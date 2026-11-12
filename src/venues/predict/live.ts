import { createRequire } from "node:module";
import { ChainId, OrderBuilder, Side as PfSide } from "@predictdotfun/sdk";
import type { Wallet } from "ethers";
import type { Logger } from "pino";
import { errMsg } from "../../core/async.js";
import { div, fx, mul, ONE, roundToStep, toNum, toStr, type Fx } from "../../core/fixed.js";
import type { Balances, FillStatus, Side, VenueEvent, VenueFill, VenueOrderState } from "../../core/types.js";
import { HttpError, httpJson } from "../../market/http.js";
import { ResilientWs } from "../../market/ws.js";
import { walkBuy } from "../../pricing/walk.js";
import type { CancelResult, LimitOrderRequest, PositionInfo, PreparedOrder, SubmitResult, TakerOrderRequest, TradingVenue, VenueErrorClass } from "../types.js";
import { VenueError } from "../types.js";

export interface PredictLiveOptions {
  restUrl: string;
  wsUrl: string | null;
  apiKey: string | null;
  signerPrivateKey: string;
  predictAccount: string | null;
  chain: "mainnet" | "testnet";
  rpcUrl?: string;
  selfTradePrevention: "CANCEL_TAKER" | "CANCEL_MAKER" | "CANCEL_BOTH";
  jwtRefreshBeforeSec: number;
  timeoutMs: number;
  log: Logger;
}

const JWT_TTL_MS = 24 * 3600_000; // 文档：JWT 有效期 24 小时

// Predict SDK 是 CommonJS 包：钱包与 Provider 必须用同一份（CJS 版）ethers 创建，避免 ESM/CJS 双实例
const ethersCjs = createRequire(import.meta.url)("ethers") as typeof import("ethers");

/** SDK 会把价格截断为 3 位有效数字、数量截断为 5 位有效数字，这里先行截断，保证本地记录与签名一致。 */
export function retainSignificant(v: bigint, digits: number): bigint {
  if (v <= 0n) return v;
  const s = v.toString();
  if (s.length <= digits) return v;
  const keep = s.slice(0, digits) + "0".repeat(s.length - digits);
  return BigInt(keep);
}

function mapErrorCode(code: string, status: number): VenueErrorClass {
  if (status === 401) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (/insufficient_(collateral|shares)_balance/.test(code)) return "INSUFFICIENT_BALANCE";
  if (/approval|allowance/.test(code)) return "ALLOWANCE";
  if (/min_order/.test(code)) return "MIN_SIZE";
  if (/price/.test(code)) return "PRICE";
  if (/not_trading|trading_disabled|market_orders_disabled/.test(code)) return "MARKET_CLOSED";
  if (/duplicate/.test(code)) return "DUPLICATE";
  if (status >= 500 || status === 0) return "NETWORK";
  return "OTHER";
}

/**
 * Predict 实盘交易适配器。
 * - 金额计算、EIP-712 签名、订单哈希、Predict 账户签名：官方 SDK @predictdotfun/sdk；
 * - 下单/撤单/查单/成交：REST（x-api-key + JWT）；
 * - 订单事件：WebSocket 主题 predictWalletEvents/{jwt}，JWT 刷新后重新订阅；
 * - 订单哈希在发送前即可算出，超时后用哈希精确查单。
 */
export class PredictLiveVenue implements TradingVenue {
  readonly venue = "predict" as const;
  readonly isSimulated = false;
  private builder: OrderBuilder | null = null;
  private wallet: Wallet;
  private jwt: string | null = null;
  private jwtAt = 0;
  private authOk = false;
  private lastError: string | null = null;
  private ws: ResilientWs | null = null;
  private subscribedJwt: string | null = null;
  private handlers: ((e: VenueEvent) => void)[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  /** 订单哈希 → 代币与方向（钱包事件里没有 tokenId） */
  private known = new Map<string, { tokenId: string; side: Side }>();
  private reqId = 1;
  /** 市场参数：marketId → isNegRisk/isYieldBearing/feeRateBps（下单签名需要） */
  private marketParams = new Map<string, { isNegRisk: boolean; isYieldBearing: boolean; feeRateBps: number; marketId: number }>();

  constructor(private readonly o: PredictLiveOptions) {
    const provider = new ethersCjs.JsonRpcProvider(o.rpcUrl ?? (o.chain === "mainnet" ? "https://bsc-dataseed.bnbchain.org/" : "https://bsc-testnet-dataseed.bnbchain.org/"));
    provider.pollingInterval = 300;
    this.wallet = new ethersCjs.Wallet(o.signerPrivateKey, provider);
  }

  get makerAddress(): string {
    return this.o.predictAccount ?? this.wallet.address;
  }

  /** 由引擎在配对加载时登记市场参数。 */
  registerMarket(marketKey: string, p: { isNegRisk: boolean; isYieldBearing: boolean; feeRateBps: number; marketId: number }): void {
    this.marketParams.set(marketKey, p);
  }

  async start(): Promise<void> {
    const chainId = this.o.chain === "mainnet" ? ChainId.BnbMainnet : ChainId.BnbTestnet;
    this.builder = await OrderBuilder.make(chainId, this.wallet as never, this.o.predictAccount ? { predictAccount: this.o.predictAccount } : undefined);
    await this.login();
    if (this.o.wsUrl && this.o.apiKey) {
      this.ws = new ResilientWs({
        name: "pf-wallet",
        url: () => this.o.wsUrl!,
        headers: () => ({ "x-api-key": this.o.apiKey! }),
        log: this.o.log,
        idleTimeoutMs: 45_000,
        onOpen: (w) => this.subscribeWallet(w),
        onMessage: (t, w) => this.handleWs(t, w),
        onStateChange: (up, reason) => this.emit({ type: "stream", venue: "predict", channel: "user", up, ts: Date.now(), reason }),
      });
      this.ws.start();
    } else {
      this.o.log.warn("Predict 未配置 WebSocket/API Key，无法接收钱包事件；实盘需要 API Key");
    }
    this.refreshTimer = setInterval(() => void this.maybeRefreshJwt(), 60_000);
    this.refreshTimer.unref();
    await this.checkApprovals();
  }

  async stop(): Promise<void> {
    this.ws?.stop();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  onEvent(handler: (e: VenueEvent) => void): void {
    this.handlers.push(handler);
  }

  private emit(e: VenueEvent): void {
    for (const h of this.handlers) h(e);
  }

  private b(): OrderBuilder {
    if (!this.builder) throw new VenueError("Predict OrderBuilder 未初始化", "AUTH");
    return this.builder;
  }

  private headers(withJwt: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.o.apiKey) h["x-api-key"] = this.o.apiKey;
    if (withJwt && this.jwt) h.Authorization = `Bearer ${this.jwt}`;
    return h;
  }

  // ---------------- 认证 ----------------

  /** 登录换取 JWT：GET /v1/auth/message → 签名 → POST /v1/auth。出处：https://dev.predict.fun/trading/authentication.md */
  async login(): Promise<void> {
    try {
      const { data } = await httpJson<{ data: { message: string } }>(`${this.o.restUrl}/v1/auth/message`, { headers: this.headers(false), timeoutMs: this.o.timeoutMs });
      const message = data.data.message;
      const signature = this.o.predictAccount ? await this.b().signPredictAccountMessage(message) : await this.wallet.signMessage(message);
      const res = await httpJson<{ data: { token: string } }>(`${this.o.restUrl}/v1/auth`, {
        method: "POST",
        headers: this.headers(false),
        body: { signer: this.makerAddress, message, signature },
        timeoutMs: this.o.timeoutMs,
      });
      this.jwt = res.data.data.token;
      this.jwtAt = Date.now();
      this.authOk = true;
      this.lastError = null;
      this.o.log.info({ signer: this.makerAddress }, "Predict 已登录（JWT 24 小时有效）");
      if (this.ws?.up) this.subscribeWallet(this.ws);
    } catch (e) {
      this.authOk = false;
      this.lastError = errMsg(e);
      throw new VenueError(`Predict 登录失败：${errMsg(e)}`, "AUTH", null, e);
    }
  }

  private async maybeRefreshJwt(): Promise<void> {
    if (Date.now() - this.jwtAt < JWT_TTL_MS - this.o.jwtRefreshBeforeSec * 1000) return;
    try {
      await this.login();
    } catch (e) {
      this.o.log.error({ err: errMsg(e) }, "Predict JWT 刷新失败");
    }
  }

  private subscribeWallet(w: ResilientWs): void {
    if (!this.jwt) return;
    if (this.subscribedJwt && this.subscribedJwt !== this.jwt) {
      w.send({ method: "unsubscribe", requestId: this.reqId++, params: [`predictWalletEvents/${this.subscribedJwt}`] });
    }
    w.send({ method: "subscribe", requestId: this.reqId++, params: [`predictWalletEvents/${this.jwt}`] });
    this.subscribedJwt = this.jwt;
  }

  /** 带 401 自动重新登录一次的请求。 */
  private async authed<T>(url: string, opts: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
    const run = async () => (await httpJson<T>(url, { method: opts.method, body: opts.body, headers: this.headers(true), timeoutMs: this.o.timeoutMs, retries: opts.method === "POST" ? 0 : 2 })).data;
    try {
      return await run();
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        await this.login();
        return await run();
      }
      throw e;
    }
  }

  private async checkApprovals(): Promise<void> {
    try {
      const steps = [];
      for (const p of this.marketParams.values()) steps.push(...this.b().getApprovalSteps({ operation: "TRADE", isNegRisk: p.isNegRisk, isYieldBearing: p.isYieldBearing }));
      if (steps.length === 0) return;
      const checks = await this.b().checkApprovals(steps);
      const missing = checks.filter((c) => !c.satisfied).map((c) => c.step.label);
      if (missing.length) {
        this.lastError = `缺少授权：${missing.join("、")}`;
        this.o.log.error({ missing }, "Predict 授权不完整（可用 SDK runApprovals 或网页完成授权）");
      }
    } catch (e) {
      this.o.log.warn({ err: errMsg(e) }, "Predict 授权检查失败");
    }
  }

  // ---------------- 下单 ----------------

  private params(meta: { marketKey: string }): { isNegRisk: boolean; isYieldBearing: boolean; feeRateBps: number } {
    const p = this.marketParams.get(meta.marketKey);
    if (!p) throw new VenueError(`Predict 市场 ${meta.marketKey} 未登记参数`, "OTHER");
    return p;
  }

  async prepareLimit(req: LimitOrderRequest): Promise<PreparedOrder> {
    const p = this.params(req.meta);
    const price = retainSignificant(roundToStep(req.price, req.meta.tickSize, req.side === "BUY" ? "floor" : "ceil"), 3);
    const qty = retainSignificant(roundToStep(req.size, req.meta.shareStep, "floor"), 5);
    const side = req.side === "BUY" ? PfSide.BUY : PfSide.SELL;
    const amounts = this.b().getLimitOrderAmounts({ side, pricePerShareWei: price, quantityWei: qty });
    const order = this.b().buildOrder("LIMIT", {
      side,
      tokenId: req.tokenId,
      makerAmount: amounts.makerAmount,
      takerAmount: amounts.takerAmount,
      feeRateBps: p.feeRateBps,
      nonce: 0n,
      ...(req.expiresAt ? { expiresAt: new Date(req.expiresAt) } : {}),
    });
    const typed = this.b().buildTypedData(order, { isNegRisk: p.isNegRisk, isYieldBearing: p.isYieldBearing });
    const signed = await this.b().signTypedDataOrder(typed);
    const hash = this.b().buildTypedDataHash(typed);
    const payload = {
      order: { ...signed, hash },
      pricePerShare: amounts.pricePerShare.toString(),
      strategy: "LIMIT",
      ...(req.postOnly ? { isPostOnly: true } : {}),
      selfTradePrevention: this.o.selfTradePrevention,
    };
    this.known.set(hash.toLowerCase(), { tokenId: req.tokenId, side: req.side });
    return { clientOrderId: req.clientOrderId, hash, price: amounts.pricePerShare, size: amounts.amount, amountUsd: null, payload: JSON.parse(JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), expiresAt: req.expiresAt };
  }

  /**
   * MARKET 吃单（按份额）。买入：目标是净到账份额，手续费扣份额，所以先按订单簿算出需要的毛份额；
   * 价格上限通过 slippageBps 表达：SDK 默认模型 makerAmount = 最差档价 × 数量 × (1 + 滑点)。
   */
  async prepareTaker(req: TakerOrderRequest): Promise<PreparedOrder> {
    const p = this.params(req.meta);
    const side = req.side === "BUY" ? PfSide.BUY : PfSide.SELL;
    let qty: Fx;
    let slippageBps = 0n;
    const levels = req.bookLevels.map((l) => [toNum(l.price), toNum(l.size)] as [number, number]);
    if (req.side === "BUY") {
      const w = walkBuy(req.bookLevels, req.shares, req.meta.fee, { maxPrice: req.limitPrice });
      qty = retainSignificant(w.grossShares > 0n ? w.grossShares : req.shares, 5);
      const worst = w.worstPrice > 0n ? w.worstPrice : req.limitPrice;
      if (req.limitPrice > worst) slippageBps = (div(req.limitPrice, worst, "floor") - ONE) / (ONE / 10_000n);
    } else {
      qty = retainSignificant(roundToStep(req.shares, req.meta.shareStep, "floor"), 5);
      const best = req.bookLevels[0]?.price ?? req.limitPrice;
      if (best > req.limitPrice) slippageBps = ((ONE - div(req.limitPrice, best, "ceil")) * 10_000n) / ONE;
    }
    if (slippageBps < 0n) slippageBps = 0n;
    if (slippageBps > 9_000n) slippageBps = 9_000n;
    const book = req.side === "BUY" ? { asks: levels, bids: [] as [number, number][], updateTimestampMs: Date.now() } : { asks: [] as [number, number][], bids: levels, updateTimestampMs: Date.now() };
    const amounts = this.b().getMarketOrderAmounts({ side, quantityWei: qty, slippageBps }, book);
    const order = this.b().buildOrder("MARKET", {
      side,
      tokenId: req.tokenId,
      makerAmount: amounts.makerAmount,
      takerAmount: amounts.takerAmount,
      feeRateBps: p.feeRateBps,
      nonce: 0n,
    });
    const typed = this.b().buildTypedData(order, { isNegRisk: p.isNegRisk, isYieldBearing: p.isYieldBearing });
    const signed = await this.b().signTypedDataOrder(typed);
    const hash = this.b().buildTypedDataHash(typed);
    const payload = {
      order: { ...signed, hash },
      pricePerShare: amounts.pricePerShare.toString(),
      strategy: "MARKET",
      slippageBps: amounts.slippageBps.toString(),
      isMinAmountOut: amounts.isMinAmountOut,
      selfTradePrevention: this.o.selfTradePrevention,
    };
    this.known.set(hash.toLowerCase(), { tokenId: req.tokenId, side: req.side });
    return { clientOrderId: req.clientOrderId, hash, price: req.limitPrice, size: req.shares, amountUsd: null, payload: JSON.parse(JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), expiresAt: null };
  }

  async submit(p: PreparedOrder): Promise<SubmitResult> {
    try {
      const data = await this.authed<{ data: { code: string; orderId: string; orderHash: string; removalLockedUntil: string | null } }>(`${this.o.restUrl}/v1/orders`, {
        method: "POST",
        body: { data: p.payload },
      });
      // 201 只表示通过初步检查，结果以钱包事件/查单为准
      return { accepted: true, venueOrderId: String(data.data.orderId), hash: data.data.orderHash ?? p.hash, status: "LIVE", reportedFilledShares: null, reportedSpentUsd: null, tradeIds: [], rejectReason: null, retryable: false, retryAfterMs: null, errorClass: null };
    } catch (e) {
      if (e instanceof HttpError) {
        const code = String((e.body as { error?: string } | null)?.error ?? "");
        const cls = mapErrorCode(code, e.status);
        if (cls === "NETWORK") throw new VenueError(e.message, "NETWORK", e.retryAfterMs, e);
        if (cls === "DUPLICATE") {
          // 同一签名订单已存在（例如超时后重发）：视为已受理，以查单为准
          return { accepted: true, venueOrderId: null, hash: p.hash, status: "LIVE", reportedFilledShares: null, reportedSpentUsd: null, tradeIds: [], rejectReason: null, retryable: false, retryAfterMs: null, errorClass: null };
        }
        return { accepted: false, venueOrderId: null, hash: null, status: "REJECTED", reportedFilledShares: null, reportedSpentUsd: null, tradeIds: [], rejectReason: `${code || e.status}: ${e.message}`, retryable: cls === "RATE_LIMIT", retryAfterMs: e.retryAfterMs, errorClass: cls };
      }
      throw new VenueError(errMsg(e), "NETWORK", null, e);
    }
  }

  // ---------------- 撤单 / 查询 ----------------

  async cancel(refs: { venueOrderId: string | null; hash: string | null }[]): Promise<CancelResult> {
    const out: CancelResult = { cancelled: [], noop: [], rejected: [] };
    // 按哈希逐笔撤：同一请求里只要有一笔不属于本钱包（含不存在），整批 401
    for (const r of refs) {
      const label = r.venueOrderId ?? r.hash ?? "";
      try {
        const body = r.venueOrderId ? { data: { ids: [r.venueOrderId] } } : { data: { hashes: [r.hash] } };
        const url = r.venueOrderId ? `${this.o.restUrl}/v1/orders/remove` : `${this.o.restUrl}/v1/orders/remove-by-hash`;
        const res = await this.authed<{ removed?: string[]; noop?: string[]; rejected?: string[] }>(url, { method: "POST", body });
        if ((res.removed ?? []).length) out.cancelled.push(label);
        else if ((res.rejected ?? []).length) out.rejected.push(label);
        else out.noop.push(label);
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) {
          // 重新登录后仍 401：多半是订单不存在，交给查单确认
          out.noop.push(label);
          continue;
        }
        throw e instanceof HttpError ? new VenueError(e.message, mapErrorCode("", e.status), e.retryAfterMs, e) : e;
      }
    }
    return out;
  }

  async getOrder(ref: { venueOrderId: string | null; hash: string | null }): Promise<VenueOrderState> {
    if (!ref.hash) {
      return { venueOrderId: ref.venueOrderId, hash: null, status: "NOT_FOUND", filled: 0n };
    }
    try {
      const res = await this.authed<{ data: Record<string, unknown> }>(`${this.o.restUrl}/v1/orders/${ref.hash}`);
      return this.parseOrderData(res.data);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return { venueOrderId: ref.venueOrderId, hash: ref.hash, status: "NOT_FOUND", filled: 0n };
      throw e instanceof HttpError ? new VenueError(e.message, mapErrorCode("", e.status), e.retryAfterMs, e) : e;
    }
  }

  private parseOrderData(d: Record<string, unknown>): VenueOrderState {
    const o = (d.order ?? {}) as Record<string, unknown>;
    const st = String(d.status ?? "");
    const status: VenueOrderState["status"] = st === "OPEN" ? "OPEN" : st === "FILLED" ? "FILLED" : st === "EXPIRED" ? "EXPIRED" : st === "INVALIDATED" ? "INVALIDATED" : "CANCELLED";
    const side: Side = Number(o.side) === 1 ? "SELL" : "BUY";
    const size = BigInt(String(d.amount ?? "0"));
    const filled = BigInt(String(d.amountFilled ?? "0"));
    const makerAmount = BigInt(String(o.makerAmount ?? "0"));
    const takerAmount = BigInt(String(o.takerAmount ?? "0"));
    const price = side === "BUY" && takerAmount > 0n ? div(makerAmount, takerAmount) : makerAmount > 0n ? div(takerAmount, makerAmount) : 0n;
    return { venueOrderId: String(d.id ?? ""), hash: String(o.hash ?? ""), status, tokenId: String(o.tokenId ?? ""), side, price, size, filled };
  }

  async listOpenOrders(tokenIds: string[]): Promise<VenueOrderState[]> {
    const set = new Set(tokenIds);
    const out: VenueOrderState[] = [];
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      const url: string = `${this.o.restUrl}/v1/orders?status=OPEN&first=150${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const res: { data: Record<string, unknown>[]; cursor?: string | null } = await this.authed(url);
      for (const d of res.data ?? []) {
        const st = this.parseOrderData(d);
        if (set.size === 0 || set.has(st.tokenId ?? "")) out.push(st);
      }
      after = res.cursor ?? null;
      if (!after) break;
    }
    return out;
  }

  /** 补拉成交：GET /v1/orders/matches?signerAddress=…，只取本钱包作为 taker/maker 的部分；要求有 settlementId 以与推送去重。 */
  async listFills(sinceMs: number, tokenIds: string[]): Promise<VenueFill[]> {
    const set = new Set(tokenIds);
    const me = this.makerAddress.toLowerCase();
    const out: VenueFill[] = [];
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      const url: string = `${this.o.restUrl}/v1/orders/matches?signerAddress=${me}&executedAfter=${Math.max(0, sinceMs - 1)}&first=150${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const res: { data: Record<string, unknown>[]; cursor?: string | null } = await httpJson<{ data: Record<string, unknown>[]; cursor?: string | null }>(url, { headers: this.headers(true), timeoutMs: this.o.timeoutMs }).then((r) => r.data);
      for (const mt of res.data ?? []) {
        const settlementId = mt.settlementId ? String(mt.settlementId) : null;
        const executedAt = Date.parse(String(mt.executedAt ?? "")) || Date.now();
        const parts = [{ f: mt.taker as Record<string, unknown>, maker: false }, ...((mt.makers as Record<string, unknown>[]) ?? []).map((f) => ({ f, maker: true }))];
        for (const { f, maker } of parts) {
          if (!f || String(f.signer ?? "").toLowerCase() !== me) continue;
          const outcome = (f.outcome ?? {}) as Record<string, unknown>;
          const tokenId = String(outcome.onChainId ?? "");
          if (set.size && !set.has(tokenId)) continue;
          if (!settlementId) {
            this.o.log.warn({ tx: mt.transactionHash }, "成交缺少 settlementId，跳过以免与推送重复计数");
            continue;
          }
          const hash = String(f.hash ?? "");
          const fee = (f.fee ?? {}) as Record<string, unknown>;
          const feeAmt = fee.amount !== undefined ? BigInt(String(fee.amount)) : null;
          out.push({
            key: `pf:${hash.toLowerCase()}:${settlementId}`,
            venue: "predict",
            venueOrderId: null,
            orderHash: hash,
            tokenId,
            side: String(f.quoteType ?? "").toLowerCase() === "ask" ? "SELL" : "BUY",
            price: BigInt(String(f.price ?? "0")),
            grossShares: BigInt(String(f.amount ?? "0")),
            feeShares: feeAmt !== null && fee.type === "SHARES" ? feeAmt : feeAmt !== null ? 0n : null,
            feeCollateral: feeAmt !== null && fee.type === "COLLATERAL" ? feeAmt : feeAmt !== null ? 0n : null,
            isMaker: maker,
            status: "SETTLED",
            matchedAt: executedAt,
            txHash: mt.transactionHash ? String(mt.transactionHash) : null,
          });
        }
      }
      after = res.cursor ?? null;
      if (!after) break;
    }
    return out;
  }

  // ---------------- 钱包事件 ----------------

  private handleWs(text: string, w: ResilientWs): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "R") {
      const err = msg.error as { code?: string } | undefined;
      if (msg.success === false && err?.code === "invalid_credentials") {
        this.o.log.warn("钱包事件订阅 JWT 无效，重新登录");
        void this.login().catch(() => undefined);
      }
      return;
    }
    const topic = String(msg.topic ?? "");
    if (topic === "heartbeat") {
      w.send({ method: "heartbeat", data: msg.data });
      return;
    }
    if (topic === "system") {
      w.reconnect("服务端重连通知");
      return;
    }
    if (!topic.startsWith("predictWalletEvents/")) return;
    const d = (msg.data ?? {}) as Record<string, unknown>;
    const type = String(d.type ?? "");
    const hash = String(d.orderHash ?? "");
    const orderId = String(d.orderId ?? "");
    const ts = Number(d.timestamp ?? Date.now());
    const details = (d.details ?? {}) as Record<string, unknown>;
    const known = this.known.get(hash.toLowerCase());
    const side: Side = known?.side ?? (String(details.quoteType ?? "BID") === "ASK" ? "SELL" : "BUY");
    const qty = details.quantity !== undefined ? fx(String(details.quantity)) : undefined;
    const qtyFilled = details.quantityFilled !== undefined ? fx(String(details.quantityFilled)) : 0n;
    const orderState = (status: VenueOrderState["status"]): VenueOrderState => ({ venueOrderId: orderId, hash, status, tokenId: known?.tokenId, side, size: qty, filled: qtyFilled });
    switch (type) {
      case "orderAccepted":
        this.emit({ type: "order", venue: "predict", state: orderState("OPEN"), ts });
        break;
      case "orderNotAccepted":
        this.emit({ type: "order", venue: "predict", state: orderState("CANCELLED"), reason: String(d.reason ?? "notAccepted"), ts });
        break;
      case "orderCancelled":
        this.emit({ type: "order", venue: "predict", state: orderState("CANCELLED"), reason: d.reason ? String(d.reason) : undefined, ts });
        break;
      case "orderExpired":
        this.emit({ type: "order", venue: "predict", state: orderState("EXPIRED"), ts });
        break;
      case "orderMarketMatchPlan":
        this.emit({ type: "plan", venue: "predict", venueOrderId: orderId, hash, plannedFill: BigInt(String(d.plannedFill ?? "0")), ts });
        break;
      case "orderTransactionSubmitted":
      case "orderTransactionSuccess":
      case "orderTransactionFailed": {
        const fill = (d.fill ?? {}) as Record<string, unknown>;
        const status: FillStatus = type === "orderTransactionSubmitted" ? "MATCHED" : type === "orderTransactionSuccess" ? "SETTLED" : "FAILED";
        const fee = d.fee as { amountWei?: string; type?: string } | undefined;
        const feeAmt = fee?.amountWei !== undefined ? BigInt(fee.amountWei) : null;
        const vf: VenueFill = {
          key: `pf:${hash.toLowerCase()}:${String(d.settlementId)}`,
          venue: "predict",
          venueOrderId: orderId,
          orderHash: hash,
          tokenId: known?.tokenId ?? "",
          side,
          price: BigInt(String(fill.executedPriceWei ?? "0")),
          grossShares: BigInt(String(fill.executedSizeWei ?? "0")),
          feeShares: status === "SETTLED" ? (feeAmt !== null && fee?.type === "SHARES" ? feeAmt : 0n) : null,
          feeCollateral: status === "SETTLED" ? (feeAmt !== null && fee?.type === "COLLATERAL" ? feeAmt : 0n) : null,
          isMaker: d.isMaker === true,
          status,
          matchedAt: ts,
          txHash: null,
          raw: { type, settlementId: d.settlementId },
        };
        this.emit({ type: "fill", venue: "predict", fill: vf, ts });
        if (qty !== undefined && qtyFilled >= qty && qty > 0n) this.emit({ type: "order", venue: "predict", state: orderState("FILLED"), ts });
        break;
      }
      default:
        break;
    }
  }

  // ---------------- 余额 / 持仓 ----------------

  async getBalances(): Promise<Balances> {
    const bal = await this.b().balanceOf("USDT", this.makerAddress);
    return { collateral: bal, available: bal, updatedAt: Date.now() };
  }

  async getPositions(tokenIds: string[]): Promise<PositionInfo[]> {
    const want = new Set(tokenIds);
    const map = new Map<string, Fx>();
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      const url: string = `${this.o.restUrl}/v1/positions?first=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const res: { data: Record<string, unknown>[]; cursor?: string | null } = await this.authed(url);
      for (const p of res.data ?? []) {
        const outcome = (p.outcome ?? {}) as Record<string, unknown>;
        const t = String(outcome.onChainId ?? "");
        if (want.has(t)) map.set(t, (map.get(t) ?? 0n) + BigInt(String(p.amount ?? "0")));
      }
      after = res.cursor ?? null;
      if (!after) break;
    }
    return tokenIds.map((t) => ({ tokenId: t, shares: map.get(t) ?? 0n }));
  }

  health(): { userStreamUp: boolean; authOk: boolean; lastError: string | null } {
    return { userStreamUp: this.ws?.up ?? false, authOk: this.authOk, lastError: this.lastError };
  }
}

export const PREDICT_ONE = ONE;
export { mul as _mul, toStr as _toStr };

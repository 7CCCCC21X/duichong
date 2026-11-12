import {
  AssetType,
  createSecureClient,
  OrderSide,
  OrderType,
  RateLimitError,
  RequestRejectedError,
  type SecureClient,
} from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";
import type { Logger } from "pino";
import { hashTypedData, type Hex } from "viem";
import { errMsg, sleep } from "../../core/async.js";
import { fromUnits, fx, roundToStep, toStr, type Fx } from "../../core/fixed.js";
import { parseTime } from "../../core/time.js";
import type { Balances, FillStatus, Side, VenueEvent, VenueFill, VenueOrderState } from "../../core/types.js";
import { ResilientWs } from "../../market/ws.js";
import type {
  CancelResult,
  LimitOrderRequest,
  PositionInfo,
  PreparedOrder,
  SubmitResult,
  TakerOrderRequest,
  TradingVenue,
  VenueErrorClass,
} from "../types.js";
import { VenueError } from "../types.js";

export interface PolymarketLiveOptions {
  privateKey: string;
  walletAddress: string | null;
  credentials: { apiKey: string; secret: string; passphrase: string } | null;
  wsUserUrl: string;
  orderHeartbeat: boolean;
  /** conditionId 列表（用户频道按市场过滤，可为空表示全账户） */
  markets: () => string[];
  log: Logger;
}

// 出处：https://docs.polymarket.com/trading/place-orders.md （Create the Order Typed Data）
const EXCHANGE = {
  ctf: "0xE111180000d2663C0091e4f400237545B87B996B",
  ctfNegRisk: "0xe2222d279d744050d28e00520010520000310F59",
  v2: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
} as const;

const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;

type SignedOrderLike = Awaited<ReturnType<SecureClient["createLimitOrder"]>>;

/** 本地推导订单哈希（交易所订单 ID）。推导值与回执不一致时引擎会告警并改用按代币/时间匹配。 */
export function polymarketOrderHash(o: SignedOrderLike, meta: { protocolVersion?: "v1" | "v2"; negRisk: boolean }): string | null {
  try {
    const verifyingContract = meta.protocolVersion === "v2" ? EXCHANGE.v2 : meta.negRisk ? EXCHANGE.ctfNegRisk : EXCHANGE.ctf;
    return hashTypedData({
      domain: { name: "Polymarket CTF Exchange", version: meta.protocolVersion === "v2" ? "3" : "2", chainId: 137, verifyingContract },
      types: ORDER_TYPES,
      primaryType: "Order",
      message: {
        salt: BigInt(o.salt),
        maker: o.maker as Hex,
        signer: o.signer as Hex,
        tokenId: BigInt(o.tokenId),
        makerAmount: BigInt(o.makerAmount),
        takerAmount: BigInt(o.takerAmount),
        side: o.side === OrderSide.BUY ? 0 : 1,
        signatureType: Number(o.signatureType),
        timestamp: BigInt(o.timestamp),
        metadata: o.metadata as Hex,
        builder: o.builder as Hex,
      },
    });
  } catch {
    return null;
  }
}

function mapTradeStatus(s: string): FillStatus {
  const v = s.toUpperCase().replace("TRADE_STATUS_", "");
  if (v === "CONFIRMED") return "SETTLED";
  if (v === "MINED") return "MINED";
  if (v === "RETRYING") return "RETRYING";
  if (v === "FAILED") return "FAILED";
  return "MATCHED";
}

function mapOrderStatus(s: string, filled: Fx, size: Fx | undefined): VenueOrderState["status"] {
  const v = s.toUpperCase();
  if (v === "LIVE") return "OPEN";
  if (v === "DELAYED") return "DELAYED";
  if (v === "MATCHED") return size !== undefined && filled < size ? "OPEN" : "FILLED";
  if (v === "CANCELED" || v === "CANCELLED" || v === "UNMATCHED" || v === "CANCELLATION") return "CANCELLED";
  return "OPEN";
}

/**
 * Polymarket 实盘交易适配器。
 * - 签名、下单、撤单、查单、余额使用官方统一 SDK @polymarket/client；
 * - 用户频道 WebSocket 自己维护（PING 心跳、断线重连、按 owner 只统计本账户订单的成交）；
 * - 订单心跳（可选）：进程失联 10 秒后交易所撤掉该 API Key 的全部挂单。
 */
export class PolymarketLiveVenue implements TradingVenue {
  readonly venue = "polymarket" as const;
  readonly isSimulated = false;
  private client: SecureClient | null = null;
  private handlers: ((e: VenueEvent) => void)[] = [];
  private ws: ResilientWs | null = null;
  private authOk = false;
  private lastError: string | null = null;
  private heartbeatId = "";
  private hbTimer: NodeJS.Timeout | null = null;
  private apiKey = "";
  /** 本进程下过的订单：orderId(=hash) → tokenId */
  private known = new Map<string, { tokenId: string; side: Side }>();
  private allowanceIssue: string | null = null;
  private lastReauth = 0;

  constructor(private readonly o: PolymarketLiveOptions) {}

  /** 认证失效时重新创建客户端（限频 30 秒一次）。 */
  private reauth(): void {
    if (Date.now() - this.lastReauth < 30_000) return;
    this.lastReauth = Date.now();
    void this.connect()
      .then(() => this.o.log.info("Polymarket 已重新认证"))
      .catch((e) => this.o.log.error({ err: errMsg(e) }, "Polymarket 重新认证失败"));
  }

  async start(): Promise<void> {
    await this.connect();
    const creds = this.client!.credentials;
    this.apiKey = String(creds.key);
    this.ws = new ResilientWs({
      name: "pm-user",
      url: () => this.o.wsUserUrl,
      log: this.o.log,
      pingIntervalMs: 10_000,
      pingPayload: "PING",
      idleTimeoutMs: 120_000,
      onOpen: (w) => {
        const markets = this.o.markets();
        w.send({ auth: { apiKey: String(creds.key), secret: creds.secret, passphrase: creds.passphrase }, type: "user", ...(markets.length ? { markets } : {}) });
      },
      onMessage: (t) => this.handleUserMessage(t),
      onStateChange: (up, reason) => this.emit({ type: "stream", venue: "polymarket", channel: "user", up, ts: Date.now(), reason }),
    });
    this.ws.start();
    if (this.o.orderHeartbeat) this.startHeartbeat();
  }

  private async connect(): Promise<void> {
    try {
      this.client = await createSecureClient({
        wallet: this.o.walletAddress ?? undefined,
        signer: privateKey(this.o.privateKey),
        ...(this.o.credentials ? { credentials: { apiKey: this.o.credentials.apiKey, secret: this.o.credentials.secret, passphrase: this.o.credentials.passphrase } as never } : {}),
      });
      this.authOk = true;
      const acc = this.client.account;
      this.o.log.info({ wallet: acc.wallet, walletType: acc.walletType, signer: acc.signer }, "Polymarket 账户已连接");
    } catch (e) {
      this.authOk = false;
      this.lastError = errMsg(e);
      throw new VenueError(`Polymarket 认证失败：${errMsg(e)}`, "AUTH", null, e);
    }
  }

  async stop(): Promise<void> {
    this.ws?.stop();
    if (this.hbTimer) clearInterval(this.hbTimer);
  }

  onEvent(handler: (e: VenueEvent) => void): void {
    this.handlers.push(handler);
  }

  private emit(e: VenueEvent): void {
    for (const h of this.handlers) h(e);
  }

  private startHeartbeat(): void {
    const beat = async () => {
      if (!this.client) return;
      try {
        const r = await this.client.sendOrderHeartbeat({ heartbeatId: this.heartbeatId });
        this.heartbeatId = r.heartbeatId;
      } catch (e) {
        const expected = (e as { heartbeatId?: string }).heartbeatId;
        if (typeof expected === "string") {
          this.heartbeatId = expected;
          try {
            const r = await this.client.sendOrderHeartbeat({ heartbeatId: expected });
            this.heartbeatId = r.heartbeatId;
            return;
          } catch {
            /* fallthrough */
          }
        }
        this.o.log.warn({ err: errMsg(e) }, "Polymarket 订单心跳失败（10 秒内未恢复将触发交易所自动撤单）");
      }
    };
    void beat();
    this.hbTimer = setInterval(() => void beat(), 5_000);
    this.hbTimer.unref();
  }

  private c(): SecureClient {
    if (!this.client) throw new VenueError("Polymarket 客户端未初始化", "AUTH");
    return this.client;
  }

  // ---------------- 下单 ----------------

  async prepareLimit(req: LimitOrderRequest): Promise<PreparedOrder> {
    const price = roundToStep(req.price, req.meta.tickSize, req.side === "BUY" ? "floor" : "ceil");
    const size = roundToStep(req.size, req.meta.shareStep, "floor");
    const expiration = req.expiresAt ? Math.floor(req.expiresAt / 1000) + 60 : undefined; // GTD 提前 1 分钟失效
    const signed = await this.c().createLimitOrder({
      assetId: req.tokenId,
      side: req.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
      price: toStr(price, 6),
      size: toStr(size, 2),
      postOnly: req.postOnly,
      ...(expiration ? { expiration } : {}),
    });
    const hash = polymarketOrderHash(signed, req.meta);
    return { clientOrderId: req.clientOrderId, hash, price, size, amountUsd: null, payload: signed, expiresAt: req.expiresAt };
  }

  async prepareTaker(req: TakerOrderRequest): Promise<PreparedOrder> {
    let signed: SignedOrderLike;
    if (req.side === "BUY") {
      // FAK 买单以金额为目标：按当前簿逐档算出买 shares 份所需金额，并以 maxPrice 限价
      const amount = req.amountUsd ?? fx(0);
      if (amount <= 0n) throw new VenueError("FAK 买单金额为 0", "MIN_SIZE");
      signed = await this.c().createMarketOrder({ assetId: req.tokenId, side: OrderSide.BUY, amount: toStr(amount, 6), maxPrice: toStr(req.limitPrice, 6), orderType: OrderType.FAK });
    } else {
      const shares = roundToStep(req.shares, req.meta.shareStep, "floor");
      signed = await this.c().createMarketOrder({ assetId: req.tokenId, side: OrderSide.SELL, shares: toStr(shares, 2), minPrice: toStr(req.limitPrice, 6), orderType: OrderType.FAK });
    }
    const hash = polymarketOrderHash(signed, req.meta);
    return { clientOrderId: req.clientOrderId, hash, price: req.limitPrice, size: req.shares, amountUsd: req.amountUsd, payload: signed, expiresAt: null };
  }

  async submit(p: PreparedOrder, _kind: "LIMIT" | "TAKER", req: LimitOrderRequest | TakerOrderRequest): Promise<SubmitResult> {
    let res: Awaited<ReturnType<SecureClient["postOrder"]>>;
    try {
      res = await this.c().postOrder(p.payload as SignedOrderLike);
    } catch (e) {
      throw this.classify(e);
    }
    if (!res.ok) {
      const code = String(res.code);
      if (code === "fak_not_filled" || code === "fok_not_filled" || code === "unmatched") {
        return { accepted: true, venueOrderId: p.hash, hash: p.hash, status: "UNMATCHED", reportedFilledShares: 0n, reportedSpentUsd: 0n, tradeIds: [], rejectReason: null, retryable: false, retryAfterMs: null, errorClass: null };
      }
      const cls: VenueErrorClass =
        code === "insufficient_balance_or_allowance"
          ? "INSUFFICIENT_BALANCE"
          : code === "post_only_would_cross"
            ? "POST_ONLY_CROSS"
            : code === "post_only_mode"
              ? "RESTARTING"
              : code === "market_not_ready"
                ? "MARKET_CLOSED"
                : "OTHER";
      return { accepted: false, venueOrderId: null, hash: null, status: "REJECTED", reportedFilledShares: null, reportedSpentUsd: null, tradeIds: [], rejectReason: `${code}: ${res.message}`, retryable: cls === "RESTARTING", retryAfterMs: null, errorClass: cls };
    }
    const orderId = String(res.orderId);
    this.known.set(orderId, { tokenId: req.tokenId, side: req.side });
    const making = fx(String(res.makingAmount));
    const taking = fx(String(res.takingAmount));
    const filledShares = req.side === "BUY" ? taking : making;
    const spent = req.side === "BUY" ? making : taking;
    const status = String(res.status) === "matched" ? "MATCHED" : String(res.status) === "delayed" ? "DELAYED" : "LIVE";
    return { accepted: true, venueOrderId: orderId, hash: orderId, status, reportedFilledShares: filledShares, reportedSpentUsd: spent, tradeIds: res.tradeIds, rejectReason: null, retryable: false, retryAfterMs: null, errorClass: null };
  }

  private classify(e: unknown): VenueError {
    if (e instanceof VenueError) return e;
    if (e instanceof RateLimitError) return new VenueError(`限流：${e.message}`, "RATE_LIMIT", (e.retryAfter ?? 5) * 1000, e);
    if (e instanceof RequestRejectedError) {
      const restriction = (e as { restriction?: string }).restriction;
      if (restriction === "restarting") return new VenueError(`撮合引擎重启：${e.message}`, "RESTARTING", (e.retryAfter ?? 2) * 1000, e);
      if (restriction === "post_only") return new VenueError(`仅接受 post-only：${e.message}`, "RESTARTING", (e.retryAfter ?? 5) * 1000, e);
      if (e.status === 401 || e.status === 403) {
        this.authOk = false;
        this.lastError = e.message;
        this.reauth();
        return new VenueError(`认证失败：${e.message}`, "AUTH", null, e);
      }
      if (e.status === 429) return new VenueError(`限流：${e.message}`, "RATE_LIMIT", (e.retryAfter ?? 5) * 1000, e);
      if (/balance|allowance/i.test(e.message)) return new VenueError(e.message, "INSUFFICIENT_BALANCE", null, e);
      return new VenueError(e.message, "OTHER", null, e);
    }
    const name = (e as { name?: string }).name ?? "";
    // 传输错误（超时、连接重置）：请求可能已到达交易所，状态未知
    if (/Transport|Timeout|Abort/i.test(name)) return new VenueError(`网络错误：${errMsg(e)}`, "NETWORK", null, e);
    if (/UserInput/i.test(name)) return new VenueError(errMsg(e), "MIN_SIZE", null, e);
    return new VenueError(errMsg(e), "NETWORK", null, e);
  }

  // ---------------- 撤单 / 查询 ----------------

  async cancel(refs: { venueOrderId: string | null; hash: string | null }[]): Promise<CancelResult> {
    const ids = refs.map((r) => r.venueOrderId ?? r.hash).filter((x): x is string => !!x);
    const out: CancelResult = { cancelled: [], noop: [], rejected: [] };
    if (ids.length === 0) return out;
    let res: Awaited<ReturnType<SecureClient["cancelOrders"]>>;
    try {
      res = await this.c().cancelOrders({ orderIds: ids });
    } catch (e) {
      throw this.classify(e);
    }
    const canceled = new Set((res.canceled as string[]).map(String));
    for (const id of ids) {
      if (canceled.has(id)) out.cancelled.push(id);
      else {
        const why = String((res.notCanceled as Record<string, string>)[id] ?? "");
        if (/delay|pending/i.test(why)) out.rejected.push(id);
        else out.noop.push(id);
      }
    }
    return out;
  }

  async getOrder(ref: { venueOrderId: string | null; hash: string | null }): Promise<VenueOrderState> {
    const id = ref.venueOrderId ?? ref.hash;
    if (!id) return { venueOrderId: null, hash: null, status: "NOT_FOUND", filled: 0n };
    try {
      const o = await this.c().fetchOrder({ orderId: id });
      const size = fx(String(o.originalSize));
      const filled = fx(String(o.sizeMatched));
      return {
        venueOrderId: String(o.id),
        hash: String(o.id),
        status: mapOrderStatus(String(o.status), filled, size),
        tokenId: String(o.assetId),
        side: String(o.side).toUpperCase() === "SELL" ? "SELL" : "BUY",
        price: fx(String(o.price)),
        size,
        filled,
        createdAt: parseTime(String(o.createdAt)) ?? undefined,
      };
    } catch (e) {
      if (e instanceof RequestRejectedError && (e.status === 404 || e.status === 400)) return { venueOrderId: id, hash: id, status: "NOT_FOUND", filled: 0n };
      throw this.classify(e);
    }
  }

  async listOpenOrders(tokenIds: string[]): Promise<VenueOrderState[]> {
    const out: VenueOrderState[] = [];
    for (const assetId of tokenIds) {
      try {
        for await (const page of this.c().listOpenOrders({ assetId })) {
          for (const o of page.items) {
            const size = fx(String(o.originalSize));
            const filled = fx(String(o.sizeMatched));
            out.push({ venueOrderId: String(o.id), hash: String(o.id), status: mapOrderStatus(String(o.status), filled, size), tokenId: String(o.assetId), side: String(o.side).toUpperCase() === "SELL" ? "SELL" : "BUY", price: fx(String(o.price)), size, filled });
          }
        }
      } catch (e) {
        throw this.classify(e);
      }
    }
    return out;
  }

  /** 补拉本账户成交：只统计属于本账户订单的部分（taker 自身订单或 makerOrders 中 owner 为本 API Key 的条目）。 */
  async listFills(sinceMs: number, tokenIds: string[]): Promise<VenueFill[]> {
    const out: VenueFill[] = [];
    for (const assetId of tokenIds) {
      try {
        for await (const page of this.c().listAccountTrades({ assetId, after: String(Math.floor(sinceMs / 1000)) })) {
          for (const t of page.items) out.push(...this.fillsFromTrade(t as unknown as Record<string, unknown>));
        }
      } catch (e) {
        throw this.classify(e);
      }
    }
    return out;
  }

  private fillsFromTrade(t: Record<string, unknown>): VenueFill[] {
    // 兼容 SDK 归一化字段（camelCase）与 WS 原始字段（snake_case）
    const get = (a: string, b: string) => t[a] ?? t[b];
    const tradeId = String(get("id", "id"));
    const status = mapTradeStatus(String(get("status", "status") ?? "MATCHED"));
    const matchedAt = parseTime(String(get("matchedAt", "match_time") ?? "")) ?? Date.now();
    const txHash = (get("transactionHash", "transaction_hash") as string | undefined) ?? null;
    const out: VenueFill[] = [];
    const owner = String(get("owner", "owner") ?? "");
    const traderSide = String(get("traderSide", "trader_side") ?? "");
    const takerOrderId = String(get("takerOrderId", "taker_order_id") ?? "");
    if (owner === this.apiKey && (traderSide === "TAKER" || traderSide === "")) {
      const side: Side = String(get("side", "side")).toUpperCase() === "SELL" ? "SELL" : "BUY";
      out.push({
        key: `pm:${tradeId}:${takerOrderId}`,
        venue: "polymarket",
        venueOrderId: takerOrderId,
        orderHash: takerOrderId,
        tokenId: String(get("assetId", "asset_id")),
        side,
        price: fx(String(get("price", "price"))),
        grossShares: fx(String(get("size", "size"))),
        feeShares: null,
        feeCollateral: null,
        isMaker: false,
        status,
        matchedAt,
        txHash,
        raw: { tradeId },
      });
    }
    const makers = (get("makerOrders", "maker_orders") as Record<string, unknown>[] | undefined) ?? [];
    for (const m of makers) {
      const mOwner = String(m.owner ?? "");
      const orderId = String(m.orderId ?? m.order_id ?? "");
      if (mOwner !== this.apiKey && !this.known.has(orderId)) continue;
      out.push({
        key: `pm:${tradeId}:${orderId}`,
        venue: "polymarket",
        venueOrderId: orderId,
        orderHash: orderId,
        tokenId: String(m.assetId ?? m.asset_id ?? ""),
        side: String(m.side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY",
        price: fx(String(m.price)),
        grossShares: fx(String(m.matchedAmount ?? m.matched_amount ?? "0")),
        feeShares: 0n,
        feeCollateral: 0n,
        isMaker: true,
        status,
        matchedAt,
        txHash,
        raw: { tradeId },
      });
    }
    return out;
  }

  private handleUserMessage(text: string): void {
    if (text === "PONG") return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    for (const raw of Array.isArray(msg) ? msg : [msg]) {
      const m = raw as Record<string, unknown>;
      if (m.event_type === "trade") {
        for (const f of this.fillsFromTrade(m)) this.emit({ type: "fill", venue: "polymarket", fill: f, ts: Date.now() });
      } else if (m.event_type === "order") {
        const id = String(m.id);
        const size = fx(String(m.original_size ?? "0"));
        const filled = fx(String(m.size_matched ?? "0"));
        const kind = String(m.type ?? "");
        const status = kind === "CANCELLATION" ? "CANCELLED" : mapOrderStatus(String(m.status ?? kind), filled, size);
        this.emit({ type: "order", venue: "polymarket", state: { venueOrderId: id, hash: id, status, tokenId: String(m.asset_id ?? ""), size, filled }, ts: Date.now() });
      }
    }
  }

  // ---------------- 余额 / 持仓 ----------------

  async getBalances(): Promise<Balances> {
    try {
      const r = await fetchBalanceAllowance(this.c(), { assetType: AssetType.COLLATERAL });
      const bal = fromUnits(BigInt(String(r.balance)), 6);
      const allowances = Object.values(r.allowances as Record<string, bigint>);
      if (allowances.length && allowances.every((a) => BigInt(a) === 0n)) {
        this.allowanceIssue = "pUSD 对交易所的授权额度为 0，买单会被拒绝（可用 SDK setupTradingApprovals 或网页完成授权）";
        this.o.log.warn(this.allowanceIssue);
      } else {
        this.allowanceIssue = null;
      }
      return { collateral: bal, available: bal, updatedAt: Date.now() };
    } catch (e) {
      throw this.classify(e);
    }
  }

  async getPositions(tokenIds: string[]): Promise<PositionInfo[]> {
    const out: PositionInfo[] = [];
    for (const t of tokenIds) {
      let shares = 0n;
      for (const assetType of [AssetType.CONDITIONAL, AssetType.CONDITIONAL_V2]) {
        try {
          const r = await fetchBalanceAllowance(this.c(), { assetId: t, assetType });
          shares += fromUnits(BigInt(String(r.balance)), 6);
          break;
        } catch {
          await sleep(50);
        }
      }
      out.push({ tokenId: t, shares });
    }
    return out;
  }

  health(): { userStreamUp: boolean; authOk: boolean; lastError: string | null } {
    return { userStreamUp: this.ws?.up ?? false, authOk: this.authOk, lastError: this.lastError };
  }

  issues(): { code: string; message: string }[] {
    return this.allowanceIssue ? [{ code: "allowance", message: this.allowanceIssue }] : [];
  }
}

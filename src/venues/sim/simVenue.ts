import { div, mul, ONE, roundToStep, type Fx } from "../../core/fixed.js";
import type { Clock } from "../../core/time.js";
import type { Balances, FeeParams, Level, Side, VenueEvent, VenueFill, VenueId, VenueMarketMeta, VenueOrderState } from "../../core/types.js";
import type { BookStore } from "../../market/bookStore.js";
import { buyFeeMode, netPerGrossShare, takerFeeUsd } from "../../pricing/fees.js";
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

interface SimOrder {
  venueOrderId: string;
  hash: string;
  tokenId: string;
  side: Side;
  price: Fx;
  size: Fx;
  filled: Fx;
  status: VenueOrderState["status"];
  createdAt: number;
  expiresAt: number | null;
  kind: "LIMIT" | "TAKER";
  marketKey: string;
}

export interface SimFaults {
  /** 下一次 submit：交易所实际处理了订单，但回执超时（抛 TimeoutError 风格的网络错误） */
  submitTimeoutNext?: { placeAnyway: boolean };
  /** 下一次 submit 被拒 */
  rejectNext?: { cls: VenueErrorClass; message: string };
  /** 每条事件推送两次 */
  duplicateEvents?: boolean;
  /** 先推送结算成功、再推送撮合（乱序） */
  reorderEvents?: boolean;
  /** 下一笔成交结算失败 */
  settlementFailNext?: boolean;
  /** 不推送成交事件（模拟 WebSocket 丢消息），只能靠 REST 补拉 */
  dropFillEvents?: boolean;
  /** 撤单请求到达时先成交这么多份（撤单途中成交） */
  fillDuringCancel?: Fx;
  userStreamUp?: boolean;
  authOk?: boolean;
}

export interface SimVenueOptions {
  venue: VenueId;
  clock: Clock;
  books: BookStore;
  /** tokenId → 市场 key（用于取手续费等元数据） */
  marketKeyOf: (tokenId: string) => string | null;
  startingBalance: Fx;
  latencyMs?: number;
  /** 撮合后多久推送结算成功；0 表示同时推送 */
  settleDelayMs?: number;
  /** 事件推送方式：async（setImmediate）或 sync */
  emitMode?: "async" | "sync";
  /** 模拟模式下，真实盘口穿过挂价时按此比例成交 */
  makerFillRatio?: number;
  timer?: (fn: () => void, ms: number) => void;
}

/**
 * 模拟交易所：实现与实盘适配器相同的 TradingVenue 接口。
 * 吃单按 BookStore 中的订单簿逐档成交并扣减流动性；挂单在测试中由 fillMaker() 触发，
 * 模拟模式下在真实盘口穿过挂价时触发。
 */
export class SimVenue implements TradingVenue {
  readonly isSimulated = true;
  readonly venue: VenueId;
  private handlers: ((e: VenueEvent) => void)[] = [];
  private orders = new Map<string, SimOrder>();
  private byHash = new Map<string, string>();
  private positions = new Map<string, Fx>();
  private fillLog: VenueFill[] = [];
  private balance: Fx;
  private seq = 0;
  faults: SimFaults = { userStreamUp: true, authOk: true };
  /** 所有 submit 请求（测试断言用） */
  readonly submitted: { kind: "LIMIT" | "TAKER"; side: Side; tokenId: string; price: Fx; size: Fx; amountUsd: Fx | null }[] = [];

  constructor(private readonly o: SimVenueOptions) {
    this.venue = o.venue;
    this.balance = o.startingBalance;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  onEvent(handler: (e: VenueEvent) => void): void {
    this.handlers.push(handler);
  }

  /** 测试：模拟进程崩溃，旧进程的事件处理器全部失效 */
  resetHandlers(): void {
    this.handlers = [];
  }

  private emit(e: VenueEvent): void {
    const send = () => {
      for (const h of this.handlers) h(e);
      if (this.faults.duplicateEvents) for (const h of this.handlers) h(e);
    };
    if ((this.o.emitMode ?? "async") === "sync") send();
    else setImmediate(send);
  }

  private wait(ms: number): Promise<void> {
    if (!ms) return Promise.resolve();
    return new Promise((r) => (this.o.timer ?? ((f, t) => setTimeout(f, t)))(r, ms));
  }

  private meta(tokenId: string): VenueMarketMeta {
    const mk = this.o.marketKeyOf(tokenId);
    const m = mk ? this.o.books.getMeta(this.venue, mk) : null;
    if (!m) throw new VenueError(`模拟交易所缺少市场数据 ${tokenId}`, "OTHER");
    return m;
  }

  private fee(tokenId: string): FeeParams {
    return this.meta(tokenId).fee;
  }

  private reservedForBuys(): Fx {
    let r = 0n;
    for (const o of this.orders.values()) {
      if (o.status === "OPEN" && o.side === "BUY") r += mul(o.size - o.filled, o.price, "ceil");
    }
    return r;
  }

  // ---------------- TradingVenue ----------------

  async prepareLimit(req: LimitOrderRequest): Promise<PreparedOrder> {
    const price = roundToStep(req.price, req.meta.tickSize, "floor");
    const size = roundToStep(req.size, req.meta.shareStep, "floor");
    return { clientOrderId: req.clientOrderId, hash: `0xsim${this.venue}${req.clientOrderId.replace(/-/g, "")}`, price, size, amountUsd: null, payload: { req: "limit" }, expiresAt: req.expiresAt };
  }

  async prepareTaker(req: TakerOrderRequest): Promise<PreparedOrder> {
    const size = roundToStep(req.shares, req.meta.shareStep, "floor");
    return {
      clientOrderId: req.clientOrderId,
      hash: `0xsim${this.venue}${req.clientOrderId.replace(/-/g, "")}`,
      price: req.limitPrice,
      size,
      amountUsd: req.amountUsd,
      payload: { req: "taker" },
      expiresAt: null,
    };
  }

  async submit(p: PreparedOrder, kind: "LIMIT" | "TAKER", req: LimitOrderRequest | TakerOrderRequest): Promise<SubmitResult> {
    this.submitted.push({ kind, side: req.side, tokenId: req.tokenId, price: p.price, size: p.size, amountUsd: p.amountUsd });
    await this.wait(this.o.latencyMs ?? 0);
    if (!this.faults.authOk) return reject("认证失败（模拟）", "AUTH");
    const rej = this.faults.rejectNext;
    if (rej) {
      this.faults.rejectNext = undefined;
      return reject(rej.message, rej.cls);
    }
    const timeout = this.faults.submitTimeoutNext;
    if (timeout) {
      this.faults.submitTimeoutNext = undefined;
      if (timeout.placeAnyway) this.process(p, kind, req);
      throw new VenueError("模拟：下单请求超时（连接被重置）", "NETWORK");
    }
    return this.process(p, kind, req);
  }

  private process(p: PreparedOrder, kind: "LIMIT" | "TAKER", req: LimitOrderRequest | TakerOrderRequest): SubmitResult {
    const now = this.o.clock.now();
    const book = this.o.books.getBook(this.venue, req.tokenId);
    const meta = this.meta(req.tokenId);
    if (!meta.acceptingOrders) return reject("市场不接受订单", "MARKET_CLOSED");
    const oid = `sim-${this.venue}-${++this.seq}`;
    if (this.byHash.has(p.hash!)) return reject("重复订单", "DUPLICATE");
    if (kind === "LIMIT") {
      const r = req as LimitOrderRequest;
      if (r.postOnly && book) {
        const crosses = r.side === "BUY" ? (book.asks[0] && book.asks[0].price <= p.price) : (book.bids[0] && book.bids[0].price >= p.price);
        if (crosses) return reject("post-only 订单会立即成交，已拒绝", "POST_ONLY_CROSS");
      }
      if (r.side === "BUY") {
        const need = mul(p.size, p.price, "ceil");
        if (this.balance - this.reservedForBuys() < need) return reject("余额不足", "INSUFFICIENT_BALANCE");
      }
      const o: SimOrder = { venueOrderId: oid, hash: p.hash!, tokenId: req.tokenId, side: req.side, price: p.price, size: p.size, filled: 0n, status: "OPEN", createdAt: now, expiresAt: r.expiresAt, kind, marketKey: meta.marketKey };
      this.orders.set(oid, o);
      this.byHash.set(o.hash, oid);
      this.emit({ type: "order", venue: this.venue, state: this.stateOf(o), ts: now });
      return { accepted: true, venueOrderId: oid, hash: o.hash, status: "LIVE", reportedFilledShares: 0n, reportedSpentUsd: 0n, tradeIds: [], rejectReason: null, retryable: false, retryAfterMs: null, errorClass: null };
    }
    // 吃单
    const r = req as TakerOrderRequest;
    const o: SimOrder = { venueOrderId: oid, hash: p.hash!, tokenId: r.tokenId, side: r.side, price: r.limitPrice, size: p.size, filled: 0n, status: "OPEN", createdAt: now, expiresAt: null, kind, marketKey: meta.marketKey };
    this.orders.set(oid, o);
    this.byHash.set(o.hash, oid);
    if (r.side === "SELL" && (this.positions.get(r.tokenId) ?? 0n) < p.size) {
      o.status = "CANCELLED";
      return reject("持仓不足", "INSUFFICIENT_BALANCE");
    }
    const levels = r.side === "BUY" ? (book?.asks ?? []) : (book?.bids ?? []);
    const fee = this.fee(r.tokenId);
    const taken: Level[] = [];
    const tradeIds: string[] = [];
    let remainingNet = p.size;
    let budget = p.amountUsd; // Polymarket FAK 买单按金额
    let spent = 0n;
    for (const lvl of levels) {
      if (remainingNet <= 0n) break;
      if (r.side === "BUY" ? lvl.price > r.limitPrice : lvl.price < r.limitPrice) break;
      let gross: Fx;
      if (r.side === "BUY") {
        if (budget !== null && this.venue === "polymarket") {
          if (budget <= 0n) break;
          const byBudget = roundToStep(div(budget, lvl.price, "floor"), meta.shareStep, "floor");
          gross = byBudget < lvl.size ? byBudget : lvl.size;
        } else {
          const npg = buyFeeMode(fee) === "SHARES" ? netPerGrossShare(fee, lvl.price) : ONE;
          const need = div(remainingNet, npg, "ceil");
          gross = need < lvl.size ? need : lvl.size;
        }
      } else {
        gross = remainingNet < lvl.size ? remainingNet : lvl.size;
      }
      if (gross <= 0n) break;
      const notional = mul(gross, lvl.price, "ceil");
      if (r.side === "BUY") {
        const extra = buyFeeMode(fee) === "COLLATERAL" ? takerFeeUsd(fee, lvl.price, gross) : 0n;
        if (this.balance - this.reservedForBuys() < notional + extra) break;
      }
      const tradeId = `t${++this.seq}`;
      tradeIds.push(tradeId);
      taken.push({ price: lvl.price, size: gross });
      const net = this.applyFill(o, tradeId, lvl.price, gross, false, now);
      spent += notional;
      if (budget !== null) budget -= notional;
      remainingNet -= net;
    }
    if (taken.length) this.o.books.consume(this.venue, r.tokenId, r.side, taken);
    o.status = o.filled > 0n ? "FILLED" : "CANCELLED";
    this.emit({ type: "order", venue: this.venue, state: this.stateOf(o), ts: now });
    return {
      accepted: true,
      venueOrderId: oid,
      hash: o.hash,
      status: o.filled > 0n ? "MATCHED" : "UNMATCHED",
      reportedFilledShares: o.filled,
      reportedSpentUsd: spent,
      tradeIds,
      rejectReason: null,
      retryable: false,
      retryAfterMs: null,
      errorClass: null,
    };
  }

  /** 记录一笔成交、更新持仓与余额并推送事件，返回到账净份额。 */
  private applyFill(o: SimOrder, tradeId: string, price: Fx, gross: Fx, isMaker: boolean, now: number): Fx {
    const fee = this.fee(o.tokenId);
    let feeShares = 0n;
    let feeCollateral = 0n;
    if (!isMaker) {
      if (o.side === "BUY") {
        if (buyFeeMode(fee) === "SHARES") feeShares = gross - mul(gross, netPerGrossShare(fee, price), "floor");
        else feeCollateral = takerFeeUsd(fee, price, gross);
      } else {
        feeCollateral = takerFeeUsd(fee, price, gross);
      }
    }
    const notional = mul(gross, price, "ceil");
    const net = o.side === "BUY" ? gross - feeShares : gross;
    o.filled += gross;
    const fail = this.faults.settlementFailNext === true;
    if (fail) this.faults.settlementFailNext = false;
    if (o.side === "BUY") {
      this.balance -= notional + feeCollateral;
      this.positions.set(o.tokenId, (this.positions.get(o.tokenId) ?? 0n) + net);
    } else {
      this.balance += notional - feeCollateral;
      this.positions.set(o.tokenId, (this.positions.get(o.tokenId) ?? 0n) - gross);
    }
    const key = `sim:${this.venue}:${tradeId}:${o.venueOrderId}`;
    const base: VenueFill = {
      key,
      venue: this.venue,
      venueOrderId: o.venueOrderId,
      orderHash: o.hash,
      tokenId: o.tokenId,
      side: o.side,
      price,
      grossShares: gross,
      feeShares: null,
      feeCollateral: null,
      isMaker,
      status: "MATCHED",
      matchedAt: now,
      txHash: null,
    };
    const settled: VenueFill = { ...base, status: fail ? "FAILED" : "SETTLED", feeShares, feeCollateral, txHash: fail ? null : `0xtx${tradeId}` };
    if (fail) {
      // 结算失败：冲回持仓与余额，订单已成交量也冲回
      o.filled -= gross;
      if (o.side === "BUY") {
        this.balance += notional + feeCollateral;
        this.positions.set(o.tokenId, (this.positions.get(o.tokenId) ?? 0n) - net);
      } else {
        this.balance -= notional - feeCollateral;
        this.positions.set(o.tokenId, (this.positions.get(o.tokenId) ?? 0n) + gross);
      }
    }
    this.fillLog.push(settled);
    if (!this.faults.dropFillEvents) {
      const settleDelay = this.o.settleDelayMs ?? 0;
      const sendMatched = () => this.emit({ type: "fill", venue: this.venue, fill: base, ts: now });
      const sendSettled = () => this.emit({ type: "fill", venue: this.venue, fill: settled, ts: now + settleDelay });
      if (this.faults.reorderEvents) {
        sendSettled();
        sendMatched();
      } else if (settleDelay > 0) {
        sendMatched();
        (this.o.timer ?? ((f, t) => setTimeout(f, t)))(sendSettled, settleDelay);
      } else {
        sendMatched();
        sendSettled();
      }
    }
    return fail ? 0n : net;
  }

  async cancel(refs: { venueOrderId: string | null; hash: string | null }[]): Promise<CancelResult> {
    await this.wait(this.o.latencyMs ?? 0);
    if (!this.faults.authOk) throw new VenueError("认证失败（模拟）", "AUTH");
    const out: CancelResult = { cancelled: [], noop: [], rejected: [] };
    const now = this.o.clock.now();
    for (const ref of refs) {
      const id = ref.venueOrderId ?? (ref.hash ? this.byHash.get(ref.hash) : undefined) ?? null;
      const o = id ? this.orders.get(id) : undefined;
      const label = ref.venueOrderId ?? ref.hash ?? "";
      if (!o || o.status !== "OPEN") {
        out.noop.push(label);
        continue;
      }
      if (this.faults.fillDuringCancel && this.faults.fillDuringCancel > 0n) {
        const q = this.faults.fillDuringCancel < o.size - o.filled ? this.faults.fillDuringCancel : o.size - o.filled;
        this.faults.fillDuringCancel = undefined;
        this.applyFill(o, `t${++this.seq}`, o.price, q, true, now);
      }
      if (o.filled >= o.size) {
        o.status = "FILLED";
        out.noop.push(label);
      } else {
        o.status = "CANCELLED";
        out.cancelled.push(label);
      }
      this.emit({ type: "order", venue: this.venue, state: this.stateOf(o), ts: now });
    }
    return out;
  }

  async getOrder(ref: { venueOrderId: string | null; hash: string | null }): Promise<VenueOrderState> {
    const id = ref.venueOrderId ?? (ref.hash ? this.byHash.get(ref.hash) : undefined) ?? (ref.hash ? undefined : undefined);
    const o = (id ? this.orders.get(id) : undefined) ?? (ref.hash ? this.orders.get(this.byHash.get(ref.hash) ?? "") : undefined);
    if (!o) return { venueOrderId: ref.venueOrderId, hash: ref.hash, status: "NOT_FOUND", filled: 0n };
    return this.stateOf(o);
  }

  async listOpenOrders(tokenIds: string[]): Promise<VenueOrderState[]> {
    const set = new Set(tokenIds);
    return [...this.orders.values()].filter((o) => o.status === "OPEN" && (set.size === 0 || set.has(o.tokenId))).map((o) => this.stateOf(o));
  }

  async listFills(sinceMs: number, tokenIds: string[]): Promise<VenueFill[]> {
    const set = new Set(tokenIds);
    return this.fillLog.filter((f) => f.matchedAt >= sinceMs && (set.size === 0 || set.has(f.tokenId)));
  }

  async getBalances(): Promise<Balances> {
    return { collateral: this.balance, available: this.balance - this.reservedForBuys(), updatedAt: this.o.clock.now() };
  }

  async getPositions(tokenIds: string[]): Promise<PositionInfo[]> {
    return tokenIds.map((t) => ({ tokenId: t, shares: this.positions.get(t) ?? 0n }));
  }

  health(): { userStreamUp: boolean; authOk: boolean; lastError: string | null } {
    return { userStreamUp: this.faults.userStreamUp !== false, authOk: this.faults.authOk !== false, lastError: null };
  }

  // ---------------- 测试/模拟辅助 ----------------

  private stateOf(o: SimOrder): VenueOrderState {
    return { venueOrderId: o.venueOrderId, hash: o.hash, status: o.status, tokenId: o.tokenId, side: o.side, price: o.price, size: o.size, filled: o.filled, createdAt: o.createdAt };
  }

  /** 让对手方吃掉我们在某代币上的挂单（我们是 maker），返回成交份额。 */
  fillMaker(tokenId: string, shares: Fx): Fx {
    const now = this.o.clock.now();
    let left = shares;
    for (const o of this.orders.values()) {
      if (left <= 0n) break;
      if (o.tokenId !== tokenId || o.status !== "OPEN" || o.kind !== "LIMIT") continue;
      const q = left < o.size - o.filled ? left : o.size - o.filled;
      if (q <= 0n) continue;
      this.applyFill(o, `t${++this.seq}`, o.price, q, true, now);
      left -= q;
      if (o.filled >= o.size) o.status = "FILLED";
      this.emit({ type: "order", venue: this.venue, state: this.stateOf(o), ts: now });
    }
    return shares - left;
  }

  /** 模拟模式：真实盘口卖价穿过我们的买价时，按穿过的数量成交。 */
  onBookUpdate(tokenId: string): void {
    const book = this.o.books.getBook(this.venue, tokenId);
    if (!book) return;
    const ratio = this.o.makerFillRatio ?? 1;
    for (const o of this.orders.values()) {
      if (o.tokenId !== tokenId || o.status !== "OPEN" || o.kind !== "LIMIT" || o.side !== "BUY") continue;
      let crossing = 0n;
      for (const a of book.asks) {
        if (a.price > o.price) break;
        crossing += a.size;
      }
      if (crossing <= 0n) continue;
      const scaled = ratio >= 1 ? crossing : (crossing * BigInt(Math.round(ratio * 1000))) / 1000n;
      const q = scaled < o.size - o.filled ? scaled : o.size - o.filled;
      if (q > 0n) this.fillMaker(tokenId, q);
    }
  }

  /** 到期处理（模拟 GTD / Predict expiresAt）。 */
  expireOrders(): void {
    const now = this.o.clock.now();
    for (const o of this.orders.values()) {
      if (o.status === "OPEN" && o.expiresAt !== null && o.expiresAt <= now) {
        o.status = "EXPIRED";
        this.emit({ type: "order", venue: this.venue, state: this.stateOf(o), ts: now });
      }
    }
  }

  setBalance(v: Fx): void {
    this.balance = v;
  }

  position(tokenId: string): Fx {
    return this.positions.get(tokenId) ?? 0n;
  }

  emitStream(up: boolean): void {
    this.faults.userStreamUp = up;
    this.emit({ type: "stream", venue: this.venue, channel: "user", up, ts: this.o.clock.now() });
  }

  openOrders(): VenueOrderState[] {
    return [...this.orders.values()].filter((o) => o.status === "OPEN").map((o) => this.stateOf(o));
  }
}

function reject(message: string, cls: VenueErrorClass): SubmitResult {
  return {
    accepted: false,
    venueOrderId: null,
    hash: null,
    status: "REJECTED",
    reportedFilledShares: null,
    reportedSpentUsd: null,
    tradeIds: [],
    rejectReason: message,
    retryable: cls === "RATE_LIMIT" || cls === "RESTARTING",
    retryAfterMs: null,
    errorClass: cls,
  };
}

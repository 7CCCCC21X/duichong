import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { abs, div, fx, max, min, mul, ONE, roundToStep, toStr, type Fx } from "../core/fixed.js";
import { errMsg, KeyedSerialQueue, TimeoutError, withTimeout } from "../core/async.js";
import type { Clock } from "../core/time.js";
import { bjTime } from "../core/time.js";
import {
  isTerminalOrder,
  otherOutcome,
  otherVenue,
  type Book,
  type Instrument,
  type OrderRole,
  type OrderStatus,
  type Outcome,
  type Side,
  type VenueFill,
  type VenueId,
  type VenueMarketMeta,
  type VenueOrderState,
} from "../core/types.js";
import type { RiskConfig, StrategyConfig } from "../config/schema.js";
import type { FillRow, OrderRow, Repo } from "../db/repo.js";
import type { BookSource } from "../market/bookStore.js";
import { effectiveBuyPrice, effectiveSellPrice, maxRawPriceForEffectiveCap, minRawPriceForEffectiveFloor } from "../pricing/fees.js";
import { checkMinOrder, computeQuote, type Quote } from "../pricing/quote.js";
import { walkBuy, walkSell } from "../pricing/walk.js";
import type { LimitOrderRequest, SubmitResult, TakerOrderRequest, TradingVenue } from "../venues/types.js";
import { VenueError } from "../venues/types.js";
import type { AlertSink } from "./alerts.js";
import { avgCost, computePositions, netExposure, pnlSummary, toFillRow, type Positions } from "./ledger.js";
import { emptyCommitment, type RiskManager } from "./risk.js";

export interface ActivePair {
  id: string;
  makerVenue: VenueId;
  makerOutcome: Outcome;
  strategy: StrategyConfig;
  risk: RiskConfig;
  /** instruments[venue][outcome] */
  instruments: Record<VenueId, Record<Outcome, Instrument>>;
  marketKeys: Record<VenueId, string>;
  startTime: number | null;
  /** 配对核对通过且未暂停 */
  tradeable: boolean;
  blockReason: string | null;
  labels: Record<Outcome, string>;
  /** 挂单有效期（秒），0 表示不过期（Predict 用短有效期兜底进程失联） */
  makerOrderTtlSec: number;
  /** 到期前多少秒续挂 */
  makerRefreshBeforeSec: number;
}

export interface EngineDeps {
  repo: Repo;
  clock: Clock;
  venues: Record<VenueId, TradingVenue>;
  books: BookSource;
  risk: RiskManager;
  alerts: AlertSink;
  log: Logger;
  queue: KeyedSerialQueue;
  /** 定时器（测试可替换） */
  setTimer?: (fn: () => void, ms: number) => void;
}

interface OrderCtx {
  order: OrderRow;
  ledgerFilled: Fx;
}

export interface PairSnapshot {
  id: string;
  labels: Record<Outcome, string>;
  makerVenue: VenueId;
  makerOutcome: Outcome;
  mode: string;
  reason: string | null;
  exposureMode: string;
  exposureReason: string | null;
  emergency: { since: number; reason: string } | null;
  startTime: number | null;
  stopQuotingAt: number | null;
  positions: Positions;
  netExposure: Fx;
  projectedNet: Fx;
  nakedSince: number | null;
  pnl: ReturnType<typeof pnlSummary>;
  lastQuote: Quote | null;
  orders: OrderRow[];
  fills: FillRow[];
  episodes: { startedAt: number; resolvedAt: number | null; peak: Fx; resolution: string | null }[];
  books: Record<string, { bids: { price: Fx; size: Fx }[]; asks: { price: Fx; size: Fx }[]; ageMs: number } | null>;
}

const NOT_FOUND_GRACE_MS = 30_000;
const SENDING_STUCK_MS = 20_000;
const CANCEL_RETRY_MS = 3_000;

/**
 * 单个配对的交易状态机。
 *
 * 并发模型：所有读写本配对状态的逻辑都在 queue.run(pairId) 里串行执行（evaluate / onFill / onOrderState）；
 * 下单、撤单、查单这类网络请求在队列外执行，结果写库后再排队触发 evaluate。
 * 下单前订单记录先以 INTENT 落库，记录本身就是“在途预占”，后续 evaluate 能看到，避免重复补单。
 */
export class PairEngine {
  private reconciled = false;
  /** 对账中“近期成交补拉”已完成：之后才允许基于台账下补单 */
  private fillsSynced = false;
  private emergency: { since: number; reason: string } | null = null;
  private cooldownUntil = 0;
  private nakedSince: number | null = null;
  private residualSince: number | null = null;
  private episodeId: number | null = null;
  private episodePeak: Fx = 0n;
  private normalAttempts = 0;
  private lastHedgeAt = 0;
  private lastRequoteAt = 0;
  private lastQuote: Quote | null = null;
  private mode = "INIT";
  private modeReason: string | null = null;
  private exposureMode = "FLAT";
  private exposureReason: string | null = null;
  private evalQueued = false;
  private resolving = new Set<string>();
  private residualAlerted = false;
  private disposed = false;
  private lastFillAt = 0;
  private readonly log: Logger;

  constructor(
    public pair: ActivePair,
    private readonly d: EngineDeps,
  ) {
    this.log = d.log.child({ pair: pair.id });
    const e = d.repo.getKv(`pair.${pair.id}.emergency`);
    if (e) this.emergency = JSON.parse(e) as { since: number; reason: string };
  }

  get id(): string {
    return this.pair.id;
  }

  get hedgeVenue(): VenueId {
    return otherVenue(this.pair.makerVenue);
  }

  setReconciled(v: boolean): void {
    this.reconciled = v;
    if (v) this.fillsSynced = true;
  }

  /** 对账开始时调用：暂停新挂单与新补单，直到成交补拉完成。 */
  beginReconcile(): void {
    this.reconciled = false;
    this.fillsSynced = false;
  }

  setFillsSynced(v: boolean): void {
    this.fillsSynced = v;
  }

  isReconciled(): boolean {
    return this.reconciled;
  }

  updatePair(p: ActivePair): void {
    this.pair = p;
  }

  dispose(): void {
    this.disposed = true;
  }

  /** 请求一次评估（合并重复请求）。 */
  schedule(reason = "tick"): Promise<void> {
    if (this.evalQueued || this.disposed) return Promise.resolve();
    this.evalQueued = true;
    return this.d.queue.run(this.pair.id, async () => {
      this.evalQueued = false;
      try {
        await this.evaluate(reason);
      } catch (e) {
        this.log.error({ err: e }, "评估出错");
        this.d.alerts.raise("warn", "EVAL_ERROR", `评估出错：${errMsg(e)}`, { pairId: this.pair.id });
      }
    });
  }

  private later(fn: () => void, ms: number): void {
    (this.d.setTimer ?? ((f, t) => void setTimeout(f, t).unref?.()))(fn, ms);
  }

  // =====================================================================
  // 事件入口（必须在本配对队列中调用）
  // =====================================================================

  /** 处理一条属于本配对订单的成交（幂等）。 */
  onFill(order: OrderRow, vf: VenueFill): void {
    const meta = this.meta(order.venue);
    if (!meta) {
      this.log.warn({ order: order.id }, "缺少市场元数据，手续费按 0 估算");
    }
    const fee = meta?.fee ?? (order.venue === "polymarket" ? { kind: "polymarket" as const, rate: 0n, exponent: 1, enabled: false } : { kind: "predict" as const, rateBps: 0, exponent: 1 });
    const row = toFillRow(vf, order, fee, this.d.clock.now());
    const res = this.d.repo.upsertFill(row);
    if (res.action === "ignored") return;
    this.d.repo.logEvent(this.d.clock.now(), order.venue, `fill.${res.action}`, row.key, {
      status: row.status,
      side: row.side,
      outcome: row.outcome,
      price: toStr(row.price, 4),
      gross: toStr(row.grossShares, 6),
      net: toStr(row.netShares, 6),
      role: row.role,
    });
    this.log.info(
      {
        fill: row.key,
        action: res.action,
        role: row.role,
        venue: row.venue,
        side: row.side,
        outcome: row.outcome,
        price: toStr(row.price, 4),
        net: toStr(row.netShares, 6),
        status: row.status,
      },
      res.action === "inserted" ? "新成交" : `成交状态更新 ${res.prev?.status} → ${row.status}`,
    );
    this.lastFillAt = this.d.clock.now();
    if (row.status === "FAILED" && res.prev && res.prev.status !== "FAILED") {
      this.d.alerts.raise("warn", "SETTLEMENT_FAILED", `${order.venue} 成交结算失败，已冲回 ${toStr(row.netShares, 4)} 份（${row.role}）`, {
        pairId: this.pair.id,
        data: { key: row.key },
      });
    }
    void this.schedule("fill");
  }

  /** 交易所推送或查询得到的订单状态（幂等）。 */
  onOrderState(order: OrderRow, st: VenueOrderState, reason?: string): void {
    const now = this.d.clock.now();
    const patch: Partial<OrderRow> = {};
    if (st.venueOrderId && !order.venueOrderId) patch.venueOrderId = st.venueOrderId;
    if (st.hash && !order.hash) patch.hash = st.hash;
    if (st.filled > order.reportedFilled) patch.reportedFilled = st.filled;
    const mapped = mapVenueStatus(order, st, now);
    if (mapped && mapped !== order.status) {
      patch.status = mapped;
      if (mapped === "ACCEPTED" && !order.ackAt) patch.ackAt = now;
      if (reason) patch.error = reason;
    }
    if (Object.keys(patch).length === 0) return;
    this.d.repo.updateOrder(order.id, patch, now);
    void this.schedule("order-state");
  }

  onPlannedFill(order: OrderRow, planned: Fx): void {
    if (order.plannedFill !== null && order.plannedFill === planned) return;
    this.d.repo.updateOrder(order.id, { plannedFill: planned }, this.d.clock.now());
    void this.schedule("plan");
  }

  // =====================================================================
  // 主评估
  // =====================================================================

  async evaluate(reason: string): Promise<void> {
    if (this.disposed) return;
    const now = this.d.clock.now();
    const orders = this.d.repo.listOrders({ pairId: this.pair.id, limit: 400 });
    const fills = this.d.repo.listFills({ pairId: this.pair.id });
    const ledgerByOrder = new Map<string, Fx>();
    for (const f of fills) {
      if (f.status === "FAILED" || !f.orderId) continue;
      ledgerByOrder.set(f.orderId, (ledgerByOrder.get(f.orderId) ?? 0n) + f.grossShares);
    }
    const ctx: OrderCtx[] = orders.map((o) => ({ order: o, ledgerFilled: ledgerByOrder.get(o.id) ?? 0n }));
    const positions = computePositions(fills, this.pair.strategy.hedgeTrigger);
    const net = netExposure(positions);

    // 1) 处理卡住的订单：状态未知、发送超时、撤单待重试、吃单回执与推送不一致
    this.resolveStuckOrders(ctx, now);

    // 2) 在途补单预占后的预计敞口
    const projected = net + this.inflightDelta(ctx, now);

    // 3) 更新风控占用
    this.updateCommitment(ctx, positions, projected);

    // 4) 敞口处理
    await this.manageExposure(ctx, positions, net, projected, now);

    // 5) 挂单管理
    this.manageMaker(ctx, positions, projected, now);

    if (reason !== "tick") this.log.debug({ reason, net: toStr(net, 4), projected: toStr(projected, 4), mode: this.mode }, "评估完成");
  }

  // ---------------------------------------------------------------------
  // 敞口与补单
  // ---------------------------------------------------------------------

  /** 在途吃单（补单/平仓）完成后对净敞口（A−B）的预计影响。 */
  private inflightDelta(ctx: OrderCtx[], now: number): Fx {
    let delta = 0n;
    for (const c of ctx) {
      const r = this.reservedShares(c, now);
      if (r <= 0n) continue;
      const sign = (c.order.side === "BUY") === (c.order.outcome === "A") ? 1n : -1n;
      delta += sign * r;
    }
    return delta;
  }

  /**
   * 在途吃单仍可能带来的成交份额（预占）：
   * - 未终结：预期数量（Predict 有撮合计划时用计划量）减去已入账；
   * - 已终结：回执显示已成交但推送尚未入账的部分，在宽限期内保留。
   */
  private reservedShares(c: OrderCtx, now: number): Fx {
    const o = c.order;
    if (o.role === "MAKER") return 0n;
    if (!isTerminalOrder(o.status)) {
      const expected = o.plannedFill ?? o.size;
      const r = expected - c.ledgerFilled;
      return r > 0n ? r : 0n;
    }
    if (o.reportedFilled > c.ledgerFilled) {
      const since = o.terminalAt ?? o.updatedAt;
      if (now - since < this.pair.strategy.hedge.fillGraceMs) return o.reportedFilled - c.ledgerFilled;
    }
    return 0n;
  }

  private async manageExposure(ctx: OrderCtx[], pos: Positions, net: Fx, projected: Fx, now: number): Promise<void> {
    const s = this.pair.strategy;
    const dust = fx(s.residual.dustShares);
    const absNet = abs(net);
    const absProj = abs(projected);

    // 敞口事件（裸仓计时）
    if (absNet > dust) {
      if (this.nakedSince === null) {
        this.nakedSince = now;
        this.episodePeak = absNet;
        this.normalAttempts = 0;
        this.episodeId = this.d.repo.openEpisode(this.pair.id, now, absNet);
      } else if (absNet > this.episodePeak) {
        this.episodePeak = absNet;
        if (this.episodeId) this.d.repo.updateEpisode(this.episodeId, { peak: absNet });
      }
    } else if (this.nakedSince !== null) {
      if (this.episodeId) {
        this.d.repo.updateEpisode(this.episodeId, {
          resolvedAt: now,
          resolution: this.emergency ? "emergency" : absNet === 0n ? "hedged" : "dust",
        });
      }
      this.log.info({ ms: now - this.nakedSince, peak: toStr(this.episodePeak, 4) }, "敞口已对齐");
      this.nakedSince = null;
      this.residualSince = null;
      this.episodeId = null;
      this.normalAttempts = 0;
      this.residualAlerted = false;
      if (this.emergency) this.clearEmergency("敞口已处理完毕");
    }

    if (absProj <= dust) {
      this.residualSince = null;
      if (absNet <= dust) this.setMode("FLAT", null);
      return;
    }
    // 有吃单在途（未终结）就不再下新的吃单，保证同一配对同时最多一笔在途吃单
    if (ctx.some((c) => c.order.role !== "MAKER" && !isTerminalOrder(c.order.status))) return;
    // 对账补拉成交完成前不下补单，避免基于不完整的台账补单
    if (!this.fillsSynced) {
      this.setMode("HEDGING", "等待对账补拉成交后再补单");
      return;
    }

    // 升级到紧急处理的条件
    const r = this.pair.risk;
    if (!this.emergency) {
      const nakedMs = this.nakedSince !== null ? now - this.nakedSince : 0;
      let why: string | null = null;
      if (absNet > fx(r.maxUnhedgedShares)) why = `未对冲 ${toStr(absNet, 2)} 份超过上限 ${r.maxUnhedgedShares}`;
      else if (nakedMs > r.maxNakedSec * 1000 && absProj >= this.minHedgeShares(projected)) why = `裸仓 ${(nakedMs / 1000).toFixed(1)}s 超过上限 ${r.maxNakedSec}s`;
      else if (this.normalAttempts >= s.hedge.maxNormalAttempts) why = `正常补单 ${this.normalAttempts} 次未完成`;
      else if (!this.venueUsable(this.hedgeVenue, true)) why = `补单平台不可用：${this.venueProblem(this.hedgeVenue) ?? "未知"}`;
      if (why) this.enterEmergency(why, ctx);
    }

    const excess: Outcome = projected > 0n ? "A" : "B";
    if (now - this.lastHedgeAt < Math.min(s.hedge.retryIntervalMs, 1000) && !this.emergency) return;
    // 合并窗口：几乎同时到达的多笔成交（例如双边挂单两边同时成交）先净额再决定是否补单
    const sinceFill = now - this.lastFillAt;
    if (s.hedge.coalesceMs > 0 && sinceFill < s.hedge.coalesceMs) {
      this.later(() => void this.schedule("coalesce"), s.hedge.coalesceMs - sinceFill + 1);
      return;
    }

    if (this.emergency) {
      await this.emergencyResolve(pos, excess, absProj, now);
    } else {
      await this.normalResolve(pos, excess, absProj, ctx, now);
    }
  }

  private minHedgeShares(projected: Fx): Fx {
    const excess: Outcome = projected > 0n ? "A" : "B";
    const hv = this.hedgeVenue;
    const target = this.pair.instruments[hv][otherOutcome(excess)];
    const meta = this.meta(hv);
    const book = this.d.books.getBook(hv, target.tokenId);
    if (!meta) return ONE;
    const p = book?.asks[0]?.price ?? fx("0.5");
    let m = meta.minOrderShares;
    if (meta.minBuyValue > 0n && p > 0n) m = max(m, div(meta.minBuyValue, p, "ceil"));
    return m;
  }

  /** 正常补单：在对冲平台买入互补结果；若是对冲腿多出，比较卖回与反向买入。 */
  private async normalResolve(pos: Positions, excess: Outcome, qty: Fx, ctx: OrderCtx[], now: number): Promise<void> {
    const s = this.pair.strategy;
    const hv = this.hedgeVenue;
    const mv = this.pair.makerVenue;
    const avgEx = avgCost(pos, excess);
    const capEff = ONE - avgEx - fx(s.hedge.minProfitPerShare);

    const candidates: Candidate[] = [];
    if (excess === this.pair.makerOutcome) {
      // 标准补单：在对冲平台买另一队
      candidates.push(this.buyCandidate(hv, otherOutcome(excess), qty, capEff, avgEx));
    } else {
      // 对冲腿多出（例如挂单成交结算失败、吃单多成交）：卖回多出的对冲腿，或在挂单平台吃入挂单方向
      candidates.push(this.sellCandidate(hv, excess, min(qty, pos.shares[hv][excess]), avgEx - fx(s.hedge.minProfitPerShare), avgEx));
      candidates.push(this.buyCandidate(mv, otherOutcome(excess), qty, capEff, avgEx));
    }
    const viable = candidates.filter((c) => c.ok && c.shares > 0n).sort((a, b) => (b.pnlPerShare > a.pnlPerShare ? 1 : -1));
    const best = viable[0];
    if (!best) {
      // 正常价格内无深度或低于最小单
      const below = candidates.find((c) => c.belowMin);
      if (below) {
        await this.handleResidual(pos, excess, qty, ctx, now);
        return;
      }
      if (this.normalAttempts === 0 || now - this.lastHedgeAt > s.hedge.retryIntervalMs * 4) {
        this.lastHedgeAt = now;
        this.normalAttempts++;
        this.log.warn({ excess, qty: toStr(qty, 4), reasons: candidates.map((c) => c.reason) }, "正常价格内无法补单，等待盘口");
      }
      this.setMode("HEDGING", "等待可用对冲价格");
      return;
    }
    this.residualSince = null;
    this.setMode("HEDGING", `补单 ${toStr(best.shares, 4)} 份`);
    this.normalAttempts++;
    this.lastHedgeAt = now;
    this.launchTaker(best, best.side === "BUY" ? "HEDGE" : "UNWIND");
  }

  /** 残余低于补单最小单时的处理。 */
  private async handleResidual(pos: Positions, excess: Outcome, qty: Fx, ctx: OrderCtx[], now: number): Promise<void> {
    const s = this.pair.strategy;
    if (this.residualSince === null) this.residualSince = now;
    // 仍在挂单（或允许继续挂单、只是正在撤换报价）时，后续成交可能把残余凑够最小单，先等待
    const makerLive = ctx.some((c) => c.order.role === "MAKER" && !isTerminalOrder(c.order.status));
    const quotingExpected = this.quoteBlocker(now) === null;
    if ((makerLive || quotingExpected) && now - this.residualSince < s.residual.maxWaitSec * 1000) {
      this.setMode("RESIDUAL_WAIT", `残余 ${toStr(qty, 4)} 份低于最小单，等待更多成交`);
      return;
    }
    // 尝试在持有该结果的平台卖出（Predict 市价卖最小 0.01 份），或在另一平台反向买入
    const avgEx = avgCost(pos, excess);
    const floor = avgEx - fx(this.pair.risk.maxLossPerShare);
    const cap = ONE - avgEx + fx(this.pair.risk.maxLossPerShare);
    const cands: Candidate[] = [];
    for (const v of ["predict", "polymarket"] as VenueId[]) {
      const held = pos.shares[v][excess];
      if (held > 0n) cands.push(this.sellCandidate(v, excess, min(qty, held), floor, avgEx));
      cands.push(this.buyCandidate(v, otherOutcome(excess), qty, cap, avgEx));
    }
    const viable = cands.filter((c) => c.ok && c.shares > 0n).sort((a, b) => (b.pnlPerShare > a.pnlPerShare ? 1 : -1));
    const best = viable[0];
    if (best && this.lossAllowed(best)) {
      this.setMode("RESIDUAL", `处理残余 ${toStr(best.shares, 4)} 份`);
      this.lastHedgeAt = now;
      this.recordExpectedLoss(best);
      this.launchTaker(best, best.side === "BUY" ? "HEDGE" : "UNWIND");
      return;
    }
    this.setMode("RESIDUAL", `残余 ${toStr(qty, 4)} 份无法处理`);
    if (!this.residualAlerted) {
      this.residualAlerted = true;
      this.d.alerts.raise("warn", "RESIDUAL", `小额残余 ${toStr(qty, 4)} 份（${this.pair.labels[excess]}）低于两边最小单或超出亏损限制，保留并继续监控`, {
        pairId: this.pair.id,
      });
    }
  }

  private enterEmergency(reason: string, ctx: OrderCtx[]): void {
    this.emergency = { since: this.d.clock.now(), reason };
    this.d.repo.setKv(`pair.${this.pair.id}.emergency`, JSON.stringify(this.emergency), this.d.clock.now());
    this.d.alerts.raise("critical", "EMERGENCY", `进入紧急处理：${reason}；撤销剩余挂单`, { pairId: this.pair.id });
    for (const c of ctx) if (c.order.role === "MAKER" && !isTerminalOrder(c.order.status)) this.launchCancel(c.order, "紧急处理撤单");
    this.setMode("EMERGENCY", reason);
  }

  private clearEmergency(why: string): void {
    if (!this.emergency) return;
    this.d.alerts.raise("info", "EMERGENCY_CLEARED", `紧急处理结束：${why}`, { pairId: this.pair.id });
    this.emergency = null;
    this.cooldownUntil = this.d.clock.now() + this.pair.strategy.emergencyCooldownSec * 1000;
    this.d.repo.setKv(`pair.${this.pair.id}.emergency`, "", this.d.clock.now());
  }

  /** 紧急处理：在亏损限制内比较“紧急补反向”与“卖回原腿”，选亏损最小者。 */
  private async emergencyResolve(pos: Positions, excess: Outcome, qty: Fx, now: number): Promise<void> {
    const r = this.pair.risk;
    const avgEx = avgCost(pos, excess);
    const cap = ONE - avgEx + fx(r.maxLossPerShare);
    const floor = avgEx - fx(r.maxLossPerShare);
    const cands: Candidate[] = [];
    for (const v of ["predict", "polymarket"] as VenueId[]) {
      cands.push(this.buyCandidate(v, otherOutcome(excess), qty, cap, avgEx));
      const held = pos.shares[v][excess];
      if (held > 0n) cands.push(this.sellCandidate(v, excess, min(qty, held), floor, avgEx));
    }
    const viable = cands.filter((c) => c.ok && c.shares > 0n).sort((a, b) => (b.pnlPerShare > a.pnlPerShare ? 1 : -1));
    this.setMode("EMERGENCY", this.emergency?.reason ?? "紧急处理");
    if (viable.length === 0) {
      this.d.risk.halt(`配对 ${this.pair.id} 紧急处理在亏损限制内无可用盘口`);
      this.d.alerts.raise("critical", "EMERGENCY_STUCK", `紧急处理无可用方案：${cands.map((c) => c.reason).join("；")}；已停止全部新挂单`, {
        pairId: this.pair.id,
        dedupeMs: 120_000,
      });
      return;
    }
    let best = viable[0]!;
    if (!this.lossAllowed(best)) {
      const fitted = this.fitToLossRoom(best);
      this.d.risk.halt(`配对 ${this.pair.id} 紧急处理预计亏损超过限制`);
      this.d.alerts.raise("critical", "LOSS_LIMIT", `紧急处理预计亏损超过限制，已停止全部新挂单；仅执行限额内部分`, { pairId: this.pair.id, dedupeMs: 120_000 });
      if (!fitted) return;
      best = fitted;
    }
    this.log.warn(
      { action: `${best.side} ${best.outcome} @${best.venue}`, shares: toStr(best.shares, 4), pnlPerShare: toStr(best.pnlPerShare, 4) },
      "紧急处理下单",
    );
    this.lastHedgeAt = now;
    this.recordExpectedLoss(best);
    this.launchTaker(best, best.side === "BUY" ? "HEDGE" : "UNWIND");
  }

  private lossAllowed(c: Candidate): boolean {
    if (c.pnlPerShare >= 0n) return true;
    const loss = mul(-c.pnlPerShare, c.shares, "ceil");
    return loss <= this.pairLossRoom() && loss <= this.d.risk.dailyLossRoom();
  }

  private fitToLossRoom(c: Candidate): Candidate | null {
    if (c.pnlPerShare >= 0n) return c;
    const room = min(this.pairLossRoom(), this.d.risk.dailyLossRoom());
    const shares = roundToStep(div(room, -c.pnlPerShare, "floor"), this.meta(c.venue)?.shareStep ?? fx("0.01"), "floor");
    if (shares <= 0n) return null;
    const meta = this.meta(c.venue);
    if (meta && checkMinOrder(meta, c.limitPrice, shares, c.side, true)) return null;
    return { ...c, shares };
  }

  private pairLossRoom(): Fx {
    const used = BigInt(this.d.repo.getKv(`pair.${this.pair.id}.loss`) ?? "0");
    const room = fx(this.pair.risk.maxLossPerPairUsd) - used;
    return room > 0n ? room : 0n;
  }

  private recordExpectedLoss(c: Candidate): void {
    if (c.pnlPerShare >= 0n) return;
    const loss = mul(-c.pnlPerShare, c.shares, "ceil");
    const used = BigInt(this.d.repo.getKv(`pair.${this.pair.id}.loss`) ?? "0");
    this.d.repo.setKv(`pair.${this.pair.id}.loss`, (used + loss).toString(), this.d.clock.now());
    this.d.risk.recordLoss(loss);
  }

  /** 构造“买入某结果”的吃单方案：每份实际成本不超过 capEff，且原始价格不超过补单硬上限。 */
  private buyCandidate(v: VenueId, outcome: Outcome, qty: Fx, capEff: Fx, avgExcessCost: Fx): Candidate {
    const inst = this.pair.instruments[v][outcome];
    const base = { venue: v, outcome, side: "BUY" as Side, tokenId: inst.tokenId };
    const meta = this.meta(v);
    const book = this.d.books.getBook(v, inst.tokenId);
    if (!meta || !book) return fail(base, "缺少行情或市场数据");
    if (!this.venueUsable(v, true)) return fail(base, `平台不可用：${this.venueProblem(v)}`);
    if (!meta.acceptingOrders || meta.postOnlyOnly) return fail(base, `市场不接受吃单（${meta.statusText}）`);
    if (this.bookStale(book)) {
      this.d.books.requestRefresh(v, inst.tokenId);
      return fail(base, "行情过期");
    }
    let rawCap = maxRawPriceForEffectiveCap(meta.fee, capEff, meta.tickSize);
    if (rawCap === null) return fail(base, `价格上限过低（每份成本上限 ${toStr(capEff, 4)}）`);
    const hardCap = roundToStep(fx(this.pair.risk.maxHedgePrice), meta.tickSize, "floor");
    if (rawCap > hardCap) rawCap = hardCap;
    const w = walkBuy(book.asks, qty, meta.fee, { maxPrice: rawCap });
    const shares = roundToStep(w.netShares, meta.shareStep, "floor");
    if (shares <= 0n) return fail(base, `价格上限 ${toStr(rawCap, 4)} 内无卖单`);
    const minErr = checkMinOrder(meta, w.worstPrice, shares, "BUY", true);
    if (minErr) return { ...fail(base, minErr), belowMin: true };
    const w2 = walkBuy(book.asks, shares, meta.fee, { maxPrice: rawCap });
    return {
      ...base,
      ok: true,
      reason: "",
      shares,
      limitPrice: rawCap,
      amountUsd: w2.notional,
      levels: book.asks,
      pnlPerShare: ONE - avgExcessCost - w2.avgEffPrice,
      belowMin: false,
    };
  }

  /** 构造“卖出某结果”的吃单方案：每份实际所得不低于 floorEff。 */
  private sellCandidate(v: VenueId, outcome: Outcome, qty: Fx, floorEff: Fx, avgExcessCost: Fx): Candidate {
    const inst = this.pair.instruments[v][outcome];
    const base = { venue: v, outcome, side: "SELL" as Side, tokenId: inst.tokenId };
    const meta = this.meta(v);
    const book = this.d.books.getBook(v, inst.tokenId);
    if (qty <= 0n) return fail(base, "无可卖持仓");
    if (!meta || !book) return fail(base, "缺少行情或市场数据");
    if (!this.venueUsable(v, true)) return fail(base, `平台不可用：${this.venueProblem(v)}`);
    if (!meta.acceptingOrders || meta.postOnlyOnly) return fail(base, `市场不接受吃单（${meta.statusText}）`);
    if (this.bookStale(book)) {
      this.d.books.requestRefresh(v, inst.tokenId);
      return fail(base, "行情过期");
    }
    const rawFloor = floorEff > 0n ? minRawPriceForEffectiveFloor(meta.fee, floorEff, meta.tickSize) : meta.tickSize;
    if (rawFloor === null) return fail(base, "卖价下限无解");
    const w = walkSell(book.bids, qty, meta.fee, { minPrice: rawFloor });
    const shares = roundToStep(w.soldShares, meta.shareStep, "floor");
    if (shares <= 0n) return fail(base, `价格下限 ${toStr(rawFloor, 4)} 内无买单`);
    const minErr = checkMinOrder(meta, w.worstPrice, shares, "SELL", true);
    if (minErr) return { ...fail(base, minErr), belowMin: true };
    const w2 = walkSell(book.bids, shares, meta.fee, { minPrice: rawFloor });
    return {
      ...base,
      ok: true,
      reason: "",
      shares,
      limitPrice: rawFloor,
      amountUsd: null,
      levels: book.bids,
      pnlPerShare: w2.avgEffPrice - avgExcessCost,
      belowMin: false,
    };
  }

  // ---------------------------------------------------------------------
  // 挂单
  // ---------------------------------------------------------------------

  stopQuotingAt(): number | null {
    const s = this.pair.strategy;
    const ts: number[] = [];
    if (this.pair.startTime !== null) ts.push(this.pair.startTime - s.stopQuotingBeforeStartSec * 1000);
    if (s.stopQuotingAt) {
      const t = Date.parse(s.stopQuotingAt);
      if (Number.isFinite(t)) ts.push(t);
    }
    return ts.length ? Math.min(...ts) : null;
  }

  /** 不允许挂单的原因；null 表示可以挂单。 */
  private quoteBlocker(now: number): string | null {
    if (!this.pair.tradeable) return this.pair.blockReason ?? "配对未通过核对";
    if (!this.reconciled) return "等待对账完成";
    if (this.d.risk.halted) return `全局停止新挂单：${this.d.risk.halted.reason}`;
    if (this.emergency) return `紧急处理中：${this.emergency.reason}`;
    if (now < this.cooldownUntil) return `紧急处理后冷却中，至 ${bjTime(this.cooldownUntil)}`;
    const stopAt = this.stopQuotingAt();
    if (stopAt !== null && now >= stopAt) return `已到停止挂单时间 ${bjTime(stopAt)}`;
    const mv = this.pair.makerVenue;
    for (const v of [mv, this.hedgeVenue]) {
      if (!this.venueUsable(v, false)) return `${v} 不可用：${this.venueProblem(v)}`;
    }
    return null;
  }

  private manageMaker(ctx: OrderCtx[], pos: Positions, projected: Fx, now: number): void {
    const s = this.pair.strategy;
    const mv = this.pair.makerVenue;
    const makerInst = this.pair.instruments[mv][this.pair.makerOutcome];
    const hedgeInst = this.pair.instruments[this.hedgeVenue][otherOutcome(this.pair.makerOutcome)];
    const makers = ctx.filter((c) => c.order.role === "MAKER" && !isTerminalOrder(c.order.status));
    // 对账进行中：不下新挂单，也不因此撤掉已有挂单（已有挂单的成交照常处理）
    if (!this.reconciled && this.pair.tradeable) {
      this.setMode("IDLE", "等待对账完成");
      return;
    }
    const blocker = this.quoteBlocker(now);
    const makerMeta = this.meta(mv);
    const hedgeMeta = this.meta(this.hedgeVenue);
    const makerBook = this.d.books.getBook(mv, makerInst.tokenId);
    const hedgeBook = this.d.books.getBook(this.hedgeVenue, hedgeInst.tokenId);

    let stop: string | null = blocker;
    if (!stop && (!makerMeta || !hedgeMeta || !makerBook || !hedgeBook)) stop = "缺少行情或市场数据";
    if (!stop && (this.bookStale(makerBook!) || this.bookStale(hedgeBook!))) {
      stop = "行情过期（盘口断连）";
      if (this.bookStale(hedgeBook!)) this.d.books.requestRefresh(this.hedgeVenue, hedgeInst.tokenId);
      if (this.bookStale(makerBook!)) this.d.books.requestRefresh(mv, makerInst.tokenId);
    }

    if (stop) {
      for (const c of makers) if (c.order.status !== "CANCEL_REQUESTED") this.launchCancel(c.order, stop);
      this.setMode("IDLE", stop);
      this.lastQuote = { ok: false, reason: stop };
      return;
    }

    // 计算报价：先按非成本类上限，再按每份成本复算资金上限
    const quoteArgs = {
      makerMeta: makerMeta!,
      hedgeMeta: hedgeMeta!,
      makerBook: this.bookWithoutOwnOrders(makerBook!, makers),
      hedgeBook: hedgeBook!,
      targetShares: fx(s.sizeShares),
      priceMode: s.priceMode,
      fixedPrice: s.price !== null ? fx(s.price) : null,
      minMakerPrice: s.minMakerPrice !== null ? fx(s.minMakerPrice) : null,
      maxMakerPrice: s.maxMakerPrice !== null ? fx(s.maxMakerPrice) : null,
      improveTicks: s.improveTicks,
      minProfitPerShare: fx(s.minProfitPerShare),
      hedgeSlippage: fx(s.hedgeSlippage),
      riskBufferPerShare: fx(s.riskBufferPerShare),
      fxBufferBps: s.fxBufferBps,
      maxHedgePrice: fx(this.pair.risk.maxHedgePrice),
    };
    const spend = pos.spend.A + pos.spend.B;
    const unhedged = abs(projected);
    let quote = computeQuote({ ...quoteArgs, capShares: fx(this.pair.risk.maxOrderShares) });
    if (quote.ok) {
      const capInfo = this.d.risk.capShares({
        pairId: this.pair.id,
        risk: this.pair.risk,
        makerVenue: mv,
        hedgeVenue: this.hedgeVenue,
        perShareMaker: quote.price,
        perShareHedge: quote.hedgeCostWithBuffers,
        pairSpend: spend,
        pairUnhedged: unhedged,
      });
      if (capInfo.cap < quote.size) {
        quote = computeQuote({ ...quoteArgs, capShares: capInfo.cap });
        if (!quote.ok) quote = { ok: false, reason: `${quote.reason}（受限于${capInfo.binding}）` };
        else quote.notes.push(`数量受限于${capInfo.binding}`);
      }
    }
    this.lastQuote = quote;

    if (!quote.ok) {
      for (const c of makers) if (c.order.status !== "CANCEL_REQUESTED") this.launchCancel(c.order, quote.reason);
      this.setMode("IDLE", quote.reason);
      return;
    }

    // 已有挂单：首版每个配对只保留一笔、且必须是配置的挂单方向；其余撤销
    if (makers.length > 0) {
      const own = makers.filter((c) => c.order.venue === mv && c.order.outcome === this.pair.makerOutcome && c.order.side === "BUY");
      for (const c of makers) {
        if (own[0] && c === own[0]) continue;
        if (c.order.status !== "CANCEL_REQUESTED") this.launchCancel(c.order, own.includes(c) ? "多余挂单" : "非当前配置的挂单方向");
      }
      const cur = own[0];
      if (!cur) return;
      const o = cur.order;
      if (["INTENT", "PREPARED", "SENDING", "UNKNOWN", "CANCEL_REQUESTED"].includes(o.status)) return;
      const remaining = o.size - max(o.reportedFilled, cur.ledgerFilled);
      const tick = makerMeta!.tickSize;
      const unprofitable = o.price > quote.makerPriceMax;
      const priceMoved = abs(quote.price - o.price) >= tick * BigInt(s.requoteMinTicks);
      const tooBig = remaining > quote.size + makerMeta!.shareStep;
      const tooSmall = remaining * 2n < quote.size;
      const ttl = o.expiresAt !== null && o.expiresAt - now < this.refreshBeforeMs();
      const intervalOk = now - this.lastRequoteAt >= s.requoteMinIntervalMs;
      let why: string | null = null;
      if (unprofitable) why = `对冲盘口恶化，挂价 ${toStr(o.price, 4)} 高于盈利上限 ${toStr(quote.makerPriceMax, 4)}`;
      else if (tooBig) why = `可挂数量下降到 ${toStr(quote.size, 2)}`;
      else if (ttl) why = "挂单即将到期，续挂";
      else if (intervalOk && priceMoved) why = `调整报价 ${toStr(o.price, 4)} → ${toStr(quote.price, 4)}`;
      else if (intervalOk && tooSmall) why = "剩余数量过少，补足";
      if (why) {
        this.lastRequoteAt = now;
        this.launchCancel(o, why);
      }
      this.setMode("QUOTING", `挂单 ${toStr(o.price, 4)} × ${toStr(remaining, 2)}`);
      return;
    }

    // 撤单流程未完成（有 CANCEL_REQUESTED 的挂单）时不下新单，避免同时两笔挂单
    if (now - this.lastRequoteAt < Math.min(s.requoteMinIntervalMs, 500) && this.lastRequoteAt > 0) return;
    this.lastRequoteAt = now;
    this.launchMaker(quote, makerInst, makerMeta!, now);
    this.setMode("QUOTING", `新挂单 ${toStr(quote.price, 4)} × ${toStr(quote.size, 2)}`);
  }

  /** 计算报价时从挂单平台订单簿中去掉自己的挂单，避免“跟自己比价”。 */
  private bookWithoutOwnOrders(book: Book, makers: OrderCtx[]): Book {
    if (makers.length === 0) return book;
    const bids = book.bids.map((l) => ({ ...l }));
    for (const m of makers) {
      if (m.order.side !== "BUY") continue;
      const lvl = bids.find((l) => l.price === m.order.price);
      if (lvl) {
        const rem = m.order.size - max(m.order.reportedFilled, m.ledgerFilled);
        lvl.size = lvl.size - rem > 0n ? lvl.size - rem : 0n;
      }
    }
    return { ...book, bids: bids.filter((l) => l.size > 0n) };
  }

  private refreshBeforeMs(): number {
    return this.pair.makerRefreshBeforeSec * 1000;
  }

  // ---------------------------------------------------------------------
  // 下单 / 撤单 / 查单（网络请求在队列外执行）
  // ---------------------------------------------------------------------

  private newOrderRow(p: {
    role: OrderRole;
    venue: VenueId;
    outcome: Outcome;
    tokenId: string;
    side: Side;
    kind: "LIMIT" | "TAKER";
    price: Fx;
    size: Fx;
    amountUsd: Fx | null;
    postOnly: boolean;
    expiresAt: number | null;
    meta: Record<string, unknown>;
  }): OrderRow {
    const now = this.d.clock.now();
    const row: OrderRow = {
      id: randomUUID(),
      pairId: this.pair.id,
      venue: p.venue,
      role: p.role,
      kind: p.kind,
      outcome: p.outcome,
      tokenId: p.tokenId,
      side: p.side,
      price: p.price,
      size: p.size,
      amountUsd: p.amountUsd,
      postOnly: p.postOnly,
      status: "INTENT",
      venueOrderId: null,
      hash: null,
      reportedFilled: 0n,
      plannedFill: null,
      expiresAt: p.expiresAt,
      createdAt: now,
      sentAt: null,
      ackAt: null,
      updatedAt: now,
      terminalAt: null,
      error: null,
      payload: null,
      meta: p.meta,
    };
    this.d.repo.insertOrder(row);
    return row;
  }

  private launchMaker(q: Extract<Quote, { ok: true }>, inst: Instrument, meta: VenueMarketMeta, now: number): void {
    const ttlSec = this.pair.makerOrderTtlSec;
    const expiresAt = ttlSec > 0 ? now + ttlSec * 1000 : null;
    const row = this.newOrderRow({
      role: "MAKER",
      venue: this.pair.makerVenue,
      outcome: this.pair.makerOutcome,
      tokenId: inst.tokenId,
      side: "BUY",
      kind: "LIMIT",
      price: q.price,
      size: q.size,
      amountUsd: null,
      postOnly: true,
      expiresAt,
      meta: { expectedHedgeCost: toStr(q.hedgeAvgEffPrice, 6), expectedProfitPerShare: toStr(q.expectedProfitPerShare, 6) },
    });
    const req: LimitOrderRequest = {
      clientOrderId: row.id,
      tokenId: inst.tokenId,
      side: "BUY",
      price: q.price,
      size: q.size,
      postOnly: true,
      expiresAt,
      meta,
    };
    this.log.info({ order: row.id, price: toStr(q.price, 4), size: toStr(q.size, 2), profit: toStr(q.expectedProfitPerShare, 4) }, "挂单");
    void this.execute(row, "LIMIT", req);
  }

  private launchTaker(c: Candidate, role: OrderRole): void {
    const meta = this.meta(c.venue)!;
    const row = this.newOrderRow({
      role,
      venue: c.venue,
      outcome: c.outcome,
      tokenId: c.tokenId,
      side: c.side,
      kind: "TAKER",
      price: c.limitPrice,
      size: c.shares,
      amountUsd: c.amountUsd,
      postOnly: false,
      expiresAt: null,
      meta: { pnlPerShare: toStr(c.pnlPerShare, 6), emergency: !!this.emergency },
    });
    const req: TakerOrderRequest = {
      clientOrderId: row.id,
      tokenId: c.tokenId,
      side: c.side,
      shares: c.shares,
      limitPrice: c.limitPrice,
      amountUsd: c.amountUsd,
      meta,
      bookLevels: c.levels.map((l) => ({ price: l.price, size: l.size })),
    };
    this.log.info(
      { order: row.id, role, venue: c.venue, side: c.side, outcome: c.outcome, shares: toStr(c.shares, 4), limit: toStr(c.limitPrice, 4) },
      role === "HEDGE" ? "补单" : "平仓",
    );
    void this.execute(row, "TAKER", req);
  }

  /** 签名 → 保存可查询标识 → 发送 → 处理回执；超时或网络错误标记为状态未知，稍后查单。 */
  private async execute(row: OrderRow, kind: "LIMIT" | "TAKER", req: LimitOrderRequest | TakerOrderRequest): Promise<void> {
    const venue = this.d.venues[row.venue];
    const timeoutMs = this.pair.strategy.hedge.requestTimeoutMs;
    let sent = false;
    try {
      const prepared = await withTimeout(kind === "LIMIT" ? venue.prepareLimit(req as LimitOrderRequest) : venue.prepareTaker(req as TakerOrderRequest), timeoutMs, "签名");
      this.d.repo.updateOrder(
        row.id,
        { status: "PREPARED", hash: prepared.hash, payload: prepared.payload, price: prepared.price, size: prepared.size, amountUsd: prepared.amountUsd, expiresAt: prepared.expiresAt },
        this.d.clock.now(),
      );
      this.d.repo.updateOrder(row.id, { status: "SENDING", sentAt: this.d.clock.now() }, this.d.clock.now());
      sent = true;
      const res = await withTimeout(venue.submit(prepared, kind, req), timeoutMs, "下单");
      this.applySubmit(row.id, res);
    } catch (e) {
      const now = this.d.clock.now();
      if (!sent) {
        this.d.repo.updateOrder(row.id, { status: "REJECTED", error: `签名失败：${errMsg(e)}` }, now);
        this.handleVenueError(row.venue, e);
      } else if (e instanceof TimeoutError || (e instanceof VenueError && e.errorClass === "NETWORK")) {
        this.d.repo.updateOrder(row.id, { status: "UNKNOWN", error: errMsg(e) }, now);
        this.d.alerts.raise("warn", "ORDER_UNKNOWN", `${row.venue} 下单状态未知（${errMsg(e)}），先查单再决定后续动作`, { pairId: this.pair.id });
      } else {
        this.d.repo.updateOrder(row.id, { status: "REJECTED", error: errMsg(e) }, now);
        this.handleVenueError(row.venue, e);
      }
    } finally {
      void this.schedule("order-done");
    }
  }

  private applySubmit(orderId: string, res: SubmitResult): void {
    const now = this.d.clock.now();
    const o = this.d.repo.getOrder(orderId);
    if (!o) return;
    if (!res.accepted) {
      this.d.repo.updateOrder(orderId, { status: "REJECTED", error: res.rejectReason ?? "拒单" }, now);
      this.log.warn({ order: orderId, reason: res.rejectReason, cls: res.errorClass }, "交易所拒单");
      if (res.errorClass) this.handleErrorClass(o.venue, res.errorClass, res.rejectReason ?? "", res.retryAfterMs);
      return;
    }
    const patch: Partial<OrderRow> = {
      venueOrderId: res.venueOrderId ?? o.venueOrderId,
      hash: o.hash ?? res.hash,
      ackAt: now,
    };
    if (res.hash && o.hash && res.hash.toLowerCase() !== o.hash.toLowerCase()) {
      patch.meta = { ...o.meta, hashMismatch: res.hash };
      this.log.warn({ order: orderId, local: o.hash, venue: res.hash }, "本地推导的订单标识与交易所不一致");
    }
    if (res.reportedFilledShares !== null) patch.reportedFilled = res.reportedFilledShares;
    if (o.kind === "TAKER") {
      if (res.status === "MATCHED") patch.status = "FILLED";
      else if (res.status === "UNMATCHED") patch.status = "CANCELLED";
      else patch.status = "ACCEPTED";
    } else {
      patch.status = res.status === "MATCHED" && res.reportedFilledShares !== null && res.reportedFilledShares >= o.size ? "FILLED" : "ACCEPTED";
    }
    this.d.repo.updateOrder(orderId, patch, now);
  }

  private launchCancel(o: OrderRow, why: string): void {
    if (["INTENT", "PREPARED", "SENDING"].includes(o.status)) return;
    const nowMs = this.d.clock.now();
    if (o.status === "CANCEL_REQUESTED" && nowMs - Number(o.meta.cancelAt ?? 0) < CANCEL_RETRY_MS) return;
    this.d.repo.updateOrder(o.id, { status: "CANCEL_REQUESTED", meta: { ...o.meta, cancelReason: why, cancelAt: nowMs } }, nowMs);
    this.log.info({ order: o.id, why }, "撤单");
    void (async () => {
      try {
        const r = await withTimeout(this.d.venues[o.venue].cancel([{ venueOrderId: o.venueOrderId, hash: o.hash }]), this.pair.strategy.hedge.requestTimeoutMs, "撤单");
        const id = o.venueOrderId ?? o.hash ?? "";
        if (r.cancelled.includes(id)) {
          this.d.repo.updateOrder(o.id, { status: "CANCELLED" }, this.d.clock.now());
        } else if (r.rejected.includes(id)) {
          const cur = this.d.repo.getOrder(o.id);
          if (cur && cur.status === "CANCEL_REQUESTED") this.d.repo.updateOrder(o.id, { status: "ACCEPTED" }, this.d.clock.now());
        } else {
          // noop：已经成交或已撤，查单确认终态
          await this.resolveOrder(o.id);
        }
      } catch (e) {
        this.log.warn({ order: o.id, err: errMsg(e) }, "撤单请求失败，稍后重试");
        this.handleVenueError(o.venue, e);
      } finally {
        void this.schedule("cancel-done");
      }
    })();
  }

  private resolveStuckOrders(ctx: OrderCtx[], now: number): void {
    for (const c of ctx) {
      const o = c.order;
      if (this.resolving.has(o.id)) continue;
      const stuckSending = o.status === "SENDING" && o.sentAt !== null && now - o.sentAt > SENDING_STUCK_MS;
      const unknown = o.status === "UNKNOWN";
      const cancelRetry = o.status === "CANCEL_REQUESTED" && now - Number(o.meta.cancelAt ?? 0) > CANCEL_RETRY_MS * 3;
      const pendingTaker = o.kind === "TAKER" && o.status === "ACCEPTED" && o.ackAt !== null && now - o.ackAt > 5_000;
      const missingFills =
        isTerminalOrder(o.status) &&
        o.kind === "TAKER" &&
        o.reportedFilled > c.ledgerFilled &&
        now - (o.terminalAt ?? o.updatedAt) > this.pair.strategy.hedge.fillGraceMs &&
        !o.meta.backfilled;
      if (stuckSending || unknown || pendingTaker) {
        void this.resolveOrder(o.id);
      } else if (cancelRetry) {
        this.launchCancel(o, String(o.meta.cancelReason ?? "重试撤单"));
      } else if (missingFills) {
        void this.backfillFills(o);
      }
    }
  }

  /** 查单确定订单真实状态。 */
  async resolveOrder(orderId: string): Promise<void> {
    if (this.resolving.has(orderId)) return;
    this.resolving.add(orderId);
    try {
      const o = this.d.repo.getOrder(orderId);
      if (!o) return;
      const st = await withTimeout(
        this.d.venues[o.venue].getOrder({ venueOrderId: o.venueOrderId, hash: o.hash, tokenId: o.tokenId }),
        this.pair.strategy.hedge.requestTimeoutMs,
        "查单",
      );
      await this.d.queue.run(this.pair.id, () => {
        const cur = this.d.repo.getOrder(orderId);
        if (!cur) return;
        if (st.status === "NOT_FOUND") {
          const age = this.d.clock.now() - (cur.sentAt ?? cur.createdAt);
          if (age > NOT_FOUND_GRACE_MS || cur.status === "INTENT" || cur.status === "PREPARED") {
            this.d.repo.updateOrder(orderId, { status: "NOT_FOUND", error: "查单未找到" }, this.d.clock.now());
            this.log.warn({ order: orderId }, "查单确认交易所无此订单");
          }
          return;
        }
        this.onOrderState(cur, st);
      });
      // 有成交的吃单，补拉成交，避免推送丢失
      if (st.filled > 0n) await this.backfillFills(o);
    } catch (e) {
      this.log.warn({ order: orderId, err: errMsg(e) }, "查单失败，稍后重试");
    } finally {
      this.resolving.delete(orderId);
      void this.schedule("resolved");
    }
  }

  /** 用 REST 补拉某订单相关的成交（推送丢失时）。 */
  async backfillFills(o: OrderRow): Promise<void> {
    try {
      const since = (o.sentAt ?? o.createdAt) - 60_000;
      const fills = await this.d.venues[o.venue].listFills(since, [o.tokenId]);
      await this.d.queue.run(this.pair.id, () => {
        for (const f of fills) {
          const matches =
            (f.venueOrderId && (f.venueOrderId === o.venueOrderId || f.venueOrderId === o.hash)) || (f.orderHash && (f.orderHash === o.hash || f.orderHash === o.venueOrderId));
          if (matches) this.onFill(o, f);
        }
        const cur = this.d.repo.getOrder(o.id);
        if (cur) this.d.repo.updateOrder(o.id, { meta: { ...cur.meta, backfilled: true } }, this.d.clock.now());
      });
    } catch (e) {
      this.log.warn({ order: o.id, err: errMsg(e) }, "补拉成交失败");
    }
  }

  // ---------------------------------------------------------------------
  // 平台错误处理
  // ---------------------------------------------------------------------

  private handleVenueError(v: VenueId, e: unknown): void {
    if (e instanceof VenueError) this.handleErrorClass(v, e.errorClass, e.message, e.retryAfterMs);
  }

  private handleErrorClass(v: VenueId, cls: string, msg: string, retryAfterMs: number | null): void {
    const now = this.d.clock.now();
    switch (cls) {
      case "INSUFFICIENT_BALANCE":
        this.d.risk.block(v, "balance", `余额不足：${msg}`, now + 60_000);
        this.d.alerts.raise("critical", "INSUFFICIENT_BALANCE", `${v} 余额不足，暂停依赖该平台的挂单：${msg}`, { pairId: this.pair.id });
        break;
      case "ALLOWANCE":
        this.d.risk.block(v, "allowance", `授权不足或失效：${msg}`);
        this.d.alerts.raise("critical", "ALLOWANCE", `${v} 授权失效，暂停依赖该平台的挂单：${msg}`, { pairId: this.pair.id });
        break;
      case "AUTH":
        this.d.risk.block(v, "auth", `认证失败：${msg}`, now + 30_000);
        this.d.alerts.raise("critical", "AUTH", `${v} 认证失败（将自动重新认证）：${msg}`, { pairId: this.pair.id });
        break;
      case "RATE_LIMIT":
        this.d.risk.block(v, "ratelimit", `限流：${msg}`, now + (retryAfterMs ?? 5_000));
        this.d.alerts.raise("warn", "RATE_LIMIT", `${v} 触发限流，暂停 ${Math.round((retryAfterMs ?? 5000) / 1000)}s`, { pairId: this.pair.id });
        break;
      case "RESTARTING":
        this.d.risk.block(v, "restarting", `撮合引擎重启：${msg}`, now + (retryAfterMs ?? 5_000));
        this.d.alerts.raise("warn", "ENGINE_RESTART", `${v} 撮合引擎重启中`, { pairId: this.pair.id });
        break;
      case "FORBIDDEN":
        this.d.risk.block(v, "forbidden", `地区或账户受限：${msg}`);
        this.d.alerts.raise("critical", "FORBIDDEN", `${v} 拒绝交易（地区或账户受限），已阻断该平台；请确认部署地区与账户资格：${msg}`, { pairId: this.pair.id });
        break;
      case "MARKET_CLOSED":
        this.d.alerts.raise("warn", "MARKET_CLOSED", `${v} 市场不接受订单：${msg}`, { pairId: this.pair.id });
        break;
      default:
        break;
    }
  }

  /** forTaker：吃单（补单/平仓）只要求认证、事件流与授权正常；挂单还要求余额正常。 */
  private venueUsable(v: VenueId, forTaker: boolean): boolean {
    const b = this.d.risk.venueBlocked(v);
    if (b) {
      if (forTaker && /余额不足/.test(b.reason)) return true; // 余额不足时仍允许尝试平仓卖出
      return false;
    }
    const h = this.d.venues[v].health();
    if (!h.authOk) return false;
    if (!forTaker && !h.userStreamUp) return false;
    return true;
  }

  private venueProblem(v: VenueId): string | null {
    const b = this.d.risk.venueBlocked(v);
    if (b) return b.reason;
    const h = this.d.venues[v].health();
    if (!h.authOk) return `认证无效 ${h.lastError ?? ""}`;
    if (!h.userStreamUp) return "订单事件流断开";
    return null;
  }

  // ---------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------

  private meta(v: VenueId): VenueMarketMeta | null {
    return this.d.books.getMeta(v, this.pair.marketKeys[v]);
  }

  private bookStale(b: Book): boolean {
    return this.d.clock.now() - b.receivedAt > this.pair.strategy.maxBookAgeMs;
  }

  /** 挂单状态（IDLE / QUOTING 等）与敞口状态（FLAT / HEDGING / RESIDUAL_WAIT / RESIDUAL / EMERGENCY）分开记录。 */
  private setMode(mode: string, reason: string | null): void {
    const exposureModes = ["HEDGING", "RESIDUAL_WAIT", "RESIDUAL", "EMERGENCY", "FLAT"];
    if (exposureModes.includes(mode)) {
      if (this.exposureMode !== mode) this.log.info({ from: this.exposureMode, to: mode, reason }, "敞口状态变化");
      this.exposureMode = mode;
      this.exposureReason = reason;
      return;
    }
    if (this.mode !== mode) this.log.info({ from: this.mode, to: mode, reason }, "挂单状态变化");
    this.mode = mode;
    this.modeReason = reason;
  }

  private updateCommitment(ctx: OrderCtx[], pos: Positions, projected: Fx): void {
    const c = emptyCommitment();
    const hedgeCost = this.lastQuote && this.lastQuote.ok ? this.lastQuote.hedgeCostWithBuffers : fx("0.6");
    for (const x of ctx) {
      const o = x.order;
      if (isTerminalOrder(o.status)) continue;
      const rem = o.size - max(o.reportedFilled, x.ledgerFilled);
      if (rem <= 0n) continue;
      if (o.role === "MAKER") {
        c.makerReserved[o.venue] += mul(rem, o.price, "ceil");
        c.hedgeReserved[otherVenue(o.venue)] += mul(rem, hedgeCost, "ceil");
      } else if (o.side === "BUY") {
        c.inflightReserved[o.venue] += o.amountUsd ?? mul(rem, o.price, "ceil");
      }
    }
    c.positionSpend = pos.spend.A + pos.spend.B;
    c.unhedged = abs(projected);
    this.d.risk.setCommitment(this.pair.id, c);
  }

  snapshot(): PairSnapshot {
    const now = this.d.clock.now();
    const fills = this.d.repo.listFills({ pairId: this.pair.id });
    const positions = computePositions(fills, this.pair.strategy.hedgeTrigger);
    const orders = this.d.repo.listOrders({ pairId: this.pair.id, limit: 50 });
    const ledgerByOrder = new Map<string, Fx>();
    for (const f of fills) if (f.orderId && f.status !== "FAILED") ledgerByOrder.set(f.orderId, (ledgerByOrder.get(f.orderId) ?? 0n) + f.grossShares);
    const ctx = this.d.repo.listOrders({ pairId: this.pair.id, limit: 400 }).map((o) => ({ order: o, ledgerFilled: ledgerByOrder.get(o.id) ?? 0n }));
    const net = netExposure(positions);
    const books: PairSnapshot["books"] = {};
    for (const v of ["predict", "polymarket"] as VenueId[]) {
      for (const o of ["A", "B"] as Outcome[]) {
        const inst = this.pair.instruments[v][o];
        const b = this.d.books.getBook(v, inst.tokenId);
        books[`${v}:${o}`] = b ? { bids: b.bids.slice(0, 5), asks: b.asks.slice(0, 5), ageMs: now - b.receivedAt } : null;
      }
    }
    return {
      id: this.pair.id,
      labels: this.pair.labels,
      makerVenue: this.pair.makerVenue,
      makerOutcome: this.pair.makerOutcome,
      mode: this.mode,
      reason: this.modeReason,
      exposureMode: this.exposureMode,
      exposureReason: this.exposureReason,
      emergency: this.emergency,
      startTime: this.pair.startTime,
      stopQuotingAt: this.stopQuotingAt(),
      positions,
      netExposure: net,
      projectedNet: net + this.inflightDelta(ctx, now),
      nakedSince: this.nakedSince,
      pnl: pnlSummary(positions),
      lastQuote: this.lastQuote,
      orders,
      fills: fills.slice(-50),
      episodes: this.d.repo.listEpisodes(this.pair.id, 20),
      books,
    };
  }

  get currentMode(): { mode: string; reason: string | null; exposureMode: string; exposureReason: string | null } {
    return { mode: this.mode, reason: this.modeReason, exposureMode: this.exposureMode, exposureReason: this.exposureReason };
  }

  get inEmergency(): boolean {
    return this.emergency !== null;
  }

  /** 最近一次报价结果（资金页用来显示挂单数量受什么限制）。 */
  get latestQuote(): Quote | null {
    return this.lastQuote;
  }
}

interface Candidate {
  ok: boolean;
  reason: string;
  venue: VenueId;
  outcome: Outcome;
  side: Side;
  tokenId: string;
  shares: Fx;
  limitPrice: Fx;
  amountUsd: Fx | null;
  levels: { price: Fx; size: Fx }[];
  /** 每份对整对盈亏的影响（正为盈利） */
  pnlPerShare: Fx;
  belowMin: boolean;
}

function fail(base: { venue: VenueId; outcome: Outcome; side: Side; tokenId: string }, reason: string): Candidate {
  return { ...base, ok: false, reason: `${base.venue} ${base.side} ${base.outcome}：${reason}`, shares: 0n, limitPrice: 0n, amountUsd: null, levels: [], pnlPerShare: -ONE, belowMin: false };
}

/** 交易所订单状态映射到本地状态。 */
function mapVenueStatus(o: OrderRow, st: VenueOrderState, _now: number): OrderStatus | null {
  switch (st.status) {
    case "OPEN":
      if (o.status === "CANCEL_REQUESTED") return null;
      return st.filled > 0n ? "PARTIAL" : "ACCEPTED";
    case "DELAYED":
      return "ACCEPTED";
    case "FILLED":
      return "FILLED";
    case "CANCELLED":
    case "INVALIDATED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    case "NOT_FOUND":
      return null;
    default:
      return null;
  }
}

export { effectiveBuyPrice, effectiveSellPrice };

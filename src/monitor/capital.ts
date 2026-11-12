import type { AppContext } from "../app.js";
import { fx, toNum, type Fx } from "../core/fixed.js";
import { bjTime, fmtDuration } from "../core/time.js";
import { isTerminalOrder, VENUES, type VenueId } from "../core/types.js";
import { effectiveRisk } from "../config/schema.js";
import { computePositions, pnlSummary } from "../engine/ledger.js";
import { emptyCommitment } from "../engine/risk.js";
import type { Quote } from "../pricing/quote.js";
import type { PairDefinition } from "../pairing/verify.js";
import { matchHours } from "./opportunity.js";

/**
 * 资金利用率。
 *
 * 每个平台的资金 = 现金余额 + 进行中比赛的持仓（按成本）。其中：
 * - 挂单占用：挂单剩余数量 × 挂价（挂着的买单，成交后变成持仓）；
 * - 补单预留：为“挂单全部成交”预留在对冲平台的补单资金（`reserveHedgeFunds`），没有真正冻结但机器人不会动用；
 * - 在途：正在执行的补单 / 平仓吃单；
 * - 持仓：已成交的两腿，比赛结算并赎回前一直占用资金；
 * - 闲置 = 余额 − 挂单占用 − 补单预留 − 在途。
 * 资金利用率 = (挂单占用 + 在途 + 持仓) ÷ (余额 + 持仓)；另给出含补单预留的占用率。
 * 比赛预计已结束（开赛 + 比赛时长 + 2 小时）的持仓单列：机器人不跟踪赎回，赎回后资金回到余额；
 * 结束超过 3 天的视为历史，不再计入。
 * USDT（Predict）与 pUSD（Polymarket）按 1:1 合计。
 */

const n = (x: Fx) => Number(toNum(x).toFixed(4));
/** 比赛结束后多久内的持仓还算“可能待赎回” */
const FINISHED_KEEP_MS = 3 * 24 * 3600_000;
const pct = (a: number, b: number) => (b > 0 ? a / b : null);

export interface VenueCapital {
  venue: VenueId;
  balance: number | null;
  balanceAt: string | null;
  makerReserved: number;
  hedgeReserved: number;
  inflight: number;
  idle: number | null;
  positionsOpen: number;
  positionsFinished: number;
  utilization: number | null;
  utilizationInclReserve: number | null;
}

export interface PairCapital {
  id: string;
  active: boolean;
  labels: Record<string, string> | null;
  startTime: string | null;
  phase: "未开赛" | "进行中（估计）" | "已结束（估计）" | "未知";
  makerVenue: VenueId | null;
  makerReserved: number;
  hedgeReserved: number;
  inflight: number;
  positions: Record<VenueId, number>;
  hedgedShares: number;
  lockedPnl: number;
  hedgedCost: number;
  returnPct: number | null;
  matchCommitted: number;
  matchLimit: number | null;
  matchUsage: number | null;
  quotedHours: number;
  makerFilledShares: number;
  filledPerHour: number | null;
  pnlPerHour: number | null;
  sizeLimit: string | null;
}

export interface CapitalReport {
  at: string;
  venues: VenueCapital[];
  total: { balance: number | null; working: number; reserved: number; positionsOpen: number; positionsFinished: number; utilization: number | null; utilizationInclReserve: number | null };
  limits: { globalCommitted: number; maxGlobalUsd: number; globalUsage: number | null; globalUnhedged: number; maxUnhedgedSharesGlobal: number; lossToday: number; maxDailyLossUsd: number };
  bindings: { reason: string; pairs: string[] }[];
  hints: string[];
  pairs: PairCapital[];
}

/** 从最近一次报价里取出“数量受什么限制”。 */
function sizeLimitOf(q: Quote | null): string | null {
  if (!q) return null;
  const texts = q.ok ? q.notes : [q.reason];
  for (const t of texts) {
    const m = /受限于([^（）()]+(?:（[^）]*）)?)/.exec(t);
    if (m) return m[1]!.trim();
    if (t.includes("对冲深度不足")) return "对冲盘深度";
  }
  return null;
}

export function computeCapital(ctx: AppContext): CapitalReport {
  const now = ctx.clock.now();
  const commitments = new Map(ctx.risk.listCommitments());
  const ids = new Set<string>([...ctx.pairConfigs.keys(), ...(ctx.db.raw.prepare("SELECT DISTINCT pair_id AS id FROM fills").all() as { id: string }[]).map((r) => r.id)]);
  const venue: Record<VenueId, { maker: Fx; hedge: Fx; inflight: Fx; open: Fx; finished: Fx }> = {
    polymarket: { maker: 0n, hedge: 0n, inflight: 0n, open: 0n, finished: 0n },
    predict: { maker: 0n, hedge: 0n, inflight: 0n, open: 0n, finished: 0n },
  };
  const pairs: PairCapital[] = [];
  const bindings = new Map<string, string[]>();

  for (const id of ids) {
    const active = ctx.pairConfigs.has(id);
    const engine = ctx.engines.get(id);
    const def = (ctx.stored.get(id)?.def ?? ctx.pairing.get(id)?.def ?? null) as PairDefinition | null;
    const c = commitments.get(id) ?? emptyCommitment();
    const fills = ctx.repo.listFills({ pairId: id });
    const live = fills.filter((f) => f.status !== "FAILED");
    if (!active && live.length === 0) continue;
    const posCost: Record<VenueId, Fx> = { polymarket: 0n, predict: 0n };
    for (const f of live) posCost[f.venue] -= f.cashFlow;
    const pnl = pnlSummary(computePositions(fills, "matched"));
    const start = def?.startTime ?? null;
    const endEst = start !== null ? start + (matchHours(def?.bestOf ?? null) + 2) * 3600_000 : null;
    const phase: PairCapital["phase"] = start === null ? "未知" : now < start ? "未开赛" : endEst !== null && now < endEst ? "进行中（估计）" : "已结束（估计）";
    const finished = phase === "已结束（估计）";
    // 机器人不跟踪赎回：结束超过 3 天的比赛视为历史（默认已赎回），不再计入资金，已删除的也不再列出
    if (finished && endEst !== null && now - endEst > FINISHED_KEEP_MS && !active) continue;
    const countFinished = finished && endEst !== null && now - endEst <= FINISHED_KEEP_MS;
    for (const v of VENUES) {
      venue[v].maker += c.makerReserved[v];
      venue[v].hedge += c.hedgeReserved[v];
      venue[v].inflight += c.inflightReserved[v];
      if (countFinished) venue[v].finished += posCost[v] > 0n ? posCost[v] : 0n;
      else if (!finished) venue[v].open += posCost[v] > 0n ? posCost[v] : 0n;
    }
    // 挂单时长：每笔被交易所受理的挂单从受理到结束（或现在）的时长之和（同一配对同时只有一笔挂单）
    let quotedMs = 0;
    for (const o of ctx.repo.listOrders({ pairId: id })) {
      if (o.role !== "MAKER") continue;
      const from = o.ackAt ?? (o.venueOrderId ? (o.sentAt ?? o.createdAt) : null);
      if (from === null) continue;
      const to = o.terminalAt ?? (isTerminalOrder(o.status) ? o.updatedAt : now);
      if (to > from) quotedMs += to - from;
    }
    const quotedHours = quotedMs / 3600_000;
    const makerFilled = live.filter((f) => f.role === "MAKER").reduce((a, f) => a + toNum(f.netShares), 0);
    const hedgedCost = pnl.hedged - pnl.lockedPnl;
    const pc = ctx.pairConfigs.get(id);
    const matchLimit = pc ? effectiveRisk(ctx.cfg.app, pc).maxMatchUsd : null;
    const committed = (c.positionSpend > 0n ? c.positionSpend : 0n) + c.makerReserved.polymarket + c.makerReserved.predict + c.hedgeReserved.polymarket + c.hedgeReserved.predict + c.inflightReserved.polymarket + c.inflightReserved.predict;
    const limit = engine ? sizeLimitOf(engine.latestQuote) : null;
    if (limit && engine?.pair.tradeable) bindings.set(limit, [...(bindings.get(limit) ?? []), id]);
    pairs.push({
      id,
      active,
      labels: def?.labels ?? null,
      startTime: start !== null ? bjTime(start) : null,
      phase,
      makerVenue: engine?.pair.makerVenue ?? pc?.maker.venue ?? null,
      makerReserved: n(c.makerReserved.polymarket + c.makerReserved.predict),
      hedgeReserved: n(c.hedgeReserved.polymarket + c.hedgeReserved.predict),
      inflight: n(c.inflightReserved.polymarket + c.inflightReserved.predict),
      positions: { polymarket: n(posCost.polymarket), predict: n(posCost.predict) },
      hedgedShares: n(pnl.hedged),
      lockedPnl: n(pnl.lockedPnl),
      hedgedCost: n(hedgedCost),
      returnPct: hedgedCost > 0n ? toNum(pnl.lockedPnl) / toNum(hedgedCost) : null,
      matchCommitted: n(committed),
      matchLimit,
      matchUsage: matchLimit ? toNum(committed) / matchLimit : null,
      quotedHours: Number(quotedHours.toFixed(2)),
      makerFilledShares: Number(makerFilled.toFixed(4)),
      filledPerHour: quotedHours >= 0.05 ? Number((makerFilled / quotedHours).toFixed(2)) : null,
      pnlPerHour: quotedHours >= 0.05 ? Number((toNum(pnl.lockedPnl) / quotedHours).toFixed(4)) : null,
      sizeLimit: limit,
    });
  }

  const venues: VenueCapital[] = VENUES.map((v) => {
    const b = ctx.risk.getBalances(v);
    const x = venue[v];
    const working = x.maker + x.inflight + x.open;
    const base = b ? b.collateral + x.open : null;
    return {
      venue: v,
      balance: b ? n(b.collateral) : null,
      balanceAt: b ? bjTime(b.updatedAt) : null,
      makerReserved: n(x.maker),
      hedgeReserved: n(x.hedge),
      inflight: n(x.inflight),
      idle: b ? n(b.collateral - x.maker - x.hedge - x.inflight) : null,
      positionsOpen: n(x.open),
      positionsFinished: n(x.finished),
      utilization: base !== null ? pct(toNum(working), toNum(base)) : null,
      utilizationInclReserve: base !== null ? pct(toNum(working + x.hedge), toNum(base)) : null,
    };
  });
  const haveAll = venues.every((v) => v.balance !== null);
  const totBalance = haveAll ? venues.reduce((a, v) => a + (v.balance ?? 0), 0) : null;
  const totWorking = venues.reduce((a, v) => a + v.makerReserved + v.inflight + v.positionsOpen, 0);
  const totReserved = venues.reduce((a, v) => a + v.hedgeReserved, 0);
  const totOpen = venues.reduce((a, v) => a + v.positionsOpen, 0);
  const totFinished = venues.reduce((a, v) => a + v.positionsFinished, 0);

  const r = ctx.risk.global;
  const globalCommitted = toNum(ctx.risk.globalCommitted(null));
  const hints: string[] = [];
  for (const v of venues) {
    const other = venues.find((x) => x.venue !== v.venue)!;
    if (v.balance && other.balance && v.idle !== null && other.idle !== null && v.idle < v.balance * 0.1 && other.idle > other.balance * 0.5) {
      hints.push(`${v.venue} 闲置资金不足（${v.idle.toFixed(2)}），${other.venue} 闲置 ${other.idle.toFixed(2)}：两腿资金不平衡，考虑从 ${other.venue} 调一部分到 ${v.venue}（注意两边币种与链不同，出入金有成本）`);
    }
    if (v.idle !== null && v.idle < 0) hints.push(`${v.venue} 的挂单占用与补单预留超过余额 ${(-v.idle).toFixed(2)}：余额刚下降或有外部支出，机器人会按可用余额缩小挂单`);
  }
  for (const [reason, ps] of bindings) {
    if (/余额/.test(reason)) hints.push(`${ps.length} 个配对的挂单数量受限于“${reason}”：资金是瓶颈，增加对应平台的资金可以挂更多`);
    else if (/资金上限|额度/.test(reason)) hints.push(`${ps.length} 个配对的挂单数量受限于“${reason}”：风控额度是瓶颈，需要时在控制台调高额度`);
  }
  if (totFinished > 0) hints.push(`最近 3 天内结束的比赛还有持仓（按成本约 ${totFinished.toFixed(2)}）：机器人不自动赎回，请在两边平台确认已赎回，赎回后资金回到余额`);

  return {
    at: bjTime(now),
    venues,
    total: {
      balance: totBalance,
      working: Number(totWorking.toFixed(4)),
      reserved: Number(totReserved.toFixed(4)),
      positionsOpen: Number(totOpen.toFixed(4)),
      positionsFinished: Number(totFinished.toFixed(4)),
      utilization: totBalance !== null ? pct(totWorking, totBalance + totOpen) : null,
      utilizationInclReserve: totBalance !== null ? pct(totWorking + totReserved, totBalance + totOpen) : null,
    },
    limits: {
      globalCommitted: Number(globalCommitted.toFixed(4)),
      maxGlobalUsd: r.maxGlobalUsd,
      globalUsage: pct(globalCommitted, r.maxGlobalUsd),
      globalUnhedged: Number(toNum(ctx.risk.globalUnhedged(null)).toFixed(4)),
      maxUnhedgedSharesGlobal: r.maxUnhedgedSharesGlobal,
      lossToday: Number(toNum(ctx.risk.lossTodayUsd()).toFixed(4)),
      maxDailyLossUsd: r.maxDailyLossUsd,
    },
    bindings: [...bindings].map(([reason, ps]) => ({ reason, pairs: ps })),
    hints,
    pairs: pairs.sort((a, b) => Number(b.active) - Number(a.active) || b.matchCommitted - a.matchCommitted),
  };
}

export const fmtHours = (h: number | null): string => (h === null ? "-" : fmtDuration(h * 3600_000));
export const ZERO = fx(0);

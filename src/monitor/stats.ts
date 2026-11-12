import { toNum } from "../core/fixed.js";
import { isTerminalOrder, otherOutcome } from "../core/types.js";
import type { FillRow, OrderRow, Repo } from "../db/repo.js";

/**
 * 补单统计（用于比较部署地区）：
 * - 总耗时（交易所口径）：第一腿实际成交时间 → 抵消它的第二腿实际成交时间（按先进先出把补单份额分配给每笔第一腿成交，取完成那一笔的时间）；
 *   耗时分布只统计由补单对齐的样本，平仓/混合处理的样本单独计数；
 * - 总耗时（本机口径）：本机收到第一腿成交 → 本机收到完成对冲的第二腿成交；两者都在本机时钟上，精度为毫秒；
 * - 分段：成交通知（交易所成交 → 本机收到）、决策（本机收到 → 补单发出）、执行（补单发出 → 第二腿交易所成交）；
 * - 补单失败率：补单（HEDGE）订单最终 0 成交的比例；需紧急处理比例：裸仓事件中以紧急处理结束的比例；
 * - 滑点：第二腿实际每份成本（含费）− 挂单时预期的对冲每份成本（含费），正数表示比预期差。
 * 注意：Polymarket 的成交时间若只有秒级（match_time），交易所口径会有最多 1 秒误差；本机口径不受影响。
 */
export interface Dist {
  n: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface HedgeStats {
  pairId: string;
  firstLegFills: number;
  firstLegShares: number;
  hedgedShares: number;
  unwoundShares: number;
  openShares: number;
  totalExchangeMs: Dist;
  totalLocalMs: Dist;
  notifyMs: Dist;
  decideMs: Dist;
  executeMs: Dist;
  slippagePerShare: Dist;
  hedgeOrders: number;
  hedgeOrdersNoFill: number;
  hedgeOrdersPartial: number;
  hedgeFailureRate: number | null;
  episodes: number;
  emergencyEpisodes: number;
  emergencyRate: number | null;
  samples: Sample[];
}

export interface Sample {
  makerFill: string;
  makerVenue: string;
  shares: number;
  firstLegAt: number;
  firstLegReceivedAt: number;
  hedgeSentAt: number | null;
  secondLegAt: number | null;
  secondLegReceivedAt: number | null;
  resolvedBy: "HEDGE" | "UNWIND" | "MIXED" | "OPEN";
  slippage: number | null;
}

export function dist(xs: number[]): Dist {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, mean: null, p50: null, p95: null, max: null };
  const rank = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!;
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, p50: rank(0.5), p95: rank(0.95), max: v[v.length - 1]! };
}

interface Piece {
  fill: FillRow;
  left: number;
  kind: "HEDGE" | "UNWIND";
}

export function computeHedgeStats(repo: Repo, pairId: string, sinceMs = 0): HedgeStats {
  const fills = repo.listFills({ pairId }).filter((f) => f.status !== "FAILED");
  const orders = new Map<string, OrderRow>(repo.listOrders({ pairId }).map((o) => [o.id, o]));
  const makers = fills.filter((f) => f.role === "MAKER" && f.side === "BUY" && f.matchedAt >= sinceMs).sort((a, b) => a.receivedAt - b.receivedAt || a.matchedAt - b.matchedAt);
  const samples: Sample[] = [];
  // 每个挂单方向一条先进先出队列：抵消“买 X”的是“买对手（补单）”或“卖 X（平仓）”
  const queues = new Map<string, Piece[]>();
  const queueFor = (outcome: string): Piece[] => {
    const key = outcome;
    if (!queues.has(key)) {
      const opp = otherOutcome(outcome as "A" | "B");
      const pieces = fills
        .filter((f) => (f.role === "HEDGE" && f.side === "BUY" && f.outcome === opp) || (f.role === "UNWIND" && f.side === "SELL" && f.outcome === outcome))
        .sort((a, b) => a.receivedAt - b.receivedAt || a.matchedAt - b.matchedAt)
        .map((f) => ({ fill: f, left: toNum(f.netShares), kind: f.role === "UNWIND" ? ("UNWIND" as const) : ("HEDGE" as const) }));
      queues.set(key, pieces);
    }
    return queues.get(key)!;
  };
  for (const m of makers) {
    const q = queueFor(m.outcome);
    let need = toNum(m.netShares);
    const shares = need;
    let firstSent: number | null = null;
    let last: FillRow | null = null;
    const kinds = new Set<string>();
    let costSum = 0;
    let costShares = 0;
    while (need > 1e-9 && q.length) {
      const p = q[0]!;
      const take = Math.min(need, p.left);
      if (p.kind === "HEDGE") {
        const unit = toNum(-p.fill.cashFlow) / Math.max(1e-12, toNum(p.fill.netShares));
        costSum += unit * take;
        costShares += take;
      }
      kinds.add(p.kind);
      const o = p.fill.orderId ? orders.get(p.fill.orderId) : undefined;
      if (o?.sentAt && firstSent === null) firstSent = o.sentAt;
      last = p.fill;
      p.left -= take;
      need -= take;
      if (p.left <= 1e-9) q.shift();
    }
    const makerOrder = m.orderId ? orders.get(m.orderId) : undefined;
    const expected = makerOrder?.meta?.expectedHedgeCost !== undefined ? Number(makerOrder.meta.expectedHedgeCost) : null;
    samples.push({
      makerFill: m.key,
      makerVenue: m.venue,
      shares,
      firstLegAt: m.matchedAt,
      firstLegReceivedAt: m.receivedAt,
      hedgeSentAt: firstSent,
      secondLegAt: need > 1e-9 ? null : (last?.matchedAt ?? null),
      secondLegReceivedAt: need > 1e-9 ? null : (last?.receivedAt ?? null),
      resolvedBy: need > 1e-9 ? "OPEN" : kinds.size > 1 ? "MIXED" : kinds.has("UNWIND") ? "UNWIND" : "HEDGE",
      slippage: costShares > 0 && expected !== null && Number.isFinite(expected) ? costSum / costShares - expected : null,
    });
  }
  // 耗时分布只统计“由补单对齐”的样本；残余等待后平仓、或混合处理的样本单独计数，不混入补单链路的 P95
  const done = samples.filter((s) => s.secondLegAt !== null && s.resolvedBy === "HEDGE");
  const hedgeOrders = [...orders.values()].filter((o) => o.role === "HEDGE" && isTerminalOrder(o.status) && o.createdAt >= sinceMs);
  const filledBy = new Map<string, number>();
  for (const f of fills) if (f.orderId) filledBy.set(f.orderId, (filledBy.get(f.orderId) ?? 0) + toNum(f.grossShares));
  const noFill = hedgeOrders.filter((o) => Math.max(toNum(o.reportedFilled), filledBy.get(o.id) ?? 0) <= 1e-9).length;
  const partial = hedgeOrders.filter((o) => {
    const filled = Math.max(toNum(o.reportedFilled), filledBy.get(o.id) ?? 0);
    return filled > 1e-9 && filled + 1e-9 < toNum(o.size);
  }).length;
  const eps = repo.listEpisodes(pairId, 10_000).filter((e) => e.startedAt >= sinceMs && e.resolvedAt !== null);
  const emergency = eps.filter((e) => e.resolution === "emergency").length;
  const sum = (f: (s: Sample) => number) => samples.reduce((a, s) => a + f(s), 0);
  return {
    pairId,
    firstLegFills: samples.length,
    firstLegShares: sum((s) => s.shares),
    hedgedShares: sum((s) => (s.resolvedBy === "HEDGE" ? s.shares : 0)),
    unwoundShares: sum((s) => (s.resolvedBy === "UNWIND" || s.resolvedBy === "MIXED" ? s.shares : 0)),
    openShares: sum((s) => (s.resolvedBy === "OPEN" ? s.shares : 0)),
    totalExchangeMs: dist(done.map((s) => Math.max(0, s.secondLegAt! - s.firstLegAt))),
    totalLocalMs: dist(done.map((s) => Math.max(0, s.secondLegReceivedAt! - s.firstLegReceivedAt))),
    notifyMs: dist(samples.map((s) => s.firstLegReceivedAt - s.firstLegAt)),
    decideMs: dist(done.filter((s) => s.hedgeSentAt !== null).map((s) => Math.max(0, s.hedgeSentAt! - s.firstLegReceivedAt))),
    executeMs: dist(done.filter((s) => s.hedgeSentAt !== null).map((s) => Math.max(0, s.secondLegAt! - s.hedgeSentAt!))),
    slippagePerShare: dist(samples.map((s) => s.slippage ?? Number.NaN)),
    hedgeOrders: hedgeOrders.length,
    hedgeOrdersNoFill: noFill,
    hedgeOrdersPartial: partial,
    hedgeFailureRate: hedgeOrders.length ? noFill / hedgeOrders.length : null,
    episodes: eps.length,
    emergencyEpisodes: emergency,
    emergencyRate: eps.length ? emergency / eps.length : null,
    samples,
  };
}

const ms = (x: number | null) => (x === null ? "-" : x >= 1000 ? `${(x / 1000).toFixed(2)}s` : `${Math.round(x)}ms`);
const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(1)}%`);

export function formatDist(d: Dist, kind: "ms" | "price"): string {
  if (d.n === 0) return "无样本";
  const f = kind === "ms" ? ms : (x: number | null) => (x === null ? "-" : x.toFixed(4));
  return `n=${d.n} 均值 ${f(d.mean)} P50 ${f(d.p50)} P95 ${f(d.p95)} 最大 ${f(d.max)}`;
}

/** 状态页/CLI 用的中文摘要。 */
export function statsSummary(s: HedgeStats): Record<string, unknown> {
  return {
    第一腿成交笔数: s.firstLegFills,
    第一腿份额: Number(s.firstLegShares.toFixed(4)),
    已由补单对齐: Number(s.hedgedShares.toFixed(4)),
    经平仓或混合处理: Number(s.unwoundShares.toFixed(4)),
    未对齐: Number(s.openShares.toFixed(4)),
    总耗时_交易所口径: formatDist(s.totalExchangeMs, "ms"),
    总耗时_本机口径: formatDist(s.totalLocalMs, "ms"),
    分段_成交通知: formatDist(s.notifyMs, "ms"),
    分段_决策: formatDist(s.decideMs, "ms"),
    分段_补单执行: formatDist(s.executeMs, "ms"),
    滑点_每份: formatDist(s.slippagePerShare, "price"),
    补单订单数: s.hedgeOrders,
    补单零成交: s.hedgeOrdersNoFill,
    补单部分成交: s.hedgeOrdersPartial,
    补单失败率: pct(s.hedgeFailureRate),
    裸仓事件数: s.episodes,
    需紧急处理比例: pct(s.emergencyRate),
  };
}

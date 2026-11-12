import { fx, ONE, toNum, type Fx } from "../core/fixed.js";
import type { Book, Outcome, VenueId, VenueMarketMeta } from "../core/types.js";
import type { RiskConfig, StrategyConfig } from "../config/schema.js";
import { computeQuote } from "../pricing/quote.js";

/**
 * 机会评估：按当前两边订单簿，对一场比赛的四个挂单方向（Predict / Polymarket × 两支队）各算一次报价，
 * 看能挂什么价、能挂多少、每份赚多少、能不能排到买一、每天的资金收益率是多少。
 *
 * 和引擎挂单用的是同一个报价函数（逐档对冲成本、手续费、缓冲、最小单、post-only），价格模式固定按 auto
 * （买一加 improveTicks，不超过盈利上限）评估，便于横向比较；资金上限不参与（这里只看市场本身）。
 *
 * 资金锁定时间（估算）= 距开赛 + 比赛时长（BO1 约 1 小时、BO3 约 3 小时、BO5 约 5 小时，未知按 3 小时）+ 结算 2 小时；
 * 按“现在成交”计算，所以是偏长（保守）的估计。每天收益率 = 每对收益率 ÷ 锁定天数。
 */

export interface MarketSide {
  meta: VenueMarketMeta | null;
  books: Record<Outcome, Book | null>;
}

export interface OpportunityInput {
  labels: Record<Outcome, string>;
  startTime: number | null;
  bestOf: number | null;
  predict: MarketSide;
  polymarket: MarketSide;
  strategy: StrategyConfig;
  risk: RiskConfig;
  /** 自己在簿上的挂单：评估竞争时从订单簿里扣掉，避免“跟自己比” */
  ownBids?: { venue: VenueId; outcome: Outcome; price: Fx; size: Fx }[];
  now: number;
}

export type QueuePosition = "ahead" | "join" | "behind" | "empty";

export interface DirectionEval {
  makerVenue: VenueId;
  makerOutcome: Outcome;
  makerTeam: string;
  hedgeTeam: string;
  ok: boolean;
  reason: string | null;
  /** 建议挂价、盈利上限价、挂单平台当前买一/卖一（已扣除自己的挂单） */
  price: number | null;
  makerPriceMax: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  /** 相对当前买一：ahead 领先、join 同价排队、behind 排在后面（成交可能性低）、empty 簿上没有买单 */
  queue: QueuePosition | null;
  /** 盈利上限价比当前买一高几个 tick（负数：别人出价已高于我们的盈利上限） */
  edgeTicks: number | null;
  /** 可挂份额（受目标份额、单笔上限与对冲深度限制） */
  size: number | null;
  hedgeAvgEffPrice: number | null;
  profitPerShare: number | null;
  profitTotal: number | null;
  /** 每对（1 份挂单 + 1 份对冲）占用资金 */
  capitalPerShare: number | null;
  returnPct: number | null;
  returnPerDay: number | null;
}

export interface OpportunityEval {
  hoursToStart: number | null;
  hoursToStop: number | null;
  lockHours: number | null;
  directions: DirectionEval[];
  best: DirectionEval | null;
}

const SETTLE_HOURS = 2;

export function matchHours(bestOf: number | null): number {
  if (!bestOf) return 3;
  if (bestOf <= 1) return 1;
  if (bestOf <= 3) return 3;
  return 5;
}

/** 停止挂单时间：开赛前 stopQuotingBeforeStartSec 与绝对时间 stopQuotingAt 取较早者。 */
export function stopTimeOf(strategy: StrategyConfig, startTime: number | null): number | null {
  const ts: number[] = [];
  if (startTime !== null) ts.push(startTime - strategy.stopQuotingBeforeStartSec * 1000);
  if (strategy.stopQuotingAt) {
    const t = Date.parse(strategy.stopQuotingAt);
    if (Number.isFinite(t)) ts.push(t);
  }
  return ts.length ? Math.min(...ts) : null;
}

function withoutOwn(book: Book, own: { price: Fx; size: Fx }[]): Book {
  if (own.length === 0) return book;
  const bids = book.bids.map((l) => ({ ...l }));
  for (const o of own) {
    const lvl = bids.find((l) => l.price === o.price);
    if (lvl) lvl.size = lvl.size > o.size ? lvl.size - o.size : 0n;
  }
  return { ...book, bids: bids.filter((l) => l.size > 0n) };
}

const otherOutcome = (o: Outcome): Outcome => (o === "A" ? "B" : "A");
const otherVenue = (v: VenueId): VenueId => (v === "predict" ? "polymarket" : "predict");
const num = (x: Fx | null | undefined): number | null => (x === null || x === undefined ? null : toNum(x));

export function evaluateOpportunity(inp: OpportunityInput): OpportunityEval {
  const s = inp.strategy;
  const hoursToStart = inp.startTime !== null ? (inp.startTime - inp.now) / 3600_000 : null;
  const stopAt = stopTimeOf(s, inp.startTime);
  const hoursToStop = stopAt !== null ? (stopAt - inp.now) / 3600_000 : null;
  const lockHours = hoursToStart !== null ? Math.max(0, hoursToStart) + matchHours(inp.bestOf) + SETTLE_HOURS : null;
  const sides: Record<VenueId, MarketSide> = { predict: inp.predict, polymarket: inp.polymarket };
  const directions: DirectionEval[] = [];
  for (const mv of ["predict", "polymarket"] as VenueId[]) {
    for (const o of ["A", "B"] as Outcome[]) {
      const hv = otherVenue(mv);
      const base: DirectionEval = {
        makerVenue: mv,
        makerOutcome: o,
        makerTeam: inp.labels[o],
        hedgeTeam: inp.labels[otherOutcome(o)],
        ok: false,
        reason: null,
        price: null,
        makerPriceMax: null,
        bestBid: null,
        bestAsk: null,
        queue: null,
        edgeTicks: null,
        size: null,
        hedgeAvgEffPrice: null,
        profitPerShare: null,
        profitTotal: null,
        capitalPerShare: null,
        returnPct: null,
        returnPerDay: null,
      };
      const makerMeta = sides[mv].meta;
      const hedgeMeta = sides[hv].meta;
      const rawMakerBook = sides[mv].books[o];
      const hedgeBook = sides[hv].books[otherOutcome(o)];
      if (!makerMeta || !hedgeMeta || !rawMakerBook || !hedgeBook) {
        directions.push({ ...base, reason: "缺少市场数据或订单簿" });
        continue;
      }
      const own = (inp.ownBids ?? []).filter((b) => b.venue === mv && b.outcome === o);
      const makerBook = withoutOwn(rawMakerBook, own);
      const bb = makerBook.bids[0]?.price ?? null;
      const ba = makerBook.asks[0]?.price ?? null;
      base.bestBid = num(bb);
      base.bestAsk = num(ba);
      if (hoursToStop !== null && hoursToStop <= 0) {
        directions.push({ ...base, reason: "已过停止挂单时间" });
        continue;
      }
      const q = computeQuote({
        makerMeta,
        hedgeMeta,
        makerBook,
        hedgeBook,
        targetShares: fx(s.sizeShares),
        capShares: fx(inp.risk.maxOrderShares),
        priceMode: "auto",
        fixedPrice: null,
        minMakerPrice: s.minMakerPrice !== null ? fx(s.minMakerPrice) : null,
        maxMakerPrice: s.maxMakerPrice !== null ? fx(s.maxMakerPrice) : null,
        improveTicks: s.improveTicks,
        minProfitPerShare: fx(s.minProfitPerShare),
        hedgeSlippage: fx(s.hedgeSlippage),
        riskBufferPerShare: fx(s.riskBufferPerShare),
        fxBufferBps: s.fxBufferBps,
        maxHedgePrice: fx(inp.risk.maxHedgePrice),
      });
      if (!q.ok) {
        directions.push({ ...base, reason: q.reason });
        continue;
      }
      const tick = makerMeta.tickSize;
      const queue: QueuePosition = bb === null ? "empty" : q.price > bb ? "ahead" : q.price === bb ? "join" : "behind";
      const capital = q.price + q.hedgeAvgEffPrice;
      const returnPct = capital > 0n ? toNum(q.expectedProfitPerShare) / toNum(capital) : null;
      directions.push({
        ...base,
        ok: true,
        price: num(q.price),
        makerPriceMax: num(q.makerPriceMax),
        queue,
        edgeTicks: bb === null || tick <= 0n ? null : Number((q.makerPriceMax - bb) / tick),
        size: num(q.size),
        hedgeAvgEffPrice: num(q.hedgeAvgEffPrice),
        profitPerShare: num(q.expectedProfitPerShare),
        profitTotal: num(q.expectedProfitTotal),
        capitalPerShare: num(capital),
        returnPct,
        returnPerDay: returnPct !== null && lockHours ? returnPct / (lockHours / 24) : null,
      });
    }
  }
  return { hoursToStart, hoursToStop, lockHours, directions, best: pickBest(directions) };
}

/** 最佳方向：能排到买一（或同价、簿上无买单）的优先，其次按每天资金收益率，再按潜在总利润。 */
export function pickBest(ds: DirectionEval[]): DirectionEval | null {
  const ok = ds.filter((d) => d.ok);
  if (!ok.length) return null;
  const tier = (d: DirectionEval) => (d.queue === "behind" ? 0 : 1);
  return [...ok].sort((a, b) => tier(b) - tier(a) || (b.returnPerDay ?? b.returnPct ?? 0) - (a.returnPerDay ?? a.returnPct ?? 0) || (b.profitTotal ?? 0) - (a.profitTotal ?? 0))[0]!;
}

/** 从 Gamma 市场原始数据里取活跃度（24 小时成交额、挂单深度），取不到返回 null。 */
export function pmActivity(raw: unknown): { volume24h: number | null; liquidity: number | null } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
    return Number.isFinite(x) ? x : null;
  };
  return { volume24h: n(r.volume24hrClob ?? r.volume24hr), liquidity: n(r.liquidityClob ?? r.liquidityNum ?? r.liquidity) };
}

export const ONE_SHARE = ONE;

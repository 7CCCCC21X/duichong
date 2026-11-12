import type { AppContext } from "../app.js";
import { errMsg } from "../core/async.js";
import { stepFromDecimals } from "../core/fixed.js";
import { bjTime } from "../core/time.js";
import type { Book, Outcome } from "../core/types.js";
import { complementBook } from "../market/bookStore.js";
import { pfMetaFrom } from "../market/predictData.js";
import { pmMetaFrom } from "../market/polymarketData.js";
import type { PairDefinition } from "../pairing/verify.js";
import { evaluateOpportunity, pmActivity, type OpportunityEval } from "./opportunity.js";

export interface OpportunityRow extends OpportunityEval {
  key: string;
  source: "configured" | "candidate";
  configuredAs: string | null;
  verifyStatus: string;
  verifyReasons: string[];
  tradeable: boolean | null;
  current: { venue: string; outcome: Outcome } | null;
  labels: Record<Outcome, string>;
  question: string | null;
  startTime: string | null;
  predictMarketId: number;
  polymarketConditionId: string;
  pmVolume24h: number | null;
  pmLiquidity: number | null;
  /** 四个订单簿中最旧的一个距今多少秒（实时盘口） */
  bookAgeSec: number | null;
}

const round = (x: number | null, d = 4) => (x === null ? null : Number(x.toFixed(d)));

function roundEval(ev: OpportunityEval): OpportunityEval {
  const r = (d: OpportunityEval["directions"][number]) => ({
    ...d,
    returnPct: round(d.returnPct, 6),
    returnPerDay: round(d.returnPerDay, 6),
    profitTotal: round(d.profitTotal),
    capitalPerShare: round(d.capitalPerShare),
  });
  return { hoursToStart: round(ev.hoursToStart, 2), hoursToStop: round(ev.hoursToStop, 2), lockHours: round(ev.lockHours, 2), directions: ev.directions.map(r), best: ev.best ? r(ev.best) : null };
}

/** 已配置的配对：用实时订单簿与该配对实际生效的参数评估，扣除自己的挂单。不访问网络。 */
export function scanConfigured(ctx: AppContext): OpportunityRow[] {
  const now = ctx.clock.now();
  const rows: OpportunityRow[] = [];
  for (const [id, engine] of ctx.engines) {
    const stored = ctx.stored.get(id);
    const def = stored?.def as PairDefinition | null | undefined;
    if (!def) continue;
    const book = (v: "predict" | "polymarket", o: Outcome) => ctx.books.getBook(v, v === "predict" ? def.predict.tokens[o] : def.polymarket.tokens[o]);
    const books = { predict: { A: book("predict", "A"), B: book("predict", "B") }, polymarket: { A: book("polymarket", "A"), B: book("polymarket", "B") } };
    const ages = [books.predict.A, books.predict.B, books.polymarket.A, books.polymarket.B].filter((b): b is Book => b !== null).map((b) => (now - b.receivedAt) / 1000);
    const own = ctx.repo
      .listOrders({ pairId: id, nonTerminal: true })
      .filter((o) => o.role === "MAKER" && o.side === "BUY")
      .map((o) => ({ venue: o.venue, outcome: o.outcome, price: o.price, size: o.size - o.reportedFilled }));
    const ev = evaluateOpportunity({
      labels: def.labels,
      startTime: def.startTime,
      bestOf: def.bestOf,
      predict: { meta: ctx.books.getMeta("predict", String(def.predict.marketId)), books: books.predict },
      polymarket: { meta: ctx.books.getMeta("polymarket", def.polymarket.conditionId), books: books.polymarket },
      strategy: engine.pair.strategy,
      risk: engine.pair.risk,
      ownBids: own,
      now,
    });
    const act = ctx.pmActivity.get(def.polymarket.conditionId);
    rows.push({
      ...roundEval(ev),
      key: id,
      source: "configured",
      configuredAs: id,
      verifyStatus: stored!.status,
      verifyReasons: stored!.statusReason ? [stored!.statusReason] : [],
      tradeable: engine.pair.tradeable,
      current: { venue: engine.pair.makerVenue, outcome: engine.pair.makerOutcome },
      labels: def.labels,
      question: null,
      startTime: def.startTime !== null ? bjTime(def.startTime) : null,
      predictMarketId: def.predict.marketId,
      polymarketConditionId: def.polymarket.conditionId,
      pmVolume24h: act?.volume24h ?? null,
      pmLiquidity: act?.liquidity ?? null,
      bookAgeSec: ages.length === 4 ? Math.round(Math.max(...ages)) : null,
    });
  }
  return rows;
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 候选市场：遍历 Predict 电竞整场胜负盘（带 polymarketConditionIds 的），核对后用 REST 拉两边订单簿评估。
 * 未通过核对的不评估（不能交易）；已配置的配对默认跳过（控制台里用实时盘口单独显示）。
 */
export async function scanCandidates(ctx: AppContext, opts: { skipConfigured?: boolean } = {}): Promise<{ at: string; rows: OpportunityRow[]; rejected: number; errors: string[]; skipped: { reason: string; count: number }[] }> {
  const now = ctx.clock.now();
  const { results, skipped } = await ctx.pairing.discover({ save: false });
  const errors: string[] = [];
  const configuredAs = (pfId: number, cond: string): string | null => {
    for (const pc of ctx.pairConfigs.values()) if (pc.predict.marketId === pfId || pc.polymarket.conditionId.toLowerCase() === cond.toLowerCase()) return pc.id;
    return null;
  };
  const usable = results.filter((r) => r.def && r.verification.status !== "REJECTED");
  const cands = usable.filter((r) => !(opts.skipConfigured && configuredAs(r.pf.id, r.pm.conditionId)));
  let pfBooks = new Map<number, Book>();
  if (cands.length) {
    try {
      pfBooks = await ctx.pfPublic.orderbooks(cands.map((r) => r.pf.id));
    } catch (e) {
      errors.push(`Predict 订单簿获取失败：${errMsg(e)}`);
    }
  }
  const rows = await pool(cands, 4, async (r): Promise<OpportunityRow> => {
    const def = r.def!;
    let clob = null;
    try {
      clob = await ctx.pmPublic.clobMarket(def.polymarket.conditionId);
    } catch (e) {
      errors.push(`Polymarket 市场参数获取失败 ${def.polymarket.conditionId.slice(0, 10)}…：${errMsg(e)}`);
    }
    const pmBook = async (t: string): Promise<Book | null> => {
      try {
        return await ctx.pmPublic.book(t);
      } catch (e) {
        errors.push(`Polymarket 订单簿获取失败：${errMsg(e)}`);
        return null;
      }
    };
    const [pmA, pmB] = await Promise.all([pmBook(def.polymarket.tokens.A), pmBook(def.polymarket.tokens.B)]);
    const yes = pfBooks.get(r.pf.id) ?? null;
    const pfB = yes ? complementBook(yes, stepFromDecimals(def.predict.decimalPrecision)) : null;
    const ev = evaluateOpportunity({
      labels: def.labels,
      startTime: def.startTime,
      bestOf: def.bestOf,
      predict: { meta: pfMetaFrom(r.pf, r.cat.startsAt, now), books: { A: yes, B: pfB } },
      polymarket: { meta: pmMetaFrom(r.pm, clob, ctx.cfg.app.polymarket.minOrderMode, now), books: { A: pmA, B: pmB } },
      strategy: ctx.cfg.app.strategy,
      risk: ctx.cfg.app.risk,
      now,
    });
    const act = pmActivity(r.pm.raw);
    return {
      ...roundEval(ev),
      key: r.pairId,
      source: "candidate",
      configuredAs: configuredAs(r.pf.id, r.pm.conditionId),
      verifyStatus: r.verification.status,
      verifyReasons: r.verification.reasons,
      tradeable: null,
      current: null,
      labels: def.labels,
      question: r.pm.question,
      startTime: def.startTime !== null ? bjTime(def.startTime) : null,
      predictMarketId: r.pf.id,
      polymarketConditionId: def.polymarket.conditionId,
      pmVolume24h: act.volume24h,
      pmLiquidity: act.liquidity,
      bookAgeSec: null,
    };
  });
  return { at: bjTime(now), rows, rejected: results.length - usable.length, errors: [...new Set(errors)].slice(0, 20), skipped };
}

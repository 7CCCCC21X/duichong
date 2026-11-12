import { describe, expect, it } from "vitest";
import { fx } from "../src/core/fixed.js";
import type { Book, Level } from "../src/core/types.js";
import { RiskSchema, StrategySchema } from "../src/config/schema.js";
import { complementBook } from "../src/market/bookStore.js";
import { evaluateOpportunity, pickBest, pmActivity, type DirectionEval, type OpportunityInput } from "../src/monitor/opportunity.js";
import { lv, pfMeta, pmMeta } from "./harness.js";

const NOW = Date.UTC(2026, 10, 12, 4, 0, 0);
const book = (bids: Level[], asks: Level[]): Book => ({ bids, asks, exchangeTs: NOW, receivedAt: NOW, source: "sim" });

/**
 * Predict A：买一 0.45 / 卖一 0.50（B 为互补簿：买一 0.50 / 卖一 0.55）
 * Polymarket A：买一 0.50 / 卖一 0.51（B：买一 0.49 / 卖一 0.50），Polymarket 吃单费率 0.05
 * 缓冲全部为 0，最低利润 0.01：Predict 挂 A、在 Polymarket 买 B（0.50 + 费 0.0125）→ 盈利上限 0.47
 */
function input(over: Partial<OpportunityInput> = {}, pfBids: Level[] = [lv("0.45", 100)]): OpportunityInput {
  const yes = book(pfBids, [lv("0.50", 100)]);
  const pmA = book([lv("0.50", 500)], [lv("0.51", 500)]);
  return {
    labels: { A: "TeamA", B: "TeamB" },
    startTime: NOW + 7 * 3600_000,
    bestOf: 3,
    predict: { meta: pfMeta(), books: { A: yes, B: complementBook(yes, fx("0.01")) } },
    polymarket: { meta: pmMeta(), books: { A: pmA, B: complementBook(pmA, fx("0.01")) } },
    strategy: StrategySchema.parse({ minProfitPerShare: 0.01, hedgeSlippage: 0, riskBufferPerShare: 0, fxBufferBps: 0, sizeShares: 50 }),
    risk: RiskSchema.parse({}),
    now: NOW,
    ...over,
  };
}

const dir = (ev: ReturnType<typeof evaluateOpportunity>, v: string, o: string) => ev.directions.find((d) => d.makerVenue === v && d.makerOutcome === o)!;

describe("机会评估", () => {
  it("四个方向逐一评估：Predict 挂 A 能领先买一，其余方向盈利上限低于买一", () => {
    const ev = evaluateOpportunity(input());
    const a = dir(ev, "predict", "A");
    expect(a.ok).toBe(true);
    expect(a.makerPriceMax).toBeCloseTo(0.47, 10);
    expect(a.price).toBeCloseTo(0.46, 10);
    expect(a.bestBid).toBeCloseTo(0.45, 10);
    expect(a.queue).toBe("ahead");
    expect(a.edgeTicks).toBe(2);
    expect(a.hedgeAvgEffPrice).toBeCloseTo(0.5125, 10);
    expect(a.profitPerShare).toBeCloseTo(0.0275, 10);
    expect(a.capitalPerShare).toBeCloseTo(0.9725, 10);
    expect(a.returnPct).toBeCloseTo(0.0275 / 0.9725, 10);
    // 资金锁定 = 距开赛 7 小时 + BO3 约 3 小时 + 结算 2 小时 = 12 小时 → 每天收益率是每对收益率的 2 倍
    expect(ev.lockHours).toBeCloseTo(12, 10);
    expect(a.returnPerDay).toBeCloseTo((0.0275 / 0.9725) * 2, 10);
    expect(ev.hoursToStop).toBeCloseTo(7 - 600 / 3600, 10);
    expect(ev.best!.makerVenue).toBe("predict");
    expect(ev.best!.makerOutcome).toBe("A");
    for (const d of ev.directions) if (d !== a && d.ok) expect(d.queue).toBe("behind");
  });

  it("别人出价高于我们的盈利上限：排在买一之后，上限比买一低", () => {
    const ev = evaluateOpportunity(input({}, [lv("0.48", 100)]));
    const a = dir(ev, "predict", "A");
    expect(a.ok).toBe(true);
    expect(a.queue).toBe("behind");
    expect(a.edgeTicks).toBe(-1);
  });

  it("评估竞争时扣除自己的挂单", () => {
    const withOwn = input({ ownBids: [{ venue: "predict", outcome: "A", price: fx("0.46"), size: fx(50) }] }, [lv("0.46", 50), lv("0.45", 100)]);
    const a = dir(evaluateOpportunity(withOwn), "predict", "A");
    expect(a.bestBid).toBeCloseTo(0.45, 10);
    expect(a.price).toBeCloseTo(0.46, 10); // 不会为了超过自己的挂单而加价
    expect(a.queue).toBe("ahead");
    // 同样的盘口如果 0.46 是别人的挂单：加价到 0.47（盈利上限）去领先
    const noOwn = dir(evaluateOpportunity(input({}, [lv("0.46", 50), lv("0.45", 100)])), "predict", "A");
    expect(noOwn.price).toBeCloseTo(0.47, 10);
    expect(noOwn.edgeTicks).toBe(1);
  });

  it("对冲盘在价格上限内没有深度：给出原因；已过停止挂单时间：全部不可挂", () => {
    const pmA = book([lv("0.01", 500)], [lv("0.02", 500)]); // B 卖一 0.99 > 补单上限 0.97
    const ev = evaluateOpportunity(input({ polymarket: { meta: pmMeta(), books: { A: pmA, B: complementBook(pmA, fx("0.01")) } } }));
    expect(dir(ev, "predict", "A").ok).toBe(false);
    expect(dir(ev, "predict", "A").reason).toMatch(/无深度/);
    const late = evaluateOpportunity(input({ startTime: NOW + 5 * 60_000 }));
    expect(late.best).toBeNull();
    expect(late.directions.every((d) => d.reason === "已过停止挂单时间")).toBe(true);
    const missing = evaluateOpportunity(input({ predict: { meta: null, books: { A: null, B: null } } }));
    expect(missing.directions.filter((d) => d.makerVenue === "predict").every((d) => /缺少/.test(d.reason ?? ""))).toBe(true);
  });

  it("最佳方向：能排到买一的优先，其次按每天资金收益率", () => {
    const d = (over: Partial<DirectionEval>): DirectionEval =>
      ({ makerVenue: "predict", makerOutcome: "A", makerTeam: "", hedgeTeam: "", ok: true, reason: null, price: 0.4, makerPriceMax: 0.45, bestBid: 0.39, bestAsk: 0.5, queue: "ahead", edgeTicks: 6, size: 50, hedgeAvgEffPrice: 0.55, profitPerShare: 0.05, profitTotal: 2.5, capitalPerShare: 0.95, returnPct: 0.05, returnPerDay: 0.1, ...over }) as DirectionEval;
    const behindButRich = d({ queue: "behind", returnPerDay: 0.5 });
    const ahead = d({ returnPerDay: 0.1 });
    const aheadBetter = d({ makerOutcome: "B", returnPerDay: 0.2 });
    expect(pickBest([behindButRich, ahead, aheadBetter])).toBe(aheadBetter);
    expect(pickBest([behindButRich, d({ ok: false })])).toBe(behindButRich);
    expect(pickBest([d({ ok: false })])).toBeNull();
  });

  it("从 Gamma 原始数据读取 24 小时成交额与挂单深度", () => {
    expect(pmActivity({ volume24hrClob: 132919.5, liquidityClob: "41549.4" })).toEqual({ volume24h: 132919.5, liquidity: 41549.4 });
    expect(pmActivity({ volume24hr: "10", liquidityNum: 5 })).toEqual({ volume24h: 10, liquidity: 5 });
    expect(pmActivity(null)).toEqual({ volume24h: null, liquidity: null });
  });
});

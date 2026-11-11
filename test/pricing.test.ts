import { describe, expect, it } from "vitest";
import { fx, toStr } from "../src/core/fixed.js";
import type { Book } from "../src/core/types.js";
import { effectiveBuyPrice, maxRawPriceForEffectiveCap, netPerGrossShare, takerFeeUsd } from "../src/pricing/fees.js";
import { computeQuote } from "../src/pricing/quote.js";
import { walkBuy, walkSell } from "../src/pricing/walk.js";
import { complementBook } from "../src/market/bookStore.js";
import { lv, pfMeta, pmMeta } from "./harness.js";

const PM_FEE = { kind: "polymarket" as const, rate: fx("0.05"), exponent: 1, enabled: true };
const PF_FEE = { kind: "predict" as const, rateBps: 200, exponent: 1 };

function book(bids: ReturnType<typeof lv>[], asks: ReturnType<typeof lv>[]): Book {
  return { bids, asks, exchangeTs: 0, receivedAt: 0, source: "sim" };
}

describe("手续费模型（对照官方文档表格）", () => {
  it("Polymarket 体育类 rate=0.05：100 份 @0.50 手续费 1.25，@0.10 为 0.45", () => {
    expect(toStr(takerFeeUsd(PM_FEE, fx("0.5"), fx(100)), 5)).toBe("1.25");
    expect(toStr(takerFeeUsd(PM_FEE, fx("0.1"), fx(100)), 5)).toBe("0.45");
    expect(toStr(takerFeeUsd(PM_FEE, fx("0.99"), fx(100)), 5)).toBe("0.0495");
  });

  it("Predict 200bps：100 份 @0.50 手续费 1 USDT，买入扣份额后到账 98 份", () => {
    expect(toStr(takerFeeUsd(PF_FEE, fx("0.5"), fx(100)), 6)).toBe("1");
    const npg = netPerGrossShare(PF_FEE, fx("0.5"));
    expect(toStr(npg, 6)).toBe("0.98");
    // 文档示例：0.99 买 100 份，约到账 99.9798 份
    const npg99 = netPerGrossShare(PF_FEE, fx("0.99"));
    expect(Number(toStr((npg99 * 100n * 10n ** 18n) / 10n ** 18n, 4))).toBeCloseTo(99.9798, 3);
  });

  it("有效成本上限反推最高原始价格（单调、按 tick）", () => {
    const cap = fx("0.52");
    const p = maxRawPriceForEffectiveCap(PM_FEE, cap, fx("0.01"))!;
    expect(effectiveBuyPrice(PM_FEE, p) <= cap).toBe(true);
    expect(effectiveBuyPrice(PM_FEE, p + fx("0.01")) > cap).toBe(true);
    const q = maxRawPriceForEffectiveCap(PF_FEE, cap, fx("0.01"))!;
    expect(effectiveBuyPrice(PF_FEE, q) <= cap).toBe(true);
    expect(effectiveBuyPrice(PF_FEE, q + fx("0.01")) > cap).toBe(true);
  });
});

describe("逐档吃单成本", () => {
  it("Polymarket 买入：手续费另付 USD，到账份额不扣", () => {
    const w = walkBuy([lv("0.50", 10), lv("0.52", 100)], fx(30), PM_FEE);
    expect(w.complete).toBe(true);
    expect(toStr(w.netShares)).toBe("30");
    expect(toStr(w.notional, 4)).toBe("15.4"); // 10*0.5 + 20*0.52
    expect(toStr(w.worstPrice, 2)).toBe("0.52");
    expect(w.feeCollateral > 0n).toBe(true);
    expect(w.feeShares).toBe(0n);
  });

  it("Predict 买入：按净到账份额倒推毛份额（扣份额手续费）", () => {
    const w = walkBuy([lv("0.50", 1000)], fx(18), PF_FEE);
    expect(w.complete).toBe(true);
    expect(w.netShares >= fx(18)).toBe(true);
    // 毛份额约 18/0.98 = 18.367...
    expect(Number(toStr(w.grossShares, 6))).toBeCloseTo(18.367347, 4);
  });

  it("深度不足时报告不完整，价格上限截断", () => {
    const w = walkBuy([lv("0.50", 5), lv("0.60", 100)], fx(20), PM_FEE, { maxPrice: fx("0.55") });
    expect(w.complete).toBe(false);
    expect(toStr(w.netShares)).toBe("5");
  });

  it("卖出：所得扣手续费", () => {
    const w = walkSell([lv("0.40", 10), lv("0.39", 10)], fx(15), PF_FEE);
    expect(w.complete).toBe(true);
    expect(w.proceeds < w.notional).toBe(true);
  });
});

describe("Predict 互补簿（只按 Yes 报价）", () => {
  it("No 买价 = 1 − Yes 卖价，No 卖价 = 1 − Yes 买价", () => {
    const yes = book([lv("0.491", 100), lv("0.49", 50)], [lv("0.492", 30), lv("0.493", 20)]);
    const no = complementBook(yes, fx("0.001"));
    expect(toStr(no.bids[0]!.price, 3)).toBe("0.508");
    expect(toStr(no.asks[0]!.price, 3)).toBe("0.509");
    expect(toStr(no.asks[0]!.size)).toBe("100");
  });
});

describe("挂单报价（按对冲侧实际深度）", () => {
  const base = {
    makerMeta: pfMeta(),
    hedgeMeta: pmMeta({ fee: { kind: "polymarket", rate: 0n, exponent: 1, enabled: false } }),
    makerBook: book([lv("0.44", 100)], [lv("0.48", 100)]),
    hedgeBook: book([lv("0.49", 100)], [lv("0.51", 100), lv("0.53", 100)]),
    targetShares: fx(50),
    capShares: fx(1000),
    priceMode: "fixed" as const,
    fixedPrice: fx("0.46"),
    minMakerPrice: null,
    maxMakerPrice: null,
    improveTicks: 1,
    minProfitPerShare: fx("0.01"),
    hedgeSlippage: 0n,
    riskBufferPerShare: 0n,
    fxBufferBps: 0,
    maxHedgePrice: fx("0.97"),
  };

  it("示例：挂 0.46，对冲有效成本 0.51，毛空间每对 0.03，满足 0.01 最低利润", () => {
    const q = computeQuote(base);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(toStr(q.price, 2)).toBe("0.46");
    expect(toStr(q.size)).toBe("50");
    expect(toStr(q.expectedProfitPerShare, 4)).toBe("0.03");
    expect(toStr(q.makerPriceMax, 2)).toBe("0.48");
  });

  it("要求利润 0.04 时，固定价 0.46 不再满足，拒绝挂单", () => {
    const q = computeQuote({ ...base, minProfitPerShare: fx("0.04") });
    expect(q.ok).toBe(false);
  });

  it("对冲深度只有 30 份时，挂单数量降到 30", () => {
    const q = computeQuote({ ...base, hedgeBook: book([], [lv("0.51", 30)]) });
    expect(q.ok && toStr(q.size)).toBe("30");
  });

  it("计入对冲手续费后利润下降（Polymarket 0.05 费率）", () => {
    const q = computeQuote({ ...base, hedgeMeta: pmMeta() });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    // 0.51 的手续费 0.05*0.51*0.49 = 0.0124950
    expect(Number(toStr(q.hedgeAvgEffPrice, 6))).toBeCloseTo(0.522495, 5);
    expect(Number(toStr(q.expectedProfitPerShare, 6))).toBeCloseTo(0.017505, 5);
  });

  it("post-only：auto 模式不会挂到卖一或以上", () => {
    const q = computeQuote({ ...base, priceMode: "auto", makerBook: book([lv("0.47", 10)], [lv("0.475", 10)]), makerMeta: pfMeta({ tickSize: fx("0.001") }) });
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.price < fx("0.475")).toBe(true);
  });

  it("Predict 挂单需满足最小 1 USDT", () => {
    const q = computeQuote({ ...base, targetShares: fx(2) });
    expect(q.ok).toBe(false);
  });
});

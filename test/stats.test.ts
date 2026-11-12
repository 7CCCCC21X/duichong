import { describe, expect, it } from "vitest";
import { fx } from "../src/core/fixed.js";
import { parseTime } from "../src/core/time.js";
import { computeHedgeStats, dist } from "../src/monitor/stats.js";
import { mapErrorCode } from "../src/venues/predict/live.js";
import { Harness, lv, TOK } from "./harness.js";

function standardBooks(h: Harness): void {
  h.setPredictBook([lv("0.44", 500)], [lv("0.48", 500)]);
  h.setPolyBook("B", [lv("0.49", 500)], [lv("0.51", 500), lv("0.53", 500)]);
}

async function ready(): Promise<Harness> {
  const h = new Harness();
  standardBooks(h);
  h.onTick = () => standardBooks(h);
  await h.refreshBalances();
  await h.reconcile();
  await h.tick();
  return h;
}

describe("时间解析", () => {
  it("Polymarket 秒级 match_time 与毫秒 timestamp 字符串", () => {
    expect(parseTime("1782753357")).toBe(1782753357000);
    expect(parseTime("1782753357257")).toBe(1782753357257);
    expect(parseTime("2026-11-11 18:00:00+00")).toBe(Date.parse("2026-11-11T18:00:00Z"));
  });
});

describe("补单统计（第一腿成交 → 第二腿成交）", () => {
  it("耗时分段、滑点与失败率", async () => {
    const h = await ready();
    const t0 = h.clock.now();
    h.venues.predict.fillMaker(TOK.predict.A, fx(18));
    await h.settle();
    // 第一次补单被拒（计入补单失败），下一轮重试成交
    h.venues.polymarket.faults.rejectNext = { cls: "OTHER", message: "模拟拒单" };
    await h.tick(1000);
    await h.tick(1500);
    expect(h.net()).toBe(0n);
    const s = computeHedgeStats(h.repo, "pair1");
    expect(s.firstLegFills).toBe(1);
    expect(s.hedgedShares).toBeCloseTo(18, 6);
    expect(s.openShares).toBe(0);
    // 第一腿在 t0 成交并收到；第二次补单在 t0+2500 发出并立即成交（模拟延迟为 0）
    expect(s.totalExchangeMs.p95).toBe(2500);
    expect(s.totalLocalMs.p95).toBe(2500);
    expect(s.notifyMs.p95).toBe(0);
    expect(s.samples[0]!.firstLegAt).toBe(t0);
    // 预期对冲成本 0.522495（0.51 + 0.05×0.51×0.49），实际相同 → 滑点约 0
    expect(Math.abs(s.slippagePerShare.mean!)).toBeLessThan(1e-6);
    expect(s.hedgeOrders).toBe(2);
    expect(s.hedgeOrdersNoFill).toBe(1);
    expect(s.hedgeFailureRate).toBeCloseTo(0.5, 9);
  });

  it("分位数（就近排名）", () => {
    const d = dist([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 5000]);
    expect(d.n).toBe(11);
    expect(d.p50).toBe(600);
    expect(d.p95).toBe(5000);
    expect(d.max).toBe(5000);
  });
});

describe("地区或账户受限（403）", () => {
  it("Predict 返回 403 forbidden 归类为 FORBIDDEN", () => {
    expect(mapErrorCode("forbidden", 403)).toBe("FORBIDDEN");
    expect(mapErrorCode("", 401)).toBe("AUTH");
  });

  it("挂单被拒（地区受限）：阻断该平台并告警，不再挂单", async () => {
    const h = new Harness();
    standardBooks(h);
    await h.refreshBalances();
    h.venues.predict.faults.rejectNext = { cls: "FORBIDDEN", message: "This operation is not available in your jurisdiction" };
    await h.reconcile();
    await h.tick();
    await h.tick();
    expect(h.alerts.recent.some((a) => a.code === "FORBIDDEN")).toBe(true);
    expect(h.risk.venueBlocked("predict")?.reason).toContain("受限");
    expect(h.activeMakers()).toHaveLength(0);
  });
});

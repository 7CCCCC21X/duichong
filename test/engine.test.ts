import { describe, expect, it } from "vitest";
import { abs, fx, toStr } from "../src/core/fixed.js";
import { Harness, lv, TOK } from "./harness.js";
import type { HarnessOptions } from "./harness.js";

/** 标准盘口：Predict A 买一 0.44 / 卖一 0.48；Polymarket B 卖一 0.51（A 镜像） */
function standardBooks(h: Harness): void {
  h.setPredictBook([lv("0.44", 500)], [lv("0.48", 500)]);
  h.setPolyBook("B", [lv("0.49", 500)], [lv("0.51", 500), lv("0.53", 500)]);
}

async function ready(opts: HarnessOptions = {}): Promise<Harness> {
  const h = new Harness(opts);
  standardBooks(h);
  await h.refreshBalances();
  await h.reconcile();
  await h.tick();
  return h;
}

const DUST = fx("0.2");

describe("挂单与按净成交补单", () => {
  it("挂 50 份、实际成交 18 份：按新增的 18 份补单，净敞口归零，挂单剩余 32 份", async () => {
    const h = await ready();
    const makers = h.activeMakers();
    expect(makers).toHaveLength(1);
    expect(toStr(makers[0]!.price, 2)).toBe("0.46");
    expect(toStr(makers[0]!.size)).toBe("50");
    expect(makers[0]!.postOnly).toBe(true);

    h.venues.predict.fillMaker(TOK.predict.A, fx(18));
    await h.settle();
    await h.tick();

    const hedges = h.orders("HEDGE");
    expect(hedges).toHaveLength(1);
    expect(hedges[0]!.venue).toBe("polymarket");
    expect(hedges[0]!.outcome).toBe("B");
    expect(toStr(hedges[0]!.size)).toBe("18");
    expect(h.net()).toBe(0n);
    const pos = h.positions();
    expect(toStr(pos.shares.predict.A)).toBe("18");
    expect(toStr(pos.shares.polymarket.B)).toBe("18");
    const maker = h.orders("MAKER")[0]!;
    expect(["PARTIAL", "ACCEPTED"]).toContain(maker.status);
    expect(toStr(maker.reportedFilled)).toBe("18");
  });

  it("补单只到账 12 份时，剩余 6 份继续管理直到对齐", async () => {
    const h = await ready();
    // 对冲盘只剩 12 份在可接受价格内
    h.setPolyBook("B", [lv("0.49", 500)], [lv("0.51", 12), lv("0.70", 500)]);
    h.venues.predict.fillMaker(TOK.predict.A, fx(18));
    await h.settle();
    await h.tick();
    expect(toStr(h.net())).toBe("6");
    // 盘口恢复，剩余 6 份继续补
    h.setPolyBook("B", [lv("0.49", 500)], [lv("0.51", 500)]);
    await h.tick(1500, 2);
    expect(h.net()).toBe(0n);
    const hedges = h.orders("HEDGE");
    expect(hedges.map((o) => toStr(o.size)).sort()).toEqual(["12", "6"]);
  });

  it("手续费扣份额（Predict 补单）：按净到账份额补足", async () => {
    const h = new Harness({ makerVenue: "polymarket", makerOutcome: "A" });
    h.setPolyBook("A", [lv("0.44", 500)], [lv("0.48", 500)]);
    // Predict A 买一 0.49 → B 卖一 0.51
    h.setPredictBook([lv("0.49", 500)], [lv("0.51", 500)]);
    await h.refreshBalances();
    await h.reconcile();
    await h.tick();
    expect(h.activeMakers()[0]?.venue).toBe("polymarket");
    h.venues.polymarket.fillMaker(TOK.polymarket.A, fx(18));
    await h.settle();
    await h.tick();
    const hedgeFills = h.repo.listFills({ pairId: "pair1" }).filter((f) => f.role === "HEDGE");
    expect(hedgeFills.length).toBeGreaterThan(0);
    const feeShares = hedgeFills.reduce((s, f) => s + f.feeShares, 0n);
    expect(feeShares > 0n).toBe(true);
    const gross = hedgeFills.reduce((s, f) => s + f.grossShares, 0n);
    expect(gross > fx(18)).toBe(true); // 毛份额多买以覆盖扣掉的手续费
    expect(abs(h.net()) <= DUST).toBe(true);
    // 到账净份额以结算回报为准
    expect(hedgeFills.every((f) => f.status === "SETTLED" && !f.feeEstimated)).toBe(true);
  });
});

describe("事件去重与乱序", () => {
  it("重复且乱序的推送只产生一次有效处理", async () => {
    const h = await ready();
    h.venues.predict.faults.duplicateEvents = true;
    h.venues.predict.faults.reorderEvents = true;
    h.venues.polymarket.faults.duplicateEvents = true;
    h.venues.polymarket.faults.reorderEvents = true;
    h.venues.predict.fillMaker(TOK.predict.A, fx(18));
    await h.settle();
    await h.tick(1000, 3);
    expect(h.orders("HEDGE")).toHaveLength(1);
    expect(h.net()).toBe(0n);
    const fills = h.repo.listFills({ pairId: "pair1" });
    expect(fills.filter((f) => f.role === "MAKER")).toHaveLength(1);
    expect(fills.every((f) => f.status === "SETTLED")).toBe(true);
  });

  it("成交先于下单回执到达时先暂存，订单受理后再匹配", async () => {
    const h = await ready();
    // 构造一条找不到订单的成交推送
    h.router.handle({
      type: "fill",
      venue: "predict",
      ts: h.clock.now(),
      fill: {
        key: "early-1",
        venue: "predict",
        venueOrderId: "late-oid",
        orderHash: null,
        tokenId: TOK.predict.A,
        side: "BUY",
        price: fx("0.46"),
        grossShares: fx(5),
        feeShares: null,
        feeCollateral: null,
        isMaker: true,
        status: "MATCHED",
        matchedAt: h.clock.now(),
        txHash: null,
      },
    });
    expect(h.repo.listUnmatchedFills()).toHaveLength(1);
    // 让本地挂单拿到这个交易所 ID
    const maker = h.activeMakers()[0]!;
    h.repo.updateOrder(maker.id, { venueOrderId: "late-oid" }, h.clock.now());
    expect(h.router.retryParked()).toBe(1);
    await h.settle();
    expect(h.repo.listFills({ pairId: "pair1" }).some((f) => f.key === "early-1")).toBe(true);
  });
});

describe("两边同时成交（为双边挂单保留的净额处理）", () => {
  it("两边各成交互补的 18 份时净敞口为零，不补单", async () => {
    const h = await ready();
    // 另一边（Polymarket B）的挂单成交记录：模拟后续双边挂单时两边同时成交
    const now = h.clock.now();
    h.repo.insertOrder({
      id: "manual-pm-maker",
      pairId: "pair1",
      venue: "polymarket",
      role: "MAKER",
      kind: "LIMIT",
      outcome: "B",
      tokenId: TOK.polymarket.B,
      side: "BUY",
      price: fx("0.50"),
      size: fx(18),
      amountUsd: null,
      postOnly: true,
      status: "FILLED",
      venueOrderId: "manual-pm-oid",
      hash: "0xmanual",
      reportedFilled: fx(18),
      plannedFill: null,
      expiresAt: null,
      createdAt: now,
      sentAt: now,
      ackAt: now,
      updatedAt: now,
      terminalAt: now,
      error: null,
      payload: null,
      meta: {},
    });
    // 同一时刻两边成交
    h.venues.predict.fillMaker(TOK.predict.A, fx(18));
    h.router.handle({
      type: "fill",
      venue: "polymarket",
      ts: now,
      fill: {
        key: "pm-trade-1:manual-pm-oid",
        venue: "polymarket",
        venueOrderId: "manual-pm-oid",
        orderHash: null,
        tokenId: TOK.polymarket.B,
        side: "BUY",
        price: fx("0.50"),
        grossShares: fx(18),
        feeShares: 0n,
        feeCollateral: 0n,
        isMaker: true,
        status: "MATCHED",
        matchedAt: now,
        txHash: null,
      },
    });
    await h.settle();
    await h.tick(1000, 2);
    expect(h.net()).toBe(0n);
    expect(h.orders("HEDGE")).toHaveLength(0);
    const pnl = h.engine.snapshot().pnl;
    expect(toStr(pnl.hedged)).toBe("18");
    // 每对成本 0.46 + 0.50 = 0.96，锁定利润 18 × 0.04 = 0.72
    expect(toStr(pnl.lockedPnl, 4)).toBe("0.72");
  });
});

describe("超时、撤单途中成交、结算失败", () => {
  it("补单请求超时但实际成交：先查单再决定，不重复补单", async () => {
    const h = await ready();
    h.venues.polymarket.faults.submitTimeoutNext = { placeAnyway: true };
    h.venues.polymarket.faults.dropFillEvents = true; // 推送也丢了，只能靠查单 + 补拉
    h.venues.predict.fillMaker(TOK.predict.A, fx(18));
    await h.settle();
    await h.tick();
    // 回执超时 → 标记“状态未知”并告警，随后查单确认实际已成交
    expect(h.alerts.recent.some((a) => a.code === "ORDER_UNKNOWN")).toBe(true);
    await h.tick(1000, 3);
    expect(h.orders("HEDGE")).toHaveLength(1);
    const resolved = h.orders("HEDGE")[0]!;
    expect(resolved.status).toBe("FILLED");
    expect(h.net()).toBe(0n);
  });

  it("撤单途中成交的数量计入敞口并补单", async () => {
    const h = await ready({ strategy: { stopQuotingAt: null } });
    h.venues.predict.faults.fillDuringCancel = fx(10);
    // 到停止挂单时间 → 撤单
    h.engine.pair.strategy.stopQuotingAt = new Date(h.clock.now() + 500).toISOString();
    await h.tick(1000, 3);
    const maker = h.orders("MAKER")[0]!;
    expect(maker.status).toBe("CANCELLED");
    expect(toStr(h.positions().shares.predict.A)).toBe("10");
    expect(h.net()).toBe(0n);
    expect(toStr(h.orders("HEDGE")[0]!.size)).toBe("10");
  });

  it("挂单成交结算失败（补单已完成后才收到失败）：冲回后对冲腿多出，按亏损限制处理", async () => {
    const h = await ready();
    h.onTick = () => standardBooks(h);
    const maker = h.activeMakers()[0]!;
    const fill = (status: "MATCHED" | "FAILED") => ({
      type: "fill" as const,
      venue: "predict" as const,
      ts: h.clock.now(),
      fill: {
        key: "pf:maker-fill-1",
        venue: "predict" as const,
        venueOrderId: maker.venueOrderId,
        orderHash: maker.hash,
        tokenId: TOK.predict.A,
        side: "BUY" as const,
        price: fx("0.46"),
        grossShares: fx(18),
        feeShares: status === "FAILED" ? 0n : null,
        feeCollateral: status === "FAILED" ? 0n : null,
        isMaker: true,
        status,
        matchedAt: h.clock.now(),
        txHash: null,
      },
    });
    h.router.handle(fill("MATCHED"));
    await h.settle();
    await h.tick();
    // 撮合即补单
    expect(h.orders("HEDGE")).toHaveLength(1);
    expect(h.net()).toBe(0n);
    // 之后收到结算失败：挂单腿冲回，变成 B 多出 18
    h.router.handle(fill("FAILED"));
    await h.settle();
    expect(toStr(h.net())).toBe("-18");
    expect(h.alerts.recent.some((a) => a.code === "SETTLEMENT_FAILED")).toBe(true);
    // 正常价格内无法处理 → 超过最长裸仓时间后进入紧急处理，在亏损限制内选最优方案
    await h.tick(5000, 6);
    expect(abs(h.net()) <= DUST).toBe(true);
    expect(h.alerts.recent.some((a) => a.code === "EMERGENCY")).toBe(true);
  });

  it("撮合与结算失败几乎同时到达：合并窗口内直接冲回，不产生多余补单", async () => {
    const h = await ready();
    h.venues.predict.faults.settlementFailNext = true;
    h.venues.predict.fillMaker(TOK.predict.A, fx(18));
    await h.settle();
    await h.tick(1000, 2);
    expect(h.orders("HEDGE")).toHaveLength(0);
    expect(h.net()).toBe(0n);
    expect(h.alerts.recent.some((a) => a.code === "SETTLEMENT_FAILED")).toBe(true);
  });

  it("hedgeTrigger=settled 时，结算成功前不补单", async () => {
    const h = new Harness({ strategy: { hedgeTrigger: "settled" } });
    standardBooks(h);
    await h.refreshBalances();
    await h.reconcile();
    await h.tick();
    const fillTs = h.clock.now();
    // 先只推送撮合
    h.router.handle({
      type: "fill",
      venue: "predict",
      ts: fillTs,
      fill: {
        key: "m1",
        venue: "predict",
        venueOrderId: h.activeMakers()[0]!.venueOrderId,
        orderHash: null,
        tokenId: TOK.predict.A,
        side: "BUY",
        price: fx("0.46"),
        grossShares: fx(18),
        feeShares: null,
        feeCollateral: null,
        isMaker: true,
        status: "MATCHED",
        matchedAt: fillTs,
        txHash: null,
      },
    });
    await h.settle();
    await h.tick();
    expect(h.orders("HEDGE")).toHaveLength(0);
    h.router.handle({
      type: "fill",
      venue: "predict",
      ts: fillTs,
      fill: {
        key: "m1",
        venue: "predict",
        venueOrderId: h.activeMakers()[0]!.venueOrderId,
        orderHash: null,
        tokenId: TOK.predict.A,
        side: "BUY",
        price: fx("0.46"),
        grossShares: fx(18),
        feeShares: 0n,
        feeCollateral: 0n,
        isMaker: true,
        status: "SETTLED",
        matchedAt: fillTs,
        txHash: "0x1",
      },
    });
    await h.settle();
    await h.tick();
    expect(h.orders("HEDGE")).toHaveLength(1);
  });
});

describe("断线、过期、深度消失、余额不足、小额残余", () => {
  it("订单事件流断开：撤掉挂单并暂停；恢复并对账后重新挂单", async () => {
    const h = await ready();
    expect(h.activeMakers()).toHaveLength(1);
    h.venues.predict.faults.userStreamUp = false;
    await h.tick();
    expect(h.orders("MAKER")[0]!.status).toBe("CANCELLED");
    expect(h.engine.currentMode.reason).toContain("事件流断开");
    h.venues.predict.faults.userStreamUp = true;
    await h.reconcile();
    await h.tick(2000);
    expect(h.activeMakers()).toHaveLength(1);
  });

  it("行情过期（盘口断连）：撤掉挂单", async () => {
    const h = await ready();
    await h.tick(16_000); // 超过 maxBookAgeMs，未收到新盘口
    expect(h.activeMakers()).toHaveLength(0);
    expect(h.engine.currentMode.reason).toContain("行情过期");
  });

  it("对冲深度消失：超过最长裸仓时间后撤挂单，比较紧急补反向与卖回原腿", async () => {
    const h = await ready();
    h.venues.predict.fillMaker(TOK.predict.A, fx(18));
    h.setPolyBook("B", [lv("0.10", 500)], []); // B 卖盘消失
    await h.settle();
    await h.tick();
    expect(toStr(h.net())).toBe("18");
    // 盘口持续更新但没有深度
    for (let i = 0; i < 5; i++) {
      h.setPolyBook("B", [lv("0.10", 500)], []);
      h.setPredictBook([lv("0.44", 500)], [lv("0.48", 500)]);
      await h.tick(5000);
    }
    expect(h.alerts.recent.some((a) => a.code === "EMERGENCY")).toBe(true);
    expect(h.activeMakers()).toHaveLength(0);
    expect(abs(h.net()) <= DUST).toBe(true);
    // 选择了在 Predict 上卖回 A 或买入 B（Polymarket 无深度）
    const actions = h.repo.listOrders({ pairId: "pair1" }).filter((o) => o.role !== "MAKER" && o.venue === "predict");
    expect(actions.length).toBeGreaterThan(0);
  });

  it("补单平台余额不足：按预留补单资金缩小挂单数量", async () => {
    const h = await ready({ balances: { polymarket: 5 } });
    const m = h.activeMakers()[0]!;
    // 5 美元 / 每份对冲成本约 0.5225 ≈ 9.56 份
    expect(m.size <= fx("9.57")).toBe(true);
    expect(m.size > fx(9)).toBe(true);
  });

  it("挂单被拒（余额不足）：暂停该平台挂单并告警", async () => {
    const h = new Harness();
    standardBooks(h);
    await h.refreshBalances();
    h.venues.predict.faults.rejectNext = { cls: "INSUFFICIENT_BALANCE", message: "insufficient collateral" };
    await h.reconcile();
    await h.tick();
    await h.tick();
    expect(h.alerts.recent.some((a) => a.code === "INSUFFICIENT_BALANCE")).toBe(true);
    expect(h.risk.venueBlocked("predict")).not.toBeNull();
    expect(h.activeMakers()).toHaveLength(0);
  });

  it("小额残余（低于 Polymarket 最小 5 份）：先等待，超时后在 Predict 处理", async () => {
    const h = await ready();
    h.venues.predict.fillMaker(TOK.predict.A, fx(3));
    await h.settle();
    await h.tick();
    expect(toStr(h.net())).toBe("3");
    expect(h.orders("HEDGE")).toHaveLength(0);
    expect(h.engine.currentMode.exposureMode).toBe("RESIDUAL_WAIT");
    h.onTick = () => standardBooks(h);
    await h.tick(10_000, 4); // 超过 residual.maxWaitSec=30
    expect(abs(h.net()) <= DUST).toBe(true);
    const acts = h.repo.listOrders({ pairId: "pair1" }).filter((o) => o.role !== "MAKER");
    expect(acts.every((o) => o.venue === "predict")).toBe(true);
  });

  it("零头不处理（低于 dust）", async () => {
    const h = await ready();
    h.venues.predict.fillMaker(TOK.predict.A, fx("0.1"));
    await h.settle();
    await h.tick(10_000, 5);
    expect(h.repo.listOrders({ pairId: "pair1" }).filter((o) => o.role !== "MAKER")).toHaveLength(0);
  });
});

describe("进程重启", () => {
  it("停机期间挂单成交：重启后先对账补拉成交，不重复挂单，补完敞口", async () => {
    const h1 = await ready();
    const makerBefore = h1.activeMakers()[0]!;

    // 模拟崩溃：旧进程的事件处理器失效，引擎丢弃；数据库与交易所状态保留
    h1.engine.dispose();
    h1.venues.predict.resetHandlers();
    h1.venues.polymarket.resetHandlers();
    // 停机期间挂单成交了 18 份（推送没人接收）
    h1.venues.predict.fillMaker(TOK.predict.A, fx(18));
    await h1.settle();
    expect(h1.repo.listFills({ pairId: "pair1" })).toHaveLength(0);

    const h2 = new Harness({ db: h1.db, clock: h1.clock, venues: h1.venues, books: h1.books });
    standardBooks(h2);
    await h2.refreshBalances();
    await h2.reconcile();
    expect(h2.engine.isReconciled()).toBe(true);
    // 对账补回了停机期间的成交
    expect(toStr(h2.positions().shares.predict.A)).toBe("18");
    await h2.tick();
    expect(h2.net()).toBe(0n);
    expect(h2.orders("HEDGE")).toHaveLength(1);
    // 挂单仍是原来那一笔（剩余 32 份），没有重复挂
    const makers = h2.activeMakers();
    expect(makers).toHaveLength(1);
    expect(makers[0]!.id).toBe(makerBefore.id);
  });

  it("崩溃在发送途中（本地 SENDING、交易所已受理）：重启查单后接管", async () => {
    const h1 = await ready();
    const maker = h1.activeMakers()[0]!;
    // 人为把本地状态改回 SENDING，模拟回执未落库就崩溃
    h1.repo.updateOrder(maker.id, { status: "SENDING", venueOrderId: null }, h1.clock.now());
    h1.engine.dispose();
    h1.venues.predict.resetHandlers();
    h1.venues.polymarket.resetHandlers();
    const h2 = new Harness({ db: h1.db, clock: h1.clock, venues: h1.venues, books: h1.books });
    standardBooks(h2);
    await h2.refreshBalances();
    await h2.reconcile();
    await h2.tick();
    const after = h2.repo.getOrder(maker.id)!;
    expect(after.status).toBe("ACCEPTED");
    expect(h2.activeMakers()).toHaveLength(1);
  });

  it("对账发现交易所持仓与台账不一致：暂停该配对挂单并告警", async () => {
    const h1 = new Harness();
    standardBooks(h1);
    await h1.refreshBalances();
    // 交易所上已有一笔不在台账里的持仓（例如手工交易）
    (h1.venues.predict as unknown as { positions: Map<string, bigint> }).positions.set(TOK.predict.A, fx(7));
    await h1.reconcile();
    expect(h1.engine.isReconciled()).toBe(false);
    expect(h1.alerts.recent.some((a) => a.code === "POSITION_MISMATCH")).toBe(true);
    await h1.tick();
    expect(h1.activeMakers()).toHaveLength(0);
  });
});

describe("对冲盘口恶化", () => {
  it("挂价高于新的盈利上限时立即撤单", async () => {
    const h = await ready();
    expect(h.activeMakers()).toHaveLength(1);
    h.setPolyBook("B", [lv("0.49", 500)], [lv("0.56", 500)]);
    await h.tick();
    expect(h.orders("MAKER")[0]!.status).toBe("CANCELLED");
    expect(h.activeMakers()).toHaveLength(0);
  });

  it("开赛前停止挂单", async () => {
    const start = Date.UTC(2026, 10, 11, 10, 30, 0);
    const h = await ready({ startTime: start, strategy: { stopQuotingBeforeStartSec: 600 } });
    expect(h.activeMakers()).toHaveLength(1);
    h.clock.set(start - 599_000);
    standardBooks(h);
    await h.tick(0);
    expect(h.activeMakers()).toHaveLength(0);
  });
});

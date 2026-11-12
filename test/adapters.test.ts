import pino from "pino";
import { describe, expect, it } from "vitest";
import { fx } from "../src/core/fixed.js";
import type { VenueEvent } from "../src/core/types.js";
import { PolymarketLiveVenue } from "../src/venues/polymarket/live.js";
import { PredictLiveVenue, retainSignificant } from "../src/venues/predict/live.js";

const log = pino({ level: "silent" });

function pmVenue(): { v: PolymarketLiveVenue; events: VenueEvent[] } {
  const v = new PolymarketLiveVenue({ privateKey: "0x" + "11".repeat(32), walletAddress: null, credentials: null, wsUserUrl: "wss://example", orderHeartbeat: false, markets: () => [], log });
  (v as unknown as { apiKey: string }).apiKey = "my-key";
  const events: VenueEvent[] = [];
  v.onEvent((e) => events.push(e));
  return { v, events };
}

const userMsg = (v: PolymarketLiveVenue, m: unknown) => (v as unknown as { handleUserMessage(t: string): void }).handleUserMessage(JSON.stringify(m));

describe("Polymarket 用户频道：只统计属于本账户订单的成交", () => {
  it("自己做 maker：只取 makerOrders 中本账户条目的 matched_amount，不把对手 taker 的数量算进来", () => {
    const { v, events } = pmVenue();
    userMsg(v, {
      event_type: "trade",
      id: "t1",
      taker_order_id: "0xtaker",
      asset_id: "B-token",
      side: "BUY",
      size: "48",
      price: "0.54",
      status: "MATCHED",
      owner: "my-key",
      trader_side: "MAKER",
      match_time: "1794414000",
      maker_orders: [
        { order_id: "0xmine", owner: "my-key", matched_amount: "18", price: "0.46", asset_id: "A-token", side: "BUY" },
        { order_id: "0xother", owner: "someone", matched_amount: "30", price: "0.46", asset_id: "A-token", side: "BUY" },
      ],
    });
    const fills = events.filter((e) => e.type === "fill").map((e) => (e as Extract<VenueEvent, { type: "fill" }>).fill);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.venueOrderId).toBe("0xmine");
    expect(fills[0]!.isMaker).toBe(true);
    expect(fills[0]!.grossShares).toBe(fx(18));
    expect(fills[0]!.tokenId).toBe("A-token");
    expect(fills[0]!.price).toBe(fx("0.46"));
    expect(fills[0]!.key).toBe("pm:t1:0xmine");
  });

  it("缺少 trader_side 且吃单订单不是本进程下的：不记 taker 成交", () => {
    const { v, events } = pmVenue();
    userMsg(v, { event_type: "trade", id: "t2", taker_order_id: "0xunknown", asset_id: "B", side: "BUY", size: "20", price: "0.5", status: "MATCHED", owner: "my-key", maker_orders: [] });
    expect(events.filter((e) => e.type === "fill")).toHaveLength(0);
  });

  it("自己是 taker：记一笔 taker 成交；状态映射 CONFIRMED→SETTLED、FAILED→FAILED", () => {
    const { v, events } = pmVenue();
    for (const status of ["MATCHED", "MINED", "CONFIRMED"]) {
      userMsg(v, { event_type: "trade", id: "t3", taker_order_id: "0xmytaker", asset_id: "B", side: "BUY", size: "25", price: "0.51", status, owner: "my-key", trader_side: "TAKER", maker_orders: [{ order_id: "0xmaker", owner: "x", matched_amount: "25", price: "0.49", asset_id: "A", side: "BUY" }] });
    }
    userMsg(v, { event_type: "trade", id: "t4", taker_order_id: "0xmytaker2", asset_id: "B", side: "BUY", size: "5", price: "0.51", status: "TRADE_STATUS_FAILED", owner: "my-key", trader_side: "TAKER", maker_orders: [] });
    const fills = events.filter((e) => e.type === "fill").map((e) => (e as Extract<VenueEvent, { type: "fill" }>).fill);
    expect(fills.map((f) => f.status)).toEqual(["MATCHED", "MINED", "SETTLED", "FAILED"]);
    expect(fills.every((f) => !f.isMaker)).toBe(true);
    expect(new Set(fills.slice(0, 3).map((f) => f.key)).size).toBe(1); // 同一笔成交的不同状态使用同一去重键
    expect(fills[0]!.grossShares).toBe(fx(25));
  });

  it("订单事件：撤单与部分成交映射", () => {
    const { v, events } = pmVenue();
    userMsg(v, { event_type: "order", id: "0xo", asset_id: "A", original_size: "50", size_matched: "18", type: "UPDATE", status: "MATCHED" });
    userMsg(v, { event_type: "order", id: "0xo", asset_id: "A", original_size: "50", size_matched: "18", type: "CANCELLATION", status: "CANCELED" });
    const st = events.filter((e) => e.type === "order").map((e) => (e as Extract<VenueEvent, { type: "order" }>).state);
    expect(st.map((s) => s.status)).toEqual(["OPEN", "CANCELLED"]);
    expect(st[0]!.filled).toBe(fx(18));
  });
});

describe("Predict 钱包事件映射", () => {
  function pfVenue(): { v: PredictLiveVenue; events: VenueEvent[]; sent: unknown[] } {
    const v = new PredictLiveVenue({ restUrl: "https://example", wsUrl: null, apiKey: null, signerPrivateKey: "0x" + "22".repeat(32), predictAccount: null, chain: "testnet", selfTradePrevention: "CANCEL_TAKER", jwtRefreshBeforeSec: 3600, timeoutMs: 1000, log });
    const events: VenueEvent[] = [];
    v.onEvent((e) => events.push(e));
    (v as unknown as { known: Map<string, { tokenId: string; side: string }> }).known.set("0xhash", { tokenId: "tok-A", side: "BUY" });
    return { v, events, sent: [] };
  }
  const push = (v: PredictLiveVenue, sent: unknown[], data: unknown, topic = "predictWalletEvents/jwt") =>
    (v as unknown as { handleWs(t: string, w: { send(x: unknown): void; reconnect(r: string): void }): void }).handleWs(JSON.stringify({ type: "M", topic, data }), { send: (x) => sent.push(x), reconnect: () => {} });

  it("撮合 → 结算成功（带份额手续费）→ 同一去重键；心跳原样回显", () => {
    const { v, events, sent } = pfVenue();
    const base = { orderId: "77", orderHash: "0xHASH", timestamp: 1794414000000, details: { quoteType: "BID", quantity: "50.000", quantityFilled: "18.000" }, settlementId: "s1", isMaker: false, fill: { executedPriceWei: "510000000000000000", executedSizeWei: "18367347000000000000", executedValueWei: "0" } };
    push(v, sent, { ...base, type: "orderTransactionSubmitted" });
    push(v, sent, { ...base, type: "orderTransactionSuccess", fee: { amountWei: "367347000000000000", type: "SHARES" } });
    push(v, sent, 1794414000123, "heartbeat");
    const fills = events.filter((e) => e.type === "fill").map((e) => (e as Extract<VenueEvent, { type: "fill" }>).fill);
    expect(fills).toHaveLength(2);
    expect(fills[0]!.key).toBe(fills[1]!.key);
    expect(fills[0]!.status).toBe("MATCHED");
    expect(fills[0]!.feeShares).toBeNull(); // 撮合时手续费未知，先估算
    expect(fills[1]!.status).toBe("SETTLED");
    expect(fills[1]!.feeShares).toBe(367347000000000000n);
    expect(fills[1]!.tokenId).toBe("tok-A");
    expect(sent).toEqual([{ method: "heartbeat", data: 1794414000123 }]);
  });

  it("被拒（post-only 会吃单）、撮合计划、结算失败", () => {
    const { v, events, sent } = pfVenue();
    push(v, sent, { type: "orderNotAccepted", reason: "rejectedPostOnly", orderId: "1", orderHash: "0xhash", timestamp: 1, details: {} });
    push(v, sent, { type: "orderMarketMatchPlan", orderId: "2", orderHash: "0xhash", timestamp: 1, plannedFill: "12000000000000000000", details: {} });
    push(v, sent, { type: "orderTransactionFailed", orderId: "2", orderHash: "0xhash", settlementId: "s9", timestamp: 1, details: {}, fill: { executedPriceWei: "1", executedSizeWei: "2" } });
    expect(events.map((e) => e.type)).toEqual(["order", "plan", "fill"]);
    expect((events[0] as Extract<VenueEvent, { type: "order" }>).state.status).toBe("CANCELLED");
    expect((events[1] as Extract<VenueEvent, { type: "plan" }>).plannedFill).toBe(fx(12));
    expect((events[2] as Extract<VenueEvent, { type: "fill" }>).fill.status).toBe("FAILED");
  });

  it("数量按 SDK 规则保留 5 位有效数字", () => {
    expect(retainSignificant(fx("18.35267"), 5)).toBe(fx("18.352"));
    expect(retainSignificant(fx("1234.5678"), 5)).toBe(fx("1234.5"));
  });
});

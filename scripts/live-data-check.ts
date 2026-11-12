/**
 * 用真实公开行情核对行情与定价模块（不下单、不需要任何凭证）：
 * 1) Polymarket 行情 WS（book 全量 + price_change 增量）维护的订单簿与 REST 快照逐档比对；
 * 2) 用真实电竞盘口深度与市场费率计算“在 Polymarket 补单”的成本，以及 Predict 挂单的盈利上限价；
 * 3) Predict 测试网 REST 订单簿解析与 No 簿（互补）推导。
 * 运行：NODE_USE_ENV_PROXY=1 npx tsx scripts/live-data-check.ts [秒数]
 */
import pino from "pino";
import { fx, toStr } from "../src/core/fixed.js";
import { bjTime } from "../src/core/time.js";
import { BookStore, complementBook } from "../src/market/bookStore.js";
import { httpJson } from "../src/market/http.js";
import { parsePmMarket, pmMetaFrom, PolymarketBookFeed, PolymarketPublic } from "../src/market/polymarketData.js";
import { PredictPublic } from "../src/market/predictData.js";
import { computeQuote } from "../src/pricing/quote.js";
import { walkBuy } from "../src/pricing/walk.js";
import { pfMeta } from "../test/harness.js";

const secs = Number(process.argv[2] ?? 45);
const log = pino({ level: "warn" });
const pm = new PolymarketPublic({ gammaUrl: "https://gamma-api.polymarket.com", clobUrl: "https://clob.polymarket.com", timeoutMs: 15000 }, log);

// 选未来 2~24 小时开赛、有订单簿的电竞整场胜负盘
const now = Date.now();
const { data: events } = await httpJson<Record<string, unknown>[]>(
  `https://gamma-api.polymarket.com/events?tag_slug=esports&active=true&closed=false&limit=100&end_date_min=${new Date(now).toISOString()}&order=endDate&ascending=true`,
);
const markets = events
  .flatMap((e) => ((e.markets as Record<string, unknown>[]) ?? []).map((m) => ({ ...m, events: [{ id: e.id }] })))
  .map(parsePmMarket)
  .filter((m) => m.sportsMarketType === "moneyline" && m.acceptingOrders && m.gameStartTime && m.gameStartTime > now + 2 * 3600_000 && m.gameStartTime < now + 24 * 3600_000)
  .slice(0, 4);
if (!markets.length) throw new Error("没有找到合适的电竞整场胜负盘");
console.log(`选中 ${markets.length} 个 Polymarket 电竞整场胜负盘：`);
for (const m of markets) console.log(`  ${m.question} | 开赛 ${bjTime(m.gameStartTime)} | ${m.version} | 费率 ${m.feeSchedule?.rate} | 最小 ${m.orderMinSize} | tick ${m.tickSize}`);

// 1) 行情 WS 与 REST 比对
const store = new BookStore();
const feed = new PolymarketBookFeed({ wsMarketUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market", resyncSec: 3600 }, pm, store, log);
let updates = 0;
store.onUpdate(() => updates++);
feed.start();
feed.subscribe(markets.flatMap((m) => m.assetIds));
console.log(`\n订阅 ${markets.length * 2} 个代币，运行 ${secs} 秒……`);
await new Promise((r) => setTimeout(r, secs * 1000));
console.log(`收到订单簿更新 ${updates} 次（含首帧 REST 与 WS 全量/增量）`);
let ok = 0;
let bad = 0;
for (const m of markets) {
  for (const t of m.assetIds) {
    const ws = store.getBook("polymarket", t);
    const rest = await pm.book(t);
    const top = (ls: { price: bigint; size: bigint }[]) => ls.slice(0, 5).map((l) => `${toStr(l.price, 3)}x${toStr(l.size, 2)}`).join(",");
    const same = ws && top(ws.bids) === top(rest.bids) && top(ws.asks) === top(rest.asks);
    if (same) ok++;
    else {
      bad++;
      console.log(`  不一致 ${t.slice(0, 10)}… WS 买 ${ws ? top(ws.bids) : "-"} / REST 买 ${top(rest.bids)}；WS 卖 ${ws ? top(ws.asks) : "-"} / REST 卖 ${top(rest.asks)}`);
    }
  }
}
console.log(`前 5 档比对：一致 ${ok}，不一致 ${bad}（比对瞬间有成交时可能短暂不一致）`);
feed.stop();

// 2) 真实深度下的补单成本与 Predict 挂单盈利上限
const m0 = markets[0]!;
const clob = await pm.clobMarket(m0.conditionId);
const meta = pmMetaFrom(m0, clob, "shares", Date.now());
console.log(`\n${m0.question}`);
console.log(`  CLOB 参数：tick ${toStr(meta.tickSize, 4)} 最小 ${toStr(meta.minOrderShares)} 份 撮合延迟 ${meta.takerDelayMs}ms 开赛清簿 ${meta.clearBookOnStart} 费率 ${meta.fee.kind === "polymarket" ? toStr(meta.fee.rate, 4) : "-"}`);
for (const [i, t] of m0.assetIds.entries()) {
  const book = await pm.book(t);
  const other = m0.outcomes[1 - i];
  for (const size of [10, 50, 200]) {
    const w = walkBuy(book.asks, fx(size), meta.fee, { maxPrice: fx("0.97") });
    const q = computeQuote({
      makerMeta: pfMeta(),
      hedgeMeta: meta,
      makerBook: { bids: [], asks: [], exchangeTs: Date.now(), receivedAt: Date.now(), source: "sim" },
      hedgeBook: book,
      targetShares: fx(size),
      capShares: fx(10_000),
      priceMode: "max",
      fixedPrice: null,
      minMakerPrice: null,
      maxMakerPrice: null,
      improveTicks: 1,
      minProfitPerShare: fx("0.01"),
      hedgeSlippage: fx("0.005"),
      riskBufferPerShare: fx("0.002"),
      fxBufferBps: 20,
      maxHedgePrice: fx("0.97"),
    });
    console.log(
      `  在 Polymarket 买 ${m0.outcomes[i]} ${size} 份：${w.complete ? "" : "（深度不足）"}均价含费 ${toStr(w.avgEffPrice, 4)}，最差档 ${toStr(w.worstPrice, 3)}，手续费 ${toStr(w.feeUsd, 4)} → Predict 买 ${other} 的盈利上限挂价 ${q.ok ? toStr(q.price, 3) + `（数量 ${toStr(q.size, 2)}）` : q.reason}`,
    );
  }
}

// 3) Predict 测试网订单簿与互补簿
const pf = new PredictPublic({ restUrl: "https://api-testnet.predict.fun", apiKey: null, timeoutMs: 15000 }, log);
const yes = await pf.orderbook(437);
const no = complementBook(yes, fx("0.01"));
console.log(`\nPredict 测试网 #437 Yes 簿：买一 ${yes.bids[0] ? toStr(yes.bids[0].price, 3) : "-"} 卖一 ${yes.asks[0] ? toStr(yes.asks[0].price, 3) : "-"}；推导 No 簿：买一 ${no.bids[0] ? toStr(no.bids[0].price, 3) : "-"} 卖一 ${no.asks[0] ? toStr(no.asks[0].price, 3) : "-"}`);
process.exit(0);

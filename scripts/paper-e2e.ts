/**
 * 端到端模拟交易（不需要任何凭证，不发真实订单）：
 * - 对冲侧：真实 Polymarket 电竞整场胜负盘，行情来自真实 WebSocket，模拟吃单逐档消耗真实深度、按真实费率计费；
 * - 挂单侧：Predict 盘口为【合成数据】（没有 Predict 主网 API Key 时拿不到真实盘口），
 *   由 Polymarket 价格加价差生成，用于驱动挂单与模拟成交；
 * - 真实计时器下运行完整引擎循环：挂单 → 模拟对手吃单 → 按净成交补单 → 重复推送 → 部分成交 → 停止挂单。
 * 运行：NODE_USE_ENV_PROXY=1 npx tsx scripts/paper-e2e.ts
 */
import pino from "pino";
import { KeyedSerialQueue } from "../src/core/async.js";
import { fx, ONE, roundToStep, toStr } from "../src/core/fixed.js";
import { bjTime, systemClock } from "../src/core/time.js";
import type { Book, Instrument, Outcome, VenueId } from "../src/core/types.js";
import { RiskSchema, StrategySchema } from "../src/config/schema.js";
import { Db } from "../src/db/db.js";
import { Repo } from "../src/db/repo.js";
import { AlertSink } from "../src/engine/alerts.js";
import { PairEngine } from "../src/engine/pairEngine.js";
import { reconcilePair } from "../src/engine/reconcile.js";
import { RiskManager } from "../src/engine/risk.js";
import { EventRouter } from "../src/engine/router.js";
import { BookStore, complementBook } from "../src/market/bookStore.js";
import { httpJson } from "../src/market/http.js";
import { parsePmMarket, pmMetaFrom, PolymarketBookFeed, PolymarketPublic } from "../src/market/polymarketData.js";
import { pairStatusJson } from "../src/monitor/status.js";
import { computeHedgeStats, statsSummary } from "../src/monitor/stats.js";
import { SimVenue } from "../src/venues/sim/simVenue.js";
import { pfMeta } from "../test/harness.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const clock = systemClock;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1) 选一个真实的 Polymarket 电竞整场胜负盘
const pm = new PolymarketPublic({ gammaUrl: "https://gamma-api.polymarket.com", clobUrl: "https://clob.polymarket.com", timeoutMs: 15000 }, log);
const now = Date.now();
const { data: events } = await httpJson<Record<string, unknown>[]>(
  `https://gamma-api.polymarket.com/events?tag_slug=esports&active=true&closed=false&limit=100&end_date_min=${new Date(now).toISOString()}&order=endDate&ascending=true`,
);
const cand = events
  .flatMap((e) => ((e.markets as Record<string, unknown>[]) ?? []).map((m) => ({ ...m, events: [{ id: e.id }] })))
  .map(parsePmMarket)
  .filter((m) => m.sportsMarketType === "moneyline" && m.acceptingOrders && m.gameStartTime && m.gameStartTime > now + 2 * 3600_000);
const m = cand[0];
if (!m) throw new Error("没有可用的电竞整场胜负盘");
const clob = await pm.clobMarket(m.conditionId);
const pmMeta = pmMetaFrom(m, clob, "shares", now);

// 2) 组装：真实 Polymarket 行情 + 合成 Predict 盘口 + 两个模拟交易所
const db = new Db(":memory:");
const repo = new Repo(db);
const books = new BookStore();
const queue = new KeyedSerialQueue();
const alerts = new AlertSink(repo, clock, log);
const riskCfg = RiskSchema.parse({ maxNakedSec: 20 });
const risk = new RiskManager(repo, clock, riskCfg);
const PF = { A: "pf-synthetic-A", B: "pf-synthetic-B" };
const PFKEY = "synthetic-predict-market";
books.setMeta(pmMeta);
books.setMeta(pfMeta({ marketKey: PFKEY, startTime: pmMeta.startTime }));
const keyOf = (t: string) => (t.startsWith("pf-") ? PFKEY : m.conditionId);
const venues: Record<VenueId, SimVenue> = {
  predict: new SimVenue({ venue: "predict", clock, books, marketKeyOf: keyOf, startingBalance: fx(1000), latencyMs: 120, settleDelayMs: 1500 }),
  polymarket: new SimVenue({ venue: "polymarket", clock, books, marketKeyOf: keyOf, startingBalance: fx(1000), latencyMs: 180, settleDelayMs: 3000 }),
};
const engines = new Map<string, PairEngine>();
const router = new EventRouter(repo, queue, engines, clock, log);
for (const v of ["predict", "polymarket"] as VenueId[]) venues[v].onEvent((e) => router.handle(e));

const inst = (venue: VenueId, outcome: Outcome): Instrument => ({
  venue,
  outcome,
  tokenId: venue === "predict" ? PF[outcome] : m.assetIds[outcome === "A" ? 0 : 1]!,
  marketKey: venue === "predict" ? PFKEY : m.conditionId,
  outcomeIndex: outcome === "A" ? 0 : 1,
  label: m.outcomes[outcome === "A" ? 0 : 1]!,
});
const engine = new PairEngine(
  {
    id: "e2e",
    makerVenue: "predict",
    makerOutcome: "A",
    strategy: StrategySchema.parse({ priceMode: "auto", improveTicks: 1, sizeShares: 50, minProfitPerShare: 0.01, requoteMinIntervalMs: 1500 }),
    risk: RiskSchema.parse({ maxNakedSec: 20 }),
    instruments: { predict: { A: inst("predict", "A"), B: inst("predict", "B") }, polymarket: { A: inst("polymarket", "A"), B: inst("polymarket", "B") } },
    marketKeys: { predict: PFKEY, polymarket: m.conditionId },
    startTime: pmMeta.startTime,
    tradeable: true,
    blockReason: null,
    labels: { A: m.outcomes[0]!, B: m.outcomes[1]! },
    makerOrderTtlSec: 900,
    makerRefreshBeforeSec: 180,
  },
  { repo, clock, venues, books, risk, alerts, log, queue },
);
engines.set("e2e", engine);

// 合成 Predict 盘口：A 的买一 = Polymarket A 买一 − 0.03，卖一 = Polymarket A 卖一 + 0.02（制造挂单可盈利的价差）
const synthPredict = () => {
  const a = books.getBook("polymarket", m.assetIds[0]!);
  if (!a || !a.bids[0] || !a.asks[0]) return;
  const tick = fx("0.01");
  const bid = roundToStep(a.bids[0].price - fx("0.03"), tick, "floor");
  const ask = roundToStep(a.asks[0].price + fx("0.02"), tick, "ceil");
  const yes: Book = { bids: [{ price: bid, size: fx(300) }], asks: [{ price: ask < ONE ? ask : fx("0.99"), size: fx(300) }], exchangeTs: Date.now(), receivedAt: Date.now(), source: "sim" };
  books.setBook("predict", PF.A, yes);
  books.setBook("predict", PF.B, complementBook(yes, tick));
};
const feed = new PolymarketBookFeed({ wsMarketUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market", resyncSec: 30 }, pm, books, log);
books.onUpdate((venue) => {
  if (venue === "polymarket") synthPredict();
  void engine.schedule("book");
});
feed.start();
feed.subscribe(m.assetIds);
const tick = setInterval(() => void engine.schedule("tick"), 1000);
// 合成盘口没有真实推送，定时刷新时间戳
const keepFresh = setInterval(synthPredict, 2000);

console.log(`\n【真实】Polymarket：${m.question}（开赛 ${bjTime(m.gameStartTime)}，${m.version}，费率 ${toStr(pmMeta.fee.kind === "polymarket" ? pmMeta.fee.rate : 0n, 3)}，最小 ${toStr(pmMeta.minOrderShares)} 份，撮合延迟 ${pmMeta.takerDelayMs}ms）`);
console.log(`【合成】Predict 盘口：由 Polymarket 价格加价差生成；挂单方向：Predict 买 ${m.outcomes[0]}，Polymarket 买 ${m.outcomes[1]} 对冲\n`);

await sleep(3000);
for (const v of ["predict", "polymarket"] as VenueId[]) risk.setBalances(v, await venues[v].getBalances());
await reconcilePair(engine, { repo, clock, venues, queue, alerts, log }, { cancelOrphans: true, tolerance: 0.05 });
await sleep(4000);

const step = async (title: string, fn: () => void | Promise<void>, waitMs = 6000) => {
  console.log(`\n=== ${title}`);
  await fn();
  await sleep(waitMs);
  const s = pairStatusJson(engine.snapshot(), Date.now()) as Record<string, unknown>;
  console.log(JSON.stringify({ 挂单状态: s.挂单状态, 挂单说明: s.挂单说明, 敞口状态: s.敞口状态, 净敞口: s.净敞口_份, 预计敞口: s.含在途补单的预计敞口_份, 盈亏: s.盈亏, 补单耗时: (s.补单耗时 as { 平均: string }).平均, 最近报价: s.最近报价 }, null, 1));
};

await step("初始挂单", () => {}, 1000);
await step("对手吃掉挂单 18 份（模拟）", () => void venues.predict.fillMaker(PF.A, fx(18)));
await step("重复推送同一批成交（WS 重放）", () => {
  venues.predict.faults.duplicateEvents = true;
  venues.predict.fillMaker(PF.A, fx(7));
});
venues.predict.faults.duplicateEvents = false;
await step("再成交 3 份（低于 Polymarket 最小 5 份，残余等待）", () => void venues.predict.fillMaker(PF.A, fx(3)), 4000);
await step("到停止挂单时间（模拟临近开赛）", () => {
  engine.pair.strategy.stopQuotingAt = new Date(Date.now() + 500).toISOString();
}, 4000);

const snap = pairStatusJson(engine.snapshot(), Date.now()) as Record<string, unknown>;
console.log("\n=== 订单");
console.table((snap.订单 as Record<string, unknown>[]).map((o) => ({ 时间: o.时间, 角色: o.角色, 平台: o.平台, 方向: o.方向, 价格: o.价格, 数量: o.数量, 已成交: o.已成交, 状态: o.状态 })));
console.log("=== 成交");
console.table((snap.成交 as Record<string, unknown>[]).map((f) => ({ 时间: f.时间, 角色: f.角色, 平台: f.平台, 方向: f.方向, 价格: f.价格, 净到账: f.净到账份额, 手续费: f.手续费, 状态: f.状态 })));
console.log("=== 持仓", JSON.stringify(snap.持仓));
console.log("=== 补单耗时", JSON.stringify(snap.补单耗时));
console.log("=== 告警", JSON.stringify(alerts.recent.map((a) => `${a.level} ${a.code} ${a.message}`)));
console.log("=== 补单统计（第一腿成交 → 第二腿成交）");
for (const [k, v] of Object.entries(statsSummary(computeHedgeStats(repo, "e2e")))) console.log(`  ${k}：${v}`);

clearInterval(tick);
clearInterval(keepFresh);
feed.stop();
await queue.drain();
process.exit(0);

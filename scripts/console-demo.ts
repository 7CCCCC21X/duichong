/**
 * 网页控制台离线演示（不访问网络、不需要任何凭证、不下真实订单）：
 * 用【合成】的两场比赛、合成订单簿和模拟交易所启动完整的机器人内核与控制台，
 * 方便在没有真实可交易比赛时先熟悉控制台。数据库在临时目录，退出即丢弃。
 *
 * 运行：npx tsx scripts/console-demo.ts   然后浏览器打开 http://127.0.0.1:8790/
 * 控制口令取环境变量 CONSOLE_TOKEN，未设置时用 demo-console-token-0000（仅演示用）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createContext, loadPairs, reconcileAll, refreshBalances, type AppContext } from "../src/app.js";
import { fx } from "../src/core/fixed.js";
import type { Book } from "../src/core/types.js";
import { AppConfigSchema, PairConfigSchema, type Secrets } from "../src/config/schema.js";
import type { LoadedConfig } from "../src/config/load.js";
import { startConsoleServer } from "../src/console/server.js";
import { ConsoleService } from "../src/console/service.js";
import { complementBook } from "../src/market/bookStore.js";
import { pairIdFor, type VerifyResult } from "../src/pairing/service.js";
import type { PairDefinition, Verification } from "../src/pairing/verify.js";
import type { SimVenue } from "../src/venues/sim/simVenue.js";
import { lv, pfMeta, pmMeta } from "../test/harness.js";

const PORT = Number(process.env.DEMO_PORT ?? 8790);
const TOKEN = process.env.CONSOLE_TOKEN ?? "demo-console-token-0000";
const dir = mkdtempSync(join(tmpdir(), "console-demo-"));
const log = pino({ level: process.env.LOG_LEVEL ?? "error" });

const RULES = `This market refers to the Counter-Strike 2 match between the two teams (BO3). If the match is cancelled or ends in a draw, this market will resolve 50-50. If the match is postponed beyond 7 days, it resolves 50-50. If a team forfeits before the match starts, 50-50; after the match starts, the opponent is the winner. Resolution source: hltv.org.（合成规则，仅演示）`;

// 合成盘口参数：pfBid/pfAsk 为 Predict A（Yes）买一/卖一，pmBid/pmAsk 为 Polymarket A 买一/卖一，vol 为 Polymarket 24 小时成交额
const MARKETS = [
  { pfId: 9001, cond: "0x" + "a1".repeat(32), labels: { A: "Team Alpha", B: "Team Bravo" }, status: "APPROVED" as const, startInH: 5, bo: 3, pfBid: 0.44, pfAsk: 0.49, pmBid: 0.5, pmAsk: 0.51, vol: 48_200 },
  { pfId: 9002, cond: "0x" + "b2".repeat(32), labels: { A: "Team Charlie", B: "Team Delta" }, status: "PENDING_REVIEW" as const, startInH: 9, bo: 3, pfBid: 0.3, pfAsk: 0.36, pmBid: 0.36, pmAsk: 0.37, vol: 15_900 },
  { pfId: 9003, cond: "0x" + "c3".repeat(32), labels: { A: "Team Echo", B: "Team Foxtrot" }, status: "APPROVED" as const, startInH: 52, bo: 3, pfBid: 0.55, pfAsk: 0.6, pmBid: 0.6, pmAsk: 0.61, vol: 3_100 },
  { pfId: 9004, cond: "0x" + "d4".repeat(32), labels: { A: "Team Golf", B: "Team Hotel" }, status: "APPROVED" as const, startInH: 3, bo: 1, pfBid: 0.52, pfAsk: 0.55, pmBid: 0.47, pmAsk: 0.48, vol: 92_700 },
];
const tok = (pfId: number) => ({ pf: { A: `demo-pf-${pfId}-A`, B: `demo-pf-${pfId}-B` }, pm: { A: `demo-pm-${pfId}-A`, B: `demo-pm-${pfId}-B` } });

function fakeVerify(m: (typeof MARKETS)[number]): VerifyResult {
  const t = tok(m.pfId);
  const def: PairDefinition = {
    predict: { marketId: m.pfId, categorySlug: `demo-cs2-${m.pfId}`, conditionId: "0x" + "cd".repeat(32), tokens: t.pf, indexSet: { A: 1, B: 2 }, isNegRisk: false, isYieldBearing: false, feeRateBps: 200, decimalPrecision: 2 },
    polymarket: { conditionId: m.cond, marketId: `demo-${m.pfId}`, eventId: null, version: "v1", tokens: t.pm, outcomeIndex: { A: 0, B: 1 }, negRisk: false },
    labels: m.labels,
    game: "cs2",
    marketType: "moneyline",
    bestOf: m.bo,
    startTime: Date.now() + m.startInH * 3600_000,
    rules: { predict: RULES, polymarket: m.status === "APPROVED" ? RULES : RULES.replace("7 days", "14 days"), predictHash: "p", polymarketHash: "q" },
    versionTag: "demo",
  };
  const warn = m.status !== "APPROVED";
  const checks = [
    { id: "type", label: "盘口类型", level: "pass", detail: "Predict SPORTS_MONEYLINE，Polymarket moneyline" },
    { id: "teams", label: "队伍对应", level: "pass", detail: "同序对应（队伍 ID 一致）" },
    { id: "bo", label: "赛制", level: "pass", detail: "Predict BO3，Polymarket BO3" },
    { id: "settle", label: "各结算情形合计兑付", level: warn ? "warn" : "pass", detail: warn ? "不一致：延期 7~14 天（合计 0.5 或 1.5）" : "所有情形合计兑付均为 1" },
  ];
  const scenarios = [
    { id: "normal", label: "正常完赛", predictLeg: "[1,0]/[0,1]", polymarketLeg: "[1,0]/[0,1]", total: "1", verdict: "consistent" },
    { id: "cancel", label: "比赛取消", predictLeg: "[0.5,0.5]", polymarketLeg: "[0.5,0.5]", total: "1", verdict: "consistent" },
    { id: "postpone", label: "延期 7~14 天", predictLeg: "[0.5,0.5]", polymarketLeg: warn ? "按原赛果" : "[0.5,0.5]", total: warn ? "0.5 或 1.5" : "1", verdict: warn ? "mismatch" : "consistent" },
  ];
  const clause = (days: number) => ({ cancelled: "50-50", tie: "50-50", postponeWindowHours: days * 24, postponedBeyond: "50-50", forfeitBeforeStart: "50-50", forfeitAfterStart: "winner", notCompleted: "unknown", resolutionSources: ["hltv.org"], nameDiscrepancyClause: false, mentionsSingleMap: false, normalizedHash: "x" });
  const verification = {
    status: m.status,
    reasons: warn ? ["各结算情形合计兑付：不一致：延期 7~14 天（合计 0.5 或 1.5）"] : [],
    checks,
    scenarios,
    clauses: { predict: clause(7), polymarket: clause(warn ? 14 : 7) },
    rulesHash: `demo-${m.pfId}`,
  } as unknown as Verification;
  const start = Date.now() + m.startInH * 3600_000;
  const pf = { id: m.pfId, title: "", question: `${m.labels.A} vs ${m.labels.B}`, description: RULES, categorySlug: `demo-cs2-${m.pfId}`, status: "REGISTERED", tradingStatus: "OPEN", isNegRisk: false, isYieldBearing: false, feeRateBps: 200, feeExponent: 1, decimalPrecision: 2, speedBump: null, marketType: "SPORTS_MONEYLINE", marketVariant: "ESPORTS_CS2", polymarketConditionIds: [m.cond], conditionId: "0x" + "cd".repeat(32), outcomes: [], line: null, gameNumber: null, raw: {} };
  const pm = { marketId: `demo-${m.pfId}`, conditionId: m.cond, slug: "", question: `Counter-Strike: ${m.labels.A} vs ${m.labels.B} (BO${m.bo})`, description: RULES, outcomes: [m.labels.A, m.labels.B], assetIds: [t.pm.A, t.pm.B], version: "v1", sportsMarketType: "moneyline", groupItemTitle: null, line: null, gameStartTime: start, eventStartTime: null, endDate: null, negRisk: false, acceptingOrders: true, active: true, closed: false, archived: false, orderMinSize: 5, tickSize: 0.01, secondsDelay: 0, feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0 }, resolutionSource: null, umaResolutionStatus: null, fallbackResolutionType: null, clearBookOnStart: true, updatedAt: null, eventId: null, event: null, raw: { volume24hrClob: m.vol, liquidityClob: m.vol / 3 } };
  return { pairId: pairIdFor(m.pfId, m.cond), pf, cat: { startsAt: start }, pm, def, verification } as unknown as VerifyResult;
}

/** 某个合成市场当前的订单簿（Predict 只给 Yes 簿，与真实接口一致）。 */
function marketBooks(m: (typeof MARKETS)[number], now: number): { yes: Book; pmA: Book } {
  const wiggle = (Math.floor(now / 20_000) % 2) * 0.01;
  const yes: Book = { bids: [lv((m.pfBid + wiggle).toFixed(2), 120), lv((m.pfBid - 0.01).toFixed(2), 300)], asks: [lv((m.pfAsk + wiggle).toFixed(2), 150), lv((m.pfAsk + 0.02).toFixed(2), 400)], exchangeTs: now, receivedAt: now, source: "sim" };
  const pmA: Book = { bids: [lv(m.pmBid.toFixed(2), 800), lv((m.pmBid - 0.01).toFixed(2), 1500)], asks: [lv(m.pmAsk.toFixed(2), 600), lv((m.pmAsk + 0.01).toFixed(2), 1200)], exchangeTs: now, receivedAt: now, source: "sim" };
  return { yes, pmA };
}

function books(ctx: AppContext): void {
  const now = Date.now();
  for (const m of MARKETS) {
    const t = tok(m.pfId);
    ctx.books.setMeta(pfMeta({ marketKey: String(m.pfId), startTime: now + m.startInH * 3600_000 }));
    ctx.books.setMeta(pmMeta({ marketKey: m.cond, startTime: now + m.startInH * 3600_000 }));
    const { yes, pmA } = marketBooks(m, now);
    ctx.books.setBook("predict", t.pf.A, yes);
    ctx.books.setBook("predict", t.pf.B, complementBook(yes, fx("0.01")));
    ctx.books.setBook("polymarket", t.pm.A, pmA);
    ctx.books.setBook("polymarket", t.pm.B, complementBook(pmA, fx("0.01")));
  }
}

const app = AppConfigSchema.parse({
  dataDir: dir,
  statusServer: { host: "127.0.0.1", port: PORT },
  strategy: { priceMode: "auto", sizeShares: 50, minProfitPerShare: 0.01 },
  simulation: { latencyMs: 120, settleDelayMs: 4000 },
});
const nul = null;
const secrets: Secrets = {
  liveTrading: false,
  predictApiKey: nul,
  predictSignerPrivateKey: nul,
  predictAccountAddress: nul,
  polymarketPrivateKey: nul,
  polymarketWalletAddress: nul,
  polymarketApiKey: nul,
  polymarketApiSecret: nul,
  polymarketApiPassphrase: nul,
  polymarketRelayerApiKey: nul,
  polymarketRelayerApiKeyAddress: nul,
  alertWebhookUrl: nul,
  statusToken: process.env.STATUS_TOKEN ?? nul,
  consoleToken: TOKEN,
};
const filePairs = [PairConfigSchema.parse({ id: "demo-alpha-bravo", predict: { marketId: 9001 }, polymarket: { conditionId: MARKETS[0]!.cond }, maker: { venue: "predict", outcome: "A" }, note: "合成数据演示" })];
const cfg: LoadedConfig = { app, pairs: filePairs, secrets, configPath: null, pairsPath: null };
const ctx = createContext(cfg, log);
ctx.pairing.verifyMarkets = async (pfId: number, cond: string) => {
  const m = MARKETS.find((x) => x.pfId === pfId && x.cond.toLowerCase() === cond.toLowerCase());
  if (!m) throw new Error(`演示环境只有合成市场 ${MARKETS.map((x) => `#${x.pfId}`).join("、")}`);
  return fakeVerify(m);
};
ctx.pairing.discover = async () => ({ results: MARKETS.map(fakeVerify), skipped: [{ reason: "非整场胜负盘（SPORTS_MAP_HANDICAP）", count: 3 }] });
const offline = async () => {
  throw new Error("演示环境不访问网络");
};
// 候选市场扫描用的 REST 订单簿：返回同样的合成盘口
Object.assign(ctx.pfPublic, {
  market: offline,
  category: offline,
  orderbooks: async (ids: number[]) => new Map(ids.flatMap((id) => MARKETS.filter((m) => m.pfId === id).map((m) => [id, marketBooks(m, Date.now()).yes] as [number, Book]))),
});
Object.assign(ctx.pmPublic, {
  marketsByConditionIds: offline,
  clobMarket: async () => null,
  book: async (token: string) => {
    const m = MARKETS.find((x) => tok(x.pfId).pm.A === token || tok(x.pfId).pm.B === token);
    if (!m) throw new Error("演示环境没有这个代币");
    const { pmA } = marketBooks(m, Date.now());
    return token === tok(m.pfId).pm.A ? pmA : complementBook(pmA, fx("0.01"));
  },
});
Object.assign(ctx.pmFeed, { subscribe: () => {}, unsubscribe: () => {} });
Object.defineProperty(ctx.pmFeed, "up", { get: () => true });
Object.assign(ctx.pfFeed, { subscribe: () => {}, unsubscribe: () => {} });
for (const v of ["predict", "polymarket"] as const) ctx.venues[v].onEvent((e) => ctx.router.handle(e));
books(ctx);
ctx.pmActivity.set(MARKETS[0]!.cond, { volume24h: MARKETS[0]!.vol, liquidity: MARKETS[0]!.vol / 3, updatedAt: Date.now() });
await loadPairs(ctx);
await refreshBalances(ctx);
await reconcileAll(ctx);
ctx.running = true;
const svc = new ConsoleService(ctx);
startConsoleServer(ctx, svc);

const timers = [
  setInterval(() => {
    books(ctx);
    for (const e of ctx.engines.values()) void e.schedule("tick");
  }, 1000),
  setInterval(() => void refreshBalances(ctx), 5000),
];
// 演示：挂单被对手吃掉一部分 → 在 Polymarket 补单
setTimeout(() => (ctx.venues.predict as SimVenue).fillMaker(tok(9001).pf.A, fx(18)), 3000);
setTimeout(() => (ctx.venues.predict as SimVenue).fillMaker(tok(9001).pf.A, fx(7)), 6000);

console.log(`\n控制台离线演示（合成数据）：http://127.0.0.1:${PORT}/\n控制口令：${TOKEN === "demo-console-token-0000" ? TOKEN + "（演示默认值）" : "已从环境变量 CONSOLE_TOKEN 读取"}\n第二场比赛（待审核）可以在“配对 → 新增配对”里用 Predict 市场 9002 与 conditionId ${MARKETS[1]!.cond} 添加。\nCtrl+C 退出（临时数据库会删除）。\n`);

const stop = () => {
  for (const t of timers) clearInterval(t);
  for (const e of ctx.engines.values()) e.dispose();
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

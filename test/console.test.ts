import { mkdtempSync, rmSync } from "node:fs";
import { request, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, loadPairs, reconcileAll, refreshBalances, resolvePairConfigs, type AppContext } from "../src/app.js";
import { fx } from "../src/core/fixed.js";
import { ManualClock } from "../src/core/time.js";
import type { Book } from "../src/core/types.js";
import { AppConfigSchema, effectiveStrategy, PairConfigSchema, type PairConfig, type Secrets } from "../src/config/schema.js";
import type { LoadedConfig } from "../src/config/load.js";
import { editPatch, OverrideStore } from "../src/console/overrides.js";
import { createConsoleHandler, hostAllowed } from "../src/console/server.js";
import { ConsoleError, ConsoleService, type Actor } from "../src/console/service.js";
import { Db } from "../src/db/db.js";
import { Repo } from "../src/db/repo.js";
import { complementBook } from "../src/market/bookStore.js";
import { pairIdFor, type VerifyResult } from "../src/pairing/service.js";
import type { PairDefinition, Verification } from "../src/pairing/verify.js";
import type { SimVenue } from "../src/venues/sim/simVenue.js";
import { lv, pfMeta, pmMeta } from "./harness.js";

const COND1 = "0x" + "11".repeat(32);
const COND2 = "0x" + "22".repeat(32);
const COND3 = "0x" + "33".repeat(32);
const ACTOR: Actor = { name: "测试员", ip: "127.0.0.1", source: "console" };
const TOKEN = "console-token-for-tests-0123456789";
const log = pino({ level: process.env.TEST_LOG ?? "silent" });

const dirs: string[] = [];
const contexts: AppContext[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) {
    for (const e of c.engines.values()) e.dispose();
    try {
      c.db.close();
    } catch {
      /* 已关闭 */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "console-test-"));
  dirs.push(d);
  return d;
}

const tokensOf = (pfId: number, cond: string) => ({ pf: { A: `pf${pfId}-A`, B: `pf${pfId}-B` }, pm: { A: `pm${cond.slice(2, 6)}-A`, B: `pm${cond.slice(2, 6)}-B` } });

/** 伪造的核对结果（不访问网络）。 */
function fakeVerify(pfId: number, cond: string, status: Verification["status"], now: number, version = "v1"): VerifyResult {
  const t = tokensOf(pfId, cond);
  const def: PairDefinition = {
    predict: { marketId: pfId, categorySlug: `cat-${pfId}`, conditionId: "0x" + "ee".repeat(32), tokens: t.pf, indexSet: { A: 1, B: 2 }, isNegRisk: false, isYieldBearing: false, feeRateBps: 200, decimalPrecision: 2 },
    polymarket: { conditionId: cond, marketId: `m${pfId}`, eventId: null, version: "v1", tokens: t.pm, outcomeIndex: { A: 0, B: 1 }, negRisk: false },
    labels: { A: "TeamA", B: "TeamB" },
    game: "cs2",
    marketType: "moneyline",
    bestOf: 3,
    startTime: now + 6 * 3600_000,
    rules: { predict: "规则原文 <script>alert(1)</script>", polymarket: "rules", predictHash: "p", polymarketHash: "q" },
    versionTag: version,
  };
  const level = status === "APPROVED" ? "pass" : status === "PENDING_REVIEW" ? "warn" : "fail";
  const verification = {
    status,
    reasons: status === "APPROVED" ? [] : ["延期窗口：Predict 168 小时，Polymarket 14 天"],
    checks: [{ id: "postpone", label: "延期窗口", level, detail: "Predict 168 小时，Polymarket 14 天" }],
    scenarios: [],
    clauses: { predict: {}, polymarket: {} },
    rulesHash: `hash-${pfId}-${version}`,
  } as unknown as Verification;
  return { pairId: pairIdFor(pfId, cond), pf: { id: pfId, question: `Predict #${pfId}` }, cat: {}, pm: { conditionId: cond, question: "TeamA vs TeamB" }, def, verification } as unknown as VerifyResult;
}

interface Env {
  dir: string;
  clock: ManualClock;
  /** 每个 Predict 市场当前的核对状态与规则版本（可在测试中修改，模拟规则变化） */
  markets: Map<number, { cond: string; status: Verification["status"]; version: string }>;
  filePairs: PairConfig[];
  secrets: Partial<Secrets>;
  live?: boolean;
}

function newEnv(over: Partial<Env> = {}): Env {
  return {
    dir: tmp(),
    clock: new ManualClock(),
    markets: new Map([
      [101, { cond: COND1, status: "APPROVED", version: "v1" }],
      [102, { cond: COND2, status: "PENDING_REVIEW", version: "v1" }],
      [103, { cond: COND3, status: "REJECTED", version: "v1" }],
    ]),
    filePairs: [PairConfigSchema.parse({ id: "p1", predict: { marketId: 101 }, polymarket: { conditionId: COND1 }, maker: { venue: "predict", outcome: "A" }, strategy: { sizeShares: 40 } })],
    secrets: { consoleToken: TOKEN },
    ...over,
  };
}

/** 构造一个不访问网络的运行环境（模拟交易所 + 伪造核对 + 手动行情）。 */
async function boot(env: Env): Promise<{ ctx: AppContext; svc: ConsoleService }> {
  const app = AppConfigSchema.parse({
    dataDir: env.dir,
    mode: env.live ? "live" : "simulation",
    strategy: { priceMode: "fixed", price: 0.46, minProfitPerShare: 0.01, hedgeSlippage: 0, riskBufferPerShare: 0, fxBufferBps: 0, requoteMinIntervalMs: 0, hedge: { coalesceMs: 0, retryIntervalMs: 777 } },
    simulation: { latencyMs: 0, settleDelayMs: 60_000 },
  });
  const secrets: Secrets = {
    liveTrading: false,
    predictApiKey: null,
    predictSignerPrivateKey: null,
    predictAccountAddress: null,
    polymarketPrivateKey: null,
    polymarketWalletAddress: null,
    polymarketApiKey: null,
    polymarketApiSecret: null,
    polymarketApiPassphrase: null,
    polymarketRelayerApiKey: null,
    polymarketRelayerApiKeyAddress: null,
    alertWebhookUrl: null,
    statusToken: null,
    consoleToken: null,
    ...env.secrets,
  };
  const cfg: LoadedConfig = { app, pairs: env.filePairs, secrets, configPath: null, pairsPath: null };
  const ctx = createContext(cfg, log, { clock: env.clock });
  contexts.push(ctx);
  // 不访问网络：核对用伪造结果，市场数据与订单簿手动设置，行情订阅为空操作
  ctx.pairing.verifyMarkets = async (pfId: number, cond: string) => {
    const m = env.markets.get(pfId);
    if (!m || m.cond.toLowerCase() !== cond.toLowerCase()) throw new Error(`未知市场 ${pfId}/${cond}`);
    return fakeVerify(pfId, m.cond, m.status, env.clock.now(), m.version);
  };
  const offline = async () => {
    throw new Error("测试环境不访问网络");
  };
  Object.assign(ctx.pfPublic, { market: offline, category: offline });
  Object.assign(ctx.pmPublic, { marketsByConditionIds: offline, clobMarket: offline });
  Object.assign(ctx.pmFeed, { subscribe: () => {}, unsubscribe: () => {} });
  Object.assign(ctx.pfFeed, { subscribe: () => {}, unsubscribe: () => {} });
  for (const v of ["predict", "polymarket"] as const) ctx.venues[v].onEvent((e) => ctx.router.handle(e));
  for (const [pfId, m] of env.markets) setMarket(ctx, pfId, m.cond);
  await loadPairs(ctx);
  await refreshBalances(ctx);
  await reconcileAll(ctx);
  await settle(ctx);
  return { ctx, svc: new ConsoleService(ctx) };
}

/** 设置市场约束与订单簿：Predict A 买一 0.45 / 卖一 0.50；Polymarket B 卖一 0.50（挂 0.46 + 对冲 0.50 有利润）。 */
function setMarket(ctx: AppContext, pfId: number, cond: string): void {
  const now = ctx.clock.now();
  const t = tokensOf(pfId, cond);
  ctx.books.setMeta(pfMeta({ marketKey: String(pfId) }));
  ctx.books.setMeta(pmMeta({ marketKey: cond }));
  const yes: Book = { bids: [lv("0.45", 100)], asks: [lv("0.50", 100)], exchangeTs: now, receivedAt: now, source: "sim" };
  ctx.books.setBook("predict", t.pf.A, yes);
  ctx.books.setBook("predict", t.pf.B, complementBook(yes, fx("0.01")));
  const pmA: Book = { bids: [lv("0.50", 500)], asks: [lv("0.51", 500)], exchangeTs: now, receivedAt: now, source: "sim" };
  ctx.books.setBook("polymarket", t.pm.A, pmA);
  ctx.books.setBook("polymarket", t.pm.B, complementBook(pmA, fx("0.01")));
}

async function settle(ctx: AppContext, rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
    await ctx.queue.drain();
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function tick(ctx: AppContext, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    for (const e of ctx.engines.values()) await e.schedule("tick");
    await settle(ctx);
  }
}

const openMakers = (ctx: AppContext, id: string) => ctx.repo.listOrders({ pairId: id, nonTerminal: true }).filter((o) => o.role === "MAKER");

async function expectConsoleError(p: Promise<unknown>, status: number, text?: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConsoleError);
    expect((e as ConsoleError).status).toBe(status);
    if (text) expect((e as Error).message).toMatch(text);
    return;
  }
  throw new Error("预期操作被拒绝，但成功了");
}

// =====================================================================
// 覆盖项合并
// =====================================================================

describe("参数覆盖项合并", () => {
  it("配对只覆盖一项补单参数时，不会把全局的其他补单参数冲回默认值（回归）", () => {
    const app = AppConfigSchema.parse({ strategy: { hedge: { retryIntervalMs: 777, coalesceMs: 5 } } });
    const pc = PairConfigSchema.parse({ id: "x", predict: { marketId: 1 }, polymarket: { conditionId: COND1 }, maker: { venue: "predict", outcome: "A" }, strategy: { hedge: { coalesceMs: 50 } } });
    expect(pc.strategy.hedge).toEqual({ coalesceMs: 50 });
    const s = effectiveStrategy(app, pc);
    expect(s.hedge.coalesceMs).toBe(50);
    expect(s.hedge.retryIntervalMs).toBe(777);
    expect(s.hedge.maxNormalAttempts).toBe(5);
  });

  it("按路径写入与删除覆盖项，清理空对象，拒绝原型污染路径", () => {
    const a = editPatch({ strategy: { sizeShares: 10, hedge: { coalesceMs: 5 } } }, { strategy: { price: null, hedge: { retryIntervalMs: 900 } } }, ["strategy.sizeShares"]);
    expect(a).toEqual({ strategy: { price: null, hedge: { coalesceMs: 5, retryIntervalMs: 900 } } });
    const b = editPatch(a, undefined, ["strategy.hedge.coalesceMs", "strategy.hedge.retryIntervalMs", "strategy.price"]);
    expect(b).toEqual({});
    expect(() => editPatch({}, { __proto__: { polluted: 1 } } as Record<string, unknown>, undefined)).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => editPatch({}, undefined, ["strategy.__proto__"])).toThrow(/非法字段/);
  });

  it("生效配置：配置文件配对 + 控制台新增 + 删除标记 + 同一市场冲突", () => {
    const db = new Db(":memory:");
    const store = new OverrideStore(new Repo(db));
    const file = [
      PairConfigSchema.parse({ id: "f1", predict: { marketId: 1 }, polymarket: { conditionId: COND1 }, maker: { venue: "predict", outcome: "A" } }),
      PairConfigSchema.parse({ id: "f2", predict: { marketId: 2 }, polymarket: { conditionId: COND2 }, maker: { venue: "predict", outcome: "A" } }),
    ];
    store.setPatch("f1", { enabled: false, strategy: { sizeShares: 7 } }, 1);
    store.setDeleted("f2", true, 1);
    store.addConsolePair(PairConfigSchema.parse({ id: "c1", predict: { marketId: 3 }, polymarket: { conditionId: COND3 }, maker: { venue: "polymarket", outcome: "B" } }), 1);
    store.addConsolePair(PairConfigSchema.parse({ id: "c2", predict: { marketId: 1 }, polymarket: { conditionId: "0x" + "44".repeat(32) }, maker: { venue: "predict", outcome: "A" } }), 1);
    const r = resolvePairConfigs(file, store);
    expect([...r.active.keys()]).toEqual(["f1", "c1"]);
    expect(r.active.get("f1")!.enabled).toBe(false);
    expect(r.active.get("f1")!.strategy.sizeShares).toBe(7);
    expect([...r.deleted.keys()]).toEqual(["f2"]);
    expect(r.origins.get("c1")).toBe("console");
    expect(r.errors.get("c2")).toMatch(/相同的市场/);
    db.close();
  });
});

// =====================================================================
// 控制操作
// =====================================================================

describe("控制台操作", () => {
  it("启动：配置文件中的配对加载、核对通过、按参数挂单", async () => {
    const env = newEnv();
    const { ctx } = await boot(env);
    const e = ctx.engines.get("p1")!;
    expect(e.pair.tradeable).toBe(true);
    expect(e.pair.strategy.hedge.retryIntervalMs).toBe(777);
    await tick(ctx);
    const m = openMakers(ctx, "p1");
    expect(m).toHaveLength(1);
    expect(m[0]!.size).toBe(fx(40));
  });

  it("暂停配对：撤挂单、不再挂单，暂停状态重启后仍然有效；恢复后重新挂单", async () => {
    const env = newEnv();
    const { ctx, svc } = await boot(env);
    await tick(ctx);
    expect(openMakers(ctx, "p1")).toHaveLength(1);
    await svc.pausePair(ACTOR, "p1", "看盘口不对");
    await tick(ctx, 2);
    expect(openMakers(ctx, "p1")).toHaveLength(0);
    expect(ctx.engines.get("p1")!.pair.blockReason).toBe("控制台已暂停：看盘口不对");
    ctx.db.close();

    const r2 = await boot(env);
    expect(r2.ctx.pairConfigs.get("p1")!.enabled).toBe(false);
    expect(r2.ctx.engines.get("p1")!.pair.tradeable).toBe(false);
    await tick(r2.ctx);
    expect(openMakers(r2.ctx, "p1")).toHaveLength(0);
    const res = (await r2.svc.resumePair(ACTOR, "p1")) as { tradeable: boolean };
    expect(res.tradeable).toBe(true);
    await tick(r2.ctx);
    expect(openMakers(r2.ctx, "p1")).toHaveLength(1);
    // 恢复后覆盖项里不再保留 enabled（配置文件本身是启用的）
    expect(r2.ctx.overrides.get("p1")!.patch).toEqual({});
  });

  it("修改配对参数：立即生效、重启后仍然有效、可恢复为配置文件值；不合理参数被拒绝并记录", async () => {
    const env = newEnv();
    const { ctx, svc } = await boot(env);
    const r = (await svc.updatePairParams(ACTOR, "p1", { set: { strategy: { sizeShares: 20, hedge: { coalesceMs: 30 } }, risk: { maxNakedSec: 9 } } })) as { changes: { key: string }[] };
    expect(r.changes.map((c) => c.key).sort()).toEqual(["risk.maxNakedSec", "strategy.hedge.coalesceMs", "strategy.sizeShares"]);
    const e = ctx.engines.get("p1")!;
    expect(e.pair.strategy.sizeShares).toBe(20);
    expect(e.pair.strategy.hedge.coalesceMs).toBe(30);
    expect(e.pair.strategy.hedge.retryIntervalMs).toBe(777);
    expect(e.pair.risk.maxNakedSec).toBe(9);
    await tick(ctx);
    expect(openMakers(ctx, "p1")[0]!.size).toBe(fx(20));

    await expectConsoleError(svc.updatePairParams(ACTOR, "p1", { set: { strategy: { priceMode: "fixed", price: null } } }), 400, /固定价模式/);
    await expectConsoleError(svc.updatePairParams(ACTOR, "p1", { set: { strategy: { sizeShres: 5 } } }), 400, /sizeShres|Unrecognized/);
    await expectConsoleError(svc.updatePairParams(ACTOR, "p1", { set: { strategy: { sizeShares: -1 } } }), 400);
    await expectConsoleError(svc.updatePairParams(ACTOR, "p1", { set: { strategy: { stopQuotingAt: "明天" } } }), 400, /无法解析/);
    await expectConsoleError(svc.updatePairParams(ACTOR, "p1", { set: { enabled: true } }), 400);
    expect(ctx.engines.get("p1")!.pair.strategy.sizeShares).toBe(20);
    ctx.db.close();

    const r2 = await boot(env);
    expect(r2.ctx.engines.get("p1")!.pair.strategy.sizeShares).toBe(20);
    await r2.svc.updatePairParams(ACTOR, "p1", { unset: ["strategy.sizeShares"] });
    expect(r2.ctx.engines.get("p1")!.pair.strategy.sizeShares).toBe(40);
    await r2.svc.resetPair(ACTOR, "p1");
    expect(r2.ctx.engines.get("p1")!.pair.risk.maxNakedSec).toBe(20);
    const audit = r2.ctx.repo.listAudit(50);
    expect(audit.filter((a) => a.action === "pair.params" && !a.ok).length).toBeGreaterThanOrEqual(5);
    expect(audit.find((a) => a.action === "pair.reset")!.actor).toBe("测试员");
  });

  it("修改全局参数：所有配对立即使用、全局风控同步、重启后仍然有效", async () => {
    const env = newEnv();
    const { ctx, svc } = await boot(env);
    await svc.updateGlobal(ACTOR, { set: { strategy: { hedge: { retryIntervalMs: 1234 } }, risk: { maxDailyLossUsd: 12 } } });
    expect(ctx.engines.get("p1")!.pair.strategy.hedge.retryIntervalMs).toBe(1234);
    expect(ctx.engines.get("p1")!.pair.strategy.sizeShares).toBe(40);
    expect(ctx.risk.global.maxDailyLossUsd).toBe(12);
    expect(ctx.fileApp.risk.maxDailyLossUsd).toBe(50);
    await expectConsoleError(svc.updateGlobal(ACTOR, { set: { strategy: { price: null } } }), 400, /固定价模式/);
    ctx.db.close();
    const r2 = await boot(env);
    expect(r2.ctx.risk.global.maxDailyLossUsd).toBe(12);
    expect(r2.ctx.engines.get("p1")!.pair.strategy.hedge.retryIntervalMs).toBe(1234);
    await r2.svc.updateGlobal(ACTOR, { unset: ["risk.maxDailyLossUsd"] });
    expect(r2.ctx.risk.global.maxDailyLossUsd).toBe(50);
  });

  it("全局停止：撤掉全部挂单、重启后仍保持；解除后恢复挂单", async () => {
    const env = newEnv();
    const { ctx, svc } = await boot(env);
    await tick(ctx);
    expect(openMakers(ctx, "p1")).toHaveLength(1);
    await svc.halt(ACTOR, "临时检查");
    await tick(ctx, 2);
    expect(openMakers(ctx, "p1")).toHaveLength(0);
    expect(ctx.risk.halted!.reason).toMatch(/临时检查/);
    ctx.db.close();
    const r2 = await boot(env);
    expect(r2.ctx.risk.halted).not.toBeNull();
    await r2.svc.resume(ACTOR);
    await tick(r2.ctx);
    expect(openMakers(r2.ctx, "p1")).toHaveLength(1);
  });

  it("审批门禁：只能批准待审核；未通过的不能批准；规则版本不一致拒绝；批准前重新核对", async () => {
    const env = newEnv();
    const { ctx, svc } = await boot(env);
    // 新增待审核与未通过的配对
    await svc.addPair(ACTOR, { predictMarketId: 102, polymarketConditionId: COND2, maker: { venue: "polymarket", outcome: "B" }, enabled: true });
    const id2 = pairIdFor(102, COND2);
    expect(ctx.engines.get(id2)!.pair.tradeable).toBe(false);
    const review = (svc.state() as { review: { id: string; status: string; labels: { A: string } | null; startTime: string | null }[] }).review;
    expect(review).toEqual([expect.objectContaining({ id: id2, status: "PENDING_REVIEW", labels: { A: "TeamA", B: "TeamB" } })]);
    expect(review[0]!.startTime).toMatch(/^\d{4}-\d{2}-\d{2} /);
    await expectConsoleError(svc.addPair(ACTOR, { predictMarketId: 103, polymarketConditionId: COND3, maker: { venue: "predict", outcome: "A" } }), 409, /未通过核对/);

    await expectConsoleError(svc.approve(ACTOR, "p1", "看过了", "hash-101-v1"), 409, /只能批准“待审核”/);
    await expectConsoleError(svc.approve(ACTOR, id2, "", "hash-102-v1"), 400, /批准理由/);
    await expectConsoleError(svc.approve(ACTOR, id2, "看过了", "hash-旧版本"), 409, /重新审阅/);
    // 审阅之后规则变了：批准前的重新核对发现版本不同，拒绝
    env.markets.get(102)!.version = "v2";
    await expectConsoleError(svc.approve(ACTOR, id2, "看过了", "hash-102-v1"), 409);
    expect(ctx.engines.get(id2)!.pair.tradeable).toBe(false);
    // 按新版本审阅后批准
    await svc.approve(ACTOR, id2, "延期窗口差异可接受", "hash-102-v2");
    expect(ctx.stored.get(id2)!.status).toBe("APPROVED_MANUAL");
    expect(ctx.engines.get(id2)!.pair.tradeable).toBe(true);
    expect(ctx.stored.get(id2)!.approvedBy).toMatch(/测试员/);
    // 规则再次变化：自动退回待审核、停止挂单
    env.markets.get(102)!.version = "v3";
    await svc.recheck(ACTOR, id2);
    expect(ctx.stored.get(id2)!.status).toBe("PENDING_REVIEW");
    expect(ctx.engines.get(id2)!.pair.tradeable).toBe(false);
  });

  it("新增配对：先核对；不能与已有配对共用市场；ID 不能重复；重启后仍然加载", async () => {
    const env = newEnv();
    const { ctx, svc } = await boot(env);
    const pv = (await svc.preview({ predictMarketId: 102, polymarketConditionId: COND2 })) as { canAdd: boolean; rulesHash: string; status: string };
    expect(pv.canAdd).toBe(true);
    expect(pv.status).toBe("PENDING_REVIEW");
    const pv1 = (await svc.preview({ predictMarketId: 101, polymarketConditionId: COND1 })) as { canAdd: boolean; conflict: string };
    expect(pv1.canAdd).toBe(false);
    expect(pv1.conflict).toMatch(/已被配对 p1 使用/);
    await expectConsoleError(svc.addPair(ACTOR, { predictMarketId: 101, polymarketConditionId: COND1, maker: { venue: "predict", outcome: "A" } }), 409, /已被配对 p1 使用/);
    await expectConsoleError(svc.addPair(ACTOR, { id: "p1", predictMarketId: 102, polymarketConditionId: COND2, maker: { venue: "predict", outcome: "A" } }), 409, /已存在/);
    await expectConsoleError(svc.addPair(ACTOR, { id: "bad id!", predictMarketId: 102, polymarketConditionId: COND2, maker: { venue: "predict", outcome: "A" } }), 400);
    await expectConsoleError(svc.addPair(ACTOR, { predictMarketId: 102, polymarketConditionId: COND2, maker: { venue: "predict", outcome: "A" }, rulesHash: "hash-不同" }), 409, /与预览时不同/);
    const r = (await svc.addPair(ACTOR, { id: "m2", predictMarketId: 102, polymarketConditionId: COND2, maker: { venue: "polymarket", outcome: "B" }, strategy: { sizeShares: 15 }, rulesHash: pv.rulesHash })) as { id: string; status: string };
    expect(r).toMatchObject({ id: "m2", status: "PENDING_REVIEW" });
    const e = ctx.engines.get("m2")!;
    expect(e.pair.makerVenue).toBe("polymarket");
    expect(e.pair.makerOutcome).toBe("B");
    expect(e.pair.strategy.sizeShares).toBe(15);
    expect(e.isReconciled()).toBe(false); // 主循环未运行，测试里不自动对账
    ctx.db.close();
    const r2 = await boot(env);
    expect(r2.ctx.pairOrigins.get("m2")).toBe("console");
    expect(r2.ctx.engines.get("m2")!.pair.strategy.sizeShares).toBe(15);
  });

  it("删除配对：有挂单、敞口或待结算成交时拒绝；暂停并处理完后可删除；重启后不加载；可恢复", async () => {
    const env = newEnv();
    const { ctx, svc } = await boot(env);
    await tick(ctx);
    expect(openMakers(ctx, "p1")).toHaveLength(1);
    await expectConsoleError(svc.deletePair(ACTOR, "p1", "p1"), 409, /未结束的订单/);
    await expectConsoleError(svc.deletePair(ACTOR, "p1", "p"), 400, /确认/);

    // 挂单成交 10 份 → 在 Polymarket 补单；成交未结算前不能删除
    (ctx.venues.predict as SimVenue).fillMaker(tokensOf(101, COND1).pf.A, fx(10));
    await settle(ctx);
    await tick(ctx, 2);
    expect(ctx.repo.listFills({ pairId: "p1" }).filter((f) => f.role === "HEDGE")).not.toHaveLength(0);
    await svc.pausePair(ACTOR, "p1", "准备删除");
    await tick(ctx, 2);
    expect(openMakers(ctx, "p1")).toHaveLength(0);
    await expectConsoleError(svc.deletePair(ACTOR, "p1", "p1"), 409, /尚未结算/);

    // 模拟结算完成
    for (const f of ctx.repo.listFills({ pairId: "p1" })) ctx.repo.upsertFill({ ...f, status: "SETTLED" });
    await svc.deletePair(ACTOR, "p1", "p1");
    expect(ctx.engines.has("p1")).toBe(false);
    expect(ctx.deletedPairs.has("p1")).toBe(true);
    const st = svc.state() as { pairs: unknown[]; deleted: { id: string }[] };
    expect(st.pairs).toHaveLength(0);
    expect(st.deleted.map((d) => d.id)).toEqual(["p1"]);
    ctx.db.close();

    const r2 = await boot(env);
    expect(r2.ctx.engines.has("p1")).toBe(false);
    expect(r2.ctx.deletedPairs.has("p1")).toBe(true);
    await r2.svc.restorePair(ACTOR, "p1");
    expect(r2.ctx.engines.has("p1")).toBe(true);
    // 恢复后沿用删除前的暂停状态
    expect(r2.ctx.engines.get("p1")!.pair.tradeable).toBe(false);
  });

  it("修改挂单方向：有挂单或敞口时拒绝；空闲时生效", async () => {
    const env = newEnv();
    const { ctx, svc } = await boot(env);
    await tick(ctx);
    await expectConsoleError(svc.updatePairParams(ACTOR, "p1", { set: { maker: { venue: "polymarket", outcome: "B" } } }), 409, /挂单方向/);
    await svc.pausePair(ACTOR, "p1", "");
    await tick(ctx, 2);
    const r = (await svc.updatePairParams(ACTOR, "p1", { set: { maker: { venue: "polymarket", outcome: "B" } } })) as { changes: { key: string }[] };
    expect(r.changes.map((c) => c.key).sort()).toEqual(["maker.outcome", "maker.venue"]);
    expect(ctx.engines.get("p1")!.pair.makerVenue).toBe("polymarket");
    expect(ctx.engines.get("p1")!.pair.makerOutcome).toBe("B");
  });

  it("保存的覆盖项无法解析（例如升级后字段改名）：配对仍加载但暂停；全局参数无法解析则停止新挂单", async () => {
    const env = newEnv();
    const { ctx, svc } = await boot(env);
    // 先撤掉挂单（模拟交易所在“重启”后不认识上一次的订单）
    await svc.pausePair(ACTOR, "p1", "");
    await tick(ctx, 2);
    expect(openMakers(ctx, "p1")).toHaveLength(0);
    ctx.repo.upsertPairOverride({ id: "p1", patch: { strategy: { 改名后的字段: 1 } }, deleted: false, now: 1 });
    ctx.repo.setKv("console.global", JSON.stringify({ risk: { notARiskKey: 1 } }), 1);
    ctx.db.close();

    const r2 = await boot(env);
    const e = r2.ctx.engines.get("p1")!;
    expect(e.pair.tradeable).toBe(false);
    expect(e.pair.blockReason).toMatch(/覆盖项无法解析/);
    expect(r2.ctx.risk.halted!.reason).toMatch(/全局参数无法解析/);
    // 不会下新挂单（库里那笔是上一次运行留下的，模拟交易所重启后已不认识它）
    const before = r2.ctx.repo.listOrders({ pairId: "p1" }).length;
    await tick(r2.ctx, 2);
    expect(r2.ctx.repo.listOrders({ pairId: "p1" }).length).toBe(before);
    // 改一个参数：覆盖项被合法数据重写，但仍保持暂停，需要人工明确恢复
    await r2.svc.updatePairParams(ACTOR, "p1", { set: { strategy: { sizeShares: 25 } } });
    expect(r2.ctx.engines.get("p1")!.pair.tradeable).toBe(false);
    expect(r2.ctx.configErrors.has("p1")).toBe(false);
    await r2.svc.resumePair(ACTOR, "p1");
    await r2.svc.updateGlobal(ACTOR, { set: { risk: { maxDailyLossUsd: 40 } } });
    await r2.svc.resume(ACTOR);
    await tick(r2.ctx);
    expect(openMakers(r2.ctx, "p1")[0]!.size).toBe(fx(25));
  });

  it("确认持仓基线需要输入配对 ID，且不能有未结束订单", async () => {
    const env = newEnv();
    const { ctx, svc } = await boot(env);
    await tick(ctx);
    await expectConsoleError(svc.acceptPositions(ACTOR, "p1", "x"), 400);
    await expectConsoleError(svc.acceptPositions(ACTOR, "p1", "p1"), 409, /未结束的订单/);
    await svc.pausePair(ACTOR, "p1", "");
    await tick(ctx, 2);
    const r = (await svc.acceptPositions(ACTOR, "p1", "p1")) as { reconcile: { ok: boolean } };
    expect(r.reconcile.ok).toBe(true);
  });
});

// =====================================================================
// HTTP：鉴权与防护
// =====================================================================

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => Record<string, unknown>;
}

function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) as Record<string, unknown> });
      });
    });
    r.on("error", reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

async function serve(env: Env, auth: { statusToken?: string | null; consoleToken?: string | null; allowedHosts?: string[] } = {}): Promise<{ ctx: AppContext; port: number; server: Server }> {
  const { ctx, svc } = await boot(env);
  const server = createServer(createConsoleHandler(ctx, svc, { statusToken: auth.statusToken ?? null, consoleToken: auth.consoleToken === undefined ? TOKEN : auth.consoleToken, allowedHosts: auth.allowedHosts ?? [] }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { ctx, port: (server.address() as AddressInfo).port, server };
}
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(port, "POST", path, { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("控制台 HTTP", () => {
  it("没有设置 CONSOLE_TOKEN 时只读：可查看状态，控制操作 403", async () => {
    const { port } = await serve(newEnv(), { consoleToken: null });
    const s = await call(port, "GET", "/api/session");
    expect(s.json()).toMatchObject({ role: "read", controlEnabled: false });
    const st = await call(port, "GET", "/api/console/state");
    expect(st.status).toBe(200);
    expect((st.json().control as { pairs: unknown[] }).pairs).toHaveLength(1);
    const h = await post(port, "/api/console/halt", { reason: "x" }, { "x-console-token": "anything" });
    expect(h.status).toBe(403);
    expect(h.json().error).toMatch(/CONSOLE_TOKEN/);
  });

  it("口令：只读口令只能看；控制口令只认请求头；错误口令被标记", async () => {
    const { port, ctx } = await serve(newEnv(), { statusToken: "status-token-abc" });
    expect((await call(port, "GET", "/api/console/state")).status).toBe(401);
    expect((await call(port, "GET", "/api/console/state", { headers: { "x-console-token": "status-token-abc" } })).status).toBe(200);
    expect((await call(port, "GET", "/api/status?token=status-token-abc")).status).toBe(200);
    expect((await call(port, "GET", "/api/console/state", { headers: { "x-console-token": TOKEN } })).status).toBe(200);
    const bad = await call(port, "GET", "/api/console/state", { headers: { "x-console-token": "wrong" } });
    expect(bad.status).toBe(401);
    expect(bad.headers["x-console-token-rejected"]).toBe("1");
    expect((await post(port, "/api/console/halt", { reason: "x" }, { "x-console-token": "status-token-abc" })).status).toBe(401);
    expect((await post(port, `/api/console/halt?token=${TOKEN}`, { reason: "x" })).status).toBe(401);
    expect(ctx.risk.halted).toBeNull();
    const ok = await post(port, "/api/console/halt", { reason: "测试" }, { "x-console-token": TOKEN, "x-console-actor": encodeURIComponent("值班A") });
    expect(ok.status).toBe(200);
    expect(ctx.risk.halted!.reason).toMatch(/值班A/);
    const a = ctx.repo.listAudit(5)[0]!;
    expect(a).toMatchObject({ action: "global.halt", actor: "值班A", ip: "127.0.0.1", ok: true });
    const bearer = await post(port, "/api/console/resume", {}, { authorization: `Bearer ${TOKEN}` });
    expect(bearer.status).toBe(200);
    expect(ctx.risk.halted).toBeNull();
  });

  it("跨站与非 JSON 请求被拒绝；Host 头校验防 DNS 重绑定", async () => {
    const { port } = await serve(newEnv(), { allowedHosts: ["bot.example.com"] });
    const tok = { "x-console-token": TOKEN };
    expect((await post(port, "/api/console/halt", {}, { ...tok, origin: "http://evil.example" })).status).toBe(403);
    expect((await post(port, "/api/console/halt", {}, { ...tok, origin: "null" })).status).toBe(403);
    expect((await call(port, "POST", "/api/console/halt", { headers: { ...tok, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await post(port, "/api/console/halt", {}, { ...tok, origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    expect((await call(port, "GET", "/api/session", { headers: { host: "attacker.example:8787" } })).status).toBe(403);
    expect((await call(port, "GET", "/api/session", { headers: { host: "localhost:9000" } })).status).toBe(200);
    expect((await call(port, "GET", "/api/session", { headers: { host: "bot.example.com" } })).status).toBe(200);
    expect(hostAllowed("[::1]:8787", [])).toBe(true);
    expect(hostAllowed("10.0.0.5", [])).toBe(true);
    expect(hostAllowed(undefined, [])).toBe(false);
  });

  it("连续输错口令 20 次后锁定", async () => {
    const { port } = await serve(newEnv());
    for (let i = 0; i < 20; i++) await call(port, "GET", "/api/session", { headers: { "x-console-token": `bad-${i}` } });
    const r = await call(port, "GET", "/api/console/state", { headers: { "x-console-token": TOKEN } });
    expect(r.status).toBe(429);
  });

  it("实盘模式下控制口令过短时不开放控制", async () => {
    const env = newEnv({ live: false });
    const { ctx, svc } = await boot(env);
    (ctx as { live: boolean }).live = true;
    const server = createServer(createConsoleHandler(ctx, svc, { statusToken: null, consoleToken: "short", allowedHosts: [] }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const s = (await call(port, "GET", "/api/session", { headers: { "x-console-token": "short" } })).json();
    expect(s.controlEnabled).toBe(false);
    expect(String(s.controlProblem)).toMatch(/至少 16/);
    expect((await post(port, "/api/console/halt", {}, { "x-console-token": "short" })).status).toBe(403);
  });

  it("页面与脚本：安全响应头、CSP、脚本语法正确；接口错误以 JSON 返回", async () => {
    const { port } = await serve(newEnv());
    const page = await call(port, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toMatch(/script-src 'self'/);
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.text).toContain("/console.js");
    const js = await call(port, "GET", "/console.js");
    expect(js.status).toBe(200);
    expect(() => new Script(js.text)).not.toThrow();
    expect(js.text).not.toMatch(/innerHTML\s*=/);
    expect((await call(port, "GET", "/console.css")).status).toBe(200);
    const nf = await post(port, "/api/console/pairs/none/pause", {}, { "x-console-token": TOKEN });
    expect(nf.status).toBe(404);
    expect(nf.json().error).toMatch(/不存在/);
    const bad = await call(port, "POST", "/api/console/halt", { headers: { "x-console-token": TOKEN, "content-type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
  });

  it("完整流程（HTTP）：预览 → 新增（待审核）→ 审阅 → 批准 → 参数 → 操作记录", async () => {
    const { port, ctx } = await serve(newEnv());
    const h = { "x-console-token": TOKEN };
    const pv = (await post(port, "/api/console/preview", { predictMarketId: 102, polymarketConditionId: COND2 }, h)).json();
    expect(pv.canAdd).toBe(true);
    const add = await post(port, "/api/console/pairs", { id: "m2", predictMarketId: 102, polymarketConditionId: COND2, maker: { venue: "predict", outcome: "A" }, rulesHash: pv.rulesHash }, h);
    expect(add.status).toBe(200);
    const rv = (await call(port, "GET", "/api/console/pairs/m2/review")).json();
    expect(rv.status).toBe("PENDING_REVIEW");
    expect((rv.rules as { predict: string }).predict).toContain("<script>");
    const ap = await post(port, "/api/console/pairs/m2/approve", { note: "已核对", rulesHash: rv.rulesHash }, h);
    expect(ap.status).toBe(200);
    expect(ctx.stored.get("m2")!.status).toBe("APPROVED_MANUAL");
    const pr = await post(port, "/api/console/pairs/m2/params", { set: { strategy: { sizeShares: 12 } } }, h);
    expect(pr.status).toBe(200);
    const cfg = (await call(port, "GET", "/api/console/pairs/m2/config")).json();
    expect((cfg.effective as { strategy: { sizeShares: number } }).strategy.sizeShares).toBe(12);
    expect((cfg.layers as { pairConsole: unknown }).pairConsole).toEqual({ strategy: { sizeShares: 12 } });
    const audit = (await call(port, "GET", "/api/console/audit")).json() as unknown as { action: string; ok: boolean }[];
    expect(audit.map((a) => a.action).slice(0, 3)).toEqual(["pair.params", "pair.approve", "pair.add"]);
    expect(audit.every((a) => a.ok)).toBe(true);
  });
});

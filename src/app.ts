import type { Logger } from "pino";
import { errMsg, KeyedSerialQueue } from "./core/async.js";
import { fx, stepFromDecimals, type Fx } from "./core/fixed.js";
import { systemClock, type Clock } from "./core/time.js";
import type { Instrument, Outcome, VenueId } from "./core/types.js";
import { VENUES } from "./core/types.js";
import { effectiveRisk, effectiveStrategy, type AppConfig, type PairConfig } from "./config/schema.js";
import { isLive, predictUrls, type LoadedConfig } from "./config/load.js";
import { applyGlobalPatch, applyPairPatch, OverrideStore, type GlobalPatch } from "./console/overrides.js";
import { Db } from "./db/db.js";
import { Repo } from "./db/repo.js";
import { AlertSink } from "./engine/alerts.js";
import { PairEngine, type ActivePair } from "./engine/pairEngine.js";
import { reconcilePair } from "./engine/reconcile.js";
import { RiskManager } from "./engine/risk.js";
import { EventRouter } from "./engine/router.js";
import { BookStore } from "./market/bookStore.js";
import { pmMetaFrom, PolymarketBookFeed, PolymarketPublic } from "./market/polymarketData.js";
import { pfMetaFrom, PredictBookFeed, PredictPublic } from "./market/predictData.js";
import { isTradeable, PairingService, type StoredPair, type VerifyResult } from "./pairing/service.js";
import type { PairDefinition } from "./pairing/verify.js";
import { PolymarketLiveVenue } from "./venues/polymarket/live.js";
import { PredictLiveVenue } from "./venues/predict/live.js";
import { SimVenue } from "./venues/sim/simVenue.js";
import type { TradingVenue } from "./venues/types.js";
import { polymarketGeoblock } from "./market/geoblock.js";
import { pmActivity } from "./monitor/opportunity.js";

export interface AppContext {
  /** cfg.app 为实际生效的全局配置（config.yaml + 控制台全局覆盖） */
  cfg: LoadedConfig;
  /** config.yaml 中的全局配置（未叠加控制台覆盖） */
  fileApp: AppConfig;
  live: boolean;
  log: Logger;
  clock: Clock;
  db: Db;
  repo: Repo;
  overrides: OverrideStore;
  books: BookStore;
  queue: KeyedSerialQueue;
  alerts: AlertSink;
  risk: RiskManager;
  pfPublic: PredictPublic;
  pmPublic: PolymarketPublic;
  pairing: PairingService;
  venues: Record<VenueId, TradingVenue>;
  engines: Map<string, PairEngine>;
  router: EventRouter;
  pfFeed: PredictBookFeed;
  pmFeed: PolymarketBookFeed;
  startedAt: number;
  /** 实际生效的配对配置（配置文件 + 控制台新增，叠加控制台覆盖项；不含已删除的） */
  pairConfigs: Map<string, PairConfig>;
  /** 配对来源：配置文件 / 控制台新增 */
  pairOrigins: Map<string, "file" | "console">;
  /** 控制台删除的配对（可在控制台恢复） */
  deletedPairs: Map<string, PairConfig>;
  /** 配置有误、未能加载的配对 */
  configErrors: Map<string, string>;
  stored: Map<string, StoredPair>;
  /** outcome token → 市场 key（模拟交易所用） */
  tokenToMarket: Map<string, string>;
  /** token → 使用它的配对（行情更新时触发评估） */
  tokenOwners: Map<string, Set<string>>;
  /** Polymarket 市场活跃度（conditionId → 24 小时成交额、挂单深度），随市场数据每分钟刷新 */
  pmActivity: Map<string, { volume24h: number | null; liquidity: number | null; updatedAt: number }>;
  /** 主循环已启动：之后新增的配对需要自行订阅成交推送并对账 */
  running: boolean;
}

/**
 * 计算实际生效的配对配置：配置文件中的配对与控制台新增的配对，叠加控制台覆盖项；
 * 跳过已删除的；同一个市场被两个配对使用时只保留先出现的（同一代币的持仓无法分属两个配对对账）。
 */
export function resolvePairConfigs(
  filePairs: PairConfig[],
  store: OverrideStore,
): { active: Map<string, PairConfig>; origins: Map<string, "file" | "console">; deleted: Map<string, PairConfig>; errors: Map<string, string> } {
  const active = new Map<string, PairConfig>();
  const origins = new Map<string, "file" | "console">();
  const deleted = new Map<string, PairConfig>();
  const errors = new Map<string, string>();
  const entries = new Map<string, ReturnType<OverrideStore["get"]>>();
  /** 覆盖项无法解析的配对：按基础配置加载但强制暂停挂单（引擎照常撤单、对账与处理敞口），并告警 */
  const unreadable = new Map<string, string>();
  for (const row of store.listIds()) {
    try {
      entries.set(row, store.get(row));
    } catch (e) {
      unreadable.set(row, errMsg(e));
    }
  }
  const fileIds = new Set(filePairs.map((p) => p.id));
  for (const [id, err] of unreadable) {
    const raw = store.getBaseOnly(id);
    const base = fileIds.has(id) ? filePairs.find((p) => p.id === id)! : (raw?.base ?? null);
    if (!base) {
      errors.set(id, `控制台保存的配置无法解析，且没有可用的基础配置，未加载：${err}`);
      continue;
    }
    origins.set(id, fileIds.has(id) ? "file" : "console");
    if (raw?.deleted) {
      deleted.set(id, base);
      continue;
    }
    active.set(id, { ...base, enabled: false });
    errors.set(id, `控制台保存的覆盖项无法解析，已按基础配置加载并暂停挂单（在控制台“参数”里清除覆盖后恢复）：${err}`);
  }
  for (const fp of filePairs) {
    if (unreadable.has(fp.id)) continue;
    const e = entries.get(fp.id);
    const pc = e ? applyPairPatch(fp, e.patch) : fp;
    origins.set(fp.id, "file");
    if (e?.deleted) deleted.set(fp.id, pc);
    else active.set(fp.id, pc);
  }
  for (const [id, e] of entries) {
    if (!e || fileIds.has(id) || !e.base || unreadable.has(id)) continue;
    const pc = applyPairPatch(e.base, e.patch);
    origins.set(id, "console");
    if (e.deleted) deleted.set(id, pc);
    else active.set(id, pc);
  }
  const byPf = new Map<number, string>();
  const byPm = new Map<string, string>();
  for (const [id, pc] of active) {
    const other = byPf.get(pc.predict.marketId) ?? byPm.get(pc.polymarket.conditionId.toLowerCase());
    if (other) {
      errors.set(id, `与配对 ${other} 使用了相同的市场，未加载`);
      active.delete(id);
      continue;
    }
    if (!pc.maker.outcome && !pc.maker.team) {
      errors.set(id, "maker 需要 outcome(A/B) 或 team");
      active.delete(id);
      continue;
    }
    byPf.set(pc.predict.marketId, id);
    byPm.set(pc.polymarket.conditionId.toLowerCase(), id);
  }
  return { active, origins, deleted, errors };
}

export function createContext(fileCfg: LoadedConfig, log: Logger, opts: { clock?: Clock } = {}): AppContext {
  const clock = opts.clock ?? systemClock;
  const live = isLive(fileCfg);
  const db = new Db(`${fileCfg.app.dataDir}/${live ? "live" : "sim"}.db`);
  const repo = new Repo(db);
  const overrides = new OverrideStore(repo);
  // 控制台全局覆盖（策略、风控）叠加在 config.yaml 之上；保存的数据无法解析时忽略并告警
  let globalPatch: GlobalPatch = {};
  let globalPatchError: string | null = null;
  try {
    globalPatch = overrides.getGlobal();
  } catch (e) {
    globalPatchError = errMsg(e);
  }
  const cfg: LoadedConfig = { ...fileCfg, app: applyGlobalPatch(fileCfg.app, globalPatch) };
  const books = new BookStore();
  const queue = new KeyedSerialQueue();
  const alerts = new AlertSink(repo, clock, log, cfg.secrets.alertWebhookUrl);
  const risk = new RiskManager(repo, clock, cfg.app.risk);
  const pf = predictUrls(cfg.app);
  const pfPublic = new PredictPublic({ restUrl: pf.rest, apiKey: cfg.app.predict.network === "mainnet" ? cfg.secrets.predictApiKey : null, timeoutMs: cfg.app.predict.requestTimeoutMs }, log);
  const pmPublic = new PolymarketPublic({ gammaUrl: cfg.app.polymarket.gammaUrl, clobUrl: cfg.app.polymarket.clobUrl, timeoutMs: cfg.app.polymarket.requestTimeoutMs }, log);
  const pairing = new PairingService(pfPublic, pmPublic, repo, clock, log, alerts);
  const engines = new Map<string, PairEngine>();
  const router = new EventRouter(repo, queue, engines, clock, log);
  const pfFeed = new PredictBookFeed({ wsUrl: pf.ws, apiKey: cfg.app.predict.network === "mainnet" ? cfg.secrets.predictApiKey : null, pollIntervalMs: cfg.app.predict.pollIntervalMs }, pfPublic, books, log);
  const pmFeed = new PolymarketBookFeed({ wsMarketUrl: cfg.app.polymarket.wsMarketUrl, resyncSec: cfg.app.polymarket.bookResyncSec }, pmPublic, books, log);
  books.setRefresher((venue, tokenId) => {
    if (venue === "polymarket") void pmFeed.refresh(tokenId);
    else {
      for (const p of ctxRef.ctx?.stored.values() ?? []) {
        if (p.def && (p.def.predict.tokens.A === tokenId || p.def.predict.tokens.B === tokenId)) void pfFeed.refresh(p.def.predict.marketId);
      }
    }
  });
  const ctxRef: { ctx: AppContext | null } = { ctx: null };
  const tokenToMarket = new Map<string, string>();
  const venues = live
    ? createLiveVenues(cfg, log, () => [...(ctxRef.ctx?.pairConfigs.values() ?? [])].map((p) => p.polymarket.conditionId))
    : createSimVenues(cfg, clock, books, (t) => tokenToMarket.get(t) ?? null);
  const resolved = resolvePairConfigs(cfg.pairs, overrides);
  const ctx: AppContext = {
    cfg,
    fileApp: fileCfg.app,
    live,
    log,
    clock,
    db,
    repo,
    overrides,
    books,
    queue,
    alerts,
    risk,
    pfPublic,
    pmPublic,
    pairing,
    venues,
    engines,
    router,
    pfFeed,
    pmFeed,
    startedAt: clock.now(),
    pairConfigs: resolved.active,
    pairOrigins: resolved.origins,
    deletedPairs: resolved.deleted,
    configErrors: resolved.errors,
    stored: new Map(),
    tokenToMarket,
    tokenOwners: new Map(),
    pmActivity: new Map(),
    running: false,
  };
  ctxRef.ctx = ctx;
  if (globalPatchError) {
    // 忽略控制台全局参数可能放宽风控（例如控制台调低过亏损上限），因此停止新挂单，等人工在控制台检查
    risk.halt(`控制台保存的全局参数无法解析：${globalPatchError}`);
    alerts.raise("critical", "CONSOLE_OVERRIDE_INVALID", `控制台保存的全局参数无法解析，已按 config.yaml 运行并停止新挂单；请在控制台“全局参数”里检查并保存一次后解除停止：${globalPatchError}`);
  }
  for (const [id, err] of resolved.errors) alerts.raise("critical", "PAIR_CONFIG_INVALID", `配对 ${id}：${err}`, { pairId: id });
  return ctx;
}

function createSimVenues(cfg: LoadedConfig, clock: Clock, books: BookStore, marketKeyOf: (t: string) => string | null): Record<VenueId, TradingVenue> {
  const sim = cfg.app.simulation;
  const mk = (venue: VenueId) =>
    new SimVenue({ venue, clock, books, marketKeyOf, startingBalance: fx(sim.startingBalanceUsd), latencyMs: sim.latencyMs, makerFillRatio: sim.makerFillRatio, settleDelayMs: sim.settleDelayMs });
  return { polymarket: mk("polymarket"), predict: mk("predict") };
}

function createLiveVenues(cfg: LoadedConfig, log: Logger, markets: () => string[]): Record<VenueId, TradingVenue> {
  const s = cfg.secrets;
  if (!s.polymarketPrivateKey) throw new Error("实盘缺少 POLYMARKET_PRIVATE_KEY");
  if (!s.predictSignerPrivateKey) throw new Error("实盘缺少 PREDICT_SIGNER_PRIVATE_KEY");
  if (cfg.app.predict.network === "mainnet" && !s.predictApiKey) throw new Error("Predict 主网实盘缺少 PREDICT_API_KEY");
  const pf = predictUrls(cfg.app);
  const polymarket = new PolymarketLiveVenue({
    privateKey: s.polymarketPrivateKey,
    walletAddress: s.polymarketWalletAddress,
    credentials: s.polymarketApiKey && s.polymarketApiSecret && s.polymarketApiPassphrase ? { apiKey: s.polymarketApiKey, secret: s.polymarketApiSecret, passphrase: s.polymarketApiPassphrase } : null,
    wsUserUrl: cfg.app.polymarket.wsUserUrl,
    orderHeartbeat: cfg.app.polymarket.orderHeartbeat,
    markets,
    log: log.child({ venue: "polymarket" }),
  });
  const predict = new PredictLiveVenue({
    restUrl: pf.rest,
    wsUrl: pf.ws,
    apiKey: cfg.app.predict.network === "mainnet" ? s.predictApiKey : null,
    signerPrivateKey: s.predictSignerPrivateKey,
    predictAccount: s.predictAccountAddress,
    chain: cfg.app.predict.network,
    selfTradePrevention: cfg.app.predict.selfTradePrevention,
    jwtRefreshBeforeSec: cfg.app.predict.jwtRefreshBeforeExpirySec,
    timeoutMs: cfg.app.predict.requestTimeoutMs,
    log: log.child({ venue: "predict" }),
  });
  return { polymarket, predict };
}

/** 由核对得到的配对定义 + 用户配置构造引擎使用的配对。 */
export function buildActivePair(ctx: AppContext, pc: PairConfig, stored: StoredPair): ActivePair | null {
  const def = stored.def as PairDefinition | null;
  if (!def) return null;
  let makerOutcome: Outcome | null = pc.maker.outcome ?? null;
  if (!makerOutcome && pc.maker.team) {
    const t = pc.maker.team.toLowerCase();
    if (def.labels.A.toLowerCase() === t) makerOutcome = "A";
    else if (def.labels.B.toLowerCase() === t) makerOutcome = "B";
  }
  if (!makerOutcome) throw new Error(`配对 ${pc.id}：maker.team "${pc.maker.team}" 与队伍 ${def.labels.A}/${def.labels.B} 都不匹配`);
  const strategy = effectiveStrategy(ctx.cfg.app, pc);
  const risk = effectiveRisk(ctx.cfg.app, pc);
  const inst = (venue: VenueId, outcome: Outcome): Instrument => ({
    venue,
    outcome,
    tokenId: venue === "predict" ? def.predict.tokens[outcome] : def.polymarket.tokens[outcome],
    marketKey: venue === "predict" ? String(def.predict.marketId) : def.polymarket.conditionId,
    outcomeIndex: venue === "predict" ? def.predict.indexSet[outcome] : def.polymarket.outcomeIndex[outcome],
    label: def.labels[outcome],
  });
  const tr = isTradeable(stored);
  return {
    id: pc.id,
    makerVenue: pc.maker.venue,
    makerOutcome,
    strategy,
    risk,
    instruments: {
      predict: { A: inst("predict", "A"), B: inst("predict", "B") },
      polymarket: { A: inst("polymarket", "A"), B: inst("polymarket", "B") },
    },
    marketKeys: { predict: String(def.predict.marketId), polymarket: def.polymarket.conditionId },
    startTime: def.startTime,
    tradeable: pc.enabled && tr.ok,
    blockReason: !pc.enabled ? disabledReason(ctx, pc.id) : tr.reason,
    labels: def.labels,
    makerOrderTtlSec: pc.maker.venue === "predict" ? ctx.cfg.app.predict.makerOrderTtlSec : 0,
    makerRefreshBeforeSec: ctx.cfg.app.predict.makerRefreshBeforeSec,
  };
}

function disabledReason(ctx: AppContext, id: string): string {
  const cfgErr = ctx.configErrors.get(id);
  if (cfgErr) return cfgErr;
  let patch: { enabled?: boolean; pausedReason?: string } | undefined;
  try {
    patch = ctx.overrides.get(id)?.patch;
  } catch {
    patch = undefined;
  }
  if (patch?.enabled === false) return `控制台已暂停${patch.pausedReason ? `：${patch.pausedReason}` : ""}`;
  return "配置文件中已禁用（enabled: false）";
}

/** 刷新两边市场约束（状态、费率、tick、开赛时间）。 */
export async function refreshMeta(ctx: AppContext, def: PairDefinition): Promise<void> {
  const now = ctx.clock.now();
  try {
    const pf = await ctx.pfPublic.market(def.predict.marketId);
    const cat = await ctx.pfPublic.category(pf.categorySlug);
    ctx.books.setMeta(pfMetaFrom(pf, cat.startsAt, now));
    const v = ctx.venues.predict as TradingVenue & { registerMarket?: (k: string, p: { isNegRisk: boolean; isYieldBearing: boolean; feeRateBps: number; marketId: number }) => void };
    v.registerMarket?.(String(pf.id), { isNegRisk: pf.isNegRisk, isYieldBearing: pf.isYieldBearing, feeRateBps: pf.feeRateBps, marketId: pf.id });
  } catch (e) {
    ctx.log.warn({ err: errMsg(e), market: def.predict.marketId }, "刷新 Predict 市场数据失败");
  }
  try {
    const [pm] = await ctx.pmPublic.marketsByConditionIds([def.polymarket.conditionId]);
    if (pm) {
      const clob = await ctx.pmPublic.clobMarket(def.polymarket.conditionId);
      ctx.books.setMeta(pmMetaFrom(pm, clob, ctx.cfg.app.polymarket.minOrderMode, now));
      ctx.pmActivity.set(def.polymarket.conditionId, { ...pmActivity(pm.raw), updatedAt: now });
    }
  } catch (e) {
    ctx.log.warn({ err: errMsg(e), market: def.polymarket.conditionId }, "刷新 Polymarket 市场数据失败");
  }
}

/** 加载全部生效的配对；单个配对失败只告警，不影响其他配对。 */
export async function loadPairs(ctx: AppContext): Promise<void> {
  for (const pc of ctx.pairConfigs.values()) {
    try {
      await loadPair(ctx, pc);
    } catch (e) {
      ctx.alerts.raise("critical", "PAIR_LOAD_FAILED", `配对 ${pc.id} 加载失败：${errMsg(e)}`, { pairId: pc.id });
    }
  }
}

/**
 * 加载一个配对：核对（可传入刚核对过的结果）→ 落库 → 构造引擎 → 订阅行情。
 * 引擎总会构造（只要拿到配对定义），未通过核对门禁时引擎不挂单，只做对账与敞口处理。
 */
export async function loadPair(ctx: AppContext, pc: PairConfig, pre?: VerifyResult): Promise<StoredPair> {
  if (ctx.engines.has(pc.id)) throw new Error(`配对 ${pc.id} 已在运行`);
  const r = pre ?? (await ctx.pairing.verifyMarkets(pc.predict.marketId, pc.polymarket.conditionId));
  r.pairId = pc.id;
  const stored = ctx.pairing.save(r);
  ctx.stored.set(pc.id, stored);
  ctx.log.info({ pair: pc.id, status: stored.status, reasons: stored.verification?.reasons }, "配对核对结果");
  if (stored.status === "PENDING_REVIEW") ctx.alerts.raise("warn", "PAIR_PENDING_REVIEW", `配对 ${pc.id} 待人工审核：${stored.statusReason ?? ""}`, { pairId: pc.id });
  if (stored.status === "REJECTED") ctx.alerts.raise("warn", "PAIR_REJECTED", `配对 ${pc.id} 未通过核对：${stored.statusReason ?? ""}`, { pairId: pc.id });
  const def = stored.def;
  if (!def) return stored;
  for (const o of ["A", "B"] as Outcome[]) {
    ctx.tokenToMarket.set(def.predict.tokens[o], String(def.predict.marketId));
    ctx.tokenToMarket.set(def.polymarket.tokens[o], def.polymarket.conditionId);
  }
  await refreshMeta(ctx, def);
  const ap = buildActivePair(ctx, pc, stored);
  if (!ap) return stored;
  const engine = new PairEngine(ap, { repo: ctx.repo, clock: ctx.clock, venues: ctx.venues, books: ctx.books, risk: ctx.risk, alerts: ctx.alerts, log: ctx.log, queue: ctx.queue });
  ctx.engines.set(pc.id, engine);
  for (const v of VENUES) {
    for (const o of ["A", "B"] as Outcome[]) {
      const t = ap.instruments[v][o].tokenId;
      if (!ctx.tokenOwners.has(t)) ctx.tokenOwners.set(t, new Set());
      ctx.tokenOwners.get(t)!.add(pc.id);
    }
  }
  ctx.pmFeed.subscribe([def.polymarket.tokens.A, def.polymarket.tokens.B]);
  ctx.pfFeed.subscribe({ marketId: def.predict.marketId, tokens: { 1: def.predict.tokens.A, 2: def.predict.tokens.B }, tick: () => stepFromDecimals(def.predict.decimalPrecision) });
  return stored;
}

/** 卸载一个配对（删除配对时调用；调用方负责确认没有挂单、敞口与待结算成交）。 */
export function unloadPair(ctx: AppContext, id: string): void {
  ctx.engines.get(id)?.dispose();
  ctx.engines.delete(id);
  ctx.risk.removePair(id);
  const def = ctx.stored.get(id)?.def ?? null;
  ctx.stored.delete(id);
  ctx.pairConfigs.delete(id);
  for (const [t, owners] of ctx.tokenOwners) {
    owners.delete(id);
    if (owners.size === 0) ctx.tokenOwners.delete(t);
  }
  if (def) {
    const unused = (t: string) => !ctx.tokenOwners.has(t);
    const pmTokens = [def.polymarket.tokens.A, def.polymarket.tokens.B].filter(unused);
    if (pmTokens.length) ctx.pmFeed.unsubscribe(pmTokens);
    if (unused(def.predict.tokens.A) && unused(def.predict.tokens.B)) ctx.pfFeed.unsubscribe(def.predict.marketId);
  }
}

/** 按最新的生效配置与核对结果重建配对参数，交给运行中的引擎（在该配对的串行队列中替换）。 */
export async function applyPairConfig(ctx: AppContext, id: string): Promise<void> {
  const pc = ctx.pairConfigs.get(id);
  const stored = ctx.stored.get(id);
  const engine = ctx.engines.get(id);
  if (!pc || !stored || !engine) return;
  const ap = buildActivePair(ctx, pc, stored);
  if (!ap) return;
  await ctx.queue.run(id, () => engine.updatePair(ap));
  void engine.schedule("config");
}

/**
 * 主循环启动后新增（或恢复）的配对：确保成交推送覆盖新市场，并补做该配对的对账。
 * 实盘需要重新订阅时会短暂断开成交推送，恢复后统一对账（含新配对），这里不再单独对账。
 */
export async function activateNewPair(ctx: AppContext, id: string): Promise<{ resubscribed: boolean }> {
  const engine = ctx.engines.get(id);
  if (!engine) return { resubscribed: false };
  let resubscribed = false;
  if (ctx.live) {
    const pfVenue = ctx.venues.predict as TradingVenue & { recheckApprovals?: () => Promise<void> };
    await pfVenue.recheckApprovals?.();
    await refreshBalances(ctx);
    resubscribed = ctx.venues.polymarket.ensureMarkets?.([engine.pair.marketKeys.polymarket]) ?? false;
  } else {
    await refreshBalances(ctx);
  }
  if (!resubscribed) {
    await reconcilePair(engine, { repo: ctx.repo, clock: ctx.clock, venues: ctx.venues, queue: ctx.queue, alerts: ctx.alerts, log: ctx.log }, { cancelOrphans: ctx.cfg.app.risk.cancelOrphanOrders, tolerance: ctx.cfg.app.risk.positionTolerance });
  }
  return { resubscribed };
}

export async function reconcileAll(ctx: AppContext): Promise<void> {
  for (const engine of ctx.engines.values()) {
    try {
      await reconcilePair(engine, { repo: ctx.repo, clock: ctx.clock, venues: ctx.venues, queue: ctx.queue, alerts: ctx.alerts, log: ctx.log }, { cancelOrphans: ctx.cfg.app.risk.cancelOrphanOrders, tolerance: ctx.cfg.app.risk.positionTolerance });
    } catch (e) {
      ctx.alerts.raise("critical", "RECONCILE_FAILED", `对账失败：${errMsg(e)}`, { pairId: engine.id });
    }
  }
}

export async function refreshBalances(ctx: AppContext): Promise<void> {
  for (const v of VENUES) {
    try {
      const b = await ctx.venues[v].getBalances();
      ctx.risk.setBalances(v, b);
      ctx.risk.unblock(v, "balance-fetch");
    } catch (e) {
      ctx.risk.block(v, "balance-fetch", `余额查询失败：${errMsg(e)}`, ctx.clock.now() + 60_000);
      ctx.log.warn({ venue: v, err: errMsg(e) }, "余额查询失败");
    }
    syncVenueIssues(ctx, v);
  }
}

/** 把平台报告的持续性问题（如授权缺失）同步为风控阻断；问题消失后自动解除。 */
export function syncVenueIssues(ctx: AppContext, v: VenueId): void {
  const issues = ctx.venues[v].issues?.() ?? [];
  const codes = new Set(issues.map((i) => `issue:${i.code}`));
  for (const i of issues) {
    if (!ctx.risk.venueBlocked(v)) ctx.alerts.raise("critical", i.code.toUpperCase(), `${v}：${i.message}`, { dedupeMs: 600_000 });
    ctx.risk.block(v, `issue:${i.code}`, i.message);
  }
  for (const b of ctx.risk.listBlocks()) if (b.venue === v && b.code.startsWith("issue:") && !codes.has(b.code)) ctx.risk.unblock(v, b.code);
}

/** 启动机器人主循环。返回停止函数。 */
export async function runBot(ctx: AppContext): Promise<() => Promise<void>> {
  const { log } = ctx;
  log.info({ mode: ctx.live ? "实盘" : "模拟", pairs: ctx.pairConfigs.size, predictNetwork: ctx.cfg.app.predict.network }, "启动");
  if (!ctx.live) log.warn("当前为模拟模式：使用真实公开行情，订单与成交均为模拟。实盘需 mode: live 且 LIVE_TRADING=true");

  for (const v of VENUES) ctx.venues[v].onEvent((e) => ctx.router.handle(e));
  ctx.router.onStream((venue, up, reason) => {
    if (!up) {
      ctx.risk.block(venue, "stream", `订单事件流断开 ${reason ?? ""}`);
      ctx.alerts.raise("warn", "STREAM_DOWN", `${venue} 订单事件流断开，暂停依赖该平台的挂单`, { dedupeMs: 30_000 });
    } else {
      ctx.risk.unblock(venue, "stream");
      ctx.alerts.raise("info", "STREAM_UP", `${venue} 订单事件流恢复，先对账再恢复挂单`, { dedupeMs: 30_000 });
      void reconcileAll(ctx);
    }
  });

  ctx.pfFeed.onMarketEvent = (marketId, kind) => {
    for (const p of ctx.stored.values()) {
      if (p.def?.predict.marketId !== marketId) continue;
      if (kind === "marketChanged") void recheckPair(ctx, p.id);
      else void refreshMeta(ctx, p.def).then(() => ctx.engines.get(p.id)?.schedule("market-status"));
    }
  };

  if (ctx.live) {
    // 部署地区自检：Polymarket 官方地理限制接口；被限制时阻断 Polymarket 交易（读行情不受影响）
    const geo = await polymarketGeoblock();
    if (geo.ok && geo.blocked) {
      ctx.risk.block("polymarket", "geoblock", `本机出口 IP ${geo.ip}（${geo.country}${geo.region ? `-${geo.region}` : ""}）被 Polymarket 地理限制`);
      ctx.alerts.raise("critical", "GEOBLOCK", `本机出口 IP ${geo.ip}（${geo.country}）被 Polymarket 地理限制，已阻断 Polymarket 交易`);
    } else if (geo.ok) {
      log.info({ ip: geo.ip, country: geo.country, region: geo.region }, "Polymarket 地理限制检查通过");
    } else {
      log.warn({ err: geo.error }, "Polymarket 地理限制检查失败（请手动确认部署地区资格）");
    }
  }
  await Promise.all(VENUES.map((v) => ctx.venues[v].start()));
  ctx.pmFeed.start();
  ctx.pfFeed.start();
  await loadPairs(ctx);
  // Predict 授权检查需要先登记市场类型（是否 negRisk / yield-bearing）
  const pfVenue = ctx.venues.predict as TradingVenue & { recheckApprovals?: () => Promise<void> };
  await pfVenue.recheckApprovals?.();
  await refreshBalances(ctx);
  // 等行情首帧
  await new Promise((r) => setTimeout(r, 1500));
  await reconcileAll(ctx);

  // 行情更新 → 评估（每个配对合并处理）；模拟模式下顺便检查挂单是否被穿价成交
  ctx.books.onUpdate((venue, tokenId) => {
    if (!ctx.live) (ctx.venues[venue] as SimVenue).onBookUpdate(tokenId);
    for (const id of ctx.tokenOwners.get(tokenId) ?? []) void ctx.engines.get(id)?.schedule("book");
  });

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => void) => {
    const t = setInterval(fn, ms);
    t.unref();
    timers.push(t);
  };
  let lastBalanceRefresh = ctx.clock.now();
  every(1000, () => {
    if (!ctx.live) for (const v of VENUES) (ctx.venues[v] as SimVenue).expireOrders();
    for (const e of ctx.engines.values()) void e.schedule("tick");
    // 余额刷新间隔可在控制台修改，按当前配置判断
    const now = ctx.clock.now();
    if (now - lastBalanceRefresh >= Math.max(5, ctx.cfg.app.risk.balanceRefreshSec) * 1000) {
      lastBalanceRefresh = now;
      void refreshBalances(ctx);
    }
  });
  every(60_000, () => {
    for (const p of ctx.stored.values()) if (p.def) void refreshMeta(ctx, p.def);
  });
  every(5 * 60_000, () => {
    for (const p of ctx.stored.values()) void recheckPair(ctx, p.id);
  });
  every(15_000, () => ctx.router.retryParked());
  ctx.running = true;

  return async () => {
    for (const t of timers) clearInterval(t);
    log.info("停止中：撤销挂单");
    for (const e of ctx.engines.values()) {
      const makers = ctx.repo.listOrders({ pairId: e.id, nonTerminal: true }).filter((o) => o.role === "MAKER");
      for (const o of makers) {
        try {
          await ctx.venues[o.venue].cancel([{ venueOrderId: o.venueOrderId, hash: o.hash }]);
          ctx.repo.updateOrder(o.id, { status: "CANCEL_REQUESTED" }, ctx.clock.now());
        } catch (err) {
          log.warn({ err: errMsg(err), order: o.id }, "退出时撤单失败");
        }
      }
      e.dispose();
    }
    ctx.pmFeed.stop();
    ctx.pfFeed.stop();
    await Promise.all(VENUES.map((v) => ctx.venues[v].stop()));
    await ctx.queue.drain();
    ctx.db.close();
  };
}

/** 重新核对配对；规则/队伍/赛程变化时暂停新挂单并按核对结果更新。失败只记日志（定时任务用）。 */
export async function recheckPair(ctx: AppContext, id: string): Promise<void> {
  try {
    await recheckPairStrict(ctx, id);
  } catch (e) {
    ctx.log.warn({ pair: id, err: errMsg(e) }, "重新核对失败");
  }
}

/** 重新核对配对，失败时抛出（控制台用）。返回最新核对结果与是否变化。 */
export async function recheckPairStrict(ctx: AppContext, id: string): Promise<{ stored: StoredPair; changed: boolean } | null> {
  const engine = ctx.engines.get(id);
  const pc = ctx.pairConfigs.get(id);
  const prev = ctx.stored.get(id);
  if (!pc || !prev) return null;
  const r = await ctx.pairing.verifyMarkets(pc.predict.marketId, pc.polymarket.conditionId);
  r.pairId = id;
  const changed = prev.rulesHash !== r.verification.rulesHash;
  const stored = ctx.pairing.save(r);
  // 配对可能在核对期间被删除
  if (!ctx.pairConfigs.has(id)) return { stored, changed };
  ctx.stored.set(id, stored);
  if (!engine && stored.def) {
    // 之前拿不到配对定义（例如队伍无法对应），现在可以了：构造引擎（仍受核对门禁约束）
    ctx.stored.delete(id);
    const s2 = await loadPair(ctx, pc, r);
    if (ctx.running) await activateNewPair(ctx, id);
    return { stored: s2, changed };
  }
  if (engine) {
    const ap = buildActivePair(ctx, pc, stored);
    if (ap) {
      await ctx.queue.run(id, () => engine.updatePair(ap));
      if (changed) ctx.log.warn({ pair: id, status: stored.status }, "配对信息变化，已按最新核对结果更新");
      void engine.schedule("recheck");
    }
  }
  return { stored, changed };
}

export type { Fx };

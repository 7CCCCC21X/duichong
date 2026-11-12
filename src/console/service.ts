import { z } from "zod";
import { activateNewPair, applyPairConfig, buildActivePair, loadPair, recheckPairStrict, unloadPair, type AppContext } from "../app.js";
import { errMsg } from "../core/async.js";
import { abs, fx, toStr, type Fx } from "../core/fixed.js";
import { bjTime } from "../core/time.js";
import { isTerminalFill, type Outcome } from "../core/types.js";
import { applyStrategyPatch, effectiveRisk, effectiveStrategy, PairConfigSchema, RiskPatchStrictSchema, StrategyPatchStrictSchema, type PairConfig } from "../config/schema.js";
import { computePositions, netExposure } from "../engine/ledger.js";
import { acceptPositionsAsBaseline, reconcilePair, type ReconcileReport } from "../engine/reconcile.js";
import { computeHedgeStats, statsSummary } from "../monitor/stats.js";
import { isTradeable, pairIdFor, type StoredPair, type VerifyResult } from "../pairing/service.js";
import type { PairDefinition, Verification } from "../pairing/verify.js";
import { fieldLabel, RISK_FIELDS, STRATEGY_FIELDS } from "./fields.js";
import { applyGlobalPatch, applyPairPatch, editPatch, flatten, GlobalPatchSchema, MakerPatchSchema, PairPatchSchema, riskProblems, strategyProblems, type PairPatch } from "./overrides.js";

/** 操作人：控制台请求头里的名字（自报，仅用于审计记录）与来源 IP。 */
export interface Actor {
  name: string;
  ip: string | null;
  source: "console" | "cli";
}

export class ConsoleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ConsoleError";
  }
}

const PAIR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COND_RE = /^0x[0-9a-fA-F]{64}$/;

const zodMsg = (e: z.ZodError): string => e.issues.map((i) => `${i.path.length ? `${i.path.join(".")}：` : ""}${i.message}`).join("；");

function parseOr400<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new ConsoleError(`参数有误：${zodMsg(r.error)}`);
  return r.data;
}

export const ParamsInputSchema = z
  .object({
    set: z
      .object({
        maker: MakerPatchSchema.optional(),
        strategy: z.record(z.unknown()).optional(),
        risk: z.record(z.unknown()).optional(),
        note: z.string().max(500).optional(),
      })
      .strict()
      .optional(),
    unset: z
      .array(z.string().regex(/^(maker|note|strategy\.[A-Za-z]+(\.[A-Za-z]+)?|risk\.[A-Za-z]+)$/, "只能恢复 maker、note、strategy.*、risk.* 字段"))
      .max(100)
      .optional(),
  })
  .strict();

export const GlobalInputSchema = z
  .object({
    set: z.object({ strategy: z.record(z.unknown()).optional(), risk: z.record(z.unknown()).optional() }).strict().optional(),
    unset: z
      .array(z.string().regex(/^(strategy\.[A-Za-z]+(\.[A-Za-z]+)?|risk\.[A-Za-z]+)$/))
      .max(100)
      .optional(),
  })
  .strict();

export const AddInputSchema = z
  .object({
    id: z.string().regex(PAIR_ID_RE, "配对 ID 只能包含字母、数字、点、下划线、连字符（最长 64，首字符为字母或数字）").optional(),
    predictMarketId: z.coerce.number().int().positive(),
    polymarketConditionId: z.string().regex(COND_RE, "conditionId 应为 0x 加 64 位十六进制"),
    maker: MakerPatchSchema,
    strategy: StrategyPatchStrictSchema.optional(),
    risk: RiskPatchStrictSchema.optional(),
    enabled: z.boolean().default(true),
    note: z.string().max(500).optional(),
    /** 预览核对时的规则版本：与添加时重新核对的结果不同则拒绝（防止审阅后规则变化） */
    rulesHash: z.string().optional(),
  })
  .strict();

export const PreviewInputSchema = z
  .object({ predictMarketId: z.coerce.number().int().positive(), polymarketConditionId: z.string().regex(COND_RE, "conditionId 应为 0x 加 64 位十六进制") })
  .strict();

interface IdleCheck {
  ok: boolean;
  reasons: string[];
  net: Fx;
  openOrders: number;
  pendingFills: number;
}

function reportSummary(r: ReconcileReport): Record<string, unknown> {
  return {
    pairId: r.pairId,
    ok: r.ok,
    ordersChecked: r.ordersChecked,
    ordersUpdated: r.ordersUpdated,
    fillsSeen: r.fillsSeen,
    orphanOrders: r.orphanOrders.length,
    positionMismatches: r.positionMismatches,
    errors: r.errors,
  };
}

/** 核对结果的展示形式（检查项、结算情形矩阵、规则条款与原文）。 */
function reviewOf(id: string, status: string, statusReason: string | null, def: PairDefinition | null, v: Verification | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status,
    statusReason,
    rulesHash: v?.rulesHash ?? null,
    def: def
      ? {
          labels: def.labels,
          startTime: bjTime(def.startTime),
          game: def.game,
          bestOf: def.bestOf,
          marketType: def.marketType,
          predict: { marketId: def.predict.marketId, categorySlug: def.predict.categorySlug, isNegRisk: def.predict.isNegRisk, isYieldBearing: def.predict.isYieldBearing, feeRateBps: def.predict.feeRateBps },
          polymarket: { conditionId: def.polymarket.conditionId, version: def.polymarket.version, negRisk: def.polymarket.negRisk },
        }
      : null,
    checks: v?.checks ?? [],
    scenarios: v?.scenarios ?? [],
    clauses: v?.clauses ?? null,
    rules: def ? { predict: def.rules.predict, polymarket: def.rules.polymarket } : null,
    ...extra,
  };
}

/**
 * 控制台的查询与操作。所有改变配置或交易状态的操作都写审计记录；
 * 修改配置的操作在同一个串行队列里执行，避免两个请求交错（全局暂停/恢复不排队，任何时候立即生效）。
 * 安全边界：不提供绕过配对核对门禁的操作；只能批准“待审核”的配对；删除配对前必须没有未结束订单、敞口与待结算成交。
 */
export class ConsoleService {
  private discovering: Promise<Record<string, unknown>> | null = null;
  private discoverCache: { at: number; data: Record<string, unknown> } | null = null;
  private statsCache = new Map<string, { at: number; data: Record<string, unknown> }>();

  constructor(private readonly ctx: AppContext) {}

  // =====================================================================
  // 查询
  // =====================================================================

  meta(): Record<string, unknown> {
    return { strategyFields: STRATEGY_FIELDS, riskFields: RISK_FIELDS, live: this.ctx.live };
  }

  /** 控制状态（每个配对的开关、核对状态、能否删除/改方向等）。 */
  state(): Record<string, unknown> {
    const ctx = this.ctx;
    return {
      live: ctx.live,
      halted: ctx.risk.halted ? { reason: ctx.risk.halted.reason, since: bjTime(ctx.risk.halted.since) } : null,
      pairs: [...ctx.pairConfigs.values()].map((pc) => this.pairState(pc)),
      deleted: [...ctx.deletedPairs.values()].map((pc) => ({
        id: pc.id,
        origin: ctx.pairOrigins.get(pc.id) ?? "console",
        predictMarketId: pc.predict.marketId,
        polymarketConditionId: pc.polymarket.conditionId,
        labels: ctx.pairing.get(pc.id)?.def?.labels ?? null,
      })),
      configErrors: [...ctx.configErrors].map(([id, error]) => ({ id, error })),
      review: this.reviewList(),
    };
  }

  private pairState(pc: PairConfig): Record<string, unknown> {
    const ctx = this.ctx;
    const stored = ctx.stored.get(pc.id) ?? null;
    const engine = ctx.engines.get(pc.id);
    const patch = this.patchOf(pc.id);
    const idle = this.idleCheck(pc.id, true);
    const m = engine?.currentMode;
    const { enabled: _e, pausedReason: _p, ...paramPatch } = patch;
    return {
      id: pc.id,
      origin: ctx.pairOrigins.get(pc.id) ?? "file",
      enabled: pc.enabled,
      pausedByConsole: patch.enabled === false,
      pausedReason: patch.pausedReason ?? null,
      verifyStatus: stored?.status ?? null,
      verifyReason: stored?.statusReason ?? null,
      rulesHash: stored?.rulesHash ?? null,
      tradeable: engine?.pair.tradeable ?? false,
      blockReason: engine ? engine.pair.blockReason : stored ? "核对未拿到配对定义（例如队伍无法对应），未构造引擎" : "尚未加载",
      labels: stored?.def?.labels ?? null,
      startTime: stored?.def ? bjTime(stored.def.startTime) : null,
      makerVenue: engine?.pair.makerVenue ?? pc.maker.venue,
      makerOutcome: engine?.pair.makerOutcome ?? pc.maker.outcome ?? null,
      predictMarketId: pc.predict.marketId,
      polymarketConditionId: pc.polymarket.conditionId,
      mode: m?.mode ?? null,
      modeReason: m?.reason ?? null,
      exposureMode: m?.exposureMode ?? null,
      netExposure: toStr(idle.net, 4),
      openOrders: idle.openOrders,
      pendingFills: idle.pendingFills,
      inEmergency: engine?.inEmergency ?? false,
      deleteBlockers: idle.reasons,
      hasParamOverrides: Object.keys(paramPatch).length > 0,
      note: pc.note ?? null,
    };
  }

  /** 需要处理的核对结果：已配置但未通过的配对，以及发现后待审核、尚未添加的配对。 */
  private reviewList(): Record<string, unknown>[] {
    const ctx = this.ctx;
    const out: Record<string, unknown>[] = [];
    for (const p of ctx.repo.listPairSummaries(["PENDING_REVIEW", "REJECTED", "PAUSED_RECHECK"])) {
      const configured = ctx.pairConfigs.has(p.id);
      if (!configured && p.status !== "PENDING_REVIEW") continue;
      out.push({ id: p.id, status: p.status, reason: p.statusReason, configured, labels: p.labels, startTime: p.startTime !== null ? bjTime(p.startTime) : null });
    }
    return out;
  }

  review(id: string): Record<string, unknown> {
    const p = this.ctx.pairing.get(id);
    if (!p) throw new ConsoleError(`配对 ${id} 没有核对记录`, 404);
    return reviewOf(p.id, p.status, p.statusReason, p.def, p.verification, { approvedBy: p.approvedBy, approvedRulesHash: p.approvedRulesHash, configured: this.ctx.pairConfigs.has(id) });
  }

  /** 配对参数：生效值与各层来源（全局配置文件、控制台全局、配对配置、控制台配对）。 */
  pairConfig(id: string): Record<string, unknown> {
    const ctx = this.ctx;
    const pc = ctx.pairConfigs.get(id);
    if (!pc) throw new ConsoleError(`配对 ${id} 不存在或已删除`, 404);
    const base = this.baseOf(id)!;
    const engine = ctx.engines.get(id);
    return {
      id,
      origin: ctx.pairOrigins.get(id) ?? "file",
      labels: ctx.stored.get(id)?.def?.labels ?? null,
      effective: {
        enabled: pc.enabled,
        maker: { venue: engine?.pair.makerVenue ?? pc.maker.venue, outcome: engine?.pair.makerOutcome ?? pc.maker.outcome ?? null },
        strategy: effectiveStrategy(ctx.cfg.app, pc),
        risk: effectiveRisk(ctx.cfg.app, pc),
        note: pc.note ?? null,
      },
      layers: {
        globalFile: { strategy: ctx.fileApp.strategy, risk: ctx.fileApp.risk },
        globalConsole: this.globalPatch(),
        pairBase: { enabled: base.enabled, maker: base.maker, strategy: base.strategy, risk: base.risk, note: base.note ?? null },
        pairConsole: this.patchOf(id),
      },
      directionChange: this.idleCheck(id, false),
    };
  }

  globalConfig(): Record<string, unknown> {
    const ctx = this.ctx;
    return {
      effective: { strategy: ctx.cfg.app.strategy, risk: ctx.cfg.app.risk },
      file: { strategy: ctx.fileApp.strategy, risk: ctx.fileApp.risk },
      console: this.globalPatch(),
    };
  }

  audit(limit = 200): Record<string, unknown>[] {
    return this.ctx.repo.listAudit(Math.min(Math.max(1, limit), 1000)).map((a) => ({ ...a, time: bjTime(a.ts, true) }));
  }

  stats(hours: number | null): Record<string, unknown> {
    const now = this.ctx.clock.now();
    const key = String(hours ?? "all");
    const hit = this.statsCache.get(key);
    if (hit && now - hit.at < 10_000) return hit.data;
    const since = hours ? now - hours * 3600_000 : 0;
    const ids = [...new Set([...this.ctx.pairConfigs.keys(), ...this.ctx.deletedPairs.keys()])];
    const data = { window: hours ? `最近 ${hours} 小时` : "全部", pairs: Object.fromEntries(ids.map((id) => [id, statsSummary(computeHedgeStats(this.ctx.repo, id, since))])) };
    this.statsCache.set(key, { at: now, data });
    return data;
  }

  // =====================================================================
  // 全局停止 / 恢复（不排队，立即生效）
  // =====================================================================

  halt(actor: Actor, reason: string): Promise<unknown> {
    return this.audited(actor, "global.halt", null, { reason }, async () => {
      const r = reason.trim() || "未填写原因";
      const already = this.ctx.risk.halted;
      this.ctx.risk.halt(`控制台（${actor.name}）：${r}`);
      if (!already) this.ctx.alerts.raise("critical", "CONSOLE_HALT", `控制台停止全部新挂单（${actor.name}）：${r}；已有挂单将撤销，补单与风控继续运行`);
      this.scheduleAll("console-halt");
      return { halted: this.ctx.risk.halted, alreadyHalted: already !== null };
    });
  }

  resume(actor: Actor): Promise<unknown> {
    return this.audited(actor, "global.resume", null, {}, async () => {
      const prev = this.ctx.risk.halted;
      this.ctx.risk.resume();
      if (prev) this.ctx.alerts.raise("warn", "CONSOLE_RESUME", `控制台解除全局停止新挂单（${actor.name}），原停止原因：${prev.reason}`);
      this.scheduleAll("console-resume");
      return { previous: prev };
    });
  }

  // =====================================================================
  // 配对：暂停 / 恢复 / 参数 / 方向
  // =====================================================================

  pausePair(actor: Actor, id: string, reason: string): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "pair.pause", id, { reason }, async () => {
        this.requireActive(id);
        const patch: PairPatch = { ...this.patchOf(id), enabled: false };
        if (reason.trim()) patch.pausedReason = reason.trim();
        else delete patch.pausedReason;
        await this.savePatch(id, patch);
        this.ctx.alerts.raise("warn", "CONSOLE_PAIR_PAUSED", `配对 ${id} 已由 ${actor.name} 暂停挂单${reason.trim() ? `：${reason.trim()}` : ""}`, { pairId: id });
        return { enabled: false };
      }),
    );
  }

  resumePair(actor: Actor, id: string): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "pair.resume", id, {}, async () => {
        this.requireActive(id);
        const base = this.baseOf(id)!;
        const patch: PairPatch = { ...this.patchOf(id) };
        delete patch.pausedReason;
        // 配置本身是启用的就去掉覆盖项；配置里禁用的由控制台显式启用
        if (base.enabled) delete patch.enabled;
        else patch.enabled = true;
        await this.savePatch(id, patch);
        const e = this.ctx.engines.get(id);
        return { enabled: true, tradeable: e?.pair.tradeable ?? false, blockReason: e?.pair.blockReason ?? null };
      }),
    );
  }

  /** 修改配对参数（策略、风控、挂单方向、备注）。set 写入覆盖项，unset 删除覆盖项（恢复为下一层的值）。 */
  updatePairParams(actor: Actor, id: string, input: unknown): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "pair.params", id, input, async () => {
        const inp = parseOr400(ParamsInputSchema, input);
        this.requireActive(id);
        const cur = this.patchOf(id);
        let next: PairPatch;
        try {
          next = editPatch(cur, inp.set as Record<string, unknown> | undefined, inp.unset);
        } catch (e) {
          throw new ConsoleError(errMsg(e));
        }
        return this.applyPairPatchChange(id, cur, next);
      }),
    );
  }

  /** 清除控制台对该配对的参数覆盖（策略、风控、方向、备注），恢复为配置文件 / 新增时的值；暂停状态保留。 */
  resetPair(actor: Actor, id: string): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "pair.reset", id, {}, async () => {
        this.requireActive(id);
        const cur = this.patchOf(id);
        const next: PairPatch = {};
        if (cur.enabled !== undefined) next.enabled = cur.enabled;
        if (cur.pausedReason !== undefined) next.pausedReason = cur.pausedReason;
        return this.applyPairPatchChange(id, cur, next);
      }),
    );
  }

  private async applyPairPatchChange(id: string, cur: PairPatch, next: PairPatch): Promise<Record<string, unknown>> {
    const ctx = this.ctx;
    const r = PairPatchSchema.safeParse(next);
    if (!r.success) throw new ConsoleError(`参数有误：${zodMsg(r.error)}`);
    next = r.data;
    const base = this.baseOf(id)!;
    const before = applyPairPatch(base, cur);
    const after = applyPairPatch(base, next);
    const sBefore = effectiveStrategy(ctx.cfg.app, before);
    const sAfter = effectiveStrategy(ctx.cfg.app, after);
    const rAfter = effectiveRisk(ctx.cfg.app, after);
    const problems = [...strategyProblems(sAfter), ...riskProblems(rAfter)];
    if (problems.length) throw new ConsoleError(`参数不合理：${problems.join("；")}`);
    // 方向：用当前核对结果试算（队名写法不匹配会在这里报错）
    const stored = ctx.stored.get(id);
    const engine = ctx.engines.get(id);
    let outcomeAfter: Outcome | null = after.maker.outcome ?? null;
    if (stored?.def) {
      try {
        outcomeAfter = buildActivePair(ctx, after, stored)?.makerOutcome ?? outcomeAfter;
      } catch (e) {
        throw new ConsoleError(errMsg(e));
      }
    }
    const makerChanged = engine ? engine.pair.makerVenue !== after.maker.venue || engine.pair.makerOutcome !== outcomeAfter : before.maker.venue !== after.maker.venue || before.maker.outcome !== after.maker.outcome;
    const triggerChanged = sBefore.hedgeTrigger !== sAfter.hedgeTrigger;
    if (makerChanged || triggerChanged) {
      const idle = this.idleCheck(id, triggerChanged);
      const what = [makerChanged ? "挂单方向" : null, triggerChanged ? "补单触发标准" : null].filter(Boolean).join("和");
      if (!idle.ok) throw new ConsoleError(`修改${what}前，请先暂停该配对并等到：${idle.reasons.join("；")}`, 409);
    }
    const changes = this.diff(
      { maker: { venue: before.maker.venue, outcome: engine?.pair.makerOutcome ?? before.maker.outcome ?? null }, strategy: sBefore, risk: effectiveRisk(ctx.cfg.app, before), note: before.note ?? null },
      { maker: { venue: after.maker.venue, outcome: outcomeAfter }, strategy: sAfter, risk: rAfter, note: after.note ?? null },
    );
    await this.savePatch(id, next);
    return { changes };
  }

  // =====================================================================
  // 全局参数
  // =====================================================================

  updateGlobal(actor: Actor, input: unknown): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "global.params", null, input, async () => {
        const ctx = this.ctx;
        const inp = parseOr400(GlobalInputSchema, input);
        const cur = this.globalPatch();
        let next;
        try {
          next = editPatch(cur, inp.set as Record<string, unknown> | undefined, inp.unset);
        } catch (e) {
          throw new ConsoleError(errMsg(e));
        }
        const parsed = GlobalPatchSchema.safeParse(next);
        if (!parsed.success) throw new ConsoleError(`参数有误：${zodMsg(parsed.error)}`);
        let newApp;
        try {
          newApp = applyGlobalPatch(ctx.fileApp, parsed.data);
        } catch (e) {
          throw new ConsoleError(`参数有误：${e instanceof z.ZodError ? zodMsg(e) : errMsg(e)}`);
        }
        const problems = [...strategyProblems(newApp.strategy), ...riskProblems(newApp.risk)];
        // 每个配对叠加自己的覆盖项后也必须合理；补单触发标准变化的配对必须处于空闲
        for (const pc of ctx.pairConfigs.values()) {
          const sNew = applyStrategyPatch(newApp.strategy, pc.strategy);
          for (const p of strategyProblems(sNew)) problems.push(`配对 ${pc.id}：${p}`);
          const sOld = effectiveStrategy(ctx.cfg.app, pc);
          if (sOld.hedgeTrigger !== sNew.hedgeTrigger) {
            const idle = this.idleCheck(pc.id, true);
            if (!idle.ok) throw new ConsoleError(`修改补单触发标准会影响配对 ${pc.id}，请先暂停它并等到：${idle.reasons.join("；")}`, 409);
          }
        }
        if (problems.length) throw new ConsoleError(`参数不合理：${problems.join("；")}`);
        const changes = this.diff({ strategy: ctx.cfg.app.strategy, risk: ctx.cfg.app.risk }, { strategy: newApp.strategy, risk: newApp.risk });
        ctx.overrides.setGlobal(parsed.data, ctx.clock.now());
        ctx.cfg.app = newApp;
        ctx.risk.setGlobal(newApp.risk);
        for (const id of ctx.engines.keys()) await applyPairConfig(ctx, id);
        return { changes };
      }),
    );
  }

  // =====================================================================
  // 核对、审批、对账
  // =====================================================================

  recheck(actor: Actor, id: string): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "pair.recheck", id, {}, async () => {
        this.requireActive(id);
        let r;
        try {
          r = await recheckPairStrict(this.ctx, id);
        } catch (e) {
          throw new ConsoleError(`重新核对失败：${errMsg(e)}`, 502);
        }
        if (!r) throw new ConsoleError(`配对 ${id} 尚未加载`, 404);
        const e = this.ctx.engines.get(id);
        return { status: r.stored.status, reason: r.stored.statusReason, changed: r.changed, verified: isTradeable(r.stored).ok, tradeable: e?.pair.tradeable ?? false, blockReason: e?.pair.blockReason ?? null };
      }),
    );
  }

  /**
   * 人工批准“待审核”配对。必须带上审阅时看到的规则版本（rulesHash）；
   * 批准前会用最新数据再核对一次，规则、队伍或赛程与审阅时不同则拒绝。
   */
  approve(actor: Actor, id: string, note: string, rulesHash: string): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "pair.approve", id, { note, rulesHash }, async () => {
        const ctx = this.ctx;
        const cur = ctx.pairing.get(id);
        if (!cur) throw new ConsoleError(`配对 ${id} 没有核对记录`, 404);
        if (cur.status === "REJECTED") throw new ConsoleError(`配对 ${id} 存在硬性不符，不能批准：${cur.statusReason ?? ""}`, 409);
        if (cur.status !== "PENDING_REVIEW") throw new ConsoleError(`只能批准“待审核”的配对，当前状态为 ${cur.status}`, 409);
        if (!note.trim()) throw new ConsoleError("请填写批准理由");
        if (!rulesHash || rulesHash !== cur.rulesHash) throw new ConsoleError("核对结果已更新，请刷新后重新审阅", 409);
        let fresh: StoredPair;
        try {
          fresh = ctx.pairConfigs.has(id) ? ((await recheckPairStrict(ctx, id))?.stored ?? cur) : (await ctx.pairing.recheck(id)).pair;
        } catch (e) {
          throw new ConsoleError(`批准前重新核对失败：${errMsg(e)}`, 502);
        }
        if (fresh.rulesHash !== rulesHash) throw new ConsoleError("规则、队伍或赛程刚刚发生变化，请重新审阅后再批准", 409);
        if (fresh.status === "APPROVED") return { status: fresh.status, message: "最新核对已自动通过，无需人工批准" };
        if (fresh.status !== "PENDING_REVIEW") throw new ConsoleError(`最新核对状态为 ${fresh.status}，不能批准：${fresh.statusReason ?? ""}`, 409);
        const p = ctx.pairing.approve(id, `${actor.name}：${note.trim()}`);
        if (ctx.stored.has(id)) {
          ctx.stored.set(id, p);
          await applyPairConfig(ctx, id);
        }
        ctx.alerts.raise("warn", "PAIR_APPROVED_MANUAL", `配对 ${id} 已由 ${actor.name} 人工批准：${note.trim()}`, { pairId: id });
        const e = ctx.engines.get(id);
        return { status: p.status, configured: ctx.pairConfigs.has(id), tradeable: e?.pair.tradeable ?? false, blockReason: e?.pair.blockReason ?? null };
      }),
    );
  }

  reconcile(actor: Actor, id: string | null): Promise<unknown> {
    return this.audited(actor, "reconcile", id, {}, async () => {
      const ctx = this.ctx;
      const engines = id ? [ctx.engines.get(id)] : [...ctx.engines.values()];
      if (id && !engines[0]) throw new ConsoleError(`配对 ${id} 没有运行中的引擎`, 404);
      const reports = [];
      for (const e of engines) {
        if (!e) continue;
        const rep = await reconcilePair(e, this.reconcileDeps(), { cancelOrphans: ctx.cfg.app.risk.cancelOrphanOrders, tolerance: ctx.cfg.app.risk.positionTolerance });
        reports.push(reportSummary(rep));
      }
      return { reports };
    });
  }

  /** 人工确认：把当前“交易所持仓 − 台账”记为基线，然后重新对账。需要输入配对 ID 确认，且该配对没有未结束订单。 */
  acceptPositions(actor: Actor, id: string, confirm: string): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "pair.acceptPositions", id, { confirm }, async () => {
        if (confirm !== id) throw new ConsoleError("请输入完整的配对 ID 确认");
        const engine = this.ctx.engines.get(id);
        if (!engine) throw new ConsoleError(`配对 ${id} 没有运行中的引擎`, 404);
        const open = this.ctx.repo.listOrders({ pairId: id, nonTerminal: true }).length;
        if (open) throw new ConsoleError(`还有 ${open} 笔未结束的订单，请先暂停该配对、等挂单撤完再确认持仓基线`, 409);
        const baseline = await acceptPositionsAsBaseline(engine, this.reconcileDeps());
        const rep = await reconcilePair(engine, this.reconcileDeps(), { cancelOrphans: this.ctx.cfg.app.risk.cancelOrphanOrders, tolerance: this.ctx.cfg.app.risk.positionTolerance });
        this.ctx.alerts.raise("warn", "BASELINE_ACCEPTED", `配对 ${id} 的交易所持仓已由 ${actor.name} 确认为基线`, { pairId: id, data: baseline });
        return { baseline, reconcile: reportSummary(rep) };
      }),
    );
  }

  // =====================================================================
  // 新增 / 删除 / 恢复配对
  // =====================================================================

  /** 预览核对（不保存）：添加前先看检查项、结算情形与规则原文。 */
  async preview(input: unknown): Promise<Record<string, unknown>> {
    const inp = parseOr400(PreviewInputSchema, input);
    let r: VerifyResult;
    try {
      r = await this.ctx.pairing.verifyMarkets(inp.predictMarketId, inp.polymarketConditionId);
    } catch (e) {
      throw new ConsoleError(`核对失败：${errMsg(e)}`, 502);
    }
    return this.previewOf(r);
  }

  private previewOf(r: VerifyResult): Record<string, unknown> {
    const conflict = this.marketConflict(r.pf.id, r.pm.conditionId, null);
    return reviewOf(r.pairId, r.verification.status, r.verification.reasons.join("；") || null, r.def, r.verification, {
      suggestedId: pairIdFor(r.pf.id, r.pm.conditionId),
      predictQuestion: r.pf.question,
      polymarketQuestion: r.pm.question,
      conflict,
      canAdd: r.verification.status !== "REJECTED" && r.def !== null && !conflict,
    });
  }

  addPair(actor: Actor, input: unknown): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "pair.add", (input as { id?: string } | null)?.id ?? null, input, async () => {
        const ctx = this.ctx;
        const inp = parseOr400(AddInputSchema, input);
        const id = inp.id ?? pairIdFor(inp.predictMarketId, inp.polymarketConditionId);
        if (!PAIR_ID_RE.test(id)) throw new ConsoleError(`配对 ID 不合法：${id}`);
        if (ctx.pairConfigs.has(id)) throw new ConsoleError(`配对 ID ${id} 已存在`, 409);
        if (ctx.cfg.pairs.some((p) => p.id === id)) throw new ConsoleError(`配置文件中已有配对 ${id}（已被删除时请在“已删除”列表中恢复）`, 409);
        const conflict = this.marketConflict(inp.predictMarketId, inp.polymarketConditionId, null);
        if (conflict) throw new ConsoleError(conflict, 409);
        let r: VerifyResult;
        try {
          r = await ctx.pairing.verifyMarkets(inp.predictMarketId, inp.polymarketConditionId);
        } catch (e) {
          throw new ConsoleError(`核对失败：${errMsg(e)}`, 502);
        }
        if (r.verification.status === "REJECTED" || !r.def) throw new ConsoleError(`配对未通过核对，不能添加：${r.verification.reasons.join("；") || "拿不到配对定义"}`, 409);
        if (inp.rulesHash && inp.rulesHash !== r.verification.rulesHash) throw new ConsoleError("核对结果与预览时不同，请重新核对后再添加", 409);
        const base = PairConfigSchema.parse({
          id,
          enabled: inp.enabled,
          predict: { marketId: inp.predictMarketId },
          polymarket: { conditionId: inp.polymarketConditionId },
          maker: inp.maker,
          strategy: inp.strategy ?? {},
          risk: inp.risk ?? {},
          ...(inp.note ? { note: inp.note } : {}),
        });
        const problems = [...strategyProblems(effectiveStrategy(ctx.cfg.app, base)), ...riskProblems(effectiveRisk(ctx.cfg.app, base))];
        if (problems.length) throw new ConsoleError(`参数不合理：${problems.join("；")}`);
        ctx.overrides.addConsolePair(base, ctx.clock.now());
        ctx.pairConfigs.set(id, base);
        ctx.pairOrigins.set(id, "console");
        ctx.deletedPairs.delete(id);
        const stored = await this.loadOrRollback(id, base, r);
        const act = ctx.running ? await activateNewPair(ctx, id) : { resubscribed: false };
        const e = ctx.engines.get(id);
        ctx.alerts.raise("info", "PAIR_ADDED", `控制台新增配对 ${id}（${actor.name}）：${r.def.labels.A} vs ${r.def.labels.B}，核对状态 ${stored.status}`, { pairId: id });
        return { id, status: stored.status, tradeable: e?.pair.tradeable ?? false, blockReason: e?.pair.blockReason ?? null, resubscribed: act.resubscribed };
      }),
    );
  }

  deletePair(actor: Actor, id: string, confirm: string): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "pair.delete", id, { confirm }, async () => {
        const ctx = this.ctx;
        if (confirm !== id) throw new ConsoleError("请输入完整的配对 ID 确认删除");
        const pc = ctx.pairConfigs.get(id);
        if (!pc) throw new ConsoleError(`配对 ${id} 不存在或已删除`, 404);
        // 在该配对的串行队列里检查并卸载：检查与卸载之间不会插入新的挂单或补单
        await ctx.queue.run(id, () => {
          const idle = this.idleCheck(id, true);
          if (!idle.ok) throw new ConsoleError(`不能删除：${idle.reasons.join("；")}。请先暂停该配对，等挂单撤完、补单完成、成交结算后再删除`, 409);
          unloadPair(ctx, id);
        });
        ctx.overrides.setDeleted(id, true, ctx.clock.now());
        ctx.deletedPairs.set(id, pc);
        ctx.alerts.raise("info", "PAIR_DELETED", `配对 ${id} 已由 ${actor.name} 删除（历史订单与成交保留，可在控制台恢复）`, { pairId: id });
        return { deleted: id };
      }),
    );
  }

  restorePair(actor: Actor, id: string): Promise<unknown> {
    return this.lock(() =>
      this.audited(actor, "pair.restore", id, {}, async () => {
        const ctx = this.ctx;
        if (!ctx.deletedPairs.has(id)) throw new ConsoleError(`配对 ${id} 不在已删除列表`, 404);
        const pc = this.effectiveFor(id);
        const conflict = this.marketConflict(pc.predict.marketId, pc.polymarket.conditionId, id);
        if (conflict) throw new ConsoleError(conflict, 409);
        ctx.overrides.setDeleted(id, false, ctx.clock.now());
        ctx.deletedPairs.delete(id);
        ctx.pairConfigs.set(id, pc);
        let stored: StoredPair;
        try {
          stored = await this.loadOrRollback(id, pc, undefined);
        } catch (e) {
          ctx.deletedPairs.set(id, pc);
          throw e;
        }
        const act = ctx.running ? await activateNewPair(ctx, id) : { resubscribed: false };
        const e = ctx.engines.get(id);
        return { id, status: stored.status, tradeable: e?.pair.tradeable ?? false, blockReason: e?.pair.blockReason ?? null, resubscribed: act.resubscribed };
      }),
    );
  }

  /** 发现候选配对（不保存）：遍历 Predict 电竞整场胜负盘，按 polymarketConditionIds 找 Polymarket 子盘口并核对。 */
  async discover(): Promise<Record<string, unknown>> {
    const now = this.ctx.clock.now();
    if (this.discoverCache && now - this.discoverCache.at < 60_000) return this.discoverCache.data;
    if (!this.discovering) {
      this.discovering = (async () => {
        try {
          const { results, skipped } = await this.ctx.pairing.discover({ save: false });
          const data = {
            at: bjTime(this.ctx.clock.now()),
            candidates: results.map((r) => ({
              suggestedId: r.pairId,
              predictMarketId: r.pf.id,
              polymarketConditionId: r.pm.conditionId,
              question: r.pm.question,
              labels: r.def?.labels ?? null,
              startTime: r.def ? bjTime(r.def.startTime) : null,
              status: r.verification.status,
              reasons: r.verification.reasons,
              configuredAs: this.configuredAs(r.pf.id, r.pm.conditionId),
            })),
            skipped,
          };
          this.discoverCache = { at: this.ctx.clock.now(), data };
          return data;
        } finally {
          this.discovering = null;
        }
      })();
    }
    try {
      return await this.discovering;
    } catch (e) {
      throw new ConsoleError(`发现候选配对失败：${errMsg(e)}`, 502);
    }
  }

  // =====================================================================
  // 内部工具
  // =====================================================================

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    return this.ctx.queue.run("__console__", fn);
  }

  private async audited<T>(actor: Actor, action: string, target: string | null, params: unknown, fn: () => Promise<T>): Promise<T> {
    const ts = this.ctx.clock.now();
    try {
      const r = await fn();
      this.ctx.repo.insertAudit({ ts, actor: actor.name, source: actor.source, ip: actor.ip, action, target, params, ok: true, result: r });
      this.ctx.log.info({ actor: actor.name, ip: actor.ip, action, target }, "控制台操作");
      return r;
    } catch (e) {
      this.ctx.repo.insertAudit({ ts, actor: actor.name, source: actor.source, ip: actor.ip, action, target, params, ok: false, result: { error: errMsg(e) } });
      this.ctx.log.warn({ actor: actor.name, ip: actor.ip, action, target, err: errMsg(e) }, "控制台操作未执行");
      throw e;
    }
  }

  private scheduleAll(reason: string): void {
    for (const e of this.ctx.engines.values()) void e.schedule(reason);
  }

  private requireActive(id: string): void {
    if (!this.ctx.pairConfigs.has(id)) throw new ConsoleError(`配对 ${id} 不存在或已删除`, 404);
  }

  private globalPatch() {
    try {
      return this.ctx.overrides.getGlobal();
    } catch {
      return {};
    }
  }

  private patchOf(id: string): PairPatch {
    try {
      return this.ctx.overrides.get(id)?.patch ?? {};
    } catch {
      // 保存的覆盖项无法解析：按“暂停”处理，之后任何保存都会以暂停状态重写，需要人工明确恢复
      return { enabled: false, pausedReason: "控制台覆盖项无法解析，已重置" };
    }
  }

  /** 配对的基础配置：配置文件中的，或控制台新增时保存的。 */
  private baseOf(id: string): PairConfig | null {
    const fp = this.ctx.cfg.pairs.find((p) => p.id === id);
    if (fp) return fp;
    try {
      return this.ctx.overrides.get(id)?.base ?? null;
    } catch {
      return null;
    }
  }

  private effectiveFor(id: string): PairConfig {
    const base = this.baseOf(id);
    if (!base) throw new ConsoleError(`配对 ${id} 没有可用配置`, 404);
    return applyPairPatch(base, this.patchOf(id));
  }

  /** 保存覆盖项并让运行中的引擎立即使用新参数。 */
  private async savePatch(id: string, patch: PairPatch): Promise<void> {
    this.ctx.overrides.setPatch(id, patch, this.ctx.clock.now());
    // 覆盖项已用合法数据重写，之前“无法解析”的配置错误随之解除
    this.ctx.configErrors.delete(id);
    this.ctx.pairConfigs.set(id, this.effectiveFor(id));
    await applyPairConfig(this.ctx, id);
  }

  private async loadOrRollback(id: string, pc: PairConfig, pre: VerifyResult | undefined): Promise<StoredPair> {
    try {
      return await loadPair(this.ctx, pc, pre);
    } catch (e) {
      unloadPair(this.ctx, id);
      this.ctx.overrides.setDeleted(id, true, this.ctx.clock.now());
      throw new ConsoleError(`加载配对失败：${errMsg(e)}`, 500);
    }
  }

  /** 同一个 Predict 市场或 Polymarket 市场不能被两个配对同时使用（同一代币的持仓无法分属两个配对对账）。 */
  private marketConflict(pfMarketId: number, conditionId: string, exceptId: string | null): string | null {
    for (const pc of this.ctx.pairConfigs.values()) {
      if (pc.id === exceptId) continue;
      if (pc.predict.marketId === pfMarketId) return `Predict 市场 #${pfMarketId} 已被配对 ${pc.id} 使用`;
      if (pc.polymarket.conditionId.toLowerCase() === conditionId.toLowerCase()) return `Polymarket 市场已被配对 ${pc.id} 使用`;
    }
    return null;
  }

  private configuredAs(pfMarketId: number, conditionId: string): string | null {
    for (const pc of this.ctx.pairConfigs.values()) {
      if (pc.predict.marketId === pfMarketId || pc.polymarket.conditionId.toLowerCase() === conditionId.toLowerCase()) return pc.id;
    }
    return null;
  }

  /**
   * 配对是否“空闲”：没有未结束订单、净敞口在零头以内、（可选）没有待结算成交、不在紧急处理中。
   * 删除配对、改挂单方向、改补单触发标准前要求空闲。
   */
  private idleCheck(id: string, requireSettled: boolean): IdleCheck {
    const ctx = this.ctx;
    const open = ctx.repo.listOrders({ pairId: id, nonTerminal: true }).length;
    const fills = ctx.repo.listFills({ pairId: id });
    const pendingFills = fills.filter((f) => !isTerminalFill(f.status)).length;
    const net = netExposure(computePositions(fills, "matched"));
    const pc = ctx.pairConfigs.get(id) ?? ctx.deletedPairs.get(id);
    const dust = pc ? fx(effectiveStrategy(ctx.cfg.app, pc).residual.dustShares) : 0n;
    const reasons: string[] = [];
    if (open) reasons.push(`还有 ${open} 笔未结束的订单（挂单或在途补单）`);
    if (abs(net) > dust) reasons.push(`净敞口 ${toStr(net, 4)} 份未对齐`);
    if (requireSettled && pendingFills) reasons.push(`${pendingFills} 笔成交尚未结算（结算失败会重新产生敞口）`);
    if (ctx.engines.get(id)?.inEmergency) reasons.push("正在紧急处理");
    return { ok: reasons.length === 0, reasons, net, openOrders: open, pendingFills };
  }

  private diff(before: Record<string, unknown>, after: Record<string, unknown>): { key: string; label: string; from: unknown; to: unknown }[] {
    const a = flatten(before);
    const b = flatten(after);
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => ({ key: k, label: fieldLabel(k), from: a[k] ?? null, to: b[k] ?? null }));
  }

  private reconcileDeps() {
    const ctx = this.ctx;
    return { repo: ctx.repo, clock: ctx.clock, venues: ctx.venues, queue: ctx.queue, alerts: ctx.alerts, log: ctx.log };
  }
}

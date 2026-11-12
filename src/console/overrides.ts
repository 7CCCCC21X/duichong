import { z } from "zod";
import {
  applyStrategyPatch,
  mergeStrategyPatch,
  PairConfigSchema,
  RiskPatchStrictSchema,
  RiskSchema,
  StrategyPatchStrictSchema,
  StrategySchema,
  type AppConfig,
  type PairConfig,
  type RiskPatch,
  type StrategyPatch,
} from "../config/schema.js";
import type { Repo } from "../db/repo.js";

/**
 * 控制台修改的持久化层。
 *
 * 生效顺序（后者覆盖前者）：默认值 → config.yaml 全局 → 控制台全局 → pairs.yaml 配对 → 控制台配对。
 * - 控制台全局覆盖保存在 kv `console.global`；
 * - 配对覆盖保存在 pair_overrides 表：配置文件中的配对只存覆盖项（patch）；
 *   控制台新增的配对另存完整配置（base）；删除用 deleted 标记，可恢复。
 * 所有修改落库后重启仍然生效；配置文件改动不会覆盖控制台修改，需要时在控制台“恢复为配置文件值”。
 */

export interface PairPatch {
  enabled?: boolean;
  /** 控制台暂停原因（enabled=false 时显示） */
  pausedReason?: string;
  maker?: { venue: "predict" | "polymarket"; outcome: "A" | "B" };
  strategy?: StrategyPatch;
  risk?: RiskPatch;
  note?: string;
}

export interface GlobalPatch {
  strategy?: StrategyPatch;
  risk?: RiskPatch;
}

export const MakerPatchSchema = z.object({ venue: z.enum(["predict", "polymarket"]), outcome: z.enum(["A", "B"]) }).strict();

export const PairPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    pausedReason: z.string().max(500).optional(),
    maker: MakerPatchSchema.optional(),
    strategy: StrategyPatchStrictSchema.optional(),
    risk: RiskPatchStrictSchema.optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export const GlobalPatchSchema = z.object({ strategy: StrategyPatchStrictSchema.optional(), risk: RiskPatchStrictSchema.optional() }).strict();

const GLOBAL_KEY = "console.global";

export interface OverrideEntry {
  id: string;
  base: PairConfig | null;
  patch: PairPatch;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
}

export class OverrideStore {
  constructor(private readonly repo: Repo) {}

  getGlobal(): GlobalPatch {
    const raw = this.repo.getKv(GLOBAL_KEY);
    if (!raw) return {};
    return GlobalPatchSchema.parse(JSON.parse(raw));
  }

  setGlobal(g: GlobalPatch, now: number): void {
    const clean = prune(g) as GlobalPatch;
    if (Object.keys(clean).length === 0) this.repo.deleteKv(GLOBAL_KEY);
    else this.repo.setKv(GLOBAL_KEY, JSON.stringify(clean), now);
  }

  get(id: string): OverrideEntry | null {
    const r = this.repo.getPairOverride(id);
    if (!r) return null;
    return {
      id: r.id,
      base: r.base ? PairConfigSchema.parse(r.base) : null,
      patch: PairPatchSchema.parse(r.patch ?? {}),
      deleted: r.deleted,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  listIds(): string[] {
    return this.repo.listPairOverrides().map((r) => r.id);
  }

  /** 覆盖项无法解析时，尽量取回控制台新增配对的基础配置与删除标记（用于安全降级：加载但暂停）。 */
  getBaseOnly(id: string): { base: PairConfig | null; deleted: boolean } | null {
    const r = this.repo.getPairOverride(id);
    if (!r) return null;
    const b = r.base ? PairConfigSchema.safeParse(r.base) : null;
    return { base: b && b.success ? b.data : null, deleted: r.deleted };
  }

  setPatch(id: string, patch: PairPatch, now: number): void {
    // 只读原始行的删除标记：旧覆盖项可能无法解析（正是要用新数据重写它）
    const cur = this.repo.getPairOverride(id);
    this.repo.upsertPairOverride({ id, patch: prune(patch) ?? {}, deleted: cur?.deleted ?? false, now });
  }

  addConsolePair(base: PairConfig, now: number): void {
    this.repo.upsertPairOverride({ id: base.id, base, patch: {}, deleted: false, now });
  }

  setDeleted(id: string, deleted: boolean, now: number): void {
    const cur = this.repo.getPairOverride(id);
    this.repo.upsertPairOverride({ id, patch: cur?.patch ?? {}, deleted, now });
  }
}

/** 去掉空对象与 undefined，保持存储干净（空覆盖项不落库）。 */
export function prune(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined) continue;
    const p = prune(x);
    if (p !== null && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 0) continue;
    out[k] = p;
  }
  return out;
}

/** config.yaml 全局 + 控制台全局 → 实际生效的全局配置（返回新对象，不修改入参）。 */
export function applyGlobalPatch(file: AppConfig, g: GlobalPatch): AppConfig {
  return {
    ...file,
    strategy: applyStrategyPatch(file.strategy, g.strategy),
    risk: RiskSchema.parse({ ...file.risk, ...(g.risk ?? {}) }),
  };
}

/** 配对配置（文件或控制台新增）+ 控制台覆盖项 → 实际生效的配对配置。 */
export function applyPairPatch(pc: PairConfig, patch: PairPatch): PairConfig {
  const out: PairConfig = {
    ...pc,
    enabled: patch.enabled ?? pc.enabled,
    maker: patch.maker ? { venue: patch.maker.venue, outcome: patch.maker.outcome } : pc.maker,
    strategy: mergeStrategyPatch(pc.strategy, patch.strategy),
    risk: { ...(pc.risk ?? {}), ...(patch.risk ?? {}) },
  };
  if (patch.note !== undefined) out.note = patch.note;
  return out;
}

/** 校验生效后的策略：字段合法，且组合有意义（例如固定价模式必须填价格）。返回问题列表。 */
export function strategyProblems(s: unknown): string[] {
  const r = StrategySchema.safeParse(s);
  if (!r.success) return r.error.issues.map((i) => `${i.path.join(".")}：${i.message}`);
  const v = r.data;
  const out: string[] = [];
  if (v.priceMode === "fixed" && v.price === null) out.push("固定价模式（priceMode=fixed）需要填写挂单价格 price");
  if (v.minMakerPrice !== null && v.maxMakerPrice !== null && v.minMakerPrice >= v.maxMakerPrice) out.push("最低挂单价必须小于最高挂单价");
  if (v.stopQuotingAt !== null && !Number.isFinite(Date.parse(v.stopQuotingAt))) out.push(`停止挂单时间无法解析：${v.stopQuotingAt}（请用 ISO 格式，例如 2026-11-12T20:00:00+08:00）`);
  return out;
}

export function riskProblems(r: unknown): string[] {
  const p = RiskSchema.safeParse(r);
  if (!p.success) return p.error.issues.map((i) => `${i.path.join(".")}：${i.message}`);
  return [];
}

/**
 * 按路径修改覆盖项：set 里的值写入（null 表示把该字段显式设为空，例如取消固定价），
 * unset 里的路径删除（恢复为下一层的值）。返回新对象。
 */
export function editPatch<T extends object>(cur: T, set: Record<string, unknown> | undefined, unset: string[] | undefined): T {
  const out = structuredClone(cur) as Record<string, unknown>;
  const walk = (obj: Record<string, unknown>, path: string[], fn: (o: Record<string, unknown>, k: string) => void) => {
    let o = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i]!;
      if (o[k] === undefined || o[k] === null || typeof o[k] !== "object") o[k] = {};
      o = o[k] as Record<string, unknown>;
    }
    fn(o, path[path.length - 1]!);
  };
  const flatSet = flatten(set ?? {});
  for (const [path, v] of Object.entries(flatSet)) {
    if (isUnsafeKey(path)) throw new Error(`非法字段：${path}`);
    walk(out, path.split("."), (o, k) => {
      o[k] = v;
    });
  }
  for (const path of unset ?? []) {
    if (isUnsafeKey(path)) throw new Error(`非法字段：${path}`);
    walk(out, path.split("."), (o, k) => {
      delete o[k];
    });
  }
  return prune(out) as T;
}

function isUnsafeKey(path: string): boolean {
  return path.split(".").some((k) => k === "__proto__" || k === "constructor" || k === "prototype" || k === "");
}

/** {strategy:{hedge:{a:1}}} → {"strategy.hedge.a":1}；数组与 null 视为叶子。 */
export function flatten(o: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, p));
    else out[p] = v;
  }
  return out;
}

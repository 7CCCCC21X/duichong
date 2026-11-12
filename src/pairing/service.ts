import type { Logger } from "pino";
import { errMsg } from "../core/async.js";
import type { Clock } from "../core/time.js";
import type { Repo } from "../db/repo.js";
import type { AlertSink } from "../engine/alerts.js";
import type { PfCategoryInfo, PfMarketInfo, PredictPublic } from "../market/predictData.js";
import type { PmMarketInfo, PolymarketPublic } from "../market/polymarketData.js";
import { verifyPair, type PairDefinition, type Verification } from "./verify.js";

export type PairStatus = "APPROVED" | "APPROVED_MANUAL" | "PENDING_REVIEW" | "REJECTED" | "PAUSED_RECHECK";

export interface StoredPair {
  id: string;
  status: PairStatus;
  statusReason: string | null;
  def: PairDefinition | null;
  verification: Verification | null;
  rulesHash: string | null;
  approvedRulesHash: string | null;
  approvedBy: string | null;
}

export interface VerifyResult {
  pairId: string;
  pf: PfMarketInfo;
  cat: PfCategoryInfo;
  pm: PmMarketInfo;
  def: PairDefinition | null;
  verification: Verification;
}

export function pairIdFor(pfMarketId: number, pmConditionId: string): string {
  return `pf${pfMarketId}-pm${pmConditionId.slice(2, 10)}`;
}

/** 判断配对是否可交易：已批准，且批准时的规则版本与当前一致。 */
export function isTradeable(p: StoredPair): { ok: boolean; reason: string | null } {
  if (p.status !== "APPROVED" && p.status !== "APPROVED_MANUAL") return { ok: false, reason: `配对状态 ${p.status}${p.statusReason ? `：${p.statusReason}` : ""}` };
  if (!p.rulesHash || p.approvedRulesHash !== p.rulesHash) return { ok: false, reason: "规则或比赛信息已变化，需重新核对/审批" };
  return { ok: true, reason: null };
}

export class PairingService {
  constructor(
    private readonly pf: PredictPublic,
    private readonly pm: PolymarketPublic,
    private readonly repo: Repo,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly alerts: AlertSink | null = null,
  ) {}

  /** 拉取两边市场并核对。 */
  async verifyMarkets(pfMarketId: number, pmConditionId: string): Promise<VerifyResult> {
    const pf = await this.pf.market(pfMarketId);
    const cat = await this.pf.category(pf.categorySlug);
    const pm = await this.pm.marketWithEvent(pmConditionId);
    if (!pm) throw new Error(`Polymarket 找不到 conditionId ${pmConditionId}`);
    const { def, verification } = verifyPair({ pf, cat, pm, now: this.clock.now() });
    return { pairId: pairIdFor(pfMarketId, pmConditionId), pf, cat, pm, def, verification };
  }

  /** 保存核对结果、规则原文快照；处理状态迁移（规则变化 → 需要重新审批）。 */
  save(r: VerifyResult): StoredPair {
    const now = this.clock.now();
    const prev = this.get(r.pairId);
    const v = r.verification;
    if (r.def) {
      this.repo.insertSnapshot({ venue: "predict", marketKey: String(r.pf.id), fetchedAt: now, rulesHash: r.def.rules.predictHash, rulesText: r.def.rules.predict, versionTag: r.def.versionTag, raw: { market: r.pf.raw, category: { ...((r.cat.raw as object) ?? {}), markets: undefined } } });
      this.repo.insertSnapshot({ venue: "polymarket", marketKey: r.pm.conditionId, fetchedAt: now, rulesHash: r.def.rules.polymarketHash, rulesText: r.def.rules.polymarket, versionTag: r.def.versionTag, raw: { market: r.pm.raw, event: r.pm.event?.raw ?? null } });
    }
    let status: PairStatus = v.status;
    let approvedRulesHash: string | null | undefined;
    let approvedBy: string | null | undefined;
    let reason: string | null = v.reasons.join("；") || null;
    if (v.status === "APPROVED") {
      approvedRulesHash = v.rulesHash;
      approvedBy = "auto";
    } else if (v.status === "PENDING_REVIEW" && prev?.status === "APPROVED_MANUAL" && prev.approvedRulesHash === v.rulesHash) {
      status = "APPROVED_MANUAL"; // 人工已批准且规则未变
      reason = prev.statusReason;
    }
    if (prev && (prev.status === "APPROVED" || prev.status === "APPROVED_MANUAL") && prev.rulesHash && prev.rulesHash !== v.rulesHash) {
      this.alerts?.raise("critical", "RULES_CHANGED", `配对 ${r.pairId} 的规则/队伍/赛程发生变化，已暂停新挂单并重新核对，结果：${status}`, { pairId: r.pairId });
      if (status === "APPROVED_MANUAL") status = "PENDING_REVIEW";
    }
    this.repo.upsertPair({ id: r.pairId, status, statusReason: reason, definition: r.def, verification: v, rulesHash: v.rulesHash, approvedRulesHash, approvedBy, now });
    return this.get(r.pairId)!;
  }

  get(id: string): StoredPair | null {
    const row = this.repo.getPair(id);
    if (!row) return null;
    return {
      id: row.id,
      status: row.status as PairStatus,
      statusReason: row.statusReason,
      def: row.definition as PairDefinition | null,
      verification: row.verification as Verification | null,
      rulesHash: row.rulesHash,
      approvedRulesHash: row.approvedRulesHash,
      approvedBy: row.approvedBy,
    };
  }

  list(): StoredPair[] {
    return this.repo.listPairs().map((r) => this.get(r.id)!);
  }

  /** 人工批准待审核配对（REJECTED 不允许批准）。 */
  approve(id: string, note: string): StoredPair {
    const p = this.get(id);
    if (!p) throw new Error(`配对不存在: ${id}`);
    if (p.status === "REJECTED") throw new Error(`配对 ${id} 存在硬性不符，不能批准：${p.statusReason ?? ""}`);
    if (!p.rulesHash) throw new Error("配对尚未核对");
    this.repo.upsertPair({
      id,
      status: "APPROVED_MANUAL",
      statusReason: `人工批准：${note}`,
      definition: p.def,
      verification: p.verification,
      rulesHash: p.rulesHash,
      approvedRulesHash: p.rulesHash,
      approvedBy: `manual:${note}`,
      now: this.clock.now(),
    });
    return this.get(id)!;
  }

  pause(id: string, reason: string): void {
    this.repo.setPairStatus(id, "PAUSED_RECHECK", reason, this.clock.now());
  }

  /**
   * 发现候选配对：遍历 Predict 电竞类别中带 polymarketConditionIds 的子盘口，
   * 到 Polymarket 查对应市场并核对。只保存首版范围（整场胜负）的候选，其余仅返回统计。
   */
  async discover(opts: { variants?: string[]; save?: boolean; includeAllTypes?: boolean } = {}): Promise<{ results: VerifyResult[]; skipped: { reason: string; count: number }[] }> {
    const variants = opts.variants ?? ["ESPORTS_CS2", "ESPORTS_LOL", "ESPORTS_DOTA2"];
    const cats = await this.pf.categories(variants);
    const results: VerifyResult[] = [];
    const skipped = new Map<string, number>();
    const skip = (r: string) => skipped.set(r, (skipped.get(r) ?? 0) + 1);
    const wanted: { pf: PfMarketInfo; cat: PfCategoryInfo; cond: string }[] = [];
    for (const cat of cats) {
      for (const m of cat.markets) {
        if (!opts.includeAllTypes && m.marketType && m.marketType !== "SPORTS_MONEYLINE") {
          skip(`非整场胜负盘（${m.marketType}）`);
          continue;
        }
        if (m.polymarketConditionIds.length === 0) {
          skip("Predict 未提供 polymarketConditionIds");
          continue;
        }
        for (const cond of m.polymarketConditionIds) wanted.push({ pf: m, cat, cond });
      }
    }
    // 批量查 Polymarket 市场
    const byCond = new Map<string, PmMarketInfo>();
    for (let i = 0; i < wanted.length; i += 50) {
      const chunk = [...new Set(wanted.slice(i, i + 50).map((w) => w.cond))];
      try {
        for (const m of await this.pm.marketsByConditionIds(chunk)) byCond.set(m.conditionId.toLowerCase(), m);
      } catch (e) {
        this.log.warn({ err: errMsg(e) }, "批量获取 Polymarket 市场失败");
      }
    }
    const eventCache = new Map<string, PmMarketInfo["event"]>();
    for (const w of wanted) {
      const pm = byCond.get(w.cond.toLowerCase());
      if (!pm) {
        skip("Polymarket 查不到对应 conditionId");
        continue;
      }
      if (pm.eventId) {
        if (!eventCache.has(pm.eventId)) {
          try {
            eventCache.set(pm.eventId, await this.pm.event(pm.eventId));
          } catch {
            eventCache.set(pm.eventId, null);
          }
        }
        pm.event = eventCache.get(pm.eventId) ?? null;
      }
      const { def, verification } = verifyPair({ pf: w.pf, cat: w.cat, pm, now: this.clock.now() });
      const r: VerifyResult = { pairId: pairIdFor(w.pf.id, pm.conditionId), pf: w.pf, cat: w.cat, pm, def, verification };
      results.push(r);
      if (opts.save !== false) this.save(r);
    }
    return { results, skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })) };
  }

  /** 重新核对一个配对，返回是否发生了需要暂停的变化。 */
  async recheck(id: string): Promise<{ changed: boolean; pair: StoredPair }> {
    const p = this.get(id);
    if (!p?.def) throw new Error(`配对 ${id} 没有可用定义`);
    const r = await this.verifyMarkets(p.def.predict.marketId, p.def.polymarket.conditionId);
    r.pairId = id; // 配置里可以自定义配对 ID，保存回同一条记录
    const changed = p.rulesHash !== r.verification.rulesHash;
    const saved = this.save(r);
    if (changed) this.log.warn({ pair: id, from: p.rulesHash?.slice(0, 12), to: r.verification.rulesHash.slice(0, 12), status: saved.status }, "配对信息变化");
    return { changed, pair: saved };
  }
}

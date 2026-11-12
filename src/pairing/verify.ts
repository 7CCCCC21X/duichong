import { sha256, extractClauses, normalizeRules, settlementMatrix, type RuleClauses, type ScenarioResult } from "./rules.js";
import type { PfCategoryInfo, PfMarketInfo, PfTeam } from "../market/predictData.js";
import type { PmMarketInfo, PmTeam } from "../market/polymarketData.js";
import type { Outcome } from "../core/types.js";

export type CheckLevel = "pass" | "warn" | "fail";

export interface Check {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

/** 配对定义：两边市场、队伍与 outcome token 的对应关系（A = Predict indexSet 1 的队伍）。 */
export interface PairDefinition {
  predict: {
    marketId: number;
    categorySlug: string;
    conditionId: string;
    tokens: Record<Outcome, string>;
    indexSet: Record<Outcome, 1 | 2>;
    isNegRisk: boolean;
    isYieldBearing: boolean;
    feeRateBps: number;
    decimalPrecision: number;
  };
  polymarket: {
    conditionId: string;
    marketId: string;
    eventId: string | null;
    version: "v1" | "v2";
    tokens: Record<Outcome, string>;
    outcomeIndex: Record<Outcome, 0 | 1>;
    negRisk: boolean;
  };
  labels: Record<Outcome, string>;
  game: string | null;
  marketType: string;
  bestOf: number | null;
  startTime: number | null;
  rules: { predict: string; polymarket: string; predictHash: string; polymarketHash: string };
  versionTag: string;
}

export interface Verification {
  status: "APPROVED" | "PENDING_REVIEW" | "REJECTED";
  reasons: string[];
  checks: Check[];
  scenarios: ScenarioResult[];
  clauses: { predict: RuleClauses; polymarket: RuleClauses };
  rulesHash: string;
}

const GAME_BY_VARIANT: Record<string, string> = { ESPORTS_CS2: "cs2", ESPORTS_LOL: "lol", ESPORTS_DOTA2: "dota2" };

function gameFromPm(pm: PmMarketInfo): string | null {
  const ev = pm.event;
  const hay = [ev?.seriesSlug ?? "", ...(ev?.tags ?? []), ev?.title ?? "", pm.question].join(" ").toLowerCase();
  if (/counter-strike|\bcs2\b|\bcsgo\b/.test(hay)) return "cs2";
  if (/league-of-legends|\blol\b|league of legends/.test(hay)) return "lol";
  if (/dota-2|dota 2|\bdota2\b/.test(hay)) return "dota2";
  if (/valorant/.test(hay)) return "valorant";
  return null;
}

function gameFromPf(cat: PfCategoryInfo, m: PfMarketInfo): string | null {
  const v = cat.marketVariant ?? m.marketVariant ?? "";
  if (GAME_BY_VARIANT[v]) return GAME_BY_VARIANT[v]!;
  const hay = `${cat.title} ${m.question}`.toLowerCase();
  if (/counter-strike/.test(hay)) return "cs2";
  if (/\blol\b|league of legends/.test(hay)) return "lol";
  if (/dota 2/.test(hay)) return "dota2";
  return null;
}

const PM_TYPE: Record<string, string> = {
  SPORTS_MONEYLINE: "moneyline",
  SPORTS_CHILD_MONEYLINE: "child_moneyline",
  SPORTS_MAP_HANDICAP: "map_handicap",
  SPORTS_TOTALS: "totals",
};

export function bestOfFrom(text: string): number | null {
  const m = text.match(/\(bo(\d)\)/i) ?? text.match(/\bbest of (\d)\b/i);
  return m ? Number(m[1]) : null;
}

function gameNumberFromPm(pm: PmMarketInfo): number | null {
  const m = `${pm.groupItemTitle ?? ""} ${pm.question}`.match(/\b(map|game) (\d+)\b/i);
  return m ? Number(m[2]) : null;
}

export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function loose(s: string): string {
  return normName(s)
    .replace(/^team /, "")
    .replace(/ (esports|e sports|gaming|esport|club|gg)$/g, "")
    .replace(/ /g, "");
}

interface TeamSide {
  idx: number;
  label: string;
  team: PfTeam | PmTeam | null;
}

function teamKeys(label: string, team: PfTeam | PmTeam | null): { strong: Set<string>; weak: Set<string> } {
  const strong = new Set<string>();
  const weak = new Set<string>();
  if (team) {
    // 实测：Predict 的 providerTeamId 等于 Polymarket 事件队伍的 id（provider=POLYMARKET 时）
    if ("providerTeamId" in team) {
      if (team.providerTeamId) strong.add(`pmteam:${team.providerTeamId}`);
    } else {
      if (team.id !== null) strong.add(`pmteam:${team.id}`);
      if (team.providerId) strong.add(`provider:${team.providerId}`);
    }
    if (team.name) strong.add(`name:${normName(team.name)}`);
    if (team.abbreviation) weak.add(`abbr:${normName(team.abbreviation)}`);
    if (team.name) weak.add(`loose:${loose(team.name)}`);
  }
  if (label) {
    // 大小分盘：“Over 2.5”与“Over”视为同一结果
    const ou = normName(label).match(/^(over|under)\b/);
    if (ou) strong.add(`ou:${ou[1]}`);
    strong.add(`name:${normName(label)}`);
    weak.add(`abbr:${normName(label)}`);
    weak.add(`loose:${loose(label)}`);
  }
  return { strong, weak };
}

/** 匹配两边队伍：优先 providerTeamId / 完整队名，其次缩写与宽松队名。返回 Predict indexSet → Polymarket 下标。 */
export function matchTeams(pfSides: TeamSide[], pmSides: TeamSide[]): { map: Map<number, number>; strength: "strong" | "weak"; detail: string } | { error: string } {
  const score = (a: TeamSide, b: TeamSide): number => {
    const ka = teamKeys(a.label, a.team);
    const kb = teamKeys(b.label, b.team);
    let s = 0;
    for (const k of ka.strong) if (kb.strong.has(k)) s = Math.max(s, 2);
    if (s === 0) for (const k of ka.weak) if (kb.weak.has(k) || kb.strong.has(k.replace(/^loose:/, "name:"))) s = Math.max(s, 1);
    return s;
  };
  if (pfSides.length !== 2 || pmSides.length !== 2) return { error: "两边都必须恰好有两个结果" };
  const direct = score(pfSides[0]!, pmSides[0]!) + score(pfSides[1]!, pmSides[1]!);
  const crossed = score(pfSides[0]!, pmSides[1]!) + score(pfSides[1]!, pmSides[0]!);
  const minDirect = Math.min(score(pfSides[0]!, pmSides[0]!), score(pfSides[1]!, pmSides[1]!));
  const minCrossed = Math.min(score(pfSides[0]!, pmSides[1]!), score(pfSides[1]!, pmSides[0]!));
  if (direct > crossed && minDirect > 0) {
    return { map: new Map([[pfSides[0]!.idx, pmSides[0]!.idx], [pfSides[1]!.idx, pmSides[1]!.idx]]), strength: minDirect >= 2 ? "strong" : "weak", detail: "同序对应" };
  }
  if (crossed > direct && minCrossed > 0) {
    return { map: new Map([[pfSides[0]!.idx, pmSides[1]!.idx], [pfSides[1]!.idx, pmSides[0]!.idx]]), strength: minCrossed >= 2 ? "strong" : "weak", detail: "交叉对应" };
  }
  return { error: `队伍无法唯一对应（同序得分 ${direct}，交叉得分 ${crossed}）` };
}

/**
 * 核对一个配对。规则原文取 Predict 市场描述（为空时用类别描述）与 Polymarket 市场描述。
 * 结果：全部通过 → APPROVED；存在歧义或可能导致兑付不一致 → PENDING_REVIEW；硬性不符 → REJECTED。
 */
export function verifyPair(input: {
  pf: PfMarketInfo;
  cat: PfCategoryInfo;
  pm: PmMarketInfo;
  now: number;
  startToleranceMin?: number;
  /** 首版只交易整场胜负盘 */
  allowedTypes?: string[];
}): { def: PairDefinition | null; verification: Verification } {
  const { pf, cat, pm, now } = input;
  const checks: Check[] = [];
  const add = (id: string, label: string, level: CheckLevel, detail: string) => checks.push({ id, label, level, detail });
  const allowed = input.allowedTypes ?? ["moneyline"];
  const tol = (input.startToleranceMin ?? 15) * 60_000;

  // 1) conditionId 对应
  if (pf.polymarketConditionIds.length === 0) add("cond", "Predict 声明的 Polymarket conditionId", "warn", "Predict 市场未提供 polymarketConditionIds，只能靠其他字段核对");
  else if (pf.polymarketConditionIds.map((x) => x.toLowerCase()).includes(pm.conditionId.toLowerCase())) add("cond", "Predict 声明的 Polymarket conditionId", "pass", pm.conditionId);
  else add("cond", "Predict 声明的 Polymarket conditionId", "fail", `Predict 列出的是 ${pf.polymarketConditionIds.join(",")}，不含 ${pm.conditionId}`);

  // 2) 游戏
  const gPf = gameFromPf(cat, pf);
  const gPm = gameFromPm(pm);
  if (!gPf || !gPm) add("game", "游戏", "warn", `无法识别（Predict ${gPf ?? "?"}，Polymarket ${gPm ?? "?"}）`);
  else add("game", "游戏", gPf === gPm ? "pass" : "fail", `Predict ${gPf}，Polymarket ${gPm}`);

  // 3) 盘口类型（整场 / 单局 / 让分 / 大小分）
  const pfType = PM_TYPE[pf.marketType ?? ""] ?? (pf.marketType ? pf.marketType.replace(/^SPORTS_/, "").toLowerCase() : null);
  const pmType = pm.sportsMarketType;
  if (!pfType || !pmType) add("type", "盘口类型", "warn", `Predict ${pf.marketType ?? "未知"}，Polymarket ${pmType ?? "未知"}`);
  else add("type", "盘口类型", pfType === pmType ? "pass" : "fail", `Predict ${pf.marketType}，Polymarket ${pmType}`);
  const marketType = pmType ?? pfType ?? "unknown";
  if (!allowed.includes(marketType)) add("scope", "首版范围（赛前整场胜负）", "fail", `盘口类型 ${marketType} 不在首版范围 ${allowed.join("/")}`);
  else add("scope", "首版范围（赛前整场胜负）", "pass", marketType);

  // 4) 单局号与盘口线
  const gnPm = gameNumberFromPm(pm);
  if (pf.gameNumber !== null || gnPm !== null) {
    add("gameNumber", "单局号", pf.gameNumber === gnPm ? "pass" : "fail", `Predict ${pf.gameNumber ?? "-"}，Polymarket ${gnPm ?? "-"}`);
  }
  if (pf.line !== null || pm.line !== null) {
    const same = pf.line !== null && pm.line !== null && Math.abs(Math.abs(pf.line) - Math.abs(pm.line)) < 1e-9;
    add("line", "让分/大小分数值", same ? "pass" : "fail", `Predict ${pf.line ?? "-"}，Polymarket ${pm.line ?? "-"}（让分方向需人工确认）`);
    if (same && marketType === "map_handicap") add("lineSide", "让分方向", "warn", "Predict 文档说明让分方向尚未在接口中标明，需人工确认");
  }

  // 5) 赛制
  const boPf = bestOfFrom(`${cat.title} ${pf.question}`);
  const boPm = bestOfFrom(`${pm.event?.title ?? ""} ${pm.question}`);
  if (boPf !== null && boPm !== null) add("bo", "赛制", boPf === boPm ? "pass" : "fail", `Predict BO${boPf}，Polymarket BO${boPm}`);
  else add("bo", "赛制", "warn", `未能从标题识别（Predict ${boPf ?? "?"}，Polymarket ${boPm ?? "?"}）`);

  // 6) 开赛时间
  const tPf = cat.startsAt;
  const tPm = pm.gameStartTime ?? pm.eventStartTime ?? pm.event?.startTime ?? null;
  if (tPf === null || tPm === null) add("start", "开赛时间", "warn", "一边缺少开赛时间");
  else {
    const diff = Math.abs(tPf - tPm);
    // 相差较大时交人工核对（Predict startsAt 与 Polymarket gameStartTime 口径可能不同），停止挂单按较早时间计算
    add("start", "开赛时间", diff <= tol ? "pass" : "warn", `相差 ${Math.round(diff / 60000)} 分钟（停止挂单按较早时间计算）`);
  }
  const startTime = tPf !== null && tPm !== null ? Math.min(tPf, tPm) : (tPf ?? tPm);
  if (startTime !== null && startTime <= now) add("prematch", "赛前", "fail", "比赛已开始，首版只做赛前");
  else add("prematch", "赛前", "pass", "未开赛");

  // 7) 市场状态
  const pfOpen = ["REGISTERED", "UNPAUSED", "PRICE_PROPOSED", "PRICE_DISPUTED"].includes(pf.status) && pf.tradingStatus === "OPEN";
  add("pfOpen", "Predict 市场可交易", pfOpen ? "pass" : "fail", `${pf.status}/${pf.tradingStatus}`);
  const pmOpen = pm.active && !pm.closed && pm.acceptingOrders;
  add("pmOpen", "Polymarket 市场可交易", pmOpen ? "pass" : "fail", `active=${pm.active} closed=${pm.closed} acceptingOrders=${pm.acceptingOrders}`);
  if (pf.feeExponent !== 1) add("feeExp", "Predict feeExponent", "warn", `feeExponent=${pf.feeExponent}（文档未说明，定价按指数 1 保守估算）`);

  // 8) 队伍与 outcome token
  const pfSides: TeamSide[] = pf.outcomes.map((o) => ({ idx: o.indexSet, label: o.team?.name ?? o.name, team: o.team }));
  const pmTeams = pm.event?.teams ?? [];
  const pmSides: TeamSide[] = pm.outcomes.map((label, i) => ({
    idx: i,
    label,
    team: pmTeams.find((t) => normName(t.name) === normName(label)) ?? pmTeams.find((t) => t.abbreviation && normName(t.abbreviation) === normName(label)) ?? null,
  }));
  const tm = matchTeams(pfSides, pmSides);
  let def: PairDefinition | null = null;
  if ("error" in tm) {
    add("teams", "队伍对应", "fail", tm.error);
  } else {
    add("teams", "队伍对应", tm.strength === "strong" ? "pass" : "warn", `${tm.detail}（${tm.strength === "strong" ? "队伍 ID/全名一致" : "仅缩写或宽松队名一致"}）`);
    const pmIdxA = tm.map.get(1) as 0 | 1;
    const pmIdxB = tm.map.get(2) as 0 | 1;
    const oA = pf.outcomes.find((o) => o.indexSet === 1)!;
    const oB = pf.outcomes.find((o) => o.indexSet === 2)!;
    if (!pm.assetIds[pmIdxA] || !pm.assetIds[pmIdxB]) add("tokens", "Polymarket outcome token", "fail", `version=${pm.version} 缺少代币 ID`);
    const pfRules = pf.description || cat.description;
    const pmRules = pm.description;
    const version = sha256(JSON.stringify([normalizeRules(pfRules), normalizeRules(pmRules), pf.outcomes.map((o) => o.onChainId), pm.assetIds, tPf, tPm]));
    def = {
      predict: {
        marketId: pf.id,
        categorySlug: pf.categorySlug,
        conditionId: pf.conditionId,
        tokens: { A: oA.onChainId, B: oB.onChainId },
        indexSet: { A: 1, B: 2 },
        isNegRisk: pf.isNegRisk,
        isYieldBearing: pf.isYieldBearing,
        feeRateBps: pf.feeRateBps,
        decimalPrecision: pf.decimalPrecision,
      },
      polymarket: {
        conditionId: pm.conditionId,
        marketId: pm.marketId,
        eventId: pm.eventId,
        version: pm.version,
        tokens: { A: pm.assetIds[pmIdxA] ?? "", B: pm.assetIds[pmIdxB] ?? "" },
        outcomeIndex: { A: pmIdxA, B: pmIdxB },
        negRisk: pm.negRisk,
      },
      labels: { A: oA.team?.name ?? oA.name, B: oB.team?.name ?? oB.name },
      game: gPf ?? gPm,
      marketType,
      bestOf: boPf ?? boPm,
      startTime,
      rules: { predict: pfRules, polymarket: pmRules, predictHash: sha256(normalizeRules(pfRules)), polymarketHash: sha256(normalizeRules(pmRules)) },
      versionTag: version.slice(0, 16),
    };
  }

  // 9) 规则条款与结算情形矩阵
  const pfRules = pf.description || cat.description;
  const pmRules = pm.description;
  const cPf = extractClauses(pfRules);
  const cPm = extractClauses(pmRules);
  const identical = normalizeRules(pfRules) === normalizeRules(pmRules);
  add("rulesText", "规则原文", identical ? "pass" : "warn", identical ? "两边规则原文一致" : "两边规则原文不同，逐条比对");
  const scenarios = settlementMatrix(cPf, cPm, { tiePossible: (boPf ?? boPm ?? 1) % 2 === 0, identicalText: identical, labels: def ? def.labels : { A: pf.outcomes[0]?.name ?? "A", B: pf.outcomes[1]?.name ?? "B" } });
  const mism = scenarios.filter((s) => s.verdict === "mismatch");
  const unk = scenarios.filter((s) => s.verdict === "unknown");
  if (mism.length) add("settle", "各结算情形合计兑付", "warn", `不一致：${mism.map((s) => `${s.label}（合计 ${s.total}）`).join("；")}`);
  else if (unk.length) add("settle", "各结算情形合计兑付", "warn", `无法判定：${unk.map((s) => s.label).join("；")}`);
  else add("settle", "各结算情形合计兑付", "pass", "所有情形合计兑付均为 1");
  const srcSame = cPf.resolutionSources.join(",") === cPm.resolutionSources.join(",");
  add("source", "结算数据源", srcSame ? "pass" : "warn", `Predict ${cPf.resolutionSources.join(",") || "-"}；Polymarket ${cPm.resolutionSources.join(",") || "-"}`);
  if (cat.resolutionProvider) add("resolver", "Predict 结算方", cat.resolutionProvider === "PREDICT_DOT_FUN" ? "pass" : "warn", cat.resolutionProvider);

  const rulesHash = sha256(JSON.stringify([def?.versionTag ?? "", cPf.normalizedHash, cPm.normalizedHash]));
  const fails = checks.filter((c) => c.level === "fail");
  const warns = checks.filter((c) => c.level === "warn");
  const status: Verification["status"] = fails.length || !def ? "REJECTED" : warns.length ? "PENDING_REVIEW" : "APPROVED";
  const reasons = [...fails, ...warns].map((c) => `${c.label}：${c.detail}`);
  return { def, verification: { status, reasons, checks, scenarios, clauses: { predict: cPf, polymarket: cPm }, rulesHash } };
}

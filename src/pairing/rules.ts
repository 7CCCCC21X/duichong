import { createHash } from "node:crypto";

/**
 * 从规则原文中提取与结算相关的条款。两边电竞规则都是英文模板文本（Predict 的电竞市场镜像自 Polymarket），
 * 这里用模式匹配提取；提取不到的条款记为 unknown，交给人工审核。
 */
export type Payout = "50-50" | "winner" | "result" | "no" | "unknown";

export interface RuleClauses {
  /** 比赛取消（完全没打） */
  cancelled: Payout;
  /** 平局 */
  tie: Payout;
  /** 延期窗口（小时），超过后按 postponedBeyond 结算 */
  postponeWindowHours: number | null;
  postponedBeyond: Payout;
  /** 开赛前弃权/取消资格/走过场 */
  forfeitBeforeStart: Payout;
  /** 开赛后未完赛、一方因对手弃权/取消资格获胜 */
  forfeitAfterStart: Payout;
  /** 开赛后未完赛（非弃权） */
  notCompleted: Payout;
  /** 结算数据源域名 */
  resolutionSources: string[];
  /** 是否有队名差异条款 */
  nameDiscrepancyClause: boolean;
  /** 是否为单局/单图盘口的规则 */
  mentionsSingleMap: boolean;
  normalizedHash: string;
}

export function normalizeRules(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const FIFTY = /(50-50|50\/50|fifty-fifty|equal split)/;

function sentenceWith(text: string, re: RegExp): string | null {
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) if (re.test(s)) return s;
  return null;
}

export function extractClauses(raw: string): RuleClauses {
  const t = normalizeRules(raw);
  const c: RuleClauses = {
    cancelled: "unknown",
    tie: "unknown",
    postponeWindowHours: null,
    postponedBeyond: "unknown",
    forfeitBeforeStart: "unknown",
    forfeitAfterStart: "unknown",
    notCompleted: "unknown",
    resolutionSources: [],
    nameDiscrepancyClause: /listed name includes minor discrepancies|name.*discrepanc/.test(t),
    mentionsSingleMap: /\b(map|game) \d+\b/.test(t) && /win (map|game) \d+/.test(t),
    normalizedHash: sha256(t),
  };

  const cancelS = sentenceWith(t, /cancel+ed/);
  if (cancelS) {
    if (FIFTY.test(cancelS)) c.cancelled = "50-50";
    else if (/resolve(s)? (to )?"?no"?/.test(cancelS)) c.cancelled = "no";
    if (/tie/.test(cancelS) && FIFTY.test(cancelS)) c.tie = "50-50";
  }
  if (c.tie === "unknown") {
    const tieS = sentenceWith(t, /\b(tie|draw)\b/);
    if (tieS && FIFTY.test(tieS)) c.tie = "50-50";
  }

  // 延期窗口：只在与延期/改期相关的句子里找 “14 calendar days” / “7-day (168-hour)” / “168 hours”
  if (/postpone/.test(t)) {
    const postSentences = t.split(/(?<=[.!?])\s+/).filter((x) => /postpone|reschedul|delay period/.test(x));
    const joined = postSentences.join(" ");
    const hoursM = joined.match(/(\d+)[- ]hours?\b/);
    const daysM = joined.match(/(\d+)[- ](calendar )?days?\b/);
    if (hoursM) c.postponeWindowHours = Number(hoursM[1]);
    else if (daysM) c.postponeWindowHours = Number(daysM[1]) * 24;
    const postS = sentenceWith(t, /(otherwise|more than \d+ hours|not .* within)[^.]*50-50|50-50, regardless/);
    if (postS && FIFTY.test(postS)) c.postponedBeyond = "50-50";
  }

  // 开赛前弃权：“ends in a forfeit, disqualification, or walkover (team withdraws before the start …), … 50-50”
  const fBefore = sentenceWith(t, /before the start/);
  if (fBefore) {
    if (/before the start/.test(fBefore) && FIFTY.test(fBefore)) c.forfeitBeforeStart = "50-50";
    else if (/before the start/.test(fBefore) && /team who (wins|advances)|resolve to the (team|winner)/.test(fBefore)) c.forfeitBeforeStart = "winner";
  }
  // 开赛后：“match begins but is not completed, and one team wins due to the opponent's forfeiture … resolve to the team who wins”
  const fAfter = sentenceWith(t, /begins but is not completed[^.]*(forfeit|disqualif|walkover)/);
  if (fAfter) {
    if (/team who wins|resolve to the (team|winner)/.test(fAfter)) c.forfeitAfterStart = "winner";
    else if (FIFTY.test(fAfter)) c.forfeitAfterStart = "50-50";
  }
  const nc = sentenceWith(t, /(not completed|is not completed for any reason)/);
  if (nc && !/forfeit|disqualif|walkover/.test(nc)) {
    if (FIFTY.test(nc)) c.notCompleted = "50-50";
    else if (/based on the completed/.test(nc)) c.notCompleted = "result";
  }

  const srcs = new Set<string>();
  for (const m of t.matchAll(/https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/g)) srcs.add(m[1]!);
  c.resolutionSources = [...srcs].sort();
  return c;
}

export type ScenarioVerdict = "consistent" | "mismatch" | "unknown";

export interface ScenarioResult {
  id: string;
  label: string;
  /** Predict 市场在该情形下对 [A, B] 的兑付 */
  predictLeg: string;
  /** Polymarket 市场在该情形下对 [A, B] 的兑付 */
  polymarketLeg: string;
  /** 互补组合“Predict 买 A + Polymarket 买 B”与“Predict 买 B + Polymarket 买 A”的合计兑付 */
  total: string;
  verdict: ScenarioVerdict;
  note?: string;
}

type Vec = [number, number] | null;

/**
 * 某条款在某情形下对结果 [A, B] 的兑付向量。
 * winner：winnerIsA 指定谁赢；no：标签为 No 的结果得 1（Yes/No 盘）；50-50：各 0.5。
 */
function vec(p: Payout, winnerIsA: boolean | null, labels: { A: string; B: string }): Vec {
  switch (p) {
    case "50-50":
      return [0.5, 0.5];
    case "winner":
    case "result":
      return winnerIsA === null ? null : winnerIsA ? [1, 0] : [0, 1];
    case "no": {
      const a = labels.A.trim().toLowerCase();
      const b = labels.B.trim().toLowerCase();
      if (b === "no" || a === "yes") return [0, 1];
      if (a === "no" || b === "yes") return [1, 0];
      return null;
    }
    default:
      return null;
  }
}

const fmt = (v: Vec) => (v ? `A ${v[0]} / B ${v[1]}` : "未写明");

/**
 * 结算情形矩阵：逐个情形求两边市场对 [A, B] 的兑付向量。
 * 两边向量相同 ⇔ 任意互补组合（Predict 买 X + Polymarket 买另一结果）合计兑付都为 1。
 */
export function settlementMatrix(
  pf: RuleClauses,
  pm: RuleClauses,
  opts: { tiePossible: boolean; identicalText: boolean; labels?: { A: string; B: string } },
): ScenarioResult[] {
  const labels = opts.labels ?? { A: "A", B: "B" };
  const out: ScenarioResult[] = [];
  const add = (id: string, label: string, a: Vec, b: Vec, note?: string) => {
    let verdict: ScenarioVerdict;
    if (a === null || b === null) verdict = opts.identicalText ? "consistent" : "unknown";
    else verdict = Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 ? "consistent" : "mismatch";
    const total = a && b ? `${a[0] + b[1]} / ${a[1] + b[0]}` : "-";
    out.push({
      id,
      label,
      predictLeg: fmt(a),
      polymarketLeg: fmt(b),
      total,
      verdict,
      note: a === null || b === null ? (opts.identicalText ? "两边规则原文一致，按同一方式结算" : note) : note,
    });
  };
  add("a-wins", `${labels.A} 正常获胜`, [1, 0], [1, 0]);
  add("b-wins", `${labels.B} 正常获胜`, [0, 1], [0, 1]);
  add("cancelled", "比赛取消（未开打）", vec(pf.cancelled, null, labels), vec(pm.cancelled, null, labels));
  if (opts.tiePossible) add("tie", "平局", vec(pf.tie, null, labels), vec(pm.tie, null, labels));
  const wPf = pf.postponeWindowHours;
  const wPm = pm.postponeWindowHours;
  if (wPf !== null && wPm !== null) {
    add("postponed-within", `延期且在两边窗口内（≤${Math.min(wPf, wPm)}h），按赛果`, [1, 0], [1, 0], "按实际赛果");
    if (wPf !== wPm) {
      const pfShort = wPf < wPm;
      for (const aWins of [true, false]) {
        const played: Vec = aWins ? [1, 0] : [0, 1];
        const a = pfShort ? vec(pf.postponedBeyond, null, labels) : played;
        const b = pfShort ? played : vec(pm.postponedBeyond, null, labels);
        add(`postponed-between-${aWins ? "a" : "b"}`, `延期 ${Math.min(wPf, wPm)}h~${Math.max(wPf, wPm)}h 且${aWins ? labels.A : labels.B}获胜`, a, b, `两边延期窗口不同（Predict ${wPf}h，Polymarket ${wPm}h）`);
      }
    }
    add("postponed-beyond", `延期超过两边窗口（>${Math.max(wPf, wPm)}h）`, vec(pf.postponedBeyond, null, labels), vec(pm.postponedBeyond, null, labels));
  } else if (wPf !== null || wPm !== null) {
    add("postponed", "延期", null, null, `只有一边写明延期窗口（Predict ${wPf ?? "-"}h，Polymarket ${wPm ?? "-"}h）`);
  } else {
    add("postponed", "延期", null, null, "未能提取延期窗口");
  }
  add("forfeit-before", "开赛前弃权/走过场", vec(pf.forfeitBeforeStart, null, labels), vec(pm.forfeitBeforeStart, null, labels));
  for (const aWins of [true, false]) {
    add(`forfeit-after-${aWins ? "a" : "b"}`, `开赛后对手弃权，${aWins ? labels.A : labels.B}获胜`, vec(pf.forfeitAfterStart, aWins, labels), vec(pm.forfeitAfterStart, aWins, labels));
  }
  add("not-completed", "开赛后未完赛（非弃权）", vec(pf.notCompleted, null, labels), vec(pm.notCompleted, null, labels));
  return out;
}

import { describe, expect, it } from "vitest";
import type { PfCategoryInfo, PfMarketInfo } from "../src/market/predictData.js";
import type { PmMarketInfo } from "../src/market/polymarketData.js";
import { extractClauses, settlementMatrix } from "../src/pairing/rules.js";
import { matchTeams, verifyPair } from "../src/pairing/verify.js";

// 两段真实规则原文（2026-11-11 从两边公开接口获取）
const PM_RULES_14D = `This market refers to the Counter-Strike match between HAVU and BoyBand in the Elisa Open Suomi Group Stage, initially scheduled for November 11, 2026 at 1:00 PM ET.

This market will resolve to "HAVU" if HAVU win the match against BoyBand.

This market will resolve to "BoyBand" if BoyBand win the match against HAVU.

If the match is canceled (not played at all) or ends in a tie, this market will resolve to 50-50.

If the match is postponed, it must be rescheduled to a start time on or before November 25, 2026 at 11:59 PM ET (14 calendar days after the originally scheduled start of November 11, 2026 at 1:00 PM ET). If, by that deadline, the most recently announced rescheduled start time is on or before the deadline, this market resolves based on the result of the match as played. Otherwise, this market resolves 50-50, regardless of whether the match is subsequently played.

If the match begins but is not completed, and one team wins due to the opponent's forfeiture, disqualification, or walkover, this market will resolve to the team who wins.

If the match ends in a forfeit, disqualification, or walkover (team withdraws before the start and the other wins automatically), this market will resolve to 50-50.

The resolution source for this market will be official information from https://hltv.org. However, if https://hltv.org has not published final results within 2 hours after the event's conclusion, a consensus of credible reporting may be used instead including video evidence.`;

const PF_RULES_7D = `This market refers to the Counter-Strike match between HAVU and BoyBand in the Elisa Open Suomi Group Stage, initially scheduled for November 11, 2026 at 1:00 PM ET.

This market will resolve to "HAVU" if HAVU win the match against BoyBand.

This market will resolve to "BoyBand" if BoyBand win the match against HAVU.

If the match is canceled (not played at all) or ends in a tie, this market will resolve to 50-50.

If the match is postponed, the 7-day (168-hour) delay period will be measured from the originally scheduled start time of November 11, 2026 at 1:00 PM ET to the rescheduled start time. If the rescheduled start time falls more than 168 hours after the originally scheduled start time, this market will resolve to 50-50, regardless of whether the match is subsequently played. If the match is rescheduled to a start time within 168 hours of the originally scheduled start time, this market will resolve based on the result of the match as played.

If the match begins but is not completed, and one team wins due to the opponent's forfeiture, disqualification, or walkover, this market will resolve to the team who wins.

If the match ends in a forfeit, disqualification, or walkover (team withdraws before the start and the other wins automatically), this market will resolve to 50-50.

The resolution source for this market will be official information from https://hltv.org. However, if https://hltv.org has not published final results within 2 hours after the event's conclusion, a consensus of credible reporting may be used instead including video evidence.`;

const START = Date.parse("2026-11-11T18:00:00Z");

function pfMarket(over: Partial<PfMarketInfo> = {}): PfMarketInfo {
  return {
    id: 9001,
    title: "Match Winner",
    question: "Counter-Strike: HAVU vs BoyBand (BO3) - Elisa Open Suomi Group Stage",
    description: PM_RULES_14D,
    categorySlug: "cs2-havu-boyban-2026-11-11",
    status: "REGISTERED",
    tradingStatus: "OPEN",
    isNegRisk: false,
    isYieldBearing: false,
    feeRateBps: 200,
    feeExponent: 1,
    decimalPrecision: 2,
    speedBump: null,
    marketType: "SPORTS_MONEYLINE",
    marketVariant: "ESPORTS_CS2",
    polymarketConditionIds: ["0xbf35e26668dfc985091d8745bb90bc93b51208f064a073a973942762de97c484"],
    conditionId: "0xpf",
    outcomes: [
      { name: "HAVU", indexSet: 1, onChainId: "111", status: null, team: { id: 1, name: "HAVU", abbreviation: "havu", providerTeamId: "177218" } },
      { name: "BOYBAN", indexSet: 2, onChainId: "222", status: null, team: { id: 2, name: "BoyBand", abbreviation: "boyban", providerTeamId: "3265481" } },
    ],
    line: null,
    gameNumber: null,
    raw: {},
    ...over,
  };
}

function pfCat(over: Partial<PfCategoryInfo> = {}): PfCategoryInfo {
  return {
    id: 1,
    slug: "cs2-havu-boyban-2026-11-11",
    title: "Counter-Strike: HAVU vs BoyBand (BO3) - Elisa Open Suomi Group Stage",
    description: "",
    startsAt: START,
    endsAt: null,
    status: "OPEN",
    marketVariant: "ESPORTS_CS2",
    resolutionProvider: "PREDICT_DOT_FUN",
    provider: "POLYMARKET",
    providerEventId: "1355310",
    teams: [],
    tags: ["Esports"],
    markets: [],
    raw: {},
    ...over,
  };
}

function pmMarket(over: Partial<PmMarketInfo> = {}): PmMarketInfo {
  return {
    marketId: "6927969",
    conditionId: "0xbf35e26668dfc985091d8745bb90bc93b51208f064a073a973942762de97c484",
    slug: "cs2-havu-boyban-2026-11-11",
    question: "Counter-Strike: HAVU vs BoyBand (BO3) - Elisa Open Suomi Group Stage",
    description: PM_RULES_14D,
    outcomes: ["HAVU", "BoyBand"],
    assetIds: ["280831", "108537"],
    version: "v1",
    sportsMarketType: "moneyline",
    groupItemTitle: "Match Winner",
    line: null,
    gameStartTime: START,
    eventStartTime: START,
    endDate: null,
    negRisk: false,
    acceptingOrders: true,
    active: true,
    closed: false,
    archived: false,
    orderMinSize: 5,
    tickSize: 0.01,
    secondsDelay: 1,
    feesEnabled: true,
    feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.15 },
    resolutionSource: "https://www.twitch.tv/x",
    umaResolutionStatus: null,
    fallbackResolutionType: "equal_split",
    clearBookOnStart: true,
    updatedAt: null,
    eventId: "1355310",
    event: {
      id: "1355310",
      slug: "cs2-havu-boyban-2026-11-11",
      title: "Counter-Strike: HAVU vs BoyBand (BO3) - Elisa Open Suomi Group Stage",
      startTime: START,
      seriesSlug: "counter-strike",
      tags: ["esports", "counter-strike-2"],
      teams: [
        { id: 177218, name: "HAVU", abbreviation: "havu", providerId: "125774", ordering: "home" },
        { id: 3265481, name: "BoyBand", abbreviation: "boyban", providerId: "138131", ordering: "away" },
      ],
      league: "Elisa Open Suomi",
      pandascoreMatchId: "1777593",
      resolutionSource: null,
      raw: {},
    },
    raw: {},
    ...over,
  };
}

const NOW = START - 3600_000;

describe("规则条款提取", () => {
  it("Polymarket 模板：取消/平局 50-50、延期 14 天、开赛前弃权 50-50、开赛后弃权判胜方、结算源 hltv", () => {
    const c = extractClauses(PM_RULES_14D);
    expect(c.cancelled).toBe("50-50");
    expect(c.tie).toBe("50-50");
    expect(c.postponeWindowHours).toBe(336);
    expect(c.postponedBeyond).toBe("50-50");
    expect(c.forfeitBeforeStart).toBe("50-50");
    expect(c.forfeitAfterStart).toBe("winner");
    expect(c.resolutionSources).toEqual(["hltv.org"]);
  });

  it("Predict 模板：延期 168 小时", () => {
    const c = extractClauses(PF_RULES_7D);
    expect(c.postponeWindowHours).toBe(168);
    expect(c.postponedBeyond).toBe("50-50");
  });

  it("延期窗口不同：延期落在 7~14 天之间时两腿合计兑付为 0.5 或 1.5", () => {
    const m = settlementMatrix(extractClauses(PF_RULES_7D), extractClauses(PM_RULES_14D), { tiePossible: false, identicalText: false });
    const between = m.filter((s) => s.id.startsWith("postponed-between"));
    expect(between).toHaveLength(2);
    expect(between.every((s) => s.verdict === "mismatch")).toBe(true);
    expect(between.map((s) => s.total).sort()).toEqual(["0.5", "1.5"]);
    expect(m.find((s) => s.id === "cancelled")!.verdict).toBe("consistent");
  });
});

describe("配对核对（落实到具体子盘口）", () => {
  it("两边一致：自动批准，记录队伍与 outcome token 对应关系", () => {
    const { def, verification } = verifyPair({ pf: pfMarket(), cat: pfCat(), pm: pmMarket(), now: NOW });
    expect(verification.status).toBe("APPROVED");
    expect(def!.predict.tokens).toEqual({ A: "111", B: "222" });
    expect(def!.polymarket.tokens).toEqual({ A: "280831", B: "108537" });
    expect(def!.labels).toEqual({ A: "HAVU", B: "BoyBand" });
    expect(def!.rules.polymarket).toContain("hltv.org");
  });

  it("Polymarket 结果顺序与 Predict 相反：按队伍交叉对应", () => {
    const pm = pmMarket({ outcomes: ["BoyBand", "HAVU"], assetIds: ["108537", "280831"] });
    const { def, verification } = verifyPair({ pf: pfMarket(), cat: pfCat(), pm, now: NOW });
    expect(verification.status).toBe("APPROVED");
    expect(def!.polymarket.tokens).toEqual({ A: "280831", B: "108537" });
    expect(def!.polymarket.outcomeIndex).toEqual({ A: 1, B: 0 });
  });

  it("规则延期窗口不同：进入待审核，列出不一致情形", () => {
    const { verification } = verifyPair({ pf: pfMarket({ description: PF_RULES_7D }), cat: pfCat(), pm: pmMarket(), now: NOW });
    expect(verification.status).toBe("PENDING_REVIEW");
    expect(verification.reasons.join("")).toContain("合计 0.5");
  });

  it("盘口类型不同（单局 vs 整场）：拒绝", () => {
    const { verification } = verifyPair({ pf: pfMarket(), cat: pfCat(), pm: pmMarket({ sportsMarketType: "child_moneyline", groupItemTitle: "Map 1 Winner" }), now: NOW });
    expect(verification.status).toBe("REJECTED");
  });

  it("conditionId 不在 Predict 声明列表中：拒绝", () => {
    const { verification } = verifyPair({ pf: pfMarket({ polymarketConditionIds: ["0x" + "11".repeat(32)] }), cat: pfCat(), pm: pmMarket(), now: NOW });
    expect(verification.status).toBe("REJECTED");
  });

  it("赛制不同（BO3 vs BO1）：拒绝", () => {
    const pm = pmMarket({ question: "Counter-Strike: HAVU vs BoyBand (BO1) - Elisa Open Suomi Group Stage" });
    pm.event!.title = pm.question;
    const { verification } = verifyPair({ pf: pfMarket(), cat: pfCat(), pm, now: NOW });
    expect(verification.status).toBe("REJECTED");
  });

  it("已开赛：拒绝（首版只做赛前）", () => {
    const { verification } = verifyPair({ pf: pfMarket(), cat: pfCat(), pm: pmMarket(), now: START + 60_000 });
    expect(verification.status).toBe("REJECTED");
  });

  it("队伍无法唯一对应：拒绝", () => {
    const r = matchTeams(
      [
        { idx: 1, label: "Alpha", team: null },
        { idx: 2, label: "Beta", team: null },
      ],
      [
        { idx: 0, label: "Gamma", team: null },
        { idx: 1, label: "Delta", team: null },
      ],
    );
    expect("error" in r).toBe(true);
  });
});

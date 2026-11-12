import { div, fx, ONE, toStr, type Fx } from "../core/fixed.js";
import type { Clock } from "../core/time.js";
import { bjTime } from "../core/time.js";
import type { Balances, VenueId } from "../core/types.js";
import { VENUES } from "../core/types.js";
import type { RiskConfig } from "../config/schema.js";
import type { Repo } from "../db/repo.js";

export interface PairCommitment {
  /** 挂单占用的抵押品（剩余数量 × 挂价） */
  makerReserved: Record<VenueId, Fx>;
  /** 为挂单全部成交预留的补单资金 */
  hedgeReserved: Record<VenueId, Fx>;
  /** 在途补单/平仓吃单的占用 */
  inflightReserved: Record<VenueId, Fx>;
  /** 持仓净花费 */
  positionSpend: Fx;
  /** 未对冲份额（绝对值） */
  unhedged: Fx;
}

export function emptyCommitment(): PairCommitment {
  return {
    makerReserved: { polymarket: 0n, predict: 0n },
    hedgeReserved: { polymarket: 0n, predict: 0n },
    inflightReserved: { polymarket: 0n, predict: 0n },
    positionSpend: 0n,
    unhedged: 0n,
  };
}

export interface VenueBlock {
  reason: string;
  since: number;
  /** 到期自动解除（毫秒时间戳），null 表示需要人工或条件解除 */
  until: number | null;
}

/**
 * 全局风控：资金预占、额度上限、停止新挂单开关、按平台的阻断（余额不足、授权失效、认证失败、事件流断开）。
 * JS 单线程，所有方法同步，调用期间不会交错。
 */
export class RiskManager {
  private commitments = new Map<string, PairCommitment>();
  private balances: Record<VenueId, Balances | null> = { polymarket: null, predict: null };
  private blocks: Record<VenueId, Map<string, VenueBlock>> = { polymarket: new Map(), predict: new Map() };
  private haltState: { reason: string; since: number } | null = null;
  private lossToday: { day: string; usd: Fx } = { day: "", usd: 0n };

  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    public global: RiskConfig,
  ) {
    const h = repo.getKv("risk.halt");
    if (h) this.haltState = JSON.parse(h) as { reason: string; since: number };
    const l = repo.getKv("risk.lossToday");
    if (l) {
      const parsed = JSON.parse(l) as { day: string; usd: string };
      this.lossToday = { day: parsed.day, usd: BigInt(parsed.usd) };
    }
  }

  /** 控制台修改全局风控参数后调用。 */
  setGlobal(r: RiskConfig): void {
    this.global = r;
  }

  // ---------------- 余额与预占 ----------------
  setBalances(v: VenueId, b: Balances): void {
    this.balances[v] = b;
  }

  getBalances(v: VenueId): Balances | null {
    return this.balances[v];
  }

  setCommitment(pairId: string, c: PairCommitment): void {
    this.commitments.set(pairId, c);
  }

  getCommitment(pairId: string): PairCommitment {
    return this.commitments.get(pairId) ?? emptyCommitment();
  }

  listCommitments(): [string, PairCommitment][] {
    return [...this.commitments.entries()];
  }

  removePair(pairId: string): void {
    this.commitments.delete(pairId);
  }

  /** 某平台扣除其他配对占用后可用的抵押品。 */
  availableFor(v: VenueId, excludePair: string | null): Fx {
    const b = this.balances[v];
    if (!b) return 0n;
    let used = 0n;
    for (const [id, c] of this.commitments) {
      if (id === excludePair) continue;
      used += c.makerReserved[v] + c.hedgeReserved[v] + c.inflightReserved[v];
    }
    const avail = b.available - used;
    return avail > 0n ? avail : 0n;
  }

  globalCommitted(excludePair: string | null): Fx {
    let t = 0n;
    for (const [id, c] of this.commitments) {
      if (id === excludePair) continue;
      t += c.positionSpend > 0n ? c.positionSpend : 0n;
      for (const v of VENUES) t += c.makerReserved[v] + c.hedgeReserved[v] + c.inflightReserved[v];
    }
    return t;
  }

  globalUnhedged(excludePair: string | null): Fx {
    let t = 0n;
    for (const [id, c] of this.commitments) if (id !== excludePair) t += c.unhedged;
    return t;
  }

  /**
   * 计算挂单份额上限。
   * perShareMaker：挂单每份占用；perShareHedge：对冲每份成本（含缓冲）。
   */
  capShares(args: {
    pairId: string;
    risk: RiskConfig;
    makerVenue: VenueId;
    hedgeVenue: VenueId;
    perShareMaker: Fx;
    perShareHedge: Fx;
    pairSpend: Fx;
    pairUnhedged: Fx;
  }): { cap: Fx; binding: string } {
    const { risk } = args;
    const caps: [string, Fx][] = [];
    caps.push(["单笔份额上限", fx(risk.maxOrderShares)]);
    if (args.perShareMaker > 0n) caps.push(["单笔金额上限", div(fx(risk.maxOrderUsd), args.perShareMaker, "floor")]);
    const perPair = args.perShareMaker + args.perShareHedge;
    if (perPair > 0n) {
      const matchRoom = fx(risk.maxMatchUsd) - (args.pairSpend > 0n ? args.pairSpend : 0n);
      caps.push(["单场资金上限", matchRoom > 0n ? div(matchRoom, perPair, "floor") : 0n]);
      const globalRoom = fx(risk.maxGlobalUsd) - this.globalCommitted(args.pairId) - (args.pairSpend > 0n ? args.pairSpend : 0n);
      caps.push(["全局资金上限", globalRoom > 0n ? div(globalRoom, perPair, "floor") : 0n]);
    }
    const unhedgedRoom = fx(risk.maxUnhedgedShares) - args.pairUnhedged;
    caps.push(["单配对未对冲上限", unhedgedRoom > 0n ? unhedgedRoom : 0n]);
    const gUnhedgedRoom = fx(risk.maxUnhedgedSharesGlobal) - this.globalUnhedged(args.pairId) - args.pairUnhedged;
    caps.push(["全局未对冲上限", gUnhedgedRoom > 0n ? gUnhedgedRoom : 0n]);
    if (args.perShareMaker > 0n) caps.push(["挂单平台可用余额", div(this.availableFor(args.makerVenue, args.pairId), args.perShareMaker, "floor")]);
    if (risk.reserveHedgeFunds && args.perShareHedge > 0n) {
      caps.push(["补单平台可用余额（预留补单资金）", div(this.availableFor(args.hedgeVenue, args.pairId), args.perShareHedge, "floor")]);
    }
    let best: [string, Fx] = caps[0]!;
    for (const c of caps) if (c[1] < best[1]) best = c;
    return { cap: best[1] > 0n ? best[1] : 0n, binding: best[0] };
  }

  // ---------------- 停止新挂单（全局） ----------------
  halt(reason: string): void {
    if (this.haltState) return;
    this.haltState = { reason, since: this.clock.now() };
    this.repo.setKv("risk.halt", JSON.stringify(this.haltState), this.clock.now());
  }

  resume(): void {
    this.haltState = null;
    this.repo.deleteKv("risk.halt");
  }

  get halted(): { reason: string; since: number } | null {
    return this.haltState;
  }

  // ---------------- 平台阻断 ----------------
  block(v: VenueId, code: string, reason: string, untilMs: number | null = null): void {
    const cur = this.blocks[v].get(code);
    if (cur && cur.reason === reason && cur.until === untilMs) return;
    this.blocks[v].set(code, { reason, since: cur?.since ?? this.clock.now(), until: untilMs });
  }

  unblock(v: VenueId, code: string): void {
    this.blocks[v].delete(code);
  }

  venueBlocked(v: VenueId): VenueBlock | null {
    const now = this.clock.now();
    for (const [code, b] of this.blocks[v]) {
      if (b.until !== null && b.until <= now) {
        this.blocks[v].delete(code);
        continue;
      }
      return b;
    }
    return null;
  }

  listBlocks(): { venue: VenueId; code: string; reason: string; since: number; until: number | null }[] {
    const out: { venue: VenueId; code: string; reason: string; since: number; until: number | null }[] = [];
    for (const v of VENUES) for (const [code, b] of this.blocks[v]) out.push({ venue: v, code, ...b });
    return out;
  }

  // ---------------- 亏损统计 ----------------
  private today(): string {
    return bjTime(this.clock.now()).slice(0, 10);
  }

  recordLoss(usd: Fx): void {
    if (usd <= 0n) return;
    const d = this.today();
    if (this.lossToday.day !== d) this.lossToday = { day: d, usd: 0n };
    this.lossToday.usd += usd;
    this.repo.setKv("risk.lossToday", JSON.stringify({ day: d, usd: this.lossToday.usd.toString() }), this.clock.now());
    if (this.lossToday.usd > fx(this.global.maxDailyLossUsd)) {
      this.halt(`当日亏损 ${toStr(this.lossToday.usd, 2)} 超过上限 ${this.global.maxDailyLossUsd}`);
    }
  }

  lossTodayUsd(): Fx {
    return this.lossToday.day === this.today() ? this.lossToday.usd : 0n;
  }

  /** 当日剩余可亏额度 */
  dailyLossRoom(): Fx {
    const room = fx(this.global.maxDailyLossUsd) - this.lossTodayUsd();
    return room > 0n ? room : 0n;
  }
}

export const ONE_USD = ONE;

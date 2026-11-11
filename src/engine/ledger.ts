import { div, mul, type Fx } from "../core/fixed.js";
import type { FeeParams, HedgeTrigger, Outcome, VenueFill, VenueId } from "../core/types.js";
import { VENUES } from "../core/types.js";
import type { FillRow, OrderRow } from "../db/repo.js";
import { buyFeeMode, netPerGrossShare, takerFeeUsd } from "../pricing/fees.js";

/**
 * 把适配器上报的成交转换为台账记录。
 * - 交易所给了实际手续费：直接使用，feeEstimated=false；
 * - 没给：maker 记 0（两边 maker 都不收费），taker 按公式估算并标记为估算值，结算回报到达后覆盖。
 */
export function toFillRow(vf: VenueFill, order: OrderRow, fee: FeeParams, now: number): FillRow {
  const gross = vf.grossShares;
  const price = vf.price;
  let feeShares: Fx = 0n;
  let feeCollateral: Fx = 0n;
  let feeEstimated = false;
  if (vf.feeShares !== null || vf.feeCollateral !== null) {
    feeShares = vf.feeShares ?? 0n;
    feeCollateral = vf.feeCollateral ?? 0n;
  } else if (!vf.isMaker) {
    feeEstimated = true;
    if (vf.side === "BUY") {
      if (buyFeeMode(fee) === "SHARES") {
        feeShares = gross - mul(gross, netPerGrossShare(fee, price), "floor");
      } else {
        feeCollateral = takerFeeUsd(fee, price, gross);
      }
    } else {
      feeCollateral = takerFeeUsd(fee, price, gross);
    }
  }
  const notional = mul(price, gross, "ceil");
  const feeUsd = feeCollateral + mul(feeShares, price, "ceil");
  const netShares = vf.side === "BUY" ? gross - feeShares : gross;
  const cashFlow = vf.side === "BUY" ? -(notional + feeCollateral) : mul(price, gross, "floor") - feeCollateral;
  return {
    key: vf.key,
    pairId: order.pairId,
    venue: vf.venue,
    orderId: order.id,
    venueOrderId: vf.venueOrderId ?? order.venueOrderId,
    role: order.role,
    outcome: order.outcome,
    side: vf.side,
    tokenId: vf.tokenId,
    price,
    grossShares: gross,
    feeShares,
    feeCollateral,
    feeUsd,
    feeEstimated,
    netShares,
    cashFlow,
    isMaker: vf.isMaker,
    status: vf.status,
    matchedAt: vf.matchedAt,
    updatedAt: now,
    txHash: vf.txHash,
    raw: vf.raw ?? null,
  };
}

/** 该笔成交是否计入敞口：失败不计；hedgeTrigger=settled 时只计结算成功的。 */
export function countsForExposure(f: FillRow, trigger: HedgeTrigger): boolean {
  if (f.status === "FAILED") return false;
  if (trigger === "settled") return f.status === "SETTLED";
  return true;
}

export type VenueOutcomeMap = Record<VenueId, Record<Outcome, Fx>>;

function zeroMap(): VenueOutcomeMap {
  return { polymarket: { A: 0n, B: 0n }, predict: { A: 0n, B: 0n } };
}

export interface Positions {
  /** 计入敞口的持仓（份） */
  shares: VenueOutcomeMap;
  /** 已撮合未结算的份额（展示用） */
  pending: VenueOutcomeMap;
  /** 已结算的份额 */
  settled: VenueOutcomeMap;
  /** 每个结果的净花费（买入花费 − 卖出所得），美元 */
  spend: Record<Outcome, Fx>;
  /** 每个结果的累计买入净份额（用于计算平均成本） */
  bought: Record<Outcome, Fx>;
  feesUsd: Fx;
  feesEstimatedUsd: Fx;
  fillCount: number;
}

export function computePositions(fills: readonly FillRow[], trigger: HedgeTrigger): Positions {
  const p: Positions = {
    shares: zeroMap(),
    pending: zeroMap(),
    settled: zeroMap(),
    spend: { A: 0n, B: 0n },
    bought: { A: 0n, B: 0n },
    feesUsd: 0n,
    feesEstimatedUsd: 0n,
    fillCount: 0,
  };
  for (const f of fills) {
    if (f.status === "FAILED") continue;
    const signed = f.side === "BUY" ? f.netShares : -f.netShares;
    if (f.status === "SETTLED") p.settled[f.venue][f.outcome] += signed;
    else p.pending[f.venue][f.outcome] += signed;
    if (!countsForExposure(f, trigger)) continue;
    p.shares[f.venue][f.outcome] += signed;
    p.spend[f.outcome] -= f.cashFlow;
    if (f.side === "BUY") p.bought[f.outcome] += f.netShares;
    p.feesUsd += f.feeUsd;
    if (f.feeEstimated) p.feesEstimatedUsd += f.feeUsd;
    p.fillCount++;
  }
  return p;
}

export function totalShares(p: Positions, o: Outcome): Fx {
  let s = 0n;
  for (const v of VENUES) s += p.shares[v][o];
  return s;
}

/** 净敞口（份）：A 总持仓 − B 总持仓。正数表示 A 多出未对冲，负数表示 B 多出。 */
export function netExposure(p: Positions): Fx {
  return totalShares(p, "A") - totalShares(p, "B");
}

/** 已对冲份数：两队持仓的较小者（每对兑付 1）。 */
export function hedgedShares(p: Positions): Fx {
  const a = totalShares(p, "A");
  const b = totalShares(p, "B");
  const m = a < b ? a : b;
  return m > 0n ? m : 0n;
}

/** 某结果持仓的平均成本（每份美元）。 */
export function avgCost(p: Positions, o: Outcome): Fx {
  const held = totalShares(p, o);
  if (held <= 0n) return 0n;
  return div(p.spend[o] > 0n ? p.spend[o] : 0n, held, "ceil");
}

export interface PnlSummary {
  hedged: Fx;
  netExposure: Fx;
  /** 总净花费（两腿） */
  totalSpend: Fx;
  /** 已锁定盈亏：已对冲部分按每对兑付 1 计算，扣除对应成本 */
  lockedPnl: Fx;
  /** 未对冲部分的成本 */
  residualCost: Fx;
  feesUsd: Fx;
}

export function pnlSummary(p: Positions): PnlSummary {
  const hedged = hedgedShares(p);
  const aHeld = totalShares(p, "A");
  const bHeld = totalShares(p, "B");
  const costA = avgCost(p, "A");
  const costB = avgCost(p, "B");
  const hedgedCost = mul(hedged, costA + costB, "ceil");
  const residualCost = mul(aHeld - hedged > 0n ? aHeld - hedged : 0n, costA, "ceil") + mul(bHeld - hedged > 0n ? bHeld - hedged : 0n, costB, "ceil");
  return {
    hedged,
    netExposure: aHeld - bHeld,
    totalSpend: p.spend.A + p.spend.B,
    lockedPnl: hedged - hedgedCost,
    residualCost,
    feesUsd: p.feesUsd,
  };
}

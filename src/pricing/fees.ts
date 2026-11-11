import { div, fx, mul, ONE, roundToStep, toNum, type Fx } from "../core/fixed.js";
import type { FeeParams } from "../core/types.js";

/**
 * 手续费模型（只有 taker 付费，两边 maker 都不收费）。
 *
 * Polymarket：fee = shares × rate × (p × (1 − p))^exponent，单位 pUSD，5 位小数。
 *   买单：手续费在成交额之外另付；卖单：从所得中扣。
 *   出处：https://docs.polymarket.com/trading/fees.md ，SDK 内部同样实现为 rate*(p*(1-p))**exponent。
 *
 * Predict：fee = feeRateBps/10000 × min(p, 1 − p) × shares，单位 USDT。
 *   买单：扣份额，少拿 fee/p 份；卖单：从所得中扣。
 *   出处：https://dev.predict.fun/trading/fees.md
 *   市场字段 feeExponent 文档未说明（实测出现 1、2），这里一律按文档公式（指数 1）估算，
 *   对 p∈(0,1) 它不低于任何指数更大的同峰曲线，属于保守估计。
 */

const PM_FEE_STEP = fx("0.00001");

export function takerFeeUsd(fee: FeeParams, price: Fx, shares: Fx): Fx {
  if (shares <= 0n || price <= 0n || price >= ONE) return 0n;
  if (fee.kind === "polymarket") {
    if (!fee.enabled || fee.rate <= 0n) return 0n;
    const pq = mul(price, ONE - price, "ceil");
    const curve = fee.exponent === 1 ? pq : fx(Math.pow(toNum(pq), fee.exponent).toFixed(18));
    const raw = mul(mul(shares, fee.rate, "ceil"), curve, "ceil");
    // 文档：5 位小数；未说明舍入方向，估算时向上取整
    return roundToStep(raw, PM_FEE_STEP, "ceil");
  }
  if (fee.rateBps <= 0) return 0n;
  const m = price < ONE - price ? price : ONE - price;
  const rate = (BigInt(fee.rateBps) * ONE) / 10_000n;
  return mul(mul(shares, rate, "ceil"), m, "ceil");
}

/** 买单手续费的收取形式。 */
export function buyFeeMode(fee: FeeParams): "COLLATERAL" | "SHARES" {
  return fee.kind === "polymarket" ? "COLLATERAL" : "SHARES";
}

/**
 * Predict 买单：每 1 份毛成交实际到账的净份额 = 1 − rate × min(p,1−p) / p。
 * Polymarket 买单：到账份额不扣，返回 1。
 */
export function netPerGrossShare(fee: FeeParams, price: Fx): Fx {
  if (fee.kind === "polymarket" || fee.rateBps <= 0 || price <= 0n) return ONE;
  const m = price < ONE - price ? price : ONE - price;
  const rate = (BigInt(fee.rateBps) * ONE) / 10_000n;
  const feeSharesPerShare = div(mul(rate, m, "ceil"), price, "ceil");
  return ONE - feeSharesPerShare;
}

/** 单价为 p 时，买到 1 份净份额的实际成本（含手续费）。 */
export function effectiveBuyPrice(fee: FeeParams, price: Fx): Fx {
  if (fee.kind === "polymarket") {
    return price + takerFeeUsd(fee, price, ONE);
  }
  const npg = netPerGrossShare(fee, price);
  if (npg <= 0n) return ONE * 1000n;
  return div(price, npg, "ceil");
}

/** 单价为 p 时，卖出 1 份的实际所得（扣手续费）。 */
export function effectiveSellPrice(fee: FeeParams, price: Fx): Fx {
  return price - takerFeeUsd(fee, price, ONE);
}

/**
 * 给定每份实际成本上限 cap，求最高可用的原始挂价（按 tick 向下取整）。
 * 两种费率模型下有效成本都随价格单调递增，可二分。
 */
export function maxRawPriceForEffectiveCap(fee: FeeParams, cap: Fx, tick: Fx): Fx | null {
  if (cap <= 0n) return null;
  let lo = 1n;
  let hi = (ONE - 1n) / tick; // 单位：tick 数
  const capTicks = cap / tick;
  if (capTicks < hi) hi = capTicks;
  if (hi < lo) return null;
  let best: bigint | null = null;
  while (lo <= hi) {
    const midTicks = (lo + hi) / 2n;
    const p = midTicks * tick;
    if (effectiveBuyPrice(fee, p) <= cap) {
      best = p;
      lo = midTicks + 1n;
    } else {
      hi = midTicks - 1n;
    }
  }
  return best;
}

/** 给定每份最低实际所得 floor，求最低可接受的原始卖价（按 tick 向上取整）。 */
export function minRawPriceForEffectiveFloor(fee: FeeParams, floorEff: Fx, tick: Fx): Fx | null {
  let lo = 1n;
  let hi = (ONE - 1n) / tick;
  let best: bigint | null = null;
  while (lo <= hi) {
    const midTicks = (lo + hi) / 2n;
    const p = midTicks * tick;
    if (effectiveSellPrice(fee, p) >= floorEff) {
      best = p;
      hi = midTicks - 1n;
    } else {
      lo = midTicks + 1n;
    }
  }
  return best;
}

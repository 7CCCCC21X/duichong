import { div, mul, ONE, roundToStep, type Fx } from "../core/fixed.js";
import type { FeeParams, Level } from "../core/types.js";
import { buyFeeMode, netPerGrossShare, takerFeeUsd } from "./fees.js";

export interface BuyWalk {
  /** 到账净份额 */
  netShares: Fx;
  /** 毛成交份额 */
  grossShares: Fx;
  /** 成交额 Σ p×q */
  notional: Fx;
  /** 手续费折合美元 */
  feeUsd: Fx;
  /** 份额形式的手续费（Predict） */
  feeShares: Fx;
  /** 抵押品形式另付的手续费（Polymarket） */
  feeCollateral: Fx;
  /** 总花费 = 成交额 + 另付手续费 */
  totalCost: Fx;
  /** 每份净份额的平均实际成本 */
  avgEffPrice: Fx;
  worstPrice: Fx;
  complete: boolean;
  levels: number;
}

/**
 * 按订单簿逐档计算买到 targetNet 份“净到账份额”的成本。
 * asks 必须按价格从低到高排列。maxPrice 为原始价格上限。
 */
export function walkBuy(asks: readonly Level[], targetNet: Fx, fee: FeeParams, opts: { maxPrice?: Fx | null } = {}): BuyWalk {
  const mode = buyFeeMode(fee);
  let net = 0n;
  let gross = 0n;
  let notional = 0n;
  let feeUsd = 0n;
  let feeShares = 0n;
  let feeCollateral = 0n;
  let worst = 0n;
  let used = 0;
  for (const lvl of asks) {
    if (net >= targetNet) break;
    if (lvl.size <= 0n || lvl.price <= 0n || lvl.price >= ONE) continue;
    if (opts.maxPrice != null && lvl.price > opts.maxPrice) break;
    const remaining = targetNet - net;
    let g: Fx;
    let n: Fx;
    if (mode === "COLLATERAL") {
      g = remaining < lvl.size ? remaining : lvl.size;
      n = g;
      const f = takerFeeUsd(fee, lvl.price, g);
      feeCollateral += f;
      feeUsd += f;
    } else {
      const npg = netPerGrossShare(fee, lvl.price);
      if (npg <= 0n) continue;
      const need = div(remaining, npg, "ceil");
      g = need < lvl.size ? need : lvl.size;
      n = mul(g, npg, "floor");
      if (n > remaining) n = remaining;
      feeShares += g - n;
      feeUsd += takerFeeUsd(fee, lvl.price, g);
    }
    gross += g;
    net += n;
    notional += mul(lvl.price, g, "ceil");
    worst = lvl.price;
    used++;
  }
  const totalCost = notional + feeCollateral;
  return {
    netShares: net,
    grossShares: gross,
    notional,
    feeUsd,
    feeShares,
    feeCollateral,
    totalCost,
    avgEffPrice: net > 0n ? div(totalCost, net, "ceil") : 0n,
    worstPrice: worst,
    complete: net >= targetNet,
    levels: used,
  };
}

export interface SellWalk {
  soldShares: Fx;
  notional: Fx;
  feeUsd: Fx;
  /** 扣手续费后的所得 */
  proceeds: Fx;
  avgEffPrice: Fx;
  worstPrice: Fx;
  complete: boolean;
}

/** 按订单簿逐档计算卖出 shares 份的所得。bids 必须按价格从高到低。 */
export function walkSell(bids: readonly Level[], shares: Fx, fee: FeeParams, opts: { minPrice?: Fx | null } = {}): SellWalk {
  let sold = 0n;
  let notional = 0n;
  let feeUsd = 0n;
  let worst = 0n;
  for (const lvl of bids) {
    if (sold >= shares) break;
    if (lvl.size <= 0n || lvl.price <= 0n || lvl.price >= ONE) continue;
    if (opts.minPrice != null && lvl.price < opts.minPrice) break;
    const q = shares - sold < lvl.size ? shares - sold : lvl.size;
    sold += q;
    notional += mul(lvl.price, q, "floor");
    feeUsd += takerFeeUsd(fee, lvl.price, q);
    worst = lvl.price;
  }
  const proceeds = notional - feeUsd;
  return {
    soldShares: sold,
    notional,
    feeUsd,
    proceeds,
    avgEffPrice: sold > 0n ? div(proceeds, sold, "floor") : 0n,
    worstPrice: worst,
    complete: sold >= shares,
  };
}

/** 订单簿在价格上限内能提供的最大净份额。 */
export function depthWithin(asks: readonly Level[], fee: FeeParams, maxPrice: Fx | null): Fx {
  let net = 0n;
  for (const lvl of asks) {
    if (lvl.size <= 0n || lvl.price <= 0n || lvl.price >= ONE) continue;
    if (maxPrice != null && lvl.price > maxPrice) break;
    net += mul(lvl.size, netPerGrossShare(fee, lvl.price), "floor");
  }
  return net;
}

export function floorShares(x: Fx, step: Fx): Fx {
  return roundToStep(x, step, "floor");
}

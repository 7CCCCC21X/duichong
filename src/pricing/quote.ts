import { div, mul, ONE, roundToStep, toStr, type Fx } from "../core/fixed.js";
import type { Book, VenueMarketMeta } from "../core/types.js";
import { walkBuy } from "./walk.js";

export type PriceMode = "fixed" | "auto" | "max";

export interface QuoteInput {
  makerMeta: VenueMarketMeta;
  hedgeMeta: VenueMarketMeta;
  /** 挂单品种（要买入的结果）的订单簿 */
  makerBook: Book;
  /** 对冲品种（另一边的互补结果）的订单簿 */
  hedgeBook: Book;
  /** 配置的目标挂单份额 */
  targetShares: Fx;
  /** 由风控与资金计算出的份额上限 */
  capShares: Fx;
  priceMode: PriceMode;
  fixedPrice: Fx | null;
  minMakerPrice: Fx | null;
  maxMakerPrice: Fx | null;
  improveTicks: number;
  /** 每对（1 份挂单 + 1 份对冲）至少要赚的金额（费后） */
  minProfitPerShare: Fx;
  /** 对冲价格滑点缓冲（价格单位，按份额计入成本） */
  hedgeSlippage: Fx;
  /** 额外风险缓冲（每份） */
  riskBufferPerShare: Fx;
  /** 结算资产换算缓冲（基点），作用在两腿总成本上 */
  fxBufferBps: number;
  /** 对冲腿原始价格硬上限 */
  maxHedgePrice: Fx;
}

export interface QuoteOk {
  ok: true;
  price: Fx;
  size: Fx;
  /** 对冲每份平均实际成本（含费，不含缓冲） */
  hedgeAvgEffPrice: Fx;
  hedgeWorstPrice: Fx;
  hedgeCostTotal: Fx;
  /** 含缓冲的对冲每份成本 */
  hedgeCostWithBuffers: Fx;
  /** 盈利上限对应的最高挂价 */
  makerPriceMax: Fx;
  expectedProfitPerShare: Fx;
  expectedProfitTotal: Fx;
  notes: string[];
}

export interface QuoteFail {
  ok: false;
  reason: string;
}

export type Quote = QuoteOk | QuoteFail;

function bestBid(b: Book): Fx | null {
  return b.bids[0]?.price ?? null;
}
function bestAsk(b: Book): Fx | null {
  return b.asks[0]?.price ?? null;
}

/**
 * 计算挂单价格与数量。
 *
 * 条件：size × 1 − (挂单成本 + 对冲成本 + 缓冲) × (1 + fx) ≥ size × minProfit。
 * 解出最高挂价 p_max = (1 − minProfit)/(1 + fx) − 对冲每份成本(含缓冲)，按 tick 向下取整。
 * 数量受目标、风控资金上限、对冲深度（在对冲价格硬上限内）共同限制。
 */
export function computeQuote(q: QuoteInput): Quote {
  const notes: string[] = [];
  const makerTick = q.makerMeta.tickSize;
  let size = roundToStep(q.targetShares < q.capShares ? q.targetShares : q.capShares, q.makerMeta.shareStep, "floor");
  if (size <= 0n) return { ok: false, reason: `可挂数量为 0（目标 ${toStr(q.targetShares)}，上限 ${toStr(q.capShares)}）` };
  if (!q.makerMeta.acceptingOrders) return { ok: false, reason: `挂单市场不接受订单（${q.makerMeta.statusText}）` };
  if (!q.hedgeMeta.acceptingOrders || q.hedgeMeta.postOnlyOnly) {
    return { ok: false, reason: `对冲市场当前不能吃单（${q.hedgeMeta.statusText}）` };
  }

  // 1) 对冲深度：在价格硬上限内能买到的净份额
  let walk = walkBuy(q.hedgeBook.asks, size, q.hedgeMeta.fee, { maxPrice: q.maxHedgePrice });
  if (!walk.complete) {
    const depth = roundToStep(walk.netShares, q.makerMeta.shareStep, "floor");
    if (depth <= 0n) return { ok: false, reason: `对冲盘在上限 ${toStr(q.maxHedgePrice)} 内无深度` };
    notes.push(`对冲深度不足，数量由 ${toStr(size)} 降为 ${toStr(depth)}`);
    size = depth;
    walk = walkBuy(q.hedgeBook.asks, size, q.hedgeMeta.fee, { maxPrice: q.maxHedgePrice });
    if (!walk.complete) return { ok: false, reason: "对冲深度计算异常" };
  }

  // 2) 含缓冲的对冲成本
  const buffers = mul(q.hedgeSlippage + q.riskBufferPerShare, size, "ceil");
  const hedgeCostWithBuffers = div(walk.totalCost + buffers, size, "ceil");
  const fxFactor = ONE + (BigInt(Math.max(0, Math.round(q.fxBufferBps))) * ONE) / 10_000n;
  const grossAllowance = div(ONE - q.minProfitPerShare, fxFactor, "floor");
  const rawMax = grossAllowance - hedgeCostWithBuffers;
  const makerPriceMax = roundToStep(rawMax, makerTick, "floor");
  if (makerPriceMax <= 0n) {
    return {
      ok: false,
      reason: `无利润空间：对冲每份成本 ${toStr(hedgeCostWithBuffers, 4)}，要求利润 ${toStr(q.minProfitPerShare, 4)}`,
    };
  }

  // 3) 按模式定价
  let price: Fx;
  if (q.priceMode === "fixed") {
    if (q.fixedPrice == null) return { ok: false, reason: "固定价模式未配置价格" };
    price = roundToStep(q.fixedPrice, makerTick, "floor");
    if (price > makerPriceMax) {
      return {
        ok: false,
        reason: `固定价 ${toStr(price, 4)} 高于盈利上限 ${toStr(makerPriceMax, 4)}（对冲成本 ${toStr(hedgeCostWithBuffers, 4)}）`,
      };
    }
  } else if (q.priceMode === "max") {
    price = makerPriceMax;
  } else {
    const bb = bestBid(q.makerBook);
    price = bb == null ? makerPriceMax : bb + makerTick * BigInt(q.improveTicks);
    if (price > makerPriceMax) price = makerPriceMax;
  }
  if (q.maxMakerPrice != null && price > q.maxMakerPrice) price = roundToStep(q.maxMakerPrice, makerTick, "floor");

  // 4) post-only：不得触及对手最优卖价
  const ba = bestAsk(q.makerBook);
  if (ba != null && price >= ba) {
    price = ba - makerTick;
    notes.push(`为保证只挂单，价格下调到卖一下方 ${toStr(price, 4)}`);
  }
  if (price <= 0n) return { ok: false, reason: "挂价不大于 0" };
  if (q.minMakerPrice != null && price < q.minMakerPrice) {
    return { ok: false, reason: `挂价 ${toStr(price, 4)} 低于配置下限 ${toStr(q.minMakerPrice, 4)}` };
  }

  // 5) 最小订单（两边都要能下）
  const minErr = checkMinOrder(q.makerMeta, price, size, "BUY");
  if (minErr) return { ok: false, reason: `挂单${minErr}` };
  const hedgeMinErr = checkMinOrder(q.hedgeMeta, walk.worstPrice, size, "BUY");
  if (hedgeMinErr) return { ok: false, reason: `对冲${hedgeMinErr}` };

  // 预期利润（不含缓冲）：size × 1 − 挂单成本 − 对冲总成本
  const expectedProfitTotal = size - mul(price, size, "ceil") - walk.totalCost;
  return {
    ok: true,
    price,
    size,
    hedgeAvgEffPrice: walk.avgEffPrice,
    hedgeWorstPrice: walk.worstPrice,
    hedgeCostTotal: walk.totalCost,
    hedgeCostWithBuffers,
    makerPriceMax,
    expectedProfitPerShare: ONE - price - walk.avgEffPrice,
    expectedProfitTotal,
    notes,
  };
}

/** 检查最小订单约束，返回错误描述或 null。 */
export function checkMinOrder(meta: VenueMarketMeta, price: Fx, shares: Fx, side: "BUY" | "SELL", taker = false): string | null {
  if (shares <= 0n) return "数量为 0";
  if (side === "BUY") {
    if (meta.minOrderShares > 0n && shares < meta.minOrderShares) {
      return `数量 ${toStr(shares)} 低于最小 ${toStr(meta.minOrderShares)} 份`;
    }
    if (meta.minBuyValue > 0n && mul(price, shares, "floor") < meta.minBuyValue) {
      return `金额 ${toStr(mul(price, shares), 4)} 低于最小 ${toStr(meta.minBuyValue)}`;
    }
    return null;
  }
  const minSell = taker ? meta.minTakerSellShares : meta.minLimitSellShares;
  if (minSell > 0n && shares < minSell) return `卖出数量 ${toStr(shares)} 低于最小 ${toStr(minSell)} 份`;
  return null;
}

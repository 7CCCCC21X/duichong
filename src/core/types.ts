import type { Fx } from "./fixed.js";

export type VenueId = "polymarket" | "predict";
export const VENUES: readonly VenueId[] = ["polymarket", "predict"] as const;
export const VENUE_LABEL: Record<VenueId, string> = { polymarket: "Polymarket", predict: "Predict" };

export function otherVenue(v: VenueId): VenueId {
  return v === "polymarket" ? "predict" : "polymarket";
}

export type Side = "BUY" | "SELL";

/** 配对层面的结果：A / B 分别对应配对定义中的两支队伍。 */
export type Outcome = "A" | "B";

export function otherOutcome(o: Outcome): Outcome {
  return o === "A" ? "B" : "A";
}

export interface Level {
  price: Fx;
  /** 份额 */
  size: Fx;
}

/** 某个结果代币的订单簿。bids 按价格从高到低，asks 从低到高。 */
export interface Book {
  bids: Level[];
  asks: Level[];
  /** 交易所给出的时间戳（毫秒），没有则为接收时间 */
  exchangeTs: number;
  receivedAt: number;
  source: "ws" | "rest" | "sim";
}

export function emptyBook(now: number, source: Book["source"] = "rest"): Book {
  return { bids: [], asks: [], exchangeTs: now, receivedAt: now, source };
}

/** 手续费参数（每个市场不同）。 */
export type FeeParams =
  | { kind: "polymarket"; rate: Fx; exponent: number; enabled: boolean }
  | { kind: "predict"; rateBps: number; exponent: number };

/** 某一边某个市场的交易约束（已从市场元数据归一化）。 */
export interface VenueMarketMeta {
  venue: VenueId;
  /** Polymarket: conditionId；Predict: 市场 ID（字符串） */
  marketKey: string;
  tickSize: Fx;
  /** 份额步长（下单时份额向下取整到此步长） */
  shareStep: Fx;
  /** 最小下单份额（买、卖均适用；Predict 为 0，改用 minBuyValue 判断） */
  minOrderShares: Fx;
  /** 最小买单价值（Predict 为 1 USDT） */
  minBuyValue: Fx;
  /** 吃单卖出最小份额（Predict 市价卖 0.01） */
  minTakerSellShares: Fx;
  /** 挂单卖出最小份额（Predict 限价卖 1） */
  minLimitSellShares: Fx;
  fee: FeeParams;
  /** 吃单撮合延迟（毫秒） */
  takerDelayMs: number;
  acceptingOrders: boolean;
  /** 只接受 post-only（例如 Predict MATCHING_NOT_ENABLED） */
  postOnlyOnly: boolean;
  negRisk: boolean;
  isYieldBearing: boolean;
  /** Polymarket 市场版本 v1(CTF)/v2 */
  protocolVersion?: "v1" | "v2";
  /** 比赛开始时间（毫秒） */
  startTime: number | null;
  /** 开赛清空订单簿（Polymarket cbos） */
  clearBookOnStart: boolean;
  /** 状态说明，例如 PAUSED / CLOSED */
  statusText: string;
  updatedAt: number;
}

/** 配对中的一个可交易品种：某一边的某个结果代币。 */
export interface Instrument {
  venue: VenueId;
  outcome: Outcome;
  /** 下单使用的代币 ID：Polymarket assetId（v1 clobTokenId / v2 positionId）；Predict onChainId */
  tokenId: string;
  /** Polymarket conditionId 或 Predict 市场 ID */
  marketKey: string;
  /** Predict: 1 或 2；Polymarket: 0 或 1（outcomes 数组下标） */
  outcomeIndex: number;
  label: string;
}

export type OrderRole = "MAKER" | "HEDGE" | "UNWIND";
export type OrderKind = "LIMIT" | "TAKER";

export type OrderStatus =
  | "INTENT" // 已落库，尚未签名
  | "PREPARED" // 已签名，已保存可查询标识
  | "SENDING" // 请求已发出
  | "ACCEPTED" // 交易所已受理
  | "PARTIAL" // 部分成交，仍在簿上
  | "CANCEL_REQUESTED"
  | "FILLED"
  | "CANCELLED"
  | "EXPIRED"
  | "REJECTED"
  | "UNKNOWN" // 发送超时或网络错误，状态未知，需要查单
  | "NOT_FOUND"; // 查单确认交易所没有这笔订单

export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "FILLED",
  "CANCELLED",
  "EXPIRED",
  "REJECTED",
  "NOT_FOUND",
]);

export function isTerminalOrder(s: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.has(s);
}

/** 成交状态：撮合 → 上链 → 结算成功 / 失败。 */
export type FillStatus = "MATCHED" | "MINED" | "RETRYING" | "SETTLED" | "FAILED";

export function isTerminalFill(s: FillStatus): boolean {
  return s === "SETTLED" || s === "FAILED";
}

export type HedgeTrigger = "matched" | "settled";

/** 适配器上报的标准化成交（只包含属于本账户订单的部分）。 */
export interface VenueFill {
  /** 去重键，同一笔成交在任何推送路径下都必须相同 */
  key: string;
  venue: VenueId;
  venueOrderId: string | null;
  orderHash: string | null;
  tokenId: string;
  side: Side;
  price: Fx;
  /** 撮合份额（未扣除份额手续费） */
  grossShares: Fx;
  /** 手续费：份额形式（Predict 买单） */
  feeShares: Fx | null;
  /** 手续费：抵押品形式（Polymarket 买单另付、两边卖单扣减） */
  feeCollateral: Fx | null;
  isMaker: boolean;
  status: FillStatus;
  matchedAt: number;
  txHash: string | null;
  raw?: unknown;
}

export type VenueOrderStatus = "OPEN" | "FILLED" | "CANCELLED" | "EXPIRED" | "INVALIDATED" | "NOT_FOUND" | "DELAYED";

export interface VenueOrderState {
  venueOrderId: string | null;
  hash: string | null;
  status: VenueOrderStatus;
  tokenId?: string;
  side?: Side;
  price?: Fx;
  size?: Fx;
  /** 已撮合份额 */
  filled: Fx;
  createdAt?: number;
}

export type VenueEvent =
  | { type: "order"; venue: VenueId; state: VenueOrderState; reason?: string; ts: number }
  | { type: "fill"; venue: VenueId; fill: VenueFill; ts: number }
  | { type: "stream"; venue: VenueId; channel: "user"; up: boolean; ts: number; reason?: string }
  | { type: "plan"; venue: VenueId; venueOrderId: string | null; hash: string | null; plannedFill: Fx; ts: number };

export interface Balances {
  /** 抵押品总余额（USDT / pUSD） */
  collateral: Fx;
  /** 可用（扣除交易所认定的占用后），拿不到时等于 collateral */
  available: Fx;
  updatedAt: number;
}

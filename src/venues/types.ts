import type { Fx } from "../core/fixed.js";
import type { Balances, Side, VenueEvent, VenueFill, VenueId, VenueMarketMeta, VenueOrderState } from "../core/types.js";

/** 挂单请求（post-only 限价买/卖）。 */
export interface LimitOrderRequest {
  clientOrderId: string;
  tokenId: string;
  side: Side;
  price: Fx;
  size: Fx;
  postOnly: boolean;
  /** 到期时间（毫秒），null 表示不过期 */
  expiresAt: number | null;
  meta: VenueMarketMeta;
}

/**
 * 吃单请求。
 * - 买：limitPrice 为最高成交价；shares 为目标净份额；amountUsd 为按金额下单时的花费（Polymarket FAK 买）。
 * - 卖：limitPrice 为最低成交价；shares 为卖出份额。
 */
export interface TakerOrderRequest {
  clientOrderId: string;
  tokenId: string;
  side: Side;
  shares: Fx;
  limitPrice: Fx;
  amountUsd: Fx | null;
  meta: VenueMarketMeta;
  /** 订单簿快照，用于按深度计算金额与滑点 */
  bookLevels: { price: Fx; size: Fx }[];
}

/** 已签名、尚未发送的订单。hash 在发送前即可得到（Predict 一定有；Polymarket 为本地推导值）。 */
export interface PreparedOrder {
  clientOrderId: string;
  hash: string | null;
  /** 实际签名的价格与数量（经过精度截断） */
  price: Fx;
  size: Fx;
  amountUsd: Fx | null;
  /** 适配器内部使用的载荷（可序列化保存） */
  payload: unknown;
  expiresAt: number | null;
}

export interface SubmitResult {
  accepted: boolean;
  venueOrderId: string | null;
  hash: string | null;
  /** live / matched / delayed / unmatched / rejected */
  status: "LIVE" | "MATCHED" | "DELAYED" | "UNMATCHED" | "REJECTED";
  /** 回执中已成交的份额（Polymarket takingAmount / makingAmount 等） */
  reportedFilledShares: Fx | null;
  reportedSpentUsd: Fx | null;
  tradeIds: string[];
  rejectReason: string | null;
  /** 拒单是否可以稍后重试（例如撮合引擎重启、限流） */
  retryable: boolean;
  retryAfterMs: number | null;
  /** 拒单分类，用于风控处理 */
  errorClass: VenueErrorClass | null;
}

export type VenueErrorClass =
  | "INSUFFICIENT_BALANCE"
  | "ALLOWANCE"
  | "AUTH"
  | "RATE_LIMIT"
  | "MARKET_CLOSED"
  | "POST_ONLY_CROSS"
  | "MIN_SIZE"
  | "PRICE"
  | "RESTARTING"
  | "DUPLICATE"
  | "NETWORK"
  | "OTHER";

export class VenueError extends Error {
  constructor(
    message: string,
    readonly errorClass: VenueErrorClass,
    readonly retryAfterMs: number | null = null,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VenueError";
  }
}

export interface CancelResult {
  cancelled: string[];
  /** 已经是终态（已成交/已撤）或不存在 */
  noop: string[];
  /** 暂时不能撤（如 Predict 撤单锁定期、Polymarket 延迟撮合期） */
  rejected: string[];
}

export interface PositionInfo {
  tokenId: string;
  shares: Fx;
}

/** 两边实盘与模拟交易所共同实现的交易接口。 */
export interface TradingVenue {
  readonly venue: VenueId;
  readonly isSimulated: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: (e: VenueEvent) => void): void;
  /** 签名并计算标识，不发网络请求下单 */
  prepareLimit(req: LimitOrderRequest): Promise<PreparedOrder>;
  prepareTaker(req: TakerOrderRequest): Promise<PreparedOrder>;
  submit(prepared: PreparedOrder, kind: "LIMIT" | "TAKER", req: LimitOrderRequest | TakerOrderRequest): Promise<SubmitResult>;
  cancel(refs: { venueOrderId: string | null; hash: string | null }[]): Promise<CancelResult>;
  getOrder(ref: { venueOrderId: string | null; hash: string | null; tokenId?: string }): Promise<VenueOrderState>;
  listOpenOrders(tokenIds: string[]): Promise<VenueOrderState[]>;
  listFills(sinceMs: number, tokenIds: string[]): Promise<VenueFill[]>;
  getBalances(): Promise<Balances>;
  getPositions(tokenIds: string[]): Promise<PositionInfo[]>;
  /** 用户事件流是否在线、认证是否有效 */
  health(): { userStreamUp: boolean; authOk: boolean; lastError: string | null };
}

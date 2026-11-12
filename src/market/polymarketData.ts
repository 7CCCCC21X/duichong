import type { Logger } from "pino";
import { fx, ONE, type Fx } from "../core/fixed.js";
import { parseTime } from "../core/time.js";
import type { Book, Level, VenueMarketMeta } from "../core/types.js";
import { httpJson } from "./http.js";
import { sortBook, type BookStore } from "./bookStore.js";
import { ResilientWs } from "./ws.js";

export interface PmTeam {
  id: number | null;
  name: string;
  abbreviation: string | null;
  providerId: string | null;
  ordering: string | null;
}

export interface PmEventInfo {
  id: string;
  slug: string;
  title: string;
  startTime: number | null;
  seriesSlug: string | null;
  tags: string[];
  teams: PmTeam[];
  league: string | null;
  pandascoreMatchId: string | null;
  resolutionSource: string | null;
  raw: unknown;
}

export interface PmMarketInfo {
  marketId: string;
  conditionId: string;
  slug: string;
  question: string;
  description: string;
  outcomes: string[];
  /** 按 version 选择的下单代币 ID（与 outcomes 同序） */
  assetIds: string[];
  version: "v1" | "v2";
  sportsMarketType: string | null;
  groupItemTitle: string | null;
  line: number | null;
  gameStartTime: number | null;
  eventStartTime: number | null;
  endDate: number | null;
  negRisk: boolean;
  acceptingOrders: boolean;
  active: boolean;
  closed: boolean;
  archived: boolean;
  orderMinSize: number | null;
  tickSize: number | null;
  secondsDelay: number;
  feesEnabled: boolean;
  feeSchedule: { rate: number; exponent: number; takerOnly: boolean; rebateRate: number } | null;
  resolutionSource: string | null;
  umaResolutionStatus: string | null;
  fallbackResolutionType: string | null;
  clearBookOnStart: boolean;
  updatedAt: string | null;
  eventId: string | null;
  event: PmEventInfo | null;
  raw: unknown;
}

function str(v: unknown): string | null {
  return v === null || v === undefined || v === "" ? null : String(v);
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      return (JSON.parse(v) as unknown[]).map(String);
    } catch {
      return [];
    }
  }
  return [];
}

export function parsePmEvent(e: Record<string, unknown>): PmEventInfo {
  const meta = (e.eventMetadata ?? {}) as Record<string, unknown>;
  const teams = Array.isArray(e.teams)
    ? (e.teams as Record<string, unknown>[]).map((t) => ({
        id: num(t.id),
        name: String(t.name ?? ""),
        abbreviation: str(t.abbreviation),
        providerId: str(t.providerId),
        ordering: str(t.ordering),
      }))
    : [];
  return {
    id: String(e.id),
    slug: String(e.slug ?? ""),
    title: String(e.title ?? ""),
    startTime: parseTime(str(e.startTime) ?? str(e.eventDate)),
    seriesSlug: str(e.seriesSlug),
    tags: Array.isArray(e.tags) ? (e.tags as Record<string, unknown>[]).map((t) => String(t.slug ?? "")) : [],
    teams,
    league: str(meta.league),
    pandascoreMatchId: str(meta.pandascoreMatchId),
    resolutionSource: str(e.resolutionSource),
    raw: e,
  };
}

export function parsePmMarket(m: Record<string, unknown>): PmMarketInfo {
  const version = m.version === "v2" ? "v2" : "v1";
  const assetIds = version === "v2" ? parseJsonArray(m.positionIds) : parseJsonArray(m.clobTokenIds);
  const fs = m.feeSchedule as Record<string, unknown> | null | undefined;
  const events = Array.isArray(m.events) ? (m.events as Record<string, unknown>[]) : [];
  return {
    marketId: String(m.id),
    conditionId: String(m.conditionId ?? ""),
    slug: String(m.slug ?? ""),
    question: String(m.question ?? ""),
    description: String(m.description ?? ""),
    outcomes: parseJsonArray(m.outcomes),
    assetIds,
    version,
    sportsMarketType: str(m.sportsMarketType),
    groupItemTitle: str(m.groupItemTitle),
    line: num(m.line),
    gameStartTime: parseTime(str(m.gameStartTime)),
    eventStartTime: parseTime(str(m.eventStartTime)),
    endDate: parseTime(str(m.endDate)),
    negRisk: m.negRisk === true,
    acceptingOrders: m.acceptingOrders === true,
    active: m.active === true,
    closed: m.closed === true,
    archived: m.archived === true,
    orderMinSize: num(m.orderMinSize),
    tickSize: num(m.orderPriceMinTickSize),
    secondsDelay: num(m.secondsDelay) ?? 0,
    feesEnabled: m.feesEnabled === true,
    feeSchedule: fs
      ? { rate: num(fs.rate) ?? 0, exponent: num(fs.exponent) ?? 1, takerOnly: fs.takerOnly !== false, rebateRate: num(fs.rebateRate) ?? 0 }
      : null,
    resolutionSource: str(m.resolutionSource),
    umaResolutionStatus: str(m.umaResolutionStatus),
    fallbackResolutionType: str(m.fallbackResolutionType),
    clearBookOnStart: m.clearBookOnStart === true,
    updatedAt: str(m.updatedAt),
    eventId: events[0] ? String(events[0].id) : null,
    event: null,
    raw: m,
  };
}

/** /clob-markets/{conditionId} 的紧凑字段（实测：gst 开赛时间、sd 撮合延迟、mos 最小单、mts tick、fd 费率、cbos 开赛清簿）。 */
export interface PmClobMarket {
  gameStartTime: number | null;
  secondsDelay: number | null;
  minOrderSize: number | null;
  tickSize: number | null;
  fee: { rate: number; exponent: number; takerOnly: boolean } | null;
  version: "v1" | "v2" | null;
  clearBookOnStart: boolean | null;
  acceptingOrders: boolean | null;
  tokens: { tokenId: string; outcome: string }[];
}

export function parseClobMarket(r: Record<string, unknown>): PmClobMarket {
  const fd = r.fd as Record<string, unknown> | undefined;
  return {
    gameStartTime: parseTime(str(r.gst)),
    secondsDelay: num(r.sd),
    minOrderSize: num(r.mos),
    tickSize: num(r.mts),
    fee: fd ? { rate: num(fd.r) ?? 0, exponent: num(fd.e) ?? 1, takerOnly: fd.to !== false } : null,
    version: r.v === "v2" ? "v2" : r.v === "v1" ? "v1" : null,
    clearBookOnStart: typeof r.cbos === "boolean" ? r.cbos : null,
    acceptingOrders: typeof r.ao === "boolean" ? r.ao : null,
    tokens: Array.isArray(r.t) ? (r.t as Record<string, unknown>[]).map((t) => ({ tokenId: String(t.t), outcome: String(t.o) })) : [],
  };
}

function toLevels(arr: unknown): Level[] {
  if (!Array.isArray(arr)) return [];
  return (arr as Record<string, unknown>[]).map((l) => ({ price: fx(String(l.price)), size: fx(String(l.size)) }));
}

/** 生成 Polymarket 市场的交易约束。minOrderMode：最小订单按份额、按 USD 或两者都要满足。 */
export function pmMetaFrom(info: PmMarketInfo, clob: PmClobMarket | null, minOrderMode: "shares" | "usd" | "both", now: number): VenueMarketMeta {
  const tick = clob?.tickSize ?? info.tickSize ?? 0.01;
  const minSize = clob?.minOrderSize ?? info.orderMinSize ?? 5;
  const fee = clob?.fee ?? (info.feeSchedule ? { rate: info.feeSchedule.rate, exponent: info.feeSchedule.exponent, takerOnly: info.feeSchedule.takerOnly } : null);
  const accepting = (clob?.acceptingOrders ?? info.acceptingOrders) && info.active && !info.closed && !info.archived;
  const minShares = minOrderMode === "usd" ? 0n : fx(String(minSize));
  const minUsd = minOrderMode === "shares" ? 0n : fx(String(minSize));
  return {
    venue: "polymarket",
    marketKey: info.conditionId,
    tickSize: fx(String(tick)),
    shareStep: fx("0.01"),
    minOrderShares: minShares,
    minBuyValue: minUsd,
    minTakerSellShares: minShares,
    minLimitSellShares: minShares,
    fee: { kind: "polymarket", rate: fee && (info.feesEnabled || clob?.fee) ? fx(String(fee.rate)) : 0n, exponent: fee?.exponent ?? 1, enabled: !!fee && fee.rate > 0 },
    takerDelayMs: (clob?.secondsDelay ?? info.secondsDelay ?? 0) * 1000,
    acceptingOrders: accepting,
    postOnlyOnly: false,
    negRisk: info.negRisk,
    isYieldBearing: false,
    protocolVersion: clob?.version ?? info.version,
    startTime: clob?.gameStartTime ?? info.gameStartTime ?? info.eventStartTime,
    clearBookOnStart: clob?.clearBookOnStart ?? info.clearBookOnStart,
    statusText: accepting ? "OPEN" : info.closed ? "CLOSED" : !info.active ? "INACTIVE" : "NOT_ACCEPTING",
    updatedAt: now,
  };
}

export class PolymarketPublic {
  constructor(
    private readonly cfg: { gammaUrl: string; clobUrl: string; timeoutMs: number },
    private readonly log: Logger,
  ) {}

  /** 按 conditionId 查市场。Gamma 默认不返回已关闭市场，查不到的再带 closed=true 查一次。 */
  async marketsByConditionIds(ids: string[]): Promise<PmMarketInfo[]> {
    if (ids.length === 0) return [];
    const fetchSet = async (list: string[], closed: boolean): Promise<PmMarketInfo[]> => {
      const q = list.map((id) => `condition_ids=${encodeURIComponent(id)}`).join("&");
      const { data } = await httpJson<Record<string, unknown>[]>(`${this.cfg.gammaUrl}/markets?${q}&limit=${Math.max(20, list.length)}${closed ? "&closed=true" : ""}`, {
        timeoutMs: this.cfg.timeoutMs,
      });
      return (Array.isArray(data) ? data : []).map(parsePmMarket);
    };
    const open = await fetchSet(ids, false);
    const found = new Set(open.map((m) => m.conditionId.toLowerCase()));
    const missing = ids.filter((id) => !found.has(id.toLowerCase()));
    if (missing.length === 0) return open;
    return [...open, ...(await fetchSet(missing, true))];
  }

  async event(id: string): Promise<PmEventInfo> {
    const { data } = await httpJson<Record<string, unknown>>(`${this.cfg.gammaUrl}/events/${encodeURIComponent(id)}`, { timeoutMs: this.cfg.timeoutMs });
    return parsePmEvent(data);
  }

  /** 市场 + 所属事件（队伍、系列、联赛）。 */
  async marketWithEvent(conditionId: string): Promise<PmMarketInfo | null> {
    const [m] = await this.marketsByConditionIds([conditionId]);
    if (!m) return null;
    if (m.eventId) {
      try {
        m.event = await this.event(m.eventId);
      } catch (e) {
        this.log.warn({ err: e, eventId: m.eventId }, "获取 Polymarket 事件失败");
      }
    }
    return m;
  }

  async clobMarket(conditionId: string): Promise<PmClobMarket | null> {
    try {
      const { data } = await httpJson<Record<string, unknown>>(`${this.cfg.clobUrl}/clob-markets/${conditionId}`, { timeoutMs: this.cfg.timeoutMs });
      return parseClobMarket(data);
    } catch (e) {
      this.log.warn({ err: e, conditionId }, "获取 CLOB 市场参数失败，回退到 Gamma 字段");
      return null;
    }
  }

  async book(tokenId: string): Promise<Book> {
    const now = Date.now();
    const { data } = await httpJson<Record<string, unknown>>(`${this.cfg.clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`, { timeoutMs: this.cfg.timeoutMs });
    const sorted = sortBook(toLevels(data.bids), toLevels(data.asks));
    return { ...sorted, exchangeTs: Number(data.timestamp ?? now) || now, receivedAt: now, source: "rest" };
  }
}

/**
 * Polymarket 行情订阅：book 全量 + price_change 增量，tick_size_change 更新约束；
 * 定期用 REST 校准（防止增量丢失）。断线时把相关订单簿标记过期（不再刷新 receivedAt）。
 */
export class PolymarketBookFeed {
  private ws: ResilientWs;
  private assets = new Set<string>();
  private local = new Map<string, { bids: Map<string, Fx>; asks: Map<string, Fx>; ts: number }>();
  private resyncTimer: NodeJS.Timeout | null = null;
  onTick: ((tokenId: string, newTick: Fx) => void) | null = null;
  onState: ((up: boolean) => void) | null = null;

  constructor(
    private readonly cfg: { wsMarketUrl: string; resyncSec: number },
    private readonly pub: PolymarketPublic,
    private readonly store: BookStore,
    private readonly log: Logger,
  ) {
    this.ws = new ResilientWs({
      name: "pm-market",
      url: () => cfg.wsMarketUrl,
      log,
      pingIntervalMs: 10_000,
      pingPayload: "PING",
      idleTimeoutMs: 60_000,
      onOpen: (w) => {
        if (this.assets.size) w.send({ assets_ids: [...this.assets], type: "market", custom_feature_enabled: true });
      },
      onMessage: (t) => this.handle(t),
      onStateChange: (up, reason) => {
        log.info({ up, reason }, "Polymarket 行情连接状态");
        this.onState?.(up);
      },
    });
  }

  get up(): boolean {
    return this.ws.up;
  }

  start(): void {
    this.ws.start();
    this.resyncTimer = setInterval(() => void this.resyncAll(), Math.max(5, this.cfg.resyncSec) * 1000);
    this.resyncTimer.unref();
  }

  stop(): void {
    this.ws.stop();
    if (this.resyncTimer) clearInterval(this.resyncTimer);
  }

  subscribe(tokenIds: string[]): void {
    const fresh = tokenIds.filter((t) => !this.assets.has(t));
    for (const t of fresh) this.assets.add(t);
    if (fresh.length && this.ws.up) this.ws.send({ assets_ids: fresh, operation: "subscribe", custom_feature_enabled: true });
    for (const t of fresh) void this.refresh(t);
  }

  /** 取消订阅（配对删除后），停止推送与 REST 校准。 */
  unsubscribe(tokenIds: string[]): void {
    const gone = tokenIds.filter((t) => this.assets.delete(t));
    for (const t of gone) this.local.delete(t);
    if (gone.length && this.ws.up) this.ws.send({ assets_ids: gone, operation: "unsubscribe" });
  }

  /** REST 拉取全量订单簿。 */
  async refresh(tokenId: string): Promise<void> {
    try {
      const b = await this.pub.book(tokenId);
      this.setFull(tokenId, b.bids, b.asks, b.exchangeTs, "rest");
    } catch (e) {
      this.log.warn({ err: e, tokenId }, "Polymarket 订单簿 REST 获取失败");
    }
  }

  private async resyncAll(): Promise<void> {
    for (const t of this.assets) await this.refresh(t);
  }

  private setFull(tokenId: string, bids: Level[], asks: Level[], ts: number, source: Book["source"]): void {
    const loc = { bids: new Map<string, Fx>(), asks: new Map<string, Fx>(), ts };
    for (const l of bids) loc.bids.set(l.price.toString(), l.size);
    for (const l of asks) loc.asks.set(l.price.toString(), l.size);
    this.local.set(tokenId, loc);
    this.publish(tokenId, source);
  }

  private publish(tokenId: string, source: Book["source"]): void {
    const loc = this.local.get(tokenId);
    if (!loc) return;
    const toL = (m: Map<string, Fx>): Level[] => [...m.entries()].filter(([, s]) => s > 0n).map(([p, s]) => ({ price: BigInt(p), size: s }));
    const now = Date.now();
    this.store.setBook("polymarket", tokenId, { bids: toL(loc.bids), asks: toL(loc.asks), exchangeTs: loc.ts, receivedAt: now, source });
  }

  private handle(text: string): void {
    if (text === "PONG" || text === "pong") return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const items = Array.isArray(msg) ? msg : [msg];
    for (const raw of items) {
      const m = raw as Record<string, unknown>;
      switch (m.event_type) {
        case "book": {
          const tokenId = String(m.asset_id);
          this.setFull(tokenId, toLevels(m.bids), toLevels(m.asks), Number(m.timestamp) || Date.now(), "ws");
          break;
        }
        case "price_change": {
          const changes = Array.isArray(m.price_changes) ? (m.price_changes as Record<string, unknown>[]) : [];
          const touched = new Set<string>();
          for (const c of changes) {
            const tokenId = String(c.asset_id);
            const loc = this.local.get(tokenId);
            if (!loc) continue;
            const side = c.side === "BUY" ? loc.bids : loc.asks;
            side.set(fx(String(c.price)).toString(), fx(String(c.size)));
            loc.ts = Number(m.timestamp) || Date.now();
            touched.add(tokenId);
          }
          for (const t of touched) this.publish(t, "ws");
          break;
        }
        case "tick_size_change": {
          const tokenId = String(m.asset_id);
          this.onTick?.(tokenId, fx(String(m.new_tick_size)));
          break;
        }
        case "market_resolved":
          this.log.warn({ market: m.market }, "Polymarket 市场已结算（推送）");
          break;
        default:
          break;
      }
    }
  }
}

export const PM_ONE = ONE;

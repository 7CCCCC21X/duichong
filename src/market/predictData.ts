import type { Logger } from "pino";
import { fx, stepFromDecimals } from "../core/fixed.js";
import { parseTime } from "../core/time.js";
import type { Book, Level, VenueMarketMeta } from "../core/types.js";
import { complementBook, sortBook, type BookStore } from "./bookStore.js";
import { httpJson } from "./http.js";
import { ResilientWs } from "./ws.js";

export interface PfTeam {
  id: number | null;
  name: string;
  abbreviation: string | null;
  providerTeamId: string | null;
}

export interface PfOutcome {
  name: string;
  indexSet: 1 | 2;
  onChainId: string;
  status: string | null;
  team: PfTeam | null;
}

export interface PfMarketInfo {
  id: number;
  title: string;
  question: string;
  description: string;
  categorySlug: string;
  status: string;
  tradingStatus: string;
  isNegRisk: boolean;
  isYieldBearing: boolean;
  feeRateBps: number;
  feeExponent: number;
  decimalPrecision: number;
  speedBump: { delayMs: number | null; liveDelayMs: number | null; liveFrom: number | null; isRemovalLocked: boolean } | null;
  marketType: string | null;
  marketVariant: string | null;
  polymarketConditionIds: string[];
  conditionId: string;
  outcomes: PfOutcome[];
  line: number | null;
  gameNumber: number | null;
  raw: unknown;
}

export interface PfCategoryInfo {
  id: number;
  slug: string;
  title: string;
  description: string;
  startsAt: number | null;
  endsAt: number | null;
  status: string;
  marketVariant: string | null;
  resolutionProvider: string | null;
  provider: string | null;
  providerEventId: string | null;
  teams: PfTeam[];
  tags: string[];
  markets: PfMarketInfo[];
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

function parseTeam(t: unknown): PfTeam | null {
  if (!t || typeof t !== "object") return null;
  const r = t as Record<string, unknown>;
  return { id: num(r.id), name: String(r.name ?? ""), abbreviation: str(r.abbreviation), providerTeamId: str(r.providerTeamId) };
}

export function parsePfMarket(m: Record<string, unknown>): PfMarketInfo {
  const sb = m.speedBump as Record<string, unknown> | null | undefined;
  const vd = ((m.variantDetails as Record<string, unknown> | undefined)?.sports ?? {}) as Record<string, unknown>;
  const outcomes = Array.isArray(m.outcomes)
    ? (m.outcomes as Record<string, unknown>[]).map((o) => {
        const od = ((o.variantDetails as Record<string, unknown> | undefined)?.sports ?? {}) as Record<string, unknown>;
        return {
          name: String(o.name ?? ""),
          indexSet: (Number(o.indexSet) === 2 ? 2 : 1) as 1 | 2,
          onChainId: String(o.onChainId ?? ""),
          status: str(o.status),
          team: parseTeam(od.team) ?? parseTeam(o.team),
        };
      })
    : [];
  return {
    id: Number(m.id),
    title: String(m.title ?? ""),
    question: String(m.question ?? ""),
    description: String(m.description ?? ""),
    categorySlug: String(m.categorySlug ?? ""),
    status: String(m.status ?? ""),
    tradingStatus: String(m.tradingStatus ?? ""),
    isNegRisk: m.isNegRisk === true,
    isYieldBearing: m.isYieldBearing === true,
    feeRateBps: num(m.feeRateBps) ?? 0,
    feeExponent: num(m.feeExponent) ?? 1,
    decimalPrecision: num(m.decimalPrecision) ?? 2,
    speedBump: sb
      ? { delayMs: num(sb.delayMs), liveDelayMs: num(sb.liveDelayMs), liveFrom: parseTime(str(sb.liveFrom)), isRemovalLocked: sb.isRemovalLocked === true }
      : null,
    marketType: str(m.marketType),
    marketVariant: str(m.marketVariant),
    polymarketConditionIds: Array.isArray(m.polymarketConditionIds) ? (m.polymarketConditionIds as unknown[]).map(String) : [],
    conditionId: String(m.conditionId ?? ""),
    outcomes,
    line: num(vd.line),
    gameNumber: num(vd.gameNumber),
    raw: m,
  };
}

export function parsePfCategory(c: Record<string, unknown>): PfCategoryInfo {
  const vs = ((c.variantDetails as Record<string, unknown> | undefined)?.sports ?? (c.variantData as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const teams = Array.isArray(vs.teams) ? (vs.teams as unknown[]).map(parseTeam).filter((t): t is PfTeam => t !== null) : [];
  return {
    id: Number(c.id),
    slug: String(c.slug ?? ""),
    title: String(c.title ?? ""),
    description: String(c.description ?? ""),
    startsAt: parseTime(str(c.startsAt)),
    endsAt: parseTime(str(c.endsAt)),
    status: String(c.status ?? ""),
    marketVariant: str(c.marketVariant),
    resolutionProvider: str(c.resolutionProvider),
    provider: str(vs.provider),
    providerEventId: str(vs.providerEventId),
    teams,
    tags: Array.isArray(c.tags) ? (c.tags as Record<string, unknown>[]).map((t) => String(t.name ?? "")) : [],
    markets: Array.isArray(c.markets) ? (c.markets as Record<string, unknown>[]).map(parsePfMarket) : [],
    raw: c,
  };
}

const TRADABLE_STATUS = new Set(["REGISTERED", "PRICE_PROPOSED", "PRICE_DISPUTED", "UNPAUSED"]);

/** Predict 市场交易约束。出处：https://dev.predict.fun/trading/place-orders.md （Rules the API checks） */
export function pfMetaFrom(m: PfMarketInfo, startsAt: number | null, now: number): VenueMarketMeta {
  const statusOk = TRADABLE_STATUS.has(m.status);
  const ts = m.tradingStatus;
  const accepting = statusOk && (ts === "OPEN" || ts === "MATCHING_NOT_ENABLED");
  let takerDelayMs = 0;
  if (m.speedBump) {
    const live = m.speedBump.liveFrom !== null && now >= m.speedBump.liveFrom;
    takerDelayMs = (live ? m.speedBump.liveDelayMs : m.speedBump.delayMs) ?? 0;
  }
  return {
    venue: "predict",
    marketKey: String(m.id),
    tickSize: stepFromDecimals(m.decimalPrecision),
    shareStep: fx("0.01"),
    minOrderShares: 0n,
    minBuyValue: fx(1),
    minTakerSellShares: fx("0.01"),
    minLimitSellShares: fx(1),
    fee: { kind: "predict", rateBps: m.feeRateBps, exponent: m.feeExponent },
    takerDelayMs,
    acceptingOrders: accepting,
    postOnlyOnly: ts === "MATCHING_NOT_ENABLED",
    negRisk: m.isNegRisk,
    isYieldBearing: m.isYieldBearing,
    startTime: startsAt,
    clearBookOnStart: false,
    statusText: `${m.status}/${ts}`,
    updatedAt: now,
  };
}

function toLevels(arr: unknown): Level[] {
  if (!Array.isArray(arr)) return [];
  return (arr as unknown[]).map((l) => {
    const [p, s] = l as [number, number];
    return { price: fx(String(p)), size: fx(String(s)) };
  });
}

export class PredictPublic {
  constructor(
    private readonly cfg: { restUrl: string; apiKey: string | null; timeoutMs: number },
    private readonly log: Logger,
  ) {}

  headers(): Record<string, string> {
    return this.cfg.apiKey ? { "x-api-key": this.cfg.apiKey } : {};
  }

  async market(id: number): Promise<PfMarketInfo> {
    const { data } = await httpJson<{ data: Record<string, unknown> }>(`${this.cfg.restUrl}/v1/markets/${id}`, { headers: this.headers(), timeoutMs: this.cfg.timeoutMs });
    return parsePfMarket(data.data);
  }

  async category(slug: string): Promise<PfCategoryInfo> {
    const { data } = await httpJson<{ data: Record<string, unknown> }>(`${this.cfg.restUrl}/v1/categories/${encodeURIComponent(slug)}`, { headers: this.headers(), timeoutMs: this.cfg.timeoutMs });
    return parsePfCategory(data.data);
  }

  /** 按 marketVariant 分页列出开放中的类别（电竞发现用）。 */
  async categories(variants: string[], maxPages = 10): Promise<PfCategoryInfo[]> {
    const out: PfCategoryInfo[] = [];
    for (const v of variants) {
      let after: string | null = null;
      for (let i = 0; i < maxPages; i++) {
        const url: string = `${this.cfg.restUrl}/v1/categories?first=100&status=OPEN&marketVariant=${encodeURIComponent(v)}${after ? `&after=${encodeURIComponent(after)}` : ""}`;
        const res: { data: { data: Record<string, unknown>[]; cursor: string | null } } = await httpJson<{ data: Record<string, unknown>[]; cursor: string | null }>(url, {
          headers: this.headers(),
          timeoutMs: this.cfg.timeoutMs,
        });
        for (const c of res.data.data ?? []) out.push(parsePfCategory(c));
        after = res.data.cursor ?? null;
        if (!after) break;
      }
    }
    return out;
  }

  /** Yes（indexSet=1）订单簿。 */
  async orderbook(marketId: number): Promise<Book> {
    const now = Date.now();
    const { data } = await httpJson<{ data: Record<string, unknown> }>(`${this.cfg.restUrl}/v1/markets/${marketId}/orderbook`, { headers: this.headers(), timeoutMs: this.cfg.timeoutMs });
    const d = data.data;
    const sorted = sortBook(toLevels(d.bids), toLevels(d.asks));
    return { ...sorted, exchangeTs: Number(d.updateTimestampMs) || now, receivedAt: now, source: "rest" };
  }

  /** 批量订单簿（最多 100 个市场）。 */
  async orderbooks(ids: number[]): Promise<Map<number, Book>> {
    const out = new Map<number, Book>();
    if (ids.length === 0) return out;
    const now = Date.now();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const q = chunk.map((id) => `ids=${id}`).join("&");
      const { data } = await httpJson<{ data: Record<string, unknown>[] }>(`${this.cfg.restUrl}/v1/markets/orderbooks?${q}`, { headers: this.headers(), timeoutMs: this.cfg.timeoutMs });
      for (const d of data.data ?? []) {
        const sorted = sortBook(toLevels(d.bids), toLevels(d.asks));
        out.set(Number(d.marketId), { ...sorted, exchangeTs: Number(d.updateTimestampMs) || now, receivedAt: now, source: "rest" });
      }
    }
    return out;
  }
}

export interface PfSubscription {
  marketId: number;
  /** indexSet → tokenId */
  tokens: { 1: string; 2: string };
  tick: () => bigint;
}

/**
 * Predict 行情订阅：WebSocket 主题 predictOrderbook / predictTradingStatus / predictMarketStatus / predictMarketChanged；
 * 每 15 秒回显心跳；收到重连通知立即重连；无 WS（测试网或无 API Key）时用批量 REST 轮询。
 * 订单簿只按 Yes 给出，indexSet=2 的簿由互补计算得到。
 */
export class PredictBookFeed {
  private ws: ResilientWs | null = null;
  private subs = new Map<number, PfSubscription>();
  private pollTimer: NodeJS.Timeout | null = null;
  private reqId = 1;
  onMarketEvent: ((marketId: number, kind: "tradingStatus" | "marketStatus" | "marketChanged", data: unknown) => void) | null = null;
  onState: ((up: boolean) => void) | null = null;

  constructor(
    private readonly cfg: { wsUrl: string | null; apiKey: string | null; pollIntervalMs: number },
    private readonly pub: PredictPublic,
    private readonly store: BookStore,
    private readonly log: Logger,
  ) {
    if (cfg.wsUrl && cfg.apiKey) {
      this.ws = new ResilientWs({
        name: "pf-market",
        url: () => cfg.wsUrl!,
        headers: () => ({ "x-api-key": cfg.apiKey! }),
        log,
        idleTimeoutMs: 45_000,
        onOpen: (w) => {
          for (const id of this.subs.keys()) this.sendSubs(w, id);
        },
        onMessage: (t, w) => this.handle(t, w),
        onStateChange: (up, reason) => {
          log.info({ up, reason }, "Predict 行情连接状态");
          this.onState?.(up);
        },
      });
    }
  }

  get usesWs(): boolean {
    return this.ws !== null;
  }

  get up(): boolean {
    return this.ws ? this.ws.up : true;
  }

  start(): void {
    this.ws?.start();
    // 有 WS 时轮询作为低频校准，没有 WS 时作为主数据源
    const interval = this.ws ? Math.max(this.cfg.pollIntervalMs, 15_000) : Math.max(500, this.cfg.pollIntervalMs);
    this.pollTimer = setInterval(() => void this.pollAll(), interval);
    this.pollTimer.unref();
  }

  stop(): void {
    this.ws?.stop();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  subscribe(sub: PfSubscription): void {
    const isNew = !this.subs.has(sub.marketId);
    this.subs.set(sub.marketId, sub);
    if (isNew) {
      if (this.ws?.up) this.sendSubs(this.ws, sub.marketId);
      void this.refresh(sub.marketId);
    }
  }

  /** 取消订阅（配对删除后），停止推送与轮询。 */
  unsubscribe(marketId: number): void {
    if (!this.subs.delete(marketId)) return;
    if (this.ws?.up) this.sendSubs(this.ws, marketId, "unsubscribe");
  }

  private sendSubs(w: ResilientWs, id: number, method: "subscribe" | "unsubscribe" = "subscribe"): void {
    for (const topic of [`predictOrderbook/${id}`, `predictTradingStatus/${id}`, `predictMarketStatus/${id}`, `predictMarketChanged/${id}`]) {
      w.send({ method, requestId: this.reqId++, params: [topic] });
    }
  }

  async refresh(marketId: number): Promise<void> {
    try {
      const b = await this.pub.orderbook(marketId);
      this.publish(marketId, b);
    } catch (e) {
      this.log.warn({ err: e, marketId }, "Predict 订单簿 REST 获取失败");
    }
  }

  private async pollAll(): Promise<void> {
    if (this.subs.size === 0) return;
    try {
      const books = await this.pub.orderbooks([...this.subs.keys()]);
      for (const [id, b] of books) this.publish(id, b);
    } catch (e) {
      this.log.warn({ err: e }, "Predict 批量订单簿轮询失败");
    }
  }

  private publish(marketId: number, yes: Book): void {
    const sub = this.subs.get(marketId);
    if (!sub) return;
    this.store.setBook("predict", sub.tokens[1], yes);
    this.store.setBook("predict", sub.tokens[2], complementBook(this.store.getBook("predict", sub.tokens[1])!, sub.tick()));
  }

  private handle(text: string, w: ResilientWs): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "R") {
      if (msg.success === false) this.log.warn({ err: msg.error }, "Predict 订阅失败");
      return;
    }
    const topic = String(msg.topic ?? "");
    if (topic === "heartbeat") {
      w.send({ method: "heartbeat", data: msg.data });
      return;
    }
    if (topic === "system") {
      const d = (msg.data ?? {}) as Record<string, unknown>;
      this.log.warn({ data: d }, "Predict 服务端重连通知");
      setTimeout(() => w.reconnect("服务端重连通知"), Math.min(Number(d.graceMs ?? 1000), 5000) / 2).unref();
      return;
    }
    const [kind, idStr] = topic.split("/");
    const id = Number(idStr);
    if (!Number.isFinite(id)) return;
    if (kind === "predictOrderbook") {
      const d = (msg.data ?? {}) as Record<string, unknown>;
      const now = Date.now();
      const sorted = sortBook(toLevels(d.bids), toLevels(d.asks));
      this.publish(id, { ...sorted, exchangeTs: Number(d.updateTimestampMs) || now, receivedAt: now, source: "ws" });
    } else if (kind === "predictTradingStatus") {
      this.onMarketEvent?.(id, "tradingStatus", msg.data);
    } else if (kind === "predictMarketStatus") {
      this.onMarketEvent?.(id, "marketStatus", msg.data);
    } else if (kind === "predictMarketChanged") {
      this.onMarketEvent?.(id, "marketChanged", msg.data);
    }
  }
}

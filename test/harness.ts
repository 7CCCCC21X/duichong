import pino from "pino";
import { KeyedSerialQueue } from "../src/core/async.js";
import { fx, ONE, type Fx } from "../src/core/fixed.js";
import { ManualClock } from "../src/core/time.js";
import type { Book, Instrument, Level, Outcome, VenueId, VenueMarketMeta } from "../src/core/types.js";
import { RiskSchema, StrategySchema, type RiskConfig, type StrategyConfig } from "../src/config/schema.js";
import { Db } from "../src/db/db.js";
import { Repo } from "../src/db/repo.js";
import { AlertSink } from "../src/engine/alerts.js";
import { computePositions, netExposure } from "../src/engine/ledger.js";
import { PairEngine, type ActivePair } from "../src/engine/pairEngine.js";
import { reconcilePair } from "../src/engine/reconcile.js";
import { RiskManager } from "../src/engine/risk.js";
import { EventRouter } from "../src/engine/router.js";
import { BookStore, complementBook } from "../src/market/bookStore.js";
import { SimVenue } from "../src/venues/sim/simVenue.js";

export const TOK = {
  predict: { A: "pf-A-token", B: "pf-B-token" },
  polymarket: { A: "pm-A-token", B: "pm-B-token" },
} as const;

export const PM_KEY = "0x" + "ab".repeat(32);
export const PF_KEY = "101";

export function lv(price: string, size: string | number): Level {
  return { price: fx(price), size: fx(String(size)) };
}

export function pmMeta(over: Partial<VenueMarketMeta> = {}): VenueMarketMeta {
  return {
    venue: "polymarket",
    marketKey: PM_KEY,
    tickSize: fx("0.01"),
    shareStep: fx("0.01"),
    minOrderShares: fx(5),
    minBuyValue: 0n,
    minTakerSellShares: fx(5),
    minLimitSellShares: fx(5),
    fee: { kind: "polymarket", rate: fx("0.05"), exponent: 1, enabled: true },
    takerDelayMs: 0,
    acceptingOrders: true,
    postOnlyOnly: false,
    negRisk: false,
    isYieldBearing: false,
    protocolVersion: "v1",
    startTime: null,
    clearBookOnStart: true,
    statusText: "OPEN",
    updatedAt: 0,
    ...over,
  };
}

export function pfMeta(over: Partial<VenueMarketMeta> = {}): VenueMarketMeta {
  return {
    venue: "predict",
    marketKey: PF_KEY,
    tickSize: fx("0.01"),
    shareStep: fx("0.01"),
    minOrderShares: 0n,
    minBuyValue: fx(1),
    minTakerSellShares: fx("0.01"),
    minLimitSellShares: fx(1),
    fee: { kind: "predict", rateBps: 200, exponent: 1 },
    takerDelayMs: 0,
    acceptingOrders: true,
    postOnlyOnly: false,
    negRisk: false,
    isYieldBearing: false,
    startTime: null,
    clearBookOnStart: false,
    statusText: "OPEN",
    updatedAt: 0,
    ...over,
  };
}

export interface HarnessOptions {
  makerVenue?: VenueId;
  makerOutcome?: Outcome;
  strategy?: Partial<StrategyConfig>;
  risk?: Partial<RiskConfig>;
  balances?: Partial<Record<VenueId, number>>;
  startTime?: number | null;
  db?: Db;
  clock?: ManualClock;
  venues?: Record<VenueId, SimVenue>;
  books?: BookStore;
}

export class Harness {
  readonly clock: ManualClock;
  readonly db: Db;
  readonly repo: Repo;
  readonly books: BookStore;
  readonly queue = new KeyedSerialQueue();
  readonly log = pino({ level: process.env.TEST_LOG ?? "silent" });
  readonly alerts: AlertSink;
  readonly risk: RiskManager;
  readonly venues: Record<VenueId, SimVenue>;
  readonly engines = new Map<string, PairEngine>();
  readonly router: EventRouter;
  engine!: PairEngine;
  pair!: ActivePair;
  /** 每次 tick 前调用（例如持续刷新盘口，模拟 WebSocket 不断推送） */
  onTick: (() => void) | null = null;

  constructor(readonly opts: HarnessOptions = {}) {
    this.clock = opts.clock ?? new ManualClock();
    this.db = opts.db ?? new Db(":memory:");
    this.repo = new Repo(this.db);
    this.books = opts.books ?? new BookStore();
    this.alerts = new AlertSink(this.repo, this.clock, this.log);
    const riskCfg = RiskSchema.parse({ maxNakedSec: 20, ...(opts.risk ?? {}) });
    this.risk = new RiskManager(this.repo, this.clock, riskCfg);
    const keyOf = (tokenId: string) => (tokenId.startsWith("pf") ? PF_KEY : tokenId.startsWith("pm") ? PM_KEY : null);
    this.venues = opts.venues ?? {
      predict: new SimVenue({ venue: "predict", clock: this.clock, books: this.books, marketKeyOf: keyOf, startingBalance: fx(opts.balances?.predict ?? 1000) }),
      polymarket: new SimVenue({ venue: "polymarket", clock: this.clock, books: this.books, marketKeyOf: keyOf, startingBalance: fx(opts.balances?.polymarket ?? 1000) }),
    };
    if (!opts.books) {
      this.books.setMeta(pmMeta({ startTime: opts.startTime ?? null }));
      this.books.setMeta(pfMeta({ startTime: opts.startTime ?? null }));
    }
    this.router = new EventRouter(this.repo, this.queue, this.engines, this.clock, this.log);
    for (const v of ["predict", "polymarket"] as VenueId[]) this.venues[v].onEvent((e) => this.router.handle(e));
    this.buildEngine();
  }

  buildEngine(): PairEngine {
    const inst = (venue: VenueId, outcome: Outcome): Instrument => ({
      venue,
      outcome,
      tokenId: TOK[venue][outcome],
      marketKey: venue === "predict" ? PF_KEY : PM_KEY,
      outcomeIndex: outcome === "A" ? (venue === "predict" ? 1 : 0) : venue === "predict" ? 2 : 1,
      label: outcome === "A" ? "TeamA" : "TeamB",
    });
    const strategy = StrategySchema.parse({ priceMode: "fixed", price: 0.46, sizeShares: 50, minProfitPerShare: 0.01, hedgeSlippage: 0, riskBufferPerShare: 0, fxBufferBps: 0, requoteMinIntervalMs: 0, ...(this.opts.strategy ?? {}) });
    const risk = RiskSchema.parse({ maxNakedSec: 20, ...(this.opts.risk ?? {}) });
    this.pair = {
      id: "pair1",
      makerVenue: this.opts.makerVenue ?? "predict",
      makerOutcome: this.opts.makerOutcome ?? "A",
      strategy,
      risk,
      instruments: {
        predict: { A: inst("predict", "A"), B: inst("predict", "B") },
        polymarket: { A: inst("polymarket", "A"), B: inst("polymarket", "B") },
      },
      marketKeys: { predict: PF_KEY, polymarket: PM_KEY },
      startTime: this.opts.startTime ?? null,
      tradeable: true,
      blockReason: null,
      labels: { A: "TeamA", B: "TeamB" },
      makerOrderTtlSec: 0,
      makerRefreshBeforeSec: 0,
    };
    this.engine = new PairEngine(this.pair, {
      repo: this.repo,
      clock: this.clock,
      venues: this.venues,
      books: this.books,
      risk: this.risk,
      alerts: this.alerts,
      log: this.log,
      queue: this.queue,
      setTimer: () => {},
    });
    this.engines.set(this.pair.id, this.engine);
    return this.engine;
  }

  /** 设置 Predict 的 Yes(A) 簿，并同步生成 B 簿。 */
  setPredictBook(bids: Level[], asks: Level[]): void {
    const now = this.clock.now();
    const yes: Book = { bids, asks, exchangeTs: now, receivedAt: now, source: "sim" };
    this.books.setBook("predict", TOK.predict.A, yes);
    this.books.setBook("predict", TOK.predict.B, complementBook(this.books.getBook("predict", TOK.predict.A)!, fx("0.01")));
  }

  /** 设置 Polymarket 某个结果代币的簿；另一结果自动镜像。 */
  setPolyBook(outcome: Outcome, bids: Level[], asks: Level[]): void {
    const now = this.clock.now();
    const b: Book = { bids, asks, exchangeTs: now, receivedAt: now, source: "sim" };
    this.books.setBook("polymarket", TOK.polymarket[outcome], b);
    const other: Outcome = outcome === "A" ? "B" : "A";
    this.books.setBook("polymarket", TOK.polymarket[other], complementBook(this.books.getBook("polymarket", TOK.polymarket[outcome])!, fx("0.01")));
  }

  /** 让所有异步推送与队列任务跑完。 */
  async settle(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await new Promise((r) => setImmediate(r));
      await this.queue.drain();
      await new Promise((r) => setImmediate(r));
    }
  }

  async reconcile(): Promise<void> {
    await reconcilePair(this.engine, { repo: this.repo, clock: this.clock, venues: this.venues, queue: this.queue, alerts: this.alerts, log: this.log }, { cancelOrphans: true, tolerance: 0.05 });
    await this.settle();
  }

  async tick(ms = 1000, times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
      this.clock.advance(ms);
      this.onTick?.();
      await this.engine.schedule("tick");
      await this.settle();
    }
  }

  async refreshBalances(): Promise<void> {
    for (const v of ["predict", "polymarket"] as VenueId[]) this.risk.setBalances(v, await this.venues[v].getBalances());
  }

  positions() {
    return computePositions(this.repo.listFills({ pairId: "pair1" }), this.pair.strategy.hedgeTrigger);
  }

  net(): Fx {
    return netExposure(this.positions());
  }

  orders(role?: string) {
    return this.repo.listOrders({ pairId: "pair1" }).filter((o) => !role || o.role === role);
  }

  activeMakers() {
    return this.orders("MAKER").filter((o) => ["ACCEPTED", "PARTIAL", "SENDING", "PREPARED", "INTENT", "CANCEL_REQUESTED", "UNKNOWN"].includes(o.status));
  }
}

export const ONE_FX = ONE;

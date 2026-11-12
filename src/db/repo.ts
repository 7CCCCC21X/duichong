import type { Fx } from "../core/fixed.js";
import type { FillStatus, OrderKind, OrderRole, OrderStatus, Outcome, Side, VenueId } from "../core/types.js";
import { isTerminalFill, isTerminalOrder } from "../core/types.js";
import type { Db } from "./db.js";

export interface OrderRow {
  id: string;
  pairId: string;
  venue: VenueId;
  role: OrderRole;
  kind: OrderKind;
  outcome: Outcome;
  tokenId: string;
  side: Side;
  price: Fx;
  size: Fx;
  amountUsd: Fx | null;
  postOnly: boolean;
  status: OrderStatus;
  venueOrderId: string | null;
  hash: string | null;
  reportedFilled: Fx;
  plannedFill: Fx | null;
  expiresAt: number | null;
  createdAt: number;
  sentAt: number | null;
  ackAt: number | null;
  updatedAt: number;
  terminalAt: number | null;
  error: string | null;
  payload: unknown;
  meta: Record<string, unknown>;
}

export interface FillRow {
  key: string;
  pairId: string;
  venue: VenueId;
  orderId: string | null;
  venueOrderId: string | null;
  role: OrderRole;
  outcome: Outcome;
  side: Side;
  tokenId: string;
  price: Fx;
  grossShares: Fx;
  feeShares: Fx;
  feeCollateral: Fx;
  feeUsd: Fx;
  feeEstimated: boolean;
  /** 买：到账净份额；卖：卖出份额 */
  netShares: Fx;
  /** 现金流：买为负（成交额+另付费），卖为正（所得−费） */
  cashFlow: Fx;
  isMaker: boolean;
  status: FillStatus;
  matchedAt: number;
  updatedAt: number;
  /** 本机首次收到这笔成交的时间（之后的状态更新不改变） */
  receivedAt: number;
  txHash: string | null;
  raw: unknown;
}

const bi = (v: unknown): bigint => BigInt(String(v ?? "0"));
const biN = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));
const s = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const parse = (v: unknown): unknown => {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

function toOrder(r: Record<string, unknown>): OrderRow {
  return {
    id: String(r.id),
    pairId: String(r.pair_id),
    venue: r.venue as VenueId,
    role: r.role as OrderRole,
    kind: r.kind as OrderKind,
    outcome: r.outcome as Outcome,
    tokenId: String(r.token_id),
    side: r.side as Side,
    price: bi(r.price),
    size: bi(r.size),
    amountUsd: biN(r.amount_usd),
    postOnly: Number(r.post_only) === 1,
    status: r.status as OrderStatus,
    venueOrderId: (r.venue_order_id as string | null) ?? null,
    hash: (r.hash as string | null) ?? null,
    reportedFilled: bi(r.reported_filled),
    plannedFill: biN(r.planned_fill),
    expiresAt: (r.expires_at as number | null) ?? null,
    createdAt: Number(r.created_at),
    sentAt: (r.sent_at as number | null) ?? null,
    ackAt: (r.ack_at as number | null) ?? null,
    updatedAt: Number(r.updated_at),
    terminalAt: (r.terminal_at as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    payload: parse(r.payload),
    meta: (parse(r.meta) as Record<string, unknown>) ?? {},
  };
}

function toFill(r: Record<string, unknown>): FillRow {
  return {
    key: String(r.key),
    pairId: String(r.pair_id),
    venue: r.venue as VenueId,
    orderId: (r.order_id as string | null) ?? null,
    venueOrderId: (r.venue_order_id as string | null) ?? null,
    role: r.role as OrderRole,
    outcome: r.outcome as Outcome,
    side: r.side as Side,
    tokenId: String(r.token_id),
    price: bi(r.price),
    grossShares: bi(r.gross_shares),
    feeShares: bi(r.fee_shares),
    feeCollateral: bi(r.fee_collateral),
    feeUsd: bi(r.fee_usd),
    feeEstimated: Number(r.fee_estimated) === 1,
    netShares: bi(r.net_shares),
    cashFlow: bi(r.cash_flow),
    isMaker: Number(r.is_maker) === 1,
    status: r.status as FillStatus,
    matchedAt: Number(r.matched_at),
    updatedAt: Number(r.updated_at),
    receivedAt: Number(r.received_at ?? r.updated_at),
    txHash: (r.tx_hash as string | null) ?? null,
    raw: parse(r.raw),
  };
}

const FILL_RANK: Record<FillStatus, number> = { MATCHED: 1, RETRYING: 1, MINED: 2, SETTLED: 3, FAILED: 3 };

export type FillUpsertResult = { action: "inserted" | "updated" | "ignored"; prev: FillRow | null; row: FillRow };

export class Repo {
  constructor(readonly db: Db) {}

  // ---------------- 订单 ----------------
  insertOrder(o: OrderRow): void {
    this.db.raw
      .prepare(
        `INSERT INTO orders(id,pair_id,venue,role,kind,outcome,token_id,side,price,size,amount_usd,post_only,status,venue_order_id,hash,
         reported_filled,planned_fill,expires_at,created_at,sent_at,ack_at,updated_at,terminal_at,error,payload,meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        o.id,
        o.pairId,
        o.venue,
        o.role,
        o.kind,
        o.outcome,
        o.tokenId,
        o.side,
        o.price.toString(),
        o.size.toString(),
        s(o.amountUsd),
        o.postOnly ? 1 : 0,
        o.status,
        o.venueOrderId,
        o.hash,
        o.reportedFilled.toString(),
        s(o.plannedFill),
        o.expiresAt,
        o.createdAt,
        o.sentAt,
        o.ackAt,
        o.updatedAt,
        o.terminalAt,
        o.error,
        json(o.payload),
        json(o.meta),
      );
  }

  updateOrder(id: string, patch: Partial<OrderRow>, now: number): OrderRow {
    const cur = this.getOrder(id);
    if (!cur) throw new Error(`订单不存在: ${id}`);
    const next: OrderRow = { ...cur, ...patch, updatedAt: now };
    // 终态不可回退
    if (isTerminalOrder(cur.status) && patch.status && patch.status !== cur.status) {
      next.status = cur.status;
    }
    if (isTerminalOrder(next.status) && !cur.terminalAt) next.terminalAt = now;
    // 已报告成交只增不减
    if (next.reportedFilled < cur.reportedFilled) next.reportedFilled = cur.reportedFilled;
    this.db.raw
      .prepare(
        `UPDATE orders SET status=?,venue_order_id=?,hash=?,reported_filled=?,planned_fill=?,expires_at=?,sent_at=?,ack_at=?,
         updated_at=?,terminal_at=?,error=?,payload=?,meta=?,price=?,size=?,amount_usd=? WHERE id=?`,
      )
      .run(
        next.status,
        next.venueOrderId,
        next.hash,
        next.reportedFilled.toString(),
        s(next.plannedFill),
        next.expiresAt,
        next.sentAt,
        next.ackAt,
        next.updatedAt,
        next.terminalAt,
        next.error,
        json(next.payload),
        json(next.meta),
        next.price.toString(),
        next.size.toString(),
        s(next.amountUsd),
        id,
      );
    return next;
  }

  getOrder(id: string): OrderRow | null {
    const r = this.db.raw.prepare("SELECT * FROM orders WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? toOrder(r) : null;
  }

  findOrderByVenueRef(venue: VenueId, venueOrderId: string | null, hash: string | null): OrderRow | null {
    if (venueOrderId) {
      const r = this.db.raw
        .prepare("SELECT * FROM orders WHERE venue=? AND (venue_order_id=? OR hash=?) LIMIT 1")
        .get(venue, venueOrderId, venueOrderId) as Record<string, unknown> | undefined;
      if (r) return toOrder(r);
    }
    if (hash) {
      const r = this.db.raw
        .prepare("SELECT * FROM orders WHERE venue=? AND (hash=? OR venue_order_id=?) LIMIT 1")
        .get(venue, hash, hash) as Record<string, unknown> | undefined;
      if (r) return toOrder(r);
    }
    return null;
  }

  listOrders(filter: { pairId?: string; venue?: VenueId; nonTerminal?: boolean; limit?: number } = {}): OrderRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.pairId) {
      where.push("pair_id=?");
      args.push(filter.pairId);
    }
    if (filter.venue) {
      where.push("venue=?");
      args.push(filter.venue);
    }
    if (filter.nonTerminal) where.push("status NOT IN ('FILLED','CANCELLED','EXPIRED','REJECTED','NOT_FOUND')");
    const sql = `SELECT * FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC ${
      filter.limit ? `LIMIT ${Math.floor(filter.limit)}` : ""
    }`;
    return (this.db.raw.prepare(sql).all(...args) as Record<string, unknown>[]).map(toOrder);
  }

  // ---------------- 成交 ----------------
  getFill(key: string): FillRow | null {
    const r = this.db.raw.prepare("SELECT * FROM fills WHERE key=?").get(key) as Record<string, unknown> | undefined;
    return r ? toFill(r) : null;
  }

  /**
   * 幂等写入成交：
   * - 同一 key 只会有一条记录；
   * - 终态（SETTLED/FAILED）不再改变；
   * - 非终态之间只前进不后退；
   * - 手续费以结算回报为准（结算回报会覆盖估算值）。
   */
  upsertFill(f: FillRow): FillUpsertResult {
    return this.db.tx(() => {
      const prev = this.getFill(f.key);
      if (!prev) {
        this.writeFill(f, true);
        return { action: "inserted" as const, prev: null, row: f };
      }
      let next: FillRow = { ...prev };
      let changed = false;
      if (!isTerminalFill(prev.status) && prev.status !== f.status) {
        if (isTerminalFill(f.status) || FILL_RANK[f.status] >= FILL_RANK[prev.status]) {
          next.status = f.status;
          changed = true;
        }
      }
      // 手续费：估算值可被实际值覆盖
      if (prev.feeEstimated && !f.feeEstimated) {
        next = {
          ...next,
          feeShares: f.feeShares,
          feeCollateral: f.feeCollateral,
          feeUsd: f.feeUsd,
          feeEstimated: false,
          netShares: f.netShares,
          cashFlow: f.cashFlow,
        };
        changed = true;
      }
      if (!prev.txHash && f.txHash) {
        next.txHash = f.txHash;
        changed = true;
      }
      if (!prev.orderId && f.orderId) {
        next.orderId = f.orderId;
        changed = true;
      }
      if (!changed) return { action: "ignored" as const, prev, row: prev };
      next.updatedAt = f.updatedAt;
      this.writeFill(next, false);
      return { action: "updated" as const, prev, row: next };
    });
  }

  private writeFill(f: FillRow, insert: boolean): void {
    const cols = [
      f.pairId,
      f.venue,
      f.orderId,
      f.venueOrderId,
      f.role,
      f.outcome,
      f.side,
      f.tokenId,
      f.price.toString(),
      f.grossShares.toString(),
      f.feeShares.toString(),
      f.feeCollateral.toString(),
      f.feeUsd.toString(),
      f.feeEstimated ? 1 : 0,
      f.netShares.toString(),
      f.cashFlow.toString(),
      f.isMaker ? 1 : 0,
      f.status,
      f.matchedAt,
      f.updatedAt,
      f.txHash,
      json(f.raw),
    ] as const;
    if (insert) {
      this.db.raw
        .prepare(
          `INSERT INTO fills(pair_id,venue,order_id,venue_order_id,role,outcome,side,token_id,price,gross_shares,fee_shares,fee_collateral,fee_usd,
           fee_estimated,net_shares,cash_flow,is_maker,status,matched_at,updated_at,tx_hash,raw,key,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(...cols, f.key, f.receivedAt);
    } else {
      this.db.raw
        .prepare(
          `UPDATE fills SET pair_id=?,venue=?,order_id=?,venue_order_id=?,role=?,outcome=?,side=?,token_id=?,price=?,gross_shares=?,fee_shares=?,
           fee_collateral=?,fee_usd=?,fee_estimated=?,net_shares=?,cash_flow=?,is_maker=?,status=?,matched_at=?,updated_at=?,tx_hash=?,raw=? WHERE key=?`,
        )
        .run(...cols, f.key);
    }
  }

  listFills(filter: { pairId?: string; orderId?: string; limit?: number } = {}): FillRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.pairId) {
      where.push("pair_id=?");
      args.push(filter.pairId);
    }
    if (filter.orderId) {
      where.push("order_id=?");
      args.push(filter.orderId);
    }
    const sql = `SELECT * FROM fills ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY matched_at ASC ${
      filter.limit ? `LIMIT ${Math.floor(filter.limit)}` : ""
    }`;
    return (this.db.raw.prepare(sql).all(...args) as Record<string, unknown>[]).map(toFill);
  }

  // ---------------- 暂存（找不到所属订单的成交） ----------------
  parkUnmatchedFill(key: string, venue: VenueId, venueOrderId: string | null, orderHash: string | null, raw: unknown, now: number): void {
    this.db.raw
      .prepare(
        "INSERT INTO unmatched_fills(key,venue,venue_order_id,order_hash,raw,received_at,resolved) VALUES (?,?,?,?,?,?,0) ON CONFLICT(key) DO UPDATE SET raw=excluded.raw",
      )
      .run(key, venue, venueOrderId, orderHash, json(raw), now);
  }

  listUnmatchedFills(venue?: VenueId): { key: string; venue: VenueId; venueOrderId: string | null; orderHash: string | null; raw: unknown; receivedAt: number }[] {
    const rows = (venue
      ? this.db.raw.prepare("SELECT * FROM unmatched_fills WHERE resolved=0 AND venue=?").all(venue)
      : this.db.raw.prepare("SELECT * FROM unmatched_fills WHERE resolved=0").all()) as Record<string, unknown>[];
    return rows.map((r) => ({
      key: String(r.key),
      venue: r.venue as VenueId,
      venueOrderId: (r.venue_order_id as string | null) ?? null,
      orderHash: (r.order_hash as string | null) ?? null,
      raw: parse(r.raw),
      receivedAt: Number(r.received_at),
    }));
  }

  resolveUnmatchedFill(key: string): void {
    this.db.raw.prepare("UPDATE unmatched_fills SET resolved=1 WHERE key=?").run(key);
  }

  // ---------------- 配对 ----------------
  upsertPair(p: {
    id: string;
    status: string;
    statusReason: string | null;
    definition: unknown;
    verification: unknown;
    rulesHash: string | null;
    approvedRulesHash?: string | null;
    approvedBy?: string | null;
    now: number;
  }): void {
    const cur = this.getPair(p.id);
    if (!cur) {
      this.db.raw
        .prepare(
          "INSERT INTO pairs(id,status,status_reason,definition,verification,rules_hash,approved_rules_hash,approved_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(p.id, p.status, p.statusReason, json(p.definition), json(p.verification), p.rulesHash, p.approvedRulesHash ?? null, p.approvedBy ?? null, p.now, p.now);
      return;
    }
    this.db.raw
      .prepare(
        "UPDATE pairs SET status=?,status_reason=?,definition=?,verification=?,rules_hash=?,approved_rules_hash=?,approved_by=?,updated_at=? WHERE id=?",
      )
      .run(
        p.status,
        p.statusReason,
        json(p.definition),
        json(p.verification),
        p.rulesHash,
        p.approvedRulesHash === undefined ? cur.approvedRulesHash : p.approvedRulesHash,
        p.approvedBy === undefined ? cur.approvedBy : p.approvedBy,
        p.now,
        p.id,
      );
  }

  getPair(id: string): PairRow | null {
    const r = this.db.raw.prepare("SELECT * FROM pairs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? toPair(r) : null;
  }

  listPairs(): PairRow[] {
    return (this.db.raw.prepare("SELECT * FROM pairs ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(toPair);
  }

  setPairStatus(id: string, status: string, reason: string | null, now: number): void {
    this.db.raw.prepare("UPDATE pairs SET status=?,status_reason=?,updated_at=? WHERE id=?").run(status, reason, now, id);
  }

  // ---------------- 规则快照 ----------------
  insertSnapshot(x: { venue: VenueId; marketKey: string; fetchedAt: number; rulesHash: string; rulesText: string; versionTag: string | null; raw: unknown }): void {
    const last = this.db.raw
      .prepare("SELECT rules_hash, version_tag FROM market_snapshots WHERE venue=? AND market_key=? ORDER BY id DESC LIMIT 1")
      .get(x.venue, x.marketKey) as { rules_hash: string; version_tag: string | null } | undefined;
    if (last && last.rules_hash === x.rulesHash && last.version_tag === x.versionTag) return;
    this.db.raw
      .prepare("INSERT INTO market_snapshots(venue,market_key,fetched_at,rules_hash,rules_text,version_tag,raw) VALUES (?,?,?,?,?,?,?)")
      .run(x.venue, x.marketKey, x.fetchedAt, x.rulesHash, x.rulesText, x.versionTag, json(x.raw));
  }

  latestSnapshot(venue: VenueId, marketKey: string): { rulesHash: string; rulesText: string; versionTag: string | null; fetchedAt: number } | null {
    const r = this.db.raw
      .prepare("SELECT * FROM market_snapshots WHERE venue=? AND market_key=? ORDER BY id DESC LIMIT 1")
      .get(venue, marketKey) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { rulesHash: String(r.rules_hash), rulesText: String(r.rules_text), versionTag: (r.version_tag as string | null) ?? null, fetchedAt: Number(r.fetched_at) };
  }

  // ---------------- 审计事件、告警、裸仓事件、KV ----------------
  logEvent(ts: number, venue: string | null, kind: string, ref: string | null, data: unknown): void {
    this.db.raw.prepare("INSERT INTO events(ts,venue,kind,ref,data) VALUES (?,?,?,?,?)").run(ts, venue, kind, ref, json(data));
  }

  insertAlert(a: { ts: number; level: string; pairId: string | null; code: string; message: string; data?: unknown }): number {
    const r = this.db.raw
      .prepare("INSERT INTO alerts(ts,level,pair_id,code,message,data) VALUES (?,?,?,?,?,?)")
      .run(a.ts, a.level, a.pairId, a.code, a.message, json(a.data));
    return Number(r.lastInsertRowid);
  }

  listAlerts(limit = 50): { id: number; ts: number; level: string; pairId: string | null; code: string; message: string; acked: boolean }[] {
    return (this.db.raw.prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      level: String(r.level),
      pairId: (r.pair_id as string | null) ?? null,
      code: String(r.code),
      message: String(r.message),
      acked: Number(r.acked) === 1,
    }));
  }

  openEpisode(pairId: string, startedAt: number, peak: Fx): number {
    const r = this.db.raw
      .prepare("INSERT INTO hedge_episodes(pair_id,started_at,peak_shares) VALUES (?,?,?)")
      .run(pairId, startedAt, peak.toString());
    return Number(r.lastInsertRowid);
  }

  updateEpisode(id: number, patch: { peak?: Fx; resolvedAt?: number; resolution?: string; notes?: string }): void {
    const cur = this.db.raw.prepare("SELECT * FROM hedge_episodes WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!cur) return;
    this.db.raw
      .prepare("UPDATE hedge_episodes SET peak_shares=?,resolved_at=?,resolution=?,notes=? WHERE id=?")
      .run(
        (patch.peak ?? bi(cur.peak_shares)).toString(),
        patch.resolvedAt ?? (cur.resolved_at as number | null) ?? null,
        patch.resolution ?? (cur.resolution as string | null) ?? null,
        patch.notes ?? (cur.notes as string | null) ?? null,
        id,
      );
  }

  listEpisodes(pairId: string, limit = 20): { id: number; startedAt: number; resolvedAt: number | null; peak: Fx; resolution: string | null }[] {
    return (this.db.raw.prepare("SELECT * FROM hedge_episodes WHERE pair_id=? ORDER BY id DESC LIMIT ?").all(pairId, limit) as Record<string, unknown>[]).map(
      (r) => ({
        id: Number(r.id),
        startedAt: Number(r.started_at),
        resolvedAt: (r.resolved_at as number | null) ?? null,
        peak: bi(r.peak_shares),
        resolution: (r.resolution as string | null) ?? null,
      }),
    );
  }

  getKv(k: string): string | null {
    const r = this.db.raw.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }

  setKv(k: string, v: string, now: number): void {
    this.db.raw.prepare("INSERT INTO kv(k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at").run(k, v, now);
  }
}

export interface PairRow {
  id: string;
  status: string;
  statusReason: string | null;
  definition: unknown;
  verification: unknown;
  rulesHash: string | null;
  approvedRulesHash: string | null;
  approvedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

function toPair(r: Record<string, unknown>): PairRow {
  return {
    id: String(r.id),
    status: String(r.status),
    statusReason: (r.status_reason as string | null) ?? null,
    definition: parse(r.definition),
    verification: parse(r.verification),
    rulesHash: (r.rules_hash as string | null) ?? null,
    approvedRulesHash: (r.approved_rules_hash as string | null) ?? null,
    approvedBy: (r.approved_by as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

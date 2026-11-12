import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS pairs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    status_reason TEXT,
    definition TEXT NOT NULL,
    verification TEXT,
    rules_hash TEXT,
    approved_rules_hash TEXT,
    approved_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venue TEXT NOT NULL,
    market_key TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    rules_hash TEXT,
    rules_text TEXT,
    version_tag TEXT,
    raw TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_snap_market ON market_snapshots(venue, market_key, fetched_at);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    pair_id TEXT NOT NULL,
    venue TEXT NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    outcome TEXT NOT NULL,
    token_id TEXT NOT NULL,
    side TEXT NOT NULL,
    price TEXT NOT NULL,
    size TEXT NOT NULL,
    amount_usd TEXT,
    post_only INTEGER NOT NULL,
    status TEXT NOT NULL,
    venue_order_id TEXT,
    hash TEXT,
    reported_filled TEXT NOT NULL DEFAULT '0',
    planned_fill TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    ack_at INTEGER,
    updated_at INTEGER NOT NULL,
    terminal_at INTEGER,
    error TEXT,
    payload TEXT,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_voi ON orders(venue, venue_order_id);
  CREATE INDEX IF NOT EXISTS idx_orders_hash ON orders(venue, hash);
  CREATE INDEX IF NOT EXISTS idx_orders_pair ON orders(pair_id, status);
  CREATE TABLE IF NOT EXISTS fills (
    key TEXT PRIMARY KEY,
    pair_id TEXT NOT NULL,
    venue TEXT NOT NULL,
    order_id TEXT,
    venue_order_id TEXT,
    role TEXT NOT NULL,
    outcome TEXT NOT NULL,
    side TEXT NOT NULL,
    token_id TEXT NOT NULL,
    price TEXT NOT NULL,
    gross_shares TEXT NOT NULL,
    fee_shares TEXT NOT NULL,
    fee_collateral TEXT NOT NULL,
    fee_usd TEXT NOT NULL,
    fee_estimated INTEGER NOT NULL,
    net_shares TEXT NOT NULL,
    cash_flow TEXT NOT NULL,
    is_maker INTEGER NOT NULL,
    status TEXT NOT NULL,
    matched_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    tx_hash TEXT,
    raw TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fills_pair ON fills(pair_id);
  CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
  CREATE TABLE IF NOT EXISTS unmatched_fills (
    key TEXT PRIMARY KEY,
    venue TEXT NOT NULL,
    venue_order_id TEXT,
    order_hash TEXT,
    raw TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    venue TEXT,
    kind TEXT NOT NULL,
    ref TEXT,
    data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    pair_id TEXT,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,
    acked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS hedge_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pair_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    resolved_at INTEGER,
    peak_shares TEXT NOT NULL,
    resolution TEXT,
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v2：成交的本机首次收到时间（统计补单耗时用）
  `ALTER TABLE fills ADD COLUMN received_at INTEGER;`,
];

export class Db {
  readonly raw: DatabaseSync;
  private inTx = false;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode=WAL;");
    this.raw.exec("PRAGMA synchronous=NORMAL;");
    this.raw.exec("PRAGMA busy_timeout=5000;");
    this.raw.exec("PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);");
    const row = this.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null } | undefined;
    const current = row?.v ?? 0;
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[i]!);
        this.raw.prepare("INSERT INTO schema_version(version) VALUES (?)").run(i + 1);
      });
    }
  }

  /** 同步事务；嵌套调用直接执行。 */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.inTx = true;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  close(): void {
    this.raw.close();
  }
}

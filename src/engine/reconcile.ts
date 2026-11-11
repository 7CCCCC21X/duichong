import type { Logger } from "pino";
import { abs, fx, toStr, type Fx } from "../core/fixed.js";
import { errMsg, type KeyedSerialQueue } from "../core/async.js";
import type { Clock } from "../core/time.js";
import type { Outcome, VenueId } from "../core/types.js";
import { isTerminalOrder, VENUES } from "../core/types.js";
import type { Repo } from "../db/repo.js";
import type { TradingVenue } from "../venues/types.js";
import type { AlertSink } from "./alerts.js";
import type { PairEngine } from "./pairEngine.js";

export interface ReconcileReport {
  pairId: string;
  ok: boolean;
  ordersChecked: number;
  ordersUpdated: number;
  fillsSeen: number;
  orphanOrders: { venue: VenueId; venueOrderId: string | null; tokenId?: string; cancelled: boolean }[];
  positionMismatches: { venue: VenueId; outcome: Outcome; tokenId: string; venueShares: string; ledgerShares: string; diff: string }[];
  errors: string[];
}

export interface ReconcileDeps {
  repo: Repo;
  clock: Clock;
  venues: Record<VenueId, TradingVenue>;
  queue: KeyedSerialQueue;
  alerts: AlertSink;
  log: Logger;
}

const FILL_LOOKBACK_MS = 6 * 3600_000;

/**
 * 对账顺序：已知订单 → 近期成交 → 交易所挂单（找孤儿单）→ 真实持仓。
 * 只有全部通过才把配对标记为可挂单。持仓不一致时保持暂停并告警，
 * 人工确认后可用 CLI 接受当前持仓为基线。
 */
export async function reconcilePair(engine: PairEngine, d: ReconcileDeps, opts: { cancelOrphans: boolean; tolerance: number }): Promise<ReconcileReport> {
  const pair = engine.pair;
  const report: ReconcileReport = { pairId: pair.id, ok: false, ordersChecked: 0, ordersUpdated: 0, fillsSeen: 0, orphanOrders: [], positionMismatches: [], errors: [] };
  engine.beginReconcile();
  const now = d.clock.now();
  const tokens: Record<VenueId, string[]> = {
    predict: [pair.instruments.predict.A.tokenId, pair.instruments.predict.B.tokenId],
    polymarket: [pair.instruments.polymarket.A.tokenId, pair.instruments.polymarket.B.tokenId],
  };

  // 1) 已知的未终结订单
  const open = d.repo.listOrders({ pairId: pair.id, nonTerminal: true });
  for (const o of open) {
    report.ordersChecked++;
    try {
      const before = o.status;
      await engine.resolveOrder(o.id);
      const after = d.repo.getOrder(o.id);
      if (after && after.status !== before) report.ordersUpdated++;
      // 从未发出的订单（INTENT/PREPARED）查不到即视为未发送
      if (after && (after.status === "INTENT" || after.status === "PREPARED")) {
        const st = await d.venues[o.venue].getOrder({ venueOrderId: o.venueOrderId, hash: o.hash, tokenId: o.tokenId });
        if (st.status === "NOT_FOUND") d.repo.updateOrder(o.id, { status: "NOT_FOUND", error: "重启时确认未发送" }, d.clock.now());
      }
    } catch (e) {
      report.errors.push(`查单 ${o.id}: ${errMsg(e)}`);
    }
  }

  // 2) 近期成交（补漏、去重由台账保证）
  const oldestOpen = open.reduce((m, o) => Math.min(m, o.createdAt), now);
  for (const v of VENUES) {
    const key = `recon.${pair.id}.${v}.lastFillTs`;
    const last = Number(d.repo.getKv(key) ?? "0");
    const since = Math.min(last > 0 ? last - 10 * 60_000 : now - FILL_LOOKBACK_MS, oldestOpen - 60_000);
    try {
      const fills = await d.venues[v].listFills(since, tokens[v]);
      await d.queue.run(pair.id, () => {
        for (const f of fills) {
          report.fillsSeen++;
          const order = d.repo.findOrderByVenueRef(v, f.venueOrderId, f.orderHash);
          if (order && order.pairId === pair.id) engine.onFill(order, f);
        }
      });
      d.repo.setKv(key, String(now), now);
    } catch (e) {
      report.errors.push(`${v} 成交补拉失败: ${errMsg(e)}`);
    }
  }

  // 成交补拉完成（无错误）后即可基于台账补单；持仓核对通过后才恢复挂单
  if (report.errors.length === 0) {
    engine.setFillsSynced(true);
    void engine.schedule("fills-synced");
  }

  // 3) 交易所上的挂单：找不在本地记录中的孤儿单
  for (const v of VENUES) {
    try {
      const venueOpen = await d.venues[v].listOpenOrders(tokens[v]);
      for (const st of venueOpen) {
        const known = d.repo.findOrderByVenueRef(v, st.venueOrderId, st.hash);
        if (known) {
          if (isTerminalOrder(known.status)) {
            // 本地认为已结束但交易所仍挂着：以交易所为准撤掉
            report.orphanOrders.push({ venue: v, venueOrderId: st.venueOrderId, tokenId: st.tokenId, cancelled: false });
            await d.venues[v].cancel([{ venueOrderId: st.venueOrderId, hash: st.hash }]);
            report.orphanOrders[report.orphanOrders.length - 1]!.cancelled = true;
          }
          continue;
        }
        const entry = { venue: v, venueOrderId: st.venueOrderId, tokenId: st.tokenId, cancelled: false };
        if (opts.cancelOrphans) {
          try {
            await d.venues[v].cancel([{ venueOrderId: st.venueOrderId, hash: st.hash }]);
            entry.cancelled = true;
          } catch (e) {
            report.errors.push(`撤销孤儿挂单失败 ${st.venueOrderId}: ${errMsg(e)}`);
          }
        }
        report.orphanOrders.push(entry);
      }
    } catch (e) {
      report.errors.push(`${v} 查询挂单失败: ${errMsg(e)}`);
    }
  }
  if (report.orphanOrders.length) {
    d.alerts.raise("warn", "ORPHAN_ORDERS", `发现 ${report.orphanOrders.length} 笔本地无记录的挂单${opts.cancelOrphans ? "，已撤销" : ""}`, {
      pairId: pair.id,
      data: report.orphanOrders,
    });
  }

  // 4) 真实持仓对比（台账：未失败的全部成交；交易所：链上/接口持仓；减去人工确认的基线）
  const fills = d.repo.listFills({ pairId: pair.id });
  const ledger = new Map<string, Fx>();
  for (const f of fills) {
    if (f.status === "FAILED") continue;
    const k = `${f.venue}:${f.tokenId}`;
    ledger.set(k, (ledger.get(k) ?? 0n) + (f.side === "BUY" ? f.netShares : -f.netShares));
  }
  const tol = fx(opts.tolerance);
  for (const v of VENUES) {
    try {
      const pos = await d.venues[v].getPositions(tokens[v]);
      for (const p of pos) {
        const baseline = BigInt(d.repo.getKv(`pair.${pair.id}.baseline.${v}.${p.tokenId}`) ?? "0");
        const led = ledger.get(`${v}:${p.tokenId}`) ?? 0n;
        const diff = p.shares - baseline - led;
        if (abs(diff) > tol) {
          const outcome: Outcome = pair.instruments[v].A.tokenId === p.tokenId ? "A" : "B";
          report.positionMismatches.push({ venue: v, outcome, tokenId: p.tokenId, venueShares: toStr(p.shares, 6), ledgerShares: toStr(led + baseline, 6), diff: toStr(diff, 6) });
        }
      }
    } catch (e) {
      report.errors.push(`${v} 查询持仓失败: ${errMsg(e)}`);
    }
  }
  if (report.positionMismatches.length) {
    d.alerts.raise("critical", "POSITION_MISMATCH", `真实持仓与台账不一致，暂停该配对挂单：${report.positionMismatches.map((m) => `${m.venue}/${m.outcome} 差 ${m.diff}`).join("；")}`, {
      pairId: pair.id,
      data: report.positionMismatches,
    });
  }

  report.ok = report.errors.length === 0 && report.positionMismatches.length === 0;
  engine.setReconciled(report.ok);
  d.repo.logEvent(d.clock.now(), null, "reconcile", pair.id, report);
  d.log.info({ pair: pair.id, ok: report.ok, orders: report.ordersChecked, fills: report.fillsSeen, orphans: report.orphanOrders.length, mismatches: report.positionMismatches.length, errors: report.errors }, "对账完成");
  void engine.schedule("reconciled");
  return report;
}

/** 人工确认：把当前“交易所持仓 − 台账”记为基线（例如账户里原本就有的持仓）。 */
export async function acceptPositionsAsBaseline(engine: PairEngine, d: ReconcileDeps): Promise<{ venue: VenueId; tokenId: string; baseline: string }[]> {
  const pair = engine.pair;
  const fills = d.repo.listFills({ pairId: pair.id });
  const out: { venue: VenueId; tokenId: string; baseline: string }[] = [];
  for (const v of VENUES) {
    const tokens = [pair.instruments[v].A.tokenId, pair.instruments[v].B.tokenId];
    const pos = await d.venues[v].getPositions(tokens);
    for (const p of pos) {
      let led = 0n;
      for (const f of fills) if (f.venue === v && f.tokenId === p.tokenId && f.status !== "FAILED") led += f.side === "BUY" ? f.netShares : -f.netShares;
      const baseline = p.shares - led;
      d.repo.setKv(`pair.${pair.id}.baseline.${v}.${p.tokenId}`, baseline.toString(), d.clock.now());
      out.push({ venue: v, tokenId: p.tokenId, baseline: toStr(baseline, 6) });
    }
  }
  return out;
}

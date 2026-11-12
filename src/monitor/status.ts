import { toStr, type Fx } from "../core/fixed.js";
import { bjTime, fmtDuration } from "../core/time.js";
import { VENUES, type Outcome, type VenueId } from "../core/types.js";
import type { AppContext } from "../app.js";
import type { PairSnapshot } from "../engine/pairEngine.js";
import { computeHedgeStats, statsSummary } from "./stats.js";

let statsCache: { at: number; data: Record<string, unknown> } | null = null;

const f = (x: Fx | null | undefined, dp = 4) => (x === null || x === undefined ? "-" : toStr(x, dp));

export function pairStatusJson(s: PairSnapshot, now: number): Record<string, unknown> {
  const pos = s.positions;
  const venuePos: Record<string, Record<string, string>> = {};
  for (const v of VENUES) {
    venuePos[v] = {};
    for (const o of ["A", "B"] as Outcome[]) {
      venuePos[v]![`${o}_计入敞口`] = f(pos.shares[v][o]);
      venuePos[v]![`${o}_已结算`] = f(pos.settled[v][o]);
      venuePos[v]![`${o}_待结算`] = f(pos.pending[v][o]);
    }
  }
  const eps = s.episodes.map((e) => ({
    开始: bjTime(e.startedAt, true),
    结束: e.resolvedAt ? bjTime(e.resolvedAt, true) : "未结束",
    补单耗时: e.resolvedAt ? fmtDuration(e.resolvedAt - e.startedAt) : fmtDuration(now - e.startedAt),
    峰值敞口: f(e.peak, 2),
    结果: e.resolution ?? "-",
  }));
  const done = s.episodes.filter((e) => e.resolvedAt);
  const avgMs = done.length ? done.reduce((a, e) => a + (e.resolvedAt! - e.startedAt), 0) / done.length : null;
  return {
    配对: s.id,
    队伍: { A: s.labels.A, B: s.labels.B },
    挂单方向: `${s.makerVenue} 买 ${s.labels[s.makerOutcome]}（${s.makerOutcome}），在 ${s.makerVenue === "predict" ? "polymarket" : "predict"} 买 ${s.labels[s.makerOutcome === "A" ? "B" : "A"]} 对冲`,
    挂单状态: s.mode,
    挂单说明: s.reason,
    敞口状态: s.exposureMode,
    敞口说明: s.exposureReason,
    紧急处理: s.emergency ? { 开始: bjTime(s.emergency.since), 原因: s.emergency.reason } : null,
    开赛时间: bjTime(s.startTime),
    停止挂单时间: bjTime(s.stopQuotingAt),
    净敞口_份: f(s.netExposure),
    含在途补单的预计敞口_份: f(s.projectedNet),
    裸仓开始: s.nakedSince ? `${bjTime(s.nakedSince, true)}（已 ${fmtDuration(now - s.nakedSince)}）` : null,
    持仓: venuePos,
    盈亏: {
      已对冲份数: f(s.pnl.hedged, 4),
      两腿净花费: f(s.pnl.totalSpend, 4),
      费用合计: f(s.pnl.feesUsd, 4),
      其中估算费用: f(pos.feesEstimatedUsd, 4),
      锁定费后盈亏: f(s.pnl.lockedPnl, 4),
      未对冲部分成本: f(s.pnl.residualCost, 4),
    },
    补单耗时: { 平均: fmtDuration(avgMs), 最近: eps.slice(0, 10) },
    最近报价: s.lastQuote
      ? s.lastQuote.ok
        ? {
            价格: f(s.lastQuote.price, 4),
            数量: f(s.lastQuote.size, 2),
            盈利上限挂价: f(s.lastQuote.makerPriceMax, 4),
            对冲每份成本含费: f(s.lastQuote.hedgeAvgEffPrice, 4),
            预期每份利润: f(s.lastQuote.expectedProfitPerShare, 4),
            预期总利润: f(s.lastQuote.expectedProfitTotal, 4),
            说明: s.lastQuote.notes,
          }
        : { 不挂单原因: s.lastQuote.reason }
      : null,
    盘口: Object.fromEntries(
      Object.entries(s.books).map(([k, b]) => [
        k,
        b
          ? {
              延迟: fmtDuration(b.ageMs),
              买: b.bids.map((l) => `${toStr(l.price, 3)} × ${toStr(l.size, 2)}`),
              卖: b.asks.map((l) => `${toStr(l.price, 3)} × ${toStr(l.size, 2)}`),
            }
          : null,
      ]),
    ),
    订单: s.orders.slice(0, 30).map((o) => ({
      时间: bjTime(o.createdAt, true),
      角色: o.role,
      平台: o.venue,
      方向: `${o.side} ${o.outcome}`,
      价格: f(o.price, 4),
      数量: f(o.size, 4),
      金额: o.amountUsd !== null ? f(o.amountUsd, 4) : undefined,
      已成交: f(o.reportedFilled, 4),
      状态: o.status,
      交易所ID: o.venueOrderId ?? o.hash ?? "-",
      错误: o.error ?? undefined,
    })),
    成交: s.fills
      .slice(-30)
      .reverse()
      .map((x) => ({
        时间: bjTime(x.matchedAt, true),
        角色: x.role,
        平台: x.venue,
        方向: `${x.side} ${x.outcome}`,
        价格: f(x.price, 4),
        撮合份额: f(x.grossShares, 4),
        净到账份额: f(x.netShares, 4),
        手续费: `${f(x.feeUsd, 5)}${x.feeEstimated ? "（估算）" : ""}`,
        现金流: f(x.cashFlow, 4),
        maker: x.isMaker,
        状态: x.status,
      })),
  };
}

export function statusJson(ctx: AppContext): Record<string, unknown> {
  const now = ctx.clock.now();
  const balances: Record<string, unknown> = {};
  const health: Record<string, unknown> = {};
  for (const v of VENUES as VenueId[]) {
    const b = ctx.risk.getBalances(v);
    balances[v] = b ? { 余额: f(b.collateral, 4), 可用: f(b.available, 4), 扣除本系统其他占用后: f(ctx.risk.availableFor(v, null), 4), 更新: bjTime(b.updatedAt) } : null;
    health[v] = ctx.venues[v].health();
  }
  return {
    模式: ctx.live ? "实盘" : "模拟（真实公开行情 + 模拟成交）",
    当前时间: bjTime(now),
    启动时间: bjTime(ctx.startedAt),
    全局停止新挂单: ctx.risk.halted ? { 原因: ctx.risk.halted.reason, 开始: bjTime(ctx.risk.halted.since) } : null,
    当日亏损: f(ctx.risk.lossTodayUsd(), 4),
    平台阻断: ctx.risk.listBlocks().map((b) => ({ 平台: b.venue, 原因: b.reason, 开始: bjTime(b.since), 到期: bjTime(b.until) })),
    行情连接: { polymarket: ctx.pmFeed.up, predict: ctx.pfFeed.usesWs ? ctx.pfFeed.up : "REST 轮询" },
    交易连接: health,
    余额: balances,
    配对: [...ctx.engines.values()].map((e) => pairStatusJson(e.snapshot(), now)),
    补单统计_近7天: (() => {
      if (!statsCache || now - statsCache.at > 10_000) {
        const since = now - 7 * 24 * 3600_000;
        statsCache = { at: now, data: Object.fromEntries([...ctx.engines.keys()].map((id) => [id, statsSummary(computeHedgeStats(ctx.repo, id, since))])) };
      }
      return statsCache.data;
    })(),
    待审核或未通过的配对: [...ctx.stored.values()].filter((p) => p.status !== "APPROVED" && p.status !== "APPROVED_MANUAL").map((p) => ({ 配对: p.id, 状态: p.status, 原因: p.statusReason })),
    告警: ctx.alerts.recent.slice(0, 30).map((a) => ({ 时间: bjTime(a.ts), 级别: a.level, 代码: a.code, 配对: a.pairId ?? "-", 内容: a.message })),
  };
}

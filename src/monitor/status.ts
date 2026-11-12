import { createServer, type Server } from "node:http";
import { toStr, type Fx } from "../core/fixed.js";
import { bjTime, fmtDuration } from "../core/time.js";
import { VENUES, type Outcome, type VenueId } from "../core/types.js";
import type { AppContext } from "../app.js";
import type { PairSnapshot } from "../engine/pairEngine.js";

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
    待审核或未通过的配对: [...ctx.stored.values()].filter((p) => p.status !== "APPROVED" && p.status !== "APPROVED_MANUAL").map((p) => ({ 配对: p.id, 状态: p.status, 原因: p.statusReason })),
    告警: ctx.alerts.recent.slice(0, 30).map((a) => ({ 时间: bjTime(a.ts), 级别: a.level, 代码: a.code, 配对: a.pairId ?? "-", 内容: a.message })),
  };
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>对冲机器人状态</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--line:#e5e5ea;--warn:#b25000;--bad:#c00;--ok:#1a7f37;--card:#f7f7f9}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--mut:#9a9aa2;--line:#2c2c30;--card:#1c1c20;--warn:#ffa94d;--bad:#ff6b6b;--ok:#51cf66}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:18px;margin:0 0 8px}h2{font-size:15px;margin:18px 0 6px}h3{font-size:13px;margin:12px 0 4px;color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{border-bottom:1px solid var(--line);padding:3px 6px;text-align:left;white-space:nowrap}th{color:var(--mut);font-weight:500}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}.kv div:nth-child(odd){color:var(--mut)}
.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--ok)}.mut{color:var(--mut)}
</style></head><body><h1>Polymarket × Predict 对冲机器人</h1><div id="root" class="mut">加载中…</div>
<script>
const esc=s=>String(s??"-").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const kv=o=>'<div class="kv">'+Object.entries(o||{}).map(([k,v])=>'<div>'+esc(k)+'</div><div>'+(typeof v==="object"&&v!==null?esc(JSON.stringify(v)):esc(v))+'</div>').join("")+'</div>';
const table=rows=>{if(!rows||!rows.length)return '<div class="mut">无</div>';const ks=Object.keys(rows[0]);return '<table><tr>'+ks.map(k=>'<th>'+esc(k)+'</th>').join("")+'</tr>'+rows.map(r=>'<tr>'+ks.map(k=>'<td>'+esc(typeof r[k]==="object"&&r[k]!==null?JSON.stringify(r[k]):r[k])+'</td>').join("")+'</tr>').join("")+'</table>'};
async function load(){try{const q=new URLSearchParams(location.search);const r=await fetch('/api/status'+(q.get('token')?'?token='+encodeURIComponent(q.get('token')):''));const s=await r.json();
let h='<div class="card">'+kv({模式:s.模式,当前时间:s.当前时间,启动时间:s.启动时间,全局停止新挂单:s.全局停止新挂单?s.全局停止新挂单.原因:'否',当日亏损:s.当日亏损,行情连接:s.行情连接,交易连接:s.交易连接,余额:s.余额})+'</div>';
if(s.平台阻断.length)h+='<div class="card warn">'+table(s.平台阻断)+'</div>';
for(const p of s.配对){h+='<h2>'+esc(p.配对)+'：'+esc(p.队伍.A)+' vs '+esc(p.队伍.B)+'</h2><div class="card">'+kv({挂单方向:p.挂单方向,挂单状态:p.挂单状态+'：'+(p.挂单说明??''),敞口状态:p.敞口状态+'：'+(p.敞口说明??''),紧急处理:p.紧急处理?JSON.stringify(p.紧急处理):'无',开赛时间:p.开赛时间,停止挂单时间:p.停止挂单时间,净敞口:p.净敞口_份,预计敞口:p.含在途补单的预计敞口_份,裸仓:p.裸仓开始??'无',盈亏:p.盈亏,补单平均耗时:p.补单耗时.平均,最近报价:p.最近报价})+'</div>';
h+='<h3>盘口（前 5 档）</h3><div class="card">'+table(Object.entries(p.盘口).map(([k,b])=>({品种:k,延迟:b?.延迟,买:(b?.买||[]).join('  '),卖:(b?.卖||[]).join('  ')})))+'</div>';
h+='<h3>持仓</h3><div class="card">'+table(Object.entries(p.持仓).map(([v,o])=>({平台:v,...o})))+'</div>';
h+='<h3>订单</h3><div class="card">'+table(p.订单)+'</div><h3>成交</h3><div class="card">'+table(p.成交)+'</div><h3>补单耗时</h3><div class="card">'+table(p.补单耗时.最近)+'</div>'}
if(s.待审核或未通过的配对.length)h+='<h2>待审核 / 未通过的配对</h2><div class="card">'+table(s.待审核或未通过的配对)+'</div>';
h+='<h2>告警</h2><div class="card">'+table(s.告警)+'</div>';document.getElementById('root').innerHTML=h}catch(e){document.getElementById('root').textContent='读取状态失败：'+e}}
load();setInterval(load,2000);
</script></body></html>`;

export function startStatusServer(ctx: AppContext): Server | null {
  const cfg = ctx.cfg.app.statusServer;
  if (!cfg.enabled) return null;
  const token = ctx.cfg.secrets.statusToken;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (token && url.pathname.startsWith("/api") && url.searchParams.get("token") !== token && req.headers["x-status-token"] !== token) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    if (url.pathname === "/api/status") {
      try {
        const body = JSON.stringify(statusJson(ctx), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(body);
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      return;
    }
    res.writeHead(404).end("not found");
  });
  server.listen(cfg.port, cfg.host, () => ctx.log.info({ url: `http://${cfg.host}:${cfg.port}/` }, "状态页已启动"));
  return server;
}

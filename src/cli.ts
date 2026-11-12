#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { createLogger } from "./core/logger.js";
import { errMsg } from "./core/async.js";
import { toStr } from "./core/fixed.js";
import { bjTime } from "./core/time.js";
import { VENUES } from "./core/types.js";
import { isLive, loadConfig, predictUrls } from "./config/load.js";
import { createContext, loadPairs, refreshBalances, runBot } from "./app.js";
import { acceptPositionsAsBaseline } from "./engine/reconcile.js";
import { startConsoleServer } from "./console/server.js";
import { computeHedgeStats, statsSummary } from "./monitor/stats.js";
import { scanCandidates, type OpportunityRow } from "./monitor/scan.js";
import type { CapitalReport } from "./monitor/capital.js";
import { polymarketGeoblock } from "./market/geoblock.js";
import { Db } from "./db/db.js";
import { Repo } from "./db/repo.js";
import type { VerifyResult } from "./pairing/service.js";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) out.flags[k] = argv[++i]!;
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const HELP = `用法: node dist/cli.js <命令> [参数]

  run                                   启动机器人（默认模拟模式）
  check                                 检查配置、行情连通、凭证与余额（不下单）
  pairs discover [--all-types] [--no-save]
                                        遍历 Predict 电竞类别，按 polymarketConditionIds 找 Polymarket 子盘口并核对
  pairs verify <predictMarketId> <polymarketConditionId>
                                        核对指定的两个子盘口，打印检查项与结算情形矩阵
  pairs list                            列出已核对的配对
  pairs show <pairId>                   查看配对详情（含两边规则原文）
  pairs approve <pairId> --note "原因"  人工批准“待审核”配对（规则版本变化后需重新批准；也可在网页控制台审批）
  status [--url http://127.0.0.1:8787]  查看运行中机器人的状态（网页控制台同一地址，见 README）
  capital [--url http://127.0.0.1:8787]
                                        资金利用率（读取运行中机器人的数据）：余额、挂单占用、补单预留、持仓、限额使用、各配对收益
  scan [--json] [--all]                 哪些市场值得挂：遍历 Predict 电竞整场胜负盘，核对并按两边当前订单簿评估四个挂单方向
  stats [--db live|sim] [--hours 24] [--pair id] [--json] [--samples]
                                        补单统计：第一腿成交到第二腿成交的耗时 P50/P95、分段耗时、补单失败率、滑点
  books <predictMarketId> <polymarketConditionId>
                                        打印两边当前订单簿（REST）
  resume                                解除全局“停止新挂单”（机器人未运行时用；运行中请在网页控制台操作）
  accept-positions <pairId>             人工确认：把当前交易所持仓与台账的差额记为基线

通用参数: --config config/config.yaml --pairs config/pairs.yaml --env .env
`;

function printVerify(r: VerifyResult): void {
  const v = r.verification;
  console.log(`\n配对 ${r.pairId}  →  ${v.status}`);
  console.log(`  Predict   #${r.pf.id} ${r.pf.question} [${r.pf.marketType ?? "-"}] ${r.pf.status}/${r.pf.tradingStatus}`);
  console.log(`  Polymarket ${r.pm.conditionId} ${r.pm.question} [${r.pm.sportsMarketType ?? "-"}] version=${r.pm.version}`);
  if (r.def) {
    console.log(`  队伍：A=${r.def.labels.A}  B=${r.def.labels.B}   开赛：${bjTime(r.def.startTime)}（北京时间）`);
    console.log(`  Predict token  A=${r.def.predict.tokens.A.slice(0, 18)}…  B=${r.def.predict.tokens.B.slice(0, 18)}…`);
    console.log(`  Polymarket token A=${r.def.polymarket.tokens.A.slice(0, 18)}…  B=${r.def.polymarket.tokens.B.slice(0, 18)}…`);
  }
  for (const c of v.checks) console.log(`  [${c.level === "pass" ? "通过" : c.level === "warn" ? "注意" : "不符"}] ${c.label}：${c.detail}`);
  console.log("  结算情形（Predict 买 X + Polymarket 买对手）：");
  for (const s of v.scenarios) console.log(`    ${s.verdict === "consistent" ? "✓" : s.verdict === "mismatch" ? "✗" : "?"} ${s.label}：${s.predictLeg} + ${s.polymarketLeg} = ${s.total}${s.note ? `（${s.note}）` : ""}`);
}


const pctS = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "-" : `${(x * 100).toFixed(d)}%`);
const m2 = (x: number | null | undefined) => (x === null || x === undefined ? "-" : x.toFixed(2));
const p3 = (x: number | null | undefined) => (x === null || x === undefined ? "-" : x.toFixed(3));
const hrs = (h: number | null | undefined) => (h === null || h === undefined ? "-" : h < 0 ? "已过" : h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`);
const QUEUE_TXT: Record<string, string> = { ahead: "领先买一", join: "与买一同价", behind: "排在买一之后", empty: "簿上无买单" };
const VENUE_TXT: Record<string, string> = { predict: "Predict", polymarket: "Polymarket" };

function printCapital(d: CapitalReport): void {
  console.log(`资金利用率（更新于 ${d.at}，北京时间；USDT 与 pUSD 按 1:1）`);
  for (const v of d.venues) {
    console.log(`  ${VENUE_TXT[v.venue]}：余额 ${m2(v.balance)}，挂单占用 ${m2(v.makerReserved)}，补单预留 ${m2(v.hedgeReserved)}，在途 ${m2(v.inflight)}，闲置 ${m2(v.idle)}，持仓（进行中）${m2(v.positionsOpen)}${v.positionsFinished ? `，已结束比赛待赎回 ${m2(v.positionsFinished)}` : ""} → 利用率 ${pctS(v.utilization)}（含补单预留 ${pctS(v.utilizationInclReserve)}）`);
  }
  const t = d.total;
  console.log(`  合计：余额 ${m2(t.balance)}，工作中 ${m2(t.working)}，补单预留 ${m2(t.reserved)} → 利用率 ${pctS(t.utilization)}（含补单预留 ${pctS(t.utilizationInclReserve)}）`);
  const L = d.limits;
  console.log(`风控额度：全局资金 ${m2(L.globalCommitted)}/${L.maxGlobalUsd}（${pctS(L.globalUsage)}），全局未对冲 ${m2(L.globalUnhedged)}/${L.maxUnhedgedSharesGlobal} 份，当日亏损 ${m2(L.lossToday)}/${L.maxDailyLossUsd}`);
  for (const b of d.bindings) console.log(`挂单数量受限于“${b.reason}”：${b.pairs.join("、")}`);
  for (const h of d.hints) console.log(`提示：${h}`);
  console.log("各配对：");
  for (const p of d.pairs) {
    console.log(`  ${p.id}${p.active ? "" : "（已删除）"}  ${p.labels ? `${p.labels.A} vs ${p.labels.B}` : "-"}  ${p.phase}  挂单占用 ${m2(p.makerReserved)}  补单预留 ${m2(p.hedgeReserved)}  持仓 Predict ${m2(p.positions.predict)} / Polymarket ${m2(p.positions.polymarket)}  已对冲 ${m2(p.hedgedShares)} 份  锁定盈亏 ${m2(p.lockedPnl)}（${pctS(p.returnPct, 2)}）  挂单 ${p.quotedHours.toFixed(1)} 小时  每小时成交 ${p.filledPerHour ?? "-"} 份${p.sizeLimit ? `  数量受限于 ${p.sizeLimit}` : ""}`);
  }
}

function printScan(rows: OpportunityRow[], all: boolean, rejected: number, errors: string[]): void {
  const key = (r: OpportunityRow) => (r.best ? (r.best.queue === "behind" ? 1 : 2) * 1e6 + (r.best.returnPerDay ?? r.best.returnPct ?? 0) : -1);
  const sorted = [...rows].sort((a, b) => key(b) - key(a));
  console.log(`\n可交易候选 ${rows.length} 个（未通过核对 ${rejected} 个不列出）。排序：能排到买一的优先，再按每天资金收益率。时间为北京时间。`);
  for (const r of sorted) {
    const b = r.best;
    if (!b && !all) continue;
    const head = `${r.labels.A} vs ${r.labels.B}  开赛 ${r.startTime ?? "-"}（${hrs(r.hoursToStart)}后，停止挂单还剩 ${hrs(r.hoursToStop)}）  ${r.verifyStatus}${r.configuredAs ? `  已配置为 ${r.configuredAs}` : ""}`;
    console.log(`\n${head}`);
    console.log(`  Predict #${r.predictMarketId}  Polymarket ${r.polymarketConditionId}  PM 24h 成交 ${r.pmVolume24h === null ? "-" : r.pmVolume24h.toFixed(0)}`);
    if (!b) {
      console.log(`  四个方向都不可挂：${r.directions.map((d) => `${VENUE_TXT[d.makerVenue]} 买 ${d.makerTeam}：${d.reason}`).join("；")}`);
      continue;
    }
    for (const d of r.directions) {
      const mark = d === b || (d.makerVenue === b.makerVenue && d.makerOutcome === b.makerOutcome) ? "★" : " ";
      if (!d.ok) {
        console.log(`  ${mark} ${VENUE_TXT[d.makerVenue]} 挂买 ${d.makerTeam}：不可挂（${d.reason}）`);
        continue;
      }
      console.log(`  ${mark} ${VENUE_TXT[d.makerVenue]} 挂买 ${d.makerTeam}：挂 ${p3(d.price)}（上限 ${p3(d.makerPriceMax)}，买一 ${p3(d.bestBid)}，${QUEUE_TXT[d.queue ?? ""] ?? "-"}）× ${m2(d.size)} 份，每份利润 ${p3(d.profitPerShare)}，每对资金 ${p3(d.capitalPerShare)}，收益率 ${pctS(d.returnPct, 2)}，每天 ${pctS(d.returnPerDay, 2)}`);
    }
  }
  if (errors.length) console.log(`\n部分数据没拿到：${errors.join("；")}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...rest] = args._;
  if (!cmd || cmd === "help" || args.flags.help) {
    console.log(HELP);
    return;
  }
  const cfg = loadConfig({ configPath: args.flags.config as string | undefined, pairsPath: args.flags.pairs as string | undefined, envPath: args.flags.env as string | undefined });
  // 订单心跳只在 run 中开启：其他命令结束后心跳停止，10 秒后交易所会撤掉该 API Key 的全部挂单
  if (cmd !== "run") cfg.app.polymarket.orderHeartbeat = false;
  mkdirSync(cfg.app.dataDir, { recursive: true });
  const log = createLogger({ level: cmd === "run" ? cfg.app.logLevel : (process.env.LOG_LEVEL ?? "warn"), file: cmd === "run" ? (cfg.app.logFile ?? undefined) : undefined });

  if (cmd === "status") {
    const url = String(args.flags.url ?? `http://${cfg.app.statusServer.host}:${cfg.app.statusServer.port}`);
    const tok = cfg.secrets.statusToken ? `?token=${encodeURIComponent(cfg.secrets.statusToken)}` : "";
    const res = await fetch(`${url}/api/status${tok}`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (cmd === "capital") {
    const url = String(args.flags.url ?? `http://${cfg.app.statusServer.host}:${cfg.app.statusServer.port}`);
    const tok = cfg.secrets.statusToken ? `?token=${encodeURIComponent(cfg.secrets.statusToken)}` : "";
    const res = await fetch(`${url}/api/console/capital${tok}`);
    if (!res.ok) throw new Error(`读取失败：HTTP ${res.status}（机器人需要在运行，且 statusServer 已启用）`);
    printCapital((await res.json()) as CapitalReport);
    return;
  }

  if (cmd === "stats") {
    const which = String(args.flags.db ?? (isLive(cfg) ? "live" : "sim"));
    const db = new Db(`${cfg.app.dataDir}/${which}.db`);
    const repo = new Repo(db);
    const since = args.flags.hours ? Date.now() - Number(args.flags.hours) * 3600_000 : 0;
    const ids = args.flags.pair
      ? [String(args.flags.pair)]
      : (db.raw.prepare("SELECT DISTINCT pair_id AS id FROM fills ORDER BY pair_id").all() as { id: string }[]).map((r) => r.id);
    const out = ids.map((id) => computeHedgeStats(repo, id, since));
    if (args.flags.json) console.log(JSON.stringify(out.map((s) => ({ ...s, samples: args.flags.samples ? s.samples : undefined })), null, 2));
    else {
      console.log(`数据库：${which}.db  统计区间：${since ? `最近 ${args.flags.hours} 小时` : "全部"}  （时间均为北京时间）`);
      for (const s of out) {
        console.log(`\n配对 ${s.pairId}`);
        for (const [k, v] of Object.entries(statsSummary(s))) console.log(`  ${k}：${v}`);
        if (args.flags.samples) {
          for (const x of s.samples) {
            console.log(`    ${bjTime(x.firstLegAt, true)} ${x.makerVenue} ${x.shares} 份 → ${x.resolvedBy}${x.secondLegAt ? ` 交易所口径 ${x.secondLegAt - x.firstLegAt}ms` : ""}${x.secondLegReceivedAt ? ` 本机口径 ${x.secondLegReceivedAt - x.firstLegReceivedAt}ms` : ""}${x.slippage !== null ? ` 滑点 ${x.slippage.toFixed(4)}` : ""}`);
          }
        }
      }
    }
    db.close();
    return;
  }

  const ctx = createContext(cfg, log);

  switch (cmd) {
    case "run": {
      if (isLive(cfg)) log.warn("⚠ 实盘模式：将使用真实资金下单");
      const stop = await runBot(ctx);
      const server = startConsoleServer(ctx);
      let stopping = false;
      const shutdown = async (sig: string) => {
        if (stopping) return;
        stopping = true;
        log.info({ sig }, "收到退出信号");
        server?.close();
        await stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      return;
    }
    case "check": {
      const pf = predictUrls(cfg.app);
      console.log(`模式：${isLive(cfg) ? "实盘" : "模拟"}（config mode=${cfg.app.mode}，LIVE_TRADING=${cfg.secrets.liveTrading}）`);
      console.log(`Predict：${cfg.app.predict.network} ${pf.rest}  API Key：${cfg.secrets.predictApiKey ? "已配置" : "未配置（主网行情不可用）"}`);
      try {
        const t0 = Date.now();
        const res = await fetch(`${cfg.app.polymarket.clobUrl}/time`, { signal: AbortSignal.timeout(10_000) });
        console.log(`Polymarket 公共接口：${res.ok ? `可访问（往返 ${Date.now() - t0}ms）` : `HTTP ${res.status}`}`);
      } catch (e) {
        console.log(`Polymarket 公共接口：失败 ${errMsg(e)}`);
      }
      try {
        const t0 = Date.now();
        await ctx.pfPublic.categories(["ESPORTS_CS2"], 1);
        console.log(`Predict 公共接口：可访问（往返 ${Date.now() - t0}ms）`);
      } catch (e) {
        console.log(`Predict 公共接口：失败 ${errMsg(e)}`);
      }
      const geo = await polymarketGeoblock();
      if (geo.ok) console.log(`Polymarket 地理限制检查（本机出口 IP ${geo.ip}，${geo.country}${geo.region ? `-${geo.region}` : ""}）：${geo.blocked ? "被限制，不能在此下单" : "未被限制"}`);
      else console.log(`Polymarket 地理限制检查失败：${geo.error}`);
      console.log("Predict：没有公开的地区检查接口；受限地区下单会返回 403 forbidden，读行情不受地区限制（机器人收到 403 会阻断该平台并告警）。");
      if (isLive(cfg)) {
        for (const v of VENUES) {
          try {
            await ctx.venues[v].start();
            const b = await ctx.venues[v].getBalances();
            console.log(`${v} 认证成功，余额 ${toStr(b.collateral, 4)}，事件流 ${ctx.venues[v].health().userStreamUp ? "在线" : "连接中"}`);
            await ctx.venues[v].stop();
          } catch (e) {
            console.log(`${v} 认证/余额失败：${errMsg(e)}`);
          }
        }
      } else {
        console.log("模拟模式不检查交易凭证。");
      }
      process.exit(0);
      return;
    }
    case "pairs": {
      if (sub === "discover") {
        const { results, skipped } = await ctx.pairing.discover({ includeAllTypes: !!args.flags["all-types"], save: !args.flags["no-save"] });
        for (const r of results) printVerify(r);
        console.log(`\n共核对 ${results.length} 个候选：APPROVED ${results.filter((r) => r.verification.status === "APPROVED").length}，PENDING_REVIEW ${results.filter((r) => r.verification.status === "PENDING_REVIEW").length}，REJECTED ${results.filter((r) => r.verification.status === "REJECTED").length}`);
        for (const s of skipped) console.log(`  跳过：${s.reason} × ${s.count}`);
      } else if (sub === "verify") {
        const [pfId, cond] = rest;
        if (!pfId || !cond) throw new Error("用法：pairs verify <predictMarketId> <polymarketConditionId>");
        const r = await ctx.pairing.verifyMarkets(Number(pfId), cond);
        printVerify(r);
        if (!args.flags["no-save"]) ctx.pairing.save(r);
      } else if (sub === "list") {
        for (const p of ctx.pairing.list()) console.log(`${p.id}\t${p.status}\t${p.def ? `${p.def.labels.A} vs ${p.def.labels.B}\t开赛 ${bjTime(p.def.startTime)}` : "-"}\t${p.approvedBy ?? ""}\t${p.statusReason ?? ""}`);
      } else if (sub === "show") {
        const p = ctx.pairing.get(rest[0] ?? "");
        if (!p) throw new Error("配对不存在");
        console.log(JSON.stringify({ ...p, verification: { ...p.verification, clauses: p.verification?.clauses } }, null, 2));
      } else if (sub === "approve") {
        const id = rest[0];
        const note = String(args.flags.note ?? "");
        if (!id || !note) throw new Error('用法：pairs approve <pairId> --note "批准理由"');
        const cur = ctx.pairing.get(id);
        if (cur && cur.status !== "PENDING_REVIEW") throw new Error(`只能批准“待审核”的配对，当前状态为 ${cur.status}`);
        const p = ctx.pairing.approve(id, note);
        ctx.repo.insertAudit({ ts: Date.now(), actor: process.env.USER ?? "cli", source: "cli", ip: null, action: "pair.approve", target: id, params: { note }, ok: true, result: { status: p.status } });
        console.log(`已批准 ${p.id}（规则版本 ${p.approvedRulesHash?.slice(0, 12)}）；规则变化后需重新批准`);
      } else throw new Error(HELP);
      ctx.db.close();
      process.exit(0);
      return;
    }
    case "scan": {
      console.log("正在遍历 Predict 电竞整场胜负盘、核对并拉取两边订单簿……");
      const r = await scanCandidates(ctx, { skipConfigured: false });
      if (args.flags.json) console.log(JSON.stringify(r, null, 2));
      else printScan(r.rows, !!args.flags.all, r.rejected, r.errors);
      ctx.db.close();
      process.exit(0);
      return;
    }
    case "books": {
      const [pfId, cond] = [sub, rest[0]];
      if (!pfId || !cond) throw new Error("用法：books <predictMarketId> <polymarketConditionId>");
      const yes = await ctx.pfPublic.orderbook(Number(pfId));
      console.log(`Predict #${pfId}（Yes/indexSet=1）`);
      console.log(`  买：${yes.bids.slice(0, 8).map((l) => `${toStr(l.price, 3)}×${toStr(l.size, 1)}`).join("  ")}`);
      console.log(`  卖：${yes.asks.slice(0, 8).map((l) => `${toStr(l.price, 3)}×${toStr(l.size, 1)}`).join("  ")}`);
      const [pm] = await ctx.pmPublic.marketsByConditionIds([cond]);
      for (const [i, t] of (pm?.assetIds ?? []).entries()) {
        const b = await ctx.pmPublic.book(t);
        console.log(`Polymarket ${pm?.outcomes[i] ?? i}`);
        console.log(`  买：${b.bids.slice(0, 8).map((l) => `${toStr(l.price, 3)}×${toStr(l.size, 1)}`).join("  ")}`);
        console.log(`  卖：${b.asks.slice(0, 8).map((l) => `${toStr(l.price, 3)}×${toStr(l.size, 1)}`).join("  ")}`);
      }
      process.exit(0);
      return;
    }
    case "resume": {
      const prev = ctx.risk.halted;
      ctx.risk.resume();
      ctx.repo.insertAudit({ ts: Date.now(), actor: process.env.USER ?? "cli", source: "cli", ip: null, action: "global.resume", target: null, params: {}, ok: true, result: { previous: prev } });
      console.log("已解除全局停止新挂单（只修改了数据库；运行中的机器人请在网页控制台点“解除停止”，否则要重启后才生效）");
      process.exit(0);
      return;
    }
    case "accept-positions": {
      const id = sub;
      if (!id) throw new Error("用法：accept-positions <pairId>");
      for (const v of VENUES) await ctx.venues[v].start();
      await loadPairs(ctx);
      await refreshBalances(ctx);
      const e = ctx.engines.get(id);
      if (!e) throw new Error("配对未加载");
      const out = await acceptPositionsAsBaseline(e, { repo: ctx.repo, clock: ctx.clock, venues: ctx.venues, queue: ctx.queue, alerts: ctx.alerts, log });
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
      return;
    }
    default:
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`错误：${errMsg(e)}`);
  process.exit(1);
});

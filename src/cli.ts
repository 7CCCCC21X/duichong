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
import { startStatusServer } from "./monitor/status.js";
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
  pairs approve <pairId> --note "原因"  人工批准“待审核”配对（规则版本变化后需重新批准）
  status [--url http://127.0.0.1:8787]  查看运行中机器人的状态
  books <predictMarketId> <polymarketConditionId>
                                        打印两边当前订单簿（REST）
  resume                                解除全局“停止新挂单”
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

  const ctx = createContext(cfg, log);

  switch (cmd) {
    case "run": {
      if (isLive(cfg)) log.warn("⚠ 实盘模式：将使用真实资金下单");
      const stop = await runBot(ctx);
      const server = startStatusServer(ctx);
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
        const books = await ctx.pmPublic.book("28083174732948602623573656431589352828090389364103778176510099725313482624335").catch(() => null);
        console.log(`Polymarket 公共接口：${books ? "可访问" : "不可访问"}`);
      } catch (e) {
        console.log(`Polymarket 公共接口：失败 ${errMsg(e)}`);
      }
      try {
        await ctx.pfPublic.categories(["ESPORTS_CS2"], 1);
        console.log("Predict 公共接口：可访问");
      } catch (e) {
        console.log(`Predict 公共接口：失败 ${errMsg(e)}`);
      }
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
        const p = ctx.pairing.approve(id, note);
        console.log(`已批准 ${p.id}（规则版本 ${p.approvedRulesHash?.slice(0, 12)}）；规则变化后需重新批准`);
      } else throw new Error(HELP);
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
      ctx.risk.resume();
      console.log("已解除全局停止新挂单（运行中的机器人需重启或等待其读取状态）");
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

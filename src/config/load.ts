import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { registerSecret } from "../core/logger.js";
import { AppConfigSchema, PairsFileSchema, type AppConfig, type PairConfig, type Secrets } from "./schema.js";

export interface LoadedConfig {
  app: AppConfig;
  pairs: PairConfig[];
  secrets: Secrets;
  configPath: string | null;
  pairsPath: string | null;
}

function readYaml(path: string): unknown {
  return parseYaml(readFileSync(path, "utf8")) ?? {};
}

function env(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : null;
}

/** 读取 .env（若存在）、config.yaml、pairs.yaml，并校验。 */
export function loadConfig(opts: { configPath?: string; pairsPath?: string; envPath?: string } = {}): LoadedConfig {
  const envPath = resolve(opts.envPath ?? ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const configPath = resolve(opts.configPath ?? process.env.BOT_CONFIG ?? "config/config.yaml");
  const pairsPath = resolve(opts.pairsPath ?? process.env.BOT_PAIRS ?? "config/pairs.yaml");
  const appRaw = existsSync(configPath) ? readYaml(configPath) : {};
  const app = AppConfigSchema.parse(appRaw);
  const pairsRaw = existsSync(pairsPath) ? readYaml(pairsPath) : { pairs: [] };
  const pairs = PairsFileSchema.parse(pairsRaw).pairs;

  const ids = new Set<string>();
  for (const p of pairs) {
    if (ids.has(p.id)) throw new Error(`配对 ID 重复: ${p.id}`);
    ids.add(p.id);
    if (!p.maker.outcome && !p.maker.team) throw new Error(`配对 ${p.id} 的 maker 需要 outcome(A/B) 或 team`);
  }

  const secrets = loadSecrets();
  return { app, pairs, secrets, configPath: existsSync(configPath) ? configPath : null, pairsPath: existsSync(pairsPath) ? pairsPath : null };
}

export function loadSecrets(): Secrets {
  const s: Secrets = {
    liveTrading: (env("LIVE_TRADING") ?? "").toLowerCase() === "true",
    predictApiKey: env("PREDICT_API_KEY"),
    predictSignerPrivateKey: env("PREDICT_SIGNER_PRIVATE_KEY"),
    predictAccountAddress: env("PREDICT_ACCOUNT_ADDRESS"),
    polymarketPrivateKey: env("POLYMARKET_PRIVATE_KEY"),
    polymarketWalletAddress: env("POLYMARKET_WALLET_ADDRESS"),
    polymarketApiKey: env("POLYMARKET_API_KEY"),
    polymarketApiSecret: env("POLYMARKET_API_SECRET"),
    polymarketApiPassphrase: env("POLYMARKET_API_PASSPHRASE"),
    polymarketRelayerApiKey: env("POLYMARKET_RELAYER_API_KEY"),
    polymarketRelayerApiKeyAddress: env("POLYMARKET_RELAYER_API_KEY_ADDRESS"),
    alertWebhookUrl: env("ALERT_WEBHOOK_URL"),
    statusToken: env("STATUS_TOKEN"),
    consoleToken: env("CONSOLE_TOKEN"),
  };
  for (const v of [
    s.predictApiKey,
    s.predictSignerPrivateKey,
    s.polymarketPrivateKey,
    s.polymarketApiKey,
    s.polymarketApiSecret,
    s.polymarketApiPassphrase,
    s.polymarketRelayerApiKey,
    s.alertWebhookUrl,
    s.statusToken,
    s.consoleToken,
  ]) {
    registerSecret(v);
  }
  return s;
}

/** 实盘必须同时满足：配置 mode=live 且环境变量 LIVE_TRADING=true。 */
export function isLive(cfg: LoadedConfig): boolean {
  return cfg.app.mode === "live" && cfg.secrets.liveTrading;
}

export function predictUrls(app: AppConfig): { rest: string; ws: string | null } {
  const rest = app.predict.restUrl ?? (app.predict.network === "mainnet" ? "https://api.predict.fun" : "https://api-testnet.predict.fun");
  const ws = app.predict.wsUrl ?? (app.predict.network === "mainnet" ? "wss://ws.predict.fun/ws" : null);
  return { rest, ws };
}

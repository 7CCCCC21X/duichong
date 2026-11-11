import pino, { type Logger } from "pino";
import { bjIso } from "./time.js";

/**
 * 日志：JSON 行格式，时间为北京时间 ISO（+08:00）。
 * 所有密钥在两层被脱敏：
 * 1) 按字段名脱敏（pino redact）；
 * 2) 按已注册的密钥值脱敏（防止密钥出现在错误消息、URL 中）。
 */
const secretValues = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const v = value.trim();
  if (v.length >= 6) secretValues.add(v);
  if (v.startsWith("0x") && v.length > 8) secretValues.add(v.slice(2));
}

export function redactString(s: string): string {
  let out = s;
  for (const v of secretValues) {
    if (out.includes(v)) out = out.split(v).join("[REDACTED]");
  }
  // 兜底：JWT、64 位十六进制私钥
  out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]");
  out = out.replace(/\b(0x)?[0-9a-fA-F]{64}\b/g, (m) => (secretValues.size > 0 && looksLikeKey(m) ? "[REDACTED_HEX]" : m));
  return out;
}

function looksLikeKey(m: string): boolean {
  const v = m.startsWith("0x") ? m.slice(2) : m;
  return secretValues.has(v) || secretValues.has(`0x${v}`);
}

export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

const SECRET_KEY_RE = /(private.?key|secret|passphrase|api.?key|apikey|jwt|token|authorization|signature|password)/i;

const REDACT_PATHS = [
  "*.privateKey",
  "*.secret",
  "*.passphrase",
  "*.apiKey",
  "*.jwt",
  "*.token",
  "*.authorization",
  "*.Authorization",
  "*.headers",
  "headers",
  "*.signature",
  "*.credentials",
];

let root: Logger | null = null;

export function createLogger(opts: { level?: string; file?: string } = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? "info";
  const destination = opts.file ? pino.destination({ dest: opts.file, mkdir: true, sync: false }) : pino.destination(1);
  root = pino(
    {
      level,
      base: undefined,
      timestamp: () => `,"time":"${bjIso()}"`,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => redactDeep(obj) as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const mapped = args.map((a) => (typeof a === "string" ? redactString(a) : a)) as Parameters<typeof method>;
          method.apply(this, mapped);
        },
      },
    },
    destination,
  );
  return root;
}

export function getLogger(): Logger {
  if (!root) {
    const level = process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info");
    root = createLogger({ level });
  }
  return root;
}

export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}

export type { Logger };

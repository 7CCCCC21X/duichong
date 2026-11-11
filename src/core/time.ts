/** 时间工具：所有展示时间统一使用北京时间（UTC+8，无夏令时）。 */
const BJ_OFFSET_MS = 8 * 3600 * 1000;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** 例：2026-11-12 02:00:00.123 (北京时间) */
export function bjTime(ts: number | Date | string | null | undefined, withMs = false): string {
  if (ts === null || ts === undefined || ts === "") return "-";
  const ms = typeof ts === "number" ? ts : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return "-";
  const d = new Date(ms + BJ_OFFSET_MS);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}`;
  return withMs ? `${base}.${pad(d.getUTCMilliseconds(), 3)}` : base;
}

/** ISO 格式带 +08:00 偏移，用于日志。 */
export function bjIso(ts: number = Date.now()): string {
  const d = new Date(ts + BJ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+08:00`;
}

export function parseTime(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  // Polymarket 有 "2026-11-11 18:00:00+00" 这种格式
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}$/.test(v) ? `${v.replace(" ", "T")}:00` : v;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h${Math.round((ms % 3_600_000) / 60_000)}m`;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** 测试用可控时钟。 */
export class ManualClock implements Clock {
  constructor(private t: number = Date.UTC(2026, 10, 11, 10, 0, 0)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

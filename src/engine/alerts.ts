import type { Logger } from "pino";
import type { Clock } from "../core/time.js";
import { bjTime } from "../core/time.js";
import { redactString } from "../core/logger.js";
import type { Repo } from "../db/repo.js";

export type AlertLevel = "info" | "warn" | "critical";

/** 告警：写日志、落库，可选推送到 webhook；同一配对同一代码在冷却期内只发一次。 */
export class AlertSink {
  private last = new Map<string, number>();
  readonly recent: { ts: number; level: AlertLevel; code: string; message: string; pairId: string | null }[] = [];

  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly webhookUrl: string | null = null,
  ) {}

  raise(level: AlertLevel, code: string, message: string, opts: { pairId?: string | null; data?: unknown; dedupeMs?: number } = {}): void {
    const now = this.clock.now();
    const key = `${opts.pairId ?? "-"}:${code}`;
    const dedupe = opts.dedupeMs ?? 60_000;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < dedupe) return;
    this.last.set(key, now);
    const msg = redactString(message);
    this.repo.insertAlert({ ts: now, level, pairId: opts.pairId ?? null, code, message: msg, data: opts.data });
    this.recent.unshift({ ts: now, level, code, message: msg, pairId: opts.pairId ?? null });
    if (this.recent.length > 200) this.recent.pop();
    const fields = { alert: code, pairId: opts.pairId ?? undefined, data: opts.data };
    if (level === "critical") this.log.error(fields, `【告警】${msg}`);
    else if (level === "warn") this.log.warn(fields, `【告警】${msg}`);
    else this.log.info(fields, `【提示】${msg}`);
    if (this.webhookUrl && level !== "info") void this.push(level, code, msg, opts.pairId ?? null, now);
  }

  private async push(level: AlertLevel, code: string, message: string, pairId: string | null, ts: number): Promise<void> {
    try {
      await fetch(this.webhookUrl!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level, code, pairId, message, time: bjTime(ts), text: `[${level}] ${bjTime(ts)} ${pairId ?? ""} ${message}` }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      this.log.warn({ err: e }, "告警推送失败");
    }
  }
}

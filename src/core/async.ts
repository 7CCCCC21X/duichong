/** 异步工具：按键串行队列、超时、退避重试。 */

/**
 * 按键串行执行：同一个 key（例如同一配对）上的任务严格按提交顺序逐个执行，
 * 前一个任务抛错不会阻塞后续任务。
 */
export class KeyedSerialQueue {
  private tails = new Map<string, Promise<unknown>>();
  private depth = new Map<string, number>();

  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    this.depth.set(key, (this.depth.get(key) ?? 0) + 1);
    const next = prev.then(
      () => task(),
      () => task(),
    );
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      const d = (this.depth.get(key) ?? 1) - 1;
      if (d <= 0) {
        this.depth.delete(key);
        if (this.tails.get(key) === tail) this.tails.delete(key);
      } else {
        this.depth.set(key, d);
      }
    });
    return next;
  }

  pending(key: string): number {
    return this.depth.get(key) ?? 0;
  }

  /** 等待某个 key 上所有已提交的任务结束。 */
  async drain(key?: string): Promise<void> {
    if (key) {
      await this.tails.get(key);
      return;
    }
    await Promise.all([...this.tails.values()]);
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} 超时 (${ms}ms)`)), ms);
  });
  return Promise.race([p, t]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor?: number;
  jitter?: number;
}

export class Backoff {
  private attempt = 0;
  constructor(private readonly opts: BackoffOptions) {}
  next(): number {
    const f = this.opts.factor ?? 2;
    const base = Math.min(this.opts.maxMs, this.opts.initialMs * f ** this.attempt);
    this.attempt++;
    const j = this.opts.jitter ?? 0.2;
    return Math.round(base * (1 - j + Math.random() * 2 * j));
  }
  reset(): void {
    this.attempt = 0;
  }
  get attempts(): number {
    return this.attempt;
  }
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; backoff: BackoffOptions; shouldRetry?: (e: unknown) => boolean; delayFor?: (e: unknown) => number | undefined },
): Promise<T> {
  const b = new Backoff(opts.backoff);
  let lastErr: unknown;
  for (let i = 0; i <= opts.retries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i === opts.retries || (opts.shouldRetry && !opts.shouldRetry(e))) break;
      await sleep(opts.delayFor?.(e) ?? b.next());
    }
  }
  throw lastErr;
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

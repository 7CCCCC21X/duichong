import { redactString } from "../core/logger.js";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpOptions {
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** 对 GET 的网络错误/5xx/429 自动重试次数 */
  retries?: number;
}

/**
 * fetch 封装：超时、JSON、限流头（Predict 的 RateLimit-Reset、标准 Retry-After）。
 * 代理：Node 24 的 fetch 需要启动时设置 NODE_USE_ENV_PROXY=1 才会使用 HTTPS_PROXY。
 */
export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<{ data: T; headers: Headers; status: number }> {
  const method = opts.method ?? "GET";
  const retries = opts.retries ?? (method === "GET" ? 2 : 0);
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, {
        method,
        headers: { accept: "application/json", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        const retryAfterMs = parseRetryAfter(res.headers);
        const msg = typeof data === "object" && data && "message" in data ? String((data as { message: unknown }).message) : text.slice(0, 200);
        const err = new HttpError(`HTTP ${res.status} ${method} ${redactString(stripQuery(url))}: ${redactString(msg)}`, res.status, data, retryAfterMs);
        if (attempt < retries && (res.status === 429 || res.status >= 500)) {
          attempt++;
          await new Promise((r) => setTimeout(r, retryAfterMs ?? 300 * 2 ** attempt));
          continue;
        }
        throw err;
      }
      return { data: data as T, headers: res.headers, status: res.status };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      const err = e as Error;
      throw new HttpError(`网络错误 ${method} ${redactString(stripQuery(url))}: ${redactString(err.message)}${err.cause ? ` (${String((err.cause as { code?: string }).code ?? err.cause)})` : ""}`, 0, null, null);
    }
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i >= 0 ? url.slice(0, i) : url;
}

export function parseRetryAfter(h: Headers): number | null {
  const ra = h.get("retry-after");
  if (ra && /^\d+$/.test(ra)) return Number(ra) * 1000;
  const reset = h.get("ratelimit-reset");
  if (reset && /^\d+(\.\d+)?$/.test(reset)) return Math.ceil(Number(reset) * 1000) + Math.floor(Math.random() * 300);
  return null;
}

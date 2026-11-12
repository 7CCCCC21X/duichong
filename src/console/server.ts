import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { AppContext } from "../app.js";
import { errMsg } from "../core/async.js";
import { statusJson } from "../monitor/status.js";
import { ConsoleError, ConsoleService, type Actor } from "./service.js";

/**
 * 网页控制台的 HTTP 服务。
 *
 * 鉴权：
 * - 控制操作（POST）必须在请求头 x-console-token（或 Authorization: Bearer）里带 CONSOLE_TOKEN；
 *   没有设置 CONSOLE_TOKEN 时控制台只读；实盘模式下口令短于 16 个字符也视为未设置。
 * - 查看状态：设置了 STATUS_TOKEN 时需要它或 CONSOLE_TOKEN；没设置时不需要口令。
 * - 口令用常量时间比较；同一来源连续输错 20 次后锁定 10 分钟。
 * 防护：只认 localhost / IP / allowedHosts 中的 Host 头（防 DNS 重绑定）；POST 要求 JSON 且同源；
 * 页面禁止被嵌入（防点击劫持），脚本只允许同源文件（CSP）。默认只监听 127.0.0.1，远程请用 SSH 隧道。
 */

const MIN_LIVE_TOKEN_LEN = 16;
const BODY_LIMIT = 64 * 1024;
const FAIL_LIMIT = 20;
const FAIL_WINDOW_MS = 10 * 60_000;
const LOCK_MS = 10 * 60_000;

const BASE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface ConsoleAuthConfig {
  statusToken: string | null;
  consoleToken: string | null;
  allowedHosts: string[];
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

function tokenEq(given: string | null | undefined, expected: string | null): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Host 头校验：localhost、IP 直连、以及配置里列出的域名。其他域名可能是 DNS 重绑定攻击。 */
export function hostAllowed(hostHeader: string | undefined, allowed: string[]): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  hostname = hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (isIP(hostname)) return true;
  return allowed.some((h) => h.toLowerCase() === hostname);
}

function readStatic(name: string): string {
  return readFileSync(new URL(`./static/${name}`, import.meta.url), "utf8");
}

let staticCache: { html: string; css: string; js: string } | null = null;
function staticFiles(): { html: string; css: string; js: string } {
  if (!staticCache) staticCache = { html: readStatic("index.html"), css: readStatic("console.css"), js: readStatic("console.js") };
  return staticCache;
}

const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function actorName(req: IncomingMessage): string {
  const raw = header(req, "x-console-actor");
  if (!raw) return "console";
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    /* 保留原样 */
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
  return name || "console";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > BODY_LIMIT) throw new ConsoleError("请求体过大", 413);
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ConsoleError("请求体不是合法 JSON");
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 控制口令是否可用（实盘要求足够长）；返回不可用的原因。 */
export function controlTokenProblem(live: boolean, token: string | null): string | null {
  if (!token) return "未设置环境变量 CONSOLE_TOKEN，控制台只读";
  if (live && token.length < MIN_LIVE_TOKEN_LEN) return `实盘模式下 CONSOLE_TOKEN 至少 ${MIN_LIVE_TOKEN_LEN} 个字符，当前口令过短，控制台只读`;
  return null;
}

/** 构造请求处理函数（测试可直接挂到任意端口）。 */
export function createConsoleHandler(ctx: AppContext, svc: ConsoleService, auth: ConsoleAuthConfig): (req: IncomingMessage, res: ServerResponse) => void {
  const controlProblem = controlTokenProblem(ctx.live, auth.consoleToken);
  const consoleToken = controlProblem ? null : auth.consoleToken;
  const failures = new Map<string, { count: number; since: number; lockedUntil: number }>();

  const send = (res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...BASE_HEADERS, "content-type": type, ...extra });
    res.end(body);
  };
  const sendJson = (res: ServerResponse, status: number, v: unknown) => send(res, status, json(v), "application/json; charset=utf-8");

  const ipOf = (req: IncomingMessage) => req.socket.remoteAddress ?? "unknown";

  const locked = (ip: string): boolean => {
    const f = failures.get(ip);
    return !!f && f.lockedUntil > Date.now();
  };
  const fail = (ip: string): void => {
    const now = Date.now();
    const f = failures.get(ip);
    if (!f || now - f.since > FAIL_WINDOW_MS) {
      failures.set(ip, { count: 1, since: now, lockedUntil: 0 });
      return;
    }
    f.count++;
    if (f.count >= FAIL_LIMIT) {
      f.lockedUntil = now + LOCK_MS;
      ctx.alerts.raise("warn", "CONSOLE_AUTH_LOCKED", `控制台：来源 ${ip} 连续输错口令 ${f.count} 次，锁定 10 分钟`, { dedupeMs: 60_000 });
    }
  };

  /** 解析请求带的口令：control（控制口令）/ read（只读口令，或未设置只读口令）/ null（无权限）。 */
  const roleOf = (req: IncomingMessage, url: URL): { role: "control" | "read" | null; badToken: boolean } => {
    const bearer = header(req, "authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    const headerToken = header(req, "x-console-token") ?? bearer;
    if (tokenEq(headerToken, consoleToken)) return { role: "control", badToken: false };
    const readToken = headerToken ?? header(req, "x-status-token") ?? url.searchParams.get("token");
    if (tokenEq(readToken, auth.statusToken)) return { role: "read", badToken: false };
    // 控制口令只接受请求头（不放在 URL 里，避免进入浏览器历史与代理日志）
    if (tokenEq(url.searchParams.get("token"), consoleToken)) return { role: "read", badToken: false };
    const presented = !!(readToken && readToken.length > 0);
    if (!auth.statusToken) return { role: "read", badToken: presented };
    return { role: null, badToken: presented };
  };

  type Handler = (req: IncomingMessage, actor: Actor, body: Record<string, unknown>, id: string | null, url: URL) => Promise<unknown> | unknown;
  const reads: [RegExp, Handler][] = [
    [/^\/api\/status$/, () => statusJson(ctx)],
    [/^\/api\/console\/state$/, () => ({ status: statusJson(ctx), control: svc.state() })],
    [/^\/api\/console\/meta$/, () => svc.meta()],
    [/^\/api\/console\/global$/, () => svc.globalConfig()],
    [/^\/api\/console\/audit$/, (_r, _a, _b, _id, url) => svc.audit(Number(url.searchParams.get("limit") ?? 200) || 200)],
    [/^\/api\/console\/stats$/, (_r, _a, _b, _id, url) => svc.stats(url.searchParams.get("hours") ? Number(url.searchParams.get("hours")) || null : null)],
    [/^\/api\/console\/capital$/, () => svc.capital()],
    [/^\/api\/console\/opportunities$/, () => svc.opportunities()],
    [/^\/api\/console\/pairs\/([^/]+)\/config$/, (_r, _a, _b, id) => svc.pairConfig(id!)],
    [/^\/api\/console\/pairs\/([^/]+)\/review$/, (_r, _a, _b, id) => svc.review(id!)],
  ];
  const writes: [RegExp, Handler][] = [
    [/^\/api\/console\/halt$/, (_r, a, b) => svc.halt(a, str(b.reason))],
    [/^\/api\/console\/resume$/, (_r, a) => svc.resume(a)],
    [/^\/api\/console\/global$/, (_r, a, b) => svc.updateGlobal(a, b)],
    [/^\/api\/console\/reconcile$/, (_r, a, b) => svc.reconcile(a, b.pairId ? str(b.pairId) : null)],
    [/^\/api\/console\/discover$/, () => svc.discover()],
    [/^\/api\/console\/opportunities\/scan$/, () => svc.scan()],
    [/^\/api\/console\/preview$/, (_r, _a, b) => svc.preview(b)],
    [/^\/api\/console\/pairs$/, (_r, a, b) => svc.addPair(a, b)],
    [/^\/api\/console\/pairs\/([^/]+)\/pause$/, (_r, a, b, id) => svc.pausePair(a, id!, str(b.reason))],
    [/^\/api\/console\/pairs\/([^/]+)\/resume$/, (_r, a, _b, id) => svc.resumePair(a, id!)],
    [/^\/api\/console\/pairs\/([^/]+)\/params$/, (_r, a, b, id) => svc.updatePairParams(a, id!, b)],
    [/^\/api\/console\/pairs\/([^/]+)\/reset$/, (_r, a, _b, id) => svc.resetPair(a, id!)],
    [/^\/api\/console\/pairs\/([^/]+)\/recheck$/, (_r, a, _b, id) => svc.recheck(a, id!)],
    [/^\/api\/console\/pairs\/([^/]+)\/approve$/, (_r, a, b, id) => svc.approve(a, id!, str(b.note), str(b.rulesHash))],
    [/^\/api\/console\/pairs\/([^/]+)\/reconcile$/, (_r, a, _b, id) => svc.reconcile(a, id!)],
    [/^\/api\/console\/pairs\/([^/]+)\/accept-positions$/, (_r, a, b, id) => svc.acceptPositions(a, id!, str(b.confirm))],
    [/^\/api\/console\/pairs\/([^/]+)\/delete$/, (_r, a, b, id) => svc.deletePair(a, id!, str(b.confirm))],
    [/^\/api\/console\/pairs\/([^/]+)\/restore$/, (_r, a, _b, id) => svc.restorePair(a, id!)],
  ];

  const match = (routes: [RegExp, Handler][], path: string): { h: Handler; id: string | null } | null => {
    for (const [re, h] of routes) {
      const m = re.exec(path);
      if (!m) continue;
      let id: string | null = null;
      if (m[1] !== undefined) {
        try {
          id = decodeURIComponent(m[1]);
        } catch {
          return null;
        }
        if (!id || id.length > 128) return null;
      }
      return { h, id };
    }
    return null;
  };

  return (req, res) => {
    void (async () => {
      const ip = ipOf(req);
      try {
        if (!hostAllowed(req.headers.host, auth.allowedHosts)) {
          send(res, 403, "Host 不在允许列表（用域名访问时请把域名加到 statusServer.allowedHosts）", "text/plain; charset=utf-8");
          return;
        }
        const url = new URL(req.url ?? "/", "http://console.local");
        const path = url.pathname;
        const method = req.method ?? "GET";

        if (method === "GET" && (path === "/" || path === "/index.html")) {
          send(res, 200, staticFiles().html, "text/html; charset=utf-8", { "content-security-policy": PAGE_CSP });
          return;
        }
        if (method === "GET" && path === "/console.js") {
          send(res, 200, staticFiles().js, "text/javascript; charset=utf-8");
          return;
        }
        if (method === "GET" && path === "/console.css") {
          send(res, 200, staticFiles().css, "text/css; charset=utf-8");
          return;
        }
        if (!path.startsWith("/api/")) {
          send(res, 404, "not found", "text/plain; charset=utf-8");
          return;
        }

        if (locked(ip)) {
          sendJson(res, 429, { error: "口令错误次数过多，已锁定 10 分钟" });
          return;
        }
        const { role, badToken } = roleOf(req, url);
        if (badToken) fail(ip);
        // 告诉页面口令是否被拒，页面据此清除旧口令（避免反复用错误口令请求而被锁定）
        res.setHeader("x-console-role", role ?? "none");
        res.setHeader("x-console-token-rejected", badToken ? "1" : "0");

        if (method === "GET" && path === "/api/session") {
          sendJson(res, 200, {
            role,
            tokenRejected: badToken,
            controlEnabled: consoleToken !== null,
            controlProblem,
            readNeedsToken: auth.statusToken !== null,
            live: ctx.live,
            mode: ctx.live ? "实盘" : "模拟",
          });
          return;
        }

        if (method === "GET") {
          const m = match(reads, path);
          if (!m) {
            sendJson(res, 404, { error: "接口不存在" });
            return;
          }
          if (!role) {
            sendJson(res, 401, { error: "需要口令" });
            return;
          }
          const actor: Actor = { name: actorName(req), ip, source: "console" };
          sendJson(res, 200, await m.h(req, actor, {}, m.id, url));
          return;
        }

        if (method === "POST") {
          const m = match(writes, path);
          if (!m) {
            sendJson(res, 404, { error: "接口不存在" });
            return;
          }
          if (!consoleToken) {
            sendJson(res, 403, { error: controlProblem ?? "控制台只读" });
            return;
          }
          if (role !== "control") {
            sendJson(res, 401, { error: "控制操作需要控制口令（CONSOLE_TOKEN）" });
            return;
          }
          // 跨站请求防护：浏览器发起的 POST 必须同源；必须是 JSON（普通表单无法跨站提交 JSON）
          const origin = header(req, "origin");
          if (origin !== null) {
            let ok = false;
            try {
              ok = origin !== "null" && new URL(origin).host === req.headers.host;
            } catch {
              ok = false;
            }
            if (!ok) {
              sendJson(res, 403, { error: "拒绝跨站请求" });
              return;
            }
          }
          if (!(header(req, "content-type") ?? "").toLowerCase().startsWith("application/json")) {
            sendJson(res, 415, { error: "请求必须是 application/json" });
            return;
          }
          const raw = await readJson(req);
          const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
          const actor: Actor = { name: actorName(req), ip, source: "console" };
          sendJson(res, 200, (await m.h(req, actor, body, m.id, url)) ?? { ok: true });
          return;
        }
        sendJson(res, 405, { error: "不支持的请求方法" });
      } catch (e) {
        if (e instanceof ConsoleError) sendJson(res, e.status, { error: e.message });
        else {
          ctx.log.error({ err: errMsg(e) }, "控制台请求出错");
          sendJson(res, 500, { error: `内部错误：${errMsg(e)}` });
        }
      }
    })();
  };
}

/** 启动控制台。监听非本机地址时必须设置 STATUS_TOKEN，否则不启动。 */
export function startConsoleServer(ctx: AppContext, svc: ConsoleService = new ConsoleService(ctx)): Server | null {
  const cfg = ctx.cfg.app.statusServer;
  if (!cfg.enabled) return null;
  const secrets = ctx.cfg.secrets;
  if (!isLoopbackHost(cfg.host)) {
    if (!secrets.statusToken) {
      ctx.alerts.raise("critical", "CONSOLE_NOT_STARTED", `控制台未启动：监听非本机地址 ${cfg.host} 时必须设置 STATUS_TOKEN（建议只监听 127.0.0.1，通过 SSH 隧道访问）`);
      return null;
    }
    ctx.log.warn({ host: cfg.host }, "控制台监听非本机地址：HTTP 为明文传输，口令可能被截获。建议只监听 127.0.0.1 并通过 SSH 隧道访问，或放在 TLS 反向代理之后");
  }
  const problem = controlTokenProblem(ctx.live, secrets.consoleToken);
  if (problem) ctx.log.warn(problem);
  else if (secrets.consoleToken && secrets.consoleToken.length < MIN_LIVE_TOKEN_LEN) ctx.log.warn(`CONSOLE_TOKEN 少于 ${MIN_LIVE_TOKEN_LEN} 个字符，实盘前请换成更长的随机口令`);
  staticFiles();
  const server = createServer(createConsoleHandler(ctx, svc, { statusToken: secrets.statusToken, consoleToken: secrets.consoleToken, allowedHosts: cfg.allowedHosts }));
  server.on("error", (e) => ctx.alerts.raise("critical", "CONSOLE_LISTEN_FAILED", `控制台启动失败：${errMsg(e)}`));
  server.listen(cfg.port, cfg.host, () => ctx.log.info({ url: `http://${cfg.host}:${cfg.port}/`, control: problem ? "只读" : "可控制" }, "网页控制台已启动"));
  return server;
}

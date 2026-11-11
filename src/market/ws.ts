import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";
import WebSocket from "ws";
import { Backoff } from "../core/async.js";
import { redactString } from "../core/logger.js";

export interface ResilientWsOptions {
  name: string;
  url: () => string;
  headers?: () => Record<string, string>;
  log: Logger;
  /** 连接建立后调用（发送订阅帧） */
  onOpen: (ws: ResilientWs) => void;
  onMessage: (text: string, ws: ResilientWs) => void;
  onStateChange?: (up: boolean, reason: string) => void;
  /** 客户端主动心跳（Polymarket：每 10 秒发 PING） */
  pingIntervalMs?: number;
  pingPayload?: string;
  /** 超过该时长没有任何消息视为假死，主动重连 */
  idleTimeoutMs?: number;
}

/** 自动重连、心跳、假死检测的 WebSocket。设置了 HTTPS_PROXY 时通过代理连接。 */
export class ResilientWs {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = new Backoff({ initialMs: 500, maxMs: 30_000 });
  private pingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastMsgAt = 0;
  private upState = false;
  connectCount = 0;

  constructor(private readonly o: ResilientWsOptions) {}

  get up(): boolean {
    return this.upState;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.removeAllListeners();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setUp(false, "stopped");
  }

  send(data: string | object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
    return true;
  }

  /** 强制重连（例如收到服务端的重连通知） */
  reconnect(reason: string): void {
    this.o.log.info({ ws: this.o.name, reason }, "主动重连");
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    const url = this.o.url();
    const ws = new WebSocket(url, { agent, headers: this.o.headers?.(), handshakeTimeout: 15_000, perMessageDeflate: false });
    this.ws = ws;
    ws.on("open", () => {
      this.connectCount++;
      this.backoff.reset();
      this.lastMsgAt = Date.now();
      this.setUp(true, "open");
      this.startTimers();
      try {
        this.o.onOpen(this);
      } catch (e) {
        this.o.log.error({ ws: this.o.name, err: e }, "订阅失败");
      }
    });
    ws.on("message", (data) => {
      this.lastMsgAt = Date.now();
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
      try {
        this.o.onMessage(text, this);
      } catch (e) {
        this.o.log.warn({ ws: this.o.name, err: e }, "处理消息出错");
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      this.o.log.warn({ ws: this.o.name, status: res.statusCode }, "WebSocket 握手被拒");
    });
    ws.on("error", (e) => {
      this.o.log.warn({ ws: this.o.name, err: redactString(e.message) }, "WebSocket 错误");
    });
    ws.on("close", (code, reason) => {
      this.clearTimers();
      this.setUp(false, `close ${code} ${reason.toString()}`);
      if (this.stopped) return;
      const delay = this.backoff.next();
      this.o.log.warn({ ws: this.o.name, code, delayMs: delay }, "WebSocket 断开，稍后重连");
      setTimeout(() => this.connect(), delay).unref();
    });
  }

  private startTimers(): void {
    this.clearTimers();
    if (this.o.pingIntervalMs) {
      this.pingTimer = setInterval(() => this.send(this.o.pingPayload ?? "PING"), this.o.pingIntervalMs);
      this.pingTimer.unref();
    }
    if (this.o.idleTimeoutMs) {
      this.idleTimer = setInterval(() => {
        if (Date.now() - this.lastMsgAt > this.o.idleTimeoutMs!) this.reconnect(`超过 ${this.o.idleTimeoutMs}ms 无消息`);
      }, Math.min(5_000, this.o.idleTimeoutMs));
      this.idleTimer.unref();
    }
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.pingTimer = null;
    this.idleTimer = null;
  }

  private setUp(up: boolean, reason: string): void {
    if (this.upState === up) return;
    this.upState = up;
    this.o.onStateChange?.(up, reason);
  }
}

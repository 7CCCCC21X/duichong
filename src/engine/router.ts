import type { Logger } from "pino";
import type { KeyedSerialQueue } from "../core/async.js";
import type { Clock } from "../core/time.js";
import type { VenueEvent, VenueFill, VenueId } from "../core/types.js";
import type { Repo } from "../db/repo.js";
import type { PairEngine } from "./pairEngine.js";

/** 序列化/反序列化 VenueFill（bigint ↔ string），用于暂存找不到所属订单的成交。 */
export function serializeFill(f: VenueFill): unknown {
  return JSON.parse(JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v)));
}

export function reviveFill(raw: unknown): VenueFill {
  return JSON.parse(JSON.stringify(raw), (_k, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as VenueFill;
}

/**
 * 把交易所事件路由到对应配对的串行队列。
 * 成交可能先于下单回执到达（例如 post-only 挂单刚受理就被吃）：
 * 先按发送前保存的订单哈希匹配；仍找不到就暂存，等订单拿到交易所 ID 后重新匹配。
 */
export class EventRouter {
  private streamListeners: ((venue: VenueId, up: boolean, reason?: string) => void)[] = [];

  constructor(
    private readonly repo: Repo,
    private readonly queue: KeyedSerialQueue,
    private readonly engines: Map<string, PairEngine>,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  onStream(l: (venue: VenueId, up: boolean, reason?: string) => void): void {
    this.streamListeners.push(l);
  }

  handle(e: VenueEvent): void {
    switch (e.type) {
      case "fill":
        this.routeFill(e.fill);
        return;
      case "order": {
        const order = this.repo.findOrderByVenueRef(e.venue, e.state.venueOrderId, e.state.hash);
        if (!order) return;
        const engine = this.engines.get(order.pairId);
        if (!engine) return;
        void this.queue.run(order.pairId, () => {
          const cur = this.repo.getOrder(order.id);
          if (cur) engine.onOrderState(cur, e.state, e.reason);
        });
        // 订单拿到交易所 ID 后，尝试匹配暂存成交
        this.retryParked(e.venue);
        return;
      }
      case "plan": {
        const order = this.repo.findOrderByVenueRef(e.venue, e.venueOrderId, e.hash);
        if (!order) return;
        const engine = this.engines.get(order.pairId);
        if (!engine) return;
        void this.queue.run(order.pairId, () => {
          const cur = this.repo.getOrder(order.id);
          if (cur) engine.onPlannedFill(cur, e.plannedFill);
        });
        return;
      }
      case "stream":
        for (const l of this.streamListeners) l(e.venue, e.up, e.reason);
        return;
    }
  }

  private routeFill(f: VenueFill): boolean {
    const order = this.repo.findOrderByVenueRef(f.venue, f.venueOrderId, f.orderHash);
    if (!order) {
      this.repo.parkUnmatchedFill(f.key, f.venue, f.venueOrderId, f.orderHash, serializeFill(f), this.clock.now());
      this.log.warn({ fill: f.key, venueOrderId: f.venueOrderId }, "成交暂未匹配到本地订单，已暂存");
      return false;
    }
    const engine = this.engines.get(order.pairId);
    if (!engine) {
      this.repo.parkUnmatchedFill(f.key, f.venue, f.venueOrderId, f.orderHash, serializeFill(f), this.clock.now());
      return false;
    }
    void this.queue.run(order.pairId, () => {
      const cur = this.repo.getOrder(order.id);
      if (cur) engine.onFill(cur, f);
    });
    return true;
  }

  /** 重新匹配暂存的成交。 */
  retryParked(venue?: VenueId): number {
    let n = 0;
    for (const p of this.repo.listUnmatchedFills(venue)) {
      const order = this.repo.findOrderByVenueRef(p.venue, p.venueOrderId, p.orderHash);
      if (!order || !this.engines.get(order.pairId)) continue;
      this.repo.resolveUnmatchedFill(p.key);
      this.routeFill(reviveFill(p.raw));
      n++;
    }
    return n;
  }
}

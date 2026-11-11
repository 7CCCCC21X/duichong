import { ONE, roundToStep, type Fx } from "../core/fixed.js";
import type { Book, Level, VenueId, VenueMarketMeta } from "../core/types.js";

export interface BookSource {
  getBook(venue: VenueId, tokenId: string): Book | null;
  getMeta(venue: VenueId, marketKey: string): VenueMarketMeta | null;
  /** 请求尽快通过 REST 刷新（行情过期时调用），异步完成后会触发 onUpdate */
  requestRefresh(venue: VenueId, tokenId: string): void;
}

export type BookListener = (venue: VenueId, tokenId: string) => void;

export function sortBook(bids: Level[], asks: Level[]): { bids: Level[]; asks: Level[] } {
  const b = bids.filter((l) => l.size > 0n && l.price > 0n && l.price < ONE).sort((x, y) => (y.price > x.price ? 1 : y.price < x.price ? -1 : 0));
  const a = asks.filter((l) => l.size > 0n && l.price > 0n && l.price < ONE).sort((x, y) => (x.price > y.price ? 1 : x.price < y.price ? -1 : 0));
  return { bids: mergeLevels(b), asks: mergeLevels(a) };
}

function mergeLevels(ls: Level[]): Level[] {
  const out: Level[] = [];
  for (const l of ls) {
    const last = out[out.length - 1];
    if (last && last.price === l.price) last.size += l.size;
    else out.push({ price: l.price, size: l.size });
  }
  return out;
}

/**
 * Predict 订单簿只按 indexSet=1（Yes）报价。
 * indexSet=2 的簿：买价 = 1 − Yes 卖价，卖价 = 1 − Yes 买价，份额不变，按 decimalPrecision 取整。
 * 出处：https://dev.predict.fun/concepts/order-book.md
 */
export function complementBook(yes: Book, tick: Fx): Book {
  // 定点数下 1 − p 是精确的；若价格不在网格上（理论上不会），按对自己不利的方向取整：
  // 买价（来自 Yes 卖价）向下取整，卖价（来自 Yes 买价）向上取整。
  const bids = yes.asks.map((l) => ({ price: roundToStep(ONE - l.price, tick, "floor"), size: l.size }));
  const asks = yes.bids.map((l) => ({ price: roundToStep(ONE - l.price, tick, "ceil"), size: l.size }));
  const sorted = sortBook(bids, asks);
  return { ...yes, bids: sorted.bids, asks: sorted.asks };
}

/** 内存行情存储：两边的订单簿与市场约束。 */
export class BookStore implements BookSource {
  private books = new Map<string, Book>();
  private metas = new Map<string, VenueMarketMeta>();
  private listeners: BookListener[] = [];
  private refresher: ((venue: VenueId, tokenId: string) => void) | null = null;

  private key(venue: VenueId, id: string): string {
    return `${venue}:${id}`;
  }

  onUpdate(l: BookListener): void {
    this.listeners.push(l);
  }

  setRefresher(fn: (venue: VenueId, tokenId: string) => void): void {
    this.refresher = fn;
  }

  setBook(venue: VenueId, tokenId: string, book: Book): void {
    const sorted = sortBook(book.bids, book.asks);
    this.books.set(this.key(venue, tokenId), { ...book, bids: sorted.bids, asks: sorted.asks });
    for (const l of this.listeners) l(venue, tokenId);
  }

  getBook(venue: VenueId, tokenId: string): Book | null {
    return this.books.get(this.key(venue, tokenId)) ?? null;
  }

  setMeta(meta: VenueMarketMeta): void {
    this.metas.set(this.key(meta.venue, meta.marketKey), meta);
  }

  getMeta(venue: VenueId, marketKey: string): VenueMarketMeta | null {
    return this.metas.get(this.key(venue, marketKey)) ?? null;
  }

  requestRefresh(venue: VenueId, tokenId: string): void {
    this.refresher?.(venue, tokenId);
  }

  /** 吃单后在本地扣减被吃掉的流动性，直到下一次全量更新（模拟与测试使用）。 */
  consume(venue: VenueId, tokenId: string, side: "BUY" | "SELL", taken: Level[]): void {
    const b = this.getBook(venue, tokenId);
    if (!b) return;
    const levels = side === "BUY" ? b.asks.map((l) => ({ ...l })) : b.bids.map((l) => ({ ...l }));
    for (const t of taken) {
      const lvl = levels.find((l) => l.price === t.price);
      if (lvl) lvl.size = lvl.size - t.size > 0n ? lvl.size - t.size : 0n;
    }
    const next = side === "BUY" ? { ...b, asks: levels.filter((l) => l.size > 0n) } : { ...b, bids: levels.filter((l) => l.size > 0n) };
    this.books.set(this.key(venue, tokenId), next);
  }
}

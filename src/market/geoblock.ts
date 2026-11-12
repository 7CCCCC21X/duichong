import { httpJson } from "./http.js";

export type GeoblockResult = { ok: true; blocked: boolean; ip: string; country: string; region: string } | { ok: false; error: string };

/**
 * Polymarket 官方地理限制检查：GET https://polymarket.com/api/geoblock（检查发起请求的 IP）。
 * 出处：https://docs.polymarket.com/api-reference/geoblock
 * 注意该文档把爱尔兰、日本列为“网页只平仓、API 不受限”，而帮助中心另有说法，实盘前仍需向平台确认账户资格。
 */
export async function polymarketGeoblock(timeoutMs = 10_000): Promise<GeoblockResult> {
  try {
    const { data } = await httpJson<{ blocked?: boolean; ip?: string; country?: string; region?: string }>("https://polymarket.com/api/geoblock", { timeoutMs, retries: 1 });
    return { ok: true, blocked: data.blocked === true, ip: String(data.ip ?? ""), country: String(data.country ?? ""), region: String(data.region ?? "") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

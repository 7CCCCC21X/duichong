/**
 * 定点数工具：所有价格、份额、金额在内部都用 bigint 表示，精度 1e18。
 * 两边链上单位：Predict 为 1e18（wei），Polymarket 为 1e6，都能无损放进 1e18 精度。
 */
export type Fx = bigint;

export const SCALE = 18;
export const ONE: Fx = 10n ** 18n;
export const ZERO: Fx = 0n;

export type Rounding = "floor" | "ceil" | "trunc";

/** 把十进制字符串或数字精确解析为定点数。数字会先转成不带指数的字符串。 */
export function fx(v: string | number | bigint): Fx {
  if (typeof v === "bigint") return v * ONE;
  let s = typeof v === "number" ? numberToPlainString(v) : v.trim();
  if (s === "" || s === "-" || s === ".") throw new Error(`非法数字: "${String(v)}"`);
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (/e/i.test(s)) s = numberToPlainString(Number(s));
  if (!/^\d*(\.\d*)?$/.test(s)) throw new Error(`非法数字: "${String(v)}"`);
  const [intPart = "0", fracRaw = ""] = s.split(".");
  const frac = (fracRaw + "0".repeat(SCALE)).slice(0, SCALE);
  const extra = fracRaw.slice(SCALE);
  let out = BigInt(intPart || "0") * ONE + BigInt(frac || "0");
  // 超过 18 位的部分直接截断（量级 1e-18，可忽略）
  void extra;
  if (neg) out = -out;
  return out;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`非法数字: ${n}`);
  const s = n.toString();
  if (!/e/i.test(s)) return s;
  // 用 toFixed 展开指数形式，保留 18 位后去掉末尾 0
  const fixed = n.toFixed(SCALE);
  return fixed.replace(/\.?0+$/, "");
}

/** 由链上整数单位转换，例如 Polymarket 6 位小数金额。 */
export function fromUnits(raw: bigint | string | number, decimals: number): Fx {
  const b = typeof raw === "bigint" ? raw : BigInt(typeof raw === "number" ? Math.trunc(raw) : raw);
  if (decimals === SCALE) return b;
  if (decimals < SCALE) return b * 10n ** BigInt(SCALE - decimals);
  return divRound(b, 10n ** BigInt(decimals - SCALE), "trunc");
}

/** 转换为链上整数单位。 */
export function toUnits(a: Fx, decimals: number, rounding: Rounding = "floor"): bigint {
  if (decimals === SCALE) return a;
  if (decimals > SCALE) return a * 10n ** BigInt(decimals - SCALE);
  return divRound(a, 10n ** BigInt(SCALE - decimals), rounding);
}

/** 带取整方式的整数除法（正确处理负数）。 */
export function divRound(n: bigint, d: bigint, rounding: Rounding): bigint {
  if (d === 0n) throw new Error("除数为 0");
  const q = n / d;
  const r = n % d;
  if (r === 0n || rounding === "trunc") return q;
  const positive = n > 0n === d > 0n;
  if (rounding === "floor") return positive ? q : q - 1n;
  return positive ? q + 1n : q;
}

export function mul(a: Fx, b: Fx, rounding: Rounding = "floor"): Fx {
  return divRound(a * b, ONE, rounding);
}

export function div(a: Fx, b: Fx, rounding: Rounding = "floor"): Fx {
  return divRound(a * ONE, b, rounding);
}

export function min(...xs: Fx[]): Fx {
  if (xs.length === 0) throw new Error("min() 需要参数");
  return xs.reduce((m, x) => (x < m ? x : m));
}

export function max(...xs: Fx[]): Fx {
  if (xs.length === 0) throw new Error("max() 需要参数");
  return xs.reduce((m, x) => (x > m ? x : m));
}

export function abs(a: Fx): Fx {
  return a < 0n ? -a : a;
}

export function clamp(a: Fx, lo: Fx, hi: Fx): Fx {
  return a < lo ? lo : a > hi ? hi : a;
}

/** 按步长取整，例如价格按 tick、份额按精度。 */
export function roundToStep(a: Fx, step: Fx, rounding: Rounding = "floor"): Fx {
  if (step <= 0n) return a;
  return divRound(a, step, rounding) * step;
}

/** 把小数位数转为步长，例如 2 → 0.01。 */
export function stepFromDecimals(decimals: number): Fx {
  if (decimals < 0 || decimals > SCALE) throw new Error(`非法小数位: ${decimals}`);
  return 10n ** BigInt(SCALE - decimals);
}

export function toNum(a: Fx): number {
  // 先转字符串再转数字，避免大数精度问题
  return Number(toStr(a, SCALE));
}

/** 输出固定小数位字符串（向零截断），默认去掉末尾 0。 */
export function toStr(a: Fx, dp = 6, trimZeros = true): string {
  const neg = a < 0n;
  let v = neg ? -a : a;
  const dpClamped = Math.max(0, Math.min(SCALE, dp));
  v = v / 10n ** BigInt(SCALE - dpClamped);
  const s = v.toString().padStart(dpClamped + 1, "0");
  let intPart = s.slice(0, s.length - dpClamped);
  let frac = dpClamped > 0 ? s.slice(s.length - dpClamped) : "";
  if (trimZeros) frac = frac.replace(/0+$/, "");
  if (intPart === "") intPart = "0";
  const body = frac ? `${intPart}.${frac}` : intPart;
  return neg && body !== "0" ? `-${body}` : body;
}

export function isZero(a: Fx): boolean {
  return a === 0n;
}

export function sum(xs: Iterable<Fx>): Fx {
  let s = 0n;
  for (const x of xs) s += x;
  return s;
}

/** 补数：1 - p。 */
export function complement(p: Fx): Fx {
  return ONE - p;
}

/** JSON 序列化辅助：bigint 转字符串。 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

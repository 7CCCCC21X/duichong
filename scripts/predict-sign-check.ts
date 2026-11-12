// 离线检查：用随机钱包构建并签名 Predict 限价单与市价单，确认金额、截断与哈希（不发送任何下单请求）
import { createRequire } from "node:module";
import pino from "pino";
import { fx, toStr } from "../src/core/fixed.js";
import { PredictLiveVenue, retainSignificant } from "../src/venues/predict/live.js";
import { pfMeta } from "../test/harness.js";

const ethers = createRequire(import.meta.url)("ethers") as typeof import("ethers");
const w = ethers.Wallet.createRandom();
const v = new PredictLiveVenue({ restUrl: "https://api-testnet.predict.fun", wsUrl: null, apiKey: null, signerPrivateKey: w.privateKey, predictAccount: null, chain: "testnet", selfTradePrevention: "CANCEL_TAKER", jwtRefreshBeforeSec: 3600, timeoutMs: 10000, log: pino({ level: "warn" }) });
// 只初始化 OrderBuilder，不登录
const { OrderBuilder, ChainId } = await import("@predictdotfun/sdk");
(v as unknown as { builder: unknown }).builder = await OrderBuilder.make(ChainId.BnbTestnet, (v as unknown as { wallet: never }).wallet);
v.registerMarket("101", { isNegRisk: false, isYieldBearing: false, feeRateBps: 200, marketId: 101 });
const meta = pfMeta();
const lim = await v.prepareLimit({ clientOrderId: "c1", tokenId: "53995717619670307812402740768355781837360379869925772176380097987049988128021", side: "BUY", price: fx("0.46"), size: fx("50"), postOnly: true, expiresAt: Date.now() + 15 * 60_000, meta });
const p = lim.payload as { order: Record<string, unknown>; pricePerShare: string; strategy: string; isPostOnly: boolean };
console.log("LIMIT hash", lim.hash, "price", toStr(lim.price, 4), "size", toStr(lim.size, 4));
console.log("  makerAmount(USDT wei)", p.order.makerAmount, "takerAmount(shares wei)", p.order.takerAmount, "pricePerShare", p.pricePerShare, "postOnly", p.isPostOnly, "maker", p.order.maker === w.address);
// 校验哈希 = EIP-712 TypedDataEncoder.hash
const td = (await import("@predictdotfun/sdk")).EIP712_DOMAIN;
void td;
const mk = await v.prepareTaker({ clientOrderId: "c2", tokenId: "45059303355214266666609536313670329022653576939527554543702090330392185817553", side: "BUY", shares: fx("18"), limitPrice: fx("0.53"), amountUsd: null, meta, bookLevels: [{ price: fx("0.51"), size: fx("10") }, { price: fx("0.52"), size: fx("100") }] });
const mp = mk.payload as { order: Record<string, unknown>; pricePerShare: string; strategy: string; slippageBps: string };
console.log("MARKET hash", mk.hash, "strategy", mp.strategy, "slippageBps", mp.slippageBps);
console.log("  makerAmount", mp.order.makerAmount, "takerAmount", mp.order.takerAmount, "→ max avg price", Number(BigInt(String(mp.order.makerAmount)) * 10000n / BigInt(String(mp.order.takerAmount))) / 10000);
console.log("retainSignificant(18.3526 shares)", toStr(retainSignificant(fx("18.35267"), 5), 6));

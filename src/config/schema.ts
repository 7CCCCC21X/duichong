import { z } from "zod";

const num = z.coerce.number();
const nonneg = num.min(0);
const price01 = num.gt(0).lt(1);

export const StrategySchema = z.object({
  /** 补单触发标准：matched=已撮合即补；settled=结算成功后才补 */
  hedgeTrigger: z.enum(["matched", "settled"]).default("matched"),
  /** 挂单价格模式：fixed=固定价（无利润时撤单）；auto=买一加 improveTicks 但不超过盈利上限；max=盈利上限价 */
  priceMode: z.enum(["fixed", "auto", "max"]).default("auto"),
  price: price01.nullable().default(null),
  minMakerPrice: price01.nullable().default(0.02),
  maxMakerPrice: price01.nullable().default(0.98),
  improveTicks: z.coerce.number().int().min(0).default(1),
  /** 目标挂单份额 */
  sizeShares: num.positive().default(50),
  /** 每对（1 份挂单 + 1 份对冲）最低费后利润（美元） */
  minProfitPerShare: num.default(0.01),
  /** 对冲滑点缓冲（价格单位） */
  hedgeSlippage: nonneg.default(0.005),
  /** 风险缓冲（每份美元） */
  riskBufferPerShare: nonneg.default(0.002),
  /** 结算资产换算缓冲（基点，作用在两腿总成本上） */
  fxBufferBps: nonneg.default(20),
  /** 开赛前多少秒停止挂单（Polymarket 电竞开赛清簿） */
  stopQuotingBeforeStartSec: nonneg.default(600),
  /** 也可配置绝对停止时间（ISO），两者取较早者 */
  stopQuotingAt: z.string().nullable().default(null),
  requoteMinIntervalMs: nonneg.default(1500),
  requoteMinTicks: z.coerce.number().int().min(1).default(1),
  /** 订单簿超过该时长未更新视为过期 */
  maxBookAgeMs: nonneg.default(15000),
  /** 紧急处理结束后暂停该配对挂单的时长（秒） */
  emergencyCooldownSec: nonneg.default(300),
  hedge: z
    .object({
      /** 正常补单可接受的每份最低利润（可为负，表示允许小亏完成对冲） */
      minProfitPerShare: num.default(0),
      retryIntervalMs: nonneg.default(1500),
      maxNormalAttempts: z.coerce.number().int().min(1).default(5),
      /** 吃单回执后等待 WebSocket 成交推送的时间，超时用 REST 补拉 */
      fillGraceMs: nonneg.default(8000),
      /** 吃单请求超时 */
      requestTimeoutMs: nonneg.default(10000),
      /** 成交合并窗口（毫秒）：窗口内到达的成交先净额再补单，0 表示立即补单 */
      coalesceMs: nonneg.default(100),
    })
    .default({}),
  residual: z
    .object({
      /** 不处理的零头份额 */
      dustShares: nonneg.default(0.2),
      /** 残余低于最小单时等待更多成交的时间 */
      maxWaitSec: nonneg.default(30),
    })
    .default({}),
});

export type StrategyConfig = z.infer<typeof StrategySchema>;

export const RiskSchema = z.object({
  maxOrderShares: num.positive().default(500),
  maxOrderUsd: num.positive().default(300),
  /** 单场（单配对）资金上限：持仓成本 + 挂单占用 + 补单预留 */
  maxMatchUsd: num.positive().default(1000),
  /** 全局资金上限 */
  maxGlobalUsd: num.positive().default(5000),
  /** 单配对最大未对冲份额 */
  maxUnhedgedShares: num.positive().default(100),
  /** 全局最大未对冲份额 */
  maxUnhedgedSharesGlobal: num.positive().default(200),
  /** 最长裸仓时间（秒），超过进入紧急处理 */
  maxNakedSec: num.positive().default(20),
  /** 补单原始价格硬上限 */
  maxHedgePrice: price01.default(0.97),
  /** 紧急处理时每份最大允许亏损 */
  maxLossPerShare: nonneg.default(0.05),
  /** 单配对累计最大允许亏损（美元） */
  maxLossPerPairUsd: nonneg.default(20),
  /** 全局当日最大亏损（美元），超过则停止所有新挂单 */
  maxDailyLossUsd: nonneg.default(50),
  /** 是否为全部挂单可能成交预留补单资金 */
  reserveHedgeFunds: z.boolean().default(true),
  balanceRefreshSec: nonneg.default(30),
  /** 发现交易所上有不属于本系统记录的挂单时是否撤销（仅限配对涉及的代币） */
  cancelOrphanOrders: z.boolean().default(true),
  /** 对账时持仓允许误差（份） */
  positionTolerance: nonneg.default(0.05),
});

export type RiskConfig = z.infer<typeof RiskSchema>;

export const PairConfigSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  predict: z.object({ marketId: z.coerce.number().int().positive() }),
  polymarket: z.object({ conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
  /** 挂单平台与方向。outcome A = Predict indexSet 1 对应的队伍；也可用 team 写队名 */
  maker: z.object({
    venue: z.enum(["predict", "polymarket"]),
    outcome: z.enum(["A", "B"]).optional(),
    team: z.string().optional(),
  }),
  strategy: StrategySchema.partial().default({}),
  risk: RiskSchema.partial().default({}),
  note: z.string().optional(),
});

export type PairConfig = z.infer<typeof PairConfigSchema>;

export const AppConfigSchema = z.object({
  /** simulation：使用真实公开行情 + 模拟成交；live：真实下单（还需要环境变量 LIVE_TRADING=true） */
  mode: z.enum(["simulation", "live"]).default("simulation"),
  dataDir: z.string().default("./data"),
  logLevel: z.string().default("info"),
  logFile: z.string().nullable().default(null),
  statusServer: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().default("127.0.0.1"),
      port: z.coerce.number().int().default(8787),
    })
    .default({}),
  predict: z
    .object({
      network: z.enum(["mainnet", "testnet"]).default("mainnet"),
      restUrl: z.string().nullable().default(null),
      wsUrl: z.string().nullable().default(null),
      /** 无 WebSocket（测试网 / 无 API Key）时 REST 轮询订单簿的间隔 */
      pollIntervalMs: nonneg.default(2000),
      /** 挂单有效期（Predict 没有进程失联自动撤单，用短有效期兜底），0 表示不过期 */
      makerOrderTtlSec: nonneg.default(900),
      /** 到期前多少秒续挂 */
      makerRefreshBeforeSec: nonneg.default(180),
      selfTradePrevention: z.enum(["CANCEL_TAKER", "CANCEL_MAKER", "CANCEL_BOTH"]).default("CANCEL_TAKER"),
      jwtRefreshBeforeExpirySec: nonneg.default(3600),
      requestTimeoutMs: nonneg.default(10000),
    })
    .default({}),
  polymarket: z
    .object({
      gammaUrl: z.string().default("https://gamma-api.polymarket.com"),
      clobUrl: z.string().default("https://clob.polymarket.com"),
      dataUrl: z.string().default("https://data-api.polymarket.com"),
      wsMarketUrl: z.string().default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),
      wsUserUrl: z.string().default("wss://ws-subscriptions-clob.polymarket.com/ws/user"),
      /** 实盘开启订单心跳：进程失联 10 秒后交易所自动撤掉该 API Key 的全部挂单 */
      orderHeartbeat: z.boolean().default(true),
      /** 最小订单单位：文档矛盾，默认按份额；可改 usd 或 both（同时满足） */
      minOrderMode: z.enum(["shares", "usd", "both"]).default("shares"),
      /** 订单簿 REST 校准间隔 */
      bookResyncSec: nonneg.default(30),
      requestTimeoutMs: nonneg.default(10000),
    })
    .default({}),
  strategy: StrategySchema.default({}),
  risk: RiskSchema.default({}),
  fx: z
    .object({
      /** 1 USDT 折合多少美元（结算资产换算） */
      usdtPerUsd: num.positive().default(1),
      pusdPerUsd: num.positive().default(1),
    })
    .default({}),
  /** 模拟模式参数 */
  simulation: z
    .object({
      startingBalanceUsd: num.positive().default(1000),
      /** 模拟吃单/挂单的网络延迟 */
      latencyMs: nonneg.default(150),
      /** 真实盘口穿过挂价时按此比例模拟成交（0~1） */
      makerFillRatio: num.min(0).max(1).default(1),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const PairsFileSchema = z.object({
  pairs: z.array(PairConfigSchema).default([]),
});

export interface Secrets {
  liveTrading: boolean;
  predictApiKey: string | null;
  predictSignerPrivateKey: string | null;
  predictAccountAddress: string | null;
  polymarketPrivateKey: string | null;
  polymarketWalletAddress: string | null;
  polymarketApiKey: string | null;
  polymarketApiSecret: string | null;
  polymarketApiPassphrase: string | null;
  polymarketRelayerApiKey: string | null;
  polymarketRelayerApiKeyAddress: string | null;
  alertWebhookUrl: string | null;
  statusToken: string | null;
}

/** 合并全局策略与配对覆盖项。 */
export function effectiveStrategy(app: AppConfig, pair: PairConfig): StrategyConfig {
  const base = app.strategy;
  const o = pair.strategy ?? {};
  return {
    ...base,
    ...o,
    hedge: { ...base.hedge, ...(o.hedge ?? {}) },
    residual: { ...base.residual, ...(o.residual ?? {}) },
  };
}

export function effectiveRisk(app: AppConfig, pair: PairConfig): RiskConfig {
  return { ...app.risk, ...(pair.risk ?? {}) };
}

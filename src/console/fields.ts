/**
 * 控制台参数表单的字段说明（标签、类型、分组）。键名与 config.yaml / pairs.yaml 一致，
 * 嵌套字段用点号（hedge.coalesceMs）。scope：pair = 配对与全局都可改；global = 只在全局生效。
 */
export interface FieldSpec {
  key: string;
  label: string;
  type: "number" | "int" | "enum" | "bool" | "text";
  group: string;
  nullable?: boolean;
  options?: [string, string][];
  hint?: string;
  unit?: string;
  scope: "pair" | "global";
  /** 修改会改变敞口的计算口径：涉及的配对必须没有未结束订单、没有敞口、没有待结算成交 */
  structural?: boolean;
}

export const STRATEGY_FIELDS: FieldSpec[] = [
  { key: "priceMode", label: "挂单价格模式", type: "enum", group: "挂单", scope: "pair", options: [["fixed", "固定价（无利润时撤单）"], ["auto", "买一加价，不超过盈利上限"], ["max", "盈利上限价"]] },
  { key: "price", label: "固定挂单价", type: "number", group: "挂单", scope: "pair", nullable: true, hint: "只在固定价模式使用" },
  { key: "improveTicks", label: "比买一高几个 tick", type: "int", group: "挂单", scope: "pair", hint: "auto 模式使用" },
  { key: "minMakerPrice", label: "最低挂单价", type: "number", group: "挂单", scope: "pair", nullable: true },
  { key: "maxMakerPrice", label: "最高挂单价", type: "number", group: "挂单", scope: "pair", nullable: true },
  { key: "sizeShares", label: "目标挂单份额", type: "number", group: "挂单", scope: "pair", unit: "份" },
  { key: "minProfitPerShare", label: "每对最低费后利润", type: "number", group: "挂单", scope: "pair", unit: "美元/份", hint: "1 份挂单 + 1 份对冲" },
  { key: "hedgeSlippage", label: "对冲滑点缓冲", type: "number", group: "挂单", scope: "pair", unit: "价格" },
  { key: "riskBufferPerShare", label: "风险缓冲", type: "number", group: "挂单", scope: "pair", unit: "美元/份" },
  { key: "fxBufferBps", label: "结算资产换算缓冲", type: "number", group: "挂单", scope: "pair", unit: "基点" },
  { key: "stopQuotingBeforeStartSec", label: "开赛前停止挂单", type: "number", group: "挂单", scope: "pair", unit: "秒" },
  { key: "stopQuotingAt", label: "绝对停止挂单时间", type: "text", group: "挂单", scope: "pair", nullable: true, hint: "ISO 格式，例如 2026-11-12T20:00:00+08:00；与开赛前时间取较早者" },
  { key: "requoteMinIntervalMs", label: "改价最小间隔", type: "number", group: "挂单", scope: "pair", unit: "毫秒" },
  { key: "requoteMinTicks", label: "改价最小变动", type: "int", group: "挂单", scope: "pair", unit: "tick" },
  { key: "maxBookAgeMs", label: "盘口过期时间", type: "number", group: "挂单", scope: "pair", unit: "毫秒", hint: "超过即撤挂单" },
  { key: "emergencyCooldownSec", label: "紧急处理后暂停挂单", type: "number", group: "挂单", scope: "pair", unit: "秒" },
  { key: "hedgeTrigger", label: "补单触发标准", type: "enum", group: "补单", scope: "pair", structural: true, options: [["matched", "已撮合即补单"], ["settled", "结算成功后才补单"]] },
  { key: "hedge.minProfitPerShare", label: "正常补单每份最低利润", type: "number", group: "补单", scope: "pair", unit: "美元/份", hint: "可为负：允许小亏完成对冲" },
  { key: "hedge.retryIntervalMs", label: "补单重试间隔", type: "number", group: "补单", scope: "pair", unit: "毫秒" },
  { key: "hedge.maxNormalAttempts", label: "正常补单最多尝试", type: "int", group: "补单", scope: "pair", unit: "次" },
  { key: "hedge.fillGraceMs", label: "等待成交推送", type: "number", group: "补单", scope: "pair", unit: "毫秒", hint: "超时用 REST 补拉" },
  { key: "hedge.requestTimeoutMs", label: "吃单请求超时", type: "number", group: "补单", scope: "pair", unit: "毫秒" },
  { key: "hedge.coalesceMs", label: "成交合并窗口", type: "number", group: "补单", scope: "pair", unit: "毫秒" },
  { key: "residual.dustShares", label: "不处理的零头", type: "number", group: "残余", scope: "pair", unit: "份" },
  { key: "residual.maxWaitSec", label: "残余等待凑单时间", type: "number", group: "残余", scope: "pair", unit: "秒" },
];

export const RISK_FIELDS: FieldSpec[] = [
  { key: "maxOrderShares", label: "单笔份额上限", type: "number", group: "风控", scope: "pair", unit: "份" },
  { key: "maxOrderUsd", label: "单笔金额上限", type: "number", group: "风控", scope: "pair", unit: "美元" },
  { key: "maxMatchUsd", label: "单场资金上限", type: "number", group: "风控", scope: "pair", unit: "美元", hint: "持仓成本 + 挂单占用 + 补单预留" },
  { key: "maxUnhedgedShares", label: "单配对最大未对冲", type: "number", group: "风控", scope: "pair", unit: "份" },
  { key: "maxNakedSec", label: "最长裸仓时间", type: "number", group: "风控", scope: "pair", unit: "秒", hint: "超过进入紧急处理" },
  { key: "maxHedgePrice", label: "补单原始价格上限", type: "number", group: "风控", scope: "pair" },
  { key: "maxLossPerShare", label: "紧急处理每份最大亏损", type: "number", group: "风控", scope: "pair", unit: "美元/份" },
  { key: "maxLossPerPairUsd", label: "单配对累计最大亏损", type: "number", group: "风控", scope: "pair", unit: "美元" },
  { key: "reserveHedgeFunds", label: "为挂单预留补单资金", type: "bool", group: "风控", scope: "pair" },
  { key: "maxGlobalUsd", label: "全局资金上限", type: "number", group: "全局风控", scope: "global", unit: "美元" },
  { key: "maxUnhedgedSharesGlobal", label: "全局最大未对冲", type: "number", group: "全局风控", scope: "global", unit: "份" },
  { key: "maxDailyLossUsd", label: "当日最大亏损", type: "number", group: "全局风控", scope: "global", unit: "美元", hint: "超过停止全部新挂单" },
  { key: "balanceRefreshSec", label: "余额刷新间隔", type: "number", group: "全局风控", scope: "global", unit: "秒" },
  { key: "cancelOrphanOrders", label: "对账时撤销孤儿挂单", type: "bool", group: "全局风控", scope: "global" },
  { key: "positionTolerance", label: "对账持仓允许误差", type: "number", group: "全局风控", scope: "global", unit: "份" },
];

const LABELS = new Map<string, string>([
  ...STRATEGY_FIELDS.map((f) => [`strategy.${f.key}`, f.label] as [string, string]),
  ...RISK_FIELDS.map((f) => [`risk.${f.key}`, f.label] as [string, string]),
  ["maker.venue", "挂单平台"],
  ["maker.outcome", "挂单方向"],
  ["maker.team", "挂单队伍"],
  ["enabled", "启用"],
  ["note", "备注"],
]);

export function fieldLabel(path: string): string {
  return LABELS.get(path) ?? path;
}

export const STRUCTURAL_STRATEGY_KEYS = STRATEGY_FIELDS.filter((f) => f.structural).map((f) => f.key);

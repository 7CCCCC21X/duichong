# 官方接口核实清单（2026-11-11 核对）

本文件记录编码前对两边官方文档与 SDK 的逐项核实结果。每一条都给出出处；标注 **【待实测】** 的项目，文档未写明、文档之间互相矛盾，或只能用真实账户小额下单确认。代码中对这些项目一律按保守方式处理，并在下文写明处理方式。

## 0. 采用的 SDK 与版本

| 平台 | 包 | 版本 | 用途 | 说明 |
| --- | --- | --- | --- | --- |
| Polymarket | `@polymarket/client` | 0.18.0（npm，2026-11-09 发布） | 签名、下单、撤单、查单、成交、余额授权、订单心跳 | 官方“统一 SDK”。文档已把旧的 `@polymarket/clob-client-v2`、`builder-relayer-client`、`builder-signing-sdk` 列为迁移对象。**要求 Node.js ≥ 24**，peer 依赖 `viem ^2.46.3` |
| Predict | `@predictdotfun/sdk` | 1.3.8（npm，2026-07-28 发布） | 订单金额计算、EIP-712 签名、订单哈希、Predict 账户签名、授权、链上撤单 | peer 依赖 `ethers ^6.15.0` |
| 运行时 | Node.js | 24.22.2 | 内置 `fetch`、`WebSocket`、`node:sqlite` | Polymarket SDK 要求 ≥ 24 |

公开行情（订单簿、市场元数据）与两个 WebSocket 由本项目自行实现，不依赖 SDK，以便掌控重连、心跳、过期检测与代理。

官方文档入口：

- Polymarket：https://docs.polymarket.com （索引 https://docs.polymarket.com/llms.txt ）
- Predict 开发者文档：https://dev.predict.fun （索引 https://dev.predict.fun/llms.txt ）
- Predict 产品文档：https://docs.predict.fun

## 1. 钱包类型、资金地址与签名地址

### Polymarket（Polygon，chainId 137）

- 钱包类型：`EOA=0`、`POLY_PROXY=1`、`GNOSIS_SAFE=2`、`DEPOSIT_WALLET=3`。2026-05-04 起新建账户默认是 Deposit Wallet。出处：https://docs.polymarket.com/trading/wallets-auth.md
- 资金地址（maker / funder）与签名地址（signer）分离：

  | 钱包 | signatureType | maker | signer |
  | --- | --- | --- | --- |
  | Deposit Wallet | 3 | Deposit Wallet 地址 | Deposit Wallet 地址（内层用账户 signer 私钥签，再按 ERC-7739 包装） |
  | Proxy Wallet | 1 | Proxy 地址 | 账户 signer 地址 |
  | Safe Wallet | 2 | Safe 地址 | 账户 signer 地址 |
  | EOA | 0 | EOA | EOA |

  出处：https://docs.polymarket.com/trading/place-orders.md （“Create the Order Typed Data”）
- 本项目配置：`POLYMARKET_PRIVATE_KEY`（signer 私钥）+ `POLYMARKET_WALLET_ADDRESS`（账户钱包，即资金地址）。SDK 的 `createSecureClient({ wallet, signer })` 会自动识别钱包类型与签名流程。

### Predict（BNB Chain，chainId 56）

- 支持 EOA，或 Predict 账户（Kernel 智能钱包，即“deposit address / 资金地址”），由 Privy 钱包签名。出处：https://dev.predict.fun/trading/authentication.md
- 使用 Predict 账户时，订单的 `maker` 和 `signer` 都是 Predict 账户地址；登录签名必须用 `orderBuilder.signPredictAccountMessage`，普通钱包签名会被拒绝。SDK 创建 builder 时会链上校验 Privy 钱包是否是账户 owner。
- 本项目配置：`PREDICT_SIGNER_PRIVATE_KEY`（EOA 私钥或 Privy 导出私钥）+ 可选 `PREDICT_ACCOUNT_ADDRESS`（Predict 账户地址）。

## 2. 授权与交易资金

| 项目 | Polymarket | Predict |
| --- | --- | --- |
| 抵押品 | pUSD（https://docs.polymarket.com/concepts/pusd.md） | BSC 上的 USDT `0x55d3…7955`，18 位小数（SDK `Constants.js`） |
| 买入授权 | pUSD 对交易所 `approve`，额度需覆盖成交额**加手续费** | USDT 对 CTF Exchange 的 ERC-20 allowance |
| 卖出授权 | CTF：`setApprovalForAll`；Protocol V2：对 PositionManager `setApprovalForAll(EXCHANGE_V3)` | ConditionalTokens 的 ERC-1155 `setApprovalForAll` |
| SDK 方法 | `fetchTradingApprovalsState`、`setupTradingApprovals`、`fetchBalanceAllowance`、`updateBalanceAllowance` | `getApprovalSteps` / `checkApprovals` / `runApprovals` / `setApprovals` |
| 余额检查范围 | 下单可用 = 余额 − 全部挂单占用（https://docs.polymarket.com/concepts/order-lifecycle.md） | **API 只检查同市场同方向同结果的挂单**，跨市场超额挂单要到结算时才失败（https://dev.predict.fun/trading/market-making.md 清单最后一条） |

因此本项目自行做资金预占：挂单所需资金 + 该挂单全部成交后补单所需资金，两边分别预留。

## 3. 认证方式

- **Polymarket**：L1 = EIP-712 `ClobAuth` 签名，换取 L2 凭证 `apiKey/secret/passphrase`（`POST /auth/api-key` 或 `GET /auth/derive-api-key`）；L2 = HMAC-SHA256 请求头 `POLY_ADDRESS/POLY_API_KEY/POLY_PASSPHRASE/POLY_SIGNATURE/POLY_TIMESTAMP`。SDK 的 `createSecureClient` 会自动派生或创建凭证。用户频道 WebSocket 在订阅帧中携带 `auth`。出处：https://docs.polymarket.com/trading/wallets-auth.md 、https://docs.polymarket.com/trading/realtime-order-updates.md
- **Predict**：主网每个请求都要带 `x-api-key`（测试网不需要，且会拒绝无效 key）；代钱包操作需要 JWT：`GET /v1/auth/message` → 签名 → `POST /v1/auth`，返回 `data.token`。消息须在 10 分钟内签名提交，**JWT 有效期 24 小时**。钱包事件 WebSocket 把 JWT 放在主题名 `predictWalletEvents/{jwt}` 中，重连后要用未过期的 JWT 重新订阅。出处：https://dev.predict.fun/trading/authentication.md 、https://dev.predict.fun/api.md

本项目在 JWT 到期前 1 小时主动刷新；遇到 401 先重新登录再重试一次。

## 4. 订单类型

| | Polymarket | Predict |
| --- | --- | --- |
| 限价 | GTC、GTD（提前 1 分钟失效，且至少 3 分钟后到期） | `LIMIT`（默认不过期；可设 `expiresAt`，至少 2 分钟后、不晚于 2100-01-01） |
| 只挂单 | `postOnly: true`（仅 GTC/GTD），会吃单则被拒 | `isPostOnly: true`（仅 LIMIT），会吃单则 `orderNotAccepted(rejectedPostOnly)` |
| 吃单 | FAK（部分成交，余量取消）、FOK（全成或全撤） | `MARKET`（余量立即取消），可选 `isFillOrKill`、`slippageBps`、`isMinAmountOut` |
| 吃单价格保护 | 买：`maxPrice`；卖：`minPrice` | `slippageBps`（SDK 依据订单簿计算金额） |
| 自成交保护 | 文档未提供 | `selfTradePrevention: CANCEL_TAKER/CANCEL_MAKER/CANCEL_BOTH` |

出处：https://docs.polymarket.com/trading/place-orders.md 、https://docs.polymarket.com/concepts/order-lifecycle.md 、https://dev.predict.fun/trading/place-orders.md

**本项目的选择**：挂单一律 post-only；Polymarket 补单用 FAK + `maxPrice`；Predict 补单用 `MARKET` + 按份额计算 + `slippageBps`（价格上限）+ `selfTradePrevention: CANCEL_TAKER`。

## 5. 价格与数量单位

- **Polymarket**：价格按 tick（0.1/0.01/0.005/0.0025/0.001/0.0001）；链上金额 6 位小数；份额精度 2 位。**GTC/GTD 买单以份额为目标，FOK/FAK 买单以抵押品金额为目标**（https://docs.polymarket.com/migrate/polymarket-v2/api-integrations.md ），SDK 的 `placeMarketOrder` 买入参数 `amount` 是美元金额，卖出参数 `shares` 是份额。tick 可能变化，需要处理 `tick_size_change` 推送。
- **Predict**：订单中的价格与数量都是 wei 整数字符串（10^18 = 1 USDT 或 1 份），小数字符串会被拒；价格小数位不超过市场的 `decimalPrecision`（2 或 3）；SDK `getLimitOrderAmounts` 会把价格截断为 3 位有效数字、数量截断为 5 位有效数字，数量至少 1e16（0.01 份）。订单簿价格/数量是普通数字，**只按 Yes（indexSet=1）报价**，No 的买价 = 1 − Yes 卖价，计算互补价时须按 `decimalPrecision` 取整。出处：https://dev.predict.fun/concepts/order-book.md

本项目内部统一用 bigint 定点数（10^18 精度）表示价格、份额和金额，避免浮点误差。

## 6. 手续费

| | Polymarket | Predict |
| --- | --- | --- |
| 谁付 | 只有 taker；maker 永不收费 | 只有 taker；`makerFeeBps` 恒为 0 |
| 公式 | `fee = C × rate × p × (1 − p)`（市场 `feeSchedule.rate/exponent`；体育类 rate=0.05） | `fee = feeRateBps/10000 × min(p, 1−p) × shares` |
| 取整 | 5 位小数 | 合约以 wei 计算并向下取整 |
| 买入如何收 | **在成交额之外另付 pUSD** | **扣份额**：少拿 `fee/p` 份 |
| 卖出如何收 | 从卖出所得中扣 | 从卖出所得 USDT 中扣 |
| 签名中的费率 | 不再签费率，撮合时确定 | 签名 `feeRateBps` 是上限，须 ≥ 市场费率减推荐折扣，不得超过 1000 |
| 实际费用查询 | 成交记录 `fee`/`feeUsdc` | 成交事件 `fee.amount`、`fee.type`（`SHARES`/`COLLATERAL`）|

出处：https://docs.polymarket.com/trading/fees.md 、https://docs.polymarket.com/market-data/market-details.md （Trading Fees）、https://docs.polymarket.com/migrate/polymarket-v2/api-integrations.md （“BUY fees add to collateral spend”）、https://dev.predict.fun/trading/fees.md 、https://docs.predict.fun/the-basics/predict-fees-and-limits

## 7. 最小订单

- **Predict**：买单价值 ≥ 1 USDT；限价卖 ≥ 1 份；市价卖 ≥ 0.01 份。出处：https://dev.predict.fun/trading/place-orders.md （Rules the API checks）
- **Polymarket**：**【待实测】文档互相矛盾**。下单页说订单簿的 `min_order_size` 是“最少份额数”，市场详情页说 Gamma 的 `orderMinSize` 是“最小 USDC 金额”，SDK 注释也写“minimum USDC notional”。本项目默认按份额校验（配置项 `polymarket.minOrderMode`，可改为 `usd` 或 `both`），SDK 本地校验报错时按“低于最小单”处理。

## 8. 撮合延迟与开赛行为

- **Polymarket**：体育/电竞市场有 `secondsDelay`（实测本次电竞赛前盘为 1 秒），吃单返回 `delayed` 状态，延迟期间无法撤单，结果要看用户频道推送。**电竞市场 `clearBookOnStart=true`：开赛时清空订单簿**。出处：https://docs.polymarket.com/concepts/order-lifecycle.md ；实测 `GET https://clob.polymarket.com/clob-markets/{conditionId}` 返回 `sd: 1`、`cbos: true`。
- **Predict**：市场字段 `speedBump {delayMs, liveDelayMs, liveFrom, isRemovalLocked}`；post-only 限价单不受延迟；电竞通常从开赛起有 `liveDelayMs`。出处：https://dev.predict.fun/trading/place-orders.md （Speed bump）
- **Polymarket 撮合引擎重启**：重启期间拒单（SDK 抛 `RequestRejectedError`，`restriction === RESTARTING`，可能带 `retryAfter`），恢复后 2 分钟只接受 post-only。出处：https://docs.polymarket.com/trading/matching-engine.md

## 9. 成交状态

| 阶段 | Polymarket | Predict |
| --- | --- | --- |
| 已受理 | 下单回执 `live`/`matched`/`delayed`/`unmatched`；用户频道 `order` 事件 `PLACEMENT` | `POST /v1/orders` 返回 201（**不是最终结果**，后续检查失败会撤单）；`orderAccepted` |
| 被拒 | 回执 `ok:false` | `orderNotAccepted`（`noMarketMatch`/`rejectedDuplicate`/`rejectedPostOnly`） |
| 已撮合（待结算） | 成交 `MATCHED`（SDK 还有 `MATCHED_NOT_BROADCASTED`） | `orderTransactionSubmitted`（带 `settlementId`、`fill`、`isMaker`） |
| 上链中 | `MINED`；失败重试 `RETRYING` | — |
| 结算成功 | `CONFIRMED`（终态） | `orderTransactionSuccess`（带手续费） |
| 结算失败 | `FAILED`（终态） | `orderTransactionFailed`；失败原因方的订单变 `INVALIDATED` |
| 订单终态 | 撤单 `CANCELLATION` | `FILLED`/`CANCELLED`/`EXPIRED`/`INVALIDATED` |

出处：https://docs.polymarket.com/trading/realtime-order-updates.md 、https://docs.polymarket.com/concepts/order-lifecycle.md 、https://dev.predict.fun/trading/order-lifecycle.md 、https://dev.predict.fun/websocket/topics/wallet-events.md

**首版补单触发标准**：默认在“已撮合”时触发补单（Polymarket `MATCHED`，Predict `orderTransactionSubmitted`），撮合数量立即计入敞口；结算失败时冲回该笔数量，由敞口引擎处理多出来的对冲腿。可配置 `hedgeTrigger: settled`，改为等结算成功后才补单。

**成交归属**：Polymarket 自己做 maker 时，按成交里 `makerOrders` 中属于本账户订单的那几条的 `matchedAmount` 计数（顶层的 `size/side/asset` 是 taker 的）；Predict 钱包事件只推送本钱包订单，自成交时 taker、maker 各收到一条。

## 10. 限流

- **Polymarket**：Cloudflare 按 IP 限流，超限是**排队延迟**而不是直接拒绝（`POST /order` 突发 5000/10s、持续 120000/10min 等），外加按 signer 的令牌桶（下单桶与撤单桶分开；2026-07-24 起先进入警告模式，响应头 `Poly-RateLimit-Warning: true`）。出处：https://docs.polymarket.com/api-reference/rate-limits.md 、https://docs.polymarket.com/api-reference/trading-rate-limits.md
- **Predict**：交易类路由 500/分钟，其他 250/分钟，搜索 120/分钟；下单/撤单 POST 另限 40/秒；响应头 `RateLimit-*`，429 时没有 `Retry-After`，用 `RateLimit-Reset`。出处：https://dev.predict.fun/resources/rate-limits.md

本项目：本地令牌桶 + 优先级队列（撤单 > 补单 > 挂单更新），429 / 限流异常按服务端给出的等待时间退避。

## 11. WebSocket

| | Polymarket | Predict |
| --- | --- | --- |
| 地址 | `wss://ws-subscriptions-clob.polymarket.com/ws/market`、`/ws/user` | `wss://ws.predict.fun/ws`（测试网文档写“暂不可用”） |
| 心跳 | 客户端每 10 秒发文本 `PING`，服务端回 `PONG` | 服务端每 15 秒发 `heartbeat`，客户端原样回显 `{method:"heartbeat", data}`，否则断开 |
| 订单簿 | `book` 全量 + `price_change` 增量 + `tick_size_change` | `predictOrderbook/{marketId}`，每条都是全量，可能合并多次变化 |
| 自己的订单 | `/ws/user` 订阅帧带 `auth` | `predictWalletEvents/{jwt}` |
| 断线 | 需重连并重新订阅 | 订阅不跨连接保留，断线期间消息不补发；服务器下线前会在 `system` 主题发重连通知 |

断线后本项目会：标记行情过期 → 撤掉依赖该行情的挂单 → 重连 → 用 REST 重新拉订单簿、挂单和近期成交对账 → 再恢复挂单。

## 12. 订单心跳（只有 Polymarket）

首次被接受的心跳会对该 API Key 的全部挂单开启超时撤单：10 秒内没有新心跳，服务端排队撤掉全部挂单，且**没有关闭开关**。出处：https://docs.polymarket.com/trading/manage-orders.md （Order Heartbeats）。本项目在实盘模式下默认开启（每 5 秒），用于进程异常退出时自动撤单。Predict 没有类似机制，所以 Predict 挂单默认设置较短有效期（`predict.makerOrderTtlSec`）并定期续挂。

## 13. 市场与结算

- **Polymarket 市场版本**：Gamma 市场 `version` 为 `v1`（CTF，用 `clobTokenIds`）或 `v2`（Protocol V2，用 `positionIds`），两者可能同时存在，必须按 `version` 选择。**电竞按计划于 2026-12-01（美东时间）切换到 Protocol V2**，已有 CTF 市场不迁移。出处：https://docs.polymarket.com/migrate/polymarket-v2/overview.md
- **电竞盘口字段**：Polymarket `sportsMarketType`（`moneyline` 整场、`child_moneyline` 单局、`totals`、`map_handicap`、`round_handicap_game_N` 等）、`line`、`gameStartTime`、事件 `teams`、`eventMetadata.pandascoreMatchId`；Predict 类别 `marketVariant`（`ESPORTS_LOL/CS2/DOTA2`）、`variantDetails.sports.{provider, providerEventId, teams}`，市场 `marketType`（`SPORTS_MONEYLINE` 等）、`variantDetails.sports.{line, gameNumber}`、结果 `variantDetails.sports.team`、`polymarketConditionIds`。
- **结算**：两边都支持 1/0 与 50-50 兑付（Predict：https://dev.predict.fun/concepts/resolution.md ；Polymarket 市场规则原文）。
- **实测规则差异**：Predict 测试网镜像的 Dota 2 赛事规则写的是“延期 7 天（168 小时）”，而 Polymarket 同类电竞规则写的是“14 天”。可见同一场比赛的规则原文可能不同，必须逐条比对，不能只看 conditionId 是否对应。

## 14. 【待实测】汇总（需要真实账户小额验证）

1. Polymarket 最小订单的单位（份额还是 USDC），以及 FAK 市价单的最小金额。
2. Predict 市场字段 `feeExponent` 的含义（实测出现 1 和 2，文档只给出指数为 1 的公式）。本项目按文档公式估算（对任意价格都不低于指数更大的曲线），并记录实际手续费比对。
3. Polymarket 电竞赛前盘 `secondsDelay=1` 是否作用于赛前吃单（补单可能返回 `delayed`）。
4. Polymarket FAK 买单的实际 pUSD 花费（成交额 + 手续费）与实得份额。
5. Predict MARKET 买单的实际到账份额与 `fee.amountWei` 是否与公式一致。
6. Predict 钱包事件中 `orderTransactionSubmitted` 与 `orderTransactionSuccess` 的到达顺序和延迟。
7. Polymarket 用户频道里，自己做 maker 时 `makerOrders` 的字段与状态推进时序。
8. Predict 主网电竞市场赛前的 `speedBump` 实际值。
9. Deposit Wallet、Predict 账户两种钱包的签名与授权流程。
10. Polymarket 订单 ID 能否在发送前本地算出（用于超时后精确查单）；本项目在拿不到 ID 时改用“按市场拉挂单与成交并按价格/数量/时间匹配”。
11. 同一场比赛两边规则原文的差异（延期窗口、弃权、平局、结算源）。
12. USDT 与 pUSD 之间的换算与出入金成本（不在机器人内，但影响真实盈亏，配置 `fx` 缓冲）。
13. 2026-12-01 起电竞新市场使用 Protocol V2（`positionIds`、`CONDITIONAL-V2`、ExchangeV3 授权）。
14. Polymarket 开赛清簿时，挂单被清掉后用户频道是否推送撤单事件。
15. Polymarket Cloudflare 限流是排队而非拒绝，可能表现为请求超时。
16. Polymarket 用户频道能否在连接后用 `{operation: "subscribe", markets: [...]}` 追加市场（加网页控制台时本环境访问不到 docs.polymarket.com，未能核实）。控制台在运行中新增配对时，目前用重连方式让订阅帧带上新市场；实测确认追加订阅有效后可改为不重连。

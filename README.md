# Polymarket × Predict.fun 电竞赛前对冲机器人

在一边挂电竞比赛整场胜负的 post-only 限价买单，实际成交后去另一边买同场比赛的互补结果，按净成交份额对齐仓位，赚取两边合计成本低于兑付金额（每对 1）的差额。

- 支持两个方向：Predict 挂单 + Polymarket 补单；Polymarket 挂单 + Predict 补单。
- 首版范围：电竞赛前整场胜负盘（moneyline），每个配对同时只启用一边挂单；挂单平台、方向、价格、数量、最低利润、停止挂单时间均可配置。
- 默认模拟模式（真实公开行情 + 模拟成交）；实盘需要显式开启。

> 编码前对两边官方文档与 SDK 的逐项核实见 [docs/API_VERIFICATION.md](docs/API_VERIFICATION.md)；测试与验证结果见 [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md)。

## 架构

```
              ┌──────────── 行情 market/ ────────────┐
Polymarket ── │ Gamma 元数据 · CLOB 订单簿 · 行情 WS  │ ─┐
Predict ───── │ REST · 行情 WS（心跳）· REST 轮询兜底 │ ─┤→ BookStore（订单簿 + 交易约束）
              └───────────────────────────────────────┘  │
pairing/ 配对核对：conditionId → 子盘口、队伍/token、赛制、时间、规则条款、结算情形矩阵 → 白名单/待审核
                                                         │
engine/ 每个配对一个 PairEngine（串行队列）               ▼
  报价（pricing/：逐档深度 + 手续费 + 缓冲）→ post-only 挂单 → 成交台账（去重、4 桶净额）
  → 按净成交补单（在途预占、超时查单）→ 残余 / 紧急处理 → 风控（限额、资金预留、停止新挂单）
  → 对账（启动、重连）
venues/ 统一交易接口：Polymarket 实盘（官方统一 SDK）| Predict 实盘（官方 SDK + REST + 钱包事件 WS）| 模拟交易所
db/ SQLite（Node 内置 node:sqlite，WAL）：订单意图、成交、配对与规则快照、告警、裸仓事件、审计日志
monitor/ 状态页（北京时间）       cli.ts 命令行
```

## 环境要求与安装

- **Node.js ≥ 24**（Polymarket 官方统一 SDK `@polymarket/client` 的要求；数据库使用 Node 内置 SQLite，无需编译原生模块）。
- 依赖已锁定在 `package-lock.json`。

```bash
npm ci
npm run build
cp config/config.example.yaml config/config.yaml
cp config/pairs.example.yaml  config/pairs.yaml
cp .env.example .env          # 填密钥；模拟模式可以先不填
npm test                      # 51 项测试
```

机器需要经 HTTP 代理访问外网时，启动前设置 `NODE_USE_ENV_PROXY=1`（让 Node 的 fetch 使用 `HTTPS_PROXY`），WebSocket 会自动走代理。

## 快速开始

```bash
node dist/cli.js check                                   # 检查配置、行情连通、凭证与余额（不下单）
node dist/cli.js pairs discover                          # 遍历 Predict 电竞盘，按 polymarketConditionIds 找对应子盘口并核对
node dist/cli.js pairs verify <predictMarketId> <conditionId>   # 核对指定配对，打印检查项与结算情形矩阵
node dist/cli.js pairs approve <pairId> --note "已人工核对延期条款"  # 待审核配对人工批准
node dist/cli.js run                                     # 启动（默认模拟）
# 浏览器打开 http://127.0.0.1:8787/ 查看状态；或 node dist/cli.js status
```

不需要任何凭证即可运行的真实行情检查与端到端模拟：

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/live-data-check.ts 45   # 行情 WS 与 REST 逐档比对、真实深度下的补单成本
NODE_USE_ENV_PROXY=1 npx tsx scripts/paper-e2e.ts            # 对冲侧真实 Polymarket 盘口的端到端模拟
```

## 配置

| 文件 | 内容 |
| --- | --- |
| `config/config.yaml` | 模式、两边接口参数、全局策略默认值、风控限额、模拟参数（见 `config.example.yaml` 注释） |
| `config/pairs.yaml` | 要交易的配对：Predict 市场 ID、Polymarket conditionId、挂单平台与方向、策略/风控覆盖项 |
| `.env` | 全部密钥（只从环境变量读取，日志自动脱敏）、`LIVE_TRADING` 实盘开关、告警 webhook、状态页口令 |

**实盘开关**：必须同时满足 `config.yaml` 中 `mode: live` 与 `.env` 中 `LIVE_TRADING=true`，否则一律模拟。模拟与实盘使用不同数据库文件（`data/sim.db` / `data/live.db`）。

**配对中的 A / B**：A = Predict 市场 indexSet=1 的队伍，B = indexSet=2 的队伍；Polymarket 一侧按队伍自动对应（顺序可能相反）。`maker` 可写 `outcome: A|B` 或 `team: 队名`。

## 配对：发现、核对、审批

1. 优先使用 Predict 市场返回的 `polymarketConditionIds` 找到 Polymarket 子盘口（Gamma 按 conditionId 查询，含已关闭市场）。
2. 逐项核对：conditionId 是否在 Predict 声明列表中、游戏、盘口类型（整场/单局/让分/大小分）、单局号、盘口线、赛制（BO3 等）、开赛时间、两边是否可交易、队伍与 outcome token 对应（Predict `providerTeamId` 与 Polymarket 队伍 `id`、全名、缩写）。
3. 规则条款：从两边规则原文中提取取消、平局、延期窗口、开赛前/后弃权、未完赛、结算源；对每种情形计算两边对 [A, B] 的兑付向量，两边相同才保证任意互补组合合计兑付为 1。例如 Predict 延期窗口 168 小时、Polymarket 14 天时，延期落在中间会出现合计 0.5 或 1.5，配对进入待审核。
4. 结果：全部通过 → `APPROVED`；有歧义或可能导致兑付不一致 → `PENDING_REVIEW`（可人工 `approve`）；硬性不符 → `REJECTED`（不可批准）。
5. 保存：两边市场 ID、队伍对应的 token、两边规则原文与哈希、市场原始数据快照（`market_snapshots` 表）。
6. 变更检测：每 5 分钟、以及收到 Predict `predictMarketChanged` 推送时重新核对；规则、队伍或赛程变化导致版本哈希变化时，配对暂停新挂单并重新核对；人工批准过的配对需要重新批准。

## 关键机制

### 挂单定价（挂单前按实际深度计算利润）

- 订阅两边完整订单簿（Polymarket 全量 + 增量并定期 REST 校准；Predict 全量推送或轮询，No 簿按精度由 Yes 簿互补得到）。
- 按目标数量逐档计算在对冲平台买入互补结果的成本：Polymarket 买单手续费另付 pUSD；Predict 买单手续费扣份额，按“净到账份额”倒推毛份额。
- 最高挂价 = (1 − 最低利润) / (1 + 结算资产换算缓冲) − 对冲每份成本（含手续费、滑点缓冲、风险缓冲），按挂单平台 tick 向下取整；post-only 不触及卖一；满足两边最小订单。
- 价格模式：`fixed`（固定价，无利润时撤单）、`auto`（买一加 N tick 但不超过盈利上限）、`max`（盈利上限价）。
- 挂单数量取以下最小值：配置数量、对冲平台在补单价格上限内的深度、单笔/单场/全局资金上限、两边可用余额（为全部挂单可能成交预留补单资金）、未对冲份额上限。
- 对冲盘口恶化使挂价高于新的盈利上限时立即撤单；价格变化达到阈值时按最小间隔调整报价；Predict 挂单使用短有效期并在到期前续挂。撤单过程中的成交照常计入敞口。

### 成交确认标准与补单（首版）

- **默认在“已撮合”时触发补单**：Polymarket 成交 `MATCHED`、Predict `orderTransactionSubmitted`。撮合数量立即计入净敞口；结算失败（Polymarket `FAILED`、Predict `orderTransactionFailed`）时冲回该笔数量，敞口引擎再处理多出的对冲腿。可配置 `hedgeTrigger: settled` 改为结算成功后才补单。
- 按新增净成交补单：挂 50 份成交 18 份就补 18 份；补单只到账 12 份，剩余 6 份继续补。
- Polymarket 补单用 FAK（按金额下单，金额按当前深度算出买目标份额所需的成交额，`maxPrice` 限价）；Predict 补单用 MARKET（按份额，`slippageBps` 表达价格上限，自成交保护 `CANCEL_TAKER`）。实际到账以成交回报为准。
- 正常补单价格上限：每份实际成本 ≤ 1 − 挂单腿平均成本 − 正常补单最低利润，且原始价格 ≤ `maxHedgePrice`。
- 成交合并窗口（默认 100ms）：几乎同时到达的多笔成交先净额再补单（为后续双边挂单保留：两边各成交互补的 18 份时净敞口为零，不补单）。

### 订单状态、持久化与幂等

- 订单在签名前以 `INTENT` 落库，签名后保存可查询标识（Predict 订单哈希；Polymarket 本地推导的订单哈希）再发送：`INTENT → PREPARED → SENDING → ACCEPTED/PARTIAL → FILLED/CANCELLED/EXPIRED/REJECTED`，超时或网络错误为 `UNKNOWN`，查单确认不存在为 `NOT_FOUND`。
- 请求超时后先查单（及补拉成交）再决定后续动作；状态未知期间按整笔数量预占，不会重复补单。
- 成交按唯一键去重（Polymarket `tradeId:orderId`，Predict `orderHash:settlementId`）；状态只前进不后退，结算回报的实际手续费覆盖估算值。成交先于下单回执到达时先暂存，订单拿到交易所 ID 后再匹配。
- 每条成交只统计属于本账户订单的部分（Polymarket 自己做 maker 时取 `makerOrders` 中本账户的条目）。
- 同一配对的所有状态更新在串行队列中执行；网络请求在队列外执行，结果写库后再排队评估。在途补单在下单前就写入订单表，作为预占。

### 补单失败与紧急处理

- 触发条件：裸仓超过 `maxNakedSec`、未对冲份额超过上限、正常补单多次未完成、补单平台不可用。
- 先撤销该配对剩余挂单，再在亏损限制内比较“紧急补反向”（任一平台买入互补结果）与“卖回原腿”（在持有平台卖出），选每份亏损最小的方案；只执行限额内部分。
- 预计亏损超过单配对或当日上限时：**停止全部新挂单并报警**，保留已有订单对账和风险处理能力（继续在限额内尝试处理敞口）。`node dist/cli.js resume` 人工解除。
- 小额残余：低于补单平台最小单时，仍在挂单就先等待更多成交；超时或停止挂单后在亏损限制内卖回或反向买入（Predict 市价卖最小 0.01 份）；低于 `dustShares` 的零头不处理；无法处理时告警并持续监控。

### 断线、暂停、余额、授权、限流、认证

| 情况 | 处理 |
| --- | --- |
| 行情断连/过期 | 超过 `maxBookAgeMs` 未更新：撤掉依赖该行情的挂单，请求 REST 刷新；WebSocket 自动重连（Polymarket 10 秒 PING，Predict 回显心跳、处理重连通知） |
| 订单事件流断开 | 阻断该平台的挂单并撤单；恢复后先对账再恢复挂单 |
| 市场暂停/关闭 | 定时刷新市场状态（Predict 还订阅状态推送）；不接受订单时撤单、停止挂单，敞口在另一平台处理 |
| 余额不足 | 拒单后阻断该平台挂单 60 秒并告警；挂单数量按可用余额与补单资金预留计算 |
| 授权缺失 | 启动与定时检查（Predict 授权步骤、Polymarket pUSD 授权额度）；缺失时阻断并告警，恢复后自动解除 |
| 限流 | 按服务端给出的等待时间（Predict `RateLimit-Reset`，Polymarket `retryAfter`）阻断后重试 |
| 认证过期 | Predict JWT 到期前 1 小时刷新、401 自动重新登录并重订钱包事件；Polymarket 401/403 自动重新创建客户端 |
| 撮合引擎重启 | Polymarket `RESTARTING`/post-only 窗口：按 `retryAfter` 暂停后重试 |
| 进程失联 | Polymarket 订单心跳（10 秒无心跳交易所撤单）；Predict 挂单短有效期兜底；退出信号时先撤挂单 |

### 恢复与对账

启动、订单事件流重连后按顺序：核对未终结订单（查单）→ 补拉近期成交（去重入账）→ 查询交易所挂单（撤销本地无记录的孤儿单）→ 比对真实持仓与台账。成交补拉完成后才允许补单，全部通过后才恢复新挂单；持仓不一致时暂停该配对并告警，人工确认后可 `accept-positions` 把差额记为基线。

### 开赛与停止挂单

Polymarket 电竞市场开赛时清空订单簿（`clearBookOnStart`），Predict 开赛后有吃单延迟。停止挂单时间取“开赛前 `stopQuotingBeforeStartSec` 秒”与 `stopQuotingAt` 的较早者，开赛时间取两边较早者；到时间撤单，敞口照常处理。

## 状态与日志

- 状态页 `http://127.0.0.1:8787/`（JSON：`/api/status`），所有时间为北京时间：两边前 5 档盘口及延迟、订单、实际成交（撮合份额、净到账份额、手续费及是否估算）、各平台持仓（计入敞口/已结算/待结算）、净敞口与含在途补单的预计敞口、裸仓时长、补单耗时（每次敞口从出现到对齐）、费用、费后盈亏（已对冲部分锁定盈亏、未对冲部分成本）、最近报价及不挂单原因、余额、平台阻断、告警。
- 日志为 JSON 行，时间为 `+08:00` 北京时间；私钥、API Key、密钥、口令、JWT、签名按字段名与值双重脱敏。
- 告警写入数据库，可选推送到 `ALERT_WEBHOOK_URL`。

## 已验证 / 需要真实账户小额实测

**已验证（无需凭证）**：定价与两边手续费公式（对照官方费率表）、订单簿维护（真实 WebSocket 与 REST 逐档一致）、配对核对与规则矩阵（真实接口与真实规则原文）、全部故障场景（模拟交易所驱动真实引擎）、端到端模拟（对冲侧真实 Polymarket 深度与费率）、启动/状态页/优雅退出、Predict 订单构建与签名（离线）、两家 SDK 类型检查。详见 [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md)。

**需要真实账户小额实测**（建议每项 5~10 份、最低利润调高、单场上限调低）：

1. Predict 主网 API Key、JWT 登录、钱包事件推送（含 Predict 账户签名）；Polymarket Deposit Wallet / Proxy / Safe 的签名与 L2 凭证派生。
2. 两边授权检查与授权流程。
3. post-only 挂单受理、被吃后的成交推送（Polymarket `makerOrders` 字段与状态推进；Predict `orderTransactionSubmitted`/`Success` 的顺序与延迟）。
4. Polymarket 本地推导的订单哈希是否等于回执 `orderID`（不一致时系统会告警并改用按代币/时间匹配）。
5. Polymarket FAK 买单的实际花费（成交额 + 手续费）与到账份额；赛前电竞盘 1 秒撮合延迟下的 `delayed` 状态处理。
6. Predict MARKET 买单的实际到账份额与 `fee.amountWei`；`feeExponent≠1` 市场的实收手续费（系统按指数 1 保守估算）。
7. Polymarket 最小订单单位（份额还是 USDC，配置 `polymarket.minOrderMode`）。
8. 撤单、超时查单、重启对账、持仓接口与台账一致性。
9. Polymarket 开赛清簿时的撤单推送；2026-12-01 起电竞新市场使用 Protocol V2（`positionIds`、ExchangeV3 授权）。
10. USDT 与 pUSD 的出入金与换算成本（配置 `strategy.fxBufferBps`）。

## 目录结构

```
src/
  cli.ts app.ts                 命令行与总控
  config/                       配置 schema 与加载（zod）
  core/                         定点数、北京时间、日志脱敏、串行队列、类型
  db/                           SQLite 与仓储
  market/                       两边行情（REST/WS）与订单簿存储
  pricing/                      手续费、逐档成本、报价
  pairing/                      规则条款、核对、配对服务
  engine/                       配对引擎、台账、风控、对账、事件路由、告警
  venues/                       交易接口：polymarket/live.ts、predict/live.ts、sim/simVenue.ts
  monitor/                      状态页
test/                           定价、配对、故障场景测试
scripts/                        真实行情核对、端到端模拟、Predict 签名离线检查
docs/                           官方接口核实清单、测试结果
config/                         配置示例
```

## 风险提示

跨平台对冲依赖两边对同一比赛的结算一致；即使核对通过，规则文本差异、结算源差异、改期、主观判定都可能导致两边结算不一致。请先在模拟模式运行，再用小额资金逐项实测上表内容。

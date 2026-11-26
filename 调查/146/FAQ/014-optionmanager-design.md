# OptionManager 设计

- 日期：2026-11-20
- 状态：DRAFT（设计文档，未写代码）
- 范围：新 FastTrade 的期权账户运行时：OptionManager、AccountHost、指标-策略、订单路由、风险与恢复
- 关联：`013-indicator-strategy-system-design.md`、`206-contract-catalog.md`

---

## 1. 系统定位

新系统把期权交易定义为一个独立的账户运行时：

```text
1 个期权 ORS 账户
  = 1 个 ORS
  + 1 个 AccountHost
  + N 个 OptionManager TB（N >= 1）
```

实例关系：

```text
1 TB 进程 = 1 OptionManager = 1 期权组合
```

一个账户内可以有多个 OptionManager。`N = 1` 只是 `N >= 1` 的特例，不是架构假设。

OptionManager 是 TB 进程内的组合编排器。

```text
Option ORS
  ↕
AccountHost
  ↕ 本机 IPC
OptionManager TB
  ├─ OptionCatalog
  ├─ OptionPricingEngine
  ├─ OptionPortfolio
  ├─ OptionGreeks
  ├─ OptionIndicators
  ├─ OptionStrategy
  ├─ OptionRisk
  └─ OptionExecutionPlanner
```

订单能力由 AccountHost 统一提供；期权语义留在 OptionManager。

---

## 2. 设计目标

1. 一个 OptionManager 管理一个期权组合。
2. 每个 TB 进程只创建一个 OptionManager 实例。
3. OptionManager 使用 AccountHost 的订单、账户、对账、`clientOrderId`/`orderRef` 能力。
4. 期权定价、组合 Greeks、策略决策、执行规划分层。
5. 指标按策略订阅，期权组合 Greeks 按 OptionManager 隔离。
6. 热路径内存计算，DB 只做异步持久化、审计和恢复基线。
7. 多 OptionManager 共享账户是一等模型，每个组合独立。
8. 账户级订单状态只有一个权威：AccountHost。

---

## 3. 设计原则

### 3.1 账户边界

```text
Account = ORS 会话 + AccountHost + clientOrderId/orderRef + 账户对账
```

### 3.2 单写者

一个账户的订单发布、订单状态、成交归属由 AccountHost 统一管理。

OptionManager 只生成 `OrderIntent`，通过 AccountHost 提交。

### 3.3 期权语义在 OptionManager

```text
symbol
underlyingContractKey / underlyingSymbol
expiryDate
strikePrice
optionType
delta/gamma/vega
hedge leg
```

由 OptionManager 持有。

### 3.4 指标与策略分离

```text
OptionPricingEngine -> 定价
OptionIndicators    -> IV/Greeks/组合 Greeks
OptionStrategy      -> 报价/对冲决策
```

指标输出数值；策略输出 `StrategyDecision`。

### 3.5 失败关闭

- 定价无效：不报价。
- Greeks 无效：不交易。
- 期权腿映射不一致：PAUSED。
- 账户对账失败：不 arm。

### 3.6 热路径内存化

```text
OptionCatalog 只读缓存
OptionPortfolio/Greeks 内存
AccountHost 订单/账户内存
DB 异步投影
```

### 3.7 完整架构

OptionManager 定义完整架构。策略类型、标的范围和上线数量属于实施范围，不是架构边界；不得删除组件、降级账本，也不得假设单 manager/单策略。

```text
OptionCatalog
OptionPricingEngine
OptionPortfolio
OptionGreeks
OptionIndicators
OptionStrategy
OptionBiasPolicy / OptionHedgePolicy
OptionExecutionPlanner
OptionRisk
AccountHost 路由
```

从第一天起全部存在。

---

## 4. 系统上下文

```text
┌──────────────────── Option ORS Account ────────────────────┐
│                                                            │
│  ORS（期权 + 标的）                                        │
│    ↕                                                       │
│  AccountHost                                               │
│    ├─ AccessClient                                         │
│    ├─ OrderState / clientOrderId / orderRef                │
│    ├─ Account/Position Reconciler                          │
│    └─ Account Risk                                         │
│                                                            │
│  OptionManager TB（StrategyProcess）                       │
│    ├─ OrderGatewayClient  ──────> AccountHost              │
│    ├─ MarketDataClient   <────── ORS/Aeron                 │
│    ├─ OptionManager                                       │
│    └─ OptionWorker/Strategy                               │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

| 组件 | 负责 |
|---|---|
| ORS | 期权/标的会话、行情、订单 |
| AccountHost | 账户订单、仓位、对账、路由、账户风险 |
| OptionManager TB | 期权组合、定价、Greeks、策略、执行计划 |
| OrderGatewayClient | OptionManager -> AccountHost 的本机请求/响应 |
| MarketDataClient | 只读行情订阅 |
| BotGateway | 只读数据/控制展示 |

---

## 5. 进程模型

### 5.1 账户与 OptionManager 数量

```text
Option ORS Account
  ├─ ORS 进程
  ├─ AccountHost 进程
  ├─ OptionManager TB A
  ├─ OptionManager TB B
  └─ OptionManager TB C
```

关系固定为：

```text
1 Account = 1 ORS + 1 AccountHost + N OptionManager TB，N >= 1
1 TB = 1 OptionManager = 1 组合
```

所有订单路由、成交归属、持仓对账、Greeks 和风险都按 `N >= 1` 设计，不能依赖“一个账户只有一个 OptionManager”的假设。

### 5.2 共享账户路由

每个 OptionManager 注册一个账户内唯一的 `strategyId`。

```text
AccountHost
  strategyId A -> OptionManager TB A
  strategyId B -> OptionManager TB B
  strategyId C -> OptionManager TB C
```

`OptionManager` 内部的多个期权策略共享该 manager 的 `strategyId`，由 manager 自己再做策略/腿的本地映射。

AccountHost 只认 OptionManager 的 `strategyId`，不感知 OptionManager 内部的 `OptionStrategy`。

---

## 6. OptionManager 组件

### 6.1 OptionManager

进程内组合编排器。

职责：

- 持有当前 TB 的期权组合；
- 组织定价、Greeks、指标、策略；
- 生成 `StrategyDecision`；
- 调用 `OptionExecutionPlanner`；
- 通过 `OrderGatewayClient` 提交 `OrderIntent`。

### 6.2 OptionCatalog

只读合约/配置目录。字段和校验统一见 `206-contract-catalog.md`；这里是 OptionManager 视图：

```text
contractKey
underlyingContractKey?
underlyingSymbol
exchange
expiryDate
strikePrice
optionType        CALL | PUT
multiplier
tickSize
exerciseStyle
catalogVersion
updatedAt
source
```

来源：

```text
ContractCatalog / OptionConfig / InstrumentCatalog / CTP 合约查询
```

`OptionCatalog` 是 `ContractCatalog` 的 Option 投影，不保留第二套 expiry/strike/underlying 事实。

### 6.3 OptionPricingEngine

纯计算：

```text
price
impliedVol
delta
gamma
vega
theta
parity
```

要求：

- 无状态；
- 不持有策略；
- 不读 AccountHost；
- 可单测；
- 可回测；
- 热路径避免大对象分配。

### 6.4 OptionPortfolio

每个 OptionManager 一份，主键是 `legKey`，不是 `instrumentId`。

```text
managerKey = strategyId
  -> legKey
    -> Position
```

`legKey` 是 OptionManager 内部稳定 ID。一个 leg 对应一个 instrument；同一个 instrument 出现在不同策略/不同腿时，不能合并为同一条持仓。

```text
OptionLeg
  legKey
  strategyId（manager 内部）
  role：OPTION | HEDGE | UNDERLYING
  contractKey
  symbol
  underlyingContractKey?
  underlyingSymbol
  expiryDate
  strikePrice
  optionType        CALL | PUT
  multiplier

Position
  legKey
  contractKey
  netQty（带符号）
  avgPrice
  realizedPnl
  fees
  lastFillId

LegOrder
  clientOrderId
  requestId
  legKey
  strategyId
  instrumentId
  side
  qty
  filledQty
  avgFillPrice
  status
```

`OptionPortfolio` 自身：

```text
managerKey
legs
positions
ordersByClientId
intentsByRequestId
pendingFills
lastFillId
state：ACTIVE | RECONCILING | PAUSED
```

`LegOrder` 只是成交归因索引，不是订单状态权威；订单状态权威在 AccountHost。

更新来源：

```text
FillEvent
  -> clientOrderId -> legKey
  -> OptionPortfolio.applyFill()
```

成交先到、映射未建立时进入 `pendingFills`，不能猜腿；超时或恢复后仍无法映射，`PAUSED`。

记账规则：

```text
BUY  -> +qty
SELL -> -qty

同方向加仓：
  newAvg = (oldQty * oldAvg + fillQty * fillPrice) / (oldQty + fillQty)

多头平仓：
  realizedPnl += (fillPrice - oldAvg) * closedQty * multiplier

空头平仓：
  realizedPnl += (oldAvg - fillPrice) * closedQty * multiplier

反手：
  先平 oldQty，剩余 qty 按 fillPrice 开新仓

未实现 PnL：
  (markPrice - avgPrice) * netQty * multiplier
```

`avgPrice` 不含乘数；乘数只在 PnL 和 Greeks 聚合时使用。手续费单独累计。

对账按 instrument 聚合：

```text
Σ OptionPortfolio.positions by instrument
  + UNASSIGNED
  = AccountHost.accountPosition
```

AccountHost 持仓快照只用于对账，不作为 OptionPortfolio 的初始化来源。

#### 与 Pair 腿的关系

相同点：

```text
legKey 是管理进程内部语义
AccountHost 不感知 legKey
requestId -> legKey
clientOrderId -> legKey
成交按 clientOrderId 回到 leg
```

不同点：

```text
Pair leg 是价差的一边，带 ratio / sideSign / pair group
Option leg 是组合账本的一条腿，带 option/hedge role、strikePrice、expiryDate、Greeks
```

因此共享 `legKey` 映射协议，不强行共享账本实现：

- `PairwiseArbStrategy` 用 `PairLegSpec` / `PairLegState`；
- `OptionManager` 用 `OptionLeg` / `OptionPortfolio`；
- 两者都不把 `legKey` 交给 AccountHost。

### 6.5 OptionGreeks

每个 OptionManager 一份：

```text
portfolio delta
portfolio gamma
portfolio vega
portfolio theta
portfolio pnl
per-leg contribution
```

输入：

```text
OptionPortfolio positions
OptionPricingEngine greeks
market data
```

输出：

```text
OptionGreeksSnapshot
```

### 6.6 OptionIndicators

通过统一 `IndicatorEngine`，按策略订阅：

```text
OptionIV
OptionDelta
OptionVega
OptionGamma
OptionTheta
OptionTheoryPrice
OptionParity
PortfolioDelta
PortfolioVega
PortfolioGamma
PortfolioPnl
```

市场指标与组合指标分开：

```text
OptionIV/Delta/Vega = 市场/定价指标
PortfolioDelta/Vega = 依赖策略仓位的组合指标
```

### 6.7 OptionStrategy

```text
OptionQuotingStrategy
OptionHedgingStrategy
```

职责：

```text
IndicatorSnapshot + OptionPortfolio + config + risk
  -> StrategyDecision
       targetPositions: legKey -> targetQty
       quoteHints
       urgency
```

`targetPositions` 的 key 是 `legKey`，不是 `instrumentId`。同一个 instrument 出现在不同策略/腿时，决策和持仓都按 leg 分开。

### 6.8 OptionBiasPolicy / OptionHedgePolicy

策略内 policy：

```text
OptionBiasPolicy
  OptionGreeksSnapshot + config -> delta/vega/position bias

OptionHedgePolicy
  OptionGreeksSnapshot + config -> hedge target positions
```

### 6.9 OptionExecutionPlanner

```text
StrategyDecision -> OrderIntent
```

输入：

```text
targetPositions: legKey -> targetQty
```

输出：

```text
OrderIntent（字段见 8.4）
```

Planner 负责：

```text
legKey -> instrumentId
quote width
delta/vega width
cross width
max quote level
hedge urgency
```

AccountHost 只看到 `instrumentId`，不看到 `legKey`。

### 6.10 OptionRisk

策略级：

```text
max option position
max delta/vega/gamma
per-strike/expiry concentration
quote width
stop
expiry/exercise risk
```

账户级：

```text
margin
max notional
max open orders
order rate
account net position
```

---

## 7. 指标-策略数据流

### 7.1 行情

```text
Option ORS
  -> MarketDataClient（只读）
  -> OptionManager
       OptionPricingEngine
       OptionIndicators
       OptionGreeks
  -> IndicatorSnapshot
  -> OptionStrategy
```

### 7.2 决策

```text
OptionStrategy.decide
  -> StrategyDecision
       targetPositions
       quoteHints
       urgency
  -> OptionExecutionPlanner
  -> OrderIntent
  -> AccountHost
```

### 7.3 成交

```text
Option ORS
  -> AccountHost
       clientOrderId -> strategyId
  -> OptionManager
       clientOrderId -> legKey
  -> OptionPortfolio.applyFill
  -> OptionGreeks recompute
```

### 7.4 对冲

```text
OptionGreeksSnapshot
  -> OptionHedgePolicy
  -> target underlying position
  -> StrategyDecision
  -> OptionExecutionPlanner
  -> OrderIntent
  -> AccountHost
```

---

## 8. AccountHost 设计

### 8.1 职责

AccountHost 提供：

```text
唯一 AccessClient
clientOrderId / orderRef
订单状态机
账户/持仓快照
成交路由
账户对账
账户级风险
异步持久化
```

### 8.2 期权扩展

AccountHost 支持：

```text
期权合约元数据引用
期权持仓
期权订单
行权/到期/被行权
期权账户快照
期权保证金/账户风险
```

OptionManager 提供期权定价和 Greeks。

### 8.3 路由

注册：

```text
OptionManager TB
  strategyId（账户内唯一）
  accountId
  processInstanceId
```

同一账户可以有多个 OptionManager，每个注册不同的 `strategyId`。

AccountHost：

```text
strategyId -> event stream / process
```

订单：

```text
OrderIntent（字段见 8.4）
```

AccountHost：

```text
clientOrderId -> strategyId
```

成交：

```text
FillEvent:
  clientOrderId
  orderRef
  exchangeOrderId
  instrumentId
  qty
  price
  tradeId
```

AccountHost：

```text
clientOrderId -> strategyId -> OptionManager event stream
```

OptionManager：

```text
requestId -> legKey
clientOrderId -> legKey
```

`legKey`、strikePrice、optionType、Greeks 保存在 OptionManager。AccountHost 不接收 `legKey`，也不按腿路由。

### 8.4 OrderIntent

`OrderIntent` 是期货和期权共用的产品无关下单意图，AccountHost 只消费这个结构。

```text
OrderIntent
  strategyId
  requestId
  instrumentId
  side
  offset
  qty
  price
  orderType
  timeInForce
  expireTime
  hedgeFlag
```

| 字段 | 含义 |
|---|---|
| `strategyId` | OptionManager 的账户内唯一 key，不是内部 `OptionStrategy` 的 key |
| `requestId` | 幂等与本地归因键；OptionManager 用它映射到 `legKey` |
| `instrumentId` | 实际交易合约；期权就是具体期权合约 |
| `side` | `BUY` / `SELL` |
| `offset` | `OPEN` / `CLOSE` / `CLOSE_TODAY` / `CLOSE_YESTERDAY` |
| `qty` | 合约张数/手数，不是标的数量 |
| `price` | 每单位价格；期权是权利金单价，不是一张的总权利金 |
| `orderType` | `LIMIT` / `MARKET` |
| `timeInForce` | `DAY` / `IOC` / `FOK` / `GTD` |
| `expireTime` | 可选；`GTD` 时必填 |
| `hedgeFlag` | `SPECULATION` / `HEDGE` / `ARBITRAGE`；期货和期权都适用，默认由账户配置提供 |

`price` 对 `LIMIT` 必填，对 `MARKET` 忽略；`expireTime` 对 `GTD` 必填。

期货同样有 `hedgeFlag`，通常默认 `SPECULATION`；套保/套利需要相应权限。策略里的“对冲腿”和 `hedgeFlag=HEDGE` 不是同一个概念。

`OrderIntent` 不按期货/期权拆字段。品种差异只体现在：

```text
instrumentId
offset/orderType/timeInForce/hedgeFlag 的可用取值
行权/被行权 -> ExerciseIntent
组合单 -> 组合执行器
```

`OrderIntent` 不包含：

```text
clientOrderId
orderRef
legKey
strikePrice
optionType
expiryDate
Greeks
```

这些字段的归属：

- `clientOrderId`、`orderRef`：AccountHost/AccessClient 分配；
- `legKey`、strikePrice、optionType、expiryDate、Greeks：OptionManager 内部；
- 行权/被行权：独立的 `ExerciseIntent` 或生命周期事件，不是普通 `OrderIntent`；
- 组合单：拆成多条单腿 `OrderIntent`，或由独立的组合执行器表达。

适配层负责映射：

```text
offset      -> CTP CombOffsetFlag
orderType   -> CTP OrderPriceType
timeInForce -> CTP TimeCondition / VolumeCondition
expireTime  -> CTP ExpireTime（GTD）
hedgeFlag   -> CTP CombHedgeFlag
```

`MARKET` 的实际可用性由交易所/柜台决定；不支持的组合由 ExecutionPlanner 拒绝或降级，不能静默改写。

---

## 9. 订单时序

```text
OptionStrategy
  -> StrategyDecision
  -> OptionExecutionPlanner
  -> OptionManager
       记录 requestId -> legKey
  -> OrderIntent（字段见 8.4）
  -> AccountHost
       分配 clientOrderId
       创建 OrderState(SUBMITTING)
       返回 OrderAllocated(clientOrderId, requestId)
       放入 AccessClient 队列
  -> AccessClient.submit（异步）
  -> ORS
```

`OrderIntent.strategyId` 是 OptionManager 的账户内唯一 key，不是内部 `OptionStrategy` 的 key。
`OrderIntent` 不含 `legKey`，AccountHost 不感知腿。

`OrderAllocated`：

```text
只表示 clientOrderId 已分配
不表示 ORS 接受
不表示成交
```

OptionManager 收到后建立：

```text
requestId -> legKey
clientOrderId -> legKey
```

成交回传：

```text
AccountHost
  -> FillEvent
  -> OptionManager
       clientOrderId -> legKey
       更新 OptionPortfolio
       重算 OptionGreeks
```

---

## 10. 市场数据

### 10.1 每 TB 只读订阅

```text
OptionManager TB
  -> MarketDataClient
       underlying quotes
       option quotes of its own symbols
```

MarketDataClient：

- 只读；
- 不发布订单；
- 每个 TB 订阅自己需要的合约。

### 10.2 规模扩展：只读 OptionChainService

```text
OptionChainService
  -> 订阅行情
  -> 计算 IV/Greeks/theory
  -> 发布 OptionChainSnapshot
```

各 OptionManager 订阅。

它只提供数据，不持有策略仓位，不参与 AccountHost 路由。

---

## 11. 状态与恢复

### 11.1 状态归属

```text
AccountHost：
  订单/成交/账户仓位权威（账户级聚合）

OptionManager：
  期权组合/Greeks/策略状态（manager 级）
  本地 requestId -> legKey
  本地 clientOrderId -> legKey
```

对账关系：

```text
Σ OptionPortfolio positions by instrument
  + UNASSIGNED
  = AccountHost account position
```

`AccountHost` 持仓是账户级权威；`OptionPortfolio` 是 manager/腿级权威。两者不一致时 PAUSED，不能用一方自动覆盖另一方。

### 11.2 持久化

异步保存：

```text
option_leg
option_position
option_leg_order
option_strategy_state
last_fill_id
option_greeks_snapshot（可选）
```

热路径不查 DB。

`OptionPortfolio` 的主键是 `legKey`；`option_position` 不能只存 instrument 级净持仓，否则多条腿会合并。

### 11.3 恢复

```text
1. AccountHost 恢复订单/成交/账户
2. OptionManager TB 重新注册 strategyId
3. 恢复 option_leg / option_position / option_leg_order / last_fill_id
4. 重放 last_fill_id 之后的归属成交
5. 重算 Greeks
6. 与 AccountHost 按 instrument 对账
7. 不一致 -> PAUSED，只允许减仓/平仓
```

无法恢复 `clientOrderId -> legKey` 时，不能从 AccountHost 的账户净持仓反推腿归属，直接 PAUSED。

---

## 12. 风险模型

### 12.1 OptionManager

```text
Delta / Gamma / Vega limit
per-strike / expiry concentration
quote width / cross width
expiry / exercise risk
stale option market data
pricing invalid
hedge failure
```

### 12.2 AccountHost

```text
margin
max notional
max open orders
order rate
account net position
```

### 12.3 失败处理

```text
定价失败 -> 不报价
Greeks 无效 -> 不交易
腿映射失败 -> PAUSED
账户对账失败 -> 不 arm
```

---

## 13. 配置

### 13.1 分层

```text
AccountConfig
  broker / investor / ORS / account

OptionConfig
  option symbols / underlying / pricing params

StrategyConfig
  strategy type / indicators / quote/hedge/risk params
```

### 13.2 加载

```text
AccountHost 启动加载 AccountConfig
OptionManager TB 启动加载 OptionConfig/StrategyConfig
```

交易期间不热更新；重启生效。

### 13.3 校验

```text
每个启用期权有 OptionCatalog
每个指标有依赖
每个策略有执行计划
定价参数完整
Greeks 阈值有效
```

失败则不启动/不 arm。

---

## 14. 性能

```text
OptionManager 在 TB 进程内
期权链/Greeks/组合状态在内存
AccountHost 订单状态在内存
```

每个 TB 只计算自己订阅的期权和指标。

规模扩大时：

```text
只读 OptionChainService
  -> 计算一次链级 IV/Greeks
  -> 发布快照
```

OptionManager 只消费快照和自己的组合。

---

## 15. 故障模型

| 故障 | 影响 | 处理 |
|---|---|---|
| OptionManager 崩溃 | 该组合停单 | AccountHost 保留订单/仓位；重启注册/恢复；失败 PAUSED |
| AccountHost 崩溃 | 该账户停单 | 重启后订单/账户对账 |
| ORS 崩溃 | 该账户停交易 | 重连后持仓/Greeks 重建 |
| 定价失败 | 该期权不报价 | 不交易，保留仓位 |
| Greeks 无效 | 策略不交易 | 只允许风险减仓 |
| 腿映射失败 | 无法归属 | PAUSED/人工对账 |
| 账户净持仓不一致 | 账实不符 | fail closed |

---

## 16. 设计决策

| 决策 | 选择 |
|---|---|
| OptionManager 实例边界 | 1 TB = 1 OptionManager |
| 账户内 OptionManager 数量 | N >= 1，多 manager 是一等模型 |
| 架构范围 | 完整 OptionManager；策略/标的范围在实施阶段确定，不删组件、不降级账本 |
| `strategyId` 粒度 | 1 OptionManager = 1 个账户内唯一 `strategyId` |
| OptionManager 内部策略 | 共享 manager 的 `strategyId`，由 manager 本地映射 |
| 账户层 | AccountHost |
| AccessClient 归属 | AccountHost |
| 期权组合状态 | 每个 OptionManager 独立 |
| OptionPortfolio 主键 | `legKey` |
| `targetPositions` | `legKey -> targetQty` |
| Greeks | 每个 OptionManager 独立 |
| AccountHost 路由 | `clientOrderId -> strategyId` |
| AccountHost 腿可见性 | 不感知 `legKey` |
| OrderIntent | 产品无关；含 offset/orderType/timeInForce/hedgeFlag，不含 legKey |
| 期权腿映射 | OptionManager 内部 `requestId/clientOrderId -> legKey` |
| 行情 | MarketDataClient 只读订阅 |
| 大规模期权链 | 只读 OptionChainService |
| 账户级 Greeks | 只读聚合，不在订单路径 |

---

## 17. 验收标准

1. 一个 TB 只有一个 OptionManager 实例；一个账户可以有 N 个 OptionManager，N >= 1。
2. 两个 OptionManager 的仓位/Greeks 互不影响。
3. 每个 OptionManager 一个账户内唯一 `strategyId`；AccountHost 按该 key 路由，不感知内部 `OptionStrategy`。
4. OptionManager 通过 `OrderGatewayClient` 提交 `OrderIntent`。
5. 成交回到正确的 OptionManager。
6. 定价引擎测试向量输出一致。
7. 定价失败/Greeks 无效时不报价。
8. OptionManager 重启后能恢复 `clientOrderId -> legKey`，否则 PAUSED。
9. 多 OptionManager 共享账户时，账户净持仓/对账正确。
10. 账户级风险与策略级 Greeks 风险分别生效。
11. OptionPortfolio 按 `legKey` 记账，按 instrument 聚合后能与 AccountHost 对账。
12. 同一个 instrument 在不同策略/腿中出现时，持仓、PnL 和 Greeks 不串账。
13. OrderIntent 包含产品无关执行字段（`offset/orderType/timeInForce/hedgeFlag`）；`legKey` 不进入 OrderIntent。

---

## 18. 开放问题

1. ORS/CTP 期权行情与报单能力。
2. 同一 OptionManager 内多个 `OptionStrategy` 的目标仓位冲突如何裁决。
3. 行权/到期/被行权归属。
4. 期权保证金/组合保证金如何进 AccountHost。
5. 多 OptionManager 是否需要账户级净 Greeks。
6. OptionChainService 的引入时机。
7. OptionQuotingStrategy 的 quote/bias/hedge 参数配置格式。

---

## 19. 一句话

```text
OptionManager 是每个 OptionManager TB 进程内的期权组合编排器；
1 TB = 1 OptionManager；
1 OptionManager = 1 个账户内唯一 strategyId；
AccountHost 统一账户订单/对账；
期权定价、Greeks、策略、执行分层；
AccountHost 只按 strategyId 路由，OptionManager 自己维护期权腿映射。
```

---

## 附录 A：与 146 的逐组件对照

本附录记录 146 的实现事实，作为正文边界设计的证据；新系统定义以正文为准。146 是参照实现，不是兼容目标。

### A.1 总览

| 新系统组件 | 146 对应物 | 146 实现事实 | 新系统边界 |
|---|---|---|---|
| `OptionManager` | `OptionManager` 单例 | 一个进程内全局实例，所有策略共享 | 1 TB 一个实例，组合级编排器 |
| `OptionCatalog` | `m_optionMap` / `m_underlyingMap` | 运行时 `Option*` 对象注册表 | 只读合约目录，运行时状态分离 |
| `OptionPricingEngine` | `TradeBot::Option` 定价方法 + `IVSurface` | 定价、IV、Greeks 分散在 Option/Indicator/Surface | 纯计算引擎，单一实现 |
| `OptionPortfolio` | 无 | 遍历全局策略，读 `ExecutionStrategy::m_netpos` | 每 OptionManager 一份，`legKey` 主键，成交驱动 |
| `OptionGreeks` | `m_portDelta/m_portVega/m_portGamma` | 全局字段，跨策略累加 | 每 OptionManager 一份快照 |
| `OptionIndicators` | `OptionsGreek`、`OptionPrice`、`IV`、`IVSurface` | 指标绑定 `Option*`，部分指标直接改 `modelIV` | IndicatorEngine 输出只读快照 |
| `OptionStrategy` | `OptionQuotingStrategy`、`HedgingStrategy`、`SimpleHedgingStrategy` | 策略继承 `ExecutionStrategy`，直接算价、直接发单 | 只输出 `StrategyDecision` |
| `OptionBiasPolicy` | `SetBiasParameters` + 策略内本地计算 | 全局写回所有策略；报价策略又算一套 | 策略内纯函数，只有一套公式 |
| `OptionHedgePolicy` | `SetHedgingParameters` + 两个全局队列 | 全局队列存 `SimConfig*`，对冲策略消费 | 每组合对冲策略，输出目标仓位 |
| `OptionExecutionPlanner` | 无 | `OptionQuotingStrategy::SendOrder` 自己算并直接发单 | `StrategyDecision -> OrderIntent` |
| `OptionRisk` | 无独立组件 | 阈值散落在 OptionManager 和 ExecutionStrategy | 独立预交易风险层 |
| `AccountHost` | 无 | 订单状态在 `ExecutionStrategy` 自己身上 | 账户订单/对账唯一权威 |

### A.2 逐组件差异

#### A.2.1 `OptionManager`

146：

- `common/include/OptionManager.h:31-53`：`GetInstance()` 懒加载单例。
- `common/include/OptionManager.h:77-172`：大量 public 字段，同时承载组合 Greeks、报价宽度、hedge 阈值、IV 参数、队列和日志时间。
- `common/OptionManager.cpp:7-81`：构造函数直接加载全局 `OptionsParams`。
- 一个 TradeBot 进程内所有策略共享同一个实例。

新系统：

- `1 TB = 1 OptionManager`。
- 只做组合编排；不持有 AccessClient，不持有订单状态。
- 组合、Greeks、指标、策略、执行计划分别有边界。

差异本质：146 是进程级 god object；新系统是组合级编排器。

#### A.2.2 `OptionCatalog`

146：

- `common/include/OptionManager.h:77-78`：`m_optionMap`、`m_underlyingMap`。
- `main/TradeBotUtils.cpp:310-345`：`AddOption()` / `AddUnderlying()` 把 `TradeBot::Option*` 插入全局 map。
- `Indicators/include/Option.h:105-180`：`TradeBot::Option` 同时保存合约字段、`parity`、`modelIV`、`surfaceIV`、`bsPx`、`m_deltaPos`、`m_vegaPos`、`stratParams`。

新系统：

- `OptionCatalog` 只读：合约、expiryDate、strikePrice、optionType、乘数、tick、exerciseStyle。
- 定价状态、IV、Greeks、仓位贡献不进入 Catalog。

差异本质：146 的 `m_optionMap` 是可变对象注册表，不是合约目录。

#### A.2.3 `OptionPricingEngine`

146：

- `Indicators/include/Option.h:149-168`：`BSPrice()`、`BlackSchole()`、`BinomialTree()`、`BSVol()`、`NewtonMethod()`、`BisectionMethod()`、`updateGreeks()` 都是 `Option` 成员函数。
- `Indicators/Option.cpp:346-450`、`:810-852`：定价和 Greeks 实现直接读 `Option` 成员状态。
- `Indicators/include/IVSurface.h:66-79`：`IVSurface` 是全局单例。
- `Indicators/OptionPrice.cpp:16-45`：又创建一个 `ImpliedVol`。
- `Indicators/IV.cpp:50-130`、`:183-215`：IV 指标直接修改 `option->modelIV` 和 `isModelVolValid`。

新系统：

- 纯函数、无状态、无策略依赖、无全局配置读取。
- 一个定价实现，输出 price/IV/delta/gamma/vega/theta。
- 指标和策略只消费结果。

差异本质：146 的定价是“成员函数 + 全局单例 + 指标各算一套”；新系统是单一纯计算引擎。

#### A.2.4 `OptionPortfolio`

146：

- 没有 `OptionPortfolio` 类。
- `common/OptionManager.cpp:123-170`：`PortfolioGreeks()` 遍历 `ConfigParams::m_baseConfigMap`。
- `Strategies/include/ExecutionStrategy.h:135-148`：仓位来自 `m_netpos`，PnL 来自 `m_netPNL`。
- `Indicators/include/Option.h:177-178`：`m_deltaPos`、`m_vegaPos` 又缓存在 `Option` 对象上。

新系统：

- 每个 OptionManager 一份组合账本。
- `FillEvent` 驱动，维护期权腿、对冲腿、均价、已实现/未实现 PnL。
- 不从其他策略对象反向拼组合。

差异本质：146 的组合是全局循环投影；新系统是独立账本。

#### A.2.5 `OptionGreeks`

146：

- `common/include/OptionManager.h:80-84`：`m_openDelta`、`m_portDelta`、`m_portGamma`、`m_portVega`、`m_portPnl` 都是全局字段。
- `common/OptionManager.cpp:130-135`：`PortfolioGreeks()` 重置 delta/vega/pnl，没有重置 `m_portGamma`。
- `common/OptionManager.cpp:216-246`：`PortfolioDelta()`、`PortfolioGamma()`、`PortfolioVega()` 是累加式，没有先清零。
- `m_portGamma` 在 `PortfolioGreeks()` 中没有完整计算路径。
- 所有策略共享同一组 Greeks。

新系统：

- 每个 OptionManager 独立 `OptionGreeksSnapshot`。
- snapshot 生成前显式清零；一次行情/成交周期对应一个不可变快照。
- 组合 Greeks 不跨策略共享。

差异本质：146 是全局累加缓存；新系统是每组合快照。

#### A.2.6 `OptionIndicators`

146：

- `Indicators/OptionsGreek.cpp:12-77`：指标持有 `Option*`，直接从 Option 取 delta/IV/gamma/theta/rho/vega。
- `Indicators/OptionPrice.cpp:16-45`：指标自己创建 `ImpliedVol`。
- `Indicators/IV.cpp`：指标直接修改 `modelIV` 和 `isModelVolValid`。
- `Indicators/include/IVSurface.h:66-79`：`IVSurface` 是全局单例。
- `main/TradeBotUtils.cpp:1027-1045`：指标实例放进全局 `m_indArr`。
- `main/CommonClient.cpp:630-660`：标的 tick 到来时遍历全局 `m_optionMap`，对所有期权调用 `QuoteUpdate/TickUpdate`。

新系统：

- `IndicatorEngine -> IndicatorSnapshot`。
- 指标只输出数值，不修改 Option，不修改策略。
- 策略按需订阅指标。
- 市场指标与组合指标分开。

差异本质：146 的指标与期权对象、定价状态、全局配置强耦合；新系统是指标快照。

#### A.2.7 `OptionStrategy`

146：

- `main/main.cpp:794-801`：`TB_OPTION_QUOTING_STRAT`、`TB_HEDGING_STRAT`、`TB_SIMPLEHEDGING_STRAT` 分别创建策略对象。
- `Strategies/OptionQuotingStrategy.cpp:35-402`：`SendOrder()` 完成目标价、quote width、delta/vega bias、tick 取整、订单过滤，然后直接 `SendBidOrder()` / `SendAskOrder()`。
- `Strategies/SimpleHedgingStrategy.cpp:9-43`：直接读全局 `m_portDelta`，直接 `SendNewOrder()`。
- `Strategies/HedgingStrategy.cpp:8-178`：遍历全局策略配置，直接对其他策略的标的发对冲单。
- `Strategies/include/ExecutionStrategy.h:225-233`：策略自己持有 `m_ordMap/m_bidMap/m_askMap/m_account`。

新系统：

- `OptionStrategy` 只输出 `StrategyDecision`。
- 不拥有订单 map，不发单，不改其他策略状态。
- 决策结果包含目标仓位、quote hints、urgency。

差异本质：146 的策略是“决策 + 执行 + 订单状态”三合一；新系统是纯决策层。

#### A.2.8 `OptionBiasPolicy`

146：

- `common/OptionManager.cpp:298-340`：`SetBiasParameters()` 遍历所有期权策略，写回 `m_deltaBias`、`m_vegaBias`、`m_positionBias`、`totalBiasAdj`。
- 使用全局 `m_portDelta/m_portVega`，做 `maxDeltaAdj/maxVegaAdj` 截断。
- 源码中调用点基本被注释：
  - `main/CommonClient.cpp:649-650`
  - `main/CommonClient.cpp:678-679`
  - `main/CommonClient.cpp:707-708`
  - `Strategies/ExecutionStrategy.cpp:1990-1991`
- `Strategies/OptionQuotingStrategy.cpp:106-118` 自己又算了一套 `deltaBias/vegaBias/posBias/totalBias`。

新系统：

- `OptionBiasPolicy` 是策略内纯函数：`OptionGreeksSnapshot + config -> bias`。
- 只影响当前策略。
- 只有一套公式。

差异本质：146 存在“全局写回版”和“策略本地版”两套，且全局版调用链不完整；新系统只保留策略内纯函数。

#### A.2.9 `OptionHedgePolicy`

146：

- `common/OptionManager.cpp:342-462`：`SetHedgingParameters()` 构建全局 `hedgeScoreQueue`、`iocScoreQueue`，元素存 `SimConfig*`。
- `Strategies/HedgingStrategy.cpp:68-178`：消费这两个全局队列，按 `m_portDelta + m_openDelta` 和阈值发对冲单。
- `common/OptionManager.cpp:110-122`：`GetHedgingStrategy()` 选第一个非期权配置作为全局 `hedgeStrategy`。
- `SetHedgingParameters()` 在源码中没有未注释的调用点；`Strategies/HedgingStrategy.cpp:22` 也是注释掉的。
- `Strategies/SimpleHedgingStrategy.cpp:9-43`：使用 `m_portDelta + 自身 m_netpos`，超过阈值直接发单。

新系统：

- `OptionHedgePolicy` 输出目标对冲仓位。
- 队列、评分、选择对冲标的都在当前 OptionManager 内完成。
- 不存全局 `SimConfig*`，不跨策略选标的。
- 对冲执行交给 `OptionExecutionPlanner -> AccountHost`。

差异本质：146 的对冲路径依赖全局队列，且队列生产者未接通；新系统是每组合策略。

#### A.2.10 `OptionExecutionPlanner`

146：

- 没有这个组件。
- `Strategies/OptionQuotingStrategy.cpp:35-402`：从目标价一直做到发单。
- `Strategies/include/ExecutionStrategy.h:35-37`：基类提供 `SendNewOrder/SendCancelOrder`。
- `Strategies/include/ExecutionStrategy.h:225-233`：订单状态在策略自己身上。
- `Strategies/HedgingStrategy.cpp:226`、`:255`、`:298`：对冲策略直接调用 `SendNewOrder()`。

新系统：

- `StrategyDecision -> OptionExecutionPlanner -> OrderIntent -> AccountHost`。
- Planner 负责 quote width、cross width、hedge urgency、最大 quote level。
- AccountHost 负责 `clientOrderId`、orderRef、订单状态、账户对账。
- OptionManager 只维护 `clientOrderId -> legKey`。

差异本质：146 把决策和执行压在一个策略对象里；新系统把 `OrderIntent` 作为唯一下单边界。

#### A.2.11 `OptionRisk`

146：

- 没有 `OptionRisk` 组件。
- `common/include/OptionManager.h:86-172` 散落：
  - `deltaHedgeThreshold`
  - `iocHedgeThreshold`
  - `maxDeltaAdj/maxVegaAdj`
  - `minDeltaToTrade/maxDeltaToTrade`
  - `strikeStopLoss`
  - `maxQtyPerSymbol`
  - `maxQuoteLevel`
- `Strategies/ExecutionStrategy.cpp:17`、`:57-70`：通用风险阈值 `MAX_POS_SIZE`、`MAX_LOSS`、`STOP_LOSS`、`NOTIONAL_MAX_SIZE`、`MAX_PRICE/MIN_PRICE`。
- `Strategies/ExecutionStrategy.cpp:2073-2146`：期权路径检查 delta 范围、`isModelVolValid`、strike stop loss。
- 账户级期权保证金、行权/到期风险没有进入 OptionManager。

新系统：

- `OptionRisk`：策略级 delta/gamma/vega、集中度、到期、定价有效性。
- AccountHost：账户级保证金、名义金额、未成交订单、下单频率、账户净持仓。
- 失败关闭：定价无效不报价，Greeks 无效不交易，腿映射失败 PAUSED。

差异本质：146 的风险是“参数 + 策略内 if”；新系统是独立预交易风险层。

#### A.2.12 `AccountHost`

146：

- 没有 AccountHost。
- `Strategies/include/ExecutionStrategy.h:225-233`：订单状态和账户字段都在策略对象上。
- `Strategies/include/ExecutionStrategy.h:35-37`：策略直接调用 `SendNewOrder()/SendCancelOrder()`。
- `common/include/OptionManager.h` 没有订单字段，OptionManager 不知道订单、成交、`clientOrderId`。
- 没有 `clientOrderId -> strategyId`，也没有 `clientOrderId -> option leg`。

新系统：

- AccountHost 唯一持有 AccessClient。
- `clientOrderId -> strategyId` 由 AccountHost 维护。
- OptionManager 内部维护 `clientOrderId -> legKey`。
- 成交按 `strategyId` 回到正确的 OptionManager。

差异本质：146 的订单归属在策略；新系统的订单归属在账户层，期权腿语义在 OptionManager。

### A.3 跨组件结论

1. 146 实际只有三个大边界：

```text
OptionManager 单例
  ├─ 全局 Option 对象图
  └─ 全局 Greeks / 队列 / 配置
ExecutionStrategy
  ├─ 决策
  ├─ 订单状态
  └─ 直接发单
```

2. 146 的“组合”是全局循环投影。`PortfolioGreeks()` 遍历 `m_baseConfigMap`，读每个 `ExecutionStrategy` 的 `m_netpos/m_netPNL`，没有 per-manager 仓位账本。

3. 146 的定价、IV、指标互相写。`Option` 自己定价，`IV`/`IVSurface` 改 `modelIV`，`OptionPrice` 又创建自己的 `ImpliedVol`，策略直接读 `Option::GetDelta/GetVega`。

4. 146 的 Bias/Hedge 源码路径不完整。`SetBiasParameters()` 和 `SetHedgingParameters()` 没有未注释的调用点；报价策略另算一套 bias；对冲策略依赖的全局队列没有生产者。

5. 146 没有账户级订单权威。订单状态在 `ExecutionStrategy` 自己身上，OptionManager 不参与订单路由和成交归属。

6. 146 的风险检查散落在 `OptionManager` 字段和 `ExecutionStrategy` 阈值里，没有独立期权风险引擎，也没有账户级期权保证金/行权风险承接。

### A.4 可参考与不复用

可参考的 146 实现：

- BS/Binomial/IV/Greeks 数学公式；
- `OptionQuotingStrategy` 的 quote width、delta/vega bias、hedge edge 计算；
- `SimpleHedgingStrategy` 的 delta 阈值思路；
- `strikeStopLoss`、`minDeltaToTrade/maxDeltaToTrade` 等参数语义；
- 作为 `OptionPricingEngine` 的测试向量来源。

只作为 146 事实、不进入新系统结构的部分：

- `OptionManager::GetInstance()`；
- 全局 `m_portDelta/m_portVega/m_portGamma`；
- 全局 `hedgeScoreQueue/iocScoreQueue`；
- `Option` 对象同时承担合约、定价、IV、仓位缓存；
- 策略直接 `SendNewOrder()`；
- 策略之间互相写 `m_deltaBias/m_hedgeBid`；
- 遍历全局 `m_baseConfigMap` 计算组合。

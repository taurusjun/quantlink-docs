# GUI 数据与控制面

- 日期：2026-11-22
- 状态：DRAFT（设计文档，未写代码）
- 范围：GUI 所需的只读数据、策略状态、策略控制、手工单和跨机接入；不改变交易运行时
- 不含：PyBot。PyBot 是 `quantlink-trading` / tbadmin 的扩展，146 没有；不进入 205
- 关联：`201-tb-ipc-model.md`、`202-trading-channel-and-routing.md`、`203-configuration.md`、`204-strategy-runtime-and-optionmanager.md`、`206-contract-catalog.md`

---

## 1. 定位

交易运行时只负责：

```text
StrategyRuntime
  -> TradeBotOrderGateway
    -> TradingChannel
      -> COMMAND IPC

MarketDataChannel
  -> MarketDataRouter
    -> StrategyRuntime
```

GUI 数据/控制面是另一个平面：

```text
Trading Plane
  StrategyRuntime / TradingChannel / MarketDataChannel

Observability Plane
  Fact -> ReadModel

Control Plane
  GUI -> BotGateway -> Control / ManualOrder
```

GUI 不直接访问：

```text
EXECUTION
STATE
VENUE_SESSION
MARKET_DATA
TradingChannel
StrategyRuntime
```

GUI 只访问：

```text
BotGateway
```

---

## 2. 三个平面

```text
┌──────────────────── TradeBot 交易运行时 ────────────────────┐
│                                                             │
│  StrategyRuntime -> TradeBotOrderGateway -> TradingChannel  │
│                                      │                      │
│                                      ├─ OrderFact           │
│                                      ├─ TradeFact           │
│                                      └─ STATE / SESSION     │
│                                                             │
│  MarketDataChannel -> MarketDataFact                        │
│  StrategyRuntime -> StrategyStatusFact                      │
│  StrategyRuntime / TradingChannel -> OperationalEventFact   │
│                                                             │
└──────────────────────────┬──────────────────────────────────┘
                           │ facts
                           ▼
┌──────────────────── Observability Plane ────────────────────┐
│                                                             │
│  OrderReadModel      TradeReadModel                         │
│  PositionReadModel   PnlReadModel                           │
│  StrategyStatusReadModel   MarketDataReadModel              │
│  AccountSnapshotReadModel   OperationalReadModel            │
│                                                             │
└──────────────────────────┬──────────────────────────────────┘
                           │ query / subscribe
                           ▼
┌──────────────────────── BotGateway ──────────────────────────┐
│  WebSocket / HTTP / gRPC                                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
                          GUI

GUI ── command ──> BotGateway
                    ├─ StrategyControlService -> StrategyRuntime
                    └─ ManualOrderService -> TradeBotOrderGateway
```

`BotGateway` 不是 `TradeBotOrderGateway`：

```text
BotGateway          GUI 数据/控制入口
TradeBotOrderGateway 交易订单路由
```

---

## 3. 交易事实

事实是不可变的只读记录，由交易运行时发布。

### 3.0 `FactEnvelope`

所有事实共用的技术信封：

```text
tbId
agentId
streamId
seq
factId
schemaVersion
occurredAt
```

用途：

```text
多 TB / Agent 聚合
去重
断线续传
恢复
审计定位
```

下面的 Fact 只列 payload；实现和传输时必须带 `FactEnvelope`。

`strategyId` 是 TB 启动配置指定的数字实例 ID，TB 内唯一；全局身份是 `(tbId, strategyId)`。`strategyName` 只用于显示。`accountId` 来自策略配置的 146 `ACCOUNT`，不是路由键。`StrategyStatusFact.instanceId` 是进程运行实例 ID，不是策略身份。

### 3.0.1 `ContractCatalog` / `OptionCatalog`（只读参考，不是 Fact）

`ContractKey` 只做身份；`expiryDate / strikePrice / optionType / underlying` 不在 Fact 里。

统一由 `206-contract-catalog.md` 定义：

```text
ContractCatalogEntry
  contractKey
  exchange
  instrumentId
  symbol
  instrumentName
  instrumentType
  currency
  multiplier
  tickSize
  expiryDate?
  strikePrice?
  optionType?
  underlyingContractKey?
  underlyingSymbol?
  exerciseStyle?
  catalogVersion
  updatedAt
  source
```

```text
OptionCatalogEntry
  contractKey
  exchange
  underlyingContractKey?
  underlyingSymbol
  expiryDate
  strikePrice
  optionType
  exerciseStyle
  multiplier
  tickSize
  catalogVersion
  updatedAt
  source
```

规则：

```text
OptionCatalog 是 ContractCatalog 的 Option 投影
OrderFact / TradeFact 只带 contractKey
读模型需要时 join ContractCatalog / OptionCatalog
ContractRoute / MarketDataRoute 不携带元数据
```

### 3.1 `OrderFact`

```text
strategyId?       手工单可空
clientOrderId
intentId
commandId?        手工单/控制命令关联

contractKey
tradingChannelKey
channelEpoch
exchange

orderRef
exchangeOrderId

positionEffect    OPEN / CLOSE / UNKNOWN
sysId?
errorCode?
exchangeTradeId?

orderSource       STRATEGY | MANUAL
operator          手工单才有

side
orderType
price
quantity
disclosedQuantity
filledQuantity
status

createdAt
updatedAt
lastTradedAt
```

注意：

```text
OrderFact 不包含 accountId
策略单的 accountId 由 strategyId 对应的策略配置 join
手工单的 accountId 由 commandId 对应的 ManualOrderCommand join
accountId 不进入 TB 交易路由
exchangeSource 由 tradingChannelKey / contractKey.exchange 提供
orderSource 才是 STRATEGY | MANUAL
positionEffect / sysId / errorCode / exchangeTradeId 是 venue/OMS 技术字段，不参与路由
```

订单状态权威仍然是 `TradingChannel.OrderRegistry`。

### 3.2 `TradeFact`

```text
tradeId

strategyId?       手工单可空
clientOrderId
contractKey
tradingChannelKey
channelEpoch

side
positionEffect    OPEN / CLOSE / UNKNOWN
lastQty
lastPrice
fee
currency
sysId?
exchangeTradeId?
```

### 3.3 `PositionSnapshot`

```text
snapshotId
accountId
contractKey
tradingChannelKey

quantity
averagePrice
netBuyQty
netSellQty
netBuyValue
netSellValue

asOf
```

### 3.4 `AccountSnapshot`

```text
snapshotId
accountId
exchange
brokerId
investorId
environment

balances
margin
available
asOf
```

### 3.5 `StrategyStatusFact`

替代 146 ZMQ 的策略状态/心跳/参数/FairValue 回传。

```text
strategyId
strategyName
instanceId

product
strategyType
modelFile?
server?

state          CREATED / STARTING / RUNNING / PAUSED / FAILED / STOPPED
health         OK / DEGRADED / DATA_LAG
heartbeatAt
updatedAt
reason
paramVersion

active         bool
running        bool
onExit         bool
onCancel       bool
onFlat         bool

alert?
alertAt?

bidExlim
bidSize
bidEdge
bidSlope
bidLean
bidPrice
bidFills
bidStatus

askExlim
askSize
askEdge
askSlope
askLean
askPrice
askFills
askStatus

fairValue
fvma
impliedBidFairValue
impliedAskFairValue
fvMidAverage
fvMidAverageStatus
```

`product / strategyType / modelFile / server` 来自策略配置/部署元数据；`active / running / onExit / onCancel / onFlat` 来自 StrategyRuntime；`alert / alertAt` 来自当前策略告警状态。

`Lock` 不放进策略运行时；它是 GUI/操作员级状态，见 `UiLockState`。

### 3.6 `MarketDataFact`

`MarketDataFact` 只表示原始行情事实，不包含 `orderIndication`。

```text
FactEnvelope

contractKey
exchange
marketDataChannelKey

updateType          SNAPSHOT
feedType

validBidLevels      u8
validAskLevels      u8

bidLevels[20]       BookLevel
askLevels[20]       BookLevel

lastTradedPrice
lastTradedQuantity
lastTradedTime

totalTradedQuantity
totalTradedValue
yield

exchangeTimestamp
```

```text
BookLevel =
  price       fixed-point / decimal
  quantity    i64
  orderCount  i32
```

规则：

```text
固定 20 档，按最优价到最差价排列
无效档 price=0 / quantity=0 / orderCount=0
validBidLevels / validAskLevels 表示有效档数
当前只做 SNAPSHOT；DELTA 保留但不实现
一个 ContractKey 只有一个行情来源
暂不引入 dataSourceId
```

#### 3.6.1 `MarketDataIndication`（派生视图）

`orderIndication` 不属于行情事实。它由当前 working orders 和盘口价格派生：

```text
MarketDataIndication
  factId
  contractKey
  marketDataChannelKey
  accountId

  bidOrderPresent[20]   bool
  askOrderPresent[20]   bool

  asOf
```

来源：

```text
OrderReadModel
  + MarketDataFact
    -> OrderIndicationService
      -> MarketDataIndication
```

它只用于 GUI 盘口着色/提示，不进入原始行情事实，也不从 venue 行情直接取得。

### 3.7 `OperationalEventFact`

```text
eventId

severity          INFO / WARN / ERROR
source            STRATEGY / CHANNEL / GATEWAY / MANUAL
strategyId?
tradingChannelKey?
commandId?
action?
ackStatus?
code
message
operator?
```

用于：

```text
Console
错误/告警
控制命令审计
手工单审计
```

### 3.8 `StrategyTelemetryFact`

承接 tbadmin 的 `key / value / info` 通用遥测，避免把任意指标塞进 `StrategyStatusFact`。

```text
strategyId
key
value
info
occurredAt
source        STRATEGY / GATEWAY
```

规则：

```text
按 strategyId + key 归并
高频值由 LocalAgent/BotGateway 合并
不作为交易事实
不进入订单/成交/持仓 key
```

### 3.9 `SpreadTradeFact`

Pair/Spread 成交使用结构化事实，不从 `Trade2` 文本解析。

```text
spreadTradeId
strategyId
legAContractKey
legBContractKey
side
quantity
spread
tradedAt
source
```

---

## 4. 读模型

读模型只读、可重建、可丢弃，不能反写交易状态。

多 TB 聚合时，读模型 key 带 `tbId`；`strategyId` 只在 TB 内唯一，不能跨 TB 直接当全局唯一 ID。

| 读模型 | 来源 | GUI 用途 |
|---|---|---|
| `OrderReadModel` | `OrderFact` + `ContractCatalog` | 挂单、历史订单、状态 |
| `TradeReadModel` | `TradeFact` | 成交列表 |
| `PositionReadModel` | `PositionSnapshot` / `TradeFact` + `ContractCatalog` + `OrderFact` | 账户/策略持仓 |
| `PnlReadModel` | `TradeFact` + 快照 + 行情 + `ContractCatalog` | 已实现/未实现 PnL |
| `StrategyPnlReadModel` | `TradeFact` + 快照 + 行情 + `ContractCatalog` | 策略级 PnL |
| `StrategyPositionReadModel` | `TradeFact` + `ContractCatalog` | 策略/腿仓位 |
| `SpreadReadModel` | `SpreadTradeFact` + `ContractCatalog` | Pair/Spread 成交 |
| `OptionDeltaReadModel` | `OptionCatalog` + 持仓 + 行情 | 期权 Delta/Greeks |
| `StrategyTelemetryReadModel` | `StrategyTelemetryFact` | 最新 key/value/info |
| `StrategyStatusReadModel` | `StrategyStatusFact` + `UiLockState` | 策略状态、心跳、参数、FairValue |
| `MarketDataReadModel` | `MarketDataFact` + `MarketDataIndication` | 行情查询/订阅/盘口 |
| `AccountSnapshotReadModel` | `AccountSnapshot` | 账户/保证金视图 |
| `OperationalReadModel` | `OperationalEventFact` | Console/告警/审计 |

### 4.1 `OrderReadModel`

在 `OrderFact` 基础上补齐 GUI 列：

```text
accountId
symbol
instrumentName
optionType
strikePrice
expiryDate
underlyingContractKey?
underlyingSymbol?
exchange
orderSource
exchangeSource

positionEffect
sysId?
errorCode?
exchangeTradeId?
```

账户标识：

```text
accountId
```

`accountId` 来自 146 的 `ACCOUNT` / `m_account` / `m_reqMsg.AccountID` / `NetPnlInfo.m_accountId`，不由 channel 推导，也不进入 `OrderFact` 或交易路由。

### 4.1.1 `TradeReadModel`

```text
strategyId
accountId
contractKey
tradeId

side
positionEffect    OPEN / CLOSE / UNKNOWN
lastQty
lastPrice
fee
currency
sysId?
exchangeTradeId?
tradedAt
```

`product / modelFile` 按 `strategyId` join 策略元数据，不复制进 `TradeFact`。

### 4.2 `PnlReadModel`

每条 key：

```text
accountId + contractKey
```

字段：

```text
symbol
instrumentName
exchange
optionType
strikePrice
expiryDate
underlyingContractKey?
underlyingSymbol?

netQuantity
netPnl
yield
lastTradedPrice
lastTradedTime
tradePercent

realizedPnl
unrealizedPnl
fees

netBuyQty
netSellQty
netBuyValue
netSellValue
netValue
netExposure

oneMinPnl
fiveMinPnl
tenMinPnl

oneMinDiff
fiveMinDiff
tenMinDiff

overnightNetExposure
overnightPnl
intradayPnl

asOf
```

PnL 保留 146 的全量字段，不删列；当前 key 不包含 `strategyId`，同一 account + contract 下多策略会合并 PnL。

### 4.2.1 `PositionReadModel`

每个 `accountId + contractKey` 一条，字段保留 146 Position 列：

```text
accountId
contractKey
strategyId?       用于策略仓位视图
tradingChannelKey
optionType?
strikePrice?
expiryDate?
underlyingContractKey?
underlyingSymbol?

avgBuy
netBuyQty
avgSell
netSellQty
netPosition

orderCount
cancelCount

group
mult
fees
pnl

asOf
```

`orderCount / cancelCount` 对应 tbadmin 的 `CXLRio = cancelCount / orderCount`；由 `OrderFact` 的订单/撤单事件聚合，不从仓位快照猜。

`group / mult / fees` 是 146 PositionModel 的 GUI 编辑字段，不要求持久化；策略仓位可由 `TradeFact` 推导，账户仓位以 `PositionSnapshot` 为基线。

`optionType / strikePrice / expiryDate / underlying*` 的权威来源是 `206-contract-catalog.md`；读模型只做 join，不复制成第二套事实。

### 4.2.2 `StrategyPnlReadModel`

当前 `PnlReadModel` 的 key 是 `accountId + contractKey`，不包含 strategy，因此多策略会合并。策略级 PnL 单独建读模型：

```text
strategyId
accountId
contractKey

symbol
instrumentName
product
strategyType
modelFile
underlyingContractKey?
underlyingSymbol?

netPnl
realizedPnl
unrealizedPnl
fees

asOf
```

来源：

```text
TradeFact
  + PositionSnapshot
  + MarketDataFact
  + ContractCatalog
    -> StrategyPnlReadModel
```

规则：

```text
不改变 PnlReadModel 的 key
StrategyPnlReadModel 只是按 strategyId 的派生视图
```

### 4.2.3 `StrategyPositionReadModel`

Pair/Option 的腿必须能区分，不能只按 account + contract 合并：

```text
strategyId
accountId
legIndex
legRole          PRIMARY / HEDGE / OPTION / UNDERLYING
contractKey
optionType?
strikePrice?
expiryDate?
underlyingContractKey?
underlyingSymbol?

netQuantity
avgPrice
netBuyQty
netSellQty
realizedPnl
fees

asOf
```

来源：

```text
TradeFact
  + ContractCatalog
    -> StrategyPositionReadModel
```

### 4.2.4 `SpreadReadModel`

```text
spreadTradeId
strategyId
legAContractKey
legBContractKey
symbolA
symbolB
side
quantity
spread
tradedAt
source
```

来源：

```text
SpreadTradeFact
  + ContractCatalog
    -> SpreadReadModel
```

### 4.2.5 `OptionDeltaReadModel`

期权 Delta 不在 `ContractCatalog`，也不应沿用 tbadmin 的本地常量计算。

```text
contractKey
underlyingContractKey?
underlyingSymbol
underlyingPrice

expiryDate
strikePrice
optionType
volatility

delta
position
symbolDelta
groupDelta

asOf
source
```

来源：

```text
OptionCatalog
  + PositionReadModel
  + MarketDataFact
    -> OptionGreeksService
      -> OptionDeltaReadModel
```

### 4.2.6 `StrategyTelemetryReadModel`

每个 `strategyId + key` 保留最新值：

```text
strategyId
key
value
info
occurredAt
source
```

用于替代 tbadmin 策略表里的 `key / val / info` 三列。

### 4.3 `StrategyStatusReadModel`

```text
StrategyStatusFact
  + uiLockState
```

`uiLockState` 来自 BotGateway，不是 StrategyRuntime：

```text
locked
operator
updatedAt
```

粒度：

```text
strategyId + operator
```

只影响 GUI 操作，不改变 `StrategyRuntime.enableFlag`。

发布频率：

```text
heartbeat 3s
state/params/fills 事件驱动
FairValue/quote 100–200ms 合并
```

### 4.4 `MarketDataReadModel` / `MarketDataSnapshot`

GUI 使用合并视图，不拼接原始 Fact：

```text
MarketDataSnapshot
  contractKey
  marketDataChannelKey

  bidLevels[20]          BookLevel
  askLevels[20]          BookLevel
  bidOrderPresent[20]    bool
  askOrderPresent[20]    bool

  lastTradedPrice
  lastTradedQuantity
  lastTradedTime

  totalTradedQuantity
  totalTradedValue
  yield

  asOf
```

组成：

```text
MarketDataFact       原始 20 档行情
MarketDataIndication working orders 的档位占用
      -> MarketDataSnapshot
```

GUI 查询盘口时不再直接读 `MARKET_DATA` IPC。

### 4.5 `OperationalReadModel`

保存：

```text
Console
错误/告警
策略控制审计
手工单审计
```

---

## 5. PnLService

`PnlService` 需要：

```text
TradeFact
PositionSnapshot / AccountSnapshot
MarketDataFact
fee schedule
```

输出：

```text
realizedPnl
unrealizedPnl
fees
netPnl
yield
tradePercent
1/5/10 分钟快照
overnight/intraday
net exposure
```

`PnlService` 不从 `AccountSnapshot` 直接复制 PnL；账户快照只是仓位/保证金基线。

`StrategyPnlReadModel` 使用同一批 `TradeFact` / 快照 / 行情，只额外按 `strategyId` 聚合；不改变 `PnlReadModel` 的 `accountId + contractKey` key。

---

## 6. 账户标识

`accountId` 的来源就是 146 的 `ACCOUNT`：

```text
accountId = trim(146 ACCOUNT / m_account / m_reqMsg.AccountID / NetPnlInfo.m_accountId)
```

账户标识不是固定常量；146 示例配置里是 `ACCOUNT=OWN`，代码必须从策略配置读取，不能把 `OWN` 写死。单账户也使用配置值。

exchange 由 `contractKey` 提供，不拼进 `accountId`。

旧稿中的固定 `OWN` 常量作废；`OWN` 只能作为 146 配置里的一个普通账户值出现。

只用于读模型：

```text
OrderReadModel.accountId
PnlReadModel.accountId
PositionReadModel.accountId
StrategyPnlReadModel.accountId
StrategyPositionReadModel.accountId
AccountSnapshotReadModel.accountId
```

不进入：

```text
ContractRoute
TradingChannel
OrderIntent
```

不存在：

```text
tradingChannelKey -> accountId
```

多账户也不引入 `tradingChannelKey -> accountId` 映射；`accountId` 直接来自 146 策略配置。只有部署层确实存在“一个 channel 对应哪个账户”的选择时，才单独引入映射。

---

## 7. 控制面

### 7.1 `StrategyControlCommand`

```text
commandId
strategyId
action         start / stop / pause / resume / updateParams
params?
operator
idempotencyKey
issuedAt
```

返回：

```text
CommandAck
  commandId
  status       ACCEPTED / REJECTED / COMPLETED / FAILED
  reason?
  occurredAt
```

### 7.2 `ManualOrderCommand`

```text
commandId
operator
accountId       146 ACCOUNT；手工单必填
strategyId?     手工单归属策略，可选
action         new / cancel / modify / cancelAll / squareOff
contractKey?
side?
orderType?
price?
quantity?
disclosedQuantity?
targetClientOrderId?
idempotencyKey
issuedAt
```

手工单走：

```text
BotGateway
  -> ManualOrderService
    -> TradeBotOrderGateway
      -> TradingChannel
```

### 7.3 `UiLockState`

```text
locked
operator
updatedAt
```

只影响 GUI 操作按钮/点击下单，不改变策略 `enableFlag`，不进入交易路由。

---

## 8. BotGateway API

对外入口：

```text
WSS /v1/stream
```

一个 WebSocket 会话同时承载：

```text
快照
订阅
策略状态
订单/成交/持仓/PnL/行情
控制命令
ACK
```

消息信封：

```text
type       snapshot / event / command / ack
topic      strategies / order / trade / position / pnl / marketdata / console
tbId
sequence
commandId?
payload
```

认证：

```text
WSS
operator
role
token / mTLS（二选一，部署决定）
```

权限：

```text
可见策略
可见合约
可控制策略
可手工下单
可撤销订单
```

审计：

```text
operator
commandId
action
ackStatus
timestamp
```

`BotGateway` 做：

```text
认证 / 授权
快照 / 订阅
命令入口
ACK
审计
```

不做：

```text
订单状态权威
成交归属
PNL 计算
交易 IPC
```

---

## 9. 146 面板覆盖矩阵

### 9.1 Strategy 面板

| 146 列 | 205 字段 | 状态 |
|---|---|---|
| Status | `StrategyStatusFact.state` | ✅ |
| Name | `strategyName` | ✅ |
| Bid Exlim | `bidExlim` | ✅ |
| Bid Size | `bidSize` | ✅ |
| Bid Edge | `bidEdge` | ✅ |
| Bid Slope | `bidSlope` | ✅ |
| Bid Lean | `bidLean` | ✅ |
| Bid Price | `bidPrice` | ✅ |
| Bid Fills | `bidFills` | ✅ |
| Offer Fills | `askFills` | ✅ |
| Offer Price | `askPrice` | ✅ |
| Offer Lean | `askLean` | ✅ |
| Offer Slope | `askSlope` | ✅ |
| Offer Edge | `askEdge` | ✅ |
| Offer Size | `askSize` | ✅ |
| Offer Exlimit | `askExlim` | ✅ |
| Start | `StrategyControlCommand.start` | ✅ |
| Stop | `StrategyControlCommand.stop` | ✅ |
| Lock | `UiLockState.locked` | ✅ |

额外数据：

| 146 数据 | 205 |
|---|---|
| FairValue | `StrategyStatusFact.fairValue` |
| FVMA | `StrategyStatusFact.fvma` |
| impliedBid/AskFairValue | 对应字段 |
| FVMidAverage/Status | 对应字段 |
| 心跳 | `heartbeatAt` |
| Console | `OperationalReadModel` |

### 9.2 Orders / OpenOrders 面板

| 146 列 | 205 字段 | 状态 |
|---|---|---|
| Account | `OrderReadModel.accountId` | ⚠️ 旁路映射 |
| Symbol | `OrderReadModel.symbol` | ✅ |
| Instr | `OrderReadModel.instrumentName` | ✅ |
| Status | `OrderFact.status` | ✅ |
| ID | `clientOrderId` / `exchangeOrderId` | ✅ |
| Trans | `OrderFact.side` | ✅ |
| OpType | `OrderReadModel.optionType` | ✅ |
| Strike | `OrderReadModel.strikePrice` | ✅ |
| Expiry | `OrderReadModel.expiryDate` | ✅ |
| Underlying | `OrderReadModel.underlyingSymbol` / `underlyingContractKey` | ✅（新增） |
| Price | `OrderFact.price` | ✅ |
| Qty | `OrderFact.quantity` | ✅ |
| LTT | `OrderFact.createdAt/updatedAt` | ✅ |
| QtyFill | `OrderFact.filledQuantity` | ✅ |
| Type | `OrderFact.orderType` | ✅ |
| DQty | `OrderFact.disclosedQuantity` | ✅ |
| Source | `exchangeSource` + `orderSource` | ✅ |

### 9.3 NetPnL 面板

| 146 列 | 205 字段 | 状态 |
|---|---|---|
| Account | `PnlReadModel.accountId` | ⚠️ 旁路映射 |
| Symbol | `symbol` | ✅ |
| Instr | `instrumentName` | ✅ |
| Qty | `netQuantity` | ✅ |
| NetPnl | `netPnl` | ✅ |
| Yield | `yield` | ✅ |
| Expiry | `expiryDate` | ✅ |
| Strike | `strikePrice` | ✅ |
| OpType | `optionType` | ✅ |
| Underlying | `underlyingSymbol` / `underlyingContractKey` | ✅（新增） |
| LTP | `lastTradedPrice` | ✅ |
| LTT | `lastTradedTime` | ✅ |
| TP | `tradePercent` | ✅ |
| Src | `exchange` | ✅ |
| RealizedPnl | `realizedPnl` | ✅ |
| UnrealizedPnl | `unrealizedPnl` | ✅ |
| NetBuyQty | `netBuyQty` | ✅ |
| NetSellQty | `netSellQty` | ✅ |
| NetBuyVal | `netBuyValue` | ✅ |
| NetSellVal | `netSellValue` | ✅ |
| NetVal | `netValue` | ✅ |
| NetExp | `netExposure` | ✅ |
| 1MinPnl | `oneMinPnl` | ✅ |
| 5MinPnl | `fiveMinPnl` | ✅ |
| 10MinPnl | `tenMinPnl` | ✅ |
| 1MinDiff | `oneMinDiff` | ✅ |
| 5MinDiff | `fiveMinDiff` | ✅ |
| 10MinDiff | `tenMinDiff` | ✅ |
| OvernightNetExp | `overnightNetExposure` | ✅ |
| OvernightPnl | `overnightPnl` | ✅ |
| IntradayPnl | `intradayPnl` | ✅ |

### 9.4 Market Data

| 146 数据 | 205 |
|---|---|
| bid/ask 20 档 | `MarketDataFact.bidLevels[20]/askLevels[20]` |
| price / quantity / orderCount | `BookLevel` 三字段 |
| validBids / validAsks | `validBidLevels/validAskLevels` |
| LTP / LTT | `lastTradedPrice/Time` |
| total traded qty/value | `totalTradedQuantity/Value` |
| yield | `yield` |
| order indication | `MarketDataIndication.bid/askOrderPresent[20]` |
| GUI 合并盘口 | `MarketDataSnapshot` |
| Console | `OperationalReadModel` |

### 9.5 控制/手工单

| 146 | 205 |
|---|---|
| Start/Stop | `StrategyControlCommand` |
| 参数修改 | `updateParams` |
| Lock | `UiLockState` |
| 手工新单/改单/撤单 | `ManualOrderCommand` |
| Cancel All | `ManualOrderCommand.cancelAll` |
| Square Off | `ManualOrderCommand.squareOff` |

### 9.6 tbadmin 字段落点

| tbadmin 字段 | 205 落点 |
|---|---|
| StrategyID | `strategyId` |
| Product | `StrategyStatusFact.product` |
| Server | `StrategyStatusFact.server` / `FactEnvelope.tbId/agentId` |
| StrategyType | `StrategyStatusFact.strategyType` |
| ModelFile | `StrategyStatusFact.modelFile` |
| alert / alert_time | `StrategyStatusFact.alert/alertAt` |
| m_active / m_running | `StrategyStatusFact.active/running` |
| m_onExit / m_onCancel / m_onFlat | `StrategyStatusFact.onExit/onCancel/onFlat` |
| key / value / info | `StrategyTelemetryFact` / `StrategyTelemetryReadModel` |
| pnl | `StrategyPnlReadModel` |
| fir / sec | `StrategyPositionReadModel.legIndex/legRole` |
| CXLRio | `PositionReadModel.orderCount/cancelCount` |
| Spread | `SpreadTradeFact` / `SpreadReadModel` |
| Option Delta | `OptionDeltaReadModel` |
| Orders/Fills PosDirection | `OrderFact/TradeFact.positionEffect` |
| Orders/Fills SysID | `OrderFact/TradeFact.sysId` |
| Orders ErrorCode | `OrderFact.errorCode` |
| Orders/Fills ExchangeTradeId | `OrderFact/TradeFact.exchangeTradeId` |
| Account TotalAsset / AvailCash | `AccountSnapshot.balances/available` |

---

## 10. 一致性

```text
OrderRegistry 是订单权威
PositionSnapshot 是账户/仓位基线
ReadModel 是投影
ReadModel 丢失 -> 从 facts / snapshot 重建
```

读模型永远不能覆盖 `OrderRegistry`、`FillLedger` 或账户快照。

事实按 `(tbId, streamId, seq)` 去重；读模型保存每个 stream 的 `lastAppliedSeq`。

---

## 11. 部署

每台交易服务器：

```text
TB 交易进程
  交易运行时
  Fact publisher
  LocalAgent
    -> 读取本机 facts / strategy status
    -> WSS
      -> 中央 BotGateway
```

中央：

```text
BotGateway
  ReadModelService
  PnlService
  StrategyControlService
  ManualOrderService
  WSS
```

控制命令反向：

```text
GUI
  -> 中央 BotGateway
    -> LocalAgent
      -> StrategyControlService / ManualOrderService
```

多 TB 聚合：

```text
按 FactEnvelope.tbId
按 strategyId
按 contractKey
```

只做配置/Agent 注册，不做自动发现。

如果 Agent 与 TB 同进程：

```text
进程内事件总线
```

如果 Agent 独立进程：

```text
读侧 IPC stream / message bus
```

不能跨机读 `aeron:ipc`。

`BotGateway` 挂了：

```text
GUI 不可用
交易继续
策略继续
```

---

## 12. 不变量

```text
交易运行时不能依赖读模型
读模型不能反写交易状态
GUI 不能直接订阅 venue IPC
GUI 不能直接操作 TradingChannel
BotGateway 不是 TradeBotOrderGateway
StrategyStatusFact 不是 WebSocket 消息
StrategyStatusFact 不是订单/成交事件
手工单必须经过 TradeBotOrderGateway
控制命令必须有 commandId + ACK
accountId = trim(146 ACCOUNT)，不进入交易路由
UiLockState 不改变策略 enableFlag
OrderFact/TradeFact 必须带 channelEpoch
订单/控制事实必须能关联 intentId / commandId
OrderFact/TradeFact 不复制 expiry/strike/underlying
StrategyPnlReadModel 不改变 PnlReadModel 的 accountId + contractKey key
Spread 必须走 SpreadTradeFact，不解析 Trade2 文本
```

---

## 13. 未决问题

1. `MarketDataFact` / `MarketDataIndication` 的 SBE IDL 和 snapshot/delta 实现；结构已定，编码未实现。
2. `PnlService` 按 146 公式实现后的验证：mark price、手续费配置、结算价、overnight/intraday。
3. 读模型的恢复 journal 保留多久；不提供历史查询。
4. 产品选择默认显示的 Order / Position / PnL 列；数据模型保留 146 全量字段。
5. 多 TB 聚合的具体查询口径：`tbId + strategyId + contractKey` 的冲突和排序规则。
6. BotGateway 的具体认证方式、角色矩阵和审计保留期。
7. Agent 断线缓存上限、重连补偿和控制命令失败语义。
8. Agent 与 BotGateway 不同进程时的读侧传输选型：进程内总线、Aeron 读侧 stream，还是消息队列。
9. `StrategyPnlReadModel` / `StrategyPositionReadModel` 的归属服务和保留周期。
10. `OptionDeltaReadModel` 的波动率、定价源和 Greeks 版本。
11. `SpreadTradeFact` 由哪一层生成：策略、TB 还是读侧配对。

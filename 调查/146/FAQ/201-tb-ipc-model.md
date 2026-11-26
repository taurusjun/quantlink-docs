# TB IPC 整体模型

- 日期：2026-11-21
- 状态：DRAFT（设计文档，未写代码）
- 范围：TradeBot 的交易/行情 IPC 边界、StrategyRuntime、TradingChannel、MarketDataChannel、账户快照边界
- 关联：`202-trading-channel-and-routing.md`、`203-configuration.md`、`204-strategy-runtime-and-optionmanager.md`、`206-contract-catalog.md`

---

## 1. 一句话

TB 交易只认 IPC：

```text
ContractKey -> TradingChannelKey
ContractKey -> MarketDataChannelKey
```

ORS 在通道后面，TB 不认识它。

```text
1 TB = 1 TradeBotRuntime
     + M StrategyRuntime
     + K TradingChannel
     + MarketDataChannel
```

---

## 2. Actors

```text
TradeBot
  StrategyRuntime
  TradingChannel
  MarketDataChannel
  TradeBotOrderGateway
  MarketDataRouter
  ExecutionEventRouter

TB 外部
  ORS（通道后面的执行端）
  AccountSnapshotService（独立读模型）
```

`TradingChannel` 是 TB 侧对象；`ORS` 不是。

### 2.1 架构图

[打开 TB IPC 架构图](201-tb-ipc-architecture.html)

关键边界：

```text
TradeBot 内：
  StrategyRuntime
  TradeBotOrderGateway
  ExecutionEventRouter
  MarketDataRouter
  MarketDataChannel
  TradingChannel[BSE/NSE_FO]

TradeBot 外：
  ORS / venue
  行情源
  AccountSnapshotService
  AccountSnapshotStore
```

`TradeBotOrderGateway` 和 `MarketDataRouter` 不连接；`StrategyRuntime` 是两条路径的汇合点。
`EXECUTION` 不是从 `TradingChannel` 直接跨边界送到 `ExecutionEventRouter`，而是先回到 TB 内的 `TradingChannel`，再进入 `ExecutionEventRouter`。

---

## 3. 职责边界

TB 负责：

```text
策略运行
ContractKey -> TradingChannelKey 路由
ContractKey -> MarketDataChannelKey 路由
每个 TradingChannel 的订单/成交状态
行情 fan-out
策略失败隔离
```

TB 不负责：

```text
ORS_ID
ORS 进程
BrokerID
InvestorID
账户
账户净仓
账户级 RMS
账户快照
```

账户快照由独立服务消费：

```text
STATE / VENUE_SESSION
  -> AccountSnapshotService
    -> AccountSnapshotStore
```

---

## 4. 实例关系

```text
1 TradingChannel
  = 1 组交易 IPC
  + COMMAND
  + EXECUTION
  + STATE
  + VENUE_SESSION
  + OrderRegistry / FillLedger
  + orderRef 空间

1 MarketDataChannel
  = 1 组行情 IPC
  + MARKET_DATA
```

`TradingChannel` 不包含：

```text
ORS_ID
BrokerID
InvestorID
账户
```

---

## 5. Key

```text
ContractKey          = (exchange, instrumentId)
TradingChannelKey    = channelId
MarketDataChannelKey = channelId
StrategyId          = 策略实例 ID，启动配置指定，TB 内唯一
```

`strategyId` 来自策略启动配置，不是 146 `m_strategyID` 自动继承；全局身份使用 `(tbId, strategyId)`。`strategyName` 只用于显示。

`ContractKey` 只做身份和路由，不携带 expiry / strike / underlying。

合约元数据统一由 `206-contract-catalog.md` 的 `ContractCatalog` 提供：

```text
ContractKey -> ContractCatalogEntry
OPTION -> OptionCatalogEntry
```

只读账户视图：

```text
accountId = trim(146 ACCOUNT / m_account / m_reqMsg.AccountID / NetPnlInfo.m_accountId)
```

`accountId` 不是新的账户命名空间；它就是 146 的 `accountID`。统一 trim 尾部空格，不改变大小写。

exchange 由 `ContractKey` 提供，不拼进 `accountId`。

它只用于账户快照、持仓和 PnL 读模型，不参与订单路由。

路由对象：

```text
ContractRoute = (
  contractKey,
  tradingChannelKey
)

MarketDataRoute = (
  contractKey,
  marketDataChannelKey,
  streamId
)
```

---

## 6. 四条主流程

### 6.1 下单

```text
StrategyRuntime
  -> OrderIntent(strategyId, contractKey, ...)
    -> TradeBotOrderGateway
      -> ContractRoute(tradingChannelKey)
        -> TradingChannel
          -> COMMAND IPC
```

`TradingChannel` 分配：

```text
clientOrderId
orderRef
```

`clientOrderId` 在 TB 内唯一；`orderRef` 在 channel + epoch 内唯一。

### 6.2 回报

```text
EXECUTION / STATE / VENUE_SESSION
  -> TradingChannel
    -> OrderRegistry / FillLedger
  -> ExecutionEventRouter
    -> StrategyRuntime[strategyId]
```

### 6.3 行情

```text
MARKET_DATA
  -> MarketDataChannel
    -> MarketDataRouter
      -> StrategyRuntime
        -> IndicatorEngine
```

行情 fan-out 不经过 `TradingChannel`，也不决定订单路由。

### 6.4 账户快照

```text
STATE / VENUE_SESSION
  -> AccountSnapshotService
    -> AccountSnapshotStore
      -> GUI / 报表 / 可选的账户风控视图
```

快照服务不在订单主链路。

---

## 7. 三个场景

### 7.1 Pair 两条腿在 BSE / NSE_FO

```text
StrategyRuntime[14526 / pair-01]
  LEG_A -> BSE:...   -> TradingChannel[BSE]
  LEG_B -> NSE_FO:... -> TradingChannel[NSE_FO]
```

两条腿是两个 `OrderIntent`，各自进入不同通道。

TB 不关心这两个通道后面是否来自同一个 ORS。

### 7.2 一个交易通道断开

```text
TradingChannel[BSE] -> DOWN
```

结果：

```text
使用 BSE 通道的策略 -> PAUSED / 拒绝新单
其他通道不受影响
重连后对账
不盲目重放旧命令
```

### 7.3 AccountSnapshotService 挂掉

```text
账户视图 stale
交易继续
策略不受影响
```

账户快照不是交易门禁。

---

## 8. 不变量

```text
策略不直接写 IPC
策略只通过 TradeBotOrderGateway 下单
TradingChannel 不知道 ORS
TradingChannel 不包含 InvestorID/账户
MarketDataChannel 不参与订单路由
clientOrderId 在 TB 内唯一
orderRef 在 (TradingChannelKey, channelEpoch) 内唯一
未知回报不按字段猜
账户快照不参与交易路由
```

---

## 9. 明确拒绝的旧模型

```text
AccountTradingEngine 进入交易主链路
OrsTradingSession
AccountKey 作为交易路由 key
InvestorID 作为 TB 配置/路由字段
账户快照参与策略启动门禁
```

这些都属于“把部署/统计维度塞进交易运行时”。

---

## 10. 与 146 的关系

146 Connector 选请求队列靠：

```text
Exchange_Type -> m_requestQueue[exchange]
```

不是靠：

```text
InvestorID
AccountID
```

新模型保持一致：

```text
ContractKey -> TradingChannelKey -> IPC
```

`AccountID` 用于账户快照、持仓和 PnL 读模型；`InvestorID` 只用于账户快照。二者都不进入 TB 交易路由。

---

## 11. 未决问题

1. 一个 `TradingChannel` 是否严格对应一个 exchange；当前建议是。
2. 同一 `ContractKey` 多通道时，是否允许 `LEG_x_CHANNEL` 显式覆盖。
3. 同一合约多通道的 active/standby 规则。
4. `AccountSnapshotService` 与 TB 同进程还是独立进程。
5. 账户级预交易风控是否需要显式接入订单路径。
6. 撤单是否需要独立高优先级 stream。

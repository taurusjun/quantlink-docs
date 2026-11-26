# TradingChannel 与路由

- 日期：2026-11-21
- 状态：DRAFT（设计文档，未写代码）
- 范围：`TradingChannel`、`MarketDataChannel`、`ContractRoute`、订单/回报/行情路由、通道故障与恢复
- 关联：`201-tb-ipc-model.md`、`203-configuration.md`、`204-strategy-runtime-and-optionmanager.md`、`206-contract-catalog.md`

---

## 1. 结论

```text
TradingChannel
  = 1 组交易 IPC
  + COMMAND
  + EXECUTION
  + STATE
  + VENUE_SESSION
  + OrderRegistry / FillLedger

MarketDataChannel
  = 1 组行情 IPC
  + MARKET_DATA
```

```text
ContractKey -> ContractRoute(contractKey, tradingChannelKey)
ContractKey -> MarketDataRoute(contractKey, marketDataChannelKey, streamId)
```

路由只使用 `contractKey`，不携带 expiry / strike / underlying。

合约元数据统一见 `206-contract-catalog.md`：

```text
ContractKey -> ContractCatalogEntry
```

`TradingChannel` 不知道 ORS；ORS 在通道后面。

---

## 2. `TradingChannel`

```text
TradingChannel
  ├─ TradingChannelKey = channelId
  ├─ ChannelTransport
  ├─ ChannelState
  ├─ SequenceGuard
  ├─ OrderRefAllocator
  ├─ OrderRegistry
  ├─ FillLedger
  └─ StreamSet
```

职责：

```text
发布 COMMAND
订阅 EXECUTION / STATE / VENUE_SESSION
维护 channel READY
维护 sourceSessionId / epoch / lastSeqByStream
分配 orderRef
维护本 channel 的订单和成交
把执行事件交给 ExecutionEventRouter
```

不负责：

```text
账户快照
账户净仓
账户级风控
策略信号
ORS 登录
```

### 2.1 状态

```text
ChannelState =
    DISCONNECTED
  | CONNECTING
  | READY
  | DEGRADED
  | CLOSED
```

只有 `READY` 接受新订单。

### 2.2 订单入口

```text
submitOrder(ContractRoute route, OrderIntent intent)
  -> SubmitOrderResponse
```

```text
1. 检查 ChannelState == READY
2. 分配 clientOrderId
3. 分配 orderRef
4. OrderRegistry.allocate
5. 发布 COMMAND
6. 返回 Accepted / Rejected
```

`clientOrderId` 在 TB 内唯一；`orderRef` 在 `(TradingChannelKey, channelEpoch)` 内唯一。

### 2.3 `OrderRegistry`

```text
byClientOrderId
byRequestId
byChannelOrderRef: (TradingChannelKey, channelEpoch, orderRef)
byChannelExchangeOrderId: (TradingChannelKey, exchangeOrderId)
byStrategy: StrategyId -> Set<ClientOrderId>
```

`Order` 至少包含：

```text
clientOrderId
strategyId
contractKey
tradingChannelKey
channelEpoch
orderRef
exchangeOrderId
side / price / quantity / filledQuantity / status
```

不变量：

```text
requestId 幂等
filledQuantity 单调不减且 <= quantity
终态不可逆
未知回报不得按价格/数量猜订单
```

### 2.4 `FillLedger`

```text
byTradeId
byStrategy
```

记录本通道成交，向策略提供成交事实；不计算账户净仓。

---

## 3. `MarketDataChannel`

```text
MarketDataChannel
  ├─ MarketDataChannelKey
  ├─ ChannelTransport
  └─ MARKET_DATA
```

职责：

```text
订阅行情
按 ContractKey 维护 sequence
向 MarketDataRouter 投递
```

不负责订单路由和账户选择。

---

## 4. 订单路由

```text
StrategyRuntime
  -> OrderIntent
    -> TradeBotOrderGateway
      1. strategy RUNNING
      2. ContractKey -> ContractRoute
      3. ContractRoute.tradingChannelKey -> TradingChannel
      4. channel.submitOrder(route, intent)
```

失败直接拒绝：

```text
ContractKey 不在目录
策略未 RUNNING
通道不存在 / 不 READY
路由重复且没有显式 channel override
```

禁止：

```text
按 InvestorID 选通道
按账户快照选通道
找不到 BSE 通道就静默改走 NSE_FO
```

---

## 5. 回报路由

```text
EXECUTION
  -> TradingChannel
    -> OrderRegistry / FillLedger
  -> ExecutionEventRouter
    -> StrategyRuntime[strategyId]
```

归属顺序：

```text
1. (tradingChannelKey, channelEpoch, orderRef)
2. (tradingChannelKey, exchangeOrderId)
3. clientOrderId
```

未知回报：

```text
UNKNOWN / ORPHAN
告警 + 对账
不按 instrument + side + qty + price 猜
```

---

## 6. 行情路由

```text
MARKET_DATA
  -> MarketDataChannel
    -> MarketDataRouter
      -> 订阅了该 ContractKey 的 StrategyRuntime
```

行情通道和交易通道独立：

```text
ContractKey -> MarketDataChannelKey
ContractKey -> TradingChannelKey
```

两者可以相同，也可以不同；不要默认绑定。

---

## 7. 多通道

### 7.1 不同交易所

```text
TradingChannel[BSE]
TradingChannel[NSE_FO]
```

两套 stream 不共享。

### 7.2 同一交易所多通道

```text
TradingChannel[BSE-01]
TradingChannel[BSE-02]
```

`TradingChannelKey` 是通道 key，不是 exchange 名。

### 7.3 同一合约多通道

默认：

```text
一个 ContractKey 只能有一个默认 ContractRoute
重复配置 -> 启动报错
```

需要多通道时，策略 leg 显式覆盖：

```text
LEG_A_CHANNEL = BSE-01
```

```text
OPEN:
  同一合约多通道的 active/standby、拆单规则未定；
  当前只支持显式指定 channel。
```

---

## 8. readiness

```text
ChannelReady = ChannelState == READY

RouteReady =
  ContractRoute 存在
  && 目标 TradingChannel READY

StrategyReady =
  所有 leg RouteReady
  && 行情通道 ready
  && 指标 warmup 完成
```

Pair 的两条腿都必须 ready，不能只发一条腿。

---

## 9. 故障与恢复

```text
通道断开
  -> ChannelState = DISCONNECTED / DEGRADED
  -> 停止接受新单
  -> 相关策略 PAUSED
  -> 保留 OrderRegistry / FillLedger

重连
  -> 新 channelEpoch
  -> 重新 READY
  -> 订阅 STATE
  -> 对账
  -> 解决 ORPHAN
  -> 恢复策略
```

不自动重放断线前的 COMMAND。已发送未确认的订单进入对账。

```text
序列缺口
  -> 停止该通道新单
  -> 等待 STATE / session 水位
  -> 必要时重连
  -> 不猜测丢失事件
```

---

## 10. 与 146 的对照

| 146 | 新模型 |
|---|---|
| `Exchange_Type` 选请求队列 | `ContractKey -> ContractRoute` |
| `ORSREQUESTSHMKEY` | `TradingChannel.COMMAND` |
| `ORSRESPONSESHMKEY` | `TradingChannel.EXECUTION` |
| `m_response_queue_to_exchange_map` | 每通道自己的订单/回报映射 |
| `MDSHMKEY` | `MarketDataChannel.MARKET_DATA` |
| `CLIENTSTORE` | TB 分配 `clientOrderId`；通道分配 `orderRef` |
| `AccountID` / InvestorID | 只用于账户快照/持仓/PnL 读模型，不进入交易路由 |

---

## 11. 不变量

```text
一个 TradingChannel 只有一组交易流
一个 TradingChannel 只有一个 orderRef 空间
一个 MarketDataChannel 只有一组行情流
策略不直接写 IPC
clientOrderId 在 TB 内唯一
orderRef 在 (TradingChannelKey, channelEpoch) 内唯一
未知回报不猜
账户快照不参与交易路由
```

---

## 12. 未决问题

1. 同一合约多通道的 active/standby / 拆单规则。
2. 一个交易通道是否严格对应一个 exchange。
3. 同一合约多行情通道的主备/合并规则。
4. 撤单是否需要独立高优先级 stream。
5. 通道恢复时是否允许保留部分 open orders。

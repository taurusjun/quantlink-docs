# AccountTradingEngine 设计

- 日期：2026-11-21
- 状态：DRAFT（设计文档，未写代码）
- 范围：账户级交易运行时 `AccountTradingEngine` 的定位、分层、组件、ADT、状态机、订单/成交/对账流程
- 关联：`009-account-isolated-new-system-structure.md`、`014-optionmanager-design.md`

---

## 1. 定位

`AccountTradingEngine` 是每个账户一份的**账户级交易应用服务**。

```text
1 Account = 1 AccountTradingEngine
1 Strategy = 1 StrategyProcess
```

它负责账户内的：

- 订单命令接收；
- 订单状态维护；
- 成交归属；
- 策略仓位与账户净仓；
- 账户级预交易风控；
- 账户对账；
- 账户交易开关；
- 执行事件发布；
- 与 ORS 的交易通信。

它不负责：

- 策略信号、指标、目标仓位；
- 期权定价、Greeks、期权腿语义；
- 行情分发；
- ORS 登录、账户密码、CTP 凭据；
- 账户开户、权限管理；
- GUI。

```text
StrategyProcess
  -> engine-sdk
    -> OrderCommandService
      -> AccountTradingEngine
        -> access-sdk (AccessClient)
          -> ORS

AccountTradingEngine
  -> ExecutionEventPublisher
    -> engine-sdk
      -> StrategyProcess
```

---

## 2. 分层

```text
┌──────────────────────────────────────────────────────────────┐
│ Adapters                                                     │
│ OrderCommandService / AccountTradingEngineClient             │
│ ExecutionEventPublisher / AeronExecutionEventPublisher       │
│ access-sdk: AccessClient / AccessListener                     │
└───────────────────┬──────────────────────────────────────────┘
                    │
┌───────────────────▼──────────────────────────────────────────┐
│ Application                                                  │
│ AccountTradingEngine                                         │
│   ├─ AccountLifecycle                                        │
│   ├─ StrategyLeaseRegistry                                   │
│   ├─ AccountRiskGuard                                        │
│   └─ ExecutionReportRouter                                   │
│                                                              │
│ 二级：AccountLifecycle                                       │
│   ├─ AccountHealth                                           │
│   └─ AccountReconciler                                       │
└───────────────────┬──────────────────────────────────────────┘
                    │
┌───────────────────▼────────────────s──────────────────────────┐
│ Domain                                                       │
│ OrderRegistry                                                │
│ PositionLedger                                               │
│ OrderIdAllocator                                             │
│ Order / Trade / Position / OrderEvent / TradeEvent           │
└───────────────────┬──────────────────────────────────────────┘
                    │
┌───────────────────▼──────────────────────────────────────────┐
│ Infrastructure                                               │
│ ExecutionEventChannel                                        │
│ AsyncJournal                                                 │
│ Aeron / SBE / DB                                             │
└──────────────────────────────────────────────────────────────┘
```

依赖方向：

```text
Adapters -> Application -> Domain
Infrastructure 实现 Adapter/Port
Domain 不依赖 Application、Aeron、DB
```

---

## 3. 对外契约

### 3.1 入站命令

```text
OrderCommandService
  submitOrder(SubmitOrderRequest) -> SubmitOrderResponse
  cancelOrder(CancelOrderRequest) -> CancelOrderResponse
```

StrategyProcess 通过 `engine-sdk` 调用：

```text
AccountTradingEngineClient
  orderCommands(): OrderCommandClient
  executionEvents(): ExecutionEventSubscriber
  lease(): StrategyLeaseClient
```

### 3.2 出站事件

```text
ExecutionEventPublisher
  publish(ExecutionEvent)
```

`ExecutionEvent` 是：

```text
ExecutionEvent = OrderEvent | TradeEvent
```

`OrderEvent` 表示订单生命周期：

```text
Allocated
Accepted
PartiallyFilled
Filled
Canceled
Rejected
Unknown
```

`TradeEvent` 表示成交明细：

```text
tradeId
clientOrderId
strategyKey
instrumentId
lastQty
lastPrice
cumQty
fee
occurredAt
```

SDK 侧对应：

```text
ExecutionEventSubscriber
```

### 3.3 查询

按需提供只读查询：

```text
AccountQueryService
  order()
  position()
  health()
```

### 3.4 SDK 边界

```text
engine-sdk
  使用方：StrategyProcess
  对端：AccountTradingEngine
  内容：AccountTradingEngineClient / OrderCommandClient /
        ExecutionEventSubscriber / StrategyLeaseClient
  不包含：订单状态、仓位、Greeks

access-sdk
  使用方：AccountTradingEngine
  对端：ORS
  内容：AccessClient / AccessListener / AccessConfig / SequenceGuard
  不包含：订单状态、策略语义
```

策略注册时，Engine 分配 lease 和事件流：

```text
StrategyProcess
  -> engine-sdk.register(strategyKey, processInstanceId)
    -> StrategyLeaseRegistry
      返回 Lease(
        leaseId,
        strategyKey,
        processInstanceId,
        commandStreamId,
        eventStreamId,
        issuedAt,
        lastRenewAt,
        expiresAt,
        status
      )

StrategyProcess
  -> subscribe(eventStreamId)
  -> publish COMMAND
  -> 每 heartbeatInterval 调 renew(leaseId, processInstanceId)
```

流分配：

```text
1 Account = 1 COMMAND stream
1 Strategy = 1 EVENT stream
streamId 由 Engine 在注册时分配
```

心跳失败：

```text
lease 到期
  -> StrategyLeaseRegistry 标记 EXPIRED
  -> 拒绝该 strategyKey 的新订单
  -> 撤销该策略的 open orders
  -> 释放 event stream publication
  -> 保留仓位并告警
```

---

## 4. 组件

### 4.1 `AccountTradingEngine`

应用服务，唯一用例编排者。

直接调用的一级组件：

```text
AccountLifecycle
StrategyLeaseRegistry
AccountRiskGuard
ExecutionReportRouter
```

通过端口/适配器访问：

```text
ExecutionEventPublisher
AccessClient（access-sdk）
MarketDataPublisher
Journal
```

### 4.2 `AccountLifecycle`

账户交易总开关。

```text
AccountState =
    INIT
  | RECOVERING
  | DISARMED
  | ARMING
  | ARMED
  | DEGRADED
  | SHUTDOWN
```

操作：

```text
init()
recover()
arm()
disarm(reason)
degrade(reason)
recoverFromDegraded()
shutdown()
isArmed()
requireArmed()
onHealthChanged(snapshot)
```

它不管理订单、仓位、ORS 登录和进程启停。

### 4.3 `StrategyLeaseRegistry`

每个策略的租约和事件流分配。

```text
LeaseStatus = ACTIVE | EXPIRED | REVOKED

Lease = (
  leaseId,
  strategyKey,
  processInstanceId,
  commandStreamId,
  eventStreamId,
  issuedAt,
  lastRenewAt,
  expiresAt,
  status
)
```

操作：

```text
register(strategyKey, processInstanceId) -> Lease | Rejected
renew(leaseId, processInstanceId) -> Lease | Expired
revoke(leaseId, processInstanceId)
expireLeases(now)
isActive(strategyKey, now)
requireActive(strategyKey, now)
activeLease(strategyKey)
```

注册规则：

```text
同一 strategyKey + 同一 processInstanceId
  -> 返回现有 active lease，幂等

同一 strategyKey + 不同 processInstanceId
  -> Rejected(LEASE_HELD)

lease 已 EXPIRED/REVOKED
  -> 允许重新注册并分配新 lease
```

心跳规则：

```text
engine-sdk 每 heartbeatInterval 调 renew()
renew 更新 lastRenewAt / expiresAt
processInstanceId 必须匹配
```

过期扫描：

```text
LeaseMonitor
  每 scanInterval 调 expireLeases(now)

expireLeases:
  status == ACTIVE 且 now >= expiresAt
    -> status = EXPIRED
```

过期处理由 `AccountTradingEngine` 编排：

```text
1. 拒绝该 strategyKey 的新订单
2. 从 OrderRegistry 取该策略的 open orders
3. 通过 AccessClient 发撤单
4. 释放 event stream publication
5. 保留仓位
6. AccountHealth 告警
```

撤单失败：

```text
order -> ORPHAN / DEGRADED
账户保持 disarmed 或降级
等待对账/人工处理
```

不变量：

```text
leaseId 唯一
一个 strategyKey 同时只有一个 active lease
lease 过期后不能提交订单
同一 processInstanceId 的多个策略 lease 可一起过期
```

### 4.4 `AccountRiskGuard`

账户级预交易风控。

```text
check(OrderIntent, AccountState) -> Allow | Reject(reason)
```

不变量：

```text
无副作用
不查 DB
账户未 ARMED 一律拒绝
超过账户限额一律拒绝
```

### 4.5 `ExecutionReportRouter`

把 ORS 回报映射到内部订单。

```text
routeOrderReport(OrderReport) -> ClientOrderId | Unknown
routeTrade(TradeEvent) -> ClientOrderId | Unknown
```

只按显式键归属：

```text
orderRef
exchangeOrderId
clientOrderId
```

未知回报不得按 instrument/side/qty/price 猜。

### 4.6 `OrderRegistry`

订单状态唯一内存权威。

```text
OrderRegistry
  orders: Map<ClientOrderId, Order>
  byOrderRef: Map<OrderRef, ClientOrderId>
  byExchangeOrderId: Map<ExchangeOrderId, ClientOrderId>
  byRequestId: Map<RequestId, ClientOrderId>
```

操作：

```text
allocate(strategyKey, intent, clientOrderId, orderRef)
onOrderEvent(OrderEvent)
onTrade(TradeEvent)
get(ClientOrderId)
openOrders(StrategyKey)
```

不变量：

```text
clientOrderId 唯一
orderRef / exchangeOrderId 映射唯一
requestId 幂等
订单状态单向
终态不可逆
filledQty 单调不减且 <= qty
```

### 4.7 `PositionLedger`

成交驱动的策略仓位和账户净仓。

```text
strategyPositions: Map<StrategyKey, Map<InstrumentId, Position>>
accountNet: Map<InstrumentId, Position>
appliedTrades: Set<TradeId>
```

操作：

```text
applyTrade(TradeEvent)
positionOf(StrategyKey, InstrumentId)
accountPosition(InstrumentId)
```

不变量：

```text
tradeId 幂等
同一笔成交只应用一次
accountNet = Σ strategyPositions + UNASSIGNED
```

### 4.8 `OrderIdAllocator`

```text
nextClientOrderId() -> ClientOrderId
nextOrderRef() -> OrderRef
```

不变量：

```text
clientOrderId 在账户内唯一
orderRef 在 CTP session 内唯一
重启不回退到旧值
不依赖同步 DB
```

### 4.9 `AccountHealth`

账户健康读模型。

```text
orsReady
reconciled
journalLag
orphanCount
armed
```

`AccountHealth` 不控制订单，只向 `AccountLifecycle` 提供状态。

### 4.10 `AccountReconciler`

恢复和 arm 前对账。

```text
reconcile(AccountSnapshot, OrderRegistry, PositionLedger)
  -> Match | Mismatch
```

不变量：

```text
不一致不得 ARM
不自动覆盖内存仓位
```

### 4.11 `access-sdk`

AccountTradingEngine 不实现 ORS 通信，使用 `access-sdk`。

```text
access-sdk
  AccessClient
  AccessListener
  AccessConfig
  SequenceGuard
```

`AccessClient` 是一个账户/venue-contract session 的双向访问客户端：

```text
发布：
  OrderRequest
  CancelRequest

订阅：
  VenueSession
  OrderUpdate
  Trade
  MarketData
  PositionSnapshot
  AccountSnapshot
```

职责：

```text
Aeron/SBE
session READY
venue/account/environment 过滤
sourceSessionId / sourcePublicationEpoch
sequence guard
duplicate / gap
未知 session 事件缓冲
publication backpressure
```

操作：

```text
submit(OrderRequest)
cancel(CancelRequest)
poll(int)
ready()
session()
close()
```

回调：

```text
AccessListener
  onSession()
  onOrderUpdate()
  onTrade()
  onPosition()
  onAccount()
  onMarketData()
```

不变量：

```text
一个账户/venue session 只有一个 AccessClient
不是线程安全对象，回调只从 poll() 触发
未 READY 不允许发单
不维护订单业务状态
不解析策略语义
```

`MarketData` 回调不进入订单路径：

```text
AccessClient.poll()
  -> AccessListener.onMarketData()
    -> MarketDataPublisher
      -> StrategyProcess
```

### 4.12 `MarketDataPublisher`

行情出站端口。

```text
publish(MarketDataEnvelope)
```

实现：

```text
AeronMarketDataPublisher
  -> 写入 strategy market data channel
```

### 4.13 `ExecutionEventPublisher`

出站事件端口。

```text
publish(ExecutionEvent)
```

实现：

```text
AeronExecutionEventPublisher
  -> 写入 ExecutionEventChannel
```

### 4.14 `Journal`

出站持久化端口。

```text
append(ExecutionEvent)
```

实现：

```text
AsyncJournal
  -> 有界队列
  -> 单写线程
  -> 异步批量落库
```

---

## 5. 调用关系

### 5.1 下单

```text
OrderCommandService.submitOrder()
  -> AccountTradingEngine.submitOrder()
    -> AccountLifecycle.requireArmed()
    -> StrategyLeaseRegistry.requireActive()
    -> AccountRiskGuard.check()
    -> OrderIdAllocator.allocate()
    -> OrderRegistry.allocate()
    -> Journal.append()
    -> AccessClient.submit()
```

### 5.2 订单回报

```text
AccessClient.poll()
  -> AccessListener.onOrderUpdate()
    -> AccountTradingEngine.onOrderReport()
      -> ExecutionReportRouter.routeOrderReport()
      -> OrderRegistry.onOrderEvent()
      -> Journal.append()
      -> ExecutionEventPublisher.publish()
```

### 5.3 成交

```text
AccessClient.poll()
  -> AccessListener.onTrade()
    -> AccountTradingEngine.onTrade()
      -> ExecutionReportRouter.routeTrade()
      -> OrderRegistry.onTrade()
      -> PositionLedger.applyTrade()
      -> Journal.append()
      -> ExecutionEventPublisher.publish()
```

### 5.4 撤单

```text
OrderCommandService.cancelOrder()
  -> AccountTradingEngine.cancelOrder()
    -> OrderRegistry 校验可撤
    -> Journal.append()
    -> AccessClient.cancel()
```

### 5.5 恢复

```text
AccountLifecycle.recover()
  -> AccountHealth.snapshot()
  -> AccountReconciler.reconcile()
  -> Match -> AccountLifecycle.arm()
  -> Mismatch -> AccountLifecycle.disarm()
```

---

## 6. 状态机

### 6.1 订单状态

```text
SUBMITTING
  -> ACKED
  -> PARTIAL
  -> FILLED
  -> REJECTED
  -> UNKNOWN

ACKED
  -> PARTIAL
  -> FILLED
  -> CANCELING

PARTIAL
  -> FILLED
  -> CANCELING

CANCELING
  -> CANCELED
  -> PARTIAL
  -> CANCEL_REJECTED -> ACKED/PARTIAL

UNKNOWN
  -> ACKED/PARTIAL/FILLED/CANCELED/REJECTED/ORPHAN
```

规则：

```text
SUBMITTING -> FILLED 允许
FILLED 是终态
FILLED 只表示订单没有剩余数量
仓位仍由 TradeEvent 更新
```

### 6.2 账户状态

```text
INIT
  -> RECOVERING
  -> DISARMED
  -> ARMING
  -> ARMED
  -> DEGRADED
  -> SHUTDOWN
```

规则：

```text
ORS 未 READY -> 不能 ARM
对账失败 -> DISARMED
journal 满/滞后 -> DISARMED/DEGRADED
```

---

## 7. 不变量

```text
1. 一个账户只有一个 AccountTradingEngine。
2. 一个账户只有一个订单写者。
3. clientOrderId、orderRef 在各自作用域内唯一。
4. requestId 幂等；tradeId 幂等。
5. 订单状态单向，终态不可逆。
6. 订单/成交归属只按显式映射，不猜。
7. accountNet = Σ strategyPositions + UNASSIGNED。
8. ORS 未 READY、对账失败、journal 满 -> 不允许 ARM。
9. 热路径不查 DB、不等 DB。
10. FILLED 不直接驱动仓位，仓位只由 TradeEvent 驱动。
11. legKey、strike、callPut、Greeks 不进入 AccountTradingEngine。
12. 密码/凭据不进入 AccountTradingEngine。
```

---

## 8. 持久化与恢复

异步事件：

```text
OrderAllocated
OrderAccepted
OrderPartiallyFilled
OrderFilled
OrderCanceled
OrderRejected
TradeApplied
AccountReconciled
ArmChanged
```

恢复基线：

```text
DB 基线 + ORS/CTP 快照
```

规则：

```text
DB 是异步投影
ORS/CTP 是最终对账源
UNKNOWN 只能通过对账离开
ORPHAN 需要人工处理
```

---

## 9. 命名约定

```text
命令 RPC：Service / Client
事件：Publisher / Subscriber
Engine / SDK：AccountTradingEngine / AccountTradingEngineClient
Venue 访问：AccessClient / AccessListener
内部组件：Java 领域名词
基础设施：Channel / Journal
```

对应关系：

```text
OrderCommandService        <-> OrderCommandClient
ExecutionEventPublisher    <-> ExecutionEventSubscriber
AccountTradingEngine       <-> AccountTradingEngineClient
AccessClient               <-> AccessListener
```

最终名称：

```text
engine-sdk
  AccountTradingEngineClient
  OrderCommandClient
  ExecutionEventSubscriber
  StrategyLeaseClient

access-sdk
  AccessClient
  AccessListener
  AccessConfig
  SequenceGuard

AccountTradingEngine
OrderCommandService
ExecutionEventPublisher
ExecutionEventChannel
MarketDataPublisher
AccountLifecycle
StrategyLeaseRegistry
LeaseMonitor
AccountRiskGuard
ExecutionReportRouter
OrderRegistry
PositionLedger
OrderIdAllocator
AccountHealth
AccountReconciler
AsyncJournal
```

`AccountTradingEngine` 是应用服务，不是领域实体、聚合根或对外服务。

---

## 10. 开放问题

1. ORS 回报乱序、重复、缺失时的标准处理矩阵。
2. 订单已 FILLED 但 TradeEvent 长时间未到的超时阈值。
3. StrategyLease 的 heartbeatInterval / ttl / scanInterval 取值。
4. AccountRiskGuard 的账户级限额字段和来源。
5. AsyncJournal 的保留周期和重放起点。
6. orderRef 在 CTP session 重启后的续号规则。
7. AccountHealth 的字段是否只读，还是允许组件主动上报。

---

## 11. 一句话

```text
AccountTradingEngine 是每账户一份的账户级交易应用服务；
对外提供订单命令服务和执行事件；
对内编排订单、成交、仓位、风控、对账和生命周期；
通过 AccessClient 发送和接收，与 ORS 通信；
不持有期权腿、Greeks、密码或 ORS 登录。
```

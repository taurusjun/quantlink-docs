# V1 Access 层实施方案

- 日期：2026-11-15
- 状态：SUPERSEDED（2026-11-17）
- 范围：历史方案，不再实施
- 前置：[`access-architecture.md`](access-architecture.md)

> **不要按本文实施。**
>
> 本文的 `AccessSDK -> AccessRuntime -> SimExchange adapter` 是旧方案。
> 当前方案是 AccessSDK 直接连接 venue-contract 进程：
>
> ```text
> SIM:  AccessSDK <-> SimVenue
> LIVE: AccessSDK <-> CTP adapter（venue-contract）<-> CTP
> ```
>
> 当前计划见
> [`../superpowers/plans/2026-11-17-fasttrade-access-simvenue.md`](../superpowers/plans/2026-11-17-fasttrade-access-simvenue.md)。

## 0. 定稿边界

```text
一个 TradeBot
  = 一个 account
  = 一个 ORS
  = 一个 MD 登录
```

第一期不做：

```text
多账户共享 ORS
多客户端共享账户
多 venue
MD 共享
mdQueue[venue]
多租户
外部量化系统 Gateway
```

传输：

```text
Aeron IPC：aeron:ipc
不使用 trading 自定义 raw SHM
不是 TCP/HTTP
```

## 1. 进程拓扑

```text
TradeBot 进程
  └─ AccessSDK
        ↕ Aeron IPC（aeron:ipc）
AccessRuntime 进程（单账户）
  ├─ SimExchange adapter     （测试）
  └─ ORS + MD adapter        （实盘）

Control Plane
  ├─ AccessConfigCenter
  └─ ControlPanel

Agent
  └─ 启停 AccessRuntime / TradeBot
```

CTP `TraderApi/MdApi` 在 AccessRuntime / ORS adapter 内，不进入 TradeBot。

## 2. Access 层组件

```text
AccessRuntime
├─ AdapterFactory
│   ├─ SimExchangeAdapter
│   └─ OrsMdAdapter
├─ MarketDataHub
│   ├─ subscribe
│   ├─ normalize
│   ├─ sequence
│   └─ Aeron MD publisher
├─ OrderGateway
│   ├─ Aeron order subscriber
│   ├─ validate
│   ├─ route to adapter
│   └─ dedup clientOrderId
├─ ExecutionHub
│   ├─ adapter order/trade callback
│   ├─ normalize
│   ├─ Aeron execution publisher
│   └─ dedup tradeId
├─ AccountSession
│   ├─ account snapshot
│   ├─ position snapshot
│   ├─ tradingDay
│   ├─ login/settlement state
│   └─ session state
└─ StatusReporter
    └─ 上报 AccessConfigCenter / ControlPanel
```

`AccessSDK`：

```text
AccessSDK
├─ MD subscription
├─ Execution subscription
├─ Account/Session subscription
├─ mdQueue
├─ executionQueue
└─ 供 TradeBot 的 SdkEventDispatcher 消费
```

## 3. Aeron 流

第一期每个 AccessRuntime 只有一套流：

| 流 | 方向 | 内容 |
|---|---|---|
| `access-md` | AccessRuntime → TradeBot | 行情 |
| `access-order` | TradeBot → AccessRuntime | 下单/撤单 |
| `access-execution` | AccessRuntime → TradeBot | 订单更新/成交 |
| `access-account` | AccessRuntime → TradeBot | 账户/持仓快照 |
| `access-session` | AccessRuntime → TradeBot | 交易时段/登录状态 |

配置来源：

```text
access_ors_instance
  md_channel / md_stream
  order_channel / order_stream
  execution_channel / execution_stream
  account_channel / account_stream
  session_channel / session_stream
```

不硬编码 `1001` 等值。

## 4. 事件契约

### MD

```text
MdEvent
├─ venueId
├─ orsId
├─ exchange
├─ instrumentId
├─ sourceSessionId
├─ sourcePublicationEpoch
├─ seq
├─ bids[]
├─ asks[]
├─ lastPrice
├─ volume
├─ openInterest
└─ timestampNanos
```

MD 不带 accountId。  
第一期虽然只有一个账户，也不把账户写进行情。

### OrderRequest

```text
OrderRequest
├─ requestId
├─ accountId
├─ clientOrderId
├─ strategyKey
├─ instrumentId
├─ exchange
├─ side
├─ offset
├─ price
├─ qty
├─ timeInForce
└─ timestampNanos
```

### OrderUpdate

```text
OrderUpdate
├─ clientOrderId
├─ exchangeOrderId
├─ accountId
├─ instrumentId
├─ status
├─ filledQty
├─ remainingQty
├─ avgPrice
├─ reason
├─ sequence
├─ terminal
└─ timestampNanos
```

### Trade

```text
Trade
├─ venueId
├─ tradingDay
├─ tradeId
├─ clientOrderId
├─ accountId
├─ instrumentId
├─ side
├─ offset
├─ price
├─ qty
├─ fee
├─ feeKnown
└─ timestampNanos
```

### Account / Position / Session

```text
AccountSnapshot
  accountId / balance / available / margin / tradingDay

PositionSnapshot
  accountId / instrument / longQty / shortQty / avgPrice / asOf

SessionEvent
  venueId / accountId / orsId / tradingDay
  loginState / settlementState / state / asOf
```

## 5. AccessRuntime 内部流程

### 行情

```text
SimExchange / CTP MdApi
  -> adapter callback
  -> MarketDataHub
  -> access-md
  -> AccessSDK
```

规则：

- 单账户，单 MD 登录；
- 按 `(venue, exchange, instrument)` 保序；
- `seq` 检测；
- 行情可丢/可合并，但必须计数；
- 不阻塞 adapter 回调线程。

### 下单

```text
TradeBot
  -> access-order
  -> OrderGateway
  -> validate account/session/entitlement
  -> SimExchangeAdapter / OrsMdAdapter
  -> venue
```

规则：

- `clientOrderId` 幂等；
- 账户/venue 必须匹配；
- session 非 READY 时拒绝新开仓；
- 撤单始终允许；
- adapter 不可用时返回明确错误，不静默丢。

### 回报

```text
venue
  -> adapter callback
  -> ExecutionHub
  -> access-execution
  -> AccessSDK
```

规则：

- `OrderUpdate` 按 `clientOrderId` 保序；
- `Trade` 按 `(venue, tradingDay, tradeId)` 去重；
- 未知 `clientOrderId` 记录 orphan，不静默丢；
- execution 事件不可静默丢。

## 6. 队列与背压

AccessRuntime 内部：

```text
mdQueue
  - 有界
  - 满 -> 丢弃 + 计数

executionQueue
  - 有界
  - 满 -> fatal / reduce-only
```

AccessSDK 内部：

```text
mdQueue
  - 有界
  - 可丢/可合并

executionQueue
  - 有界
  - 不可静默丢
```

第一期只有一条 MD 队列和一条 execution 队列，不做多 venue 轮询。

## 7. AccessConfigCenter

管理：

```text
ors_instance
md_source
account
credential_ref
adapter_kind
enabled
```

表建议：

```text
access_ors_instance
  ors_id
  venue_id
  adapter_kind          SIM / ORS
  order_channel
  order_stream
  execution_channel
  execution_stream
  md_channel
  md_stream
  account_channel
  account_stream
  session_channel
  session_stream
  enabled

access_account
  account_id
  venue_id
  ors_id
  broker_id
  investor_id
  credential_ref
  enabled

access_md_source
  md_source_id
  ors_id
  venue_id
  md_login_ref
  enabled
```

约束：

```text
一个 account 只能绑定一个 ORS
一个 ORS 只能绑定一个 account（第一期）
凭据只存 secret_ref，不存明文
面板不返回密码
```

## 8. 状态与监控

AccessRuntime 上报：

```text
AccessStatus
├─ orsId
├─ venueId
├─ accountId
├─ mdState         CONNECTED / LOGIN / READY / DOWN
├─ orderState      CONNECTED / READY / DOWN
├─ loginState
├─ settlementState
├─ tradingDay
├─ balance
├─ available
├─ margin
├─ lastMdAt
├─ lastOrderAt
└─ asOf / stale
```

来源：

```text
VenueSession
AccountSnapshot
PositionSnapshot
adapter health
```

控制面板只读：

```text
ORS 登录状态
MD 登录状态
账户登录状态
账户余额/可用/保证金
最后更新时间
```

不要由面板推导或直接轮询 CTP。

## 9. 失败处理

| 故障 | 动作 |
|---|---|
| MD 断流 | `mdState=DOWN`，新开仓拒绝，撤单/平仓允许 |
| 订单通道断开 | `orderState=DOWN`，拒绝新单，保留撤单重试 |
| 账户未登录 | 拒绝开仓，允许查询/撤单 |
| AccessRuntime 崩溃 | TradeBot 检测 session DOWN；Agent 重启；从账户快照恢复 |
| executionQueue 满 | fatal / reduce-only，不静默丢 |
| mdQueue 满 | 丢弃 + 计数 + stale 标记 |
| 重复 `clientOrderId` | 拒绝重复提交，返回已有状态 |
| 未知回报 | orphan 记录/告警 |

## 10. 测试与验收

### SimExchange E2E

```text
1. 启动 AccessRuntime（SimExchange adapter）
2. AccessSDK 连接
3. 订阅 MD
4. 下单
5. 收到 OrderUpdate/Trade
6. 收到 Account/Position/Session
7. 撤单
```

### 必测场景

```text
- MD 订阅/退订
- 下单/撤单/拒单
- 部分成交/全部成交
- 重复 clientOrderId
- 重复 tradeId
- executionQueue 满
- mdQueue 满
- adapter 断线/重连
- session 非 READY 拒绝开仓
- AccessRuntime 重启
```

### 验收指标

```text
md_dropped_total
md_gap_total
execution_dropped_total = 0
execution_fatal_total
order_submit_latency
order_update_latency
account_snapshot_age_ms
```

## 11. 实施顺序

1. 定义 Access 事件契约与 Aeron stream 配置。
2. 搭建 AccessRuntime 骨架 + SimExchange adapter。
3. 实现 MD 订阅/归一化/发布。
4. 实现 order submit/cancel + execution 回报。
5. 实现 account/position/session 快照。
6. 实现 AccessSDK 客户端 + 测试客户端。
7. 实现 AccessConfigCenter + secret_ref + 状态上报。
8. 接 ControlPanel。
9. 实现 OrsMdAdapter。
10. TradeBot 接入 AccessSDK。

## 12. 不在本期

```text
多账户
多客户端共享账户
多 venue
MD 共享
AccessRuntime 多活
外部量化系统 Gateway
StrategyConfigCenter 集成
TradeBot 运行状态上报
```

TradeBot 的策略配置、状态持久化、PnL 上报放到下一步。

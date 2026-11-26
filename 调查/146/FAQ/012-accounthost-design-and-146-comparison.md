# AccountHost 设计与 146 对比

- 日期：2026-11-19
- 状态：DRAFT（设计文档，未写代码）
- 范围：新 FastTrade 的账户级运行时 `AccountHost`，以及它与 146 原始 TradeBot/ORS 的对比
- 关联：`009-account-isolated-new-system-structure.md`、`010-accounthost-responsibilities.md`

---

## 1. 结论摘要

`AccountHost` 是一个账户的交易协调器：

```text
1 Account = 1 ORS = 1 AccountHost = 1 AccessClient
1 Strategy = 1 StrategyProcess
```

它负责：

- 账户内唯一的订单发布；
- 账户级 `clientOrderId` / `orderRef` 生成与映射；
- 订单状态机；
- 成交归属与向策略进程路由；
- 策略级仓位账本与账户级对账；
- 账户级风控与 arm 门禁；
- 异步持久化；
- 故障时的撤单、隔离和恢复。

它不负责：

- 策略信号、指标、目标仓位；
- 策略级风控；
- 行情分发；
- 交易所会话；
- GUI。

核心设计原则：

```text
热路径只读内存、只写内存
DB 只做异步 write-behind、审计、冷启动基线
崩溃恢复以 ORS/CTP 快照为最终对账源
归属键显式化，绝不按合约/方向/数量猜
```

---

## 2. 设计目标

### 2.1 目标

1. **账户隔离**：一个账户一个 ORS、一个 AccountHost、一个 AccessClient、一套 ID/映射/仓位/风控。
2. **策略隔离**：一个策略一个 StrategyProcess；一个策略崩溃不影响其他策略。
3. **低延迟订单路径**：下单、成交、撤单不依赖同步 DB。
4. **可靠归属**：CTP 成交能准确回到 `strategyKey`。
5. **可恢复**：AccountHost/ORS 重启后能撤单、对账、恢复策略仓位。
6. **可扩展**：增加策略只改配置 + `Strategy` 实现 + `StrategyFactory`。
7. **可观测**：所有订单/成交/异常都能按 account/strategy 追踪。

### 2.2 非目标

- 不做账户级对冲、组合优化；
- 不做跨账户净额；
- 不做旧 146 状态/文件迁移；
- 不做 ZMQ 控制面；
- 不复用旧 DataService；
- 不做单 ORS 多 Account；
- 不做单进程多策略；
- 不在热路径做同步 DB 读写。

---

## 3. 设计原则

### 3.1 关注点分离

```text
StrategyProcess：交易判断
AccountHost：账户交易协调
ORS：柜台/交易所会话
AccessClient：Aeron/SBE 传输适配
BotGateway：只读数据/控制网关
BotSupervisor：进程生命周期
```

AccountHost 不跑策略，StrategyProcess 不持有 AccessClient。

### 3.2 账户内单写者

一个账户的订单发布、订单状态、成交归属、仓位账本只有一个写者：AccountHost。

这消除了：

- 多进程竞争同一个 `clientOrderId`；
- 同一账户多个订单发布者；
- 成交归属竞态；
- 多份账户快照不一致。

### 3.3 热路径内存化

订单路径不允许：

- `SELECT`；
- 同步 `INSERT/UPDATE`；
- 等待 DB 事务；
- 等待 DB 生成 ID。

所有热路径状态在 AccountHost 内存中，DB 通过异步事件队列写入。

### 3.4 归属键显式化

CTP 原始成交没有内部 `clientOrderId`。归属必须依赖显式关联键：

```text
orderRef          -> clientOrderId    主关联
exchangeOrderId   -> clientOrderId    辅助关联
clientOrderId     -> strategyKey      业务归属
tradeId           -> 已应用           幂等
```

禁止按 `instrument + side + qty + price` 猜。

### 3.5 失败关闭

任何无法唯一归属、无法确认状态、无法对账的情况：

```text
fail closed
```

不猜测、不静默丢弃、不把成交随便归给某个策略。

### 3.6 背压优先于阻塞

异步持久化队列有界：

- 队列满：停止新单；
- DB 滞后：账户 disarmed；
- 绝不阻塞订单线程等待 DB。

### 3.7 以柜台为最终事实源

DB 是异步投影，可能落后。恢复时：

```text
DB 基线 + ORS/CTP 快照
```

以 ORS/CTP 的订单/持仓为最终对账源。

---

## 4. 系统上下文

```text
                         GUI / Control Plane
                                │
                         WebSocket/HTTPS
                                │
                         BotGateway（只读）
                                │
┌────────────────────────── Server ──────────────────────────┐
│                                                            │
│  BotSupervisor                                             │
│    ├─ ORS（每 Account 一个）                               │
│    ├─ AccountHost（每 Account 一个）                       │
│    │    ├─ OrderGateway                                    │
│    │    ├─ AccountRiskGate                                 │
│    │    ├─ IdAllocator                                     │
│    │    ├─ OrderRegistry                                   │
│    │    ├─ ExecutionRouter                                 │
│    │    ├─ PositionLedger                                  │
│    │    ├─ AccountReconciler                               │
│    │    ├─ AsyncJournal                                    │
│    │    └─ Health                                          │
│    ├─ StrategyProcess A                                    │
│    ├─ StrategyProcess B                                    │
│    └─ StrategyProcess C                                    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

多账户时：

```text
Server
  ├─ AccountHost A + ORS A + StrategyProcess A1/A2
  ├─ AccountHost B + ORS B + StrategyProcess B1/B2
  └─ 共享 BotSupervisor / BotGateway
```

每个 Account 的 ORS、AccessClient、stream base、DB key、counter、映射、仓位、风控、日志独立。

---

## 5. AccountHost 组件

| 组件 | 职责 |
|---|---|
| `OrderGateway` | 接收本机 IPC 的 `OrderIntent` / `CancelIntent`；校验 `strategyKey`、账户、幂等键 |
| `AccountRiskGate` | 账户级预交易风控；使用缓存参数，不查 DB |
| `IdAllocator` | 内存生成 `clientOrderId` 和 `orderRef`；不依赖同步 DB |
| `OrderRegistry` | 内存订单状态机；维护所有订单和索引 |
| `ExecutionRouter` | 按 `orderRef/exchangeOrderId` 找 `clientOrderId`，再找 `strategyKey` |
| `PositionLedger` | 策略级仓位、账户净仓、成交账本 |
| `AccountReconciler` | ORS 快照 vs 内存/DB 仓位；启动和周期对账 |
| `AsyncJournal` | 有界事件队列 + 单写线程，异步批量落库 |
| `Health` | ready、arm、对账状态、持久化滞后、orphan 计数 |
| `Lifecycle` | 启动、恢复、arm/disarm、优雅关闭、租约 |

---

## 6. 核心领域模型

### 6.1 订单状态机

#### 6.1.1 状态定义

| 状态 | 含义 |
|---|---|
| `NEW` | 内存订单已创建，尚未提交 |
| `SUBMITTING` | 已投递给 AccessClient/ORS，等待确认 |
| `ACKED` | 柜台已接受，尚无成交 |
| `PARTIAL` | 有成交或有部分撤单，但仍有 open qty |
| `FILLED` | 全部成交 |
| `CANCELED` | 剩余数量全部撤销（可能已有部分成交） |
| `CANCELING` | 撤单已发出，等待确认 |
| `CANCEL_REJECTED` | 撤单被拒，临时状态，回到原 live 状态 |
| `MODIFYING` | 改单已发出，等待确认（可选） |
| `MODIFY_REJECTED` | 改单被拒，临时状态，回到原 live 状态（可选） |
| `REJECTED` | 新单被拒 |
| `UNKNOWN` | 超时/丢回报，状态未知，不是终态 |
| `ORPHAN` | 无法归属到任何订单，异常终态，需对账/人工处理 |

`state` 只表达订单生命周期。  
不要定义 `PARTIAL_WORKING`、`ACKED_WORKING` 这类复合状态；是否还在排队由 `remainingWorking` 表达。

#### 6.1.2 状态转移

```text
NEW
  -> SUBMITTING
       -> ACKED
       -> PARTIAL
       -> FILLED
       -> REJECTED
       -> UNKNOWN

ACKED
  -> PARTIAL
  -> FILLED
  -> CANCELING
  -> MODIFYING

PARTIAL
  -> FILLED
  -> CANCELING
  -> MODIFYING

ACKED/PARTIAL
  -> CANCELING
       -> CANCELED
       -> PARTIAL                 # 部分撤单，仍有 open qty
       -> CANCEL_REJECTED -> ACKED/PARTIAL

ACKED/PARTIAL
  -> MODIFYING                   # 仅当系统支持改单
       -> ACKED/PARTIAL
       -> MODIFY_REJECTED -> ACKED/PARTIAL

SUBMITTING/ACKED/PARTIAL/CANCELING/MODIFYING
  -> UNKNOWN
       -> ACKED/PARTIAL/FILLED/CANCELED/REJECTED/ORPHAN   # 通过对账离开
```

转移表：

| From | 触发 | To | 说明 |
|---|---|---|---|
| `NEW` | 提交 | `SUBMITTING` | 已交给 AccessClient/ORS |
| `SUBMITTING` | `Accepted + NoTradeQueueing` | `ACKED` | 已接受，无成交，剩余在排队 |
| `SUBMITTING` | `Accepted + NoTradeNotQueueing` | `ACKED` | 已接受，无成交，剩余未排队 |
| `SUBMITTING` | `Accepted + PartTradedQueueing` | `PARTIAL` | 部分成交，剩余在排队 |
| `SUBMITTING` | `Accepted + PartTradedNotQueueing` | `PARTIAL` | 部分成交，剩余未排队 |
| `SUBMITTING` | `Accepted + AllTraded` | `FILLED` | 全部成交；仓位等 Trade |
| `SUBMITTING` | `InsertRejected` / `ORDER_ERROR` | `REJECTED` | 新单被拒 |
| `SUBMITTING/ACKED/PARTIAL/CANCELING/MODIFYING` | ACK 丢失/超时/未知 | `UNKNOWN` | 不能猜，进入对账 |
| `ACKED` | 部分成交 | `PARTIAL` | openQty 仍大于 0 |
| `ACKED` | 全部成交 | `FILLED` | openQty = 0 |
| `ACKED/PARTIAL` | 发撤单 | `CANCELING` | 撤单在途 |
| `CANCELING` | 全部撤单确认 | `CANCELED` | 剩余 openQty = 0 |
| `CANCELING` | 部分撤单确认 | `PARTIAL` | 仍有 openQty，可继续撤 |
| `CANCELING` | 撤单拒绝 | `CANCEL_REJECTED` | 临时状态，回到 `ACKED/PARTIAL` |
| `ACKED/PARTIAL` | 发改单 | `MODIFYING` | 仅支持改单时 |
| `MODIFYING` | 改单确认 | `ACKED/PARTIAL` | 回到 live 状态 |
| `MODIFYING` | 改单拒绝 | `MODIFY_REJECTED` | 临时状态，回到 `ACKED/PARTIAL` |
| `UNKNOWN` | 对账 | `ACKED/PARTIAL/FILLED/CANCELED/REJECTED/ORPHAN` | 落回真实状态或异常 |

`CANCEL_REJECTED` 和 `MODIFY_REJECTED` 不是终态，必须回到撤单/改单前的 live 状态。  
`RECONCILED` 不是状态，是 `UNKNOWN` 通过对账落到真实状态的过程。

同一状态内的更新：

```text
ACKED -> ACKED
  NoTradeQueueing / NoTradeNotQueueing 变化
  只更新 remainingWorking，状态不变

PARTIAL -> PARTIAL
  继续部分成交或部分撤单
  OrderUpdate 更新 filledQty / canceledQty / openQty
  Trade 更新 appliedFilledQty
  状态不变
```

#### 6.1.3 正常流程

```text
NEW
  -> SUBMITTING
  -> ACKED / PARTIAL / FILLED
```

第一条回报不一定是 `ACKED`，可能是：

```text
ACKED
PARTIAL
FILLED
REJECTED
UNKNOWN
```

所以允许直接从 `SUBMITTING` 进入：

```text
SUBMITTING -> ACKED
SUBMITTING -> PARTIAL
SUBMITTING -> FILLED
SUBMITTING -> REJECTED
SUBMITTING -> UNKNOWN
```

不需要先伪造一个 `ACKED`。

部分成交：

```text
ACKED -> PARTIAL
```

全部成交：

```text
ACKED/PARTIAL -> FILLED
```

`PARTIAL` 可以继续部分成交，状态仍是 `PARTIAL`，直到：

```text
openQty = 0 -> FILLED
```

#### 6.1.4 撤单与改单

撤单：

```text
ACKED/PARTIAL -> CANCELING
```

三种结果：

```text
CANCELING -> CANCELED         # 剩余全部撤掉
CANCELING -> PARTIAL          # 部分撤掉，仍有 openQty
CANCELING -> CANCEL_REJECTED -> ACKED/PARTIAL
```

`CANCELED` 可能已经有部分成交：

```text
filledQty > 0
canceledQty > 0
openQty = 0
```

改单（可选）：

```text
ACKED/PARTIAL -> MODIFYING
  -> ACKED/PARTIAL
  -> MODIFY_REJECTED -> ACKED/PARTIAL
```

如果 v1 不支持改单，可以不启用 `MODIFYING` / `MODIFY_REJECTED`。

#### 6.1.5 `UNKNOWN` 与 `ORPHAN`

`UNKNOWN` 的来源：

```text
ACK 丢失
超时
回报顺序异常
本地无法判断当前状态
撤单/改单确认丢失
```

`UNKNOWN` 不是终态，只能通过对账离开：

```text
UNKNOWN -> ACKED
UNKNOWN -> PARTIAL
UNKNOWN -> FILLED
UNKNOWN -> CANCELED
UNKNOWN -> REJECTED
UNKNOWN -> ORPHAN
```

`ORPHAN` 的来源：

```text
orderRef 找不到 clientOrderId
orderRef/clientOrderId 不一致
成交无法归属到任何订单
```

`ORPHAN` 是异常终态：

- 不能按普通挂单继续推进；
- 不能自行猜测归属；
- 必须进入对账/人工处理。

#### 6.1.6 数量字段与不变量

`OrderState` 使用：

```text
filledQty         柜台口径已成交量，来自 CTP VolumeTraded
appliedFilledQty  已应用到仓位账本的成交量，来自 Trade 事件
canceledQty       已撤销数量
openQty           剩余数量
```

`fillsPending`：

```text
filledQty > appliedFilledQty
```

表示柜台已成交，但 Trade 事件还没全部应用。

对已进入 `ACKED` / `PARTIAL` / `FILLED` / `CANCELED` 的订单，基本不变量：

```text
filledQty + canceledQty + openQty = qty
```

仓位账本只使用 `appliedFilledQty`，不使用 `filledQty`。  
`REJECTED` / `ORPHAN` / `UNKNOWN` 不强制套用这个不变量；它们的数量字段可能不完整，必须靠对账/审计处理。

状态与数量：

```text
ACKED:
  filledQty = 0
  canceledQty = 0
  openQty = qty

PARTIAL:
  openQty > 0
  且 filledQty > 0 或 canceledQty > 0

FILLED:
  openQty = 0
  filledQty = qty

CANCELED:
  openQty = 0
  canceledQty > 0
  可能有 filledQty > 0
```

如果数量不变量被破坏：

```text
进入 UNKNOWN / 对账
```

不能用状态名猜数量。

#### 6.1.7 `remainingWorking` 正交字段

`remainingWorking` 不是状态，而是 `OrderState` 上的额外字段：

```text
true     剩余 openQty 还在排队/工作
false    剩余 openQty 不在排队/工作
unknown  无法确定，需对账
```

示例：

```text
ACKED + openQty=10 + remainingWorking=true
ACKED + openQty=10 + remainingWorking=false
PARTIAL + openQty=5 + remainingWorking=true
PARTIAL + openQty=5 + remainingWorking=false
```

用途：

- 判断撤单是否有意义；
- 判断剩余数量是否真的在市场上；
- 策略决定是否重挂/改价/撤单；
- 对账时判断本地订单是否还在工作。

`openQty > 0` 不代表一定在工作：

```text
openQty > 0 + remainingWorking=false
```

表示还有未成交/未撤销数量，但它当前不在排队。  
这种情况必须结合 `venueOrderStatus` 和对账处理，不能当成普通挂单。

#### 6.1.8 终态与关联保留

正常终态：

```text
FILLED
CANCELED
REJECTED
```

异常终态：

```text
ORPHAN
```

规则：

- 终态不能重新打开；
- 终态从活跃索引移除；
- `orderRef -> clientOrderId` 保留一段保留期；
- 迟到成交仍要更新仓位/审计；
- 重复成交按 `tradeId` 幂等；
- `FILLED` 表示柜台口径全部成交，`filledQty = qty`；可能仍有 `appliedFilledQty < filledQty`、`fillsPending=true`，仓位以 Trade 事件为准；
- `CANCELED` 如果在撤销前有部分成交，也可能仍有 `appliedFilledQty < filledQty`、`fillsPending=true`。

### 6.2 OrderState

```text
OrderState
  accountId
  strategyKey
  clientOrderId
  orderRef
  exchangeOrderId
  requestId
  instrument
  side
  offsetFlag
  qty
  price
  state
  filledQty
  appliedFilledQty
  canceledQty
  openQty
  remainingWorking
  venueSubmitStatus
  venueOrderStatus
  fillsPending
  avgPrice
  tradingDay
  createdAt
  updatedAt
```

`strategyKey` 在下单时确定，订单生命周期内不可变。

### 6.3 内存索引

```text
clientOrderId     -> OrderState
orderRef          -> clientOrderId
exchangeOrderId   -> clientOrderId
strategyKey       -> 该策略的订单集合
requestId         -> clientOrderId
tradeId           -> 已应用成交
```

`clientOrderId -> strategyKey` 不需要单独表；它就在 `OrderState.strategyKey`。

---

## 7. 标识与关联关系

### 7.1 字段职责

| 字段 | 谁生成 | 说明 |
|---|---|---|
| `requestId` | StrategyProcess | 策略意图幂等键 |
| `clientOrderId` | AccountHost | 内部订单主键，账户内唯一 |
| `orderRef` | 我们（AccountHost/ORS 客户端侧） | 填入 CTP InputOrder，CTP 原样回显 |
| `exchangeOrderId` | 交易所 | CTP `OrderSysID`，可能为空/晚到 |
| `tradeId` | 交易所 | CTP `TradeID`，成交幂等 |
| `strategyKey` | 配置/策略注册 | 业务归属 |

关键事实：

```text
OrderRef 不是 CTP 分配的
OrderRef 是我们下单时填的
CTP 只负责在订单/成交回报里带回
OrderSysID 才是交易所分配的
clientOrderId 不是 CTP 字段
```

### 7.2 映射关系

```text
orderRef        -> clientOrderId    主关联，CTP 成交可靠
exchangeOrderId -> clientOrderId    辅助，可能为空/变化
clientOrderId   -> strategyKey      业务归属，一笔单一个策略
tradeId         -> 已应用           幂等，不参与归属
```

`exchangeOrderId` 和 `clientOrderId` 不是强推导关系：

- `clientOrderId` 下单前知道；
- `exchangeOrderId` 订单被交易所接受后才知道；
- 改单/重发后交易所可能给新的 `OrderSysID`；
- 所以它只能做辅助键，不能做主键。

### 7.3 ID 生成

`clientOrderId`：

```text
账户内单调序列，或 Snowflake
64 位，内存生成
不查 DB
```

默认不采用 146 的：

```text
clientId * 1,000,000 + seq
```

原因：

- 146 的 `clientId` 是 Connector/进程注册 ID，不是策略 ID；
- 新系统一个 AccountHost 只有一个 AccessClient，没有 per-TB clientId；
- `1,000,000` 号段可能溢出；
- 账户已经是隔离边界，不需要再编码 clientId。

如果确实需要编码实例（例如 HA/多实例），用：

```text
AccountHost instanceId * RANGE + seq
```

而不是 146 的 per-TB `clientId`。

`orderRef`：

```text
CTP 客户端侧 12 位数字序列
启动时从 CTP MaxOrderRef + 1 续号
内存递增
不查 DB
```

映射保留：

```text
orderRef -> clientOrderId
```

不做 `clientOrderId` 与 `orderRef` 的强制自关联；两者职责不同。

---

## 8. 关键流程

### 8.1 下单

```text
StrategyProcess
  -> OrderIntent(requestId, strategyKey, instrument, side, offset, qty, price)
  -> OrderGateway
       1. 校验 strategyKey/账户
       2. requestId 幂等检查
       3. AccountRiskGate
       4. clientOrderId = IdAllocator.nextClientOrderId()
       5. orderRef      = IdAllocator.nextOrderRef()
       6. OrderRegistry.create(OrderState)
       7. 建立 orderRef -> clientOrderId
       8. AsyncJournal.append(OrderSubmitted)
       9. AccessClient.submit(clientOrderId, orderRef, ...)
  -> ORS -> CTP
```

注意：

- 第 8 步是投递到内存队列，不是同步 DB；
- `orderRef` 在发单前已经存在，CTP 回报不会早于映射建立；
- `OrderState` 在发单前创建，后续 ACK/REJECT 都能落地。

### 8.2 订单回报

```text
ORS OrderUpdate
  -> AccountHost
       1. 按 orderRef 找 clientOrderId
       2. 找不到则按 exchangeOrderId 找
       3. 更新 state / venueSubmitStatus / venueOrderStatus
       4. 更新 filledQty / canceledQty / openQty / remainingWorking
       5. 更新 fillsPending = (filledQty > appliedFilledQty)
       6. 记录 exchangeOrderId（如果首次出现）
       7. AsyncJournal.append(OrderEvent)
```

### 8.3 成交

```text
CTP TRADE
  -> ORS
  -> AccessClient
  -> AccountHost
       1. orderRef -> clientOrderId
       2. 找不到则 exchangeOrderId -> clientOrderId
       3. 仍找不到 -> orphan
       4. (accountId, tradingDay, tradeId) 幂等检查
       5. 更新 OrderState.appliedFilledQty / avgPrice
       6. 更新 fillsPending = (filledQty > appliedFilledQty)
       7. 更新 PositionLedger
       8. 路由 FillEvent 给 OrderState.strategyKey
       9. AsyncJournal.append(TradeEvent)
```

归属顺序：

```text
orderRef
  > exchangeOrderId
  > orphan
```

如果适配层同时给了 `clientOrderId`：

- 校验它与 `orderRef` 映射一致；
- 不一致拒绝，不能静默选一个。

### 8.4 撤单

```text
StrategyProcess
  -> CancelIntent(strategyKey, clientOrderId)
  -> AccountHost
       1. 校验订单属于该 strategyKey
       2. 状态允许撤单
       3. 优先用 exchangeOrderId 撤
       4. 没有则用 orderRef 撤
       5. 都没有 -> fail closed
       6. AsyncJournal.append(CancelRequested)
```

撤单回报同样按 `orderRef` / `exchangeOrderId` 归属。

### 8.5 启动与恢复

```text
1. 加载配置、连接 DB（只做批量恢复读）
2. 启动 ORS，等待 session READY
3. 启动 AccountHost/AccessClient，等待 READY
4. 加载 DB 基线：
   - open orders
   - strategy positions
   - last checkpoints
5. 从 ORS/CTP 拉快照：
   - open orders
   - recent trades
   - positions
6. 重建内存索引：
   orderRef -> clientOrderId
   exchangeOrderId -> clientOrderId
   clientOrderId -> OrderState(strategyKey)
7. 对账：
   - ORS 有、DB 没有的挂单 -> orphan，撤销/告警
   - DB 有、ORS 没有的挂单 -> 标记终态
   - 账户净仓 != sum(策略仓位) -> fail closed
8. 启动 StrategyProcess
9. 对账通过后，按策略 arm
```

默认：

```text
armed = false
```

对账失败保持 disarmed。

---

## 9. 异步持久化

### 9.1 事件类型

```text
OrderSubmitted
OrderAck
OrderRejected
OrderCancelRequested
OrderCanceled
TradeApplied
OrphanDetected
ReconcileSnapshot
```

每个事件带：

```text
accountId
accountSeq（单调递增）
clientOrderId
orderRef
strategyKey
eventType
payload
timestamp
```

### 9.2 写入模型

```text
AccountHost 内存
  -> bounded MPSC queue
  -> 单写线程
  -> 批量 upsert
  -> PostgreSQL
```

规则：

- 队列满：停止新单；
- DB 写失败：degraded；
- 滞后超过阈值：disarm；
- 优雅关闭：flush；
- 崩溃：允许丢最后一小段，恢复靠 ORS 快照。

### 9.3 DB 表

```text
order_event
  account_id, account_seq, client_order_id, order_ref, event_type, payload, ts

order_state
  account_id, client_order_id, strategy_key, order_ref, exchange_order_id,
  instrument, side, qty, price, state, filled_qty, applied_filled_qty,
  canceled_qty, open_qty, remaining_working, venue_submit_status,
  venue_order_status, fills_pending, trading_day, updated_at

trade_state
  account_id, trading_day, trade_id, client_order_id, order_ref,
  exchange_order_id, qty, price, applied_at

strategy_position
  account_id, strategy_key, instrument, qty, avg_price, updated_at

account_snapshot
  account_id, net_position, reconcile_state, updated_at

persistence_checkpoint
  account_id, last_account_seq, updated_at
```

约束：

```text
order_state: unique(account_id, client_order_id)
order_state: unique(account_id, trading_day, order_ref)
order_state: unique(account_id, trading_day, exchange_order_id) where not null
trade_state: primary key(account_id, trading_day, trade_id)
```

---

## 10. 故障模型

| 故障 | 影响 | 处理 |
|---|---|---|
| StrategyProcess 崩溃 | 该策略停单 | AccountHost 撤该策略挂单；其他策略继续 |
| AccountHost 崩溃 | 该账户所有策略停单 | supervisor 重启；DB + ORS 快照对账 |
| ORS 崩溃 | 该账户停交易 | 其他账户不受影响；重连后对账 |
| DB 故障 | 持久化滞后 | 交易可在阈值内继续；超阈值停止新单 |
| 异步队列满 | 持久化跟不上 | 停止新单，不能阻塞订单线程 |
| 成交找不到归属 | 无法路由 | orphan，fail closed，告警 |
| `orderRef` 冲突 | 可能串单 | 拒绝新单/告警，检查 IdAllocator |
| 账户净仓与策略仓不符 | 账实不符 | fail closed，人工/自动对账 |

---

## 11. 与 146 的对比

### 11.1 146 的结构

```text
TradeBot 进程 A（策略 A）
  ├─ CommonClient
  ├─ Connector（clientId A）
  └─ m_orderIDStrategyMap
        │
        ▼
      SHM request ──> ORS ──> CTP
        ▲
        │
      SHM response queue（共享）
        │
        ├─ TB A Connector：clientId 过滤
        └─ TB B Connector：clientId 过滤
```

146 生产部署：

```text
一个策略 = 一个 TradeBot 进程
一个 TradeBot = 一个 Connector/clientId
```

### 11.2 146 的标识链

```text
TB 本地 OrderID = clientId * 1,000,000 + seq
  -> TB m_orderIDStrategyMap[OrderID] = ExecutionStrategy*
  -> ORS 作为客户端侧生成并填入 CTP OrderRef
  -> ORS m_ordExchMap[OrderRef] = local OrderID
  -> ORS OrderInfo.OrderSysID = CTP OrderSysID
  -> CTP 回报 OrderRef
  -> ORS 查 m_ordExchMap -> local OrderID
  -> ResponseMsg.OrderID = local OrderID
  -> TB Connector 按 clientId 过滤
  -> TB ORScallback 查 m_orderIDStrategyMap -> ExecutionStrategy*
```

关键点：

- `clientId` 是 **Connector/进程注册 ID**，不是策略 ID；
- 生产一策略一进程时，效果上接近策略进程 ID；
- `--controlList` 多策略同进程时，同一 clientId 下靠 `m_orderIDStrategyMap` 再分；
- `OrderSysID` 主要留在 ORS 的 `OrderInfo` 里，TB 不靠它归属；
- `m_orderIDStrategyMap` 是进程内内存表，重启丢失；
- `RemoveOrder` 会删除映射，迟到回报可能查不到；
- 146 没有 DB，没有跨进程账户级路由，没有账户级对账。

### 11.3 146 为什么不需要 AccountHost

1. **每个策略自己发单**：出栈方向不需要中心路由。
2. **每个 TB 自己持有 Connector**：没有“一个账户一个 AccessClient”的约束。
3. **入栈用 clientId + 进程内 map 足够**：一个进程通常一个策略。
4. **没有 DB/账户级状态**：不需要集中订单/仓位持久化。
5. **账户级职责在 ORS/RMS**：ORS 管账户/柜台，RMS 管账户风控。
6. **GUI 手工单不经过 TB**：走 DataService/ORS。

代价：

- 没有账户级统一撤单；
- 没有账户级对账；
- 没有统一 `clientOrderId`；
- 没有跨重启恢复；
- `--controlList` 多策略同进程时全局 map 容易串。

### 11.4 对比表

| 维度 | 146 | 新 AccountHost |
|---|---|---|
| 账户边界 | 一个 ORS/账户；每个 TB 自己连 | 一个 AccountHost/账户 |
| 订单发布者 | 每个 TB 自己 | 账户内唯一 AccountHost |
| 进程模型 | 一策略一 TB（生产） | 一策略一 StrategyProcess |
| 本地订单 ID | `clientId * 1,000,000 + seq` | `clientOrderId`（账户内序列/Snowflake） |
| CTP 关联键 | ORS `OrderRef -> local OrderID` | `orderRef -> clientOrderId` |
| 交易所订单号 | ORS `OrderInfo.OrderSysID` | `exchangeOrderId -> clientOrderId` |
| 策略归属 | `m_orderIDStrategyMap[OrderID]` | `OrderState.strategyKey` |
| 回报过滤 | TB Connector 按 clientId | AccountHost 按 orderRef 路由 |
| 状态持久化 | 无 | 异步 DB 投影/审计 |
| 热路径 DB | 无 | 无 |
| 账户对账 | 无自动对账 | AccountReconciler |
| 账户级风控 | ORS/RMS + 策略内 | AccountRiskGate + 策略内 |
| 策略崩溃撤单 | 无统一保证 | AccountHost 撤该策略挂单 |
| 重启恢复 | 内存丢失 | DB 基线 + ORS 快照 |
| 多策略共享账户 | 多 TB/clientId | 多 StrategyProcess + 一个 AccountHost |

### 11.5 146 的 `clientId` 到底是什么

```text
clientId = Connector/ORS 客户端注册 ID
```

不是：

```text
账户 ID
策略 ID
稳定业务主键
```

生产一策略一进程时：

```text
clientId ≈ 策略进程 ID
```

但这是部署巧合，不是代码契约。

---

### 11.6 订单状态机对比

> Canonical 状态定义与转移以 `6.1` 为准；本节只比较 146 的实现和 CTP 状态映射，不另立一套状态。

#### 146 的状态枚举

```text
NEW_ORDER
NEW_CONFIRM
NEW_REJECT
MODIFY_ORDER
MODIFY_CONFIRM
MODIFY_REJECT
CANCEL_ORDER
CANCEL_CONFIRM
CANCEL_REJECT
TRADED
INIT
```

`INIT` 基本未使用；主路径是前 10 个。

#### 146 的主状态转移

```text
NEW_ORDER
  --NEW_ORDER_CONFIRM--> NEW_CONFIRM
  --NEW_ORDER_FREEZE / ORDER_ERROR / REJECT--> NEW_REJECT
        -> RemoveOrder

NEW_CONFIRM
  --TRADE（部分成交）--> NEW_CONFIRM       openQty > 0
  --TRADE（全部成交）--> TRADED
        -> RemoveOrder
  --发撤单--> CANCEL_ORDER
  --发改单--> MODIFY_ORDER

CANCEL_ORDER
  --CANCEL_ORDER_CONFIRM--> CANCEL_CONFIRM
        openQty <= 0 -> RemoveOrder
        否则保留 CANCEL_CONFIRM
  --CANCEL_ORDER_REJECT--> NEW_CONFIRM（主路径）

CANCEL_CONFIRM
  --TRADE（部分/全部）--> NEW_CONFIRM / TRADED
  --再次撤单--> 不允许（SendCancelOrder 只接受 NEW_CONFIRM / MODIFY_CONFIRM / MODIFY_REJECT）

MODIFY_ORDER
  --MODIFY_ORDER_CONFIRM--> MODIFY_CONFIRM
  --MODIFY_ORDER_REJECT--> MODIFY_REJECT

MODIFY_CONFIRM
  --TRADE（部分）--> NEW_CONFIRM
  --TRADE（全部）--> TRADED
  --撤单--> CANCEL_ORDER

MODIFY_REJECT
  --撤单--> CANCEL_ORDER
  --再改单--> MODIFY_ORDER（允许）
```

几个容易被忽略的点：

- 146 **没有显式 PARTIAL 状态**：部分成交后仍然是 `NEW_CONFIRM`，靠 `m_openQty > 0` 表达。
- 146 **没有 UNKNOWN**：ACK 丢失/超时没有状态，只有日志和“找不到就丢弃”。
- 146 的 `CANCEL_REJECT` 枚举存在，但主路径 `ORSCallBack` 在撤单被拒时把状态设回 `NEW_CONFIRM`，不是 `CANCEL_REJECT`。
- 146 的 `MODIFY_CONFIRM` 会一直保留，直到下一条成交把它改回 `NEW_CONFIRM`。
- 146 的 CTP `OrderStatus` partial 处理不完整，详见下面“146 对 CTP OrderStatus 的处理”。
- 146 的部分成交数量完全由 `OnRtnTrade` 的 `TRADE_CONFIRM` 驱动；TB 状态仍是 `NEW_CONFIRM + m_openQty > 0`。
- 146 的部分撤单后是 `CANCEL_CONFIRM` + `openQty > 0`；`SendCancelOrder` 不允许从 `CANCEL_CONFIRM` 再撤，剩余数量可能卡住，直到成交。
- 146 的终态 `TRADED`/`NEW_REJECT` 会调用 `RemoveOrder`，同时删除 `m_orderIDStrategyMap` 和 `m_ordMap`；迟到成交会变成 “Response OrderID not found”。
- 146 除了 `m_status`，还有 `m_active/m_new/m_cancel/m_modifywait/m_modify` 等正交标志；状态不是单一枚举能表达的。

#### 146 对 CTP OrderStatus 的处理

146 处理了部分成交的**数量**，但没有把 CTP 的 partial 报单状态当成独立状态。

CTP `OnRtnOrder` 的 `OrderStatus` 在 146 中的处理：

| CTP OrderStatus | 146 处理 |
|---|---|
| `PartTradedQueueing` | 和 `NoTradeQueueing` 合并；只有 `orderSent=true` 时补发一次 `NEW_ORDER_CONFIRM`，不表达 `PARTIAL` |
| `PartTradedNotQueueing` | 分支被注释掉，落到 `default`，只打 `unhandled order status` |
| `AllTraded` | 只打日志，不推回报 |
| `NoTradeQueueing` | 发 `NEW_ORDER_CONFIRM` |
| `NoTradeNotQueueing` | 分支被注释掉，落到 `default` |
| `Canceled` | 发 `CANCEL_ORDER_CONFIRM` |
| `Unknown` | 重置数量并打日志 |
| `NotTouched` / `Touched` | 分支被注释掉，落到 `default` |

对应代码：

```cpp
case THOST_FTDC_OST_PartTradedQueueing:
case THOST_FTDC_OST_NoTradeQueueing:
    if (ordinfo.orderSent) {
        response.Response_Type = NEW_ORDER_CONFIRM;
        PushUpdate(&response);
        ordinfo.orderSent = 0;
    }
    break;

/*
case THOST_FTDC_OST_PartTradedNotQueueing:
    break;
case THOST_FTDC_OST_NoTradeNotQueueing:
    break;
*/
```

所以：

```text
PartTradedQueueing 只被当作“补发新单确认”的触发条件
PartTradedNotQueueing 根本没处理
```

146 的部分成交来自 `OnRtnTrade`：

```text
CTP TRADE
  -> ORS OnRtnTrade
  -> ResponseMsg = TRADE_CONFIRM
  -> 共享响应队列
  -> TB ORSCallBack
  -> ProcessTrade
       m_openQty -= Volume
       m_doneQty += Volume
       状态仍为 NEW_CONFIRM
       openQty == 0 -> TRADED -> RemoveOrder
```

`ProcessTrade` 的关键逻辑：

```cpp
m_openQty -= response->Quantity;
m_doneQty += response->Quantity;

if (m_openQty == 0) {
    m_status = TRADED;
    RemoveOrder(iter);
}
```

结论：

```text
146 处理部分成交数量：是，靠 TRADE_CONFIRM
146 处理 CTP Partial 报单状态：不完整
  - PartTradedQueueing 只补发 NEW_ORDER_CONFIRM
  - PartTradedNotQueueing 未处理
  - AllTraded 只打日志
```

这带来两个问题：

1. **剩余数量是否还在排队，146 不知道**
   - `PartTradedQueueing` 和 `PartTradedNotQueueing` 被混在一起；
   - 可能对已经不在排队的剩余数量继续撤单。

2. **如果 TRADE 回调丢了，OrderStatus 不会修正状态**
   - `AllTraded` 只打日志；
   - TB 可能一直保持 `NEW_CONFIRM + openQty > 0`；
   - 没有对账机制。

新系统应该拆开：

```text
PARTIAL：由 filledQty/canceledQty/openQty 推导
remainingWorking：由 CTP OrderStatus 的 Queueing/NotQueueing 推导
```

即：

```text
PartTradedQueueing    -> PARTIAL + remainingWorking=true
PartTradedNotQueueing -> PARTIAL + remainingWorking=false
AllTraded             -> FILLED
Canceled              -> CANCELED
Unknown               -> UNKNOWN
```

#### 新系统对 CTP OrderStatus 的处理

新系统不能只看 CTP `TRADE`，还要看 `OnRtnOrder` 的 `OrderStatus`。

处理原则：

```text
OrderSubmitStatus 决定“在途/拒绝”
OrderStatus       决定“成交/排队/未排队/撤销”
VolumeTraded/VolumeTotal 决定数量
Trade             决定仓位账本
```

##### OrderSubmitStatus

| CTP `OrderSubmitStatus` | 值 | AccountHost 状态 |
|---|---|---|
| `InsertSubmitted` | `0` | `SUBMITTING` |
| `CancelSubmitted` | `1` | `CANCELING` |
| `ModifySubmitted` | `2` | `MODIFYING`（如果支持改单） |
| `Accepted` | `3` | 按 `OrderStatus` 继续映射 |
| `InsertRejected` | `4` | `REJECTED` |
| `CancelRejected` | `5` | `CANCEL_REJECTED` -> 回到 `ACKED/PARTIAL` |
| `ModifyRejected` | `6` | `MODIFY_REJECTED` -> 回到 `ACKED/PARTIAL` |

##### OrderStatus

| CTP `OrderStatus` | 值 | 含义 | AccountHost 状态 | `remainingWorking` |
|---|---|---|---|---|
| `AllTraded` | `0` | 全部成交 | `FILLED` | `false` |
| `PartTradedQueueing` | `1` | 部分成交，剩余在排队 | `PARTIAL` | `true` |
| `PartTradedNotQueueing` | `2` | 部分成交，剩余未排队 | `PARTIAL` | `false` |
| `NoTradeQueueing` | `3` | 未成交，正在排队 | `ACKED` | `true` |
| `NoTradeNotQueueing` | `4` | 未成交，未排队 | `ACKED` | `false` |
| `Canceled` | `5` | 已撤 | `CANCELED` | `false` |
| `Unknown` | `a` | 未知 | `UNKNOWN` | `unknown` |
| `NotTouched` | `b` | 未触及 | `ACKED` / `PARTIAL` | `unknown` |
| `Touched` | `c` | 已触及 | `ACKED` / `PARTIAL` | `unknown` |

补充规则：

- `AllTraded` 只是订单状态；仓位仍然只由 `TRADE` 更新。若 `filledQty > appliedFilledQty`，标记 `fillsPending`，不能直接加仓位。
- `PartTradedQueueing` 和 `PartTradedNotQueueing` 都是 `PARTIAL`，但前者剩余还在排队，后者剩余不在排队，不能混。
- `NoTradeNotQueueing` 不是终态，但它也不在排队；要确认是否符合预期，必要时撤单/对账。
- `NotTouched` / `Touched` 不要拿来猜终态；保留 `venueOrderStatus`，按数量字段和后续成交对账。
- `Unknown` 要进入 `UNKNOWN`，不能当普通挂单，也不能当成交。
- `Canceled` 是终态；即使之前有部分成交，也保留 `filledQty` 和 `canceledQty`。
- `ORPHAN` 不是 CTP 状态，是找不到 `orderRef -> clientOrderId` 时的内部异常状态。
- 如果 `AllTraded` 但 `VolumeTraded != VolumeTotalOriginal`，或 `Canceled` 但 `VolumeTotal > 0`，不要强行按表映射，进入 `UNKNOWN` / 对账。
- `remainingWorking` 只在 `openQty > 0` 时才有意义；`openQty = 0` 时必须为 `false`。

##### 数量字段

CTP `CThostFtdcOrderField` 里使用：

```text
VolumeTotalOriginal   原始数量
VolumeTraded          已成交数量
VolumeTotal           剩余数量
```

AccountHost 计算：

```text
filledQty        = VolumeTraded
openQty          = VolumeTotal
canceledQty      = VolumeTotalOriginal - VolumeTraded - VolumeTotal
appliedFilledQty = 已应用 Trade 数量
fillsPending     = filledQty > appliedFilledQty
```

如果：

```text
canceledQty < 0
filledQty + openQty > original
```

就是账实不一致，进入对账/告警，不能继续按这个订单发新单。

##### 状态推进顺序

```text
OrderSubmitStatus
  -> 先处理 InsertRejected / CancelRejected / ModifyRejected
  -> 再处理 CancelSubmitted / ModifySubmitted
  -> 最后按 Accepted + OrderStatus 映射
```

伪代码：

```text
if InsertRejected:
    state = REJECTED
elif CancelRejected:
    state = CANCEL_REJECTED -> live
elif ModifyRejected:
    state = MODIFY_REJECTED -> live
elif CancelSubmitted:
    state = CANCELING
elif ModifySubmitted:
    state = MODIFYING
elif Accepted or InsertSubmitted:
    switch OrderStatus:
        AllTraded              -> FILLED
        PartTradedQueueing     -> PARTIAL, working=true
        PartTradedNotQueueing  -> PARTIAL, working=false
        NoTradeQueueing        -> ACKED, working=true
        NoTradeNotQueueing     -> ACKED, working=false
        Canceled               -> CANCELED
        Unknown                -> UNKNOWN
        NotTouched/Touched     -> ACKED/PARTIAL by qty, working=unknown
```

状态推进必须满足：

- 不允许从新状态回退到旧状态；
- 用 `sequence`/时间戳丢弃过期更新；
- 重复 `OrderUpdate` 幂等；
- `CANCEL_REJECTED`/`MODIFY_REJECTED` 回到之前的 live 状态，不是终态；
- `UNKNOWN` 只能通过对账离开。

AccessClient 的 `OrderUpdateEvent` 至少要提供：

```text
orderRef
exchangeOrderId
venueSubmitStatus
venueOrderStatus
volumeTotalOriginal
volumeTraded
volumeTotal
tradingDay
sequence
```

否则 AccountHost 无法区分 `PartTradedQueueing` 和 `PartTradedNotQueueing`，也无法计算 `remainingWorking`。

##### 和 146 的区别

146：

```text
PartTradedQueueing    -> 只补发 NEW_ORDER_CONFIRM，不表达 PARTIAL
PartTradedNotQueueing -> 未处理，走 default
AllTraded             -> 只打日志
部分成交数量           -> 靠 TRADE_CONFIRM
```

新系统：

```text
PARTIAL 显式
remainingWorking 显式
PartTradedQueueing / PartTradedNotQueueing 分开
AllTraded 与 Trade 分开：状态归状态，仓位归仓位
Unknown/NotTouched/Touched 进入对账，不猜
```

#### 新设计对应的状态

| 146 | 新 AccountHost | 说明 |
|---|---|---|
| `NEW_ORDER` | `SUBMITTING` | 已发出，等待 ACK |
| `NEW_CONFIRM` | `ACKED` / `PARTIAL` | 146 不区分零成交和部分成交 |
| `NEW_REJECT` | `REJECTED` | 终态 |
| `TRADED` | `FILLED` | 终态 |
| `CANCEL_ORDER` | `CANCELING` | 撤单在途 |
| `CANCEL_CONFIRM` | `CANCELED` / `PARTIAL` | 有剩余 open qty 就是 `PARTIAL` |
| `CANCEL_REJECT`（主路径实际回 `NEW_CONFIRM`） | `CANCEL_REJECTED` | 非终态，回到 `ACKED/PARTIAL` |
| `MODIFY_ORDER` | `MODIFYING` | 仅当支持改单 |
| `MODIFY_CONFIRM` | `ACKED` / `PARTIAL` | 改单确认后回到 live 状态 |
| `MODIFY_REJECT` | `MODIFY_REJECTED` | 非终态，回到 `ACKED/PARTIAL` |
| `INIT` | — | 无对应 |
| — | `UNKNOWN` | 146 没有；新系统必须有 |
| — | `ORPHAN` | 146 只有日志；新系统显式建模 |

#### 新设计要补/避免的点

1. **显式 `PARTIAL`**
   - 146 用 `NEW_CONFIRM + openQty` 表达部分成交，容易和“零成交已确认”混。
   - 新设计用 `PARTIAL` + `filledQty/appliedFilledQty/canceledQty/openQty` 明确表达。
   - 同时保留 `venueOrderStatus` / `remainingWorking`，区分 `PartTradedQueueing` 和 `PartTradedNotQueueing`。

2. **`CANCELING` / `MODIFYING` 是在途状态**
   - 不能一按撤单就直接 `CANCELED`；
   - 撤单被拒要回 `ACKED/PARTIAL`，不是终态；
   - 部分撤单后要允许继续撤剩余，不能像 146 一样卡在 `CANCEL_CONFIRM`。

3. **`MODIFY` 必须单独建模**
   - 当前 AccountHost v1 如果不支持改单，可以没有 `MODIFYING`；
   - 一旦支持改单，不能把改单当撤单 + 新单，否则 `clientOrderId`/`orderRef` 关系会乱；
   - 改单确认后回到 live 状态，改单被拒回到原参数。

4. **终态不能立即删除关联**
   - 146 `RemoveOrder` 删除 `m_orderIDStrategyMap`，迟到成交只能报错；
   - 新设计终态订单从活跃索引移除，但 `orderRef -> clientOrderId` 保留保留期；
   - 迟到成交仍要更新账户/策略仓位和审计。

5. **必须有 `UNKNOWN`**
   - 146 没有超时/丢 ACK 状态；
   - 新系统跨进程/Aeron/SHM 边界，必须能表达“已发出但不知道结果”；
   - `UNKNOWN` 只能通过 ORS/CTP 对账离开，不能猜。

6. **必须有 `ORPHAN`**
   - 146 对找不到的 `OrderID` 只打日志；
   - 新系统要显式记录 orphan，fail closed，并进入对账。

7. **用显式状态 + 数量字段，不靠 flag soup**
   - 146 的 `m_active/m_new/m_cancel/m_modifywait` 是历史包袱；
   - 新设计用 `state + filledQty + appliedFilledQty + canceledQty + openQty` 表达，减少状态组合。

8. **改单/撤单的 reject 不是终态**
   - `CANCEL_REJECTED` / `MODIFY_REJECTED` 要回到原 live 状态；
   - `REJECTED`（新单被拒）、`FILLED`、`CANCELED` 是正常终态；
   - `ORPHAN` 是异常终态，进入对账/人工处理。

#### 结论

146 的状态机是“响应驱动 + 全局 flag + 终态删除”：

```text
能跑，但 PARTIAL/UNKNOWN/ORPHAN 不显式，
CANCEL_CONFIRM 部分撤单可能卡住，
终态删除关联导致迟到成交丢失。
```

新 AccountHost 的状态机是“显式状态 + 数量账本 + 关联保留”：

```text
PARTIAL 显式
CANCELING/MODIFYING 在途
CANCEL_REJECTED/MODIFY_REJECTED 可回到 live
UNKNOWN/ORPHAN 显式
终态保留 orderRef 映射
```

---

### 11.7 CTP 下单接口的交易所差异与封装

#### 结论

CTP 对期货交易所是统一 API：

```text
ReqOrderInsert(CThostFtdcInputOrderField)
ReqOrderAction(CThostFtdcInputOrderActionField)
```

不存在“SHFE 专用下单函数”。  
差异在字段取值、交易所规则和合约格式，不在函数签名。

封装位置：

```text
交易所/CTP 差异 -> ORS 的 VenueAdapter / ExchangeRules / InstrumentCatalog
账户/订单/策略归属 -> AccountHost
交易决策 -> StrategyProcess
传输 -> AccessClient
```

#### 差异维度

| 维度 | 典型差异 |
|---|---|
| `ExchangeID` | `SHFE` / `INE` / `DCE` / `CZCE` / `CFFEX` / `GFEX` |
| `InstrumentID` | SHFE/DCE/CFFEX/GFEX 常见 4 位年月；CZCE 常见 3 位；必须使用交易所认可的精确代码 |
| 平今/平昨 | SHFE/INE 区分 `CloseToday` / `CloseYesterday`；其他交易所平仓规则不同 |
| 市价单 | 支持范围不同；146 直接拒绝 SHFE 市价单 |
| `TimeCondition` | GFD/FAK/FOK/IOC 支持范围不同；146 拒绝 CFFEX/CZCE 的 FAK/FOK |
| `VolumeCondition` | CV/AV 支持不同 |
| 套保/投机 | `CombHedgeFlag` 规则不同 |
| 条件单/止损单 | `ContingentCondition` 支持不同 |
| `OrderSysID` | 交易所格式不同，不能解析，只能当 opaque ID |
| 撤单字段 | 可能用 `OrderSysID + ExchangeID`，也可能用 `OrderRef + FrontID/SessionID` |
| 订单状态语义 | 部分成交、排队、未排队的时序和含义不同 |
| 合约规则 | 最小变动价位、手数、乘数、交易时段、涨跌停、保证金不同 |

一个 CTP session 可以接多个交易所。  
不需要每个交易所一个 ORS；需要的是一个 `InstrumentCatalog` + `ExchangeRules`。

#### 新系统的分层

```text
StrategyProcess
  -> AccountHost
    -> AccessClient
      -> ORS
        -> VenueAdapter
          -> CtpTraderAdapter
          -> CtpMdAdapter
          -> OtherVenueAdapter
        -> InstrumentCatalog
        -> ExchangeRules
```

| 关注点 | 所属层 |
|---|---|
| 交易决策 | `StrategyProcess` |
| 账户/订单/路由 | `AccountHost` |
| Aeron/SBE 传输 | `AccessClient` |
| CTP 登录/会话 | `ORS` |
| CTP 字段编码 | `ORS / CtpTraderAdapter` |
| 交易所规则 | `ORS / ExchangeRules` |
| 合约元数据 | `ORS / InstrumentCatalog` |
| 平今/平昨 | `ORS / OffsetResolver` |
| 市价/FAK/FOK | `ORS / OrderTypeMapper` |
| 订单状态规范化 | `ORS / StatusNormalizer` |
| CTP 错误码 | `ORS / ErrorMapper` |

AccountHost 和 StrategyProcess 只使用 canonical 字段：

```text
venueId
accountId
exchange
instrumentId
side
offset
priceType
timeCondition
volumeCondition
qty
price
clientOrderId
venueOrderRef
```

不出现：

```text
CThostFtdcInputOrderField
OrderRef
OrderSysID
FrontID
SessionID
BrokerID
InvestorID
```

#### 146 的实现

146 确实把交易所差异放在 ORS，但实现是硬编码。

##### 平今/平昨

`ORSServer::SetCombOffsetFlag`：

```cpp
if (request->Quantity <= todayShortPos) {
    if (request->Exchange_Type == CHINA_SHFE)
        flag = THOST_FTDC_OF_CloseToday;
    else
        flag = THOST_FTDC_OF_Close;
    orderType = CLOSE_TODAY;
} else if (request->Quantity <= ONShortPos) {
    flag = THOST_FTDC_OF_Close;
    orderType = CLOSE_YESTERDAY;
} else {
    flag = THOST_FTDC_OF_Open;
    orderType = OPEN_ORDER;
}
```

规则：

```text
SHFE 平今 -> CloseToday
非 SHFE 平今 -> Close
```

注意：146 在下单时就扣本地持仓，不是成交后扣；部分成交/拒单时会账实不一致。

##### 市价单/FAK/FOK

`ORSServer::SendNewOrder`：

```cpp
if (request->OrdType == MARKET) {
    if (request->Exchange_Type == CHINA_SHFE) {
        RejectOrder(request, "No market orders in SHFE");
        return;
    }
    if ((request->Exchange_Type == CHINA_CFFEX) ||
        (request->Exchange_Type == CHINA_ZCE)) {
        RejectOrder(request, "Order type not supported in this market");
        return;
    }
}
```

硬编码规则：

| 请求 | 146 行为 |
|---|---|
| SHFE 市价单 | 拒绝 |
| CFFEX/CZCE FAK/FOK | 拒绝 |
| DCE 市价/FAK/FOK | 允许，按 CTP 字段填 |
| 普通限价 | `LimitPrice + GFD + AV` |

##### ExchangeID / InvestorID / InstrumentID

CTP 路径：

```cpp
strcpy(req.BrokerID, m_BROKER_ID.c_str());
strcpy(req.InvestorID, m_INVESTOR_ID.c_str());
strcpy(req.InstrumentID, request->Contract_Description.Symbol);

sprintf(ORDER_REF, "%012d", iNextOrderRef);
strcpy(req.OrderRef, ORDER_REF);
iNextOrderRef++;
```

特点：

- CTP 路径使用统一的 `m_INVESTOR_ID`；
- Sgit 路径才按 SHFE/CFFEX/ZCE/DCE 使用不同 `InvestorID`；
- `InstrumentID` 直接 copy，没有统一合约代码转换；
- 撤单时按交易所填 `ExchangeID`：

```text
SHFE
CFFEX
CZCE
DCE
```

146 这份 ORS 只覆盖这四个交易所，没有 `INE`、`GFEX` 分支。

##### OrderRef / OrderSysID

146：

```text
ORS 生成 12 位 OrderRef
m_ordExchMap[OrderRef] = local OrderID
OrderInfo.OrderSysID = CTP OrderSysID
```

撤单：

```cpp
strcpy(req.OrderRef, ordinfo.exchID);
req.FrontID = FRONT_ID;
req.SessionID = SESSION_ID;
req.ActionFlag = THOST_FTDC_AF_Delete;
strcpy(req.OrderSysID, ordinfo.OrderSysID);
```

撤单同时依赖：

```text
OrderRef
OrderSysID
FrontID
SessionID
ExchangeID
```

这些都在 ORS 内处理。

##### 改单

146 这份 ORS 直接拒绝改单：

```cpp
void ORSServer::SendModifyOrder(RequestMsg* request)
{
    RejectOrder(request, "Modify orders not allowed");
}
```

TB 里虽然有 `MODIFY_ORDER/MODIFY_CONFIRM/MODIFY_REJECT` 状态，但 CTP 路径下改单是关闭的。

##### 146 的问题

| 问题 | 影响 |
|---|---|
| 交易所规则硬编码 | 新增 INE/GFEX 或规则变化要改 ORS 代码 |
| 没有 `ExchangeRules` | 市价/FAK/FOK/平今规则散落 |
| `InstrumentID` 直接透传 | 没有统一合约代码转换 |
| 下单时扣本地持仓 | 部分成交/拒单导致账实不一致 |
| CTP 统一 InvestorID | 没有按交易所区分 |
| 不支持改单 | `SendModifyOrder` 直接拒绝 |
| 只覆盖四个交易所 | 没有 INE/GFEX |
| 部分 OrderStatus 未处理 | 详见 11.6 |

#### 146 与新系统对比

| 维度 | 146 | 新 AccountHost/ORS |
|---|---|---|
| CTP API | 统一 `ReqOrderInsert` | 统一 `ReqOrderInsert` |
| 交易所差异位置 | ORS，硬编码 `if/switch` | ORS，`VenueAdapter/ExchangeRules` |
| 平今/平昨 | `if (SHFE)` | `OffsetResolver` 按交易所/合约/今昨仓 |
| 合约代码 | 直接 copy | `InstrumentCatalog` |
| 市价/FAK/FOK | 硬编码拒绝/允许 | `OrderTypeMapper` 配置 |
| `OrderRef` | ORS 12 位序列 | adapter 的 `venueOrderRef` |
| `OrderSysID` | ORS `OrderInfo` | `exchangeOrderId`（opaque） |
| 撤单 | ORS 拼 CTP 字段 | ORS adapter 拼字段 |
| 改单 | 拒绝 | adapter 能力，可选 |
| INE/GFEX | 无 | 通过配置/规则扩展 |
| AccountHost 感知 CTP | 无 AccountHost | 仍不感知 |

#### 落地要求

1. `ExchangeRules` 配置化：
   - 支持的订单类型；
   - 市价单支持；
   - FAK/FOK/IOC 支持；
   - 平今/平昨规则；
   - 套保/投机规则；
   - 撤单字段组合；
   - 合约代码格式。
2. `InstrumentCatalog` 提供：
   - exchange；
   - tick size；
   - lot size；
   - multiplier；
   - trading hours；
   - 合约代码。
3. `CtpTraderAdapter` 只做 CTP 编码/解码，不把 CTP 字段泄漏到 AccountHost。
4. `StatusNormalizer` 按 11.6 把 CTP `OrderStatus` 映射成 canonical 状态。
5. 每个交易所至少一组测试：
   - 开仓/平今/平昨；
   - 市价/限价；
   - FAK/FOK；
   - 撤单；
   - 部分成交；
   - 拒绝；
   - 状态回报顺序。

#### 状态配置命名约定

配置文件里的 `statusMap` 必须映射到 6.1 的 canonical 状态 + `remainingWorking`，不能定义复合状态。状态定义与转移以 6.1 为准；这里只配置 CTP 状态到 canonical 状态/flag 的映射：

```yaml
statusMap:
  AllTraded:
    state: FILLED
    remainingWorking: false
  PartTradedQueueing:
    state: PARTIAL
    remainingWorking: true
  PartTradedNotQueueing:
    state: PARTIAL
    remainingWorking: false
  NoTradeQueueing:
    state: ACKED
    remainingWorking: true
  NoTradeNotQueueing:
    state: ACKED
    remainingWorking: false
  Canceled:
    state: CANCELED
    remainingWorking: false
  Unknown:
    state: UNKNOWN
    remainingWorking: null
```

`NotTouched` / `Touched` 不单独定义状态：

```text
filledQty = 0 -> ACKED
filledQty > 0 -> PARTIAL
remainingWorking = null
后续按数量字段和对账处理
```

禁止：

```text
PARTIAL_WORKING
PARTIAL_NOT_WORKING
ACKED_WORKING
ACKED_NOT_WORKING
```

原因：

- 状态机只认 `ACKED` / `PARTIAL`；
- 是否还在排队是正交属性 `remainingWorking`；
- 复合状态会让状态转移和配置映射出现两套语义；
- 配置只负责 `CTP OrderStatus -> state + remainingWorking`，不负责定义状态转移；状态转移以 `6.1` 为准。

一句话：

> **146 的边界是对的：交易所差异在 ORS；但实现是硬编码。新系统应保留边界，把它抽象成 ORS 内的 VenueAdapter/ExchangeRules。**

---

## 12. 设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 进程边界 | 一 AccountHost/账户 | 账户是交易/会话/对账边界 |
| 策略边界 | 一 StrategyProcess/策略 | 故障隔离 |
| 订单发布 | 账户内单写者 | 避免 ID/发布/状态竞争 |
| 热路径 DB | 不使用 | 延迟和可用性 |
| 持久化 | 异步事件 + DB 投影 | 审计/恢复/报表 |
| 恢复源 | DB 基线 + ORS 快照 | DB 可能滞后 |
| 成交主键 | `orderRef` | CTP 回显我们填的值 |
| 交易所差异 | ORS `VenueAdapter/ExchangeRules` | AccountHost/Strategy 保持 venue-neutral |
| 交易所订单号 | 辅助键 | 可能为空/变化 |
| 策略归属 | `OrderState.strategyKey` | 一笔单一个策略 |
| ID 自关联 | 不做 | 保留 `orderRef -> clientOrderId` 映射 |
| 失败策略 | fail closed | 不猜、不串单 |

---

## 13. 备选方案

### 方案 A：146 式，每策略一个 AccessClient

```text
StrategyProcess -> 自己的 AccessClient -> ORS
```

优点：

- 没有 AccountHost；
- 每个策略独立；
- 实现简单。

缺点：

- 一个账户 N 个会话/N 个订单发布者；
- `clientOrderId`、READY、撤单、对账分散；
- 成交归属依赖 clientId + 每进程 map；
- 账户级风控/对账困难。

### 方案 B：当前设计，一账户一个 AccountHost

```text
StrategyProcess -> AccountHost -> AccessClient -> ORS
```

优点：

- 账户内单写者；
- 统一 ID、映射、订单状态、对账、风控；
- 策略进程不接触 CTP/Aeron 细节；
- 便于恢复和审计。

缺点：

- AccountHost 是账户级单点；
- 需要本机 IPC；
- 设计复杂度高于 146。

### 方案 C：一账户一策略

```text
1 Account = 1 Strategy = 1 AccountHost
```

这时 AccountHost 可以退化成 StrategyProcess 内部模块，路由也不需要。

适用：

- 每策略独立账户；
- 不需要跨策略共享账户；
- 不需要账户级净额。

---

## 14. 风险与开放问题

1. **ORS 快照接口**：必须提供 open orders / positions / trades 查询；否则异步持久化不足以恢复。
2. **异步 DB 丢失窗口**：无 WAL 时，崩溃可能丢最后一小段事件；需要接受或用 ORS 快照兜底。
3. **`TradeEnvelope` 缺少 `orderRef`**：需要补字段，或要求 ORS 在发布前完成 `OrderRef -> clientOrderId` 映射。
4. **CTP `OrderRef` 长度/格式**：12 位数字是否足够、是否需要按交易日重置。
5. **`OrderSysID` 变化**：改单/重发可能产生新 `OrderSysID`，不能做唯一归属。
6. **多账户同机**：Aeron media driver/stream base 隔离需要单独设计。
7. **`clientOrderId` 生成**：Snowflake vs 账户序列；重启/HA 的唯一性需要验证。
8. **账户级风控参数来源**：配置、DB 还是风控服务；不能在热路径查 DB。
9. **INE/GFEX 与交易所规则**：146 只覆盖 SHFE/CFFEX/CZCE/DCE；新系统需要 `ExchangeRules` 明确 INE/GFEX、平今/平昨、市价/FAK/FOK、套保规则。
10. **CTP InvestorID 粒度**：146 CTP 路径使用统一 InvestorID，Sgit 路径按交易所区分；新系统要确认是否一账户一 InvestorID 还是按交易所/品种区分。

---

## 15. 验收标准

1. 同一账户两个策略：成交只到所属策略。
2. `orderRef` 缺失或未知：orphan，不误路由。
3. `exchangeOrderId` 为空：仍能通过 `orderRef` 归属。
4. 重复 `tradeId`：仓位只加一次。
5. 下单/成交热路径无同步 DB 调用。
6. 异步队列满：停止新单，不阻塞订单线程。
7. AccountHost 重启：DB + ORS 快照对账后恢复。
8. 策略崩溃：只撤该策略挂单，其他策略继续。
9. 账户净仓与策略仓位之和不一致：fail closed。
10. 旧 146 文件/状态不读取、不迁移。
11. `PartTradedQueueing` / `PartTradedNotQueueing` 分别映射为 `PARTIAL` + `remainingWorking=true/false`。
12. `AllTraded` 只推进订单状态，不直接加仓位；TRADE 未到齐时 `fillsPending=true`。
13. `Unknown` / `NotTouched` / `Touched` 进入对账，不猜终态。
14. `Canceled` 之前有部分成交时，`filledQty` 和 `canceledQty` 仍保留。
15. SHFE/INE/DCE/CZCE/CFFEX/GFEX 的平今/平昨、市价/FAK/FOK 规则只在 ORS 配置中体现，AccountHost 不出现 CTP 字段。
16. 不支持的订单类型由 ORS 明确拒绝，不能透传到 AccountHost 再失败。

---

## 16. 附录：146 证据索引

| 主题 | 146 位置 |
|---|---|
| 本地 OrderID 生成 | `3/dalong/infrastructure/Connector/src/connector.cpp:943-947` |
| clientId 过滤回报 | `Connector/src/connector.cpp:601-618` |
| TB 回报入口 | `3/TradeBot/TradeBot_China/main/CommonClient.cpp:299` |
| 全局 orderID -> strategy | `3/TradeBot/TradeBot_China/main/main.cpp:262-274` |
| 映射插入 | `3/TradeBot/TradeBot_China/Strategies/ExecutionStrategy.cpp:1405` |
| ORS OrderRef -> localID | `3/dalong/infrastructure/China/src/ORSServer.cpp:2537-2566` |
| ORS OrderSysID | `3/dalong/infrastructure/China/include/ORSServer.h:88-109` |
| ORS 平今/平昨 | `3/dalong/infrastructure/China/src/ORSServer.cpp:378-495` |
| ORS 下单映射 | `3/dalong/infrastructure/China/src/ORSServer.cpp:497-870` |
| ORS 撤单映射 | `3/dalong/infrastructure/China/src/ORSServer.cpp:882-989` |
| ORS 拒绝改单 | `3/dalong/infrastructure/China/src/ORSServer.cpp:873-878` |
| ORS CTP 状态处理 | `3/dalong/infrastructure/China/src/ORSServer.cpp:1906-2098` |
| CTP Trade 字段 | `3/dalong/infrastructure/China/include/ThostFtdcUserApiStruct.h:1607` |
| 146 路由分析 | `146/02-tradebot-core.md:451-455` |
| 146 多策略风险 | `146/06-security-lineage.md:807` |

---

## 17. 术语

| 术语 | 含义 |
|---|---|
| `AccountHost` | 账户级交易协调器 |
| `StrategyProcess` | 一策略一进程 |
| `clientOrderId` | 内部订单主键，账户内唯一 |
| `orderRef` | 我们填入 CTP 的报单引用，CTP 回显 |
| `exchangeOrderId` | CTP `OrderSysID`，交易所报单号 |
| `tradeId` | CTP `TradeID`，成交幂等键 |
| `strategyKey` | 策略业务标识 |
| `requestId` | 策略意图幂等键 |
| `filledQty` | 柜台口径已成交量，来自 `VolumeTraded` |
| `appliedFilledQty` | 已应用到仓位账本的成交量，来自 Trade 事件 |
| `remainingWorking` | 剩余 openQty 是否还在排队/工作，正交字段，不是状态 |
| `fillsPending` | 柜台已成交，但 Trade 事件还未全部应用 |
| `AccessClient` | ORS 的客户端传输适配器 |
| `ORS` | 账户/柜台订单路由服务 |

---

## 18. 一句话

```text
AccountHost 让“账户”成为一个可管理、可对账、可恢复的交易单元；
StrategyProcess 只负责策略判断；
ORS 只负责柜台会话；
DB 只负责异步留痕和恢复基线。
```

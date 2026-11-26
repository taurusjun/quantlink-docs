# FastTrade TradeBot MVP 设计

- 日期：2026-11-18
- 状态：DRAFT（待批准）
- 目标：一个可运行的 TradeBot

## 0. 范围

```text
一个进程
一个账户
一个 venue
一个策略
一份配置文件
一条完整订单生命周期
一次重启恢复
```

MVP 包含：

```text
TradeBotMain
AccessSDK
TargetPositionStrategy
OrderManager
StateStore
Health
```

不包含：

```text
多策略
OptionManager / Greeks
数据库配置/状态
热加载
控制面 UI
CTP 实盘
多账户 / 多 venue
自动平仓
完整风控
```

## 1. 构建边界

根构建只包含产品模块：

```text
:access-sdk
:fasttrade-tradebot
```

`fasttrade-smoke` 不属于产品构建，放在 `tools/fasttrade-smoke`，只做 E2E 探针。
MVP 实现第一步：把 smoke 移出根 `settings.gradle.kts`。
MVP 验收时，根构建只包含 `:access-sdk` 和 `:fasttrade-tradebot`。

## 2. 进程与线程

启动顺序：

```text
TradeBotMain
  -> 读取配置
  -> 加载 StateStore
     - 首次启动必须显式 --init-state；创建 state 后才能连接
     - --init-state 且 stateFile 已存在：拒绝启动
     - 后续 state 缺失或损坏：fail-closed
  -> 连接 Aeron / AccessSDK
  -> 等待 session READY
  -> 撤销 persisted PENDING / OPEN / CANCELING order
  -> 撤单未确认则 fail-closed，不进入交易
  -> 等待第一份 PositionSnapshot
  -> 进入回调循环
```

线程：

```text
主线程 / 回调循环
  - poll session / MD / execution / position / account
  - 每个 poll 周期调用 TargetPositionStrategy.onTick(now)
  - onTick 检查 ACK 超时 / reprice / 撤单重试
  - OrderManager.onUpdate / onTrade
  - 订单提交/终态时写 StateStore

Health 写入线程（daemon）
  - 每秒把最新不可变 health 快照写入文件
  - close 前设置 healthStop=true，join 最多 1s
  - 最终 health 由主线程写一次
```

没有 per-strategy 线程。

SIGTERM 协调：

```text
shutdown hook:
  stopRequested = true
  等待 closedLatch，最多 3s

主线程:
  看到 stopRequested
  -> 停新单
  -> 撤单
  -> 写 state / health
  -> close
  -> closedLatch.countDown()
```

shutdown hook 不直接写交易文件。

## 3. 模块

```text
fasttrade-tradebot
  src/main/java/com/quantlink/fasttrade/tradebot/
    TradeBotMain.java
    TradeBotConfig.java
    TargetPositionStrategy.java
    OrderManager.java
    StateStore.java
    TradeBotHealth.java
```

依赖：

```text
access-sdk
slf4j-api
logback-classic
```

## 4. 配置

使用 `java.util.Properties`，启动时一次性读取。

```properties
venueId=SIMVENUE
accountId=SIMVENUE-001
environment=SHADOW
aeronDir=/opt/quantlink-fasttrade/aeron
streamBase=9000
sourceSessionId=<startup-epoch-millis>
sourcePublicationEpoch=1

instrument=au2612
exchange=SHFE
strategyKey=mvp-target
tickSize=0.02

targetQty=1
orderQty=1
priceOffsetTicks=5
repriceMs=2000
ackTimeoutMs=3000
maxMarketDataAgeMs=1000
positionInitTimeoutMs=3000

stateFile=state/tradebot.properties
healthFile=state/tradebot-health.json
```

规则：

- `streamBase` 必填，不写死 `1001`。
- `aeronDir` 必须与 SimVenue 使用同一个 Aeron directory。
- `targetQty` 可以为负，支持空头。
- `tickSize > 0`，`priceOffsetTicks >= 0`，`orderQty > 0`，`repriceMs > 0`，`ackTimeoutMs > 0`，`maxMarketDataAgeMs > 0`。
- `sourceSessionId` / `sourcePublicationEpoch` 传给 AccessConfig，并写入日志。
- 买价 = `bestAsk + priceOffsetTicks * tickSize`。
- 卖价 = `bestBid - priceOffsetTicks * tickSize`。
- 不支持热加载；改配置后重启。

## 5. TargetPositionStrategy

### 5.1 状态

```text
targetQty
positionQty
positionInitialized
flatAssumed
latestPositionSnapshot
lastMarketDataAt
lastTradeIngestTimestamp
lastPositionSnapshotNanos
orderState
openOrder
orderCreatedAt
```

`orderState`：

```text
NONE
OPEN
CANCELING
```

`positionQty`：

- 启动后等第一份 `PositionSnapshot` 作为基线。
- 如果 state 有 open order，先撤单并等订单清除后的 quiet snapshot；清除后仍没有快照时保持 `positionInitialized=false`，不假设 flat。
- 如果 `positionInitTimeoutMs` 内没有收到任何仓位快照，且启动时没有 open order，按 flat=0 + 已见本地成交启动。
- 成交回调立即增量更新；`lastTradeIngestTimestamp = trade.ingestTimestamp` 只用于快照排序，不再让成交刷新仓位新鲜度。
- 只有 `snapshotTimestampNanos >= lastTradeIngestTimestamp` 的仓位快照才能覆盖。
- 更旧的快照必须忽略，不能把成交后的仓位改回去。
- 覆盖后保存 `latestPositionSnapshot`，并记录本地 `System.nanoTime()` 接收时间 `lastPositionSnapshotNanos`。
- `positionFresh = positionInitialized && latestPositionSnapshot != null && nowNanos - lastPositionSnapshotNanos <= latestPositionSnapshot.staleAfterMs`；使用本地单调时钟，避免 adapter 时钟偏差。
- 没有任何仓位快照且未到 `positionInitTimeoutMs` 时，`positionFresh=false`；超时且启动时没有 open order 时，允许 `flatAssumed=true`，`positionFresh=true`。

### 5.2 决策

只有满足以下条件才能下新单：

```text
positionInitialized == true
positionFresh == true
orderState == NONE
session READY
now - lastMarketDataAt <= maxMarketDataAgeMs
```

```text
delta = targetQty - positionQty

delta > 0
  -> BUY LIMIT
  -> price = bestAsk + priceOffsetTicks * tickSize
  -> qty = min(delta, orderQty)

delta < 0
  -> SELL LIMIT
  -> price = bestBid - priceOffsetTicks * tickSize
  -> qty = min(-delta, orderQty)
```

规则：

- 同一时间只允许一个 open order。
- 行情或仓位 stale 时不下新单，只允许撤单。
- 下单前先写 state `PENDING`；发送成功后等待 ACK，ACK 后进入 `OPEN`。
- `submit` 在发送前失败（publication 未连接）：清除 `PENDING`，不下单。
- 发送后 `ackTimeoutMs` 内没有 ACK：`PENDING -> CANCELING`，撤单；unknown 清除，撤单失败 fail-closed。
- 成交后更新 `positionQty`，再决定下一单。
- 达到目标后不再下单；已有挂单进入 `CANCELING`。
- 挂单超过 `repriceMs` 未成交：
  - `OPEN -> CANCELING`
  - 发撤单，记录 `cancelAttempts`
  - 每次重新决策或超过 `repriceMs` 时重发撤单
  - 收到 `CANCELED` 才回到 `NONE`
  - `CANCELED` 的未知订单视为已不存在，清除 state
  - 撤单连续失败 3 次或超过 3s：fail-closed，写 health，退出

### 5.3 onTick

主循环每个 poll 周期调用：

```text
onTick(now)
```

职责：

```text
PENDING 且 now - orderCreatedAt > ackTimeoutMs
  -> CANCELING，发撤单

OPEN 且 now - orderCreatedAt > repriceMs
  -> CANCELING，发撤单

CANCELING
  -> 按退避重发撤单
  -> 连续失败 3 次或超过 3s
     -> fail-closed
```

`onTick` 不依赖新行情；没有行情时仍必须执行。

## 6. OrderManager

职责：

```text
生成 clientOrderId / requestId
保存当前订单和状态
按 clientOrderId 路由 OrderUpdate / Trade
处理 ACK / PARTIAL / FILLED / CANCELED / REJECTED
撤销订单
```

标识：

```text
clientOrderId = ++lastClientOrderId
requestId = UUID
traceId = requestId
```

规则：

- `lastClientOrderId` 从 StateStore 恢复。
- 到 `999_999_999_999` 后拒绝启动，不回绕。
- 只跟踪一个策略的一个 open order。
- 未知 `clientOrderId` 记录 orphan，不影响策略仓位。
- `PENDING -> OPEN` 需要 ACK；收到 `PARTIAL` 也视为已接受并进入 `OPEN`，因为立即部分成交的订单可能没有单独 ACK。
- 下单被拒：清除 open order，回到 `NONE`。
- 撤单被拒：保持 `CANCELING`，按退避重试撤单，不重新下单。
- `unknown order` 的撤单结果：清除 state，回到 `NONE`。
- 连续撤单失败 3 次或超过 3s：fail-closed，退出。
- 收到终态：清除 open order，回到 `NONE`。

## 7. StateStore

文件：`state/tradebot.properties`，原子替换。

保存：

```text
lastClientOrderId
open.clientOrderId
open.requestId
open.side
open.qty
open.price
open.state
```

不保存：

```text
positionQty
account
行情
```

仓位在启动时从 `PositionSnapshot` 读取。

写入时机：

```text
发送订单前写 PENDING
ACK 后写 OPEN
进入 CANCELING 时写 CANCELING
撤单失败计数变化
终态写 NONE 并清除 open
```

顺序：

```text
StateStore PENDING 成功
  -> 发送 OrderRequest
  -> ACK
  -> StateStore OPEN
```

PENDING 写失败时不得发送订单。

MVP 的 state 写入是回调线程同步写，属于有意选择：文件很小，且状态必须先于订单发送落盘。
写失败就停止新单；不要在这条路径上增加 JSON/DB/异步层。health 仍由独立线程写。

写入失败：

```text
停止新单
health 记录错误
保留旧状态文件
```

重启流程：

```text
load state
  -> 等待 session READY
  -> 如果有 PENDING / OPEN / CANCELING，先发 CancelRequest
  -> 等待 CANCELED
  -> unknown order -> 清除 state，继续
  -> 撤单超时 / 其他 REJECTED：fail-closed，不进入策略
  -> 等第一份 PositionSnapshot
  -> 开始策略
```

## 8. 停止

收到 `SIGTERM`：

```text
shutdown hook 设置 stopRequested
主循环停止新单
如果 orderState != NONE：发撤单
等待最多 3s 的 CANCELED
写最终 state 和 health
close AccessClient
closedLatch.countDown()
```

shutdown hook 最多等 `closedLatch` 3 秒，不在 hook 内写文件。

MVP 不自动平仓。  
需要平仓时，把 `targetQty=0` 后启动。

## 9. Health

文件：`state/tradebot-health.json`，原子替换，由独立线程每秒写一次。

字段：

```text
ready
sessionId
positionQty
targetQty
orderState
openOrderId
lastMarketDataAt
lastExecutionAt
lastError
updatedAt
```

回调线程只更新内存快照，不写文件。

## 10. 日志

使用 SLF4J + 异步 Logback。

每条关键日志包含：

```text
traceId = requestId
requestId
strategyKey
clientOrderId
tradeId
accountId
venueId
orsId
instrumentId
```

事件：

```text
tradebot.start
tradebot.config
tradebot.session
tradebot.decision
tradebot.submit
tradebot.reprice
tradebot.cancel
tradebot.order_update
tradebot.trade
tradebot.position
tradebot.stop
```

禁止输出密码、AuthCode、密钥。

## 11. 失败处理

| 情况 | 行为 |
|---|---|
| session 未 READY | 不下新单，允许撤单 |
| 无行情 | 不下新单，health 标记 stale |
| 无仓位快照 | 不启动策略 |
| state 缺失/损坏 | fail-closed；仅 --init-state 可创建 |
| 无行情但有 PENDING/OPEN | onTick 仍执行超时处理 |
| 旧仓位快照 | 忽略；不能覆盖更新成交 |
| order publication 未连接 | 本次下单失败，记录 health |
| 下单被拒 | 清除 `PENDING`，下一次行情重试 |
| 发单前 publication 断开 | 清除 `PENDING`，不发送 |
| ACK 超时 | `PENDING -> CANCELING`，撤单；unknown 清除，失败 fail-closed |
| 行情 stale | 不下新单，只允许撤单 |
| 仓位 stale | 不下新单，等新快照 |
| 挂单超时 | `OPEN -> CANCELING`，撤单确认后才重挂 |
| 撤单被拒/超时 | 保持 `CANCELING`，按退避重试；3 次/3s 后 fail-closed |
| PENDING 写失败 | 不发送订单 |
| SIGTERM | 撤单、写状态、退出 |
| 重启撤单失败 | fail-closed，不进入策略 |
| StateStore 写失败 | 停止新单，health 报错 |

## 12. 测试

### 12.1 单元测试

- `TradeBotConfig`：必填校验、正数校验、streamBase。
- `TargetPositionStrategy`：
  - 空仓 target 1 -> BUY
  - 多仓 target 0 -> SELL
  - 达到目标 -> 不下单
  - `PENDING` / `OPEN` / `CANCELING` -> 不重复下单
  - 撤单被拒 -> 保持 `CANCELING` 并重试
  - 撤单连续 3 次失败 -> fail-closed
  - PENDING 写失败 -> 不发送订单
  - publication 断开 -> 清除 PENDING，不发送
  - ACK 超时 -> CANCELING
  - 行情 stale / 仓位 stale -> 不下单
  - 旧仓位快照被忽略
  - 无行情时 onTick 仍触发 ACK 超时 / reprice
  - state 缺失/损坏 -> fail-closed
  - --init-state 创建初始 state
- `OrderManager`：
  - ACK / FILLED / REJECTED
  - 撤单状态
  - 重复 clientOrderId
  - 未知回报
- `StateStore`：
  - 原子写/读
  - open order + state 恢复
  - clientOrderId 单调递增

### 12.2 190 E2E

```text
1. 启动 SimVenue（stream base 9000）
2. 启动 tradebot，targetQty=1
3. 等到 positionQty=1，orderState=NONE
4. 重启 tradebot，保持目标，不重复下单
5. 挂一个不会成交的单，SIGTERM 后确认撤单
6. 模拟重启时有 persisted open order，确认先撤单再交易
7. 用 requestId 验证 decision -> submit -> SimVenue -> ACK/Trade -> position
```

## 13. 验收标准

```text
配置文件可启动
自动到达目标仓位
挂单超时只撤单，不会重复下单
撤单未确认不会下新单
撤单连续失败会 fail-closed
PENDING 状态先落盘再发送
发单前断开不会留下 PENDING
ACK 超时会进入 CANCELING
行情/仓位 stale 不会下新单
无行情时 ACK 超时和 reprice 仍会执行
state 缺失/损坏会拒绝启动
空仓账户能在 positionInitTimeoutMs 后启动
--init-state 在 state 已存在时拒绝
重启先撤旧单；撤单失败不交易
旧仓位快照不会覆盖新成交
SIGTERM 会撤单
health 文件可读
日志能用 requestId 串起来
```

## 14. 非目标

```text
多策略
OptionManager / Greeks
数据库配置/状态
热加载
控制面 UI
CTP 实盘
多账户 / 多 venue
自动平仓
完整风控
```

# FastTrade Access -> SimVenue 设计

- 日期：2026-11-17
- 状态：APPROVED（方案 1，AccessSDK 直连 SimVenue）
- 关联：[`../../v1/access-architecture.md`](../../v1/access-architecture.md)、[`../../v1/access-layer-plan.md`](../../v1/access-layer-plan.md)

## 0. 结论

第一期采用 **AccessSDK 直连 SimVenue**：

```text
FastTrade AccessSDK
  ↕ venue-contract Aeron IPC
SimVenue
```

不新增 `AccessRuntime` 代理进程。SimVenue 已经是 venue 边界，直接实现 contract 的行情、订单、回报、快照和会话。AccessSDK 只负责客户端侧的订阅、发布、校验、排队和回调。

实盘 ORS/CTP 以后接入时，仍使用同一套 AccessSDK 接口；届时由新的 CTP adapter 直接实现相同的 contract 流。`AccessRuntime` 不再是独立进程；CTP adapter 自己承担 CTP 登录、重连、订单映射和 contract 发布。第一期不实现 CTP adapter。

## 1. 目标

1. FastTrade 能通过 `com.quantlink.contract:venue-contract:0.1.8` 连接 SimVenue。
2. 能接收 `MarketData`、`OrderUpdate`、`Trade`、`PositionSnapshot`、`AccountSnapshot`、`VenueSession`。
3. 能提交限价单、撤单。
4. 单线程消费所有流，顺序可预测。
5. 会话未 READY 或发布通道未连接时，不静默丢单。
6. execution sequence、MD sequence、重复消息和缺口都有计数，不崩进程。
7. 客户端重启后能重新连接，并按新会话/快照恢复观察状态。
8. 在 190 上跑通真实 SimVenue E2E。

## 2. 非目标

- 不做完整 TradeBot 策略框架、OptionManager、配置 DB、状态 DB。
- 不做多账户、多 ORS、多 venue、MD 共享。
- 不做独立 AccessRuntime 进程；LIVE 由 CTP adapter 直接实现 contract。
- 不做 CTP/实盘 adapter。
- 不做订单簿持久化；订单状态以 venue 回报为准。
- 不在 SDK 内生成业务订单 ID；调用方负责 `clientOrderId` / `requestId`。

## 3. 方案选择

### 3.1 方案 A：AccessSDK 直连 SimVenue（采用）

```text
AccessSDK -> 9002 order / 9003 cancel
SimVenue -> 9001 md / 9004 execution / 9005 position / 9006 account / 9007 session
```

优点：进程最少，失败点最少，直接验证 contract；与未来 ORS adapter 的客户端接口一致。  
缺点：SimVenue 自己承担 venue 侧全部职责；这是它已经完成的。

### 3.2 方案 B：AccessSDK -> AccessRuntime -> SimVenue

优点：拓扑与未来 CTP adapter 一致。  
缺点：多一个进程、多一套连接/队列/重连；SimVenue 没有增加任何能力；当前阶段没有收益。

### 3.3 方案 C：复用 quantlink-fin 的 runtime/ORS

优点：已有代码。  
缺点：跨仓库耦合，引入 V3 抽象，违反 FastTrade 独立边界。

## 4. 组件

```text
access-sdk
  AccessConfig
  AccessClient
  AccessListener
  AccessHealth
  SequenceGuard

fasttrade-smoke
  AccessSmokeMain
```

### 4.1 AccessConfig

不可变 record：

```text
aeronDir
venueId
accountId
environment
sourceSessionId
sourcePublicationEpoch
streamBase
mdStream / orderStream / cancelStream / executionStream
positionStream / accountStream / sessionStream
```

规则：

- `channel` 固定 `aeron:ipc`。
- `--stream-base 9000` 时使用 `9001..9007`。
- 不传 stream base 时使用 contract 默认值 `1001..2006`。
- `venueId`、`accountId`、`environment` 必须非空。
- `sourceSessionId` / `sourcePublicationEpoch` 必须大于 0。

### 4.2 AccessClient

构造时创建：

```text
Subscriptions: md, execution, position, account, session
Publications: order, cancel
```

对外接口：

```java
int poll(int fragmentLimit)
boolean submit(OrderRequestEnvelope request)
boolean cancel(CancelRequestEnvelope request)
AccessHealth health()
Optional<AccountSnapshotEnvelope> account()
Optional<VenueSessionEnvelope> session()
Map<String, PositionEnvelope> positions()
boolean ready()
void close()
```

- 非线程安全；所有 `poll/submit/cancel` 在同一个回调线程调用。
- `poll` 每轮依次处理 session、execution、MD、position、account；每类最多 `fragmentLimit` 条。
- 未知 template、解码失败、字段校验失败：计数 + 日志，不抛到主循环。
- `submit/cancel` 只允许 `ready() == true` 且对应 publication `isConnected()`；否则抛 `IllegalStateException`，调用方可重试。
- 发布采用 250ms 重试窗口；超时抛 `IllegalStateException`，不静默返回成功。

### 4.3 AccessListener

回调全部在 `poll` 线程：

```java
onMarketData(MarketDataEnvelope)
onOrderUpdate(OrderUpdateEnvelope)
onTrade(TradeEnvelope)
onPosition(PositionEnvelope)
onAccount(AccountSnapshotEnvelope)
onSession(VenueSessionEnvelope)
```

默认实现为空，`AccessSmokeMain` 只覆盖需要的回调。

### 4.4 Session / ready

contract 没有显式登录请求。SimVenue 每秒发布 `VenueSession`：

```text
loginState = UP
settlementState = SETTLED
state = READY
```

`ready()` 条件：

```text
收到 session
loginState == UP
settlementState == SETTLED
state == READY
session、MD、execution subscription 已连接
order/cancel publication 已连接
session 快照未过期（5s 本地阈值）
```

会话变化处理：

- `(venueId, accountId, sourceSessionId, sourcePublicationEpoch)` 变化时，记录新会话。
- 用 `lastSeqByStream[executionStream]` 初始化 execution 高水位，避免加入已有会话时误报大量缺口。SimVenue 必须用配置后的 stream ID（例如 9004）发布，不能用固定的 2003；key 缺失时记录 `missingSessionHighWater`，不静默当成正常高水位。
- MD 每个 `(venue, exchange, instrument)` 独立维护 seq；新 session 重置。
- 不清空旧账户/持仓快照；新快照到达后覆盖；旧快照按 `staleAfterMs` 判定过期。

### 4.5 序列与重复

execution：

- `OrderUpdate`/`Trade` 共用一个 sequence。
- `sequence <= lastExecutionSequence`：重复，`duplicateExecution++`，忽略。
- `sequence > lastExecutionSequence + 1`：`executionGap++`，记录日志，继续处理。
- 处理成功后更新高水位。

MD：

- key = `venueId|exchange|instrumentId`。
- `seq <= last`：重复，`duplicateMarketData++`，忽略。
- `seq > last + 1`：`marketDataGap++`，记录日志，继续。
- 不同 session/epoch 重置该 key。

未知 `clientOrderId` 的回报：

- 不丢；计数 `orphanExecution++`，仍回调给上层。
- 上层负责缓存或告警。
- AccessClient 只保留最近 100,000 个已知订单 ID；更早的 ID 视为 orphan，避免内存随历史订单无限增长。

```text
shortcut: clientOrderId window is 100k entries; older IDs are treated as orphan.
```

### 4.6 快照

- Account：只保留最新一条；按 `snapshotTimestamp + staleAfterMs` 判断 `stale`。
- Position：按 `instrumentId` 保留最新一行；同一 `snapshotId` 内直接覆盖。不要在新 `snapshotId` 出现时清空旧行，因为 contract 没有批次结束标记，行是逐条到达的。已平仓标的通过 `snapshotTimestamp + staleAfterMs` 过期，而不是猜测批次边界。
- Session：只保留最新。

### 4.7 健康

`AccessHealth` 至少包含：

```text
connected
ready
lastSessionAt
lastMarketDataAt
lastExecutionAt
lastAccountAt
marketDataGap
executionGap
duplicateMarketData
duplicateExecution
orphanExecution
missingSessionHighWater
malformedFrames
submitFailures
```

`AccessSmokeMain` 在结束时打印 health，异常退出非 0。

## 5. Smoke 客户端

`AccessSmokeMain` 是一个可执行客户端，不是策略框架：

```text
1. 连接 Aeron
2. 等待 session READY，记录 `initialSessionHighWater = lastSeqByStream[executionStream]`
3. 等待第一条 au2612 MD
4. 以卖一价买入 1 手 LIMIT DAY
5. 等待 ACK/FILLED 和 Trade
6. 以买一价的 99% 挂 1 手不会成交的买单
7. 等待 ACK
8. 撤单，等待 CANCELED
9. 等待 account/position 快照更新
10. 打印结果和 health
11. 正常退出 0；任一条件超时退出 1
```

默认参数：

```text
--venue-id SIMVENUE
--account-id SIMVENUE-001
--environment SHADOW
--instrument au2612
--stream-base 9000
--timeout-ms 15000
--source-session-id <current-time-millis>
--source-publication-epoch 1
```

订单 ID：

```text
clientOrderIdBase = max(1, (sourceSessionId % 1_000_000_000) * 1000)
requestId = "ft-" + sourceSessionId + "-" + clientOrderId
```

保证 `clientOrderId` 在 contract 的 `1..999999999999` 范围内，且同一次运行内唯一。跨进程重启由新的 `sourceSessionId` 区分。

## 6. 重启

### 6.1 Smoke 客户端重启

- 新进程使用新的 `sourceSessionId` 和新的订单 ID。
- SimVenue 的持仓/账户仍在，FastTrade 通过快照重新读取。
- 不重放旧订单；订单归属由 `strategyKey` 和订单 ID 区分。

### 6.2 SimVenue 重启

- SimVenue 使用 VenueStore 恢复持仓、现金、订单。
- 新 `sourceSessionId` 发布新会话；AccessSDK 重置 sequence 高水位并等待新快照。
- FastTrade 不自动重发旧订单；由上层按业务决定。

## 7. 失败处理

| 情况 | 行为 |
|---|---|
| 未收到 session | `ready=false`，不提交订单 |
| session 非 READY | `ready=false`，不提交订单 |
| order/cancel publication 未连接 | `submit/cancel` 抛异常，不静默丢 |
| 发布 250ms 超时 | 抛异常，`submitFailures++` |
| execution 缺口 | 计数 + 日志，继续回调 |
| 重复 execution | 计数，忽略 |
| 未知订单回报 | `orphanExecution++`，仍回调 |
| 解码失败 | `malformedFrames++`，丢弃该帧，继续 |
| 快照过期 | `stale=true`，上层不得用于风险判断 |
| Aeron 断开 | `connected=false`，`ready=false`，等待恢复 |

## 8. 测试

### 8.1 单元测试

- `AccessConfig` stream base 映射和必填校验。
- `SequenceGuard`：连续、重复、缺口、新 session 重置。
- `AccessHealth` 计数快照。

### 8.2 真实 Aeron 测试

用嵌入式 MediaDriver + 测试 venue 端：

- session READY 前 `submit` 失败。
- READY 后提交订单，测试端收到 `OrderRequest`。
- 发布 `OrderUpdate` + `Trade` 共享 sequence，客户端按顺序收到。
- 重复 sequence 被忽略，缺口被计数。
- 快照按 instrument 更新。

### 8.3 190 E2E

```text
1. 启动 SimVenue（--stream-base 9000，独立 Aeron dir）
2. 启动 fasttrade-smoke
3. 验证 ACK + Trade + 持仓 + 账户 + 撤单
4. 再启动一次 smoke，验证客户端重启后仍能读取持仓/账户
5. 停止 SimVenue，再启动，验证 VenueStore 恢复后新会话可读
```

验收输出必须包含：

```text
FASTTRADE_E2E_OK
```

## 9. 构建与版本

- FastTrade 版本 `0.1.0`。
- 只依赖 contract artifact `com.quantlink.contract:venue-contract:0.1.8`，不依赖 SimVenue 源码。
- Java 25，Gradle 9.8.2。
- 构建在 190 上执行；本机只编辑和提交。

## 10. 后续

1. 在 AccessSDK 上实现 `CommonClient` / `ExecutionStrategy`。
2. 接入配置 DB 和运行状态 DB。
3. 实现新的 CTP adapter，直接发布 venue-contract；不增加独立 AccessRuntime 进程。
4. 增加 `RuntimeReporter` 和控制面。

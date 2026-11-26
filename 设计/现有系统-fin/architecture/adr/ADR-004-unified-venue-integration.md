# ADR-004 统一交易场所接入层（修订版）

- 状态：**APPROVED — 契约冻结；实现进行中（T-060/T-061）**
- 日期：2026-11-12
- 状态校准：2026-11-14。`APPROVED` 表示决策与契约通过，不代表 adapter/Ports/runner 已全部接入。冻结范围仅限身份、stream、SBE 字段；Venue Ports 的运行面投递语义仍在补齐。
- 评审记录：`docs/reviews/2026-11-12-adr-004-venue-review.md`
- 规范字段：`docs/architecture/venue-contract.md`
- 迁移计划：`docs/tasks/T-060-venue-integration-migration.md`

> 统一的是契约，不是进程。
> CTP C++、SimVenue Java、Replay Java 仍是独立 adapter，通过 Aeron/SBE 实现同一 Venue Contract。

## 1. 决策摘要

| # | 决策 |
|---|---|
| D1 | `venueId` 是唯一接入身份；`accountId`、`exchange`、`counterparty` 分离 |
| D2 | 交易核心只依赖 Venue Ports + Registry，不依赖 CTP/SIMVENUE |
| D3 | 所有 adapter 统一 MarketData / OrderUpdate / Trade / Account / Position / Session envelope |
| D4 | stream 由 Registry/ORS 分配，禁止默认共用 1001；replay 区不复用 |
| D5 | `venueType` 仅元数据；行为由 capabilities/environment 决定 |
| D6 | 先契约/conformance，再 registry/stream，再 adapter/ports，最后删旧分支 |
| D7 | v1 路由键 `(venueId, accountId) -> ORS -> channel/stream` |

## 2. 身份与所有权

### 2.1 唯一映射

```text
venueId        = venue_configs.id
accountId      = accounts.id
exchange       = instruments.exchange
orsId          = ors_instances.ors_id

venue_configs.id
  = accounts.venue_id
  = orders.venue_id
  = ors_instances.venue_id
```

SBE 兼容字段：

```text
SBE counterpartyId 语义 = venueId
```

`counterpartyId` 保留为 wire 字段名，但不再作为独立路由主键。

### 2.2 SimVenue

现有默认：

```text
--venue-id SIMVENUE-001
--account  SIMVENUE-001
```

修订后：

```text
venueId   = SIMVENUE
accountId = SIMVENUE-001
```

`venue_configs.id`、`SimVenue --venue-id`、`accounts.venue_id` 必须一致。
部署 env 不得再用 `SIMVENUE-001` 作为 venueId。

### 2.3 路由键

v1：

```text
(venueId, accountId) -> orsId -> channel/stream
```

`VenueDescriptor` 声明 venue 默认/能力；`ors_instances` 持有该账户的实际执行通道。
ORS 覆盖必须显式，服务端校验：

```text
account.venue_id == request.venueId
```

## 3. VenueDescriptor

```text
VenueDescriptor {
  venueId
  descriptorVersion
  counterpartyId          // = venueId（兼容字段名）
  exchange[]
  environment             SHADOW | LIVE | REPLAY
  venueType               CTP | SIM | REPLAY   // 仅元数据
  adapterKind             CTP_CPP | SIM_JAVA | REPLAY_JAVA
  enabled / status
  capabilities[]          {supported, constraints}
  accountBindings[]
  channels/streams
  calendarMode
  sessionPolicy
  snapshotSources
  healthSource
  reconciliationMode
  writerRole
}
```

Capabilities 至少：

```text
MD
ORDER
CANCEL
POSITION
ACCOUNT
CALENDAR
SETTLEMENT
FEES
MARGIN
OPTION_CHAIN
RECONCILIATION
HEALTH
SNAPSHOT
TRADE
ORDER_SNAPSHOT
TRADE_SNAPSHOT
REPLAY
```

未知 venue/capability 必须 fail-closed，禁止默认 CTP/SIMVENUE。

## 4. Venue Ports

Port 只在 control-plane/runner 消费侧，C++ 不实现 Java 接口。

```java
interface VenueRegistryPort {
    VenueDescriptor require(VenueId venue);
    List<VenueDescriptor> list(Capability capability);
}

interface VenueMarketDataPort {
    Subscription subscribe(VenueId venue, InstrumentKey key,
                           Consumer<MarketDataEnvelope> sink);
}

interface VenueExecutionPort {
    OrderSubmission submit(VenueId venue, OrderRequestEnvelope request);
    CancelSubmission cancel(VenueId venue, CancelRequestEnvelope request);
}

record OrderSubmission(String requestId, boolean acceptedForPublication) {}
record CancelSubmission(String requestId, boolean acceptedForPublication) {}

interface VenueAccountPort {
    Snapshot<AccountSnapshot> account(VenueId venue, AccountId account);
    Snapshot<List<PositionSnapshot>> positions(VenueId venue, AccountId account);
}

interface VenueHealthPort {
    VenueSession session(VenueId venue, AccountId account, OrsId ors);
}

record Snapshot<T>(T value, Instant asOf, boolean stale) {}
```

`submit` 不是同步成交确认，只表示“已受理发布”；真实 ACK/成交从 OrderUpdate/Trade 异步回来。

## 5. 统一消息

完整字段表见 `docs/architecture/venue-contract.md`。

### 5.1 MarketData

使用新消息 `MarketDataV2`，固定字段必须位于 Bids/Asks group 之前：

```text
venueId / counterpartyId
sourceSessionId
sourcePublicationEpoch
seq
exchange
instrumentId
eventTime / publishTime
last/bid/ask/depth
volume/openInterest
synthetic
environment
replayEpoch
replaySessionId
recordingId
framePosition
engineId
```

`seq` 作用域：

```text
(venueId, sourceSessionId, sourcePublicationEpoch, exchange, instrumentId)
```

从 1 单调；重复/旧序丢弃；gap 必须检测并告警，进入 WARMUP。

### 5.2 Execution

拆为：

```text
OrderUpdateEnvelope
TradeEnvelope
CancelRequestEnvelope
```

必须包含：

```text
venueId/accountId/instrumentId/exchange
clientOrderId/venueOrderId
requestId/routeId
deploymentId/generation
orderEpoch/fencingToken/sequence
environment
status/filledQty/remainingQty/avgPrice/reason
tradeId/fee
```

`venueOrderId` 来自 CTP OrderSysID，不用 instrumentId 代替。

`OrderUpdateV2.sequence` 的作用域是 `(venueId, sourceSessionId,
sourcePublicationEpoch)` 的 stream-global 单调序号；它不是 per-clientOrder
序号，consumer 不得用它推断单个订单的 gap。per-order 完整性必须依赖
`status/filledQty/tradeId` 与 venue 快照对账。

### 5.3 Account/Position

Position 保留现有 V2 字段：

```text
longQty/shortQty
todayLong/todayShort
yesterdayLong/yesterdayShort
avgPrice/longAvgPrice/shortAvgPrice
settlementPrice
```

Account 保留：

```text
balance/available/margin/frozenMargin
commission/closeProfit/positionProfit
deposit/withdraw
```

Snapshot 增加：

```text
venueId/accountId
snapshotId
asOf/tradingDay
staleAfterMs
source
```

### 5.4 VenueSession

键：

```text
(venueId, accountId, orsId)
```

字段：

```text
sourceSessionId
sourcePublicationEpoch
fencingToken
tradingDay
loginState/settlementState
leaseExpiry
lastSeqByStream
adapterSessionId
state STARTING|READY|REPLAYING|FENCED|LOST
reason
```

fencing 规则：

```text
current fencing > 0 时，incoming 0 拒绝
只有 SHADOW + legacy 才允许 0
旧 session/epoch/orderEpoch 一律拒绝
```

## 6. Registry 与 ORS

```text
VenueRegistry
  venueId -> VenueDescriptor
  capabilities / calendar / health / snapshot sources

ORS
  (venueId, accountId) -> orsId
  -> actual channel/stream allocation
```

优先级：

```text
descriptor 默认流 < ORS 显式覆盖
覆盖不一致 -> registry 启动失败
```

禁止：

```text
按 account 查 ORS 后绕开 request.venueId 校验
按 venueType 选 reconciler/stream
```

## 7. Stream / ORS 分配

`ors_instances` 是唯一事实源，`VenueDescriptor` 只给默认值。

当前实际分配（2026-11-12）：

```text
SIMNOW       MD 1100  order 2100  cancel 2101  update 2102  trade 2103  position 2006
SIMSHENGLI   MD 1110  order 2110  cancel 2111  update 2112  trade 2113  position 2013
SIMVENUE     MD 1001  order 3140  cancel 3141  update 3142  trade 3143  position 2014
```

保留区间（只做规划）：

```text
1000-1199   market data
2001-2005   legacy execution
2006-2099   snapshot（每 writer 唯一）
2100-2999   sim/test execution
3000-3999   prod execution
4000-4999   telemetry/control
9001-9999   replay (ADR-003)
```

规则：

```text
不得按 venueType 推导 stream
不得回退 1001/2100/3140
同一 (channel, stream, writerRole) 只能有一个 writer
多 reader 共享时必须按 venueId scope
position 2006 拆给两个 CTP；Shengli 用 2013，避开 account 2007
replay 发布只能落 9001-9999
迁移期双订阅旧/新流
```

## 8. 迁移顺序

```text
A0 身份映射 + SBE 字段 + golden vectors
A1 conformance harness（fake adapter + CTP 录制帧）
A2 descriptor 读模型 + registry 校验（不切路由）
B stream 双订阅 + ORS 迁移
C1 CTP adapter（shadow）
C2 SimVenue adapter（shadow）
C3 Replay adapter（shadow）
D Venue Ports + feature flag + shadow compare
F conformance 全绿（从 A 持续）
E 最后删除旧分支
```

每阶段必须有：

```text
feature flag
双读/双订阅
回滚触发条件
在途订单/回报处理
```

## 9. 验收

```text
1. 同一策略代码/配置，新建 deployment 指向新 venueId/account/ORS，不改代码
2. 交易核心无 `venueType` 分支，且无字面量 `venueId` 分支
3. 行情 seq 严格递增、无重复/乱序，gap 被检测并告警
4. 旧 session/epoch/fencing 被拒绝，0 值规则明确
5. 同一 (channel,stream) 两 venue 不交叉归因；registry 拒绝重复 writer
6. 同一 conformance suite 跑 CTP 录制帧、SimVenue、Replay
7. 新 venueId 的 UI 不依赖字面量
```

## 10. 非目标

```text
不合并 CTP/SimVenue 进程
不做真实 CTP wire protocol 兼容
不要求模拟撮合等价真实交易所
不做完整 FIX/快速行情
不替代 ADR-001/002/003 的指标协议
```

## 11. 风险

| 风险 | 处理 |
|---|---|
| 身份迁移 | A0 映射表 + DB 约束 |
| SBE 版本兼容 | 追加字段 + 版本/Schema 兼容测试 |
| stream 切换在途订单 | 双订阅 + 迁移窗口 |
| replay 9xxx 冲突 | 禁止非 replay 使用 9xxx |
| descriptor/ORS 双源 | 明确优先级 + 启动校验 |
| environment 失真 | 删除 mapper 硬编码 SHADOW |
| cancel 无 fencing | CancelRequest 补字段 + adapter 校验 |
| CTP IPC-only | descriptor 标记或 CTP 增加 channel 参数 |

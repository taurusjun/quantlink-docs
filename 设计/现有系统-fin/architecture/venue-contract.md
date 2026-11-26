# 统一交易场所契约（Venue Contract）

- 状态：**APPROVED — 规范字段基线**
- 日期：2026-11-12
- 关联：`docs/architecture/adr/ADR-004-unified-venue-integration.md`
- 迁移：`docs/tasks/T-060-venue-integration-migration.md`

> 本文件是 ADR-004 的规范性字段表。
> SBE 字段 ID 在实现前必须冻结；本文给出的 ID 是建议值，合并前由 schema owner 确认。

## 1. 身份映射

| 业务概念 | 数据库 | SBE | 规则 |
|---|---|---|---|
| venueId | `venue_configs.id` | `counterpartyId`（兼容名） | 唯一接入身份 |
| accountId | `accounts.id` | `accountId` | 账户身份 |
| exchange | `instruments.exchange` | `exchange` | SHFE/DCE/... |
| orsId | `ors_instances.ors_id` | `routeId` / 配置 | 执行实例 |
| environment | `venue_configs`/`orders` | `environment` | SHADOW/LIVE/REPLAY |

不变量：

```text
venue_configs.id = accounts.venue_id = orders.venue_id = ors_instances.venue_id
SimVenue --venue-id = venue_configs.id
SBE counterpartyId 语义 = venueId
accountId 不参与 venue 身份
```

## 2. MarketDataV2

现有 `MarketData` 的固定字段和 group 布局不适合把新字段追加在 group 之后。
新增 `MarketDataV2`（建议 message id=29），固定字段全部放在 Bids/Asks group 之前。

### 2.1 新消息布局

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

建议字段 ID：

```text
sourceSessionId          id=30  uint64
sourcePublicationEpoch   id=31  uint64
seq                      id=32  uint64
publishTime              id=33  uint64
environment              id=34  Environment
replayEpoch              id=35  uint64
replaySessionId          id=36  char[64]
recordingId              id=37  uint64
framePosition            id=38  uint64
engineId                 id=39  char[64]
```

### 2.2 现有字段

```text
instrumentId  id=1
timestamp     id=2
lastPrice     id=3
volume        id=4
openInterest  id=5
synthetic     id=6
counterpartyId id=7   // 语义改为 venueId
exchange      id=8
Bids group    id=10 (price 11, qty 12)
Asks group    id=20 (price 21, qty 22)
```

### 2.3 规则

```text
seq 作用域 = (venueId, sourceSessionId, sourcePublicationEpoch,
              exchange, instrumentId)
seq 从 1 开始，单调
重复 seq 丢弃
seq > last+1 -> gap，WARMUP/告警
synthetic 只表示数据是否模拟，不表示 venueType
```

### 2.4 每 venue MD 分配

`ors_instances` 是唯一事实源，下面是 190 当前实际值：

```text
SIMNOW       1100
SIMSHENGLI   1110
SIMVENUE     1001
SIMVENUE-RPL 1011（仅测试 replay 预留，不是生产 MD）

注意：2007 是 account snapshot，不可被 position 复用。
```

禁止按 `venueType` 推导；禁止代码回退 1001。

## 3. OrderRequest v2

现有 `OrderRequestV2` 已包含大部分字段。必须保证：

```text
counterpartyId == venueId
exchange ∈ VenueDescriptor.exchange[]
environment 由调用方给出，不由 mapper 默认 SHADOW
```

新增/明确：

```text
venueId alias     -> counterpartyId
accountId         id=9
bookId            id=17
routeId           id=13
deploymentId      id=20
generation        id=21
orderEpoch        id=22
fencingToken      id=14
environment       id=23
```

## 4. OrderUpdate v2

现有 `OrderUpdateV2` 已有 1-21。必须修正：

```text
exchangeOrderId id=2  语义 = venueOrderId，不得填 instrumentId
counterpartyId id=16  语义 = venueId
sequence id=11        作用域 = (venueId, sourceSessionId, sourcePublicationEpoch)
                      的 stream-global 单调序号；不得用它推断 per-order gap
```

新增：

```text
sourceSessionId          id=30
sourcePublicationEpoch   id=31
eventTime                id=32
```

## 5. Trade v2

现有 `TradeV2` 已有 1-19。必须保证：

```text
tradeId 全局唯一（venueId + tradeId）
instrumentId/exchange/side/price/qty/timestamp
requestId/routeId/deployment/generation
counterpartyId = venueId
orderEpoch/fencingToken/environment
```

新增：

```text
fee              id=30 double
sourceSessionId  id=31
sourcePublicationEpoch id=32
```

## 6. CancelRequest v2

现有 `CancelRequestV2` 有 1-8。新增：

```text
counterpartyId          id=9
exchange                id=10
environment             id=11
sourceSessionId         id=30
sourcePublicationEpoch  id=31
```

adapter 必须校验：

```text
account.venue_id == request.counterpartyId
fencing/orderEpoch current
```

## 7. AccountSnapshot

现有字段：

```text
accountId 1
balance 2
available 3
margin 4
frozenMargin 5
commission 6
closeProfit 7
positionProfit 8
timestamp 9
deposit 10
withdraw 11
```

新增：

```text
counterpartyId/venueId  id=30
environment             id=31
snapshotId              id=32
tradingDay              id=33
staleAfterMs            id=34
```

## 8. PositionSnapshotV2

现有 1-19 已包含 today/yesterday/long-short/avg/settlement。

新增：

```text
environment             id=30
snapshotId              id=31
source                  id=32  // CTP/SIM/REPLAY
```

不得丢：

```text
longQty/shortQty
todayLong/todayShort
yesterdayLong/yesterdayShort
avgPrice/longAvgPrice/shortAvgPrice
settlementPrice
```

## 9. VenueSession（新 SBE message，建议 id=28）

```text
venueId / counterpartyId
accountId
orsId
sourceSessionId
sourcePublicationEpoch
fencingToken
tradingDay
loginState
settlementState
leaseExpiry
lastSeqByStream group {streamId,lastSeq}
adapterSessionId
state
reason
timestamp
```

状态：

```text
STARTING | READY | REPLAYING | FENCED | LOST
```

## 10. Fencing / Epoch 规则

```text
current fencingToken > 0 时，incoming 0 拒绝
只有 SHADOW + legacy 才允许 0
旧 sourceSessionId / publicationEpoch / orderEpoch 拒绝
新 publicationEpoch 的 seq=1 不算重复
```

## 11. Capability

```text
MD / ORDER / CANCEL / POSITION / ACCOUNT
CALENDAR / SETTLEMENT / FEES / MARGIN
OPTION_CHAIN / RECONCILIATION / HEALTH
SNAPSHOT / TRADE / ORDER_SNAPSHOT / TRADE_SNAPSHOT / REPLAY
```

Capability 不是布尔：

```text
{ supported, constraints, asOf }
```

未知 venue/capability -> reject，不默认 CTP/SIMVENUE。

## 12. Stream 分配

`ors_instances` 是唯一事实源。保留区间：

```text
1000-1199   MD
2001-2005   legacy execution
2006-2099   snapshot（每 writer 唯一）
2100-2999   sim/test execution
3000-3999   prod execution
4000-4999   telemetry/control
9001-9999   replay only
```

禁止：

```text
按 venueType 推导 stream
代码回退 1001/2100/3140
9101 作为 SimVenue MD（与 replay 冲突）
3150 作为 MD
同一 (channel,stream,writerRole) 多个 writer
replay 发布写 live stream
```

## 13. Replay 上下文

Replay adapter 必须保留：

```text
engineId
replayEpoch
replaySessionId
recordingId
framePosition
sourceSessionId
sourcePublicationEpoch
```

MarketData 新字段 `replayEpoch/replaySessionId/recordingId/framePosition` 仅在 replay 时非 0。
`replaySessionId` 使用 `char[64]`，与 ADR-003 的 TEXT 对齐；`engineId` 使用 `char[64]`。

## 14. Conformance Cases

```text
V-01 identity: venueId/account/exchange
V-02 MD 字段完整
V-03 seq 严格递增/重复丢弃/gap 告警
V-04 session/epoch 切换
V-05 order 幂等
V-06 cancel fencing
V-07 update/trade 字段
V-08 account/position today/yesterday
V-09 snapshot stale
V-10 unknown venue/capability reject
V-11 same stream two venue no cross-attribution
V-12 replay context
```

## 15. 兼容策略

```text
1. SBE 新字段只追加，不改旧字段 ID
2. CTP C++ 与 Java codegen 同步更新
3. 旧 consumer 忽略新字段时仍能解析旧字段
4. 新 consumer 对缺失新字段 fail-closed
5. 先 shadow 双读，再切生产
```

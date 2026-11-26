# 统一接入冻结清单（2026-11-12）

- 状态：**FROZEN — S0-04**
- 范围：venue identity / ORS stream / SBE message-field IDs
- 不冻结：`VenuePorts` 运行面接口、事件投递语义、runner 内部线程模型。它们见 ADR-004 §4 与 V3 运行面设计；当前仍为实现进行中。
- 依据：
  - `docs/architecture/adr/ADR-004-unified-venue-integration.md`
  - `docs/architecture/venue-contract.md`
  - `docs/tasks/T-060-venue-integration-migration.md`
  - `docs/testing/T-060-venue-acceptance.md`

> 任何字段/stream/身份变更必须同时更新本文件、ADR-004、venue-contract、T-060，
> 并重新跑 T-060 V-A0/V-A1。代码不得以本文件之外的值作为默认。

## 1. 身份

| venueId | accountId | orsId | adapter | DB 约束 |
|---|---|---|---|---|
| SIMNOW | TEST-001 | ors-simnow-test-001 | CTP_CPP | `account.venue_id = SIMNOW` |
| SIMSHENGLI | TEST-SHENGLI | ors-shengli-test-shengli | CTP_CPP | `account.venue_id = SIMSHENGLI` |
| SIMVENUE | SIMVENUE-001 | ors-simvenue-001 | SIM_JAVA | `account.venue_id = SIMVENUE` |

不变量：

```text
venueId = venue_configs.id
accountId = accounts.id
SBE counterpartyId = venueId
SimVenue --venue-id = SIMVENUE
SimVenue --account  = SIMVENUE-001
```

## 2. Stream（190 实际值，ORS 为唯一事实源）

| venueId | MD | order | cancel | update | trade | position |
|---|---:|---:|---:|---:|---:|---:|
| SIMNOW | 1100 | 2100 | 2101 | 2102 | 2103 | 2006 |
| SIMSHENGLI | 1110 | 2110 | 2111 | 2112 | 2113 | 2013 |
| SIMVENUE | 1001 | 3140 | 3141 | 3142 | 3143 | 2014 |

规则：

```text
同一 (channel, stream, writerRole) 只能一个 writer
MD reader 可共享，但必须按 venueId scope
position 2006 拆分完成前只允许一个 CTP 写；Shengli 用 2013，2007 是 account snapshot
replay 发布只允许 9001-9999
```

已知 P0：

```text
迁移前 SimNow/Shengli 共用 position 2006
SimVenue MD 1001 是模拟行情，不是 CTP 行情
```

## 3. SBE

### 3.1 新消息

| Message | ID | 说明 |
|---|---:|---|
| `VenueSession` | 28 | session/lease/fencing/stream seq group |
| `MarketDataV2` | 29 | venue-scoped MD + source/replay context |

### 3.2 字段 ID

`MarketDataV2`：

```text
instrumentId 1, timestamp 2, lastPrice 3, volume 4, openInterest 5,
synthetic 6, counterpartyId 7, exchange 8
sourceSessionId 30, sourcePublicationEpoch 31, seq 32, publishTime 33,
environment 34, replayEpoch 35, replaySessionId 36, recordingId 37,
framePosition 38, engineId 39
Bids group 10, Asks group 20
```

`VenueSession`：

```text
counterpartyId 1, accountId 2, orsId 3, sourceSessionId 4,
sourcePublicationEpoch 5, fencingToken 6, tradingDay 7,
loginState 8, settlementState 9, leaseExpiry 10,
adapterSessionId 11, state 12, reason 13, timestamp 14
lastSeqByStream group 20 { streamId 21, lastSeq 22 }
```

扩展字段：

```text
OrderRequestV2:   sourceSessionId 30, sourcePublicationEpoch 31
OrderUpdateV2:    sourceSessionId 30, sourcePublicationEpoch 31, eventTime 32
TradeV2:          fee 30, sourceSessionId 31, sourcePublicationEpoch 32
CancelRequestV2:  counterpartyId 9, exchange 10, environment 11,
                  sourceSessionId 30, sourcePublicationEpoch 31
AccountSnapshot:  counterpartyId 30, environment 31, snapshotId 32,
                  tradingDay 33, staleAfterMs 34
PositionSnapshotV2: environment 30, snapshotId 31, source 32
```

### 3.3 枚举

```text
VenueSessionState: STARTING 0, READY 1, REPLAYING 2, FENCED 3, LOST 4
SettlementState: NONE 0, PENDING 1, SETTLING 2, SETTLED 3, FAILED 4
DataSource: UNKNOWN 0, CTP 1, SIM 2, REPLAY 3, ARCHIVE 4
```

## 4. 冻结哈希

```text
abi/sbe/quantlink-fin-sbe.xml
1994423e0ec79737a9b6aadc8245010284cdc3572eab5016e20271e1722e47be

docs/tasks/T-060-venue-integration-migration.md
457e71f59c66f1bdab4039569a0c52357fd6f63626d5a99b6d8bcc3dd1fa0401

docs/testing/T-060-venue-acceptance.md
e4a0f2dea831cb2538ac7393aa5acf9b821a226651a5bd2744a3bb7b66322710

docs/testing/T-059-test-remediation.md
6de1b6369cd092342afd7696e6eb3d9c3a97824c835bef713886fb0c21d7323e

docs/tasks/T-061-v2-master-execution.md
2870f59f72e276daae94f9fbd9508ac20735623ddfe71954db82e24cdb05cfdf
```

## 5. 变更控制

```text
新增/修改 SBE 字段 ID -> 必须重新生成 Java/C++，跑 V-A0-03..09
修改 stream 值        -> 必须先改 ors_instances，再改 adapter 参数，跑 V-B
修改身份              -> 必须跑 V-A0-01/02，更新 DB 约束
```

## 6. 当前证据

```text
Java SBE tests: 6 tests passed
Java -> C++ interop: OK
C++ SBE V2 codec: OK
migrate-t060-venue-identity.sql: 已写，未应用到 190
validate-t060-venue-streams.sql: 只读诊断
```

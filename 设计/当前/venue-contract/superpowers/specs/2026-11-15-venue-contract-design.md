# Venue Contract v0.1 Design

- 日期：2026-11-15
- 状态：DRAFT — 等待确认
- 仓库：`quantlink-venue-contract`
- 字段字典：[`docs/contract-fields.md`](../contract-fields.md)

## Intent

把 venue contract 从 `quantlink-fin` 中独立出来，成为 SimVenue 和 FastTrade 共同依赖的唯一合同 artifact。

v0.1 优先解决：

```text
发布
版本
消费方固定版本
190 单机构建顺序
一致性验收
```

## Goals

```text
1. contract 独立构建，不依赖 quantlink-fin
2. SBE、envelope、codec、validator、sequence guard 都在 contract 仓库
3. contract 版本由 Gradle/Maven version 表达
4. 每次 contract 改动 bump 版本，不覆盖
5. 190 上 publishToMavenLocal，SimVenue/FastTrade 同机构建
6. 消费方固定 contract 版本
7. 不做旧代码兼容
8. pre-1.0 允许破坏性变更
```

## Non-Goals

```text
ContractMetadata
schemaHash
ContractHandshake
handshake stream
多版本并存
Nexus / 私服 / GitHub Packages
旧包名兼容
旧 SBE 字段兼容
V1/V2 双版本
SimVenue / FastTrade 实现
quantlink-fin 迁移
```

## Decisions

### 消息集合

v0.1 只保留 9 个 canonical 消息：

```text
Instrument
MarketData
OrderRequest
CancelRequest
OrderUpdate
Trade
PositionSnapshot
AccountSnapshot
VenueSession
```

删除：

```text
所有 V1/V2 重复
StrategyPnl
StrategyPosition
IndicatorValue
CtpOrderSnapshot
CtpTradeSnapshot
GatewayHealth
```

### 命名

```text
SBE package:       com.quantlink.contract.sbe
contract package:  com.quantlink.contract.venue
```

消息名不带 `V2`：

```text
MarketData
OrderRequest
CancelRequest
OrderUpdate
Trade
PositionSnapshot
```

### 字段

字段语义以 `docs/contract-fields.md` 为准。

关键删除：

```text
strategyId
bookId
publishTime
replayEpoch / replaySessionId / recordingId / framePosition / engineId
eventTime
counterpartyId（改名 venueId）
```

关键新增：

```text
Trade.tradingDay
Trade.feeKnown
```

### Execution stream

每个 ORS/账户只有一条 execution stream。

```text
OrderUpdate
Trade
```

两者共用这条流和同一个 `sequence`；消费方按 SBE `templateId` 分发。
不按消息类型拆成 order-update / trade 两条流。

### Codec direction matrix

每条 canonical 消息必须明确 encode 入口和 decode 入口。

| Message | encode 负责方 | decode 负责方 | Codec |
|---|---|---|---|
| Instrument | venue/接入层 | 消费方 | `InstrumentCodec` |
| MarketData | venue/接入层 | 消费方 | `MarketDataCodec` |
| OrderRequest | TradeBot | AccessRuntime | `OrderRequestCodec` |
| CancelRequest | TradeBot | AccessRuntime | `CancelRequestCodec` |
| OrderUpdate | AccessRuntime | TradeBot | `VenueExecutionCodec` |
| Trade | AccessRuntime | TradeBot | `VenueExecutionCodec` |
| PositionSnapshot | AccessRuntime/ORS | TradeBot | `PositionSnapshotCodec` |
| AccountSnapshot | AccessRuntime/ORS | TradeBot | `AccountSnapshotCodec` |
| VenueSession | AccessRuntime | TradeBot | `VenueSessionCodec` |

只有单向需求时，必须在设计中写明原因。

验收时每条消息至少覆盖：

```text
encode -> decode 字段一致
错误 templateId 拒绝
必填字段缺失拒绝
```

### 发布物

两个 artifact，同一版本：

```text
com.quantlink.contract:venue-contract-sbe:0.1.8
com.quantlink.contract:venue-contract:0.1.8
```

当前补丁版本是 `0.1.8`：0.1.0 是初始发布，0.1.1 修正执行事件校验与 sequence baseline，0.1.2 补齐消息 codec、边界校验和 guard 容量限制，0.1.3 修正 envelope 状态与可选字段边界，0.1.4 补齐 execution/session encode，0.1.5 修正 null 文本和期权元数据校验，0.1.6 修正期权类型组合和 execution requestId，0.1.7 校验 tradingDay，0.1.8 增加 contract 级 unknown order 错误码；两个 artifact 同步发布 `0.1.8`。

消费方只声明：

```text
implementation("com.quantlink.contract:venue-contract:0.1.8")
```

`venue-contract` 通过 POM 依赖 `venue-contract-sbe`。

### 版本

```text
起始版本：0.1.0
不使用 SNAPSHOT 做 190 验收
每次 contract 改动 bump version
不覆盖已发布版本
```

### 验收机器

```text
只在 190 验收
本机只用于编辑/代码审查
190 上使用 JDK 25 和运行服务的同一 OS 用户构建
```

### quantlink-fin

```text
v0.1 out of scope
不改 fin
不迁移 fin
后续单独迁移
```

这会产生短期双份合同，接受该风险，并用 contract version 明确边界。

### 消费方 smoke

v0.1 增加一个独立 smoke-consumer：

```text
smoke-consumer/
  settings.gradle.kts
  build.gradle.kts
  src/main/java/...
```

它从 `mavenLocal` 解析：

```text
com.quantlink.contract:venue-contract:0.1.0
```

并解码一条 `MarketData`。  
这是发布物可消费的最小证据，不代表 SimVenue/FastTrade 已完成接入。

### deploy 版本矩阵

`quantlink-deploy/docs/version-matrix.md` 先记录：

```text
contract: 0.1.0
simvenue: pending
fasttrade: pending
fin: pending
```

SimVenue/FastTrade 接入后再更新。

## Build Layout

```text
quantlink-venue-contract/
├── settings.gradle.kts
├── build.gradle.kts
├── abi/sbe/quantlink-fin-sbe.xml
├── tools/gen_sbe.sh
├── shared/sbe/
├── venue-contract/
├── smoke-consumer/
└── docs/
    ├── contract-fields.md
    └── superpowers/specs/2026-11-15-venue-contract-design.md
```

## Dependencies

允许：

```text
io.aeron:aeron-client
org.agrona:agrona
slf4j
```

禁止：

```text
quantlink-fin
sim-exchange
sim-venue
control-plane
runtime
runtime-runner
```

## Acceptance on 190

```text
cd /path/to/quantlink-venue-contract
./gradlew clean build
./gradlew publishToMavenLocal

artifact exists:
  ~/.m2/repository/com/quantlink/contract/venue-contract-sbe/0.1.0/
  ~/.m2/repository/com/quantlink/contract/venue-contract/0.1.0/

SBE round-trip tests pass
envelope codec/validator tests pass
sequence guard conformance tests pass
recorded CTP frame test passes

smoke-consumer resolves venue-contract:0.1.0
and decodes a MarketData frame

runtimeClasspath has no business repo dependency
contract packages are com.quantlink.contract.*
```

## What Is Left to the Builder

- 按 `docs/superpowers/plans/2026-11-15-venue-contract.md` 实施。
- 删除旧 plan 中的 `ContractMetadata` / `schemaHash` / handshake / V2 任务。
- 重新生成 SBE 包名为 `com.quantlink.contract.sbe`。
- contract 类包名改为 `com.quantlink.contract.venue`。
- 用固定 `0.1.0` 发布两个 artifact。
- 在 190 上跑 smoke-consumer。
- 更新 `quantlink-deploy` 版本矩阵为 pending。

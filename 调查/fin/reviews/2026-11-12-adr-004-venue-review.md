# ADR-004 统一交易场所接入层评审

> **历史评审（2026-11-12）**。本文保留当时的 P0/OPEN 判断用于追溯；其中身份/stream/SBE 已由 S0-04 冻结，Ports 与 adapter 接入仍按 T-061 状态表为 PARTIAL。当前是否完成以 T-060/T-061 和代码为准，不要把本文的 OPEN 当成今天的最终状态。

- 日期：2026-11-12
- 对象：`docs/architecture/adr/ADR-004-unified-venue-integration.md`
- 结论：**APPROVED（设计层；第三轮确认）**
- 含义：方向正确，“统一契约、adapter 独立进程”成立；但当前文本不能冻结为实施契约。

## 1. 总体判断

```text
原则 CLOSED：统一的是契约，不是进程
Port 边界 PARTIAL：同步 Port 与 Aeron 异步语义冲突
Canonical envelope OPEN：关键字段不在 wire 上
Stream 分配 OPEN：1001 串流、9101 与 ADR-003 replay 冲突
Registry/ORS PARTIAL：双路由源未裁决
验收 PARTIAL：只切 venueId 与部署不可变绑定冲突
```

## 2. 仍阻止实施的 P0

### P0-1 身份模型未裁决

证据：

```text
venue_configs.id = SIMVENUE
SimVenue --venue-id = SIMVENUE-001
account id = SIMVENUE-001
SBE MarketData 字段 = counterpartyId
orders.venue_id 被当 counterparty_id 使用
```

必须先定义唯一映射：

```text
venueId = venue_configs.id = orders.venue_id = ors_instances.venue_id
accounts.id 是账户，不参与 venue 身份
SBE counterpartyId 作为兼容字段名
SimVenue --venue-id 必须等于 venue_configs.id
```

### P0-2 行情 canonical envelope 不在 wire 上

`MarketDataCodec` 不写/不读 `counterpartyId/exchange`；
`MarketDataMessage` 没有 venue/session/epoch/seq；
CTP `publishTick` 和 SimVenue 生成器都没有这些字段。

ADR-004 §5.1 的字段目前无法被消费者看到。

关闭条件：

```text
新增 SBE schema 版本/字段 ID
改 MarketDataCodec/MarketDataMessage
改 CTP publishTick + SimVenue generator
golden vectors
seq 生成/持久化/restart 规则
```

### P0-3 执行/账户/session 契约不完整

缺：

```text
TradeEnvelope / tradeId / fee
instrument/exchange/side/offset/orderType/TIF/price/qty
environment / orderEpoch / bookId
sequence 作用域
CancelRequest 的 venue/fencing/orderEpoch
Position today/yesterday/long-short/settlementPrice
Account venue/counterparty
Session accountId/orsId/tradingDay/loginState/lease/lastSeq
```

CTP `OrderReport` 没有 `orderSysId`，`publishOrder` 把 `instrumentId` 写进 `exchangeOrderId`。

### P0-4 stream 分配与串流

```text
ADR-004 建议 SimVenue test md=9101
ADR-003 已把 9001-9999 分配给 replay
9101 直接冲突
CTP 与 SimVenue 默认都发 1001
MarketDataAeronConsumer 按订阅 route 给消息盖 venue
=> 两个 venue 同时发 1001 会交叉归因
runbook 用 3150 作 MD，落在 prod execution 区
venue_type CHECK 不含 REPLAY
```

### P0-5 Registry 与 ORS 双路由源

ADR 说 `VenueRegistry` 是唯一路由来源，但实际 channel/stream 在 `ors_instances`；
`ManualOrderPublisher` 按 account 查 ORS；`AeronOrderGateway` 从 execution context 取 stream。

必须先定义：

```text
(venueId, accountId) -> ORS -> channel/stream
descriptor 只声明 venue 默认/能力
ORS 覆盖必须显式且与 descriptor 一致
account.venue_id == request.venueId
```

### P0-6 验收 #1 与部署不可变绑定冲突

ADR 写“同一策略只切 venueId”，但现有 `StrategyOrderService` 拒绝 account/venue/ORS 变化，`agent_strategy_bindings` 对 strategy_id 唯一。

应改为：

```text
同一策略代码/配置
新建 deployment 指向新 venueId/account/ORS
不改代码
```

或新增显式 switch/fork 协议。

## 3. 关键设计问题

### Ports 签名

`OrderAck submit` 是同步返回，但真实路径是 Aeron 异步回报。应改为：

```text
OrderSubmission { requestId, acceptedForPublication }
CompletableFuture<OrderAck>
```

`AccountPort` 应返回 `Snapshot<T> { asOf, stale }`，而不是同步值。

### CTP channel

CTP adapter 硬编码 `aeron:ipc`；ADR 的 registry channel 对 CTP 不可兑现。
要么 CTP 增加 channel 参数，要么 descriptor 明确 `IPC_ONLY`。

### capability

缺 `CALENDAR`、`RECONCILIATION`、`HEALTH`、`SNAPSHOT`、`TRADE`、`ORDER_SNAPSHOT`、`TRADE_SNAPSHOT`；
未知 capability/venue 必须 fail-closed，不能默认 SIMVENUE/CTP。

### 迁移阶段

建议：

```text
A0 身份映射 + SBE 字段 + golden
A1 conformance harness（fake adapter + CTP 录制帧）
A2 descriptor 读模型 + registry 校验
B stream 双订阅 + ORS 迁移
C CTP / SimVenue / Replay adapter（shadow）
D Ports + feature flag + shadow compare
F conformance 全绿
E 最后删除旧分支
```

当前 ADR 把 conformance 放到最后，太晚；Phase B 改 `venue_configs` 的对象也写错了。

## 4. 现有分支清单遗漏

ADR §9 还需补：

```text
SettlementTask（venue_type='CTP'）
ManualOrderPublisher（account 查 ORS、cancel 无 fencing）
ExecutionController/ExecutionMapper（adapterKind 默认 SIM）
AeronOrderMapper/TradingMapper（environment 硬编码 SHADOW）
MarketDataAeronConsumer.staleSynthetic（Replay 历史被丢）
SystemStatusController（单一 SimVenue health）
CtpVenueReconciler 未实现 VenueReconciler 接口
ManualBook/StrategyWizard/OptionChainV2 前端硬编码
TradingController.isSimulatedVenue 空字符串当模拟
```

## 5. ADR 拆分建议

不建议拆成多个 ADR。
建议拆出两份非 ADR 文档：

```text
docs/architecture/venue-contract.md
docs/tasks/T-xxx-venue-migration.md
```

前者放字段表/SBE ID/状态机/conformance case，后者放阶段/rollback/stream 分配表。

## 7. 最终确认

第三次定向确认：上一轮 3 个 P0 中，多 CTP MD、ReplayGrant、SBE 布局均已闭合。
T-060 的 MD 表已同步四行分配，验收 #2 已改为“无 venueType 分支，且无字面量 venueId 分支”。
结论更新为：**APPROVED（设计层）**。

## 8. 审核边界

- 只读评审 ADR-004、doc 19/22、指定代码/SBE/schema/runbook。
- 未修改文件，未执行 SQL/测试。
- 未完整审 CTP session、全部前端、全部 mapper、生产 env。
- 结论基于当前代码与文档证据。

# T-060 统一交易场所接入迁移计划

- 状态：**APPROVED — 迁移计划；实现 PARTIAL（未完成）**
- 日期：2026-11-12
- 状态校准：2026-11-14。`APPROVED` 指计划通过，不指 A0-F/E 已完成。当前实际状态以 T-061 状态表为准：V-A0/V-A1/V-A2/V-C1/V-C2/V-C3/V-D 均为 PARTIAL；运行面 runner 尚未完全迁到 Venue Ports。
- 设计：`docs/architecture/adr/ADR-004-unified-venue-integration.md`
- 规范：`docs/architecture/venue-contract.md`
- 评审：`docs/reviews/2026-11-12-adr-004-venue-review.md`

> 目标：交易核心只依赖 Venue Ports/Registry；CTP、SimVenue、Replay 仍是独立 adapter，
> 通过同一 SBE 契约接入。迁移期间允许双订阅/双读，最终删除所有 CTP/SIMVENUE 分支。

## 1. 身份迁移

### 1.1 唯一映射

```text
venueId = venue_configs.id
accountId = accounts.id
exchange = instruments.exchange
orsId = ors_instances.ors_id
```

约束：

```text
accounts.venue_id = venue_configs.id
orders.venue_id = venue_configs.id
ors_instances.venue_id = venue_configs.id
SimVenue --venue-id = venue_configs.id
SBE counterpartyId = venueId
```

### 1.2 SimVenue 修正

```text
旧:
  --venue-id SIMVENUE-001
  --account  SIMVENUE-001

新:
  venueId   = SIMVENUE
  accountId = SIMVENUE-001
```

更新：

```text
deploy/sim-venue.env
docs/runbooks/sim-venue.md
venue_configs / accounts / orders
```

身份迁移审计范围：

```text
trades
books
strategy_positions
counterparty_exchange
agent_strategy_bindings
position_history
```

不能只改 venue_configs/accounts/orders。

## 2. Stream / ORS 分配

### 2.1 唯一事实源

`ors_instances` 是运行时唯一事实源：

```text
(venueId, accountId) -> orsId
  -> order/cancel/update/trade/md/position channel + stream
```

`VenueDescriptor` 只声明默认值和能力，不能覆盖已注册 ORS 的显式配置。  
任何代码都不得按 `venue_type` 推导 stream，也不得回退到 `1001`、`2100` 等默认值。

启动校验：

```text
account.venue_id == venue_configs.id
ors.venue_id     == account.venue_id
request.venueId  == account.venue_id
ORS 显式配置优先于 descriptor 默认值
未知 venue/ORS/stream -> fail closed
```

### 2.2 190 当前实际配置（2026-11-12，只读核对）

| venueId | accountId | orsId | adapter | MD | order | cancel | update | trade | position | 状态 |
|---|---|---|---:|---:|---:|---:|---:|---:|---|
| SIMNOW | TEST-001 | ors-simnow-test-001 | CTP_CPP | 1100 | 2100 | 2101 | 2102 | 2103 | 2006 | RUNNING |
| SIMSHENGLI | TEST-SHENGLI | ors-shengli-test-shengli | CTP_CPP | 1110 | 2110 | 2111 | 2112 | 2113 | 2013 | HALTED |
| SIMVENUE | SIMVENUE-001 | ors-simvenue-001 | SIM_JAVA | 1001 | 3140 | 3141 | 3142 | 3143 | pos=2014 acct=2018 | RUNNING |

这是当前基线，不是建议值。迁移任务必须先读这张表，再改配置；不能反过来按文档批量重排。

### 2.3 已发现的真实冲突

```text
1. SIMNOW 与 SIMSHENGLI 都写 position_stream=2006 / aeron:ipc
   两个 CTP 同时启动时，position 会交叉归因。
   解决：拆为 2006(SIMNOW) / 2013(SIMSHENGLI)；2007 是 account snapshot，不可占用。
   在拆分完成前，只允许一个 CTP 写 2006。

2. SimVenue 的 MD=1001 是模拟行情；SimNow MD=1100，Shengli MD=1110
   T-059 里“1001 live”只能证明 SimVenue/回放链路，不能证明 CTP 行情。
   IndicatorEngine 必须绑定 (venueId, mdChannel, mdStream)，不能写死 1001。

3. SIMVENUE-RPL=1011 是测试 replay 预留，不是 SimVenue 生产 MD
   不能把 SimVenue 的 md_stream 改成 1011 来“避开”1001。

4. archive-replay 当前引用 2102/2103/2122/2123/3122/3123
   2102/2103 同时是 SimNow 的 update/trade live stream。
   在确认 replay 只读、不发布之前，不得把它当作发布链路；
   任何 replay 发布必须使用 9001-9999。

5. `1001` 可以被多个 reader 订阅，但只能有一个 writer
   共享订阅不等于共享写入；不能靠“都订阅 1001”掩盖 venue 身份。
```

### 2.4 保留区间（只做规划，不等于分配）

```text
1000-1199   MD（实际已有 1100/1110，旧 1000-1099 上限不够）
2001-2005   legacy execution
2006-2099   snapshot（每个 writer 必须唯一）
2100-2999   sim/test execution
3000-3999   prod execution
4000-4999   telemetry/control
9001-9999   replay only
```

槽位布局：

```text
+0 order
+1 cancel
+2 update
+3 trade
+4 health
+5..+9 reserved
```

`SIMVENUE` 的 position 使用独立 2014；3140-3143 位于 3000-3999，但它是 SIM adapter。  
这正好说明：区间只是保留规划，**不能按区间或 venueType 反推 venue 身份**。

### 2.5 必须做的迁移

1. 给 `ors_instances` 增加 `position_channel` / `position_stream`（以及必要的 `writer_role` 校验视图）。
2. 把 SimNow / Shengli 的 position stream 拆开，先在 DB 和 adapter 参数中双写，确认唯一 writer 后再切 consumer。
3. 所有 adapter 启动时上报实际 `(channel, stream)`，与 DB 行比对；不一致拒绝启动。
4. `MarketDataAeronConsumer` / `IndicatorEngine` 从 ORS 读 `(md_channel, md_stream)`，不再写死 1001。
5. `archive-replay` 的发布目标统一改到 9001-9999；确认现有 2102/2103 引用是只读还是发布，未确认前保持关闭。
6. 增加启动校验：

```text
同一 (channel, stream, writerRole) 只能有一个 writer
同一 (channel, stream) 允许多个 reader，但消息必须带 venueId 且 consumer 按 venueId scope
ORS row 与 adapter 启动参数不一致 -> 拒绝启动
```

### 2.6 唯一性校验 SQL（只读诊断）

```sql
-- 执行通道 writer 冲突
SELECT order_channel, order_stream, count(*)
FROM ors_instances
WHERE status IN ('RUNNING', 'STARTING')
GROUP BY 1,2 HAVING count(*) > 1;

-- position writer 冲突（增加 position_stream 后）
SELECT position_channel, position_stream, count(*)
FROM ors_instances
WHERE status IN ('RUNNING', 'STARTING')
GROUP BY 1,2 HAVING count(*) > 1;

-- 账户/venue 不一致
SELECT o.ors_id, o.venue_id, a.venue_id
FROM ors_instances o JOIN accounts a ON a.id = o.account_id
WHERE o.venue_id <> a.venue_id;
```

### 2.7 退出条件

```text
所有 active ORS 的 DB 行 = adapter 实际参数
同一 (channel, stream, writerRole) 无重复 writer
两个 CTP 同时运行不交叉 position
SimVenue/SimNow/Shengli 的 MD 订阅各自正确
replay 发布不落 live stream
交易核心无字面量 1001/2100/3140 分支
```

## 3. 分支迁移清单

| 位置 | 当前 | 目标 |
|---|---|---|
| `ExchangeController` | `CTP/SIM` 分支 | `VenueDescriptor.capabilities/session` |
| `TradingController` | `SIM -> SIMVENUE` | `VenueRegistry` |
| `StrategyRuntimeController` | `SIMVENUE` 特判 | `VenueReconciliationPort` |
| `ReconciliationGateService` | `if SIMVENUE else CTP` | registry 选 reconciler |
| `StrategyOrderService` | `simulatedVenue` | capability + gateway |
| `ManualOrderPublisher` | account 查 ORS、无 venue 校验 | `(venueId,accountId)` 路由 |
| `AeronOrderGateway` | `SIMVENUE` 特判 | canonical port |
| `AeronOrderUpdateConsumer` | 默认推进 `SIM` | envelope.venueId |
| `MarketDataAeronConsumer` | 固定 stream + route 盖 venue | registry 订阅 |
| `SettlementTask` | `venue_type='CTP'` | `SETTLEMENT` capability |
| `ExecutionController` | `adapterKind` 默认 `SIM` | descriptor 必填 |
| `AeronOrderMapper/TradingMapper` | environment 硬编码 `SHADOW` | envelope.environment |
| `SystemStatusController` | 单 SimVenue health | `VenueHealthPort` |
| `CtpVenueReconciler` | 未实现接口 | 统一 `VenueReconciler` |
| `ExchangeController.normalizeType` / `venue_type CHECK` | 只接受 SIM/CTP | 增加 REPLAY |
| `MarketDataAeronConsumer.staleSynthetic` | 隐式丢弃 Replay 历史 | 由 environment/replay 字段决定 |
| `ManualOrderPublisher.connected()` | 全局任一 publication | 目标 venue/ORS 健康 |
| `TradingController.isSimulatedVenue` | 空字符串当模拟 | 显式 venueId，禁止默认 |
| `OptionChainV2/ManualBook/StrategyWizard` | venue 字面量 | registry 驱动 |
| `ReconciliationGateService` | gate 默认值不一致 | 统一配置源 |

## 4. 阶段

### A0 身份 + SBE

- [ ] 身份映射表 + DB 约束（以 190 实际 `venue_configs/accounts/ors_instances` 为输入）
- [ ] 固化当前 ORS inventory（venue/account/ors/channel/stream）
- [ ] SimVenue env 改 `venueId=SIMVENUE`、`accountId=SIMVENUE-001`
- [ ] `ors_instances` 增加 `position_channel` / `position_stream`
- [ ] MarketData/Order/Trade/Account/Position/Session 新字段
- [ ] `MarketDataV2` id=29；`VenueSession` id=28；字段 30-39
- [ ] golden vectors
- [ ] CTP/Java codegen 同步

退出：

```text
同一 envelope 在 CTP/SimVenue/Replay 可编码/解码
```

### A1 Conformance harness

- [ ] fake adapter
- [ ] CTP 录制帧回放
- [ ] V-01..V-12 case
- [ ] 负向正控

### A2 Descriptor/Registry

- [ ] `venue_descriptor` 扩展（或 venue_configs 扩展列）
- [ ] capabilities/enabled/version
- [ ] `(channel,stream,writerRole)` 唯一校验
- [ ] position channel/stream 唯一 writer
- [ ] descriptor 默认值 < ORS 显式覆盖
- [ ] 未知 ORS/channel/stream -> 启动失败

### B Stream/ORS 迁移

- [ ] 读取现有 3 个 ORS 行，不按 venueType 重排
- [ ] position 拆分：SimNow 2006 / Shengli 2013（2007 是 account snapshot）
- [ ] 双订阅旧/新 position stream
- [ ] 迁移 ORS 行并校验 adapter 参数一致性
- [ ] 在途订单/回报处理
- [ ] 切默认 stream（只切 DB/参数，不改代码字面量）

### C1 CTP adapter

- [ ] channel 参数或 `IPC_ONLY`
- [ ] sourceSessionId/publicationEpoch/seq
- [ ] orderSysId -> exchangeOrderId
- [ ] cancel fencing/orderEpoch
- [ ] account/position venue/environment

### C2 SimVenue adapter

- [ ] 相同 envelope
- [ ] 保持 ORS 配置：生产 MD 1001；测试 replay 1011 仅用于测试
- [ ] order/cancel/update/trade 3140-3143（保持当前 ORS）
- [ ] venueId=SIMVENUE、accountId=SIMVENUE-001
- [ ] virtual clock/seed 测试模式
- [ ] calendar capability

### C3 Replay adapter

- [ ] replayEpoch/session/recording/frame position
- [ ] 9001-9999 独占
- [ ] 不写 live 1001/1100/1110
- [ ] archive-replay 现有 2102/2103/2122/2123/3122/3123 引用改为只读或 9xxx

### D Ports

- [ ] VenueRegistryPort
- [ ] VenueMarketDataPort
- [ ] VenueExecutionPort（异步 Submission）
- [ ] VenueAccountPort（Snapshot）
- [ ] VenueHealthPort
- [ ] feature flag + shadow compare

### F Conformance

- [ ] CTP 录制帧
- [ ] SimVenue
- [ ] Replay
- [ ] 只按 capability skip

### E 删除旧分支

- [ ] 交易核心无 `CTP`/`SIMVENUE` 字面量
- [ ] 旧 controller/reconciler 删除
- [ ] 旧 stream 默认删除
- [ ] ArchUnit/grep gate

## 5. Rollback

每阶段必须有：

```text
feature flag
旧路径可切回
双读/双订阅
回滚触发条件
在途订单处理
```

回滚触发阈值（初始值，实施时确认）：

```text
conformance case 失败 >= 1
shadow compare 差异 >= 1 笔
订单/回报关联失败 >= 1
pending order 超过 30s
adapter heartbeat 丢失 > 5s
```

每阶段必须有明确 owner 和回滚负责人。

重点：

```text
stream 切换：先双订阅，再切写，再删旧
adapter 切换：shadow compare，不一致告警
identity 切换：DB 映射先加列，不删旧字段
```

## 6. 验收

```text
1. 同一策略代码/配置，新建 deployment 指向新 venueId/account/ORS
2. 交易核心无 `venueType` 分支，且无字面量 `venueId` 分支
3. 行情 seq 严格递增；gap 告警
4. 旧 session/epoch/fencing 拒绝，0 值规则明确
5. 同一 (channel,stream) 两 venue 不交叉归因
6. 两个 CTP 同时运行时 position 不交叉
7. conformance suite 三 adapter 通过
8. 新 venueId UI 不依赖字面量
9. 交易核心无字面量 1001/2100/3140 分支
10. rollback 演练通过
```

## 7. 风险

```text
SBE 版本兼容
stream 在途订单
identity 迁移
descriptor/ORS 双源
environment 失真
cancel fencing
replay 9xxx 冲突
```

每项必须有对应测试和回滚步骤。

# T-059 指标生产实现计划

- 状态：**DRAFT — 测试评审 CHANGES REQUIRED**
- 日期：2026-11-12
- 设计依据：
  - `docs/architecture/adr/ADR-001-indicator-replay-contract.md`（APPROVED）
  - `docs/architecture/adr/ADR-002-indicator-p1-closure.md`（APPROVED）
  - `docs/architecture/adr/ADR-003-indicator-runtime-residual-p1.md`（APPROVED）
  - `tools/db/schema-indicator-v2.sql`
- 验收测试矩阵：`docs/testing/T-059-indicator-production-acceptance.md`
- 测试评审：`docs/reviews/2026-11-12-t059-test-review.md`（APPROVED WITH CHANGES）
- 现状：POC 和协议已完成；生产 Java、schema 实库、UI、运维尚未开始。

> 本计划不包含 V1 兼容迁移。调试阶段允许破坏性 reset；旧 `indicator_defs` / `indicator_values`
> / `indicator_daily_history` 不再作为生产路径。

## 1. 目标

```text
每个 counterparty 一个 ACTIVE IndicatorEngine
指标共享、无策略私有指标
运行期 engine 不读指标 DB
catalog/lease/ACK/outbox 可恢复
1001 live + Archive replay 可切换
snapshot/applyCut 可恢复
ValueKV -> 策略 gate 可信任
```

## 2. 非目标

```text
不做 V1 数据迁移/兼容
不做 C++ 指标引擎
不做策略私有指标
不做指标依赖指标
不做跨柜台 pair
不在本计划内做交易策略改造
不在本计划内做交易盈亏模型改造
```

## 3. 现状盘点

### 已有

```text
ADR-001/002/003 协议
schema-indicator-v2.sql（debug/shadow 验证过）
indicator-engine POC（EMA/Archive/replay/journal/lease/fencing）
190 真实 Archive recording 1021 golden
旧 control-plane/runtime-runner 指标链路（V1 表）
```

### 必须替换/删除

```text
backend/control-plane/src/main/resources/mapper/IndicatorMapper.xml
backend/control-plane/src/main/java/com/quantlink/fin/control/mapper/IndicatorMapper.java
backend/runtime-runner/src/main/java/com/quantlink/fin/runner/db/IndicatorDefMapper.java
backend/runtime-runner/src/main/java/com/quantlink/fin/runner/IndicatorPublisher.java
backend/control-plane/src/main/java/com/quantlink/fin/control/aeron/IndicatorStreamConsumer.java
StrategyIndicatorOwnership / StrategyIndicatorRemap 的旧私有归属逻辑
migrate-t056-indicator-ownership.sql
```

先用兼容适配层可以，但必须在 Phase 6 前删除旧表读写。

## 4. 阶段与依赖

```text
Phase 0 冻结/基线
  -> Phase 1 schema shadow
  -> Phase 2 control-plane catalog/lease/ACK
  -> Phase 3 engine runtime
  -> Phase 4 value/strategy read path
  -> Phase 5 legacy removal
  -> Phase 6 operations
  -> Phase 7 acceptance/rollout
```

Phase 2 和 Phase 3 可并行，但 Phase 4 依赖前两者。

## 5. Phase 0：冻结与基线

- [ ] 冻结 ADR-001/002/003 为实施基线
- [ ] 建生产分支 `feature/indicator-v2`
- [ ] 确认 190 上 Archive 1001 recording 链和 retention 状态
- [ ] 固定测试 fixture：
  - recording 1021
  - au2612 1m EMA(13)
  - 两个 instrument 同 session/seq
  - 空 recording / gap / active recording
- [ ] 建立 operator manifest 生成脚本（codeHash/schemaHash）
- [ ] 生成 `indicator_operator` 初始 manifest

验收：

```text
同一 spec 在 builder/engine 得到同一 indicatorId
manifest 可重复生成同一 codeHash
```

## 6. Phase 1：schema 应用到 shadow

需要用户确认 shadow DB 连接和破坏性 reset。

- [ ] 备份/确认 shadow 库
- [ ] 执行 `tools/db/schema-indicator-v2.sql`
- [ ] 执行 `tools/db/indicator-history-partitions.sql`
- [ ] 验证：
  - `indicator_operator` 非空 hash
  - `indicator_catalog_outbox` 一行一 delta
  - `indicator_catalog_ack` REJECTED 两态 + status_rank trigger
  - `indicator_latest` PRODUCER_LOST/source/status_rank
  - `indicator_archive_gap/ref`
  - `indicator_engine` replay_stream/epoch/session
  - history 月分区
- [ ] 生成 schema smoke SQL + CI test
- [ ] 清理旧 indicator 表和旧迁移

验收：

```text
schema 在空 shadow 库可重复 reset
所有约束/trigger 有正向和反向测试
```

## 7. Phase 2：control-plane catalog / lease / ACK

### 2.1 Catalog API

- [ ] `POST /api/v1/indicators`：canonical spec -> indicatorId
- [ ] `PATCH /api/v1/indicators/{id}`：只改 displayName
- [ ] `DELETE /api/v1/indicators/{id}`：软删除 + binding 检查
- [ ] `POST /disable` / `POST /enable`
- [ ] `GET /catalog/{counterparty}`：snapshot
- [ ] `GET /catalog/{counterparty}/delta?fromVersion=`

### 2.2 Outbox/ACK

- [ ] 一个 `(counterparty, catalog_version)` 一行 outbox
- [ ] `payload_jcs` 和 `payload_sha256` 由 canonical builder 生成
- [ ] ACK `(engine_id, request_id)` 幂等
- [ ] ACK `REJECTED_RETRYABLE` 重试同一 requestId
- [ ] ACK `REJECTED_FINAL` 终态
- [ ] ACK target 不可变 trigger 测试
- [ ] PUBLISHED 超时回到 PENDING

### 2.3 Lease/fencing

- [ ] acquire/renew/release 内部 API
- [ ] tokenEpoch 高水位文件 + DB 事务
- [ ] catalogEpoch 变化/PITR bump
- [ ] 全量 lease fence
- [ ] engine replay stream/epoch/session 分配
- [ ] PRODUCER_LOST control 写入

验收：

```text
两个 engine 不能同时 ACTIVE
旧 tokenEpoch 不能 renew/publish
catalogEpoch 变化后旧 lease FENCED
ACK 重放无重复应用
```

## 8. Phase 3：IndicatorEngine runtime

### 3.1 Catalog/plan

- [ ] snapshot/delta 应用
- [ ] APPlied -> RouteIndex(routable=false) -> ACK APPLIED
- [ ] READY 条件 `warmup 完成 + routable + first OK`
- [ ] 删除/禁用移除 RouteIndex + tombstone
- [ ] planVersion + 旧 plan refcount

### 3.2 journal/WAL

- [ ] 生产 journal（R1）：
  - 分段追加
  - CRC32C
  - PREPARED/APPLIED
  - checkpoint durable/replay offset
  - 崩溃恢复
- [ ] cutId per delta/batch
- [ ] per-input cursor

### 3.3 live/replay

- [ ] 1001 live 订阅 + buffer
- [ ] 9001 per-engine replay grant
- [ ] `(engineId, replayEpoch, replaySessionId)` 过滤
- [ ] applyCut 屏障
- [ ] gap/WARMUP
- [ ] replay 完成校验

### 3.4 state/value

- [ ] 1m bar builder + EMA
- [ ] snapshot（含 partial bar）
- [ ] ValueKV
- [ ] VALUE_DELTA publisher
- [ ] VALUE_ENGINE_STATE heartbeat
- [ ] run 期间不读 DB

### 3.5 热加载

- [ ] 新增指标
- [ ] 删除/禁用
- [ ] 参数变更生成新 indicatorId
- [ ] 旧 plan drain 前新 apply REJECTED_RETRYABLE

验收：

```text
D1 golden 重复通过
pre-cut tick 不重复
publisher restart seq=1 不丢
kill -9 后从 journal 续跑
```

## 9. Phase 4：Value/策略读取

- [ ] control-plane VALUE consumer
- [ ] `indicator_latest` guard
- [ ] history + dedupe 事务
- [ ] 策略 ValueKV 副本
- [ ] gate：
  - engine ACTIVE
  - lease active
  - tokenEpoch/fencingToken 匹配
  - status OK + fresh
- [ ] REPLAYING/FENCED/LOST 禁止新开仓
- [ ] 平仓不受 gate 限制

验收：

```text
策略读不到 DB 也能交易
PRODUCER_LOST 后 1 个 heartbeat 内 gate 关闭
旧 tokenEpoch 值不能恢复 OK
```

## 10. Phase 5：旧链路删除

- [ ] 删除 `IndicatorMapper` 旧表 SQL
- [ ] 删除 `IndicatorDefMapper`
- [ ] 删除 `IndicatorPublisher` 旧路径
- [ ] 删除 `IndicatorStreamConsumer` 旧表写入
- [ ] 删除 `StrategyIndicatorOwnership` 旧私有归属
- [ ] 删除 `migrate-t056-indicator-ownership.sql`
- [ ] 删除前端旧指标编辑/值读取路径
- [ ] `rg indicator_defs|indicator_values|indicator_daily_history` 为 0

验收：

```text
全仓无旧指标表读写
旧表可以从 shadow 删除
```

## 11. Phase 6：运维/UI

- [ ] 指标目录页：创建/编辑/禁用/删除
- [ ] 指标详情：codeHash/operatorVersion/status/warmup/producer
- [ ] engine 状态页：lease/tokenEpoch/fencing/replayEpoch
- [ ] ACK 状态页：APPLIED/READY/REJECTED
- [ ] Archive roll timer
- [ ] `indicator_archive_ref` 导出 -> `--protected-file`
- [ ] HWM 文件/leader 检查
- [ ] 告警：active recording age、replay gap、persist lag、codeHash mismatch

## 12. Phase 7：验收

### 功能

```text
1. 新建 EMA 1m 指标，10s 内 READY
2. 两个策略共享同一 indicator
3. 修改 displayName 不改 indicatorId
4. 修改 period 生成新 indicatorId
5. 删除有 binding 返回 409
6. 禁用后 RouteIndex 移除，策略不能新开仓
```

### 恢复

```text
1. kill -9 后 journal 续跑
2. snapshot + replay 无重复
3. Archive gap -> WARMUP
4. publisher restart epoch/seq
5. PITR -> tokenEpoch bump
6. 两个 engine 不共用 replay stream
```

### 性能

```text
1. 20k 指标 catalog 加载
2. tick 稳态无 DB/日志/大对象分配
3. value publisher 队列满不阻塞 tick
4. 1m bar close 批量发布
5. history 月分区跨月
```

### 安全

```text
1. 旧 tokenEpoch 写入被拒
2. 旧 replay session 被拒
3. 未注册 operator codeHash 被拒
4. 控制面 PRODUCER_LOST 不被 seq guard 拒绝
```

## 13. 交付顺序（建议）

```text
Sprint 1  Phase 0 + 1
Sprint 2  Phase 2 catalog/outbox/ACK
Sprint 3  Phase 2 lease + Phase 3 catalog/plan
Sprint 4  Phase 3 journal/live/replay
Sprint 5  Phase 3 value + Phase 4 gate
Sprint 6  Phase 5 legacy removal
Sprint 7  Phase 6 UI/ops
Sprint 8  Phase 7 acceptance
```

每个 Sprint 结束必须：

```text
单元测试 + shadow 集成测试 + 更新本计划 + 不保留旧路径双写
```

## 14. 风险

| 风险 | 处理 |
|---|---|
| schema reset 破坏 shadow | 先备份；只允许 `_shadow` |
| 旧代码仍写 V1 表 | Phase 5 前禁止双写；grep 验收 |
| 真实 Archive 数据不足 | 1021 golden + 合成 fixture |
| tokenEpoch PITR | HWM 文件 + restore_generation |
| 多 engine 共用 9001 | per-engine grant + partial unique |
| 队列满丢最新值 | generation/CAS + latest 追平 |
| 旧 producer 复活 | tokenEpoch/fencing + PRODUCER_LOST guard |
| operator hash 不一致 | manifest 单一来源 + REJECTED_FINAL |
| history 分区 default 卡住 | ensure 前置 + runbook |

## 15. 退出条件

```text
Phase 0-7 全部验收
旧指标表/旧代码为 0
shadow 连续运行 24h 无 WARMUP 泄漏
真实 Archive replay 通过
两个 engine 隔离通过
PITR/lease 测试通过
策略 gate 真实阻断通过
```

## 16. 第一批可执行任务

```text
T-059-01 生成 operator manifest
T-059-02 shadow schema reset + smoke
T-059-03 catalog canonical/outbox API
T-059-04 lease/tokenEpoch/HWM
T-059-05 ACK 状态机
T-059-06 engine plan/RouteIndex
T-059-07 生产 journal
T-059-08 live/replay barrier
T-059-09 value publisher
T-059-10 策略 gate
```

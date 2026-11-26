# ADR-003 最终定向复审

- 日期：2026-11-12
- 对象：`docs/architecture/adr/ADR-003-indicator-runtime-residual-p1.md`
- 范围：v6 §4 剩余 5 个运行时 P1
- 结论：**APPROVED**
- 生产状态：5 个 P1 协议已关闭；生产 Java 实现/压测/HA 仍另开计划

## 1. 结果

```text
R1 applyCut journal              CLOSED
R2 tick 重路由/pre-cut 重复      CLOSED
R3 VALUE 发布线程                CLOSED
R4 9001 per-engine 分配          CLOSED
R5 catalogEpoch -> tokenEpoch    CLOSED
```

## 2. 两轮修复的关键点

### R1

- journal 改为分段追加式二进制日志 + CRC32C。
- `PREPARED` 先 fsync；state snapshot durable 后写 `APPLIED`。
- checkpoint 只推进到 `APPLIED/ABORTED`，使用 `durableOffset/replayStartOffset`。
- APPLIED 但 State 缺失时强制重建；损坏 checkpoint 从最早 segment 扫描。
- payload 增加 `cutId/planVersion/inputs[]`，与 ADR-001 的 StreamCut/InputCursor 对齐。

### R2

- tick 携带 `planVersion`，旧 plan 保留到工作队列 **和 live buffer** drain。
- 最多 2 个在途 plan；旧 plan 未 drain 时新 apply 返回 REJECTED_RETRYABLE。
- 去重键包含 `sourceSessionId/sourcePublicationEpoch/inputKey/seq`。
- 新 input 不在 cut 中时从 replay 起点初始化，不沿用其他 input 的 seq。
- gap 不 apply，WARMUP 后 replay/rebuffer。

### R3

- engine 只发 Aeron `VALUE_DELTA`；control-plane 负责 `indicator_latest/history`。
- engine dirty 在 Aeron 发布成功后清；DB 侧用 `(engineId, valueSeq/streamSeq)` 幂等。
- `persistLagMs` 从 engine 状态移出，由 control-plane `VALUE_PERSIST_STATE` 发布。
- 策略 gate 读 Aeron ValueKV，不读 DB。

### R4

- 每 engine 唯一 `replay_stream_id` + `replay_epoch` + `replay_session_id`。
- `ReplayGrant` 固化 stream/channel/epoch/session/recording/from/to。
- engine 过滤 `(engineId, replayEpoch, replaySessionId)`。
- slot 生命周期 `ALLOCATED -> ACTIVE -> DRAINING -> RECLAIMABLE`。
- partial unique index 允许 RECLAIMABLE 后复用，旧 epoch 永远拒绝。

### R5

- `tokenEpoch` 高水位在 DB 外文件中，先写文件再写 DB。
- `restore_generation` 外部 marker 让 PITR 到同 catalogEpoch 也能触发 bump。
- bump + `setval` + 全量 lease fence + catalog marker 同一事务。
- 失败进入 maintenance，主动 FENCED/VALUE_INVALIDATE。
- HWM 只允许 control-plane leader 写。

## 3. 验证

```text
schema-indicator-v2.sql 在临时 _shadow 库执行成功
indicator_engine replay_stream_id/replay_epoch/replay_state 约束
同 stream ACTIVE 重复插入被拒绝
RECLAIMABLE 后同 stream 新 epoch 可复用
indicator_catalog_state.token_epoch_bumped_for/restore_generation 可写入
```

## 4. 边界

- 本评审只覆盖运行时协议和 debug/shadow schema。
- 不认证生产 Java 实现、性能/吞吐、Aeron Archive 内部、DB 迁移顺序、HA/PITR 运维。
- POC `FileApplyCutJournal` 明确不是生产实现。

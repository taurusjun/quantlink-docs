# 27 号指标目录文档第五轮独立架构复审

- 日期：2026-11-12
- 审查基线：`1d55905`（doc 27 + `schema-indicator-v2.sql`）
- 前序：`docs/reviews/2026-11-12-indicator-catalog-architecture-review-v4.md` 及 v1/v2/v3
- 结论：**REJECT（作为 V1 实施基线）；方向 APPROVE**

## 1. 总体判断

本轮有实质进展，但仍有两个 P0 没有形成可执行不变量：

```text
P0-01 applyWatermark 捕获时机 / 区间语义 / 持久化 / 1d 语义
P0-02 1001 全局 streamCut / session 级 seq / position 语义
```

不是文档长度问题，而是安全属性仍未证明。

## 2. 已关闭项

- producer liveness / order gate
- 期权链 selector-only key、resolvedContracts 不进 key
- tokenEpoch 字段/sequence/reset 递增/guard 文字
- ACK 唯一键与 outbox 版本唯一
- chain snapshot/binding 关联
- snapshot/history 算术预算
- 软删除 retention 不删 binding
- engine 注册/新柜台初始化（设计层）
- canonical bytes/JCS
- timer 只入队、producer 执行
- subscriptionRef/routeRef
- 期权链 fanout
- IV Rank series
- displayKey 短 hash
- API/安全
- 容量组合约束
- doc 24 控制面指标边界

## 3. 仍 OPEN 的 P0

### P0-01 applyWatermark 不可执行

问题：

1. `applyWatermark` 同时被写成 snapshot 字段和 apply 时直播水位。周期 snapshot 不可能知道未来 apply 值。
2. 恢复流程先按 `snapshot.watermark` 恢复，又回放 `[warmupTo, applyWatermark]`，会重复回放 `[warmupTo, watermark]`。
3. 接收线程记录 applyWatermark，producer 稍后 apply；队列延迟区间没有回放。
4. applyWatermark 不持久化；producer 在 replay 中崩溃后不知道进度。
5. 没有覆盖判定：recording 是否覆盖、position 是否连续、seq 是否缺口、maxRecoveryGap 是否超限。
6. 1d 指标没有交易日语义；09:30 apply 会回放未完成日。

正确语义：

```text
ApplyAdd 由 producer 在安全点捕获 applyCut：
  recordingId
  sessionId
  position
  nextPosition
  eventAsOf

snapshot 路径：replay (snapshot.watermark, applyCut]
warmup 新指标：replay (artifact.to, applyCut]

1d：applyCut.eventAsOf = 最后一个已收盘交易日
```

applyCut 必须持久化到 LKG/journal；replay 中崩溃后继续。

### P0-02 1001 全局 cursor 不足

问题：

- 1001 契约有 `seq` 文字，但 seq 作用域矛盾：消息级一个 seq，还是 per-field seq。
- 没有全局 `streamPosition/recordingId + nextPosition`。
- `archiveRefs` 是 per-input position，pair/chain 分别回放会打乱交错顺序。
- position 是 inclusive 还是 exclusive 未定义。
- 去重只用 `lastInputSeq`，没有 `(sessionId, seq)`；CTP 重连 seq 归零会丢新 tick。
- 9001 replay envelope 没有 replaySessionId/recordingId/position，多个 replay 无法区分。
- 新 tick/1s 指标没有初始 replay 起点。

正确契约：

```text
StateSnapshot:
  streamCut:
    recordingId
    sessionId
    position       # 最后一条已处理（inclusive）
    nextPosition   # 下一条待处理（exclusive）
    eventAsOf
  archiveRefs[]:
    inputKey
    sessionId
    lastInputSeq
    lastPosition
    eventAsOf

ReplayEnvelope:
  replaySessionId
  recordingId
  position
  sourceSessionId
  payload
```

replay 从 `streamCut.nextPosition` 开始，按流顺序过滤，去重键 `(sourceSessionId, seq)`。

## 4. 主要 P1

| 编号 | 问题 | 建议 |
|---|---|---|
| P1-02 | Archive roll/live handoff 只有要求 | 独立 roll service；overlap 或受控 gap；recording chain 表；active age 告警 |
| P1-03 | 新 tick/1s 初始 replay 起点不完整 | initialReplayFrom/lookback 单位/锚点；不足原因映射状态 |
| P1-04 | tokenEpoch 跨 PITR 无权威 | DB 外序列或显式 bump runbook；恢复后重新 acquire |
| P1-05 | ACK requestId 与 status 矛盾 | requestId 不含 status，UPSERT + 单调状态 |
| P1-06 | chain binding 无当前唯一约束 | partial unique `(indicator_id) WHERE effective_to IS NULL` |
| P1-07 | history event_as_of NOT NULL | 回退 published_at；月分区模板 |
| P1-08 | latest guard 未落 SQL | 条件 UPDATE/trigger + catalog_epoch |
| P1-09 | T-058 正文仍是旧模型 | 重写/归档，不只加横幅 |
| P1-10 | operator codeHash 未进 catalog | catalog operators 加 codeHash；seed 真实 hash |
| P1-11 | 9001 多路复用/handoff barrier | 每 engine 独立 stream 或 envelope；先订阅 live 记 cut |
| P1-12 | retention check-then-delete 竞态 | 单事务 + FOR UPDATE + 重查 binding |
| P1-13 | outbox 版本并发 | `UPDATE ... RETURNING` 原子分配 |
| P1-14 | warmup artifact PK 不完整 | 加 timeframe/key_schema_version/status |
| P1-15 | history 分区只有 default | 月分区模板 + 维护 job |
| P2 | indicator_id 字母表、catalogEpoch 到 value、ACK CHECK、chain snapshot 唯一、reset guard、search_path 等 | 逐项清理 |

## 5. Archive 专项

- ArchiveRecorder 默认录 1001：成立，但只录 `aeron:ipc`。
- 启动/publisher 变化强制 re-arm，有 100ms gap。
- startRecording 失败不重试。
- ArchiveReplayTool 可按 recording/position 重放。
- 当前 replay service 不含 1001。
- `--latest-for-stream` 会写回原 stream；工具未拦截 1001。
- active 1001 recording 不会被 retention 清理。
- 1001 缺全局 cursor/session seq，无法可靠恢复。
- 新 tick/1s 指标没有 snapshot，初始 replay 起点未定义。
- replay 期间 gate 未检查 `REPLAYING`；lease renew 可能被 producer/replay 阻塞。

## 6. 仍缺决策

| # | 决策 | 建议 |
|---|---|---|
| D1 | applyCut 捕获者/时机/持久化 | producer 安全点；LKG/journal |
| D2 | seq 作用域 | 消息级 per instrument 或 per stream；去重 `(sessionId,seq)` |
| D3 | position 语义 | 明确 inclusive/exclusive；snapshot 存 nextPosition |
| D4 | Archive roll owner/gap 策略 | 独立 roll service；重叠 recording 或受控 gap + WARMUP |
| D5 | tokenEpoch PITR | DB 外权威/显式 bump |
| D6 | ACK requestId/status | 一个 requestId，UPSERT + 单调状态 |
| D7 | REPLAYING gate | engine status 纳入 order gate；lease 独立线程 |
| D8 | chain roll 原子性 | 单事务 close+insert + partial unique |
| D9 | 1d watermark | 最后已收盘交易日 |
| D10 | history 无事件时间 | 回退 published_at；分区/去重 |
| D11 | T-058 处置 | 重写/归档 |
| D12 | operator codeHash | catalog + seed |

## 7. 建议测试

- T-A：接收线程记录 cut，producer 延迟 apply；必须回放到实际 apply。
- T-B：snapshot watermark=10:00、warmupTo=08:55，10:05 恢复；只回放 `(10:00,10:05]`。
- T-C：pair 两 leg position 不同；按全局 streamCut 回放。
- T-D：CTP 重连 seq 归零；按 `(sessionId,seq)` 接受新 session。
- T-E：收盘 roll；无 gap 或明确 WARMUP。
- T-F：active 1001 >24h/roll 失败；告警且不静默 OK。
- T-G：replay > lease TTL；heartbeat 独立，不因 replay 自 fence。
- T-H：9001 replay 与 1001 live 同时到达；barrier 后无重复/丢失。
- T-I：APPLIED→READY；UPSERT 状态不回退。
- T-J：PITR 旧 producer tokenEpoch 更高；新值可写、旧值被拒。
- T-K：并发 CREATE 同 counterparty；版本唯一。
- T-L：retention 与并发 binding；无半删除。
- T-M：1d 09:30 apply；使用最后收盘交易日。
- T-N：PRODUCER_LOST/DISABLED 无 eventAsOf 写 history。
- T-O：operator seed 空 hash；拒绝。
- T-P：chain roll 并发；唯一当前 binding。
- T-Q：latest 乱序/epoch 变化；不回退。
- T-R：`--latest-for-stream 1001`；工具拒绝。

## 8. 最终意见

```text
结论：REJECT（作为 V1 实施基线）
方向：APPROVE
```

修完 P0-01/P0-02 可转 `APPROVE WITH CHANGES`；  
再修 P1-02/03/04/05/06/07/08 可转 `APPROVE`。

本次审查只读，未修改文件、未执行 SQL。

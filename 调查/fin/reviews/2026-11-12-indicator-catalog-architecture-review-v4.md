# 27 号指标目录文档第四轮独立架构复审

- 日期：2026-11-12
- 审查基线：`799569a`（doc 27 + `schema-indicator-v2.sql`）
- 前序评审：
  - `docs/reviews/2026-11-12-indicator-catalog-architecture-review.md`
  - `docs/reviews/2026-11-12-indicator-catalog-architecture-review-v2.md`
  - `docs/reviews/2026-11-12-indicator-catalog-architecture-review-v3.md`
- 结论：**REJECT（方向 APPROVE）**

## 1. 总体结论

```text
P0-A producer liveness / order gate        CLOSED
P0-C option-chain identity                 CLOSED（核心）
P0-B warmup/apply 连续性                   仍 OPEN
```

第四轮新增/保留两个 P0：

```text
P0-01 warmup artifact.to -> apply 时刻的缺口没有强制回放
P0-02 1001 没有 per-input seq / counterparty / exchange / 全局 cursor
```

P0-B 不是细节缺失，而是安全属性未证明：EMA/bar/IV 指标可能在缺数据时进入 OK。

## 2. 已关闭项

- producer liveness / order gate
- 期权链 selector-only key、resolvedContracts 不进 key
- timer 线程：只入队，producer 执行
- subscriptionRef / routeRef 拆分
- 期权链 fanout coalescing
- IV Rank series
- displayKey 短 hash
- operator schema 权威
- API/安全
- 容量组合约束
- doc 24 控制面指标边界

## 3. 仍 OPEN / PARTIAL

### P0-01 warmup/apply 连续性

证据：

- `warmupRef` 只有 bars，`to` 是生成时固定时间。
- `stateSnapshot` 有 `warmupTo`，但没有 `applyWatermark`。
- 新指标仍写 `warmupRef -> WARMUP -> OK`，没有强制回放 `[artifact.to, applyWatermark]`。

影响：

```text
08:55 生成 warmup
09:30 apply
EMA 回放到 08:55
第一笔 09:30 tick 后直接 OK
08:55-09:30 的 35 根 1m bar 缺失
```

建议：

1. `PreparedSpec` 增加 `warmupTo`。
2. `ApplyAdd` 增加 `applyWatermark`。
3. 强制回放 `[artifact.to, applyWatermark]` 后才能 OK。
4. 不能回放 -> WARMUP，并记录缺口区间。
5. 1d 指标使用交易日语义。
6. 增加延迟 apply 测试。

### P0-02 1001 seq / cursor 不足

证据：

- `MarketDataMessage` 只有 instrument/timestamp/price/volume/openInterest/depth/synthetic。
- 没有 `seq`、`counterpartyId`、`exchange`。
- `stateSnapshot.archiveRefs` 是每个 input 一条 position。
- 文档依赖 `lastInputSeq` 去重和连续性检查，但该 seq 不存在。

影响：

- 无法判断 replay 与 live 是否连续。
- pair/option chain 多输入分别按 position 回放，会打乱输入交错顺序。
- 1001 是全市场流，无法只靠 instrument 区分柜台。
- `position` 是 inclusive/exclusive 未定义。

建议：

1. 1001 消息增加 `counterpartyId/exchange/seq`。
2. `stateSnapshot` 增加全局 `streamPosition` / `recordingId + nextPosition`。
3. 每个 input 保留 `lastProcessedSeq`。
4. 回放从全局 position 开始，按流顺序过滤；用 `(sessionId, seq)` 去重。
5. 明确 position 语义。
6. 增加 pair/chain 多输入回放 golden test。

## 4. 主要 P1

| 编号 | 问题 | 建议 |
|---|---|---|
| P1-02 | Archive recording roll/live handoff/active retention 未闭合 | 1001 定时 roll；recording 链；live barrier；禁止写回 live 1001 |
| P1-03 | 新 tick/1s 指标没有初始 warmup 起点 | `lookback/initialReplayFrom/maxReplaySpan`；不足保持 WARMUP |
| P1-04 | tokenEpoch guard/reset 递增不一致 | 独立 sequence；reset 显式递增；guard 按 `(token_epoch, fencing_token, seq)` |
| P1-05 | ACK 幂等键与 SQL 冲突 | 文档统一 `(engine_id, request_id)`；outbox 版本唯一 |
| P1-06 | chain snapshot 与 indicator 无关联 | `indicator_chain_binding` 或 `indicator.chain_snapshot_id`；selector DECIMAL 规范化 |
| P1-07 | snapshot/history I/O 算术不成立 | 20k/30s=667/s；按 key 分片/轮转；给 bytes/fsync 预算 |
| P1-08 | 软删除 retention 不应删除 binding | 有 binding 跳过并告警；retention 只处理无引用 |
| P1-09 | T-058 正文仍是旧模型 | 重写/归档；只保留 OPT 算子细节 |
| P1-10 | codeHash 未进 catalog/seed 空 hash | operator 列表加 codeHash；seed 从 Registry 生成 |
| P1-11 | history 分区未落地；event_as_of NOT NULL | 分区 DDL；无事件状态回退 published_at |
| P1-12 | engine 重新注册/新柜台初始化 | register upsert；新柜台初始化 lease/catalog；区分 LEASE_NOT_INITIALIZED |
| P2 | lease DDL 漏 token_epoch、VALUE_ENGINE_STATE 两处定义、archiveRefs 措辞、indicator_id 字母表、ACK CHECK、warmup PK、history seq=0 等 | 文档/SQL 清理 |

## 5. Archive 专项结论

- `ArchiveRecorder` 默认录 1001：成立。
- 只录 `aeron:ipc`；CTP/Adapter 若非 IPC 则不录。
- 启动/publisher 变化强制 re-arm，有 gap 窗口。
- startRecording 失败不重试。
- `ArchiveReplayTool` 可按 recording/position 重放。
- 当前 archive-replay.service 不包含 1001。
- `--latest-for-stream` 会重放到原 stream，禁止对 1001 使用。
- active 1001 recording 不会被 retention 清理，30 天保留对 1001 不成立。
- 1001 全市场流缺少 seq/counterparty/exchange，不能可靠恢复。
- 新 tick/1s 指标没有 snapshot，也就没有 archiveRef，初始 warmup 起点未定义。

## 6. 仍缺失决策

| # | 决策 | 建议 |
|---|---|---|
| D1 | 1001 消息 seq/cursor 契约 | 增加 seq + counterparty + exchange，或明确 Aeron position 为唯一 cursor |
| D2 | 新 tick/1s 初始 warmup | lookback/replayFrom/maxReplaySpan |
| D3 | Archive recording roll/live handoff | 定时 roll；recording 链；live barrier |
| D4 | engine liveness 消息 | 独立 stream；ACTIVE/REPLAYING/FENCED/LOST；阈值绑定 lease TTL |
| D5 | token_epoch 权威 | 独立 sequence；reset/PITR 递增；字典序 guard |
| D6 | chain snapshot 关联 | binding 表或 indicator 列；selector DECIMAL |
| D7 | ACK/outbox 版本 | 固定 request_id；唯一版本 |
| D8 | retention/binding | 有 binding 永不清 |
| D9 | history 分区/无事件状态 | 分区 DDL；eventAsOf 回退 |
| D10 | T-058 处置 | 重写/归档旧模型 |
| D11 | engine 注册/新柜台 | upsert + 初始化 |
| D12 | snapshot 持久性 | 本地丢失后的恢复起点 |

## 7. 建议测试

- warmup 延迟 apply 缺口
- 新 tick/1s 只有 1 小时 Archive、lookback 4 小时
- 1001 seq 重复/乱序/缺口/跨 session
- pair 两 input position 不同
- recorder 重启/re-arm/active roll
- engine kill 后 1d OK 值 gate
- VALUE_ENGINE_STATE 丢失/策略重启
- PITR/reset 旧 producer tokenEpoch=0/fencing=1000
- latest/history 重复/乱序/PITR
- ACK 重试 APPLIED/READY/snapshot
- chain roll 同 indicatorId
- 20k 指标 snapshot/history 预算
- 软删除有 binding/retention
- 新柜台无 lease 行/新 engine_id
- operator codeHash/schemaHash 不匹配

## 8. 最终意见

```text
结论：REJECT（作为 V1 实施基线）
方向：APPROVE
```

修完 P0-01/P0-02 可转 `APPROVE WITH CHANGES`；  
再修 P1-02/03/04/05/06 可转 `APPROVE`。

本次审查只读，未修改文件、未执行 SQL。

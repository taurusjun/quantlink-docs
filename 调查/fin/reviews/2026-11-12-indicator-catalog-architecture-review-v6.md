# 27 号指标目录文档第六轮独立架构复审

- 日期：2026-11-12
- 审查基线：`3af6812`（doc 27 + `schema-indicator-v2.sql`）
- 前序：`docs/reviews/2026-11-12-indicator-catalog-architecture-review-v5.md`
- 结论：**REJECT（作为 V1 实施基线）；方向 APPROVE**

## 1. 总体判断

本轮有实质进展：

- `ApplyCut` 从 snapshot 中拆出
- `streamCut` 有 position/nextPosition
- 1001 增加 sessionId/seq
- 9001 增加 ReplayEnvelope
- chain binding 增加当前唯一约束
- SQL 临时库重建通过

但以下三个不变量仍未闭合：

```text
1. 回放区间：position 与 event-time 两套语义并存
2. live handoff：applyCut 捕获早于 live 订阅，中间有缺口
3. fencing：tokenEpoch PITR 无 bump，renew/release 不校验
```

## 2. 第五轮 P0 关闭情况

| 编号 | 结论 | 理由 |
|---|---|---|
| P0-01 applyWatermark | PARTIALLY CLOSED | ApplyCut 已拆分，但区间二义、partial bar、live barrier 未闭合 |
| P0-02 1001 streamCut | PARTIALLY CLOSED | seq/session/position 文本有了；position 单位、去重作用域、live 位置空间未闭合 |

## 3. 新 P0

### P0-N1 position 是 Aeron 字节位置还是逻辑序号

文档示例：

```text
position     987654321
nextPosition 987654322
```

看起来是消息序号 +1，但 `ArchiveReplayTool --position` 使用 Aeron 字节位置。  
Aeron 下一条消息位置不是 +1，而是 `position + fragmentLength`。

影响：

- replay 可能从一条消息中间开始
- 或跳过整条消息
- live barrier 按 position 切片失效

建议：

```text
position 明确为 Aeron byte position
同时保存 fragmentLength / nextPosition
或 position 用逻辑 message index，另存 aeronPosition
跨 recording/live 连续性用 (sessionId, instrument, seq)
```

### P0-N2 applyCut 与 live 订阅顺序有缺口

当前：

```text
producer 捕获 applyCut
之后才订阅 live
```

如果 live 订阅发生在 applyCut 之后，`[applyCut, liveStartCut)` 的 tick：

- 不在 replay 范围
- 不在 live buffer 范围

建议：

```text
先订阅 live 并缓冲
再捕获 applyCut（或在捕获前记录 liveStartCut）
replay 到 liveStartCut
切换 live
```

buffer 必须有界；溢出 -> WARMUP。

### P0-N3 tokenEpoch renew/release/PITR

问题：

- Acquire 的 `token_epoch = token_epoch` 是 no-op
- Renew/Release 只校验 fencing_token，不校验 token_epoch
- PITR 后旧 engine 可继续续约
- 消费端又只按 fencingToken 比较

建议：

```text
Renew/Release 加 AND token_epoch = :tokenEpoch
PITR 显式 bump tokenEpoch
按 (tokenEpoch, fencingToken, seq) 统一比较
旧 engine 必须被 fence
```

### P0-N4 seq 去重作用域错误

`seq` 是 per-instrument 消息级，但文档用 `(sessionId, seq)` 全局去重。  
两个 instrument 在同一 session 下都从 1 开始，会碰撞。

正确键：

```text
(sourceSessionId, counterpartyId, exchange, instrumentId, seq)
```

`archiveRefs` 还需要 `lastInputSessionId`。  
`streamCut.sessionId`、`archive_segment.session_id`、`ReplayEnvelope.sourceSessionId` 的权威关系要定义。

### P0-N5 snapshot 路径 event-time/position 二义

文档同时写：

```text
(snapshot.watermark, applyCut.eventAsOf]
(snapshot.streamCut.nextPosition, applyCut.nextPosition]
```

snapshot state 已包含切点消息：

- event-time 上界可能重复应用切点
- position `nextPosition` exclusive 可能漏切点

建议：

```text
snapshot 路径：replay [snapshot.nextPosition, applyCut.nextPosition)
新指标路径：replay [artifact.startPosition, applyCut.position]
```

`watermark` 只用于 freshness/gap 预算，不作为 replay 上界。  
`IndicatorState` 包含当前 partial bar，必须明确 partial bar 归属。

### P0-N6 1d 的 cut 与 tick position 混用

1d applyCut 使用“最后收盘交易日”，但 `streamCut.position` 仍是当前 1001 tick 位置。  
夜盘/当日未完成 bar 的 tick 会被算进 cut，但 state 故意不包含。

建议：

```text
1d 使用独立 barCut/tradingDay
当前交易日从 session start replay 到 cut
不要把 1001 position 用于 1d
```

## 4. 主要 P1

- READY 才进入 RouteIndex，但 ACK READY 又在 RouteIndex 之后，可能死锁
- applyCut journal 路径/格式/CRC/恢复进度未定义
- ACK `REJECTED` 终态与 `retryable=true` 矛盾
- 控制面写 PRODUCER_LOST 可能被 latest seq guard 拒绝
- outbox per-event 行与 `(counterparty,catalog_version)` 唯一冲突
- Archive GAP 行仍以 recording_id 为 PK，无法表示无 recording 的 gap
- tick 工作项 apply 时按 indicatorId 重路由，pre-cut tick 可能重复
- VALUE_ENGINE_STATE 发布线程未独立
- delta 没有 operators/operatorSetHash
- 9001 仍写单数，未定义 per-engine stream 分配
- gap 用时间计算，周末/夜盘会误判
- catalogEpoch 变化未保证 tokenEpoch bump
- T-058 仍只有横幅，正文旧模型仍在
- history 只有 default partition
- operator seed 仍空 hash

## 5. 已关闭项

- ApplyCut 从 snapshot 拆分
- 1001 seq 消息级 per instrument
- position inclusive/exclusive 文字定义
- archiveRefs 不再作为全局 replay 起点
- ReplayEnvelope
- ACK requestId 不含 status
- chain binding current unique
- history event_as_of 回退 published_at
- engine 注册/新柜台初始化（设计层）

## 6. 仍缺决策

| # | 决策 | 建议 |
|---|---|---|
| D1 | position 语义 | Aeron byte position 或逻辑 index，二选一 |
| D2 | live barrier 顺序/缓冲上限 | 先订阅 live 再捕获 cut；溢出 WARMUP |
| D3 | session/seq 权威 | CTP session / publisher epoch / Aeron session 关系 |
| D4 | 1d/barCut | 独立 tradingDay/barCut |
| D5 | applyCut 作用域 | 按 delta/batch 一个 cut，还是 per-key |
| D6 | READY/RouteIndex | WARMUP 可路由，gate 按 status |
| D7 | tokenEpoch PITR | DB 外单调源或 bump runbook |
| D8 | Archive roll owner/gap | 独立 roll service，gap 表，active age 告警 |
| D9 | ACK REJECTED retryable | REJECTED_RETRYABLE/FINAL |
| D10 | outbox 行模型 | 一行一 delta 或 event_seq |
| D11 | tombstone guard | control_seq/status_rank/source |
| D12 | T-058 | 重写/归档 |
| D13 | codeHash | catalog + seed |
| D14 | 9001 stream 分配 | per-engine stream/channel |
| D15 | history 分区维护 | 月模板 + detach/drop |

## 7. 建议测试

- position 非 +1（fragment length > 1）
- applyCut 后延迟订阅 live
- 两 instrument 同 session 同 seq=1
- 1d 09:30/20:00/21:00 重启
- 新 tick/1s lookback 不足
- PITR 旧 engine tokenEpoch 更高
- ACK retryable/final
- Archive roll 失败/active >24h
- 两 engine 共用 9001
- 控制面 PRODUCER_LOST 被 seq guard
- operator codeHash 空
- history 分区跨月

## 8. 最终意见

```text
结论：REJECT（作为 V1 实施基线）
方向：APPROVE
```

修完 P0-N1~P0-N6，可转 `APPROVE WITH CHANGES`；  
再修 P1-N3/N4/N5/N6/N8/N9/N10 等，可转 `APPROVE`。

本次审查只读，未修改文件、未执行 SQL。

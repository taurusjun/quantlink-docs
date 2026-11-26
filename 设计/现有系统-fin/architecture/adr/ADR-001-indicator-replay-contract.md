# ADR-001 指标回放与生产协议

- 状态：**APPROVED（协议决策）— D1 golden PASS；production 等待 27 更新**
- 日期：2026-11-12
- 决策范围：第六轮架构评审的 6 个 P0
- 关联：
  - `docs/architecture/27-指标目录与Agent内存热加载.md`（当前 **REJECT**，作为生产实施规范）
  - `docs/reviews/2026-11-12-indicator-catalog-architecture-review-v6.md`
  - `docs/reviews/2026-11-12-adr-001-targeted-review.md`（首轮定向评审：APPROVED WITH CHANGES）
  - `docs/reviews/2026-11-12-adr-001-final-review.md`（最终定向复审：APPROVED）
  - `docs/reviews/2026-11-12-indicator-poc-conclusion.md`（POC CLOSED / CORE PASS）

> 本 ADR 是生产协议决策，不是实现代码。
> **ADR DRAFT ≠ 审查通过 ≠ 生产解禁。**
> 只有 D1-D6 全部 CLOSED，定向复审给出 APPROVED，并更新/取代 27 号文档后，才解除 production BLOCKED。

## 1. Context

POC 已验证：

```text
真实 Archive 1001 replay
SBE MarketData -> MarketEvent
MarketEvent -> EmaState
snapshot/replay/fencing/applyCut 的内存语义
```

但 POC 的 `AeronArchiveAdapter` 把 Aeron `Header.position()` 当作 fragment 起点，并把 payload length 当作 frame length。
Aeron 1.54 的 `Header.position()` 实际是**帧结束位置**：

```text
frameEnd   = header.position()
frameStart = frameEnd - header.frameLength()
```

因此 190 的 `samples=23298` 只能证明 SBE 解码和 EMA，不能证明 position/cut 语义。
本 ADR 明确正确的 API 映射，并把“真实 Archive 最后一帧 golden”列为 D1 的闭合证据。

## 2. Decision Summary

| # | 决策 | 结论 |
|---|---|---|
| D1 | position/cursor | 以 frameEnd 为 exclusive cursor；`frameStart = frameEnd - frameLength`；payload length 不参与 cursor |
| D2 | live barrier | 先等 `Image.available()` 并缓冲，再捕获 applyCut；replay 到 cut 后按 per-input seq drain |
| D3 | tokenEpoch | 控制面权威；PITR 显式 bump；renew/release 校验 tokenEpoch；guard 使用 `valueSeq` |
| D4 | source session / seq | `sourceSessionId + sourcePublicationEpoch + instrument + seq` 去重；9001 只做 transport |
| D5 | snapshot/warmup 区间 | 全部使用半开区间 `[from, to)`；watermark 只做 freshness |
| D6 | 1d barCut | `barCut` 与 `streamCut` 分离；1d 保留 current partial；夜盘归下一交易日 |

### 2.1 Closure Status

| # | 协议决策 | 证据状态 |
|---|---|---|
| D1 | CLOSED | 真实 Archive 最后一帧 golden 已 PASS（recording 1021）；production 只等 27 更新 |
| D2 | CLOSED | 顺序、image barrier、replay 完成校验、per-input drain 已定义 |
| D3 | CLOSED | 首轮评审已 CLOSED；本次补 `valueSeq` 作用域 |
| D4 | CLOSED | `sourceSessionId + publicationEpoch + seq` 已定义 |
| D5 | CLOSED | 全部半开区间；跨 recording 已定义 |
| D6 | CLOSED | `barCut`、partial、夜盘日历已定义 |

D1 的协议决策已闭合，但真实 Archive golden 是**生产准入证据**，不是协议文本本身。

## 3. D1：position / cursor

### 3.1 Aeron API 映射

`FragmentHandler` 回调参数必须这样解释：

```text
frameEnd        = header.position()          // Aeron 1.54: 帧结束
frameLength     = header.frameLength()       // 含 Aeron frame header + padding
frameStart      = frameEnd - frameLength
payloadLength   = handler.length             // SBE payload，仅用于解码
nextPosition    = frameEnd                   // exclusive cursor
```

禁止：

```text
nextPosition = header.position() + handler.length
position     = header.position()
用 message index 冒充 Aeron position
跨 recording/live 直接比较 position
```

### 3.2 StreamCut

```text
StreamCut {
  recordingId
  streamId
  position          // 最后一条已完整应用 fragment 的 frameStart
  nextPosition      // 最后一条 fragment 的 frameEnd（exclusive）
  eventAsOf         // 最后一条已应用消息的 SBE timestamp；空 cut 才允许 0
}
```

不变量（非空 cut）：

```text
nextPosition > position
nextPosition == position + frameLength
eventAsOf > 0
```

空 cut：

```text
recordingId = -1
position = nextPosition = 0
eventAsOf = 0
```

`StreamCut` 不再包含全局 `sessionId`。source session 是 per-input 的，见 D4 的 `InputCursor`。

### 3.3 InputCursor

```text
InputCursor {
  counterpartyId
  exchange
  instrumentId
  sourceSessionId
  sourcePublicationEpoch
  lastSeq
  eventAsOf
}
```

`StreamCut` 持有 `Map<InputKey, InputCursor>`。
`position/nextPosition` 只描述全局行情流；每个 input 的连续性用 `sourceSessionId + sourcePublicationEpoch + lastSeq` 判断。

### 3.4 Archive 适配器

`AeronArchiveAdapter` 必须：

```text
1. replay filter 使用 frameStart >= from && frameEnd <= to
2. 保证 frameEnd == to 的最后一帧被消费
3. 给 MarketEvent 传 frameStart/frameLength，不传 payload length
4. nextPosition = frameEnd
```

`lastCut()` 不能只靠 `listRecordingsForUri` 的 `stopPosition` 伪造：

```text
listRecordingsForUri 只提供 stopPosition
它不提供最后一帧 frameLength，也不提供 eventAsOf
```

`lastCut()` 必须来自：

```text
journal/LKG 中持久化的 StreamCut
或对最后一帧做有界 tail replay 后计算
```

如果两者都没有，返回空 cut 或明确失败，不能返回 `position = nextPosition = stopPosition` 的非空 cut。

### 3.5 D1 闭合证据

在真实 190 Archive 上增加 golden：

```text
fragments 数
最后一帧 included
frameLength != payloadLength
nextPosition == header.position()
nextPosition == toPositionExclusive
eventAsOf == 最后一帧 SBE timestamp
```

通过后才满足 D1 的 production 准入，协议决策本身已 CLOSED。

2026-11-12 在 190 上已通过：

```text
recordingId=1021
lastFrameStart=33554319
lastFrameEnd=33554592
lastFrameLength=273
lastPayloadLength=241
lastFrameEnd == toPositionExclusive
```

## 4. D2：live barrier

### 4.1 顺序

```text
0. 订阅 live 1001
1. await Image.available()
2. liveStartPosition = image.joinPosition()
3. 开始把 live fragment 放入有界 buffer
4. producer 在安全点捕获 applyCut
5. applyCut + StreamCut + InputCursor 写入 LKG/journal 并 fsync
6. assert archiveDurableHead >= applyCut.nextPosition
7. replay Archive 到 applyCut.nextPosition（exclusive）
8. assert lastAppliedFrameEnd == applyCut.nextPosition
9. drain live buffer：按每个 input 的 (sourceSessionId, sourcePublicationEpoch) + seq 处理
   - 同 session/epoch 且 seq > lastSeq：接受
   - 同 session/epoch 且 seq <= lastSeq：重复，丢弃
   - session/epoch 不同：不能沿用旧 lastSeq；若是控制面 current epoch，重新捕获 applyCut
     或进入 WARMUP；非 current epoch 丢弃并告警
10. 切换到 live
```

barrier 期间发生 publisher restart / image change 时，不允许静默续接。
必须重新捕获 applyCut，或进入 WARMUP/REJECT；新 epoch 的 seq 从 1 开始不能被当作重复。

不能：

```text
先捕获 applyCut，之后才订阅 live
先停 replay，再订阅 live
用绝对 position 直接切片 live buffer
```

### 4.2 live image 屏障

`addSubscription` 返回不代表 image 已可用。必须等待 `Image.available()`。

```text
liveStartPosition > applyCut.nextPosition
  -> 中间有缺口，进入 WARMUP/REJECT
liveStartPosition <= applyCut.nextPosition
  -> 允许，replay 与 buffer 重叠部分按 seq 去重
```

上述 position 比较只在 live image 的 sourceSessionId/sourcePublicationEpoch 与
applyCut 的对应 input cursor 一致时有效。session/epoch 不一致时 position 归零或不可比，
必须按 D4 的 epoch 规则处理，并重新捕获 applyCut 或进入 WARMUP。

如果 image 在 cut 之后才可用，`[cut, liveStart)` 既不在 replay 也不在 buffer，必须失败，不能静默继续。

### 4.3 replay 完成校验

```text
lastAppliedFrameEnd == applyCut.nextPosition
applyCut.nextPosition <= archiveDurableHead
```

不满足时有界等待；超过预算进入 WARMUP，不能把缺失尾段过滤掉。

### 4.4 buffer 与去重

```text
有界 buffer
溢出 -> 停止 apply -> WARMUP / REJECT
去重键 = (sourceSessionId, sourcePublicationEpoch,
          counterpartyId, exchange, instrumentId, seq)
```

position 只在同一 source session 内用于定位，不能单独作为跨 recording/live 的去重键。

`VALUE_ENGINE_STATE.status=REPLAYING` 时策略禁止新开仓。

## 5. D3：tokenEpoch fencing

### 5.1 Authority

`tokenEpoch` 由控制面持久化权威维护，并与 lease 行使用同一 PITR 一致性存储。

```text
普通重启：fencingToken 递增
PITR/reset/目录重建：tokenEpoch 显式 bump
bump = max(restoredEpoch, lastIssuedEpoch) + 1
bump 必须在 acquire 前持久化
```

如果 authority 使用 DB 外源，必须明确该源不被 PITR 回滚。

### 5.2 Lease

Acquire 返回：

```text
leaseId
tokenEpoch
fencingToken
expiresAt
```

Renew/Release：

```sql
WHERE counterparty_id = :counterpartyId
  AND lease_id = :leaseId
  AND token_epoch = :tokenEpoch
  AND fencing_token = :fencingToken
  AND status = 'ACTIVE'
```

### 5.3 Guard

消费端/值 guard：

```text
(tokenEpoch, fencingToken, valueSeq)
```

`valueSeq` 是 per-indicator 的单调递增序号，不是 1001 市场 seq。
市场 seq 只用于 D4 去重。

Guard 必须覆盖所有外部写：

```text
ValueKV
outbox
DB
snapshot/LKG
```

### 5.4 PITR runbook

```text
1. 恢复 DB
2. bump tokenEpoch
3. 清空/失效旧 ValueKV 副本
4. 所有 engine 重新 acquire
5. 旧 engine 自 fence
```

## 6. D4：source session / publicationEpoch / seq

### 6.1 source session

```text
sourceSessionId 由 CTP/adapter publication session 产生
1001 消息必须携带 sourceSessionId
ReplayEnvelope 必须携带 sourceSessionId
```

9001 replay transport session 不是 source session，禁止用于去重或连续性判断。

### 6.2 publicationEpoch

```text
每个 publisher 每次启动生成新的 sourcePublicationEpoch
epoch 必须唯一、持久化、可比较
seq 在每个 (instrument, epoch) 内从 1 开始
publisher 重启后 seq 归零，必须换新 epoch
```

控制面登记每个 `(counterpartyId, exchange, instrumentId)` 的 current epoch。
消费端拒绝非 current epoch，旧 epoch 消息告警/丢弃。

### 6.3 去重键

```text
(sourceSessionId, sourcePublicationEpoch,
 counterpartyId, exchange, instrumentId, seq)
```

`seq` 是消息级：一条 1001 MarketData 的 last/bid/ask/volume/OI 共享一个 seq。

### 6.4 Gap

```text
同 (sourceSessionId, sourcePublicationEpoch, instrument) 内：
  seq == lastSeq + 1  -> 正常
  seq <= lastSeq      -> 重复，丢弃
  seq > lastSeq + 1   -> gap
```

gap 记入 telemetry；超过预算进入 WARMUP/NO_DATA，不能静默跳过。

## 7. D5：snapshot / warmup 回放区间

### 7.1 半开区间

所有 replay 使用：

```text
[from, to)
```

`to` 是 exclusive frameEnd，不允许 inclusive upper。

### 7.2 snapshot 路径

```text
snapshot.state 包含当前 partial bar
snapshot.streamCut.position 是最后已处理帧的 frameStart
snapshot.streamCut.nextPosition 是最后已处理帧的 frameEnd
replay [snapshot.streamCut.nextPosition, applyCut.nextPosition)
```

snapshot 状态与 streamCut 必须在同一个 producer 临界区捕获。

### 7.3 新指标路径

```text
ArtifactReplayStart {
  recordingId
  sourceSessionId
  sourcePublicationEpoch
  position          // frameStart
  nextPosition      // frameEnd
  eventAsOf
}
```

```text
replay [artifact.position, applyCut.nextPosition)
```

`initialReplayFrom` 是 event-time。必须解析成 `(recordingId, frameStart)`：

```text
按 recording/时间索引找到 eventAsOf >= initialReplayFrom 的第一帧
```

不能写：

```text
max(initialReplayFrom, earliestRecording)
```

因为一边是时间，一边是 recording id。

### 7.4 跨 recording

```text
按 (recordingId, from, to) 逐段 replay
每段结束用 seq 校验连续
session/epoch 变化 -> WARMUP
```

### 7.5 其他规则

```text
watermark 只用于 freshness/gap 预算，不作为 replay 上界
CUMULATIVE 指标不允许部分回放
不足 lookback -> WARMUP，不静默缩短
```

如果 snapshot 选择只包含已收盘 bar：

```text
必须显式记录 closedBarCut
replay 从 closedBarCut.nextPosition 开始
不能把 closedBarCut 和 watermark 混用
```

## 8. D6：1d barCut

### 8.1 BarCut

```text
BarCut {
  tradingDay
  calendarId
  barStartEventAsOf
  barEndEventAsOf
  cutPosition          // frameStart
  cutNextPosition      // frameEnd
  closedAt
  status               // PARTIAL / CLOSED
}
```

`streamCut.eventAsOf` 始终表示“最后一条已应用 tick 的事件时间”。
1d 的最后收盘日放在 `barCut`，不能覆盖 `streamCut.eventAsOf`。

### 8.2 1d 状态

```text
1d state = closed daily bars + current-day PARTIAL bar
applyCut 仍在当前流位置
barCut 只标记最后已收盘交易日
只有 status=CLOSED 的 bar 才能发 OK
```

盘中恢复：

```text
snapshot/applyCut 包含 current partial bar
replay 从 streamCut.nextPosition 继续
不能把未完成日 bar 当成 CLOSED
```

### 8.3 夜盘/交易日历

```text
夜盘 tick 归属下一交易日
Friday night -> Monday（或节假日后的下一交易日）
holiday eve -> 节后第一个交易日
tradingDay 由交易所日历决定，不能用自然日
```

日盘收盘（交易日最后一个日盘 session 结束）：

```text
daily bar close
barEndEventAsOf = 最后一条已应用 tick 时间
barCut.status = CLOSED
```

夜盘收盘：

```text
只结束 night segment
当前交易日 bar 仍为 PARTIAL
不把 barCut.status 置为 CLOSED
```

如果交易所日历定义该交易日以夜盘结束（没有后续日盘），按 calendar 的
`tradingDayEnd` 触发 CLOSED。

测试至少覆盖：

```text
15:00 日盘收盘 -> CLOSED
02:30 夜盘收盘 -> 仍 PARTIAL
09:30 / 20:00 / 21:00 恢复
Friday night -> Monday
holiday eve -> next trading day
```

## 9. Non-goals

本 ADR 不决定：

```text
SQL schema 落地
Java Mapper/Publisher/Consumer 迁移
管理页面
1d/pair/期权链完整实现
ACK/outbox 细节
多 Agent / PITR 完整 HA
```

这些进入生产实现计划，仍需单独评审。

## 10. P1 Closure

ADR-002 收口的是 **ADR-001 §10 明确列出的 8 个 P1**，不是 v6 §4 的全部 15 个 P1：

| P1 | 决策 |
|---|---|
| READY/RouteIndex 生命周期 | ADR-002 §2 |
| ACK REJECTED_RETRYABLE/FINAL | ADR-002 §3 |
| 控制面 PRODUCER_LOST status rank | ADR-002 §4 |
| outbox per-event vs per-delta | ADR-002 §5 |
| Archive roll/gap/active retention | ADR-002 §6 |
| history 分区 | ADR-002 §7 |
| operator codeHash | ADR-002 §8 |
| T-058 清理 | ADR-002 §9 |

### v6 §4 的剩余 P1（已由 ADR-003 收口）

以下 5 项不在 ADR-001 §10，已由 `ADR-003` 收口：

```text
1. applyCut journal 路径/格式/CRC/恢复进度
2. tick 工作项按 indicatorId 重路由，pre-cut tick 可能重复
3. VALUE_ENGINE_STATE 发布线程未独立
4. 9001 仍写单数，未定义 per-engine stream/channel 分配
5. catalogEpoch 变化未保证 tokenEpoch bump
```

当前状态：

```text
v6 P0 协议：CLOSED
v6 §4 P1：15 closed / 0 open（ADR-002 10 + ADR-003 5）
生产实现：未开始
```

## 11. Approval Gate

```text
D1-D6 协议决策 CLOSED
  -> targeted re-review APPROVED
  -> D1 真实 Archive 最后一帧 golden PASS
  -> 更新/取代 27 号文档
  -> 生产实现计划
  -> 生产代码
```

当前：

```text
POC: CLOSED / CORE PASS
27 doc: SUPERSEDED（P0 协议）
ADR-001: APPROVED（协议决策）
D1 golden: PASS（recording 1021）
ADR-002: P1 closure（见独立文档）
Production: BLOCKED，等待 P1 实施/生产计划
```

## 12. Targeted Re-review Questions

复审只回答：

```text
1. D1 的 frameStart/frameEnd/cursor 是否覆盖 recording + live 连续性？
2. D2 的 live barrier 是否真正不丢/不重？
3. D3 的 tokenEpoch/valueSeq 是否足以处理 PITR/reset/split-brain？
4. D4 的 sourceSession/publicationEpoch/seq 是否覆盖重启和多 instrument？
5. D5 的半开区间和跨 recording 是否不重不漏？
6. D6 的 barCut/partial/night session 是否与交易日历一致？
```

不需要再审全文，不需要再审 POC。

# ADR-003 指标运行时剩余 P1 收口

- 状态：**APPROVED — 5 个运行时 P1 协议；生产实现待计划**
- 日期：2026-11-12
- 范围：v6 §4 剩余的 5 个 P1
- 关联：
  - `docs/architecture/adr/ADR-001-indicator-replay-contract.md`
  - `docs/architecture/adr/ADR-002-indicator-p1-closure.md`
  - `docs/reviews/2026-11-12-adr-003-final-review.md`
  - `docs/reviews/2026-11-12-indicator-catalog-architecture-review-v6.md`
  - `docs/architecture/27-指标目录与Agent内存热加载.md`

> ADR-003 只关闭运行时协议，不实现生产 Java 代码。
> 这 5 项不在 ADR-001 §10 的 8 项清单里，因此 ADR-002 APPROVED 不代表它们已关闭。

## 1. Decision Summary

| # | P1 | 决策 |
|---|---|---|
| R1 | applyCut journal | 分段追加式二进制日志；CRC32C；PREPARED/APPLIED 两阶段；恢复按 offset，不按 mtime |
| R2 | tick 重路由 | tick 携带 `planVersion`；旧 plan 保留到队列 + live buffer drain；按 per-input session/epoch/seq 只应用一次 |
| R3 | VALUE 发布线程 | engine 只发 Aeron `VALUE_DELTA`；独立 publisher 合并；control-plane 持久化 DB；心跳独立 |
| R4 | 9001 分配 | 每个 engine 控制面分配唯一 `replayStreamId`；禁止共用 9001；无 fallback |
| R5 | catalogEpoch bump | `catalogEpoch` 变化必须先 bump `tokenEpoch`，再允许 acquire/catalog |

## 2. R1：applyCut journal

### 2.1 路径

```text
<engine-data>/indicator/applycut/
  applycut-000001.aqj
  applycut-000002.aqj
  applycut.checkpoint
```

- 与 stateSnapshot 同一本地文件系统，不允许 NFS。
- 目录权限 `0700`，仅 engine 用户可写。
- `applycut.checkpoint` 保存：

```text
lastSegmentId
durableOffset
replayStartOffset
lastApplyId
updatedAt
crc32c
```

### 2.2 记录格式

```text
offset  size  field
0       4     magic = "AQJ1"
4       2     version = 1
6       1     recordType (PREPARED=1, APPLIED=2, ABORTED=3)
7       1     flags
8       4     payloadLength
12      N     payload: canonical JSON (JCS UTF-8)
12+N    4     crc32c
```

`crc32c` 覆盖 **header + payload**，使用 Castagnoli 多项式。
单条记录最大 64 KiB；超过直接拒绝。

payload 必填：

```text
applyId
cutId
engineId
indicatorId
planVersion
catalogEpoch
catalogVersion
tokenEpoch
fencingToken
recordingId
streamId
position
nextPosition
eventAsOf
capturedAt
inputs[]:
  inputKey
  sourceSessionId
  sourcePublicationEpoch
  lastSeq
  lastPosition
  eventAsOf
```

所有 64 位字段（applyId 以外的 id/position/epoch/seq）在 JCS payload 中使用**十进制字符串**，
避免 JSON number 的 IEEE-754 精度问题。`cutId` 标识一次 catalog delta/batch 的切点；
同一 batch 的所有指标共享该 `cutId`。

`applyId` 使用 UUIDv7，时间有序；不允许随机 UUID 作为唯一排序依据。

### 2.3 写入顺序

```text
1. 组装 PREPARED record
2. append 到当前 segment
3. FileChannel.force(true)             // PREPARED 必须 fsync
4. replay 到 nextPosition
5. state snapshot durable              // 状态持久化
6. append APPLIED record
7. FileChannel.force(true)
8. ACK APPLIED
9. checkpoint 推进到 APPLIED 末尾
10. checkpoint fsync
```

checkpoint 只能推进到 **最后一个 APPLIED/ABORTED** 的末尾，不能推进到 PREPARED 之后。
`checkpoint` 至少保存：

```text
durableOffset       // 可安全 append 的位置（已截断 torn tail）
replayStartOffset   // 恢复时开始扫描的位置
lastApplyId
lastSegmentId
updatedAt
crc32c
```

`durableOffset` 和 `replayStartOffset` 分开：前者用于 torn-tail 截断，后者用于恢复扫描。

`APPLIED` 必须在 state snapshot durable 之后写。
如果状态快照包含 `applyId` 且 `snapshot.cut == applyCut.cut`，恢复时可以幂等跳过 replay；
否则必须重建 state。

### 2.4 状态机

```text
PREPARED
  -> REPLAYING
  -> APPLIED
  -> (ACK 已记录)

PREPARED
  -> ABORTED
```

- `PREPARED`：applyCut 已 fsync，replay 还没完成。
- `APPLIED`：state 已提交，允许 ACK `APPLIED`。
- `ABORTED`：显式放弃，不再 replay。
- 只有 `APPLIED` 才能推进 checkpoint 的 `lastApplyId`。

### 2.5 恢复

```text
1. 从 checkpoint 的 replayStartOffset 开始
2. 读取 header，校验 magic/version/payloadLength
3. 校验 crc32c
4. 读取 recordType
5. 正常记录继续；遇到不完整尾部 -> 截断到最后完整 offset 并 fsync
6. 中间 CRC 错误 -> fail closed，不能跳过
```

恢复决策：

```text
checkpoint 损坏/缺失
  -> 从最早可用 segment 的 offset 0 重新扫描
  -> 不能因为 checkpoint 丢失就跳过 PREPARED
```

```text
最后记录 PREPARED
  -> 查 state snapshot 是否包含同一 applyId + cut
  -> 包含 -> 补写 APPLIED，再推进 checkpoint
  -> 不包含 -> 用同一个 applyId 重新 replay 到 nextPosition

最后记录 APPLIED
  -> 校验 state snapshot 存在且 cut 匹配
  -> 匹配 -> 幂等跳过 replay
  -> 缺失/损坏 -> 强制重建，不能直接跳过

最后记录 ABORTED
  -> 忽略
```

`latest()` 必须按 `(segmentId, offset)` 排序，不能按文件 mtime；同一 applyId 取最大 offset 的记录。

### 2.6 清理

```text
只删除已经 APPLIED 且被 snapshot/ACK 覆盖的旧 segment
保留至少 2 个 segment
PREPARED/ABORTED 永不因 retention 删除
checkpoint 所在 segment 不得删除
```

### 2.7 cut 作用域

一个 catalog delta/batch 使用一个 `cutId`：

```text
同一 batch 的所有 indicator 共享 cutId
每个 indicator 的 PREPARED 全部 APPLIED 后，plan 才能 READY
任何一个 PREPARED 未完成 -> 整个 batch 保持 APPLIED/REPLAYING
```

不允许同一个 batch 内一部分 indicator 已切 live、另一部分还在 replay 时对外发布。

POC `FileApplyCutJournal` 是 per-apply 文本文件、按 mtime 取 latest、无 CRC、无 PREPARED/APPLIED，
明确不满足本节；生产必须替换，POC 不能作为 R1 闭合证据。

## 3. R2：tick 重路由与 pre-cut 重复

### 3.1 TickEnvelope

每个 tick 工作项必须携带：

```text
planVersion        // catalogVersion
sourceSessionId
sourcePublicationEpoch
inputKey
seq
position
eventTime
payload
```

`localId` 只在同一个 `planVersion` 内有效，不能跨 plan 使用。

### 3.2 RouteIndex 版本化

```text
PlanVersion 42:
  inputKey -> [localId, indicatorId, ...]

PlanVersion 43:
  inputKey -> [localId, indicatorId, ...]  // 新 plan
```

- 每个 `planVersion` 是不可变快照。
- 新 plan 生效后，旧 plan 不能立刻销毁；要保留到工作队列和 live buffer 中所有 `planVersion=42` 的 tick 处理完。
- 最多允许 2 个在途 plan；旧 plan 未 drain 时新 catalog apply 返回 `REJECTED_RETRYABLE`，不能无限堆积。
- tick 的 apply 必须使用它入队时的 `planVersion`，不能改成“当前最新 plan”重路由。

### 3.3 applyCut 屏障

hot add/delete 的顺序：

```text
1. producer 停止接收新的 tick 工作项（或标记 cut 边界）
   live 订阅继续缓冲，不能停止收 tick
2. drain 工作队列 AND live buffer 到 applyCut.nextPosition
   - 每个 input 的 lastAppliedSeq 必须 >= cut.inputs[].lastSeq
3. 在安全点捕获 applyCut
4. 新指标 replay 到 applyCut.nextPosition
5. 新 plan 每个 input 从 applyCut.inputs[inputKey].lastSeq + 1 开始
   新 input 不在 cut 中 -> 从 replay 起点初始化
6. 旧 plan refcount 归零后释放
```

释放旧 plan 的条件必须同时满足：

```text
work queue 中无旧 plan tick
live buffer 中无旧 plan tick
每个 input lastAppliedSeq >= applyCut.inputs[].lastSeq
```

live buffer 溢出：

```text
WARMUP/REJECT
不能静默丢
```

`applyCut` 必须包含每个 input 的：

```text
lastAppliedSeq
lastAppliedPosition
```

### 3.4 Apply 规则

去重键：

```text
(sourceSessionId, sourcePublicationEpoch, inputKey, seq)
```

```text
tick.seq <= applyCut.inputs[inputKey].lastSeq
  且 session/epoch 相同:
  该 tick 已属于旧 plan
  新指标不能再次应用（它已在 replay 中包含）
  旧指标按旧 plan 处理

tick.seq > applyCut.inputs[inputKey].lastSeq:
  使用新 plan

inputKey 不在 applyCut.inputs 中:
  新 input
  用 replay 起点初始化
  不沿用其他 input 的 lastSeq

session/epoch 不同:
  不能沿用旧 lastSeq
  current epoch -> 重新捕获 cut 或 WARMUP
  非 current -> 丢弃/告警
```

每个 input 维护：

```text
(lastSourceSessionId, lastPublicationEpoch, lastAppliedSeq, lastAppliedPosition)
```

如果收到：

```text
同 session/epoch 且 seq <= lastAppliedSeq  -> 重复，丢弃
同 session/epoch 且 seq == lastAppliedSeq + 1 -> 正常
同 session/epoch 且 seq > lastAppliedSeq + 1 -> gap
```

gap 时：

```text
不 apply
WARMUP
走 replay/rebuffer 补齐
连续后才能恢复
```

### 3.5 新 plan 初始化

```text
新 plan 的每个 input lastApplied 从 applyCut.inputs[] 初始化
新 input 不在 cut 中时使用 replay 起点，不从其他 input 推导
pre-cut buffered tick 只作用于旧 State
新指标靠 replay 覆盖 [start, cut)
cut 之后的 tick 才进入新 plan
```

不能把 pre-cut tick 重路由给新 indicator；否则新 indicator 会重复计算。

### 3.6 禁止

```text
不能因为新 plan 有 indicatorId 就把旧 tick 重新路由给新 indicator
不能把 localId 当作跨 plan 的稳定身份
不能在旧 plan 队列未 drain 时销毁旧 State
```

验收：

```text
catalog 42 -> 43 时有 1000 个 tick 在队列
新指标 replay 到 cut
旧 tick 不得进入新指标
新 tick 必须只进入新 plan
所有 indicator 的 seq 无重复、无缺口
```

## 4. R3：VALUE_ENGINE_STATE 与发布线程

### 4.1 线程与写入归属

engine 不直接写指标历史 DB。职责分开：

```text
engine producer/tick 线程
  -> 更新 ValueKV
  -> 写入有界 value queue

engine value-publisher 线程
  -> 合并 latest
  -> 发布 VALUE_DELTA / VALUE_SNAPSHOT 到 Aeron 2013
  -> 不做 DB I/O

control-plane value-consumer
  -> 消费 2013
  -> 批量写 indicator_latest / history / dedupe
  -> 更新 persist lag 指标

strategy
  -> 从 Aeron ValueKV 副本读取
  -> gate 使用 VALUE_ENGINE_STATE + indicator value

snapshot 线程
  -> 只写 dirty state

lease/heartbeat 线程
  -> 续约
  -> 发布 VALUE_ENGINE_STATE
```

这样与 doc 27 “engine 运行期不读指标 DB / 控制面负责历史”一致。
`indicator_latest` 是控制面审计/UI/查询视图，不是策略交易的唯一实时来源。

### 4.2 队列、generation 与背压

```text
有界 MPSC 队列
每个 indicatorId 维护 dirty generation
publisher 发布前重读 ValueKV 的 latest
```

队列满时：

```text
保留每个 key 的 latest generation
丢弃中间 generation
增加 coalesced 计数
不阻塞 producer
```

不能只“保留一个 value 对象”：必须用 `(indicatorId, generation)` 判断，
防止 publisher 在重读/写入期间 producer 又更新，导致最新值被旧 generation 覆盖。

`indicator_latest` 写入使用 ADR-001/ADR-002 的 guard：

```text
(tokenEpoch, fencingToken, valueSeq)
```

control-plane consumer 用 `(engineId, valueSeq/streamSeq)` 做幂等；DB 写失败只影响持久化副本，
不回压 engine 的 dirty。历史可以采样/丢弃中间值，latest 不允许永久落后。

engine 的 dirty 只在 **Aeron VALUE_DELTA 发布成功** 后清除，不由 control-plane 清除。

### 4.3 VALUE_ENGINE_STATE

```text
engineId
counterpartyId
producerEpoch
tokenEpoch
fencingToken
catalogEpoch
catalogVersion
leaseExpiresAt
heartbeatAt
status: ACTIVE | REPLAYING | FENCED | LOST | STOPPED
```

- 1s 一条，engine 级，不进入每个 IndicatorValue。
- 由 lease/heartbeat 线程独立发布，不能依赖 value-publisher 的 Aeron/DB 进度。
- `REPLAYING` 期间策略禁止新开仓。
- `FENCED/LOST` 时策略失效本地副本。
- `persistLagMs` 不属于 engine 状态：它由 control-plane 的 VALUE 消费健康消息
  `VALUE_PERSIST_STATE` 单独发布；engine 不知道 DB 落盘进度。
- DB 持久化滞后不改变 engine `ACTIVE`；超过阈值告警。若风控要求 DB 实时一致，
  必须额外配置 blocking gate，默认策略读 Aeron ValueKV，不读 DB。

### 4.4 写入顺序

```text
engine ValueKV 更新（内存）
  -> value queue
  -> VALUE_DELTA 发布
  -> control-plane consumer 接收
  -> indicator_latest UPSERT（guard）
  -> indicator_value_history + dedupe（同一事务）
```

DB 失败：

```text
control-plane 有界重试 + 退避
engine ValueKV 继续提供最新值
VALUE_ENGINE_STATE 继续心跳
persistLagMs 超阈值 -> 告警
```

DB 失败不能让 engine tick 线程阻塞，也不能把 `ACTIVE` 直接改成 `REPLAYING`；
`REPLAYING` 只表示行情 replay，不表示 DB sink 落后。

## 5. R4：9001 per-engine 分配

### 5.1 分配与生命周期

`9001` 只是 POC 默认值，生产不能共用。

```text
engineSlot       = 控制面分配的全局唯一整数
replayStreamId   = 9001 + engineSlot（9001..9999）
replayChannel    = aeron:ipc（或按 host 配置）
replayEpoch      = 每次 engine 注册/重启单调递增
replaySessionId  = 控制面为一次 replay grant 分配的唯一 id
```

控制面表 `indicator_engine`：

```text
replay_stream_id      INTEGER NOT NULL
replay_channel        TEXT NOT NULL
replay_epoch          BIGINT NOT NULL
replay_session_id     TEXT NOT NULL
replay_state          ALLOCATED | ACTIVE | DRAINING | RECLAIMABLE
replay_allocated_at
replay_released_at
```

约束：

```text
replay_stream_id BETWEEN 9001 AND 9999
UNIQUE(replay_stream_id, replay_epoch)
PARTIAL UNIQUE(replay_stream_id) WHERE replay_state <> 'RECLAIMABLE'
PARTIAL UNIQUE(replay_session_id) WHERE replay_session_id <> ''
禁止 1001 / 2001-2013 等 live/order stream
replay_epoch > 0
```

### 5.2 注册与 grant

```text
1. engine 启动，请求 engine slot
2. control-plane 用 DB UNIQUE + SKIP LOCKED/重试分配
3. control-plane 生成 replayEpoch + replaySessionId
4. engine 得到 replay stream/channel/epoch/session
5. ArchiveReplayTool 使用同一个 grant 启动 replay
6. 租约/engine 注册成功后才允许发布
7. 无可用 slot -> 启动失败，不 fallback 9001
```

`ReplayGrant`：

```text
engineId
replayStreamId
replayChannel
replayEpoch
replaySessionId
recordingId
fromPosition
toPositionExclusive
```

`ArchiveReplayTool` 必须把 grant 原样写入每条 `ReplayEnvelope`。

### 5.3 Envelope 与过滤

每条 replay 消息必须带：

```text
engineId
replayEpoch
replaySessionId
recordingId
position
sourceSessionId
sourcePublicationEpoch
payload
```

engine 只消费：

```text
engineId == self
AND replayEpoch == currentGrant.replayEpoch
AND replaySessionId == currentGrant.replaySessionId
```

只比较 `engineId` 不够：同 engine 重启后旧 Archive replay session 可能仍在跑。
旧 epoch/session 的消息必须丢弃并告警。

### 5.4 释放

```text
engine deregister / lease EXPIRED
-> replay_state = DRAINING
-> 通知 ArchiveReplayTool stopReplay
-> 确认 archive session 停止
-> replay_state = RECLAIMABLE
-> 新 engine 才能复用该 slot
```

slot 复用必须产生新的 `replayEpoch`；旧 epoch 永远拒绝。
不能仅凭 lease 过期就直接复用 slot。

验收：

```text
两个 engine 同时启动 -> 两个不同 replay stream
同 engineId 重启且旧 replay 仍存活 -> 旧 epoch/session 被拒绝
无 9001 共用
slot 耗尽 -> NO_SLOT，不是 fallback
```

## 6. R5：catalogEpoch -> tokenEpoch bump

### 6.1 Authority

`tokenEpoch` 不能只依赖会被 PITR 回滚的 DB sequence。
权威文件：

```text
/var/lib/quantlink-fin/indicator-token-epoch.hwm
```

内容：

```text
epoch
restoreGeneration
updatedAt
crc32c
```

- 独立于数据库，原子写 + fsync。
- control-plane 启动时读取：

```text
lastIssuedEpoch = max(fileEpoch, dbLastIssuedEpoch)
restoreGeneration = external restore marker
```

- 文件缺失/损坏 -> fail closed，进入 maintenance，不能从 0 开始。
- DB sequence 只作为同一高水位内的分配器，不作为唯一权威。
- HWM 文件只允许 control-plane leader 写；多实例用文件锁/leader lease，禁止双 writer。

### 6.2 触发

以下任一情况必须 bump：

```text
catalogEpoch 变化（E1 -> E2）
PITR / DB restore / rebuild
DB 的 restore_generation != 外部 restore marker
control-plane 检测到 tokenEpoch 回退
lease/epoch marker 不一致
```

`catalogEpoch` 本身只比较相等，不比较大小。
PITR 到相同 catalogEpoch 也必须靠 `restore_generation` 检测，不能只看 epoch。

### 6.3 原子 bump + fence

```text
1. newEpoch = max(fileHighWater, dbLastIssuedEpoch) + 1
2. 原子写 high-water 文件（epoch + restoreGeneration）并 fsync
3. 单 DB 事务：
     SETVAL indicator_token_epoch_seq TO newEpoch
     UPDATE indicator_lease
       SET token_epoch = newEpoch, status = 'FENCED'
     UPDATE indicator_catalog_state
       SET token_epoch_bumped_for = :newCatalogEpoch,
           restore_generation = :restoreGeneration
4. 提交
5. 发布 VALUE_INVALIDATE / FENCED
6. engine 重新 acquire
7. 下发新 catalogEpoch snapshot
8. 重建 State/RouteIndex
```

为什么 high-water 先写：

```text
先写文件、后写 DB：
  文件成功 + DB 失败 -> newEpoch 被跳过，下一次从更高值开始，安全
先写 DB、后写文件：
  PITR 回滚 DB 后可能重用 tokenEpoch，不安全
```

DB sequence 必须 `setval` 到 newEpoch，否则下一次 acquire 可能拿到更低值。

### 6.4 失败关闭

bump 或 fence 失败：

```text
control-plane 进入全局 maintenance
拒绝 acquire
拒绝 catalog 下发
主动 fence 现有 lease
发布 VALUE_INVALIDATE / FENCED
告警
```

不能只拒绝新 acquire；旧 engine 必须停止发布。
risk/order gateway 在 `tokenEpoch`/`catalogEpoch` 不匹配时统一拒绝新开仓，平仓保留。

### 6.5 PITR

PITR 是独立触发条件：

```text
PITR 后即使 catalogEpoch 相同，也 bump tokenEpoch
策略本地保存 lastTokenEpoch
重连时拒绝更低 tokenEpoch
不能只依赖 VALUE_INVALIDATE 消息
```

### 6.6 Schema

`indicator_catalog_state` 增加：

```text
token_epoch_bumped_for TEXT NOT NULL DEFAULT ''
restore_generation     BIGINT NOT NULL DEFAULT 0
```

control-plane 启动校验：

```text
token_epoch_bumped_for == current catalogEpoch
AND restore_generation == external restore marker
否则先 bump/fence，再提供服务
```

PITR 到同一 catalogEpoch 时，restore_generation 会变化，从而触发 bump。

## 7. Acceptance Tests

```text
R1:
  - PREPARED 后崩溃 -> 同 applyId 续跑
  - replay 中崩溃 -> 不生成新 applyId
  - state durable 前 APPLIED -> 恢复时重建
  - APPLIED 但 State 缺失 -> 强制重建
  - journal 尾部不完整 -> 截断到最后完整 offset
  - 中间 CRC 错误 -> fail closed
  - latest 按 offset 不按 mtime
  - checkpoint 不越过 PREPARED

R2:
  - 42 -> 43 时队列和 live buffer 都有 pre-cut tick
  - 新 indicator 不接收 pre-cut tick
  - 旧 plan drain 后才释放
  - publisher 重启 seq=1 不被当重复
  - 所有 indicator seq 无重复/缺口

R3:
  - producer 不做 DB I/O，engine 不做历史 DB 写
  - 队列满时 latest generation 不丢，不阻塞 tick
  - control-plane consumer 落后时 persistLagMs 告警
  - heartbeat 独立于 DB
  - 策略 gate 不依赖 DB 实时性

R4:
  - 两个 engine 分配不同 replay stream
  - 同 engineId 重启，旧 replayEpoch/session 被拒绝
  - 无 9001 共用
  - slot 释放 DRAINING -> RECLAIMABLE
  - slot 耗尽 -> NO_SLOT

R5:
  - catalogEpoch 变化 -> tokenEpoch bump
  - PITR 同 epoch 也 bump
  - bump + fence 同事务
  - 旧 engine lease 失效，旧值被拒
  - bump 失败 -> maintenance + FENCED
  - high-water 缺失 -> fail closed

## 8. Non-goals

```text
不实现生产 Java 代码
不迁移 shadow DB
不改变 ADR-001 D1-D6 和 ADR-002 P1-1..P1-8
不解决交易策略/CTP 问题
```

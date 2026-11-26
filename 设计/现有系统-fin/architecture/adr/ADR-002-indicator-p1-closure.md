# ADR-002 指标生产 P1 收口

- 状态：**APPROVED — 8 个 P1 协议决策；生产实现待计划**
- 日期：2026-11-12
- 范围：ADR-001 §10 列出的 8 个 P1
- 关联：
  - `docs/architecture/adr/ADR-001-indicator-replay-contract.md`
  - `docs/reviews/2026-11-12-adr-002-p1-review.md`
  - `docs/architecture/27-指标目录与Agent内存热加载.md`（P0 已由 ADR-001 取代）
  - `tools/db/schema-indicator-v2.sql`
  - `docs/reviews/2026-11-12-indicator-catalog-architecture-review-v6.md`

> 本 ADR 只关闭 P1 协议决策，不实现生产代码。
> schema 仍是 debug/shadow 基线；生产迁移和 Java 实现另开计划。

## 1. Decision Summary

| # | P1 | 决策 |
|---|---|---|
| P1-1 | READY/RouteIndex 生命周期 | APPLIED 即进入 RouteIndex（routable=false）；READY 只控制可交易性 |
| P1-2 | ACK retryable/final | `REJECTED_RETRYABLE` / `REJECTED_FINAL` 两态；同 requestId 单调 UPSERT |
| P1-3 | 控制面 PRODUCER_LOST | 独立 `source=CONTROL` + `status_rank`，不受 producer seq guard 拒绝 |
| P1-4 | outbox 粒度 | 一行一个 catalog delta；events 放 payload；`(counterparty, catalog_version)` 唯一 |
| P1-5 | Archive roll/gap/active | roll 由控制面/独立 timer 负责；gap 独立表；active 永不 purge |
| P1-6 | history 分区 | 月分区 + 预建未来 2 个月；retention 只 detach/drop 命名分区 |
| P1-7 | operator codeHash | catalog 携带 codeHash；engine 校验；seed 不再写空 hash |
| P1-8 | T-058 | 归档旧 PRIVATE/STRATEGY_GROUP 方案，不再作为实现依据 |

## 2. P1-1：READY / RouteIndex 生命周期

### 决策

```text
CREATED
  -> APPLIED        catalog/state 已建立，RouteIndex 已插入，routable=false
  -> WARMUP         warmup 进行中，RouteIndex 仍 routable=false
  -> READY          warmup 完成，RouteIndex 条目 routable=true
  -> ACTIVE         首个 OK 值已发布；UI/指标状态
  -> STOPPED        删除/禁用/retention 墓碑
  -> FAILED         operator/schema/state 错误
```

关键顺序：

```text
1. 应用 catalog delta
2. 创建 State
3. 插入 RouteIndex（routable=false）
4. ACK APPLIED
5. warmup
6. 标记 READY / routable=true
7. ACK READY（同一个 requestId 的单调状态）
8. 首个 OK 值 -> ACTIVE
```

这样不会死锁：

```text
RouteIndex 插入不依赖 ACK READY
ACK READY 只表示 warmup 完成
```

策略 gate：

```text
READY + routable + latest.status=OK -> 允许新开仓
APPLIED / WARMUP / READY 但 latest 非 OK -> 禁止新开仓
平仓不受 gate 限制
```

`READY` 与首个 `OK` 之间仍可能有一个很短的窗口；gate 必须同时检查
`latest.status=OK`，不能只看 READY/routable。

RouteIndex 是内存结构，重建来源：

```text
catalog snapshot + applyCut/LKG
重建时先 routable=false
warmup/ready 完成后恢复 routable=true
```

删除/禁用：

```text
从 RouteIndex 移除
写入 STOPPED 墓碑
不删除 State 直到 retention
```

## 3. P1-2：ACK REJECTED_RETRYABLE / FINAL

### 状态

```text
APPLIED
READY
REJECTED_RETRYABLE
REJECTED_FINAL
```

不再使用 `retryable=true/false` 与 `REJECTED` 组合。

### 语义

```text
REJECTED_RETRYABLE
  -> 临时原因：snapshot 未就绪、archive lag、lease 暂时不可用
  -> 控制面可以重发同一 requestId
  -> engine 可以 UPSERT 为 APPLIED

REJECTED_FINAL
  -> 永久原因：operator codeHash/schemaHash 不匹配、catalog 非法、key 冲突
  -> 同一 requestId 不允许再升级
  -> 必须人工修复后生成新 requestId
```

### 幂等

```text
UNIQUE (engine_id, request_id)
同一 requestId 只更新状态，不插入第二行
状态单调：
  REJECTED_RETRYABLE(1) -> APPLIED(2) -> READY(3)
  REJECTED_FINAL(4) 终态
```

不建议把 status 放进 requestId；requestId 表示一次 apply 尝试，状态是结果。

schema 必须增加：

```text
status_rank  SMALLINT
  REJECTED_RETRYABLE=1
  APPLIED=2
  READY=3
  REJECTED_FINAL=4
```

UPSERT 条件：

```sql
ON CONFLICT (engine_id, request_id) DO UPDATE
SET status = EXCLUDED.status,
    error_code = EXCLUDED.error_code,
    error_detail = EXCLUDED.error_detail
WHERE indicator_catalog_ack.status <> 'REJECTED_FINAL'
  AND (CASE EXCLUDED.status
         WHEN 'REJECTED_RETRYABLE' THEN 1
         WHEN 'APPLIED' THEN 2
         WHEN 'READY' THEN 3
         WHEN 'REJECTED_FINAL' THEN 4
       END) >= indicator_catalog_ack.status_rank
```

`REJECTED_FINAL` 之后只允许 `REJECTED_FINAL`，不能升级为 APPLIED/READY。
同一 requestId 的 `catalog_epoch/catalog_version/target` 不可变；target 不一致直接拒绝。

## 4. P1-3：控制面 PRODUCER_LOST

### 问题

lease sweeper 写 `PRODUCER_LOST` 时没有新的 producer seq；如果复用 producer 的
`(tokenEpoch, fencingToken, seq)` guard，控制面写入会被拒绝。

### 决策

`indicator_latest` / `indicator_value_history` 增加：

```text
source       PRODUCER | CONTROL
status_rank  OK=1, WARMUP=2, STALE=3, NO_DATA=4, PRODUCER_LOST=5, STOPPED=6
```

控制面写入：

```text
source = CONTROL
seq = 0
token_epoch = 当前 lease.token_epoch
fencing_token = 当前 lease.fencing_token
status = PRODUCER_LOST
```

Guard：

```sql
-- producer write
UPDATE indicator_latest
SET ...
WHERE indicator_id = :id
  AND (
    (:tokenEpoch > token_epoch)
    OR (:tokenEpoch = token_epoch AND :fencingToken > fencing_token)
    OR (:tokenEpoch = token_epoch AND :fencingToken = fencing_token
        AND :seq > seq)
  )
  AND NOT (
    status IN ('PRODUCER_LOST', 'STOPPED')
    AND :tokenEpoch = token_epoch
    AND :fencingToken = fencing_token
  );
```

即：一旦进入 `PRODUCER_LOST` / `STOPPED`，**同一个 (tokenEpoch, fencingToken) 的旧 producer
不能靠更高 seq 复活**，必须获得新的 epoch/fencing。

```sql
-- control write
UPDATE indicator_latest l
SET status = 'PRODUCER_LOST',
    source = 'CONTROL',
    seq = 0,
    invalidated_at = now()
WHERE l.indicator_id = :id
  AND EXISTS (
    SELECT 1 FROM indicator_lease lease
    WHERE lease.counterparty_id = :counterpartyId
      AND lease.owner_engine_id = :lostEngine
      AND lease.token_epoch = :tokenEpoch
      AND lease.status IN ('EXPIRED', 'FENCED')
  )
  AND l.status_rank <= 5;
```

CONTROL 不能覆盖 ACTIVE lease 的新 producer，也不能把坏状态改回 OK。

schema 约束：

```text
status_rank 必须与 status 绑定：
  OK=1, WARMUP=2, STALE=3, NO_DATA=4, PRODUCER_LOST=5, STOPPED=6
source=CONTROL 才能写 PRODUCER_LOST/STOPPED
producer 写不能出现 source=CONTROL
```

新 producer 获得更高 tokenEpoch/fencingToken 后，可以重新发布 OK/WARMUP，
这是唯一允许“从坏状态恢复”的路径。

### 一致性

同事务更新：

```text
indicator_latest
indicator_value_history（status 带 event_as_of 或 invalidated_at）
```

控制面写 latest 与 history 必须使用同一个 `source=CONTROL` 和 `status_rank`。

## 5. P1-4：outbox per-delta

### 决策

一行一个 catalog delta，不是一行一个 event：

```text
indicator_catalog_outbox
  id
  counterparty_id
  catalog_epoch
  catalog_version
  event_type       SNAPSHOT | DELTA
  event_count
  checksum          sha256 hex
  operator_set_hash sha256 hex
  payload_json     { operators:[...], operatorSetHash, events:[...] }
  payload_jcs      BYTEA（RFC 8785 canonical bytes）
  payload_sha256   sha256 hex
  status           PENDING | PUBLISHED | APPLIED | FAILED
  attempts
  next_retry_at
  publish_lease_until
  last_error
```

唯一键保持：

```text
UNIQUE (counterparty_id, catalog_version)
```

`events[]` 内部顺序固定，按 `indicator_id` 排序；`payload_jcs` 是重发/校验的权威字节，
不能从 JSONB 重新序列化后假设字节一致。

### ACK 关联

```text
target_type = DELTA | SNAPSHOT
delta_id    = BIGINT REFERENCES indicator_catalog_outbox(id)（target_type=DELTA）
snapshot_id = TEXT（target_type=SNAPSHOT）
```

CHECK 必须保证：

```text
target_type=DELTA  -> delta_id NOT NULL AND snapshot_id IS NULL
target_type=SNAPSHOT -> snapshot_id NOT NULL AND delta_id IS NULL
```

不再使用 per-event `indicator_id` 作为 outbox 行的唯一依据。
单条 indicator 的查询可以走 payload/索引，但不改变投递粒度。

### 重试

```text
PENDING -> PUBLISHED -> APPLIED
        -> FAILED -> PENDING（next_retry_at）
```

`PUBLISHED` 必须带 `publish_lease_until`；超时未 ACK 回到 `PENDING`，并增加 attempts。
`FAILED` 不删除；超过阈值告警。重复发送是幂等的，以 ACK requestId 去重。

## 6. P1-5：Archive roll / gap / active retention

### Owner

1001 roll 由**控制面/独立 timer**负责，不由 IndicatorEngine 负责。
时点由交易日历驱动；15:00/02:30 只是默认提示，不能写死为自然时间。

roll 动作：

```text
1. 停止 recorder 对 1001 的录制
2. 写/确认 indicator_archive_segment STOPPED
3. 重启 recorder，产生新 recordingId
4. 写新 segment ACTIVE
```

roll 期间行情不能丢；若无法无缝切换，按 gap 处理并进入 WARMUP。
必须处理两种恢复态：

```text
recorder 已停，但 segment 仍 ACTIVE
segment 已 STOPPED，但 recorder 未停
```

### Gap

新增独立表：

```text
indicator_archive_gap (
  gap_id,
  stream_id,
  session_id,
  previous_recording_id,
  next_recording_id,
  gap_start_position,
  gap_end_position,
  detected_at,
  status OPEN/CLOSED,
  reason,
  closed_at
)
```

不用 `recording_id` 表示 gap；gap 可能没有 recording。
`indicator_archive_segment.status` 不允许 `GAP`，gap 只存在于此表。

唯一与一致性：

```text
UNIQUE (stream_id, session_id, gap_start_position, gap_end_position)
CHECK ((status='CLOSED') = (closed_at IS NOT NULL))
```

检测来源：

```text
previous_recording.stop_position != next_recording.start_position
session/epoch change
missing recording chain
active recording age > threshold
```

gap 覆盖 warmup 所需区间 -> WARMUP，不能静默跳过。

### Active

```text
每个 stream 只能有一个 ACTIVE segment
CREATE UNIQUE INDEX ... ON indicator_archive_segment(stream_id)
  WHERE status='ACTIVE'
```

### Retention

```text
active recording 永不 purge
STOPPED 且无 warmup/artifact/snapshot 引用才可 purge
purge 前写 audit
```

新增引用表：

```text
indicator_archive_ref(
  recording_id,
  ref_type,   -- WARMUP | SNAPSHOT | APPLY_CUT | MANUAL
  ref_id,
  created_at,
  PRIMARY KEY (recording_id, ref_type, ref_id)
)
```

`ArchiveRetentionTool` 已跳过 active；生产还必须：

```text
--stream 1001 filter
--protected-file <recording-id list>（由引用表导出，apply 时必填）
active age alert
```

`--apply` 缺少 protected file 时必须拒绝执行，不能按时间盲删。

## 7. P1-6：history 分区

### 分区

```text
indicator_value_history PARTITION BY RANGE (event_as_of)
```

按自然月分区：

```text
indicator_value_history_YYYYMM
```

预建：

```text
当前月 + 未来 2 个月
```

`default` 分区保留作为安全网，但不能成为长期唯一分区。

### 时区

分区边界固定使用 UTC：

```text
SET LOCAL TimeZone = 'UTC'
date_trunc('month', now()) 也按 UTC
```

`event_as_of` 的存储/交换语义必须与分区时区一致；不能用本地时区的月初切 UTC 数据。

### default 分区

如果某月漏跑 ensure，数据落入 default 后，PostgreSQL 不允许直接补该月分区。
`ensure` 必须：

```text
1. 创建前检查 default 分区是否已有目标月数据
2. 有数据 -> 抛出带 runbook 的异常，不做隐式迁移
3. 运维按 runbook 把 default 行迁入临时表/新分区后再 attach
```

不能静默跳过，也不能让默认分区长期承载生产数据。

### Retention

```text
只 detach/drop 命名月度分区
不 DELETE 明细
default 分区不自动 drop
drop 前检查依赖/导出
drop 前写 audit
```

保留期：

```text
默认 400 天（覆盖 1d 年线）
tick/1s 可单独配置更短
```

`drop(cutoff)` 必须：

```text
cutoff <= 当前月头
只 drop 整月都早于 cutoff 的分区
记录分区名、行数、min/max event_as_of、调用者、时间
```

### Seq 去重

分区表的唯一索引必须包含分区键，不能直接实现
`(indicator_id, producer_epoch, token_epoch, seq)` 全局唯一。
新增非分区 dedupe 表：

```text
indicator_value_history_seq (
  indicator_id,
  producer_epoch,
  token_epoch,
  seq,
  event_as_of,
  PRIMARY KEY (indicator_id, producer_epoch, token_epoch, seq)
)
```

producer 写 history 的同一事务先插 dedupe，再插 history；重复 seq 直接拒绝。

新增 `tools/db/indicator-history-partitions.sql`，提供：

```text
ensure_indicator_history_partitions(months_ahead)
drop_indicator_history_partitions_before(cutoff)
```

## 8. P1-7：operator codeHash

### 定义

```text
schema_hash = sha256(canonical params schema)
code_hash   = sha256("qlink-operator-v1\n" + code + "\n" + version + "\n" + artifact_sha256)
operatorSetHash = sha256(join("\n", sorted(
  code + "@" + version + ":" + codeHash + ":" + schemaHash)))
```

`artifact_sha256` 是 operator 编译产物（class/JAR 或签名 build manifest）的字节 hash，
不是源码拼接，也不是参数 hash。构建方必须把 artifact hash 写进 operator manifest；
control-plane 与 engine 使用同一 manifest，不能各自重新计算。

### Catalog

Snapshot/Delta 的 `payload_json` 必须包含：

```json
{
  "operators": [
    {"code":"EMA","version":1,"schemaHash":"...","codeHash":"..."}
  ],
  "operatorSetHash":"sha256(...)",
  "events": [ ... ]
}
```

`operator_set_hash` 是独立列，非空且必须是 64 位小写 hex；`checksum` 同样。
Engine 启动/应用 catalog 时校验：

```text
operator 存在
schemaHash 匹配
codeHash 匹配
operatorSetHash 匹配
```

不匹配：

```text
ACK REJECTED_FINAL
error_code=OPERATOR_CODE_MISMATCH / OPERATOR_SCHEMA_MISMATCH
```

### Bootstrap

空 `indicator_operator` + FK 要求明确的初始化顺序：

```text
1. 构建时生成 operator manifest（含真实 hash）
2. control-plane 启动读取 manifest，UPSERT indicator_operator
3. 只有 operator 注册完成后才允许 catalog CREATE/DELTA
4. debug 环境同样走 manifest，不再插入空 hash seed
```

如果 manifest 缺失：

```text
control-plane 启动失败并告警
不要以空 hash/空 operator 表继续接单
```

未注册时 catalog CREATE -> OPERATOR_NOT_FOUND。
`indicator_operator` 增加非空/格式约束，禁止空 hash 进入 ACTIVE。

## 9. P1-8：T-058 清理

### 决策

T-058 中以下内容全部归档，不实施：

```text
PRIVATE / STRATEGY_GROUP
indicator_defs.strategy_id 私有归属
旧 indicator_values / indicator_daily_history 迁移
“每个策略 Runner 自己算私有指标”
```

T-058 文件保留一个短 ARCHIVED 说明，正文旧模型不再作为实现依据。
历史内容留在 git history，不在工作区继续误导实现。

## 10. Schema Changes

本 ADR 对应的 debug schema 修改：

```text
indicator_operator
  schema_hash / code_hash 非空格式约束；删除空 seed

indicator_catalog_outbox
  event_type SNAPSHOT|DELTA
  catalog_epoch / checksum / operator_set_hash / event_count / last_error
  一行一个 delta

indicator_catalog_ack
  status 增加 REJECTED_RETRYABLE / REJECTED_FINAL
  删除 retryable 布尔

indicator_latest / indicator_value_history
  status 增加 PRODUCER_LOST
  source / status_rank
  CONTROL 写入 guard

indicator_archive_gap
  新增 gap 表

indicator_value_history
  月分区维护脚本
```

## 11. Acceptance Tests

```text
1. APPLIED 已进入 RouteIndex，但策略 gate 仍拒绝新开仓；只有 READY + routable + latest.status=OK 才允许。
2. 同一 requestId 从 REJECTED_RETRYABLE -> APPLIED -> READY 单调；FINAL 不再升级。
3. 控制面 PRODUCER_LOST 不被 producer seq guard 拒绝；新 epoch producer 可恢复 OK。
4. 一个 catalog delta 只产生一行 outbox；重发字节一致；ACK 幂等。
5. 1001 roll 后新 recording segment；gap 表记录缺口；active 不被 retention。
6. 跨月写入落对应月分区；retention 只 drop 命名分区。
7. operator codeHash 为空/不匹配 -> REJECTED_FINAL，不进入 RouteIndex。
8. T-058 不再出现 PRIVATE/STRATEGY_GROUP 实施步骤。
```

## 12. v6 P1 closed by ADR-003

本 ADR 只处理 ADR-001 §10 的 8 个 P1。v6 §4 另有 5 项，已由 `ADR-003` 收口：

```text
P1-R1 applyCut journal 路径/格式/CRC/恢复进度
P1-R2 tick 工作项 apply 时按 indicatorId 重路由，pre-cut tick 可能重复
P1-R3 VALUE_ENGINE_STATE 发布线程未独立
P1-R4 9001 仍写单数，未定义 per-engine stream/channel 分配
P1-R5 catalogEpoch 变化未保证 tokenEpoch bump
```

因此 v6 §4 的 15 个 P1 现在全部有协议决策；生产实现仍需单独计划。

## 13. Non-goals

```text
不实现生产 Java 代码
不迁移 shadow DB
不改变 ADR-001 的 D1-D6 决策
不解决 P0 以外的交易策略问题
```

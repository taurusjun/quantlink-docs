# 27. 指标目录与 Agent 内存热加载设计

- 日期：2026-11-12
- 状态：**SUPERSEDED（P0 协议）— 保留为设计背景**
- 评审记录：`docs/reviews/2026-11-12-indicator-catalog-architecture-review.md`
- 替代文档：`docs/architecture/adr/ADR-001-indicator-replay-contract.md`（APPROVED，D1 golden PASS）
- P1 协议：`docs/architecture/adr/ADR-002-indicator-p1-closure.md`（APPROVED）
- 关联：
  - `docs/tasks/T-058-indicator-producer-ownership.md`
  - `docs/architecture/24-实时推送与Agent计算边界.md`
  - `quantlink-trading/docs/architecture/tbsrc-indicator-calculation.md`（旧 C++ 仓库参考，不是 V2 组件）

> **状态更新（2026-11-12）**：本文的 6 个 P0 协议决策
> （position、live barrier、tokenEpoch、seq、snapshot/warmup、1d barCut）
> 已由 `ADR-001` 取代并通过定向复审；D1 真实 Archive 最后一帧 golden 已 PASS。
>
> 本文不再作为生产实施基线。生产实现以 ADR-001 为准；
> ADR-001 §10 列出的 P1 仍需在生产计划中处理或明确排除。
>
> 历史说明：T-058 中 `PRIVATE / STRATEGY_GROUP` 的段落是历史方案，V1 不实现；
> doc 24 中“控制面计算全局指标”的描述在调试重置后废弃。

## 0. V1 范围与假设

本版采用以下范围，未确认前不得按其他范围实现：

```text
1. 指标必须绑定 counterparty，不存在全局指标。
2. 同柜台所有指标共享，不存在策略私有指标。
3. pair 指标允许同柜台、同交易所的多合约输入，所有同柜台策略可选择。
4. V1 包含 OPT 期权链指标，但只支持同柜台、同交易所的期权链。
5. V1 不支持指标依赖指标；多输入由单个 operator 内部完成。
6. V1 不支持跨柜台 pair，也不支持跨交易所 pair。
7. V1 不支持任意表达式/代码热加载；新增 operator 代码仍需发布。
8. V1 一个 counterparty 只有一个 active producer；没有备用 ORS，也没有 standby engine。
   故障时 fail-closed，重启/恢复后重新获得 lease 和新 epoch。
9. IndicatorEngine 运行期不读指标数据库；DB 只在管理面和控制面目录构建中使用。
10. V2 只有 Java control-plane / runtime-agent / strategy-runner；不包含 C++ tbsrc。
    tbsrc 只存在于旧仓库 `quantlink-trading`，是设计参考，不是 V2 运行时组件。
    不建设 C++ 指标 bridge，也不存在第二套 writer。
11. 当前为调试阶段：允许直接删除旧 indicator 表，不做兼容、不做 ID/历史迁移。
    重置脚本：`tools/db/schema-indicator-v2.sql`。
12. Aeron Archive 已录制行情 stream 1001；tick/1s 状态恢复使用 Archive replay 到专用 stream。
    Archive 不足或 recording 有缺口时保持 WARMUP。
```

如果后续要突破其中任何一条，必须提升 key schema 版本并重新评审。

## 1. 结论

```text
IndicatorEngine = 版本化指标目录 + 内存计算引擎 + KV
控制面          = 指标配置 + 校验 + 版本 + 下发
数据库  = 管理面存储 + 历史 + 审计
策略    = 按不透明 indicatorId 读值
```

四个核心决策：

```text
指标身份用不透明 hash
CatalogPlan 不可变，State 由 producer 单线程独占
每柜台一个 active producer + lease + epoch/fencing
warmup 由 catalog 携带 warmupRef，IndicatorEngine 本地缓存
```

## 2. 术语

| 术语 | 定义 |
|---|---|
| `Operator` | 代码里的运算函数，例如 EMA、PAIR_SPREAD、OPT_ATM_IV |
| `IndicatorSpec` | 一条指标配置，属于某个 counterparty |
| `IndicatorState` | 某个 key 的可变计算状态，只由 producer 线程读写 |
| `IndicatorValue` | 对外发布的不可变值快照 |
| `Catalog` | 某个 counterparty 的全量指标目录 |
| `CatalogPlan` | IndicatorEngine 内由 Catalog 编译出的不可变路由计划 |
| `ValueKV` | IndicatorEngine 内 `indicatorId -> IndicatorValue` 的内存表 |
| `Producer` | 某个 counterparty 的指标计算引擎实例 |
| `ProducerEpoch` | producer 每次启动/重启的唯一 epoch |
| `FencingToken` | 单调递增的租约令牌，用于拒绝旧 producer |
| `Agent` | runtime-agent supervisor；对应一个 ACTIVE ORS 和一个 counterparty |
| `IndicatorEngine` | 与 ORS 同机的独立指标进程，单 writer，不是 ORS，也不登录 CTP |
| `Runtime Agent` | 部署单元 supervisor，负责拉起 ORS、IndicatorEngine 和策略 Runner |
| `StrategyBinding` | 策略对某个 indicatorId 的引用 |

## 3. 四层对象

```text
Operator          代码，不可热加载
IndicatorSpec     配置，可热加载
IndicatorState    运行状态，producer 独占
IndicatorValue    对外值，不可变
```

### 3.1 Operator

```java
public interface IndicatorOperator {
    String code();
    int version();

    OperatorSchema schema();

    void validate(IndicatorSpec spec);

    IndicatorState createState(IndicatorSpec spec);

    void onTick(IndicatorState state, MarketEvent event, Emit emit);

    void onTimer(IndicatorState state, TimerEvent event, Emit emit);

    StateSnapshot snapshotState(IndicatorState state);

    void restoreState(IndicatorState state, StateSnapshot snapshot);

    void closeState(IndicatorState state);

    FreshnessPolicy freshnessPolicy(IndicatorSpec spec);

    long maxStateBytes(IndicatorSpec spec);
}
```

`OperatorSchema` 至少声明：

```text
params/defaults/ranges
allowedFields
orderedInputs
legFieldsMayDiffer
stateDependency
warmupRequired(spec)
archiveReplayRequired(spec)
maxRecoveryGap(spec)
freshness
maxStateBytes
schemaHash
```

`stateDependency`：

```text
LATEST_ONLY   只需要最新值
WINDOWED      需要窗口内事件
CUMULATIVE    需要从起点累计
BAR           需要完整 bar
```

OperatorSchema 还要声明：

```text
initialReplayLookback(spec)  新指标需要回看多久
maxReplaySpan(spec)          单次 replay 最大跨度
warmupRequired(spec)         是否必须有历史
```

恢复策略由 `stateDependency` 决定，不能用一个全局“tick 是否 replay”开关。

`StateSnapshot`、`TimerEvent`、`Emit`、`FreshnessPolicy` 是框架类型，不由业务代码自定义序列化格式。

新增或修改 operator 代码必须发布新版本。
OperatorRegistry 必须保留所有仍被 `strategy_indicator_binding` 引用的版本，不能只保留 N/N-1 后直接删除旧 key。

权威关系：

```text
Java OperatorRegistry = 权威
indicator_operator 表 = DB 投影/查询索引
Catalog Builder 启动/发布前 upsert code/version/schema_hash/code_hash
IndicatorEngine 校验 schemaHash/codeHash，不匹配 -> OPERATOR_SCHEMA_MISMATCH
```

不能由 DB 中的 operator 投影反向决定 Java 代码行为。

### 3.2 IndicatorSpec

不可变语义对象：

```json
{
  "indicatorId": "ik1_9k3m7q2v8r5t1w4x6y0z2abcde",
  "keySchemaVersion": 1,
  "counterpartyId": "SIMNOW",
  "operatorCode": "EMA",
  "operatorVersion": 1,
  "inputs": [
    {
      "type": "instrument",
      "counterpartyId": "SIMNOW",
      "exchange": "SHFE",
      "instrument": "au2612",
      "field": "last"
    }
  ],
  "params": {"period": 13},
  "timeframe": "1m",
  "displayName": "EMA(au2612, 13, 1m) @ SIMNOW",
  "displayKey": "EMA(au2612, period=13, field=last, tf=1m, v1) @ SIMNOW #9k3m7q2v",
  "warmupRef": "warmup://SIMNOW/ik1_.../v1",
  "enabled": true
}
```

约束：

- `counterpartyId` 必填。
- V1 所有 `inputs` 必须属于同一个 counterparty。
- pair 的所有 inputs 必须属于同一个 counterparty 和同一个 exchange。
- `displayName` 不参与身份。
- `params` 是结构化参数，不是字符串。
- `timeframe` 使用枚举：`tick / 1s / 1m / 5m / 1d`。

### 3.3 IndicatorState

```text
IndicatorState
  ├─ 输入 bar / 窗口 / EMA 状态
  ├─ 当前 bar 聚合
  ├─ warmup 计数
  ├─ lastInputAsOf
  ├─ lastEventAsOf
  └─ operator 私有状态
```

规则：

- 只允许 producer 线程访问。
- 不进入 `CatalogPlan`。
- 不通过 HTTP/WS 暴露。
- 同 key 在热加载时 carry-over。
- 语义变化生成新 key，旧 key 的 state 不迁移。
- 删除/禁用时由 producer 线程执行 `closeState`。

### 3.4 IndicatorValue

```java
record IndicatorValue(
    String indicatorId,
    Double value,                 // NO_DATA 时为 null，禁止用 0 冒充
    IndicatorStatus status,
    StatusReason reason,
    long eventAsOf,               // 数据/bar 的业务时间
    long lastInputAsOf,           // 最后一次输入的 tick 时间
    long publishedAt,             // 写入 KV 的本地时间
    TimeSource timeSource,        // EXCHANGE / LOCAL / BAR_CLOSE
    long nextExpectedAt,          // 用于 stale sweep
    Long removedAt,               // STOPPED 墓碑时间
    Long invalidatedAt,           // PRODUCER_LOST 失效时间
    long seq,
    String producerId,
    String producerEpoch,
    long tokenEpoch,
    long fencingToken,
    String catalogEpoch,
    long catalogVersion,
    int keySchemaVersion
) {}
```

状态：

```text
OK
WARMUP
STALE
NO_DATA
STOPPED
```

状态优先级：

```text
STOPPED > NO_DATA > WARMUP > STALE > OK
```

`reason` 至少包含：

```text
NO_TICK
NOT_SUBSCRIBED
WARMUP_INSUFFICIENT
INPUT_STALE
PRODUCER_LOST
DISABLED
REMOVED
```

## 4. 指标身份 key

### 4.1 不透明 ID

`indicatorId` 是唯一身份，不使用可读串：

```text
ik1_<crockford-base32-lower(sha256(canonicalSpecJcs))[0:26]>
```

示例：

```text
ik1_9k3m7q2v8r5t1w4x6y0z2abcde
```

规则：

- 使用 RFC 8785 JCS 序列化 canonical JSON。
- 使用 SHA-256。
- 使用 Crockford Base32 小写字母表，固定 26 个字符（130 bit）。
- 数据库中另存完整 `spec_hash`（SHA-256 hex）用于碰撞检测。
- `ik1_` 后只包含 Crockford Base32 子集 `[0-9a-hjkmnp-tv-z]`，固定 26 位，适合 URL、日志、DB 主键。
- 不使用 `v1|SIMNOW|...` 作为身份，因为它含 `|`、`,`、`=`。

### 4.2 canonicalSpec

hash 输入是 canonical JSON：

```json
{
  "keySchemaVersion": 1,
  "counterpartyId": "SIMNOW",
  "operatorCode": "EMA",
  "operatorVersion": 1,
  "timeframe": "1m",
  "inputs": [
    {
      "type": "instrument",
      "counterpartyId": "SIMNOW",
      "exchange": "SHFE",
      "instrument": "au2612",
      "field": "last"
    }
  ],
  "params": {"period": 13}
}
```

期权链 input 的 key 只包含 selector tuple：

```json
{
  "type": "option_chain",
  "counterpartyId": "SIMNOW",
  "exchange": "SHFE",
  "underlying": "au2612",
  "expirySelector": {"type": "nearest", "minDays": 7},
  "strikeSelector": {"type": "delta_range", "minDelta": "0.05", "maxDelta": "0.95"},
  "callPut": "both",
  "field": "mid"
}
```

`chainSnapshotId` 和 `resolvedContracts` 是 catalog 派生元数据，不进 key。

规范化规则：

1. `operatorCode`、`exchange`、`counterpartyId` 使用主数据规范值，当前约定为大写。
2. `instrument` 使用合约主数据 ID，不自行改大小写。
3. `timeframe` 使用小写枚举：`tick / 1s / 1m / 5m / 1d`。
4. 参数类型由 OperatorSchema 固定：
   - `INTEGER` -> JSON integer，`13.0` 归一为 `13`
   - `DECIMAL` -> canonical decimal string，先 `stripTrailingZeros`，不用 JSON float
   - `ENUM` -> 小写枚举
   - `BOOLEAN` -> `true/false`
5. 布尔值只允许 `true/false`。
6. 字符串做 NFKC、trim、连续空白归一；大小写是否敏感由参数 schema 决定。
7. 参数顺序按 operator schema 固定，不依赖 JSON map 顺序。
8. 默认值合并为 effective params，key 使用 effective params。
9. input 顺序：
   - `orderedInputs=true` 的 operator（如 PAIR_SPREAD）保留顺序。
   - `orderedInputs=false` 的 operator 按输入身份 tuple 排序后参与 hash。
   - 重复 input 拒绝。
10. 每个 input 必须包含 `field`；不同 leg 可以使用不同 field。
11. 禁止把 `displayName`、`displayKey`、颜色、阈值、`enabled`、`warmupRef`、策略 ID、producer ID 放入 key。
12. 只使用一个版本字段 `keySchemaVersion`；不再保留 `"schema"` 别名。
13. canonical bytes 由 RFC 8785 JCS 序列化器一次生成，写入 `indicator.spec_canonical`。
14. `indicator.spec_json` 只是查询投影；Engine/Catalog Builder 不得从 JSONB round-trip 重算 `indicatorId`。
15. 生成 key 必须使用固定的 golden vectors 做 byte-level 对比。

### 4.3 显示名和唯一显示键

`displayName` 是人读标签，允许重复或省略版本信息：

```text
EMA(au2612, 13, 1m) @ SIMNOW
PAIR_SPREAD(au2612, ag2612, ratio=0.82) @ SIMNOW
OPT_ATM_IV(au2612, 1m) @ SIMNOW
```

`displayKey` 是唯一显示键，必须包含所有身份维度：

```text
EMA(au2612, period=13, field=last, tf=1m, v1) @ SIMNOW #9k3m7q2v
PAIR_SPREAD(au2612, field=last, ag2612, field=mid, ratio=0.82, tf=1m, v1) @ SIMNOW #7r5t1w4x
```

规则：

- 唯一约束：`(counterparty_id, display_key)`。
- `displayName` 不唯一，仅用于 UI。
- `displayKey` 由后端生成，用户不可编辑。
- `displayKey` 始终追加 indicatorId 短 hash，避免 keySchemaVersion/operatorVersion 变化后撞唯一约束。
- `displayKey` 过长时截断可读部分，但保留 hash 后缀。
- 修改 `displayName` 不改变 `indicatorId`/`displayKey`。
- API 路径使用 `indicatorId`，不使用 displayName/displayKey。

### 4.4 重名与复用

```text
canonicalSpec 相同 -> 同一个 indicatorId -> 复用
canonicalSpec 不同但 displayKey 相同 -> 409 Conflict
canonicalSpec 不同但 displayName 相同 -> 允许，UI 增加 tooltip 区分
```

参数变化、operatorVersion 变化、timeframe 变化、input field 变化都生成新 key。

## 5. 总体架构

```text
┌──────────────── Control Plane ────────────────┐
│ indicator DB                                  │
│ Catalog Builder                               │
│ Catalog Outbox                                │
│ Warmup Service                                │
└───────────────────┬───────────────────────────┘
                    │ Catalog Snapshot / Delta
                    │ Catalog ACK
┌───────────────────▼───────────────────────────┐
│ Runtime Agent Supervisor（同一台主机）        │
│                                               │
│  ORS（1 ACTIVE，交易账户执行实例）            │
│  MarketData publisher（柜台行情）             │
│                                               │
│  IndicatorEngine（独立进程，单 writer）       │
│    ├─ CatalogStore（不可变）                  │
│    ├─ StateStore                              │
│    ├─ RouteIndex                              │
│    ├─ SubscriptionManager                     │
│    ├─ TimerService                            │
│    ├─ ValueKV                                 │
│    └─ Local LKG catalog / warmup cache        │
│                                               │
│  Strategy Runner(s)                           │
└───────────────────┬───────────────────────────┘
                    │ 同机 Aeron IPC
          Strategy Runner / Web / Management
```

职责：

```text
控制面：写配置、校验、构建 catalog、发 outbox
Runtime Agent：拉起 ORS / IndicatorEngine / 策略 Runner
IndicatorEngine：加载 catalog、算指标、写 ValueKV、发布
策略：按 indicatorId 读 ValueKV，不计算共享指标
数据库：管理面事实源 + 历史 + 审计
```

## 6. 部署单元与 producer

### 6.1 部署单元

V1 的部署不变量：

```text
1 柜台 = 1 账户 = 1 ACTIVE ORS
1 ACTIVE ORS = 1 Runtime Agent Supervisor
1 Runtime Agent Supervisor = 1 IndicatorEngine 进程
```

进程形态：

```text
runtime-agent（supervisor）
  ├─ ORS / CTP session（唯一 active）
  ├─ MarketData publisher
  ├─ IndicatorEngine（独立进程）
  └─ Strategy Runner(s)
```

IndicatorEngine：

- 与 active ORS 同机；
- 不登录 CTP，不建立第二套交易会话；
- 只消费 ORS/Adapter 的本地行情流；
- 单线程计算；
- 一个 counterparty；
- 一个 active producer；
- 不依赖任何策略 Runner 的生命周期；
- 通过同机 Aeron IPC 发布 ValueKV；
- 崩溃后由 supervisor 在本机重启，ORS/策略不随之重启。

行情流要求：

```text
MarketDataMessage 必须携带 counterpartyId/exchange
或者每个 ORS 使用独立的本地 MD stream
```

不能靠“全局 instrumentId”猜柜台。

V1 没有备用 ORS，也没有 standby engine。
ORS/主机故障时策略 fail-closed；恢复时在同一 ORS/主机上重启。

V1 不允许策略 Runner 内嵌指标计算。

### 6.2 Lease

表：

```sql
indicator_lease (
  counterparty_id   PRIMARY KEY,
  lease_id,
  owner_agent_id,
  owner_engine_id,
  producer_epoch,
  token_epoch,
  fencing_token,
  status,
  expires_at,
  last_renew_at,
  updated_at
)

indicator_lease_token_seq
  -- 独立 DB sequence，分配单调 fencing_token
```

状态机：

```text
ACTIVE -> FENCED / EXPIRED
EXPIRED -> ACTIVE
```

没有 `STANDBY`、`CANDIDATE`、`RESTARTING`：
V1 没有备用 ORS/engine，重启通过 acquire 新 lease 完成。

`fencingToken` 比较使用 `(tokenEpoch, fencingToken)`：
- `tokenEpoch` 在 DB reset/PITR/重建时递增。
- 普通重启只递增 `fencingToken`。
- 消费端先比较 tokenEpoch，再比较 fencingToken。

规则：

- `producer_epoch` 每次启动/重启唯一，不要求可排序。
- `fencing_token` 由 DB sequence 分配，单调递增。
- active 必须周期续约。
- active 续约失败超过阈值 -> 本地自 fence，停止计算，ValueKV 标记 `PRODUCER_LOST`。
- 不自动把指标切到另一个 ORS；恢复必须在同一主机/ORS 上重启。
- 值、ACK、心跳都带 `producerEpoch + fencingToken`。
- 消费端按 `fencingToken` 拒绝旧消息。
- 旧进程恢复后必须被 fence，不能继续写；本地 ValueKV 也必须失效。

### 6.2.1 Lease authority

采用：

```text
控制面 lease 接口 + DB CAS
```

IndicatorEngine 不直接访问数据库，只调用控制面内部接口。

接口：

```text
POST /internal/indicator-leases/{counterpartyId}/acquire
POST /internal/indicator-leases/{counterpartyId}/renew
POST /internal/indicator-leases/{counterpartyId}/release
GET  /internal/indicator-leases/{counterpartyId}
```

#### Acquire

请求：

```json
{
  "agentId": "agent-simnow-01",
  "engineId": "indicator-simnow-01",
  "producerEpoch": "01J...",
  "ttlSeconds": 10
}
```

控制面事务内 CAS：

```sql
UPDATE indicator_lease
SET lease_id = :leaseId,
    owner_agent_id = :agentId,
    owner_engine_id = :engineId,
    producer_epoch = :producerEpoch,
    token_epoch = token_epoch, -- reset/PITR 时由控制面先递增
    fencing_token = nextval('indicator_lease_token_seq'),
    status = 'ACTIVE',
    expires_at = now() + (:ttlSeconds * interval '1 second'),
    last_renew_at = now(),
    updated_at = now()
WHERE counterparty_id = :counterpartyId
  AND (status IN ('EXPIRED', 'FENCED') OR expires_at < now())
RETURNING lease_id, producer_epoch, token_epoch, fencing_token, expires_at;
```

- 更新 1 行：获得 lease。
- 更新 0 行：返回 `409 LEASE_HELD`，engine 不启动计算，保持 fail-closed。
- 首次部署时必须先插入一行 `(counterparty_id, status='EXPIRED', fencing_token=0)`，否则 acquire 永远 0 行。

#### Renew

```sql
UPDATE indicator_lease
SET expires_at = now() + (:ttlSeconds * interval '1 second'),
    last_renew_at = now(),
    updated_at = now()
WHERE counterparty_id = :counterpartyId
  AND lease_id = :leaseId
  AND fencing_token = :fencingToken
  AND status = 'ACTIVE'
  AND expires_at > now();
```

- 更新 0 行：lease 已丢失，engine 立即本地自 fence。
- 续约周期建议为 TTL 的 1/3，例如 TTL 10s、每 3s 续约。

#### Release / Fence

```sql
UPDATE indicator_lease
SET status = 'FENCED',
    updated_at = now()
WHERE counterparty_id = :counterpartyId
  AND lease_id = :leaseId
  AND fencing_token = :fencingToken;
```

正常退出、重启、人工接管前都要显式 release 或等待过期。

#### 控制面不可用

```text
已有 lease 未过期 -> engine 继续计算
续约失败 -> 到 TTL 后本地自 fence
新 engine 启动 -> 无法 acquire -> fail-closed
```

不能因为没有控制面就无限续命。
`fencingToken` 是唯一写入排序依据，`producerEpoch` 只做启动身份和审计。

### 6.3 故障恢复

V1 没有 standby，分两种故障：

#### A. IndicatorEngine 进程崩溃，ORS 仍存活

```text
1. supervisor 发现 engine 进程退出
2. ValueKV 标记 PRODUCER_LOST / STALE
3. 策略继续运行，但禁止新开仓
4. supervisor 在本机重启 IndicatorEngine
5. 通过控制面 lease API 获取新的 lease / epoch / fencingToken
6. 加载 LKG catalog + warmup/stateSnapshot
7. 重新订阅 ORS 的本地行情流
8. 将 ValueKV 原子替换为 NO_DATA/PRODUCER_LOST 占位
9. 进入 ACTIVE，逐 key 恢复 OK
```

ORS、账户、策略不重启。

#### B. ORS / 主机故障

```text
1. 策略 fail-closed
2. IndicatorEngine 停止
3. 指标值标记 PRODUCER_LOST / STALE
4. 同一主机/ORS 恢复后，按顺序重启 ORS、engine、strategy
5. 通过控制面 lease API 重新获取 lease / epoch
6. 加载 catalog + warmup
7. 恢复期间禁止新开仓
```

没有“从备用 ORS 接管”这个动作。
如果同一主机/ORS 无法恢复，交易保持停止并告警，不自动切到其他柜台或 ORS。

## 7. Catalog

### 7.1 版本

```text
catalogEpoch    目录重建代次，DB 恢复/重建时变化
catalogVersion  同一 epoch 内按 counterparty 单调递增
```

规则：

- 版本按 counterparty 独立，不是全局。
- 版本由 DB sequence/outbox 生成，不由应用内存计数器生成。
- `indicator_catalog_outbox (counterparty_id, catalog_version)` 必须唯一。
- `catalogEpoch` 是不透明代次，只比较“是否相同”，不比较大小。
- 同一 epoch 内，低 `catalogVersion` 拒绝；epoch 不同 -> 拉全量 snapshot。
- epoch 变化时清空旧 catalog/plan；State 按新 plan 重建/warmup。
- API 必须带 `counterpartyId`。

### 7.2 Snapshot

```json
{
  "catalogSchemaVersion": 1,
  "catalogEpoch": "01J...",
  "catalogVersion": 42,
  "counterpartyId": "SIMNOW",
  "generatedAt": "2026-11-12T15:00:00+08:00",
  "checksum": "sha256:...",
  "signature": "ed25519:...",
  "keyId": "catalog-key-2026-11",
  "operators": [
    {"code": "EMA", "version": 1, "schemaHash": "..."},
    {"code": "PAIR_SPREAD", "version": 1, "schemaHash": "..."}
  ],
  "indicators": [ ... ]
}
```

### 7.3 Delta

```json
{
  "deltaId": "delta-43",
  "counterpartyId": "SIMNOW",
  "catalogEpoch": "01J...",
  "baseVersion": 42,
  "newVersion": 43,
  "baseChecksum": "sha256:...",
  "checksum": "sha256:...",
  "signature": "ed25519:...",
  "keyId": "catalog-key-2026-11",
  "adds": [ ... ],
  "updates": [ ... ],
  "removes": ["ik1_..."],
  "reason": "user-create",
  "actor": "alice"
}
```

规则：

- `deltaId` 幂等。
- `baseVersion` 必须等于 IndicatorEngine 当前版本。
- `baseChecksum` 必须匹配当前 catalog。
- delta 和 snapshot 都必须有 `signature/keyId`；checksum 只防传输错误。
- 版本跳跃、checksum 不匹配、签名失败都请求全量 snapshot。
- 任一条非法整批拒绝，保留旧 plan。
- 签名 key 轮换必须保留旧 keyId 验证窗口。

### 7.4 ACK

```json
{
  "requestId": "...",
  "deltaId": "delta-43",
  "snapshotId": null,
  "engineId": "indicator-simnow-01",
  "counterpartyId": "SIMNOW",
  "catalogEpoch": "01J...",
  "catalogVersion": 43,
  "status": "APPLIED",
  "appliedChecksum": "sha256:...",
  "operatorSetHash": "...",
  "appliedAt": "...",
  "errorCode": null,
  "retryable": false
}
```

状态：

```text
APPLIED   plan 已生效，部分 key 可能仍 WARMUP
READY     所有 enabled key 已有有效值
REJECTED  整批拒绝，旧 plan 继续运行
```

规则：

- ACK 按 `(engineId, requestId)` 幂等。
- `requestId` 只由 `engineId + deltaId/snapshotId` 生成，**不包含 status**。
- 同一 requestId 用 UPSERT 从 `APPLIED` 升级到 `READY`；状态 rank 单调，不回退。
- `REJECTED` 是本次请求终态，不能后续变成 APPLIED。
- ACK 丢失时控制面重发 delta；Engine 不能重复应用。
- snapshot 也必须返回独立 ACK（`snapshotId`，requestId 由 snapshotId 生成）。
- 管理面必须同时展示 `desiredVersion` 和 `appliedVersion`。

### 7.5 Outbox

控制面写配置必须走事务：

```text
BEGIN
  INSERT/UPDATE indicator
  INSERT catalog_outbox
COMMIT
```

Publisher 只读 outbox 发送 catalog delta。
不能：

```text
先写 DB，再尽力发消息
```

否则会出现 DB 已改、IndicatorEngine 未收到，或 IndicatorEngine 收到旧版本。

### 7.6 新增指标从 DB 到 IndicatorEngine 的时序

前提：新增指标必须走控制面 API，不能只对 `indicator` 表做裸 `INSERT`。

```text
管理面/API
  -> DB 事务：
       INSERT indicator
       UPDATE indicator_catalog_state (version + 1)
       INSERT indicator_catalog_outbox (event = CREATE)
     COMMIT
  -> Catalog Builder 读取 outbox
  -> 校验、生成 canonicalSpec/indicatorId/displayName/warmupRef
  -> 构建 CatalogDelta
  -> 发送 CATALOG_DELTA 到目标 IndicatorEngine
  -> Engine 接收线程校验
  -> 预取 warmup artifact
  -> 将 ApplyAdd 放入 producer 有界队列
  -> producer 在两次 tick 之间创建 State、恢复 warmup、加入 RouteIndex
  -> 原子切换 CatalogPlan
  -> ACK APPLIED
  -> key 状态 WARMUP
  -> 样本足够后 READY
```

#### 1. DB 写入

推荐表：

```sql
indicator (
  indicator_id,
  counterparty_id,
  operator_code,
  operator_version,
  inputs_json,
  params_json,
  timeframe,
  display_name,
  display_key,
  warmup_ref,
  enabled,
  retired_at,
  spec_canonical,
  spec_json,
  spec_hash
)

indicator_catalog_state (
  counterparty_id PRIMARY KEY,
  catalog_epoch,
  catalog_version,
  checksum
)

indicator_catalog_outbox (
  id,
  counterparty_id,
  event_type,       -- CREATE / UPDATE / DELETE / DISABLE / ENABLE
  indicator_id,
  catalog_version,
  payload_json,
  status,           -- PENDING / PUBLISHED / APPLIED / FAILED
  attempts,
  next_retry_at,
  created_at
)
```

其他表：

```text
indicator_operator           Java OperatorRegistry 的 DB 投影
indicator_engine             engine 注册/心跳/applied catalog
indicator_catalog_ack        snapshot/delta ACK 幂等
indicator_lease              lease/fencing
indicator_chain_snapshot     option chain 展开后的合约集合
indicator_latest             最新值
indicator_value_history      采样历史
indicator_warmup_artifact    bars/state/series warmup 元数据
```

事务必须同时写指标和 outbox。
只写 `indicator` 不写 outbox，Engine 不会知道。

#### 2. Catalog Builder

Builder 负责：

```text
校验 operator/version 存在
生成 canonicalSpec
生成 indicatorId/displayName
校验 inputs 同 counterparty/exchange
校验 key 是否重复
生成 warmupRef
构建 delta
签名
发送
```

如果使用已有 operator：

```text
EMA / PAIR_SPREAD / OPT_ATM_IV 已存在
-> 可以热加载
```

如果是新 operator 代码：

```text
OperatorRegistry 中不存在
-> 拒绝 delta，errorCode=OPERATOR_NOT_FOUND
-> 先发布新 operator，再新增指标
```

#### 3. Engine 接收线程

接收线程只做不可变准备工作：

```text
1. 校验 delta/baseVersion/checksum/签名
2. 校验 indicatorId 与 canonicalSpec 一致
3. 校验 operator/version 存在
4. 校验 inputs 属于本 counterparty
5. 校验订阅上限和资源上限
6. 预取 warmup artifact 到本地缓存
7. 构建不可变 PreparedSpec
8. 放入 producer 的 ApplyAdd 队列
```

接收线程不能：

```text
创建可变 IndicatorState
回放 warmup 到 State
修改 RouteIndex
修改 ValueKV
```

这些必须由 producer 线程在安全点执行。

#### 4. Producer 应用

```text
ApplyAdd(spec, warmupArtifact)
  -> createState(spec)
  -> restoreWarmup/回放
  -> 加入 RouteIndex
  -> 加入 SubscriptionManager 引用
  -> 切换 CatalogPlan
  -> ValueKV 写入 WARMUP 占位
  -> ACK APPLIED
```

warmup 完成后：

```text
WARMUP -> OK
```

样本不足：

```text
保持 WARMUP
策略禁止新开仓
```

#### 5. ACK 与重试

```text
APPLIED   plan 已生效
READY     key 已有有效值
REJECTED  整批拒绝，旧 plan 不变
```

ACK 丢失时：

```text
控制面按 deltaId 重发
Engine 按 deltaId 幂等
```

outbox 状态：

```text
PENDING -> PUBLISHED -> APPLIED
                    -> FAILED（可重试）
```

#### 6. Engine 离线

```text
outbox 保持 PENDING/PUBLISHED
Engine 重连后比较 catalogVersion
版本相同 -> 无需动作
版本落后 -> 拉全量 snapshot
版本跳跃 -> 拉全量 snapshot
```

不能只补发增量而不校验 baseVersion。

#### 7. 直接 SQL 的情况

如果运维直接 `INSERT indicator`：

```text
必须同时写 outbox
或者触发一次 catalog rebuild
```

否则 Engine 不会加载。
推荐禁止生产环境裸 SQL 写指标表，统一走 API。

#### 8. 新增的可见性

新指标创建后：

```text
策略向导可见
但 key 状态可能是 WARMUP
策略可绑定，但新开仓必须等 OK
```

不能创建后立即假设可交易。

## 8. IndicatorEngine 启动与本地恢复

### 8.1 启动流程

```text
1. 读取本地 LKG catalog
2. 校验 schemaVersion/epoch/version/checksum/signature
3. 连接控制面，比较 epoch/version
4. 需要则拉全量 snapshot
5. 校验 operator/params/inputs/key
6. 构建 CatalogPlan
7. 创建 StateStore
8. 加载 stateSnapshot / warmupRef
9. 从 watermark 补算到当前
10. 构建 RouteIndex/SubscriptionManager
11. 订阅行情
12. 发布 READY/APPLIED
```

### 8.2 LKG 文件

路径：

```text
<engine-data>/indicator/catalog-<counterparty>.json
<engine-data>/indicator/warmup/<indicatorId>.warmup
<engine-data>/indicator/state/<indicatorId>/<operatorVersion>/<catalogEpoch>/<stateSeq>.snap
```

写入：

```text
临时文件 -> fsync -> 原子 rename
保留 previous 备份
文件内包含 schemaVersion/epoch/version/checksum
```

损坏时：

- 不使用空目录。
- 尝试 previous。
- 都失败则 fail closed，告警。

### 8.3 控制面不可用

```text
继续使用 LKG 运行
不能热加载
记录 catalogAge
超过 catalogMaxAge 后禁止新开仓，允许平仓
```

### 8.4 策略 readiness

策略部署前必须检查：

```text
目标 IndicatorEngine 已 APPLIED 对应 catalogVersion
所需 indicatorId 在 catalog 中存在
所需 key 状态不是 STOPPED/NO_DATA
```

策略可以接受 `WARMUP`，但新开仓必须等 `OK`。
不允许策略运行后才发现 key 不存在。

## 9. Warmup 与状态交接

V1 采用：

```text
周期 stateSnapshot + watermark
+ warmupRef
+ 从 watermark 补算到恢复时刻
+ 补不齐保持 WARMUP
```

目标：

- Engine 重启后不丢 EMA/RSI/bar/IV Rank 状态
- 不从零重放全部历史
- 不把缺口数据算成 OK
- 不把状态交接和策略持仓恢复混在一起

状态交接只恢复指标计算状态，不恢复订单、持仓、PnL。

### 9.1 warmupRef

`IndicatorSpec.warmupRef` 指向控制面生成的 warmup artifact：

```json
{
  "type": "bars",
  "uri": "warmup://SIMNOW/ik1_.../v1",
  "operatorVersion": 1,
  "timeframe": "1m",
  "from": "2026-11-01T00:00:00+08:00",
  "to": "2026-11-11T15:00:00+08:00",
  "checksum": "sha256:...",
  "bars": [...]
}
```

解析：

```text
GET /internal/indicators/{indicatorId}/warmup
  ?operatorVersion=...
  &from=...
  &to=...
```

规则：

- IndicatorEngine 通过控制面获取 warmup，不直接查指标 DB。
- warmup 本地缓存，带 checksum/signature。
- `operatorVersion`、`keySchemaVersion` 必须匹配，否则拒绝。
- 无 warmup 时允许加载，但 key 状态为 `WARMUP`，原因 `WARMUP_INSUFFICIENT`。
- 长周期指标（如 `1d`）无 warmup 时拒绝该 key 的加载。
- V1 支持的热加载 timeframe：`tick / 1s / 1m / 5m / 1d`；`1d` 依赖 warmupRef。
- `bars` 只用于小数据内联；大 artifact 只使用 `uri`，避免 delta 过大。

### 9.2 stateSnapshot

`stateSnapshot` 是 Engine 自己周期生成的确定性状态快照，只由 producer 线程创建。

```json
{
  "snapshotVersion": 1,
  "indicatorId": "ik1_...",
  "keySchemaVersion": 1,
  "operatorVersion": 1,
  "catalogEpoch": "01J...",
  "catalogVersion": 44,
  "watermark": "2026-11-12T10:00:00+08:00",
  "warmupTo": "2026-11-12T10:00:00+08:00",
  "lastInputAsOf": "...",
  "stateSeq": 12345,
  "checksum": "sha256:...",
  "state": { ... },
  "streamCut": {
    "recordingId": 123456,
    "streamId": 1001,
    "sessionId": 123,
    "position": 987654321,
    "nextPosition": 987654322,
    "eventAsOf": "2026-11-12T10:00:00+08:00"
  },
  "archiveRefs": [
    {
      "input": "SIMNOW/SHFE/au2612/last",
      "replaySource": "ARCHIVE",
      "lastInputSeq": 456789,
      "eventAsOf": "2026-11-12T10:00:00+08:00"
    }
  ]
}
```

`watermark` 表示：

```text
这个 snapshot 已经计算到哪个 eventAsOf
```

`streamCut` 表示：

```text
这个 snapshot 对应的全局行情流位置
position     最后一条已处理消息位置（inclusive）
nextPosition 下一条待处理消息位置（exclusive）
```

`archiveRefs` 表示：

```text
每个输入在 snapshot 时刻的 lastInputSeq / replaySource
```

要求：

- `archiveRefs` 每个 archive-backed input 一条；没有 Archive 的输入用 `WARMUP/NONE`，不能伪造。
- 全局 replay 从 `streamCut.nextPosition` 开始，不是从 per-input position 开始。
- `lastInputSeq` 必须与 1001 的 `(sessionId, seq)` 对齐。
- `warmupTo` 是 snapshot 的预热截止时间，不一定等于 watermark。
- `stateSnapshot` 不保存未来 apply 的切点；apply 点由独立的 `ApplyCut` 表示。

要求：

- 同 key、同 operatorVersion 才能恢复。
- `catalogEpoch` 不匹配时不能恢复。
- `watermark` 不能晚于当前时间。
- `state` 必须是确定性数据，不包含指针、线程、连接、随机数。
- 快照只包含指标状态，不包含 RouteIndex/Subscription/ValueKV。

快照写入路径：

```text
<engine-data>/indicator/state/<indicatorId>/<operatorVersion>/<catalogEpoch>/<stateSeq>.snap
```

写入：

```text
临时文件 -> fsync -> 原子 rename
checksum 校验
保留最近 N 份（建议 3 份）
```

生成频率：

```text
bar 型：每个 bar close
tick 型：每 30s 或每 N 个 tick
日线型：每日收盘
```

不能每个 tick 为所有 key 写快照；按 key 分片、错峰、只写 dirty state。

### 9.2.1 ApplyCut

`ApplyCut` 是“新指标/重启恢复从历史切到实时”的精确切点，不是周期 snapshot 字段。

```json
{
  "engineId": "indicator-simnow-01",
  "indicatorId": "ik1_...",
  "applyId": "01J...",
  "streamCut": {
    "recordingId": 123456,
    "streamId": 1001,
    "sessionId": 123,
    "position": 987654400,
    "nextPosition": 987654401,
    "eventAsOf": "2026-11-12T09:30:00+08:00"
  },
  "capturedAt": "2026-11-12T09:30:00+08:00"
}
```

规则：

- 由 producer 线程在安全点捕获：当前 tick/bar 已处理完，State 一致，新指标尚未加入 RouteIndex。
- 接收线程只准备 `PreparedSpec`，不能决定 apply 点。
- `applyCut` 在 replay 开始前写入本地 LKG/journal，`fsync` 后才开始 replay。
- producer/replay 崩溃后从持久化 `applyCut` 继续，不能从旧 snapshot 重新开始。
- `position` inclusive，`nextPosition` exclusive；replay 从 `nextPosition` 开始。
- 1d 指标：`applyCut.streamCut.eventAsOf` 使用最后一个已收盘交易日，而不是当前墙钟。
- 不能把 applyCut 写进周期 stateSnapshot；snapshot 的 `streamCut` 是过去时。

### 9.3 恢复流程

```text
1. 获取 lease / 新 epoch
2. producer 在安全点捕获 applyCut，并写入 LKG/journal
3. 为每个 key 找最新有效 stateSnapshot
4. 校验 operatorVersion/keySchemaVersion/catalogEpoch/checksum
5. 由 producer 线程 restoreState
6. 从 snapshot.streamCut.nextPosition 开始回放
7. 回放区间： (snapshot.watermark, applyCut.streamCut.eventAsOf]
8. 校验 recording/position/seq 连续
9. 补齐且连续 -> OK
10. 无法补齐 -> WARMUP/NO_DATA，记录缺口区间
```

两条路径不能混：

```text
有 snapshot：
  state 已包含到 snapshot.watermark
  replay (snapshot.streamCut.nextPosition, applyCut.streamCut.nextPosition]

没有 snapshot / 新指标：
  replay (warmup artifact.to, applyCut.streamCut.eventAsOf]
```

不能从 `snapshot.watermark` 恢复后又从 `warmupTo` 重放一遍；这会把 `[warmupTo, watermark]` 重复计算。

1d 指标：

```text
applyCut.streamCut.eventAsOf = 最后一个已收盘交易日
当日盘中不把未完成日 bar 纳入 applyCut
```

优先级：

```text
最新 snapshot + (watermark, applyCut]
  > 旧 snapshot + (watermark, applyCut]
  > warmupRef 全量回放 + (artifact.to, applyCut]
  > WARMUP
```

没有 snapshot：

```text
使用 warmupRef 全量回放
如果 warmup 不足 -> WARMUP
```

snapshot 损坏：

```text
尝试上一份 snapshot
都失败 -> warmupRef
仍失败 -> WARMUP/NO_DATA
```

### 9.4 缺口处理

```text
gap = applyCut.streamCut.eventAsOf - snapshot.watermark
```

规则：

- gap 内数据可补齐 -> 恢复 OK
- gap 超出允许范围 -> 保持 WARMUP，禁止新开仓
- 关键输入缺失 -> NO_DATA
- 不能用 0 或不连续数据补缺口
- 不能因为 heartbeat 继续就认为状态新鲜

`maxRecoveryGap` 按 operator/timeframe 配置：

```text
tick/1s/1m：分钟级
1d：交易日级
```

### 9.5 新指标 vs 重启

```text
新指标：
  没有旧 snapshot
  -> OperatorSchema.initialReplayLookback
  -> initialReplayFrom = applyCut.streamCut.eventAsOf - initialReplayLookback
  -> 从 max(initialReplayFrom, earliestRecording) 回放到 applyCut.streamCut
  -> 不足保持 WARMUP
  -> 足够才 OK

Engine 重启：
  优先 snapshot + 补算
  -> tick/1s 用 Archive replay 补缺口
  -> 回放区间 (snapshot.watermark, applyCut]
  -> 不重放全部历史

ORS/主机故障：
  本地 snapshot 可能丢失
  -> tick/1s 优先 Archive replay
  -> bar 指标用 warmupRef/bar replay
  -> 补不齐保持 WARMUP
```

### 9.6 回放确定性

- 不使用当前墙钟参与计算。
- 不访问外部 I/O。
- bar 时间使用 `eventAsOf`。
- 回放结束后的 state 与实时状态使用同一 operator 版本。
- 回放必须可重复；同输入产生同 checksum。

### 9.7 Aeron Archive replay

Aeron Archive 已录制行情 stream `1001`，可作为 tick/1s 指标的可重放输入源。

1001 消息契约必须包含：

```text
counterpartyId
exchange
instrument
sessionId
seq             per (counterparty, exchange, instrument) 消息级单调
timestamp
```

`seq` 是消息级，不是 per-field：同一条消息里的 last/bid/ask/volume/OI 共享一个 seq。
每个 field 的消费位点用 `(sessionId, seq)` 表示。

当前 Java `MarketDataMessage`/`MarketDataCodec` 还没有暴露 `counterpartyId/exchange/seq/sessionId`；SBE encoder 已有 counterparty/exchange 字段，但 codec 未写入，`seq/sessionId` 仍需补。实现前必须先完成 SBE/Java 契约迁移。

当前事实：

```text
ArchiveRecorder 默认录制 1001 行情
ArchiveReplayTool 支持 --recording-id/--position 重放
当前 archive-replay.service 只重放执行流 2102/2103/2122/2123/3122/3123
```

因此指标恢复需要新增 Engine 侧 replay 接入，不能假设现有 replay service 已经覆盖 1001。

#### 全局 streamCut

```text
recordingId
streamId
sessionId
position       最后一条已处理消息（inclusive）
nextPosition   下一条待处理消息（exclusive）
eventAsOf
```

`stateSnapshot.streamCut` 是全局游标。
`archiveRefs` 只保存每个 input 的 `lastInputSeq`，不能各自作为 replay 起点。

#### ReplayEnvelope

9001 上必须带：

```text
replaySessionId
recordingId
position
sourceSessionId
payload
```

每个 IndicatorEngine 使用独立 replay stream，禁止多 engine 共用 9001。

#### 恢复策略

```text
LATEST_ONLY:
  最新值/最新 tick 恢复，不需要 replay

WINDOWED / CUMULATIVE:
  stateSnapshot.streamCut
  -> 从 nextPosition 全局回放
  -> 按 counterparty/exchange/instrument 过滤
  -> 按 (sessionId, seq) 去重
  -> 到达 applyCut
  -> 切换 live
  -> 补不齐 -> WARMUP

BAR:
  stateSnapshot + warmupRef/bar replay
  有 Archive 时可作为补充
```

#### Replay 不能写回 live 1001

必须使用专用 replay stream：

```text
Archive replay -> aeron:ipc, stream 9001（可配置）
IndicatorEngine -> 只订阅 9001 做追赶
追平 live head 后 -> 切回 1001
```

不能用 Archive 直接重放到 `1001`，否则会和实时行情混流、重复、乱序。

#### 追平与切换

```text
1. restore snapshot
2. 先订阅 live 1001，缓冲并记录 liveStartCut
3. 从 snapshot.streamCut.nextPosition 开始 replay
4. 按 counterparty/exchange/instrument 过滤
5. 用 (sourceSessionId, seq) 去重
6. replay 追到 applyCut.nextPosition
7. 停止 replay
8. 切换到 live 1001
9. live 首条消息的 (sessionId, seq) 必须与 applyCut 连续
10. 连续 -> OK；不连续 -> 留在 WARMUP
```

同步屏障：

```text
live 订阅必须先于 replay 启动
replay 到达 applyCut 后，live 缓冲中从 applyCut.nextPosition 之后开始应用
不能先停 replay 再订阅 live
```

`applyCut` 和 live 切换期间：

```text
VALUE_ENGINE_STATE.status = REPLAYING
策略禁止新开仓
lease 续约由独立线程执行
```

不能因为 replay 阻塞 producer 导致 lease 超时自 fence。

#### 限制

- Archive retention 当前 30 天；`1d` 200 天指标仍需要 `warmupRef` 或日线 series。
- `1001` 是全市场行情流，replay 必须过滤，不能全量喂给单指标。
- ArchiveRecorder 在 publisher session 变化时会重新录制；recordingId 变化/间隙必须检测。
- 1001 必须每天收盘后定时 roll，否则 active recording 永远不会被 retention 清理。
- roll 不能简单 stop → 100ms → start；必须重叠启动新 recording 再停旧 recording，或明确接受受控 gap。
- 恢复时使用 recording 链：从 snapshot recording 开始，逐条 replay 到当前 active recording，再切 live。
- recording 链元数据：

```text
indicator_archive_segment (
  stream_id,
  recording_id,
  session_id,
  start_position,
  stop_position,
  start_ts,
  stop_ts,
  status,
  previous_recording_id
)
```

- 受控 gap 必须记录 `ARCHIVE_GAP`，相关指标保持 WARMUP 到下一个完整 snapshot。
- 禁止 `ArchiveReplayTool --latest-for-stream 1001` 直接写回 live 1001。
- Archive 写入失败/`ARCHIVE_NOT_WRITING` 时，不能把 replay 当成完整历史。
- 新指标如果没有覆盖 lookback 的 recording，保持 WARMUP。
- replay 期间策略禁止新开仓；追平并通过 continuity check 后才 OK。
- `OPT_IV_RANK` 的日线历史不能只依赖 30 天 Archive，需要 `series` warmup。

## 10. 热加载

### 10.1 新增

```text
接收线程校验 spec
-> 预取 warmup artifact
-> 构建不可变 PreparedSpec
-> 放入 producer 的 ApplyAdd 队列
-> producer 在安全点捕获 applyCut
-> applyCut 写入 LKG/journal 并 fsync
-> producer 创建 State
-> producer restore/回放
-> snapshot: replay (snapshot.watermark, applyCut]
-> new indicator: replay (artifact.to, applyCut]
-> 加入新的 CatalogPlan
-> 建立 RouteIndex/订阅
-> 原子应用
-> ACK APPLIED
-> 缺口补齐 -> READY
```

接收线程不能创建可变 State。

### 10.2 删除与禁用

V1 的 DELETE 是软删除：

```text
1. 检查 strategy_indicator_binding
2. 有引用 -> 409，不允许删除
3. 无引用 -> enabled=false, retired_at=now()
4. REMOVE delta
5. producer 移除路由
6. 状态 STOPPED
7. 保留墓碑 TTL
8. 释放 State
9. ACK
```

物理删除只由 retention job 执行，且只处理：

```text
retired_at IS NOT NULL
enabled = false
NOT EXISTS (strategy_indicator_binding)
```

清理顺序：

```text
indicator_latest
indicator_value_history
indicator_warmup_artifact
indicator_chain_binding
indicator
```

retention **永远不删除 binding**。
有 binding 的指标跳过并告警 `RETENTION_BLOCKED_BY_BINDING`。
不能依赖 `ON DELETE CASCADE` 删除历史，也不能静默解绑策略。

墓碑：

```text
IndicatorValue(status=STOPPED, reason=REMOVED, removedAt)
```

墓碑保留到所有跨进程副本都收到通知，且至少一个 TTL。
不能让策略读到 null 后误判为“从未加载”。

### 10.3 修改

语义字段：

```text
inputs
counterparty
operator
operatorVersion
timeframe
params
```

任一项变化 -> 新 indicatorId。

显示名/颜色/备注变化 -> 只更新 metadata，不改 key。

旧 key：

- 继续服务旧策略。
- 新策略绑定新 key。
- 旧策略改绑新 key 后，旧 key 进入 retire。
- 不能原地修改旧 key 的语义。

### 10.4 禁用与启用

```text
disable -> 状态 STOPPED，保留 spec 和 state 一段时间
enable  -> 重新加载 state/warmup，状态 WARMUP
```

禁用不是删除，策略仍能看到 `STOPPED`。

### 10.5 原子应用

```text
CatalogPlan：
  specs
  routeIndex
  localIdMap
  catalogVersion/epoch

StateStore：
  只由 producer 线程拥有
  按 indicatorId carry-over
```

流程：

```text
1. 旁路线程解析/校验 delta，构建候选 CatalogPlan
2. 预取 warmup，构建不可变 PreparedSpec/WarmupArtifact
3. 将 ApplyAdd 命令放入 producer 有界队列
4. producer 在两次 tick 之间消费命令
5. producer 创建 State、restore/回放 warmup
6. 同 key 复用 State；新 key 加入；删除 key closeState
7. 原子替换 plan 引用
8. ACK
```

State 生命周期：

```text
PREPARED(side, 不可变) -> CREATED(producer) -> READY -> ACTIVE -> CLOSED
```

约束：

- 旁路线程只创建 `PreparedSpec/WarmupArtifact`，不创建 `IndicatorState`。
- 只有 producer 线程可以调用 `createState/restoreState/closeState`。
- 只有 `READY` 之后 State 才能进入 RouteIndex。
- 旁路线程只处理不可变数据，不接触可变 State。
- tick 路径不加锁。
- 不使用“引用归零释放”作为生命周期机制；State 的释放由 producer 线程显式执行。

### 10.6 失败

```text
校验失败 -> 整批拒绝 -> 旧 plan 不变
warmup 可选且失败 -> APPLIED，对应 key WARMUP/NO_DATA
warmup 必需且失败 -> 拒绝该 key/delta，旧 plan 不变
订阅失败 -> 整批拒绝，除非该 key 可选且明确标记 NOT_SUBSCRIBED
```

`warmupRequired` 由 operator/spec 声明：

```text
1m/5m EMA      可选
1d EMA         必需
OPT_IV_RANK    必需
```

不能部分应用后返回成功。

## 11. 计算路径

```text
tick
  -> (counterparty, exchange, instrument)
  -> RouteIndex
  -> 受影响的 indicatorId 列表
  -> IndicatorState.onTick
  -> 计算值
  -> ValueKV.put
  -> 发布 value delta
```

规则：

- 只更新受影响的 key，不遍历全部指标。
- tick 路径不查 DB、不写日志、不分配临时对象。
- pair 指标注册到两条 leg；任一 leg 更新都触发。
- 一条 leg 缺失 -> `NO_DATA` 或 `STALE`，不能计算，也不能返回 0。
- 期权链按 chain snapshot 批量更新，不逐合约全量重算。
- V1 不支持 indicator-to-indicator 依赖；复合逻辑必须在 operator 内完成。
- 若未来支持依赖，必须新增 `INDICATOR` input、DAG、拓扑排序、环检测和 as-of 传播，并升级 key schema。

## 12. 路由与订阅

### 12.1 路由

```text
RouteIndex:
  MarketInputKey -> int[] localIds
```

`localId` 只在同一个 CatalogPlan 内有效。
跨进程、API、历史、日志仍使用 `indicatorId`。

`MarketInputKey`：

```text
(counterpartyId, exchange, instrument, field)
```

期权链输入在 catalog 编译时展开为具体期权合约：

```text
OptionChainInput
  counterpartyId
  exchange
  underlying
  expirySelector
  strikeSelector
  callPut
  field
```

### 12.2 订阅管理

```text
SubscriptionManager:
  subscriptionRef[(counterparty, exchange, instrument)] -> refCount
  routeRef[(counterparty, exchange, instrument, field)] -> refCount
```

规则：

- 同一合约多个 field 只占一个 CTP 订阅。
- 新增指标引用 input 时 `subscriptionRef++` 和 `routeRef++`。
- 删除指标引用时对应 refCount--。
- `subscriptionRef` 为 0 才退订。
- CTP 订阅上限只按 instrument 计数，不按 field。
- 超过上限：整批拒绝 catalog，保留旧 plan，返回明确错误。
- 不能静默少订阅，否则会变成 NO_DATA。

### 12.3 缺失输入

```text
从未订阅 -> NOT_SUBSCRIBED
已订阅但无 tick -> NO_TICK
曾有值但过期 -> INPUT_STALE
```

策略和 UI 必须能区分这三种原因。

## 13. Timer 与时间

指标不能只依赖 tick。

新增 `IndicatorTimerService`：

```text
bar close
session close
stale sweep
heartbeat
```

时间源：

```text
eventAsOf   交易所时间或 bar 收盘时间
publishedAt IndicatorEngine 本地写入时间
timeSource  EXCHANGE / LOCAL / BAR_CLOSE
```

`exchange` 时间不可用时，使用 `timeSource=LOCAL` 明确标记，不能混用。

规则：

- `IndicatorTimerService` 只负责入队 `TimerEvent`。
- `onTick/onTimer/apply/close` 全部由 producer 线程执行，不能并发访问 State。
- engine heartbeat 只更新 `indicator_engine.last_heartbeat` / `indicator_lease.last_renew_at`，**绝不更新 eventAsOf**。
- bar close 由 timer 触发，不依赖下一笔 tick。
- session close 触发最终 bar 和收盘状态。
- stale sweep 周期检查 `nextExpectedAt`。
- 无 tick 时也能进入 STALE。
- V1 使用交易所交易日历，不自己猜夜盘/节假日。
- `nextExpectedAt` 按 operator 计算：tick=`lastInput+maxAge`，bar=`barClose+tolerance`，daily=下一交易日收盘，event=事件窗口结束。
- 同一时间戳的 tick 与 bar close：先应用 tick，再关闭 bar；跨 session 的迟到 tick 丢弃或进入 allowed-lateness 队列。

## 14. ValueKV 与状态机

### 14.1 时间字段

```text
eventAsOf      数据/业务时间
lastInputAsOf  最后输入 tick 时间
publishedAt    写入 KV 时间
timeSource     EXCHANGE / LOCAL / BAR_CLOSE
nextExpectedAt 预期下一次更新时间
removedAt      STOPPED 墓碑时间
invalidatedAt  PRODUCER_LOST 失效时间
```

### 14.2 freshness

由 operator 声明：

```text
tick 型：maxInputAge
bar 型：maxInputAge + timeframe 容忍
日线型：按交易日
事件型：按事件窗口
```

`isFresh(value, now)` 统一由框架提供，不让策略自己判断。

### 14.3 心跳

心跳是 **producer/engine 级**，不是每个 indicator 一条：

```text
indicator_engine.last_heartbeat
indicator_lease.last_renew_at
```

规则：

- 心跳不进入 `IndicatorValue`。
- 心跳不改变 `eventAsOf/lastInputAsOf/value/status`。
- `isFresh` 只看 `eventAsOf/lastInputAsOf/nextExpectedAt`。
- 心跳丢失超过 lease 阈值 -> `PRODUCER_LOST`。
- 不能用心跳让停止更新的指标“永远新鲜”。

### 14.4 状态转换

`LOADED` 不是对外值状态；它是内部生命周期：

```text
CREATED -> READY -> ACTIVE -> CLOSED
```

对外 `IndicatorStatus`：

```text
OK
WARMUP
STALE
NO_DATA
STOPPED
```

转换表：

| From | Trigger | Guard | To | Reason |
|---|---|---|---|---|
| NO_DATA | 收到输入但样本不足 | warmup 未完成 | WARMUP | WARMUP_INSUFFICIENT |
| WARMUP | 样本足够 | value finite | OK | — |
| OK | 超过 maxAge 无输入 | 已有值 | STALE | INPUT_STALE |
| STALE | 新输入恢复 | 样本足够 | OK | — |
| NO_DATA | 开始 warmup | — | WARMUP | WARMUP_INSUFFICIENT |
| OK/WARMUP/STALE | disable | — | STOPPED | DISABLED |
| OK/WARMUP/STALE | remove | — | STOPPED | REMOVED |
| STOPPED | enable | — | WARMUP/NO_DATA | — |
| OK/STALE | producer lost | lease/fence 失败 | STALE | PRODUCER_LOST |

优先级：

```text
STOPPED > NO_DATA > WARMUP > STALE > OK
```

规则：

- 无数据：`NO_DATA`，`value` 为 null，禁止 0。
- 样本不足：`WARMUP`。
- 有值但过期：`STALE`，保留最后值。
- 删除/禁用：`STOPPED`，写 `removedAt`。
- producer 丢失：写 `invalidatedAt`，策略只能平仓。
- 恢复行情后可回到 `OK`。
- 策略必须检查 `status/eventAsOf/timeSource`，不能只读 value。

### 14.5 ValueKV 失效与墓碑

不能把 ValueKV 清空后让策略读到 `null`。
Engine 重启/切换时使用原子替换：

```text
1. 新 map 预填所有已知 indicatorId
2. 每个 value = {value:null, status:NO_DATA/STALE, reason:PRODUCER_LOST, invalidatedAt:now}
3. 原子替换旧 map
4. 新值恢复后逐 key 覆盖
```

规则：

- `STOPPED` 墓碑保留 `removedAt`，TTL 后才回收。
- `PRODUCER_LOST` 保留 `invalidatedAt`，策略看到后只能平仓。
- 跨进程副本收到 epoch 变化时，执行同样的 tombstone 替换。
- 不允许在 epoch 切换时保留旧 `OK` 值。
- 墓碑 TTL 由 catalog/agent 配置，至少覆盖所有副本重连时间。

## 15. 策略如何使用

绑定表：

```sql
strategy_indicator_binding (
  binding_id BIGSERIAL PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  indicator_id TEXT NOT NULL REFERENCES indicator(indicator_id) ON DELETE RESTRICT,
  deployment_id BIGINT,
  generation BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL DEFAULT 'system',
  UNIQUE (strategy_id, indicator_id, COALESCE(deployment_id, 0))
)
```

策略部署时：

```text
1. 校验 indicatorId 在目标 IndicatorEngine catalog 中存在
2. 校验 counterparty 匹配
3. 事务内写 binding
4. 等 catalog APPLIED
5. 检查 readiness gate
```

删除保护：

```text
删除 indicator 时，binding FK ON DELETE RESTRICT
或 SELECT ... FOR UPDATE 后检查
禁止 check-then-delete 竞态
```

统一 readiness gate：

```text
目标 engine APPLIED 对应 catalogVersion
engineStatus == ACTIVE
engineLease.active
value.producerEpoch == engineLease.producerEpoch
value.tokenEpoch == engineLease.tokenEpoch
value.fencingToken == engineLease.fencingToken
now - engineLease.heartbeatAt < threshold
所有 binding 的 indicator 存在
status 不是 STOPPED/NO_DATA
新开仓要求 OK && isFresh
```

`REPLAYING` 等同于不可开仓，只允许平仓。

不能只依赖策略代码自觉检查；order gateway/risk 必须统一拦截。

`VALUE_ENGINE_STATE` 消息：

```text
engineId
counterpartyId
producerEpoch
fencingToken
leaseExpiresAt
heartbeatAt
status
```

频率：

```text
1s 一条，engine 级，不进入每个 IndicatorValue
```

策略 Runner 维护 `engineLease`。
控制面 lease sweeper 在 lease 过期时主动发布 `PRODUCER_LOST`，不能依赖已死进程自 fence。

运行期：

```text
策略与 IndicatorEngine 同机：通过 Aeron IPC 读取副本
策略跨主机：Aeron UDP snapshot + delta，策略维护只读副本
```

不存在“同进程直接共享 Java Map”的路径。

策略读取：

```java
var v = valueReader.get(indicatorId);
if (v == null || v.status() != OK || !isFresh(v, now)) {
    // 禁止新开仓；平仓允许
}
```

策略必须保存自己的 `lastSeq`/`lastValue` 游标；
共享 ValueKV 不提供 per-consumer diff。

### 15.1 跨进程 ValueKV 协议

消息：

```text
VALUE_SNAPSHOT
  snapshotId
  engineId
  counterpartyId
  producerEpoch
  tokenEpoch
  fencingToken
  catalogEpoch
  catalogVersion
  chunkIndex / chunkCount
  streamSeq
  entries[]

VALUE_DELTA
  engineId
  counterpartyId
  producerEpoch
  tokenEpoch
  fencingToken
  catalogEpoch
  catalogVersion
  streamSeq
  entries[]

VALUE_INVALIDATE
  engineId
  counterpartyId
  producerEpoch
  tokenEpoch
  fencingToken
  reason

VALUE_ENGINE_STATE
  engineId
  counterpartyId
  producerEpoch
  tokenEpoch
  fencingToken
  leaseExpiresAt
  heartbeatAt
  status
```

规则：

- 分配独立 stream `2013`。
- `status`：`ACTIVE / REPLAYING / FENCED / LOST / STOPPED`。
- 策略加入时先请求一帧 `VALUE_ENGINE_STATE` snapshot。
- gate 阈值：`min(2 * heartbeatInterval, leaseTtl)`。
- gate 比较 `(tokenEpoch, fencingToken, producerEpoch)`。

entry：

```text
indicatorId
value
status
reason
eventAsOf
lastInputAsOf
publishedAt
timeSource
nextExpectedAt
removedAt
invalidatedAt
seq
producerEpoch
tokenEpoch
fencingToken
catalogEpoch
catalogVersion
```

规则：

- 策略进程启动/重连：先拉 `VALUE_SNAPSHOT`，再应用 `VALUE_DELTA`。
- snapshot 必须分片，不能一条消息塞 20k 条值。
- `streamSeq` 缺口 -> 丢弃本地副本，重新拉 snapshot。
- epoch/fencingToken 变化 -> 先 `VALUE_INVALIDATE`，再拉新 snapshot。
- 慢消费者：有界队列 + 合并最新值；不能阻塞 producer。
- 不能保留旧 epoch 的 `OK` 值。
- 心跳是 engine 级，不通过每个 value 发送。

### 15.2 值存储与历史

Engine 不直接写历史 DB；控制面 consumer 负责落库。

表：

```text
indicator_latest         每个 indicatorId 一行最新值
indicator_value_history  采样历史
```

历史策略：

```text
1m/tick 指标：按 1s 或 1m 采样，不全量写每个 tick
1d 指标：每日收盘一条
状态变化：OK/WARMUP/STALE/NO_DATA/STOPPED 变化时额外写
```

历史行必须带：

```text
indicator_id
event_as_of       -- 无事件时间时用 published_at
published_at
value
status
reason
time_source
seq
producer_id
producer_epoch
fencing_token
catalog_epoch
catalog_version
key_schema_version
```

写入 guard：

```text
latest 只接受：
  catalogEpoch 相同且 (token_epoch, fencing_token, seq) 更大
  或 catalogEpoch 不同但 token_epoch 更大

history 唯一键：
  (indicator_id, producer_epoch, token_epoch, seq, event_as_of)

重复/乱序消息不能回退 latest。
```

删除指标：

```text
indicator_value_history FK ON DELETE RESTRICT
indicator_latest FK ON DELETE RESTRICT
```

不能 cascade 删除历史。
默认历史采样 1m + 状态变化；tick/1s 不全量落库。
按天/月分区；保留期、分区、压缩由控制面 retention job 管理。

## 16. Pair 指标

```text
PAIR_SPREAD(au2612, ag2612, ratio=0.82) @ SIMNOW
```

- 一个 indicatorId。
- 两个 instrument inputs。
- 同柜台、同交易所。
- 所有同柜台策略可选。
- 不同 ratio -> 不同 indicatorId。
- 不允许依赖策略持仓、订单、阈值。
- 缺一条 leg 的状态必须确定：
  - 从未有值 -> `NO_DATA`
  - 曾有值但过期 -> `STALE`
  - 未订阅 -> `NO_DATA`，reason `NOT_SUBSCRIBED`
- V1 不支持跨柜台/跨交易所 pair。

pair operator 必须声明：

```text
orderedInputs = true
legFieldsMayDiffer = true
```

规则：

- 每个 leg 的 `field` 进入 key，允许 leg1=last、leg2=mid。
- leg 顺序参与 key；重复 leg 拒绝。
- ratio 必须 finite 且 `> 0`；负 ratio 通过交换 leg 表达。
- 计算结果必须 finite；溢出/NaN -> `NO_DATA`。
- binding 时校验 strategy 绑定柜台与 pair 的 counterparty 一致。

## 17. 期权链

V1 支持同柜台、同交易所的期权链指标：

```text
OPT_ATM_IV(au2612, 1m) @ SIMNOW
OPT_25D_RR(au2612, expiry=2612, 1m) @ SIMNOW
OPT_IV_RANK(au2612, 20d, 1d) @ SIMNOW
```

输入模型：

```json
{
  "type": "option_chain",
  "counterpartyId": "SIMNOW",
  "exchange": "SHFE",
  "underlying": "au2612",
  "expirySelector": {"type": "nearest", "minDays": 7},
  "strikeSelector": {"type": "delta_range", "minDelta": "0.05", "maxDelta": "0.95"},
  "callPut": "both",
  "field": "mid"
}
```

编译后的 catalog 派生对象，不进 key：

```json
{
  "chainSnapshotId": "chain-...",
  "resolvedContracts": ["au2612C900", "au2612P900", "..."]
}
```

规则：

- **Catalog Builder 负责展开**为具体期权合约，写入 `indicator_chain_snapshot`。
- `indicator_chain_binding` 记录 indicatorId -> chainSnapshotId -> catalogVersion。
- IndicatorEngine 不再自行选链，只按 catalog 中的合约订阅。
- 新增行权价/到期日 -> 控制面生成新的 chain snapshot / catalog version。
- SubscriptionManager 按具体合约做 refCount；chain 只是批量引用，不代替 per-contract 计数。
- 期权报价缺失：
  - 个别 strike 缺失 -> 该 strike 不参与。
  - 全链无报价 -> `NO_DATA`。
  - 25Δ 的 call 或 put 单侧缺失 -> `NO_DATA`，不能只用另一侧。
- `strikeSelector` 不得依赖当前 IV 才能选 strike；使用 delta 或上一交易日 IV，避免循环依赖。
- ATM IV / 25Δ RR 不得用标的期货 tick 直接代替。
- `OPT_IV_RANK` 必须声明 `lookbackDays/minSamples/sampling=1d`；历史不足 -> `NO_DATA`。
- `OPT_IV_RANK` 使用 `indicator_warmup_artifact.artifact_type='series'`，由控制面日线 job 生成；30 天 Archive 不足以提供 20d/60d 日序列。
- 冷启动 reset 后 IV Rank 保持 `NO_DATA`，直到 series 样本满足 `minSamples`。
- 期权链接口必须按 counterparty/exchange 查询，不能全局。
- CTP 订阅上限不足 -> 整批拒绝 catalog，返回具体超限合约。
- 每条 chain 的 ATM/25Δ/Rank 计算必须有 coalescing 窗口（建议 200ms~1s），不能任一期权 tick 触发全链重算。
- 单次 tick 最多重算受影响的 strike；IV/Greeks 增量更新。
- 5000 合约链必须有 fanout 上限和背压；超过预算的 tick 合并到下一次 batch。

#### Chain snapshot 与 roll

`resolvedContracts` 不进 key。
Catalog 派生元数据存表：

```text
indicator_chain_snapshot (
  chain_snapshot_id,
  counterparty_id,
  exchange,
  underlying,
  as_of,
  contracts_json,
  checksum,
  created_at
)

indicator_chain_binding (
  indicator_id,
  chain_snapshot_id,
  catalog_epoch,
  catalog_version,
  effective_from,
  effective_to
)
```

chain roll 语义：

```text
indicatorId 不变
catalogVersion + 1
新 chainSnapshotId
未变合约的 State carry-over
新增合约 WARMUP
移除合约 closeState
重新校验 warmup/refCount
```

这样每天/每周换月不会导致所有策略重新绑定。

## 18. 管理面

指标中心只有一层：

```text
柜台选择：SIMNOW
指标列表
```

列表：

```text
displayName
inputs
operator / params / timeframe
status / reason / eventAsOf
producerId / producerEpoch
catalogVersion
warmup 进度
引用策略数
订阅状态
```

操作：

```text
新增
删除（有绑定则 409）
禁用
启用
查看使用策略
查看 IndicatorEngine 应用状态
```

创建：

```text
选择柜台
选择输入（instrument / option_chain）
选择 operator / params / timeframe
后端生成 canonicalSpec、indicatorId、displayName
同 indicatorId 复用
```

不再有：

```text
私有指标
策略组
发布为公共
```

管理面还要展示：

```text
desiredCatalogVersion
appliedCatalogVersion
catalogAge
active producer / epoch / lease
last reload latency
```

## 19. API

管理面：

```text
GET    /api/v1/indicators?counterpartyId=&operator=&status=&q=
POST   /api/v1/indicators
GET    /api/v1/indicators/{indicatorId}
PATCH  /api/v1/indicators/{indicatorId}   # 只改 displayName/备注，不改语义
DELETE /api/v1/indicators/{indicatorId}
POST   /api/v1/indicators/{indicatorId}/disable
POST   /api/v1/indicators/{indicatorId}/enable
GET    /api/v1/counterparties/{counterpartyId}/indicator-catalog
GET    /api/v1/counterparties/{counterpartyId}/indicator-catalog/version
GET    /api/v1/agents/{agentId}/indicator-status
```

规则：

- 路径只用不透明 `indicatorId`。
- 创建请求只接收结构化 spec，不接收 `id/name`。
- 支持 `Idempotency-Key`。
- 更新使用 `If-Match`/ETag。
- 删除返回 409 如果存在绑定。
- 错误码结构化：`KEY_CONFLICT`、`BINDING_EXISTS`、`OPERATOR_NOT_FOUND`、`CATALOG_VERSION_GAP`、`SUBSCRIPTION_LIMIT`、`LEASE_HELD`、`LEASE_LOST`。

控制面 lease / engine 内部接口：

```text
POST /internal/indicator-leases/{counterpartyId}/acquire
POST /internal/indicator-leases/{counterpartyId}/renew
POST /internal/indicator-leases/{counterpartyId}/release
GET  /internal/indicator-leases/{counterpartyId}

POST /internal/indicator-engines/register
POST /internal/indicator-engines/{engineId}/heartbeat
POST /internal/indicator-engines/{engineId}/deregister
```

规则：

- register 按 counterparty upsert，允许 engine_id 变化。
- 新柜台创建时在同一事务初始化 `indicator_catalog_state` 和 `indicator_lease(status=EXPIRED, token_epoch=nextval)`。
- acquire 区分 `LEASE_HELD` 和 `LEASE_NOT_INITIALIZED`。

IndicatorEngine 内部：

```text
GET  /internal/indicator-catalog?counterpartyId=...
POST /internal/indicator-catalog/delta
POST /internal/indicator-catalog/ack
GET  /internal/indicators/{indicatorId}/warmup?operatorVersion=...&from=...&to=...
```

内部接口必须：

```text
token/HMAC 或 mTLS
catalog 签名校验
agentId/counterpartyId 绑定校验
```

## 20. 安全与治理

最低要求：

```text
1. 内部认证：token/HMAC；跨主机时 mTLS
2. catalog checksum + 控制面签名
3. RBAC：创建/删除/禁用/查看分离
4. 审计：actor、reason、diff、catalogVersion
5. 配额：每柜台指标数/订阅数/内存
6. 禁止客户端传 indicatorId/displayName/params 以外的身份字段
```

V1 不做任意表达式/代码热加载。

## 21. 容量与性能

初始预算（可配置，需基准测试后调整）：

| 项 | 初始上限 |
|---|---:|
| 每 IndicatorEngine 指标数 | 20,000 |
| 每指标 inputs | 16 |
| 每指标最大窗口 | 4,096 bars |
| 每条期权链最大合约数 | 5,000 |
| 每 IndicatorEngine 订阅数 | 20,000 |
| ValueKV 条目 | 20,000 |
| State 内存 | 2 GiB |
| 单 tick 路由 key 数 | 1,000 |

估算：

```text
stateBytes   ≈ Σ(window × fieldSize) + operator overhead
valueBytes   ≈ 200 B
routeEntries ≈ Σ(有效市场输入)
subscriptions = distinct(counterparty, exchange, instrument, field)
```

期权链必须先把 `OptionChainInput` 展开成具体合约，再计入：

```text
subscriptions 和 routeEntries
```

不能把一条链只算 1 个 input。
20k 指标 × 16 inputs 会超过 20k 订阅上限；apply 前按组合约束校验，超限整批拒绝并告警。

超限行为：

```text
apply 前拒绝 catalog
ACK REJECTED
旧 plan 继续运行
告警
```

tick 路径目标：

- 无锁。
- 无 DB。
- 无日志。
- 稳态 tick 路径零分配。
- `IndicatorValue` 只在发布边界构造，不在每个 operator 内部构造。
- RouteIndex 使用预分配 `int[] localId`，不用 `Set<String>`。
- State 使用 primitive/预分配环形缓冲，不用 `Double` boxing。
- 值发布合并/批量。
- `localId` 只在同一个 CatalogPlan 内稳定；tick 工作项携带 `planVersion`，apply 时按 indicatorId 重路由，不能直接丢弃 tick。
- 用 JFR/分配 profiler 验收，而不是只写“零分配”。

Snapshot / history I/O 预算：

```text
snapshotsPerSecond = dirtyKeys / snapshotInterval
stateSnapshot：只写 dirty state
批量 fsync（10ms 窗口），不按 key 单独 fsync
历史默认 1m 采样 + 状态变化
tick/1s 指标不全量写 DB
按天/月分区，retention job 按分区 drop
```

容量预算：

```text
20k 指标，tick snapshot 30s -> 约 667 次/秒
20k 指标，1m bar close -> 约 333 次/秒
初始目标：1,000 snapshots/秒，批量 fsync
如果硬件只能 100/s，则 snapshotInterval 至少 200s，或按 key 分片轮转
```

不能写“100 次/秒”却同时声称 20k 指标每 30s 快照；两者矛盾。

## 22. 失败与一致性

### 控制面不可用

```text
LKG 继续运行
不能热加载
catalogAge 监控
超过 catalogMaxAge -> 禁止新开仓
```

### IndicatorEngine 重启（ORS 仍存活）

```text
LKG + warmup
重新构建 State
重新订阅同一 ORS 的本地行情流
ValueKV 原子替换为 PRODUCER_LOST/NO_DATA
逐 key 恢复 OK
ORS/策略不重启
```

### ORS / 主机故障

```text
策略 fail-closed
IndicatorEngine 停止
同一主机/ORS 恢复后按顺序重启
没有 standby，没有自动切其他 ORS
```

### 热加载失败

```text
旧 plan 不变
ACK REJECTED
管理面显示错误
```

### active producer 失联

```text
lease 过期
本地自 fence
ValueKV 标记 PRODUCER_LOST/STALE
旧 epoch 消息拒绝
策略 fail-closed
人工/进程在同一 ORS 上重启
新 epoch/fencing 生效
```

没有 standby 接管，也没有自动切到另一个 ORS。

### 双写

```text
禁止控制面 IndicatorEngine 与独立 IndicatorEngine 进程同时写同一个 key
调试重置前必须先停旧 writer，不能边跑边 drop
```

## 23. 调试阶段重置（无兼容、无迁移）

当前是调试阶段，不做 cutover、不保留旧指标数据、不做 ID 映射。

重置脚本：

```text
tools/db/schema-indicator-v2.sql
```

脚本行为：

```text
1. 拒绝在非 *_shadow 数据库执行
2. DROP 旧 indicator_defs
3. DROP 旧 indicator_values
4. DROP 旧 indicator_daily_history
5. DROP 旧 indicator_versions
6. 清除 strategies.config_json.indicators 旧引用
7. 创建新 indicator 表族
8. 为每个 venue/counterparty 初始化 catalog_state 和 lease
```

执行前提：

```text
1. 停止控制面 IndicatorEngine
2. 停止所有策略 Runner 内 IndicatorPublisher
3. 停止所有 IndicatorEngine
4. 确认数据库名以 _shadow 结尾
5. 确认不需要旧指标历史
6. 确认 V2 Java 代码已经可部署
```

执行：

```bash
psql -v ON_ERROR_STOP=1 -d quantlink_fin_shadow \
  -f tools/db/schema-indicator-v2.sql
```

维护窗口顺序：

```text
1. 停旧 writer：控制面 IndicatorEngine / Runner Publisher / IndicatorEngine
2. 执行 schema-indicator-v2.sql
3. 部署 V2 Java 代码（Mapper/Controller/Consumer 已切新表）
4. 从 OperatorRegistry seed indicator_operator
5. 启动 IndicatorEngine，确认 catalog_state/lease 就绪
6. 通过 API 创建新指标
7. 通过 strategy_indicator_binding 绑定策略
8. 启动策略 Runner
```

当前 Java 代码仍写 `indicator_defs`/`indicator_values`。
在第 3 步完成前执行 SQL，指标管理 API 和 Agent 会失效。

重置后：

```text
旧 indicator_id 全部失效
旧 indicator_values/history 全部删除
旧策略 config_json.indicators 清空
新指标通过 API 创建
策略通过 strategy_indicator_binding 绑定新 indicatorId
```

不做：

```text
indicator_id_map
shadow 对比
旧历史迁移
回滚旧指标
双写过渡
```

C++ tbsrc 不在 V2 范围内：

```text
tbsrc 是旧仓库 quantlink-trading 的参考实现
不是 V2 runtime
不接入 V2 catalog
不建设 C++ bridge
不构成第二套 writer
```

## 24. 测试

| # | 类别 | 场景 | 期望 |
|---|---|---|---|
| T1 | Key | 参数顺序、13/13.0、1e-1/0.1、分隔符、大小写、默认值、operatorVersion、field | 语义相同 key 相同；语义不同 key 不同 |
| T2 | Key | pair leg 顺序、重复 leg、不同 exchange、ratio=0/负/NaN | 按 schema 接受或拒绝；key 稳定 |
| T3 | Catalog | 重复 delta、旧 delta 后到、版本跳跃、checksum 损坏、签名错误 | 幂等；旧不覆盖新；跳版本拉全量；整批拒绝 |
| T4 | Catalog | snapshot 部分非法、operator 缺失、key/spec 不一致 | 保留旧 plan，ACK REJECTED |
| T5 | 热加载 | tick 风暴中新增/删除/改参 | 无丢 tick、无半更新、无全量 WARMUP |
| T6 | State | 同 key 热加载 | State carry-over，EMA 不清零 |
| T7 | Warmup | 新增 1m/1d EMA、无历史、文件损坏、operatorVersion 不匹配 | APPLIED/READY 正确；长周期拒绝或预置 |
| T20 | 状态交接 | 周期 snapshot、kill -9 后恢复、warmup 08:55 生成 09:30 apply、snapshot 损坏、gap 超限 | snapshot 只回放 `(watermark, applyCut]`；新指标回放 `(artifact.to, applyCut]`；补不齐 WARMUP |
| T8 | Producer | 两个 active、lease 过期、旧 producer 恢复、engine 进程 kill、ORS 存活 | 只有当前 epoch/token 被接受；engine 同机重启；ORS/策略不重启 |
| T9 | 重启 | ORS/主机 kill、catalog/warmup 写入中、seq 重置 | 策略 fail-closed；同主机恢复；无 standby 切换 |
| T10 | 新鲜度 | 无 tick、迟到/乱序 tick、bar close、session close、heartbeat | 状态正确；heartbeat 不改 eventAsOf |
| T11 | 路由 | 同合约多柜台、同柜台多交易所、pair 缺 leg、期权链、订阅超限 | 不跨柜台泄漏；缺 leg 明确状态 |
| T12 | 跨进程 | 晚启动、丢增量、重复增量、重连、背压 | snapshot-on-join；缺口可恢复 |
| T13 | 绑定 | 删除被引用指标、删除 vs 部署并发 | 409；无竞态 |
| T14 | 安全 | 未认证 catalog push、伪造 producer、越权创建 | 拒绝并告警；审计完整 |
| T15 | 容量 | 10k/20k 指标、期权链 5k、tick 突发 | 内存/延迟在预算内；超限拒绝 |
| T16 | 调试重置 | 停旧 writer、执行 `schema-indicator-v2.sql`、启动新 Engine | 旧表删除；新表创建；旧 config 引用清空；无双写 |
| T17 | 运维 | 控制面宕机、LKG 损坏、catalog 超龄 | fail closed/LKG 策略正确；告警 |
| T18 | 数据质量 | 0/负价、NaN/Inf、crossed quote、停牌、夜盘换日 | 不产生伪值；状态明确 |
| T19 | Lease | 两个 engine 并发 acquire、CAS 冲突、续约丢失、控制面宕机、TTL 过期、旧 token 恢复 | 只有一个 active；旧 engine 自 fence；`fencingToken` 单调；无 standby 接管 |
| T21 | Archive replay | 1001 recording 从 snapshot position 重放、replay/live 切换、recording gap、30 天保留、全市场过滤 | 缺口补算后 OK；recording 不足/间隙保持 WARMUP；不重放到 live 1001 |
| T22 | Producer liveness | 1d 指标 OK 后 kill engine、lease 过期、策略读副本、控制面 sweeper | 新开仓立即禁止；不能等 nextExpectedAt；平仓允许 |
| T23 | Option chain roll | 新 expiry/strike、同 indicatorId、binding 不变、旧合约移除 | indicatorId 不变；catalogVersion+1；新合约 WARMUP；旧合约 close |
| T24 | Canonical bytes | JSONB round-trip、JCS 数字语法、Unicode、option_chain selector | Builder/Engine 生成同一 indicatorId；链合约变化不改 ID |
| T25 | 软删除 | DELETE 有 binding、无 binding、retention purge | 有 binding 409；软删除 STOPPED；硬删除只由 retention |

## 25. 实施顺序

```text
1. 定 V1 范围和 key schema
2. OperatorRegistry + schema/state/freshness 接口
3. IndicatorSpec + canonical key + displayName
4. Catalog snapshot/delta/outbox/签名
5. IndicatorEngine LKG + CatalogPlan + StateStore
6. RouteIndex + SubscriptionManager + TimerService
7. ValueKV + status/asOf/epoch/seq
8. Warmup Service + warmupRef
9. producer lease + epoch/fencing
10. 热加载 apply 命令队列
11. strategy_indicator_binding + 管理面
12. OPT OptionChainInput
13. 调试阶段重置旧 indicator 表并启动新链路
14. 性能/故障注入/验收
```

## 26. 验收

可执行验收：

- IndicatorEngine 进程启动后，运行期指标 DB 查询数为 0。
- 新增 EMA/PAIR_SPREAD 指标，IndicatorEngine PID 不变，catalogVersion 增加，ACK APPLIED。
- 同 key 热加载后 EMA 状态连续，不清零。
- 删除被引用指标返回 409。
- 非法 delta 整批拒绝，旧 plan 继续运行。
- catalogVersion 跳跃自动拉全量。
- 两个 producer 同时启动，只有一个 epoch 被接受。
- 旧 producer 恢复后无法覆盖新值。
- 无行情时按 operator 的 freshness 进入 STALE，不返回 0。
- engine heartbeat 不改变 eventAsOf。
- pair 缺 leg：从未有值返回 NO_DATA，曾有值后过期返回 STALE，未订阅返回 NO_DATA/NOT_SUBSCRIBED。
- 期权链无报价返回 NO_DATA，不用标的 tick 代替。
- IndicatorEngine kill -9 后重启，LKG + snapshot + Archive/warmup 恢复，旧 epoch 失效；ORS/策略不重启。
- tick/1s 指标从 Archive replay 追平后才 OK，且 replay 不写入 live 1001。
- Archive 记录缺口/30 天保留不足时保持 WARMUP。
- engine 失联后，策略在 lease 阈值内禁止新开仓，不能等 nextExpectedAt。
- 期权链 roll 保持 indicatorId，binding 不变，catalogVersion 增加。
- 策略在指标未 READY 时不能新开仓，平仓不受影响。
- 控制面不可用超过 catalogMaxAge 后禁止新开仓。
- 旧控制面 IndicatorEngine 停用后没有双写。

## 27. 不做的事

```text
全局指标
策略私有指标
STRATEGY_GROUP
跨柜台 pair
跨交易所 pair
指标依赖指标
任意表达式/代码热加载
控制面计算指标
运行期读指标 DB
删除历史级联
C++ tbsrc runtime / C++ 指标 bridge
```

## 28. 最终模型

```text
指标属于柜台
目录在 IndicatorEngine 内存
值在 ValueKV
热加载只换配置，不换进程
producer 单 writer + epoch/fencing
warmup 由 catalog ref + Archive replay 提供
```

一句话：

```text
IndicatorEngine 持有不可变 CatalogPlan 和可变 StateStore，producer 单线程计算，策略按 indicatorId 读取带时间/状态/epoch 的不可变值；tick/1s 指标用 Archive 从 checkpoint 追平，bar 指标用 warmupRef 回放。
```

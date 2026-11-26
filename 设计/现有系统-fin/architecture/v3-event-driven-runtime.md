# V3 事件驱动运行时设计

**Revision 3（2026-11-14）** · 状态：DRAFT — R2 的 P0/P1 已在设计层关闭；代码按 §14 分阶段落地，未完成项见 §16

- 前版：Revision 2（1423 行，sha256 `f9896752aa2f879518c1d480285e1570f7bb04708cd8d5fbc2f5a03e69eb505e`，R2 结论 APPROVE_WITH_CHANGES）
- 评审：`docs/reviews/2026-11-14-v3-architecture-review-r2.md`
- 依赖：ADR-004、`venue-freeze-2026-11-12.md`、`venue-contract.md`
- 范围：runtime / runtime-runner / shared-aeron 消费侧
- 边界：只描述运行面语义。ADR-004 冻结的 `venueId/accountId/exchange/orsId`、stream 分配、SBE 字段 ID 一个都不改。

## 0. 本版关闭了 R2 的哪些 P0/P1

### 0.1 P0

| P0 | R2 结论 | Rev3 处置 | 落点 |
|---|---|---|---|
| P0-1 端到端不丢 | PARTIAL | L1 改为“gap 检测 + venue 快照对账”，**不承诺普通 Aeron transport replay**；L0 spool 补齐格式/容量/轮转/fsync/重放顺序/dedup/磁盘满/publication null；M5 `ExecNoDropIT` 增加 spool 重启恢复 | §1.2、§5.2、§8.3、§13.4、§14.7 |
| P0-2 双重记账/顺序 | PARTIAL | `tradingDay` 进入 `TradeEnvelope`/`FillEvent`/WAL（SBE 不改，adapter/session 注入）；WAL 自包含；`netQtyAt(asOf)` 有历史结构；交易日切换状态机；`ledgerAvg`/`displayAvg` 拆分 | §6.2–§6.7 |
| P0-3 快照假新鲜 | PARTIAL | `VenueAccountPort` 只读 venue/account truth；删除全部 `Instant.now()` fallback；区分 `snapshotAsOf`/`positionAsOf`；透传 `staleAfterMs/snapshotId/source`；`requestSeq` 进入 Port API；`AccountSnapshot` 对齐 ADR §5.3 | §7.1–§7.3 |
| P0-4 热加载丢成交 | CLOSED | 保持事件分类、先撤旧 working、orphan fill | §9.1–§9.3 |
| P0-5 单写者 | CLOSED | 所有权表、每 publication 独占 buffer、gateway 账本删除 | §4.2–§4.3、§14.2 |
| P0-6 队列/control 饿死 | CLOSED | 独立 control 队列、exec 满即 fatal、无秒级自旋、预算数值化 | §4.4、§5.2–§5.3 |
| P0-7 决策链路 IO | CLOSED | loop 无 HTTP/JDBC/文件 IO；`runtime.engine` 纳入 ArchUnit | §11 |
| P0-8 sequence/tradeId/gap | PARTIAL | `tradingDay` 进入 dedup key；MD reset 进入 Port API；`EpochGuard/FencingGuard` 接到 exec accept；`lastSeqByStream` 持久化 schema | §5.5–§5.6、§7.1、§10.4 |
| P0-9 MD 合并/replay | PARTIAL | `Clock` 注入；`LatestQuote` 只在版本变化时发布；ring key=seq scope；replay 容差数值化；`CoalescePolicy` 枚举化 | §10.2、§10.5–§10.6、§12.1 |
| P0-10 迁移顺序 | PARTIAL | M0a 改行为测试；registry 默认值/SHADOW 硬编码进 M0a 门禁；M0b 扫实际包并断言字段删除；M1 定义 tee 点/复制/慢消费者；M3 删除直连 gateway 路径 | §14 |
| P0-11 账本 scope/账户独占 | OPEN（新增） | key 加 `strategyKey`；启动强校验账户独占；manual/blank strategy Fill 归属规则；account/strategy 两套视图 | §6.1、§6.10、§7.5 |
| P0-12 WAL 自包含 | OPEN（新增） | `INTENT/FILL_ACCEPTED/ORDER_STATE/POSITION_RESET/CHECKPOINT` 全字段、LSN、重放上下文、失败原子性 | §6.8 |

上表的“R2 结论”是评审当时的状态；Rev3 对这 12 项均按“设计层 CLOSED”处理，代码状态见 §2.2 与 §16。

### 0.2 P1

| P1 | Rev3 处置 | 落点 |
|---|---|---|
| P1-1 Ports 字段/默认值 | `VenueDescriptor` 全字段；`Snapshot.requestSeq/scope`；`AccountSnapshot` ADR 字段；`VenueSession.lastSeqByStream`；`retryAfterMs`；gap/position/health 默认 fail-closed | §5.4、§7.1 |
| P1-2 exec ordering/epoch | `EpochGuard/FencingGuard` 固定在 `ExecIngress.accept()`；`adapterSessionId` 参与比较；终态粘滞 | §5.6、§6.4 |
| P1-3 pending 语义 | `pendingClose` 覆盖 `CLOSE/CLOSE_TODAY/CLOSE_YESTERDAY` 四个买卖组合；`remainingKnown` 取代哨兵；`terminalHistory` 有界 | §6.9 |
| P1-4 Portfolio/PositionKey | `Portfolio` 降为只读聚合；key 切 `PositionKey`；`cash/notional` 乘 multiplier | §6.1、§6.2、§14.2 |
| P1-5 SimpleHedging | θ/lot/cooldown 默认值与校验；`armed` 中间区间；`logicalIntentSeq` 只在发单时递增；`onStart` 幂等 | §12.2 |
| P1-6 WAL/dedup | 单线程权威 dedup + I/O 快速过滤；窗口覆盖；journal 只做索引；checkpoint 原子写 | §6.8 |
| P1-7 registry 默认值 | 删除 `SHADOW/UNKNOWN/SIM/*/legacy/1001` 默认；M0a `RegistryDefaultsIT` | §14.1 |
| P1-8 drain fail-stop | shutdown 30s 后 handoff+halt 语义；MD 定价保留到平仓完成；`requestSeq` 支撑 flat | §7.5、§9.4 |
| P1-9 验收指标 | 恒等式含 fatal；拆 `order_gap_total/trade_gap_total`；`md_lost_no_image` 口径改为“0 或可解释 WARMUP”；apply/onFill 分开 | §13.1–§13.3 |
| P1-10 retry 状态机 | `PENDING_RETRY` 内部重试绕过 duplicate；deadline 后 REDUCE_ONLY | §5.7 |
| P1-11 FatalEvent/预算 | `FatalSlot` 独立；control/exec/MD 预算数值；fatal flush 顺序 | §5.3 |
| P1-12 RuntimeEngine/ArchUnit | 纳入 `runtime.engine`；删除 latest tick 重放；`StrategyStartSnapshot` 子类型定义完整 | §9.3、§11.3 |

### 0.3 关闭口径与删除的旧表述

“关闭”指设计层同时满足四件事：字段/接口可编译、状态机可执行、失败路径显式、退出证据可运行。代码是否已实现只看 §2.2 与 §16；本版不把“设计已写”当成“代码已完成”。

本版删除了 R2 中以下会被实现者误读的旧表述，不再保留“回应段落”：

- 删除“L1 可重放/retention 由 Aeron 配置保证”。普通 publication 没有 durable replay；只有显式 Archive 才可谈 retention。
- 删除 `Snapshot`/`ControlPlaneVenueAccountPort` 任何以 `Instant.now()` 补 `asOf` 的写法；缺时间即 `EPOCH + stale`。
- 删除“`snapshotNet` 与 `PositionKeeper.netQtyAt` 直接比较”的单一写法；改为“按 `snapshotAsOf` + 可判定水位比较，不可判定即 `DRIFT_UNKNOWN`”。
- 删除“每次可信快照用 `longAvgPrice` 重算账本 avg”。快照只写 `displayAvg`，`ledgerAvg` 只由 WAL 顺序成交产生。
- 删除“M0a 用 grep 证明没有 `Instant.now()`”。改为行为测试 + 字节码扫描。
- 删除“M3 用 grep 证明没有 gateway 调用”。改为先删调用点，再用实际模块扫描。
- 删除“`finalSnapshotRequestSeq` 是 loop 自己记的变量”。`requestSeq` 由 Port 分配并随 `Snapshot` 返回。

## 1. 结论先行

V3 把 runner 从“主循环 + 多个后台线程各自改共享状态”改为：**每个 venue 一个 I/O 线程 + 一个策略 loop + 一个账本线程**。所有影响仓位/敞口/订单簿状态的写操作只在 loop 线程发生；I/O 线程只做解码、身份过滤、去重、sequence/epoch 校验和入队。

### 1.1 三条不变量

1. **状态单写者**：`PositionKeeper`、`OrderBookView`、`RiskView`、`Closeout`、`deploymentGeneration` 只有 loop 线程能写；I/O、control、risk、shutdown hook 都只能投事件或写不可变快照槽。
2. **成交只应用一次**：幂等键 `(venueId, tradingDay, tradeId)`；先 WAL 后改内存；重启按 checkpoint + WAL 重放，重放本身也走同一幂等路径。
3. **不可信就不决策**：行情 gap、risk 过期、快照不可信、session 非 READY、对账 drift 时，开仓 fail-closed；平仓/撤单始终允许。

### 1.2 分层保证（说清楚“绝不丢”到底保证到哪一层）

V3 **不承诺** wire 层 exactly-once。承诺的是：**exec 传输 at-least-once 或显式 fatal，账本按幂等键应用，最终效果 exactly-once。**

| 层 | 承诺 | 实现机制 | 承诺不成立时 |
|---|---|---|---|
| L0 adapter 出站/入站 | exec 事件不得静默丢 | 有界队列满 → 有限阻塞 → durable spool → 仍失败则 adapter fatal；publication null/未连接同样走 spool | `exec_dropped_total=0`；>0 禁止 live |
| L1 Aeron transport | **只承诺可检测，不承诺 replay** | exec stream-global seq gap 检测；MD scope seq gap 检测；gap 后停 OPEN，用 venue `ORDER_SNAPSHOT/TRADE_SNAPSHOT/position snapshot` 对账 | 进入 `ExecGap`/WARMUP；对账不可信则 REDUCE_ONLY |
| L2 runner ingress | 不静默丢、不阻塞 I/O | 有界 exec 队列；满则 `FatalExecutionException`，不做秒级自旋 | 进程 fatal，重启后从 WAL + 快照恢复 |
| L3 ledger | 成交效果 exactly-once | `(venueId, tradingDay, tradeId)` 去重 + WAL + 幂等 apply | 重复事件只计数，不重复记账 |
| L4 snapshot | 不伪造新鲜度 | `asOf/stale/staleAfterMs/snapshotId/source/requestSeq` 全部来自 venue/控制面 | 缺字段即 `stale=true`，WARMUP |
| L5 recovery | 重启后账本可解释 | checkpoint + WAL + dedup journal + venue 快照 + `DAY_ROLL` | 无法解释 → REDUCE_ONLY，不报 flat |

L1 的准确语义：

```text
普通 Aeron Publication = term buffer + backpressure，不是 durable log。
consumer 断流/term 轮转后不能 rewind；V3 不设计“从 transport 重放”。

exec：seq 跳号 -> ExecGap -> 禁 OPEN -> venue ORDER_SNAPSHOT 对重 working
      -> venue TRADE_SNAPSHOT/position snapshot 对账 -> 重建基线 -> READY
MD：scope seq 跳号 -> WARMUP -> venue snapshot/reset -> 恢复交付

只有显式开启 AERON_ARCHIVE 且配置 retention/rewind 时，才允许从 Archive replay。
Archive 不是 V3 默认路径，也不能替代 venue 快照对账；它只是 L1 的可选增强。
```

CTP adapter 当前 `kMaxOutbound=8192` 且队列满 `outboundDropped_++`，只满足“可检测丢失”，不满足 L0。**L0 未通过前，V3 不得接 live；该改造是 M5 的前置条件，不属于 M0a。**

### 1.3 目标（可验收）

1. `subscription.poll` 只出现在 `com.quantlink.fin.aeron.io` / `runner.io` / adapter 实现；strategy loop 内为零。
2. control、exec、MD 三条路径分离；control 独立有界队列，每轮优先 drain。
3. `PositionKeeper`/`PortfolioView`/`OrderBookView`/`RiskView` 每个公开方法入口断言 loop 线程。
4. 成交进入 loop 后同轮更新仓位并触发 `onFill`，不再等 `positionRefreshMillis`。
5. 订单发布只有 loop 一个 writer；每个 publication 一个独占 buffer。
6. 重启后从 checkpoint + WAL 恢复到崩溃前最后一条已应用记录，重复/缺失可解释。
7. 决策链路无 HTTP、无 JDBC、无文件 IO、无同步日志刷盘。
8. 行情 gap 后该 scope 停止回调，直到 snapshot/reset；不允许“跳过继续”。
9. 账户独占、交易日切换、manual fill 归属都有启动/运行时强校验，不靠运维约定。

### 1.4 非目标与 ADR-004 冻结边界

非目标：

- 不合并 CTP/SimVenue 进程；不采用 C++ trading 的单进程共享内存。
- 不做撮合、UI、跨机事件总线。
- 不改变 `venueId/accountId/exchange/orsId` 映射、stream 表、SBE message/field ID。
- 不把 control plane 变成交易热路径的一部分。
- 不承诺普通 Aeron publication 的 transport replay；Archive 只在显式配置时可选。

冻结项检查（本版不引入任何 wire 变更）：

| 冻结项 | 本版处理 |
|---|---|
| `venueId = venue_configs.id`、`accountId = accounts.id`、`exchange = instruments.exchange`、`orsId = ors_instances.ors_id` | 原样引用，不新增别名 |
| stream 分配（可选值见 `venue-freeze-2026-11-12.md` §2） | 原样引用；本版只规定 reader/writer 角色，不改值 |
| SBE message/field ID 与冻结哈希 | 不改；`tradingDay` 只加在 Java 消费侧 envelope，不进 SBE |
| `OrderUpdateV2.sequence` | 明确为 `(venueId, sourceSessionId, sourcePublicationEpoch)` 的 **stream-global** 单调序号，不能推断 per-order gap |
| Position/Account/Session 字段 | 使用 ADR-004 §5.3/§5.4 已定义字段；本版只增加消费侧语义，不新增 SBE 字段 |
| `TradeV2.tradeId` | 运行时语义统一为 `(venueId, tradingDay, tradeId)` 唯一；`venue-contract.md` 的“全局唯一”表述必须按 §16.4 同步修订，否则以本文件为准 |

## 2. 现状基线与评审后状态

### 2.1 评审时的问题（Rev3 要消除的对象）

| 问题 | 代码事实（评审时） | 后果 | Rev3 处置 |
|---|---|---|---|
| 三路持仓账本 | gateway `positions` 由 poll 线程 `onTrade` 即时更新；`Portfolio` 另有 fill/cash 账；`refreshPositions` 每 5s 全量覆盖；`liveFills` 再补一次 | 双重记账窗口、口径不一致、drift 被覆盖 | §6 删除 gateway positions 决策路径；`PositionKeeper` 唯一写者；refresh 只对账 |
| 5 秒 risk + 每单 HTTP | `refreshRisk` 5s HTTP；`AeronOrderGateway.submit` 每笔 OPEN 同步 `indicatorGate` | 控制面一次 5s 超时卡住 loop；控制面宕机拒开仓 | §11 gate 缓存 + risk 快照槽 |
| latest map + MD fallback | `AeronMarketData.ticks()` 复制全量 latest；2s 无 tick 时 HTTP fallback | 采样而非事件；双源；无 gap | §10 `MdEvent` + `LatestQuote`；删除 fallback |
| pending 不可见 | gateway `orders` 私有；`CANCEL_REQUESTED` 被 `openOrders()`/`queueDepth()` 跳过 | 撤单未确认时 pending 归零，重复下单 | §6.9 `OrderBookView` 保留到 terminal |
| 线程边界 | 主循环做策略/下单/持仓覆盖/PnL/drain；`qf-order-events`、`qf-local-risk`、`qf-runner-state`、`qf-closeout`、shutdown hook 各自碰共享状态 | 无单写者；buffer/publication 多写者 | §4 所有权表；buffer 独占 |
| 热加载 | loop 内同步 stop/start；新策略吃 latest 缓存；旧挂单靠一次 cancel 尝试 | 旧成交被当“旧事件”丢；幽灵仓位 | §9 reload 状态机 + orphan fill |
| sequence/tradeId | CTP order `sequence` 是全局；tradeId 当日唯一；dedup 只按 tradeId 且 100k LRU 非线程安全 | per-order gap 误判；跨日误杀；dedup 文件损坏 | §5.5 stream-global 语义；dedup key 加 tradingDay + journal |
| 快照假新鲜 | `ControlPlaneVenueAccountPort` 成功即本地时间、`stale=false`；PositionSnapshot 只有 long/short/avg | READY/drain flat 建立在假字段上 | §7 透传 asOf/stale + 全字段 |
| 无持久账本 | `Portfolio` 纯内存；无 WAL/最后应用位点 | 重启只能靠快照猜 | §6.8 WAL + checkpoint |
| loop 内 JDBC/文件 IO | `DeploymentConfigLoader.load` 每 5s；`Files.exists(killFile)` 每轮；`reportHotState` 5s | 违约硬约束 | §11 调用点表 |

### 2.2 评审后代码事实（2026-11-14，`fd81cae` 之后）

本节只记录“设计假设是否成立”，不作为 Rev3 关闭依据。

| 项 | 当前代码 | 对 Rev3 的影响 |
|---|---|---|
| `ControlPlaneVenueAccountPort` 数据源 | 已改读 `/api/v1/strategy-center/accounts/{accountId}` 的 account/positions 投影，不再是 `/strategy-runtime/risk` | P0-3 的“数据源”方向已落地；仍缺 `requestSeq`、`strategyKey/scope`、`AccountSnapshot` 全字段、`positionAsOf` 独立语义 |
| `Instant.now()` fallback | account/positions 的 fallback 已改为 `Instant.EPOCH` | 行为测试仍需覆盖“缺 serverTime/缺行 asOf/缺 staleAfterMs”三种；`DEFAULT_STALE_AFTER_MS=15s` 仍硬编码 |
| `Snapshot` 字段 | 已有 `asOf/stale/staleAfterMs/tradingDay/snapshotId/source`，无 `requestSeq/scope` | Port API 仍要加字段，flat 谓词才可实现 |
| `TradeEnvelope` | Java record 无 `tradingDay`；SBE `TradeV2` 无该字段 | §6.3 的 dedup 需要消费侧注入，不能按 timestamp 推 |
| `VenueSession` | 无 `lastSeqByStream[]` | §7.1 要补字段 + 持久化 schema |
| `VenueMarketDataPort` | 有 `gapSink` 默认重载，但默认实现丢弃 gap；无 reset/snapshot API | §10.4 要把 reset 变成接口，不是实现类方法 |
| `AeronVenueExecutionPort` | 只校验 venue/account + per-order `lastOrderSequence`，无 epoch/fencing/deploymentGeneration | §5.6 要接 `EpochGuard/FencingGuard` |
| `AeronOrderGateway` | 仍持有 `positions/orders`、单 buffer、risk 线程 reconcile、poll 线程 cancel | §14.2 M0b 删除；M3 删除调用点 |
| `Portfolio` | 仍按 `instrumentId`；`replacePosition/clearPositions` 仍在 | §6.1 key 切换；M0b 删除热路径 |
| `AeronStreams`/`AeronOrderGateway` 默认值 | 仍有 `1001`、`"*"`、`"SIM"`、`"legacy"`、`SHADOW` 回退路径 | §14.1 M0a 门禁删除 |

### 2.3 本版结论

- 设计层：R2 的 12 个 P0 全部有“字段 + 状态机 + 失败路径 + 退出证据”；其中 P0-4/5/6/7 原本已关闭，本版只做一致性维护。
- 代码层：只有 `fd81cae` 的数据源切换可视为 P0-3 的局部落地；WAL、PositionKeeper、OrderBookView、spool、MD reset、clock 注入均未实现。
- 因此 §14 的阶段准入仍按“退出证据”卡，不按“设计已写”放行。

## 3. trading 对照

C++ trading 的 `ShmManager.loopMD` 轮询共享内存后调 strategy callback，本质仍是 **poll 包装成 callback**，不是内核 push。可借鉴的是分层与生命周期，不是共享内存。

可借鉴：

- poll 固定在 I/O 层，策略层只看到 callback/事件。
- 单策略线程串行、策略内无锁。
- session/epoch/fencing、closeout、drain 是一等生命周期。
- 队列满/断流显式降级，不静默跳过。

不可照搬：

- 单进程共享内存与策略直接读写 SHM 环。Aeron 是跨进程日志，有 backpressure/sequence，应使用这些能力，不复制 head/tail。
- 所有线程 busy-spin。Java 用有界 backoff；I/O 线程单次阻塞预算 <100µs。
- I/O 线程直接执行策略或写组合。
- “回调即成交确认”。`submit` 只表示已发布，成交只认 `TradeEnvelope`。

## 4. 目标架构与线程模型

### 4.1 组件图

```text
 CTP_CPP / SIM_JAVA / REPLAY_JAVA adapter
        │  Aeron + SBE（ADR-004 冻结的 channel/stream/字段）
        │  L0：req-spool（runner→venue）/ evt-spool（venue→runner）
        ▼
┌──────────────────────── I/O 层（decode / filter / guard / enqueue）────────────────────────┐
│ qf-venue-md-<venue>          qf-venue-exec-<venue>         qf-venue-account-<venue>       │
│ poll + scope seq/gap         poll + dedup + seq/epoch      snapshot/session poll           │
│ MdEvent ring + LatestSlot    exec queue + shadow tee       SnapshotSlot(requestSeq)       │
└──────────────┬───────────────────────┬───────────────────────────┬────────────────────────┘
               ▼                       ▼                           ▼
        MdPipe(lossless)          execQueue(有界)             SnapshotSlot(版本化)
               └───────────────────────┼───────────────────────────┘
                                       ▼
                         qf-strategy-loop（唯一策略线程）
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
  PositionKeeper                 OrderBookView                    RiskView
  （唯一持仓写者）                （唯一订单写者）                  （只读缓存）
        └──────────────── Strategy callbacks（串行）────────────────┘
                                       │
                                       ▼
                                   OrderSink
                                       │
                                       ▼
                         VenueExecutionPort.submit / cancel
                                       │
                                       ▼
                            Aeron publication（loop 单写者）
                                       │
                                       ▼
                              WAL（mmap，ledger 线程 fsync）
```

### 4.2 线程与所有权

| 线程 | 拥有 | 允许 | 禁止 |
|---|---|---|---|
| `qf-venue-md-<venueId>` | MD subscription、scope seq tracker、per-scope ring/slot | 解码、seq/gap、写 ring/slot、投 `SeqCursorUpdate` | 写 Portfolio/订单、调策略、发单、HTTP、文件 IO |
| `qf-venue-exec-<venueId>` | exec subscription、venue/account 过滤、epoch/fencing guard、trade 快速去重、per-order filter cache | 解码、快速去重、seq/epoch、入 exec queue、shadow tee | 写 canonical 订单/持仓、调策略、cancel、publication、HTTP |
| `qf-venue-account-<venueId>` | 账户/持仓/session 快照轮询（默认 2s） | 写版本化 SnapshotSlot，带 `requestSeq` | 参与决策、写 PositionKeeper |
| `qf-control-plane` | 配置/部署/registry/risk/indicatorGate 拉取、lease、kill-file 监听、热加载构建、指标上报 | 构建新策略、写 RiskCache/Control 事件 | 直接改策略状态、写订单/持仓、发单 |
| `qf-strategy-loop` | PositionKeeper、OrderBookView、RiskView、Strategy、Timer、Closeout、reload/shutdown 状态机、order publication | 处理事件、应用成交、生成 intent、publish | 任何阻塞调用（HTTP/JDBC/文件 IO/同步刷盘/长 sleep） |
| `qf-ledger` | WAL 文件、fsync、rotate、checkpoint | 持久化、发布 durableLsn | 决策、发单 |
| `qf-seq-cursor` | MD `lastSeqByStream` 持久化文件 | 原子写 cursor | 决策、发单 |
| `qf-shadow` | M1 shadow 消费者、shadow 指标 | 只读复制事件、独立队列 | 反压生产路径、写账本 |
| `qf-alerts` / `qf-telemetry` | 告警、指标、PnL 外发 | 异步 HTTP/Aeron | 回写运行态 |

补充规则：

- 不存在 `qf-local-risk` 决策线程。风险检查是 loop 内的纯函数；控制面只提供快照。
- 不存在 `qf-closeout` 决策线程。closeout 由 loop 的 session timer 驱动。
- 不存在 `qf-runner-drain` 决策线程。shutdown hook 只投 `Control(SHUTDOWN)`。
- 旧 `qf-runner-state` 的职责并入 `qf-control-plane`。

### 4.3 单写者不变量

| 对象 | 唯一写者 | 其他线程如何读 | 强制手段 |
|---|---|---|---|
| Aeron order/cancel publication | loop | 不读 | `Thread.currentThread()` 断言；每个 publication 一个 writer |
| `UnsafeBuffer`（编码） | 所属 publication 的 writer | 不共享 | 一个 publication 一个 buffer；禁止字段级共享 |
| `PositionKeeper` | loop（含 BOOTSTRAP 重放） | 导出不可变 `PositionSnapshot` | 入口断言 + 包可见性 |
| `OrderBookView` | loop | 导出不可变 `OrderView` | 入口断言 |
| `RiskView` | loop（从版本化槽拷贝） | control 线程只写槽 | 槽版本号；loop 记录已消费版本 |
| `Closeout` | loop | 不读 | 定时器只在 loop |
| `deploymentGeneration` / `commandGeneration` | loop | control 只读副本 | reload 状态机 |
| shutdown 状态 | loop | hook 只置 atomic + 投事件 | hook 不碰 gateway/port |
| WAL 追加 | loop | ledger 只读已追加段 | 单生产者；LSN 单调 |
| WAL fsync/rotate | ledger | loop 只读 durableLsn | 单写者 |
| MD `lastSeqByStream` 内存态 | md I/O | loop 只读快照 | seq-cursor 线程只写磁盘副本 |

`RiskView` 的写法要特别说明：control 线程拉取后写 `RiskCacheSlot`（immutable + version）；loop 在每批事件开始时如果发现版本变化，才拷贝进 `RiskView`。这样 `RiskView` 仍然只有 loop 一个写者，控制面线程永远不直接改策略可见状态。

`OrderBookView` 不保存“决策用 pending”之外的任何 venue 私有状态。`qf-venue-exec` 可以保留一个 **filter cache**（per-clientOrderId 的 lastSequence、terminal 标记）用于快速丢重复/回退，但该缓存：

- 只服务过滤，不暴露给策略；
- 可由 stream 重放重建；
- 与 `OrderBookView` 冲突时，以 loop 的 `OrderBookView` 为准；
- 不得用于撤单、风控或敞口计算。

`qf-venue-exec` 的 trade dedup 只是**快速过滤**，不能是唯一防线：canonical 幂等键 `(venueId, tradingDay, tradeId)` 在 loop 的 `applyTrade` 里，由 journal + WAL 保证。I/O 过滤不得把一笔真实成交永久丢弃；不确定时宁可入队，让 loop 去重。

### 4.4 loop 主循环伪代码与预算

```java
while (running) {
    // 1. control 优先；容量 1024，时间预算 200µs
    for (ControlEvent c : controlQueue.drain(MAX_CONTROL_PER_ROUND)) {
        applyControl(c);                    // RELOAD/DRAIN/CLOSEOUT/SHUTDOWN/KILL/RECONNECTED
        if (budgetExceeded(200, MICROS)) break;
    }
    if (fatalSlot.isPresent()) { fatalShutdown(fatalSlot.get()); break; }

    // 2. 执行事件：512 个或 200µs 双上限；每 64 个检查 control/fatal
    int execCount = execQueue.drain(EXEC_BUDGET, EXEC_TIME_BUDGET, this::applyExec);

    // 3. 快照槽：只在版本变化时应用
    applySnapshotSlots();

    // 4. 行情：lossless ring 优先；2048 个或 200µs
    int mdCount = mdPipe.drainLossless(MD_BUDGET, MD_TIME_BUDGET, this::onMdEvent);
    mdPipe.publishLatestIfChanged(strategy);   // 只在版本变化时投递

    // 5. timer / closeout / delta
    fireDueTimers(nowNanos());
    flushDeltas();                             // PositionDelta 在 apply 后批量产生

    if (execCount == 0 && mdCount == 0 && controlQueue.isEmpty()) {
        backoff.idle();                        // parkNanos(50µs)，最长 1ms
    }
}
```

预算常量（可配，但必须有默认值）：

```text
MAX_CONTROL_PER_ROUND = 1024           // 队列容量；每轮全 drain 的上限
EXEC_BUDGET           = 512 events     // 或 200µs
MD_BUDGET             = 2048 events    // 或 200µs
CONTROL_CHECK_EVERY   = 64 events
IDLE_PARK             = 50µs, max 1ms
```

`applyExec` 的固定顺序：`Fill`（先记账）→ `OrderUpdate`（更新订单簿，终态粘滞）→ `ReconcileReport`。同一批里如果先收到 OrderUpdate 后收到 Fill，`OrderBookView` 用 `filledQty=max(累计, ΣtradeQty)` 收敛，不要求 wire 顺序。

### 4.5 exec 批内顺序

同一 instrument 的 Fill/OrderUpdate 可能来自不同 stream，V3 不假设 wire 全序。批内规则：

1. 先应用所有 Fill：`PositionKeeper` 的 `netQty` 只依赖成交集合，顺序无关。
2. 再应用 OrderUpdate：`filledQty = max(updateCumQty, tradeQty)`；终态不可回退。
3. 最后应用 ReconcileReport：若 report 的 `requestSeq` 早于本地已应用的成交水位，只审计，不覆盖。
4. 同一 `clientOrderId` 的 OrderUpdate 用 `sequence` 做同订单回退过滤；`sequence` 不用于推断跨订单 gap。
5. Fill 的 `eventTime` 回退只影响 `avg/realized` 与 `netQtyAt` 窗口，不影响 `netQty`。

## 5. 事件模型与投递契约

### 5.1 事件类型

```java
sealed interface RuntimeEvent permits FillEvent, OrderUpdateEvent, ReconcileReport,
        SnapshotEvent, MdEvent, LatestQuote, MdReset, ControlEvent, TimerEvent, FatalEvent {}

record FillEvent(TradeEnvelope trade, TradingDay tradingDay,
                 long ingressSeq, long ingressNanos) {}
record OrderUpdateEvent(OrderUpdateEnvelope update, TradingDay tradingDay,
                        long ingressSeq, long ingressNanos) {}
record ReconcileReport(String reportId, Snapshot<List<PositionSnapshot>> venue,
                       List<OpenOrderView> openOrders, long requestSeq, Instant requestedAt) {}
record SnapshotEvent<T>(Snapshot<T> snapshot) {}
record MdEvent(MarketDataEnvelope envelope, long ingressSeq, long ingressNanos) {}
record LatestQuote(MarketDataEnvelope envelope, long slotVersion, long ingressNanos) {}
record MdReset(MdScope scope, long seq, Instant asOf, String snapshotId,
               MdResetSource source) {}
record ControlEvent(ControlCommand command, long controlSeq, long deadlineNanos) {}
record TimerEvent(long nowNanos, TimerKind kind) {}
record FatalEvent(FatalCause cause, long atNanos) {}
```

`FatalEvent` 只用于审计/上报，**不进 control 队列**；fatal 走独立 `FatalSlot`（§5.3）。

`TradingDay` 是值对象：

```java
record TradingDay(String yyyymmdd) {   // 例 "20261117"；夜盘 21:00 属于下一交易日
    TradingDay { if (!yyyymmdd.matches("\\d{8}")) throw new IllegalArgumentException(); }
    boolean isBefore(TradingDay other) { return yyyymmdd.compareTo(other.yyyymmdd) < 0; }
}
```

`Fill`/`OrderUpdate`/`Control` **不共用一个 FIFO**。`Control` 有自己的队列，`Fill`/`OrderUpdate` 走 exec 队列，`Snapshot`/`Risk` 走版本化槽，`MdEvent`/`LatestQuote` 走 MD 管道。

`TradeEnvelope` 的消费侧扩展（不改 SBE）：

```java
record TradeEnvelope(..., long sourceSessionId, long sourcePublicationEpoch,
                     TradingDay tradingDay) {}
```

- `TradeV2` wire 没有 `tradingDay`。`qf-venue-exec` 在解码时用 `(venueId, sourceSessionId, sourcePublicationEpoch)` 查 `TradingDayResolver`，值来自 `VenueSession.tradingDay` 或 adapter 在 session 消息中声明的交易日。
- 解析不到时：该事件进入 `pendingTradingDay` 有界队列（每 session 最多 4096 条），最多等 5s；仍解析不到 → `FatalExecutionException(TRADING_DAY_UNKNOWN)`。**禁止用 `timestamp` 的本地日历日代替。**
- `TradeV2` 的 `tradeId` 唯一性按 `(venueId, tradingDay, tradeId)`；`venue-contract.md` 的“全局唯一”是本设计要修订的文档依赖（§16.4）。

### 5.2 通道、容量与失败策略

| 通道 | 结构 | 默认容量 | 满时行为 | 指标 |
|---|---|---|---|---|
| control | MPSC 有界队列 | 1024 | `ControlOverflow` → 进程 fatal；绝不丢 | `control_queue_depth`、`control_overflow_total` |
| exec | MPSC 有界队列 | 262144 事件或 128MiB 估算 | offer 失败 → 立即 `FatalExecutionException`；不自旋、不阻塞、不落 runner 磁盘 | `exec_queue_depth`、`exec_dropped_total`、`exec_fatal_total` |
| fatal | 单槽 `AtomicReference<FatalCause>` | 1 | CAS 写入；重复 fatal 只计数 | `exec_fatal_total` |
| snapshot | 每 `(account, kind)` 一个版本化槽 | 1（latest） | 覆盖旧值；`requestSeq` 必须递增 | `snapshot_superseded_total`、`snapshot_age_ms` |
| MD lossless | 每 `MdScope` 有界 ring | 256 条/scope；总预算 64MiB | 该 scope `md_lost_no_image_total++`，进入 WARMUP，**不静默丢** | `md_lost_no_image_total` |
| MD latest | 每 `(venue, exchange, instrument)` 一个 slot | 1 | 覆盖；记录被覆盖次数与 `slotVersion` | `md_superseded_total` |
| req-spool | adapter 侧预分配 append-only 分段 | 默认 min(2GiB, 10% 空闲磁盘) | 见 §8.3；90% 停新 OPEN，100% fatal | `spool_bytes`、`spool_replay_total` |
| evt-spool | adapter 侧预分配 append-only 分段 | 同上 | 见 §8.3；publication null/断连即写 | `evt_spool_bytes` |
| alert | MPSC 有界队列 | 1000 | 丢弃 + 计数 + 降级日志 | `alert_dropped_total` |
| telemetry | MPSC 有界队列 | 8192 | 丢弃 + 计数 | `telemetry_dropped_total` |

**I/O 线程阻塞预算**：单次回调 p99.9 <50µs、max <100µs；禁止 `park`/`sleep`/`fsync`/HTTP/JDBC；自旋等待最多 1,000 次 CPU pause，超过即按失败策略处理。任何“等 1 秒再抛异常”的实现都视为设计违约。

adapter 侧 outbound 的阻塞预算单独定义（§8.3，≤5ms），只作用于 C++ adapter 线程，不适用于 runner 的 Java I/O 线程。

### 5.3 fatal 语义

`FatalExecutionException` 是进程级错误，不是普通业务异常。

```java
final class FatalSlot {
    private final AtomicReference<FatalCause> cause = new AtomicReference<>();
    boolean raise(FatalCause c) { return cause.compareAndSet(null, c); }
    Optional<FatalCause> get() { return Optional.ofNullable(cause.get()); }
}

// 事件分发：只有非 fatal 的 RuntimeException 允许被记录后继续
void dispatch(ExecutionSink sink, TradeEnvelope trade) {
    try {
        sink.onTrade(trade);
    } catch (FatalExecutionException e) {
        throw e;                     // 绝不被 listener 层吞掉
    } catch (RuntimeException e) {
        metrics.listenerError++;
        logAsync("listener error (non-fatal)", e);   // 只允许异步/有界日志
    }
}

// I/O 线程顶层：offer 返回 false 才是真丢，计数后 fatal
void onTradeFromAeron(TradeEnvelope trade) {
    if (!execQueue.offer(new FillEvent(trade, resolveTradingDay(trade),
            nextIngressSeq(), System.nanoTime()))) {
        metrics.execDroppedTotal.increment();
        fatalSlot.raise(FatalCause.EXEC_QUEUE_FULL);
    }
}
```

fatal 处理顺序（loop 或 watchdog 执行）：

```text
1. closing = true；OrderSink 立即拒绝新 OPEN（CLOSE/CANCEL 仍可发）
2. loop 不再应用非账本事件；把 pending 的 Fill/OrderUpdate 尽量 drain 完
3. WAL flush 到 durableLsn（上限 5s）；写 HANDOFF（未 flat 时）
4. loop 关闭 publication；I/O 线程只置位，不 close
5. watchdog 10s 到点仍卡住 -> Runtime.halt(70)
```

`exec_dropped_total` 的语义：**已经确认无法进入 runner 账本的事件数**。正常运行必须恒为 0；一旦大于 0，进程必须 fatal，不允许继续交易。

fatal 时不允许把“日志记录成功”当作已处理；listener 实现不得捕获并吞掉 `FatalExecutionException`。`publication.close()` 只能由 loop 在 `fatalShutdown()` 中执行。

### 5.4 `submit` / `cancel` 的结构化结果

```java
record OrderSubmission(String requestId, boolean acceptedForPublication,
                       SubmitReason reason, boolean retryable, long retryAfterMs) {}
record CancelSubmission(String requestId, boolean acceptedForPublication,
                        SubmitReason reason, boolean retryable, long retryAfterMs) {}

enum SubmitReason {
    ACCEPTED,               // 已交给 publication
    REJECTED_VALIDATION,    // 参数/身份/合约不合法，不可重试
    REJECTED_RISK,          // 本地风控拒绝，不可原样重试
    REJECTED_LIMIT,         // max open orders / throttle，可在状态变化后重试
    BACKPRESSURE,           // Aeron offer 失败，可重试（带 retryAfterMs）
    PUBLICATION_CLOSED,     // publication 断连/为空/关闭，重连后可重试
    TIMEOUT_UNKNOWN,        // 发布结果未知，禁止盲目重试，必须按 clientOrderId 对账
    FATAL                   // 进程正在停止
}
```

规则：

- `acceptedForPublication=true` 只表示“已发布”，不表示 ACK/成交。
- `retryAfterMs` 由 Port 给出；Port 不给时 loop 用自己的指数 backoff，默认 10ms 起、最大 250ms。
- `TIMEOUT_UNKNOWN` 时 `OrderBookView` 保留 reservation，必须通过 venue `ORDER_SNAPSHOT` 或后续 OrderUpdate 消解。
- 任何 `retryable=true` 的重试必须复用同一个 `intentId`；`retryable=false` 不允许换参数重试。
- 指标：`order_submit_total{reason=...}`、`order_submit_retry_total`、`order_submit_unknown_total`。

### 5.5 幂等键与顺序

| 对象 | 键/规则 | 说明 |
|---|---|---|
| Trade 幂等 | `(venueId, tradingDay, tradeId)` | CTP TradeID 当日唯一；跨日必须区分，禁止只用 tradeId |
| Dedup 持久化 | WAL `FILL_ACCEPTED` + checkpoint watermark；journal 只是加速索引 | 恢复以 checkpoint + WAL 为准；journal 只到 checkpointLsn |
| `filledQty` | `max(orderUpdateCumulative, Σ tradeQty by clientOrderId)` | trade 增量永不直接加到累计值上 |
| Order 状态 | 终态粘滞：`FILLED/CANCELED/REJECTED` 不可回退 | `CANCEL_REQUESTED` 不是终态 |
| OrderUpdate sequence | stream-global，只用于同订单回退过滤 | 不推断 per-order gap |
| MD sequence | 按 `(venueId, sourceSessionId, epoch, exchange, instrumentId)` | gap 后阻塞到 snapshot/reset |
| Intent 幂等 | `intentId`，策略生成，跨重试稳定 | `recentIntents` 有界 LRU + WAL 恢复；结果必须持久化 |

`recentIntents` 必须记录结果，而不能只记录 key：

```text
ACCEPTED / TIMEOUT_UNKNOWN / PENDING_RETRY / PUBLISHED
                           -> 同 intentId 再次提交直接返回 DUPLICATE，不再 publish
REJECTED_LIMIT / BACKPRESSURE / PUBLICATION_CLOSED
                           -> 允许同 intentId 重试（重新做风控与限额检查）
REJECTED_VALIDATION / REJECTED_RISK
                           -> 同 intentId 再次提交返回原拒绝，不 publish
```

`OrderUpdateV2.sequence` 的精确语义（与 ADR-004 §5.2 一致）：

```text
scope = (venueId, sourceSessionId, sourcePublicationEpoch)
含义  = 该 stream 上所有订单更新的全局单调序号
用途  = 丢弃同一 clientOrderId 的回退/重复更新
禁止  = 用 seq+1 推断“这个订单缺了一条更新”
        缺失的中间序号可能属于其他订单
```

per-order 完整性只能来自 `status/filledQty/tradeId` 与 venue 的订单/成交快照对账。

**dedup 的线程安全与窗口**：

```text
权威 dedup：只在 loop 线程；按 tradingDay 两代结构 current/previous。
  - 每个 key 存 (tradeIdHash, tradeId, tradingDay)，不驱逐；容量按当日成交数增长。
  - 超过 dedupMaxEntries（默认 1,000,000）-> fatal（不能降级为概率去重）。
  - 重启时从 checkpoint + WAL 重建；journal 只到 checkpointLsn，不用于跳过 WAL。
I/O 快速过滤：每线程独立、容量 4096、只做“确定见过”的拒绝；false negative 允许。
  禁止共享 LinkedHashMap；禁止在 I/O 线程 checkpoint。
窗口：至少覆盖 max(2 * snapshotPeriod, 1 个交易日)；
  previous day 只在 checkpoint 记录 dedupWatermark 且 current day 已稳定后释放。
```

### 5.6 exec accept 管线（EpochGuard/FencingGuard 接线点）

执行 I/O 的 `accept()` 固定顺序，任何一步失败都不能静默丢：

```text
1. decode SBE -> envelope
2. identity: venueId/accountId 必须等于订阅配置；否则丢并计数（不是本 runner 的事件）
3. strategyKey: 不在这里过滤；空/未知 -> 标记 orphan=true，交给 loop 归属
4. EpochGuard:
     incoming.sourceSessionId/epoch < current -> stale
     OrderUpdate stale -> 只审计，不进 canonical book
     Fill stale -> 仍必须进入 exec queue（由 loop 应用并标记 orphan）
5. FencingGuard:
     currentFencing > 0 && incoming.fencingToken == 0 -> reject
     incoming.fencingToken < currentFencing -> reject
     sourceSessionId 由 adapter 持久化单调分配；回退 -> stale，不能靠 epoch 前进洗白。
     adapterSessionId 只用于区分进程重启；与 sessionId/epoch 一起进入审计。
6. sequence:
     OrderUpdate: seq <= lastSeqByStream -> duplicate，丢弃
     OrderUpdate: seq > lastSeqByStream + 1 -> order_gap_total++，置 ExecGap
     Trade: 无 seq；不推断 gap，只做快速 dedup
7. trade 快速 dedup（非权威）
8. enqueue；失败 -> fatal
9. shadow tee（M1，仅复制值，不共享 DirectBuffer）
```

`deploymentGeneration` 只限制策略命令，不限制 Fill/仓位事实；旧 generation 的 Fill 仍进入 loop，由 `applyTrade` 应用并计 `orphan_fill_total`。

`ExecGap` 的处置：

```text
ExecGap 状态：禁 OPEN；保持 CLOSE/CANCEL。
动作：
  - 向 venue 请求 ORDER_SNAPSHOT（按 account）
  - 向 venue 请求 TRADE_SNAPSHOT 或 position snapshot（若 capability 支持）
  - 用快照重建 working/terminal 与 netQty 基线
  - 对账完成且无 drift -> READY；否则 RECONCILING/REDUCE_ONLY
不允许“跳过缺失 seq 继续”。
```

### 5.7 下单重试状态机（P1-10）

`PENDING_RETRY` 不是“等外部再调用一次”，而是 loop 内部的显式状态：

```java
enum IntentState { NEW, RESERVED, PUBLISHED, PENDING_RETRY, TIMEOUT_UNKNOWN,
                   ACCEPTED, REJECTED_FINAL }

// flush 在每轮回调结束后执行
void flushRetries(long now) {
    for (PendingIntent p : retryQueue.due(now)) {
        if (p.state() == PENDING_RETRY) {
            OrderSubmission r = port.submit(p.request());   // 绕过 duplicate 检查
            switch (r.reason()) {
                case ACCEPTED -> { p.state(PUBLISHED); orderBook.onPublishResult(p, r); }
                case BACKPRESSURE, PUBLICATION_CLOSED -> {
                    if (now >= p.submitDeadlineNanos()) {
                        p.state(TIMEOUT_UNKNOWN);
                        reduceOnly = true;
                        alert(DRAIN_INCOMPLETE, p.intentId());
                    } else {
                        retryQueue.reschedule(p, now + r.retryAfterMs());
                    }
                }
                case TIMEOUT_UNKNOWN -> { p.state(TIMEOUT_UNKNOWN); reduceOnly = true; }
                default -> { p.state(REJECTED_FINAL); orderBook.release(p); }
            }
        }
    }
}
```

规则：

- 外部同 `intentId` 在 `PENDING_RETRY` 期间再次提交 → 返回 `DUPLICATE_IN_FLIGHT`，不重复 reserve、不重复 publish。
- `submitDeadline` 默认 3s；超时后风险增加 intent 保持 reservation 并进入 REDUCE_ONLY；撤单/平仓继续重试。
- 任何情况下不得把“未发出”当成“已发出”，也不得静默丢弃 intent。
- 该状态机同时适用于 runner publication 和 adapter outbound：可用则发，不可用则 durable spool/fail-stop。

## 6. 唯一账本：PositionKeeper、OrderBookView、WAL

### 6.1 所有权、scope 与账户独占

```text
PositionKey        = (venueId, accountId, strategyKey, instrumentId)   // 策略账本
AccountPositionKey = (venueId, accountId, instrumentId)                // 账户真值镜像
```

- `strategyKey` 在 runner 生命周期内**不可变**；V3 中 `strategyKey = strategyId`。`RELOAD_PREPARE` 若发现 `next.strategyKey != current.strategyKey`，直接 `RELOAD_REJECTED_STRATEGY_KEY_CHANGED`，不做仓位转移。
- V3 采纳 **1 account = 1 active runner = 1 strategyKey**；这是启动强校验，不是假设。多策略共享账户不在 V3 范围。
- 两套账本、一条成交路径：
  - `PositionKeeper` 只持有 `PositionKey`，供策略/风控/平仓使用。
  - `AccountLedger` 只持有 `AccountPositionKey`，接收同一批 Fill（含 orphan/manual），供对账与 drain 判断使用。
  - 同一 `FillEvent` 先写 WAL，再应用：策略 Fill 同时应用 `PositionKeeper` 与 `AccountLedger`；orphan/manual Fill 只应用 `AccountLedger`，不进入 `PositionKeeper`/`OrderBookView`/策略 PnL。
- 账户独占是启动强校验，不是运维约定：
  - DB 唯一约束：`strategy_deployments(venue_id, account_id)` 在 `STARTING|RUNNING` 状态唯一。
  - lease：`runner_leases(venue_id, account_id, owner_id, fencing_token, expires_at)`；runner 启动先 `acquire`，每 2s `renew`；续租失败超过 `leaseGraceMs=5s` → `REDUCE_ONLY` + fatal。
  - 第二个 runner 绑定同一 account → 启动直接失败（`ACCOUNT_ALREADY_OWNED`），不进入 WARMUP。
- manual / blank strategy Fill 归属：
  - `TradeEnvelope.strategyKey` 为空或不属于当前 runner → `ORPHAN_ACCOUNT_FILL`。
  - 只进入 `AccountLedger`，不进入 `PositionKeeper`，不触发 `onFill`，不参与策略 PnL。
  - 计入 `orphan_account_exposure`（manual/blank/unknown strategy）；已知的其他策略仓位计入 `foreign_strategy_exposure`。两者都使 `flat()` 为 false；默认禁止自动 flat，必须 operator handoff 或先人工处理。
  - 不能静默丢，也不能静默算进策略账本。
- 多策略共享 loop 不在 V3 范围内；若未来需要，必须每策略一个 `PositionKeeper`，并且 `AccountLedger` 单独维护，不能共用 instrument map。
- `Portfolio` 降为只读聚合：不再持有可变仓位，不再提供 `replacePosition/clearPositions` 热路径；`PortfolioSnapshot` 只是 `PositionKeeper` 的导出视图。

### 6.2 Position 状态与 avg 拆分

```java
final class PositionState {
    TradingDay tradingDay;
    long todayLong, todayShort, yesterdayLong, yesterdayShort;

    // 账本 avg：只由 WAL 顺序的成交计算，风控/结算/对冲都不读它做价格判断
    double ledgerLongAvg, ledgerShortAvg;

    // 展示 avg：可由可信快照的 longAvgPrice/shortAvgPrice 重算，只读
    double displayLongAvg, displayShortAvg;

    double settlementPrice;
    double realized, fees;
    long version;                 // per PositionKey 单调
    boolean avgOrderUncertain;    // eventTime 回退或历史超窗
    boolean fillHistoryComplete;  // 供 netQtyAt 判定
}
```

`netQty = (todayLong + yesterdayLong) - (todayShort + yesterdayShort)`。

规则：

- **风控/对冲只能用 `netQty`、lot 分解与 pending；不得用 `ledgerAvg` 或 `displayAvg` 做开平仓决策。**
- `ledgerAvg` 是账本字段：只由 `applyTrade` 按 WAL 顺序更新；快照不得覆盖。
- `applyPriorDay(fill)` 只更新 `yesterday*` lot 与对应 avg/realized，不进入新日 `today*`；用于日切后的迟到成交。
- `displayAvg` 是展示字段：可由可信快照重算；重算只写 `displayAvg`，不写 `ledgerAvg`，不改变 `realized`。
- `settlementPrice` 只来自 venue/结算快照；缺失时保持 `0` 并标记 `settlementUnknown`，不得用本地 avg 代替。
- `realized` 是账本估算，按到达顺序；venue `closeProfit` 是展示/结算真值，两者不得混用。
- `cash` 只在 `AccountLedger` 维护；策略账本不持有 `cash`，避免多策略/手工单混账。
- `PortfolioSnapshot` 的 `cash/realized/fees` 是只读聚合；`cash -= notional + fee` 必须乘 `multiplier`，与 `realized/unrealized` 口径一致。

`PositionDelta` 是 per-instrument、增量语义；组合级视图单独用 `PortfolioSnapshot`，不混在 delta 里：

```java
record PositionDelta(String venueId, String accountId, String strategyKey,
                     String instrumentId, long netQty,
                     long todayQty, long yesterdayQty, long pendingQty,
                     double displayAvg, double realizedDelta, double feesDelta,
                     long version, long asOfNanos) {}

record PortfolioSnapshot(double realized, double fees, double cash,
                         long version, long asOfNanos) {}
```

`version` 是 per-`PositionKey` 单调；策略用 `(instrumentId, version)` 做幂等，不假设全局有序。

### 6.3 成交应用（唯一路径）

```java
boolean applyTrade(FillEvent f) {
    TradeEnvelope t = f.trade();
    TradingDay day = f.tradingDay();                 // 来自 VenueSession/adapter，不用 timestamp 推
    require(t.venueId(), t.accountId(), day);
    if (t.tradeId() == null || t.tradeId().isBlank()) {
        throw new FatalExecutionException("tradeId missing");   // 不可去重 = 不可记账
    }

    boolean orphan = isOrphan(t);          // blank/other strategyKey 或不属于本 runner
    boolean priorDay = day.isBefore(ledger.tradingDay());

    // 日切后的迟到成交：若已被新日快照覆盖，只审计，不重复记账
    if (priorDay && lastTrustedSnapshot != null
        && f.eventTimeNanos() <= lastTrustedSnapshot.asOfNanos()) {
        audit(LATE_FILL_COVERED_BY_SNAPSHOT, t);
        return false;
    }

    DedupKey key = new DedupKey(t.venueId(), day, t.tradeId());
    if (!dedup.firstSeen(key)) {          // loop 单线程；权威集合，不驱逐
        metrics.execDuplicateTotal.increment();
        return false;                     // 只计数，不重复记账
    }

    if (!replayMode) {
        wal.append(FILL_ACCEPTED, contextOf(t), t, f.ingressNanos());
    }

    // 账户真值镜像：strategy + orphan/manual 都进入
    accountLedger.apply(t);

    if (orphan) {
        // 不进入 OrderBookView / PositionKeeper / 策略 PnL
        metrics.orphanFillTotal.increment();
        orphanAudit.record(t, priorDay);
        if (!replayMode) strategy.onOrphanFill(ctx, Fill.from(t));  // 默认告警
        return true;
    }

    OrderState order = orderBook.onTrade(t);   // 未知订单 -> UNKNOWN_ORDER，不丢
    PositionState p = positionKeeper.get(positionKeyOf(t));
    if (priorDay) {
        p.applyPriorDay(t);                // 只改 yesterday lot；不进入新日 today
        audit(LATE_FILL_APPLIED_TO_PRIOR_DAY, t);
    } else {
        p.apply(t);                        // 只在这里改 today/yesterday/ledgerAvg/realized/fees
    }
    order.tradeQty += t.qty();             // 仅用于 filledQty 的 max()
    order.filledQty = Math.max(order.updateCumQty, order.tradeQty);
    p.version++;
    if (!replayMode) {
        emit(new PositionDelta(...));      // 同轮产生；批次末 flush
        strategy.onFill(ctx, Fill.from(t)); // 每笔首次成交恰好一次
    }
    return true;
}
```

关键规则：

- **成交只应用一次**：dedup 在 `applyTrade` 入口，WAL 重放也走同一入口。
- **refresh 不覆盖已确认成交**：`PositionEnvelope`/`PositionSnapshot` 只进入 `ReconcileReport`，不直接调用 `replacePosition`；只有 `POSITION_RESET` 控制事件（带 operator/snapshotId/requestSeq）才能重置。
- **未知订单的成交**：`OrderBookView` 创建 `UNKNOWN_ORDER` 临时记录，标记 `needsOrderSnapshot`，保留在审计集合中（不计入 `pendingOpen`）；不允许因为“订单簿没有”而丢成交。
- **策略抛异常不影响账本**：`onFill` 在账本更新之后调用；策略异常只把策略置为 `STRATEGY_FAULT`（reduce-only），不回滚仓位。
- **apply 失败即 fatal**：`applyTrade` 的 WAL 追加、去重、仓位更新任一步失败，都不得“跳过这笔继续”；必须 `fatalShutdown`，否则账本会出现无法解释的缺口。
- **lot 归属**：today/yesterday 的归属以 `OrderState.offset` 为准；未知订单先按成交方向暂定，标记 `LOT_UNKNOWN`，拿到 OrderUpdate/订单快照后校正。校正不得改变 `netQty`，只调整 lot 分解。
- **eventTime 缺失**：标记 `eventTimeUnknown=true`，仍可用于 `netQty`，但 `netQtyAt(asOf)` 返回 UNKNOWN，drift 判 `DRIFT_UNKNOWN`。

### 6.4 `filledQty` 与订单状态

```java
void onOrderUpdate(OrderUpdateEnvelope u) {
    OrderState s = orderBook.getOrCreate(u);
    if (u.sequence() > 0 && u.sequence() <= s.lastSequence) return;  // 同订单回退
    s.updateCumQty = Math.max(s.updateCumQty, u.filledQty());
    s.status = lattice(s.status, u.status());     // 终态粘滞
    s.lastSequence = Math.max(s.lastSequence, u.sequence());
    s.filledQty = Math.max(s.updateCumQty, s.tradeQty);
    s.remainingQty = s.remainingKnown
        ? Math.max(0, s.orderQty - s.filledQty) : -1;
    if (s.updateCumQty < s.tradeQty) {
        health.raise(EXEC_DIVERGENCE, s.clientOrderId);   // 以 trade 为准，对账
    }
}
```

禁止：`s.filledQty += trade.qty`。这会把“累计值已包含该笔”的情况算高。

`UNKNOWN_ORDER`（先到 Fill、后到 OrderUpdate）不参与 `pendingOpen` 估算，只计入 `pending_unknown_total`；该 instrument 在拿到 OrderUpdate/订单快照前按 fail-closed 处理，不允许新开仓。

`terminalHistory`：终态订单保留 20,000 条或 2 个 session（先到为准）；淘汰只影响审计，不影响 canonical 状态；`terminal_history_evicted_total` 必须可解释。

### 6.5 avg/realized 的顺序问题（明确边界）

`avgPrice`/`realized` 依赖成交顺序；`netQty` 不依赖。V3 明确区分：

| 量 | 保证 | 说明 |
|---|---|---|
| `netQty` / today/yesterday 数量 | **精确** | 交换律成立，成交任意顺序结果一致 |
| `fees` | 可加 | 每笔独立累加；`feeUnknown` 不填 0 |
| `ledgerAvg` | **不保证顺序无关** | 按到达顺序（WAL 顺序）计算；乱序时标记 `avgOrderUncertain` |
| `realized` | **不保证顺序无关** | 依赖 avg；同上 |
| `displayAvg` | 可被可信快照校正 | 只展示，不进风控 |

V3 的明确选择：

```text
不承诺“任意乱序下 ledgerAvg/realized 精确”。
per-instrument 全序只在 venue 提供 trade sequence 时使用；
CTP 没有该序列，因此：
  - netQty/today/yesterday 是风控唯一依据
  - ledgerAvg/realized 按到达顺序计算，作为账本估算
  - 每次可信快照只重算 displayAvg 与展示 PnL，不覆盖 ledgerAvg
  - 若检测到 eventTime 回退或历史超窗，置 avgOrderUncertain=true，
    产生 health(AVG_ORDER_UNCERTAIN)，不计入 position drift
```

策略契约：**风控/对冲只能用 `netQty` 与 pending；不得用本地 avg 做开仓/平仓决策。** CTP 的 PnL 以快照 settlement/avg 为准，本地 avg 只用于即时展示。

### 6.6 交易日切换、结算与日切 dedup

交易日是 venue/session 的属性，不是本地日历日：

```text
 authoritativeTradingDay = VenueSession.tradingDay（adapter 声明，夜盘 21:00 属于下一交易日）
 禁止：LocalDate.now()、timestamp 的本地日期、cron 猜日切。
```

状态机：

```text
DAY_STABLE
  ├─ session.tradingDay == ledger.tradingDay -> 保持
  ├─ session.tradingDay > ledger.tradingDay
  │    ├─ settlementState 必须为 NONE 或 SETTLED；PENDING/SETTLING/FAILED -> WARMUP
  │    ├─ 必须有新交易日的可信 account/position snapshot（scope=ACCOUNT）
  │    ├─ 必须无 ExecGap、无在途 publication、无未决 TIMEOUT_UNKNOWN
  │    └─> 写 WAL DAY_ROLL(from,to,snapshotId,asOf,requestSeq)
  │         -> positionKeeper.rollDay(snapshot)       // 用快照值，不用本地 today+yesterday 猜
  │         -> accountLedger.rollDay(snapshot)
  │         -> dedup.rotate(toDay)                    // current/previous 两代
  │         -> DAY_STABLE
  └─ session.tradingDay < ledger.tradingDay
       └─> WARMUP（旧 session 迟到，不允许回滚账本）
ROLL_PENDING（等待新日快照）
  ├─ 可信快照到达 -> DAY_STABLE
  └─ 超时 30s -> REDUCE_ONLY + 告警 + 人工
```

`rollDay(snapshot)` 的规则：

- 新日 `today*` 以新快照为准；快照完整且缺该 instrument 才置 0。不得把旧账本 today 直接当新日 today。
- `yesterday*` 用快照的 `yesterday*`（不含新日成交）；若快照已经把新日成交算进 today，按快照值，不重复加。
- 若快照是完整账户快照且 `trusted`，缺失 instrument 视为 0；若不是完整快照 → 不推断，保持原值并 WARMUP。
- `settlementPrice` 用新快照；`ledgerAvg` 保留（作为昨仓成本），`displayAvg` 用新快照校正。
- `realized/fees` 跨日结转；日切不清零。
- `DAY_ROLL` 必须先 WAL 后改内存；失败 fatal。

日切 dedup：

```text
DedupKey = (venueId, tradingDay, tradeId)
内存结构 = currentDay + previousDay 两代；previousDay 至少保留到 currentDay 稳定结算。
journal  = dedup-<tradingDay>.log，只作为启动加速；权威仍是 WAL FILL_ACCEPTED。
跨日同一 tradeId 不视为重复；同一日内重复仍只应用一次。
日切后收到 previousDay 的 fill：
  - eventTime <= 新日最后一次可信 snapshot.asOf -> LATE_FILL_COVERED_BY_SNAPSHOT（只审计）
  - eventTime >  snapshot.asOf -> 应用到 yesterday 并写 WAL（PRIOR_DAY_FILL）
  - 无法判定 -> DRIFT_UNKNOWN + WARMUP，不允许猜
```

### 6.7 `netQtyAt(asOf)` 与 fill 历史

`netQtyAt(asOf)` 不能只用当前净仓。每个 `PositionKey` 维护一个有界 fill 历史：

```java
record FillPoint(long eventTimeNanos, long signedQty, String tradeId, long ingressSeq) {}

final class FillHistory {
    ArrayDeque<FillPoint> points;          // 按 eventTime 非降序；乱序插入时标记
    long maxEntries = 65_536;
    long retentionNanos = max(2 * snapshotPeriodNanos,
                              2 * staleAfterMs * 1_000_000L,
                              10 * 60 * 1_000_000_000L);
    boolean complete;                      // ExecGap / eventTimeUnknown / 超窗 -> false
}
```

```text
netQtyAt(asOf):
  if (!history.complete) return UNKNOWN;
  if (points.isEmpty()) return currentNet;                 // 窗口内无成交
  if (asOf < points.first.eventTimeNanos) return UNKNOWN;  // 超窗，不能倒推
  return currentNet - Σ(signedQty where eventTimeNanos > asOf);
```

规则：

- 结构 per `PositionKey`，不是 account 级；account 级用 `AccountLedger` 的同一结构汇总。
- 保留窗口至少覆盖“两个 snapshot 周期 + 一个 staleAfterMs”；默认 10 分钟，最大 65,536 笔/合约。
- 超窗返回 `UNKNOWN`，**不得返回 0、也不得用当前净仓冒充**。
- 乱序成交（`eventTime < points.last.eventTime`）允许插入，但置 `complete=false` 直到下一次可信快照重建；此时 `netQtyAt` 返回 UNKNOWN。
- 每次可信快照可以**重建** history 的基线（只保留 `asOf` 之后的成交），但必须写 `SNAPSHOT_BASELINE`，且重建后 `complete=true` 仅当之后无 gap。
- `netQtyAt` 的输入 `asOf` 必须是 `snapshotAsOf`，不是 per-row `positionAsOf`。

### 6.8 WAL、checkpoint 与恢复点（P0-12）

#### 6.8.1 文件布局与记录格式

```text
目录：ledger/<venueId>/<accountId>/<strategyKey>/
  wal-000001.log          预分配 + mmap；固定段大小 64MiB
  checkpoint-<lsn>.json   原子写；保留最近 2 份
  dedup-<tradingDay>.log  启动加速索引，非权威
  handoff-<ts>.json       未 flat 时的交接记录
```

记录头（28 字节）：

```text
magic u32 = "QLW3" | schemaVersion u16 | recordType u8 | flags u8
lsn i64 | tradingDay i32 (YYYYMMDD, 0=不适用) | payloadLen i32 | crc32c u32
```

- `lsn` 是 ledger 内单调字节偏移，不随 segment 重置；segment header 记录 `baseLsn`。
- 每条记录必须 CRC32C 校验；`payloadLen` 必须与实际一致。
- `SESSION_CONTEXT` 必须是每个 segment 的第一条记录；没有 context 的记录视为损坏。

#### 6.8.2 记录 schema（脱离当前配置也能重放）

| 记录 | 必填字段 |
|---|---|
| `SESSION_CONTEXT` | `contextId, schemaVersion, venueId, accountId, strategyKey, deploymentId, generation, orderEpoch, fencingToken, sourceSessionId, sourcePublicationEpoch, adapterSessionId, tradingDay, createdAtNanos` |
| `INTENT` | `contextId, venueId, accountId, strategyKey, exchange, intentId, clientOrderId, instrumentId, side, offset, price, qty, tif, riskVersion, generation, requestHash` |
| `PUBLISH_RESULT` | `contextId, venueId, accountId, strategyKey, intentId, accepted, reason, retryAfterMs, publicationEpoch, atNanos` |
| `ORDER_STATE` | `contextId, venueId, accountId, strategyKey, exchange, clientOrderId, venueOrderId, instrumentId, side, offset, orderQty, updateCumQty, tradeQty, status, lastSequence, sourceSessionId, epoch, eventTimeNanos, terminal` |
| `FILL_ACCEPTED` | `contextId, venueId, accountId, strategyKey, exchange, tradingDay, tradeId, clientOrderId, venueOrderId, instrumentId, side, orderOffset, price, qty, fee, feeKnown, eventTimeNanos, ingressNanos, sourceSessionId, epoch, fencingToken, generation` |
| `SNAPSHOT_BASELINE` | `contextId, venueId, accountId, strategyKey, snapshotId, source, scope, tradingDay, asOf, requestSeq, positions[]` |
| `POSITION_RESET` | `contextId, venueId, accountId, strategyKey, operator, reason, snapshotId, snapshotAsOf, requestSeq, tradingDay, before[], after[]` |
| `DAY_ROLL` | `contextId, venueId, accountId, strategyKey, fromTradingDay, toTradingDay, snapshotId, asOf, requestSeq, beforeTotals[], afterTotals[]` |
| `CHECKPOINT` | `contextId, venueId, accountId, strategyKey, checkpointId, checkpointLsn, lastAppliedByStream[], dedupWatermark, openOrderCount, positionCount, configFingerprint, createdAtNanos` |
| `HANDOFF` | `contextId, venueId, accountId, strategyKey, reason, state, requestSeq, snapshotId, asOf, positions[], workingOrders[]` |

规则：

- `contextId` 只是索引/校验；**每条记录仍必须自带 `venueId/accountId/strategyKey`**，不得只靠 context 补。
- `FILL_ACCEPTED` 必须能独立构造 `TradeEnvelope` + `PositionKey`：`accountId/strategyKey/exchange/sourceSessionId/epoch/tradingDay` 都在记录里。
- `ORDER_STATE` 必须能独立构造 `OrderState`：`instrumentId/side/offset/orderQty` 不能只靠 `INTENT` 补。
- `INTENT` 里的 `clientOrderId` 必须在 publish 前分配并持久化；重放时不能重新生成。
- `configFingerprint` 只用于诊断，不是恢复依据；恢复不得读当前 runner 配置来补字段。
- `lastAppliedByStream[]` 的元素：`(streamKind, sourceSessionId, epoch, exchange, instrumentId, seq, tradingDay)`；与 `VenueSession.lastSeqByStream` 对齐。

#### 6.8.3 checkpoint 原子写与截断

```text
checkpoint 写：
  1. 生成完整快照（position/order/dedup/lastAppliedByStream）
  2. 写 checkpoint-<lsn>.json.tmp
  3. fsync(tmp)
  4. rename -> checkpoint-<lsn>.json
  5. fsync(dir)
  6. 更新 durableCheckpointLsn
  7. 只有 6 成功后，才允许 truncateBefore(lsn - keepSegments)

truncate 规则：
  - 不删除包含最新 checkpoint LSN 的 segment；
  - 至少保留一个前序 segment；
  - checkpoint 文件损坏时回退到上一个有效 checkpoint，不跳过 WAL。
```

#### 6.8.4 恢复流程与失败原子性

```java
recover() {
    Checkpoint cp = newestValidCheckpoint();       // CRC + schema + lsn <= wal.end
    if (cp == null) cp = emptyCheckpoint(wal.startLsn());
    positionKeeper.load(cp);
    orderBook.load(cp);
    accountLedger.load(cp);
    dedup.load(cp.dedupWatermark());

    for (Record r : wal.after(cp.lsn())) {
        validateContext(r);                        // 必须能独立解释
        applyIdempotent(r);                        // FILL_ACCEPTED 走同一 dedup + applyTrade
    }
    long checkpointLsn = checkpoint(lastApplied);
    wal.truncateBefore(checkpointLsn);
    state = (cp.isEmpty() && wal.isEmpty()) ? BOOTSTRAP : WARMUP;
}
```

失败原子性：

1. **先 append 后 apply**：`FILL_ACCEPTED` 写入成功后才改内存；append 失败 → fatal。
2. **崩溃在 append 与 apply 之间**：重启从 checkpoint 重放，成交只应用一次。
3. **崩溃在 apply 与 checkpoint 之间**：WAL 已有记录，重放幂等。
4. **WAL 尾部撕裂**：从第一个 CRC 失败/长度不完整处截断尾部，计 `wal_tail_truncated_total`；只允许尾部，mid-stream 损坏 → fatal。
5. **INTENT 无 PUBLISH_RESULT**：状态为 `UNKNOWN_PUBLISH`；先查 venue `ORDER_SNAPSHOT`：
   - 找到该 `clientOrderId` → 采纳订单，不重发；
   - 未找到且快照可信 → 同 `intentId` 重发；
   - 快照不可信 → WARMUP/REDUCE_ONLY，禁止盲发。
6. **fsync 失败**：ledger 线程 fatal；loop 不再接受新成交。
7. **checkpoint 损坏**：回退上一个 checkpoint；两份都坏 → 从 WAL 起点重放；WAL 也损坏 → 人工恢复，进程 fail-closed。

fsync 策略：

- loop 只做 mmap 追加，不调用 `force()`；`qf-ledger` 每 1ms 或 64 条记录 group commit。
- `INTENT` 在 publish 前追加（page cache），不等待 fsync；崩溃后按上面的 `UNKNOWN_PUBLISH` 规则处理。
- `FILL_ACCEPTED` 必须先追加再改内存。
- `SHUTDOWN` 必须等 `durableLsn == appendLsn` 才退出；上限 5s，超时写 handoff 并 halt。

### 6.9 pending 与敞口

`OrderBookView` 的定义：

```java
record OrderState(
    long clientOrderId, String venueOrderId, String instrumentId,
    Side side, Offset offset, long orderQty,
    long updateCumQty, long tradeQty, long filledQty,
    long remainingQty, boolean remainingKnown,
    Status status, long lastSequence, long version, boolean unknownOrder) {}
```

`remainingQty = max(0, orderQty - filledQty)`；`UNKNOWN_ORDER` 的 `remainingKnown=false`，不参与估算。`CANCEL_REQUESTED` 保留在 working，直到 `CANCELED`/`FILLED`/`REJECTED`。

`closableLong = todayLong + yesterdayLong`（按 offset 再细分 today/yesterday）；`closableShort` 同理。

敞口计算（覆盖四种合法 offset 组合）：

```text
pendingOpenSigned(i) =
    Σ (+remaining for BUY  OPEN, -remaining for SELL OPEN)

closeQty(i, order) =
  SELL CLOSE_TODAY      -> -min(remaining, todayLong)
  SELL CLOSE_YESTERDAY  -> -min(remaining, yesterdayLong)
  SELL CLOSE            -> -min(remaining, todayLong + yesterdayLong)
  BUY  CLOSE_TODAY      -> +min(remaining, todayShort)
  BUY  CLOSE_YESTERDAY  -> +min(remaining, yesterdayShort)
  BUY  CLOSE            -> +min(remaining, todayShort + yesterdayShort)
  其他 offset           -> 不参与 pendingClose（按 OPEN 或非法处理）

pendingCloseSigned(i) = Σ closeQty(i, order)
totalExposure(i)      = netQty(i) + pendingOpenSigned(i) + pendingCloseSigned(i)
```

lot 级规则：

- `CLOSE_TODAY` 只能减 `todayLong/todayShort`；`CLOSE_YESTERDAY` 只能减 yesterday；`CLOSE` 先按 today 再 yesterday 拆分，拆单在策略层完成。
- `CANCEL_REQUESTED` 必须计入 pending；撤单确认前不得假定敞口下降。
- terminal 订单保留在 `terminalHistory`（20,000 条或 2 个 session，先到为准），供审计与重复回报比对。
- 终态订单被 venue 再次回报时，只更新审计，不回到 working。
- pre-trade risk 必须读 `totalExposure`，不能只看 `netQty`。
- 启动恢复 working：优先 venue `ORDER_SNAPSHOT`；控制面 `openOrders` 只作补充；两者都不可用 → WARMUP，不得假定“没有挂单”。`seedOpenOrders` 写 WAL，重复 seed 必须幂等（按 `clientOrderId` 去重）。

### 6.10 对账（account 级与 strategy 级分开）

```text
周期：2s（可配），由 qf-venue-account 拉取，requestSeq 单调
输入：Snapshot<List<PositionSnapshot>>（scope=ACCOUNT）+ OpenOrderView[]
输出：ReconcileReport -> loop
```

| 差异 | 动作 |
|---|---|
| 本地有、venue 无的 working | 保留，标记 `MISSING_AT_VENUE`，发 cancel，等 terminal；不直接删 |
| venue 有、本地无的 order | 创建 `ORPHAN_ORDER`，进入 pending，发 cancel，告警 |
| 数量 drift ≤ tolerance | 记录，不改变状态 |
| 数量 drift > tolerance，连续 3 次 | `RECONCILING` + reduce-only + 告警；等待 `POSITION_RESET` 或人工 |
| `netQtyAt(asOf)` 返回 UNKNOWN | `DRIFT_UNKNOWN`，不判 drift，保持 WARMUP/reduce-only |
| 快照 stale/缺字段/scope≠ACCOUNT | 不判定 drift，保持 WARMUP |
| manual/orphan 仓位存在 | 计入 `orphan_account_exposure`，阻止自动 flat，告警 |

- **对账/控制面线程不得直接 `removeIf` 本地 working。** 它们只能产出 `ReconcileReport`，删除决定只在 loop 做出。
- account 级比较：`AccountLedger.netQtyAt(snapshot.asOf)` vs `snapshotNet`（包含 manual/orphan）。strategy 级比较只在 `PositionSnapshot.scope=STRATEGY` 时使用，且不能用于 flat。
- 同一 `requestSeq` 的 report 只能应用一次；旧 report 只审计。

## 7. 快照、READY/WARMUP 与 drain flat

### 7.1 字段定义

`Snapshot<T>` 必须有：

```text
value / asOf(snapshotAsOf) / stale / staleAfterMs / tradingDay / snapshotId / source
requestSeq / scope / requestedAt / completedAt
```

- `asOf` 是**整次查询/生成的时刻**（snapshotAsOf），不是 per-row 的 `updated_at`。
- `requestSeq` 由 Port 在发起请求时分配，单调递增；`flat()` 用它判断“drain 之后重新请求过”。
- `scope`：`ACCOUNT | STRATEGY | VENUE | UNKNOWN`；只有 `ACCOUNT` 可用于 drift/flat。

`PositionSnapshot` 必须有：

```text
venueId / exchange / accountId / strategyKey / scope / instrumentId
longQty / shortQty
todayLong / todayShort / yesterdayLong / yesterdayShort
avgPrice / longAvgPrice / shortAvgPrice / settlementPrice
environment / snapshotId / source / asOf(snapshotAsOf) / positionAsOf
```

- `strategyKey` 为空且 `scope=ACCOUNT` 表示账户级行；`scope=STRATEGY` 必须带 `strategyKey`。
- `positionAsOf` 是该行最后变化时间，只用于展示/诊断；`trusted()` 用 snapshot 级 `asOf`。

`AccountSnapshot` 必须与 ADR-004 §5.3 对齐；未知用 `null`，不得填 0：

```text
venueId / accountId
balance / available / margin / frozenMargin
commission / closeProfit / positionProfit / deposit / withdraw
tradingDay / snapshotId / source / asOf
```

- 金额字段用可空 `Double`（`null=unknown`），不是 `double 0`；这样“零费用”和“未知费用”可区分。

- V3 必需：`balance/available/margin/commission`；缺失 → `stale=true`。
- 可选：`frozenMargin/closeProfit/positionProfit/deposit/withdraw`；缺失为 `null`，消费方必须显式处理 unknown。
- `AccountSnapshot` 不再有“balance 恒为 0”的兼容构造；旧构造只能用于测试并标 `unknown`。

`VenueSession` 必须有：

```text
venueId / accountId / orsId
sourceSessionId / publicationEpoch / fencingToken
tradingDay / loginState / settlementState
leaseExpiryMillis / adapterSessionId / state / reason / asOf
lastSeqByStream[]
```

`lastSeqByStream[]` 的元素：

```text
StreamSeq(streamKind, sourceSessionId, sourcePublicationEpoch,
          exchange, instrumentId, lastSeq, updatedAtNanos)
```

`VenueAccountPort` 的可选流与 `VenueHealthPort.subscribe` 必须有显式能力位：

```text
supportsPositionStream() / supportsHealthStream()
  - false -> runtime 走 snapshot-only + WARMUP，不得把 UnsupportedOperationException 当成空/0
  - true  -> 必须实现；默认实现不能 throw 后静默忽略
```

`VenueDescriptor` 必须有（ADR-004 §3）：

```text
venueId / descriptorVersion / counterpartyId
exchange[] / environment / venueType / adapterKind
enabled / status / capabilities[] / accountBindings[]
channels / streams / calendarMode / sessionPolicy
snapshotSources / healthSource / reconciliationMode / writerRole
```

- `environment`、`adapterKind` 缺失必须抛异常；**删除 `SHADOW`/`UNKNOWN` 默认**。
- `capabilities` 为 `{supported, constraints}`；V3 可以只读 `supported`，但字段形状要与 ADR 一致。
- `writerRole` 用于启动时拒绝重复 writer（ADR-004 §7）。

### 7.2 数据源、asOf 与 requestSeq（P0-3）

`VenueAccountPort` 必须读 venue/account 真值，不可读 strategy ledger：

| 数据 | 允许来源 | 禁止来源 |
|---|---|---|
| `positions()` | `/api/v1/positions`（`positions` 表，由 `PositionSnapshotConsumer` 从 `PositionSnapshotV2` 写入）或 `/api/v1/strategy-center/accounts/{accountId}` 的 account 投影 | `/api/v1/strategy-runtime/risk`、`Portfolio`、`PositionKeeper` |
| `account()` | account snapshot 表/控制面账户接口，带 `snapshotId/source/asOf/staleAfterMs` | 策略 PnL 投影 |
| `session()` | `VenueSession` SBE / 控制面 session 表 | 本地推断 |

规则：

- `source` 必须是 `CTP|SIM|REPLAY|ARCHIVE`；`UNKNOWN` 或空 → `stale=true`。
- `snapshotId` 必须来自 venue/控制面的快照批次；禁止用 `System.currentTimeMillis()` 合成。
- `staleAfterMs` 必须从源/descriptor 透传；缺失 → `0` → `trusted()` 为 false。禁止硬编码 15s 作为唯一值。
- 所有 `Instant.now()` fallback 删除；缺 `serverTime/asOf` → `Instant.EPOCH` + `stale=true`。
- `stale` 的年龄计算用注入 `Clock`（`RuntimeClock`），不用 `Instant.now()`；这样测试拨系统时钟不会改变 `asOf` 语义。
- 缺 qty/价格字段 → `null`/`UNKNOWN`，不得 `longValue(...)=0` 冒充。
- `requestSeq` 由 `ControlPlaneVenueAccountPort` 内部 `AtomicLong` 分配；同一 `(venue, account, kind)` 单调；`Snapshot.requestSeq` 必须回传。
- `scope`：account 投影返回 `ACCOUNT`；如果短期只能读策略投影，必须显式 `scope=STRATEGY`、`strategyScoped=true`，并禁止用于 flat/drift。
- `snapshotAsOf` 与 `positionAsOf` 分离：`positions()` 的 `asOf` 用批次时间；每行 `positionAsOf` 只诊断。任一行 `positionAsOf > asOf + skewTolerance` → 整张快照 `stale=true`（时间倒挂）。

### 7.3 `trusted()` 谓词

```java
boolean trusted(Snapshot<?> s, VenueSession sess, Instant now,
                TradingDay currentDay, boolean requiresAccountScope) {
    if (s == null || s.stale()) return false;
    if (s.staleAfterMs() <= 0) return false;
    if (blank(s.snapshotId()) || blank(s.source())) return false;
    if (s.source().startsWith("STRATEGY")) return false;             // 账本对账本
    if (requiresAccountScope && s.scope() != SnapshotScope.ACCOUNT) return false;
    if (!currentDay.equals(s.tradingDay())) return false;
    if (s.asOf().equals(Instant.EPOCH)) return false;
    if (s.asOf().isAfter(now.plus(skewTolerance))) return false;     // 未来时间戳
    if (Duration.between(s.asOf(), now).toMillis() > s.staleAfterMs()) return false;
    if (s.requestSeq() <= 0) return false;
    if (sess == null || !"READY".equals(sess.state())) return false;
    if ("DOWN".equals(sess.loginState())) return false;
    if ("PENDING".equals(sess.settlementState())
        || "SETTLING".equals(sess.settlementState())
        || "FAILED".equals(sess.settlementState())) return false;
    if (sess.leaseExpiryMillis() > 0 && sess.leaseExpiryMillis() <= now.toEpochMilli()) return false;
    return true;
}
```

`skewTolerance` 默认 2s，可配；超过即视为不可信，不尝试“猜”。

### 7.4 状态机

```text
BOOTSTRAP
  └─ WAL 重放完成 + 有可信快照 + 本地账本为空/已 seed
       └─> WARMUP
WARMUP
  └─ 可信快照 + session READY + 无 gap + drift 可解释
       └─> READY
READY
  ├─ MD gap / image 丢失 / session LOST / 快照过期
  │     └─> WARMUP（拒 OPEN，允许 CANCEL/CLOSE）
  ├─ drift 超限
  │     └─> RECONCILING（只 reduce/cancel）
  ├─ tradingDay 变化
  │     └─> ROLL_PENDING（等待新日可信快照）
  └─ Control(DRAIN)
        └─> DRAINING
ROLL_PENDING
  ├─ 新日快照可信 -> READY
  └─ 30s 超时 -> REDUCE_ONLY
RECONCILING
  └─ 可信快照解释 drift 或 POSITION_RESET
        └─> READY
DRAINING
  ├─ flat 谓词成立
  │     └─> CLOSED
  └─ timeout / 快照不可信
        └─> REDUCE_ONLY（进程保持存活，告警 + handoff）
```

各状态的交易权限：

| 状态 | OPEN | CLOSE/CANCEL | 说明 |
|---|---|---|---|
| BOOTSTRAP | 否 | 否 | 只读恢复 |
| WARMUP | 否 | 是 | 允许撤单/减仓，不允许增加敞口 |
| READY | 是（需 risk fresh） | 是 | 正常 |
| ROLL_PENDING | 否 | 是 | 等待新交易日基线 |
| RECONCILING | 否 | 是 | 只 reduce/cancel |
| DRAINING | 否 | 是 | 只平仓/撤单 |
| REDUCE_ONLY | 否 | 是 | drain/roll 超时后的驻留状态 |

### 7.5 drain flat 的可信条件

```java
boolean flat() {
    return orderBook.working().isEmpty()
        && orderBook.unknown().isEmpty()
        && positionKeeper.allZero()                        // 策略账本所有 lot 为 0
        && accountLedger.orphanExposure() == 0             // 手工/未知策略仓位必须已处理
        && accountLedger.foreignStrategyExposure() == 0   // 已知其他策略仓位必须已处理
        && trusted(finalSnapshot, session, now, tradingDay)
        && finalSnapshot.scope() == SnapshotScope.ACCOUNT
        && finalSnapshot.requestSeq() > drainStartRequestSeq
        && !finalSnapshot.asOf().isBefore(drainStartAt)
        && finalSnapshot.value().stream().allMatch(p -> p.netQty() == 0)
        && !reduceOnlyPending;                             // 没有在途减仓
}
```

只信本地账本不够；只信控制面旧快照也不够。二者必须同时满足，且快照必须是本次 drain 开始后重新获取的：

- `requestSeq` 由 Port 分配，`drainStartRequestSeq` 是进入 DRAINING 时记录的最后一个序号；不能用 loop 自己猜。
- `asOf` 必须不早于 `drainStartAt`，且 `tradingDay` 与 session 一致。
- 如果 `orphan_account_exposure != 0` 或 `foreign_strategy_exposure != 0`，即使策略账本为 0，也不得报 flat；必须 handoff 或 operator ack。

### 7.6 drain / shutdown 的 fail-stop 规则

- **drain**：`Control(DRAIN)` → 禁 OPEN → 撤全部 working → 等 terminal → 按 `totalExposure` 平仓 → 每轮检查 `flat()`。
- **drain 超时**：默认 60s；进程**保持存活**在 `REDUCE_ONLY`，发 `DRAIN_INCOMPLETE` 告警并写 handoff；只有 flat 或 operator 明确 ack 才退出。
- **shutdown hook**：只 `closing.set(true)` + `controlQueue.tryOffer(SHUTDOWN)` + `await(shutdownGraceMs=30s)`。
- **30s 后**：若 loop 仍未 flat，hook 写 `HANDOFF`（含最后可信快照、working orders、未平仓位），然后 `Runtime.halt(75)`；**不允许静默正常退出**。外部 supervisor 不得自动重启，必须等 operator ack。
- **关闭顺序**：停策略回调 → **保留 MD subscription/latest slot 给平仓定价** → 停新单 → 撤单并等 terminal → 平仓并等 terminal → 最终可信快照 → WAL checkpoint + fsync → 关 publication → 关 exec subscription → 关 MD/account → 退出。
- **MD 定价**：只停“策略回调”，不停“行情订阅”；closeout 使用 `LatestQuote` 时必须检查 `age <= maxQuoteAgeMs`，过期则用 venue market order/FAK 或 handoff，不得用过期价硬平。
- **fail-stop 后**：保留 exec subscription 到 terminal 或 handoff 完成；控制面 flatten 能力是外部依赖（§16.3）。

## 8. 执行链路

### 8.1 单一路径

```text
Strategy.onFill/onTimer/onMarketData
  -> OrderIntent(intentId, ...)
  -> OrderSink.submit(intent)            // loop
  -> VenueExecutionPort.submit(request)  // 唯一出口
  -> Aeron publication                   // loop 单写者
```

runner 不得再直接调用 `AeronOrderGateway.submit/cancel`；`ModeAwareOrderSink` 改为 `PortOrderSink`。`AeronOrderGateway` 改名为 `AeronExecutionIo`，只保留 decode/filter/dedup/seq/epoch + publication 编码。

### 8.2 下单前置检查（全部在 loop，无 IO）

```java
SubmitOutcome submit(OrderIntent intent) {
    if (closing || fatalSlot.isPresent()) return reject(FATAL);
    if (intent.increasesRisk() && state != READY) return reject(RISK);
    if (blank(intent.strategyKey())) return reject(VALIDATION);   // manual 不允许走策略下单
    IntentState prev = recentIntents.get(intent.intentId());
    if (prev == ACCEPTED || prev == TIMEOUT_UNKNOWN || prev == PUBLISHED
        || prev == PENDING_RETRY) {
        return duplicateInFlight(intent.intentId());   // 不重复 reserve、不重复 publish
    }
    if (!risk.allows(intent)) return reject(RISK);
    if (orderBook.openCount() >= maxOpenOrders) return reject(LIMIT);

    orderBook.reserve(intent);              // PENDING_PUBLISH，计入 pending
    wal.append(INTENT, context, intent);    // clientOrderId 必须已确定
    retryQueue.add(intent, now + submitDeadlineMs);  // 由 flushRetries 发布
    return acceptedPending(intent);
}
```

`REJECTED_LIMIT`/`BACKPRESSURE`/`PUBLICATION_CLOSED` 允许同 `intentId` 重试；`REJECTED_VALIDATION`/`REJECTED_RISK` 是终局，同 id 重试返回原拒绝。内部 retry 见 §5.7。

`PUBLICATION_CLOSED`/`BACKPRESSURE` 不能只返回一个 boolean 让调用方自己猜：

```text
intent 已在 WAL（INTENT 记录）中 -> 标记 PENDING_RETRY，保留 pending reservation
按 retryAfterMs 退避重试，直到 submitDeadline（默认 3s）
submitDeadline 内恢复 -> 正常提交；期间成交/撤单照常应用
超过 deadline -> 风险增加 intent 进入 REDUCE_ONLY + 告警；撤单/平仓继续重试
任何情况下不得把“未发出”当成“已发出”，也不得静默丢弃 intent
```

### 8.3 L0 adapter no-drop 契约（CTP 必改）

#### 8.3.1 spool 布局与记录格式

```text
<adapterData>/spool/<venueId>/<direction>/<sourceSessionId>-<epoch>/
  seg-<baseSpoolSeq>.log     预分配 append-only，默认 64MiB/段
  spool.meta                 原子写：ackSpoolSeq、lastSpoolSeq、crc、createdAt
```

- `direction = REQ`（runner→venue：OrderRequest/CancelRequest）或 `EVT`（venue→runner：OrderUpdate/Trade）。
- 记录头 32 字节：`magic "QLSP" | version u16 | direction u8 | type u8 | flags u16 | payloadLen u32 | spoolSeq i64 | createdAtNanos i64 | crc32c u32`。
- payload 是原始 SBE frame；`REQ` 额外带 `intentId/clientOrderId`，`EVT` 带 `venueId/sourceSessionId/epoch` 便于重放校验。
- 每条记录 `spoolSeq` 在 `(direction, sessionId, epoch)` 内连续，不允许跳号。

#### 8.3.2 容量、轮转、fsync、清理

| 项 | 规则 |
|---|---|
| 容量 | `spoolMaxBytes = min(2GiB, 10% 空闲磁盘)`；按 direction 独立 |
| 水位 | 70% 告警；90% 停新 OPEN（reduce-only）；100% fatal |
| 轮转 | 段满 64MiB 切新段；段号单调；只追加，不原地改 |
| fsync | 每 1ms 或 64 条 `fdatasync`；段切换/退出前必须 fsync；目录项变更后 `fsync(dir)` |
| 清理 | 只删除 `seg.endSpoolSeq <= ackSpoolSeq` 的段；至少保留 2 段；`spool.meta` 原子写 |
| 磁盘满 | 写失败 → adapter fatal（停止接单）；不允许丢记录后继续 |
| 损坏 | 尾部 CRC 失败 → 截断尾部并告警；中间损坏/跳号 → fatal，不跳过 |

#### 8.3.3 重放顺序与 dedup

```text
启动：
  read spool.meta -> ackSpoolSeq
  从 ackSpoolSeq+1 开始按 spoolSeq 连续重放
  尾部 CRC 失败 -> 截断到最后一个有效记录
  中间缺号 -> ExecGap + fatal（不允许跳过）

REQ 重放（可能重复下单）：
  1. 按 clientOrderId 查 venue ORDER_SNAPSHOT
  2. 已存在 -> 记 ack，跳过（不重发）
  3. 不存在且快照可信 -> 重发同一 clientOrderId/intentId
  4. 快照不可信 -> REDUCE_ONLY/handoff，禁止盲发
  撤单重放天然幂等，可直接重发

EVT 重放（可能重复回报）：
  按 spoolSeq 顺序 publish；runner 按 (venueId,tradingDay,tradeId) 与 order seq 去重
  publication null/未连接 -> 继续留在 spool，按 retryAfterMs 重试；
  超过 deadline -> adapter fatal（不丢）
```

#### 8.3.4 publication null / not connected 的显式规则

| 条件 | 必须行为 | 禁止 |
|---|---|---|
| outbound queue 满 | 有限阻塞（≤ `maxBlockMs`，默认 5ms）→ 写 REQ spool → 计数 | `outboundDropped_++` 后 `return` |
| publication 指针为空 | 写 EVT spool；spool 不可用 → fatal | `if (closing_ || !tradePub_) return;` |
| `!publication.isConnected()` | 写 EVT spool，按 10ms/50ms/250ms 退避重试 | 直接丢 |
| spool 写失败/磁盘满 | adapter fatal（停止接单，告警） | 静默丢 |
| `tradeId` 为空 | 拒绝该 trade 并 fatal | 用 `"CTP-"+clientOrderId` 兜底 |
| `fee` 不可得 | `feeKnown=false`，不填 0 | 把未知费用当 0 |
| 恢复 spool | 按 spoolSeq 重放；不能保序时 `ExecGap` + fatal/对账 | 跳过 |

`kMaxOutbound` 的语义改为“背压阈值”，不是“丢弃阈值”。该改动属于 CTP adapter 的独立任务，需要 Linux 构建与维护窗口；在完成前，M5 门禁不通过，V3 不接 live。

#### 8.3.5 M5 `ExecNoDropIT` 必须覆盖

```text
1. 打满 kMaxOutbound+1：断言 spool 写入，exec_dropped_total=0
2. publication=null / disconnected：断言 spool 写入，重连后按序 publish
3. spool 写入后 kill -9 adapter：重启后从 ackSpoolSeq+1 重放
   - REQ：venue 侧每个 clientOrderId 恰好一次（靠 ORDER_SNAPSHOT 去重）
   - EVT：runner 侧每笔 trade 恰好一次（靠 dedup key）
4. spool 磁盘满：断言 fatal，非静默丢
5. spool 尾部撕裂：断言截断尾部并可继续
6. spool 中间缺号：断言 ExecGap + fatal
```

### 8.4 throttle / commonSize / intentId

- `throttle` 只在 `acceptedForPublication=true` 后计时；失败不占用冷却窗口。
- key 至少包含 `(intentId, instrumentId, side)`；不能用 `instrument+side` 单独做 key。
- `commonSize` 在策略生成 `OrderIntent` 之前应用，risk 看到的就是最终 qty；如果无法保证，删除该功能。
- `intentId` 由策略生成并跨重试稳定；gateway 不再生成 `UUID.randomUUID()`/`nextClientOrderId()` 作为业务幂等键。
- gateway 的“同 instrument/side/offset/price 直接返回已有 id”前置去重要删除；只保留“同 `intentId` 重试”的去重。

## 9. 热加载、epoch/generation 与生命周期

### 9.1 事件分类（先分类，再决定丢不丢）

| 事件 | generation/epoch 旧 | 处置 |
|---|---|---|
| Fill / Trade | 旧 generation、旧 epoch | **必须应用**：本策略的进 `PositionKeeper`，同时进 `AccountLedger`；blank/其他策略只进 `AccountLedger`。计 `orphan_fill_total`；进入审计；触发 `onOrphanFill`（默认告警） |
| OrderUpdate | 旧 generation、当前 epoch | 若订单在 `OrderBookView` 中存在，更新状态（终态粘滞）；新策略通过 `onStart(snapshot)` 看到它 |
| OrderUpdate | 旧 epoch/fencing | 只进审计，不进 canonical book；防止旧 session 覆盖新 session |
| 策略命令（submit/cancel） | 旧 generation | 拒绝，返回 `STALE_GENERATION` |
| control/MD | 旧 epoch | 丢弃并计数；MD 进入 gap 逻辑 |

核心原则：**epoch/generation 限制“命令和回调”，不限制“仓位事实”。** 任何声称“旧 generation 的成交可以丢”的表述都不存在。

### 9.2 热加载状态机

```text
IDLE
 └─ Control(RELOAD_PREPARE{nextConfig, nextGeneration})
      └─> PREPARING（qf-control-plane 构建新策略，不碰运行态）
            ├─ strategyKey 变化 -> RELOAD_REJECTED_STRATEGY_KEY_CHANGED
            ├─ 构建失败 -> RELOAD_ABORT，保留旧实例
            └─ 构建成功 -> Control(RELOAD_SWAP)
                  └─> DRAINING_OLD（loop）
                        ├─ commandGeneration = next
                        ├─ 撤旧 generation 的 working orders，或显式 transfer 给新策略
                        ├─ 等 terminal（reloadCancelTimeoutMs，默认 3s）
                        ├─ 期间到达的 Fill 正常应用
                        ├─ 全部 terminal -> old.onStop -> new.onStart(snapshot) -> 替换
                        └─ 超时 -> 恢复 commandGeneration=old，保持旧策略，进 REDUCE_ONLY + 告警
```

规则：

- 旧 generation 的 working orders 必须先撤单/转移并等 terminal，不能只 `onStop`。
- “转移”指新策略显式接管这些 `clientOrderId`（仍在 `OrderBookView`，仍计入 pending），并在 `onStart(snapshot)` 中看到它们；不转移就必须撤掉。
- 撤单超时不允许“直接换”；新策略会继承未知敞口。超时回退时，已经发出的撤单不回滚，旧策略以 `OrderBookView` 为准。
- `onStart(snapshot)` 只能读快照，不能重放历史成交；历史已在 `PositionKeeper`。
- 构建新策略（类加载、配置解析、indicator 初始化）在 control 线程完成；loop 只做 swap。
- **禁止 `RuntimeEngine.replaceStrategies` 重放 `marketData.values()`**；新策略只从 `StrategyStartSnapshot.latestQuotes` 拿到带 age/stale 的视图。

### 9.3 `onStart(snapshot)` 的内容与类型

```java
record StrategyStartSnapshot(
    String venueId, String accountId, String strategyKey, TradingDay tradingDay,
    long generation,
    List<PositionView> positions,
    List<OrderView> workingOrders,
    List<OrderView> recentTerminalOrders,
    ExposureView exposure,
    Map<String, QuoteView> latestQuotes,
    RiskSnapshot risk,
    StrategyState strategyState,          // 可空
    long lastAppliedEventVersion,
    String snapshotId, Instant asOf, long requestSeq
) {}

record PositionView(String instrumentId, long netQty, long todayLong, long todayShort,
                    long yesterdayLong, long yesterdayShort,
                    double displayAvg, double settlementPrice,
                    long version, Instant asOf) {}

record OrderView(long clientOrderId, String venueOrderId, String instrumentId,
                 Side side, Offset offset, long orderQty, long filledQty,
                 long remainingQty, boolean remainingKnown, String status,
                 boolean cancelRequested, boolean unknownOrder, long version) {}

record ExposureView(long netQty, long pendingOpen, long pendingClose,
                    long totalExposure, long version) {}

record QuoteView(String instrumentId, double bid, double ask,
                 long seq, long sourceSessionId, long epoch,
                 long ingressNanos, long ageMs, boolean stale) {}

record RiskSnapshot(String riskSnapshotId, Instant asOf, long staleAfterMs,
                    Map<String, AccountLimits> accountLimits,
                    Map<String, StrategyLimits> strategyLimits,
                    Map<String, Boolean> indicatorGate,
                    Instant gateAsOf, boolean gateLoaded, long leaseExpiryMillis) {}

record StrategyState(long logicalIntentSeq, boolean armed,
                     long cooldownUntilMillis, TradingDay tradingDay) {}
```

缺失字段的策略必须按“未知”处理并进入 WARMUP，不得假定 flat。`strategyState` 为空时，`SimpleHedging` 按 §12.2 的初始 `armed` 规则重建。

### 9.4 closeout / drain / shutdown

- **closeout**：session timer 在 loop 产生 `Control(CLOSEOUT)`；loop 用 `OrderBookView` + `LatestQuote`（必须检查 age）+ `totalExposure` 发 CLOSE；不再有独立线程读 `Portfolio` 决策。
- **drain**：见 §7.5/§7.6。
- **shutdown hook**：只投事件；不调用 `submit/cancel/drain`，不碰 publication/buffer。
- **关闭顺序**：见 §7.6；关键是“策略回调先停、MD 定价后停”。
- **fail-stop 后**：保留 exec subscription 到 terminal 或 handoff 完成；控制面 flatten 能力是外部依赖（§16.3）。

### 9.5 重连

```text
publication/gateway 断连
  -> exec I/O 线程检测 isConnected=false
  -> 发 Control(RECONNECTED{outageMs, lastSeqByStream})
  -> loop: 禁 OPEN -> 对每个本地 working 发 cancel -> 等 terminal
  -> 从 venue ORDER_SNAPSHOT 对账（若可用）
  -> 用 TRADE_SNAPSHOT/position snapshot 校准 netQty
  -> 恢复 READY
```

旧 epoch 迟到的 OrderUpdate 只更新审计；旧 epoch 的 Fill 仍必须应用（§9.1）。新 epoch 回报进入 canonical book。重连不应重置 `clientOrderId` 持久 block；若 block 不可用，必须 fail-closed，不得随机生成。

## 10. 行情语义：lossless 与 latest

### 10.1 两条流

| 流 | 语义 | 消费者 | 合并 | 丢失后果 |
|---|---|---|---|---|
| `MdEvent` | 每个 envelope 一条，按 scope seq 有序 | indicator、bar、声明 lossless 的策略 | 不合并 | 该 scope WARMUP，指标 reset |
| `LatestQuote` | 每 `(venue, exchange, instrument)` 最新值 | quote-only 策略、closeout 定价、展示 | 覆盖 | 只影响最新价，`md_superseded_total++` |

规则：

- `MdEvent` 在 I/O 线程进入 per-`MdScope` 有界 ring；ring 满 → `md_lost_no_image_total++`，该 scope 进入 WARMUP，**不得只更新 latest 继续跑**。
- `LatestQuote` 是 `MdEvent` 的派生视图，不是替代品；coalesce 只发生在 `MdEvent` 已入 ring 之后。
- `LatestQuote` 槽用“单写者 + 不可变快照 + seq/version”发布；loop 读取的是完整记录，不能读到半更新字段。
- 指标/bar 只能消费 `MdEvent`；不允许从 `LatestQuote` 反推 bar（会丢 high/low/volume）。
- 策略通过 `Strategy.marketDataMode()` 声明 `LOSSLESS` 或 `QUOTE_ONLY`；默认 `LOSSLESS`。
- `QUOTE_ONLY` 策略在 `onMarketData` 中看到的是 latest，但必须检查 `age <= maxQuoteAgeMs`；过期不决策。

### 10.2 ring key、seq scope 与 epoch 切换

三者必须一致：

```text
MdScope = (venueId, sourceSessionId, sourcePublicationEpoch, exchange, instrumentId)
ring    = 每个 MdScope 一个
slot    = (venueId, exchange, instrumentId) 一个，记录内带 sourceSessionId/epoch/seq/version

epoch 比较 = (sourceSessionId, epoch) 字典序：
  新 sourceSessionId 允许 epoch 从 1 开始；
  sessionId 前进但 epoch 回退 -> 新 session，合法；
  sessionId 回退 -> stale，不覆盖。
```

epoch 切换：

```text
1. 新 epoch 的第一个事件到达时，旧 ring 继续 drain 完（lossless 消费者看到旧 epoch 尾部）
2. 新 epoch 必须等 MdReset/MdSnapshot 建立基线后，才允许交付
3. reset 之前：该 scope WARMUP，不把新 epoch 当“继续”
4. reset 之后：旧 epoch 的迟到事件 -> md_late_epoch_dropped_total（审计，不交付）
5. slot 只接受 (epoch > current) 或 (epoch == current && seq > slot.seq)
   epoch 回退 -> 丢弃并计数，不能覆盖新 epoch
```

禁止把 ring key 只写成 `(venue, instrument)`：reconnect 后新 epoch 的 seq 从 1 开始，会和旧 ring 冲突。

### 10.3 bar 聚合

- bar 聚合在 loop 内从 `MdEvent` 完成；使用事件 `eventTime`，不使用 `System.currentTimeMillis()`。
- 每个 instrument 维护 `currentBar`；bar 边界由 session calendar 决定。
- 收到 gap/reset 时：丢弃未完成 bar，标记 `bar_incomplete`，从 reset 后的第一个事件重新开始；不得拼接 gap 前后数据。
- volume 只能累加；重复事件（seq 回退）不重复累加。

### 10.4 gap 恢复与 MD reset 的 Port API（P0-8）

`VenueMarketDataPort` 必须提供 reset/snapshot 入口，策略/loop 不依赖实现类：

```java
record MdScope(String venueId, long sourceSessionId, long epoch,
               String exchange, String instrumentId) {}

enum MdResetSource { VENUE_SNAPSHOT, REPLAY_RESET, RESTART_BASELINE }

record QuoteLevel(double price, long qty) {}

record MdReset(MdScope scope, long seq, Instant asOf,
               String snapshotId, MdResetSource source) {}

record MdSnapshot(MdScope scope, long seq, Instant asOf, String snapshotId,
                  MdResetSource source, List<QuoteLevel> bids, List<QuoteLevel> asks) {}

interface VenueMarketDataPort {
    AutoCloseable subscribe(String venueId, String instrumentId,
                            Consumer<MarketDataEnvelope> sink,
                            Consumer<MarketDataGap> gapSink,
                            Consumer<MdReset> resetSink);

    void installSnapshot(MdSnapshot snapshot);   // venue snapshot / replay reset / restart baseline
    boolean supportsSnapshotReset();
}
```

- 默认实现若 `supportsSnapshotReset()==false`，必须 `throw` 或显式 WARMUP；不能静默忽略 gapSink。
- `MdReset` 进入 `RuntimeEvent`；loop 收到后设置 `lastSeq(scope)=reset.seq`、`state=OK`，并清空该 scope 的未完成 bar。
- **没有 reset 就一直 WARMUP**，不允许“跳过 gap 继续”。

MD 恢复状态机：

```java
enum MdState { OK, GAP, WAIT_RESET }

void onFragment(MarketDataEnvelope e) {
    MdScope s = scopeOf(e);
    MdState st = state(s);
    if (st == WAIT_RESET) { mdSuppressed++; return; }
    if (e.seq() == lastSeq(s) + 1) { deliver(e); lastSeq(s) = e.seq(); return; }
    if (e.seq() <= lastSeq(s)) { metrics.mdDuplicate++; return; }
    state(s) = WAIT_RESET;
    metrics.mdGap++;
    health.raise(MD_GAP, s, expected = lastSeq(s) + 1, actual = e.seq());
}

void onReset(MdReset r) {
    if (!r.scope().equals(currentScope)) return;
    if (r.seq() < lastSeq(currentScope)) return;      // 旧 reset
    lastSeq(currentScope) = r.seq();
    state(currentScope) = OK;
    barReset(currentScope);                          // 丢弃未完成 bar
    metrics.mdRecovered++;
}
```

consumer 重启的首个 seq：

- 有持久化 `lastSeqByStream/scope`：`seq == last+1` 继续；`seq <= last` 丢弃；`seq > last+1` 判 gap。
- 无持久化基线：必须等 `VenueSession.state==READY` + snapshot/reset，建立基线后才交付；不能把“第一个 seq”无条件当正常。

`lastSeqByStream` 的持久化格式（P0-8）：

```text
目录：runtime/seq/<venueId>/<accountId>/<streamKind>/
文件：<scopeHash>.json
内容：{
  "version": 1, "venueId": "...", "accountId": "...",
  "streamKind": "MD|ORDER|TRADE",
  "sourceSessionId": 123, "sourcePublicationEpoch": 7,
  "exchange": "SHFE", "instrumentId": "rb2601",
  "lastSeq": 456789, "lastEventTimeNanos": 123456789,
  "updatedAt": "2026-11-14T21:00:00Z", "writerRole": "READER",
  "crc32c": "..."
}
```

- 由 `qf-seq-cursor` 单线程原子写（tmp+rename+fsync）；MD I/O 只投 `SeqCursorUpdate`，不做文件 IO。
- 每 1s 或每 256 条更新一次；允许“少写”（重启后重放少量重复，由 seq 去重），不允许“多写”。
- 启动时校验 `sourceSessionId/epoch` 与 `VenueSession` 一致；不一致 → 基线无效，等 reset。
- exec 的权威 `lastAppliedByStream` 在 WAL checkpoint，不在这个 JSON；JSON 只用于 MD 和诊断。

### 10.5 `LatestQuote` 的发布语义（P0-9）

```java
final class LatestSlot {
    record Versioned(MarketDataEnvelope quote, long slotVersion,
                     long sourceSessionId, long epoch, long seq,
                     long receivedNanos) {}

    // 只在 (epoch, seq) 前进时替换；同一 seq 重发不更新版本
    void offer(MarketDataEnvelope e) {
        Versioned cur = ref.get();
        if (cur != null && !newer(e, cur)) return;
        ref.set(new Versioned(e, cur == null ? 1 : cur.slotVersion + 1,
            e.sourceSessionId(), e.sourcePublicationEpoch(), e.seq(),
            System.nanoTime()));
    }
}
```

loop 侧：

```java
void publishLatestIfChanged(Strategy s) {
    for (var slot : latestSlots) {
        long v = slot.slotVersion();
        if (v == lastDeliveredVersion.getOrDefault(slot.key(), 0L)) continue;  // 没变化不回调
        if (s.marketDataMode() != QUOTE_ONLY) continue;
        if (slot.ageMs() > maxQuoteAgeMs) continue;
        s.onMarketData(ctx, slot.quote().toLegacy(), slot.versionView());
        lastDeliveredVersion.put(slot.key(), v);
    }
}
```

规则：

- 同一 `(sourceSessionId, epoch, seq)` 的重复发布不推进 `slotVersion`，不触发 `onMarketData`。
- `LatestQuote` 的重复投递不推进策略的 `logicalIntentSeq`；只有真正生成订单时才推进。
- `slotVersion` 只用于“是否变化”，不是业务幂等键；业务幂等仍用 `intentId`。
- 若 slot 的 `age > maxQuoteAgeMs`，不回调；策略看到的是 stale，必须拒开仓。

### 10.6 replay 等价性（P0-9）

等价口径：**同一输入日志 + 同一 `CoalescePolicy` + 注入 `Clock` + 固定随机种子 + 稳定容器顺序**。

```java
enum CoalesceMode { NONE, LATEST_PER_LOOP, LATEST_PER_WINDOW }
enum DropPolicy { LAST_WINS, FIRST_WINS }

record CoalescePolicy(CoalesceMode mode, long windowMs,
                      int maxEventsPerInstrumentPerWindow,
                      DropPolicy dropPolicy) {}
```

默认值：

```text
LOSSLESS 策略 -> NONE
QUOTE_ONLY 策略 -> LATEST_PER_LOOP
需要限速时 -> LATEST_PER_WINDOW(windowMs=10, maxEvents=1, LAST_WINS)
```

可断言：

| 量 | 容差 |
|---|---|
| `netQty` / today/yesterday / working order 集合 | 完全一致（0） |
| `filledQty` / 订单终态 | 完全一致（0） |
| 决策序列（`intentId` 顺序、side/offset/qty） | 完全一致；价格允许 1 tick |
| `ledgerAvg` | `abs(diff) <= max(1 tick, 1e-6 * price)` |
| `realized` | `abs(diff) <= 1e-6 * Σ|qty*price*multiplier|` |
| `fees` | 源提供时完全一致；源缺失时两边都 `feeUnknown` |
| `cash` | `abs(diff) <= 0.01`（账户币种） |
| 样本 | 至少 3 个 session 或 100k fills；报告 p50/p99 差异 |

不可断言：raw replay 与 coalesced replay 逐字节一致；`LatestQuote` 回放与原始 tick 等价。

事件日志必须记录 `coalescePolicy` 和 `droppedCount`；replay 报告要能解释“少了多少 tick、为什么”。禁止再用“逐字节一致”作为验收。

Clock 注入：

```java
interface StrategyContext {
    Clock clock();          // replay 注入固定 clock
    long nowNanos();        // 等价于 clock.instant()/nanoTime，但可被替换
    ...
}
```

- `RuntimeClock` 三种模式：`SYSTEM`、`FIXED(Instant)`、`REPLAY(eventLog)`。
- replay 模式禁止 `System.currentTimeMillis/nanoTime`、`Instant.now()`、`new Date()`、`LocalDate.now()`；ArchUnit/字节码扫描覆盖 `runtime.loop`、`runtime.strategy`、`runtime.engine`。
- 旧策略不调用 `clock()` 时，runner 仍注入，但无法保证其内部时间；这类策略不得进入 replay 验收。

## 11. 决策链路：无 HTTP / JDBC / 文件 IO

### 11.1 loop 调用点清单（逐个处置）

| # | 当前 loop 内调用点 | 现在做什么 | Rev3 处置 |
|---|---|---|---|
| 1 | `RuntimeRunnerMain` → `DeploymentConfigLoader.load` | 每 5s MyBatis/JDBC | 移到 `qf-control-plane`；loop 只收 `Control(RELOAD_PREPARE)` |
| 2 | `RuntimeRunnerMain` → `controlPlane.reportHotState` | 每 5s 同步 HTTP | 移到 `qf-control-plane` |
| 3 | `RuntimeRunnerMain.refreshPositions` | 5s 拉 gateway positions（内部 HTTP） | `qf-venue-account` 拉快照 → SnapshotSlot；loop 只对账 |
| 4 | `RuntimeRunnerMain.refreshRisk` | 5s HTTP `riskSnapshot` | `qf-control-plane` 缓存 → RiskCacheSlot |
| 5 | `AeronOrderGateway.submit` → `ensureRisk` → `indicatorGate` | 每笔 OPEN 同步 HTTP | `RiskView.indicatorGate` 缓存 + TTL；无 HTTP |
| 6 | `AeronMarketData.ticks()` | 2s 无 tick 时 HTTP fallback | 删除；只认 Aeron（已删则保持） |
| 7 | `CloseoutGuard.drain/updatePositions` | 独立线程决策，经 gateway 发单 | loop session timer + OrderSink；M3 删除线程 |
| 8 | 主循环 `Files.exists(killFile)` | 每轮文件 IO | `qf-control-plane` 监听 → `Control(KILL)` |
| 9 | 热加载 `StrategyFactory.create` | 类加载/配置解析在 loop | `qf-control-plane` 构建 |
| 10 | `RuntimeEngine.replaceStrategies` | stop/start 在 loop；重放 latest tick | 仅 swap 在 loop；prepare 在 control；删除 tick 重放 |
| 11 | `pnlPublisher.publish` | Aeron offer（非阻塞但耦合） | telemetry 线程；loop 导出不可变快照 |
| 12 | `metrics.log` / `runnerMetrics` | 日志/HTTP | telemetry 线程；loop 只允许异步有界日志 |
| 13 | `catch` 分支 `Thread.sleep(pollMillis)` | 阻塞 loop | 删除；改为 fatal/backoff 策略 |
| 14 | `AeronOrderGateway.monitorOrderPublication` → `cancel()` | poll 线程直接 publish cancel | 发 `Control(RECONNECTED)`，loop 执行 |
| 15 | `AeronOrderGateway.reconcileOpenOrders` | risk 线程 `removeIf` | control 产出 `ReconcileReport`，loop 决策 |
| 16 | shutdown hook `drain(...)` | hook 线程 submit/cancel | loop drain 状态机（§7.6） |
| 17 | `FuturesPairStrategy` 分支 | 绕过 `RuntimeEngine` | `runtime=v3\|legacy` 显式标记；M4 迁移 |
| 18 | `RuntimeAeronService` / `RuntimeOrderClient` 第二条 poll 路径 | runtime 内 poll | 删除或移入 `...io`，M2 静态检查 |

### 11.2 RiskView 缓存与降级

```java
final class RiskView {
    String riskSnapshotId;
    Instant asOf;
    long staleAfterMs;
    Map<String, AccountLimits> accountLimits;
    Map<String, StrategyLimits> strategyLimits;
    Map<String, Boolean> indicatorGate;   // strategyKey -> enabled
    Instant gateAsOf;
    boolean gateLoaded;
    long leaseExpiryMillis;

    boolean gateFresh(long now) {
        return gateLoaded && now - gateAsOf.toEpochMilli() <= gateTtlMs;
    }

    boolean allowsOpen(OrderIntent i, long now) {
        if (now - asOf.toEpochMilli() > staleAfterMs) return false;      // risk stale
        if (leaseExpiryMillis <= now) return false;                     // lease 过期
        if (!gateFresh(now)) {
            return gateLoaded && now - gateAsOf.toEpochMilli() <= gateGraceMs;
        }
        return indicatorGate.getOrDefault(i.strategyKey(), false)
            && limitsAllow(i);
    }
}
```

- `indicatorGate` 不再每单 HTTP；控制面线程每 2s 拉取，loop 只读缓存。
- 控制面宕机时：risk/lease 仍新鲜 → 允许 OPEN；gate 在 grace 内沿用最后值；超过 grace → 拒 OPEN，但 CLOSE/CANCEL 始终允许。
- `riskSnapshot`、`positions`、`session` 的失败都不得变成“空 = 0 = flat”。
- `RiskCacheSlot` 覆盖旧版本时：risk/lease 字段丢版本 → fail-closed（WARMUP）；仅展示字段丢版本 → 只计数。

### 11.3 静态检查（ArchUnit / 字节码 / 运行时）

- 禁止包：`com.quantlink.fin.runtime.loop`、`com.quantlink.fin.runtime.strategy`、`com.quantlink.fin.runtime.engine`、`com.quantlink.fin.runner` 主循环代码。
- 禁止依赖：`java.net.http`、`java.sql`、`org.springframework.jdbc`、`java.nio.file`、`okhttp3`、`retrofit2`。
- 允许 IO 包：`com.quantlink.fin.aeron.io`、`com.quantlink.fin.runner.io`、`com.quantlink.fin.control`、`com.quantlink.fin.telemetry`。
- 线程断言：`PositionKeeper`/`OrderBookView`/`RiskView` 的每个 public 方法入口 `assertLoopThread()`。
- `grep` 检查：strategy loop 包内无 `subscription.poll`、无 `Thread.sleep`、无 `LockSupport.park`（idle backoff 除外，且 ≤1ms）。
- 运行时检查：I/O 线程若调用 `submit/cancel/publication.offer`，直接抛 `IllegalThreadStateException` 并 fatal。
- 日志：loop 内只允许异步/有界 appender；`log.error` 若可能同步刷盘，必须改为 `telemetry.log` 队列，队列满时计数并降级，不允许阻塞 loop。
- replay 模式：字节码扫描禁止 `System.currentTimeMillis/nanoTime`、`Instant.now`、`new Date`、`LocalDate.now`；策略必须通过 `StrategyContext.clock()`。

### 11.4 控制面接口的边界

- loop 不直接调控制面；所有控制面调用在 `qf-control-plane`。
- `qf-control-plane` 的失败只影响“新配置/新 risk/gate”的可用性，不影响已加载策略的 CLOSE/CANCEL。
- 控制面返回的 snapshot 必须带 `requestSeq/snapshotId/source/asOf/staleAfterMs`；缺字段按 §7.3 fail-closed。

## 12. Strategy SPI 扩展

### 12.1 接口与 Clock

```java
interface Strategy {
    String id();
    String strategyKey();                 // 默认 = id()；runner 生命周期内不可变

    default void onStart(StrategyContext ctx, StrategyStartSnapshot snapshot) {
        onStart(ctx);
    }
    default void onStart(StrategyContext ctx) {}
    default void onStop(StrategyContext ctx) {}

    default void onMarketData(StrategyContext ctx, MarketDataMessage message) {}
    default void onTimer(StrategyContext ctx, long nowNanos, TimerKind kind) {}
    default void onFill(StrategyContext ctx, Fill fill) {}
    default void onOrderUpdate(StrategyContext ctx, OrderView order) {}
    default void onPosition(StrategyContext ctx, PositionDelta delta) {}
    default void onPortfolioDelta(StrategyContext ctx, PortfolioSnapshot snapshot) {}
    default void onOrphanFill(StrategyContext ctx, Fill fill) {}

    default MarketDataMode marketDataMode() { return MarketDataMode.LOSSLESS; }
}

interface StrategyContext {
    Clock clock();                      // replay 注入；策略不得直接读系统时间
    long nowNanos();
    PortfolioView portfolio();          // 只读
    OrderBookReadView orders();         // 只读；写接口不暴露给策略
    RiskView risk();                    // 只读
    ExposureView exposure(DeltaSet set);
    void sendOrder(OrderIntent intent);
    void cancel(CancelIntent intent);
}
```

线程契约：

- 所有回调都在 `qf-strategy-loop`；实现不得阻塞、不得起线程、不得做 IO。
- `sendOrder` 只记录 intent；真正 publish 在回调返回后的批次末尾，保证同一轮回调看到的 pending 一致。
- `onTimer` 由 loop 的 100ms tick 驱动，支持 `FAST(100ms)`、`SLOW(1s)`、`SESSION`；错过的 timer 允许合并，但 `SESSION`/`CLOSEOUT` 至少触发一次。
- 现有 `StrategyContext` 是具体类；M2 迁移为只读接口（或保留类但移除可变 `Portfolio` 访问）。旧策略不实现新方法仍可运行。
- `onMarketData` 保持兼容，但 V3 根据 `marketDataMode()` 投递 `MdEvent` 或 `LatestQuote`。
- `futures_pair` 在 M3 前用 `runtime=legacy` 显式标记，不参与 V3 验收；M4 迁移为 `Strategy` 并删除旁路。

### 12.2 SimpleHedging 目标语义（P1-5）

```text
E = Σ_{i≠h} netQty_i * delta_i * mult_i
P = Σ signedRemaining_i * delta_i * mult_i
R = E + P + netQty_h * delta_h * mult_h

hedgeQty = |R| / |delta_h * mult_h|          // 对冲合约的“手数等价”，与 θ 同单位
side     = -sign(R * delta_h)
q        = lotRoundDown(min(maxOrderQty, hedgeQty * hedgeRatio), lot)
q == 0 -> HEDGE_TOO_SMALL，不下单
```

配置默认值与校验：

| 字段 | 默认 | 规则 |
|---|---|---|
| `thetaOpen` | `2 * lotSize` | 与 `hedgeQty` 同单位；必须 > `thetaClose` |
| `thetaClose` | `1 * lotSize` | 与 `hedgeQty` 同单位；必须 < `thetaOpen` |
| `cooldownMs` | 500 | 按 `(instrument, side)` 生效 |
| `lotSize` | instrument metadata | 缺失 → 禁止开仓 |
| `maxOrderQty` | 20 * lotSize | 不超过交易所限仓 |
| `hedgeRatio` | 1.0 | 乘在 `hedgeQty` 上，再取整 |

`armed` 规则（按 `hedgeQty` 判断，不按 `|R|` 的货币值）：

```text
初始（onStart 无 strategyState）：
  hedgeQty > thetaOpen -> ARMED
  否则                 -> DISARMED（中间区间不猜，避免启动即追单）
运行中：
  ARMED    + hedgeQty < thetaClose -> DISARMED
  DISARMED + hedgeQty > thetaOpen  -> ARMED
  中间区间保持原状态（滞回）
```

其他规则：

- 触发：`onFill`、`onOrderUpdate`（终态）、`onPosition`、200ms timer；不能只依赖对冲合约行情。
- `logicalIntentSeq` **只在真正生成 OrderIntent 时**递增；评估但不下单不递增。`intentId = hash(strategyKey, generation, logicalIntentSeq)`；`logicalIntentSeq` 持久化到 `strategyState`/WAL，`onStart` 恢复。
- 同一 `intentId` 重试不重复下单；不同逻辑意图必须换新 id。
- `onStart` 从 `StrategyStartSnapshot.strategyState` 恢复 `armed/cooldown/logicalIntentSeq`；空状态按上面的初始规则，不重放历史成交。
- `onStart` 幂等：同一 `snapshotId` 只应用一次；重复 `onStart` 不重置 `logicalIntentSeq`/`cooldown`，也不补发历史 intent。
- `onStop` 撤掉本策略未成交的 hedge 单；不撤其他策略/手工单。
- offset：减少现有 hedge 仓位时必须用 `CLOSE_TODAY`/`CLOSE_YESTERDAY`，按 today/yesterday 可用量；两者都有时拆成两个 intent（各自递增 `logicalIntentSeq`），不能默认 `OPEN`。
- 负 delta 对冲合约必须走 `R * delta_h` 符号判断；`lot`/`multiplier` 未知时禁止开仓。
- `fee` 未知时标 `feeUnknown`，不静默 0；`multiplier` 从 instrument metadata 读，不依赖默认 1.0。

## 13. 观测与验收

### 13.1 指标定义（必须可解释）

| 指标 | 定义 | 正常值 |
|---|---|---|
| `exec_ingress_total` | exec I/O 解码并尝试入队的事件数 | 单调增 |
| `exec_accepted_total` | 首次进入账本的 Fill/OrderUpdate 数 | 与 duplicate/gap/fatal 一起构成恒等式 |
| `exec_duplicate_total` | 幂等键重复的事件数 | ≥0，可解释 |
| `order_gap_total` | OrderUpdate stream-global seq 跳号 | 0（或对账后解释） |
| `trade_gap_total` | Trade 无 seq，只能由 TRADE_SNAPSHOT 对账发现的不一致 | 0 |
| `exec_dropped_total` | 无法进入账本且未计入 fatal 的事件数 | **必须 0** |
| `exec_fatal_total` | 触发 fatal 的事件数 | 0 |
| `exec_spooled_total` | adapter 落 spool 的事件数 | 0（正常） |
| `md_ingress_total` | MD envelope 数 | 单调增 |
| `md_delivered_lossless_total` | 进入 lossless ring 并交付的数 | ≤ ingress |
| `md_superseded_total` | latest 槽被覆盖的次数 | 可高，不是丢行情 |
| `md_lost_no_image_total` | ring 溢出或 gap 后、reset 前无法交付的 scope 事件数 | 稳态 0；>0 必须伴随 WARMUP 原因 |
| `md_gap_total` | MD seq gap 次数 | 0（演练注入除外） |
| `md_late_epoch_dropped_total` | reset 后旧 epoch 迟到事件 | 可解释 |
| `gap_recovery_ms` | gap 发生到 reset 生效的时长 | p99 < 5s（有 reset 源时） |
| `orphan_fill_total` | 旧 generation / 非当前 strategy 的成交数 | 0（正常），>0 必须审计 |
| `orphan_account_exposure` | manual/其他策略在账户账本中的敞口 | 0 或 handoff |
| `duplicate_intent_total` | 同 `intentId` 重复提交数 | 0（正常） |
| `order_submit_total{reason}` | 各 reason 的下单结果 | 可解释 |
| `order_publish_fail_total` | publication 失败/断连 | 0 |
| `position_drift_abs` | 每次对账的绝对 drift | ≤ tolerance |
| `position_reset_total` | 人工/自动 reset 次数 | 0 |
| `snapshot_age_ms` | 快照年龄 | < staleAfterMs |
| `snapshot_request_seq` | 当前快照请求序号 | 单调 |
| `warmup_seconds` | 每次 WARMUP 时长 | 可解释 |
| `shadow_dropped_total` | M1 shadow 队列丢弃数 | 只影响 shadow，不反压生产 |

恒等式：

```text
exec_ingress_total = exec_accepted_total + exec_duplicate_total
                   + order_gap_total + exec_fatal_total
trade_gap_total 由 TRADE_SNAPSHOT/position snapshot 对账产生，不参与 ingress 恒等式。
exec_dropped_total 独立告警，必须为 0；不为 0 时不计入上式，避免与 fatal 双算。
```

`md_dropped_total` 这个旧名字删除，拆成 `md_superseded_total` 与 `md_lost_no_image_total`，避免“覆盖”和“丢失”混在一个告警里。

### 13.2 延迟测量点

| 段 | 起点 | 终点 | 报告 |
|---|---|---|---|
| ingress | Aeron fragment 到达 I/O 回调 | `execQueue.offer` 返回 | p50/p99/p99.9/max |
| queue wait | offer 返回 | loop poll 到该事件 | p50/p99/p99.9 |
| apply | loop 取到 Fill | `PositionKeeper.applyTrade` 返回 | p50/p99/p99.9 |
| fill→strategy | apply 返回 | `Strategy.onFill` 返回 | p50/p99/p99.9，按策略 baseline 分开 |
| decision | `MdEvent` 出队 | `OrderIntent` 生成 | p50/p99/p99.9 |
| publish | `submit` 入口 | `publication.offer` 返回 | p50/p99/p99.9 + 成功率 |
| order RTT | publish 返回 | 首个 OrderUpdate ingress | 仅观测，不作为 SLO |
| timer jitter | deadline | 实际触发 | p99 |

所有延迟必须带 `sampleCount`、成功率、p99.9；不允许只报平均值。`apply` 与 `fill→strategy` 必须分开，策略慢不能污染账本 SLO。

### 13.3 验收标准

1. **poll 范围**：`grep -rn "subscription.poll"` 在 `com.quantlink.fin.runtime.loop`、`runtime.strategy`、`runtime.engine` 为 0；所有 poll 只在 `...io` / adapter 实现。
2. **线程所有权**：所有策略回调在同一命名线程；跨线程调用触发断言；ArchUnit 检查 `PositionKeeper`/`OrderBookView` 只被 loop 包引用。
3. **成交可见**：ingress→PositionKeeper p99 <1ms；`apply` p99 <1ms；`fill→onFill` p99 <5ms（策略 baseline 另计）。
4. **不丢**：24h soak 中 `exec_dropped_total=0`、`exec_fatal_total=0`；注入 publication null/closed/队列满时，要么 spool 可恢复，要么显式 fatal + 重启恢复，不允许静默丢。
5. **重复下单**：同一 `intentId` 提交 100 次，`acceptedForPublication=true` 最多 1 次；`duplicate_intent_total` 可解释。
6. **gap**：注入 MD gap 后，该 scope 无策略回调；`md_gap_total++`；只有 snapshot/reset 后恢复；`gap_recovery_ms` 有记录。
7. **快照**：缺 `asOf/staleAfterMs/tradingDay/snapshotId/source` 任一项 → `stale=true` → WARMUP；不存在 `Instant.now()` 伪造路径；`requestSeq` 单调。
8. **drain**：只有 §7.5 谓词成立才报 flat；否则 `DRAIN_INCOMPLETE` 且进程保持 reduce-only；manual 仓位未处理时不得报 flat。
9. **replay**：同一输入 + 同一 coalesce 规则 + 注入 clock + 稳定容器顺序 → `netQty`/`filledQty`/working 集合完全一致、决策序列一致、avg/realized 在 §10.6 容差内。
10. **24h soak**：连续 24h（含至少一个交易 session），`exec_dropped=0`、`duplicate_fill=0`、`orphan_fill=0`、`position_drift=0`、`md_lost_no_image=0`（或全部有 WARMUP 原因与 reset 记录）、`control_queue_depth<50%`、heap 无单调增长、WAL fsync lag p99 <2ms；中途 kill -9 三次均能精确恢复。
11. **冻结**：`sha256(abi/sbe/quantlink-fin-sbe.xml)` 等于冻结值；stream 表与 `venue-freeze-2026-11-12.md` 一致；身份映射无新增别名。

### 13.4 测试矩阵

| P0 | 测试 |
|---|---|
| P0-1 | `ExecNoDropIT`：打满 8192+、publication null/closed、listener 异常；spool 写入后 kill -9 重启，断言原序恢复且 exactly-once；磁盘满 fatal |
| P0-2 | `FillDoubleApplyIT`、`ReverseFillOrderIT`、`OrderUpdateVsTradeIT`、`RefreshBoundaryFillIT`、`TradingDayRolloverIT`、`SnapshotDriftAsOfIT` |
| P0-3 | `SnapshotStaleIT`、`NoLocalClockIT`、`AccountTruthSourceIT`、`RequestSeqMonotonicIT`、`AccountSnapshotFieldsIT` |
| P0-4 | `ReloadDuringFillIT`、`OldGenerationWorkingOrderIT`、`OrphanFillIT` |
| P0-5 | `LedgerOwnershipArchTest`、`PublicationSingleWriterTest`、`ReconcileNoDirectRemoveIT` |
| P0-6 | `ControlPriorityIT`、`ExecQueueFullIT`、`MdSlotBoundIT` |
| P0-7 | `LoopNoBlockingIoArchTest`、`RiskCacheIT`、`KillFileOffLoopIT`、`NoSystemClockIT` |
| P0-8 | `SequenceScopeIT`、`DedupAcrossDayIT`、`ConsumerRestartSeqIT`、`MdResetApiIT`、`StaleEpochFillIT`、`OrderUpdateRegressionIT` |
| P0-9 | `LosslessIndicatorIT`、`LatestQuoteVersionIT`、`ReplayEquivalenceIT`、`GapBarResetIT` |
| P0-10 | 每阶段退出测试见 §14 |
| P0-11 | `AccountExclusivityIT`、`ManualFillAttributionIT`、`DrainWithManualPositionIT` |
| P0-12 | `WALSelfContainedReplayIT`、`CheckpointCorruptionIT`、`KillNineRecoveryIT`、`DedupWindowIT` |

## 14. 迁移顺序与阶段准入

### 14.0 阶段准入表（更新）

| 阶段 | 是否允许进入 | 条件 |
|---|---|---|
| **M0a** Port 契约/字段/快照 | **允许，带条件** | 先完成 §14.1 的字段/truth source/registry 默认值；退出用行为测试，不用 grep |
| **M0b** 单账本/WAL/删 gateway 账本 | **有条件允许** | M0a 退出 + 本版 WAL schema/tradingDay/账户独占/`netQtyAt` 已评审通过；退出加 `WALSelfContainedReplayIT`/`TradingDayRolloverIT`/`AccountExclusivityIT` |
| **M1** 事件总线 shadow | **仅 shadow** | M0a 退出后；不得消费生产账本、不得参与决策；tee 点/复制/慢消费者按 §14.3；M0b 未退出时只做独立 harness |
| **M2** StrategyEventLoop/无 IO/SPI | **不允许** | 需要 M0b + M1 24h shadow 退出；P0-9 clock/latest/ring 已实现；`runtime.engine` 纳入 ArchUnit |
| **M3** runner cutover | **不允许** | 需要 M2 退出 + 24h shadow + drain fail-stop；`RuntimeRunnerMain.drain/cancelWorkingOrders/CloseoutGuard` 直连路径删除 |
| **M4** SimpleHedging | **不允许** | 需要 M3 退出 + §12.2 默认值/offset/onStart 落地；`HedgeStartupTest/HedgeIdempotencyIT/HedgeOffsetSplitTest` |
| **M5** Live | **不允许** | 需要 M4 + L0 spool + CTP no-drop/`tradeId` 空 fatal/`feeUnknown` + 控制面 flatten/handoff + 5 日 live 证据 |

直接回答：

- **M0a：允许进入**，但 `ControlPlaneVenueAccountPort` 的 `requestSeq/scope/AccountSnapshot` 字段和 `VenueDescriptor` 默认值必须先改；否则退出测试会红。
- **M0b：有条件允许**，前提是 M0a 退出，并且 WAL/交易日/账户独占按本版实现；不再因为“设计未定”而阻塞。
- **M2/M3：仍不允许**；M2 卡在 M0b/M1 退出，M3 卡在 M2 退出、24h shadow 与 drain fail-stop。

### 14.1 M0a — Port 契约、字段、快照语义

内容：

- `VenueDescriptor`：补齐 §7.1 全字段；`environment/adapterKind` 必填，删除 `SHADOW/UNKNOWN` 默认；`capabilities` 保持 `{supported, constraints}`。
- `Snapshot<T>`：加 `requestSeq/scope/requestedAt/completedAt`；`asOf` 明确为 `snapshotAsOf`。
- `PositionSnapshot`：加 `strategyKey/scope/positionAsOf`。
- `AccountSnapshot`：补 ADR-004 §5.3 字段；未知用 `null`。
- `VenueSession`：加 `lastSeqByStream[]`。
- `VenueMarketDataPort`：加 `resetSink/installSnapshot/supportsSnapshotReset`；默认实现 fail-closed，不静默丢 gap。
- `VenueAccountPort`：加 `requestSeq`；数据源切到 account truth（`positions` 表/account 投影）；禁止 `riskSnapshot`。
- `VenueHealthPort`/`VenueAccountPort`：`supportsPositionStream()/supportsHealthStream()` 显式能力位；false 走 snapshot-only + WARMUP，不能把默认 `throw` 当空。
- `VenueExecutionPort`：`OrderSubmission/CancelSubmission` 加 `retryAfterMs`；`subscribe` 保持 venue/account scope，不按 strategyKey 丢真实成交。
- `TradeEnvelope`：加消费侧 `tradingDay`（SBE 不改），由 `VenueSession`/adapter 注入；加 `TradeTradingDayIT`。
- registry 默认值：删除 `VenueRegistryService` 非 REPLAY 返回 `SHADOW`、`AeronMarketData` `"*"`、`AeronOrderGateway` `"legacy"/"SIM"`、`AeronStreams` `1001/2100/3140` 默认；缺配置 fail-closed。
- `ControlPlaneVenueAccountPort`：删除所有 `Instant.now()` fallback；`staleAfterMs/snapshotId/source` 透传；`snapshotAsOf` 与 `positionAsOf` 分离。

退出证据（行为测试，不用伪 grep）：

```text
./gradlew :backend:shared:aeron:test --tests '*VenuePorts*'
./gradlew :backend:runtime-runner:test --tests '*VenueAccountPort*'
./gradlew :backend:control-plane:test --tests '*Registry*'

SnapshotStaleIT:
  - 缺 serverTime/asOf -> EPOCH + stale=true + trusted=false
  - 缺 staleAfterMs -> 0 + trusted=false
  - 缺 snapshotId/source -> stale=true
  - 行 updated_at 很旧但 snapshot asOf 新鲜 -> 不因行年龄判 stale
NoLocalClockIT:
  - 字节码扫描 ControlPlaneVenueAccountPort/runner account 包：Instant.now/System.currentTimeMillis = 0
  - 行为：把系统时钟拨快 1h，port 返回值不变
AccountTruthSourceIT:
  - 控制面返回 STRATEGY_LEDGER/risk 投影 -> scope=STRATEGY + trusted=false
  - 控制面返回 positions 表/account 投影 -> scope=ACCOUNT + source=CTP/SIM
RequestSeqMonotonicIT:
  - 连续 100 次 positions() 的 requestSeq 严格递增
AccountSnapshotFieldsIT:
  - balance/available/margin/commission 缺失 -> stale；可选字段缺失 -> null，不是 0
DescriptorFieldsIT / RegistryDefaultsIT:
  - 缺 environment/adapterKind/streams -> 启动失败
  - 非 REPLAY 不再返回 SHADOW；无 1001/2100/3140 回退
TradeTradingDayIT:
  - 夜盘 21:00 成交 -> tradingDay 为下一交易日，不是本地日历日
  - session 未解析 -> pendingTradingDay 缓冲；5s 后 fatal，不猜
MdResetApiIT:
  - gap 后 subscribe 的 resetSink 收到 MdReset；installSnapshot 后恢复交付
  - 没有 reset 时一直 WARMUP，不跳过 gap
conformance: V-04 / V-06 / V-08 / V-09 / V-11 全绿
sha256(abi/sbe/quantlink-fin-sbe.xml) == 冻结值
```

### 14.2 M0b — 单账本 + WAL + 删除 gateway 账本

内容：

- `PositionKeeper`（策略）与 `AccountLedger`（账户）成为唯一持仓写者；`OrderBookView` 成为唯一订单写者。
- 删除 `AeronOrderGateway.positions` 与决策用 `orders`；类改名为 `AeronExecutionIo` 并移到 `com.quantlink.fin.runner.io`（或保留在原包，但测试扫描**实际包**）。
- `refreshPositions`/`reconcileOpenOrders` 只产出 `ReconcileReport`；对账/控制面线程不得 `removeIf`。
- WAL/checkpoint/dedup journal；恢复点 `lastApplied`；`INTENT/FILL_ACCEPTED/ORDER_STATE/POSITION_RESET/CHECKPOINT` 按 §6.8 schema。
- 交易日切换 `DAY_ROLL`、`netQtyAt(asOf)` fill 历史、`ledgerAvg/displayAvg` 拆分。
- 账户独占：DB 唯一约束 + lease + `ACCOUNT_ALREADY_OWNED`。
- manual/blank strategy Fill：`ORPHAN_ACCOUNT_FILL` + `AccountLedger`，不进策略账本。
- `Portfolio.replacePosition/clearPositions` 从热路径删除；`Portfolio` 只读聚合；`cash/notional` 乘 multiplier。

退出证据：

```text
ArchUnit/反射（扫实际包，不假设 runner.io 存在）:
  - com.quantlink.fin.runner 与 com.quantlink.fin.runner.io 中
    AeronOrderGateway/AeronExecutionIo 不得有字段名 positions/orders
  - 不得有 Map<Long, ...> positions / Map<Long, ...> orders
  - AeronExecutionIo 只依赖 decode/guard/dedup/publish，不依赖 PositionKeeper/OrderBookView

WALSelfContainedReplayIT:
  - 只给 ledger 目录（venue/account/strategy 从 SESSION_CONTEXT 读），不给当前 runner 配置
  - kill -9 于 5 个注入点，重启后 netQty/filledQty/working 与预期完全一致

TradingDayRolloverIT:
  - 夜盘跨日：today -> yesterday、settlement、dedup 日切
  - 旧日迟到 fill：被快照覆盖只审计；未被覆盖进 yesterday
SnapshotDriftAsOfIT:
  - 快照 asOf 早于最后 fill：netQtyAt 返回 UNKNOWN，不产生假 drift
  - 快照 asOf 晚于最后 fill：drift 可判定
AccountExclusivityIT / ManualFillAttributionIT / DrainWithManualPositionIT
PendingExposureIT / CancelRequestedPendingIT / SeedOpenOrdersIdempotentIT
CheckpointCorruptionIT / KillNineRecoveryIT / DedupWindowIT / TerminalStickyIT
```

### 14.3 M1 — 事件总线 shadow（不改路由）

内容：

- `RuntimeEvent`、`EventInbox`、独立 control 队列、exec 队列、`MdPipe`、metrics。
- 旧 latest 路径保留，新总线 shadow 运行；只观测，不参与决策。
- 计数口径：`ingress = accepted + duplicate + order_gap + fatal`；`trade_gap_total` 由快照对账单独计数；MD `delivered ≤ ingress` 必须可解释。

**shadow tee 点（必须明确）**：

```text
位置：ExecIngress.accept() 内，identity/epoch/fencing/seq guard 之后，
     execQueue.offer 之前。
复制：把 envelope 的标量字段复制成不可变 ShadowEvent；
     不共享 DirectBuffer，不持有 Aeron fragment 生命周期。
队列：shadow 独立有界队列 65,536，DROP_NEWEST；生产路径 never blocks。
线程：qf-shadow 单线程消费；与 qf-strategy-loop 分离。
慢消费者：shadow 落后 >5s -> 暂停 shadow、计 shadow_lag_ms、告警；
         不得反压 I/O/loop，不得丢生产事件。
```

退出证据：

```text
EventBusShadowIT:
  - 200k exec 事件突发，shadow 计数 == production accepted 计数
  - 生产 p99 ingress 与无 shadow 时差异 <10%
  - shadow 暂停 5s，生产 exec_dropped_total=0，shadow_dropped_total 可解释
ControlPriorityIT:
  - 100 万 Fill 下 SHUTDOWN 在 2ms 内被 loop 取到（预算 200µs + 队列）
指标恒等式测试通过（每个 stream 单独断言）
shadow 运行 24h，无内存增长，无未解释 gap
```

**不再使用“事件计数 == poll 计数”。** coalesce 后 delivered 必然小于 poll。

### 14.4 M2 — StrategyEventLoop、无 HTTP/JDBC、SPI

内容：

- `RuntimeEngine.onMarketData/onTimer/onFill/onOrderUpdate` 全部走 loop。
- `PositionKeeper`/`OrderBookView`/`RiskView` 单写者 + 线程断言。
- 删除 loop 内 `DeploymentConfigLoader`、`reportHotState`、`indicatorGate` HTTP、kill-file 文件 IO、`Thread.sleep` 兜底。
- `Strategy` 新 default 方法；`onTimer` 真正接线；`futures_pair` 显式 legacy。
- hot reload 改 control 构建 + loop swap；旧 working 先撤/转移；删除 `marketData.values()` 重放。
- `StrategyContext.clock()` 注入；replay 禁止系统时间；`LatestQuote` 版本化；ring key 与 seq scope 一致。

退出证据：

```text
LoopNoBlockingIoArchTest 全绿（HttpClient/JdbcTemplate/Files/okhttp 均禁止）
  - 范围包含 com.quantlink.fin.runtime.engine 与 runner 主循环包
ThreadOwnershipTest / TimerWiringTest / SpiCompatibilityTest 全绿
NoSystemClockIT:
  - replay 模式下 runtime.loop/runtime.strategy/runtime.engine 无系统时间调用
LatestQuoteVersionIT:
  - 同一 seq 重复发布 1000 次，onMarketData 只回调 1 次
ReplayEquivalenceIT:
  - netQty/filledQty/working 完全一致；avg/realized 在 §10.6 容差内
ReloadDuringFillIT / OldGenerationWorkingOrderIT 全绿
grep -R "Thread.sleep" backend/runtime/.../loop => 0
```

### 14.5 M3 — Runner cutover

内容（先删路径，再谈退出 grep）：

- 删除 `RuntimeRunnerMain.drain` 直接 `orderGateway.submit`（当前 `:341`/`:389`）。
- 删除 `cancelWorkingOrders` 直接 `orderGateway.cancel`（当前 `:402`/`:365`）。
- 删除 `CloseoutGuard` 独立线程（当前 `:185`）；closeout 由 loop timer 驱动。
- 删除 5s `refreshPositions`、latest map、HTTP 风险轮询、shutdown hook 直接 drain。
- `OrderSink` 统一走 `VenueExecutionPort`；runner 不再直接依赖 `AeronOrderGateway`。
- `runner=v3|legacy` flag；legacy 只保留一个回滚窗口。
- 24h shadow → 单账户 canary。

退出证据：

```text
RunnerCutoverIT:
  - 24h shadow，position_drift=0，duplicate_intent=0，orphan_fill=0
  - kill -9 三次，重启后 working/positions 可解释
  - 重连：publication closed -> cancel -> ORDER_SNAPSHOT 对账 -> READY
DrainIT:
  - flat 谓词成立才退出
  - 60s 未 flat -> REDUCE_ONLY + handoff，进程不退出
  - 快照过期 -> 不报 flat
  - MD 断流 -> 无法获得可信定价 -> handoff，不用过期价硬平
  - manual 仓位存在 -> 不报 flat
KillSwitchIT: kill file 由 control 线程处理，loop 无文件 IO
扫描（实际模块，不是假设包）:
  grep -R "orderGateway\.\|gateway\.submit\|gateway\.cancel" \
       backend/runtime-runner/src/main/java
  允许文件仅限 AeronVenueExecutionPort.java / AeronExecutionIo.java（Port 实现）；
  其他文件命中 = 失败
  grep -R "class CloseoutGuard\|new CloseoutGuard" backend/runtime-runner/src/main/java => 0
  grep -R "void drain(\|cancelWorkingOrders(" backend/runtime-runner/src/main/java => 0
```

### 14.6 M4 — SimpleHedging

内容：

- 实现 §12.2 的 `E/P/R` 公式、`side=-sign(R*delta_h)`、lot 取整、`θ_open/θ_close/armed/cooldown`。
- 触发改为 `onFill`、`onOrderUpdate`（终态）、`onPosition`、200ms timer；不再只依赖对冲合约行情。
- offset 按 `PositionKeeper` 的 today/yesterday 可用量选择 `CLOSE_TODAY`/`CLOSE_YESTERDAY`；两者都有时拆单。
- `intentId` 稳定；删除 gateway 的价格去重；实现 `onStart/onStop`。
- fee/multiplier：multiplier 从 instrument metadata 读并显式设置到 `PositionKeeper`；fee 取不到标 `feeUnknown`。

退出证据：

```text
HedgeSideSignTest: delta_h<0 时方向正确
HedgeStartupTest: hedgeQty 在 θ_close~θ_open 之间启动 -> DISARMED；>θ_open -> 允许首笔
HedgeIdempotencyIT: 同一 intentId 重复触发只产生 1 个 accepted intent；不同 intent 的同价补单不被吞
HedgeOffsetSplitTest: today/yesterday 都有 -> 两个 CLOSE intent，不默认 OPEN
FeeMultiplierPnlIT: 回放 PnL 与手工计算误差 ≤ 1e-6
```

### 14.7 M5 — Live

内容：

- shadow → 单账户 canary → 全量；保留 `runner=v3|legacy` 回滚开关。
- 维护窗口完成 CTP adapter no-drop/spool 改造（§8.3）。
- 控制面 flatten/handoff API 就绪。
- `ExecNoDropIT` 增加 spool 重启恢复断言。

退出证据：

```text
ExecNoDropIT:
  - 打满 8192+、publication null/closed、listener 异常
  - spool 写入后 kill -9 adapter，重启按 spoolSeq 原序恢复
  - REQ：每个 clientOrderId 恰好一次；EVT：每笔 trade 恰好一次
  - 磁盘满 fatal；尾部撕裂截断；中间缺号 ExecGap+fatal
连续 5 个交易日：exec_dropped=0、exec_fatal=0、orphan_fill=0、duplicate_fill=0
每日 drain：flat 100% 或显式 handoff + operator ack
每日对账：position_drift_abs=0，snapshot_age_ms 在阈值内
回滚演练：切回 legacy 后旧路径可接管在途订单
```

### 14.8 回滚与在途订单

每阶段必须有：

- feature flag：`runtime=v3|legacy`、`shadow.enabled`、`md.mode`、`ledger.wal.enabled`。
- 双读/双订阅：新端口与旧路径并行时，只允许一个写账本；shadow 只读。
- 回滚条件：退出证据任一红、`exec_fatal>0`、`position_drift` 连续 3 次、`orphan_account_exposure>0`。
- 在途订单：回滚前必须先 `DRAIN` 或显式 transfer；不允许把未知 working 留给 legacy。

## 15. 风险与开放问题

风险：

- **loop 瓶颈**：MD 高频 + 指标计算可能拖慢执行事件；用 512/2048 双预算、lossless ring 和 10x 压测验证。
- **adapter 背压传导**：exec spool 会占用磁盘；容量/轮转/告警已在 §8.3 定义，但 spool 满仍是 fatal，必须演练。
- **跨流乱序**：`ledgerAvg/realized` 在窗口外不精确；策略契约写死“只用 netQty + pending 做风险”。
- **热加载**：撤单超时、旧 generation 成交、transfer 语义都可能留下 orphan；`orphan_fill_total`/`orphan_account_exposure` 必须有处置流程。
- **多账户**：V3 只支持单策略单账户；多账户聚合是只读视图，不共享 loop。
- **CTP 无 venue trade sequence**：avg 只能“条件精确”；如果业务要求精确 avg，需要 venue 提供序列或改为快照结算。
- **账户真值接口延迟**：`positions` 表来自 `PositionSnapshotV2`，若控制面/venue 快照延迟，drift 会滞后；用 `staleAfterMs` 与 `requestSeq` 显式暴露，不猜。
- **manual 仓位**：任何手工单都会阻止自动 flat；这是有意的 fail-closed，但需要运维 handoff 流程。

开放问题（不阻塞 M0a，但阻塞对应阶段）：

1. 是否引入 Aeron Archive：引入后 retention/rewind/磁盘预算/恢复流程进 M5 还是独立阶段；不引入则 L1 永久是“检测+对账”。
2. `tradingDay` 权威源：adapter `VenueSession.tradingDay` 与控制面 `tradingDayLabel` 不一致时以谁为准；本版选 adapter/session，控制面必须对齐。
3. `lastSeqByStream` 存文件还是 DB：本版选文件 + `qf-seq-cursor`；多机/容器迁移时的卷挂载需要运维确认。
4. shutdown 30s 后 supervisor 是否允许自动重启：本版要求 operator ack，supervisor 不得自动拉起。
5. manual 仓位的 handoff API 由谁提供、operator ack 存哪里。
6. `AccountSnapshot` 可选字段（deposit/withdraw 等）的 venue 覆盖度；缺失时展示 unknown。

## 16. 仍未关闭 / 依赖项

本版只关闭**设计层** P0/P1。以下事项仍需 Ports/代码/控制面/维护窗口，不能当成已完成。

### 16.1 Ports 与代码依赖

| 依赖 | 现状 | 阻塞阶段 |
|---|---|---|
| `VenueDescriptor` 全字段 + 无默认 | 只有 `venueId/environment/adapterKind/capabilities`；仍有 SHADOW/UNKNOWN 默认 | M0a |
| `Snapshot.requestSeq/scope` | 无 | M0a/M0b（flat） |
| `PositionSnapshot.strategyKey/scope/positionAsOf` | 无 | M0a/M0b（P0-11） |
| `AccountSnapshot` ADR 字段 | 只有 balance/available/tradingDay/snapshotId/source/asOf | M0a |
| `VenueSession.lastSeqByStream` | 无 | M0a |
| `VenueMarketDataPort` reset/snapshot | 只有 gap 重载，默认丢 gap；无 reset API | M0a |
| `VenueAccountPort` truth + requestSeq | 已改 account 投影；仍缺 requestSeq/scope/staleAfterMs 透传 | M0a |
| `TradeEnvelope.tradingDay` | 无；SBE 不改，需消费侧注入 | M0a |
| `VenueExecutionPort` guard | 只有 per-order lastSequence；无 epoch/fencing/deploymentGeneration | M0a/M0b |
| `AeronOrderGateway` | 仍持有 `positions/orders`、risk 线程 reconcile、poll 线程 cancel | M0b |
| `Portfolio` / `PositionKey` | 仍按 `instrumentId`；`replacePosition/clearPositions` 仍在 | M0b |
| `OrderIntent` | 现有 record 无稳定 `intentId` | M0b |
| WAL/checkpoint/PositionKeeper/AccountLedger | 未实现 | M0b |
| `Strategy` / `StrategyContext` | 缺 clock/fill/order/position/timer 回调与只读视图 | M2 |
| `RuntimeEngine` 移除 tick 重放/telemetry | 未做 | M2 |
| `RuntimeRunnerMain.drain/cancelWorkingOrders/CloseoutGuard` | 仍直连 gateway | M3 |
| 控制面 registry 客户端/默认值 | 仍有 SHADOW/SIM/legacy/1001 回退 | M0a |

### 16.2 CTP adapter（需要 Linux 构建 + 维护窗口）

- `kMaxOutbound=8192` 的 `outboundDropped_++` 必须删除，改为阻塞/spool/fatal。
- `publishOrder`/`publishTrade` 在 `closing_ || !pub_` 时直接 `return` 必须删除；改为 EVT spool。
- `publishTrade` 的 `"CTP-"+clientOrderId` 兜底必须删除；`tradeId` 为空即 fatal。
- `fee=0` 目前无法区分“零费用”和“未知费用”；在 adapter 补 fee 来源前，PnL 必须标 `feeUnknown`。
- REQ/EVT spool 格式、容量、轮转、fsync、重放、ack watermark 需要 C++ 侧实现，并跑 conformance。
- 以上未完成前，**M5 不通过，live 不得开启**。

### 16.3 控制面与运维依赖

- `/api/v1/positions` 或 account 投影必须返回 `source/snapshotId/asOf/staleAfterMs/requestSeq/scope`；当前接口字段不足。
- `positions` 表/`PositionSnapshotService` 要有 account-scope 快照批次语义；per-row `updated_at` 不能当 snapshot asOf。
- 账户独占 DB 唯一约束/lease 表；`strategy_deployments(venue_id, account_id)` 的迁移与回滚。
- 控制面 flatten/handoff API、operator ack 存储、drain 超时告警闭环。
- WAL 磁盘配额、轮转、备份与恢复演练；checkpoint 损坏降级路径。
- `environment` 真实来源与 registry 校验；删除 `"SIM"/"*"/"legacy"/1001/2100/3140` 默认。
- 维护窗口：CTP adapter 升级、stream 双订阅、runner 切换、回滚演练。
- 24h soak 与 5 日 live 证据；kill -9/重连/未 flat 演练。

### 16.4 文档同步依赖

- `docs/architecture/venue-contract.md` §5 的 `tradeId 全局唯一（venueId + tradeId）` 必须改为 `(venueId, tradingDay, tradeId)`；本版运行时以三元组为准。
- ADR-004 §5.3 的 `AccountSnapshot` 字段与本版 §7.1 对齐；若 ADR 不增字段，则本版的 `null=unknown` 必须在 venue-contract 注明。
- `docs/tasks/T-060/T-061` 的验收项要引用本版 §14 的退出证据，不再引用 Rev2 的 grep。
- `venue-freeze-2026-11-12.md` 的 SBE 哈希不变；本版只加 Java 消费侧字段。

### 16.5 本版明确不做

- 不承诺普通 Aeron transport replay；Archive 不是默认路径。
- 不承诺 CTP 无 venue sequence 时任意乱序 `ledgerAvg/realized` 精确；只承诺 `netQty` 精确 + avg 可校正。
- 不承诺控制面宕机时无条件开仓；只在 risk/lease 新鲜且 gate 在 grace 内时允许。
- 不承诺 manual/其他策略仓位自动 flat；必须 handoff 或 operator ack。
- 不在本版实现代码；代码关闭证据按 §14 各阶段补齐。

---

**本版变更范围**：仅改写 `docs/architecture/v3-event-driven-runtime.md`。未改代码、未 commit。Revision 3 的关闭结论以本文件与 §14 退出证据为准；R2 评审中的“PARTIAL/OPEN”项若与本版冲突，以本版为准。

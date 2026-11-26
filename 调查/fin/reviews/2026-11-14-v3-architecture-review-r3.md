# V3 事件驱动运行时设计复审（R3）

- 日期：2026-11-14
- 对象：`docs/architecture/v3-event-driven-runtime.md`，**Revision 3**（2026-11-14，2344 行）
- 上一轮：`docs/reviews/2026-11-14-v3-architecture-review-r2.md`（针对 Revision 2，结论 APPROVE_WITH_CHANGES）
- 必读约束：`docs/architecture/adr/ADR-004-unified-venue-integration.md`、`docs/architecture/venue-freeze-2026-11-12.md`、`docs/architecture/venue-contract.md`
- 结论：**APPROVE_WITH_CHANGES**

> 口径：本评审判断的是“设计层是否给出了可实现、可验收、与冻结契约一致的机制”，不是“代码是否已经实现”。设计里写了规则，但规则缺少字段、类型、状态机、数据来源或退出证据的，仍记为 PARTIAL。代码现状只用于检验设计假设是否成立，不要求本轮代码完成。

## 0. 总体判断

Revision 3 是一次有效的收敛，不是给 Revision 2 补几段文字：

1. L1 不再承诺普通 Aeron publication 的 replay，明确“可检测 gap + venue 快照对账”，Archive 只作为可选增强（§1.2）。
2. L0 spool 从一句开放问题变成可实施的布局、记录头、容量/水位/轮转/fsync/清理/磁盘满/重放/dedup（§8.3）。
3. WAL 从“字段列表”变成文件布局、28 字节记录头、CRC32C、`SESSION_CONTEXT`、按类型的必填字段、checkpoint 原子写与恢复原子性（§6.8）。
4. `netQtyAt(asOf)` 有了 per-`PositionKey` 的 `FillHistory`、超窗 UNKNOWN、乱序置 `complete=false`、快照基线重建（§6.7）。
5. 交易日切换有了 `DAY_STABLE/ROLL_PENDING` 状态机、日切 dedup 两代结构、`DAY_ROLL` 记录（§6.6）。
6. 账户/策略两套账本、manual/blank fill 归属、账户独占的 DB+lease 约束写成了启动强校验（§6.1、§6.10、§7.5）。
7. MD reset 进入 Port API，`MdReset` 进入 `RuntimeEvent`，ring key 与 seq scope 统一，`LatestQuote` 版本化，replay 有 `CoalescePolicy` 和数值容差（§10.2–§10.6）。
8. M0a 的退出证据从伪 grep 改为行为/字节码测试；M0b 要求扫实际包并断言 gateway 字段删除；M1 定义了 tee 点；M3 明确先删直连路径（§14）。

但本轮复核认为 **7 个 P0 仍是 PARTIAL**，其中三个是 R3 新引入或新暴露的阻断项：

- **P0-13（新增）`tradingDay` 的权威来源没有落地，也没有排期。** 设计把 `VenueSession.tradingDay` 当作唯一权威（§6.6、§5.1），但 CTP adapter 目前根本不发布 `VenueSession`；`currentTradingDay()` 用 `localtime_r` 取本地日历日（`ctp_aeron_bridge.h:566-573`），`publishAccount` 直接用它（`:180`）；`TradeV2`/`PositionSnapshotV2` 也没有 `tradingDay` 字段。M0a 只加 Java 消费侧字段，§16.2 的 CTP 改造清单没有“发布 session/交易日”这一项。按当前文字，CTP live 的 `pendingTradingDay` 只能等 5s 后 fatal，或者退回本地日历日——后者正是 R2 明确禁止的。
- **P0-14（新增）`AccountLedger` 没有 account-scope checkpoint。** WAL 目录是 `ledger/<venue>/<account>/<strategy>`（§6.8.1），`CHECKPOINT` 也只带 `strategyKey`；manual/blank fill 即使被写进当前策略 WAL，checkpoint 也没有 `AccountLedger` 的 positions/orders。重启后从 checkpoint 开始的 WAL 无法恢复 checkpoint 之前的手工仓，`orphan_account_exposure`/`foreign_strategy_exposure` 可能归零，`flat()` 会把“还有手工仓”误判为 flat。这不是实现细节，是 P0-11 与 P0-12 的交叉缺口。
- **P0-15（新增）L0 spool 的跨 session/重启边界未定义。** spool 路径包含 `<sourceSessionId>-<epoch>`（§8.3.1），`spool.meta` 是每个目录一份；§8.3.3 只说“启动 read spool.meta -> ackSpoolSeq”。如果 adapter 重启后拿到新的 `sourceSessionId`，新目录的 ack 从 0 开始，旧目录里未 ack 的 REQ/EVT 永远不会被重放。`M5 ExecNoDropIT` 也没有“重启后 session id 变化”的用例。

另外两个跨条目的问题会直接影响“设计层可编译/可自洽”：

- **`TradingDay` 类型在 `Snapshot`/`VenueSession`/`PositionState`/`trusted()` 之间不一致。** `TradingDay` 是 record（§5.1），`PositionState.tradingDay` 用它（§6.2），但 `Snapshot.tradingDay`、`VenueSession.tradingDay`、`AccountSnapshot.tradingDay` 都是 `String`；`trusted()` 写 `currentDay.equals(s.tradingDay())`（§7.3），`TradingDay` 与 `String` 比较永远不等。这不是“实现者自己决定”的问题，是字段类型没有统一。
- **MD `lastSeq` 的所有权在 §4.2/§4.3 与 §10.4 之间冲突。** §4.2 说 `qf-venue-md` 拥有 scope seq tracker，§4.3 说 MD `lastSeqByStream` 内存态由 md I/O 写；但 §10.4 的 `onReset` 在 loop 里写 `lastSeq(currentScope)` 并 `barReset`，而 bar 又在 loop 内。无论 `onReset` 跑在哪个线程，都会违反其中一条。

因此结论仍是 **APPROVE_WITH_CHANGES**：M0a 可以在带条件的情况下开工；M0b、M2、M3 不能按当前文字进入。

## 1. R2 P0 关闭表

| P0 | R2 结论 | R3 自述 | 本轮结论 | 设计落点 / 主要缺口 |
|---|---|---|---|---|
| P0-1 端到端不丢 | PARTIAL | CLOSED | **PARTIAL** | §1.2、§5.2、§8.3、§13.4、§14.7。L1 措辞已修，spool 已细化；但 spool 按 session 分目录、无跨 session ack；C++ 单一 `outbound_` 同时承载 order/trade/position/account/snapshot，§8.3 只定义 REQ/EVT 的 order/trade；`feeKnown` 无 wire 表达；`closing_` 与 publication null 未区分。 |
| P0-2 双重记账/顺序 | PARTIAL | CLOSED | **PARTIAL** | §6.2–§6.8。字段/状态机大幅补齐；但 `tradingDay` 权威源缺失（P0-13）；`rollDay(ACCOUNT snapshot)` 会把 manual/其他策略仓写进 `PositionKeeper`（§6.6）；checkpoint 只有 `dedupWatermark`，没有当日 dedup 集合。 |
| P0-3 snapshot 假新鲜 | PARTIAL | CLOSED | **PARTIAL** | §7.1–§7.3、§14.1。truth source、`snapshotAsOf/positionAsOf`、`requestSeq`、行为测试都写了；但 `trusted()` 只黑名单 `STRATEGY*`，当前 `ACCOUNT_POSITION` 会通过；`PositionSnapshot` 的 `long/double` 无法表达 unknown；`Instant.now()` 年龄计算未接 `RuntimeClock`；`snapshotId` 仍由 `asOf` 合成。 |
| P0-4 热加载丢成交 | CLOSED | CLOSED | **CLOSED** | §9.1–§9.3、§14.3。事件分类、先撤旧 working、orphan fill、`strategyKey` 不可变都已给出；无回归。 |
| P0-5 单写者/线程边界 | CLOSED | CLOSED | **CLOSED*** | §4.2–§4.3、§6.8。所有权表成立；但 §10.4 的 MD `lastSeq`/`barReset` 与 §4.2/§4.3 冲突，WAL append/rotate 交接未定义，见 P1-15/P1-16。 |
| P0-6 队列/背压/control 饿死 | CLOSED | CLOSED | **CLOSED** | §4.4、§5.2–§5.3。`FatalSlot`、control 独立队列、exec 满即 fatal、预算数值化都已给出。 |
| P0-7 决策链路 HTTP/JDBC | CLOSED | CLOSED | **CLOSED** | §11.1–§11.3。18 个调用点逐项处置，`runtime.engine` 纳入 ArchUnit，`log.error` 改为异步/有界。 |
| P0-8 sequence/tradeId/gap | PARTIAL | CLOSED | **PARTIAL** | §5.5–§5.6、§10.4。sequence 语义、MD reset API、Epoch/Fencing 接线、`lastSeqByStream` schema 都写了；但 `venue-contract.md:160` 仍是 `(venueId+tradeId)`；`VenueSession` SBE group 只有 `streamId/lastSeq`，与设计的 7 字段 `StreamSeq` 不一致；`lastAppliedByStream` 把 stream-global order seq 与 per-instrument 行混在一起；`sourceSessionId` 单调持久化未排期。 |
| P0-9 MD 合并/replay | PARTIAL | CLOSED | **CLOSED*** | §10.2、§10.4–§10.6。clock、`LatestQuote` 版本、ring=scope、reset、`CoalescePolicy`、数值容差都写了；但 replay clock 的推进语义、MD I/O 里的系统时钟、`MdReset` 的投递通道仍要补，见 P1-15/P1-17。 |
| P0-10 迁移顺序 | PARTIAL | CLOSED | **PARTIAL** | §14。M0a 行为测试、M0b 包扫描、M1 tee、M3 删路径都写了；但 M1 `EventBusShadowIT` 的“shadow 计数 == production accepted”与 65,536 DROP_NEWEST 队列自相矛盾；M0b 仍被标成“有条件允许”；M2 的 grep 路径是占位符；M3 清单漏了 `RuntimeRunnerMain:523`。 |
| P0-11 账本 scope/账户独占 | OPEN（新增） | CLOSED | **PARTIAL** | §6.1、§6.10、§7.5。manual/blank fill 归属已闭合；但 DB 唯一约束只覆盖 `STARTING|RUNNING`，不含 `DRAINING/REDUCE_ONLY/RECONCILING`；`fencing_token` 分配未定义；`AccountLedger` 无 account-scope checkpoint（P0-14）；日切用 ACCOUNT 快照覆盖策略账本。 |
| P0-12 WAL 自包含 | OPEN（新增） | CLOSED | **PARTIAL** | §6.8。布局/头/CRC/checkpoint 原子写/恢复流程都写了；但 `CHECKPOINT` schema 没有 positions/orders/dedup set，`DAY_ROLL` 没有 snapshot positions；account-scope checkpoint 缺失；WAL 尾部丢失后不强制 WARMUP/venue 对账；`UNKNOWN_PUBLISH` 与 `IntentState` 枚举不一致。 |

统计：**5 CLOSED（P0-4/5/6/7/9，其中 P0-5/9 标 `CLOSED*`，表示方向关闭但仍有 P1 级实现前必修正）；7 PARTIAL（P0-1/2/3/8/10/11/12）**。R3 §0.1 的“12 项均按设计层 CLOSED 处理”过于乐观。

## 2. 逐项核对

### P0-1 端到端不丢：PARTIAL

**设计已做到的**

- §1.2 明确 L1 的准确语义：普通 Aeron publication 不是 durable log，V3 不设计 transport replay；exec 只做 stream-global seq gap 检测，gap 后禁 OPEN，用 venue `ORDER_SNAPSHOT/TRADE_SNAPSHOT/position snapshot` 对账；Archive 只有显式配置才可用。
- §8.3.1 给出 spool 目录、`seg-<baseSpoolSeq>.log`、`spool.meta`、32 字节记录头、原始 SBE payload、`REQ`/`EVT` 附加字段。
- §8.3.2 给出容量 `min(2GiB, 10% 空闲磁盘)`、70%/90%/100% 水位、64MiB 段轮转、1ms/64 条 `fdatasync`、只删 `seg.endSpoolSeq <= ackSpoolSeq` 的段、磁盘满 fatal、尾部 CRC 截断/中间损坏 fatal。
- §8.3.3 给出启动从 `ackSpoolSeq+1` 连续重放、REQ 按 `clientOrderId` 查 `ORDER_SNAPSHOT` 去重、EVT 按 `spoolSeq` 保序、publication null/未连接留在 spool 重试。
- §8.3.4 明确 publication 指针为空写 EVT spool、`!isConnected()` 退避重试、tradeId 空 fatal、fee 不可得 `feeKnown=false`。
- §8.3.5/§14.7 的 `ExecNoDropIT` 覆盖 8192+、publication null/closed、spool 写入后 kill -9 重启、磁盘满、尾部撕裂、中间缺号。

**为什么仍是 PARTIAL**

1. **spool 按 session 分目录，缺跨 session 的 ack/manifest。** 路径是 `spool/<venueId>/<direction>/<sourceSessionId>-<epoch>/`，`spool.meta` 在目录内（§8.3.1）。adapter 重启后 `sourceSessionId` 可能变化（设计自己在 §5.6 要求“adapter 持久化单调分配”），新目录的 `ackSpoolSeq` 从 0 开始；§8.3.3 的“启动 read spool.meta”只读当前目录，旧目录中未 ack 的 EVT/REQ 不会被重放。需要稳定的 `spoolId = (venueId, direction)` 根索引、跨 session 的 `ackSpoolSeq/segmentIndex`，以及“先重放所有未 ack 旧段，再开新 session”的规则。
2. **C++ 的 `outbound_` 是一个队列，不只承载 order/trade。** `publishPosition`、`publishAccount`、`publishOrderSnapshot`、`publishTradeSnapshot` 都走同一个 `offer()`（`ctp_aeron_bridge.h:137/156/184/208/242`）。§8.3 的 REQ/EVT 分类、`spoolSeq`、水位、重放只针对 order/trade；position/account/snapshot 是可再生快照，但如果它们占满 `kMaxOutbound`，`publishOrder/publishTrade` 会一起 fatal。需要按消息族定义策略（execution no-drop；snapshot 可再生/可丢/单独队列），否则“order/trade 不丢”会被快照流量打破。
3. **`feeKnown` 没有 wire 表达。** §8.3.4 要求“fee 不可得 -> `feeKnown=false`，不填 0”，但 `TradeV2` 只有 `fee double`（`venue-contract.md` §5），adapter 当前固定 `fee(0)`（`ctp_aeron_bridge.h:550`）。SBE 不改的前提下，必须定义一种 wire 约定（NaN、哨兵、或复用 `fee` 的符号位）或承认 `fee=0` 无法区分；否则 `FillEvent/WAL` 的 `feeKnown` 在 CTP 路径上永远是猜的。
4. **`closing_ || !pub_` 被当成同一种情况。** `publishOrder`/`publishTrade` 的条件是 `closing_ || !updatePub_`/`!tradePub_`（`ctp_aeron_bridge.h:488/523`）。§8.3.4 只说“publication 指针为空 -> 写 EVT spool”；主动 shutdown 时的 `closing_` 不应再 spool，否则会在退出时制造永远不 ack 的尾段。需要分成 `closing_`（正常停止，不再接单）和 `publication unavailable`（spool + 重试）。
5. **M5 测试没有覆盖 session id 变化。** `ExecNoDropIT` 的 kill -9 重启只断言“从 ackSpoolSeq+1 重放”，没有强制重启后 `sourceSessionId/epoch` 变化；而第 1 条正是这个场景。

**关闭条件**

- 定义稳定的 spool 根 + 跨 session ack/segment 索引，启动时先重放所有未 ack 段；`ExecNoDropIT` 增加“重启后新 sessionId”用例。
- 定义 order/trade 与 position/account/snapshot 的分流/优先级/丢弃策略。
- 定义 `feeKnown` 的 wire 编码，或明确 CTP `fee=0` 的 unknown 语义。
- 拆分 `closing_` 与 publication unavailable。
- CTP `kMaxOutbound` 从“丢弃阈值”改为“背压阈值”的改造纳入 M5 内容与测试（§16.2 已写，但没有和 spool 重放测试绑定）。

### P0-2 双重记账/顺序：PARTIAL

**设计已做到的**

- §6.3 只有 `applyTrade` 一条路径：`require(venueId, accountId, tradingDay)` → tradeId 空 fatal → orphan 判定 → priorDay 判定 → dedup → WAL `FILL_ACCEPTED` → `AccountLedger.apply` → `OrderBookView.onTrade` → `PositionKeeper.apply` → `PositionDelta`/`onFill`。
- §6.4 `filledQty = max(updateCumQty, tradeQty)`，禁止 `+=`；`UNKNOWN_ORDER` 不丢；`terminalHistory` 有界（20,000 或 2 个 session）。
- §6.5 明确 `netQty` 精确、`ledgerAvg/realized` 按到达顺序、`displayAvg` 可被可信快照校正、策略只能用 `netQty`+pending。
- §6.6 给出 `DAY_STABLE/ROLL_PENDING` 状态机、`DAY_ROLL` WAL、`rollDay(snapshot)` 规则、日切 dedup 两代结构、旧日迟到 fill 的 `LATE_FILL_COVERED_BY_SNAPSHOT`/`PRIOR_DAY_FILL`/`DRIFT_UNKNOWN` 三分支。
- §6.7 给出 `FillHistory`、`netQtyAt(asOf)` 公式、超窗 UNKNOWN、乱序 `complete=false`、`SNAPSHOT_BASELINE` 重建。

**为什么仍是 PARTIAL**

1. **`tradingDay` 的权威来源不存在（P0-13）。** §5.1 说 `TradingDayResolver` 从 `VenueSession.tradingDay` 或 adapter 的 session 消息解析；但 `ctp-adapter/src` 里没有 `VenueSession` 的发布代码（全仓 grep `ctp-adapter` 无匹配），`currentTradingDay()` 是 `localtime_r` 的本地日历日（`ctp_aeron_bridge.h:566-573`），`publishAccount` 直接使用它（`:180`）。`TradeV2` 与 `PositionSnapshotV2` 都没有 `tradingDay`。按当前文字，要么 `pendingTradingDay` 5s 后 fatal，要么用本地日——后者会把夜盘 21:00 归到当天，和 §6.6 的“夜盘属于下一交易日”直接冲突。
2. **日切用 ACCOUNT 快照覆盖 `PositionKeeper`。** §6.6 要求“必须有新交易日的可信 account/position snapshot（scope=ACCOUNT）”，然后 `positionKeeper.rollDay(snapshot)`。`PositionKeeper` 的 key 是 `(venueId, accountId, strategyKey, instrumentId)`（§6.1），而 ACCOUNT 快照包含 manual/其他策略仓位。如果 `rollDay` 直接用 ACCOUNT 行，会把手工仓写进策略账本；如果只取 `strategyKey=current` 的行，ACCOUNT 行通常没有 `strategyKey`，策略账本会被清空。需要明确：`PositionKeeper.rollDay` 只接受 `scope=STRATEGY` 的快照；`AccountLedger.rollDay` 接受 `scope=ACCOUNT`；如果只有 ACCOUNT 可用，进入 WARMUP，不得 seed 策略账本。
3. **checkpoint 的 dedup 不可重建。** §6.8.2 的 `CHECKPOINT` 只有 `dedupWatermark`；§5.5 说“重启时从 checkpoint + WAL 重建”。但 WAL 在 checkpoint 之前会被 `truncateBefore` 截掉（§6.8.3），checkpoint 又不含当日已见 `tradeId` 集合；重启后旧 fill 再次到达（spool 重放、venue 重发）时，dedup 会 miss，重复记账。需要 `CHECKPOINT` 带 current/previous day 的 dedup set（或可验证的 compact digest），或保留从当日开始到 checkpoint 的 WAL。
4. **`lastTrustedSnapshot.asOfNanos()` 与 `Snapshot.asOf()` 的类型不一致。** §6.3 的 `priorDay` 分支用 `lastTrustedSnapshot.asOfNanos()`，但 §7.1 的 `Snapshot` 只有 `asOf`（`Instant`）。这是伪代码级错误，会让实现者各自发明一个 `asOfNanos` 字段。
5. **`PositionState.tradingDay` 与 `VenueSession.tradingDay` 类型不一致。** 前者是 `TradingDay`（§6.2），后者是 `String`（§7.1）；`DAY_ROLL` 的 `from/to` 是 `TradingDay`，`Snapshot.tradingDay` 是 `String`。需要统一为 `TradingDay` 或全部 `String`，并在 `trusted()`/`rollDay` 里一致比较。
6. **`priorDay` 只用“最后一个可信快照”做覆盖判断。** 如果多个 instrument 的快照批次不同（`requestSeq` 不同），一个 `asOf` 不能代表所有 instrument 的覆盖水位；至少要按 `(snapshotId, requestSeq, instrument)` 或按账户批次记录，否则旧日 fill 可能被错误地判为“已被覆盖”或“未被覆盖”。

**关闭条件**

- 落地 `tradingDay` 权威源（见 P0-13），并提供 `CtpTradingDayIT` 夜盘/周末用例。
- 拆分 `PositionKeeper.rollDay(STRATEGY)` 与 `AccountLedger.rollDay(ACCOUNT)`；只有 ACCOUNT 时 WARMUP。
- `CHECKPOINT` 增加 dedup set/digest；明确 WAL 保留窗口覆盖当日。
- 统一 `TradingDay` 类型和 `asOfNanos` 表达；`priorDay` 按批次/合约水位判断。

### P0-3 snapshot 假新鲜：PARTIAL

**设计已做到的**

- §7.1 给出 `Snapshot<T>` 的 `value/asOf/stale/staleAfterMs/tradingDay/snapshotId/source/requestSeq/scope/requestedAt/completedAt`；`PositionSnapshot` 加 `strategyKey/scope/positionAsOf`；`AccountSnapshot` 对齐 ADR-004 §5.3 并用可空 `Double`。
- §7.2 规定 `positions()` 允许 `/api/v1/positions` 或 account 投影，禁止 `strategy-runtime/risk`/`Portfolio`/`PositionKeeper`；`source` 必须是 `CTP|SIM|REPLAY|ARCHIVE`；缺 `asOf` -> `EPOCH + stale`；`staleAfterMs` 透传；`requestSeq` 由 Port 分配；`snapshotAsOf` 与 `positionAsOf` 分离。
- §7.3 `trusted()` 覆盖 null/stale、`staleAfterMs<=0`、空 `snapshotId/source`、`STRATEGY*`、scope、tradingDay、EPOCH、未来时间、age、session READY、login DOWN、settlement、lease。
- §14.1 用 `SnapshotStaleIT`/`NoLocalClockIT`/`AccountTruthSourceIT`/`RequestSeqMonotonicIT`/`AccountSnapshotFieldsIT` 替代伪 grep。

**为什么仍是 PARTIAL**

1. **`trusted()` 的 source 检查与 §7.2 的允许集合不一致。** §7.3 只写 `if (s.source().startsWith("STRATEGY")) return false;`，而 §7.2 说允许 `CTP|SIM|REPLAY|ARCHIVE`、`UNKNOWN`/空 -> stale。当前 `ControlPlaneVenueAccountPort` 把 `source` 硬编码成 `ACCOUNT_POSITION`（`:91/95/106/111`），它不以 `STRATEGY` 开头，会被 `trusted()` 判为可信；但它不是 §7.2 列出的 venue source。必须改成白名单，或明确 `ACCOUNT_POSITION` 是允许的派生源并定义它的可信级别。`AccountTruthSourceIT` 的“account 投影 -> source=CTP/SIM”也没有说明如何从投影中保留原始 source。
2. **`PositionSnapshot` 的字段类型无法表达 unknown。** §7.2 说“缺 qty/价格字段 -> null/UNKNOWN，不得 `longValue(...)=0` 冒充”，但 `VenuePorts.PositionSnapshot` 的 qty 是 `long`、价格是 `double`（`VenuePorts.java:104-110`），当前构造器还把缺失值填 0（`ControlPlaneVenueAccountPort:84-91`）。`AccountSnapshot` 在 §7.1 明确用可空 `Double`，`PositionSnapshot` 却没有同样的可空类型/`*Known` 标志；`settlementPrice=0`、`avgPrice=0` 无法区分“零”和“未知”。这是 P0-3 的字段级缺口。
3. **`Instant.now()` 年龄计算没有接 `RuntimeClock`。** 当前 `ControlPlaneVenueAccountPort:44/72` 仍用 `Instant.now()` 判断 stale；§7.2 要求“stale 的年龄计算用注入 `Clock`（`RuntimeClock`）”。M0a 的 `NoLocalClockIT` 写“字节码扫描 `Instant.now/System.currentTimeMillis = 0`”，会红；但 M0a 的内容清单没有“给 Port 注入 `RuntimeClock`”这一项。需要补进 M0a，否则测试和实现脱节。
4. **`requestSeq` 是 Port 内部 `AtomicLong`，不是 venue/control-plane 的快照批次序号。** §7.2 说“由 `ControlPlaneVenueAccountPort` 内部 `AtomicLong` 分配”。这能满足“drain 之后重新请求过”的进程内判断，但如果 `qf-venue-account` 在 drain 中重建 Port/线程，序号会重置，`flat()` 的 `finalSnapshot.requestSeq() > drainStartRequestSeq` 可能永远不成立。需要定义 `requestSeq` 的生命周期（进程级/账户级/Port 实例级），或在 flat 谓词里同时使用 `snapshotId`/`completedAt`。
5. **`account()` 没有 `requestSeq` 的测试。** `RequestSeqMonotonicIT` 只写“连续 100 次 `positions()`”；`Snapshot<T>` 的 `requestSeq` 对 `account()` 同样适用，`flat()`/trusted 也会用。补 `account()` 的单调性。
6. **`snapshotId` 仍是合成值。** 当前 `:51/95` 用 `String.valueOf(asOf.toEpochMilli())`；§7.2 明确“禁止用 `System.currentTimeMillis()` 合成”。M0a 必须换成源批次 `snapshotId`，并在 §2.2 的“现状”里如实写“仍合成”，而不是只写“缺字段”。
7. **per-row `updated_at` 仍被当成 `PositionSnapshot.asOf`。** 当前 `:77` 用 `row.updated_at` 作为 `positionAsOf`，`:91` 把它塞进 `PositionSnapshot.asOf`（新 record 还没有 `positionAsOf` 字段）。设计说 `positionAsOf` 只用于展示/诊断，`trusted()` 用 snapshot 级 `asOf`；M0a 要加字段并把两者彻底分开，且补“行很旧但快照新鲜”的行为测试（§14.1 已写，但当前代码结构不支持）。
8. **`AccountSnapshot` 缺失字段仍填 0。** 当前 `doubleValue(account.get("balance"))`（`:48-49`）缺字段返回 0；§7.1 说 `balance/available/margin/commission` 缺失 -> `stale=true`。M0a 的 `AccountSnapshotFieldsIT` 要求正确，但代码路径仍会把 0 当有效值；需要可空字段 + 显式 missing 检查。

**关闭条件**

- `trusted()` 改为 source 白名单；`ACCOUNT_POSITION` 要么被明确允许并保留原始 `CTP/SIM` 来源，要么判 stale。
- `PositionSnapshot` 的 qty/价格改为可空或加 `*Known` 标志；`settlementPrice/avgPrice` 缺失不得填 0。
- M0a 内容加入 `RuntimeClock` 注入；`NoLocalClockIT` 覆盖 `account()/positions()` 两条路径。
- `requestSeq` 定义生命周期；`account()` 也测；`snapshotId` 来自源批次；`positionAsOf` 独立字段。
- 当前 `ControlPlaneVenueAccountPort` 的 `environment="SHADOW"`、`settlementPrice=0`、`snapshotId=""`、`source="ACCOUNT_POSITION"` 硬编码要逐项删除或显式标记 unknown。

### P0-8 sequence/tradeId/gap：PARTIAL

**设计已做到的**

- §5.5 明确 `OrderUpdateV2.sequence` 的 scope 是 `(venueId, sourceSessionId, sourcePublicationEpoch)` 的 stream-global 单调序号，只用于同订单回退，不推断 per-order gap；Trade 幂等键 `(venueId, tradingDay, tradeId)`；`filledQty` 公式；终态粘滞。
- §5.6 把 `EpochGuard/FencingGuard` 固定到 exec I/O 的 `accept()`，明确“identity 过滤 → strategyKey 标记 orphan → EpochGuard → FencingGuard → sequence → dedup → enqueue → shadow tee”，且旧 epoch 的 Fill 仍必须入队。
- §10.4 把 `MdReset/MdSnapshot/installSnapshot/supportsSnapshotReset` 提升为 `VenueMarketDataPort` 接口；`MdReset` 进入 `RuntimeEvent`；`onFragment`/`onReset` 给出 GAP/WAIT_RESET 状态机；consumer 重启有/无基线两种规则。
- §7.1/§10.4 给出 `VenueSession.lastSeqByStream[]` 与 `runtime/seq/<venue>/<account>/<streamKind>/<scopeHash>.json` 的持久化格式。
- §14.1/§14.3 有 `TradeTradingDayIT`、`MdResetApiIT`、`SequenceScopeIT`、`StaleEpochFillIT`、`ConsumerRestartSeqIT`。

**为什么仍是 PARTIAL**

1. **`venue-contract.md` 仍写 `tradeId 全局唯一（venueId + tradeId）`（`:160`），与设计的 `(venueId, tradingDay, tradeId)` 冲突。** §16.4 把修订列为“文档同步依赖”，§1.4 甚至写“否则以本文件为准”。设计层可以这样声明，但冻结契约没有同步前，conformance、adapter、控制面会按两个不同的 key 实现；M0a 的退出不应在契约未更新时通过。`tradeId` 不是 SBE 字段变化，但它是契约语义变化，仍应走 ADR-004/venue-freeze 的变更控制。
2. **`VenueSession.lastSeqByStream` 的 SBE 形状与设计不一致。** `venue-contract.md:257` 与 `venue-freeze §3.2` 的 group 只有 `{streamId, lastSeq}`；`VenueSessionEnvelope` 是 `Map<Integer, Long>`（`VenueSessionEnvelope.java:21`）。设计 §7.1 的 `StreamSeq` 有 `streamKind/sourceSessionId/sourcePublicationEpoch/exchange/instrumentId/lastSeq/updatedAtNanos` 七个字段；其中 `sourceSessionId/epoch` 可以继承消息级字段，但 `exchange/instrumentId/updatedAtNanos` 不在 group，`streamId` 是否等价于 `streamKind` 也没有定义。SBE 不改的前提下，必须定义 `streamId -> scope` 的映射（谁分配、是否稳定、冲突怎么办），或承认 `lastSeqByStream` 只是 `streamId/lastSeq` 的本地扩展。
3. **`lastAppliedByStream[]` 把 stream-global 序号与 per-instrument 行混在一起。** §6.8.2 的元素是 `(streamKind, sourceSessionId, epoch, exchange, instrumentId, seq, tradingDay)`。OrderUpdate 的 `sequence` 是 `(venue, session, epoch)` 级别的 stream-global 序号，同一 stream 上不同 instrument 共享一个 seq；如果 checkpoint 按 `(exchange, instrumentId)` 存多行，同一 stream 会出现多个不同的 `seq`，恢复时无法判断哪个是权威。应拆成 `orderStreamCursor[]`（per stream）和 `mdScopeCursor[]`（per instrument scope）两类。
4. **`sourceSessionId` 的单调持久化没有排期。** §5.6 要求“sourceSessionId 由 adapter 持久化单调分配；回退 -> stale，不能靠 epoch 前进洗白”。CTP 侧 `currentSourceSessionId()` 返回 `session_.sourceSessionId()`，为 0 时回退 1（`ctp_aeron_bridge.h:556-559`），没有持久化单调分配。§16.2 的 CTP 改造清单只列 no-drop/tradeId/fee/spool，没有列 session id。FencingGuard 的“新 session 合法/旧 session 拒绝”因此不可实现。
5. **`MdReset` 的投递通道未定义。** §5.1 把 `MdReset` 放进 `RuntimeEvent`，§10.4 的 `onReset` 在 loop 里写 `lastSeq`/`barReset`；但 §4.2/§4.3 说 MD I/O 拥有 scope seq tracker，bar 又在 loop。见 P1-15。`MdReset` 是走 MD lossless ring、control 队列，还是独立 slot？容量/优先级/丢弃策略没有写；如果走 256 条 ring 且 ring 满，reset 可能丢，scope 永久 WARMUP。
6. **`EpochGuard/FencingGuard` 的接线只在文字里。** `AeronVenueExecutionPort` 目前只有 per-order `lastOrderSequence`（`:30`），`accept()` 只校验 venue/account（`:69-75`）；M0a 说“接 guard”，但没有给 `sourceSessionId/epoch/fencingToken/deploymentGeneration` 在 `TradeEnvelope`/`OrderUpdateEnvelope` 上的完整来源（Trade 有 session/epoch，OrderUpdate 有 session/epoch，fencing 有；deploymentGeneration 有）。字段是够的，但“旧 epoch 的 Fill 仍入队、旧 epoch 的 OrderUpdate 只审计”需要 `accept()` 返回三态（accept/audit/drop），而不是 boolean。设计应明确三态接口。
7. **`TradeEnvelope` 的 `tradingDay` 是消费侧字段，但 resolver 的输入 `VenueSession` 没有发布者（P0-13）。** 这条和 P0-2 重叠，但也是 P0-8 的 dedup 前提。

**关闭条件**

- 同步 `venue-contract.md` 的 tradeId 唯一性，并把文档变更纳入 M0a 退出。
- 定义 `lastSeqByStream` 的 `streamId` 语义与 SBE/本地映射；拆 `lastAppliedByStream` 为 order stream cursor + MD scope cursor。
- 把 `sourceSessionId` 单调持久化加入 CTP adapter/M5 清单。
- 定义 `MdReset` 的投递通道、容量、优先级；明确 `lastSeq` 的唯一写者。
- `EpochGuard/FencingGuard` 的 `accept()` 返回 accept/audit/drop 三态，并有 `StaleEpochFillIT`/`StaleEpochOrderUpdateIT`。

### P0-9 MD 合并/replay：CLOSED

**设计已做到的**

- §10.1 两条流：`MdEvent` lossless、`LatestQuote` 可合并；`MdEvent` 入 ring 后才 coalesce；指标/bar 只消费 `MdEvent`；默认 `LOSSLESS`，`QUOTE_ONLY` 必须检查 `age <= maxQuoteAgeMs`。
- §10.2 `MdScope = (venueId, sourceSessionId, epoch, exchange, instrumentId)`，ring 与 scope 一致；slot 是 `(venue, exchange, instrument)` 但记录内带 session/epoch/seq/version；epoch 切换规则（旧 ring 先 drain、新 epoch 等 reset、reset 后旧事件只审计、slot 只接受前进）。
- §10.4 `MdReset/MdSnapshot` Port API、`onFragment/onReset` 状态机、consumer 重启有/无基线规则、`lastSeqByStream` JSON schema。
- §10.5 `LatestQuote` 只在 `(epoch, seq)` 前进时替换；同一 seq 重发不推进 `slotVersion`；`publishLatestIfChanged` 只在版本变化且 `QUOTE_ONLY` 时回调；重复投递不推进 `logicalIntentSeq`。
- §10.6 `CoalescePolicy` 枚举、默认值、replay 等价口径、`netQty/filledQty/working` 完全一致、avg/realized/cash 数值容差、样本量（3 session 或 100k fills）；`RuntimeClock` 三模式；replay 禁止系统时间。
- §13.4 `LosslessIndicatorIT/LatestQuoteVersionIT/ReplayEquivalenceIT/GapBarResetIT`。

**为什么可以 CLOSED**

- R2 的五个失败模式（无 clock SPI、latest 每轮重发、ring key 与 seq scope 不一致、`MdReset` 不是事件、容差无数值）在设计层都有正面对策，且字段/状态机/测试齐全。剩余问题是实现细节，不是方向问题。

**仍需在实现前盯住的 P1**

- **Replay clock 的推进语义未定义。** `RuntimeClock.REPLAY(eventLog)` 需要在每个事件回调前把 `now` 推进到 `eventTime`，同一回调内保持固定；timer 的 `nowNanos` 用逻辑时间，不用 `System.nanoTime`。设计只说“注入固定 clock”，没有说“何时推进、同一事件内是否冻结、timer 是否跳变”。
- **`NoSystemClockIT` 的范围不含 MD I/O。** `AeronVenueMarketDataPort.health` 用 `System.currentTimeMillis()`（`:113`），`LatestSlot.offer` 用 `System.nanoTime()`（§10.5 代码），`LastEventByVenue` 也用系统时钟。如果 replay 的 `ageMs`/slot version 依赖这些值，等价性会漂。应把 `aeron.io` 的“决策相关时间”改为注入 clock，或明确这些字段不参与 replay 断言。
- **`MdReset` 的投递通道/容量未定义**（见 P0-8/P1-15）。
- `publishLatestIfChanged` 只对 `QUOTE_ONLY` 回调；closeout 直接读 slot，需保证 closeout 的 `age` 检查与 `LatestQuote` 一致。

### P0-10 迁移顺序：PARTIAL

**设计已做到的**

- §14.1 M0a 用行为测试替代伪 grep：`SnapshotStaleIT/NoLocalClockIT/AccountTruthSourceIT/RequestSeqMonotonicIT/AccountSnapshotFieldsIT/DescriptorFieldsIT/RegistryDefaultsIT/TradeTradingDayIT/MdResetApiIT`，并保留 conformance V-04/V-06/V-08/V-09/V-11 与 SBE hash。
- §14.2 M0b 扫实际包（`com.quantlink.fin.runner` 与 `runner.io`），断言 `AeronOrderGateway/AeronExecutionIo` 不得有 `positions/orders` 字段；`WALSelfContainedReplayIT` 只给 ledger 目录；`TradingDayRolloverIT`、`SnapshotDriftAsOfIT`、`AccountExclusivityIT`、`ManualFillAttributionIT`、`DrainWithManualPositionIT`、`CheckpointCorruptionIT`、`KillNineRecoveryIT`、`DedupWindowIT`。
- §14.3 M1 定义 tee 点（`ExecIngress.accept()` 后、`execQueue.offer` 前）、标量复制、不共享 `DirectBuffer`、独立 65,536 DROP_NEWEST、`qf-shadow` 单线程、慢消费者暂停。
- §14.3/§14.4/§14.5 有 `EventBusShadowIT/ControlPriorityIT/LoopNoBlockingIoArchTest/ThreadOwnershipTest/TimerWiringTest/SpiCompatibilityTest/NoSystemClockIT/LatestQuoteVersionIT/ReplayEquivalenceIT/RunnerCutoverIT/DrainIT/KillSwitchIT`。
- §14.8 回滚条件、在途订单、feature flag。

**为什么仍是 PARTIAL**

1. **M1 `EventBusShadowIT` 的计数断言与队列策略矛盾。** §14.3 写“shadow 独立有界队列 65,536，DROP_NEWEST，生产路径 never blocks”，退出证据却写“200k exec 事件突发，shadow 计数 == production accepted 计数”。65,536 的队列在 200k 突发下必然丢；如果生产不阻塞，shadow 计数只能小于 production。应改为 `shadow_accepted + shadow_dropped == production_accepted`，并单独断言 `shadow_dropped_total` 可解释；或者把突发量降到队列容量内。
2. **M0b 仍被标成“有条件允许”，但条件没有闭合。** §14.0 说“M0b 有条件允许，前提是 M0a 退出，并且 WAL/交易日/账户独占按本版实现；不再因为设计未定而阻塞”。本轮复核认为 P0-2（tradingDay 源/日切）、P0-11（account WAL/lease 状态）、P0-12（checkpoint 内容）仍是设计层缺口，M0b 的“设计未定”并没有消失。应改为“M0b 不允许，直到必改 1–4 完成”。
3. **M2 的 grep 路径是占位符。** §14.4 写 `grep -R "Thread.sleep" backend/runtime/.../loop => 0`，`...` 不是可执行路径；应写成实际模块（如 `backend/runtime-runner/src/main/java/com/quantlink/fin/runtime/loop`）并列出扫描脚本/ArchUnit 规则。否则测试会空转或误报。
4. **M3 的显式删除清单漏了 `RuntimeRunnerMain:523`。** §14.5 只列 `drain:341/389`、`cancelWorkingOrders:402/365`、`CloseoutGuard:185`；但 `RuntimeRunnerMain` 的 `send()` 里还有 `orderGateway.submit(sized)`（`:523`），这是策略主下单路径，不在 `drain/cancelWorkingOrders` 里。虽然 §14.5 的文字“OrderSink 统一走 VenueExecutionPort”覆盖了它，但“先删路径”的清单应明确列 `:523` 和 `:237`（hot reload 的 `cancelWorkingOrders`），否则 grep 会失败或实现者漏改。
5. **M0a `TradeTradingDayIT` 只证明 Java resolver，不证明 CTP adapter。** 测试用 fake `VenueSession` 可以绿，但 adapter 没有发布 `VenueSession`（P0-13）。M5 需要一个 `CtpTradingDayIT`（夜盘 21:00、周末、节假日前夜）。
6. **M0b 的 WAL 测试只覆盖 strategy ledger。** `WALSelfContainedReplayIT` 的目录是 `ledger` 根，但 `AccountLedger` 的 manual/orphan fill 没有 account-scope checkpoint（P0-14）；`ManualFillAttributionIT` 只测归属，不测重启恢复。需要 `ManualFillRecoveryIT`。
7. **M0a `NoLocalClockIT` 只扫 `ControlPlaneVenueAccountPort/runner account 包`，没有把 `ControlPlaneClient`/`AeronMarketData`/`AeronVenueMarketDataPort` 纳入。** 如果 M0a 的目标是“快照不伪造新鲜度”，至少要覆盖所有 `Snapshot` 生产路径；`health()` 的系统时钟是 P1。
8. **M1 的 tee 点虽定义，但“shadow 计数 == production accepted”与“shadow 暂停 5s 不反压”不能同时用同一个计数器证明。** 需要三个计数器：`production_accepted`、`shadow_accepted`、`shadow_dropped`，并断言恒等式。

**关闭条件**

- 修正 `EventBusShadowIT` 的计数断言；补 `shadow_accepted + shadow_dropped` 恒等式。
- M0b 改为 blocked，直到 P0-2/P0-11/P0-12 的必改项完成。
- M2 grep 路径改成实际路径/ArchUnit；M3 清单补 `:523`/`:237`。
- M0a 的 `TradeTradingDayIT` 明确“Java resolver only”；M5 加 CTP adapter 测试。
- M0b 加 `ManualFillRecoveryIT`/account-scope checkpoint 断言；M0a 的 `NoLocalClockIT` 扩到所有 snapshot 生产路径。

### P0-11 账本 scope/账户独占：PARTIAL

**设计已做到的**

- §6.1 `PositionKey=(venue,account,strategyKey,instrument)`，`AccountPositionKey=(venue,account,instrument)`；`strategyKey` 在 runner 生命周期不可变，`RELOAD_PREPARE` 拒绝变化。
- `PositionKeeper` 只持策略 key；`AccountLedger` 持账户 key，接收同一批 Fill（含 orphan/manual）；策略 Fill 同时进两者，orphan/manual 只进 `AccountLedger`。
- 账户独占：DB 唯一约束 `strategy_deployments(venue_id,account_id)` + `runner_leases`（owner/fencing/expires）+ 每 2s renew + `ACCOUNT_ALREADY_OWNED` 启动失败。
- manual/blank fill：`ORPHAN_ACCOUNT_FILL`，只进 `AccountLedger`，不进 `PositionKeeper`/`OrderBookView`/策略 PnL；`orphan_account_exposure`/`foreign_strategy_exposure` 使 `flat()` 为 false；默认禁止自动 flat。
- §7.5 `flat()` 同时要求本地 working/unknown 空、`positionKeeper.allZero()`、orphan/foreign exposure 0、可信 ACCOUNT 快照、`requestSeq > drainStartRequestSeq`、`asOf >= drainStartAt`、快照全 flat、无在途减仓。
- §13.4 `AccountExclusivityIT/ManualFillAttributionIT/DrainWithManualPositionIT`。

**为什么仍是 PARTIAL**

1. **DB 唯一约束只覆盖 `STARTING|RUNNING`。** §6.1 写 `strategy_deployments(venue_id,account_id)` 在 `STARTING|RUNNING` 状态唯一。如果第一个 runner 进入 `DRAINING`/`REDUCE_ONLY`/`RECONCILING`，唯一约束不再覆盖；第二个 runner 可以插入同一账户，而第一个还持有 working order。lease 是唯一防线，但 lease 过期/续租失败时第二个可以 acquire。必须把唯一约束扩到所有非终态（`STARTING/RUNNING/DRAINING/REDUCE_ONLY/RECONCILING/ROLL_PENDING`），或规定 lease 只在 flat/handoff 后释放。
2. **`fencing_token` 的分配未定义。** `runner_leases` 有 `fencing_token`，但没有说它是 DB sequence、每账户单调、还是启动时 `max+1`。如果两个 runner 并发 acquire，可能拿到同一个 token；`FencingGuard` 的“incoming.fencingToken < currentFencing -> reject”就无法区分。需要 `fencing_token` 的单调分配/持久化规则。
3. **`REDUCE_ONLY + fatal` 语义矛盾。** §6.1 写“续租失败超过 `leaseGraceMs=5s` → `REDUCE_ONLY` + fatal”。`fatal` 会停止进程，`REDUCE_ONLY` 是运行状态；两者不能同时。应定义“先 REDUCE_ONLY，flat/handoff 后 fatal”或“立即 fatal + handoff”，并写清是否有平仓窗口。
4. **`AccountLedger` 没有 account-scope checkpoint（P0-14）。** 这是最实质的缺口：manual/orphan fill 只进内存 `AccountLedger`，重启后 `orphan_account_exposure`/`foreign_strategy_exposure` 归零，`flat()` 会误判。`ManualFillAttributionIT` 不能覆盖重启。
5. **日切用 ACCOUNT 快照覆盖策略账本（P0-2）。** `positionKeeper.rollDay(snapshot)` 的输入是 `scope=ACCOUNT`；manual 仓位会被写进策略账本，或策略行因缺 `strategyKey` 被清空。
6. **`orphan_fill_total` 与 `ORPHAN_ACCOUNT_FILL` 的计数口径没有统一。** §1.1/§9.1 的 `orphan_fill_total` 定义为“旧 generation/非当前 strategy 的成交数”；§6.1 的 manual/blank 是 `ORPHAN_ACCOUNT_FILL`，只进 `AccountLedger`；§6.3 的 `if (orphan) metrics.orphanFillTotal.increment()` 又把所有 orphan（含 manual）计入 `orphan_fill_total`。指标表只有 `orphan_fill_total` 和 `orphan_account_exposure`，没有 `orphan_account_fill_total`。需要一张归属/计数表，明确 manual 是否计 `orphan_fill_total`。
7. **`onOrphanFill` 的触发范围不明确。** §6.3 对 `orphan` 调 `strategy.onOrphanFill`；§6.1 说 manual/blank“不触发 `onFill`，不参与策略 PnL”。`onOrphanFill` 是否给 manual 触发？如果触发，策略会看到手工成交；如果不触发，旧 generation 的 orphan 又需要告警。需要区分 `ORPHAN_GENERATION_FILL` 与 `ORPHAN_ACCOUNT_FILL` 两类回调。

**关闭条件**

- 唯一约束覆盖所有非终态；lease 释放条件明确；`fencing_token` 单调分配。
- `REDUCE_ONLY + fatal` 改成单一语义。
- `AccountLedger` 有 account-scope checkpoint（P0-14）；`ManualFillRecoveryIT`。
- 日切拆 `PositionKeeper(STRATEGY)` / `AccountLedger(ACCOUNT)`。
- 统一 `orphan_fill_total/ORPHAN_ACCOUNT_FILL/orphan_account_exposure` 的口径；明确 `onOrphanFill` 是否给 manual。

### P0-12 WAL 自包含：PARTIAL

**设计已做到的**

- §6.8.1 文件布局 `ledger/<venue>/<account>/<strategy>/wal-*.log`、64MiB 段、checkpoint 保留 2 份、dedup journal、handoff；28 字节记录头、CRC32C、`SESSION_CONTEXT` 必须是段首。
- §6.8.2 `SESSION_CONTEXT/INTENT/PUBLISH_RESULT/ORDER_STATE/FILL_ACCEPTED/SNAPSHOT_BASELINE/POSITION_RESET/DAY_ROLL/CHECKPOINT/HANDOFF` 的必填字段；`FILL_ACCEPTED` 能独立构造 `TradeEnvelope + PositionKey`；`ORDER_STATE` 能独立构造 `OrderState`；`INTENT` 的 `clientOrderId` 在 publish 前持久化；`configFingerprint` 只诊断。
- §6.8.3 checkpoint 原子写（tmp → fsync → rename → fsync dir → durableCheckpointLsn → truncate）、truncate 保留规则、损坏回退。
- §6.8.4 `recover()` 流程、append-then-apply、崩溃在 append/apply/checkpoint 之间、WAL 尾部撕裂、`INTENT` 无 `PUBLISH_RESULT` 的 `UNKNOWN_PUBLISH` 规则、fsync 失败 fatal、checkpoint 双坏回退。
- §13.4 `WALSelfContainedReplayIT/CheckpointCorruptionIT/KillNineRecoveryIT/DedupWindowIT`。

**为什么仍是 PARTIAL**

1. **`CHECKPOINT` schema 不包含实际 positions/orders。** §6.8.2 的 `CHECKPOINT` 只有 `checkpointId/checkpointLsn/lastAppliedByStream[]/dedupWatermark/openOrderCount/positionCount/configFingerprint`；但 §6.8.4 的 `recover()` 要 `positionKeeper.load(cp)`/`orderBook.load(cp)`/`accountLedger.load(cp)`。`positionCount` 不能重建仓位，`openOrderCount` 不能重建订单。§6.8.3 说“生成完整快照（position/order/dedup/lastAppliedByStream）”，但 schema 没有这些字段。必须补 `positions[]/orders[]/terminalOrders[]/dedupSet[]`，否则 checkpoint 不是自包含恢复源。
2. **`DAY_ROLL` 没有 snapshot positions。** §6.8.2 的 `DAY_ROLL` 有 `beforeTotals[]/afterTotals[]`，但 `rollDay(snapshot)` 需要新日的逐合约仓位。如果只重放 `DAY_ROLL`，无法恢复 `PositionKeeper`；除非保证前面一定有一条 `SNAPSHOT_BASELINE`（带 positions），但设计没有写这个顺序/配对规则。应写成 `SNAPSHOT_BASELINE` 后紧跟 `DAY_ROLL`，或把 `snapshotPositions[]` 放进 `DAY_ROLL`。
3. **没有 account-scope checkpoint（P0-14）。** WAL 目录带 `<strategy>`，`CHECKPOINT` 只带 `strategyKey`；即使 `FILL_ACCEPTED` 为 orphan/manual 记录保留了 `strategyKey` 字段，checkpoint 也没有 `AccountLedger` 的 positions/orders/terminal。重启后从 checkpoint 重放时，checkpoint 之前的手工仓没有来源，`flat()` 会误判。需要 `ledger/<venue>/<account>/account/` 的 checkpoint，或在 strategy checkpoint 内嵌 account ledger 快照，并明确 orphan 记录的 `contextId/strategyKey` 写法。
4. **WAL 尾部丢失后没有状态迁移。** §6.8.4 只写“从第一个 CRC 失败/长度不完整处截断尾部，计 `wal_tail_truncated_total`；只允许尾部，mid-stream 损坏 -> fatal”。如果尾部丢失的是 `FILL_ACCEPTED`，内存已经应用过（崩溃前），重启后 WAL 没有这条记录，仓位会少一笔；设计没有要求进入 WARMUP/用 venue `TRADE_SNAPSHOT` 对账。这是 exactly-once 的实质缺口：截断尾部不是“可继续”，而是“账本可能不完整”。必须 `WAL_TAIL_LOST -> WARMUP + TRADE_SNAPSHOT/position snapshot + 对账后才能 READY`。
5. **`UNKNOWN_PUBLISH` 不在 `IntentState` 枚举。** §6.8.4 用 `UNKNOWN_PUBLISH`，§5.7 的枚举是 `NEW/RESERVED/PUBLISHED/PENDING_RETRY/TIMEOUT_UNKNOWN/ACCEPTED/REJECTED_FINAL`。`UNKNOWN_PUBLISH` 是 `INTENT` 无 `PUBLISH_RESULT` 的恢复态，应加入枚举或明确它是 WAL 记录状态而非运行时状态。
6. **`ORDER_STATE` 缺 `remainingKnown/unknownOrder`。** §6.9 的 `OrderState` 有 `remainingKnown/unknownOrder`，但 §6.8.2 的 `ORDER_STATE` 必填字段没有这两个；重放时 `orderQty=0`/`remainingQty=-1` 无法区分“未知”和“零”。补字段或哨兵。
7. **`lastAppliedByStream` scope 混淆（P0-8）。** 见 P0-8 第 3 条。
8. **`checkpoint()` 失败没有守卫。** `recover()` 在重放后 `checkpoint(lastApplied)`，然后 `wal.truncateBefore(checkpointLsn)`；如果 `checkpoint()` 写失败，`truncateBefore` 不应执行。设计只写了 checkpoint 原子写，没有写“recover 中 checkpoint 失败 -> fatal，不 truncate”。
9. **fsync 语义的“已应用”与“已持久”边界。** `FILL_ACCEPTED` 只 append 到 page cache，`qf-ledger` 1ms/64 条 group commit；kill -9 可以丢 page cache 之外的记录。设计说“FILL_ACCEPTED 必须先追加再改内存”，但“追加成功”不等于“durable”。需要明确：kill -9 允许丢最近 1ms/64 条，重启后用 venue `TRADE_SNAPSHOT` 补齐；不能把 `wal_tail_truncated_total` 当作正常恢复。

**关闭条件**

- `CHECKPOINT` 加 positions/orders/terminal/dedup set；`DAY_ROLL` 加 snapshot positions 或强制配对 `SNAPSHOT_BASELINE`。
- account-scope WAL/checkpoint（P0-14）。
- WAL 尾部丢失 -> WARMUP + venue 对账；更新 `KillNineRecoveryIT`。
- `UNKNOWN_PUBLISH` 枚举、`ORDER_STATE` 的 `remainingKnown/unknownOrder`。
- `recover()` 中 checkpoint 失败不 truncate；fsync 丢失窗口与 venue 对账规则写清。

## 3. 新增 P0

### P0-13 `tradingDay` 权威源未落地、未排期（P0）

**证据**

- 设计 §6.6：`authoritativeTradingDay = VenueSession.tradingDay（adapter 声明，夜盘 21:00 属于下一交易日）`；§5.1：`TradingDayResolver` 用 `(venueId, sourceSessionId, sourcePublicationEpoch)` 查 `VenueSession.tradingDay` 或 adapter 在 session 消息中声明的交易日；解析不到 -> `pendingTradingDay` 最多 4096 条/5s -> `FatalExecutionException(TRADING_DAY_UNKNOWN)`。
- CTP adapter 没有发布 `VenueSession`：`ctp-adapter/src` 全目录 grep 不到 `VenueSession`/`publishSession`。`currentTradingDay()` 用 `localtime_r` 取本地日历日（`ctp_aeron_bridge.h:566-573`），`publishAccount` 用它（`:180`）；`publishTrade` 不带 `tradingDay`（SBE `TradeV2` 没有该字段）；`PositionSnapshotV2` 没有 `tradingDay`（`venue-contract.md` §8）。
- `TradeReport` 在 CTP session 里有 `trade->TradingDay`（`ctp_trader_session.h:811`），但 adapter 没有把它带到 `publishTrade` 或 session 消息。
- §16.2 的 CTP 改造清单只有 no-drop/`tradeId` 空 fatal/`feeUnknown`/spool；没有“发布 VenueSession”或“交易日来源”。
- M0a 只加 Java 消费侧 `TradeEnvelope.tradingDay` 和 `TradeTradingDayIT`；没有 adapter 侧测试。

**为什么是 P0**

- `tradingDay` 是 dedup key、夜盘归属、`DAY_ROLL`、`trusted()` 的共同前提。没有权威源，CTP 路径只有两种结果：5s 后 fatal（不可上线），或用本地日历日（夜盘错账）。这不是“实现细节”，是设计把权威源指向了一个不存在的消息。

**关闭条件**

- CTP adapter 发布 `VenueSession`（至少 `tradingDay/sourceSessionId/epoch/fencingToken/loginState/settlementState`），或由 CTP `TradingDay` 派生并持久化到 session 状态；`publishAccount`/`publishTrade`/`PositionSnapshot` 使用同一来源。
- 明确 adapter 与 control-plane `TradingCalendarService` 不一致时的优先级；周末/节假日/夜盘跨日测试。
- §16.2/M5 加入“VenueSession 发布 + tradingDay 对齐”任务；M0a 的 `TradeTradingDayIT` 标明“Java resolver only”，M5 加 `CtpTradingDayIT`。

### P0-14 `AccountLedger` 无 account-scope checkpoint（P0）

**证据**

- §6.1：`AccountLedger` 接收同一批 Fill（含 orphan/manual），供对账与 drain flat；manual/blank fill 只进 `AccountLedger`。
- §6.8.1：WAL 目录 `ledger/<venueId>/<accountId>/<strategyKey>/`；`FILL_ACCEPTED` 带 `strategyKey`；没有 `account` scope 目录。
- §6.8.2：`CHECKPOINT` 带 `strategyKey`；没有 `accountLedger` 的 positions/orders/dedup。
- §7.5 `flat()` 依赖 `accountLedger.orphanExposure()==0` 和 `foreignStrategyExposure()==0`；重启后如果没有 account-scope checkpoint，这两个值只能从 0 开始。
- `ManualFillAttributionIT` 只测归属，不测重启恢复。

**为什么是 P0**

- manual/其他策略仓位是 CTP 账户每天都会出现的场景。重启后 `AccountLedger` 归零，`flat()` 会报 flat，drain 会把“还有手工仓”的账户当作已平；这是 R2 P0-11 的核心失败模式，R3 用内存账本修了一半，但没有持久化。

**关闭条件**

- `ledger/<venue>/<account>/account/` 独立 WAL/checkpoint，或同一 WAL 内 `scope=ACCOUNT` 的记录与 checkpoint；`FILL_ACCEPTED` 的 orphan/manual 记录必须可重放。
- `recover()` 同时恢复 `PositionKeeper` 与 `AccountLedger`；`flat()` 在 account ledger 未恢复时不得为 true。
- `ManualFillRecoveryIT`：写入 manual fill -> kill -9 -> 重启 -> `orphan_account_exposure` 仍 >0 -> `flat()==false`。

### P0-15 L0 spool 跨 session/重启边界（P0）

**证据**

- §8.3.1：`spool/<venueId>/<direction>/<sourceSessionId>-<epoch>/`；`spool.meta` 在目录内。
- §8.3.3：启动 `read spool.meta -> ackSpoolSeq -> 从 ackSpoolSeq+1 重放`；没有跨目录索引。
- §5.6：`sourceSessionId` 由 adapter 持久化单调分配（设计意图），所以重启后 session id 很可能变化。
- §8.3.5 `ExecNoDropIT` 只测 kill -9 后“从 ackSpoolSeq+1 重放”，没有测 session id 变化。

**为什么是 P0**

- 这是 L0 “不丢”承诺的直接反例：旧 session 目录里的未 ack EVT（成交/订单回报）在新 session 启动后永远不会被重放；REQ 也可能重复或丢失。M5 的 `ExecNoDropIT` 会绿着通过，但线上 adapter 重启会丢成交。

**关闭条件**

- 稳定 spool 根（`venueId+direction`）+ 跨 session 的 `spoolIndex/ackSpoolSeq`；启动先重放所有未 ack 段，再开新 session；段头带 `sourceSessionId/epoch` 用于校验。
- `ExecNoDropIT` 增加“重启后 sourceSessionId 变化”的用例；断言旧段全部 ack 后才删除。

## 4. 新增/剩余 P1

> P1 不改变“M0a 可以开工”的结论，但必须在对应阶段退出前关闭。

### P1-13 Snapshot 真值的剩余字段/类型问题

- `trusted()` 的 source 白名单（见 P0-3 第 1 条）；`ACCOUNT_POSITION` 当前会通过。
- `PositionSnapshot` 的 `long/double` 无法表达 unknown；需要可空 `Long/Double` 或 `qtyKnown/priceKnown`。
- `TradingDay` 类型不统一：`Snapshot.tradingDay`/`VenueSession.tradingDay` 在现有 record/字段表里是 `String`，`PositionState.tradingDay`/`trusted(currentDay)` 是 `TradingDay`；设计没有统一。`trusted()` 的 `currentDay.equals(s.tradingDay())` 按当前类型永远 false。统一为 `TradingDay` 或在边界显式转换。
- `Snapshot` 的 `asOf` 是 `Instant`，`applyTrade` 用 `asOfNanos`；补 `asOfNanos()` 或改伪代码。
- `account()` 也需要 `requestSeq/scope`；`RequestSeqMonotonicIT` 覆盖两条路径。
- `ControlPlaneVenueAccountPort` 的 `environment="SHADOW"`、`settlementPrice=0`、`snapshotId=""`、`source="ACCOUNT_POSITION"` 硬编码要逐项删除或标 unknown；§2.2 的“现状”不要只写“缺 requestSeq/scope”。

### P1-14 `lastSeqByStream` / `lastAppliedByStream` 的 SBE 与 scope

- `VenueSession` SBE group 只有 `{streamId,lastSeq}`（`venue-contract.md:257`、`venue-freeze §3.2`）；message-level 有 `sourceSessionId/epoch`，但 group 没有 `exchange/instrumentId/updatedAtNanos`；设计 §7.1 的 `StreamSeq` 有 7 个字段。定义 `streamId -> scope` 映射，或把 `lastSeqByStream` 降级为 `streamId/lastSeq` + 本地扩展。
- `lastAppliedByStream` 拆成 `orderStreamCursor[]`（per `venue/session/epoch`）与 `mdScopeCursor[]`（per `venue/session/epoch/exchange/instrument`）；不要把 stream-global seq 存成 per-instrument 多行。
- `sourceSessionId` 单调持久化加入 CTP adapter/M5（见 P0-8）。
- 当前 `AeronVenueMarketDataPort` 对首个 seq 无条件 `baseline`（`:141-143`），与 §10.4“无持久化基线必须等 READY + snapshot/reset”相反；`resetGap(venueId,instrumentId)`（`:97-106`）也不含 session/epoch，会把所有 epoch 一起解锁。M0a 要改成 scope reset + `WAIT_RESET`，并由 `ConsumerRestartSeqIT`/`MdResetApiIT` 覆盖。

### P1-15 MD `lastSeq`/`barReset` 的所有权

- §4.2/§4.3 说 MD I/O 拥有 `lastSeq`；§10.4 `onReset` 在 loop 写 `lastSeq` 并 `barReset`，bar 又是 loop。三者不能同时成立。建议：
  - MD I/O 只维护 `seqTracker` 和 `blocked`，收到 reset 后更新自己的 `seqTracker`，并向 loop 投 `MdReset`；
  - loop 维护一个只读镜像 `lastSeqForDecision`，只用于 bar/策略，不反向写 I/O；
  - 或把 `onFragment/onReset` 全部放到 MD I/O，bar reset 以事件通知 loop。
- `MdReset` 的投递通道/容量/优先级要定义（MD ring vs control vs 独立 slot）；不能因为 ring 满丢 reset。

### P1-16 WAL append/rotate 的单写者交接

- §4.3 说 loop 追加 WAL、ledger fsync/rotate；§6.8.1 说 64MiB 段轮转，但没写：段满时谁封段、loop 如何切 mmap、rotate 期间 append 是否阻塞、`baseLsn` 如何发布、append 与 rotate 失败如何 fatal。需要 segment 状态机（OPEN/SEALING/SEALED）+ 单生产者队列，或 loop 只 append 固定 mmap、ledger 只 fsync。
- `wal.truncateBefore` 与 loop append 的并发：ledger 不能删除 loop 正在写的段；至少保留当前段 + 前一段。

### P1-17 Replay clock 与系统时钟范围

- `RuntimeClock.REPLAY(eventLog)` 的推进规则：每个事件前推进到 `eventTime`；同一回调内 `nowNanos` 固定；timer 用逻辑时间；`LatestQuote.ageMs` 用逻辑时间。
- `NoSystemClockIT` 目前只覆盖 `runtime.loop/strategy/engine`；`AeronVenueMarketDataPort.health`（`:113`）、`LatestSlot.offer`（§10.5）用系统时钟。要么纳入 clock，要么明确这些字段不参与 replay 断言。
- `LatestQuote` 的 `slotVersion` 在 replay 中必须可复现（不能依赖 `System.nanoTime` 的单调值）。

### P1-18 阶段测试的可执行性

- M1 `EventBusShadowIT` 的“shadow 计数 == production accepted”改为 `shadow_accepted + shadow_dropped == production_accepted`；200k 突发与 65,536 队列的矛盾要消除。
- M2 `grep -R "Thread.sleep" backend/runtime/.../loop` 改成实际模块路径；建议同时给 ArchUnit 规则名。
- M3 清单补 `RuntimeRunnerMain:523`（`send()` 的 `orderGateway.submit`）和 `:237`（hot reload 的 `cancelWorkingOrders`）；grep 的 allowed files 说明 `AeronVenueExecutionPort` 仍可依赖 gateway。
- M0b 加 `ManualFillRecoveryIT`/account-scope checkpoint 断言；M0a `TradeTradingDayIT` 标明 Java resolver only，M5 加 CTP adapter 测试。

### P1-19 账户独占的 lease/fencing 细节

- 唯一约束覆盖所有非终态（`DRAINING/REDUCE_ONLY/RECONCILING/ROLL_PENDING`），或 lease 只在 flat/handoff 后释放。
- `fencing_token` 单调分配（DB sequence/每账户 `max+1` + 事务）；`owner_id` 与 `adapterSessionId` 的关系。
- `REDUCE_ONLY + fatal` 改成单一语义；写清续租失败后是否允许平仓、多久后 halt。
- `lease` 过期但 runner 仍在交易（时钟漂移/网络分区）时，`FencingGuard` 如何拒绝旧 runner 的 order/cancel；需要 `fencingToken` 在 publication 上持续携带。

### P1-20 `feeKnown` 的 wire 表达

- `TradeV2` 只有 `fee double`；adapter 当前 `fee(0)`。SBE 不改时，需要约定（NaN、哨兵、或 `fee` 的符号位）把“未知”传到 runner；否则 `FillEvent/WAL` 的 `feeKnown` 在 CTP 路径上不可信。
- 如果选择新增字段，必须走 ADR-004/venue-freeze 变更控制，不能只在 V3 文档里写。

### P1-21 `UNKNOWN_PUBLISH` / `ORDER_STATE` 的恢复字段

- `IntentState` 枚举加入 `UNKNOWN_PUBLISH`，或明确它只是 WAL 恢复态。
- `ORDER_STATE` 补 `remainingKnown/unknownOrder`；`FILL_ACCEPTED` 补 `feeKnown`（已有）和 `eventTimeUnknown`（如有）。
- `CHECKPOINT` 的 `lastAppliedByStream` 元素类型与 `VenueSession.lastSeqByStream` 的差异要写清。

### P1-22 `closing_` 与 publication null 的 spool 语义

- `publishOrder/publishTrade` 的条件拆成 `closing_`（停止接单，不 spool）和 `!pub_`/`!isConnected()`（spool + 重试）。
- `outbound_` 的消息族拆分/优先级：order/trade no-drop；position/account/snapshot 可再生/可丢/单独队列。
- `publishTick` 的 MD 丢弃与 `mdDropped_` 计数保持独立，不要和 exec spool 混。

### P1-23 指标与命名口径

- `orphan_fill_total`/`ORPHAN_ACCOUNT_FILL`/`orphan_account_exposure`/`foreign_strategy_exposure` 一张表，明确 manual/old-generation/other-strategy 三类各计哪个。
- `exec_ingress_total = accepted + duplicate + order_gap + fatal` 与 `exec_dropped_total` 独立；`trade_gap_total` 不参与 ingress 恒等式（§13.1 已写，补测试）。
- `md_lost_no_image_total` 的“稳态 0”与 ring 256 的 WARMUP 解释要一致；`gap_recovery_ms` 的“有 reset 源”限定已写，补无 reset 源的永久 WARMUP 断言。
- `ControlPriorityIT` 的 1ms/2ms 预算统一；`EXEC_BUDGET` 的 512/200µs 与压测对应。

### P1-24 exec Port 仍丢弃 intentId/结构化结果

- `AeronVenueExecutionPort.submit` 调 `gateway.submit(toIntent(request))`；`toIntent` 丢掉 `requestId/intentId/clientOrderId`，gateway 自己生成 `UUID.randomUUID()`/`nextClientOrderId()`（`AeronOrderGateway.java:332-333`）。`OrderSubmission` 对任何非异常都返回 `accepted=true`（`AeronVenueExecutionPort.java:80-96`）。
- 这与 §8.1/§8.4/§5.7 的“intentId 稳定、重试复用、PENDING_RETRY 不重发”不一致。M0b/M3 必须让 Port 接受 `OrderIntent(intentId/clientOrderId)`，返回 `SubmitReason/retryAfterMs`，并加 `BackpressureRetryIT`；`AeronOrderGateway` 的同价去重（`:321-330`）和 `throttle`（`RuntimeRunnerMain:520`）也要按 §8.4 删除或改为 `intentId` 维度。

## 5. 阶段准入

### 5.1 准入表

| 阶段 | 本轮结论 | 条件 |
|---|---|---|
| **M0a** Port 契约/字段/快照 | **允许，带条件** | 先修 P1-13（source 白名单、`PositionSnapshot` unknown 类型、`TradingDay` 类型、`RuntimeClock` 注入、`requestSeq` 生命周期、`snapshotId`/硬编码）；`TradeTradingDayIT` 明确只测 Java resolver；`NoLocalClockIT` 扩到所有 snapshot 生产路径；`RegistryDefaultsIT` 覆盖 `SHADOW/UNKNOWN/SIM/*/legacy/1001/2100/3140`。 |
| **M0b** 单账本/WAL/删 gateway 账本 | **不允许（按当前文字）** | R3 标“有条件允许”，但 P0-2（tradingDay 源/日切 ACCOUNT vs STRATEGY）、P0-11（lease 状态/account checkpoint）、P0-12（checkpoint 内容/尾部丢失）仍未闭合。完成必改 1–4 后再评估；M0b 退出加 `ManualFillRecoveryIT`、account-scope checkpoint、`WAL_TAIL_LOST`。 |
| **M1** 事件总线 shadow | **允许（仅 shadow，M0a 退出后）** | 不得消费生产账本、不得参与决策；修正 `EventBusShadowIT` 计数断言；定义 `MdReset` 通道；shadow 独立 65,536 DROP_NEWEST + `shadow_accepted/shadow_dropped` 恒等式。M0b 未退出时只做独立 harness。 |
| **M2** StrategyEventLoop/无 IO/SPI | **不允许** | 需要 M0b + M1 24h shadow；P0-9 的 replay clock/MD 系统时钟、P0-5 的 MD `lastSeq` 所有权、P1-17 先修；`runtime.engine` 纳入 ArchUnit；M2 grep 路径改成实际路径；`LatestQuote`/`NoSystemClockIT` 覆盖 MD I/O。 |
| **M3** Runner cutover | **不允许** | 需要 M2 退出 + 24h shadow + drain fail-stop；删除 `RuntimeRunnerMain.drain:341/389`、`cancelWorkingOrders:402/365`、`CloseoutGuard:185`、`send:523`、hot reload `:237`；`RunnerCutoverIT` 覆盖 kill -9/重连/未 flat；`DrainIT` 覆盖 manual 仓位/快照过期/MD 断流。 |
| **M4** SimpleHedging | **不允许** | 需要 M3 退出 + §12.2 默认值/offset/onStart 落地；`HedgeStartupTest/HedgeIdempotencyIT/HedgeOffsetSplitTest`。 |
| **M5** Live | **不允许** | 需要 M4 + L0 spool（P0-1/P0-15）+ CTP no-drop/`tradeId` 空 fatal/`feeKnown` + `VenueSession/tradingDay`（P0-13）+ 控制面 flatten/handoff + 5 日 live 证据。 |

### 5.2 直接回答

- **M0a：允许进入，但必须带条件。** 设计层已经给出字段/行为测试，剩余是 P1-13 的字段/类型/Clock 修正；M0a 退出前不修，`SnapshotStaleIT`/`NoLocalClockIT` 会红。
- **M0b：不允许。** R3 的“有条件允许”过于乐观；P0-2/P0-11/P0-12 仍有设计缺口，尤其 tradingDay 源、account-scope checkpoint、checkpoint 内容。
- **M1：有条件允许（仅 shadow，M0a 退出后）。** 不得作为决策源；先修 shadow 计数断言和 `MdReset` 通道；M0b 未完成时只做独立 harness。
- **M2：不允许。**
- **M3：不允许。**

## 6. 必改清单（按优先级）

1. **P0-13 `tradingDay` 权威源**：CTP adapter 发布 `VenueSession`（含 CTP `TradingDay`）或从 `TradeReport.TradingDay` 持久化 session day；`publishAccount`/`publishTrade`/`PositionSnapshot` 使用同一来源；§16.2/M5 加入任务；`CtpTradingDayIT`（夜盘 21:00、周末、节假日前夜）。
2. **P0-2 日切拆账**：`PositionKeeper.rollDay` 只接受 `scope=STRATEGY`；`AccountLedger.rollDay` 接受 `scope=ACCOUNT`；只有 ACCOUNT 时 WARMUP，不得 seed 策略账本；`TradingDayRolloverIT` 覆盖 manual 仓位。
3. **P0-14 `AccountLedger` 持久化**：account-scope checkpoint；manual/orphan `FILL_ACCEPTED` 可重放；`ManualFillRecoveryIT`；`flat()` 在 account ledger 未恢复时不得 true。
4. **P0-12 checkpoint 自包含**：`CHECKPOINT` 加 positions/orders/terminal/dedup set；`DAY_ROLL` 加 snapshot positions 或强制配对 `SNAPSHOT_BASELINE`；WAL 尾部丢失 -> WARMUP + venue `TRADE_SNAPSHOT`；`UNKNOWN_PUBLISH`/`ORDER_STATE` 标志补齐；`KillNineRecoveryIT` 更新。
5. **P0-8 契约/seq**：更新 `venue-contract.md` 的 tradeId 唯一性并纳入 M0a 退出；定义 `lastSeqByStream` 的 `streamId` 映射/SBE 本地扩展；拆 order stream cursor / MD scope cursor；`sourceSessionId` 单调持久化进 CTP/M5；`StaleEpochFillIT`。
6. **P0-3 snapshot 真值**：`trusted()` source 白名单；`PositionSnapshot` 可空/`*Known`；`RuntimeClock` 注入；`requestSeq` 生命周期；`snapshotId` 源批次；删除 `environment="SHADOW"`/`settlementPrice=0`/`source="ACCOUNT_POSITION"` 硬编码；`SnapshotStaleIT/NoLocalClockIT/AccountTruthSourceIT` 补 `account()`。
7. **P0-1/P0-15 spool**：稳定 spool 根 + 跨 session ack/manifest；order/trade 与 snapshot 分流；`feeKnown` wire 约定；`closing_` vs null；`ExecNoDropIT` 加 session id 变化/新 session 用例。
8. **P0-10 阶段测试**：M1 shadow 计数改为 `accepted+dropped`；M2 grep 路径实际化；M3 补 `:523`/`:237`；M0b 改为 blocked 直到 1–4；M0a 标明 `TradeTradingDayIT` 只测 Java resolver。
9. **P1-15/P1-16/P1-17 MD/WAL/clock**：MD `lastSeq`/`barReset` 单一所有者；`MdReset` 投递通道；WAL append/rotate 状态机；replay clock 推进；`NoSystemClockIT` 覆盖 MD I/O。
10. **P1-19/P1-23 独占/指标**：唯一约束覆盖非终态；`fencing_token` 单调分配；`REDUCE_ONLY + fatal` 单一语义；orphan 指标/回调口径统一；`ControlPriorityIT` 预算统一。

## 7. 开放问题

1. **`tradingDay` 的权威源到底是谁？** adapter `VenueSession.tradingDay`、CTP `TradeReport.TradingDay`、还是 control-plane `TradingCalendarService`？三者在夜盘/周末/节假日可能不一致；设计选 adapter，但 adapter 目前不发布 session。需要 ADR/契约级决定，而不是 V3 单方面声明。
2. **`venue-contract` 的 tradeId 唯一性变更是否需要重新冻结？** `tradeId` 不是 SBE 字段，但它是契约语义；`(venueId, tradingDay, tradeId)` 会改变 conformance 的断言。谁负责更新 ADR-004/venue-freeze/T-060，何时生效？
3. **`lastSeqByStream` 是否扩 SBE？** 如果不扩，`streamId` 的 scope 映射由谁维护、是否稳定、跨 adapter 重启是否一致？如果扩，必须走 venue-freeze 的字段变更流程。
4. **`AccountLedger` 的 WAL scope**：独立目录、同一 WAL 的 `scope=ACCOUNT` 记录，还是控制面账户快照 + 本地 replay？manual fill 的 `tradeId` 是否与策略 fill 共享 dedup key？
5. **L0 spool 的稳定身份**：`spoolId` 是 `(venue,direction)` 还是 `(venue,account,direction)`？跨 session 的 ack 放在哪里？磁盘满时是否允许丢弃可再生的 position/account snapshot？
6. **`requestSeq` 的语义**：Port 进程内、账户级、还是 venue 快照批次？Port 重建/多线程调用时如何保持 `flat()` 的“drain 后请求”判断？
7. **`feeKnown` 的 wire 表达**：SBE 冻结下用 NaN/哨兵，还是接受“0=未知”直到 M5？如果新增字段，谁承担 re-freeze？
8. **`PositionSnapshot` 的 unknown 表达**：可空 `Long/Double` 会破坏现有 record 构造器；是否用 `qtyKnown/priceKnown` 标志保持兼容？
9. **M1 shadow 的验收口径**：`shadow_accepted + shadow_dropped == production_accepted` 是否足够？是否需要“shadow 决策序列与生产一致”的更强断言？
10. **`RuntimeClock.REPLAY` 的推进**：事件时间、publishTime、ingress 时间三者哪个驱动 `nowNanos`？timer 是否允许跳变？这些决定 replay 的可复现性。

## 8. 评审边界

- 本次为**只读复审**：只读取设计稿 Revision 3（2344 行）、R2 评审、ADR-004、`venue-freeze-2026-11-12.md`、`venue-contract.md`，以及指定的 `ControlPlaneVenueAccountPort.java`、`VenuePorts.java`、`AeronVenueMarketDataPort.java`、`AeronVenueExecutionPort.java`、`AeronOrderGateway.java`、`ctp-adapter/src/ctp_aeron_bridge.h`；另抽查 `RuntimeRunnerMain.java`、`ControlPlaneClient.java`、`TradeEnvelope.java`、`VenueSessionEnvelope.java`、`ctp_trader_session.h`。未修改设计/代码，未 commit。
- **未运行构建、单元测试、集成测试、24h soak、replay 或 CTP 联调**；因此本文所有“代码现状”仅来自静态阅读，不代表运行时验证。
- 未完整审：CTP session 内部细节（`ctp_trader_session.h` 只抽查 `TradingDay`）、SimVenue/Replay adapter 全路径、控制面 DB 迁移、前端、生产 190 环境、Aeron Archive 配置、Aeron 集群/备份。
- 未计算设计稿 sha256；以 Revision 3、2344 行为准。若设计稿在本评审后继续修改，应以新版本重新核对 §1 表和 §6 必改清单。
- 本文的 **CLOSED** 仅指**设计层**给出了可实现、可验收、与冻结契约一致的机制；代码关闭状态仍以 §2.2/§16 和各阶段退出证据为准。不要把本文的 CLOSED 当作“代码已支持”。
- 本文的 **PARTIAL** 不表示方向错误；多数是“字段/类型/数据来源/测试断言”还差一层，修正后可以关闭。

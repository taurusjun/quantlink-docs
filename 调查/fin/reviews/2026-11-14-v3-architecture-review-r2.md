# V3 事件驱动运行时设计复审（R2）

- 日期：2026-11-14
- 对象：`docs/architecture/v3-event-driven-runtime.md`，**Revision 2**（2026-11-14，1423 行）
- 上一轮：`docs/reviews/2026-11-14-v3-architecture-review.md`（REJECT，针对 Revision 1）
- 必读约束：`docs/architecture/adr/ADR-004-unified-venue-integration.md`、`docs/architecture/venue-freeze-2026-11-12.md`、`docs/architecture/venue-contract.md`
- 结论：**APPROVE_WITH_CHANGES**

> 口径：本评审判断的是“设计层是否给出了可实现、可验收、与冻结契约一致的机制”，不是“代码是否已经实现”。设计里写了规则，但规则缺少字段、状态机、计数口径或退出证据的，仍记为 PARTIAL；代码现状只作为“设计假设是否成立”的反证，不要求本轮代码已完成。

## 0. 总体判断

Revision 2 是一次实质重写，不是给 Revision 1 追加回应。它把上一轮最危险的四个错误方向纠正了：

1. 不再把“绝不丢”说成 runner 内部队列的局部保证，而是拆成 adapter/transport/ingress/ledger 四层，并把 CTP adapter 的 no-drop 改造显式推后到 M5 门禁。
2. 不再让 gateway 持有决策账本；`PositionKeeper` / `OrderBookView` 的所有权、WAL、checkpoint、恢复点已经写成可实施的结构。
3. 不再把旧 generation/epoch 的 Fill 当“旧事件”丢弃；§9.1 明确“epoch/generation 限制命令和回调，不限制仓位事实”。
4. 不再用单一 latest map 冒充事件流；`MdEvent`（lossless）与 `LatestQuote`（可合并）分开，replay 等价性也改成了“同输入 + 同 coalesce + 固定 clock”的可断言口径。

但本轮仍有 6 个 P0 只能算 PARTIAL，且有两个跨条目的 P0 级缺口没有被上一轮编号覆盖：

- **P0-2** 的唯一账本方向正确，但 WAL 记录不是自包含恢复日志，`netQtyAt(asOf)` 没有历史数据来源，交易日切换没有规则。
- **P0-3** 的字段和 `trusted()` 谓词正确，但唯一的 `VenueAccountPort` 仍读“策略账本投影”而不是 venue/account 真值；M0a 的退出证据是一条会误判的 grep。
- **P0-8** 的 sequence 语义已经和 ADR-004 §5.2 对齐，但 `TradeEnvelope` / `TradeV2` 没有 `tradingDay`，设计里的 `applyTrade` 和 dedup key 无法按写法实现；MD reset 也没有进入 Port 接口。
- **P0-11（新增）** 账本 key 含 `strategyId`，但快照/对账/flat 是 account 级；账户独占没有被写成启动时强校验。
- **P0-12（新增）** WAL 的 `FILL_ACCEPTED` / `ORDER_STATE` / `INTENT` 字段不足以独立重放；这会让 P0-2 的“checkpoint + WAL 可解释”在实现时退化成“靠外部上下文猜”。

因此结论是 **APPROVE_WITH_CHANGES**：方向可以进入 M0a，但不能按当前文字直接进入 M0b/M2/M3。

## 1. P0 关闭表

| P0 | 结论 | 设计落点 | 关键证据 / 反证 |
|---|---|---|---|
| P0-1 端到端不丢 | **PARTIAL** | §1.2、§5.2–§5.3、§8.3、§13.4、M5 门禁 | 分层契约成立；但 L1 写“可重放”不成立（普通 Aeron publication 无 durable retention/rewind），L0 spool 被留成开放问题，CTP 仍是 8192 队列 + drop/fatal。 |
| P0-2 Fill/Position 双重记账与顺序 | **PARTIAL** | §6.3–§6.8 | 唯一写者、`filledQty=max()`、`POSITION_RESET` 唯一覆盖、unknown order 都写清了；但 WAL 字段、`netQtyAt(asOf)` 历史、交易日切换、账户 scope 未闭合。 |
| P0-3 snapshot asOf/stale/字段 | **PARTIAL** | §7.1–§7.4、M0a V-08/V-09 | 字段和 `trusted()` 正确；唯一 port 仍读 `STRATEGY_LEDGER`，`Instant.now()` fallback 仍在，M0a 退出 grep 会误判，`finalSnapshotRequestSeq` 不在 API。 |
| P0-4 hot reload/epoch 丢弃真实成交 | **CLOSED** | §9.1–§9.3、§13.4、M2/M3 | 事件分类、旧 working 撤销/转移、等 terminal、`onStart(snapshot)`、`orphan_fill_total` 都已给出；代码未实现，但设计层关闭。 |
| P0-5 单写者/线程边界/buffer | **CLOSED** | §4.2–§4.3、M0b | 所有权表、每 publication 独立 buffer、loop 断言、I/O 线程禁止 submit/cancel/publish、WAL 单生产者都已明确；gateway 账本删除是 M0b 的硬退出门。 |
| P0-6 队列/背压/control 饿死 | **CLOSED** | §4.4、§5.2–§5.4、§13.4 | 独立 control 队列、exec 满即 fatal、无秒级自旋、MD ring、control 优先都已给出；`FatalEvent` 类型和预算值是 P1，不影响方向。 |
| P0-7 决策链路 HTTP/JDBC | **CLOSED** | §11.1–§11.3、M2/M3 | 18 个 loop 调用点逐项处置，RiskView 缓存、kill-file、hot swap、closeout、shutdown 都已移到 control/loop；ArchUnit 范围还需补 `runtime.engine`（P1）。 |
| P0-8 sequence/tradeId/gap 恢复 | **PARTIAL** | §5.5、§10.3、§6.7 | sequence 语义正确；但 `TradeEnvelope` 无 `tradingDay`，MD reset 无 Port API，`lastSeqByStream` 无持久化格式，EpochGuard/FencingGuard 未接线。 |
| P0-9 MD 合并与指标/replay | **PARTIAL** | §10.1–§10.4、M1/M2 | 双流、lossless 默认、bar 规则、replay 容差口径都正确；但 replay 无注入 clock，`publishLatestTo` 每轮重发，ring key 与 seq scope 不一致。 |
| P0-10 迁移顺序可执行性 | **PARTIAL** | §14、§16 | 阶段顺序正确；但 M0a 退出证据是伪 grep，M0a 未门禁 registry 默认值，M0b ArchUnit 包名可能空转，M1 shadow tee 点未定义，M3 drain 仍在 runner。 |
| P0-11 账本 scope/账户独占 | **OPEN（新增）** | §6.1、§6.6、§7.4 | `PositionKey` 含 strategyId，`PositionSnapshot` 是 account 级；设计靠“1 strategy=1 runner=1 account”假设，但没有启动强校验，也没有 manual/blank-strategyFill 归属规则。 |
| P0-12 WAL 自包含性 | **OPEN（新增）** | §6.3、§6.7 | `FILL_ACCEPTED`/`ORDER_STATE`/`INTENT` 缺少 `accountId/strategyKey/exchange/sourceSessionId/epoch` 或 `orderQty` 等重放必需字段；`netQtyAt(asOf)` 无历史。 |

## 2. 逐项核对

### P0-1 端到端不丢：PARTIAL

**设计已做到的**

- §1.2 把承诺拆成 L0 adapter、L1 transport、L2 runner ingress、L3 ledger、L4 snapshot、L5 recovery，并逐层写“承诺不成立时”怎么办。
- §5.2 明确 exec 队列满 `offer` 返回 false 才是真丢，立即 `FatalExecutionException`，不自旋、不落 runner 磁盘。
- §5.3 明确 `FatalExecutionException` 不能被 listener 层吞掉，`publication.close()` 只能 loop 在 `fatalShutdown()` 做。
- §8.3 给出 adapter no-drop 契约：队列满有限阻塞 → durable spool → 仍失败 adapter fatal；`tradeId` 为空 fatal；spool 恢复保序，否则 `ExecGap`。
- §13.4 `ExecNoDropIT` 覆盖 8192+、publication closed、listener 异常；M5 门禁明确“L0 未通过不接 live”。

**为什么仍是 PARTIAL**

1. **L1 的“可重放”不成立。** 设计写“stream + seq + session/epoch；retention 由 Aeron 配置保证”（§1.2）。普通 Aeron `Publication` 是 term buffer + backpressure，不是 durable log；没有 Archive/recording，consumer 断流或 term 轮转后不能 replay。能做的只是“检测 gap + 用 venue 快照对账”。如果实现者按“可重放”去设计恢复，会得到一个不存在的保证。
2. **L0 spool 仍是开放问题，不是设计。** §15 开放问题 2 只问“spool 磁盘预算和轮转策略；是否允许在 publication closed 时阻塞 CTP 回调线程”。§8.3 没有定义 spool 文件格式、容量、fsync、轮转、重放顺序、与 dedup 的关系、谁负责清理。M5 的退出证据因此不可估算，也无法写 `ExecNoDropIT` 的恢复断言。
3. **adapter 的静默路径没有全部覆盖。** `ctp_aeron_bridge.h:488` 的 `publishOrder` 在 `closing_ || !updatePub_` 时直接 `return`；`:523` 的 `publishTrade` 在 `closing_ || !tradePub_` 时直接 `return`。§8.3 只列了队列满、publication closed、spool 写失败、tradeId 空，没有列“publication 指针为空/未创建”。这仍然是“正常路径不丢”的洞。
4. **当前 CTP 的行为比设计描述更硬，但仍不是 L0。** `offer` 在 `outbound_.size() >= kMaxOutbound` 时 `outboundDropped_++`、`fatal_=true` 并返回（`ctp_aeron_bridge.h:401-413`）；`main.cpp:541-544` 看到 fatal 就 break。它是“可检测丢失 + fail-stop”，不是“有限阻塞 + durable spool”。设计在 §1.2 已承认“只满足可检测丢失”，这点是诚实的；但这也意味着 P0-1 不能在 M0a/M1 关闭，只能在 M5 关闭。

**关闭条件**

- 把 L1 改成“可检测 gap + venue 快照对账；不承诺 transport replay”，或明确引入 Aeron Archive 并给出 retention/rewind 配置。
- 在 §8.3 补 spool 的格式、容量、轮转、fsync、重放顺序、dedup 交互、磁盘满策略。
- 补 `publication == null` / `!isConnected()` 的显式 fatal/spool 规则。
- M5 的 `ExecNoDropIT` 必须包含“spool 写入后重启，按原顺序恢复”的断言，而不只是“fatal 或计数”。

### P0-2 Fill/Position 双重记账与顺序：PARTIAL

**设计已做到的**

- §6.3 只有 `applyTrade` 一条路径：dedup → WAL `FILL_ACCEPTED` → `orderBook.onTrade` → `PositionState.apply` → `PositionDelta` / `onFill`；refresh 只进 `ReconcileReport`，不调用 `replacePosition`。
- §6.4 `filledQty = max(updateCumQty, tradeQty)`，禁止 `filledQty += trade.qty`；未知订单创建 `UNKNOWN_ORDER`，不丢成交。
- §6.5 明确 `netQty/today/yesterday` 精确、`avgPrice/realized` 不保证顺序无关；策略风控只能用 `netQty` 与 pending，不能用本地 avg 做开平仓决策。
- §6.6 快照只 seed 一次，之后只对账；`POSITION_RESET` 是唯一覆盖路径；无法算 `netQtyAt(asOf)` 时不得判 flat。
- §6.8 `CANCEL_REQUESTED` 保留在 working，terminal 进 `terminalHistory`，`totalExposure` 含 pending。

**为什么仍是 PARTIAL**

1. **`applyTrade` 的入参在当前 wire 上不成立。** §6.3 写 `require(t.venueId(), t.accountId(), t.tradingDay())`，但 `TradeEnvelope`（`backend/shared/aeron/.../TradeEnvelope.java:4-27`）没有 `tradingDay`；`venue-contract.md` §5 的 `TradeV2` 也没有该字段。唯一可行的“tradingDay”是 adapter/session 的交易日，不是 `timestamp` 的本地日历日；夜盘 21:00 的成交属于下一交易日，按 timestamp 推导会跨日误判。这个问题同时打在 P0-8 的 dedup 上。
2. **WAL 记录不是自包含恢复日志。** §6.7 的 `FILL_ACCEPTED(venueId, tradingDay, tradeId, clientOrderId, instrument, side, price, qty, fee, eventTime)` 没有 `accountId`、`strategyKey`、`exchange`、`sourceSessionId/epoch`；`ORDER_STATE` 没有 `instrument/side/offset/orderQty`；`INTENT` 没有 `strategy/account/venue`。`recover()` 只用 checkpoint + WAL，重放到 `applyTrade` 时无法构造合法 `TradeEnvelope`/`PositionKey`，只能从当前 runner 配置补上下文。这会把“WAL 权威”退化成“WAL + 当前配置猜”。
3. **`netQtyAt(snap.asOf())` 没有历史来源。** §6.6 用 `positionKeeper.netQtyAt(snap.asOf())` 与快照比较，但 `PositionState` 只保存当前 today/yesterday 数量，没有按 `eventTime` 的成交历史/环形缓冲。若快照 `asOf` 早于最近几笔成交，当前净仓与快照本来就不在同一个时点，drift 会假阳性；若快照 `asOf` 晚于最后成交，则可以直接用当前净仓。设计必须定义“保留多久的 fill 历史、按 instrument 还是 account、超出窗口怎么办”，否则 `netQtyAt` 只是伪代码。
4. **交易日切换没有规则。** `PositionState` 有 today/yesterday，但 §6.6/§6.7 没有定义交易日切换时 today→yesterday、settlement、dedup 日切、`tradingDay` 变化时 `trusted()` 的行为。夜盘/日盘交界会出现“本地 today 还停在昨天、快照 tradingDay 已经是新日”的 WARMUP 死锁，或者 today/yesterday 归属错误。
5. **avg/realized 的“展示值重算”与“快照不得覆盖账本”冲突。** §6.5 说“每次可信快照用 longAvgPrice/shortAvgPrice 重算展示值与 PnL”，§6.6 说快照只对账、不覆盖。`PositionState` 只有一个 `longAvgPrice` 字段，没有区分“账本 avg”和“展示 avg”。需要拆字段，或明确重算只写 `displayAvg`，风控/账本永远不读它。
6. **账户级快照 vs 策略级账本。** 见 P0-11。

**关闭条件**

- 给 `TradeEnvelope` 增加 `tradingDay`（Java 消费侧字段即可，不必改 SBE），或在 exec ingress 用 `VenueSession.tradingDay` 绑定并写进 `FillEvent`/WAL；同时更新 `venue-contract` 的 tradeId 唯一性表述。
- 把 WAL 记录补齐到“脱离当前配置也能重放”的程度，或明确写出“重放上下文 = 当前 runner 的 venue/account/strategy”，并加 `RestartRecoveryIT` 断言。
- 定义 `netQtyAt(asOf)` 的 fill 历史保留窗口、数据结构和超窗行为。
- 定义交易日切换/结算/日切 dedup 的状态机。
- 拆分 `ledgerAvg` 与 `displayAvg`，或删除“快照重算展示值”这句。

### P0-3 snapshot asOf/stale/字段：PARTIAL

**设计已做到的**

- §7.1 给出 `Snapshot<T>` 的 `value/asOf/stale/staleAfterMs/tradingDay/snapshotId/source`，`PositionSnapshot` 的全字段，`VenueSession` 的 session/lease/lastSeq 字段，`AccountSnapshot` 的基本字段。
- §7.2 `trusted()` 覆盖 stale、staleAfterMs<=0、空 snapshotId/source、tradingDay 不一致、未来时间戳、age、session READY、login DOWN、settlement PENDING/FAILED、lease 过期。
- §7.3 状态机把 BOOTSTRAP/WARMUP/READY/RECONCILING/DRAINING/REDUCE_ONLY 的交易权限写清。
- §7.4 `flat()` 要求本地 working/unknown 为空、本地 allZero、最终快照可信、快照请求序号晚于 drain 开始、asOf 不早于 drain 开始、快照全 flat、无在途减仓。

**为什么仍是 PARTIAL**

1. **唯一的 `VenueAccountPort` 不是 venue truth。** `ControlPlaneVenueAccountPort.positions()` 调 `client.riskSnapshot()`（`ControlPlaneClient.java:230-238` 的 `/api/v1/strategy-runtime/risk?strategyId=`），返回行的 `source` 缺省写成 `STRATEGY_LEDGER`（`ControlPlaneVenueAccountPort.java:94`）。这是策略账本的投影，不是 CTP/venue 的 `positions` 真值。用它做 drift 基线，等于拿账本对账本，drift 恒为 0；用它做 drain flat，等于自证 flat。M0a 不能只“透传 asOf/stale”，必须把数据源切到 `positions`/`PositionSnapshotService`/venue snapshot，或明确这是 strategy-scoped snapshot 并另建 account/venue truth 源。
2. **`asOf` 仍在伪造。** `ControlPlaneVenueAccountPort.java:40` `instant(snapshot.get("serverTime"), Instant.now())`；`:51` 和 `:103` 的 catch 分支 `Instant.now()`；`:68` `Instant.now()`。如果控制面没给 `serverTime` 或行里没有 `asOf`，port 仍可能返回“新鲜”的快照。设计 §7.1 说“任何未知/缺字段返回 stale=true”，代码没有做到。
3. **M0a 的退出证据会误判。** §14 M0a 写“`ControlPlaneVenueAccountPort` 中不存在 `asOf = Instant.now()`（目标：该字面模式为 0）”。当前代码没有这个字面赋值，但有 `instant(..., Instant.now())` 和 catch 里的 `Instant.now()`；grep 会绿，行为仍然伪造。必须改成行为测试：缺 `serverTime`/缺行 `asOf`/缺 `staleAfterMs` → `stale=true` 或 `asOf=EPOCH`，且 `trusted()==false`。
4. **per-row `updated_at` 被当成快照 asOf。** `:74` 用行的 `updated_at` 作为 `asOf`，`:76-79` 只要任一行超过 15s 就整张快照 stale。一个长时间没有成交的持仓行 `updated_at` 很旧，即使控制面刚刚查询过，也会被判 stale；反过来，只要有一行刚更新，其他旧行也会被“最新 asOf”掩盖。需要区分 `snapshotAsOf`（本次查询/生成时间）与 `positionAsOf`（该仓位最后变化时间），并让 `trusted()` 用前者。
5. **`staleAfterMs`/`snapshotId`/`source` 没有真正透传。** `DEFAULT_STALE_AFTER_MS=15_000` 硬编码（`:19`、`:48`、`:99`）；`snapshotId` 用 `String.valueOf(latest.toEpochMilli())` 合成（`:101`），不是控制面/venue 的 snapshotId；`source` 缺省 `STRATEGY_LEDGER`（`:94`）；缺 qty 用 `longValue(...)=0`（`:122-124`），设计说“缺字段按 unknown 处理，不得填 0 冒充”。
6. **`finalSnapshotRequestSeq` 不在 API。** §7.4 的 flat 谓词要求 `finalSnapshotRequestSeq > drainStartSnapshotRequestSeq`，但 `Snapshot` 没有 requestSeq，`VenueAccountPort.positions()` 也不返回请求序号；`SnapshotEvent` 有 `requestSeq`，但 account port 不产出它。按当前接口，flat 谓词不可实现。
7. **`AccountSnapshot` 字段不完整。** §7.1 只要求 `balance/available/tradingDay/snapshotId/source/asOf`；ADR-004 §5.3 还要求 `margin/frozenMargin/commission/closeProfit/positionProfit/deposit/withdraw`。设计 §1.4 说“使用 ADR-004 §5.3/§5.4 已定义字段”，这里不一致。M0a 至少要明确哪些字段是 V3 必需、哪些可以 unknown。

**关闭条件**

- M0a 把 `ControlPlaneVenueAccountPort` 的数据源切到 venue/account truth（`positions` 表或 `PositionSnapshotService`），并把 `source` 写成 `CTP/SIM/REPLAY` 而不是 `STRATEGY_LEDGER`；如果短期只能读策略投影，必须显式标记 `strategyScoped=true` 且禁止用于 flat/drift。
- 删除所有 `Instant.now()` fallback；缺 `serverTime`/`asOf`/`staleAfterMs`/`snapshotId`/`source` 一律 stale/EPOCH。
- 区分 `snapshotAsOf` 与 per-row `positionAsOf`；`staleAfterMs` 从源透传，不硬编码。
- 给 `VenueAccountPort`/`Snapshot` 增加 `requestSeq`（或让 `SnapshotEvent` 成为唯一入口），使 flat 谓词可实现。
- 补 `AccountSnapshot` 的 ADR 字段，或写明 V3 不依赖的字段及 unknown 语义。

### P0-4 热加载/epoch 丢弃真实成交：CLOSED

**设计已做到的**

- §9.1 先分类再决定丢不丢：旧 generation/旧 epoch 的 Fill 必须应用到 `PositionKeeper`，计入 `orphan_fill_total`，进入审计，触发 `onOrphanFill`；旧 epoch 的 OrderUpdate 只进审计，不覆盖 canonical book；旧 generation 的策略命令返回 `STALE_GENERATION`。
- §9.2 定义 `IDLE → PREPARING → DRAINING_OLD → swap` 状态机：control 线程构建新策略；loop 先撤旧 working 或显式 transfer，等 terminal（默认 3s）；期间 Fill 正常应用；超时回退旧 generation + REDUCE_ONLY + 告警。
- §9.3 定义 `StrategyStartSnapshot`：positions、workingOrders（含 CANCEL_REQUESTED/UNKNOWN_ORDER）、recentTerminalOrders、exposure、latestQuotes（含 seq/age）、risk、strategyState、lastAppliedEventVersion、snapshotId/asOf。
- §13.4 有 `ReloadDuringFillIT`、`OldGenerationWorkingOrderIT`、`OrphanFillIT`。

**代码现状（不构成设计关闭的反证）**

- `RuntimeEngine.replaceStrategies` 仍是 `old.onStop` → 替换 → 把 `marketData.values()` 重放给新策略 → `new.onStart`（`RuntimeEngine.java:53-62`）；`SimpleHedgingStrategy` 没有 `onStop`（`SimpleHedgingStrategy.java:10-55`）；`RuntimeRunnerMain` 在 hot swap 前调 `cancelWorkingOrders`（`:237`）但没有等 terminal。设计在 M2/M3 明确要改，M0b 不依赖这些代码完成。

**仍需在实现阶段盯住的 P1**

- `strategyId` 在 hot reload 时是否允许变化。`DeploymentConfigLoader` 返回的 `next.strategyId()` 可以不同；如果变了，`PositionKey` 的 strategyId 也变，旧 Fill 会进入旧 key，新策略看到 flat。设计只写“1 strategy = 1 runner”，没有写“strategyId 在 runner 生命周期内不可变”。建议在 `RELOAD_PREPARE` 拒绝 strategyId 变化，或定义显式 position transfer。
- `TradeEnvelope.strategyKey` 为空的手工/遗留成交：§9.1 说 Fill 必须应用，但 `PositionKey` 需要 strategyId；空 key 会生成一个空 strategy 的 key，或需要归到当前 runner。设计没有规则。见 P0-11。

**结论**：原始 P0-4 的失败模式（旧 Fill 被丢、旧 working 不清理、新策略看不到状态）在设计层已经关闭；剩余是身份/归属的 P1。

### P0-5 单写者/线程边界/buffer：CLOSED

**设计已做到的**

- §4.2 线程所有权表：`qf-venue-md` 只写 ring/slot；`qf-venue-exec` 只 decode/filter/dedup/seq/enqueue；`qf-venue-account` 只写 SnapshotSlot；`qf-control-plane` 只构建/写 RiskCache/Control；`qf-strategy-loop` 拥有 `PositionKeeper/OrderBookView/RiskView/Closeout/generation`；`qf-ledger` 只持久化。
- §4.3 单写者表：order/cancel publication 只 loop；每个 publication 一个 `UnsafeBuffer`；`PositionKeeper/OrderBookView/RiskView/Closeout/generation/shutdown/WAL append` 都有唯一写者；`RiskView` 用 immutable slot + version，control 线程不直接改策略可见状态。
- §4.3 补充规则：exec 的 filter cache 只服务过滤、不暴露策略、可由 stream 重放重建、冲突以 loop 的 `OrderBookView` 为准、不得用于撤单/风控/敞口；trade dedup 只是快速过滤，canonical key 在 loop。
- §11.3 运行时检查：I/O 线程调用 submit/cancel/publication.offer 直接 `IllegalThreadStateException` + fatal。
- M0b 明确删除 `AeronOrderGateway.positions` 与决策用 `orders`，改名 `AeronExecutionIo`。

**代码现状**

- `AeronOrderGateway` 仍有 `orders/positions`（`:107-108`）、单 `buffer`（`:106`）、poll 线程 `monitorOrderPublication` 直接 `cancel`（`:813-832`）、risk 线程 `applyRiskSnapshot` 写 positions（`:1033-1076`）、risk 线程 `reconcileOpenOrders`（`:1091-1115`）。这些正是设计要删除的对象，M0b 退出证据必须覆盖。

**仍需在实现阶段盯住的 P1**

- WAL append（loop）与 fsync/rotate（ledger）的交接：设计说“WAL 追加 loop、WAL fsync/rotate ledger”，但没有定义 rotate 时如何阻止 loop 追加到正在关闭的 segment、如何发布新 segment 的 LSN、append 与 rotate 的失败如何 fatal。建议单生产者队列 + segment 状态机，或 loop 只 append 到固定 mmap、ledger 只 fsync。
- `publication.close()` 只 loop 做，但 fatal 路径可能在 loop 卡住时由 watchdog halt；halt 前是否允许关闭 publication、是否会让 cancel 无法发出，需要和 drain 顺序统一（见 P1-8）。
- `RiskView` 的 slot version 要处理“control 写入比 loop 消费快”的覆盖；设计说版本号 + loop 记录已消费版本，但没有定义丢版本时是否 WARMUP。建议丢版本只影响非关键字段，risk/lease 丢版本要 fail-closed。

**结论**：设计层关闭；M0b 必须以 ArchUnit + 运行时断言证明 gateway 账本已删除。

### P0-6 队列/背压/control 饿死：CLOSED

**设计已做到的**

- §4.4 loop 每轮先 drain control，再 exec，再 snapshot，再 MD，再 timer；control 有独立队列。
- §5.2 通道表：control 1024（满则 fatal）、exec 262144（offer 失败立即 fatal，不自旋、不阻塞、不落 runner 磁盘）、snapshot 版本槽、MD lossless ring 256、MD latest slot 1、adapter spool、alert/telemetry 可丢但计数。
- §5.3 fatal 语义：`FatalExecutionException` 进程级；listener 不得吞；I/O 线程只置 `closing/fatal`，publication.close 只 loop；watchdog 10s halt。
- §5.4 `OrderSubmission/CancelSubmission` 结构化 reason/retryable/retryAfterMs。
- §13.4 `ControlPriorityIT`（100 万 Fill 下 SHUTDOWN <1ms）、`ExecQueueFullIT`、`MdSlotBoundIT`。

**为什么仍是 CLOSED 而不是 PARTIAL**

- 原始 P0-6 的三个失败模式（I/O 线程 1s 自旋、control 与 Fill 共 FIFO、异常被吞）在设计层都有正面对策，且 §5.3 明确 fatal 不能被 listener 捕获。剩余问题是实现细节/类型问题，不是方向问题。

**必须在实现前修的 P1**

- **`FatalEvent` 类型不匹配。** §5.1 `ControlEvent` 与 `FatalEvent` 是 `RuntimeEvent` 的两个不同分支；§5.3 `controlQueue.tryOffer(new FatalEvent(e.cause(), ...))` 把 `FatalEvent` 塞进 `ControlEvent` 队列。要么让 `FatalEvent` 实现/包装成 `ControlEvent`，要么给 fatal 一个独立的 atomic + 事件槽。按当前文字编译不过。
- **预算值未定义。** `MAX_CONTROL_PER_ROUND`、`EXEC_BUDGET`、`MD_BUDGET` 都没有数值或时间预算；`ControlPriorityIT` 的 1ms 无法从设计推导。建议 control 每轮全 drain（容量 1024 可接受），exec/MD 用“最多 N 个事件或最多 200µs”双上限，并在批次内每 N 个事件检查 control/fatal。
- **exec 队列 262144 的容量语义。** 这是事件数，不是字节数；一个 `FillEvent` 含 envelope 引用，队列本身不大，但 262144 个对象在成交风暴中会放大 GC。建议按 venue/session 分队列或按字节预算，并给出满队列的压测。
- **fatal 后 adapter 的行为。** CTP `fatal_` 只是 break 主循环；runner fatal 是 `Runtime.halt(70)`。两边都需要 supervision/重启策略和“重启后先对账再开仓”的门禁；设计 §9.4 提了 handoff，但没有把 adapter 重启纳入 M5 退出证据。

### P0-7 决策链路 HTTP/JDBC：CLOSED

**设计已做到的**

- §11.1 逐项列出 18 个 loop 调用点：`DeploymentConfigLoader`、`reportHotState`、`refreshPositions`、`refreshRisk`、`indicatorGate`、`AeronMarketData.ticks()` fallback、`CloseoutGuard`、kill-file、`StrategyFactory.create`、`replaceStrategies`、`pnlPublisher.publish`、`metrics.log`、`catch Thread.sleep`、`monitorOrderPublication.cancel`、`reconcileOpenOrders`、shutdown hook drain、`FuturesPairStrategy` 旁路、`RuntimeAeronService/RuntimeOrderClient` 第二条 poll。
- §11.2 `RiskView` 缓存 `riskSnapshotId/asOf/staleAfterMs/accountLimits/strategyLimits/indicatorGate/gateAsOf/gateLoaded/leaseExpiry`；控制面宕机时 risk/lease 新鲜仍允许 OPEN，gate 在 grace 内沿用，超 grace 拒 OPEN，CLOSE/CANCEL 始终允许。
- §11.3 ArchUnit/字节码扫描禁止 `java.net.http/java.sql/org.springframework.jdbc/java.nio.file/okhttp3/retrofit2`；允许 IO 包 `aeron.io/runner.io/control/telemetry`；运行时禁止 I/O 线程 submit/cancel/publish。

**代码现状**

- `RuntimeRunnerMain` 主循环仍有 `Files.exists(killFile)`（`:216`）、`DeploymentConfigLoader.load`（`:226`）、`reportHotState`（`:231`/`:249`）、`refreshPositions`（`:256`）、`marketData.ticks()`（`:265`）、`CloseoutGuard`（`:288-295`）、`pnlPublisher.publish`（`:296-303`）、catch 里的 `Thread.sleep`（`:323`）。
- `AeronOrderGateway.submit` 仍对每个 OPEN 调 `client.indicatorGate`（`:315`）；`AeronMarketData.ticks()` 已删 HTTP fallback（`:97-102`），但仍是 latest map pull。
- 设计 M2/M3 明确删除；代码未做不构成设计关闭的反证。

**必须在实现前修的 P1**

- **ArchUnit 范围不够。** §11.3 只写 `com.quantlink.fin.runtime.loop` 和 `runtime.strategy`；`RuntimeEngine` 在 `com.quantlink.fin.runtime.engine`，是 loop 实际调用的类。如果 `RuntimeEngine.onMarketData` 仍调 `telemetry.write`（`RuntimeEngine.java:67-71`）或未来保留 HTTP，ArchUnit 不会失败。把 `runtime.engine`、`runner` 主循环包也纳入禁止列表，或把 `RuntimeEngine` 移到 `runtime.loop`。
- **同步日志/telemetry。** §1.3 目标 7 说“无同步日志刷盘”，但 §11.1 只把 `metrics.log` 移到 telemetry 线程；`log.error` 仍可能在 loop 内同步写 appender。需要明确 loop 只允许异步/有界日志，或把非致命 listener 错误交给 telemetry。
- **`RuntimeEngine.replaceStrategies` 仍重放 latest tick。** 这与 §9.2 “onStart(snapshot) 只读快照”不一致；新策略会通过 `onMarketData` 收到缓存 tick，而不是 `StrategyStartSnapshot.latestQuotes` 的带 age 视图。M2 应删除 `marketData.values()` 重放。

### P0-8 sequence/tradeId/gap 恢复：PARTIAL

**设计已做到的**

- §1.4/§5.5 明确 `OrderUpdateV2.sequence` 是 `(venueId, sourceSessionId, sourcePublicationEpoch)` 的 stream-global 单调序号，不能推断 per-order gap；只用于同订单回退过滤。这与 ADR-004 §5.2 一致。
- §5.5 Trade 幂等键 `(venueId, tradingDay, tradeId)`；`filledQty = max(orderUpdateCum, Σ tradeQty by clientOrderId)`；终态粘滞；`CANCEL_REQUESTED` 不是终态。
- §6.7 恢复点 `(venueId, accountId, streamKind, sourceSessionId, sourcePublicationEpoch, seq, tradingDay, tradeId?)`；checkpoint + WAL + dedup journal；重放走同一幂等路径。
- §10.3 MD seq scope `(venueId, sourceSessionId, sourcePublicationEpoch, exchange, instrumentId)`；gap 后抑制 scope 到 reset；consumer 重启有持久化基线则继续，无基线则等 READY + snapshot/reset。
- §13.4 `SequenceScopeIT`（V-04/V-06）、`DedupAcrossDayIT`、`ConsumerRestartSeqIT`。

**为什么仍是 PARTIAL**

1. **`tradingDay` 无法从当前 wire 构造。** `TradeEnvelope` 没有 `tradingDay`（`TradeEnvelope.java:4-27`），`TradeV2` 也没有（`venue-contract.md` §5）。设计 §6.3 的 `require(t.tradingDay())` 和 §5.5 的 dedup key 都是按“envelope 有 tradingDay”写的。用 `trade.timestamp` 的本地日历日代替是错的：CTP 夜盘 21:00 属于下一交易日，按日历日会把同一 `TradeID` 分到两个 key，或把不同交易日的同一 `TradeID` 误判为跨日重复。必须从 `VenueSession.tradingDay`/adapter 的 `tradingDay` 绑定到 `FillEvent`，或给 envelope 增加字段（Java 消费侧，不改 SBE）。
2. **`venue-contract` 的 tradeId 唯一性表述与设计冲突。** `venue-contract.md:160` 写 `tradeId 全局唯一（venueId + tradeId）`；设计写 `(venueId, tradingDay, tradeId)`。CTP 的 `TradeID` 是当日唯一，不是全局唯一。两处必须统一，否则 conformance 和 dedup 会按不同 key 实现。
3. **MD reset 没有 Port API。** §10.3 的 `onReset(MdReset reset)` 和“没有 reset 就一直 WARMUP”需要 `VenueMarketDataPort` 提供 reset/snapshot 入口；当前 `VenuePorts.VenueMarketDataPort` 只有 `subscribe` 和 `health`（`VenuePorts.java:176-204`），`AeronVenueMarketDataPort.resetGap` 是实现类方法（`:97-106`），不是接口。策略/loop 不应该依赖实现类。
4. **`lastSeqByStream` 持久化没有格式。** §7.1 要求 `VenueSession.lastSeqByStream[]`，但 `VenuePorts.VenueSession` 没有该字段（`VenuePorts.java:134-139`）；设计没有定义持久化文件/DB 表、scope 粒度、更新时机、与 `sourceSessionId/epoch` 的关系。consumer 重启的“有持久化基线”目前只是文字。
5. **EpochGuard/FencingGuard 未接线。** 设计 §5.5 说接线点在 exec I/O 的 `accept()`；当前 `AeronVenueExecutionPort` 只有 per-order `lastOrderSequence`（`:45-55`），没有 `sourceSessionId/epoch`、`fencingToken`、`deploymentGeneration` 检查；`VenueContractGuards` 只在测试中使用。M0a/M0b 必须把它变成生产路径。

**关闭条件**

- 给 `TradeEnvelope`/`FillEvent`/WAL 增加 `tradingDay` 来源，更新 `venue-contract` 的 tradeId 唯一性。
- 在 `VenueMarketDataPort` 增加 `subscribe(..., gapSink, resetSource)` 或 `installSnapshot/reset(scope, seq)`；把 `MdReset` 加入 `RuntimeEvent`。
- 定义 `lastSeqByStream` 的持久化 schema 和 scope，补 `VenueSession` 字段。
- 在 exec I/O 接 `EpochGuard`/`FencingGuard`，并加 V-04/V-06 运行时测试。

### P0-9 MD 合并与指标/replay：PARTIAL

**设计已做到的**

- §10.1 两条流：`MdEvent` 每个 envelope 一条，按 scope seq 有序，供 indicator/bar/lossless 策略；`LatestQuote` 每 `(venue, instrument)` 最新值，供 quote-only/closeout/展示；coalesce 只在 `MdEvent` 入 ring 之后。
- §10.1 默认 `marketDataMode()=LOSSLESS`；`QUOTE_ONLY` 必须检查 `age <= maxQuoteAgeMs`。
- §10.2 bar 聚合在 loop 内从 `MdEvent` 完成，用 `eventTime`，gap/reset 丢未完成 bar、标记 `bar_incomplete`，volume 只累加。
- §10.3 gap 后抑制 scope 到 reset，不“跳过继续”；consumer 重启有基线/无基线两种规则。
- §10.4 replay 等价口径：同输入日志 + 同 `CoalescePolicy` + 固定 clock/随机种子 + 稳定容器顺序；`netQty` 完全一致、决策序列一致、avg/realized 在容差内；不要求逐字节。

**为什么仍是 PARTIAL**

1. **没有注入 clock 的 SPI。** §10.4 的“固定 clock”无法强制：`Strategy`/`StrategyContext` 没有 `clock()`/`now()`；策略可以调 `System.currentTimeMillis`，`RuntimeEngine.onMarketData` 用 `Instant.now()` 写 telemetry（`:67-71`），`Portfolio`/`SimpleHedging` 也可能读系统时间。replay 的“决策序列一致”只在策略自觉使用注入时间时成立。必须给 `StrategyContext` 增加 `Clock`/`nowNanos`，并在 replay 模式注入。
2. **`LatestQuote` 每轮重发。** §4.4 `mdPipe.publishLatestTo(strategy)` 每轮 loop 调用；如果每轮都触发 `onMarketData`，QUOTE_ONLY 策略会以 loop 频率重复决策，而不是“有新报价才回调”。设计没有说 `LatestQuote` 只在 `version/seq` 变化时发布，也没有说重复发布是否推进策略的 `logicalIntentSeq`。这会直接影响 replay 和 cooldown。
3. **ring key 与 seq scope 不一致。** §5.2/§10.1 的 ring 是 `(venue, instrument)` 一个；§10.3 的 seq scope 含 `sourceSessionId/sourcePublicationEpoch`。reconnect/epoch 变化后，新 epoch 的 seq 从 1 开始，旧 ring/lastSeq 如果不 reset，会把新数据当 duplicate；如果 reset，又要保证不丢旧 epoch 的尾部。设计没有定义 epoch 切换时 ring/slot 的迁移。
4. **`MdReset` 不是事件类型。** §5.1 的 `RuntimeEvent` 没有 `MdReset`；§10.3 的 `onReset` 没有来源。与 P0-8 同一个洞。
5. **replay 容差没有数值。** §10.4 说 avg/realized “在容差内”，但没有给绝对/相对容差、样本、比较口径；`CoalescePolicy` 也没有枚举/字段定义。M2 的 `ReplayEquivalenceIT` 无法写断言。

**关闭条件**

- 在 `StrategyContext`/`Strategy` 增加可注入 clock；replay 模式禁止 `System.currentTimeMillis`（ArchUnit/字节码）。
- `LatestQuote` 加 `version/seq`，只有变化才投递；重复投递不推进 `logicalIntentSeq`。
- 定义 ring 的 epoch 切换/reset 规则，或把 ring key 扩到 scope。
- 补 `MdReset` 事件和 Port API。
- 给 avg/realized 容差和 `CoalescePolicy` 字段。

### P0-10 迁移顺序可执行性：PARTIAL

**设计已做到的**

- §14 重排为 M0a（Port 契约/字段/快照）→ M0b（单账本/WAL/删 gateway 账本）→ M1（shadow 事件总线）→ M2（loop 无 HTTP/JDBC/SPI）→ M3（runner cutover）→ M4（hedging）→ M5（live）。
- 每阶段有 feature flag、双读/双订阅、回滚条件、在途订单处理。
- M0a 明确 V-04/V-06/V-08/V-09/V-11；M0b 有 `FillDoubleApplyIT/ReverseFillOrderIT/RefreshBoundaryFillIT/RestartRecoveryIT`；M1 有计数恒等式；M2 有 `LoopNoBlockingIoArchTest/ThreadOwnershipTest/TimerWiringTest/SpiCompatibilityTest`；M3 有 `RunnerCutoverIT/DrainIT/KillSwitchIT`；M4 有 hedge/fee 测试；M5 有 5 日 live 证据。
- §14 明确“未通过退出证据不得进入下一阶段”。

**为什么仍是 PARTIAL**

1. **M0a 退出证据是伪 grep。** `asOf = Instant.now()` 这个字面模式在当前代码中不存在，但 `instant(serverTime, Instant.now())` 和 catch 里的 `Instant.now()` 仍在。按这条证据，M0a 会绿着进入 M0b，而 P0-3 的假新鲜没有修。必须换成行为测试。
2. **M0a 内容与 §7.1 交叉引用错误。** §14 M0a 写“`VenueDescriptor` 补齐 §7.1 字段”，但 §7.1 只有 Snapshot/PositionSnapshot/VenueSession/AccountSnapshot，没有 VenueDescriptor 的字段块；字段清单在 §16.1。设计应把 `VenueDescriptor` 的 `exchange[]/channels/streams/snapshotSources/healthSource/reconciliationMode/writerRole/descriptorVersion/counterpartyId/venueType/enabled/status/accountBindings/calendarMode/sessionPolicy` 写进 §7.1 或 M0a 正文。
3. **M0a 没有门禁 registry 默认值。** §16.3 把 `"SIM"`/`"*"`/`"legacy"`/1001/2100/3140 的删除列为“控制面与运维依赖”，但 M0a 的退出证据只有 SBE hash + V-04/V-06/V-08/V-09/V-11。按当前阶段，M0a 可以在 `VenueDescriptor` 仍默认 `SHADOW`、`AeronMarketData` 仍 `"*"`、`AeronStreams.MARKET_DATA=1001` 的情况下通过。这与 ADR-004 §11“删除 SHADOW 硬编码”和 P1-8 冲突。
4. **M0b ArchUnit 包名可能是空转。** `AeronOrderGateway` 在 `com.quantlink.fin.runner`，M0b 写“ArchUnit: runner.io 包不得出现 LocalPosition/PositionKeeper/OrderBookView”。如果只是把类改名为 `AeronExecutionIo` 而不移动包，`runner.io` 包不存在，测试会空转。M0b 必须写“类/包移动 + 测试扫描实际包”，并断言 `AeronOrderGateway` 不再有 `positions/orders` 字段。
5. **M1 shadow 没有 tee 点。** §14 M1 说“旧 latest 路径保留，新总线 shadow 运行；只观测，不参与决策”，但没有定义在哪个点复制事件、复制是否共享同一 `DirectBuffer`、shadow 是否与 production 同一线程、shadow 消费慢是否会反压 I/O。`EventBusShadowIT` 可以只测一个旁路消费者，不能证明 production 事件都被 shadow 看到。
6. **M3 的 grep 范围不够。** §14 M3 写 `grep -R "orderGateway.submit|orderGateway.cancel" backend/runtime-runner => 只在 Port 实现`；`RuntimeRunnerMain.drain` 仍直接 `orderGateway.submit`（`:389`），`cancelWorkingOrders` 直接 `cancel`（`:406`），`CloseoutGuard` 也直接 gateway。M3 必须先删除这些路径，否则 grep 会失败；设计应把它们列进 M3 内容，而不是只写退出 grep。
7. **没有阶段承接 P0-11/P0-12。** 账户独占、manual fill 归属、trading-day rollover、WAL 自包含性都没有对应的 M0a/M0b 退出测试。按当前 §14，M0b 可以在“WAL 只有部分字段、账户独占只在文字里”的情况下通过。

**关闭条件**

- M0a 退出改为行为测试（`SnapshotStaleIT`/`NoLocalClockIT`/`DescriptorFieldsIT`/`RegistryDefaultsIT`），并包含 `VenueDescriptor`/registry 默认值。
- M0b 退出包含实际包扫描、`AeronOrderGateway` 字段删除、WAL 重放自包含测试。
- M1 定义 shadow tee 点、复制语义、慢消费者策略。
- M3 明确删除 `drain`/`cancelWorkingOrders`/`CloseoutGuard` 直接 gateway 的路径。
- 增加 M0b/M3 的 P0-11/P0-12 测试。

## 3. 新增 P0

### P0-11 账本 scope 与账户独占未闭合（P0 级）

**证据**

- §6.1 `PositionKey = (venueId, accountId, strategyId, instrumentId)`；§6.6 `snapshotNet = snap.value().stream().mapToLong(PositionSnapshot::netQty).sum()`；§7.4 `finalSnapshot.value().allMatch(p -> p.netQty()==0)`。`PositionSnapshot` 没有 `strategyId`，它就是 account 级。
- `ControlPlaneVenueAccountPort.positions()` 返回控制面 risk snapshot 的所有行（`ControlPlaneVenueAccountPort.java:63-101`），`source` 缺省 `STRATEGY_LEDGER`；`RuntimeRunnerMain.refreshPositions` 也把 gateway/account positions 全量 seed 进 `Portfolio`（`:424-441`）。如果同一账户有手工单、另一个策略或遗留仓位，`snapshotNet` 包含它们，而 `PositionKeeper` 只含本策略，drift 会假阳性；drain 若按 `PositionKeeper` 平仓，又会漏掉手工仓。
- 硬约束 §8 要求 `strategy_id + account_id + instrument_id` 归属，不允许按账户总持仓反推（`01-架构硬约束.md:275-281`）。设计只写“V3 采纳 1 strategy = 1 runner = 1 account”，没有写启动时如何拒绝第二个 deployment/runner 绑定同一 account，也没有写 manual/blank-strategyFill 的归属。

**为什么是 P0**

- 这不是“未来多策略聚合”的问题；单策略 + 手工单的 CTP 账户每天都会遇到。`trusted()` 会把账户快照判为可信，`snapshotNet` 与本地策略账本不等，进入 RECONCILING；或者本地账本 seed 了手工仓，drain 去平手工仓。两种都会让 READY/drain flat 不可信。
- `TradeEnvelope.strategyKey` 允许为空（`TradeEnvelope.java` 没有非空校验），`AeronOrderGateway.onTrade` 对空 key 的 legacy/manual trade 直接 return（`:889-893`）；设计 §9.1 说 Fill 必须应用，但没有说空 key 归到哪个 `PositionKey`。

**关闭条件**

- 把“1 account = 1 agent = 1 strategy”变成启动时强校验：registry/DB 唯一约束或 lease；第二个 deployment/runner 绑同一 account 必须 fail-closed。
- 明确 manual/blank-strategyFill：要么归入 account-level ledger 并参与 flat（但策略不能拿它做决策），要么显式 `ORPHAN_ACCOUNT_FILL` + 告警 + 禁止自动 flat；不能静默丢，也不能静默算进策略账本。
- `PositionSnapshot` 增加 `strategyId` 或 `scope` 字段；`snapshotNet` 只汇总本策略 scope，另建 account-level 对账视图。
- 加 `AccountExclusivityIT`、`ManualFillAttributionIT`、`DrainWithManualPositionIT`。

### P0-12 WAL 自包含性与 `netQtyAt(asOf)`（P0 级）

**证据**

- §6.7 说 `recover()` 只用 `checkpoint + WAL`；`lastApplied = (venueId, accountId, streamKind, sourceSessionId, sourcePublicationEpoch, seq, tradingDay, tradeId?)`。但 `FILL_ACCEPTED` 记录没有 `accountId/strategyKey/exchange/sourceSessionId/epoch`；`ORDER_STATE` 没有 `instrument/side/offset/orderQty`；`INTENT` 没有 `strategy/account/venue`。按记录字段，重放时无法独立构造 `TradeEnvelope`/`OrderState`。
- §6.6 `netQtyAt(snap.asOf())` 需要按 `eventTime` 的持仓历史；§6.2 `PositionState` 只有当前 today/yesterday/avg/realized/fees/version，没有 fill 历史。设计没有定义保留窗口、存储结构、超窗行为。
- §6.7 `wal.truncateBefore(checkpointLsn)` 与 `checkpoint-<lsn>.json` 的写入/fsync/rename 顺序没有定义；如果 checkpoint 文件损坏或 truncate 先于 checkpoint durable，恢复点会丢。

**为什么是 P0**

- P0-2 的“唯一账本”与 P0-5 的“WAL 单写者”都依赖 WAL 是权威恢复源。如果 WAL 不是自包含的，`RestartRecoveryIT` 只能测“当前配置能猜对”的场景，不能测“换配置/多账户/多策略/夜盘日切”的场景；kill -9 恢复仍可能错账。
- `netQtyAt(asOf)` 是 drift 和 drain 的核心；没有历史就只能用当前净仓，快照 `asOf` 稍旧就会假 drift，或者忽略 drift。设计必须给出可实现的数据结构，而不是一句“用 fill eventTime 计算”。

**关闭条件**

- 补 WAL 记录字段，或明确“重放上下文”并把它写进 checkpoint（venue/account/strategy/instrument metadata），使 `recover()` 不依赖当前进程配置。
- 定义 `netQtyAt(asOf)` 的 fill 历史：per-instrument ring（保留最近 N 分钟/至少 2 个 snapshot 周期）、按 eventTime 索引、超窗返回 UNKNOWN 而不是 0。
- 定义 checkpoint 原子写、fsync、rename、truncate 顺序；加 `CheckpointCorruptionIT`。
- 加 `RestartRecoveryIT` 的“只给 WAL + checkpoint，不给当前配置”的变体；加 `SnapshotDriftAsOfIT`（快照 asOf 早于/晚于最后 fill）。

## 4. P1 必改

> 这一节覆盖上一轮 P1 的抽查项：Ports 字段、execution ordering/epoch、pending 语义、Portfolio/PositionKey、SimpleHedging、WAL/dedup、registry 默认值、drain fail-stop、验收指标。P1 不阻塞 M0a 的方向，但必须在对应阶段退出前关闭。

### P1-1 Ports 字段仍不完整，M0a 的“字段补齐”没有可核对的清单

| 项 | 现状 | 必改 |
|---|---|---|
| `VenueDescriptor` | 只有 `venueId/environment/adapterKind/capabilities`（`VenuePorts.java:28-29`） | 补 `descriptorVersion/counterpartyId/exchange[]/venueType/enabled/status/accountBindings/channels/streams/calendarMode/sessionPolicy/snapshotSources/healthSource/reconciliationMode/writerRole`（ADR-004 §3、§16.1） |
| `VenueDescriptor` 默认值 | `environment` 空 → `"SHADOW"`，`adapterKind` 空 → `"UNKNOWN"`（`:34-37`） | 缺字段 fail-closed，不默认 SHADOW/UNKNOWN；加 `DescriptorDefaultsIT` |
| `Capability` 形状 | `Set<Capability>` 枚举 | ADR-004 §3/venue-contract §11 是 `{supported, constraints, asOf}`；要么明确 V3 只用枚举，要么补 constraints |
| `AccountSnapshot` | 只有 `balance/available/tradingDay/snapshotId/source/asOf` | 补 ADR-004 §5.3 的 `margin/frozenMargin/commission/closeProfit/positionProfit/deposit/withdraw`，或明确 unknown 语义 |
| `VenueSession` | 无 `lastSeqByStream[]`（`:134-139`） | 补字段 + 持久化格式 |
| `OrderSubmission/CancelSubmission` | `requestId/accepted/reason/retryable`，无 `retryAfterMs`（`:47-69`） | 补 `retryAfterMs` 或明确由 loop 自己 backoff；与 §5.4 对齐 |
| `VenueMarketDataPort` gap 重载 | 默认实现丢弃 `gapSink`（`:195-199`） | 默认必须 fail-closed 或显式 `supportsGap()`；不能静默忽略 |
| `subscribePositions`/`VenueHealthPort.subscribe` | 默认 `throw`（`:235-239`、`:245-249`） | 加 `supportsPositionStream()/supportsHealthStream()`，或在 M0a 实现；runtime 走 snapshot-only + WARMUP 的路径要显式 |
| `VenueExecutionPort.subscribe` | 只按 venue，无 strategy/deployment scope | 明确 envelope 的 `strategyKey` 过滤责任；不要在 port 层丢真实成交 |

### P1-2 execution ordering/epoch 仍只在设计文字里

- `AeronVenueExecutionPort` 只维护 per-order `lastOrderSequence`（`:45-55`），没有 `sourceSessionId/epoch`、`fencingToken`、`deploymentGeneration`；`accept()` 只校验 venue/account（`:69-75`）。
- `AeronOrderGateway.onOrderUpdate` 在终态时 `orders.remove(id)`（`:861-862`），没有 `terminalHistory`；非终态状态可以回退（NEW/PARTIAL/OPEN 没有 lattice）。
- gateway 在 `notifyOrderUpdate` 之后才检查本地 order（`AeronOrderGateway.java:834-866`），如果 listener 是 loop，loop 可能先看到一条“本地已删除的终态”更新。
- `VenueContractGuards.EpochGuard` 的 `accept` 只接受递增 `session/epoch`，但新 adapter 重启可能复用/回退 session id；设计说“旧 session 拒绝”，需要定义 session id 的单调来源，或把 `adapterSessionId` 纳入比较。

**必改**：在 M0a 把 `EpochGuard/FencingGuard` 接到 exec I/O 的 `accept()`；在 M0b 把终态粘滞/terminalHistory 放进 `OrderBookView`；加 `OrderUpdateRegressionIT`、`StaleEpochFillIT`、`TerminalStickyIT`。

### P1-3 pending 语义基本正确，但公式漏了两种 offset

- §6.8 的 `pendingClose` 只写 `SELL CLOSE/CLOSE_TODAY` 和 `BUY CLOSE_YESTERDAY`；漏了 `BUY CLOSE`（平空）和 `SELL CLOSE_YESTERDAY`（平多昨仓）。这两个在 CTP 上都是合法组合，按当前公式会低估/高估敞口。
- `CANCEL_REQUESTED` 在设计中保留，但当前 gateway 的 `openOrders()/queueDepth()/openOrderCount()` 都跳过它（`AeronOrderGateway.java:407`、`:419`、`:660`）。M0b 的 `OrderBookView` 必须替换这些实现，不能只改设计。
- `terminalHistory` 有界保留到 session 结束；需要定义容量上限（按 order 数/时间），否则夜盘长会话会增长。
- `UNKNOWN_ORDER` 不参与 `pendingOpen`，但 `remainingQty=UNKNOWN` 的哨兵值需要类型/常量定义；`OrderState` record 的 `long remainingQty` 不能表示“未知”，除非用 `-1`。
- `seedOpenOrders` 写 WAL、幂等；但启动恢复优先 venue `ORDER_SNAPSHOT`，控制面 `openOrders` 只补充；当前 `seedOpenOrders` 只有控制面（`:776-790`），没有 venue snapshot 路径。

**必改**：把 `pendingClose` 公式补全；定义 `UNKNOWN` 哨兵；给 `terminalHistory` 容量；M0b 加 `PendingExposureIT`、`CancelRequestedPendingIT`、`SeedOpenOrdersIdempotentIT`。

### P1-4 Portfolio/PositionKey 仍缺 strategy/venue/account

- `Portfolio` 只按 `instrumentId` 存（`Portfolio.java:17`），`snapshot()`/`netDelta()`/`position()` 都不带 account/venue/strategy；`replacePosition` 仍直接覆盖（`:157-161`），`clearPositions` 仍存在（`:163-165`）。
- 设计 §6.1 的 `PositionKey` 含 `strategyId`，但 `PositionSnapshot` 没有 strategyId；`PortfolioSnapshot.cash` 是 account 级，`PositionKeeper` 在 `applyTrade` 累加 cash；如果多策略/手工单共享账户，cash 会混。
- `Portfolio.applyFill` 的 `cash -= notional + fee` / `cash += notional - fee`（`:46`、`:59`）没有乘 `multiplier`，而 `realized`/`unrealized` 乘了（`:38`、`:51`、`:92-93`）。对非 1 multiplier 的合约，cash/PnL 口径不一致。
- `Portfolio` 没有 today/yesterday；设计 `PositionState` 有，但 M0b 要明确 `Portfolio` 是否被 `PositionKeeper` 替换，还是保留为只读聚合。

**必改**：M0b 把 `Portfolio` 的 key 切到 `PositionKey` 或明确只读聚合；删除 `replacePosition/clearPositions` 的热路径；M4 给 `applyFill` 的 cash/notional 加 multiplier，并加 `FeeMultiplierPnlIT`。

### P1-5 SimpleHedging 目标语义基本正确，但默认值和持久化未定义

- §12.1 的 `E/P/R`、`side=-sign(R*delta_h)`、`q=lotRoundDown(min(maxOrderQty,|R|/|delta_h*mult_h|),lot)` 是正确的，已经修掉了当前 `SimpleHedgingStrategy` 的 `side = netDelta > 0 ? SELL : BUY`（`:47`）忽略 `delta_h` 符号的问题。
- `SimpleHedgingStrategy.Config` 只有 `deltaThreshold`（`:11-16`）；设计新增 `θ_open/θ_close/cooldown/lotSize`，但没有默认值、关系（必须 `θ_close < θ_open`）、配置 schema/backward-compatible 默认值。
- `armed` 初始规则只写“启动时 |R|>θ_open 且 READY 允许首笔；之后只有 |R|<θ_close 重置”；如果启动时 |R| 在 θ_close 和 θ_open 之间，是 armed 还是 disarmed？需要明确。
- `intentId = hash(strategyId,generation,logicalIntentSeq)`；`logicalIntentSeq` 何时递增（每次评估还是每次真正生成 order）没有定义。如果每次评估都递增，重复触发会产生不同 intentId，幂等失效。
- `onStart` 从 `StrategyStartSnapshot.strategyState` 恢复 `armed/cooldown`；`strategyState` 可空，空时默认 armed/cooldown 是什么没有定义。
- `offset` 减少现有 hedge 仓位时要按 today/yesterday 可用量选择 `CLOSE_TODAY/CLOSE_YESTERDAY`；如果两者都有，是否需要拆单？设计没有说。
- 当前 gateway 的同价去重（`AeronOrderGateway.java:321-330`）和 `throttle` 的 key（`RuntimeRunnerMain.java:520`）仍会吞合法补单/重试；§8.4 说删除/加 intentId，M3/M4 要落实。

**必改**：给 `θ_open/θ_close/cooldown/lotSize/maxOrderQty` 默认值和 schema；定义 `logicalIntentSeq` 只在生成 order 时递增；定义 `armed` 在中间区间的行为；补 `HedgeStartupTest/HedgeIdempotencyIT/HedgeOffsetSplitTest`。

### P1-6 WAL/dedup 仍是“设计有、代码没有”，且 dedup 窗口语义不够

- `seenTrades` 是 100k `LinkedHashMap` LRU（`AeronOrderGateway.java:120-127`），poll 线程 `add`（`:874`），risk 线程 `checkpointSeenTrades`（`:957`、`:1239-1252`）；`LinkedHashMap` 非线程安全，可能 `ConcurrentModificationException` 或写坏文件。设计 §2.2 已承认，M0b 必须替换。
- `tradeDedupKey` 用 `trade.timestamp()` 的本地日期（`:911-915`），不是 CTP `tradingDay`；夜盘会错。见 P0-8。
- 设计说“dedup journal 只是加速索引，权威以 WAL/checkpoint 为准”；但 `dedup.firstSeen(key)` 的运行时集合仍有界，超过 100k 的旧重复会再次进入 WAL。需要定义“dedup 窗口必须覆盖最大 Aeron redelivery/rewind；超出则 fatal 或查 WAL 索引”，否则 exactly-once 只是概率保证。
- `wal.truncateBefore(checkpointLsn)` 与 checkpoint 原子写/fsync 的顺序没有定义；`checkpoint` 损坏时的降级路径只在 §16.3 一句“WAL 配额/备份/恢复演练”，没有测试。
- `FILL_ACCEPTED` 记录缺字段（P0-12），`ORDER_STATE` 缺 `orderQty/instrument`，重放时需要 checkpoint 或 `INTENT` 补；设计没有写“哪些记录必须成对出现”。

**必改**：M0b 的 `PositionKeeper`/WAL 实现必须用单线程 dedup（loop 或 exec I/O）+ copy-on-write checkpoint；补 WAL 记录 schema；加 `KillNineRecoveryIT`、`DedupWindowIT`、`CheckpointCorruptionIT`。

### P1-7 registry 默认值仍在，M0a 没有门禁

- `VenueDescriptor` 默认 `SHADOW`/`UNKNOWN`（`VenuePorts.java:34-37`）。
- `AeronOrderGateway` 默认 `agentId="legacy"`、`routeId="legacy"`、`counterpartyId="SIM"`（`:200-204`），`environment` 默认 `SHADOW`（`:211-212`）。
- `AeronMarketData` venue 回退 `"*"`（`:26-28`），会订阅所有 venue 的行情。
- `AeronStreams.MARKET_DATA=1001`（`AeronStreams.java:5`），`MarketDataPublisher` 默认用它；ADR-004 §7 明确“不得回退 1001/2100/3140”。
- `VenueRegistryService` 对非 REPLAY 一律 `"SHADOW"`（`VenueRegistryService.java:59`），直接违反 ADR-004 §11。
- 设计 §16.3 说“删除身份/stream 默认值，缺配置 fail-closed”，但 §14 M0a 的退出证据没有包含这些；M0a 可以在默认值仍在的情况下通过。

**必改**：M0a 增加 `RegistryDefaultsIT`/`NoLegacyStreamDefaultIT`；删除 `"SIM"/"*"/"legacy"/1001` 默认值；`environment` 从 descriptor 来；缺配置 fail-closed。runner 侧 registry 客户端要在 M0a 接入，而不是留到 M2。

### P1-8 drain fail-stop 仍有三个洞

1. **shutdown hook 30s join 可能退出未 flat 的进程。** §9.4 写 hook 只投 `Control(SHUTDOWN)` + join loop（30s）；如果 loop 在 REDUCE_ONLY 等待 handoff，30s 后 hook 返回，JVM 仍会退出，和“只有 flat 或 operator ack 才退出”矛盾。需要定义 30s 后是“hook 继续阻塞”还是“halt 前写 handoff 并保留外部进程”。
2. **关闭顺序先停 MD 回调，后平仓。** §9.4 写“停新单 → 停 MD 回调 → 撤单并等 terminal → 平仓并等 terminal → 最终快照 → ...”。如果停掉 MD 回调，closeout/drain 的 `LatestQuote` 会过期，平仓单没有可信价格；应该只停“策略 MD 回调”，保留 MD subscription/latest slot 给 closeout 用，或最后平仓用 venue market order/FAK。
3. **`finalSnapshotRequestSeq` 不在 API。** §7.4 的 flat 谓词依赖它，但 `Snapshot`/`VenueAccountPort` 没有 requestSeq；见 P0-3。当前 `RuntimeRunnerMain.drain` 只看 `orderGateway.positions()`（`:370`），不是 venue 快照；M3 要替换。

**必改**：定义 shutdown 的 30s 语义；调整关闭顺序为“停策略回调、保留 MD 定价到平仓完成”；给 account port 加 requestSeq；`DrainIT` 覆盖“30s 未 flat”“快照过期”“MD 断流”三种情况。

### P1-9 验收指标有 4 个口径问题

1. **`exec_ingress = accepted + duplicate + gap + dropped` 没有 `fatal` 项。** 缺 `tradeId`、WAL append 失败、`applyTrade` 失败都是 fatal，但事件已经 ingress；恒等式会不成立。加 `fatal` 或明确 fatal 单独计数。
2. **`exec_gap_total` 只对 OrderUpdate 有意义。** `TradeV2` 没有 sequence；Trade 的“gap”只能靠 tradeId/venue snapshot。设计应把 `exec_gap_total` 拆成 `order_gap_total` 与 `trade_gap_total`（或声明 trade 不做 seq gap）。
3. **`md_lost_no_image_total` 必须 0 与 ring 256 的容量矛盾。** 高频行情/开盘 burst 下 ring 满会 WARMUP，指标会 >0；如果“必须 0”是 live 门禁，需要给出容量/背压证明或改成“WARMUP 可解释”。
4. **`gap_recovery_ms p99 <5s` 没有 reset API 时不可达。** 没有 `MdReset`/snapshot API，gap 后只能一直 WARMUP；验收 #6 的“只有 snapshot/reset 后恢复”无法执行。
5. **`ControlPriorityIT` 的 1ms 没有预算值。** 见 P0-6。
6. **`fill→onFill p99 <5ms` 包含策略回调时间。** 如果策略本身慢，SLO 会误判为账本慢；建议把 `apply` 与 `onFill` 分开，或按策略 baseline 扣减。

### P1-10 下单重试状态机缺失，`PENDING_RETRY` 会被当 duplicate

§8.2 的 `submit` 片段：

```java
if (prev == ACCEPTED || prev == TIMEOUT_UNKNOWN || prev == PENDING_RETRY) {
    return duplicate(intent.intentId());   // 重试走内部 retry，不重复 reserve
}
```

但片段里没有“内部 retry”循环；`port.submit` 只调用一次。如果 `port.submit` 返回 `BACKPRESSURE`/`PUBLICATION_CLOSED`，`recentIntents` 存 `PENDING_RETRY`，`orderBook` 保留 reservation；下一次同 intentId 的 `submit` 会直接返回 DUPLICATE，永远不再 publish。设计文字说“按 retryAfterMs 退避重试，直到 submitDeadline”，但状态机没有落地。这是一个可以静默丢单的 P1（若按 P0-1 的“不得静默丢 intent”口径，也可升级为 P0）。

**必改**：把 `PENDING_RETRY` 分成“内部重试中”和“可被外部同 id 查询”的状态；内部 retry 绕过 duplicate 检查，按 `retryAfterMs` 退避到 `submitDeadline`；超时后 `REDUCE_ONLY` + 告警；加 `BackpressureRetryIT`（先 BACKPRESSURE 后成功、先 PUBLICATION_CLOSED 后恢复、deadline 超时）。

### P1-11 `FatalEvent` 类型/控制队列与预算

- §5.3 `controlQueue.tryOffer(new FatalEvent(...))` 与 §5.1 的 `ControlEvent` 队列类型不一致；见 P0-6。
- `MAX_CONTROL_PER_ROUND`/`EXEC_BUDGET`/`MD_BUDGET` 没有数值或时间预算；`ControlPriorityIT` 的 1ms 不可推导。
- `watchdog.haltAfter(10s)` 与 `SHUTDOWN` 的 `durableLsn==appendLsn` 等待可能冲突：fatal 时如果 WAL fsync 卡住，10s 后 halt 会丢 page cache 之外的记录；需要定义 fatal 的 flush 优先级。

### P1-12 `RuntimeEngine`/ArchUnit/telemetry

- `RuntimeEngine` 在 `com.quantlink.fin.runtime.engine`，不在 §11.3 的禁止包列表；`onMarketData` 调 `telemetry.write`（`:67-71`），`replaceStrategies` 重放 latest tick（`:53-62`）。
- `RuntimeEngine.onTimer` 已实现（`:80-84`），但 runner 当前没有调用；M2 的 `TimerWiringTest` 要覆盖。
- `StrategyContext` 仍是具体类，`orders()/risk()/exposure()` 没有签名；`PositionView/OrderView/ExposureView/QuoteView/RiskSnapshot/StrategyState` 没有定义。M2 实现者仍要猜。

## 5. P2

1. `EventInbox`/`MdPipe` 的 string key（`venue|instrument`）每 tick 分配；建议 `InstrumentKey`/slot index，避免 GC 抖动。
2. `LatestQuote` slot 的覆盖计数/版本号要暴露，避免“覆盖”和“丢失”混在一起。
3. `alerts` 队列容量 1000，`offer` 失败被忽略（`RuntimeRunnerMain.java:543`）；设计允许丢，但要计数/降级日志。
4. `AeronStreams` 注释区间（1000-1099、2001-2005）与 ADR-004（1000-1199、2006-2099、9001-9999）不一致；`AeronEcho` 仍用 1001，建议清理。
5. `VenueDescriptor` 的 `Set.copyOf(capabilities)` 对 null 会 NPE；fail-closed 应给出明确异常。
6. `ControlPlaneVenueAccountPort.account` 的 `balance` 恒为 0（`:43`）；如果用于保证金/权益会误导，至少标 unknown。
7. `reportHotState` 用字符串拼 JSON（`ControlPlaneClient.java:370-383`）；version/fingerprint 含引号会坏，建议 ObjectMapper。
8. 新增 `thetaOpen/thetaClose/cooldown/lotSize/fee/multiplier/queueCapacity` 等配置需要 schema/backward-compatible 默认值/回滚策略；当前 `config_json` 只列少数 key。
9. `MarketDataPublisher.offer` 100 次 BusySpin 后丢样本（`MarketDataPublisher.java:60-77`）；MD 可丢，但应暴露 `lastResult`/drop 计数，且不要忙等拖住发布线程。
10. `SimpleHedgingStrategy` 直接 `message.askPrices()[0]`/`bidPrices()[0]`（`:48`）没有数组长度检查；空深度会 `ArrayIndexOutOfBoundsException`。`MarketDataMessage` 应保证至少 1 档，或策略检查。
11. `OrderState.remainingQty` 的 `UNKNOWN` 哨兵、`status lattice`、`TimerKind` 的 missed timer 语义、`PortfolioSnapshot.version` 的 scope 都没有定义；实现者会各自发明。
12. `exec_accepted_total`/`exec_duplicate_total` 的计数点（I/O 快速去重 vs loop canonical 去重）要在 §13.1 写清；否则恒等式对不上。

## 6. 阶段准入

| 阶段 | 允许？ | 条件 |
|---|---|---|
| **M0a** Port 契约/字段/快照 | **允许，带条件** | 先完成必改清单 1–4、7、8；M0a 退出必须用 `SnapshotStaleIT/NoLocalClockIT/DescriptorFieldsIT/RegistryDefaultsIT` 替换伪 grep；`ControlPlaneVenueAccountPort` 切到 venue/account truth。 |
| **M0b** 单账本/WAL/删 gateway 账本 | **不允许** | P0-2/P0-11/P0-12 未闭合；WAL schema、`netQtyAt(asOf)`、交易日切换、账户独占必须先定。M0b 退出要加 `RestartRecoveryIT`（仅 WAL+checkpoint）与 `AccountExclusivityIT`。 |
| **M1** 事件总线 shadow | **仅允许 shadow，且必须在 M0a 退出后** | 不得消费生产账本、不得参与决策；必须定义 tee 点/复制语义/慢消费者策略；P0-1（L1 措辞）和 P0-6（FatalEvent/预算）先修。M0b 未完成时 M1 只能做独立 shadow harness。 |
| **M2** StrategyEventLoop/无 HTTP/JDBC/SPI | **不允许** | 需要 M0b 退出 + P0-2/3/5/6/7/8/9 关闭；`RuntimeEngine` 纳入 ArchUnit；clock 注入、`LatestQuote` 版本、`replaceStrategies` 删除 cache replay；`StrategyStartSnapshot` 类型定义完整。 |
| **M3** runner cutover | **不允许** | 需要 M2 退出 + 24h shadow + P1-8 drain/close 顺序 + P1-10 retry 状态机；`RuntimeRunnerMain.drain/cancelWorkingOrders/CloseoutGuard` 直接 gateway 路径删除；`RunnerCutoverIT` 必须包含 kill -9/重连/未 flat。 |
| **M4** SimpleHedging | **不允许** | 需要 M3 退出 + P1-5 默认值/offset/onStart 持久化；`HedgeStartupTest/HedgeIdempotencyIT/HedgeOffsetSplitTest`。 |
| **M5** Live | **不允许** | 需要 M4 + P0-1 L0 spool 完成 + CTP no-drop/`tradeId` 空 fatal/`feeUnknown` + 控制面 flatten/handoff API + 5 日 live 证据。 |

**直接回答“是否允许进入 M1/M2/M3”**：

- **M1：有条件允许**（仅 shadow，M0a 退出后；不得作为决策源；M0b 未完成时只做独立 harness）。
- **M2：不允许。**
- **M3：不允许。**

## 7. 必改清单（按顺序）

1. **tradingDay 来源**：给 `TradeEnvelope` 增加 `tradingDay`，或在 exec ingress 用 `VenueSession.tradingDay` 绑定并写入 `FillEvent`/WAL；更新 `venue-contract` 的 `tradeId` 唯一性表述；加夜盘跨日测试。
2. **WAL 自包含**：补齐 `FILL_ACCEPTED/ORDER_STATE/INTENT` 字段（account/strategy/exchange/session/epoch/orderQty 等）；定义 checkpoint 原子写/fsync/truncate 顺序；加“只给 WAL+checkpoint”的恢复测试。
3. **`netQtyAt(asOf)` + 交易日切换**：定义 fill 历史窗口/结构、today→yesterday/settlement/dedup 日切；加 `SnapshotDriftAsOfIT`、`TradingDayRolloverIT`。
4. **快照真值**：`ControlPlaneVenueAccountPort` 切到 venue/account truth（`positions`/`PositionSnapshotService`），删除所有 `Instant.now()` fallback，区分 `snapshotAsOf` 与 per-row `positionAsOf`，`staleAfterMs/snapshotId/source` 透传；用行为测试替换 M0a 伪 grep。
5. **账户独占/归属**：启动时强校验 1 account = 1 agent = 1 strategy；定义 manual/blank-strategyFill 的 `ORPHAN_ACCOUNT_FILL` 语义；`PositionSnapshot` 加 strategy/scope；加 `AccountExclusivityIT/ManualFillAttributionIT/DrainWithManualPositionIT`。
6. **MD reset/seq**：给 `VenueMarketDataPort` 增加 reset/snapshot API，`MdReset` 进入 `RuntimeEvent`；定义 `lastSeqByStream` 持久化 schema；处理 epoch 切换的 ring/slot；加 `ConsumerRestartSeqIT/GapResetIT`。
7. **clock/LatestQuote**：`StrategyContext` 注入 clock；`LatestQuote` 只在 version/seq 变化时投递；replay 模式禁止 `System.currentTimeMillis`；给 avg/realized 容差数值。
8. **retry 状态机**：`PENDING_RETRY` 内部 retry 绕过 duplicate；`submitDeadline`/`retryAfterMs`/REDUCE_ONLY 语义；`OrderSubmission` 补 `retryAfterMs`；加 `BackpressureRetryIT`。
9. **fatal/control/预算**：`FatalEvent` 与 `ControlEvent` 类型统一；定义 `MAX_CONTROL_PER_ROUND/EXEC_BUDGET/MD_BUDGET`；`ControlPriorityIT` 用预算推导 1ms；fatal 时 WAL flush/close 顺序。
10. **Ports 字段/默认值**：`VenueDescriptor` 全字段 + fail-closed；`AccountSnapshot` ADR 字段；`VenueSession.lastSeqByStream`；`supportsPositionStream/supportsHealthStream`；删除 `"SIM"/"*"/"legacy"/1001` 默认值；M0a 加 `DescriptorFieldsIT/RegistryDefaultsIT`。
11. **ArchUnit/telemetry**：把 `runtime.engine`/`runner` 主循环纳入禁止 IO；loop 只允许异步/有界日志；删除 `replaceStrategies` 的 latest tick 重放；`RuntimeEngine.onTimer` 接线测试。
12. **drain/close 顺序**：保留 MD 定价到平仓完成；定义 shutdown 30s 后行为；account port 加 requestSeq；`DrainIT` 覆盖未 flat/快照过期/MD 断流。
13. **Portfolio/PositionKey**：M0b 切 key；删除 `replacePosition/clearPositions` 热路径；M4 给 `applyFill` cash/notional 加 multiplier；`FeeMultiplierPnlIT`。
14. **SimpleHedging**：`θ_open/θ_close/cooldown/lotSize/maxOrderQty` 默认值与 schema；`logicalIntentSeq` 只在生成 order 时递增；`armed` 中间区间；offset 拆单；`onStart/onStop` 持久化；`HedgeStartupTest/HedgeIdempotencyIT/HedgeOffsetSplitTest`。
15. **M0b/M3 退出证据**：实际包扫描（不是空转的 `runner.io`）、`AeronOrderGateway` 字段删除、`RuntimeRunnerMain.drain/cancelWorkingOrders/CloseoutGuard` 直接 gateway 路径删除、kill -9/重连/未 flat。

## 8. 开放问题

1. **账户独占是不是硬约束？** 如果 CTP 账户允许手工单/多策略，`PositionKey` 的 strategyId 与 account-level snapshot 必须同时存在两套视图；如果是硬独占，必须在 registry/DB/lease 层强制，而不是只写在设计里。
2. **`tradingDay` 的权威来源**：adapter `VenueSession.tradingDay`、控制面 `tradingDayLabel`、还是 WAL 记录？夜盘/日盘切换时谁负责递增？SBE 不能加字段，Java envelope 加字段是否可接受？
3. **Aeron 是否引入 Archive**：如果不引入，L1 只能“检测+对账”，不能“replay”；如果引入，retention/rewind/磁盘预算/恢复流程要进 M0a 还是 M5？
4. **CTP spool 的边界**：磁盘预算、轮转、fsync、重放顺序、与 dedup 的关系；是否允许在 publication closed 时阻塞 CTP 回调线程（当前是 fatal）。
5. **MD reset/snapshot 的来源**：venue snapshot、replay reset、还是 consumer 重启基线？`lastSeqByStream` 存哪里、存多久、跨重启如何校验？
6. **`netQtyAt(asOf)` 的历史窗口**：保留最近 N 分钟还是至少两个 snapshot 周期？超窗返回 UNKNOWN 还是用当前净仓？drift tolerance 是多少？
7. **shutdown 30s 后怎么办**：hook 继续阻塞、halt 并写 handoff、还是由外部 supervisor 接管？operator ack 存在哪里？
8. **replay clock 注入的 SPI**：`StrategyContext.clock()` 还是 `Strategy.onStart(clock)`？旧策略不实现时默认 `System` 还是 replay 专用？
9. **`StrategyStartSnapshot` 的类型定义**：`PositionView/OrderView/ExposureView/QuoteView/RiskSnapshot/StrategyState` 的字段、可空性、版本；M2 实现者需要。
10. **M1 shadow 的 tee 点**：在 Aeron fragment 解码后、`EventInbox` 入队前，还是 `RuntimeEvent` 分发器？共享 `DirectBuffer` 的生命周期如何保证？

## 9. 评审边界

- 本次为**只读复审**：只读取设计稿 Revision 2、上一轮 review、ADR-004、`venue-freeze-2026-11-12.md`、`venue-contract.md` 及指定 Java/C++ 代码；**未修改设计/代码，未 commit**。
- **未运行构建、单元测试、集成测试、24h soak、replay 或 CTP 联调**；因此本文所有“代码现状”仅来自静态阅读，不代表运行时验证。
- 未计算设计稿 sha256（本轮未运行 shell/hash 工具）；以 Revision 2、1423 行为准。若设计稿在本评审后继续修改，应以新版本重新核对 §1 表和 §7 必改清单。
- 未完整审：CTP session 内部细节、SimVenue/Replay adapter 的全路径、控制面 DB 迁移、前端、生产 190 环境、Aeron Archive 配置。
- 本文的“CLOSED”仅指**设计层**给出了可实现机制；代码关闭状态仍以 §2.2/§16 和各阶段退出证据为准。不要把本文的 CLOSED 当作“代码已支持”。

# V3 事件驱动运行时设计评审

- 日期：2026-11-14
- 对象：`docs/architecture/v3-event-driven-runtime.md`
- 评审版本：sha256 `91af16334af6a45c197dcd6192818d471d2fbed1282bb666f0eb7710aca60abd`（2026-11-14 01:04，290 行）
- 关联：ADR-004、`venue-freeze-2026-11-12.md`、`venue-contract.md`、`2026-11-12-adr-004-venue-review.md`、T-060/T-061
- 结论：**REJECT**
- 含义：事件驱动的方向正确，状态所有权问题也定位准确；但当前版本仍把“成交绝不丢、单写者、快照新鲜、Ports 已够用”当成接近完成，而代码证据显示这些是会直接导致持仓/成交错账、静默丢单、drain 误判 flat 的 P0。P0 关闭前不建议进入 M1 之后的实现。

> 说明：评审期间设计稿被外部更新过一次（从 282 行变为 290 行，新增 §4 loop 伪代码，§6 stale 描述改为控制面线程拉快照，§7 公式改为 `i ≠ h`）。本文按上述 hash 版本评审；若设计稿继续变化，应以新 hash 重新核对本文条目。

## 1. P0（必须修复，否则不可实施）

### P0-1 端到端“成交/订单绝不丢”不成立，设计只保证了 runner 内部队列

**证据**

- 设计 §5 写“成交、订单、持仓、控制不可合并、不可静默丢弃”（`v3-event-driven-runtime.md:121`），§8 写 exec 队列满“超时 fail-stop；绝不丢”（`:208`）。
- CTP adapter 的 outbound 队列有界：`ctp-adapter/src/ctp_aeron_bridge.h:401-406`，`kMaxOutbound = 8192`（`:643`），队列满时 `outboundDropped_++` 后直接 `return`；`publishOrder`/`publishTrade` 都走这个 `offer`（`:481-514`、`:516-548`）。`drainOutbound` 遇到 publication closed 也会丢（`:423-428`）。
- runner 侧也没有真正的 fail-stop：`AeronOrderGateway.java:283-291` 对每个 listener 的 `RuntimeException` 只 `log.error`，poll 继续。V3 的 `publishExec` 抛出的 `FatalQueueOverflow`（设计 `:131-136`）如果从 `onTrade`/`onOrderUpdate` 回调里抛出，会被这里吞掉，结果是“记录一条日志，然后继续丢事件”。
- `AeronVenueExecutionPort.java:65-76` 把 `gateway.submit` 的所有异常都转成 `acceptedForPublication=false`，既不区分风控拒绝、Aeron backpressure 还是 publication 断连，也没有指标。

**影响**

队列满、publication 短暂 closed、listener 瞬时异常，都可能让一笔成交或订单回报永远消失。之后 `Portfolio`/`OrderBookView` 与柜台不一致，drain 依据本地账本可能报 flat，实际仍有仓。设计里的“绝不丢”只覆盖了“事件已经进入 runner 之后”的一段，端到端不成立。

**必须修改**

- 把“绝不丢”定义成端到端契约：adapter 的 exec 流不得静默丢；要么阻塞/背压并保留有界内存，要么落 durable spool，并在恢复时显式产生 `Gap`/`ExecLost` 事件。
- runner 侧任何 exec 丢失都必须是进程级 fatal（独立 `FatalErrorHandler`，不能是会被 listener catch 的普通异常），并写 `exec_dropped_total`；重启后从 dedup + 快照恢复。
- `VenueExecutionPort.submit` 返回结构化结果：`acceptedForPublication` 之外还要有 `reason` 和 `retryable`；不能把风控拒绝和 Aeron backpressure 混成一个 `false`。
- 增加 conformance：打满 8192+ 执行事件、注入 publication closed、注入 listener 异常，验证“无静默丢失，或显式 fatal + 可恢复”。

### P0-2 Fill/Position 记账不可交换，当前双路径还会重复记账

**证据**

- 设计 §5 写“跨流无全序……记账必须可交换（tradeId、累计 filledQty）”（`:120`），§6 写成交在 loop 立即 `applyFill`（`:151`），`PositionEnvelope` 只对账（`:163`）。
- 当前 runner 先 `refreshPositions` 再 `drainLiveFills`：`RuntimeRunnerMain.java:248-252`。`refreshPositions` 把 gateway 的 `positions` 全量覆盖进 `Portfolio`（`:407-417`），而 gateway 的 `onTrade` 在 poll 线程改同一份 `positions`（`AeronOrderGateway.java:880`）。`onTrade` 先 `notifyTrade` 入 `liveFills`（`:863`）再 `applyPosition`（`:880`）；如果 `applyPosition` 先于 refresh 读取完成，而该成交还在 `liveFills` 里没被 drain，refresh 会把它复制进 Portfolio，随后 `drainLiveFills`（`RuntimeRunnerMain.java:398-404`）再应用一次，形成双重记账。这个竞态窗口每次 5s refresh 都可能出现。
- `Portfolio.applyFill`（`Portfolio.java:35-61`）的 avgPrice/realized 依赖买卖顺序；两笔方向相反的成交交换顺序，netQty 相同但 avgPrice/realized 不同。因此“记账可交换”对净持仓成立，对均价/已实现盈亏不成立。
- `AeronOrderGateway.onTrade`（`:882-888`）把增量 `qty` 加到 `filledQty`，而 `onOrderUpdate`（`:841`）把累计 `decoder.filledQty()` 取 max。如果 order update 的累计值已经包含该笔 trade，再相加就会高估 filledQty。

**影响**

对冲数量、`maxPosition`、PnL、replay 结果都会偏。设计说“成交后同一轮循环更新持仓”只解决了延迟，没有解决“账本是否正确”。

**必须修改**

- 明确唯一账本：V3 起删除 gateway 的 `positions` 决策路径，`PositionKeeper` 是唯一写者；成交只应用一次，refresh/对账不得覆盖已确认成交。
- 定义每 instrument 的成交全序：优先使用 venue trade sequence；没有的话用 `(eventTime, tradeId)` 并在窗口内重排，或者明确只保证 netQty，avgPrice 从权威快照重算。
- `filledQty = max(orderUpdateCumulative, sum(tradeQty by tradeId))`，不能把增量 trade 直接加到累计值上。
- 增加“refresh 边界成交”“两笔反向成交任意顺序”“order update 与 trade 乱序”三个回归测试。

### P0-3 启动/对账快照的 asOf/stale 是本地伪造，WARMUP/READY/drain flat 不可信

**证据**

- `ControlPlaneVenueAccountPort.java:44-63`（当前唯一的 `VenueAccountPort` 实现）：成功时 `asOf = Instant.now()`、`stale = false`；失败时才 `stale = true`。也就是说，只要 HTTP 请求成功，无论控制面缓存多旧、CTP 是否断线，这个 port 都报“新鲜”。
- 同一个 port 的 `positions()` 只构造 `longQty/shortQty/avgPrice`（`:54-60`），丢掉 `todayLong/todayShort/yesterdayLong/yesterdayShort/longAvgPrice/shortAvgPrice/settlementPrice`。
- `VenuePorts.java:53-54` 的 `Snapshot` 只有 `value/asOf/stale`，没有 `staleAfterMs/tradingDay/snapshotId/source`；`:59-61` 的 `PositionSnapshot` 只有 long/short/avg；`:63-66` 的 `VenueSession` 没有 loginState/settlementState/leaseExpiry/lastSeqByStream。
- 设计 §6 用 `asOf` 超过 `staleAfterMs` 判 WARMUP（`:149`），§6 用快照比对 drift（`:163`），§9 drain 等“新快照”（`:221`）。这些判断都建立在不存在的字段上。
- T-061 已明确 `V-D` 仍为 PARTIAL，完整 `VenueAccountPort` position/session 流尚未完成（`docs/tasks/T-061-v2-master-execution.md:434-435`）。

**影响**

控制面缓存旧持仓会被判成 READY；drain 可能用旧快照确认 flat；`CLOSE_TODAY`/`CLOSE_YESTERDAY` 无法决策；drift 检测没有可信基线。V3 的 fail-closed 状态机在最关键的地方是“假新鲜”。

**必须修改**

- `PositionSnapshot` 补齐 today/yesterday/long-short/avg/settlementPrice；`Snapshot` 增加 `staleAfterMs/tradingDay/snapshotId/source`；`VenueSession` 补齐 session 字段。
- `ControlPlaneVenueAccountPort` 必须透传 venue/控制面给出的 `asOf` 和 `staleAfterMs`，不能用 `Instant.now()` 伪造；任何未知/缺字段都返回 `stale=true`。
- `BOOTSTRAP`/`READY`/`drain` 的 flat 判定必须同时满足：本地 terminal + 新鲜 venue/account 快照 + 快照版本晚于本地最后成交；只信本地账本不够。
- 增加 V-09 snapshot stale、V-08 today/yesterday 的 conformance；在 M0 退出条件中逐项列出。

### P0-4 热加载/epoch 规则会丢弃真实成交，旧挂单没有清理

**证据**

- 设计 §9 写“`deploymentGeneration` 递增，旧 generation 的成交/回报丢弃”（`:219`）；§8 写“旧 epoch 事件丢弃并计数”（`:207`）、“旧 epoch 迟到回报只更新审计，不更新 `OrderBookView`”（`:213`）。
- 但旧 generation 的订单可能仍在柜台存活，它们的成交是真实的仓位变化。丢弃这些 Fill 会让 `PositionKeeper` 永远不知道仓位；审计里也没有可消费的仓位更新。
- 当前 hot reload 是 `engine.replaceStrategies` 直接 `old.onStop` → 替换 → 新策略吃缓存（`RuntimeRunnerMain.java:232`、`RuntimeEngine.java:53-62`）；`SimpleHedgingStrategy` 没有 `onStop` 实现（`SimpleHedgingStrategy.java:10-55`），旧策略的 working hedge 单不会自动撤销。
- 设计自己在风险清单里承认“旧 timer/未撤单不清理会留下幽灵仓位”（`:269`），但 §9 的 hot reload 步骤没有对应的 cancel/transfer 动作。

**影响**

新策略可能认为已经 flat 或已经对冲，实际柜台还有旧 generation 的挂单/成交；极端情况下形成裸腿。把真实 Fill 当成“旧事件”丢弃，是比重复记账更危险的错误。

**必须修改**

- 区分“过期/重复事件”和“真实执行”：Fill 必须按 tradeId 幂等应用到 `PositionKeeper`（并进入审计），generation/epoch 只用于限制策略回调和命令，不得丢弃仓位变化。
- hot reload 边界必须先处理旧 generation 的 working orders：撤单并等待 terminal，或显式转移给新策略/ drain；不能只 `onStop`。
- `onStart(snapshot)` 的 `snapshot` 要定义清楚：positions、pending、delta、last quote、armed/cooldown、last event version；否则新策略无法安全重建状态。
- 增加“reload 期间成交”“旧 generation 挂单未撤”两个集成测试，以及 `orphan_fill_total` 指标。

### P0-5 单写者只写在设计里；gateway 内部账本和重连撤单仍跨线程

**证据**

- `AeronOrderGateway.java:105-106` 的 `orders`/`positions` 被多处写：poll 线程 `onOrderUpdate`（`:819-851`）、`onTrade`（`:853-889`）；risk 线程 `reconcileOpenOrders` 会 `removeIf`（`:930`、`:1065-1082`）；strategy 线程 `submit`/`cancel` 也写 `orders`（`:294-358`、`:361-385`）。
- `reconcileOpenOrders`（`:1065-1082`）在 risk 线程按控制面 `openOrders` 的 10s 窗口删除本地 working；控制面延迟/漏单时会把真实挂单从账本删掉，pending exposure 直接归零。
- `monitorOrderPublication` 在 poll 线程直接调用 `cancel()`（`:798-817`），`cancel()` 里 `cancelPublication.offer`（`:373-374`），违反“publication offer 只在 loop 线程”。
- `submit`/`cancel` 共用同一个 `UnsafeBuffer buffer`（`:104`），而 shutdown hook 的 `drain` 会在另一个线程调用 `submit`/`cancel`（`RuntimeRunnerMain.java:197-201`、`:333-392`）。这是 buffer 内容竞争 + publication 多写者。
- 设计 §4 说 publication offer 只在 loop（`:82`），§9 说 `Fill/OrderUpdate` 只由 loop 应用（`:223`）；但它没有说 gateway 的 `orders/positions` 要删除，也没有说重连撤单要从 poll 线程移到 loop。

**影响**

即使 V3 给 `Portfolio`/`OrderBookView` 加线程断言，gateway 内部账本仍然会被 I/O/risk 线程改写；`orders` 的本地 working 集合和 pending 敞口会漂移。最坏情况是 `UnsafeBuffer` 被两个线程同时编码，发出去的是混合报文。

**必须修改**

- 把 `AeronOrderGateway` 拆成“I/O 解码/去重/seq/epoch 过滤”和“loop 侧 OrderBookView/PositionKeeper”；删除 gateway 的 `positions` 决策路径。
- 重连后的 cancel-all 改成 `Control(RECONNECTED)` 事件，由 loop 执行；`reconcileOpenOrders` 的 remove 也改成 loop 的对账结果，不在 risk 线程直接删。
- shutdown hook 只设置 `closing` 并投 `Control(SHUTDOWN)`，不能直接 `drain/submit/cancel`；`OrderSink` 在 loop 内检查 `closing`，避免 hook 等待期间继续下单。
- 每个 publication 一个 writer 断言；`buffer` 改为 loop 独占或每线程独立。

### P0-6 队列/背压方案会在 I/O 线程自旋 1 秒，control 可能饿死，异常会被吞

**证据**

- 设计 `:131-136` 的 `publishExec`：`20_000` 次自旋 × `parkNanos(50_000)`，最坏约 1 秒；超时才抛 `FatalQueueOverflow`。这发生在 `qf-order-events`/`qf-venue-account` 的 I/O 线程上，会把 order/trade 的 `poll` 停住。
- 如 P0-1 所述，`FatalQueueOverflow` 从 `AeronOrderGateway.notifyTrade` 抛出时会被 `:283-291` 捕获，fail-stop 不生效。
- `exec` 是单个 `MpscArrayQueue`（`:127`），Control 也走 `publishExec`；FIFO 下 `SHUTDOWN/DRAIN` 会排在大量 Fill 后面。设计说“控制事件不设预算”（`:113`），但没有独立的 control 队列，优先级只存在于“出队之后”。
- `dirty` 是无界 `ConcurrentLinkedQueue`（`:129`），每个 tick 都 `offer` 一个字符串 key（`:140`）；行情突发时内存无上限，`md_dropped_total` 永远不会增长。
- 同一时段 CTP adapter 的 outbound 只有 8192（P0-1），poll 线程一停，CTP 侧就开始丢 order/trade。

**影响**

一次成交风暴可能同时造成：runner 停止 poll → CTP 队列满 → 成交/回报丢失 → 持仓错。shutdown/drain 也可能被排在成交后面，无法及时执行。

**必须修改**

- 独立的有界 `control` 队列，loop 每轮先 drain control；`exec` 与 `control` 分开，Control 不跟 Fill 抢 FIFO。
- `publishExec` 在 I/O 线程不做秒级自旋；要么非阻塞 + 显式 fatal handler（进程级），要么把入队放到独立 handoff 线程。I/O 线程的任何阻塞都应小于 100µs。
- `dirty` 改为有界 per-instrument slot/bitmap（每合约一个 dirty 位 + 最新值），不要每 tick 入队一个字符串；定义容量、淘汰和 `md_dropped` 的真实语义。
- 增加“队列打满 + publication backpressure + 成交风暴”的集成测试，验证 control 不被饿死、无静默丢、内存有界。

### P0-7 决策链路仍有同步 HTTP/JDBC，与硬约束和验收 #3 冲突

**证据**

- `AeronOrderGateway.submit` 对每个 OPEN 调 `client.indicatorGate(strategyId)`（`:299-305`），`ControlPlaneClient.indicatorGate` 是同步 HTTP（`:219-228`），`get` 的超时是 5 秒（`:385-392`）。
- `AeronMarketData.ticks()` 在 Aeron 2 秒无 tick 时调用 `fallback.ticks()`（`AeronMarketData.java:103-119`），这是同步 HTTP，而且发生在主循环 `marketData.ticks()`（`RuntimeRunnerMain.java:257`）。
- 以 `--deployment-id` 启动时，`RuntimeRunnerMain` 主循环每 5 秒调用 `DeploymentConfigLoader.load(deploymentId)`（`:219-222`），这是 MyBatis/JDBC；`DeploymentConfigLoader.java:16-17` 自己的注释写着“must never be called from the strategy loop”。同一段还调用 `controlPlane.reportHotState`（`:241`），也是同步 HTTP。
- 硬约束明确禁止：`01-架构硬约束.md:111-118`（Runner 轮询 `/market/ticks`、每 tick HTTP）、`:153-159`（每笔订单同步 HTTP）、`:216-237`（策略循环禁止 JDBC/HTTP/文件 IO）、`:283-300`（禁止 HTTP tick + Aeron tick 双源）。
- 设计 §1/§10 却写“决策链路上没有 5 秒轮询”“无同步 HTTP”（`:10`、`:284`）；M3 只列了 `refreshPositions`、`latest` map、风险 HTTP（`:256`），没有列 `indicatorGate`、MD fallback、`DeploymentConfigLoader`、`reportHotState`。

**影响**

控制面或数据库一次 5 秒超时就能把 loop 卡住 5 秒；OPEN 在控制面不可用时被 `indicatorGate` 拒绝，违反“控制面宕机 runner 继续交易/风控新鲜时继续开仓”的硬约束。1ms 下单 SLO 也不可能成立。

**必须修改**

- `indicatorGate` 的结果进入 `RiskView`（控制面线程拉取/推送），loop 只读缓存；控制面不可用时按 risk 新鲜度决定 OPEN，而不是同步 HTTP。
- 删除 `AeronMarketData` 的 HTTP fallback；Aeron 断流就 WARMUP/fail-closed，不能双源。
- `DeploymentConfigLoader` 和 `reportHotState` 移到 `qf-control-plane` 线程；loop 只接收 `Control(RELOAD/DEPLOYMENT_STATE)`。
- 在 §2 现状表里补上这些调用，并在 M3 退出条件中加“loop 线程无 HttpClient/JdbcTemplate/文件 IO”的静态检查（ArchUnit 或字节码扫描）。

### P0-8 sequence/tradeId 语义与 wire 不一致，gap 恢复没有快照

**证据**

- CTP `publishOrder` 使用 `.sequence(nextOrderSequence())`（`ctp-adapter/src/ctp_aeron_bridge.h:501`），而 `nextOrderSequence()` 是全局 `orderEventSequence_`（`:569-575`、`:636`）。`venue-contract.md:143` 写的是 `sequence` 作用域 = per `clientOrderId`、单调；ADR-004 §5.2 也要求 orderEpoch/fencing/sequence。全局递增仍能保证“单个订单的 sequence 不回退”，但它不能提供 per-order 完整性：A 的 10 与 12 之间缺的 11 可能属于 B；如果实现按 per-order `next = last+1` 检查，会把正常交叉误判为 gap；如果实现成 stream-global last，则会误丢其他订单的合法更新。设计没有说明采用哪一种。
- `publishTrade` 在 `trade.tradeId` 为空时用 `"CTP-" + clientOrderId` 兜底，并截断到 31 字符（`:521-523`）。CTP 的 `TradeID` 是当日唯一，不跨日全局唯一；runner 的 dedup 只用 `tradeId`（`AeronOrderGateway.java:857-861`），文件是 100k 的有界 LRU（`:117-123`），而且 `LinkedHashMap` 不是线程安全的。
- `AeronVenueMarketDataPort` 检测到 gap 只 `gaps.incrementAndGet()`，然后继续把该 envelope 分发给 sink（`AeronVenueMarketDataPort.java:99-111`）；没有任何“gap 后抑制/等快照”的状态。`VenueMarketDataPort.subscribe` 只有一个 `Consumer<MarketDataEnvelope>`，没有 gap/health 回调（`VenuePorts.java:74-87`）；也没有 MD 快照 API。
- 设计 §5 说“同一 clientOrderId 的 sequence 单调，旧序/回退丢弃”（`:111`），§8 说 gap 后等快照/重放补齐（`:206`），但当前 wire 和 port 都不支持这些语义。
- `EpochGuard`/`FencingGuard` 只在测试里使用（`VenueContractConformanceTest`），生产代码没有接线。

**影响**

per-order 完整性无法靠这个字段判断：缺的中间值可能属于别的订单，真正的丢更新不会被发现；如果实现成 stream-global 则会误丢。consumer 重启后第一个 seq=N 会被判 gap，又永远没有快照可补，合约只能一直 WARMUP。跨日的同一 `TradeID` 会被 dedup 误杀，造成少记成交。

**必须修改**

- 二选一：改 C++ publisher 为 per-`clientOrderId` sequence（并更新 ADR-004/venue-contract/conformance），或把 `sequence` 明确定义为 stream-global，不再用它做 per-order 完整性判断。不能一边写 per-order、一边发全局。
- dedup key 改为 `(venueId, tradingDay, tradeId)`（或直接依赖 DB unique），并明确 LRU/文件/db 三层的持久化语义。
- 增加 MD 快照/基线 API，或定义“首个 seq 建立基线 + 持久化 last seq per `(venue, session, epoch, exchange, instrument)`”；consumer 重启不能必然 WARMUP。
- 在 port 或 loop 中接入 `EpochGuard`/`FencingGuard`，并加 V-04/V-06 的 runtime 侧测试。

### P0-9 MD 合并会改变指标/策略语义，和 replay 确定性冲突

**证据**

- 设计 §1 说行情是事件（`:15`），§5 又写 `Md` 每合约只保留最新（`:111`），§5 说“行情可合并”（`:121`），§10 要求 replay 逐字节一致（`:247`）。
- 设计 §10 把指标列入决策预算（`:233`），但 `RuntimeEngine.onMarketData` 对每个 tick 调 `indicator.onMarketData`（`RuntimeEngine.java:64-78`）；`Indicator` 接口只接收逐 tick 的 `MarketDataMessage`（`Indicator.java:8`）。EMA、1m bar 的 high/low/volume、VWAP 都需要每个 tick；只留最新会丢掉 bar 内的高低价和成交量。当前 runner 以 `List.of()` 启动 indicator（`RuntimeRunnerMain.java:166`），但 V3 的 SPI/预算明确包含指标；一旦接入，coalesce 就会改变语义。
- 当前 `AeronMarketData` 的 `latest` map 已经是“每合约最后一笔”，设计把它换成 `MdSlot` 并没有改变“采样”本质，只是换了一个数据结构。

**影响**

指标值与回测/实盘不一致；依赖 bar/volume 的策略决策改变；所谓“同一事件日志 replay 结果确定”只在“replay 也使用 coalesce 后的事件日志”时成立，和原始行情回放不等价。验收 #8 会给出虚假的安全感。

**必须修改**

- 明确区分两条流：`MdEvent`（lossless，供 indicator/bar 消费）和 `LatestQuote`（可合并，供只关心最新价的决策）。coalesce 只能发生在 indicator 消费之后，或者由策略显式声明“只要最新价”。
- 如果坚持在 inbox 合并，必须定义 bar 聚合规则（high/low/volume/OHLC 在 I/O 线程或 loop 内聚合），并加“raw replay vs coalesced replay”的等价测试。
- 在 §10 写明哪些消费者允许丢 tick、哪些不允许；验收 #8 改为“同一输入日志 + 同一 coalesce 规则下决策一致”，并给出数值容差。

### P0-10 迁移顺序的退出条件不可证明，M2 在账本拆分前就要求单写者

**证据**

- M0 只写“gateway 隐藏到 port 后”（`:253`），但 `AeronOrderGateway` 仍拥有 `orders/positions`（P0-5）；一个 wrapper 就能满足“runtime 不直接依赖 `AeronOrderGateway`”的字面条件，却没有任何所有权变化。
- M2 要求 `Portfolio/OrderBookView/RiskView` 单写者（`:255`），但没有前置阶段删除 gateway 的 `positions`/`orders` 写路径；单写者断言只能覆盖新对象，覆盖不到 gateway。
- M1 的退出条件“事件计数与 poll 计数一致；shadow 零丢”（`:254`）与“行情可合并”（`:111`）矛盾：coalesce 后事件数必然小于 poll 数。
- M3 的“决策路径无 HTTP”（`:256`）没有覆盖 `indicatorGate`、MD fallback、`DeploymentConfigLoader`、`reportHotState`（P0-7），按现有清单做完也达不到。
- 没有任何阶段创建持久账本/WAL 或修 snapshot 字段（P0-3）；M3 的“24h shadow 零 drift”没有可信基线。

**影响**

阶段验收可以“绿”，但核心不变量仍是假的；迁移会同时保留双账本和 HTTP，回滚时无法判断哪本账是对的。

**必须修改**

- 重排为：M0a Port 契约/字段/snapshot 语义 → M0b 单账本 + WAL/恢复点 + 删除 gateway 账本 → M1 shadow 事件总线（ingress/accepted/duplicate/gap/dropped 四类计数）→ M2 loop + 无 HTTP/JDBC + Strategy 回调 → M3 runner cutover → M4 hedging → M5 live。
- 每个阶段给出可执行测试和退出证据，而不是“conformance 绿/延迟达标”这种笼统条件。
- M1 的计数改为 `ingress = accepted + duplicate + gap + dropped`，MD 的 delivered 可以小于 accepted，但必须可解释。

## 2. P1（实施前应修复）

### P1-1 VenuePorts 字段/能力不完整，M0 退出条件覆盖不到

`VenuePorts.PositionSnapshot` 只有 long/short/avg（`:59-61`）；`Snapshot` 缺 staleAfterMs/tradingDay/snapshotId/source（`:53-54`）；`VenueSession` 缺 login/settlement/lease/lastSeq（`:63-66`）；`VenueDescriptor` 缺 ADR-004 §3 的 exchange/streams/snapshotSources/healthSource/reconciliationMode/writerRole。`subscribePositions` 和 `VenueHealthPort.subscribe` 默认直接 `throw UnsupportedOperationException`（`:118-122`、`:128-132`）。T-061 也确认 V-D 仍 PARTIAL（`:434-435`）。

**影响**：V3 的 READY/drain/recovery/registry 只能靠字段不全的 port 实现，最终会退化成“再读控制面 HTTP”。

**修改**：补齐上述字段；M0 退出条件逐项列出 V-04/V-08/V-09/V-11，并明确 `subscribePositions` 不支持时的降级路径（snapshot-only + WARMUP 规则）。

### P1-2 Gap/WARMUP 无法通过 MD Port 表达

`AeronVenueMarketDataPort` 检测到 gap 只计数，然后继续分发（`:99-111`）；`VenueMarketDataPort.subscribe` 只有 `Consumer<MarketDataEnvelope>`，没有 gap/health 回调；`VenuePorts` 没有 MD 快照 API。设计 §5/§8 的 `Gap` 事件和“恢复前不回调策略”没有接缝。

**影响**：要么 runtime 自己解码 Aeron（违反“策略不接触 subscription”），要么永远不知道 gap。

**修改**：给 MD port 增加 `subscribeHealth`/`MarketDataEvent`（含 Gap/Recovered），或在 `MarketDataEnvelope` 外套一个带 `gap` 标记的事件；gap 后由 port 抑制该 scope，直到 reset/快照。

### P1-3 Execution Port 没有 ordering/epoch/generation 过滤

`AeronVenueExecutionPort` 只按 venue/account fan-out（`:90-96`），不检查 `sequence`、`sourceSessionId/epoch`、`fencingToken`、`deploymentGeneration`。`AeronOrderGateway.onOrderUpdate` 完全不看 `decoder.sequence()`（`:819-851`），并且终态直接 `orders.remove(id)`（`:846-849`）；非终态状态可以回退（PARTIAL → OPEN）。

**影响**：V3 的“旧序/旧 epoch 丢弃”“终态粘滞”在 port/gateway 层没有实现；策略可能看到回退的订单状态。

**修改**：port 或 loop 侧维护 per-order `(sequence, status, filledQty)` 单调规则；接入 `EpochGuard`/`FencingGuard`；终态保留审计记录，不直接删除；增加乱序/回退测试。

### P1-4 OrderBookView 的 pending 语义不完整

设计 §6 的 `signedRemaining`（`:153-161`）没有定义 OPEN/CLOSE/CLOSE_TODAY/CLOSE_YESTERDAY 的符号和上限；当前 `openOrders()` 和 `queueDepth()` 都跳过 `CANCEL_REQUESTED`（`AeronOrderGateway.java:389-397`、`:401-405`），意味着撤单请求发出后、终态回来前，pending exposure 已经被丢掉，敞口被低估。终态订单被 `remove`，没有历史保留。

**影响**：对冲/平仓计算偏乐观；cancel 未确认时可能重复下单；审计缺失。pre-trade risk 也受影响：`ensureRisk` 的 `maxPosition` 只看 gateway `positions` 的 net（`AeronOrderGateway.java:575-585`），不含 pending；`openOrderCount` 也跳过 `CANCEL_REQUESTED`（`:642-650`）。V3 的 `totalExposure` 必须进入 pre-trade risk，不能只用于策略公式。

**修改**：`CANCEL_REQUESTED` 保留在 pending 直到 terminal；终态保留到 generation/session 结束（有界）；定义 `signedRemaining(order, instrument)` 对 OPEN 加符号、对 CLOSE 减符号并 cap 到现有仓位；Fill 先于 OrderUpdate 时创建临时 order 记录并标记 `UNKNOWN_ORDER`，不能静默丢；启动 `seedOpenOrders` 不能只依赖控制面 `openOrders`（`AeronOrderGateway.java:761-775`），控制面不可用时要能从 venue `ORDER_SNAPSHOT` 恢复，否则本地账本为空、pending 不可见。

### P1-5 Portfolio/PositionKey 缺 strategyId，多账户/多策略未决

`Portfolio` 只按 `instrumentId` 存（`Portfolio.java:17`），`netDelta`/`position`/`snapshot` 都不带 account/venue/strategy；设计 §6 的 key 是 `(venueId, accountId, instrumentId)`（`:147`），仍缺 `strategyId`。硬约束 §8 要求策略持仓/PnL/closeout 按 `strategy_id + account_id + instrument_id` 归属（`01-架构硬约束.md:268-281`）。

**影响**：同一账户多策略时会合并持仓，违反归属约束； `PortfolioDelta` 也无法区分策略。

**修改**：先裁决“一策略一 runner/一账户一 runner”；推荐保持一策略一 runner，但 key 仍包含 strategyId 以便审计/聚合；若要多策略共享 loop，必须 per-strategy Portfolio，不能共用一个 instrument map。这项决定直接影响 M2 的 API 和线程模型，不能留到 M4。

### P1-6 SimpleHedging 公式/起步/幂等仍不足

- `side = sign(R) > 0 ? SELL : BUY`（设计 `:189`）没有考虑 `delta_h` 的符号。若对冲合约是负 delta（如看跌期权），R > 0 时应该 BUY 而不是 SELL；正确写法应基于 `sign(R * delta_h)`（`side = -sign(R * delta_h)`）。
- `armed` 的初始值、`|R| > θ_open` 时启动是否立即对冲、`θ_close` 的默认值都没有定义。若 `armed=false` 启动且 `|R|` 一直大于 `θ_open`，策略永远不会对冲。
- `q = lotRound(min(maxOrderQty, |R| / |delta_h|))` 需要明确 lot size 和 0 手处理；否则 `ensureRisk` 的 lot 校验会拒单。
- 没有定义 offset：`SimpleHedgingStrategy` 默认 `OPEN`（`OrderIntent.java:21`），但减少现有 hedge 仓位时应 `CLOSE`/`CLOSE_TODAY`；CTP 的 offset 语义不能靠默认。
- 幂等键不可实现：`AeronOrderGateway.submit` 自己生成 `UUID.randomUUID()` requestId（`:318`）和 `nextClientOrderId()`（`:317`），策略无法提供稳定 `requestId`；设计说“由 clientOrderId/requestId 幂等”，但这两个值都不在策略手里。
- gateway 还有一个“同 instrument/side/offset/price 直接返回已有 id”的前置去重（`:306-315`），会吞掉合法的同价加仓/补单，和“gateway 去重只作最后防线”（`:198`）矛盾。
- `onStart`/`onStop` 仍未实现（`SimpleHedgingStrategy.java:10-55`）。

**影响**：负 delta 对冲方向可能反；启动时可能永不对冲；重复 intent 无法真正幂等；同价补单被静默吞掉。

**修改**：修正 side 公式；定义 `armed` 初始规则（启动时 `|R| > θ_open` 且 READY 则允许首笔对冲，否则等 `|R| < θ_close` 重置）；补 lot/offset/today-yesterday；给 `OrderIntent` 增加稳定 `intentId`/`requestId` 并透传到 gateway；删除或收窄 gateway 价格去重；实现 `onStart`/`onStop`。

### P1-7 没有持久账本/恢复点；dedup 文件不可靠

设计 §6 写“本地无持久账本则进 WARMUP”（`:149`），但当前 `Portfolio` 是纯内存（`Portfolio.java:17-23`），没有 WAL/事件日志/最后应用位置。`seenTrades` 是 100k 有界 LRU（`AeronOrderGateway.java:117-123`），`LinkedHashMap` 非线程安全；`checkpointSeenTrades` 在 risk 线程执行（`:930-931`、`:1206-1219`），poll 线程同时 `seenTrades.add`（`:858`），可能 `ConcurrentModificationException` 或写出损坏文件；key 只有 tradeId，没有 venue/tradingDay。

**影响**：进程重启后无法知道“从哪笔成交继续”，只能靠快照猜；跨日/超 100k 成交会重复记账；dedup 文件本身可能写坏。

**修改**：定义恢复源（WAL 或 snapshot + exec replay）和最后应用位点 `(venue, session/epoch, stream, seq, tradeId)`；dedup 移到 I/O 单线程或 copy-on-write 快照；key 加 venue/tradingDay；checkpoint 原子写；做 crash/restart 测试。

### P1-8 Registry/environment/stream 默认值仍违反 ADR-004

`VenueRegistryService` 对非 REPLAY 的 venue 一律返回 `"SHADOW"`（`backend/control-plane/.../VenueRegistryService.java:57-61`），直接违反 ADR-004 §11 “删除 mapper 硬编码 SHADOW”。`AeronOrderGateway` 的 `counterpartyId` 兜底是 `"SIM"`、`agentId/routeId` 兜底 `"legacy"`（`:196-200`）；`AeronMarketData` 的 venue 兜底是 `"*"`（`:30-32`），会订阅所有 venue 的行情；`AeronStreams.MARKET_DATA = 1001`（`:5`）且 `MarketDataPublisher(Aeron)` 默认使用它（`:14-16`），违反 ADR-004 §7 “不得回退 1001/2100/3140”。

**影响**：live venue 被标成 SHADOW；跨 venue 行情归因；漏配时静默走 1001，和冻结清单冲突。V3 说“冻结值一个都不能动”只对文档/SBE 成立，对代码默认值不成立。

**修改**：删除所有身份/stream 默认值，缺配置就 fail-closed；runner 侧增加 registry 客户端；environment 从 descriptor 来；加静态检查禁止 `1001/2100/3140` 字面量和 `"SIM"` 兜底。

### P1-9 ExecutionPort submit 结果丢失原因；OrderSink 绕过了 port

`AeronVenueExecutionPort.submit` 捕获所有异常并返回 `acceptedForPublication=false`（`:65-76`），没有 reason/retryable；实际 runner 的 `ModeAwareOrderSink` 直接调 `orderGateway.submit`（`RuntimeRunnerMain.java:499`），没有走 `VenueExecutionPort`。设计 §4 画的是 `OrderSink → VenueExecutionPort.submit`（`:68`），但迁移清单没有这一步。

**影响**：风控拒绝、Aeron backpressure、publication 断连无法区分；策略无法决定重试/告警；M0 的“runtime 不直接依赖 gateway”无法真正达成。

**修改**：`OrderSubmission` 增加 reason/retryable；所有 submit/cancel 统一走 port；runner 删除 `AeronOrderGateway` 直接调用；增加 rejection reason 指标。

### P1-10 Shutdown/drain 的 fail-stop 可能留下裸腿

设计 §9 写 drain 超时 `DRAIN_TIMEOUT` 并 fail-stop（`:221`），§12 验收 #7 写“要么 flat，要么显式失败并告警”（`:288`）。但 fail-stop 后如果还有仓位，谁来平？当前 `RuntimeRunnerMain.drain` 超时只 `log.error`（`:388`），没有控制面 handoff。硬约束 §10 要求任何单点故障不得导致裸腿无人管（`01-架构硬约束.md:302-322`）。

**影响**：drain 超时 + 进程退出 = 仓位留给人工/控制面，但设计没有定义交接协议和告警闭环。

**修改**：drain 超时后保持 reduce-only 进程存活，发 `DRAIN_TIMEOUT` 告警并交给控制面 flatten；只有 flat 或 operator 明确 ack 才退出。定义关闭顺序：先停新单/停 MD 回调，保留 exec subscription 到 terminal，最后关 publication/Aeron。

### P1-11 验收指标存在伪指标/范围错误

- 验收 #1 “grep 证明 `subscription.poll` 只出现在 `shared/aeron` 的 I/O 实现中”（`:282`）不成立：`AeronOrderGateway` 在 `runtime-runner` 里 `updateSubscription.poll/tradeSubscription.poll`（`:781-782`），`RuntimeAeronService`/`RuntimeOrderClient` 在 `runtime` 里 poll（`RuntimeAeronService.java:26-27`、`RuntimeOrderClient.java:37`）。grep 会失败，或者迫使把 execution I/O 也搬进 shared/aeron（设计没写）。
- “同一事件日志 replay 逐字节一致”（`:247`）过强：策略里仍有 `System.currentTimeMillis`、`HashMap` 迭代顺序、double 计算；除非注入确定性 clock/排序，否则无法逐字节。
- 延迟表（`:227-237`）没有定义测量点（venue eventTime vs 本地 ingress vs loop 开始）、失败率、max；`order publish 500µs` 不包含 `ensureRisk` 的 O(n) 扫描和 `indicatorGate` HTTP。
- `md_dropped_total`（`:239`）在“同合约覆盖”的语义下不是丢行情，而是“被更新值覆盖”；命名会误导告警。

**修改**：验收 #1 改为“strategy loop 不出现 `subscription.poll`”；#8 改为“同一输入日志 + 确定性 clock + 定义容差下决策一致”；延迟表加测量点/成功率和 p99.9；`md_dropped` 拆成 `md_superseded` 与 `md_lost_no_image`。

### P1-12 Runtime/Strategy SPI 缺 fill/order/position/timer 回调

`Strategy` 只有 `onMarketData/onTimer`（`Strategy.java:5-17`），`StrategyContext` 只有 portfolio/indicator/marketData/sendOrder（`StrategyContext.java:29-48`）。设计 §7 用到 `onFill/onPortfolioDelta/onOrderUpdate`、`context.exposure(deltaSet)`、`risk.allowsOpen()`、`orders.canOpen()`（`:195-197`），但没有任何接口签名。runner 当前也从不调用 `engine.onTimer`（grep 只有定义，无调用），所以 SimpleHedging 的 200ms timer 在现有 runner 里是空的。

**影响**：M2 的实现者需要自己猜 SPI；timer 触发可能“设计了但没接”。另外 `RuntimeRunnerMain.java:84-87` 在 `futures_pair` 时直接 `PairSpreadRunner.run(config)` 返回，完全绕过 V3；设计需要明确它是保留旧路径还是纳入同一事件循环，否则验收 #2 只覆盖部分策略。

**修改**：在 §5/§7 给出 `Strategy` 新增 default 方法、`StrategyContext` 新增 `orders()/risk()/exposure()` 的签名和线程契约；明确 `onTimer` 由 loop 的 100ms tick 驱动；加 SPI 兼容性测试（旧策略不实现新方法仍可运行）；明确 `futures_pair` 的迁移/排除边界。

### P1-13 Fee/multiplier 缺失使 PnL/对冲公式失真

CTP `publishTrade` 固定 `.fee(0)`（`ctp_aeron_bridge.h:544`）；runner 从未调用 `Portfolio.setMultiplier`（唯一调用点在 `Portfolio.java:65`，runner 无调用）；`Portfolio` 默认 multiplier=1.0（`:31`）。设计 §6 要求 `PortfolioDelta` 带 `fees`，§7 公式带 `multiplier_i`。

**影响**：CTP 的 PnL/费用永远是“无费用 + multiplier 1”，M4 的“回放 PnL 与手工一致”必然失败；对冲数量对非 1 multiplier 的合约也会偏。

**修改**：从 instrument metadata 读 multiplier 并设置 Portfolio；fee 从费率表/成交回报取，取不到就标记 `feeUnknown`，不要静默 0；在 M4 验收中加 fee/multiplier 用例。

### P1-14 现有 throttle/common size 与策略幂等冲突

`ModeAwareOrderSink` 的 `throttled` 在发送前就更新 `lastSent`（`RuntimeRunnerMain.java:548-560`），key 只有 instrument+side；如果 `orderGateway.submit` 因风控/backpressure 失败，3 秒内不会再试。`withCommonSize` 在发送时把 qty 改成 `size/max_size`（`:533-542`），而策略/风控是按原 qty 算的，导致实际下单量与风险检查不一致。

**影响**：对冲被拒后 3 秒不能重试；qty 被静默改写，可能超过/低于策略意图。

**修改**：throttle/cooldown 移到 loop 的策略状态，只在 `acceptedForPublication=true` 后计时钟；key 加 intent/generation；`commonSize` 在策略/risk 之前应用，或删除，保持 OrderIntent 不可变。

## 3. P2（后续优化）

1. `EventInbox.publishMd` 每 tick 做字符串拼接 key（`:139-140`），建议用稳定的 `InstrumentKey`/slot 索引，避免分配和 GC 抖动。
2. `md` map 无淘汰、无订阅 universe 上限；期权链千合约时会长期增长。建议按 subscription/generation 清理，或固定 slot 数组。
3. `dirty` 每 tick 入队一个 key，重复度高；建议 per-instrument dirty 位 + 版本号，loop 只处理 dirty 集合。
4. `CopyOnWriteArrayList` 的 sink fan-out 在 I/O 线程上逐个调用；sink 慢会拖住全部行情。建议明确 sink 必须 O(1)，或改为单 sink + 内部队列。
5. Timer 的“合并同 kind”没有定义 missed timer 语义；closeout 需要“至少触发一次”，不能因为合并而跳过。建议 timer 记录 deadline 并允许 catch-up。
6. `qf-runner-alerts` 的 `alerts` 队列容量 1000，`offer` 失败被忽略（`RuntimeRunnerMain.java:462-463`、`:519`）；告警可丢，建议计数并降级到日志。
7. `AeronStreams` 注释的区间（1000-1099、2001-2005）与 ADR-004（1000-1199、2006-2099、9001-9999）不一致；`AeronEcho` 仍用 1001，建议清理。
8. `VenueDescriptor` 的 `Set.copyOf(capabilities)` 对 null 会 NPE；建议 fail-closed 并给出明确错误。
9. `ControlPlaneVenueAccountPort.account` 的 balance 恒为 0（`:33-38`），如果后续用于保证金/权益，会误导；建议标记 unknown 或补字段。
10. `PortfolioDelta` 的 `cash/realized/fees` 是组合级还是 instrument 级不明确；建议拆成 `PositionDelta`（per instrument）和 `PortfolioSnapshot`（组合级），并定义 `version` 作用域。
11. `reportHotState` 用字符串拼 JSON（`ControlPlaneClient.java:370-383`），version/fingerprint 含引号会坏；建议用 ObjectMapper。
12. 新增 `thetaOpen/thetaClose/cooldown/lotSize/fee/multiplier/queueCapacity` 等配置项需要 schema/backward-compatible 默认值和回滚策略；当前 `DeploymentConfigLoader` 的 `config_json` 只列了少数 key。
13. `MarketDataPublisher.offer` 100 次 BusySpin 后丢样本（`MarketDataPublisher.java:60-77`）；MD 可丢，但应把 `lastResult` 和 drop 计数暴露到指标，且不要用 100 次忙等拖住发布线程。
14. `AeronMarketData` 在 fallback 成功时也更新 `lastAeronTickMs`（`:115`），会掩盖 Aeron 真实断流；V3 删除 fallback 时一并删除这个变量。

## 4. 逐项 review 结论

| # | 评审项 | 结论 | 关键证据/对应条目 |
|---|---|---|---|
| 1 | 策略层无 poll；Aeron poll 只在 I/O 层 | **部分达成** | MD poll 在 `AeronVenueMarketDataPort`；exec poll 仍在 `AeronOrderGateway`（runner）；`AeronMarketData.ticks()` 仍是 latest map pull；`RuntimeAeronService`/`RuntimeOrderClient` 是第二条 poll 路径；验收 #1 的 shared/aeron 范围错误。→ P1-11 |
| 2 | 事件顺序；跨流乱序；per-instrument sequence；成交/订单不丢 | **未达成** | Fill 先于 OrderUpdate 时未知订单；avg/realized 不可交换；`filledQty` 混用累计/增量；CTP adapter 8192 队列会丢；listener 异常被吞；CTP sequence 是全局不是 per-order；tradeId 当日唯一。→ P0-1/2/8 |
| 3 | 线程模型与单写者；publication/Portfolio/hot reload/closeout/drain/shutdown | **未达成** | gateway `orders/positions` 多写者；poll 线程重连撤单；risk 线程 removeIf；`buffer`/publication 与 shutdown hook 并发；设计未拆分 gateway。→ P0-5/6 |
| 4 | 持仓与组合 delta；启动快照+增量；pending；stale；多账户；delta 不落 venue | **方向正确，落地条件不成立** | delta 放 runtime 是对的；但 snapshot asOf/stale 伪造、PositionSnapshot 缺 today/yesterday、无 watermark、pending sign/offset 未定义、Portfolio key 缺 strategyId。→ P0-2/3，P1-4/5 |
| 5 | SimpleHedging 启动恢复、公式、重复下单、maxOrderQty/threshold | **不足** | `i≠h` 已修正；但 side 忽略 `delta_h` 符号；armed 初值/θ_close/lot/offset 未定义；无 onStart/onStop；requestId/clientOrderId 由 gateway 生成，策略无法幂等；gateway 同价去重会吞合法补单。→ P1-6，P0-4 |
| 6 | 背压/队列：行情合并、执行不丢、队列满、Aeron 反压 | **未达成** | `dirty` 无界；单 FIFO 让 Control 排在 Fill 后；I/O 线程自旋 1s；`FatalQueueOverflow` 被 listener catch；CTP 8192 丢；order publication backpressure 无重试。→ P0-1/6 |
| 7 | 恢复：Aeron 重连、sequence/epoch、gap、快照补齐、控制面不可用 | **未达成** | gap 只计数仍前向；无 MD 快照；EpochGuard/FencingGuard 未接线；控制面 lease/INACTIVE 未实现；dedup 100k LRU 非线程安全；drain 用本地账本。→ P0-3/8，P1-2/3/7/10 |
| 8 | 与 ADR-004 边界；冻结项；Ports 是否被当成已完成 | **文本未破坏冻结，但依赖被高估** | 设计没改 venueId/stream/SBE；但 Ports 的 PositionSnapshot/Snapshot/VenueSession/Descriptor 不完整，subscribePositions/health 默认 throw，runner 无 registry；代码还有 `"SIM"`、`"*"`、1001 默认值和硬编码 SHADOW。→ P0-3/8，P1-1/8 |
| 9 | 延迟预算与验收标准可测性；伪指标 | **部分可测，存在伪指标** | 无测量点/失败率；order publish 500µs 不含 ensureRisk/HTTP；验收 #1 scope 错；#8 逐字节过强；#7 fail-stop 裸腿。→ P0-7/9，P1-11 |
| 10 | 迁移顺序可执行性；是否应先完成 ADR-004 Ports | **不可执行；应先完成 Ports 的运行面语义** | M0 可用 wrapper 过；M1 count==poll 与 coalesce 矛盾；M2 在账本拆分前要求单写者；M3 no-HTTP 未覆盖全部调用；缺 ledger/recovery/fee 阶段。→ P0-10，P1-7/13 |

对第 10 项的最终建议：**M1 的事件总线/双写 shadow 可以先做**（不改路由，只做观测），但 **M2 的 StrategyEventLoop 和 M3 的 runner cutover 必须等 ADR-004 Ports 的运行面 P0 关闭**：exec ordering/epoch/no-drop、position/session snapshot 的 asOf/stale/字段、MD gap/health、runner 可用的 registry。否则 V3 会在一个语义不完整的 Port 上实现状态机，最后仍然只能用 HTTP/本地 map 兜底，等于把 V3 要消除的问题重新引入。

## 5. 必改清单（具体到设计章节/类/接口）

### 5.1 设计文档章节

- **§1 结论先行**：把“端到端绝不丢”降级/限定为“runner 入口之后 at-least-once + gap detection + reconciliation”，并列出 M0 必须补齐的 Ports 语义清单（exec ordering/epoch、position/session snapshot、MD gap/health、registry）。
- **§2 现状问题**：补上 `indicatorGate` 同步 HTTP、`AeronMarketData` HTTP fallback、`DeploymentConfigLoader` JDBC、`reportHotState` HTTP（都在主循环）；把“双持仓账本”展开为“gateway positions + Portfolio + liveFills 三路”。
- **§4 线程模型**：明确 gateway 拆分（I/O-only vs loop book）；`qf-order-events` 不得 publish/cancel；增加独立 control 队列；`qf-strategy-loop` 禁止任何阻塞调用（含 JDBC/MyBatis/文件 IO）。
- **§5 事件模型**：
  - `Gap` 增加 `sourceSessionId/sourcePublicationEpoch/exchange`（以及 scope 的 `tradingDay` 如适用）。
  - `Control` 独立队列/优先通道，不能与 Fill 共用 FIFO。
  - `publishExec` 去掉 1s 自旋；定义进程级 fatal handler。
  - 明确 Fill/OrderUpdate 的合并规则：`filledQty = max(cumulative, sum(tradeId))`；未知 order 的 Fill 必须建临时记录。
  - 明确 MD 是 lossless `MdEvent` 还是 latest quote；两者分开命名。
- **§6 持仓与 delta**：
  - `PositionKey` 增加 `strategyId`（或明确一策略一进程 + 仍保留审计字段）。
  - 增加 snapshot watermark：`(snapshotId/asOf/version)` 与 Fill 的应用顺序。
  - 增加本地持久账本/WAL 与 last-applied event point。
  - `signedRemaining` 定义 OPEN/CLOSE/CLOSE_TODAY/CLOSE_YESTERDAY 的符号、cap 和 CANCEL_REQUESTED 保留规则。
  - `PortfolioDelta` 拆分为 `PositionDelta` + `PortfolioSnapshot`，或明确组合级字段语义。
- **§7 SimpleHedging**：
  - `side = -sign(R * delta_h)`；`q = lotRound(min(maxOrderQty, |R|/|delta_h|), lot)`。
  - 定义 `armed` 初值、启动首笔对冲规则、`θ_close`、cooldown。
  - 定义 offset/today-yesterday；定义稳定 `intentId/requestId` 并透传。
  - 删除 gateway 同价去重或明确只作“同 requestId 重试”的去重。
- **§8 恢复**：
  - 区分 stale duplicate vs real old-epoch Fill：Fill 必须进账本，epoch 只限制命令/回调。
  - 接入 `EpochGuard`/`FencingGuard`；明确重连 cancel 由 loop 执行。
  - 增加 MD snapshot/baseline 方案；明确 consumer 重启首个 seq 的策略。
  - 增加控制面 lease/INACTIVE 的实现位置和超时值。
- **§9 生命周期**：
  - hot reload 增加“旧 generation working orders 撤销/转移 + 等 terminal”。
  - `onStart(snapshot)` 定义 snapshot 字段。
  - shutdown/drain 定义 fail-stop 后的控制面 handoff、关闭顺序、operator ack。
- **§10 观测与测试**：
  - 定义每个延迟指标的起点/终点（本地 ingress 用 `System.nanoTime`）、成功率、p99.9。
  - 验收 #1 改为“strategy loop 无 `subscription.poll`”；#8 改为确定性 clock + 容差；#7 增加 handoff。
  - 增加 `exec_dropped_total`、`orphan_fill_total`、`md_superseded`、`md_lost_no_image`。
- **§11 迁移顺序**：按 P0-10 重排；M0 拆成“Port 契约/字段”和“单账本/删除 gateway 账本”；M1 计数改为 ingress/accepted/duplicate/gap/dropped；M3 补全所有 loop HTTP/JDBC 移除；新增 fee/multiplier 与 recovery 阶段。

### 5.2 类/接口

- `VenuePorts.PositionSnapshot`：补 todayLong/todayShort/yesterdayLong/yesterdayShort/longAvgPrice/shortAvgPrice/settlementPrice/tradingDay/snapshotId/asOf。
- `VenuePorts.Snapshot`：补 `staleAfterMs/tradingDay/snapshotId/source`；`stale` 必须来自 venue/控制面，不是本地推断。
- `VenuePorts.VenueSession`：补 loginState/settlementState/leaseExpiry/lastSeqByStream/adapterSessionId/reason。
- `VenuePorts.VenueDescriptor`：补 exchange[]/channels/streams/snapshotSources/healthSource/reconciliationMode/writerRole。
- `VenuePorts.VenueMarketDataPort`：增加 gap/health 回调或 `MarketDataEvent` union；明确 gap 后抑制到 reset。
- `VenuePorts.VenueExecutionPort`：`OrderSubmission/CancelSubmission` 增加 reason/retryable；`subscribe` 支持 strategy/deployment scope；明确 ordering/epoch 契约。
- `VenuePorts.VenueAccountPort`：`subscribePositions` 要么实现，要么在接口层显式声明 `supportsPositionStream()`，并让 runtime 走 snapshot-only + WARMUP。
- `ControlPlaneVenueAccountPort`：去掉 `Instant.now()` 伪造；透传真实 asOf/stale；补 today/yesterday；失败时返回空 + stale，不能返回“成功但 0 仓”。
- `AeronVenueExecutionPort`：增加 sequence/epoch/generation 过滤；`submit` 返回结构化 reason；不要把异常吞成 false。
- `AeronOrderGateway`：拆成 `AeronExecutionIo`（decode/dedup/seq/epoch）和 `OrderBookView`/`PositionKeeper`（loop）；删除 `positions` 写路径；重连 cancel/对账 remove 改为 Control。
- `AeronMarketData`：删除 HTTP fallback；`latest` map 只作为 `LatestQuote`，不要把 `ticks()` 当事件源。
- `RuntimeRunnerMain`：删除 loop 内的 `DeploymentConfigLoader.load`、`reportHotState`、`indicatorGate` 间接调用；shutdown hook 只投 Control；drain 改为 loop 状态机。
- `Portfolio`：key 改为 `PositionKey(venueId, accountId, strategyId, instrumentId)`（或明确 per-runner 但保留字段）；补 pending/exposure API；补 setMultiplier 的 runner 接线。
- `Strategy` / `StrategyContext`：增加 `onFill/onOrderUpdate/onPosition/onPortfolioDelta` default 方法；增加 `orders()/risk()/exposure(deltaSet)`；`RuntimeEngine` 增加 fill/order/position 入口并在 runner 调用 `onTimer`。
- `SimpleHedgingStrategy`：实现 `onStart/onStop/onTimer/onFill/onOrderUpdate`；修正 side/q；使用 `context.exposure`；加 armed/cooldown/offset。
- `RunnerMetrics`：增加 `exec_dropped_total`、`orphan_fill_total`、`md_superseded`、`md_lost_no_image`、`decision_rejected_total`；延迟指标记录本地 ingress 时间。

## 6. 开放问题

1. **多账户/多策略的进程模型**：一策略一 runner，还是一账户一 loop 多策略？这决定 `Portfolio` key、publication 数量、单写者边界；设计现在把这个问题留到 §12，但 M2 的 API 已经依赖它。
2. **权威执行账本是什么**：Aeron exec stream + 本地 WAL，还是控制面 DB + 快照？重启后的 last-applied event point 存在哪里？如果两者都不是，drain 的 flat 只能靠猜。
3. **CTP adapter 能否保证 exec 不丢**：`kMaxOutbound=8192` 是硬限制；是否允许改成阻塞/磁盘 spool？如果不改，V3 只能承诺“可检测丢失 + 对账”，不能承诺“绝不丢”。
4. **每 instrument 的成交全序从哪来**：CTP TradeID 当日唯一但没有排序语义；是否有 venue 序列/ExchangeTradeID？没有的话，avgPrice 只能从快照重算，策略不能依赖成交顺序。
5. **哪些消费者需要 lossless tick**：EMA/bar/volume 需要；只报价的策略可能不需要。这个分类决定 MD coalescer 的边界和 replay 等价性。
6. **`environment` 的真实来源**：`VenueRegistryService` 现在非 REPLAY 一律 SHADOW；V3 的 live/shadow 门禁、fencing、告警是否会被这个值误导？
7. **drain 超时的责任边界**：runner fail-stop 后，控制面是否具备 flatten 能力？谁确认 flat？如果控制面也不可用，是否允许保留 reduce-only 进程？
8. **`PortfolioDelta` 的 scope**：per instrument 还是 per portfolio？`cash/realized/fees` 是累计还是增量？`version` 是全局还是 per instrument？策略幂等依赖这个定义。
9. **`PortfolioDelta.realized` 是否分账户**：设计 §12 已提出；如果多账户共享 loop，必须分账户，否则策略无法做账户级风控。
10. **M0 的“conformance 绿”具体包含什么**：是否包含 V-04（session/epoch 切换）、V-06（cancel fencing）、V-09（snapshot stale）、V-11（同 stream 两 venue 不交叉归因）？当前 M0 只写“conformance 绿”，不足以证明 V3 依赖的 Ports 语义。

## 7. 评审边界与未验证项

- 本次只读评审设计稿、ADR-004、冻结清单、venue-contract、历史评审、T-060/T-061 状态、runtime/runtime-runner/shared-aeron 相关代码和 CTP adapter 的 `ctp_aeron_bridge.h`；未修改设计稿或代码，未执行构建/测试/回放。
- 未完整审：全部 C++ CTP session 细节、SimVenue/Replay adapter 的全部 envelope 路径、控制面 DB 迁移、前端、生产 190 环境。
- 结论基于当前工作区代码和上述设计 hash；设计稿在评审期间发生过一次更新，若继续变化，需要以新 hash 重新核对 P0/P1。
- 历史评审 `2026-11-12-adr-004-venue-review.md` 已标注为历史文档；ADR-004 的 `APPROVED` 只代表契约冻结，不代表 Ports/runner 已接入（ADR-004 `:5`、T-061 `:434-435`）。本评审不把该历史文档的 OPEN 当作今天的最终状态，但也不把 Ports 当成已完成。

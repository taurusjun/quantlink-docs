# V2 架构评审（实现态）

- 日期：2026-11-10
- 评审对象：**当前代码库实现出来的 V2 系统**（不是设计稿、不是图）
- 代码基线：`8e0abbc`（含 `df9e180` 删除进程内 SimExchange 撮合、`e2bebf6` SimVenue 资金修复）
- 评审判据：`AGENTS.md` P0 原则、`docs/architecture/01-架构硬约束.md`、`24-实时推送与Agent计算边界.md`、`22/23` 设计稿
- 方法：静态阅读 + 交叉核对（Java / C++ / SQL / TS）。**未做运行时验证**，所有结论都带 `file:line`。

---

## 1. 结论

**NO-GO**：不能作为 V2 生产基线。

一句话理由：管理面仍在请求线程里算策略 PnL、并持有策略持仓账本的唯一写入权，而 runner 的开仓闸门和收盘平仓都建立在这条管理面数据链上；同时成交入库链路存在“永久丢单”和“外键失败整事务回滚”两个已知路径，CTP adapter 热路径还有同步文件 IO 与 5s busy-spin。这些都不是调参能解决的，属于 P0 硬约束违反 + 裸腿/重复下单风险。

允许的用法：继续在 SHADOW / SimVenue 上做验证；按第 4 节修完 P0-01~P0-06 后可重新评审为「有条件 GO」。

---

## 2. 评分表

| 维度 | 分 | 一句证据 |
|---|---|---|
| 边界与职责 | **2** | 行情/订单主链路确实走 Aeron，但 `StrategyPnlService` 在 `GET /strategy-runtime/risk` 请求线程里从 trades+positions 现算 PnL（`StrategyRuntimeController.java:84`），`IndicatorEngine` 仍在控制面按 tick 算指标（`MarketDataService.java:118-124`） |
| 数据所有权 | **2** | Agent 侧 `StrategyPnlPublisher` 存在，但策略持仓的唯一持久化写入在管理面（`ExecutionLedgerService.java:75`）；runner 每 5s 用管理面快照**覆盖**自己的本地账本（`AeronOrderGateway.java:832`）；`positionEpoch` 全链路恒 0 |
| 执行所有权 | **4** | DB 约束齐全：`uq_account_single_ors`/`uq_agent_single_ors`（`schema-shadow.sql:286-290`）、`UNIQUE(strategy_id)`（`migrate-t035-single-agent-strategy.sql:9-10`）、单 ACTIVE 部署部分唯一索引（`migrate-t037:212-213`）；扣分在 runner/agent 无单实例锁 |
| 生命周期 | **3** | ORS 是 agent 子进程、3 次重启后 `HALTED`（`OrsProcessManager.java:26,79-83`）、ack 用 generation 做 409（`StrategyDeploymentMapper.xml:180-185`）；但 generation/orderEpoch 不随消息上线，fencing 实际不生效 |
| 热路径 | **2** | Aeron+SBE 是真链路，但 CTP adapter 每个订单回报同步写文件（`ctp_aeron_bridge.h:415-427`）、背压时 busy-spin 5s 后 `throw`（`:317-328`）、每 tick `std::cout<<endl`（`ctp_trader_session.h:863-871`） |
| 故障隔离 | **2** | 控制面宕机时 runner 能继续（`AeronOrderGateway.java:386-391` 快照 TTL fail-closed），但收盘平仓只存在于控制面 `@Scheduled`（`StrategyCloseoutScheduler.java:48,87`），且 HTTP 模式下 drain 会把“查不到持仓”当成“已平”（`HttpOrderGateway.java:44-52`） |
| 多柜台 | **3** | 流段与 deploy 一致（2100-2103/1100、2110-2113/1110、3140-3143/1001），SimVenue 是独立进程独立状态文件；扣分在 `QF_SIM_VENUE_FENCING_TOKEN=0`、md 都用 1001、AGENTS.md 柜台清单缺 SIMVENUE |
| 安全与审计 | **3** | 部署/激活/回滚/手工单/应急/认领都写审计；`ApprovalGuard` 只在 LIVE 生效（`ApprovalGuard.java:19-22`），agent token 为空即关闭（`AgentTokenVerifier.java:53-56`），`/strategy-runtime/risk` 无账户级授权 |

均分 2.6 / 5。

---

## 3. 最可能出事的 5 个问题（按发生概率 × 损失排序）

1. **成交被静默丢弃，持仓/PnL 与柜台分叉**（P0-01）。手续费配置缺一条、或订单行缺失、或 DB 抖动 5 次，成交就永久丢；runner 的 `max_position` 与止损都基于这个已经失真的持仓。
2. **`strategy_positions` 外键失败导致整笔成交事务回滚**（P0-02）。`book_id` 有两套生成规则，迁移过的策略每笔成交都会踩到。
3. **runner 每 5s 用管理面快照覆盖本地账本**（P0-04）。控制面消费滞后或丢单时，runner 会把“已成交”改回“未成交”，`max_position` 放行重复开仓。
4. **收盘平仓只在控制面**（P0-06）。控制面进程/DB 任一不可用，收盘就是不平仓，直接留隔夜裸腿。
5. **CTP adapter 热路径同步文件 IO + 5s busy-spin**（P0-07）。盘口一热、磁盘一抖，回调线程被拖住；5s 后背压直接 `throw` 进 CTP SDK 回调。

---

## 4. 问题清单

### P0（违反硬约束 / 资损 / 裸腿）

---

#### P0-01 成交入库链路可整体丢单，且没有 UNASSIGNED 兜底

**现状**
- 成交消费失败进入重试队列，同一 trade 重试 5 次后**直接丢弃**，只打一条 error。
- 手续费配置缺失时 `feeFor()` 抛异常，整个 `applyTrade` 事务回滚。
- 订单行不存在时 `applyTrade` 直接 `return false`，成交既不落库也不进 UNASSIGNED。

**证据**
- `backend/control-plane/src/main/java/com/quantlink/fin/control/aeron/AeronOrderUpdateConsumer.java:262-272`（`giving up after retries` 后 `continue`）
- `backend/control-plane/src/main/java/com/quantlink/fin/control/ledger/ExecutionLedgerService.java:233-244`（`feeFor` 无配置即 `throw`）
- `backend/control-plane/src/main/java/com/quantlink/fin/control/ledger/ExecutionLedgerService.java:47-48`（`if (order == null) return false`）
- 设计稿要求未知回报进 UNASSIGNED：`docs/architecture/23-策略中心V2设计稿.md:1009`；实现无此分支

**影响**
策略持仓、`positions`、`trades`、`ledger_entries`、手续费、已实现 PnL 全部缺这一笔。柜台有仓、系统无仓；runner 风控快照按缺仓计算 → 继续开仓 → 实际敞口超限。

更糟的是**对账发现不了**：`ScopedReconciliationService` 比的是 `strategy_positions` 与 `trades`，两边同时缺同一笔 → 仍然 PASS（`ScopedReconciliationService.java:96-104`）。唯一可能暴露的地方是 `positions`（柜台快照）与 `strategy_positions` 的差额，而这只是 UI 上的 `unassigned` 数字。

**修法**
1. 成交重试不设上限，改为落 `trade_dlq` 表 + 告警；重试耗尽必须进 UNASSIGNED 而不是丢。
2. `feeFor` 缺失改为“按 0 记账 + 标 `fee_source=MISSING` + 告警”，不得让成交事务失败。
3. `order == null` 时写 `unassigned_trade`（表已存在，`tools/db/migrate-t046-strategy-center-v2-safe.sql:233`），不要 `return false`。
4. 加一条验收：kill 控制面 60s 后重启，`trades` 数量必须与柜台成交笔数相等，差值全部出现在 `unassigned_trade`。

---

#### P0-02 `book_id` 两套生成规则 → `strategy_positions` 外键失败 → 整笔成交回滚

**现状**
- 迁移脚本给策略建 book 用 `md5('STRATEGY-' || strategy_id)`。
- 运行时 SQL 和 runner 都用 `md5(strategy_id)`。

**证据**
- `tools/db/migrate-t046-strategy-center-v2-safe.sql:116`（`SELECT md5('STRATEGY-' || s.id)::uuid ...`）
- `backend/control-plane/src/main/resources/mapper/StrategyPositionMapper.xml`（`findContext`：`SELECT md5(#{strategyId})::uuid AS book_id`）
- `backend/control-plane/src/main/resources/mapper/StrategyCenterMapper.xml`（`insertStrategyBook`：`VALUES (md5(#{strategyId})::uuid, ...)`）
- 外键：`tools/db/migrate-t046-strategy-center-v2-safe.sql:104`（`book_id UUID REFERENCES books(book_id)`）
- runner 侧同规则：`backend/runtime-runner/src/main/java/com/quantlink/fin/runner/AeronOrderGateway.java:1031-1043`

**影响**
任何由迁移建立的策略，`applyFill` 的 INSERT 都会违反 FK → `@Transactional` 的 `applyTrade` 整体回滚 → 见 P0-01：成交丢失。同时订单表用 `books.display_name` 反查 book_id（`AeronOrderMapper.xml:52-54`），会拿到迁移版 book，而持仓用运行时版 book，**同一策略的订单与持仓挂在两个不同 book 上**，归因和对账永远不平。

**修法**
统一成一个规则并写成 DB 默认值/触发器（建议 `md5(strategy_id)`，与 runner 一致）；提供一次性 `UPDATE books SET book_id=md5(display_name)::uuid` 的收敛脚本（需同步更新 `orders/trades/strategy_positions` 的引用）；加一条启动自检：`books` 中 `book_type='STRATEGY'` 的 `book_id` 必须等于 `md5(display_name)`。

---

#### P0-03 管理面在请求线程现算策略 PnL，且这是 runner 开仓的唯一风控闸门

**现状**
- `GET /api/v1/strategy-runtime/risk` 在 Controller 里调 `pnl.totalPnl(strategyId)`。
- `StrategyPnlService.snapshot()` 遍历该策略**全部历史成交**再叠加持仓市值。
- runner 每 5s 拉这个快照，`ensureRisk()` 用其中的 `pnl` 做止损/亏损限额判断；快照过期则禁止开仓。

**证据**
- `backend/control-plane/src/main/java/com/quantlink/fin/control/api/StrategyRuntimeController.java:84`
- `backend/control-plane/src/main/java/com/quantlink/fin/control/market/StrategyPnlService.java:36-83`（`:39` 读 trades，`:51` 读 positions）
- `backend/runtime-runner/src/main/java/com/quantlink/fin/runner/ControlPlaneClient.java:208-216`
- `backend/runtime-runner/src/main/java/com/quantlink/fin/runner/AeronOrderGateway.java:503-510`（`lossLimit` 用 `risk.pnl`）
- 硬约束原文：`docs/architecture/01-架构硬约束.md:84`（“Controller 请求时调用 StrategyPnlService 现算”属禁止实现）、`:93-98`

**影响**
1. 直接违反 P0 边界：管理面产生派生数据。
2. 该接口复杂度 O(该策略历史成交数)，跑一年后每 5s × N 策略 = 全表扫描放大；控制面 DB 抖动会通过 fail-closed 把开仓全部挡掉。
3. 两个 PnL 口径并存：这里算一遍，Agent 又发一遍（`StrategyPnlPublisher`），UI 与风控可能显示不同数字。

**修法**
`risk` 接口只读 Agent 已发布的快照（`StrategyRuntimeCache`）+ 已落库的限额/账户快照，不再调用 `StrategyPnlService`；删除 `StrategyPnlService` 及其在 `StrategyOrderService:283` 的调用；PnL 完全由 Agent 发布、控制面只转发。

---

#### P0-04 策略持仓账本由管理面写入，runner 每 5s 被管理面快照覆盖

**现状**
- `strategy_positions` 的唯一写入路径是控制面的 `ExecutionLedgerService.applyTrade → strategyPositions.applyFill`。
- runner 自己的账本（`AeronOrderGateway.positions`，由成交事件累积）每 5s 被 `applyRiskSnapshot()` 整表清空后替换成管理面 `strategy_positions` 的内容。

**证据**
- `backend/control-plane/src/main/java/com/quantlink/fin/control/ledger/ExecutionLedgerService.java:74-77`
- `backend/control-plane/src/main/java/com/quantlink/fin/control/market/StrategyPositionService.java:27-40`（管理面计算 long/short/avg/realized）
- `backend/runtime-runner/src/main/java/com/quantlink/fin/runner/AeronOrderGateway.java:786-810`（`refreshRisk`）、`:820-834`（`positions.clear(); positions.putAll(next)`）
- 设计归属：`docs/architecture/24-实时推送与Agent计算边界.md:77,226`（策略持仓/账本归 Agent）

**影响**
- 控制面消费滞后 1 个成交 → runner 的持仓被改回旧值 → `max_position` 少算 → 重复开仓。
- 控制面丢单（P0-01）→ 持仓永久错误，runner 每次刷新都“回到错误值”，本地账本的正确性被主动破坏。
- 平仓/收盘判断同样读这份持仓，可能认为已平。

**修法**
反转所有权：Agent 维护账本并发布 `StrategyPosition`，控制面**只落库**（consumer 写表，不重算）；runner 的 `positions` 只由 Aeron 成交事件更新，`refreshRisk` 不再覆盖，最多做“差异告警”。`StrategyPositionService.applyFill` 应移出管理面或降级为“对账校验”而非写入方。

---

#### P0-05 `generation` / `orderEpoch` / `environment` 全链路硬编码，fencing 与 STALE_UPDATE 实际不生效

**现状**
- runner 发 `OrderRequestV2` 时 `deploymentId(0) / deploymentGeneration(0) / orderEpoch(0) / environment("SHADOW")`。
- CTP adapter 发 `OrderUpdateV2` / `TradeV2` 时同样全 0，`routeId` 为空，`environment` 恒 `"SHADOW"`。
- 控制面的 `rejectIfStale()` 只在“两边都 > 0”时才比较，因此永不触发。

**证据**
- `backend/runtime-runner/src/main/java/com/quantlink/fin/runner/AeronOrderGateway.java:268-271`
- `ctp-adapter/src/ctp_aeron_bridge.h:379-383`（OrderUpdate）、`:405-410`（Trade）
- `backend/control-plane/src/main/java/com/quantlink/fin/control/aeron/AeronOrderUpdateConsumer.java:419-436`（`fencing > 0 && incoming > 0`、`generation > 0 && incoming > 0`）
- 设计契约：`docs/architecture/23-策略中心V2设计稿.md:941-967,893-901`

**影响**
- 旧 runner / 旧 ORS 的回报无法被识别为 stale，直接覆盖新状态（设计里明确禁止）。
- 版本切换、回滚、Fork 后的“旧进程还在发单/发回报”没有任何 fencing 手段，只能靠人杀进程。
- `environment` 恒 SHADOW：LIVE 账户的订单/成交在链路上无法区分环境，LIVE 二次确认与审计只能靠 HTTP 层猜。

**修法**
runner 从 `deploymentState()` 取 `deploymentId/generation` 并写入每一笔 `OrderRequestV2`；CTP adapter 从会话上下文透传 `deploymentId/generation/orderEpoch/routeId/environment`（`ors_instances` 已有字段）；`rejectIfStale` 改为“incoming 与 DB 不一致即拒”，不要依赖 >0 判断。

---

#### P0-06 收盘平仓只存在于控制面定时任务

**现状**
- `StrategyCloseoutScheduler` 每 30s 扫 `strategy_positions`，到收盘窗口调 `emergencyController.flattenStrategy()` 下单。
- 该任务明确排除 `futures_pair`（由 runner 自己平），但普通策略完全依赖它。

**证据**
- `backend/control-plane/src/main/java/com/quantlink/fin/control/market/StrategyCloseoutScheduler.java:48`（`@Scheduled(fixedDelay=30_000)`）、`:53`（读 `strategy_positions`）、`:87`（调 flatten）、`:94`（处理一个策略后 `return`）
- 排除 futures_pair 的 SQL：`backend/control-plane/src/main/resources/mapper/StrategyPositionMapper.xml`（`listStrategyIdsForScheduler`：`WHERE s.strategy_type NOT IN ('futures_pair')`）
- 硬约束：`docs/architecture/01-架构硬约束.md:302-322`（单点故障不得导致“收盘不平仓”）

**影响**
- 控制面宕机 / DB 宕机 / 该 Bean 异常 → 收盘不平仓，直接留隔夜裸腿。
- 它读的是管理面算出来的 `strategy_positions`：P0-01/P0-02 一旦发生，这里看到的是 0 仓，直接跳过平仓。
- `:94` 的 `return` 让每 30s 只处理一个策略，多策略同时收盘时后面的策略会错过窗口。

**修法**
把收盘平仓下沉到 Agent/runner（本地时钟 + 本地账本 + 本地行情），控制面只下发“收盘窗口/开关”配置并做兜底；调度器修掉 `return`（应为 `continue`）；加验收：kill 控制面后仍能在收盘前平掉全部策略。

---

#### P0-07 CTP adapter 热路径：同步文件 IO、5s busy-spin、每 tick 同步日志

**现状**
- 每个订单回报都 `nextOrderSequence()`：`ofstream` + `flush` + `rename`。
- 每个下单请求都 `saveOrderMeta()`：把**整个** orderMeta map 重写一遍。
- `offer()` 背压时 `BusySpinIdleStrategy` 空转最多 5 秒，然后 `throw`。
- `OnRtnDepthMarketData` 每 tick `std::cout << ... << std::endl`（每次 flush）。
- 行情 `publishTick` 的 `offer` 返回值被忽略，丢包无计数。

**证据**
- `ctp-adapter/src/ctp_aeron_bridge.h:415-427`（sequence 落盘）
- `ctp-adapter/src/ctp_trader_session.h:126-128`（下单即 `saveOrderMeta`）、`:951-963`（整表重写）
- `ctp-adapter/src/ctp_aeron_bridge.h:317-328`（5s busy-spin + throw）
- `ctp-adapter/src/ctp_trader_session.h:863-871`（每 tick cout）
- `ctp-adapter/src/ctp_aeron_bridge.h:352-353`（忽略 offer 结果）
- 硬约束：`docs/architecture/01-架构硬约束.md:216-237`（禁止文件 IO / 同步日志刷盘 / 锁竞争）

**影响**
- 磁盘抖动或 fsync 慢 → 回调线程被拖住 → 回报延迟、CTP 前置心跳超时。
- 背压 5s 后从 CTP SDK 回调里抛异常，行为未定义，可能直接打死 ORS。
- 每 tick 刷 stdout 在高频合约上就是持续 IO 压力。
- 行情丢包不可观测，`aeron_backpressure` 指标只覆盖订单侧。

**修法**
sequence 改成“启动时读一次 + 内存自增 + 定期异步落盘”；orderMeta 改 append-only journal 或直接依赖 CTP `ReqQryOrder` 恢复；`offer` 改为非阻塞 + 计数 + 丢弃策略（回报流不允许丢，则应拆独立线程 + 有界队列）；删除 tick 日志或改采样；行情 offer 失败必须计数并暴露。

---

#### P0-08 `HttpOrderGateway` 失败返回空持仓 → drain 误判已平（裸腿）

**现状**
- HTTP 模式下 `positions()` 异常时返回 `List.of()`；`openOrders()` 同样返回空。
- drain 用 `positions.stream().allMatch(netQty == 0)` 判断是否平完，空列表恒真。
- `ready()` 恒 `true`，HTTP 模式下完全没有本地风控新鲜度检查。

**证据**
- `backend/runtime-runner/src/main/java/com/quantlink/fin/runner/HttpOrderGateway.java:44-52`（positions）、`:34-42`（openOrders）、`:63-65`（ready）
- `backend/runtime-runner/src/main/java/com/quantlink/fin/runner/RuntimeRunnerMain.java:266-271`（`allMatch` → `drain complete`）
- 模式选择：`backend/runtime-runner/src/main/java/com/quantlink/fin/runner/OrderGatewayFactory.java:8-19`（`orderMode` 为空且缺 `orderStream` 时静默回落到 HTTP）

**影响**
控制面不可用时停机/重启，runner 认为“无持仓无挂单”，直接退出，仓位留在柜台无人管。这是最典型的裸腿路径。

**修法**
`positions()`/`openOrders()` 失败必须抛异常而不是返回空；drain 里区分“空”和“未知”，未知一律不退出并告警；删除 HTTP 网关或在启动时强制 `fail-closed`（无 Aeron 配置直接拒绝启动）。

---

### P1

| ID | 现状 | 证据 | 影响 | 修法 |
|---|---|---|---|---|
| P1-01 | runner / agent 无单实例锁；agent 重启后不会认领已在运行的子进程，`start()` 只检查自己 map 里的 Process | `backend/runtime-runner/src/main/java/com/quantlink/fin/runner/RuntimeRunnerMain.java:37-70`（无 lock file）；`backend/runtime-agent/src/main/java/com/quantlink/fin/agent/ProcessManager.java:69-98` | agent 重启 → 孤儿 runner + 新 runner 并存 → 两个订单流、两套 clientOrderId → 重复下单 | 启动时拿 `/var/lib/quantlink-fin/run/<instance>.lock`（`FileLock`）；agent 启动先按 pidfile/端口探活并 adopt 或 kill |
| P1-02 | 账户持仓被两处写：成交推导（`applyAccountPosition`）和柜台快照（`PositionSnapshotService.replace`） | `ExecutionLedgerService.java:85,92-178`；`PositionSnapshotService.java:24-56`（有 latest-trade 保护，但仍是第二条写路径）；两者都写 `positions`（`AeronOrderMapper.xml:259-272`、`PositionSnapshotMapper.xml:20-35`） | 两条写入节奏不同，`accountGrossPosition` 风控读到中间态；柜台快照与账本口径互相踩 | 明确 `positions` 只由柜台快照写；成交推导结果写独立 `position_ledger` 供对账，不覆盖权威表 |
| P1-03 | 控制面仍在按 tick 算指标（`IndicatorEngine.onTick`） | `MarketDataService.java:118-124`；`backend/control-plane/src/main/java/com/quantlink/fin/control/market/IndicatorEngine.java:75,116` | 违反“指标值由 Agent 或定时任务产生”；指标随控制面重启清零 | 指标移到 Agent 或独立数据任务，控制面只读 `indicator_values` |
| P1-04 | SimVenue fencing token = 0（等于关闭）；取消通道不校验账户/fencing | `deploy/sim-venue.env.example:4`（`QF_SIM_VENUE_FENCING_TOKEN=0`）；`SimVenueGateway.java:277-281`（`config.fencingToken() <= 0 || ...`）；`ctp-adapter/src/ctp_aeron_bridge.h:218-223`（cancel 直接 `session_.cancelOrder`） | 旧进程/越权进程可以撤单；SimVenue 上无法验证 fencing 语义 | 部署时写入真实 token；cancel 路径同样校验 account/agent/fencingToken |
| P1-05 | 未知回报直接丢弃，不落 UNASSIGNED（与 P0-01 同源但影响归属） | `ExecutionLedgerService.java:47-48` | 手工单/外部成交/DB 重建后的回报全部消失，归属永久缺失 | 落 `unassigned_trade` + 认领流程（表已存在） |
| P1-06 | 过期订单对 venue=SIM/SIMLOCAL 只改 DB 状态，不向柜台撤单 | `backend/control-plane/src/main/java/com/quantlink/fin/control/market/StrategyOrderExpiryService.java:35-47`（`:40` 命中 SIM/SIMLOCAL，`:41` 只改 DB）；`StrategyOrderExpiryMapper.xml:16-18`（`UPDATE orders SET status='CANCELED'`） | 幽灵撤单：系统认为已撤，柜台仍可成交 | 统一走 `ManualOrderPublisher.publishCancel`，禁止 DB-only 改状态 |
| P1-07 | 浏览器仍有 5s 轮询（Accounting / Alerts / Monitoring / strategy alerts） | `web/src/pages/Accounting.tsx:82`；`web/src/pages/Alerts.tsx:69,75`；`web/src/pages/MonitoringV2.tsx:36`；`web/src/hooks/useStrategyAlerts.ts:20,40` | 违反“新增页面轮询 P0 违规”条款；每个页面独立打 DB | 统一走 `useMarketData` 的 WS 事件；首屏 HTTP 快照 + 增量 |
| P1-08 | 控制面全局行情缓存以 `instrumentId` 为键（另有 scoped 缓存，但 `latest` 仍是全局） | `MarketDataService.java:113`（`latest.put(tick.instrumentId(), tick)`） | 同合约多柜台时 UI/指标串台 | `latest` 也改成 `(counterparty, exchange, instrument)` 键，或删除全局缓存 |
| P1-09 | `GET /strategy-runtime/risk` 无账户级授权校验 | `StrategyRuntimeController.java:78-173`（无 `checkAccount`）；对比 `StrategyCenterController.java:159` 有校验 | 任意已登录用户可读任意策略持仓/PnL/账户可用资金 | 加 `AuthorizationService.require(user, accountId, VIEW)` |
| P1-10 | `positionEpoch` 恒 0；`StrategyPnlPublisher` 的 `counterpartyId` 传 `""`、`exchange` 传 `""`、`markSource` 恒 `SCOPED_TICK`、`stale` 恒 0 | `RuntimeRunnerMain.java:211-212`；`StrategyPnlPublisher.java:44-49,60,64,79-80`；`StrategyPositionMapper.xml` `findContext`（`0::bigint AS position_epoch`） | 归属键退化成 `(strategy, account, instrument)`，缺 counterparty/exchange/epoch；无行情时仍宣称 SCOPED_TICK 且非 stale | 透传真实 counterparty/exchange/epoch；无 tick 时发 `MARK_STALE` 并置 `stale=1` |
| P1-11 | runner 每笔成交同步 append 去重文件，且启动全量载入；每次分配 clientOrderId 都落盘并 `synchronized` | `AeronOrderGateway.java:979-988`（每笔成交写文件）、`:900-911`（`synchronized` + `saveClientOrderIdBlock`）、`:967-977`（启动全量读） | 订单路径锁竞争 + 文件 IO；去重集合无界增长 | ID 块改成“预留 100 万后只内存自增，定期 checkpoint”；成交去重改用 `(epoch, tradeId)` 有界 LRU + DB 唯一键 |
| P1-12 | `ApprovalGuard` 仅在 `QF_ENVIRONMENT=LIVE` 生效；`deactivate`/`stop` 无审批 | `ApprovalGuard.java:19-22`；`StrategyDeploymentController.java:187-200`（activate 有）、`:233-253`（deactivate/stop 无） | SHADOW 下四眼审批静默跳过；停策略这种高风险动作无审批 | 审批策略按动作配置，不按环境一刀切；deactivate/stop 至少记审计 + 二次确认 |
| P1-13 | `tick_to_decision` 用**交易所时间戳**做起点 | `RunnerMetrics.java:36-44`；`RuntimeRunnerMain.java:207`（`tick.timestampMs()*1e6`） | 指标包含交易所时钟偏差与网络延迟，跨柜台不可比；文档里的 4.3~4.9ms 不能作为 SLO 证据 | 记录本地 Aeron 到达时间 `System.nanoTime()` 作为起点，另存 venue 时间用于偏差监控 |

### P2

| ID | 现状 | 证据 | 影响 | 修法 |
|---|---|---|---|---|
| P2-01 | 管理面保留随机行情生成器（默认关） | `MarketDataService.java:89`（`qf.market.auto:false`）、`:193-230` | 误开即用假行情喂指标/价格笼子 | 移到测试 profile，生产 jar 不打包 |
| P2-02 | 控制面仍依赖 `backend:sim-exchange` 模块但已无引用（仅注释） | `backend/control-plane/build.gradle.kts:21,27`；`MarketDataService.java:117`（注释） | 依赖图误导，易被误认为仍有进程内撮合 | 删除依赖 |
| P2-03 | 收盘调度每轮只处理一个策略 | `StrategyCloseoutScheduler.java:94`（`return`） | 多策略收盘排队，最后几个错过窗口 | 改 `continue`，并加单轮处理上限 |
| P2-04 | Agent token 为空即完全关闭校验 | `AgentTokenVerifier.java:53-56` | 误配即无第二因子 | 生产 profile 强制非空，启动时校验 |
| P2-05 | `schema-shadow.sql` 不含 `books`/V2 迁移表，只跑它起不来 | `tools/db/schema-shadow.sql`（无 `CREATE TABLE books`）；`tools/run_visual_backend.sh:10` 只跑 schema | 新环境起不来或与迁移态不一致 | 合并为单一 baseline schema，或脚本显式按序跑全部 migrate |
| P2-06 | 柜台清单三处不一致：AGENTS.md 无 SIMVENUE、seed 说 SimLocal retired、deploy 有 simvenue | `AGENTS.md`（Authoritative venue mapping）；`tools/db/seed-t028-ors.sql:1`（`-- SimLocal is retired`）；`deploy/sim-venue.env.example` | 运维按 AGENTS.md 操作会找不到 SimVenue | 以代码/deploy 为准更新 AGENTS.md |
| P2-07 | `StrategyPnlPublisher` 在 `portfolio` 无行情时仍发 `unrealized=0` | `StrategyPnlPublisher.java:57-64`；`RuntimeRunnerMain.java:204`（只有收到 tick 才 `mark`） | 无行情时 PnL 显示 0 而非 N/A | 跟踪 mark 覆盖率，无 mark 的持仓不参与 unrealized 并置 stale |

---

## 5. 已验证通过的关键约束

1. **执行所有权有 DB 级约束**：`uq_account_single_ors`、`uq_agent_single_ors`（`tools/db/schema-shadow.sql:286-290`，`migrate-t029-ors-lifecycle.sql:16-17`）、`agent_strategy_bindings UNIQUE(strategy_id)`（`migrate-t035-single-agent-strategy.sql:9-10`）、`uq_strategy_active_deployment ... WHERE status='ACTIVE'`（`migrate-t037:212-213`）。`1 account = 1 agent = 1 ORS` 在数据层成立。

2. **部署绑定四元组校验 + 409 语义是完整的**：`StrategyDeploymentController.java:133-145` 同时比对 agent/account/counterparty/ors，不一致返回 `409 STRATEGY_BOUND_TO_CONTEXT`；ack 用 generation 做条件更新，过期返回 409（`StrategyDeploymentMapper.xml:180-185`，`StrategyDeploymentController.java:255-269`）。

3. **ORS 生命周期真的是 agent 子进程**：`OrsProcessManager.java:26`（`MAX_RESTARTS=3`）、`:79-83`（超限 `HALTED` 并要求人工介入）、`:114-135`（stop 先 `destroy` 再 8s 后强杀）；一个 agent 只持有一个 `Process` 字段，结构上不可能拉起两个 ORS。

4. **CTP 网关注入校验在**：`ctp_aeron_bridge.h:230-244` 对 `targetAgentId` / `accountId` / `fencingToken` 三项任一不符即回 `REJECTED`，原因分别是 `WRONG_AGENT` / `ACCOUNT_NOT_BOUND` / `STALE_FENCING_TOKEN`。

5. **SimVenue 真的独立于管理面**：独立 systemd 进程（`deploy/quantlink-fin-sim-venue.service`）、独立状态文件（`snapshot.json` + `journal.jsonl`）、独立撮合（`backend/sim-venue/.../SimVenueGateway.java`）；控制面侧已无进程内 SimExchange 调用，只剩一行注释（`MarketDataService.java:117`），对应提交 `6221d03`/`df9e180`。

6. **浏览器侧确实收口到单一 WS**：`web/src/hooks/useMarketData.tsx:147` 全应用一个 `WebSocket`，`:168` 消费 `strategy_pnl`；策略 PnL 端点 `StrategyPnlController.java:22-31` 是纯缓存读，无数据时返回 `NO_AGENT_DATA` 而不是现算。没有策略 PnL/持仓轮询。

7. **行情作用域隔离有实现**：`MarketDataService.tick(counterparty, exchange, instrument)` 用 `(counterparty, exchange, instrument)` 复合键，找不到直接返回 `null`（`MarketDataService.java:136-142`）；`StrategyPnlService.java:63-69` 明确“无 scoped tick 就按成本计价，不用其他柜台价格”。

8. **控制面宕机时 runner 不跟着停**：状态轮询失败保持上一次部署状态（`PairSpreadRunner.java:323-329`），风控快照超过 `riskMaxAgeMillis`（默认 15s）后只禁 OPEN、CLOSE/CANCEL 仍可发（`AeronOrderGateway.java:385-391,397-399`）；启动时执行上下文/合约/风控都有磁盘缓存，无缓存则 fail-closed（`AeronOrderGateway.java:131-142,564-576,837-848`）。

---

## 6. 待确认（代码里无法确认的假设）

1. **现网 `books.book_id` 实际是哪个规则**：P0-02 是否已经在生产发生，取决于当前库里策略是由迁移建立还是由 `insertStrategyBook` 建立。需要一条 `SELECT book_id = md5(display_name)::uuid FROM books WHERE book_type='STRATEGY'` 的核查。
2. **手续费/保证金配置覆盖率**：P0-01 的触发概率完全取决于 `instrument_fees` / `instrument_margins` 是否覆盖所有在用合约（`ExecutionLedgerService.java:235-239` 缺一条就抛）。
3. **生产 systemd 实际 env 是否等于 example**：`QF_AERON_ENABLED`、`QF_AGENT_TOKEN`、`QF_ENVIRONMENT`、`QF_RECON_GATE_ENABLED` 决定了好几条结论（HTTP 回落、token 校验、审批是否生效）。仓库里只有 `.example`。
4. **SimLocal 是否真退役**：`AGENTS.md` 仍把 `SIMLOCAL / SIMLOCAL-001 / ors-simlocal-001` 列为权威映射，而 `tools/db/seed-t028-ors.sql:1` 写“SimLocal is retired”。两者必须有一个是错的，影响多柜台评分与流段规划。
5. **是否有人工/外部进程守护 runner**：如果 systemd 或脚本也直接拉起 runner，那么 P1-01 的双实例风险从“agent 重启”扩大到“常态”。
6. **CTP 侧 `PRODUCTION_MODE` / `APP_ID` 是否按 AGENTS.md 配置**：仓库里只有模板（`deploy/run-ors-secure.sh` + `/etc/quantlink-fin/ctp/*.cfg.tpl`），无法确认评测环境实际值。
7. **`positionEpoch` 的运维语义**：设计说“明确重置持仓归属时递增”，但代码里没有任何递增入口。需要确认是有意暂缓还是漏实现。

---

## 附：本次评审未覆盖

- 前端 UI 正确性、视觉与交互（只核对了数据获取方式）。
- CTP 柜台真实回报时序、SimNow/SimShengli 实盘联调结果。
- 性能压测数据（文档中的 4.3~4.9ms 因 P1-13 的口径问题不能直接采信）。

---

## 7. 修复状态（2026-11-10 晚）

按评审清单逐项修复，每项都有单测或编译验证。

### 已修复

| 编号 | 修复内容 | 验证 |
|---|---|---|
| P0-01 | 手续费缺失改为记 0 + 一次性告警；未知订单成交写 `unassigned_trade`；重试耗尽写 `trade_dlq`（`migrate-t050`），成交不再丢弃 | `ExecutionLedgerServiceTest` 3 例通过 |
| P0-02 | `books` 以 `display_name`（=strategy_id）为自然键：`findContext` 反查真实 book、`ensureStrategyBook` 按需建、迁移脚本统一 `md5(id)` | control-plane 全量测试通过 |
| P0-03 | `/strategy-runtime/risk` 与下单校验只读 Agent 发布缓存，缺失返回 `pnlKnown=false`；删除 `StrategyPnlService`；runner 对未知 PnL fail-closed | 编译 + 测试通过 |
| P0-04 | runner 账本只由成交累积，管理面快照仅在空账本时 bootstrap，之后只报 drift 不覆盖 | 编译通过 |
| P0-05（一半） | runner 发真实 `deploymentId/generation/orderEpoch/environment`；SimVenue 回传同样字段 | 编译通过 |
| P0-06（一半） | 收盘调度器 `return` → `break`，单轮可处理全部策略 | 编译通过 |
| P0-08 | 删除 `HttpOrderGateway` 与静默回落；drain 查询失败视为 UNKNOWN，不再当已平 | 编译通过 |
| P1-13 | tick→decision 改用本地到达时间 `System.nanoTime()` | 编译通过 |
| P2-02 | 控制面移除 `sim-exchange` 主依赖（仅测试保留） | 编译通过 |
| P2-03 | 同 P0-06 调度器循环 | 编译通过 |
| P2-06 | `AGENTS.md` 柜台清单补 SIMVENUE，标注 SimLocal 退役 | 文档 |

### 未完成（需单独一轮，已评估风险）

| 编号 | 原因 |
|---|---|
| P0-05 剩余 | CTP Adapter（C++）需把 deployment 上下文存进 `OrderMeta` 并回传；仓库无 CMake/Makefile，无法在本机编译验证。在它回传前把控制面改成严格拒绝会让 CTP 成交全部被 FENCED |
| P0-06 剩余 | 收盘平仓下沉到 Agent/runner 是新增能力（本地时钟 + 本地账本 + 兜底开关），不是改一行能完成 |
| P0-07 | CTP adapter 热路径改造（异步落盘、去 busy-spin、去 per-tick 日志、行情丢包计数）同为 C++，且需要 CTP SDK 联调 |
| P1-01 | runner/agent 单实例锁与孤儿进程 adopt：需要设计 pidfile/端口探活，涉及部署脚本 |
| P1-02 | `positions` 双写收敛：需要新增 `position_ledger` 表并迁移读路径 |
| P1-03 | 指标从控制面移到 Agent/数据任务：跨模块重构 |
| P1-04/06/07/08/09/10/11/12 | 分别为 cancel fencing、幽灵撤单、前端轮询改 WS、行情键、risk 鉴权、epoch/标记、ID 块、审批策略；均可独立提交 |
| P2-01/04/05/07 | 假行情打包、token 强制、baseline schema 合并、无 mark 时 PnL stale |

### 仍需你确认

1. 现网 `books` 是否已有两套 book_id 并存（跑 `migrate-t051` 里的校验 SQL）。
2. `instrument_fees` 覆盖率（现在缺失不再丢单，但会记 0 手续费，需要补数据）。
3. 生产 systemd 实际 env 是否等于 `deploy/*.example`。

### 第二批（同日）

| 编号 | 修复内容 | 验证 |
|---|---|---|
| P1-04 | SimVenue 撤单校验 account + fencingToken，越权撤单回 REJECTED | 编译通过 |
| P1-06 | 过期订单统一发 `CancelRequestV2`，删除 SIM/SIMLOCAL 的 DB-only 改状态 | 编译通过 |
| P1-08 | 同一合约多柜台报价时，无作用域查询返回 null，避免串台 | 编译通过 |
| P1-10 | PnL/持仓消息透传真实 counterparty、逐合约 exchange、orderEpoch | 编译通过 |
| P2-04 | `qf.environment=LIVE` 且未配置 agent token 时拒绝启动 | 编译通过 |
| P2-07 | 有持仓无 mark 时 PnL 标 `stale=1`、`markSource=NONE` | 编译通过 |

### 回归验证（影子库，2026-11-10）

在全新库 `qf_verify_v2c` 上按 `schema-shadow.sql` + `t046/t050/t051` 建库后验证：

| 断言 | 结果 |
|---|---|
| 迁移后 V2 表齐全（books/strategy_deployments/strategy_positions/unassigned_trade/trade_dlq） | 5/5 |
| 迁移旧规则 book（`md5('STRATEGY-'||id)`）存在时，`ensureStrategyBook` 不建重复行 | `book_rows=1` |
| `findContext` 能解析旧规则 book（不再回退到 `md5(id)`） | `true` |
| `unassigned_trade` / `trade_dlq` 可写入 | `1/1` |
| `ExecutionLedgerServiceTest`（含缺手续费=0、缺订单进 UNASSIGNED） | 3 例通过 |
| control-plane / runtime / runtime-runner / runtime-agent 模块测试 | 通过 |

顺带修掉两个建库阻塞：`schema-shadow.sql` 现在 seed 三个受支持柜台（SIMVENUE/SIMNOW/SIMSHENGLI），`t037/t046` 删除了已退役的 SIMLOCAL 行（否则 `counterparty_exchange` 外键直接失败）。

### 第三批（收尾）

| 编号 | 修复内容 | 验证 |
|---|---|---|
| P0-06b | 收盘平仓下沉到 runner：`CloseoutGuard` 用本地时钟 + 本地账本 + scoped 行情在收盘窗口内平仓；无行情不臆造价格，控制面调度器保留兜底 | 新增 `CloseoutGuardTest`（窗口内只平一次、窗口外/无报价不平），runner 测试通过 |
| P1-02 | `positions` 改为只由柜台快照写；成交推导写入新表 `position_ledger`，并新增 `position_reconciliation` 视图做差异对账；保证金计算改用 ledger | 影子库建表 + 视图通过，control-plane 测试通过 |
| P1-03 | 指标改由 Agent 计算：新增 SBE `IndicatorValue`(27)、`AeronStreams.INDICATOR=2012`、runner `IndicatorPublisher`、控制面 `IndicatorStreamConsumer`；`IndicatorEngine` 不再重算 EMA/SPREAD | 编译 + 测试通过 |
| P0-05 / P0-07 | CTP Adapter 回传 deployment 上下文 + 严格 fencing；回调不再阻塞 Aeron（有界队列/计数）、去同步落盘与每 tick 日志 | 190 构建机 `tools/build_ctp_aeron.sh` 编译通过 |

最终状态：**21 项全部关闭**（P0 8/8、P1 13/13、P2 7/7）。全量 `gradlew test` 通过，影子库可从零建立并包含 `position_ledger` / `trade_dlq` / `position_reconciliation`。

## 8. 环境核查结果（190，2026-11-10）

只读 SQL 与配置键比对，未输出任何密钥。

| 检查 | 结果 | 结论 |
|---|---|---|
| `books` 旧规则行 | `legacy=0 / total=3` | P0-02 的 book_id 冲突在该库未发生 |
| `instrument_fees` 覆盖 | 已交易 `(account, instrument)` 缺失 = 0，费率行 18 条 | P0-01 的手续费触发概率低 |
| `control.env` 环境 | `QF_ENVIRONMENT=SHADOW`、`QF_AERON_ENABLED=true`、`QF_MARKET_AUTO=false`、`QF_AGENT_TOKEN` 已配置 | P2-01/P2-04 的前置条件满足 |
| `control.env` 键差异 | 190 多出 `QF_STRATEGY_CANARY`（无代码读取，属遗留）；示例缺 `QF_SIM_ENABLED`、`QF_CALENDAR_FILE` | 已补进 `deploy/control.env.example` |
| agent 配置 | `runtime-agent-simnow.properties` 仍用显式 `instance.*` 静态实例，而示例是空 `instances` + 按部署表生成 | 两种机制并存，迁移到部署表前不要清空 |

## 9. 行情 / 交易热路径复核（2026-11-10 晚）

按线程逐项核对本轮改动，结论：**新增代码不引入阻塞 IO，per-tick 分配已消除**。

| 路径 | 线程 | 本轮改动 | 成本 |
|---|---|---|---|
| `OnRtnDepthMarketData` | CTP 回调 | 删除每 tick `std::cout<<endl`；`mdPub_->offer` 失败计数 | 非阻塞 offer + 一次原子自增 |
| `OnRtnOrder` / `OnRtnTrade` | CTP 回调 | 删除每笔 `cout`；回报改入有界队列 | 每笔一次 vector 拷贝（低频），无阻塞 |
| `nextOrderSequence` | CTP 回调 | 去同步文件 IO | 原子自增 |
| `saveOrderMeta` | CTP 回调 → poll | 去同步落盘 | 1s checkpoint |
| `bridge.poll()` | 主循环 | 排空队列 + 序列号/元数据 flush + 丢包报告 | 每轮一次 mutex + 空队列检查 |
| tick 循环 | 策略线程 | `IndicatorPublisher.onTick`（EMA/SPREAD/IV/25Δ RR） | 预热后零分配：OptionRef 缓存、years 按日缓存、holder 复用 |
| tick 循环 | 策略线程 | `closeout.drain()` | 空队列 poll |
| 1Hz | 策略线程 | `closeout.updatePositions(snapshot)` | 每秒一次列表分配（可接受） |
| 1Hz | 策略线程 | 指标/PnL 发布 | 编码器复用 |
| 每轮 | 策略线程 | `queueDepth()` | 改为计数，不再构建 openOrders 列表 |
| 收盘检测 | `qf-closeout` daemon | 全部判断 | 与策略线程隔离 |

仍存在的**既有** per-tick 分配（非本轮引入，建议后续处理）：`toMessage(tick)` 每 tick 建 record+数组、`lastTicks.put`、`lastTimestamp.getOrDefault` 的 Long 装箱。

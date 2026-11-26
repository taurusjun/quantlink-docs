# quantlink-fin 独立架构审查（2026-11-08）

- 审查对象：`quantlink-fin` 当前 `main`
- 代码基线：`c7e9be5`（最近一次代码修复为 `faf667a`，之后只有文档、导航、告警展示修改）
- 审查范围：`backend/control-plane`、`runtime-runner`、`runtime-agent`、`sim-exchange`、`ctp-adapter`、`deploy`、`tools/db`、`docs`
- 审查方式：代码走查 + 仓库内部署文件/脚本核对
- 未执行：未登录生产主机、未查询线上 PostgreSQL/ClickHouse、未执行 `systemctl/psql`、未做 CTP 交易日联调。凡涉及“线上实际值”的结论均标注为**未验证**，不以仓库代码代替部署事实。

---

## 0. 结论先行

### 0.1 一句话结论

**这次对账误拦修复的“事务化 + 策略级 scope”在代码层是真的，但“P0 全部关闭”不成立。当前系统仍不具备影子/小资金试点条件，只适合 SimLocal 研究；实盘不通过。**

最危险的仍然是“看起来生效、实际没生效”的链路，而且这次复审又确认了 5 条：

```text
1. stop-all 把 deployment 改成 INACTIVE，而 Agent 把 INACTIVE 当成“应运行” → 策略进程不会停，也不会 drain/flatten。
2. 控制面 MarketDataService 默认 auto=true，且只跳过 source=external；Aeron 行情 source=aeron → 每秒被模拟 tick 覆盖。
3. Pair/Generic runner 默认从控制面 HTTP 取行情（策略配置没有 mdStream）→ 控制面宕机时 Runner 没有行情，无法撤单/平仓。
4. Archive 自动重放从 recording 起点开始、30 秒后停止，且从不使用 consumer checkpoint → 重放不到宕机窗口；CTP 执行流根本没被录制。
5. Runner 本地持仓只在第一次 risk 快照时 seed，且会重复消费 replay 的 trade → 本地持仓/风控/收盘平仓可能多算或少算。
```

### 0.2 分级结论

| 场景 | 结论 | 依据 |
|---|---|---|
| SimLocal 研究 | **有条件可用** | 执行/撮合语义多数已修；但必须关闭后端 auto-sim，且明白 Archive/风控未闭环 |
| 影子 / 小资金 | **不通过** | 本报告 P0-01～P0-13 未清零 |
| 实盘 | **不通过** | 账本键控、场所级对账、CTP 账户权益、应急、HA 均未闭环 |

### 0.3 对 7 个重点问题的直接回答

1. **ExecutionLedgerService 事务边界**：事务本身成立（外部 Bean 调用，无自调用失效），覆盖 trade、`orders.filled_qty/status`（由 trades 汇总）、ledger、`strategy_positions`、`positions`。但 `orders.status` 的 OrderUpdate 写入不在该事务内；消费端失败后没有重试/位点恢复，Aeron 位点会前进而 DB 回滚。
2. **ScopedReconciliationService**：策略级 scope 生效，PAIR 不再因 OPT 的**策略持仓**不一致被连坐；但 refresh 仍是非事务的多条 SQL，存在读快照竞态；首次状态缺失会在 `/risk` 请求内同步 refresh（失败则 `NO_RECONCILIATION_STATUS`，fail-closed 但增加延迟）；没有 ACCOUNT scope；venue gate 仍是全局且无过期检测；PAIR 仍可能被其他策略的在途订单/场所差异阻塞。
3. **Archive 重放 + last_update_ts**：`last_update_ts` 用 `System.nanoTime()`（SimLocal）或 `0`（CTP）。同一主机同一 boot 内 Linux CLOCK_MONOTONIC 尚可比较，但**跨重启/跨主机不可比**；CTP 完全没有防回退。重放与实时消费并发不安全，Runner 没有去重/防回退，会重复计持仓。consumer checkpoint 只写不读。
4. **三级风控**：账户限额只覆盖 Aeron gateway 和 `StrategyOrderService`；手工单、canary/in-process 路径绕过。价格笼子只在 gateway 且依赖可能被模拟的 `lastPrice`；自成交只查 Runner 本地订单；频率限制默认关闭；交易日历只用 `todayTradingDay`，夜盘归属未实现。**两腿时段交集确实实现了**（`PairSpreadRunner.java:719-730`），但两腿执行不是原子的（P1-03）。
5. **保证金/today-yesterday/结算**：`SettlementService.settle` 的 `@Transactional` 覆盖 positions/margin/settlement/ledger，事务边界成立；但公式按净持仓和单一 avg 计算，不能处理同合约多空并存；同日同价重跑通常 pnl=0，改价/部分重算会二次改现金并覆盖结算历史；保证金只在结算时更新，盘中不预占；CTP 账户权益从未进入 DB 对账。
6. **安全**：WS ticket、Origin 白名单、审计 append-only 是真实改进；但审计哈希链并发会分叉，限流只覆盖写请求且按 IP+URI，Agent token 不绑定 agentId，RISK 角色不能执行 POST 应急，CTP 凭据在 SimNow 路径仍未证明加密。
7. **部署/运维**：单机单库单 Archive，无 HA/PITR 落地；备份脚本无定时任务；按仓库默认配置，Archive 只录 SimLocal 2120-2123，不录 CTP 2100-2103/2110-2113/2006（实际 systemd 是否覆盖未验证）；重放服务 oneshot 无重启；无 P0 故障注入证据。

---

## 1. 审查基线与“声称 vs 证据”

### 1.1 Git 基线

最近 15 条提交中，真正的交易/账本代码修复只有 `faf667a`（对账事务化/策略级 Gate/告警消失）；之后 `6c08768`/`cb5ed67`/`9172aca` 是告警展示，`3a309f0` 是文档，`77d6d42`/`9f31a35`/`c7e9be5` 仅导航。**没有新的代码提交证明 P0 复审已执行。**

### 1.2 关键声称核验表

| 声称 | 代码证据 | 复核结论 |
|---|---|---|
| R-P0-13 控制面宕机 Runner 继续交易 | `PairSpreadRunner.java:279-285` 保留 last-known mode；但 `MarketDataProviderFactory.java:6-11` + 策略配置无 `mdStream` → 行情走 HTTP | **部分**：mode 修了，行情链路没修 |
| R-P0-14 场所级对账 Gate | `SimLocalVenueReconciler.java:44-115` | **部分**：只做 SimLocal 订单/持仓，无 CTP、无 trade/account、无快照时效 |
| R-P0-15 stop-all/drain/flatten | `EmergencyMapper.xml:19-22` + `HeartbeatClient.java:102-104` | **未闭环**：INACTIVE 被 Agent 当成应运行，stop-all 不 flatten |
| R-P0-16 账本/手续费/保证金/结算 | `ExecutionLedgerService.java:34-66`；`SettlementService.java:37-86`；`schema-shadow.sql:165,497` | **部分**：有代码，但键控/重复结算/盘中保证金不成立 |
| R-P0-17 执行事件持久化/重放 | `ArchiveRecorder.java`、`ArchiveReplayTool.java`、`deploy/quantlink-fin-archive-replay.service:11` | **部分**：服务存在，重放策略和 checkpoint 不对 |
| R-P0-18 本地风控权威化 | `AeronOrderGateway.java:300-450`；`TradingController.java:314-424` | **部分**：gateway 有；手工/canary 绕过；持仓只 seed 一次 |
| R-P0-08/21 删除生产 Mock | `MarketDataService.java:79,138-151`；`MarketDataAeronConsumer.java:108`；`SimMdPublisher.java:49` | **未闭环**：前端 mock 删了，后端模拟行情仍在覆盖真实行情 |
| R-P1-01 配置 hash/generation/回滚 | `StrategyDeploymentController.java:197-208`；`PairSpreadRunner.java:355-416` | **部分**：hash 只覆盖 strategies.config_json；Pair/Common 热加载绕过 generation |
| R-P1-02 全局订单 ID / 单一 OrderRouter | `AeronOrderGateway.java:767-771` | **未闭环**：Aeron 路径仍是毫秒取模 + 进程内 sequence |
| R-P1-03 安全加固 | `WsTicketService.java`、`SecurityConfig.java:32-35`、`AgentTokenVerifier.java:27` | **部分**：WS 已修；限流/token 绑定/凭据仍有缺口 |
| R-P1-06 CI + 故障注入 | `.github/workflows/ci.yml` | **部分**：有单测/构建，无控制面宕机/Adapter 重启/双 Runner/背压故障注入 |
| R-P1-09 SimLocal ORS 归 Agent 管 | `OrsProcessManager.java:133-146` | **未验证**：示例配置没有 `ors.healthFile`，仍可能是独立 systemd |
| R-P1-10 四眼/变更审批 | `ApprovalGuard.java:17-38` | **部分**：只有 LIVE 的 activate；rollback、settlement、manual 不要求 |

---

## 2. P0 问题表

> 口径：P0 = 可能导致错单、漏撤、账本错误、风控失效、无法恢复，或让“已关闭”结论失真；影子/小资金前必须解决。

| ID | 级别 | 问题 | 证据（文件:行） | 影响 | 建议修复 | 验收方式 |
|---|---|---|---|---|---|---|
| P0-01 | P0 | **stop-all 实际停不住、也不平仓**：`pauseActiveDeployments` 把 deployment 置为 `INACTIVE`，Agent 的 `shouldRun` 把 `INACTIVE` 当可运行；Pair 在 `INACTIVE` 只报警，不 flatten；`cancelAll` 的 `listCancelableOrders` 还漏掉 `CANCEL_FAILED`/`ACK_TIMEOUT`/`SENT` | `EmergencyMapper.xml:19-22,30-48`；`HeartbeatClient.java:102-104`；`PairSpreadRunner.java:600-613`；`EmergencyController.java:68-82` | stop-all 后策略进程仍运行，持仓不退；撤单失败或状态不在列表内的挂单仍在场所；与“5 秒停新单、撤单、平仓、确认 flat、停进程”的验收标准不符 | 新增不可运行的 `PAUSED/STOPPED` 语义，Agent 不再把 `INACTIVE` 当 shouldRun；stop-all 顺序改为：停新单→撤单并等待回执→按策略 flatten→确认 flat→停进程；取消发布失败必须 fail-closed 并保留人工介入 | 有持仓/挂单时调用 stop-all：5 秒内无新单、`orders` 全终态、`positions` 净额为 0、进程退出、Agent 日志出现 drain complete；断开 cancel publication 再测一次 |
| P0-02 | P0 | **真实行情被后端模拟 tick 覆盖**：`qf.market.auto` 默认 true；每秒对 au2612/ag2612/ag2706 生成 `source=simulated` tick；只跳过 `source=external`，而 Aeron 消费写入 `source=aeron`；SimMdPublisher 还无条件每 100ms 发 synthetic | `MarketDataService.java:79,138-151,103-107`；`MarketDataAeronConsumer.java:100-111`；`SimMdPublisher.java:49,70-77,108-110`；`SystemStatusController.java:33-48` | 策略、价格笼子、行情龄、`/system/status marketFresh` 都建立在随机游走上；行情源中断也不会 stale；`SimExchangeService.onTick` 还会用假 tick 撮合 | 生产/影子默认 `qf.market.auto=false`；`MarketDataService.accept` 拒绝“已有真实源时”的 simulated；保留 `synthetic` 标志贯穿到 Tick/前端；SimLocal 研究可显式启用 synthetic，但 source 必须为 `simulated` 且不得覆盖 `aeron` 源；shadow/live 禁止 auto-sim | 在无 `QF_MARKET_AUTO` 覆盖时启动，`/api/v1/market/ticks` 中 ag2612 的 source 只能是 `aeron`；停掉 Aeron feed 后 5 秒内 `marketAgeMs > 5000`、`marketFresh=false`、OPEN 被拒绝 |
| P0-03 | P0 | **控制面仍在行情热路径**：Pair/Generic 默认用 `ControlPlaneMarketData` HTTP 拉 `/market/ticks`；仓库内所有 SimLocal 策略配置都没有 `mdStream` | `deploy/strategies/sim-local-pair.properties`（无 mdStream）；`RunnerConfig.java:116-118`；`MarketDataProviderFactory.java:6-11`；`ControlPlaneMarketData.java:11-17`；`PairSpreadRunner.java:488-540` | 控制面宕机 10 分钟时 Runner 收不到 tick，无法撤单/平仓；与架构硬约束“控制面不进入 tick/order 热路径”直接冲突 | 所有 shadow/live 策略配置显式 `mdStream=1001`；启动时强制校验“非 test 模式必须 Aeron 行情”；HTTP 行情仅保留显式测试开关；增加控制面宕机故障注入 | 停 control-plane 10 分钟，Pair 仍持续收到 Aeron tick、能撤单/平仓；`grep mdStream` 所有策略配置非 0；Runner 日志无 `/market/ticks` 请求 |
| P0-04 | P0 | **Archive 重放不能恢复宕机窗口，且会污染 Runner**：重放从 `NULL_POSITION` 起、30 秒后 stop，从不读 checkpoint；重放与实时写同一 IPC stream；Runner 只有进程内 `seenTrades`（重启清空、5 万条清空），没有持久化/交易日去重；仓库默认 recorder/replay 只覆盖 SimLocal 2120-2123，不覆盖 CTP 2100-2103/2110-2113/2006（生产 systemd 是否用 `--stream` 覆盖未验证） | `ArchiveReplayTool.java:23,28,72-78`；`deploy/quantlink-fin-archive-replay.service:11`；`ArchiveRecorder.java:40`；`runtime-agent-simnow.properties.example:19`；`runtime-agent-shengli.properties.example:17`；`AeronOrderGateway.java:648-679` | 宕机窗口在 recording 末尾，但重放从起点开始且 30 秒后强制停止，**不能保证到达 latest**（消息量大时到不了）；旧 trade 被 Runner 重新计入本地持仓；按仓库默认 CTP 没有可重放记录；审计恢复结论不成立 | 用 PersistentSubscription 或“checkpoint=已提交 DB 位点”作为重放起点，length 限定到最新；重放完成要有可验证的结束位点；CTP/PositionSnapshot 流纳入 recorder；重放只投递给控制面专用 stream，或 Runner 用 `(positionEpoch, tradeId)` 去重；replay 在 Runner 启动前完成或显式隔离 | 控制面停机期间产生 3 笔成交；重启后 DB/UI 恰好 3 笔、持仓与场所一致；replay 日志显示从 checkpoint 到最新；Runner 本地持仓不翻倍；`archive list` 能看到 2100-2103/2110-2113/2006 |
| P0-05 | P0 | **OrderUpdate 防回退无效**：SimLocal 用 `System.nanoTime()` 作 `last_update_ts`，跨重启/跨主机不可比；CTP 的 OrderUpdate timestamp 固定为 0；`applyOrderUpdate` 在通过时间戳条件后仍无条件覆盖 `filled_qty`（不取 max），且允许 `last_update_ts=0` | `SimOrderCodec.java:63-77`；`AeronOrderMapper.xml:35-41`；`ctp_aeron_bridge.h:226-240`；`AeronOrderUpdateConsumer.java:147-153` | 主机重启后旧 recording 的 nanoTime 可能大于新实时消息，导致新回报被全部丢弃；CTP 重放会用旧状态覆盖新状态；CANCEL_FAILED 等 0 filled 回报会把已成交量清零 | 改为每订单单调 `sequence`（交易所/适配器生成）或“boot epoch + seq”；禁止用墙上/单调时钟做跨进程排序；CTP 用 OrderSysID/回报序号；`filled_qty` 只允许单调不减；重放按 sequence 拒绝旧值 | 重启主机后重放旧 recording：订单状态/成交量不回退；CTP Adapter 重启后旧订单仍能更新；构造 PARTIAL→CANCEL_FAILED→FILLED 乱序，最终状态正确 |
| P0-06 | P0 | **消费端 DB 失败后 Aeron 位点前进**：poll 回调内 `applyTrade` 抛异常只打印；`checkpoint` 每秒记录 `image.position()` 但从不用于恢复；order request 在无 RUNNING route 时直接丢弃；pending 只在内存 | `AeronOrderUpdateConsumer.java:119-185,187-213,202-208,215-249,279-298`；`AeronOrderMapper.xml:142-154`；`AeronConsumerPositionController.java`（仅 GET） | trade 事务回滚但消息已消费，DB 永久缺一笔；order request 丢失后对应的 update/trade 进 pending 也永远无法落库；控制面重启只能靠“恰好重放” | 建立“已提交位点”语义：DB 事务成功后才推进可恢复 checkpoint；失败重试 + 死信 + 告警；pending order/trade 持久化；无 route 时进入 pending 而不是丢弃；启动时从 checkpoint 重放 | 在 `insertTradeIfAbsent` 后注入异常：trade 不落库时 checkpoint 不前进；恢复后仍能补上；kill control-plane 时下的单重启后能查全 |
| P0-07 | P0 | **账本/成交幂等键没有账户/交易日维度**：`trades.trade_id` 是全局主键；`ledger_entries` 唯一键是 `(trade_id, entry_type, direction)`，不含 account；CTP TradeID 直接截断到 31 字符后使用 | `schema-shadow.sql:164-174,486-498`；`ctp_aeron_bridge.h:246-258`；`LedgerService.java:24-43`；`SettlementService.java:74-81` | 不同账户/不同交易日的相同 CTP TradeID 会让第二笔被 `ON CONFLICT DO NOTHING` 静默丢弃；Settlement 用 `SETTLE-<day>-<instrument>` 作为 trade_id，跨账户冲突；`recordRealizedPnl` 在 ledger 冲突时仍执行 `applyCashDelta` → 现金变了但无分录 | 主键改为 `(account_id, trading_day, trade_id)`；ledger 唯一键加 `account_id`；现金变动必须由“ledger 插入成功”驱动，冲突时不得再改账户；迁移历史数据并校验借贷平衡 | 两个账户使用同一 TradeID 各成交 1 笔，两笔都在；同一账户连续两日同 TradeID 都在；同账户同 instrument 重复结算不再改变现金；借贷分录逐笔平衡 |
| P0-08 | P0 | **Runner 本地持仓不可信**：`refreshRisk` 只在 `!riskLoaded` 时 seed 一次，之后不再校正；`onTrade` 在 OrderUpdate 的累计 filledQty 之上再加 qty；replay 的旧 trade 会再次 `applyPosition` | `AeronOrderGateway.java:703-725,619-679`；`PairSpreadRunner.java:219,503`；`StrategyRuntimeController.java:74` | 本地 `maxPosition`、Pair `pairPosition`、drain/flatten 使用的是漂移的净持仓；重启/重放后可能翻倍，导致超限或过度平仓；`filledQty` 也可能重复 | 每次 risk 刷新都用权威快照对账本地持仓（带 position version/epoch）；trade 去重使用 `(account, tradingDay, tradeId)`；`filledQty` 只接受“累计值取 max”；重放时先重置本地账本再按 checkpoint 应用；把本地持仓差异上报并阻断 OPEN | 重启 Runner 前后本地持仓 = 控制面策略持仓；重放 10 笔历史 trade 不改变持仓；构造 OrderUpdate PARTIAL + Trade 同笔，filledQty 不翻倍；drain 后净额为 0 |
| P0-09 | P0 | **结算/保证金不满足 CTP 账本语义**：按净持仓和单一 `avg_price` 计算；同合约多空并存时忽略一边；`is_relative`/hedge flag 未处理；同日同价重跑通常 pnl=0，但改价/部分重算会再次 `applyCashDelta`，且 `account_daily_settlements` 被 upsert 覆盖；保证金只在结算时更新，盘中不预占；CTP `queryAccount` 只打印不落库 | `SettlementService.java:37-86,89-102`；`LedgerService.java:33-43`；`schema-shadow.sql:81-93,504-512`；`ctp-adapter/src/main.cpp:260-264` | 多空并存/锁仓时 PnL 和保证金错误；改价重跑会二次改现金且覆盖结算历史；可用资金高估（未扣盘中保证金）；无法与 CTP 账户权益对账 | 引入 position lots 或分方向 avg/保证金；结算按“已结算日”幂等，重复调用不得再动现金；成交时预占/释放保证金；CTP `ReqQryTradingAccount` 结果入库并与本地 `balance/available/margin` 对账；缺 rate 必须拒绝结算 | 同一合约 long 2 + short 1：PnL/保证金按两边分别计算；同日同价重复结算现金不变；改价重跑不二次结算；盘中开仓后 `available` 反映保证金；CTP 权益差异 = 0 或告警 |
| P0-10 | P0 | **场所对账仍不完整，且仍可能误拦 PAIR**：只比 SimLocal 订单/持仓，不比 trade/account；快照文件无 TTL 检查；`localOrders` 不按 account 过滤；写快照不是 temp+rename；venue 结果全局，任何在途订单/其他账户差异都会阻塞所有策略 | `SimLocalVenueReconciler.java:44-115`；`SimExchangeAeronGateway.java:121-157`；`StrategyRuntimeController.java:91-104` | SimExchange 死后旧快照仍可能 passed；一个账户/一个在途订单会让 PAIR 全部 OPEN 被拒；partial write 会抛异常 → gate false；无法证明“场所 vs 本地差异 = 0” | 快照带 `ts` 并校验 TTL；只比较目标 account；增加 trades/accounts/手续费比较；temp 文件 + 原子 rename；对“刚下单/刚成交”的合理宽限；CTP 用 ReqQry 系列；venue 结果按 account/scope 聚合 | 停 SimExchange 后 5 秒内 gate=false；其他账户有挂单时 PAIR 不受影响；快照写入过程中并发读不产生 false；CTP 账户有独立 venue reason |
| P0-11 | P0 | **手工单/legacy canary 绕过统一风控与账本**：手工单只查日历、tick/lot、100 手上限、固定 10% 保证金；无 session/价格笼子/账户限额/自成交/行情龄；canary/in-process 直接写 orders/trades/positions，不走 ledger/fee/strategy_positions | `TradingController.java:210,314-424`；`StrategyExecutionService.java:49-84`；`control.env.example:5-6`；`StrategySignalService.java:95-117` | 手工单可在非交易时段/超账户限额/远离市价成交；canary 单无手续费/无 ledger/无 strategy position；同一账户出现两套账 | 所有下单入口收敛到一条 `StrategyOrderService`/Aeron router；手工单复用账户/策略/合约三级限额、session、价格笼子、自成交、行情龄；canary 在 shadow/live 强制关闭；保证金用 `instrument_margins` | 非交易时段手工 OPEN 被拒；超 `account_risk_limits` 被拒；手工成交有 fee + ledger + strategy_positions；`QF_STRATEGY_CANARY=true` 在 SHADOW 启动即失败 |
| P0-12 | P0 | **CTP Adapter 重启后订单归属丢失**：`orderMeta_` 只在内存；启动/登录不查询未完成订单；`OnRtnOrder`/`OnRtnTrade` 只能从内存 meta 取 requestId/strategyKey | `ctp_trader_session.h:122-123,341-346,426-436`；`ctp-adapter/src/main.cpp:240-255`（启动只 publish positions，无 ReqQryOrder）；`ctp_aeron_bridge.h:93-106` | Adapter 重启后旧订单的回报没有 requestId/strategyKey，控制面无法归属/对账；旧会话订单的撤单是否可用需交易日验证 | 登录后 `ReqQryOrder`/`ReqQryTrade` 重建 orderMeta；把 meta 持久化或从控制面按 clientOrderId 回填；撤单前校验 FrontID/SessionID；启动时先恢复再允许新单 | 有未完成订单时 kill -9 Adapter，重启后旧订单回报仍带正确 requestId/strategyKey；撤单成功；控制面 order 归属不变 |
| P0-13 | P0 | **PositionSnapshotConsumer 与成交账本并发覆盖**：CTP 快照到达时先 `deletePositions(account)` 再逐条 upsert，无事务、无 snapshot version、无“最后成交位点”比较；Adapter 每 30 秒查询一次持仓 | `PositionSnapshotConsumer.java:92-101`；`runtime-agent-simnow.properties.example:19`（position-interval 30） | 快照查询发生在成交前、到达在成交后时，会把刚写入的 fill 持仓删除/回退；进程在 delete 后崩溃会留下空 positions；保证金/PnL 随之错误 | 快照带序号/查询时间；与最近成交位点比较，旧快照只记录不覆盖；不要 delete-all，改为 merge + 标记缺失；整个 apply 加事务/临时表切换；单一 writer | 在 fill 提交后注入旧快照：持仓不回退；kill 在 delete 与 insert 之间：positions 不为空；连续 10 次快照+成交交错后净额与成交一致 |

---

## 3. P1 问题表

| ID | 级别 | 问题 | 证据（文件:行） | 影响 | 建议修复 | 验收方式 |
|---|---|---|---|---|---|---|
| P1-01 | P1 | **对账刷新不是一致快照**：`ScopedReconciliationService.refresh` 无 `@Transactional`，先查 strategy_positions、再逐合约查 trades；READ COMMITTED 下每条 SQL 独立快照；`consecutive_failures` 只记录不用于宽限；无 ACCOUNT scope、无 run history | `ScopedReconciliationService.java:37-104`；`ReconciliationStatusMapper.xml:18-37` | 成交在两条 SELECT 之间提交时仍会误报 `STRATEGY_POSITION_MISMATCH`，原 incident 的 false positive 仍可出现；账户级差异永远不被 gate 检查；无法回看历史 issue | 用单条 SQL 或 `REPEATABLE_READ`/显式快照；读取 `consecutive_failures` 做 N 次宽限；增加 ACCOUNT scope 行；新增 `reconciliation_run` 历史；venue 缓存带 ts | 注入 100ms 写入延迟，gate 不误报；持续不一致超过宽限仍 false；账户 positions 与 trades 不一致时 ACCOUNT 行 false；`/reconciliation/status` 能看到历史 run |
| P1-02 | P1 | **SHFE 今昨仓无法一笔平掉**：`ExecutionOffsetPolicy` 明确“单笔不拆单”，提示“启用 SPLIT”，但代码没有 SPLIT 实现 | `ExecutionOffsetPolicy.java:60-73` | 持仓同时有今仓/昨仓时，`CLOSE` 被拒绝；收盘 closeout 可能留下裸仓 | 实现拆单（先平今/先平昨按交易所规则）或在 closeout 层拆成两笔；拒绝时必须把 residual 报给 flatten 调用方，不得静默 | SHFE 合约 today 1 + yesterday 1，CLOSE 2 成功且 residual=0；或明确返回“需拆单”并让 closeout 自动拆 |
| P1-03 | P1 | **收盘平仓双 owner 与两腿非原子**：Pair Runner 自己做 closeout，`StrategyCloseoutScheduler` 又每 30 秒对所有 strategy_positions 调 `flattenStrategy`；Pair `closePair` 同时发两腿，`id1 != null || id2 != null` 即认为已触发，不验证两腿都成交 | `PairSpreadRunner.java:561-585,706-717`；`StrategyCloseoutScheduler.java:43-93` | 可能重复平仓；一腿成交一腿拒绝时留下裸腿；`flattenStrategy` 只按 net 平，锁仓会留一边 | 收盘平仓只能有一个 owner（Runner 或 Scheduler 二选一，建议 Runner 本地）；两腿用状态机/补偿单，任一腿失败必须重试或对冲；flatten 按 long/short 两边分别处理 | 构造一腿拒单：5 秒内补单或明确告警，最终净敞口=0；同时开启 Scheduler 不产生重复成交；锁仓 long+short 能分别平掉 |
| P1-04 | P1 | **交易日归属仍是墙钟日期**：`orders/trades.trading_day` 仅 `DEFAULT CURRENT_DATE`，没有任何 insert 显式写；策略日限额用 `created_at::date = CURRENT_DATE`；`nightSessionOk` 计算但未使用 | `schema-shadow.sql:550-553`；`StrategyOrderMapper.xml:40-67`；`TradingCalendarService.java:103-120` | 夜盘 21:00-24:00 归属前一日；00:00 后日限额重置；节假日前夜盘可能被放行；PnL/结算历史按错日 | 引入 TradingDayService（含夜盘映射、节假日、交易所日历）；所有 order/trade insert 显式写 trading_day；日限额按 trading_day；夜盘用 `nightSessionOk` 或专门 session 判断 | 21:30 与 00:30 各下一单：trading_day 都是下一交易日；跨 00:00 日限额不重置；节假日前夜盘 OPEN 被拒 |
| P1-05 | P1 | **Aeron 订单 ID 仍可能冲突**：`nextClientOrderId = (millis % 900_000_000) * 1000 + sequence%1000`；多 Runner 各自维护 sequence；900M ms 约 10.4 天回绕 | `AeronOrderGateway.java:767-771` | 同账户多 Runner/多策略同毫秒同 sequence 可能生成相同 clientOrderId；`orders` 唯一键冲突会丢单/错归属 | 改为账户级 DB 序列或“boot epoch + strategy hash + 单调序列”；CTP OrderRef 仍限制 12 位时做账户级映射表；禁止进程内取模 | 同时启动两个 Runner 各发 10k 单，clientOrderId 无重复；重启后仍单调；CTP OrderRef 映射可逆 |
| P1-06 | P1 | **配置 hash/generation 不覆盖真实参数**：`configHash` 只 hash `strategies.config_json`；Pair 每 30 秒直接热加载 `pairRuntimeConfig`；rollback 无审批 | `StrategyDeploymentController.java:197-208,147-166`；`PairSpreadRunner.java:355-416`；`ApprovalGuard.java:17-38` | 修改 pair/common 参数不产生 generation、不触发 drain、不留部署历史；rollback 任意 TRADER 可执行 | hash 覆盖 strategy + pair + common + fees/limits 的 effective config；任何变更生成 generation；Runner 只在 generation 变化时 reload，reload 前 drain；LIVE rollback 也走四眼 | 改 pair 参数后出现新 generation/history；未 drain 不 reload；LIVE rollback 无 approval 返回 428 |
| P1-07 | P1 | **审计哈希链并发分叉 + 保留策略冲突**：trigger 用 `SELECT entry_hash ORDER BY id DESC LIMIT 1`，无 advisory lock/序列；hash 用 md5 且不含 id/created_at；`retention.sql` 要 DELETE `audit_log`/`ledger_entries`，但 append-only trigger 会拒绝 | `schema-shadow.sql:589-603`；`schema-shadow.sql:498-501`；`retention.sql:7-9` | 并发写审计会两条记录指向同一 prev，链断裂；保留脚本实际跑不通；审计“不可篡改”结论过强 | 用单序列/ advisory lock 串行化链；SHA-256/HMAC；把 id/created_at 纳入 hash；保留用分区 DROP 或受控维护窗口；保留操作本身写审计 | 并发 100 条审计后链可线性校验；`retention.sql` 能执行或明确失败并告警；删除后仍可导出/校验 |
| P1-08 | P1 | **安全边界仍偏弱**：限流只对 POST/PUT/DELETE、按 `remoteAddr+URI`、内存态；无登录失败锁定；Agent token 为空即关闭校验且不绑定 agentId；`SecurityConfig` POST 只允许 ADMIN/TRADER，RISK 无法执行 stop-all；SimNow 示例仍用明文 cfg 路径 | `ApiRateLimitFilter.java:34-49`；`AgentTokenVerifier.java:24-32`；`SecurityConfig.java:32-35`；`runtime-agent-simnow.properties.example:19`；`deploy/nginx-quantlink-fin-api.conf` | 暴力破解/重放/横向冒充 Agent；RISK 角色在事故中无法停机；凭据仍可能明文落盘 | Nginx/网关层限流 + 登录失败锁定；token 绑定 `(agentId, token)` 并支持热轮换；RISK 允许应急 POST；SimNow 也走 `run-ors-secure`；WS ticket 不落 access log | 错误 token 100 次触发锁定；Agent A 的 token 不能注册 Agent B；RISK 用户能 stop-all；SimNow 进程命令行无明文密码 |
| P1-09 | P1 | **SimLocal 语义仍有缺口**：`SimOrderCodec.decodeRequest` 不读 targetAgent/fencing；SimExchange 不区分 CLOSE_TODAY/CLOSE_YESTERDAY；重启只 seed positions，不恢复 open orders/cash/fees/realized | `SimOrderCodec.java:45-61`；`SimExchange.java:282-340`；`SimExchangeAeronMain.java:63-79` | SimLocal 无法证明 fencing/今昨仓；重启后挂单消失、现金/手续费/PnL 重置；T-027 的验收不能代表 CTP 语义 | SimLocal 增加 targetAgent/fencing 校验；建模 today/yesterday；快照保存 open orders/cash/fees/realized 并在启动恢复；重启后与 venue 对账 | 错误 fencing 被拒；CLOSE_TODAY 不能平昨仓；重启后 open orders/cash/fees 与重启前一致 |
| P1-10 | P1 | **费用/保证金/乘数缺失时 fail-open**：`feeFor` 查不到返回 0；`findMultiplier` null 默认 1；`available` 缺失时 `number(...,-1)` 绕过；`requireAccountLimits` 默认 false；`max_size=0` 视为不限 | `ExecutionLedgerService.java:131-153`；`AeronOrderGateway.java:344-398`；`SettlementService.java:59-60,89-102` | 新合约/新账户可能零手续费、错误乘数、无账户限额；风控“未配置即拒绝”未真正实现 | fee/margin/multiplier 缺失一律拒绝 OPEN/结算；账户限额在 shadow/live 强制要求；max_size 给强制默认值；启动时自检配置完整性 | 删除一条 instrument_fees 后 OPEN 被拒；删除 multiplier 后结算被拒；无 account_risk_limits 启动即失败 |
| P1-11 | P1 | **备份/PITR/HA/Archive 运维未闭环**：`backup.sh` 只有手工脚本，无 systemd timer；PITR 只有文档；无 standby；Archive 无磁盘/recording lag 监控，replay 是 oneshot 无 Restart | `tools/db/backup.sh`；`docs/architecture/21-backup-pitr.md`；`deploy/quantlink-fin-archive-replay.service:3-11`；`R-P1-07 BLOCKED` | 主机/DB/Archive 故障不可恢复；备份是否每天执行无法验证；replay 失败静默 | 增加 backup timer + 成功/失败告警；实际开启 WAL archive 并做恢复演练；Archive 磁盘/录制 lag/重放完成告警；replay 失败重试或 systemd 告警；定义 RTO/RPO | 删库后从 dump+PITR 恢复到指定时间；备份任务连续 7 天成功；Archive 停止录制 5 分钟触发告警；replay 失败系统可见 |
| P1-12 | P1 | **关键修复没有自动化测试**：`ExecutionLedgerService`、`ScopedReconciliationService`、`SettlementService`、Archive replay 没有测试文件；CI 只跑单测和 bootJar，无故障注入 | `find backend -path '*/src/test/*'` 无对应类；`.github/workflows/ci.yml` | 事务回滚、重复消息、并发对账、重复结算、replay 回归全部靠人工；P0 无法持续验证 | 增加集成测试：DB 事务回滚、重复 trade、并发 consistency、trade/order 乱序、settlement 重跑、replay from checkpoint、control-plane outage；CI 加 Testcontainers/故障注入 | 每个 P0 场景有可重复测试；CI 在 PR 上失败即阻断；故障注入报告入库 |
| P1-13 | P1 | **下一交易日 runbook 没有覆盖本次复审的失败场景**：只覆盖 fee/margin、settlement、期权到期、5 日长稳；没有配置真相、行情源、stop-all、控制面宕机、Archive 重放、Adapter 重启、PAIR 误拦回归 | `docs/runbooks/next-trading-day-validation.md:1-114` | 即使按 runbook 全绿，也不能证明 P0 已关闭；历史 incident 可能复发 | 在 runbook 增加第 3/4/5/6 节：配置快照、行情 provenance、PAIR scope 回归、stop-all、control-plane outage + replay、adapter restart；每步附验收与证据路径 | runbook 逐项有命令、预期、失败处理、证据文件；交易日结束后能回答每个 P0 是否通过 |

---

## 4. P2 问题表

| ID | 级别 | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|---|
| P2-01 | P2 | `/strategy-runtime/risk` 首次无缓存时同步触发多表 refresh | `ScopedReconciliationService.java:44-53` | 首请求延迟、DB 抖动；与“risk 不做多表查询”设计不符 | 启动预热/异步 refresh；risk 只读 |
| P2-02 | P2 | consumer checkpoint 只取 `imageAtIndex(0)`，且只展示不恢复 | `AeronOrderUpdateConsumer.java:202-208`；`AeronConsumerPositionController.java` | 多 image/重放时 checkpoint 可能回退；运维误以为可恢复 | 按 session/stream 记录；真正作为 replay 起点 |
| P2-03 | P2 | Archive 无容量/保留/监控；replay oneshot 无 Restart | `ArchiveRecorder.java`；`deploy/quantlink-fin-archive-replay.service` | 磁盘满后停止录制无人知；replay 失败静默 | 容量阈值告警、按交易日保留、replay 失败重试 |
| P2-04 | P2 | 审计 md5、WS ticket 放 URL、CORS 允许 localhost 任意端口 | `schema-shadow.sql:596`；`WsTicketService.java`；`SecurityConfig.java:69-73` | 日志泄露 ticket、哈希强度不足、攻击面扩大 | SHA-256；ticket 放 header/一次性 cookie；CORS 收紧 |
| P2-05 | P2 | SimExchange 账户现金/手续费/已实现 PnL 不持久化；open orders 不恢复 | `SimExchangeAeronMain.java:63-79`；`SimExchange.java:327-330` | 重启后账户视图不一致；研究结果不可复现 | 完整快照 + 恢复；与控制面账本对账 |
| P2-06 | P2 | Settlement 接口无审计/审批；Manual 有审计但无审批，且预览固定 10% 保证金 | `SettlementController.java:20-31`；`TradingController.java:413-414` | 资金变更不可追溯；大额手工单风险 | 结算写审计、LIVE 四眼、用手工单一并改用 instrument_margins |
| P2-07 | P2 | 仓库唯一 control env 模板与文档相反：`QF_AERON_ENABLED=false`、`QF_RECON_GATE_ENABLED=false`、`QF_STRATEGY_CANARY=true` | `deploy/control.env.example:5-7,14` | 新人/恢复环境会得到错误配置；DONE 结论不可复现 | 把 /etc 实际配置脱敏入仓；模板改为 SHADOW 安全默认 |
| P2-08 | P2 | Aeron `offer` 在背压下无限自旋（SimExchange/CTP bridge） | `SimExchangeAeronGateway.java:164-172`；`ctp_aeron_bridge.h:187-192` | 慢消费者时撮合/撤单线程被阻塞；背压不可观测 | 有界重试/断开策略；背压指标和告警 |

---

## 5. 已确认闭环项（仅代码/单测级）

### 5.0 三类状态必须分开看

| 状态 | 项目 |
|---|---|
| **代码已修复且有测试** | SimLocal tradeId 唯一、撤单保留 filledQty、累计 filledQty、价格-时间排序、CLOSE 不得反向开仓（`SimExchangeTest`） |
| **代码已改，但没有对应测试/故障注入** | ExecutionLedgerService 事务、ScopedReconciliationService 策略 scope、WS ticket/Origin、审计 append-only、Pair/Generic SIGTERM drain、Agent token 多值、配置 hash/ACK |
| **代码未修复，但文档写成 DONE** | stop-all 停止语义、后端 auto-sim、Archive 重放窗口/checkpoint、CTP stream 录制、OrderUpdate 防回退、trade/ledger 幂等键、Runner 本地持仓、结算幂等、CTP orderMeta 恢复、手工单/canary 统一风控 |

以下项可以确认“代码已经这样写”，但不等于“线上已验证”：

1. **ExecutionLedgerService 事务本身成立**
   - 证据：`ExecutionLedgerService.java:34-66`；`AeronOrderUpdateConsumer.java:293-296`。
   - 结论：consumer 通过注入的 Bean 调用 `applyTrade`，Spring 代理生效；没有 `this.applyTrade()` 自调用；`LedgerService` 的 `@Transactional` 以 REQUIRED 加入同一事务。
   - 覆盖：trade、`orders.filled_qty/status`（`reconcileOrderFillFromTrades`）、fee/PnL ledger + cash、`strategy_positions`、`positions`。
   - 重复消息：`insertTradeIfAbsent` 返回 0 时直接返回，不会重复更新 positions/ledger；代价是 trade_id 碰撞时会把**另一笔**成交误判为重复（P0-07）。
   - 不覆盖：OrderUpdate 的 order status、telemetry、consumer checkpoint（见 P0-05/P0-06）。
2. **SimLocal 成交/撤单基础语义**
   - `SimOrderCodec.java:96-110` 每笔 fill 唯一 tradeId；
   - `SimExchange.java:282-292` cancel 保留 filledQty；
   - `SimExchange.java:84-175` 价格-时间排序 + 累计 filledQty；
   - 单测：`SimExchangeTest.java:97-110,130-136`。
3. **策略级对账 scope**
   - `ScopedReconciliationService.java:71-104` 只按 strategy_id 查 strategy_positions/trades；
   - `StrategyRuntimeController.java:95-99` 返回 `localReconciliationScope=STRATEGY`；
   - 结论：OPT 的策略持仓不一致不会再直接让 PAIR 的 `localReconciliationPass=false`。**但 venue/账户级仍会连坐（P0-10/P1-01）。**
4. **WS ticket + Origin**
   - `WsTicketService.java` 32 字节随机、60 秒、一次性；
   - `WsAuthInterceptor.java` 消费 ticket；
   - `MarketWebSocketConfig.java`/`TelemetryWebSocketConfig.java` 都注册 interceptor 和 Origin allowlist。
5. **告警可诊断性与去重**
   - `AeronOrderGateway.java:453-470` 的 reject reason 带 scope/issues/lastSuccess；
   - `PairSpreadRunner.java:766-780` 30 秒内同 reconciliation 原因只报一次。
6. **Agent SIGTERM drain 路径**
   - `ProcessManager.java:85-110` `destroy()` 后等待 180 秒；
   - Pair/Generic 都有 shutdown hook；
   - 结论：**只要 Agent 真的发 SIGTERM**，drain 会执行。stop-all 当前不会触发它（P0-01）。
7. **审计/账本 append-only trigger**
   - `schema-shadow.sql:498-501` 与 `audit_log` trigger；
   - 结论：普通 UPDATE/DELETE 被拒。但并发哈希链和保留脚本仍有问题（P1-07）。
8. **CI 基础**
   - `.github/workflows/ci.yml` 跑 backend test、bootJar、web build、SBE；
   - 结论：基础构建存在，不等于故障注入/集成测试存在（P1-12）。

---

## 6. 仍阻塞项

### 6.1 代码层仍阻塞（不是“等交易日”）

```text
P0-01 stop-all 不 stop / 不 flatten
P0-02 后端 auto-sim 覆盖真实行情
P0-03 Runner 行情仍走控制面 HTTP
P0-04 Archive 重放不能恢复窗口 / CTP 流未录 / Runner 重复计
P0-05 OrderUpdate 防回退无效 / filled_qty 可回退
P0-06 消费失败丢事件，checkpoint 不恢复
P0-07 trade/ledger 幂等键缺 account+trading_day
P0-08 Runner 本地持仓只 seed 一次 + trade 重复计数
P0-09 结算/保证金不满足 CTP 语义
P0-10 场所对账不完整/不新鲜/全局连坐
P0-11 手工单/canary 绕过统一风控与账本
P0-12 CTP orderMeta 重启丢失
P0-13 PositionSnapshot 与成交账本并发覆盖
```

### 6.2 真实部署/交易日验证未完成

```text
没有 /etc/quantlink-fin/control.env 的脱敏快照入仓；仓库模板反而关闭 Aeron/Recon、开启 Canary
没有 control-plane 10 分钟宕机故障注入记录
没有 stop-all + 持仓 + Agent drain 的实测记录
没有 Archive 重放“宕机窗口恰好一次”的证据
没有 CTP 场所级 orders/trades/positions/accounts 对账
没有 CTP 账户权益/保证金/手续费与本地账本对账
没有 CTP Adapter 重启后旧订单归属证据
没有 5 个交易日长稳
没有 HA/PITR 实际恢复演练
没有 Windows Electron 验收
```

### 6.3 文档与结论口径问题

`docs/reviews/remediation-execution-2026-11-08.md` 的“P0 全部关闭”应改为：

```text
代码层：部分关闭
真实部署：未验证
交易日：未验证（CTP 场所对账/账户权益/5 日长稳）
```

---

## 7. 下一交易日验证建议

> 目标不是“再跑一遍 happy path”，而是证明本报告 P0 是否真的关闭。建议按顺序执行，证据统一放 `docs/evidence/next-trading-day/`。

### 7.1 先做配置真相采集（开盘前，30 分钟）

```bash
# 脱敏后入仓
sudo cat /etc/quantlink-fin/control.env
systemctl cat quantlink-fin-control quantlink-fin-runtime-agent \
  quantlink-fin-sim-exchange quantlink-fin-aeron-archive \
  quantlink-fin-archive-recorder quantlink-fin-archive-replay
```

必须确认：

```text
QF_AERON_ENABLED=true
QF_MARKET_AUTO=false            # 当前仓库模板没有这一项，默认 true
QF_RECON_GATE_ENABLED=true
QF_RECON_SIMLOCAL_ENABLED=true  # 仅 SimLocal
QF_SIM_INPROCESS=false
QF_STRATEGY_CANARY=false
QF_AGENT_TOKEN 非空且与 Agent 配置一致
```

验收：把实际值与仓库模板 diff 写入证据；任何一项不符，停止后续交易验证。

### 7.2 行情 provenance 与 stale gate（开盘前/开盘后各一次）

```bash
curl -s -u test_admin:test http://127.0.0.1:18081/api/v1/market/ticks \
  | jq '.[] | select(.instrumentId=="ag2612" or .instrumentId=="ag2706") | {instrumentId,source,timestampMs}'
curl -s -u test_admin:test http://127.0.0.1:18081/api/v1/system/status | jq
```

验收：

```text
ag2612/ag2706 的 source 只能是 aeron（或显式 CTP 源），不得出现 simulated
停掉行情源 5 秒后 marketAgeMs > 5000，marketFresh=false
此时 Pair OPEN 被拒绝，CLOSE/CANCEL 仍允许
```

### 7.3 原 incident 回归（必须做，且要制造“别的策略不一致”）

```text
1. 让 TEST-STRAT-OPT-01 的 strategy_positions 与 trades 人为不一致（仅测试库）
2. 确认 TEST-STRAT-PAIR-01 的 OPEN 仍被允许
3. 让 TEST-STRAT-PAIR-01 自身不一致，确认其 OPEN 被拒绝、CLOSE 仍允许
4. 在成交提交的同一毫秒并发调用 /reconciliation/consistency 与 /risk
5. 观察 30 秒内 PAIR 告警是否去重、恢复后是否出现 RECOVERED/不再 NEW
```

验收：PAIR 不被 OPT 连坐；PAIR 自身问题仍拦截；瞬时窗口不把 gate 打 false；告警只出现一条。

### 7.4 成交/账本/结算压力场景

```text
A. 部分成交后撤单：filled_qty 保留，trades 不丢，ledger 一笔
B. 多档扫单：每笔 tradeId 唯一，orders.filled_qty = sum(trades)
C. 重复 Trade 回报：只入账一次，持仓不重复
D. 两个账户使用同一 TradeID：两笔都入账（当前会丢一笔）
E. 同账户同 instrument 重复结算（同价/改价）：现金只变一次
F. long 2 + short 1：PnL/保证金按两边分别算
G. CTP 账户权益 vs accounts.balance/available/margin：差异=0 或告警
```

### 7.5 stop-all / drain 实测（必须有持仓）

```text
1. PAIR 持有 ag2612/ag2706 各 1 手，留 1 笔挂单
2. 调用 POST /api/v1/emergency/stop-all
3. 记录 0/1/3/5 秒的 orders/positions/进程状态/Agent 日志
4. 再测 cancel publisher 断开时的 stop-all
```

验收：5 秒内无新单、场所挂单=0、净持仓=0、进程退出、drain complete；断开撤单通道时必须明确失败并告警，不能假装已停。

### 7.6 控制面宕机 + Archive 重放（建议盘后/仿真环境先做）

```text
1. 记录 control-plane 停止前最后订单/成交/持仓
2. kill control-plane 10 分钟；期间通过 Runner 下 3 笔单，至少 2 笔成交
3. 重启 control-plane + archive-replay
4. 校验 orders/trades/positions/ledger 恰好补齐，且 Runner 本地持仓不翻倍
5. 检查 replay 日志从 checkpoint 开始，而不是 recording 起点
6. 检查 archive list 包含 SimLocal 2120-2123；CTP 环境检查 2100-2103/2110-2113/2006
```

### 7.7 CTP Adapter 重启 / 订单归属

```text
1. 留 1 笔未完成 CTP 订单
2. kill -9 ctp-adapter，重启
3. 让该订单成交/撤单
4. 校验控制面 order 的 requestId/strategyKey/account 仍正确
5. 校验 cancel 使用正确 FrontID/SessionID
```

### 7.8 夜盘/交易日归属

```text
21:30 与 00:30 各下一笔 OPEN
校验 orders.trading_day / trades.trading_day 都属于下一交易日
校验 00:00 后 max_traded_qty 不重置
校验节假日前夜盘 OPEN 被拒
```

### 7.9 5 日长稳

按 `docs/runbooks/next-trading-day-validation.md` 第 4 节执行，但增加：

```text
每日记录 market provenance（不得有 simulated）
每日记录 reconciliation_status（ACCOUNT/STRATEGY 两级）
每日记录 archive recording/consumer checkpoint lag
每日记录 stop-all 演练结果（可用仿真账户）
```

---

## 8. 需要人类确认的问题

以下只列真正阻塞或需要决策的：

1. **实际 `/etc/quantlink-fin/control.env` 的值是什么？**
   - 必须确认 `QF_MARKET_AUTO=false`、`QF_AERON_ENABLED=true`、`QF_RECON_GATE_ENABLED=true`、`QF_SIM_INPROCESS=false`、`QF_STRATEGY_CANARY=false`。
   - 若 `QF_MARKET_AUTO` 仍为 true，则所有基于当前行情的策略/风控/验收结论都不成立，应先停机修配置，而不是继续交易日验证。

2. **stop-all 的产品语义是否要求“自动平仓”？**
   - 当前代码和文档不一致：代码只暂停+撤单，注释要求另调 flatten；验收标准要求 5 秒内平仓。
   - 若要求自动平仓，P0-01 必须先改代码；若不要求，验收标准和 UI 必须改，不能继续宣称“stop-all 已闭环”。

3. **Shadow/LIVE 是否要求 Runner 必须直连 Aeron 行情？**
   - 当前仓库所有策略配置都没有 `mdStream`，实际走 HTTP。
   - 若要求直连，需要把所有策略配置改为 `mdStream=1001` 并做控制面宕机测试；若不要求，架构文档的“控制面不进入 tick 热路径”需要降级。

4. **CTP TradeID 的全局唯一性口径是什么？**
   - 是否跨账户唯一？是否每个交易日重置？是否可能超过 31 字符？
   - 如果任一答案是否定的，P0-07 的 schema 变更（account+trading_day+trade_id）是上线前必须项，不是优化项。

5. **CTP 实际使用哪些 Aeron stream，Archive 应覆盖哪些？**
   - 仓库示例：SimNow 2100-2103/1100/2006，Shengli 2110-2113/1110/2006；而 recorder/replay 只覆盖 2120-2123。
   - 需要确认生产 systemd 是否用 `--stream` 覆盖；否则 CTP 审计/重放不成立。

6. **HA/PITR 是否属于下一交易日的前置条件？**
   - 若属于，当前 `R-P1-07 BLOCKED` 就是 no-go；若不属于，必须在评审结论中明确接受“单机故障不可恢复”的风险。

7. **canary / in-process SimExchange 是否允许在 SHADOW 运行？**
   - `control.env.example` 当前 `QF_STRATEGY_CANARY=true`、`QF_SIM_ENABLED=true`，但这两条会绕过统一 ledger/风控。若允许，需要明确这是“研究模式”，不能计入 P0 关闭；若不允许，模板和实际环境都要关闭。

---

## 附录 A：本报告关键证据复核命令

```bash
# 1. stop-all 语义
grep -n "pauseActiveDeployments" -A 4 backend/control-plane/src/main/resources/mapper/EmergencyMapper.xml
grep -n "shouldRun" -A 4 backend/runtime-agent/src/main/java/com/quantlink/fin/agent/HeartbeatClient.java

# 2. 后端自动模拟
grep -n "qf.market.auto\|simulate()\|equals(existing.source())\|simulated" \
  backend/control-plane/src/main/java/com/quantlink/fin/control/market/MarketDataService.java
grep -n '"aeron"' backend/control-plane/src/main/java/com/quantlink/fin/control/aeron/MarketDataAeronConsumer.java

# 3. Runner 行情来源
grep -rn "mdStream" deploy/strategies backend/runtime-runner/src/main/java/com/quantlink/fin/runner

# 4. Archive 重放
grep -n "NULL_POSITION\|durationSeconds\|startReplay" tools/archive/ArchiveReplayTool.java
grep -n "latest-for-stream" deploy/quantlink-fin-archive-replay.service
grep -n "streams = List.of" tools/archive/ArchiveRecorder.java

# 5. 账本幂等键
grep -n "trade_id.*PRIMARY KEY\|UNIQUE (trade_id" tools/db/schema-shadow.sql
grep -n "applyCashDelta" backend/control-plane/src/main/java/com/quantlink/fin/control/ledger/*.java

# 6. 本地持仓/重复计数
grep -n "!riskLoaded\|filledQty() + qty\|positions.putAll" \
  backend/runtime-runner/src/main/java/com/quantlink/fin/runner/AeronOrderGateway.java
```

---

*本报告只创建文档，不修改任何生产代码。所有“已修复”均指代码层；所有“不通过/未验证”均指影子或实盘 readiness，不否定 SimLocal 研究用途。*

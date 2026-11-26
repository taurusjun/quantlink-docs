# 架构师审查修复状态（新分支）

分支：`feature/architect-review-fixes`  
基线：已合并 `main@fb9f828`（日志重构）

合并提交：`200c5aa`（已推送 main）（包含 sim-venue、7x24、场所对账、健康 fail-closed）

## P0 状态

| 编号 | 状态 | 修复 |
|---|---|---|
| P0-01 stop-all | 已修 | deployment 改 `PAUSED`；stop-all 顺序 pause→cancel→flatten→stop；取消状态补齐 `SENT/ACK_TIMEOUT/CANCEL_FAILED` |
| P0-02 auto-sim | 已修 | `qf.market.auto` 默认 false；simulated 不得覆盖 `aeron/ctp/external`；模板补 `QF_MARKET_AUTO=false` |
| P0-03 HTTP 行情 | 已修 | 策略配置补 `mdStream`；Aeron order mode 缺 `mdStream` 且未显式允许 HTTP 时启动失败 |
| P0-04 Archive | 已修 | Recorder 覆盖 2006-2009/2100-2103/2110-2113/2120-2123/3120-3123；启动时重挂；venue/ORS 重启写 archive-rearm；replay 读取 checkpoint 且只回放 update/trade 流，不回放 order request；SimExchange orderId 持久化去重 |
| P0-05 OrderUpdate | 已修 | SBE `OrderUpdate.sequence`；Sim/CTP/SimVenue 持久化单调序号；DB `last_update_seq` 先比序号再比时间；`filled_qty` GREATEST；`filledQty` 本地只增不减 |
| P0-06 consumer 位点 | 已修 | 失败时 checkpoint 不前进；成功后才推进；持久化 `aeron_consumer_failures`；订单/成交/请求内存重试并设上限，避免旧回放永久自旋；checkpoint 取多 image 最大位点 |
| P0-07 账本键 | 已修 | trades 主键 `(account_id,trading_day,trade_id)`；ledger 唯一键含 account；settlement reference 含 account |
| P0-08 本地持仓 | 已修 | 每次 risk 刷新用权威快照重置；trade 去重文件持久化 `(account,tradingDay,tradeId 命名空间)`；filledQty 累计只增 |
| P0-09 结算/保证金 | 已修（CTP 数据待验） | positions 增加 long/short 独立均价；开平按 offset 分方向处理；结算按多空两边 PnL/保证金；重复结算返回历史；成交后按 `instrument_margins` 重算盘中保证金；CTP AccountSnapshot 落 `account_snapshots` |
| P0-10 场所对账 | 已修（CTP 待验） | SimLocal TTL/account/filled/原子快照 + 自动修复缺失单；SimVenue health/sequenceGap；CTP AccountSnapshot + ReqQryOrder/ReqQryTrade 快照落库并做 CTP_VENUE 对账 |
| P0-11 手工/canary | 已修（LIVE 待验） | 手工单接入日历/时段/行情龄/账户限额/5% 价格笼子/LIVE 四眼；canary 非 TEST 禁用、走统一 `ExecutionLedgerService`、强制账户限额；CTP 分方向保证金依赖交易日配置 |
| P0-12 CTP orderMeta | 已修（CTP 待验） | orderMeta 持久化 FrontID/SessionID/requestId/strategyKey；登录后 `ReqQryOrder` 回填；撤单使用订单原 FrontID/SessionID |
| P0-13 持仓快照 | 已修 | 整批事务；timestamp 与最新成交时间比较；缺失合约定向删除而非 delete-all；long/short 均价随快照落库 |

## P1/P2 进展

| 编号 | 状态 | 修复 |
|---|---|---|
| P1-01 对账刷新 | 已修 | `refresh` REPEATABLE_READ；STRATEGY + ACCOUNT scope；reconciliation_runs 历史；grace cycles；risk 只读缓存 |
| P1-02 今昨仓拆单 | 已修 | 应急 flatten 按 today/yesterday 拆腿；StrategyOrderService 对 SHFE/INE 混合 CLOSE 自动拆两笔 |
| P1-03 收盘双 owner | 已修 | Pair Runner 独占 futures_pair 收盘；两腿失败重试失败腿并保留残腿日志；Scheduler 跳过 pair |
| P1-04 交易日归属 | 已修 | `TradingCalendarService.tradingDayFor` 支持夜盘归属；orders/trades 显式写 trading_day；日限额按 trading_day；修复 Set 无序导致跳到错误交易日 |
| P1-05 订单 ID | 已修 | control-plane `order_id_blocks` 原子分配；Runner 启动/耗尽时取一块，不再用毫秒取模；12 位空间校验 |
| P1-06 配置 hash | 已修 | hash 覆盖 strategy + pair + common；Pair 只在 deployment generation 变化且空仓时热加载；LIVE rollback 走四眼 |
| P1-07 审计链 | 已修 | advisory lock；SHA-256；id/created_at 纳入 hash；retention 已改为不 DELETE append-only 表 |
| P1-08 安全 | 已修 | Agent token 绑定；RISK 可执行 emergency POST；Basic 登录失败锁定；SimNow/SimShengli 均走加密 CTP 配置；密钥目录/模板权限已修正 |
| P1-09 SimLocal 语义 | 已修 | targetAgent/fencing 校验；账户/挂单/现金/手续费/已实现 PnL 快照恢复；today/yesterday 分桶并随快照恢复 |
| P1-10 配置缺失 | 已修 | fee/multiplier 缺失拒绝成交/结算；available 缺失拒绝开仓；Runner/策略/手工单在账户限额缺失时拒绝开仓；已为全账户补限额 |
| P1-11 备份/运维 | 部分 | db-backup service+timer 已启用并验证；replay 失败重启；Archive 磁盘/写入 lag 监控 timer；HA/PITR 演练仍受单机资源限制 |
| P1-12 自动化测试 | 部分 | 增加交易日历、Agent token、SBE sequence、position avg、成交幂等、分方向结算、CTP 快照替换、Postgres Testcontainers schema 约束测试；故障注入演练未做 |
| P1-13 runbook | 已修 | 补配置真相、行情 provenance、stop-all、控制面宕机、Archive replay、Adapter 重启、证据清单 |
| P2-05 SimExchange 状态 | 已修 | snapshot 增加 cash/fees/orders/realisedPnl，启动恢复 open orders/account/positions |
| P2-07 模板默认 | 已修 | 模板改为 `QF_AERON_ENABLED=true`、`QF_RECON_GATE_ENABLED=true`、canary=false |
| P2-06 结算/手工审批 | 已修 | 结算写入审计并接 LIVE 四眼；手工大单接 LIVE 四眼 |
| P2-04 WS ticket/CORS | 已修 | WS ticket 改 HttpOnly SameSite cookie，不再放 URL；CORS 收敛到固定开发/生产源；审计 SHA-256 |
| P2-03 Archive 保留 | 已修 | ArchiveRetentionTool + 周度 timer，默认保留 30 天，活跃 recording 跳过 |
| P2-08 Aeron 背压 | 已修 | Sim/ORS/CTP publish 改为 5 秒有界等待，超时抛错而非无限自旋 |

## 验证

```text
./gradlew test PASS
control-plane / runtime-agent / sim-exchange / sim-venue / archive-recorder 已部署
market ticks source=aeron
SimLocal venueReconciliationPass=true
order_id_blocks 已分配且不重复
aeron_consumer_positions 与 replay checkpoint 一致
trades 主键 (account_id,trading_day,trade_id) 已生效
positions.long_avg_price/short_avg_price 已迁移
```

## 仍需交易日/环境验证

```text
CTP ReqQryOrder 回填与 Adapter kill -9 恢复
CTP AccountSnapshot/CTP_VENUE 对账
CTP 多空并存/盘中保证金/结算改价重跑
Archive 在 CTP adapter 重启后的 recording 重挂
stop-all + 持仓 + drain 实测
控制面 10 分钟宕机 + replay 恰好一次
5 日长稳 / HA / PITR / Windows Electron
```

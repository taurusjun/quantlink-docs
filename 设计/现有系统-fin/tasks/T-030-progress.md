# T-030 Progress Ledger

Read this first on every T-030 turn. Do not stop because a phase is complete.
Pick the first unchecked item, implement it, test it, update this file, commit,
then continue. Only true external blocks or exhaustion of this ledger end a turn.

## Done

- [x] Phase 0/1 core schema, clean V2 bootstrap, no compatibility backfills
- [x] Explicit book/strategy/account/counterparty/exchange attribution writes
- [x] Account permission enforcement for manual orders and strategy center
- [x] Strategy closeable validation (strategy + account, stricter wins)
- [x] Book positions for MANUAL/UNASSIGNED
- [x] Strategy binding four-tuple immutable; fork/version records
- [x] Version carry guard (409 unless carry=true)
- [x] Strategy center overview/detail/account/unassigned/claim/fork/version
- [x] V2 strategy center UI: list, detail, accounts, unassigned, books, manual order, create strategy
- [x] Delete V1 pages and top venue selector
- [x] V2 orders/trades page with account/strategy validation
- [x] SBE v2 schema fields + Java/C++ codegen + round-trip test
- [x] Emergency scopes STRATEGY/ACCOUNT/ALL backend + strategy detail action
- [x] SimVenue clean E2E manual order 900000000021

## Next queue

- [x] Runtime order gateway fills SBE v2 book/counterparty/exchange/environment fields
- [x] Fill account/environment in SimVenue and CTP update/trade producers; book/deployment remain control-plane enrichment
- [x] Build V2 option chain / monitoring pages without top venue selector
- [x] Version creation + carry deploy UI
- [x] Non-carry version deploy stops/flattens before redeploy; carry path explicit
- [x] Deployment rollback UI
- [x] Add ACCOUNT emergency UI
- [x] ALL emergency via existing stop-all control
- [x] Archive replay timer restored; stale recording cleanup is maintenance follow-up, not a code task
- [x] Playwright headless smoke for strategy center/orders/options/monitoring
- [x] Final regression + evidence refresh
- [x] MarketDataService accepts scoped `(counterparty, exchange, instrument)` ticks; strategy PnL and option-chain API prefer scoped ticks

## Next queue (unfinished issues)

- [x] Account PnL snapshot realized/fees from ledger entries
- [x] Account PnL snapshot unrealized from positions
- [x] CTP C++ adapter full build with Linux CTP SDK and Aeron source/lib
- [x] Playwright manual/new-strategy dialog interaction
- [x] Playwright claim interaction
- [x] Playwright fork/version/emergency interaction
- [x] Shared-account multi-strategy closeout E2E on SimVenue (A=2/B=8/account=10)
- [x] Clean test data after evidence capture; clean bootstrap leaves 8 books and zero execution rows
- [x] SBE attribution boundary decided: venue fills account/environment; control plane enriches book/deployment from order ownership

## 2026-11-09 设计缺口补齐

- [x] 策略详情显示“标的 / 合约”
- [x] 策略详情显示“策略指标”（含未采集状态）
- [x] Pair 详情显示第一腿/第二腿与 pair 配置
- [x] Pair 向导写入 `strategy_pair_configs`，并生成价差指标
- [x] Pair 编辑双腿、复制（Fork）复制 pair 配置和指标
- [x] 策略列表/详情增加“编辑策略”“复制策略”入口
- [x] 绑定展示只保留“规则 + 账户”，交易员页面隐藏 Agent/ORS
- [x] 新增 `TC-T030-062~067` 与 `tools/e2e/t030-pair.mjs`
- [x] Pair 策略真实双腿成交/对冲/平仓 SimVenue E2E（2026-11-10 历史回放通过；证据 `docs/evidence/T-030/historical-replay-20261110.md`）

## 2026-11-09 真实数据闭环（本轮）

- [x] `IndicatorEngine` 改为有界队列 + 单线程异步消费，行情线程只 `offer`，不查库不计算
- [x] 指标按 `indicator_defs` 动态计算，不再只写硬编码 ID；`indicator_values` 从 0 增至 479+
- [x] 16 个指标定义有实时值：组合 Delta/Vega、IV、IV Rank、RR25、Spread、Pair Spread/ZScore/HedgeLatency
- [x] `strategy_pnl_snapshot` 表 + 5 秒落库；策略 PnL 后台每秒计算并通过 WebSocket 推送
- [x] 策略详情显示账户权威 PnL（含 deposit/withdraw）
- [x] Pair 真实双腿 E2E：ag2612 买 1、au2612 卖 1 均 FILLED；双腿平仓、无归属平仓拒绝、PnL 实时
- [x] SimNow `Deposit/Withdraw` 字段确认已从 CTP 取到，当前值为 0（当日无出入金事件）

### 仍未闭环（初判）

原始 T-030-01 ~ T-030-41：**29 项可判定闭环，12 项部分/未闭环**。

| 任务 | 状态 | 缺口 |
|---|---|---|
| T-030-16 策略 PnL | 部分 | 实时值和快照已有；FIFO/账户对账/历史曲线未完整验收 |
| T-030-17 账户 PnL | 部分 | deposit/withdraw=0；无非零出入金；`preBalance`/资金流水未展示 |
| T-030-22 策略详情 | 部分 | 缺 PnL、风险、对账、日志 Tab；当前是概览+指标+持仓/订单/成交/版本 |
| T-030-29 手工簿页面 | 部分 | 只有策略中心内手工簿 Tab/手工单，无独立手工簿详情与动作 |
| T-030-31 策略版本 | 部分 | “编辑策略”更新基础配置，未生成新草稿版本 |
| T-030-33 部署状态机 | 部分 | drain/审批/失败回滚未完整演练 |
| T-030-36 账户/全局应急 | 部分 | 顶栏动作存在，范围预览/审批验收不完整 |
| T-030-37 手工簿应急 | 未完成 | 无手工簿撤单/平仓/只减仓的独立动作 |
| T-030-38 LIVE/SHADOW | 部分 | 标签存在，LIVE 审批/红色确认未完整验收 |
| T-030-39 柜台健康 | 部分 | 监控页存在，按柜台/交易所下钻与故障注入未验收 |
| T-030-40 迁移与双跑 | N/A/部分 | 本次采用 clean bootstrap，不做 V1 回填；双跑/回滚未执行 |
| T-030-41 回归与证据 | 未完成 | 尚缺完整 TC 执行、性能/Chaos、最终交易员验收 |

新增跨领域任务：

- [x] T-030-42 指标动态采集
- [x] T-030-43 策略 PnL 快照与 WebSocket 推送
- [x] T-030-46 Pair 真实双腿 E2E
- [x] T-030-47 SimNow 账户定时查询（CTP adapter 30s，`account_pnl_snapshot` 持续更新）
- [x] T-030-48 费率/保证金刷新（SimNow + 盛立均已验收）：
  已改为复用 Agent 现有 CTP 会话生成快照，systemd 只做导入，不再另开 CTP 登录；
  CTP 查询按 1.1 秒流控串行，记录 `ReqQry...` 返回码。
  2026-11-11 02:35 timer 自动导入 SimNow；08:34 双账户导入成功：
  TEST-001 au2612 / ag2612，TEST-SHENGLI au2612 / ag2612 均已更新。
  新增 `fee_money_open/close/close_today` 与 `fee_volume_*` 列，
  `ExecutionLedgerService` 按 offset 取费；乘数由合约主数据补齐。
  盛立 ORS 已于 08:10 恢复 `LOGGED_IN`，不再跳过。
- [ ] T-030-44 驾驶舱完全数据驱动（组合层仍 2 秒轮询；T-018 图表/数据龄未完整）
- [ ] T-030-45 SimNow 资金流水/preBalance 与非零出入金验收

## 2026-11-09 交易员 review 后修订

独立交易员 review 报告：`docs/reviews/trader-review-2026-11-09-t030-truth-data.md`。
结论：T-030 不能宣称完成；原 41 项仅 5 项完全闭环，36 项未闭环。
P0/P1/P2 全部问题已进入 anti-stop 未完成任务表，不再只修前 5 个。

本轮已开始修复：

- [x] P0-01 驾驶舱权益改为只读最新 `account_pnl_snapshot.equity`；
  不再用 `accounts.balance + pnl`；覆盖不足显示 `PARTIAL`。
  当前仍只有 TEST-001 有快照，因此显示 1/4，不伪装全量。
- [x] P0-03 `account_pnl_snapshot.trading_day` 改用交易日历；
  夜盘新快照已写 `2026-11-10`，不再是 `CURRENT_DATE`。
- [x] P0-05 账户未分配按 `账户 - 策略 - 手工` 计算；
  TEST-001 现在显示 ag2706 `-88`、au2612 `+4`，不再显示 0。
- [x] OPS-01 fee/margin 工具收回本仓库：
  `ctp-adapter/src/fee_refresh_main.cpp` + `tools/build_ctp_fee.sh`；
  现已由 CTP adapter 复用 Agent 登录会话生成快照，`qf-fee-refresh` 不再参与
  定时刷新，避免第二次 CTP 登录踢掉 Agent。
- [x] 2026-11-10 fee/margin 复用 Agent CTP 会话：
  CTP adapter 在 15:05/02:35 用现有登录查询 fee/margin，原子写
  `/var/lib/quantlink-fin/fee/<account>-fees.csv` / `-margins.csv`；
  `quantlink-fin-fee-refresh.sh` 只等待新快照并调用现有 import API，不再执行
  `qf-fee-refresh` 独立 CTP 登录。手动触发验证得到
  `fee refresh returned no rows`，说明链路已走到 CTP，但 SimNow 柜台未返回查询结果。
- [x] P1-01 策略详情补齐 PnL / 风险 / 对账 / 日志 Tab：
  - PnL：Agent 快照曲线、已实现/浮动/费用拆分、来源/估值/数据龄
  - 风险：账户权益/保证金占用、策略净数量、名义敞口、最大单合约敞口
  - 对账：`reconciliation_status` 的 passed/issue/连续失败/差异明细
  - 日志：`audit_log` 按策略目标与 payload.strategyId 过滤
  - 证据：`docs/evidence/T-030/p1-01-strategy-detail-tabs.png`；`tools/e2e/t030-detail-tabs.mjs`
- [x] P1-02 手工单提交前预览：
  - 预览显示名义/保证金/可用/合约类型/交易所/解析开平/TIF/环境
  - 未通过预览禁止提交；名义 >=5 万需勾选二次确认
  - 提交时按当前字段重新预览，避免旧预览覆盖改价/改量
  - 证据：`docs/evidence/T-030/p1-02-manual-order-preview.png`；`tools/e2e/t030-manual-preview.mjs`
  - 仍未做：服务端 previewId/accountVersion 绑定；当前由提交前重校验兜底
- [x] P1-03 订单/成交复盘入口：
  - 策略筛选 + URL `strategyId` 深链；策略详情“订单/成交”直接跳转
  - 默认今日，可切全部；显示 asOf；当前页 CSV 导出
  - 订单/成交显示 environment；新增“总持仓”Tab，按账户分组
  - 证据：`docs/evidence/T-030/p1-03-orders-filters.png`；`tools/e2e/t030-orders-filters.mjs`
  - 仍未做：独立 `/positions` 路由、跨页全量 CSV、排序/列配置
- [x] P1-10 / P1-12 期权链真数据：
  - CTP Aeron 行情按 route.venue_id 写入 venue-scoped tick；期权链不再 fallback 到全局合约
  - OI/Volume 来自 SBE 真实字段；新增理论价（ATM IV）、数据龄、Greeks 切换（Δ/Γ/Vega/Θ）
  - 无报价/无样本显示 N/A；900/940/1050/1100 等无 tick 保持 N/A
  - 2026-11-10 修复全 N/A：
    - 同一 Aeron MD stream 的订阅去重只按 stream，导致 SIMVENUE/SIMLOCAL 等共享 1001 的柜台没有 scoped 副本
    - 去重键改为 `channel|stream|counterparty`，每个柜台独立写入 scoped tick
    - CTP 适配器启动增加 `ReqQryDepthMarketData`，控制面重启后用柜台最后盘口补种子
  - 实测：SIMVENUE/SIMLOCAL 900P `6.79/6.81`、920C `1.79/1.81`、IV `0.108`
  - SimNow 当前无数据：收盘后重启适配器 CTP 登录失败，ORS 已 HALTED（`ORS exited 3 times`），需下一个会话/手工释放
  - 证据：`docs/evidence/T-030/p1-10-option-chain.png`；`tools/e2e/t030-option-chain.mjs`
  - 仍未做：合约实际到期日（当前按到期月月末估算）、IV chg 历史、Vega 单位统一为每 1 vol point
- [x] P1-06 策略持仓已实现/费用/行锁/日终：
  - `applyFill` 同事务写入 `strategy_positions.realized_pnl/fees`，按策略自身均价和合约乘数计算
  - `findForUpdate` 行锁；成交事务内读取并更新，避免并发平仓超卖
  - 日终结算同步 `strategy_positions/book_positions` 的 today→yesterday
  - 单测：`StrategyPositionServiceTest`、`SettlementServiceTest`
  - 仍未做：部分成交跨多笔的逐笔 FIFO 明细（当前按策略均价汇总）
- [x] P1-04 环境标签：
  - 策略列表/详情显示 SHADOW/LIVE chip；LIVE 红色并提示实盘
  - 编辑、版本更新、停止平仓在 LIVE 下要求二次确认
  - 订单/成交已有 environment 列；手工单确认显示 SHADOW
  - 仍未做：服务端 `LIVE_ACK` 签发与强制校验；当前为前端确认
- [x] P1-08 账户 PnL 异常值防护：
  - 写入前校验 `|unrealized| > qf.account.pnl.max-abs`（默认 1 亿）直接拒绝并记录错误
  - 迁移 `migrate-t041` 将 14 条历史异常标记 `stale=TRUE, source=REJECTED_OUTLIER`，不删除
  - 新增 `(account_id, as_of DESC)` 索引
- [x] P1-05 指标阈值服务端评估：
  - `indicator_defs.warning_threshold/critical_threshold` 进入采集定义
  - 值 >= critical 置 `CRIT` 并 raise P1；>= warning 置 `WARN` 并 raise P2；恢复正常后 resolve
  - 指标中心原有 WARN/CRIT 颜色与计数生效
  - 仍未做：指标版本/引用/停用保护；阈值方向目前统一按“越高越差”
- [x] P1-07 策略/账户 PnL 差异可见：
  - 账户详情新增 `pnlAttribution`：已发布 Agent 策略浮动合计、账户快照浮动、差额、覆盖率
  - 差额明确标注含手工/未分配/未发布策略，不自动配平、不伪造覆盖
  - 仍未做：把差额阈值接入对账 Gate 阻断开仓；当前只读展示
- [x] P0-06 策略编辑/状态/回滚治理：
  - 编辑非运行策略生成 `vX-draft-<timestamp>` 草稿版本并写审计；ACTIVE/SHADOW/RUNNING/DEPLOYING 部署拒绝直接编辑
  - `POST /strategies/{id}/status` 拒绝 ACTIVE/PAUSED，必须走 deployment activate/deactivate
  - 部署回滚同步更新 `strategies.current_version/version`
  - 仍未做：完整 drain/审批/失败回滚状态机演练
- [x] P0-09 固定种子行情隔离：
  - 删除启动时 `seedFixedTicks`，不再把固定 au/ag 价格注入驾驶舱/PnL
  - 策略 PnL 估算移除全局 instrument fallback；无 scoped tick 按成本计价（零浮盈），不跨柜台借价
  - 仍未做：驾驶舱逐值 age 颜色/冻结报价全量覆盖；行情断线整页降级
- [x] P2-07 旧策略详情路径清理：
  - 顶栏提醒“查看策略”跳 `/strategy-center`，不再跳已删除的 `/strategy-view`
  - 文档标题不再有旧路径特判
- [x] P2-04 策略列表状态：部署状态 + strategy_status 双 chip，带英文 tooltip；挂单数保留
- [x] P1-09 手工簿独立页面：
  - `/manual-book` 只读 `book_type=MANUAL` 的持仓/订单/成交
  - 按簿撤单 `POST /api/v1/manual-book/orders/{id}/cancel`，校验 MANUAL + 账户交易权限
  - 平仓对话框复用手工单 preview/二次确认，reduceOnly=true
  - 账户只减仓开关复用 `/emergency/reduce-only`
  - 证据：`docs/evidence/T-030/p1-09-manual-book.png`；`tools/e2e/t030-manual-book.mjs`
  - 仍未做：手工簿独立“只减仓”范围（当前为账户级）、批量撤单/平仓
- [x] P1-11 幽灵对账 scope 清理：
  - `cleanup-t042` 删除不存在策略的 `reconciliation_status` 17 条、`reconciliation_runs` 76 条
  - 清理后 `reconciliation_status` 仅 4 账户 + 3 现存策略；books=11 为 4 账户 MANUAL/UNASSIGNED + 3 策略簿，属正常
  - 现存 3 个策略/6 订单/5 成交保留作为回归证据
  - 仍未做：E2E 数据隔离 schema；测试脚本需在结束后自动清理
- [x] P2-05 账户下钻：
  - 账户详情已有策略/持仓/手工簿/未分配；新增未分配成交表与“订单/成交”跳转（带 accountId 过滤）
  - 仍未做：账户行直接在列表内展开、未分配认领入口在账户详情内
- [x] P2-06 数据保留：
  - `RetentionTask` 每日 03:30 清理 `indicator_values`(14d)、`strategy_pnl_snapshot`(30d)、`reconciliation_runs`(30d)
  - 三表总大小超过预算（默认 4GB）raise `RETENTION_TABLE_SIZE` P2，恢复后 resolve
  - 单测：`RetentionTaskTest`
  - 仍未做：冷归档到对象存储/分区表；仅删除，不做降采样
- [x] P1-05b 指标版本/引用：
  - `indicator_defs.version` + `indicator_versions` 历史归档；口径字段变化自动 archive+bump
  - `indicator_values.version` 由当前定义版本写入；历史 API 返回 version
  - 策略引用中的指标禁止直接停用，需先解绑（409）
  - 实测：创建 v1 → 改参数 v2，归档 v1；绑定策略后停用返回 409；测试数据已清理
  - 仍未做：UI 版本历史抽屉/引用关系图（P2-03）
- [x] P2-03 指标详情：
  - 指标卡片“详情”抽屉：ID/类型/合约/周期/版本/单位/启用/引用策略
  - 公式参数、最后计算、历史曲线 + 最近样本、冻结版本表
  - 证据：`docs/evidence/T-030/p2-03-indicator-detail.png`；`tools/e2e/t030-indicator-detail.mjs`
- [x] P2-01 策略列表体验（部分）：
  - 搜索、收藏（localStorage）、最近（打开策略记录）、URL `q/favorite` 同步、CSV 导出
  - 列配置（标的/交易所/版本，localStorage 保存）、打印/PDF
  - 证据：`docs/evidence/T-030/p2-01-strategy-list.png`；`tools/e2e/t030-strategy-list.mjs`
- [x] P0-09 驾驶舱数据龄（部分）：
  - 策略 PnL 卡片显示 asOf age：>1s 黄、>5s 红
  - 策略指标 chip 显示 age 颜色；账户组合快照 chip 显示 age 颜色
  - 新增账户持仓表：逐持仓 mark price + age（>1s 黄、>5s 红、无 tick N/A）
  - WS 断开显示整页红色告警“报价/PnL 可能过期”
  - 证据：`docs/evidence/T-030/p0-09-position-age.png`
- [x] P0-11a 迁移/回滚：
  - 新增 `migrate-t046-strategy-center-v2-safe.sql`：无 TRUNCATE，保留现网执行数据
  - book/counterparty/exchange 可空加列 → 回填 → 校验 → SET NOT NULL
  - `validate-t046` 9 项检查全部 0 失败；同一事务内连续执行两次通过
  - `rollback-t046` + safe 重建在同一事务内演练通过
  - 已生成 shadow 备份 `/tmp/qf-shadow.dump`（5MB）
  - 已完成恢复演练：临时库 `qf_restore_test` 恢复成功；strategies=3、orders=6、trades=5、books=11 与源库一致
  - account_pnl_snapshot 恢复 6415 行 vs 源库 7535 行，差异来自备份期间持续写入，非结构/数据丢失
  - 仍未做：V1/V2 双跑对比
- [x] P0-12a SimVenue 测试账户重置：
  - 按方案 A 重置 SimVenue 测试账户：ag/au 遗留持仓清除，保留本地/柜台一致的 auC920 +1
  - 因旧 3120 stream 会在重启时重放历史订单，测试账户切到 3140-3143 独立流；DB ors_instances 同步
  - 对账门恢复：ag 开仓预览不再报 VENUE mismatch；当前仅因行情过期拒绝
  - 仍未做：Pair 双腿 E2E 需行情恢复后重跑
- [x] P0-12 Pair E2E（2026-11-10 历史回放通过；venue/本地 ag/au flat，对账 passed；订单 deployment/route/fencing 字段仍有缺口）：
  - 口径定义：SimVenue 作为独立交易所时，venue snapshot 是账户持仓/现金/挂单的权威；控制面 `positions` 是物化快照；归因等式为 `strategy + manual + unassigned = venue`
  - 差异处置：不得静默改本地库配平；新开仓由对账门阻断。测试环境优先清空/重置 SimVenue 测试账户后重跑；生产环境将差异落为未分配并走认领/核账
  - 当前差异：venue `ag2612 +1 / au2612 -1`，本地 0；需先选择“重置/平仓测试账户”或“按 venue 记账后认领”
  - 尝试激活 deployment 25 并下 ag2612 买单，策略下单返回 422
  - 原因：`SIMVENUE_VENUE` 对账 `ag2612 local=0 venue=1`、`au2612 local=0 venue=-1`
  - 已恢复 deployment 25 为 INACTIVE/STOPPED；未绕过对账门
  - runtime-agent-simvenue 已修复端口冲突（19101→19103）并运行
- [x] P0-10a 订单 fencing/generation/epoch：
  - `orders` 写入 `deployment_id/deployment_generation/order_epoch`，保留 `route_id/fencing_token`
  - OrderUpdate 消费校验：fencing 不一致 → `FENCED`；generation/orderEpoch 落后 → `STALE_UPDATE`
  - v1 producer 未填字段（0）保持兼容
- [x] P0-10b SBE v2 合同与分流：
  - 新增 message id 20-24（OrderRequest/Update/Trade/Cancel/PositionSnapshot V2）
  - Java/C++ codegen 完成；v1 消息保留
  - runtime-runner 下单切 V2；CTP bridge、SimExchange codec、control-plane consumer 按 templateId 分流 v1/v2
  - 停机窗口内部署并重启 CTP/control/runtime-agent/sim-exchange，服务均 active
  - Java V2 round-trip + C++ codec/interop 测试通过
  - 已删除 v1 兼容分支：CTP/SimVenue/SimExchange/control-plane/ManualOrderPublisher/OrsAeronGateway 只发/只收 V2
  - 手工单实测：V2 OrderRequest 发布成功，V2 CancelRequest 撤单成功
  - 仍未做：FENCED/STALE_UPDATE 告警重放演练
- [x] P0-01 账户快照口径：
  - 账户列表/详情 `equity/available/margin` 只读最新 `account_pnl_snapshot`；无快照显示 N/A，不再用 `accounts.balance` 冒充
  - 显示 snapshot source/as_of/stale
  - SimVenue/SimLocal 已通过 `AccountSnapshotPublisher` 每秒发布柜台快照；实测四账户均有 COUNTER 快照：
    `SIMLOCAL-001 9,823,010.49`、`SIMVENUE-001 9,999,998.16`、`TEST-001 22,579,969.04`、`TEST-SHENGLI 951,444.92`
  - 模拟柜台当前为现金账户模型：`margin=0, available=equity`
- [x] P0-03 账户 PnL 字段分离：
  - `cash` 不再写 available；新增 `available/margin/pre_close_equity` 列
  - 修复 Shengli 余额为 0 的根因：
    - `accounts.balance/available/margin` 自 11-07 后未随 CTP 快照更新
    - `account_pnl_snapshot.cash` 被 SQL 硬编码为 0
    - 组合查询把 `p.cash` 当作 available
  - 修复：账户快照落库后同步更新 `accounts`；`cash=balance`；组合查询 available 取 `account_snapshots.available`
  - 手工回填并重启 Shengli CTP 适配器触发查询，15:59:22 新快照：
    `TEST-SHENGLI balance/equity=721314.92 available=212623.92 margin=508661.00 cash=721314.92`
  - 仍未做：AccountRegister 资金流水与非零出入金 E2E
- [x] 统一任务调度管理 P1：
  - `scheduled_jobs` / `scheduled_job_runs` + `migrate-t052-scheduled-jobs.sql`
  - `GET/PUT /api/v1/scheduled-jobs`，`POST /{key}/run`，`GET /{key}/runs`
  - INTERNAL：portfolio_snapshot / indicator_history / retention_cleanup，统一 tick 执行并记录运行历史
  - AGENT/ctp_close_query 与 SYSTEMD_READONLY/fee_refresh 只读展示；手动触发返回 409，避免在错误边界另开 CTP/systemd
  - `/scheduler` 页面：任务表、编辑计划、立即执行、运行历史抽屉
  - 实测：手动 run SUCCESS、SCHEDULE tick SUCCESS、AGENT 409、next_run_at 正确
- [ ] 其余 P0/P1/P2 见 anti-stop 任务表。

## 2026-11-10 回归与证据

- [x] `./gradlew test` 全量通过
- [x] `pnpm --filter @quantlink-fin/web typecheck` 通过
- [x] `pnpm --filter @quantlink-fin/web build` 通过
- [x] Playwright：`t030-smoke`、`t030-detail-tabs`、`t030-manual-preview`、`t030-orders-filters` 通过
- [x] 策略中心 overview 接口 200（修复误用 `strategy_deployments.mode` 导致的 500）
- [x] 期权链在午休无 scoped tick 时显示 N/A，不伪造行情；开市时段 OI/Vol/理论价/数据龄证据见 `p1-10-option-chain.png`
- [ ] 期权链 SimNow 回归：收盘后 CTP 登录失败导致 ORS HALTED；开市后需 activate 并复核 OI/Vol
- [ ] P1-09 手工簿独立页面/撤单/平仓/只减仓未完成
- [x] P1-11 E2E 测试数据隔离：`tools/e2e/isolated-db.sh` 创建一次性 DB、schema-only 启动 control-plane、退出自动 drop；已实测 `true` 命令后无残留 DB
- [x] P2-01~07 体验项收口：收藏/最近/列配置/CSV/PDF、指标版本与引用、账户下钻、数据保留、旧路径清理均已有实现；`pnpm --filter @quantlink-fin/web typecheck` 与 build 通过。剩余为非阻塞的视觉打磨。

## 2026-11-10 交易员体验修复

- [x] 新建策略向导按 V1 引导补齐：
  - 5 步：基本信息、标的与合约、风险与模式、指标与通用配置、账户与部署
  - 指标从指标中心多选，创建时复制为策略私有指标
  - 通用配置支持继承全局或策略覆盖；覆盖走 `/strategies/{id}/common-config`
  - 创建后部署为 INACTIVE，需人工激活
- [x] 策略列表行增加「激活 / 停用」入口，调用 deployment activate/deactivate
- [x] 手工簿增加「新建手工单」入口，支持账户/合约/方向/开平/价格/数量/TIF、预览、二次确认、提交
- [x] 顶部全撤/停全部并平仓/只减仓收进「应急」菜单，不再占用页面开头
- [x] 主内容取消 1680px 宽度上限；顶部状态缩短并在窄屏自动隐藏次要项，900/760px 无横向裁切
- [x] SimLocal 从新建策略、手工下单、手工簿账户选择中移除；手工单默认 SIMVENUE，后端空交易所默认也改为 SIMVENUE
- [x] 收盘时间管理：
  - `/api/v1/calendar/session-clock` 返回日盘/夜盘起止、当前活跃时段、剩余收盘分钟
  - 顶栏显示「日盘已收盘 15:00」或「日盘/夜盘 xx:xx 收盘，剩余 N 分钟」
  - 点击收盘状态打开盘后查询
- [x] 盘后查询：`/api/v1/calendar/post-close` 返回账户权益/可用/保证金和存储持仓；SIMVENUE-001 当前返回 au2612C920 多 1
- [x] 验证：`t030-trader-ux`、`t030-smoke` 通过，页面 900/760px 无横向溢出
- [x] 交易日历交易时段：
  - 日历页合约改为读取 `/api/v1/instruments`，不再写死 au2612
  - 日历格子直接显示所选合约的日盘/夜盘时段；点击日期弹出当天时段编辑
  - 可查看/保存所选合约 DAY/NIGHT 起止时间
  - 新增按日期覆盖 `trading_session_overrides`：支持某一天取消日盘/夜盘或改时间
  - 订单风控、Pair runtime sessions 读取生效覆盖；实测 2026-11-13 夜盘禁用后 pair runtime 不再返回夜盘
- [x] 编辑策略增强：
  - 合约改为从合约配置下拉选择
  - 增加最大持仓、最大亏损
  - 指标可勾选/取消；保存时复制新增指标、停用移除的策略私有指标
- [x] 修复运行态：
  - runtime-runner 仍用 v1 OrderUpdate/Trade 解码，已改 V2；Pair deployment ACK timeout 修复
  - 详情页策略状态改用 `strategy_status`，不再显示遗留 `strategies.status`
- [x] 部署改为数据库驱动：
  - 新增 `GET /api/v1/strategy-deployments/by-strategy/{strategyId}/runtime-config`
  - agent 按 `strategy_deployments + ors_instances + strategy config_json` 生成
    `/var/lib/quantlink-fin/deployments/deploy-<strategyId>.properties`
  - properties 只保留 agent/control-plane/ORS/Aeron 连接，不再配置 `instances`/策略命令
  - SimVenue agent 实测动态拉起 `deploy-SIMVENUE-OPT-01` 与 `deploy-PAIR-SIMVENUE-MW9C01BR`
  - deployment 24/25 均为 RUNNING；已删除 `/etc/quantlink-fin/strategies/sim-venue-opt.properties`
    和 `sim-venue-pair.properties`
- [x] 期权链默认柜台修复：
  - 页面默认从 SIMNOW 改为 SIMVENUE
  - 柜台改为下拉，显示有报价行权价数量
  - SIMNOW ORS HALTED 时明确提示无报价，不再让默认页全 N/A
- [x] SimLocal 下线与清理：
  - 停止并删除 `quantlink-fin-runtime-agent.service`、`quantlink-fin-sim-exchange.service`
  - 删除 `SIMLOCAL-001` 账户、`ors-simlocal-001`、`SIMLOCAL` venue、books、ledger、快照
    （account_snapshots 61k+、account_pnl_snapshot 14k+）、费率/保证金/权限
  - 删除 sim-local strategy properties、agent 日志、SimExchange snapshot 与 `/opt/quantlink-fin/sim-exchange`
  - seed 不再创建 SimLocal；SimExchange 默认账户改为 SIMVENUE-001
- [x] runner 改为直接读数据库：
  - `runtime-runner --deployment-id <id>` 从 `strategy_deployments + strategies + ors_instances` 读取配置
  - agent 不再生成 `/var/lib/quantlink-fin/deployments/*.properties`
  - 通用 runner 每 5s 读取部署版本/配置指纹；变化时先构建新 Strategy，再在 RuntimeEngine 内原子替换
  - Pair runner 每 5s 检查部署版本并刷新 pair 参数，不重启进程
  - 实测通用 `v1 -> v1-hot -> v1`、Pair `v0.1.0 -> v0.1.1`，runner PID 不变；
    日志分别出现 `hot-swapped` / `hot-loaded`
- [x] 账户会话与收盘查询：
  - CTP 适配器就是 agent 托管的 ORS 进程，账户/持仓查询在同一个登录会话内完成，不创建第二个 CTP session
  - 新增 `QF_QUERY_SCHEDULE_FILE` 计划（日盘 15:00 / 夜盘 02:30），适配器热读取；管理页日历可直接配置
  - CTP 适配器登录后写 health 文件；agent 心跳上报 `login_status/login_at`，`/execution` 显示已登录/未登录
  - 费率刷新脚本检测到活跃 CTP 登录时跳过独立登录，避免把 agent 会话踢下线
- [x] 消息到策略详情深链：
  - 消息中心点击行跳转 `/strategy-center?strategyId=...&tab=messages`
  - Dashboard「查看策略」与顶部消息“查看策略”都带 `strategyId` 深链
  - 策略中心自动打开对应策略详情并定位「消息」Tab
  - 策略详情新增「消息」Tab，展示该策略的提醒/确认记录
- [x] 管理面板可见内存策略：
  - runner 上报 loaded/pending/configFingerprint/hotSwapAt
  - `/execution` 新增「Agent 内存策略」表，显示内存版本和等待加载版本
  - `runtime_instances` 新增 loaded_version/pending_version/loaded_config_hash/hot_swap_at
- [x] 删除 control-plane 进程内 SimExchange canary：
  - 删除 `SimExchangeService`、`SimExchangeMapper` 及其 mapper XML
  - `StrategySignalService` 只记录 shadow order，不再提交 canary 委托
  - `StrategyExecutionService` 改为 `StrategyOrderExpiryService`，仅保留策略挂单 TTL 撤单
  - 移除 `QF_SIM_ENABLED` / `QF_STRATEGY_CANARY` 配置项
  - `./gradlew test` 通过；control-plane 已部署，`/api/v1/health` 返回 200
- [x] 修复 SimVenue 撮合/账户 bug：
  - 平仓回补名义本金并扣平仓手续费，`equity = cash + 市值` 不再因平仓丢失本金
  - 修正 `closeBucket` 买卖方向，FILLED 后 today/yesterday 持仓桶正确减少
  - snapshot v2 保存 today/yesterday 桶；v1 旧快照兼容恢复为 today
  - 非法委托返回 `REJECTED`，不再让 poll 因 `IllegalArgumentException` 中断
  - 默认账户从 `SIMLOCAL-001` 改为 `SIMVENUE-001`
  - 新增平仓多空、手续费、CLOSE_TODAY/CLOSE_YESTERDAY、旧快照兼容测试
  - `./gradlew test` 通过；SimVenue 已部署，health 正常
- [x] u50 历史期权回放：
  - `ReplayCli` 支持 `--publish --stream --speed --start --end --prefix`
  - `U50CsvReplayReader` 支持前缀和时间窗口过滤
  - `ReplaySimVenueTest` 覆盖 u50 tick → Aeron → SimVenue 成交
  - 服务器用 20260318 数据回放 au2612/ag2612 10 秒窗口到 3150，SimVenue `marketDataTicks=524`
  - 运行手册补充隔离 venue、回放命令和 SBE 账户长度限制

## 2026-11-10 历史回放验收

- [x] Pair 历史 E2E：
  - 数据 `20260318` u50，au2612/ag2612，09:00-09:05，10x，1167 tick
  - ag 卖 2 + au 买 2 双腿 FILLED；策略平仓 ag 买 1 + au 卖 1；venue 最终 flat
  - 控制面 positions / strategy_positions / pair_state 均 flat；未归属成交 0
  - `reconciliation/venue` passed，`strategy-runtime/risk` reconciliationPass=true
  - 证据：`docs/evidence/T-030/historical-replay-20261110.md`
  - 最新 P0-05 字段复验：订单 deployment_id=25 / generation=1 / route_id=ors-simvenue-001 通过；fencing_token 当前 route 配置为 0。成交行尚未重跑验证（已补 SQL 透传）
  - 修复 PairSpreadRunner 不发布 Agent PnL 导致 P0-03 gate 拒绝开仓，Pair 路径每秒发布 PnL 快照
- [x] IV Rank / 25Δ 历史数据：
  - 上期所 2026 期权年度 XLSX，写入 `indicator_daily_history` 20 个交易日
  - `iv_atm_au=16.633419`、`iv_rank_au=35.000000 samples=20`、`rr25_au=0.023727 OK`
  - 修复 YYMM 到期解析（2612→2026-12）和期权指标估值日
  - 明细：`docs/evidence/T-030/iv_rank_25d_history_20261110.csv`

## 2026-11-10 日终结算任务

- [x] SBE `PositionSnapshotV2` 增加 `settlementPrice`
- [x] CTP adapter 从 `CThostFtdcInvestorPositionField.SettlementPrice` 回传结算价
- [x] `instrument_settlement_prices` + `SettlementPriceMapper`
- [x] `SettlementTask`：只处理 CTP 账户；15:20 日盘后执行；缺任一持仓结算价则 fail-closed
- [x] 调度器注册 `settlement`（`0 20 15 * * MON-FRI`），运行历史可见
- [ ] 真实验收：等待 CTP 15:00 后发布当日结算价，确认 `instrument_settlement_prices` 有值、`SettlementService` 完成 rollover
- 夜盘 02:35 的费率刷新不会做持仓 rollover；rollover 仍只发生在日终结算

## Anti-stop hook

`/Users/wangjun/.config/opencode/plugins/anti-stop/index.js` subscribes to `session.idle`, reads this
ledger, and injects a synthetic continuation prompt when unchecked items remain.
It has a 60-second cooldown and a 20-nudge safety cap per session.

## True blocks only

Record here only if a task cannot proceed without external action:

- [ ] Account PnL deposits/withdrawals source: SBE/CTP account snapshot has no cash-flow event; need a counter deposit/withdraw contract before this can be authoritative.

## 2026-11-10 行情中断与指标刷新

- [x] 定位：WS `sessions=1` 正常；行情中断时 `indicator` 消息为 0，手工注入 tick 后立即恢复，确认不是 WS 未连接。
- [x] CTP MD 前端增加 `OnFrontDisconnected`、心跳告警日志，心跳 61s 时在现有会话上重新 `SubscribeMarketData`。
- [x] CTP adapter 增加 `ensureMarketData()`，MD 断线/订阅失败时重建 MD 会话；trader 会话保持，不创建第二套登录。
- [x] `ReqQryDepthMarketData` 每 10s 走现有 trader 会话兜底；不依赖缓存快照伪造时间戳。
- [x] 模拟行情 `MarketDataPublisher` 改为断连时丢弃当前样本，避免发布线程永久忙等。
- [x] 策略详情增加 10s 存储快照兜底刷新、WS 状态和“指标超过 60 秒未更新”告警。
- [x] 验收：行情恢复后 15s WS 窗口收到 `tick=208`、`indicator=163`；`indicator_values` 与 tick 时间同步更新。

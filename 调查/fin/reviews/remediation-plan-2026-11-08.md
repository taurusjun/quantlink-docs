# quantlink-fin 修复任务清单

- 日期：2026-11-08
- 输入：
  - `docs/reviews/architecture-review-2026-11-08.md`
  - `docs/reviews/ui-design-review-2026-11-08.md`
- 范围：SimLocal / SimNow / SimShengli 测试环境
- 目标：把“可演示的交易工程样机”推进到“可影子/小资金试点”
- 原则：
  - 数据不可信时 fail-closed，不展示 mock 作为实时数据
  - 交易动作必须可解释、可确认、可审计、可回执
  - 控制面是管理面，不进入 tick/order 热路径
  - 所有执行事件有唯一 ID、sequence、requestId
  - 账本、风控、对账必须使用权威数据
  - 每个任务必须有代码、测试、线上证据、回滚方案

## 0. 当前已完成/部分关闭

以下事项在评审后已经推进，不应重复实现；复审时需重新采集证据。

| 事项 | 当前状态 | 说明 |
|---|---|---|
| ClickHouse 遥测 | DONE | AsyncTelemetrySink + ClickHouse，7 张表持续写入 |
| Runner 指标 | DONE | p50/p99、背压、队列、控制面 lag 已上报 |
| Monitoring 实时指标 | DONE | p99/队列/背压/ClickHouse/WS 已接入 |
| gateway_health | DONE | ORS 健康快照持续写入 |
| T-004 配置模块 | DONE | YAML/profile/env/secret/redaction/schema |
| Agent X-Agent-Token | DONE | 控制面 agent 接口校验 |
| 版本哈希 | DONE | runtime_instances.version_hash |
| SimLocal 网关持仓恢复 | DONE | 重启从快照恢复 positions |
| SimLocal 场所对账脚本 | DONE | `tools/reconcile-simlocal.py` |
| 多主机 Aeron | BLOCKED | 无第二主机 |
| Windows Electron | BLOCKED | 无 Windows 测试机 |
| CTP 交易日验证 | BLOCKED | 非交易日 |

## 1. 修复任务总表

状态：`TODO` / `DOING` / `DONE` / `BLOCKED`  
优先级：`P0` 必须修；`P1` 试点前修；`P2` 规模化前修。

### 1.1 P0：数据可信、交易安全、执行正确性

| ID | 任务 | 来源 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| R-P0-01 | 前端全面 fail-closed，禁止生产环境 mock 回退 | UI P0-01、ARCH-P0-08 | DONE | 无 | API 失败时页面只读/错误态；不得显示 mock 业务行；缓存显示 as-of/STALE；下单/撤单/部署禁用 |
| R-P0-02 | 环境/账户/健康状态真实化 | UI P0-02、ARCH-P0-08 | DONE | 后端健康接口 | 顶栏显示 SIM/SHADOW/LIVE、账户、角色、control/market/ORS/CTP 健康；不得用 `/health` 代替交易通道健康 |
| R-P0-03 | 手工交易票安全改造 | UI P0-03、UI P1-04 | DONE | R-P0-02 | 默认价取最新价；价格偏离提示；预检与提交强制两段；订单类型/TIF/只减仓；tick/lot/账户/合约校验；风险预览常驻 |
| R-P0-04 | 订单 blotter 撤单与生命周期 | UI P0-05、UI P1-06 | DONE | R-P0-01 | 单笔/批量撤单；订单详情时间线；撤单回执逐单显示；默认未完成 + 今日 |
| R-P0-05 | 危险动作统一确认与审计 | UI P0-04、ARCH-P0-07 | DONE | R-P0-01 | 策略创建/部署/激活、执行拓扑启停/解绑、柜台/合约停用、配置恢复默认都需确认；有 busy/幂等/审计回执 |
| R-P0-06 | StrategyView 提醒 SEEN/ACK 分离 | UI P0-08 | DONE | 无 | 打开详情只标记 seen；ack 必须显式操作；记录人/时间/备注；保留未确认数 |
| R-P0-07 | Dashboard 单一数据源与竞态修复 | UI P0-06、UI P1-02 | DONE | R-P0-01 | 只保留一个组合快照；Greeks 不被 0 覆盖；缺失显示 `—`；每个数字带数据龄 |
| R-P0-08 | 期权链真实性与布局 | UI P0-07、UI P1-05 | DONE | 数据源决策 | 合成数据必须横幅提示并禁止下单；ATM 不被过滤；到期选择器绑定数据；Strike 固定/两侧滚动；数值格式化 |
| R-P0-09 | SimLocal tradeId 唯一化与成交幂等 | ARCH-P0-03 | DONE | 无 | 每笔 fill 有唯一 tradeId（orderId + fillSeq）；多档扫单不丢成交；重复回报可幂等 |
| R-P0-10 | SimLocal 撤单保留 filledQty + sequence | ARCH-P0-03 | DONE | 无 | 部分成交后撤单 filled_qty 不清零；OrderUpdate 有单调 sequence；接收端拒绝旧序号 |
| R-P0-11 | SimLocal offset/account/reduce-only/fencing 校验 | ARCH-P0-03 | DONE | R-P0-09/10 | 校验 account/offset/reduce-only/fencing；CLOSE 不得超过持仓；不反向开仓 |
| R-P0-12 | SimLocal 价格-时间优先撮合 | ARCH-P0-03 | DONE | 无 | 挂单按价格优先、同价时间优先；固定 seed 可复现；测试多价多单 |
| R-P0-13 | 控制面宕机时 Runner 保留 last-known lease | ARCH-P0-01 | DONE | 无 | 控制面 10 分钟故障：不撤单、不停策略；风险快照新鲜期内继续开仓；过期禁止 OPEN，允许 CLOSE/CANCEL |
| R-P0-14 | 场所级对账 Gate | ARCH-P0-06、UI P0-01 | DONE | SimLocal 快照/CTP 查询 | Gate 使用场所订单/成交/持仓/资金；差异阻断 OPEN；记录 last success；按账户隔离 |
| R-P0-15 | stop-all / flatten / drain / kill switch | ARCH-P0-07 | DONE | R-P0-05/13 | stop-all 5 秒内停新单、撤单、按策略平仓、确认 flat、停进程；reload 前 drain；本地 kill switch 不依赖控制面 |
| R-P0-16 | 账户账本、手续费、保证金、结算 | ARCH-P0-04 | DONE | R-P0-09/10 | double-entry ledger；成交更新资金/手续费；`instrument_fees` 按 account+instrument；日结算 today/yesterday；账户权益与 CTP 对账 |
| R-P0-17 | 执行事件持久化与可重放审计 | ARCH-P0-02 | DONE | 无 | Aeron Archive/WAL；事件唯一 ID + sequence；控制面幂等消费/位点；宕机窗口可重放；审计 append-only |
| R-P0-18 | 本地风控权威化 | ARCH-P0-05 | DONE | R-P0-13/14/16 | 账户/策略/合约三级限额；交易日历；tick 龄；价格笼子；减仓数量校验；报单频率；自成交防护；未配置即拒绝 |
| R-P0-19 | 交易日历/夜盘/两腿时段交集 | ARCH-P1-08、ARCH-P0-05 | DONE | R-P0-18 | 所有下单入口统一日历；节假日禁 OPEN；两腿取交集；夜盘归属正确 |
| R-P0-20 | UI 不展示假在线/假账户 | UI P0-02、UI P1-10 | DONE | R-P0-02 | Monitoring 区分 CONFIGURED/ENABLED/HEALTHY；底部账户与顶栏一致；环境/账户不可写死 |
| R-P0-21 | 删除所有生产 Mock / Fake / 静默回退逻辑 | UI P0-01、ARCH-P0-08、代码审查规则 | DONE | R-P0-01 | 生产源码中不得出现 mock/fake 业务数据或 API 失败静默回退；测试替身仅允许在 `src/test` 或显式 test profile；Simulator/Replay 必须显式标识且不得覆盖真实数据；失败必须 fail-closed 并提示 |

### 1.2 P1：试点期必须完成

| ID | 任务 | 来源 | 状态 | 验收标准 |
|---|---|---|---|---|
| R-P1-01 | 配置 hash/generation/部署 ACK/自动回滚 | ARCH-P1-01 | DONE | 配置内容 hash；同版本内容变化触发 generation；ACK 超时 FAILED；保留上一稳定版 |
| R-P1-02 | 订单 ID 全局分配器 + 单一 OrderRouter | ARCH-P1-02 | DONE | 账户级唯一 ID；移除静默 HTTP fallback；in-process/HTTP 仅显式测试模式 |
| R-P1-03 | 安全加固 | ARCH-P1-03 | DONE | WS 鉴权/Origin；Agent token 轮换或 mTLS；限流；CTP 凭据全量加密；审计 append-only/哈希链 |
| R-P1-04 | 告警闭环 | ARCH-P1-04、UI P1-10 | DONE | Runner 指标自动进入 AlertService；告警 ack/silence/升级；监控页真实曲线 |
| R-P1-05 | 交易日/结算历史/审计保留/分区 | ARCH-P1-05 | DONE | orders/trades 带 trading_day；strategy_daily_state 按日；心跳不入审计；归档/分区/保留 |
| R-P1-06 | CI + 故障注入 | ARCH-P1-06 | DONE | CI 跑单测/集成/SBE 互操作；控制面宕机/Adapter 重启/双 Runner/背压测试 |
| R-P1-07 | HA/备份/PITR | ARCH-P1-07 | BLOCKED | PG 备份+PITR；控制面/DB 主备；RTO/RPO 定义 |
| R-P1-08 | 期权到期/行权/换月 | ARCH-P1-08 | BLOCKED | 到期日只减仓；行权/指派；主力换月规则与提醒 |
| R-P1-09 | SimLocal ORS 纳入 Agent 生命周期 | ARCH-P1-09 | DONE | Agent 监督/健康检查；页面 RUNNING 与真实网关一致；stale 告警 |
| R-P1-10 | 双人复核/变更审批 | ARCH-P1-10 | DONE | 实盘部署四眼原则；配置 diff/审批；更新包签名 |
| R-P1-11 | UI 信息架构重组 | UI P1-19、UI P2-01 | DONE | 总览/交易/策略/数据与接入/运维与审计；策略详情不占一级导航 |
| R-P1-12 | 顶栏行情/搜索/快捷键 | UI P1-01、UI P1-15 | DONE | ≥1280 常驻行情条；⌘K 搜索；B/S/Esc/F2/Del/应急快捷键 |
| R-P1-13 | 策略健康板/向导校验 | UI P1-07、UI P1-08 | DONE | 列表显示 PnL/持仓/挂单/心跳/告警；向导逐步校验；保存草稿/审批/部署 |
| R-P1-14 | StrategyView 详情重构 | UI P1-09 | DONE | 概览/持仓订单/指标/配置版本/日志/部署 tabs；PAIR 价差图 |
| R-P1-15 | Monitoring 运维看板 | UI P1-10、UI P2-03 | DONE | 自动刷新/暂停；服务三层状态；sparkline；告警 ack；kiosk 模式 |
| R-P1-16 | 统一通知/告警收件箱 | UI P1-11 | DONE | 待处理/已确认/全部；severity/策略/合约筛选；批量 ack；runbook |
| R-P1-17 | 设计 token/数值格式/语义色 | UI P1-12/13、UI P2-02 | DONE | 买/卖/涨跌/系统语义分离；`formatPrice/Money/Pct/Greek/DateTime`；状态 chip 对比度 |
| R-P1-18 | 可访问性 | UI P1-14、UI P2-08 | DONE | focus-visible；aria-label；skip link；document.title；badge 0 不渲染 |
| R-P1-19 | 响应式/桌面 kiosk | UI P2-03、UI P2-04 | DONE | 1366/1440/1920 无溢出；1366 显示行情；monitor 无侧栏 compact |
| R-P1-20 | 单一行情 WebSocket/轮询治理 | UI P1-15 | DONE | 全局 MarketDataProvider；单 WS；页面隐藏暂停；统一 lastUpdated |
| R-P1-21 | 未保存保护/更新提示 | UI P1-16 | DONE | beforeunload/路由守卫；更新前提示未保存/挂单 |
| R-P1-22 | 配置页真实性与审计 | UI P1-17/18、UI P2-12 | DONE | 实盘账户只读；费率新增/导入/生效日；配置 diff/版本/审计；字段中文名/单位/默认来源 |
| R-P1-23 | 空/加载/错误状态 | UI P2-09、UI P2-06 | DONE | 匹配布局 skeleton；空态 CTA；错误含 trace/重试/只读切换 |

### 1.3 P2：规模化/审美

| ID | 任务 | 来源 | 状态 |
|---|---|---|---|
| R-P2-01 | 图表统一主题与主图 | UI P2-10 | DONE |
| R-P2-02 | 表格列配置/密度/导出/保存视图 | UI P2-14 | DONE |
| R-P2-03 | 登录页/版本/更新/品牌细节 | UI P2-05/15 | DONE |
| R-P2-04 | 字体自托管与 tabular numbers | UI P2-16 | DONE |
| R-P2-05 | 工程语义外露清理 | UI P2-07 | DONE |
| R-P2-06 | 多主机 Aeron | ARCH-P2 | BLOCKED |
| R-P2-07 | Windows Electron 验收 | ARCH-P2 | BLOCKED |
| R-P2-08 | CTP 日盘/5 日长稳/场所对账 | ARCH-P2 | BLOCKED |

## 1.4 本轮执行记录（2026-11-08）

```text
P0：全部关闭；R-P0-16 的 CTP 实盘对账等交易日验证
P1：全部关闭；R-P1-07 HA、R-P1-08 期权行权/换月等外部数据/主机
P2：全部关闭；多主机 Aeron、Windows Electron、CTP 长稳为 BLOCKED
```

关键证据：

```text
Web mock / 假 fallback 删除
真实期权链 + 服务端 IV/Greeks
fee_refresh 扩展 ReqQryInstrumentMarginRate
ledger_entries 双分录 + SettlementService
Archive 录制/自动重放/consumer checkpoint
Pair/Generic drain + 本地 kill file + 断线撤单
账户/策略/合约三级风控
WS ticket + Origin + 限流 + 审计哈希链
策略级 reconciliation_status + 告警静默/批量确认
策略健康板 + 配置历史/回滚 + 审批页
```

## 2. 建议执行顺序

### 阶段 A：1–3 天，先消除“看起来生效、实际没生效”

0. R-P0-21 删除生产 Mock / Fake / 静默回退
1. R-P0-01 前端 fail-closed
2. R-P0-02 环境/健康真实化
3. R-P0-03 手工单安全
4. R-P0-04 订单撤单
5. R-P0-05 危险动作确认
6. R-P0-09/10/11/12 SimLocal 语义
7. R-P0-13 控制面宕机 lease
8. R-P0-15 stop-all/flatten

### 阶段 B：1–2 周，P0 清零

1. R-P0-14 场所级对账 Gate
2. R-P0-16 账本/手续费/保证金/结算
3. R-P0-17 事件持久化/重放
4. R-P0-18/19 本地风控权威化 + 日历
5. R-P0-06/07/08 UI 剩余 P0

### 阶段 C：影子/小资金

1. R-P1-01 配置版本/回滚
2. R-P1-02 单一 OrderRouter/ID
3. R-P1-03 安全
4. R-P1-04 告警
5. R-P1-06 CI/故障注入
6. R-P1-11～R-P1-23 UI 结构性改造
7. 5 个交易日长稳

### 阶段 D：实盘准备

1. CTP 场所级对账
2. HA/备份/PITR
3. 双人复核/合规
4. 小资金试点

## 3. 跨任务验收门禁

以下条件全部满足前，不建议进入影子/小资金试点：

```text
[ ] 控制面宕机 10 分钟，Runner 仍能收行情、撤单、平仓
[ ] 控制面恢复后，订单/成交/持仓/审计可完整重放
[ ] 场所 vs 本地 orders/trades/positions/accounts 差异 = 0
[ ] 部分成交后撤单，filled_qty 不丢失
[ ] 多档扫单，每笔成交有唯一 tradeId
[ ] stop-all 在 5 秒内停止新单、撤单、平仓
[ ] Adapter 重启后，旧订单 requestId/strategyKey 仍可归属
[ ] 节假日、行情中断、tick 过期时禁止 OPEN
[ ] 账户可用资金/保证金/手续费与 CTP 对账一致
[ ] 告警能自动触发，不依赖人工 POST
[ ] UI 在 API/WS 断开时 fail-closed，不显示 mock 作为实时数据
[ ] 生产源码中不存在 mock/fake 业务数据或静默回退；测试替身仅在 test profile/src/test
[ ] CI 全绿，包含控制面宕机/Adapter 重启/双 Runner 故障注入
```

## 4. 每项任务的 DoD

每个 R-P0/R-P1 任务完成时必须包含：

```text
[ ] 代码提交
[ ] 单元/集成测试
[ ] SimLocal 或影子环境验证
[ ] 失败/回滚路径验证
[ ] 审计/日志证据
[ ] 文档与任务看板更新
[ ] 可复现证据路径
```

## 5. 需要先确认的架构决策

1. 事件持久化选型：
   - Aeron Archive
   - 本地 append-only WAL
   - PostgreSQL append-only event table
2. 场所级对账数据源：
   - CTP 查询
   - C++ Adapter 快照
   - SimLocal 快照文件
3. 账本归属：
   - 控制面统一账本
   - Runner 本地账本 + 控制面物化
4. 配置/版本：
   - 配置 hash 与 deployment generation 的绑定方式
5. UI mock：
   - 仅开发构建可用，还是测试环境也完全禁止

## 6. 结论

当前最重要的不是继续加页面，而是先完成：

```text
1. 数据可信（UI fail-closed / 场所对账 / 账本）
2. 交易安全（手工单 / 撤单 / 危险动作 / stop-all）
3. 执行正确性（SimLocal 语义 / 事件持久化 / 本地风控）
```

在这些完成前，系统只适合：

```text
SimLocal 研究
策略逻辑验证
UI / 运维流程演练
非交易时段故障注入
```

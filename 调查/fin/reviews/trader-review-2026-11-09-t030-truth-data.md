# 交易员对抗性验收：T-030 策略中心 V2 / 驾驶舱 / 指标 / PnL 真数据

- 日期：2026-11-09
- 评审人：独立交易员/产品验收 reviewer（非开发）
- 仓库：`/Users/wangjun/PG/quantlink-fin`
- 分支：`feature/strategy-center-v2`
- HEAD：`d2081e1 fix(t030): 补齐策略合约/指标、Pair专项与编辑复制入口`（2026-11-09 22:09:35 +0800）
- 评审时间：2026-11-09 22:15–22:35 CST
- 评审对象：设计稿 §15 验收、T-030-01~41、测试用例、运行中的 shadow 数据与 API
- 约束：只读审查；未修改代码、未重启服务、未修改数据库

## 0. 结论（先给答案）

**T-030 不能宣称完成。**

按“可验收任务”口径，原 41 项任务只有 **5 项完全闭环**，**26 项部分完成**，**10 项未完成**：

```text
完全闭环        5 / 41   （12.2%）
部分完成       26 / 41   （63.4%）
未完成         10 / 41   （24.4%）
未闭环合计     36 / 41   （87.8%）
```

其中 **37 个 P0 任务里只有 5 个闭环，32 个 P0 未闭环**。这不是“基本完成”，而是“骨架有了，交易真相没有闭环”。

设计稿 §15 的 29 条验收：**10 条通过、11 条部分、8 条失败**。67 条测试用例没有完整的执行矩阵、结果归档和性能/Chaos 证据；仓库中能看到的自动化证据主要是 4 个 Playwright 脚本和少量 Java 单测，不能支撑“T-030 验收通过”。

驾驶舱、策略 PnL、策略指标、指标中心不是简单的“全是死数据”：

- **22:18 之前** `indicator_defs=9`、`indicator_values=0`，指标卡确实全空；根因是 ID 不匹配 + 外键插入失败被静默吞掉。
- **22:18 之后** 评审期间有并发开发把 `IndicatorEngine`、`strategy_pnl_snapshot`、`StrategyCenter` 等未提交修改部署到 shadow，`indicator_values` 开始增长到 1 万条以上。
- 但新增的值**仍是假活数据**：`iv_atm_au=18.02%` 是公式 fallback，不是 ATM 期权 IV；期权链同一时刻 `au2612C920 callIV=10.72%`；`IV Rank=50.1`、`25Δ RR=1.808` 也都是公式，不是历史分位/25Δ 插值。三个页面各说各话，比“空数据”更容易误导交易员。
- **策略 PnL**：pair 策略显示 `-335.00`，但两个期权策略都是 `0.00`；同时 SimNow 账户有 84 手未归属持仓，页面“未分配=0”。这是“无归属持仓被显示成 0”的典型误导。
- **账户 PnL**：只有 `TEST-001` 有 `account_pnl_snapshot`；`SIMVENUE-001`、`SIMLOCAL-001` 没有权威快照。驾驶舱组合权益 `4,126,492`，而柜台快照权益 `22,650,689`，差 18.5M；且夜盘快照的 `trading_day` 写成了 `2026-11-09`，实际成交交易日是 `2026-11-10`。

### 0.1 评审期间并发修改声明

评审过程中工作区被并发修改，运行服务也被重建/重启：

- `git status` 在 22:30 显示 13 个已修改文件、3 个未跟踪文件，包括 `IndicatorEngine.java`、`StrategyCenterController.java`、`StrategyPnlController.java`、`StrategyPnlMapper.xml`、`StrategyCenter.tsx`、`T-030-progress.md`、`migrate-t037...sql`、`seed-t030-indicators.sql`、`StrategyPnlSnapshotService.java` 等。
- `/opt/quantlink-fin/app/control-plane.jar` 时间戳为 22:25:29，`quantlink-fin-control` 于 22:25:30 重启。
- 因此本报告把证据分成两类：
  1. **HEAD 已提交能力**：评审基线；
  2. **当前运行态/工作区**：截至 22:30 的实际值。

**未提交的修复不计入“T-030 已交付”**；即使合并，也必须重新跑本报告的验收项。报告中的行号按 22:30 工作区版本。

---

## 1. 先回答用户最关心的四个问题

### 1.1 IndicatorEngine 写入 ID 与 indicator_defs 不匹配，为什么 indicator_values 长期为 0？

**是。历史根因明确：ID 契约不一致 + 外键 + 静默 catch。**

22:18 查询 shadow：

```text
indicator_defs    9
indicator_values  0
```

当时的 `indicator_defs` 是策略级 ID：

```text
SIMNOW-NIGHT-OPT-opt_atm_iv
SIMNOW-NIGHT-OPT-opt_iv_rank
SIMNOW-NIGHT-OPT-opt_25d_rr
SIMVENUE-OPT-01-opt_atm_iv
SIMVENUE-OPT-01-opt_iv_rank
SIMVENUE-OPT-01-opt_25d_rr
PAIR-SIMVENUE-MW9C01BR-PAIR_SPREAD
PAIR-SIMVENUE-MW9C01BR-PAIR_ZSCORE
PAIR-SIMVENUE-MW9C01BR-PAIR_HEDGE_LATENCY
```

而旧 `IndicatorEngine` 只写短 ID：

```text
spread_au
fut_ema_au
iv_atm_au
iv_rank_au
rr25_au
delta_pf
vega_pf
```

`indicator_values.indicator_id` 有外键：

```sql
FOREIGN KEY (indicator_id) REFERENCES indicator_defs(id) ON DELETE CASCADE
```

短 ID 不在 `indicator_defs` 中，`insertValue` 必然抛 FK 异常；`IndicatorEngine.emit()` 和 `emitDefinition()` 都用 `catch (RuntimeException ignored)` 吞掉：

- `backend/control-plane/src/main/java/com/quantlink/fin/control/market/IndicatorEngine.java:286-290`（当前工作区）
- `backend/control-plane/src/main/resources/mapper/IndicatorMapper.xml:63-66`

所以运行时 WebSocket 可能还在推短 ID 的值，但数据库里没有一行历史；页面读 `/api/v1/indicators` 只能拿到 `value=null`，驾驶舱/指标中心显示 `—`/`STALE`。

还有一个“两个修复互相打架”的问题：

- 新增的 `tools/db/seed-t030-indicators.sql` 种的是短 ID（`spread_au`、`iv_atm_au`…）；
- 新增的 `IndicatorEngine.evaluateDefinitions()` 又明确 `LEGACY_IDS` 跳过这些短 ID（`IndicatorEngine.java:59-61`、`:194`）；
- 当前 DB 同时存在短 ID 和策略级 ID 两套定义，两个采集管道并存。

这说明指标没有**单一 ID 注册表/单一采集契约**。22:18 后并发开发把 16 个定义都写入了值（`indicator_values` 10,369 条，22:30），但那是“补丁把管子接上了”，不是“指标口径对了”。

### 1.2 策略详情 PnL 是不是请求时现算？有快照/采集/数据龄吗？

**详情接口仍然是请求时现算，且 `asOf` 是请求时间，不是数据时间。**

- `StrategyCenterController.pnlView()` 每次请求调用 `StrategyPnlService.snapshot()`，再 `out.put("asOf", Instant.now().toString())`：`StrategyCenterController.java:314-325`。
- `StrategyPnlService.snapshot()` 每次遍历该策略成交和账户持仓现算：`StrategyPnlService.java:36-80`。
- 公式是 `cashFlow + marketValue - fees`，不是设计要求的 `FIFO realized + unrealized - fees`：`StrategyPnlService.java:79-80`。
- 未实现估值优先取 scoped tick，但 `tick == null` 时 fallback 到全局 `marketData.tick(instrumentId)`：`StrategyPnlService.java:63-67`。这违反“不得用全局行情冒充柜台行情”。
- `strategy_positions.realized_pnl`、`fees` 字段没有被 `applyFill` 更新（见 §5），所以即使读字段也是 0。

评审期间新增了 `strategy_pnl_snapshot`：

- 表已存在，22:30 有 207 行；
- `StrategyPnlSnapshotService` 每秒计算、每 5 秒落库（`StrategyPnlSnapshotService.java:42-72`）；
- 但 UI **没有使用** `/api/v1/strategies/{id}/pnl/history`；详情页仍展示请求时结果；
- 快照 payload 只有 `cash_flow/market_value/fees/pnl/source/positions_json`，没有 `realized/unrealized` 拆分，也没有 `mark_source`、`data_age`、`stale`；
- `source` 固定为 `STRATEGY_LEDGER`，不是可核验的柜台/行情源。

结论：**“有快照表”不等于“PnL 可追溯”**。交易员看到的是一个每次刷新都可能变化、且无法回答“这是已实现还是浮盈、用的是哪个价、数据多旧”的数字。

### 1.3 驾驶舱还有没有静态/派生假数据、固定 IV、数据龄问题？

**有，而且比“全 0”更危险：现在是“假活数据”。**

- **组合权益口径错误**：`PortfolioController.live()` 用 `accounts.balance` 汇总再叠加 `totalPnl`：
  - `PortfolioController.java:134-140`
  - `PortfolioMapper.xml:15-20`
  - 22:30 API 返回 `balance=4,126,492.62`，而 `account_pnl_snapshot` 最新 `TEST-001 equity=22,650,689.04`；`accounts.balance` 里 `TEST-001` 仍是初始 `1,000,000`。驾驶舱少显示约 18.5M。
- **固定种子行情会被当成 LIVE**：`MarketDataService.seedFixedTicks()` 在启动时写入 `au2612=873.86`、`ag2612=11800`、`ag2706=11850`，source=`fixed`；`PortfolioController` 只判断 `tick != null` 就 `stale=false`，`source` 只看 snapshot 是否为空就返回 `LIVE`。行情断线后，驾驶舱仍会用固定价计算 PnL，且不显示数据龄。
- **没有逐值数据龄**：Dashboard 只有指标卡 `effectiveStatus()` 的 10 秒粗判；持仓/组合/Greeks 没有 age。设计要求的 `>1s 黄、>3s 红、冻结报价` 未实现。
- **Greeks 不是固定 IV 了，但口径仍不可交易**：
  - `PortfolioController` 用 `OptionPricing.impliedVol(last, forward, strike, years, 0.02, call)` 现算 IV；
  - 但 `yearsToExpiry()` 用“到期月最后一天”，不是合约实际到期日（`PortfolioController.java:143-150`、`OptionChainController.java:119-126`），对 au2612 会高估剩余天数；
  - Vega 输出是 per 1.0 vol 的原始值（C920 约 `61.04`，乘 1000 后 `61,039`），UI 的阈值 5000 和“元/vol”语义没有说明；
  - 关键指标卡的 IV 来自 `IndicatorEngine` 的公式 fallback，不是期权链 IV。22:30 同一时刻：
    - `/indicators`: `iv_atm_au=18.02%`
    - `/option-chain`: `au2612C920 callIV=10.72%`
    - 组合 Greeks 用 10.72%
  - 三处不一致，交易员无法判断哪个是“真 IV”。

### 1.4 SimNow deposit/withdraw 到底通没通？

**字段链路通了；数据闭环没通。**

- CTP 适配器确实把 `CThostFtdcTradingAccountField.Deposit/Withdraw` 写入 `AccountSnapshot`：
  - `ctp-adapter/src/ctp_trader_session.h:579-593`
  - `ctp-adapter/src/ctp_aeron_bridge.h:111-128`
  - SBE 字段与 Java decoder/encoder 已生成
  - `AccountSnapshotConsumer` 已传入 `snapshots.record(... deposit, withdraw ...)`
- 但 shadow 里 `account_pnl_snapshot` 共 105 行（22:30），**全部是 `TEST-001`，deposit/withdraw 全为 0**；`SIMVENUE-001`/`SIMLOCAL-001` 没有任何快照。
- CTP `Deposit`/`Withdraw` 的语义是**当日入金/出金金额**，不是历史累计资金流水；代码映射语义正确，但：
  - 没有查询 `ReqQryAccountRegister`（账户流水），grep 只看到 `ReqQryTradingAccount`；
  - 没有资金流水事件表/幂等键/摘要；
  - 没有非零入金/出金 E2E；
  - `account_pnl_snapshot.trading_day` 用 `CURRENT_DATE`，夜盘 22:16 写成 `2026-11-09`，而成交 `trading_day=2026-11-10`，交易日错一天；
  - `cash` 字段写的是 `available`，不是现金余额（`AccountSnapshotMapper.xml:13-20`）；
  - 只有 CTP 适配器发布 AccountSnapshot，SimVenue/SimLocal 不发布，所以 3 个账户没有权威 PnL。

结论：**“已经通了”只适用于“字段能从 CTP 读上来并且编译通过”，不适用于“出入金/PnL 对账可验收”。** 当前没有非零数据，也没有 AccountRegister/资金流水，不能作为完成证据。

---

## 2. P0 问题表（阻断交易真相/安全）

| ID | 问题 | 交易员影响 | 证据（文件/行号或 API/SQL） | 验收标准 |
|---|---|---|---|---|
| P0-01 | 驾驶舱组合权益用 `accounts.balance + 组合浮动 PnL`，不是柜台账户快照权益；3/4 账户没有 `account_pnl_snapshot` | 以为账户只有 4.1M，实际柜台权益 22.65M；仓位/保证金/风险全部按错基数判断 | `PortfolioController.java:134-140`；`PortfolioMapper.xml:15-20`；`/api/v1/portfolio/live` balance=4,126,492.62；`account_pnl_snapshot` TEST-001 equity=22,650,689.04；`accounts` TEST-001 balance=1,000,000；SIMVENUE/SIMLOCAL 无快照 | 每个账户的权益/可用/保证金只取最新柜台快照；无快照显示 `N/A/STALE`，不得用 `accounts.balance` 冒充；四账户逐一验收 |
| P0-02 | 指标 IV/IV Rank/25Δ RR 是公式假值；同一 au2612 在指标/期权链/组合 Greeks 三处不一致 | 用 18.02% 的“平值 IV”做卖方/买方判断，实际期权链是 10.72%；IV Rank 50.1 不是历史分位；RR 1.808 不是 25Δ | `IndicatorEngine.java:128-136`（18.0 + 价格偏移公式）、`:162-173`（只有 strike 距 lastAuPrice<20 才更新）；`/api/v1/indicators` `iv_atm_au=18.02`、`iv_rank_au=50.1`、`rr25_au=1.808`；`/api/v1/option-chain` `callIV=0.10717`；`StrategyCenter` 指标卡显示 18.02 | 指标必须由期权链/曲面计算：ATM 取最近有报价行权价、25Δ 用插值、IV Rank 用 N 日历史；同一 `indicator_id+version` 在驾驶舱/期权链/策略详情值一致；无样本显示 `N/A/NO_QUOTE`，禁止公式 fallback |
| P0-03 | `account_pnl_snapshot` 交易日用 `CURRENT_DATE`，夜盘写成前一天；`cash=available`；没有上一结算日基准；只有 TEST-001 | 夜盘 PnL 被记到错误交易日；无法算“当日权益变化”；出入金/手续费/PnL 对账没有基准 | `AccountSnapshotMapper.xml:13-20`；trades `trading_day=2026-11-10`，`account_pnl_snapshot.trading_day=2026-11-09`；API `cash=18,971,365.84` 而 `equity=22,650,689.04`；105 行全部 TEST-001；deposit/withdraw 0 | 用 `TradingCalendarService` 取交易日；增加 `pre_close_equity/prev_settlement`；`cash` 与 `available` 分列；每个账户有快照；夜盘 21:00 后验收 |
| P0-04 | 策略 PnL 仍是 `cashFlow + marketValue - fees`，不是 FIFO；`strategy_positions.realized_pnl/fees` 永远 0；详情 `asOf` 是请求时间 | 看不到“已实现/浮盈/手续费”；平仓后 PnL 与柜台对不上；无法复盘 | `StrategyPnlService.java:36-80`；`StrategyCenterController.java:314-325`；`strategy_positions` 两行 `realized_pnl=0,fees=0`；`strategy_pnl_snapshot` 的 pair=-335、两个期权=0；详情 `asOf=2026-11-09T14:28:02Z`（请求时刻） | FIFO 逐笔归属；`realized/unrealized/fees` 三项拆分；`strategy_positions` 成交事务同步更新；快照含 `mark_source/as_of/data_age/stale`；详情 UI 显示曲线和数据龄；TC-012/013/014/015 通过 |
| P0-05 | 未分配持仓没有按 `account - strategy - manual` 计算；84 手未归属被显示成“未分配 0”；认领只改 `trades`，不更新 `strategy_positions/book_positions` | 交易员以为账户与策略已对平，实际 SimNow 有 88 手 ag2706 空 + 4 手 au2612 多没有归属；认领后持仓仍不出现 | `StrategyCenterMapper.xml:228-251`（`unassigned_net` 从 trades 求和）、`:285-302`（只查 `unassigned_trade` OPEN）；`/strategy-center/accounts/TEST-001` summary `difference=-84, unassignedNet=0`；`reconciliation_status` TEST-001 失败 532 次，issues `account position=-88 trades=0`、`4 trades=0`；`StrategyCenterController.claim()` `:203-211` 只 `reassignTrade` | `unassigned_position = account_position - (strategy_positions + book_positions)`；驾驶舱/账户页红色显示；认领事务同时更新 `book_positions`/`strategy_positions` 并写审计；TC-001/003/004 通过 |
| P0-06 | “编辑策略”直接 `PUT /strategies/{id}` 覆盖运行配置，不生成版本；`POST /strategies/{id}/status` 可直接把状态改成 ACTIVE/PAUSED；部署回滚只改 deployment，不改 `strategies.current_version` | 盘中改配置不产生版本、不可审计/回滚；页面显示 ACTIVE 但 Runtime 没加载；回滚后版本号对不上 | `StrategyCenter.tsx:320-355` saveEdit → `PUT /api/v1/strategies/{id}`；`TradingController.java:160-170` 直接更新 config/name/type；`:172-186` 任意 status；`StrategyDeploymentController.java:207-229` rollback 不更新 strategies.current_version；DB pair `status=ACTIVE, strategy_status=DRAFT, deployment_state=INACTIVE` | 编辑必须生成 draft version；运行中版本只读；删除/禁用直接改 ACTIVE 的 API；回滚同时更新 `current_version` 并写审计；部署/版本/回滚共用 `validateBoundContext()`；TC-039/041/042 通过 |
| P0-07 | 全局“全撤/停全部/只减仓”仍在顶栏，`scope: ALL`，无账户范围选择、无影响预览；设计稿明确要求移到运维页并显式选择范围 | 误点“停全部”会停掉所有账户/策略；交易员无法确认影响范围；与 V2 设计相反 | `web/src/components/AppShell.tsx:290-303`（顶栏三按钮）、`:176-199`（`/emergency/cancel-all` scope ALL、`/emergency/stop-all`）；设计 §4.1/§11.2；账户级按钮只在 `StrategyCenter.tsx:1220-1222` | 顶栏移除全局应急；运维页提供账户多选/全部范围、挂单数/持仓/预估影响、二次确认；策略详情默认当前策略；TC-043/044 通过 |
| P0-08 | 系统健康“任一 ORS/任一 Agent 在线”即绿；SimVenue Agent 19:45 已 OFFLINE，但 ORS 行仍 `RUNNING`（最后更新 2026-11-08 16:06），顶栏仍显示“交易通道已连接” | 交易员以为 SimVenue 可交易，实际 runtime-agent-simvenue 失败、策略无法运行；单柜台故障不可见 | `SystemStatusController.java:48-49` anyMatch；`/api/v1/system/status` `agent-simvenue-01=OFFLINE last_heartbeat=19:45`，`ors-simvenue-001=RUNNING updated_at=2026-11-08 16:06 pid=0`；`AppShell.tsx:161` 用 `agentOnline && orsRunning`；`systemctl status quantlink-fin-runtime-agent-simvenue` failed 143 | 按柜台/交易所/账户展示心跳与 age；任一授权柜台 P0 故障顶栏转红；`RUNNING` 必须有新鲜心跳，超时自动降级；单柜台故障注入 TC-047 |
| P0-09 | 行情有固定种子 tick / 全局 fallback；`PortfolioController` 只判断 tick 存在就 `stale=false`；驾驶舱/持仓不显示逐值数据龄 | 行情断线后仍显示“LIVE”和 PnL；拿旧价/固定价判断风险；一个合约有 tick 会掩盖其他合约 stale | `MarketDataService.java:80-90` seedFixedTicks、`:173-206` simulate、`:165-167` 全局 tick；`PortfolioController.java:80-86,116`；`OptionChainController.java:114-117` fallback；`Dashboard.tsx:90-94` 只有指标 10s stale | 固定/合成行情不得进入驾驶舱/PnL；每值显示 age；age>1s 黄/>3s 红并冻结报价；无 scoped tick 显示 N/A；行情断线整页降级；TC-026/027/028/029 通过 |
| P0-10 | SBE 仍是 v1 message id=3/4/5 原地加字段，不是设计要求的 V2 id=20-24；CTP 回报没有 book/deployment/generation/route/orderEpoch；控制面没有 FENCED/STALE_UPDATE 校验 | 旧 ORS/旧 generation 的回报可能覆盖新状态；book/strategy 归属靠控制面猜；实盘/重启场景不可信 | `abi/sbe/quantlink-fin-sbe.xml:121-193`（OrderRequest/OrderUpdate/Trade id 3/4/5 扩展）；`ctp_aeron_bridge.h:341-387` 只填 accountId/strategyKey/environment；`AeronOrderUpdateConsumer.java:362-396` 只用 strategyKey/account；grep 无 `FENCED`/`STALE_UPDATE` | 真正新增 V2 消息 ID/字段并保留 v1 兼容队列；CTP 回报填全上下文；旧 generation/ORS/fencing/route 拒绝并标 FENCED；TC-025/031/032/033 通过 |
| P0-11 | 迁移脚本 `migrate-t037` 直接 TRUNCATE strategies/orders/trades/positions/books，不做回填、无回滚；但 T-030-05/40 的验收是“迁移成功、无丢失、可回滚” | 无法从 V1 平滑升级；历史订单/成交/持仓不可追溯；shadow 数据被清空后无法证明迁移正确 | `tools/db/migrate-t037-strategy-center-v2.sql:46-48` `TRUNCATE ... CASCADE`；`docs/evidence/T-030/README.md:14` 明确“直接清空 V1 ... 不做回填”；`:102` 再次确认 clean bootstrap | 拆分“clean bootstrap”和“迁移”两个脚本；迁移需 backfill/校验/回滚；shadow 先 dry-run；T-030-05/40 重新验收 |
| P0-12 | Pair 真实双腿 E2E 未闭环：第二条腿平仓单被撤，18 秒后以 900 成交（当时 au 约 873.94），策略 PnL -335；订单无 deployment/route；runtime-agent-simvenue 失败 | 单腿裸露 18 秒，平仓价严重偏离；这不是“对冲成功”，而是“人工补救”；不能证明 Pair 自动化/风控可用 | `orders` 900000000027 `au2612 B CLOSE_TODAY @873.76 CANCELED`；900000000028 `au2612 B CLOSE_TODAY @900.00 FILLED`；`strategy_positions` 归零；`orders.deployment_id=NULL, deployment_generation=0, route_id=NULL`；`systemctl status quantlink-fin-runtime-agent-simvenue` failed；`T-030-progress.md:61` 仍为未勾选 | 启动 runtime-agent-simvenue + Pair runner；双腿同时成交/对冲；断腿超时/撤单/重试有明确策略；E2E 断言策略持仓、PnL、对账、无未归属；脚本化并归档证据 |

---

## 3. P1 问题表（影响可用性/对账/复盘）

| ID | 问题 | 交易员影响 | 证据 | 验收标准 |
|---|---|---|---|---|
| P1-01 | 策略详情只有持仓/订单/成交/版本，缺 PnL/风险、对账、日志、部署详情 Tab；`reconciliation` 返回了但 UI 不展示 | 看不到 PnL 曲线/回撤/Greeks/对账差异/请求日志，无法盘中判断策略是否健康 | `StrategyCenter.tsx:1052-1057` 只有 4 个 Tab；`reconciliation` 只出现在类型定义 `:218`；控制器 `StrategyCenterController.java:123-136` 已返回 | 详情页按设计 §10.1 提供概览/持仓/订单/成交/PnL/风险/对账/部署/日志；只显示当前策略；TC-049 |
| P1-02 | 手工单没有 previewId/accountVersion/环境/TIF/交易所确认；`exchange` 字段实际传的是 `counterpartyId`；没有独立手工交易页 | 下单前看不到名义/保证金/偏离/环境；无法区分同一柜台下 SHFE/DCE；容易误单 | `StrategyCenter.tsx:783-820` 只有账户/合约/方向/开平/价格/数量；`:411` `exchange: account.counterpartyId`；`TradingController.java:41-53` 请求无 previewId/accountVersion；`previewOrder` 只在后端 | 恢复独立手工交易页；preview 绑定 account/book/exchange/instrument/side/offset/price/qty/accountVersion；任一变化失效；确认框显示环境/名义/保证金/偏离；TC-050 |
| P1-03 | 订单/成交页只有账户筛选；无策略筛选、默认今日、CSV、asOf/stale；没有独立“总持仓”页 | 从策略详情无法跳转到该策略订单/成交；复盘要手工筛；总持仓只能进账户抽屉 | `OrdersV2.tsx:72-80` 只拼 accountId/status；`:105-113` 只有账户/状态；无 export/asOf；路由 `App.tsx:36-41` 无总持仓页 | 订单/成交默认今日+策略上下文；策略详情跳转带 strategyId；总持仓按账户分组，可下钻策略/持仓/未分配/订单；分页/排序/导出/asOf；TC-051/053 |
| P1-04 | 策略列表/详情/手工单没有 SHADOW/LIVE 环境标签；订单/成交环境硬编码 SHADOW | 交易员不知道当前策略/手工单在哪个环境；LIVE 误操作风险 | `StrategyCenter.tsx` 全文无 `environment/SHADOW/LIVE` 展示；`AeronOrderMapper.xml:36-46` 固定 `'SHADOW'`；`ctp_aeron_bridge.h:362,386` 固定 SHADOW；`TradingController` 无环境字段 | 列表/详情/订单/成交/手工确认显示环境；LIVE 红色角标+二次确认+`LIVE_ACK`；v1 默认禁用；TC-046 |
| P1-05 | 指标中心没有版本/引用/发布/停用/历史详情；阈值从未参与计算，`WARN/CRIT` 不会触发；16 个定义中短 ID 与策略 ID 重复 | 阈值是死配置；“IV Rank>70”不会告警；同一指标多个 ID 值相同，不知道哪个被策略引用 | `Indicators.tsx` 只有创建/编辑/卡片；无 version/reference/history；`IndicatorEngine.listEnabled` 不取 warning/critical；示例 `/indicators` 16 条，3 组 IV/RR/Rank 重复 | 指标注册表含 `indicator_id+version`；阈值服务端评估并告警；改口径生成新版本；引用关系可见；停用保护；TC-IND-01~10 |
| P1-06 | `strategy_positions.realized_pnl/fees` 从未更新；`applyFill` 无行锁/乐观版本；日终只结算 `positions`，不结算 `strategy_positions/book_positions` | 策略已实现盈亏/手续费永远 0；并发平仓可能超卖；今昨仓不随日终转换 | `StrategyPositionService.java:23-96` 只 upsert 数量/均价，realized/fees 原样保留；`SettlementService.java:44-97` 只遍历 `orders.listPositions(accountId)`；`StrategyPositionService` 无 lock 参数 | 成交事务同步 realized/fees；`(book,epoch,account,exchange,instrument)` 行锁/版本；日终 strategy/book today→yesterday；TC-007/009/011 |
| P1-07 | 对账只比“已有 strategy_positions 的合约”和“已有 account positions 的合约”，没有持仓的账户差异不进 issues；没有策略 PnL vs 账户 PnL diff | 没有归属的 84 手不会触发对账；账户 PnL 差异不可见；策略详情 `passed=true` 可能只是“没仓可对” | `ScopedReconciliationService.java:96-117` 只遍历 `listStrategyPositionNets`；`:119-140` 只遍历账户已有 positions；`reconciliation_status` TEST-001 失败但 pair/option `passed=true`；设计 §6.4 要求 PnL diff/tolerance | 对账同时检查账户/策略/手工/未分配和 PnL diff；无仓但有成交也要检查；阈值/连续失败/阻断；TC-001/014/020 |
| P1-08 | `account_pnl_snapshot` 存在 -3.27B 异常历史值；没有金额 sanity 校验/清理 | 一旦做 PnL 曲线会出现 -32 亿尖峰；交易员无法信任历史 | `select min(unrealized),max(unrealized) from account_pnl_snapshot` → `-3,268,641,360` / `1,172,960`；前 10 行均为 -3.268B；最新约 1.12M | 写入前校验 equity/unrealized 与持仓×价格一致；超出阈值拒绝并告警；异常历史标记/清理；P1 数据质量 |
| P1-09 | 手工簿没有独立列表/详情/撤单/平仓/只减仓页面；只有策略中心“交易簿”Tab 和手工单弹窗 | 手工单出错时无法按手工簿应急；手工簿持仓不可操作 | `StrategyCenter.tsx:686-708` 交易簿只读表格；无手工簿动作；路由无 `/manual-book`；T-030-29/37 未完成 | 独立手工簿页/详情；撤单/平仓/只减仓；不进策略排名/自动收盘；TC-018/019/045 |
| P1-10 | 期权链只有 2 个行权价、单边报价；无 OI/Volume/理论价/我们的 Bid/Ask/IV chg/数据龄；T-018 却标记 DONE | 无法选行权价、判断流动性/贵贱；Greeks 只显示 Delta；IV 参考值不完整 | `OptionChainV2.tsx:79-99` 只有 Bid/Ask/IV/Delta；`/option-chain` 900 call 无报价、920 put 无报价；`callOI/callVol=null`；`T-018` 验收勾选全 DONE | 期权链补 OI/Volume/理论价/IV chg/数据龄；Greeks 列可切换；无报价显示 N/A；T-018 重新验收 |
| P1-11 | 测试/演示数据污染：`reconciliation_status` 有 24 个 scope，含 E2E-CLOSE-A/B、V2-SIMVENUE-OPT、多个 Fork；`books=11`、`orders=6`、`trades=5`，与“clean bootstrap 零执行行”不符 | 对账页出现幽灵策略；交易员不知道哪些是测试数据；审计/排名被污染 | SQL：`reconciliation_status` 24 行，E2E-CLOSE-A/B `passed=false`；`books=11`；`orders=6/trades=5`；`docs/evidence/T-030/README.md:102` 声称清空后 0 | 测试数据清理/隔离 schema；reconciliation 只扫真实策略；证据归档带清理前后 SQL；禁止在生产 shadow 留 E2E 策略 |
| P1-12 | Greeks 到期时间用月末而非合约到期日；Vega 单位未定义；组合 Greeks 只覆盖 `positions` 表期权，不含 strategy 归因 | 临近到期 Theta/Gamma 估算偏差；Vega 阈值误报/漏报；策略层 Greeks 缺失 | `PortfolioController.java:143-150`、`OptionChainController.java:119-126`；`au2612C920` vega=61.039（原始）/61,039（乘 1000）；Dashboard 阈值 5000；策略详情无 Greeks | 用合约到期日；明确 Vega per 1 vol point；策略/账户/组合 Greeks 分层；数据龄；TC-RSK-04 验收 |

---

## 4. P2 问题表（体验/复盘）

| ID | 问题 | 交易员影响 | 证据 | 验收标准 |
|---|---|---|---|---|
| P2-01 | 策略列表无收藏/最近/固定/URL 分享；无列配置/保存视图/CSV/PDF | 每天重复筛选；复盘无法导出 | `StrategyCenter.tsx` 无 favorite/recent/column/export；`T-030-31` 列表只有基础列 | 收藏/最近/固定；URL 带筛选；CSV/PDF；列配置 |
| P2-02 | 策略详情无 PnL 曲线/最大回撤/限额占用 | 无法看策略历史表现和风险 | `StrategyCenter.tsx:1052-1057` 无 PnL Tab；`strategy_pnl_snapshot` 有 207 行但 UI 未用 | 详情 PnL/风险 Tab；曲线/回撤/限额；asOf/stale |
| P2-03 | 指标详情/历史/引用/公式说明缺失；卡片不能点击进详情 | 指标不可解释，交易员不知道口径和被谁引用 | `Indicators.tsx:288-327` 卡片只有值/阈值/编辑；无 history/引用 | 指标详情页：公式/输入/窗口/样本/最后计算/引用策略/历史图 |
| P2-04 | 状态中文/英文 tooltip/颜色规范未统一；列表不显示 `strategy_status` 三列 | 分不清 DRAFT/BOUND/ACTIVE/INACTIVE/STOPPED | `StrategyCenter.tsx:582-587` 只显示 deployment chip+version；DB pair `status=ACTIVE,strategy_status=DRAFT` | 列表三列 `book_type/deployment_status/strategy_status`；中文+英文 tooltip；颜色只用于 deployment |
| P2-05 | 账户汇总不能展开到策略/持仓/未分配/订单；无过滤跳转 | 差异定位要手工翻页 | `StrategyCenter.tsx:605-637` 账户表只读；`AccountDetailPanel` 有持仓/策略但无订单/下钻 | 账户行展开；策略/持仓/未分配/订单；带过滤跳转 |
| P2-06 | 数据保留/清理/归档无策略；指标和 PnL 快照无限增长 | 长期运行后查询变慢；磁盘/对账噪声 | `strategy_pnl_snapshot` 5 秒/策略；`account_pnl_snapshot` 无 retention；`indicator_values` 1s | 定义保留期/降采样/归档；监控表大小；清理任务 |
| P2-07 | 导航/页面仍保留旧管理页与 V2 页面混用；`/strategy-view` 旧路径仍在 Dashboard 提醒里 | 交易员可能进入旧页面看到旧口径 | `Dashboard.tsx:328` 跳 `/strategy-view`；`App.tsx` 路由；`StrategyCenter` 是 `/strategy-center` | 旧路径重定向或删除；导航只保留 V2；文档同步 |

---

## 5. 死数据根因与修复拆解（必须新增的子任务）

### 5.1 指标：不是“没人点页面”，是“ID/口径/管道三处断”

**根因链：**

1. **ID 断**：`IndicatorEngine` 写 `iv_atm_au` 等短 ID，`indicator_defs` 是 `SIMNOW-NIGHT-OPT-opt_atm_iv` 等策略级 ID。
2. **外键断**：`indicator_values.indicator_id` FK 到 `indicator_defs.id`；短 ID 插入直接失败。
3. **异常断**：`catch (RuntimeException ignored)` 把 FK 失败吞掉；没有 last_error、没有 DLQ、没有告警。
4. **管道断**：`emit()` 写短 ID，`evaluateDefinitions()` 写策略 ID，两套并存；`LEGACY_IDS` 又跳过短 ID；seed 文件种短 ID，互相打架。
5. **口径断**：`OPT_ATM_IV/IV_RANK/OPT_25D_RR` 用 futures 价格公式生成，不是期权链/曲面；同一 au2612 三处值不同。
6. **消费断**：Dashboard 取 `/indicators` 前 6 个（字母序），策略详情按 `strategy_id` 查；期权链根本不引用 indicator_id；三处不可能一致。
7. **治理断**：没有 indicator version、引用关系、发布/停用、阈值评估、历史详情、数据龄。

**新增子任务：**

| 子任务 | 内容 | 验收 |
|---|---|---|
| T-030-42A | 统一指标注册表/ID 契约：全局指标与策略指标用同一 `indicator_id`，策略关联放 `indicator_bindings`，禁止短 ID/策略 ID 双轨 | `indicator_defs` 无重复语义；engine 写入 ID 全部存在；零 FK 失败 |
| T-030-42B | 采集器重构：按定义计算 + 按 `(counterparty,exchange,instrument)` 取 tick；禁止全局 fallback；写入失败落 `indicator_write_error` 并告警 | 多柜台同合约不串价；FK 失败可见；TC-026/027 |
| T-030-42C | 真实期权指标：ATM 取最近有报价 strike；25Δ RR/BF 插值；IV Rank 用 N 日历史；无样本 N/A | 指标值与期权链/曲面一致；三处同一 `indicator_id+version`；TC-IND-06 |
| T-030-42D | 阈值/告警：服务端评估 warning/critical，冷却/确认/静默；指标 age>3s 策略暂停报价 | IV Rank>80 持续 5s 触发 P1；无刷屏；TC-IND-08 |
| T-030-42E | 指标版本/引用：改口径生成新版本；引用策略可见；停用保护 | 旧版本冻结；部署锁定版本；TC-IND-07/09 |

### 5.2 策略 PnL：有快照表，但没有“可对账的 PnL”

**根因：**

- `StrategyPnlService` 用现金流+市值，不是 FIFO；
- `strategy_positions.realized_pnl/fees` 不更新；
- `strategy_pnl_snapshot` 只存 `cash_flow/market_value/fees/pnl/positions_json`，没有 realized/unrealized 拆分、mark source、data age；
- 详情接口仍现算，`asOf=Instant.now()`；
- UI 不读 history；没有曲线/回撤；
- 行情 fallback 全局 tick，无法证明用的是部署柜台价。

**新增子任务：**

| 子任务 | 内容 | 验收 |
|---|---|---|
| T-030-43A | FIFO 已实现 PnL + 手续费逐笔归属；`strategy_positions` 成交事务同步 realized/fees；部分成交/平今平昨 | 与手工计算一致；TC-012 |
| T-030-43B | 未实现 mark source（LAST/SETTLEMENT/THEORETICAL）+ scoped tick + `as_of/source/stale/data_age` | 无 scoped tick 显示 N/A；不 fallback；TC-015 |
| T-030-43C | 快照 5s 落库 + 详情/列表读快照；UI PnL 曲线/回撤/版本切换点 | 刷新不跳变；曲线可追溯；TC-016/059 |
| T-030-43D | 策略 PnL vs 账户 PnL diff/tolerance/连续失败告警；超阈值阻断新开仓 | 差异可见；不静默覆盖；TC-014/020 |

### 5.3 驾驶舱：从“常量/mock”变成“派生但错误的真数据”

**根因：**

- 组合权益用 `accounts.balance`（静态初始值）+ 浮动 PnL；
- 只有 CTP 账户有 `account_snapshot`/`account_pnl_snapshot`；
- 固定种子 tick 被当成 LIVE；
- 没有逐值 age；
- 健康状态 anyMatch；
- 关键指标取字母序前 6 个，不是交易员关心的 ATM IV/IV Rank/价差/深度；
- 期权链/指标/组合 Greeks 三套 IV。

**新增子任务：**

| 子任务 | 内容 | 验收 |
|---|---|---|
| T-030-44A | 驾驶舱权益只读最新 `account_pnl_snapshot`/`account_snapshots`；无快照显示 N/A/STALE；禁止 `accounts.balance + pnl` | 4 账户逐一对比柜台；权益一致；TC-DASH-01 |
| T-030-44B | 删除/隔离固定种子 tick；所有 PnL/ Greeks 只用 scoped live tick；断线整页降级 | 断行情 5s：卡片红/冻结；不显示假 LIVE；TC-DASH-02/05 |
| T-030-44C | 关键指标卡改为交易员选择/固定 8 个，不从字母序 slice；每卡显示 age/source | ATM IV/IV Rank/价差/深度有值或 N/A；age 颜色正确 |
| T-030-44D | 顶栏健康按柜台/交易所/账户聚合，带最后心跳 age；单柜台故障转红 | SimVenue offline 顶栏红；TC-047 |
| T-030-44E | Greeks 用真实到期日/乘数/vega 单位；组合/策略/账户分层 | 与期权链/风险限额一致；TC-RSK-04 |

### 5.4 SimNow deposit/withdraw：字段通了，事件源没通

**新增子任务：**

| 子任务 | 内容 | 验收 |
|---|---|---|
| T-030-45A | CTP 增加 `ReqQryAccountRegister`（账户流水）或等价的资金流水事件合同；记录 deposit/withdraw/close profit/fee/transfer 时间、流水号、摘要 | 能查当日/历史流水；幂等；不重复 |
| T-030-45B | `account_pnl_snapshot` 用交易日历，不用 CURRENT_DATE；增加 `pre_balance/pre_close_equity`；cash/available 分列 | 夜盘 22:00 的 trading_day=下一交易日；权益变化=出入金+PnL-费用 |
| T-030-45C | 非零出入金 E2E：入金→快照→权益变化→出金→对账；所有账户（CTP/SimVenue/SimLocal）有快照或明确 N/A | deposit/withdraw 非零；账户 PnL 可解释；TC-013/017 |

### 5.5 Pair E2E：有成交，但没有“干净的对冲闭环”

**事实：**

- `orders` 900000000024/25 双腿开仓 FILLED；
- 900000000026 ag 平仓 FILLED；
- 900000000027 au 平仓 `CANCELED @873.76`；
- 900000000028 au 平仓 `FILLED @900.00`，比当时 au 约 873.94 高约 3%；
- 策略 PnL -335，其中大部分来自这条腿的追价；
- 订单 `deployment_id=NULL`、`deployment_generation=0`、`route_id=NULL`；
- `runtime-agent-simvenue` 19:45 已 failed，当前没有 Pair runner。

**新增子任务：**

| 子任务 | 内容 | 验收 |
|---|---|---|
| T-030-46A | 启动/修复 runtime-agent-simvenue，策略实例 ID 与 DB 对齐（配置里是 `TEST-STRAT-SIMVENUE-OPT-01`，DB 是 `SIMVENUE-OPT-01`） | Agent ONLINE；策略 deploy 后 actual=RUNNING |
| T-030-46B | Pair runner 双腿开/平仓；腿成交超时、撤单、重试、追价上限、单腿裸露告警；禁止无归属手工补救 | 双腿同时成交；单腿裸露 < 阈值；PnL/持仓/对账一致 |
| T-030-46C | E2E 脚本断言：策略持仓、PnL、账户归因、无 UNASSIGNED、审计、订单 deployment/route/fencing 字段 | 一键跑通；证据归档；T-030-46 才能真正勾选 |

### 5.6 其他必须补的子任务

| 子任务 | 内容 | 验收 |
|---|---|---|
| T-030-47 | 未分配持仓引擎：`unassigned = account - strategy - manual`；认领更新 `book_positions/strategy_positions`；60s 告警/阈值阻断 | TEST-001 84 手显示未分配；认领后归零；TC-001/003/004 |
| T-030-48 | 版本/状态治理：编辑生成 draft version；禁止直接 PUT 运行配置；禁止 POST status ACTIVE；回滚更新 current_version | 版本历史/回滚/审计；TC-039/041/042 |
| T-030-49 | 应急范围：顶栏移除全局；运维页账户多选/全部；影响预览；二次确认；手工簿动作 | 单项策略/账户/全部范围正确；TC-043/044/045 |
| T-030-50 | 迁移/回填：拆分 clean bootstrap 与迁移；backfill/校验/回滚；双跑对比 | 迁移后无归属订单/成交=0；可回滚；T-030-05/40 |
| T-030-51 | 真正 SBE v2：新消息 ID/字段；v1 兼容队列；CTP 回报全上下文；FENCED/STALE_UPDATE | TC-025/031/032/033 |
| T-030-52 | 指标一致性/版本：三处同一 `indicator_id+version`；期权链也引用指标 | 同一时刻三处值/单位/时间戳一致；TC-IND-06 |
| T-030-53 | 手工单 preview：accountVersion/previewId/环境/交易所/TIF；无 preview 禁止提交 | 改价/改量/改账户旧 preview 失效；TC-050 |

---

## 6. T-030-01 ~ T-030-41 逐项矩阵

状态口径：

- ✅ 完全闭环：交付物存在，且按验收标准有运行证据；
- ◐ 部分完成：有代码/页面/表，但验收缺一项以上；
- ✗ 未完成：无实现，或实现与设计冲突。

| ID | 任务 | 状态 | 证据/缺口 |
|---|---|---|---|
| T-030-01 | V2.1 设计冻结 | ✅ | `closure2` 对 P0-03/P1-13 APPROVE；设计文档存在。仅设计层闭环，不代表实现 |
| T-030-02 | 数据模型迁移设计 | ◐ | `migrate-t037` 有 DDL，但默认脚本 TRUNCATE，无回填/回滚；验收“表、约束、回填、回滚评审通过”不成立 |
| T-030-03 | SBE v2 合同冻结 | ✗ | 仍是 `OrderRequest id=3 / OrderUpdate id=4 / Trade id=5` 原地扩展；无 V2 message id=20-24；v1/v2 分流未实现 |
| T-030-04 | API/错误码/权限合同冻结 | ◐ | 部分接口/错误码存在；无 OpenAPI；权限未覆盖所有数据页；错误码不一致 |
| T-030-05 | DB 迁移与回填 | ✗ | `migrate-t037:46-48` TRUNCATE；无 backfill；无 rollback；证据文档自认“clean bootstrap 不做回填” |
| T-030-06 | Book/BookPosition 模型 | ✅ | `books` 11 行，MANUAL/UNASSIGNED/STRATEGY 分离；`book_positions` 有 1 行手工期权；服务存在 |
| T-030-07 | 账户持仓权威化 | ◐ | `positions` 同时被 CTP PositionSnapshot 和 ExecutionLedger 本地成交修改；account recon TEST-001 失败 532 次；无 `source/as_of` 字段体系 |
| T-030-08 | 权限表与 AuthorizationService | ◐ | `AccountAccessService` 覆盖手工/策略中心；未证明所有订单/成交/持仓/账户接口 403；无权限矩阵测试报告 |
| T-030-09 | 行情键改造 | ◐ | `MarketDataService` 有 scoped tick；但 PnL/期权链/账户快照/指标都有全局 fallback；不满足“不串价” |
| T-030-10 | 数据库不变量/启动检查 | ◐ | `accounts.venue_id UNIQUE`、ACTIVE deployment 部分唯一索引存在；无 bound_* 不可变 DB 约束；启动检查有限 |
| T-030-11 | SBE v2 发布/消费 | ✗ | 无 v2 消息/兼容队列；producer/consumer 直接改 v1；旧客户端兼容性未验证 |
| T-030-12 | CTP/ORS 归属映射 | ◐ | `orderMeta` 持久化 strategyKey/requestId/front/session；不持久化 book/account/counterparty/deployment/generation；CTP 回报只填 strategyKey/account |
| T-030-13 | 订单/成交归属字段 | ◐ | 表字段齐全；实际 `orders.deployment_id=NULL`、`generation=0`、`route_id=NULL`；environment 固定 SHADOW |
| T-030-14 | 策略持仓引擎 | ◐ | 有 strategy_positions/epoch/今昨；无 realized/fees 更新，无日终 rollover，无行锁；当前所有行 0 |
| T-030-15 | 策略平仓校验 | ✅ | `StrategyOrderService:189-196` + `StrategyPositionService.closeable` 取 min；E2E A=2/B=8 拒绝平 5；并发锁未验证 |
| T-030-16 | 策略 PnL 引擎 | ◐ | 有 snapshot 表/API；公式非 FIFO；无 realized/unrealized；UI 不读 history；detail 现算 |
| T-030-17 | 账户 PnL 快照与对账 | ✗ | 只有 TEST-001；trading_day 错；cash=available；无 pre_close baseline；deposit/withdraw 0；无 diff/tolerance 阻断 |
| T-030-18 | 未分配与认领 | ◐ | 表/UI/认领/审计存在；claim 只改 trades，不更新 positions；60s 告警/阈值阻断未实现；account diff 84 显示未分配 0 |
| T-030-19 | 路由/fencing/FENCED | ◐ | CTP bridge 校验 agent/account/fencing；控制面无 FENCED/STALE_UPDATE/generation 拒绝；route_id 未落订单 |
| T-030-20 | 策略/账户对账 Gate | ◐ | Gate 接入手工/策略/runner；只做 position/trade 对账；TEST-001 失败 532 次；无 PnL diff/age 阻断 |
| T-030-21 | 策略列表 | ◐ | 列表可用，3 策略；缺环境、对账状态、strategy_status 三列；不显示手工簿（符合） |
| T-030-22 | 策略详情 | ◐ | 有持仓/订单/成交/版本/部署；缺 PnL/风险/对账/日志 Tab；reconciliation 未渲染 |
| T-030-23 | 账户上下文卡片 | ◐ | 有权益/可用/保证金/共享策略数；缺账户 PnL/差异/其他策略 PnL/风险度/本策略估算占用 |
| T-030-24 | 行情/期权链/手工入口 | ◐ | 期权链页/手工弹窗存在；无独立手工页/ preview/环境/交易所联动；期权链仅 2 档 |
| T-030-25 | 订单/成交/总持仓页面 | ◐ | OrdersV2 有账户筛选；无策略筛选/默认今日/导出/asOf；无总持仓独立页 |
| T-030-26 | 移除顶部柜台选择器 | ✅ | `AppShell` 无 venue selector；导航 6 页可用。注意顶栏仍保留全局应急（T-030-36） |
| T-030-27 | 总持仓按账户 | ◐ | 账户 Tab/详情有持仓；无独立总持仓页/按账户分组下钻/订单下钻 |
| T-030-28 | 账户汇总详情 | ◐ | 有账户/策略/持仓/手工/未分配；无订单/PnL/导出/差异定位跳转 |
| T-030-29 | 手工簿页面 | ✗ | 只有“交易簿”只读 Tab；无详情/撤单/平仓/只减仓 |
| T-030-30 | 绑定四元组 | ◐ | 四字段存在；deploy 校验四元组；无 DB 不可变约束；直接 edit 不校验绑定 |
| T-030-31 | 策略版本 | ◐ | 版本表/列表/创建；编辑直接 PUT 配置，不生成版本；无草稿/版本回滚 |
| T-030-32 | Fork | ✅ | Fork 复制 config/version/pair/指标，不复制持仓/订单/成交/PnL；审计存在 |
| T-030-33 | 部署状态机 | ◐ | 有 BOUND/ACTIVE/INACTIVE/FAILED；无 STOPPING/drain/reconcile/ROLLED_BACK；activate 只改 DB；离线 Agent 未阻断 |
| T-030-34 | 版本更新安全 | ◐ | deploy 有 carry 409 保护；UI 先 stop/flatten；version 接口绕过；无 drain/审批 |
| T-030-35 | 策略应急 | ◐ | 策略详情“停止并平仓” scope STRATEGY；无影响预览/单独撤单/只减仓/平仓动作 |
| T-030-36 | 账户/全局应急 | ✗ | 顶栏全撤/停全部/只减仓 scope ALL；无账户选择/范围预览；账户按钮仅在详情 |
| T-030-37 | 手工簿应急 | ✗ | 无手工簿撤单/平仓/只减仓 |
| T-030-38 | LIVE/SHADOW | ✗ | 策略列表/详情/手工单无环境标签；orders/trades 固定 SHADOW；无 LIVE_ACK/禁用 |
| T-030-39 | 柜台/交易所健康 | ✗ | 系统状态 any ORS/any Agent；SimVenue offline 仍 RUNNING；无按交易所下钻 |
| T-030-40 | 迁移与双跑 | ✗ | clean bootstrap TRUNCATE；无回填/双跑/对比/回滚 |
| T-030-41 | 回归与证据 | ◐ | 4 个 Playwright 脚本；无完整 TC 结果矩阵、性能/Chaos、截图归档、交易员签字 |

**统计：✅ 5（01、06、15、26、32）；◐ 26；✗ 10；未闭环 36/41。37 个 P0 中仅 5 个闭环，32 个 P0 未闭环。**

> 与 `docs/evidence/T-030/README.md:551-552` 的“29 项闭环、12 项部分/未闭环”不一致。差异原因：该自评把“有代码/有表/有页面”计为闭环；本报告按设计稿验收标准、运行数据和交易员可用性计。自评文档本身在 `:553-558` 也承认“策略详情缺 PnL/风险/对账/日志、手工簿无独立详情/应急、编辑未生成草稿版本、部署 drain/审批/回滚未完整演练、完整 TC/性能/Chaos/最终验收未完成”——这些恰好是未闭环项。

---

## 7. 设计稿 §15 验收逐条对照

| # | 验收条 | 状态 | 证据/缺口 |
|---|---|---|---|
| 1 | 无顶部柜台选择器 | ✅ | `AppShell.tsx` 无 venue selector |
| 2 | 策略列表/详情是主入口 | ✅ | 导航 `/strategy-center`，列表/抽屉详情 |
| 3 | 策略有独立持仓和 PnL | ✗ | `strategy_positions` 两行全 0；PnL 现算且非 FIFO；两个期权策略 0 但账户有 84 手未归属 |
| 4 | 策略详情只显示该策略数据 | ◐ | orders/trades/positions 按 strategy_id 过滤；PnL/指标/行情仍可能用全局 tick，非严格隔离 |
| 5 | 一个账户可有多个策略 | ✅ | SIMVENUE-001 有 PAIR + SIMVENUE-OPT-01 |
| 6 | 一个策略只能有一个部署上下文 | ✅ | 3 策略各 1 个 deployment；DB 有 ACTIVE 部分唯一索引 |
| 7 | 已部署策略不能选择其他 Agent | ✅ | `StrategyDeploymentController:133-145` 四元组 409；UI 不提供其他 Agent |
| 8 | 已部署策略编辑后只能更新当前 Agent | ◐ | 部署路径校验；`PUT /strategies/{id}` 可直接改配置，version 接口不校验 |
| 9 | Fork 生成新策略，不继承持仓/订单/成交/PnL | ✅ | Fork 只复制 config/version/pair/indicators |
| 10 | 策略版本历史可查看、可回滚 | ◐ | 历史表可见；只支持 deployment rollback，不支持版本回滚；rollback 不改 current_version |
| 11 | 带持仓升级必须显式确认或先平仓 | ◐ | deploy 有 carry 409；UI 先 stop；version 接口可绕过；无 drain |
| 12 | 手工单归属 MANUAL，不进策略部署选择 | ✅ | 900000000023 手工单 book=MANUAL，strategy_id NULL；策略列表不含手工簿 |
| 13 | 总持仓按账户汇总 | ◐ | 账户 Tab/详情有；无独立总持仓页/按账户分组下钻 |
| 14 | 账户持仓以柜台快照为权威 | ◐ | `positions` 由 CTP snapshot + 本地成交共同修改；TEST-001 对账失败 532 次 |
| 15 | 账户=快照；归因=策略+手工；未分配=差额 | ✗ | account diff=-84，unassignedNet=0；未分配只来自 `unassigned_trade`，不是持仓差额 |
| 16 | 策略 PnL 与账户 PnL 对账差异可见 | ✗ | 只有 position/trade recon；无 PnL diff；策略详情 `passed=true` 不覆盖账户 PnL |
| 17 | 订单/成交携带 book/strategy/account/counterparty/ors/exchange | ◐ | 表字段有；实际 orders `deployment_id=NULL/route_id=NULL`；environment 固定；ors 为空 |
| 18 | 一个柜台支持多个交易所 | ✅ | `counterparty_exchange` 有 SIMNOW 4 个交易所等 |
| 19 | 策略可跨交易所但不能跨柜台 | ◐ | 模型支持 exchange；无跨交易所策略运行证据；无跨柜台测试 |
| 20 | 行情按 `(counterparty,exchange,instrument)` 隔离 | ✗ | scoped store 有，但 PnL/期权链/账户快照/指标有全局 fallback；多柜台同合约会串价 |
| 21 | 无有效 ORS fail-closed，不 fallback | ◐ | `AeronOrderUpdateConsumer` 无 route 时 log+return；没有明确 `NO_ACTIVE_ROUTE` 返回；运行时 gate 有 |
| 22 | 旧 generation/ORS/fencing 回报被拒绝 | ✗ | 无 FENCED/STALE_UPDATE；OrderUpdateConsumer 不校验 generation/fencing；仅 CTP bridge 校验 fencing |
| 23 | 策略平仓只消耗策略自身持仓 | ✅ | `StrategyOrderService:189-196` + `StrategyPositionService.closeable`；E2E A=2/B=8 通过 |
| 24 | 手工单确认包含账户/柜台/环境/开平/TIF/previewId | ✗ | 手工弹窗仅 6 字段；无 previewId/accountVersion/环境/TIF；exchange 传 counterparty |
| 25 | 紧急操作默认当前策略 | ✅ | `stopStrategy` 只发 `scope:STRATEGY`；详情按钮“停止并平仓” |
| 26 | 账户/全局应急显式选择范围 | ✗ | 顶栏全撤/停全部/只减仓 scope ALL；无范围预览/账户选择 |
| 27 | 权限默认拒绝，无权限 403 | ◐ | 策略中心/手工有 `AccountAccessService`；未证明所有数据接口；VIEWER 403 有证据 |
| 28 | LIVE/SHADOW 在列表/详情/手工单显式显示 | ✗ | 策略中心无环境标签；orders/trades 固定 SHADOW；无 LIVE_ACK |
| 29 | CTP 回报能回填 strategy/book/account/counterparty/exchange | ◐ | CTP 只填 strategyKey/account；控制面从 order 补 book/counterparty/exchange；deployment/generation/route/fencing 缺失 |

**统计：✅ 10（1、2、5、6、7、9、12、18、23、25）；◐ 11（4、8、10、11、13、14、17、19、21、27、29）；✗ 8（3、15、16、20、22、24、26、28）。**

---

## 8. 文档声称完成但实际未闭环（重点）

| 文档声称 | 实际 | 证据 |
|---|---|---|
| `T-030-progress.md` / evidence：29 项闭环 | 本报告只认 5 项完全闭环；36/41 未闭环 | §6 矩阵；自评文档 `:553-558` 自认多项未完成 |
| “SBE v2 schema fields + codegen” | 仍是 v1 message id=3/4/5 原地加字段；无 V2 id=20-24 | `abi/sbe/quantlink-fin-sbe.xml:121-193` |
| “Account PnL snapshot realized/fees from ledger” | 只有 TEST-001；trading_day 错；cash=available；deposit/withdraw 0；无 baseline | `AccountSnapshotMapper.xml:13-20`；105 行全 TEST-001 |
| “MarketData scoped；策略 PnL 和期权链优先 scoped” | fallback 全局 tick 仍存在；账户快照/指标也全局 | `StrategyPnlService.java:63-67`；`OptionChainController.java:114-117`；`AccountSnapshotService.java:36-57` |
| “V2 orders/trades page” | 只有账户筛选；无策略筛选/默认今日/CSV/asOf；无总持仓页 | `OrdersV2.tsx:72-113` |
| “Version creation + carry deploy UI” | 编辑直接 PUT 覆盖配置；version 接口绕过 carry；rollback 不改 current_version | `StrategyCenter.tsx:320-355`；`TradingController.java:160-170`；`StrategyDeploymentController.java:207-229` |
| “Deployment rollback UI” | 只回滚 deployment 行；`strategies.current_version` 不变；generation 用 `System.currentTimeMillis()` | `StrategyDeploymentMapper.xml:151-158` |
| “Account/global emergency” | 顶栏 scope ALL；无范围预览；设计要求移到运维页 | `AppShell.tsx:176-199,290-303` |
| “Final regression + evidence refresh” | 只有 4 个 Playwright 脚本；无 TC 矩阵/性能/Chaos/截图 | `docs/evidence/T-030/README.md:436-447`；无结果文件 |
| “Pair 真实双腿 E2E” | 第二腿平仓被撤，18s 后 @900 成交（市场 ~873.94）；订单无 deployment/route；Agent offline | `orders 900000000027/28`；`runtime-agent-simvenue` failed |
| “Clean bootstrap 零执行行” | 当前 books=11、orders=6、trades=5；recon 24 个 scope 含 E2E 幽灵策略 | SQL 结果；`reconciliation_status` |
| “Indicator 16 defs 有实时值，驾驶舱无数据=false” | 值存在但 IV/IV Rank/RR 是公式；三处 IV 不一致；阈值不触发 | `/indicators` 18.02/50.1/1.808；`/option-chain` 10.72%；`IndicatorEngine` 公式 |
| `T-018` 状态 DONE | 期权链只有 2 档、单边报价、无 OI/Volume/理论价/IV chg/数据龄/Gamma/Vega/Theta | `OptionChainV2.tsx:79-99` |

---

## 9. 设计稿要求但当前 UI/后端缺失

### 9.1 策略详情

- 缺 `PnL / 风险` Tab：PnL 曲线、最大回撤、限额占用。
- 缺 `对账` Tab：策略持仓 vs 成交、策略持仓 vs 账户归属、PnL diff。
- 缺 `日志` Tab：策略运行日志、requestId/clientOrderId。
- 缺 `部署` 详情：generation/desired/actual、绑定 Agent/ORS、当前/草稿/历史版本、回滚入口。
- 缺环境标签（SHADOW/LIVE）。
- 详情 `reconciliation` API 已返回但 UI 未渲染。

### 9.2 编辑/版本

- 设计：编辑 → 新 draft version → 校验 → 更新到当前 Agent；历史版本可回滚。
- 实际：`PUT /strategies/{id}` 直接覆盖 `config_json/name/type`；`POST /strategies/{id}/status` 可直接改 ACTIVE； `PUT /strategies/{id}/versions` 只插版本并改 current_version，不校验绑定/持仓；回滚只回滚 deployment。

### 9.3 手工簿

- 设计：独立手工簿列表/详情/动作（撤单/平仓/只减仓），不进策略排名/自动收盘。
- 实际：只有策略中心“交易簿”只读 Tab；手工单弹窗；无独立页/动作。

### 9.4 LIVE/SHADOW

- 设计：策略列表/详情/订单/成交/持仓/手工单/确认框均显示环境；LIVE 红色角标/水印/二次确认/LIVE_ACK；v1 默认禁用。
- 实际：`StrategyCenter` 无环境字段；订单/成交 `environment` 固定 `'SHADOW'`；无 LIVE_ACK。

### 9.5 柜台/交易所健康

- 设计：顶栏健康可展开到柜台/交易所；策略详情显示所属柜台/交易所健康/数据龄；任一授权柜台 P0 故障顶栏转红。
- 实际：`SystemStatusController` 用 anyMatch；SimVenue Agent offline 但 ORS 行 stale RUNNING；顶栏仍绿；无按交易所下钻。

### 9.6 账户/全局应急

- 设计：账户/全部操作只在运维页；显式选择范围；展示影响范围；二次确认；顶栏无全局应急。
- 实际：顶栏三按钮 scope ALL；无范围预览；账户按钮只在账户详情；手工簿无应急。

### 9.7 版本回滚

- 设计：`POST /strategies/{id}/rollback`，回到同一 Agent 的历史版本。
- 实际：只有 `POST /strategy-deployments/{id}/rollback`；不更新 `strategies.current_version`；没有策略级版本回滚。

### 9.8 指标一致性/版本

- 设计：指标是一等对象，有 ID/版本/口径/单位/所有者/依赖/引用；一处定义三处消费；改口径生成新版本；阈值告警；数据龄。
- 实际：`indicator_defs` 无 version 字段；无引用表；无发布/停用；阈值不评估；无历史详情；短 ID/策略 ID 双轨；三处 IV 不一致。

### 9.9 总持仓/订单/成交

- 设计：总持仓按账户分组、可下钻策略；订单/成交默认今日、策略跳转、分页/排序/列配置/CSV/asOf/stale。
- 实际：无独立总持仓页；OrdersV2 只有账户筛选；无导出/asOf/列配置；策略详情无跳转。

### 9.10 迁移/双跑

- 设计：迁移脚本、回填、双写/兼容队列、迁移后无归属=0、可回滚。
- 实际：`migrate-t037` 直接 TRUNCATE；无 backfill；无 rollback；无双跑。

---

## 10. 运行数据证据（截至 2026-11-09 22:30 CST）

### 10.1 表计数

```text
indicator_defs            16   （22:18 时为 9）
indicator_values          10,369（22:18 时为 0；22:18:46 起并发修复写入）
strategy_pnl_snapshot     207
account_pnl_snapshot      105  （全部 TEST-001）
strategies                3
strategy_deployments      3
strategy_positions        2    （全部 0 手）
book_positions            1    （SIMVENUE 手工 au2612C920 1 手）
orders                    6
trades                    5
positions                 5
books                     11
unassigned_trade          0
```

### 10.2 策略/部署

```text
PAIR-SIMVENUE-MW9C01BR  status=ACTIVE  strategy_status=DRAFT  deployment=BOUND/INACTIVE/STOPPED
SIMNOW-NIGHT-OPT        status=DRAFT   strategy_status=DRAFT  deployment=BOUND/INACTIVE/STOPPED
SIMVENUE-OPT-01         status=DRAFT   strategy_status=DRAFT  deployment=BOUND/INACTIVE/STOPPED
```

三个策略全部 `actual_state=STOPPED`，没有一个 ACTIVE 运行；SimVenue Agent offline。

### 10.3 PnL

```text
pair detail: cashFlow=-335, marketValue=0, fees=0, pnl=-335, positions=[]
pair reconciliation: passed=true, issues=[]
SIMNOW-NIGHT-OPT pnl=0
SIMVENUE-OPT-01 pnl=0
strategy_pnl_snapshot: 3 strategies × ~56 samples; pair -335 constant; options 0
account detail TEST-001: accountNet=-84, strategyNet=0, manualNet=0, unassignedNet=0, difference=-84
accountPnl TEST-001: equity=22,650,689.04, cash=18,971,365.84, realized=0, unrealized=1,120,888.71, deposit=0, withdraw=0
```

### 10.4 对账

```text
ACCOUNT TEST-001: passed=false, issue_count=2, consecutive_failures=532
  ACCOUNT_POSITION_MISMATCH ag2706 account position=-88 trades=0
  ACCOUNT_POSITION_MISMATCH au2612 account position=4 trades=0
STRATEGY PAIR-SIMVENUE-MW9C01BR: passed=true
STRATEGY E2E-CLOSE-A/B: passed=false（测试残留）
```

### 10.5 驾驶舱/期权链/指标

```text
/api/v1/portfolio/live:
  balance=4,126,492.62
  available=2,796,110
  margin=202,715
  pnl=1,127,667.62
  delta=2,787.56
  vega=61,013.61

/api/v1/option-chain?underlying=au2612&expiry=202612&counterpartyId=SIMVENUE&exchange=SHFE:
  strike 900: callBid=0, callAsk=0, callIV=null；putBid=6.79, putAsk=6.81, putIV=null
  strike 920: callBid=1.79, callAsk=1.81, callIV=0.10717, callDelta=0.10762, callVega=61.039
              putBid=0, putAsk=0, putIV=null

/api/v1/indicators:
  iv_atm_au=18.02%, iv_rank_au=50.1, rr25_au=1.808
  SIMNOW/SIMVENUE opt_atm_iv=18.02/18.03, opt_iv_rank=50.1, opt_25d_rr=1.808
  PAIR_SPREAD=10926.68, PAIR_ZSCORE=-0.5378, PAIR_HEDGE_LATENCY=13.034
  vega_pf=60,806.77, delta_pf=2,787.12
```

### 10.6 健康

```text
/api/v1/system/status:
  environment=SHADOW
  agentOnline=true
  orsRunning=true
  marketFresh=true
  marketAgeMs=28
  agent-simvenue-01 status=OFFLINE last_heartbeat=2026-11-09T19:45:29
  ors-simvenue-001 status=RUNNING pid=0 updated_at=2026-11-08T16:06:04
  ors-shengli status=HALTED error="ORS exited 3 times; manual release/activate required"

SimVenue health.json:
  connected=true, positions=3, tradesFilled=5, lastEventAgeMs=142006
```

### 10.7 Pair 订单

```text
900000000024 ag2612 B OPEN  FILLED 1 @11800
900000000025 au2612 S OPEN  FILLED 1 @873.62
900000000026 ag2612 S CLOSE FILLED 1 @11799
900000000027 au2612 B CLOSE CANCELED 0 @873.76
900000000028 au2612 B CLOSE FILLED 1 @900.00
all: deployment_id=NULL/deployment_generation=0/route_id=NULL/environment=SHADOW
```

### 10.8 SimVenue 行情/合约

- `quantlink-fin-sim-feed.service` active；`SimVenueMain` 订阅 `md-stream 1001`；`health.json connected=true`。
- 但这是 `qf-sim-long` + `SimMdPublisher` 生成的**模拟行情**，不是外部真实市场；`SimVenue` 是模拟柜台。
- 可交易合约（instruments 9 个）：
  - 期货：`ag2612`、`au2612`、`ag2706`、`ad2605`
  - 期权：`au2612C900`、`au2612C920`、`au2612P900`、`au2612P920`、`ad2604C26200`
- 当前策略只用 SHFE `ag2612/au2612`；期权链只有 900/920 两档，且 900 call / 920 put 无报价。

---

## 11. 最小闭环顺序（交易员建议）

1. **P0-01/P0-03/P0-05 账户真相**：账户快照权益 + 交易日 + 未分配 = 账户 - 策略 - 手工；先把 84 手未归属显式化。
2. **P0-02/P1-05 指标真相**：统一 ID/版本/采集/口径；IV/IV Rank/RR 从期权链/历史算；三处一致；阈值生效。
3. **P0-04/P1-06 PnL 真相**：FIFO + fees + unrealized + scoped mark + 快照/age；策略详情接 history。
4. **P0-06/P0-07/P0-08 治理/安全**：编辑生成版本、禁止直接 ACTIVE、回滚更新 current_version；顶栏移除全局应急；按柜台健康。
5. **P0-09/P0-10 行情/协议**：删除固定种子/全局 fallback；真正 V2 消息 + CTP 全上下文 + FENCED。
6. **P0-11/P0-12 迁移/Pair**：拆分 clean bootstrap/迁移；修复 SimVenue Agent；双腿对冲 E2E。
7. **P1/P2 体验**：手工页/总持仓/订单过滤/环境/LIVE、导出/收藏/曲线/指标详情。

在此之前，T-030 不应宣称完成，也不应把“29/41 闭环”作为对外口径。

---

## 12. 附：关键文件证据索引

| 主题 | 文件 |
|---|---|
| 指标 ID/写入 | `backend/control-plane/src/main/java/com/quantlink/fin/control/market/IndicatorEngine.java` |
| 指标 Mapper/FK | `backend/control-plane/src/main/resources/mapper/IndicatorMapper.xml` |
| 策略 PnL | `backend/control-plane/src/main/java/com/quantlink/fin/control/market/StrategyPnlService.java` |
| 策略 PnL 快照 | `backend/control-plane/src/main/java/com/quantlink/fin/control/market/StrategyPnlSnapshotService.java`、`mapper/StrategyPnlMapper.xml` |
| 账户快照 | `market/AccountSnapshotService.java`、`mapper/AccountSnapshotMapper.xml`、`aeron/AccountSnapshotConsumer.java` |
| 驾驶舱 | `web/src/pages/Dashboard.tsx`、`portfolio/PortfolioController.java`、`mapper/PortfolioMapper.xml` |
| 策略中心 UI | `web/src/pages/StrategyCenter.tsx` |
| 策略中心 API | `api/StrategyCenterController.java`、`mapper/StrategyCenterMapper.xml` |
| 版本/部署 | `api/StrategyDeploymentController.java`、`mapper/StrategyDeploymentMapper.xml` |
| 直接编辑/状态 | `api/TradingController.java` |
| 应急 | `web/src/components/AppShell.tsx`、`api/EmergencyController.java` |
| 健康 | `api/SystemStatusController.java` |
| 行情 | `market/MarketDataService.java` |
| CTP 字段 | `ctp-adapter/src/ctp_trader_session.h`、`ctp_aeron_bridge.h` |
| SBE | `abi/sbe/quantlink-fin-sbe.xml` |
| 迁移 | `tools/db/migrate-t037-strategy-center-v2.sql` |
| 自评证据 | `docs/evidence/T-030/README.md` |
| 进度 | `docs/tasks/T-030-progress.md` |

---

*本评审只读；未修改生产代码、未重启服务、未修改数据库。评审期间工作区/运行态被并发修改，结论以 2026-11-09 22:30 CST 的证据快照为准。*

# T-030 策略中心 V2 实施与自测记录

- 分支：`feature/strategy-center-v2`
- 日期：2026-11-09
- 设计：`docs/architecture/23-策略中心V2设计稿.md`
- 任务：`docs/tasks/T-030-策略中心V2.md`
- 用例：`docs/testing/T-030-策略中心V2测试用例.md`

## 已完成

### Phase 0/1：数据、归属、权限、行情

- `tools/db/migrate-t037-strategy-center-v2.sql`
  - V2 clean bootstrap，直接清空 V1 执行/持仓/策略数据，不做回填
  - `books`、`book_positions`
  - `counterparty_exchange`
  - `strategies` 绑定四元组、版本、部署状态
  - `strategy_versions`
  - `strategy_positions` 增加 `book_id/position_epoch/counterparty_id/exchange/source/as_of/stale/realized_pnl/fees`
  - `orders/trades` 增加 `book_id/strategy_id/counterparty_id/exchange/deployment/environment/ors/fencing/route/order_epoch`
  - `account_pnl_snapshot`
  - `user_account_permission`
  - `unassigned_trade`、`position_assignment`
- 所有订单/成交写入显式填写 book/策略/账户/柜台/交易所，不使用旧数据兼容触发器
- `tools/db/migrate-t039-simvenue-fees.sql`
  - SimVenue 阴影账户补齐零费率，避免成交因缺费率被丢弃
- 默认拒绝的账户权限：`AccountAccessService`
- 手动下单与预览接入账户权限；VIEWER 不能下单
- 策略关闭校验接入策略持仓与账户可平量，取更严格值，拒绝负持仓
- 账户 PnL 快照写入；未知合约持仓快照不再抛异常（跳过并在后续告警）
- 市场行情拒绝乱序/旧 tick，避免慢 WebSocket 阻塞行情消费

### Phase 2：归属、对账、Book、PnL

- 策略中心只读 API：
  - `GET /api/v1/strategy-center/overview`
  - `GET /api/v1/strategy-center/strategies/{id}`
  - `GET /api/v1/strategy-center/accounts/{id}`
  - `GET /api/v1/strategy-center/unassigned`
- 手工/未知成交归属与认领：
  - `POST /api/v1/strategy-center/unassigned/{tradeId}/claim`
  - 事务写入 `position_assignment`、审计、trades 归属
- 策略 Fork / 版本：
  - `POST /api/v1/strategy-center/strategies/{id}/fork`
  - `PUT /api/v1/strategy-center/strategies/{id}/versions`
- 绑定四元组不可迁移：
  - 首次部署写入绑定
  - 不同 Agent/账户/柜台/ORS 返回 `409 STRATEGY_BOUND_TO_CONTEXT`
- 手工/未分配 book position 更新（`BookPositionService`）
- 账户汇总与差异：
  - 账户净持仓（柜台快照权威）
  - 策略净持仓 + 手工净持仓 + 未分配
  - 差异显式展示，不自动配平

### Phase 3：策略中心 UI

- 新增 `web/src/pages/StrategyCenter.tsx`，路由 `/strategy-center`
- 侧边栏新增“策略中心”，旧策略管理保留
- 策略中心页面不显示顶部柜台切换器
- 页面包含：策略列表、账户、未分配、交易簿、策略详情抽屉、账户差异、认领对话框
- 策略详情显示不可变绑定四元组、最新部署不一致告警、持仓/订单/成交/版本/部署
- 账户页显示账户、策略、手工、未分配和差异

## 自测结果

| 测试 | 结果 |
|---|---|
| `./gradlew test` | PASS |
| `web typecheck` | PASS |
| `web build` | PASS |
| 迁移执行（shadow） | PASS |
| 迁移后 orders/trades/strategy_positions 无 book | PASS（0） |
| 策略中心 overview/detail/account/unassigned API | PASS |
| VIEWER 认领 POST 403 | PASS |
| Fork 创建新策略、不继承持仓/PnL | PASS |
| 未分配成交认领、审计、trades 归属 | PASS |
| SimVenue 手工单归属：MANUAL book、strategy_id NULL、counterparty/exchange 正确 | PASS |
| SimVenue 成交进入 trades、positions、book_positions | PASS |
| 策略平仓 A=2/B=10 拒绝平 3；平 2 成功 | PASS（单元测试） |

## SimVenue 补足

- `SimVenueGateway` 转发行情时使用接收时间，避免上游 replay 的旧时间戳导致预检永远过期。
- SimVenue 测试账户补齐 `instrument_fees`，否则 ExecutionLedger 会因缺费率丢弃成交。
- 修复 `MarketDataBroadcaster`：慢 WebSocket 客户端不再阻塞 Aeron 行情消费线程。

## 最终自测（2026-11-09 14:42）

- `GET /api/v1/strategy-center/overview`：HTTP 200；策略 3、账户 4、未分配 0。
- 第二次相同 Basic Auth 请求：403ms（密码匹配缓存生效；未缓存 UserDetails，避免 Spring 擦除密码导致下个请求 401）。
- `GET /api/v1/strategy-center/accounts/SIMVENUE-001`：
  - `accountNet=2`、`manualNet=2`、`strategyNet=0`、`unassignedNet=0`、`difference=0`。
  - `au2612C920` 账户 2 手、手工簿 2 手。
- `POST /api/v1/strategy-deployments` 用 SIMVENUE ORS 部署已绑定 SIMLOCAL 的策略：HTTP 409
  `STRATEGY_BOUND_TO_CONTEXT`。
- `t030_viewer`：GET 策略中心 200，认领 POST 403。
- SimVenue 手工单 `900000000020`：FILLED；`trades` 写入；策略归属为空；manual
  `book_positions` 与 `positions` 均为 2 手；成交归属字段
  `counterparty_id=SIMVENUE`、`exchange=SHFE` 正确。
- 通过 nginx `https://101.43.54.190:8443/strategy-center`：HTML 200，API 200。
- 测试用户、临时 Fork、外部未分配测试成交已清理；审计记录保留。
- 之后执行了 V2 clean bootstrap：`strategies=0`、`orders=0`、`trades=0`、`positions=0`，只剩 4 个 MANUAL/4 个 UNASSIGNED book；V1 执行数据不迁移。
- 已确认数据库中不存在 `trg_t030_*` 兼容触发器。

## SimVenue clean E2E（2026-11-09）

先停止 `quantlink-fin-archive-replay`（它会把旧 order stream 重新回放到 SimVenue），清空 SimVenue recovery 文件后重启：

```text
orders=0 positions=0 tradesFilled=0 sequence=0
```

然后通过 V2 手工入口下单：

```text
clientOrderId=900000000021
account=SIMVENUE-001
book=MANUAL
strategy_id=NULL
counterparty=SIMVENUE
exchange=SHFE
status=FILLED
```

落库结果：

- `orders` 1 条 FILLED
- `trades` 1 条
- `positions.au2612C920` 多 1 手
- `book_positions MANUAL` 多 1 手
- 策略中心账户汇总：
  `accountNet=1, manualNet=1, strategyNet=0, difference=0`

## V2 订单与成交页

新增 `web/src/pages/OrdersV2.tsx`：

- 路由 `/orders`
- 无顶部柜台选择器
- 按账户筛选订单
- 按账户/策略筛选成交
- 显示 account/strategy/book/counterparty/exchange
- 后端 `trades/page` 增加 `accountId`、`strategyId` 过滤

## 旧页面删除（2026-11-09）

按用户确认的“不兼容旧页面，删除”执行：

- 删除 `web/src/pages/Strategies.tsx`
- 删除 `web/src/pages/ManualOrder.tsx`
- 删除 `web/src/pages/Orders.tsx`
- 删除 `web/src/pages/Monitoring.tsx`
- 删除 `web/src/pages/OptionChain.tsx`
- 删除 `web/src/hooks/useVenues.ts`
- 删除旧页面专用组件 `PairConfigDialog`、`VolSmileChart`
- 顶部柜台切换器从 `AppShell` 彻底移除
- V2 策略中心新增手工下单和新建策略入口

## SBE v2 合同

已在 `abi/sbe/quantlink-fin-sbe.xml` 增加并重新生成 Java/C++：

- `BookId`、`CounterpartyId`、`Environment`
- `MarketData.counterpartyId/exchange`
- `OrderRequest.bookId/counterpartyId/exchange/deploymentId/deploymentGeneration/orderEpoch/environment`
- `OrderUpdate.accountId/bookId/deploymentId/deploymentGeneration/counterpartyId/exchange/routeId/orderEpoch/fencingToken/environment`
- `Trade.accountId/bookId/deploymentId/deploymentGeneration/counterpartyId/exchange/routeId/orderEpoch/fencingToken/environment`
- `PositionSnapshot.exchange/counterpartyId`
- `SbeRoundTripTest` 已覆盖新增字段

## 应急范围

新增：

- `POST /api/v1/emergency/stop`
  - `scope=STRATEGY`：暂停当前策略、撤单、平仓
  - `scope=ACCOUNT`：暂停该账户策略/部署、撤单、逐策略平仓
  - `scope=ALL`：复用原 stop-all
- `POST /api/v1/emergency/flatten`
  - `scope=STRATEGY/ACCOUNT/ALL`
- `POST /api/v1/emergency/cancel-all` 支持 `strategy:<id>`
- 策略详情新增“停止并平仓”入口

## 版本更新门禁

`StrategyDeploymentController` 新增：

- 版本变化且策略仍有持仓时，默认返回
  `409 POSITION_CARRY_CONFIRMATION_REQUIRED`
- 必须显式 `carry=true` 才允许带仓更新
- 绑定四元组不一致仍返回 `409 STRATEGY_BOUND_TO_CONTEXT`

## V2 补充页面

- `OptionChainV2`：`/options`，无顶部柜台选择器，按标的/到期月查询
- `MonitoringV2`：`/monitor`，系统状态、ORS、SimVenue 健康
- `OrdersV2`：`/orders`，账户筛选订单、账户/策略筛选成交
- 策略详情：新建版本并提交部署；默认拒绝带仓更新，勾选 carry 才允许
- 账户详情：账户级“停止并平仓”应急
- 验证：`/api/v1/option-chain` 200、`/api/v1/system/status` 200、`/api/v1/trades/page?accountId=SIMVENUE-001` 200

## 版本更新操作流

策略详情“保存并部署”：

- 有持仓且未勾选 carry：先调用 `POST /api/v1/emergency/stop` 执行策略级停旧/撤单/平仓，再创建版本并提交部署
- 勾选 carry：跳过停旧/平仓，直接提交版本部署
- 跨绑定上下文仍由后端 409 拒绝
- 无持仓可直接部署

## P0 原则

`AGENTS.md` 已记录：新产品，不做兼容分支、旧 producer fallback、双写或 backfill。
契约变化时同步修改 producer、consumer、schema 和测试，删除旧路径。

## 浏览器 E2E：未分配认领

新增 `tools/e2e/t030-claim.mjs`，通过 Playwright 打开策略中心未分配页，
认领 `T030-E2E-CLAIM`：

```text
seen=1
claimed=true
```

## 浏览器 E2E

新增 `tools/e2e/t030-smoke.mjs`，通过 Playwright headless 访问
`https://101.43.54.190:8443`：

```text
strategyCenter=true
manualOrderEntry=true
venueSelectorCount=0
orders=true
options=true
monitoring=true
pageErrors=[]
```

运行：

```bash
node tools/e2e/t030-smoke.mjs
```

## 行情键隔离验证

`MarketDataService` 新增 scoped tick：

```text
(counterpartyId, exchange, instrumentId)
```

验证：

```text
POST /api/v1/market/ticks counterpartyId=SIMVENUE exchange=SHFE price=111
POST /api/v1/market/ticks counterpartyId=SIMLOCAL exchange=SHFE price=222
GET /api/v1/option-chain?...counterpartyId=SIMVENUE&exchange=SHFE -> callBid=111
GET /api/v1/option-chain?...counterpartyId=SIMLOCAL&exchange=SHFE -> callBid=222
```

全局 instrument tick 仍保留给旧 UI；策略 PnL 和期权链接口优先使用 scoped tick。

## 账户 PnL 快照

`AccountSnapshotService` 现在写入：

- `equity = balance`
- `cash = available`
- `realized`：从 `ledger_entries` 的 `REALIZED_PNL` 汇总
- `fees`：从 `ledger_entries` 的 `TRADE_FEE` 汇总
- `unrealized`：账户持仓 × 当前行情
- `deposit/withdraw` 仍为 0，缺少柜台出入金事件源

## 策略创建与可见性修复

- 策略中心 API/UI 增加 `target`/`configJson`，列表显示标的（如 `au2612`）
- 策略详情增加：
  - “标的 / 合约”卡：Pair 策略显示 `第一腿 / 第二腿`
  - “策略指标”区：指标名、合约、最新值、状态、更新时间
  - `GET /api/v1/strategy-center/strategies/{id}` 返回 `indicators` 与 `pairConfig`
- 新增 V2 引导式新建策略页 `/strategy-center/new`
  - 策略 ID 系统生成，用户只填名称
  - 4 步：基本信息 → 标的与合约 → 风险与模式 → 账户与规则
  - 创建时自动生成默认指标；Pair 策略自动写入 `strategy_pair_configs`
- 策略列表/详情增加“编辑策略”“复制策略”入口
  - 编辑只改名称/标的/双腿，不改变绑定规则/账户
  - 复制走 Fork：复制配置、版本、Pair 双腿、指标；不复制持仓/订单/成交/PnL/绑定
- 交易员展示口径：
  - 标的/双腿为主信息
  - 绑定区只显示“规则 + 账户”
  - 策略列表和详情不再显示 Agent/ORS
- 已创建 SimVenue 策略：
  - `SIMVENUE-OPT-01` → `SIMVENUE-001` / `SIMVENUE` / `ors-simvenue-001`
- 已创建 6 个指标（SIMNOW/SimVenue 各 3 个）；Pair 策略另建 3 个价差指标

### Pair 专项验收

新增 `tools/e2e/t030-pair.mjs`，结果：

```text
pairConfigSaved=true
targetShowsBothLegs=true
detailHasPairConfig=true
detailHasIndicators=true
editUpdatesLegs=true
overviewShowsRulesAndAccount=true
overviewShowsPairTarget=true
closeWithoutAttributionRejected=true
copyHasPairConfig=true
copyHasIndicators=true
copyHasNoPositions=true
copyIsUnbound=true
copyHasParent=true
```

Pair 运行时单测也重新执行：

```text
FuturesPairStrategyTest   tests=1 failures=0
PairSpreadRunnerTest      tests=9 failures=0
```

## SimNow 夜盘与 CTP 权威账户

SimNow 夜盘 ORS 已恢复，修复了行情流 1100 背压导致进程退出的问题。

账户快照新增权威字段：

```text
deposit
withdraw
```

并修正 CTP `PositionCost` 归一化：

```text
avgPrice = PositionCost / (Position * VolumeMultiple)
```

验证：

```text
au2612 avg_price 877.06 (原 877060)
ag2706 avg_price 12712
```

当前 SimNow 账户出入金为 0，说明字段链路可用但还没有非零事件。

为提高页面可见性，已创建并绑定：

```text
SIMNOW-NIGHT-OPT -> TEST-001 / SIMNOW / ors-simnow-test-001
```

策略中心页面可见该策略。

## SimVenue 最终模拟验收

2026-11-09 完成：

```text
SimVenue manual order 900000000023
status=FILLED
book=MANUAL
strategy_id=NULL
account=SIMVENUE-001
counterparty=SIMVENUE
exchange=SHFE
```

同时 SimNow 策略 `SIMNOW-NIGHT-OPT` 仍绑定在 `TEST-001`，页面可见。

## CTP C++ 构建验证（2026-11-09）

在 Linux 服务器用 CTP SDK + Aeron C++ source/lib 完整构建：

```text
CTP_HOME=/opt/finrobot/ors/third_party/ctp/linux
AERON_SRC=/tmp/qf-ctp-build/aeron-src
AERON_RUNTIME=/opt/quantlink-fin/aeron-runtime
bash tools/build_ctp_aeron.sh
```

结果：

```text
built .tools/bin/qf-ctp-aeron
```

仅有 `putInstrumentId` 的编译器 `-Wstringop-overread` 警告，二进制生成成功。

## 浏览器 E2E：版本/Fork/应急

新增 `tools/e2e/t030-lifecycle.mjs`：

```text
detail=true
version=true
emergency=true
forked=true
```

覆盖：
- 打开策略详情
- 创建并部署版本
- 策略级停止并平仓
- Fork 新策略

## 共享账户策略平仓验证

SimVenue 账户 `SIMVENUE-001` 同一合约：

```text
E2E-CLOSE-A = 2
E2E-CLOSE-B = 8
账户持仓   = 10
```

调用 A 平 5：

```text
HTTP 422 STRATEGY_POSITION_INSUFFICIENT: requested=5 closeable=2
```

调用 A 平 2：

```text
HTTP 200 CLOSE_TODAY accepted
```

说明策略平仓先受策略归属限制，不会被账户 10 手掩盖。

## 最终回归（2026-11-09）

```text
./gradlew test                          PASS
FuturesPairStrategyTest                 PASS (1/1)
PairSpreadRunnerTest                    PASS (9/9)
web typecheck                           PASS
web build                               PASS
Playwright smoke                        PASS
Playwright lifecycle (edit/copy/stop)   PASS
t030-pair API E2E                       PASS
```

页面级验收：

```text
SIMNOW-NIGHT-OPT 详情:
  标的 / 合约 = true
  策略指标 = true
  平值 IV = true
  规则 / 账户 = true
  展示 agent/ORS = false

列表:
  规则 / 账户表头 = true
  编辑/复制入口 = true
  Pair 标的 = ag2612 / au2612

Pair 详情:
  第一腿 = ag2612
  第二腿 = au2612
  价差 Z-Score 指标 = true
```

## 指标与 PnL 数据闭环（2026-11-09）

### 指标

`IndicatorEngine` 已改为：

```text
行情线程 -> 有界队列 offer -> 单线程 worker
  -> 按 indicator_defs 动态计算
  -> 写 indicator_values（约 900ms 节流）
  -> WebSocket 推送
```

实测：

```text
indicator_defs        16
indicator_values      479+
全局指标              Delta/Vega/IV/IV Rank/RR25/Spread
策略指标              SIMNOW/SIMVENUE 各 3 个
Pair 指标             Spread/ZScore/HedgeLatency
状态                  OK
驾驶舱“无数据”         false
```

### 策略 PnL

新增 `strategy_pnl_snapshot`，后台每秒计算、每 5 秒落库，并通过
`type=strategy_pnl` WebSocket 消息推送：

```text
PAIR-SIMVENUE-MW9C01BR  pnl=-335.00
SIMNOW-NIGHT-OPT        pnl=0.00（策略无归属）
SIMVENUE-OPT-01         pnl=0.00（策略无归属）
```

策略详情同时显示账户权威 PnL（`account_pnl_snapshot` 的 equity/cash/
deposit/withdraw/unrealized/as_of），避免把“策略无归属”误判为数据未采集。

### Pair 真实双腿 E2E

SimVenue 账户 `SIMVENUE-001`，策略 `PAIR-SIMVENUE-MW9C01BR`：

```text
900000000024  ag2612 B OPEN   FILLED 1  @11800
900000000025  au2612 S OPEN   FILLED 1  @873.62
900000000026  ag2612 S CLOSE  FILLED 1
900000000027  au2612 B CLOSE  CANCELED 0（未成交，已撤）
900000000028  au2612 B CLOSE  FILLED 1  @900（可成交价）
```

结果：

```text
strategy_positions ag2612=0 au2612=0
trades=4
strategy PnL=-335.00
account positions 增加/回退一致
```

### SimNow 定时查询状态

- 账户信息：CTP adapter 每 30 秒查询，`account_pnl_snapshot` 持续更新（实测 105 行，最新 22:29）。
- 费率/保证金：**未在跑**。`quantlink-fin-fee-refresh.service` 于 15:40 失败，
  `fee_refresh` 在 `./ctp_flow/fee_refresh/` 打不开 CFlow 后段错误：
  - `instrument_fees` 最新 14:05
  - `instrument_margins` 最新 2026-11-08 23:34
- 根因：systemd 未设置 `WorkingDirectory`，脚本从 `/` 启动，CTP flow 相对路径不存在。
- 修复：费率/保证金查询工具已收回本仓库
  （`ctp-adapter/src/fee_refresh_main.cpp`、`tools/build_ctp_fee.sh`），
  systemd 只使用 `/opt/quantlink-fin/bin/qf-fee-refresh` 和
  `/opt/quantlink-fin/ctp_flow/fee_refresh`，不依赖外部目录。
  timer 已调整为工作日 15:05（`NextElapse=2026-11-11 15:05:00 CST`），scheduler 的
  `fee_refresh` 只读记录同一时间。11-10 的 15:40/15:56 是旧 timer/手工执行，
  服务仍失败；CTP ORS 当前 HALTED，需在可用 CTP 会话窗口复验。
- 仍待验收：修复后的 fee/margin 刷新必须产生新的 `updated_at`，且费率/保证金不为空。

### SimNow 出入金

最新 `account_pnl_snapshot`：

```text
account=TEST-001
equity=22672249.04
cash=18986725.84
deposit=0
withdraw=0
unrealized=39200.00
source=COUNTER
as_of=2026-11-09 22:19:17
```

结论：CTP `TradingAccount.Deposit/Withdraw` 字段链路已通，当前 SimNow
账户当日没有出入金事件，因此为 0；这不是“没有取数”。若需要非零验收，
必须触发一笔 SimNow 入金/出金，或补 `PreBalance`/银行流水字段。

## 运行面实时链路（2026-11-09 夜盘）

### Agent 策略 PnL

新增 SBE：

```text
StrategyPnl id=25
StrategyPosition id=26
stream 2010 / 2011
```

RuntimeRunner 已发布，control-plane 只消费缓存，不再请求时重算：

```json
{
  "source": "AGENT",
  "asOf": "2026-11-09T15:05:14.730Z",
  "pnl": 0.0,
  "markSource": "SCOPED_TICK"
}
```

WS 实测收到 `strategy_pnl` 帧。

### 账户/持仓 WS

CTP Adapter 的 `AccountSnapshot`/`PositionSnapshot` 消费后广播：

```text
account_snapshot
account_position
```

10 秒实测：

```text
tick=6606
indicator=164
account_snapshot=1
account_position=2
strategy=4
```

Dashboard 已删除 2 秒 `/portfolio/live` 轮询；8 秒内仅首屏请求 1 次：

```text
portfolioRequests=1
```

### WS 会话修复

`MarketDataBroadcaster` 原来在一次异步发送失败时直接移除 session，导致只收到 1~2 帧就断流。
现在：

- 按 session 串行化发送
- 发送失败不驱逐会话
- 只有 session 真正关闭才移除

修复后 tick 从 1~2 个/10 秒恢复到 6606 个/10 秒。

### 期权 IV

CTP Adapter 已订阅：

```text
au2612C900 / au2612C920 / au2612P900 / au2612P920
```

期权 tick 新鲜，ATM IV 取真实期权链最近报价：

```text
iv_atm_au=75.8%（实际期权 tick 计算）
```

无历史分位/25Δ 报价时：

```text
iv_rank_au=NO_HISTORY
rr25_au=NO_QUOTE
```

不伪造 50 / 1.8。

### P0-09 管理面轮询/组合计算清理

- 删除 `PortfolioController` 与 `PortfolioMapper`
- `/api/v1/portfolio/live` 返回 404
- Dashboard 不再请求该接口：实测 8 秒内 `portfolioRequests=0`
- Dashboard 使用 `account_snapshot` / `account_position` / `indicator` / `strategy_pnl` WS
- 策略详情 PnL 只读 `StrategyRuntimeCache`；无 Agent 数据返回 `NO_AGENT_DATA`
- 策略详情持仓只读 Agent `strategy_position` 缓存

## 当前未完成 / 真实阻塞

- T-030 原始 41 项：当前初判 29 项闭环，12 项部分/未闭环（见
  `docs/tasks/T-030-progress.md`）。
- 策略详情仍缺 PnL、风险、对账、日志 Tab。
- 手工簿没有独立详情/应急动作。
- “编辑策略”未生成草稿版本；部署 drain/审批/回滚未完整演练。
- 驾驶舱组合层仍每 2 秒轮询 `/portfolio/live`；T-018 图表/数据龄未完整验收。
- SimNow 非零 `deposit/withdraw` 事件尚未出现；`preBalance`/资金流水未展示。
- 完整 TC 执行、性能/Chaos、交易员最终验收未完成。

# 交易员独立审查：quantlink-fin（2026-11-08）

- 审查身份：期货/期权交易员（SHFE au/ag，做市 + 方向 + 价差 + 手工应急）
- 审查对象：当前工作树（含未提交改动），重点为对账事故修复、告警确认、手工单、撤单/应急、策略操作、账务与交易日历
- 输入文档：`docs/reviews/trader-review-2026-11-06.md`、`docs/reviews/remediation-plan-2026-11-08.md`、`docs/reviews/remediation-execution-2026-11-08.md`、`docs/incidents/2026-11-08-reconciliation-gate-false-positive.md`、`docs/runbooks/next-trading-day-validation.md`
- 审查方式：只读代码 + 文档比对 + 场景推演；未改任何生产代码
- 结论：**这轮修复把“对账误拦”的技术方向修对了，但“交易员能不能安全地用”还没有过关。仍有 7 个 P0 级“以为生效、实际没生效/反着生效”的问题。**

---

## 0. 结论先行

### 0.1 一句话结论

```text
现在的系统比 11-06 可信，但还不是“可以交给交易员盯盘并动手”的系统。
最危险的不是缺功能，而是几个动作的实际后果和页面写的不一样：
停止策略会先平仓、全撤会跳过最该撤的单、只减仓不拦开仓单、
保证金和权益是估算值、期权 Greeks 是固定 18% IV 算出来的。
```

### 0.2 按本次审查重点的验收结论

| # | 审查重点 | 结论 | 主要依据 |
|---|---|---|---|
| 1 | “策略已触发”横幅：确认、激活、失败、重复、消失 | **部分改善，未达标** | 确认后横幅在“当天已有历史告警”的场景下不会消失；页面打开后新告警不会出现；手动激活一键执行且顺手 ack 全部提醒 |
| 2 | 手工单：最新价、偏离、两段、TIF/只减仓、校验、回执 | **方向正确，有 2 个 P0 缺口** | 保证金=名义×10%；“只减仓”开关不进入订单；确认按钮可重复点击；服务端不校验价格偏离/涨跌停/交易时段 |
| 3 | 撤单与应急：单笔/批量/全撤、drain、stop-all、只减仓、断线、部分成交 | **“全撤”存在假动作** | 全撤 SQL 不包含 `CANCEL_FAILED`/`ACK_TIMEOUT`/`SENT`；只减仓不撤开仓挂单；无 UI 一键平仓；drain 在无买价时发 1 tick 假单 |
| 4 | 对账事故：PAIR 是否连坐、告警定位、CLOSE/CANCEL 是否允许 | **策略级已修，入口级与场所级仍未修** | 本地策略 scope 已生效；但 venue 级仍全局连坐；手工单和 `StrategyOrderService` 完全不走对账 Gate |
| 5 | 账务：手续费、保证金、已实现/未实现、结算、可用 | **交易员无法在页面上核对** | 保证金按 10% 估算；账户余额/可用/保证金可手工改；无结算/持仓 today-yesterday/逐笔手续费页面；Dashboard 可用资金重复扣减保证金 |
| 6 | 策略操作：激活/停止/部署/回滚/审批 | **“停止/激活”的真实后果与提示不符** | 停止/激活/回滚/重新部署都会 bump generation → agent reload → SIGTERM → drain → **可能先平仓**；页面只说“不再产生新订单” |
| 7 | 交易日历/两腿时段/夜盘/收盘 closeout | **PAIR 两腿交集正确；夜盘归属有 1 个实盘级错误** | 周五夜盘跨到周六 00:00–02:30 会被 `todayTradingDay=false` 拒绝开仓 |
| 8 | 交易员日常工作流：搜索、排序、批量、导出、通知、复盘 | **仍缺一半** | 订单无搜索/排序/批量/策略来源筛选、无自动刷新；告警无 severity/策略筛选；无盘后复盘/对账单 |

### 0.3 证据口径（请务必区分）

| 标记 | 含义 |
|---|---|
| `CODE` | 已通过阅读当前代码确认；本地代码行为正确/错误 |
| `SIM` | 需要 SimLocal 交易日实测才能确认；当前只能推演 |
| `CTP` | 需要真实 CTP 交易日实测；当前完全未验证 |

> 本文所有“代码确认”只代表本地逻辑；不代表 SimLocal 撮合、CTP 柜台、交易所接受了这个行为。
> 当前不是交易日，`todayTradingDay=false`，任何“下单成功/撤单成功”的结论都还没有真实交易日证据。

### 0.4 如果只先改三件

1. **把“停止策略”和“平仓”拆成两个动作，并在 UI 说清楚后果**（TRD-P0-01）。这是最直接“点错一次就改变持仓”的问题。
2. **让“全撤”覆盖 `CANCEL_FAILED/ACK_TIMEOUT/SENT`，并以交易所终态为准**（TRD-P0-02）。这是最典型的“越急越撤不掉”的问题。
3. **把保证金/权益/可用切到权威数据，去掉 10% 估算、手改余额、默认 100 万**（TRD-P0-04）。这是最根本的“交易员看到的本金是假的”的问题。

其余 P0（对账入口覆盖、Dashboard 固定 IV、横幅数据源、手工单幂等）同样要修，但可以先用人工作业规避；上面三件无法靠“小心一点”规避。

---

## 1. P0 问题表

> P0 定义：会导致错单、漏撤、裸腿、超限、基于假数据决策，或让交易员对“已经做了什么”产生根本误解。
> 上模拟盘/小资金试点前必须解决，或有明确的人工 break-glass 流程。

| ID | 范围/验证 | 交易场景 | 证据 | 交易风险 | 建议 | 验收方式 |
|---|---|---|---|---|---|---|
| **TRD-P0-01** | 策略操作 / `CODE`+`SIM` | **点“停止自动交易”，系统会先把仓位平掉；而顶栏“停全部”又不会——同样叫停止，行为不一致。** 单策略 `deactivate` 会 bump generation → agent reload → SIGTERM → runner drain（撤单→市价平仓→确认 flat）→ 再以 INACTIVE 启动。**“激活”同样会 bump generation；如果进程正在 INACTIVE 且还有仓位，激活会先平掉旧仓再开始新仓。**PAIR 两条腿都会用 FAK 打对手价；流动性差时一条腿不成交，180 秒后 agent 强杀，留下裸腿。页面只写“不再产生新订单；已有订单不会自动撤销”，完全没提平仓。 | `backend/runtime-agent/.../HeartbeatClient.java` `superviseStrategies()` 把 `INACTIVE` 也视为 shouldRun；`ProcessManager.reload()` = `stop()`+`start()`；`ProcessManager.stop()` 用 SIGTERM 并注明“starts the runner's local drain (cancel -> flatten -> flat confirmation)”；`PairSpreadRunner.drainOnShutdown()`、`RuntimeRunnerMain` shutdown hook 都会 flatten。单策略 `deactivate` 的 SQL 有 `generation = generation + 1`；顶栏 stop-all 的 `pauseActiveDeployments` **不 bump generation**，所以不 reload、不平仓。UI 文案：`web/src/pages/StrategyView.tsx:1055-1059`、`web/src/pages/Strategies.tsx:856-860`。 | 这是**交易决策级**的语义错误。停策略≠平仓；停策略和平仓必须是两个动作。交易员想“先停报价、保留仓位手动处理”，实际整组价差被市价平掉；PAIR 还可能只平掉一条腿。更糟的是：顶栏“停全部”保留仓位，单策略“停止”平仓，交易员无法从按钮文字判断后果。 | 拆成两个动作：①“停止报价（保留仓位）”：desired=INACTIVE，但不 bump generation、不 reload、不 drain；②“停止并平仓”：明确二次确认+输入策略 ID+逐腿回执。若必须 reload，UI 必须先显示“将平掉 N 手，预计滑点 X”。统一单策略与 stop-all 的语义。 | SimLocal 持仓 2 腿 → 分别点单策略“停止自动交易”和顶栏“停全部” → 记录停止前后 `positions`；两者行为必须一致且与文案一致；再点“停止并平仓”验证逐腿回执。CTP 交易日同样验证。 |
| **TRD-P0-02** | 撤单/应急 / `CODE` | **“全撤”会跳过最危险的订单。** `CANCEL_FAILED`、`ACK_TIMEOUT`、`SENT` 这三种状态恰恰是“撤单没成功/委托状态不明”的单，但全撤 SQL 只取 `NEW/OPEN/PARTIAL/CANCEL_REQUESTED`。如果当时只剩这类单，交易员按“全撤”，页面显示“全撤：0 笔，已发 0，失败 0”，以为干净了，实际交易所还挂着单。 | `backend/control-plane/src/main/resources/mapper/EmergencyMapper.xml:30-48`，全撤状态列表不含 `CANCEL_FAILED/ACK_TIMEOUT/SENT`；`EmergencyController.cancelAll()` 仅按该列表遍历；`OrderLifecycleGuard` 会把 30 秒无 ack 的手工单改成 `ACK_TIMEOUT`。 | 这是 11-06 评审里“假全撤”问题的残留变种：不是不改库，而是**根本不去撤那些失败的单**。一次撤单失败后，交易员越急越会点全撤，越点越撤不掉。 | 全撤必须覆盖所有“可能还在交易所”的状态：`NEW/OPEN/PARTIAL/SENT/CANCEL_REQUESTED/CANCEL_FAILED/ACK_TIMEOUT`；逐单回执 + 失败重试 + 最终 `CANCELED` 才消失；UI 显示“仍未确认”数量。 | 制造一次撤单失败（停 Aeron/断网）使订单变 `CANCEL_FAILED`，再点全撤：该单必须出现在回执里并被重试；`ACK_TIMEOUT` 单同理。验收以交易所最终状态为准，不以本地状态为准。 |
| **TRD-P0-03** | 对账 Gate / `CODE` | **对账 Gate 只拦“策略直连 Aeron”这一条路。** 交易员手工开仓、或策略走 HTTP 下单，对账失败时仍可开新仓，且页面没有任何提示。反过来，venue 级对账仍是全局的：CTP 账户有一张挂单，或 SimLocal 快照文件缺失，PAIR 的 ag 也会被一起拒绝。 | `AeronOrderGateway.ensureRisk()` 是唯一检查 `reconciliationPass` 的地方；`TradingController.validateOrder()` 没有对账检查；`StrategyOrderService.submit()` 没有对账检查；`StrategyRuntimeController.risk()` 的 `reconciliationPass = (NOT gate) OR (localPass AND venue.passed())`（第 104 行）；`SimLocalVenueReconciler.check()` 用 `mapper.listOrders()` 取**全部账户**订单，不按 account 过滤（第 56-64 行）。 | 对账事故的根因是“一个账户的问题连坐所有策略”。策略级修了，venue 级没修；同时 Gate 没有覆盖所有下单入口，等于“有门的地方上锁，没门的地方敞开”。交易员会在对账失败时手工把仓位加上去，事后无法解释。 | ①venue 对账按 account/venue scope，账户 A 不影响账户 B；②`SimLocalVenueReconciler` 先按 `account_id` 过滤，再对比；③手工单/HTTP 策略单统一走同一个 Gate，或显式标记 `BREAK_GLASS` 并二次确认+审计；④快照缺失只阻断对应 venue，不阻断全部。 | ①SimLocal 期权策略制造不一致，PAIR ag 开仓必须通过；②PAIR 自身不一致，OPEN 必须被拒、CLOSE 必须通过；③CTP 账户挂一张单，PAIR 不应被拒；④手工 OPEN 在对账失败时必须被拒或明确 break-glass。 |
| **TRD-P0-04** | 账务/资金 / `CODE`+`CTP` | **保证金和可用资金是估算值，不是账户事实。** 手工单预检用 `名义金额×10%`；Dashboard 用 `abs(净持仓)×最新价×乘数×10%`；`accounts.balance/available/margin` 还能在页面上手工改；Dashboard 的可用资金又在“已扣保证金”的 `available` 上再减一次总保证金；没有任何活跃账户时 `COALESCE(..., 1000000)` 直接显示 100 万。 | `TradingController.validateOrder()`：`double margin = notional * 0.10;`；`PortfolioController.live()`：`totalMargin += Math.abs(net) * last * multiplier * 0.10;`，`available = Math.max(0, accountAvailable - totalMargin)`；`PortfolioMapper.xml` `accountSummary` 对所有 active TRADING 账户求和且 `COALESCE(SUM(balance), 1000000)`；`AccountConfigController.upsert()` 接受 `balance/available/margin`；`AeronOrderMapper.updateAccountMargin()` 只在日结算时写 `available = balance - margin`。 | 交易员会看到“可用 80 万”去做 100 万的仓；期权卖方保证金被低估一个数量级；账户余额可以被人为改成任何数。而且 Dashboard 把所有 active TRADING 账户加在一起，顶栏却只显示一个场所账户，交易员不知道这 100 万属于谁。试点时最直接的后果是超限/强平，而不是策略亏钱。 | ①保证金唯一来源 `instrument_margins`（期货按多空比例，期权按 CTP 公式/组合口径）；②`accounts` 对 CTP 账户只读，由柜台查询/结算写入；③Dashboard 可用资金不要二次扣减；④无账户时必须显示“无数据”而不是 100 万；⑤手工单预检显示“保证金来源 + 计算式”。 | 交易日 09:00：页面权益/可用/保证金 vs CTP 终端逐项比对，差异必须为 0；把 `accounts` 改成只读后手工单预检仍能算出正确保证金；删除全部账户时 Dashboard 必须报错而非显示 100 万。 |
| **TRD-P0-05** | 驾驶舱/期权 / `CODE` | **Dashboard 的期权 Greeks 是固定 18% IV 算出来的。** 没有期权行情时，还直接用 18% IV 的理论价当“最新价”算浮动 PnL。交易员看到的 Delta/Gamma/Vega/Theta 和期权浮盈不是市场值。 | `backend/control-plane/.../portfolio/PortfolioController.java`：`double iv = 0.18;`；`if (tick == null OR tick.lastPrice() <= 0) { last = OptionPricing.price(forward, strike, years, 0.02, iv, call); }`；Greeks 用同一固定 IV。 | 对期权做市/卖方，Greeks 就是方向盘。18% IV 与真实 35% IV 的 Vega/Gamma 差一倍以上；用理论价冒充最新价会让“浮盈”看起来很好，平仓时对不上。 | 有市场 IV 用市场 IV；没有就显示 `N/A`/`STALE`，禁止用固定 IV 生成 Greeks；没有期权 tick 时 PnL 显示 `—` 并说明“无行情”，不得用理论价。组合 Greeks 必须标注 IV 来源与数据龄。 | 选一个 IV 明显偏离 18% 的期权合约，页面 Greeks 必须与期权链/柜台一致；拔掉该合约行情，PnL/Greeks 必须变 `—`，不得出现理论价。 |
| **TRD-P0-06** | 策略横幅 / `CODE` | **“策略已触发”横幅可能不出现，也可能永远不消失。** 页面优先使用打开时加载一次的 `historyAlerts`；只要当天该策略已有一条历史告警，后续新告警不会进入横幅；点“确认提醒”后，`ack` 只刷新 5 秒轮询的 `alerts`，不刷新 `historyAlerts`，横幅仍按旧的 `NEW` 渲染，点了也不消失。交易员会以为“没触发”或“系统坏了”，实际是页面数据源冻结。 | `web/src/pages/StrategyView.tsx:610-613`：`const selectedAlerts = historyAlerts.length > 0 ? historyAlerts : alerts.filter(...)`；`loadHistory()` 只在 `selected` 变化和 `activateTriggered()` 后调用（第 592-605、629-648 行）；`ackTriggered()`（第 616-627 行）只调 `ack()`，不调 `loadHistory()`；`historyAlerts` 是快照，ack 后仍是 `NEW`。 | ①策略在盘中新触发，页面不响，交易员错过；②确认后不消失，交易员反复点，最后干脆不看；③“手动激活”会顺手 ack 所有提醒（第 638-640 行），把“触发过”这件事也一起抹掉。 | 单一数据源：横幅只从 `alerts`（5 秒轮询/WS）派生，按 `strategy_id` 过滤；ack 后本地立即移除并 reload；`historyAlerts` 只用于“今日已触发 N 条”历史展示，不参与未确认判断；手动激活不得自动 ack。 | 场景 A：打开页面时该策略已有 1 条告警 → 再制造 1 条新告警 → 5 秒内横幅必须更新到新告警；场景 B：点确认 → 横幅必须立即消失且刷新后仍消失；场景 C：点手动激活 → 未确认数不得自动清零。 |
| **TRD-P0-07** | 手工单 / `CODE` | **确认下单按钮可以连点，产生重复订单。** 二次确认弹窗的“确认下单”只按输入合约代码启用，`submit()` 的 `busy` 没有禁用该按钮；服务端也没有幂等键（每次请求生成新 UUID），双击/超时重试就是两单。 | `web/src/pages/ManualOrder.tsx:364-369`：`disabled={confirmText !== instrumentId}`，没有 `busy`；`submit()` 设置 `busy` 但按钮未使用；`TradingController.manualOrder()` 每次 `mapper.nextClientOrderId()` 新 ID，`requestId` 每次新 UUID，无重复检测。 | 乌龙指一次就够亏一个月；在波动大的 au/ag 上，双击两下手数直接翻倍。 | 前端：提交中禁用按钮并显示“已提交，等待回执”；服务端：`Idempotency-Key`/`requestId` 唯一约束，重复请求返回同一 `clientOrderId`；超时后先查单再决定是否重发。 | 双击确认按钮：DB 只能有 1 条订单；用同一 `Idempotency-Key` 重放请求：返回同一订单且不重复发 Aeron。 |

---

## 2. P1 问题表

> P1 定义：显著增加误操作/漏处理概率，或让交易员无法完成每天必须做的核对与处置。试点期内必须解决。

| ID | 范围/验证 | 交易场景 | 证据 | 交易风险 | 建议 | 验收方式 |
|---|---|---|---|---|---|---|
| **TRD-P1-01** | 策略横幅 / `CODE` | “手动激活”一键执行，没有二次确认，也不说明激活后会怎样：会不会先平仓（activate 也 bump generation → reload → drain）、从当前价差重新入场、限额/账户/版本是否变化。激活成功后还会把该策略所有未确认提醒一起 ack，等于“一按键既开仓又清告警”。 | `StrategyView.tsx:629-648`：直接 `POST /strategy-deployments/{id}/activate`，成功后循环 ack 所有 `NEW`；第 726-731 行按钮无确认弹窗；`StrategyDeploymentMapper.activate` 会 `generation = generation + 1`。 | 交易员在紧张时点错一次，策略立刻开始发单；如果已有仓位，还可能先被平掉；告警被清掉后无法复盘“当时为什么触发”。 | 手动激活必须弹确认：策略/版本/generation/账户/限额/当前持仓/“是否会先平仓”/“将从哪一腿开始报价”；确认后只激活，不 ack；ack 单独动作。 | 点手动激活：先出现确认框；取消后无任何状态变化；确认后提醒仍在，需单独确认；已有仓位时不得静默平仓。 |
| **TRD-P1-02** | 撤单 / `CODE` | 撤单只代表“撤单请求已发布”，不代表交易所已撤。`CANCEL_REQUESTED` 没有超时兜底；`ACK_TIMEOUT`、`CANCEL_REQUESTED` 在订单页没有撤单按钮；订单页不自动刷新，交易员看到的可能是几分钟前的状态。另外 `routeInfo` 在找不到 running route 时会回退到 `legacy` stream，可能把撤单发到别的通道并返回 `published=true`。 | `StrategyOrderController.cancel()` 只要 Aeron publish 成功就写 `CANCEL_REQUESTED`；`Orders.tsx:232-233` `canCancel` 只含 `NEW/OPEN/PARTIAL/SENT/CANCEL_FAILED`；`Orders.tsx` 无 `setInterval`；`OrderLifecycleGuard` 只把 `NEW` 手工单改 `ACK_TIMEOUT`，没有把 `CANCEL_REQUESTED` 超时改 `CANCEL_FAILED`；`ManualOrderPublisher.routeInfo()` 无 route 时返回 `legacy/legacy`。 | 交易员点了撤单，看到 `CANCEL_REQUESTED`，以为撤了；实际交易所拒撤/已成交，或撤单发到了错误的 stream，仓位继续变化。 | 撤单状态机：`CANCEL_REQUESTED → CANCELED`（收到 OrderUpdate）或 `CANCEL_FAILED`（超时/拒撤）；所有“可能还活着”的状态都可再次撤；订单页 1s 自动刷新并显示状态年龄；无 running route 时必须拒绝撤单，不得回退 legacy。 | 撤一张已成交的单：必须显示 `CANCEL_FAILED` 并给出原因；撤一张正常挂单：必须等到 `CANCELED` 才消失；订单页 1 秒内反映成交；停掉 ORS 后撤单必须失败而不是 `CANCEL_REQUESTED`。 |
| **TRD-P1-03** | 只减仓 / `CODE` | 开启“只减仓”只改一个全局状态，不撤已挂的开仓单。开仓单继续成交，仓位继续增加，交易员以为已经“只减仓”。另外页面文案写“只减仓模式禁止买入开仓，只允许平仓/卖出”，实际后端对买卖两侧的 OPEN 都拦，文案与行为不一致。 | `EmergencyController.reduceOnly()` 只 `upsertState("reduce_only")`；`AeronOrderGateway.ensureRisk()` 对 `opening` 才检查 `reduceOnly`；`AppShell.tsx:434` 文案写“禁止买入开仓”。 | 风控切到只减仓后，已有买单仍成交，越减越亏；文案还会让交易员以为卖出开仓是允许的。 | 开启只减仓时：①撤掉所有 OPEN 方向挂单（逐单回执）；②禁止一切 OPEN；③文案改为“禁止所有开仓（买/卖）”；④提供 account/instrument 范围。 | 挂 2 张买入开仓单 → 开启只减仓 → 两张单必须被撤；再手工下买入开仓/卖出开仓都必须被拒；恢复后正常。 |
| **TRD-P1-04** | 应急/drain / `CODE`+`SIM` | 没有 UI “一键平仓”。`stop-all` 只暂停+撤单，不平仓；要平仓得逐个策略调 `flatten-strategy`。`stop-all` 的 `instancesRequested` 只是往 `runtime_instances` 写 `STOP_REQUESTED`，agent 不读这个表，进程不会停，UI 的“等待 runtime-agent 确认”不会有下文。PAIR drain 时如果买价/卖价为 0，`alignPrice(0, SELL, tick)` 会返回 1 tick，发一张永远不会成交的“假平仓单”，然后 120 秒超时；generic runner 的 drain 依赖 `lastTicks`，没行情就无法平仓。 | `EmergencyController.stopAll()` 明确写 `call flatten-strategy for closeout`；`EmergencyMapper.requestStopActiveInstances` 只更新 `runtime_instances.status='STOP_REQUESTED'`，agent 无引用；`AppShell.tsx` 只有全撤/停全部/只减仓；`PairSpreadRunner.drainStep()` → `flatten()` 未检查 `tick.bidPrice()>0`，`alignPrice` 在 0 价时返回 `tick`；`RuntimeRunnerMain.drain()` 用 `lastTicks`。 | 盘中出事时没时间点五个页面；以为 stop-all 已经清仓/停进程，实际策略只是 INACTIVE、进程还在、仓位还在；0 价时发出的 1 tick 单会让交易员误以为“已经挂了平仓单”。 | 增加“全部平仓/按策略平仓”按钮，逐腿回执+未平数量；drain 时 bid/ask 为 0 必须跳过并告警，不得发假价；drain 完成条件必须是“场所持仓=0”，不是“本地持仓=0”；stop-all 要么真的停进程，要么把文案改成“暂停+撤单，不平仓/不停进程”。 | 拔掉一条腿行情 → 全平：必须显示 `SKIPPED_NO_PRICE` 并告警，不得发 1 tick 单；恢复行情后能继续平；stop-all 后 `positions` 必须为 0 或明确列出未平；进程状态必须与文案一致。 |
| **TRD-P1-05** | PAIR 风控 / `CODE`+`SIM` | PAIR 的“价差持仓”只取两腿的较小值；残余单腿不显示、也可能不收敛。比如腿1=3、腿2=-2，`pairPosition=2`；平掉 2 手后腿1=1、腿2=0，`pairPosition=0`；如果 `hedgeThres>1` 或对冲 FAK 失败，腿1 会一直裸着，页面显示“价差持仓 0”。drain 才会平它。 | `PairSpreadRunner.pairPosition()` 第 853-857 行；`tick()` 第 506-508、616-621、627-645、647-655 行；对冲条件要求 `leg1Net != 0` 且 `abs(hedgeDr) >= hedgeThres`；平仓只按 `pairPosition` 数量。 | 交易员以为价差已平，实际单腿敞口过夜；第二天跳空直接打在裸腿上。 | 页面同时显示 `leg1Net/leg2Net/pairPosition/unpairedQty`；只要 `leg1Net+hedgeSizeRatio*leg2Net != 0` 就显示“未对冲”；runner 对残余腿无条件收敛或进入 `DEGRADED` 并停新单+告警。 | 制造腿1=3/腿2=-2 → 页面必须显示 unpaired=1；平 2 手后 runner 必须自动对冲/平掉残余 1 手，或告警并停止报价；不得静默。 |
| **TRD-P1-06** | 交易日历 / `CODE`+`CTP` | **周五夜盘跨零点后禁止开仓。** 系统用 `LocalDate.now()` 判断 `todayTradingDay`；周六 00:00–02:30 属于周五夜盘（归属下一交易日周一），但 `today=Saturday` 不是交易日 → `tradingDay=false` → `ensureRisk` 拒绝所有 OPEN。节前夜盘同理。 | `TradingCalendarService.status()` 只用 `days.contains(today)`；`AeronOrderGateway.ensureRisk()` 对 `Boolean.FALSE.equals(risk.get("tradingDay"))` 直接拒绝 OPEN；`nightSessionOk` 只是 UI 展示，未参与归属计算。 | 周五夜盘最后 2.5 小时无法建仓/对冲；有夜盘策略时等于每周少半天。 | 引入“交易日归属”：夜盘 21:00–次日 02:30 归属下一交易日；`tradingDay` 按“当前所属交易日”判断，不按自然日；`nextTradingDay`/`nightSessionOk` 同步。 | 模拟周五 23:59 → 周六 00:30：OPEN 必须允许到 02:27 closeout；周六 09:00 必须禁止；节前夜盘按交易所公告。 |
| **TRD-P1-07** | 告警 / `CODE` | ①“静默 30m”对持续重复的告警基本无效：`create()` 先判断 `latest.status == NEW` 并直接返回 duplicate，根本走不到 `silenced_until` 分支。②去重键是 `(strategy, instrument, side)`，ack 后 30 分钟内**不同原因**的新告警也会被静默。 | `StrategyAlertController.create()` 第 95-118 行：先 `NEW` 短路，再查 `silenced_until`；`findLatest(strategyId, instrumentId, side)` 不含 `reason`；`ackedWithin30Minutes()` 也不看 reason。 | 交易员点了静默，告警还在；或者真正的“对账失败”被 30 分钟前 ack 的“价差触发”静默掉，盘中漏掉事故。 | 静默应写“规则/原因”维度并在 create 时优先判断；去重键加入 `reason` 或 `reason_code`；静默/去重都要有到期时间和恢复事件。 | 对同一策略/合约/方向制造两种不同 reason：第二种必须产生新告警；对同一 reason 点静默后 30 分钟内不再产生新行，30 分钟后恢复。 |
| **TRD-P1-08** | 账务页面 / `CODE`+`CTP` | 交易员没有地方核对：逐笔手续费、逐合约保证金、today/yesterday 持仓、已实现/未实现拆分、结算历史、账户权益。`StrategyView` 的“已实现盈亏”= 成交流水重算的毛利 − 手续费，而 ledger 的已实现盈亏是毛利，两个数口径不同；`SettlementService` 用 `abs(net)` 算保证金，锁仓（多空同存）保证金会算成 0；期权保证金用单腿比例字段，未实现 CTP 的期权/组合保证金公式（口径是否一致未验证）。 | `StrategyViewController.stats()`：`realizedPnl = realized - fees`；`ExecutionLedgerService.realizedPnl()` 是毛利；`SettlementService.marginFor()` 用 `Math.abs(net)`；`PortfolioController` 无手续费/已实现字段；前端无 `/settlements` 路由。 | 交易员无法回答“今天到底赚了多少、手续费多少、还差多少保证金”；锁仓和期权卖方的保证金被低估，容易超限。 | 增加“账务/结算”页：账户权益、可用、占用、维持保证金、强平距离、当日已实现/未实现/手续费、逐合约 today/yesterday/avg、逐笔手续费、结算历史、导出；统一“已实现盈亏”口径（建议页面显示“毛利/净额”两列）。 | 交易日收盘后：页面数字与 CTP 结算单逐项对齐；锁仓 1 多 1 空，保证金不得为 0；期权卖方保证金与 CTP 一致；导出 CSV 能被财务直接使用。 |
| **TRD-P1-09** | 手工单校验 / `CODE` | 服务端只校验 tick/lot/数量/合约/账户/开平/可用资金，**不校验价格偏离、涨跌停、交易时段**。前端只在偏离 >0.5% 时给黄色提示，不拦；价格来自 2 秒 HTTP 轮询，行情快时交易员看到的是旧价。 | `TradingController.validateOrder()` 无价格偏离/涨跌停/`sessionOpen` 检查；`ManualOrder.tsx` 的 `priceDeviation` 只渲染 `<Alert severity="warning">`；第 108-115 行 `loadTicks` 每 2 秒轮询。 | 乌龙指：把 900 输成 9000，服务端照发；非交易时段的手工单到交易所才被拒，交易员以为已经下单；用旧价挂单，成交在不利位置。 | 服务端加价格笼子（如 ±2% 或涨跌停）、交易时段、合约到期/交割月检查；前端改用 WS 行情并显示 `age`，age>1s 冻结报价类操作；偏离超阈值必须二次确认+输入价格。 | 输入 10 倍价格：服务端必须拒绝并给出“偏离/涨跌停”原因；午休/收盘后手工开仓必须被拒；行情断开时下单按钮必须禁用。 |
| **TRD-P1-10** | 策略操作/审计 / `CODE` | 部署、激活、停止、回滚这些动作**没有写 `audit_log`**。`activate`/`deactivate` 只更新 deployment 的 `requested_by` 和 generation；回滚还绕过 `ApprovalGuard`。UI 回滚是一键，没有二次确认，也没有 diff；部署/回滚没有 busy 状态，连点会重复 bump generation；回滚后状态是 INACTIVE，交易员可能以为已经回到上一版并继续跑。 | `StrategyDeploymentController` 没有 `AuditMapper`；`activate()` 只 `mapper.activate` + `markStrategyActive`；`rollback()` 不调 `approvalGuard.require`；`Strategies.tsx:400-423` 部署、`482-491` 回滚均无 busy；`StrategyDeploymentController.create()` 的 `mode` 参数完全未使用。 | 事后无法回答“谁在 09:31 把策略停了/激活了”；LIVE 环境回滚可绕过四眼；连点回滚会多次 reload/可能多次平仓；回滚后未激活，交易员以为在跑（或反之）。 | 所有部署/激活/停止/回滚写审计（actor/action/target/before/after/generation/reason）；回滚走审批+二次确认+展示版本 diff；部署/回滚加 busy + 幂等；回滚后明确提示“已切到 INACTIVE，需要重新激活”。 | 执行一次激活/停止/回滚，审计页必须能按时间/人/对象查到；LIVE 回滚无审批必须 428；连点回滚只产生一次 generation 变化；回滚后页面明确显示 INACTIVE。 |
| **TRD-P1-11** | 风控 / `CODE` | 账户级限额“未配置即放行”：`AeronOrderGateway` 只有在 `requireAccountLimits=true` 时才在缺失时报错，默认 false；`StrategyOrderService` 只有 `accountLimit != null` 才校验。没有 `account_risk_limits` 的账户等于没有账户级上限。 | `AeronOrderGateway.ensureRisk()`：`if (accountLimits.isEmpty() && config.getBoolean("requireAccountLimits", false)) throw ...`；`StrategyOrderService.submit()`：`if (accountLimit != null) { ... }`。 | 新账户上线漏配限额，策略可以无限开仓；等到发现时已经超限。 | OPEN 时账户限额缺失必须 fail-closed；UI 在策略激活前检查账户限额并阻断；提供默认限额模板。 | 删除某账户的 `account_risk_limits`，再下 OPEN：必须被拒并提示“账户限额未配置”；配置后恢复。 |
| **TRD-P1-12** | 对账可观测 / `CODE` | 策略详情页看不到该策略的对账状态/issue/lastSuccess；只有 Monitoring 底部一张卡片，而且 `reconciliation/status` 只在页面加载时取一次，盘中新失败不会出现；卡片只有 hover 的 `issues_json`，不能点开。 | `StrategyViewController` 无 reconciliation 字段；`Monitoring.tsx:97-102` 一次性加载 `consistency`/`scoped`，之后不刷新；第 262-279 行卡片 `title={row.issues_json}`。 | 交易员看到“reconciliation gate is not passed”只能去猜；监控页开着也发现不了新失败。 | StrategyView 顶部增加“本地对账 PASS/FAIL + issue + lastSuccess + 刷新”；Monitoring 的 scoped gate 每 5 秒刷新并可点开 issue 详情/跳转策略。 | 制造策略级不一致：StrategyView 5 秒内变红并显示具体 issue；恢复后变绿；Monitoring 不刷新页面也能看到变化。 |
| **TRD-P1-13** | 订单去重 / `CODE` | runner 的重复订单判断只看 `instrument+side+price`，**不看 offset**。如果已有一张同价同向的 CLOSE 挂单，策略再发 OPEN，会直接返回那张 CLOSE 的 id，OPEN 被静默吞掉；反之亦然。 | `AeronOrderGateway.submit()` 第 169-177 行：`existing.instrumentId().equals(...) && existing.side().equals(...) && Math.abs(existing.price()-intent.price())<1e-9`，无 `offset` 比较。 | 该开的仓没开（策略以为已下单），或该平的仓没平；PAIR 在 closeout 与重新报价同价时可能触发。 | 去重键加入 `offset`（或 `intent` 语义），并把被吞掉的请求记日志/指标。 | 同价同向先挂 CLOSE 再发 OPEN：必须产生两张不同订单，或明确拒绝并告警；不得返回 CLOSE 的 id。 |
| **TRD-P1-14** | 控制面容灾 / `CODE` | 控制面宕机期间，**已经在跑的** runner 能靠 last-known lease 继续（好）；但如果 runner 此时重启，构造函数先取 `executionContext`、再等 risk 快照，失败直接 `IllegalStateException` 退出——持仓无人管理，也不能只减仓。 | `AeronOrderGateway` 构造函数第 99-104、146-157 行：`executionContext` 失败即抛；`riskLoaded` 5 秒超时即抛。 | 控制面维护/网络抖动时 runner 崩一次，仓位就裸奔到控制面恢复；夜盘无人值守时风险更大。 | 支持“只读/只平”启动：本地持久化 last-known execution context + 持仓，控制面不可用时允许 CLOSE/CANCEL、禁止 OPEN，并持续告警；控制面恢复后自动补快照。 | 停控制面 → 重启 runner：必须能起来并只允许平仓/撤单；恢复控制面后 OPEN 自动恢复；全程有告警。 |
| **TRD-P1-15** | 止损/熔断 / `CODE` | 只有策略配置里的 `max_loss/stop_loss` 检查，没有账户级单日止损、没有权益回撤熔断、触发后不会自动切只减仓/停策略。亏损扩大只能靠人盯。 | `AeronOrderGateway.ensureRisk()` 只读 `limits.max_loss/stop_loss/upnl_loss`；`StrategyOrderService` 同样只按策略；`EmergencyController` 只有人工 reduce-only。 | 策略参数写错或行情跳空，亏损可以打到账户权益；夜盘无人时没有自动刹车。 | 账户级日止损（金额/权益%）：触发 → 自动只减仓 + 撤开仓单 + 告警 + 需人工复位；策略级止损触发 → 停止该策略并保留平仓能力。 | 模拟当日亏损超过阈值：必须自动切只减仓、撤开仓单、页面红色告警；人工复位前不得恢复开仓。 |
| **TRD-P1-16** | 手工单/合约切换 / `CODE` | **切换合约时旧价格会留在价格框里，且没有偏离提示。** 从 au2612（900）切到 ag2612，如果 ag 还没有行情，`lastPrice` 为空，价格框仍是 900；服务端只校验 tick/lot，不校验偏离。于是一张“卖出 ag @900”会立即以对手价成交（或挂在远离市场的位置）——交易员以为挂了限价，实际成交时点和价格都不是本意。 | `ManualOrder.tsx:131-138`：`useEffect(() => { if (lastPrice != null) setPrice(String(lastPrice)) }, [instrumentId])`；第二个 effect 只在 `current` 为空时填价；`priceDeviation` 在 `lastPrice == null` 时为 0，不显示警告；`TradingController.validateOrder()` 无偏离检查。 | 合约切换是最常见的误操作；旧价 + 无行情 + 无偏离提示 = unintended marketable order，仓位/成交时点不可控。 | 切换合约时立即清空价格并显示“等待行情”；无行情时禁止提交；服务端加价格笼子；前端在 `lastPrice==null` 时显示红色“无参考价”。 | 切到无行情合约：价格必须为空、提交按钮禁用；切回有行情合约：价格自动填最新价；手工输入偏离 10% 必须被服务端拒绝。 |
| **TRD-P1-17** | 断线/假在线 / `CODE` | **顶栏“交易通道已连接”不看下单 Aeron 桥；桥断了仍能提交手工单，并显示为 NEW。** `connected` 只判断 control plane UP + ORS 进程 RUNNING；手工单只判断 `navigator.onLine`；服务端只对 CTP 检查 `manualOrderPublisher.connected()`，SimLocal 发布失败时返回 `aeronPublished=false`，订单仍记 NEW；`routeInfo` 找不到 running route 时回退 `legacy`，可能把单发到没有 ORS 消费的 stream。交易员看到“NEW / 已提交”，以为单子在场内。 | `AppShell.tsx:141-147`：`setConnected(status.controlPlane === 'UP' && Boolean(status.orsRunning))`；`ManualOrder.tsx` 用 `useOnline()`；`TradingController.manualOrder()` 只在 `CTP` venue 检查 `connected()`；第 263-267 行发布失败仍返回 `status=NEW`；第 339-341 行用 `info` 色显示“Aeron 桥未启用”；`ManualOrderPublisher.routeInfo()` 无 route 回退 `legacy`。 | 断线时交易员以为单子已经发出，实际没有到场；或反过来，页面说断开但实际能发。两种都会导致仓位/对冲判断错误。 | 顶栏显示每个 venue 的下单通道健康（publisher.connected）；手工单在通道断开时禁止提交；发布失败必须把订单置 `SEND_FAILED` 并红色告警，不得留在 NEW；无 running route 必须拒绝下单；手工单页面显示 `ack` 而非“已发送”。 | 停掉 manual Aeron 桥：顶栏必须显示“下单通道断开”，手工单提交必须被禁用或明确失败；恢复后正常；订单状态不得停在 NEW；无 route 时必须 422。 |

---

## 3. P2 问题表（体验/效率，不阻断试点）

| ID | 问题 | 交易影响 | 建议 |
|---|---|---|---|
| TRD-P2-01 | Dashboard 标题写死 `SHADOW · 数据源...` | 在 SIM/CTP 环境会误读环境 | 用 `/system/status.environment`，与顶栏一致 |
| TRD-P2-02 | 消息中心只有 NEW/ACK/ALL，无 severity/策略/合约筛选；“全部确认”一键无确认、循环中一个失败就中断且无提示 | 告警多时找不到重点；批量确认误操作 | 加 severity/策略/合约筛选、多选、确认框、逐条结果 |
| TRD-P2-03 | Monitoring 告警只有名字和“触发阈值”，没有当前值/阈值/持续时间/影响策略/runbook；无 ack | 无法判断严重性 | 告警卡补字段、ack、跳转 runbook |
| TRD-P2-04 | 审计页只有最近 100 条，无筛选/分页/导出 | 事后追责找不到 | 时间/人/动作/对象筛选 + 导出 + 至少 1 年 |
| TRD-P2-05 | 审批页用自由文本填 action/target，无 diff、无一键通过确认 | 审批流于形式 | 从具体变更发起、展示 before/after、通过需二次确认 |
| TRD-P2-06 | 订单导出只导当前页；成交无导出；无文本搜索/排序/策略/来源筛选 | 几十单后无法定位 | 服务端筛选/排序 + 导出全部筛选结果 |
| TRD-P2-07 | 订单页不自动刷新；成交表不显示手续费/成交号可读性 | 核对成交要手动刷新 | 1s 刷新或 WS + 手续费列 |
| TRD-P2-08 | 键盘只有 B/S/F2/Esc，没有全撤/停全部/搜索合约快捷键 | 盘中慢 | 可配置快捷键 + 二次确认 |
| TRD-P2-09 | PAIR 告警数量 `qtyFrom(spread)=abs(spread)`，与真实下单手数无关 | 误读为“要下 5 手” | 告警里显示建议手数/腿/价差，不显示价格绝对值 |
| TRD-P2-10 | `PortfolioController` 持仓行 `key={p.symbol}`，多账户同合约会重复 key；`margin/balance` 可能除零 | 渲染异常/显示 Inf% | key 加 accountId；除零保护 |
| TRD-P2-11 | `nextClientOrderId` 在 runner 用时间戳、在控制面用 DB sequence，两套 ID 空间 | 极端情况下冲突；排障困难 | 统一走 DB sequence 或全局 ID 服务 |
| TRD-P2-12 | `SimExchangeService` in-process 路径构造 `SimOrderRequest` 时丢 offset（默认 OPEN），若 `qf.sim.inprocess=true`，CLOSE 在本地 sim 内部会被当 OPEN | 本地 sim 的持仓与 DB 分叉，CLOSE 校验失真 | 传 offset；只在测试 profile 使用，并在启动日志显式标记 |
| TRD-P2-13 | `ExecutionLedgerService` 找不到费率时手续费按 0 计 | 低估成本、虚增 PnL | 缺费率时告警/阻断，或按最坏费率计提 |
| TRD-P2-14 | 结算 API 无 UI、无重复执行保护、结算价需手工 JSON | 交易员无法自行结算/核对 | 结算页 + 幂等 + 结算价来源与确认 |
| TRD-P2-15 | `PairSpreadRunner` 只对 reconciliation 原因做 30 秒告警去重，其他拒单原因每 tick 发 HTTP alert | 告警/日志噪声，拖慢状态线程 | 所有原因按 `reason` 去重 + 冷却 |

---

## 4. 关键问题展开（交易员视角）

### 4.1 “停止自动交易”到底做了什么

作为交易员，我点“停止自动交易”的预期是：**不再报新价，仓位还在，我可以手动处理**。

实际链路：

```text
POST /strategy-deployments/{id}/deactivate
  → generation = generation + 1, status = INACTIVE, desired = STOPPED
  → agent 看到 generation 变化，且 INACTIVE 也算 shouldRun
  → ProcessManager.reload() = stop() + start()
  → stop() 发 SIGTERM
  → runner shutdown hook: cancel all → flatten → 等 flat
  → 然后以 INACTIVE 重新启动（只告警，不下单）
```

对 PAIR：两条腿用 `tick.bidPrice()/askPrice()` 发 FAK 平仓；如果一条腿没流动性，120 秒 drain 超时，agent 180 秒强杀，**留下另一条腿**。
对通用 runner：drain 依赖 `lastTicks`；没有行情就平不了。

更让人困惑的是：顶栏“停全部”走的是 `pauseActiveDeployments`，**不 bump generation**，所以 agent 不 reload、不平仓；单策略“停止自动交易”走 `deactivate`，会 bump generation，于是 reload→drain→平仓。
**同样叫“停止”，一个保仓、一个平仓，交易员无法从按钮文字判断。**
“激活”也是一样：`activate` 会 bump generation；如果进程正在 INACTIVE 且还有仓位，激活会先 reload→drain 平掉旧仓，再开始新仓。

**这是当前最容易被误触发、后果最大的一条。** 页面必须明确写“会平仓”，并且提供“只停报价、保留仓位”的选项。

### 4.2 “全撤”为什么会漏掉最该撤的单

交易员的心理模型：点了全撤 → 所有没成交的单都没了。

实际 SQL：

```sql
AND status IN ('NEW', 'OPEN', 'PARTIAL', 'CANCEL_REQUESTED')
```

`CANCEL_FAILED`（撤单失败）、`ACK_TIMEOUT`（30 秒没收到委托确认）、`SENT`（已发未确认）都不在里面。
这三种状态恰恰意味着“交易所那边可能还活着”。如果只剩这类单，全撤返回 0 笔，页面显示“已发 0，失败 0”，交易员会认为已经干净。

**建议：全撤的唯一完成条件是“每一张单都拿到交易所终态”，不是“本地库更新了”。**

### 4.3 手工单：预检很漂亮，但钱和价都不真

我在页面上看到的：

- 最新价：2 秒 HTTP 轮询，可能是旧价；没有 age。
- 偏离提示：>0.5% 只是黄色提示，服务端不拦。
- 预计保证金：`名义金额 × 10%`，与 `instrument_margins` 无关。
- 可用资金：`accounts.available`，而它可以被人在账户页手工改。
- “只减仓”：只是 UI 的一个 chip，SBE `OrderRequest` 没有这个字段，`ManualOrderPublisher` 也不传；如果 offset=OPEN，它照样开仓。
- 确认按钮：可以连点，服务端没有幂等键。

**结论：手工单的“两段式”流程是对的，但“钱”和“价”的校验还不足以让我放心把手指放在鼠标上。**

### 4.4 对账：策略级修好了，但“连坐”换了个地方

已修：

```text
localReconciliationScope = STRATEGY
localReconciliationPass  = 按 strategyId 查 reconciliation_status
reject reason 带 scope/issues/lastSuccess
PAIR 对 reconciliation 原因 30 秒去重
```

仍未修：

```text
reconciliationPass = localPass && venue.passed()
```

`venue.passed()` 来自 `SimLocalVenueReconciler`，它：

- 用 `mapper.listOrders()` 取**所有账户**的订单；
- 只和 `SIMLOCAL-001` 的快照比；
- 快照文件缺失直接 `passed=false`。

所以只要有一个 CTP 账户挂着单，或者快照没写，PAIR 的 ag 也会被拒。
这不是“PAIR 被 OPT 连坐”，而是“PAIR 被所有账户/所有场所连坐”。

另外，对账 Gate 只存在于 `AeronOrderGateway`：

- 手工单 `TradingController.validateOrder()` 不检查；
- HTTP 策略单 `StrategyOrderService.submit()` 不检查；
- 撤单/平仓不检查（这是对的，必须始终允许）。

**结论：CLOSE/CANCEL 始终允许是对的；但 OPEN 的 Gate 没有覆盖所有入口。**

### 4.5 账务：交易员现在无法回答的 5 个问题

1. 今天已实现盈亏是多少？含不含手续费？
2. 今天手续费一共多少？逐笔对不对？
3. 现在占用多少保证金？锁仓/期权卖方算对了吗？
4. 可用资金是多少？为什么和 CTP 终端不一样？
5. 昨天结算后 today/yesterday 持仓和均价对不对？

页面上没有一页能同时回答这 5 个问题。
`SettlementService` 有，但只能 curl，且结算价要手工传 JSON；没有结算历史页面。
`StrategyViewController` 的“已实现盈亏”是成交流水重算后减手续费，ledger 的已实现盈亏是毛利，两个口径。

**对交易员来说，账务不可核对 = 不敢放大资金。**

### 4.6 策略横幅：为什么“确认后消失”仍然会失败

关键在 `selectedAlerts`：

```ts
const selectedAlerts = (historyAlerts.length > 0
  ? historyAlerts
  : alerts.filter((alert) => alert.strategy_id === selected))
```

- `historyAlerts` 是页面打开时（或手动激活后）的一次性快照；
- `alerts` 是 5 秒轮询的实时 NEW 列表；
- 只要快照非空，实时列表就被忽略。

于是：

| 场景 | 结果 |
|---|---|
| 打开页面时该策略没有告警，之后新触发 | `historyAlerts` 为空 → 用实时 `alerts` → 横幅出现，ack 后消失（正常） |
| 打开页面时该策略已有 1 条告警，之后又触发 1 条 | 用旧快照 → 新告警不出现；旧告警 ack 后仍是 `NEW` → 横幅不消失 |
| 页面开着，策略反复触发 | 只显示第一次快照，交易员看不到最新一条 |

这就是“确认后消失”修复没有覆盖主场景的原因。修法不是再加一个 `filter`，而是**去掉 `historyAlerts` 作为未确认数据源**。

---

## 5. 已确认改善（代码级，值得保留）

以下是我逐条读代码确认“确实变好了”的部分，不含未验证的交易日结论。

| 项 | 证据 | 评价 |
|---|---|---|
| 成交落库事务化 | `ExecutionLedgerService.applyTrade()` `@Transactional`，同一事务写 trade/order fill/ledger/strategy_positions/positions | 方向正确；删除了“trade 已写、position 未写”的窗口。但控制面只有 1 个单测，缺回滚/并发测试 |
| 策略级对账 | `ScopedReconciliationService` + `reconciliation_status`；`/risk` 返回 `localReconciliationScope/Pass/Issues/LastSuccess` | 真正解决了“OPT 不一致拦 PAIR”的主场景 |
| 对账原因可定位 | `AeronOrderGateway.reconciliationReason()` 带 `scope=STRATEGY:<id> issues=[...] lastSuccess=...` | 告警从一句话变成可定位；但 UI 展示仍需优化 |
| FILLED_WITHOUT_TRADE 宽限 | `ReconciliationMapper.listStrategyFilledWithoutTrade` 带 `updated_at < now() - 2 seconds` | 降低瞬时误报 |
| ACK 幂等 | `StrategyAlertController.ack()` 重复确认返回 `duplicate=true`，不 404 | 多标签页/重试安全 |
| 策略详情不再自动 ack | 打开详情只 `loadHistory`，ack 需显式点击 | 符合“看≠确认” |
| 手工单两段式 | 预检 → 确认弹窗 → 提交；确认需输入合约代码 | 防误点方向正确；但按钮未防连点、服务端无幂等 |
| 手工单基础校验 | 合约存在/active、tick、lot、数量 ≤100、账户 active、开平可平数量、可用资金、50k 二次确认 | 比 11-06 大幅改善；仍缺价格笼子/时段/涨跌停 |
| 订单页单笔撤单 | `Orders.tsx` 撤单按钮 + `CANCELED/CANCEL_FAILED` 状态色 | 有入口；但无终态确认、无自动刷新 |
| 订单页筛选/导出/列配置 | 状态 chip、账户、时间范围、CSV、密度、列隐藏 | 日常可用性提升；仍缺搜索/排序/批量 |
| 应急入口 | 顶栏 全撤/停全部/只减仓 + 确认弹窗；`stop-all` 同时暂停 strategies/deployments/instances | 入口正确；但全撤状态集、只减仓撤单、无 flatten 是硬伤 |
| 控制面宕机不误停 | `PairSpreadRunner` 对 `UNKNOWN` 保留 last-known mode；`AeronOrderGateway` 快照过期只拦 OPEN | 符合“控制面故障不误杀策略” |
| CLOSE/CANCEL 不被对账拦 | `AeronOrderGateway.ensureRisk()` 在 `!opening` 时提前 return | 降风险动作始终允许，正确 |
| 期权到期只减仓 | `AeronOrderGateway`/`TradingController`/`StrategyOrderService` 的 nearExpiry 检查 | 方向正确；CTP 到期/行权数据未验证 |
| PAIR 两腿时段交集 | `PairSpreadRunner.activeSession()` 取两腿交集，closeout 按较早收盘 | 逻辑正确；夜盘跨零点归属仍是 bug |
| 订单生命周期兜底 | `OrderLifecycleGuard` 30 秒 ACK_TIMEOUT + 撤单失败重试（最多 3 次） | 比“永远 NEW”好；但 ACK_TIMEOUT 不可撤、CANCEL_REQUESTED 无超时 |
| 审计 append-only | schema trigger + `auditMapper.insert` 覆盖手工单/应急/策略状态 | 数据库层防改；但部署/激活/回滚没写审计（见 P1-10） |
| Monitoring 三层状态 | `CONFIGURED/ENABLED/HEALTHY` 区分，`system/status` 而非 `/health` | 不再“假在线” |

---

## 6. 仍阻塞项（进入影子/小资金前必须解决）

```text
[BLOCK] 停止策略会先平仓，且 UI 未告知；无“只停报价”模式            → TRD-P0-01
[BLOCK] 全撤跳过 CANCEL_FAILED/ACK_TIMEOUT/SENT                      → TRD-P0-02
[BLOCK] 对账 Gate 未覆盖手工单/HTTP 策略单；venue 级仍全局连坐        → TRD-P0-03
[BLOCK] 保证金/可用资金/权益不是账户事实（10% 估算、可手改、默认 100 万） → TRD-P0-04
[BLOCK] Dashboard 期权 Greeks/PnL 使用固定 18% IV                     → TRD-P0-05
[BLOCK] 策略横幅数据源冻结：新告警不出现、确认后不消失                → TRD-P0-06
[BLOCK] 手工单可重复提交，无幂等                                      → TRD-P0-07

[未验证] CTP 交易日：手续费/保证金导入、结算、委托/撤单 ack、FAK/FOK/IOC 映射、期权保证金/行权
[未验证] SimLocal 交易日：PAIR 真实发单不被误拦、部分成交、CANCEL_FAILED、drain 平仓
[未验证] 控制面单元测试仅 1 个（ManualOrderPublisherTest）；对账/账本/撤单/结算无回归测试
[未验证] LIVE 四眼审批：UI 不发送 X-Approval-Id，LIVE 下激活会 428；回滚完全绕过审批
```

> 注：`docs/reviews/remediation-execution-2026-11-08.md` 写“P0 全部关闭”，但从交易员可用性看，至少上述 7 项不能算关闭。
> 这些不是“代码没写”，而是“写了但语义/覆盖/数据源不对”。

---

## 7. 下一交易日必须验证的清单

> 顺序按开盘到收盘；每项都要保存截图/接口响应/DB 查询结果到 `docs/evidence/next-trading-day/`。
> 判定标准必须是“交易所/CTP 的结果”，不是“本地库的状态”。

### 7.1 开盘前（08:45–09:00）

| # | 验证 | 通过标准 | 失败即阻断 |
|---|---|---|---|
| 1 | 账户权益/可用/保证金 vs CTP 终端 | 权益、可用、占用、维持保证金四项差异 = 0 或可解释 | 是 |
| 2 | `instrument_fees` / `instrument_margins` | 非零；multiplier/prev_settle 与 CTP 一致；重复导入不产生重复行 | 是 |
| 3 | 账户余额是否仍可手工改 | CTP 账户只读；或明确这是 SimLocal 专用 | 是 |
| 4 | `tradingDay=true`、`nightSessionOk`、下一交易日 | 与交易所日历一致 | 是 |

### 7.2 开盘后（09:00–09:30）

| # | 验证 | 通过标准 | 失败即阻断 |
|---|---|---|---|
| 5 | 手工单完整链路 | 预检→确认→交易所 ack；`Orders` 1 秒内出现 `OPEN` | 是 |
| 6 | 双击“确认下单” | DB 只有 1 条订单；交易所只有 1 笔委托 | 是 |
| 7 | 只减仓 + 开仓 | 服务端拒绝；或明确提示“只减仓不拦 OPEN” | 是 |
| 8 | 价格偏离 10% / 涨跌停外 / 午休 | 服务端拒绝并给出原因 | 是 |
| 9 | 非交易时段开仓 | 拒绝 | 是 |

### 7.3 撤单与应急（09:30–10:30）

| # | 验证 | 通过标准 | 失败即阻断 |
|---|---|---|---|
| 10 | 单笔撤单 | 收到交易所 `CANCELED` 才算完成；不是 `CANCEL_REQUESTED` | 是 |
| 11 | 制造 `CANCEL_FAILED` 后点“全撤” | 该单必须出现在回执并重试；不能返回 0 笔 | 是 |
| 12 | 制造 `ACK_TIMEOUT` 后点“全撤” | 同上；且订单页可单笔撤 | 是 |
| 13 | 只减仓开关 | 现有开仓挂单被撤；新开仓（买/卖）都被拒 | 是 |
| 14 | stop-all | 5 秒内停新单/撤单；明确列出未平仓位；不得声称“已平仓”（当前 stop-all 不平仓） | 是 |
| 15 | 停止单个策略 | 记录停止前后持仓；确认是否平仓；UI 必须提前告知 | 是 |

### 7.4 对账（10:30–11:00）

| # | 验证 | 通过标准 | 失败即阻断 |
|---|---|---|---|
| 16 | OPT 策略制造不一致，PAIR ag 开仓 | PAIR 不被拒 | 是 |
| 17 | CTP/其他账户挂一张单，PAIR ag 开仓 | PAIR 不被 venue 连坐 | 是 |
| 18 | PAIR 自身制造不一致 | OPEN 被拒；CLOSE 通过；reason 带 scope/issue/lastSuccess | 是 |
| 19 | 停控制面 10 分钟 | 已运行 runner 不撤单/不停策略；OPEN 在快照过期后拒绝；CLOSE 通过 | 是 |
| 20 | 停控制面后重启 runner | 能起来并只允许 CLOSE/CANCEL（当前预期会失败，见 P1-14） | 是 |

### 7.5 收盘前与夜盘（11:15 / 14:50 / 21:00 / 02:00）

| # | 验证 | 通过标准 | 失败即阻断 |
|---|---|---|---|
| 21 | 11:27 / 14:57 closeout | 撤单+平仓完成；无挂单过午休/收盘 | 是 |
| 22 | 夜盘 21:00 恢复报价 | 两腿都开盘后才报价；一腿关闭则停新开仓 | 是 |
| 23 | 周六 00:30（周五夜盘） | OPEN 允许至 02:27；不被 `todayTradingDay=false` 误拒 | 是 |
| 24 | 02:27 夜盘 closeout | 按较早收盘平仓；02:30 后无挂单 | 是 |

### 7.6 账务与复盘（收盘后）

| # | 验证 | 通过标准 | 失败即阻断 |
|---|---|---|---|
| 25 | 日结算 API | today_* 清零、yesterday_* = 原持仓、avg=结算价、ledger SETTLE 双分录 | 是 |
| 26 | 手续费逐笔 vs CTP | 逐笔一致；平今/平昨费率正确 | 是 |
| 27 | 锁仓保证金 | 1 多 1 空不得算 0 | 是 |
| 28 | 期权卖方保证金 | 与 CTP 一致 | 是 |
| 29 | 账户权益与 CTP 对账 | 差异 = 0 | 是 |
| 30 | 告警闭环 | ack 后横幅消失；新告警 5 秒内出现；静默对重复告警有效 | 是 |
| 31 | 审计 | 激活/停止/回滚/手工单/全撤都能按时间/人/对象查到 | 是 |
| 32 | 导出 | 订单/成交/账务 CSV 可用于财务对账 | 否（P1） |

---

## 8. 需要人类确认的问题（只列真正阻塞或需要交易决策的）

1. **“停止自动交易”是否应该平仓？**
   当前实现是“停止 = reload = drain = 平仓”。如果这是预期，UI 必须改文案并加二次确认；如果不是，需要新增“只停报价、保留仓位”的模式，且 agent 不能在 INACTIVE 时 reload。
   这是交易决策，不是技术决策。

2. **对账失败时，手工单是否允许开仓？**
   当前允许，且没有任何提示/审计标记。如果允许，必须定义 break-glass：谁有权、二次确认、审计、事后复核；如果不允许，需要把 Gate 加到 `TradingController.validateOrder()`。

3. **CTP 账户的 balance/available/margin 由谁维护？**
   当前页面可手工改。若继续允许，等于交易员可以自己“创造”可用资金；若不允许，需要明确由 CTP 查询/结算写入，并定义刷新频率与失败时的 fail-closed 行为。

4. **期权保证金采用哪个口径？**
   `instrument_margins` 是单腿比例；期权卖方/组合（垂直价差、跨式）在 CTP 有组合优惠/SPAN 类口径。当前按单腿比例可能高估或低估。需要交易/风控确认采用交易所组合保证金还是单腿保守估算。

5. **全撤是否必须覆盖 `CANCEL_FAILED/ACK_TIMEOUT/SENT`？**
   我的建议是必须。但需要确认：对 `ACK_TIMEOUT` 重发撤单是否会造成“对已成交单反复撤单”的噪声/费用；如果会，是否改为“先查单再撤”。

6. **LIVE 的审批链路是否要现在打通？**
   UI 不发送 `X-Approval-Id`，LIVE 下所有激活都会 428；回滚完全绕过审批。试点如果只在 SHADOW/SIM，可以先记录为已知限制；如果要进 LIVE，必须先打通并在 UI 里选择审批单。

7. **告警静默/去重的业务规则**
   当前按 `(strategy, instrument, side)` ack 后静默 30 分钟，会掩盖同合约同方向的不同原因。是否改为按 `reason/reason_code` 维度？静默是否应该只影响通知、不影响告警入库？

8. **是否接受“控制面测试只有 1 个”就进入小资金试点？**
   对账事务、账本、撤单、结算都没有回归测试。如果下一交易日只能人工验证，建议至少把本文 P0-01/02/03/04 的场景写成集成测试，否则每次改动都可能重新引入。

---

## 9. 审查范围与未覆盖

已读/已核对：

```text
web/src/pages/ManualOrder.tsx, Orders.tsx, StrategyView.tsx, Alerts.tsx,
  Dashboard.tsx, Monitoring.tsx, Strategies.tsx
web/src/components/AppShell.tsx
web/src/hooks/useStrategyAlerts.ts
backend/runtime-runner/.../AeronOrderGateway.java, PairSpreadRunner.java, RuntimeRunnerMain.java
backend/runtime-agent/.../HeartbeatClient.java, ProcessManager.java
backend/control-plane/.../StrategyRuntimeController.java, ExecutionLedgerService.java,
  ScopedReconciliationService.java, SettlementService.java, LedgerService.java,
  TradingController.java, StrategyOrderService.java, StrategyDeploymentController.java,
  EmergencyController.java, StrategyAlertController.java, ReconciliationController.java,
  SimLocalVenueReconciler.java, PortfolioController.java, ApprovalGuard.java,
  OrderLifecycleGuard.java, ManualOrderPublisher.java
backend/sim-exchange/.../SimExchange.java, SimOrderRequest.java
backend/control-plane/src/main/resources/mapper/*.xml（关键 SQL）
abi/sbe/quantlink-fin-sbe.xml
最近 35 条 git log
```

未覆盖/未验证：

```text
OptionChain.tsx 的报价/下单交互
C++ ORS / CTP Adapter 的委托/撤单/成交回报映射
Aeron Archive 重放的端到端一致性
ClickHouse 遥测与告警引擎的阈值准确性
HA/备份/PITR（文档已标 BLOCKED）
Windows Electron（文档已标 BLOCKED）
真实 CTP 的期权行权/指派/组合保证金
```

---

*本报告只读代码与文档，未修改任何生产代码。*
*报告中的“代码确认”不等于“交易日验证”；下一交易日请按第 7 节逐项留证。*

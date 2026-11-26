# 交易员最终复审：策略中心 V2.1

- 日期：2026-11-09
- 评审对象：`docs/architecture/23-策略中心V2设计稿.md`（V2.1 DRAFT）
- 复审基线：`docs/reviews/trader-review-2026-11-09-strategy-centric-v2.md`
- 评审视角：期货/期权交易员（SHFE au/ag，做市 + 方向 + 对冲），兼交易系统评审
- 结论：**REQUEST_CHANGES**
- 统计：**P0 3 CLOSED / 7 PARTIAL / 0 OPEN；P1 3 CLOSED / 14 PARTIAL / 0 OPEN；P2 2 CLOSED / 8 PARTIAL / 0 OPEN**

> V2.1 的方向和主干是对的：Fork/版本/绑定 Agent 的约束把“策略迁移”从身份问题降成了产品问题；§3.8/§3.9 把账户持仓权威和策略平仓校验写清楚了；§8.5 也终于把 SBE 归属链路摆上桌面。
>
> 但 **§17 的闭环矩阵比正文走得更快**：多项 P1/P2 只在矩阵里写了结论，正文仍是 V2 的旧交互/旧默认值；P0-03/04/05/06/07/08/09 仍有正文与矩阵、正文与业务约束之间的矛盾。按现稿可以继续做 Phase 0 设计，但不能直接进入 Phase 1 的实现/迁移。

---

## 0. 复审口径

本轮不把“§17 写了决定”等同于“正文已闭合”。采用三个状态：

| 状态 | 判定标准 |
|---|---|
| **CLOSED** | 正文有明确、可执行的规则，且与 §17 矩阵一致；不依赖实现者猜 |
| **PARTIAL** | §17 有决定，但正文缺失、仍是旧交互、或与业务约束/其他章节矛盾；需要补正文或冻结参数 |
| **OPEN** | 没有可执行规则，或多个章节互相冲突，无法落成实现 |

本轮重点不是文字润色，而是回答三个问题：

1. 交易员看到的页面，是否真的按策略/账户/环境/柜台隔离？
2. 策略持仓、手工簿、账户快照三者能否对账，且不会被“配平项”掩盖？
3. Phase 分阶段上线时，是否会出现“先上策略 PnL、后补归属/权限/行情键”的错账窗口？

---

## 1. 总裁决

### 1.1 结论

**REQUEST_CHANGES，不允许按现稿进入全面实现。**

不是方向问题，是“正文没有跟上矩阵”的问题：

- **P0-03**：`bound_agent_id` 只绑 Agent，没有绑账户/柜台/ORS；§16 又说 Fork 必须新 Agent、可以同一账户，和 v1“一账户一 ORS”冲突。
- **P0-04 / P0-09**：SBE v2 的字段清单不完整（缺 `routeId/orderEpoch`），`strategyId int32` 和 `strategyKey/bookId` 的关系没有冻结；CTP 回报打标的合同还不够实现。
- **P0-06 / P0-08**：权限 enforcement 放在 Phase 6，但 Phase 2/3 已经暴露策略/订单/账户数据；SBE 归属升级也在 Phase 6，但 Phase 2 已经做“成交归因”。阶段上线会出现错账窗口。
- **P0-07**：正文说账户/全局应急“只放在运维页”，§17 又说订单/成交/总持仓/监控页可打开应急抽屉；两处必须选一个。
- **P1/P2**：大量矩阵决定没有落回正文（P1-02/05/06/07/08/09/10/11/12/13/14/16/17，P2-01/02/03/04/07/08/09/10）。

### 1.2 是否允许进入实现

**不允许全面进入实现。** 可以进入“Phase 0 设计/契约冻结”，但不能开始写生产迁移或移除顶部选择器。最小阻塞项：

1. **P0-03 绑定身份**：`bound_agent_id` 之外，必须冻结 `bound_account_id / bound_counterparty_id / bound_ors_id`；明确 Fork 是否允许同一账户；明确“一账户一 ORS”下 Fork 到新 Agent 的合法路径（旧 ORS 释放前拒绝）。
2. **P0-04 + P0-09 SBE 合同**：SBE v2 的字段 ID/类型/长度、`bookId` 与 `strategyKey` 的唯一语义、`routeId/orderEpoch`、旧协议兼容策略、CTP 映射持久化，必须先冻结再写 Phase 1。
3. **P0-06 + P0-08 阶段顺序**：权限 enforcement 和 SBE 归属必须前移到 Phase 1/2，不能等 Phase 6；Phase 2 的“成交归因”不能早于 SBE 归属。
4. **P0-07 应急语义**：正文的“只在运维页”与 §17 的“任何页可开应急抽屉”必须二选一；同时定义 `currentStrategyId`。
5. **P0-05 手工簿账本 + P1-05 / P1-06 / P1-08 / P1-13 / P1-16 正文补充**：`Book` 元数据之外必须有 `book_positions`/未分配持仓账本；账户 PnL 快照、未分配认领、策略持仓主键/结算、PnL 口径、迁移脚本，不能只存在于 §17。

### 1.3 一句话给交易员

**V2.1 已经把“策略中心”讲清楚了，但还没有把“策略账本”讲完。** 现在最危险的不是页面长什么样，而是：Phase 2 先上策略 PnL，Phase 6 才补 SBE/权限；中间这段时间，策略 PnL 可能是用本地归因 + 全局行情 + 未授权数据算出来的。

---

## 2. 逐项闭环状态

### 2.1 上一轮 P0（10 项）

| ID | 状态 | 设计稿对应章节/决定 | 说明 |
|---|---|---|---|
| P0-01 账户持仓等式/未分配配平 | **CLOSED** | §3.8、§5.3、§17 P0-01 | 账户持仓=柜台快照权威；`unassigned = account - attributed`；`book_type=MANUAL` 只计一次；`source/as_of/stale` 已补。§15 验收仍写“策略+手工+未分配=账户持仓”，建议改成“差额等式”，避免实现者当成配平项 |
| P0-02 策略平仓用策略持仓 | **CLOSED** | §3.9、§5.3、§17 P0-02 | 先策略持仓、再账户可平量、取更严格者；今昨/平今按策略持仓；行锁/版本；超平拒绝不 clamp |
| P0-03 策略迁移/身份 | **PARTIAL** | §3.4、§3.5、§3.6、§16 第 6 条 | 不可迁移+Fork 方向正确；但只绑 `bound_agent_id`，未绑 account/counterparty/ORS；§16“Fork 必须新 Agent、可以同一账户”与 v1 一账户一 ORS 冲突（见 §3.1） |
| P0-04 CTP/SBE 归属链路 | **PARTIAL** | §8.5、§17 P0-04 | 字段和映射方向正确；但 SBE v2 只列字段名，没有字段 ID/类型/长度/版本协商；§8.5 的 `OrderUpdate/Trade` 清单漏 `routeId/orderEpoch`；`strategyId int32` 与 `strategyKey/bookId` 的关系未冻结（见 §3.2） |
| P0-05 手工簿模型 | **PARTIAL** | §3.7、§4.3、§7.3、§17 P0-05 | 独立 `Book` 元数据和隔离规则正确；但只有 `Book` 表，没有 `book_positions`/手工簿持仓账本，`manual_book_position`/`unassigned_position` 没有可落地表（见 §3.7） |
| P0-06 账户级权限 | **PARTIAL** | §12、§17 P0-06 | 正文已有唯一键/default deny/403/AuthorizationService 原则；但 §14 把 enforcement 放到 Phase 6，Phase 2/3 先暴露数据；正文缺 ADMIN action/权限版本/测试矩阵（见 §3.3） |
| P0-07 应急范围/当前策略 | **PARTIAL** | §4.1、§11.1、§11.2、§17 P0-07 | 顶栏移除全局应急正确；但正文说账户/全局“只放在运维页”，§17 说订单/成交/总持仓/监控页可开应急抽屉；`currentStrategyId` 未定义（见 §3.4） |
| P0-08 Phase 顺序/错 PnL 窗口 | **PARTIAL** | §14、§15、§17 P0-08 | Phase 1 已含行情键，比上版好；但 Phase 2 成交归因早于 Phase 6 SBE，Phase 3 策略绑定/版本/Fork 入口早于 Phase 5 实现，Phase 2/3 早于 Phase 6 权限 enforcement（见 §3.5） |
| P0-09 旧 ORS/fencing | **PARTIAL** | §7.1、§7.2、§8.3、§17 P0-09 | 字段和 FENCED 方向正确；§8.3 要求 `routeId/orderEpoch`，§8.5 SBE 字段清单却没有；`last_update_fencing_token` 未在订单表出现；旧 ORS 同 generation 的校验链不完整（见 §3.6） |
| P0-10 LIVE/SHADOW 环境 | **CLOSED** | §4.1、§4.3、§4.4、§10.3、§10.4、§17 P0-10 | 列表/详情/确认框/审计显示环境；LIVE 红色水印+二次确认；v1 默认禁用 LIVE；手工单确认有环境 |

**P0 统计：CLOSED 3（01、02、10），PARTIAL 7（03、04、05、06、07、08、09），OPEN 0。**

### 2.2 上一轮 P1（17 项）

| ID | 状态 | 设计稿对应章节/决定 | 说明 |
|---|---|---|---|
| P1-01 跨交易所列表 | **CLOSED** | §4.3、§17 P1-01 | 列表显示 `SHFE, SIM`/交易所集合；详情可全部/单交易所；筛选多选 |
| P1-02 手工单默认账户/preview | **PARTIAL** | §10.3、§17 P1-02 | 正文有 env/book/contextVersion/preview 失效；缺“默认上次账户”、`accountVersion`、确认框方向/价格/数量/名义/保证金/偏离（§17 才写） |
| P1-03 行情/期权链/交易入口 | **CLOSED** | §4.2、§16 第 8 条 | 一级导航已有“行情 / 期权链、手工交易”；入口携带上下文 |
| P1-04 共享账户保证金/限额 | **PARTIAL** | §6.3、§17 P1-04 | 正文只写“账户权威、策略风险预算”；没有 `strategy_risk_budget` 字段/校验/展示细节（§17 才写） |
| P1-05 账户 PnL 快照/容差 | **PARTIAL** | §6.2、§17 P1-05、§18 | 正文仍是 `≈`，没有 `account_pnl_snapshot` 表/基准/容差；只有 §17/§18 有阈值 |
| P1-06 未分配/外部成交认领 | **PARTIAL** | §5.3、§13、§17 P1-06 | 正文提到认领流程，API 有 `/unassigned`、`/claim`；没有表/页面/SLA/阻断规则（§17 才写） |
| P1-07 部署生命周期/回滚 | **PARTIAL** | §10.6、§14 Phase 5、§17 P1-07 | 正文有“更新到当前 Agent/Fork/历史”，状态机 `VALIDATED → ...` 只在 §17；drain/审批/回滚细节不在正文 |
| P1-08 `strategy_positions` 主键/结算 | **PARTIAL** | §3.5、§5.1、§17 P1-08 | 正文有 `position_epoch` 和归属键；唯一键、`realized_pnl/fees` 事务同步、日终 today→yesterday 只在 §17 |
| P1-09 状态列拆分 | **PARTIAL** | §4.3、§17 P1-09 | 正文列表仍只有一个“状态”列；§17 说拆成 `book_type/deployment_status/strategy_status`，正文未改 |
| P1-10 订单/成交默认范围/分页 | **PARTIAL** | §10.5、§17 P1-10 | 正文仍“全部授权策略”；§17 才写“今日未完成+今日成交”、URL 带 strategyId、分页/排序/CSV |
| P1-11 API 幂等/preview/手工簿端点 | **PARTIAL** | §13、§17 P1-11 | 正文有 `previewId`；缺 `clientRequestId/previewVersion/orderType/reduceOnly`，缺 `/books/{id}/orders`；§17 才写 |
| P1-12 审计事件 | **PARTIAL** | §12、§17 P1-12 | 正文只有字段清单，没有 `BOOK_ASSIGN/STRATEGY_FORK/...` 事件；§17 才写 |
| P1-13 PnL 口径/期权 Greeks | **PARTIAL** | §6.1、§17 P1-13 | 正文只有公式；FIFO、手续费、mark source、Greeks/IV 只在 §17 |
| P1-14 策略详情账户上下文 | **PARTIAL** | §4.4、§10.1、§17 P1-14 | 正文没有“账户上下文”卡片；§17 才写权益/可用/风险度/同账户策略 |
| P1-15 系统健康按柜台/交易所 | **CLOSED** | §4.1、§10.4、§17 P1-15 | 顶栏“系统健康”可展开按柜台/交易所；任一授权柜台 P0 故障转红 |
| P1-16 迁移脚本/SBE 版本 | **PARTIAL** | §14、§17 P1-16 | 正文 Phase 1 有字段和行情键；缺手工单回填、`trades` 按 client_order_id 回填、旧 `strategy_positions` 去重、旧 SBE 兼容细节 |
| P1-17 1:1/单 ACTIVE 约束 | **PARTIAL** | §3.3、§3.4、§17 P1-17 | 正文没有 DB 约束/启动检查；§17 才写 `UNIQUE`/部分唯一索引/乐观锁 |

**P1 统计：CLOSED 3（01、03、15），PARTIAL 14，OPEN 0。**

### 2.3 上一轮 P2（10 项）

| ID | 状态 | 设计稿对应章节/决定 | 说明 |
|---|---|---|---|
| P2-01 PnL `asOf/source/stale` | **PARTIAL** | §5.1/§5.2、§17 P2-01 | 持仓表有 `source/as_of/stale`；策略列表 PnL 正文没有 `asOf`，§17 才说“所有 PnL” |
| P2-02 状态中英/状态色 | **PARTIAL** | §4.3、§17 P2-02 | 正文仍一个“状态”列；§17 才说统一中文/颜色只用于 deployment |
| P2-03 策略详情 Tab 收起 | **PARTIAL** | §4.4、§17 P2-03 | 正文仍是 8 个 Tab；§17 才说默认概览/折叠/记住 Tab |
| P2-04 收藏/最近策略 | **PARTIAL** | §4.3、§17 P2-04 | 正文无收藏/最近；§17 才写 |
| P2-05 `book_id` UUID | **CLOSED** | §3.7、§17 P2-05 | Book `book_id` UUID；`MANUAL-<account>` 只做 display_name |
| P2-06 策略/手工簿/未分配分区 | **CLOSED** | §3.7、§4.3、§17 P2-06 | 手工簿独立分组，不进入策略排名/部署；未分配独立 |
| P2-07 账户汇总下钻 | **PARTIAL** | §10.2、§17 P2-07 | 正文“支持展开到策略”；未写展开到持仓/未分配/订单 |
| P2-08 UNASSIGNED badge | **PARTIAL** | §5.3、§17 P2-08 | 正文有未分配概念；无 badge/阈值颜色 |
| P2-09 API 分页/错误码/OpenAPI | **PARTIAL** | §13、§17 P2-09 | 正文 API 仍是草案；§17 才写统一分页/错误码/OpenAPI |
| P2-10 导出/列配置 | **PARTIAL** | §17 P2-10 | 正文没有导出/列配置；§17 才写 CSV/PDF/保存视图 |

**P2 统计：CLOSED 2（05、06），PARTIAL 8，OPEN 0。**

---

## 3. P0 未关闭项详解

### 3.1 P0-03（PARTIAL）：`bound_agent_id` 只绑 Agent，Fork 同账户与 v1 一账户一 ORS 冲突

**设计稿位置**：§3.1、§3.4、§3.5、§3.6、§16 第 6 条。

**问题**：
- §3.4 只把 `bound_agent_id` 设为不可变；`bound_account_id / bound_counterparty_id / bound_ors_id` 没有进入 `strategies` 表，也没有“版本更新只能同一账户/柜台/ORS”的数据库/服务端校验。
- §3.5 说“更新版本只能部署到同一个 Agent”，但没有禁止同一 Agent 下换账户/柜台/ORS。一个 Agent 最多一个 ACTIVE ORS；如果同一 Agent 上换账户，就必须换 ORS，实际是迁移，不是版本更新。
- §16 第 6 条说“Fork 必须指向新的 Agent；可以落在同一账户”。但 v1 是“一账户 = 一 ORS”；同一账户要新 Agent，就要新 ORS。如果旧策略/旧 ORS 仍 ACTIVE，这和“一账户一 ORS”冲突；只有旧策略 flat/archived 且旧 ORS 已释放时，才可能分配新 ORS。§3.4 又说“停止、INACTIVE、FAILED 都不解除绑定”，但没有定义“归档/释放 ORS”，所以同账户 Fork 的合法路径没有闭环。
- §3.6 说 Fork 可选择新的 Agent/柜台/账户；§16 又说必须新 Agent；两处不一致；且没有定义旧策略归档/旧 ORS 释放后才能 Fork 同账户。

**交易员影响**：
- 同一策略 ID 可能在版本更新后落到另一个账户/ORS，策略持仓/PnL 跨账户混算。
- Fork 到同一账户可能直接失败（409/ORS 冲突），或者绕过一账户一 ORS，出现两个 ORS 同时交易同一账户。
- 交易员以为“只是更新版本”，实际换了账户/柜台，旧仓没人管。

**修改建议**：
1. 在 `strategies` 增加 `bound_account_id / bound_counterparty_id / bound_ors_id`，和 `bound_agent_id` 一起在首次部署时写入，全部不可变；版本更新、回滚校验四者全部一致。
2. 明确 Fork 规则，二选一：
   - **推荐**：Fork 必须指向新的 `(agent, ors, account)`；同一账户不允许 Fork，因为 v1 一账户一 ORS；如果业务需要同账户多策略，只能在同一 ORS 上追加策略（不新增 ORS）。
   - 或者允许“同账户 Fork”但必须显式走：旧策略停止新开仓 → 撤单 → 平仓/归档 → 释放旧 ORS → 新 Agent/ORS 上线 → 验证旧 ORS 不再 ACTIVE；否则拒绝 409 `ACCOUNT_ORS_STILL_ACTIVE`。
3. §16 第 6 条改成“Fork 必须指向新的 Agent/ORS/账户组合；同一账户只能在同一 ORS 上新增策略，或旧 ORS 释放后再建新 ORS，不得并行”。
4. 验收：同账户 Fork 必须被拒绝并提示原因；版本更新改账户/柜台/ORS 必须 409 `STRATEGY_BOUND_CONTEXT`；Fork 新账户从 0 持仓/PnL 开始。

---

### 3.2 P0-04（PARTIAL）：SBE v2 只列字段名，没有冻结字段 ID/类型/版本，且缺 `routeId/orderEpoch`

**设计稿位置**：§8.3、§8.5、§13、§14 Phase 6、§17 P0-04。

**问题**：
- §8.5 写了“v2 增加字段”，但没有：
  - 字段 ID、类型、长度、是否 optional；
  - SBE schema 版本号/兼容策略（旧 v1 消息如何拒绝/迁移）；
  - `bookId` 与 `strategyId`、`strategyKey` 三者的唯一语义；`OrderRequest` 同时有 `bookId`、`strategyId`，SBE v2 又写 `strategyKey`，实现者会各选一个；
  - `strategyId(int32)` 与字符串策略 ID 的映射表；
  - `OrderUpdate/Trade` 的 `routeId/orderEpoch` 字段。
- §8.3 明确要求回报匹配 `routeId/orderEpoch`，但 §8.5 的 `OrderUpdate/Trade` 字段清单没有 `routeId/orderEpoch`；两节直接矛盾。
- §14 把 SBE 升级放在 Phase 6，但 Phase 2 已经“成交归因”；归因所需的字段在 Phase 2 还没有。
- 正文说“旧协议回报进入兼容队列”，但没有说明兼容队列的消费者、存储、过期、人工处理；如果没有，旧回报会永远堆着或丢失。

**交易员影响**：
- 不同服务（控制面/ORS/Adapter）对 `bookId/strategyId/strategyKey` 理解不一致，成交可能归到错误策略。
- Phase 2 的策略 PnL 可能没有可靠的 CTP 成交归属，只是本地推断。
- 旧回报兼容队列无人处理，盘中查不到成交。

**修改建议**：
1. 冻结 SBE v2 XML：字段 ID/类型/长度/optional、schema version、兼容矩阵；明确 `bookId` 是唯一业务键，`strategyKey` 为兼容别名，`strategyId int32` 只读旧字段。
2. `OrderUpdate/Trade` 增加 `routeId/orderEpoch`、`requestId`、`sequence`；`OrderRequest` 增加 `bookId/deploymentId/deploymentGeneration/accountId/counterpartyId/exchange/orsId/fencingToken`。
3. 明确 CTP `OrderRef/OrderSysID` → `clientOrderId` → `bookId/strategyId` 的映射持久化表；未知回报进 `UNASSIGNED` 队列，队列有消费者和超时告警。
4. 把 SBE 升级和归属映射前移到 Phase 1/2；Phase 6 只做多柜台运维，不再承担归属字段升级。
5. 验收：同一账户两策略同合约成交分别落 A/B；旧 v1 消息被拒绝/进兼容队列；`routeId/orderEpoch` 不匹配的回报被 `STALE_UPDATE`。

---

### 3.3 P0-06（PARTIAL）：权限正文有原则，但 enforcement 在 Phase 6，Phase 2/3 先暴露数据

**设计稿位置**：§12、§14 Phase 1/6、§17 P0-06。

**问题**：
- §12 已写唯一键、默认拒绝、403、`AuthorizationService.require(user, accountId, VIEW|TRADE|CANCEL|EMERGENCY)`，比上一版好。
- 但 §14 把“账户级授权 enforcement”放在 **Phase 6**；Phase 1 只“建立账户级权限表和默认拒绝”，Phase 2/3 就先上策略持仓/PnL/策略界面。表存在不等于接口拒绝；Phase 2/3 期间任何登录用户仍可能看到所有账户策略。
- §12 的 `require` 没有 `ADMIN` action；§17 说 ADMIN 默认无交易权，但正文没有这条。
- 没有权限版本/会话失效机制；权限被收回后已打开页面仍可提交，正文只在 §17 提“权限版本变化使旧页面失效”。
- 没有服务端测试矩阵（VIEWER/TRADER/ADMIN/跨账户/手工簿）。

**交易员影响**：
- Phase 2/3 试点期间，交易员能看到/操作不该看的账户策略；手工单可能下到别人账户。
- 权限收回后旧页面仍能提交，事后审计看不出授权状态。

**修改建议**：
1. 把 enforcement 前移到 Phase 1/2：建表同时上线 `AuthorizationService`，所有读接口和下单接口走同一检查；Phase 6 只做运维 UI/多柜台扩展。
2. §12 补 `ADMIN` action 和“ADMIN 默认无交易权”；补 `permission_version`/会话失效。
3. 手工单只接受 `bookId/accountId`，服务端解析 counterparty；策略单只接受 `strategyId/deploymentId/generation`，服务端解析 account/counterparty/ORS，客户端字段只做一致性校验。
4. 验收矩阵：VIEWER 只看授权；TRADER 只能交易授权账户；ADMIN 默认无交易权；越权 403 + 审计；权限变更后旧页面提交 403。

---

### 3.4 P0-07（PARTIAL）：正文“账户/全局只在运维页”与 §17“任何页可开应急抽屉”冲突

**设计稿位置**：§4.1、§11.1、§11.2、§17 P0-07。

**问题**：
- §11.2 明确“账户/全部柜台操作只放在运维页面”；§17 P0-07 又说“订单/成交/总持仓/监控页没有当前策略时只能打开应急抽屉并显式选范围”。两个入口不一致。
- 正文没有定义 `currentStrategyId` 在非策略详情页如何确定；订单页、成交页、总持仓页没有“当前策略”，§11.1 的“默认当前策略”无法执行。
- 手工簿当前时点的动作已改为“撤单/平仓/只减仓”（§3.7），但 §11.1 仍写“停止策略/平掉该策略持仓”，没有区分手工簿。
- 顶栏已移除全局应急（§4.1），但 §11.2 的“全局停全部/全撤/只减仓”在运维页；需要明确从事务页面如何快速到达，不能盘中找不到。

**交易员影响**：
- 在订单页发现异常，不知道点哪里；按 §11.2 要跳运维页，按 §17 有抽屉，行为不确定。
- 在非策略详情页误以为“当前策略”是刚才看的策略，实际可能是空/默认策略。
- 手工簿显示“停止策略”但没有策略可停。

**修改建议**：
1. 二选一并写死：
   - **方案 A（推荐）**：全局只保留运维页“应急中心”；顶栏只放入口链接，不直接执行；策略详情页有当前策略快捷动作。
   - **方案 B**：任何页面可打开应急抽屉，但必须先显式选择策略/账户/全部，不允许“默认当前策略”猜测。
2. 定义 `currentStrategyId`：仅策略详情/策略 Tab 设置；其他页面显示“未选择策略”，应急动作要求显式选。
3. 手工簿动作单独分支：撤单/平仓/只减仓，不显示停止策略。
4. 验收：在订单页打开应急，必须出现范围选择；策略详情点只减仓只影响当前策略；手工簿不出现“停止策略”。

---

### 3.5 P0-08（PARTIAL）：Phase 2 成交归因早于 Phase 6 SBE，Phase 3 UI 早于 Phase 5 绑定/版本实现

**设计稿位置**：§14 Phase 1~6、§17 P0-08、§15。

**问题**：
- Phase 1：数据模型 + 行情键 + 账户权限表。
- Phase 2：策略持仓、**成交归因**、策略 PnL、账户 PnL 快照、策略平仓、对账差异。
- Phase 3：策略列表/详情、移除顶部选择器、**策略绑定 Agent、版本历史、Fork 入口**。
- Phase 5：`bound_agent_id` 不可变、编辑生成版本、Fork、部署 generation/drain/rollback/审批。
- Phase 6：**账户级授权 enforcement**、**CTP/SBE 归属字段升级**、多柜台运维。

矛盾：
1. Phase 2 的“成交归因”需要 Phase 6 的 SBE 字段；没有 SBE，成交无法可靠带 `bookId/strategyId`。
2. Phase 3 的“绑定 Agent/版本历史/Fork 入口”在 Phase 5 才实现；UI 先上会暴露未实现按钮。
3. Phase 2/3 的策略/订单/账户数据在 Phase 6 权限 enforcement 之前暴露；试点期数据隔离不成立。
4. Phase 1 说“先建立账户级权限表和默认拒绝”，但没有 enforcement；表/default deny 不等于接口 403。
5. Phase 2 策略 PnL 依赖 Phase 1 行情键，这是好的；但 Phase 2 成交归因/策略持仓在没有 SBE 时只能用本地订单映射，不能宣称“策略持仓已与 CTP 一致”（§8.5 也承认“协议升级前 strategy_positions=本地归因账”）。

**交易员影响**：
- Phase 2 上策略 PnL 后，交易员看到的是“本地归因 PnL”，却可能被当成账户/策略权威 PnL；错账窗口。
- Phase 3 先移除顶部选择器，Phase 5 才实现绑定/版本/Fork；一旦部署/版本更新，UI 行为与后端不一致。
- Phase 2/3 无权限 enforcement，所有登录用户可见所有账户策略。

**修改建议**：
1. 调整 Phase：
   - Phase 1：数据模型 + SBE v2 归属 + CTP 映射 + 行情键 + 权限 enforcement。
   - Phase 2：策略持仓/成交归因/PnL + 策略平仓 + 对账。
   - Phase 3：策略 UI + 绑定/版本/Fork 后端 + 移除顶部选择器（同一阶段完成，不拆到 Phase 5）。
   - Phase 4：账户汇总/手工簿/未分配。
   - Phase 5：多柜台运维/监控/审计。
2. 如果必须分阶段，Phase 2 的策略 PnL 标记“LOCAL_ATTRIBUTION”，不能显示为权威；§15 验收加“Phase 2 前 SBE 归属完成”。
3. Phase 3 不要先移除顶部选择器，除非 Phase 3 同时完成策略列表/详情所有过滤；否则用户会再次看到“页面没变化”。
4. 每个 Phase 有 feature flag/回滚；Phase 2 未完成 SBE/权限时，不允许进入策略 PnL 页面。

---

### 3.6 P0-09（PARTIAL）：`routeId/orderEpoch` 在 §8.3 必填，§8.5 SBE 清单却没有

**设计稿位置**：§7.1、§7.2、§8.3、§8.5、§17 P0-09。

**问题**：
- §7.1/§7.2 已补 `ors_id/fencing_token/route_id/order_epoch/last_update_ors_id`，方向正确。
- §8.3 要求回报匹配 `deploymentGeneration + orsId + fencingToken + routeId + orderEpoch`；但 §8.5 的 `OrderUpdate/Trade` 字段清单只列 `bookId/strategyId/deploymentId/deploymentGeneration/accountId/counterpartyId/exchange/orsId/fencingToken/requestId`，没有 `routeId/orderEpoch`。
- 订单表有 `last_update_ors_id`，但没有 `last_update_fencing_token`；§17 P0-09 也没有写最后接受的 fencingToken。旧 ORS 同 generation 时，仍可能用旧 fencingToken 通过校验。
- `FENCED` 状态只写在 §8.3；`ors_instances.status` 的状态集/迁移/查询没有定义。
- `FILLED → CANCELED` 禁止，但人工调整的审计/权限/恢复流程没有定义。

**交易员影响**：
- 旧 ORS 的撤单/成交仍可能覆盖新状态；策略持仓/PnL 按错误状态更新。
- 交易员看到“已撤”但实际成交，重复下单；或看到“已成交”但实际被撤。

**修改建议**：
1. §8.5 的 `OrderUpdate/Trade` 补 `routeId/orderEpoch`；`orders` 补 `last_update_fencing_token`；`trades` 补 `last_update_fencing_token`/`order_epoch`。
2. 消费端校验顺序：`deploymentGeneration → orsId → fencingToken → routeId → orderEpoch`；任一不匹配 `STALE_UPDATE`。
3. `ors_instances` 增加 `FENCED` 状态及迁移；FENCED 的 ORS 不再消费回报；新 ORS 查柜台确认未完成订单。
4. 人工调整状态必须 `ADMIN + 原因 + 审计`，不能直接改库。
5. 验收：同一 generation 下旧 ORS 发 CANCELED、新 ORS FILLED，保持 FILLED；旧 sequence 归零不丢新更新；FENCED ORS 回报不落库。

---

### 3.7 P0-05（PARTIAL）：`Book` 只有元数据，没有手工簿/未分配持仓账本

**设计稿位置**：§3.7、§3.8、§5.1、§5.3、§7.3、§17 P0-05。

**问题**：
- §3.7 定义了 `Book` 元数据（`book_id/book_type/account/counterparty/owner/display_name/status`），并说“手工簿持仓单独统计”；但 §5.1 的 `strategy_positions` 明确只统计 `book_type=STRATEGY`，全文没有 `book_positions` / `manual_positions` / `unassigned_positions` 表。
- §3.8/§5.3 的 `manual_book_position`、`unassigned_position` 没有数据来源；手工成交后如何更新今昨仓/均价/realized/fees 未定义；`position_assignment` 只在 §17 提到。
- 手工簿的“平仓/只减仓”动作需要一份可读的持仓账本；没有表就只能从 `account_positions` 反推，无法知道哪一部分是手工簿、哪一部分是 UNASSIGNED。
- `Account positions` 是柜台快照，不能替代手工簿 attribution；否则又回到“账户级汇总当策略账”的问题。

**交易员影响**：
- 手工单成交后，手工簿 PnL/持仓无法计算，或只能按账户总仓估算；手工簿平仓可能平错策略/未分配仓。
- `unassigned` 只是一个数字，没有明细，无法认领；手工簿和策略 PnL 继续混。
- 收盘/对账时无法解释“账户多出来的 1 手”是手工簿还是 UNASSIGNED。

**修改建议**：
1. 新增 `book_positions`（或 `position_ledger`）：
   `book_id / book_type / position_epoch / account_id / counterparty_id / exchange / instrument_id / today_long/today_short/yesterday_long/yesterday_short / avg_price / realized_pnl / fees / source / as_of / stale`。
2. `strategy_positions` 可以只存 `book_type=STRATEGY`，但 `manual_book_position` 必须从 `book_positions where book_type=MANUAL` 取；`UNASSIGNED` 从 `book_type=UNASSIGNED` 取；三者不重复。
3. 手工成交按 `book_id` 更新 `book_positions`；`position_assignment` 认领时从 `UNASSIGNED` 转入 MANUAL/STRATEGY，并写审计。
4. 手工簿平仓/只减仓读取 `book_positions`，不要用 `account_positions` 反推；`book_positions` 与账户快照做对账。
5. 验收：手工单成交后 `book_positions` 有今昨/均价/PnL；账户多 1 手时 `UNASSIGNED` 有明细；手工簿平仓只减手工簿；策略/手工/未分配汇总等于账户快照 + diff。

---

## 4. P1 未关闭项

> P1-01、P1-03、P1-15 已 CLOSED，不在此表重复。以下按主题分组，ID 均来自上一轮评审。

### 4.1 P1-02 + P1-11：手工单/API 合同仍不完整

| 项 | 问题 | 交易员影响 | 具体修改建议 |
|---|---|---|---|
| P1-02 | §10.3 有 env/book/contextVersion/preview 失效，但正文没有“默认上次账户”、`accountVersion`、确认框方向/价格/数量/名义/保证金/偏离；这些只在 §17 | 多账户手工单选错账户；确认框信息不足，乌龙指 | 正文补默认账户规则（上次使用+显式标签/可清空）；preview 绑定 `accountId/bookId/exchange/instrument/side/offset/price/qty/accountVersion`；确认框补全方向/价格/数量/名义/保证金/可用/偏离/环境 |
| P1-11 | §13 只有 `previewId`；缺 `clientRequestId`、`previewVersion`、`orderType`、`reduceOnly`、`/books/{id}/orders`、分页；这些只在 §17 | 双击/超时重试重复下单；手工簿下单无端点；策略/手工单合同不一致 | 统一订单合同：`bookId/strategyId/deploymentId/generation/previewId/previewVersion/clientRequestId`；服务端按 `clientRequestId` 幂等；补手工簿/未分配/版本/部署端点；统一分页/错误码 |

### 4.2 P1-04 + P1-05 + P1-06 + P1-14：共享账户资金/PnL/未分配/上下文

| 项 | 问题 | 交易员影响 | 具体修改建议 |
|---|---|---|---|
| P1-04 | §6.3 只说账户权威、策略风险预算；没有 `strategy_risk_budget` 字段、下单校验、详情展示（§17 才有） | 两个策略都以为有全额可用，同时开仓导致账户保证金超限 | 加 `strategy_risk_budget`/`estimated_margin`；下单同时校验账户级+策略级；策略详情显示账户可用/已占用/本策略估算 |
| P1-05 | §6.2 仍 `≈`；`account_pnl_snapshot` 字段/基准/容差只在 §17/§18 | 账户 PnL 与策略 PnL 永远对不上，无法判断是策略亏还是出入金/手续费 | 正文补 `account_pnl_snapshot(trading_day/as_of/equity/cash/deposit/withdraw/realized/unrealized/fees/source)`；定义上一结算日基准；差异 `diff/tolerance/stale/last_success`；阈值按 §18 |
| P1-06 | §5.3 说提供认领，§13 有 `/unassigned`/`claim`；没有 `unassigned_trade/position_assignment` 表、页面、SLA、阻断（§17 才有） | 外部成交/历史遗留永远躺着；策略风险低估；没人知道认领到哪 | 建表+未分配页面+认领审计；未认领超阈值告警；重大差异阻止该账户新开仓；外部成交不得自动归策略 |
| P1-14 | §4.4/§10.1 没有“账户上下文”卡片；只在 §17 | 看策略详情以为风险小，实际同账户其他策略已用满保证金 | 详情加账户权益/可用/保证金/风险度/同账户策略数/合计持仓/PnL/本策略估算/账户 PnL 差异；只读 |

### 4.3 P1-07 + P1-08 + P1-09 + P1-17：生命周期/持仓/状态/约束

| 项 | 问题 | 交易员影响 | 具体修改建议 |
|---|---|---|---|
| P1-07 | §10.6/§14 Phase 5 有更新/Fork/历史；状态机 `VALIDATED → DEPLOYING → ...`、drain/审批/回滚只在 §17 | 部署失败无回滚；盘中部署留下孤儿单；版本更新旧仓无人管 | 正文补状态机、版本/config hash、部署前 cancel→drain→reconcile→release→bind→deploy、失败回滚、LIVE/ACTIVE 审批、盘中部署二次确认 |
| P1-08 | §3.5/§5.1 有 `position_epoch`/归属键；唯一键、`realized_pnl/fees` 事务同步、日终 today→yesterday 只在 §17 | 跨交易所/重新部署重复行；策略 PnL 缺手续费/已实现；第二天平今/平昨被拒 | 正文写唯一键 `(book_id, position_epoch, account_id, exchange, instrument_id)`；成交事务同步数量/均价/realized/fees；日终结算；期权到期/行权；迁移查重 |
| P1-09 | §4.3 仍只有“状态”一列；§17 才拆 `book_type/deployment_status/strategy_status` | `MANUAL`/`ACTIVE`/`FAILED` 混读，误以为手工簿在跑或策略已运行 | 正文列表拆三列；手工簿显示“手工簿”；默认只显示 `book_type=STRATEGY`；手工簿单独分组 |
| P1-17 | §17 有 `accounts.counterparty_id UNIQUE`、部分唯一索引、启动检查；正文 §3.3/§3.4 未写 | 两账户同柜台/两 ACTIVE 部署；账户改柜台后旧 ORS 还在跑 | 正文补约束、迁移校验、运行中禁止改柜台、启动 invariants、并发部署乐观锁；验收重复提交/旧进程 |

### 4.4 P1-10 + P1-12 + P1-13 + P1-16：Blotter/审计/PnL 口径/迁移

| 项 | 问题 | 交易员影响 | 具体修改建议 |
|---|---|---|---|
| P1-10 | §10.5 仍“全部授权策略”；§17 才写今日未完成+今日成交、URL 带 strategyId、分页/排序/CSV | 从策略详情跳订单页丢失上下文；大量订单卡；复盘不能导出 | 正文改默认“今日未完成 + 今日成交”；详情跳转带 strategyId；统一分页/排序/列配置/CSV；显示 asOf/stale |
| P1-12 | §12 只有字段；§17 才列 `BOOK_ASSIGN/STRATEGY_FORK/...` 事件 | 持仓/PnL 差异无法追；不知道谁认领/迁移/拒绝 | 正文写结构化审计事件+字段（user/book/strategy/deployment/account/counterparty/exchange/requestId/before/after/reason）；审计页按账户/策略/柜台过滤 |
| P1-13 | §6.1 只有公式；FIFO、手续费、mark source、Greeks/IV 只在 §17 | 策略/账户 PnL 口径不一致；期权风险看不全 | 正文定义 FIFO（与柜台差异标注）、逐笔手续费、`mark_source LAST/SETTLEMENT/THEORETICAL`+asOf、期权乘数/到期/Greeks/IV 分组 |
| P1-16 | §14 Phase 1 有字段/行情键；缺手工单回填、trades 按 client_order_id 回填、旧 strategy_positions 去重、旧 SBE 兼容细节（§17 才有） | 升级后历史订单/成交无归属；策略 PnL 从 0；旧仓重复/丢失 | 正文补迁移脚本+校验：orders/trades 无归属=0、strategy_positions 去重、positions→account_positions、旧 SBE 双写/版本兼容、失败进 UNASSIGNED |

---

## 5. P2 未关闭项

| ID | 问题 | 交易员影响 | 具体修改建议 |
|---|---|---|---|
| P2-01 | 策略列表 PnL 正文没有 `asOf/source/stale`；只在 §17 | 不知道 PnL 是实时/延迟/昨日 | 正文列表 PnL 带 asOf/source/stale；陈旧置灰 |
| P2-02 | §4.3 仍一个“状态”列；§17 才说统一中文/颜色只用于 deployment | 中英混读，误判 | 正文拆状态列/统一中文+英文 tooltip；颜色只用于 deployment |
| P2-03 | §4.4 仍 8 个 Tab；§17 才说默认概览/折叠/记住 | 盘中找不到订单/持仓 | 正文默认概览只保留 PnL/持仓/风险/对账；订单/成交/日志折叠；记住上次 Tab |
| P2-04 | §4.3 无收藏/最近；§17 才写 | 多策略每次搜索 | 正文加收藏/最近/固定；URL 可分享 |
| P2-07 | §10.2 只“展开到策略”；§17 才写展开到持仓/未分配/订单 | 看到差异无法定位 | 正文账户行可展开策略/持仓/未分配/订单；带过滤跳转 |
| P2-08 | §5.3 有未分配概念；无 badge/阈值颜色（§17 才写） | 不知道多少未归属 | 顶栏/导航 badge；超数量/金额转红 |
| P2-09 | §13 API 仍是草案，无分页/错误码/OpenAPI；§17 才写 | 后期兼容/客户端不一致 | 正文统一 `/api/v1` 分页/错误码/OpenAPI；详情端点版本兼容 |
| P2-10 | 正文无导出/列配置；§17 才写 | 复盘/合规只能截图 | 正文支持 CSV/PDF、列配置、保存视图 |

---

## 6. 正文与 §17 矩阵的矛盾清单

以下是必须在实现前消除的“正文/矩阵不一致”，否则实现者会按不同章节做出不同系统：

| 编号 | 矛盾 | 位置 | 影响 |
|---|---|---|---|
| C-01 | 应急入口：正文说账户/全局“只放在运维页”，§17 说订单/成交/总持仓/监控页可打开应急抽屉 | §11.2 vs §17 P0-07 | 交易员不知道盘中从哪里止损；实现者可能两边都做或都不做 |
| C-02 | SBE 回报字段：§8.3 要求 `routeId/orderEpoch`，§8.5 的 `OrderUpdate/Trade` 清单没有 | §8.3 vs §8.5 | 旧 ORS/路由校验无法实现 |
| C-03 | Fork：§16 说“必须新 Agent、可以同一账户”，v1 是一账户一 ORS；旧 ORS 未释放时同账户 Fork 没有合法 ORS | §16 第 6 条 vs §2 业务约束 2 | 同账户 Fork 可能破坏一账户一 ORS，或直接 409 |
| C-04 | 绑定：§3.4 只绑 `bound_agent_id`，但 §3.3 要“一个策略一个账户/柜台/ORS” | §3.4 vs §2 业务约束 4 | 版本更新可换账户/柜台/ORS，实际迁移 |
| C-05 | Phase 2 成交归因 vs Phase 6 SBE 升级 | §14 Phase 2 vs Phase 6 | Phase 2 没有可靠成交归属，策略 PnL 可能是本地推断 |
| C-06 | Phase 2/3 数据暴露 vs Phase 6 权限 enforcement | §14 Phase 1/6 | 试点期所有登录用户可见所有账户数据 |
| C-07 | Phase 3 绑定/版本/Fork 入口 vs Phase 5 实现 | §14 Phase 3 vs Phase 5 | UI 先上，后端未实现 |
| C-08 | §10.5 默认“全部授权策略” vs §17 “今日未完成+今日成交” | §10.5 vs §17 P1-10 | 订单页默认行为不一致 |
| C-09 | §13 订单 JSON 缺 `clientRequestId/orderType/reduceOnly/previewVersion`，§17 说已统一 | §13 vs §17 P1-11 | 幂等/订单类型/预检版本无法实现 |
| C-10 | §12 只有字段无审计事件；§17 说事件清单 | §12 vs §17 P1-12 | 审计无法落地 |
| C-11 | §6.2 仍 `≈` 无快照；§17/§18 才有 `account_pnl_snapshot`/阈值 | §6.2 vs §17 P1-05/§18 | 账户 PnL 对账无口径 |
| C-12 | §4.3 仍一个“状态”列，§17 说拆三列 | §4.3 vs §17 P1-09 | 手工簿/策略/部署状态混读 |
| C-13 | §15 验收“策略持仓+手工簿+未分配=账户持仓”仍像配平等式；§3.8 说未分配是差额 | §15 vs §3.8 | 实现者可能把 unassigned 当配平项 |
| C-14 | §8.5 重复句“不能直接更新策略持仓，不能直接更新策略持仓” | §8.5 | 文本错误，需清理 |

---

## 7. 交易员仍需确认的配置参数

以下只列真正需要业务确认、且会改变模型/验收的项；纯 UI 文案不列。

1. **账户 PnL 对账阈值**：默认 `max(100 CNY, 0.1% equity)`、连续 2 次告警；超过阈值且快照 `age > 5s` 阻止新开仓。这个阈值是否符合 au/ag 日内波动和账户规模？
2. **UNASSIGNED 阈值**：数量 > 0 持续 60s 告警；重大差异按金额/手数配置。重大差异是否要阻止该账户新开仓？阈值定多少？
3. **LIVE 启用**：v1 默认禁用；启用需四眼审批 + 红色确认。是否接受“默认禁用”，还是先只允许 SHADOW 策略？
4. **版本更新默认动作**：默认“停止新开仓→撤单→平仓→对账→更新”；携带持仓升级需二次确认+原因。默认平仓是否符合做市/对冲策略的日常升级习惯？
5. **策略 PnL 已实现口径**：§17 选 FIFO；柜台结算可能用加权平均/逐笔。交易员是否接受 FIFO 与柜台差异显式标注，还是要求与柜台完全一致？
6. **未实现 mark source**：`LAST / SETTLEMENT / THEORETICAL` 可配；默认用哪个？期权做市是否默认 THEORETICAL，期货是否默认 LAST/SETTLEMENT？
7. **手工簿粒度**：一账户一个 `MANUAL-<account>`，还是按交易员/子策略拆多个？是否需要按 `created_by` 分摊 PnL？
8. **Fork 同账户**：§16 允许“Fork 可以落在同一账户”，但 v1 一账户一 ORS；请确认是“同账户只能同 ORS 追加策略”，还是放宽一账户多 ORS？这决定 Fork 是否合法。
9. **共享账户风险预算**：策略只做“风险预算/估算占用”，还是需要硬性 per-strategy 保证金上限？如果 A 用满，B 是否必须被拒绝开仓？

---

## 8. 最小可实施路径（建议）

| 顺序 | 动作 | 完成标志 | 对应项 |
|---|---|---|---|
| 1 | 冻结策略身份：`bound_agent/account/counterparty/ors` + Fork 规则 | 同账户 Fork 的无解路径被明确禁止/放宽；版本更新不能换账户/柜台/ORS | P0-03、C-03/C-04 |
| 2 | 冻结 SBE v2：字段 ID/类型/版本/`routeId/orderEpoch`/映射表 | 两策略同合约成分别归属；旧 v1 消息进兼容队列 | P0-04、P0-09、C-02 |
| 3 | 前移权限 enforcement + SBE 归属到 Phase 1/2 | 权限矩阵通过；Phase 2 不再用本地推断冒充 CTP 归属 | P0-06、P0-08、C-05/C-06 |
| 4 | 正文补齐账户 PnL/未分配/持仓主键/PnL 口径/迁移 | §17 的决定在正文可执行；无“只在矩阵” | P1-05/06/08/13/16、C-11 |
| 5 | 统一应急入口/currentStrategyId | 订单页/策略详情/手工簿的应急范围一致 | P0-07、C-01 |
| 6 | 正文补齐 P1/P2 交互默认值 | 订单页默认、状态列、Tab、导出、审计事件与 §17 一致 | P1-02/09/10/11/12/14、P2 |

**允许进入实现的判定**：第 1~3 项完成后，可进入“Phase 1 数据模型 + SBE 契约 + 权限 enforcement”的实现；在第 1~3 项完成前，不能写生产迁移、不能移除顶部选择器、不能上线策略 PnL 页面。

---

## 9. 附录：本轮引用的关键证据

1. `docs/architecture/23-策略中心V2设计稿.md` §3.4/§3.5/§3.6：`bound_agent_id` 是唯一不可变绑定；§16 第 6 条“Fork 必须新 Agent、可以同一账户”与 §2 业务约束 2“一账户一 ORS”冲突。
2. §8.3 vs §8.5：§8.3 要求 `routeId/orderEpoch` 回报校验，§8.5 的 `OrderUpdate/Trade` 字段清单没有这两个字段。
3. §14 Phase 2 的“成交归因”早于 Phase 6 的“CTP/SBE 归属字段升级”；§8.5 也承认协议升级前 `strategy_positions` 只是本地归因账。
4. §14 Phase 3 的“绑定 Agent/版本历史/Fork 入口”早于 Phase 5 的“bound_agent_id 不可变/版本/Fork”实现。
5. §14 Phase 1 只建“账户级权限表和默认拒绝”，Phase 6 才“账户级授权 enforcement”；Phase 2/3 先暴露数据。
6. §11.2 正文“账户/全局只放在运维页” vs §17 P0-07“订单/成交/总持仓/监控页可打开应急抽屉”。
7. §10.5 正文“订单/成交默认全部授权策略” vs §17 P1-10“今日未完成 + 今日成交”。
8. §13 订单 JSON 只有 `previewId`，缺 `clientRequestId/orderType/reduceOnly/previewVersion`；§17 P1-11 声称已统一。
9. §6.2 正文仍 `≈` 且无 `account_pnl_snapshot`；§17 P1-05/§18 才有快照字段和阈值。
10. §4.3 正文仍一个“状态”列；§17 P1-09 声称拆成三列。
11. 现有 `abi/sbe/quantlink-fin-sbe.xml`：`MarketData` 无 `counterpartyId/exchange`；`OrderUpdate/Trade` 无策略/部署/账户/柜台/交易所；`OrderRequest.strategyId` 为 int32；`PositionSnapshot` 无 `exchange`。V2.1 §8.5 是正确的方向，但还没有字段 ID/类型/版本。
12. 现有 `StrategyCloseoutScheduler` 遍历 `strategy_positions` 中除 `futures_pair` 外的所有策略；V2.1 §3.7 已把手工簿移出 `strategy_positions`，这一点已修好。
13. 现有 `EmergencyController.flattenStrategy` 要求策略有 deployment/ORS；V2.1 §3.7 手工簿专用动作已避免该路径，但正文 §11.1 仍写“停止策略/平掉该策略持仓”，需要按 book_type 分支（见 P0-07）。

---

*本评审只针对设计稿，不修改源代码或设计稿。V2.1 的主干可以保留；请先关闭 P0-03/04/05/06/07/08/09 与正文/矩阵矛盾，再进入 Phase 1 实现。*

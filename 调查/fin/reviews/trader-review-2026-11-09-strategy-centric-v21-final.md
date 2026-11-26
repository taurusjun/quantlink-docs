# 交易员最终闭环复审：策略中心 V2.1

- 日期：2026-11-09
- 评审对象：`docs/architecture/23-策略中心V2设计稿.md`（V2.1 DRAFT）
- 复审基线：`docs/reviews/trader-review-2026-11-09-strategy-centric-v2.md`、`docs/reviews/trader-review-2026-11-09-strategy-centric-v21.md`
- 评审视角：期货/期权交易员（SHFE au/ag，做市 + 方向 + 对冲），兼交易系统评审
- 结论：**REQUEST_CHANGES**
- 统计：**P0 9 CLOSED / 1 PARTIAL / 0 OPEN；P1 15 CLOSED / 2 PARTIAL / 0 OPEN；P2 10 CLOSED / 0 PARTIAL / 0 OPEN**

> V2.1 已经把上一轮绝大多数问题真正写进正文：`Book + book_positions`、四元绑定、SBE v2 字段表、账户 PnL 快照、未分配认领、Phase 1 权限 enforcement、行情键、旧 ORS/FENCED 都已经有可执行文本。方向可以定稿。
>
> 还剩一个 P0 和两个 P1。P0-03 是“绑定四元组在 schema/校验中只落了 Agent”的落地缺口；P1-09 是状态枚举在正文两处不一致；P1-13 是策略 PnL 口径仍只在 §17 矩阵，正文 §6.1 不足。修完 P0-03 即可进入 Phase 1；P1-13 必须在 Phase 2 前补，P1-09 必须在 Phase 3 前补。

---

## 0. 复审口径

本轮按“正文可执行 + 正文与 §17 一致”判定，不把矩阵里的决定自动视为闭环：

| 状态 | 判定 |
|---|---|
| **CLOSED** | 正文有明确规则/字段/校验，且与 §17 不冲突，可直接排期实现 |
| **PARTIAL** | 正文缺字段、枚举、校验或与 §17/其他章节矛盾；可小范围补齐，但影响实现 |
| **OPEN** | 无规则或冲突到无法实现 |

---

## 1. 总裁决与 Phase 1 准入

### 1.1 结论

**REQUEST_CHANGES，不是 BLOCK。** V2.1 的主干、数据模型和阶段划分已经成立；剩下的是“落地前必须补的三处”：

1. **P0-03 绑定四元组**：正文 §3.3 写了 `bound_agent/account/counterparty/ors`，但 §3.4 的 `strategies` 表只列了 `bound_agent_id`；§3.4/§13 的校验只比较 Agent，不比较 account/counterparty/ORS。实现者可能只加一列，版本更新仍能换账户/ORS。
2. **P1-09 状态枚举**：§3.4 的 lifecycle 是 `DRAFT/BOUND/RUNNING/INACTIVE/FAILED/ARCHIVED`；§4.3 拆出的 `strategy_status` 是 `DRAFT/VALIDATED/ARCHIVED`，`deployment_status` 又是 `ACTIVE/INACTIVE/FAILED/STOPPING`。`BOUND/RUNNING` 没有落点，`VALIDATED` 不在 lifecycle，`INACTIVE/FAILED` 重复。
3. **P1-13 PnL 口径**：§6.1 只有 `realized + unrealized - fees`；FIFO、手续费分配、mark source、期权 Greeks/IV 只在 §17。正文不足以让 Phase 2 算出可对账的策略 PnL。

### 1.2 是否允许进入 Phase 1

**不允许直接进入 Phase 1。** 先修 P0-03，Phase 1 即可开工。最小条件：

- [ ] P0-03：补 `bound_account_id / bound_counterparty_id / bound_ors_id` 字段；服务端/DB 同时校验四元组；更新 §16 Fork 同账户规则；明确 `bound_ors_id` 是“逻辑 ORS 槽位”还是“进程实例”。
- [ ] P1-13：在 Phase 2 前把 FIFO/mark source/手续费/期权 Greeks 写进 §6.1 或独立小节；不能只留 §17。
- [ ] P1-09：在 Phase 3 前统一 lifecycle/deployment_status/strategy_status 三套枚举及映射；否则策略列表无法判断“运行中/已绑定/已验证”。

**结论：P0-03 修完即可进入 Phase 1；Phase 2 前补 P1-13；Phase 3 前补 P1-09。** P2 没有阻塞项，可随实现补齐。

---

## 2. P0 逐项状态

| ID | 状态 | 设计稿对应 | 结论 |
|---|---|---|---|
| P0-01 账户持仓权威/未分配 | **CLOSED** | §3.7、§3.8、§5.3、§6.4 | 账户快照权威；`book_positions` 分 MANUAL/UNASSIGNED；`unassigned = account - attributed`；`unassigned_trade`/`position_assignment` 有表；`source/as_of/stale` 有 |
| P0-02 策略平仓校验 | **CLOSED** | §3.9、§5.3 | 策略持仓优先、账户可平量取严格值；按策略今昨解析；行锁/版本；超平拒绝不 clamp |
| P0-03 策略迁移/绑定/Fork | **PARTIAL** | §3.3、§3.4、§3.6、§13、§16 | 四元组概念正确；但 `strategies` 表只列 `bound_agent_id`，校验只校验 Agent，§16 仍说 Fork 可同一账户，和 §3.4 新 Agent 必须新账户/柜台冲突（见 §5.1） |
| P0-04 CTP/SBE 归属 | **CLOSED** | §8.5、§14 Phase 1 | SBE v2 消息 ID/字段表/类型/兼容队列已有；`routeId/orderEpoch` 在公共字段表；CTP 映射持久化、未映射进 UNASSIGNED 已写 |
| P0-05 手工簿/未分配账本 | **CLOSED** | §3.7、§5.3、§7.1、§7.3 | `Book` + `book_positions` 分离；手工单 `book_id`+`strategy_id=null`；手工簿不进入策略列表/排名/自动收盘；未分配独立 |
| P0-06 账户级权限 | **CLOSED** | §12、§14 Phase 1 | `user_account_permission` 唯一键/default deny/403；`AuthorizationService` Phase 1 接入所有数据/下单；无权限 403；审计事件已列 |
| P0-07 应急范围/当前策略 | **CLOSED** | §4.1、§11.1、§11.2、§17 | 顶栏无全局应急；策略详情默认当前策略；订单/成交/总持仓/监控页不提供策略应急，只能跳策略详情/运维；账户/全局显式选择 |
| P0-08 Phase 顺序 | **CLOSED** | §14 Phase 1~6、§15 | Phase 1 数据/SBE/权限/行情键；Phase 2 成交归因/持仓/PnL；Phase 3 只读 UI 并移除顶部选择器；Phase 5 才版本/Fork；Phase 6 应急/多柜台。顺序允许分阶段上线 |
| P0-09 旧 ORS/fencing | **CLOSED** | §7.1、§7.2、§8.3、§8.5 | 订单/成交有 ors/fencing/route/order_epoch；订单有 `last_update_fencing_token`；回报校验 ORS+fencing+generation+route；FENCED；禁止非法状态回退 |
| P0-10 LIVE/SHADOW | **CLOSED** | §4.3、§4.4、§10.3、§10.4 | 列表/详情/确认/审计显示环境；LIVE 红色水印/二次确认；v1 默认禁用 LIVE；手工单确认有环境 |

**P0 统计：CLOSED 9（01、02、04、05、06、07、08、09、10），PARTIAL 1（03），OPEN 0。**

---

## 3. P1 逐项状态

| ID | 状态 | 设计稿对应 | 结论 |
|---|---|---|---|
| P1-01 交易所集合 | **CLOSED** | §4.3、§19.1 | 列表显示 `SHFE, SIM`/集合；筛选多选；详情按交易所分组 |
| P1-02 手工单默认/preview | **CLOSED** | §10.3 | 默认上次账户、显式展示/可清空；账户→柜台→交易所联动；preview 绑定 accountVersion；确认框补方向/价格/数量/名义/保证金/偏离/环境；无 preview 禁止提交 |
| P1-03 行情/期权链入口 | **CLOSED** | §4.2、§16 第 8 条 | 导航保留行情/期权链/手工交易；入口携带上下文 |
| P1-04 共享账户保证金/限额 | **CLOSED** | §6.3 | 账户保证金/可用权威；策略风险预算/估算；下单同时校验账户级/策略级；详情显示账户上下文 |
| P1-05 账户 PnL 快照 | **CLOSED** | §6.4、§18 | `account_pnl_snapshot` 字段、上一结算日基准、出入金/手续费、diff/tolerance/stale、阈值/阻止开仓已写 |
| P1-06 未分配认领 | **CLOSED** | §5.3、§13、§14 | `unassigned_trade`/`position_assignment`；认领到策略/手工簿；审计；60s 告警；重大差异阻止新开仓 |
| P1-07 部署生命周期/回滚 | **CLOSED** | §3.3、§10.6 | 状态机、cancel→drain→reconcile→release→bind→deploy、失败回滚、LIVE/ACTIVE 审批已写 |
| P1-08 策略持仓主键/结算 | **CLOSED** | §3.7、§5.1 | 唯一键 `(book_id, position_epoch, account_id, exchange, instrument_id)`；成交事务更新数量/均价/realized/fees；日终 today→yesterday；期权到期单独处理 |
| P1-09 状态枚举/三列 | **PARTIAL** | §3.4、§4.3 | 已拆 `book_type/deployment_status/strategy_status`；但 lifecycle 与三列枚举不一致：`BOUND/RUNNING` 无落点，`VALIDATED` 不在 lifecycle，`INACTIVE/FAILED` 重复（见 §5.2） |
| P1-10 订单/成交默认/分页 | **CLOSED** | §10.5 | 今日未完成+今日成交；策略详情带 strategyId；分页/排序/列配置/CSV；asOf/stale |
| P1-11 API 幂等/preview/端点 | **CLOSED** | §13 | `clientRequestId/previewVersion/orderType/reduceOnly`；`/books/{id}/orders`、`/unassigned`、版本/部署端点；统一错误码 |
| P1-12 审计事件 | **CLOSED** | §12 | `BOOK_ASSIGN/STRATEGY_FORK/DEPLOYMENT_CHANGE/PERMISSION_CHANGE/DENIED_TRADE/EMERGENCY_SCOPE/UNASSIGNED_ASSIGN/RECON_DIFF_ACK`；字段含 before/after/reason |
| P1-13 PnL 口径/期权 Greeks | **PARTIAL** | §6.1、§17 P1-13 | §6.1 只有公式；FIFO、手续费分配、mark source、期权乘数/到期/Greeks/IV 只在 §17；正文不足以实现可对账 PnL（见 §5.3） |
| P1-14 策略详情账户上下文 | **CLOSED** | §10.1、§6.3 | 权益/可用/保证金/风险度；同账户策略数量/合计持仓/PnL；本策略估算/账户 PnL 差异 |
| P1-15 系统健康按柜台/交易所 | **CLOSED** | §4.1、§10.4 | 顶栏健康可展开；策略详情显示所属柜台/交易所健康/数据龄；任一授权柜台 P0 故障转红 |
| P1-16 迁移脚本/SBE 版本 | **CLOSED** | §14 Phase 1 | 手工单回填 MANUAL book；trades 按 client_order_id 回填；旧 strategy_positions 去重补 epoch/exchange；positions 映射；旧 SBE 双写/兼容；迁移校验 |
| P1-17 DB 约束/1:1/单 ACTIVE | **CLOSED** | §14 Phase 1 | `accounts.counterparty_id UNIQUE`；`strategy_deployments(strategy_id) WHERE ACTIVE` 部分唯一索引；运行中禁止改柜台；启动 invariants；乐观锁 |

**P1 统计：CLOSED 15（01~08、10~12、14~17），PARTIAL 2（09、13），OPEN 0。**

---

## 4. P2 逐项状态

| ID | 状态 | 设计稿对应 | 结论 |
|---|---|---|---|
| P2-01 PnL `asOf/source/stale` | **CLOSED** | §19.1、§5.1/§5.2 | 所有 PnL 带 asOf/source/stale；陈旧置灰 |
| P2-02 状态中英/颜色 | **CLOSED** | §4.3、§19.1 | 状态中文 + 英文 tooltip；颜色只用于 deployment 状态 |
| P2-03 详情 Tab 收起 | **CLOSED** | §10.1、§19.2 | 默认概览只保留 PnL/持仓/风险/账户上下文/对账；订单/成交/日志折叠；记住 Tab |
| P2-04 收藏/最近 | **CLOSED** | §19.2 | 收藏/最近/固定；URL 可分享 |
| P2-05 `book_id` UUID | **CLOSED** | §3.7、§19.3 | `book_id` UUID；`MANUAL-<account>` 只做 display_name |
| P2-06 策略/手工簿/未分配分区 | **CLOSED** | §3.7、§4.3、§19.2 | 分区展示；手工簿不进策略排名；未分配置顶红色 |
| P2-07 账户汇总下钻 | **CLOSED** | §19.2 | 账户行展开策略/持仓/未分配/订单；带过滤跳转 |
| P2-08 UNASSIGNED badge | **CLOSED** | §19.3 | 顶栏/导航 badge；超阈值转红 |
| P2-09 API 规范 | **CLOSED** | §19.4 | `/api/v1`；分页二选一在实现时冻结；统一错误码；OpenAPI；详情兼容 |
| P2-10 导出/列配置 | **CLOSED** | §19.3 | CSV/PDF、列显示配置、保存视图 |

**P2 统计：CLOSED 10，PARTIAL 0，OPEN 0。**

---

## 5. 未关闭项详解

### 5.1 P0-03（PARTIAL）：`bound_*` 四元组在 schema/DB 校验/§16 Fork 规则上没有完全落地

**设计稿位置**：§3.3、§3.4、§3.6、§13、§16 第 6 条。

**问题**：
1. §3.3 写了 `bound_agent_id / bound_counterparty_id / bound_account_id / bound_ors_id` 四元组；但 §3.4 的 `strategies` 表只列了 `bound_agent_id`，另外三个字段没有出现在 schema 列表里。实现者可能只建一列。
2. §3.4 的数据库/服务端校验只写 `strategy_deployments.agent_id == strategies.bound_agent_id`；§13 部署接口也只校验 `bound_agent_id != request.agentId`。没有校验 `deployment.account_id == bound_account_id`、`counterparty_id == bound_counterparty_id`、`ors_id == bound_ors_id`。版本更新同 Agent 但仍可换 Account/ORS，形成事实迁移。
3. §3.4 明确“Fork 到另一个 Agent 必须使用另一个账户/柜台；同一账户的多个策略可以共享同一个 ORS”；但 §16 第 6 条仍写“Fork 必须指向新的 Agent；可以落在同一账户”。两处冲突：同一账户 + 新 Agent 在 v1 一账户一 ORS 下没有合法 ORS，除非旧 ORS 已释放；正文没有定义“归档/释放 ORS”的路径。
4. `bound_ors_id` 不可变与 ORS 重启/更换的关系没有定义：如果 ORS 进程重启但逻辑 ORS ID 不变，可以；如果换新 ORS ID，策略是否必须 Fork？如果 Agent 故障，策略如何继续？需要明确“逻辑 ORS 槽位”与“进程实例”的区别。
5. §3.6 Fork 说“可选择新的 Agent / 柜台 / 账户”，但没有同步写“新 Agent 必须新账户/柜台”“同一账户只能共享同一 ORS”的约束；实现者容易按自由组合做。

**交易员影响**：
- 版本更新后策略可能落到另一个账户/ORS，旧仓/PnL 留在旧账户，新策略在新账户开仓；交易员以为只是版本升级，实际是迁移。
- Fork 到同一账户可能因 ORS 冲突失败，或者绕过一账户一 ORS，出现两个 ORS 同时交易同一账户。
- ORS 重启/换实例时，`bound_ors_id` 不可变会让策略无法恢复；交易员只能 Fork，历史断裂。

**具体修改建议**：
1. `strategies` 表明确列出四个字段，并加数据库约束/服务端校验：
   - `bound_agent_id`、`bound_counterparty_id`、`bound_account_id`、`bound_ors_id` 首次部署写入，`NOT NULL` 后不可变；
   - `strategy_deployments` 的 `agent/counterparty/account/ors` 必须与四个 `bound_*` 完全一致；
   - 违反统一返回 `409 STRATEGY_BOUND_CONTEXT`（或拆分错误码）。
2. 把 §13 的部署校验从“只比较 Agent”改为“四元组逐项比较”；版本更新/回滚也走同一校验。
3. 统一 §16 第 6 条与 §3.4：
   - **推荐**：Fork 必须指向新的 `(Agent, ORS, Account, Counterparty)`；同一账户只能在同一 ORS 上新增策略，不得新建 ORS；同账户 Fork 必须拒绝，提示“同一账户共享同一 ORS，请在同一 ORS 上新增策略或先归档旧策略/释放 ORS”。
   - 或者明确“同账户 Fork 允许，但旧 ORS 必须先 flat/archive/release，再新 Agent/ORS”，加 `ACCOUNT_ORS_STILL_ACTIVE` 校验。
4. 定义 `bound_ors_id` 的语义：
   - 建议把它定义为“逻辑 ORS 槽位”，进程重启/重连不改变；换新槽位必须 Fork 或走显式 ORS 迁移（需单独设计，不在 v1）。
   - Agent/ORS 故障恢复用同一逻辑 ORS + 新 fencing generation，不改变 bound。
5. 验收用例：
   - 版本更新改 account/counterparty/ors 必须 409；
   - 同账户 Fork 在旧 ORS 仍 ACTIVE 时必须 409；
   - 旧策略归档/释放 ORS 后，同账户 Fork 或新策略可启动；
   - ORS 重启（同一逻辑 ID）后策略仍可恢复；换新 ORS ID 必须 Fork/迁移。

---

### 5.2 P1-09（PARTIAL）：lifecycle、deployment_status、strategy_status 三套枚举不一致

**设计稿位置**：§3.4 lifecycle、§4.3 列表三列、§17 P1-09。

**问题**：
- §3.4 lifecycle：`DRAFT / BOUND / RUNNING / INACTIVE / FAILED / ARCHIVED`。
- §4.3 列表拆成：
  - `book_type`：策略/手工簿/UNASSIGNED；
  - `deployment_status`：`ACTIVE / INACTIVE / FAILED / STOPPING`；
  - `strategy_status`：`DRAFT / VALIDATED / ARCHIVED`。
- 对照后：
  - `BOUND`、`RUNNING` 没有出现在三列中；
  - `VALIDATED` 不在 lifecycle；
  - `INACTIVE`、`FAILED` 同时出现在 deployment_status 和 lifecycle；
  - `strategy_status` 没有 `RUNNING`，交易员无法从列表判断“策略是否正在运行”。
- §10.6 又用“已部署策略/当前部署/当前版本/草稿版本”，状态口径仍然混。

**交易员影响**：
- 列表显示 `VALIDATED` 但策略可能已 BOUND/RUNNING；显示 `INACTIVE` 不知道是“部署未激活”还是“策略已停止”；手工簿/策略/部署状态混读。
- 误点“更新/停止/部署”操作；盘中无法快速判断策略是否在报价。

**具体修改建议**：
1. 冻结三套枚举及映射关系，不跨列复用：
   - `book_type`: `STRATEGY / MANUAL / UNASSIGNED`（对象类型，不是状态）。
   - `deployment_status`: `NONE / DEPLOYING / ACTIVE / STOPPING / INACTIVE / FAILED / ROLLED_BACK`（部署实例状态）。
   - `strategy_status`: `DRAFT / VALIDATED / ARCHIVED`（策略定义状态）。
   - `lifecycle` 作为内部派生/审计字段，建议废弃或映射到 `BOUND / RUNNING / INACTIVE / FAILED`，不再单独展示。
2. §4.3 列表明确“运行中”由 `deployment_status=ACTIVE` + `actual_state=RUNNING` 派生；不要新增第四个 `strategy_status=RUNNING`。
3. 画一张状态映射表：`DRAFT → VALIDATED → BOUND/DEPLOYING → ACTIVE/INACTIVE/FAILED → ARCHIVED`；前端只展示三列。
4. 验收：同一策略在草案/验证/部署中/运行/停止/失败/归档 7 个阶段，列表三列显示唯一且不矛盾；手工簿只显示 `book_type=MANUAL`，不显示 deployment/strategy 状态。

---

### 5.3 P1-13（PARTIAL）：策略 PnL 口径和期权 Greeks 只在 §17，正文 §6.1 不足

**设计稿位置**：§6.1、§6.4、§10.1、§17 P1-13。

**问题**：
- §6.1 只有 `realized + unrealized - fees`，没有定义：
  - 已实现盈亏用 FIFO、加权平均还是柜台逐笔；
  - 手续费按开/平仓如何分摊，如何与账户快照 `commission` 对齐；
  - 未实现用 `LAST/SETTLEMENT/THEORETICAL` 哪个，`asOf` 如何处理；
  - 期权乘数、到期、Greeks、IV、行权/交割；
  - `strategy_positions.realized_pnl/fees` 由成交事务更新，但 PnL 公式如何取数。
- §6.4 只写账户 PnL 快照；§10.1 只有“PnL 曲线/最大回撤/限额占用”；具体口径只在 §17。
- `book_positions` 没有 `realized_pnl/fees` 字段；手工簿 PnL 只能从 trades 推，正文没有写。
- 期权策略（V2 支持期权链）没有 Greeks/IV 的存储/展示/限额口径；策略详情“PnL/风险”无法回答 Delta/Gamma/Vega。

**交易员影响**：
- 策略 PnL 与柜台/账户 PnL 口径不一致；交易员不知道差异是手续费、结算价还是 FIFO/均价导致。
- 期权做市策略看不到 Greeks/IV，无法判断真实风险；策略 PnL 曲线不可用于复盘。
- 手工簿 PnL 可能只算成交、不算持仓浮盈，或手续费重复/漏算。

**具体修改建议**：
1. §6.1 增加“PnL 口径”小节：
   - 已实现：FIFO（与柜台差异显式标注）或与柜台一致的加权平均；冻结一种默认；
   - 手续费：按 `trades.fee` 逐笔计入，账户快照 `commission` 只用于对账；
   - 未实现：`mark_source=LAST/SETTLEMENT/THEORETICAL`，每个值带 `asOf/source`；
   - 账户 PnL 与策略 PnL 的差异项：手续费、结算价、出入金、未分配。
2. `book_positions` 增加 `realized_pnl/fees`，或明确手工簿 PnL 由 `book_id` 的 trades 实时汇总，并在页面显示“按成交口径”；不能两种口径混用。
3. 期权策略增加 `option_greeks`/`iv` 快照或实时计算字段；策略详情按标的/到期/交易所分组，显示 Delta/Gamma/Vega/Theta/IV 及 `asOf`。
4. §10.1 “PnL/风险”补：已实现/未实现/手续费/资金费四项、mark source、Greeks、限额占用、对账差异。
5. 验收：
   - 部分成交、平今/平昨、手续费、结算价切换的 PnL 与账户快照对账；
   - 期权策略 Greeks 与持仓/IV 变化一致；
   - 手工簿 PnL 不与策略/未分配重复。

---

## 6. 正文与矩阵的残余不一致（不阻塞 Phase 1，但应在 Phase 2/3 前清理）

| 编号 | 不一致 | 位置 | 建议 |
|---|---|---|---|
| R-01 | `OrderUpdate/Trade` 的 §8.5 字段清单没有 `routeId/orderEpoch`，但公共字段表有；实现者可能漏加 | §8.3/§8.5 | 在 §8.5 的 OrderUpdate/Trade 清单补 `routeId/orderEpoch`，或明确“公共字段表适用于所有 V2 消息” |
| R-02 | §12 `require` 只有 VIEW/TRADE/CANCEL/EMERGENCY，没有 `ADMIN`；§17 说 ADMIN 默认无交易权 | §12 vs §17 P0-06 | 在 §12 加 `ADMIN` 和“ADMIN 默认无交易权”，避免实现者把 ADMIN 当超级用户 |
| R-03 | §8.5 末尾“不能直接更新策略持仓”重复两次 | §8.5 | 删除重复句 |
| R-04 | §15 验收“策略持仓 + 手工簿 + 未分配 = 账户持仓”仍像配平等式 | §15 | 改成“attributed = 策略+手工；unassigned = 账户- attributed；差额必须等于 UNASSIGNED 账本”，避免实现者把 unassigned 当配平项 |
| R-05 | §3.4 `strategies` 表只列 `bound_agent_id`；§3.3 有四元组 | §3.3/§3.4 | 与 P0-03 一起补三个字段 |
| R-06 | `book_positions` 无 `realized_pnl/fees`，但 §6.2 要手工簿 PnL | §3.7/§6.2 | 与 P1-13 一起补或明确由 trades 汇总 |
| R-07 | `P2-09` 分页参数“page/size 或 limit/offset（实现时冻结一种）”还不是决定 | §19.4 | Phase 3 API 前冻结一种；不影响 Phase 1 |
| R-08 | `strategy_status=VALIDATED` 与 lifecycle 不一致 | §3.4/§4.3 | 与 P1-09 一起统一 |

---

## 7. 仍需业务确认的参数

以下只列真正需要业务确认、会影响策略行为/风控的项：

1. **Fork 同账户规则**：§3.4 说“新 Agent 必须新账户/柜台”，§16 说“可以同一账户”。请确认：同一账户只能共享同一 ORS，还是允许旧 ORS 释放后新建？这决定 Fork 按钮是否合法。
2. **账户 PnL 对账阈值**：默认 `max(100 CNY, 0.1% equity)`、连续 2 次告警、快照 `age > 5s` 阻止新开仓；是否符合 au/ag 日内波动和账户规模？
3. **UNASSIGNED 阈值**：数量 > 0 持续 60s 告警；重大金额/手数是否阻止该账户新开仓？阈值定多少？
4. **LIVE 启用**：v1 默认禁用，启用需四眼审批 + 红色确认；是否接受，还是先只允许 SHADOW？
5. **版本更新默认平仓**：默认“停止新开仓→撤单→平仓→对账→更新”，携带持仓升级需二次确认；做市/对冲策略日常升级是否接受默认平仓？
6. **策略 PnL 已实现口径**：FIFO，还是与柜台结算一致的加权平均？如果 FIFO，与柜台差异是否只显示不阻断？
7. **未实现 mark source**：`LAST/SETTLEMENT/THEORETICAL` 默认用哪个？期货/期权是否分开配置？
8. **手工簿粒度**：一账户一个 `MANUAL-<account>`，还是按交易员/子策略拆多个？是否需要按 `created_by` 分 PnL？
9. **共享账户风险预算**：策略只做估算归因，还是需要硬性 per-strategy 保证金上限？A 用满时 B 是否必须拒绝开仓？

---

## 8. 最小实施路径

| 阶段 | 先决条件 | 可做什么 |
|---|---|---|
| Phase 1 | 修完 **P0-03** | 数据模型/SBE v2/权限 enforcement/行情键/Book+book_positions/迁移脚本；不碰策略 UI |
| Phase 2 | 补完 **P1-13** | CTP 映射、成交归因、策略持仓/PnL、账户快照、FENCED、对账；可先只读 |
| Phase 3 | 补完 **P1-09** | 策略列表/详情只读；所有数据页过滤+权限验证通过后才移除顶部选择器 |
| Phase 4 | Phase 2/3 验收 | 账户汇总/手工簿/未分配认领/共享账户风险预算 |
| Phase 5 | Phase 1 绑定字段/版本/Fork 完成 | 版本更新/Fork/部署闭环 |
| Phase 6 | Phase 1~5 | 应急/多柜台运维/LIVE 审批 |

**结论：P0-03 是唯一 Phase 1 阻塞项；P1-13 是 Phase 2 前置；P1-09 是 Phase 3 前置。P2 无阻塞。**

---

## 9. 附录：本轮核对依据

1. `docs/architecture/23-策略中心V2设计稿.md` §3.3（四元组）、§3.4（strategies 表/bound 校验/§16 Fork 规则）、§13（部署接口只校验 Agent）。
2. §3.4 lifecycle 与 §4.3 三列状态枚举的差异。
3. §6.1 与 §17 P1-13 的 PnL 口径差异；§3.7 `book_positions` 字段与 §6.2 手工簿 PnL 的缺口。
4. §8.5 公共字段表包含 `routeId/orderEpoch`，但 `OrderUpdate/Trade` 字段清单未列；`OrderRequest.strategyId(int32)` 与 `strategyKey` 的兼容说明。
5. §14 Phase 1~6 的顺序：Phase 1 SBE/权限/行情键，Phase 2 成交归因/PnL，Phase 3 只读 UI，Phase 5 版本/Fork，Phase 6 应急。
6. §18 冻结阈值、§19 P2 体验补充。
7. 现有代码基线（只读参考）：`StrategyOrderService` 仍用账户持仓做平仓拆分；`StrategyPositionService` 键为 `(strategyId, accountId, instrumentId)`；`StrategyPnlService` 用全局 `marketData.tick(instrumentId)`；`ManualOrderPublisher` 手工单 `strategyId(0)`/空 `strategyKey`；SBE v1 `MarketData` 无 counterparty/exchange。V2.1 正文已要求改造，实现时需逐项替换。

---

*本评审只针对设计稿，不修改源代码或设计稿。V2.1 主干可保留；修完 P0-03 可进入 Phase 1，Phase 2 前补 P1-13，Phase 3 前补 P1-09。*

# 交易员复审：策略中心 V2 设计稿

- 日期：2026-11-09
- 评审对象：`docs/architecture/23-策略中心V2设计稿.md`
- 评审视角：期货/期权交易员（SHFE au/ag，做市 + 方向 + 对冲），兼交易系统评审
- 参考：`docs/architecture/14-多Runtime-Agent与柜台账号绑定.md`、`docs/architecture/22-多柜台接入与管理系统设计.md`、`docs/reviews/trader-review-2026-11-08-multi-counter.md`
- 结论：**REQUEST_CHANGES**（P0 10 项、P1 17 项、P2 10 项）

> V2 修掉了上一版最根本的概念错误：柜台和交易所分开，策略成为归因主对象，手工簿和未分配被显式建模，路由也写了 fail-closed。方向是对的，这些必须保留。
>
> 但现稿还不能进入开发。三处会直接把策略 PnL 做错：
>
> 1. §5.3 的账户持仓等式把“未分配”做成了万能插头，且手工簿可能被双重计入；账户持仓不再是对账对象，而是被策略汇总“定义”出来的。
> 2. §8.2 的下单校验没有要求用**策略自身持仓**校验平仓量；同一账户多个策略时，A 策略可以平掉 B 策略的仓。
> 3. §16 仍把“策略迁移到新账户是否保留同一策略 ID”留成开放问题；这决定 `strategy_positions` 和 PnL 的身份，不能在开发前悬空。
>
> 另外，V2 要求订单/成交/回报携带 `strategy/deployment/account/counterparty/exchange`，但现有 SBE 合同和 CTP 回报链路并没有这些字段，也没有说明谁负责打标；不做这一层，策略持仓仍是“本地账”，不是可对账的账。

---

## 0. 结论与放行条件

### 0.1 一句话结论

**策略中心的产品方向成立，但 V2 的“策略持仓/手工簿/账户对账”三者还没有形成闭环。** 现稿可以继续做概念评审，不能按 §14 的 Phase 1 直接开工。

### 0.2 放行条件（全部满足才建议进入开发）

- [ ] 账户持仓改为“柜台快照权威”，策略汇总只用于归因和对账；`unassigned` 是差额，不是等式里的配平项。
- [ ] 手工簿是独立 `book_type=MANUAL` 对象，不计入 `sum(strategy_positions)`，不参与策略部署/排名/自动平仓。
- [ ] 平仓/平今/平昨校验使用**策略自身持仓**，不是账户持仓；同一账户多策略并发下单有锁和拒绝规则。
- [ ] 策略迁移/重新部署的持仓、PnL、历史归属有明确方案，不能留到 §16 让交易员选。
- [ ] SBE `OrderRequest/OrderUpdate/Trade/MarketData/PositionSnapshot` 的字段扩展、CTP Adapter 打标、未知成交进入 `UNASSIGNED` 队列的流程冻结。
- [ ] 权限、应急“当前策略”、LIVE/SHADOW 环境显性化、旧 ORS/fencing 四项有服务端合同和验收用例。
- [ ] Phase 顺序调整：先数据模型 + 行情键 + 归属 + 权限，再改策略中心 UI；不要先移除顶部选择器。

---

## 1. V2 做对的地方

1. **§3.2 柜台与交易所分离**：`counterparty_exchange`、`instrument.exchange`、`orders.exchange`、`trades.exchange` 的模型正确，直接关闭了上一版 `counterparty.exchange` 的核心错误。
2. **§3.3 / §8.1 策略执行上下文**：把 `deploymentId / generation / agent / counterparty / account / ors / environment` 绑定到策略，比上一版“当前柜台”更贴近交易意图。
3. **§5.1 策略独立持仓**：明确 `strategy_positions` 和 `account_positions` 两张表，方向正确；这是策略 PnL 能成立的前提。
4. **§6.1 / §6.2 策略 PnL 与账户 PnL 分权**：策略 PnL 归因、账户 PnL 以柜台快照为权威，这个原则必须保留。
5. **§8.2 / §8.3 路由 fail-closed 与 generation**：`NO_ACTIVE_ROUTE`、不 fallback、旧 generation `STALE_UPDATE`，比上一版前进了一大步。
6. **§11.1 应急默认当前策略**：这是交易员真正需要的默认值；但需要解决“当前策略”在非策略详情页的定义问题（见 P0-07）。
7. **§4.1 移除顶部柜台选择器**：方向正确，减少“登录用户/交易账户/ORS”混淆；但必须补回多柜台日常操作入口（见 P1-03）。

---

## 2. 本轮业务约束逐条核对

| 业务约束 | V2 对应 | 评审结论 |
|---|---|---|
| 1. 一个柜台可对接多个交易所 | §3.2、§8.4、§9.1 | **模型正确**；但 `counterparty_exchange` 的 API/校验/验收还没写，Phase 5 才落地 |
| 2. v1 一柜台 = 一账户 | §3.1、§3.3 | 作为部署约束可接受；需要唯一约束和迁移检查，不能只写在文档 |
| 3. 一个账户可有多个策略 | §6.3、§4.3 | 产品上成立；但共享账户的平仓、保证金、限额分配没有定义（P0-02、P1-04） |
| 4. 一个策略只能部署在一个 Agent/柜台/账户/ORS | §3.3、§8.1 | 方向正确；缺 `ACTIVE` 唯一约束、迁移/drain 规则（P1-07） |
| 5. 不支持跨柜台策略 | §8.4 | 正确；但“跨交易所不能跨柜台”的边界要在下单和持仓键上验证 |
| 6. 策略必须有独立持仓 | §5.1 | 方向正确；但账户持仓等式和手工簿双重计入会破坏这个前提（P0-01、P0-05） |
| 7. 策略 PnL 按自身成交/持仓；账户 PnL 以快照为权威 | §6.1、§6.2 | 原则正确；缺账户快照模型、平仓校验和 CTP 打标（P0-02、P0-04、P1-05） |
| 8. 订单/成交/持仓带账户/柜台/策略/交易所 | §7.1、§7.2 | 表字段正确；SBE/CTP 链路带不了这些字段（P0-04） |
| 9. 只有总持仓按账户维度 | §5.2、§10.2 | 正确；策略详情按策略维度也成立，但列表“交易所”单值不成立（P1-01） |
| 10. 手工单必须有归属 | §3.4、§7.3 | 方向正确；`MANUAL-<account>` 不是完整手工簿模型（P0-05） |
| 11. 紧急操作默认当前策略，账户/全部显式选择 | §11.1、§11.2 | 方向正确；§4.1 顶栏仍有全局“只减仓/紧急操作”，冲突（P0-07） |

---

## 3. 上一轮 P0 关闭状态

> 上一轮指 `docs/reviews/trader-review-2026-11-08-multi-counter.md` 的 P0-01 ~ P0-11。这里只评“设计是否真正闭合”，不把“写了字段”当成“已经可运行”。

| 上轮 P0 | V2 对应位置 | 状态 | 说明 |
|---|---|---|---|
| P0-01 柜台/交易所分离 | §3.2、§5.1、§7.1、§7.2、§9.1 | **已关闭（设计）** | `counterparty_exchange` 和 `orders/trades.exchange` 方向正确；但 `instruments` 仍以 `id` 单主键、`counterparty_exchange` 没有 API/校验/验收，落地待补 |
| P0-02 当前柜台选择器混淆账户/ORS | §4.1、§4.4、§10.3 | **已关闭（设计）** | 顶部选择器移除，策略详情固定上下文；手工单账户选择是必要输入，不再是“全局当前账户”混淆 |
| P0-03 行情按柜台建键 | §9.1、§6.1、§9.3 | **部分关闭** | 键 `(counterpartyId, exchange, instrumentId)` 正确；但 Phase 5 才落地，SBE `MarketData` 还没有 `counterpartyId/exchange`，固定种子价/freshness 没有处理 |
| P0-04 路由 fail-closed / 旧回报 | §8.2、§8.3 | **部分关闭** | 不 fallback、旧 generation 丢弃写对了；但 `orders/trades` 没有 `ors_id/fencing_token`，§8.3 必带字段清单也漏了它们，旧 ORS 同 generation 仍可能覆盖 |
| P0-05 切换 contextVersion | §3.3、§8.3 | **部分关闭** | 策略单用 `deploymentGeneration`，方向正确；手工单没有 preview/contextVersion，改账户后旧预检仍可能提交 |
| P0-06 账户级权限 | §12 | **未关闭** | 仍只有 `user_account_permission` 表字段，没有唯一键、默认拒绝、服务层 enforcement、策略范围、测试 |
| P0-07 应急范围 | §11.1、§11.2 | **部分关闭** | 策略详情默认当前策略正确；§4.1 顶栏仍保留全局“只减仓/紧急操作”，且非详情页没有“当前策略”定义 |
| P0-08 对账/持仓/成交按柜台隔离 | §5.3、§6.2、§10.2 | **未关闭** | 公式把账户持仓定义成策略汇总+手工+未分配，`unassigned` 成了配平项；手工簿还可能双重计入 |
| P0-09 Phase 顺序 | §14 Phase 2 / Phase 5 | **未关闭** | Phase 2 就移除顶部选择器、做策略 PnL，Phase 5 才做行情键/多柜台；会再次出现“看起来策略中心、实际全局数据” |
| P0-10 手工单开平/TIF | §7.1、§10.3 | **基本关闭** | 手工单表单和订单快照有开平/TIF；但 V2 导航没有期权链/快捷下单，确认框缺价格/数量/名义/保证金 |
| P0-11 LIVE/SHADOW 环境 | §3.3、§4.1、§4.3、§4.4 | **部分关闭** | 部署模型有 `environment`，但策略列表/详情/确认框/顶栏没有按策略显示，LIVE 切换没有确认 |

**结论：上一轮 11 项 P0 中，设计层面真正关闭 3 项（P0-01、P0-02、P0-10 基本关闭），部分关闭 5 项，未关闭 3 项。** 未关闭的三项（权限、对账、Phase 顺序）都是上模拟盘前必须解决的。

---

## 4. P0（上模拟盘/试点前必须解决）

### P0-01 账户持仓等式把“未分配”做成万能插头，手工簿可能双重计入

**设计稿位置**：§3.4 手工交易簿、§5.1 `strategy_positions`、§5.2 `account_positions`、§5.3 对账关系、§6.2 账户 PnL。

**问题**：
- §5.3 写的是：

  ```text
  account_position
    = sum(strategy_positions for account)
    + manual_book_position
    + unassigned_position
  ```

  但 §3.4 又把每个账户的手工簿定义成 `MANUAL-<account>` 策略/交易簿。如果手工簿也落在 `strategy_positions` 里，`sum(strategy_positions)` 已经包含手工簿，再加 `manual_book_position` 就是双重计入。
- 更严重的是 `unassigned_position` 被加在等式右边。任何外部成交、历史差异、归属丢失都可以塞进 `unassigned`，等式永远成立；账户持仓不再是柜台快照，而是被策略汇总“定义”出来的。这样对账不会失败，只会把差异藏起来。
- §6.2 说账户 PnL 以柜台快照为权威，但 §5.2/§5.3 的账户持仓却是计算值；两个权威口径不一致。

**交易员影响**：
- 页面显示“账户持仓 = 策略 + 手工 + 未分配”永远平，实际柜台可能多出 29 笔挂单/持仓（上一轮架构评审已经出现过 `local 2 vs venue 31` 的假阳性）。
- 手工簿 PnL/持仓被算两次，策略 PnL 排名和账户 PnL 对账都失真；交易员会以为策略赚了，实际是手工簿重复计入。
- 外部成交被静默塞进 `unassigned`，策略风险看起来比实际小；平仓/对冲决策会错。

**具体修改建议**：
1. `account_positions` 改为**柜台快照权威**：`account_id / counterparty_id / exchange / instrument_id / long/short/today/yesterday / avg_price / as_of / source=SNAPSHOT / stale`。
2. 对账等式改成“比较”，不是“定义”：

   ```text
   venue_position (权威)
     vs
   attributed_position
     = sum(strategy_positions where book_type=STRATEGY)
     + manual_book_position (book_type=MANUAL, 只算一次)
   diff = venue_position - attributed_position
   ```

   `diff != 0` 就是 `UNASSIGNED` 或 `RECON_DIFF`，必须显示、告警、可分配，不能加到等式右边把账配平。
3. `strategy_positions` 增加 `book_id / book_type`，手工簿独立 `book_type=MANUAL`，不进入 `sum(STRATEGY)`；`manual_book_position` 单独从手工簿取，二者只取一个来源。
4. `account_positions` 和 `strategy_positions` 都带 `as_of`、`source`、`stale`；账户 PnL 与账户持仓使用同一快照时点。
5. 验收用例：注入一笔外部 1 手多单，必须出现 `UNASSIGNED=1` 或 `RECON_DIFF=1`，页面变黄/红，不能自动平衡；手工簿只计一次；策略 A/B 的持仓合计与账户快照不一致时能定位到策略/手工/未分配。

---

### P0-02 策略平仓/开平校验必须用策略自身持仓，不能用账户持仓

**设计稿位置**：§5.1 `strategy_positions`、§7.1 订单 `offset`、§8.2 路由校验、§10.1 订单/持仓。

**问题**：
- §8.2 的校验只写“校验 strategy / deployment / account / counterparty / ACTIVE ORS / fencingToken”，没有写“校验该策略自己的可平持仓”。
- 现状实现 `StrategyOrderService` 的平仓拆分用的是 `currentPosition(accountId, instrumentId)`（账户持仓）和账户的今昨仓；`StrategyPositionService.applyFill` 又在策略持仓减到 0 时 `Math.max(0, ...)`，会把超平悄悄吃掉。
- 同一账户 A/B 两个策略共享 `ag2612`：A 有 2 手多、B 有 8 手多，账户 10 手。A 发“平仓 5 手”，按账户持仓会通过；成交后 A 的策略持仓被 clamp 到 0，B 的 8 手实际少了 3 手，但 B 的本地账还显示 8 手，账户与策略账同时错。
- V2 没有说明开仓/平仓校验的顺序是“先策略持仓，再账户持仓”，也没有说明多策略并发时的锁。

**交易员影响**：
- 策略 A 可以“偷”策略 B 的持仓；B 的 PnL、风险、止损全部失真。
- 交易员以为平的是 A 的 2 手，实际把 B 的对冲腿平了，组合变成裸敞口。
- 账户可用持仓与策略持仓不一致时，系统可能继续放行，直到柜台拒单或账户超限。

**具体修改建议**：
1. 下单校验顺序固定为：
   - `strategy_positions` 可平量（按方向、今昨、交易所规则）；
   - `account_positions` 可平量（柜台快照）；
   - 两者取更严格者；任一不足返回 `STRATEGY_POSITION_INSUFFICIENT` / `ACCOUNT_POSITION_INSUFFICIENT`。
2. `CLOSE` 的今昨拆分必须基于策略持仓的 `today_long/today_short/yesterday_long/yesterday_short`，不是账户持仓；SHFE/INE 的 `CLOSE_TODAY/CLOSE_YESTERDAY` 也按策略持仓解析。
3. 订单/成交确认显示：策略可用平仓量、账户可用平仓量、实际解析的开平/今昨、拆腿数量和原因。
4. 同一 `(strategy_id, account_id, exchange, instrument_id)` 的下单/成交更新加行锁或乐观版本号，禁止并发超平；`applyFill` 不允许负数，超平必须报错而不是 clamp。
5. 验收用例：A=2、B=8、账户=10；A 平 5 必须拒绝；A 平 2 后账户=8、A=0、B=8；并发两笔 A 平 2 只能成功一笔。

---

### P0-03 策略迁移/重新部署的身份与持仓归属未定义

**设计稿位置**：§3.3 一个 ACTIVE deployment、§5.1 `strategy_positions.deployment_id`、§14 Phase、§16 待确认第 5 问。

**问题**：
- §16 第 5 问仍把“策略部署到新账户时，是新建策略 ID，还是允许同一策略迁移并保留历史”留给交易员。这不是 UI 偏好，是 `strategy_positions`、PnL、审计的身份模型，必须在开发前定。
- 如果允许同一 `strategy_id` 迁移到新账户：
  - 旧账户的 `strategy_positions` 仍存在，新账户又新建；`strategy_id` 跨两个账户，策略 PnL 汇总会把两个账户的历史混在一起，违反“一个策略只能部署在一个账户”。
  - 旧账户如果还有未平持仓，策略迁移后旧仓无人负责，平仓/止损/对账归属不清。
- 如果同一账户重新部署（新 `deployment_id`、新 generation）：
  - `strategy_positions` 带 `deployment_id`，旧行仍挂在旧 deployment；如果按策略汇总所有 deployment，持仓/PnL 会重复；如果不汇总，旧仓丢失。
- V2 没有定义迁移前必须 `drain → cancel → flatten/reconcile`，也没有定义旧 epoch 的冻结。

**交易员影响**：
- 迁移后策略 PnL 出现两份历史，或者旧账户仓位变成“无主”；交易员无法判断当前策略到底管哪个账户的仓。
- 旧账户还有持仓时，新账户策略已经开新仓；组合风险看起来正常，实际两个账户都有敞口。
- 回滚/复盘时，无法解释“同一策略为什么在两个账户都有成交”。

**具体修改建议**：
1. v1 明确二选一，并写进 §3.3：
   - **推荐 A：策略不可迁移**。换账户 = 新建策略 ID；旧策略必须先平仓/归档，历史保留在旧 ID；UI 显示“历史策略（已归档）”。
   - **推荐 B：允许迁移但引入 `strategy_epoch`**。`strategy_positions` 以 `(strategy_id, epoch, account_id, exchange, instrument_id)` 为键；迁移产生新 epoch，旧 epoch 冻结；策略 PnL 分 epoch 展示，不跨账户合并。
2. 无论 A/B，迁移流程固定为：停止新开仓 → 撤销该策略挂单 → 平仓或明确转移 → 对账通过 → 释放旧 ORS → 新 deployment/generation → 验证旧 epoch 持仓为 0。
3. `strategy_positions` 的 `deployment_id` 只作为成交来源/审计，不作为持仓归属主键；持仓归属主键应是 `strategy_id + epoch`（或 `book_id`），否则重新部署会重复。
4. 验收用例：迁移后旧账户持仓为 0 或进入明确的“旧 epoch 待处理”；新账户从 0 开始；策略 PnL 分 epoch；旧账户历史可查但不再计入新策略风险。

---

### P0-04 CTP/ORS 回报归属未闭环，SBE 合同也带不了 V2 字段

**设计稿位置**：§7.1 订单快照、§7.2 成交快照、§8.3 回报保护、§9.1 行情键、§13 下单 JSON。

**问题**：
- §8.3 要求 `OrderUpdate / Trade` 必须带 `strategyId / deploymentId / deploymentGeneration / accountId / counterpartyId / exchange`，但 CTP 原生回报只有 `OrderRef/OrderSysID/InstrumentID` 等账户级字段，不带策略/部署。设计稿没有说明：
  - 谁把 `strategyId/deploymentId` 打到 CTP 回报上；
  - ORS/Adapter 重启后如何恢复 `clientOrderId → strategy/deployment` 映射；
  - 未知成交如何进入 `UNASSIGNED`，而不是猜一个策略。
- 现有 SBE 合同不支持这些字段：`abi/sbe/quantlink-fin-sbe.xml` 的 `OrderUpdate` / `Trade` 没有 `strategyId/deploymentId/accountId/counterpartyId/exchange`；`OrderRequest.strategyId` 是 `int32`，而 V2 的策略 ID 是字符串；`Trade` 连 `accountId` 都没有；`MarketData` 没有 `counterpartyId/exchange`；`PositionSnapshot` 没有 `exchange`。
- 现状 `ManualOrderPublisher` 发手工单时 `strategyId(0)`、`strategyKey` 传空串；DB 里即使写 `MANUAL-<account>`，线上回报也无法从 SBE 恢复这个归属。
- 结果是：策略持仓只能在控制面“猜/补”，而不是从成交事件自然推导。

**交易员影响**：
- 同一账户两个策略同一合约成交时，回报无法区分 A/B；策略持仓和 PnL 会错，账户 PnL 对账出现无法解释的差异。
- 手工单成交可能被归到 `UNASSIGNED` 或 0 号策略；手工簿 PnL 和策略 PnL 混在一起。
- ORS 重启后映射丢失，旧成交补记错策略；越到盘中越难恢复。

**具体修改建议**：
1. 冻结“策略归属键”：统一使用字符串 `strategyKey`（或 `book_id`）作为业务键；`strategyId int32` 只作为兼容字段，不再作为 V2 归属依据。
2. SBE 升版：`OrderRequest` 增加 `deploymentId / deploymentGeneration / bookId`；`OrderUpdate / Trade` 增加 `strategyKey / deploymentId / deploymentGeneration / accountId / counterpartyId / exchange / orsId / fencingToken`；`MarketData` 增加 `counterpartyId / exchange`；`PositionSnapshot` 增加 `exchange`。
3. ORS/Adapter 维护持久化 `clientOrderId → strategy/deployment/book` 映射；手工单写入 `MANUAL-<account>` 的 `bookId`；CTP 回报先按 `clientOrderId` 查映射再发布；查不到进入 `UNASSIGNED`，不得按合约/时间猜。
4. 控制面消费端只接受 `order.strategyKey` 与订单快照一致的回报；不一致记 `ATTRIBUTION_MISMATCH`，不更新策略持仓。
5. 验收用例：同一账户两个策略同一合约各成交 1 手，回报必须分别落到 A/B；手工单落 `MANUAL`；未知外部成交落 `UNASSIGNED`；ORS 重启后历史映射仍能恢复；SBE 旧版本消息被明确拒绝或迁移。

---

### P0-05 `MANUAL-<account>` 不是完整手工簿模型，会污染策略列表、自动平仓和 PnL

**设计稿位置**：§3.4 手工交易簿、§4.3 策略列表中的 `MANUAL-SIMLOCAL-001`、§7.3 订单归属、§11.1 策略详情应急。

**问题**：
- `MANUAL-<account>` 只是一个字符串约定，没有 `book_type`、`book_id`、负责人、子簿。一个账户多个交易员/多个手工策略时，无法区分“谁的手工单”和“哪类手工单”。
- V2 把手工簿放进策略列表（§4.3 有一行 `MANUAL-SIMLOCAL-001`，状态 `MANUAL`），但策略列表的“部署/停止/激活/策略详情/部署 Tab”都是按策略设计的。手工簿没有 deployment/ORS，点“停止策略”“部署”没有意义。
- 现有 `StrategyCloseoutScheduler` 会遍历 `strategy_positions` 中除 `futures_pair` 外的所有策略，并在收盘前调用 `flattenStrategy`；如果手工簿写入 `strategy_positions`，手工持仓可能被自动平仓；而 `EmergencyController.flattenStrategy` 又要求策略有 deployment/ORS，手工簿没有，会失败/刷日志。
- 手工簿出现在策略 PnL 排名、策略数量、策略风控里，会污染“策略表现”口径；手工单本来可能是对冲、纠错或客户单，不应被当成策略业绩。

**交易员影响**：
- 收盘前手工持仓被自动平掉，或系统反复尝试平仓失败；交易员以为手工仓会保留到夜盘。
- 策略列表里手工簿占一行，策略 PnL/排名混入手工盈亏；复盘时无法区分“策略赚的”和“手工做的”。
- 多个交易员共用一个账户时，手工簿只有一个，无法追责/分摊 PnL。

**具体修改建议**：
1. 建独立 `book` 实体：`book_id / book_type(STRATEGY|MANUAL|UNASSIGNED) / account_id / owner_user_id / status / display_name`；策略与手工簿都引用 `book_id`，不要用字符串前缀判断类型。
2. 手工簿 `book_type=MANUAL`，一个账户默认一个（v1），并记录 `operator_user_id`；如果多人共用一个账户，至少订单上保留 `created_by`，并在手工簿下支持子簿/标签（可 v2）。
3. 策略列表分两个区：`策略` 与 `手工簿`；手工簿不显示“部署/激活/停止策略”，只显示“手工簿详情/撤单/平仓/只减仓”。
4. 自动收盘/策略 closeout 只处理 `book_type=STRATEGY`；`MANUAL`/`UNASSIGNED` 必须显式配置是否收盘平仓，默认不自动平。
5. `strategy_positions` 增加 `book_id`，`sum(strategy_positions)` 只统计 `book_type=STRATEGY`；手工簿单独汇总，避免 P0-01 的双重计入。
6. 验收用例：手工单成交后不出现在策略 PnL 排名；收盘不自动平手工簿；手工簿详情没有部署 Tab；两个交易员同账户手工单可按 `created_by` 追溯。

---

### P0-06 权限仍未落地：`user_account_permission` 只是表，不是服务端合同

**设计稿位置**：§12 权限与审计、§13 API、§10.3 手工下单。

**问题**：
- §12 仍只列 `user_account_permission(user_id, account_id, role)`，没有唯一键、默认拒绝、角色继承、权限变更审计、策略级范围。
- “用户只能查看授权账户的策略/订单/成交/持仓”“策略详情页也做服务端权限校验”只是原则，没有说明：
  - 无权限时返回 403 还是空列表；
  - 手工单只接受 `accountId` 还是服务端从 `book/account` 解析；
  - 策略详情、订单、成交、总持仓、对账是否都走同一个 `AuthorizationService`；
  - ADMIN 是否有交易权，还是只能管理（四眼）。
- 现状 `SecurityConfig` 只有全局角色，`/api/v1/execution/contexts`、`/api/v1/accounts`、`/api/v1/positions` 对 VIEWER 可见；`TradingController` 不校验账户权限。V2 没有把这段现状写进迁移。

**交易员影响**：
- 任何 TRADER 仍可选到别人的账户/策略；手工单可能下到别的交易台。
- 策略列表显示不该看到的账户 PnL/持仓；合规和数据隔离失效。
- 权限被收回后，已打开的页面仍能提交；事后审计看不出“是否有权”。

**具体修改建议**：
1. `user_account_permission` 加 `(user_id, account_id)` 唯一键、`default deny`、`granted_by/granted_at/expires_at`；增加 `user_strategy_permission`（可选，若业务需要只读某策略）。
2. 统一 `AuthorizationService.require(user, accountId, action)`：`VIEW / TRADE / CANCEL / EMERGENCY / ADMIN`；所有 Controller/Service 走它，不能只靠 GET/POST 角色。
3. 手工单只接受 `accountId + bookId`，服务端解析 `counterparty/book`；策略单只接受 `strategyId + deploymentId + generation`，服务端解析 account/counterparty/ORS，客户端传的账户字段只做一致性校验。
4. 无权限返回 403（不返回空列表）；审计 `DENIED_VIEW / DENIED_TRADE / PERMISSION_CHANGE`；权限版本变化让已打开页面失效。
5. 验收矩阵：VIEWER 只看授权账户；TRADER 只能对授权账户下单；ADMIN 默认无交易权（请交易员确认）；越权请求 403 且审计。

---

### P0-07 应急“当前策略”与 §4.1 全局按钮冲突，非策略详情页没有当前策略

**设计稿位置**：§4.1 顶部栏 `只减仓 | 紧急操作`、§11.1 策略详情默认当前策略、§11.2 账户/全局应急只在运维页面。

**问题**：
- §4.1 顶栏仍保留“只减仓 / 紧急操作”，但 §11.1 说默认范围是“当前策略”。在订单页、成交页、总持仓页、监控页，**当前策略是什么？** 设计稿没有定义 `currentStrategyId` 上下文，也没有说顶栏按钮在这些页面是否可用。
- §11.2 又把账户/全部操作“只放在运维页面”，但顶栏仍有“紧急操作”入口，交易员在盘中会先点顶栏；如果顶栏只能做全局，和“默认当前策略”冲突；如果顶栏要求先选策略，又多一步。
- 手工簿 `MANUAL-<account>` 作为当前策略时，“停止策略/激活策略”没有意义；需要手工簿专用动作。
- 现有 `EmergencyController.stopAll` 会 pause 所有策略、cancelAll(ALL)、逐策略 flatten；如果顶栏“紧急操作”仍走这个接口，范围就是全部账户，和 §11 冲突。

**交易员影响**：
- 在策略详情页点“只减仓”，以为是当前策略；顶栏却可能是全局，另一个账户的策略被停。
- 在订单页发现异常，想按当前策略止损，但页面没有当前策略，只能猜/选，盘中耽误时间。
- 手工簿当前时点“停止策略”无效或误触发其他逻辑。

**具体修改建议**：
1. 明确“当前策略”上下文：`currentStrategyId` 存在 URL/页面 store；进入策略详情自动设置；其他页面顶部显示 `当前策略: ...` 或 `未选择策略`。
2. 顶栏只保留一个“应急”抽屉，打开时显示三档范围：
   - `当前策略`（仅当 `currentStrategyId` 存在，默认）；
   - `当前账户/指定账户`（显式选择）；
   - `全部账户`（输入 `ALL`/账户数确认）。
3. 或者把顶栏的“只减仓/紧急操作”移除，只在策略详情和运维“应急”页提供；不要留一个语义不明的全局按钮。
4. 手工簿的应急动作改为“撤销手工簿挂单 / 平掉手工簿持仓 / 手工簿只减仓”，不显示“停止策略”。
5. 每个动作显示影响：策略/账户/柜台/交易所/挂单数/持仓/名义/预估保证金；审计记录范围。
6. 验收用例：在策略详情点只减仓只影响当前策略；在订单页选择“当前账户”影响该账户所有策略；全部账户必须二次确认并显示逐账户清单。

---

### P0-08 Phase 2 移除顶部选择器、Phase 5 才做行情键，策略 PnL 会先用全局行情

**设计稿位置**：§14 Phase 1~5、§15 验收、§9.1 行情键。

**问题**：
- Phase 2 就做“策略列表/详情/持仓/订单/成交/PnL/对账”并“顶部移除柜台选择器”；Phase 5 才做“行情键改造、柜台交易所关联、多交易所策略持仓、账户总持仓验证”。
- 这意味着 Phase 2 的策略 PnL 只能用现有 `MarketDataService.tick(instrumentId)` 全局行情；同合约在多个柜台/交易所有不同价格时，策略 PnL 和未实现盈亏会串价。Phase 2 也还没有 `counterparty_exchange` 的完整校验，策略跨交易所持仓可能只显示一个。
- Phase 4 才做权限；Phase 2/3 的策略、订单、账户数据已经暴露给所有登录用户。Phase 3 才做账户 PnL 权威，Phase 2 的策略 PnL 可能先被当成账户 PnL 使用。
- 这正是上一轮 P0-09 的翻版：先把 UI 改成“策略中心”，数据却还是全局。

**交易员影响**：
- 策略详情 PnL 看起来是 SIMVENUE 的，实际用了 SimNow 的价格；交易员按错误 PnL 做止损/加仓。
- 移除顶部选择器后，交易员没有“当前柜台”可核对，错误更难发现。
- Phase 2 上线后权限还没做，任何登录用户能看到所有账户策略；试点期数据隔离不成立。

**具体修改建议**：
1. 调整 Phase 顺序：
   - Phase 1：数据模型 + `counterparty_exchange` + `orders/trades` 归属 + SBE/Adapter 打标 + `strategy_positions`/`account_positions`。
   - Phase 2：行情键 + 路由 fail-closed + 回报 fencing + 对账 gate + 权限。
   - Phase 3：策略列表/详情/PnL（此时价格/归属/权限已可信）。
   - Phase 4：账户汇总/总持仓/对账 UI。
   - Phase 5：移除顶部选择器/旧页面，做多柜台/多交易所验收。
2. 如果必须早做策略 UI，加 feature flag：未完成行情键/权限前，策略 PnL 显示 `N/A` 或 `数据未就绪`，不能用全局价冒充。
3. §15 增加阶段性验收：Phase 2 完成前，策略 PnL 必须能证明使用 `(counterparty, exchange, instrument)` 价格；权限矩阵必须通过；旧页面切换前后 6 个页面一致。
4. 每个 Phase 有回滚开关；顶部选择器最后移除，不要在 Phase 2 提前删。

---

### P0-09 订单/成交/回报缺 `ors_id`/`fencing_token`，旧 ORS 同 generation 仍可覆盖

**设计稿位置**：§7.1 订单快照、§7.2 成交快照、§8.2 路由、§8.3 回报保护。

**问题**：
- §7.1/§7.2 只加了 `deployment_id / deployment_generation`，没有 `ors_id / fencing_token / route_id`；§8.3 的“必须带”清单也没有 `orsId/fencingToken`，后面却说“旧 fencingToken”要丢弃。
- `deploymentGeneration` 只在策略切换部署上下文时递增；同一个 deployment 下 ORS 重启/重新登录，generation 可能不变。旧 ORS 进程仍活着、拿着旧 fencingToken，发出的 `CANCELED`/`FILLED` 可能通过 generation 校验，覆盖新 ORS 的状态。
- 现有 `AeronOrderUpdateConsumer` 按 `clientOrderId` 应用更新，`applyOrderUpdate` 只有 `last_update_seq/timestamp`，没有 `orsId/fencingToken` 校验；ORS 重启 sequence 归零时，可能出现新更新被 `GREATEST` 丢掉，或旧更新覆盖新状态。

**交易员影响**：
- 旧 ORS 的“已撤”覆盖新 ORS 的“已成交”，交易员以为没成交，重复下单。
- 策略持仓/PnL 按错误状态更新；账户对账差异无法解释。
- ORS 重启后订单状态卡住，盘中无法判断真实挂单。

**具体修改建议**：
1. `orders/trades` 增加 `ors_id / fencing_token / route_id / order_epoch / last_update_ors_id / last_update_fencing_token`；回报必须携带同样字段。
2. 消费端校验：`order.ors_id == update.ors_id` 且 `order.fencing_token == update.fencing_token` 且 `deployment_generation` 匹配；旧值直接 `STALE_UPDATE`，不更新状态、不改策略持仓。
3. ORS 重启/新 fencingToken 时，旧 ORS 的 stream 进入 `FENCED`；未完成订单由新 ORS 查询柜台确认，不能靠旧回报猜。
4. `applyOrderUpdate` 增加 `ors_id/fencing_token` 条件和状态机，阻止 `FILLED → CANCELED` 之类的非法回退（除非人工调整）。
5. 验收用例：同一 deployment generation，旧 ORS 发 CANCELED、新 ORS 已 FILLED，页面保持 FILLED 并告警；旧 ORS sequence 归零不丢新更新。

---

### P0-10 环境未按策略/账户显性化，LIVE 与 SHADOW 可能同屏同色

**设计稿位置**：§3.3 `StrategyDeployment.environment`、§4.1 顶栏单一 `SHADOW`、§4.3 策略列表、§4.4 策略详情、§10.3 手工单确认、§13 下单 JSON。

**问题**：
- 模型里 `environment` 是 deployment 属性，但 §4.3 策略列表没有环境列，§4.4 详情头没有环境，§10.3 手工单确认没有环境，§4.1 顶栏只有一个全局 `SHADOW`。交易员无法从策略列表区分 SIM/SHADOW/LIVE。
- 没有定义从 SIM 策略切到 LIVE 策略、或手工单选择 LIVE 账户时的二次确认、颜色带、水印、审批。V2 的页面布局在两种环境下完全一样。
- 现状 `AppShell` 的环境来自全局 `/system/status`；登录页写死 `SHADOW ENVIRONMENT`。V2 没有改这个数据源。

**交易员影响**：
- 在策略列表点开一个 LIVE 策略，以为还是 SHADOW；下单确认只显示账户/柜台，不显示 LIVE。
- 手工单选择 LIVE 账户，页面仍是 SHADOW 风格；误把实盘当模拟。
- 复盘时无法按环境区分策略 PnL。

**具体修改建议**：
1. `StrategyDeployment.environment` 必须出现在：策略列表列、策略详情头、订单/成交/持仓行、手工单表单和确认框、审计日志。
2. 顶栏环境改为“当前策略/当前账户环境”或“全部授权环境中最高风险环境”；`SIM` 蓝、`SHADOW` 紫、`LIVE` 红，配页面角标/水印。
3. 打开 LIVE 策略/选择 LIVE 账户手工单：要求输入策略 ID/账户 ID 或二次确认；切换后清空旧 preview；审计记录 `LIVE_ACK`。
4. v1 如果没有 LIVE 计划，明确写“LIVE 在 v1 禁用”，不要只留字段。
5. 验收用例：SIM/SHADOW/LIVE 三环境同屏时颜色/文字可区分；LIVE 下单确认包含 `LIVE`；把 LIVE 当 SHADOW 的路径不存在。

---

## 5. P1（试点期内必须解决）

### P1-01 策略列表/详情的“交易所”是单值，但策略可以跨交易所

**设计稿位置**：§4.3 策略列表 `交易所` 列、§4.4 详情头 `SHFE`、§8.4 跨交易所。

**问题**：§8.4 明确“一个策略可以通过同一柜台交易多个交易所的合约”，但 §4.3/§4.4 每行只显示一个 `交易所`。策略 A 同时交易 SHFE au 和 DCE TA 时，列表只能显示一个，交易员会误判策略只在一个交易所。

**交易员影响**：看策略列表时漏掉另一个交易所的持仓/风险；按交易所筛选时策略只出现在一个交易所；复盘/对账不完整。

**修改建议**：列表显示 `交易所集合`（如 `SHFE/DCE` 或 `2 个交易所`），详情头显示 `交易所: 全部 / SHFE / DCE` 可切换；策略列表支持按交易所多选筛选；策略 PnL/持仓按交易所分组。

---

### P1-02 手工单缺默认账户规则、账户/交易所联动和 preview 失效

**设计稿位置**：§10.3 手工下单、§13 下单 JSON。

**问题**：§10.3 只列账户/柜台/手工簿/交易所/合约/方向/开平/价格/数量/TIF，没有定义：
- 默认账户是上次使用、第一个授权账户，还是必须每次显式选择；
- 交易所由合约自动带出还是用户选择；账户换了之后交易所/合约是否重置；
- 预检后改账户/交易所/价格/数量，旧 preview 是否失效；
- 确认框只列 `账户/柜台/交易所/手工簿/开平/TIF`，没有价格、数量、方向、名义、保证金、可用资金、价格偏离。

**交易员影响**：多账户手工单容易选错账户/交易所；预检后改价仍提交旧结果；确认框信息不足，乌龙指风险高。

**修改建议**：默认账户用“上次使用”但必须显示并允许清空；账户→柜台→可用交易所联动，合约选择后交易所只读；preview 绑定 `accountId + bookId + exchange + instrument + side + offset + price + qty + accountVersion`，任一变化清空；确认框补全方向/价格/数量/名义/保证金/可用/偏离/环境；禁止无 preview 提交。

---

### P1-03 策略中心导航缺少行情、期权链和交易驾驶舱

**设计稿位置**：§4.2 一级导航、§10.1 策略详情、§10.3 手工下单。

**问题**：V2 一级导航只有策略/数据/接入/运维，没有“行情”“期权链”“交易驾驶舱”。对于 SHFE 期权做市/方向交易，策略列表和单合约手工单不能替代期权链：
- 看不到 Call/Put 各档 IV、Greeks、盘口、我们的报价；
- 无法点价下单/撤改报价；
- 无法同时看策略持仓与期权链。

**交易员影响**：日常期权交易要跳回旧页面或无法操作；策略中心只适合“看策略”，不适合“做交易”；多柜台切换后更找不到入口。

**修改建议**：在“策略”或“数据”下保留 `行情 / 期权链 / 手工交易` 入口；策略详情/持仓行可下钻到期权链并带上 `strategyId/accountId/counterpartyId/exchange`；如果 V2 暂不做期权链，明确写“旧期权链页面保留，不删除，且上下文随策略传递”，不要用策略中心替代交易前台。

---

### P1-04 共享账户的保证金、可用资金、挂单/成交限额没有分摊

**设计稿位置**：§6.3 多策略共享账户、§10.1 PnL/风险、§8.2 风控。

**问题**：一个账户多策略共享 CTP 资金/保证金/最大挂单/最大成交手数，V2 只定义策略持仓和 PnL，没有定义：
- 每个策略看到的“可用资金”是账户全额还是分摊额度；
- 策略 A 用掉保证金后，策略 B 的开仓如何被拒绝；
- 账户级最大挂单/成交手数如何在策略间分配；
- 策略详情“限额占用”是策略限额还是账户限额。

**交易员影响**：两个策略都以为有 100 万可用，同时开仓导致账户保证金超限/被柜台拒单；策略 A 的盈利/亏损影响 B 的可用资金，但页面看不出来。

**修改建议**：明确账户资金/保证金是共享权威值；策略详情显示“账户可用/已占用/本策略占用（估算）”；增加 `strategy_risk_limit` 或“策略保证金预算”字段（可 v1 先只读估算）；下单前同时校验账户级和策略级限额；账户级挂单/成交限额按策略实时汇总，超过时拒绝并显示占用方。

---

### P1-05 账户 PnL 快照模型缺失，`≈` 没有口径和容差

**设计稿位置**：§6.2 账户 PnL、§13 `GET /accounts/{id}/pnl`。

**问题**：§6.2 说“账户 PnL = 柜台账户快照权益变化 = 权威值”，但没有定义：
- 快照表字段（权益/现金/出入金/手续费/已实现/未实现/结算价）；
- 当日 PnL 的起始基准（上一交易日结算权益？今日开盘权益？）；
- 出入金、手续费、交割/行权、资金费如何剔除；
- 快照 `asOf` 与策略 PnL 行情时点如何对齐；
- `≈` 的容差、持续时长、失败动作。

**交易员影响**：账户 PnL 和策略 PnL 永远对不上；无法判断是策略亏了还是出入金/手续费；日终复盘不可信。

**修改建议**：建 `account_pnl_snapshot`（`account_id, trading_day, as_of, equity, cash, deposit, withdraw, realized, unrealized, fees, source`）；定义当日/累计 PnL 公式和出入金剔除；策略 PnL 与账户 PnL 对账显示 `diff / tolerance / stale / 最近成功时间`；超过阈值告警，是否阻止开仓由交易员确认（见问题 4）。

---

### P1-06 `unassigned_position` / 外部成交没有认领流程、表和审计

**设计稿位置**：§5.3 `unassigned_position`、§7.3 `UNASSIGNED`。

**问题**：V2 只提到 `unassigned_position` 和 `UNASSIGNED`，没有：
- 表结构（哪笔成交/持仓、来源、金额、时间）；
- 认领 UI（分配给策略/手工簿）；
- 认领审计（谁、何时、依据）；
- 未认领的 SLA/告警/是否阻止策略开仓；
- 外部成交与 CTP 回报的匹配规则。

**交易员影响**：外部成交/历史遗留永远躺在未分配，账户 PnL 对不上；策略风险低估；没人知道该认领到哪个策略。

**修改建议**：建 `unassigned_trade` / `position_assignment` 表，记录 `trade_id/instrument/exchange/qty/price/source/status/assigned_to/assigned_by/assigned_at`；增加“未分配”页面和认领动作；认领必须写审计并更新策略/手工簿持仓；未认领超过阈值告警，重大差异可配置阻止新开仓；验收用例覆盖外部成交、历史遗留、策略归属丢失。

---

### P1-07 策略部署生命周期、回滚、drain 和审批没有进入 V2

**设计稿位置**：§3.3 `StrategyDeployment`、§10.1 部署 Tab、§14 Phase。

**问题**：V2 只定义 deployment 字段和“一个 ACTIVE”，没有定义：
- 部署状态机（VALIDATED/DEPLOYING/ACTIVE/STOPPING/FAILED/ROLLED_BACK）；
- 版本、配置 hash、回滚目标；
- 盘中部署是否先撤单/冻结/对账；
- 新 deployment 失败时旧 deployment 是否恢复；
- 部署/回滚审批（四眼）。

**交易员影响**：部署变更后旧策略挂单/持仓没人管；新版本失败无法回滚；盘中部署可能留下孤儿订单。

**修改建议**：补状态机和版本/配置 hash；部署前 `cancel → drain → reconcile → release → bind → deploy`；失败自动回滚上一稳定版；ACTIVE 部署需 ADMIN/四眼（按环境）；盘中部署需二次确认并显示影响；审计记录 deployment/generation/version；验收用例覆盖部署失败、回滚、盘中部署。

---

### P1-08 `strategy_positions` 的主键/唯一键和结算生命周期没有定义

**设计稿位置**：§5.1 `strategy_positions`、§5.3 对账、§14 Phase 1。

**问题**：
- 表字段有 `deployment_id`、`exchange`，但没有主键/唯一键；现状冲突键是 `(strategy_id, account_id, instrument_id)`，没有 `exchange`/`deployment`/`book`，同一策略跨交易所或重新部署会产生重复行。
- `StrategyPositionService.applyFill` 只更新数量/均价，不更新 V2 新增的 `realized_pnl` / `fees`；这两个字段会一直是 0。
- 没有定义日终结算/今昨转换（today → yesterday）、交割/行权、期权到期；策略持仓跨交易日会错。

**交易员影响**：同一策略跨交易所持仓被合并/覆盖；策略 PnL 缺手续费/已实现；第二天今昨仓错，平今/平昨被拒。

**修改建议**：主键/唯一键定为 `(book_id/strategy_id, epoch/deployment_generation, account_id, exchange, instrument_id)`；`deployment_id` 只做来源；`applyFill` 在同一个事务更新数量、均价、realized_pnl、fees；日终结算任务做 today→yesterday；期权到期/行权单独处理；迁移时校验重复行；验收用例覆盖跨交易所、重新部署、跨交易日、部分成交。

---

### P1-09 策略列表“状态”列混用策略状态、部署状态和手工簿类型

**设计稿位置**：§4.3 列表 `状态` 列（`ACTIVE` / `MANUAL`）、§3.3 deployment `desired/actual`。

**问题**：`ACTIVE` 是策略状态还是 deployment 状态？`MANUAL` 是策略类型还是状态？`INACTIVE`/`STOPPED`/`FAILED` 与 deployment 的 `desired/actual` 混在一起。手工簿没有 deployment，却显示 `MANUAL` 状态，交易员无法判断“是否在跑、是否有持仓、是否可交易”。

**交易员影响**：看到 `MANUAL` 以为策略在运行；看到 `ACTIVE` 但 deployment 实际 FAILED；误点停止/部署。

**修改建议**：拆成三列：`book_type`（策略/手工簿/未分配）、`deployment_status`（ACTIVE/INACTIVE/FAILED/STOPPING）、`strategy_status`（DRAFT/VALIDATED/ARCHIVED）；手工簿显示 `手工簿` 而非 `MANUAL`；列表默认只显示 `book_type=STRATEGY`，手工簿单独分组。

---

### P1-10 订单/成交/总持仓默认“全部授权策略”，缺少上下文延续和分页

**设计稿位置**：§10.4 订单/成交/总持仓过滤器与默认范围、§13 API。

**问题**：§10.4 默认订单/成交“全部授权策略”，总持仓“全部授权账户”。这适合做 blotter，但：
- 从策略详情跳到订单页后，默认变成全部策略，丢失当前策略上下文；
- 没有分页/排序/导出/列配置；
- 没有“今日未完成 + 今日成交”的默认；
- 没有显示数据 `asOf`/`stale`。

**交易员影响**：切页后找不到刚才的策略订单；大量订单时页面卡；复盘无法导出。

**修改建议**：订单/成交默认“今日未完成 + 今日成交”，支持 `strategyId` URL 参数；策略详情跳转自动带 `strategyId`；分页/排序/列配置/CSV；显示 `asOf` 和刷新状态；总持仓默认按账户分组，可展开策略。

---

### P1-11 API 合同缺幂等键、preview、订单类型和手工簿/未分配端点

**设计稿位置**：§13 API 草案、§10.3 手工单。

**问题**：§13 下单 JSON 只有 `strategyId/deploymentId/generation/accountId/counterpartyId/exchange/instrument/side/offset/price/qty/timeInForce`；缺：
- `clientRequestId` 幂等键；
- `previewId` / `previewVersion`；
- `orderType` / `reduceOnly`；
- 手工簿下单接口（是否也走 `/strategy/orders`？`MANUAL` 不是可部署策略）；
- 未分配列表/认领接口；
- 分页参数。

**交易员影响**：双击/超时重试重复下单；手工单与策略单走不同路径，归属不一致；无法查未分配。

**修改建议**：统一下单合同：策略单只传 `strategyId/deploymentId/generation/previewId/clientRequestId`，服务端解析 account/counterparty/exchange；手工单传 `bookId/accountId/exchange/previewId/clientRequestId`；服务端按 `clientRequestId` 幂等；补 `orderType/reduceOnly`；增加 `/books/{id}/orders`、`/unassigned`、`/strategies/{id}/deployments`；分页统一。

---

### P1-12 审计缺手工簿认领、策略迁移、权限拒绝、部署/应急范围

**设计稿位置**：§12 权限与审计。

**问题**：§12 只列“切换账户、部署、撤单、紧急操作记审计”和字段，没有定义：
- 手工单/成交认领到策略/手工簿；
- 策略迁移/epoch 变更；
- 权限拒绝、权限变更；
- 部署失败/回滚；
- 应急范围/逐账户结果；
- 未分配持仓调整。

**交易员影响**：P0 的持仓/PnL 差异事后无法追；不知道谁把成交认领到哪个策略；合规审计不完整。

**修改建议**：定义结构化事件：`BOOK_ASSIGN`、`STRATEGY_MIGRATE`、`DEPLOYMENT_CHANGE`、`PERMISSION_CHANGE`、`DENIED_TRADE`、`EMERGENCY_SCOPE`、`UNASSIGNED_ASSIGN`、`RECON_DIFF_ACK`；字段含 `userId/bookId/strategyId/deploymentId/accountId/counterpartyId/exchange/requestId/reason/before/after`；审计页支持按账户/策略/柜台过滤；心跳不入审计。

---

### P1-13 策略 PnL 的口径（FIFO/均价、手续费、结算价、期权 Greeks）没有定义

**设计稿位置**：§6.1 策略 PnL、§5.1 `realized_pnl/fees`、§10.1 PnL/风险。

**问题**：§6.1 只写 `realized + unrealized - fees`，没有定义：
- 已实现盈亏用 FIFO、加权平均还是交易所逐笔；
- 手续费在开/平仓如何分摊，是否与账户快照 `commission` 对齐；
- 未实现用最新价、买一/卖一、结算价还是理论价；
- 期权乘数、到期、Greeks、IV、行权/交割如何处理；
- `strategy_positions.realized_pnl/fees` 由谁更新（现状 `applyFill` 不更新）。

**交易员影响**：策略 PnL 与柜台/账户 PnL 口径不一致；期权策略的 Delta/Gamma/Vega 风险无法看；复盘归因错误。

**修改建议**：明确已实现方法（建议与柜台结算一致，或明确 FIFO 并说明差异）；手续费按成交逐笔计入 `trades.fee`，策略 PnL 汇总；未实现用可配置 `mark_source`（最新价/结算价/理论价），显示 `asOf`；期权增加乘数、到期、Greeks、IV，策略详情按标的/到期/交易所分组；`strategy_positions` 的 realized/fees 由成交事务更新；验收用例覆盖部分成交、平今/平昨、期权到期、手续费。

---

### P1-14 策略详情没有账户级风险上下文，共享账户其他策略不可见

**设计稿位置**：§4.4 策略详情、§10.1 概览/PnL/风险。

**问题**：策略详情只显示该策略数据（这是对的），但没有显示：
- 该策略所在账户的总保证金/可用/风险度；
- 同账户其他策略的持仓/占用（至少汇总）；
- 该策略亏损时对账户强平线的影响；
- 账户 PnL 与该策略 PnL 的差异。

**交易员影响**：看策略详情以为风险很小，实际同账户其他策略已把保证金用满；策略亏损可能触发账户强平，但详情页看不到。

**修改建议**：策略详情右栏/概览增加“账户上下文”卡片：账户权益/可用/保证金占用/风险度、同账户其他策略数量/合计持仓/合计 PnL、本策略占用估算、对账户 PnL 的贡献、对账差异；只读，不能在这里操作其他策略。

---

### P1-15 顶栏“系统健康”仍是全局汇总，不能表达某个柜台/交易所故障

**设计稿位置**：§4.1 顶部栏 `系统健康`、§4.2 接入/柜台总览。

**问题**：V2 移除当前柜台选择器后，顶栏只剩一个“系统健康”。多柜台/多交易所下，这个健康是“全部正常”还是“当前策略所在柜台正常”？如果任意柜台故障，顶栏是否变红？设计稿没有定义。

**交易员影响**：SIMVENUE 行情断了，顶栏仍绿；策略详情用旧价算 PnL；交易员不知道哪个柜台/交易所出了问题。

**修改建议**：顶栏“系统健康”显示汇总（红/黄/绿）+ 点击展开“按柜台/交易所”健康列表；策略详情头显示该策略所在柜台/交易所的健康和数据龄；柜台总览保留每个柜台/交易所的 `md age / ORS / recon / last error`；健康汇总规则明确（任一授权柜台 P0 故障则红）。

---

### P1-16 迁移方案没有覆盖现有手工单、旧 strategy_positions 和 SBE 版本

**设计稿位置**：§14 Phase 1。

**问题**：§14 Phase 1 只列新建表和加字段，没有：
- 现有 `orders.strategy_id` 为 null 的手工单如何回填 `MANUAL-<account>`；
- 现有 `trades` 没有 `strategy_id`，如何按 `client_order_id` 回填；
- 现有 `strategy_positions` 没有 `exchange/deployment/book`，如何迁移唯一键；
- 现有 `positions` 如何映射到 `account_positions`；
- 旧 SBE `strategyId int32` / `strategyKey` 如何兼容；
- 回填失败的订单/成交进入哪个队列、谁处理。

**交易员影响**：升级后历史订单/成交无归属，策略 PnL 从 0 开始；手工簿 PnL 缺失；旧策略持仓重复/丢失。

**修改建议**：写清迁移脚本和校验：`orders` 按 `source/strategy_id` 回填；`trades` 按 `client_order_id` 关联订单回填；`strategy_positions` 增加 `exchange/deployment/book`，迁移前去重；`positions` 映射 `account_positions`；旧 SBE 双写/版本兼容；迁移后跑 `orders without strategy = 0`、`trades without strategy = 0`、`strategy positions sum vs account` 报告；失败进入 `UNASSIGNED` 队列。

---

### P1-17 “1 柜台 = 1 账户”“1 策略 1 ACTIVE 部署”只写在文档，没有数据库约束

**设计稿位置**：§2 业务约束 2/4、§3.1 账户 1:1、§3.3 一个 ACTIVE deployment、§14 迁移。

**问题**：V2 把这两条当不变量，但没有对应的数据库约束/迁移校验：
- `accounts` 的 `counterparty_id` 没有唯一约束，管理员仍可把两个账户挂到同一柜台，或把运行中账户改到另一柜台；现状 `Accounts.tsx` 就允许直接改 `venue_id`。
- `strategy_deployments` 需要“每个策略最多一个 ACTIVE”，但只靠应用层判断；并发部署/旧进程可能产生两个 ACTIVE。
- 没有启动时 `invariants` 检查，也没有冲突时的审计/阻断。

**交易员影响**：两个 ORS/两个账户同时交易同一柜台；同一策略两个 ACTIVE 部署同时发单；策略持仓/PnL 双写；平仓/对账无法判断哪个是权威。

**修改建议**：加 `accounts.counterparty_id` 唯一约束（v1）+ `strategy_deployments(strategy_id) WHERE status='ACTIVE'` 部分唯一索引；账户改柜台必须 drain/cancel/reconcile 并禁止运行中修改；启动时跑 `invariants` 检查（重复 ACTIVE 账户/策略/order stream）并在 UI 显示；并发部署用乐观锁/generation；验收用例覆盖重复提交和旧进程。

---

## 6. P2（体验与打磨）

| ID | 问题 | 交易员影响 | 具体修改建议 |
|---|---|---|---|
| P2-01 | 策略列表 PnL 没有 `asOf`/来源/数据龄 | 不知道 PnL 是实时、延迟还是上一交易日 | 每个 PnL 带 `asOf`、`source`、`stale`；延迟/陈旧置灰 |
| P2-02 | 列表“状态”中英混用（ACTIVE/MANUAL/INACTIVE） | 扫读慢，误判 | 统一中文 + 英文 tooltip；状态色只用于 deployment 状态 |
| P2-03 | 策略详情 Tab 太多（8 个），默认页信息密度低 | 盘中找不到订单/持仓 | 默认概览只保留 PnL/持仓/风险/对账；订单/成交/日志可折叠；记住上次 Tab |
| P2-04 | 一级导航没有“最近策略/收藏” | 多策略时每次搜索 | 列表支持收藏/最近访问/固定策略；URL 可分享 |
| P2-05 | `MANUAL-<account>` 字符串可能超长/含特殊字符 | 迁移/显示异常 | 用 `book_id` UUID + `display_name`；字符串只做标签 |
| P2-06 | 未分配/手工簿/策略混在一个列表 | 视觉和统计污染 | 分区/筛选；未分配置顶红色 |
| P2-07 | 账户汇总页没有下钻到策略/订单 | 看到差异无法定位 | 账户行可展开策略、持仓、未分配、订单；带过滤跳转 |
| P2-08 | `UNASSIGNED` 没有颜色/数量 badge | 不知道有多少未归属 | 顶栏/导航 badge；超过阈值红色 |
| P2-09 | API 命名 `GET /strategies/{id}/summary` 等没有分页/版本 | 后期兼容困难 | 统一 `/api/v1/...` 分页/错误码/版本；OpenAPI 文档 |
| P2-10 | 策略列表/详情没有导出/打印/列配置 | 复盘/合规只能截图 | CSV/PDF 导出；列显示配置；保存视图 |

---

## 7. 交易员必须确认的问题

以下问题会直接改变数据模型和页面默认值，必须在开发前回答。V2 §16 已有 5 个，这里收敛并补充为 10 个：

1. **策略迁移**：策略换账户时，是新建策略 ID（推荐，历史清晰），还是保留同一策略 ID 并分 epoch？如果保留，旧账户未平持仓由谁负责、旧 PnL 如何冻结？
2. **手工簿粒度**：一个账户一个 `MANUAL-<account>` 够不够？是否需要按交易员/子策略/客户拆多个手工簿？手工簿是否出现在策略列表（建议单独分组，不算策略业绩）？
3. **共享账户平仓**：策略 A 只能平自己的持仓，还是允许在账户层面统一平？如果允许统一平，A/B 的 PnL 如何分配？建议严格按策略持仓，超平拒绝。
4. **账户 PnL 对账差异**：差异超过多少、持续多久要告警/阻止策略开仓？只显示、告警、还是硬阻断？请给具体金额/比例。
5. **共享账户保证金**：每个策略是否有独立保证金预算，还是账户统一占用、策略只做归因？如果策略 A 用满，B 是否应被拒绝开仓？
6. **策略跨交易所展示**：策略列表的“交易所”显示集合还是主交易所？策略详情默认“全部交易所”还是当前交易所？（V2 §16 第 1 问）
7. **期权链/行情入口**：V2 是否保留独立期权链/行情/手工交易页面？如果保留，放在哪个导航、如何带 `strategyId/accountId/counterpartyId`？
8. **应急当前策略**：在订单/成交/总持仓/监控页，“当前策略”如何确定？顶栏“只减仓/紧急操作”是当前策略、当前账户还是全局？建议策略详情默认当前策略，其他页面必须显式选。
9. **未分配/外部成交**：谁负责认领、多长时间内必须认领、未认领是否阻止该账户新开仓？外部成交是否允许直接归到手工簿？
10. **策略部署变更**：同账户换版本/换 generation 是否先撤单/平仓/对账？跨账户迁移是否必须人工审批（四眼）？旧 deployment 失败时是否自动回滚？

---

## 8. 上线前最小改造顺序（建议）

| 顺序 | 改造 | 完成标志 | 对应问题 |
|---|---|---|---|
| 1 | 账户持仓权威化 + 手工簿独立 book | 账户快照 vs 策略+手工的 diff 可见；手工簿只计一次；未分配不被配平 | P0-01、P0-05 |
| 2 | 策略平仓校验 + 并发锁 | A=2/B=8/账户=10 时 A 平 5 被拒；并发不超平 | P0-02 |
| 3 | 策略迁移/epoch 方案冻结 | §16 Q5 有结论；迁移/回滚验收通过 | P0-03 |
| 4 | SBE/CTP 归属链路 | 两策略同合约成交分别归属；手工单落 MANUAL；未知落 UNASSIGNED | P0-04 |
| 5 | 权限 + 应急当前策略 | 越权 403；策略详情只减仓只影响当前策略；全账户需显式确认 | P0-06、P0-07 |
| 6 | 行情键 + 路由/回报 fencing | 同合约两柜台不串价；旧 ORS 不覆盖新状态 | P0-08、P0-09 |
| 7 | 环境显性化 | 策略列表/详情/确认框显示 SIM/SHADOW/LIVE；LIVE 二次确认 | P0-10 |
| 8 | 最后移除顶部选择器/旧页面 | 6 个页面切换/策略上下文一致；用户不再反馈“页面没变化” | P0-08 |

**建议的最小验收用例（与 V2 §15 合并）**：

- `TC-V2-01`：账户快照比策略+手工多 1 手，页面显示 `UNASSIGNED=1`/`RECON_DIFF`，不自动配平；手工簿只计一次。
- `TC-V2-02`：A=2、B=8、账户=10；A 平 5 拒绝；A 平 2 后账户 8、A 0、B 8；并发两笔 A 平 2 只成功一笔。
- `TC-V2-03`：策略迁移后旧账户持仓 0/旧 epoch 冻结，新账户从 0 开始，策略 PnL 不跨账户混算。
- `TC-V2-04`：同账户 A/B 同合约成交，成交/持仓/PnL 分别归属；手工单落 `MANUAL-<account>`；未知外部成交落 `UNASSIGNED`。
- `TC-V2-05`：VIEWER/TRADER/ADMIN 权限矩阵；越权请求 403 且有审计。
- `TC-V2-06`：策略详情点“只减仓”只影响该策略；顶栏“全部账户”必须二次确认并显示逐账户清单；手工簿只显示手工动作。
- `TC-V2-07`：同合约在 SIMVENUE/SimNow 价格不同；策略 PnL、手工单预检、成交回报全部用各自 `(counterparty, exchange, instrument)` 价格。
- `TC-V2-08`：停 SIMVENUE ORS 返回 `NO_ACTIVE_ROUTE`；旧 ORS 回报被 `STALE_UPDATE` 丢弃；新 ORS 状态不被覆盖。
- `TC-V2-09`：策略列表/详情/手工确认显示环境；LIVE 下单有红色确认；SIM/SHADOW 不显示 LIVE。
- `TC-V2-10`：迁移脚本跑完后 `orders/trades without strategy = 0`（除明确的 UNASSIGNED）；`strategy_positions` 无重复键。

---

## 9. 附录：本次评审引用的现状证据

以下是“设计稿之外的现状”，用来证明上述风险不是假设；评审只读代码，没有修改。

1. `abi/sbe/quantlink-fin-sbe.xml`：`MarketData` 只有 `instrumentId/timestamp/...`，没有 `counterpartyId/exchange`；`OrderUpdate/Trade` 没有 `strategyId/deploymentId/accountId/counterpartyId/exchange`；`Trade` 没有 `accountId`；`PositionSnapshot` 没有 `exchange`；`OrderRequest.strategyId` 是 `int32`，V2 使用字符串策略 ID。
2. `backend/control-plane/.../market/StrategyOrderService.java`：平仓拆分 `splitClose` 与 `currentPosition` 使用 `accountId` 的账户持仓，不是策略持仓；`marketData.tick(instrumentId)` 是全局行情。
3. `backend/control-plane/.../market/StrategyPositionService.java`：`applyFill` 键为 `(strategyId, accountId, instrumentId)`，没有 `exchange`/`deployment`/`book`；只更新数量/均价，不更新 `realized_pnl/fees`。
4. `backend/control-plane/.../market/StrategyPnlService.java`：`marketData.tick(instrumentId)` 全局取价；注释明确“shared-instrument strategies should add an explicit position ownership key”。
5. `backend/control-plane/.../market/StrategyCloseoutScheduler.java`：遍历 `strategy_positions` 中除 `futures_pair` 外的所有策略，收盘前调用 `flattenStrategy`；手工簿如果进入 `strategy_positions` 会被纳入。
6. `backend/control-plane/.../api/EmergencyController.java`：`flattenStrategy` 要求策略有 deployment/ORS；手工簿没有 deployment，会失败/刷日志。
7. `backend/control-plane/.../market/ScopedReconciliationService.java`：只做 `strategy_positions vs strategy trades` 和 `account_positions vs account trades`，没有 `account_position vs sum(strategy)+manual+unassigned`。
8. `backend/control-plane/.../aeron/ManualOrderPublisher.java`：手工单 `strategyId(0)`、`strategyKey` 传空串；SBE 回报无法恢复 `MANUAL-<account>`。
9. `backend/control-plane/.../api/TradingController.java`：手工单插入 `orders` 时没有 `strategy_id`；没有账户权限校验；没有 `counterparty_id/exchange` 快照。
10. `backend/control-plane/.../market/AccountSnapshotService.java` / `account_snapshots`：只有 `balance/available/margin/commission/snapshot_at`，没有权益、出入金、已实现/未实现、PnL 基线。
11. `backend/control-plane/.../market/StrategyPnlService.java` 与 `strategy_daily_state`：策略日 PnL 与账户快照没有统一对账口径。
12. `backend/control-plane/src/main/resources/mapper/StrategyPositionMapper.xml`：唯一冲突键 `(strategy_id, account_id, instrument_id)`，没有 `exchange/deployment/book`。
13. `backend/control-plane/.../config/SecurityConfig.java`：只有全局角色；GET 任意账户对 VIEWER 可见。
14. `web/src/pages/ManualOrder.tsx` / `OptionChain.tsx`：手工单仍有独立账户下拉；期权链快捷下单固定 `offset: 'OPEN'`；预检 key 不包含账户/柜台。V2 需要明确这些页面保留还是重做。

---

*本评审只针对设计稿，不修改源代码或设计稿。建议按第 8 节顺序逐项关闭 P0 后再复审；P0-01/P0-02/P0-04/P0-05 未关闭前，不建议上线任何策略 PnL/持仓页面。*

# 交易员最终复核：策略中心 V2.1 三个阻塞项

- 日期：2026-11-09
- 评审对象：`docs/architecture/23-策略中心V2设计稿.md`（V2.1 DRAFT）
- 复审基线：`docs/reviews/trader-review-2026-11-09-strategy-centric-v21-final.md`
- 评审范围：仅核上一轮剩余的 P0-03、P1-13、P1-09
- 结论：**REQUEST_CHANGES**
- 统计：**3 项中 1 CLOSED / 2 PARTIAL / 0 OPEN**

> P0-03 的 schema 和 §3.4/§16 规则已经补上；P1-09 的枚举已统一；但 P0-03 的 §13 API 校验仍只写 Agent，P1-13 的 PnL 口径仍只留在 §17。两项都是小范围文字/合同补齐，不是推倒重来。

---

## 0. 本次核对的三个点

| 项 | 状态 | 结论 |
|---|---|---|
| P0-03 策略绑定四元组/Fork | **PARTIAL** | `strategies` 已列四元组，§3.4 有四元组校验，§16 已改；但 §13 部署接口的“额外校验”仍只比较 `bound_agent_id`，没有比较 counterparty/account/ors |
| P1-13 策略 PnL 口径/期权 Greeks | **PARTIAL** | `book_positions` 已有 `realized_pnl/fees`；但 §6.1 仍只有公式，FIFO/手续费/mark source/期权 Greeks 只在 §17 |
| P1-09 状态枚举/三列 | **CLOSED** | §3.4 与 §4.3 已统一 `strategy_status` / `deployment_status`；`BOUND/RUNNING` 不再混用 |

---

## 1. P0-03：PARTIAL（只差 §13 API 四元组校验）

**设计稿位置**：§3.3、§3.4、§3.6、§13、§16。

**已关闭的部分**：
- §3.3 已列 `bound_agent_id / bound_counterparty_id / bound_account_id / bound_ors_id`。
- §3.4 的 `strategies` 表已列四元组；首次部署写入、不可变。
- §3.4 已写数据库/服务端四元组逐项校验，并定义 `409 STRATEGY_BOUND_TO_CONTEXT`。
- §3.4 已明确 `bound_ors_id` 是逻辑 ORS 槽位，进程重启/PID 变化不改变；换 `ors_id` 必须 Fork。
- §16 已改为“Fork 必须指向新的 Agent/账户/柜台/ORS 四元组；同账户不能创建第二个 ORS；同账户多策略共享同一 ORS”。

**剩余问题**：
- §13 “部署接口额外校验”仍只写：

  ```text
  if strategy.bound_agent_id != null
     and request.agentId != strategy.bound_agent_id
  → 409 STRATEGY_BOUND_TO_CONTEXT
  ```

  没有比较 `request.counterpartyId / accountId / orsId` 与 `bound_counterparty_id / bound_account_id / bound_ors_id`。
- §3.4 的服务端校验是原则，§13 是 API 合同；实现者可能两个都写，也可能只按 §13 写。两份合同不一致，不能算 CLOSED。
- §3.6 Fork 文案仍写“可选择新的 Agent / 柜台 / 账户”，没有在同一处重复“四元组/新 ORS”；§3.4 虽有规则，但 Fork 弹窗/API 以 §3.6 为准时容易漏 ORS。

**交易员影响**：
- 版本更新/部署接口只校验 Agent，客户端仍可能把 account/counterparty/ors 换成另一个，形成事实迁移；旧仓/PnL 留在旧账户，新策略在新账户开仓。
- Fork 到同账户若只按 §3.6 选择“新 Agent + 同账户”，仍可能撞上一账户一 ORS；交易员看到的是“部署成功/失败”而不是“需要 Fork 新账户”。

**具体修改建议**：
1. 把 §13 的额外校验改成四元组逐项比较：
   ```text
   if strategy.bound_agent_id != null
      and (request.agentId != bound_agent_id
        or request.counterpartyId != bound_counterparty_id
        or request.accountId != bound_account_id
        or request.orsId != bound_ors_id)
   → 409 STRATEGY_BOUND_TO_CONTEXT
   ```
2. 部署、版本更新、回滚、Fork 四条路径共用同一个 `validateBoundContext()`，不要只在 deploy 接口写。
3. §3.6 Fork 弹窗增加“目标 ORS”字段，并明确“新 Agent 必须新账户/柜台/ORS；同账户只能共享同一 ORS”。
4. 验收用例：只改 account、只改 ors、只改 counterparty 三种请求都必须 409；同账户 Fork 在旧 ORS ACTIVE 时必须 409；同一逻辑 ORS 进程重启后可恢复。

---

## 2. P1-13：PARTIAL（正文 §6.1 仍只有公式）

**设计稿位置**：§3.7、§6.1、§6.2、§6.4、§10.1、§17 P1-13。

**已关闭的部分**：
- `book_positions` 已增加 `realized_pnl`、`fees`（§3.7）。
- `strategy_positions` 已有 `realized_pnl/fees`，§3.7 要求成交事务同步更新。
- `account_pnl_snapshot` 已有 equity/cash/deposit/withdraw/realized/unrealized/fees/source/stale（§6.4）。
- 账户 PnL 阈值、diff/tolerance/stale 已在 §6.4/§18。
- 策略详情“账户上下文”已在 §10.1。

**剩余问题**：
- §6.1 仍只有：

  ```text
  strategy PnL = realized PnL + unrealized PnL - fees
  ```

  没有定义：
  - 已实现用 FIFO、加权平均还是柜台逐笔；
  - 手续费按开/平仓如何分摊，如何与账户快照 `commission` 对齐；
  - 未实现用 `LAST/SETTLEMENT/THEORETICAL` 哪个，`asOf` 如何处理；
  - 期权乘数、到期、Greeks、IV、行权/交割；
  - `book_positions.realized/fees` 与 `trades.fee` 的口径关系。
- 这些只在 §17 P1-13 和 §16 第 3 条出现；正文 §6.1/§10.1 不完整。实现者按 §6.1 写代码，只能得到“cash flow + market value - fees”的一种隐式口径，无法与柜台/账户 PnL 对账。

**交易员影响**：
- 策略 PnL 与账户 PnL 差异无法解释：可能是 FIFO/均价、手续费、结算价、期权乘数，交易员不知道哪个是真实归因。
- 期权做市策略看不到 Delta/Gamma/Vega/Theta/IV，无法判断真实风险；策略 PnL 曲线无法用于复盘。
- `book_positions` 有 realized/fees 但无计算规则，手工簿 PnL 可能重复或漏算手续费。

**具体修改建议**：
1. §6.1 增加“PnL 口径”小节：
   - 已实现：FIFO（与柜台差异显式标注）或与柜台一致的加权平均，冻结默认；
   - 手续费：按 `trades.fee` 逐笔计入，账户快照 `commission` 只用于对账；
   - 未实现：`mark_source=LAST/SETTLEMENT/THEORETICAL`，每个值带 `asOf/source`；
   - 账户/策略差异项：手续费、结算价、出入金、未分配。
2. `book_positions` 的 `realized_pnl/fees` 与 `trades.fee` 二选一作为源，另一个仅对账，不能双记。
3. 期权策略增加 `option_greeks/iv` 快照或实时计算字段；策略详情按标的/到期/交易所分组显示 Delta/Gamma/Vega/Theta/IV 及 `asOf`。
4. §10.1 PnL/风险补“已实现/未实现/手续费/资金费”四项、mark source、Greeks、对账差异。
5. 验收：部分成交、平今/平昨、手续费、结算价切换、期权到期/行权的 PnL 与账户快照对账；手工簿不与策略/未分配重复。

---

## 3. P1-09：CLOSED

**设计稿位置**：§3.4、§4.3、§17 P1-09。

**核对结果**：
- §3.4 已统一：
  - `strategy_status: DRAFT / VALIDATED / ARCHIVED`
  - `deployment_status: UNBOUND / BOUND / ACTIVE / INACTIVE / FAILED / STOPPING / ROLLED_BACK`
- §4.3 列表已用同一套枚举，`book_type` 单独表示策略/手工簿/UNASSIGNED；`BOUND/RUNNING` 不再混在 `strategy_status`。
- §17 P1-09 与正文一致。

**非阻塞文字项**：§17 P1-07 的状态机写 `UNBOUND → BOUND → ACTIVE / FAILED / STOPPING / ROLLED_BACK`，漏了 §3.3 的 `ACTIVE → STOPPING → INACTIVE`；不影响 P1-09 关闭，但建议补 `INACTIVE` 分支，避免实现者漏掉“停止后未激活”状态。

---

## 4. 正文与 §17 的残余不一致（仅列剩余）

| 编号 | 不一致 | 位置 | 处理 |
|---|---|---|---|
| R-01 | §13 只校验 `bound_agent_id`，§3.4 要求四元组 | §13 vs §3.4 | P0-03 修复项；补 counterparty/account/ors 检查 |
| R-02 | §6.1 只有公式；FIFO/mark/Greeks 只在 §17 | §6.1 vs §17 P1-13 | P1-13 修复项；补正文小节 |
| R-03 | §17 P1-07 状态机漏 `INACTIVE` | §17 P1-07 vs §3.3 | 非阻塞，补一行 |
| R-04 | §8.5 `OrderUpdate/Trade` 字段清单未列 `routeId/orderEpoch`，公共字段表有 | §8.5 | 非阻塞，补清单或注明“公共字段表适用所有 V2 消息” |
| R-05 | §15 验收“策略+手工+未分配=账户持仓”仍像配平公式 | §15 | 非阻塞，改成“unassigned = account - attributed，差额=UNASSIGNED 账本” |

---

## 5. 是否允许进入 Phase 1

**当前不允许无条件进入 Phase 1；只差一个 P0 修复。**

- **Phase 1 前置**：P0-03 的 §13 API 四元组校验补完后即可进入 Phase 1。数据模型、SBE v2、权限 enforcement、行情键、`book_positions` 已经足够。
- **Phase 2 前置**：P1-13 的 §6.1 PnL 口径必须在 Phase 2 前补；否则策略 PnL/账户 PnL 对账没有统一口径。
- **Phase 3 前置**：P1-09 已 CLOSED，无阻塞。
- P2 无阻塞项；R-03/R-04/R-05 是非阻塞文字清理。

**最小阻塞清单**：
1. P0-03：§13 补 `bound_counterparty_id / bound_account_id / bound_ors_id` 校验（唯一 Phase 1 阻塞）。
2. P1-13：§6.1 补 FIFO/手续费/mark source/期权 Greeks（Phase 2 前）。
3. P1-09：无（仅 R-03 文字补 `INACTIVE`）。

---

## 6. 仍需业务确认的参数

1. **Fork 同账户规则**：§3.4/§16 已选“同账户不能创建第二个 ORS，同账户多策略共享同一 ORS”。请确认交易员接受“同账户 Fork 到另一个 Agent 不允许”，而不是希望旧 ORS 释放后允许同账户新 ORS。
2. **策略 PnL 已实现口径**：FIFO，还是与柜台结算一致的加权平均？若 FIFO，与柜台差异是否只显示不阻断？
3. **未实现 mark source**：`LAST/SETTLEMENT/THEORETICAL` 默认用哪个？期货/期权是否分开配置？
4. **账户 PnL 阈值**：`max(100 CNY, 0.1% equity)`、连续 2 次、快照 `age > 5s` 阻止开仓，是否符合当前账户规模/波动？
5. **UNASSIGNED 阈值**：数量 > 0 持续 60s 告警；重大金额/手数是否阻止该账户新开仓？阈值多少？
6. **版本更新默认平仓**：默认“停止新开仓→撤单→平仓→对账→更新”，做市/对冲策略日常升级是否接受？
7. **手工簿粒度**：一账户一个 `MANUAL-<account>`，还是按交易员/子策略拆分？v1 是否接受单手工簿。

---

## 7. 复核依据

- §3.3/§3.4：四元组字段、四元组 DB/服务端校验、`STRATEGY_BOUND_TO_CONTEXT`、`bound_ors_id` 逻辑槽位、Fork 目标规则。
- §13：部署接口“额外校验”实际只比较 `bound_agent_id`（P0-03 剩余）。
- §3.7：`book_positions` 已有 `realized_pnl/fees`；§6.1 仍只有策略 PnL 公式（P1-13 剩余）。
- §3.4/§4.3：`strategy_status` 与 `deployment_status` 已统一（P1-09 CLOSED）。
- §17 P1-07 状态机漏 `INACTIVE`、§8.5 字段清单漏 `routeId/orderEpoch`、§15 公式措辞，均为非阻塞文字项。

---

*本评审只针对设计稿，不修改源代码或设计稿。P0-03 的 §13 四元组校验是唯一 Phase 1 阻塞项；修完即可进入 Phase 1，P1-13 在 Phase 2 前补。*

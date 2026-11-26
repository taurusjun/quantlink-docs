# 交易员最终确认：V2.1 两项阻塞项复核

- 日期：2026-11-09
- 评审对象：`docs/architecture/23-策略中心V2设计稿.md`
- 复核范围：仅 P0-03（§13 四元组校验）、P1-13（§6.1 PnL 口径）；P1-09 上一轮已 CLOSED
- 结论：**APPROVE**
- 两项状态：**P0-03 CLOSED；P1-13 CLOSED**
- Phase 1：**允许进入**

---

## 1. P0-03：CLOSED

**核对位置**：§3.3、§3.4、§3.6、§13、§16、§17 P0-03。

**已关闭证据**：
- §3.3/§3.4 的 `strategies` 已列 `bound_agent_id / bound_counterparty_id / bound_account_id / bound_ors_id`，首次部署写入且不可变。
- §3.4 已要求数据库/服务端四元组逐项校验，并定义 `409 STRATEGY_BOUND_TO_CONTEXT`。
- §3.4 已明确 `bound_ors_id` 是逻辑 ORS 槽位：进程重启/PID 变化不改变，换 `ors_id` 必须 Fork。
- §13 部署接口已改为 `validateBoundContext(strategy, request)`，同时比较：
  - `request.agentId == bound_agent_id`
  - `request.counterpartyId == bound_counterparty_id`
  - `request.accountId == bound_account_id`
  - `request.orsId == bound_ors_id`
- §13 明确 `validateBoundContext()` 由部署、版本更新、回滚、Fork 目标校验共用，不能只比 `agent_id`。
- §16 已统一为“Fork 必须指向新的 Agent/账户/柜台/ORS 四元组；同一账户不能创建第二个 ORS；同账户多策略共享同一 ORS”。

**结论**：正文、§13 API 合同、§17 矩阵一致；无剩余阻塞。P0-03 **CLOSED**。

---

## 2. P1-13：CLOSED

**核对位置**：§3.7、§6.1、§6.2、§6.4、§17 P1-13。

**已关闭证据**：
- §6.1 已补完整 PnL 口径：
  - 已实现：FIFO，逐笔成交归属策略；
  - 手续费：`trades.fee` 逐笔计入，策略 PnL 汇总；
  - 未实现：`LAST / SETTLEMENT / THEORETICAL` 可配置；
  - 期货：盘中 LAST，日终 SETTLEMENT；
  - 期权：合约乘数 + mark source + Greeks/IV，按标的/到期/交易所分组；
  - 手工簿：`book_positions.realized_pnl/fees` + 行情估值；
  - 账户 PnL：柜台快照权威，差异显示 `RECON_DIFF`；
  - 所有 PnL 带 `asOf/source/stale`；FIFO 与柜台差异只显示，不覆盖。
- §3.7 `book_positions` 已含 `realized_pnl/fees`，与 §6.1 手工簿口径一致。
- §6.4 已定义 `account_pnl_snapshot`、上一结算日基准、出入金/手续费/交割行权/资金费、diff/tolerance/stale、快照陈旧阻止新开仓。
- §17 P1-13 与正文一致。

**结论**：正文不再只有公式，FIFO/手续费/mark source/期权 Greeks/手工簿/账户对账均有可执行定义。P1-13 **CLOSED**。

---

## 3. Phase 1 准入

**允许进入 Phase 1 实现。**

理由：
- P0-03 已闭合，§13 四元组校验与 §3.4/§16 一致；Phase 1 的 schema/部署合同不再阻塞。
- P1-13 已闭合；Phase 2 的策略 PnL/账户 PnL 对账口径不再阻塞。
- P1-09 上一轮已 CLOSED；Phase 3 的状态枚举无阻塞。
- 本轮未发现新的 P0/P1/P2 阻塞项。

**实施边界**：
- Phase 1 按 §14 执行：数据模型、SBE v2、权限 enforcement、行情键、`book_positions`、迁移脚本、四元组约束。
- Phase 2 前确认 `validateBoundContext()` 与所有版本/回滚/Fork 路径共用，并有四元组不匹配的 409 验收。
- Phase 3 前按已冻结的 `strategy_status / deployment_status` 实现列表。

---

## 4. 非阻塞文字项（不影响本次结论）

1. §17 P1-07 状态机写 `UNBOUND → BOUND → ACTIVE / FAILED / STOPPING / ROLLED_BACK`，可补 `ACTIVE → STOPPING → INACTIVE` 分支；正文 §3.3 已有，不影响 P1-09 关闭。
2. §8.5 的 `OrderUpdate/Trade` 字段清单可补 `routeId/orderEpoch`，或注明“公共字段表适用于所有 V2 消息”；不影响 P0-03/P1-13。
3. §15 验收“策略+手工+未分配=账户持仓”建议改成“unassigned = account - attributed”，避免实现者误当配平项；不影响本次结论。

---

*本评审只针对两项阻塞项及 Phase 1 准入；未修改源代码或设计稿。*

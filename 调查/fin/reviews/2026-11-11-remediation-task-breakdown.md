# 交易端改造任务拆解与测试用例

- 日期：2026-11-11
- 上游：`docs/reviews/2026-11-11-trading-ux-remediation-plan.md`（PLAN-01…31）
- 目的：把 PLAN 拆成可执行任务（T-xx），为每个任务补验证用例（UT/CT/E2E/VIS），并给出 E2E 回归的更新清单。
- 状态约定：`TODO` / `DOING` / `DONE`；测试状态 `PLANNED` / `AUTO` / `MANUAL`。

---

## 0. 总览

| Wave | 任务数 | 目标 | 出口门槛 |
|---|---|---|---|
| Wave 0 | 6 | 消除“界面在骗人”的功能性错误 | 900px 可用；单笔撤单可用；回归 39/39 |
| Wave 1 | 8 | 让“不能交易”可见、可处置 | 状态灯/阻塞条/告警聚合/逐柜台健康/订单 blotter |
| Wave 2 | 6 | 误操作防护与限仓 | 版本不隐式平仓；手工单合规；限额前置 |
| Wave 3 | 6 | 数据可信与实时 | 所有数字带 asOf；无过期样式；实时刷新 |
| Wave 4 | 6 | 一屏驾驶舱与收盘 | 1920 一屏；5 组导航；收盘清单 |

任务编号规则：`T-W<wave>-<两位序号>`；测试编号：`UT-`（单元）、`CT-`（契约/集成）、`E2E-`（端到端）、`VIS-`（视觉）。

---

## 1. Wave 0 · 立即修复（6 个任务）

### T-W0-01 执行页表格列对齐

- PLAN：PLAN-08（UX P0-6）
- 改动：`web/src/pages/Execution.tsx` 用列定义数组驱动表头与单元格；登录/心跳/PID/Fencing/stream 拆列。
- 依赖：无。
- 测试：
  - `UT-W0-01`：列定义长度 == 表头数 == 每行 cell 数（Vitest/React Testing Library 或纯函数断言）。
  - `E2E-B10-013`：打开 `/execution`，断言每张表 `thead th` 数 == 每行 `td` 数。
- 验收：三张表无错位；登录时间与心跳时间分别可见。
- 规模：S。

### T-W0-02 时区统一

- PLAN：PLAN-14（TR-17）
- 改动：`StrategyCenter.tsx:829` 等禁止 ISO `slice`；统一 `formatTime(ts)` → `Asia/Shanghai` + `CST`。
- 测试：
  - `UT-W0-02`：`formatTime('2026-11-11T10:57:24Z') === '2026-11-11 18:57:24 CST'`。
  - `E2E-B10-014`：驾驶舱与策略中心“快照时间”差值 < 2 分钟。
- 验收：同屏不出现相差 8 小时的时间。
- 规模：S。

### T-W0-03 总持仓进页即拉取

- PLAN：PLAN-15（TR-14）
- 改动：`OrdersV2.tsx` 挂载即请求 positions；tab 计数使用已加载数据。
- 测试：
  - `E2E-B10-015`：进入 `/orders` 首屏，标签“总持仓 (N)”N 等于接口返回行数。
- 验收：无需点开 tab 即显示正确计数。
- 规模：S。

### T-W0-04 快照覆盖标记

- PLAN：PLAN-07（UX P0-5 / TR-08）
- 改动：`Dashboard.tsx` 聚合值显示 `覆盖 1/3`、`asOf`；不足 100% 加“部分”前缀；缺失显示 `—` 而非 0。
- 测试：
  - `UT-W0-04`：`aggregate([{equity:100}], 3)` → `{value:100, partial:true, covered:1}`。
  - `E2E-B10-016`：mock/拦截 `account_snapshot` 仅 1 条，断言首页出现“部分/1 of 3”。
- 验收：覆盖不足时不出现无前缀“总权益”。
- 规模：S。

### T-W0-05 已部署策略编辑入口改道

- PLAN：PLAN-16（TR-15）
- 改动：`StrategyCenter.tsx` 的编辑按钮先判断 `deploymentState/actualState`；已部署 → 打开“新建版本”表单并预填；后端 409 文案中文化。
- 测试：
  - `CT-W0-05`：已部署策略 `PUT /strategies/{id}` 返回 409 + 中文提示。
  - `E2E-B6-016`：已部署策略点“编辑策略”，不出现英文 409，直接进入版本表单。
- 验收：不再出现 `strategy is deployed` 英文原文。
- 规模：S。

### T-W0-06 单笔撤单

- PLAN：PLAN-04（UX P0-1 / TR-05）的第一刀
- 改动：`OrdersV2.tsx` 操作列「撤单」，`OPEN/PARTIAL` 可用；调用 `POST /api/v1/strategy/orders/{id}/cancel`；行内展示回执。
- 测试：
  - `CT-W0-06`：cancel API 对 OPEN 单返回 200，对 FILLED 返回 409。
  - `E2E-B10-017`：创建一笔挂单 → 行内撤单 → 2s 内状态 `CANCEL_REQUESTED/ CANCELED`。
- 验收：单笔撤单 ≤2 次点击；失败原因可见。
- 规模：M。

**Wave 0 Gate**：`run-regression --all` 39/39；900px 关键操作可达；新增 E2E 用例全部通过。

---

## 2. Wave 1 · 交易安全与可见性（8 个任务）

### T-W1-01 单一 runState

- PLAN：PLAN-01（TR-01）
- 改动：
  - 控制面 `overview` 派生 `runState`（9 态），映射表：`UNDEPLOYED/INACTIVE/STARTING/ACTIVE/DEGRADED/STOPPING/STOPPED/ERROR/HALTED`。
  - 驾驶舱/策略列表只渲染一个 `StatusChip`；`desired/actual` 放 tooltip。
- 依赖：T-W1-04（逐柜台健康可用于 DEGRADED）。
- 测试：
  - `UT-W1-01`：9 组输入 → 9 个输出，覆盖优先级（ERROR > HALTED > DEGRADED > ACTIVE）。
  - `CT-W1-01`：`GET /strategy-center/overview` 每条策略含 `runState`，值在枚举内。
  - `E2E-B6-011`：同一行不再出现“部署 INACTIVE + 策略 ACTIVE”并存。
- 验收：页面只出现一个状态词；交易员可判断“在不在发单”。
- 规模：M。

### T-W1-02 拒单/风控 KPI 与阻塞条

- PLAN：PLAN-02（TR-03）
- 改动：
  - 后端 `overview` 增加今日 `orderCount/fillCount/rejectCount`、`rejectReasons[0..n]`（来自 orders `status=REJECTED`）。
  - 驾驶舱 KPI 增加“拒单”；5 分钟内 `rejectCount>0` 显示红色阻塞条 + 首条 reason + 处置按钮。
- 测试：
  - `CT-W1-02`：插入 3 条 REJECTED 订单 → overview 计数为 3，reason 非空。
  - `E2E-B3-008`：风控快照过期时下单被拒，驾驶舱 2s 内出现红色阻塞条。
- 验收：拒单不再“隐身”；阻塞条可点击到订单/告警。
- 规模：M。

### T-W1-03 告警指纹聚合与分级

- PLAN：PLAN-03（TR-02 / UX P1-5）
- 改动：
  - `strategy_alerts` 增加 `fingerprint`（复用 `reason_code` + instrument + side）、`severity`、`occurrence_count`、`last_seen`。
  - 60s 内同指纹只更新计数；默认展示 P0/P1；>24h 过期；P0 未 ack 5 分钟升级。
  - 聚合在服务端完成，前端只渲染。
- 测试：
  - `UT-W1-03`：fingerprint 生成稳定（同 reason code + instrument + side 相同）。
  - `CT-W1-03`：连续 3 条同指纹 → 1 行，`occurrence_count=3`。
  - `E2E-B8-008`：告警页 3 分钟内同故障只出现 1 条，显示 count。
- 验收：3 分钟 500 条同指纹不再刷屏；P0 可识别。
- 规模：M。

### T-W1-04 逐柜台健康

- PLAN：PLAN-10（TR-12 / UX P1-12）
- 改动：顶栏读取 `/system/status` 的 `ors[]`，显示“柜台 N/M 在线”，展开逐柜台（ORS/agent/行情龄/最后 tick）；任一 HALTED 不显示“通道正常”。
- 测试：
  - `CT-W1-04`：`/system/status` 返回每柜台状态与 `marketAgeMs`。
  - `E2E-B10-010`：模拟 1/3 在线，顶栏显示“1/3”且无“通道正常”。
- 验收：交易员能回答“哪个柜台还能发单”。
- 规模：M。

### T-W1-05 危险动作统一对话框

- PLAN：PLAN-05（UX P0-2/P0-3 / TR-13）
- 改动：
  - 新增 `DangerousActionDialog`（动作、对象、环境、账户、影响数量）。
  - 策略详情动作分三组；危险组折叠“更多”；激活/停用/停止/停止并平仓统一确认；删除仅 STOPPED 且无持仓/挂单，需输入策略 ID。
- 测试：
  - `UT-W1-05`：影响面文案生成（N 单/M 手/账户）。
  - `E2E-B6-013`：点“停止并平仓”先显示影响面，未确认不发 API。
- 验收：详情 ≤1 主操作 + 更多；所有状态变更都有确认。
- 规模：M。

### T-W1-06 订单 blotter（详情/批量/作用域撤单）

- PLAN：PLAN-04（UX P0-1）
- 改动：订单页默认“今日+未完成”；操作列（撤单/详情）；批量勾选撤单；行详情生命周期与成交明细；作用域撤单“撤当前筛选(N)”。
- 测试：
  - `CT-W1-06`：批量 cancel 对 N 单逐单返回结果。
  - `E2E-B10-007`：勾选 3 单 → 确认框显示 N=3 → 逐单回执。
- 验收：批量确认列出订单号/合约/方向/数量/账户/策略。
- 规模：L。

### T-W1-07 响应式与设计系统基座

- PLAN：PLAN-06/22（UX P0-4 / P1-2/3/4/6/13）
- 改动：`PageHeader`、`FilterBar`、`DataTable`、`StatusChip`、`FreshnessBadge`、formatter；三档宽度（≥1440/1280/900）。
- 测试：
  - `VIS-W1-07`：1440/1280/900 三档视觉基线。
  - `E2E-B10-008`：900px 下 `document.documentElement.scrollWidth === 900`，期权链 Put 侧可滚动，策略操作列可点击。
- 验收：900px 无不可达控件；宽表内部滚动，不被 Card 裁切。
- 规模：L。

### T-W1-08 手工单价合规与行情龄

- PLAN：PLAN-09（TR-04）
- 改动：默认对手价；↑↓ 按 `tickSize` 步进；非整数倍禁用；显示 tick 龄/柜台；偏离最新价 >2% 二次确认。
- 测试：
  - `UT-W1-08`：`roundToTick(866.5739, 0.02) === 866.58`。
  - `E2E-B10-009`：输入非整数倍 → 提交按钮禁用并提示。
- 验收：不能提交非 tick 整数倍价格。
- 规模：M。

**Wave 1 Gate**：盘前能一屏判断能否开；拒单/风控不可见问题消失；订单可单笔/批量撤；900px 可用；回归 39/39 + 新增用例。

---

## 3. Wave 2 · 误操作防护与额度（6 个任务）

| 任务 | PLAN | 改动 | 测试 | 验收 |
|---|---|---|---|---|
| T-W2-01 版本表单化 + diff | PLAN-19/23 | 版本表单预填当前配置、自动递增、发布前 diff | `CT-W2-01` 版本行完整快照；`E2E-B6-014` diff 可见 | 不存在手写 JSON 路径 |
| T-W2-02 发布不隐式平仓 | PLAN-19（REQ-09） | 有持仓且未勾 carry → 显示撤单/平仓影响并要求输入策略 ID；未确认不调用 `/emergency/stop` | `E2E-B6-012` 拦截并断言无 emergency 请求 | 不会静默平仓 |
| T-W2-03 手工单合约搜索/预览 | PLAN-20 | 合约模糊搜索、五档盘口、保证金/限仓预览；未预览不可提交 | `E2E-B10-018` 选错合约被阻止 | 预览含名义/保证金/可用 |
| T-W2-04 限仓额度上送与前置校验 | PLAN-18（REQ-20） | 运行体上报 `limit/used/remaining/utilization`；驾驶舱/下单展示；≥80% 琥珀、≥100% 禁用开仓 | `CT-W2-04` overview 含限额；`E2E-B3-009` 超限被拒并给原因 | 前端不计算限仓 |
| T-W2-05 只减仓确认与常驻 banner | PLAN-29 | 开关确认影响面；开启后所有交易页 banner、开仓按钮禁用 | `E2E-B10-019` 刷新后 banner 仍在 | 误触可恢复 |
| T-W2-06 告警静默规则 | PLAN-24（REQ-22） | `(策略,合约,指纹) × 30m/4h/当日`；规则可见可撤销 | `CT-W2-06` 静默期内计数累计但不弹窗 | 噪音可治理 |

**Gate 2**：带仓升级被拦截；限仓前置生效；手工单合规；回归 39/39。

---

## 4. Wave 3 · 数据可信与实时（6 个任务）

| 任务 | PLAN | 测试 |
|---|---|---|
| T-W3-01 统一 asOf/新鲜度 | PLAN-13/07/10 | `UT-W3-01` 阈值；`E2E-B10-011` 过期降级 |
| T-W3-02 订单/成交/策略实时 | PLAN-15（REQ-15/16） | `E2E-B10-020` 新成交 2s 内出现 |
| T-W3-03 PnL 双口径 | PLAN-11 | `E2E-B6-017` 两个口径均有标注 |
| T-W3-04 指标阈值/格式 | PLAN-12（REQ-17） | `CT-W3-04` 0/0 → UNCONFIGURED；`E2E-B7-008` |
| T-W3-05 未归属下钻/批量认领 | PLAN-17（REQ-14） | `E2E-B6-018` KPI 可点击、批量认领 |
| T-W3-06 格式化/颜色/文案 | PLAN-22/26/27 | `VIS-W3-06` 无原始浮点/ISO/英文分页；AA 对比 |

**Gate 3**：任何数字可追溯来源与时间；无过期样式；实时刷新可见。

---

## 5. Wave 4 · 一屏驾驶舱与收盘（6 个任务）

| 任务 | PLAN | 测试 |
|---|---|---|
| T-W4-01 B 式一屏布局 + kiosk | PLAN-31（REQ-18/23） | `VIS-W4-01` 1920 无滚动可见 KPI+≥12 行+右栏 |
| T-W4-02 5 组导航与职责合并 | PLAN-21（UX P1-1） | `E2E-B10-021` 一级入口 ≤16；旧路由重定向 |
| T-W4-03 快捷键 F2/F3/F8/F12 | PLAN-29（REQ-19） | `E2E-B10-022` 快捷键触发对应确认 |
| T-W4-04 收盘 checklist + 日报 | PLAN-28（REQ-21） | `E2E-B11-006` 收盘前 15 分钟出现清单 |
| T-W4-05 期权链/手工簿/表格增强 | PLAN-30 | `VIS-W4-05` 微笑图/多 Greek/display_name |
| T-W4-06 视觉基线进 CI | PLAN-22/06 | `VIS-W4-06` 三档基线门禁 |

**Gate 4**：交易员可用性走查通过；视觉基线纳入 CI；回归 39/39。

---

## 6. 测试用例目录（按类型）

### 6.1 单元（UT）

| ID | 目标 | 断言 |
|---|---|---|
| UT-W0-01 | 执行页列定义 | 表头数 == cell 数 |
| UT-W0-02 | 时间格式 | UTC→CST 正确 |
| UT-W0-04 | 聚合覆盖 | partial/covered/asOf |
| UT-W1-01 | runState 映射 | 9 态优先级 |
| UT-W1-03 | 告警指纹 | 同 code+instrument+side 稳定 |
| UT-W1-05 | 影响面文案 | N 单/M 手/账户 |
| UT-W1-08 | tick 取整 | 866.5739 → 866.58 |
| UT-W3-01 | 新鲜度阈值 | 3s/10s/60s 降级 |

### 6.2 契约/集成（CT）

| ID | 目标 | 断言 |
|---|---|---|
| CT-W0-05 | 已部署编辑 | 409 + 中文 |
| CT-W0-06 | 单笔撤单 | OPEN 200 / FILLED 409 |
| CT-W1-01 | `runState` | 枚举 + 唯一状态 |
| CT-W1-02 | 拒单统计 | count/reason |
| CT-W1-03 | 告警聚合 | 1 行 + count |
| CT-W1-04 | 逐柜台状态 | `ors[]` + age |
| CT-W2-01 | 版本 diff | 快照完整 + diff |
| CT-W2-04 | 限仓字段 | limit/used/remaining |
| CT-W2-06 | 静默规则 | 计数累计、不弹窗 |
| CT-W3-04 | 指标阈值 | 0/0 → UNCONFIGURED |

### 6.3 端到端（E2E，新增）

| ID | 场景 | 断言 | 依赖 |
|---|---|---|---|
| E2E-B3-008 | 风控过期拒单可见 | 驾驶舱红条 + 首条 reason | T-W1-02 |
| E2E-B3-009 | 限仓超限 | 预览返回拒绝 + 开仓禁用 | T-W2-04 |
| E2E-B6-011 | 单一 runState | 无“INACTIVE+ACTIVE”并存 | T-W1-01 |
| E2E-B6-012 | 发布不隐式平仓 | 有持仓时拦截、无 emergency 请求 | T-W2-02 |
| E2E-B6-013 | 危险动作影响面 | 确认框含 N 单/M 手 | T-W1-05 |
| E2E-B6-014 | 版本表单/diff | 无手写 JSON；diff 可见 | T-W2-01 |
| E2E-B6-016 | 已部署编辑改道 | 直接进入版本表单 | T-W0-05 |
| E2E-B6-017 | PnL 双口径 | 两口径标注 | T-W3-03 |
| E2E-B6-018 | 未归属下钻 | KPI 可点 + 批量认领 | T-W3-05 |
| E2E-B8-008 | 告警聚合 | 同指纹 1 条 + count | T-W1-03 |
| E2E-B10-007 | 批量撤单 | 确认 N 单 + 逐单回执 | T-W1-06 |
| E2E-B10-008 | 900px 响应式 | scrollWidth==900、操作可达 | T-W1-07 |
| E2E-B10-009 | 手工单 tick | 非整数倍禁用 | T-W1-08 |
| E2E-B10-010 | 逐柜台健康 | 1/3 在线不显示正常 | T-W1-04 |
| E2E-B10-011 | 新鲜度降级 | 过期灰化 + 角标 | T-W3-01 |
| E2E-B10-013 | 执行页列对齐 | th==td | T-W0-01 |
| E2E-B10-014 | 时区一致 | 两页时间差 <2min | T-W0-02 |
| E2E-B10-015 | 持仓计数 | 首屏计数正确 | T-W0-03 |
| E2E-B10-016 | 快照覆盖 | 显示部分/1 of 3 | T-W0-04 |
| E2E-B10-017 | 单笔撤单 | 2s 内回执 | T-W0-06 |
| E2E-B10-018 | 手工单合约选择 | 错合约被阻止 | T-W2-03 |
| E2E-B10-019 | 只减仓横幅 | 刷新后仍在 | T-W2-05 |
| E2E-B10-020 | 实时成交 | 2s 内出现 | T-W3-02 |
| E2E-B10-021 | 导航收敛 | ≤16 入口 + 旧路由重定向 | T-W4-02 |
| E2E-B10-022 | 快捷键 | F2/F3/F8/F12 生效 | T-W4-03 |
| E2E-B11-006 | 收盘清单 | 收盘前 15min 出现 | T-W4-04 |

### 6.4 视觉（VIS）

| ID | 内容 |
|---|---|
| VIS-W1-07 | 1440/1280/900 三档基线 |
| VIS-W3-06 | 格式化/颜色/对比度 |
| VIS-W4-01 | 1920 一屏驾驶舱 |
| VIS-W4-05 | 期权链/手工簿增强 |
| VIS-W4-06 | 基线进 CI |

---

## 7. E2E 回归是否需要更新：需要

### 7.1 受影响的现有用例

| 现有用例 | 影响 | 处理 |
|---|---|---|
| `E2E-B6-001/003`（Pair 写路径） | 详情动作收敛、版本表单化后按钮位置变化 | 改为按 `data-testid` 定位；断言单一状态灯 |
| `E2E-B6-004`（版本契约 IT） | `runState`/版本 diff 字段新增 | 契约测试扩展，不破坏现有断言 |
| `E2E-B10-001..005`（smoke） | 导航 5 组、页面头/表格改造 | 更新路由与 marker；旧路由保留重定向 |
| `E2E-B10-006`（生命周期脚本） | 危险动作对话框、停止/停用确认 | 点击后需确认 `DangerousActionDialog` |
| `E2E-B12-001`（版本快照） | 版本表单化 | 选择器由 JSON 文本框改为表单字段 |
| `VIS` 基线 | 布局/颜色变化 | 三档基线全部重拍并评审 |

### 7.2 需要新增的命令/脚本

| 脚本 | 用途 | 关联用例 |
|---|---|---|
| `tools/e2e/trader-cockpit.mjs` | 盘前/阻塞条/runState/逐柜台 | B6-011、B3-008、B10-010 |
| `tools/e2e/orders-blotter.mjs` | 单笔/批量/作用域撤单、详情 | B10-007/017 |
| `tools/e2e/alerts-aggregation.mjs` | 告警聚合/分级/静默 | B8-008 |
| `tools/e2e/responsive-900.mjs` | 900px 功能可达 | B10-008 |
| `tools/e2e/manual-tick.mjs` | tick 取整/行情龄 | B10-009 |
| `tools/e2e/version-safety.mjs` | 版本 diff/不隐式平仓 | B6-012/014/016 |

> 这些脚本随对应任务一起提交；在脚本落地前，用例在回归映射中标记 `PLANNED`，不加入 `commands`，避免 `--all` 误跑。

### 7.3 回归映射更新

- B3 `cases` 追加：`E2E-B3-008`、`E2E-B3-009`。
- B6 追加：`E2E-B6-011…014`、`016…018`。
- B8 追加：`E2E-B8-008`。
- B10 追加：`E2E-B10-007…011`、`013…022`。
- B11 追加：`E2E-B11-006`。
- B10 `paths` 追加：`web/src/components/**`（设计系统）、`web/src/utils/**`、`web/src/pages/Dashboard.tsx|OrdersV2.tsx|Alerts.tsx|Execution.tsx|ManualBook.tsx`（若 `web/src/**` 已覆盖则不重复）。
- 新增脚本落地后，在对应 block 的 `commands` 中追加，requires 为 `[QF_WEB_URL]` 或 `[QF_BASE_URL, QF_WEB_URL]`。

### 7.4 门禁

- 每个 Wave 结束：`run-regression --all` 必须 39/39；新增 E2E 用例计入 PASS。
- 视觉：三档基线在 Wave 1/4 各更新一次，评审后合入。
- 回归映射必须与 `04-e2e-test-plan.md` 的矩阵同步，否则视为未完成。

---

## 8. 建议排期

| 周 | 任务 | 出口 |
|---|---|---|
| W1（本周） | T-W0-01…06 + T-W1-01/02/03/04 | 盘前判定、拒单可见、告警聚合、逐柜台 |
| W2 | T-W1-05/06/07/08 | 危险动作、订单 blotter、响应式、手工单 |
| W3 | T-W2-01…06 | 版本安全、限仓、只减仓、静默 |
| W4 | T-W3-01…06 | 数据可信与实时 |
| W5–W6 | T-W4-01…06 | 一屏驾驶舱、导航、收盘、视觉基线 |

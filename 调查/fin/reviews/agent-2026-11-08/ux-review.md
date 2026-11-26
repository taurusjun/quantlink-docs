# quantlink-fin UX / 交互独立复审

- 评审日期：2026-11-08
- 评审对象：`quantlink-fin` Web 控制台（`web/src`）+ Electron 监控窗（`desktop/electron`）
- 评审方式：最近 15 条 git 提交走查 + 全量源码走查 + 本地 Vite/桩 API 浏览器验证（1440/1366/1920）+ 旧评审/修复执行报告对照
- 范围：导航、策略触发、策略详情、消息中心、订单、手工单、监控、期权链、审批、可访问性、响应式
- 约束：本报告只新增 `docs/reviews/agent-2026-11-08/ux-review.md`，未修改任何生产代码

> 重要说明：浏览器验证使用的是本地 Vite + 临时桩 API（SHADOW、INACTIVE 策略、两条未确认告警），用于验证交互与布局，不代表真实后端/CTP 行为。凡涉及真实撤单、成交、审批、行情、交易日的行为，在文中单独标为“需交易日/真后端验证”。

---

## 1. 结论先行

**当前版本比旧评审更接近“可演示的交易终端”，但最近的导航修复和告警修复没有真正闭环，且暴露出三个新的下单安全问题。结论仍是：可内部演示，不建议直接交给交易员上桌。**

五个最重要的结论：

1. **导航只是“换了分组”，没有形成交易工作流。** 当前是“交易 7 项 / 数据与接入 5 项 / 策略 1 项 / 运维与审计 3 项”；“策略中心、指标中心”被塞进交易，“策略”组只剩“执行拓扑”，“交易日历”被放进数据与接入。结果是：策略组变成单页分组，订单/手工单被后移到第 5/6 位，交易日历离开交易入口。
2. **策略触发横幅的两个按钮都在，但确认后不消失。** 浏览器实测：点击一次“确认提醒”会发出 2 条 ACK，横幅仍然存在；连续点击会重复发 ACK，PAIR 页面还同时出现两个“确认提醒”入口。根因是详情页同时使用 `historyAlerts` 与轮询的 `alerts`，ACK 后没有更新 `historyAlerts`。
3. **“手动激活”是单点击直接激活，没有二次确认。** 浏览器实测：点击横幅里的“手动激活”没有出现任何确认对话框，直接 POST `/activate`；而页面自己的“激活策略”按钮却会打开确认对话框。同一个动作存在两套完全不同的安全语义。
4. **手工单和期权快捷单仍存在可造成错误下单的 P0 缺口。** 手工单切换到无行情合约后，价格仍保留上一个合约的 901.2；二次确认按钮在请求进行中仍可点击，双击实测发出 2 笔订单；期权快捷单在未预检时可以提交，改价/改量后旧预览仍然保留。
5. **“已修复”的项目里有大量“代码/文档写了、体验没接上”。** 1440 下行情条仍被隐藏；订单表没有搜索/排序/详情/批量撤单/sticky header，也不自动刷新；消息中心仍只展示当天策略提醒；`format.ts` 已存在但 0 处引用；Electron 的 `/monitor` 根本没有带 `?kiosk=1`。

### 1.1 评分（本次）

| 维度 | 分数 | 说明 |
|---|---:|---|
| 信息架构 | 5.0 / 10 | 四组存在，但策略组单页化、交易组拥挤、日历错位；详情页无导航上下文 |
| 交易安全交互 | 5.5 / 10 | 预检→确认方向正确，但确认不消失/单击激活/双击重复下单抵消了可信度 |
| 盘中效率 | 5.0 / 10 | 订单无自动刷新/搜索/详情/撤单闭环；期权链 1440 仍横向溢出 |
| 状态与数据可信 | 5.5 / 10 | fail-closed 有进步；但仍缺 as-of、自动刷新、缓存提示和“连接”真实语义 |
| 可访问性 | 4.5 / 10 | skip link 和 focus-visible 规则存在，但 MUI 控件实测无 focus 轮廓；badge 0 进入可访问名；状态色对比度不足 |
| **综合** | **5.2 / 10** | 骨架比上一版好，交易动作与信息架构还没有到“可上桌”。 |

---

## 2. P0 问题（必须修）

> 判定标准：会导致错误订单、错误激活、漏看告警、或让用户无法相信确认动作已经生效。

| ID | 页面 / 文件:行 | 现象与用户影响 | 可直接执行的建议 | 验收方式 |
|---|---|---|---|---|
| **UX-P0-01** | 策略详情 `StrategyView.tsx:448, 590-627, 717-738`；`useStrategyAlerts.ts:47-50` | **点击“确认提醒”后横幅不消失，且会重复 ACK。** 详情页把 `historyAlerts`（`status=ALL&today=true`）作为 `selectedAlerts` 优先来源；`ackTriggered()` 只调用 hook 的 `ack()`（重载 `alerts`），没有更新/重载 `historyAlerts`。所以只要进页时有一条历史告警，确认后 `unreadAlerts` 仍然非空，横幅和“确认提醒”按钮一直存在。浏览器实测：第一次点击发出 101/102 两条 ACK，横幅仍在；第二次点击再发两条；PAIR 页面同时出现 2 个“确认提醒”按钮。 | 单一数据源：`selectedAlerts` 从 hook 的 `alerts` + 当日历史合并，或 ACK 成功后同时 `setHistoryAlerts(current => current.map(...status:'ACK'))` 并 `await loadHistory()`；按钮点击后立即把本地行置为 ACK，再后台校准。PAIR 页复用同一 `ackAlerts()`，不要维护第二套按钮。ACK 失败要逐条提示，不能只给一个总错误。 | Playwright：点击 1 次后 300ms 内横幅/未确认数消失；每个 alert 只发出 1 个 ACK POST；刷新页面后仍为 ACK；网络失败时显示失败并保留行。 |
| **UX-P0-02** | 策略详情 `StrategyView.tsx:629-648, 726-731`；策略自己已有确认弹窗 `:1050-1072` | **“手动激活”没有二次确认，且对 UNDEPLOYED/FAILED 也显示。** 浏览器实测点击后 `dialogs=0`、直接发出 `POST /strategy-deployments/7/activate`。它会绕过页面上“激活策略”的确认对话框；激活成功后还会顺手 ACK 所有提醒，把“看告警”和“启动策略”两个动作绑在一起。对未部署策略，按钮先显示、点击后才报“策略尚未部署”。 | 横幅的“手动激活”改为打开现有 `statusOpen` 确认弹窗，弹窗中展示：策略 ID、deployment、账户、ORS、当前状态、限额/影响；只有 `deployment_id` 存在且状态为 INACTIVE/FAILED 才显示；UNDEPLOYED 显示“先部署”并链接到策略中心。把 ACK 与激活拆开，激活不要隐式清提醒。 | 点击“手动激活”先出现确认 dialog；取消时 0 个 activate POST；确认时只发 1 次；UNDEPLOYED 不出现可点击激活按钮。 |
| **UX-P0-03** | 手工交易 `ManualOrder.tsx:131-138, 263-272` | **切换合约后价格可能保留上一个合约的价格。** `useEffect([instrumentId])` 只在 `lastPrice != null` 时赋值；切换到无 tick 的期权（实测 `au2612C900`）时，价格仍为 `au2612` 的 `901.2`，且 `lastPrice` 为 `undefined` 导致偏离提示为 0、没有“过期价格”警告。用户可能把 901.2 当成期权价格提交。 | 切换合约时：有最新价则 `setPrice(String(lastPrice))`，无最新价则 `setPrice('')` 并显示“等待行情”；预检按钮在无行情时禁用。价格状态按 `instrumentId` 分键，或显式 `resetOrderForm()`；同时用 `preview.tickSize` 做 tick 校验，而不是只靠 `step:any`。 | 切换到无 tick 合约时价格为空/禁用预检；切换到有 tick 合约时价格等于最新价；无行情时无法打开确认弹窗。 |
| **UX-P0-04** | 手工交易 `ManualOrder.tsx:347-369` | **确认按钮在请求进行中不 disabled，双击会下两笔单。** 浏览器实测：确认弹窗中双击“确认下单”，发出 2 个 `POST /api/v1/manual/orders`；按钮文案不变、仍可再次点击。`busy` 只用于预检按钮，未传入弹窗。 | 确认按钮 `disabled={busy || confirmText !== instrumentId}`；提交后立即锁定弹窗并显示“提交中…”；失败才解锁。服务端增加幂等键（客户端生成 requestId，重复提交返回同一订单），前端不要只依赖按钮状态。参考现有 `cancelBusy` 模式。 | 双击只产生 1 个 POST；请求中按钮 disabled；失败后恢复；重复 requestId 返回同一 clientOrderId。 |
| **UX-P0-05** | 期权链 `OptionChain.tsx:233-255, 399-424` | **快捷下单可以在未预检时直接提交，且改价/改量后旧预览不失效。** `提交` 的 disabled 条件只检查 `canTrade` 和“已有 preview 且被拒绝”；`preview=null` 时按钮可用。实测 `submitDisabledWithoutPreview=false`；预检后把数量从 1 改成 9，旧 `名义金额` 仍在、按钮仍可用。`confirm` 也沿用旧 preview 的 `requiresConfirmation`，大额单可能绕过确认。 | 引入 `previewFingerprint`（instrument/side/price/qty/offset/TIF）：无 preview 或指纹不匹配时禁用提交；任一字段变化立即清空 preview/confirmText；提交同样加 `busy` 和幂等 requestId；把“提交”改成“确认预检结果并下单”并在 Drawer 显示账户/环境/数据龄。 | 未预检提交按钮 disabled；改价后旧 preview 消失；改量后必须重新预检；双击只发 1 单。 |

---

## 3. P1 问题（试点前应修）

| ID | 页面 / 文件:行 | 现象与用户影响 | 建议 | 验收方式 |
|---|---|---|---|---|
| **UX-P1-01** | 导航 `AppShell.tsx:49-86`；最近提交 `77d6d42/9f31a35/c7e9be5` | **四组存在，但工作流不合理。** 实测导航顺序：交易（驾驶舱、期权链、策略中心、指标中心、订单/成交、手工交易、消息中心）→ 数据与接入（通用配置、合约、柜台、费率、交易日历）→ 策略（仅执行拓扑）→ 运维与审计。策略组变成单页分组；订单/手工单被策略/指标挤到第 5/6 位；交易日历离开交易入口。 | 建议改为：**交易**：驾驶舱、期权链、手工交易、订单/成交、消息中心；**策略**：策略中心、指标中心、执行拓扑、通用配置（执行与风控默认）；**数据与接入**：合约、柜台与账户、费率；**运维与审计**：系统监控、变更审批、审计。交易日历放回交易，或顶栏 session chip + popover，不要放在数据接入末位。 | 1440/1366 手测：新用户从“看到提醒”到“策略详情”不超过 2 次点击；下单路径（期权链→手工→订单）连续；策略组至少 3 项；导航高亮与页面标题一致。 |
| **UX-P1-02** | 顶栏 `AppShell.tsx:249-251` | **行情条在 1440/1366 仍被隐藏。** `display: { xs:'none', xl:'flex' }` 需要 ≥1536；实测 1440 `au2612` 父级 `display:none`，1920 才可见。修复执行报告写的“≥1280 常驻”没有落地。 | 改为 `md`/`lg`（≥1280）常驻；空间不足时只保留主力合约最新/涨跌/买卖，其他合约进 popover；不要仅靠 CSS 隐藏但仍挂载连接。 | 1440 截图能看到至少一个合约的最新价；1366 不横向溢出；行情断开有明确占位。 |
| **UX-P1-03** | 策略详情 `StrategyView.tsx:673-713`；`AppShell.tsx:187-192` | **详情页没有导航上下文，`document.title` 仍是 `quantlink-fin`。** 浏览器实测 `/strategy-view?strategy=STRAT-PAIR` 标题为 `quantlink-fin`；`/orders` 正常为“订单/成交 · quantlink-fin”。因为 `NAV_GROUPS` 没有 `strategy-view`，标题查找失败，侧栏也没有高亮。 | 增加面包屑“策略中心 / 策略详情”；标题按详情页设置 `策略详情 · ${selected} · quantlink-fin`；侧栏高亮策略中心；详情页保留“返回策略中心”链接和当前策略选择器。 | 详情页标题包含策略 ID；侧栏策略中心高亮；返回按钮回到带筛选的列表。 |
| **UX-P1-04** | 期权链 `OptionChain.tsx:309-310, 332-363` | **1440/1366 仍横向溢出，Strike 不固定，Put 半张表在视口外。** 实测 1440：表格 1280px，容器 1186px，Put Vol 右边界 1517 > 窗口 1440；1366：1280 vs 1112。用户必须横向滚动才能看到 Put 的 Gamma/Vega/OI/Vol。 | 将 Strike 列设为 `position: sticky; left: 0`（或中间固定列），Call/Put 两侧独立滚动；默认隐藏 OI/Vol 等无源列；提供列显示配置；1440 首屏至少完整显示 Call Bid/Ask、Strike、Put Bid/Ask。 | 1440/1366 下无需横向滚动即可看到 Strike 和两侧 Bid/Ask；滚动时 Strike 固定；列配置可持久化。 |
| **UX-P1-05** | 期权链快捷下单 `OptionChain.tsx:392-397`；`AppShell.tsx:213-217` | **Drawer 标题被固定 AppBar 遮住。** 实测“快捷下单”标题 `top=24px`，`elementFromPoint` 命中 AppBar 的 Toolbar，而不是标题。用户打开 Drawer 第一眼看不到标题/合约上下文。 | Drawer 设置 `PaperProps={{ sx: { top: 49 } }}` 或使用 `Modal`/全屏 Dialog；Drawer 内容顶部加 `pt: 2`；移动端使用全屏。 | 打开 Drawer 时标题、合约、账户完整可见；标题区域不被 AppBar 拦截点击。 |
| **UX-P1-06** | 订单 `Orders.tsx:136-139, 169-204, 406-448` | **订单表是“静态快照”，不是 blotter。** 无自动刷新/轮询；只有改筛选/翻页才重新请求，成交/撤单不会自动出现。没有搜索（订单号/合约）、排序、详情抽屉、批量撤单、按当前筛选撤单；默认筛选是 `ALL`，不是“未完成+今日”；表头 `position: static`，长表滚动后失去列头。 | 默认 `OPEN` + 今日；添加 5–10s 可暂停的自动刷新（或复用订单 WS）；工具栏加订单号/合约搜索、列排序、来源/策略/offset/TIF、时间范围；行内“详情”打开生命周期抽屉；勾选后批量撤单/按筛选撤单；`Table stickyHeader` + `TableContainer maxHeight`。 | 成交/撤单 5s 内自动反映；搜索订单号命中；滚动 20 行后表头仍可见；勾选 2 行可批量撤；默认只显示未完成。 |
| **UX-P1-07** | 订单 `Orders.tsx:235-251, 408-444, 472-497` | **撤单反馈和表格语义仍不足。** 单笔撤单无二次确认，误点立即发请求；成功后只有顶部 `Alert` 和行状态，缺少“撤单已发/已撤/失败”逐单回执；无撤全部；时间列直接显示 ISO（实测 `2026-11-08T07:45:58.957Z`）；API 返回的 `source` 被丢弃，无法区分策略/手工；成交表也显示原始时间。 | 对单笔撤单加轻量确认或 undo；行内状态加“撤单请求已发/已撤/失败/原因”时间线；`formatDateTime` 统一时间；增加来源列；CSV 明确导出当前页还是全部；空态给“今日暂无订单 + 查看全部”。 | 撤单成功/失败都在行内有反馈；时间统一 `YYYY-MM-DD HH:mm:ss`；来源可见；空表有 CTA。 |
| **UX-P1-08** | 策略中心 `Strategies.tsx:521-527, 529-598, 572-594` | **策略健康板仍是 5 个文本按钮的配置表。** 实测 ACTIVE 行仍显示“部署”按钮；统计 chip（全部/ACTIVE/INACTIVE/UNDEPLOYED）不可点击；无搜索/状态筛选/仅看异常；“详情/历史/PAIR参数/部署/停止”平铺，主次不分；状态列用 deploymentStatus，DRAFT 等策略生命周期不可见。 | ACTIVE 行隐藏“部署”，改为“重新部署”并走独立确认；统计 chip 变筛选器；顶部加搜索/状态/标的/仅异常；操作收进“更多”，主操作只留“详情 + 停止/激活”；状态列合并“生命周期 + 部署状态”，用 dot + label。 | ACTIVE 行无裸“部署”；点击 ACTIVE/INACTIVE chip 能筛选；搜索策略 ID；主操作不超过 2 个。 |
| **UX-P1-09** | 策略向导 `Strategies.tsx:303-377, 840-848` | **向导仍可无校验一路“下一步”。** 第 1 步以外没有逐字段校验；默认 `STRAT-NEW-01` 可直接创建；`window.confirm` 与页面内 Dialog 两套风格；创建/部署无 busy，双击可重复创建；关闭 Dialog 不提示未保存（`beforeunload` 只覆盖页面卸载）；`ACTIVE（需 ADMIN 审批）` 在前端没有审批流程，后端 LIVE guard 只认 `X-Approval-Id`（见 P1-20）。 | 每步即时校验并显示错误摘要；数字字段加单位/范围/默认值；复核页用人话摘要 + 风险/冲突检查；`保存草稿 / 提交审批 / 部署` 分离；统一 MUI 确认弹窗；提交时 busy + 幂等；关闭时 `confirm` 未保存。 | 空字段无法下一步；创建按钮双击只产生一个策略；关闭有未保存提示；ACTIVE 真正进入审批流程或被明确标注为“仅 SHADOW”。 |
| **UX-P1-10** | 消息中心 `Alerts.tsx:39-64, 89-114, 118-158` | **仍不是统一收件箱。** 只查 `today=true` 的策略提醒；无来源/severity/策略/合约/时间筛选；无系统告警；`全部确认` 一键循环 ACK、无 count/影响确认、无 busy、无 try/catch（一个失败会让整串中断且页面不显示错误）；只显示“记录保留 7 天”但无法查看前 6 天；无 ack 人/时间。 | 统一为“待处理/已确认/全部”收件箱，补来源/severity/策略/合约/时间筛选；批量 ACK 先确认“将确认 N 条”；失败逐条回执；补 ack 人/时间/备注；保留期与后端一致并允许日期范围（7 或 30 天由产品定）；系统告警与策略告警同一入口。 | 能筛 severity/source；查看昨天告警；批量确认前有 N 条确认；一条失败不阻断其余；列显示 ack 人/时间。 |
| **UX-P1-11** | 系统监控 `Monitoring.tsx:74-121, 144-158, 245-257` | **“实时监控”没有系统状态自动刷新。** 只在 mount 时请求一次 `/system/status`；WS 消息只刷新 telemetry，不刷新 system/倾估/对账；无最后更新时间；`ENABLED` 与 `HEALTHY` 共用绿色，柜台启用被当成健康；告警卡只有名称+“触发阈值”，不能 ack/silence/runbook。 | 统一 5–10s 刷新 system/health/reconciliation（可暂停）；服务卡区分 `CONFIGURED / ENABLED / HEALTHY / STALE`；显示 `lastUpdated/dataAge`；告警卡支持 ack/silence、当前值/阈值/持续时长/影响范围/runbook；对账显示 last run/样本数。 | 控制面断开后 10s 内状态变红/STALE；服务卡能区分 ENABLED 但 unhealthy；告警可 ack；页面有最后刷新时间。 |
| **UX-P1-12** | 变更审批 `Approvals.tsx:39-57, 81-107` | **“通过”是一键不可逆操作。** 没有确认、没有 busy、没有拒绝动作；表格不展示 payload/diff、请求原因、目标策略/部署详情；没有按状态/动作/时间筛选；发起审批是自由文本 + deployment id。 | 通过前打开审批详情：动作、目标、payload diff、影响、申请人、当前环境；要求再次确认/输入目标 ID；增加“拒绝”与备注；提交 busy；支持筛选/分页；目标用选择器而不是自由文本。 | 点击通过先出现详情 dialog；取消 0 请求；确认后 1 次请求；可拒绝并记录原因。 |
| **UX-P1-13** | 手工交易 `ManualOrder.tsx:219-220, 263-275, 281-289` | **下单票仍缺市场上下文和安全约束。** 账户是可自由编辑的文本框；无盘口/最近成交/持仓/合约乘数/tick 提示；价格 `step:any`、数量只 `min:1`，不按 tick/lot；按钮文案“预检并提交”会让人以为点击就发单；离线只读只看 `navigator.onLine`，不看控制面/交易通道状态。 | 账户改为选择器（来自当前 venue 绑定）；价格/数量用 tick/lot stepper，显示单位；补盘口/持仓/保证金/手续费上下文；按钮改为“预检”；离线/控制面断开时整页只读并禁用；把三条 warning 收进可展开说明。 | 账户不可自由输入；价格自动对齐 tick；控制面断开时预检/提交禁用；按钮文案为“预检”。 |
| **UX-P1-14** | 全局可访问性 `theme.ts:52`；`AppShell.tsx:208-211, 360-364`；`Calendar.tsx:192, 196` | **focus-visible 规则存在但 MUI 控件实测无轮廓。** 键盘 Tab 实测：skip link 有 2px 琥珀 outline；顶栏 Select、日历 Chip、应急按钮均 `outline: none`，因为 MUI ButtonBase 的 `outline:0` 覆盖了全局 `:focus-visible`。导航 badge 0 仍进入可访问名（实测“0交易驾驶舱”）；日历左右月 IconButton 无 `aria-label`。 | 在 `MuiButtonBase`/`MuiListItemButton`/`MuiChip`/`MuiSelect` 上显式写 `&:focus-visible { outline: 2px solid ...; outline-offset: 2px; }`（必要时提高优先级）；badge 为 0 时不渲染 Badge/或 `aria-hidden`；日历按钮加 `aria-label="上个月/下个月"`；所有仅图标按钮补名称。 | Tab 经过顶栏/导航/表格按钮均能看到轮廓；导航可访问名不含 0；图标按钮有名称；Lighthouse/axe 无 landmark/name 错误。 |
| **UX-P1-15** | 语义色 `theme.ts:13-15`；`tokens.ts:3-9`；`MarketTicker.tsx:38-43`；`OptionChain.tsx:336, 350`；`Orders.tsx:429` | **买卖、涨跌、状态、错误仍共用一套红绿。** `success/error` 同时表示 BUY/SELL、正负 PnL、FILLED/REJECTED、Call/Put；`tokens.up/down` 定义了却未被使用；MarketTicker 红涨绿跌，Orders 绿买红卖，OptionChain Call 绿/Put 红，同一屏含义冲突。成功/失败 chip 白字对比度实测 3.0:1 / 3.49:1。 | 拆成三组 token：market direction（红涨绿跌）、order side（买/卖独立色或中性+文案）、system status（success/warning/danger/info）；状态 chip 改浅色 tint + 深色文字或加深底色至 4.5:1；不要再让 SELL 使用 error。 | 同一屏能区分“涨”“买”“成功”；色弱模拟仍可读；状态 chip 对比度 ≥4.5:1。 |
| **UX-P1-16** | Electron / kiosk `desktop/electron/main.ts:108-110`；`AppShell.tsx:185, 213, 313, 400`；`Monitoring.tsx:176-260` | **Electron 监控窗没有进入 kiosk。** `/monitor` 是直接 `createWindow('/monitor', true)`，没有追加 `?kiosk=1`；`AppShell` 只有在 query 上有 `kiosk=1` 才隐藏侧栏/顶栏。即使手动加 query，Monitoring 仍是 3 列普通页面，不是 1280×860 的紧凑大字号监控。 | `createWindow('/monitor?kiosk=1', true)`；Monitoring 在 kiosk 下改为 2 列 + 大字号状态 + 告警 ticker；隐藏页面 padding/标题营销文案；为 always-on-top 1280×860 做专用布局。 | 打包 Electron 打开监控窗无侧栏/顶栏；1280×860 不横向滚动；关键状态字号 ≥18px；浏览器 `?kiosk=1` 同样生效。 |
| **UX-P1-17** | 驾驶舱 `Dashboard.tsx:198, 206-236, 285-311, 341` | **驾驶舱仍写死 SHADOW、休市重复告警、指标语义错位。** AppShell 已从 `/system/status` 读取环境，Dashboard 仍固定 `SHADOW`；正文黄色 Alert 与顶栏休市 chip 重复；组合 Delta 的 hint 是 Gamma、组合 Vega 的 hint 是 Theta；保证金占用永远 warning 色，`margin/balance` 无 0 保护；持仓表空态只有表头，无合计/无数据龄。 | 环境从 `system.status` 统一读取；删除正文日历 Alert，只留顶栏 chip/popover；直接显示“Gamma/Theta”独立指标，不放在 Delta/Vega 的 hint；保证金 0–80% 中性、>80% 黄、>90% 红；补 `balance<=0` 保护、空态 CTA、as-of/数据龄和持仓合计。 | LIVE 环境 Dashboard 显示 LIVE；休市只在顶栏；保证金 0 为中性；空持仓有“查看订单/刷新”。 |
| **UX-P1-18** | 全局 `useAppUpdate.ts:39-42`；`AppShell.tsx:445-480`；`Strategies.tsx:178-186` | **更新提示仍会直接 reload，且未保存保护只覆盖策略向导页面卸载。** 白色胶囊 + 紫色按钮与全站深色/琥珀体系冲突；点击“立即刷新”不检测未提交表单/未确认订单；关闭策略向导、CommonConfig、手工单都不提示未保存。 | 更新提示改深色 surface + 主题内按钮；reload 前检查未保存表单/挂单/弹窗，显示“有未保存修改，建议稍后刷新”；用路由守卫 + `beforeunload` 覆盖向导、CommonConfig、手工单、PAIR 参数。 | 有未保存表单时点击刷新出现阻断提示；关闭向导有确认；提示样式与主题一致。 |
| **UX-P1-19** | 顶栏 `AppShell.tsx:138-147, 259-267` | **“交易通道已连接”仍不等于交易可用。** `connected` 只由 `controlPlane === 'UP' && orsRunning` 推导，忽略 `agentOnline`；agent 掉线时仍可能显示绿色已连接。market 延迟另有 chip，但 agent/CTP 不可用没有独立状态。 | 把“控制面可访问”和“可交易”分开：顶栏展示 control / agent / ORS / market 四个小状态，只有全部满足才显示“可交易”；点击展开详情和最近心跳。 | 模拟 `agentOnline=false`（system status 或断 WS）时，顶栏不能显示“交易通道已连接”；四个子状态可见。 |
| **UX-P1-20** | 激活链路 `ManualOrder`/`StrategyView` + `api/client.ts:61-71`；`Approvals.tsx`；后端 `StrategyDeploymentController.java:130-136`、`ApprovalGuard.java:14-38` | **LIVE 审批链路在 Web 端断开。** 后端 LIVE 激活要求 `X-Approval-Id` 且审批人不能是发起人；前端 `apiPost` 只带 Basic/Content-Type，没有任何地方传 `X-Approval-Id`，审批页也没有“用这个审批去激活”的入口。结果是 LIVE 下策略详情/列表的激活请求必然 428，审批页变成孤立页面。 | `apiPost` 增加可选 headers；策略激活弹窗允许选择已 APPROVED 的 approval（显示 action/target/approver），或从审批页“去激活”带 approvalId；错误 428 要显示“需要另一名操作员审批”而不是原始状态码。 | LIVE 桩/真环境：无 approval 时激活显示明确提示；选择已通过 approval 后激活成功；发起人不能审批自己的请求。 |

---

## 4. P2 问题（体验债 / 打磨）

| ID | 页面 / 文件:行 | 问题与用户影响 | 建议 | 验收方式 |
|---|---|---|---|---|
| UX-P2-01 | 全局 `AppShell.tsx:400`；`Dashboard.tsx:217-236` | 1920 内容拉满：main 实测约 1700px，4 张指标卡各 ~405px，信息密度反而下降；没有最大宽度或第三栏。 | 内容 `maxWidth: 1680` 或 12 列网格；1920 下增加右栏（告警/持仓/成交），不要只把卡片拉宽。 | 1920 截图内容有最大宽度/第三栏；卡片不因屏幕变宽而失去可读性。 |
| UX-P2-02 | 全局 `format.ts`（0 引用）；`Orders.tsx:427, 488`；`StrategyView.tsx:946, 989` | 已有 `formatPrice/Money/Pct/Greek/DateTime/Age`，但页面 0 处 import；订单/成交时间仍是 ISO，价格全是 `toFixed(2)`，不按 tick/单位。用户看到 `2026-11-08T07:45:58.957Z` 这类工程时间，复盘和扫读都慢。 | 全面接入 `utils/format.ts`；订单/成交/策略详情时间统一 `YYYY-MM-DD HH:mm:ss`；价格/希腊值按 instrument/字段格式化；`format.ts` 加单测。 | 页面无 ISO 原文；时间/价格格式有单测；不同 tick 合约显示一致。 |
| UX-P2-03 | 期权链 `OptionChain.tsx:58, 298-305, 382` | `fmt` 把 0 显示成 `—` 但仍保留 pointer/红绿可点击样式；无报价/未启用合约要点击后才报错；2s 轮询成功会 `setError('')`，可能把刚出现的错误提示清掉；`25Δ RR` 在概要卡仍可能输出浮点原值。 | 无报价/未启用单元格禁用 + `aria-disabled` + tooltip；错误提示保持到用户关闭；`rr25` 用 `formatPct/formatGreek`；页面顶部 Alert 与 Drawer 内错误去重。 | 无报价单元格不可点击且有说明；错误停留到手动关闭；RR 1 位/2 位小数稳定。 |
| UX-P2-04 | 策略详情 `StrategyView.tsx:231-240, 755-831` | “概览/指标/持仓/配置”Tabs 只是 `scrollIntoView`，所有区块仍同时显示；非 PAIR 分支内又嵌套 `strategy_type === 'futures_pair'` 永远不可达代码。 | Tabs 真正切换面板（或改成锚点导航并标注）；删除死分支；PAIR 专用页保留自己的 tab。 | 点击 tab 只显示对应内容；无不可达 PAIR 分支；深链/返回保持 tab。 |
| UX-P2-05 | 策略中心 `Strategies.tsx:552-554, 563` | 状态列只显示 deploymentStatus，策略生命周期（DRAFT/ACTIVE/STOPPED）不可见；PnL 固定 `toFixed(2)` 无正负色/单位；时间和最小/最大行权价无单位。 | 合并“生命周期 + 部署状态”；PnL 带颜色/符号/币种；向导字段加单位（tick/手/元/百分比）和范围。 | 行内能区分 DRAFT/ACTIVE/STOPPED；PnL 正负色/单位可见；表单 helper 有单位。 |
| UX-P2-06 | 消息中心 `Alerts.tsx:89-114` | “待处理 N”按当前筛选计算，在“已确认”视图会显示待处理 0，误导；状态仍是 `NEW/ACK` 英文；无空态 CTA。 | 计数从独立全局 stats 获取；状态中文化；空态给“刷新/查看全部/前往策略中心”。 | ACK 视图仍显示真实待处理数；空态有 CTA；状态中文。 |
| UX-P2-07 | 监控 `Monitoring.tsx:266-267` | `scoped.length===0` 时 `every()` 为 true，chip 用 success 绿色但 label 是“未接入”；`ENABLED` 也归入 success。 | 空数据用 `default`；`ENABLED` 与 `HEALTHY` 分色；为未接入显示灰色的“未配置”。 | 空对账为灰色“未接入”；ENABLED 与 HEALTHY 色不同。 |
| UX-P2-08 | 日历 `Calendar.tsx:110, 192-200` | 副标题仍暴露内部文件名 `trading_days.txt`；左右月按钮无 aria-label（见 P1-14）；摘要卡 + 12 个后续交易日重复。 | 文案改“交易所交易日与夜盘规则”；按钮加名称；后续交易日 6 个 + 展开；点击日期打开右侧详情（节假日/session/到期）。 | 页面无内部文件名；按钮可读名称；后续交易日可折叠。 |
| UX-P2-09 | 全局 `PageSkeleton.tsx:7-12` | 固定 `cards` 数量 + 一块 320px 区域，和真实页面（表格/期权链/策略详情）结构不匹配；加载切换时页面跳动。 | 提供 `PageSkeleton variant="table|dashboard|chain|detail"`；表格用行骨架，期权链用中间列骨架。 | 加载骨架与最终布局同高/同列；首屏不跳。 |
| UX-P2-10 | 顶栏 `AppShell.tsx:280-309, 380-385` | 顶栏常驻 “SimLocal / SimNow / SimShengli” 和路径 `/xxx`，没有信息价值；侧栏账户/版本与顶栏上下文割裂；版本 `0.1.0 · M0` 不可点击。 | 移除静态环境名和路径；账户/角色/版本放用户菜单；版本链到“关于/更新”。 | 顶栏无路径/静态环境名；用户菜单含账户/版本；版本可点击。 |
| UX-P2-11 | 登录 `Login.tsx:33, 134, 333-346`；Dashboard `Dashboard.tsx:198` | 登录默认 `test_admin`、写死 `SHADOW ENVIRONMENT`；“离线演示”与真实登录同等显眼；Dashboard 写死 SHADOW。 | 默认用户名留空/记住上次；环境从 `/system/status`；离线演示仅开发构建显示并二次确认。 | 生产构建无 test_admin/离线演示；LIVE 环境登录页/Dashboard 显示 LIVE。 |
| UX-P2-12 | `AppShell.tsx:339, 360-364`；`MarketTicker.tsx:13, 52`；`OptionChain.tsx:348` | `Badge` 0 仍渲染（导航可访问名 “0交易驾驶舱”）；9–10px chip 仍大量存在（MarketTicker “SIM/CTP” 9px、ATM 9px、导航组标题 10px）。 | 0 badge 不渲染或 aria-hidden；状态 chip 最小 11px；技术缩写放 tooltip/详情。 | 导航可访问名无 0；状态 chip ≥11px；读屏无噪声。 |
| UX-P2-13 | 测试 `tests/visual/specs/m0-skeleton.spec.ts:64-70`；`Strategies.tsx:103` | 视觉测试仍断言“新建策略 · 4 步向导”，而普通模板已是 5 步（PAIR 才是 4 步）；没有 ack 消失、双击下单、期权 Drawer、导航顺序的交互测试，导致本轮回归没有被 CI 捕获。 | 更新向导断言为按模板动态；增加 Playwright：ACK 后横幅消失、手动激活先确认、手工单双击只 1 单、期权链未预检禁用、1440 行情条可见。 | CI 包含新增交互用例并全绿；视觉基线随模板步骤更新。 |
| UX-P2-14 | 审计 `Audit.tsx:35-77`；审批 `Approvals.tsx:73-80` | 审计只显示最近 100 条，无筛选/分页/展开 payload/diff/trace id；审批发起是自由文本，无目标选择器。 | 审计按时间/人/动作/对象筛选，行展开 payload diff；审批目标用选择器并显示影响。 | 审计可按对象筛选并展开 diff；审批目标从选择器产生。 |

---

## 5. 已确认改善（不是复述旧文档）

以下行为在本次源码/浏览器验证中确认成立，下一轮应保留：

1. **策略详情不再自动 ACK。** `StrategyView` 没有“打开页面即 ack”的 effect；浏览器打开详情后没有 ACK POST，必须点击按钮才会发请求。方向正确。
2. **横幅同时提供“确认提醒”和“手动激活”。** 对非 ACTIVE 且有未确认提醒的策略，两个按钮都出现；这是 commit `9172aca` 的真实结果。问题在交互语义，而不是按钮缺失。
3. **ACK 后端幂等。** `StrategyAlertController.ack()` 对已 ACK 的 alert 返回 200 + `duplicate:true`，重复确认不会 404（`StrategyAlertController.java:132-149`）；但前端重复提交和按钮不消失仍需修。
4. **手工单默认价改为最新价，并强制“预检 → 确认弹窗 → 下单”。** `ManualOrder.tsx:161-185` 即使服务端 `requiresConfirmation=false` 也打开确认弹窗；价格偏离 >0.5% 有黄色提示。方向正确，但被 P0-03/P0-04 抵消。
5. **订单页 fail-closed + 单笔撤单 busy。** API 失败时清空订单并提示“禁止撤单或下单”；撤单按钮有 `提交中…` 并禁用；列配置/密度/CSV 已存在。基础是对的，缺自动刷新/搜索/详情/批量。
6. **期权链已接真实 instruments + ticks。** 不再 `buildRows()` 合成；IV/Greeks/OI/Vol 无源时显示 `—`，ATM 不再被 `tradeableRows` 过滤；无报价/未启用合约有明确错误文案（`OptionChain.tsx:182-207, 301-305`）。真实数据质量仍需交易日验证。
7. **驾驶舱删除了第二套 `/positions` 竞态覆盖。** 只保留 `/portfolio/live`，Greeks 不再被全 0 覆盖；数据失败进入 ERROR chip/错误提示。
8. **Monitor 有 sparkline、服务状态、对账结果；Alerts 有状态筛选/静默；库存数据有 PnL/挂单/告警/心跳字段。**
9. **可访问性有真实进步：** skip link 可用（Tab 首项，2px 琥珀 outline）；已知路由的 `document.title` 会更新；Inter 自托管、`tabular-nums` 已接入；主题深色底一致。
10. **策略列表已有健康字段**（PnL/持仓/挂单/告警/心跳/运行状态）和配置历史/回滚入口；方向正确，但列表操作/确认仍需收紧。

---

## 6. 仍存在的体验债（系统性问题）

1. **IA 是“混合分类”，不是交易工作流。** 交易组把策略/指标夹在期权链与订单之间；策略组单页化；通用配置（执行/风控默认）在数据接入；日历离开交易；消息中心只覆盖策略提醒。详见 UX-P1-01/P1-10。
2. **危险动作模式不统一。** 有 MUI Dialog（策略停止/激活、应急），有 `window.confirm`（创建/部署），有直接执行（手动激活、撤单、审批通过、回滚）。busy/幂等/确认/影响摘要没有统一组件；LIVE 审批虽然有后端 Guard，但前端没有任何 `X-Approval-Id` 传递路径，审批页与激活链路是断开的。
3. **数据新鲜度没有统一契约。** Orders/Strategies/Approvals/Monitoring 是一次性快照；Dashboard 2s、Alerts 5s、期权链 2s；没有统一的 `as of / data age / stale`。缓存 `OFFLINE` 只有 source chip，没有时间戳。
4. **“设计 token / format”只完成了定义，没有完成接线。** `utils/format.ts` 0 引用；`tokens.up/down` 未被使用；`success/error` 仍混合买卖/涨跌/状态。
5. **空态/错误态/骨架仍是通用模板。** 空表只有表头、空指标网格没有 CTA；错误 Alert 不阻断操作（Indicators 在 ERROR 下仍允许新建/编辑）；加载骨架与页面结构不匹配。
6. **可访问性只完成了 skip link + 全局规则，未覆盖 MUI 组件。** focus 轮廓被覆盖、badge 0 进入可访问名、日历图标无名称、状态色对比度不足。
7. **响应式只完成了“无横向滚动”，没有完成“信息可达”。** 1440 行情条隐藏；期权链 1440/1366 横向溢出；kiosk 未接 Electron；1920 只是拉宽卡片。
8. **测试与真实体验脱节。** 视觉基线仍按 4 步向导，未覆盖 ACK/双击/激活/导航；本轮两个 P0 告警问题未被任何测试捕获。

---

## 7. 代码正确 vs 浏览器验证 vs 交易日验证

### 7.1 已由代码/浏览器验证成立

- 浏览器（本地桩 API，1440/1366/1920）：
  - 导航四组及顺序、策略中心/指标中心/日历位置；
  - 策略横幅两个按钮；点击确认后横幅仍在；连续点击重复 ACK；PAIR 页 2 个“确认提醒”；
  - 手动激活 0 个对话框、1 个 activate POST；
  - 手工单双击 2 个下单 POST；切换无行情合约价格仍为 901.2；
  - 期权 Drawer 标题被 AppBar 命中；未预检 `submitDisabled=false`；改量后旧 preview 仍在；
  - 1440 行情条父级 display:none、1920 可见；1440 期权链 1280 vs 1186，1366 1280 vs 1112；
  - 订单无搜索 input、thead `position: static`、无详情/批量撤单、默认 ALL、时间 ISO；
  - 策略 ACTIVE 行仍有“部署”按钮、统计 chip 不可点击；
  - `document.title` 在 `/strategy-view` 仍为 `quantlink-fin`；
  - Tab 到顶栏 Select/Chip/Button 无 outline；导航可访问名含“0”；success chip 3.0:1。
- 仅代码可见、但高置信：
  - Electron `/monitor` 未追加 `?kiosk=1`；
  - Monitoring 只在 mount 请求 system status；
  - `format.ts` 无引用；
  - `Alerts.tsx:59-64` `ackAll` 无 try/catch/确认/busy；
  - `OptionChain` 2s 轮询成功会清空 `error`；
  - `Strategies` 创建/部署无 busy，`window.confirm` 与 Dialog 混用；
  - `Approvals` 一键通过无确认。

### 7.2 需要在真实浏览器/真实控制面再验证

- ACK 在真实数据库/多标签页下的最终状态、`historyAlerts` 排序、当天边界（00:00 后、夜盘归属）。
- 真实 CTP/SimLocal 的撤单回执、部分成交、拒单原因、价格笼子、tick/lot、reduce-only。
- 真实行情无报价/断流时，期权链/手工单的错误路径与 `error` 清除时机。
- 真实激活策略后 runner 是否立即产生订单、审批是否强制、SHADOW/LIVE 环境标识是否一致。
- Electron 打包后的 1280×860 监控窗、always-on-top、kiosk 布局、字体渲染。
- 交易日（含夜盘）的日历 gate、下一交易日、CTP 结算/保证金与 UI 显示。

---

## 8. 需要人类确认的问题

只列会阻塞产品或需要风险/合规决策的：

1. **导航最终归属：** “策略中心 / 指标中心”到底属于交易工作区还是策略工作区？“交易日历”是交易入口还是数据与接入？当前提交 `77d6d42/9f31a35/c7e9be5` 选择了前者，但导致策略组只剩“执行拓扑”。请确认是否接受本报告建议的“策略组：策略中心/指标中心/执行拓扑/通用配置；交易组：驾驶舱/期权链/手工/订单/消息；日历回交易或顶栏”。
2. **“手动激活”风险策略：** 是否允许交易员单击横幅直接激活策略？还是必须二次确认/ADMIN 审批？激活是否应该自动 ACK 提醒，还是 ACK 与激活完全分离？这决定 UX-P0-02 的实现。
3. **告警保留期与“全部确认”：** 代码/后端实际保留 7 天（`StrategyAlertController` 注释与 UI 一致），修复文档写 30 天；且“全部确认”是否允许无二次确认地批量 ACK？请产品/合规确认 7 或 30 天，以及批量确认是否需要备注/审批。
4. **订单默认视图与撤单确认：** 是否接受“默认未完成 + 今日”、单笔撤单二次确认/undo、按筛选全部撤？这会改变交易员当前的操作习惯，需要交易负责人拍板。
5. **Electron 监控窗形态：** 是否确认 `/monitor` 应自动进入无侧栏 kiosk、1280×860 两列大字号布局？当前代码没有接线，属于产品形态决策。

---

## 9. 附：本次复审对最近提交的判断

| 提交 | 判断 |
|---|---|
| `77d6d42 nav: 策略中心移入交易，交易日历移入数据与接入` | 只做了“移动”，没有解决策略组单页化；交易日历位置反而更偏离交易工作流。 |
| `9f31a35 nav: 策略中心置于期权链下方` | 让策略中心更靠近期权链，但把订单/手工单继续后移；交易组变得更长。 |
| `c7e9be5 nav: 指标中心置于策略中心下方` | 策略/指标相邻是合理的，但两者一起放在“交易”组，进一步掏空“策略”组。 |
| `9172aca fix(alerts): 横幅同时提供确认提醒与手动激活` | 按钮存在性修复成功；但“手动激活”直接执行、确认后不消失，使修复没有形成安全闭环。 |
| `6c08768 fix(alerts): 确认后从策略详情未确认列表移除` | 只改了 PAIR 卡片的渲染条件，没有更新 `historyAlerts`；浏览器实测确认后横幅仍在，修复未生效。 |
| `3ccf708 fix(alerts): ACK 幂等` | 后端幂等有效，避免重复确认 404；但前端重复 ACK 与不消失问题仍在。 |

**一句话收口：** 下一步不要继续加页面；先把“确认必须即时生效、危险动作必须二次确认、订单必须可刷新可搜索可撤、导航按交易工作流重排”四件事做完，再谈视觉打磨。

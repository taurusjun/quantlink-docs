# 交易端评审证据 · 2026-11-11

所有 A 系统截图均为**只读**采集：只打开页面、切 Tab、打开弹窗后 `Esc` 关闭，未提交任何表单、未下单/撤单/停止/激活/删除。

- 采集时间：2026-11-11 18:56 – 19:10（CST）
- 环境：`https://101.43.54.190:8443`（SHADOW），Basic Auth `test_admin`
- 工具：Playwright（Chromium，`ignoreHTTPSErrors`，`addInitScript` 写入 `localStorage.qf_basic_auth`）
- 视口：1600×1000（`15-dashboard-1280.png` 为 1280×800；`16`–`20` 为 1600×1900 以便看到 Tab 内容）
- 浏览器 console / pageerror / HTTP≥400：**0 条**

| 文件 | 页面 | 证明了什么 |
| --- | --- | --- |
| `01-dashboard.png` | `/` 交易驾驶舱 | 6 策略/3 账户；KPI「3 个运行中」与卡片状态不一致；「策略提醒 100」全为同一拒单原因；指标 chip 全红且带秒级龄；「策略 PnL 对比」大片空白；左下 toast 覆盖卡片 |
| `02-strategy-center.png` | `/strategy-center` | 同一行「部署 INACTIVE + 策略 ACTIVE」并存；「快照 10:57:24」为 UTC，与驾驶舱 18:57 差 8 小时；操作列只有 编辑/复制/激活/停用 |
| `03-orders.png` | `/orders` | 今日委托 0 / 成交 0 / 总持仓标签 0；无自动刷新；无任何撤单入口；`asOf` 静态 |
| `04-manual-book.png` | `/manual-book` | 手工簿持仓更新时间为 2026-11-09 21:46（两天前）仍以正常样式展示；簿 ID 显示 UUID；「账户只减仓」开关一键生效 |
| `05-alerts.png` | `/alerts` | 200 行同指纹告警（接口上限 500）；无严重度、无聚合、无过期；副标题「仅显示当天」与默认「全部日期」矛盾 |
| `06-indicators.png` | `/indicators` | 阈值 0/0 的 PAIR 指标全部 CRIT；`269,081.3 ms`、`11,278.3` 无口径；STALE 显示 1142m/2615m |
| `07-options.png` | `/options` | 8 个行权价仅 2 个有报价；其余 N/A（符合“不做全局 fallback”）；只有单一 Greek 可选；无微笑/无档位 |
| `08-monitor.png` | `/monitor` | 3 个 ORS 中 2 个 HALTED，但 KPI 显示「ORS 运行」；无逐柜台行情龄/延迟 |
| `09-execution.png` | `/execution` | 真实状态在这里：agent/ORS/fencing/stream/desired-actual；`SIMVENUE-OPT-01` desired RUNNING/actual RUNNING 但部署状态 INACTIVE |
| `10-strategy-detail.png` | 策略详情 | 10 个动作平铺两行，「停止并平仓」「删除」与「复制策略」相邻；指标原始浮点（11289.154374644851） |
| `11-strategy-version-dialog.png` | 更新版本弹窗 | 版本默认 `v0.1.1`，配置 JSON 为空的 `{}`；无当前配置、无 diff；按钮「保存并部署」 |
| `12-manual-order-dialog.png` | 新建手工单 | 价格自动填 `866.5739174493044`（未按 0.02 最小变动价位取整）；买一/卖一有值但无时间/龄；无合约检索 |
| `13-emergency-confirm.png` | 应急确认 | 「停止全部并平仓」确认框无影响面（撤多少单/平多少手/涉及哪些策略），只需点一次 |
| `14-strategy-wizard.png` | `/strategy-center/new` | 5 步向导；第 1 步仅名称+类型；无模板、无账户保证金上下文 |
| `15-dashboard-1280.png` | `/` 1280×800 | 快照仅 1/3 时直接显示 10,016,137 权益（无 PARTIAL 覆盖）；交易日历 chip 与行情 chip 被隐藏 |
| `16-strategy-versions-deploy.png` | 版本/部署 Tab | 仅 1 个版本 v0.1.0；部署表 physical state `RUNNING` 与头部 `部署 ACTIVE` 两套词；回滚按钮对唯一版本仍可点 |
| `17-strategy-risk-tab.png` | 风险 Tab | 只有权益/保证金/占用率/净数量/名义敞口；无限额、无已用/剩余、无单笔上限；「数据龄」实际显示时间戳 |
| `18-strategy-recon-tab.png` | 对账 Tab | 对账通过/问题 0/连续失败 0；但同账户存在未归属 2 手，对账口径未说明 |
| `19-strategy-pnl-tab.png` | PnL Tab | 顶部「总 PnL 0.00」与曲线「最低/最高/最新 -335.00」同屏冲突；历史行全是 11-09 的 -335 |
| `20-strategy-orders-tab.png` | 策略订单 Tab | 订单 528 条只有列表，无撤单、无筛选、无实时新增 |
| `21-orders-positions.png` | `/orders` 总持仓 Tab | 点击后标签由「(0)」变「(6)」，证明懒加载计数错误；含 0/0 空行与 11-09/11-10 过期行 |
| `22-strategy-unassigned.png` | 策略中心 · 未分配 | 未归属成交可「认领」（好）；但只能进二级 Tab，驾驶舱 KPI 无下钻 |
| `api-snapshot.md` | — | 采集时刻的关键接口数据与自相矛盾项 |

> B 系统（quantlink-trading `/product_management/check`）**没有可访问的运行实例**：`101.43.54.190:8080` 属于另一个产品（AI 营养师后台），B 的生产环境指向内网 `amois.intranet.citicsf.com`，本地仓库未安装依赖。因此 B 的结论全部来自源码行号，不使用截图作为证据，也不对页面视觉做像素级评价。

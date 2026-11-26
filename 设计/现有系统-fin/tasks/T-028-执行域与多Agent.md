# T-028 执行域与多 Runtime Agent

- 状态：BLOCKED（仅剩多主机 Aeron 与交易日联调）
- 阶段：M5
- 依赖：T-020 CTP Adapter、T-023 Electron

## 目标

建立账户级执行所有权：Agent、柜台、账户、Aeron 流、租约、部署。

## Phase 0（当前）

- [x] 新增 `runtime_agents`
- [x] 过渡表 `agent_account_bindings/agent_leases/order_routes` 已迁移并删除
- [x] 新增 `strategy_deployments`
- [x] 回填 SimNow Agent / TEST-001 binding / route
- [x] 新增只读 `GET /api/v1/execution/topology`
- [x] 新增只读执行管理页面
- [x] 交易路由保持现状

## Phase 1

- [x] 订单发布按 route 选择独立 stream
- [x] SBE 增加 targetAgentId / routeId / fencingToken
- [x] ManualOrderPublisher 按 ors_instances 动态发布
- [x] Adapter ownership guard（agent/account/fencing token）
- [x] 全撤/TTL 撤单通过 account 路由动态 cancel stream

## Phase 2

- [x] deployment generation / ack / rollback（ack 已接入）
- [x] Agent 注册 / Agent 级心跳 API
- [x] Agent 心跳下发动作（START_ORS / DRAIN_ORS / STOP_ORS）
- [x] drain/cancel/reconcile/release/bind
- [x] RuntimeAgent 直接启动 ORS 进程（不依赖 systemd / sudo）
- [x] Agent 心跳返回绑定策略列表
- [x] 策略绑定表 `agent_strategy_bindings`
- [x] `backend:runtime-runner` 可执行策略进程
- [x] SimLocal 策略从 canary 迁到 RuntimeAgent 策略进程
- [x] ORS 随 Agent 生命周期启停，无 activate/drain/release
- [x] Agent 心跳上报 ORS status / pid / startedAt / error
- [x] 策略部署状态 UNDEPLOYED / INACTIVE / ACTIVE / FAILED
- [x] 策略 INACTIVE 也运行信号计算，只产生提醒
- [x] 策略 ACTIVE 才允许自动下单
- [x] 侧边栏策略详情 Badge + 全局消息通知
- [x] 驾驶舱展示 INACTIVE 策略触发提醒
- [x] 策略详情自动选中触发策略、显示标记、手动激活
- [x] 执行拓扑不再承载策略提醒
- [x] 消息中心页面（仅当天提醒）
- [x] strategy_alerts 保留 7 天
- [x] 交易日历页面与下一交易日提醒
- [x] 交易日历逻辑从 quantlink-trading 搬运
- [x] PAIR Java FuturesPairStrategy（两腿/EWMA/被动腿1/FAK腿2/专用页面）
- [x] PAIR daily_init/fee.csv 配置支持
- [x] PAIR 两腿挂单查询/撤单、FAK对冲、收盘前平仓
- [x] 策略进程滚动升级 / 版本哈希校验

## Phase 3

- [x] 顶部 ORS/账户上下文与用户偏好
- [x] CTP 持仓快照替换 + `position_history` 归档
- [x] fencing token 从 1000 开始
- [ ] 多主机 Aeron（需要第二台主机与独立 media driver，当前单机环境阻塞）
- [x] Agent token / mTLS（已实现 X-Agent-Token，mTLS 未启用）
- [x] 对账门禁（影子库已清理历史差异并启用 `QF_RECON_GATE_ENABLED=true`）
- [ ] SimNow 日盘实盘联调
- [ ] SimShengli 日盘联调

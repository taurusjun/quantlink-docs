# 多 Runtime Agent 与柜台/账号绑定

- 状态：Phase 0 完成；Phase 1 采用 ORS 简化模型
- 日期：2026-11-07
- 目标：建立执行所有权模型，先只读展示，不改变现有交易路由

## 0. 最终简化决策

已确认采用：

```text
1 ORS = 1 柜台 = 1 账户
1 Runtime Agent 最多托管 1 个 ACTIVE ORS
SimLocal 作为进程内 ORS
策略与 ORS 同机运行
```

因此新增 `ors_instances` 作为执行主线；此前的
`agent_account_bindings + agent_leases + order_routes`
已完成迁移并删除，不再保留。

账户隔离：

```text
SimLocal  → SIMLOCAL-001
SimNow    → TEST-001     (InvestorID 142266)
SimShengli→ TEST-SHENGLI (InvestorID 99000943)
```

同一账户不会跨柜台/ORS 使用。

核心表：

```text
ors_instances
  ors_id
  agent_id        UNIQUE (ACTIVE)
  venue_id
  account_id      UNIQUE (ACTIVE)
  adapter_kind
  process_key
  status
  fencing_token
  order_stream / cancel_stream / update_stream / trade_stream / md_stream
  last_heartbeat
```

策略部署目标改为：

```text
strategy_deployments.target_ors_id
```

订单路由简化为：

```text
account_id → 唯一 ACTIVE ors_instance → order_stream
```

不再需要独立 `order_routes` 表做多层解析。

## 1. 核心判断

当前缺口不是“多 Agent 页面”，而是执行所有权模型缺失：

```text
Strategy ── deployments.target(字符串) ──> 某个不存在的东西
Venue ── venue_configs(元数据) ──> 没有账户、Agent、Aeron 流
Account ── accounts ──> 没有柜台、Agent
Order ── orders.venue(请求字符串) ──> 没有真实路由
```

## 2. 模型

```text
RuntimeAgent
AgentAccountBinding
AgentLease
OrderRoute
StrategyDeployment
```

### RuntimeAgent

Agent 身份与心跳：

```text
agent_id
hostname
endpoint
agent_version
capabilities
boot_id
status
last_heartbeat
load_json
```

### AgentAccountBinding

核心粒度：

> 一个 Agent 上的一个 Adapter 执行槽 = 一个柜台 + 一个账户 + 一组 Aeron 流 + 一个租约。

```text
binding_id
agent_id
venue_id
account_id
adapter_kind
process_key
status
lease_epoch / fencing_token
order_stream / cancel_stream / update_stream / trade_stream / md_stream
config_hash
```

### AgentLease

```text
lease_id
resource_type = ACCOUNT
resource_id = account_id
agent_id
binding_id
fencing_token
status ACTIVE/EXPIRED/REVOKED
expires_at
```

### OrderRoute

只读路由快照：

```text
account_id → binding_id → agent_id → order/cancel/update/trade streams
```

### StrategyDeployment

```text
strategy_id / version / config_hash
target_binding_id / target_agent_id / account_id
generation
desired_state / actual_state
status / ack_at / rollback_of
```

## 3. 不变量

- 一个账户最多一个 ACTIVE binding
- 一个账户最多一个 ACTIVE lease
- 一条 ACTIVE route 的 order_stream 唯一
- 同一策略同一账户最多一个 ACTIVE deployment
- 没有 ACTIVE binding/lease 的账户禁止下单（Phase 1 生效）
- 迁移账户前必须 drain + 对账

数据库唯一索引只能防两个 ACTIVE，防不住旧进程继续交易，必须叠加 fencing token + Adapter 自检 + 进程隔离。

## 4. 页面信息架构

新增一级菜单：

```text
执行管理
  Agent 列表
  柜台—Agent—账户绑定
  路由诊断
  策略部署矩阵
```

Phase 0 先做只读拓扑页，不改变下单。

顶部选择器最终改为账户上下文：

```text
[执行账户 TEST-001 · SIMNOW · agent-simnow-01 · ONLINE]
```

## 5. 数据表

Phase 0 新增：

- `runtime_agents`
- `strategy_deployments`

扩展：

- `accounts.venue_id / investor_id / broker_id`
- `orders.agent_id / route_id / fencing_token / venue_id`

## 5.1 手动单与行情驱动单必须共用同一路由

`OrderRoute` 不是“手动下单专用”，它是所有订单意图的执行路由。

统一入口：

```text
手工交易 / 策略运行时 / 算法单
        ↓
OrderIntent（source=MANUAL|STRATEGY|ALGO, accountId, strategyId）
        ↓
OrderRouter
  → 查 account 的 ACTIVE route
  → 校验 binding / lease / fencing token
  → 选择 SimExchange（stream=0, SIM）或 Aeron stream
        ↓
执行
```

区别只在：

```text
source=MANUAL   手工单
source=STRATEGY 策略单
```

不能出现：

```text
手工单走 route
策略单直接写数据库 / 发全局 2001
```

### 行情驱动场景

策略运行时产生订单时：

1. 策略部署已经绑定 `target_binding_id` / `target_agent_id` / `account_id`
2. Agent 从心跳响应或部署包获得当前 `route_id`、`order_stream`、`fencing_token`
3. 策略发单时携带 `accountId`、`strategyId`、`routeId`、`fencingToken`
4. 若走控制面统一入口，由 OrderRouter 再校验一次 route
5. route 不可用、lease 过期、token 过期 → 策略单 fail closed，不 fallback

低延迟方案：

- Agent 本地缓存 route assignment
- 订单直接发到本地 route 的 order_stream
- 控制面通过心跳下发 route generation / revokedLeases
- Adapter 再做 ownership guard

无论哪种方式，行情驱动单和手工单最终都落到同一条 account route。

### 当前差距

- `StrategyExecutionService` 目前仍直接写数据库 + SimExchange，未经过 OrderRouter
- `RuntimeOrderCodec` 仍硬编码 `accountId="SIM"`、`strategyId=0`
- 策略部署还没有绑定 route generation
- Phase 1 只完成了手工单和撤单的 route 化，策略路径需要继续改造


## 5.2 参考 quantlink-trading 的订单路径

参考项目的策略并不直接连接 CTP，也不决定 offset 或 Aeron stream。

路径：

```text
Strategy
  → ExecutionStrategy::SendNewOrder(... m_account ...)
  → CommonClient::SendNewOrder(...)
  → RequestMsg { AccountID, StrategyID, Product, Symbol, Side, Price, Qty }
  → Connector::SendNewOrder
  → m_requestQueue[Exchange_Type]
  → ORS
  → CTP
```

关键代码：

```text
tbsrc/Strategies/ExecutionStrategy.cpp:1563
tbsrc/main/CommonClient.cpp:957
C++_deps/hftbase/Connector/include/connector.h:275
ors/China/src/ORSServer.cpp:406
```

对应关系：

- 策略只提供账户、策略号、合约、方向、价格、数量
- `AccountID` 和 `StrategyID` 放在 RequestMsg 里
- ORS 进程从配置读取 `BROKER_ID` / `INVESTOR_ID`
- offset 由 ORS 的 `SetCombOffsetFlag` 按今昨仓自动解析
- 人工后台 `tbadmin` 也是构造 RequestMsg 入队，不直接调 CTP

因此参考项目里“业务不感知底层”的本质是：

```text
策略/手工 → RequestMsg → 队列/ORS → CTP
```

它的队列主要按 `Exchange_Type` 划分，隐含假设是一个 ORS 部署对应一个柜台/账户。

我们的多 Agent 场景不能只按交易所分队列，因为同一交易所可能有多个账户、多个 Agent，所以要把队列/流升级为：

```text
account_id
  → 唯一 ACTIVE OrderRoute
  → binding/agent
  → order_stream
```

也就是说：**route 就是参考项目 RequestMsg 队列在多账户/多 Agent 下的升级版。**


## 5.3 RuntimeAgent / ORS / Strategy 的关系

不要混淆三层：

```text
RuntimeAgent
  = 一台主机上的执行代理，最多托管 1 个 ACTIVE ORS

ORS
  = 该主机上的柜台执行进程/进程内执行体
  = 固定一个柜台 + 一个账户

Strategy
  = 运行在同一台主机上的策略进程
  = 可以多个，通过 ORS 发单
```

关系：

```text
RuntimeAgent 1 ── 1 ACTIVE ORS
RuntimeAgent 1 ── N Strategy processes
```

`runtime_agents` 表表示 Agent；
`ors_instances.agent_id` 表示该 Agent 当前托管的 ORS；
RuntimeAgent 配置里的 `instances` 是**策略进程**，不是 ORS。

当前 `agent-control-local` 的 `instances=[]` 表示：

- 该 Agent 已在线
- SimLocal ORS 是进程内执行体，不需要外部命令
- 还没有配置真实的策略进程

### ORS 激活与 Adapter 自动启动

目标流程：

```text
管理面点击“激活 ORS”
  → ORS status = STARTING
  → Agent 心跳收到 START_ORS
  → Agent 启动该 ORS 的 Adapter/进程
  → Agent 回报 ACTIVE
  → 管理面显示 ACTIVE
```

当前实现是管理面直接置 ACTIVE，尚未接入 Agent 自动启动 Adapter。
这是下一步 Phase 2 的工作。

## 6. 分阶段实施

### Phase 0：模型 + 只读拓扑

- 建表
- 回填当前 SimNow Agent / TEST-001 binding / route
- 只读执行管理页面
- 交易路由不变

### Phase 1：流隔离

流区间规划：

```text
1000-1099 行情 MD
2001-2005 Phase 0 遗留执行流
2100-2999 Sim/Test 执行槽位（每个槽位 10 个 stream）
3000-3999 Prod 正式账户执行槽位（每个槽位 10 个 stream）
4000-4999 遥测 / 控制 / 对账
```

每个槽位：

```text
+0 order
+1 cancel
+2 update
+3 trade
+4 health
+5..+9 reserved
```

- 每账户独立 Aeron stream
- OrderRequest 增加 targetAgentId / routeId / fencingToken
- Adapter ownership guard
- 手工单、策略单、全撤按 route 发送

### Phase 2：部署闭环

- generation / config hash
- desired vs actual
- Agent ack / rollback
- drain → cancel → reconcile → release → bind → deploy

### Phase 3：多主机与安全

- Aeron UDP
- 每 Agent token / mTLS
- 对账门禁
- 顶部账户上下文

## 7. 风险

- 同一 InvestorID 多会话登录可能互踢
- 旧 Agent 失联但进程仍活着
- 跨主机不能使用共享 IPC
- client_order_id 并发撞号
- 多 Adapter 行情重复发布
- 柜台查询与 DB 不一致以柜台为准

## 6. 当前实现状态（2026-11-07）

### 6.1 Agent 与 ORS 进程

RuntimeAgent 除策略实例外，新增单个 ORS 进程配置：

```properties
instances=sim-local-opt,sim-local-hedge

ors.id=ors-simnow-test-001
ors.command=/opt/quantlink-fin/ctp-adapter/qf-ctp-aeron ...
ors.workDir=/opt/quantlink-fin/ctp
ors.autostart=true
```

行为：

```text
Agent 启动
  → ORS 随 Agent 启动
  → Agent 停止
  → ORS 停止

ORS 没有 activate / drain / release 业务动作。
ORS 状态只有进程状态：
  RUNNING / STOPPED / ERROR / HALTED
```

Agent 把 ORS 的 `status / pid / startedAt / error` 放在 Agent 心跳里：

```json
{
  "ors": {
    "orsId": "ors-simnow-test-001",
    "status": "UP",
    "pid": 192386,
    "startedAt": "2026-11-07T15:02:26+08:00",
    "error": ""
  }
}
```

控制面写入 `ors_instances.status / pid / started_at / error /
last_heartbeat`，执行页面直接展示。

Agent 不调用 systemd、不需要 sudo。ORS 进程连续异常退出时按
30s / 60s / 90s 退避，最多 3 次后进入 `HALTED`，避免非交易时段
CTP 重复登录导致锁定。

### 6.2 策略进程

新增可执行模块：

```text
backend/runtime-runner
```

Runner 的职责边界：

```text
行情：轮询控制面 /api/v1/market/ticks
持仓：轮询控制面 /api/v1/positions，作为权威净持仓
策略：复用 backend/runtime 的 RuntimeEngine / Strategy
下单：POST /api/v1/strategy/orders
      → 控制面解析 RUNNING ORS、账户、开平、SimLocal/CTP 路由
```

Runner 不直接写数据库，也不直接选 account/offset/stream。

### 6.3 策略绑定与部署

绑定回答“策略放在哪个 Agent/ORS”：

```text
agent_strategy_bindings
  agent_id
  ors_id
  strategy_id
  strategy_version
  status
```

部署回答“当前是否激活、运行哪个版本”：

```text
strategy_deployments
  strategy_id
  strategy_version
  target_ors_id / target_agent_id / account_id
  generation
  status
```

策略状态：

```text
UNDEPLOYED  没有 deployment 行
INACTIVE    已部署到 Agent，进程停止
ACTIVE      已手动激活，进程运行
FAILED      Agent 启动失败
```

规则：

- 没有部署到任何 Agent = `UNDEPLOYED`
- 部署到 Agent 后默认 = `INACTIVE`
- 手动激活 = `ACTIVE`
- 停止 = `INACTIVE`
- Agent 对 `ACTIVE` 和 `INACTIVE` 都启动策略进程
- `INACTIVE` 只产生策略提醒，不自动下单
- `ACTIVE` 才允许自动下单
- 部署前必须有对应的 `agent_strategy_bindings`

策略 Runner 的模式由控制面实时读取：

```text
GET /api/v1/strategy-deployments/state?strategyId=...&orsId=...

INACTIVE → POST /api/v1/strategy/alerts
ACTIVE   → POST /api/v1/strategy/orders
```

策略提醒写入 `strategy_alerts`，执行页面展示并可由交易员确认。

### 6.4 当前实例

```text
agent-control-local  → ors-simlocal-001        RUNNING  (进程内 ORS)
agent-simnow-01      → ors-simnow-test-001     STOPPED  (非交易时段不启动)
agent-shengli-01     → ors-shengli-test-shengli STOPPED (仅日盘)
```

SimNow 的 ORS 启动命令已配置在
`/etc/quantlink-fin/runtime-agent-simnow.properties`。
SimShengli 国盛评测参数已配置在
`/etc/quantlink-fin/ctp/ors_server_shengli.cfg`。

### 6.5 提醒通知

```text
INACTIVE 策略触发
  → strategy_alerts
  → 侧边栏“策略详情”Badge 计数
  → 全局消息通知
  → 交易驾驶舱提醒卡片
  → 点击策略详情自动选中触发策略
  → 显示“已触发”标记
  → 提供“手动激活”按钮
```

执行拓扑页只负责 Agent/ORS/进程/部署，不再承载策略提醒列表。

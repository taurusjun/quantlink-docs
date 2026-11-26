# quantlink-fin 架构评审（金融交易系统标准）

- 日期：2026-11-08
- 评审对象：`quantlink-fin`（SimLocal / SimNow / SimShengli）
- 代码基线：`main` 当前版本
- 评审方式：代码走查 + 线上 SimLocal 影子环境快照
- 未覆盖：CTP 交易日实盘验证、5 个交易日长稳、Windows 安装包、多机 Aeron
- 评审人：AI 架构评审（按金融交易系统标准）

---

## 0. 执行摘要

### 0.1 一句话结论

**架构方向正确，当前是“能跑通的交易工程样机”，不是“可以接真钱的金融交易系统”。**

| 场景 | 结论 | 说明 |
|---|---|---|
| 模拟 / 研究 | 可用 | Aeron 直连、策略、模拟交易所已闭环 |
| 影子 / 小资金试点 | **不通过** | 账本、风控输入、对账、应急仍有 P0 |
| 实盘 | **不通过** | 存在错单、漏撤、超限、审计缺失风险 |

当前最危险的不是“缺功能”，而是几个**看起来生效、实际没生效**的地方：

```text
对账 gate 显示 passed，但场所仍有大量挂单未对平
stop-all 看起来停了，实际 agent 仍按 deployment 状态运行
本地风控有快照，但可用资金、保证金、手续费、PnL 不是权威值
UI API 失败后回退 mock，交易员可能照着假数据做决策
```

### 0.2 评审现场快照

以下为本次评审时点的线上 SimLocal 影子环境数据，仅用于说明“当前状态”，不代表永久值：

```text
reconciliation/consistency:
  passed=true, issueCount=0

SimLocal venue vs local:
  local openOrders = 2
  venue openOrders = 31
  differences = 29 笔 missing_locally

risk snapshot:
  available = 800000
  pnl = 0
  reconciliationGateEnabled = true
  reconciliationPass = true

audit_log:
  total = 47,684
  RUNTIME_HEARTBEAT = 45,136

Runner metrics latest:
  tickToDecisionP99 = 6.29 ms   （目标 < 5 ms）
  decisionToOrderP99 = 5.05 ms  （目标 < 1 ms）
  aeronBackpressure = 0
```

这些数字说明两件事：

1. **可观测性和遥测已经存在**，不是“没有指标”；
2. **指标和门禁还没有形成可信的金融级闭环**。

### 0.3 最优先修复的五件事

| 顺序 | 事项 | 原因 |
|---|---|---|
| 1 | **执行事件持久化 + 可重放审计** | 控制面宕机会丢失订单/成交/持仓证据 |
| 2 | **账户账本 + 手续费 + 保证金 + 结算** | 当前可用资金/保证金/PnL 不是权威值 |
| 3 | **本地风控输入权威化 + 交易日历 + 行情龄** | 当前风控可能基于旧数据/缺失数据放行 |
| 4 | **场所级对账 + 差异阻断 OPEN** | 当前 Gate 只做本地一致性，已出现 false positive |
| 5 | **本地应急开关 + cancel-on-disconnect + drain** | 当前 stop-all 停不住，重启/断线会留下未知挂单 |

---

## 1. 评审范围与方法

### 1.1 范围

包含：

```text
backend/control-plane
backend/runtime
backend/runtime-runner
backend/runtime-agent
backend/ors-core
backend/sim-exchange
backend/reconciliation
backend/telemetry
backend/shared/aeron
backend/shared/sbe
ctp-adapter
web/src
deploy/
tools/db/
```

不包含：

```text
quantlink-trading C++ 老系统（本次评审对象是 quantlink-fin）
真实 CTP 交易日的完整联调
Windows 安装包验收
多机 Aeron 部署
```

### 1.2 方法

- 阅读 `docs/architecture/01-架构硬约束.md`、`10-Runtime控制设计.md`、`12-模拟交易所.md`、`13-执行指令与交易所规则.md`、`14-多Runtime-Agent与柜台账号绑定.md`、`16-PAIR策略配置设计.md`。
- 走查控制面、Runner、SimLocal、CTP Adapter、Reconciliation、Telemetry 的关键代码路径。
- 查询线上 SimLocal 影子环境的服务状态、ClickHouse 指标、PostgreSQL 订单/持仓/审计数据。
- 使用 `tools/reconcile-simlocal.py` 对比本地与 SimLocal 场所快照。

### 1.3 分级口径

- **P0**：可能导致错单、漏撤、超限、账本错误、审计缺失，或让交易员基于错误数据决策；**实盘/影子试点前必须解决**。
- **P1**：显著增加运营风险、恢复风险或误操作概率；**试点期内必须解决**。
- **P2**：不影响正确性，但影响效率、容量、可维护性；**规模化前解决**。

---

## 2. 架构现状

### 2.1 现有分层

```text
Control Plane（Spring Boot）
  ├─ 配置/策略/部署/审计/查询/UI
  ├─ 异步消费订单/成交/行情
  └─ PostgreSQL / ClickHouse / WebSocket

Runtime Agent（本机）
  ├─ 期望状态收敛
  ├─ 策略进程管理
  └─ ORS/CTP Adapter 进程监督

Runtime Runner（策略进程）
  ├─ 直接订阅 Aeron 行情
  ├─ 策略计算
  ├─ 本地预交易风控
  └─ 直接发 Aeron OrderRequest

SimLocal / CTP Adapter
  ├─ 撮合或 CTP 交易
  ├─ OrderUpdate / Trade 回报
  └─ PositionSnapshot
```

### 2.2 已具备的能力

1. **控制面 / 数据面 / 交易面分离的方向正确**
   - Runner 直接订阅 Aeron 行情；
   - 订单走 `Strategy → Local Risk → Aeron → Adapter`；
   - 控制面异步消费订单/成交，不进入 tick 热路径。

2. **本地风控雏形正确**
   - 风控快照过期时，OPEN fail-closed，CLOSE/CANCEL 仍允许；
   - 校验 tick、lot、active instrument、交易时段、最大挂单、最大持仓、最大成交量、亏损限制；
   - 具备 `requestId`、`strategyKey`、`fencingToken` 字段。

3. **执行所有权模型清晰**
   - `1 account = 1 agent = 1 ORS`；
   - `ors_instances`、`strategy_deployments`、`agent_strategy_bindings` 有唯一约束；
   - CTP Adapter 对新订单校验 `targetAgentId / accountId / fencingToken`。

4. **Telemetry 已经真实落 ClickHouse**
   - 7 张表、TTL 366 天；
   - `AsyncTelemetrySink` 有界队列、批量写入、队列满丢弃；
   - Runner 每 30 秒上报 p50/p99、队列深度、背压、控制面 lag。

5. **对账框架和证据链已经起步**
   - `ReconciliationService` 支持订单/成交/持仓/资金比较；
   - SimLocal 网关有快照；
   - 已有 P0/Aeron/模拟交易所验收证据。

6. **Agent 模型具备可运维性基础**
   - 期望状态/实际状态分离；
   - systemd + Agent 监督；
   - 版本哈希已上报。

### 2.3 当前关键路径

行情：

```text
SimMdPublisher / CTP Adapter
  → Aeron MARKET_DATA
  → AeronMarketData
  → PairSpreadRunner / RuntimeRunnerMain
```

订单：

```text
Strategy
  → AeronOrderGateway.submit
  → OrderRequest (SBE/Aeron)
  → SimExchangeAeronGateway / CTP Adapter
  → OrderUpdate / Trade (SBE/Aeron)
  → Runner 本地账本 + Control Plane 异步落库
```

控制面：

```text
Control Plane
  → 配置 / 部署 / 风险快照 / 状态查询
  → Runner 定时拉取（非 tick 路径）
  → 异步消费订单/成交/行情
```

---

## 3. 发现总表

| ID | 级别 | 领域 | 发现 | 结论 |
|---|---|---|---|---|
| ARCH-P0-01 | P0 | 可用性 | 控制面仍直接决定 Runner 是否交易 | 控制面抖动会撤单/停策略，违反硬约束 |
| ARCH-P0-02 | P0 | 持久化 | 执行事件/审计不可重放 | 控制面宕机窗口无法恢复 |
| ARCH-P0-03 | P0 | 执行语义 | SimLocal 成交/撤单语义错误 | 账本/对账证据不可信 |
| ARCH-P0-04 | P0 | 账本 | 手续费/保证金/结算/资金不成立 | 风控和 PnL 基于错误数字 |
| ARCH-P0-05 | P0 | 风控 | 本地风控输入不权威，安全门禁不全 | 可能超限、旧价交易、节假日交易 |
| ARCH-P0-06 | P0 | 对账 | 对账 Gate 只做本地一致性 | 已出现 false positive |
| ARCH-P0-07 | P0 | 应急 | stop-all/重启/断线/收盘不安全 | 可能留下未知挂单或裸腿 |
| ARCH-P0-08 | P0 | 数据可信 | UI mock/模拟行情覆盖真实数据 | 交易员可能基于假数据决策 |
| ARCH-P1-01 | P1 | 部署 | 配置/版本/回滚未闭环 | 热加载绕过部署审计 |
| ARCH-P1-02 | P1 | 订单 | 订单 ID 可能冲突，多路径并存 | 覆盖/错归属/绕过风控 |
| ARCH-P1-03 | P1 | 安全 | WS 未鉴权、静态 token、明文凭据 | 数据泄露/暴力破解 |
| ARCH-P1-04 | P1 | 可观测性 | 告警不自动消费指标 | 阈值告警不会自动触发 |
| ARCH-P1-05 | P1 | 数据模型 | 缺交易日/结算历史/审计保留 | 夜盘归属、PnL 历史、审计不可信 |
| ARCH-P1-06 | P1 | 工程 | 无 CI、无故障注入 | P0 约束无法持续验证 |
| ARCH-P1-07 | P1 | 可用性 | 单机单库、无备份/HA | 主机/DB 故障不可恢复 |
| ARCH-P1-08 | P1 | 交易规则 | 日历/期权到期/换月未闭环 | 节假日、到期、换月风险 |
| ARCH-P1-09 | P1 | 生命周期 | SimLocal ORS 不归 Agent 管 | 页面 RUNNING 但网关可能已死 |
| ARCH-P1-10 | P1 | 合规 | 无双人复核/变更审批 | 误部署/供应链风险 |

---

## 4. P0 详细发现

### ARCH-P0-01 控制面仍然直接决定 Runner 是否交易

**证据**

```text
ControlPlaneClient.deploymentState()
  → 请求失败时返回 status = "UNKNOWN"

PairSpreadRunner.tick()
  → mode 不是 ACTIVE / INACTIVE 时 cancelAll(openOrders) 并 return

RuntimeRunnerMain.ModeAwareOrderSink.send()
  → 只有 ACTIVE 才下单，UNKNOWN 直接忽略
```

这直接违反架构硬约束：

```text
control-plane 停止
→ runner 继续收行情 / 决策 / 撤单 / 平仓
→ 风险快照新鲜期内继续开仓
```

实际行为是：**控制面一抖动，Runner 撤掉全部挂单并停止交易**。控制面仍然在交易控制链路上。

**影响**

- 控制面网络抖动/重启会造成策略无谓撤单；
- 与架构硬约束不一致；
- 运维无法把控制面当作纯管理面。

**修复建议**

- Runner 本地保存 **deployment lease**（带 TTL、generation、last-known-good）；
- 控制面只更新期望状态，不参与每个 tick 的判定；
- lease 过期时：禁止新开仓，但保留撤单、平仓、已有订单管理；
- 不要因为一次 HTTP 失败就 `cancelAll`；
- 增加“控制面宕机 10 分钟”故障注入测试。

---

### ARCH-P0-02 执行事件和审计没有持久化恢复能力

**证据**

- `AeronOrderUpdateConsumer` 的 `pendingUpdates`、`pendingTrades` 全部在内存；
- 生产部署没有看到 Aeron Archive / 持久化订阅；
- Control Plane 宕机期间，Aeron IPC 上的订单请求、OrderUpdate、Trade 没有持久化留存；
- 恢复后只能看到新消息，不能重放宕机窗口。

**影响**

```text
控制面宕机 → 订单已成交 → DB 没有订单/成交
恢复后 → 持仓、PnL、审计、对账全部缺失
```

在一个金融系统里，审计不能依赖“当时 consumer 正好在线”。

**修复建议**

- Aeron Archive 或本地 append-only journal / WAL；
- 每个事件带 `account_id + sequence + event_id`；
- Control Plane 做幂等消费，记录消费位点，可重放；
- 订单、成交、持仓、资金变更必须能从事件重建；
- 审计日志改为 append-only，禁止 UPDATE/DELETE；
- Adapter 在启动时查询未完成订单，补发/重放状态。

---

### ARCH-P0-03 SimLocal 的成交/订单语义会产生错误账本

这是当前模拟环境最严重的问题，直接影响所有 SimLocal 验收结论。

**证据**

1. **多档成交 tradeId 冲突**

```java
// SimOrderCodec.encodeTrade
.tradeId("TR-" + fill.clientOrderId() + "-"
    + (fill.timestampNanos() % 1_000_000_000L))
```

同一笔订单扫多档时，`submitOrder` 给所有 fill 使用同一个 `timestampNanos`，因此多笔成交生成相同 `tradeId`。控制面 `insertTradeIfAbsent` 只保留第一笔，后续成交丢失。

2. **撤单把 filledQty 覆盖为 0**

```java
// SimExchange.cancel
return new SimOrderUpdate(..., CANCELED, 0, order.remaining, ...)
```

控制面 `applyOrderUpdate` 直接覆盖 `filled_qty`，部分成交后撤单会把已成交数量清零。

3. **OrderUpdate 的 filledQty 语义不统一**

`submitOrder` 返回累计成交量，`matchResting` 返回本次增量；控制面按绝对值覆盖，Runner 按“大于 0 才更新”处理，双方状态会分叉。

4. **SimLocal 忽略 offset / account**

`SimOrderCodec.decodeRequest` 只读取价格、数量、方向，不读取 `offsetFlag`、`accountId`、`routeId`、`fencingToken`。`SimExchange` 也不校验账户、平今/平昨、reduce-only、保证金。CLOSE 单可以在没有对应持仓时反向开仓。

5. **模拟撮合顺序不是价格-时间优先**

`matchResting` 遍历 `HashMap`，多个挂单的成交分配顺序不确定。

**影响**

```text
SimLocal 的成交、持仓、对账、PNL 证据不可信
T-027 的 20 条验收不能证明 CTP 语义正确
```

**修复建议**

- `fillId = orderId + fillSeq`，全局唯一；
- `filledQty` 统一为累计值，`remainingQty` 统一为剩余值；
- 撤单必须保留已成交数量；
- 每条 OrderUpdate 带 `sequence`，接收端拒绝旧序号；
- SimLocal 必须校验 account/offset/reduce-only/fencing；
- 撮合按价格-时间优先；
- 增加“部分成交后撤单”“多档扫单”“重复成交回报”测试。

---

### ARCH-P0-04 账户账本、手续费、保证金、结算不成立

**证据**

- `AeronOrderMapper.insertTradeIfAbsent` 和 `StrategyOrderMapper.insertTrade` 的 `fee` 固定为 `0`；
- `instrument_fees` 表存在，但成交链路没有使用；
- 成交不会更新 `accounts.balance / available / margin`；
- `TelemetrySnapshotScheduler` 写出的账户快照仍是：

```text
SIMLOCAL-001 balance=1,000,000 available=800,000 margin=200,000
```

- `PortfolioController` 的期权 IV 固定 `0.18`，保证金按 `10%` 估算；
- 没有交易日结算、今日/昨仓滚动、逐日盯市、已实现/未实现 PnL 拆分。

**影响**

```text
可用资金不是权威值
保证金占用不是权威值
手续费为 0
账户权益/PnL 可能错误
风控基于错误数字做决策
```

**修复建议**

- 建立账户级 double-entry ledger：

```text
cash
frozen_margin
available
realised_pnl
unrealised_pnl
commission
```

- 成交时同时更新订单、成交、持仓、资金、手续费；
- 每个交易日做结算和 today/yesterday 滚动；
- 期权 IV/Greeks 来自行情/模型，不用固定值；
- 账户权益、保证金、可用资金必须与 CTP 查询结果对账；
- `instrument_fees` 按 `account + instrument` 参与成交费用计算。

---

### ARCH-P0-05 本地风控输入不权威，安全门禁不完整

**证据**

- `AeronOrderGateway.refreshRisk` 只在第一次加载时 seed 持仓：

```java
if (!riskLoaded && rows instanceof List<?> list) { ... }
```

之后只更新风险快照，不再校正本地持仓。

- `available` 只校验 `> 0`，不校验所需保证金；
- `max_position`、`max_loss`、`max_traded_qty` 默认 `0`，等于不限制；
- 没有账户级风险聚合：同一账户多个策略各自检查自己的限额；
- 没有交易日历门禁；
- 没有行情新鲜度门禁：Aeron 最新 tick 停止后，Pair 仍会基于旧 tick 报价；
- 没有价格笼子 / 最大偏离 / 涨跌停校验；
- 没有平仓数量校验：CLOSE 可以超过实际持仓；
- 没有报单频率限制、自成交防护、连续拒单熔断；
- `sessionOpen` 只按本地时间判断，不检查节假日；两条腿的交易时段也没有取交集。

**影响**

```text
多个策略可合计突破账户限额
节假日前/行情中断时仍可能报价
可用资金不足时仍可能开仓
平仓可能反向开仓
```

**修复建议**

- 本地风险状态必须来自：成交 + 交易所持仓快照 + 资金快照；
- 账户、策略、合约三级限额；
- 交易日前置校验；
- tick 龄 > 阈值时禁止 OPEN，允许 CANCEL/CLOSE；
- 价格笼子、最大名义金额、最大单笔、报单速率；
- CLOSE 数量不得超过对应持仓；
- 所有限额必须有强制默认值和“未配置即拒绝”策略。

---

### ARCH-P0-06 对账 Gate 名不副实

**证据**

- `QF_RECON_GATE_ENABLED=true`；
- `StrategyRuntimeController.risk()` 的 `reconciliationPass` 只调用：

```java
reconciliation.consistency()
```

- `consistency()` 只做本地校验：

```text
positions 净额 vs trades 推算
FILLED 订单是否有 trade
```

- 不比较 SimLocal/CTP 场所订单、成交、持仓、资金；
- `sumTradeNet(instrument)` 和 `listPositions()` 没有按账户隔离。

**本次评审现场数据**

```text
/api/v1/reconciliation/consistency:
  passed=true, issueCount=0

SimLocal 场所快照 vs 本地：
  local openOrders = 2
  venue openOrders = 31
  differences = 29 笔 missing_locally
```

也就是说：**本地门禁是绿的，但场所还有 31 笔挂单没有对平。**

**影响**

- 切换实盘时可能带着未知挂单/持仓；
- 策略以为已经平仓，交易所仍有单；
- 对账 Gate 给管理层错误信心。

**修复建议**

- Gate 必须使用场所级快照：CTP 查询 / SimLocal 快照；
- 按 `account_id` 隔离订单、成交、持仓、资金；
- 比较订单、成交、持仓、账户权益、手续费；
- 差异 > 0 时禁止 OPEN，只允许撤单/平仓；
- 记录“最后一次成功对账时间”，超过阈值同样阻断；
- 将 `reconciliationGateEnabled` 和实际 venue compare 结果绑定，不能再只看本地 consistency。

---

### ARCH-P0-07 应急、重启、断线、收盘处理不安全

**证据**

1. `EmergencyController.stopAll` 实际执行：

```sql
UPDATE strategies SET status = 'PAUSED'
UPDATE runtime_instances SET status = 'STOP_REQUESTED'
```

但 Agent 的 `HeartbeatClient.superviseStrategies()` 只看 `strategy_deployments.status`。`strategies.status` 变了，`strategy_deployments.status` 仍是 ACTIVE，因此**策略进程不会停**。

2. `stopAll` 不撤单、不平仓；
3. `flattenStrategy` 走 `StrategyOrderService`，要求策略 `ACTIVE`；stop-all 先把策略改成 PAUSED，紧急平仓会失败；
4. 没有本地 kill switch / dead-man switch；
5. CTP Adapter 的 `orderMeta_` 只在内存，重启后丢失 `requestId / strategyKey`，旧订单的回报无法归属；
6. SimExchange 重启只恢复持仓，不恢复现金、手续费、已实现 PnL、挂单；
7. `ProcessManager.reload()` 直接 stop/start，没有 drain、撤单、平仓；
8. `StrategyCloseoutScheduler` 和 Pair Runner 都做收盘平仓，存在重复平仓风险。

**影响**

```text
盘中出事时 stop-all 停不住
停住了也可能留着挂单
重启后订单归属丢失
收盘可能裸腿或重复平仓
```

**修复建议**

- 本地 Agent / Runner 提供 kill switch，不依赖控制面；
- stop-all 必须：停止新单 → 撤全部挂单 → 按策略平仓 → 确认 flat → 停进程；
- reload 前必须 drain；
- Adapter 启动时查询 CTP 未完成订单/持仓，重建 `orderMeta`；
- SimExchange 重启恢复完整账本，不只持仓；
- 断线自动 cancel-on-disconnect 或本地 dead-man 超时撤单；
- 收盘平仓只能有一个 owner，Runner 和 Scheduler 二选一。

---

### ARCH-P0-08 UI 和行情源存在 fail-open / 假数据

**证据**

- `web/src/pages/Dashboard.tsx` 仍保留：

```text
mockPositions
mockIndicators
hardcoded metrics（Delta/Vega/PNL/保证金）
API 失败 catch → setPositions(mockPositions)
```

- `Monitoring.tsx` 的 p99、Aeron 队列、ClickHouse 磁盘仍显示“未接入”；
- `MarketDataService.simulate()` 默认 `autoSimulate=true`，并且只跳过 `source == "external"` 的 tick；
- Aeron 消费的 source 是 `"aeron"`，不是 `"external"`，所以**真实 Aeron 行情也会被模拟 tick 覆盖**；
- `MarketDataAeronConsumer` 把 `System.nanoTime()` 当 epoch 毫秒写入 `timestampMs`，UI 数据龄可能错误。

**影响**

```text
交易员可能看到 mock 持仓
看到的是模拟覆盖后的价格
数据龄显示错误
基于假数据做真决策
```

**修复建议**

- 生产/影子环境 API 失败时整页 fail-closed，禁止 mock 回退；
- 所有价格、持仓、PnL 显示来源和数据龄；
- 真实环境禁止自动模拟覆盖；模拟数据必须显式标记并隔离；
- 时间戳统一为 epoch nanos/millis，禁止跨进程用 `System.nanoTime()` 当墙钟；
- 前端交易按钮在数据 stale / offline / mock 时禁用。

---

## 5. P1 详细发现

### ARCH-P1-01 配置/部署/回滚没有真正闭环

**证据**

- `strategy_deployments.config_hash` 默认为空，没有真正计算/校验配置内容 hash；
- Agent 只比较 `deployment.version()` 字符串，不比较 `versionHash`；
- `RuntimeController` 存储 `version_hash`，但控制面没有拿它和部署期望值比较；
- Runner 每 30 秒直接热加载 `pairRuntimeConfig` / `commonRuntimeConfig`，不经过 deployment generation；
- 没有自动回滚；
- `ProcessManager.reload()` 没有 drain。

**影响**

- 修改参数可能绕过部署审计；
- 版本字符串相同但内容变化时不会触发重启；
- 新版本失败不能自动恢复上一稳定版。

**建议**

- 配置内容 hash + generation + 版本签名；
- 部署 ACK 超时标记 FAILED；
- 上一稳定版本保留并支持一键回滚；
- 运行中配置变更必须生成新 generation；
- reload 前先撤单/平仓/等待 flat。

---

### ARCH-P1-02 订单 ID 可能冲突，多路径并存

**证据**

```text
AeronOrderGateway.nextClientOrderId()
  = (System.currentTimeMillis() % 900_000_000) * 1000 + sequence

多个 Runner 进程各自维护 sequence
```

- 900,000,000 ms 约 10.4 天回绕；
- 多个策略在同一账户、同一毫秒、同一 sequence 时可能生成相同 ID；
- `orders.client_order_id` 是唯一键，冲突会导致插入失败/归属丢失；
- `OrderGatewayFactory` 在 `orderMode` 缺失/为空时可能静默回退 HTTP；
- `TradingController` 有 in-process SimExchange 路径；
- `StrategyExecutionService` 仍有直接写库 + SimExchange 的 legacy canary 路径。

**影响**

- 订单覆盖/错归属；
- 绕过统一风控/审计；
- 与架构硬约束“唯一订单路径”不一致。

**建议**

- 账户级 ID 分配器，或 boot epoch + strategy hash + 单调序列；
- 只保留一条 OrderRouter；
- HTTP/in-process 仅限显式测试模式；
- 生产配置缺失时 fail-closed，不静默回退。

---

### ARCH-P1-03 安全边界不足

**证据**

- `SecurityConfig` 将 `/ws/**` 设为 `permitAll`；
- WebSocket `setAllowedOriginPatterns("*")`；
- Agent token 是静态共享 token；
- 没有 mTLS；
- SimNow 的 `ors_server_simnow.cfg` 仍包含明文 `PASSWORD / AUTH_CODE`；
- Nginx 没有明显的 API 限流；
- `audit_log` 是普通表，可 UPDATE/DELETE；
- `runtime-agent` 的 `/instances` GET 未鉴权。

**影响**

- 未认证 WS 可读取行情/策略信号；
- 凭据泄露；
- 暴力破解/重放；
- 审计不可信。

**建议**

- WebSocket 鉴权（token/session）；
- Agent mTLS 或 token 轮换；
- Nginx rate limit / 登录失败锁定；
- 全量 CTP 凭据加密；
- 审计 append-only + 只读账号 + 哈希链；
- 最小权限运行。

---

### ARCH-P1-04 告警没有闭环

**证据**

- `AlertService.onMetric` 只被 `TelemetryController` 的 `POST /api/v1/telemetry/metrics` 调用；
- Runner 的 `RunnerMetrics` 通过 `/api/v1/telemetry/runner` 写入 `TelemetryService`，再写 ClickHouse；
- `TelemetryService.runnerMetrics` 没有调用 `AlertService`；
- `gateway_health` 当前只有旧记录，未持续更新；
- `Monitoring.tsx` 的 p99/队列/磁盘仍显示“未接入”。

**影响**

- 4 条阈值规则不会自动触发；
- 指标存在但没有人被通知；
- 值班人员无法依赖系统告警。

**建议**

- `TelemetryService` 直接把关键指标送入 `AlertService`；
- 增加告警确认/静默/升级；
- 修复 `gateway_health` 写入；
- UI 接真实 p99/队列/磁盘；
- 增加 Prometheus/健康检查端点。

---

### ARCH-P1-05 数据模型缺少交易日/结算历史/审计保留

**证据**

- 订单/成交没有 `trading_day` 字段；
- `strategy_daily_state` 只有一行（`strategy_id` 主键），不能保留每日历史；
- 没有 today/yesterday 滚动任务；
- `audit_log` 47,684 条，其中 45,136 条是 `RUNTIME_HEARTBEAT`；
- `orders`/`trades`/`audit_log` 没有按时间分区/归档；
- `trades` 没有订单外键，存在孤儿风险；
- 关键表没有乐观锁/版本号。

**影响**

- 夜盘归属、当日/昨日仓、PnL 历史错误；
- 审计噪声淹没真正操作；
- 数据增长不可控；
- 并发更新可能丢失。

**建议**

- 引入 `trading_day`、结算快照、`position_lots`；
- 心跳不入审计，改遥测；
- 按日/月分区、归档、保留策略；
- 订单/成交/持仓增加版本号或幂等键；
- 审计只读、可导出。

---

### ARCH-P1-06 无 CI、无故障注入

**证据**

- `.github/workflows` 为空；
- 78 个测试以单元测试为主；
- 控制面缺少订单消费者/对账/风控的数据库集成测试；
- CTP Adapter 测试主要靠手工脚本；
- 没有控制面宕机、Adapter 重启、双 Runner、Aeron backpressure 的自动化故障测试。

**影响**

- P0 约束无法持续验证；
- 回归依赖人工；
- 关键路径变更风险高。

**建议**

- CI 跑单元/集成/契约/回放测试；
- Java/C++ SBE 互操作测试；
- 故障注入套件；
- 覆盖率/SLO 门禁；
- 每次发布保留可复现证据。

---

### ARCH-P1-07 单机单库，无 HA/DR

**证据**

- 4 vCPU 单机；
- 单 PostgreSQL；
- 单 Control Plane；
- 没有备份任务；
- 没有多机 Aeron；
- 没有 PITR/主备。

**影响**

- 主机/DB 故障不可恢复；
- 容量和延迟受单机限制；
- 无法满足金融系统 RTO/RPO。

**建议**

- PG 备份 + PITR；
- Control Plane/DB 主备；
- 明确 RTO/RPO；
- 多机 Aeron/Archive；
- 容量与 GC/CPU 隔离测试。

---

### ARCH-P1-08 交易日历/期权到期/换月未闭环

**证据**

- `TradingCalendarService` 只在 `PairDailyStateService` 中使用；
- Runner 的 `sessionOpen` 只按时间判断；
- 手工单没有交易日历检查；
- 两条腿交易时段没有取交集；
- 没有期权到期/行权/指派处理；
- 没有合约换月/主力切换规则。

**影响**

- 节假日仍可能下单；
- 单腿开市、另一腿休市时无法对冲；
- 期权到期实值自动行权会造成裸露期货头寸；
- 换月跳空/流动性风险。

**建议**

- 所有下单入口统一交易日历；
- 两腿时段取交集；
- 到期日只减仓；
- 行权/指派处理；
- 主力换月规则与提醒。

---

### ARCH-P1-09 SimLocal ORS 生命周期不归 Agent 管

**证据**

- SimLocal 网关是独立 `quantlink-fin-sim-exchange.service`；
- `runtime-agent.properties` 的 `ors.id` 为空；
- `ors_instances.last_heartbeat` 仍为旧时间；
- `RuntimeController.markStaleInstances` 只处理 Agent 离线，不检查 SimLocal 网关健康。

**影响**

- 页面可能显示 ORS RUNNING，实际网关已死；
- stop-all 无法控制 SimLocal 网关；
- 与“ORS 生命周期由 Agent 所有”的架构目标不一致。

**建议**

- SimLocal 也纳入 Agent 监督，或增加独立健康检查；
- 心跳/健康状态持续更新；
- stale 即降级并告警。

---

### ARCH-P1-10 合规/变更管理不足

**证据**

- 实盘部署没有双人复核；
- 没有配置 diff/审批流；
- Electron 更新包签名未完成；
- 没有监管报表/导出；
- 没有用户操作双人确认。

**影响**

- 误部署/供应链风险；
- 无法满足机构合规要求。

**建议**

- 四眼原则；
- 部署审批与回滚记录；
- 更新包签名；
- 监管报表/审计导出；
- 关键操作二次确认。

---

## 6. P2 / 当前阻塞项

以下事项不改变“当前不能实盘”的结论，但会影响规模化：

| 事项 | 状态 | 说明 |
|---|---|---|
| 多机 Aeron | 阻塞 | 无第二台 Linux 主机/媒体驱动 |
| Windows Electron 安装包验收 | 阻塞 | 无 Windows 测试机 |
| CTP 交易日联调 | 阻塞 | 非交易日，无法登录/下单/查询 |
| 5 个交易日长稳 | 阻塞 | 需要连续交易日 |
| 场所级 CTP 对账 | 阻塞 | 需要 CTP 交易数据 |
| 性能调优 | 进行中 | 4 vCPU 下 p99 仍有 6.29ms 波动 |
| 模拟交易所真实性 | 进行中 | 价格-时间优先、EOD 撤单、自成交防护仍需补 |
| 文档漂移 | 存在 | `docs/STATUS.md` 日期/状态与当前代码不完全一致 |

---

## 7. 目标架构

保留现有骨架，补五层能力：

```text
Strategy Runner
  │
  ├─ Local Risk / Position Cache   ← 账户/策略/合约限额、交易日历、行情龄
  │
  ├─ Aeron / Archive               ← 订单、成交、回报持久化 + 可重放
  │
  ▼
Execution Adapter (CTP / Sim)
  │
  ▼
Venue

            异步
Control Plane ──────▶ Ledger / OMS / Audit
  │                      │
  │                      ├─ PostgreSQL：当前状态
  │                      ├─ ClickHouse：指标/时序
  │                      └─ WORM/Archive：审计与回放
  │
  └─ Config / Deployment / UI（不进入 tick/order 热路径）
```

核心原则：

```text
1. 一个账户一个执行 owner，所有订单走同一条 OrderRouter
2. 所有执行事件有唯一 ID + 单调 sequence + requestId
3. 账本从事件重建，DB 只是物化视图
4. 本地风控使用权威持仓/资金/日历，不依赖控制面实时可用
5. 对账必须到场所级，差异阻断 OPEN
6. 应急开关必须在本地生效，不依赖控制面
```

---

## 8. 建议路线图

### 阶段 0：立即（1–3 天）

- 冻结实盘/小资金试点，只保留 SimLocal 研究；
- 把当前 `reconciliationPass` 标记为“本地一致性”，不能作为场所对账；
- 修复 stop-all 与 flatten 的逻辑；
- 修正 SimLocal `tradeId / filledQty / cancel` 语义；
- 关闭生产环境的 mock/自动模拟覆盖。

### 阶段 1：P0 清零（2–4 周）

- 持久化执行事件 + 审计；
- 账户账本、手续费、保证金、结算；
- 本地风控权威化：账户级限额、交易日历、行情龄、价格笼子、平仓校验；
- 场所级对账 gate；
- 本地 kill switch / cancel-on-disconnect / drain；
- SimLocal 重启恢复完整账本。

### 阶段 2：影子/小资金（2–4 周）

- 配置 hash/generation、部署 ACK、自动回滚；
- 统一订单路径，移除静默 HTTP fallback；
- CI + 故障注入 + 5 日稳定；
- 安全加固：WS 鉴权、mTLS、限流、审计不可篡改；
- 告警闭环和 SLO 看板。

### 阶段 3：实盘准备

- CTP 场所级对账；
- 多机/HA/备份/PITR；
- 双人复核、变更审批、监管报表；
- 5 个交易日以上影子 + 小资金试点。

---

## 9. 验收门槛

以下条件全部满足前，不建议进入实盘：

```text
[ ] 控制面宕机 10 分钟，Runner 仍能收行情、撤单、平仓
[ ] 控制面恢复后，订单/成交/持仓/审计可完整重放
[ ] 场所 vs 本地 orders/trades/positions/accounts 差异 = 0
[ ] 部分成交后撤单，filled_qty 不丢失
[ ] 多档扫单，每笔成交有唯一 tradeId
[ ] stop-all 在 5 秒内停止新单、撤单、平仓
[ ] Adapter 重启后，旧订单 requestId/strategyKey 仍可归属
[ ] 节假日、行情中断、tick 过期时禁止 OPEN
[ ] 账户可用资金/保证金/手续费与 CTP 对账一致
[ ] 告警能自动触发，不依赖人工 POST
[ ] UI 在 API/WS 断开时 fail-closed，不显示 mock 作为实时数据
[ ] CI 全绿，包含控制面宕机/Adapter 重启/双 Runner 故障注入
```

---

## 10. 结论

```text
架构骨架：正确
工程实现：有亮点
金融级正确性：不足
实盘 readiness：不通过
```

当前最应该做的不是继续加页面，而是按顺序补：

```text
1. 执行事件持久化 + 账本
2. 本地风控权威化 + 交易日历/行情龄
3. 场所级对账 + 应急开关
4. 配置版本/回滚 + 安全 + CI
```

在 P0 清零前，建议系统只用于：

```text
SimLocal 研究
策略逻辑验证
UI / 运维流程演练
非交易时段故障注入
```

---

## 附录 A：关键代码位置

| 主题 | 文件 |
|---|---|
| 架构硬约束 | `docs/architecture/01-架构硬约束.md` |
| Runtime 控制设计 | `docs/architecture/10-Runtime控制设计.md` |
| 执行指令规则 | `docs/architecture/13-执行指令与交易所规则.md` |
| 多 Agent/ORS 绑定 | `docs/architecture/14-多Runtime-Agent与柜台账号绑定.md` |
| 本地订单网关 | `backend/runtime-runner/src/main/java/com/quantlink/fin/runner/AeronOrderGateway.java` |
| Pair Runner | `backend/runtime-runner/src/main/java/com/quantlink/fin/runner/PairSpreadRunner.java` |
| 控制面订单消费 | `backend/control-plane/src/main/java/com/quantlink/fin/control/aeron/AeronOrderUpdateConsumer.java` |
| 本地风险快照 | `backend/control-plane/src/main/java/com/quantlink/fin/control/api/StrategyRuntimeController.java` |
| 应急控制 | `backend/control-plane/src/main/java/com/quantlink/fin/control/api/EmergencyController.java` |
| 对账 | `backend/control-plane/src/main/java/com/quantlink/fin/control/api/ReconciliationController.java` |
| SimLocal 网关 | `backend/sim-exchange/src/main/java/com/quantlink/fin/sim/SimExchangeAeronGateway.java` |
| SimLocal 撮合 | `backend/sim-exchange/src/main/java/com/quantlink/fin/sim/SimExchange.java` |
| SimLocal 编解码 | `backend/sim-exchange/src/main/java/com/quantlink/fin/sim/SimOrderCodec.java` |
| CTP 桥 | `ctp-adapter/src/ctp_aeron_bridge.h` |
| CTP 会话 | `ctp-adapter/src/ctp_trader_session.h` |
| 遥测配置 | `backend/control-plane/src/main/java/com/quantlink/fin/control/telemetry/TelemetryConfig.java` |
| 遥测服务 | `backend/control-plane/src/main/java/com/quantlink/fin/control/telemetry/TelemetryService.java` |
| 告警 | `backend/control-plane/src/main/java/com/quantlink/fin/control/telemetry/AlertService.java` |
| ClickHouse schema | `tools/db/clickhouse-init.sql` |
| 影子库 schema | `tools/db/schema-shadow.sql` |
| 前端驾驶舱 | `web/src/pages/Dashboard.tsx` |
| 前端监控 | `web/src/pages/Monitoring.tsx` |

---

## 附录 B：复审建议

建议在本文件基础上维护一个“P0 清零看板”，每项至少包含：

```text
ID
负责人
目标完成日期
代码提交
测试证据
线上验证记录
回滚方案
```

下一次复审建议放在：

```text
P0-01 ~ P0-08 全部关闭后
或 CTP 交易日联调完成后
```

复审时必须重新采集：

```text
控制面宕机 10 分钟
Adapter 重启
双 Runner
Aeron backpressure
场所 vs 本地全量对账
stop-all / flatten 实测
```

---

## 附录 C：Aeron Archive 是什么，是否必须

### C.1 一句话

**Aeron Archive 不是“审美”或日志装饰，它是 Aeron 的持久化录制与回放服务：把 Aeron stream 上的消息按顺序写到磁盘，并支持按位置回放、按 recording 重放，以及 PersistentSubscription 的“断线后从上次位置继续消费”。**

可以把它理解成：

```text
Aeron 的 Kafka-like durable log
```

但它不是数据库，也不是业务账本。

### C.2 它解决什么问题

```text
1. Control Plane 重启/宕机后，能重放错过的 OrderUpdate / Trade
2. Adapter 重启后，能回放未处理完的执行事件
3. 审计/复盘：按 recording + position 精确重放某一段时间
4. 新消费者 late join：从 recording 起点补齐历史，再切到 live
5. 消费者断开恢复：PersistentSubscription 自动从上次 position 继续
```

典型 API 概念：

```text
startRecording(channel, streamId, SourceLocation.LOCAL)
listRecordings(...)
replay(recordingId, replayChannel, replayStreamId, ...)
PersistentSubscription.create(...)
```

### C.3 它不解决什么问题

```text
1. 不保证业务 exactly-once
   → 消费端仍必须用 eventId / sequence / requestId 做幂等
2. 不替代订单/持仓/资金账本
   → 账本仍要从事件重建，或由 ledger service 维护
3. 不保证 publisher 没发出去的消息存在
   → Adapter 必须在 publish 前/后保证事件已进入可恢复路径
4. 不做业务查询/索引
   → 查询仍走 PostgreSQL / ClickHouse
5. 不自动管理无限保留
   → recording 需要容量规划、归档、删除策略
6. IPC 录制通常要求 Archive 与 publisher 在同一媒体驱动/主机
   → 多机需要 Archive 复制或网络化方案
```

### C.4 在 quantlink-fin 里的位置

当前问题是：

```text
Control Plane 异步消费 IPC
  → 没有持久化
  → Control Plane 宕机期间的消息丢失
  → 恢复后无法补审计/补持仓
```

Aeron Archive 可以补这一层：

```text
CTP Adapter / SimExchange
  → 发布 OrderUpdate / Trade 到 Aeron
  → Aeron Archive 录制这些 stream
  → Control Plane 用 PersistentSubscription 消费
  → 本地保存 last_position
  → 重启后从 last_position 继续
```

但还必须同时补：

```text
1. 事件唯一 ID / sequence
2. Control Plane 幂等消费
3. 账本重建
4. 场所级对账
5. Archive 容量/保留/监控
```

否则只是“有录像”，不是“有账本”。

### C.5 当前阶段是否必须

| 阶段 | 是否必须 | 建议 |
|---|---|---|
| SimLocal 研究 | 不必须 | 先用本地 WAL/JSONL/DB outbox 也能验证流程 |
| 影子/小资金 | **建议必须** | 至少要有等价的可重放事件日志 |
| 实盘 | **必须** | 审计、恢复、对账不能依赖 IPC 在线 |

如果当前只做 SimLocal 验证，引入 Archive 可能是**过度设计**；但一旦目标包含实盘/影子试点，**必须有等价能力**，Aeron Archive 是现成方案之一。

### C.6 替代方案

```text
A. Aeron Archive
   → 与现有 Aeron 架构最匹配；支持 recording/replay/persistent subscription

B. Adapter 本地 WAL / append-only journal
   → 实现简单；需要自己处理分段、校验、回放、保留

C. PostgreSQL outbox + 异步 relay
   → 业务系统常见；但热路径不能同步写库，需要本地 WAL/队列

D. Kafka / Pulsar / Chronicle Queue
   → 成熟；但增加一套基础设施和运维复杂度
```

对当前项目，推荐顺序：

```text
短期：Adapter 本地 WAL / 现有 PostgreSQL 事件表 + 幂等消费
中期：Aeron Archive（如果继续以 Aeron 为事件总线）
长期：Archive + 账本 + 场所对账 + HA
```

### C.7 实施要点

```text
1. Archive 独立进程/服务，独立磁盘，不与交易日志共用
2. 录制 OrderRequest / OrderUpdate / Trade / PositionSnapshot
3. Control Plane 用 PersistentSubscription，不直接 poll live subscription
4. 保存 last_position（按 account + stream + consumer）
5. 消费端幂等：event_id / request_id / trade_id 唯一
6. 监控 recording lag、archive disk、replay 延迟
7. 保留策略：按交易日/大小/合规要求
8. Archive 控制接口只对本机/内网开放
9. 不要用 Archive 替代账本和对账
```

### C.8 结论

```text
Aeron Archive = 持久化事件日志/回放基础设施
不是审美，也不是业务账本
SimLocal 阶段可以暂缓
影子/实盘阶段必须有等价能力
```

*本文档为架构评审记录，不替代交易、风控、合规的正式审批。*

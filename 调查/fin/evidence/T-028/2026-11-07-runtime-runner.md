# T-028 RuntimeAgent 托管 ORS + 可执行策略 Runner

- 日期：2026-11-07
- 提交：`6f4bc59`
- 环境：190 / `quantlink_fin_shadow`

## 1. 账户 = Agent = ORS

```text
SIMLOCAL-001  → agent-control-local  → ors-simlocal-001        ACTIVE
TEST-001      → agent-simnow-01      → ors-simnow-test-001     RELEASED
TEST-SHENGLI  → agent-shengli-01     → ors-shengli-test-shengli PENDING
```

三个 RuntimeAgent 均在线：

```text
agent-control-local  ONLINE
agent-simnow-01      ONLINE
agent-shengli-01     ONLINE
```

## 2. 策略 Runner

新增 `backend:runtime-runner`，由 RuntimeAgent 启动：

```text
sim-local-opt    TEST-STRAT-OPT-01    UP
sim-local-hedge  TEST-STRAT-HEDGE-01  UP
```

Runner 通过控制面接口运行，不直接写数据库：

```text
GET  /api/v1/market/ticks
GET  /api/v1/positions
POST /api/v1/strategy/orders
```

策略单样例：

```text
900000176  SIMLOCAL-001  au2612C920  B  OPEN  1.98  1  OPEN    strategy
900000177  SIMLOCAL-001  au2612      S  OPEN  875.88 1  FILLED  strategy
```

## 3. 手动激活 ORS 自动启动进程

使用 `sleep 120` 代替真实 CTP 进程做无登录验证（避免非交易时段重复登录）：

```text
POST /api/v1/execution/ors/ors-simnow-test-001/activate
→ {"status":"ACTIVE","fencingToken":1000}

Agent /ors/status
→ {"orsId":"ors-simnow-test-001","status":"UP","pid":182588}

POST /api/v1/execution/ors/ors-simnow-test-001/release
→ {"status":"RELEASED"}

Agent /ors/status
→ {"orsId":"ors-simnow-test-001","status":"STOPPED","pid":0}
```

验证点：

- 手动激活是唯一入口
- Agent 心跳收到 `START_ORS` 后直接启动二进制，不调用 systemd
- 释放后进程停止
- fencing token 从 1000 开始

## 4. 部署 ack

```text
POST /api/v1/strategy-deployments
→ deployment_id=4, generation=1, status=PENDING

Agent 心跳后
→ actual_state=RUNNING, status=ACTIVE, error=''
```

Runner 进程未运行时 ack 为 `FAILED`。

## 5. 测试

```text
./gradlew test
BUILD SUCCESSFUL
```

新增测试：

- `OrsProcessManagerTest`
- `RunnerConfigTest`
- `RuntimeAgentTest` ORS 配置解析

## 6. 未完成 / 等待真实数据

- SimNow 真实 CTP 登录：非交易时段，未启动
- SimShengli：国盛期货仿真评测参数已配置（BrokerID 88888，InvestorID 99000943），等待日盘前置开放
- 真实期权 tick / IV / 持仓对账
- 策略进程滚动升级与版本哈希校验

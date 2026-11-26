# 实时推送与 Agent 计算边界

- 日期：2026-11-09
- 状态：设计修订中
- 关联：T-030、T-018、P0-01/P0-02/P0-04/P0-08/P0-09

> 指标章节已被 `docs/architecture/27-指标目录与Agent内存热加载.md` 取代。  
> V1 不存在“控制面全局指标”；控制面不再计算指标，所有指标按 counterparty 由 IndicatorEngine 计算。  
> 本文后续提到“控制面（全局指标）”的段落仅保留为历史背景。

## 1. 结论

实时数据不再由控制面查库重算，也不再由浏览器轮询。

```text
Agent / ORS 能算的 → Agent 计算 → SBE/Aeron → 控制面消费 → WebSocket
柜台能提供的     → Adapter 查询 → SBE/Aeron → 控制面消费 → WebSocket
控制面只负责     → 归属、聚合、对账、历史、权限、WS 分发
浏览器只负责     → 首屏 HTTP 快照 + 后续 WS 增量
```

禁止：

- 浏览器周期轮询策略 PnL、策略持仓、组合权益、指标。
- 控制面在请求线程里从 trades/positions 现算策略 PnL。
- 用全局行情 fallback 计算策略/账户 PnL。
- 用公式 fallback 生成 IV/IV Rank/25Δ RR。

## 1.1 管理与运行是硬边界

管理面和运行面不是同一个东西：

```text
运行系统（Runtime / Agent / ORS / Adapter）
  产生：
    订单、成交、持仓、策略 PnL、风险、Greeks、账户快照、账户持仓、健康
  传输：
    SBE / Aeron / 数据库事件

定时数据任务（Scheduler / Data Job）
  产生：
    指标值、PnL 快照、对账结果、日终结算、费率/保证金、告警评估
  写入：
    只写数据表 / 事件流，不提供管理 API

管理面（Control Plane / Web）
  只做：
    配置、权限、审批、部署指令、读取已生成的数据、WS 转发、历史查询
  禁止：
    计算策略 PnL
    计算指标
    计算账户权益/PnL
    计算组合 Greeks
    请求时聚合派生数据
```

判定规则：

> 如果一个值需要“根据行情/成交/持仓/账户算出来”，它就不属于管理面。
> 管理面只能读取运行系统或定时任务已经算好并写入的数据。

当前越界代码（必须移出管理面）：

| 当前代码 | 越界内容 | 归属 |
|---|---|---|
| `StrategyPnlService` | 请求时从 trades/positions 算 PnL | Runtime Agent |
| `StrategyPnlSnapshotService` | 控制面每秒重算 PnL | 运行数据任务，且生产者为 Agent |
| `IndicatorEngine` | 历史代码：控制面从行情算指标 | V1 删除；改由按 counterparty 的独立 IndicatorEngine 计算 |
| `PortfolioController` | 控制面把账户余额和持仓 PnL 相加 | 运行数据任务，管理面只读 |
| `AccountSnapshotService` | 控制面计算 realized/unrealized | 账户数据任务/Adapter |
| `ScopedReconciliationService` | 控制面请求时算对账 | 定时对账任务 |
| `StrategyCenterController.pnlView` | 请求时现算 | 管理面只读 |
| `Dashboard` 2 秒轮询 | 管理面触发计算 | 删除，改 WS |

## 2. 数据所有权

| 数据 | 权威计算方 | 传输 | 频率 | 持久化 |
|---|---|---|---|---|
| 行情 tick | 交易所/Adapter | Aeron → WS | 实时 | 可选 ticks |
| 指标值 | IndicatorEngine（按 counterparty，见 doc 27） | WS | tick 驱动/1s | indicator_latest / indicator_value_history |
| 策略持仓 | Runtime Agent | SBE → Aeron → WS | 成交/定时 | strategy_positions |
| 策略 PnL | Runtime Agent（FIFO） | SBE → Aeron → WS | 成交 + 1s mark | strategy_pnl_snapshot |
| 策略订单/成交 | Runtime Agent / Venue | SBE → Aeron → WS | 事件 | orders/trades |
| 策略风险/限额/Greeks | Runtime Agent | WS | 1s/事件 | 可选快照 |
| 账户权益/可用/保证金 | CTP Adapter（查询） | SBE → Aeron → WS | 30s | account_pnl_snapshot |
| 账户持仓 | CTP Adapter（查询） | SBE → Aeron → WS | 30s | positions |
| 组合权益/组合 Greeks | 控制面聚合（来自账户/Agent） | WS | 1s/事件 | 可选快照 |
| 对账状态 | 控制面 | WS | 5s/事件 | reconciliation_status |
| 柜台/ORS/Agent 健康 | 控制面 + Agent 心跳 | WS | 2s | 状态表 |
| 费率/保证金率 | CTP 定时查询 | 非实时 HTTP/DB | 每日 | instrument_fees/margins |
| 合约/策略/权限 | 控制面 | HTTP | 变更时 | DB |

## 3. 事件信封

所有 WS 消息统一信封：

```json
{
  "type": "strategy_pnl",
  "schemaVersion": 2,
  "eventId": "uuid",
  "source": "agent-simnow-01",
  "asOf": "2026-11-09T22:50:00.123+08:00",
  "sequence": 12345,
  "stale": false,
  "dataAgeMs": 37,
  "payload": {}
}
```

事件类型：

```text
tick
indicator
strategy_pnl
strategy_position
strategy_order
strategy_trade
strategy_health
strategy_risk
account_snapshot
account_position
portfolio
reconciliation
alert
heartbeat
```

### 3.1 strategy_pnl

由 Agent 发布：

```json
{
  "strategyId": "PAIR-SIMVENUE-01",
  "cashFlow": -335.0,
  "realized": -335.0,
  "unrealized": 0.0,
  "fees": 0.0,
  "pnl": -335.0,
  "markSource": "SCopedTick|SETTLEMENT|NONE",
  "positions": [
    {"instrumentId":"ag2612","netQty":0,"avgPrice":0,"lastPrice":0,"multiplier":15}
  ],
  "positionEpoch": 0,
  "deploymentId": 24,
  "generation": 1,
  "stale": false,
  "asOf": "..."
}
```

### 3.2 account_snapshot

由 CTP Adapter / SimVenue / SimLocal 发布：

```json
{
  "accountId": "TEST-001",
  "equity": 22701449.04,
  "cash": 18986725.84,
  "available": 18986725.84,
  "margin": 3679323.2,
  "deposit": 0,
  "withdraw": 0,
  "preBalance": 22650000.0,
  "preCloseEquity": 22650000.0,
  "tradingDay": "2026-11-10",
  "source": "CTP",
  "stale": false,
  "asOf": "..."
}
```

### 3.3 account_position

```json
{
  "accountId": "TEST-001",
  "instrumentId": "ag2706",
  "exchange": "SHFE",
  "longQty": 0,
  "shortQty": 88,
  "avgPrice": 12712,
  "source": "CTP",
  "asOf": "..."
}
```

### 3.4 portfolio

控制面聚合，不重新计算账户权益：

```json
{
  "equity": 22701449.04,
  "available": 18986725.84,
  "margin": 3679323.2,
  "strategyPnl": -335.0,
  "accountsCovered": 1,
  "accountsTotal": 4,
  "source": "PARTIAL",
  "asOf": "..."
}
```

## 4. 订阅与首屏

```text
GET /api/v1/snapshot/strategy/{id}      首屏策略+持仓+PnL 快照
GET /api/v1/snapshot/portfolio          首屏组合快照
GET /api/v1/snapshot/account/{id}       首屏账户快照
WS  /ws/market                          后续增量
```

规则：

- 首屏允许 HTTP 快照，但快照必须带 `asOf/stale/source/sequence`。
- 首屏之后不再定时 GET 同类数据。
- WS 重连后先发 `resume`（last sequence），服务端补发或要求重新拉取快照。
- 页面隐藏时不建立重复订阅；全局只有一个 WS Provider。

## 5. Agent 计算边界

Agent 负责：

- 订单/成交事件处理。
- 策略持仓账本：`(strategy, account, counterparty, exchange, instrument, epoch)`。
- FIFO 已实现 PnL、手续费、今昨仓。
- 未实现 PnL：只用该策略绑定的 `(counterparty, exchange)` 行情；无行情发 `MARK_STALE`，不 fallback 全局价。
- 策略级 Greeks（期权）。
- 风险限额占用、订单/成交延迟、策略健康。
- 对账输入：账户快照 vs 策略+手工+未分配差额。

控制面负责：

- 校验事件来源/身份/fencing/generation/route。
- 归属 book/strategy/account/counterparty。
- 组合聚合（账户快照 + Agent PnL）。
- 对账与告警。
- 历史落库、查询、权限、WS 分发。

## 6. 不是实时的数据

以下数据允许 HTTP/定时：

- 合约、费率、保证金率、交易日历、权限配置。
- CTP 账户查询本身是 request/response，Adapter 可 30s 查询，但查询结果必须 WS 推送。
- 历史查询、导出、审计。

## 7. 热路径与背压

```text
Agent 行情线程：只更新内存账本，不写 DB
Agent 发布线程：有界队列，满则丢弃并计数
控制面消费线程：有界队列，批量写 DB
WS 广播：不阻塞行情线程
```

禁止在行情线程做 SQL、HTTP、portfolio 查询。

## 8. 失败语义

- 无 WS：页面显示 `DISCONNECTED`，保留最后一次快照并标 `STALE`，不自动轮询业务数据。
- 无行情：`MARK_STALE`，P&L/Greeks 显示 N/A，不 fallback。
- Agent 离线：策略 `AGENT_OFFLINE`，组合权益仍显示但标覆盖不足。
- 账户快照过期：`ACCOUNT_STALE`，禁止新开仓。
- 数据库写失败：不影响 WS 当前值，进入重试/DLQ。

## 9. 需要落地的改造

1. SBE：新增 `StrategyPnl`、`StrategyPosition`、`AccountSnapshot`（补 `preBalance/preCloseEquity/available`）、`PortfolioEvent` 消息。
2. Runtime Agent：账本、FIFO PnL、scoped 行情、发布器、背压计数。
3. CTP/SimVenue/SimLocal Adapter：账户/持仓定时查询后发布，不再只写 DB。
4. Control Plane：消费者、事件缓存、WS 分发、快照 API；删除请求时 PnL 现算和 portfolio 轮询路径。
5. Web：`useMarketData` 扩展事件类型；删除 `/portfolio/live` 轮询、指标/策略 PnL 轮询；首屏快照。
6. 指标：全部指标按 counterparty 由独立 IndicatorEngine 计算；V1 无全局指标，控制面不计算指标；期权必须按柜台订阅，无报价 N/A。详见 doc 27。
7. 测试：断 WS、断行情、Agent 离线、重复事件、乱序、重连、背压、快照一致性。

## 10. 验收标准

```text
[ ] 浏览器 Network 面板无 /portfolio/live、无策略 PnL、无指标周期 GET
[ ] WS 断线后数据变 DISCONNECTED/STALE，不自动 HTTP 轮询
[ ] 策略 PnL 来源 = Agent，控制面不查 trades/positions 现算
[ ] 账户权益来源 = 最新柜台快照，无快照 N/A/PARTIAL
[ ] 同一 indicator_id 在驾驶舱/期权链/策略详情一致
[ ] 所有实时事件带 asOf/source/sequence/stale
[ ] 行情线程无 SQL/HTTP
```

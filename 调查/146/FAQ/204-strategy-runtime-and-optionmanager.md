# 多策略运行时与 OptionManager

- 日期：2026-11-21
- 状态：DRAFT（设计文档，未写代码）
- 范围：一个 TradeBot 内多策略的共享/隔离边界、`StrategyRuntime`、`TradingChannel`、`OptionManager` 归属、策略生命周期和失败处理
- 关联：`201-tb-ipc-model.md`、`202-trading-channel-and-routing.md`、`203-configuration.md`、`206-contract-catalog.md`

---

## 1. 结论

```text
TradeBotRuntime
  ├─ StrategyRuntime[14526 / pair-01]
  │    ├─ IndicatorEngine
  │    ├─ Strategy
  │    ├─ ExecutionPlanner
  │    ├─ StrategyRisk
  │    └─ OptionManager（可选）
  │
  ├─ StrategyRuntime[14527 / mm-01]
  │    ├─ IndicatorEngine
  │    ├─ Strategy
  │    ├─ ExecutionPlanner
  │    ├─ StrategyRisk
  │    └─ OptionManager（可选）
  │
  ├─ TradingChannel[BSE]
  ├─ TradingChannel[NSE_FO]
  └─ AccountSnapshotService（独立读模型）
```

没有全局 mutable `OptionManager`，没有全局 `IndicatorEngine`，没有全局 mutable `ConfigParams`。

策略只按 `ContractKey -> TradingChannelKey` 路由，不按 ORS/InvestorID/账户路由。

---

## 2. 共享与隔离

共享：

```text
ContractCatalog（见 206）
OptionCatalog（只读定义，见 206）
MarketDataRouter
TradingChannel
TradeBotOrderGateway
ExecutionEventRouter
策略配置的只读模板
```

`ContractCatalog` / `OptionCatalog` 的字段和校验统一由 `206-contract-catalog.md` 定义；本节只描述共享关系。

隔离：

```text
IndicatorEngine
指标窗口/缓存
Strategy 实例
ExecutionPlanner
策略参数
策略级风险
StrategyPositionView
OptionManager
OptionPricingEngine
OptionPortfolio
OptionGreeks
OptionIndicators
OptionRisk
OptionExecutionPlanner
事件队列
```

每个 `StrategyRuntime` 单线程消费自己的事件；其他策略不能直接访问它的指标、仓位或期权组合。

---

## 3. `StrategyRuntime`

```text
StrategyRuntime
  ├─ StrategyLifecycle
  ├─ IndicatorEngine
  ├─ Strategy
  ├─ ExecutionPlanner
  ├─ StrategyRisk
  ├─ StrategyPositionView
  └─ OptionManager（可选）
```

职责：

```text
订阅行情
维护自己的指标
生成 StrategyDecision
生成 OrderIntent/CancelIntent
接收自己的 ExecutionEvent
维护策略仓位视图
做策略级风险检查
```

不负责：

```text
交易 IPC
订单权威
账户快照
账户净仓
clientOrderId
```

`OrderIntent` 只能进入 `TradeBotOrderGateway`；策略不能直接写 IPC。

---

## 4. 多策略订单

```text
StrategyRuntime A
  -> OrderIntent(BSE:..., strategyId=A)
    -> TradeBotOrderGateway
      -> TradingChannel[BSE]

StrategyRuntime B
  -> OrderIntent(NSE_FO:..., strategyId=B)
    -> TradeBotOrderGateway
      -> TradingChannel[NSE_FO]
```

一个策略可以跨多个通道：

```text
StrategyRuntime 14526 / pair-01
  LEG_A -> BSE contract   -> TradingChannel[BSE]
  LEG_B -> NSE contract   -> TradingChannel[NSE_FO]
```

两条腿的 `OrderIntent` 是独立的；策略负责 leg 语义，TB 只负责 `ContractKey -> TradingChannelKey` 路由。

---

## 5. OptionManager 归属

### 5.1 每个策略一个

```text
StrategyRuntime[14526 / pair-01]
  OptionManager
    OptionCatalog（只读引用，见 206）
    OptionPricingEngine
    OptionPortfolio
    OptionGreeks
    OptionIndicators
    OptionStrategy
    OptionRisk
    OptionExecutionPlanner
```

`OptionManager` 是策略运行时的一部分，不是 TB 全局单例。

如果策略不是期权策略，不创建 `OptionManager`。

### 5.2 共享只读

```text
OptionCatalog 可以共享（206 的 Option 投影）
ContractCatalog 可以共享（206 的唯一元数据来源）
行情可以共享
TradingChannel 可以共享
```

不可共享：

```text
OptionPortfolio
OptionGreeks
定价缓存
期权指标窗口
期权策略参数
期权执行计划
```

### 5.3 多策略共享同一组合

默认不允许两个 `StrategyRuntime` 同时修改同一个 `OptionPortfolio`。

如果业务上确实需要一个组合由多个子策略共同管理，模型应是：

```text
1 StrategyRuntime
  ├─ PortfolioOwner
  ├─ SubStrategy A
  ├─ SubStrategy B
  └─ 共享的 OptionPortfolio / OptionGreeks
```

把“共享组合”收进一个策略运行时，而不是让多个 StrategyRuntime 绕过边界共享可变对象。

---

## 6. 策略生命周期

```text
StrategyState =
    CREATED
  | STARTING
  | RUNNING
  | PAUSED
  | FAILED
  | STOPPED
```

启动：

```text
创建 StrategyRuntime
  -> 加载策略配置
  -> 构建 IndicatorEngine
  -> 构建 OptionManager（如果需要）
  -> 订阅行情
  -> 等待所有 leg channel READY / 指标 warmup
  -> RUNNING
```

暂停：

```text
任一必需 leg 的 TradingChannel 不 READY
行情 stale
指标 invalid
手动 pause
```

`PAUSED` 时：

```text
不产生新 OrderIntent
可以继续接收行情/回报
可以撤已有订单
```

失败：

```text
StrategyRuntime 捕获未处理异常
  -> FAILED
  -> 撤该策略 open orders
  -> 保留策略仓位
  -> 告警
  -> 其他策略继续
```

策略异常不能杀死 TB 进程，也不能让其他策略进入未知状态。

---

## 7. 策略级风险与账户视图

策略级：

```text
单 leg 最大数量
leg 失衡
策略最大敞口
策略价格/滑点限制
指标有效性
期权 Greeks 限额
```

账户视图：

```text
AccountSnapshotService
  <- STATE / VENUE_SESSION
  -> AccountSnapshotStore
```

边界：

```text
StrategyRisk 只看本策略
AccountSnapshotService 只生成账户读模型
```

策略默认不读账户快照，也不因为账户快照缺失而停止交易。

如果以后需要账户级预交易风控，应作为独立的 `AccountRiskView` 服务显式接入网关；不要把它塞回 `TradingChannel` 或 `StrategyRuntime`。

---

## 8. 配置

策略配置只描述策略：

```ini
STRATEGY_ID = 14526
STRATEGY_NAME = pair-01
TYPE = pairwise-arb
URGENCY = NORMAL
ACCOUNT = OWN

LEG_A = BSE:BANKNIFTY1088260200-10
LEG_B = NSE_FO:BANKNIFTY1088260200-10

MAX_LEG_IMBALANCE = 1
```

TB 配置只登记：

```ini
[STRATEGIES]
14526 = strategies/pair-01.cfg
14527 = strategies/mm-01.cfg
```

`STRATEGY_ID` 是 TB 内唯一的数字策略实例 ID；`STRATEGY_NAME` 只用于显示。`ACCOUNT` 是 146 的 `accountId`，不是路由键。

策略配置不写：

```text
ORS_ID
BROKER_ID
INVESTOR_ID
COMMAND_STREAM
AccessClient
OptionManager 全局路径
```

需要显式通道时：

```ini
LEG_A_CHANNEL = BSE
```

### 8.1 启动注册

TB 启动时：

```text
读取 [STRATEGIES] 列表
  -> 读取每个策略配置
  -> 校验 strategyId 唯一
  -> 创建 StrategyRuntime
  -> 写入 TB 本地 StrategyRegistry
```

```text
StrategyRegistry
  strategyId -> StrategyRuntime
```

不提供动态注册：

```text
没有策略注册 API
没有心跳注册
没有租约/发现
没有中央注册中心
```

GUI 的策略列表来自配置 + `StrategyStatusReadModel`，不是注册服务。重启后 `strategyId` 不变。

### 8.2 146 运行期文件边界

146 的 `strategyID` 会用于一些运行期文件；新系统不把这些文件当账户事实：

| 146 文件/通道 | 新系统定位 |
|---|---|
| PID 文件 | 进程级；一个 TB 一个，不按策略一个 |
| `begin_prices_calendar_<id>` | 可选策略种子；路径配置化，不作为账户状态 |
| `positions<id>` | 策略本地 checkpoint；不能替代账户持仓 |
| `final_positions_<date>_<id>` | 策略收盘记录；不是恢复权威 |
| 日志 | 保留；按 `tbId + strategyId` 组织 |
| tbadmin memlog | 仅 Plan A/兼容层；不是核心事实源 |

账户/持仓真相仍然来自 ORS 快照、成交和 reconciliation。

---

## 9. 与 146 的对照

| 146 | 新模型 |
|---|---|
| 全局 `OptionManager` | 每 `StrategyRuntime` 一个 OptionManager |
| 全局 `CommonClient` | 每 `TradingChannel` 自己的状态 |
| 全局 `ConfigParams` | 只读 TB 配置 + 独立策略配置 |
| `--controlList` 共享全局对象 | 多 StrategyRuntime，各自状态隔离 |
| `--strategyID` 进程运行号 | 新系统 `strategyId`，TB 内唯一；旧运行号只做映射 |
| `ControlConfig.m_id` | control 文件字段，不直接当注册 ID |
| 一个 TB 进程通常一个 control | 一个 TB 进程登记多个策略 |
| 策略直接依赖全局对象 | 策略只依赖自己的运行时和 TradeBotOrderGateway |
| `AccountID` / InvestorID | 只用于账户快照/持仓/PnL 读模型，不进入交易路由 |

146 的多策略能力受全局单例限制；新模型把“多策略”作为一等模型。

---

## 10. 不变量

```text
一个 strategyId 只有一个 StrategyRuntime
一个 StrategyRuntime 只有一个 IndicatorEngine
一个 StrategyRuntime 只有一个 OptionManager（如果需要）
策略之间不共享可变指标/组合/仓位对象
策略不能直接写 IPC
策略订单必须经过 TradeBotOrderGateway
策略失败不影响其他策略
共享对象只读或线程安全
账户快照不参与策略交易门禁
```

---

## 11. 未决问题

1. 多策略共享同一期权组合时，是否允许 `PortfolioOwner + SubStrategy`。
2. 策略级风控和账户视图如何协同；默认不把账户视图放进交易路径。
3. 策略配置是否允许 include 共享参数。
4. 策略级 journal 是否与 channel journal 分开。
5. 策略重启时，策略仓位视图如何从执行事件/journal 恢复。
6. 期权 `OptionCatalog` 的刷新周期和版本管理。

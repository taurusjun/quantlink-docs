# 指标-策略体系设计

- 日期：2026-11-20
- 状态：DRAFT（设计文档，未写代码）
- 范围：新 FastTrade 的指标计算、策略订阅、PairwiseArbStrategy 驱动方式，以及与 146 的对照

---

## 1. 结论摘要

新系统采用：

```text
指标目录全局定义
指标引擎按策略实例化
指标快照按策略裁剪
策略只消费自己的指标
```

核心边界：

```text
Indicator 只算数值
Strategy 只生成 StrategyDecision
ExecutionPlanner 只生成 OrderIntent
AccountHost 只做订单/账户
```

统一模型：

```text
StrategyDecision.targetPositions
  -> ExecutionPlanner
  -> OrderIntent
  -> AccountHost
```

`TargetPricePolicy / PnLAtLevelCalculator` 只属于单标的策略；
PairwiseArb 使用 `PairExecutionPolicy`。

不使用：

```text
PairSignal 这种“指标 + 策略”混合对象
全局 IndicatorEngine 算全部指标再广播
每个指标单独触发一次策略
```

---

## 2. 设计目标

1. 指标计算与交易决策分离。
2. 一个策略只计算自己需要的指标。
3. 指标状态按 StrategyProcess 隔离。
4. 策略收到一致、不可变的指标快照。
5. PairwiseArbStrategy 作为主力策略可独立演进。
6. 回测和实盘复用同一套指标实现。
7. AccountHost 不感知 Pair 的腿语义。
8. 决策统一到 `StrategyDecision.targetPositions`，执行按策略族拆分。

---

## 3. 分层

```text
MarketData
  -> IndicatorEngine（每个 StrategyProcess 一个）
       -> IndicatorSnapshot（只含该策略订阅的指标）
  -> Strategy
       -> StrategyDecision
  -> ExecutionPlanner
       -> OrderIntent
  -> AccountHost
       -> AccessClient
       -> ORS
```

| 层 | 职责 | 不负责 |
|---|---|---|
| MarketData | 行情标准化、时间戳、有效性 | 指标、下单 |
| IndicatorEngine | 计算指标、维护窗口状态、生成快照 | 买卖决策 |
| Strategy | 基于指标/仓位/状态/风控生成 `StrategyDecision` | 滚动统计、直接发单 |
| ExecutionPlanner | 把 `StrategyDecision` 转成 `OrderIntent` | 策略信号、账户状态 |
| AccountHost | clientOrderId、订单路由、账户对账 | Pair 腿语义、策略决策 |
| AccessClient/ORS | 传输、CTP | 指标/策略 |

---

## 4. 指标目录、指标引擎、指标快照

### 4.1 IndicatorCatalog

全局只放定义和工厂：

```text
IndicatorCatalog
  ├─ pair_spread
  ├─ pair_zscore
  ├─ pair_beta
  ├─ pair_half_life
  ├─ pair_volatility
  ├─ pair_correlation
  └─ ...
```

Catalog 不保存运行状态。

### 4.2 IndicatorEngine

每个 `StrategyProcess` 一个，只实例化当前策略需要的指标及其依赖。

例如：

```text
Strategy A 需要 3 个：
  pair_spread_ab
  pair_zscore_ab
  pair_beta_ab

Strategy B 需要 5 个：
  pair_spread_cd
  pair_zscore_cd
  pair_half_life_cd
  pair_volatility_cd
  pair_correlation_cd
```

```text
Process A
  IndicatorEngine A
    -> 只构建 A 的 3 个 + 依赖

Process B
  IndicatorEngine B
    -> 只构建 B 的 5 个 + 依赖
```

不会出现：

```text
全局算 10 个 -> A/B 各自过滤
```

### 4.3 订阅配置

```yaml
indicators:
  pair_spread_ab:
    type: pair_spread
    legA: rb2601
    legB: i2601

  pair_beta_ab:
    type: rolling_ols
    legA: rb2601
    legB: i2601
    lookback: 240

  pair_zscore_ab:
    type: zscore
    input: pair_spread_ab
    lookback: 120

strategies:
  pair_ab:
    type: pairwise-arb
    indicators:
      - pair_spread_ab
      - pair_zscore_ab
      - pair_beta_ab
```

策略只声明需要的指标；引擎自动补齐依赖。

### 4.4 IndicatorSnapshot

快照只包含当前策略的指标：

```json
{
  "timestamp": 123456789,
  "ready": true,
  "valid": true,
  "values": {
    "pair_spread_ab": 12.5,
    "pair_zscore_ab": 2.1,
    "pair_beta_ab": 0.82
  }
}
```

策略 A 不会收到 B 的字段。

---

## 5. Indicator 契约

```java
interface Indicator {
    void onMarketData(MarketEvent event);
    IndicatorValue value();
    boolean ready();
    boolean valid();
    void reset();
}
```

规则：

- 指标只输出数值、状态、有效性；
- 指标不生成 `BUY/SELL/ENTER/EXIT`；
- 指标不调用 Strategy；
- 指标不持有 AccountHost/AccessClient；
- 指标状态只属于当前 StrategyProcess；
- 指标必须支持 `reset()`，用于新交易日/重启。

---

## 6. 更新与触发

错误方式：

```text
indicator1.done -> strategy.onUpdate()
indicator2.done -> strategy.onUpdate()
indicator3.done -> strategy.onUpdate()
```

问题：

- 一次行情多次触发；
- 策略可能看到半新半旧的指标；
- 可能重复下单；
- 回测/实盘事件顺序不一致。

正确方式：

```text
MarketEvent
  -> 标记 dirty indicators
  -> 按依赖图计算
  -> 所有订阅指标完成
  -> 生成 immutable Snapshot
  -> Strategy.decide() 只调用一次
  -> StrategyDecision
  -> ExecutionPlanner
  -> OrderIntent
  -> AccountHost
```

如果 A 和 B 在不同进程：

```text
A 的 Engine 只更新 A 的指标
B 的 Engine 只更新 B 的指标
```

---

## 7. Strategy 契约与 StrategyDecision

### 7.1 Strategy

```java
interface Strategy {
    void onStart(StrategyContext ctx);
    StrategyDecision decide(IndicatorSnapshot snapshot, MarketView market);
    void onOrderUpdate(OrderUpdate update);
    void onFill(FillEvent fill);
    void onTimer(TimerEvent timer);
    void onStop();
}
```

`StrategyContext` 提供：

```text
position(instrument)
openOrders()
clock()
config()
health()
orderGateway()
```

规则：

- `decide()` 只生成决策，不直接调用 AccountHost；
- `onOrderUpdate`/`onFill` 只更新策略本地状态；
- 策略不直接持有 `AccessClient`、`AccountHost OrderRegistry`、CTP 字段；
- 策略不读全局 `m_simConfig`。

### 7.2 StrategyDecision

`StrategyDecision` 是**运行时对象**，不是配置加载的。

配置加载的是：

```text
策略类型
指标列表/参数
entry/exit/stop 阈值
目标仓位上限
默认 urgency
```

运行时 `decide()` 生成：

```text
StrategyDecision
  decisionId
  strategyKey
  snapshotTimestamp
  targetPositions
  quoteHints（可选）
  urgency
  reason
```

#### targetPositions

绝对目标仓位，不是本次增量：

```text
legKey -> targetQty
正数 = 目标多头
负数 = 目标空头
```

单标的策略可以把 `legKey` 直接设为 `instrumentId`；Pair、期权等多腿策略必须为每条腿分配独立的 `legKey`。

例如 Pair：

```text
legA（ag2612） -> +10
legB（ag2706） -> -8
```

例如单标的：

```text
ag2612 -> +10
```

`ExecutionPlanner` 负责把 `legKey` 映射回 `instrumentId`，再生成 `OrderIntent`。`legKey` 不进入 AccountHost。

ExecutionPlanner 计算：

```text
delta = target - currentPosition - pendingOrders
```

目标没变，`delta = 0`，不重复下单。

#### quoteHints

单标的报价提示，可选：

```text
instrumentId -> targetPrice
```

Pair 通常不需要。

#### urgency

见 7.3。

#### decisionId / snapshotTimestamp / reason

用于：

- 幂等；
- 审计；
- 回放；
- 日志关联。

#### 决策输入

```text
StrategyDecision =
  IndicatorSnapshot
  + 当前仓位
  + 在途订单
  + 策略内部状态
  + 配置阈值
  + 策略级风控
  + 时钟/交易时段
```

同样的 `zscore`，在不同状态下决策不同：

```text
FLAT    -> 可能开仓
HOLDING -> 可能继续持有
EXITING -> 不应反向开仓
PAUSED  -> 不交易
```

### 7.3 urgency

`urgency` 是策略给 ExecutionPlanner 的执行紧迫度提示，不是 CTP 字段。

```text
PASSIVE
NORMAL
AGGRESSIVE
UNWIND
```

| urgency | 含义 | 执行层典型行为 |
|---|---|---|
| `PASSIVE` | 尽量被动 | 限价挂单，GFD，不主动跨价 |
| `NORMAL` | 默认 | 限价，可适度改价/撤单 |
| `AGGRESSIVE` | 优先成交 | 跨价，IOC/FAK，短 timeout |
| `UNWIND` | 强制退出/平腿 | 对手价，最大滑点限制 |

`urgency` 不是 `LIMIT/MARKET/FAK/FOK`。  
具体订单类型由 ExecutionPlanner 根据 urgency + 交易所规则决定。

例如：

```text
AGGRESSIVE
  -> 跨价 + IOC/FAK

但 SHFE 不支持市价
  -> ExecutionPlanner 降级为限价 + 撤单
```

### 7.4 ExecutionPlanner

```java
interface ExecutionPlanner {
    List<OrderIntent> plan(
        StrategyDecision decision,
        MarketView market,
        OrderView orders,
        StrategyContext ctx
    );
}
```

`StrategyProcess` 内部流程：

```text
snapshot = indicatorEngine.snapshot()
decision = strategy.decide(snapshot, market)
intents = executionPlanner.plan(decision, market, orders, ctx)
for (intent : intents) ctx.orderGateway().submit(intent)
```

单标的和 Pair 用不同决策/执行组件：

| 策略族 | 决策组件 | 执行组件 |
|---|---|---|
| 单标的报价 | `Strategy` + `TargetPricePolicy` | `SingleInstrumentExecutionPlanner` + `PnLAtLevelCalculator` |
| Pair | `PairwiseArbStrategy` | `PairExecutionPlanner` + `PairExecutionPolicy` |

统一的是：

```text
StrategyDecision
ExecutionPlanner
OrderIntent
AccountHost
```

不强行统一的是：

```text
TargetPricePolicy -> 单标的策略决策
PnLAtLevelCalculator -> 单标的执行
PairExecutionPolicy -> Pair 执行
```

这就是 013 的统一模型：  
**决策统一到目标仓位，执行按策略族拆分。**


---

## 8. PairwiseArbStrategy 的指标设计

PairwiseArbStrategy 是主力策略：

```text
StrategyFactory 默认类型: pairwise-arb
PairwiseArbStrategy 按标准 Strategy / PairExecutionPlanner 接入
```

它不是特殊执行引擎，而是标准 `Strategy` 实现：

```text
PairwiseArbStrategy
  ├─ PairLegSpec A/B
  ├─ PairLegState A/B
  ├─ PairStateMachine
  ├─ PairPosition
  └─ PairRisk
```

`IndicatorEngine` 和 `PairExecutionPlanner` 属于 `StrategyProcess`，由 `StrategyProcess` 注入/调用，不是 PairwiseArb 对象自己的状态。

PairwiseArb 的决策输出：

```text
StrategyDecision:
  targetPositions:
    legA: +10
    legB: -8
  urgency: NORMAL
  reason: zscore entry
```

`legA` / `legB` 由 `PairLegSpec.legKey` 定义；`PairExecutionPlanner` 再映射到 `ag2612` / `ag2706`。

`PairExecutionPlanner` 再把它转成两条腿的 `OrderIntent`，并处理：

```text
leg timeout
legging risk
max leg imbalance
unwind
```

PairwiseArb 是主力策略，但它的指标仍然是纯指标：

```text
PairSpread
PairZScore
PairBeta
PairHalfLife
```

策略自己负责：

```text
entryZ
exitZ
stopZ
targetUnits
leg risk
state machine
```

配置示例：

```yaml
strategy:
  key: pair_ag2612_ag2706
  type: pairwise-arb
  legs:
    - legKey: A
      instrumentId: ag2612
      exchange: SHFE
      ratio: 1.0
    - legKey: B
      instrumentId: ag2706
      exchange: SHFE
      ratio: 1.0
  indicators:
    - pair_spread
    - pair_zscore
    - pair_beta
  entryZ: 2.0
  exitZ: 0.5
  stopZ: 3.5
  execution:
    mode: PARALLEL_IOC
    legTimeoutMs: 1500
    onLegTimeout: UNWIND_FILLED
    maxLegImbalance: 0
```

不要：

```text
PairSignal.enter()
PairSignal.exit()
PairSignal.shouldTrade()
```

这些都应该是 PairwiseArbStrategy 的决策。

---

## 9. Pair 腿与 AccountHost 边界

### 9.1 腿对象

```text
PairLegSpec
  legKey
  instrumentId
  exchange
  ratio
  sideSign
  offset
  priceType
  timeCondition

PairLegState
  position
  targetQty
  pendingQty
  filledQty
  avgPrice
  openClientOrderIds
  status
```

`legKey` 是 StrategyProcess 内部语义。

OptionManager 使用同一边界：`OptionPortfolio` 以 `legKey` 为主键，`targetPositions` 也是 `legKey -> targetQty`；AccountHost 只按 manager 的 `strategyKey` 路由，不感知 `legKey`。

### 9.2 AccountHost 不感知 legKey

AccountHost 只维护：

```text
clientOrderId -> strategyKey
```

不维护：

```text
clientOrderId -> legKey
```

也不接收 `legKey` 作为路由/归属字段。

策略自己维护：

```text
requestId -> legKey
clientOrderId -> legKey
```

### 9.3 下单流程

```text
StrategyProcess
  Strategy.decide()
    -> StrategyDecision
         targetPositions
         quoteHints
         urgency
  ExecutionPlanner.plan()
    -> OrderIntent(strategyKey, requestId, instrumentId, side, offset,
                   qty, price, orderType, timeInForce, expireTime, hedgeFlag)
  -> AccountHost
       分配 clientOrderId
       创建 OrderState(SUBMITTING)
       返回 OrderAllocated(clientOrderId, requestId)
       放入 AccessClient 队列
  -> AccessClient.submit（异步）
  -> ORS
```

`OrderAllocated` 是本地同步响应：

```text
只表示 clientOrderId 已分配
不表示 ORS 接受，也不表示成交
```

策略收到后：

```text
requestId -> legKey
clientOrderId -> legKey
```

注意：`StrategyDecision` 只存在于 StrategyProcess 内，不发送给 AccountHost。  
AccountHost 只接收 ExecutionPlanner 产出的 `OrderIntent`。

`OrderIntent` 是期货/期权共用的产品无关结构，完整字段见 `014` 的 8.4；`legKey` 不进入 `OrderIntent`。

### 9.4 成交回传

```text
FillEvent
  strategyKey
  clientOrderId
  orderRef
  exchangeOrderId
  instrumentId
  qty
  price
  tradeId
```

AccountHost 按 `clientOrderId -> strategyKey` 路由；  
StrategyProcess 再按自己的 `clientOrderId -> legKey` 更新对应腿。

### 9.5 策略重启

策略需要自己持久化：

```text
pair_leg_order
  client_order_id
  strategy_key
  leg_key
  group_id
  purpose
  state
```

AccountHost 不需要保存这份映射。

如果 strategy 无法重建 `clientOrderId -> legKey`：

```text
PAUSED
只允许减仓/平仓
不允许新开仓
```

---

## 10. 和 146 的对比

146：

```text
SimConfig
  ├─ m_indicatorList
  └─ m_calculatePNL
```

路径：

```text
CommonClient::Update
  -> Indicator::QuoteUpdate/TickUpdate
  -> m_INDCallBack
  -> CalculateTargetPNL
  -> SetTargetValue
  -> SendOrder
```

特点：

- 一策略一 SimConfig、一指标列表、一 CalculatePNL；
- 生产一策略一进程，所以实际一策略一指标引擎；
- `CalculateTargetPNL` 把指标组合成目标价；
- 指标是全局可变对象；
- 多策略同进程受 `m_simConfig`/`m_lastInstruMapIter` 影响；
- `PairwiseArbStrategy` 没有走指标路径，而是直接算盘口 spread，且未接入 146 工厂。

新设计：

```text
IndicatorCatalog（定义）
  -> StrategyProcess 的 IndicatorEngine（按订阅实例化）
  -> 每策略 Snapshot
  -> Strategy.decide
  -> StrategyDecision
  -> ExecutionPlanner
  -> OrderIntent
  -> AccountHost
```

保留 146 的正确分层：

```text
指标 -> 目标/信号 -> 策略 -> 下单
```

去掉：

```text
全局指标状态
全局 last instrument 指针
PairSignal
全量指标广播
```

---

### 10.1 `CalculateTargetPNL` 拆分设计

146 的 `CalculateTargetPNL` 实际做了五件事：

```text
1. 选依赖指标
2. 组合多个指标
3. 生成 targetPrice
4. 校验所有指标有效
5. 计算每档 targetBidPNL / targetAskPNL
```

新系统不能把它原样搬过来，应该拆成：

```text
IndicatorEngine
  -> IndicatorSnapshot
  -> Strategy.decide
       -> TargetPricePolicy
            -> quoteHint.targetPrice
       -> StrategyDecision
  -> SingleInstrumentExecutionPlanner
       -> PnLAtLevelCalculator
            -> targetBidPnl / targetAskPnl
       -> OrderIntent
  -> AccountHost
```

#### 职责边界

| 组件 | 职责 |
|---|---|
| `IndicatorEngine` | 计算指标值、依赖、有效性 |
| `TargetPricePolicy` | 单标的决策：指标快照 + 盘口 -> `quoteHint.targetPrice` |
| `Strategy` | 基于指标/仓位/风控生成 `StrategyDecision` |
| `SingleInstrumentExecutionPlanner` | 把单标的 Decision 转成订单 |
| `PnLAtLevelCalculator` | 目标价 + 盘口 + 手续费/乘数 -> 每档 PnL |
| `AccountHost` | 订单/账户/路由 |

关键：

```text
TargetPricePolicy / PnLAtLevelCalculator
  只属于单标的策略族

PairwiseArb
  不使用这两个组件
```

接口示例：

```java
interface TargetPricePolicy {
    TargetPriceQuote compute(
        IndicatorSnapshot snapshot,
        MarketBook book,
        InstrumentSpec instrument,
        TargetPriceConfig config
    );
}

record TargetPriceQuote(
    double targetPrice,
    double[] targetBidPnl,
    double[] targetAskPnl,
    boolean valid
) {}
```

不同 `m_priceType` 拆成不同 policy：

```text
RATIO        -> RatioTargetPricePolicy
MKTW_PX      -> WeightedPriceTargetPricePolicy
MKTW_PX2     -> WeightedTickTargetPricePolicy
VOL          -> VolTargetPricePolicy
```

这样：

- `AggressiveStrategy` 按模型配置选择 policy；示例用 `MKTW_PX2`，实际以模型文件为准；
- `PassiveStrategy` 可能用 `MKTW_PX`；
- 期权策略用 `VOL`；
- 不在一个函数里堆 `if (priceType == ...)`。

`PnLAtLevelCalculator` 单独做：

```text
targetPrice
bid/ask price
fee
multiplier
perYield
-> targetBidPnl[]
-> targetAskPnl[]
```

原因：

- 目标价是指标/模型问题；
- 每档 PnL 是合约和费用问题；
- 策略是用 PnL 做决策；
- 三者混在一起会导致回测和实盘口径不一致。

> PairwiseArb 不使用 `TargetPricePolicy`。它直接使用 spread/z-score/targetUnits，不走单标的目标价模型。

### 10.2 迁移样例：`AggressiveStrategy`

146 生产使用次数最多的目标价路径策略是：

| 策略 | 146 生产 control 数 |
|---|---:|
| `AggressiveStrategy` | **1172** |
| `CommsPassiveStrategy` | 406 |
| `AggressivePassiveStrategy` | 380 |
| `DepAggressivePassiveStrategy` | 41 |
| `FAKStrategy` | 6 |
| `PassiveStrategy` | 1 |

所以迁移样例选：

```text
AggressiveStrategy
```

它不仅使用最多，而且完整走：

```text
Indicator
  -> CalculateTargetPNL
  -> SetTargetValue
  -> AggressiveStrategy::SendOrder
```

#### 146 旧行为

`AggressiveStrategy::SendOrder` 的核心：

```text
1. SetThresholds
2. 处理时间止损
3. 撤掉所有 NEW_CONFIRM 挂单
4. bidDiff = targetPrice - ask
   askDiff = bid - targetPrice
5. 用 targetPrice 计算 targetBidPNL / targetAskPNL
6. 判断 spread、OPP_QTY、最大仓位、支持单数
7. 满足条件则 SendBidOrder / SendAskOrder
8. 用 PAUSE 控制同向连发
```

依赖：

```text
m_targetPrice
m_targetBidPNL
m_targetAskPNL
m_tholdBidPlace / m_tholdAskPlace
m_thold->PAUSE
m_thold->OPP_QTY
m_netpos
m_buyOpenOrders / m_sellOpenOrders
```

#### 新系统迁移

```text
AggressiveStrategy
  implements Strategy
  ├─ IndicatorEngine（由 StrategyProcess 提供）
  ├─ TargetPricePolicy（单标的决策）
  ├─ StrategyRisk（仓位/下单数/时间）
  └─ LocalOrderView（只读/派生）

SingleInstrumentExecutionPlanner
  ├─ PnLAtLevelCalculator
  ├─ 撤单/改价/报价
  └─ OrderIntent
```

处理流程：

```text
Strategy.decide(snapshot, book):
  1. if (!snapshot.ready || !snapshot.valid) return no decision
  2. quote = targetPricePolicy.compute(snapshot, book, instrument, config)
  3. if (!quote.valid) return no decision
  4. 策略级风控：
       max position
       max orders
       pause
       OPP_QTY
       spread 条件
  5. 生成 StrategyDecision：
       targetPositions[legKey] = targetQty   // 单标的：legKey = instrumentId
       quoteHints[instrument] = quote.targetPrice
       urgency = NORMAL / AGGRESSIVE
       reason = "aggressive quote"

SingleInstrumentExecutionPlanner.plan(decision):
  6. PnLAtLevelCalculator 计算 targetBidPnl / targetAskPnl
  7. 计算 bidDiff / askDiff
  8. 撤掉本策略不再需要的挂单
  9. 满足条件 -> OrderIntent
 10. AccountHost 统一分配/路由
```

注意：

```text
StrategyDecision 不是订单
策略不直接 context.submit
ExecutionPlanner 才生成 OrderIntent
```

配置示例：

```yaml
strategy:
  key: ag_aggressive_01
  type: aggressive
  indicators:
    - mid_price
    - weighted_price_offset
  targetPrice:
    policy: MKTW_PX2          # 示例；以实际模型为准
    dependencyIndicator: mid_price
    coefficients:
      weighted_price_offset: 1.0
  thresholds:
    bidPlace: 1
    askPlace: 1
    maxPosition: 10
    maxOrders: 450
    pauseMs: 50
    oppQtyRatio: 3.0
```

#### 迁移后必须保持的行为

1. 同样的指标快照 + 盘口 + 配置，目标价与 146 一致。
2. `targetBidPNL / targetAskPNL` 与 146 口径一致。
3. 撤单/下单条件一致：
   - `bidDiff > bidPlace`
   - `askDiff > askPlace`
   - PnL > 0
   - OPP_QTY 过滤
   - 最大仓位/订单数
   - PAUSE
4. 不再使用：
   - 全局 `m_simConfig`
   - `m_lastInstruMapIter`
   - `m_targetPrice` 全局成员
5. 订单由 `SingleInstrumentExecutionPlanner` 生成 `OrderIntent`，再交给 AccountHost；策略不直接发单。
6. 本地订单视图由策略维护；AccountHost 是权威。
7. `StrategyDecision.targetPositions` 是绝对目标仓位，不是本次增量。
8. `urgency` 必须能映射到具体 `OrderIntent`，并受交易所规则约束。

#### 验收对照

```text
同一段历史行情：
  146 AggressiveStrategy
  新 AggressiveStrategy
-> 目标价序列一致
-> 每档 PnL 一致
-> 下单/撤单决策一致
-> 订单通过 AccountHost
```

---

## 11. 生命周期与故障

### 启动

```text
StrategyProcess 启动
  -> 读取 StrategyConfig
  -> 解析 indicators
  -> 构建依赖图
  -> 实例化 IndicatorEngine
  -> warmup
  -> ready
```

warmup 不够：

```text
snapshot.ready = false
策略不交易
```

### 行情异常

```text
stale market data
indicator.valid = false
策略不交易
```

### 指标异常

```text
indicator 计算失败
snapshot.valid = false
策略不交易
```

### StrategyProcess 崩溃

- AccountHost 保留订单/仓位；
- 策略重启后重建指标 warmup；
- 用 `pair_leg_order` 恢复腿映射；
- 不一致 -> PAUSED。

### AccountHost 崩溃

- 策略停止新单；
- 重连后由 AccountHost 对账；
- 策略重建本地订单视图。

---

## 12. 性能

当前一策略一进程：

```text
A 只算自己的 3 个指标
B 只算自己的 5 个指标
```

不会全量计算 10 个指标给所有策略。

如果未来同进程多策略：

```text
IndicatorKey = (type, params, inputs, instrument, timeframe)
```

相同 Key 的指标只算一次，但每个策略仍然收到自己的快照。

不采用：

```text
每个指标单独触发策略
全局可变指标对象
```

指标应尽量增量计算：

```text
rolling mean/std  O(1)
z-score          O(1)
rolling OLS      O(1)
Kalman           O(1)
AR(1)/half-life  O(1)
```

---

## 13. 验收标准

1. A 策略只实例化 A 的指标，B 只实例化 B 的指标。
2. A 的 Snapshot 不包含 B 的指标字段。
3. 一次行情对同一策略只触发一次 `decide()`。
4. 指标未 ready/valid 时策略不交易。
5. PairwiseArb 的 spread/zscore/beta 来自 IndicatorEngine，不直接写策略里。
6. `PairSignal` 不存在。
7. `legKey` 不出现在 AccountHost 的路由/归属字段中。
8. `OrderIntent -> OrderAllocated` 是本地同步响应。
9. `AccessClient.submit` 是异步，不阻塞策略。
10. 策略重启后 `clientOrderId -> legKey` 能恢复，否则 PAUSED。
11. `TargetPricePolicy` 对同一 `IndicatorSnapshot + MarketBook + InstrumentSpec + config` 输出确定一致。
12. `PnLAtLevelCalculator` 与目标价计算分离，手续费/乘数口径可单独测试。
13. `AggressiveStrategy` 迁移后，目标价、每档 PnL、下单/撤单决策与 146 对照一致。
14. 新代码中不再出现 `CalculateTargetPNL` 这种“指标组合 + 目标价 + PnL”大函数。
15. `StrategyDecision` 是运行时输出，不是配置加载对象。
16. `targetPositions` 是绝对目标仓位，ExecutionPlanner 用 `target - current - pending` 计算增量。
17. `urgency` 能映射到具体 OrderIntent，且不支持的订单类型由 ExecutionPlanner 降级或拒绝。
18. 同一 `snapshot + position + orders + config + clock` 产生同一 `StrategyDecision`。

---

## 14. 开放问题

1. `PairBeta` 使用 rolling OLS 还是 Kalman，是否在 v1 引入。
2. 指标参数是否支持热更新；默认不支持，重启生效。
3. 同进程多策略是否真的需要；当前一策略一进程。
4. 指标历史窗口持久化/回放策略。
5. PairwiseArb 的 entry/exit/stop 参数由配置、DB 还是策略库同步。
6. 策略重启后自动续管 Pair，还是 PAUSED 只平仓。
7. `TargetPricePolicy` 的配置形式：每个策略一个 policy，还是从模型文件迁移。
8. `AggressiveStrategy` 的 `MKTW_PX2` / `MKTW_PX` 目标价组合是否需要支持表达式扩展；默认只支持固定 policy。

---

## 15. 一句话

```text
IndicatorCatalog 是全局定义；
IndicatorEngine 是每策略实例；
IndicatorSnapshot 是每策略视图；
Strategy 只消费自己的快照并生成 StrategyDecision；
ExecutionPlanner 把 StrategyDecision 转成 OrderIntent；
AccountHost 只按 strategyKey 路由；
legKey 永远留在 StrategyProcess。
```

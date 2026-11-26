# PAIR 参数与 trading 原始规则对照

原始代码位置（本机 `/Users/wangjun/PG/RD/quantlink-trading`）：

```text
tbsrc/Strategies/PairwiseArbOptStrategy.cpp
tbsrc/Strategies/PairwiseArbETFStrategy.cpp
tbsrc/Strategies/PairwiseArbStrategy.cpp
tbsrc/Strategies/PairwiseArbStrategyCffex.cpp
tbsrc/main/include/TradeBotUtils.h
```

`ThresholdSet` 定义在：

```text
tbsrc/main/include/TradeBotUtils.h
```

## 1. 参数含义

| 参数 | trading 原始语义 | 代码位置 |
|---|---|---|
| `BEGIN_PLACE` | 零仓位时腿1被动报价的价差阈值。买价差 `< avg - BEGIN_PLACE` 挂买，卖价差 `> avg + BEGIN_PLACE` 挂卖。 | `PairwiseArbOptStrategy.cpp` SetThresholds/Quote 逻辑 |
| `LONG_PLACE` | 多头满仓时的买侧报价阈值；与 `BEGIN_PLACE` 做线性仓位偏置。 | SetThresholds |
| `SHORT_PLACE` | 空头满仓时的卖侧报价阈值；与 `BEGIN_PLACE` 做线性仓位偏置。 | SetThresholds |
| `BEGIN_REMOVE` | 零仓位时的撤单价差阈值。 | SetThresholds |
| `LONG_REMOVE` | 多头满仓时的买侧撤单阈值。 | SetThresholds |
| `SHORT_REMOVE` | 空头满仓时的卖侧撤单阈值。 | SetThresholds |
| `SIZE` | 单次报价数量。 | SetThresholds `m_tholdSize` |
| `BEGIN_SIZE` | 初始建仓数量。 | SetThresholds `m_tholdBeginPos` |
| `MAX_SIZE` | 最大仓位，按 lot 换算。 | SetThresholds `m_tholdMaxPos` |
| `BID_MAX_SIZE` | 买方向最大仓位。 | Quote 逻辑 |
| `ASK_MAX_SIZE` | 卖方向最大仓位。 | Quote 逻辑 |
| `BID_SIZE` / `ASK_SIZE` | 买卖单笔报价数量。 | Quote 逻辑 |
| `MAX_QUOTE_LEVEL` | 报价档位数，逐档循环。 | Quote 逻辑 |
| `SUPPORTING_ORDERS` | 单边最大同时挂单数。 | Quote/Hedge 逻辑 |
| `HEDGE_THRES` | 第二腿残余未对冲量的阈值。`dr = netpos_pass / HEDGE_SIZE_RATIO + netpos_agg + pending`；`dr > HEDGE_THRES` 卖对冲，`dr < -HEDGE_THRES` 买对冲。 | `PairwiseArbETFStrategy.cpp` SendOrder |
| `HEDGE_SIZE_RATIO` | 对冲比例。第一腿净仓先除以该比例，再与第二腿净仓比较。 | `PairwiseArbETFStrategy.cpp` |
| `CROSS` | 在 `PairwiseArbOptStrategy` 中是订单类型 `CROSS`（IOC 不成即撤），不是价差阈值。`ThresholdSet.CROSS` 数值用于其他被动策略。 | `ExecutionStrategyStructs.h` 枚举；`PairwiseArbOpt` 调用 |
| `PIL_FACTOR` | 被动单腿策略的“身后挂单量价格改善”因子；`PairwiseArbOpt` 不使用。 | `BondsPassiveStrategy.cpp`、`CommsPassiveStrategy.cpp` |
| `ABSPOS_THRES` | CFFEX PAIR 变体的绝对仓位停止阈值；SHFE/INE 的 `PairwiseArbOpt` 不使用。 | `PairwiseArbStrategyCffex.cpp` |
| `AVG_SPREAD_AWAY` | 价差偏离均值超过 `tickSize * AVG_SPREAD_AWAY` 时退出/停策略。 | `PairwiseArbOptStrategy.cpp` |
| `MAX_ORDERS` | `ThresholdSet` 有字段，但 `PairwiseArbOpt` 未使用；实际使用 `SUPPORTING_ORDERS`。 | `TradeBotUtils.h` / PairwiseArbOpt |
| `MAX_TRADED_QTY` | `PairwiseArbOpt` 没有该原始参数，是量化平台新增的通用限制。 | 无 |

## 2. 仓位偏置公式

trading 的原始公式：

```text
long_place_diff  = LONG_PLACE  - BEGIN_PLACE
short_place_diff = BEGIN_PLACE - SHORT_PLACE

netpos == 0:
  bidPlace = askPlace = BEGIN_PLACE
  bidRemove = askRemove = BEGIN_REMOVE

netpos > 0:
  bidPlace = BEGIN_PLACE + long_place_diff * netpos / maxPos
  askPlace = BEGIN_PLACE - short_place_diff * netpos / maxPos

netpos < 0:
  bidPlace = BEGIN_PLACE + short_place_diff * netpos / maxPos
  askPlace = BEGIN_PLACE - long_place_diff * netpos / maxPos
```

Remove 阈值同理。

含义：

```text
仓位越偏多：
  买侧更难成交（买阈值上移）
  卖侧更容易成交（卖阈值下移）

仓位越偏空：
  买侧更容易成交
  卖侧更难成交
```

## 3. trading 的腿1报价条件

trading 用的是交叉价差，不是中间价：

```text
LongSpread  = leg1.ask[level] - leg2.bid[0]
ShortSpread = leg1.bid[level] - leg2.ask[0]

买：
  LongSpread < avg - bidPlace

卖：
  ShortSpread > avg + askPlace

撤买：
  LongSpread > avg - bidRemove

撤卖：
  ShortSpread < avg + askRemove
```

同时检查：

```text
净仓 < BID_MAX_SIZE / ASK_MAX_SIZE
单边挂单数 <= SUPPORTING_ORDERS
单笔数量 = BID_SIZE / ASK_SIZE
档位 <= MAX_QUOTE_LEVEL
```

## 4. trading 的对冲条件

ETF 变体：

```text
dr = netpos_leg1 / HEDGE_SIZE_RATIO
   + netpos_leg2
   + pending_leg2

dr > HEDGE_THRES:
  卖 leg2，价格 = leg2.bid - 1 tick，IOC/CROSS
  qty = 按 dr 取整，阈值决定 ceil/floor

dr < -HEDGE_THRES:
  买 leg2，价格 = leg2.ask + 1 tick，IOC/CROSS
```

`PairwiseArbOpt` 的 SHFE/INE 版本条件更简单：

```text
netpos_leg1 + netpos_leg2 + pending_leg2 > 0 → 卖 leg2
< 0 → 买 leg2
```

`HEDGE_THRES` 在该版本只出现在日志中，实际阈值语义以 ETF 变体为准。

## 5. 当前 Java runner 的差距

已实现：

```text
BEGIN_PLACE / LONG_PLACE / SHORT_PLACE
BEGIN_REMOVE / LONG_REMOVE / SHORT_REMOVE
仓位线性偏置
BID_SIZE / ASK_SIZE
BID_MAX_SIZE / ASK_MAX_SIZE
MAX_SIZE
HEDGE_THRES / HEDGE_SIZE_RATIO
交叉价差报价
AVG_SPREAD_AWAY
SLOP_TICKS
收盘前停止/强平
两腿 tick 对齐
```

仍未实现：

```text
MAX_QUOTE_LEVEL > 1 的多档报价
SUPPORTING_ORDERS 的多挂单完整语义
ABSPOS_THRES（仅 CFFEX 变体使用）
CROSS 数值参数（PAIR 中主要使用 IOC 订单类型）
```

注意：

```text
PIL_FACTOR 不属于 PairwiseArbOpt，不应在 PAIR 中强行实现。
CROSS 在 PAIR 中主要是订单类型，不是 0.5 这种价差参数。
```

## 6. 建议实现顺序

1. 把 `BEGIN_PLACE/LONG_PLACE/SHORT_PLACE` 和 remove 三兄弟接入仓位偏置公式。
2. 把 `BID_MAX_SIZE/ASK_MAX_SIZE/SIZE/BID_SIZE/ASK_SIZE` 接入报价数量与仓位上限。
3. 把 `SUPPORTING_ORDERS/MAX_QUOTE_LEVEL` 接入挂单控制。
4. 用 `HEDGE_THRES` 重写对冲数量取整。
5. 最后再讨论 `ABSPOS_THRES` 和 `CROSS` 是否需要保留在 PAIR 配置中。

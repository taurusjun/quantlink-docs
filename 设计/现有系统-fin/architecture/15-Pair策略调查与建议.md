# PAIR 价差策略调查与建议

- 日期：2026-11-07
- 参考：`~/PG/RD/quantlink-trading`
- 对象：`TEST-STRAT-PAIR-01` / `strategy_type=futures_pair`

## 1. trading 里的 PAIR 是什么

对应实现：

```text
tbsrc/Strategies/PairwiseArbStrategy.cpp
tbsrc/Strategies/include/PairwiseArbStrategy.h
```

控制文件示例：

```text
tbsrc/controls/day/control.TB_PAIR_STRAT.92201
```

模型示例：

```text
data_cpp/bin/models/model.au2606.au2608.par.txt.92202
```

它不是普通的单合约策略，而是双腿价差策略：

```text
leg1 = au2606
leg2 = au2608
currSpread = mid1 - mid2
```

核心行为：

1. 用两腿中间价计算价差：

```text
currSpreadRatio = mid1 - mid2
```

2. 用 EWMA 维护均值：

```text
avgSpreadRatio_ori = (1 - ALPHA) * avgSpreadRatio_ori + ALPHA * currSpreadRatio
avgSpreadRatio = avgSpreadRatio_ori + tValue
```

3. 价差偏离熔断：

```text
abs(currSpread - avg) > tickSize * AVG_SPREAD_AWAY
→ 撤单、平仓、策略 deactive
```

4. 腿1 做被动挂单：

```text
BEGIN_PLACE / LONG_PLACE / SHORT_PLACE
BEGIN_REMOVE / LONG_REMOVE / SHORT_REMOVE
```

5. 腿1 成交后，腿2 做对冲：

```text
HEDGE_THRES
SLOP
CROSS / FAK
```

6. 双腿联合持仓和敞口：

```text
Exposure() = leg1 + leg2 的联合敞口
```

7. 需要 `daily_init.<sid>`：

```text
avgPx 不能为 0
```

8. 需要两腿手续费：

```text
fee.csv 必须包含两腿合约
```

9. 停止/收盘处理：

```text
撤掉两腿挂单
等待在途单
敞口为 0 后 deactive
收盘前 3 分钟/1 分钟强制平仓
```

关键参数：

```text
SIZE / MAX_SIZE
BID_SIZE / ASK_SIZE
BEGIN_PLACE / LONG_PLACE / SHORT_PLACE
BEGIN_REMOVE / LONG_REMOVE / SHORT_REMOVE
CROSS
HEDGE_THRES
SLOP
ALPHA
AVG_SPREAD_AWAY
FIX_SIZE
MAX_LOSS / UPNL_LOSS / STOP_LOSS
```

## 2. 为什么不能直接塞进当前通用 Runner

当前 `runtime-runner` 的抽象是：

```text
一个 Strategy
  → 一个 OrderIntent
  → 一个 instrument
  → 一个方向/价格/数量
  → POST /api/v1/strategy/orders
```

PAIR 需要：

```text
两腿行情
两腿持仓
两腿挂单簿
腿1被动成交
腿2 FAK 对冲
两腿撤单
联合敞口
daily_init 价差均值
AVG_SPREAD_AWAY 熔断
收盘前强平
```

这不是一个 `OrderIntent` 能表达的。

如果直接把 `TEST-STRAT-PAIR-01` 激活，当前 Agent 找不到
`futures_pair` 的 runner，结果只会是：

```text
deployment FAILED
```

## 3. 建议

### 建议 A：保持 INACTIVE，先补专用实现

不要复用 `simple_hedging`，也不要复用 `option_quoting`。

新增专用：

```text
PairSpreadStrategy
PairSpreadRunner
```

至少需要：

```text
leg1 / leg2
priceRatio（默认 1）
spread 均值（EWMA）
daily_init avgPx
AVG_SPREAD_AWAY
BEGIN/LONG/SHORT/REMOVE 阈值
HEDGE_THRES
SLOP
两腿净持仓
两腿挂单状态
腿2 FAK 对冲
两腿撤单/收盘强平
```

建议分两阶段：

```text
Phase 1：只读信号
  → 计算价差/均值/偏离
  → INACTIVE 只发 strategy_alerts
  → 验证两腿行情和价差模型

Phase 2：执行
  → 腿1 DAY 被动挂单
  → 腿1 成交
  → 腿2 FAK 对冲
  → 联合敞口/撤单/强平
```

### 建议 B：复用 trading 的 C++ PairwiseArbStrategy

如果目标是尽快跑通真实 PAIR：

```text
直接复用 PairwiseArbStrategy
而不是在 Java 里重写
```

优点：

- 均值回归、AVG_SPREAD_AWAY、FAK 对冲、两腿撤单、收盘强平都是现成的
- model/control/daily_init 格式已经稳定

代价：

- 需要把 TradeBot 的 model/control/daily_init/fee.csv 接入
- 需要把 C++ 策略的报单/回报接到当前 ORS/Aeron
- 两腿状态和当前 RuntimeAgent 的 deployment/alert 体系需要适配

### 当前选择：Java

已选择 Java 路线，并实现第一版：

```text
backend/runtime/.../FuturesPairStrategy.java
```

已实现：

```text
两腿中间价
spread = mid1 - priceRatio * mid2
EWMA avg
entrySpread / exitSpread
AVG_SPREAD_AWAY 触发平仓
腿1 + 腿2 两条 OrderIntent
OPEN / CLOSE offset
INACTIVE 只产生 alerts
ACTIVE 才发单
```

当前部署：

```text
sim-local-pair  runner UP
deployment TEST-STRAT-PAIR-01 = INACTIVE
leg1=ag2612 / leg2=ag2706
```

PAIR 详情页现在是独立两腿视图：

```text
价差 / 均值 / AVG_SPREAD_AWAY
腿1 / 腿2 盘口与净持仓
价差持仓
entry / exit / tick
腿1挂单中标记
PAIR runner 状态更新时间
手动激活
```

Phase 2 已完成的执行骨架：

```text
腿1 被动 DAY 挂单
leg1 成交后腿2 FAK 对冲
slopTicks
hedgeTimeoutMillis
OPEN/CLOSE offset
AVG_SPREAD_AWAY 平仓
```

仍需 Phase 2：

```text
daily_init 读取
fee.csv 校验
腿1 被动 DAY 挂单
腿2 FAK 对冲
两腿订单状态机
两腿撤单/追单
收盘前强平
联合敞口与风控
```

所以当前 PAIR 只能作为 Java 只读信号/提醒版本，不建议直接当作
生产 PAIR 自动交易策略。

## 4. 当前配置不足

当前策略配置只有：

```json
{"leg1":"ag2612","leg2":"ag2702"}
```

缺少：

```text
ALPHA
AVG_SPREAD_AWAY
BEGIN/LONG/SHORT/REMOVE
HEDGE_THRES
SLOP
SIZE / MAX_SIZE
daily_init avgPx
两腿手续费
```

因此即使补 runner，也需要先补模型参数。

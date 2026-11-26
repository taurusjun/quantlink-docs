# PAIR 策略配置设计

- 日期：2026-11-07
- 目标：PAIR 参数、日状态、费用全部入库，不再使用 `daily_init.*` / `fee.csv` 手写文件
- 关联：`docs/architecture/15-Pair策略调查与建议.md`

## 1. 设计原则

```text
策略参数      → strategy_pair_configs
每日状态      → strategy_daily_state
合约费用/乘数 → instrument_fees
运行状态      → pair_state（runner 上报）
部署/激活     → strategy_deployments
```

Runner 只保留：

```text
strategyId
orsId
controlPlane 连接信息
```

不再从 `runtime-agent.properties`、`daily_init`、`fee.csv` 读取业务参数。

## 2. 两腿定义

```text
leg1 合约
leg2 合约
priceRatio
tickSize
```

spread：

```text
spread = mid(leg1) - priceRatio * mid(leg2)
```

校验：

```text
leg1 != leg2
两个合约存在且 active
tickSize > 0
priceRatio > 0
```

## 3. 价差模型

```text
avgPx                 来自 strategy_daily_state
alpha                 EWMA 系数
avgSpreadAway         偏离熔断（tickSize * 该值）
```

`avgPx` 不由页面手写，由日终状态生成/继承；首次启动允许从首笔行情初始化。

## 4. 报价阈值

第一版简化参数：

```text
entrySpread
exitSpread
removeSpread
```

后续可扩展 trading 完整参数：

```text
BEGIN_PLACE / LONG_PLACE / SHORT_PLACE
BEGIN_REMOVE / LONG_REMOVE / SHORT_REMOVE
```

## 5. 执行与对冲

```text
orderQty
maxPairPosition
slopTicks
hedgeTimeoutMillis
cooldownMillis
maxOpenOrders
```

执行规则：

```text
腿1 被动 DAY
腿1 成交后腿2 FAK
价差不利 → 撤腿1
```

## 6. 风控与收盘

```text
maxLoss
upnlLoss
stopLoss
reduceOnly
closeoutBeforeEndMinutes   3
aggressiveBeforeEndMinutes 1
```

收盘时间不是固定 14:57，而是按品种交易时段计算：

```text
日盘  09:00-15:00   → 14:57 停止 / 14:59 强平
夜盘  21:00-02:30   → 02:27 停止 / 02:29 强平（SHFE/INE）
夜盘  21:00-23:00   → 22:57 停止 / 22:59 强平（DCE/CZCE/GFEX）
```

说明：

```text
closeoutBeforeEndMinutes   = 当前交易时段结束前 N 分钟：停止新单、撤单、平仓
aggressiveBeforeEndMinutes = 当前交易时段结束前 N 分钟：强制平仓兜底
```

交易时段来自 `instrument_trading_sessions`，按品种/交易所配置；
runner 只在当前时段内交易，收盘停止后本时段不再开新仓。

这是 trading 原逻辑，不是所有 PAIR 业务的强制要求；
如果未来做隔夜价差，可以关闭 aggressive flat。

## 7. 日状态

```text
strategy_daily_state
  strategy_id
  trade_date
  avg_px
  ytd1 / today1 / ytd2
  px1 / px2
  max_pnl / pnl
```

用途：

```text
初始价差均值
隔夜仓位恢复
PnL / 风控
```

## 8. 费用配置

```text
instrument_fees
  account_id          ← 费率按柜台账户隔离
  instrument_id
  exchange
  fee_money_buy / fee_money_sell
  fee_volume_buy / fee_volume_sell
  multiplier
  prev_settle
```

`instrument_fees` 主键为 `(account_id, instrument_id)`。
同一合约在不同柜台/账户可以有不同费率；Runner 使用 ORS 对应账户的费率。
不再读取 `fee.csv`。

## 9. 配置页面

策略配置页对 `futures_pair` 显示专用步骤：

```text
1. 基础与部署
2. 两腿定义
3. 价差模型
4. 报价阈值
5. 对冲与执行
6. 风控与收盘
7. 日状态与费用（只读/生成）
8. 复核、保存版本、部署
```

## 10. 生效方式

```text
保存配置 → 写入 strategy_pair_configs / strategy_daily_state
部署   → strategy_deployments = INACTIVE
激活   → ACTIVE
Runner → 启动时和每 30 秒从控制面读取配置
```

不再需要重启 Agent 来改业务参数。

## 11. 实现状态

已完成：

```text
strategy_pair_configs
strategy_daily_state
instrument_fees
PAIR 参数弹窗
PAIR Runner 从控制面读取配置
PAIR 日终快照任务
fee CSV 导入接口与 fee_refresh 定时器
```

当前：

```text
ag2612 fee_money = 5.005e-05
ag2706 fee_money = 0.00015
multiplier = 15
```

费率来源：

```text
CTP adapter（Agent 已登录会话）15:05/02:35 查询
→ /var/lib/quantlink-fin/fee/<account>-fees.csv / -margins.csv
→ systemd fee-refresh 脚本只做 import API
→ instrument_fees / instrument_margins
```

不允许 `qf-fee-refresh` 或任何其他进程再开第二个 CTP 登录；第二次登录会踢掉 Agent 的 trader session。

CTP 查询必须遵守约 1 秒 1 次的查询流控，`ReqQryInstrumentCommissionRate` /
`ReqQryInstrumentMarginRate` 的返回值必须检查。CTP 返回的是
`Open/Close/CloseToday` 费率，不是 buy/sell。

`instrument_fees` 已增加 `fee_money_open/close/close_today` 与
`fee_volume_open/close/close_today`；成交账本按 `offset` 选择对应字段，
不再按买卖方向取费。旧的 buy/sell 列仅为历史兼容保留，不再参与成交手续费计算。

## 12. 禁止手写文件

`daily_init.*` / `fee.csv` 不再作为本系统运行时输入：

```text
策略日状态 → strategy_daily_state
费用        → instrument_fees
PAIR 参数   → strategy_pair_configs
```

Runner 仍需要 Agent 的启动命令和连接信息，但业务参数全部从控制面读取。

## 13. SimNow 策略部署

SimNow 不是 SimLocal 的同一执行域：

```text
SIMLOCAL-001 → ors-simlocal-001 → agent-control-local
TEST-001    → ors-simnow-test-001 → agent-simnow-01
```

切换到 SimNow 时，已有 SimLocal deployment 不会迁移。

已准备：

```text
agent-simnow-01
  simnow-opt
  simnow-hedge

strategy_deployments:
  TEST-STRAT-OPT-01   → ors-simnow-test-001   INACTIVE
  TEST-STRAT-HEDGE-01 → ors-simnow-test-001   INACTIVE
```

交易日 08:45 Agent/ORS 启动后，策略进程以 INACTIVE 只读提醒模式启动；
需要交易时在 SimNow ORS 上激活对应 deployment。

## 14. 完整 trading 参数

页面「PAIR参数」高级区已包含：

```text
BEGIN_PLACE / LONG_PLACE / SHORT_PLACE
BEGIN_REMOVE / LONG_REMOVE / SHORT_REMOVE
HEDGE_THRES / HEDGE_SIZE_RATIO
MAX_SIZE / BID_SIZE / ASK_SIZE
BID_MAX_SIZE / ASK_MAX_SIZE
MAX_QUOTE_LEVEL / SUPPORTING_ORDERS
FIX_SIZE / OPP_QTY
MAX_ORDER_COUNT / MAX_TRADED_QTY
```

这些字段存入 `strategy_pair_configs.advanced_json`。
当前 runner 使用核心阈值，完整字段供后续两腿订单簿执行使用。

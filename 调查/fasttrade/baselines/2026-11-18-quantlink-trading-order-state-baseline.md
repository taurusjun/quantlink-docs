# quantlink-trading 订单/成交/仓位基线

- 日期：2026-11-18
- 状态：CALIBRATION BASELINE
- 来源仓库：`/Users/wangjun/PG/RD/quantlink-trading`
- 用途：FastTrade 订单状态与成交处理的对照基线，不是可直接移植的代码

## 1. 基线结论

`quantlink-trading` 的核心模型是：

```text
订单状态：由 ORS/venue 回报推进
成交数量：由 TRADE_CONFIRM 推进
仓位：由累计成交数量推进
撤单：收到 CANCEL_CONFIRM 才减少 openQty
终态：openQty == 0 才移除订单
```

它**没有** FastTrade 那种独立的：

```text
OrderUpdate FILLED
```

也没有在 FILLED 时先清订单、再等 Trade 更新仓位。它的成交回报本身就是成交数量和仓位的驱动。

## 2. 状态枚举

来源：

```text
tbsrc/Strategies/include/ExecutionStrategyStructs.h:20-33
```

```text
NEW_ORDER
NEW_CONFIRM
NEW_REJECT
MODIFY_ORDER
MODIFY_CONFIRM
MODIFY_REJECT
CANCEL_ORDER
CANCEL_CONFIRM
CANCEL_REJECT
TRADED
INIT
```

注意：

- 没有 `PARTIAL` 状态。
- 部分成交时订单仍在 `NEW_CONFIRM` 或 `CANCEL_ORDER` 等非终态。
- 是否完成由 `m_openQty == 0` 决定，不是由 `PARTIAL/FILLED` 枚举决定。

## 3. 订单结构

来源：

```text
tbsrc/Strategies/include/ExecutionStrategyStructs.h:44-68
```

关键字段：

```text
m_orderID
m_Qty
m_openQty
m_cxlQty
m_doneQty
m_status
m_side
m_price
m_newprice
```

含义：

```text
m_Qty       原始数量
m_openQty   尚未成交/未撤的数量
m_doneQty   已成交数量
m_cxlQty    已撤数量
m_status    生命周期状态
```

## 4. 回报处理主流程

来源：

```text
tbsrc/Strategies/ExecutionStrategy.cpp:995-1165
```

### NEW_ORDER_CONFIRM

```text
m_status = NEW_CONFIRM
m_rejectCount = 0
m_confirmCount++
```

订单进入可工作状态。

### TRADE_CONFIRM

```text
如果当前不是 MODIFY_ORDER / CANCEL_ORDER:
    m_status = NEW_CONFIRM
ProcessTrade(response, iter)
```

注意：如果撤单在途时成交先到，代码不会把状态改回 `NEW_CONFIRM`，而是保留 `CANCEL_ORDER` 后继续处理成交。

### CANCEL_ORDER_CONFIRM

进入 `ProcessCancelConfirm`：

```text
openQty -= cancelQty
cxlQty = cancelQty
status = CANCEL_CONFIRM
if openQty <= 0:
    RemoveOrder
```

### CANCEL_ORDER_REJECT

```text
if status != TRADED:
    status = NEW_CONFIRM
ProcessCancelReject
```

撤单被拒后订单仍被视为活动订单，并按 `CANCELREQ_PAUSE` 控制重试。

### NEW_REJECT / ORDER_ERROR

```text
status = NEW_REJECT
ProcessNewReject
RemoveOrder
```

## 5. 成交处理

来源：

```text
tbsrc/Strategies/ExecutionStrategy.cpp:1988-2115
```

`ProcessTrade` 的顺序：

```text
1. m_openQty -= trade.qty
2. m_doneQty += trade.qty
3. 更新 buy/sell 成交量和成交均价
4. m_netpos = m_buyTotalQty - m_sellTotalQty
5. 更新 PnL
6. if m_openQty == 0:
       m_status = TRADED
       RemoveOrder
```

关键代码位置：

```text
openQty/doneQty    ExecutionStrategy.cpp:1991-1992
netpos            ExecutionStrategy.cpp:2065
TRADED/Remove     ExecutionStrategy.cpp:2106-2114
```

## 6. 仓位来源

仓位不是从订单状态或 FILLED 状态推导，而是：

```text
m_netpos = m_buyTotalQty - m_sellTotalQty
```

每一条成交：

```text
BUY  -> m_buyTotalQty += qty
SELL -> m_sellTotalQty += qty
```

然后重新计算净仓和均价。

## 7. 撤单中的成交

`TRADE_CONFIRM` 分支先检查：

```text
if status != MODIFY_ORDER && status != CANCEL_ORDER:
    status = NEW_CONFIRM
```

所以：

```text
CANCEL_ORDER -> TRADE_CONFIRM
    -> 保留 CANCEL_ORDER 状态
    -> ProcessTrade
    -> openQty 减到 0 后 TRADED
```

代码中还有专门的告警：

```text
ALERT!! TRADE ON CANCEL REJECT.
```

这说明基线显式考虑了“撤单失败/在途成交”的竞态。

## 8. 状态机不变量

可以作为 FastTrade 校准目标：

1. `openQty` 只能由成交或撤单确认减少。
2. `doneQty` 只能由成交增加。
3. `netpos` 只能由成交数量累计计算。
4. 部分成交不是终态。
5. `openQty == 0` 才能进入 `TRADED` 并移除订单。
6. 撤单请求本身不减少 `openQty`。
7. 撤单在途成交必须仍能推进成交数量和净仓。
8. 订单状态与仓位是相关但独立的账本。
9. 收到终态回报不能回退到更早状态。
10. 成交数量必须单调不减。

## 9. 与 FastTrade 的差异

| 项 | quantlink-trading | FastTrade 当前 |
|---|---|---|
| 成交状态 | `TRADE_CONFIRM` 同时推进 open/done | `OrderUpdate PARTIAL/FILLED` 推进；`Trade` 单独 |
| 仓位 | 成交累计 | 累计 `filledQty`（本轮修复） |
| 终态 | `openQty == 0` | `FILLED/CANCELED` 回报清除 |
| partial | 非终态，靠 openQty | `PARTIAL` 进入 OPEN |
| 撤单在途成交 | 明确保留 CANCEL_ORDER 并处理成交 | `CANCELING` 下仍处理 PARTIAL/FILLED |
| 快照 | 本地账本优先/对账 | 仓位快照可覆盖（需按时间戳判断） |
| 成交去重 | 基线依赖 ORS/回报 | 无独立 Trade 去重账本 |

## 10. 使用边界

这是一份**行为基线**，不是要求 FastTrade 复制 C++ 状态枚举或 ORS 结构。

需要校准的是：

```text
成交量单调
仓位来自成交
终态由剩余量决定
撤单在途仍可成交
订单状态不能倒推成交量
```

不需要校准的是：

```text
具体枚举名
C++ 容器结构
ORS 协议结构
策略层 PnL 算法
```

## 11. 已知基线缺口

本次只阅读了订单状态、成交、撤单和仓位主路径，未覆盖：

- `MODIFY_ORDER` 的全部边界。
- 自成交、组合策略和期权 Greeks。
- 券商/ORS 侧回报去重实现。
- 盘中重启和快照恢复的完整路径。

FastTrade 方案应把这些缺口标为“未校准”，不能假设基线已经证明。

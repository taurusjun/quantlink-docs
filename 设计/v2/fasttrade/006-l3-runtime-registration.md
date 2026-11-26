# 006 L3 StrategyRuntime / TradeBotOrderGateway 设计

- 状态：DRAFT
- 日期：2026-11-25
- 范围：L3 StrategyRuntime、TradeBotOrderGateway
- 业务基准：`tb_origin = /Volumes/DevDisk/git/tb_origin/tbsrc`
- 关联：
  - L2 设计：`005-l2-trading-channel.md`
  - 对照：`ref/001-tb-origin-parity.md`

---

## 1. 定位

L3 负责策略意图和策略级状态：

```text
指标/信号
策略决策
OrderIntent
策略级持仓视图
启动注册
```

L3 不负责：

```text
直接写 IPC
直接调用 ORS
直接改 OrderRegistry
账户级持仓真相
```

---

## 2. tb_origin 的报单行为

`tb_origin` 的新单：

```text
side + price + qty + DAY/FAK
```

不发送：

```text
PosDirection
offset
```

`CommonClient::SendNewOrder`：

```text
Duration = FAK if ordHitType == CROSS else DAY
OrdType  = LIMIT
```

`CROSS`：

```text
主动扫单/尾盘 aggressive flatten
-> FAK
```

平仓：

```text
HandleSquareoff:
  qty = abs(m_netpos)
  一笔 SendNewOrder
```

不拆单。

---

## 3. OrderIntent

L3 向 L2 提交：

```text
strategyId
businessAccountId
contractKey
side
price
qty
duration = DAY / FAK
offsetIntent = AUTO（默认）
```

约束：

```text
策略路径默认 AUTO
不要求 TB 传 offset/PosDirection
不要求 TB 拆单
```

显式 offset（OPEN/CLOSE_TODAY/CLOSE_YESTERDAY）只保留给手工/高级入口；策略路径不使用。

---

## 4. 策略持仓

`tb_origin` 的策略持仓：

```text
m_netpos = m_buyTotalQty - m_sellTotalQty
```

用途：

```text
决定 TB 报单手数
squareoff 的 qty
策略 PnL/监控
```

不用途：

```text
L2 AUTO offset
账户可平量
```

账户级持仓真相在 L2/L0；策略持仓不是账户真相。

---

## 5. 字段映射

```text
tb_origin StrategyID -> OrderIntent.strategyId
tb_origin Product    -> L3 监控字段
tb_origin AccountID  -> OrderIntent.businessAccountId
tb_origin OrderID    -> L3 clientOrderId
```

`businessAccountId` 由 L2 映射为 venue 账户；L3 不直接拼 L0 的 `accountId`。

---

## 6. 回报路由

`tb_origin` 用 `OrderIDStrategyMap` 按 `OrderID` 找策略。

新系统等价设计：

```text
L2 返回 clientOrderId/orderRef
L3 维护 clientOrderId/orderRef -> strategyId
回报按此路由到 StrategyRuntime
```

映射：

```text
ACK       -> NEW_ORDER_CONFIRM
Trade     -> TRADE_CONFIRM
CANCELED  -> CANCEL_ORDER_CONFIRM
cancelState=REJECTED -> CANCEL_ORDER_REJECT
REJECTED  -> ORDER_ERROR / ORS_REJECT / RMS_REJECT
```

不要求 L0 携带 strategyId。

---

## 7. 平仓

`tb_origin`：

```text
HandleSquareoff:
  qty = abs(m_netpos)
  一笔发出
```

新系统：

```text
L3 保持整笔净仓
L2 按 AUTO 选择 offset
L2 单边放不下 -> 整笔 OPEN
不拆单
```

L3 不按今仓/昨仓拆分；今昨仓由 L2 的账户级账本处理。

---

## 8. 策略注册与生命周期

```text
TB 启动读配置
  -> 校验 strategyId 唯一
  -> 创建 StrategyRuntime
  -> 写入 StrategyRegistry
```

不做：

```text
动态注册 API
心跳注册
租约/发现
中央注册中心
```

策略状态：

```text
STARTING / RUNNING / STOPPING / STOPPED / ERROR
```

---

## 9. 不变量

```text
1. strategyId 在 TB 内唯一
2. strategyId 不参与 exchange/contract 路由
3. TB 不发 offset/PosDirection
4. TB 只发 LIMIT + DAY/FAK
5. TB 平仓整笔净仓，不拆单
6. 策略持仓不是账户真相
7. 回报按 clientOrderId/orderRef 路由
```

---

## 10. 未决

```text
1. L3 策略持仓是否参与部分风控
2. 手工/高级入口是否允许显式 offset
3. Product 的读模型归属
```

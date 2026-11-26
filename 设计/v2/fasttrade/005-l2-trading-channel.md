# 005 L2 TradingChannel 设计

- 状态：DRAFT
- 日期：2026-11-25
- 范围：L2 TradingChannel
- 上游：L3 `OrderIntent`
- 下游：L1 COMMAND、L0 `OrderUpdate/Trade/PositionSnapshot`
- 关联：
  - L0 设计：`003-l0-ors-venue.md`
  - L1 设计：`004-l1-ipc-transport.md`
  - ORS 改动：`quantlink-ors/docs/2026-11-25-ctp-ors-changes.md`
  - 业务基准：`ref/001-tb-origin-parity.md`、`ref/002-china-ctp-ors-parity.md`

---

## 1. 定位

L2 是订单业务状态的拥有者：

```text
OrderRegistry
FillLedger
账户级平仓可用量账本
orderRef 分配
AUTO 开平解析
平仓预扣/释放
可选 STP
回报归属
```

L2 不负责：

```text
策略决策
策略持仓归属
CTP 字段映射
CTP 持仓查询
拆单
RMS
```

---

## 2. 输入与输出

### 2.1 输入

来自 L3：

```text
OrderIntent:
  strategyId
  businessAccountId
  contractKey
  side
  price
  qty
  duration = DAY / FAK
  offsetIntent = AUTO（默认）
```

来自 L1：

```text
OrderUpdate
Trade
PositionSnapshot
AccountSnapshot
VenueSession
```

### 2.2 输出

发给 L1：

```text
OrderRequest（最终 offsetFlag、qty、orderRef）
CancelRequest
```

发给 L3：

```text
ACK / PARTIAL / FILLED / CANCELED / REJECTED
Trade
```

---

## 3. 订单模型

`OrderRecord` 至少包含：

```text
clientOrderId
orderRef
strategyId
businessAccountId
venueAccountId
exchange
instrumentId
side
offsetFlag
orderType
timeInForce
price
orderQty
filledQty
remainingQty
status
cancelState
requestId
sourceSessionId
sourcePublicationEpoch
```

状态：

```text
NEW       本地已创建/已发布
ACK       柜台已接受
PARTIAL   部分成交
FILLED    全部成交，终态
CANCELED  已撤，终态
REJECTED  新单被拒，终态
```

约束：

```text
ACK 只发一次
FILLED 不早于 Trade
终态订单从 active 集合移除或归档
```

---

## 4. AUTO 开平

### 4.1 输入

```text
OrderIntent.offsetIntent = AUTO
账户级 PositionSnapshot
本通道未完成订单的预扣
```

### 4.2 算法

```text
BUY:
  qty <= 今空 -> CLOSE_TODAY（SHFE/INE）/ CLOSE（非 SHFE/INE）
  qty <= 昨空 -> CLOSE
  否则       -> OPEN

SELL:
  qty <= 今多 -> CLOSE_TODAY（SHFE/INE）/ CLOSE（非 SHFE/INE）
  qty <= 昨多 -> CLOSE
  否则       -> OPEN
```

### 4.3 整笔规则

```text
一笔 OrderIntent 只生成一笔 OrderRequest
只选一个最终 offsetFlag
不拆单
```

如果 `qty` 同时大于今仓和昨仓：

```text
整笔 OPEN
```

这是公司 China ORS 的原语义，也是 `tb_origin` 整笔 squareoff 的配套行为。  
代价是：大单平仓会被转成开仓，L3/策略必须控制单笔 qty；L2 不自行拆单或改拒单。

### 4.4 账户持仓不是策略持仓

`tb_origin` 的 `m_netpos` 是策略级：

```text
m_netpos = m_buyTotalQty - m_sellTotalQty
```

它只用于：

```text
决定 TB 报单手数
策略 PnL/监控
```

L2 的 AUTO 使用**账户级今昨仓**，不是 `m_netpos`。

---

## 5. 平仓预扣/释放账本

### 5.1 数据结构

按 `account + exchange + instrument` 维护：

```text
todayLong
todayShort
yesterdayLong
yesterdayShort
reservedTodayLong
reservedTodayShort
reservedYesterdayLong
reservedYesterdayShort
```

### 5.2 生命周期

发单：

```text
AUTO 选定 offset 后，预扣对应 bucket
```

拒单：

```text
REJECTED -> 释放全部剩余
```

撤单：

```text
CANCELED -> 释放未成交剩余
```

成交：

```text
OPEN 成交      -> 增加今仓
CLOSE_TODAY 成交 -> 消耗今仓预扣，不重复扣
CLOSE 成交     -> 消耗昨仓预扣，不重复扣
```

### 5.3 对账

`PositionSnapshot` 到达后：

```text
1. 以快照为账户持仓基线
2. 保留在途订单的预扣
3. 重新计算可用量
4. 记录不一致
```

查询未完成或不新鲜时：

```text
不启用 AUTO 平仓
不静默使用旧快照
```

---

## 6. STP

决策：**默认关闭，可选开启。**

```text
未配置 -> 订单路径直接跳过 STP
配置开启 -> account + exchange + instrument
            方向相反 + 价格交叉 + 对手单 open
            -> 拒绝新单
```

约束：

```text
STP 检查与 pending 入表在同一临界区/单线程内完成
覆盖策略单和手工单
不解决跨策略吃仓
```

---

## 7. 字段映射

```text
TB StrategyID  -> OrderRecord.strategyId
TB Product     -> L2/L3 监控字段
TB AccountID   -> businessAccountId
TB OrderID     -> clientOrderId
```

`businessAccountId` 到 venue 账户：

```text
L2 按配置映射到 venueAccountId
OrderRequest.accountId = venueAccountId
```

L0 不接收：

```text
strategyId
Product
PosDirection
```

---

## 8. 回报映射

```text
L0 OrderUpdate.status=ACK       -> L3 NEW_ORDER_CONFIRM
L0 Trade                        -> L3 TRADE_CONFIRM
L0 OrderUpdate.status=CANCELED  -> L3 CANCEL_ORDER_CONFIRM
L0 cancelState=REJECTED         -> L3 CANCEL_ORDER_REJECT
L0 status=REJECTED              -> L3 ORDER_ERROR / ORS_REJECT / RMS_REJECT
```

L2 保留：

```text
orderRef / clientOrderId -> strategyId
```

回报按此映射回 L3；不依赖 L0 携带 strategyId。

---

## 9. 关键流程

### 9.1 新单

```text
L3 OrderIntent(AUTO)
  -> L2 映射 venueAccountId
  -> L2 读账户持仓 + 预扣
  -> AUTO 选 offset
  -> 预扣
  -> 分配 orderRef
  -> OrderRegistry pending
  -> L1 COMMAND
```

### 9.2 拒单

```text
L0 REJECTED
  -> L2 释放预扣
  -> L3 ORDER_ERROR
```

### 9.3 成交

```text
L0 Trade
  -> L2 更新 filledQty/remainingQty
  -> FillLedger
  -> OPEN 加仓 / CLOSE 消耗预扣
  -> L3 TRADE_CONFIRM
```

### 9.4 撤单

```text
L3 Cancel
  -> L2 CancelRequest
  -> L0 final
  -> L2 释放剩余
  -> L3 cancel confirm/reject
```

### 9.5 重连

```text
L0 PositionSnapshot / OrderUpdate / Trade
  -> L2 对账 OrderRegistry
  -> L2 对账预扣账本
  -> READY 后接受新单
```

---

## 10. 不变量

```text
1. 一笔 OrderIntent 只生成一笔 OrderRequest
2. 每笔 OrderRequest 只有一个最终 offsetFlag
3. 不拆单
4. AUTO 使用账户级今昨仓
5. 平仓发单预扣，拒/撤释放，成交不重复扣
6. ACK 只发一次
7. FILLED 不早于 Trade
8. 终态订单移除/归档
9. STP 默认关闭
10. strategyId/Product 不进入 L0
```

---

## 11. 未决

```text
1. CancelState::REQUESTED 是否暴露给 L3
2. L3 策略持仓是否参与部分风控
3. RMS 放 L2 还是独立组件
4. CFFEX/ZCE 后续接入时的 TIF 规则
```

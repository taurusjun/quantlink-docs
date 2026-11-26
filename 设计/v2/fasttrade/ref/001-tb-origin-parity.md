# 001 tb_origin TB 与新系统差异

- 状态：DRAFT
- 日期：2026-11-25
- 基准：`tb_origin = /Volumes/DevDisk/git/tb_origin/tbsrc`
- 范围：tb_origin 的报单/回报行为，与新系统 L0/L1/L2/L3 设计对照
- 原则：业务逻辑以 tb_origin 原代码为准；不质疑、不自行设计替代逻辑

说明：`tb_origin` 目录下是 TB 源码，没有 ORS 源码。本文以 tb_origin 的报单/回报行为为准，描述新系统必须提供的对应逻辑；ORS 侧只保留 tb_origin 依赖的“单笔、整笔推断”语义，不引入拆单等新方案。

---

## 1. 结论

tb_origin 的 TB 只发：

```text
side + price + qty + DAY/FAK
```

不发 offset，不发 PosDirection，也不拆单。平仓时它按策略净仓 `m_netpos` **整笔**发出。

新系统设计目前的主要差异不是“要不要拆单”，而是：

```text
1. L2 缺少 AUTO 开平推断（TB 不传 offset）
2. L2 缺少平仓预扣/释放账本（TB 整笔平仓会超平）
3. CTP FAK 映射错误（TB 的 CROSS 全部走 FAK）
4. StrategyID/Product/AccountID/OrderID 的 L2 映射未写清
5. TB ResponseMsg 与新 contract 的状态映射未写清
```

---

## 2. tb_origin 的实际行为

### 2.1 新单字段

`main/CommonClient.cpp:950-1006`：

```text
m_reqMsg.Request_Type = NEWORDER
m_reqMsg.Token
m_reqMsg.Transaction_Type = side
m_reqMsg.Price
m_reqMsg.Quantity
m_reqMsg.QuantityFilled = 0
m_reqMsg.DisclosedQnty = Quantity
m_reqMsg.Product = execStrategy->m_product
m_reqMsg.StrategyID = execStrategy->m_strategyID
m_reqMsg.AccountID = 业务账户
m_reqMsg.Contract_Description.Symbol
m_reqMsg.Exchange_Type = instrument exchange
m_reqMsg.Duration = FAK if ordHitType == CROSS else DAY
```

`main/CommonClient.cpp:1144-1145`：

```text
OrdType = LIMIT
PxType  = PERUNIT
```

`hftbase/Connector/include/connector.h:271-277`：

```text
OrderID = GetUniqueOrderNumber(Exchange_Type)
Request_Type = NEWORDER
PushRequest
```

关键点：

```text
不设置 PosDirection
不设置 offset
不设置市场单
只有 DAY / FAK
StrategyID / Product 在 RequestMsg 中
OrderID 由 Connector 按 exchange 分配
DisclosedQnty 永远等于 Quantity
```

### 2.2 平仓是整笔净仓

`Strategies/ExecutionStrategy.cpp:2437`：

```cpp
int32_t qty = m_netpos > 0 ? m_netpos : -1 * m_netpos;
```

`Strategies/MMFPassiveStrategy.cpp:112`、`Strategies/ExtraStrategy.cpp:604` 同样：

```cpp
int32_t qty = m_netpos > 0 ? m_netpos : -1 * m_netpos;
```

然后一笔 `SendNewOrder`。TB 不按今仓/昨仓拆，也不知道 ORS 的今昨仓分布。

`m_netpos` 是策略级：

```text
ExecutionStrategy.cpp:2062
m_netpos = m_buyTotalQty - m_sellTotalQty
```

### 2.3 回报

`hftbase/CommonUtils/include/orderresponse.h:438-463`：

```text
ResponseMsg:
  Response_Type
  OrderID
  ErrorCode
  Quantity
  Price
  Side
  Symbol
  AccountID
  ExchangeOrderId
  ExchangeTradeId
  Product
  StrategyID
```

`main/main.cpp:283-294`：

```text
OrderIDStrategyMap.find(response->OrderID)
```

TB 用 `OrderID` 找回策略；找不到就报错。

---

## 3. P0：新系统设计必须纠正

### 3.1 L2 必须支持 AUTO 开平推断

tb_origin 不发 `PosDirection`，也不发 offset。新系统不能要求 TB 传开平。

新系统当前：

- `001-system-overview.md` / `002-system-layers.md` 只写 `OrderIntent(strategyId, contractKey, ...)`，没有 offset 字段语义。
- `003-l0-ors-venue.md` / contract 只规定 L0 收到最终 `offsetFlag`。
- 缺少“TB 不传 offset 时 L2 怎么推断”的设计。

必须补：

```text
OrderIntent.offsetIntent = AUTO（默认）/ OPEN / CLOSE
策略路径默认 AUTO
AUTO 解析：
  BUY  -> 今空够则平今；否则昨空够则平昨；否则开多
  SELL -> 今多够则平今；否则昨多够则平昨；否则开空
```

注意：这里的“持仓”必须与 tb_origin 依赖的原 ORS 一致：**账户级今昨仓**，不是策略级 `m_netpos`。策略级 `m_netpos` 只决定 TB 发多少手，不决定 offset。

### 3.2 整笔平仓必须保留“整笔推断”语义

tb_origin 的 squareoff 是整笔净仓；原 ORS 的语义是：

```text
qty <= 今仓 -> 平今
否则 qty <= 昨仓 -> 平昨
否则 -> 整笔 OPEN
```

新系统设计必须原样保留这条，不要改成拆单、也不要改成拒单。`contract-fields.md` 已写“整笔按 OPEN”，但 `002-system-layers.md` 的 L2/TB 下单路径还没有把这条写进流程。

必须补：

```text
L2/TB 下单路径：
  1. 取账户今昨仓
  2. 按 AUTO 选择单一 offset
  3. 单笔放不下今/昨 -> 整笔 OPEN
  4. 不拆单
```

这条是 tb_origin 整笔 squareoff 的直接对应逻辑，不能自行替换。

### 3.3 平仓预扣/释放账本

tb_origin 平仓整笔发出；如果 L2 不预扣，两个 squareoff/平仓单可以同时通过可平校验。

原 ORS 语义：

```text
发单时：今/昨仓 -= qty
拒单：  今/昨仓 += 剩余
撤单：  今/昨仓 += 剩余
开仓成交：今多/今空 += trade.qty
平仓成交：不重复加（发单已扣）
```

新系统必须补：

```text
reserve(account, exchange, instrument, side, bucket, qty)
release_full(order)
release_remaining(order)
consume_on_fill(order, qty)
reconcile_with_position_snapshot()
```

作用域按 tb_origin 依赖的原 ORS：**账户 + 交易所 + 合约**，不是策略子账本。

### 3.4 DAY/FAK 映射

tb_origin 只有：

```text
LIMIT + DAY
LIMIT + FAK（CROSS）
```

FAK 是所有 aggressive/squareoff 的路径，映射必须正确。

原 ORS CTP 映射：

```text
DAY:
  GFD + AV + MinVolume=1 + LimitPrice=price

FAK:
  IOC + AV + MinVolume=1 + LimitPrice=price

（IOC/FOK 不是 TB 路径，但为新 contract 保留时也应保持原 ORS 语义：
 IOC: IOC + CV + MinVolume=qty
 FOK: IOC + CV + MinVolume=qty）
```

新系统当前：

```text
contract 表：FAK = IOC + AV（正确）
CtpAdapter：FAK -> IOC + CV（错误）
CtpAdapter：DAY -> GFD + AV，但 MinVolume 未显式设 1
```

必须改：

```text
CtpAdapter::fillInsert
  FAK: IOC + AV + MinVolume=1
  DAY: GFD + AV + MinVolume=1
```

并补测试：CROSS/FAK 部分成交、FAK 全撤、DAY 挂单。

### 3.5 StrategyID / Product / AccountID / OrderID 映射

tb_origin 字段：

```text
StrategyID  -> L3 策略归属 / Dashboard
Product     -> 策略/监控字段
AccountID   -> 业务账户（不是 venue 账户）
OrderID     -> Connector 按 exchange 分配
```

新系统：

```text
contract L0 没有 StrategyID/Product
contract accountId = venue 账户
L2 分配 orderRef
```

必须补映射表：

```text
TB StrategyID        -> L2 OrderRegistry.strategyId（仅归属/回报）
TB Product           -> L2/L3 监控字段（不进 L0）
TB AccountID         -> L2 业务账户 -> L0 venue accountId
TB OrderID           -> L2 clientOrderId/orderRef -> 回报时映射回 TB
```

`001-system-overview.md` 已写业务账户到 venue 账户的映射，但 `OrderIntent` / L2 字段还没有逐项落表。

### 3.6 TB ResponseMsg 与新 contract 的状态映射

tb_origin 依赖：

```text
NEW_ORDER_CONFIRM
TRADE_CONFIRM
CANCEL_ORDER_CONFIRM
CANCEL_ORDER_REJECT
ORDER_ERROR
ORS_REJECT
RMS_REJECT
ORDERS_PER_DAY_LIMIT_REJECT
```

新 contract：

```text
OrderUpdate.status = NEW / ACK / PARTIAL / FILLED / CANCELED / REJECTED
Trade
OrderUpdate.cancelState = NONE / REQUESTED / REJECTED
```

必须补映射：

```text
NEW_ORDER_CONFIRM   -> OrderUpdate.status=ACK（不是本地 NEW）
TRADE_CONFIRM       -> Trade
CANCEL_ORDER_CONFIRM-> OrderUpdate.status=CANCELED
CANCEL_ORDER_REJECT -> OrderUpdate.cancelState=REJECTED，原 status 继续
ORDER_ERROR/ORS_REJECT/RMS_REJECT -> OrderUpdate.status=REJECTED + reason/errorCode
```

并且 L2 要保留 `orderRef -> strategyId`，回报时让 TB 能找回策略；tb_origin 用 `OrderIDStrategyMap` 做这件事。

### 3.7 账户持仓与策略持仓

tb_origin：

```text
m_netpos = 策略级买卖总量差
```

原 ORS：

```text
mapContractPos = 账户级今/昨仓
SetCombOffsetFlag 只用账户级持仓
```

新系统：

```text
L3 策略持仓
L2 channel 账户+交易所持仓
L0 venue 账户持仓
```

为保持 tb_origin 依赖的原逻辑，L2 的 AUTO offset 必须使用 **账户级今/昨仓**；策略级 `m_netpos` 只用于 TB 决定报单手数。  
如果新系统改成用策略持仓做 offset，行为会与 tb_origin 不同，属于业务变更，需要单独确认。

---

## 4. 不需要进入 L0 的字段（先报告）

以下字段在 tb_origin 中存在，但按原 ORS 行为不需要进入 L0 contract。先报告，评估后再决定：

| 字段 | tb_origin 行为 | 建议 |
|---|---|---|
| `PosDirection` | 不设置；ORS 不看 | 不进 L0；L2 AUTO |
| `DisclosedQnty` | 永远等于 Quantity | 不进 L0；无冰山单 |
| `QuantityFilled` | 新单恒 0；改单被拒 | 不进 L0 OrderRequest |
| `PxType` | 恒 PERUNIT | 不进 L0；price 就是每单位价 |
| `Product` | 设置，但 ORS 不用于交易 | 不进 L0；留 L2/L3 监控 |
| `StrategyID` | 设置；用于 Dashboard/回报归属 | 不进 L0；L2/L3 映射 |
| `OrderID` | Connector 按 exchange 分配 | 不进 L0；L2 分配 orderRef |
| `OrdType=MARKET` | TB 不发；只发 LIMIT | L0 可保留给手工/API，但 TB 路径不用 |
| `IOC/FOK` | TB 不发；只发 DAY/FAK | L0 可保留给手工/API，但 TB 路径不用 |

这些不是“删掉业务逻辑”，而是“不进入 L0 线协议”；L2/L3 仍需保留对应语义。

---

## 5. 已对齐

```text
accountId：业务账户 -> venue 账户映射，001/002 已有
strategyId：L3 归属，不参与路由，001/002 已有
offsetFlag：L0 最终语义，L2 解析，contract/003 已有
不拆单：contract/003/ors 文档已改
Modify：CTP 拒绝，和 tb_origin 不依赖 modify 一致
OrderRef 12 位格式化：新 adapter 已有
```

---

## 6. 仍需确认

1. **L2 AUTO 用账户持仓还是策略持仓？**
   - tb_origin 依赖原 ORS：账户级。
   - 新系统若要策略级，是行为变更，需要单独确认。

2. **平仓整笔放不下今/昨时，保留整笔 OPEN？**
   - 原 ORS 是整笔 OPEN；按“以原代码为准”，应保留。
   - 需要确认新系统不在 L2 改成拆单/拒单。

3. **`Product` / `DisclosedQnty` / `QuantityFilled` / `PxType` 不进入 L0，是否接受？**
   - 这是字段边界，不是业务逻辑删除；L2/L3 保留。

4. **TB ResponseMsg 映射到新 contract 状态，是否由 L2 `ExecutionEventRouter` 统一做？**
   - 建议是；否则 Java TB 会直接依赖新 contract 语义。

---

## 7. 附录：tb_origin 代码位置

```text
新单组包
  main/CommonClient.cpp:950-1006

OrdType/PxType
  main/CommonClient.cpp:1144-1145

OrderID 分配
  hftbase/Connector/include/connector.h:271-277

RequestMsg/ResponseMsg
  hftbase/CommonUtils/include/orderresponse.h:134-154, 438-463

策略净仓更新
  Strategies/ExecutionStrategy.cpp:2062

整笔平仓
  Strategies/ExecutionStrategy.cpp:2437
  Strategies/MMFPassiveStrategy.cpp:112
  Strategies/ExtraStrategy.cpp:604

回报找策略
  main/main.cpp:283-294
```

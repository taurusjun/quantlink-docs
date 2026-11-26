# 002 公司 ORS（China/CTP）与新系统差异

- 状态：DRAFT
- 日期：2026-11-25
- ORS 基准：`/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/ors/China`
- TB 基准：`tb_origin = /Volumes/DevDisk/git/tb_origin/tbsrc`
- 范围：CTP 分支（`_USE_CTP_`）与新系统 L0/L1/L2/L3 设计对照

---

## 1. 结论

`ors/China` 是公司多柜台 ORS 的 CTP/SGIT 适配层。CTP 代码在：

```text
China/src/ORSServer.cpp
```

它的核心业务逻辑与 tb_origin 配套：

```text
账户级 mapContractPos
今仓 -> 昨仓 -> 整笔 OPEN
发单预扣、拒单/撤单释放、开仓成交加仓
单笔、不拆单
```

新系统目前的主要差异：

```text
1. L2 缺少 AUTO 开平推断和账户级预扣/释放账本
2. CTP 持仓查询在新系统有、在 China ORS 没有；需要决定是否保留
3. OrderCrossCheck 在 China ORS 是死代码；新系统是否要 STP 需要决定
4. TIF / 状态时序 / StrategyID 映射仍有差异
```

---

## 2. China/CTP ORS 的实际行为

### 2.1 开平与持仓

`China/src/ORSServer.cpp:488-606`：

```text
BUY:
  qty <= todayShort -> 平今
  qty <= ONShort    -> 平昨
  否则              -> 整笔 OPEN
SELL:
  对称使用 todayLong / ONLong
```

发单时直接扣减：

```text
todayShortPos -= qty
ONShortPos    -= qty
```

### 2.2 持仓来源

`China/src/ORSServer.cpp:145-220`：

```text
构造函数 updatePositionFromFile()
  读 POSITION_FILE 到 mapContractPos

writePositionToFile()
  把 mapContractPos 写回 POSITION_FILE
```

CTP 持仓查询：

```text
ReqQryPosition()  China/src/ORSServer.cpp:1477
  return;   // CTP 下直接返回
```

也就是说，China/CTP **不查柜台持仓**，完全依赖：

```text
position.csv + 本 ORS 自己的订单/成交流
```

登录成功即 `m_connected = true`（`OnRspUserLogin` 1662-1745），不会等持仓查询。

### 2.3 状态与回报

`China/src/ORSServer.cpp`：

```text
OnRspOrderInsert  1999    ErrorID=0 也按拒单
OnRtnOrder        2202    Trade 前不提前 FILLED；ACK 一次；终态移除
OnRtnTrade        2837    更新 Qty/openQty；openQty=0 移除
SendModifyOrder   971     明确拒绝
OrderCrossCheck   1836    函数存在
```

`SendNewOrder()`（607-970）里**没有调用** `OrderCrossCheck`：

```text
只有 ordercrosscheck 计时，没有 OrderCrossCheck(request)
```

### 2.4 TIF

`SendNewOrder` CTP 分支：

```text
MARKET:
  CFFEX/ZCE 的 FOK/IOC/FAK 本地拒绝
  没有 SHFE market 本地拒绝
  FOK/IOC: AnyPrice + IOC + CV + MinVolume=qty
  FAK:     AnyPrice + IOC + AV + MinVolume=1
  DAY:     LimitPrice + 0 + GFD + AV + MinVolume=1

LIMIT:
  CFFEX/ZCE 的 FOK/IOC/FAK 本地拒绝
  FOK/IOC: LimitPrice + price + IOC + CV + MinVolume=qty
  FAK:     LimitPrice + price + IOC + AV + MinVolume=1
  DAY:     LimitPrice + price + GFD + AV + MinVolume=1
```

### 2.5 StrategyID / Product

共享 `hftbase/CommonUtils/include/orderresponse.h` 里有：

```text
RequestMsg.Product
RequestMsg.StrategyID
ResponseMsg.Product
ResponseMsg.StrategyID
```

但 `China/src/ORSServer.cpp` 不使用 `StrategyID`：

```text
不写 response.StrategyID
TB 用 main.cpp 的 OrderIDStrategyMap 按 OrderID 找策略
```

---

## 3. 与 tb_origin 的对应

tb_origin TB：

```text
不发 PosDirection / offset
只发 LIMIT + DAY/FAK
CROSS -> FAK
平仓 qty = abs(m_netpos)，整笔
```

China ORS：

```text
按账户级 mapContractPos 推断开平
单笔、不拆单
整笔放不下 -> 整笔 OPEN
```

两者是配套的：TB 不感知 offset，ORS 用账户持仓推断。

新系统必须保留这条链路，不能要求 TB 传 offset，也不能自己改成拆单。

---

## 4. CTP 持仓查询：新系统是否需要

### 4.1 China ORS 的做法

```text
不查 CTP 持仓
启动读 position.csv
本 ORS 订单/成交增量维护 mapContractPos
写回 position.csv
```

### 4.2 新系统现状

```text
CtpQueryService 查询 CTP 持仓，发布 PositionSnapshot
CtpReconciler 重连后对账
```

### 4.3 判断

**决策：保留 CTP 持仓查询。**  
形式是 L0 `PositionSnapshot` + L2 对账，不是 ORS 本地 `mapContractPos` 的替代品。

原因：

```text
1. 新系统 L2 的 AUTO offset 用账户级持仓；只靠 position.csv/本地成交，
   无法看到手工单、外部系统单、重启前持仓、其他策略持仓。
2. 新系统有重连/epoch/对账；没有柜台持仓，无法确认账户真相。
3. tb_origin 的 squareoff 是整笔净仓；账户持仓不准会直接导致开平方向错误。
4. L2 的预扣/释放账本需要一个权威基线；PositionSnapshot 就是这个基线。
```

但要注意：

```text
1. 昨仓必须用 Position - TodayPosition，不能用 YdPosition。
   （YdPosition 是昨日结转值，平仓后不减少。）
2. CTP 查询有 1 秒限流；启动/重连要重试，查询完成前不能放单。
3. 查询失败时不能静默使用旧 position.csv；应降级/拒绝开仓。
```

结论：

```text
原 China ORS 可以不做 CTP 持仓查询，是因为它依赖外部维护的 position.csv；
新系统不能沿用这个假设，已定保留 CTP 查询。
```

---

## 5. OrderCrossCheck：新系统是否需要

### 5.1 China ORS 的做法

```text
OrderCrossCheck 函数存在（1836）
SendNewOrder 没有调用
= 生产路径没有 STP
```

`quantlink-trading` 也是同样：函数在，调用被去掉。

### 5.2 它解决什么

```text
同一账户、同一合约、方向相反、价格交叉的挂单 -> 拒绝新单
```

它解决的是**自成交/对敲**，不是跨策略吃仓。

### 5.3 新系统是否需要

**决策：不是原业务逻辑的必需项；默认关闭，作为可选风控。**

原因：

```text
1. 原 China ORS 不调用它；生产行为没有 STP。
2. 它会阻止同账户下不同策略的正常对手单，改变业务行为。
3. 它不解决跨策略吃仓；跨策略吃仓要靠策略级可平量/子账本。
4. 自成交是交易所/合规问题，不是开平/持仓正确性问题。
```

如果风控/产品要求 STP：

```text
放 L2 TradingChannel
作用域：account + exchange + instrument
默认 OFF；按 account/channel 开启
命中：拒绝新单
失败：fail closed
```

但不要把它写成“原 ORS 已有、必须保留”的核心逻辑；原代码里它是死代码。

---

## 6. 新系统需要纠正的点

### 6.1 必须补

```text
1. L2 AUTO offset：side + 账户今昨仓 -> 平今/平昨/整笔 OPEN
2. L2 账户级平仓预扣/释放账本
3. CTP PositionSnapshot 用 Position - TodayPosition 算昨仓
4. FAK 映射：IOC + AV + MinVolume=1
5. TB StrategyID/Product/AccountID/OrderID 的 L2 映射
6. TB ResponseMsg 到新 contract 的状态映射
```

### 6.2 已定 / 待定

```text
已定：
1. CTP 持仓查询：保留
2. OrderCrossCheck：默认关闭
3. MARKET：允许
4. 当前只做 SHFE；CFFEX/ZCE 的 FOK/IOC/FAK 暂不实施

待定：
1. 账户级 offset（原逻辑）还是策略级 offset（新能力）
2. 撤单 CancelState::REQUESTED 是否暴露给策略
```

---

## 7. 已对齐

```text
单笔、不拆单
整笔放不下 -> 整笔 OPEN
Modify 拒绝
OrderRef 12 位
L0 最终 offsetFlag
accountId 业务账户 -> venue 账户映射
strategyId 不进 L0
```

---

## 8. 附录：China/CTP 代码位置

```text
SetCombOffsetFlag    China/src/ORSServer.cpp:488
SendNewOrder         China/src/ORSServer.cpp:607
SendModifyOrder      China/src/ORSServer.cpp:971
SendCancelOrder      China/src/ORSServer.cpp:979
updatePosition       China/src/ORSServer.cpp:1186
ReqQryPosition       China/src/ORSServer.cpp:1477
OnRspOrderInsert     China/src/ORSServer.cpp:1999
OnRtnOrder           China/src/ORSServer.cpp:2202
OrderCrossCheck      China/src/ORSServer.cpp:1836
OnRtnTrade           China/src/ORSServer.cpp:2837
```

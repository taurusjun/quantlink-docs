# 003 146 ORS 与新系统差异

- 状态：DRAFT
- 日期：2026-11-25
- 范围：146 CTP ORS 与新系统 `quantlink-venue-contract` / `quantlink-fasttrade` / `quantlink-ors` 的业务逻辑对照
- 不包含：`quantlink-fin`（现有系统）、146 SGIT 分支、非 CTP venue

---

## 1. 结论

新系统不是只差 STP 或拆单。146 CTP ORS 的业务逻辑中，新系统目前主要缺四类：

```text
1. 平仓发单即预扣、拒单/撤单释放、成交加减仓的账本
2. RMS 检查和合约元数据
3. 报单类型 / TIF / 交易所拒绝规则
4. 订单 / 成交状态时序
```

本文原则：

```text
业务逻辑以 146 原代码为准
架构差异单独列，不混同为 bug
146 实现层问题不照搬
```

本轮只记录差异，不改代码。

---

## 2. 对照口径

### 2.1 146

```text
/Volumes/DevDisk/146/3/dalong/infrastructure/China/src/ORSServer.cpp
/Volumes/DevDisk/146/3/dalong/infrastructure/China/include/ORSServer.h
/Volumes/DevDisk/146/3/dalong/infrastructure/RMS_NEW
/Volumes/DevDisk/146/3/dalong/infrastructure/China/src/MdSpi.cpp
```

只看 `_USE_CTP_` 分支。

### 2.2 新系统

```text
quantlink-venue-contract/docs/contract-fields.md
quantlink-fasttrade/docs/v2/001-system-overview.md
quantlink-fasttrade/docs/v2/002-system-layers.md
quantlink-fasttrade/docs/v2/003-l0-ors-venue.md
quantlink-fasttrade/docs/v2/004-l1-ipc-transport.md
quantlink-ors/docs/2026-11-24-l0-ors-ctp-design.md
quantlink-ors/ors/ctp/src/CtpAdapter.cpp
quantlink-ors/ors/ctp/src/ContractRuntime.cpp
quantlink-ors/ors/ctp/src/CtpReconciler.cpp
```

`quantlink-fin` 是现有系统，不作为新系统设计依据。

---

# 3. P0：必须按 146 纠正

## 3.1 平仓预扣 / 释放 / 成交账本

### 146 行为

```text
新单平仓:
  SetCombOffsetFlag 发单时 todayShort/ONShort -= qty
成交:
  OPEN  -> todayLong/Short += trade.qty
  CLOSE -> 不重复加（发单已扣）
拒单/ORDER_ERROR:
  today/ON += ordinfo.Qty
撤单确认:
  today/ON += ordinfo.openQty（剩余未成交）
部分成交后撤单:
  openQty 已按成交递减，只释放剩余
全部成交:
  openQty == 0，订单从 map 移除
```

### 146 位置

```text
SetCombOffsetFlag       ORSServer.cpp:404-489
updatePosition          ORSServer.cpp:1070-1171
OnRtnTrade              ORSServer.cpp:2505-2600
```

关键代码：

```text
todayShortPos -= request->Quantity        // 424-425
ONShortPos    -= request->Quantity        // 434-435
ORDER_ERROR   -> += ordinfo.Qty           // 1090-1123
CANCEL_CONFIRM-> += ordinfo.openQty       // 1126-1150
TRADE OPEN    -> += resp->Quantity        // 1153-1170
OnRtnTrade: ordinfo.Qty -= pTrade->Volume // 2560-2565
```

### 新系统现状

- `002-system-layers.md` 的 L2 只写了 `OrderRegistry` / `FillLedger` / STP，没有平仓可用量预扣和释放。
- `003-l0-ors-venue.md` / contract 有 `PositionSnapshot`，但那是账户快照，不是下单预扣账本。
- `CtpAdapter` 只维护订单状态，不维护可平量。

### 影响

```text
两笔并发平仓单可以同时通过可平校验 -> 超平
拒单/撤单后可用量不恢复 -> 后续平仓被误拒
部分成交后撤单按全量释放 -> 可用量偏大
开仓成交不加仓 -> 后续平仓看不到新仓
```

### 必须补的接口

```text
reserve(account, exchange, instrument, side, bucket, qty)
release_full(order)
release_remaining(order)
consume_on_fill(order, qty)
reconcile_with_position_snapshot()
```

### 验收

- 并发两笔平仓，第二笔看到第一笔预扣后的可用量。
- 拒单释放全量。
- 部分成交后撤单只释放剩余。
- 平仓成交不重复加仓。
- 开仓成交逐笔加仓。
- 重连/快照对账后账本收敛。

---

## 3.2 报单类型 / TIF / 交易所拒绝

### 146 CTP 映射

```text
MARKET:
  SHFE -> 拒绝 "No market orders in SHFE"
  FOK/IOC + CFFEX/ZCE -> 拒绝
  FAK    + CFFEX/ZCE -> 拒绝

  FOK/IOC:
    OrderPriceType = AnyPrice
    LimitPrice     = 0
    TimeCondition  = IOC
    VolumeCondition= CV
    MinVolume      = qty

  FAK:
    OrderPriceType = AnyPrice
    LimitPrice     = 0
    TimeCondition  = IOC
    VolumeCondition= AV
    MinVolume      = 1

  DAY:
    OrderPriceType = LimitPrice
    LimitPrice     = 0
    TimeCondition  = GFD
    VolumeCondition= AV
    MinVolume      = 1

LIMIT:
  FOK/IOC + CFFEX/ZCE -> 拒绝
  FAK    + CFFEX/ZCE -> 拒绝

  FOK/IOC:
    OrderPriceType = LimitPrice
    LimitPrice     = price
    TimeCondition  = IOC
    VolumeCondition= CV
    MinVolume      = qty

  FAK:
    OrderPriceType = LimitPrice
    LimitPrice     = price
    TimeCondition  = IOC
    VolumeCondition= AV
    MinVolume      = 1

  DAY:
    OrderPriceType = LimitPrice
    LimitPrice     = price
    TimeCondition  = GFD
    VolumeCondition= AV
    MinVolume      = 1
```

### 146 位置

```text
SendNewOrder  ORSServer.cpp:537-700
```

### 新系统现状

contract 表：

```text
DAY  GFD + AV
IOC  IOC + AV
FAK  IOC + AV
FOK  IOC + CV
```

`CtpAdapter::fillInsert`：

```text
IOC -> IOC + AV
FAK -> IOC + CV
FOK -> IOC + CV + MinVolume=qty
DAY -> GFD + AV
MARKET -> AnyPrice，LimitPrice=request.price
没有 SHFE market / CFFEX-ZCE FAK-FOK-IOC 的预拒绝
```

### 差异

```text
146 IOC = CV + MinVolume=qty；新 contract/adapter = AV
146 FAK = AV + MinVolume=1；新 adapter = CV
146 MARKET DAY = LimitPrice + LimitPrice=0 + GFD + AV + MinVolume=1；
新 adapter = AnyPrice + request.price + GFD + AV
146 预拒绝 SHFE market、CFFEX/ZCE FAK/FOK/IOC；新 adapter 不预拒绝
146 LIMIT DAY 显式 MinVolume=1；新 adapter 默认 0
```

### 必须纠正

- contract `timeInForce` 表按 146 改。
- `CtpAdapter::fillInsert` 按 146 改。
- 增加交易所级预拒绝。
- `CtpAdapterTest` 增加 146 对照用例。

---

## 3.3 CTP 平昨 flag

### 146 行为

```text
SHFE today -> THOST_FTDC_OF_CloseToday
非 SHFE today -> THOST_FTDC_OF_Close
ON bucket -> THOST_FTDC_OF_Close
```

146 CTP 分支从未使用 `THOST_FTDC_OF_CloseYesterday`。

### 146 位置

```text
SetCombOffsetFlag  ORSServer.cpp:404-489
```

### 新系统现状

```text
contract: CLOSE = 平昨；CLOSE_YESTERDAY = 平昨
CtpAdapter::ctpOffset: CloseYesterday -> THOST_FTDC_OF_CloseYesterday
```

如果 L2 对 SHFE/INE 的昨仓返回 `CLOSE_YESTERDAY`，新系统会发 `CloseYesterday`，与 146 不同。

### 处理建议

两条路二选一：

```text
A. 严格 146：L2 对 CTP 昨仓返回 CLOSE；CtpAdapter 收到 CloseYesterday 时按需要拒绝或映射为 Close。
B. 保留 CLOSE_YESTERDAY：确认 CTP/交易所支持且业务接受与 146 不同的 wire flag。
```

---

## 3.4 RMS 与合约元数据

### 146 行为

`SendNewOrder` 第一道：

```text
if (!rms.executeNewOrderChecks(*request)) return;
```

RMS 规则包括（配置决定启用哪些）：

```text
symbol 允许/禁止
单笔数量/金额
单 ticker 限额
下单频率
每日/每笔订单数
ticker/account stop loss
firm net position
firm quantity
X% away from LTP
cancel confirm count
```

合约元数据：

```text
OnRspQryInstrument 查全市场
m_symbolMap 保存 VolumeMultiple/tick/min/max/IsTrading/expiry/exchange
rms.setExchangeInstrDefinitionMap(m_symbolMap, ...)
```

### 146 位置

```text
SendNewOrder:513
RMS_NEW/include/rmschecks.h
RMS_NEW/src/rmschecks.cpp:271
OnRspQryInstrument:1295-1367
```

### 新系统现状

```text
003-l0-ors-venue.md：L0 明确不包含账户级 RMS
002-system-layers.md：账户级风控如需要，单独接入
contract 有 Instrument schema，但 ORS 没有发布路径
L2 没有 tick/lot/min/max/IsTrading 的明确来源
```

### 影响

- 146 的第一道业务门禁缺失。
- 新 L2 无法完整复刻 146 的单笔限额、频率、每日单数、stop loss、X% LTP 等检查。
- 没有 tick/lot 元数据，L2 无法做价格/数量合法性校验。

### 待决策

```text
1. 哪些 RMS 规则必须保留？
2. 放 L2 进程内，还是独立 RMS？
3. 中国区 RMS 配置文件的规则集能否提供？
4. 合约元数据从 ContractCatalog、ORS Instrument 消息，还是其他来源？
```

如果某些规则认为不需要，必须逐条列出并评估，不能默认丢掉。

---

## 3.5 OnRspOrderInsert ErrorID=0

### 146 行为

```text
OnRspOrderInsert 对 NEWORDER 一律按 ORDER_ERROR 处理
即使 pRspInfo->ErrorID == 0 也处理
```

146 注释：

```text
// Changed since error code 0 is also valid in this case
```

### 146 位置

```text
OnRspOrderInsert  ORSServer.cpp:1713-1771
```

### 新系统现状

`CtpAdapter::onInsertRejected`：

```text
if (info->ErrorID == 0) {
  return;  // accepted: nothing to add to the NEW already published
}
```

### 影响

CTP 在 ErrorID=0 的 `OnRspOrderInsert` 场景下，新系统可能把订单留在 NEW，永远不会进入 REJECTED/终态。

### 必须纠正

对 NEWORDER 的 `OnRspOrderInsert` 一律按拒单处理，并释放预扣；增加 ErrorID=0 测试。

---

## 3.6 订单 / 成交状态时序

### 146 行为

```text
不发本地 NEW
Accepted + NoTradeQueueing/PartTradedQueueing:
  只发一次 NEW_ORDER_CONFIRM（orderSent 标志）
AllTraded:
  不先发 FILLED
  等 OnRtnTrade
OnRtnTrade:
  TRADE_CONFIRM
  ordinfo.Qty -= Volume
  ordinfo.openQty = ordinfo.Qty
  openQty == 0 -> RemoveFromMap
Canceled:
  CANCEL_ORDER_CONFIRM
  response.Quantity = VolumeTotal（剩余）
  ordinfo.Qty -= VolumeTotal
  Qty == 0 -> RemoveFromMap
InsertRejected:
  ORDER_ERROR
  RemoveFromMap
```

### 146 位置

```text
OnRtnOrder   ORSServer.cpp:1906-2101
OnRtnTrade   ORSServer.cpp:2505-2600
OnRspOrderInsert / OnErrRtnOrderInsert  1713-1889
```

### 新系统现状

`CtpAdapter`：

```text
onOrderRequest 成功后立即发 NEW
每次 OnRtnOrder 都发 ACK/PARTIAL/FILLED
AllTraded 先发 FILLED，Trade 可能后到
onRtnTrade 不更新 orders_ 的 filledQty
终态订单不移除
```

### 影响

- 策略可能在 Trade 前看到 FILLED。
- 策略可能收到重复 ACK/PARTIAL。
- 订单状态和成交账本可能短暂不一致。

### 必须定义

```text
1. NEW 是否只作为本地状态，策略不得当 ACK。
2. ACK 是否只发一次。
3. FILLED 必须与 Trade 原子发布，或 Trade 先于 FILLED。
4. filledQty/remainingQty 必须在 Trade 上更新。
5. 终态订单按 146 移除，或定义归档/保留策略。
```

---

## 3.7 STP 顺序

### 146 顺序

```text
RMS -> STP -> SetCombOffsetFlag（预扣）-> ReqOrderInsert
```

### 146 位置

```text
SendNewOrder:513 / 518 / 804
```

### 新系统现状

`002-system-layers.md` 已加入 STP，但只写了“发 COMMAND 前”，没写和 RMS、offset、预扣的顺序。

### 必须补

```text
1. RMS（如果启用）
2. STP
3. offset 解析
4. 平仓预扣
5. orderRef / OrderRegistry
6. 发布 COMMAND
```

市价单规则也要明确：146 用价格 0 判交叉；新系统应明确市价单与反向 open 单无条件交叉。

---

# 4. P1：需要确认的架构差异

这些不是简单补逻辑，而是新系统主动改变的行为。

## 4.1 持仓真相

```text
146：只用自己的订单/成交流维护账户持仓；启动为空；不查持仓；
     不知道手工/外部仓位；没有 strategyId。
新系统：L0 发布 venue PositionSnapshot；L2/L3 还有策略持仓。
```

影响：146 对未知空头会开仓；新系统可能平仓。必须定 L2 offset 用哪份持仓：

```text
A. 146 式本地订单/成交账本（严格 146）
B. venue PositionSnapshot（新能力）
C. 两者结合：本地账本做预扣，快照做对账
```

## 4.2 PosDirection / AUTO

```text
146：PosDirection 实际不填、不看；BUY/SELL + 账户今昨仓推断开平。
新系统：允许显式 OPEN/CLOSE/CLOSE_TODAY/CLOSE_YESTERDAY。
```

建议：策略路径默认 `AUTO`（146 行为）；显式 offset 只给手工/高级。否则策略行为和 146 不一致。

## 4.3 重连

```text
146：重新登录、结算确认、查合约；不查订单/成交/持仓；
     无 epoch；登录失败 exit(1)。
新系统：LOST、epoch++、订单/成交/持仓对账、READY 门禁。
```

这是新增能力，不是 146 逻辑。建议保留，但文档必须标注“与 146 不同”。

## 4.4 行情

```text
146：ORS 自己登录 MD、订阅合约、输出 5 档。
新系统：MD 独立，20 档补零。
```

建议保留新架构；确认这是新需求，不是 146 行为。

## 4.5 撤单中间态

```text
146：撤单发送成功后不立即回响应；终态靠 OnRtnOrder / OnErrRtnOrderAction。
新系统：CtpAdapter 发 CancelState::REQUESTED。
```

需要确认策略是否能处理新增中间态。如果严格 146，可以不把 REQUESTED 暴露给策略，只内部记录。

## 4.6 错误码

```text
146：RejectOrder 对所有本地拒单都用 ERROR_CODE_CROSS_REJECT；
     RMS 另有 RMS_REJECT / ORDERS_PER_DAY_LIMIT_REJECT。
新系统：REJECTED + reason/errorCode。
```

建议保留新语义，但做映射，避免 146 客户端依赖旧码。

## 4.7 终态订单保留

```text
146：成交/撤单/拒单后从 m_ordLocalMap / m_ordExchMap 移除。
新系统：CtpAdapter 的 orders_ 终态不删除。
```

需要定：保留用于对账/审计，还是按 146 移除。保留要有容量/清理策略。

## 4.8 OrderRef

```text
146 CTP：OnRspUserLogin 用 MaxOrderRef 初始化；
         发单前 sprintf("%012d") 并自增；
         发单失败不回退。
新系统：L2 分配 orderRef。
```

需要保证重连后不与柜台已有 OrderRef 冲突；定义 seed/epoch/分配规则。

---

# 5. P2：146 实现层问题，不建议照搬

这些是代码问题，不是业务规则。新系统不要复制：

```text
1. OrderCrossCheck 命中时 return true 前没有 unlock（1557-1583）。
2. PushUpdate 用 m_ordLocalMap[...] 会插入默认 OrderInfo；
   RejectOrder 的 ORS_REJECT 可能让 updatePosition 解引用 mapContractPos.end()。
3. SetCombOffsetFlag 在 ReqOrderInsert 失败后没有恢复预扣仓位。
4. m_ordLocalMap[OrderID] 对重复 OrderID 直接覆盖。
5. OrderCrossCheck 只比 symbol，不校验 exchange。
6. OnRtnTrade 找不到 OrderRef 时 ILOG(FATAL) 后直接 return。
7. iNextOrderRef 发单失败不回退。
8. 登录失败 exit(1)。
```

新系统应使用：

```text
RAII 锁
显式 reservation release
OrderRegistry 唯一键校验
未知回报进入 pending/reconciliation，不 FATAL
可重连的会话状态机
```

---

# 6. 已对齐

```text
Modify：146 SendModifyOrder 明确拒绝；新系统也拒绝 CTP Modify。
不拆单、整笔开平：已按产品口径写入 contract 与 fasttrade/ors 文档。
STP：已加入 L2 设计，账户+交易所+合约，拒新单。
OrderRef 12 位格式化：新 adapter 已有。
撤单本地查找/终态拒绝：大体一致。
146 offset 优先级：今仓 -> 昨仓 -> 整笔 OPEN；新文档已对齐。
```

---

# 7. 待决策

```text
1. L2 的 offset/预扣用哪份持仓？
   A. 146 式本地订单/成交账本
   B. venue PositionSnapshot
   C. 两者结合

2. RMS 保留哪些规则？需要中国区 RMS 配置或产品清单。

3. 订单状态时序：
   严格 146（Trade 前不发 FILLED、ACK 只发一次）
   还是保留新系统 NEW/ACK/FILLED 语义？

4. 重连和 MD：
   保留新架构，还是按 146 复制？
   建议保留新架构，但文档标注差异。

5. PosDirection：
   策略路径是否统一走 AUTO（146 行为），显式 offset 只给手工？

6. 平昨：
   CTP 是否发 CLOSE，还是允许 CLOSE_YESTERDAY？
```

---

# 8. 附录：146 CTP 函数地图

```text
Login / OnRspUserLogin / OnRspSettlementInfoConfirm
  ORSServer.cpp:272-344, 1418-1555

SetCombOffsetFlag
  ORSServer.cpp:378-490

SendNewOrder
  ORSServer.cpp:497-872

SendModifyOrder
  ORSServer.cpp:873-881

SendCancelOrder
  ORSServer.cpp:882-990

PushUpdate / updatePosition / RejectOrder
  ORSServer.cpp:997-1200

OnRspQryInstrument
  ORSServer.cpp:1295-1367

OrderCrossCheck
  ORSServer.cpp:1557-1583

OnRspOrderAction / OnRspOrderInsert
  ORSServer.cpp:1701-1771

OnErrRtnOrderAction / OnErrRtnOrderInsert
  ORSServer.cpp:1773-1889

OnRtnOrder
  ORSServer.cpp:1906-2101

OnRtnTrade
  ORSServer.cpp:2505-2600

RMS
  RMS_NEW/include/rmschecks.h
  RMS_NEW/src/rmschecks.cpp:271

MD
  China/src/MdSpi.cpp:131-235
```

---

# 9. 备注

- 本文只记录差异，不代表已经修改新系统代码。
- `quantlink-fin` 是现有系统，不作为新系统设计依据。
- 146 业务规则以原代码为准；以上 P2 是实现层问题，不应被当作业务规则照搬。

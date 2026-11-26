# Venue Contract Field Dictionary

- 日期：2026-11-23
- 范围：当前 canonical contract
- 原则：只记录现有字段，不记录历史变更

## 0. Messages

```text
Instrument
MarketData
OrderRequest
ModifyRequest
CancelRequest
OrderUpdate
Trade
PositionSnapshot
AccountSnapshot
VenueSession
```

## 1. Common Types

| 类型 | 长度/编码 | 含义 |
|---|---|---|
| `InstrumentId` | char[32] ASCII | 合约代码，例如 `ag2612`、`au2612C920` |
| `Exchange` | char[8] ASCII | 交易所代码：`SHFE`、`DCE`、`CZCE`、`CFFEX`、`INE`、`GFEX` |
| `AccountId` | char[16] ASCII | venue 账户 |
| `VenueId` | char[32] ASCII | 接入点/柜台标识，例如 `SIMVENUE`、`SIMNOW` |
| `OrsId` | char[32] ASCII | ORS 实例标识，例如 `ors-simvenue-001` |
| `RequestId` | char[64] ASCII | 请求唯一键 |
| `OrderId` | char[32] ASCII | 订单标识字符串 |
| `TradeId` | char[32] ASCII | 成交标识 |
| `TradingDay` | char[8] ASCII | 交易日，格式 `yyyyMMdd` |
| `SnapshotId` | char[64] ASCII | 快照批次 ID |
| `Environment` | char[16] ASCII | `SHADOW` / `LIVE` / `REPLAY` |
| `Timestamp` | uint64 | 纳秒 epoch |

## 2. Shared Field Semantics

SBE message 之间没有继承关系。  
下面这些字段只是多个 message 复用的**同名语义**，每个 message 都显式声明自己需要的字段。

contract 面向 L0 venue：订单身份只有 `orderRef`，消息不携带策略归因。

| 字段 | 含义 |
|---|---|
| `orderRef` | L0 订单主键；下单方分配，贯穿 OrderRequest/ModifyRequest/CancelRequest/OrderUpdate/Trade；取值 1..999999999999 |
| `exchangeOrderId` | 柜台订单号；接受前为空 |
| `requestId` | 请求唯一键；幂等、审计、日志关联 |
| `accountId` | venue 账户 |
| `venueId` | 柜台/接入点 |
| `orsId` | ORS 实例 |
| `instrumentId` | 合约 |
| `exchange` | 交易所代码 |
| `sourceSessionId` | 行情/执行源 session；适配器重连/重启后变化 |
| `sourcePublicationEpoch` | 发布代次；拒绝旧 publication 的迟到消息 |
| `seq` | 序号；按 scope 单调递增 |
| `exchangeTimestamp` | 交易所/venue 事件时间；缺失时为 0，不用本地时间替代 |
| `ingestTimestamp` | 适配器接收时间；用于延迟和本地排序 |
| `snapshotTimestamp` | 持仓/账户/会话快照生成时间 |
| `environment` | 运行环境 |
| `snapshotId` | 快照批次 ID |
| `staleAfterMs` | 快照过期阈值 |

### Identity

```text
exchange = SHFE            交易所代码
venueId  = SIMVENUE        接入点/柜台
orsId    = ors-simvenue-001
```

三者语义不同。`venueId` 不是账户；多个账户可以共用一个 `venueId`。
成交幂等键必须包含 `accountId`。

### Environment

```text
一条 stream/session 只允许一个 environment
environment 不一致 -> AccessRuntime 拒绝
```

如果无法保证一条流只属于一个 environment，`seq` 的 scope 必须包含 `environment`。

### Session and sequence

```text
sourceSessionId
  = 适配器/行情源的一次会话实例
  = 重连、重启、重新登录后变化

sourcePublicationEpoch
  = 发布代次
  = 同一个 session 内重启 publication 时递增
```

`seq` 只在同一 `sourceSessionId + sourcePublicationEpoch` 内比较：

```text
MarketData: 每个 (venueId, exchange, instrumentId) 一条序列
OrderUpdate/Trade: 每个 ORS/账户一条 execution stream，两者共用同一个 sequence
```

`OrderUpdate` 和 `Trade` 必须共用一条 execution stream，不能按消息类型拆成两条流。
消费方按 SBE `templateId` 分发；未知 `orderRef` 必须先缓存，不能静默丢弃。

### Snapshot fields

```text
snapshotId    这次快照的批次 ID
staleAfterMs  超过多久算过期
```

### Field presence

| 字段 | 出现在 |
|---|---|
| `orderRef` | OrderRequest, ModifyRequest, CancelRequest, OrderUpdate, Trade |
| `exchangeOrderId` | OrderUpdate, Trade |
| `requestId` | OrderRequest, ModifyRequest, CancelRequest, OrderUpdate, Trade |
| `accountId` | OrderRequest, ModifyRequest, CancelRequest, OrderUpdate, Trade, PositionSnapshot, AccountSnapshot, VenueSession |
| `venueId` | MarketData, OrderRequest, ModifyRequest, CancelRequest, OrderUpdate, Trade, PositionSnapshot, AccountSnapshot, VenueSession |
| `orsId` | VenueSession |
| `instrumentId` | Instrument, MarketData, OrderRequest, ModifyRequest, CancelRequest, OrderUpdate, Trade, PositionSnapshot |
| `exchange` | Instrument, MarketData, OrderRequest, ModifyRequest, CancelRequest, OrderUpdate, Trade, PositionSnapshot |
| `sourceSessionId` / `sourcePublicationEpoch` | MarketData, OrderRequest, ModifyRequest, CancelRequest, OrderUpdate, Trade, VenueSession |
| `seq` | MarketData；OrderUpdate/Trade 叫 `sequence`；VenueSession 用 `lastSeqByStream` |
| `exchangeTimestamp` | MarketData, OrderUpdate, Trade |
| `ingestTimestamp` | MarketData, OrderUpdate, Trade |
| `snapshotTimestamp` | PositionSnapshot, AccountSnapshot, VenueSession |
| `environment` | MarketData, OrderRequest, ModifyRequest, CancelRequest, OrderUpdate, Trade, PositionSnapshot, AccountSnapshot, VenueSession |
| `snapshotId` | PositionSnapshot, AccountSnapshot |
| `staleAfterMs` | PositionSnapshot, AccountSnapshot |
| `tradingDay` | OrderUpdate, Trade, PositionSnapshot, AccountSnapshot, VenueSession |

## 3. Instrument

| 字段 | 含义 |
|---|---|
| `instrumentId` | 合约代码 |
| `exchange` | 交易所代码 |
| `instrumentType` | `FUTURE` / `OPTION` |
| `product` | 品种，例如 `ag`、`au` |
| `underlyingId` | 期权标的；期货留空 |
| `expiryDate` | 到期日 `uint32 yyyyMMdd`；OPTION 必须 > 0，FUTURE 必须为 0 |
| `strike` | 行权价；期货为 0 |
| `callPut` | `CALL` / `PUT` / `NONE`；期货显式 `NONE` |
| `multiplier` | 合约乘数 |
| `tickSize` | 最小变动价位 |
| `lotSize` | 每手数量 |

校验：

```text
OPTION: expiryDate > 0，且是有效 yyyyMMdd
FUTURE: expiryDate == 0
TradingDay: char[8] ASCII yyyyMMdd
```

`expiryDate` 与 `TradingDay` 语义不同，不强行统一类型。

## 4. MarketData（Quote Snapshot）

`MarketData` 本身就是 **quote snapshot**，不是增量 tick，也没有独立的 `QuoteSnapshot` 消息。

每次 `MarketData` 事件都表示当前时刻的完整行情快照：

```text
Bids[] / Asks[]          完整 20 档盘口
lastPrice / lastTrade*   最新成交
volume / turnover        累计成交量/成交额
openInterest             持仓量
```

不存在：

```text
QuoteSnapshot 单独消息
TradeTick 单独消息
```

盘口和最新成交合并在同一条 `MarketData` 中，避免多消息之间的 seq/一致性/消费复杂度。

| 字段 | 含义 |
|---|---|
| `instrumentId` | 合约 |
| `venueId` | 行情来源接入点 |
| `exchange` | 交易所 |
| `environment` | 环境 |
| `exchangeTimestamp` | 交易所/venue 行情事件时间 |
| `ingestTimestamp` | 适配器接收时间 |
| `lastPrice` | 最新成交价 |
| `lastTradeQty` | 最新一笔成交量 |
| `lastTradeTime` | 最新一笔成交时间 |
| `volume` | 累计成交量 |
| `turnover` | 累计成交金额 |
| `openInterest` | 持仓量 |
| `synthetic` | 是否合成行情 |
| `sourceSessionId` | 行情 session |
| `sourcePublicationEpoch` | 发布代次 |
| `seq` | 该合约行情序号 |
| `Bids[]` | `price` + `qty`，固定 20 档；不足补零 |
| `Asks[]` | `price` + `qty`，固定 20 档；不足补零 |

`exchangeTimestamp` 是交易所/venue 事件时间；缺失时填 0，并标记 stale。  
`ingestTimestamp` 是适配器接收时间，只用于本地延迟/排序，不参与交易所时间比较。

## 5. OrderRequest

| 字段 | 含义 |
|---|---|
| `orderRef` | 订单业务主键 |
| `instrumentId` / `exchange` | 合约/交易所 |
| `side` | `BUY` / `SELL` |
| `offsetFlag` | `OPEN` / `CLOSE` / `CLOSE_TODAY` / `CLOSE_YESTERDAY` |
| `orderType` | `LIMIT` / `MARKET` |
| `timeInForce` | 委托有效期：`DAY` / `FAK` / `FOK` / `IOC` |
| `price` / `qty` | 价格/数量 |
| `accountId` | 账户 |
| `venueId` | 目标接入点 |
| `requestId` | 幂等键 |
| `environment` | 环境 |
| `sourceSessionId` / `sourcePublicationEpoch` | 发布上下文 |

`offsetFlag` 是**最终开平语义**。

```text
SHFE / INE:
  CLOSE            平昨
  CLOSE_TODAY      平今
  CLOSE_YESTERDAY  平昨
非 SHFE / INE:
  CLOSE            唯一合法平仓写法
  CLOSE_TODAY / CLOSE_YESTERDAY  非法
```

L0 只接收最终 `offsetFlag`；不拆分、不改写、不按交易所猜。  
ModifyRequest 不得改变 `offsetFlag`。

`timeInForce` 的抽象语义：

| `timeInForce` | 行为 |
|---|---|
| `DAY` | 当日有效，剩余继续挂单 |
| `IOC` | 立即成交，剩余撤销 |
| `FAK` | 立即成交，剩余撤销 |
| `FOK` | 全部立即成交，否则全撤 |

## 6. ModifyRequest

改单请求，与 `OrderRequest` 共用 order request stream；`orderRef` 指向已存在的订单。

| 字段 | 含义 |
|---|---|
| `orderRef` | 要修改的订单 |
| `instrumentId` / `exchange` | 合约/交易所 |
| `side` / `offsetFlag` | 委托方向/开平方向；改单不得改变 |
| `orderType` / `timeInForce` | 改单后的委托类型/有效期 |
| `price` / `qty` | 改单后的价格/总数量 |
| `filledQty` | 该订单已成交数量，供 venue 校验；`0 <= filledQty <= qty` |
| `disclosedQty` | 改单后显示数量；`0 <= disclosedQty <= qty` |
| `accountId` | 账户 |
| `venueId` | 目标接入点 |
| `requestId` | 改单幂等键 |
| `environment` | 环境 |
| `sourceSessionId` / `sourcePublicationEpoch` | 发布上下文 |

校验：

```text
orderRef > 0
qty > 0，0 <= filledQty <= qty，0 <= disclosedQty <= qty
订单不存在或已终态 -> 返回 rejected OrderUpdate，不得改错订单
```

## 7. CancelRequest

| 字段 | 含义 |
|---|---|
| `orderRef` | 要撤的订单 |
| `instrumentId` / `accountId` | 合约/账户 |
| `requestId` | 撤单幂等键 |
| `venueId` / `exchange` | 路由 |
| `environment` | 环境 |
| `sourceSessionId` / `sourcePublicationEpoch` | 发布上下文 |

## 8. OrderUpdate

| 字段 | 含义 |
|---|---|
| `orderRef` | 订单主键 |
| `exchangeOrderId` | 柜台订单号 |
| `status` | `NEW` / `ACK` / `PARTIAL` / `FILLED` / `CANCELED` / `REJECTED` |
| `cancelState` | `NONE` / `REQUESTED` / `REJECTED`；撤单中间态 |
| `filledQty` | 累计成交 |
| `remainingQty` | 剩余数量 |
| `avgPrice` | 成交均价 |
| `reason` | 拒单/失败原因 |
| `errorCode` | 柜台错误码；0 表示无错误；`1001` 是 contract 定义的 unknown order |
| `tradingDay` | 交易日 |
| `exchangeTimestamp` | 交易所/venue 事件时间 |
| `ingestTimestamp` | 适配器接收时间 |
| `requestId` | 原始请求关联 |
| `sequence` | execution stream/session/epoch 内的单调序号 |
| `side` | 委托方向 |
| `offsetFlag` | 开平方向 |
| `orderQty` | 原始委托数量 |
| `price` | 委托价 |
| `accountId` | 账户 |
| `venueId` / `exchange` | 路由 |
| `environment` | 环境 |
| `sourceSessionId` / `sourcePublicationEpoch` | 发布上下文 |

`sequence` 由适配器在 execution stream 上分配；同一 session/epoch 内单调。  
它用于去重和 stream gap，不承诺 per-order gap。

`status`：

```text
NEW       本地已创建/已发布，尚未收到柜台确认
ACK       柜台已接受，订单在工作
PARTIAL   部分成交，订单仍在工作
FILLED    全部成交，终态
CANCELED  已撤，终态
REJECTED  新单被拒，终态
```

`cancelState`：

```text
NONE       没有撤单请求
REQUESTED  已发撤单，等待柜台终态
REJECTED   撤单被拒，原订单仍按 status 工作
```

`cancelState=REJECTED` 时，`status` 不能是 `CANCELED`；订单仍在工作。

## 9. Trade

| 字段 | 含义 |
|---|---|
| `tradeId` | 成交 ID；必须非空；唯一键 `(venueId, accountId, tradingDay, tradeId)` |
| `orderRef` | 所属订单 |
| `exchangeOrderId` | 柜台订单号 |
| `sequence` | execution stream/session/epoch 内的单调序号 |
| `instrumentId` | 合约 |
| `side` | 成交方向 |
| `offsetFlag` | 开平方向 |
| `price` / `qty` | 成交价/量 |
| `exchangeTimestamp` | 交易所/venue 成交事件时间 |
| `ingestTimestamp` | 适配器接收时间 |
| `tradingDay` | 交易日 |
| `fee` | 手续费 |
| `feeKnown` | 手续费是否已知 |
| `requestId` | 原始请求关联 |
| `accountId` | 账户 |
| `venueId` / `exchange` | 路由 |
| `environment` | 环境 |
| `sourceSessionId` / `sourcePublicationEpoch` | 发布上下文 |

校验：

```text
tradeId 必须非空
```

## 10. PositionSnapshot

| 字段 | 含义 |
|---|---|
| `accountId` / `instrumentId` | 账户/合约 |
| `longQty` / `shortQty` | 多/空总持仓 |
| `todayLong` / `todayShort` | 今仓 |
| `yesterdayLong` / `yesterdayShort` | 昨仓 |
| `avgPrice` | 总均价 |
| `longAvgPrice` / `shortAvgPrice` | 多/空均价 |
| `settlementPrice` | 结算价 |
| `exchange` / `venueId` | 交易所/接入点 |
| `environment` | 环境 |
| `tradingDay` | 交易日 |
| `snapshotId` / `source` | 快照批次/来源 |
| `staleAfterMs` | 过期阈值 |
| `snapshotTimestamp` | 快照生成时间 |

同一 `snapshotId` 的持仓行必须使用同一个 `tradingDay` 和 `snapshotTimestamp`。
消费方在用持仓做风险/对冲前，必须按 `staleAfterMs` 拒绝过期快照。

## 11. AccountSnapshot

| 字段 | 含义 |
|---|---|
| `accountId` | 账户 |
| `balance` | 期货结算准备金/动态权益 |
| `available` | 可用资金 |
| `margin` | 占用保证金 |
| `frozenMargin` | 冻结保证金 |
| `commission` | 手续费 |
| `closeProfit` | 平仓盈亏 |
| `positionProfit` | 持仓盈亏 |
| `deposit` / `withdraw` | 入金/出金 |
| `venueId` | 接入点 |
| `environment` | 环境 |
| `snapshotId` / `source` | 快照批次/来源 |
| `tradingDay` | 交易日 |
| `staleAfterMs` | 过期阈值 |
| `snapshotTimestamp` | 快照生成时间 |

## 12. VenueSession

| 字段 | 含义 |
|---|---|
| `venueId` / `accountId` / `orsId` | 接入点/账户/ORS |
| `sourceSessionId` | 会话 ID |
| `sourcePublicationEpoch` | 发布代次 |
| `environment` | 环境 |
| `tradingDay` | 交易日 |
| `loginState` | `DOWN` / `CONNECTING` / `UP` / `DEGRADED` |
| `settlementState` | `NONE` / `PENDING` / `SETTLING` / `SETTLED` / `FAILED` |
| `adapterSessionId` | 适配器会话标识 |
| `state` | `STARTING` / `READY` / `REPLAYING` / `LOST` |
| `reason` | 状态原因 |
| `snapshotTimestamp` | 会话快照生成时间 |
| `lastSeqByStream[]` | `streamId` + `lastSeq`，各流高水位 |

## 13. Enums

```text
Side             BUY / SELL
Offset           OPEN / CLOSE / CLOSE_TODAY / CLOSE_YESTERDAY
OrderType        LIMIT / MARKET
TimeInForce      DAY / FAK / FOK / IOC
OrderStatus      NEW / ACK / PARTIAL / FILLED / CANCELED / REJECTED
GatewayState     DOWN / CONNECTING / UP / DEGRADED
VenueSessionState STARTING / READY / REPLAYING / LOST
SettlementState  NONE / PENDING / SETTLING / SETTLED / FAILED
DataSource       UNKNOWN / CTP / SIM / REPLAY / ARCHIVE
```

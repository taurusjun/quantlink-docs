# Venue Contract vs Trading Field Diff

- 日期：2026-11-23
- 对比对象：
  - `quantlink-trading`：`MarketUpdateNew`、`Instrument`、`RequestMsg`、`ResponseMsg`、position file、`OptionManager`
  - `quantlink-venue-contract`：canonical v0.2

## 1. Contract 新增/改名，trading 没有直接字段

| contract 字段 | trading 对应 | 为什么需要 |
|---|---|---|
| `venueId` | 无独立字段；trading 用 exchange/session 隐含 | 区分接入点/柜台与交易所；Access 层多 venue/账户路由 |
| `orsId` | 无消息字段；ORS 进程隐含 | 标识 ORS 实例，做 session/健康/审计 |
| `sourceSessionId` | 无；SHM/进程生命周期隐含 | AccessRuntime/TradeBot 独立重启后区分新旧 session |
| `sourcePublicationEpoch` | 无 | publication 重建后 seq 归零；区分旧 publication |
| `seq` | `m_seqnum/m_rptseqnum` | 统一成合同内序号；去重/gap/旧消息 |
| `environment` | 配置文件/进程隐含 | SHADOW/LIVE/REPLAY 硬边界，防止串环境 |
| `requestId` | 无独立字段 | 请求幂等、审计、日志关联 |
| `snapshotId` | 无 | 快照批次关联，避免混合快照 |
| `staleAfterMs` | 无 | 快照新鲜度判断 |
| `Trade.tradingDay` | 无 | 成交幂等键 `(venueId, accountId, tradingDay, tradeId)` |
| `Trade.feeKnown` | 无 | CTP fee 可能未知，区分 0 与 unknown |
| `synthetic` | 无 | SimVenue/SyntheticChain 合成行情标识 |
| `source`（PositionSnapshot） | 无 | 快照来源：CTP/SIM/REPLAY/ARCHIVE |

## 2. Trading 有，Contract 没有或改名

| trading 字段 | contract 处理 | 原因 |
|---|---|---|
| `m_exchTS` + `m_timestamp` | `exchangeTimestamp` + `ingestTimestamp` | 交易所时间与本地接收入口分开 |
| `m_seqnum` + `m_rptseqnum` | 只保留 `seq` | 统一为一个可检测序号；不区分上报序号 |
| `m_tokenId` / `m_symbolID` | 不保留 | 内部 symbol 编号；contract 用 `instrumentId` |
| `m_exchangeName` 数字码 | `exchange` 字符串 | 可读、跨系统稳定 |
| `m_newPrice` / `m_oldPrice` | 不保留 | 归一化为完整 `MarketData`（quote snapshot） |
| `m_lastTradedPrice` | `lastPrice` | 同义 |
| `m_lastTradedTime` | `lastTradeTime` | 已补 |
| `m_totalTradedValue` | `turnover` | 已补 |
| `m_lastTradedQuantity` | `lastTradeQty` | 已补 |
| `m_totalTradedQuantity` | `volume` | 同义 |
| `m_yield` | 不保留 | CTP 商品期货不需要；债券/特殊品种以后单独加 |
| 20 档行情 | 20 档 | contract 固定 20 档；venue 不足的档位补零，不重复、不伪造 |
| 每档 `orderCount` | 不保留 | CTP 行情没有 order count |
| `m_newQuant/oldQuant` | 不保留 | 完整 snapshot 不需要增量字段 |
| `m_updateType/feedType/side/updateLevel/endPkt` | 不保留 | contract 归一化为完整 `MarketData` 快照 |
| `m_validBids/m_validAsks` | 由 group count 表达 | SBE group 自带数量 |
| `Instrument.priceFactor/contractFactor/multipleSize/divisorSize` | 只保留 `multiplier` | CTP 合约元数据以 multiplier 为主；需要时再升版本 |
| `Instrument.sendInLots` / `optionType` / `daysToExpiry` | 不保留 | 策略/适配器可派生；不属于 venue 事实 |
| `RequestMsg.RequestType`（NEW/MODIFY/CANCEL/STATUS） | 拆成 `OrderRequest` / `ModifyRequest` / `CancelRequest` | 0.2.0 支持改单；status 仍由 `OrderUpdate` 承载 |
| `RequestMsg.QuantityFilled` / `DisclosedQnty` | `ModifyRequest.filledQty` / `disclosedQty` | 改单需要已成交量和显示数量；新单不携带 |
| `RequestMsg.PxType` | 不保留 | CTP 限价/市价用 `orderType` 足够 |
| `OrderHitType`（STANDARD/IMPROVE/CROSS/...） | 不保留 | 策略执行风格，不是交易所 TIF；CROSS 转成 `timeInForce=FAK` |
| `RequestMsg.Token/Product/StrategyID` | 不保留 | 内部路由/策略字段，L0 contract 只认 `venueId`/`accountId`/`instrumentId` |
| `ResponseMsg.Response_Type/Child_Response` | `OrderUpdate.status` + `errorCode` | 拆分后保留必要语义 |
| `ResponseMsg.OrderID` | `orderRef` | L0 订单主键；`clientOrderId` 留在上层 |
| `ResponseMsg.Quantity/Price` | `OrderUpdate.orderQty/price` | 已补 |
| `ResponseMsg.Side/OpenClose` | `OrderUpdate.side/offsetFlag` / `Trade.side/offsetFlag` | 已补 |
| `ResponseMsg.ExchangeTradeId` | `Trade.tradeId` | 同义 |
| position file `BUY_QTY/SELL_QTY` | `PositionSnapshot.longQty/shortQty` | 语义映射 |
| position file `BUY_AVG_PRICE/SELL_AVG_PRICE` | `longAvgPrice/shortAvgPrice` | 语义映射 |
| position file `REALISED_PNL` | `AccountSnapshot.closeProfit` + runtime PnL | 策略 PnL 由 runtime 计算，不混入 venue position |
| `OptionManager` delta/vega/IV/basis/hedge queues | 不在 contract | 策略派生状态，不是 venue 事实 |

## 3. Contract 从 trading 补充的字段

| contract 字段 | trading 来源 | 为什么补 |
|---|---|---|
| `MarketData.lastTradeQty` | `m_lastTradedQuantity` | 策略/指标需要最新成交量 |
| `MarketData.lastTradeTime` | `m_lastTradedTime` | 最新成交时间 |
| `MarketData.turnover` | `m_totalTradedValue` | 成交额/VWAP |
| `OrderUpdate.side` | `ResponseMsg.Side` | 回报自包含 |
| `OrderUpdate.offsetFlag` | `ResponseMsg.OpenClose` | 开平归因 |
| `OrderUpdate.orderQty` | `ResponseMsg.Quantity` | 原始委托量 |
| `OrderUpdate.price` | `ResponseMsg.Price` | 委托价 |
| `OrderUpdate.errorCode` | `ResponseMsg.ErrorCode` | CTP 错误码 |
| `OrderUpdate.cancelState` | `ResponseMsg` cancel confirm/reject | 撤单中间态 |
| `Trade.offsetFlag` | `ResponseMsg.OpenClose` | 开平归因 |
| `Trade.exchangeOrderId` | `ResponseMsg.ExchangeOrderId` | 柜台订单关联 |

## 4. 结论

```text
contract 保留：
  行情事实
  订单/成交事实
  持仓/账户事实
  session/路由/幂等/版本元数据

contract 不保留：
  策略执行风格（OrderHitType）
  策略派生 Greeks/OptionManager
  进程内部 symbol/token/缓存字段
  CTP 不提供的盘口细节（orderCount）
  strategyKey / clientOrderId（策略归因由 L1/L2 持有）
```

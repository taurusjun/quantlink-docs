# 策略触发下单后，数据是怎么到 DataService 的？

## 短答

**自动策略单不经过 DataService 转发。** 策略直接向 ORS 发单；DataService 是**旁路订阅/读取 ORS 的请求与回报**，把订单/成交/持仓/PNL 整理后给 GUI 查询。

手工单是另一条路：GUI → DataService → ORS。

## 自动策略单的路径

```text
策略（SHSH* 或 TradeBot）
  -> Connector/CommonClient::SendNewOrder
  -> ORS（RequestMsg / 订单请求）
  -> 交易所
  -> ORS 收到 ResponseMsg（确认/拒绝/成交）
  -> DataService 旁路读取 ORS 的 Request/Response
  -> DataService 按 OrderID 关联请求+回报
  -> 更新订单/成交/持仓/PNL 数据存储
  -> GUI 的 OrdersCollector / PNLCollector / MDCollector 用 TCP 查询
  -> GUI 显示
```

策略自身也会收到 ORS 回报，用于自己的订单状态/仓位/PnL；DataService 是另一份观察者数据。

## DataService 两种取数模式

历史启动给了两个 DataService 脚本，二选一：

### 1. ServiceApplication：`runDataService.sh`

`configService.xml`：

```xml
<ServerPort>20000</ServerPort>
<ApplicationType>ServiceApplication</ApplicationType>
<Exchange Name="CME">   <Port>1733</Port> ...
<Exchange Name="China"> <Port>1732</Port> ...
```

`ServiceOrderDataStore` 对每个交易所发 `ServiceOrdersCommandType`，`ServiceOrderDataSource` 从 ORS 服务 socket 读取 `OrderExchangeMessage`：

- `RequestMessageType` → `RequestMsg`
- `ResponseMessageType` → `ResponseMsg`

`ServiceOrderDataStore` 按 `OrderID` 关联请求/回报：

- 收到请求先存 `m_requestMsgMap_new[OrderID]`；
- 收到回报先找请求，找到就构造 `OrderInfo`、更新订单/成交/PNL；
- 如果回报先到，先放 `m_responseMsgMap[OrderID]` 缓存，等请求到达再补处理。

这就是日志里大量 `got response message:Type:...` 的来源。

### 2. StreamingApplication：`runDataStream_CTP.sh`

`configStream_CTP.xml`：

```xml
<ServerPort>1732</ServerPort>
<DataSource Name="StreamingMdDataSource"> Key=872 ...
<DataSource Name="StreamingOrsDataSource">
  <DataSourceConfig Name="ORSREQ"> Key=3872 ... ClientStoreKey=727272
  <DataSourceConfig Name="ORSRES"> Key=4872 ...
```

它直接读 ORS 的 SHM：

- 872：行情；
- 3872：ORS 请求；
- 4872：ORS 回报；
- 727272：ClientStore。

`StreamingOrsDataStore`/`OrdersDataSource` 把这些流注册给 DataService，GUI 连 1732 查询。

> 选 20000 还是 1732，取决于你启动 `runDataService.sh` 还是 `runDataStream_CTP.sh`；GUI 的 ConnectDialog 里填对应端口。

## GUI 怎么拿到 DataService 数据？

`DataCollector` 登录 DataService 后，各采集器发命令、读结构体：

| 采集器 | 命令 | 收到 |
|---|---|---|
| `OrdersCollector` | `OrderCommand`（`ServiceOrdersCommandType`） | `Order` 流（open/closed） |
| `PNLCollector` | `NetPnlCommand` | `NetPnlInfo` |
| `MDCollector` | `MarketUpdateCommand`（AddSymbols） | `MarketUpdateWithOrderIndication` |
| `ManualOrderSender` | `ManualOrderCommand` | 手工单 New/Cancel/Modify/CancelAll |

## 手工单的路径（相反方向）

```text
GUI 手工单
  -> ManualOrderSender
  -> ManualOrderCommand
  -> DataService
  -> ORS
  -> 交易所
```

所以：

- **自动策略单**：策略 → ORS → DataService 旁路观察；
- **手工单**：GUI → DataService → ORS。

## 关键坑

- DataService 的订单数据依赖它是否订阅了对应交易所；没订到就没有。
- 回报可能先于请求到达；`ServiceOrderDataStore` 有缓存队列，但缓存/关联失败会丢单或“Object not present for trade confirm”。
- `DataService` 不是策略的订单主通道；它挂了，策略仍可能继续向 ORS 发单，只是 GUI 看不到最新订单/PNL。
- 两套模式（Service/Streaming）端口/数据源不同；GUI 连错端口会“连上但没数据”。

## 证据

- `3/infra/dataservice_deploy/configService.xml:1-60`
- `3/infra/dataservice_deploy/configStream_CTP.xml:1-37`
- `3/dalong/infrastructure/DataService/src/serviceorderdatastore.cpp:26-205`
- `3/dalong/infrastructure/DataService/src/serviceorderdatasource.cpp:11-69`
- `3/dalong/infrastructure/DataService/src/streamingorsdatastore.cpp:7-54`
- `3/dalong/infrastructure/TradingSystemsGUI/DataCollector.cpp:24-116`
- `3/dalong/infrastructure/TradingSystemsGUI/OrdersCollector.cpp:24-80`
- `3/dalong/infrastructure/TradingSystemsGUI/PNLCollector.cpp:24-70`
- `3/dalong/infrastructure/TradingSystemsGUI/MDCollector.cpp:24-90`
- `3/dalong/infrastructure/TradingSystemsGUI/ManualOrderSender.cpp:24-80`

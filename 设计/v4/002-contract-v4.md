# Contract 方案（v4 设计）

- 状态：DRAFT（2026-11-26）
- 范围：ORS ↔ SDK 的 Aeron 消息 schema
- 业务基线：公司 ORS `RequestMsg` / `ResponseMsg` + `tb_origin`
- 关联：
  - `001-v4-architecture.md`
  - `ref/001-ors-baseline-comparison.md`

---

## 1. 结论

**重写 ORS contract，不在旧 `OrderRequest/OrderUpdate` 上打补丁。**

contract 的职责只有：

```text
把公司 ORS 的 RequestMsg / ResponseMsg 和行情、账户查询编码成 Aeron frame
```

它不定义订单状态机，不替代 ORS 的订单 map，不新增 v3 的 `NEW/ACK/PARTIAL` 语义。

---

## 2. 版本与仓库策略

**contract 1.0.0 是唯一 active contract。SimVenue、FastTrade、ORS、SDK 全部使用同一版本。**

```text
quantlink-venue-contract/
  abi/sbe/
    quantlink-fin-sbe.xml          # 1.0.0，唯一 active schema
```

生成代码使用统一包名：

```text
com.quantlink.contract.sbe
```

发布 artifact：

```text
com.quantlink.contract:venue-contract:1.0.0
```

规则：

- v3 schema 冻结为历史版本，不再新增字段、不再作为 active 依赖
- 不保留 v3/v4 双 canonical，不做兼容 shim
- contract 1.0.0 的升级必须和 SimVenue、FastTrade、ORS、SDK 同批发布
- 版本矩阵锁定 contract 1.0.0 与各仓 SHA，禁止 v3 consumer 混入 new release

迁移顺序：

```text
1. 定义新 schema + 生成代码
2. ORS/SDK 接新 contract
3. SimVenue 接新 contract
4. FastTrade 接新 contract
5. 删除 active 构建中的 v3 依赖
6. 版本矩阵切到 contract 1.0.0
```

SimVenue 和 FastTrade 不是“以后再说”的消费方，而是本次 contract 重写的必改项。

---

## 3. Contract 消息集

```text
1. OrsRequest           SDK -> ORS
2. OrsResponse          ORS -> SDK
3. AccountQuery         SDK -> ORS
4. AccountSnapshot      ORS -> SDK
5. MarketUpdate         ORS -> SDK
6. SessionEvent          ORS -> SDK
7. ClientRegister       SDK -> ORS
8. ClientRegisterResponse ORS -> SDK
```

contract 不使用旧的 `OrderUpdate` / `Trade` / `CancelState` 作为 canonical 订单消息。
订单事件全部由 `OrsResponse.ResponseType` 表达。

---

## 4. `OrsRequest`

字段对齐公司 `RequestMsg`：

```text
contractDescription
  instrumentName      char[32]
  symbol              char[50]
  expiryDate          int32
  strikePrice         int32
  optionType          char[2]       // XX / CE / PE
  caLevel             int16

requestType           enum RequestType
orderType             enum OrderType
duration              enum OrderDuration
priceType             enum PriceType
positionDirection     enum PositionDirection
orderId               uint32
token                 int32
quantity              int32
quantityFilled        int32
disclosedQty          int32
price                 double
timestamp             uint64
accountId             char[11]      // 公司 MAX_ACCNTID_LEN + 1
transactionType       uint8         // 公司 B/S 字节
exchangeType          uint8         // 公司 ExchangeType
```

说明：

- `padding[20]` 不进入 SBE；它只是 C++ 内存对齐
- `OrderID` 是公司 ORS 的订单主键，不是 v3 的 `orderRef`
- `StrategyID` 不在公司 `RequestMsg` 中；如果确实需要，走 Aeron envelope 或 ORS 配置，不先塞进订单主键
- `Side` 使用公司字节值 `B/S`，还是枚举值，需要在字段字典中固定一种；默认按公司字节值

`RequestType` 对齐公司：

```text
NEWORDER      = 0
MODIFYORDER   = 1
CANCELORDER   = 2
ORDERSTATUS   = 3
SESSIONMSG    = 4
HEARTBEAT     = 5
```

`OrderType` / `OrderDuration` / `PriceType` / `PositionDirection` 使用公司枚举值，不重新编号。

---

## 5. `OrsResponse`

字段对齐公司 `ResponseMsg`：

```text
responseType        enum ResponseType
childResponse       enum SubResponseType
orderId             uint32
errorCode           uint32
quantity            int32
price               double
timestamp           uint64
side                uint8
symbol              char[50]
accountId           char[11]
exchangeOrderId     double
```

注意：

- 公司 `ExchangeOrderId` 在 `ResponseMsg` 中是 `double`，contract 先按原类型保留；不要为了“看起来合理”改成 string，否则又改变语义
- `ResponseType` 使用公司枚举，尤其保留：
  - `NEW_ORDER_CONFIRM`
  - `CANCEL_ORDER_CONFIRM`
  - `CANCEL_ORDER_REJECT`
  - `TRADE_CONFIRM`
  - `ORDER_ERROR`
  - `ORS_REJECT`
  - `RMS_REJECT`
  - `ORDERS_PER_DAY_LIMIT_REJECT`
  - `ORDERS_PER_DAY_LIMIT_WARNING`
  - `ORDER_EXPIRED`
- `SubResponseType` 保留：
  - `NULL_RESPONSE_MIDDLE`
  - `ORDER_REJECT_MIDDLE`
  - `MODIFY_REJECT_MIDDLE`
  - `CANCEL_ORDER_REJECT_MIDDLE`

contract 不增加 `OrderStatus`、`CancelState`、`filledQty/remainingQty` 作为 canonical 字段。
这些是 TradeBot 从公司 ResponseMsg 推导的本地状态，不是 ORS wire 语义。

---

## 6. Account query

公司 CTP ORS 原始代码的 account query 基本未启用；contract 只在这里做业务改动。

建议消息：

```text
AccountQuery
  requestId       uint64
  accountId       char[11]
  timestamp       uint64

AccountSnapshot
  requestId       uint64
  accountId       char[11]
  tradingDay      char[9]
  balance         double
  available       double
  margin          double
  frozenMargin    double
  commission      double
  closeProfit     double
  positionProfit  double
  deposit         double
  withdraw        double
  errorCode       uint32
  errorMsg        char[128]
  timestamp       uint64
```

待确认：

- 是否只保留 `balance/available/margin`，还是保留当前 contract 的完整字段
- 账户查询是“快照”还是“请求-响应”；建议请求-响应 + snapshot 体
- 账户查询失败是否单独回 `errorCode`，还是复用 `OrsResponse`；建议单独消息，避免污染订单状态

持仓查询不在本次“只改 account query”范围内；如果 contract 需要，单独加 `PositionQuery`。

---

## 7. MarketUpdate

如果 ORS 仍负责行情发布，v4 需要单独的行情消息，不能复用 v3 `MarketData` 作为公司 `MarketUpdateNew` 的同义词。

建议按公司 `MarketUpdateNew` 的核心字段定义：

```text
symbol              char[50]
exchangeName        uint8
exchangeTimestamp   uint64
localTimestamp      uint64
sequence            uint64
reportSequence      uint64
tokenId             uint64
lastPrice           double
lastTradedPrice     double
lastTradedTime      uint64
lastTradedQty       int32
totalTradedValue    double
totalTradedQty      int64
yield               double
openInterest        double
updateType          uint8
feedType            uint8
side                uint8
validBids           int8
validAsks           int8

bids[20] { price double, qty int32, orderCount int32 }
asks[20] { price double, qty int32, orderCount int32 }
```

具体字段是否全部进入 contract，需要按 TradeBot 实际消费字段裁剪；不能把 v3 `MarketData` 的 20 档结构直接当公司行情结构。

---

## 8. Aeron 布局

```text
stream 1: REQUEST      SDK -> ORS
stream 2: RESPONSE     ORS -> SDK
stream 3: ACCOUNT      ORS -> SDK
stream 4: MARKET_DATA  ORS -> SDK
stream 5: SESSION      ORS -> SDK
stream 6: CONTROL      SDK -> ORS / ORS -> SDK
```

规则：

- 一个 Aeron frame 只放一个 SBE message
- SBE header 带 schemaId/templateId/version
- `OrderID` 是 request/response 关联键
- `requestId` 是 account query 关联键
- `AccountQuery` 走 REQUEST stream（SDK -> ORS）；`AccountSnapshot` 走 ACCOUNT stream（ORS -> SDK）
- 没有单独的 `AccountQueryResponse` contract 消息
- `ClientRegisterResponse.clientId` 是 OrderID 的高位编号来源
- 不在 ORS/SDK 之间重新引入 `orderRef` 和 v3 `sourcePublicationEpoch` 语义
- 断线重连、sequence、epoch 如果需要，放在 Aeron/SDK envelope，不塞进公司 `RequestMsg/ResponseMsg` 字段

---

## 9. 生成与测试

- 使用现有 SBE 生成链路，生成 C++/Java
- contract 包名与旧包隔离，避免 classpath/类名冲突
- 字段宽度、枚举值、字节序、字符串填充规则要有 golden frame 测试
- 用公司 `RequestMsg/ResponseMsg` 的真实样例做 round-trip
- 必须覆盖：
  - 未知撤单 `CANCEL_ORDER_REJECT`
  - `TRADE_CONFIRM`
  - `ORDER_ERROR`
  - account query 成功/失败
  - 固定宽度 UTF-8/ASCII 边界
  - 旧/新 contract 不混用

---

## 10. 不做

- 不把旧 `OrderStatus` / `CancelState` 改名为新 contract
- 不在 contract 中重新实现订单状态机
- 不把 `CANCEL_ORDER_REJECT` 降级成普通订单拒绝
- 不为了兼容旧 contract 在新 canonical schema 里保留两套订单字段
- 不保留双 active contract
- 不让 SimVenue/FastTrade 继续以 v3 进入 new release

---

## 11. ClientRegister

contract 没有 SHM ClientStore，但 OrderID 仍按 `tb_origin` 的 `clientId * 1_000_000 + orderCount` 规则。

因此需要在 CONTROL stream 增加：

```text
ClientRegister
  requestId       uint64
  instanceId      char[64]
  accountId       char[11]
  environment     char[16]
  timestamp       uint64

ClientRegisterResponse
  requestId       uint64
  clientId        uint32
  errorCode       uint32
  errorMsg        char[128]
  timestamp       uint64
```

规则：

- SDK 启动先注册，拿到 `clientId` 后才能发订单
- `clientId` 在 ORS 账户范围内唯一
- ORS 重启后注册关系重新建立
- `clientId` 分配和释放规则必须防止进程重启后复用仍存活订单的 OrderID
- 不把 ClientStore 的 SHM 语义带进请求/响应消息

---

## 12. SimVenue / FastTrade 迁移

contract 不是 ORS 专用 schema；SimVenue 和 FastTrade 必须使用同一份 v4 消息语义。

### SimVenue

- 用 `OrsRequest` / `OrsResponse` 模拟公司 ORS 的订单和撤单行为
- 行情使用 `MarketUpdate`
- 账户/持仓使用 `AccountSnapshot` / position 消息
- 必须覆盖 `CANCEL_ORDER_REJECT`、终态、未知撤单等公司行为
- 不能继续发出 v3 `OrderUpdate` 状态机

### FastTrade

- AccessSDK / TradeBot 订单接入改为 `OrsRequest` / `OrsResponse`
- 删除 v3 `OrderRequest/OrderUpdate/Trade` 依赖
- 策略层仍可使用自己的策略订单视图，但不能把 v3 contract 状态当 ORS 权威
- 与 SimVenue 联调使用同一 contract artifact

### 发布门槛

```text
contract 1.0.0
  + ORS v4（设计版本）
  + SDK v4（设计版本）
  + SimVenue v4（设计版本）
  + FastTrade v4（设计版本）
```

任一消费方仍依赖旧 contract，不得发布新版本矩阵。

---

## 13. 待确认

1. `OrsResponse.ExchangeOrderId` 是否严格保留公司 `double` 类型。
2. `StrategyID` 是否进入 Aeron envelope，还是完全不进 v4。
3. account query 字段是否按当前 `AccountSnapshot` 全集。
4. MarketUpdate 是否由 ORS 发布，以及 TradeBot 实际需要哪些字段。
5. 持仓查询是否也进 contract，还是保持公司 ORS 内部行为。
6. SimVenue/FastTrade 的 contract 切换顺序和联调窗口。

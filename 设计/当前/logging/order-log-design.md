# 订单日志设计

**状态：** DRAFT，等待确认  
**范围：** C++ ORS 与 Java SimVenue 订单生命周期日志  
**采用方案：** A（源码级订单日志统一）  
**目标：** 让订单日志可稳定按订单号、状态、错误码查询；`message` 只保留人类可读语义。

## 1. 为什么重做

当前订单日志主要是历史 `ORS_LOG` 格式：

```text
--->>> 1795784608006220485|Request submitted | 142266 | au2612 | 2000000 | 000000000001 | B
--->>> 1795784608014311112|Trade | 142266 | au2612 | 2000000 | 000000000001 | B | 785.7 | 1 | 0
```

问题：

- 订单字段全部在 `message` 中，无法按字段查询；
- 同一状态重复记录 start/end、Request submitted、All traded、Trade；
- `exchID` 实际是 CTP `OrderRef`，不是交易所；
- `ClientID` 实际是账户 ID；
- `OrderSysID` 才是交易所订单号；
- `exchange` 是数字枚举，查询不直观；
- 拒单、撤单失败、未知状态也多数写成 `INFO`；
- 部分 `std::cout` 输出根本不进入 JSON 文件；
- `event` 和 `message` 没有订单生命周期语义。

## 2. 设计原则

1. **一条日志对应一个订单状态变化**，不记录无业务含义的 start/end。
2. **订单号是主关联键**：所有订单事件必须带 `order_id`。
3. **`type="order"` 固定**。
4. **`message` 是短句**，不包含 ID、时间戳、函数名、价格、数量、错误码。
5. 字段名和 CTP 原始字段区分清楚：
   - `order_id`：ORS 本地订单号
   - `order_ref`：CTP `OrderRef`
   - `exchange_order_id`：CTP `OrderSysID`
   - `exchange_id`：SHFE/CFFEX/ZCE/DCE/GFEX/INE
6. 拒单、错误、未知状态使用 `ERROR` 或 `WARN`，正常状态使用 `INFO`。
7. 日志代码不改变订单、RMS、CTP 回调的处理顺序。
8. 旧 `ORS_LOG` 订单日志全部迁移；迁移完成后订单域不再依赖 pipe 文本。

## 3. 订单字段

### 3.1 必填订单字段

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `type` | string | 固定 | 固定 `order` |
| `event` | string | 代码 | 订单事件名 |
| `order_id` | string | `OrderInfo.localID` | ORS 本地订单号 |
| `strategy_id` | number | `OrderInfo.strategyId` | TB 策略实例 ID；0 表示无策略/外部订单 |
| `order_ref` | string | `OrderInfo.exchID` | CTP `OrderRef` |
| `exchange_order_id` | string | `OrderInfo.OrderSysID` | CTP `OrderSysID`，可为空 |
| `front_id` | number | `OrderInfo.frontId` | CTP FrontID |
| `session_id` | number | `OrderInfo.sessionId` | CTP SessionID |
| `exchange_id` | string | `OrderInfo.exchange` | `SHFE` / `CFFEX` / `ZCE` / `DCE` / `GFEX` / `INE` |
| `instrument` | string | `ScripCode` | 合约 |
| `account_id` | string | `ClientID` | 账户 |
| `side` | string | `Transaction_Type` | `BUY` / `SELL` |
| `status` | string | 状态映射 | 见 3.3 |
| `message` | string | 代码 | 纯人类可读语义 |

### 3.2 可选订单字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `offset` | string | `OPEN` / `CLOSE` / `CLOSE_TODAY` / `CLOSE_YESTERDAY` |
| `price` | number | 委托价 |
| `quantity` | number | 委托数量 |
| `filled_quantity` | number | 本次成交量 |
| `remaining_quantity` | number | 剩余数量 |
| `error_code` | string | CTP/ORS 错误码，字符串 |
| `error_message` | string | 错误描述，已脱敏 |
| `latency_us` | number | 从发出到确认的耗时，可选 |
| `exchange_trade_id` | string | 交易所逐笔成交号；SimVenue 使用 `sim-<orderRef>-<tradeId>` |
| `source` | string | `ctp_order_report` / `ctp_trade` / `sim_exchange` |
| `raw_status` | string | CTP/SimVenue 原始状态值 |
| `raw_status_name` | string | 原始状态名，如 `AllTraded` |

不记录 `tempTimeStamp`。统一使用外层 `ts`；如果确实需要纳秒级时间，再另加 `event_time_ns`，不放进 `message`。

`client_id` 由 ORS 分配，只用于 `order_id` 命名空间和回报归属：TB 用 `client_id * 1,000,000 + count` 生成 `order_id`，ORS 校验高位段属于已注册客户端，SDK 过滤非本客户端回报。`client_id` 不是策略身份，不替代 `strategy_id`。

## 4. 状态语义

### 4.1 `status`

| status | 含义 |
|---|---|
| `submitted` | ORS 已发出/已报单，等待交易所确认 |
| `accepted` | 交易所接受，订单在队列中 |
| `partially_filled` | 部分成交 |
| `filled` | 全部成交 |
| `canceled` | 已撤单 |
| `rejected` | 新单/撤单被拒 |
| `cancel_requested` | 已发出撤单请求，等待确认 |
| `unknown` | 未识别状态 |

### 4.2 CTP 映射

`OrderStatus`：

- `THOST_FTDC_OST_AllTraded` → `filled`
- `THOST_FTDC_OST_PartTradedQueueing` → `partially_filled`
- `THOST_FTDC_OST_NoTradeQueueing` → `accepted`
- `THOST_FTDC_OST_Canceled` → `canceled`
- `THOST_FTDC_OST_Unknown` → `submitted`

`OrderSubmitStatus`：

- `InsertSubmitted` + `Unknown` → `submitted`
- `Accepted` + 队列状态 → `accepted`
- `InsertRejected` → `rejected`

### 4.3 offset 映射

`OrderInfo.qtyType`：

- `OPEN_ORDER` → `OPEN`
- `CLOSE_TODAY` → `CLOSE_TODAY`
- `CLOSE_YESTERDAY` → `CLOSE_YESTERDAY`
- 其他 → `UNKNOWN`

## 5. 事件设计

| event | 触发点 | level | status |
|---|---|---|---|
| `ors.order.submitted` | `OrderService::sendNewOrder` 发出后 | INFO | `submitted` |
| `ors.order.accepted` | `OnRtnOrder` 交易所接受 | INFO | `accepted` |
| `ors.order.rejected` | `OnRspOrderInsert`/`OnErrRtnOrderInsert` 错误 | ERROR | `rejected` |
| `ors.order.cancel_requested` | `OrderService::sendCancelOrder` 发出后 | INFO | `cancel_requested` 或沿用 `accepted` 前状态 |
| `ors.order.canceled` | `OnRtnOrder` Canceled | INFO | `canceled` |
| `ors.order.cancel_rejected` | `OnRspOrderAction`/`OnErrRtnOrderAction` | ERROR | `rejected` |
| `ors.order.trade` | `OnRtnTrade` | INFO | `partially_filled` / `filled` |
| `ors.order.status` | `OnRtnOrder` 状态变化 | INFO/WARN | CTP `OrderStatus` 归一化 |

说明：

- **不新增** `ors.order.filled` 和 `ors.order.trade` 两条重复日志；成交事件统一用 `ors.order.trade`，用 `status` 区分部分/全部成交。
- `ors.order.status` 是 CTP 状态审计流，覆盖 `AllTraded/PartTradedQueueing/NoTradeQueueing/Canceled` 等；同一状态重复回调不重复记录。
- 状态审计和成交统计必须分开：状态流看 `ors.order.status`，成交量/价只能用 `ors.order.trade`，不能相加。
- `exchange_trade_id` 只出现在 trade 事件。
- `PushUpdate` 中原来的 `NC/CC` 日志是重复状态记录，迁移时删除；如果需要延迟指标，作为 `latency_us` 字段附加到 accepted/canceled 事件。
- `OnRtnOrder` 的 start/end 日志删除。
- `SendCancelOrder` 中的 `std::cout` 改为结构化 `ors.order.cancel_requested`，或者如果已有等价日志则删除。

## 6. 日志示例

### 新单提交

```json
{
  "schema_version": "1",
  "type": "order",
  "event": "ors.order.submitted",
  "order_id": "2000000",
  "order_ref": "000000000001",
  "exchange_order_id": "",
  "exchange_id": "SHFE",
  "instrument": "au2612",
  "account_id": "142266",
  "side": "BUY",
  "offset": "OPEN",
  "price": 785.7,
  "quantity": 1,
  "status": "submitted",
  "message": "order submitted to CTP"
}
```

### 交易所接受

```json
{
  "type": "order",
  "event": "ors.order.accepted",
  "order_id": "2000000",
  "order_ref": "000000000001",
  "exchange_order_id": "123456",
  "exchange_id": "SHFE",
  "instrument": "au2612",
  "account_id": "142266",
  "side": "BUY",
  "offset": "OPEN",
  "price": 785.7,
  "quantity": 1,
  "remaining_quantity": 1,
  "status": "accepted",
  "message": "order accepted by exchange"
}
```

### 成交

```json
{
  "type": "order",
  "event": "ors.order.trade",
  "order_id": "2000000",
  "order_ref": "000000000001",
  "exchange_order_id": "123456",
  "exchange_id": "SHFE",
  "instrument": "au2612",
  "account_id": "142266",
  "side": "BUY",
  "price": 785.7,
  "filled_quantity": 1,
  "remaining_quantity": 0,
  "status": "filled",
  "message": "order filled"
}
```

### 拒单

```json
{
  "type": "order",
  "event": "ors.order.rejected",
  "order_id": "2000000",
  "order_ref": "000000000001",
  "exchange_id": "SHFE",
  "instrument": "au2612",
  "account_id": "142266",
  "side": "BUY",
  "status": "rejected",
  "error_code": "26",
  "error_message": "cancel reject",
  "message": "order rejected by exchange"
}
```

## 7. 实现方式

### 7.1 单一日志 helper

新增订单日志 helper，输入：

```text
event, message, status,
OrderInfo,
可选 error_code / error_message / filled_quantity / remaining_quantity
```

helper 负责：

- 固定 `type=order`；
- 把 `OrderInfo` 映射成统一字段；
- 映射 exchange/offset/status；
- 统一 `message`；
- 不读取 `tempTimeStamp`。

helper 不改变订单状态机，只负责日志输出。

### 7.2 迁移范围

- `src/execution/OrderService.cpp`
- `src/session/ORSServer.cpp`：
  - `logOrderInfoResponse`
  - `PushUpdate`
  - `OnRspOrderInsert`
  - `OnRspOrderAction`
  - `OnErrRtnOrderInsert`
  - `OnErrRtnOrderAction`
  - `OnRtnOrder`
  - `OnRtnTrade`
  - `SendCancelOrder`
- `src/session/ORSServerCallbacks.cpp` 的登录/断线日志不属于订单域，单独按 session 日志处理。

### 7.3 删除内容

- `OnRtnOrder` start/end 日志
- `OnRspOrderInsert` start/end 日志
- `OnErrRtnOrder*` start/end 日志
- `NC/CC` 重复确认日志
- 订单路径中的 `std::cout`
- 订单路径中的 `tempTimeStamp` 文本拼接

## 8. 测试与验收

### 单元测试

新增订单日志映射测试：

- `OrderInfo` → `order_id/order_ref/exchange_order_id/exchange_id/instrument/account_id/side`
- `exchange` 数字 → `SHFE/CFFEX/ZCE/DCE`
- `status` 映射
- `message` 不含 `|`、`orderId=`、时间戳
- 拒单带 `error_code`

### 夜盘验证

用 `ors_live_smoke` 产生新单和成交，查询：

```text
order_id:"2000000"
type:order
event:ors.order.trade
status:filled
```

验收：

- 同一订单链路能查到 submitted/accepted/trade；
- 每笔订单没有重复 start/end；
- 拒单 `level=ERROR` 且有 `error_code`；
- ORS 订单语义不变；
- CPU/延迟没有明显变化。

## 9. 非目标

- 不改变订单、撤单、RMS、CTP 回调行为；
- 不新增 CTP 请求；
- 不做日志采样；
- 不在本设计里引入 ClickHouse；
- 不修改 FastTrade/策略运行时；SimVenue 纳入本次订单日志改造。

## 10. Java / SimVenue 映射

Java 使用同一个字段表和事件名，通过 `quantlink-java-logging` 的 `OrderLog` helper 输出，不自行拼接 `orderId=...`。

| 字段 | SimVenue 来源 |
|---|---|
| `order_id` | `SimOrderRequest.orderId()` / `SimOrderUpdate.orderRef()` 的字符串形式 |
| `order_ref` | 场馆订单引用 |
| `exchange_id` | 合约交易所，如 `SHFE` |
| `venue_id` | `SIMVENUE` |
| `instrument` | 合约 |
| `account_id` | 账户 |
| `side` | `BUY` / `SELL` |
| `offset` | `OPEN` / `CLOSE` |
| `price` / `quantity` | 委托价量 |
| `filled_quantity` / `remaining_quantity` | 成交/剩余 |
| `status` | `submitted/accepted/partially_filled/filled/canceled/rejected` |
| `error_code` / `error_message` | 场馆错误 |
| `exchange_trade_id` | SimVenue 生成的 `sim-<orderRef>-<tradeId>` |
| `source` | `sim_exchange` |
| `raw_status` / `raw_status_name` | `SimOrderStatus` 原值/名称 |

SimVenue 还输出 `simvenue.order.status`，覆盖 `OPEN/PARTIAL/FILLED/CANCELED/REJECTED`；成交仍然只写 `simvenue.order.trade`。

事件映射：

- `simvenue.order.received` → `simvenue.order.submitted`
- `simvenue.order.accept` → `simvenue.order.accepted`
- `simvenue.order.reject` → `simvenue.order.rejected`
- `simvenue.cancel.received` → `simvenue.order.cancel_requested`
- `simvenue.cancel.reject` → `simvenue.order.cancel_rejected`
- `simvenue.trade` → `simvenue.order.trade`

## 11. 风险

| 风险 | 处理 |
|---|---|
| 字段映射错误 | 单元测试固定 CTP 枚举和 `OrderInfo` 字段 |
| 日志重复/缺失 | 按状态转移逐项替换，删除 start/end 和 NC/CC |
| 影响交易 | 只改日志调用，不改控制流；夜盘 smoke 验证 |
| 性能 | helper 只做字符串/枚举映射，不做网络/锁 |
| 旧日志兼容 | 新订单日志统一新格式；历史日志保留，查询层兼容 |

# 非订单日志设计

**状态：** DRAFT，等待确认  
**范围：** C++ ORS 和 Java SimVenue 的 `market_data/session/account/rms/transport/system` 日志  
**目标：** 沿用 JSONL 公共字段和 `message` 规则，复用已有订单字段，避免同义字段重复命名。

## 1. 设计原则

1. **同一含义只允许一个字段名**，不能 C++ 叫 `account`、Java 叫 `account_id`。
2. `message` 只写人类可读短句，不承载 ID、时间、价格、错误码。
3. `type` 固定为以下七类之一：

```text
order
market_data
account
session
rms
transport
system
```

4. 一个事件只记录一次状态变化，不记录无业务含义的 start/end。
5. `error_code` 统一字符串；`error_message` 统一错误描述；`duration_us` 统一耗时，单位微秒。
6. 字段名统一 `snake_case`；新代码不得使用 `account/symbol/venue/requestId/qty/errorCode` 等别名。
7. 现有订单字段直接复用，尤其是 `account_id/instrument/order_id/order_ref/side/offset/price/quantity/status/error_code`。

## 2. 公共字段复用表

这些字段跨类型复用，不再新增同义字段：

| 字段 | 类型 | 统一含义 | 使用类型 |
|---|---|---|---|
| `service` | string | `ors/simvenue` | 全部 |
| `instance` | string | 实例 | 全部 |
| `host` | string | 主机 | 全部 |
| `pid` | number | 进程 | 全部 |
| `type` | string | 业务分类 | 全部 |
| `event` | string | 稳定事件名 | 全部 |
| `message` | string | 人类可读语义 | 全部 |
| `account_id` | string | 账户 | order/account/session/rms |
| `venue_id` | string | `SIMNOW/SIMVENUE/CTP` | order/session/rms/transport |
| `exchange_id` | string | `SHFE/CFFEX/ZCE/DCE/GFEX/INE` | order/market_data/account/rms |
| `instrument` | string | 合约 | order/market_data/account/rms |
| `ors_id` | string | ORS 逻辑 ID | session/market_data/account |
| `environment` | string | `SHADOW/PROD/TEST` | session/account |
| `request_id` | string | 客户端请求 ID | account/session |
| `client_id` | string | ORS clientId | account/session |
| `order_id` | string | ORS 本地订单号 | order/rms |
| `order_ref` | string | CTP/场馆 OrderRef | order/rms |
| `exchange_order_id` | string | 交易所 OrderSysID | order/rms |
| `side` | string | `BUY/SELL` | order/rms |
| `offset` | string | `OPEN/CLOSE/CLOSE_TODAY/CLOSE_YESTERDAY` | order/rms |
| `price` | number | 价格 | order/market_data/rms |
| `quantity` | number | 委托数量 | order/rms |
| `filled_quantity` | number | 成交数量 | order |
| `remaining_quantity` | number | 剩余数量 | order |
| `status` | string | 订单状态 | order |
| `instrument_status` | string | 合约状态语义 | market_data |
| `instrument_status_code` | number | CTP 原始状态码 | market_data |
| `error_code` | string | 错误码 | 全部 |
| `error_message` | string | 错误描述 | 全部 |
| `duration_us` | number | 操作耗时 | session/account/rms/transport |
| `balance` | number | 账户余额 | account |
| `available` | number | 可用资金 | account |
| `margin` | number | 保证金 | account |
| `position_quantity` | number | 持仓数量 | account |
| `rule` | string | RMS 规则名 | rms |
| `limit_value` | number | RMS 限额 | rms |
| `current_value` | number | 当前值 | rms |
| `channel` | string | Aeron channel | transport |
| `stream_id` | number | Aeron stream | transport |
| `queue_depth` | number | 队列深度 | transport |
| `backpressure_events` | number | 背压次数 | transport |
| `sequence` | number | 业务序列 | system |

禁止新增：

```text
account / accountId / accountID
symbol / instrumentId / scrip_code
venue / venueId
requestId / requestID
clientId / clientID
qty / orderQty
errorCode / errcode
reason（错误场景改用 error_message）
latency / elapsed（统一 duration_us）
```

## 3. 各 type 的字段与事件

### 3.1 `session`

字段：

```text
account_id, venue_id, ors_id, environment,
front_address, request_id, client_id,
error_code, error_message, duration_us
```

事件：

```text
ors.session.connected
ors.session.disconnected
ors.session.authenticated
ors.session.login
ors.session.login_failed
ors.session.heartbeat_warning
ors.session.settlement_confirmed
ors.session.ready
simvenue.session.ready
```

示例：

```json
{
  "type": "session",
  "event": "ors.session.ready",
  "account_id": "142266",
  "venue_id": "SIMNOW",
  "ors_id": "ors-ctp-1",
  "environment": "SHADOW",
  "duration_us": 320000,
  "message": "ORS session ready"
}
```

### 3.2 `market_data`

字段：

```text
instrument, exchange_id, venue_id, ors_id,
update_time, update_millisec,
instrument_status, instrument_status_code,
error_code, error_message
```

事件：

```text
ors.md.connected
ors.md.disconnected
ors.md.subscribe
ors.md.subscribe_response
ors.md.tick
ors.md.unsubscribe
ors.instrument.status
ors.instrument.definition
ors.instrument.query
ors.instrument.query_response
```

规则：

- `update_time` 是交易所时间字符串，例如 `21:29:10`；
- `update_millisec` 是交易所毫秒；
- 不要用 `timestamp` 同时表示交易所时间和本机日志时间；
- `instrument_status` 用 `continuous_trading/auction_ordering/closed` 等语义值；
- `instrument_status_code` 保留 CTP 原始数值（例如 51）。

### 3.3 `account`

字段：

```text
account_id, venue_id, request_id, client_id,
instrument, exchange_id,
balance, available, margin, position_quantity,
error_code, error_message, duration_us
```

事件：

```text
ors.account.query
ors.account.snapshot
ors.account.position_query
ors.account.position_ready
simvenue.account.snapshot
```

规则：

- 余额、可用、保证金统一数字；
- 持仓明细用 `position_quantity`，不要用 `qty/position`；
- 查询超时写 `error_code=timeout`，不要只放文本。

### 3.4 `rms`

字段：

```text
order_id, order_ref, exchange_order_id,
account_id, exchange_id, instrument,
side, offset, price, quantity,
rule, limit_value, current_value,
error_code, error_message
```

事件：

```text
ors.rms.reject
ors.rms.warning
ors.rms.error
ors.rms.limit
```

规则：

- 直接复用订单字段，不重复定义 `symbol/orderQty/priceValue`；
- `rule` 是稳定规则名，例如 `max_order_qty`；
- `limit_value/current_value` 用于限额对比。

### 3.5 `transport`

字段：

```text
venue_id, channel, stream_id,
queue_depth, backpressure_events,
duration_us, error_code, error_message
```

事件：

```text
ors.transport.aeron_backpressure
ors.transport.publish_failed
ors.transport.connected
ors.transport.disconnected
simvenue.execution.backpressure
simvenue.frame.unknown
simvenue.frame.malformed
simvenue.ack.failed
```

规则：

- `channel` 只放 channel URI；
- `stream_id` 数字；
- 队列深度用 `queue_depth`；
- 不把整个队列内容写入日志。

### 3.6 `system`

字段：

```text
sequence, duration_us, error_code, error_message
```

事件：

```text
ors.startup.position_ready
ors.startup.orders_flat
ors.startup.live_orders
ors.system.metrics
ors.system.signal
simvenue.start
simvenue.commit
vector.log.parse_error
```

规则：

- `metrics` 使用固定指标名，例如 `orders_received/orders_sent/md_ticks`；
- `live_orders` 的 `order_refs` 用数组或逗号字符串，不放进 `message`；
- `startup` 告警的 `severity` 只允许 `P0/P1/P2/P3`；
- 解析失败日志：`level=WARN`、`message="failed to parse log line"`、原始行放 `raw`。

## 4. `type` 推断规则

事件名前缀优先：

```text
ors.order.* / simvenue.order.* / fasttrade.order.*  -> order
ors.md.* / ors.instrument.* / simvenue.market.*      -> market_data
ors.account.* / simvenue.account.*                   -> account
ors.session.* / simvenue.session.*                   -> session
ors.rms.* / simvenue.rms.*                           -> rms
ors.transport.* / simvenue.transport.* / simvenue.ack.* -> transport
其他 / startup / metrics / commit                    -> system
```

实现要求：

- C++ logger 统一通过 `event` 推断，不在每条日志手动写 `type`；
- Java `QuantLinkLog.event()` 使用同一规则；
- 订单日志继续使用 `OrderLog` helper，显式 `type=order`；
- 如果事件前缀无法判断，默认 `system`，不再新增 `other`。

## 5. `message` 规范

正确：

```text
market data subscription requested
market data tick
instrument definition loaded
account snapshot returned
RMS order rejected
Aeron publish backpressure
ORS session ready
```

禁止：

```text
|179578...|Instrument au2612
account=142266 balance=...
errorCode=3
orderId=1001 price=785.7
```

## 6. C++ / Java 落地

C++：

- 保留 `log::info/warn/error(event, fields)`；
- 用公共字段表迁移 `MdSpi`、`ORSServerCallbacks`、`StartupQuery`、`RmsError/RmsWarning`、`Aeron` 日志；
- 旧 `ORS_LOG` 非订单日志逐步迁移，迁移完成后 `message` 不再包含 pipe；
- 不在日志热路径做 JSON 解析或网络调用。

Java：

- SimVenue 的非订单日志使用 `QuantLinkLog.event()` + `StructuredArguments`/字段 helper；
- 统一把 `account/venue/requestId/clientId/errorCode` 改为公共字段名；
- `simvenue.commit`、`simvenue.start` 使用 `system/session` 字段；
- 后续 FastTrade/策略运行时复用同一字段表。

## 7. 迁移顺序

1. session 登录/认证/断线日志；
2. market_data 日志和设备状态；
3. account 查询/快照/持仓；
4. RMS 告警/拒绝；
5. transport/backpressure；
6. system/metrics/startup；
7. SimVenue 非订单日志；
8. 190 全量测试 + live smoke 查询。

## 8. 验收查询

```text
type:session event:ors.session.ready
type:market_data instrument:au2612
type:account account_id:142266
type:rms order_id:2000000
type:transport backpressure_events:>0
type:system event:metrics
```

验收：

- 同一含义只有一套字段名；
- 非订单 `message` 不再包含 `|` 和 `key=value`；
- 订单日志的 `account_id/instrument/order_id` 等字段可直接复用；
- Grafana 能按 type、instrument、account_id、error_code 过滤；
- 不改变交易、RMS、CTP、Aeron 行为。

## 9. 非目标

- 不修改订单状态机；
- 不新增指标或交易语义；
- 不做日志采样；
- 不引入 ClickHouse；
- 不重写历史日志。

## 10. 风险

| 风险 | 处理 |
|---|---|
| 同义字段再次出现 | 以本文公共字段表为唯一来源，新字段先查表 |
| 旧日志兼容 | 迁移期保留旧日志，新日志只写新字段名 |
| 热路径性能 | 只做字段构造，不做解析/网络 |
| 交易所时间混淆 | 统一 `update_time/update_millisec`，日志 `ts` 单独表示本机时间 |
| 类型误判 | 事件前缀规则 + 未知默认 `system` |

# Venue Contract 通道设计

- 日期：2026-11-21
- 状态：DRAFT（设计文档，未写代码）
- 范围：`quantlink-venue-contract` 的 Aeron 通道划分、消息归类、序列语义和 AccessClient 边界
- 关联：`015-accounttradingengine-design.md`

---

## 1. 目标

Venue contract 的目标是统一接入，不是为每种消息复制一条 Aeron 通道。

通道划分应满足：

```text
方向清晰
消费者清晰
背压边界清晰
序列语义清晰
错误隔离清晰
```

不应满足：

```text
一种消息一条通道
一个字段一组通道
```

---

## 2. 消息与方向

### 2.1 客户端到 venue

```text
OrderRequest
CancelRequest
```

这两类都是交易命令，方向相同，消费者都是 venue/ORS。

### 2.2 venue 到客户端

```text
OrderUpdate
Trade
PositionSnapshot
AccountSnapshot
VenueSession
```

这五类都是 venue 回报，但用途不同：

```text
OrderUpdate + Trade       订单执行热路径
PositionSnapshot          仓位快照
AccountSnapshot           账户快照
VenueSession              会话/READY/水位
```

### 2.3 行情

```text
MarketData
```

行情是独立广播数据：

```text
高频
无账户归属
多消费者
和交易回报的背压/序列完全不同
```

---

## 3. 当前七通道

```text
1001 MARKET_DATA
2001 ORDER_REQUEST
2002 CANCEL_REQUEST
2003 EXECUTION
2004 POSITION_SNAPSHOT
2005 ACCOUNT_SNAPSHOT
2006 VENUE_SESSION
```

存在的问题：

```text
OrderRequest / CancelRequest 按消息类型拆开
PositionSnapshot / AccountSnapshot 按消息类型拆开
```

这两组在方向、消费者、协议上没有本质差异。

---

## 4. 146 对照

146 的通道模型是：

```text
MD SHM
ORS REQUEST SHM
ORS RESPONSE SHM
```

对应：

```text
行情
请求（New / Modify / Cancel / Status）
响应（Order confirm / Cancel / Trade / Error）
```

146 的请求和响应都按“方向 + 用途”分，不按消息类型分。

因此 146 只有：

```text
1 条行情
1 条请求
1 条响应
```

当前 contract 的七通道比 146 更碎。

---

## 5. 新通道模型

固定为五条：

```text
1001 MARKET_DATA
2001 COMMAND
2003 EXECUTION
2004 STATE
2006 VENUE_SESSION
```

### 5.1 MARKET_DATA

```text
MarketData
```

职责：

```text
行情广播
按 instrument 维护 sequence
不做交易路由
不进入订单热路径
```

### 5.2 COMMAND

```text
OrderRequest
CancelRequest
```

职责：

```text
客户端 -> venue 的交易命令
按 SBE templateId 分发
requestId 幂等
```

请求命令不需要拆成 order/cancel 两条通道。

### 5.3 EXECUTION

```text
OrderUpdate
Trade
```

职责：

```text
venue -> 客户端的执行回报
OrderUpdate + Trade 共用一条流和同一个 sequence
按 SBE templateId 分发
```

`OrderUpdate` 和 `Trade` 必须共用一条 execution stream，不能拆成两条。

### 5.4 STATE

```text
PositionSnapshot
AccountSnapshot
```

职责：

```text
venue -> 客户端的仓位/账户快照
低频
用于恢复和对账
按 snapshotId / snapshotTimestamp 校验
```

两类快照共用一条 state stream，不拆成 position/account 两条通道。

### 5.5 VENUE_SESSION

```text
VenueSession
```

职责：

```text
登录状态
结算状态
READY 状态
sourceSessionId / epoch
lastSeqByStream 高水位
```

会话流独立，因为它是交易门禁：

```text
未 READY -> 不允许发单
session 变化 -> 重置 sequence
```

---

## 6. 通道关系

```text
客户端
  -> COMMAND
    -> ORS

ORS
  -> EXECUTION
  -> STATE
  -> VENUE_SESSION

行情源
  -> MARKET_DATA
```

---

## 7. 序列语义

```text
MARKET_DATA
  每个 (venueId, exchange, instrumentId) 一条序列

COMMAND
  requestId 幂等
  不要求全局 sequence

EXECUTION
  每个 ORS/账户一条 sequence
  OrderUpdate + Trade 共用

STATE
  snapshotId / snapshotTimestamp
  不要求全局 sequence

VENUE_SESSION
  lastSeqByStream
  保存各流高水位
```

`VenueSession.lastSeqByStream` 仍保留分组结构，只减少实际使用的 stream 数量。

---

## 8. 编解码边界

```text
COMMAND
  OrderRequestCodec
  CancelRequestCodec

EXECUTION
  VenueExecutionCodec
  OrderUpdateDecode
  TradeDecode

STATE
  PositionSnapshotCodec
  AccountSnapshotCodec

VENUE_SESSION
  VenueSessionCodec

MARKET_DATA
  MarketDataCodec
```

`AccessClient` 按 `templateId` 分发，不按 stream 数量分发。

---

## 9. AccessClient 边界

一个账户/venue session 一个 `AccessClient`。

```text
发布：
  COMMAND

订阅：
  EXECUTION
  STATE
  VENUE_SESSION
  MARKET_DATA
```

`AccessClient` 仍然一次 `poll()` 处理所有订阅：

```text
poll()
  -> session
  -> execution
  -> state
  -> market data
```

`AccessListener` 保持按消息类型回调：

```text
onSession
onOrderUpdate
onTrade
onPosition
onAccount
onMarketData
```

通道减少，不改变回调语义。

---

## 10. 为什么不是三条

146 的三条是：

```text
MD
REQUEST
RESPONSE
```

新 contract 不能直接压成三条，因为：

```text
EXECUTION 是热路径
STATE 是恢复/对账路径
VENUE_SESSION 是门禁
```

三者混在一条 response 流里会造成：

```text
快照阻塞执行回报
会话 READY 被快照延迟
sequence/背压语义混杂
```

所以保留：

```text
EXECUTION
STATE
VENUE_SESSION
```

三条 venue -> client 流。

---

## 11. 为什么不是七条

`ORDER_REQUEST` / `CANCEL_REQUEST`：

```text
方向相同
消费者相同
协议相同
```

合并为 `COMMAND`。

`POSITION_SNAPSHOT` / `ACCOUNT_SNAPSHOT`：

```text
方向相同
消费者相同
都是低频快照
```

合并为 `STATE`。

所以七条是过度拆分。

---

## 12. 撤单优先级

如果以后确认：

```text
撤单不能被普通下单背压阻塞
```

再单独增加：

```text
2002 CANCEL
```

此时是六条通道：

```text
1001 MARKET_DATA
2001 COMMAND
2002 CANCEL
2003 EXECUTION
2004 STATE
2006 VENUE_SESSION
```

在没有明确证据前，不提前拆。

---

## 13. 变更范围

需要同步修改：

```text
AeronStreams
AccessConfig
AccessClient
VenueSession.lastSeqByStream
contract tests
smoke consumer
```

但消息结构、SBE 编码和字段语义不变，只改通道分配。

---

## 14. 决策

```text
DECISION:
  MARKET_DATA     1001
  COMMAND         2001
  EXECUTION       2003
  STATE           2004
  VENUE_SESSION   2006
```

`2002` 和 `2005` 在默认模型中不使用。

---

## 15. 开放问题

1. 撤单是否需要独立 `CANCEL` 通道。
2. STATE 中 position/account 快照是否允许互相阻塞。
3. COMMAND 是否需要自己的 sequence。
4. VENUE_SESSION 是否必须独立于 STATE。
5. AccessClient 的 poll 是否需要按通道设置 fragment budget。

---

## 16. 一句话

```text
Venue contract 按“方向 + 用途”分通道：
行情一条、命令一条、执行一条、状态一条、会话一条；
不按每种消息类型拆通道。
```

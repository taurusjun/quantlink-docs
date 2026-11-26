# 003 L0：ORS / Venue

- 状态：APPROVED（2026-11-24，contract 0.2.0 验收通过：190 上 contract/simvenue/fasttrade 全部 PASS）
- L1 细节以 `004-l1-ipc-transport.md` 为准；本文的 L1 流/配置段落已按 004 修订
- 日期：2026-11-23
- 范围：L0 的职责、会话、订单/回报、账户快照、行情和 L0/L1 边界
- 关联：`002-system-layers.md`

---

## 1. L0 定位

L0 是 **venue 访问运行时**：

```text
ORS 进程
  + venue session
  + venue order adapter
  + venue execution/trade 回报
  + 可选 venue account/position 查询
  + venue market data 接入
```

L0 不包含：

```text
StrategyRuntime
strategyId
strategy 路由
GUI
PnL 计算
账户级 RMS
STP（自成交检查）
```

L0 的输出是 venue 事实，不是策略事实。

---

## 2. 实例关系

```text
1 ORS 实例
  = 1 个 venue 交易账户（FIX_TRADING_ACCOUNT）
  + 1 个登录会话
  + N 个 exchange channel（N >= 1）
```

```text
1 TradingChannel（L2）
  = 1 个 exchange
  = 1 组 L2 request/response/state/session 队列
```

规则：

```text
一个 ORS 可以服务多个 exchange
每个 exchange 有独立 command/position/MD/session stream
不同 channel 不共享 response queue
OrderUpdate/Trade 是 ORS 账户级 execution stream，L1 按 exchange 分发给 L2
一个 TB 可以连接多个 ORS
一个 ORS 只绑定一个 venue 交易账户
请求里的 accountId 不能切换 venue 账户
```

ORS 对 StrategyRuntime/L2 路由是隐藏的：

```text
L2 只看到 ContractKey -> TradingChannelKey
L2/StrategyRuntime 不需要知道通道后面是哪一个 ORS
L1 部署配置仍知道 ORS/ORsId
```

---

## 3. L0 标识

```text
orsId           部署侧 ORS 实例标识
accountId       venue 账户
exchange        venue/exchange
environment     SHADOW / LIVE / REPLAY（contract 0.2.0）
channelKey      对应 L2 TradingChannelKey
sessionId       ORS 登录会话
sourceSessionId / sourcePublicationEpoch  会话/发布标识
```

重连时 `sourceSessionId` 变化；同一 session 内重新创建 publication 时 `sourcePublicationEpoch` 递增。

L0 不使用：

```text
strategyId
strategyKey
clientOrderId
```

`accountId` 是订单/账户字段，不是 exchange 路由键。

contract 0.2.0 只有一个账户字段 `accountId`，语义是 **venue 账户**；没有第二个 `venueAccountId` 字段。
业务账户到 venue 账户的映射留在 L1/L2，下单前校验。

单账户 ORS 必须满足：

```text
accountId == ORS 配置的 FIX_TRADING_ACCOUNT
```

如果两者不一致，不能静默下单；应拒绝或走显式账户映射。

---

## 4. 会话

### 4.1 状态

```text
DISCONNECTED
  -> CONNECTING
  -> LOGIN_SENT
  -> READY
  -> DEGRADED
  -> CLOSED
```

只有 `READY` 接受新订单。

`DEGRADED`：

```text
会话存在，但不能安全接收新单
例如：登录异常、venue 拒绝、序号缺口、回报中断
```

### 4.2 登录

ORS 登录成功后，在每个 channel 的 `sessionStream` 上发布 contract `VenueSession`：

```text
VenueSession
  venueId / accountId / orsId
  sourceSessionId / sourcePublicationEpoch
  environment / tradingDay
  loginState / settlementState / state
  adapterSessionId / reason
  snapshotTimestamp
  lastSeqByStream
```

`VenueSession` 没有 exchange 字段；channel 身份由 `sessionStream` 绑定，并由 `lastSeqByStream` 的 stream 集合校验。一个 ORS 只有一个 TraderApi 登录；front 断开时所有 channel 一起降级。

登录凭据：

```text
ORS 配置持有
不进入 GUI
不进入策略配置
不写日志明文
```

### 4.3 重连

重连后：

```text
sessionEpoch++
orderRef 空间按 epoch 隔离
未完成订单进入对账
不猜测丢失回报
```

---

## 5. 订单入口

L0 接收的订单命令只有：

```text
NEW
MODIFY
CANCEL
```

逻辑字段：

```text
requestId        幂等键，L1/TB 分配
orderRef         通道内订单引用
accountId        交易账户
exchange
instrumentId
side
offsetFlag
price
quantity
disclosedQuantity
orderType
timeInForce
timestamp
```

规则：

```text
L0 不解释 strategyId
L0 不按 accountId 选 exchange
L0 不按 accountId 切换 venue 账户
L0 不按 exchange 选 TB
accountId != FIX_TRADING_ACCOUNT 时拒绝下单
L0 只传输 L2 已解析的最终 offsetFlag，不拆分、不改写
```

`accountId` 只做账户归属；实际 venue 账户由 ORS 配置绑定。

`offsetFlag` 是 final semantics：SHFE/INE 的 `CLOSE` 表示平昨，平今必须显式
`CLOSE_TODAY`。L0 只消费 L2 给出的最终 `offsetFlag`；选择/拆分是 L2 职责，见 `005-l2-trading-channel.md`。

`clientOrderId` / `strategyKey` 属于 L2/L3，不进入 venue 协议；L0 命令与回报只使用 `orderRef`。

### 5.1 幂等

```text
requestId 在 (channelKey, sessionEpoch) 内幂等
重复 NEW 不重复下单
重复 MODIFY/CANCEL 返回同一处理结果或明确拒绝
```

如果 L1 没收到 ACK：

```text
进入 UNKNOWN / 对账
不能重发成新订单
```

---

## 6. 订单回报

L0 向 L1 发布：

```text
OrderAccepted
OrderRejected
OrderModified
OrderCancelled
TradeConfirmed
OrderError
```

逻辑字段：

```text
requestId
orderRef
exchangeOrderId?
accountId
exchange
instrumentId
status
side
offsetFlag
price
quantity
filledQuantity
lastFillPrice?
lastFillQuantity?
reason?
exchangeTimestamp?
receivedAt
```

规则：

```text
同一 requestId/orderRef 的 filledQuantity 单调不减
终态不可逆
未知回报不能按价格/数量猜订单
响应丢失进入对账，不静默丢弃
```

### 6.1 回报归属

L0 只保证：

```text
requestId/orderRef -> venue order
```

L2/L3 负责：

```text
clientOrderId -> strategyId / order
```

L0 不把 `strategyId` 写进 venue 协议。

`OrderUpdate` / `Trade` 不带 `strategyKey` / `clientOrderId`，只带 `orderRef`；两者共用同一条 execution stream 和一个 `sequence`，消费方按 SBE templateId 分发。

---

## 7. 账户与持仓边界

L0 发布：

```text
PositionSnapshot
AccountSnapshot
```

要求：

```text
至少启动后一条初始快照，之后按实现周期更新
必带 snapshotId / snapshotTimestamp / staleAfterMs
```

来源：

```text
venue account/position query
或 adapter 从执行/成交 + 行情推导
```

来源不可用时进入 `DEGRADED` 或显式标记 stale，不能静默使用旧快照。

快照是 venue 事实，不是账户真相。账户/持仓真相由上层 `AccountSnapshotService` 维护。

规则：

```text
不能把 ORS 的 AccountID 当成 venue 账户切换
不能把上层 PnL 反推成 L0 账户快照
快照过期/缺失只降级依赖快照的风控与账户视图，不把交易通道判死
消费方按 staleAfterMs 判断新鲜度，快照不是唯一账户真相
```

---

## 8. 行情

行情是独立 MD 链路，不经过 ORS 的 request/response：

```text
MD SHM -> Connector -> Strategy
```

ORS 自己也可能读 MD 做 RMS，但它不是行情源。

因此 L0 可以定义行情接入，但不要求经过 ORS：

```text
MD source -> MarketDataChannel -> L1 MARKET_DATA
```

行情逻辑：

```text
MarketDataRaw
  exchange
  instrumentId
  bids[20]
  asks[20]
  lastPrice?
  exchangeTimestamp
  sequence
  asOf
```

盘口深度固定 20 档：contract `MarketData` 的 Bids/Asks 就是 20 档，adapter 不足补 `price=0 / qty=0`，不重复、不伪造。
venue 只给 5 档时同样补零到 20 档，不降低 contract 深度。

规则：

```text
按 ContractKey 维护 sequence
行情不经过账户/策略路由
行情丢失不能伪造
v1 行情源和交易通道同主机部署；远程 MD 需要 aeron:udp，另行设计
ORS 不拥有行情事实
```

---

## 9. L0 / L1 契约

L0 对 L1 只暴露 contract 流：

```text
COMMAND        L1 -> L0   每个 exchange：order request stream（NEW / MODIFY 共流）+ cancel
EXECUTION      L0 -> L1   每个 ORS 账户一条：OrderUpdate + Trade 共用流和 sequence
STATE          L0 -> L1   每个 exchange：PositionSnapshot；每个 ORS：AccountSnapshot
SESSION        L0 -> L1   每个 exchange：VenueSession
MARKET_DATA    L0 -> L1   每个 exchange：MarketData（独立 MD 源；不要求经过 ORS）
```

`EXECUTION` 是账户级，L1 按 `OrderUpdate/Trade.exchange` 分发给 L2 的 `TradingChannel`。

ORS 不产生快照时：由 L0 adapter 或上层 `AccountSnapshotService` 从执行/成交+行情生成，仍按 contract 0.2.0 发布 `PositionSnapshot` / `AccountSnapshot`。

L0 不暴露：

```text
strategyId
strategy 状态
GUI 命令
read model
```

L1/L2/L3 负责：

```text
L1 传输：account/execution + 每 exchange channel 流和序列
L2 通道：channel 状态/orderRef/订单成交
L3 策略：clientOrderId/strategyId 归属
```

---

## 10. 失败与恢复

### 10.1 venue 断开

```text
共享 TraderApi/front 断开
  -> 该 ORS 所有 exchange channel -> DEGRADED
  -> 所有 channel 停止新单
  -> 保留未完成订单
  -> 重连后按 sessionEpoch 对账
```

exchange 级 reject/不可用：

```text
只降级对应 channel
不把其他 exchange 说成独立登录
```

### 10.2 ORS 进程崩溃

```text
对应 channel 不可用
不影响其他 ORS/channel
重启后重新登录
未完成订单对账
```

### 10.3 回报丢失

```text
不猜终态
标记 UNKNOWN
从 venue/账户查询对账
```

### 10.4 账户快照失败

```text
交易继续
账户视图降级
不把快照失败当交易拒绝
```

快照本身是 v0.2 必需消息：失败期间消费方按 `staleAfterMs` 判过期，账户/持仓视图标 stale/DEGRADED，交易会话不因此降级；恢复后立即补发初始快照。

---

## 11. 配置

ORS 配置属于部署侧，不属于策略：

```ini
ORS_ID = ors-nse-01
ENVIRONMENT = LIVE
VENUE = NSE
FIX_TRADING_ACCOUNT = OWN
BROKER_ID = ******
INVESTOR_ID = ******
PASSWORD = ******
EXECUTION_STREAM    = 55555
ACCOUNT_STREAM      = 55556

[NSE_FO]
ORDER_REQUEST_STREAM = 44444
CANCEL_REQUEST_STREAM = 44445
POSITION_STREAM     = 44446
SESSION_STREAM      = 44447
MARKET_DATA_STREAM  = 12988
```

规则：

```text
ORS 配置不写 strategyId
ORS 配置不写策略参数
TB 配置不写 ORS 密码
账户 ID 不作为 exchange 路由键
FIX_TRADING_ACCOUNT 是 venue 账户；策略 ACCOUNT 必须与它一致
```

---

## 12. 历史对照

146 对照见 `ref/003-146-ors-parity.md`。

---

## 13. 不变量

```text
1. L0 不认识 strategyId
2. L0 不按 accountId 选 exchange
3. 一个 ORS 只绑定一个 venue 账户
4. 不同 channel 不共享 response queue
5. 同一 requestId 不重复下单
6. filledQuantity 单调不减
7. 终态不可逆
8. 未知回报进入对账
9. 账户快照失败不阻止交易
10. ORS 故障只影响对应 channel
11. L0 字段语义稳定，协议实现可替换
12. L0 消息只用 orderRef，不出现 strategyKey / clientOrderId
13. contract accountId 就是 venue 账户，accountId == FIX_TRADING_ACCOUNT
14. 盘口固定 20 档，venue 不足补 price=0 / qty=0
15. PositionSnapshot / AccountSnapshot 是 v0.2 必需消息
```

---

## 14. 下一步

```text
004-l1-ipc-transport.md
  OrsAccountStream / 每 exchange ChannelStreamSet、序列、epoch、背压、断线不续传
```

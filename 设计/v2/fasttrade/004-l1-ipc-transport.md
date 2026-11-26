# 004 L1 IPC Transport

- 状态：PROPOSED（review 修订后待复审）
- 日期：2026-11-24
- 范围：L0/L1 线协议之上、L2 业务状态之前的传输行为
- 关联：`001-system-overview.md`、`002-system-layers.md`、`003-l0-ors-venue.md`、`quantlink-venue-contract` 0.2.0

---

## 1. 定位

`quantlink-venue-contract` 已经定义了 L1 的线格式：

```text
SBE schema
消息字段
Aeron stream 默认值
codec
基础 sequence guard
```

L1 不重新定义字段，只定义：

```text
流怎么分配
谁发布/谁订阅
session/epoch 怎么接受
sequence 怎么处理
背压和错误怎么办
消息怎么交给 L2
多 ORS / 多 exchange / 多 TB 怎么隔离
```

一句话：

```text
contract 是 L1 的 wire format
L1 是使用这份 contract 的 transport runtime
```

L1 是逻辑边界，不等于独立进程。v1 实现为 L2/TB 进程内库，不单独部署 LocalAgent/AccessRuntime 进程。

---

## 2. 责任边界

L1 负责：

```text
Aeron channel / stream 连接
account / execution / channel 流
SBE frame 收发
sourceSessionId / sourcePublicationEpoch 门禁
sequence / duplicate / gap 检测
每个 exchange 的 template 校验和分发
背压和发送结果
L1 指标
```

L1 不负责：

```text
订单业务状态
OrderRegistry / FillLedger
clientOrderId / strategyId 归属
PnL / 持仓 / 账户真相
策略路由
GUI 读模型
```

L1 是 L2 进程内库；L1→L2 的通知是同一 `poll` 线程上的回调，不是新的 SBE 消息。

`STATE` 只是逻辑分类：

```text
STATE = PositionSnapshot (per channel) + AccountSnapshot (per ORS account)
```

没有物理 STATE stream。

---

## 3. StreamSet

L1 分两层。

### 3.1 OrsAccountStream

每个 ORS venue 账户一套：

```text
OrsAccountStream
  orsId
  venueId
  accountId
  environment

  executionStream     L0 -> L2   OrderUpdate + Trade（账户级，一个 sequence）
  accountStream       L0 -> L2   AccountSnapshot（账户级）
```

`executionStream` 必须是 ORS 账户级，不是 exchange 级。它对应 contract 0.2.0 的“每个 ORS/账户一条 execution stream”。L1 收到 OrderUpdate/Trade 后，按消息里的 `exchange` 分发给对应 L2 `TradingChannel`。

### 3.2 ChannelStreamSet

每个 exchange 一套：

```text
ChannelStreamSet
  orsId
  venueId
  accountId
  environment
  exchange
  tradingChannelKey

  sessionStream         L0 -> L2   VenueSession（exchange/channel 级）
  orderRequestStream    L2 -> L0   OrderRequest + ModifyRequest
  cancelRequestStream   L2 -> L0   CancelRequest
  positionStream        L0 -> L2   PositionSnapshot
  marketDataStream      L0 -> L2   MarketData
```

规则：

```text
一个 ORS 账户一个 OrsAccountStream
一个 ORS 的每个 exchange 一个 ChannelStreamSet
每个 ChannelStreamSet 有自己的 VenueSession/sessionStream
不同 exchange 不共享 session/order/cancel/position/market-data stream
不同 ORS 不共享 execution/account/command stream
OrderRequest 和 ModifyRequest 共用一个 order request stream，按 templateId 分发
CancelRequest 单独一条 stream
OrderUpdate 和 Trade 共用 OrsAccountStream.executionStream 和一个 sequence
```

L2 的 `TradingChannelKey` 与 `ChannelStreamSet.tradingChannelKey` 一一对应。L1 不在 command 路径按 `exchange` 二次路由；command 按 `tradingChannelKey` 选 channel stream。execution 路径按消息的 `exchange` 分发给 L2。

`AeronStreams` 的 1001/2001..2006 是单 exchange ORS 的默认值；多 ORS/多 exchange 必须显式分配，不能自动发现。

---

## 4. Frame

L1 直接收发 contract SBE frame：

```text
MessageHeader
  blockLength
  templateId
  schemaId
  version
payload
```

规则：

```text
schemaId 必须 = 1
version 必须 = 1（contract 0.2.0）
不额外包 strategyId / account routing envelope
不修改 payload
不把 SBE frame 再包 JSON
```

每条流只接受允许的 template：

```text
orderRequestStream    OrderRequest | ModifyRequest
cancelRequestStream   CancelRequest
executionStream       OrderUpdate | Trade
positionStream        PositionSnapshot
accountStream         AccountSnapshot
sessionStream         VenueSession
marketDataStream      MarketData
```

未知 template、schemaId/version 不符、跨流 template 都进入 malformed/quarantine，不进入 L2。

---

## 5. Session 和 Epoch

L0 在每个 channel 的 `sessionStream` 上发布 `VenueSession`。字段以 contract 为准，包括：

```text
venueId
accountId
orsId
sourceSessionId
sourcePublicationEpoch
environment
tradingDay
loginState
settlementState
adapterSessionId
state
reason
snapshotTimestamp
lastSeqByStream
```

L1 规则：

```text
只有该 channel 的 VenueSession READY 才允许向该 channel 发 COMMAND
新 session/epoch 到达时，旧 session/epoch 的消息进入 quarantine
旧 epoch 的迟到 frame 不进入 L2 状态机
不把旧 session 的 seq 接到新 session
VenueSession 不含 exchange 字段；channel 身份由 sessionStream 绑定
```

### 5.1 channel readiness

按 contract 枚举完整映射：

```text
channelReady =
  state == READY
  && loginState == UP
  && settlementState == SETTLED

channelDegraded =
  loginState == DEGRADED
  || state == LOST
  || settlementState == FAILED

channelBlocked =
  state == STARTING
  || state == REPLAYING
  || loginState == DOWN
  || loginState == CONNECTING
  || settlementState == NONE
  || settlementState == PENDING
  || settlementState == SETTLING
```

未列出的组合一律 blocked，不能默认 ready。

v1 要求 L0 把“无结算阶段/不需要结算”的 venue 归一到 `SETTLED`；`NONE` 只表示尚未完成初始化，不能直接交易。`DEGRADED` 是 `loginState` 的值，不是 `VenueSessionState` 的值。

truth table 必须覆盖所有 enum 组合，并至少测：

```text
READY + UP + SETTLED -> ready
READY + DOWN + SETTLED -> blocked
READY + UP + NONE -> blocked
READY + UP + FAILED -> degraded
LOST + UP + SETTLED -> degraded
STARTING + UP + SETTLED -> blocked
```

### 5.2 共享 TraderApi 的现实

一个 ORS = 一个 venue 账户 = 一个 TraderApi/MdApi 会话。`ChannelStreamSet` 的 session 是逻辑 channel 状态，不表示每个 exchange 有独立登录：

```text
front/transport 断开 -> 该 ORS 所有 channel 全部 DEGRADED
exchange 级 reject/不可用 -> 只降级对应 channel
```

L1 不得把“一个 exchange 还能交易”建立在共享登录已断开的基础上。

### 5.3 channel 身份校验

由于 `VenueSession` 没有 `exchange`/`tradingChannelKey`，L1 必须校验：

```text
venueId/accountId/orsId/environment 与 ChannelStreamSet 配置一致
同一 ORS 账户的所有 channel session 必须共享
  venueId/accountId/orsId/environment/sourceSessionId/sourcePublicationEpoch
lastSeqByStream 只包含 ORS executionStream + 该 channel 的 marketDataStream
order/cancel/position/session/account stream 没有 seq，不得列入 lastSeqByStream
各 channel 的 execution 高水位按 stream 单调；不得低于 lastDeliveredSeq
```

不同 channel 的 execution 高水位不要求相等；session 快照时间不同会造成正常偏差。任何 account/session/epoch 不一致都降级整个 ORS，而不是只降级一个 channel。

这个校验能发现错流/错配置；它不能替代 publisher 正确配置，不能检测“key 集合完全正确但语义写错”的人为错误。

### 5.4 VenueSession 字段来源和用途

`VenueSession` 由 L0/ORS adapter 生成和发布，L1 只消费、校验，不重新赋值。

| 字段 | 来源 | 用途 |
|---|---|---|
| `venueId` | ORS 配置 | venue 身份；拒绝跨 venue 消息 |
| `accountId` | ORS 配置的 `FIX_TRADING_ACCOUNT` | venue 账户；不是策略账户 |
| `orsId` | ORS 部署配置 | ORS 实例身份；运维定位，不是 L2 路由键 |
| `sourceSessionId` | L0 每次登录/重连生成 | session 命名空间；重连后变化，旧 session 消息丢弃 |
| `sourcePublicationEpoch` | L0 publication 生命周期 | publication 重建代次；同一 session 内 seq 归零时区分 |
| `environment` | 配置 | `SHADOW/LIVE/REPLAY`；防止模拟/实盘串消息 |
| `tradingDay` | CTP 登录/结算回调 | 交易日；订单、成交、快照必须同一交易日 |
| `loginState` | CTP 连接/登录/断线回调 | `DOWN/CONNECTING/UP/DEGRADED`；判断共享登录可用性 |
| `settlementState` | CTP 结算确认回调 | `NONE/PENDING/SETTLING/SETTLED/FAILED`；只有 `SETTLED` 可交易 |
| `adapterSessionId` | L0 adapter 生成，例如 CTP `FrontID + SessionID` | 人看/排障；不参与 L1 路由和 sequence |
| `state` | L0 状态机聚合 | `STARTING/READY/REPLAYING/LOST`；channel 逻辑状态 |
| `reason` | L0 错误/状态说明 | 为什么不是 READY；日志和人工排障 |
| `snapshotTimestamp` | L0 生成会话快照的时间 | L1 只接受更新的 session 快照，旧快照不能覆盖新状态 |
| `lastSeqByStream` | L0 各发布流的 sequence 高水位 | L1 检测 gap、触发对账；不能直接推进已交付序号 |

关键区别：

```text
venueId    = 哪个 venue / SimNow
exchange   = 哪个交易所 / SHFE、DCE
accountId  = venue 交易账户
tbId       = FastTrade TradeBot
strategyId = 策略
orsId      = 哪个 ORS 进程
```

这些字段控制：

```text
身份校验：venue/account/environment/ors 匹配当前 stream set
交易门禁：state READY + login UP + settlement SETTLED
重连隔离：session/epoch 变化后旧消息不能进入新状态
缺口检测：lastSeqByStream 只列有 seq 的 execution + market data
快照排序：snapshotTimestamp 只排 VenueSession，不排订单
```

---

## 6. Sequence

### 6.1 Execution

```text
OrderUpdate 和 Trade 共用 OrsAccountStream.executionStream 的 sequence
```

L1：

```text
按 (venueId, accountId, sourceSessionId, sourcePublicationEpoch) scope
重复 sequence + 相同 payload -> 丢弃
重复 sequence + 不同 payload -> 协议违规，quarantine + 整个 ORS degraded
缺口 sequence -> 标记 gap + 通知 L2，不伪造/不重排
未知 orderRef -> 原样交给 L2，L1 不建立订单状态
```

同一个 execution stream 内有多个 exchange 的消息；sequence 是账户级，不能按 exchange 各自比较。

缺口恢复：

```text
L1 只标记 gap，不主动补洞
L2 收到 gap 后通过订单/成交查询、快照和 venue query 对账
L1 不重放历史
```

### 6.2 MarketData

```text
每个 (venueId, exchange, instrumentId, sourceSessionId, sourcePublicationEpoch) 一条 sequence
```

L1：

```text
重复 -> 丢弃
缺口 -> 标记 stale/gap
session/epoch 变化 -> 重置该 instrument 的 sequence guard
旧 session/epoch 的 tick -> 丢弃
行情可合并/丢弃旧 tick，但不能把旧 tick 当新
```

行情源重连后 `seq` 归零是正常的；不得把新 `seq=1` 当成旧 session 的重复。

### 6.3 Session 高水位

`VenueSession.lastSeqByStream` 只包含真正有 sequence/seq 的流：

```text
ORS 的 execution stream（没有事件时写 0）
该 channel 的 marketData stream（没有 tick 时写 0）
```

order/cancel/position/session/account stream 没有 seq 字段，不得列入。

L1 按 stream 维护两个值：

```text
lastDeliveredSeq[streamId]   本消费者已经交给 L2 的最高序号
sessionHighWater[streamId]   VenueSession 报告的发布端高水位
```

规则：

```text
高水位只用于判断 gap 和触发对账
不用高水位直接推进 lastDeliveredSeq
不把未交给 L2的 91..100 静默跳过
execution 和每个 market data stream 分别维护
```

---

## 7. COMMAND 路径

L2 -> L1：

```text
OrderRequest
ModifyRequest
CancelRequest
```

规则：

```text
OrderRequest/ModifyRequest：目标 channel VenueSession READY 后才发送
STP 由 L2 负责（默认关闭）；L1 只传输 COMMAND，不重复检查
CancelRequest：publication 已连接即可，DEGRADED 时允许用最后已知 session 尝试撤单
orderRef 由 L2 分配，L1 不改
requestId 原样透传
sourceSessionId/sourcePublicationEpoch 由 L2 按当前/最后已知 channel session 填写
L1 不改写 session/epoch
L2 传入目标 tradingChannelKey
L1 用 tradingChannelKey 选择对应 ChannelStreamSet
L1 不按 strategyId/accountId/exchange 二次路由
```

L1 必须拒绝以下 command，返回 `NOT_RETRYABLE`：

```text
sourceSessionId/sourcePublicationEpoch 与当前或最后已知 channel session 不一致
venueId/accountId/environment 与 AccessConfig 不一致
exchange 与目标 ChannelStreamSet.exchange 不一致
tradingChannelKey 未知
```

身份校验和路由是两件事：路由仍按 `tradingChannelKey`，但 payload 的 `exchange` 必须与目标 channel 一致。Cancel 在 DEGRADED 时只保证“尝试发出”，不保证 venue 受理。

### 7.1 SubmitResult

L1 暴露同进程结果，不新增 wire 消息：

```text
ACCEPTED        已提交到 Aeron transport，不是订单 ACK
RETRYABLE       同一 session/epoch 内可重试
NOT_RETRYABLE   不可重试，需对账/人工处理
```

Aeron offer 映射：

```text
SUCCESS          ACCEPTED
BACK_PRESSURED   RETRYABLE（同一 session/epoch）
NOT_CONNECTED    同一 session/epoch 内 RETRYABLE；session 已失效则 NOT_RETRYABLE
ADMIN_ACTION     NOT_RETRYABLE
CLOSED           NOT_RETRYABLE
```

规则：

```text
L1 不在内部重试交易命令
L1 不因重试改变 requestId/orderRef
L2 只能在同一 (tradingChannelKey, sourceSessionId, sourcePublicationEpoch) 内重试
epoch 变化后订单状态置 UNKNOWN，对账，不重发
ACCEPTED 不能当作订单已到达 venue
```

### 7.2 CTP ModifyRequest

L1 只透明传输 `ModifyRequest`。CTP 不支持原子 modify，CTP L0 必须返回 `REJECTED` OrderUpdate；L2 不得用 cancel+new 模拟 modify，除非有单独的显式设计批准。

---

## 8. EXECUTION / STATE 路径

L0 -> L1 -> L2：

```text
EXECUTION -> 对应 TradingChannel -> ExecutionEventRouter（L1 按 exchange 分发）
POSITION  -> 对应 TradingChannel + AccountSnapshotService
ACCOUNT   -> AccountSnapshotService
SESSION   -> channel readiness gate
```

L1 只把 execution 交给 `TradingChannel`；`OrderRegistry` / `FillLedger` / `ExecutionEventRouter` 仍由 `TradingChannel` 驱动，L1 不绕过订单状态。

规则：

```text
L1 只做 transport、session/sequence 门禁和 exchange 分发
每个 OrderUpdate/Trade 原样交给对应 L2 TradingChannel
PositionSnapshot 跟随 channel stream
AccountSnapshot 跟随 ORS account stream（每账户一条）
L1 不把快照当订单状态
```

未知 `orderRef` 的 OrderUpdate/Trade：

```text
由 L2 缓存/对账
L1 只计数并转发，不建立 orderRef -> order 映射
不能根据价格/数量猜订单
```

### 8.1 快照

快照没有 `sourceSessionId`/`sourcePublicationEpoch`，L1 不对快照做 epoch 门禁。快照消费方必须：

```text
按 snapshotId 去重
拒绝 snapshotTimestamp 更旧的快照
超过 staleAfterMs 标记 stale
AccountSnapshotService 订阅该 ORS 每个 channel 的 PositionSnapshot
AccountSnapshot 只进入 AccountSnapshotService，不进入 TradingChannel
```

---

## 9. MARKET_DATA 路径

```text
L0/MD source -> MARKET_DATA -> MarketDataRouter
```

规则：

```text
行情按 exchange 使用独立 marketDataStream
行情生命周期独立于交易 session
交易 channel DEGRADED 不代表行情不可用
行情 ready 不等于交易 channel READY
L1 不修改 Bids/Asks；L0 负责把 CTP 5 档补零到 20 档
```

行情进 `MarketDataRouter`，不进 execution，不决定订单路由。

---

## 10. 背压和错误

### 10.1 交易流

```text
ORDER_REQUEST / CANCEL_REQUEST / EXECUTION / SESSION
不允许静默丢
```

L1 是 poll 驱动：

```text
listener 回调只在 AccessClient.poll() 线程触发
L1 不维护无界内部队列
回调必须快速返回；需要异步处理时由 L2 自己入队
L2 poll 长期跟不上 -> channel degraded + 告警
```

listener 抛异常时，L1 记录第一个异常、继续处理当前 poll 的后续 frame，并在 poll 返回前重抛。已交付给 listener 的 frame 视为已消费；L2 必须按异常类型对账，不能假设 L1 会重放。

L0 发布失败：

```text
EXECUTION/SESSION offer 失败 -> L0 标记 session DEGRADED，停止新单
POSITION/ACCOUNT snapshot offer 失败 -> 账户/持仓视图 stale，交易继续
不静默丢执行回报
```

### 10.2 行情

```text
MARKET_DATA 可以丢弃过期 tick
只有同一 instrument 已有更新的 tick 已交付/排队时才允许丢弃旧 tick
MarketDataRouter 拥有 latest-snapshot cache
必须记录 drop/lag
```

### 10.3 malformed

```text
malformed frame -> 计数 + quarantine
不崩溃整个 TB
channel stream 上反复 malformed -> 该 channel degraded
execution/account stream 上 malformed -> 无法定位 exchange，降级该 ORS 全部 channel
```

---

## 11. 重连

L1 不提供历史回放。

重连流程：

```text
transport disconnected
  -> 该 ORS 所有 channel session DEGRADED
  -> 等待该 channel 的新 VenueSession
  -> sourceSessionId 变化，或同一 session 内 sourcePublicationEpoch++
  -> 重置 sequence guard
  -> 清空旧 epoch 的 pending/quarantine
  -> L2/AccountSnapshotService 对账
```

exchange 级错误：

```text
只降级对应 channel
不把整个 ORS 说成可用
```

L1 不能：

```text
从旧 stream 读历史补洞
把旧 epoch 的回报写进新 session
自动重发订单
```

---

## 12. 多 ORS / 多 Exchange / 多 TB

```text
一个 ORS 账户 = 一个 OrsAccountStream（execution + account snapshot）
一个 ORS 的每个 exchange = 一个 ChannelStreamSet（session/order/cancel/position/MD）
一个 TradingChannelKey = 一个 ChannelStreamSet
```

多 exchange：

```text
execution stream 是账户级；L1 按 exchange 分发给 L2
session/order/cancel/position/market-data 按 exchange 分开
account snapshot 按 ORS 账户聚合，每账户一条
不允许不同 exchange 的 command/position/MD 共用 stream
```

多 ORS：

```text
ORS 之间不共享任何 stream
response queue 不共享
L1 不跨 ORS 聚合业务状态
```

v1 的 TB 归属：

```text
一个 ORS 账户的 stream set 只由一个 TB 拥有
一个 TB 可以拥有多个 ORS 账户
不同 ORS 账户的 stream set 不共享
```

如果以后要多个 TB 共享一个 ORS，必须另做 per-TB fan-out，不能直接共享 execution/account stream。

“ORS 对 TB 隐藏”只表示：

```text
StrategyRuntime/L2 路由不需要知道 ORS
L1 部署配置仍然知道 ORS/ORsId
```

L2/L4 通过：

```text
tradingChannelKey
```

定位 `ChannelStreamSet`；`orsId`/`tbId`/`strategyId` 不参与 L1 stream 选择。

---

## 13. 部署和配置

v1 使用：

```text
aeron:ipc
ORS、MD source、TB 在同一主机
每主机一个 Aeron media driver/dir
```

远程 ORS/MD 不在 v1 范围；需要时改用 `aeron:udp` 并重新定义 channel namespace。

### 13.1 配置示例

```ini
[ORS_SIMNOW_01]
ORS_ID = ors-ctp-simnow-01
VENUE_ID = SIMNOW
ACCOUNT_ID = 142266
ENVIRONMENT = SHADOW
TB_ID = tb-sim-01
AERON_DIR = /dev/shm/aeron-ql
CHANNEL = aeron:ipc
EXECUTION_STREAM = 6003
ACCOUNT_STREAM   = 6005

[ORS_SIMNOW_01.SHFE]
EXCHANGE = SHFE
TRADING_CHANNEL_KEY = CTP-SHFE
SESSION_STREAM          = 6007
ORDER_REQUEST_STREAM    = 6002
CANCEL_REQUEST_STREAM   = 6006
POSITION_STREAM         = 6004
MARKET_DATA_STREAM      = 6001

[ORS_SIMNOW_01.DCE]
EXCHANGE = DCE
TRADING_CHANNEL_KEY = CTP-DCE
SESSION_STREAM          = 6037
ORDER_REQUEST_STREAM    = 6032
CANCEL_REQUEST_STREAM   = 6036
POSITION_STREAM         = 6034
MARKET_DATA_STREAM      = 6031
```

### 13.2 Stream ID 规则

```text
每个 ORS 账户分配一个连续 block
OrsAccountStream 的 execution/account 在 block 内
每个 exchange 在 block 内分配独立子块
ACCOUNT_STREAM/EXECUTION_STREAM 也必须参与唯一性校验
启动时校验：同一 (aeronDir, streamId) 只能属于一个 StreamSet
启动时校验：没有重复 streamId，没有跨 ORS 复用
```

一个 ORS block 预留 256 个 ID，支持最多 7 个 exchange：

```text
block base = ORS_INDEX * 256
account/execution = base + 1..9
exchange N = base + N*32 + 1..31   (N = 0..6)
```

CTP 的 6 个 exchange（SHFE/DCE/CZCE/CFFEX/INE/GFEX）落在 `9 + 6*32 = 201` 个 ID 内。具体 base 由部署配置分配；L1 不自动发现，配置不一致 fail closed。

启动时还要验证最大 channel 数不超过 7；超过时必须重新分配 block，不能复用相邻 block。

---

## 14. 可观测性

L1 指标至少：

```text
framesReceived / framesSent
malformedFrames
unsupportedSchemaVersion
unknownTemplate
duplicateFrames
sequenceGaps
sessionEpochChanges
offerFailures / backpressureEvents
marketDataDrops
lastDeliveredSeq
sessionHighWater
lastFrameAt
```

v1 实现目前对 gap/malformed/backpressure 只写日志并回调，不暴露完整计数器；上表是 target，计数器接入前不要把它当成已实现。

禁止记录：

```text
password
AppID
AuthCode
完整账户配置
```

---

## 15. 测试与验收

L1 单测：

```text
old schema/version rejected
unknown template rejected
cross-stream template rejected
old epoch rejected
new epoch resets sequence
command before channel READY rejected
channel A READY / channel B DEGRADED isolated
shared front disconnect degrades all channels
execution duplicate same payload dropped
execution duplicate different payload quarantined
execution gap flagged and notified, not thrown away
market data session/epoch reset accepted
old-session market data rejected
command with stale session/epoch rejected
command payload exchange/venue/account mismatch rejected
backpressure returns RETRYABLE / NOT_RETRYABLE
L1 does not internally retry
snapshot dedupe and stale handling
malformed channel frame degrades that channel
malformed execution/account frame degrades all ORS channels
session with order/cancel/position stream in lastSeqByStream rejected
cross-channel session/epoch mismatch degrades whole ORS
same epoch different execution high-water accepted
7-channel config accepted; 8-channel config rejected
```

190 集成：

```text
C++ CTP ORS -> SBE/Aeron -> AccessClient（L1 进程内库）
每个 exchange 的 VenueSession READY 独立
MarketData 20 档
OrderUpdate + Trade 共用 ORS execution sequence
L1 按 exchange 分发给 L2
PositionSnapshot 按 channel / AccountSnapshot 每 ORS 账户一条
重连后旧 epoch 不串流
```

---

## 16. 不变量

```text
1. contract 是 L1 唯一线格式
2. 一个 ORS 账户一个 OrsAccountStream
3. 一个 ORS 的每个 exchange 一个 ChannelStreamSet
4. OrderRequest + ModifyRequest 共流，按 templateId 分发
5. CancelRequest 独立流
6. OrderUpdate + Trade 共用 ORS execution stream 和 sequence
7. 旧 schema/旧 epoch 不进入 L2
8. 交易流不静默丢
9. 行情可丢弃旧 tick，但必须有指标
10. L1 不做订单状态/策略归属
11. 没有 handshake / discovery / 历史回放
12. L1 v1 是 L2/TB 进程内库
13. AccountSnapshot 每个 ORS 账户一条
14. 快照没有 epoch 字段；按 snapshotId/timestamp/stale 处理
15. v1 只支持同主机 aeron:ipc
16. lastSeqByStream 只列 execution + market data；不列无 seq 的流
17. 同一 ORS 的所有 channel session 共享 account/session/epoch
18. execution 高水位按 channel 单调，不要求跨 channel 相等
19. 每个 ORS 账户的 stream set 只由一个 TB 拥有；一个 TB 可拥有多个 ORS
20. 每个 ORS block 最多 7 个 exchange，256 个 stream ID
21. STATE 只是 PositionSnapshot + AccountSnapshot 的逻辑分类
```

---

## 17. 已定决策

```text
1. exchange readiness：每个 exchange 一条 channel VenueSession（逻辑）
2. L1 部署：v1 做 L2/TB 进程内库
3. execution gap：L1 标记并通知 L2，L2 对账
4. 命令背压：L1 返回 RETRYABLE / NOT_RETRYABLE，L2 用 requestId 幂等重试
5. 多 TB：同一主机共享 Aeron dir，stream ID 全局唯一；每个 ORS 只由一个 TB 拥有，一个 TB 可拥有多个 ORS
6. AccountSnapshot：每个 ORS 账户一条，不按 exchange 拆
7. execution stream：每个 ORS 账户一条，L1 按 exchange 分发
8. MD sequence：包含 session/epoch，重连后重置
9. CTP ModifyRequest：L0 拒绝，L2 不模拟 cancel+new
```

---

## 18. 已知限制

```text
VenueSession 没有 exchange/tradingChannelKey 字段
  -> channel 身份靠 stream 绑定 + lastSeqByStream 校验
  -> 无法检测 key 集合完全正确但语义写错的人为错误

v1 只支持同主机 aeron:ipc
  -> 远程 ORS/MD 需要 UDP 和新的 stream namespace

每个 ORS 账户只由一个 TB 拥有；一个 TB 可以拥有多个 ORS 账户
  -> 多 TB 共享同一 ORS 需要 per-TB fan-out

快照没有 session/epoch
  -> 只能按 snapshotId/timestamp/stale 处理
```

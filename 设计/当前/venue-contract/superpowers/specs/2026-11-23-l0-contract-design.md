# L0 单合同设计

- 日期：2026-11-23
- 状态：APPROVED（2026-11-24，contract 0.2.0 验收通过）
- 仓库：`quantlink-venue-contract`
- 关联：`../../../../quantlink-fasttrade/docs/v2/003-l0-ors-venue.md`、`../../contract-fields.md`

---

## 1. 决策

用户选择：

```text
一份 contract 直接贯穿 L0
```

这里的 L0 指：

```text
ORS / venue 访问运行时
```

合同直接覆盖：

```text
L0 <-> L1 的订单、会话、成交、持仓/账户快照、行情
```

不再保留“L1 合同 + L0 内部另一套 payload”的双层字段。

---

## 2. 目标

```text
1. 同一份 SBE contract 从 L1 一直到 L0/venue
2. L0 不认识 strategyId / strategyKey
3. L0 只认 orderRef / accountId / venueId / exchange / instrument
4. 策略归因留在上层
5. 保留 requestId 幂等、session/epoch、execution sequence
6. 支持 NEW / MODIFY / CANCEL
7. PositionSnapshot / AccountSnapshot 作为必需消息
8. SimVenue 继续同时模拟 L0 和 L1
```

非目标：

```text
不在本仓库实现 ORS
不在本仓库实现 FastTrade runtime
不保留旧 clientOrderId/strategyKey 双字段兼容
不引入 handshake / schema hash
```

---

## 3. 现状问题

当前 `quantlink-venue-contract` 是 L1/L2 AccessRuntime contract，不是纯 L0：

| 问题 | 当前状态 | L0 要求 |
|---|---|---|
| 策略归因 | `OrderRequest` / `OrderUpdate` / `Trade` 有 `strategyKey` | L0 不应看到策略 |
| 订单身份 | `clientOrderId` 直接贯穿 | L0 使用 `orderRef`，`clientOrderId` 留在上层 |
| 改单 | 只有 `CancelRequest` | 需要 `ModifyRequest` |
| 账户 | 只有 `accountId` | contract 的 `accountId` 定义为 venue 账户 |
| 行情深度 | codec 固定 5 档 | L0 设计当前写 20 档，需要统一 |
| 快照 | Position/AccountSnapshot 已有 | 可选能力，146 ORS 不提供 |

---

## 4. 方案比较

### 方案 A：contract 继续只做 L1/L2

```text
L1/L2 contract（含 strategyKey/clientOrderId）
  -> L0 内部再转一套 venue payload
```

拒绝原因：

```text
用户明确要求一份 contract 贯穿 L0
双层 payload 会继续产生字段映射和归属歧义
```

### 方案 B：一份 contract 贯穿 L0（选定）

```text
L1/L2/L0 共用 venue-contract
L0 只使用 venue 字段
strategy 归因由上层维护 orderRef -> clientOrderId/strategyId
```

优点：

```text
字段边界清楚
SimVenue 可直接作为 L0 模拟器
FastTrade 与 L0 共用 codec
```

代价：

```text
breaking change
SimVenue/FastTrade 都要改
```

### 方案 C：contract 不改，L0 adapter 剥离字段

拒绝原因：

```text
contract 仍携带 strategyKey
语义上 L0 仍然“认识策略”
无法通过 contract 验收 L0 边界
```

---

## 5. 目标字段模型

### 5.1 L0 可见字段

```text
orderRef
requestId
accountId        venue 账户
venueId
exchange
instrumentId
side
offsetFlag
orderType
timeInForce
price
qty
environment
sourceSessionId
sourcePublicationEpoch
sequence
```

L0 不可见：

```text
strategyId
strategyKey
clientOrderId
```

### 5.2 账户

contract 中：

```text
accountId = venue 账户
```

上层业务账户映射由 L1/L2 维护：

```text
(orderRef) -> (clientOrderId, strategyId, business account)
```

不再在 contract 中增加第二套 `venueAccountId`；如果未来需要区分，再升版本。

### 5.3 request 里的 `accountId` 做什么

`accountId` 是 **venue 账户绑定和归属字段**，不是账户切换开关。

用途：

```text
1. 校验订单属于当前 ORS/venue 绑定的账户
2. 给 OrderUpdate / Trade / PositionSnapshot / AccountSnapshot 做归属
3. 与 venueId、requestId 一起做幂等和审计
4. 拒绝误发到错误 ORS/账户的订单
```

不用于：

```text
1. 在一个 ORS 内切换到另一个 venue 账户
2. 选择 exchange
3. 选择 TradingChannel
4. 替代 VenueSession.accountId
```

146 对照：

```text
RequestMsg.AccountID
  = 146 策略配置 ACCOUNT
  = 订单/成交/PnL 归属

FIX_TRADING_ACCOUNT
  = ORS 实际登录的 venue 账户
```

v0.2 单合同里两者统一成一个 `accountId`：

```text
accountId = venue 账户
```

如果 146 的 `ACCOUNT` 与 `FIX_TRADING_ACCOUNT` 不一致，必须在 L1/L2 做映射并在下单前校验，不能把两个账户混在一个 L0 contract 里。

---

## 6. 消息变更

### 6.1 `OrderRequest`

变更：

```text
clientOrderId -> orderRef
删除 strategyKey
```

目标字段：

```text
orderRef
instrumentId
exchange
side
offsetFlag
orderType
timeInForce
price
qty
accountId
venueId
requestId
environment
sourceSessionId
sourcePublicationEpoch
```

### 6.2 `ModifyRequest`（新增）

与 146 `MODIFYORDER` 对齐的字段集合：

```text
orderRef
instrumentId
exchange
accountId
venueId
requestId

side
orderType
timeInForce
price
qty
filledQty
disclosedQty

environment
sourceSessionId
sourcePublicationEpoch
```

字段映射：

| ModifyRequest | 146 `RequestMsg` |
|---|---|
| `orderRef` | `OrderID` |
| `instrumentId` / `exchange` | `Token` / `Contract_Description` / `Exchange_Type` |
| `accountId` | `AccountID` |
| `side` | `Transaction_Type` |
| `orderType` | `OrdType` |
| `timeInForce` | `Duration` |
| `price` | `Price` |
| `qty` | `Quantity` |
| `filledQty` | `QuantityFilled` |
| `disclosedQty` | `DisclosedQnty` |
| `requestId` | 新系统幂等键 |

规则：

```text
放在与 OrderRequest 相同的 order request stream
按 SBE templateId 分发
orderRef 必须已存在
requestId 幂等
price/qty 是修改后的目标值
filledQty 是请求方已知的累计成交，不替代 venue 回报
```

### 6.3 `CancelRequest`

变更：

```text
clientOrderId -> orderRef
```

字段：

```text
orderRef
instrumentId
accountId
venueId
exchange
requestId
environment
sourceSessionId
sourcePublicationEpoch
```

### 6.4 `OrderUpdate`

变更：

```text
clientOrderId -> orderRef
删除 strategyKey
```

保留：

```text
exchangeOrderId
status
cancelState
filledQty / remainingQty
avgPrice
reason / errorCode
tradingDay
exchangeTimestamp / ingestTimestamp
requestId
sequence
side / offsetFlag / orderQty / price
accountId / venueId / exchange / environment
sourceSessionId / sourcePublicationEpoch
```

### 6.5 `Trade`

变更：

```text
clientOrderId -> orderRef
删除 strategyKey
```

保留：

```text
tradeId
exchangeOrderId
sequence
instrumentId / exchange
side / offsetFlag
price / qty
exchangeTimestamp / ingestTimestamp
tradingDay
fee / feeKnown
requestId
accountId / venueId / environment
sourceSessionId / sourcePublicationEpoch
```

### 6.6 `VenueSession`

保持不变：

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

### 6.7 `PositionSnapshot` / `AccountSnapshot`

v0.2 保留为 **必需消息**：

```text
PositionSnapshot
AccountSnapshot
```

要求：

```text
L0/venue 必须发布
至少启动后一条初始快照
之后按实现周期更新
必须带 snapshotId / snapshotTimestamp / staleAfterMs
```

146 ORS 本身不提供快照；接 146 ORS 时，L0 adapter 必须从可用来源生成或明确让会话进入 DEGRADED，不能静默不实现。

消费方必须按 `staleAfterMs` 判断新鲜度；快照仍不是唯一账户真相。

### 6.8 `MarketData`

保留独立行情流。

v0.2 固定：

```text
20 档
```

变更：

```text
MarketDataCodec.DEPTH 5 -> 20
SimVenue 行情生成最少提供 20 档（不足补 0）
测试覆盖 20 档 round-trip
contract-fields.md 更新为 20 档
```

如果某个 venue 只有 5 档，未能提供的档位必须填 `price=0 / qty=0`，不能重复或伪造。

SBE 的 `Bids` / `Asks` group 本身可变；20 档由 codec 固定深度和文档约束表达。

---

## 7. 归因边界

L0 只传：

```text
orderRef
```

L1/L2 维护：

```text
orderRef -> clientOrderId
orderRef -> strategyId
orderRef -> business account
```

因此：

```text
L0 日志/回报不需要 strategyKey
OrderUpdate/Trade 不带 strategyId
策略归因不进入 venue 协议
```

---

## 8. 版本与迁移

```text
当前版本：0.1.8
目标版本：0.2.0
已发布：0.2.0（2026-11-24）
```

规则：

```text
breaking change
不保留 strategyKey/clientOrderId 双字段
不覆盖 0.1.8
SimVenue/FastTrade 固定 0.2.0
```

迁移顺序：

```text
1. 改 SBE schema 和 contract-fields
2. 改 codec/validator/tests
3. 改 SimVenue
4. 改 FastTrade access-sdk
5. 更新 L0 文档
6. 发布 0.2.0
```

---

## 9. 验收

```text
1. contract 源码/文档/生成代码不再出现 strategyKey
2. L0 消息不再出现 clientOrderId
3. OrderRequest/CancelRequest/ModifyRequest/OrderUpdate/Trade 使用 orderRef
4. ModifyRequest round-trip 通过
5. SimVenue 支持 NEW/MODIFY/CANCEL
6. one account 校验保持
7. OrderUpdate 和 Trade 共用 execution stream/sequence
8. 旧 session/epoch 的迟到消息被拒绝
9. PositionSnapshot / AccountSnapshot 必需，且带 staleAfterMs
10. MarketData 20 档 round-trip 通过
11. L0 文档、contract 文档、SimVenue 字段一致
```

---

## 10. 最终决定（已确认）

```text
MarketData       20 档；codec DEPTH 固定 20，venue 不足补 price=0 / qty=0
ModifyRequest    与 146 MODIFYORDER 对齐；与 OrderRequest 共用 request stream，按 templateId 分发
Snapshot         PositionSnapshot / AccountSnapshot 是 v0.2 必需消息，必须带 snapshotId / snapshotTimestamp / staleAfterMs
SimVenue         同时模拟 L0 + L1
L0 身份          L0 消息不出现 strategyKey / clientOrderId，订单身份只用 orderRef
```

验收记录（2026-11-24，JDK 25）：

```text
contract 0.2.0      test + publishToMavenLocal   BUILD SUCCESSFUL
simvenue            ./gradlew test               BUILD SUCCESSFUL
fasttrade           :access-sdk:test             BUILD SUCCESSFUL（17 tests, 0 failures）
```

仍待跟踪（不阻塞本次验收）：

```text
1. 旧 0.1.8 消费方切换窗口
2. 146 ORS 无快照时，L0 adapter 的 DEGRADED 规则
```

---

## 11. 结论

```text
contract 从 L1/L2 contract 升级为 L0 单合同
L0 字段 = orderRef + venue/account/instrument
strategyKey/clientOrderId 全部留在上层
新增 ModifyRequest，字段与 146 MODIFYORDER 对齐
MarketData 固定 20 档
PositionSnapshot / AccountSnapshot 是 v0.2 必需消息
SimVenue 同时模拟 L0 + L1
版本 0.2.0
```

这份文档已确认（APPROVED），contract 0.2.0 已按此实施并发布；下游 `003-l0-ors-venue.md` 已同步 20 档与快照必需。

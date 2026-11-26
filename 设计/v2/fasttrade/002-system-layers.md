# 002 系统分层

- 状态：DRAFT
- 日期：2026-11-23
- 范围：逻辑分层、依赖方向、数据/控制/交易平面、进程映射和失败边界
- 关联：`001-system-overview.md`

---

## 1. 分层目标

分层要解决四个问题：

```text
1. 谁能调用谁
2. 谁拥有交易状态
3. 谁能写订单/成交/持仓
4. GUI/账户快照如何不进入交易主链路
```

先说明：

```text
层是逻辑边界，不是进程边界
一个进程可以实现多层
一层也可以拆成多个进程
```

不能用“同进程”作为跨越边界的理由。

---

## 2. 分层原则

```text
1. 交易主链路短，观测/控制链路在旁边
2. 上层依赖下层；下层不反向调用上层
3. 事实向上发布，控制向下命令；两者都异步
4. 读模型只读，不反写交易状态
5. accountId 不参与路由；contract 的 accountId 是 venue 账户（`FIX_TRADING_ACCOUNT`）
6. strategyId 只做策略归属，不参与 exchange/contract 路由
7. 设计只描述当前系统；历史对照见 `ref/`
```

---

## 3. 逻辑分层

```text
L6  GUI
      |
L5  BotGateway
      |
L4  LocalAgent
      |
L3  TradeBot
      ├─ StrategyRuntime
      ├─ TradeBotOrderGateway
      ├─ MarketDataRouter
      ├─ OrderRegistry / FillLedger
      └─ FactPublisher
      |
L2  TradingChannel
      |
L1  IPC / Transport
      |
L0  ORS / Venue
```

旁边的账户边界：

```text
EXECUTION / TRADE（+ 可选 venue 账户/持仓查询）
  -> PositionSnapshot / AccountSnapshot（L0 必需消息，来源可为 venue 查询或 adapter 推导）
    -> AccountSnapshotService
      -> Fact / ReadModel
        -> BotGateway
```

`AccountSnapshotService` 不在交易主链路上。

---

## 4. 各层职责

### L0 ORS / Venue

负责：

```text
venue 登录/会话
实际订单执行
venue 订单/成交回报
PositionSnapshot / AccountSnapshot 发布（v0.2 必需消息）
```

快照来源可以是 venue account/position 查询，也可以由 adapter 从执行/成交 + 行情推导。
L0 不提供账户/持仓真相；快照不是账户真相。

不负责：

```text
策略身份
策略路由
GUI 数据模型
```

### L1 IPC / Transport

负责：

```text
COMMAND
EXECUTION
STATE = PositionSnapshot + AccountSnapshot（逻辑分类，无物理 STATE stream）
SESSION
MARKET_DATA
```

规则：

```text
一个 ORS 账户一条 execution stream，L1 按 exchange 分发给 TradingChannel
每个 exchange 独立 command/session/position/MD stream
一个 MarketDataChannel 一组行情流
通道之间不共享 response queue
v1 L1 是 L2/TB 进程内库
```

不负责：

```text
业务订单状态
策略归属
读模型
```

### L2 TradingChannel

负责：

```text
单通道会话/READY
orderRef 空间
OrderRegistry
FillLedger
channelEpoch
EXECUTION 回报解析
SelfTradeGuard（STP，可选，默认关闭）
```

不负责：

```text
策略决策
账户级资金
GUI
策略级持仓归属
```

`TradingChannel` 是唯一能写通道订单状态的层。

#### L2.1 SelfTradeGuard（STP，可选）

STP 默认关闭；需要时按 account/channel 开启。作用域：account + exchange + instrument；命中拒绝新单。详细流程见 `005-l2-trading-channel.md`。

### L3 TradeBot

#### L3.1 StrategyRuntime

负责：

```text
指标/信号
策略决策
OrderIntent
策略级仓位视图
```

不负责：

```text
直接写 IPC
直接调用 ORS
直接改 OrderRegistry
```

#### L3.2 TradeBotOrderGateway

负责：

```text
接收 OrderIntent
校验 strategyId
分配 clientOrderId / orderRef
选择 ContractRoute
提交给 TradingChannel
```

不负责：

```text
策略计算
venue 会话
GUI 控制
```

#### L3.3 MarketDataRouter

负责：

```text
MarketDataChannel -> StrategyRuntime
```

不参与订单路由。

#### L3.4 OrderRegistry / FillLedger

负责：

```text
订单状态权威
成交归属
channelEpoch
```

它们是交易状态，不是读模型。

#### L3.5 FactPublisher

负责：

```text
OrderFact
TradeFact
PositionSnapshot
StrategyStatusFact
StrategyTelemetryFact
SpreadTradeFact
OperationalEventFact
```

事实只发布，不回写交易状态。

### L4 LocalAgent

负责：

```text
本机采集 Fact
本地缓冲/合并
转发给 BotGateway
```

不负责：

```text
交易决策
订单路由
账户真相
```

LocalAgent 不在订单主链路；LocalAgent 挂了，交易继续。

### L5 BotGateway

负责：

```text
GUI 认证/授权
读模型查询/订阅
控制命令入口
手工单入口
ACK/审计
```

不负责：

```text
订单状态权威
成交归属
PnL 计算
交易 IPC
```

BotGateway 不是 TradeBotOrderGateway。

### L6 GUI

负责：

```text
展示
操作入口
```

不直接访问：

```text
IPC
ORS
TradingChannel
StrategyRuntime
```

---

## 5. 依赖方向

允许的调用：

```text
GUI          -> BotGateway
BotGateway   -> LocalAgent / 控制命令
LocalAgent   -> FactPublisher（异步读取）
StrategyRuntime -> TradeBotOrderGateway
TradeBotOrderGateway -> TradingChannel
TradingChannel -> IPC
IPC -> ORS / Venue
```

允许的事件回流：

```text
IPC -> TradingChannel
TradingChannel -> ExecutionEventRouter
ExecutionEventRouter -> StrategyRuntime
```

禁止：

```text
GUI -> IPC / ORS / TradingChannel
StrategyRuntime -> IPC / ORS
LocalAgent -> 订单主链路
AccountSnapshotService -> TradingChannel
ReadModel -> StrategyRuntime / OrderRegistry
BotGateway -> venue IPC
```

---

## 6. 三个平面

### 6.1 交易平面

```text
StrategyRuntime
  -> TradeBotOrderGateway
    -> TradingChannel
      -> IPC
        -> ORS
```

唯一能改变订单/成交状态的路径。

### 6.2 行情平面

```text
MarketDataChannel
  -> MarketDataRouter
    -> StrategyRuntime
```

行情不经过 BotGateway。

### 6.3 观测/控制平面

```text
TradeBot / TradingChannel
  -> Fact
    -> LocalAgent
      -> BotGateway
        -> GUI
```

控制反向：

```text
GUI
  -> BotGateway
    -> LocalAgent / Control
      -> StrategyRuntime
```

读模型只读。

---

## 7. 账户边界

L0 必须发布 contract 的 `PositionSnapshot` / `AccountSnapshot`（v0.2 必需消息，带 `snapshotId` / `snapshotTimestamp` / `staleAfterMs`）。
来源可以是 venue account/position query，也可以由 adapter 从执行/成交 + 行情推导；来源不可用时由 adapter 标记 `DEGRADED`，不能静默不实现。

```text
EXECUTION / TRADE
  + 可选 venue account/position query
    -> PositionSnapshot / AccountSnapshot（L0 必需消息）
      -> AccountSnapshotService
        -> AccountSnapshotFact / ReadModel
          -> BotGateway
            -> GUI
```

规则：

```text
contract 的 accountId 是 venue 账户；业务账户映射在 L1/L2
AccountSnapshotService 不参与订单路由
快照是必需消息；快照失败/过期只降级依赖它的账户视图和风控，不把交易通道判死
账户级风控如需要，单独接入，不塞回 TradingChannel
```

---

## 8. 进程映射

推荐部署：

```text
GUI 进程
BotGateway 进程
LocalAgent 进程（每台 TB 主机）
TradeBot 进程（每个 TB）
ORS 进程（每个账户/通道）
AccountSnapshotService 进程（可独立）
```

允许：

```text
BotGateway + LocalAgent 同机
LocalAgent + TradeBot 同机
AccountSnapshotService 与 ORS 同机
```

不允许因为同进程就绕过接口。

---

## 9. 失败边界

```text
StrategyRuntime 失败
  -> 只影响该策略

TradingChannel 失败
  -> 只影响该通道/对应订单

LocalAgent 失败
  -> 交易继续；观测数据本地缓冲或丢弃

BotGateway 失败
  -> 交易继续；GUI 不可用

AccountSnapshotService 失败
  -> 交易继续；账户视图降级

ORS 失败
  -> 对应通道不可用；不影响其他通道
```

---

## 10. 历史对照

146 对照见 `ref/003-146-ors-parity.md`，本设计不重复历史映射。

---

## 11. 核心不变量

```text
1. 只有 TradingChannel 能写通道订单状态
2. 只有 TradeBotOrderGateway 能把 OrderIntent 送到通道
3. StrategyRuntime 不能直接访问 IPC/ORS
4. GUI 不能绕过 BotGateway
5. LocalAgent 不在订单主链路
6. accountId 不参与路由
7. strategyId 不参与 exchange/contract 路由
8. 读模型不能反写交易状态
9. 事实向上发布，控制向下命令
10. 层是逻辑边界，不因同进程而消失
```

---

## 12. 未决问题

```text
1. BotGateway 与 LocalAgent 的部署边界是否固定
2. LocalAgent 缓冲上限和丢弃策略
3. TradingChannel 是否允许一个进程承载多个通道
4. AccountSnapshotService 是否与 ORS 同进程
5. Fact 发布是进程内总线还是跨进程 IPC
6. 控制命令是否需要 LocalAgent 中转，还是 BotGateway 直连 TB
```

---

## 13. 下一步

```text
003-l0-ors-venue.md
  ORS/venue 会话、订单/回报、账户快照、行情和 L0/L1 边界

004-l1-ipc-transport.md
  OrsAccountStream / 每 exchange ChannelStreamSet、序列、epoch、背压、断线不续传
```

# v3 L0-L6 分层与职责边界

- 状态：DRAFT（2026-11-26）
- 范围：逻辑分层、依赖方向、状态所有权、交易/观测平面、失败边界
- 关联：`README.md`、`ref/001-legacy-mapping.md`

---

## 1. 目标

v3 要回答四个问题：

```text
1. 谁能调用谁
2. 谁拥有交易状态
3. 谁能写订单/成交/持仓
4. 账户/读模型如何不进入订单主链路
```

原则：

```text
1. 层是逻辑边界，不是进程边界
2. 上层依赖下层；下层不反向调用上层
3. 事实向上发布，控制向下命令，二者异步
4. 读模型只读，不反写交易状态
5. accountId 是 venue 账户，不参与 exchange 路由
6. strategyId 只做策略归属，不进入 L0
7. 设计只描述当前系统；历史对照放 ref/
```

---

## 2. 分层图

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
      ├─ StrategyOrderView
      ├─ MarketDataRouter
      └─ FactPublisher
      |
L2  TradingChannel
      ├─ OrderRegistry
      ├─ FillLedger
      ├─ 平仓预扣账本
      └─ orderRef 分配
      |
L1  IPC / Transport
      |
L0  ORS / Venue
```

旁路：

```text
L0 PositionSnapshot -> L2 TradingChannel
L0 AccountSnapshot  -> AccountSnapshotService
L0 MarketData       -> L3 MarketDataRouter
L3/L2 Fact          -> LocalAgent -> BotGateway / ReadModel
```

---

## 3. 职责与不负责

### L0 ORS / Venue

负责：

```text
venue 登录/会话
实际下单/撤单
OrderUpdate / Trade 回报
PositionSnapshot / AccountSnapshot 发布
venue market data 接入
orderRef -> CTP 路由地址的 live 上下文
```

不负责：

```text
strategyId
订单查询
订单状态权威
订单记录/读模型
RMS
AUTO 开平
平仓预扣
账户/持仓真相
```

L0 的订单 map 只保留 live 路由：

```text
orderRef -> FrontID/SessionID/CTP OrderRef/OrderSysID
撤单寻址
迟到/重复回报识别
```

终态回报发布后立即删除 live 映射，不保留 tombstone。
`orderRef` 由 L2 分配；L0 不假设、不生成、不复用。

L0 的 `PositionSnapshot` / `AccountSnapshot` 是 venue fact，不是账户真相。
L0 必须提供查询并发布快照；L2 没有 CTP session，不能绕过 L0 直接查 CTP 持仓。

### L1 IPC / Transport

负责：

```text
COMMAND / EXECUTION / STATE / SESSION / MARKET_DATA
sequence / gap 标记
account 级 execution 路由
PositionSnapshot 路由到对应 TradingChannel
AccountSnapshot 路由到 AccountSnapshotService
```

不负责：

```text
订单状态
订单归属
订单对账
读模型
```

L1 不建立订单状态；未知 orderRef 不补状态。

### L2 TradingChannel

负责：

```text
单 exchange 通道会话
orderRef 分配
OrderRegistry
FillLedger
channelEpoch
AUTO 开平
平仓预扣/释放
OrderUpdate / Trade 归属
PositionSnapshot 作为预扣基线
可选 STP（默认关闭）
```

不负责：

```text
策略决策
策略级持仓归属
GUI
读模型
```

L2 是通道订单状态的唯一写入者。
终态订单从 active 订单集合移除或归档，但归档仍在 L2，不在 L0。

### L2 RiskService

风险检查从 L2 订单状态中独立出来：

```text
TradingChannel -> RiskService -> 允许/拒绝
```

负责：

```text
RMS
撤单计数
账户级/通道级预交易检查
```

不负责：

```text
订单状态写入
策略决策
venue 访问
```

RiskService 不进入 L0；L0 不认识 `strategyId`、业务账户或风控规则。

### L3 TradeBot

负责：

```text
StrategyRuntime
TradeBotOrderGateway
OrderIntent
StrategyOrderView
MarketDataRouter
FactPublisher
```

不负责：

```text
通道订单状态
orderRef
CTP 字段映射
venue 会话
```

`StrategyOrderView` 是策略归属视图，不是 L2 `OrderRegistry`。

### L4 LocalAgent

负责：

```text
Fact 采集
本地缓冲/合并
转发给 BotGateway
```

不进入订单主链路。

### L5 BotGateway

负责：

```text
认证/授权
读模型查询/订阅
控制命令入口
手工单入口
ACK/审计
```

不负责订单状态权威、成交归属、PnL 计算。

### L6 GUI

展示和操作入口。只依赖 L5。

---

## 4. 依赖方向

允许：

```text
GUI          -> BotGateway
BotGateway   -> LocalAgent / 控制命令
LocalAgent   -> Fact
StrategyRuntime -> TradeBotOrderGateway
TradeBotOrderGateway -> TradingChannel
TradingChannel -> RiskService
TradingChannel -> IPC
IPC -> ORS / Venue
ORS -> IPC EXECUTION / STATE / SESSION / MARKET_DATA
IPC -> TradingChannel
IPC -> AccountSnapshotService
IPC -> MarketDataRouter
```

禁止：

```text
GUI -> IPC / ORS / TradingChannel
StrategyRuntime -> IPC / ORS
L2/L3 -> CTP
L0 -> L2 业务状态
L2 -> AccountSnapshotService 反写
LocalAgent/ReadModel -> 订单主链路
BotGateway -> venue IPC
```

---

## 5. 状态所有权

| 状态 | 所有者 | 说明 |
|---|---|---|
| venue session | L0 | CTP 登录/结算/连接状态 |
| live orderRef -> venue 地址 | L0 | 仅撤单/回报识别，终态删除 |
| 通道订单状态 | L2 | `OrderRegistry` 唯一写入 |
| 成交账本 | L2 | `FillLedger` |
| 平仓可用/预扣 | L2 | 基于 PositionSnapshot + 在途订单 |
| orderRef 分配 | L2 | L0 只消费，不重复分配 |
| 策略订单归属 | L3 | `StrategyOrderView` |
| venue 持仓/账户 fact | L0 生产 | 不是账户真相 |
| 账户读模型/账户视图 | AccountSnapshotService | 旁路，不反写交易 |
| 订单历史/读模型 | L3 FactPublisher + L4 LocalAgent + L5 ReadModel | 旁路，不是订单权威 |
| PnL 读模型 | AccountSnapshotService / ReadModel | 不参与路由 |

### 5.1 PositionSnapshot 与账户真相

```text
L2 消费 PositionSnapshot 作为 AUTO 的 venue 基线；
L2 自己的预扣账本决定可用量；
AccountSnapshotService 维护账户层读模型；
L3 FactPublisher 发布订单/成交事实；L4 LocalAgent 采集转发；L5 ReadModel 重建订单历史和 PnL。
```

`PositionSnapshot` 过期或缺失时：

```text
L2 不启用 AUTO 平仓
不静默使用旧快照
不把 L0 判死；交易通道的 READY 由 L0 session 决定
```

`AccountSnapshot` 只进 AccountSnapshotService；L2 不直接用它做订单路由。
如果 RiskService 需要保证金，由 RiskService 订阅账户快照，不反写 L2 订单状态。

---

## 6. 交易主链路

```text
L3 OrderIntent
  -> L2 映射 venueAccountId
  -> L2 分配 orderRef
  -> L2 读 PositionSnapshot + 预扣
  -> L2 AUTO/offset
  -> L2 RiskService
  -> L2 OrderRegistry pending
  -> L1 COMMAND
  -> L0 ORS
  -> CTP
```

回报：

```text
CTP -> L0 OrderUpdate/Trade
  -> L1 EXECUTION
  -> L2 OrderRegistry/FillLedger
  -> L3 StrategyOrderView
```

---

## 7. 失败边界

```text
L0 session 断开
  -> VenueSession LOST
  -> epoch 递增
  -> L2 不重发/不伪造订单
  -> 重新登录后 L0 发布 READY
  -> L2 用 PositionSnapshot/OrderUpdate/Trade 对账
  -> 不把“查询失败”当成订单状态
```

```text
PositionSnapshot 过期
  -> 不启用 AUTO
  -> 账户视图降级
  -> 交易通道不被判死

AccountSnapshot 过期
  -> AccountSnapshotService 降级
  -> 不影响 L2 订单状态

LocalAgent/ReadModel 失败
  -> 读模型降级
  -> 不影响订单主链路
```

---

## 8. 不变量

```text
1. 只有 L2 能写通道订单状态
2. 只有 L3 TradeBotOrderGateway 能送 OrderIntent
3. orderRef 由 L2 分配；L0 不生成、不复用
4. 一笔 OrderIntent 只生成一笔 OrderRequest
5. 每笔 OrderRequest 只有一个最终 offsetFlag
6. FILLED 不早于 Trade
7. 终态订单从 L2 active 集合移除或归档
8. L0 终态 live 映射立即删除
9. L0 不做订单查询/订单状态/RMS
10. AccountSnapshotService/ReadModel 不反写交易
```

---

## 9. 当前实现对应的 L0 约束

```text
ORS 只接受 --config PATH
身份/stream 全部配置驱动
CTP 回调 -> contract 0.2.0 -> Aeron
account/position 查询 -> 快照发布
order query / CtpReconciler 不在 runtime
unknown report 丢弃
终态 live 映射删除
```

L0 仍需补齐的生产问题不在本文展开，见 ORS 仓库的 plan/acceptance。

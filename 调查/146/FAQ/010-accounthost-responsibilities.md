# AccountHost 具体干什么？

> 完整设计、异步持久化和 146 对比见 `012-accounthost-design-and-146-comparison.md`。

## 一句话

`AccountHost` 是**一个账户的交易前台/账户网关**：所有策略的下单、撤单、成交回报、`clientOrderId`、订单/仓位落库、账户对账和账户级风控都从这里过。

它**不跑策略**，也不做行情指标。

```text
StrategyProcess A ─┐
StrategyProcess B ─┼─ OrderIntent ─> AccountHost ─> AccessClient ─> ORS
StrategyProcess C ─┘                     │
                                         ├─ clientOrderId / DB
                                         ├─ order_state / strategy_position
                                         ├─ execution/trade 路由
                                         ├─ 账户快照对账
                                         └─ 账户级风控
```

## 它具体负责的事

| 职责 | 说明 |
|---|---|
| 持有唯一 `AccessClient` | 一个 Account 只有一个账户会话、一个订单发布者 |
| 接收订单意图 | 从各 `StrategyProcess` 通过本机 IPC 收 `OrderIntent` / `CancelIntent` |
| 分配 `clientOrderId` | 从 DB 的账户级 counter 原子分配；策略进程不能自己生成 |
| 订单落库 | 发单前先写 `PENDING`；撤单前先写 `CANCELING` |
| 发单/撤单 | 通过 `AccessClient` 发给 ORS；不直接操作交易所 |
| 接收执行回报 | 订阅 ORS 的 execution/trade；按 `clientOrderId` 找到 `strategyKey` |
| 路由回报 | 把成交/订单事件只回给所属的 `StrategyProcess` |
| 维护订单/仓位账本 | 统一写 `order_state`、`strategy_position`；策略进程只保留内存视图 |
| 账户对账 | ORS 的账户/持仓快照 vs 各策略仓位之和；不一致就 fail closed |
| 账户级风控 | 账户敞口、订单频率、单笔上限等；策略级风控仍在策略进程 |
| 故障清理 | 某策略崩溃时，撤销该策略的 open order；其他策略继续 |
| 生命周期门禁 | ORS/AccessClient 未 READY、对账未通过时，不允许 arm/发单 |

## 它不负责的事

- 不计算信号、不决定买卖方向/价格/数量。
- 不实现 `Strategy`，不持有策略参数。
- 不做行情指标计算，也不把行情逐笔转发给策略。
- 不 seed 策略仓位；账户快照只用于对账。
- 不替代 ORS，不直接和交易所/CTP 会话交互。
- 不做 GUI；只向 `BotGateway` 提供健康/状态。

> 行情由各 `StrategyProcess` 只读订阅（或走独立行情总线）；`AccountHost` 的职责是账户交易链路，不是行情分发中心。

## 一笔订单的实际路径

```text
1. Strategy A 产生意图：
   OrderIntent(strategyKey=A, instrument=rb2601, side=BUY, qty=1, price=3500)

2. AccountHost：
   - 账户级风控
   - DB 分配 clientOrderId，例如 100045
   - INSERT order_state = PENDING
   - AccessClient.submit(...)

3. ORS 回报成交：
   Execution(clientOrderId=100045, fill qty=1, price=3500)

4. AccountHost：
   - 用 clientOrderId 反查 order_state，得到 strategyKey=A
   - UPDATE order_state = FILLED
   - UPDATE strategy_position(A, rb2601) += 1
   - 把 FillEvent 只路由给 Strategy A

5. Strategy A：
   - 更新自己的内存 PositionBook
```

如果成交的 `clientOrderId` 在 DB 里找不到，就是账户级 orphan，不能随便路由给某个策略；应告警并对账。

## 为什么不让每个 StrategyProcess 自己持有 AccessClient

如果 N 个策略各有一个 `AccessClient`：

- 同一账户会有 N 个会话/N 个订单 publication；
- `clientOrderId` 分配、READY 状态、撤单、账户快照、对账都要做 N 份；
- 成交回来时，很难判断应该归哪个策略；
- 策略崩溃时，无法统一撤销该策略的挂单；
- 账户级风控和净仓对账会分散。

所以让 `AccountHost` 做**账户内唯一的订单写入口**，策略进程只发意图、收自己的回报。

## 和 ORS、AccessClient 的区别

| 组件 | 角色 |
|---|---|
| ORS | 真正的订单路由/柜台会话服务；每 Account 一个 |
| `AccessClient` | ORS 的客户端 SDK/传输适配器；Aeron 订阅/发布 |
| `AccountHost` | FastTrade 的账户业务层；订单入口、状态、对账、风控、路由 |
| `StrategyProcess` | 一个策略的逻辑和内存仓位；只发意图、收自己的成交 |

## 故障边界

- 单个 `StrategyProcess` 崩溃：`AccountHost` 撤该策略挂单，其他策略继续。
- `AccountHost` 崩溃：该账户所有策略停单；supervisor 重启后恢复、撤单、对账；其他账户不受影响。
- ORS 崩溃：该账户停交易；`AccountHost` 保持 disarmed，重连后重新对账。
- 对账失败：账户保持 disarmed，不允许新单。

## 关键结论

`AccountHost` 不是“策略容器”，而是**账户交易链路的唯一协调者**：

```text
策略只负责“想做什么”
AccountHost 负责“这个账户怎么做、做到哪、状态是什么”
ORS 负责“真正送到哪里”
```

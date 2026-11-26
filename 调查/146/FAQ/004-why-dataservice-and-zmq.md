# 为什么数据源要分成 DataService 和 ZMQ？

## 短答

因为两条链解决的不是同一类问题，而且是历史分层叠加出来的：

- **ZMQ**：GUI ↔ 单个策略进程的**控制/遥测面**（Connect、Start/Stop、参数、FairValue、报价/成交计数、心跳）。
- **DataService**：GUI ↔ 交易系统的**市场/账户/订单数据面**（行情、持仓、挂单、订单回报、成交、PNL、手工单）。

不是重复造两条数据源，而是把“策略私有状态”和“交易公共事实”分开。

## 1. ZMQ 是什么

```text
GUI 策略表
  -> ZMQ PUSH 15300+row
  -> 策略 StrategyMsgHub PULL bind 15300+row

策略
  -> ZMQ PUSH localhost:15213
  -> GUI GuiMsgHub PULL bind 15213
```

特点：

- 每个策略一个端口；
- 消息是小型 ASCII：`port|key#value`；
- 命令：`connectRequest`、`startOrStop#true/false`、`bidEdge#0.5` 等；
- 回传：`initComplete`、`status`、`bidPrice/askPrice`、`bidFills/askFills`、FairValue、heartbeat；
- **PUSH/PULL、fire-and-forget**：无 ACK、无请求/响应、无查询/历史，`ZMQ_DONTWAIT` 可能丢命令；
- 数据所有权在**策略进程**：只有策略知道自己的 `enableFlag`、参数、FairValue、报价/成交计数。

## 2. DataService 是什么

```text
GUI
  -> MDCollector / PNLCollector / OrdersCollector / DataCollector
  -> TCP DataService
  -> ORS / 行情 / 账户 / 订单
```

承载：

- 行情：`MDCollector`；
- 持仓/PNL：`PNLCollector`、`NetPnlModel`；
- 挂单/订单回报：`OrdersCollector`、`OpenOrder`、`OrderResponse`；
- 成交：`FillResponse`；
- 手工单/撤单/平仓：`ManualOrderSender` → `ManualOrderCommand` → DataService → ORS。

特点：

- 共享数据服务，多个 GUI/工具可消费；
- 数据所有权在 **ORS/柜台/DataService**，不是某个策略进程；
- 支持登录、查询、命令、回执；
- 策略挂了，DataService 仍可提供已有行情/持仓/订单/PNL。

## 3. 为什么分开

| 维度 | ZMQ | DataService |
|---|---|---|
| 数据 | 策略私有状态/参数/FV/成交计数 | 市场行情、账户持仓、订单、成交、PNL |
| 所有权 | 策略进程 | ORS/DataService |
| 消息 | 小、事件、ASCII | 大/高频、结构化、请求/响应 |
| 语义 | fire-and-forget | 登录、查询、命令、回执 |
| 扇出 | 每个策略一个点对点端口 | 多 GUI/多消费者共享 |
| 生命周期 | 策略重启就断 | 独立于策略，可继续提供已有数据 |
| 安全/运维 | 单独控制通道 | 单独数据/手工单通道 |

具体原因：

1. **所有权不同**：策略参数/`enableFlag` 只有策略知道；行情/持仓/订单只有 ORS/DataService 知道。
2. **生命周期不同**：策略崩溃/重启时，GUI 仍应能看到行情、账户持仓、已有订单；不能因为某个策略挂了就整个面板空白。
3. **数据量和频率不同**：行情/订单/成交是高频、共享、可缓存；策略参数/心跳是低频、点对点。
4. **交互语义不同**：手工单需要 New/Cancel/Modify/CancelAll 命令和回执；ZMQ PUSH/PULL 没有请求/响应，不适合做可靠交易指令通道。
5. **历史复用**：Qt4 `TradingSystemsGUI` 已经用 DataService 做行情/持仓/手工单；Qt5 `SkylineFL_GUI` 复用了这些采集器，又额外加了 ZMQ 策略表。
6. **故障隔离**：DataService 挂了，策略可能还在跑；ZMQ 挂了，DataService 的行情/持仓仍可看。

## 4. 代价

- **两套时间/序列**：ZMQ 的策略报价和 DataService 的行情/成交没有统一序号，排障要自己对时。
- **局部视图**：ZMQ 断了但 DataService 还在，GUI 会显示“行情/持仓正常，但策略状态不动”。
- **语义重叠**：ZMQ 也发 `bidPrice/askPrice/bidFills/askFills`，DataService 也有行情/成交；相关但不是同一权威源。
- **两套安全边界**：ZMQ 无认证、DataService 也有自己的连接/权限问题。
- **运维复杂**：两个端口/进程/日志，缺一个就是半边瘫。

## 5. 如果重做

保留“两个平面”的思路，但统一消息信封：

```text
strategy_id / instrument / seq / timestamp / source / version
```

- 控制命令加 ACK/幂等；
- 数据面统一快照 + 增量；
- 策略状态和数据面共享同一套 `strategy_id/instrument` 键；
- 这样既保留隔离，又减少对账和排障成本。

## 证据

- `146/03-qt-gui.md` §3（ZMQ 拓扑/协议）
- `146/03-qt-gui.md` §5（数据流与状态）
- `3/dalong/FromDaya/SkylineFL_GUI/GuiMsgHub.cpp:25-95`
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/StrategyMsgHub.cpp:7-118`
- `3/dalong/infrastructure/TradingSystemsGUI/ManualOrderSender.cpp:24-80`
- `3/dalong/infrastructure/TradingSystemsGUI/DataCollector.cpp`、`MDCollector.cpp`、`PNLCollector.cpp`、`OrdersCollector.cpp`

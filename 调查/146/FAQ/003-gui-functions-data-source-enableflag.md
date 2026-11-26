# GUI 的功能、数据来源、是否集中管理、enableFlag 前后行为、交易员视角

## 原问题

> GUI 的功能是什么？数据来源是哪里？是否是集中了所有的策略进程在面板上进行管理？GUI 对策略只是进行手工交易和设置 enableFlag 吗？设置 enableFlag 前，是需要显示指标/行情等交易实时信息，并且需要提醒交易员可以进行 set flag 吗？enableFlag 后，策略会继续自动交易了，还是说 enableFlag 会变成 false，然后仍然等待下一次交易员来激活呢？假设从交易员的角度，他能在 GUI 上能获取哪些信息，然后进行什么交易操作呢？

## 先限定：哪套 GUI？

146 里有两套：

- **Qt4 `TradingSystemsGUI`**：历史启动命令用的那套；主要是按交易所分 tab 的手工交易/持仓/PNL 界面，不是按策略管理的面板。
- **Qt5 `SkylineFL_GUI`**：有策略表，通过 ZMQ 管理 `3/leon/CL/SHSH*` 策略；不管理 `TradeBot_China` 的 `enableFlag`。

下面的“策略表/enableFlag”主要指 Qt5 `SkylineFL_GUI`。

---

## 1. GUI 的功能是什么？

### A. 策略管理

- Connect：发 `connectRequest`，策略回传初始参数/合约/组名，置 `connectGUIFlag=true`。
- Start：发 `startOrStop#true`，策略 `enableFlag=true`，开始自动报价/发单。
- Stop：发 `startOrStop#false`，策略 `resetStrategy()`，`enableFlag=false`。
- 参数修改：`bidEdge`、`askEdge`、`bidSize`、`askSize`、`bidSlope`、`askSlope`、`bidLean`、`askLean`、FairValue 等；滚动条每动一次发一条 `字段#值`。
- Lock/Unlock：**本地 UI 锁**，断开 Start 按钮和盘口点击下单，防误点；不改变策略 `enableFlag`。
- 心跳/连接状态：策略每约 3 秒发 heartbeat；GUI 用它判断连接/断线。

### B. 交易信息展示

- 策略表：Bid/Ask FairValue、Size、Edge、Slope、Lean、报价、成交数量、状态。
- FairValue 窗口：FV、FVMA 等。
- 合约窗口：盘口、点击价格下单、改单/撤单。
- 持仓、挂单、订单回报、成交、PNL、Console 日志。
- 保存持仓 CSV。

### C. 手工交易

- 手工新单/改单/撤单；
- Cancel All；
- Square Off All（按持仓逐个生成平仓单）；
- 但不能直接指定成交/成交价；成交仍由 ORS/交易所完成。

---

## 2. 数据来源是哪里？

| 数据 | 来源 | 说明 |
|---|---|---|
| 策略状态、心跳、FairValue、报价、成交数量、参数初值 | **策略 → GUI 的 ZMQ** | 策略 `StrategyMsgHub` PUSH → GUI `15213` PULL；GUI PUSH → 策略 `15300+` |
| 行情、持仓、挂单、订单回报、成交、PNL | **DataService TCP** | `MDCollector`/`PNLCollector`/`OrdersCollector`/`DataCollector` |
| 手工单/撤单/平仓 | **DataService TCP** | `ManualOrderSender` → `ManualOrderCommand` → DataService → ORS |
| 策略列表/端口/GUI 配置 | **本地 `GuiSettings.xml`** | 策略名、端口、交易所 |
| 策略参数初值 | **策略进程** `sendIniMsg()` | `initBidFairValue`、`initAskFairValue`、`init*Edge/Size/Slope/Lean` |
| 心跳 | **策略进程** `StrategyMsgHub` | 每 3 秒 `port|heartBeat#port` |

关键：**ZMQ 管策略控制/状态；DataService 管行情/持仓/订单/成交/PNL/手工单。两条链是分开的。**

---

## 3. 是否集中了所有策略进程在面板上管理？

**Qt5 `SkylineFL_GUI`：是“集中管理它配置的那些策略”。**

- `GuiSettings.xml` 列出策略名/端口（15300–15333）。
- `Container` 为每个策略建一行，`GuiMsgHub` 为每个端口建一个 PUSH socket，PULL 统一 bind 15213。
- 策略侧 `StrategyMsgHub` bind 自己的端口、PUSH 回 15213，并每 3 秒心跳。
- 所以一个 GUI 进程可以看/控制多个 `leon/CL/SHSH*` 策略。

但：

- 不是自动发现；端口/策略必须在 `GuiSettings.xml` 里配置。
- **不管理 `TradeBot_China/TradeBot`**：该源码没有 bind 15300+ 的 `StrategyMsgHub`；它靠 `RunStrategies.sh`、control/model、`SIGUSR1`/`SIGTSTP`。
- **Qt4 `TradingSystemsGUI` 不是按策略集中管理**：它是按交易所 tab + 手工单/持仓/PNL。

---

## 4. GUI 对策略只是“手工交易 + 设置 enableFlag”吗？

不是。GUI 对策略的控制面是：

```text
Connect / Start / Stop / 参数修改
```

加上展示/心跳/本地 Lock；手工交易是另一条 DataService 链，不是 enableFlag。

它不能：

- 直接改策略内部订单；
- 指定成交价/成交量；
- 绕过 ORS/交易所；
- 用 Lock 停止策略（Lock 只是 UI 防误点）。

---

## 5. 设置 enableFlag 前，会显示指标/行情并提醒交易员吗？

### 会显示

Connect 后，策略回传：

- `initBidFairValue` / `initAskFairValue`
- `initBidSize` / `initAskSize`
- `initBidEdge` / `initAskEdge`
- `initBidSlope` / `initAskSlope`
- `initBidLean` / `initAskLean`
- 合约名/组名/策略名
- `initComplete`

运行中持续回传：

- `bidPrice` / `askPrice`
- `bidFills` / `askFills`
- `bidStatus` / `askStatus`
- `FVMidAverage` / `FVMidAverageStatus`
- `impliedBidFairValue` / `impliedAskFairValue`
- `console` 消息

GUI 还从 DataService 拿盘口/持仓/挂单/成交/PNL。

### 不会强制提醒

代码里：

```text
Connect -> connectRequest
  -> 策略 connectGUIFlag=true
  -> sendIniMsg()
  -> sendoneMsg("true","initComplete")
GUI:
  initComplete -> Start 按钮 setEnabled(true)
```

也就是说：

- Connect 前：Start 按钮默认 disabled。
- `initComplete` 后：Start 按钮才可用。
- **没有**“指标达到阈值，请激活”的自动提醒；
- **没有**“先确认行情/持仓/风控”的强制 checklist；
- 心跳丢失会把连接标红/禁用 Start/Stop 并 beep，但这不是交易信号。

交易员要自己看 FairValue、盘口、参数、持仓，再决定是否 Start。

---

## 6. enableFlag=true 后，会继续自动交易还是变 false 等下一次激活？

### 默认：持续自动交易

`startOrStop#true`：

```text
sclock::onMsg -> Strategy::onMsg
  -> enableFlag=true
  -> 回传 status=start
  -> 策略报价循环持续运行
```

不是“成交一次就 false”。

### 会变 false 的情况

1. **交易员点 Stop**：`startOrStop#false` → `resetStrategy()` → `enableFlag=false`，回传 `status=stop`，清零 fills，Console 打印 `strategy stop`。
2. **策略内部目标完成**：某些策略（如 `SHSHFAK`）在 Bid/Ask 目标数量都完成时直接 `enableFlag=false`，日志 `Strategy finish!`。
   - **Live**：不会自动 reset 再 true；需要交易员再次 Start。
   - **SIM**：代码会 `resetStrategy(); enableFlag=true` 自动继续。
3. **GuiClose/断线处理**：`enableFlag=false`、`connectGUIFlag=false`。
4. **策略自身异常/风控/收盘逻辑**（具体策略不同）。

### 重要坑

内部完成时**不一定回传 `status=stop`**；代码里主要看到日志。GUI 可能仍显示 Stop 按钮可用，看起来“还在跑”。交易员要结合日志、成交数量、持仓确认。不要只看按钮颜色。

---

## 7. 交易员在 GUI 上能获取什么、做什么？

### 能看到

- 策略行：连接状态、策略名、Bid/Ask FairValue、Size、Edge、Slope、Lean、报价、Bid/Ask 成交数量、状态。
- FairValue 窗口：FV、FVMA、参数。
- 合约窗口：盘口、点击价格、下单/改单/撤单。
- 持仓表：合约、数量、均价、PNL。
- 挂单表：订单号、方向、价格、数量、状态。
- 订单回报/成交表、Console 日志。
- 心跳/断线状态（颜色/按钮启用状态）。

### 能做

- Connect / Start / Stop；
- 改策略参数；
- Lock/Unlock（本地防误点）；
- 手工新单、改单、撤单；
- Cancel All；
- Square Off All；
- 保存持仓 CSV；
- 查看 FairValue/盘口/持仓/PNL/订单/成交。

### 不能做

- 不能直接指定“成交”或修改成交价；
- 不能绕过 ORS/交易所；
- 不能保证 Start 命令一定到达（ZMQ `DONTWAIT`、无 ACK）；
- 不能用 Lock 停止策略；
- Qt5 策略表不能控制 `TradeBot_China`。

---

## 8. 一句话总结

GUI 是“策略监控 + 启停/参数 + 手工交易”的控制台：ZMQ 管策略状态/参数，DataService 管行情/持仓/订单/成交/手工单。它不替交易员判断“现在能不能开”，只显示数据并等交易员点 Start；Start 后通常持续自动交易，直到 Stop 或内部目标完成；`Lock` 不是策略停止，`enableFlag` 也不是“成交一次就失效”。

## 证据

- `146/03-qt-gui.md` §3–§5
- `3/dalong/FromDaya/SkylineFL_GUI/Container.cpp:100-260`
- `3/dalong/FromDaya/SkylineFL_GUI/Strategy.cpp:274-405`
- `3/dalong/FromDaya/SkylineFL_GUI/GuiMsgHub.cpp:25-95`
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/StrategyMsgHub.cpp:7-118`
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/sclock.cpp:245-290`
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/SSFAKstrategy.cpp:492-501, 951-968, 1146-1148`

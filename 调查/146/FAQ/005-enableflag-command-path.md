# enableFlag 是交易员通过 GUI 下达、经 ZMQ 到具体策略吗？

## 短答

**是，但有前提：只适用于 Qt5 `SkylineFL_GUI` 管理的 `3/leon/CL/SHSH*` 策略；不是 `TradeBot_China`。**

链路：

```text
交易员点击 Strategy 表的 Start
  -> Strategy::startOrStop()
  -> Container::sendToStrategy(row, "startOrStop#true")
  -> GuiMsgHub::send：ZMQ PUSH 到 localhost:15300+row
  -> 对应策略 StrategyMsgHub：ZMQ PULL bind 15300+row
  -> sclock::onMsg
  -> Strategy::onMsg
  -> enableFlag = true
```

Stop 同理：`startOrStop#false` → `resetStrategy()` → `enableFlag=false`。

## 前提

1. **必须先 Connect**
   - GUI 发 `connectRequest`；
   - 策略 `sclock::onMsg` 置 `connectGUIFlag=true`，回传初始参数并回 `initComplete`；
   - `Strategy::onMsg` 只有在 `connectGUIFlag==true` 时才处理 `startOrStop`。
2. **端口必须对应**
   - GUI 行号 `row` 对应 `15300+row`；
   - 策略 `StrategyMsgHub` bind 这个端口；
   - 策略单独重启后若端口漂移，GUI 可能控制错行。

## enableFlag 是内存状态，不持久化

- 每个策略进程自己的 `bool enableFlag`，不是数据库字段。
- 策略重启会执行 `resetStrategy()`，默认 `false`，需要重新 Connect/Start。
- GUI 重启不会自动恢复策略状态；需要重新连接/激活。
- **GUI 崩溃/关闭不一定让策略停止**：代码里没有“GUI 心跳丢失 → 自动 enableFlag=false”的 dead-man switch；`GuiClose` 只有 GUI 明确发送才处理。若 GUI 直接崩溃，策略可能继续自动交易。

## 不是 TradeBot_China

`TradeBot_China/TradeBot`（`RunStrategies.sh` 启动，strategyID 420）没有绑定 `15300+` 的 `StrategyMsgHub`；它的启动/停止靠：

- `RunStrategies.sh` / control / model；
- `SIGUSR1`（激活）；
- `SIGTSTP`（平仓/停止）；
- `SIGUSR2`（重载参数）。

所以“GUI 点 Start → enableFlag”这条链不适用于它。

## 时序图

```mermaid
sequenceDiagram
    participant T as 交易员
    participant G as Qt5 GUI
    participant S as 策略进程
    participant O as ORS
    T->>G: Connect
    G->>S: ZMQ connectRequest
    S-->>G: initComplete + 初始参数
    T->>G: Start
    G->>S: ZMQ startOrStop#true
    S->>S: enableFlag=true
    S-->>G: status=start
    S->>O: 自动报价/下单
    T->>G: Stop
    G->>S: ZMQ startOrStop#false
    S->>S: resetStrategy(); enableFlag=false
    S-->>G: status=stop
```

## 证据

- `3/dalong/FromDaya/SkylineFL_GUI/Strategy.cpp:274-301`：Connect/Start/Stop/参数。
- `3/dalong/FromDaya/SkylineFL_GUI/Container.cpp:287-291`：`sendToStrategy`。
- `3/dalong/FromDaya/SkylineFL_GUI/GuiMsgHub.cpp:25-55`：ZMQ PUSH。
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/StrategyMsgHub.cpp:7-118`：策略 PULL bind + PUSH 回 GUI。
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/sclock.cpp:251-290`：`connectRequest`/`startOrStop`/status。
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/SSFAKstrategy.cpp:951-968`：`enableFlag=true/false`。

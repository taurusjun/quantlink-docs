# GUI 也只能是单机吗？不能跨机收集信息？

## 短答

**看走哪条链：**

- **DataService 数据面（行情/持仓/订单/成交/PNL/手工单）**：可以跨机，`ConnectionDetails` 里地址/端口可配，Qt4/Qt5 的 `DataCollector` 用 TCP 连 DataService。
- **ZMQ 策略控制/遥测面**：146 的代码把地址写死为 `localhost`，**默认只能同机**；跨机要改代码或做 SSH/端口转发。
- Qt4 `TradingSystemsGUI` 主要是 DataService 手工单/持仓/PNL，因此它的“信息收集”可以跨机。
- Qt5 `SkylineFL_GUI` 的策略表依赖 ZMQ，**策略控制默认跨不了机**；它的 DataService 信息面仍可跨机。

## 1. DataService 数据面：可跨机

`DataCollector`：

```cpp
m_qsocket->connectToHost(
    m_ConnectionDetails.m_InetAddress.c_str(),
    m_ConnectionDetails.m_Port);
```

`ConnectionDetails` 默认：

```text
127.0.0.1:20000
```

但 `ConnectDialog` 允许填地址/端口；Qt4 `Mainwindow` 也按交易所保存连接信息。因此：

- `dataservice` 在交易服务器；
- GUI 在另一台机器；
- GUI 连 `tcp://<交易服务器>:20000` 或 `:1732`；
- 理论可行。

但注意：

- 146 没有 TLS/认证，跨公网非常危险；
- 需要防火墙/安全组放行；
- 延迟、断线、时钟同步都要自己处理；
- 建议 VPN/SSH 隧道，不要裸暴露 DataService 端口。

## 2. ZMQ 策略控制面：默认只能同机

`GuiMsgHub`：

```cpp
pushAddr = "tcp://localhost:" + pushPorts[i];
```

`StrategyMsgHub`：

```cpp
pushAddr = "tcp://localhost:" + push;
pullAddr = "tcp://*:" + pull;
```

两端都写死 `localhost`：

- GUI 的 PUSH 发到**本机** `15300+`；
- 策略的 PUSH 发到**本机** `15213`；
- 远端 GUI 不会收到策略 telemetry，也不能直接控制远端策略。

`GuiMsgHub` 虽然 bind `tcp://*:15213`，但策略 `pushAddr` 仍是 `localhost:15213`；`StrategyMsgHub` bind `tcp://*:15300+`，但 GUI `pushAddr` 仍是 `localhost:15300+`。所以默认部署是**同机**。

跨机办法：

1. 改代码，把 `localhost` 换成可配置 host；
2. SSH 端口转发/隧道（34 个策略端口，运维麻烦）；
3. 加一个本机 relay/gateway；
4. 重做成 WebSocket/HTTP 控制面。

## 3. 推荐拓扑

```text
交易服务器
  ORS + DataService + N TradeBot + 本机 GUI relay/agent
        │
        │ WebSocket/HTTPS/VPN（带认证）
        ▼
远端 GUI
```

不要让远端 GUI 直接裸连：

- DataService 20000/1732；
- 策略 ZMQ 15213/15300+。

## 4. 新系统

- `AeronStreams.CHANNEL = "aeron:ipc"` → 只读 Aeron 订阅者必须同机；
- 远端 GUI 通过本机 DataService/relay 暴露 WebSocket/HTTP；
- 跨机用 `aeron:udp` 也可以，但需要改 channel、网络、安全和流控，不建议为了 GUI 做。

## 结论

- **信息收集（DataService）可以跨机**，但 146 没有安全边界，必须加 VPN/隧道/认证。
- **策略控制/遥测（ZMQ）默认只能同机**；跨机要改代码或加 relay。
- 最稳妥：交易组件同机，远端 GUI 只连一个带认证的 WebSocket/HTTP 网关。

## 证据

- `3/dalong/infrastructure/TradingSystemsGUI/DataCollector.cpp:43`
- `3/dalong/infrastructure/TradingSystemsGUI/ConnectionDetails.h:14-18`
- `3/dalong/infrastructure/TradingSystemsGUI/ConnectDialog.cpp:80-83`
- `3/dalong/FromDaya/SkylineFL_GUI/GuiMsgHub.cpp:29`
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/StrategyMsgHub.cpp:11-12`
- `146/03-qt-gui.md` §3

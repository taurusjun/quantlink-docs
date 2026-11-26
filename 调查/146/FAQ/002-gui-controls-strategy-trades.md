# GUI 是怎么控制策略成交的？

## 短答

GUI **不直接制造或控制成交**。它通过两条链影响交易：

1. **策略控制（ZMQ）**：Connect / Start / Stop / 改参数，改变策略的 `enableFlag`/参数；策略自己向 ORS 发单。
2. **手工交易（DataService TCP）**：手工新单/改单/撤单/撤所有/平所有，直接经 DataService → ORS → 交易所。

成交仍由策略/ORS/交易所完成，GUI 只显示回报。

## 先分清两套 GUI / 两套策略

| GUI | 策略 | 控制方式 |
|---|---|---|
| Qt4 `TradingSystemsGUI`（历史启动命令） | 主要是手工单/持仓/PNL | DataService + `ManualOrderSender`；没有 StrategyMsgHub 策略表 |
| Qt5 `SkylineFL_GUI` | `3/leon/CL/SHSH*` 策略 | ZMQ `GuiMsgHub` / `StrategyMsgHub` |
| `TradeBot_China/TradeBot` | `RunStrategies.sh` 启动 | 不在这两套 GUI 的 enableFlag 链里；靠 `SIGUSR1`/`SIGTSTP`/control 文件 |

## 策略控制链（Qt5）

```text
GUI 策略表（Connect/Start/Stop/参数滚轮）
  -> Container::sendToStrategy(row, msg)
  -> GuiMsgHub::send：ZMQ PUSH 到 localhost:15300+row
  -> 策略 StrategyMsgHub：ZMQ PULL bind 15300+row
  -> sclock::onMsg -> Strategy::onMsg
  -> enableFlag / resetStrategy / 参数变量
  -> 策略报价循环 -> ORS -> 交易所
```

### 命令和效果

| GUI 动作 | 消息 | 策略侧效果 |
|---|---|---|
| Connect | `connectRequest` | 回传初始参数/合约；`connectGUIFlag=true`；`initComplete` |
| Start | `startOrStop#true` | `enableFlag=true`；开始持续报价/发单 |
| Stop | `startOrStop#false` | `resetStrategy()`；`enableFlag=false`；回传 status stop |
| 参数滚轮 | 如 `bidEdge#0.5`、`askSize#10` | 更新参数变量，下一轮报价使用 |
| Lock/Unlock | **不发 ZMQ** | 仅本地：断开 Start 按钮和盘口点击下单，防误点 |

策略侧对应：`3/leon/CL/SHSHFAK/.../StrategyMsgHub.cpp`、`sclock.cpp`、`SSFAKstrategy.cpp`。

## 手工交易链（Qt4 为主）

```text
OpenOrder / ExchangeWidget / ContractWidget
  -> ManualOrderSender（继承 DataCollector）
  -> ManualOrderCommand
  -> DataService TCP
  -> ORS/网关
  -> 交易所
```

`ManualOrderSender` 的 `OrderType`：

```text
New / Cancel / Modify / CancelAll
```

`ExchangeWidget::OnSquareOffAll()` 会按持仓逐个生成平仓单；`OpenOrder::cancelAll()` 遍历挂单发撤单。

## 关键限制

- **没有 ACK**：GUI 的 ZMQ `send` 用 `ZMQ_DONTWAIT`；命令可能丢，GUI 仍可能显示“发过”。
- **端口即身份**：`15300+row` 对应 GUI 行；策略单独重启换端口会控制错行。
- **无认证**：ZMQ 绑定 `tcp://*`，能连端口的人都能发 Start/Stop。
- **Lock 不是停止**：Lock 只断开本地按钮/点击，不改变策略 `enableFlag`。
- **成交不可控**：GUI 不能指定成交价/成交量；只能 Start/Stop/改参数或发手工单。

## 一句话

GUI 控制的是“策略是否允许交易”和“参数/手工单”，不是“直接控制成交”。成交在策略/ORS/交易所，GUI 只负责控制、展示和手工干预。

## 证据

- `146/03-qt-gui.md` §3（ZMQ 拓扑/协议）
- `3/dalong/FromDaya/SkylineFL_GUI/Strategy.cpp:274-301`
- `3/dalong/FromDaya/SkylineFL_GUI/Container.cpp:287-291`
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/StrategyMsgHub.cpp:7-118`
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/sclock.cpp:251-290`
- `3/dalong/infrastructure/TradingSystemsGUI/ManualOrderSender.cpp:24-80`
- `3/dalong/infrastructure/TradingSystemsGUI/ExchangeWidget.cpp:737-764`

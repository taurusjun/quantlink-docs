# 03 — Qt 前端：SkylineFL_GUI、TradingSystemsGUI 与部署态

> 调查对象：`/Volumes/DevDisk/146`（下文用 `$R` 代替），只读。
> 范围：Qt5 源码 `3/dalong/FromDaya/SkylineFL_GUI`、共享 GUI 源码 `3/dalong/infrastructure/TradingSystemsGUI`、Qt4 运行态 `3/infra/TradingSystemsGUI`、Qt5 部署态 `3/GUI/SH`，以及它们与策略进程之间的 ZMQ/DataService 协议。
> 方法：只读 `ls/stat/file/strings/grep/diff/git log/tar -t`，**未运行任何二进制，未修改任何源文件**。
> 证据标记：**V** = 直接读源码/配置/日志/文件元数据确认；**I** = 由结构、时间戳、二进制字符串、日志推断；**P** = 假设或无法验证。
> 本文不复制任何口令、密钥、内网地址或完整凭据；涉及凭据只记录位置与风险。

---

## 0. 一页结论

| 前端 | 类型 | 技术栈 | 结论 |
|---|---|---|---|
| `3/dalong/FromDaya/SkylineFL_GUI` | **源码（权威）** | Qt 5.3.1 / C++11 / ZMQ 3.x | 2015 年实际在用的新前端；单主窗 + 7 个浮动 Dialog；策略表是“每格一个 widget”，持仓表才是 model/view。[V] |
| `3/dalong/infrastructure/TradingSystemsGUI` | **共享控件源码（受 git 管理）** | Qt4/Qt5 双兼容 | 提供 MD/PNL/Orders 采集器、手工下单对话框、SquareOff 对话框、旧主窗与旧模型；SkylineFL 只编译其中 7 个 `.cpp`。[V] |
| `3/infra/TradingSystemsGUI` | **Qt4.8.6 运行态（旧）** | Qt4 / 无 ZMQ | 旧 GUI（`Mainwindow.cpp`/`ExchangeWidget.cpp`）；148 个日志里 146 个是 0 字节；目录缺少 `libQt*.so.4` 符号链接，按原样不能独立启动。[V/I] |
| `3/GUI/SH` | **Qt5 部署态（线上）** | Qt 5.3.1 + 自带 `libzmq.so.3` | 二进制 2014-12-21，配置 15213 + 34 个策略槽位；日志证明 2015-07-24 只有 17 个策略在线；日志 9 GB。[V] |

**五条关键判断**

1. **这是“控制面/数据面分离”的前端**：GUI 与策略之间只有 ZMQ 控制与遥测（端口 15213 与 15300–15333）；行情、持仓、挂单、成交、手工单全部走 DataService 的 TCP 命令流（默认 `127.0.0.1:20000`），不是 ZMQ。[V]
2. **线上二进制与归档源码基本同源**：源码目录所有 `.cpp/.h` 最后修改都是 2014-11-20；线上二进制 2014-12-21；其日志中的 `Container.cpp:59`、`GuiMsgHub.cpp:85`、`Position.cpp:29`、`ContractWidget.cpp:20` 与归档源码逐行对得上。`00-inventory.md` 里“线上二进制比源码旧约 3 个月”的说法，是把线上二进制和**源码树里 2015-03-19 的本机构建**相比，不是和源码内容相比。[V/I]
3. **SkylineFL 是“新壳 + 旧控件层”**：它直接编译 `$INFRA/{MDCollector,PNLCollector,ManualOrderSender,PlaceOrderWidget,DataCollector,OrdersCollector,SquareOffAllDialog}.cpp`，但不编译旧主窗 `Mainwindow.cpp`/`ExchangeWidget.cpp`；旧模型 `NetPnlModel.cpp`、`OpenOrdersModel.cpp` 等也不编译。[V]
4. **协议是纯文本、无认证、无版本号**：`端口|键#参数`，多条用 `;` 连接；GUI 在 `tcp://*:15213` 上 bind PULL，策略在 `tcp://*:15300..15333` 上 bind PULL。任何能连上这些端口的人都能发 `startOrStop#true`、`bidFairValue#...`，没有签名、白名单或 CURVE。[V/I]
5. **最危险的不是 UI，而是生命周期与阻塞**：`GuiMsgHub` 的接收线程 `detach()` 后从不停止，`GuiMsgHub` 也从不 delete；`DataCollector` 在 GUI 线程里做最长 30 秒的 `waitForConnected()/waitForReadyRead()`；手工单的 `RequestMsg.OrdType` 没有被初始化。这些都比“界面好不好看”更值得先处理。[V]

---

## 1. 代码谱系与目录

### 1.1 四条线

```
infrastructure/TradingSystemsGUI        (git, 2014-01-29 创建, 最后改动 2014-10-07)
   │  共享控件/采集器：MDCollector, PNLCollector, OrdersCollector,
   │  ManualOrderSender, PlaceOrderWidget, SquareOffAllDialog,
   │  Mainwindow, ExchangeWidget, NetPnlModel, OpenOrdersModel ...
   │
   ├── TradingSystemsGUI.pro  (Qt4/Qt5 兼容垫片)
   │        └── 3/infra/TradingSystemsGUI
   │              Qt 4.8.6 随包, 二进制 2014-09-26, BuildID 76f8f101
   │              [旧运行态, 已被 Qt5 取代]
   │
   └── SkylineFL_GUI.pro  (Qt 5.3.1)
            ├── 3/GUI/SH
            │     二进制 2014-12-21, BuildID a2e432bd  [线上部署]
            └── 3/dalong/FromDaya/SkylineFL_GUI/SkylineFL_GUI
                  二进制 2015-03-19, BuildID 1aecd50d  [本机构建, 未部署]
```

判读：

- `SkylineFL_GUI` **不是** fork 一份共享控件源码，而是通过 `SkylineFL_GUI.pro:31` 的 `INFRA = $$(HOME)/infrastructure/TradingSystemsGUI` 直接编译共享 `.cpp`。[V]
- `SkylineFL_GUI` 本身**不在任何 git/svn 里**；`3/dalong/FromDaya` 下没有 `.git`，`git rev-parse` 报“不是 git 仓库”。共享控件层在 `3/dalong/infrastructure` 的 git 里，最后一条 GUI 提交是 `345637ee 2014-10-07 "removed showing of junk in market data widget"`。[V]
- `3/GUI/SH` 与 `3/infra/TradingSystemsGUI` 都只有运行物，没有源码；源码分别在 `3/dalong/FromDaya/SkylineFL_GUI` 与 `3/dalong/infrastructure/TradingSystemsGUI`。[V]

### 1.2 文件与角色

**SkylineFL_GUI（Qt5 源码，约 60 个文件，3.2 MB）**

| 文件 | 角色 |
|---|---|
| `Main.cpp` | 入口；读 `./GuiSettings.xml`；初始化 logger/font；创建 `Container`。[V] |
| `Container.h/.cpp` | `QMainWindow`；持有 7 个 Dialog、`GuiMsgHub`、`OpenOrderMsgHub`；心跳定时器；消息分发。[V] |
| `GuiMsgHub.h/.cpp` | ZMQ PULL/PUSH 封装；接收线程；发送。[V] |
| `Strategy.h/.cpp` | 策略表（19 列）；连接/启停/锁定；右键开合约窗。[V] |
| `ContractWindow.h/.cpp` | 一个策略的“驱动/报价”两个合约窗。[V] |
| `ContractWidget.h/.cpp` | 20 档订单簿、双边挂单、点击下单、改单/撤单、行情订阅。[V] |
| `FairValue.h/.cpp` | 公允价值表；FV 编辑、Match、FVAuto、Group。[V] |
| `Position.h/.cpp` | 持仓表容器；PNL 采集器；CSV 读取。[V] |
| `PositionModel.h/.cpp` | `QAbstractTableModel`；持仓/组 PNL/乘数/手续费。[V] |
| `PositionDelegate.h/.cpp` | 持仓表编辑器（Group/Mult/Fees）。[V] |
| `ProxySortModel.h/.cpp` | `QSortFilterProxyModel`；数值排序与逗号过滤。[V] |
| `OpenOrder.h/.cpp` | 挂单表；Cancel All；右键撤单。[V] |
| `FillResponse.h/.cpp` | 成交表；蜂鸣；关窗自动导出 CSV。[V] |
| `OrderResponse.h/.cpp` | 非成交订单响应文本流。[V] |
| `Console.h/.cpp` | 策略控制台文本流。[V] |
| `OpenOrderMsgHub.h/.cpp` | 600 ms 轮询 DataService 的挂单/已结束订单，分发给各表。[V] |
| `ScrollLabel.h`、`ContractScrollLabel.h`、`ClickLabel.h`、`TableButton.h`、`LockButton.h`、`TableCheck.h` | 表格内的可编辑/可点击控件。[V] |
| `Dialog.h/.cpp` | 所有浮动窗的基类：几何保存、Esc 屏蔽、show/hide。[V] |
| `GuiConfig.h`、`GuiUtils.h` | 单例配置、表格/样式/时间/空订单工具。[V] |
| `TableDataModel.cpp/.h`、`TableDataModel_.cpp/.h`、`TableView_.cpp/.h` | 前两个是基类；带下划线的两个是共享层的**死副本**，`.pro` 没有编译它们。[V] |

**共享层 TradingSystemsGUI（58 个受 git 跟踪的文件）**

| 文件 | 角色 | SkylineFL 是否编译 |
|---|---|---|
| `DataCollector.cpp/.h` | TCP 命令流基类；初始化/登录/`DoWork`。[V] | 是 |
| `MDCollector.cpp/.h` | 行情订阅；按 `MarketUpdateWithOrderIndication` 结构体读。[V] | 是 |
| `PNLCollector.cpp/.h` | 净持仓/PnL 订阅；按 `NetPnlInfo` 读。[V] | 是 |
| `OrdersCollector.cpp/.h` | 挂单/已结束订单流；`StartOpenStreamStatus` 清空。[V] | 是 |
| `ManualOrderSender.cpp/.h` | 手工单/撤单/改单/撤所有；`ManualOrderCommand`。[V] | 是 |
| `PlaceOrderWidget.cpp/.h` | 手工单编辑对话框（BUY/SELL、数量、价格、账户等）。[V] | 是 |
| `SquareOffAllDialog.cpp/.h` | “输入随机码确认”对话框。[V] | 是 |
| `Mainwindow.cpp/.h`、`ExchangeWidget.cpp/.h` | 旧 GUI 主窗与每交易所面板。[V] | **否** |
| `NetPnlModel/OpenOrdersModel/ClosedOrdersModel/OrdersModel` | 旧 GUI 的 model/view 表。[V] | **否** |
| `MarketDataWidget/MarketDataTab/TableView/CancelModifyOrderWidget/...` | 旧 GUI 的行情窗、表视图、改撤对话框。[V] | **否** |
| `ConnectDialog.cpp/.h` | 旧 GUI 的连接对话框（地址/端口/用户/口令/保存会话）。[V] | **否** |
| `VersionHeaders.h` | Qt4/Qt5 API 垫片（`setResizeMode` vs `setSectionResizeMode` 等）。[V] | 是（头文件） |

### 1.3 哪些是死代码/悬空引用

- `SkylineFL_GUI.pro:33-58` 的 `SOURCES` 只列了 19 个本地 `.cpp` + 7 个共享 `.cpp`；目录里存在的 `TableDataModel_.cpp`（与共享 `TableDataModel.cpp` 完全相同）和 `TableView_.cpp`（与共享 `TableView.cpp` 完全相同）**没有编译**。[V]
- `PositionModel.cpp:1` `#include "NetPnlModel.h"`，但 `NetPnlModel.cpp` 不在 `.pro` 里，代码也没用到 `NetPnlModel`；这是历史残留。[V]
- `SkylineFL_GUI.pro` 不包含 `ConnectDialog.cpp`，目录里也没有这个文件；SkylineFL 没有“连接对话框”，连接是策略表里的 `Connect` 按钮 + ZMQ 握手。[V]
- `DTemplate.cpp/.h` 是 Qt 官方 “Basic Layouts” 示例的拷贝，`Container` 没有使用它；它仍在 `.pro` 里编译，属于无用代码。[V]
- `GuiUtils.h:11` 的 `STR_TO_QSTR` 直接 `QString((s).c_str())`，假定 `std::string` 是 UTF-8/ASCII；策略名/合约名都是 ASCII，问题不大。[V]

### 1.4 版本控制状态

| 目录 | 版本控制 | 证据 |
|---|---|---|
| `3/dalong/FromDaya/SkylineFL_GUI` | 无 | 无 `.git`/`.svn`；`git rev-parse` 失败。[V] |
| `3/dalong/infrastructure` | git，HEAD `6efe348f`（2014-10-27，`Salil "RMS bugfix"`），`TradingSystemsGUI` 58 个文件受跟踪。[V] | `git log -1`、`git ls-files` |
| `3/TradeBot/TradeBot_China` | SVN r2375（2015-06-10），工作副本干净。[V] | 见 `00-inventory.md` |
| `3/GUI/SH`、`3/infra/TradingSystemsGUI` | 运行目录，无版本控制。[V] | 目录内容 |

> 资产风险：**GUI 新代码没有版本控制**，只有目录和两个 tarball（`3/unknown/SkylineFL_GUI.tar.gz`、`tosendgui.tar.gz`）。这比任何单个 bug 都更值得先归档。[V/I]

---

## 2. 架构：窗口、表格、模型、委托

### 2.1 启动链

`Main.cpp`：

1. `QApplication app(argc, argv)`。
2. `std::string configPath("./GuiSettings.xml")` —— **相对当前工作目录**，不是相对可执行文件。[V `Main.cpp:63`]
3. `loadConfig()`：
   - `XmlReader::LoadConfig` 失败 → `ILOG(FATAL)` + `exit(-1)`。[V `Main.cpp:10-13`]
   - 读 `CompanyName/ApplicationName/Font/FontSize/RowHeight/ServerPort` 到 `AppConfig` 单例。[V `Main.cpp:15-20`]
   - 遍历 `StrategyList/Strategy`：`Name/Port/Quoting/Driving/QuotingExchange/DrivingExchange` → `StrategyInfo`。[V `Main.cpp:22-45`]
   - 重新 `LoadConfig`（重置迭代器），遍历 `ExchangeList/Exchange`：`Name/Type` → `ExchangeDetails`。[V `Main.cpp:47-56`]
4. `Logger::InitLogger(INFRA, TO_FILE, ApplicationName, ".log", true, true)` —— 文件名形如 `SkylineGUI-YYYYMMDD-HH.MM.SS.log`，写在当前目录，安装 SIGSEGV handler。[V `Main.cpp:66-67`；日志文件名]
5. `QFont(Font, FontSize)`；`QApplication::setFont`。[V `Main.cpp:68-69`]
6. `Container container; container.show(); app.exec();`。[V `Main.cpp:71-74`]

注意：**没有** `QApplication::setOrganizationName/ApplicationName`；所有 `QSettings` 都是显式传 `(company, app)` 或 `("Test")`，不是全局默认。[V `GuiUtils.h:52`、`Position.cpp:50`]

### 2.2 `Container`：单主窗 + 7 个浮动 Dialog

`Container` 继承 `QMainWindow`，窗口标题 `"SkylineFL Trading Front"`。[V `Container.cpp:35`]

构造顺序（很重要，决定了启动阻塞点）：

```
readSettings()                        // QSettings 恢复主窗 geometry/state
setupConfig()                         // port -> row 索引
openOrderMsgHub = new OpenOrderMsgHub(this)
    └─ 每个交易所 new OrdersCollector(...)->DoWork()   // 同步 TCP，见 §5/§8
initWidget()
    ├─ new FairValue(...)->show()
    ├─ new Console(...)->show()
    ├─ new Strategy(...)->show()
    ├─ new FillResponse(...)->show()
    ├─ new OrderResponse(...)->show()
    ├─ new OpenOrder(...)->show()
    └─ new Position(...)->show()
         └─ 每个交易所 new PNLCollector(...)->DoWork() // 同步 TCP
createCtrlWidget()                    // 7 个按钮
setupCallback()                       // 注册消息键 -> 信号
setupMsgHub()                         // bind 15213 + 每策略 PUSH
setupMonitor()                        // 心跳数组 + 1s 定时器
```

[V `Container.cpp:33-55`、`:262-285`]

主窗中央控件只是一个 `QGroupBox` + `QHBoxLayout`，里面 7 个 `QPushButton`；每个按钮 `pressed()` → 对应 Dialog 的 `showOrHide()`。**没有 QTabWidget、没有 QDockWidget、没有 MDI**；7 个窗口是独立浮动的 `QDialog`，启动时全部 `show()`。[V `Container.cpp:294-335`、`:262-285`]

`Dialog` 基类：
- 构造时 `restoreWidgetGeometry(widgetName)`；关闭时 `saveWidgetGeometry`。[V `Dialog.cpp:7-11`、`:27-34`]
- `keyPressEvent` 屏蔽 Esc，防止误关。[V `Dialog.cpp:21-25`]
- `closeEvent` 调 `onClose()`，然后 `setVisible(false)`，不 delete；窗口可反复开关。[V `Dialog.cpp:27-34`]

`Container::closeEvent`：保存主窗 geometry/state → `closeDialog()`（依次 `close()` 7 个窗口）→ `QMainWindow::closeEvent`。**没有**停止 ZMQ、没有发 `GuiClose`、没有 `msgHub` 的销毁。[V `Container.cpp:18-25`、`:91-101`]

### 2.3 `Strategy`：19 列策略表

`Strategy` 继承 `Dialog`，内部是一个 `QTableWidget`（`UnscrollTable`，重写 `wheelEvent` 直接 `ignore()`，防止滚轮误改参数）。[V `Strategy.cpp:109-117`、`UnscrollTable.h:16-19`]

列定义（`Strategy.h:41-61`，`colNum = 19`）：

| 列 | 枚举 | 控件 | 含义 |
|---|---|---|---|
| 0 | `connectCol` | `TableButton("Connect")` | 发 `connectRequest` |
| 1 | `nameCol` | `DisplayLabel` | 策略名（由 `strategyName` 消息更新） |
| 2 | `bidExlim` | `ScrollLabel` | 买侧单边亏损上限 |
| 3 | `bidSize` | `ScrollLabel` | 买侧数量 |
| 4 | `bidEdge` | `ScrollLabel` | 买侧 edge |
| 5 | `bidSlope` | `ScrollLabel` | 买侧 slope |
| 6 | `bidLean` | `ScrollLabel` | 买侧 lean |
| 7 | `bidPrice` | `DisplayLabel` | 买价（只读） |
| 8 | `bidFillCol` | `FillsLabel` | 买侧成交/状态 |
| 9 | `askFillCol` | `FillsLabel` | 卖侧成交/状态 |
| 10 | `askPrice` | `DisplayLabel` | 卖价（只读） |
| 11 | `askLean` | `ScrollLabel` | 卖侧 lean |
| 12 | `askSlope` | `ScrollLabel` | 卖侧 slope |
| 13 | `askEdge` | `ScrollLabel` | 卖侧 edge |
| 14 | `askSize` | `ScrollLabel` | 卖侧数量 |
| 15 | `askExlim` | `ScrollLabel` | 卖侧单边亏损上限 |
| 16 | `startCol` | `TableButton("Start")` | `startOrStop#true` |
| 17 | `stopCol` | `TableButton("Stop")` | `startOrStop#false` |
| 18 | `lockCol` | `LockButton("Lock")` | 本地锁：断 Start/点击下单 |

```cpp
enum StrategyCol {
  connectCol = 0, nameCol, bidExlim, bidSize, bidEdge, bidSlope, bidLean,
  bidPrice, bidFillCol, askFillCol, askPrice, askLean, askSlope, askEdge,
  askSize, askExlim, startCol, stopCol, lockCol
};
```

[V `Strategy.h:41-61`；表头字符串 `Strategy.cpp:113-115` 也正好 19 项]

构建方式：
- `rowCnt = AppConfig::strategySize()`，每行对应配置里的一个 `<Strategy>`。[V `Strategy.cpp:110`]
- 每个单元格 `setCellWidget`，不是 `QAbstractTableModel`；更新时直接 `qobject_cast<...>(tb->cellWidget(r,c))->setText(...)`。[V `Strategy.cpp:126-226`、`:376-410`]
- `FillsLabel` 继承 `DisplayLabel`，把 `hedged/unhedged/cancel/reject` 映射成紫/青/粉/红背景；数字则直接显示。[V `FillsLabel.h:11-27`]
- `TableButton` 记住 `row/col`，`pressed()` 后通过 `sender()` 取回行号。[V `TableButton.h:10-23`、`Strategy.cpp:279-286`]
- `LockButton` 文本在 `Lock/Unlock` 之间切换；`lock()` 发 `lockSignal`，`unlock()` 发 `unlockSignal`。[V `LockButton.h:20-38`]

交互：

| 动作 | 代码 | 发出的 ZMQ |
|---|---|---|
| Connect | `Strategy.cpp:274-277` | `connectRequest` |
| Start | `Strategy.cpp:279-286` | `startOrStop#true` |
| Stop | 同上 | `startOrStop#false` |
| Stop All | `Strategy.cpp:77-87` | 对每个 Stop 可用的行发 `startOrStop#false` |
| Lock All | `Strategy.cpp:89-97` | 只改 UI/本地 lock 信号，不发 ZMQ |
| Unlock All | `Strategy.cpp:99-107` | 同上 |
| 参数滚轮 | `Strategy.cpp:300-302` | `colToHeader[c] + cur`，如 `bidSize#4` |
| 右键行 | `Strategy.cpp:305-338` | 打开 `ContractWindow`，不发 ZMQ |

**锁定的真实语义**（容易误解）：
- `Lock` 只 `disconnect` 了 **Start 按钮**的 `pressed()`，并灰掉整行标签；Stop 按钮仍然可用。[V `Strategy.cpp:258-264`]
- `ContractWidget::handleLock()` 只断开买/卖价 `ClickLabel` 的点击下单信号；改单/撤单（`ContractScrollLabel`）仍然可用。[V `ContractWidget.cpp:228-258`]
- 因此 Lock 是“防误开新仓”，不是“冻结所有操作”。

**自动连接/自动锁定**：
- `Container::checkHeartBeat()` 每秒检查 `rowToHeartBeat[i]`；小于阈值 6 视为在线，否则调 `m_strategy->onIsConnect(i,false)`。[V `Container.cpp:68-80`]
- 第一次收到某行心跳时，`Strategy::onIsConnect(true)` 会**自动发一次 `connectRequest` 并 `lockBtn->lock()`**（把该行锁上）。[V `Strategy.cpp:340-354`]
- 掉线时若之前是连接状态，禁用 Start/Stop，并 `QApplication::beep()` 三声；变红。[V `Strategy.cpp:355-370`]

### 2.4 `ContractWindow` / `ContractWidget`：一个策略两个合约

`Strategy::createContractDialog(r)`：
- 从 `AppConfig` 取该行的 `quoting/driving/quotingEx/drivingEx`；
- `new ContractWindow(strat_name[r], quoting, quotingEx, driving, drivingEx, r, this, getOpenOrderMsgHub())`；
- 把该行 `LockButton` 的 lock/unlock 信号连到两个 `ContractWidget` 的 `handleLock/handleUnlock`；
- 缓存到 `contractsMap[r]`；关闭时 `ContractWindow::closeEvent` 把缓存置 NULL。[V `Strategy.cpp:310-338`、`ContractWindow.cpp:33-37`]

`ContractWindow` 是 `QDialog`，内部 `QHBoxLayout` 左边 `dw`（driving）、右边 `cw`（quoting）；`WA_DeleteOnClose`；构造时 `show()`。[V `ContractWindow.cpp:3-31`]

`ContractWidget` 布局：
- 顶部：合约名、`TimeStamp`、`Volume`、`LTP`、`Size`（`QSpinBox` 手数）。[V `ContractWidget.cpp:39-100`]
- 中部：`bidOrder`（2 列 Size/Price）、`orderBook`（4 列 Bid Size/Bid/Offer/Offer Size，20 行）、`askOrder`（2 列）。[V `ContractWidget.cpp:53-86`]
- `orderBook` 每个价格格是 `ClickLabel`：买价左键 `sendBuy()`、右键 `sendSell()`；卖价反过来。[V `ContractWidget.cpp:62-73`]
- `bidOrder/askOrder` 的行由 `ContractScrollLabel` + `DisplayLabel` 组成；左键改单、右键撤单、滚轮调价。[V `ContractWidget.cpp:213-225`、`ContractScrollLabel.h:38-71`]

行情：
- `setupMDCollector()` 为该合约创建一个 `MDCollector`，订阅单个 symbol，连接 `DataBatchReady` → `updateTickerData()`；同时把 `OpenOrderMsgHub::signalMap[m_name]` 里的 `Signaller` 连到 `processOrders()`。[V `ContractWidget.cpp:146-167`]
- `updateTickerData()` 从 `MDCollector::PopDataBatch` 取 `MarketUpdateWithOrderIndication`，把 20 档买卖价/量写进 `orderBook`；价格格按买卖染蓝/红；更新时间戳/总量/LTP。[V `ContractWidget.cpp:300-337`]
- 如果合约名为空，`setupMDCollector()` 直接返回 -1，不订阅、不建立 signal 连接；窗口会一直是空表。[V `ContractWidget.cpp:147-148`]

挂单：
- `processOrders(QVector<Order>)` 按 `Transaction_Type` 分成买/卖，分别 `updateOrder(bidOrder,sOrders)`、`updateOrder(askOrder,bOrders)`。[V `ContractWidget.cpp:194-211`]
- `updateOrder()` 用 `while` 调整行数（多退少补），再逐行写数量/价格；`ContractScrollLabel::updateContent` 在用户滚轮编辑期间用 `blockUpdateFlag` 阻止覆盖。[V `ContractWidget.cpp:169-192`、`ContractScrollLabel.h:22-31`]
- `addOneRow()` 在顶部插入一行，并连接改单/撤单信号。[V `ContractWidget.cpp:213-225`]

手工下单/改单/撤单：
- 新单：`sendNewOrder()` 组装 `PlaceOrderInfo`，`AccountID="OWN"`，`Symbol=m_name`，`Quantity=orderSize`，`Price=ClickLabel.text()`，`Request_Type=NEWORDER`，`Transaction_Type=B/S`；弹 `PlaceOrderWidget`，接受后 `ManualOrderSender(...).DoWork()`。[V `ContractWidget.cpp:117-144`]
- 改单：复制原 `Order`，`Request_Type=MODIFYORDER`，`Price=新价`，弹 `PlaceOrderWidget`，接受后发送。[V `ContractWidget.cpp:260-279`]
- 撤单：复制原 `Order`，`Request_Type=CANCELORDER`，**构造 `PlaceOrderWidget` 但没有 `exec()`**，直接发送。[V `ContractWidget.cpp:281-298`]
- 撤单成功后把 `ContractScrollLabel` 染绿；失败没有 UI 提示。[V `ContractWidget.cpp:292-295`]

### 2.5 `FairValue`：公允价值与组编辑

`FairValue` 也是 `QTableWidget`（`UnscrollTable`），10 列（`FairValue.h:23-34`）：

| 列 | 控件 | 作用 |
|---|---|---|
| 0 `isShowCol` | `TableCheck` | 是否用 `bidFvmaFV/offerFvmaFV` 自动覆盖 FV |
| 1 `nameCol` | `DisplayLabel` | 策略名 |
| 2 `impliedBidCol` | `DisplayLabel` | 隐含买 FV（只读） |
| 3 `bidCol` | `ScrollLabel` | 买 FV（可滚轮编辑） |
| 4 `askCol` | `ScrollLabel` | 卖 FV（可滚轮编辑） |
| 5 `impliedAskCol` | `DisplayLabel` | 隐含卖 FV（只读） |
| 6/7 `bidMatch/askMatch` | `TableButton("Match")` | 把隐含 FV 填到可编辑 FV 并下发 |
| 8 `groupCol` | `ScrollLabel` | 组号（默认行号，策略会发 `group#port` 覆盖） |
| 9 `fVMidAvgCol` | `DisplayLabel` | FV Mid Average |

[V `FairValue.cpp:40-103`、`FairValue.h:23-42`]

行为：
- `handleCheck()`：勾选/取消 → `FVAuto#true/false`。[V `FairValue.cpp:108-119`]
- `handleMatch()`：取 `impliedBidCol/impliedAskCol` 的文本，调 `onScrollChange(row, bidCol/askCol, "", cur)`。[V `FairValue.cpp:121-141`]
- `onScrollChange()`：查 `groupCol` 的组号，遍历 `group[grpIdx]`，把同一组的所有行设成同一值，并逐行发 `bidFairValue#/askFairValue#`。[V `FairValue.cpp:143-154`]
- `adjustGrp()`：换组时从旧组删、往新组插。[V `FairValue.cpp:156-164`]
- `onMsg()`：
  - `group#`：更新组号并 `adjustGrp`；
  - `FVMidAverageStatus#true/false`：禁用/启用 bid/ask 的 `ScrollLabel`；
  - `bidFvmaFV/offerFvmaFV`：仅在 checkbox 勾选时覆盖 FV；
  - `impliedBidFairValue/impliedAskFairValue/init*/strategyName/FVMidAverage`：写对应 `DisplayLabel`。[V `FairValue.cpp:166-224`]

**组功能的实际退化**：策略侧 `cfgField.cpp:308` 把 `groupNUM = pull_port`，即每个策略自己一组；日志里 `15300|group#15300`、`15301|group#15301`…… 因此“同组多行一起改 FV”在生产里基本没有意义（每组只有自己）。[V `cfgField.cpp:308`、日志 `SkylineGUI-20150724-08.12.49.log` 的 `group#` 行]

### 2.6 `Position`：model/view 的持仓表

这是 SkylineFL 里唯一标准的 model/view：

```
QTableView
  └─ ProxySortModel (QSortFilterProxyModel)
        └─ PositionModel (QAbstractTableModel / TableDataModel)
  + PositionDelegate (QItemDelegate)
```

[V `Position.cpp:7-12`、`:38-58`、`PositionModel.h:10-27`]

列（`PositionModel.h:14-27`）：Account、AvgBuy、NetBuyQty、Symbol、NetSellQty、AvgSell、NetPosition、Groups、Mult、Fees、PNL（`MaxCol=11`）。

- `PositionModel::data()`：`DisplayRole` 直接取 `m_Data[row][col]`；`BackgroundRole` 对 NetPos 列（列 6）正绿负红；`ToolTipRole` 走基类。[V `PositionModel.cpp:16-51`]
- `headerData()`：硬编码列名。[V `PositionModel.cpp:53-140`]
- `SetData(QVector<NetPnlInfo>)`：按 `m_symbol` 找行；找不到就 `beginInsertRows` + `push_back` + `FillData`；找到就 `FillData` + `dataChanged`。[V `PositionModel.cpp:142-178`]
- `FillData()`：把 `NetPnlInfo` 的 account/avgBuy/netBuyQty/symbol/netSellQty/avgSell/netQuantity 写进前 7 列；计算 `pnl_new = m_netPNL * mult - fees*(netBuyQty+netSellQty)`；然后做组汇总。[V `PositionModel.cpp:180-208`]
- `AddFromCsv()`：从当前目录 `Position.csv` 读 `Symbol,Group,Mult,Fees`；每个非空 Group 建一个 `"Group"` 行；`m_Group[S]={row,count}`。[V `PositionModel.cpp:232-299`、`Position.csv:1-6`]
- `AddToCsv()`：存在但**从未调用**；`Position::onClose()` 里 `//PosModel->AddToCsv();` 是注释。[V `PositionModel.cpp:302-315`、`Position.cpp:60-70`]
- `setData()`：只允许 Group/Mult/Fees（`flags()`）；改 Mult 按比例重算 PNL；改 Fees 按 `(new-old)*(netBuyQty+netSellQty)` 重算；改 Group 建/并组行。[V `PositionModel.cpp:317-419`]
- `PositionDelegate`：Group 列用 `QLineEdit`，Fees 列用 `QDoubleSpinBox`，其余用 `QSpinBox`；`setModelData` 统一 `model->setData(index, value, Qt::EditRole)`。[V `PositionDelegate.cpp:12-69`]

`Position` 本体：
- 构造时 `PosModel->AddFromCsv()`（当前目录的 `Position.csv`），然后为每个交易所在 GUI 线程里 `new PNLCollector(...)->DoWork()`，连 `DataBatchReady(const QString&)` → `updatePNLData(name)`。[V `Position.cpp:14-35`]
- `updatePNLData()`：`collectors[exchToIdx[name]]->PopDataBatch(pnlBat)` → `PosModel->SetData(pnlBat)`。[V `Position.cpp:72-77`]
- 表头状态用 `QSettings(QSettings::IniFormat, QSettings::UserScope, "Test")` 的 `"PositionCol"` 保存/恢复，而不是其他窗口用的 `AlphaGrep/SkylineGUI`。[V `Position.cpp:50-52`、`:60-66`]

**持仓表的功能缺口**：
- 部署目录 `3/GUI/SH` 没有 `Position.csv`，所以启动时表是空的，所有行都来自 PNL 流；`Group/Mult/Fees` 全为空/1/0。[V `3/GUI/SH` 文件列表；`PositionModel.cpp:237`]
- 用户在表里改的 Group/Mult/Fees **不会写回 CSV**，关窗即丢。[V `Position.cpp:60-70`、`PositionModel.cpp:302-315`]
- `m_MapSymbolRow` 只用 `m_symbol` 做键，不区分 `m_accountId`/`m_exchangeType`/`m_tradingSymbol`；同一 symbol 在不同账户/交易所会合并成一行。[V `PositionModel.cpp:148-168`]
- `FillData()` 的组汇总用 `if (grp != 0)`（`0` 被当作空 `const char*`），且 `m_Group[grp].first` 用 `operator[]` 取，组不存在时默认 `(0,0)`，没有校验 `grp_c` 是否等于当前行。新行 `GroupCol` 为空但非 null 时，首行 PNL 可能被当成“空组汇总行”反复累加。是否触发取决于 Qt 5.3 下 `QString("")` 的 null/empty 状态，建议用样例数据实测；但代码本身没有防线。[V/I]

### 2.7 挂单、成交、订单响应、控制台

**`OpenOrder`（挂单表，9 列）**
- 列：Account、Symbol、Status、ID、Side、Price、Quantity、Time Stamp、Exchange。[V `OpenOrder.h:24-34`]
- `updateTable(QVector<Order>)`：保存 `m_orders`，`while` 调整行数，逐行写 `DisplayLabel`；买绿卖红。[V `OpenOrder.cpp:95-150`]
- 右键行 → `handleRight()`：复制该订单，`Request_Type=CANCELORDER`，弹 `PlaceOrderWidget`，接受后 `ManualOrderSender` 发送。[V `OpenOrder.cpp:68-93`]
- `Cancel All`：弹 `SquareOffAllDialog`（随机码），接受后遍历 `m_orders`，每单一个 `ManualOrderSender` 发送撤单。[V `OpenOrder.cpp:46-66`]

**`FillResponse`（成交表，8 列）**
- 列：Status、Order Id、Symbol、Quantity、Side、Price、Time Stamp、Exchange ID。[V `FillResponse.h:36-45`]
- `updateTable()`：每笔 `insertRow(0)`，写 8 个 `DisplayLabel`，蜂鸣；超过 `rowMax=501` 删最后一行。[V `FillResponse.cpp:118-152`]
- `createMenu()`：`File → Add to Csv`；弹出一个小 `QWidget`（`popup`）输入文件名，`okBtn_clicked()` 把全表写成 CSV。[V `FillResponse.cpp:22-95`]
- `onClose()`：先用当前时间填文件名，再自动 `okBtn_clicked()`，**每次关窗都会导出一个 CSV**；这就是 `3/GUI/SH` 下 50 个 `YYYYMMDD-HH_MM_SS.sss.csv` 的来源。[V `FillResponse.cpp:109-116`；文件名与内容]
- 表里 `Status` 只显示 `order.getOrderDescription()`（通常是 `TRADE_CONFIRM`），没有区分 `Fill m_status` 的 0/1；被拒绝的成交确认也会以同样方式显示。[V `FillResponse.cpp:124-125`；旧日志 `20150504-20.42.41.log` 里 `TRADE_CONFIRM` + `Fill m_status:0`]

**`OrderResponse`（非成交订单响应）**
- `QPlainTextEdit`，`setMaximumBlockCount(6096)`，只读。[V `OrderResponse.cpp:8-19`]
- 每笔非 `TRADE_CONFIRM` 的已结束订单追加一行：本地时间 + symbol + price + side + qty + desc；desc 含 `CANCEL` → `cancelled`，含 `TRADE/FILL` → `filled`，否则原文。[V `OrderResponse.cpp:21-58`]
- 时间用的是 `QDateTime::currentDateTime()`（接收时间），不是订单的 `TimeStamp`。[V `OrderResponse.cpp:26-27`]

**`Console`**
- `QPlainTextEdit`，`maximumBlockCount=4096`；每条前面加 `策略名:`。[V `Console.h:19`、`Console.cpp:21-23`]

**`OpenOrderMsgHub`（数据分发）**
- 构造时为每个交易所 `new OrdersCollector(...)->DoWork()`，并启动两个 `QTimer::singleShot(600ms)`：`PollOpenOrder` 和 `PollCloseOrder`。[V `OpenOrderMsgHub.cpp:4-15`、`.h:31`]
- `PollOpenOrder()`：把各交易所的开放订单 `PopDataBatch` 合并 → `emit orderReady(totalBat)`；再按 `Contract_Description.Symbol` 分组，推给 `signalMap[symbol]->sendSignal(...)`（每个合约窗一个 `Signaller`）。[V `OpenOrderMsgHub.cpp:17-49`]
- `PollCloseOrder()`：把已结束订单 `PopClosedOrdersDataBatch` 合并 → `classifyOrders`；`getOrderDescription()=="TRADE_CONFIRM"` → `tradeOrderReady`（成交表）；其余 → `closeOrderReady`（订单响应）。[V `OpenOrderMsgHub.cpp:51-97`]
- 两个轮询都用 `QTimer::singleShot` 在末尾重新排程，所以周期是“600ms + 处理时间”，会漂移。[V `OpenOrderMsgHub.cpp:46`、`:78`]

### 2.8 旧 GUI（Qt4/Qt5 共享源码）的架构对比

`Mainwindow`：
- `QMainWindow` + 菜单 `Connection`（New/Close/Load/Save）、`Action`（Square Off All/Save Positions）、`Help`（About/About Qt）。[V `Mainwindow.cpp:98-154`]
- 中央是 `QTabWidget`，**每个交易所一个 tab**；`DoConnectService()` 先弹 `ConnectDialog`，再用 `ExchangeNameCollector` 取交易所列表，`ChooseExchangeDialog` 选要显示的交易所，`new ExchangeWidget(...)` 加到 tab。[V `Mainwindow.cpp:171-242`]
- 支持多交易所合并到一个 tab（`AddExchange`）。[V `Mainwindow.cpp:226-233`]

`ExchangeWidget`：
- 内部 `QTabWidget`：`&Orders`、`&Net Positions`、`&Market Data`。[V `ExchangeWidget.cpp:80-93`]
- Orders 页：`QTableView` + `OpenOrdersModel`/`OpenOrdersProxy`；关闭单表用 `ClosedOrdersModel`（`SHOW_TRADES` 宏）。[V `ExchangeWidget.cpp:95-116`、`:282-329`]
- Net Positions 页：`QTableView` + `NetPnlModel`/`ProxySortModel`；下面是 `QGridLayout` 的 PnL 汇总（Options/Futures/Equities/Total × PnL/1Min/5Min/10Min/Ovn/IDay/…）。[V `ExchangeWidget.cpp:331-429`]
- Market Data 页：`MarketDataTab`，里面是 `QMdiArea`；每个 ticker 一个 `QDialog` + `MarketDataWidget`（20 档）。[V `MarketDataTab.cpp:15-87`、`MarketDataWidget.cpp:33-102`]
- 每交易所的 `OrdersCollector` 被 `moveToThread(QThread)`，`started()` → `DoWork()`；`PNLCollector`/`MDCollector` 不移动线程。[V `ExchangeWidget.cpp:809-863`]
- `UpdateOrderData()` 每 6 秒轮询开放/已结束订单；`UpdatePnlTotals()` 每 5 秒重算汇总；`CheckConnections()` 每 10 秒检查；`OnAutoSavePositions()` 10 秒后启动，17:00 后保存，之后每 30 分钟重试。[V `ExchangeWidget.cpp:206-263`、`:437-591`、`:766-806`、`Mainwindow.cpp:289-314`]

`TableView`：
- `setSortingEnabled(true)`、按列 0 降序、`ResizeToContents`、表头可移动、右键菜单。
- Net Positions 右键：Square Off（F2）、View Market Data（F3）；Open Orders 右键：Cancel（F4）、Modify（F5）。[V `TableView.cpp:10-60`、`:127-175`]
- 通过 `dynamic_cast<QAbstractProxyModel*>` + `mapToSource` 找回源行，再调 `TableDataModel::SquareOff/CancelOrder/ModifyOrder`。[V `TableView.cpp:78-125`]

**两代 GUI 的结构差异**

| 维度 | SkylineFL（Qt5） | 旧 GUI（Qt4/Qt5 共享源码） |
|---|---|---|
| 组织单位 | **策略**一行；合约窗按策略打开 | **交易所**一个 tab；orders/positions/MD 三个子 tab |
| 策略表 | `QTableWidget` + 每格 widget | 无“策略表”概念 |
| 持仓 | `QTableView` + `PositionModel`（11 列） | `QTableView` + `NetPnlModel`（30 列，含 1/5/10Min、Ovn、Yield 等） |
| 挂单/成交 | `OpenOrder` 表 + `FillResponse` 表 + `OrderResponse` 文本 | `OpenOrdersModel`/`ClosedOrdersModel` 两个表 |
| 行情 | 合约窗内 20 档 | 独立 `MarketDataWidget` 20 档，MDI 多窗 |
| 连接 | 策略表 Connect + ZMQ | `ConnectDialog` 填地址/端口/用户/口令 |
| 汇总 | 无 | PnL 汇总网格（Options/Futures/Equities/Total） |
| 自动保存 | 成交 CSV | 持仓 CSV（17:00） |

[V 两侧源码]

### 2.9 Qt 机制小结

- **没有 `.ui`/`.qrc`**：所有布局在 C++ 里手写 `QGridLayout/QHBoxLayout/QVBoxLayout`；`find -name '*.ui' -o -name '*.qrc'` 无结果。[V]
- `Q_OBJECT` 类用 `signals:` 返回 `int`（Qt 允许，但非常规）；`emit` 一个返回 `int` 的信号，返回值被忽略。[V 例如 `Container.h:55-63`、`ScrollLabel.h:68-72`]
- Qt4/Qt5 兼容靠 `VersionHeaders.h` 的宏：`TO_ASCII`、`RESIZE_MODE`、`SET_MOVABLE`、`PLACE_HOLDER_TEXT`。[V `VersionHeaders.h:4-18`]
- Qt5 下仍在用 `QString::sprintf`（`MarketDataWidget.cpp:132`）、`QDateTime::fromTime_t`（`OrdersModel.cpp:151`、`NetPnlModel.cpp:314`）、`QWheelEvent::delta()`（`ScrollLabel.h:96`、`ContractScrollLabel.h:57`）——5.3 能编，后续 Qt 版本会陆续废弃/移除。[V]
- `QSettings` 的 org/app 不统一：大多数窗口用 `AlphaGrep/SkylineGUI`；`Position` 用 `IniFormat, UserScope, "Test"`。[V `GuiUtils.h:52`、`Position.cpp:50`]

---

## 3. ZMQ 协议

### 3.1 拓扑与端口

```
┌──────────────────────────────┐        ZMQ PUSH (每策略一个 socket)
│ SkylineFL_GUI                │  ────────────────────────────────────┐
│  PULL bind tcp://*:15213     │                                      │
│  PUSH connect localhost:15300│                                      │
│  PUSH connect localhost:15301│                                      │
│  ...                         │                                      │
│  PUSH connect localhost:15333│                                      │
└──────────────────────────────┘                                      │
              ▲                                                       ▼
              │ ZMQ PUSH (heartbeat/telemetry)          ┌─────────────────────────┐
              │                                         │ 策略进程 (15300..15333) │
              └─────────────────────────────────────────│  PULL bind tcp://*:port │
                                                        │  PUSH connect :15213    │
                                                        └─────────────────────────┘
```

| 方向 | Socket | 绑定/连接 | 地址 | 证据 |
|---|---|---|---|---|
| 策略 → GUI | PULL | GUI **bind** | `tcp://*:15213`（部署值） | `GuiMsgHub.cpp:8`、`GuiSettings.xml:7` |
| GUI → 策略 | PUSH | GUI **connect** | `tcp://localhost:15300..15333` | `GuiMsgHub.cpp:29`、`Container.cpp:207-216` |
| 策略 ← GUI | PULL | 策略 **bind** | `tcp://*:<自己的端口>` | `StrategyMsgHub.cpp:12`、`:92-95` |
| 策略 → GUI | PUSH | 策略 **connect** | `tcp://localhost:15213` | `StrategyMsgHub.cpp:11`、`:22-24` |
| 策略 → GUI 心跳 | PUSH（独立 socket） | 策略 **connect** | `tcp://localhost:15213` | `StrategyMsgHub.cpp:33-41` |

关键点：
- GUI 不是“连到每个策略的 REQ”，而是**一个 PULL 收所有策略，N 个 PUSH 分别发**；`Container::setupMsgHub()` 从 `AppConfig` 取所有策略端口，构造 `std::vector<std::string> ports`，传给 `GuiMsgHub`。[V `Container.cpp:207-220`]
- 策略侧对应 `StrategyMsgHub(push, pull)`：`pushAddr = tcp://localhost:<push>`、`pullAddr = tcp://*:<pull>`。[V `StrategyMsgHub.cpp:7-12`]
- 因此 **GUI 必须先启动并 bind 15213**，否则策略的 PUSH 只能排队/丢弃；策略先启动则 GUI 的 PUSH 可以稍后连上（ZMQ 会自动重连）。[I ZMQ 语义]
- **这套 ZMQ 控制面在源码里对应 `3/leon/CL/SHSH*` 的 `StrategyMsgHub`，不是 `3/TradeBot/TradeBot_China` 的 `main/TradeBot`**。`TradeBot_China` 源码里没有 bind 15300.. 的 `StrategyMsgHub`；它的启动/停止靠 `RunStrategies.sh`、control/model 和 SIGUSR1/SIGTSTP。[V 源码检索；I 线上主用关系]
- **GUI 不直接产生成交**：它只改策略的 `enableFlag`/参数，或发手工单；成交由策略/ORS/交易所完成，GUI 通过 DataService 显示回报。详见 §3.9 与 §5。

### 3.2 消息封装

一条 ZMQ 消息是一个 ASCII 字符串：

```
<port>|<key>#<args>
```

- `<port>`：策略端口，同时也是 GUI 的行索引键（`portToRowIdx`）。
- `<key>`：消息类型。
- `<args>`：参数；可以是空、单个数字、`a,b,c`、甚至带空格的名字。

多条消息可以拼在一个 ZMQ frame 里，用 `;` 分隔：

```
15300|contractName#ag1512,57,quoting;15300|contractName#SIU5,54,driving;15300|group#15300;15300|strategyName#ag1512 SIU5 B-FAKL-1
```

[V `Container.cpp:222-260`；日志 `SkylineGUI-20150724-08.12.49.log` 的 `recv [15300|contractName#...` 行]

解析顺序（`Container::onMsg`）：
1. `qstr.split(";")` 得到多条；
2. 每条 `split("|")`，必须至少 2 段，否则 WARN；
3. 第 0 段是 `port`；查 `portToRowIdx`，未知 port → `ILOG(FATAL)` 后 `continue`（**注意 FATAL 不会退出**）；
4. 第 1 段再 `split("#")`，第 0 段是 `signalKey`，第 1 段是 `args`；
5. 查 `msgMap[signalKey]`，未知 key → WARN；
6. 对每个注册的 callback `emit` 对应信号，参数 `(row, signalKey, args)`。

[V `Container.cpp:222-260`]

**格式的硬限制**：
- `args` 只取 `#` 后的**第一个**片段；如果 console 文本里有 `#`，后半段丢失。[V `Container.cpp:240-247`]
- 如果 console 文本里有 `;` 或 `|`，会被当成多条/多段，产生 WARN 或错误分发。[V 同上]
- 没有长度前缀、没有转义、没有版本号；策略名里出现 `|`/`#`/`;` 都会破坏协议。[V/I]

### 3.3 GUI → 策略命令

| 命令 | 参数 | GUI 触发 | 策略侧行为 | 证据 |
|---|---|---|---|---|
| `connectRequest` | 无 | Connect 按钮；首次心跳自动发 | `sclock::onMsg` 设 `connectGUIFlag=true`，`sendIniMsg()`，发 `initComplete#true` | `Strategy.cpp:274-277`、`sclock.cpp:251-262` |
| `startOrStop` | `true`/`false` | Start/Stop/Stop All | 开/关策略；回 `status#start` 或 `status#stop` + `bidFills#0`/`askFills#0` + console | `Strategy.cpp:279-286`、`sclock.cpp:279-287` |
| `FVAuto` | `true`/`false` | FairValue 复选框 | 设 `FVautoFlag`；回 `FVMidAverageStatus#true/false` | `FairValue.cpp:108-119`、`sclock.cpp:288-291` |
| `bidFairValue` / `askFairValue` | 数值 | FairValue 滚轮/Match | 设 FV；若 MD 就绪立即 `bidGQOrder()/OfferGQOrder()` | `FairValue.cpp:143-154`、`SHCMEFAKLIMITSingleLevels.cpp:734-755` |
| `bidSize` / `askSize` | 数值 | Strategy 滚轮 | 设 size；回 `MSGbidSize/MSGofferSize` | `Strategy.cpp:300-302`、`SHCMEFAKLIMITSingleLevels.cpp:809-822` |
| `bidEdge` / `askEdge` | 数值 | Strategy 滚轮 | 设 edge；若 MD 就绪立即报价 | `SHCMEFAKLIMITSingleLevels.cpp:756-779` |
| `bidSlope` / `askSlope` | 数值 | Strategy 滚轮 | 设 slope | `SHCMEFAKLIMITSingleLevels.cpp:780-793` |
| `bidLean` / `askLean` | 数值 | Strategy 滚轮 | 设 lean | `SHCMEFAKLIMITSingleLevels.cpp:794-808` |
| `bidExlim` / `askExlim` | 数值 | Strategy 滚轮 | 设单边亏损上限（`bidExlim` 用于 `totalPNL <= -bidExlim` 的风控） | `SHCMEFAKLIMITSingleLevels.cpp:823-840`、`SHCMEFAKLIMITSingleLevels.cpp:328` |
| `GuiClose` | 无 | **GUI 从不发** | 策略停用、`connectGUIFlag=false` | `sclock.cpp:263-269`；GUI `closeEvent` 没有发送 |

> 结论：**Lock/Unlock 不是 ZMQ 命令**，只是 GUI 本地断开 Start/ClickLabel 信号；策略不知道“被锁”。[V `Strategy.cpp:258-272`、`ContractWidget.cpp:228-258`]

### 3.4 策略 → GUI 消息

| 消息 | 参数 | 频率/时机 | GUI 处理 | 证据 |
|---|---|---|---|---|
| `heartBeat` | 自己的 port | 每 3 秒 | `rowToHeartBeat[row]=0`；在线判定 | `StrategyMsgHub.cpp:33-59`、`Container.cpp:184-187` |
| `contractName` | `symbol,exchange,quoting/driving` | `connectRequest` 后 | 更新 `StrategyInfo.quoting/driving/ex` | `sendMsg2GUI.cpp:59-68`、`Container.cpp:187-202` |
| `group` | 组号（= port） | 初始化 | `FairValue::adjustGrp` | `sendMsg2GUI.cpp:69-71`、`FairValue.cpp:166-171` |
| `strategyName` | 名字 | 初始化 | Strategy 名称列 + 窗口标题；FairValue 名称列 | `sendMsg2GUI.cpp:72-73`、`Strategy.cpp:393-406` |
| `initBidFairValue` / `initAskFairValue` | `value,increment` | 初始化 | `ScrollLabel::onMsg` 设值和步长 | `sendMsg2GUI.cpp:94-105`、`ScrollLabel.h:26-30` |
| `initBidSize/askSize/edge/slope/lean` | `value,increment` | 初始化 | 同上 | `sendMsg2GUI.cpp:106-153` |
| `initComplete` | `true` | 初始化最后 | 启用 Start | `sclock.cpp:258`、`Strategy.cpp:393-396` |
| `status` | `start`/`stop` | 启停后 | Start/Stop 按钮 enable 切换 | `sclock.cpp:279-287`、`Strategy.cpp:381-392` |
| `bidStatus`/`askStatus` | `hedged/unhedged/cancel/reject` | 订单状态变化 | `FillsLabel` 颜色 | `sclock.cpp:53-91`、`FillsLabel.h:11-27` |
| `bidFills`/`askFills` | 数量 | 成交/停止 | `FillsLabel` 文本/颜色 | `sclock.cpp:98-103`、`Strategy.cpp:393-406` |
| `bidPrice`/`askPrice` | 价格 | 行情/报价变化 | 价格 `DisplayLabel` | `Strategy.cpp:154-157`、`sendMsg2GUI` |
| `impliedBidFairValue`/`impliedAskFairValue` | 数值 | 行情变化 | FairValue 只读列 | `sendMsg2GUI.cpp`、`FairValue.cpp:209-221` |
| `bidFvmaFV`/`offerFvmaFV` | 数值 | FV mid average | 勾选时覆盖 FV | `FairValue.cpp:183-207` |
| `FVMidAverage` | 数值 | 定时 | 显示 | `FairValue.cpp:209-221` |
| `FVMidAverageStatus` | `true/false` | FVAuto 切换 | 禁用/启用 FV 编辑 | `FairValue.cpp:172-182` |
| `console` | 文本 | 任意 | Console 追加（前缀策略名） | `Container.cpp:127-130`、`Console.cpp:21-23` |

**日志里的真实统计**（`SkylineGUI-20150724-08.12.49.log`，一天）：

| 消息 | 条数 |
|---|---|
| `impliedBidFairValue` | 1,729,691 |
| `bidPrice` | 1,084,893 |
| `FVMidAverage` | 431,371 |
| `heartBeat` | 118,221 |
| `bidStatus` / `askStatus` | 3,948 / 3,835 |
| `console` | 1,375 |
| `bidFills` / `askFills` | 806 / 799 |
| `status` | 90 |
| `initComplete` | 17 |
| `initBidFairValue` / `contractName` | 17 / 17 |

[V `grep -o 'recv \[[0-9]*|[a-zA-Z]*' ... | sort | uniq -c`]

这组数字说明：
- 真正的交易事件（status/fills）只占极小比例；**99% 的日志是行情/FV 遥测**。
- 17 个 `initComplete` 对应 17 个在线策略；`GuiSettings.xml` 有 34 个槽位。[V]

### 3.5 连接/初始化时序

```
GUI                                     策略
 |  bind PULL *:15213                     |
 |                                        |  bind PULL *:15300
 |                                        |  PUSH connect :15213
 |                                        |---- heartBeat#15300 (每3s) ---->|
 |  checkHeartBeat(): rowToHeartBeat=0     |
 |  onIsConnect(true): send connectRequest |
 |---- connectRequest ------------------->|
 |                                        |  connectGUIFlag=true
 |                                        |  sendIniMsg():
 |<--- contractName#..., group#..., ------|
 |     strategyName#..., init*#... -------|
 |<--- initComplete#true -----------------|
 |  启用 Start；自动 lock 该行             |
 |                                        |
 |  用户 Unlock → Start                    |
 |---- startOrStop#true ------------------>|
 |                                        |  enableFlag=true
 |<--- status#start -----------------------|
 |                                        |
 |  用户滚轮/ Match                        |
 |---- bidSize#4 / bidFairValue#... ----->|
 |                                        |  改参数/重报价
 |<--- bidPrice#... / bidStatus#... -------|
 |<--- bidFills#... / console#... ---------|
 |                                        |
 |  用户关窗（不发 GuiClose）               |
 |  X  (策略仍认为 GUI 在线)                |
```

[V 代码 + 日志时序]

### 3.6 心跳与断线判定

- 策略 `heartBeat()`：独立 PUSH socket，每 3 秒发 `pullPort|heartBeat#pullPort`；`ZMQ_SNDTIMEO=-1`（无限阻塞）。[V `StrategyMsgHub.cpp:33-59`]
- GUI `HEARTBEAT_PERIOD=1000ms`，`HEARTBEAT_THRESHHOLD=6`；`rowToHeartBeat` 初始为 6，收到心跳置 0，每秒对未收到心跳的行 +1；≥6 判离线。[V `Container.h:83`、`Container.cpp:34`、`:57-80`]
- 离线：Connect 按钮变红；若之前在线，禁用 Start/Stop 并三声蜂鸣。[V `Strategy.cpp:355-370`]
- 恢复：下一次心跳会再次触发 `onIsConnect(true)`；由于 `btn->getIsConnect()` 为 false，会**再发一次 `connectRequest` 并再次 lock**；策略回 `initComplete`，但**不会主动回 `status#start`**，所以如果策略其实还在跑，GUI 会暂时显示“可 Start”。[V `Strategy.cpp:340-354`、`sclock.cpp:251-262`]
- 这会造成**断线重连后的状态错位**：GUI 认为 stopped，策略可能 running；用户再点 Start 会重复下发 `startOrStop#true`。[I]

### 3.7 端口分配：静态配置 vs 动态抢占

- GUI 的 `GuiSettings.xml` 固定 34 个 `<Strategy>`，端口 15300–15333，一行一个。[V `3/GUI/SH/GuiSettings.xml:19-290`]
- 策略侧 `.PortsFile` 也是 34 行，正好 15300–15333。[V `3/leon/.PortsFile:1-34`（34 行）]
- 策略启动时 `cfgField::getSocketPort()` 从 `.PortsFile` 里**顺序找第一个 connect 失败的端口**（即未被占用的端口）作为 `pull_port`。[V `cfgField.cpp:687-735`]
- `groupNUM = pull_port`；`push_port` 来自策略配置的 `Z|PUSHPort`（部署为 15213）。[V `cfgField.cpp:289-308`、`3/leon/CL/config/.strategy_new.cfg:1-2`]

**风险**：GUI 用“端口 → 行号”映射，而策略用“第一个空闲端口”动态占位。只要启动顺序变化（某个策略崩溃后单独重启、或 `startAll` 并发启动），策略就可能拿到一个与它“原配置行”不同的端口。GUI 会把该策略显示在端口对应的行上，行号与策略名不再匹配运维预期；参数/分组也会跟着错位。[V/I]

日志显示 2015-07-24 只有 15300–15316 共 17 个心跳，说明 17 个策略进程在线，另外 17 个槽位空着；这与“34 个配置槽位”不是一回事。[V]

### 3.8 手工单与 SquareOff：不走 ZMQ

这是最容易被误解的一点：**ZMQ 只用于策略控制/遥测；下单/撤单/改单/行情/持仓/挂单/成交全部走 DataService 的 TCP 命令流。**

```
GUI ──TCP──> DataService ──> ORS/交易所
GUI ──ZMQ──> 策略进程 ──CommonClient/ORS──> 交易所
```

- `ManualOrderSender` 继承 `DataCollector`，构造 `ManualOrderCommand`，设置 `ClientId/ExchangeType/Order/CommandType`，`Request_Type` 映射到 `OrderType::New/Cancel/Modify`，或 `CancelAll`。[V `ManualOrderSender.cpp:24-79`]
- 连接参数默认 `127.0.0.1:20000`，用户名/口令硬编码在 `ConnectionDetails.h:14-19`（源码里还有 `TODO: Remove these details`）；本文不复述具体值。[V]
- `DataCollector::DoWork()`：`new CommandStream<QTcpSocket>` → `Init()`（`InitializeCommand` + `LogIn`）→ `SendCommand()`。[V `DataCollector.cpp:121-141`]
- `InitializeCommand()`：`connectToHost(address, port)` → `waitForConnected()`（默认 30 s）→ 写 `CommandExchangeInitMessage` → `waitForBytesWritten()` → `waitForReadyRead()` → 读 `CommandReplyMessage`。[V `DataCollector.cpp:35-85`]
- `LogIn()`：写 `LoginCommand`（用户名/口令）→ `waitForBytesWritten()` → `waitForReadyRead()` → 读 `LoginReplyStructure`；**没有检查 `read()` 的返回值**，失败时用的是未初始化的栈上 `loginreply`。[V `DataCollector.cpp:88-102`]
- `ManualOrderSender` 不等待订单确认；`DoWork()` 返回 true 只代表“字节已写给 DataService”。[V `ManualOrderSender.cpp:68-72`]
- `ManualOrderSender` 把 `Duration=DAY`、`PxType=PERUNIT` 写死。[V `ManualOrderSender.cpp:32-33`]

**SkylineFL 没有连接对话框**：所有 `ConnectionDetails` 都是默认构造（127.0.0.1:20000），交易所来自 `GuiSettings.xml` 的 `ExchangeList`。旧 GUI 才有 `ConnectDialog`（地址/端口/用户/口令/保存会话）。[V `ContractWidget.h:69`、`OpenOrder.cpp:55`、`Position.cpp:24`、`ConnectDialog.cpp:18-76`]

**SquareOff/Cancel All 的确认**：
- `SquareOffAllDialog`：`srand(time(NULL))` + `rand()%1000`，把随机码显示在同一个对话框里，要求用户输入；这是“防误点”，不是授权。[V `SquareOffAllDialog.cpp:9-33`]
- `OpenOrder::cancelAll()`：确认后遍历 `m_orders`，每单一个 `ManualOrderSender`（每单一次 TCP 连接/登录/握手）。[V `OpenOrder.cpp:46-66`]
- `ExchangeWidget::OnCancelAllOrder()`：只取第一行的 index 来构造 `CancelAll` 命令，实际是按该行的交易所撤所有。[V `ExchangeWidget.cpp:636-664`]
- `ExchangeWidget::OnSquareOffAll()`：遍历 NetPnl 代理的所有行，每个仓位一个 `ManualOrderSender`，串行发送。[V `ExchangeWidget.cpp:737-764`]

### 3.9 协议层缺陷

| 缺陷 | 说明 | 证据 |
|---|---|---|
| 无认证 | 两个方向都没有 CURVE/ZAP/HMAC/白名单；GUI/策略只认 `port` 字符串 | `GuiMsgHub.cpp:8`、`StrategyMsgHub.cpp:12` |
| 绑定所有网卡 | `tcp://*:15213`、`tcp://*:15300..`；不是 `127.0.0.1` | 同上 |
| 无版本号 | 消息没有 schema/version；字段增删只能靠“双方同时改” | `Container.cpp:222-260` |
| 无请求 ID/ACK | `connectRequest/startOrStop` 没有序号；重复发送可能重复执行 | `Strategy.cpp:274-286` |
| 分隔符冲突 | 分号、竖线、井号都没有转义；console 文本可能破坏解析 | `Container.cpp:225-247` |
| 无长度限制 | 单条消息可任意长；`QString::split` 全量复制 | 同上 |
| 无流控 | GUI 每个滚轮 notch 发一条；策略 `usleep(100000)` 每条消息后睡 10 ms，实际限速 100 条/s | `StrategyMsgHub.cpp:117-119` |
| 无关闭握手 | GUI 不发 `GuiClose`；策略 `connectGUIFlag` 永远为 true | `Container.cpp:18-25`、`sclock.cpp:263-269` |
| 无错误回传 | 策略参数非法（`atof("abc")=0`）也当合法；GUI 不知道 | `SHCMEFAKLIMITSingleLevels.cpp:823-840` |

---

## 4. UI 功能逐项

### 4.1 策略参数编辑（`ScrollLabel`）

`ScrollLabel` 继承 `DisplayLabel`（`QLabel`），行为：
- 构造：`installEventFilter(this)`，`step=0.5`，`lowerBound=-INT_MAX`，`clickFlag=false`。[V `ScrollLabel.h:14-24`]
- `eventFilter`：
  - `Leave`：恢复背景色、`clickFlag=false`、发 `leave()`（没人连）。[V `:77-80`]
  - `MouseButtonPress`（左键）：背景变浅绿，发 `leftclicked()`；若 `clickFlag` 为 false 则置 true，否则发 `sendSignal()`（没人连）。[V `:81-91`]
  - `Wheel`：**只有 `clickFlag==true` 才处理**；`delta()>0` 加 `step`，否则减；`max(val, lowerBound)`；接近 0 时显示 `"0"`；`setText`；发 `valueChanged(row,col,pre,cur)`。[V `:92-113`]
- `onMsg(QString s)`：`s.split(",")`，取 `[0]` 值和 `[1]` 步长；**没有检查 size**，若策略只发一个数就越界崩溃。[V `ScrollLabel.h:26-30`]

使用方式：
- Strategy 表：`bidExlim`/`bidSize`/`bidEdge`/`bidSlope`/`bidLean` + 卖侧对应列；`setLowerBound(0)` 用于 size/exlim；`setLowerBound(1)` 用于 lean；edge/slope 无下界。[V `Strategy.cpp:149-225`]
- FairValue 表：`bidCol`/`askCol`/`groupCol`；`groupCol` 的 step=1、lowerBound=0。[V `FairValue.cpp:63-94`]
- 每个滚轮 notch 立即发一条 ZMQ；没有 debounce/throttle。[V `Strategy.cpp:300-302`、`FairValue.cpp:143-154`]

**交易风险**：策略的 `bidFairValue/bidSize/bidEdge` 处理器在 MD 就绪时会立刻 `bidGQOrder()`（撤/重报）。用户快速滚轮会生成一串撤单/新单，没有确认、没有节流、没有“改动未生效”提示。[V `SHCMEFAKLIMITSingleLevels.cpp:734-779`；I 影响]

### 4.2 买/卖控制与锁定

- Strategy 表每行有 `Connect/Start/Stop/Lock` 四个按钮。[V `Strategy.cpp:126-147`]
- `Connect` 只发 `connectRequest`，不改变 Start/Stop；Start 要等 `initComplete` 才 enable。[V `Strategy.cpp:393-396`]
- Lock 本地断 Start 按钮；Stop 始终可用；ContractWidget 的 ClickLabel 下单被断开，但改/撤单仍可用。[V `Strategy.cpp:258-264`、`ContractWidget.cpp:228-258`]
- `Stop All` 只对 Stop 按钮 `isEnabled()` 的行发停止；如果某行从未连接/未初始化，Stop 是 disabled，`stopAll` 会跳过它。[V `Strategy.cpp:77-87`]
- `Lock All`/`Unlock All` 只改 UI 和本地信号，不通知策略。[V `Strategy.cpp:89-107`]

### 4.3 持仓/PnL

SkylineFL 的持仓表是**简化版**：
- 只有 11 列：Account/AvgBuy/NetBuyQty/Symbol/NetSellQty/AvgSell/NetPosition/Groups/Mult/Fees/PNL。[V `PositionModel.h:14-27`]
- 没有旧 GUI 的 `LTP/NetVal/OVNNetExp/NetExp/LTT/1MinDiff/5MinDiff/10MinDiff/Yield/RPnL/URPnl/Trade%/OpType/Expiry/1MinPnL/5MinPnL/10MinPnL/OvnPnL/IDPnL` 等 30 列。[V `NetPnlModel.cpp:14-213` vs `PositionModel.cpp:53-140`]
- 没有旧 GUI 的 Options/Futures/Equities/Total 汇总网格。[V `ExchangeWidget.cpp:331-368`]
- PnL 颜色：`PositionModel::data` 对 NetPos 列（6）正绿负红；旧 GUI 对 PnL 列（eCol_NetPnl）浅绿/浅红背景。[V `PositionModel.cpp:32-43`、`NetPnlModel.cpp:435-453`]
- 数据来自 `PNLCollector` 推送，不是定时轮询；每个交易所一个 collector。[V `Position.cpp:23-35`、`PNLCollector.cpp:42-57`]
- 组/乘数/手续费可编辑，但不持久化（见 §2.6）。[V `PositionModel.cpp:317-419`、`Position.cpp:60-70`]

### 4.4 挂单、成交、订单响应

| 视图 | 内容 | 上限 | 更新方式 |
|---|---|---|---|
| OpenOrder | 当前挂单 | 无硬上限（表行数随订单数） | `OpenOrderMsgHub` 600 ms 轮询 |
| FillResponse | `TRADE_CONFIRM` | 501 行 | 推送，插到顶部 |
| OrderResponse | 非成交的已结束订单 | 6096 个 block | 推送，追加文本 |
| ContractWidget 的 bid/askOrder | 该合约的开放买卖单 | 随订单数 | `Signaller` 推送，600 ms |
| 旧 GUI 的 ClosedOrdersModel | 已结束订单 | `cClosedOrderWindow=500`（内部保留 600，超出删前 100） | 6 s 轮询 |

[V `OpenOrderMsgHub.cpp`、`FillResponse.h:48`、`OrderResponse.h:38`、`OrdersCollector.cpp:12-14`、`ExchangeWidget.cpp:206-241`]

**SkylineFL 没有“已完成订单”表**：已结束的非成交订单只进 `OrderResponse` 文本；成交只进 `FillResponse` 表。旧 GUI 有 `ClosedOrdersModel` 表。[V 两侧 `.pro`/源码]

### 4.5 公允价值、FVMidAverage、组

- `FairValue` 表每行一个策略；`impliedBid/Ask` 只读，`bid/ask` 可编辑，`Match` 把 implied 填入可编辑列并下发。[V `FairValue.cpp:40-141`]
- `FVAuto` 复选框：勾选后策略用 `bidFvmaFV/offerFvmaFV` 自动覆盖 FV；GUI 同时禁用 bid/ask 的 `ScrollLabel`（`FVMidAverageStatus#true`）。[V `FairValue.cpp:108-119`、`:172-182`]
- `FVMidAverage` 只显示，不参与编辑。[V `FairValue.cpp:96`、`:209-221`]
- `group` 列：默认行号；策略发 `group#port` 后变成端口；同组多行会一起改 FV。生产里每组只有自己（见 §2.5）。[V `FairValue.cpp:86-94`、`cfgField.cpp:308`]

### 4.6 行情与合约窗口

- 每个 `ContractWidget` 自己订阅一个 symbol 的 MD；20 档买卖价/量；买价蓝、卖价红；锁定时不改变颜色（`if (!isLock)`）。[V `ContractWidget.cpp:308-328`]
- `Volume` 是 `m_totalTradedQuantity`；`LTP` 是 `m_lastTradedPrice`；`TimeStamp` 是 `convertTime(m_timestamp).mid(9,12)`（只取 `hh:mm:ss` 部分）。[V `ContractWidget.cpp:330-332`]
- `Size` 是 `QSpinBox`，默认 0；为 0 时 `sendNewOrder` 直接返回 -1，不弹下单框。[V `ContractWidget.cpp:97-98`、`:118-119`]
- 旧 GUI 的 `MarketDataWidget` 也是 20 档，但用 `QTableWidgetItem`，支持右键 Place Order；`MarketDataTab` 用 `QMdiArea` 管理多个行情窗。[V `MarketDataWidget.cpp:33-102`、`:144-182`、`MarketDataTab.cpp:15-87`]

### 4.7 控制台、日志、CSV

- `Console`：策略 `console#text` → `策略名:text` 追加；`maximumBlockCount=4096`，超出自动截断。[V `Console.cpp:21-23`、`Console.h:19`]
- `OrderResponse`：`QPlainTextEdit`，6096 blocks；每笔非成交响应一行。[V `OrderResponse.h:38`、`OrderResponse.cpp:21-58`]
- `FillResponse`：关窗自动导出 CSV；文件名是 `yyyyMMdd-hh:mm:ss.zzz.csv`，无表头，500 行左右。[V `FillResponse.cpp:68-95`、`:109-116`；`3/GUI/SH/20150724-20_35_50.724.csv`]
- 运行日志：`SkylineGUI-YYYYMMDD-HH.MM.SS.log`，写在当前目录；INFO 级别记录每条收/发消息。[V `GuiMsgHub.cpp:53`、`:85`]
- 旧 GUI：`FrontEndConfig.xml` 的 `AutoSave path="/home/punit/pnl/" fileName="pnl_%1.csv" time="1700"`；17:00 自动保存持仓 CSV。[V `FrontEndConfig.xml:4`、`Mainwindow.cpp:289-314`]

### 4.8 配置项

| 配置 | 读者 | 关键内容 | 运行时可否修改 |
|---|---|---|---|
| `GuiSettings.xml`（SkylineFL） | `Main.cpp:8-59` | `CompanyName/ApplicationName/Font/FontSize/RowHeight/ServerPort`；`ExchangeList`；`StrategyList`（Name/Port/Quoting/Driving/QuotingExchange/DrivingExchange） | 否，改文件后重启 |
| `QSettings(AlphaGrep, SkylineGUI)` | `GuiUtils.h:52`、`Dialog.cpp:10` | 主窗 geometry/state、各 Dialog geometry、表列宽 | 是，自动 |
| `QSettings(IniFormat, UserScope, "Test")` | `Position.cpp:50` | `PositionCol` 表头状态 | 是，自动 |
| `Position.csv`（当前目录） | `PositionModel.cpp:237` | `Symbol,Group,Mult,Fees` | 只读；不写回 |
| `fills.csv` / `yyyyMMdd-*.csv` | `FillResponse` | 成交表导出 | 关窗自动写 |
| `FrontEndConfig.xml`（旧 GUI） | `GuiConfiguration.cpp:21-33` | Version、AutoSave path/fileName/time | 否 |
| `.PortsFile`（策略侧） | `cfgField.cpp:691` | 15300–15333 | 否 |
| `.strategy_new.cfg`（策略侧） | `cfgField.cpp` | `Z` 字段里的 `PUSHPort`（15213）及各策略参数 | 否 |

**部署 vs 源码的 `GuiSettings.xml` 差异**：

| 键 | 源码树 | 部署 |
|---|---|---|
| `ServerPort` | `15150`[V `GuiSettings.xml:2`] | `15213`[V `3/GUI/SH/GuiSettings.xml:7`] |
| 策略数 | 4[V `:13-46`] | 34[V `:18-291`] |
| 端口 | 15111/15152/15153/15129 | 15300–15333 |
| 策略名 | A/B/C/D | 空（运行时由 `strategyName` 填） |
| Quoting/Driving | au1412/500209 等 | 空（运行时由 `contractName` 填） |
| 字体 | 无 | Helvetica 9 |
| 行高 | 无 | 24 |

`GuiSettings.xml` 在部署时是“超集 + 运行期补齐”；源码树的配置只是开发样例，不能当生产配置。[V/I]

---

## 5. 数据流与状态

### 5.1 三条数据通路

```
① 控制/遥测（ZMQ，双向）
   GUI ── connectRequest/startOrStop/params/FVAuto ──> 策略进程
   GUI <── heartBeat/status/fills/price/FV/console ─── 策略进程

② 行情/持仓/挂单/成交（TCP，DataService 命令流）
   GUI ── MDCollector/PNLCollector/OrdersCollector ──> DataService
   GUI <── MarketUpdateWithOrderIndication / NetPnlInfo / Order ── DataService

③ 手工单/撤单/改单/撤所有（TCP，DataService 命令流）
   GUI ── ManualOrderSender(ManualOrderCommand) ──> DataService ──> ORS/交易所
```

**GUI 不直接连 TradeBot**。TradeBot/策略进程通过 `CommonClient`/ORS 发单；GUI 的手工单走 DataService 的 `ManualOrderCommand`，由 ORS 处理。三者共享同一个交易所/账户体系，但网络路径不同。[V DataService 代码；I ORS 路由]

### 5.2 启动与刷新时序

| 时间/触发 | 动作 | 证据 |
|---|---|---|
| GUI 启动 | `Main` 读 `GuiSettings.xml`；初始化 logger | `Main.cpp:61-69` |
| `Container` 构造 | `OpenOrderMsgHub` 为每个交易所建 `OrdersCollector` 并同步 `DoWork()` | `Container.cpp:38-40`、`OpenOrderMsgHub.cpp:6-11` |
| `initWidget` | 7 个窗口全部 `show()`；`Position` 为每个交易所建 `PNLCollector` 并同步 `DoWork()` | `Container.cpp:262-285`、`Position.cpp:23-35` |
| `setupMsgHub` | bind `tcp://*:15213`；为每个策略建 PUSH 并 connect `localhost:port`；启动接收线程 | `Container.cpp:207-220`、`GuiMsgHub.cpp:25-41` |
| `setupMonitor` | `rowToHeartBeat` 填 6；1 ms 后启动 `checkHeartBeat` | `Container.cpp:57-66` |
| 每 1 s | 心跳检查；在线/离线 UI | `Container.cpp:68-80` |
| 首次心跳 | 发 `connectRequest`；自动 lock | `Strategy.cpp:340-354` |
| 策略初始化 | 一批 `contractName/group/strategyName/init*` + `initComplete` | `sclock.cpp:251-262`、`sendMsg2GUI.cpp:50-155` |
| 每 600 ms | `PollOpenOrder` + `PollCloseOrder` | `OpenOrderMsgHub.cpp:17-82` |
| 行情到达 | `MDCollector::ReadSocket` 解析结构体 → `DataBatchReady` → `ContractWidget::updateTickerData` | `MDCollector.cpp:79-94`、`ContractWidget.cpp:300-337` |
| PnL 到达 | `PNLCollector::ReadSocket` → `DataBatchReady(name)` → `Position::updatePNLData` → `PositionModel::SetData` | `PNLCollector.cpp:42-57`、`Position.cpp:72-77` |
| 挂单/成交到达 | `OrdersCollector::ReadSocket` 累积 → 600 ms 轮询取出 → `OpenOrder`/`FillResponse`/`OrderResponse`/`ContractWidget` | `OrdersCollector.cpp:50-86`、`OpenOrderMsgHub.cpp` |
| 关窗 | 保存 geometry/列宽；`FillResponse` 导出 CSV；**不发 `GuiClose`** | `Dialog.cpp:27-34`、`FillResponse.cpp:109-116`、`Container.cpp:18-25` |

### 5.3 状态住在哪里

| 状态 | 存放位置 | 生命周期 | 是否持久化 |
|---|---|---|---|
| 配置（端口/交易所/策略槽位/字体） | `AppConfig` 单例（`GuiConfig.h`） | 进程 | `GuiSettings.xml` |
| 策略名/合约/交易所 | `StrategyInfo`（`AppConfig`）+ `Strategy::strat_name` | 进程；被 ZMQ 消息覆盖 | 否（部署配置里为空） |
| 心跳计数 | `Container::rowToHeartBeat` | 进程 | 否 |
| 策略表显示 | `QTableWidget` 的 cell widgets | 进程 | 列宽在 QSettings |
| 持仓 | `PositionModel::m_Data` | 进程 | 启动读 `Position.csv`，不写回 |
| 组/乘数/手续费 | `m_Data` 的 Group/Mult/Fees 列 + `m_Group` | 进程 | 否 |
| 挂单/成交 | `OrdersCollector` 的 `m_OpenOrders/m_ClosedOrders`；各表控件 | 进程 | 成交 CSV（关窗） |
| 订单响应 | `OrderResponse` 的 `QPlainTextEdit` | 进程 | 否 |
| 控制台 | `Console` 的 `QPlainTextEdit` | 进程 | 日志文件 |
| 行情 | `MDCollector::m_MarketUpdates`（每合约一个） | 进程 | 否 |
| 窗口几何/列宽 | `QSettings` | 跨进程 | 是 |
| GUI 是否“在线” | 策略侧 `connectGUIFlag` | 策略进程 | 否；GUI 关闭不通知 |

### 5.4 一次手工交易的完整路径

1. 用户在 `ContractWidget` 的 `orderBook` 点买价/卖价。
2. `ClickLabel::eventFilter` 发 `leftClickSignal/rightClickSignal`。
3. `ContractWidget::sendBuy/sendSell` → `sendNewOrder(lb, 'B'/'S')`。
4. 组装 `PlaceOrderInfo`：`AccountID="OWN"`、`Symbol=m_name`、`Quantity=orderSize`、`Price=lb->text()`、`Request_Type=NEWORDER`、`Transaction_Type`。[V `ContractWidget.cpp:121-131`]
5. `PlaceOrderWidget` 模态编辑；用户点 SEND → `accept()`；`GetOrder` 回填（其实 `m_OrderInfo` 是引用，`OnSend` 已直接改）。[V `PlaceOrderWidget.cpp:177-207`]
6. `ManualOrderSender(connDetail, exchangeDetail, inOrder.m_Order)`：
   - `DataCollector::DoWork()` → `InitializeCommand()`（TCP 连接/握手）→ `LogIn()` → `SendCommand()`。
   - `SendCommand()` 写 `ManualOrderCommand`（`OrderType::New`），`waitForBytesWritten()`，返回 true。
7. GUI 把点击的价格格染绿，`ILOG(INFO) << "Sent new order"`；**没有等待交易所/ORS 的确认**。[V `ContractWidget.cpp:134-141`]
8. 成交/拒绝最终通过 `OrdersCollector` 的 `TRADE_CONFIRM` 回到 `FillResponse`（蜂鸣）和 `OrderResponse`。[V `OpenOrderMsgHub.cpp:51-82`]
9. 如果 `ManualOrderSender::DoWork()` 返回 false（DataService 不可达/登录失败），GUI 只跳过“Sent new order”日志，**没有错误对话框**。[V `ContractWidget.cpp:136-140`、`DataCollector.cpp:121-141`]

### 5.5 一致性与丢失场景

| 场景 | 结果 | 证据 |
|---|---|---|
| GUI 先关，策略后关 | 策略继续 push；`connectGUIFlag` 仍 true；HWM 满后 `zmq_send` EAGAIN，策略日志 FATAL（但不退出） | `sclock.cpp:263-269` 没人调用；`StrategyMsgHub.cpp:61-75` |
| GUI 重启 | 策略收到 `connectRequest` 重发 init；不会重发 `status#start`；GUI 可能显示 stopped 而策略仍在跑 | `sclock.cpp:251-262` |
| 心跳短暂丢失 | GUI 变红/三声蜂鸣；恢复后自动 `connectRequest` + 自动 lock，可能把运行中的策略锁住 | `Strategy.cpp:340-354` |
| 订单已成交但表未刷新 | `OpenOrder` 仍显示 600 ms 内的旧单；用户撤单会收到 ORS 拒绝 | `OpenOrderMsgHub.cpp` 600 ms |
| 持仓 symbol 跨交易所同名 | `PositionModel` 合并成一行 | `PositionModel.cpp:148-168` |
| 手工单 `OrdType` 未初始化 | ORS 可能按随机枚举解释（限价/市价/其他），导致拒绝或错误类型 | `Order.cpp:58-63`、`GuiUtils.h:77-95`、`PlaceOrderWidget.cpp:177-207` |
| 手工单价格/数量为 0 | `getEmptyOrder` 置 0；`PlaceOrderWidget` 允许 0；没有校验 | `PlaceOrderWidget.cpp:190-192` |
| 合约窗打开过早 | `contractName` 未到，`quoting/driving` 为空 → `setupMDCollector` 返回 -1；窗口永久空表，不会因后续消息重建 | `Strategy.cpp:310-320`、`ContractWidget.cpp:147-148` |
| 成交被拒绝 | `FillResponse` 只显示 `TRADE_CONFIRM`，不区分 `Fill m_status` | `FillResponse.cpp:124-125`；旧日志示例 |

---

## 6. 源码 vs 运行态

### 6.1 产物对照

| 产物 | 类型 | Qt | 时间 | BuildID | 大小 | 判定 |
|---|---|---|---|---|---|---|
| `3/dalong/FromDaya/SkylineFL_GUI/SkylineFL_GUI` | 源码树内构建 | 5.3.1 | 2015-03-19 | `1aecd50d…` | 1,862,816 | 本机构建，**未见部署** |
| `3/GUI/SH/SkylineFL_GUI` | 线上部署 | 5.3.1 | 2014-12-21 | `a2e432bd…` | 1,882,103 | **线上当前** |
| `3/GUI/SH/SkylineFL_GUI.bak` | 上一版 | 5.3.1 | 2014-12-03 | `5f15f309…` | 1,882,007 | 回滚备份 |
| `3/infra/TradingSystemsGUI/TradingSystemsGUI` | Qt4 旧 GUI | 4.8.6 | 2014-09-26 | `76f8f101…` | 533,963 | 旧运行态 |
| `3/infra/TradingSystemsGUI/TradingSystemsGUI.Old` | 更旧 | 4.8.6 | 2014-08-21 | `2d6e24d5…` | — | 旧备份 |
| 源码 `.cpp/.h`（SkylineFL） | 源码 | — | **2014-11-20** | — | — | 全目录无更晚的 `.cpp/.h` |

[V `file`、`stat`、`ls -lt`、`strings | grep BuildID`、`00-inventory.md:243-251`]

### 6.2 时间线修正：线上二进制并不比源码“旧 3 个月”

`00-inventory.md:245` 写“`3/GUI/SH/SkylineFL_GUI` 比源码旧：源码树自编版本是 2015-03-19”。更准确的说法是：

- SkylineFL 源目录里**所有 `.cpp/.h` 的 mtime 都是 2014-11-20**；`find . -maxdepth 1 -name '*.cpp' -o -name '*.h' -newermt '2014-11-21'` 无输出。[V]
- 线上二进制 2014-12-21，**晚于源码最后修改约 1 个月**。[V]
- 源码树里的 2015-03-19 二进制只是**同一份源码的再次构建/重链接**，不是“更新的源码”。[I]
- 线上日志的行号与归档源码逐行一致：
  - `Container.cpp:59` = `ILOG(INFO) << "Init heartbeat "`，日志 `SkylineGUI-20150724-08.12.49.log` 有 `[Container.cpp:59] |Init heartbeat 15300`。[V]
  - `GuiMsgHub.cpp:85` = `ILOG(INFO) << "recv ["`，日志每条 `recv` 都是 `[GuiMsgHub.cpp:85]`。[V]
  - `Position.cpp:29` = `ILOG(INFO) << "init pnl collector "`，日志有 `[Position.cpp:29] |init pnl collector 57`。[V]
  - `ContractWidget.cpp:20` = `ILOG(INFO) << "contractWidget destructor"`，日志尾部有 `[ContractWidget.cpp:20]`。[V]

因此：**至少这四个文件，线上二进制与归档源码是同源的**；“2015-03-19 构建”没有部署，不代表代码更新。真正需要解释的是“为什么 2015-03-19 的重建没有上线”，而不是“线上比源码旧”。[V/I]

### 6.3 Qt4 旧 GUI：二进制比源码旧 11 天，且缺符号链接

- 二进制 `2014-09-26 16:01`，BuildID `76f8f101…`。[V `stat`/`file`]
- 二进制内嵌的源文件名是 `Mainwindow.cpp`/`ExchangeWidget.cpp`，**不是** `Container.cpp`；`strings TradingSystemsGUI | grep -i zmq` 无输出 → 旧 GUI 不依赖 ZMQ，只走 DataService 的 QTcpSocket。[V]
- 共享源码 `TradingSystemsGUI` 在 git 里的最后三条提交：
  - `fbd2a1e2 2014-10-06 changes for net exposure - also overnight net exp`
  - `01aaffcb 2014-10-07 fixing the bug for net exp`
  - `345637ee 2014-10-07 removed showing of junk in market data widget`
  [V `git log`]
- 所以 Qt4 二进制**不包含** 10-06/10-07 的净敞口/隔夜净敞口改动；用归档源码重编会得到不同行为。[V/I]
- `3/infra/TradingSystemsGUI` 只有 `libQtCore.so.4.8.6`、`libQtGui.so.4.8.6`、`libQtNetwork.so.4.8.6`，**没有 `libQtCore.so.4` 等 SONAME 符号链接**；`runGUI.sh` 只设 `LD_LIBRARY_PATH=.`。[V `ls -la`、`runGUI.sh:2`]
- `2/GUI/TradingSystemsGUI.tar.gz` 里保留了这些符号链接（`libQtCore.so.4 -> libQtCore.so.4.8.6` 等）。[V `tar -tzvf`]
- 结论：`3/infra/TradingSystemsGUI` 这份**按原样不能独立启动**；要么恢复符号链接，要么依赖系统 Qt 4.6.2（`2/usr/lib64/libQtCore.so.4.6.2`，ABI 兼容但行为不同）。[I]

Qt4 日志：
- 148 个 `*.log`，146 个 0 字节；只有 `20150504-20.42.41.log`（552,960 B）和 `20150608-08.57.19.log`（368,640 B）有内容。[V]
- 两个非空文件都正好是 4096 的整数倍（135×4096、90×4096），像是进程被 `kill -9` 前只刷了几个页；没有 “logger shutting down”。[I]
- 文件名格式 `YYYYMMDD-HH.MM.SS.log`，与 Qt5 的 `SkylineGUI-*` 不同；每天 08:xx/20:xx 成对出现，和 Qt5 启动时间几乎同一秒，说明有一套外部脚本/人工同时拉起两套 GUI；Qt4 那套大多立即退出或没初始化。[V/I]

### 6.4 Qt5 部署态：自带运行时，但 RPATH 过期

`3/GUI/SH` 的运行时：
- `libQt5Core/Gui/Widgets/Network/DBus.so.5`（2014-11-19）；`strings libQt5Core.so.5` → `Qt 5.3.1 (Jun 19 2014, GCC 4.6.1, 64 bit, release build)`。[V]
- `libicu*.so.52`、`platforms/libqxcb.so`、`libzmq.so.3.1.0`（导出 `zmq_ctx_new/zmq_msg_recv`，实际是 3.2.x ABI）。[V `strings`]
- 二进制的 RPATH 仍是 `/home/dalong/Qt5.3.1/5.3/gcc_64:/home/dalong/Qt5.3.1/5.3/gcc_64/lib`（`strings` 可见）。[V]
- 部署路径是 `/home/GUI/SH`；`runChinaGui.sh` 用 `LD_LIBRARY_PATH=/home/GUI/SH/` 覆盖。若直接 `./SkylineFL_GUI` 而不设 `LD_LIBRARY_PATH`，且 `/home/dalong/Qt5.3.1` 不存在，会找不到 Qt5 库。[V/I]
- `SkylineFL_GUI` 需要 `libzmq.so.3`；bundle 里有同名文件（真实文件，不是 symlink），可以解析。[V `ls -la`]

配置/运行数据：
- `GuiSettings.xml`：15213 + 34 策略槽位（15300–15333），策略名/合约留空，运行时由 `strategyName/contractName` 填。[V `3/GUI/SH/GuiSettings.xml:7`、`:18-291`]
- 50 个 CSV（2015-05-05 → 2015-07-24），多数 30–34 KB，正好 500 行；内容形如 `TRADE_CONFIRM,12005436,au1512,2,B,218.9,20150724-06:52:41.403921,57`。[V `20150724-20_35_50.724.csv:1-500`]
- 25 个 `SkylineGUI-*.log`（2015-07-13 → 07-24），单文件 86 KB – 606 MB，总计约 9 GB；最大 606,907,686 B。[V `ls -l`]
- 07-24 日志：17 个策略心跳（15300–15316），1,729,691 条 `impliedBidFairValue`，1,084,893 条 `bidPrice`，431,371 条 `FVMidAverage`，118,221 条心跳。[V `grep`]
- 关窗顺序：先 6 个 `ContractWidget` 析构，再 `logger shutting down`；没有 `GuiClose`，也没有 FATAL（抽查的两份日志）。[V `SkylineGUI-20150724-08.12.49.log` 尾部]

### 6.5 缺失/悬空依赖

| 缺失项 | 影响 | 证据 |
|---|---|---|
| `3/dalong/infrastructure/bin/debug` 为空 | `-llogger -lcommonutils` 链接失败；需先构建 infra 或改用 `2/bldBak/dev_multi_20141127_2011` | `ls bin/debug` 0 项；`.build_debug` 仅 372 KB、一个 `china_ors/Main.o`[V] |
| `2/usr/local/lib` 无 `libzmq.so` 符号链接（只有 `.a` 和 `.so.4.0.0`） | `-lzmq` 可能链接到静态 4.0.5，与部署的 3.2 ABI 不一致 | `ls`[V] |
| ZMQ 头文件 4.0.5 vs 部署库 3.2 ABI | 重建时 API/ABI 代差；本项目只用基础 API，风险中等 | `2/usr/local/include/zmq.h:32-34`；`strings libzmq.so.3.1.0`[V/I] |
| Qt4 `libQt*.so.4` 符号链接 | Qt4 GUI 不能按原样启动 | `3/infra/.../ls` vs `2/GUI/TradingSystemsGUI.tar.gz`[V] |
| `Position.csv` 不在 `3/GUI/SH` | 持仓表启动为空，Group/Mult/Fees 全空/1/0 | 文件列表；`PositionModel.cpp:237`[V] |
| `FrontEndConfig.xml` 的 `/home/punit/pnl/` 不存在 | 旧 GUI 17:00 自动保存静默失败 | `FrontEndConfig.xml:4`；`2/etc/passwd` 用户列表[V] |
| `GuiSettings.xml` 源码 15150/4 策略 vs 部署 15213/34 | 直接用源码配置启动会连错端口/只显示 4 行 | 两份配置[V] |
| `SkylineFL_GUI.pro` 用 `$$(HOME)/infrastructure` | 构建用户 HOME 必须是 `/home/dalong`（或手工改路径） | `.pro:18-31`；`Makefile:5`[V] |
| `Makefile` 的 rpath 指向 `/home/dalong/Qt5.3.1` | 部署机无此路径；必须 `LD_LIBRARY_PATH` | `Makefile:20`；`strings`[V] |
| `TableDataModel_.cpp`/`TableView_.cpp` 死副本 | 误改它们不会生效 | `.pro:33-58` 未列[V] |
| `NetPnlModel.h` 被 `PositionModel.cpp` include 但 `.cpp` 未编译 | 仅头文件依赖，不影响链接；但说明历史耦合 | `PositionModel.cpp:1`、`.pro`[V] |

### 6.6 该信哪一份

| 目的 | 用哪份 | 不要用 |
|---|---|---|
| 读/改 SkylineFL 源码 | `3/dalong/FromDaya/SkylineFL_GUI` | 目录里的 2015-03-19 二进制（只作对照） |
| 复现线上行为 | `3/GUI/SH` 的二进制 + `GuiSettings.xml` + 自带 Qt5/ZMQ 库 | 源码树的 `GuiSettings.xml`（15150/4 策略） |
| 读共享控件源码 | `3/dalong/infrastructure/TradingSystemsGUI`（git） | `2/dalong/infrastructure`（不完整） |
| 旧 GUI 行为 | `3/infra/TradingSystemsGUI` 二进制 + `2/GUI/TradingSystemsGUI.tar.gz` 的符号链接 | 空日志/`TradingSystemsGUI.Old` |
| 构建依赖 | `2/include` + `2/bld` + `3/dalong/Qt5.3.1` + `2/usr/local` | `2/opt/Qt5.3.2`（未使用） |

---

## 7. 构建与运行

### 7.1 `SkylineFL_GUI.pro` 解析

```qmake
QT       += core gui network
greaterThan(QT_MAJOR_VERSION, 4): QT += widgets
TARGET = SkylineFL_GUI
QMAKE_CXXFLAGS += -std=c++0x -D_GLIBCXX_USE_SCHED_YIELD -D_GLIBCXX_USE_NANOSLEEP -DSHOW_TRADES
INCLUDEPATH += /usr/local/include/ \
    $$(HOME)/infrastructure/DataService/include \
    ... $$(HOME)/infrastructure/TradingSystemsGUI/
LIBPATH += /usr/local/lib/ /usr/lib $$(HOME)/infrastructure/bin/debug
LIBS += -lzmq -llogger -lcommonutils
INFRA = $$(HOME)/infrastructure/TradingSystemsGUI
SOURCES += Main.cpp ... $$INFRA/MDCollector.cpp ... $$INFRA/SquareOffAllDialog.cpp
```

[V `SkylineFL_GUI.pro:7-58`]

要点：
- `-DSHOW_TRADES` 让 `OrdersCollector` 保留已结束订单（`ClosedOrderStatus`），否则成交表为空。[V `.pro:16`、`OrdersCollector.cpp:70-80`]
- 所有 infra 路径都基于 `$$(HOME)`；构建时 `HOME` 必须是包含 `infrastructure/` 的目录（原构建机是 `/home/dalong`）。[V]
- `-lzmq -llogger -lcommonutils` 需要 `libzmq.so`、`liblogger.a`、`libcommonutils.a`；`bin/debug` 为空，必须先构建 infra。[V]
- `HEADERS` 没有列 `GuiUtils.h`（纯头文件工具），不影响编译；`ScrollLabel.h`、`TableCheck.h` 等都在。[V `.pro:60-100`]

### 7.2 `Makefile` 解析

- 生成器：`# Generated by qmake (3.0) (Qt 5.3.1)`；命令：`/home/dalong/Qt5.3.1/5.3/gcc_64/bin/qmake -o Makefile SkylineFL_GUI.pro`。[V `Makefile:5`]
- `LFLAGS`：`-Wl,-rpath,/home/dalong/Qt5.3.1/5.3/gcc_64 -Wl,-rpath,/home/dalong/Qt5.3.1/5.3/gcc_64/lib`。[V `Makefile:20`]
- `LIBS`：`-L/usr/local/lib/ -L/usr/lib -L/home/dalong/infrastructure/bin/debug -lzmq -llogger -lcommonutils -lQt5Widgets -lQt5Network -lQt5Gui -lQt5Core -lGL -lpthread`。[V `Makefile:21`]
- `OBJECTS_DIR = ./`；`SOURCES` 里共享文件被解析成 `../../infrastructure/TradingSystemsGUI/*.cpp`。[V `Makefile:44-73`]
- 目录里**没有 `.o` 文件**；Makefile 存在但无法直接增量链接。[V `ls *.o` 0]

### 7.3 重建步骤（推测，未执行）

```bash
# 1) 构建 infra（生成 bin/debug/liblogger.a、libcommonutils.a）
export HOME=/home/dalong
cd /home/dalong/infrastructure
# 按 SConstruct/Makefile 构建；或改用 2/bldBak/dev_multi_20141127_2011 作为 LIBPATH
scons        # 或 make；具体 target 需按 SConstruct 确认

# 2) 构建 GUI
cd /home/dalong/FromDaya/SkylineFL_GUI
/home/dalong/Qt5.3.1/5.3/gcc_64/bin/qmake -o Makefile SkylineFL_GUI.pro
make -j4
```

注意：
- 若没有 `liblogger.a/libcommonutils.a`，可把 `LIBPATH` 指到 `2/bldBak/dev_multi_20141127_2011`（里面有 `liblogger.a`、`libcommonutils.a`、`libloggerso.so`、`libcommonutilsso.so`）。[V]
- 若 `-lzmq` 找不到 `libzmq.so`，可把 `LIBPATH` 指到 `3/GUI/SH`（有 `libzmq.so`），但要接受 3.2 vs 4.0.5 头文件的差异。[V/I]
- 链接顺序/ABI 可能因 GCC 版本不同而变化；原二进制用 GCC 4.4.7 编译（`strings` 可见）。[V]

### 7.4 运行步骤

```bash
cd /home/GUI/SH
export LD_LIBRARY_PATH=/home/GUI/SH/
./SkylineFL_GUI
```

必须满足：
1. 当前目录有 `GuiSettings.xml`（`Main.cpp:63` 用 `./GuiSettings.xml`）。[V]
2. `LD_LIBRARY_PATH` 指向 bundle（RPATH 指向不存在的 `/home/dalong/Qt5.3.1`）。[V/I]
3. `15213` 未被占用；`GuiMsgHub::recv` 里 `zmq_bind` 失败会 `exit(-1)`（在接收线程里）。[V `GuiMsgHub.cpp:69-72`]
4. DataService 在 `127.0.0.1:20000` 可达；否则启动时每个 collector 的 `waitForConnected()` 最长 30 s，GUI 会长时间无响应。[V `DataCollector.cpp:43-56`]
5. `Position.csv` 可选；没有就空表。[V]
6. 日志会写当前目录；确保磁盘空间（单日可达 600 MB）。[V]

`runChinaGui.sh`：

```bash
export LD_LIBRARY_PATH=/home/GUI/SH/
taskset -c -p 7 /home/GUI/SH/SkylineFL_GUI &
#gdb SkylineFL_GUI
```

[V `runChinaGui.sh:1-3`]

**`taskset` 语法可疑**：util-linux 的 `-c` 需要 CPU 列表参数，`-p` 是“对已有 PID 操作”。`taskset -c -p 7 <cmd>` 很可能把 `-p` 当作 `-c` 的参数而报 invalid CPU list；正确写法应是 `taskset -c 7 <cmd>`（启动新进程）或 `taskset -cp 7 <pid>`（改已有进程）。日志证明 GUI 确实运行过，所以实际启动可能没有走这个脚本，或用了别的包装。[I/P]

**cwd 陷阱**：`runChinaGui.sh` 没有 `cd`；如果从其他目录执行，`GuiSettings.xml` 读不到，`exit(-1)`；即使读到，日志/CSV 也会写到调用目录。[V `Main.cpp:63`；脚本]

### 7.5 Qt4 旧 GUI 的构建/运行

构建：
```bash
cd /home/infra/TradingSystemsGUI
qmake TradingSystemsGUI.pro    # Qt 4.8.6 或 Qt5 均可（VersionHeaders.h 兼容）
make
```
- `TradingSystemsGUI.pro:32-57` 编译旧主窗、`ExchangeWidget`、4 个 collector、`ConnectDialog`、4 个 model、`MarketData*`、`TableView`、`PlaceOrder*`、`CancelModifyOrderWidget`、`SquareOffAllDialog`。[V]
- `VersionHeaders.h:4-18` 兼容 Qt4.6+；`QT_VERSION >= 0x050000` 用新 API，否则用 `setResizeMode/setMovable/toAscii`。[V]

运行：
```bash
cd /home/infra/TradingSystemsGUI
export LD_LIBRARY_PATH=.
taskset -c 15 ./TradingSystemsGUI
```
[V `runGUI.sh:2-4`]

- 必须当前目录有 `FrontEndConfig.xml`（`main.cpp:12`）。[V]
- 目录缺少 `libQt*.so.4` 符号链接；直接运行会找不到 SONAME（除非系统 Qt 4.6.2 兜底）。[V/I]
- `FrontEndConfig.xml` 的 autosave 路径 `/home/punit/pnl/` 在本机不存在；17:00 保存会静默失败。[V]

### 7.6 配置替换清单（从源码配置到部署配置）

| 项 | 源码 | 部署 | 说明 |
|---|---|---|---|
| `ServerPort` | 15150 | 15213 | 必须与策略 `push_port` 一致 |
| 策略数 | 4 | 34 | GUI 行数 = 配置条数 |
| 策略端口 | 15111/15152/15153/15129 | 15300–15333 | 必须与 `.PortsFile`/实际 bind 一致 |
| 策略名 | A/B/C/D | 空 | 运行时由 `strategyName` 填 |
| Quoting/Driving | au1412/500209 | 空 | 运行时由 `contractName` 填 |
| 交易所 | CHINA(57)/CME(54) | 同 | `57=CHINA_SHFE`、`54=CME`、`50=CHINA`[V `marketupdateNew.h:73-83`] |
| 字体/行高 | 无 | Helvetica 9 / 24 | 不影响逻辑 |

---

## 8. 代码风险清单

> 排序按“对交易正确性/安全性/可运维性的影响”，不是按修复难度。

### 8.1 严重（Critical）

**R1. ZMQ 控制面完全无认证，且 bind 所有网卡**
- GUI `tcp://*:15213`、策略 `tcp://*:15300..15333`；消息里只带 `port`，没有签名/白名单/CURVE。[V `GuiMsgHub.cpp:8`、`StrategyMsgHub.cpp:12`]
- 任何能访问这些端口的主机都可以发 `15313|startOrStop#true` 启动策略、`15313|bidFairValue#...` 改报价、`15313|GuiClose` 停策略；GUI 会把它当成正常策略消息。[V `Container.cpp:222-260`、`sclock.cpp:251-269`]
- 缓解前提：如果 15213/15300–15333 只绑定在隔离的内网/本机并由防火墙限制，风险降低；但代码本身没有防护。[I]

**R2. `GuiMsgHub` 接收线程 detached，且对象从不销毁**
- `recv_thr = std::thread(&GuiMsgHub::recv, this); recv_thr.detach();`。[V `GuiMsgHub.cpp:37-38`]
- `GuiMsgHub` 在 `Container::setupMsgHub()` `new` 出来后没有 delete；`Container` 没有析构函数；`closeEvent` 不停止线程/不 `zmq_ctx_term`。[V `Container.cpp:207-220`、`:18-25`]
- 关窗后接收线程仍可能调用 `onMsgCallback`（绑定到 `Container`），而 `Container` 已析构 → use-after-free；只是进程通常紧接着退出，窗口很小。[V/I]
- 需要区分：`Container::onMsg` 里 `emit` 的是 Qt 信号（`fairValueOnMsg/strategyOnMsg/containerMsgSignal`），从接收线程 emit、`AutoConnection` 会排队到 GUI 线程执行，所以**正常路径下槽函数不在 ZMQ 线程里跑**；真正危险的是 `onMsgCallback` 这个直接 `std::function` 调用、以及对象生命周期。[V `GuiMsgHub.cpp:87`、`Container.cpp:254-256`；I Qt 连接语义]
- 建议：给 `GuiMsgHub` 加 `stop()`（设置 atomic flag + `zmq_ctx_term`/`zmq_close`），`join()` 线程；`Container` 析构时调用。

**R3. `DataCollector` 在 GUI 线程做阻塞 socket 操作**
- `InitializeCommand()`：`connectToHost` + `waitForConnected()`（默认 30 s）+ `waitForBytesWritten()` + `waitForReadyRead()`（默认 30 s）。[V `DataCollector.cpp:43-56`]
- `LogIn()`：`waitForBytesWritten()` + `waitForReadyRead()`。[V `:88-102`]
- `DoWork()` 在 `OpenOrderMsgHub` 构造、`Position` 构造、`ContractWidget` 构造、每次手工单/撤单/改单时被同步调用。[V `OpenOrderMsgHub.cpp:6-11`、`Position.cpp:31-32`、`ContractWidget.cpp:155-157`、`ManualOrderSender.cpp`]
- 结果：DataService 不在/慢时，GUI 启动或点击“下单/撤单”会冻结最长 30–60 s/连接；`OpenOrder::cancelAll` 对 N 张单做 N 次连接。[V/I]
- 建议：所有 collector 移到 `QThread`/线程池；手工单改异步 + 超时 + 明确的失败提示。

**R4. 手工新单的 `RequestMsg.OrdType` 未初始化**
- `Order()` 默认构造只初始化 `m_status/m_validity/m_isCompletelyFilled`，不初始化 `m_requestMsg`。[V `3/dalong/infrastructure/DataService/include/order.h:58-63`]
- `GuiUtils::getEmptyOrder()` 设置了 `ExpiryDate/StrikePrice/OptionType/Transaction_Type/Price/Quantity/DisclosedQnty/Request_Type/InstrumentName/AccountID/Symbol/OrderID`，**没有 `OrdType/Duration/PxType/Token/PosDirection/CALevel/TimeStamp/QuantityFilled`**。[V `GuiUtils.h:77-95`]
- `PlaceOrderWidget::OnSend()` 设置了 `AccountID/Symbol/ExpiryDate/StrikePrice/OptionType/InstrumentName/DisclosedQnty/Quantity/Price/Token/Transaction_Type`，**没有 `OrdType`**。[V `PlaceOrderWidget.cpp:177-207`]
- `ManualOrderSender::SendCommand()` 只补 `Duration=DAY`、`PxType=PERUNIT`，**没有 `OrdType`**。[V `ManualOrderSender.cpp:32-33`]
- 结果：新单的 `OrdType` 是栈上/未初始化值；ORS 可能按随机枚举解释（限价/市价/其他），造成拒绝或错误订单类型。[V/I]
- 建议：`getEmptyOrder()` 显式 `OrdType=LIMIT`（或由 UI 选择），并在发送前做字段校验。

**R4b. `ExchangeDetails.m_WindowNumber` 未初始化就用于订单订阅**
- `ExchangeDetails` 是普通 struct，没有构造函数：`char m_ExchangeType; QString m_ExchangeName; int m_WindowNumber;`。[V `ExchangeDetails.h:6-11`]
- `GuiSettings.xml` 的 `<Exchange>` 只解析 `Name/Type`，不设置 `m_WindowNumber`。[V `Main.cpp:48-55`]
- `OpenOrderMsgHub` 构造时 `ExchangeDetails exChangeDetails = AppConfig::getInstance().getExchange(i);`，直接传给 `OrdersCollector`；`OrdersCollector::SendCommand()` 用 `setWindowNumber(m_ExchangeDetails.m_WindowNumber)`。[V `OpenOrderMsgHub.cpp:6-10`、`OrdersCollector.cpp:24-38`]
- 旧 GUI 在 `ExchangeWidget::AddExchange()` 里显式 `m_WindowNumber = 5`（还带 `TODO: Need to remove this`）；SkylineFL 没有这一步。[V `ExchangeWidget.cpp:814-816`]
- 结果：订单订阅的 window number 是栈上垃圾值；DataService 可能返回错误窗口/空窗口，表现为挂单表时有时无。线上能看到成交 CSV，说明该字段可能被服务端忽略或恰好为 0，但这是未定义行为。[V/I]
- 建议：`ExchangeDetails` 加默认构造/`m_WindowNumber=0`，或在 SkylineFL 里显式设 5。

**R5. `strcpy` 写入固定长度协议字段，来源是 UI/策略消息**
- `PlaceOrderWidget::OnSend()`：`strcpy(AccountID, m_AccId->text()...)`（`AccountID[11]`）、`strcpy(Symbol, m_Symbol->text()...)`（`Symbol[50]`）、`strcpy(InstrumentName, m_Instr->text()...)`（`InstrumentName[32]`）。[V `PlaceOrderWidget.cpp:179-188`；字段长度 `orderresponse.h:101-102,142`]
- `ContractWidget::sendNewOrder()`：`strcpy(Symbol, m_name...)`，`m_name` 来自 `contractName` 消息/配置，可被策略控制。[V `ContractWidget.cpp:126`]
- `MDCollector::SendCommand()`：`strcpy(temp.m_symbol, theSymbol...)`，`theSymbol` 来自 UI ticker 输入或合约名。[V `MDCollector.cpp:38-40`]
- `ConnectDialog` 的 `LoginCommand` 用户名/口令是 `char[20]`，UI 输入无长度限制。[V `logincommand.h:31-33`、`ConnectDialog.cpp:80-83`]
- 结果：超长输入/恶意策略名可覆盖相邻字段/栈，造成崩溃或协议字段被篡改。[V/I]
- 建议：所有 `strcpy` 换成 `snprintf`/`strncpy` + 强制 NUL；UI 加 `setMaxLength`；协议层做长度校验。

**R6. 撤单没有确认对话框**
- `ContractWidget::sendCancelOrder()` 构造了 `PlaceOrderWidget`，但**没有 `exec()`**，直接 `ManualOrderSender.DoWork()`。[V `ContractWidget.cpp:289-295`]
- 对比 `sendModifyOrder()` 有 `exec()`；`OpenOrder::handleRight()` 也有 `exec()`。[V `ContractWidget.cpp:268-276`、`OpenOrder.cpp:79-92`]
- 结果：右键点击挂单价格格会立即撤单，没有二次确认；在合约窗里误右键就会撤。[V]
- 建议：补 `if (dlg.exec() != QDialog::Accepted) return;`，或至少加确认。

### 8.2 高（High）

**R7. `zmq_msg_recv` 失败时用 `status=-1` 构造 `std::string`**
- `if ((status = zmq_msg_recv(...)) == -1) { if (errno != EAGAIN) ILOG(FATAL); }` 然后 `std::string msg((const char*)zmq_msg_data(&zmsg), status);`。[V `GuiMsgHub.cpp:77-84`]
- `status` 为 -1 时，`std::string(const char*, size_t)` 的第二个参数被转成 `size_t(-1)`，会抛 `std::length_error`/`bad_alloc` 或读越界；没有 try/catch。[V/I]
- 触发条件：EINTR、context 终止、socket 错误；不是日常路径，但一旦发生就是崩溃。[I]
- 建议：`if (status <= 0) { zmq_msg_close(&zmsg); continue; }`，并在循环末尾 `zmq_msg_close`。

**R8. `zmq_msg_close` 缺失，消息内存泄漏**
- 循环里每轮 `zmq_msg_init(&zmsg)`，`zmq_msg_recv` 分配缓冲区，但从不 `zmq_msg_close(&zmsg)`。[V `GuiMsgHub.cpp:74-93`]
- 按 300 万条/日、每条几十字节计，日泄漏量在百 MB 级；进程每天重启两次，可能没到 OOM，但属确定性泄漏。[V/I]
- 建议：每轮处理完 `zmq_msg_close(&zmsg)`；或用 `zmq_recv` + 固定 buffer。

**R9. `ILOG(FATAL)` 不会终止进程**
- `FATAL` 只是日志级别；`InfraLogMessage::~InfraLogMessage()` 只把日志投递给后台 worker，不 abort/exit。[V `log.h:22`、`log.cpp:360-366`]
- 因此 `if ((zmq_ctx = zmq_ctx_new()) == NULL) ILOG(FATAL) ...;` 之后仍会继续用 NULL socket；`zmq_socket` 失败同理；`zmq_bind` 失败才显式 `exit(-1)`。[V `GuiMsgHub.cpp:10-16`、`:64-72`]
- 结果：资源耗尽/初始化失败时不是清晰退出，而是空指针崩溃。[V/I]
- 建议：初始化失败直接 `exit(1)` 或抛异常；不要依赖 FATAL。

**R10. 旧 GUI 的 `OrdersCollector` 线程生命周期不安全**
- `ExchangeWidget::AddExchange()`：`new OrdersCollector` → `moveToThread` → `started()` 连 `DoWork()`；`Finished()` 连 `quit()`/`deleteLater()`。[V `ExchangeWidget.cpp:824-833`]
- `~ExchangeWidget()`：`theInfo->m_OrdersThread->quit();` 然后立刻 `delete theInfo->m_OrdersCollector;`，**没有 `wait()`**。[V `ExchangeWidget.cpp:192-203`]
- 结果：线程可能仍在 `ReadSocket`/`DoWork` 中使用被删除的对象 → 崩溃/UB。[V/I]
- 建议：`quit()` + `wait()`，或让 `deleteLater` 走事件循环；析构时不要跨线程 delete。

**R11. 旧 GUI 明文保存连接口令**
- `ConnectDialog::DoAccept()`：把地址/端口/用户名/口令用逗号拼成字符串写入 `QSettings` 的 `Saved Sessions`。[V `ConnectDialog.cpp:85-99`]
- `MainWindow::SaveConnection()`：把 `m_Username/m_Password` 写进 `Saved Exchanges` 的 `QStringList`。[V `Mainwindow.cpp:396-404`]
- `ConnectionDetails.h:14-19` 还硬编码默认用户名/口令（源码注释 `TODO: Remove these details`）；本文不复述值。[V]
- 结果：任何能读用户 `QSettings` 文件的人都能拿到交易系统口令；且口令明文在源码里。[V]
- 建议：改用系统 keychain/受限权限文件；删除默认凭据；强制首次修改。

**R12. `PlaceOrderWidget::UpdateUI` 对空 `QString` 下标写入**
- `QString theOptionType; theOptionType[0] = ...; theOptionType[1] = ...;` —— `QString` 为空（size 0），对 `operator[]` 写入是未定义行为；Qt5 debug 可能 assert。[V `PlaceOrderWidget.cpp:142-146`]
- `OnSend()` 又对 `m_OptType->text()[0]/[1]` 取值，若用户输入不足 2 字符，越界读。[V `PlaceOrderWidget.cpp:185-186`]
- 结果：空/单字符期权类型可能崩溃或写入垃圾。[V/I]
- 建议：用 `QString::leftJustified(2, ' ')` 或显式补空字符；读取前检查 `size()`。

### 8.3 中（Medium）

**R13. 心跳/状态不同步**
- 重连只发 `connectRequest`，不回 `status`；GUI 可能把运行中的策略显示为“可 Start”。[V `sclock.cpp:251-262`、`Strategy.cpp:340-354`]
- 用户再点 Start 会重复 `startOrStop#true`；策略是否幂等取决于实现（`enableFlag=true`，可能触发 `bidGQOrder`）。[I]
- 建议：`connectRequest` 的响应里带 `status`/`running` 字段；GUI 以策略状态为准。

**R14. 端口动态分配 vs GUI 静态行号**
- 见 §3.7；策略崩溃后单独重启可能换端口，GUI 行号/策略名错位。[V `cfgField.cpp:687-735`]
- 建议：端口由启动脚本按策略名固定分配（命令行参数），不要“第一个空闲”。

**R15. GUI 关闭不发 `GuiClose`**
- `sclock` 支持 `GuiClose`，但 `Container::closeEvent` 不发送；日志中 `GuiClose` 计数为 0。[V `Container.cpp:18-25`、`sclock.cpp:263-269`、日志 grep]
- 结果：策略继续认为 GUI 在线，继续 push；HWM 满后 `zmq_send` EAGAIN，策略日志 FATAL（但不退出）。[V/I]
- 建议：关窗时对每个 PUSH socket 发 `GuiClose`，再关闭；或让策略用心跳超时判定 GUI 离线。

**R16. 日志量过大**
- 每条收/发都 INFO：`GuiMsgHub.cpp:53`、`:85`；一天 300 万+ 条、600 MB；25 个文件约 9 GB。[V]
- 结果：磁盘占用、I/O 抖动、排障困难；`grep` 9 GB 会超时。[V/I]
- 建议：行情/FV 消息降到 DEBUG 或采样；按天/大小滚动 + 压缩；保留最近 3–5 天。

**R17. 持仓组/乘数/手续费不持久化，且组汇总逻辑脆弱**
- `AddToCsv` 未调用；`Position.csv` 只读；部署目录没有该文件。[V `Position.cpp:60-70`、`PositionModel.cpp:302-315`]
- `FillData()` 的 `grp != 0`/`m_Group[grp].first` 没有命中校验；空组可能落到第 0 行。[V `PositionModel.cpp:194-200`]
- 结果：用户改的费用/乘数重启即丢；首行 PNL 可能被当成合计行。[V/I]
- 建议：明确的 `Save` 按钮 + 原子写 CSV；组汇总用显式 `contains()` 和有效行号校验。

**R18. 成交表不区分拒绝**
- `FillResponse` 只显示 `TRADE_CONFIRM`，不看 `Fill m_status`；旧日志里存在 `TRADE_CONFIRM` + `Fill m_status:0`（拒绝/失败）。[V `FillResponse.cpp:124-125`；旧日志]
- 结果：被拒绝的成交也显示成“成交”，用户可能误判仓位。[V/I]
- 建议：按 `getFillStatus()`/`OrderStatus` 显示不同颜色/文本（reject 红）。

**R19. `OrderResponse`/`Console` 的文本分割与 `#` 冲突**
- 策略 console 文本若包含 `#`，`Container::onMsg` 只取 `#` 后第一段；若包含 `;`，被拆成多条。[V `Container.cpp:225-247`]
- 结果：错误信息被截断/误分发；排障时看不到完整原因。[V/I]
- 建议：console 用单独的消息类型 + 长度前缀/JSON 转义。

**R19b. 定长结构体读取没有校验 `read()` 的字节数**
- `MDCollector::ReadSocket()`：`while (bytesAvailable >= sizeof(MarketUpdateWithOrderIndication))`，然后 `if (read((char*)&md, sizeof(md)) != -1)` —— 只判断“不是 -1”，没有判断“等于 sizeof”。TCP 可能短读，短读后循环继续，下一次从结构体中间开始解析。[V `MDCollector.cpp:79-94`]
- `PNLCollector::ReadSocket()` 同样只判断 `!= -1`。[V `PNLCollector.cpp:42-57`]
- `DataCollector::InitializeCommand()/LogIn()` 也不检查 `read()` 是否读满 `CommandReplyMessage`/`LoginReplyStructure`。[V `DataCollector.cpp:56-57`、`:99`]
- 结果：网络抖动/服务端半包时，行情/持仓字段错位，甚至把上一条的尾部当新结构体；没有 magic/version/length 校验。[V/I]
- 建议：`read` 返回值必须 `== sizeof(...)`；或改成“长度前缀 + 完整缓冲”的帧协议。

**R20. 旧 GUI 的 `NetPnlModel` 连接告警误报**
- `SetData()` 只在 `eCol_Qty` 变化时把 `is_changed=true`；PNL 变化但仓位不变时 `m_IsUpdated=false`。[V `NetPnlModel.cpp:215-247`]
- `CheckConnections()` 连续 6 次（约 60 s）`m_IsUpdated=false` 就显示告警图标/交易所名。[V `ExchangeWidget.cpp:766-806`]
- 结果：持仓不变但 PNL 正常更新时，会误报“连接断开”。[V/I]
- 建议：用“最后收到任意 PNL 消息的时间”做健康检查，不要用 qty 变化。

**R21. 旧 GUI 的 `SquareOffAll`/`CancelAll` 串行阻塞**
- `OnSquareOffAll()` 对每个仓位 `new ManualOrderSender(...).DoWork()`，每个都同步 TCP 连接/登录/等待。[V `ExchangeWidget.cpp:752-762`]
- `OpenOrder::cancelAll()` 对每张单同理。[V `OpenOrder.cpp:54-64`]
- 结果：仓位多时 UI 冻结数十秒，且部分成功/部分失败没有汇总。[V/I]
- 建议：批量命令（`CancelAll` 已支持）或异步队列 + 进度/结果表。

**R21b. 旧 GUI 的撤单/改单/SquareOff 对空 `OptionType` 下标越界**
- `OpenOrdersModel::CancelOrder()` / `ModifyOrder()` 直接 `m_Data[inRow][eCol_OptionType][0]/[1]`，不检查字符串长度。[V `OpenOrdersModel.cpp:84-85`、`:120-121`]
- `NetPnlModel::SquareOff()` / `GetSqrOffAllOrders()` 同样直接 `[0]/[1]`。[V `NetPnlModel.cpp:350-351`、`:402-403`]
- 若某个合约的 `OptionType` 为空（例如某些期货/自定义合约），这里会越界读；`QString::operator[]` 在越界时返回 `QChar()`（Qt5 release）或 assert（debug），随后写入协议字段 0，可能发错单。[V/I]
- 建议：先 `size() >= 2`，不足补空格。

**R22. 合约窗打开过早的永久空窗**
- `Strategy::createContractDialog()` 用当前 `StrategyInfo.quoting/driving` 构造；如果 `contractName` 还没到（或策略没连接），符号为空。[V `Strategy.cpp:310-320`]
- `ContractWidget::setupMDCollector()` 对空 `m_name` 直接返回 -1，之后即使 `contractName` 到了也不会重建/补订阅。[V `ContractWidget.cpp:147-148`]
- 结果：右键太早 → 空窗口，必须关掉重开。[V/I]
- 建议：在 `contractName` 到达时刷新已打开的 ContractWindow；或禁用未初始化行的右键。

**R23. `Strategy::onMsg` 的类型转换**
- `DisplayLabel* lb = (DisplayLabel*)tb->cellWidget(r, col);` 对 `bidFills/askStatus` 实际是 `FillsLabel`；因为 `onMsg` 是 `virtual`，能正确派发，但 C 风格 cast 掩盖了类型。[V `Strategy.cpp:403-405`、`FillsLabel.h:11`]
- 如果将来把某列换成非 `DisplayLabel` 控件，这里会静默写错内存。[I]
- 建议：`qobject_cast<DisplayLabel*>` + null 检查。

**R24. `ProxySortModel::lessThan` 只检查左值**
- 左值能转 double、右值不能时，右值 `toDouble()` 返回 0，排序结果不符合预期。[V `ProxySortModel.cpp:15-31`]
- 建议：两边都 `toDouble(&ok)`，都成功才按数值比较。

**R25. `GuiUtils::restoreTableWidth` 首次运行列宽 10 px**
- `settings.value(...).toInt()` 缺失时返回 0；`min(160,0)=0`、`max(10,0)=10`，所有列被设成 10 px。[V `GuiUtils.h:60-67`]
- 结果：全新用户第一次打开 Strategy/FairValue/OpenOrder/FillResponse 表，列窄到看不清，必须先手动拉宽再关窗保存。[V/I]
- 建议：缺失时用默认宽度（如 80）或 `resizeColumnsToContents()`。

### 8.4 低（Low）

- `OrderResponse` 的 `s` 已带 `\n`，`appendPlainText` 又加一个换行，行距翻倍。[V `OrderResponse.cpp:56-57`]
- `FillResponse::okBtn_clicked()` 的 `fn.trimmed();` 没有赋值，文件名首尾空格不会被去掉。[V `FillResponse.cpp:72`]
- `OpenOrder::handleRight()` 第 75 行用 `inOrder.m_Order` 的 `Exchange_Type` 构造 `m_Exchanges`，但此时 `inOrder.m_Order` 还没赋值（第 76 行才赋值）；第 85 行又用正确的 order 覆盖 `Exchange_Type`，所以只影响对话框显示。[V `OpenOrder.cpp:73-86`]
- `OpenOrder::updateTable()` 的 Exchange 列用 `QString("") + msg.Exchange_Type`（`unsigned char`），很可能显示成字符而不是数字 `57/54`；旧 GUI 用的是 `QString::number((int)...)`。[V `OpenOrder.cpp:142-143` vs `OrdersModel.cpp:142`]
- `OrdersCollector::PopDataBatch()` 用 `tryLock(200)`，失败时直接返回、不修改 `outBatch`；`OpenOrderMsgHub` 每轮把 `tmpOrders` 清空后调用，锁竞争时会把该交易所的挂单表暂时清空（600 ms 后下一轮再填）。[V `OrdersCollector.cpp:88-100`、`OpenOrderMsgHub.cpp:21-25`]
- `ContractWindow::closeEvent` 调 `QDialog::closeEvent`，但类继承 `QDialog`；没问题。[V]
- `ScrollLabel` 的 `lowerBound` 默认 `-INT_MAX`，`edge/slope` 可滚到很大负数；策略端没有范围校验。[V]
- `ClickLabel`/`ContractScrollLabel` 有未使用成员 `step/val/valStr/lowerBound/order/blockUpdateFlag`（`ClickLabel.h:39-46`），复制粘贴残留。[V]
- `DTemplate` 是 Qt 示例，未使用但编译。[V]
- `Main.cpp` 末尾 `return app.exec();;` 双分号。[V `Main.cpp:74`]

---

## 9. 证据索引（可复现）

| # | 命令/文件 | 证明 |
|---|---|---|
| E1 | `ls -la 3/dalong/FromDaya/SkylineFL_GUI` | 源码/二进制/`.pro`/`Makefile` 的日期与大小 |
| E2 | `SkylineFL_GUI.pro:7-58` | Qt 模块、`SHOW_TRADES`、`$$(HOME)` 路径、共享 `.cpp` |
| E3 | `Main.cpp:8-74` | 配置读取、`./GuiSettings.xml`、logger、Container |
| E4 | `Container.cpp:33-55`、`:207-260`、`:262-335` | 启动顺序、7 个 Dialog、`onMsg` 解析、ZMQ 初始化 |
| E5 | `GuiMsgHub.cpp:6-96` | `tcp://*:port`、`tcp://localhost:port`、detach、send/recv、无 close |
| E6 | `Strategy.cpp:109-302`、`:340-410` | 19 列表、控件、心跳/自动连接/锁、参数发送 |
| E7 | `ContractWidget.cpp:117-337` | 手工单/改单/撤单、MD 订阅、20 档、ticker |
| E8 | `FairValue.cpp:40-224` | FV 表、Match、FVAuto、组 |
| E9 | `PositionModel.cpp:142-419` | 持仓/组/乘数/费用/CSV |
| E10 | `OpenOrderMsgHub.cpp:4-97` | 600 ms 轮询、TRADE_CONFIRM 分类 |
| E11 | `DataCollector.cpp:35-141` | 阻塞连接/登录/DoWork |
| E12 | `PlaceOrderWidget.cpp:123-207` | 手工单 UI 与 `strcpy` |
| E13 | `3/GUI/SH/GuiSettings.xml:7,18-291` | 15213 + 34 策略槽位 |
| E14 | `3/GUI/SH/runChinaGui.sh:1-3` | `LD_LIBRARY_PATH`、`taskset` 写法 |
| E15 | `grep -o 'recv \[[0-9]*\|[a-zA-Z]*' 3/GUI/SH/SkylineGUI-20150724-08.12.49.log \| sort \| uniq -c` | 消息类型统计 |
| E16 | `head -40 3/GUI/SH/SkylineGUI-20150724-08.12.49.log` | 启动顺序、15213、34 个 heartbeat 初始化 |
| E17 | `tail -10 3/GUI/SH/SkylineGUI-20150724-08.12.49.log` | 关窗析构、`logger shutting down`、无 `GuiClose` |
| E18 | `head -5 3/GUI/SH/20150724-20_35_50.724.csv` + `wc -l` | 500 行成交 CSV 格式 |
| E19 | `3/infra/TradingSystemsGUI/runGUI.sh:2-4` + `ls -la` | Qt4 `taskset -c 15`、缺 `libQt*.so.4` |
| E20 | `tar -tzvf 2/GUI/TradingSystemsGUI.tar.gz \| grep libQt` | tarball 里有 SONAME 符号链接 |
| E21 | `git -C 3/dalong/infrastructure log -- TradingSystemsGUI` | 共享源码最后提交 2014-10-07 |
| E22 | `3/leon/CL/StrategyLeon/cfgField.cpp:687-735` | 端口扫描/第一个空闲端口 |
| E23 | `3/leon/.PortsFile`（34 行） | 15300–15333 |
| E24 | `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/sclock.cpp:251-290` | `connectRequest`/`GuiClose`/`status` 回应 |
| E25 | `3/leon/CL/StrategyLeon/sendMsg2GUI.cpp:50-155` | `contractName/group/strategyName/init*` 批量格式 |
| E26 | `3/leon/CL/config/.strategy_new.cfg:1-2` | `Z\|PUSHPort=15213` |
| E27 | `file`/`strings` on `3/GUI/SH/SkylineFL_GUI`、`libQt5Core.so.5`、`libzmq.so.3.1.0` | Qt 5.3.1、BuildID、RPATH、ZMQ ABI |
| E28 | `stat -f "%Sm %N"` on binaries | 2014-12-21 / 2015-03-19 / 2014-09-26 |
| E29 | `find 3/dalong/FromDaya/SkylineFL_GUI -maxdepth 1 -name '*.cpp' -newermt 2014-11-21`（无输出） | 源码最后修改 2014-11-20 |
| E30 | `git log -1` / `git ls-files TradingSystemsGUI \| wc -l` | infra HEAD `6efe348f`、58 个 GUI 文件 |

---

## 10. 如果要复刻/重写，最小验收清单

1. **控制面**：用带认证的 `ROUTER/DEALER` 或 HTTP/JSON，消息带 `version/request_id/strategy_id/ts`；禁止 `tcp://*` 裸奔。[建议]
2. **数据面**：把 MD/PNL/Orders 采集器放到独立线程/进程，GUI 只消费队列；所有 `waitFor*` 设短超时 + 重试 + 错误事件。[建议]
3. **交易安全**：手工单必须显式 `OrdType/Duration/PxType`，价格/数量/账户校验；撤单/改单/撤所有都要确认 + 结果回执；`SquareOffAll` 用真实二次确认（不是同屏随机码）。[建议]
4. **模型/视图**：策略表、合约表也改成 `QAbstractTableModel` + delegate，避免每格 widget 和 C 风格 cast；持仓表持久化 Group/Mult/Fees。[建议]
5. **可观测性**：行情日志采样/降级；保留策略状态、心跳、订单/成交审计日志；GUI 关闭发 `GuiClose`，策略侧用心跳判活。[建议]

---

## 11. 未决问题（5 个）

1. **线上 2014-12-21 二进制与 2015-03-19 本机构建，代码是否完全同一份？**
   现有证据：源码 `.cpp/.h` 全部 2014-11-20；四个文件的日志行号与源码一致；2015-03-19 构建未部署。但没有 2014-12-21 的 build log/tarball 校验和，无法证明“全树完全一致”。需要找到当时的 qmake/make 日志或二进制 diff（`objdump`/DWARF 路径）来确认。

2. **Qt5 GUI 到底是怎么启动的？`runChinaGui.sh` 的 `taskset -c -p 7` 看起来不是合法语法。**
   没有 crontab 条目、没有 systemd unit、没有 `startAll` 脚本调用 GUI；日志却每天 08:xx/20:xx 启动。是人工在 VNC 里启动、还是另一个未归档的包装脚本？如果是后者，它可能还设置了 `cd /home/GUI/SH` 或其他环境变量。

3. **Qt4 旧 GUI 在 2015 年还有没有实际使用？**
   148 个日志里 146 个 0 字节，只有 2015-05-04 和 2015-06-08 有内容；目录缺少 `libQt*.so.4` 符号链接。它是“每天被脚本拉起但立即失败”，还是“偶尔人工用它做对照”？需要当时的 shell history / VNC 录屏 / 启动脚本。

4. **策略端口是“按启动顺序抢”的，运维是否依赖端口=策略槽位？**
   `.PortsFile` 是 15300–15333，`getSocketPort()` 取第一个空闲；GUI 用端口映射行号。若某个策略崩溃后单独重启，它可能换端口，GUI 行号/策略名错位。有没有发生过这种事故？启动脚本是否按固定顺序串行启动以保证端口稳定？

5. **手工单的 `OrdType` 未初始化，ORS 实际怎么处理？**
   代码路径确定没有设置 `OrdType`；但线上手工单显然用过（CSV 里有 `TRADE_CONFIRM`，AccountID=OWN）。是 ORS 对 0/垃圾值做了默认限价，还是手工单大多走“改单/撤单”（复制已有订单，字段完整）？需要 ORS 的 `ManualOrderCommand` 处理代码或一次抓包来确认。如果 ORS 默认限价，这个 bug 被“意外掩盖”了；如果默认市价，则风险极高。

---

## 12. 结论

- **SkylineFL_GUI 是 2014-2015 年这套 TradeBot 的实际人机界面**：单主窗 + 7 个浮动窗，策略表是 19 列 widget 表，持仓表是标准 model/view；它复用共享采集器/手工单对话框，但不复用旧主窗。
- **它的“控制面”是 ZMQ，数据面是 DataService TCP**；ZMQ 只负责策略连接/启停/参数/遥测，行情/持仓/挂单/成交/手工单全部走 DataService。把这两条链路混在一起看，是理解这套 GUI 的关键。
- **线上二进制与归档源码基本同源**，`00-inventory.md` 的“旧 3 个月”是拿两个二进制比，容易误导；真正的问题是 2015-03-19 的重建没有上线。
- **Qt4 旧 GUI 是上一代“按交易所分 tab”的实现**，源码比二进制新 11 天，运行目录缺 SONAME 符号链接；它更适合作为对照，而不是可运行备份。
- **最该先修的不是界面，而是**：ZMQ 无认证、detached 接收线程/UAF、GUI 线程阻塞 socket、`strcpy` 越界、手工单 `OrdType` 未初始化、撤单无确认、日志 9 GB。这些直接关系到“能不能安全地下单/撤单”和“出事能不能查”。

---

*本文只读分析，未运行任何二进制，未修改 `/Volumes/DevDisk/146` 或 `/Users/wangjun/PG/quantlink-new/146` 中的源码/配置。*

# tbadmin UI 字段盘点与 146 差异

> 盘点对象：`quantlink-trading` 的 tbadmin 后端 + `tbadmin-front/my-admin` 前端  
> 对比对象：146 Qt4/Qt5 GUI（重点 Qt4 `TradingSystemsGUI`，并参考 Qt5 `SkylineFL_GUI`）  
> 盘点日期：2026-11-23  
> 证据：源码只读。`V` = 直接读源码确认；`D` = 由源码逻辑派生或推断。

---

## 0. 一页结论

tbadmin 不是 146 GUI 的超集，而是另一套“多机运维 + 监控”前端：

- 新增的主要是 **身份/部署字段**：`StrategyID`、`Product`、`Server`、`StrategyType`、`ModelFile`。
- 新增的主要是 **运维状态字段**：`alert`、`alert_time`、`m_active`、`m_running`、`m_onExit`、`m_onCancel`、`m_onFlat`、`update_time`。
- 新增 **通用遥测字段**：`key`、`value`、`info`、`pnl`。
- 新增 **派生字段**：`fir`、`sec`、`count`、`CXLRio`、`SymbolDelta`、`GroupDelta`。
- 新增 **数据面板**：`Spread`、`Option Delta`、`PyBot`。
- 但 tbadmin **没有** 146 的：
  - 策略级 bid/ask 报价参数
  - `Connect` / `Lock`
  - 146 的 30 列 NetPnl
  - PnL 汇总网格
  - FairValue 表
  - 146 订单/成交表中的部分字段

另一个关键点：

```text
tbadmin 的“UI 展示字段” != “后端 payload 字段”
```

有些字段后端有、UI 没显示；有些字段 UI 有、后端没数据（例如 Account 的 `Margin` / `Risk`）。

---

## 1. 代码位置

### 后端

```text
tbadmin/proto/admingpb.proto
tbadmin/inc/admin.h
tbadmin/admin.cpp
```

### 前端

```text
tbadmin-front/my-admin/src/views/tbcheck/index.vue
tbadmin-front/my-admin/src/views/tbcheck/indexTable/product.vue
tbadmin-front/my-admin/src/views/tbcheck/indexTable/orders.vue
tbadmin-front/my-admin/src/views/tbcheck/indexTable/fills.vue
tbadmin-front/my-admin/src/views/tbcheck/indexTable/position.vue
tbadmin-front/my-admin/src/views/tbcheck/indexTable/account.vue
tbadmin-front/my-admin/src/views/tbcheck/indexTable/spreadTrades.vue
tbadmin-front/my-admin/src/views/tbcheck/indexTable/option.vue
tbadmin-front/my-admin/src/views/tbcheck/indexTable/pyBotTables.vue
```

### 146 对比

```text
146/03-qt-gui.md
146 Qt4: Mainwindow / ExchangeWidget / OrdersModel / NetPnlModel / FillResponse
146 Qt5: Strategy / Position / OpenOrder / FillResponse
```

---

## 2. tbadmin UI 结构

```text
实时监测
  顶部：平铺 Strategy 表
  底部 tabs：
    挂单
    成交
    持仓
    Spread
    账户
    PyBot
    期权
```

注意：

- 这是“数据类型”分区，不是 `pair / cso / hedge` 分区。
- 顶部策略表是唯一包含所有策略的平铺表。

---

## 3. Strategy 表

### 3.1 UI 展示字段

前端 `product.vue` 的列：

| UI 字段 | tbadmin 来源 | 146 对应 | 差异 |
|---|---|---|---|
| Status | `m_running` + `m_active`，来自 `StrategyStatusMsg` | 146 只有 Start/Stop 按钮 | tbadmin 新增进程/active 状态 |
| Alert | `m_alert` | 无 | 新增告警文本 |
| AT | `m_alert_time` | 无 | 新增告警时间 |
| Pro | DB `product` | 146 策略名，无 product 列 | 新增多产品维度 |
| ID | DB `sid` → `StrategyID` | 146 用行号/端口标识 | 新增策略 ID |
| IP | DB `server` | 146 本机，无 server | 新增多机维度 |
| ModelFile | DB `modelfile`，去掉路径/前缀 | 146 配置文件有，但策略表不显示 | 新显示字段 |
| StrategyType | DB `type` | 146 配置有，但策略表不显示 | 新显示字段 |
| Key | `StrategyDetail.key` | 146 无通用 key | 新增遥测 |
| val | `StrategyDetail.value` | 146 无通用 value | 新增遥测 |
| 1 | `m_position[sid]` 第一腿净仓 | 146 策略表无两腿净仓 | 新增 pair 腿视图 |
| 2 | `m_position[sid]` 第二腿净仓 | 同上 | 新增 pair 腿视图 |
| PNL | `StrategyPNL.netPNL` | 146 策略表无策略级 PnL | 新增策略级 PnL |
| Time | `m_update_time` | 无 | 新增更新时间 |
| 信息 | `StrategyDetail.info` | 146 控制台文本，不在策略行 | 新显示字段 |

`操作` 列是动作，不是数据：

```text
拉起 / 启动 / 停止 / 杀死
```

对应 146 的：

```text
Connect / Start / Stop / Lock
```

但语义不同：tbadmin 是进程级操作，146 还包含 ZMQ 连接和本地锁。

### 3.2 Payload 里有、UI 没显示的字段

`ControlAux::toString()` 还包含：

```text
m_onExit
m_onCancel
m_onFlat
m_active
m_running
alert_time
update_time
count
id
userref
ControlFile
```

其中：

- `m_onExit` / `m_onCancel` / `m_onFlat`：策略状态标志，UI 不直接显示。
- `m_active` / `m_running`：组合成 UI 的 `Status`。
- `count`：同一 `StrategyID` 的行数，用于合并；当前表格没有绑定 `span-method`，所以实际还是平铺。
- `id` / `userref`：内部 DB 行号和 hft id，不作为业务列显示。
- `ControlFile`：payload 有，UI 不显示。

### 3.3 新字段来源

| 新字段 | 来源 | 说明 |
|---|---|---|
| StrategyID | `tbhft_strategy.sid` | 策略 ID，不是 DB 主键 `id` |
| Product | `tbhft_strategy.product` | 产品/组合 |
| Server | `tbhft_strategy.server` | 策略所在机器 |
| StrategyType | `tbhft_strategy.type` | `TB_PAIR_STRAT` 等 |
| ModelFile | `tbhft_strategy.modelfile` | 去掉 `./models/model.` 和 `.txt` |
| ControlFile | 由 ModelFile 派生 | 控制文件名 |
| Alert / AT | `StrategyDetail.isAlert` / `info` | 告警文本与本地接收时间 |
| m_active / m_running / m_onExit / m_onCancel / m_onFlat | `StrategyStatus` memlog → `StrategyStatusMsg` | 策略进程与状态标志 |
| key / value / info | `StrategyDetail` memlog | 通用策略遥测 |
| PNL | `PNL` memlog → `StrategyPNL.netPNL` | 策略级净 PnL |
| 1 / 2 | `Position` memlog → `m_position[sid]` | 第一腿/第二腿净仓 |
| Time | 本地 `util::getNanoTime()` | 最后一次更新接收时间 |
| count | `dumpStrategyInfo()` 计算 | 同 StrategyID 行数 |

关键源码：

```text
tbadmin/admin.cpp:298-420       memlog -> protobuf
tbadmin/admin.cpp:597-705       tbhft_strategy -> OneControl
tbadmin/admin.cpp:4051-4165     dumpStrategyInfo()
```

### 3.4 146 有、tbadmin 没有

146 Strategy 表 19 列：

```text
Connect / Name
bidExlim / bidSize / bidEdge / bidSlope / bidLean / bidPrice / bidFill
askFill / askPrice / askLean / askSlope / askEdge / askSize / askExlim
Start / Stop / Lock
```

tbadmin 缺：

```text
bidExlim / bidSize / bidEdge / bidSlope / bidLean / bidPrice / bidFill
askFill / askPrice / askLean / askSlope / askEdge / askSize / askExlim
Connect / Lock
```

所以 tbadmin 是“策略运维表”，不是 146 的“策略报价控制表”。

---

## 4. Orders

### 4.1 UI 展示字段

`orders.vue` 实际只显示：

```text
Symbol / S / Qty / Price / ModelFile / ID / pro
```

| UI 字段 | 来源 | 146 对应 | 差异 |
|---|---|---|---|
| Symbol | `OpenOrder.InstrumentName` | Symbol | 一致 |
| S | `OpenOrder.Side` | Side | 一致 |
| Qty | `OpenOrder.Qty` | Quantity | 一致 |
| Price | `OpenOrder.Price` | Price | 一致 |
| ModelFile | `dumpStrategyOpenOrders()` 派生 | 146 无 | 新增 |
| ID | `StrategyID` | 146 的 ID 是 OrderID | **同名不同义** |
| pro | `OpenOrder.Product` | 146 无 product | 新增 |

`ID` 这里是 **StrategyID**，不是订单 ID。订单真实 `OrderID` 在 payload 里，但 UI 不显示。

### 4.2 Payload 字段

`OpenOrder::toString()`：

```text
Response_Type
OrderID
ErrorCode
Quantity
Price
TimeStamp
Side
Symbol
AccountID
SysID
ExchangeTradeId
PosDirection
Server
Exchange
product
StrategyID
```

其中 UI 没显示的：

```text
OrderID
ErrorCode
TimeStamp
AccountID
SysID
ExchangeTradeId
PosDirection
Server
Exchange
Response_Type
```

### 4.3 146 有、tbadmin 没有

146 OrdersModel 16 列：

```text
Account / Symbol / Instr / Status / ID / Trans / OpType / SPrice
Expiry / Price / Qty / LTT / QtyFill / Type / DQty / Source
```

tbadmin Orders UI 只有 7 列，缺：

```text
Account / Instr / Status / OrderID / Trans / OpType / SPrice
Expiry / LTT / QtyFill / Type / DQty / Source
```

注意：其中一部分在 payload 里有（AccountID、OrderID、TimeStamp、Exchange），只是 UI 没显示；`Instr`、`Status`、`OpType`、`SPrice`、`Expiry`、`QtyFill`、`Type`、`DQty` 在 tbadmin 订单 payload 里也没有。

### 4.4 新字段来源

| 新字段 | 来源 | 说明 |
|---|---|---|
| StrategyID | ORS order response / `m_rsp.strategyid()` | 订单归属策略 |
| product | order response | 产品 |
| ModelFile | `dumpStrategyOpenOrders()` 匹配 `StrategyID` + Instrument 到 `m_ctls` | 派生，可能为空 |
| Server | order response | 订单所在机器 |
| AccountID | order response | 账户 |
| PosDirection | order response | 持仓方向 |
| SysID | order response | 系统 ID |
| ExchangeTradeId | order response（当前格式中可能为空字符串） | 成交号 |
| ErrorCode | order response（当前固定 0） | 错误码 |

`ModelFile` 的派生逻辑：

```text
遍历 m_ctls
  找 StrategyID 相同
  且 InstrumentName 等于该 control 的 Instrument 或 InstrumentSecond
  取该 control 的 ModelFile
```

找不到就是空字符串；同一策略多腿时也可能匹配到第一腿/第二腿的 model。

---

## 5. Fills

### 5.1 UI 展示字段

`fills.vue`：

```text
Time / Symbol / S / Price / Qty / ID / Pro
```

| UI 字段 | 来源 | 146 对应 | 差异 |
|---|---|---|---|
| Time | `Fill.TimeStamp` | Time Stamp | 一致 |
| Symbol | `Fill.Symbol` | Symbol | 一致 |
| S | `Fill.Side` | Side | 一致 |
| Price | `Fill.Price` | Price | 一致 |
| Qty | `Fill.Quantity` | Quantity | 一致 |
| ID | `StrategyID` | 146 的 Order ID | **同名不同义** |
| Pro | `product` | 146 无 | 新增 |

注意：tbadmin 成交表没有 `ModelFile` 列；成交 payload 也没有 `ModelFile` 字段。

### 5.2 Payload

`Fill` 继承 `OpenOrder`，所以 payload 与订单相同：

```text
Response_Type / OrderID / ErrorCode / Quantity / Price / TimeStamp
Side / Symbol / AccountID / SysID / ExchangeTradeId
PosDirection / Server / Exchange / product / StrategyID
```

### 5.3 146 有、tbadmin 没有

146 FillResponse 8 列：

```text
Status / Order ID / Symbol / Quantity / Side / Price / Time Stamp / Exchange ID
```

tbadmin 显示缺：

```text
Status / Order ID / Exchange ID
```

payload 里有 `OrderID`、`Exchange`，但 UI 不显示；`Status` 和 `Exchange ID` 在该 payload 里也没有。

### 5.4 新字段

```text
StrategyID
product
Server
AccountID
PosDirection
SysID
ExchangeTradeId
```

其中 UI 只显示 `StrategyID` / `product`；其余是 payload 级新增。

---

## 6. Position

### 6.1 UI 展示字段

`position.vue` 只显示 4 列：

```text
Symbol (Instrument) / Pos (netpos) / CXLRio / Pro
```

| UI 字段 | 来源 | 146 对应 | 差异 |
|---|---|---|---|
| Symbol | `Position.Instrument` | Symbol | 一致 |
| Pos | `Position.netpos` | NetPosition | 一致 |
| CXLRio | `cancelCnt/orderCnt` | 146 无 | 新增撤单/报单比 |
| Pro | `Position.product` | 146 无 | 新增产品维度 |

### 6.2 Payload 字段

`PositionAux::toString()`：

```text
StrategyID
product
buyPx
sellPx
buyTotalQty
sellTotalQty
buyTotalPx
sellTotalPx
netpos
Instrument
buyQty
sellQty
cancelCnt
orderCnt
```

UI 只显示 `Instrument` / `netpos` / `cancelCnt+orderCnt` / `product`，其余不显示。

### 6.3 来源

- `Position` 来自 `MemLogType::POSITION`（type 6）。
- `OrderCancel` 来自 `MemLogType::CANCEL_STS`（type 11），提供 `newOrdCnt` / `canelOrdCnt`。
- `dumpPosition()` 遍历的是 `ors_position`（按 product + instrument 的 ORS 汇总），不是 `m_position[sid]` 的策略仓位。
- 因此 Position tab 是 **ORS/product 聚合视图**，不是 146 的按策略/合约 PnL 表。
- `StrategyID` 在聚合仓位里可能只是最后一次写入的值，不能当可靠归属。

### 6.4 146 有、tbadmin 没有

146 有两套：

```text
PositionModel 11 列：
  Account / AvgBuy / NetBuyQty / Symbol / NetSellQty / AvgSell
  NetPosition / Group / Mult / Fees / PNL

NetPnlModel 30 列：
  Account / Symbol / Instr / Qty / PnL / Yield / Expiry / SPrice
  OpType / LTP / LTT / Trade% / Source / RPnL / URPnl
  NetBuyQty / NetSellQty / NetBuy(L) / NetSell(L) / NetVal(L) / NetExp(L)
  1MinPnL / 5MinPnL / 10MinPnL
  1MinDiff / 5MinDiff / 10MinDiff
  OVNNetExp(L) / OVNPnL / IDPnL
```

tbadmin Position 没有这些 PnL、Yield、LTP、LTT、Trade%、1/5/10Min、Ovn、IDay 字段，也没有 Options/Futures/Equities/Total 汇总网格。

结论：

```text
tbadmin 持仓表比 146 窄得多，不是 146 NetPnl 的替代。
```

---

## 7. Account

### 7.1 UI 展示字段

```text
Pro / Ex / TotalAsset / AvailCash / Margin / Risk
```

| UI 字段 | 来源 | 146 对应 | 差异 |
|---|---|---|---|
| Pro | `Account.product` | 146 账户/产品概念 | 命名不同 |
| Ex | `Account.exchange` | exchange | 一致概念 |
| TotalAsset | `Account.TotalAsset` | 总资产/权益 | 新显示名 |
| AvailCash | `Account.availableCash` | 可用资金 | 新显示名 |
| Margin | 无后端字段 | 146 有保证金概念 | **UI 预留，当前无数据** |
| Risk | 无后端字段 | 146 风控概念 | **UI 预留，当前无数据** |

### 7.2 来源

`Account` protobuf（type 14）来自 agent/ORS：

```text
product
exchange
TotalAsset
availableCash
```

`AccountAux::toString()` 也只输出这四个字段。

`Margin` / `Risk` 在 `account.vue` 有列，但对应的 `MarginStr` / `RiskStr` 是注释状态，payload 也没有字段。

### 7.3 与 146 的关系

146 Qt4 GUI 没有独立的 Account tab；它的主界面是 Orders / Net Positions / Market Data。

146 数据侧有账户、保证金、可用资金的概念，但不在这个表格里。tbadmin 只是把 `TotalAsset` / `availableCash` 单独列出来；`Margin` / `Risk` 目前只是 UI 占位，不是真正新增数据。

---

## 8. Spread

### 8.1 UI 展示字段

```text
ModelFile / S / Qty / Spread / Time / Pro
```

### 8.2 来源

不是结构化订单/成交事实，而是从策略 memlog 的 `info` 文本里解析：

```text
info.find("Trade2")
  vec[3] -> Side
  vec[4] -> Qty
  vec[5] -> Spread
  timestamp = 本地接收时间
  Product = StrategyDetail.product
  ModelFile = m_ctls[sid].ModelFile
```

对应源码：

```text
tbadmin/admin.cpp:2435-2460
```

`SpreadTrade` 字段：

```text
StrategyID
Side
qty
Spread
timestamp
Product
ModelFile（dump 时补充）
```

### 8.3 146 对比

146 没有 Spread 表；这是 tbadmin 新增的数据面板。

但它是 **日志文本派生字段**：

```text
依赖策略打印 "Trade2 ..." 的格式
不是订单/成交事实
不是 pair/cso/hedge 分类
```

---

## 9. Option Delta

### 9.1 UI 展示字段

```text
Key / Contract / Underlying / UnderlyingPrice
Strike / Vol / Delta / Pos / SymbolDelta / GroupDelta
```

### 9.2 来源

不是策略直接上报的完整 Delta 表，而是 tbadmin 自己拼出来的：

1. 从 `Position` memlog 拿到 option/future 的 `Instrument` 和 `Pos`。
2. 查 DB `GetInstrumentFromDb()` 获取 expiry、strike、underlying。
3. 虚拟期权从 `control.ModelDetail` 的 `VirtualOption` 行解析：

```text
au2410C542 20250725 0.01 0.14 542 C -29
```

4. `Volatility`：
   - 普通期权：`IMPLIED_VOLATILITY` 常量
   - 虚拟期权：model 行里的 volatility
5. `UnderlyingPrice`：从 `m_market_datas[underlying].LastTradedPrice` 取。
6. `Delta`：用 Black-Scholes 公式在 tbadmin 本地计算：

```text
CalculateCallDelta(...)
CalculatePutDelta(...)
```

7. `SymbolDelta = Delta * Pos`
8. `GroupDelta = 同一 DeltaKey（product/variety）下所有 SymbolDelta 之和`
9. `Key = product + " / " + variety`

对应源码：

```text
tbadmin/admin.cpp:31-42      Delta 公式
tbadmin/admin.cpp:917-1115   OptionDelta / dumpDeltaTable
tbadmin/admin.cpp:1004-1115  VirtualOption
tbadmin/inc/admin.h:204-243  OptionDelta::toString()
```

### 9.3 146 对比

146 GUI 没有这张 Option Delta 表。

这是 tbadmin 新增的 **本地派生分析视图**，不是原始交易事实：

- `Vol` 可能来自常量或 model 文件
- `UnderlyingPrice` 是最新成交价，不是 mark/mid
- `Delta` 是 tbadmin 计算的，不是 ORS/策略上报的
- `GroupDelta` 是 tbadmin 聚合的

---

## 10. PyBot 带来的字段（单独归类）

> 这一节只记录 tbadmin 的 PyBot 专属字段。它们不是 146 字段，也不混入 §11 的普通新字段总表。

### 10.1 UI 展示字段

```text
State / StrategyID / Model / Value / Log
```

### 10.2 来源

1. `InitPyBot()` 扫描 `PYBOT_PATH` 下的 `<strategyID>.json` 文件，初始化 `m_pymonitor`。
2. `CheckPyBot()` 每 5 秒执行：

```text
ps -ef | grep PythonBot | grep -v grep | grep -v nohup
```

从命令行里提取 `--strategyID`，设置：

```text
PYBOT_RUNNING / PYBOT_NO_PROCESS
```

3. `Value`：来自 `StrategyDetail` 的 `key == "TValue"`，调用 `ProcessPyBotValue()`，转成 double。实际链路是 PythonBot 写 `tVar`，C++ 策略读 `tVar` 后再发 `TValue`；不是 PythonBot 直接上报。
4. `Log`：tbadmin 读 `PYBOT_KEY` ShmLog 的 `strategyID|<log>`；但当前 PythonBot 仓库只写文件日志（`logs/python_signal_<sid>_<date>.log`），没有写 `PYBOT_KEY` ShmLog，且默认 `PYBOT_KEY=0`。
5. `Model`：从 `m_ctls[strategyID].ModelFile` 取；这不是 PythonBot 的 `settings/<sid>.json` 或 `models/*.csv`。
6. `PYBOT_PATH`：tbadmin 只扫描该目录下的 `<id>.json`；PythonBot 配置实际在 `settings/` 子目录，当前布局可能对不上。

PythonBot 的完整运行架构、tVar/tCache 闭环和风险见：

```text
208-pythonbot-analysis.md
```

对应源码：

```text
tbadmin/admin.cpp:525-580    InitPyBot
tbadmin/admin.cpp:1337-1460  CheckPyBot / ProcessPyBot*
tbadmin/admin.cpp:1486-1514  DumpPyBotTable / DumpPyMonitor
```

### 10.3 146 对比

146 没有 PyBot 表。

这是 tbadmin 新增的 Python 策略进程/日志监控：

- `State` 来自 `ps`，不是策略心跳
- `Value` 是 PythonBot `tVar` 经 C++ 策略回传的 `TValue`
- `Log` 的 ShmLog 通道当前没有 PythonBot 生产者
- `Model` 来自 tbadmin DB，不是 PythonBot 实际模型
- 不是交易事实

### 10.4 PyBot 字段归类

| PyBot 字段 | tbadmin 来源 | 146 能否推导 | 结论 |
|---|---|---|---|
| `State` | `ps -ef \| grep PythonBot` | 146 没有 PythonBot | 新外部进程状态，只能进程探测 |
| `StrategyID` | `settings/<sid>.json` 文件名 / 命令行 | 146 可用端口/配置路径合成，但不是同一 ID | 部分可推导，语义不同 |
| `Model` | `m_ctls[strategyID].ModelFile` | 146 有 C++ model，但没有 PythonBot model | 不可直接推导，且当前列不是 PythonBot 实际模型 |
| `Value` | PythonBot `tVar` → C++ TB `TValue` → memlog | 146 没有 PythonBot/tVar | 不可从 146 推导，属于 PythonBot 外部数据源 |
| `Log` | `PYBOT_KEY` ShmLog | 146 没有该通道 | 不可推导；当前 PythonBot 只写文件日志，ShmLog 无生产者 |

支撑 `Value` 的非 UI 数据：

```text
PythonBot tVar
C++ TB m_tvar->load()
SendMonitorStratDetail(key=TValue)
tbadmin ProcessPyBotValue()
```

支撑 `Log` 的非 UI 数据：

```text
PythonBot logs/python_signal_<sid>_<date>.log
tbadmin PYBOT_KEY ShmLog（默认 PYBOT_KEY=0）
```

结论：

```text
PyBot 字段不是 146 的字段
它们是 tbadmin/PythonBot 外部运行时专属
不能混入 146 核心字段表
```

---

## 11. 新增字段总表

### 11.1 真正新增的数据字段

| 字段 | 面板 | 来源 | 性质 |
|---|---|---|---|
| StrategyID | Strategy/Orders/Fills/Position/Spread | DB `sid` / response / memlog | 新身份字段 |
| Product | Strategy/Orders/Fills/Position/Account/Spread | DB / response / memlog | 新分组字段 |
| Server | Strategy/Orders | DB `server` / order response | 新多机字段 |
| StrategyType | Strategy | DB `type` | 新显示字段 |
| ModelFile | Strategy/Orders/Spread | DB / 派生 | 新显示字段 |
| ControlFile | Strategy | 派生自 ModelFile | payload 字段，UI 不显示 |
| alert / alert_time | Strategy | StrategyDetail | 新运维字段 |
| m_active / m_running | Strategy | StrategyStatusMsg | 新运维字段 |
| m_onExit / m_onCancel / m_onFlat | Strategy payload | StrategyStatusMsg | 新状态字段，UI 未显示 |
| key / value / info | Strategy | StrategyDetail | 新遥测字段 |
| pnl | Strategy | StrategyPNL.netPNL | 新策略级 PnL |
| fir / sec | Strategy | m_position 派生 | 新 pair 腿视图 |
| count | Strategy | dumpStrategyInfo 计算 | 新 UI 分组辅助 |
| update_time | Strategy | 本地接收时间 | 新时间字段 |
| CXLRio | Position | cancelCnt/orderCnt | 新派生理 |
| Spread / Side / qty | Spread | StrategyDetail.info 文本 | 新日志派生面板 |
| Underlying / UnderlyingPrice / Strike / Vol / Delta / SymbolDelta / GroupDelta | Option Delta | DB + model + MD + 本地计算 | 新派生分析 |

PyBot 的 `State / StrategyID / Model / Value / Log` 不混入本表，单独见 §10。

### 11.2 同名但语义不同

| 字段 | 146 语义 | tbadmin 语义 | 风险 |
|---|---|---|---|
| ID | OrderID | StrategyID（Orders/Fills） | 不能把 tbadmin 的 ID 当订单号 |
| Status | 订单状态 | 策略进程/active 状态 | 不能和订单状态混用 |
| PnL | 按 account+contract 的净 PnL | 策略级 netPNL | 粒度不同 |
| Position | 按策略/合约的净仓与 PnL | ORS/product 聚合仓位 | 不能直接对齐 |
| Source | 订单来源/交易所 | tbadmin Orders 不显示 Source | 字段丢失 |
| ModelFile | 146 配置文件，不在表里 | tbadmin 策略/订单派生列 | 订单上的 ModelFile 可能为空 |

### 11.3 146 有、tbadmin 没有

```text
策略：
  bidExlim / bidSize / bidEdge / bidSlope / bidLean / bidPrice / bidFill
  askFill / askPrice / askLean / askSlope / askEdge / askSize / askExlim
  Connect / Lock

持仓/PnL：
  Account / Yield / Expiry / SPrice / OpType / LTP / LTT / Trade%
  RPnL / URPnl / NetBuy(L) / NetSell(L) / NetVal(L) / NetExp(L)
  1MinPnL / 5MinPnL / 10MinPnL / 1MinDiff / 5MinDiff / 10MinDiff
  OVNNetExp(L) / OVNPnL / IDPnL
  Options/Futures/Equities/Total 汇总网格

挂单/成交：
  Account / Status / OrderID / Instr / OpType / SPrice / Expiry
  LTT / QtyFill / Type / DQty / Source / Exchange ID

其他：
  FairValue 表
```

### 11.4 tbadmin 有、但只是 UI 占位

```text
Account.Margin
Account.Risk
```

前端有列，后端 `Account` payload 没有对应字段；`MarginStr` / `RiskStr` 仍是注释状态。

---

## 12. 重要陷阱

### 12.1 UI 列不等于 payload

例如 Orders 后端有 `AccountID`、`OrderID`、`TimeStamp`、`Exchange`，UI 只显示 7 列，这些字段看不到。

### 12.2 `ModelFile` 是派生字段

Orders 的 `ModelFile` 不是订单本身带的，而是：

```text
StrategyID + InstrumentName -> 在 m_ctls 里找 ModelFile
```

匹配不到就是空；同一策略多腿时可能混淆。

### 12.3 `Position` 是 ORS 聚合，不是策略明细

`dumpPosition()` 遍历 `ors_position`，按 product + instrument 聚合；不是 146 的按策略/合约 PnL 表。

### 12.4 `Spread` 是文本解析

依赖策略 info 里的 `Trade2` 格式：

```text
Side / Qty / Spread 都从字符串切出来
```

策略日志格式一变，Spread 表就失效。

### 12.5 `Option Delta` 是 tbadmin 计算值

不是 ORS/策略上报的事实：

```text
Delta = Black-Scholes(local)
Vol = 常量或 model 文件
UnderlyingPrice = 最新成交价
GroupDelta = 本地聚合
```

### 12.6 `PyBot` 是进程/日志监控

`State` 来自 `ps`，`Value`/`Log` 来自日志文本；不是策略心跳或交易事实。

---

## 13. 对 205 / 新 GUI 的启示

tbadmin 可以借鉴，但不能直接当 146 的替代数据模型。

建议并集：

```text
146 的交易能力：
  bid/ask 报价参数
  NetPnl 30 列
  PnL 汇总
  FairValue

tbadmin 的运维能力：
  StrategyID / Product / Server / StrategyType
  alert / active / running / exit / cancel / flat
  key / value / info
  strategy PnL
  pair 两腿净仓

新增数据面板：
  Spread
  Option Delta
  PyBot
```

如果新系统要表达 pair/cso/hedge，不要依赖 tbadmin 的文本字段：

```text
strategyType
strategyFamily
parentStrategyId
legIndex
legRole
```

应该成为显式字段，而不是从 `ModelFile`、`Trade2` 文本或 `Loading` 猜。

---

## 14. 如何补齐差异并对齐 205

### 14.1 先分清：不是所有缺口都来自 C++ 差异

146 的 C++ 内部本来就有不少数据，缺的是“输出契约”和“读模型契约”：

```text
146 C++ 内部有：
  m_strategyID
  m_account
  m_buyPrice / m_sellPrice / m_buyQty / m_sellQty
  m_buyTotalQty / m_sellTotalQty
  currSpreadRatio / LongSpreadRatio
  OptionManager 的 Greeks

146 输出层只暴露了其中一部分：
  NetPnlInfo 的 net / avg
  DataService 的账户/合约 PnL

quantlink-trading 又延伸出另一套：
  SendMonitorStrat*
  tVar / tCache
  Trade2 文本日志
  tbadmin 本地 Delta
```

所以应分成三层判断：

```text
A. C++ / runtime 真差异
B. 205 数据契约差异
C. UI 展示差异
```

| 缺口 | 146 C++ 有数据吗 | 根因 | 补齐方向 |
|---|---|---|---|
| Account / Subunit | 有 `m_account`，按策略配置 | tbadmin 手工单固定 `OWN`；205 也把 `OWN` 当固定常量，没有读取 146 `ACCOUNT` | 账户维度直接使用 146 配置的 `accountId`，进命令、订单/成交读模型、持仓、资金读模型 |
| 多 TB 的 `tbId/server` | 146 单机，没有 | quantlink 有 agent/server，205 只在 FactEnvelope 有 `tbId` | 读模型 key 也加 `tbId/server` |
| Spread | 有 `currSpreadRatio` / `LongSpreadRatio` | 146 没发 `Trade2`；tbadmin 解析文本 | 策略成交时发 `SpreadTradeFact`，不再解析日志 |
| Option Delta | 有 OptionManager Greeks | tbadmin 用 DB/model/常量另算一套 | 统一到 `OptionGreeksService` / `OptionDeltaReadModel` |
| Position 原始买卖字段 | 有 `m_buyPrice`、`m_buyQty` 等 | 146 DataService / 205 选择了 avg/net | 读模型增加原始字段，avg/net 作为派生 |
| `StrategyID` 数字 ID | 有 `m_strategyID`（`--strategyID` 运行号） | 146 GUI 用端口/行号；205 用启动配置的 `strategyId` | 只保留 `strategyId`；146 `m_strategyID` 仅做 adapter 映射 |
| Account `Product` | 配置里有 product | 146 NetPnlInfo 没有 product；205 AccountSnapshot 没有 | AccountSnapshot 加 product，或 join 策略配置 |
| `Risk` | tbadmin 也没有后端字段 | 只是 UI 占位 | 不补；如需要，单独 RiskSnapshot |

### 14.2 真正由 C++ / runtime 差异引起的

#### Account / Subunit

146：

```text
ExecutionStrategy:
  m_account
  m_reqMsg.AccountID = m_account
```

quantlink-trading：

```text
策略 C++ 也有 m_account
但 tbadmin 手工单：
  add.setAccountId("OWN")
  cxl.setAccountId("OWN")
```

所以多账户不是 146 C++ 做不到，而是：

```text
tbadmin 手工单把账户固定了
205 也没有使用 146 的 accountId，而是写成了 OWN
```

补齐逻辑：

```text
accountId = trim(146 ACCOUNT / m_account / m_reqMsg.AccountID / NetPnlInfo.m_accountId)

accountId 用于 ManualOrderCommand 和策略配置
RequestMsg.AccountID 由 gateway 从 accountId 注入
OrderReadModel / TradeReadModel 通过 strategyId 或 commandId join accountId
PositionReadModel / AccountSnapshot 按 accountId 聚合
```

如果 Plan A 只有单账户，也使用 146 策略配置里的 `ACCOUNT` 值（示例可能是 `OWN` 或 `PRP05`），不要写死；只有多账户路由才需要扩展命令/订单维度。

#### 多 TB

146 没有多 TB；quantlink 有 `server`/agent，但：

```text
Strategy 有 server
Order 有 server
Account 只有 product + exchange
ors_position 只有 product + instrument
```

所以多 TB 不是 UI 的事：

```text
Account / Position 的 key 必须加 tbId/server
```

补齐逻辑：

```text
(tbId, accountId, contractKey)
(tbId, strategyId, legIndex)
```

FactEnvelope 有 `tbId` 还不够，读模型的 key 也要有。

#### Spread

146 C++ 有：

```text
currSpreadRatio
LongSpreadRatio1 / ShortSpreadRatio1
avgSpreadRatio
```

但没有 tbadmin 那样的 `Trade2` 文本。

quantlink C++ 在成交处新增了：

```text
Trade2 B/S:... Qty:... spread:...
```

tbadmin 再解析这行文本。

这是文本协议代替结构化事实，不是 146 不会算 spread。

补齐逻辑：

```text
PairwiseArbStrategy 成交时发 SpreadTradeFact:
  strategyId
  legAContractKey
  legBContractKey
  side
  qty
  spread
  tradedAt
```

`Trade2` 日志继续保留，但只用于 debug。

#### Option Delta

146 `OptionManager` 已经有：

```text
m_portDelta
per-option delta
m_underlyingMap
```

quantlink tbadmin 又用：

```text
DB + model + 常量波动率 + 行情
```

独立算了一份 Delta。

这是两套计算，不是 C++ 缺数据。

补齐逻辑：

```text
OptionGreeksService
  OptionCatalog
  + PositionReadModel
  + MarketDataFact
    -> OptionDeltaReadModel
```

tbadmin 和 GUI 都不再自己算。

### 14.3 属于 205 数据契约差异的

#### Position 原始字段

146 策略内部有：

```text
m_buyPrice
m_sellPrice
m_buyQty
m_sellQty
m_buyTotalQty
m_sellTotalQty
m_buyTotalValue
m_sellTotalValue
```

quantlink `SendMonitorStratPos` 也把它们发出来了：

```text
bpx / spx / btpx / stpx
bqty / sqty / btqty / stqty
netpos
```

只是 205 的 `PositionReadModel` 现在选的是：

```text
avgBuy
netBuyQty
avgSell
netSellQty
netPosition
```

补齐逻辑二选一：

```text
A. PositionReadModel 增加原始字段
B. 明确 avg/net 是唯一视图，tbadmin 原始字段不保留
```

要和 tbadmin 字段一致，选 A：

```text
buyPx
sellPx
buyQty
sellQty
buyTotalQty
sellTotalQty
buyTotalValue
sellTotalValue
```

`avgBuy / avgSell / netPosition` 继续作为派生字段。

#### StrategyID

146 的：

```text
m_strategyID
```

来自启动参数 `--strategyID`，是运行实例号，用于 PID、数据文件、日志和 tbadmin memlog；不是策略配置 key，也不是路由 key。

新系统只保留一个策略身份：

```text
strategyId = 启动配置指定，TB 内唯一
strategyName = 显示名，可选
```

映射规则：

```text
146 单策略进程：m_strategyID <-> strategyId 1:1
146 多策略/新 TB：由新 TB 配置给每个 StrategyRuntime 分配 strategyId
ControlConfig.m_id / simConfig[i] 不作为注册 ID
```

`StrategyStatusReadModel` / `StrategyPnlReadModel` 只使用 `strategyId`；不再引入第二个策略身份字段。

#### Account Product / TotalAsset / AvailCash

146 `NetPnlInfo` 有 account、exchange、instrument，但没有 product。

quantlink tbadmin Account 有 product/exchange/TotalAsset/availableCash。

205 `AccountSnapshot` 有 balances/margin/available，但没有 product。

补齐逻辑：

```text
AccountSnapshot:
  + product
  + totalAsset
  + availableCash
```

或者：

```text
AccountSnapshot -> join strategy/product config
```

`TotalAsset` / `AvailCash` 可以映射 `balances / available`，但先定义口径：

```text
TotalAsset = 什么口径
AvailCash = available 还是 availableCash
```

#### Risk

tbadmin 的：

```text
Account.Margin
Account.Risk
```

`Margin` 205 有；`Risk` 后端没有。

这不是 C++ 缺，是 tbadmin UI 占位。要么不做，要么单独 RiskSnapshot。

### 14.4 统一逻辑：一个事实源

不要试图让 tbadmin、146、205 三套各自算。定一个来源：

```text
Account / 资金：
  ORS / AccountSnapshot

Strategy 仓位：
  StrategyRuntime / StrategyPositionReadModel

Account 仓位：
  PositionSnapshot / ORS

订单 / 成交：
  OrderRegistry / FillLedger

PnL：
  PnlService（account + contract）
  + StrategyPnlReadModel（strategy）

Spread：
  策略成交事件 -> SpreadTradeFact

Option Delta：
  OptionGreeksService -> OptionDeltaReadModel

StrategyID：
  strategyId 是唯一策略身份；146 m_strategyID 只做 adapter 映射

Product：
  策略 / 产品配置，不靠 PnL 消息
```

具体补齐顺序：

```text
1. Account
   - 单账户：使用策略配置里的实际 accountId（示例 OWN/PRP05），不写死
   - 多账户：accountId 进命令/订单/成交/仓位/账户读模型

2. 多 TB
   - read model key 加 tbId/server
   - LocalAgent 按 TB 采集，BotGateway 聚合

3. Spread
   - 在 PairwiseArbStrategy 成交处发结构化 SpreadTradeFact
   - 删除 tbadmin 的 Trade2 文本解析

4. Option Delta
   - 统一 OptionGreeksService
   - tbadmin / UI 只读 OptionDeltaReadModel

5. Position
   - 增加原始 buy/sell 字段
   - avg/net 作为派生

6. StrategyID
   - 统一为 strategyId；不增加第二个策略身份字段
   - 146 m_strategyID 只保留在 adapter 映射

7. Account Product
   - AccountSnapshot 加 product 或 join 策略元数据

8. Risk
   - 不补；单独风控模型
```

### 14.5 对 Plan A 的判断

单 TB / 单账户 Plan A：

```text
不需要改 C++：
  Account/Subunit：不做
  多 TB：不做
  Spread / Option Delta：不做
```

需要补的只有：

```text
Position 原始字段
strategyId 启动配置字段
Account Product（如果界面要）
```

这些都可以在 205 / read model + UI 层解决。

完整 Plan A：

```text
必须改：
  Account/Subunit   -> C++/命令/读模型
  多 TB             -> Agent/read model key
  Spread            -> C++ 发结构化 Fact
  Option Delta      -> 统一 Greeks 服务
```

### 14.6 验收标准

```text
1. 同一个账户/持仓在 GUI、205、ORS 使用同一套 key
2. 多 TB 时 account/position 不会互相覆盖
3. Spread 不再依赖 Trade2 文本
4. Delta 只有一个计算来源
5. Position 原始字段和 avg/net 派生字段能同时解释
6. strategyId 是唯一策略身份；146 m_strategyID 只做 adapter 映射，不引入第二个 ID
7. Product 不靠 PnL 消息反推
8. Risk 不拿空白 UI 列冒充后端字段
```

---

## 15. 结论

tbadmin 相对 146 的新字段，主要分为五类：

```text
1. 身份/部署：StrategyID / Product / Server / StrategyType / ModelFile
2. 运维状态：alert / alert_time / m_active / m_running / m_onExit / m_onCancel / m_onFlat
3. 通用遥测：key / value / info / strategy PnL
4. 派生字段：fir / sec / count / CXLRio / Delta / GroupDelta
5. 新面板：Spread / Option Delta
```

PyBot 字段单独归类，见 §10，不计入普通新字段。

但 tbadmin 不是 146 的超集：

```text
它多了运维字段，
少了 146 的报价控制、30 列 PnL、FairValue 和部分订单/成交字段。
```

因此新 GUI 的数据模型应该是 **146 交易字段 + tbadmin 运维字段 + 显式策略族/腿角色** 的并集，而不是照搬 tbadmin 的表格列。

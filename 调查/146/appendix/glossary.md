# 附录 B — 术语表（2015 原始版）

> 只解释本档案/这套 2015 系统的含义，不是现代 `quantlink-trading` 的术语。

| 术语 | 含义 | 备注 |
|---|---|---|
| **TradeBot** | C++ 策略引擎，单进程单策略 | `3/TradeBot/TradeBot_China` |
| **ORS / china_ors_extreme_new** | 订单路由/柜台网关 | `3/infra/prod/bin/china_ors_extreme_new` |
| **mdreceiverX** | CME/Quincy 行情接收机 | `3/re`；`mdreceiverX_bothfeeds` 是双 feed 版 |
| **DataService** | GUI 的数据后端 | `dataservice` + `configService.xml`/`configStream_CTP.xml` |
| **TradingSystemsGUI** | Qt4 运行态 GUI | `3/infra/TradingSystemsGUI` |
| **SkylineFL_GUI** | Qt5 GUI 源码/另一套前端 | `3/dalong/FromDaya/SkylineFL_GUI` |
| **infrastructure** | 共享 C++ 库/控件 | `3/dalong/infrastructure` |
| **SHM** | System V 共享内存 | 实时行情/订单/回报/ClientStore |
| **ClientStore** | 客户端/订单上下文共享内存 | 策略构造时 attach；失败可能 terminate |
| **control 文件** | 策略控制文件 | `control.<BASE>.<session>[.<variant>].<YYYYMMDD>`；7 字段 |
| **model 文件** | 指标/阈值模型 | `Dependant` + 指标行 + `KEY VALUE` 阈值 |
| **session 标签** | control 文件名里的 day/eve/noon 等 | 只是标签；真实时段在 control 字段/GMT |
| **strategyID** | 策略 ID | 归档 `RunStrategies.sh` 用 `420`；control 第 4 字段恒 `16` |
| **m_Active** | 策略是否可发单 | Live 启动默认 false；需 SIGUSR1 激活 |
| **SIGUSR1 / SIGUSR2 / SIGTSTP / SIGRTMIN** | 激活/重载参数/平仓/恢复等信号 | 具体见 `02`/`06`；`36/37` 是选择性/全量激进平仓 |
| **adjustLTP** | 用 LTP±tick 合成 book | China 版实盘参数 `--adjustLTP 1` |
| **Dependant** | model 首行，指定价格/指标依赖 | 目标价模型 |
| **UPNL_LOSS / STOP_LOSS / MAX_LOSS** | 未实现/净/最大亏损阈值 | 策略内风控 |
| **MAX_ORDERS** | 订单数硬闸门 | 归档 `StrategyConfig.cfg` 为 450 |
| **MAX_POS_SIZE** | 名义“最大仓”配置 | 归档 1,000,000；在 SFE 下事实失效 |
| **REJECT_LIMIT** | 拒绝计数阈值 | 100 平仓 / 200 exit |
| **squareoff** | 平仓/收尾 | 信号/收盘；不保证一定平光 |
| **position.csv** | ORS 时点持仓快照 | 不是实时流；TradeBot 不读 |
| **daily_init** | 现代系统的日初文件 | **2015 原始版不存在**；别把现代概念套进来 |
| **ZMQ** | GUI↔策略控制面 | 15213/15300+；无认证/ACK |
| **DataService TCP** | GUI 数据面 | 默认 20000；行情/持仓/订单/PNL/手工单 |
| **CTP** | 上期技术柜台 API | 2015 归档主线是 CME/SGIT/China 网关，不是 CTP |
| **SGIT** | 上海柜台/网关（历史） | ORS 配置/脚本里出现；不是现代 CTP |
| **CME Quincy** | 历史行情源 | `cme.recv.quincy.data.cfg` |
| **VNC** | 远程 X 桌面 | root `:1`，800×600 |
| **`/bld`、`/include`** | 老构建依赖 | `2/` 根盘；TradeBot Makefile 绝对路径 |
| **V / I / P** | 本档案证据标记 | V=代码/脚本确认；I=推断；P=计划/未验证 |

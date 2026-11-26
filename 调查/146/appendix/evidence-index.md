# 附录 C — 关键文件/证据索引

> 用于快速定位原始证据。所有路径相对 `/Volumes/DevDisk/146`；文档内另有 file:line。
> V = 已读源码/配置/脚本；I = 结构/时间戳推断；P = 未验证。

## C.1 版本/布局

| 证据 | 路径 | 用途 |
|---|---|---|
| SVN 工作副本 | `3/TradeBot/TradeBot_China/.svn/entries` | repo URL / revision r2375 / author / date |
| SVN 基准 | `3/TradeBot/TradeBot_China/.svn/text-base/*` | 与工作副本比对 |
| Windows 工程 | `3/TradeBot/TradeBot_China/Tradebot.sln`、`Tradebot.vcxproj` | VS2010/Win32 legacy |
| Linux Makefile | `3/TradeBot/TradeBot_China/Makefile`、`main/Makefile` | g++/infra 依赖 |
| Qt5 GUI 工程 | `3/dalong/FromDaya/SkylineFL_GUI/SkylineFL_GUI.pro` | 源码/依赖/端口 |
| Qt5 部署 | `3/GUI/SH/`、`runChinaGui.sh`、`GuiSettings.xml` | 线上 Qt5 运行态 |
| Qt4 运行态 | `3/infra/TradingSystemsGUI/`、`runGUI.sh`、`FrontEndConfig.xml` | 线上实际 GUI |
| 共享 infra | `3/dalong/infrastructure/`（git） | DataService/Connector/Ipc/Logger/GUI 控件 |
| 根盘 | `2/etc/`、`2/opt/Qt5.3.2/`、`2/bld/` | OS/依赖/构建产物 |

## C.2 TradeBot 核心

| 证据 | 路径 | 用途 |
|---|---|---|
| 入口 | `3/TradeBot/TradeBot_China/main/main.cpp` | 参数/模式/信号/策略工厂 |
| 核心运行时 | `main/CommonClient.cpp`、`main/include/CommonClient.h` | 行情/回报/连接器 |
| 工具/配置 | `main/TradeBotUtils.cpp`、`main/include/TradeBotUtils.h` | 配置/模型/指标/PNL |
| 策略基类 | `Strategies/ExecutionStrategy.cpp`、`include/ExecutionStrategy.h` | 订单/成交/仓位/风控 |
| 具体策略 | `Strategies/*.cpp`、`Strategies/include/*.h` | 策略实现/工厂分支 |
| 指标 | `Indicators/` | 指标实现/模型行 |
| 连接器 | `Connector/` | SHM/网关协议 |
| 控制/模型 | `controls/`、`models/` | 策略输入 |
| 数据 | `data/` | contract/fee/日历/费率 |
| 运行脚本 | `livescripts/RunStrategies.sh`、`RunStrategies_noon.sh` | 策略启动 |

## C.3 Qt GUI

| 证据 | 路径 | 用途 |
|---|---|---|
| Qt5 入口 | `3/dalong/FromDaya/SkylineFL_GUI/Main.cpp` | 配置/启动 |
| 主容器 | `Container.cpp/.h` | 主窗/tab/策略 |
| 策略表 | `Strategy.cpp/.h` | 19 列/参数/启停/lock |
| 消息 | `GuiMsgHub.cpp/.h` | ZMQ PUSH/PULL |
| 持仓/订单 | `PositionModel.cpp`、`OrderResponse.cpp`、`OpenOrder.cpp`、`FillResponse.cpp` | model/view |
| 公允价值 | `FairValue.cpp` | 期权/价差展示 |
| 共享控件 | `3/dalong/infrastructure/TradingSystemsGUI/*.cpp` | DataService/手工单/PNL/Orders |
| Qt4 GUI | `3/infra/TradingSystemsGUI/` | 运行态二进制/日志 |
| 部署配置 | `3/GUI/SH/GuiSettings.xml`、`runChinaGui.sh` | 端口/策略/启动 |
| CSV/日志 | `3/GUI/SH/*.log`、`*.csv` | 运行取证 |

## C.4 启动/运维

| 证据 | 路径 | 用途 |
|---|---|---|
| ORS | `3/infra/prod/scripts/runORS_extreme_new.sh`、`config/prod.china.ors_new.cfg` | 订单路由/柜台 |
| ORS 源码 | `2/bld/build_dev_multi.20150330_1447/China/` | 构建树 |
| MD | `3/re/receive_new.sh`、`3/re/receive.shBak`、`cme.recv.quincy.data.cfg` | 行情接收/回滚脚本 |
| MD 源码 | `2/bld/build_dev_multi.20150330_1447/MDReceiverX/` | 构建树 |
| 策略 | `3/TradeBot/livescripts/RunStrategies.sh` | 单策略启动 |
| DataService | `3/infra/dataservice_deploy/runDataService.sh`、`runDataStream_CTP.sh`、`configService.xml`、`configStream_CTP.xml` | GUI 数据后端 |
| GUI 启动 | `3/infra/TradingSystemsGUI/runGUI.sh` | Qt4 |
| 历史命令 | `2/root/.bash_history`、`3/TradeBot/.bash_history` | 启动/信号/运维 |
| 日志 | `3/TradeBot/log`、`3/GUI/SH/*.log`、`3/infra/.../log`、`2/var/log` | 时间线/故障 |
| cron/服务 | `2/etc`、`2/var/spool/cron`、`3/TradeBot/...` | 启停/调度 |

## C.5 安全/谱系

| 证据 | 路径 | 用途 |
|---|---|---|
| 凭据位置 | `3/TradeBot/TradeBot_China/Connector/*.cfg`、`3/infra/prod/config/*.cfg`、`3/GUI/SH/*.xml` | 只记位置/类型，不复制值 |
| ZMQ | `GuiMsgHub.cpp`、`Container.cpp`、`Strategy.cpp` | 无认证/端口即身份 |
| DataService | `infrastructure/TradingSystemsGUI/DataCollector.cpp` | TCP/阻塞 |
| 安全日志 | `2/var/log/secure`、`2/var/log/messages`、VNC 配置 | 现场暴露面 |
| 版本差异 | `2/` vs `3/`、`TradeBot` vs `.bak` vs `tempTradeBot` | 漂移/备份 |
| 现代对照 | `/Users/wangjun/PG/quantlink-new/quantlink-trading-architecture/` | 旧→新演进 |

## C.6 未决问题（汇总）

1. `receive_new.sh` 的 `taskset -c -p 8` 为何不能启动；历史实际用 `receive.shBak`/`bothfeeds`？
2. 线上 6/17 TradeBot 二进制相对 r2375 的未提交改动。
3. `3/GUI/SH` 2014-12-21 二进制 vs 2015-03-19 源码构建；SkylineFL 是否部署。
4. 2015 主机是否公网 + root VNC + ZMQ 全网卡。
5. `symbolID` 是否始终 <100（`m_simConfigList[100]`）。
6. `position.csv`/TradeBot 账本的重启人工流程。
7. 手工单未初始化 `OrdType` 的实际效果。
8. `3/leon/log` 39GB 是否含唯一证据/是否保留。
9. `2/` 与 `3/` 的复制关系/谁在 7/25 深夜搬了 11GB。
10. `92221` 现代系统的双 control 问题不属于本档案，但可对照现代文档。

# 附录 A — 历史启动/端口/SHM 矩阵

> 这是 2015 年归档态的历史启动矩阵，不是现代生产 runbook。证据见 `05-build-deploy-ops.md`、`03-qt-gui.md`、`02-tradebot-core.md`。
> V = 脚本/配置/源码确认；I = 推断；P = 未验证。

## A.1 主机

| 项 | 归档值 | 备注 |
|---|---|---|
| OS | CentOS 6.6 / kernel 2.6.32 | `2/` 根盘 |
| CPU | 48 逻辑 CPU | `taskset` 使用 0/1/5/6/7/8/21 等 |
| 内存 | 32GB | `05` |
| 根盘/家目录 | `2/` = `/`；`3/` = `/home` | `2/home` 空 |
| 图形 | root VNC `:1` 800×600 | `05`、`06` |
| 关键路径 | `/home/{GUI,infra,leon,re,TradeBot}`、`/usr/share/API`、`/bld`、`/include` | 脚本硬编码 |

## A.2 进程/启动顺序

| 顺序 | 组件 | 历史命令/脚本 | 源码/二进制 | 依赖 | 证据 |
|---:|---|---|---|---|---|
| 0 | 铺目录 | 将 `/146/3/*` 放到 `/home` | — | `/usr/share/API`、`/bld`、`/include` | 用户提供；`05` |
| 1 | ORS/网关 | `/home/infra/prod/scripts/runORS_extreme_new.sh` | 源码 `2/bld/build_dev_multi.20150330_1447/China`；二进制 `/home/infra/prod/bin/china_ors_extreme_new` | 网关/柜台配置 `prod.china.ors_new.cfg`；SHM keys | `05` |
| 2 | 行情接收 | `/home/re/receive.sh` | 源码 `2/bld/.../MDReceiverX`；`mdreceiverX` 或 `mdreceiverX_bothfeeds` | `cme.recv.quincy.data.cfg`；CPU 5,6 | 用户提供；`05` |
| 3 | 策略 | `/home/TradeBot/livescripts/RunStrategies.sh` | 源码 `3/TradeBot/TradeBot_China`；`main/TradeBot` | ORS + MD 必须先起；control/model；`--strategyID 420` | `02`、`04`、`05` |
| 4 | DataService | `runDataService.sh` 或 `runDataStream_CTP.sh` | `3/infra/dataservice_deploy/dataservice` | `configService.xml` 或 `configStream_CTP.xml`；GUI 之前 | `03`、`05` |
| 5 | GUI | `/home/infra/TradingSystemsGUI/TradingSystemsGUI` | Qt4 运行态（`3/infra/TradingSystemsGUI`） | DataService；X/VNC；Qt4 libs | `03`、`05` |

## A.3 行情/策略/GUI 协议

| 通道 | 端点 | 用途 | 备注 |
|---|---|---|---|
| ZMQ GUI PULL | `tcp://*:15213` | GUI 接收策略/数据消息 | 绑定所有网卡（V） |
| ZMQ 策略 PULL | `tcp://*:15300..15333` | 策略接收 GUI 命令 | 端口=策略槽位；无认证（V） |
| DataService TCP | `127.0.0.1:20000`（默认/历史） | 行情/持仓/挂单/成交/PNL/手工单 | 与 ZMQ 是两条链（V/I） |
| SHM | 3872/727272/4872/872 等 | ORS/策略/行情 | 启动脚本 `ipcrm`；结构/键见 `02`/`05` |
| 日志 | `/home/TradeBot/log`、`/home/GUI/SH`、`/home/infra/.../log` | 取证 | TradeBot GMT；DataService/GUI CST（V） |

## A.4 版本/资产

| 资产 | 路径 | 状态 |
|---|---|---|
| TradeBot 源码 | `3/TradeBot/TradeBot_China` | SVN r2375；权威 |
| TradeBot 旧版 | `3/TradeBot.bak`、`3/tempTradeBot` | r1936/r2023 备份 |
| ORS 源码 | `2/bld/build_dev_multi.20150330_1447/China` | 构建树 |
| MD 源码 | `2/bld/build_dev_multi.20150330_1447/MDReceiverX` | 构建树 |
| Qt5 GUI 源码 | `3/dalong/FromDaya/SkylineFL_GUI` | 无 VCS；未部署证据 |
| Qt4 GUI 运行态 | `3/infra/TradingSystemsGUI` | 线上实际 GUI |
| Qt5 部署态 | `3/GUI/SH` | 2014-12-21 构建 |
| 共享 infra | `3/dalong/infrastructure` | git + SCons |

## A.5 已知启动坑

1. `receive_new.sh` 使用 `taskset -c -p 8 nohup ...`，标准 util-linux 语法不成立；用户明确应使用 `receive.shBak` 改名后的 `receive.sh`（`05`）。
2. ORS/MD 必须先于 TradeBot；否则 SHM attach 失败，`IpcException` 可能直接 terminate。
3. `RunStrategies.sh` 当前归档只启动一条 `GOLD_F_0_SFE.eve.ltp.20150725`，`strategyID 420`；不能假设它启动全部策略。
4. Live 模式 `m_Active=false`，启动后需要 `SIGUSR1` 激活；脚本本身不发。
5. 历史 cron 的停机是 `pkill -9`；可能留仓，必须先 `SIGTSTP`/人工平仓。
6. `position.csv` 只是 ORS 时点快照，TradeBot 不读；重启不恢复仓位。

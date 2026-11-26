# 原始 TradeBot + Qt 前端调查档案（/Volumes/DevDisk/146）

> 调查对象：`/Volumes/DevDisk/146`（用户口中的 `/DevDisk/146`）。
> 输出位置：`/Users/wangjun/PG/quantlink-new/146`。
> 本目录只读分析，不修改 `/Volumes/DevDisk/146`。

## 这是什么

`/Volumes/DevDisk/146` 不是单一源码仓库，而是一份 **2015 年的 Linux 机器/数据盘快照**，包含：

- `2/`：约 17GB，一套完整 Linux 根文件系统（`bin/`、`etc/`、`usr/`、`root/`、`opt/Qt5.3.2` 等）+ `/home` 下的 TradeBot/GUI/infra。
- `3/`：约 58GB，一套以 `/home` 为主的数据盘/备份（TradeBot、TradeBot.bak、tempTradeBot、GUI、dalong/infrastructure、re 行情录制等）。
- `1/`：空目录。

其中的核心资产：

- **原始 TradeBot C++ 源码**：`3/TradeBot/TradeBot_China/`（也有 `2/TradeBot/TradeBot_China/` 副本）。
- **Qt 前端**：
  - `3/dalong/FromDaya/SkylineFL_GUI/`：Qt5/C++ 源码（`.pro`、`Main.cpp`、`Strategy.cpp`、`PositionModel.cpp` 等）。
  - `3/infra/TradingSystemsGUI/`：更早的 Qt4 运行时（二进制 + 配置 + 日志）。
  - `3/GUI/SH/`：部署后的 Qt5 GUI 运行目录（二进制、Qt5 库、配置、日志、CSV）。
- **共享基础设施**：`3/dalong/infrastructure/`（git 仓库，含 DataService、Connector、Ipc、Logger、CommonUtils、TradingSystemsGUI 等）。
- **运行数据/配置**：`3/TradeBot/TradeBot_China/{Config,controls,models,data,livescripts}`、`3/re/`（行情录制）、`3/GUI/SH/*.csv`。

## 核心结论（先看这 6 条）

1. **`2/` 是 CentOS 6.6 根盘，`3/` 是同一台机器的 `/home` 数据盘**；`1/` 为空。TradeBot 权威源码是 `3/TradeBot/TradeBot_China`，SVN r2375（2015-06-10）。
2. **TradeBot 是单进程单策略**：`RunStrategies.sh` 当前归档只启动一条 `GOLD_F_0_SFE.eve.ltp`（strategyID 420），不是现代多策略容器。
3. **Qt 前端有两条线**：历史启动命令用的是 Qt4 `TradingSystemsGUI`；`3/GUI/SH` 是 Qt5 `SkylineFL_GUI` 的部署态（2014-12-21 构建），源码树里还有一套 2015-03-19 构建未部署。两套 GUI 的实际主用关系需现场确认；SkylineFL 源码没有 VCS。
4. **没有数据库、没有订单/仓位/PnL 持久化**：配置/控制/模型是文件；`position.csv` 只是 ORS 时点快照；TradeBot 重启即空仓，和交易所账户是两本账。
5. **历史启动顺序是**：ORS → 行情 `receive.sh` → `RunStrategies.sh` → DataService/DataStream → GUI；归档 `receive_new.sh` 不能启动，用户明确应使用 `receive.shBak` 改名后的 `receive.sh`。
6. **风险很高**：ZMQ 无认证/端口即身份、root VNC、`pkill -9` 停机、源码/二进制漂移、`MAX_POS_SIZE` 名义上限事实失效。

> 详见 `01-architecture.md`、`05-build-deploy-ops.md`、`06-security-lineage.md`。

## 证据约定

- **V** = 直接读源码/配置/脚本/日志确认，附文件:行号。
- **I** = 由目录结构、时间戳、二进制/日志推断。
- **P** = 计划/文档/无法验证的假设。
- 不复制明文密码、密钥、webhook、SSH 凭据；只记录位置、权限、风险。
- 不把 2015 年的运行态当成当前生产；区分“源码”“运行目录”“备份”“操作系统镜像”。

## 文档结构

| 文件 | 内容 |
|---|---|
| `00-inventory.md` | 磁盘/目录/版本/源码与运行副本/时间线/证据 |
| `01-architecture.md` | 端到端架构、进程、ZMQ、TradeBot↔GUI、数据流 |
| `02-tradebot-core.md` | TradeBot 启动、策略层、订单/成交/仓位/PnL、指标、风控 |
| `03-qt-gui.md` | SkylineFL_GUI 源码、TradingSystemsGUI、控件、消息协议、手工单/持仓/订单/公允价值 |
| `04-config-data.md` | Config、controls、models、data、行情录制、日志、持久化 |
| `05-build-deploy-ops.md` | VS/Make/Qt 构建、infrastructure、部署、启停、VNC/日志/运行 |
| `06-security-lineage.md` | 安全、故障模式、2 vs 3 差异、旧→新演进教训 |
| `07-preservation-playbook.md` | 如何复刻/运行/保存这套旧系统，验收与未决问题 |
| `appendix/startup-matrix.md` | 历史启动顺序/进程/端口/SHM/版本矩阵 |
| `appendix/glossary.md` | 2015 原始版术语表 |
| `appendix/evidence-index.md` | 关键文件/证据索引与未决问题汇总 |
| `FAQ/` | 本次调查问答：架构图、GUI 控制成交、GUI/enableFlag/交易员视角 |

## 阅读顺序

1. `00-inventory.md` 先搞清“哪份是源码、哪份是运行、哪份是备份”。
2. `01-architecture.md` 看全局。
3. `02` / `03` 分别看后端和 Qt 前端。
4. `04` / `05` 看数据、构建、部署。
5. `06` / `07` 看风险、差异和复刻。

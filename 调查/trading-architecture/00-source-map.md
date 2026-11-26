# 00 — 仓库地图、模块、构建与依赖

> 证据约定：**V** = 直接读代码/配置/脚本确认；**I** = 结构推断；**P** = 计划/未实现。
> 源码快照：`/Users/wangjun/PG/RD/quantlink-trading`，commit `5cee3dd5b3322ec21c1958aac20ad38ba0d8ca40`，分支 `main`，2026-11-18。

## 1. 一句话概括

`quantlink-trading` 是一套 **Linux 上的多进程期货交易系统**：`ors_server` 接 CTP 柜台并通过 SysV SHM 转发行情/订单/回报；`TradeBot` 是 C++ 策略引擎；`tbadmin` 是 C++/Python 管理面；Vue/前端和管理脚本围绕这些进程做配置、监控和运维。

> **范围排除**：`web-go`（Go Dashboard/监控服务）不在本次调查范围。本文档不分析其内部实现；如果部署脚本会启动它，只在部署文档中作为外部黑盒提一句。

README 的官方链路：

```text
Market Data:  CTP API -> ors_server -> [SysV SHM 0x1001] -> TradeBot
Order Flow:   TradeBot -> [SysV SHM 0x2001] -> ors_server -> CTP API
Response:     CTP API -> ors_server -> [SysV SHM 0x3001] -> TradeBot
```

> 仓库 README 还列了一个 Go Dashboard（`memlog-reader`）；它不在本次范围。

（`README.md:5-12`，**V**）

## 2. 代码规模与语言分布

`git ls-files` 共 **4395** 个文件。按扩展名统计（只算已跟踪文件）：

| 类型 | 数量（约） |
|---|---:|
| C++ `.cpp` | 839 |
| C/C++ 头 `.h` | 1294 |
| `.hpp` | 219 |
| Python `.py` | 110 |
| Vue `.vue` | 42 |
| JS `.js` | 44 |
| Shell `.sh` | 122 |
| Markdown `.md` | 549 |
| YAML `.yaml/.yml` | 115 |
| SQL `.sql` | 1 |
| 配置 `.cfg` | 76 |

按顶层目录的跟踪文件数：

| 目录 | 文件数 | 角色 |
|---|---:|---|
| `tbsrc/` | 2133 | TradeBot C++ 策略引擎、指标、hftbase 依赖、回测/模拟配置 |
| `C++_deps/` | 759 | ORS/TradeBot 共用的 hftbase 依赖（含 RMS、Logger、Ipc、memlog、CTP 相关工具） |
| `openspec/` | 575 | 变更提案/规范，不是运行时 |
| `tbadmin/` | 305 | C++ 管理面：ZMQ/Protobuf、memlog 聚合、YB/YD 客户端 |
| `tbadmin-py/` | 189 | 旧 Python 管理/监控/巡检工具（部分已退役） |
| `tbadmin-front/` | 85 | Vue 管理前端（旧/独立） |
| `vue3-admin/` | 76 | Vue 管理前端 + Python 后端 |
| `ors/` | 52 | C++ ORS/CTP 适配器 + fee_refresh |
| `data_cpp/` | 50 | 生产配置/模型/日初数据的事实源 |
| `scripts/` | 49 | 构建、启停、监控、数据同步、cron 入口 |

| `docs/` | 17 | 旧系统文档/测试报告/架构图 |
| `tools/` | 5 | strategy_sync、交易日历 |
| `ops/` | 5 | DB 配置模板、crontab、logrotate、nginx、控制表 SQL |
| `tests/` | 6 | 测试脚本/夹具 |

> 注：`C++_deps/hftbase` 与 `tbsrc/hftbase` 是两套并存目录；ORS 使用 `C++_deps/hftbase`（`ors/CMakeLists.txt:14`），TradeBot 使用 `tbsrc/hftbase`（`tbsrc/CMakeLists.txt:21-38`）。两者不是同一个构建产物，升级时要分别核对。

## 3. 顶层目录与职责

| 路径 | 职责 | 关键入口/证据 |
|---|---|---|
| `ors/` | CTP Order Routing Service；CTP 行情/交易 API、SHM、RMS 前置检查 | `ors/China/src/main.cpp`、`ors/China/src/ORSServer.cpp`、`ors/CMakeLists.txt` |
| `tbsrc/` | TradeBot 策略引擎；策略、指标、回测/模拟 | `tbsrc/main/main.cpp`、`tbsrc/main/CommonClient.cpp`、`tbsrc/Strategies/ExecutionStrategy.cpp` |
| `tbadmin/` | C++ 管理面：agent/admin 两种角色、ZMQ/Protobuf、memlog、YD 客户端 | `tbadmin/main.cpp`、`tbadmin/admin.cpp`、`tbadmin/Makefile` |
| `tbadmin-py/` | 旧 Python 监控/巡检/风控/页面工具 | 各子目录 README；部分已退役，见 `ops/crontab.txt` 对照 |
| `tbadmin-front/` | Vue 管理前端 | `tbadmin-front/my-admin/` |
| `vue3-admin/` | Vue 管理前端 + Python 后端/消息转发 | `vue3-admin/back_end/`、`vue3-admin/frontend/` |
| `data_cpp/` | 部署配置源：`config/`、`controls/`、`models/`、`data/` | `data_cpp/bin/config/config_CHINA.92201.cfg` 等 |
| `scripts/` | 构建/部署/启停/会话/监控/数据同步/cron | `scripts/build_deploy_cpp.sh`、`scripts/ops_*.sh`、`scripts/start_*.sh` |
| `ops/` | 运维基础设施：crontab、DB 配置模板、logrotate、nginx、控制表 SQL | `ops/crontab.txt`、`ops/db.conf.example`、`ops/db/hft_control_tables.sql` |
| `tools/` | 策略表同步、交易日历 | `tools/strategy_sync/sync_tbhft_strategy.py`、`tools/trading_calendar/update_trading_days.py` |
| `docs/` | 启动/回测/测试/架构图/迁移说明 | `docs/STARTUP_GUIDE.md`、`docs/GETTING_STARTED.md`、`docs/BACKTEST_GUIDE.md` |
| `tests/` | 测试脚本/数据 | `tests/README.md` |
| `C++_deps/` | ORS 使用的 hftbase，含 RMS、Logger、Ipc、CommonUtils、memlog | `C++_deps/hftbase/` |
| `convert_data/` | 数据转换工具（Markdown 等） | `convert_data/convert_md/Makefile` |
| `openspec/` | 变更提案/规范，不是运行时代码 | `openspec/` |

## 4. 构建系统矩阵

| 组件 | 构建方式 | 语言/标准 | 主要输出 | 证据 |
|---|---|---|---|---|
| ORS | CMake + Make | C++17，`-D_USE_CTP_` | `ors_server`、`fee_refresh` | `ors/CMakeLists.txt:1-40`、`:140-173` |
| TradeBot | GNU Make（`tbsrc/Makefile`）或 CMake（`tbsrc/CMakeLists.txt`） | C++0x（Makefile）/ C++17（CMake） | `tbsrc_bin/TradeBot` | `tbsrc/main/Makefile:1-90`、`tbsrc/CMakeLists.txt:1-110` |
| hftbase | SCons | C++ | `C++_deps/hftbase`/`tbsrc/hftbase` 的库 | `tbsrc/hftbase/Makefile:1-25` |
| tbadmin | GNU Make | C++17 | `tbadmin/tbadmin` | `tbadmin/Makefile:1-45` |
| Vue 管理前端 | Vite/npm | Vue/TS | 静态 dist | `vue3-admin/frontend/`、`tbadmin-front/my-admin/` |
| 部署 | Shell | Bash | `deploy_cpp/` | `scripts/build_deploy_cpp.sh` |

### 4.1 一键构建/部署

```bash
# Linux 服务器上
./scripts/build_deploy_cpp.sh            # ORS + TradeBot -> deploy_cpp/
./scripts/build_deploy_cpp.sh --ors      # 只构建 ORS
./scripts/build_deploy_cpp.sh --trader   # 只构建 TradeBot
./scripts/build_deploy_cpp.sh --config-only
./scripts/build_deploy_cpp.sh --mode live
```

证据：`scripts/build_deploy_cpp.sh:1-90`（参数/目录布局），`:110-180`（旧名包装/仅配置同步），以及后续 ORS/TradeBot 编译段（文件 1358 行，详见 `06-build-deploy-ops.md`）。

## 5. 运行时进程与入口

| 进程 | 入口 | 作用 |
|---|---|---|
| `ors_server` | `ors/China/src/main.cpp` | CTP 行情/交易接入、SHM 发布、RMS 前置检查、订单路由 |
| `TradeBot` | `tbsrc/main/main.cpp` | 单策略/单控制文件运行；策略引擎 |
| `tbadmin agent` | `tbadmin/main.cpp` | agent 模式：memlog 转发/策略状态同步 |
| `tbadmin admin` | `tbadmin/main.cpp` | admin 模式：管理面/前端/ZMQ |
| `fee_refresh` | `ors/tools/fee_refresh/fee_refresh.cpp` | 从 CTP 查询费率生成 `fee.csv` |
| Python ops | `scripts/*.py`、`tools/*.py` | 会话、巡检、同步、报告、交易日历 |

## 6. 数据与配置事实源

- **配置源**：`data_cpp/bin/config/`、`data_cpp/bin/controls/`、`data_cpp/bin/models/`。
- **日初/回测数据**：`data_cpp/data/`（`daily_init.*`、`fee.csv`、`contractfile`、`trading_days.txt`、`OptionsParams`、`session_rules.csv` 等）。
- **生产运行目录**：`deploy_cpp/bin/`（由 `scripts/build_deploy_cpp.sh` 生成；`cwd` 通常是这里）。
- **数据库配置**：`ops/db.conf`（由 `ops/db.conf.example` 复制，gitignored）；PostgreSQL `dbtrade`。
- **控制面 DB 表**：`ops/db/hft_control_tables.sql`（调度/动作/产品），策略表 `tbhft_strategy` 由 `tools/strategy_sync` 同步。
- **cron/运维**：`ops/crontab.txt`（含旧任务迁移对照和当前生效段）。

> 不要把 `deploy_cpp/`、`ors/build/`、`tbsrc_bin/` 里的生成物当源码；它们是构建/部署产物，可能过期或本机平台相关。

## 7. 外部依赖与平台假设

| 依赖 | 用途 | 证据/备注 |
|---|---|---|
| CTP SDK 6.7.11（Linux `.so` + 头文件） | ORS 行情/交易 | `ors/third_party/ctp/linux/`；CMake `link_ctp_sdk` |
| CTP macOS framework（旧） | macOS 构建 | `ors/third_party/ctp/macos/`；生产以 Linux 为主 |
| PostgreSQL + libpqxx | 策略表、管理面、运维数据 | `tbadmin/Makefile`、`ops/db.conf.example` |
| Protobuf | tbadmin/admin 协议 | `tbadmin/admingpb.*`、`msggpb.*` |
| ZeroMQ | tbadmin 消息总线 | `tbadmin/Makefile` 的 `-lzmq` |
| YD API（`libyd`） | tbadmin 账户/持仓查询 | `tbadmin/Makefile`、`tbadmin/client_yd.cpp` |
| hsflow/其他 hftbase 库 | SHM、Logger、memlog、RMS | `C++_deps/hftbase/` |
| Node/pnpm + Vue/Vite | 前端 | `vue3-admin/`、`tbadmin-front/` |
| 企微 webhook（当前默认停用） | 告警 | `ops/db.conf.example` 注释；`scripts/ops_*` 有空值守卫 |

## 8. 重要事实与坑（阅读后续文档前先知道）

1. **“一策略一进程”是部署事实**：`tbadmin` 按 `tbhft_strategy` 生成 control/start 脚本，`nohup ./TradeBot --Live --controlFile ... --strategyID <sid>`；`main.cpp` 的 N 策略循环是遗留/回归路径，不是生产多策略容器。详见 `02-runtime-strategy.md`。
2. **所有策略默认共用 `ACCOUNT=OWN`**：`data_cpp/bin/config/StrategyConfig.cfg:1`、`tbadmin/admin.cpp:1824`。账户级净额存在，但没有账户级对冲器；详见 `01-system-architecture.md` / `02-runtime-strategy.md`。
3. **`MAX_POS_SIZE` 在 TradeBot 里被用作累计成交量上限**（`m_maxTradedQty`），不是持仓上限；持仓限制在策略自己的 `MAX_SIZE/BID_MAX_SIZE/ASK_MAX_SIZE` 等参数。详见 `02-runtime-strategy.md`。
4. **RMS 是 ORS 侧前置检查，不是策略内部风控**：`E_RMS_*` 来自 `C++_deps/hftbase/RMS_NEW`/ORS；TradeBot 只消费 `RMS_REJECT` 并反应。详见 `03-ors-connectors.md`。
5. **`position.csv` 是时点文件，不是实时流**：ORS 只在启动/关机/CTP 查询回调写；不能当实时持仓对账源。详见 `07-operations-runbook.md`。
6. **仓库里的 `docs/` 与 `ops/crontab.txt` 含大量迁移历史**：有些是旧系统对照，有些是当前生效；后文会标“当前生效/历史对照”。
7. **`.env` 注释里曾出现明文备用凭据**：本档案不复制该值；安全文档会把它列为必须移除/轮换的风险项。

## 9. 待补充/交叉验证

后续文档会继续补充：

- 每个 Make/CMake target 的完整依赖和实际构建命令。
- `tbadmin` 两种模式、ZMQ/Protobuf 消息、前端页面与 API。
- `tbhft_*` 表的完整字段/索引/外键/写入方。
- ORS 的 CTP session、SHM 槽位、RMS 规则、订单状态机。
- 生产主机、systemd/cron、升级/回滚、备份/PITR 的实际路径。
- 旧文档与当前代码冲突清单。

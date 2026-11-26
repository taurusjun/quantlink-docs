# 附录 A — 服务/进程/端口/SHM 矩阵

> 证据约定：V = 代码/配置/脚本确认；I = 推断；P = 建议。
> 本表是运维/复刻速查，不是完整实现说明。详细证据见 02–08。

## A.1 进程矩阵

| 进程 | 可执行文件 | 角色 | 数量（190） | 启动方式 | 停止方式 | 关键源码 |
|---|---|---|---|---|---|---|
| ORS | `deploy_cpp/bin/ors_server` | CTP 行情/交易 + SHM + RMS | 1 | `start_ors.sh ctp` / `start_all.sh` | `stop_all.sh` 等待 ≤90s | `ors/China/src/main.cpp`、`ORSServer.cpp` |
| TradeBot | `deploy_cpp/bin/TradeBot` | 单策略运行时 | 每策略 1 个（约 6 个 sid） | `start_strategy.sh <sid> <session>` / `start_all.sh` | `stop_all.sh`；最终可能 `kill -9` | `tbsrc/main/main.cpp` |
| tbadmin agent | `tbadmin/tbadmin agent` | 读本机 memlog/SHM 转发 | 1 | `start_agent.sh` / cron 08:28 | `stop_agent.sh` / cron | `tbadmin/main.cpp`、`admin.cpp` |
| tbadmin admin | `tbadmin/tbadmin admin` | 聚合/管理/前端后端 | 1 | `start_admin.sh` / cron 08:30 | `stop_admin.sh` / `stop_agent.sh` | `tbadmin/admin.cpp` |
| Vue/管理页 | 前端 dist + Flask/uWSGI | 管理 UI | 1 套 | `runserver.py`/uWSGI（现场） | 进程管理 | `vue3-admin/back_end`、`tbadmin-front` |
| PostgreSQL | `postgresql-16.service` | `dbtrade` / `admin` | 1 | systemd（DB 自身） | systemd | `ops/db.conf.example`、`05` |
| cron | `crond` | 会话/同步/看门狗 | 1 | 系统 | 系统 | `ops/crontab.txt` |
| 外部 Go 工具 | `memlog-reader` 等 | Dashboard/监控 | 1+ | 构建/start_all（外部黑盒） | 进程管理 | **不在本档案范围** |

## A.2 端口

| 端口 | 组件 | 绑定 | 用途 | 证据 |
|---|---|---|---|---|
| 5432 | PostgreSQL | `127.0.0.1`（I） | `dbtrade` / `admin` | `ops/db.conf.example`、`05` |
| 9980 | tbadmin admin | `tcp://*:9980`（V） | ZMQ PUB/SUB 管理通道 | `tbadmin/cfg/admin.cfg`、`08` |
| 9981 | tbadmin admin | `tcp://*:9981`（V） | ZMQ 管理通道 | 同上 |
| 5004 | Flask 管理后端 | 现场（V 代码可能 0.0.0.0） | HTTP API | `vue3-admin/back_end/runserver.py`、`08` |
| 8882 | message_forwarding | 现场 | WebSocket/消息转发 | `tbadmin-py/new/message_forwarding`、`08` |
| 50003 | nginx | 现场 | 管理页反代 | `ops/nginx/quantlink-admin.conf`、`08` |
| 8080/8081 | 外部 Dashboard | `:port`（V） | Web/监控（范围外黑盒） | `data_cpp/bin/config/memlog-reader*.yaml` |
| 28080/28081 | 外部 Dashboard alt | `:port` | 190 备用 | 同上 |

> 9980/9981 无认证、无加密；不要暴露到不可信网络。详见 `08-security-gaps.md`。

## A.3 SysV SHM / memlog key

| Key（hex/dec） | 结构/用途 | 写者 | 读者 | 关键约束 | 证据 |
|---|---|---|---|---|---|
| `0x1001` / 4097 | `MarketUpdateNew` 行情 | ORS | TradeBot（每策略） | 结构体 816B、队列元素 824B；槽数需一致 | `03` §3 |
| `0x2001` / 8193 | `RequestMsg` 订单/撤单请求 | TradeBot | ORS | 结构体 256B、元素 320B；无来源校验 | `03` §3 |
| `0x3001` / 12289 | `ResponseMsg` 订单/成交回报 | ORS | TradeBot | 结构体 176B、元素 184B | `03` §3 |
| `0x4001` / 16385 | ClientStore | ORS/客户端 | ORS/客户端 | clientId/上下文 | `03` §3 |
| 789 / `0x315` | MemLog 策略状态/PnL/订单事件 | TradeBot | tbadmin agent | 结构/长度需与 `MEMLOG_LEN_LIST` 一致 | `04` §8.8、`06` |
| 其他 | 各策略/监控自定义 | — | — | 见 `03`/`04` | — |

## A.4 目录与文件

| 路径 | 用途 | 备注 |
|---|---|---|
| `/root/quantlink-trading` | 生产仓库根 | git clone；构建脚本所在 |
| `deploy_cpp/bin` | 运行时 cwd | `TradeBot`/`ors_server`/脚本/配置/日志 |
| `deploy_cpp/data` | `../data` | 由 `data_cpp` 同步；`daily_init`/fee/contract 等 |
| `deploy_cpp/lib/ctp` | CTP 动态库 | Linux `.so`/macOS framework |
| `data_cpp/bin/{config,controls,models,live}` | 配置事实源 | `build_deploy_cpp.sh` 同步 |
| `data_cpp/data` | 数据事实源 | 软链到 `/home/hft/tbdata` |
| `/home/hft/tbdata` | TradeBot 硬编码数据路径 | `contractfile`/`fee.csv`/`RolloverOverrideFile` |
| `deploy_cpp/bin/log` | 运行日志 | 轮转到 `log.bak/` |
| `deploy_cpp/bin/live/data/position.csv` | ORS 时点持仓 | 不是实时流 |
| `deploy_cpp/report_bak` | 日终报告 | `ops_eod_report` |
| `tbadmin/` | 管理面源码/二进制 | 私有 `.so` 可能不在 git |

## A.5 会话/启停命令

```bash
# 仓库根（生产）
./scripts/ops_start_session.sh day
./scripts/ops_stop_session.sh day
./scripts/ops_start_session.sh night   # 当前夜盘通常停用

# deploy_cpp/bin（核心组件）
./scripts/start_all.sh ctp day
./scripts/start_all_with_tbadmin.sh ctp day
./scripts/stop_all.sh
./scripts/stop_all_with_tbadmin.sh

# 策略信号
./scripts/ops_tb_signal.sh 92201 on
./scripts/ops_tb_signal.sh 92201 off
./scripts/ops_tb_signal.sh 92201 flatten   # 以脚本实际用法为准
```

> 命令细节/前置条件见 `06`、`07`；不要直接在生产试 `--clean`。

## A.6 日志/监控速查

| 日志 | 内容 | 轮转 |
|---|---|---|
| `deploy_cpp/bin/log/ors_server-*.log` | CTP 登录/订单/错误/密码风险 | `ops_rotate_logs.sh` |
| `deploy_cpp/bin/log/TradeBot*` / `log.<type>.<sid>` | 策略决策/订单/成交/PnL | 同上 |
| `deploy_cpp/bin/log/tbadmin*` | 管理面/DB/ZMQ | `logrotate/quantlink-tbadmin` |
| `deploy_cpp/bin/log/memlog-reader*` | 外部 Dashboard | 同上 |
| cron 输出/`nohup.out.*` | 启停/告警/失败 | 需单独检查 |

## A.7 事实源优先级

1. **交易执行**：TradeBot 内存 + ORS/CTP 账户事实。
2. **策略启动**：`data_cpp`/`deploy_cpp` 文件（control/model/daily_init）。
3. **策略注册**：PostgreSQL `tbhft_strategy`（经 `strategy_sync` 物化）。
4. **监控展示**：memlog/tbadmin/前端（可陈旧，不是真相）。
5. **日志**：事后取证，不是活体探针。

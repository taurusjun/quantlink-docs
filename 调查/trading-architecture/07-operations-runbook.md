# 07 — 运维、监控、告警、故障处置与备份恢复

> 证据约定：**V** = 直接读代码/配置/脚本确认；**I** = 由代码结构、脚本、部署文件推断，未在运行环境验证；**P** = 计划/文档描述，当前代码未完全实现。
> 源码快照：`/Users/wangjun/PG/RD/quantlink-trading`，commit `5cee3dd5b3322ec21c1958aac20ad38ba0d8ca40`，分支 `main`，调查日期 2026-11-18。
> 范围：运维、监控、健康检查、告警、日常检查、故障处置、备份/恢复、数据安全。**不分析 `web-go` / Go Dashboard 内部**；`memlog-reader`、`check-md`、`md-recorder` 仅作为外部黑盒提及。
> 本文不记录任何明文口令、token、webhook URL。涉及凭据的位置只写文件、权限、加载方式。

---

## 0. 一页结论

先给最影响复刻和值守的结论。后面的章节逐条展开证据。

| # | 结论 | 影响 | 证据 |
|---|---|---|---|
| 1 | 生产是 **cron + shell + 单机 PostgreSQL + 单盘**，没有 systemd 交易单元、没有容器编排、没有异地备份、没有 PITR、没有 `pg_dump` 产物 | 磁盘坏 = 日志/快照/密钥/本机 DB 永久丢失；只能从 git + 券商/RDS 重建“能交易”的最小集 | `ops/crontab.txt:1-8`、`docs/RISK_NO_OFFSITE_BACKUP.md:15,58-66,119-120`（V；现场未复核 I） |
| 2 | 告警默认是**静默**的：`WECHAT_WEBHOOK` 为空或不是可用 URL 时，所有脚本降级为“只写日志” | 无人值守时故障只留在本机日志里；2026-11-09 起官方默认就是停用 | `ops/db.conf.example:11-15`、各脚本空值守卫；当前工作区 `ops/db.conf` 的该行不是 `https://` URL（V/I） |
| 3 | 主健康检查 `ops_check_status.sh` 实际只在 **00:00** 跑；20:50 的 `--evening` 被收进“夜盘受管块”并注释 | 夜盘停用后，00:00 会对 ORS/TradeBot/memlog-reader 报“缺失”，是结构性误报；20:50 的盘后检查不存在 | `ops/crontab.txt:99-101,923-939`、`scripts/ops_check_status.sh:35-36,141-170`（V 逻辑；190 现场表现 I） |
| 4 | `ops_check_status` 的“费率/启动失败”检查在 00:00 **读不到策略日志**（当前夜盘停用）：15:15 已把 `log/*` 搬到 `log.bak/`，20:13 又没有夜盘新日志 | 检查项 3 静默跳过；只剩检查项 8 的事前合约预检在兜底 | `scripts/ops_check_status.sh:103-107`、`scripts/ops_rotate_logs.sh:35-61`、`ops/crontab.txt:923-939`（V 逻辑） |
| 5 | `position.csv` 是**时点文件**，只在 ORS 启动查询完成、空仓查询完成、ORS 正常关机时写；`daily_init` 才是策略启动时的持仓真相 | 不能用 `position.csv` 做实时对账；盘中快照里的 `position.csv` 是开盘时点的旧值 | `ors/China/src/ORSServer.cpp:207-233,264,1430-1560`、`tbsrc/Strategies/PairwiseArbStrategy.cpp:24-46`（V） |
| 6 | 代码里**没有** “`daily_init` 与 CTP `position.csv` 自动修正”的桥；ORS 只修正自己的 `mapContractPos` 并重写 `position.csv` | `.claude/CLAUDE.md:675-676` 和上线测试清单 R-4 的“auto-correction”说法是 **P/错误**；崩溃后必须人工核对/修正 `daily_init` | `PairwiseArbStrategy.cpp:24-46`（只读 daily_init）、`ORSServer.cpp:1500-1560`（只换 ORS 表）；`.claude/CLAUDE.md:675`（P） |
| 7 | `tbstop`（SIGTSTP）的 squareoff 对 PairwiseArb 是“**撤单 + 等成交回报对冲**”，不是保证市价平仓；`SIGTERM` 还要求 `./config/signal.txt` 存在且列出该品种，**仓库没有这个文件**；`stop_all` 等 10s 后 `kill -9` TradeBot，ORS 等 90s | 收盘/重启后可能仍有单腿持仓；`stop_all` 对单策略通常是**硬杀**，会丢当日 `daily_init` 修正；不能把 `tbstop` 当“必然平光” | `tbsrc/main/main.cpp:111-170`、`docs/2026-09-23_策略库分析.md:205`、`PairwiseArbStrategy.cpp:1024-1056,970-1010,535-560`、`build_deploy_cpp.sh:679-745`（V） |
| 8 | Live 模式 TradeBot 启动默认 **inactive**；自动重启只激活 `92221 92222`，不激活 `92204` | 开盘/ORS 自愈后，真正要交易的 `92204` 可能一直不报价；必须人工 `tbstart 92204` | `ExecutionStrategy.cpp:390-392`、`ops/crontab.txt:46`、`ops_preopen_check.sh:29,99-101`、`ops_md_liveness_watchdog.sh:37,110-112,192-194`（V） |
| 9 | 日志**无限本地保留**；`ctp_flow.bak` 按同名覆盖；`/var/log/quantlink` 无轮转；`ops/db.conf` 是 644；策略日志会打印带口令的 DSN（当 DSN 非空） | 磁盘可被日志/核心转储吃满；历史 CTP flow 只留最后一天；口令进入归档日志 | `ops_rotate_logs.sh:35-69`、`ops/logrotate/quantlink-tbadmin:1-13`、`ls -l ops/db.conf`、`ExecutionStrategy.cpp:72`（V/I） |
| 10 | 没有 DB 备份；`tbhft_strategy` 可由 RDS 每 10:30/20:30 同步恢复，`tbtrading_days/tbinstrument_info/tbtrade_sections` 可由文件/ORS dump 重建；其余控制面表不可重建 | 单盘坏后 DB 只能“部分重建”；`tbhft_strategy_bak_sync_*` 是同盘表，不是备份 | `tools/strategy_sync/sync_tbhft_strategy.py:14-15,34,212-235`、`docs/RISK_NO_OFFSITE_BACKUP.md:66,119-120`（V） |
| 11 | 复制时最容易漏的隐藏状态：**crontab 整份替换**、交易日历双副本、`MEMLOG_READER_CONFIG` 端口覆盖、`strategies.disabled`、pid/cooldown/stamp 文件 | 少一个就会“代码一样但行为不同” | `ops/crontab.txt:27-32`、`ops_start_session.sh:28-47`、`build_deploy_cpp.sh:546-575`、`ops/db.conf.example:20-24`（V） |

**一句话**：这套系统的“自动”集中在**启动/停止/轮转/快照**，不集中在**持仓正确性**和**告警可达性**。复刻时要把“自动”与“必须人工确认”分开，否则会把结构性误报当成故障、把 `tbstop` 当成平仓保证。

---

## 1. 运维边界与事实源

### 1.1 主机、目录、时区

| 项 | 值 | 证据 |
|---|---|---|
| 生产主机 | `root@101.43.54.190`（文档记录；现场未复核） | `ops/crontab.txt:4`（V 文档） |
| 项目根 | `/root/quantlink-trading` | `ops/crontab.txt:5`（V） |
| 部署/运行目录 | `/root/quantlink-trading/deploy_cpp/bin` | `ops/crontab.txt:6`、`ops_start_session.sh:13`（V） |
| 时区 | 服务器本地时间 = 北京时间 CST；策略 C++ 日志用 UTC | `ops/crontab.txt:7`、`docs/STARTUP_GUIDE.md:363`（V） |
| cron 安装 | `crontab /root/quantlink-trading/ops/crontab.txt`，**整份替换**，不是追加 | `ops/crontab.txt:8,27-32`（V） |
| 数据库 | 本机 PostgreSQL 16，`dbtrade`，`127.0.0.1:5432` | `ops/db.conf.example:5-9`、`docs/RISK_NO_OFFSITE_BACKUP.md:113-116`（V） |
| 磁盘 | 单盘 `/dev/vda1` 178G；无网络挂载、无第二台机器 | `docs/RISK_NO_OFFSITE_BACKUP.md:15,26-40`（V 文档） |
| PG 数据目录 | `/var/lib/pgsql/16/data/`，约 96M，`dbtrade` 15M | `docs/RISK_NO_OFFSITE_BACKUP.md:66`（V 文档） |
| 企微告警 | 2026-11-09 起默认停用，`WECHAT_WEBHOOK=` 留空 | `ops/db.conf.example:11-15`（V） |

> 注意：`ops/crontab.txt` 同时包含“当前生效段”“历史对照段”“已退役理由段”。读这个文件时必须看行首有没有被注释，不能按段落标题猜。本文只把**行首是数字/`*` 的行**当作生效任务；其余是历史说明。

### 1.2 进程、端口、职责

| 进程 | `comm` / 识别名 | 端口 | 启动方 | 主要日志 | 职责 |
|---|---|---|---|---|---|
| `ors_server` | `ors_server` | 无监听端口（CTP 出站） | `start_ors.sh`（由 `start_all.sh` 调） | `deploy_cpp/bin/log/ors_server.<YYYYMMDD>.log` | CTP 行情/交易、SHM 0x1001/0x2001/0x3001/0x4001、RMS 前置、`position.csv` |
| `TradeBot` | `TradeBot` | 无 | `start_strategy.sh`（每策略一个进程） | `log/log.<control_basename>.<YYYYMMDD>`、`log/nohup.<control_basename>.<YYYYMMDD>` | 策略引擎；读 control/model，写 MemLog 789 |
| `tbadmin admin` | `AdminLoop` | ZMQ 9980/9981 | `tbadmin/start_admin.sh` | `tbadmin/log/admin.log`（脚本），另有 `cfg LOG_FILE` | 管理面：收 agent、读 `tbhft_strategy`、转发前端 |
| `tbadmin agent` | `AgentLoop` | ZMQ connect 到 9980/9981 | `tbadmin/start_agent.sh` | `tbadmin/log/agent.log` | 读 SHM 789/4097/12289，转发给 admin |
| `memlog-reader` | `memlog-reader` | 28080/28081（190 用 alt 配置；默认 8080/8081） | `start_all.sh`、`ops_watchdog_memlog.sh` | `log/memlog-reader.<YYYYMMDD>.log` | Go Dashboard；`/api/strategies`、`/api/orders`；**黑盒** |
| `check-md` | `check-md` | 无 | `ops_check_md.sh start` | `log/check-md.<YYYYMMDD>.log` | 独立行情断流检测（Go）；读 MD SHM；**黑盒** |
| `md-recorder` | `md-recorder` | 无 | `ops_start_md_recorder.sh` | `log/md-recorder.<YYYYMMDD>.log` | 只读 MD SHM → `/home/u50_data/u50_*.csv`；**黑盒** |
| `message_forwarding.py` | python | 8882（Flask/SocketIO） | 手工/`start_all_with_tbadmin.sh` | `/tmp/flask.log` | tbadmin → 前端消息转发 |
| `vue3-admin` 后端 | python | 5004 | `start_tbadmin.sh` | `/tmp/vue3admin.log` | 旧/独立管理前端 |
| PostgreSQL | `postgres` | 5432 | systemd `postgresql-16.service` | `/var/lib/pgsql/16/data/log/` | `dbtrade` |
| nginx | `nginx` | 8080（190 被 `dietitian-admin-web` 占用） | 系统 | 系统日志 | 与交易无关，但会占 8080，导致 memlog 必须走 alt 配置 |

证据：`ops_check_status.sh:155-167`（`AdminLoop/AgentLoop` 的 comm 名）、`admin.cpp:1520,4447`（`prctl(PR_SET_NAME)`）、`tbadmin/cfg/admin.cfg`/`agent.cfg`、`data_cpp/bin/config/memlog-reader.alt.yaml:6-8`、`ops_watchdog_memlog.sh:24-32`、`docs/STARTUP_GUIDE.md:52-66,244,323-333`。

> `memlog-reader` 与 `check-md`/`md-recorder` 的内部实现属于 `web-go`，不在本文范围。本文只把它们当作“有固定端口/固定退出码/固定日志”的外部依赖；它们的行为若变化，本文的判据要重新核对。

### 1.3 运维文件地图

| 路径 | 作用 | 读法/注意 |
|---|---|---|
| `ops/crontab.txt` | 生产 crontab 的**唯一源**；整份替换安装 | 行首数字才是生效行；末尾有大量“已退役”说明 |
| `ops/db.conf` | DB + 企微 webhook 的本地凭据（gitignored） | 644，需收紧；脚本 `source` 或只 `grep` 一行 |
| `ops/db.conf.example` | 模板；2026-11-09 起 webhook 默认空 | 部署时复制，不要提交真实值 |
| `ops/logrotate/quantlink-tbadmin` | tbadmin `admin.log` 的 logrotate 模板 | **没有安装器**；需手工放到 `/etc/logrotate.d/` |
| `scripts/ops_start_session.sh` | 日/夜会话启动包装 | 日历门控 + 残留 ORS 清理 + `start_all.sh` |
| `scripts/ops_stop_session.sh` | 会话停止包装 | 先 `ops_eod_report.sh`，再 `stop_all.sh` |
| `scripts/ops_check_status.sh` | 主健康检查（00:00；`--evening` 20:50） | 9 个检查项；告警聚合 |
| `scripts/ops_check_md.sh` | 启动/停止 `check-md` | 09:01/21:01 启；15:30/02:30 停 |
| `scripts/ops_md_liveness_watchdog.sh` | 行情活性看门狗（每 5 分钟） | 只日盘窗口；断流则重启日盘会话 |
| `scripts/ops_preopen_check.sh` | 开盘前体检（08:55/09:00） | 只 08:48-09:04 动作；10 分钟冷却 |
| `scripts/ops_watchdog_memlog.sh` | `memlog-reader` 看门狗（09:35/13:35/21:35） | 只“不存在才拉起”，不处理挂起 |
| `scripts/ops_ensure_tbadmin.sh` | tbadmin agent/admin 存活守护（每 5 分钟） | 只按 pid 文件；失败静默 |
| `scripts/ops_rotate_logs.sh` | 15:15 本地日志轮转 | `log/*` → `log.bak/<date>/`；`ctp_flow/*` → `ctp_flow.bak/` |
| `scripts/ops_snapshot_daily_init.sh` | 07:00 `daily_init` 快照 | 复制 `deploy_cpp/data/daily_init.*` → `daily_init_bak/<date>/` |
| `scripts/ops_snapshot_money.sh` | 11:46/15:16 资金/持仓快照 | 复制 `daily_init.*` + `position.csv` → `money_bak/` |
| `scripts/ops_sync_git.sh` | 15:20 `daily_init` + `position.csv` 提交/推送 | 只 `git add` 两个路径；无 pull/rebase |
| `scripts/ops_eod_report.sh` | 停会话前抓 Dashboard 快照 | 写 `report_bak/report_<date>_<label>.txt` |
| `scripts/ops_feed_db.sh` / `.py` | 17:00 喂 DB | 合约 dump、日历、sections、contractfile |
| `scripts/ops_refresh_fee.sh` | 15:40 CTP 直查刷新 `fee.csv` | 成功后 commit/push + 写戳 |
| `scripts/ops_setup_arbi.sh` | 20:10 重算 control 窗口、CPU 亲和校验、sections | **当前夜盘块被注释，未生效** |
| `scripts/is_trading_day.sh` | 交易日历门控 | `--today/--next/--night-ok`；故障 fail-closed |
| `scripts/ops_tb_signal.sh` | 策略信号（activate/deactivate/reload） | `SIGUSR1/SIGTSTP/SIGUSR2`；不重启进程 |
| `scripts/ops_install_deps.sh` | 190 一次性引导 | 建 `/home/hft/tbdata` 软链、备份 crontab、webhook 测试 |
| `scripts/ops_night_session.py` | 夜盘受管块的开关/整理 | 直接改 crontab；会重写块外匹配行 |
| `docs/RISK_NO_OFFSITE_BACKUP.md` | **备份事实的权威文档** | 明确“单盘、无副本、已接受风险” |
| `scripts/start_all_with_tbadmin.sh` / `stop_all_with_tbadmin.sh` | 手工一键启停（含 tbadmin/Flask） | **不进 cron**；`stop` 会 `kill -9` tbadmin/Flask 并清所有 SHM |
| `scripts/start_all_with_frontend.sh` / `stop_all_with_frontend.sh` | 手工一键启停（含前端/防火墙） | **不进 cron**；会开 8080/8081/8882 防火墙、`pkill vite/uvicorn/admin_backend`；只在调试机用 |

### 1.4 仓库默认 vs 190 运行态（复刻时必须分开）

| 项 | 仓库当前状态 | 对运维的含义 |
|---|---|---|
| 夜盘 | 受管块整体注释；`20:13/02:40/02:56/02:50/20:10/20:28/20:30/20:47/20:50` 都不生效 | 夜间没有 ORS/TradeBot；但 `21:01 check-md`、`21:35 memlog 看门狗`、`02:30 check-md stop`、`02:50 md-recorder stop` 仍生效；`09:20/14:50` 的 delta 快照是日盘任务，不是夜盘 |
| 策略停用清单 | `92201/92202/92203` 停用 | `start_all.sh` 会跳过；手动 `start_strategy.sh` 不受影响 |
| 当前可启动策略 | `92204`、`92221`、`92222` | `92204` 需人工激活；`92221/92222` 09:05 自动激活 |
| `92221` 控制文件 | 同一天有两个：`control.IF2612.IF2610.par.txt.92221` 与 `control.TA701.TA702.par.txt.92221` | `start_strategy.sh` 的 glob 取第一个（IF），TA 文件是“死配置”；日志里的 `Control File:` 才是实际 |
| Dashboard 端口 | 主配置 8080/8081；190 因 8080 被 nginx 占用，用 `memlog-reader.alt.yaml` 的 28080/28081 | 必须确认 `ops/db.conf` 里有 `MEMLOG_READER_CONFIG=config/memlog-reader.alt.yaml`；否则 eod/看门狗会打到错误服务 |
| Dashboard 策略表 | `memlog-reader.yaml` 的 `strategies` 只列了 `92201/92202`（已停用） | 页面上的策略/模型元数据可能不完整；不要把它当唯一真相 |
| 企微 webhook | 模板为空；当前 `ops/db.conf` 的值不是 `https://` URL | 实际等于静默；所有 `[ALERT]` 只落日志 |
| logrotate | 只有模板，没有安装脚本 | 190 上是否已安装需现场确认；未安装则 `tbadmin/log/admin.log` 无限增长 |
| 备份 | 单盘、无异地、无 PITR、无 `pg_dump` | 见第 7 章 |

### 1.5 时间与日志时区陷阱

- 服务器本地时间 = 北京时间；`ops_*` 的 `date`、cron 时间、crontab 注释都是 CST。
- `TradeBot` 的 C++ 日志用 **UTC**（`docs/STARTUP_GUIDE.md:363`；`ops_tb_signal.sh:136` 提示“日志时间为 UTC”）。
- 同一天的策略日志文件名用**启动日**（`start_strategy.sh` 的 `DATE=$(date +%Y%m%d)`），日盘和夜盘可能同名；`ops_rotate_logs.sh:38-45` 用“文件名里的 8 位日期”分子目录，撞名再加 `.2/.3`。
- 排查时先确认日志是 UTC 还是 CST，再与 cron/告警时间对齐；不要直接把 `14:57` 的 CST 事件去 UTC 日志里搜 `14:57`。

---

## 2. 交易日运行手册

### 2.1 时间轴总表（当前生效状态）

| 时间（CST） | 任务 | 脚本/命令 | 当前状态 | 失败后果 | 证据 |
|---|---|---|---|---|---|
| 06:00 每日 | 校时 | `chronyc -a makestep 1.0 1` | 生效 | 时间漂移 → 订单时间戳/日志错位 | `ops/crontab.txt:39` |
| 07:00 周一-五 | `daily_init` 快照 | `ops_snapshot_daily_init.sh` | 生效 | 丢当日开盘前基线 | `ops/crontab.txt:70` |
| 08:28 周一-五 | 停 tbadmin（实际连 admin 一起杀） | `tbadmin/stop_agent.sh` | 生效 | 监控链短暂中断 | `ops/crontab.txt:919`、`tbadmin/stop_agent.sh:8-13` |
| 08:30 周一-五 | 启 agent | `tbadmin/start_agent.sh` | 生效 | 监控数据链断 | `ops/crontab.txt:920` |
| 08:30 周一-五 | 启 admin | `tbadmin/start_admin.sh` | 生效 | 前端/策略表不可用 | `ops/crontab.txt:921` |
| 08:47 周一-五 | 日盘 MD 录制 | `ops_start_md_recorder.sh` | 生效 | 无行情 CSV；不影响交易 | `ops/crontab.txt:917` |
| **08:50** 周一-五 | **日盘会话启动** | `ops_start_session.sh day` | 生效 | 无 ORS/TradeBot，全天不能交易 | `ops/crontab.txt:43` |
| 08:55 周一-五 | 开盘前体检 #1 | `ops_preopen_check.sh` | 生效 | ORS 未起/登录未完成无人处理 | `ops/crontab.txt:123` |
| 09:00 周一-五 | 开盘前体检 #2 | `ops_preopen_check.sh` | 生效 | 同上；但可能被 08:55 冷却挡住 | `ops/crontab.txt:125`、`ops_preopen_check.sh:78-85` |
| 09:01 周一-五 | 启 `check-md` | `ops_check_md.sh start` | 生效 | 无独立断流告警 | `ops/crontab.txt:111` |
| 09:05 周一-五 | 自动激活 92221/92222 | `ops_tb_signal.sh <sid> activate` | 生效 | 测试策略不报价 | `ops/crontab.txt:46` |
| 09:20 周一-五 | Delta 快照（开盘） | `ops_delta_snapshot.py --tag open` | 生效（依赖 socketio/8882） | 验收数据缺失 | `ops/crontab.txt:942` |
| 11:46 周一-五 | 资金/持仓快照 am | `ops_snapshot_money.sh am` | 生效 | 少一份盘中快照 | `ops/crontab.txt:91` |
| 14:50 周一-五 | Delta 快照（收盘前） | `ops_delta_snapshot.py --tag close` | 生效（同上） | 验收数据缺失 | `ops/crontab.txt:943` |
| ~14:57 | 策略内部 `endTime-180s` 停手 | `ExecutionStrategy.cpp:44` / `PairwiseArbStrategy.cpp:970` | 代码内建 | 到点撤单/停用/可能留仓 | `ExecutionStrategy.cpp:44-47`、`PairwiseArbStrategy.cpp:970-1010` |
| ~14:59 | 策略内部 `endTime-60s` 激进 flat 兜底 | `ExecutionStrategy.cpp:46` / `PairwiseArbStrategy.cpp:951` | 代码内建 | 同上 | `ExecutionStrategy.cpp:46-47`、`PairwiseArbStrategy.cpp:951-968` |
| 15:00 | 收盘 | — | — | — | — |
| **15:05** 周一-五 | **日盘停会话** | `ops_stop_session.sh day` | 生效 | 进程/持仓/SHM 未收尾 | `ops/crontab.txt:47` |
| 15:15 周一-五 | 日志轮转 | `ops_rotate_logs.sh` | 生效 | 日志留在 `log/`，下一日混写 | `ops/crontab.txt:96` |
| 15:16 周一-五 | 资金/持仓快照 pm | `ops_snapshot_money.sh pm` | 生效 | 少收盘快照 | `ops/crontab.txt:92` |
| 15:20 周一-五 | git 同步 | `ops_sync_git.sh day` | 生效 | `daily_init/position.csv` 未推送 | `ops/crontab.txt:71` |
| 15:30 周一-五 | 清 tbadmin 日态 | `tbadmin/clear.sh` | 生效 | `order_ref.json`/`cfg/*.dat` 未重置 | `ops/crontab.txt:131` |
| 15:40 周一-五 | 刷新 `fee.csv` | `ops_refresh_fee.sh apply` | 生效 | 次日缺合约 → 策略 `exit(1)` | `ops/crontab.txt:88` |
| 17:00 周一-五 | DB 喂数 | `ops_feed_db.sh` | 生效 | 合约/日历/sections 不更新 | `ops/crontab.txt:55` |
| 20:10 周一-五 | 重算 control/亲和/sections | `ops_setup_arbi.sh` | **被注释（夜盘块）** | 窗口/亲和校验不做 | `ops/crontab.txt:923-939`、`scripts/ops_setup_arbi.sh:1-17` |
| 20:13 周一-五 | 夜盘启动 | `ops_start_session.sh night` | **被注释** | 夜盘不交易 | `ops/crontab.txt:923-939` |
| 20:28/20:30 | tbadmin 夜盘重启 | `stop_agent/start_agent/start_admin` | **被注释** | 夜间不重启 | `ops/crontab.txt:923-939` |
| 20:47 | 夜盘 MD 录制 | `ops_start_md_recorder.sh` | **被注释** | 无夜盘 CSV | `ops/crontab.txt:923-939` |
| 20:50 | 晚间体检 | `ops_check_status.sh --evening` | **被注释** | 盘后无检查 | `ops/crontab.txt:923-939` |
| 21:01 周一-五 | 启 `check-md`（夜盘窗口） | `ops_check_md.sh start` | **生效** | 夜盘无 ORS 时可能空跑/误报 | `ops/crontab.txt:111` |
| 21:35 周一-五 | memlog 看门狗 | `ops_watchdog_memlog.sh` | **生效** | 夜间拉起 Dashboard | `ops/crontab.txt:115` |
| 00:00 周一-五 | 主健康检查 | `ops_check_status.sh` | **生效** | 夜盘停用后结构性误报 | `ops/crontab.txt:99` |
| 02:30 周二-六 | 停 `check-md` | `ops_check_md.sh stop` | 生效 | 进程残留 | `ops/crontab.txt:112` |
| 02:40 周二-六 | 夜盘停会话 | `ops_stop_session.sh night` | **被注释** | 无夜盘收尾 | `ops/crontab.txt:923-939` |
| 02:50 周二-六 | 停 MD 录制 | `ops_stop_md_recorder.sh` | 生效 | 录制器残留 | `ops/crontab.txt:107` |
| 02:56 周二-六 | 夜盘资金快照 | `ops_snapshot_money.sh night` | **被注释** | 无夜盘快照 | `ops/crontab.txt:923-939` |
| 02:50 周二-六 | 夜盘 git 同步 | `ops_sync_git.sh night` | **被注释** | 夜盘数据不推送 | `ops/crontab.txt:923-939` |

> 注意：`ops_start_session.sh` 文件头注释还写着“08:13 启动”，但实际 cron 是 `50 08`（08:50），`ops_preopen_check.sh:56-59` 也记录了 2026-11-04 从 08:13 改到 08:50。以 crontab 行为准，注释是历史（V）。

### 2.2 开盘前（06:00–08:59）

#### 2.2.1 自动流程

1. **06:00 校时**：`chronyc -a makestep 1.0 1`（`ops/crontab.txt:39`）。只写 `/var/log/ntpdate.log`，不检查结果。
2. **07:00 `daily_init` 快照**：复制 `deploy_cpp/data/daily_init.*` 到 `deploy_cpp/daily_init_bak/<YYYYMMDD>/`（`ops_snapshot_daily_init.sh:22-35`）。只警告“0 个文件”，不校验内容。
3. **08:28 停 tbadmin**：`tbadmin/stop_agent.sh` 先按 `agent.pid` 杀 agent，然后 `ps -ef | grep -w './tbadmin'` **把 admin 也一起杀掉**（`tbadmin/stop_agent.sh:8-13`）。所以 08:28 实际是“全套 tbadmin 重启”。
4. **08:30 启 agent/admin**：crontab 顺序是 agent 先、admin 后（`ops/crontab.txt:920-921`），与 `docs/STARTUP_GUIDE.md:244` 的“先 admin 后 agent”相反。agent 若因 admin 未 bind 而退出，靠 `ops_ensure_tbadmin.sh` 在 09:05 后每 5 分钟兜底。
5. **08:47 启 MD 录制**：`ops_start_md_recorder.sh` 检查二进制/配置/pid，然后 `nohup ./md-recorder ...`（`ops_start_md_recorder.sh:31-44`）。它**不查交易日历**，节假日也会起（无害，但会空等 SHM）。
6. **08:50 日盘会话**：
   - `ops_start_session.sh day` 先跑 `is_trading_day.sh --today`；rc=1 → 跳过并 `exit 0`；rc=2（日历故障）→ `exit 1` 告警（`ops_start_session.sh:28-47`）。
   - 若 `pgrep -x ors_server` 有残留，先 `stop_all.sh`（防 CTP 双登录互踢）（`:53-59`）。
   - 然后 `exec >> log/cron_start_day.log`，调 `deploy_cpp/bin/scripts/start_all.sh ctp day`（`:50-61`）。
   - `start_all.sh` 自己还会再跑一次日历门控：优先 `../data/trading_days.txt`（deploy 副本），否则 `data_cpp/data/trading_days.txt`（`build_deploy_cpp.sh:546-575`）。**外层用 data_cpp，内层可能用 deploy_cpp**，两份日历必须同步。
   - `start_all.sh` 顺序：`start_ors.sh ctp` → 创建 MemLog SHM 789（16MB）→ 遍历 `config/config_CHINA.*.cfg` 启策略（跳过 `strategies.disabled`）→ 启 `memlog-reader`（`build_deploy_cpp.sh:600-661`）。
   - 单策略失败不阻断其余策略，最后以 `exit 1` 汇总失败 SID（`build_deploy_cpp.sh:625-660`）。
7. **08:55 开盘前体检 #1**：见 2.2.2。
8. **09:00 开盘前体检 #2**：见 2.2.2。

#### 2.2.2 `ops_preopen_check.sh` 的真实判据

- **只在 08:48–09:04 动作**：`HHMM` 不在窗口直接 `[SKIP]`（`ops_preopen_check.sh:60-64`）。
- **交易日门控**：`is_trading_day --today` 非 0 → 跳过（`:66-75`）。
- **冷却 600s**：`/var/log/quantlink/preopen_check.cooldown`；冷却内跳过（`:26-28,78-85`）。
- **ORS 不在跑** → 告警 + `start_and_activate`（`:106-110`）。
- **ORS 在跑但启动 <600s** → 跳过（登录/订阅需要时间）（`:116-120`）。
- **用 `check-md -probe -probe-wait 1s` 读 MD SHM 绝对 head**：
  - rc=2（attach 失败）→ 告警 + `ops_stop_session.sh day` + 重启（`:133-138`）。
  - rc=0/1 且 head ≤1（没收到启动快照）→ 判定登录/订阅失败，停会话 + 重启（`:139-147`）。
  - head >100 → 正常（`:145`）。
- **重启后只激活 `RESTART_ACTIVATE_STRATEGIES`，默认 `92221 92222`**（`:29,99-101`）。**不激活 92204**。

**关键缺陷（V 逻辑，I 影响）**：

1. `start_and_activate()` 在**开始动作前**就写 `date +%s > COOLDOWN`（`:88`）。如果 08:55 这次拉起失败（例如 CTP 仍未就绪、`ErrorID=7`），08:55 写入的冷却会让 **09:00 的第二次机会直接 `[SKIP]`**（300s < 600s）。09:00 那次“抢开盘”被 08:55 自己挡住。
2. 脚本**没有 flock**。08:55 的 `ops_start_session` 若超过 5 分钟（ORS 启动 + 30s 等待 + 8s 激活），09:00 会并发再跑一次，可能触发“停残留 ORS → 再拉起”的竞态。
3. `start_and_activate()` 调 `ops_stop_session.sh`，而后者会先跑 `ops_eod_report.sh`（`ops_stop_session.sh:33-36`），再 `stop_all.sh`，再 `sync_data_back.sh`。**为了重启 ORS，会写一份当天的“日终快照”、把 deploy 侧 `daily_init/position.csv` 回灌 data_cpp**。这不是轻量重启，副作用要知情。
4. 如果 `check-md` 不存在，直接 `[WARN] 跳过`，不告警（`:124-127`）。
5. 探针输出用 `sed -n 's/.*head \([0-9][0-9]*\) ->.*/\1/p'` 解析（`:130`）。若 `check-md` 输出格式变化，`HEAD` 为空 → 被当作 ≤1 → 误重启。

#### 2.2.3 人工开盘前检查单（只读）

```bash
cd /root/quantlink-trading

# 1) 交易日历（外层门控）
./scripts/is_trading_day.sh --today; echo "rc=$?"
tail -3 data_cpp/data/trading_days.txt
tail -3 deploy_cpp/data/trading_days.txt   # 内层 start_all 可能读这份

# 2) git 漂移（只应看到 daily_init / position.csv 或干净）
git status --porcelain

# 3) 磁盘 / inode
df -h /
df -i /

# 4) 策略读的硬编码路径（应全是软链，指向 data_cpp/data）
ls -l /home/hft/tbdata

# 5) 进程（开盘前应为空；若已有 ORS，先判断是不是残留）
pgrep -a -x ors_server
pgrep -a -x TradeBot
pgrep -a -x AdminLoop
pgrep -a -x AgentLoop
pgrep -a -x memlog-reader

# 6) SHM（开盘前应为空；启动后应出现 0x315/0x1001/0x2001/0x3001）
ipcs -m | egrep '0x00000315|0x00001001|0x00002001|0x00003001'

# 7) 端口（tbadmin / dashboard / Flask）
ss -tlnp | egrep '28080|28081|9980|9981|8882|5004'
```

**通过标准**：

- `is_trading_day --today` rc=0；两份日历都包含今天。
- `git status` 只允许 `daily_init`/`position.csv` 的运行时改动，或干净。
- `/home/hft/tbdata/{fee.csv,contractfile,sections.csv,trading_days.txt,...}` 都是软链，`readlink -f` 指回 `data_cpp/data/`（`ops_install_deps.sh:42-68`）。
- 无残留 ORS/TradeBot；若发现残留，先 `ops_stop_session.sh day`（它会等 ORS 退出）再启动。

### 2.3 开盘（09:00–09:05）

1. **09:01 `check-md` 启动**：`ops_check_md.sh start` 先跑日历门控；若 `check-md.pid` 活着或 `pgrep -x check-md` 命中则跳过；否则 `nohup ./check-md -config ./config/check-md.yaml`（`ops_check_md.sh:26-44`）。
2. **09:05 自动激活**：crontab 行是 `is_trading_day --today && ops_tb_signal.sh 92221 activate && ops_tb_signal.sh 92222 activate`（`ops/crontab.txt:46`）。
   - 只激活 `92221/92222`，**不激活 92204**。
   - 如果策略未运行，`ops_tb_signal` 输出 `[SKIP] 未运行` 并返回 1；整条 `&&` 链会中断，但 cron 不关心。
   - `ops_tb_signal` 用 `/proc/<pid>/cmdline` 精确匹配 `--strategyID <sid>`（`ops_tb_signal.sh:82-98`），不会把 `92201` 误配到 `922010`。
3. **92204 必须人工激活**（如果当天要交易 92204）：

```bash
cd /root/quantlink-trading/deploy_cpp/bin
./scripts/tbstart 92204
# 或
/root/quantlink-trading/scripts/ops_tb_signal.sh 92204 activate
```

4. **验证激活**：

```bash
# 进程
pgrep -af -- '--strategyID 92204'
# 日志（注意 UTC）
tail -50 deploy_cpp/bin/log/log.control.*.92204.$(date +%Y%m%d) | egrep 'Strategy is active now|Control File|daily_init|MAX LOSS|STOPLOSS'
# Dashboard（190 用 28080）
curl -s http://127.0.0.1:28080/api/strategies | python3 -m json.tool | head -40
```

**通过标准**：日志出现 `Strategy is active now.`；Dashboard `active=true`；只有一个 92204 进程；没有重复 `--strategyID`。

### 2.4 盘中（09:05–11:30 / 13:30–15:00）

#### 2.4.1 自动看护

- **`ops_md_liveness_watchdog.sh` 每 5 分钟**，只在 `09:05-11:25` 与 `13:35-14:55` 动作（`ops_md_liveness_watchdog.sh:68-71`）。
- 交易日门控（`:78-86`）；ORS 不在跑 → 冷却外拉起 + 激活 92221/92222（`:90-115`）。
- ORS 启动 <180s → 预热，跳过（`:117-123`）。
- 冷却 1800s（`:126-133`）。
- `check-md -probe -probe-wait 15s`：
  - rc=0 → 行情在流。
  - rc=2 → attach 失败，告警但**不重启**（`:153-157`）。
  - rc=1 → 15s 内 head 无增长 → 判定 CTP 连接静默死亡 → 停会话 + 重启（`:158-196`）。
- 重启后只激活 92221/92222，**不激活 92204**（`:192-194`）。

#### 2.4.2 人工巡检（建议每 30 分钟）

```bash
cd /root/quantlink-trading

# 进程数量（不是“有没有”）
pgrep -c -x ors_server
pgrep -c -x TradeBot
pgrep -a -x AdminLoop
pgrep -a -x AgentLoop
pgrep -a -x memlog-reader
pgrep -a -x check-md
pgrep -a -x md-recorder

# CTP 连接是否 CLOSE-WAIT（D15 的典型形态）
ss -tnp state close-wait | egrep 'ors_server|:41205|:34205' || true

# ORS 最近日志
tail -50 deploy_cpp/bin/log/ors_server.$(date +%Y%m%d).log | \
  egrep 'OnFrontConnected|OnFrontDisconnected|login failed|ErrorID|Position query|POSITION MISMATCH|POSITION STALE|RECVMD|CTP:'

# 策略最近日志（UTC）
for f in $(ls -t deploy_cpp/bin/log/log.control.*.$(date +%Y%m%d) 2>/dev/null | head -5); do
  echo "== $f"
  tail -20 "$f" | egrep 'Strategy is active now|Squareoff|HandleSquareoffNow|REJECT LIMIT|RMS Reject|Error in finding Transaction Charges|pos uneven|m_wating_stop' || true
done

# Dashboard 健康
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:28080/api/strategies

# 磁盘
df -h /
```

**通过标准**：ORS 1 个、TradeBot 数量等于当天应跑策略数、tbadmin 2 个、memlog 1 个、check-md 1 个；`/api/strategies` 返回 200；策略 `active=true`；无 `POSITION MISMATCH`/`POSITION STALE`/`REJECT LIMIT`；无 CLOSE-WAIT。

#### 2.4.3 午休（11:30–13:30）

- **不要重启 ORS**：`docs/STARTUP_GUIDE.md:365` 明确“午休 CTP `ReqQryInstrument` 会失败导致 ORS exit；只能重启 TradeBot 或等 13:00 后再启动 ORS”。
- `md_liveness` 在 11:25–13:35 不动作；`check-md` 的 `trade_windows` 也不含午休（`check-md.yaml` 的 `1030-1130`、`1330-1500`）。
- 午休没有行情是正常的；不要用“日志不动”判故障。

### 2.5 收盘（14:57–17:00）

#### 2.5.1 代码内建的收盘动作

- `ExecutionStrategy.cpp:44-47`：`m_endTime = endTime - 180000ms`；`m_endTimeAgg = endTime - 60000ms`。
- `PairwiseArbStrategy.cpp:903-904` 每 tick 调 `EndTimeAggEpich()` / `EndTimeEpoch()`。
- `EndTimeEpoch()`（`:970-1010`）：
  - 有未成交挂单 → 撤单/等在途，**不立刻平仓**。
  - 无挂单且 `netpos==0` → `HandleSquareoffNow()`。
  - 无挂单但 `netpos!=0` → `m_Active=false`，等 10 个 tick 后 `HandleSquareoffNow()`，并告警 `strategy pos uneven!`。
- `EndTimeAggEpich()`（`:951-968`）：到 `endTime-60s` 直接 `m_aggFlat=true` + `HandleSquareoffNow()`。
- `HandleSquareoffNow()`（`:1039-1056`）：取消所有未成交单、把两腿 `m_onExit/m_onCancel/m_onFlat=true`、`m_Active=false`、`SaveMatrix2("../data/daily_init.<sid>")`、上报状态。**它本身不发平仓单**。
- 结论：**收盘前“停手”是确定的；“平光”不是确定的**。`netpos!=0` 时可能带着单腿过夜，只留一条 `pos uneven` 告警（如果告警可达）。

#### 2.5.2 15:05 停会话

```bash
cd /root/quantlink-trading
./scripts/ops_stop_session.sh day
tail -100 deploy_cpp/bin/log/cron_stop_day.log
```

`ops_stop_session.sh` 的顺序（V）：

1. `ops_eod_report.sh day`（**必须在 stop_all 之前**，否则 memlog-reader 已停，Dashboard API 没了）（`ops_stop_session.sh:33-36`）。
2. `deploy_cpp/bin/scripts/stop_all.sh`（`:38`）。
3. `stop_all.sh` 内部：TradeBot `TERM` → 等 10s → `pkill -9 -f TradeBot`；memlog `TERM`/`pkill`；ORS `TERM` → 等最多 90s → `SIGKILL`；`ipcrm` 清当前用户全部 SHM；`rm .gateway_mode`；`sync_data_back.sh`（`build_deploy_cpp.sh:679-745`）。
   - **关键**：`SIGTERM` 的处理分支先打开 `./config/signal.txt`；文件不存在就直接 `return`，进程既不 squareoff 也不退出（`tbsrc/main/main.cpp:111-120`）。仓库里没有这个文件；190 上是否存在需确认。若不存在，`stop_all` 的 `TERM` 等于空操作，10s 后就是 **SIGKILL**，不会写 `daily_init`。不要把“15:05 stop_all”当成优雅平仓。

#### 2.5.3 收盘后检查

```bash
cd /root/quantlink-trading

# 1) 进程应全部退出（tbadmin 例外，它不在 stop_all 里）
pgrep -a -x ors_server; pgrep -a -x TradeBot; pgrep -a -x memlog-reader; pgrep -a -x check-md; pgrep -a -x md-recorder

# 2) SHM 应清空（当前用户的全部 SHM）
ipcs -m | grep "$(whoami)" || true

# 3) 日终快照
ls -l deploy_cpp/report_bak/report_$(date +%Y%m%d)_day.txt
head -40 deploy_cpp/report_bak/report_$(date +%Y%m%d)_day.txt

# 4) 资金/持仓快照（15:16）
ls -l deploy_cpp/money_bak/money_$(date +%Y%m%d)_pm/

# 5) deploy → data_cpp 回灌
git status --porcelain
git diff --stat -- data_cpp/data/daily_init.* data_cpp/bin/live/data/position.csv

# 6) 15:20 git 同步结果
tail -40 deploy_cpp/bin/log/cron_git_sync.log
git log -1 --stat

# 7) 15:40 fee 刷新结果
tail -60 deploy_cpp/bin/log/cron_refresh_fee.log
ls -l deploy_cpp/bin/log/.fee_refresh.ok

# 8) 17:00 喂数结果
tail -60 deploy_cpp/bin/log/cron_feed_db.log
```

**通过标准**：

- 无 ORS/TradeBot/memlog/check-md/md-recorder 残留（tbadmin 可继续跑）。
- `position.csv` 的 mtime 应是 15:05 之后（ORS 正常 `Stop()` 会写）；若是开盘时间，说明 ORS 被硬杀，见 6.12。
- `daily_init.*` 与 `data_cpp` 一致（`diff` 为空），`git log` 有当天 `chore: day收盘同步...` 提交。
- `report_bak` 文件非空、行数合理；`money_bak` 有 `daily_init.*` + `position.csv`。
- `.fee_refresh.ok` 的 mtime 是当天 15:40 之后；`cron_feed_db.log` 末尾是 `ops_feed_db 完成`。

#### 2.5.4 如果收盘不平

1. **不要直接 `stop_all`**：`SIGTERM` 只有在 `./config/signal.txt` 存在且列出该品种时才触发 squareoff；否则 handler 直接返回，10s 后 `kill -9`，`daily_init` 不会写（`main.cpp:111-120`）。
2. 先 `tbstopall`（或 `tbstop <sid>`）触发撤单/停用；观察策略日志 `Squareoff is called` / `HandleSquareoffNow`。
3. 通过券商终端/App 查实际持仓；如果仍有单腿，**在券商终端手动平掉**。Dashboard 的 `manual_order.enabled` 是 `false`（`memlog-reader.yaml:18-19`），不能依赖页面下单。
4. 平掉后再 `ops_stop_session.sh day`。
5. 若已过 15:05，先停会话再人工平仓也可以，但必须保证 `daily_init` 与实际一致（见 6.6）。

### 2.6 夜盘（当前停用）

#### 2.6.1 现状

- 夜盘受管块整体被注释（`ops/crontab.txt:923-939`）；`ops_night_session.py status` 会显示“已关闭”。
- 但以下**不在受管块里**的夜盘相邻任务仍生效：
  - `21:01 ops_check_md.sh start`
  - `21:35 ops_watchdog_memlog.sh`
  - `02:30 ops_check_md.sh stop`
  - `02:50 ops_stop_md_recorder.sh`
- 这些任务在“夜盘不跑”时可能空跑：`check-md` 没有 ORS/SHM 可 attach；`delta_snapshot` 连 8882 可能失败但 stderr 被丢弃；`memlog` 可能拉起一个没有数据的 Dashboard。**这是已知噪音源**（V 逻辑/I 现场）。

#### 2.6.2 如果要重新开启夜盘

先做**前置检查**，再 `ops_night_session.py enable`：

1. **CPU 亲和唯一性**：`ops_setup_arbi.sh` 会遍历 `deploy_cpp/bin/config/config_CHINA.*.cfg`，对 `SHM_MD_RESP_THREAD_CPU_AFFINITY` 做全局唯一校验（`ops_setup_arbi.sh:45-58`）。当前仓库里 `92201=2` 与 `92221=2`、`92202=3` 与 `92222=3` 重复。虽然 92201/92202 已停用，脚本仍会因重复而 `exit 1`，**不生成 control 窗口**。开启夜盘前必须改成“只校验启用策略”或给启用策略分配唯一核。
2. **交易日历**：`is_trading_day.sh --night-ok` 会检查“今天是否交易日 + 下一交易日距今 ≤3 天”；节前夜盘自动取消（`is_trading_day.sh:77-101`）。
3. **夜盘合约/费率**：`fee.csv` 必须覆盖夜盘合约；`ops_refresh_fee` 在 15:40 跑，若失败则不写文件。
4. **CTP 会话**：日盘 ORS 必须已退出（`pgrep -x ors_server` 为空），否则 20:13 新 ORS 会双登录互踢。
5. **tbadmin**：20:28/20:30 重启是为了加载 20:30 `strategy_sync` 写入的策略表；如果跳过，admin 还是旧策略列表。
6. **夜盘 controls**：仓库 `controls/night/` 只有 `92201/92202/92204/92221/92222` 的一部分；`92201/92202` 已停用，实际夜盘可跑的策略要逐一确认。

开启命令（会改 crontab，先备份）：

```bash
crontab -l > /root/crontab_backup_$(date +%Y%m%d_%H%M%S).txt
cd /root/quantlink-trading
./scripts/ops_night_session.py status
./scripts/ops_night_session.py enable
./scripts/ops_night_session.py status
```

关闭：`./scripts/ops_night_session.py disable`。

> `ops_night_session.py normalize` 会**删掉块外匹配 `NIGHT_PATTERNS` 的行**再重建块（`ops_night_session.py:125-142`）。不要在没备份 crontab 的情况下跑。

### 2.7 非交易日 / 节假日

#### 2.7.1 哪些任务有日历门控

| 有门控 | 无门控 |
|---|---|
| `ops_start_session.sh`（外层） | `ops_feed_db.sh`（17:00） |
| `start_all.sh ctp`（内层，用 deploy/data 或 data_cpp 日历） | `ops_snapshot_daily_init.sh`（07:00） |
| `ops_check_md.sh start` | `ops_snapshot_money.sh`（11:46/15:16） |
| `ops_md_liveness_watchdog.sh` | `ops_sync_git.sh`（15:20） |
| `ops_preopen_check.sh` | `ops_rotate_logs.sh`（15:15） |
| `ops_check_status.sh` 的进程检查 | `ops_watchdog_memlog.sh`（09:35/13:35/21:35） |
| `ops_eod_report.sh` | `ops_ensure_tbadmin.sh`（9-11/13-15 每 5 分钟） |
| `ops_refresh_fee.sh` | `ops_delta_snapshot.py`（09:20/14:50） |
| | `tbadmin` 08:28/08:30 重启 |
| | `tbadmin/clear.sh` 15:30 |
| | `strategy_sync` 10:30/20:30 |
| | `ops_setup_arbi.sh`（若夜盘块开启） |

证据：`ops_start_session.sh:28-47`、`build_deploy_cpp.sh:546-575`、`ops_check_md.sh:26-30`、`ops_md_liveness_watchdog.sh:78-86`、`ops_preopen_check.sh:66-75`、`ops_check_status.sh:138-140`、`ops_eod_report.sh:63-78`、`ops_refresh_fee.sh:69-80`；无门控项见各自脚本。

#### 2.7.2 节假日预期状态

- ORS/TradeBot/memlog/check-md/md-recorder 不应有（除非被无门控任务拉起）。
- tbadmin admin/agent 可能被 08:28/08:30 和 `ops_ensure_tbadmin` 拉起；这是正常的“监控空转”。
- `ops_check_status` 00:00 仍会跑：它只跳过“进程存在性”检查（`is_trading_day` 非 0），但 git/日历/fee/disk/daily_init/contractfile/preflight/fee 刷新检查仍会跑。
- `ops_feed_db` 仍会在 17:00 跑：如果没有当天 ORS dump，它会回退到最新的非空 dump，把旧合约写成 `trading_day=今天`（`ops_feed_db.py:75-110,265`）。这是**数据污染风险**，节假日应人工跳过或加门控。

#### 2.7.3 节假日人工检查

```bash
./scripts/is_trading_day.sh --today; echo "rc=$?"
pgrep -a -x ors_server; pgrep -a -x TradeBot
tail -20 deploy_cpp/bin/log/cron_feed_db.log
tail -20 deploy_cpp/bin/log/cron_check_status.log
```

不要因为“00:00 有 ALERT”就认为系统坏了；先看当天是否交易日、夜盘是否开启。

### 2.8 每日必须人工确认的 7 件事

| # | 事项 | 命令/判据 | 失败动作 |
|---|---|---|---|
| 1 | 日历覆盖今天/下一交易日 | `is_trading_day.sh --today` rc=0；`tail` 两份 `trading_days.txt` | 补日历；否则 `start_all` fail-closed |
| 2 | ORS 登录 + 持仓查询完成 | ORS 日志有 `Position query complete`、`Position query done, ORS ready`；`position.csv` mtime 是当天 | 不要交易；查 CTP 登录/ErrorID；见 6.1/6.12 |
| 3 | 92204 是否激活 | `pgrep -af -- '--strategyID 92204'`；日志 `Strategy is active now.`；Dashboard `active=true` | `tbstart 92204`；见 6.4 |
| 4 | 策略持仓 vs 券商 | `position.csv` / `daily_init.*` vs 券商 App；ORS 日志无 `POSITION MISMATCH`/`POSITION STALE` | 停策略，按 6.6 修正 |
| 5 | fee/合约预检 | `ops_check_status.sh` 检查项 8 无 `ALERT:`；手工 `python3 scripts/ops_f_contract_check.py` | 补 `fee.csv`/换月；否则策略 `exit(1)` |
| 6 | 磁盘/日志 | `df -h /`、`du -sh deploy_cpp/bin/log.bak ctp_flow.bak /home/u50_data` | 清最旧归档/核心转储；见 6.9 |
| 7 | 收盘快照/git | `report_bak`、`money_bak`、`git log -1`、`.fee_refresh.ok` | 手工重跑 `ops_eod_report`/`sync_data_back`/`ops_sync_git`；见 2.5.3 |

---

## 3. 健康模型

### 3.1 分层

| 层 | 问题 | 当前是否有自动检查 |
|---|---|---|
| L0 进程 | ORS/TradeBot/tbadmin/memlog/check-md/md-recorder 是否在 | 部分：`ops_check_status` 只看 4 类 + memlog；check-md/md-recorder 不在 |
| L1 行情 | MD SHM 是否在增长、CTP 是否静默断连 | 有：`check-md` + `ops_md_liveness_watchdog`（仅日盘窗口） |
| L2 订单/回报 | 报单是否被柜台接收、回报是否回流、挂单是否卡住 | **无自动检查**；只能看 Dashboard/日志 |
| L3 策略 | 策略是否 active、是否被风控停用、是否在报价 | 只有 Dashboard 展示；无“死进程显示运行中”的失效检测 |
| L4 数据正确性 | `position.csv`/`daily_init`/CTP 是否一致；fee/contractfile/日历是否有效 | 部分：fee/contractfile/日历有检查；持仓一致性**无自动检查** |
| L5 资源 | 磁盘、inode、CPU 亲和、内存、FD、NTP | 只有根分区 >90%（00:00）和 CPU 亲和（20:10，当前未生效） |
| L6 外部 | CTP 柜台、DB、git 远端、webhook、Dashboard/Flask | 只有 DB feed 失败告警；其余无 |

### 3.2 检查项详表（判据、覆盖、盲区）

| ID | 检查 | 实现/频率 | 判据 | 能抓到 | 抓不到/盲区 | 证据 |
|---|---|---|---|---|---|---|
| H1 | ORS 进程 | `ops_check_status.sh` 00:00；`ops_md_liveness` 5min；`ops_preopen` 08:55/09:00 | `pgrep -x ors_server` 有 PID | 进程不存在/启动失败 | 僵尸、挂起、重复、错误二进制、14:55 后崩溃 | `ops_check_status.sh:159-166`、`ops_md_liveness_watchdog.sh:90`、`ops_preopen_check.sh:107` |
| H2 | TradeBot 进程 | `ops_check_status.sh` 00:00 | `pgrep -x TradeBot` **有任意一个** | 全部策略都没了 | 4 个死 3 个仍通过；挂起；重复；错误 SID | `ops_check_status.sh:159-166`；`ops/crontab.txt:196-203` 明确记录该缺陷 |
| H3 | tbadmin admin/agent | `ops_check_status.sh` 00:00；`ops_ensure_tbadmin` 5min | `pgrep -x AdminLoop/AgentLoop`；pid 文件 | 进程不存在 | 挂起；pid 文件丢失导致重复；DB 故障导致的崩溃循环 | `ops_check_status.sh:155-166`、`ops_ensure_tbadmin.sh:13-21` |
| H4 | memlog-reader | `ops_check_status.sh` 00:00；`ops_watchdog_memlog` 09:35/13:35/21:35 | `pgrep -x memlog-reader`；不存在才拉起 | 进程不存在 | 挂起；端口被占导致启动失败；Dashboard API 返回陈旧数据 | `ops_watchdog_memlog.sh:19-44` |
| H5 | `check-md` 进程 | 无看门狗 | 无 | 无 | 进程死了没人知道；21:01 启动后可能空跑 | `ops_check_md.sh:35-44`（只有启动时查重） |
| H6 | `md-recorder` 进程 | 无看门狗 | 无 | 无 | 进程死了没人知道；录制缺失不影响交易 | `ops_start_md_recorder.sh:31-44` |
| M1 | 行情断流（独立检测） | `check-md` 09:01–15:30（配置含夜盘 21:00–02:30）；`stale_sec:5`、`alert_interval_sec:60` | MD SHM head 5s 不增长 | 柜台静默断连、ORS 不写 MD | `check-md` 自身死亡；午休/非交易时段；SHM attach 失败只告警；head 在涨但数据陈旧 | `data_cpp/bin/config/check-md.yaml`（`stale_sec:5`、`alert_interval_sec:60`、`trade_windows`） |
| M2 | 行情活性（看门狗） | `ops_md_liveness_watchdog` 每 5 分钟，15s 探针 | 15s 内 head 无增长 | 静默断连；ORS 不在跑 | 09:00–09:05、11:25–13:35、14:55–15:00、夜盘；探针只看 head 增量，不看时间戳；`check-md` 缺失时跳过 | `ops_md_liveness_watchdog.sh:68-71,148-165` |
| O1 | 订单/回报流 | **无** | 无 | 无 | 报单无回报、柜台拒单、挂单卡死、REQ/RSP 队列满 | 只能人工看 Dashboard/日志；见 6.5 |
| D1 | DB feed | `ops_feed_db.sh` 17:00；失败发 webhook | 脚本退出码/日志 `[ALERT]` | 脚本异常、无 dump、全 0 字节 dump | 部分/空 dump 导致的“成功但数据坏”；DB 之后挂了；行数/新鲜度无人校验 | `ops_feed_db.py:75-110,265,306` |
| D2 | DB 可用性 | **无** | 无 | 无 | PG 挂了；tbadmin 启动崩溃；strategy_sync/feed 失败 | 见 6.8 |
| R1 | 磁盘 | `ops_check_status` 00:00 | `df /` 使用率 >90% | 根分区满 | 盘中涨满；inode；其他挂载点；核心转储；`/home` 单独盘 | `ops_check_status.sh:173-177` |
| R2 | CPU 亲和 | `ops_setup_arbi` 20:10（当前夜盘块注释，未生效） | 每个 `config_CHINA.*.cfg` 的 affinity 唯一 | 重复配置 | 只校验不应用；白天启动不校验；停用策略也参与导致误报 | `ops_setup_arbi.sh:45-58` |
| R3 | 日志新鲜度 | **无** | 无 | 无 | 进程活着但不再写日志（挂起/死锁） | 无 |
| S1 | 策略状态 | Dashboard `m_running`/`m_active` | memlog 最后一条状态 | 人工可见 | 进程死后没有新消息，面板仍显示 `running=true`（crontab 已记录） | `ops/crontab.txt:725`；`ExecutionStrategy.cpp:449-460` |
| S2 | 持仓/PnL 一致性 | 日终 `ops_eod_report` 快照；无实时对账 | 报告文本 | 人工复盘 | 盘中偏差；`position.csv` 时点性；`daily_init` 不自动修正 | `ops_eod_report.sh:108-143`、`ORSServer.cpp:207-233` |
| T1 | NTP/时钟 | 06:00 `chronyc makestep` | 无检查 | 无 | 时钟漂移；chrony 未运行 | `ops/crontab.txt:39` |
| G1 | git 同步 | 15:20 `ops_sync_git` | 只在日志里 | 无 | push 失败；远端分叉；本地 commit 堆积 | `ops_sync_git.sh:25-38` |

### 3.3 故障 × 检查矩阵

图例：✓ 能自动发现；△ 部分/有延迟；✗ 不能。

| 故障 | H1 进程 | H2 策略进程 | M1/M2 行情 | O1 订单流 | D1/D2 DB | R1 磁盘 | S1 状态 | 人工 |
|---|---|---|---|---|---|---|---|---|
| ORS 崩溃 | ✓（窗口内） | ✗ | ✓/△ | ✗ | — | — | △ | ✓ |
| ORS 挂起（进程在） | ✗ | ✗ | ✓（head 不增） | ✗ | — | — | △ | ✓ |
| CTP MD 静默断连 | ✗ | ✗ | ✓ | ✗ | — | — | ✗ | ✓ |
| CTP 交易会话断（MD 正常） | ✗ | ✗ | ✗ | ✗ | — | — | ✗ | ✓ |
| TradeBot 崩溃 | ✗ | ✓（仅全灭） | ✗ | ✗ | — | — | △（陈旧 true） | ✓ |
| TradeBot 挂起 | ✗ | ✗ | ✗ | ✗ | — | — | △ | ✓ |
| 策略未激活 | ✗ | ✓（进程在） | ✗ | ✗ | — | — | ✓（active=false） | ✓ |
| 挂单卡死 | ✗ | ✗ | ✗ | ✗ | — | — | △ | ✓ |
| 持仓不一致 | ✗ | ✗ | ✗ | ✗ | — | — | ✗ | ✓ |
| SHM 满/损坏 | △ | △ | ✓（attach/断流） | ✗ | — | — | ✗ | ✓ |
| DB 挂 | — | — | — | — | △（feed 失败） | — | △（tbadmin） | ✓ |
| 磁盘满 | △（进程可能崩） | △ | △ | ✗ | △（PG 写失败） | ✓（仅 00:00） | ✗ | ✓ |
| 重复 ORS | ✗ | — | △ | — | — | — | — | ✓ |
| 错账户/错策略 | ✗ | — | — | ✗ | — | — | △ | ✓ |
| `position.csv` 陈旧 | — | — | — | — | — | — | — | ✓ |

### 3.4 为什么这些检查会漏（逐条）

1. **检查时点不对**：主检查 00:00；夜盘停用后这是“非交易时段”，进程检查却因为 `HHMM<=230` 仍判为交易时段（`ops_check_status.sh:141-144`），于是对 ORS/TradeBot/memlog 报缺失。真正的盘中 09:00–15:00 没有周期性 `ops_check_status`。
2. **只看“有没有”，不看“几个/哪个”**：`pgrep -x TradeBot` 只要有一个就过（`ops_check_status.sh:159-166`）；4 个策略死 3 个不报警。crontab 自己在 `:196-203` 记录了旧 `check_PB` 的逐策略检查被退役后留下的缺口。
3. **进程存在 ≠ 在工作**：挂起、死锁、线程卡住、SHM attach 失败，`pgrep` 都过。`ops_md_liveness` 能补一部分，但只在日盘两个窗口。
4. **面板会“冻结在 true”**：TradeBot 死后没有新 MemLog 消息，前端只读最后状态，`m_running` 仍是 true（`ops/crontab.txt:725`）。
5. **日志检查被轮转打断**：`ops_check_status` 检查项 3 在 00:00 读 `log/log.control.*`，但 15:15 已把它们搬到 `log.bak/`（`ops_rotate_logs.sh:35-61`）。在当前**夜盘停用**状态下，00:00 的 `log/` 里没有策略日志，所以费率失败检查实际是空循环；如果夜盘重新开启（20:13 启动新日志），这条才恢复。
6. **check-md 自己没人看**：`ops_check_md.sh` 只在启动时查重，没有看门狗；它死了，M1 整条断。
7. **md_liveness 只看 head 增量**：head 在涨但数据是旧快照/重复包，它判“正常”；CTP 交易会话断但 MD 仍在，它完全看不到。
8. **没有订单/回报心跳**：O1 完全空缺；报单被拒/无回报/挂单卡死只能人工看。
9. **磁盘只在 00:00 查**：盘中日志/核心转储把盘吃满，最早也要到次日 00:00 才知道；inode 不查。
10. **DB 没有可用性检查**：feed 失败只在 17:00 发一次；PG 在盘中挂掉，tbadmin 可能崩溃循环，TradeBot 若无 DSN 继续跑，没人知道。
11. **告警默认静默**：所有 `[ALERT]` 在 webhook 为空时只写日志；这不是“检查不到”，是“检查到了没人知道”。
12. **冷却/窗口互相打架**：preopen 的 600s 冷却会让 08:55 失败后的 09:00 直接跳过；这是“检查逻辑自己制造的盲区”。
13. **重复/错误进程没有基线**：没有“期望策略集合”的运行态对账（旧 `adminStatus.py` 的职能已退役）；`ops_check_status` 不知道今天应该跑哪几个 SID。
14. **`position.csv` 被当成实时源**：它是时点文件；盘中快照/人工检查若拿它当真相，会得出错误结论。
15. **预检脚本自身失败不告警**：`ops_check_status` 检查项 8 只把 `ALERT:` 行转成告警；如果 `ops_f_contract_check.py` 自己崩溃/缺 python，输出的是 traceback，脚本只打印一行 `[INFO] 检查项 8 退出码 ...`（`ops_check_status.sh:270-286`），不会告警。也就是说“预检器坏了”和“预检通过”在告警层看起来一样安静。

### 3.5 最小改进（不要求改代码）

如果只能加三样东西，按优先级：

1. **一个“期望策略集合 vs 实际进程/active 状态”的逐策略对账**：从 `data_cpp/bin/config/strategies.disabled` + `controls/{day,night}` 生成期望 SID 集合，然后 `pgrep -af -- '--strategyID'` 求差集；每 5 分钟，交易时段内跑。直接补上 H2/S1 的最大缺口。
2. **订单/回报心跳**：用 ORS 日志的 `OnRtnOrder`/`OnRspOrderInsert` 计数或 Dashboard `/api/orders` 的更新时间；交易时段内 60s 无变化就告警。补 O1。
3. **把告警重新接上并分级**：webhook + 至少 P0/P1 的区分；P0 重复提醒直到确认。否则前面两项加了也没人知道。

---

## 4. 监控与告警

### 4.1 数据链：MemLog → tbadmin → 前端 / Dashboard

```text
TradeBot ──写 SHM 789 (MemLog)──> memlog-reader ──HTTP /api/strategies──> ops_eod_report / 人工
    │                                   └── :28080/:28081 Dashboard（黑盒）
    └──写 SHM 789──> tbadmin agent ──ZMQ 9981──> tbadmin admin ──> 前端 (Flask :8882 / Vue)
                                                   │
                                                   └──读 dbtrade.tbhft_strategy（启动时）
```

- TradeBot 每 120s 至少上报一次策略状态（`ExecutionStrategy.cpp:449-460`）；成交/订单/PnL 另有上报。
- tbadmin agent 读 `MEMLOG_LIST=789`、`RSP_Q_LIST=12289`、`MD_LIST=4097`（`tbadmin/cfg/agent.cfg`）。
- admin 在启动时读 `tbhft_strategy where active=1`（`admin.cpp:595-606`），所以**策略表变更必须重启 admin 才生效**。
- `memlog-reader` 和 tbadmin 是两条并行消费链：Dashboard 挂了不影响 tbadmin 前端；反之亦然。
- `ops_eod_report.sh` 只依赖 `memlog-reader` 的 `/api/strategies` 和 `/api/orders`（`ops_eod_report.sh:108-122`），不依赖 tbadmin。

### 4.2 告警通道

| 项 | 事实 | 证据 |
|---|---|---|
| 主通道 | 企微机器人 webhook，HTTP POST JSON | `ops_preopen_check.sh:35-54`、`ops_md_liveness_watchdog.sh:44-63` |
| 配置来源 | `ops/db.conf` 的 `WECHAT_WEBHOOK`；`ops/db.conf` gitignored | `ops/db.conf.example:11-15`、`.gitignore:101` |
| 默认状态 | 2026-11-09 起“全部 webhook 推送已取消，默认留空”；留空时所有脚本只写日志 | `ops/db.conf.example:12-15` |
| 读取方式 | 有的脚本 `source` 整个 `db.conf`（check_status/setup_arbi/check_md），有的只 `grep` 一行（watchdog/eod/refresh_fee），避免把 DB 凭据带进环境 | `ops_check_status.sh:30`、`ops_setup_arbi.sh:26`、`ops_check_md.sh:21`、`ops_watchdog_memlog.sh:29-32`、`ops_eod_report.sh:39-41`、`ops_refresh_fee.sh:129-131` |
| check-md | 优先 `webhook_url`（配置），为空回退 `CHECK_MD_WEBHOOK` 环境变量（由 `ops_check_md.sh` 注入） | `check-md.yaml`、`ops_check_md.sh:19-22` |
| 当前工作区 | `ops/db.conf` 存在，但 `WECHAT_WEBHOOK` 的值不是 `https://` URL；按“未启用”处理 | `ls -l ops/db.conf`（644）；值不在此复制（V/I） |
| 其它通道 | `memlog-reader` 的 `feishu.secret_file`（可选）；`tbadmin` 前端无推送 | `memlog-reader.yaml:15-16`；`STARTUP_GUIDE.md:128-131` |

### 4.3 各脚本告警行为表

| 脚本 | 触发 | 消息格式 | 去重/冷却 | 是否执行动作 | 证据 |
|---|---|---|---|---|---|
| `ops_check_status.sh` | 9 个检查项任一 `alert` | Markdown，聚合为一条，`<font color="warning">` | 无（每天一次） | 否 | `:40-52,348` |
| `ops_preopen_check.sh` | ORS 缺失/登录未完成/attach 失败 | 纯文本 | 600s cooldown 文件 | 是（拉起/重启） | `:35-54,78-104` |
| `ops_md_liveness_watchdog.sh` | ORS 缺失/15s 无行情 | 纯文本 | 1800s cooldown 文件 | 是（停/启会话） | `:44-63,126-196` |
| `check-md` | MD SHM 5s 不增长 | 纯文本（Go 内部） | 60s throttle | 否（只告警） | `check-md.yaml` |
| `ops_refresh_fee.sh` | fee_refresh 非 0 | Markdown | 无 | 否（已尝试刷新） | `:127-147` |
| `ops_feed_db.py` | 无 dump/全 0 字节/DB 异常 | Markdown | 无 | 否 | `:57-68,94-103,306` |
| `ops_eod_report.sh` | Dashboard 非 200/空/渲染失败 | Markdown | 无 | 否 | `:48-57,108-143` |
| `ops_setup_arbi.sh` | CPU 亲和冲突 | Markdown | 无 | 退出，不生成 control | `:36-58` |
| `ops_watchdog_memlog.sh` | 无告警；只写 `cron_watchdog.log` | — | — | 拉起 memlog | `:19-44` |
| `ops_ensure_tbadmin.sh` | 无告警；只写 `tbadmin/log/ensure.log` | — | — | 拉起 agent/admin | `:13-25` |
| `ops_sync_git.sh` | 无告警；只写 `cron_git_sync.log` | — | — | commit/push | `:25-38` |
| `ops_snapshot_*.sh` | 无告警；只写日志 | — | — | 复制 | `ops_snapshot_money.sh:43`、`ops_snapshot_daily_init.sh:34-36` |
| `ops_rotate_logs.sh` | 无告警；只写 `log.bak/cron_rotate.log` | — | — | mv | `:27-72` |
| `tbadmin` 前端 | 无推送；只显示 | — | — | 可发控制命令 | `admin.cpp`、`message_forwarding.py` |

### 4.4 告警严重级别（当前没有，建议这样分）

当前所有告警都是**同一条通道、同一种橙色 warning**，没有 P0/P1、没有 @人、没有升级。复刻时建议至少分四级：

| 级别 | 定义 | 例子 | 期望响应 |
|---|---|---|---|
| P0 | 资金/持仓/账户安全受威胁 | 重复 CTP 登录；持仓与柜台不一致；错账户/错策略下出单；ORS 在持仓未平的情况下消失；磁盘 >95% 且 DB/日志写失败 | 立即人工；电话/电话升级；停止新单 |
| P1 | 交易能力受损，但资金尚未受损 | ORS 盘中崩溃；MD 静默断连；策略全部未激活；fee/contractfile 导致次日无法启动；日历过期；磁盘 >90% | 15 分钟内处理 |
| P2 | 监控/数据能力受损 | tbadmin/memlog 挂；DB feed 失败；git push 失败；eod 快照失败；单策略未激活 | 当日处理 |
| P3 | 记录/整洁性问题 | 日志轮转失败；delta 快照失败；`clear.sh` 未跑；money 快照缺一份 | 次日处理 |

建议把 P0/P1 与 P2/P3 分开发送（不同 webhook 或不同前缀），并在 P0 上重复提醒直到人工确认。当前脚本没有“确认”概念。

### 4.5 静默、去重、升级

- **全局静默**：`WECHAT_WEBHOOK` 为空 → 所有脚本只写日志。这不是“某个告警被静音”，是“所有告警被静音”。复刻时不要把“没有告警”当成“没有问题”。
- **冷却**：
  - `ops_preopen_check.sh`：600s；见 2.2.2 的 08:55/09:00 冲突。
  - `ops_md_liveness_watchdog.sh`：1800s。
  - `check-md`：`alert_interval_sec:60`。
- **无计划静默**：没有“午休静音”“收盘后静音”“维护窗口”的概念；靠 `trade_windows`/`HHMM` 窗口硬编码。
- **无升级**：没有 on-call、没有电话、没有“未确认重复”。单条 webhook 失败只写 `[WARN]`。
- **聚合风险**：`ops_check_status` 把 9 项塞进一条 markdown；企微对消息长度有限制，太多告警可能被截断/拒收；脚本没有拆分。
- **告警可达性验证**：`ops_install_deps.sh:94-105` 会发一条测试消息，但只在引导时跑一次；之后没有心跳。`docs/test/2026-10-12_上线测试清单_国盛柜台.md:71` 明确要求实盘前重测 webhook。

### 4.6 告警自检（不泄露 URL）

```bash
# 1) 只用长度/前缀判断是否配置，不打印值
awk -F= '/^WECHAT_WEBHOOK=/{print "configured=" (length($2)>0), "is_https=" ($2 ~ /^https:\/\//)}' \
  /root/quantlink-trading/ops/db.conf

# 2) 用一个临时测试 webhook（不要用生产群）验证脚本能发
#    临时覆盖环境变量，跑一个不会改系统的检查
WECHAT_WEBHOOK='https://example.invalid/test' \
  /root/quantlink-trading/scripts/ops_check_status.sh
#    预期日志出现 [ALERT] 且 curl 失败时 [WARN] webhook 发送失败

# 3) 恢复：不要修改 db.conf；脚本退出后环境变量即失效
```

> 不要 `cat ops/db.conf`、不要把 webhook 贴到聊天/工单。`ops/db.conf` 当前是 644，发现后应 `chmod 600`。

### 4.7 监控盲区清单（按影响排序）

1. **无逐策略对账**：死一个策略不报警；面板还可能显示运行中。
2. **无订单/回报心跳**：挂单卡死、柜台拒单、回报断流只能人工发现。
3. **无交易会话检查**：MD 正常但交易登录断，所有检查都过。
4. **告警默认静默**：所有检查等于“只写日志”。
5. **无 DB 可用性/新鲜度检查**：feed 只证明“脚本跑过”，不证明“数据对”。
6. **无盘中磁盘/inode 检查**：只在 00:00 看根分区。
7. **无日志新鲜度**：进程活着但不写日志（挂起/死锁）无法发现。
8. **check-md/md-recorder 无看门狗**：检测器自己死了没人知道。
9. **无 NTP 校验**：校时命令失败/chrony 未运行无人知道。
10. **无 git 同步校验**：push 失败只写日志，`daily_init` 可能没上远端。
11. **无持仓一致性自动对账**：`position.csv`/`daily_init`/CTP 三方差异只能人工看。
12. **夜盘停用后的残留任务**：21:01 check-md、21:35 memlog 可能制造噪音。

---

## 5. 日志

### 5.1 路径、写入方、内容、轮转

| 路径 | 写入方 | 内容 | 轮转/保留 |
|---|---|---|---|
| `deploy_cpp/bin/log/ors_server.<YYYYMMDD>.log` | `start_ors.sh` 重定向 | CTP 连接/登录/持仓查询/订单/回报/RMS/错误；含 `POSITION MISMATCH`/`POSITION STALE` | 15:15 `ops_rotate_logs` → `log.bak/<date>/`；无删除 |
| `deploy_cpp/bin/log/log.<control_basename>.<YYYYMMDD>` | TradeBot | 策略启动参数、control/model、订单/成交、PnL、squareoff、风控、DSN（若配置） | 同上 |
| `deploy_cpp/bin/log/nohup.<control_basename>.<YYYYMMDD>` | `start_strategy.sh` | TradeBot stdout/stderr（崩溃栈） | 同上 |
| `deploy_cpp/bin/log/memlog-reader.<YYYYMMDD>.log` | `start_all`/watchdog | Dashboard 启动/错误 | 同上 |
| `deploy_cpp/bin/log/check-md.<YYYYMMDD>.log` | `ops_check_md.sh` | check-md 的告警/attach 错误 | 同上（15:15 时进程可能还在写，文件被 mv，inode 不断） |
| `deploy_cpp/bin/log/md-recorder.<YYYYMMDD>.log` | `ops_start_md_recorder.sh` | 录制器启动/flush/错误 | 同上 |
| `deploy_cpp/bin/log/cron_*.log` | 各 cron 包装 | `[INFO]/[WARN]/[ERROR]/[ALERT]`、退出码 | 15:15 → `log.bak/<date>/cron_*.log.<YYYYMMDD>` |
| `deploy_cpp/bin/log.bak/cron_rotate.log` | `ops_rotate_logs.sh` | 轮转自身日志 | **固定追加，不轮转** |
| `deploy_cpp/bin/ctp_flow/`、`ctp_flow/md/`、`ctp_flow/fee_refresh/` | CTP SDK | 原始 API 流（登录/报单/行情） | 15:15 → `ctp_flow.bak/`；**同名覆盖，只留最后一天** |
| `tbadmin/log/admin.log` | `start_admin.sh` | admin stdout/stderr（全量 debug） | 需手工装 `ops/logrotate/quantlink-tbadmin`；否则无限 |
| `tbadmin/log/agent.log` | `start_agent.sh` | agent stdout/stderr | 无轮转 |
| `tbadmin/log/ensure.log` | `ops_ensure_tbadmin.sh` | 拉起记录 | 无轮转 |
| `tbadmin/log/tbadmin_admin.log` | `admin.cfg` 的 `LOG_FILE` | C++ logger | 无轮转（与 admin.log 可能是两份） |
| `/var/log/quantlink/preopen_check.log` | `ops_preopen_check.sh` | 体检/告警/动作 | **无轮转** |
| `/var/log/quantlink/md_liveness.log` | `ops_md_liveness_watchdog.sh` | 探针/重启/告警 | **无轮转** |
| `/var/log/quantlink/strategy_sync.log` | cron `strategy_sync` | RDS → 本地同步 | **无轮转** |
| `/var/log/quantlink/tb_autoactivate.log` | cron 09:05 | 92221/92222 激活 | **无轮转** |
| `/var/log/quantlink/trading_days_check.log` | cron 每年 1/2 | 日历巡检 | **无轮转** |
| `/var/log/quantlink/delta_snapshot.log` | `ops_delta_snapshot.py` | Delta 快照 JSON | **无轮转** |
| `/var/log/ntpdate.log` | cron 06:00 | chrony 输出 | 系统 logrotate（视发行版） |
| `/tmp/admin.log`、`/tmp/agent.log`、`/tmp/flask.log`、`/tmp/vue3admin.log` | 手工启动脚本 | 启动输出 | 由 OS 清理；不在项目控制内 |

### 5.2 轮转机制

#### 5.2.1 `ops_rotate_logs.sh`（主轮转）

- 15:15 周一-五跑；前提是 15:05 已停会话（memlog/TradeBot/md-recorder 已停），但 **check-md 要到 15:30 才停**，所以它会在 15:15 被 mv（Linux 上打开的文件继续写旧 inode，不丢数据，但归档里会包含 15:15–15:30 的内容）。
- `log/*` → `log.bak/<文件名里的 8 位日期>/`；无日期后缀的用今天（`ops_rotate_logs.sh:35-52`）。
- 撞名加 `.2/.3`（`:53-57`）。
- `cron_*` 额外加 `.<今天>` 后缀（`:58-61`）。
- `ctp_flow/*` → `ctp_flow.bak/`，**没有日期子目录、没有撞名保护**（`:66-69`）。CTP flow 文件名每天相同，所以实际上每天覆盖，只保留最后一份。
- **不删除、不压缩、不异地**；`log.bak` 会一直增长。
- 轮转自身日志固定在 `log.bak/cron_rotate.log`，不参与轮转（`:27`）。

#### 5.2.2 `ops/logrotate/quantlink-tbadmin`

```text
/root/quantlink-trading/tbadmin/log/admin.log {
    daily
    size 500M
    rotate 3
    compress
    delaycompress
    copytruncate
    missingok
    notifempty
    dateext
}
```

- 只覆盖 `tbadmin/log/admin.log`；不覆盖 `agent.log`/`ensure.log`。
- `daily` + `size 500M` 同时出现时，logrotate 的实际行为取决于版本（通常 `size` 与 `daily` 互斥，后写的生效）；上线前用 `logrotate -d` 验证。
- `copytruncate` 适合不能重开文件的进程，但会丢“复制到 truncate”之间的几行。
- **仓库里没有任何脚本安装这个文件**（全文搜索无 `logrotate` 安装调用）。190 上是否已手工安装，需要现场确认（I）。

#### 5.2.3 无轮转的目录

- `/var/log/quantlink/*`：只增不减。
- `tbadmin/log/agent.log`、`ensure.log`、`tbadmin_admin.log`：只增不减。
- `/home/u50_data/*.csv`：只增不减（录制器运行时）。
- `deploy_cpp/daily_init_bak/`、`money_bak/`、`report_bak/`：只增不减。
- `core-*`：tbadmin 启动脚本设 `ulimit -c unlimited` + `kernel.core_pattern=core-%e-%p-%t`（`tbadmin/start_admin.sh:3-4`、`start_agent.sh:3-4`）；ORS 默认 `ulimit -c 0`（`build_deploy_cpp.sh:362`）。tbadmin 崩溃会产生大 core，可能吃满盘。

### 5.3 保留与磁盘估算

- `docs/RISK_NO_OFFSITE_BACKUP.md:58` 记录 2026-10-05 `log.bak/` 约 **791M**，其中大部分是迁移期一次性大文件（`ors_server-20260803-*.log` 416M、`ors_server-20260728-*.log` 147M 等）。
- 真实交易日增量约 **7–25 MB/天**；加上其它约 **50–60 MB/交易日**，一年 **13–15 GB**（同文档 `:144-148`）。
- 190 磁盘 178G，2026-10-05 时 46G used / 124G avail（同文档 `:30`）。按 60MB/天，理论可撑数年；但单次 ORS debug 日志可达数百 MB、tbadmin core 可达数百 MB，实际余量要看 `du`。
- 90% 检查只在 00:00；盘中无检查。**磁盘满的典型后果**：PG 写失败、`position.csv`/`daily_init` 写失败、ORS/TradeBot 日志写失败、SHM/临时文件失败。

### 5.4 常见故障的日志检索

> 策略日志是 UTC；ops 日志是 CST。下面命令默认在 `/root/quantlink-trading`。

```bash
# ORS：连接/登录/持仓/错误
tail -300 deploy_cpp/bin/log/ors_server.$(date +%Y%m%d).log | \
  egrep 'OnFrontConnected|OnFrontDisconnected|login failed|ErrorID|Position query|POSITION MISMATCH|POSITION STALE|ReqQryInstrument|CTP:|RECVMD'

# 策略：启动/激活/平仓/风控/费率
ls -t deploy_cpp/bin/log/log.control.*.$(date +%Y%m%d) 2>/dev/null | head
tail -300 <上面的第一个文件> | \
  egrep 'Control File:|Strategy is active now|Squareoff is called|HandleSquareoffNow|REJECT LIMIT|RMS Reject|Error in finding Transaction Charges|daily_init|pos uneven|MAX LOSS|STOPLOSS'

# tbadmin：DB/ZMQ/启动
tail -200 tbadmin/log/admin.log | egrep 'failed to init PostgresSql|initstlist failed|FATAL|zmq|Bind|connect'
tail -100 tbadmin/log/agent.log | egrep 'FATAL|shm|SHM|EINVAL|ENOENT'

# check-md / md-recorder
tail -100 deploy_cpp/bin/log/check-md.$(date +%Y%m%d).log
tail -100 deploy_cpp/bin/log/md-recorder.$(date +%Y%m%d).log

# cron 包装：所有告警/错误
egrep -H '\[ALERT\]|\[ERROR\]|\[WARN\]' deploy_cpp/bin/log/cron_*.log | tail -100

# 进程/内核层
dmesg -T | egrep -i 'oom|killed process|segfault|oracle|postgres' | tail -50
journalctl -u postgresql-16 --since today | tail -100
```

**注意**：

- 策略日志里混有 NUL（二进制 dump）；用 `tr -d '\0'` 再交给 bash 变量，否则某些工具会告警（`ops_check_status.sh:109` 已这么做）。
- 不要 `cat` 几百 MB 的 ORS 日志；用 `tail`/`rg`/`awk`。
- 先确认日志时区（UTC vs CST），再和告警时间对齐。
- 日志可能正在被写；取证前先 `cp` 一份，不要 `truncate`。

### 5.5 故障取证顺序

1. **先复制**：`cp -a log/ors_server.<date>.log /tmp/incident_<ts>/`；`cp -a log/log.control.*.<date>`；`cp -a ctp_flow/`（如果还没轮转）；`cp -a tbadmin/log/`。
2. **保留现场**：不要重启、不要清 SHM、不要删 `position.csv`/`daily_init`；先记录 `ps -ef`、`ipcs -m`、`ss -tnp`、`df -h`、`date`。
3. **再判断**：按第 6 章对应 playbook。
4. **最后才恢复**：恢复前把现场打包到 `log.bak/incident_<ts>/` 或 `/root/incident_<ts>/`（注意别把盘吃满）。
5. 记录：时间线、命令、日志片段、持仓/订单号、 broker 沟通记录。

### 5.6 日志中的 PII / 凭据

| 位置 | 风险 | 证据 |
|---|---|---|
| 策略日志 | 启动时打印 `DSN`，若配置了 DSN 则包含 DB 口令 | `ExecutionStrategy.cpp:72`（V 代码；实际是否非空取决于配置，I） |
| `config_CHINA.*.cfg` / `StrategyConfig.cfg` | tbadmin 生成配置时写入 `DSN=... password=<redacted>`，并 `chmod 0755` | `admin.cpp:1816,1825`（V） |
| tbadmin 源码 | `InitDb` 里硬编码了一组 DB 用户/口令（值不在此复制） | `admin.cpp:583`（V） |
| `ops/db.conf` | DB 口令 + 企微 webhook；当前 644 | `ls -l ops/db.conf`、`.gitignore:101`（V） |
| `ors_server.cfg` | CTP BrokerID/InvestorID/Password/AuthCode/AppID | gitignored；`STARTUP_GUIDE.md:88`（V） |
| `ctp_flow/` | CTP 原始 API 流，可能含登录/报单字段 | `ORSServer.cpp:132-145`（V 生成；内容 I，按敏感数据对待） |
| `log.bak/` | 上述日志的归档；目录 755，文件通常 644 | `ops_rotate_logs.sh:35-61`（V） |
| git 提交 | `daily_init.*` + `position.csv` 含持仓/均价 | `ops_sync_git.sh:25`（V） |
| `/root/quantlink-backups/` | CTP 凭据 `.bak`，与生产同盘 | `RISK_NO_OFFSITE_BACKUP.md:64`（V 文档） |
| `strategy_sync.env` | RDS/本地 DB 凭据；文档要求 600 | `ops/crontab.txt:66`（V 文档） |

**建议**：

- `chmod 600 ops/db.conf`；把 `ors_server.cfg`、`strategy_sync.env`、`feishu.secret.yaml` 同样收紧。
- 去掉 `ExecutionStrategy.cpp:72` 的 DSN 打印，或只在 debug 下打印并脱敏。
- 不要让 tbadmin 把 DSN 写进 `config_CHINA.*.cfg`；如果 TradeBot 不需要写 DB，直接留空 `DSN`，避免 squareoff 时 DB 连接失败阻断 `daily_init` 写入（见 6.8）。
- `log.bak/`、`ctp_flow.bak/` 权限收紧到 700/600；归档前考虑脱敏。
- 不要把 `ops/db.conf`、`ors_server.cfg`、`log.bak/` 上传到 git/对象存储的公共桶。

### 5.7 日志质量与“日志不可当活体探针”

- ORS 的异步 logger 会积压：2026-10-29 实测日志里的 `RECVMD` 计数十几分钟不落盘，实际已收 7861 条，日志只显示 5473（`ops_md_liveness_watchdog.sh:10-14`）。**所以 D15 的判活改用 MD SHM head，不读日志**。
- 同理，不能用“日志最后一行时间”判断进程是否在工作；要用 SHM/心跳/端口/DB。
- 策略日志只在有事件/tick 时写；午休不动是正常的。
- `ops_check_status.sh:110` 明确处理了策略日志里的 NUL；其它脚本/工具读日志时也要注意。

---

## 6. 故障处置 Playbooks

### 6.0 通用原则

1. **先保命，再保数据，再恢复交易**：有持仓异常时，先停止新单/撤单，再谈重启。
2. **一次只改一个变量**：不要同时重启 ORS、TradeBot、清 SHM、改配置。
3. **盘中不重启 TradeBot**（`.claude/CLAUDE.md` 铁律；`ops/crontab.txt:18`）：重启会把持仓计数器/均价重置为 `daily_init`，而 `daily_init` 不是实时值。
4. **不重复登录 CTP**：旧 ORS 未退出就起新 ORS，会让柜台静默踢掉先登录的 MD 连接，表现为“进程活着、全天零行情”（D15；`build_deploy_cpp.sh:339-345`、`ops_md_liveness_watchdog.sh:5-17`）。
5. **不清交易 SHM**：除非确认所有消费者/生产者都已退出。`stop_all` 会清当前用户全部 SHM（`build_deploy_cpp.sh:739`）。
6. **保留现场**：重启前复制日志、`ps`、`ipcs`、`ss`、`position.csv`、`daily_init`。
7. **记录时间线**：CST 与 UTC 都记；订单号/成交号/策略 SID 要留。
8. **升级**：P0 立即呼人；CTP 柜台问题联系券商；DB/主机问题联系平台；不要独自反复重试。

### 6.1 ORS 崩溃 / 启动失败

**症状**

- `pgrep -x ors_server` 为空；Dashboard 行情冻结；策略日志不再有新 tick；`md_liveness` 告警“交易时段内 ors_server 未运行”。
- ORS 日志末尾可能是 `login failed`、`ErrorID=7`、`4040`、`Position query failed`、`ORS ready` 缺失。

**检测**

```bash
pgrep -a -x ors_server
tail -100 deploy_cpp/bin/log/ors_server.$(date +%Y%m%d).log
tail -100 deploy_cpp/bin/log/cron_start_day.log
tail -50 /var/log/quantlink/preopen_check.log
tail -50 /var/log/quantlink/md_liveness.log
```

**止损**

- 如果 ORS 已死：不要再手工启动第二个；确认没有残留（`ps -ef | grep ors_server | grep -v grep`，包括僵尸）。
- 如果 ORS 还在但登录失败：不要重复 `kill/start` 风暴；CTP 对同账号频繁登录可能锁定/互踢。
- 如果策略还在跑：先 `tbstopall` 或逐策略 `tbstop`，避免它们在无行情下继续报价（`tbstop` 不保证平仓，见 6.6）。

**恢复**

```bash
cd /root/quantlink-trading
# 首选：走会话脚本（会等旧 ORS 退出、清 SHM、同步数据）
./scripts/ops_start_session.sh day
# 观察
tail -f deploy_cpp/bin/log/cron_start_day.log
tail -f deploy_cpp/bin/log/ors_server.$(date +%Y%m%d).log
```

**验证**

- ORS 日志出现 `OnFrontConnected` → `login` 成功 → `Position query complete` → `Position query done, ORS ready`。
- `position.csv` mtime 更新。
- `./check-md -probe -probe-wait 5s -config ./config/check-md.yaml` 返回 head 增长。
- `pgrep -c -x ors_server` = 1；`pgrep -c -x TradeBot` = 期望策略数。
- 人工激活 92204（以及其它需要交易的 SID）：`./scripts/tbstart 92204`，日志 `Strategy is active now.`。

**升级**

- 连续 5 次登录失败/`ErrorID=7`/`4040` → 联系券商确认柜台状态/前置地址/`PRODUCTION_MODE`；不要继续自动重启。
- `CRITICAL: Position query failed after 3 attempts, degraded startup with position.csv values`（`ORSServer.cpp:2032-2040`）→ **P0**：ORS 会带着 `position.csv` 旧值启动并置 `m_connected=true`，此时不能交易；必须重启/修 CTP 查询，直到看到 `Position query complete`。

**证据/注意**

- `start_ors.sh` 硬拒绝双启动（`build_deploy_cpp.sh:358-363`）。
- `stop_all.sh` 等 ORS 最多 90s，再 SIGKILL（`build_deploy_cpp.sh:710-737`）；不要提前清 SHM/起新实例。
- `ops_preopen`/`md_liveness` 自动重启只激活 92221/92222，不激活 92204。

### 6.2 CTP 行情静默断连（D15）

**症状**

- ORS 进程在、CPU 可能很低；Dashboard 行情/盘口不动；策略不再有 tick；日志可能没有 `OnFrontDisconnected`。
- `ss -tnp state close-wait` 看到 ORS 到 CTP 前置的连接处于 CLOSE-WAIT（柜台只发 FIN，API 不回调/不重连）。

**检测**

```bash
cd /root/quantlink-trading/deploy_cpp/bin
./check-md -probe -probe-wait 15s -config ./config/check-md.yaml; echo "rc=$?"
ss -tnp state close-wait | egrep 'ors_server|:41205|:34205' || true
tail -100 log/ors_server.$(date +%Y%m%d).log | egrep 'RECVMD|OnFrontDisconnected|CTP:'
```

`check-md -probe` 的退出码：0=有增长，1=15s 无增长，2=attach 失败（`ops_md_liveness_watchdog.sh:148-165`）。

**止损**

- 不要再发新单；`tbstopall` 停用策略（注意：不保证平仓）。
- 不要手工起第二个 ORS。

**恢复**

- 让 `ops_md_liveness_watchdog.sh` 自动处理（停会话 → 等 ORS 退出 → 启会话 → 激活 92221/92222）。
- 或手工：
  ```bash
  ./scripts/ops_stop_session.sh day
  # 等 pgrep -x ors_server 为空（stop_all 最多等 90s）
  ./scripts/ops_start_session.sh day
  ./scripts/tbstart 92204
  ```

**验证**

- `check-md -probe` rc=0；`ss` 无 CLOSE-WAIT；ORS 日志有新的 `RECVMD`/行情；Dashboard 时间戳更新；策略有 tick。
- 只有一个 ORS；没有双登录告警。

**升级**

- 同一交易日反复断流（>2 次）→ 联系券商查前置/网络；检查 ORS `API_LOG_DIR` 是否 MD/Trader 分开（D15 修复要求独立目录，`ORSServer.cpp:132-145`）。
- 如果断流发生在 14:55 后，`md_liveness` 不动作；人工决定是否重启（收盘前重启风险高，优先停手）。

**证据/注意**

- D15 根因与 2026-10-23/26/27/29 的连续零行情记录在 `ops_md_liveness_watchdog.sh:5-17`。
- `check-md` 的 `stale_sec:5`、`alert_interval_sec:60` 见 `check-md.yaml`。

### 6.3 TradeBot 崩溃 / 挂起

**症状**

- 某个 SID 的进程消失；或进程在但日志不再更新、Dashboard `running` 仍是 true（陈旧）、不再有报价/成交。
- 该 SID 的 `trader.<sid>.pid` 可能还在（崩溃）或还在但进程挂起。

**检测**

```bash
pgrep -af -- '--strategyID 92204'
ps -o pid,stat,etimes,pcpu,pmem,cmd -p <pid>
tail -100 deploy_cpp/bin/log/log.control.*.92204.$(date +%Y%m%d)
tail -100 deploy_cpp/bin/log/nohup.*.92204.$(date +%Y%m%d)
tail -50 deploy_cpp/bin/log/cron_start_day.log
```

**止损**

- 如果进程还在但挂起：先 `tbstop 92204`（发 SIGTSTP）尝试撤单/停用；若 handler 未就绪，SIGTSTP 默认会挂起进程（`ops_tb_signal.sh:25-27`），所以只在日志已出现 `Strategy is active now.` 后操作。
- 如果进程已死：**不要立即重启**。先确认它在柜台/ORS 侧还有没有挂单/持仓；TradeBot 死亡不会自动撤单。
- 有挂单 → 通过券商终端/管理面撤单；有持仓 → 记录并准备人工平仓。

**恢复（盘中）**

- 铁律是“盘中不重启 TradeBot”。如果必须恢复：
  1. 停掉该 SID 的所有残留进程。**不要依赖 `kill -TERM`**：它要求 `./config/signal.txt` 存在且列出该品种，否则 handler 直接返回（`main.cpp:111-120`）。优先 `tbstop <sid>`（SIGTSTP，不依赖 signal.txt），确认日志 `Squareoff is called`；仍不退出再 `kill -9`，并接受 `daily_init` 不会写。
  2. 从券商/ORS 查实际持仓，和 `daily_init.<sid>` 对比。
  3. 如需修正，停进程后手工改 `daily_init`（格式见 6.6），不要边跑边改。
  4. `./scripts/start_strategy.sh 92204 day`。
  5. `./scripts/tbstart 92204` 激活。
  6. 验证只有一个进程、日志 `Strategy is active now.`、无重复订单。

**恢复（收盘后）**

- 收盘后重启风险低；但仍要先 `daily_init` 对齐，再启动。
- 如果当天不打算再交易，保持停止，次日 08:50 会话会重新拉起（但 92204 仍需人工激活）。

**验证**

- `pgrep -af -- '--strategyID 92204'` 只有一个 PID。
- 日志 `Control File:` 是预期合约，`daily_init` 行数/持仓合理。
- Dashboard `active=true`；第一笔报价/成交正常；没有 `REJECT LIMIT`/`RMS Reject`。

**升级**

- 反复崩溃 → 查 `nohup.*.log` 的栈、core、`dmesg` OOM；查是否 `contractfile`/`fee.csv` 缺失导致 `exit(1)`（`TradeBotUtils.cpp:2465-2494`）。
- 持仓不一致 → 按 6.6，P0。

### 6.4 策略不交易（进程在、active=false 或不下单）

**常见原因**

| 原因 | 证据/日志 | 处理 |
|---|---|---|
| Live 模式默认 inactive | `ExecutionStrategy.cpp:390-392` | `tbstart <sid>` |
| 被 `tbstop`/SIGTSTP 停用 | `Squareoff is called` | 确认持仓后 `tbstart` |
| 到达 `endTime`/`endTimeAgg` 自动停用 | `HandleSquareoffNow`/`pos uneven` | 次日重新激活；检查是否留仓 |
| `REJECT_LIMIT` 200 触顶 | `REJECT LIMIT REACHED`、`Strategy exits due to reject limit`（`ExecutionStrategy.cpp:444-492`） | 查拒单原因；修复后**重启进程**（`m_Active=false`，信号激活可能不够） |
| `MAX_LOSS`/`UPNL_LOSS`/`STOP_LOSS`/`MAX_ORDERS`/`MAX_POS_SIZE` | 日志 `MAX LOSS...`、`Strategy squared off due to limit hit` | 查风控参数；不要盲目放宽；确认持仓 |
| `agg_repeat` 达 3 次自动 deactive | `.claude/CLAUDE.md`/`tbstart` 注释（`scripts/tbstart:4`） | `tbstart` 重新激活 |
| 没有该 session 的 control | `start_strategy.sh` 报 `找不到 controlFile` | 补 control 或换 session |
| 策略在 `strategies.disabled` | `start_all.sh` 日志 `跳过 <sid>（停用清单）` | 从清单删除并 `git pull`，再启动 |
| MD 断流/行情无效 | `bidPx/askPx<=0` 时 `MDCallBack` 直接 return（`ExecutionStrategy.cpp:783-790`） | 先修行情（6.2） |
| `m_wating_stop` 卡住 | 日志 `do hedge on wating stop state` | 查 exposure/挂单；必要时人工平仓后重启 |
| 风控 RMS 拒单 | `RMS Reject`、`E_RMS_*` | 查 ORS RMS 配置/额度；不要绕过 |

**检测**

```bash
pgrep -af -- '--strategyID 92204'
tail -300 deploy_cpp/bin/log/log.control.*.92204.$(date +%Y%m%d) | \
  egrep 'Strategy is active now|Squareoff|REJECT LIMIT|RMS Reject|MAX LOSS|STOPLOSS|agg_repeat|pos uneven|m_wating_stop|daily_init'
curl -s http://127.0.0.1:28080/api/strategies | python3 -m json.tool | egrep -A5 '92204'
```

**恢复**

- 纯“未激活” → `tbstart 92204`；日志出现 `Strategy is active now.` 即可。
- 风控触顶/拒绝上限 → 先查原因，修参数/仓位，再重启进程；不要只发信号。
- `m_wating_stop` 卡住 → 先确认 exposure；如果无法归零，人工平仓，再重启。
- 没有 control/被停用 → 改配置/清单，`--config-only` 或 `git pull`，再启动。

**验证**

- 日志 `Strategy is active now.`；Dashboard `active=true`；有报价/成交；无 `REJECT LIMIT`。
- 如果是 92204，确认没有被 09:05 的自动激活链漏掉（它本来就不在链里）。

**升级**

- 同日多次触顶 → 停策略，复盘参数/行情；不要反复 `tbstart`。
- 涉及风控额度调整 → 必须有人工审批，不能盘中随手改。

### 6.5 挂单卡死 / 订单无回报

**症状**

- Dashboard 挂单表有长时间 `NEW_CONFIRM`/未成交；策略日志没有 `TRADE_CONFIRM`/`CANCEL_ORDER_CONFIRM`；`HasUnTradedOrder()` 一直 true。
- 可能是柜台未收单、回报丢失、ORS 请求队列满、CTP 流控。

**检测**

```bash
# Dashboard 挂单
curl -s http://127.0.0.1:28080/api/orders | python3 -m json.tool | head -80
# ORS 订单/回报
tail -300 deploy_cpp/bin/log/ors_server.$(date +%Y%m%d).log | \
  egrep 'OnRspOrderInsert|OnRtnOrder|OnRtnTrade|CANCEL|REJECT|ErrorID|flow'
# 策略订单
tail -300 deploy_cpp/bin/log/log.control.*.92204.$(date +%Y%m%d) | egrep 'Order|Cancel|Trade|REJECT'
```

**止损**

- 先撤单：`tbstop 92204`（会 `CancelAllUnTradeOrders`，`PairwiseArbStrategy.cpp:1035`）；或通过管理面/券商终端撤单。
- 如果撤单也无回报，停止该策略，避免继续叠加挂单。
- 记录订单号、交易所、合约、方向、数量、价格、时间。

**恢复**

- 确认柜台侧订单状态（券商终端/电话）。
- 如果柜台已撤/已成交但本地没回报：说明回报链断，按 6.1/6.2 检查 ORS/CTP 交易会话；必要时重启 ORS（会重建回报链）。
- 如果本地有“幽灵挂单”（柜台没有），重启 TradeBot 前先确认 `m_ordMap` 不会导致重复下单；最稳妥是停策略、重启进程、重新激活。
- 如果是 CFFEX FAK 被拒（D9）或拒单无退避（D10），见上线测试清单 `:80-81`；当前代码未修，实盘 CFFEX 前必须处理。

**验证**

- Dashboard 挂单表清空/状态正确；ORS 日志有 `CANCEL_ORDER_CONFIRM` 或 `TRADE_CONFIRM`；策略 `m_wating_stop` 归零；持仓与柜台一致。

**升级**

- 同一合约反复撤单失败 → 联系券商；不要在不明状态时重启 TradeBot。
- 订单风暴/连环拒单 → P0，先 `tbstopall`，再查 D10。

### 6.6 持仓不一致（ORS / position.csv / daily_init / 柜台）

这是最危险的一类。先明确三方关系：

| 来源 | 是什么 | 谁写 | 是否实时 |
|---|---|---|---|
| 柜台（CTP） | 最终权威 | 券商 | 是 |
| ORS `mapContractPos` / `position.csv` | ORS 侧持仓表/时点文件 | ORS 启动查询、空仓查询、正常关机 | 否（时点） |
| `daily_init.<sid>` | 策略启动时的昨仓/均价/2day | TradeBot `HandleSquareoffNow()` 写 | 否（收盘/停用时） |

**症状**

- ORS 日志 `POSITION MISMATCH <sym> LONG/SHORT: file=... ctp=...`（`ORSServer.cpp:1500-1545`）。
- ORS 日志 `POSITION STALE <sym> cleared (not in CTP)`（`:1430-1444`、`:1545-1552`）。
- 券商 App 持仓与 Dashboard/策略 PnL 不一致；`daily_init` 行数与实际不符。
- 收盘 `pos uneven!` 告警；次日开盘策略 netpos 不对。

**检测**

```bash
# ORS 日志
tail -500 deploy_cpp/bin/log/ors_server.$(date +%Y%m%d).log | \
  egrep 'POSITION MISMATCH|POSITION STALE|Position query complete|Position query failed|degraded startup'

# position.csv（时点）
ls -l --time-style=full-iso deploy_cpp/bin/live/data/position.csv
cat deploy_cpp/bin/live/data/position.csv

# daily_init（策略真相）
for f in deploy_cpp/data/daily_init.*; do echo "== $f"; cat "$f"; done

# 柜台：券商 App/终端逐合约对平；或让 ORS 重新查询（重启）
```

**止损**

- 立即 `tbstop <sid>` 停用相关策略；不要新开仓。
- 不要边跑边改 `daily_init`；不要用 `position.csv` 直接覆盖 `daily_init`。
- 如果 ORS 是“degraded startup”（查询失败 3 次后用 `position.csv` 启动），**不要交易**；先修 CTP 查询（6.1）。

**恢复（按权威顺序）**

1. 以柜台为准，导出/记录每个合约的 `多头今仓/多头昨仓/空头今仓/空头昨仓`。
2. 停掉该 SID 的 TradeBot（确认退出）。
3. 对照 `daily_init.<sid>` 的字段：
   - 头部：`StrategyID 2day avgPx m_origbaseName1 m_origbaseName2 ytd1 ytd2`（`PairwiseArbStrategy.cpp:1088-1100`）。
   - `ytd1` = 第一腿昨仓；`ytd2` = 第二腿净仓；`2day` = 第一腿两日仓（`m_netpos_pass - m_netpos_pass_ytd`）；`avgPx` = 价差均值。
   - 具体填法取决于策略语义；**不要凭猜**。用上一份已知正确的 `daily_init_bak/<date>/` 或 `money_bak/` 做基线，只改与柜台不一致的字段。
4. 如果 ORS 的 `position.csv` 也旧：重启 ORS 让 `OnRspQryInvestorPosition` 重写（不要手工编辑 `position.csv`）。
5. 启动 TradeBot，`tbstart` 激活；先观察一轮，不下单。
6. 如果仍不一致：停策略，联系券商/策略作者；不要用“先跑起来再说”。

**验证**

- ORS 日志无 `POSITION MISMATCH`/`POSITION STALE`；`position.csv` 与柜台逐合约一致。
- `daily_init` 的 `ytd1/ytd2/2day` 与柜台/策略预期一致。
- 策略日志启动时读到的 `daily_init` 行合理；Dashboard PnL 不再跳变。
- 收盘 `HandleSquareoffNow` 写回后，`git diff` 的 `daily_init` 变化可解释。

**升级**

- 任何“真实持仓与记录不一致”都是 P0；通知风险负责人/交易负责人，必要时暂停全部策略。
- 如果涉及错账户/错策略（6.11），同时联系券商。

**证据/注意**

- `.claude/CLAUDE.md:675-676` 说“启动时对比 daily_init vs CTP position.csv，不一致则修正为 CTP 值，不需要手动改 daily_init”——**当前代码没有这个逻辑**。`PairwiseArbStrategy.cpp:24-46` 只从 `daily_init.<sid>` 读；`ORSServer.cpp:1500-1560` 只换 ORS 自己的表。该说法是 P/错误，复刻时不要实现成“信任自动修正”。
- `position.csv` 不是实时流；见 6.12。

### 6.7 SHM 满 / SHM 损坏

**症状**

- ORS/TradeBot 启动报 `shmget`/`EINVAL`/`ENOENT`；Dashboard 无数据；策略不启动。
- `ipcs -m` 里 key 存在但 `nattch` 异常/大小不对；`/dev/shm` 满。
- 策略日志可能有队列满/丢包（不同队列实现行为不同；不要假设一定有明确报错）。

**检测**

```bash
ipcs -m
ipcs -m | egrep '0x00000315|0x00001001|0x00002001|0x00003001|0x00004001'
df -h /dev/shm
# 看 nattch 是否与预期消费者/生产者数量一致
```

**止损**

- 不要 `ipcrm` 正在被进程使用的 SHM；先停所有消费者/生产者。
- 不要只杀 ORS 留 TradeBot（它会 attach 失败/读到坏队列）。

**恢复**

```bash
cd /root/quantlink-trading
./scripts/ops_stop_session.sh day
# 确认没有 ors_server/TradeBot/memlog/check-md/md-recorder
pgrep -a -x ors_server; pgrep -a -x TradeBot; pgrep -a -x memlog-reader
# 清当前用户全部 SHM（危险：确认没有别的程序用）
ipcs -m | grep "$(whoami)" | awk '{print $2}' | xargs -r -I{} ipcrm -m {}
ipcs -s | grep "$(whoami)" | awk '{print $2}' | xargs -r -I{} ipcrm -s {}
ipcs -q | grep "$(whoami)" | awk '{print $2}' | xargs -r -I{} ipcrm -q {}
./scripts/ops_start_session.sh day
```

**验证**

- `ipcs -m` 出现预期的 4 个 key（789/4097/8193/12289/16385），`nattch` 合理。
- `check-md -probe` 有增长；策略启动成功；Dashboard 有数据。
- 如果仍然 `shmget EINVAL`：检查 `MD_SHMSIZE`/`MD_LEN_LIST` 是否一致（ORS `MD_SHMSIZE=2048`，agent `MD_LEN_LIST=2048`；`tbadmin/cfg/agent.cfg` 注释明确写 4096 会 EINVAL）。

**升级**

- 反复 SHM 损坏 → 查是否有重复进程/错误二进制/内存压力；查 `dmesg`。
- 需要改 SHM 大小/队列长度 → 属于代码/配置变更，走第 9 章，不要在盘中改。

**证据/注意**

- `stop_all.sh` 会清当前用户**全部** SHM（`build_deploy_cpp.sh:739`），不只是交易的 4 个；如果同机有别的 SHM 应用，会被误删。
- `start_ors.sh` 启动前也会 `ipcrm` 当前用户全部 SHM（`build_deploy_cpp.sh:363`）。

### 6.8 DB 挂 / DB 连接失败

**症状**

- `ops_feed_db` 日志 `[ALERT] ops_feed_db 执行失败`；`strategy_sync` 日志报错；tbadmin `admin.log` 出现 `failed to init PostgresSql` 或 `initstlist failed`；Dashboard 策略列表空。
- `psql`/`pg_isready` 失败；PG 日志有 `could not write`/`disk full`/`PANIC`。

**检测**

```bash
pg_isready -h 127.0.0.1 -p 5432
systemctl status postgresql-16
journalctl -u postgresql-16 --since today | tail -100
tail -100 /root/quantlink-trading/deploy_cpp/bin/log/cron_feed_db.log
tail -100 /root/quantlink-trading/tbadmin/log/admin.log
tail -50 /var/log/quantlink/strategy_sync.log
```

**止损**

- 交易本身**不一定**依赖 DB：ORS/TradeBot 的主要链路是 CTP + SHM。若 `DSN` 为空，TradeBot 不写 DB；若 `DSN` 非空，squareoff 时会尝试连 DB（见下）。
- tbadmin admin 在 DB 挂时可能崩溃/重启循环；`ops_ensure_tbadmin` 每 5 分钟拉一次，会形成 churn。可临时停 `ops_ensure_tbadmin` 的 cron 行（改 `ops/crontab.txt` 后整份安装），或手工 `pkill` 后不再拉起，直到 DB 恢复。
- 不要让 `ops_feed_db` 在 DB 挂时反复重跑；修好再跑。

**恢复**

```bash
systemctl start postgresql-16
pg_isready -h 127.0.0.1 -p 5432
# 检查 dbtrade
psql -h 127.0.0.1 -U "$DB_USER" -d dbtrade -c '\dt'   # 变量从 ops/db.conf 读，不要把口令写命令行
# 重跑 feed
/root/quantlink-trading/scripts/ops_feed_db.sh
# 重跑策略同步（如果 10:30/20:30 失败）
flock -n /tmp/strategy_sync.lock python3 /root/quantlink-trading/tools/strategy_sync/sync_tbhft_strategy.py --apply
# 重启 tbadmin（admin 只在启动时读策略表）
cd /root/quantlink-trading/tbadmin && ./stop_agent.sh && ./start_agent.sh && ./start_admin.sh
```

**验证**

- `pg_isready` OK；`tbinstrument_info`/`tbtrading_days`/`tbtrade_sections` 行数合理；`tbhft_strategy` 有 active 行。
- tbadmin admin 日志不再 `failed to init PostgresSql`；前端策略列表恢复。
- `ops_check_status` 检查项 6/7/8 不因 DB 失败而误报（这些检查大多不依赖 DB；`ops_setup_arbi` 的 sections 依赖 DB）。

**升级**

- 单盘 DB 坏 → 见第 7 章恢复；没有 PITR，只能重建。
- 如果是磁盘满导致 PG 挂 → 先清盘（6.9），再启 PG；不要先删 PG 数据目录。
- `ops_setup_arbi.sh` 的 `sections.csv` 是“从 DB 查 `tbtrade_sections` 再重写”（`ops_setup_arbi.sh:138-152`）。如果 DB 查询返回空（DB 挂/表空），它会写出**只有表头**的 `sections.csv`，不报错；依赖它的模块会看到空 sections。DB 恢复后要重跑 `ops_feed_db.sh` + `ops_setup_arbi.sh`，并检查 `sections.csv` 行数。

**关键数据安全注意（V 代码/I 影响）**

- `PairwiseArbStrategy::HandleSquareoffNow()` 在写 `daily_init` 前会构造 `PqHelper`（如果 `m_dsn` 非空）：`auto db = m_dsn.empty() ? nullptr : std::make_shared<PqHelper>(m_dsn); SaveMatrix2(..., db);`（`PairwiseArbStrategy.cpp:1053-1054`）。如果 DB 连接在构造函数里抛异常，`SaveMatrix2` 不会被调用，**当日 `daily_init` 不会落盘**。DB 挂 + 收盘 = 持仓状态丢失。
- 规避：如果 TradeBot 不需要写 DB，保持 `DSN` 为空；如果必须写，给 `PqHelper` 构造加 try/catch，先写文件再尝试 DB。复刻时不要保留“DB 失败阻断本地状态保存”的路径。
- `ops/db.conf` 当前 644；DB 凭据可被本机任意用户读取。应 600。

### 6.9 磁盘满 / inode 满

**症状**

- `df -h /` 100%；`df -i /` 100%；日志出现 `No space left on device`；PG 写失败；`position.csv`/`daily_init` 写失败；进程可能崩溃。
- `dmesg` 可能有 OOM/ENOSPC。

**检测**

```bash
df -h /
df -i /
du -sh /root/quantlink-trading/deploy_cpp/bin/log.bak \
       /root/quantlink-trading/deploy_cpp/ctp_flow.bak \
       /root/quantlink-trading/deploy_cpp/money_bak \
       /root/quantlink-trading/deploy_cpp/daily_init_bak \
       /root/quantlink-trading/deploy_cpp/report_bak \
       /home/u50_data /data/u50_data 2>/dev/null
find /root/quantlink-trading -maxdepth 3 -name 'core-*' -o -name 'core.*' 2>/dev/null | head
```

**止损**

- 先停非关键写入：`ops_stop_md_recorder.sh`（如果还在跑）；暂停 `check-md`（如果日志疯长）；不要停 ORS/TradeBot 除非它们已经写失败。
- **不要删**：`position.csv`、`daily_init.*`、`data_cpp/`、`ors_server.cfg`、`ops/db.conf`、当前 `log/` 里正在写的文件。
- 可以删/移：最旧的 `log.bak/<date>/`、`ctp_flow.bak/`、`/home/u50_data` 旧 CSV、core 文件、`/tmp` 下本项目日志。

**恢复**

1. 释放空间（按“最旧、最可重建”顺序）：
   ```bash
   # 先看，再删；不要 rm -rf 整个 log.bak
   du -sh deploy_cpp/bin/log.bak/* | sort -h | head
   # 例：删最旧日期目录（确认已备份/不需要复盘）
   rm -rf deploy_cpp/bin/log.bak/20260101
   # core
   find /root/quantlink-trading -maxdepth 3 -name 'core-*' -delete
   # 旧行情 CSV（确认不需要）
   ls -lt /home/u50_data | tail
   ```
2. 如果 PG 因磁盘满挂了：先释放空间，再 `systemctl start postgresql-16`；检查 `pg_isready`、`dbtrade` 完整性。
3. 如果 `position.csv`/`daily_init` 写失败：修好空间后，重启 ORS（重写 `position.csv`）或让策略在收盘时重写 `daily_init`；必要时手工恢复（6.6）。
4. 重新启动被停的组件；验证日志/DB/持仓。

**验证**

- `df -h /` <90%；`df -i /` 有余量；PG `pg_isready`；ORS/TradeBot 正常写日志；`position.csv`/`daily_init` mtime 更新。
- `ops_check_status` 不再报磁盘 >90%。

**升级**

- 磁盘反复满 → 加盘/扩盘、把日志/行情数据分盘、设置保留策略；不要靠每天手删。
- 如果根分区 >95% 且无法立即释放 → P0，停止交易/停止写日志，先保 DB 和持仓文件。

**证据/注意**

- 90% 检查只在 00:00（`ops_check_status.sh:173-177`）。
- `log.bak`/`ctp_flow.bak`/`/home/u50_data` 都没有自动保留策略；`ctp_flow.bak` 还会同名覆盖。
- tbadmin 启动脚本 `ulimit -c unlimited` + `core_pattern`，core 可能很大；ORS 默认关闭 core（`build_deploy_cpp.sh:362`）。

### 6.10 重复进程（ORS / TradeBot / tbadmin / memlog）

**症状**

- `pgrep -c -x ors_server` >1；同一 `--strategyID` 有多个 TradeBot；`pgrep -a -x AdminLoop/AgentLoop` 多个；端口 bind 失败；Dashboard 同一 SID 重复/数据跳变。
- CTP 双登录会导致先登录的 MD 被静默踢掉（D15），表现为“两个进程但只有一个有行情”。

**检测**

```bash
pgrep -c -x ors_server
pgrep -af -- '--strategyID'
pgrep -af -x AdminLoop; pgrep -af -x AgentLoop
pgrep -af -x memlog-reader
ss -tlnp | egrep '9980|9981|28080|28081|8882'
ps -o pid,lstart,cmd -p <pid1> <pid2>
```

**止损**

- 不要随意 `kill -9` 其中一个；先确认哪个是“旧/新”、哪个持有 CTP 会话、哪个有挂单。
- 最稳妥：停全部相关进程（`ops_stop_session.sh day` 会停 ORS/TradeBot/memlog，但不停 tbadmin），等 ORS 真正退出（90s），清 SHM，再启一个。
- tbadmin 重复：`tbadmin/stop_agent.sh` 会按 `./tbadmin` 全杀（包括 admin），然后按 08:30 的顺序重起；或手工 `pkill -f './tbadmin'` 后只起一套。

**恢复**

```bash
cd /root/quantlink-trading
./scripts/ops_stop_session.sh day
# 等 pgrep -x ors_server 为空；确认没有 TradeBot
./scripts/ops_start_session.sh day
./scripts/tbstart 92204
# tbadmin
cd tbadmin && ./stop_agent.sh && ./start_agent.sh && ./start_admin.sh
```

**验证**

- 每个进程恰好 1 个；端口只 bind 一次；Dashboard 每个 SID 一条；ORS 日志只有一个 `ORS ready`；没有双登录/断流。

**升级**

- 反复重复 → 查 cron 重叠（preopen/md_liveness 无 flock）、pid 文件丢失、手工启动、systemd/旧脚本残留。
- 双 ORS 导致的 MD 断流按 6.2 处理；不要只杀一个了事，必须确认 CTP 会话释放。

**证据/注意**

- `start_ors.sh` 硬拒绝双启动（`build_deploy_cpp.sh:358-363`）。
- `start_strategy.sh` 先查 `trader.<sid>.pid`，再 `pgrep -f "strategyID <sid>"`（`build_deploy_cpp.sh:461-477`）。后者是子串匹配，`92201` 可能命中 `922010`；`ops_tb_signal` 用精确 argv 匹配（`ops_tb_signal.sh:82-98`），两者不一致。
- `stop_all.sh` 用 `pgrep -f "TradeBot"`/`pkill -9 -f "TradeBot"`（`build_deploy_cpp.sh:690-694`），会误杀命令行里含 `TradeBot` 的其它进程（如 `tail -f ...TradeBot...`）。

### 6.11 错账户 / 错策略

**症状**

- 订单出现在错误账户/错误策略下；`ACCOUNT` 不是 `OWN`；实际运行的 SID 与预期不符；92221 跑了 IF 而不是 TA（或反之）；日志 `Control File:` 与预期合约不一致。

**检测**

```bash
# 实际进程/SID
pgrep -af -- '--strategyID'
# 账户标签
grep -n '^ACCOUNT' /root/quantlink-trading/data_cpp/bin/config/StrategyConfig.cfg
grep -n '^ACCOUNT' /root/quantlink-trading/deploy_cpp/bin/config/StrategyConfig.cfg
# 策略日志里的 control/model
tail -100 /root/quantlink-trading/deploy_cpp/bin/log/log.control.*.92221.$(date +%Y%m%d) | \
  egrep 'Control File|Strategy ID|ConfigFile|daily_init'
# 策略表
psql -h 127.0.0.1 -U "$DB_USER" -d dbtrade -c \
  "select sid,type,instrument,instrument2,active from tbhft_strategy order by sid;"
# 停用清单
cat /root/quantlink-trading/data_cpp/bin/config/strategies.disabled
# 92221 的两个 control
ls -l /root/quantlink-trading/data_cpp/bin/controls/day/control.*.par.txt.92221
```

**关键事实**

- `ExecutionStrategy.cpp:16,59,66`：代码默认 `ACCOUNT "PRP05     "`；如果配置里没有 `ACCOUNT`，会 **静默用 PRP05**。仓库 `StrategyConfig.cfg:1` 是 `ACCOUNT=OWN`；tbadmin 生成的配置也写 `ACCOUNT=OWN`（`admin.cpp:1824`）。所以“账户错”最常见的根因是**配置缺失/被覆盖**，不是代码。
- `ACCOUNT=OWN` 是策略侧标签，不是 CTP InvestorID；真正账户在 `ors_server.cfg` 的 `INVESTOR_ID`。所有策略共用一个 ORS/一个投资者账户（`01-system-architecture` 已述）。
- `92221` 有两个 control 文件；`start_strategy.sh` 的 `for f in controls/${SESSION}/control.*.par.txt.${SID}; do ... break; done` 取 glob 第一个（通常 `IF...` 在 `TA...` 前）。日志里的 `Control File:` 才是实际；不要看文件名猜。
- `strategies.disabled` 只影响 `start_all.sh` 自动启动；手动 `start_strategy.sh` 不受影响（`strategies.disabled:2`）。所以“清单里有”不等于“手动起不来”。

**止损**

- 立即 `tbstop <sid>` 停用错误策略；撤单；确认是否有成交。
- 如果是错账户订单已到柜台，**立即联系券商**，不要自行反向下单掩盖。
- 不要同时启动“正确”和“错误”两个策略；先停干净。

**恢复**

1. 修正 `StrategyConfig.cfg` 的 `ACCOUNT=OWN`（或 tbadmin 生成配置的 `ACCOUNT`），确保部署侧和源侧一致。
2. 修正 control/model / `strategies.disabled`；`build_deploy_cpp.sh --config-only` 或 `git pull`。
3. 重启错误策略（按 6.3 的盘中/收盘规则），激活预期 SID。
4. 验证日志 `Control File:`、`Strategy ID`、`ACCOUNT`、`daily_init` 都是预期。

**验证**

- `pgrep -af -- '--strategyID'` 只有预期 SID；每个 SID 一个进程。
- 日志 `Control File:` 的合约对与预期一致；`ACCOUNT: OWN`。
- Dashboard/策略表/订单账户一致；券商侧无错账户订单。

**升级**

- 错账户已成交 → P0；通知券商/风控/负责人；保留订单号/成交号。
- 反复错策略 → 检查 tbadmin 生成的配置、`start_all` 的 glob、`strategies.disabled`、`92221` 双 control。

### 6.12 `position.csv` 陈旧 / ORS 降级启动

**症状**

- `position.csv` mtime 是开盘时间，不是收盘时间；内容与券商不一致。
- ORS 日志 `CRITICAL: Position query failed after 3 attempts, degraded startup with position.csv values`（`ORSServer.cpp:2032-2040`）。
- 盘中 `money_bak/money_<date>_am/position.csv` 与实时持仓不一致（正常，但容易被误读）。

**检测**

```bash
ls -l --time-style=full-iso /root/quantlink-trading/deploy_cpp/bin/live/data/position.csv
stat -c '%y %s' /root/quantlink-trading/deploy_cpp/bin/live/data/position.csv 2>/dev/null || \
  stat -f '%Sm %z' /root/quantlink-trading/deploy_cpp/bin/live/data/position.csv
tail -200 /root/quantlink-trading/deploy_cpp/bin/log/ors_server.$(date +%Y%m%d).log | \
  egrep 'Position query|POSITION MISMATCH|POSITION STALE|degraded startup'
```

**止损**

- 如果 ORS 是 degraded startup：**不要交易**。它的 `m_connected=true` 是用旧 `position.csv` 换来的，持仓表可能是错的。
- 如果只是盘中的 `position.csv` 旧：这是设计如此，不要据此判断实时持仓；用券商/ORS 查询。

**恢复**

1. 停策略/会话（按 6.1）。
2. 修 CTP 登录/查询（前置、认证、结算单、`ErrorID`）；确保 `ReqQryInvestorPosition` 成功。
3. 重启 ORS，直到日志出现 `Position query complete` + `Position query done, ORS ready`；`position.csv` mtime 更新。
4. 对比 `position.csv` 与柜台；如有 `POSITION STALE`，确认是柜台没有的旧合约，接受 ORS 的重写。
5. 再启动/激活策略。

**验证**

- `position.csv` mtime 在本次启动之后；内容与柜台逐合约一致；无 `degraded startup`/`POSITION MISMATCH`。
- `daily_init` 与柜台一致（6.6）；策略启动后 netpos 合理。

**升级**

- CTP 持仓查询持续失败 → 券商；不要反复重启（可能触发登录限制）。
- 如果 `position.csv` 写失败（目录/权限/磁盘）→ 修目录/权限/磁盘；ORS 日志会 `Unable to open position file`（`ORSServer.cpp:212-218`）。

**证据/注意**

- `position.csv` 只在 ORS 启动查询完成、空仓查询完成、`Stop()` 时写（`ORSServer.cpp:207-233,264,1430-1444,1557-1558`）；成交/报单回调不写。
- `money_bak` 的 am 快照（11:46）复制的是这份时点文件，所以它**不是** 11:46 的实时持仓。
- `sync_data_back.sh:47-52` 对 `position.csv` 是**无条件覆盖**（deploy → data_cpp），没有 mtime 比较；如果 deploy 侧是旧的，会把 data_cpp 也覆盖成旧的，然后 `ops_sync_git` 提交旧值。这是数据安全 bug，见 7.3。

---

## 7. 备份与恢复

### 7.1 现状（一句话）

`quantlink-trading` 的生产主机是**单盘、无网络挂载、无第二台机器、无对象存储凭据**；**没有异地备份、没有 PITR、没有 `pg_dump` 产物**。这是 2026-10-05 用户明确接受的已知风险（`docs/RISK_NO_OFFSITE_BACKUP.md:3,15,124-136`，V 文档；现场未复核 I）。

因此备份章节的重点不是“怎么备份”，而是：

1. **哪些东西能从 git/文件重建**（决定了坏盘后还能不能交易）。
2. **哪些东西一坏就没**（决定了复盘/合规损失）。
3. **恢复顺序**（先让系统能交易，再谈历史）。
4. **RPO/RTO 的真实数字**（不要写“<=5 分钟”这种不属于本系统的承诺）。

### 7.2 资产分类

| 类别 | 内容 | 位置 | 是否有副本 | 丢了能否重建 |
|---|---|---|---|---|
| A. 代码/配置（git 跟踪） | 源码、`data_cpp/bin/{config,controls,models}`、`data_cpp/data/*`（fee/contractfile/sections/trading_days/name/session_rules/OptionsParams 等）、`scripts/ops_*`、`ops/crontab.txt` | git 远端（GitHub） | 有（git） | 能，`git clone` + build |
| B. 运行时状态（git 跟踪） | `daily_init.*`、`position.csv` | `data_cpp/data/`、`data_cpp/bin/live/data/`，每天 15:20 push | 有（git，最多滞后 1 个交易日） | 能恢复到最近一次 push；当日盘中丢失不可重建 |
| C. 本机快照 | `daily_init_bak/<date>/`、`money_bak/money_<date>_<label>/`、`report_bak/report_<date>_<label>.txt` | `deploy_cpp/` | **无** | 不能（历史时点） |
| D. 日志/行情 | `log.bak/`、`ctp_flow.bak/`、`/home/u50_data/`、`/data/u50_data/` | `deploy_cpp/`、`/home`、`/data` | **无**（`ops_rotate_logs` 只本地 mv） | 不能；复盘唯一原始数据 |
| E. 数据库 | `/var/lib/pgsql/16/data/`（`dbtrade` 15M，data dir 96M） | 本机 PG | **无**（`tbhft_strategy_bak_sync_*` 是同盘表，不是备份） | 部分：日历/合约/sections 可从文件重建；`tbhft_strategy` 可从 RDS 同步；其余不可 |
| F. 凭据 | `ops/db.conf`、`ors_server.cfg`、`strategy_sync.env`、`feishu.secret.yaml`、`/root/quantlink-backups/` | 本机 | **无**（或同盘） | 需向券商/企微/RDS 重新申请；有等待成本 |
| G. tbadmin 状态 | `tbadmin/cfg/order_ref.json`、`cfg/*.dat` | `tbadmin/cfg/` | 无 | 可由 SHM/DB 重建一部分；`clear.sh` 每天清 |
| H. 构建产物 | `deploy_cpp/bin/*` | `deploy_cpp/` | 无 | 能，源码重建 |

证据：`docs/RISK_NO_OFFSITE_BACKUP.md:44-66,77-101`；`ops_sync_git.sh:25`；`ops_rotate_logs.sh:35-69`；`tools/strategy_sync/sync_tbhft_strategy.py:14-15,34,212-235`；`tbadmin/clear.sh:1-7`。

### 7.3 快照/同步机制（逐个核对）

#### 7.3.1 `ops_snapshot_daily_init.sh`（07:00）

- 源：`deploy_cpp/data/daily_init.*`；目标：`deploy_cpp/daily_init_bak/<YYYYMMDD>/`（`ops_snapshot_daily_init.sh:10,22-31`）。
- 只 `cp`；`COUNT=0` 只 `[WARN]`；不校验内容/数量（`:33-36`）。
- 用途：当天开盘前基线；如果前一天 `stop_all` 没跑/`daily_init` 没写，快照也是旧值。

#### 7.3.2 `ops_snapshot_money.sh`（11:46 / 15:16）

- 源：`deploy_cpp/data/daily_init.*` + `deploy_cpp/bin/live/data/position.csv`（找不到再退 `data_cpp/bin/live/data/position.csv`）；目标：`deploy_cpp/money_bak/money_<YYYYMMDD>_<am|pm|night>/`（`ops_snapshot_money.sh:24-44`）。
- **11:46 的 `position.csv` 是 ORS 开盘查询时写的时点值**，不是 11:46 实时持仓；这点必须在复盘时标注。
- 15:16 在 `stop_all` 之后，ORS `Stop()` 已写最终 `position.csv`；这份更有价值。
- `night` 标签在脚本里支持，但夜盘 cron 被注释。

#### 7.3.3 `ops_eod_report.sh`（停会话前）

- 源：`memlog-reader` 的 `/api/strategies` + `/api/orders`；目标：`deploy_cpp/report_bak/report_<SESS_DATE>_<day|night>.txt`（`ops_eod_report.sh:108-143`）。
- 必须在 `stop_all` 之前（memlog 会被停）；`ops_stop_session.sh:33-36` 保证顺序。
- 内容：策略数、运行中/未运行、active/onExit/onCancel/onFlat、持仓、PNL、cancelRatio、挂单（`ops_eod_report.py:54-133`）。
- 失败时删半成品、告警、不阻断停会话（`:137-143`）。
- **`report_bak` 是“运行态文本快照”，不是交易所对账单**；不能替代券商结算单。

#### 7.3.4 `sync_data_back.sh`（stop_all 末尾）

- `deploy_cpp/data/daily_init.*` → `data_cpp/data/`：按 mtime 新赢；deploy 新则回灌；data 新则反向下发（但策略运行中会 `[WARN]` 暂不下发）（`sync_data_back.sh:16-45`）。
- `deploy_cpp/bin/live/data/position.csv` → `data_cpp/bin/live/data/position.csv`：**无条件 `cp`**（`:47-52`）。
- 风险：如果 ORS 被 SIGKILL、`position.csv` 没更新，deploy 是旧的；`sync_data_back` 会把 data_cpp 也覆盖成旧的；随后 15:20 `ops_sync_git` 提交旧值。这是“坏数据覆盖好数据”的路径（V 代码；是否发生过 I）。
- 建议：对 `position.csv` 也做 mtime/内容比较；或在 `cp` 前校验 `position.csv` 的 mtime 不早于本次会话启动。

#### 7.3.5 `ops_sync_git.sh`（15:20）

- `git add data_cpp/data/daily_init.* data_cpp/bin/live/data/position.csv`（`ops_sync_git.sh:25`）。
- 无变更 → 静默退出；有变更 → `git commit -m "chore: <session>收盘同步..."` + `git push`（`:27-38`）。
- **不 `git pull`/不 rebase**；push 失败只写 `[ERROR]` 日志，不告警。
- 只同步 `daily_init` + `position.csv`；不同步 `fee.csv`（由 `ops_refresh_fee` 单独 commit）、不同步日志/快照/DB。

#### 7.3.6 `ops_refresh_fee.sh`（15:40）

- `fee_refresh` 从 CTP 直查，成功才写 `data_cpp/data/fee.csv`；失败不写文件（`ops_refresh_fee.sh:110-147`）。
- 成功 touch `deploy_cpp/bin/log/.fee_refresh.ok`（`:155-160`）。
- `git add data_cpp/data/fee.csv` + commit + push（`:172-186`）；push 失败不算刷新失败。
- 与 `ops_sync_git`/`strategy_sync` 抢 `.git/index.lock`：用 `flock -n /tmp/fee_refresh.lock` 串行化；拿不到锁就跳过本轮（`:102-108`）。

#### 7.3.7 `strategy_sync`（10:30/20:30）

- RDS `public.tbhft_strategy` → 本地 `dbtrade.tbhft_strategy`；以 `id` 为键，新增/更新/删除；本地独有行永不修改（`sync_tbhft_strategy.py:5-18`）。
- `--apply` 单事务，写前 `CREATE TABLE tbhft_strategy_bak_sync_<ts> AS SELECT * FROM ...`，保留 `BACKUP_KEEP=10`（`:14-15,34,212-235`）。
- 这个“备份表”在**同一个库、同一块盘**，不是异地备份；只能防误操作，不防磁盘坏。
- 配置 `/root/.quantlink/strategy_sync.env`（600，gitignored）（`ops/crontab.txt:66`）。

### 7.4 数据库：现状与恢复

#### 7.4.1 有什么

- 本机 PostgreSQL 16，`dbtrade` 约 15M，data dir 约 96M（`RISK:66`）。
- 主要表：`tbtrading_days`、`tbinstrument_info`、`tbinstrument_name`、`tbtrade_sections`、`tbhft_strategy`、`tbhft_strategy_bak_sync_*`、`tbhft_schedule/action/product`（空表，`ops/db/hft_control_tables.sql:1-32`）。
- 写入方：
  - `ops_feed_db.py`：`tbtrading_days`、`tbinstrument_info/name`、`tbtrade_sections`（17:00）。
  - `strategy_sync`：`tbhft_strategy`（10:30/20:30）。
  - `tbadmin`：读策略表；可能写 `posdetail`（`SaveMatrix2`，当 DSN 非空）。
  - 旧 `tbadmin-py` 已退役，不再写。

#### 7.4.2 有没有备份

- **没有 `pg_dump` 产物**：`find / -maxdepth 4 -name "*.dump" -o -name "*.sql.gz"` 无结果；crontab 无 dump 任务（`RISK:119-120`，V 文档）。
- **没有 WAL 归档/PITR**：仓库里没有任何 `archive_mode`/`wal_level`/`pg_basebackup` 配置（全文搜索无）。
- `tbhft_strategy_bak_sync_*` 是同库表，不是备份；`/var/lib/pgsql/16/data/` 在单盘上。

#### 7.4.3 坏盘后能恢复什么

| 表 | 能否重建 | 方法 |
|---|---|---|
| `tbtrading_days` | 能 | `ops_feed_db.py` 从 `data_cpp/data/trading_days.txt` 重灌 |
| `tbinstrument_info` / `tbinstrument_name` | 能（需 ORS dump） | `ops_feed_db.py` 从 `deploy_cpp/bin/log/contracts_*` 或 `contractfile_*` 重灌；没有 dump 就等下一次 ORS 启动 |
| `tbtrade_sections` | 能 | `ops_feed_db.py` 从 `session_rules.csv` 重建 |
| `tbhft_strategy` | 能（若 RDS 可达） | `strategy_sync --apply`；本地独有行会丢 |
| `tbhft_strategy_bak_sync_*` | 不能 | 同盘，随盘丢 |
| `tbhft_schedule/action/product` | 能（空表） | `ops/db/hft_control_tables.sql` |
| 其它 `tbhft_*` / 历史 PnL | 不能 | 没有备份/来源不明 |

#### 7.4.4 建议的 DB 备份（P，不在当前实现）

如果将来补：

1. **逻辑备份**：每天 `pg_dump -Fc dbtrade` → 独立目录/对象存储；保留 ≥14 天；恢复到临时库验证。
2. **PITR**：`wal_level=replica`、`archive_mode=on`、`archive_command` 到独立存储；定期 `pg_basebackup`；RPO/RTO 按业务定。
3. **恢复演练**：每季度在临时主机恢复一次，验证 `tbtrading_days/tbinstrument_info/tbhft_strategy` 行数与关键查询。
4. **不要把备份放在同一块盘**；不要用 `tbhft_strategy_bak_sync_*` 冒充备份。

### 7.5 对 `docs/architecture/21-backup-pitr.md` 的核对（重要）

**结论：该文件不在 `quantlink-trading` 仓库里。**

- `quantlink-trading/docs/architecture/` 只有 3 个文件：`2026-09-23_系统架构图.html`、`Quantlink交易架构系统（经典）.html`、`tbsrc-indicator-calculation.md`；没有 `21-backup-pitr.md`（V：`ls docs/architecture/`）。
- 工作区里唯一同名文件是 `/Users/wangjun/PG/quantlink-new/quantlink-fin/docs/architecture/21-backup-pitr.md`，属于 **`quantlink-fin`**，不是本文对象（V）。
- 该文件描述的 `tools/db/backup.sh`、systemd timer、WAL 归档、`quantlink_fin_shadow`、RPO<=5min/RTO<=30min，都是 `quantlink-fin` 的设计；`quantlink-trading` **没有**这些脚本/服务/配置（V：`find` + 全文搜索）。
- 其中 `tools/db/backup.sh` 确实存在于 `quantlink-fin`，每天 02:15 由 `quantlink-fin-db-backup.timer` 调 `pg_dump -Fc`，保留 14 天（V，读 `quantlink-fin/tools/db/backup.sh:1-20`、`deploy/quantlink-fin-db-backup.timer`）。但这是**另一个系统**的备份，不覆盖 `quantlink-trading` 的 `dbtrade`。
- `quantlink-trading` 的权威备份事实是 `docs/RISK_NO_OFFSITE_BACKUP.md`：**单盘、无副本、已接受风险**；不要用 `quantlink-fin` 的 PITR 文档来回答“trading 的备份怎么做”。

**逐条核对**：

| 21 号文档的条款 | `quantlink-fin` 的实际脚本 | `quantlink-trading` 的实际状态 |
|---|---|---|
| 逻辑备份 `tools/db/backup.sh` | 存在：`pg_dump -Fc`，默认 `/var/backups/quantlink-fin`，保留 14 天（`quantlink-fin/tools/db/backup.sh:1-20`） | **不存在**；`quantlink-trading` 的 `tools/` 只有 strategy_sync/trading_calendar |
| 每天 02:15 自动备份 | `quantlink-fin-db-backup.timer`（`OnCalendar=*-*-* 02:15:00`） | **不存在**；crontab 无 dump 任务（`RISK:119-120`） |
| PITR：`wal_level=replica`、`archive_mode=on`、`archive_command` | 21 号文档要求；是否已在 fin 生产启用需现场确认 | **没有**任何 `archive_mode`/`wal_level`/`pg_basebackup` 配置（全文搜索无） |
| basebackup + `wal-archive` | 21 号文档要求；fin 的部署脚本是否已落地需现场确认 | **没有**；`RISK:119-120` 明确“本机没有任何 pg_dump 产物” |
| RPO<=5 分钟 / RTO<=30 分钟 | fin 的目标（是否达标需演练） | **不适用**；trading 没有 WAL 归档，RPO 对 DB 是“磁盘故障 = 最近可重建点” |
| 保留 orders/trades 365 天、audit/ledger 730 天、alerts 90 天 | `quantlink-fin/tools/db/retention.sql`（fin） | **不适用**；trading 的 `dbtrade` 没有对应保留策略 |

> 如果档案读者需要“目标态备份设计”，可以把 `quantlink-fin` 的 21 号文档当作 **P/参考**，但必须显式标注“不适用于 quantlink-trading 当前实现”。不要把它写成 trading 的现状。

### 7.6 恢复顺序（坏盘/换机）

> 目标：先恢复“能交易的最小集”，再恢复历史/复盘。以下为 **P/演练步骤**，当前没有实际演练记录（I）。

#### 阶段 0：保留现场

1. 如果旧盘还能读：先镜像/复制 `/root/quantlink-trading`、`/var/lib/pgsql/16/data`、`/root/quantlink-backups`、`/home/hft/tbdata`、`/home/u50_data` 到独立介质。
2. 记录旧机 `crontab -l`、`df -h`、`ipcs -m`、`ps -ef`、`ss -tnlp`（如果还能跑）。
3. 不要在原盘上反复 `fsck`/重建，先镜像。

#### 阶段 1：主机与依赖

1. 新机装 Linux（与 190 同族），设置 CST 时区、chrony、防火墙。
2. 装构建/运行依赖：C++ 工具链、CMake/Make、CTP SDK、ZMQ/protobuf/libpqxx/YD 库、PostgreSQL 16、Python3 + `psycopg2`、`curl`、`flock`、`psql`、`git`、`logrotate`。
3. 建目录：`/root/quantlink-trading`、`/home/hft/tbdata`、`/home/u50_data`、`/var/log/quantlink`、`/root/.quantlink`、`/root/quantlink-backups`。
4. `ops_install_deps.sh` 建 `/home/hft/tbdata` 软链、备份 crontab、生成 `ops/db.conf` 模板（`ops_install_deps.sh:42-92`）。

#### 阶段 2：代码与配置

1. `git clone` 到 `/root/quantlink-trading`，checkout 已知 commit（记录在案）。
2. 恢复**不进 git** 的配置：
   - `data_cpp/bin/config/ors_server.cfg`（CTP 凭据/前置/`PRODUCTION_MODE`/`API_LOG_DIR`/`POSITION_FILE`/SHM 大小）。
   - `ops/db.conf`（DB + webhook；600）。
   - `/root/.quantlink/strategy_sync.env`（600）。
   - `feishu.secret.yaml`（如启用）。
   - `/root/quantlink-backups/` 的 CTP `.bak`（如果旧盘还在）。
3. 核对 `data_cpp/data/` 的 9 个关键文件（fee/contractfile/sections/trading_days/name/session_rules/OptionsParams/RolloverOverrideFile/SimpleChinaInstruments）都在 git 里；`/home/hft/tbdata/*` 全部软链回 `data_cpp/data/`（`RISK:77-101`、`ops_install_deps.sh:42-68`）。
4. 恢复 `daily_init.*`/`position.csv`：优先 `git checkout` 最近一次 15:20 提交；如果旧盘可读，用 `daily_init_bak`/`money_bak` 的最近一份交叉核对。

#### 阶段 3：数据库

1. `initdb`/启动 PG 16；建 `dbtrade`、用户/权限（与 `ops/db.conf` 一致）。
2. 应用 `ops/db/hft_control_tables.sql`（空表；`schedule` 保持空，避免盘中信号）。
3. 跑 `ops_feed_db.sh`：从 `data_cpp/data/trading_days.txt`、`session_rules.csv`、`contractfile`/ORS dump 重建 `tbtrading_days/tbinstrument_info/tbtrade_sections`。
4. 跑 `strategy_sync --apply`：从 RDS 恢复 `tbhft_strategy`（如果 RDS 可达；本地独有行会丢）。
5. 如果旧盘有 `pg_dump`（本项目没有），按 `pg_restore` 恢复；否则接受“部分重建”。

#### 阶段 4：构建

1. `./scripts/build_deploy_cpp.sh`（ORS + TradeBot；`--config-only` 只刷配置）。
2. 构建/复制 Go 工具：`check-md`、`md-recorder`、`memlog-reader`（来自 `web-go`，不在本文范围，但运行目录需要它们）。
3. 构建 `tbadmin`（`cd tbadmin && make`）。
4. 校验 `deploy_cpp/bin/` 的二进制/配置/controls/models 齐全；`fee.csv`/`contractfile` 可读。

#### 阶段 5：启动与验证（先评测/小流量）

1. 设 `ors_server.cfg` 的 `PRODUCTION_MODE=0`（评测）先验证；确认无 4040、登录/结算/持仓查询成功。
2. `./scripts/ops_start_session.sh day`；观察 `cron_start_day.log`、ORS 日志、`check-md -probe`。
3. 只激活一个策略（建议 92204 或评测 SID），用最小手数；验证报单/成交/撤单/平仓/持仓。
4. 确认 `position.csv`、`daily_init`、Dashboard、券商四方一致。
5. 切 `PRODUCTION_MODE=1`（生产），重启 ORS；重复登录/持仓/最小单验证。
6. 安装 crontab：`crontab /root/quantlink-trading/ops/crontab.txt`；安装 logrotate；启动 chrony。
7. 跑一遍 `ops_check_status.sh`、`ops_check_md.sh start`、`ops_eod_report.sh day`（手工）确认脚本可用。

#### 阶段 6：历史/复盘（可选）

1. 从旧盘/备份恢复 `log.bak/`、`money_bak/`、`report_bak/`、`/home/u50_data`。
2. 核对 `log.bak` 的日期完整性；`ctp_flow.bak` 只留最后一天是已知限制。
3. 把恢复后的目录权限收紧；不要覆盖新系统的 `log/`。

### 7.7 RPO / RTO（真实数字，不是承诺）

| 资产 | RPO | RTO | 说明 |
|---|---|---|---|
| 代码/配置（git） | 0（已 push） | 30–60 分钟（clone + build） | 依赖工具链/CTP SDK/内网 |
| `daily_init`/`position.csv`（git） | ≤1 个交易日（15:20 push） | 10 分钟（checkout） | 当日盘中丢失不可重建 |
| `fee.csv`（git） | ≤1 个交易日（15:40） | 5 分钟（checkout）或重跑 `fee_refresh` | 需 CTP 可达 |
| `trading_days.txt`（git） | 0（已 push） | 5 分钟 | 年度巡检 |
| 本机快照（`daily_init_bak`/`money_bak`/`report_bak`） | 磁盘故障 = 全部 | 不可恢复 | 同盘、无副本 |
| 日志/CTP flow/行情 CSV | 磁盘故障 = 全部 | 不可恢复 | 复盘原始数据；`ctp_flow.bak` 只留一天 |
| DB `dbtrade` | 磁盘故障 = 最近一次可重建点；无 PITR | 30–120 分钟（部分重建） | `tbhft_strategy` 依赖 RDS；其余部分可重建 |
| 凭据（`ops/db.conf`/`ors_server.cfg`/`strategy_sync.env`/`feishu.secret.yaml`） | 磁盘故障 = 全部 | 小时–天（向券商/企微/RDS 申请） | 可能阻塞上线 |
| 整体“能交易” | 取决于 git + 凭据 + 券商 | 2–4 小时（手工，未演练） | 没有自动化恢复脚本；I/P |
| 整体“能复盘” | 磁盘故障 = 丢失 | 不可恢复 | 除非将来加异地备份 |

> 这些数字是**推算**，不是 SLA；当前没有恢复演练记录（I）。如果对外承诺 RPO/RTO，必须先做一次完整演练并记录。

### 7.8 什么**没有**备份（逐项）

1. `deploy_cpp/bin/log.bak/`：交易日志归档（复盘唯一原始数据）。
2. `deploy_cpp/ctp_flow.bak/`：CTP 原始 API 流（且只留最后一天）。
3. `deploy_cpp/money_bak/`：持仓/资金快照。
4. `deploy_cpp/daily_init_bak/`：每日开盘前 `daily_init` 快照。
5. `deploy_cpp/report_bak/`：日终运行态文本快照。
6. `/home/u50_data/`：MD 录制 CSV。
7. `/data/u50_data/`：旧系统遗留行情（9.5G，上游不可达）。
8. `/var/lib/pgsql/16/data/`：本机 PG 数据目录。
9. `ops/db.conf`：DB + webhook 凭据。
10. `ors_server.cfg` / `*.secret.yaml`：CTP/飞书凭据。
11. `/root/quantlink-backups/`：CTP 凭据 `.bak`（同盘）。
12. `tbadmin/cfg/order_ref.json`、`cfg/*.dat`：tbadmin 日态（每天 `clear.sh` 清）。
13. `/var/log/quantlink/*`：体检/看门狗/同步日志。
14. `tbadmin/log/*`：admin/agent 日志。
15. `/usr/local/bin/tbstart*` 等 shim：可重装，不算真丢。
16. `crontab`：可从 `ops/crontab.txt` 重建，不算真丢；但**服务器上手工加的行会丢**（整份替换）。

### 7.9 备份改进（P，按优先级）

1. **先承认现状**：不要把 `tbhft_strategy_bak_sync_*`、`daily_init_bak`、`money_bak` 当异地备份；它们都在同一块盘。
2. **最小可交易恢复包**：git 远端 + `ors_server.cfg`/`ops/db.conf`/`strategy_sync.env` 的离线副本（加密、异机）+ 券商联系方式。这能保证坏盘后 2–4 小时恢复交易。
3. **日志/行情异地**：按 `RISK:150-158` 的候选，COS 同区是唯一可行；只跑增量（用户偏好，`RISK:160-164`）；备份必须 `copy` 不能 `move`；目标必须是独立存储（用 `df` 设备号/挂载点校验）；失败必须告警（`RISK:166-178`）。
4. **DB 逻辑备份 + PITR**：`pg_dump -Fc` 每天 + WAL 归档到独立存储；每季度恢复演练。参考 `quantlink-fin` 的 21 号文档，但不要混写。
5. **保留策略**：`log.bak` 按日期保留 N 天/压缩；`ctp_flow.bak` 加日期子目录（当前同名覆盖）；`/var/log/quantlink` 加 logrotate；`/home/u50_data` 按交易日保留。
6. **权限**：备份/归档目录 700/600；`ops/db.conf` 600；不要把凭据打进日志。
7. **演练**：至少做一次“坏盘换机”演练，记录 RTO；没有演练的 RTO 不算数。

---

## 8. 安全停机、重启与收盘

### 8.1 `squareoff` 的真实语义（代码级）

这是运维最容易误解的地方，单独讲清楚。

#### 8.1.1 信号路径

- `main.cpp:142-170`：
  - `SIGTSTP`（`tbstop`，kill -20）→ `m_onExit=true; m_onCancel=true; m_onFlat=true; HandleSquareoff()`。
  - `SIGTERM` 只有在 `./config/signal.txt` 存在且当前策略的 `m_origbaseName` 在文件里时才走同一路径；文件缺失/不匹配时 `Squareoff()` 直接 `return`，**进程不退出、不平仓**（`main.cpp:111-120`）。仓库没有 `signal.txt`（V：`find` 无结果），`docs/2026-09-23_策略库分析.md:205` 也明确记录“文件不存在时进程不退出”。
  - `SIGUSR1`（`tbstart`，kill -10）→ 清 flags、`m_Active=true`、`HandleSquareON()`，日志 `Strategy is active now.`。
  - `SIGUSR2`（`tbreload`）→ `LoadThresholds`，日志 `Strategy Thresholds Reset.`。
- `SIGTSTP` 默认动作是挂起进程；TradeBot 装了 handler 才不挂起。**如果进程刚启动、handler 未就绪，信号可能把进程挂起**（`ops_tb_signal.sh:25-27`）。所以只在日志出现 `Strategy is active now.` 后操作；如果发现进程状态是 `T`（stopped），先 `kill -CONT <pid>` 恢复，再判断是否需要 `tbstop`/`tbstart`。

#### 8.1.2 PairwiseArb 的 `HandleSquareoff()`

`PairwiseArbStrategy.cpp:1024-1036`：

```text
if (Exposure() == 0 && !HasUnTradedOrder()) {
    HandleSquareoffNow();      // 撤单 + deactivate + 写 daily_init
} else {
    m_wating_stop = true;
    CancelAllUnTradeOrders();  // 只撤单，不发平仓单
}
```

- `m_wating_stop` 状态下，`SendOrder()` 不再发新单（`:199-206`），只在收到 `TRADE_CONFIRM` 时按 `exposure` 对冲（`:535-560`）。
- 如果之后没有成交回报，exposure 不会自动归零；`HandleSquareoffNow` 也不会被调用。
- 因此：**“tbstop = 平仓”只在 exposure 已经为 0 或后续有成交回报时成立**。它不是“市价平掉所有持仓”的保证。

#### 8.1.3 收盘时间路径

- `EndTimeEpoch()`（`:970-1010`）：
  - 有挂单 → 撤单/等在途；不立刻平。
  - 无挂单 + netpos=0 → `HandleSquareoffNow()`。
  - 无挂单 + netpos!=0 → `m_Active=false`，10 tick 后 `HandleSquareoffNow()` + `pos uneven!` 告警。
- `EndTimeAggEpich()`（`:951-968`）：到 `endTime-60s` 强制 `m_aggFlat=true` + `HandleSquareoffNow()`。
- `HandleSquareoffNow()`（`:1039-1056`）：取消未成交单、设 flags、`m_Active=false`、`SaveMatrix2("../data/daily_init.<sid>")`、上报；**没有 `SendNewOrder` 平仓**。

#### 8.1.4 基类 `ExecutionStrategy::HandleSquareoff()` 有平仓单

`ExecutionStrategy.cpp:2385-2465` 的基类实现会在无挂单时按 `m_netpos` 发 `SELL/BUY`（`m_aggFlat` 时用 CROSS/QUOTE）。但 **PairwiseArb 重写了 `HandleSquareoff()`，不调用基类**（`:1024`）。所以：

- 对 PairwiseArb（当前生产策略类型）：不要期待 `tbstop` 自动市价平仓。
- 对基类策略（如果将来用别的策略类型）：基类会发平仓单，但仍受行情/涨跌停/拒单影响，不保证成交。

#### 8.1.5 与文档/注释的冲突

- `ops/crontab.txt:23-26` 写“收盘前停手由策略内部完成……自动平仓 + deactivate”；代码显示 `HandleSquareoffNow` 只撤单/停用/写 `daily_init`，**不平仓**。这是 **V 代码 vs V 注释冲突**，以代码为准。
- `.claude/CLAUDE.md:675` 的“daily_init 自动修正”同样是 P/错误（见 6.6）。

### 8.2 `stop_all.sh` 的顺序与超时

`build_deploy_cpp.sh:679-745`（生成的 `deploy_cpp/bin/scripts/stop_all.sh`）：

1. 遍历 `trader.*.pid`：`kill -TERM <pid>`，删 pid 文件。**注意**：TERM 是否触发 squareoff 取决于 `./config/signal.txt`；文件缺失时 handler 直接返回，进程继续活着。
2. 最多等 **10 秒**：`pgrep -f "TradeBot"` 为空则 break。
3. 还活着 → `pkill -9 -f "TradeBot"`（**硬杀**）。
4. `memlog-reader`：`TERM` → `pkill -f`。
5. ORS：`pkill -TERM -x ors_server`；最多等 **90 秒**（`ORS_WAIT_SEC`）；还活着 → `pkill -KILL -x ors_server`。
6. `ipcrm` 清当前用户全部 SHM（m/s/q）。
7. `rm -f .gateway_mode`。
8. `sync_data_back.sh`（deploy → data_cpp）。

**风险点**：

- 10 秒对“撤单 + 等成交回报 + 对冲”通常不够；如果 `tbstop` 后还有挂单/持仓，`kill -9` 会中止 squareoff，`daily_init` 不会写。
- `pkill -f "TradeBot"` 是宽匹配，可能误杀 `tail -f .../TradeBot...` 之类。
- `ipcrm` 清**所有**当前用户 SHM，不只是交易的 4 个；同机其它 SHM 应用会被破坏。
- ORS 90 秒是硬等；如果 CTP release 超过 90 秒，SIGKILL 可能导致柜台会话未释放，下一次登录可能被拒/互踢。
- `sync_data_back` 在 stop 之后跑；如果 `position.csv` 是旧的（ORS 被 KILL），会把旧值覆盖到 `data_cpp`（见 7.3.4）。

### 8.3 ORS 等待与 CTP 会话释放

- 实测 ORS `pkill` 后约 **70 秒**才走完 CTP Release，并可能在 `libthostmduserapi_se` 里崩一次；每次约 180MB core；2026-10-29 单日 2.4GB（`build_deploy_cpp.sh:339-345`）。
- 所以 `stop_all` 默认等 90 秒；不要提前起新 ORS。
- ORS 默认 `ulimit -c 0`，避免 core；需要现场时用 `CORE_LIMIT=unlimited ./scripts/start_ors.sh ctp`（`:362-363`）。
- 如果 ORS 在 90 秒内没退出，脚本 SIGKILL；此后至少等几秒再起新实例，并观察 CTP 登录是否被拒。

### 8.4 `position.csv` 与 `daily_init` 的前后处理

**停止前**：

```bash
# 记录当前状态
date
pgrep -af -- '--strategyID'
cat deploy_cpp/bin/live/data/position.csv
for f in deploy_cpp/data/daily_init.*; do echo "== $f"; cat "$f"; done
# 记录挂单（Dashboard）
curl -s http://127.0.0.1:28080/api/orders > /tmp/orders_before_stop.json
```

**停止后**：

```bash
# position.csv 应是本次 stop 之后写的新文件
ls -l --time-style=full-iso deploy_cpp/bin/live/data/position.csv
# daily_init 应是本次 squareoff 写的新文件
ls -l --time-style=full-iso deploy_cpp/data/daily_init.*
# 与 data_cpp 对比
for f in deploy_cpp/data/daily_init.*; do
  b=$(basename "$f"); diff -q "$f" "data_cpp/data/$b" || echo "DIFF $b"
done
diff -q deploy_cpp/bin/live/data/position.csv data_cpp/bin/live/data/position.csv || echo "POSITION DIFF"
```

**如果 `position.csv` mtime 还是开盘时间**：ORS 没正常 `Stop()`（被 KILL/崩溃）；不要把它当最终持仓；按 6.12 重启 ORS 重查，或人工对账。

**如果 `daily_init` 没更新**：squareoff 没走到 `HandleSquareoffNow`（被 KILL/持仓未平/DB 异常）；按 6.6 人工核对，不要直接次日开盘。

### 8.5 撤单

- `tbstop <sid>` → `HandleSquareoff()` → PairwiseArb 的 `CancelAllUnTradeOrders()`（`PairwiseArbStrategy.cpp:1035`）。
- `stop_all` 的 `TERM` 只有在 `./config/signal.txt` 存在且列出该品种时才走同一路径；否则不会撤单/平仓，10s 后被 SIGKILL。不要把 `stop_all` 当撤单手段。
- Dashboard 的 `manual_order.enabled` 是 `false`（`memlog-reader.yaml:18-19`），不要依赖页面手动下单/撤单；用券商终端/管理面（如果启用）。
- 撤单后必须确认 `CANCEL_ORDER_CONFIRM` 或柜台侧已撤；没有回报时按 6.5 处理。

### 8.6 停止前/后检查单

**停止前**

- [ ] 当天是否交易日、是否已过 `endTime`（14:57）
- [ ] 所有策略 `active` 状态；是否有 `m_wating_stop`
- [ ] Dashboard 挂单表；是否有长时间未成交单
- [ ] `position.csv`/`daily_init` 当前值已记录
- [ ] 券商 App 持仓已记录（截图/导出）
- [ ] 当天日志已备份到 `/root/incident_<date>/`（如果怀疑异常）
- [ ] 磁盘余量足够写快照/日志

**停止后**

- [ ] `pgrep` 无 ORS/TradeBot/memlog/check-md/md-recorder
- [ ] `ipcs -m` 无当前用户 SHM
- [ ] `position.csv` mtime 是 stop 之后
- [ ] `daily_init` 与 `data_cpp` 一致
- [ ] `report_bak` 有当天文件且非空
- [ ] `money_bak` 有 pm 快照
- [ ] `git log` 有 15:20 提交；`git status` 干净（除已知运行时文件）
- [ ] `.fee_refresh.ok` 是当天 15:40 之后
- [ ] `cron_feed_db.log` 末尾 `ops_feed_db 完成`
- [ ] 无 core 文件/磁盘未满

### 8.7 禁止事项（复刻时写进值班手册）

1. **盘中重启 TradeBot**（持仓计数器/均价重置；`daily_init` 不是实时值）。
2. **11:30–13:00 重启 ORS**（CTP `ReqQryInstrument` 失败；`STARTUP_GUIDE.md:365`）。
3. **旧 ORS 未退出就起新 ORS**（CTP 双登录互踢；D15）。
4. **进程还在就 `ipcrm` 清 SHM**。
5. **`kill -9` TradeBot 前不确认 squareoff 已结束**。
6. **边跑边改 `daily_init`**。
7. **`crontab -e` 手工加行**（下一次整份替换会被静默清掉；`ops/crontab.txt:27-32`）。
8. **跑 `bktblog.py`**（`shutil.move` + 假 `/mnt/hft`，会把日志搬进同盘假挂载；`RISK:166-178`）。
9. **删 `log.bak`/`position.csv`/`daily_init` 前不复制**。
10. **把 `position.csv` 当实时持仓**。
11. **把 `tbstop` 当“必然平光”**。
12. **随手 `stop_all_with_tbadmin.sh`**（会杀 tbadmin、清所有 SHM；只适合完全停机）。

---

## 9. 变更管理

### 9.1 变更分类与窗口

| 类型 | 例子 | 建议窗口 | 是否需停会话 | 回滚 |
|---|---|---|---|---|
| 配置/control/model | 换月、阈值、合约对 | 收盘后 15:30–17:00 或周末 | 是（改 control/model 最好停策略） | `git checkout` + `--config-only` + 重启 |
| 策略库 | RDS `tbhft_strategy` | 10:30/20:30 同步后；重启 admin | 否（运行中策略不读表） | RDS 回滚 + 同步 + 重启 admin |
| fee.csv | 交易所费率/合约 | 15:40 刷新窗口 | 否（ORS 停机窗口） | git 回滚 fee.csv |
| 交易日历 | 年度/临时休市 | 收盘后 | 否 | git 回滚 + 复制到 deploy |
| 代码 | ORS/TradeBot/tbadmin/脚本 | 收盘后/周末 | 是 | `git checkout <prev>` + 重建 |
| cron | 新增/调整任务 | 收盘后 | 否 | 恢复 `/root/crontab_backup_*.txt` |
| 数据库 schema | 新表/列 | 收盘后 | 是（tbadmin/脚本可能依赖） | 备份表/DDL 回滚 |

**原则**：盘中只做“止损/撤单/停用”，不做配置/代码变更；任何变更前先备份 crontab、`daily_init`、`position.csv`、当前 `fee.csv`、当前配置。

### 9.2 配置 / control / model

#### 9.2.1 事实源与部署副本

- 源：`data_cpp/bin/{config,controls,models}`。
- 部署：`deploy_cpp/bin/{config,controls,models}`。
- `build_deploy_cpp.sh --config-only`：**覆盖模式** `cp -R data_cpp/bin/{config,controls,models}/. deploy_cpp/bin/...`（`build_deploy_cpp.sh:148-167`）。适合“只改配置”。
- 全量 build：`cp -Rn`（存在即跳过，保留运行时修改），并 `prune_stale_renamed` 删除“源头已改名”的 control/model（`build_deploy_cpp.sh:790-830`）。
- `trading_days.txt` 是特例：build 时**无条件覆盖**（`build_deploy_cpp.sh:830` 附近注释），因为它是纯派生数据；其它 `data_cpp/data/*` 是“存在即跳过”，人工改动不会自动到 deploy。
- `--config-only` **不碰** `data/` 运行时数据（`daily_init`/`position.csv`），只建 `live/data` 目录（`build_deploy_cpp.sh:162-167`）。

#### 9.2.2 换月/改 control/model

1. 停相关策略（`tbstop <sid>`，确认退出）。
2. 改 `data_cpp/bin/controls/{day,night}/control.*` 和 `models/model.*`；文件名里的合约对要与内容一致。
3. `./scripts/build_deploy_cpp.sh --config-only`（或全量 build）。
4. **检查 deploy 侧没有旧的同名 SID 文件**：`ls deploy_cpp/bin/controls/*/control.*.par.txt.<sid>` 只能有一个；`prune_stale_renamed` 只在全量 build 时跑。
5. `python3 scripts/ops_f_contract_check.py` 预检 `_F_` 解析/两腿顺序/fee 覆盖。
6. 启动策略，检查日志 `Control File:`、`daily_init`、第一笔报价。
7. 如果换月导致 `daily_init` 合约名变化：按 6.6 处理，不要直接沿用旧文件。

#### 9.2.3 `ACCOUNT` / `MAX_*` / `DSN`

- `ACCOUNT` 必须在 `StrategyConfig.cfg` 里显式为 `OWN`；缺失会静默用代码默认 `PRP05`（`ExecutionStrategy.cpp:16,59,66`）。
- `MAX_POS_SIZE` 在 TradeBot 里是**累计成交量上限**（`m_maxTradedQty`），不是持仓上限；持仓限制在策略参数 `MAX_SIZE/BID_MAX_SIZE/ASK_MAX_SIZE`。改之前读 `02-runtime-strategy`。
- `DSN`：如果不需要写 DB，留空；否则注意 6.8 的 squareoff 风险。

### 9.3 策略库同步（RDS → 本地）

- 任务：`30 10,20 * * 1-5 flock -n /tmp/strategy_sync.lock python3 tools/strategy_sync/sync_tbhft_strategy.py --apply`（`ops/crontab.txt:67`）。
- 规则：以 RDS `id` 为键；新增/更新/删除；本地独有行永不改；`--apply` 单事务 + 写前备份表 + 修正序列（`sync_tbhft_strategy.py:5-18,212-235`）。
- RDS 批次（`max(imported_at)`）不变时跳过（`:15`）。
- **tbadmin admin 只在启动时读策略表**（`admin.cpp:595-606,4450-4459`）；所以：
  - 日盘：08:30 重启 admin 加载“昨夜 20:30”同步的结果。
  - 夜盘：20:30 重启（当前被注释）加载 20:30 同步。
  - 10:30 的同步在盘中写库，不影响运行中的策略；但 admin 前端可能显示旧列表，直到下次重启。
- 备份表 `tbhft_strategy_bak_sync_*` 保留 10 张（`BACKUP_KEEP=10`）；同盘，不是异地备份。
- 配置 `/root/.quantlink/strategy_sync.env` 600；不要提交。

### 9.4 `fee.csv`

- 生成：`ops_refresh_fee.sh apply`（15:40）调 `deploy_cpp/bin/fee_refresh`，从 CTP 直查；失败**不写文件**（`ops_refresh_fee.sh:110-147`）。
- 门控：非交易日跳过；日历缺失/为空 fail-closed（`:69-80`）。
- 锁：`flock -n /tmp/fee_refresh.lock`；拿不到锁跳过本轮（`:102-108`）。
- 成功戳：`deploy_cpp/bin/log/.fee_refresh.ok`（`:155-160`）；`ops_check_status` 检查项 9 靠它判“刷新链路是否成功过”。
- git：只 add `data_cpp/data/fee.csv`，commit + push；push 失败不算刷新失败（`:172-186`）。
- **前置**：必须在 ORS 停机窗口（15:05 停、20:13 起）内跑，避免同 `INVESTOR_ID` 并发登录踢掉 ORS（`ops/crontab.txt:78-86`）。如果 15:05 停会话失败，15:40 不要跑 fee_refresh；先确认 `pgrep -x ors_server` 为空。
- 验证：`grep ',<合约>,' /home/hft/tbdata/fee.csv`；`ops_f_contract_check.py`；`ops_check_status` 检查项 9。

### 9.5 交易日历

- 文件：`data_cpp/data/trading_days.txt`，每行 `YYYYMMDD`，升序（`is_trading_day.sh:4,50-54`）。
- 年度巡检：`10 6 2 1 * python3 tools/trading_calendar/update_trading_days.py --check`（`ops/crontab.txt:103`）；只提醒不写。
- 门控：
  - `--today`：今天不在日历 → rc=1（非交易日）或 rc=2（日历过期/故障）；调用方 fail-closed。
  - `--night-ok`：今天交易日 + 下一交易日距今 ≤3 天；节前夜盘取消。
- **双副本**：外层 `ops_start_session` 读 `data_cpp/data/trading_days.txt`；内层 `start_all.sh` 优先读 `deploy_cpp/data/trading_days.txt`（`build_deploy_cpp.sh:546-575`）。build 会无条件覆盖 deploy 副本，但如果你手工只改 data_cpp、没 build，内层可能仍旧日历。
- 变更步骤：改 data_cpp → `build_deploy_cpp.sh --config-only`（或全量）→ 核对两份 `tail -3` → `is_trading_day --today/--next/--night-ok` 验证。
- 风险：日历过期/缺失会让 `ops_start_session` fail-closed（不启动），而不是“照常启动”；这是有意的安全设计。

### 9.6 代码部署 / 回滚

#### 9.6.1 部署

1. 确认非交易时段（收盘后/周末）；`pgrep` 无 ORS/TradeBot。
2. 备份：`crontab -l > /root/crontab_backup_...`；`cp -a deploy_cpp /root/deploy_cpp.bak.<ts>`（如果空间允许）；记录当前 commit。
3. `git pull`（或 checkout 目标 commit）；确认 `git status` 干净。
4. `./scripts/build_deploy_cpp.sh`（或 `--ors`/`--trader`/`--config-only`）。
5. 检查 `deploy_cpp/bin/` 的二进制、配置、controls/models；`ldd`/`--version`（如果有）。
6. 启动会话；验证登录/持仓/行情/最小单。
7. 更新 `docs/version-matrix` 类记录（如果有）。

#### 9.6.2 回滚

1. 停会话（`ops_stop_session.sh day`）。
2. `git checkout <上一个已知良好 commit>`；`./scripts/build_deploy_cpp.sh`。
3. 如果配置/DB 也变了：回滚 `data_cpp` 配置 + `fee.csv` + `trading_days.txt`；DB 用备份表/DDL 回滚。
4. 启动/验证（同部署）。
5. **注意**：`deploy_cpp` 没有版本化产物仓库；回滚依赖 git + 重建。保留旧 `deploy_cpp` 副本是手工步骤，不是自动。

#### 9.6.3 不能回滚的东西

- 已经被 TradeBot 写过的 `daily_init`/`position.csv`（git 只保留提交点；盘中值不可重建）。
- 已经被 `clear.sh` 清掉的 `tbadmin/cfg/*.dat`/`order_ref.json`。
- 已经轮转/覆盖的 `ctp_flow.bak`。
- 已经发给柜台的订单/成交。

### 9.7 cron 变更（最容易出事）

- `ops/crontab.txt` 是**整份替换**安装：`crontab ops/crontab.txt`。任何只在服务器 `crontab -e` 加的行，下一次重装会被**静默清掉**（`ops/crontab.txt:27-32` 的 strategy_sync 血泪案例）。
- 变更流程：
  1. `crontab -l > /root/crontab_backup_$(date +%Y%m%d_%H%M%S).txt`
  2. 改 `ops/crontab.txt`（只在生效段加行；不要把说明写成会被执行的行）。
  3. `crontab ops/crontab.txt`
  4. `crontab -l | egrep -v '^#'` 对照；确认新行在、旧行没丢。
  5. 在下一个触发点看日志；或手工跑一次脚本（注意副作用/告警）。
- 夜盘开关用 `ops_night_session.py`，不要手工编辑受管块；`normalize` 会删块外匹配行，先备份。
- 加任务时注意：
  - 是否需要 `flock`（git/DB/重启类）。
  - 是否需要日历门控。
  - 是否会与 15:15 轮转/15:20 git/15:40 fee/17:00 feed 抢资源。
  - 失败是否有告警（否则只写日志）。

### 9.8 变更后验证清单

- [ ] `crontab -l` 与 `ops/crontab.txt` 一致（除注释）。
- [ ] `git status` 干净；`git log -1` 是预期 commit。
- [ ] ORS 登录/持仓查询完成；MD head 增长。
- [ ] 每个预期 SID 一个进程；`active=true`；无重复。
- [ ] `fee.csv`/`contractfile`/`trading_days.txt` 被正确读取。
- [ ] 最小单（评测/生产按规程）能报/能撤/能成交/能平。
- [ ] `position.csv`/`daily_init`/券商一致。
- [ ] 日志/告警/快照/DB feed 正常。
- [ ] 回滚方案已记录（commit/备份路径）。

---

## 10. 复刻要点

### 10.1 最小运维栈

| 层 | 最小要求 | 说明 |
|---|---|---|
| OS | Linux（190 是 el9 系） | 需要 SysV SHM、`/proc`、`ipcs`、`pgrep`、`flock`、`timeout` |
| 时间 | chrony + 06:00 `makestep` | 订单时间戳/日志对齐 |
| 调度 | cron（整份 `ops/crontab.txt`） | 不用 systemd timer；所有任务按 CST |
| Shell 工具 | bash、coreutils、`curl`、`flock`、`psql`、`git`、`ss`、`ipcs`、`pgrep`、`stat` | `ops_md_liveness` 用 `timeout`；`stat` 有 GNU/BSD 双写法 |
| Python | 3.9+，`psycopg2` | `ops_feed_db`；`ops_eod_report`/`ops_f_contract_check` 只用 stdlib |
| DB | PostgreSQL 16 本机 | `dbtrade`；无 PITR |
| CTP | CTP SDK 6.7.11/6.7.13 SE + 券商前置 | ORS/TradeBot/fee_refresh |
| tbadmin | ZMQ/protobuf/libpqxx/YD | admin/agent |
| Go 工具 | `memlog-reader`、`check-md`、`md-recorder` | 黑盒；端口/退出码是契约 |
| 日志 | logrotate（可选）+ 本地归档 | `ops_rotate_logs` 是主轮转；logrotate 只补 tbadmin |
| 监控 | webhook（或替代）+ Dashboard + tbadmin 前端 | 当前默认静默；复刻时至少接一个可达通道 |
| 备份 | 独立存储（对象存储/另一台机） | 当前没有；复刻时不要省 |

> 小坑：`ops_install_deps.sh:21` 的环境核查列表里是 `ntpdate`，但实际 cron 用的是 `chronyc`（`ops/crontab.txt:39`）。`MISS ntpdate` 不等于“没有校时”；以 `chronyc tracking` 为准。

### 10.2 必须复刻的机制（少一个就会行为不同）

1. **crontab 整份替换**，禁止 `crontab -e` 作为持久变更。
2. **交易日历门控**（`is_trading_day`，fail-closed；`--night-ok` 节前取消）。
3. **Live 模式默认 inactive + 人工/定时激活**；不要假设进程起来就会交易。
4. **“一策略一进程”**（`--strategyID` 精确匹配），不要用多策略循环的遗留路径。
5. **SHM 契约**：789/4097/8193/12289/16385；`MD_SHMSIZE=2048` 与 agent `MD_LEN_LIST=2048` 一致。
6. **ORS 90s 等待 + 双启动拒绝**；CTP 双登录的代价必须写进值班手册。
7. **`position.csv` 只读时点 + `daily_init` 策略真相**；不要虚构“自动修正”。
8. **`tbstop` 语义**（撤单 + 停用，不保证平仓）；收盘检查必须看券商。
9. **cooldown/stamp/pid 状态文件**：preopen/md_liveness 冷却、fee 成功戳、`trader.*.pid`、`check-md.pid`、`memlog-reader.pid`、`md-recorder.pid`、`agent.pid`/`admin.pid`。
10. **日志轮转按文件名日期分目录**，避免日夜同名覆盖；`ctp_flow.bak` 要加日期（当前是反例）。
11. **15:20 git 同步 + 15:40 fee 刷新 + 17:00 feed** 的顺序；不要打乱（git index 锁、ORS 停机窗口）。
12. **`strategies.disabled` + `--config-only` + `prune_stale_renamed`**：换月/停用/改名三件事要一起考虑。
13. **告警空值守卫**：`WECHAT_WEBHOOK` 为空时只写日志；复刻时要么接通道，要么明确接受“无告警”。
14. **`MEMLOG_READER_CONFIG` 端口覆盖**：8080 被占时走 28080/28081；eod/看门狗/start_all 都读这一行。
15. **cron 与日志轮转的时序**：15:05 停、15:15 轮转、15:16 快照、15:20 git、15:40 fee、17:00 feed；任何一项挪动都要重新核对。

### 10.3 验收演练（建议至少做一遍）

| # | 演练 | 操作 | 通过标准 | 注意 |
|---|---|---|---|---|
| 1 | 非交易日门控 | 把 `TDFILE` 指到不含今天的日历，跑 `ops_start_session.sh day` | 退出 0，不启动 ORS/TradeBot | 不要改生产日历；用临时文件/环境变量 |
| 2 | 日历故障 fail-closed | 把 `TDFILE` 指到空文件 | 退出 1，告警，不启动 | 验证调用方不会“照常启动” |
| 3 | ORS 崩溃自愈 | 交易时段 `kill -9 ors_server` | 5 分钟内 `md_liveness` 拉起；无重复；持仓查询完成；策略重新激活（92221/92222） | 92204 需人工激活；不要在持仓未平时做 |
| 4 | MD 静默断连 | 模拟 FIN/断网（测试环境）；或 `kill -STOP` ORS 让 head 不增 | `check-md`/`md_liveness` 告警；15s 探针触发重启；无双登录 | 生产慎做；优先在评测环境 |
| 5 | TradeBot 崩溃 | `kill -9` 一个 SID | 不自动重启（按设计）；人工按 6.3 恢复；无重复订单 | 盘中不做；收盘后做 |
| 6 | 策略未激活 | 启动后不 `tbstart` | Dashboard `active=false`；`tbstart` 后日志 `Strategy is active now.` | 验证 92204 不在 09:05 自动链里 |
| 7 | fee 缺失 | 临时改名 `fee.csv`，启动一个策略 | 日志 `Error in finding Transaction Charges`，`exit(1)`；检查项 8 报 ALERT | 恢复文件；不要在盘中做 |
| 8 | DB 挂 | `systemctl stop postgresql-16` | `ops_feed_db` 告警；tbadmin 行为记录；TradeBot（无 DSN）不受影响 | 不要在收盘 squareoff 时做（6.8） |
| 9 | 磁盘告警 | 临时把根分区用到 >90%（测试机） | 00:00 `ops_check_status` 告警；手工 `df` 可见 | 不要在生产做 |
| 10 | 重复 ORS | 手工再起一个 `ors_server` | 第二个被拒绝；`pgrep -c` 仍为 1 | 不要绕过脚本直接起 |
| 11 | 陈旧 daily_init | 改一个 `daily_init` 的 `ytd1`，启动策略 | 策略按改后的值跑；ORS 不会自动改它 | 验证“无自动修正” |
| 12 | webhook 可达 | 用测试 webhook 触发一个告警 | 收到消息；日志无 `[WARN]` | 不要用生产群；不要打印 URL |
| 13 | 日志轮转 | 手工跑 `ops_rotate_logs.sh` | 文件进 `log.bak/<date>/`；无覆盖；`cron_*` 带日期 | 确认没有进程在写关键文件 |
| 14 | crontab 重装 | `crontab ops/crontab.txt` | 生效行与文件一致；strategy_sync/夜盘块状态正确 | 先备份 |
| 15 | 坏盘恢复 | 在临时主机按 7.6 走一遍 | 能启动、能登录、能下最小单、RTO 记录 | 至少一次；否则 RTO 不算 |

### 10.4 监控缺口优先级（复刻时先补哪些）

| 优先级 | 缺口 | 建议实现 | 代价 |
|---|---|---|---|
| P0 | 逐策略进程/active 对账 | 期望 SID 集合 vs `pgrep -af -- '--strategyID'` + Dashboard `active` | 小脚本 + cron 5min |
| P0 | 订单/回报心跳 | ORS 日志计数或 `/api/orders` 更新时间；60s 无变化告警 | 小脚本；需要定义“正常” |
| P0 | 告警可达 | 接一个真实通道；P0/P1 分级；重复提醒 | 组织流程 > 代码 |
| P1 | 持仓一致性 | 每日收盘 `position.csv`/`daily_init`/券商对账；差异告警 | 需要券商数据源/人工 |
| P1 | DB 可用/新鲜度 | `pg_isready` + 表行数/`max(trading_day)` | 小脚本 |
| P1 | 盘中磁盘/inode | 每 15 分钟 `df`；>90% 告警 | 小脚本 |
| P2 | 日志新鲜度 | 交易时段内 `find log -mmin` + 策略心跳 | 需要避免午休误报 |
| P2 | check-md/md-recorder 看门狗 | pid + 端口/日志 | 小脚本 |
| P2 | git push 校验 | `git rev-parse` 本地 vs 远端；失败告警 | 小脚本 |
| P3 | NTP 校验 | `chronyc tracking` 偏移阈值 | 小脚本 |

### 10.5 改进路线（按“最小完整改动”）

1. **先修“会骗人”的检查**：
   - `ops_check_status` 00:00 的夜盘误报：夜盘停用时跳过进程检查，或把 `IN_SESSION` 与夜盘开关联动。
   - `ops_check_status` 检查项 3 的日志路径：同时扫 `log.bak/<date>/`，或把检查挪到 15:05 前。
   - `ops_preopen` 的 08:55→09:00 冷却：失败时不写冷却/或 09:00 强制重试。
2. **再修“会丢数据”的路径**：
   - `sync_data_back` 的 `position.csv` 加 mtime/内容校验，禁止旧覆盖新。
   - `PairwiseArbStrategy::HandleSquareoffNow` 先写 `daily_init` 再连 DB；DB 失败不阻断文件。
   - `stop_all` 的 TradeBot 等待从 10s 提到可配置（如 60s），或在 `tbstop` 后等 `m_wating_stop` 清零。
3. **再补“看不见”的监控**：
   - 逐策略对账、订单/回报心跳、DB 可用/新鲜度、盘中磁盘、日志新鲜度。
4. **最后做“能恢复”的备份**：
   - 最小恢复包（git + 凭据离线）→ 日志/行情增量到 COS → DB `pg_dump` + WAL/PITR → 季度恢复演练。
5. **安全清理**：
   - `ops/db.conf` 600；去掉 DSN 日志；`config_CHINA.*` 不再写 DSN；`log.bak`/`ctp_flow.bak` 权限收紧。

> 不要一次全做。先做 1（避免误报/漏报骗人），再做 2（避免坏数据覆盖），再做 3（看见），最后做 4（恢复）。顺序反了会出现“有备份但没人知道系统已经坏了”。

---

## 11. 证据索引

> 说明：V=直接读代码/配置/脚本；I=结构推断/现场未验证；P=计划/文档未实现。行号以 commit `5cee3dd` 为准。

### 11.1 调度与启停

| 结论 | 证据 | 类型 |
|---|---|---|
| crontab 整份替换；`crontab -e` 会被清 | `ops/crontab.txt:8,27-32` | V |
| 日盘 08:50 启动、15:05 停止 | `ops/crontab.txt:43,47` | V |
| 夜盘块整体注释 | `ops/crontab.txt:923-939` | V |
| 21:01 check-md / 21:35 memlog 仍生效；09:20/14:50 delta 是日盘任务 | `ops/crontab.txt:111,115,942-943` | V |
| 00:00 主检查 | `ops/crontab.txt:99` | V |
| 20:50 evening 被注释 | `ops/crontab.txt:923-939` | V |
| 08:28 stop_agent 连 admin 一起杀 | `tbadmin/stop_agent.sh:8-13` | V |
| 08:30 先 agent 后 admin | `ops/crontab.txt:920-921` | V |
| `ops_start_session` 日历门控/残留清理 | `scripts/ops_start_session.sh:28-61` | V |
| `start_all` 内层日历门控（deploy/data 优先） | `scripts/build_deploy_cpp.sh:546-575` | V |
| `start_all` 启动顺序/跳过 disabled/汇总失败 | `scripts/build_deploy_cpp.sh:600-661` | V |
| `ops_stop_session` 先 eod 再 stop | `scripts/ops_stop_session.sh:33-38` | V |
| `stop_all` TERM→10s→KILL；ORS 90s；ipcrm | `scripts/build_deploy_cpp.sh:679-745` | V |
| `start_ors` 双启动拒绝、core 默认 0、ipcrm | `scripts/build_deploy_cpp.sh:358-369` | V |
| `start_strategy` pid + pgrep 查重 | `scripts/build_deploy_cpp.sh:461-477` | V |
| `ops_setup_arbi` 20:10、亲和校验、sections | `scripts/ops_setup_arbi.sh:1-17,45-58,79-124,138-152` | V |
| 夜盘块开关/normalize | `scripts/ops_night_session.py:31-46,115-142` | V |

### 11.2 健康检查/看门狗

| 结论 | 证据 | 类型 |
|---|---|---|
| `ops_check_status` 9 项、聚合告警 | `scripts/ops_check_status.sh:1-23,40-52` | V |
| 检查 1 git 漂移 | `scripts/ops_check_status.sh:54-60` | V |
| 检查 2 日历覆盖 | `scripts/ops_check_status.sh:62-77` | V |
| 检查 3 费率日志（00:00 读不到轮转后的日志） | `scripts/ops_check_status.sh:79-134`；`ops_rotate_logs.sh:35-61` | V（逻辑） |
| 检查 4 进程仅 `pgrep -x TradeBot` | `scripts/ops_check_status.sh:136-171` | V |
| 检查 5 根分区 >90% | `scripts/ops_check_status.sh:173-177` | V |
| 检查 6 daily_init 漂移方向 | `scripts/ops_check_status.sh:179-209` | V |
| 检查 7 contractfile 三家族/行数 | `scripts/ops_check_status.sh:211-253` | V |
| 检查 8 `_F_` 事前预检 | `scripts/ops_check_status.sh:255-286` | V |
| 检查 9 fee 刷新戳 | `scripts/ops_check_status.sh:288-346` | V |
| 00:00 夜盘窗口误报 | `scripts/ops_check_status.sh:141-153`；`ops/crontab.txt:99-101` | V/I |
| 逐策略缺口（死 3 个仍过） | `ops/crontab.txt:196-203` | V（文档自述） |
| 面板死后仍显示 running | `ops/crontab.txt:725` | V（文档自述） |
| preopen 08:48-09:04、600s 冷却、head 判据 | `scripts/ops_preopen_check.sh:60-64,78-104,133-147` | V |
| preopen 只激活 92221/92222 | `scripts/ops_preopen_check.sh:29,99-101` | V |
| md_liveness 窗口/15s/1800s/只激活 92221/92222 | `scripts/ops_md_liveness_watchdog.sh:68-71,126-133,148-196` | V |
| check-md stale 5s / throttle 60s | `data_cpp/bin/config/check-md.yaml` | V |
| memlog 看门狗只“不存在才拉起” | `scripts/ops_watchdog_memlog.sh:19-44` | V |
| tbadmin 看门狗只 pid、失败静默 | `scripts/ops_ensure_tbadmin.sh:13-25` | V |
| check-md start/stop/查重 | `scripts/ops_check_md.sh:26-55` | V |

### 11.3 策略/持仓/信号

| 结论 | 证据 | 类型 |
|---|---|---|
| Live 模式默认 inactive | `tbsrc/Strategies/ExecutionStrategy.cpp:390-392` | V |
| SIGTSTP → squareoff；SIGTERM 需 `./config/signal.txt`，文件缺失时不退出；USR1 激活；USR2 reload | `tbsrc/main/main.cpp:111-170`；`docs/2026-09-23_策略库分析.md:205` | V |
| Pairwise `HandleSquareoff` 只撤单/等回报 | `tbsrc/Strategies/PairwiseArbStrategy.cpp:1024-1036` | V |
| wating_stop 下只在 TRADE_CONFIRM 对冲 | `PairwiseArbStrategy.cpp:535-560,623` | V |
| 收盘 endTime-180s/60s；`HandleSquareoffNow` 不平仓 | `ExecutionStrategy.cpp:44-47`；`PairwiseArbStrategy.cpp:951-1010,1039-1056` | V |
| 基类 HandleSquareoff 有平仓单，但 Pairwise 不调用 | `ExecutionStrategy.cpp:2385-2465`；`PairwiseArbStrategy.cpp:1024` | V |
| `daily_init` 只读、不自动修正 | `PairwiseArbStrategy.cpp:24-46`；`ORSServer.cpp:1500-1560` | V |
| `position.csv` 只写启动/空仓/关机 | `ORSServer.cpp:207-233,264,1430-1444,1557-1558` | V |
| ORS 持仓查询失败 3 次降级启动 | `ORSServer.cpp:2032-2040` | V |
| ORS 登录失败 5 次退避后 exit | `ORSServer.cpp:2066-2099` | V |
| ACCOUNT 默认 PRP05；配置 OWN | `ExecutionStrategy.cpp:16,59,66`；`StrategyConfig.cfg:1` | V |
| 92204 不在 09:05 自动激活 | `ops/crontab.txt:46`；`ops_preopen_check.sh:29`；`ops_md_liveness_watchdog.sh:37` | V |
| 92221 两个 control；glob 取第一个 | `data_cpp/bin/controls/day/`（`ls`）；`build_deploy_cpp.sh:445-449` | V/I |

### 11.4 数据/日志/告警

| 结论 | 证据 | 类型 |
|---|---|---|
| 日志轮转 15:15；`log.bak/<date>/`；cron 加日期 | `scripts/ops_rotate_logs.sh:29-63` | V |
| `ctp_flow.bak` 同名覆盖 | `scripts/ops_rotate_logs.sh:65-69` | V |
| logrotate 只覆盖 admin.log；无安装器 | `ops/logrotate/quantlink-tbadmin:1-13`；全文搜索无安装调用 | V |
| `/var/log/quantlink` 无轮转 | 各脚本 `exec >>`；无 logrotate 条目 | V |
| 策略日志 DSN（若非空） | `tbsrc/Strategies/ExecutionStrategy.cpp:72` | V |
| tbadmin 配置写 DSN + chmod 0755 | `tbadmin/admin.cpp:1816,1825` | V |
| tbadmin 硬编码 DB 凭据 | `tbadmin/admin.cpp:583` | V |
| `ops/db.conf` 644 | `ls -l ops/db.conf` | V |
| webhook 默认停用 | `ops/db.conf.example:11-15` | V |
| 各脚本空值守卫 | `ops_check_status.sh:45-52`、`ops_preopen_check.sh:44-47`、`ops_md_liveness_watchdog.sh:53-56` 等 | V |
| `ops_check_status` 告警聚合 | `scripts/ops_check_status.sh:40-52,348` | V |
| preopen/md 冷却文件 | `ops_preopen_check.sh:26-28,78-85`；`ops_md_liveness_watchdog.sh:30-34,126-133` | V |
| feed DB 0 字节 dump 处理 | `scripts/ops_feed_db.py:75-110` | V |
| feed DB 删除非当日 instrument | `scripts/ops_feed_db.py:265` | V |
| strategy_sync 备份表/保留 10 | `tools/strategy_sync/sync_tbhft_strategy.py:14-15,34,212-235` | V |
| fee 刷新戳/门控/flock/git | `scripts/ops_refresh_fee.sh:69-80,102-108,155-160,172-186` | V |

### 11.5 备份/风险

| 结论 | 证据 | 类型 |
|---|---|---|
| 单盘、无网络挂载、无第二台机 | `docs/RISK_NO_OFFSITE_BACKUP.md:15,26-40` | V（文档） |
| 无异地副本清单 | `docs/RISK_NO_OFFSITE_BACKUP.md:54-66` | V（文档） |
| 无 `pg_dump` 产物/任务 | `docs/RISK_NO_OFFSITE_BACKUP.md:119-120` | V（文档） |
| 已接受风险（(d) 不建） | `docs/RISK_NO_OFFSITE_BACKUP.md:3,124-136` | V（文档） |
| git 同步只 `daily_init`+`position.csv` | `scripts/ops_sync_git.sh:25` | V |
| `sync_data_back` position 无条件覆盖 | `scripts/sync_data_back.sh:47-52` | V |
| `daily_init` 快照 07:00 | `scripts/ops_snapshot_daily_init.sh:22-35` | V |
| money 快照 11:46/15:16 | `scripts/ops_snapshot_money.sh:24-44` | V |
| eod 快照在 stop 前 | `scripts/ops_stop_session.sh:33-36`；`scripts/ops_eod_report.sh:108-143` | V |
| `21-backup-pitr.md` 不在 trading；在 fin | `docs/architecture/`（只有 3 个文件）；`quantlink-fin/docs/architecture/21-backup-pitr.md` | V |

### 11.6 文档/测试清单中的计划或冲突

| 结论 | 证据 | 类型 |
|---|---|---|
| “daily_init 自动修正”说法 | `.claude/CLAUDE.md:675-676`；`docs/test/2026-10-12_上线测试清单_国盛柜台.md:61` | P（与代码冲突） |
| 上线前需重测 webhook | `docs/test/2026-10-12_上线测试清单_国盛柜台.md:71` | V（清单） |
| 实盘首日 cron 全链路验收 | `docs/test/2026-10-12_上线测试清单_国盛柜台.md:62` | V（清单） |
| D9/D10 未修，CFFEX 门槛 | `docs/test/2026-10-12_上线测试清单_国盛柜台.md:80-81` | V（清单） |
| 午休不重启 ORS | `docs/STARTUP_GUIDE.md:365` | V（文档） |
| STARTUP_GUIDE 的 8080/8081 与 190 的 28080/28081 不一致 | `docs/STARTUP_GUIDE.md:323-333`；`ops/db.conf.example:20-24`；`memlog-reader.alt.yaml` | V/I |
| “收盘前自动平仓”注释与代码冲突 | `ops/crontab.txt:23-26`；`PairwiseArbStrategy.cpp:1039-1056` | V（冲突） |

---

## 12. 未验证 / 待确认

以下问题在本次调查中**没有现场运行证据**，复刻/上线前必须确认。

### 12.1 文档与仓库不一致

1. **`docs/architecture/21-backup-pitr.md` 的归属**：`quantlink-trading` 没有这个文件；同名文件在 `quantlink-fin`。请确认档案是否误引，或是否想把 fin 的 PITR 当作 trading 的目标态（如果是，必须标 P，不能写成本系统现状）。
2. **`daily_init` 自动修正**：`.claude/CLAUDE.md:675` 与测试清单 R-4 说有；代码只读 `daily_init`，ORS 只改自己的 `position.csv`。请确认是否有另一个二进制/脚本在做修正（本 commit 未找到）。
3. **“收盘前自动平仓”**：`ops/crontab.txt:23-26` 的注释与 `PairwiseArbStrategy::HandleSquareoffNow` 代码冲突。请用 190 的真实日志确认：`HandleSquareoffNow` 后是否还有平仓成交；如果没有，注释应改。
4. **08:13 vs 08:50**：`ops_start_session.sh` 文件头还写 08:13，cron 是 08:50。以哪个为准？现场 `cron_start_day.log` 的启动时间是多少？
5. **`STARTUP_GUIDE` 的端口**：文档写 8080/8081，190 实际用 28080/28081（`MEMLOG_READER_CONFIG`）。请确认 190 的 `ops/db.conf` 是否有这一行；如果没有，eod/看门狗会打到 8080（nginx）。

### 12.2 运行态（190）

6. **`ops_check_status` 00:00 是否真的每天误报**：夜盘停用后，00:00 的 `is_trading_day`/`IN_SESSION` 逻辑会检查 ORS/TradeBot/memlog；请用 `cron_check_status.log` 确认实际告警频率。
7. **21:01 `check-md` 在夜盘停用后的行为**：它会 attach 不到 MD SHM（ORS 未起），是退出、空转还是每 60s 告警？需要 `check-md` 日志/进程状态（黑盒，本文未分析内部）。
8. **`ops_feed_db` 在节假日是否污染数据**：17:00 无当天 ORS dump 时会回退到最新非空 dump；请确认 190 节假日的 `tbinstrument_info.trading_day` 是否被写成节假日。
9. **`ops_delta_snapshot` 是否真的在跑**：它需要 `python-socketio`，`ops_install_deps.sh` 没装；且硬编码 `101.43.54.190:8882`。请确认 190 上是否有该模块、Flask 是否常驻、`/var/log/quantlink/delta_snapshot.log` 是否有内容。
10. **tbadmin admin 在 DB 挂时是否崩溃**：`InitDb` 捕获后返回，`InitStList` 直接 `m_db_trade->exec_sql`（`admin.cpp:583-606`）；按代码推断是空指针崩溃，但需要现场/日志确认。
11. **`ops/db.conf` 的 webhook 值**：当前文件 35 字符、不是 `https://`；请确认是“故意占位”还是“配错”。不要打印值。
12. **logrotate 是否已安装**：仓库只有模板；190 上 `/etc/logrotate.d/quantlink-tbadmin` 是否存在？`tbadmin/log/admin.log` 的实际大小/轮转情况？
13. **`/home/hft/tbdata` 是否仍是软链**：如果被改成实体拷贝，`RISK` 的“配置在 git”前提失效，备份风险升级（`RISK:77-101`）。
14. **`log.bak` 实际体积/保留**：2026-10-05 是 791M；现在多少？是否已经手工清理？`ctp_flow.bak` 是否只留最后一天？
15. **`ops_ensure_tbadmin` 是否在跑**：crontab 有行（`:946`），但脚本硬编码 `/root/quantlink-trading/tbadmin`；确认 190 路径一致、`ensure.log` 有记录。

### 12.3 配置/策略

16. **92221 的双 control**：`control.IF2612.IF2610.par.txt.92221` 与 `control.TA701.TA702.par.txt.92221` 同时存在；实际跑的是哪个？TA 文件是否为废弃残留？`start_strategy` 的 glob 取第一个，日志 `Control File:` 是唯一证据。
17. **92204 的激活责任人**：它不在 09:05 自动链，也不在 preopen/md_liveness 的 `RESTART_ACTIVATE_STRATEGIES`；谁在开盘后激活它？是否有手工 checklist？
18. **92201/92202/92203 的停用期限**：`strategies.disabled` 说“待换月/待修 D9/D10”；换月后是否会恢复？恢复时 `daily_init`/control/model 是否已准备好？
19. **CPU 亲和重复**：`92201=2`/`92221=2`、`92202=3`/`92222=3`；`ops_setup_arbi` 会全局校验并 `exit 1`。开夜盘前是否已修？如果没修，20:10 不会生成 control 窗口。
20. **`PRODUCTION_MODE`**：190 的 `ors_server.cfg` 当前是 0 还是 1？评测/生产切换是否有 checklist？错误会导致 4040 或连到评测前置。
21. **`ors_server.cfg` 的 SHM/路径**：`API_LOG_DIR`、`POSITION_FILE`、`CONTRACT_FILE`、`MDSHMSIZE/RESPONSESHMSIZE` 的实际值；仓库没有模板，复刻时容易漏。
22. **`MD_SHMSIZE=2048` vs `check-md`/`md-recorder` 的 `qlen:4096`**：Go 工具按 header 读还是按配置 attach？如果按 4096 建/读，是否与 ORS 2048 兼容？本文未分析 Go 内部，需现场验证 `check-md -probe`/`md-recorder` 是否正常。
23. **`memlog-reader.yaml` 的 `strategies` 只列 92201/92202**：Dashboard 是否因此不显示 92204/92221/92222 的模型/PnL？需要页面/接口验证。
24. **tbadmin 的 `clear.sh` 与 admin 运行态**：15:30 清 `cfg/*.dat`/`order_ref.json` 时 admin 仍在跑；它的内存态与文件态是否一致？次日 08:30 重启后是否会出现“订单引用丢失”？
25. **`deploy_cpp/bin/config/signal.txt` 是否存在**：`SIGTERM` 的 squareoff 依赖它；仓库没有该文件，190 上是否手工创建？如果不存在，`stop_all` 对单策略就是 10s 后硬杀，`daily_init` 不会写。这是收盘数据安全的关键前置项。

### 12.4 备份/恢复

25. **坏盘恢复演练**：没有记录；RTO 2–4 小时是推算。谁负责？是否有独立介质/对象存储？
26. **`tbhft_strategy` 的 RDS 可达性**：坏盘当天 RDS 是否可达？`strategy_sync.env` 是否在离线备份里？如果 RDS 也不可达，`tbhft_strategy` 无法恢复。
27. **`/root/quantlink-backups/` 的内容**：CTP 凭据 `.bak` 是否完整？是否与当前 `ors_server.cfg` 一致？同盘，坏盘即丢。
28. **券商重新申请凭据的等待时间**：没有记录；这决定“最坏 RTO”。需要提前问券商。
29. **`quantlink-fin` 的 21 号文档是否可作为目标态**：如果要用它的 `pg_dump`/PITR 设计，需要确认它是否覆盖 `dbtrade`（当前不覆盖；它是 `quantlink_fin_shadow`）。

### 12.5 告警/组织

30. **谁收告警、谁 on-call**：没有文档；webhook 停用后没有替代通道。复刻前必须定。
31. **P0/P1 的升级路径**：没有电话/值班表；建议补。
32. **告警内容是否含敏感信息**：当前 markdown 里可能带路径/合约/持仓；如果接到外部群，需脱敏。
33. **webhook 恢复后的告警风暴**：00:00 夜盘误报、21:01 check-md、preopen 冷却等会一起出现；恢复前先修 3.4 的误报，否则会被淹没。

---

## 附录 A：命令速查

### A.1 只读巡检

```bash
cd /root/quantlink-trading

# 日历
./scripts/is_trading_day.sh --today; echo rc=$?
./scripts/is_trading_day.sh --next
./scripts/is_trading_day.sh --night-ok; echo rc=$?

# 进程
pgrep -a -x ors_server
pgrep -a -x TradeBot
pgrep -af -- '--strategyID'
pgrep -a -x AdminLoop; pgrep -a -x AgentLoop
pgrep -a -x memlog-reader; pgrep -a -x check-md; pgrep -a -x md-recorder

# SHM
ipcs -m | egrep '0x00000315|0x00001001|0x00002001|0x00003001|0x00004001'

# 端口
ss -tlnp | egrep '28080|28081|9980|9981|8882|5004|5432'

# 磁盘
df -h /; df -i /

# 日志
tail -100 deploy_cpp/bin/log/ors_server.$(date +%Y%m%d).log
tail -100 deploy_cpp/bin/log/cron_check_status.log
tail -50 /var/log/quantlink/preopen_check.log
tail -50 /var/log/quantlink/md_liveness.log

# DB（变量从 ops/db.conf 读；不要把口令写命令行）
set -a; . ops/db.conf; set +a
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c \
  "select max(trading_day), count(*) from tbinstrument_info;"
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c \
  "select count(*) from tbtrade_sections; select count(*) from tbhft_strategy where active=1;"
```

### A.2 启停

```bash
cd /root/quantlink-trading

# 日盘
./scripts/ops_start_session.sh day
./scripts/ops_stop_session.sh day

# 单策略
cd deploy_cpp/bin
./scripts/start_strategy.sh 92204 day
./scripts/tbstart 92204
./scripts/tbstop 92204
./scripts/tbreload 92204
./scripts/tbstartall.sh
./scripts/tbstopall.sh
```

### A.3 体检/看门狗（手工）

```bash
cd /root/quantlink-trading
./scripts/ops_check_status.sh            # 注意：可能发告警；webhook 空则只写日志
./scripts/ops_check_md.sh start
./scripts/ops_check_md.sh stop
./scripts/ops_preopen_check.sh           # 只在 08:48-09:04 动作
./scripts/ops_md_liveness_watchdog.sh    # 只在日盘窗口动作
./scripts/ops_watchdog_memlog.sh
./scripts/ops_ensure_tbadmin.sh
```

### A.4 快照/同步

```bash
cd /root/quantlink-trading
./scripts/ops_snapshot_daily_init.sh
./scripts/ops_snapshot_money.sh am
./scripts/ops_snapshot_money.sh pm
./scripts/ops_rotate_logs.sh
./scripts/ops_sync_git.sh day
./scripts/ops_refresh_fee.sh dry-run
./scripts/ops_refresh_fee.sh apply
./scripts/ops_feed_db.sh
./scripts/sync_data_back.sh
```

### A.5 夜盘管理

```bash
cd /root/quantlink-trading
crontab -l > /root/crontab_backup_$(date +%Y%m%d_%H%M%S).txt
./scripts/ops_night_session.py status
./scripts/ops_night_session.py enable
./scripts/ops_night_session.py disable
./scripts/ops_night_session.py normalize   # 危险：先备份
```

### A.6 日志取证

```bash
TS=$(date +%Y%m%d_%H%M%S)
mkdir -p /root/incident_$TS
cp -a /root/quantlink-trading/deploy_cpp/bin/log /root/incident_$TS/
cp -a /root/quantlink-trading/deploy_cpp/ctp_flow /root/incident_$TS/ 2>/dev/null || true
cp -a /root/quantlink-trading/tbadmin/log /root/incident_$TS/
cp -a /root/quantlink-trading/deploy_cpp/bin/live/data/position.csv /root/incident_$TS/
cp -a /root/quantlink-trading/deploy_cpp/data/daily_init.* /root/incident_$TS/
ps -ef > /root/incident_$TS/ps.txt
ipcs -m > /root/incident_$TS/ipcs_m.txt
ss -tnp > /root/incident_$TS/ss.txt
df -h > /root/incident_$TS/df.txt
```

---

## 附录 B：每日值班清单（可打印）

### 开盘前

- [ ] `is_trading_day --today` rc=0
- [ ] 两份 `trading_days.txt` 都覆盖今天
- [ ] `git status` 只允许 `daily_init`/`position.csv`
- [ ] `df -h /` <80%，`df -i /` 有余量
- [ ] `/home/hft/tbdata/*` 全是软链
- [ ] 无残留 ORS/TradeBot
- [ ] tbadmin 9880/9981 监听（或 9980/9981）
- [ ] Dashboard 28080/28081 可访问
- [ ] `fee.csv` 有当天要交易的合约
- [ ] `contractfile` 三家族/行数正常

### 开盘

- [ ] ORS `Position query complete` + `ORS ready`
- [ ] `position.csv` mtime 是当天
- [ ] `check-md -probe` head 增长
- [ ] 92204 已 `tbstart`（如果当天要交易）
- [ ] 92221/92222 已自动激活（09:05）
- [ ] 每个 SID 一个进程
- [ ] Dashboard `active=true`

### 盘中（每 30 分钟）

- [ ] ORS 1 个；TradeBot 数量正确；tbadmin 2 个；memlog 1 个
- [ ] 无 CLOSE-WAIT 到 CTP
- [ ] 策略有 tick/报价（不是“日志不动=故障”，午休除外）
- [ ] 无 `POSITION MISMATCH`/`POSITION STALE`
- [ ] 无 `REJECT LIMIT`/`RMS Reject` 激增
- [ ] 磁盘 <85%

### 收盘

- [ ] 14:57 后策略停手；15:00 收盘
- [ ] 15:05 `ops_stop_session` 完成
- [ ] `position.csv` mtime 是 stop 后
- [ ] `daily_init` 与 data_cpp 一致
- [ ] `report_bak` 有当天文件
- [ ] `money_bak` 有 pm
- [ ] 15:20 git 提交/push
- [ ] 15:40 `.fee_refresh.ok`
- [ ] 17:00 feed 完成
- [ ] 无 core/磁盘未满

### 非交易日

- [ ] 确认 `is_trading_day --today` rc=1
- [ ] 无 ORS/TradeBot（除非测试）
- [ ] 忽略 00:00 的夜盘进程误报（如果未修）
- [ ] 检查 `cron_feed_db.log` 是否把旧 dump 写成今天
- [ ] 检查 `check-md`/memlog 是否有残留进程

---

## 附录 C：术语

| 术语 | 含义 |
|---|---|
| ORS | Order Routing Service，CTP 行情/交易接入、SHM 发布、RMS 前置 |
| TradeBot | C++ 策略引擎；一个 SID 一个进程 |
| tbadmin | C++ 管理面；admin（AdminLoop）+ agent（AgentLoop） |
| MemLog | TradeBot 写、Dashboard/tbadmin 读的策略状态 SHM（key 789） |
| `daily_init.<sid>` | 策略启动时的昨仓/均价/2day；策略唯一持仓真相 |
| `position.csv` | ORS 的持仓时点文件；不是实时流 |
| squareoff | 撤单 + 停用 + 写 `daily_init`；不保证平仓 |
| `tbstop` | SIGTSTP → deactivate（旧语义“平仓+停用”，实际见 8.1） |
| `tbstart` | SIGUSR1 → activate |
| `tbreload` | SIGUSR2 → 重载阈值 |
| D15 | CTP 静默断连缺陷（柜台 FIN，ORS 不重连） |
| D18 | 开盘登录失败直接 exit 的缺陷（已改退避重试） |
| PITR | Point-In-Time Recovery；本系统没有 |
| RPO/RTO | 恢复点/恢复时间目标；本文为推算，不是 SLA |

---

## 附录 D：本文没有做的事

- 没有修改 `quantlink-trading` 的任何代码/配置。
- 没有在 190 上执行任何命令；所有“现场状态”均来自仓库文档/脚本，未复核的已标 I。
- 没有分析 `web-go`/Go Dashboard 内部；`memlog-reader`/`check-md`/`md-recorder` 只按外部契约描述。
- 没有记录任何明文口令、token、webhook URL。
- 没有把 `quantlink-fin` 的备份/PITR 设计混写成 `quantlink-trading` 的现状；相关段落已显式标注归属。

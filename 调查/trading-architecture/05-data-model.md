# 05 — 数据模型与数据生命周期

> 证据约定：**V** = 直接读代码/配置/脚本确认；**I** = 由代码结构或部署文件推断，未在运行环境验证；**P** = 计划/建议，当前代码未实现。
> 源码快照：`/Users/wangjun/PG/RD/quantlink-trading`，commit `5cee3dd5b3322ec21c1958aac20ad38ba0d8ca40`，分支 `main`，2026-11-18。
> 范围排除：`web-go`（Go Dashboard / memlog-reader）不在本文范围。
> 本文不记录任何明文口令、token、webhook URL。只记录**位置、键名、加载方式**。

---

## 0. 结论先行（复刻者最需要知道的 8 条）

1. **生产只有一个库：PostgreSQL `dbtrade`**，跑在 190 本机（`127.0.0.1:5432`，服务名 `postgresql-16.service`，数据目录 `/var/lib/pgsql/16/data/`）。另有一个独立的 `admin` 库只服务 Vue 控制台的用户/风控表。**V**（`docs/RISK_NO_OFFSITE_BACKUP.md:66,108-116`；`vue3-admin/back_end/server/config.py:2-16`）
2. **`dbtrade` 里真正驱动交易的只有 5 张表**：`tbhft_strategy`（策略注册表）、`tbhft_product`（产品 ↔ SHM key 映射）、`tbtrade_sections`（交易时段）、`tbinstrument_info`（合约规格/到期）、`tbtrading_days`（交易日历）。其余是审计/遗留。**V**
3. **TradeBot 进程从不读 `tbhft_strategy`**。它只吃**文件**（control/model/`daily_init.<sid>`/`position/<sid>`/`fee.csv`/`contractfile`），并且**只向 DB 写一个列**：`posdetail`。DB→文件的物化动作发生在 `tbadmin agent`。**V**（`tbsrc/` 全仓只有 `UPDATE tbhft_strategy`，无 `SELECT`；`admin.cpp:1729-1748`）
4. **仓库里没有任何 `tbhft_strategy` / `tbhft_man_order` / `tbinstrument_info` 的 DDL**。全仓只有一个 `.sql` 文件（`ops/db/hft_control_tables.sql`）。表结构只能从读写代码和 Python ORM 反推。**V**（`find . -name "*.sql"` 仅 1 个）
5. **`tbhft_strategy` 是生产全量策略表的镜像**（277 行、8 个交易所、13 种策略 type + `OptionManage`），不是"190 本机在跑的策略清单"。在 190 上真正在跑的只有 6 个 sid（`92201/92202/92203/92204/92221/92222`），监控脚本已改为**从 `deploy_cpp/bin/config/config_CHINA.*.cfg` 反推**，DB 只作兜底。**V**（`docs/2026-09-23_策略库分析.md:11,29-43`；`tbadmin-py/tbadmin_check/tbstate_send.py:127-140`；`tbadmin-py/check_PB/check_PB.py:35-52`）
6. **唯一有真正事务边界的数据通路是 `tools/strategy_sync`**（RDS→本地，单事务 + 写前建备份表）。其他所有 DB 写入都是 `nontransaction` 逐条自动提交（`PqHelper` 显式 `exec("commit;")`）。**V**（`tools/strategy_sync/sync_tbhft_strategy.py:204-239`；`tbadmin/persistence/pqhelper.cpp:12-15,29-31`）
7. **没有任何 `pg_dump` / WAL 归档 / PITR**。同库同盘的 `tbhft_strategy_bak_sync_*` 是唯一的 DB 级"备份"，且只覆盖一张表。这是**明确接受的风险**，不是遗漏。**V**（`docs/RISK_NO_OFFSITE_BACKUP.md:66,116,119-120`，`§6`）
8. **`docs/architecture/21-backup-pitr.md` 不存在**。`docs/architecture/` 只有 3 个文件（2 个 HTML 架构图 + 指标计算 md）。本文的备份结论全部来自 `docs/RISK_NO_OFFSITE_BACKUP.md`、`ops/crontab.txt` 与脚本本身。**V**

---

## 1. 数据库拓扑、连接与归属

### 1.1 实例清单

| 实例 | 地址 | 库 | 用途 | 证据 |
|---|---|---|---|---|
| 190 本机 PG16 | `127.0.0.1:5432` | `dbtrade` | 交易主库：策略表、产品表、时段、合约、日历、手工单、手工持仓 | **V** `ops/db.conf.example:5-9`；`tbadmin/cfg/admin.cfg:3-4`；`tbadmin/cfg/agent.cfg:14-15` |
| 190 本机 PG16 | `127.0.0.1:5432` | `admin` | Vue 控制台自身：`admin_user`/`tbuser`/`tbmenu`/`tbuser_menu`/`tbproduct_user`/`risk_edit_log` | **V** `vue3-admin/back_end/server/config.py:2,11-15` |
| 阿里云 RDS（源） | `pgm-bp1sq2jq9z5poro3io.pg.rds.aliyuncs.com:5432` | `appdb` | **上游**策略表 `public.tbhft_strategy`（含 `imported_at`），只读拉取 | **V** `tools/strategy_sync/strategy_sync.env.template:3-6` |
| 旧内网（已不可达） | `172.31.37.238:5435` | `dbtrade` | 旧系统多机共库；`tbadmin/py/*` 里硬编码 | **V** `tbadmin/py/hft_control.py:13-14`；**I** 190 到该地址不可达（`docs/RISK_NO_OFFSITE_BACKUP.md:32`） |
| 旧测试库 | `127.0.0.1:5633` | `dbtrade` | 旧 `hft_manager.py` 的默认测试目标 | **V** `tbadmin/py/hft_manager.py:20-21,540-541` |

> 注：`dbtrade` 只监听 loopback。`tools/strategy_sync/README.md:7` 明确"本机 PG 只监听 127.0.0.1"，所以该同步工具**只能部署在 190**。**V**

### 1.2 连接键与凭据（脱敏）

**A. `ops/db.conf`（运维脚本共享配置，gitignored）**

```
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=<DB_USER>
DB_PASS=<DB_PASS>
DB_NAME=dbtrade
WECHAT_WEBHOOK=            # 2026-11-09 起停用，留空 → 各脚本降级为只写日志
KEEP_INSTRUMENT_HISTORY=0  # 0 = tbinstrument_info 只保留当日
```

证据：`ops/db.conf.example:1-18`；gitignore 见 `.gitignore:101`（**V**，`git check-ignore -v` 确认）。
消费方：`scripts/ops_feed_db.py:31-44`、`scripts/ops_setup_arbi.sh:28`、`scripts/ops_check_status.sh`、`scripts/ops_check_md.sh`。**V**

**B. `tbadmin`（C++ 管理面）** — 不读 `ops/db.conf`，读自己的 cfg：

- admin 模式：`tbadmin/cfg/admin.cfg` 的 `DB_ADDR` / `DB_PORT`。**V**（`admin.cpp:4729-4736`）
- agent 模式：`tbadmin/cfg/agent.cfg` 的 `DB_ADDR` / `DB_PORT`。**V**（`admin.cpp:4666-4667`）
- DSN 在代码里**硬编码拼接**：`dbname=dbtrade hostaddr=<DB_ADDR> port=<DB_PORT> user=trader password=<redacted> options='-c statement_timeout=<ms>'`。**V**（`admin.cpp:583`）
- 同一串 DSN 还会被写进每个策略的 `config_CHINA.<sid>.cfg` 与 `StrategyConfig.cfg`（两个分支各一份：`admin.cpp:1816`、`admin.cpp:1825`）。**V**
- ⚠️ 该口令是**与服务名同名的弱默认值**，属安全缺陷，见 `08-security-gaps.md`。本文不复述。**V**

**C. `vue3-admin`（Flask + Vue 控制台）**

| 键 | 值（脱敏） | 证据 |
|---|---|---|
| `ADMIN_URL` | `postgresql://admin:<redacted>@localhost:5432/admin` | `vue3-admin/back_end/server/config.py:2` |
| `QUOTE_PRD` / `QUOTE_TRADER_PRD` | `postgresql://risker:<redacted>@localhost:5432/dbtrade` | `config.py:8-9` |
| `SQLALCHEMY_BINDS` | `admin` → ADMIN_URL；`trader` → QUOTE_TRADER_PRD | `config.py:11-15` |

> ⚠️ 该文件把口令**明文写在被 git 跟踪的源码里**。V。复刻时必须改为环境变量。

**D. `tools/strategy_sync`** — 唯一"正规"的凭据管理：

- 配置路径 `/root/.quantlink/strategy_sync.env`（`chmod 600`，gitignored：`.gitignore:89`）。**V**（`sync_tbhft_strategy.py:29`；`README.md:22-27`）
- 必填键：`RDS_HOST/RDS_PORT/RDS_DB/RDS_USER/RDS_PASSWORD` + `LOCAL_HOST/LOCAL_PORT/LOCAL_DB/LOCAL_USER/LOCAL_PASSWORD`；可选 `SERVER_OVERRIDE`（默认 `127.0.0.1`）、`BACKUP_KEEP`（默认 `10`）。**V**（`sync_tbhft_strategy.py:62-69`）
- 状态文件 `/root/.quantlink/strategy_sync_state.json`，写时 `chmod 600` + 原子 `os.replace`。**V**（`sync_tbhft_strategy.py:30,79-85`）

### 1.3 schema / owner / 权限

| 项 | 事实 | 证据 |
|---|---|---|
| schema | 全部在 `public` | **V** 所有 SQL 都写 `public.tbhft_strategy` 或裸表名 |
| `tbhft_strategy` owner | `risker` | **V** `openspec/changes/archive/2026-09-23-add-strategy-db-sync/design.md:4` |
| `tbhft_strategy.id` | 自增主键，序列名 `tbhft_strategy_id_seq` | **V** `sync_tbhft_strategy.py:33,230-231` |
| 读 `tbhft_strategy` 的角色 | `trader`（tbadmin）、`risker`（vue3-admin / sync） | **V** |
| 写 `tbhft_strategy` 的角色 | `trader`（tbadmin）、`risker`（sync 工具、TradeBot 的 posdetail 更新） | **V** |
| 授权 DDL | **仓库里没有**（无 `GRANT`、无 `ALTER OWNER`） | **V**（唯一 `.sql` 文件不含 GRANT）；**I** 现场靠手工授权 |
| `search_path` | 未设置，默认 `"$user", public` | **I** |

### 1.4 谁连谁（写者/读者矩阵）

| 进程 | 连接身份 | 读 | 写 |
|---|---|---|---|
| `tbadmin admin` | `trader` | `tbhft_strategy`、`tbhft_product`、`tbinstrument_info`、`tbtrade_sections`、`tbors_core`、`tbadmin_position` | `tbhft_strategy`、`tbhft_product`、`tbhft_man_order`、`tbadmin_position` |
| `tbadmin agent` | `trader` | 同 admin（只查 product / instrument / sections） | 执行 admin 通过 protobuf 下发的 SQL（`tbhft_strategy` 的 INSERT/UPDATE/DELETE） |
| `TradeBot` | `trader`（DSN 来自 `StrategyConfig.cfg`） | **不读任何表** | `UPDATE tbhft_strategy SET posdetail=...` |
| `scripts/ops_feed_db.py` | `ops/db.conf` | — | `tbinstrument_info`、`tbinstrument_name`、`tbtrading_days`、`tbtrade_sections` |
| `tools/strategy_sync` | `risker` | RDS + 本地 `tbhft_strategy` | `tbhft_strategy`、`tbhft_strategy_bak_sync_*` |
| `vue3-admin` | `risker` / `admin` | `tbhft_strategy`、`tbhft_man_order`、`tbhft_product`、`tbinstrument_info`、`tbtrading_days` | **只写 `admin` 库与 `ts*` 遗留表**，对 `tbhft_*` 只读 |
| `tbadmin-py/*` | `trader` | `tbhft_strategy`、`tbhft_schedule`、`tbhft_product` | `tbhft_schedule`（delete/insert）、`tbhft_strategy`（`refresh_product` 批量置 `active=0`） |

证据：`admin.cpp:583,597,712,724,820,848,1123,1218,2662,3252,3556`；`ops_feed_db.py:69-72`；`sync_tbhft_strategy.py:176-201`；`tbadmin-py/hft_control/hft_control.py:51,62-78`；`tbadmin/py/hft_manager.py:100-109`。**V**

---

## 2. 表目录（`tbhft_*` 及直接相关表）

> 仓库里**没有** `\d` 输出、没有 dump、没有 `information_schema` 查询。下面"键/索引"列凡是没写"V"的，都是**从 SQL 语义推断**（I），不是读 DDL 得到的。

### 2.1 一览

| # | 表 | 角色 | 行数量级（190） | 写者 | 更新节奏 | 证据 |
|---|---|---|---:|---|---|---|
| 1 | `tbhft_strategy` | 策略注册表（配置真值源） | 277（active=1 44） | tbadmin admin/agent、strategy_sync、TradeBot(posdetail) | 事件驱动 + 每工作日 10:30/20:30 | **V** |
| 2 | `tbhft_strategy_bak_sync_<ts>` | 策略表同步前快照 | 277 × 最多 10 张 | strategy_sync | 每次有变更时 | **V** |
| 3 | `tbhft_product` | 产品 ↔ 5 个 SHM key + 部署路径 | 个位数 | tbadmin admin | 手工/产品注册事件 | **V** |
| 4 | `tbhft_man_order` | 手工（Web）单的成交流水 | 每日数十~数百 | tbadmin admin | 每条柜台回报一行 | **V** |
| 5 | `tbhft_schedule` | 由 action×product 展开的定时动作表 | **0（刻意留空）** | tbadmin-py `hft_control.build_schedule_table()` | 不再运行 | **V** |
| 6 | `tbhft_action` | 定时动作模板 | **0** | 手工 | 不再运行 | **V** |
| 7 | `tbadmin_position` | 手工持仓（跨重启） | 个位数 | tbadmin admin | 每笔手工成交 upsert | **V** |
| 8 | `tbtrade_sections` | 品种交易时段（4 列新 schema） | 23 | `ops_feed_db.py` | 每工作日 17:00 全量重建 | **V** |
| 9 | `tbinstrument_info` | 合约规格/到期/`product_id` | ~860（只当日） | `ops_feed_db.py` | 每工作日 17:00 upsert + 清旧 | **V** |
| 10 | `tbinstrument_name` | 合约发送名 | ~860 | `ops_feed_db.py` | 同上 | **V** |
| 11 | `tbtrading_days` | 交易日历 | 5094（DB）/ 5298（文件） | `ops_feed_db.py`、`tools/trading_calendar` | 每日 append | **V / I** |
| 12 | `tbors_core` | ORS 已占用 CPU core | 0~1 行 | **无写入方**（旧系统遗留） | 只读 | **V / I** |
| 13 | `admin` 库 6 张表 | 控制台用户/菜单/风控日志 | 小 | vue3-admin | 事件驱动 | **V** |
| 14 | `ts*`（`tborder`/`tbtrade`/`tbproduct`…） | 证券子系统的遗留表 | 未知 | 无（新系统不写） | — | **V**（仅 ORM 声明） |

### 2.2 `tbhft_strategy`（核心表）

**用途**：策略/组合的**配置真值源**。tbadmin 前端在这里做增删改；agent 把它物化成 `config_CHINA.<sid>.cfg`、`models/<modelfile>`、`data|position/<posfile>`、`controls/**/control.*`、`start|stop.<sess>.<sid>.sh`；TradeBot 启动后只回写 `posdetail`。

**列**（21 列，顺序取自 `sync_tbhft_strategy.py:37-41`；语义取自 `models.py:314-345`、`admin.cpp` 各 SQL、`docs/2026-09-23_策略库分析.md:59-62`）：

| 列 | 类型（推断/证据） | 语义 | 备注 |
|---|---|---|---|
| `id` | `integer` PK, default `nextval('tbhft_strategy_id_seq')` | 自增主键，**同步键** | RDS 全局唯一；本地序列曾被 RDS 追尾（`last_value=686` vs RDS `694`）**V** |
| `sid` | `integer` NOT NULL | 业务策略 ID（92201、67201…） | **不是主键**，可变；`(sid,type)` 不唯一 **V** |
| `parent` | `integer` | >0 表示属于某 `OptionManage` 组合的子策略 | 组合容器用 `sid` 关联 |
| `status` | `integer` | 1=自动（允许调度拉起），0/其它=手动 | `hft_control` 过滤 `status!=0`；admin 注释 `1: auto 0: manual` **V** |
| `active` | `integer` | 1=已部署/启用，0=停用 | 语义是**期望状态**，不是运行时状态 |
| `core` | `integer` | CPU 亲和核号；`-1`=已释放、`-2`=不绑定、`0`=待分配、`>0`=实际核 | **V** `admin.cpp:3500-3530` |
| `corebind` | `integer` | 0=不绑、1=绑定、-1=保持现状 | **V** `admin.cpp:3493-3510` |
| `ref` | `integer`（ORM / sync 工具按 int 处理） | 引用策略 ID（`--refStrategyID`） | ⚠️ C++ 侧按**字符串**处理并可携带 `"<ref>,<core>"`，见 §6.4 |
| `product` | `varchar(20)` | 资管产品/账户组（ax3、spbl1…），对应 cfg 的 `PRODUCT` | 无 FK，靠名字关联 `tbhft_product` |
| `exchange` | `varchar(20)` | `SFE`（上期所写作 SFE，不是 SHFE）/`DCE`/`CZCE`/`CFFEX`/`INE`/`GFEX`/`SH`/`SZ` | **V** |
| `server` | `varchar(20)` | 归属主机；同步后统一改写为 `127.0.0.1` | agent 用它过滤"本机策略" **V** |
| `type` | `varchar(20)` | 策略类名（`TB_PAIR_STRAT`…，共 13 种 + `OptionManage`） | 与 `main.cpp` 工厂一一对应 **V** `docs/2026-09-23_策略库分析.md:64-84` |
| `modelfile` | `varchar` | model 文件名（如 `model.TB_PAIR_STRAT.ag_F_6_SFE.ag_F_8_SFE.txt`） | 相对 `bin/models/` |
| `modeldetail` | `text` | **model 文件全文** | 多条 SQL 里直接内联，见 §6.7 |
| `posfile` | `varchar` | 仓位文件名：PAIR 系 `daily_init.<sid>`，其它 `<sid>` | **V** `admin.cpp:3405-3425` |
| `posdetail` | `text` | **daily_init 文件全文**（含表头 + 一行数据） | TradeBot 平仓时回写，见 §4 |
| `optfile` | `varchar` | `OptionsParams.<sid>` | 期权类 |
| `optdetail` | `text` | OptionsParams 文件全文 | 期权类 |
| `instrument` | `varchar` | TB 内部合约名（`ag_F_6_SFE` 模板，不是 `ag2606`） | 换月靠改这里 |
| `instrument2` | `varchar` | 第二腿；非 PAIR 系写空串 | **V** |
| `path` | `varchar` | 部署根目录 | ⚠️ 同步后为 RDS 的 `/home/hft/TB.<product>.<exchange>`，**190 上是错的**，见 §6.4 |

**键与索引**

- 主键：`id`（**V**）。
- 唯一约束：**discoverable 的只有 `id`**。`sid` 的"唯一性"只由应用层检查：`admin.cpp:3541-3554` 在 `parent==0` 时 `select distinct sid from tbhft_strategy` 后比对。**V** → 该检查是 TOCTOU（见 §6.6）。
- 索引：**没有任何 `CREATE INDEX` 证据**。查询模式显示应至少需要 `(server, active)`、`(sid)`、`(sid,type)`、`(exchange,product)`。**I / P**

**读写与节奏**

| 动作 | 触发 | SQL 位置 |
|---|---|---|
| 全表载入内存 | `admin` 启动 + 每次 core 回写后 | `admin.cpp:597`、`:604`（18:00 后只取非 CFFEX/SH/SZ/GFEX） |
| 新增 | 前端"保存策略" → agent 执行 | `admin.cpp:3556` |
| 修改 | 同上 | `admin.cpp:3489`（由 agent 执行，`admin.cpp:3142`） |
| 删除 | 前端删除 | `admin.cpp:3605`（按 sid，OptionManage）/ `:3611`（按 id） |
| 核绑定回写 | agent 分配 core 后 | `admin.cpp:3148`、`:3158`、`:3191`、`:3525-3532` |
| 仓位回写 | TradeBot 平仓完成 | 10 个策略类各一处，见 §4 |
| 全量同步 | cron 10:30 / 20:30（工作日） | `sync_tbhft_strategy.py` |

### 2.3 `tbhft_strategy_bak_sync_<YYYYmmdd_HHMMSS>`

- **用途**：`strategy_sync` 在**同一事务内**执行 `CREATE TABLE ... AS SELECT * FROM tbhft_strategy` 得到的整表快照。**V**（`sync_tbhft_strategy.py:212-213`）
- **保留**：按表名倒序保留最近 `BACKUP_KEEP`（默认 10）张，只删自己前缀的；手工备份（如 `_bak_20260822_192753`）不动。**V**（`:233-237`）
- **风险**：同库同盘，且 `CREATE TABLE AS` 不带索引/约束/序列。**V**
- **恢复**：`DELETE FROM tbhft_strategy; INSERT INTO tbhft_strategy SELECT * FROM <bak>; SELECT setval(...)`（`tools/strategy_sync/README.md:57-62`）。

### 2.4 `tbhft_product`

```sql
CREATE TABLE IF NOT EXISTS tbhft_product (
    product     varchar,
    exchange    varchar,
    server      varchar,
    clientkey   varchar,
    monitorkey  varchar,
    orsreqkey   varchar,
    orsrspkey   varchar,
    mdkey       varchar,
    path        varchar
);
```

**V**（`ops/db/hft_control_tables.sql:22-32`）

- **用途**：产品名 → 5 个 SysV SHM key（client store / monitor / ORS request / ORS response / market data）+ 部署路径。agent 用它在部署策略时把 key 写进 `config_CHINA.<sid>.cfg`。**V**（`admin.cpp:3458-3478`）
- **键**：DDL 无任何约束；逻辑键 `(product, exchange, server)`（所有查询按这三者过滤）。**V/I**
- **写者**：`admin.cpp:3252`（前端 `msgtype=product`，`path` 被硬编码改写为 `/root/quantlink-trading/deploy_cpp`）。**V**
- **读者**：`admin.cpp:712`（`select distinct product`）、`:3458`、`hft_control.py:72,180`、`vue3-admin` `product.py:22`、`instrument_info.py:92`。
- **注意**：`ops/db/hft_control_tables.sql` 建的是**空表**；实际 190 上有注册行（`openspec/changes/cron-migration-full/tasks.md:41`）。**V**
- **注意 2**：ORM `Product` 声明了 `id = Column(String, primary_key=True)`，但 DDL 没有 `id`，`INSERT` 也不写 `id` → **ORM 与真实表结构不一致**（`models.py:269-280` vs `hft_control_tables.sql:22-32`；`admin.cpp:3252`）。**V** → 谁若用 `create_all()` 建表会得到不同结构。
- **注意 3**：`tbhft_product` 为空时，`hft_control._close_all` 会**跳过** `kill -9`（防误杀盘后手工进程）；`admin` 在部署策略时会直接报 `query product db shmkey error` 并中止。**V**（`tbadmin-py/hft_control/hft_control.py:170-176`；`admin.cpp:3461-3469`）

### 2.5 `tbhft_man_order`（唯一有"流水"语义的表）

**用途**：**仅记录手工/Web 报单**（`strategyid < 0`，即 `WEB_STRATEGY_ID = -1`）的每一笔柜台回报。策略单**不入库**。

**写点**：`admin.cpp:2601` 的判断 `m_rsp.strategyid() < 0 && m_orderRef2TotalQty.count(userref)` → `admin.cpp:2662-2669` 执行 INSERT。**V**

```sql
INSERT INTO tbhft_man_order
(product,strategy_id,instrument_id,exchange,req_price,req_qty,buy_sell,open_close,
 order_id,status,cumfilledqty,trade_price,trade_qty,remain_qty,errorid,errormsg,trade_id,server)
VALUES ('%s',%d,'%s','%s',%g,%d,'%s',%d,%d,%d, %d,%g,%d,%d,%d,'%s','%s','%s');
```

**列**（ORM：`models.py:490-540`；写点：上文）

| 列 | ORM 类型 | 实际写入 | 备注 |
|---|---|---|---|
| `id` | `BigInteger` PK | **不写** | 依赖 DB 默认（`serial`/`identity`）；仓库无 DDL **I** |
| `product` / `server` | String | 字符串 | |
| `strategy_id` | Integer NOT NULL | `-1` | 手工单固定 -1 |
| `exchange` / `instrument_id` | String | 字符串 | 存 `SHFE`（读侧再 `REPLACE(...,'SHFE','SFE')`）**V** |
| `req_price` / `trade_price` | Float | `%g` | ⚠️ `%g` 默认 6 位有效数字，见 §6.4 |
| `req_qty` / `cumfilledqty` / `trade_qty` / `remain_qty` / `errorid` / `status` / `open_close` | Integer | `%d` | |
| `buy_sell` | **Integer** | **`'B'` / `'S'`（带引号的字符串）** | ⚠️ 类型冲突，实际列必为 char/varchar，见 §6.4 |
| `errormsg` | String | `%s`，来自 `getErrorCodeDesciption()` | 可能含中文/引号 → 见 §6.7 |
| `trade_id` | String | `%s` | |
| `create_time` | `DateTime`, nullable | **从不写** | ⚠️ 读侧却按它过滤，见 §6.4 |

**键/索引**：主键 `id`（ORM 声明）；读侧用 `max(id) group by order_id` 取每单最新状态 → 需要 `(order_id)`、`(create_time)` 索引。**I / P**

**读者**：
- `vue3-admin/back_end/server/api/tbhft_man_order.py:38-96`：`WITH latest_order_status AS (select order_id, max(id) mid ... group by order_id)` + `status in (0,1,2,5)` + `create_time >= TRADING_DAY_BEGIN`。
- 直接后果：**同一 `order_id` 会有多行**（未报/已报/部成/全成/废单各一行），读侧必须自己折叠。

**状态码**（`tbadmin/inc/admin.h:29-37`，**V**）：

| 值 | 含义 | 值 | 含义 |
|---:|---|---:|---|
| 0 | 未报 | 6 | 全成交 |
| 1 | 正报 | 7 | 部成部撤 |
| 2 | 已报 | 8 | 全撤 |
| 3 | 废单 | 9 | 撤废（注释掉，不入库） |
| 5 | 部分成交 | | |

### 2.6 `tbhft_schedule` / `tbhft_action`

```sql
CREATE TABLE IF NOT EXISTS tbhft_schedule (
    time varchar, exchange varchar, strategytype varchar,
    action int, product varchar, server varchar
);
CREATE TABLE IF NOT EXISTS tbhft_action (
    time varchar, exchange varchar, strategytype varchar, action int
);
```

**V**（`ops/db/hft_control_tables.sql:6-20`）

- **语义**：`action` = 1 启动 / 2 激活（`SIGUSR1`=kill -10）/ 3 去激活（`SIGTSTP`=kill -20）/ 4 关闭（`kill -9`）。**V**（`tbadmin-py/hft_control/hft_control.py:137-141`；`tbadmin/py/hft_control.py:214-224`）
- **build 规则**：`DELETE FROM tbhft_schedule` → 读 `tbhft_action` → 对每个 `exchange` 展开 `tbhft_product` 的 `(product,server)` → 逐行 INSERT（**每行一次 commit**）。**V**（`hft_control.py:58-79`）
- **190 的现状是刻意留空**：文件头写明"保持空表 —— 空 schedule = 不发任何盘中信号（遵守盘中不重启 TradeBot 铁律）"。**V**（`ops/db/hft_control_tables.sql:3-4`）
- **约束**：两张表**都没有主键/唯一约束** → 重复 build 会产生重复行（虽然先 DELETE 缓解）。**V**
- **状态**：`hft_control` 不在 `ops/crontab.txt` 的任何一行里；190 用 `ops_start_session.sh` / `ops_stop_session.sh` 代替。**V**（`ops/crontab.txt:41-49`）

### 2.7 `tbadmin_position`（手工持仓，唯一"仓位真相"之一）

```sql
INSERT INTO tbadmin_position (product, instrument_id, type_id, long_qty, short_qty)
VALUES ('%s','%s','%s',%d,%d)
ON CONFLICT (product, instrument_id, type_id) DO UPDATE
SET long_qty = EXCLUDED.long_qty, short_qty = EXCLUDED.short_qty;
```

**V**（`admin.cpp:1218-1226`）

- **唯一键**：`(product, instrument_id, type_id)`（从 `ON CONFLICT` 反推，**V**）。
- **`type_id` 常量**：`"MANUAL"`。**V**（`admin.cpp:1224`）
- **读**：`SELECT * FROM tbadmin_position`（`admin.cpp:1123`），启动时装入 `m_manual_position`，`StrategyID = -1`。
- **写**：每笔 `StrategyID == TSLINKER_STRATEGY_ID (0)` 的成交后 upsert（`admin.cpp:1150-1226`）。
- **语义**：`long_qty/short_qty` 是**累计买卖量**，`netpos = long - short`。
- **注意**：没有 `exchange` 列 → 同 product+instrument 跨交易所会合并。**V**

### 2.8 `tbtrade_sections`（4 列新 schema）

| 列 | 语义 |
|---|---|
| `instrument_id` | **品种级占位**（`ag0001`、`if0001`），不是真实合约 |
| `startstr` / `endstr` | `YYYYMMDD HH24:MI:SS`，**北京时间** |
| `is_trading` | 1=交易时段，0=非交易（当前只写 1） |

- **生产者**：`ops_feed_db.feed_sections()` → `DELETE FROM tbtrade_sections` 后按 `session_rules.csv` 重建，每品种 2~3 行（早/午/夜）。**V**（`ops_feed_db.py:149-181`）
- **行数自洽**：8 个品种（7 个有夜盘 + IF）→ `7×3 + 1×2 = 23`，与 `docs/RISK_NO_OFFSITE_BACKUP.md:66` 的 23 行一致。**V**
- **读者**：`admin.cpp:63`（`GetTradeSectionFromDb`，按品种前缀匹配 + `- INTERVAL '8 hours'` 转 UTC）、`admin.cpp:848`（全量载入 `m_trade_section`）；`ops_setup_arbi.sh:133-152`（反查 DB 重生成 `sections.csv`）。
- **旧 7 列 schema 已废弃**：`instrument_id,start,end,is_trading,startstr,endstr,tday`；`openspec/changes/cron-migration-full/design.md:78` 明确"勿还原 7 列——admin.cpp 已是 4 列原生"。**V**
- **没有主键**：`DELETE`+`INSERT` 全量重建。**V**

### 2.9 `tbinstrument_info` / `tbinstrument_name`

| 表 | 列 | 键 |
|---|---|---|
| `tbinstrument_info` | `instrument_id, trading_day, exchange_id, price_tick, expire_date, product_id` | PK `instrument_id`（`ON CONFLICT (instrument_id)`）**V** |
| `tbinstrument_name` | `instrument_id, send_name, exchange_id` | PK `instrument_id` **V** |

- **生产者**：`ops_feed_db.feed_instruments()`，唯一数据源是 **ORS 启动时写的 `contracts_YYYY_MM_DD` dump**（`ScripCode|RoundLot|DecimalLocator|ExpiryDate|ExchangeID|PriceTick|IsTrading`）。**V**（`ops_feed_db.py:184-269`；`:8-10`）
- **保留**：`KEEP_INSTRUMENT_HISTORY=0`（默认）→ 每次 `DELETE FROM tbinstrument_info WHERE trading_day <> <today>`，即**只留当日**。**V**（`ops_feed_db.py:264-265`；`ops/db.conf.example:18`）
- **健壮性设计**：跳过 0 字节 dump（回退到最新的非空 dump）；跳过 `expire_date` 非 8 位数字的行（`OnRtnInstrumentStatus` 写的品种级伪代码，其 `ExpiryDate` 是**未初始化栈变量**）。**V**（`ops_feed_db.py:75-108,193-245`）
- **读者**：`admin.cpp:47`（按合约查到期日）、`admin.cpp:724`（`distinct product_id, exchange_id`，见下条）、`vue3-admin` `instrument_info.py:92`。
- ⚠️ **ORM `TbInstrumentInfo` 缺 `product_id` 列**（`models.py:415-424` 只有 5 列）→ schema drift。**V**
- ⚠️ **`admin.cpp:724` 把 `trading_day = '2026-03-10'` 写死在 SQL 里** → 该查询在 2026-03-11 之后要么返回空、要么返回旧行，`m_symbol_exchange` 从此不刷新。**V**

### 2.10 `tbtrading_days`

- 结构：单列 `trading_day varchar` PK。**V**（`models.py:7-19`）
- 写：`INSERT ... ON CONFLICT DO NOTHING`，来源 `data_cpp/data/trading_days.txt`（每行 `YYYYMMDD`，升序）。**V**（`ops_feed_db.py:111-124`）
- 只追加，不删 → 历史累积（DB 5094 行 @2026-10-05；文件 5298 行 @2026-11-11）。**V / I**（数量差来自文件增补，DB 应随后续 17:00 任务追平，未现场核对）
- 读者：`vue3-admin` `futils.py:135`；`check_PB.py:56-60`（判断今天是否交易日）；`ops_setup_arbi.sh:134`（取 `TDAY`）；`ops_feed_db.py:138-146`。

### 2.11 `tbors_core`

- 结构：`server varchar, corestr varchar`（逗号分隔，如 `"8,9"`）。**V**（`admin.cpp:831-843`）
- **只读**：全仓只有一条 `SELECT`，**没有任何写入方**。写者应是旧系统的 core 注册器（已随系统退役）。**V / I**
- 用途：与 `tbhft_strategy.core where active=1` 一起初始化 `m_used_core`，供 agent 分配空闲核（从 `hardware_concurrency()-1` 往下找，最低到 10；全占满则退化为 `-2` 不绑定）。**V**（`admin.cpp:819-843,1765-1795`）

### 2.12 遗留与旁路表

| 表 | 状态 | 证据 |
|---|---|---|
| `ts*`（`tborder`/`tbtrade`/`tbproduct`/`tbstrategy`/`tbunit_*`/`tbtrader_accounts`/`tbuser_*`） | 证券子系统的 ORM 声明；新系统无写入方；`tsorder.py`/`futils.py` 仍会查 `tborder` | **V** `vue3-admin/back_end/server/tsmodels.py:8-340` |
| `admin` 库：`admin_user`/`tbuser`/`tbproduct_user`/`tbmenu`/`tbuser_menu`/`risk_edit_log` | Vue 控制台自身；`tbrisk`/`tbunit_risk`/`tbproduct_risk` **没有 `__bind_key__`** → 落在 `SQLALCHEMY_DATABASE_URI`（即 **dbtrade**） | **V** `models.py:20-130,455-480`；`config.py:11-18` |
| `tborder`（dbtrade） | 旧证券成交表；`tsorder.py` 仍读 | **V** |
| `tbhft_*` 之外无 ORS 订单表 | **策略单/成交/PnL 完全不入库** | **V**（全仓 `tbhft_` 引用穷举，见 §9） |

---

## 3. 策略配置数据：`tbhft_strategy` 的完整生命周期

### 3.1 三条写入路径

```text
路径 A（人工，实时）
  前端/Vue ──ZMQ "toadmin"──> tbadmin admin ──protobuf 102──> tbadmin agent
                                   │                            │
                                   │                            ├─ 写文件（model/posfile/config/control/start.sh）
                                   │                            └─ 回 21|StrategyRsp{sql}
                                   └── 执行 rsp.sql() ─────────────────> PostgreSQL

路径 B（批量，cron 10:30/20:30）
  阿里云 RDS appdb.tbhft_strategy ──sync_tbhft_strategy.py（单事务）──> 本地 dbtft_strategy

路径 C（运行时，平仓时）
  TradeBot ──UPDATE tbhft_strategy SET posdetail=...──> PostgreSQL
             （同时写 ../data/daily_init.<sid>）
```

**A 的关键细节**：`admin` **不直接执行** UPDATE/INSERT，而是把 SQL 文本塞进 `StrategyInfo.sql` 发给 agent（`admin.cpp:3493-3496`：`info.set_sql(sql)`），agent 原样回传（`admin.cpp:1676-1684`：`rsp.set_sql(m_st.sql())`），admin 再执行（`admin.cpp:3140-3143`）。**V** → 这条链路上 SQL 只经过**字符串拼接**，无参数化，见 §6.7。

### 3.2 新增策略时的派生计算（agent 侧）

`admin.cpp:3386-3430`：

| 字段 | 规则 |
|---|---|
| `posfile` | 默认 = `sid`；`TB_PAIR*` → `daily_init.<sid>`；`parent != 0` → `<sid>.<instrument>`；`OptionManage` → `" "` |
| `optfile` | `OptionsParams.<sid>` |
| `path` | 硬编码 `/root/quantlink-trading/deploy_cpp`（注释说明原为 `/home/hft/TB.<product>.<exchange>`） |
| `instrument` / `instrument2` | 从 `modeldetail` 第 1/2 行里含 `Dependant` 的那行首 token 解析 |
| `posdetail` 校验 | PAIR 系必须 ≥3 行，且 `m_origbaseName1/2` 必须与 `instrument/instrument2` 一致，否则拒绝 |
| `modeldetail` | 必须 ≥3 行（`"modeldetail empty!"`） |
| `sid` 唯一性 | 仅当 `parent==0`：`select distinct sid` 后比对 |
| `status` | 前端传入（`1` 自动 / `0` 手动 / `-1` 默认） |
| `core` | 新增时写 `-2`；`corebind==0 || active==0` 时 `info.core=-2` |

### 3.3 同步工具行为（`tools/strategy_sync/sync_tbhft_strategy.py`）

**差异算法**（纯函数，可单测，`:135-169`）：

| 情形 | 处理 |
|---|---|
| RDS 有、本地无 | INSERT（显式写 `id`） |
| 两边都有、内容不同 | UPDATE（以 RDS 为准） |
| 上次同步过、本次 RDS 消失 | DELETE |
| 本地独有（从未来自 RDS） | **永不修改** |
| 本地手工行与 RDS 新行同 `id` | **报错退出码 2，不写库** |
| `max(imported_at)` 与状态文件相同 | 跳过写库（`--force` 强制） |

**"本地独有"如何判定**：状态文件 `/root/.quantlink/strategy_sync_state.json` 记录上次的 `synced_ids`；首次运行（无状态文件）时把 `本地 ∩ RDS` 视为"来自 RDS"，因此**首次运行不删任何行**。**V**（`:143-151`）

**写库**（`:204-239`，单事务）：

```text
CREATE TABLE tbhft_strategy_bak_sync_<ts> AS SELECT * FROM tbhft_strategy
DELETE FROM tbhft_strategy WHERE id = ANY(<deletes>)
UPDATE tbhft_strategy SET <20 列> WHERE id = <i>     -- 逐行
INSERT INTO tbhft_strategy (<21 列>) VALUES %s        -- execute_values 批量
SELECT setval('tbhft_strategy_id_seq', GREATEST(max(id), last_value))
DROP TABLE tbhft_strategy_bak_sync_* （保留最近 BACKUP_KEEP 张）
COMMIT
```

**写后校验**（`:325-330`）：重新 `SELECT` 一次，比较 **id 集合** 与 `synced_ids ∪ local_only`；不一致则返回 1 并提示用备份表恢复。
> ⚠️ 此时**事务已提交**，校验失败只能人工回滚；且只比 id 集合，不比内容。**V**

**类型转换**（`:92-123`）：`sid/status/parent/id/core/active/ref/corebind` 一律 `to_int`；`None`/`""` → `NULL`；`"3.0"` 接受；`"1.5"`/`"abc"` → `ValueError` **中止整批**。**V**

**`server` 改写**：无条件写成 `SERVER_OVERRIDE`（默认 `127.0.0.1`），因为 agent 按 `server == m_local_ip` 过滤本机策略。**V**（`:120`；`admin.cpp:1668`）

**测试**：`test_sync_tbhft_strategy.py` 覆盖 `to_int`（含 `3.0`/`1.5` 边界）、`server` 改写、首次运行、仅删"上次同步过的"、id 冲突、`None`≡`""`。**V**（71 行，5 个 test）

### 3.4 control/model 生成（DB → 文件的物化规则）

| 产物 | 内容来源 | 证据 |
|---|---|---|
| `bin/models/<modelfile>` | `modeldetail` 全文 | `admin.cpp:1729-1734` |
| `bin/data/daily_init.<sid>` 或 `bin/position/<sid>` | `posdetail` 全文（`TB_PAIR*` 走 `data/`，其余走 `position/`） | `admin.cpp:1736-1742` |
| `bin/data/OptionsParams.<sid>` | `optdetail` 全文（仅 `OptionManage`） | `admin.cpp:1843-1850` |
| `bin/config/config_CHINA.<sid>.cfg` | `tbhft_product` 的 5 个 SHM key + `PRODUCT` + `DSN` + `SHM_MD_RESP_THREAD_CPU_AFFINITY=<core>` | `admin.cpp:1800-1828` |
| `bin/config/StrategyConfig.cfg` | 全局：`ACCOUNT=OWN`、`MAX_POS_SIZE=1000`、`MAX_ORDERS=5000`、`DSN` | `admin.cpp:1822-1826` |
| `bin/controls/{day,night}/control.<type>.<sid>` | 一行：`<instrument> <modelpath> <exchange> 16 <type> <startUTC> <endUTC> <instrument2>` | `admin.cpp:1856-1885,2026-2040` |
| `bin/start.<sess>.<sid>.sh` | `nohup ./TradeBot --Live --controlFile ... --strategyID <sid> [--refStrategyID <ref>] ...` | `admin.cpp:1852-1875` |
| `bin/tbstart.<sid>.sh` / `tbstop.<sid>.sh` | `tbstart <sid>` / `tbstop <sid>` | `admin.cpp:1833-1848` |
| `OptionManage` 组合 | 额外为每个子策略生成 `control.dummy.<contract>.<sid>` 与 `model.dummy.<contract>`，汇总成 `parent_control` 列表 | `admin.cpp:1950-2015` |

> **物化是单向的**：DB → 文件只发生在 agent 处理 `102` 消息时（前端保存策略）。**普通"启动策略"走 `103` 消息，不会重写文件**。**V**（`admin.cpp:2059-2110`）→ 所以文件可能比 DB 新（TradeBot 平仓回写了文件但 DB 也写了；人工改文件则只有文件新）。

### 3.5 `status` / `active` / `core` / `corebind` / `ref` 状态机

```text
            前端"启用"(active=1, core=0)
  [未部署] ─────────────────────────────► agent 分配 core（hardware_concurrency-1 递减，≥10）
     ▲                                        │
     │                                        ├─ 成功 → UPDATE active=1, corebind=1, core=<n>；重新 InitStList
     │                                        └─ 无核可用 → core=-2, corebind=0
     │  前端"停用"(active=0)
     └────────────────────────────────────────┘
              UPDATE core=-1, ref="<ref>,<oldcore>"（释放核）
```

- `status`：**只影响 `hft_control` 的自动拉起**（`status==1` 才进 action=1 的启动集合）。190 上 `hft_control` 不跑，所以 `status` 在 190 上**近似无作用**。**V**
- `core`/`corebind` 的持久化含义是**上一次分配结果**，重启 admin 时被 `InitStList` 读入内存；`m_used_core` 另从 `tbors_core` 补充。**V**
- ⚠️ `ref` 被复用为"释放 core 的载体"：`ref += "," + std::to_string(core)`（`admin.cpp:3523`），agent 侧 `split(ref, ',')[1]` 取出旧核并 `m_used_core.erase()`（`admin.cpp:1760-1766`）。**这是 `ref` 既是 int 又是字符串的根源**，见 §6.4。

---

## 4. 运行时数据：持久化真相 vs 内存/文件

### 4.1 总矩阵

| 数据 | PostgreSQL | SHM / memlog | 文件 | 谁是真值 |
|---|---|---|---|---|
| 策略配置（model/pos/opt/type/instrument/exchange/product/server） | ✅ `tbhft_strategy` | — | 物化副本 | **DB**（但运行时读文件） |
| 策略期望状态（active/status/core） | ✅ | 内存 `m_controlAux` | — | DB |
| 策略**运行时**状态（onExit/onCancel/onFlat/Active/running） | ❌ | ✅ memlog `STRATEGY_STATUS` | — | **只有内存**，进程死即丢 |
| 策略**运行时**详情（告警文本、netpos…） | ❌ | ✅ memlog `STRATEGY_DETAIL` | 日志 | 内存 |
| PnL（net/unrealised/realised/gross/fee） | ❌ | ✅ memlog `PNL` | 策略日志 | 内存 → memlog → 前端 |
| 持仓（buy/sell/net/totalPx） | ❌（除手工持仓表） | ✅ memlog `POSITION` | `position/<sid>`、`position.csv`、`cfg/<instr>_<product>.dat` | **三方并存，互不校验** |
| 委托/成交明细 | ❌（策略单完全不落库） | ✅ ORS 请求/响应 SHM | `log.control.*` 文本日志 | **只有日志** |
| 手工单流水 | ✅ `tbhft_man_order` | — | — | DB |
| 手工持仓 | ✅ `tbadmin_position` | `m_manual_position` | — | DB（启动时载入） |
| 报单引用映射 `orderID → userRef` | ❌ | `m_orderID2ordRef`（unordered_map） | `cfg/order_ref.json` | 文件（每次报单全量落盘） |
| 柜台持仓（真实） | ❌ | `mapContractPos`（ORS 进程） | `live/data/position.csv` | **柜台**；文件只是时点快照 |
| 手续费/乘数/昨结 | ❌ | — | `fee.csv` | 文件 |
| 合约规格（tick/lot/exchange） | ✅ `tbinstrument_info`（供 UI/时段） | 内存 `m_symbol_exchange` | `contractfile`（策略实际读它） | **两份，来源不同** |
| 交易日历 | ✅ `tbtrading_days` | — | `trading_days.txt` | 文件（cron 门控读文件） |
| 交易时段 | ✅ `tbtrade_sections` | `m_trade_section` | `session_rules.csv`（源）、`sections.csv`（派生产物） | **`session_rules.csv`** |

### 4.2 PostgreSQL 里到底有什么（严格清单）

**有**：策略注册与配置、产品 SHM key、交易时段、合约规格/到期、交易日历、手工单流水、手工持仓、控制台用户/风控。
**没有**：策略订单、策略成交、策略持仓、策略 PnL、账户资金、风控指标、运行时策略状态、审计日志（除 `risk_edit_log` 只记控制台自身的风控表改动）。

> 这是本文最重要的边界：**想复刻"能从 DB 重建交易现场"是不可能的**。DB 只能重建"配置"，重建不了"仓位与盈亏"。

### 4.3 只在共享内存 / memlog

memlog 类型（`tbsrc/hftbase/memlog/include/msg.h:22-31`，**V**）：

```text
NONE, STRATEGY_STATUS, STRATEGY_DETAIL, PNL, POSITION, CANCEL_STS, ORS_DETAIL
```

- 写入方：TradeBot（`mlog = new tbadmin::memlog(shmkeymonitor, shmsizemonitor, IPC_CREAT|0666)`，`ExecutionStrategy.cpp:120`）。
- 读取方：`tbadmin agent` → ZMQ → `tbadmin admin` → 前端。
- **不落盘、不落库**；进程重启即归零 → 这是"盘中绝不重启 TradeBot（持仓计数器清零）"这条铁律的技术根源。**V**（`ops/crontab.txt:19-20`）

### 4.4 只在文件

| 文件 | 内容 | 写者 | 节奏 | 生命周期 |
|---|---|---|---|---|
| `deploy_cpp/data/daily_init.<sid>` | 策略级"昨仓 + 均价" | TradeBot 平仓时 `SaveMatrix2()` | 每次 squareoff | 跨日累积，收盘回灌 `data_cpp` 并 git push |
| `deploy_cpp/bin/position/<sid>` | 单腿策略持仓明细（buy/sell/avg/gross/net pnl） | `DumpPosition()`（`PassiveHedgingStrategy.cpp:455`、`TwapStrategy.cpp:271` 等） | 出场时 | 同上 |
| `deploy_cpp/bin/live/data/position.csv` | 柜台真实持仓 | ORS `writePositionToFile()` | **仅启动 CTP 查询完成 + 关机** | 时点快照 |
| `deploy_cpp/bin/cfg/<instr>_<product>.dat` | `admingpb::Position` protobuf | admin（memlog `POSITION` 且 `StrategyID==-99` 时） | 每次推送 | 跨重启缓存 |
| `deploy_cpp/bin/cfg/order_ref.json` | `{orderID: userRef}` | admin `send_new_order` | **每笔报单** 全量 dump | 重启后恢复 userRef 映射 |
| `data_cpp/data/fee.csv` | 费率/乘数/昨结 | `fee_refresh`（CTP 直查）+ git commit | 每工作日 15:40 | 版本化 |
| `data_cpp/data/contractfile` | 合约规格 | **无生成器**（上游/手工） | 换月/tick 调整 | 版本化 |
| `data_cpp/data/trading_days.txt` | 交易日历 | `tools/trading_calendar` | 年度 | 版本化 |
| `data_cpp/data/session_rules.csv` | 品种时段真值表 | 手工 | 规则变更 | 版本化 |

**`position.csv` 的格式与语义**（`ors/China/src/ORSServer.cpp:207-233`，**V**）：

```text
<instrument>,<ONLongPos>,<todayLongPos>,<ONShortPos>,<todayShortPos>
```

即 **5 列、整型、无表头**、按 `mapContractPos` 的 map 顺序输出。仓库里的样例（`data_cpp/bin/live/data/position.csv`）只有 3 行，`au2701,2,0,0,0` 这种形态。**V**

---

## 5. 文件型数据源（逐文件）

> 路径前缀：源在 `data_cpp/data/`（git 跟踪），运行时经 `build_deploy_cpp.sh` 拷到 `deploy_cpp/data/`，并由 `ops_install_deps.sh:42-50` 在 `/home/hft/tbdata/` 建**符号链接**指回 `data_cpp/data/`。策略代码里读的是**硬编码绝对路径** `/home/hft/tbdata/*`。**V**（`docs/RISK_NO_OFFSITE_BACKUP.md:76-90`）

### 5.1 `contractfile`

| 项 | 值 |
|---|---|
| 规模 | 26,382 行 / 1.0 MB |
| 格式 | 空格分隔 6 列，**有表头**：`INSTRUMENT TICKSIZE LOTSIZE EXCHANGE PRICEFACTOR CONTRACTFACTOR` |
| 样例 | `AP_F_0_ZCE 1.0 10 ZCE 0 FUTCOM` |
| 组成 | 期货 1,742（`_F_`）+ 期权 23,716（`_O_`）+ 组合 923（`SP`/`SPD`/`SPC`/`IPS`，合约名含空格→行首带引号） |
| 生产者 | **无**。`ops_feed_db.sync_contractfile()` 只是把 `data_cpp/data/contractfile` 复制到 `/home/hft/tbdata/`，不是生成。**V**（`ops_feed_db.py:272-284`） |
| 消费者 | `tbsrc/common/Instrument.cpp:1575` `FillContractSpecs()`（tick/lot/exchange）、`:1548` `FillOptionStrikeSpread()`、`tbsrc/Tools/marketMonitor.cpp:137` |
| 失败模式 | 文件打不开 → **`exit(1)`**（`Instrument.cpp:1575-1581`）；**symbol 找不到 → 静默保留旧值**（无日志）→ 错价/拒单且无告警 |
| 节奏 | 静态表（品种×13 个月），只在"新挂牌/tick·lot 调整"时变，可能数月不动 |

> ⚠️ **最危险的静默失败**：`ops/crontab.txt:210-240` 记录了实测——用旧脚本 `ouput_instrement_info.py` 重建会把 26,382 行打成 ~1,742 行且**不报错**。因此 `ops_check_status.sh:211-260` 专门检查"家族完整性 + 行数 ≥20000"。

### 5.2 `fee.csv`

| 项 | 值 |
|---|---|
| 规模 | 1,512 行 / 64 KB（`data_cpp` 版）；`deploy_cpp` 侧曾 16,578 行（构建时间差，`docs/RISK...:80`） |
| 格式 | CSV **有表头** 8 列：`exchange,instrument,fee_money_buy,fee_money_sell,fee_volume_buy,fee_volume_sell,multiplier,prevSettle` |
| 样例 | `CFFEX,HO2610-C-2500,0,0,15.01,15.01,1,0` |
| 生产者 | `ors/tools/fee_refresh` 直查 CTP（`ReqQryInstrument` + `ReqQryInstrumentCommissionRate` + 可选 `ReqQryDepthMarketData`），由 `scripts/ops_refresh_fee.sh` 每工作日 **15:40** 调用并 git commit/push。**V**（`docs/UPSTREAM_SYNC.md:38-56`；`ops/crontab.txt:112-126`） |
| 消费者 | `tbsrc/main/TradeBotUtils.cpp:2463-2485` `LoadTCost2()`：读 `/home/hft/tbdata/fee.csv`，**按 `strncmp(m_instrument, Tokens[1], strlen(Tokens[1]))` 前缀匹配** |
| 失败模式 | 文件打不开 → `exit(1)`；**合约找不到 → `exit(1)`**（打印 `Error in finding Transaction Charges for the contract`） |
| 节奏 | 每日一次（交易所公告才变；盘中调费率当日仍用旧值） |

> ⚠️ 前缀匹配 + 有表头意味着：① 表头行靠 `strncmp` 自然跳过；② 同一前缀的多行会**后者覆盖前者**（`found=true` 但继续循环）。**V**

### 5.3 `daily_init.<sid>`

| 项 | 值 |
|---|---|
| 规模 | 每 sid 2 行（1 表头 + 1 数据），~150 B；仓库现有 6 个（92201/92202/92203/92204/92221/92222） |
| 格式 | 空格分隔，第 1 行表头、第 2 行数据，按列名映射 |
| 表头（生产版） | `StrategyID 2day avgPx m_origbaseName1 m_origbaseName2 ytd1 ytd2 px1 px2 max_pnl pnl`（**11 列**） |
| 样例 | `92201 0 158.302 ag_F_6_SFE ag_F_8_SFE -32 32 14087.2 13927.3 0 -655.917`（11 个 token） |
| 生产者 | ① TradeBot `SaveMatrix2()` 平仓时写；② `tbadmin agent` 在"保存策略"时用 DB `posdetail` 覆盖写 |
| 消费者 | `LoadMatrix2()`（`PairwiseArbCSOStrategy.cpp:290-322` 等）；PAIR 系要求 **`avgPx != 0`**、`m_origbaseName1/2` 与 model 一致，否则**拒绝启动并告警** |
| 节奏 | 每次 squareoff；另有 cron `07:00` 整目录快照（`ops_snapshot_daily_init.sh`） |
| 版本化 | 收盘 `ops_sync_git.sh`（15:20）`git add data_cpp/data/daily_init.*` 后 commit+push |

> ⚠️ **两套表头并存**：`LoadMatrix2` 是"按表头名取值"，所以 7 列版（`StrategyID 2day avgPx m_origbaseName1 m_origbaseName2 ytd1 ytd2`，无 pnl 四列）与 11 列版都能跑；`SaveMatrix2` 只有在 `m_test_pnl` 为真时才追加 `px1/px2/max_pnl/pnl`。复刻时必须允许两种宽度。**V**（`PairwiseArbStrategy.cpp:1087-1101`）

### 5.4 `trading_days.txt`

- 5,298 行 / 47 KB，每行 `YYYYMMDD`，升序，覆盖 2006-04-17 → **2027-12-31**。**V**
- 生产者：`tools/trading_calendar/update_trading_days.py`（年度巡检 cron：`10 6 2 1 *`）。**V**（`ops/crontab.txt:137`）
- 消费者：`scripts/is_trading_day.sh`（启动门控）、`ops_check_status.sh:66-76`（过期告警）、`ops_feed_db.py:111-135`（喂 `tbtrading_days`）、`build_deploy_cpp.sh:553-554`。
- 特殊性：build 时**无条件覆盖**（唯一特例），因为"存在即跳过"曾让副本停在 20241231。**V**（`build_deploy_cpp.sh:829-837`）
- 目录里有 3 个 `trading_days.txt.bak.*`（**未被 git 跟踪**，是误留）。**V**

### 5.5 `sections.csv`

| 项 | 值 |
|---|---|
| 规模 | 99,109 行 / 9.8 MB（`data_cpp`）；`deploy_cpp` 侧重建后只有 23 行 |
| 格式 | 7 列 CSV：`instrument_id,start,end,is_trading,startstr,endstr,tday`；`start/end` 是**北京时间的 epoch 纳秒** |
| 生产者 | `ops_setup_arbi.sh:126-152`：从 `tbtrade_sections` 反查重生成（旧 `fee_section.py` 的"parity 格式"） |
| 消费者 | **新系统无消费者**。`docs/UPSTREAM_SYNC.md:20,390` 明确"新系统不读上游版"；保留是为了对齐旧格式/排查 |
| 节奏 | 每日 20:10（随 `ops_setup_arbi`）；190 已停用夜盘 → 该 cron 整段被注释 |

### 5.6 `session_rules.csv`（时段真值表）

- 9 行（1 表头 + 8 品种）：`product,exchange,am_start,am_end,pm_start,pm_end,night_start,night_end,is_trading`。**V**
- 覆盖：`ag/au/cu/al/zn/pb/bu`（SHFE，夜盘）+ `IF`（CFFEX，无夜盘）。**V**
- 双消费者：`ops_feed_db.feed_sections()`（→ DB）与 `ops_setup_arbi.sh`（→ 重写 control 窗口）。**V**（`ops_feed_db.py:149-181`；`ops_setup_arbi.sh:84-124`）
- 缺品种时的行为：`ops_setup_arbi` 保留原 control 窗口并 WARN；`feed_sections` 直接不生成该品种。**V**

### 5.7 其它

| 文件 | 消费者 | 状态 |
|---|---|---|
| `OptionsParams` | `OptionManager::LoadOptionsParams()` 走 **config 驱动**，`../data/OptionsParams` 是死路径 | **V** `docs/UPSTREAM_SYNC.md:22`；`tbsrc/main/main.cpp:622` |
| `SimpleChinaInstruments` | 无 | **V** |
| `name.csv` | 无 | **V** |
| `RolloverOverrideFile` | 调用点已注释 | **V** `docs/UPSTREAM_SYNC.md:23` |
| `RolloverOverrideFile` / `OptionsParams` | 仍在 git 里，属"历史遗留但保留" | **V** |

---

## 6. 数据完整性：已确认的缺陷与风险

> 本节全部为代码级确认（V），影响程度为推断（I）。

### 6.1 重复策略行

| 事实 | 证据 |
|---|---|
| `(sid, type)` 不唯一：`sid=41251` 有两条 `TB_OPTION_QUOTING_STRAT` | **V** `openspec/.../add-strategy-db-sync/design.md:5` |
| `sid` 唯一性仅由应用层在 `parent==0` 时检查 | **V** `admin.cpp:3541-3554` |
| 多行同 `sid` 时，`hft_control` 按 `sid+product+type` 查会**重复拉起同一策略** | **V** `hft_control.py:119-131`（每行都会 `_start`） |
| `vue3-admin` 的 `getOneStrategy` 用 `.first()`，同 sid 多行时**静默取第一条** | **V** `tbhft_strategy.py:39-52` |
| `OptionManage` 删除按 `sid` 删（`DELETE ... WHERE sid=`），会**连带删掉同 sid 的所有子行**；非 OM 按 `id` 删 | **V** `admin.cpp:3603-3612` |

**影响**：换月时若把新合约写成新行而不是改 `instrument`，会得到同 sid 双行；DB 无约束阻止。

### 6.2 `posdetail` 陈旧（最影响交易正确性的问题）

1. `posdetail` 只在 **squareoff 完成**时写（`HandleSquareoffNow()` → `SaveMatrix2()`），不是每 tick。**V**（`PairwiseArbCSOStrategy.cpp:1052-1067`；`PairwiseArbStrategy.cpp:1050-1055`）
2. 同一时刻也写文件 `../data/daily_init.<sid>`。**V**
3. 但 `tbadmin agent` 在处理 `102`（保存策略）时会用 **DB 的 `posdetail` 覆盖文件**。**V**（`admin.cpp:1736-1742`）
4. 于是：若操作员在盘中"顺手保存"了一个已平仓但 DB 未回写的策略，**文件会被 DB 的旧值覆盖**，策略重启后按错误的 `avgPx`/`ytd` 计算价差 → 错误的开仓方向/阈值。
5. `sync_tbhft_strategy` 每工作日 10:30 / 20:30 又会把 **RDS 的 `posdetail`** 写进 DB。RDS 是生产镜像，其 posdetail 反映的是**旧生产机**的昨仓，与 190 的实际持仓无关。下一次"保存策略"就把它物化到 190 的文件里。**V**（`CONTENT_COLUMNS` 含 `posdetail`，`sync_tbhft_strategy.py:43`）

**结论**：`posdetail` 在 190 上是**三源混合**（本地 TradeBot 回写 / RDS 镜像 / 人工编辑），没有版本号、没有时间戳、没有校验。复刻时应改为"单独一张 pos 快照表 + 时间戳 + 只允许显式动作覆盖"。

### 6.3 缺合约 / 缺产品

| 缺失项 | 后果 | 证据 |
|---|---|---|
| `contractfile` 里没有该 symbol | tick/lot **静默沿用旧值**（无日志） | **V** `ops_check_status.sh:217-218` |
| `contractfile` 打不开 | TradeBot `exit(1)` | **V** `Instrument.cpp:1575-1581` |
| `fee.csv` 里没有该合约 | TradeBot `exit(1)` | **V** `TradeBotUtils.cpp:2463-2468` |
| `tbhft_product` 里没有 `(product,server)` | 部署策略时中止（`query product db shmkey error`）；`hft_control` 跳过 `close_all` | **V** `admin.cpp:3461-3469`；`hft_control.py:170-176` |
| `daily_init.<sid>` 缺 `avgPx` 或 `avgPx==0` | PAIR 系拒绝启动并告警 | **V** `PairwiseArbCSOStrategy.cpp:24-45` |
| `position/<sid>` 少于 3 行 | `PassiveHedgingStrategy` `exit(-1)` | **V** `PassiveHedgingStrategy.cpp:632-640` |

### 6.4 NULL / 类型不匹配（逐条）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | **`ref`：C++ 当字符串，DB/ORM/sync 当 int**。C++ 可写入 `"1,-1"`（`ref += "," + core`），SQL 里是 `ref=" + ref` 裸拼接 → 生成 `ref=1,-1` → **语法错误，整条 UPDATE 失败**（连带 `modeldetail/posdetail/posfile` 都存不进去） | **V** `admin.cpp:3523`、`:3489`、`:1760-1764`；`models.py:345`；`sync_tbhft_strategy.py:42` | 停用策略 + 保存 的组合会静默丢失配置更新（只 `LOG_ERROR("update ... fail")`） |
| 2 | 若 `ref` 真的被写成 `"1,2"`，`sync_tbhft_strategy.to_int()` 抛 `ValueError` → **整批同步中止**（fail-closed，行为可接受但无告警） | **V** `sync_tbhft_strategy.py:92-107` | 同步停摆，需人工看日志 |
| 3 | **`buy_sell`：ORM `Integer`，实际写 `'B'`/`'S'` 字符串** | **V** `models.py:500` vs `admin.cpp:2662` | ORM 查询/反序列化可能异常；实际列必为 char/varchar |
| 4 | **`tbhft_man_order.create_time` 从不写入**，读侧却按它过滤 `>= TRADING_DAY_BEGIN` | **V** `admin.cpp:2662`（列清单无 `create_time`）；`tbhft_man_order.py:29,84-96` | 若无 DB `DEFAULT now()`，手工单页面**永远空**。仓库内无 DDL 可确认 → **I** |
| 5 | `status` / `active` / `core` 从 JSON 取成 `std::string` 再裸拼进 SQL；空串会产生 `status=` | **V** `admin.cpp:3323-3330` | 前端传空即 SQL 语法错 |
| 6 | `%g` 写 `req_price`/`trade_price`（默认 **6 位有效数字**） | **V** `admin.cpp:2662` | 大价格（如 123456.7）丢精度 |
| 7 | `tbinstrument_info.trading_day` 在 `admin.cpp:724` **写死 `'2026-03-10'`** | **V** | `m_symbol_exchange` 永不更新 |
| 8 | ORM `TbInstrumentInfo` 缺 `product_id`；ORM `Product` 多了 `id` | **V** `models.py:415-424`、`:269-280` | `create_all()` 会建出与生产不一致的表 |
| 9 | `server` 被同步改写为 `127.0.0.1`，但 `path` **原样保留 RDS 的 `/home/hft/TB.*`** | **V** `sync_tbhft_strategy.py:120` vs `CONTENT_COLUMNS` 含 `path` | `hft_control._start` 会 `cd /home/hft/TB.xxx/bin`（不存在）。190 上 `hft_control` 已不跑，属**潜伏缺陷** |
| 10 | RDS 的 `active`/`core`/`corebind` 也被同步覆盖 | **V** `CONTENT_COLUMNS` | 本地激活状态与核绑定每 10:30/20:30 被拉回生产镜像值；`core` 落在 `m_used_core` 里会**虚占本机不存在的核** |

### 6.5 事务边界

| 路径 | 边界 | 后果 |
|---|---|---|
| `PqHelper`（tbadmin 与 TradeBot 共用逻辑） | `pqxx::nontransaction` + 每条 `exec()` 后显式 `exec("commit;")` | **每条 SQL 自动提交**；多语句业务操作（策略 UPDATE + core UPDATE；man_order INSERT + 前端推送）**不原子** |
| `ops_feed_db.py` | 单 psycopg2 连接，`main()` 末尾一次 `commit()`，异常 `sys.exit(1)` 不提交 | **整批原子**（含 `DELETE tbtrade_sections` 全量重建）✅ |
| `sync_tbhft_strategy.py` | 显式单事务 | **原子** ✅（唯一） |
| `hft_control.build_schedule_table` | 每行一次 `commit()` | 中途失败留下半张表 |
| `tbhft_man_order` INSERT | 单语句 | 无跨表一致性需求 |

**`setval` 的坑**（已文档化）：PostgreSQL 的 `setval` **不受事务回滚影响**；在 `BEGIN … ROLLBACK` 里演练恢复会导致序列停在备份表的 `max(id)`，需补一次 `setval`。同步工具自身只用 `GREATEST(...)` 往大调，所以失败回滚不会造成 id 冲突。**V**（`tools/strategy_sync/README.md:65-70`）

### 6.6 竞态

| 竞态 | 机制 | 证据 |
|---|---|---|
| **sid 唯一性 TOCTOU** | admin 先 `SELECT DISTINCT sid` 校验，再让 agent 异步 INSERT；两个前端同时提交可双双通过 | **V** `admin.cpp:3541-3554`（校验）→ `:3556`（SQL 文本）→ `:3140-3143`（执行） |
| **同步 vs 人工编辑** | `strategy_sync` 在 10:30/20:30 全量 UPDATE `active/core/posdetail/...`；若操作员刚在 UI 改过，改动被覆盖（设计上"以 RDS 为准"） | **V** `sync_tbhft_strategy.py:218-227` |
| **同步 vs TradeBot 平仓回写** | 两者都写 `posdetail`；同步用 RDS 值覆盖，TradeBot 用本地值覆盖，最后写的赢 | **V**（同表同列，无版本号） |
| **admin 重启丢在途请求** | `m_req_time`/`m_orderRef2TotalQty`/`m_optmgr_st` 全在内存；重启后 core 分配与订单量映射丢失 | **V** `admin.cpp:3746-3794`（`m_orderRef2TotalQty[baseOrderRef++]`） |
| **core 分配双写** | `m_used_core` 从 `tbhft_strategy.core` + `tbors_core` 初始化，但 `tbors_core` 无写入方 → 只靠 `tbhft_strategy` | **V** `admin.cpp:819-843` |
| **cron 覆盖 crontab** | `ops/crontab.txt` 是**整份替换**安装；曾把 strategy_sync 行静默清掉（2026-10-04 → 10-05 才被发现） | **V** `ops/crontab.txt:27-31` |

### 6.7 SQL 拼接（无参数化）

所有 C++ 写路径都是 `std::string` 拼接或 `snprintf` 格式化，**没有 prepared statement / 绑定变量**：

| 位置 | 风险 |
|---|---|
| `admin.cpp:3489` | `modeldetail`/`posdetail` 是**整文件文本**（可达 KB），内含单引号（中文注释、`'`）→ SQL 语法错；**语句本身是 `std::string` 拼接，无长度上限，但 proto `sql` 字段与下游日志会吃亏** |
| `admin.cpp:2662` | `errormsg` 可能含中文与引号；输出缓冲 `char sql[2048]` → **超长时被 `snprintf` 静默截断**（截断后仍是"语法完整"的半条记录） |
| `admin.cpp:3556` | `product/type/instrument/path` 全部内插（`sid/parent/ref/status` 为裸数字拼接） |
| `admin.cpp:3252` | product 注册同理 |
| TradeBot 10 处 `UPDATE ... posdetail = '<整段>'` | 同 `modeldetail` 风险；一处失败只打日志 |
| `vue3-admin` | f-string 拼 SQL（`tbhft_man_order.py:31-96`、`futils.py:135,146,191-196`），`instrument_id ILIKE` 参数化但 `exchange/product` 内插 |

**影响**：① 含 `'` 的模型/仓位文本会导致写入失败；② 理论上可 SQL 注入（前端可信度决定风险等级）；③ 截断后 DB 里是**语法完整的半截内容**，比报错更危险。

### 6.8 一致性问题清单（复刻时必须显式决策）

| 项 | 现状 | 建议（P） |
|---|---|---|
| `(sid,type)` 唯一性 | 无约束 | `UNIQUE (sid, type)` + 应用层友好报错 |
| `product` FK | 无 | `tbhft_product(product,exchange,server)` 唯一 + FK |
| `ref` 类型 | int ↔ `"ref,core"` 双关 | 拆成 `ref_strategy_id int` + `released_core int` |
| `create_time` | 无默认 | `DEFAULT now()` + `NOT NULL` |
| `buy_sell` | char | 明确 `char(1) CHECK (buy_sell IN ('B','S'))` |
| `path` | 存旧生产路径 | 不落库，由部署根目录 + product 派生 |
| `posdetail` | 三源混合 | 独立快照表 + `captured_at` + 单写者 |
| 事务 | 逐条自动提交 | 每个业务动作一个显式事务 |
| 备份 | 同盘同库 | `pg_dump` + 异地（见 §7） |

---

## 7. 保留、备份与 PITR

### 7.1 已实现（V）

| 机制 | 覆盖范围 | 位置 | 保留策略 | 证据 |
|---|---|---|---|---|
| `tbhft_strategy_bak_sync_<ts>` | **仅 `tbhft_strategy`** | 同一 `dbtrade` 库 | 最近 10 张（`BACKUP_KEEP`） | `sync_tbhft_strategy.py:212-213,233-237` |
| `daily_init` 日快照 | `deploy_cpp/data/daily_init.*` | `deploy_cpp/daily_init_bak/<YYYYmmdd>/` | 无自动清理 | `scripts/ops_snapshot_daily_init.sh`（cron `00 07 * * 1-5`） |
| 资金/持仓快照 | `daily_init.*` + `position.csv` | `deploy_cpp/money_bak/money_<date>_<am\|pm>/` | 无自动清理 | `scripts/ops_snapshot_money.sh`（cron 11:46 / 15:16） |
| 日志轮转 | `deploy_cpp/bin/log/*` | `deploy_cpp/bin/log.bak/` | 同日目录、按日期后缀 | `scripts/ops_rotate_logs.sh`（cron 15:15） |
| git 版本化 | `daily_init.*` + `position.csv` | GitHub | 永久（仓库历史） | `scripts/ops_sync_git.sh:25`（cron 15:20） |
| git 版本化 | `fee.csv`、`data_cpp/data/*` | GitHub | 永久 | `ops_refresh_fee.sh`（cron 15:40） |
| 策略表上游 | RDS `appdb.tbhft_strategy` | 阿里云 RDS | 由 DBA 侧决定（**未知**） | `tools/strategy_sync/README.md:3-7` |

### 7.2 未实现（V，明确记录）

| 缺口 | 事实 |
|---|---|
| **无 `pg_dump`** | `find / -maxdepth 4 -name "*.dump" -o -name "*.sql.gz"` 无结果；crontab 无 dump 任务。`docs/RISK_NO_OFFSITE_BACKUP.md:119-120` |
| **无 PITR** | 无 `archive_mode` / `wal_level` 配置证据；`docs/architecture/21-backup-pitr.md` **不存在** |
| **无异地副本** | 190 单盘 `/dev/vda1` 178G，无 NFS/CIFS，`172.31.37.238`/`10.192.113.140` 均不可达。`docs/RISK_NO_OFFSITE_BACKUP.md:26-34` |
| **无 `tbhft_man_order` 归档** | 只增不删，无分区、无清理任务 |
| **无 `tbhft_schedule/action/product` 审计** | 无 `updated_at`、无变更日志 |
| **备份未验证** | 没有任何"从备份恢复"的演练记录；`tbhft_strategy_bak_sync_*` 的生成者曾被标为"未查证"（后被本次调查确认 = sync 工具） |

### 7.3 已接受的风险（P → 决策已落地）

- 2026-10-05 用户明确选择 **(d) 不建异地备份**。理由：无可达的独立存储、无对象存储凭据、日志增量 50–60 MB/交易日会在一年内把 git 仓库撑到 13–15 GB。**V**（`docs/RISK_NO_OFFSITE_BACKUP.md:3-6,§6`）
- 代价清单：`log.bak/`（791M）、`money_bak/`、`report_bak/`、`/data/u50_data/`（9.5G）、`ops/db.conf`、CTP 凭据、`/var/lib/pgsql/16/data/`（96M，含 `dbtrade` 15M）**全部只有一份**。**V**（`§3.2`）
- 若将来要做，唯一可行方案是**同区对象存储（腾讯 COS）**；`rsync` 到备份机与纳入 git 均被实测排除。**V**（`§7.2`）

### 7.4 恢复路径（现状下的可行操作）

| 场景 | 操作 | 数据损失 |
|---|---|---|
| 策略表被同步写坏 | `DELETE FROM tbhft_strategy; INSERT ... SELECT * FROM tbhft_strategy_bak_sync_<ts>; setval(...)` | 最近一次同步之后的本地改动 |
| 策略表被同步**误删行** | 同上（备份表含删前全量） | 同上 |
| 策略表全丢（磁盘坏） | 从 RDS 重新同步（`--apply --force`） | 本地独有行（如 `id=1` 的 92201 及其 `posdetail`）、`core/corebind` 分配 |
| `tbinstrument_info` / `tbtrade_sections` / `tbtrading_days` 丢 | 重跑 `ops_feed_db.py`（需当日 ORS dump 存在） | 当日 dump 缺失则合约表停在旧值 |
| `tbhft_product` 丢 | **无法自动重建**（SHM key 必须与 `ors_server.cfg`/`agent.cfg` 一致） | 需人工按配置重填 |
| `tbhft_man_order` 丢 | **不可恢复** | 全部手工单历史 |
| `tbadmin_position` 丢 | **不可恢复**（只能按柜台持仓手工重录） | 手工持仓 |
| 整库丢 | **只能从零重建**（见 §8） | 全部 DB 内容 |

---

## 8. 复刻要点

### 8.1 最小 schema（**P：以下 DDL 是建议，仓库里不存在**）

> 依据：列名与写入顺序来自 `sync_tbhft_strategy.py:37-41`、`admin.cpp` 各 SQL、`models.py`、`ops_feed_db.py`、`ops/db/hft_control_tables.sql`。类型按读写语义取最保守值。
> ⚠️ 若采用下面的 `ref_strategy_id` 改名，必须同步改 `sync_tbhft_strategy.py:COLUMNS`、`admin.cpp` 里 4 处 `ref` 拼接、`hft_manager.py` 的 `"ref": str(ref)`，否则同步/前端会当场报错。**P**

```sql
-- ============ 1. 策略注册表 ============
CREATE TABLE tbhft_strategy (
  id          serial PRIMARY KEY,
  sid         integer NOT NULL,
  parent      integer     DEFAULT 0,
  status      integer     DEFAULT 0,
  active      integer     DEFAULT 0,
  core        integer     DEFAULT -2,
  corebind    integer     DEFAULT 0,
  ref_strategy_id integer DEFAULT 0,   -- 原名 ref；建议改名以消除双关
  product     varchar(20) NOT NULL,
  exchange    varchar(20) NOT NULL,
  server      varchar(20) NOT NULL,
  type        varchar(40) NOT NULL,
  modelfile   varchar(255),
  modeldetail text,
  posfile     varchar(255),
  posdetail   text,
  optfile     varchar(255),
  optdetail   text,
  instrument  varchar(64),
  instrument2 varchar(64),
  path        varchar(255)
);
CREATE UNIQUE INDEX ux_strategy_sid_type ON tbhft_strategy (sid, type);
CREATE INDEX ix_strategy_server_active ON tbhft_strategy (server, active);

-- ============ 2. 产品 ↔ SHM key ============
CREATE TABLE tbhft_product (
  product varchar NOT NULL,
  exchange varchar NOT NULL,
  server  varchar NOT NULL,
  clientkey  varchar,
  monitorkey varchar,
  orsreqkey  varchar,
  orsrspkey  varchar,
  mdkey      varchar,
  path       varchar,
  PRIMARY KEY (product, exchange, server)
);

-- ============ 3. 交易时段（4 列新 schema，勿还原 7 列）============
CREATE TABLE tbtrade_sections (
  instrument_id varchar,
  startstr      varchar,   -- 'YYYYMMDD HH24:MI:SS' 北京时间
  endstr        varchar,
  is_trading    integer
);
CREATE INDEX ix_sections_prefix ON tbtrade_sections (is_trading, instrument_id);

-- ============ 4. 合约 ============
CREATE TABLE tbinstrument_info (
  instrument_id varchar PRIMARY KEY,
  trading_day   varchar,
  exchange_id   varchar,
  price_tick    double precision,
  expire_date   varchar,
  product_id    varchar
);
CREATE TABLE tbinstrument_name (
  instrument_id varchar PRIMARY KEY,
  send_name     varchar,
  exchange_id   varchar
);

-- ============ 5. 日历 ============
CREATE TABLE tbtrading_days (trading_day varchar PRIMARY KEY);

-- ============ 6. 手工单流水 ============
CREATE TABLE tbhft_man_order (
  id bigserial PRIMARY KEY,
  product       varchar,
  server        varchar,
  strategy_id   integer NOT NULL,
  exchange      varchar,
  instrument_id varchar,
  req_price     double precision,
  req_qty       integer,
  buy_sell      char(1) CHECK (buy_sell IN ('B','S')),   -- 注意：不是 int
  open_close    integer,
  order_id      bigint,
  status        integer,
  create_time   timestamp NOT NULL DEFAULT now(),         -- writer 不写，必须有默认
  cumfilledqty  integer,
  trade_price   double precision,
  trade_qty     integer,
  remain_qty    integer,
  errorid       integer,
  errormsg      varchar,
  trade_id      varchar
);
CREATE INDEX ix_man_order_order_id ON tbhft_man_order (order_id);
CREATE INDEX ix_man_order_create_time ON tbhft_man_order (create_time);

-- ============ 7. 手工持仓 ============
CREATE TABLE tbadmin_position (
  product       varchar NOT NULL,
  instrument_id varchar NOT NULL,
  type_id       varchar NOT NULL,
  long_qty      integer DEFAULT 0,
  short_qty     integer DEFAULT 0,
  PRIMARY KEY (product, instrument_id, type_id)
);

-- ============ 8. 控制面（190 上刻意留空）============
CREATE TABLE tbhft_schedule (time varchar, exchange varchar, strategytype varchar,
                             action int, product varchar, server varchar);
CREATE TABLE tbhft_action   (time varchar, exchange varchar, strategytype varchar, action int);

-- ============ 9. core 注册（只读遗留）============
CREATE TABLE tbors_core (server varchar PRIMARY KEY, corestr varchar);
```

### 8.2 Seed 顺序（**P**，按依赖）

```text
1. createdb dbtrade; 建 role trader / risker / admin；GRANT（仓库无此 DDL，必须自己写）
2. tbtrading_days   ← data_cpp/data/trading_days.txt（5298 行）
3. tbinstrument_info / tbinstrument_name
      ← 当日 ORS contracts_YYYY_MM_DD；**首次没有 dump 时**可从 contractfile 兜底（26,382 行，需自己写转换）
4. tbtrade_sections ← data_cpp/data/session_rules.csv（8 品种 → 23 行）
5. tbhft_product    ← SHM key 必须与 ors_server.cfg / agent.cfg 完全一致；**这是唯一不能凭空造的种子**
6. tbhft_strategy   ← 一条最小可用：sid=92201, type=TB_PAIR_STRAT, product=<p>, exchange=SFE,
                       modelfile=model.TB_PAIR_STRAT.ag_F_6_SFE.ag_F_8_SFE.txt,
                       posfile=daily_init.92201, instrument=ag_F_6_SFE, instrument2=ag_F_8_SFE,
                       status=1, active=0, core=-2, corebind=0, ref=0, path=<deploy root>
7. tbhft_schedule / tbhft_action：保持空表
8. tbadmin_position：空表
9. 启动 tbadmin admin → 检查 InitStList 载入行数 == DB 行数
```

### 8.3 测试数据（最小可跑集合）

| 对象 | 值 | 为什么 |
|---|---|---|
| 产品 | `product=demo`, `exchange=SFE`, `server=127.0.0.1`, 5 个 SHM key 与 `ors_server.cfg` 一致 | 少了它 agent 拒绝部署 |
| 策略 | `TB_PAIR_STRAT`，`instrument=ag_F_6_SFE` / `instrument2=ag_F_8_SFE` | 两腿都是**真实上期所期货**，不触发"ORS 不支持期权" |
| model | 3 行，两行含 `Dependant` | 少于 3 行被拒 |
| daily_init | 11 列（含 `avgPx`），`avgPx != 0`，`m_origbaseName1/2` 与 model 一致 | 否则拒绝启动 |
| fee.csv | 必须含 `ag2606`、`ag2608` 两行 | 缺一个就 `exit(1)` |
| contractfile | 必须含 `ag_F_6_SFE`/`ag_F_8_SFE` 可解析的 tick/lot | 否则 tick 沿用旧值 |

### 8.4 Shadow DB（**P**，但旧系统已用过同样手法）

- 旧 `hft_manager.py` 的默认目标就是 `127.0.0.1:5633` 的**另一个 `dbtrade`**（`hft_manager.py:20-21`）→ 证明"同 schema 第二实例"是被验证过的做法。**V**
- 复刻建议：`dbtrade_shadow` 同实例不同库，或第二实例；切换点只有两个：
  1. `tbadmin/cfg/{admin,agent}.cfg` 的 `DB_ADDR`/`DB_PORT`；
  2. `ops/db.conf` 的 `DB_HOST`/`DB_NAME`。
- 注意：`config_CHINA.<sid>.cfg` 里的 `DSN` 是**生成时写死**的，切库后必须重新部署策略（走一次 `102`），否则 TradeBot 仍写旧库。**V**（`admin.cpp:1816,1825`）

### 8.5 DDL / 迁移策略

| 现状 | 建议（P） |
|---|---|
| 无迁移框架、无 `schema_version` | 建 `schema_migrations(version, applied_at, checksum)` |
| 唯一 `.sql` 用 `CREATE TABLE IF NOT EXISTS`（只适合建空表，不能演进） | 每条变更一个 `ops/db/migrations/NNNN_*.sql`，只允许前向 |
| 表结构靠现场 `\d` 传承 | 把 `pg_dump --schema-only` 纳入 git，作为**唯一事实源** |
| ORM 与真实表已漂移（`Product.id`、`TbInstrumentInfo.product_id`） | ORM 只用于读；写路径用显式 SQL/迁移 |

### 8.6 验收检查（可直接执行的 SQL / 断言）

```sql
-- A. 结构
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tbhft_strategy';         -- 期望 21
SELECT count(*) FROM pg_indexes
 WHERE schemaname='public' AND tablename='tbhft_strategy';            -- ≥2（PK + sid/type）

-- B. 策略表
SELECT count(*) FROM tbhft_strategy;                                   -- 参考 277
SELECT count(*) FROM tbhft_strategy WHERE active=1;                    -- 参考 44
SELECT sid, type, count(*) FROM tbhft_strategy
 GROUP BY 1,2 HAVING count(*)>1;                                       -- 期望 0（除已知 41251）
SELECT count(*) FROM tbhft_strategy WHERE sid IS NULL OR type IS NULL; -- 期望 0
SELECT max(id), (SELECT last_value FROM tbhft_strategy_id_seq) FROM tbhft_strategy;
                                                                       -- 序列必须 ≥ max(id)
-- C. 配置完整性
SELECT s.sid, s.product FROM tbhft_strategy s
  LEFT JOIN tbhft_product p USING (product)
 WHERE s.active=1 AND p.product IS NULL;                               -- 期望 0
SELECT count(*) FROM tbtrade_sections WHERE is_trading=1;              -- 期望 23
SELECT count(*) FROM tbinstrument_info WHERE trading_day = to_char(now(),'YYYYMMDD');
                                                                       -- 期望 ~860（当日）
SELECT count(*) FROM tbtrading_days WHERE trading_day >= to_char(now(),'YYYYMMDD');
                                                                       -- 期望 >0（日历未过期）
-- D. 手工单可读性（验证 create_time 有默认）
SELECT count(*) FROM tbhft_man_order
 WHERE create_time >= date_trunc('day', now());                        -- 有手工单时应 >0

-- E. 文件一致性（shell）
--    deploy_cpp/data/daily_init.<sid> 内容 == tbhft_strategy.posdetail（物化后）
--    data_cpp/data/{fee.csv,contractfile,trading_days.txt} == /home/hft/tbdata/ 的 readlink -f
```

**验收门禁（P）**

1. `tbadmin admin` 启动日志无 `initstlist failed` / `init query trade section failed` / `init query core failed`。
2. 前端策略列表行数 == `SELECT count(*) FROM tbhft_strategy WHERE active=1`（注意 18:00 后 admin 会过滤 CFFEX/SH/SZ/GFEX，`admin.cpp:602-606`）。
3. 部署一个策略后，`config_CHINA.<sid>.cfg` 的 5 个 SHM key 与 `tbhft_product` 逐字相同。
4. TradeBot 启动后 `data/daily_init.<sid>` 的 `avgPx` 非 0 且与 DB `posdetail` 第二行一致。
5. 平仓后 `tbhft_strategy.posdetail` 与文件 `daily_init.<sid>` 内容一致（若不一致，说明有第三方覆盖）。

---

## 9. 证据索引

### 9.1 数据库与连接

| 结论 | 文件:行 | 级 |
|---|---|---|
| DB 键名与 `dbtrade` | `ops/db.conf.example:1-9` | V |
| `KEEP_INSTRUMENT_HISTORY` 语义 | `ops/db.conf.example:18` | V |
| `ops/db.conf` 被 gitignore | `.gitignore:101` | V |
| tbadmin admin cfg 键 | `tbadmin/cfg/admin.cfg:3-4`；`admin.cpp:4729-4736` | V |
| tbadmin agent cfg 键 | `tbadmin/cfg/agent.cfg:14-15`；`admin.cpp:4666-4667` | V |
| DSN 硬编码模板 | `admin.cpp:583,1816,1825` | V |
| PqHelper = nontransaction + 显式 commit | `tbadmin/persistence/pqhelper.cpp:12-15,29-31` | V |
| TradeBot 侧 DSN 读取 | `tbsrc/Strategies/ExecutionStrategy.cpp:69-72` | V |
| TradeBot 侧 PqHelper | `tbsrc/common/Pqhelper.cpp:7-20` | V |
| vue3-admin 两个库 | `vue3-admin/back_end/server/config.py:2-16` | V |
| sync 工具凭据位置 | `tools/strategy_sync/sync_tbhft_strategy.py:29,62-69`；`README.md:22-27` | V |
| `tbhft_strategy` owner=risker | `openspec/changes/archive/2026-09-23-add-strategy-db-sync/design.md:4` | V |
| PG16 实例存在、单盘 | `docs/RISK_NO_OFFSITE_BACKUP.md:26-34,108-116` | V |

### 9.2 表与 SQL

| 结论 | 文件:行 | 级 |
|---|---|---|
| 唯一 DDL 文件（3 张空表） | `ops/db/hft_control_tables.sql:1-32` | V |
| 策略表列清单（21 列） | `tools/strategy_sync/sync_tbhft_strategy.py:37-43` | V |
| 策略表 ORM | `vue3-admin/back_end/server/models.py:314-345` | V |
| 手工单 ORM | `models.py:490-540` | V |
| 手工单 INSERT | `admin.cpp:2601,2662-2669` | V |
| 手工单读侧（max(id) per order_id） | `vue3-admin/back_end/server/api/tbhft_man_order.py:38-96` | V |
| 订单状态码 | `tbadmin/inc/admin.h:29-37` | V |
| 产品表 ORM | `models.py:269-300` | V |
| 产品表 INSERT（硬编码 path） | `admin.cpp:3252-3266` | V |
| 手工持仓 upsert（唯一键） | `admin.cpp:1218-1226` | V |
| 手工持仓读入 | `admin.cpp:1123-1148` | V |
| `tbtrade_sections` 读 | `admin.cpp:63,848-858` | V |
| `tbinstrument_info` 读 + 死日期 | `admin.cpp:47,724` | V |
| `tbors_core` 读（无写者） | `admin.cpp:831-843` | V |
| 策略载入（含 18:00 过滤） | `admin.cpp:595-606` | V |
| 策略 INSERT / UPDATE / DELETE | `admin.cpp:3556,3489,3605,3611` | V |
| 核绑定回写 | `admin.cpp:3148,3158,3191,3525-3532` | V |
| 策略表建表统计（277/44） | `docs/2026-09-23_策略库分析.md:5,11` | V |
| 190/DB 行数清单 | `docs/RISK_NO_OFFSITE_BACKUP.md:66` | V |

### 9.3 同步工具

| 结论 | 文件:行 | 级 |
|---|---|---|
| 规则表（新增/更新/删除/本地独有/冲突） | `sync_tbhft_strategy.py:5-21`；`README.md:9-17` | V |
| 差异算法 | `sync_tbhft_strategy.py:135-169` | V |
| 单事务写库 + 备份 + setval + 清理 | `sync_tbhft_strategy.py:204-239` | V |
| 写后校验（只比 id 集合） | `sync_tbhft_strategy.py:325-330` | V |
| 批次跳过 | `sync_tbhft_strategy.py:318-320` | V |
| 冲突退出码 2 | `sync_tbhft_strategy.py:314-316` | V |
| cron 行 | `ops/crontab.txt:61-67` | V |
| 回滚 SQL + setval 坑 | `tools/strategy_sync/README.md:55-70` | V |
| 单测 | `tools/strategy_sync/test_sync_tbhft_strategy.py:1-71` | V |

### 9.4 文件数据源

| 结论 | 文件:行 | 级 |
|---|---|---|
| `ops_feed_db` 三段数据源 | `scripts/ops_feed_db.py:7-14` | V |
| 合约 dump 0 字节处理 | `ops_feed_db.py:75-108` | V |
| 伪代码行过滤（栈变量指纹） | `ops_feed_db.py:193-245` | V |
| `tbinstrument_info` 只留当日 | `ops_feed_db.py:264-265` | V |
| `contractfile` 同步（非生成） | `ops_feed_db.py:272-284` | V |
| `fee.csv` 消费者（前缀匹配 + exit） | `tbsrc/main/TradeBotUtils.cpp:2463-2486` | V |
| `contractfile` 消费者（exit / 静默旧值） | `tbsrc/common/Instrument.cpp:1548-1582` | V |
| `daily_init` 解析（按表头） | `tbsrc/Strategies/PairwiseArbCSOStrategy.cpp:290-322` | V |
| `daily_init` 写入 | `PairwiseArbStrategy.cpp:1083-1122` | V |
| `position.csv` 写点与格式 | `ors/China/src/ORSServer.cpp:207-233,1557-1562` | V |
| 文件→deploy 拷贝规则 | `scripts/build_deploy_cpp.sh:828-838` | V |
| deploy→data_cpp 回灌（mtime 新赢 + 反向下发） | `scripts/sync_data_back.sh:24-56` | V |
| `/home/hft/tbdata` 符号链接 | `scripts/ops_install_deps.sh:42-50`；`docs/RISK_NO_OFFSITE_BACKUP.md:76-90` | V |
| 时段重算 + `sections.csv` 重生成 | `scripts/ops_setup_arbi.sh:84-152` | V |
| 上游文件现状总表 | `docs/UPSTREAM_SYNC.md:15-27` | V |

### 9.5 备份与保留

| 结论 | 文件:行 | 级 |
|---|---|---|
| 无异地副本（已接受） | `docs/RISK_NO_OFFSITE_BACKUP.md:1-6,§6` | V |
| 无 `pg_dump` 产物 | 同上 `:119-120` | V |
| 备份表存在但未查证生成者 | 同上 `:115-118` | V（本次调查已确认 = sync 工具） |
| `daily_init` 日快照 | `scripts/ops_snapshot_daily_init.sh:1-40` | V |
| 资金快照 | `scripts/ops_snapshot_money.sh:1-50` | V |
| git 同步范围 | `scripts/ops_sync_git.sh:25` | V |
| crontab 整份替换的坑 | `ops/crontab.txt:27-31` | V |
| `docs/architecture/21-backup-pitr.md` 不存在 | `ls docs/architecture`（仅 3 文件） | V |

---

## 10. 未决问题（需现场/负责人确认）

1. **`tbhft_strategy` / `tbhft_man_order` / `tbinstrument_info` 的真实 DDL 与索引**：仓库无 DDL，本文的键/索引全是推断。需要一次 `pg_dump --schema-only dbtrade` 落到 git，否则复刻只能"看起来像"。
2. **`tbhft_man_order.create_time` 是否有 DB 默认值**：C++ 不写该列，读侧却按它过滤。若无默认（且列可空），手工单页面会长期为空——但没人报过，怀疑是历史遗留页面。需要现场 `\d tbhft_man_order` 或跑一条 `INSERT` 试探。
3. **`tbhft_man_order.id` 的生成方式**：ORM 声明 `BigInteger` PK 但 INSERT 不给值；必须有 `serial`/`identity`/默认序列，仓库无证据。
4. **`tbhft_product` 是否真有 `id` 列**：ORM 声明了，DDL 与 INSERT 都没有。二者只能有一个对。
5. **`tbhft_strategy.path` 在 190 上的实际值**：同步会带入 RDS 的 `/home/hft/TB.*`。是否有人手工改回 `/root/quantlink-trading/deploy_cpp`？只能现场 `SELECT DISTINCT path`。
6. **`tbors_core` 是否有写入方**：全仓无 INSERT/UPDATE。若为空且 `tbhft_strategy.core` 被 RDS 覆盖成生产核号，admin 的 core 分配会虚占不存在的核。需现场核对 `SELECT * FROM tbors_core` 与 `SELECT core,count(*) FROM tbhft_strategy WHERE active=1 GROUP BY 1`。
7. **RDS 侧 `imported_at` 的刷新保证**：同步的"批次未变化则跳过"完全依赖它。若 RDS 端某天不更新 `imported_at` 而内容已变，本地会**静默不同步**。
8. **`tbhft_strategy_bak_sync_*` 是否曾被用于真实恢复**：文档只写了演练 SQL，没有实战记录。
9. **`trading_days.txt`（5298 行）与 `tbtrading_days`（5094 行 @10-05）的差**：文件在 10-20 又更新过，DB 是否已追平未验证。
10. **`vue3-admin` 的 `admin` 库是否需要一起复刻**：交易链路不需要（tbadmin 用 `trader` 直连 `dbtrade`），但控制台登录需要。若不复刻，Vue 页面不可用，不影响交易。

---

### 附：本文未覆盖（去别的章节看）

- 进程/主机拓扑、SHM key 全表、ZMQ 主题 → `01-system-architecture.md`、`03-ors-connectors.md`
- `tbadmin` 消息协议与前端交互细节 → `04-admin-control-plane.md`
- 构建、systemd、cron 时序 → `06-build-deploy-ops.md`
- 备份/恢复的**操作步骤**、日志轮转细节 → `07-operations-runbook.md`
- 弱口令、SQL 注入、明文凭据的完整评估 → `08-security-gaps.md`
- 从零复刻的执行顺序与验收门禁 → `09-replication-playbook.md`

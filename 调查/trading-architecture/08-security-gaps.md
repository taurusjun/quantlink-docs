# 08 — 安全模型、信任边界、故障模式与缺口

> 证据约定：**V** = 直接读代码/配置/脚本确认；**I** = 由结构、脚本或部署方式推断，未在运行环境验证；**P** = 文档/计划描述，当前代码未完全实现或未现场复核。
>
> 调查对象：`/Users/wangjun/PG/RD/quantlink-trading`，commit `5cee3dd5b3322ec21c1958aac20ad38ba0d8ca40`，分支 `main`，2026-11-18。
>
> 范围：安全模型、信任边界、凭据、认证授权、审计、网络暴露、可用性/完整性、代码级风险、合规与改进路线。**不含 `web-go`/Go Dashboard 内部实现**；只在网络暴露处把它当黑盒。
>
> **本文不复制任何密码、token、webhook、私钥或 CTP 凭据值。** 只记录位置、类型、权限、加载方式和轮换缺口。文中出现的 `trader`、`risker`、`admin` 等是代码里的用户名/默认口令线索，不是生产实值。

---

## 0. 结论摘要

这套系统的安全模型基本是 **“单机 root + 本地回环 + 明文协议 + 默认口令 + 无认证管理面”**。它假设“能登录 190 的人都是可信运维”，但这个假设在公网 IP、开放端口、ZMQ 命令通道、Web 管理面和自动同步脚本同时存在时不成立。

最严重的十条：

| # | 结论 | 级别 | 关键证据 |
|---|---|---|---|
| 1 | `tbadmin admin` 的 ZMQ 管理通道绑定 `tcp://*:9980/9981`，无认证、无加密；消息可直接触发 `popen()` 执行命令。 | **P0/致命** | `tbadmin/admin.cpp:509,781,2064-2092,3675-3693`；`tbadmin/cfg/admin.cfg:1-2` |
| 2 | Web 管理面（Flask 5004 / message_forwarding 8882 / nginx 50003）无认证；前端路由显式跳过登录；CORS 全开；表单 POST 无 CSRF 保护。 | **P0/致命** | `vue3-admin/back_end/runserver.py:32,117`；`tbadmin-front/my-admin/src/router/index.js:18-23`；`vue3-admin/back_end/message_forwarding/message_forwarding.py:544-557` |
| 3 | 多个入口把外部输入拼进 SQL 和 shell：`exchange/product/sid/path` 可注入；RDS 同步来的 `path` 最终被 `admin` 当 shell 命令执行。 | **P0/致命** | `tbadmin/admin.cpp:3662,3675-3693`；`vue3-admin/back_end/server/api/tbhft_man_order.py:38-70`；`tools/strategy_sync/sync_tbhft_strategy.py:37-41,176-183` |
| 4 | ORS 把 CTP `PASSWORD` 明文写进日志（4 处登录日志 + 1 处下单请求日志），并写到 stdout 文件；TradeBot 把含 DB 密码的 DSN 写进策略日志。 | **P0/致命** | `ors/China/src/ORSServer.cpp:420,430,443,460,2146`；`tbsrc/Strategies/ExecutionStrategy.cpp:72`；`tbadmin/admin.cpp:1816,1825` |
| 5 | 大量凭据是明文、git 跟踪或默认弱口令：Flask DB 连接串、tbadmin/tbadmin-py 的 DB DSN、YD appID/authCode、ESB app_key、Flask SECRET_KEY、示例 passwordfile、FTP 游客账号。 | **P0/高** | `vue3-admin/back_end/server/config.py:2,8,9`；`tbadmin/admin.cpp:583,1816,1825`；`tbadmin/client_yd.cpp:23`；`tbuser.py:201`；`passwordfile.xml:2-3`；`getNSECDSTokens.sh:1` |
| 6 | `.env` 在仓库根目录、权限 644，注释和第 8 行含备用 SSH 密码；`ops/db.conf` 本地为 644 模板，190 上按文档为实值。 | **P0/高** | `.env:1-8`；`ops/db.conf`（本地占位）；`docs/RISK_NO_OFFSITE_BACKUP.md:63` |
| 7 | 停止流程并不可靠：`SIGTERM` 只有在 `./config/signal.txt` 列出的合约才平仓；仓库里没有该文件；10 秒后 `pkill -9 -f "TradeBot"`，可能留下未平仓且不写 `daily_init`。 | **P0/致命** | `tbsrc/main/main.cpp:110-118,142-149`；`scripts/build_deploy_cpp.sh:682-694`；`docs/2026-09-23_策略库分析.md:205` |
| 8 | 关键 SysV SHM 均以 `0666` 创建/附加；任何本机用户/进程都能读行情、持仓、PnL，或往 Request SHM（8193）写订单；ORS 不验证请求来源。 | **P0/致命** | `ors/China/src/ORSServer.cpp:281,491-506`；`scripts/build_deploy_cpp.sh:600`；`C++_deps/hftbase/Ipc/include/shmqueue.h:50` |
| 9 | CTP 回调里对 `pRspInfo` 多处无空指针保护；`position.csv` 用 `strtok/atoi` 解析且不检查缺列；DB 断线时 tbadmin 的 `m_db_trade` 为空仍被解引用。 | **P0/高** | `ors/China/src/ORSServer.cpp:190-194,1964,2047,2552-2557`；`tbadmin/admin.cpp:1524-1525,821` |
| 10 | 没有异地备份、没有 `pg_dump`、没有证据表明有 PITR、没有双人复核、没有 pre-trade 资金检查、没有账户级对冲、没有不可篡改审计。 | **P1/高** | `docs/RISK_NO_OFFSITE_BACKUP.md:54-66,109-120`；`data_cpp/bin/config/StrategyConfig.cfg:1`；`data_cpp/bin/config/ors/configs/rms/prod.china.rms.xml:2-9,23-27` |

**一句话判断**：这不是“有几个漏洞”，而是 **信任边界画错了**：把管理面、命令通道和交易请求 SHM 都放在了“本机/内网可信”的假设里，却同时把它们暴露在公网或弱隔离网络中。复刻前必须先重画边界，而不是照抄端口和默认值。

---

## 1. 信任边界与攻击面

### 1.1 资产

| 资产 | 位置/载体 | 被攻破的后果 |
|---|---|---|
| CTP 交易账户 | `ors_server.cfg`（gitignored，190 上） | 直接下单、撤单、平仓；资金损失 |
| 订单/成交/持仓 | SHM 8193/12289/4097、PostgreSQL `dbtrade`、`position.csv`、`daily_init.*` | 错误交易、重复平仓、对账失真 |
| 策略配置/模型 | `data_cpp/bin/controls`、`models`、`tbhft_strategy` | 改参数、改合约、启动/停止策略 |
| 管理命令通道 | ZMQ 9980/9981、Flask 8882、HTTP 5004/50003 | 远程启停策略、杀进程、下单 |
| 凭据 | `.env`、`ops/db.conf`、`ors_server.cfg`、`strategy_sync.env`、`feishu.secret.yaml`、`/root/quantlink-backups` | 横向移动、数据泄露、冒充交易 |
| 审计/复盘数据 | `deploy_cpp/bin/log*`、`log.bak/`、`money_bak/`、DB | 无法追责、无法复盘、合规缺口 |
| 主机 | 190 单机 root、cron、SSH | 全系统失守 |

### 1.2 边界图

```text
                 公网 / 办公网 / 旧内网（可达性未验证）
                              │
        ┌─────────────────────┼──────────────────────────┐
        │ SSH 22 (root)       │ HTTP 50003/5004/8882/8080/8081 │
        │ key + 备用密码      │ 无 TLS / 无认证（多数）        │
        ▼                     ▼
┌──────────────────────────────────────────────────────────────┐
│ 190 单台 Linux 主机（root 运行所有进程，无 systemd 单元）       │
│                                                              │
│  ors_server ──SHM 4097/8193/12289/16385 (0666)── TradeBot     │
│      │                                              │        │
│      │ CTP API（出站）                               │ 日志/DSN│
│      ▼                                              ▼        │
│  期货公司柜台                                   log/ + core    │
│                                                              │
│  tbadmin admin  :9980/:9981  ZMQ 明文，bind *，无认证         │
│  tbadmin agent  ── SHM 789/4097 ── memlog                      │
│  Flask 5004 / message_forwarding 8882 / nginx 50003           │
│  PostgreSQL 127.0.0.1:5432  (admin/risker/trader 默认口令)     │
│  cron(root) ── scripts ── git push(GitHub) / RDS 同步          │
│  文件系统：.env(644)、ops/db.conf、ors_server.cfg、日志、core   │
└──────────────────────────────────────────────────────────────┘
```

### 1.3 边界逐项

| 边界 | 跨越的内容 | 现有控制 | 结论 | 证据 |
|---|---|---|---|---|
| 主机/root | 所有进程、所有文件、所有 cron | 无服务用户、无 namespace/cgroup、无 SELinux/AppArmor 证据 | **不存在进程级隔离**；任一 Web/ZMQ RCE = root | `scripts/*` 全部 `/root/...`；`tbadmin/start_admin.sh:1-18` |
| DB | 策略、订单、持仓、风险、用户 | 本机 TCP + 用户名口令；无 TLS、无角色隔离证据 | 本机可连；SQL 注入可直达；口令硬编码 | `vue3-admin/back_end/server/config.py:2,8,9`；`tbadmin/admin.cpp:583` |
| CTP 网络 | 登录、报单、回报、行情 | CTP API 自身认证/握手；账户级权限由柜台控制 | 应用层没有二次授权；账户共享；断线/双登录会互踢 | `ors/China/src/ORSServer.cpp:403-415`；`docs/RISK_NO_OFFSITE_BACKUP.md:33` |
| ZMQ | `toadmin`/`tofront`/`operation`/`103` 命令 | 无 CURVE、无 ACL、无来源校验；admin 绑定所有网卡 | **任何人能连 9980 就能发管理命令** | `tbadmin/admin.cpp:509,781,2064-2092` |
| HTTP/WebSocket | 策略查询、风险修改、手动下单、启停 | 无统一认证；CORS `*`；无 CSRF；前端跳过登录 | **未认证即可改配置/下单**（若端口可达） | `runserver.py:32,117`；`message_forwarding.py:544-557`；`router/index.js:18-23` |
| SHM | 行情、订单请求、回报、MemLog | 文件权限 `0666`；无请求签名/来源校验 | **本机任意进程可读可写**；可伪造订单/持仓显示 | `ORSServer.cpp:281`；`build_deploy_cpp.sh:600` |
| 文件系统 | 配置、凭据、日志、core | 默认 umask；部分文件 644；无加密 | 凭据可读；日志含密码；core 含内存秘密 | `.env` 644；`ops/db.conf` 644；`tbadmin/start_admin.sh:4-5` |
| SSH | root 登录、GitHub key | key + 备用密码；`sshd_config` 不在仓库 | 若密码登录开启，弱口令风险高；无堡垒机证据 | `.env:4-5`；`docs/RISK...:34` |
| cron/同步 | 启停、快照、git push、RDS 拉取 | root crontab；无签名/审批；`flock` 仅 strategy_sync | 配置/策略可被上游 RDS 或本地脚本静默改写 | `ops/crontab.txt:43-115`；`tools/strategy_sync/...` |

### 1.4 攻击面清单（按可达性排序）

| 入口 | 认证 | 最坏结果 | 证据 |
|---|---|---|---|
| ZMQ 9980 `toadmin` | 无 | 启停策略、`kill -9`、`popen` 任意命令、SQL 注入 | `admin.cpp:2064-2092,3675-3693` |
| Flask 5004 全部 `/admin_backend/*` | 无 | 改风险参数、加/删用户、读全部订单/持仓、手动下单 | `runserver.py:35-51`；`tbhft_man_order.py`；`tbproduct_risk.py` |
| message_forwarding 8882 `/tbadmin/transmit` | 无 | 把任意 JSON 转成 `toadmin` 消息 | `message_forwarding.py:544-557` |
| Socket.IO `/server` `/order` `/md` | 无 | 订阅全部订单/持仓/PnL；`socketio` `cors_allowed_origins='*'` | `message_forwarding.py:31-33,464-520` |
| nginx 50003 | 无 | 读取管理前端静态资源；配合 API 使用 | `ops/nginx/quantlink-admin.conf:2-17` |
| Dashboard 8080/8081 | 未核查（范围外） | 可能读持仓/PnL；手动下单开关默认 false | `web-go/config.yaml:1-22`；`web-go/cmd/memlog-reader/main.go:316,334` |
| Request SHM 8193 | 无（0666） | 伪造报单/撤单，直接到 CTP | `ORSServer.cpp:281,491-506` |
| MemLog SHM 789 | 无（0666） | 伪造策略状态/持仓显示，误导运维 | `build_deploy_cpp.sh:600`；`tbadmin/admin.cpp:282-297` |
| SSH 22 | key/密码 | root 全控 | `.env:4-5` |

---

## 2. 凭据与密钥

### 2.1 清单（不复制值）

| 位置 | 类型 | Git | 权限/状态 | 风险 | 轮换 | 证据 |
|---|---|---|---|---|---|---|
| `.env` | SSH host/user/password；第 5 行注释含备用 SSH 密码；第 8 行 `SERVER_190_PASS` | **untracked**（`.gitignore:95`） | 本地 644；值看起来是实值 | 明文、同机、可能被复制/同步；弱/复用未知 | 无流程 | `.env:1-8`；`stat` |
| `ops/db.conf` | PostgreSQL host/user/pass + 企微 webhook | untracked（`.gitignore:101`） | 本地 644，仍是模板占位（`DB_USER=<DB_USER>`，webhook 为占位） | 190 上按文档为 846B 实值，权限未验证 | 无 | `ops/db.conf.example:1-15`；`docs/RISK...:63` |
| `ops/db.conf.example` | 模板 | tracked | 644 | 本身无实值；但注释说明 webhook 默认停用 | — | `ops/db.conf.example:11-15` |
| `data_cpp/bin/config/ors_server.cfg` | CTP BrokerID/InvestorID/Password/AuthCode/AppID、前置地址 | untracked（`.gitignore:42`） | 本地不存在；190 上手工配置 | **最高价值凭据**；与日志/备份同机 | 无 | `docs/STARTUP_GUIDE.md:88,126`；`.gitignore:42` |
| `tools/strategy_sync/strategy_sync.env` | 阿里云 RDS + 本地 PG 凭据 | untracked（`.gitignore:89`） | 文档要求 600；实际未验证 | 公网 RDS 凭据；同步进程可改写策略表 | README 有手工步骤，无自动轮换 | `strategy_sync.env.template:1-13`；`tools/strategy_sync/README.md:26-29` |
| `feishu.secret.yaml` | 飞书 webhook/secret | untracked（`*.secret.yaml`） | 未验证 | 告警通道可被伪造/滥用 | 无 | `web-go/config.yaml:15-16`；`data_cpp/bin/config/memlog-reader.yaml:15-16` |
| `/root/quantlink-backups/*.bak` | CTP 凭据 `.bak` | 不在 git | 与生产同盘 | “挪出 git”≠“有副本/加密” | 无 | `docs/RISK...:64` |
| `vue3-admin/back_end/server/config.py` | `admin`/`risker` DB 连接串 | **tracked** | 源码明文 | 默认弱口令；Web 进程可直接连库 | 改代码/环境变量 | `config.py:2,8,9` |
| `tbadmin/admin.cpp` | `dbtrade` DSN，用户 `trader` | **tracked** | 源码明文；MMF 分支生成的 `config_CHINA.*.cfg` 含 DSN 且 `chmod 0755`；所有分支的 `StrategyConfig.cfg` 也含 DSN | 任何能读生成配置/日志的人拿到 DB 口令 | 改代码 | `admin.cpp:583,1816,1820,1825` |
| `tbadmin/py/hft_control.py`、`hft_manager.py`、`tbadmin-py/hft_control/hft_control.py` | PostgreSQL DSN | **tracked** | 源码明文 | 遗留工具仍可连库 | 改代码 | `hft_control.py:51`；`hft_manager.py:94`；`tbadmin-py/...:53` |
| `vue3-admin/back_end/message_forwarding/futils.py` | PostgreSQL DSN | **tracked** | 源码明文 | 消息转发进程可读写 `dbtrade` | 改代码 | `futils.py:85` |
| `tbadmin/client_yd.cpp` | YD `appID`/`authCode` | **tracked** | 源码明文；YD 配置文件另有账号/口令 | legacy 柜台凭据 | 无 | `client_yd.cpp:23,71` |
| `vue3-admin/back_end/server/api/tbuser.py` | 统一认证 ESB `app_key` | **tracked** | 源码明文；HTTP 内网地址 | 可冒充登录校验 | 无 | `tbuser.py:199-201,235` |
| `message_forwarding.py` | Flask `SECRET_KEY` | **tracked** | 源码明文默认值 | 会话/签名可伪造（若使用 session） | 无 | `message_forwarding.py:31-33` |
| `tbsrc/hftbase/DataService/config/passwordfile.xml` | 示例用户名/口令 | **tracked** | 644 | 默认弱口令；若被 DataService 使用则可登录 | 无 | `passwordfile.xml:1-4` |
| `tbsrc/scripts/getNSECDSTokens.sh` | FTP 游客账号/口令 | **tracked** | 644 | 共享弱口令；遗留 NSE 数据脚本 | 无 | `getNSECDSTokens.sh:1` |
| `vue3-admin`/`tbadmin-front` `.env.*` | 公网 IP、内网 SSO URL | **tracked** | 明文 | 信息泄露；生产仍走 HTTP | 无 | `tbadmin-front/my-admin/.env.development:10-15`；`.env.production2:10-15` |
| 日志 | CTP 密码、DB DSN、账户余额 | 本地文件 | 默认 644/755 目录 | 复盘/备份/截图即泄露 | 无 | `ORSServer.cpp:420,430,443,460,2146`；`ExecutionStrategy.cpp:72` |
| core dump | 进程内存（含凭据） | 本地文件 | `ulimit -c unlimited`，`core-%e-%p-%t` | tbadmin core 可能含 DB/YD 口令 | 无 | `start_admin.sh:4-5`；`start_agent.sh:4-5` |

### 2.2 具体判断

1. **明文**：`.env`、`ops/db.conf`（190）、`ors_server.cfg`、`strategy_sync.env`、`feishu.secret.yaml`、YD 配置、DB DSN、日志、core，全部是明文或可还原明文。
2. **git-tracked 凭据**：`config.py`、`admin.cpp`、`hft_control.py`、`hft_manager.py`、`futils.py`、`client_yd.cpp`、`tbuser.py`、`message_forwarding.py`、`passwordfile.xml`、`getNSECDSTokens.sh`。这些不是“示例值”就是“默认值”，但仍是凭据类信息；其中 DB/YD/ESB 凭据可直接用于横向移动。
3. **弱/默认**：DB 用户使用“用户名=口令”的默认串；`admin_user` 新用户使用硬编码默认口令（`user.py:49`，值不复述）；示例 `passwordfile.xml` 用户名/口令相同；FTP 为共享游客账号。生产是否改过未验证。
4. **权限过大**：部署脚本、cron、日志路径全部以 `/root` 为根，未见降权/服务用户；按 `.env` 与文档判断实际以 root 运行（I）。Web 进程的 DB 用户可读写 `dbtrade`；`trader` 同时被 tbadmin、策略、消息转发使用；没有证据表明存在只读/最小权限角色。`ops/db.conf` 被多个 root 脚本 `source`，文件内容等同于 root shell 代码。
5. **轮换缺口**：没有自动轮换、没有过期时间、没有 secret manager；`m_NEWPASSWORD` 只被读取（`ORSServer.cpp:413`），没有调用 CTP 改密接口；换密码需要改源码/生成配置/重启。CTP 密码已经进入日志，**必须视为已泄露并轮换**。
6. **复用**：`.env` 的备用 SSH 密码与 `SERVER_190_PASS` 相同（同一文件第 5/8 行），是否与 root/其他系统复用未知；这类“备用密码”通常会被复制到聊天/文档，风险高于 key。

### 2.3 最小处置

- 删除 `.env` 中的密码注释和 `SERVER_190_PASS`，只保留 host/user；改用 SSH key + 堡垒机；若密码已外泄，立即轮换并禁用密码登录。
- `chmod 600` 所有本地凭据文件；生产 `ops/db.conf`、`ors_server.cfg`、`strategy_sync.env`、`feishu.secret.yaml` 同样 600，属主为专用服务用户。
- 把 `config.py`/`admin.cpp` 的 DSN 改为环境变量或 `/etc/quantlink/*.env`（600），代码只读环境；删除 `hft_control.py`/`hft_manager.py`/`futils.py` 的硬编码 DSN。
- 删除 ORS/TradeBot 日志中的密码/DSN 输出；清理历史日志和 core；轮换 CTP、DB、YD、ESB、webhook、SSH 凭据。
- 加一个提交前扫描（`gitleaks`/`git-secrets`）和 CI 检查；当前仓库没有这类门禁（V：无 CI 配置）。

---

## 3. 认证与授权

### 3.1 组件矩阵

| 组件 | 认证 | 授权 | 结论 | 证据 |
|---|---|---|---|---|
| `tbadmin admin` ZMQ | 无 | 无；按消息类型直接执行 | **完全信任网络来源** | `admin.cpp:509,781,2064-2092` |
| `tbadmin agent` ZMQ | 无 | 只校验 `server == m_local_ip` 或空/0.0 | 本机回环也信任；消息可伪造 | `admin.cpp:2159-2175` |
| `tbadmin` 前端登录 | 有 UI；后端 `/user/login` 可校验 `tbuser` | 角色只返回给前端；后端不校验 | **认证可选、授权不存在** | `tbuser.py:258-300`；`userstore.js:31-39` |
| Vue/Flask API | 无统一中间件 | 无 | 所有端点默认开放 | `runserver.py:30-54` |
| message_forwarding | 无 | 无 | 任意 POST 转 ZMQ | `message_forwarding.py:544-557,636-651,746-890` |
| Socket.IO | 无 | 无；CORS `*` | 任意站点可连 | `message_forwarding.py:31-33` |
| PostgreSQL | 用户名/口令 | 角色/GRANT 未在仓库定义 | 默认口令 + 可能同库 owner | `config.py:2,8,9`；`admin.cpp:583` |
| CTP 会话 | 柜台 BrokerID/InvestorID/Password/AuthCode | 交易所/柜台账户权限 | 应用层无二次认证；账户共享 | `ORSServer.cpp:403-415` |
| Request SHM | 无 | 无 | 任何本机进程可冒充策略 | `ORSServer.cpp:281,491-506` |
| Dashboard 8080/8081 | 未核查（范围外） | 未核查 | 默认 `manual_order.enabled=false`，但读接口可能开放 | `web-go/config.yaml:18-22` |

### 3.2 前端登录的真实状态

- 登录页存在（`tbadmin-front/my-admin/src/views/user/Login.vue`），调用 `/user/login`。
- 后端 `user.py` 里旧的 `/user/login` 被整段注释（`user.py:20-38`）；实际生效的是 `tbuser.py:258`。
- `tbuser.py:282` 用 f-string 拼 `username` 查菜单，存在 SQL 注入；`:289` 把 `user.password` 原样返回给前端。
- 前端把 `password` 写进 **非 HttpOnly 的 cookie**（`userstore.js:38`），并在刷新时从 cookie 恢复（`:47`）。任何 XSS/浏览器扩展/共用电脑都能拿到明文口令。
- 路由守卫被改成“所有路由直接放行”（`router/index.js:18-23`）；没有 token 校验、没有过期、没有刷新机制。
- `user.py:92-105` 的改密接口不验证旧密码，只按 `username` 更新；配合无认证 API，任何人可改任意用户口令。
- `user.py:49` 新用户使用硬编码默认口令（值不复述）；`models.py:126-150` 明文存储口令；没有哈希、没有盐、没有密码策略。

### 3.3 不存在的控制

- 没有统一认证中间件（`before_request` 只做初始化，`runserver.py:89-113`）。
- 没有 RBAC 服务端校验；`role`/`menu` 只用于前端展示。
- 没有 API token、mTLS、HMAC、IP allowlist（ZMQ/HTTP 都没有）。
- 没有 CSRF token；Flask 接受 `application/x-www-form-urlencoded`，任意站点可替用户发请求（如果浏览器能访问目标）。
- 没有登录失败锁定、速率限制、验证码、MFA。
- 没有会话吊销/单点登出；前端删 cookie 不等于服务端失效。
- 没有 DB 行级安全（RLS）或最小权限角色定义。
- 没有 CTP 账户级操作员身份：所有策略/手动单都归到同一个 `ACCOUNT=OWN`。

---

## 4. 审计能力

### 4.1 事件矩阵

| 事件 | 现有记录 | 缺口 | 证据 |
|---|---|---|---|
| 策略报单/撤单 | 策略日志 `log.control.*`；MemLog；ORS 日志 | 无操作员身份；日志可删；无 WORM；无集中检索 | `ORSServer.cpp:491-506`；`ExecutionStrategy.cpp:238-258` |
| 手动报单/撤单 | `tbhft_man_order` 表（product/strategy_id/instrument/price/qty/status/error/trade_id） | **没有 user/operator 字段**；`strategy_id=-1`；DB 写失败不影响已发单 | `models.py:490-513`；`admin.cpp:2662-2670`；`admin.h:26` |
| 手动单的“谁点的” | 前端有当前用户，但请求不带身份 | 后端不记录；可否认 | `tbhft_man_order.py`；`message_forwarding.py:544-557` |
| 策略启停/杀进程 | tbadmin debug 日志 `cmd:`；`log/admin.log` | 3 天轮转；无命令审计表；无操作员 | `admin.cpp:3700-3705`；`ops/logrotate/quantlink-tbadmin:3-12` |
| 策略配置/参数修改 | `risk_edit_log` 表（username/target_table/operation_type/old/new） | **客户端自己调 `/addOneRecord` 写入**，username 可伪造；不写也能改；策略表本身无历史 | `risk_edit_log.py:46-71`；`models.py:457-467` |
| `tbhft_strategy` 变更 | 只有 `posdetail` 更新；RDS 同步前建同库备份表 | 无 before/after diff 审计；备份同库同盘 | `PairwiseArbStrategy.cpp:1121`；`sync_tbhft_strategy.py:206-240` |
| 登录/登出 | 无登录审计表；前端只写 cookie | 无法追责；无失败记录 | `tbuser.py:258-300`；`userstore.js:31-39` |
| DB 结构/数据变更 | 仓库无 trigger/audit 扩展；无 `pgaudit` 配置 | 应用可改；DBA 操作不可见 | `ops/db/hft_control_tables.sql:6-32`（无审计表/触发器） |
| 配置/文件变更 | git 跟踪 `data_cpp`；`ops_sync_git` 提交运行数据 | 只覆盖 `daily_init.*`/`position.csv`；DB 变更不在 git；提交者是 root，无签名 | `ops_sync_git.sh:25-35` |
| 风控规则变更 | `risk_edit_log` 可选写入 | 规则表更新与日志写入不是一个事务；可只改不记 | `tbproduct_risk.py:45-108`；`risk_edit_log.py:46-71` |
| 审计保留 | `logrotate` 只保留 3 份 `tbadmin/log/admin.log`；ORS 日志本地 `log.bak` 无清理/无异地 | 无保留策略、无 WORM、无异地；root 可删 | `ops/logrotate/quantlink-tbadmin:3-12`；`ops_rotate_logs.sh:35-70` |

### 4.2 审计结论

- **订单有“结果”，没有“责任人”**：`tbhft_man_order` 能查到单，但查不到谁下的；`strategy_id=-1` 只表示“Web 手动单”。
- **配置变更可“不记”**：`risk_edit_log` 是前端主动调用，不是数据库触发器；任何直接 SQL/API 修改都不会自动留痕。
- **管理命令只有 debug 日志**：`LOG_DEBUG("cmd: ...")` 进入 `tbadmin_admin.log`，而 logrotate 只轮转 `admin.log`（stdout），`tbadmin_admin.log` 的保留策略未定义；即使有，也可被 root 删除。
- **登录审计不存在**：没有 `login_history`/`last_login_ip`；前端口令还在 cookie 里。
- **审计不可证明**：没有签名链、没有哈希链、没有远端只写存储；无法证明日志未被修改。

### 4.3 最小审计模型（建议）

一张 `audit_event` 表即可，不要先上大型平台：

```text
id, ts, actor, source_ip, action, object_type, object_id,
before_json, after_json, request_id, result, error
```

写入点放在服务端（Flask `before_request`/统一 service、tbadmin 消息处理入口），不要信任前端传来的 `username`。订单表增加 `operator`、`source`、`request_id`；`daily_init`/`position.csv` 增加 `generated_at`、`source`、`checksum`。

---

## 5. 网络暴露

### 5.1 端口/绑定

| 端口 | 服务 | 绑定 | 认证/TLS | 仓库证据 | 状态 |
|---:|---|---|---|---|---|
| 9980 | tbadmin admin SUB（接收 `toadmin`） | `tcp://*` | 无/无 | `admin.cfg:1-2`；`admin.cpp:509` | **V（代码绑定所有网卡）** |
| 9981 | tbadmin admin PUB（`tofront`/`toagent`） | `tcp://*` | 无/无 | `admin.cpp:781` | **V** |
| 5004 | Flask `runserver.py` | `0.0.0.0`（直接运行） | 无/HTTP | `runserver.py:117` | **V（直接运行路径）** |
| 5004 | uWSGI | `127.0.0.1` | 无/HTTP | `uwsgi_conf.ini:3` | **V（另一条部署路径）** |
| 8882 | message_forwarding/Socket.IO | `127.0.0.1`（代码） | 无/HTTP+WS | `message_forwarding.py:899-902` | **V（代码）；外部可达性未验证** |
| 8882 | 防火墙/安全组 | — | — | 启动脚本主动开放 | `start_all_with_frontend.sh:44-48,69` | **V（脚本意图）** |
| 50003 | nginx 静态前端 | 所有网卡（`listen 50003`） | 无/HTTP | `ops/nginx/quantlink-admin.conf:2` | **V** |
| 8080 | memlog-reader Dashboard | `:8080`（所有网卡） | 未核查（范围外） | `web-go/cmd/memlog-reader/main.go:334` | **V（绑定）；认证未验证** |
| 8081 | memlog-reader Monitor | `:8081`（所有网卡） | 未核查 | `main.go:316` | **V（绑定）** |
| 28080/28081 | 备用 Dashboard | 配置端口 | 未核查 | `memlog-reader.alt.yaml:13-15` | **I** |
| 5432 | PostgreSQL | 文档称 127.0.0.1 | 口令/无 TLS | `tools/strategy_sync/README.md:7`；`docs/RISK...:109-112` | **P/I（无仓库配置）** |
| 22 | SSH | 所有网卡 | key + 备用密码 | `.env:4-5` | **I（sshd 配置不在仓库）** |
| 6379/9379 | Redis（Vue/消息转发） | `127.0.0.1`/`172.31.152.132` | 无/未知 | `config.py:46-48`；`message_forwarding/config.py:4` | **I** |
| CTP 前置 | 出站 TCP | 券商地址 | CTP 自身握手/认证 | `ORSServer.cpp:403-415` | **P/I（地址在 ors_server.cfg）** |
| RDS 5432 | 出站到阿里云 | 公网域名 | `psycopg2` 默认 `sslmode=prefer`，未校验证书 | `strategy_sync.env.template:3-7`；`sync_tbhft_strategy.py:176-183` | **V（无 verify-full）** |
| GitHub 22/443 | 出站 | `git@github.com:...` | SSH key | `git remote -v`；`ops_sync_git.sh:35` | **V** |

### 5.2 已确认的暴露意图

- `scripts/start_all_with_frontend.sh:44-48` 主动执行 `firewall-cmd --add-port=8080/8081/8882/tcp --permanent`；`:67` 打印 `tbadmin admin ZMQ :9980/9981`；`:69` 明确写“腾讯云安全组需开放端口: 8882 / 8080 / 8081”。**这不是“忘了关”，是部署脚本要求开放。**
- `ops/nginx/quantlink-admin.conf:2` 的 `listen 50003` 没有 `127.0.0.1` 限制；`:14-17` 只有静态文件，没有 `auth_basic`、没有 TLS。
- `vue3-admin/back_end/server/config.py:41` 仍指向旧内网 `10.192.113.140:9186`；`message_forwarding/config.py:17-18` 指向 `172.31.124.6:10982/10983`。这些旧地址在 190 上不可达（`docs/RISK...:33`），说明 **配置是迁移残留**，不要照抄。

### 5.3 未验证但必须现场确认

- 190 的实际 `ss -ltnp`、`firewall-cmd --list-ports`、腾讯云安全组入站规则。
- 5004 是 uWSGI（127.0.0.1）还是 `python runserver.py`（0.0.0.0）；前端 `.env.development:10` 指向公网 5004，说明至少某条路径不是 uWSGI。
- 8882 代码绑定 127.0.0.1，但启动脚本要求开放 8882；是否有 nginx 反代/端口转发未知。
- 8080/8081 是否有认证；本次范围排除 web-go 内部，不能下结论。
- PostgreSQL 的 `listen_addresses`、`pg_hba.conf`、角色 GRANT、是否有 TLS。

---

## 6. 可用性与完整性风险

### 6.1 单机、无 HA、无自恢复

- 190 是单盘单机：`/dev/vda1` 178G，无网络挂载、无第二台机器可达（`docs/RISK...:15,30-33`）。DB、日志、凭据、代码全在同一块盘。
- 仓库没有 systemd unit、没有 `@reboot` cron、没有容器编排；重启后要等 08:50/20:13 的 cron 才启动（`ops/crontab.txt:43,99`）。**盘中重启/宕机不会自动恢复。**
- 没有 ORS 看门狗；`ops_ensure_tbadmin.sh` 只管 tbadmin（`:13-21`）；`ops_watchdog_memlog.sh` 只管 memlog（`:19`）；`ops_check_status.sh` 只在 00:00 跑一次，且进程检查是 `pgrep -x TradeBot`（任意一个，不区分策略，`:159-167`）。
- 没有策略级 liveness：某个 `TradeBot --strategyID 92204` 死了，另一个还活着，`pgrep -x TradeBot` 仍然通过；Dashboard 的 `m_running` 会停在最后一次 `true`（`ops/crontab.txt:723-725` 已记录该残余缺口）。

### 6.2 进程死亡与“假运行”

| 故障 | 行为 | 后果 | 证据 |
|---|---|---|---|
| ORS 死 | 无自动重启；`start_ors` 只在会话启动时跑 | 无行情/无回报；策略可能继续用旧盘口 | `build_deploy_cpp.sh:345-369`；cron 无 ORS watchdog |
| TradeBot 死 | 无策略级 watchdog；`pgrep -x TradeBot` 任意一个即可 | 单策略静默停止；敞口无人管 | `ops_check_status.sh:159-167` |
| tbadmin admin 死 | `ops_ensure_tbadmin` 每 5 分钟拉起 | 监控恢复，但历史空洞；重启后状态可能旧 | `ops_ensure_tbadmin.sh:13-21`；`ops/crontab.txt:945` |
| memlog-reader 死 | 看门狗 09:35/13:35/21:35 拉起 | Dashboard 冻结/重启；盘中最多 4 小时空窗 | `ops_watchdog_memlog.sh:19-44`；`ops/crontab.txt:115` |
| 策略进程“显示运行中” | MemLog 最后一条 `m_running=true` 无失效检测 | 运维误判，继续等 | `ops/crontab.txt:723-725` |

### 6.3 陈旧数据

- `start_strategy.sh` 生成命令固定 `--updateInterval 7200`（2 小时），`CommonClient::CheckLastUpdate` 只有在 `m_lastUpdate - lastLocalTime > 7200s` 时才触发（`build_deploy_cpp.sh:505`；`CommonClient.cpp:385`）。**5 秒断流不会让策略退出**；它靠 `ops_check_md` 外部告警（`check-md.yaml:15`）。
- 触发后只 `system(mailx)` + 设 `m_onExit/m_onCancel/m_onFlat`，`// exit(1)` 被注释（`CommonClient.cpp:388-396`）；策略是否真的停，取决于后续循环。
- Dashboard 的 PnL 存储是内存快照（`web-go/pkg/pnlstore/store.go:16`，范围外，仅作事实引用）；进程重启即丢，未落盘时只能靠人工截图。

### 6.4 SHM 覆盖/清理

- ORS 和 hftbase 的 SHM 创建/附加大量使用 `0666`（`ORSServer.cpp:281`；`Ipc/include/shmqueue.h:50`；`shmmanager.h:287-605`）。
- `start_ors.sh` 启动前执行 `ipcs -m | grep "$(whoami)" | ... ipcrm -m`（`build_deploy_cpp.sh:363`），会删除 **当前用户所有** SysV SHM，不只是本项目的 key；`stop_all.sh` 同样（`:739`）。如果同机还有别的交易/行情程序，启动 ORS 会把它们的内存段一起清掉。
- 没有 SHM key 冲突检测；配置里多个策略共用 4097/8193/12289/16385（`config_CHINA.92201.cfg:17-20` 等），靠约定不靠隔离。

### 6.5 DB 故障

- `tbadmin::InitDb` 捕获异常后只打印并返回（`admin.cpp:583-592`）；随后 `initialize()` 直接 `m_db_trade->exec_sql`（`:821`）。DB 不可用 ⇒ **空指针崩溃**，不是降级。
- TradeBot 的 `PqHelper::Exec` 捕获异常、打印 SQL、返回 `nullptr`（`tbsrc/common/Pqhelper.cpp:28-60`）；`SaveMatrix2` 在 DB 不可用时只打日志（`PairwiseArbStrategy.cpp:1114-1120`）。**订单照发，持仓快照不落库。**
- Web API 在 DB 故障时返回 500；手动下单可能已发到 ORS，但 `tbhft_man_order` 写失败（`admin.cpp:2662-2670`），形成“有单无记录”。

### 6.6 磁盘满 / core

- `start_admin.sh:4-5`、`start_agent.sh:4-5` 设置 `ulimit -c unlimited` 和全局 `kernel.core_pattern=core-%e-%p-%t`；tbadmin 崩溃会在 cwd 生成 core。`build_deploy_cpp.sh:344` 注释记录 ORS 每次崩溃约 180MB、单日 2.4GB。
- `ops_check_status.sh:174-178` 只在 00:00 检查根分区 >90%；没有自动清理、没有日志配额。
- `ops_rotate_logs.sh:35-70` 只是同盘 `mv` 到 `log.bak/`，不删除；`logrotate` 只轮转 `tbadmin/log/admin.log`（`ops/logrotate/quantlink-tbadmin:3-12`），ORS/TradeBot 的 `log.bak` 无保留上限。
- 磁盘满时：日志写失败、`daily_init`/`position.csv` 可能写一半、DB WAL 可能满；没有熔断。

### 6.7 `kill -9` 与 squareoff 缺口

这是本系统最危险的完整性缺口之一：

1. `stop_all.sh` 对每个 `trader.*.pid` 发 `SIGTERM`，等 10 秒，然后 `pkill -9 -f "TradeBot"`（`build_deploy_cpp.sh:682-694`）。
2. `main.cpp` 的 `SIGTERM` 处理只在 `./config/signal.txt` 存在且当前合约在列表里时才调用 `HandleSquareoff()`（`main.cpp:110-118,142-149`）。**仓库里没有 `signal.txt`**（V：`find` 无结果）。
3. 因此 `SIGTERM` 很可能直接 return，10 秒后 `SIGKILL`；`HandleSquareoffNow()` 不会跑，`SaveMatrix2()` 不会写 `daily_init`（`PairwiseArbStrategy.cpp:1039-1055`），ORS 的 `writePositionToFile()` 也可能来不及跑（`ORSServer.cpp:264`）。
4. 结果：**未平仓 + 昨仓/均价状态停留在旧值**；下一会话按旧 `daily_init` 计算 netpos，可能重复开仓或平错方向。
5. `ops_tb_signal.sh deactivate` 用 `SIGTSTP` 才会平仓，但脚本自己警告：如果处理器尚未就绪，`SIGTSTP` 可能把进程挂起（`ops_tb_signal.sh:24-27`）。

文档已明确记录该行为：`docs/2026-09-23_策略库分析.md:205`、`docs/test/2026-09-23_CTP模拟盘全链路测试报告.html:406`。

### 6.8 重复策略

- `start_strategy.sh` 有两道检查：pid 文件 + `pgrep -f "strategyID <id>"`（`build_deploy_cpp.sh:461-474`）。这是有效的常规防线，但 `pgrep -f` 是子串匹配，存在误判/竞态；两个启动请求同时到达时都可能通过。
- `admin.cpp:2076` 的“已存在”检查用的是 `cmd.find("/bin/start.")`，而新命令是 `/bin/bash .../scripts/start_strategy.sh`（`:3675`），**该检查永远不会命中**，只剩 `start_strategy.sh` 自身兜底。
- 没有 DB 唯一约束保证“一个 sid 只有一个活动进程”；`tbhft_strategy` 可被 RDS 同步改 `active`/`path`。
- 重复进程会各自分配 clientId（`getInitOrdID`，`admin.cpp:4749-4755`），订单 ID 不一定冲突，但**同一策略逻辑会下双份单**，账户净额被放大。

### 6.9 账户净额与对冲

- 所有策略默认 `ACCOUNT=OWN`（`data_cpp/bin/config/StrategyConfig.cfg:1`；`admin.cpp:1824`）。
- ORS 的持仓是账户级净额；`SetCombOffsetFlag` 按 `mapContractPos` 决定开/平（`ORSServer.cpp:513-560`）。
- 没有账户级对冲器/风险聚合器；两个策略对同一合约反向持仓时，柜台看到的是净额，单个策略的“平仓”可能变成对另一策略的开仓。RMS 只做 per-ticker net quantity/频率/单笔价值（`prod.china.rms.xml:2-9,23-27`），不理解策略意图。
- `MAX_POS_SIZE` 在 TradeBot 里是累计成交量上限，不是持仓上限（`02-runtime-strategy.md` 已记录）；不要把它当账户风险上限。

### 6.10 `position.csv` / `daily_init`

- `position.csv` 是时点文件：ORS 在启动读（`ORSServer.cpp:164`）、收到 `SIGUSR2` 再读（`:3402`）、关机写（`:264`）、CTP 持仓查询后写（`:1558`）；无持仓分支也会写（`:1444`）。它不是实时流；盘中孤儿敞口看不到。
- 写入用 `std::ofstream` 直接截断（`:212`），无临时文件+rename、无校验和；如果 `mapContractPos` 为空（CTP 查询失败降级，`:2040`），会把文件写成空。
- 读取用 `strtok` + `atoi(strtok(NULL,...))`（`:190-194`），缺列/空行会传 `NULL` 给 `atoi`，启动即崩；`strtok((char*)line.c_str(), ...)` 还修改了 `const std::string` 的内部缓冲，属未定义行为。
- `writePositionToFile()` 遍历 `mapContractPos` 时没有拿 `contractPosLock`（`:207-225`），而 CTP 回调在锁内改表（`:1470-1547`）；关机与回调并发时可能读到半更新状态或崩溃。
- `daily_init.<sid>` 只在 `HandleSquareoffNow()` 写（`PairwiseArbStrategy.cpp:1054`），格式固定 `2day=0`（`:1095`），`ytd1/ytd2` 直接写当前 `m_netpos`；盘中重启会把“今日/昨日”混在一起，`avgPx` 也可能不是最新。
- `ops_sync_git.sh:25` 每天把 `daily_init.*` 和 `position.csv` push 到 GitHub；如果文件被写坏，会把坏状态提交并成为下一轮构建的输入。

### 6.11 手动操作

- 手动下单没有服务端二次确认、没有双人复核、没有金额/名义价值上限（只有 RMS 单笔 `OpenValue=500000`、`OpenQuantity=1000`，`prod.china.rms.xml:25-26`）。
- 没有 pre-trade 资金/可用保证金检查：ORS 只把 CTP 的 `Available` 打到日志（`ORSServer.cpp:1623`），下单路径不比较。
- 没有“全撤/平仓”二次确认的服务端强制；前端确认框可绕过（直接 POST）。
- 手动单的 `strategy_id=-1`、无 operator 字段（`admin.h:26`；`models.py:490-513`），事后无法区分是谁点的。

### 6.12 CTP 会话/双登录

- `start_ors.sh` 启动前检查已有 `ors_server` 并硬拒绝（`build_deploy_cpp.sh:349-360`），防止双登录互踢；但 `stop_all` 要等 ORS 真正退出（默认 90 秒，`:708-734`），如果等待超时后 SIGKILL，CTP 侧可能仍保留会话。
- 登录失败只重试 5 次（3/6/12/24/30 秒），之后 `exit(1)`（`ORSServer.cpp:2077-2105`）；没有无限重连/会话恢复。
- `OnFrontDisconnected` 只把 `m_connected=false`（`:1888-1900`），没有应用层重连/重新查询持仓逻辑；依赖 CTP API 自身重连。
- 没有“同一账户被别的程序登录”的检测/告警；`.env` 的备用 SSH 密码和旧内网地址说明历史上存在多人/多机操作。

### 6.13 费率/换月/时间

- `fee.csv` 每天 15:40 从 CTP 刷新（`ops/crontab.txt:88`；`ops_refresh_fee.sh`）；盘中交易所改费率不会即时生效。
- `_F_<MM>_` 合约解析是“下一个 MM 月”，不是“N 个月后”；控制文件需要人工滚动，`ops_f_contract_check.py` 只能事前检查覆盖率/倒挂（`ops/crontab.txt:450-568`）。
- `chronyc makestep` 每天 06:00 一次（`ops/crontab.txt:39`）；如果系统时钟漂移/时区错，会话门控、订单时间戳、审计时间都会错。

---

## 7. 代码级风险

> `tbsrc/main`、`tbsrc/Strategies`、`tbsrc/common` 里 `strcpy/strcat/sprintf/memcpy` 类调用约 **436 处**（V：`grep` 计数）。下面只列会影响“资金/凭据/可用性”的代表，不是全量审计。

| # | 位置 | 模式 | 触发 | 影响 | 级别 |
|---|---|---|---|---|---|
| C1 | `ors/China/src/ORSServer.cpp:1964,2047,2552-2557` | `pRspInfo->ErrorID` 在 `pRspInfo` 可能为 NULL 时解引用 | CTP 成功回调/错误回调传 NULL | 登录/报单回调崩溃，ORS 退出 | P0 |
| C2 | `ors/China/src/ORSServer.cpp:190-194` | `strtok` 返回 NULL 直接 `atoi` | `position.csv` 缺列/截断/手工编辑 | 启动崩溃；或读到脏持仓 | P0 |
| C3 | `ors/China/src/ORSServer.cpp:207-225` | 无锁遍历 `mapContractPos` 并截断写文件 | 关机与 CTP 查询回调并发 | 数据竞争/半写文件 | P1 |
| C4 | `ors/China/src/ORSServer.cpp:368-372,1116-1144,1759-1770` | `strcpy` 配置字符串到 CTP 固定字段 | 配置值超长/含特殊字符 | 栈/结构体溢出，崩溃或内存破坏 | P1 |
| C5 | `tbsrc/main/main.cpp:635,641,648,664` | `strcpy` argv 到 `char controlFile[500]` | `--controlFile`/`--controlList` 超长 | 栈溢出 | P1 |
| C6 | `tbsrc/main/main.cpp:652-653` | `sprintf` 拼接后 `system()` | `--controlList` 含 shell 元字符 | 命令注入（本地/启动脚本参数） | P1 |
| C7 | `tbsrc/main/CommonClient.cpp:388-389` | `system(mailx)` 在行情回调路径 | 行情断流触发 `CheckLastUpdate` | 阻塞行情线程；命令注入（model/exchange 字段） | P1 |
| C8 | `tbsrc/main/CommonClient.cpp:972,1039,1103` | `memcpy(AccountID, Account, strlen(Account))` | `ACCOUNT` 配置 >10 字节 | 覆盖相邻字段/栈 | P1 |
| C9 | `tbsrc/Strategies/ExecutionStrategy.cpp:66`；`ExecutionStrategy.h:280` | `strcpy(m_account, config)`，`m_account[11]` | `ACCOUNT` 配置超长 | 溢出 | P1 |
| C10 | `tbsrc/main/include/CommonClient.h:124` | 所有 send 路径复用成员 `m_reqMsg` | 多线程/回调并发 send | 请求字段串单/错单 | P1（I） |
| C11 | `tbadmin/admin.cpp:583-592,821` | DB 连接失败后 `m_db_trade` 为空仍解引用 | DB 宕机/口令错 | tbadmin 崩溃 | P0 |
| C12 | `tbadmin/admin.cpp:861-863` | `ref_file >> ref_j` 不检查文件存在/JSON 合法性 | `order_ref.json` 空/半写 | 启动抛异常/崩溃 | P0 |
| C13 | `tbadmin/admin.cpp:2064-2092` | `popen(cmd)`，`cmd` 来自 admin 转发的 `103` 消息 | 任意能发 `toadmin operation` 的人（admin 生成 `103` 给 agent） | **远程命令执行（root）** | P0 |
| C14 | `tbadmin/admin.cpp:3675-3693` | `sid`/`path` 拼 shell，`path` 来自 DB/RDS | 恶意/错误 `path`、`sid` 含 `;` | **命令注入** | P0 |
| C15 | `tbadmin/admin.cpp:1647` | `system("cp ... " + path)` | `path` 来自 DB/RDS | 命令注入 | P0 |
| C16 | `tbadmin/admin.cpp:47,63,820,3489,3556,3662` | SQL 字符串拼接 | `local_ip`、`sid`、`type`、`modelfile` 等含引号 | SQL 注入/策略表被改 | P0 |
| C17 | `tbadmin/admin.cpp:2662-2670` | `snprintf` 拼 `tbhft_man_order` INSERT，字段来自 CTP 回报 | 回报字符串含 `'` | 插入失败/注入；手动单无审计 | P1 |
| C18 | `vue3-admin/.../tbhft_man_order.py:38-70` | f-string 拼 `exchange/product`，再 `.replace()` 参数 | 前端传 `' OR 1=1--` | SQL 注入；返回 SQL 文本 | P0 |
| C19 | `vue3-admin/.../tbuser.py:282` | f-string 拼 `username` | 登录名注入 | SQL 注入/绕过 | P0 |
| C20 | `message_forwarding.py:544-557` | 无认证 POST 直接 `send_socket.send_string` | 任意 HTTP 客户端 | 管理命令注入 | P0 |
| C21 | `scripts/build_deploy_cpp.sh:509` | `eval $TRADEBOT_CMD` | 控制文件/策略字段含空格/元字符 | 启动参数注入 | P2 |
| C22 | `scripts/build_deploy_cpp.sh:363,739` | `ipcrm` 当前用户所有 SHM | 启动/停止 | 误删其他进程 SHM | P1 |
| C23 | `scripts/build_deploy_cpp.sh:694` | `pkill -9 -f "TradeBot"` | 停止会话 | 误杀任何 cmdline 含 TradeBot 的进程；未平仓 | P0 |
| C24 | `scripts/build_deploy_cpp.sh:600` | MemLog SHM `0666` | 本机任意用户 | 伪造监控/持仓显示 | P1 |
| C25 | `tbadmin/admin.cpp:1524-1525` | `InitDb` 后无条件 `initialize` | DB 不可用 | 空指针崩溃 | P0 |
| C26 | `tbsrc/CMakeLists.txt:7` | `-w -O2`，无 `-fstack-protector/-D_FORTIFY_SOURCE/-pie` | 编译产物 | 漏洞利用门槛低 | P2 |
| C27 | `tbadmin/Makefile:31` | `-g -Wall`，无 hardening | 编译产物 | 同上 | P2 |
| C28 | `ops_install_deps.sh:36` | root 下 `pip3 install` 未固定版本/未校验 hash | 供应链 | 恶意包 = root | P2 |
| C29 | `ops_install_deps.sh:98`；`ops_setup_arbi.sh:30` | `source ops/db.conf` | 文件被改 | root shell 代码执行 | P2 |

### 7.1 说明

- **最危险的不是 C++ 缓冲区，而是 C13/C14/C15/C16/C18/C20 的“外部输入 → shell/SQL”链路。** 缓冲区问题需要本机/配置权限；ZMQ/HTTP 注入只需要网络可达。
- `pRspInfo` 空指针是 CTP 回调的常见形态；即使当前柜台总传非空，也不能把它当契约。
- `position.csv` 的 `strtok/atoi` 是“配置错误 → 启动崩溃”的典型；复刻时先改成有界解析（`std::getline` + `std::from_chars` + 列数校验）。
- `m_reqMsg` 共享成员是否真的并发，取决于 TradeBot 的线程模型；标 **I**。复刻时应改成每次 send 的局部变量，成本极低。

---

## 8. 合规与运维风险

| 风险 | 现状 | 影响 | 证据 |
|---|---|---|---|
| 凭据在 git | DB/YD/ESB/Flask/FTP 默认凭据被跟踪；真实 CTP/DB 文件未跟踪 | 代码泄露即凭据泄露；默认口令可被扫描 | `config.py:2,8,9`；`admin.cpp:583`；`client_yd.cpp:23`；`tbuser.py:201`；`getNSECDSTokens.sh:1` |
| 无异地备份 | 明确接受：190 单盘，无副本 | 磁盘故障丢日志/行情/DB/凭据；无法复盘 | `docs/RISK...:1-17,54-66` |
| 无 PITR 证据 | 无 `pg_dump` 产物、crontab 无 dump；WAL 归档未验证 | DB 误删/损坏只能回到未知状态 | `docs/RISK...:109-120` |
| 无双人复核 | 手动下单/平仓/改风险参数单人或单脚本即可 | 误操作/内部欺诈无阻断 | `admin.cpp:2140-2260`；`ops_tb_signal.sh:1-27` |
| 无 pre-trade 资金检查 | RMS 只做 symbol/qty/frequency/open value；`EnableExposureCheck=FALSE` | 保证金不足时订单被柜台拒；极端行情下无法提前拦截 | `prod.china.rms.xml:2-9,23-27`；`ORSServer.cpp:1623` |
| 无账户级对冲 | 所有策略 `ACCOUNT=OWN`，无聚合器 | 策略间净额抵消，风险敞口不可解释 | `StrategyConfig.cfg:1`；`admin.cpp:1824` |
| 无责任人审计 | 手动单无 operator；`risk_edit_log` 客户端写入 | 事后追责/监管问询无法回答“谁做的” | `models.py:490-513`；`risk_edit_log.py:46-71` |
| 无传输加密 | HTTP 50003/5004/8882/8080/8081；ZMQ 明文；DB 本地无 TLS | 口令/订单/持仓可被嗅探/中间人 | `ops/nginx/...:2`；`runserver.py:117`；`admin.cpp:509` |
| 持仓/PnL 进 GitHub | `ops_sync_git.sh:25` 每天 push `daily_init.*` + `position.csv` | 若仓库可见性过宽，策略/持仓/盈亏泄露 | `ops_sync_git.sh:25-35` |
| 明文口令/个人信息 | `admin_user`/`tbuser` 明文口令，含 phone/email 字段 | 数据泄露；无法满足基本密码保护要求 | `models.py:126-150`；`tbuser.py:258-300` |
| 无保留/WORM | 日志本地、root 可删；tbadmin 只留 3 份 | 无法满足审计留痕/取证 | `ops/logrotate/...:3-12`；`ops_rotate_logs.sh:35-70` |
| 供应链 | 旧 Flask/Werkzeug/psycopg2；root pip 安装；无 SCA | 已知漏洞/恶意包 | `requirements.txt:1-24`；`ops_install_deps.sh:36` |
| 全 root（I） | 部署脚本/cron/路径以 `/root` 为主；未见服务用户降权 | 任一 RCE = 全机 | `start_admin.sh`；`start_agent.sh`；cron `/root/...` |
| 无漏洞管理/IR | 仓库无扫描、无告警分级、webhook 可停用 | 发现慢、响应慢、无证据 | `ops/db.conf.example:11-15`；无 CI 配置 |
| 变更无审批 | RDS 同步 10:30/20:30 覆盖策略表；构建脚本直接覆盖 deploy | 上游/误操作可改变交易行为 | `ops/crontab.txt:67`；`sync_tbhft_strategy.py:206-240` |
| 无 DR 演练 | 备份/恢复未验证；单机 | RTO/RPO 未知 | `docs/RISK...:1-17` |

> 合规结论只到“技术控制缺失”层面；具体是否违反期货交易记录、客户资金、个人信息保护等法规，需要合规/法务按适用辖区确认。这里能确认的是：**没有身份、没有不可篡改审计、没有异地备份、没有传输加密、没有双人复核**。

---

## 9. 优先级改进路线图

> 原则：先“关掉能直接下单/执行命令的入口”，再“让错误可发现/可恢复”，最后“改架构”。每项都给最小改动，不引入大平台。

### P0 — 立即（复刻/上线前必须完成）

| # | 目标 | 最小具体改动 | 验收 |
|---|---|---|---|
| P0-1 | 关闭公网管理面 | 在 190 安全组/`firewall-cmd` 删除 9980/9981/8882/5004/8080/8081/50003 入站；`start_all_with_frontend.sh` 删除 `--add-port`；ZMQ 改绑 `127.0.0.1` | 外部 `nmap`/`nc` 全部不可达；`ss -ltnp` 只看到 127.0.0.1 |
| P0-2 | 停止密码入日志 | 删除 `ORSServer.cpp:420,430,443,460,2146` 的 `m_PASSWORD`/`req.Password` 输出；`ExecutionStrategy.cpp:72` 去掉 `DSN`；清理历史日志/core；**轮换 CTP 密码** | `grep -R "PASSWORD\|DSN" log/` 无命中；旧密码在柜台失效 |
| P0-3 | 清除明文凭据 | 删除 `.env` 密码注释/`SERVER_190_PASS`；`chmod 600`；DB/YD/ESB/webhook/SSH 全部换新；源码 DSN 改环境变量 | `git grep` 无默认口令；`stat` 600；轮换记录 |
| P0-4 | 管理面认证 | nginx `auth_basic` + TLS（或只绑 127.0.0.1 + SSH 隧道）；Flask 加统一 `before_request` token/HMAC；CORS 从 `*` 改为白名单；关闭 `supports_credentials` 或加 CSRF | 未带 token 的 POST 返回 401；跨站表单被拒 |
| P0-5 | 限制 ZMQ 命令 | admin 只 bind 127.0.0.1；消息增加 `source` 白名单/共享密钥；禁止 `103` 消息里直接带 `cmd`；`sid` 必须纯数字，`path` 必须在前缀白名单内 | 伪造 `toadmin` 消息被拒；`sid=1;id` 不执行 |
| P0-6 | 修复崩溃点 | `pRspInfo` 全部判空；`InitDb` 失败时 `initialize` 直接返回；`order_ref.json` 解析 try/catch；`position.csv` 改有界解析 | 注入 NULL/坏文件/停 DB 后进程不崩溃（失败关闭） |
| P0-7 | 修复停止/平仓 | 生成覆盖全部合约的 `signal.txt`，或把 `SIGTERM` 处理改成“无条件 squareoff 全部策略”；停止时等待“已平仓”确认再 SIGKILL；禁止 `pkill -9 -f TradeBot` | 模拟 stop：所有策略平仓、`daily_init` 更新、无残留进程 |
| P0-8 | SHM 最小权限 | 创建 `0600`，属主为专用交易用户；`ipcrm` 只删本项目 key；ORS 校验 `RequestMsg` 来源/clientId 白名单 | 非属主 `ipcs`/`shmat` 失败；启动不再删别人的 SHM |
| P0-9 | 备份底线 | 每晚 `pg_dump` 到独立磁盘/对象存储；`daily_init`/`position.csv`/日志增量到同一目标；**拷贝不是 move**，校验目标设备号不同 | 能在干净主机恢复 DB + 当日状态；恢复演练记录 |

> P0-9 在“只做安全”的排序里可以排 P1，但以交易系统“丢了就无法复盘/对账”的后果看，建议和 P0 同批做。若时间只够一件，先做 P0-1 + P0-2。

### P1 — 两周到一个月

| # | 目标 | 最小具体改动 | 验收 |
|---|---|---|---|
| P1-1 | 服务端 RBAC + 审计 | `audit_event` 表；所有写接口从 session/token 取 actor；订单表加 `operator`/`source`/`request_id`；`risk_edit_log` 改服务端写 | 任意写操作都有 actor；删除日志后 DB 仍有记录 |
| P1-2 | 密码/会话 | bcrypt/argon2 哈希；禁止明文返回；HttpOnly/Secure/SameSite cookie；登录失败锁定；删除前端 password cookie |  DB 中无明文；浏览器 JS 读不到口令 |
| P1-3 | DB 最小权限 | 建 `quantlink_web_ro`、`quantlink_web_rw`、`quantlink_trader`、`quantlink_sync`；撤销 owner/DDL；`pg_hba` 仅 localhost + scram | Web 用户不能 DDL；trader 不能读 admin 库 |
| P1-4 | 传输加密 | nginx TLS；Flask/uWSGI 只绑 127.0.0.1；RDS `sslmode=verify-full`；ZMQ 若跨机必须 CURVE | `ss` 无明文公网端口；RDS 证书校验通过 |
| P1-5 | 策略级看护 | 每策略 systemd unit 或一个 `pgrep -f -- "--strategyID <sid>"` 循环；ORS 单独 watchdog；失败告警 | 杀任一策略 60 秒内告警/重启；不误杀其他策略 |
| P1-6 | 状态原子性 | `daily_init`/`position.csv` 写临时文件 + `fsync` + `rename`；加 `generated_at`/`checksum`；启动时校验，坏文件拒绝启动 | 模拟写一半：旧文件保留；启动报错而非静默用坏值 |
| P1-7 | 独立对账 | 用 `ReqQryInvestorPosition` 每 5–30 秒对账，和策略内部持仓/`daily_init` 比较；差异告警/只读展示 | 人工改仓/漏单能在分钟级发现 |
| P1-8 | 代码注入修复 | 所有 SQL 改参数化；删除 `system/popen` 拼接，改 `execve` 参数数组或内部告警；`sid` 白名单 | SQLMap/手工注入无效；`;id` 不执行 |
| P1-9 | 日志/磁盘 | ORS/TradeBot 日志轮转 + 保留上限；core 默认 0；`/var/log/quantlink` 轮转；磁盘 85% 告警 | 连续跑一周磁盘不增长失控；core 不生成 |
| P1-10 | 依赖/构建 | 固定 pip 版本 + hash；升级 Flask/Werkzeug/psycopg2；加 `-fstack-protector-strong -D_FORTIFY_SOURCE=2 -pie`；CI 跑 `pip-audit`/`gitleaks` | 扫描无高危；构建 flags 可见 |

### P2 — 架构演进

| # | 目标 | 最小具体改动 | 验收 |
|---|---|---|---|
| P2-1 | 主机分离 | ORS/TradeBot 与 Web/DB/监控分机；交易网段只允许 CTP 出站和运维跳板 | 公网无法直达交易主机 |
| P2-2 | 高可用 | ORS 主备/快速重启；DB 流复制/Patroni；会话锁避免双登录 | 杀主 30 秒内切换；不双开 |
| P2-3 | 消息总线安全 | ZMQ CURVE 或换成有 ACL 的 bus；管理面和数据面分网 | 无密钥无法 pub/sub |
| P2-4 | 统一风控网关 | 所有订单（策略+手动）经一个 pre-trade 服务：资金、保证金、账户净额、频率、白名单、kill switch | 超限订单在到达 ORS 前被拒 |
| P2-5 | 账户级对冲/多账户 | 账户/策略两级净额；对冲器；多账户路由 | 任一时刻账户净额可解释、可限额 |
| P2-6 | 不可篡改审计 | 追加写事件存储（本地 WORM/对象存储 Object Lock）；日志签名链 | 删改可检测；监管可导出 |
| P2-7 | 可观测性 | 指标（订单延迟、拒单率、断流、持仓差异）、集中日志、告警分级 | 5 分钟内发现“策略死/断流/持仓不符” |
| P2-8 | 供应链/DR | 依赖锁定、镜像/制品签名、备份恢复演练、RTO/RPO 目标 | 半年一次恢复演练通过 |

---

## 10. 复刻指引

### 10.1 不要复制的东西

- `.env`（SSH 密码/主机信息）
- `ops/db.conf`、`data_cpp/bin/config/ors_server.cfg`、`tools/strategy_sync/strategy_sync.env`、`feishu.secret.yaml`
- `/root/quantlink-backups/`、任何 `*.bak` 凭据
- `deploy_cpp/bin/log*`、`log.bak/`、`core-*`、`nohup.out*`
- `tbadmin/cfg/order_ref.json`（运行时订单映射）
- `data_cpp/bin/live/data/position.csv`、`data_cpp/data/daily_init.*`（运行时状态，不是模板）
- `.claude/`、`.codegraph/`、`.DS_Store`、`__pycache__`

### 10.2 复刻前必须修

1. **网络**：默认只绑 127.0.0.1；管理面走 VPN/堡垒机；不允许 9980/9981/8882/5004/8080/8081 直接入公网。
2. **认证**：所有管理 API/WS 必须有 token/HMAC；前端不得存明文口令；服务端必须做 RBAC。
3. **凭据**：全部重新生成，唯一化；600 权限；secret manager 或至少 `/etc/quantlink/*.env`；禁止默认口令。
4. **日志**：禁止输出密码/DSN/token；日志脱敏；core 默认关闭。
5. **停止/平仓**：先修 `signal.txt`/SIGTERM 语义，再谈自动停止；停止必须验证平仓。
6. **SHM**：0600 + 专用用户 + 请求白名单；不要 `ipcrm` 全部。
7. **DB**：最小权限、备份/PITR、`pg_dump` 验证；RDS 用 `verify-full`。
8. **审计**：订单/配置/管理命令/登录四类事件必须有 actor、时间、前后值、request_id；服务端写。
9. **风控**：pre-trade 资金/保证金检查、账户级净额、kill switch；RMS 不能只做数量/频率。
10. **测试**：先过 10.4 的验收/安全测试，再灌真实资金。

### 10.3 目标拓扑（最小安全版）

```text
运维笔记本/堡垒机
   │ SSH（key + MFA） / HTTPS（TLS + SSO）
   ▼
[跳板/nginx] ── 只暴露 443，反代到 127.0.0.1:5004/8882
   │
   ▼
[交易主机] 专用用户 quantlink，非 root
   ors_server ──SHM 0600── TradeBot（每策略一个进程）
   tbadmin（可选，只读监控）── ZMQ 127.0.0.1
   │
   ├── CTP 出站（白名单 IP/端口）
   └── 本地 PostgreSQL（127.0.0.1，scram，最小权限）
          │
          └── 备份 → 对象存储（WORM/版本化，异地）
```

### 10.4 验收/安全测试

| # | 测试 | 命令/方法 | 通过标准 |
|---|---|---|---|
| T1 | 端口暴露 | 从公网 `nmap -Pn -p 22,5004,50003,8080,8081,8882,9980,9981 <host>` | 除 22/443 外全部 closed/filtered |
| T2 | 未认证 API | `curl -X POST http://host:5004/admin_backend/...`（不带 token） | 401/403，不返回数据 |
| T3 | 未认证 ZMQ | 用 `pyzmq` PUB 连 9980 发 `toadmin` 测试消息 | 连接被拒或消息被丢弃/告警 |
| T4 | 命令注入 | `sid=1;id`、`path=/tmp;id`、`exchange=' OR 1=1--` | 不执行命令；SQL 报参数错误；审计记录拒绝 |
| T5 | 密码泄露 | `grep -R -i "password\|DSN\|secret" log/ core*` | 无命中；历史已清理 |
| T6 | git 秘密 | `gitleaks detect --no-git` / `git log -S` | 无真实凭据；默认口令已移除 |
| T7 | DB 权限 | 以 Web 用户执行 `CREATE TABLE`/`DROP`；以 trader 读 `admin` | 全部 permission denied |
| T8 | SHM 权限 | 以非属主用户 `ipcs -m`/`shmat` | 不可读/不可写 |
| T9 | 停止/平仓 | 盘中模拟 `stop_all`；查 CTP 持仓、`daily_init`、进程 | 全部平仓；`daily_init` 更新；无 SIGKILL 残留 |
| T10 | 崩溃恢复 | 停 DB、坏 `order_ref.json`、截断 `position.csv`、NULL `pRspInfo` | 进程失败关闭/告警，不崩溃、不带病下单 |
| T11 | 重复策略 | 同时两次启动同一 sid | 只允许一个进程；第二个拒绝并告警 |
| T12 | 断流 | 停行情 10 秒/2 小时 | 10 秒内外部告警；2 小时内策略进入退出/平仓，不静默 |
| T13 | 备份恢复 | 从备份在干净主机恢复 DB + `daily_init`/`position.csv`/日志 | 交易可启动；持仓/均价与备份时点一致 |
| T14 | 审计 | 手动下单/改风险/启停策略/登录 | 四类事件均有 actor、时间、前后值；应用用户不能删 |
| T15 | 双登录 | 启两个 ORS / 会话锁 | 第二个拒绝；CTP 不被互踢 |

### 10.5 复刻顺序（建议）

1. 先搭“只读沙箱”：ORS + TradeBot + 模拟柜台 + 本地 DB，不接真实资金。
2. 修 P0-1/2/3/4/5/6/8，再过 T1–T8。
3. 修停止/平仓 + 状态原子性 + 独立对账，过 T9–T12。
4. 加审计/RBAC/备份，过 T13–T14。
5. 最后接真实 CTP，先小资金/单策略，观察一周再扩。

---

## 11. 证据表

> 行号以 commit `5cee3dd` 为准。`V` 直接读文件；`I` 推断；`P` 文档/未复核。

| ID | 证据 | 结论 | 类型 |
|---|---|---|---|
| E1 | `.env:1-8`；`stat` 644 | 仓库根目录有未跟踪的 SSH host/user/password；第 5 行注释含备用密码 | V |
| E2 | `.gitignore:42,89,95,101` | `ors_server.cfg`、`strategy_sync.env`、`.env`、`ops/db.conf` 被忽略 | V |
| E3 | `git ls-files` + `git check-ignore` | 上述文件均未跟踪；`.env`/`ops/db.conf` 存在于工作区 | V |
| E4 | `git log --all -- .env ops/db.conf ...` | 无历史提交记录（未发现曾入库） | V |
| E5 | `ops/db.conf.example:5-15` | DB/webhook 模板；webhook 默认空；注释称 2026-11-09 停用 | V |
| E6 | `ops/db.conf` 本地 `stat`/内容 | 644；仍是 `<DB_USER>` 等占位，不是实值 | V |
| E7 | `docs/RISK_NO_OFFSITE_BACKUP.md:63` | 190 上 `ops/db.conf` 846B，含 PG 凭据 + 企微 webhook | P/I |
| E8 | `docs/RISK...:54-66,109-120` | 单盘、无异地、无 pg_dump/PITR；凭据与 DB 同盘 | V（文档） |
| E9 | `vue3-admin/back_end/server/config.py:2,8,9` | `admin`/`risker` DB 连接串明文、默认弱口令 | V |
| E10 | `tbadmin/admin.cpp:583,1816,1825` | `trader` DSN 明文；生成配置也含 DSN | V |
| E11 | `tbadmin/py/hft_control.py:51`；`hft_manager.py:94`；`tbadmin-py/hft_control/hft_control.py:53` | 遗留 Python 工具硬编码 DB 凭据 | V |
| E12 | `message_forwarding/futils.py:85` | 消息转发硬编码 DB 凭据 | V |
| E13 | `tbadmin/client_yd.cpp:23` | YD appID/authCode 硬编码（值不复述） | V |
| E14 | `vue3-admin/.../tbuser.py:199-201` | ESB app_key 硬编码（值不复述） | V |
| E15 | `message_forwarding.py:31-33` | Flask `SECRET_KEY` 默认值 + CORS `*` | V |
| E16 | `tbsrc/hftbase/DataService/config/passwordfile.xml:1-4` | 示例用户名/口令相同，git 跟踪 | V |
| E17 | `tbsrc/scripts/getNSECDSTokens.sh:1` | FTP 游客账号/口令硬编码，git 跟踪 | V |
| E18 | `tbadmin/start_admin.sh:4-5`；`start_agent.sh:4-5` | core unlimited + 全局 core_pattern；core 可能含内存秘密 | V |
| E19 | `ORSServer.cpp:420,430,443,460,2146` | CTP 密码明文进日志/stdout | V |
| E20 | `ExecutionStrategy.cpp:72` | 策略日志输出完整 DSN（含 DB 口令） | V |
| E21 | `tbadmin/admin.cpp:1820` | 生成的 `config_CHINA.*.cfg` 被 `chmod 0755`（含 DSN 的配置同目录） | V |
| E22 | `models.py:126-150` | `admin_user` 口令明文列；`__repr__` 返回口令 | V |
| E23 | `userstore.js:31-39,47` | 前端把明文口令写进非 HttpOnly cookie | V |
| E24 | `router/index.js:18-23` | 路由守卫跳过登录，所有路由放行 | V |
| E25 | `runserver.py:32,117` | CORS `supports_credentials=True`；直接运行绑 `0.0.0.0:5004` | V |
| E26 | `user.py:20-38,49,92-105` | 旧登录注释；新用户硬编码默认弱口令（值不复述）；改密不验旧口令 | V |
| E27 | `tbuser.py:258-300` | 登录返回 `user.password`；`:282` f-string SQL | V |
| E28 | `admin.cfg:1-2`；`admin.cpp:509,781` | ZMQ 9980/9981，admin bind `tcp://*` | V |
| E29 | `admin.cpp:2064-2092` | `103` 消息里的 `cmd` 直接 `popen()` | V |
| E30 | `admin.cpp:3675-3693` | `path`/`sid` 拼 shell；action 2/3/4/5/6 | V |
| E31 | `admin.cpp:1647` | `system("cp ... " + path)`；path 来自 DB | V |
| E32 | `admin.cpp:47,63,820,3489,3556,3662` | SQL 字符串拼接（local_ip/sid/type/modelfile） | V |
| E33 | `admin.cpp:2662-2670` | 手动单 INSERT 用 `snprintf` 拼字段；无 operator | V |
| E34 | `tbhft_man_order.py:38-70` | f-string SQL + `.replace()` 参数，返回 SQL 文本 | V |
| E35 | `message_forwarding.py:544-557` | `/tbadmin/transmit` 无认证转发 `toadmin` | V |
| E36 | `start_all_with_frontend.sh:44-48,67,69` | 主动开放 8080/8081/8882；打印 9980/9981；安全组提示 | V |
| E37 | `ops/nginx/quantlink-admin.conf:2-17` | 50003 所有网卡、静态、无 auth/TLS | V |
| E38 | `web-go/cmd/memlog-reader/main.go:316,334` | Dashboard/Monitor 绑 `:port`（所有网卡） | V |
| E39 | `uwsgi_conf.ini:3` vs `runserver.py:117` | 两条部署路径：127.0.0.1 vs 0.0.0.0；实际未验证 | V/I |
| E40 | `tbadmin-front/my-admin/.env.development:10-15` | 前端指向公网 `http://...:5004/8882` | V |
| E41 | `strategy_sync.env.template:1-13`；`README.md:26-29` | RDS/本地 PG 凭据，要求 600 | V |
| E42 | `sync_tbhft_strategy.py:37-41,176-183` | 同步 `path` 等列；`psycopg2` 未设 `sslmode=verify-full` | V |
| E43 | `sync_tbhft_strategy.py:206-240` | 同库建备份表、写策略表；无人工审批 | V |
| E44 | `ORSServer.cpp:281`；`shmqueue.h:50`；`shmmanager.h:287-605` | SHM 创建/附加 `0666` | V |
| E45 | `build_deploy_cpp.sh:600` | MemLog SHM 以 `0o666` 创建 | V |
| E46 | `ORSServer.cpp:491-506` | 任何 RequestMsg 直接分派 NEW/MODIFY/CANCEL | V |
| E47 | `ORSServer.cpp:190-194` | `strtok`/`atoi` 无空值/列数检查 | V |
| E48 | `ORSServer.cpp:1964,2047,2552-2557` | `pRspInfo` 可能为 NULL 仍解引用 | V |
| E49 | `ORSServer.cpp:207-225` | `writePositionToFile` 无锁、截断写 | V |
| E50 | `ORSServer.cpp:164,3402,264,1558,1444,2040` | 读/写 position.csv 的时点；查询失败降级 | V |
| E51 | `main.cpp:110-118,142-149` | SIGTERM 依赖 `./config/signal.txt`；缺失则 return | V |
| E52 | `build_deploy_cpp.sh:682-694` | 10 秒后 `pkill -9 -f "TradeBot"` | V |
| E53 | `docs/2026-09-23_策略库分析.md:205`；`docs/test/...html:406` | 文档确认 SIGTERM 只对 signal.txt 合约生效，缺失则进程不退出 | V（文档） |
| E54 | `ops_tb_signal.sh:24-27` | `deactivate` 真平仓；SIGTSTP 可能挂起 | V |
| E55 | `build_deploy_cpp.sh:461-474`；`admin.cpp:2076` | 启动脚本有重复检查；admin 的 `/bin/start.` 检查已失效 | V |
| E56 | `CommonClient.cpp:388-389` | `system(mailx)` 在行情回调路径 | V |
| E57 | `CommonClient.cpp:972,1039,1103`；`ExecutionStrategy.h:280` | `memcpy/strcpy` 无长度限制；`m_account[11]` | V |
| E58 | `main.cpp:635,641,652-653` | `controlFile[500]` strcpy；squareoff `system()` | V |
| E59 | `CommonClient.h:124` | 共享 `m_reqMsg` 成员 | V/I |
| E60 | `PairwiseArbStrategy.cpp:24-43,1054,1085-1105` | `daily_init` 解析/保存；`2day=0`；直接截断写 | V |
| E61 | `ExecutionStrategy.cpp:44-47` | `endTime-180s` 自动 squareoff | V |
| E62 | `StrategyConfig.cfg:1`；`admin.cpp:1824` | 所有策略 `ACCOUNT=OWN` | V |
| E63 | `prod.china.rms.xml:2-9,23-27` | RMS 只启用 ticker/quantity/cancel/frequency；`EnableExposureCheck=FALSE` | V |
| E64 | `ORSServer.cpp:1623` | `Available` 只打日志；下单路径无资金比较 | V |
| E65 | `ops_check_status.sh:159-167,174-178` | 进程检查任意 TradeBot；磁盘 >90% 告警 | V |
| E66 | `ops_ensure_tbadmin.sh:13-21`；`ops_watchdog_memlog.sh:19-44` | 只守护 tbadmin / memlog | V |
| E67 | `ops/crontab.txt:43,99,115,945` | 启动 08:50、状态 00:00、memlog 3 次、tbadmin 每 5 分钟；无 @reboot | V |
| E68 | `ops_rotate_logs.sh:35-70` | 同盘 mv 到 `log.bak`，无异地/无删除上限 | V |
| E69 | `ops_sync_git.sh:25-35` | 每天 push `daily_init.*` + `position.csv` 到 GitHub | V |
| E70 | `admin.cpp:861-863` | `order_ref.json` 解析无异常保护 | V |
| E71 | `admin.cpp:1524-1525,821` | DB 初始化失败后仍解引用 | V |
| E72 | `build_deploy_cpp.sh:505,509` | `--updateInterval 7200`；`eval $TRADEBOT_CMD` | V |
| E73 | `build_deploy_cpp.sh:363,739` | `ipcrm` 当前用户所有 SHM | V |
| E74 | `tbsrc/CMakeLists.txt:7` | `-w -O2`，无 hardening | V |
| E75 | `ops_install_deps.sh:36,98`；`ops_setup_arbi.sh:30` | root pip 未固定；source db.conf | V |
| E76 | `ops/db.conf.example:11-15`；各脚本空值守卫 | webhook 可停用；告警可能静默降级为只写日志 | V |
| E77 | `web-go/config.yaml:18-22` | 手动下单默认 `enabled=false`；`account_id=OWN` | V |
| E78 | `docs/RISK...:33` | 190 到旧内网 `10.192.113.140` 等不可达 | V（文档） |
| E79 | `vue3-admin/back_end/server/config.py:41`；`message_forwarding/config.py:17-18` | 旧 ZMQ 地址残留（10.192/172.31） | V |
| E80 | `tbadmin/admin.cpp:2159-2175` | agent 对 `server` 的订阅校验只认空/0.0/本机 | V |

### 11.1 复现命令（只读）

```bash
cd /Users/wangjun/PG/RD/quantlink-trading
git rev-parse HEAD
git ls-files | grep -Ei '(\.env|secret|db\.conf|strategy_sync\.env|ors_server\.cfg)'
git check-ignore -v .env ops/db.conf data_cpp/bin/config/ors_server.cfg tools/strategy_sync/strategy_sync.env
stat -f '%Sp %N' .env ops/db.conf
grep -n -E 'zmq_bind|user=trader|popen\(|system\(' tbadmin/admin.cpp | head
grep -n -E 'pRspInfo->|strtok|writePositionToFile|Logging in' ors/China/src/ORSServer.cpp | head -40
grep -n -E 'signal.txt|pkill -9|ipcrm|0o666' tbsrc/main/main.cpp scripts/build_deploy_cpp.sh
grep -rn -E 'password=<redacted>":|PASSWORD=' --include='*.py' --include='*.cpp' . | head
```

### 11.2 未验证/待确认（按重要性）

1. **GitHub 仓库可见性**：`ops_sync_git.sh` 每天 push 持仓/PnL；若仓库 public 或协作者过多，这是数据泄露。未从仓库判断。
2. **190 实际入站规则**：脚本要求开放 9980/9981/8882/8080/8081；实际安全组/防火墙是否照做未验证。
3. **`.env` 密码是否复用/已外泄**：与 root SSH、其他系统是否同口令未知；是否曾复制到聊天/文档未知。
4. **CTP 密码轮换状态**：日志已含明文；柜台侧是否已改密、是否有其他系统共用该账户未知。
5. **`signal.txt` 是否存在于 190**：仓库没有；若生产也没有，`stop_all` 的 SIGTERM 不会平仓。
6. **5004/8882 的真实部署**：uWSGI 127.0.0.1 还是 `runserver.py` 0.0.0.0；是否有 nginx 反代/认证。
7. **Dashboard 8080/8081 是否有认证**：本次范围排除 web-go 内部，无法确认。
8. **PostgreSQL 角色/GRANT/pg_hba/TLS**：仓库只有连接串，没有角色定义；生产是否最小权限未知。
9. **RDS 同步的写入权限**：谁能改 `tbhft_strategy.path`，是否有审批/审计；RDS 账号是否只读源、是否 TLS 校验。
10. **备份/PITR**：文档说没有 `pg_dump`/PITR；是否在云侧有快照/WAL 归档未验证。
11. **CTP 前置是否限制源 IP/是否支持多会话**：旧账户是否与别的程序共用未知。
12. **`order_ref.json` 是否会在生产被写坏**：只在崩溃/并发时；未做故障注入。

---

## 12. 一句话给复刻者

**先把管理面关进回环/堡垒机，把命令通道加上认证和白名单，把密码从日志/源码/默认值里拿掉，把停止流程改成“确认平仓再杀”，再谈复刻策略逻辑。** 这四件事不做，复刻出来的不是交易系统，是一台连着期货账户的公网 root shell。

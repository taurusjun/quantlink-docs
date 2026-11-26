# 06 — 安全、可审计性、可用性与版本谱系（2015 原始 TradeBot）

> 调查对象：`/Volumes/DevDisk/146`（下文 `$R`），只读。
> 关联文档：`00-inventory.md`（盘/版本）、`02-tradebot-core.md`（C++ 核心）、`03-qt-gui.md`（Qt 前端）、`04-config-data.md`（配置/数据）、`05-build-deploy-ops.md`（构建/部署/运维）。
> 证据标记：**V** = 直接读源码/配置/脚本/日志/元数据确认，附 `file:line`；**I** = 由结构、时间戳、日志、二进制字符串推断；**P** = 假设、计划或本次无法验证。
> 脱敏：本文**不复制任何口令、密钥、Token、webhook、账户号或内网地址原文**。凭据只记位置、类型、权限/暴露面与处置建议；凡可能被误读为实值的字段一律写 `<redacted>`。未运行任何二进制，未修改 `$R` 中任何文件。

---

## 0. 一页结论

| # | 结论 | 级别 | 关键证据 |
|---|---|---|---|
| 1 | 这套系统的真实信任模型是“**能登录这台机器的人 = 全权交易员 + root**”；但机器有公网地址、VNC 以 root 运行且没有 `-localhost`、ZMQ 绑定 `tcp://*`，模型与部署不一致。 | **P0** | `2/etc/sysconfig/vncservers:20-21`；`3/dalong/FromDaya/SkylineFL_GUI/GuiMsgHub.cpp:8`；`3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/StrategyMsgHub.cpp:12` |
| 2 | GUI↔策略的 ZMQ 控制面**没有认证、没有加密、没有请求 ID、没有 ACK**；消息里的 `port` 就是唯一身份。任何能连上 15213/15300–15333 的进程都能发 `startOrStop`、改 FV/参数、发 `GuiClose`，或冒充某个策略行。 | **P0** | `GuiMsgHub.cpp:8,37-38,77-87`；`StrategyMsgHub.cpp:12,92-111`；`sclock.cpp:251-291` |
| 3 | 策略侧 `connectRequest`/`GuiClose` 只是普通字符串，没有身份校验；`startOrStop` 也没有序号/幂等键。控制命令还可能因为 `ZMQ_DONTWAIT` 被静默丢弃。 | **P0** | `sclock.cpp:254-270`；`GuiMsgHub.cpp:45-50`；`Container.cpp:287-291` |
| 4 | SysV SHM 以 **0666** 创建/附加；本机任意用户可读行情、订单、持仓，甚至向请求队列写入伪造报单。ORS 不验证请求来源。 | **P0** | `3/dalong/infrastructure/Ipc/include/shmmanager.h:245,260,300,308,456`；`runORS_extreme_new.sh:4-7` |
| 5 | 多处明文凭据：ORS 配置、网关 ini、策略配置、DataService 口令文件、GUI 源码默认值。**Broker/CTP 级口令与交易数据同盘、明文、无加密**。 | **P0** | `3/infra/prod/config/prod.china.ors_new.cfg:23-24`；`3/jfs/linux-64bin/tradegate/conf/tradegate.ini:34,57`；`3/leon/CL/config/.leonConfig.cfg:7`；`ConnectionDetails.h:17-18` |
| 6 | **最危险的动作审计最弱**：自动单在 TradeBot 日志里有完整 `NewOrder/Trade/PnL`；手工单只记一句 `Sent new order`，没有单号/价格/数量/操作者；Lock/Unlock 完全不打日志；配置/模型改动没有审计。 | **P0** | `ContractWidget.cpp:139`；`Strategy.cpp:258-272`；`Main.cpp:63`；`04 §5.5` |
| 7 | **两本账 + `kill -9` + 无启动对账**：TradeBot 的 `m_netpos` 在内存，重启归零；交易所/ORS 仓位仍在；`position.csv` 只有 30 字节、每日覆盖两次，且 TradeBot 从不读它。 | **P0** | `3/TradeBot/TradeBot_China/main/main.cpp:683-690`；`2/var/spool/cron/root:8-10,17-20`；`04 §7.3` |
| 8 | 生产停机和切换基本是 `pkill -9`；唯一“先平后杀”的证据只在 `/home/TradeBot/.bash_history` 里，不在任何 cron/脚本里。 | **P0** | `2/var/spool/cron/root:8-10,17-20`；`05 §5.2` |
| 9 | 代码里有多条**会直接造成错误下单或持仓裸奔**的路径：`m_simConfigList[100]` 用 `symbolID` 无界索引、风险限额触发 `exit(1)` 不平仓、超成交 `assert(0)`、蝶式 `HandleSquareoff` 因基类非虚而完全失效、手工单 `OrdType` 未初始化。 | **P0** | `main.cpp:1041-1055`；`CommonClient.cpp:424,443`；`ExecutionStrategy.cpp:308,945,1981-1984`；`ExecutionStrategy.h:43`；`ButterflyStrategy.h:36`；`PlaceOrderWidget.cpp:177-207` |
| 10 | 源码/二进制/配置三者都不同步：线上 TradeBot 二进制（6/17）**晚于**最高 SVN rev r2375（6/10），含未提交改动；线上 GUI 是 2014-12-21，源码树 2015-03-19 的构建从未部署；ORS 二进制 4/26、配置 7/13。 | **P0（保存）/P1（运行）** | `05 §7.1`；`00 §3.2,§5.6`；`03 §6.1-6.2` |
| 11 | **SkylineFL_GUI 没有任何 git/svn**，只有目录 + 两个 tarball + 一个部署二进制；共享控件层在 git 里，但新壳（Container/Strategy/Position）不在。 | **P0（保存）** | `03 §1.4`；`00 §6.1` |
| 12 | 现代 `quantlink-trading` 是这套代码的直接后代：保留了一策略一进程、SysV SHM、静态 RMS、两本账和 `pkill -9`；新增了 PostgreSQL 与 `tbadmin` 管理面，但也把管理面变成了新的未认证攻击面。 | **P1（架构）** | `quantlink-trading-architecture/01-system-architecture.md`、`08-security-gaps.md` |

**一句话**：这不是“有几个 C++ bug”的问题，而是**边界画错了**——把交易控制面、订单队列、broker 凭据都放在“本机/内网可信”的假设里，却把这台机器暴露在公网/VNC/明文 ZMQ 之下；同时最需要审计的人工操作几乎没有留痕。

---

## 1. 部署事实与口述启动序列核对

### 1.1 单机拓扑（先定位，避免把“备份”当“运行态”）

| 层 | 内容 | 说明 |
|---|---|---|
| 主机 | 一台 CentOS 6.6 / kernel 2.6.32 / 48 vCPU / ~32 GB 的物理机，hostname `685` | 【V】`05 §1.1`；`2/var/log/dmesg:272,307,401` |
| `/` | `$R/2`，约 17 GB，含 `/bld`、`/include`、`/usr/local`、`/usr/share/API`、`/opt/Qt5.3.2` | 【V】`2/etc/fstab:9-12` |
| `/home` | `$R/3`，约 58 GB，全部源码/运行数据/日志/备份 | 【V】`3/lost+found`；`3/` 无 `etc/bin` |
| 交易链路 | `jfs` 网关（7776/7777）→ ORS（`china_ors_extreme_new`）→ SHM 872/10201（行情）、3872/4872（请求/回报）、727272（client store）→ TradeBot/leon 策略 | 【V】`05 §3.7,§4.2` |
| 前端 | Qt5 `SkylineFL_GUI`（`/home/GUI/SH`）+ DataService（stream 1732/1733、service 20000） | 【V】`05 §3.5-3.6` |
| 旧前端 | Qt4 `TradingSystemsGUI`（`/home/infra/TradingSystemsGUI`），2014-09-26，146/148 日志为空 | 【V】`03 §6.3`；`05 §3.6` |
| 调度 | root + jfs crontab：07:15 网关（jfs）、08:10 拉持仓、08:11 ORS、08:55 行情、08:56 leon 策略；15:05/02:35 `kill -9` | 【V】`2/var/spool/cron/root:1-32`；`2/var/spool/cron/jfs:1-4` |

> **关键纠偏**：`$R/2` 不是“可运行的 `/home`”。`2/home/` 是空目录；`2/TradeBot`、`2/GUI`、`2/TradeBot.bak` 是 7/25–7/26 用 `cp -a` 拷到根盘的**副本**（与 `3/` 逐字节相同），不是原始运行路径。真正的运行态是 `3/` 挂成 `/home` + `2/` 提供 `/bld`、`/include`、`/usr/share/API`。混用会把路径和权限全部搞错。【V/I】

### 1.2 口述启动序列逐条核对

| # | 口述 | 核对结果 | 证据 |
|---|---|---|---|
| 1 | 把 `$R/3/*` 拷到 `/home`；`/usr/share/API` 也相关 | **基本正确，但不完整**：还要从 `2/` 取 `/bld`、`/include`、`/usr/local/lib/libsnappy.a`、`/usr/share/API`；要排除 `lost+found`、`.Trash-0`、39 GB 的 `leon/log`；要按 `2/etc/passwd` 恢复 `jfs:500`、`TradeBot:501`、`leon:503` 的 uid/gid。 | 【V】`05 §3.1,§8.3`；`00 §2.1` |
| 2 | `/home/infra/prod/scripts/runORS_extreme_new.sh`，源码在 `2/bld/build_dev_multi.20150330_1447/China` | **正确**：脚本存在；`china_ors_extreme_new` 是活动产物；`build.py:56-66` 的 `china_ors_extreme` 走 SGIT，`39-51` 的 `china_ors_ctp` 整段被注释。但脚本**先 `ipcrm` 再启动，不先杀旧 ORS**；且 `LD_LIBRARY_PATH` 指向 `/home/piyush/ORS_CHINA_extreme/`，缺这个跨用户目录可能加载失败（取决于二进制是否依赖其中的 SGIT 库）。 | 【V】`runORS_extreme_new.sh:1-10`；`2/bld/build_dev_multi.20150330_1447/China/build.py:39-66` |
| 3 | `/home/re/receive.sh`（`receive.shBak`；源码 MDReceiverX）；`receive_new.sh` 失败 | **现象正确，解释要修正**：快照里**没有 `receive.sh`**，只有 `receive_new.sh`（一行，`taskset -c -p 8 nohup ./mdreceiverX …`）和 `receive.shBak`（一行，`taskset -c -p 5,6 nohup ./mdreceiverX_bothfeeds …`）。`taskset -c -p N cmd` 不是标准 util-linux 语法（`-p` 是“对已有 PID 操作”），按原文执行不会启动后面的命令。`receive.shBak` 是**回滚到 2 月双 feed 版**，不是“修复新版”。 | 【V】`3/re/receive_new.sh:1`；`3/re/receive.shBak:1`；`05 §3.3` |
| 4 | `/home/TradeBot/livescripts/RunStrategies.sh`（TradeBot_China） | **正确，但属于 6 月，不是 7 月生产**：脚本只启用 `GOLD_F_0_SFE.eve.ltp`（其余 8 条注释），必须 `cd .../main`，`--adjustLTP 1` 是中国链路必需。7 月 cron 实际启动的是 leon 的 `startAll_new2.sh`，TradeBot 日志只到 6/30。 | 【V】`RunStrategies.sh:1-13`；`2/var/spool/cron/root:6,16`；`05 §4.1` |
| 5 | `runDataService.sh` **或** `runDataStream_CTP.sh` | **不是二选一**：`runDataStream_CTP.sh` 是 stream（1732），`runDataService.sh` 是 service（20000）；CME 还有 `configStream_CME.xml`（1733）。正确顺序是 **stream → service → GUI**；只起一个，GUI 要么没行情，要么连不上。 | 【V】`runDataService.sh:1`；`runDataStream_CTP.sh:1`；`05 §3.5` |
| 6 | `/home/infra/TradingSystemsGUI/TradingSystemsGUI` | **存在，但不是主 GUI**：这是 Qt4 旧前端（2014-09-26，BuildID `76f8f101…`），148 个日志中 146 个 0 字节，且缺 `libQt*.so.4` 符号链接，按原样不能独立启动。线上主 GUI 是 `/home/GUI/SH/SkylineFL_GUI`（Qt5，2014-12-21，BuildID `a2e432bd…`）。 | 【V】`03 §6.3`；`05 §3.6` |

### 1.3 三个时代混在一起

口述序列把三套东西拼成了一条：

1. **6 月 TradeBot 时代**：`RunStrategies.sh` → `TradeBot_China/main/TradeBot`，日志到 2015-06-30。
2. **7 月 leon 时代**：cron `startAll_new2.sh` → `/home/leon/CL` 的 `SHStrategy_new`，日志到 2015-07-24；TradeBot 不在 cron 里。
3. **两代 GUI**：Qt4 `TradingSystemsGUI`（旧，基本空跑）与 Qt5 `SkylineFL_GUI`（线上）。

> 因此，**这份口述不能当作“任意一天的开机脚本”**。它更像“TradeBot 时代的策略启动 + 7 月的 ORS/行情/GUI 运维 + 旧 Qt4 GUI 的路径”三者的混合。复刻时必须先选一个时代，再把该时代的进程、配置、日志对齐。【V/I】

### 1.4 最小正确启动顺序（按历史证据）

```
1) jfs 网关 startfs（quotgate 7777 / tradegate 7776）
2) reqPositionFile.sh → ORS position.csv
3) pkill -9 ors（如有）→ runORS_extreme_new.sh
4) cd /home/re && taskset -c 5,6 ./mdreceiverX_bothfeeds cme.recv.quincy.data.cfg
5) cd /home/TradeBot/TradeBot_China/main && sh /home/TradeBot/livescripts/RunStrategies.sh
6) stream(s): dataservice configStream_CTP.xml / configStream_CME.xml
7) service: dataservice configService.xml
8) cd /home/GUI/SH && LD_LIBRARY_PATH=. taskset -c 7 ./SkylineFL_GUI
```

【V/I】`05 §4.3`。注意第 6/7 步在历史 7 月实际发生在 08:12（ORS 之后、行情之前），顺序略早；这不影响交易，因为策略不依赖 DataService，但 GUI 会等 collector。

---

## 2. 信任边界

### 2.1 边界总表

| 边界 | 跨越的内容 | 现有控制 | 结论 | 证据 |
|---|---|---|---|---|
| 主机/root | 所有进程、所有文件、所有 cron | 无服务用户、无 namespace/cgroup、无 SELinux（disabled） | **没有进程级隔离**；任一应用 RCE = root | 【V】`2/etc/selinux/config:7`；`2/var/spool/cron/root`；`05 §1.1` |
| X/VNC | 远程桌面、键盘/鼠标、交易 GUI | VNC 密码；`-nolisten tcp`；**没有 `-localhost`** | 远程可连；VNC 内是 root 桌面 | 【V】`2/etc/sysconfig/vncservers:20-21` |
| ZMQ | 策略启停、参数、FV、遥测、心跳 | 无 | **无认证/无加密/绑定所有网卡** | 【V】`GuiMsgHub.cpp:8`；`StrategyMsgHub.cpp:12` |
| DataService TCP | 登录、行情、持仓、挂单、手工单 | 用户名/口令 + 只读/查看 ACL | 有登录，但**明文 TCP、共享账户、无交易级授权** | 【V】`DataCollector.cpp:88-102`；`accesscontrol.xml:1-37` |
| SHM | 行情、请求、回报、client store | 文件权限 0666 | **本机任意进程可读可写** | 【V】`shmmanager.h:245,260,300,308,456` |
| ORS/网关 | 报单、撤单、成交、行情、broker 登录 | broker 自身认证；ORS 静态 RMS | 应用层无二次授权；本机 7776/7777 无认证 | 【V】`prod.china.ors_new.cfg:1,5,23-24,42-44`；`05 §3.2` |
| 配置/数据文件 | control/model/contract/rollover/signal | 文件系统权限 | 无签名/无校验；**可触发 `system()`** | 【V】`CommonClient.cpp:393-394`；`main.cpp:623-624` |
| 远程复制 | 二进制、配置、tar、scp | 无 | 无校验和/无签名；以 root 运行 | 【V】`2/root/.bash_history:302,592,733`；`05 §1.3` |

### 2.2 本机/root

- **ORS** 由 root cron 拉起；**TradeBot** 由人工在 root shell 里跑 `RunStrategies.sh`（不在 cron）；**GUI** 由人工在 root VNC 桌面拉起；**网关** 由 `jfs` 用户 cron 拉起（`2/var/spool/cron/jfs:1-4`）。除网关外，没有 systemd unit/服务用户/降权。【V/I】`2/var/spool/cron/root:1-32`；`05 §1.2,§6.3`
- SELinux `disabled`；没有 AppArmor/cgroup/namespace 的证据。【V】`2/etc/selinux/config:7`
- `/home/TradeBot`、`/home/leon`、`/home/jfs` 是普通用户目录，但脚本由 root 执行，且多处硬编码 `/home/...`；权限边界实际是“文件系统 DAC”，不是“进程身份”。【V/I】`04 §9.2`
- **后果**：GUI 的一个 `strcpy` 溢出、DataService 客户端的一个栈溢出、或任何本地用户写 `control/model`，都可以直接变成 root 代码执行或 broker 级下单。这不是“纵向提权”，而是“从一开始就没有降权”。

### 2.3 X/VNC

`2/etc/sysconfig/vncservers:20-21`：

```
VNCSERVERS="1:root"
VNCSERVERARGS[1]="-geometry 800x600 -nolisten tcp"
```

- **`-nolisten tcp` 只关 X 的 TCP 监听，不关 VNC 自身的 TCP 监听**；要限制远程 VNC 客户端必须用 `-localhost`。该文件第 14 行的注释自己就写了这一点，但实际配置没加。【V】
- VNC 以 **root** 运行，桌面里可以直接开终端、改配置、杀进程、下单；没有单独的 `vncuser`。【V】
- `2/root/.vnc/passwd` 存在（VNC 口令文件，传统 DES 混淆，不是强哈希）；本次未读取内容。【V】`2/root/.vnc/`
- `2/etc/sysconfig/iptables:10` 名义上只放行 22/tcp，但 `05 §1.3` 根据 `boot.log` 没有 “Starting iptables” 且 VNC 日志有外部客户端，推断 **iptables 实际未启用**。【I】
- **结论**：如果这台机器像 2015 年那样带公网地址，VNC 就是“公网 root 桌面”。这是整套系统最高的单点风险，优先级高于任何交易 bug。P0。

### 2.4 ZMQ 控制面

拓扑（`03 §3.1`）：

```
GUI  PULL bind tcp://*:15213      ← 策略 PUSH 心跳/遥测
GUI  PUSH connect localhost:15300..15333 → 策略 PULL bind tcp://*:<port>
```

- GUI 的 bind 地址是 `tcp://*:`，不是 `127.0.0.1`；策略的 PULL 也是 `tcp://*:`。【V】`GuiMsgHub.cpp:8`；`StrategyMsgHub.cpp:12`
- 消息格式是纯文本 `port|key#args`，多条用 `;` 连接；没有 schema/version/签名/序号。【V】`Container.cpp:222-260`
- `port` 同时是 GUI 的行索引（`portToRowIdx`）和策略身份；没有独立的 `strategyID`/token。【V】`Container.cpp:186-202,222-260`
- 任何能连上 15213 的进程都可以向 GUI 推 `heartBeat`、`status`、`bidPrice`、`console`，让某一行显示成“在线/已启动/某个价格”。任何能连上 153xx 的进程都可以向策略推 `startOrStop#true`、`bidFairValue#...`、`GuiClose`。【V】`sclock.cpp:251-291`；`03 §3.3-3.4`
- **示例（伪造，不含任何秘密）**：`15313|startOrStop#true`、`15313|bidFairValue#9999`、`15313|GuiClose`。GUI 会把它当成来自 15313 号策略的正常消息。【V/I】
- 控制命令使用 `ZMQ_DONTWAIT`；HWM 满时 `zmq_send` 返回 -1，`GuiMsgHub::send` 只打 WARN，`Container::sendToStrategy` **忽略返回值并永远返回 0**。也就是说，**“停止”命令可能被静默丢弃，操作员看不到失败**。【V】`GuiMsgHub.cpp:45-50`；`Container.cpp:287-291`

> 这是本系统最反讽的一点：交易数据面（SHM）很快，控制面（ZMQ）很轻，但**控制面的身份和可靠性都靠“端口没被别人占用”**。P0。

### 2.5 DataService TCP

- GUI 的 `DataCollector`/`ManualOrderSender` 通过 `QTcpSocket` 连 `127.0.0.1:20000`；协议是**定长二进制结构体**（`CommandExchangeInitMessage`、`LoginCommand`、`LoginReplyStructure`、`ManualOrderCommand`），没有 TLS、没有消息认证码、没有版本协商。【V】`DataCollector.cpp:35-102`；`logincommand.h:27-84`
- 登录是 `用户名/口令` 的定长 `char[20]`；`setUserName/setPassword` 用 `strcpy`，**不检查长度**。UI 的 `ConnectDialog` 也没有 `setMaxLength`。【V】`logincommand.h:51-58`；`ConnectDialog.cpp:80-83`
- `LogIn()` 写入后 `waitForReadyRead()`，然后 `read((char*)&loginreply, sizeof(LoginReplyStructure))`，**不检查 read 返回值**；`LoginReplyStructure::m_loginAuthenticated` 没有默认初始化。读失败/短读时，返回值是栈上未初始化 bool → 可能被当作“已认证”。【V】`DataCollector.cpp:96-101`；`loginreplymessage.h:23-46`
- 服务端有 `passwordfile.xml` 和 `accesscontrol.xml`；ACL 只有 `MDAccess/OrderViewAccess/PnlViewAccess` 三个查看位，**没有“能否下单/能否撤单/能否改单”的权限位**。两个用户都属同一个 `Tradebot` 组，对 `OWN` 账户的所有交易所全开。【V】`accesscontrol.xml:1-37`
- 手工单路径：GUI 组装 `PlaceOrderInfo` → `ManualOrderSender::DoWork()` → 同步 TCP 连接/登录/发命令；**没有等待订单确认**，`DoWork()` 返回 true 只代表字节写给了 DataService。【V】`ManualOrderSender.cpp:24-80`；`03 §3.8`

### 2.6 SHM

- 交易链路的所有跨进程数据都在 SysV SHM：行情 `872`（SHFE，100000）、`10201`（CME，1000）、请求 `3872`、回报 `4872`、client store `727272`。【V】`05 §3.7`；`config_CHINA_CME.cfg:16-23`；`prod.china.ors_new.cfg:31-35`
- `ShmManager` 创建/附加的权限是 **0666**：`initClientStore(..., IPC_CREAT|0666)`、`clientStore.init(..., 0666)`、`new MdShmQ(..., 0666)`、`getResponseClient(..., 0666)`、`getRequestClient(..., 0666)`。【V】`shmmanager.h:245,260,300,308,456`
- 没有 magic/version/length 校验；布局由 `2/include/illuminati/dev_multi` 的头文件决定，跨语言/跨版本必须人工保持一致。【V】`05 §8.4`
- `mdreceiverX` 启动时默认 **attach 已存在的 10201**，日志出现 `Header already existing`，不重建队列；跨重启可能读到旧消息。【V】`05 §3.3`；`3/re/nohup.out`
- ORS 启动脚本先 `ipcrm -M 3872/727272/4872/872`，但**不先杀旧 ORS**；旧进程可能继续使用已删除段，新进程建新段，策略可能连到旧段/双实例。【V】`runORS_extreme_new.sh:4-10`；`05 §4.4`
- **攻击面**：本机任意用户（或任何被攻陷的进程）可以 `shmat` 这些 key，读行情/持仓，或向 3872 写 `RequestMsg`；ORS 不验证请求来源。写请求需要知道结构体布局，但布局就在归档头文件里。【V/I】

### 2.7 ORS/网关

- ORS 二进制 `china_ors_extreme_new` 连本机 `tcp://127.0.0.1:7776`（tradegate）/`7777`（quotgate）；网关再连券商 FENS/交易/行情前置。【V】`prod.china.ors_new.cfg:1,5`；`05 §3.2`
- 2015 生产 ORS 是 **SGIT/extreme**，不是 CTP：`build.py:39-51` 的 `china_ors_ctp` 整段注释，`56-66` 的 `china_ors_extreme` 链接 `libsgitquotapi.so.64/libsgittradeapi.so.64`。`china_ors_ctp` 是 2014-12-04 的遗留二进制。【V】`2/bld/build_dev_multi.20150330_1447/China/build.py:39-66`；`05 §2.5`
- ORS 配置文件有 `PASSWORD`/`NEWPASSWORD` 字段（值脱敏）；网关 `tradegate.ini`/`quotgate.ini` 也有明文 `Password` 字段（值脱敏）。【V】`prod.china.ors_new.cfg:23-24`；`tradegate.ini:34,57`
- ORS 的 RMS 是**静态额度检查**：`TICKER_LIMIT_CHECK`、`QUANTITY_FIRMLEVEL_CHECK`、`CANCEL_CONFIRMS_COUNT_CHECK`；`STOP_LOSS_CHECK` 被注释掉；账户级/品种级亏损限额写在配置里但没有对应检查，实际不生效。【V】`prod.china.rms.xml:2-9,43-46`；`04 §3.5`
- **结论**：ORS 是“有 broker 登录、有静态限额”的网关，但**没有应用层身份、没有请求来源验证、没有可用资金/保证金/涨跌停/时段检查**。它信任本机 7776/7777 和 3872 的一切写入者。

### 2.8 配置/数据文件

配置不是“数据”，而是**代码路径的一部分**：

- `control` 文件一行 7 个字段，决定 `baseName`、`modelFile`（绝对路径）、交易所、策略 ID、策略类、起止时间；`model` 文件决定指标表达式和 155 个阈值字段。解析器有 151 个 `strcmp` 指标分支、31 个策略工厂分支。【V】`04 §2.3,§3.2`；`02 §4.3`
- 这些文件没有签名/校验和；运行目录 `3/TradeBot/{controls,models}` 不在 SVN 里（SVN 里只有 5 个 NIFTY 样例）。任何能写 `/home/TradeBot` 的人都能改策略行为。【V】`00 §3.2`；`04 §2.1`
- **最严重的一条**：`CommonClient::CheckLastUpdate()` 把 `control` 里的 `m_modelFile` 直接 `sprintf` 进 shell 命令，然后 `system(cmd)` 调 `mailx`。如果 `modelFile`/symbol/exchange 含 shell 元字符，就是**以 root 执行任意命令**。【V】`CommonClient.cpp:392-394`
- 同类：`main.cpp:623-624` 把 `--controlList` 参数拼进 `system("../scripts/squareoffcontrols.sh %s")`；该脚本本身在归档里不存在。【V】
- `Config/signal.txt` 只有 NIFTY 期权符号；`SIGTERM` 只对命中列表的 symbol 平仓，对 `GOLD_F_0_SFE` **不生效**。运维若把 `SIGTERM` 当“全平”，会以为平了其实没平。【V】`main.cpp:90-160`；`04 §1.3,§5.2`
- `data/contractfile`、`ChinaInstruments`、`RolloverOverrideFile` 决定“逻辑合约 → 真实合约”的映射；`RolloverOverrideFile` 的 GOLD/SILVER 只到 2015-11-15，之后回退到按月推算，可能选错合约。【V】`04 §4.2,§9.3`

### 2.9 远程复制/scp/tar

- 没有 NFS/CIFS；跨机同步靠 `scp`/tar。`2/root/.bash_history:302,592,733` 三次把 `SHStrategy_new` 二进制 `scp` 到另一台主机；没有校验和/签名/版本号。【V】
- `/home/dalong`、`/home/piyush` 是从别的机器拷来的目录（本机 `/etc/passwd` 没有这两个用户），GUI 的 RPATH 仍指向 `/home/dalong/Qt5.3.1`。【V】`05 §1.2`；`03 §6.4`
- 归档 tarball（`TradeBot20150617.tar.gz`、`ttt.tar.gz`、`SkylineFL_GUI.tar.gz`）是“传输/备份”产物，不是签名发布物；解包后直接以 root 运行。【V】`00 §6.5`
- **供应链含义**：无法证明“运行的二进制 = 归档源码编译出来的二进制”；只能靠 BuildID/日志行号/行为对齐做弱证据。P0（保存）/P1（运行）。

### 2.10 边界图

```
公网/办公网/旧内网（可达性未验证）
        │
        ├── SSH 22（PasswordAuthentication yes；root 登录默认允许）
        ├── VNC 5901（root 桌面；无 -localhost；无 TLS）
        ├── ZMQ 15213 / 15300-15333（明文、无认证、bind *）
        └── DataService 20000/1732/1733（明文二进制协议）
                    │
        ┌───────────▼──────────────────────────────────────┐
        │ 单机 root：ORS / TradeBot / 网关 / GUI / cron     │
        │  SHM 872/10201/3872/4872/727272  (0666)          │
        │  control/model/data 文件（无签名，可触发 system） │
        │  明文 broker 凭据（ORS/网关/策略配置）            │
        └───────────┬──────────────────────────────────────┘
                    │
              CTP/SGIT/FENS 柜台
```

**边界结论**：真正的边界不是“进程”，而是“这台主机 + 这个网络”。一旦网络可达，ZMQ/VNC/DataService 都是入口；一旦本机有任意用户，SHM/配置文件就是入口。代码里的“本地信任”假设与部署现实不一致。

---

## 3. 认证与授权

### 3.1 组件矩阵

| 组件 | 认证 | 授权 | 结论 | 证据 |
|---|---|---|---|---|
| GUI→策略 ZMQ | 无 | 无；按 `port` 直接执行 | **完全信任网络来源** | 【V】`GuiMsgHub.cpp:8`；`StrategyMsgHub.cpp:12,92-111` |
| 策略→GUI ZMQ | 无 | 无；GUI 按 `port` 映射行 | 可伪造心跳/状态/价格 | 【V】`Container.cpp:186-202,222-260` |
| DataService | 用户名/口令（明文 TCP） | 仅 `MDAccess/OrderViewAccess/PnlViewAccess` | 有登录，无交易级授权/无 TLS | 【V】`DataCollector.cpp:88-102`；`accesscontrol.xml` |
| ORS | broker 登录（CTP/SGIT） | 静态 RMS 限额 | 无应用层身份；RMS 非身份 | 【V】`prod.china.ors_new.cfg:23-24,42-44` |
| VNC | 单一 VNC 口令 | root 全权 | 远程 root 桌面 | 【V】`2/etc/sysconfig/vncservers:20-21` |
| SSH | 系统口令/密钥 | root/普通用户 | `PasswordAuthentication yes`；root 默认允许 | 【V】`2/etc/ssh/sshd_config:42,64-66` |
| 文件系统 | Unix DAC | 按 uid/gid | APFS 已压平 uid/gid；恢复前不可信 | 【V】`00 §1` |

### 3.2 ZMQ：没有身份，只有端口

- `connectRequest`、`GuiClose`、`startOrStop` 都是**普通字符串**，没有 token、签名、时间戳、序号。【V】`sclock.cpp:254-270`
- GUI 的 `onMsg` 只检查 `port` 是否在 `portToRowIdx` 里；未知 port 打 `ILOG(FATAL)` 后 `continue`（**FATAL 不会退出**），消息被丢弃。【V】`Container.cpp:222-260`；`log.h`/`log.cpp`（`03 §8.2 R9`）
- 因为 `port` 是唯一身份，**冒充一个策略只需要占住它的端口**；而策略端口又是“第一个空闲端口”，不是固定分配。攻击者可以先 bind 15313，等 GUI 发 `startOrStop`，或者先 bind 一个空闲端口再向 GUI 推假状态。【V/I】`cfgField.cpp:687-735`；`03 §3.7`
- 没有 `ROUTER/DEALER`、没有 `ZMQ_CURVE`、没有 `ZAP`、没有 IP allowlist。`tcp://*` 让同网段任何主机都能连。【V】
- **授权后果**：GUI 的 `Lock` 只是本地断开 Start 按钮的 `pressed()` 信号，策略完全不知道“被锁”；Stop 仍然可用，改单/撤单仍然可用。【V】`Strategy.cpp:258-272`；`ContractWidget.cpp:228-258`

### 3.3 DataService：有登录，但没有“交易授权”

- 登录流程：`CommandExchangeInitMessage` → `LoginCommand(user,password)` → `LoginReplyStructure`；没有 TLS，口令在 TCP 上明文（本机回环，但仍是明文）。【V】`DataCollector.cpp:35-102`
- ACL 只有查看权限：`MDAccess`、`OrderViewAccess`、`PnlViewAccess`；没有 `OrderEntry`、`Cancel`、`Modify`、`SquareOff` 权限位。只要登录成功，就能发 `ManualOrderCommand`（New/Cancel/Modify/CancelAll）。【V】`accesscontrol.xml:1-37`；`ManualOrderSender.cpp:24-80`
- 两个用户同属一个组，对 `OWN` 账户的所有交易所全开；没有只读用户、没有风控用户、没有双人复核角色。【V】`accesscontrol.xml:30-36`
- `passwordfile.xml` 是明文/弱权限（04 §9.5 记为 141 B、`rw-rw-r--`）；本次未读取内容。任何能读该文件的本地用户都能拿到 DataService 口令。【V/I】
- **授权后果**：DataService 的“授权”本质是“登录成功 = 可以交易”，不是“这个用户只能看/只能撤/只能下某个品种”。P1。

### 3.4 ORS/RMS：限额不是身份

- ORS 只做 broker 登录；没有“哪个策略/哪个用户”的应用层身份。所有策略共用 `ACCOUNT=OWN` 的账户语义（配置里是单一账户）。【V】`Config/StrategyConfig.cfg:1`；`04 §1.2`
- RMS 检查的是 `PerTickerNetQuantity=1000`、`OpenValue=500000`、`OpenQuantity=1000`、`OpenOrders=1000`、`InstrumentLevelLossFatalLimit=10000` 等静态额度；**不检查可用资金/保证金/涨跌停/时段**，`STOP_LOSS_CHECK` 被注释。【V】`prod.china.rms.xml:2-9,23-46`；`04 §3.5`
- 因此 ORS 能拦“单笔太大/太频繁”，不能拦“这个请求不是我们发的”或“这个策略已经失控”。【I】

### 3.5 VNC/SSH

- VNC：`VNCSERVERS="1:root"`，`-geometry 800x600 -nolisten tcp`，**没有 `-localhost`**；VNC 口令文件存在；无 TLS；iptables 很可能未启用。【V/I】`2/etc/sysconfig/vncservers:20-21`；`05 §1.3`
- SSH：`PasswordAuthentication yes`；`PermitRootLogin` 被注释（CentOS 6 默认 `yes`）；没有 `AllowUsers`/`Match`/`ForceCommand`/fail2ban 证据。【V】`2/etc/ssh/sshd_config:42,64-66`
- **授权后果**：只要拿到 root 口令/VNC 口令，就是全权；没有堡垒机、没有 MFA、没有会话录制、没有命令审计（只有 shell history）。P0。

### 3.6 缺失项清单

| 缺失 | 影响 |
|---|---|
| ZMQ 认证/加密/来源校验 | 任何人可启停策略、改参数、伪造状态 |
| ZMQ 请求 ID/ACK/重试 | 控制命令可能丢失/重复；操作员不知道是否生效 |
| 每策略独立身份 | `port` 可被抢占/冒用；重启后行号错位 |
| DataService TLS | 口令/订单在回环上明文；本机嗅探/注入 |
| 交易级 RBAC | 登录即可下单/撤单/平仓；无只读/风控/复核角色 |
| ORS 请求来源校验 | 本机任意进程可向 3872 写请求 |
| 双人复核/四眼原则 | `SquareOffAll` 只是同屏随机码，不是授权 |
| 配置/模型签名 | 任意写文件即可改策略行为，甚至 `system()` 执行 |
| 制品签名/校验和 | scp/tar 的二进制无法证明来源 |
| 密钥管理/轮换 | 明文凭据长期驻留；无过期/无轮换 |
| 登录失败锁定/速率限制 | 可暴力尝试 DataService/SSH/VNC |
| 应用级审计 | 手工单、Lock、配置改动几乎无痕 |

### 3.7 一个具体的越权链（示例）

1. 攻击者能连 15313（同网段/本机）→ 发 `15313|startOrStop#true` 启动策略；或发 `15313|bidFairValue#<极端值>` 让策略立刻按异常 FV 报价。【V/I】
2. 或攻击者先 bind 15313，等 GUI 连上来；GUI 以为这是 15313 号策略，把 Start/Stop/参数都发给它，同时接受它推的假 `bidPrice/status`。【I】
3. 若攻击者能写 `/home/TradeBot/models/...`，可在 model 路径/字段里注入 shell 元字符；策略在行情陈旧告警时 `system("... mailx ...")`，以 root 执行。【V】`CommonClient.cpp:392-394`
4. 若攻击者能 `shmat` 3872，可按 `RequestMsg` 布局写一条伪造报单；ORS 不验证来源。【V/I】

> 这条链不需要“攻破交易所”，只需要“能连端口/能写文件”。这就是边界画错的代价。

---

## 4. 凭据与秘密

> 本节只列**位置、类型、暴露面、处置**；不复制任何值。`<redacted>` 表示原文有值但本文不复述。

### 4.1 清单

| 位置 | 类型 | 暴露面/权限 | 风险 | 轮换 | 证据 |
|---|---|---|---|---|---|
| `3/infra/prod/config/prod.china.ors_new.cfg:23-24` | ORS/broker `PASSWORD`、`NEWPASSWORD` | 与 ORS 同目录；默认文件权限；明文 | **最高**：可直接登录柜台 | 无 | 【V】 |
| `3/leon/CL/config/.leonConfig.cfg:7` | 券商/CTP `PASSWORD=`；同文件还有 `USERID/BROKERID/INVESTORID` | 策略配置目录；明文 | **最高** | 无 | 【V】 |
| `3/jfs/linux-64bin/tradegate/conf/tradegate.ini:34,57` | 柜台 `Password=`（两处） | 网关目录；明文 | **最高** | 无 | 【V】 |
| `3/jfs/linux-64bin/quotgate/conf/quotgate.ini:38-40` | 行情/柜台口令 | 网关目录；明文 | 高 | 无 | 【V/I】（05 §3.2） |
| `3/infra/dataservice_deploy/passwordfile.xml` | DataService 用户名/口令 | 141 B；`rw-rw-r--` | 高：可登录 20000 发手工单 | 无 | 【V】`04 §9.5` |
| `3/dalong/infrastructure/TradingSystemsGUI/ConnectionDetails.h:17-18` | 硬编码默认用户名/口令 | 源码；所有 SkylineFL collector 默认使用 | 高：源码即凭据 | 无 | 【V】 |
| `3/dalong/infrastructure/TradingSystemsGUI/ConnectDialog.cpp:88-96,176` | 把地址/端口/用户/口令逗号拼接写入 `QSettings` | 用户 `~/.config/...`；明文 | 中高：本机其他用户可读 | 无 | 【V】 |
| `2/root/.vnc/passwd` | VNC 口令（DES 混淆） | root 家目录；VNC 可远程连 | 高 | 无 | 【V】 |
| `/etc/shadow`（`2/etc/shadow`） | 系统用户口令哈希 | root 可读 | 中：取决于口令强度 | 无 | 【V】 |
| `3/TradeBot/.ssh/known_hosts`、`2/root/.ssh/known_hosts` | 仅主机指纹 | 无口令 | 低 | — | 【V】 |
| `3/TradeBot/.subversion/auth/svn.simple/` | SVN 缓存凭据 | **空目录** | 低（好消息） | — | 【V】 |
| `3/TradeBot/TradeBot_China/.svn/entries:5` | `svn+ssh://...` 内网 URL（含用户名） | 源码元数据 | 低-中：暴露内网拓扑/用户名 | — | 【V】 |
| 日志/配置里的内网/公网地址 | 主机、SVN、git、NFS/网关地址 | 文本 | 中：信息泄露/横向移动线索 | — | 【V】 |

### 4.2 日志与历史中的秘密

- **ORS 详细日志**：记录登录/RMS/订单事件；本次未逐行核验是否打印口令。按“可能含密”处理：恢复/分享前先扫描 `PASSWORD`、`InvestorID`、`BrokerID`、`AuthCode` 等关键词。【P】
- **TradeBot 策略日志**：头部打印 `configFile/controlFile/modelFile/strategyID/ACCOUNT`，不含 broker 口令；但 `ACCOUNT=OWN` 与订单细节属于敏感业务信息。【V】`04 §6.2`
- **GUI 日志**：只记录 ZMQ 消息和 UI 事件；本次未发现口令字段。但 `connectRequest`/`init*` 可能带策略名/合约名，属于业务信息。【V】`04 §6.3`
- **`.bash_history`**：`/home/TradeBot/.bash_history` 32 KB，含 `vim models/...`、`kill -SIGUSR2`、`pkill` 等；`2/root/.bash_history` 含 `scp` 到其他主机。若历史里有带口令的命令（如 `mysql -p`、`svn --password`），会成为二次泄露。【V/I】
- **core dump**：`runORS_extreme_new.sh:1` 设 `ulimit -c unlimited`；网关 2015-07-20 有 segfault core（05 §6.6）。core 可能含进程内存中的口令/会话；`abrtd` 可能删除，但归档/备份里若残留就是高价值秘密。【V/I】
- **VNC 日志**：`2/root/.vnc/*.log` 可能记录客户端地址/连接事件，不含口令。【V】

### 4.3 没有发现的东西（同样是结论）

- **没有 webhook/API key**：在 `3/` 的 `*.cfg/*.xml/*.ini/*.sh/*.pl/*.py/*.json/*.yaml/*.txt` 中搜索 `webhook|api_key|access_token|secret_key` 零命中。【V】`grep`（本次）
- **交易链路没有数据库**：`grep -rniE "psql|postgres|mysql|sqlite|libpq|odbc"` 在 TradeBot 源码零命中；链接库没有 DB 客户端；`CommonDbApi/FastDb` 在 infra 里但未被 TradeBot 使用。因此**没有 DB 连接串/DB 口令**这一类秘密（这是原版比现代少的一类风险）。【V】`04 §7.2`
- **没有私钥**：`3/TradeBot/.ssh`、`2/root/.ssh` 只有 `known_hosts`；未发现 `id_rsa`/`id_dsa`/`*.pem`。SVN 的 `svn+ssh` 需要密钥，但密钥不在快照里（可能在原机器/agent 中）。【V】
- **SVN 未缓存口令**：`auth/svn.simple/` 为空。【V】
- **没有发现“数据库口令”**：DataService 的 `passwordfile.xml` 是服务登录，不是 DB；`CommonDbApi` 未被交易链路使用。【V/I】

### 4.4 处置优先级

1. **立即视为已泄露并轮换**：ORS/broker 口令、网关 `Password`、`.leonConfig.cfg`、DataService `passwordfile.xml`、GUI 硬编码默认值、VNC/SSH 口令。2015 年的明文凭据在 2026 年不应再有效。
2. **删除源码/配置中的默认值**：`ConnectionDetails.h:17-18` 的 TODO 默认值、`ConnectDialog` 的明文保存、任何 `password=` 模板。
3. **权限最小化**：凭据文件 `0600`、属主为专用服务用户；不要把 `/home/TradeBot` 做成全组可读。
4. **日志脱敏**：恢复/分享前扫描 ORS/TradeBot/GUI/DataService 日志与 core；删除/脱敏 `PASSWORD`、`InvestorID`、`BrokerID`、`AuthCode`、DSN、webhook。
5. **轮换后验证**：确认旧口令失效、无残留会话、无旧 core/备份可读；更新所有引用点（ORS、网关、DataService、GUI、脚本）。

---

## 5. 可审计性

### 5.1 事件矩阵

| 事件 | 是否有日志 | 字段 | 缺口 | 可重建性 |
|---|---|---|---|---|
| 策略自动下单 | **有**（TradeBot `NewOrder:`） | 时间、symbol、side、px、qty、OrdID、盘口、目标价、NetPos、BPNL/APNL | 只有 3 个日志文件（6.5 MB，到 6/30）；无集中存储 | **高**（对保留的 run） |
| 策略成交 | **有**（`Trade:`） | OrdID、px、qty、side、NetPos、NetPNL/RPNL/UPNL、MaxPNL/DrawDown、改善/穿越比例 | 同上；无 DB；无跨进程 ID | **高**（单进程内） |
| 手工单 | **很弱**（GUI `Sent new order`，无字段） | 仅一句文本 | 无单号/价格/数量/账户/操作者；DataService 日志是调试流水；CSV 手工导出且每文件最多 500 行 | **低** |
| 手工撤单/改单 | 弱 | GUI `Sent ...` / 无 | 同上；撤单无确认对话框 | **低** |
| 策略启停 | **部分**（GUI `zmq_msg_send:...startOrStop#...`；策略 `status#start/stop`） | 端口、命令、状态 | 无操作者、无原因、无 ACK；GUI 日志只留 10 天 | **中** |
| Lock/Unlock | **无** | — | 纯本地 UI 状态；策略不知道 | **无** |
| 配置/模型改动 | **无** | — | 文件原地覆盖；`SIGUSR2` 只打 “Thresholds Reset.”，不记旧值/新值；`.bash_history` 只有部分命令 | **低** |
| 仓位/PnL | **快照**（TradeBot `Trade:` 行；ORS `position.csv`） | NetPos/PNL | 无历史；`position.csv` 30 B、每日覆盖两次 | **低-中** |
| ORS RMS 拒绝 | **有**（ORS 详细日志） | 订单/限额/错误码 | 2.4 GB、无轮转；未逐行核验 | **中** |
| 登录/认证 | **OS 层有**（`secure`、`wtmp`、`btmp`） | SSH/VNC 登录 | ZMQ 无认证事件；DataService 登录只在调试日志里，未结构化/未核验 | **低**（应用层） |
| 停机/杀进程 | **cron 日志**（`var/log/cron`） | 执行了 `pkill -9` | 无“平仓是否完成”的记录 | **低** |
| GUI 关闭 | **无 `GuiClose`** | — | 策略侧 `connectGUIFlag` 仍为 true；GUI 侧只能靠心跳判离线 | **误导** |

### 5.2 日志清单

| 日志 | 路径 | 数量/大小 | 时间基准 | 内容 | 轮转 |
|---|---|---|---|---|---|
| TradeBot 策略 | `3/TradeBot/log/log.live.control.*` | 3 个 / 6.5 MB（目录 8.1 MB） | **GMT** | 启动头、IND、NewOrder、Confirmation、Trade、Limit reached | 按日期新文件；同日 `>>` 追加；`ZipLogs.sh` 未挂 cron |
| GUI（Qt5） | `3/GUI/SH/SkylineGUI-*.log` | 25 个 / **9.0 GB** | 本地 CST | 每条 ZMQ 收/发、TRADE_CONFIRM、心跳 | 每次启动新文件；**无** |
| DataService | `3/infra/dataservice_deploy/DataService-*.log` | 296 个 / 866 MB | 本地 CST | store/订单存储调试流水 | 每次启动新文件；**无** |
| ORS | `3/infra/prod/log/extremeors-log-*`、`cmd.ors_*` | 2.4 GB / 137+64 | 详细日志 **UTC**，文件名 CST | 登录、RMS、订单、错误 | 每次启动新文件；**无** |
| MD 接收 | `3/re/*.log`、`log/*.stats` | 79 个 / 40 MB | 本地 CST | 启动 14 行 + 丢包/跳号 | 每次启动新文件；**无** |
| leon 策略 | `3/leon/log/` | **39 GB** | 本地 CST | 7 月策略日志 | 按日期目录移动；**不删除** |
| 成交 CSV | `3/GUI/SH/*.csv` | 50 个 / 14,918 行 | 本地 CST | `TRADE_CONFIRM` 导出 | 手工导出；每文件 ≤500 行 |
| 系统 | `2/var/log/{cron,messages,secure,wtmp,btmp}` | — | 本地 CST | cron/登录/内核 | 系统 logrotate |

【V】`04 §6.1,§6.6`；`05 §6.2`。

### 5.3 能重建什么

对**保留的 TradeBot run**（6/17、6/18、6/30）：

- 启动参数：`configFile`、`controlFile`、`modelFile`、`startDate/endDate`、`strategyID`、实际生效的 GMT 窗口、`adjustLTP` 等。【V】`04 §6.2`
- 订单生命周期：`NewOrder` → `New Confirmation` → `Trade`，含 OrdID、价格、数量、方向、盘口、目标价、NetPos、PNL、改善/穿越比例、回撤。【V】
- 指标时间序列：`IND:` 行，可用于复算信号。【V】
- 风控触发原因：`Limit reached. ... Reason: END TIME / MAX LOSS / MAX ORDERS / MAX TRADED`。【V】
- GUI 侧：盘口/FV 更新、策略心跳、状态、成交确认、控制台文本；但不含 PnL 数值。【V】`04 §6.3`
- ORS 侧：登录/RMS/订单事件；DataService 侧：进程/客户端/store 活动。【V/I】

### 5.4 不能重建什么

- **运行前初始仓位**：TradeBot 不落盘、不读 `position.csv`；ORS 只覆盖写 30 字节快照。【V】`04 §7.3`
- **运行时的完整 control/model**：归档的是最后一次编辑后的版本；6/18 同一个 control 路径在日志里出现两种窗口（`0100-0215` 与 `1300-1830`），证明盘中改过。【V】`04 §2.8`
- **完整订单簿**：只有成交时刻的 `BB0/BA0/BQty/AQty`，不是逐档历史。【V】
- **手工单的完整内容/操作者**：GUI 只记 “Sent new order”；CSV 是手工导出且截断 500 行。【V】
- **Lock/Unlock**：无日志。【V】
- **配置/模型的 diff**：无版本控制、无变更日志；只有 `.bash_history` 的部分 `vim`/`kill -SIGUSR2`。【V】
- **跨进程全局订单 ID 映射**：TradeBot OrdID、GUI OrderID、ORS OrderID 不在同一命名空间，无法直接 join。【V/I】`04 §8.5`
- **GUI 的 PnL 历史**：只在内存/界面，不落日志。【V】`04 §6.3`

### 5.5 时间与 ID：审计的两个陷阱

1. **时区不一致**：TradeBot 日志是 **GMT**（`Logger::SetGMTimeStamp()`，`main.cpp:430`），GUI/DataService/CME 录制是 **本地 CST**；ORS 详细日志内容是 **UTC**，文件名是 **CST**。同一事件在 TradeBot 与 GUI 日志里相差 8 小时；不做换算会把因果顺序搞反。【V】`04 §2.5`；`05 §3.2`
2. **ID 不一致**：TradeBot 的 `OrdID` 由 Connector 分配（如 `1000000`、`13000000`），GUI 的 `OrderID` 是 DataService/ORS 侧另一段（如 `18000375`），没有共享全局 ID；手工单与策略单无法在同一张表里对齐。【V/I】`04 §8.5`

### 5.6 审计结论

- **自动交易的审计是可用的**：TradeBot 日志足以复盘“某个策略在某天做了什么”，包括 PnL 和风控原因；这是这套系统最好的部分。
- **人工操作的审计是不可用的**：手工单、Lock、配置改动、启停的“谁/为什么/改前改后”几乎都缺失；而这些恰恰是最容易出错/最需要追责的动作。
- **保留期不足**：TradeBot 只剩 3 个日志；GUI 只有 10 天；ORS/DataService 无轮转但可能被清理；`position.csv` 覆盖写。一次事故如果发生在两周前，基本无法复盘。
- **日志本身是风险**：9 GB GUI 日志/天、2.4 GB ORS、39 GB leon；磁盘满会同时影响交易和审计；日志里可能含凭据/账户信息。

---

## 6. 可用性与完整性

### 6.1 单机、无 HA

- 所有进程在 `685` 一台机器：网关、ORS、MD 接收、策略、DataService、GUI、cron。没有 standby、没有复制、没有 VIP、没有 NFS。【V】`05 §1.1-1.3`
- 任何单点故障（电源/内核/磁盘/网卡/ORS/网关）都会停止交易；没有自动切换，只能人工重建。【V/I】
- `/home` 78 GB，已用约 58 GB；`3/leon/log` 39 GB + GUI 9 GB + ORS 2.4 GB ≈ 50 GB 是日志。磁盘满会先杀日志，再杀交易。【V】`05 §1.1,§6.2`

### 6.2 停机：cron `pkill -9`

```
05 15 * * 1-5 pkill -9 rec
05 15 * * 1-5 pkill -9 ors
05 15 * * 1-5 pkill -9 Trade
05 15 * * 1-5 killAllStrategy.sh
...
35 02 * * 1-6 pkill -9 rec / ors / Trade + killAllStrategy.sh
```

【V】`2/var/spool/cron/root:8-10,17-20`

**TradeBot 的真实信号语义**（`main.cpp:90-164`，比 `04 §5.2` 更精确；`02 §2.3` 把 `SIGRTMIN` 写成“平仓”是错的）：

| 信号 | 语义 | 是否读 `signal.txt` |
|---|---|---|
| `SIGTERM`（15） | 非激进平仓；只有 `m_origbaseName` 命中列表的策略才执行 | **是** |
| `SIGTSTP`（20） | 非激进平仓；**全量** | 否 |
| `SIGUSR1`（10） | 恢复（`m_Active=true`，清 exit/cancel/flat）；**全量** | 否 |
| `SIGUSR2`（12） | 重载模型阈值（`LoadThresholds`） | 否 |
| `SIGRTMIN`（34） | **恢复**；只有命中列表的策略才恢复 | **是** |
| `36`（RTMIN+2） | **激进平仓**；只有命中列表的策略才执行 | **是** |
| `37`（RTMIN+3） | **激进平仓**；**全量** | 否 |

> 这解释了为什么“`pkill -SIGTERM TradeBot` 不一定平仓”：它依赖一个过期的 NIFTY 白名单。真正安全的是 `SIGTSTP`（全量非激进）或 `37`（全量激进），但脚本里没有 37。

- `kill -9` 不给进程任何清理机会：不撤单、不平仓、不写 `position.csv`、不发 `GuiClose`、不刷新日志。
- 正常交易日 15:05/02:35 时，策略内部 `endTime` 应该已经平仓；但 `kill -9` 只是“兜底”，无法保证。若当天有未平仓位/挂单，它们留在交易所。
- **唯一“先平后杀”的证据**在 `/home/TradeBot/.bash_history`：`pkill -SIGTSTP TradeBot` → `pkill -9 TradeBot`。这不在任何 cron/脚本里。【V】`05 §5.2`
- 归档脚本里没有发送 `37`（全量强平）的；`stopTradeMulti.pl` 注释说 group，实际发 `36`（单符号、且还要命中 `signal.txt`）。【V】`04 §5.2`
- `signal.txt` 是 NIFTY 符号，`SIGTERM` 对 GOLD 不生效；运维若用 `SIGTERM` 当“全平”，会静默失败。【V】`04 §1.3`

### 6.3 两本账：没有订单/仓位持久化

| 账本 | 位置 | 谁维护 | 恢复来源 | 问题 |
|---|---|---|---|---|
| 策略净仓 `m_netpos` | TradeBot 进程内存 | 成交累计 | **无**（重启归零） | 与交易所/ORS 仓位的唯一真相分离 |
| 账户/交易所仓位 | ORS/CTP | ORS | `position.csv`（ORS 启动读） | 30 B、每日覆盖两次、无历史 |
| 手工仓/展示 | GUI `PositionModel` | DataService 流 | 无 | 只在内存；Group/Mult/Fees 不持久化 |
| 订单 | TradeBot 内存 + 日志 | TradeBot | 无 | 重启后订单表空；交易所可能仍有挂单 |
| PnL | TradeBot 内存 + 日志 | TradeBot | 无 | 重启后归零 |

【V】`04 §7.1-7.3`；`05 §3.2`

- 代码里唯一的仓位持久化在蝶式：`../data/positions<id>`、`final_positions_*`、`final_PNL_*`；这些文件在磁盘上**不存在**，因为蝶式从未启用。【V】`04 §4.6`
- Live 中国链路的 TradeBot **不写任何业务状态文件**；`grep ofstream` 只有 4 处，其中 3 处是死路径（KRX/pid/蝶式）。【V】`04 §7.5`
- `pid` 文件路径写成 `/home/TradeBot/TradeBot/data/pid.<date>`，少了 `_China`，目录不存在；`ofstream` 失败不检查，**实际没有 pid 文件**。运维只能 `pkill` 按进程名。【V】`main.cpp:683-690`
- **重启语义**：TradeBot 重启后 `m_netpos=0`，按“空仓”重新报价；交易所可能仍有旧仓/旧单。若没有人工先平仓，可能双向叠加。P0。

> 注意一个细微差别：ORS 启动时会读 `position.csv`（`POSITION_FILE`），所以 **ORS 侧有部分对账**；但 TradeBot 不读，策略侧仍是空的。两本账不会自动合并。【V/I】`05 §3.2`

### 6.4 源码/二进制/配置漂移

| 组件 | 源码 | 构建 | 线上 | 判定 |
|---|---|---|---|---|
| TradeBot | `TradeBot_China` r2375，2015-06-10 | `main/TradeBot` 6/17，BuildID `65f23d3c…` | 同左；日志到 6/30 | **二进制晚于源码**；`.bash_history` 显示 6/10 后还在改 `ExecutionStrategy/AggressiveStrategy` → 含未提交改动 |
| ORS | `infrastructure/China`（git HEAD 2014-10-27，1287 dirty） | `2/bld/.../China` 2015-03-30 | `china_ors_extreme_new` 4/26，`beaa7b6d…` | 二进制晚于 build 快照；配置 7/13 又晚于二进制 |
| MD 接收 | `MDReceiverX` 2015-03-30 | `mdreceiverX` 6/2 `6e73c47b…`；`bothfeeds` 2/11 `69db68c5…` | `/home/re` 两套并存 | 不知道 7/24 实际跑的是哪套 |
| DataService | `infrastructure/DataService` | 2014-09-30 | `dataservice` `ebb2a27f…` | 配置/二进制都是 2014 |
| Qt5 GUI | `.cpp/.h` 2014-11-20 | 源码树 2015-03-19 `1aecd50d…` | `GUI/SH` 2014-12-21 `a2e432bd…` | 线上 12/21 与源码同源（日志行号对得上）；3/19 构建**未部署** |
| Qt4 GUI | `TradingSystemsGUI` git 2014-10-07 | 二进制 2014-09-26 `76f8f101…` | `3/infra/TradingSystemsGUI` | 二进制**缺** 10/6–10/7 的净敞口修复 |

【V】`05 §7.1`；`00 §5.6`；`03 §6.1-6.3`

**含义**：

1. 不能从归档源码**字节级重建**线上二进制；只能“行为近似”。
2. 配置可能比二进制新；新键可能被旧二进制静默忽略。
3. Qt4 源码比二进制新；重编会得到不同行为。
4. MD 有三个近亲；选错会“进程在、没数据”。
5. 唯一持久的交易状态是 ORS 的 `position.csv` + 柜台；不是源码/二进制。

### 6.5 硬编码路径与不可重定位

| 路径 | 出处 | 问题 |
|---|---|---|
| `/home/TradeBot/models/...` | 所有 control 第 2 字段 | 换机器/用户必须整体改 |
| `/home/TradeBot/TradeBot_China/...` | `RunStrategies*.sh` | 目录名写死 |
| `/home/TradeBot/TradeBot_Multi/main/TradeBot` | `runExec.pl:15` | 树名错误（过时脚本） |
| `/home/TradeBot/TradeBot/data/pid...` | `main.cpp:685` | 少 `_China` |
| `/home/leon/CL/config/cfg_` | `cfgField.cpp:38` | 策略配置根 |
| `/home/piyush/ORS_CHINA_extreme/log/position.csv` | `.leonConfig.cfg:21` | 跨用户路径 |
| `/home/infra/dataservice_deploy/...` | `configServiceChinaNew.xml:5-6` | 部署路径 |
| `/home/GUI/SH/...` | `runChinaGui.sh` | 部署路径 |
| `../data/...`、`../Config/...`、`../models/...` | TradeBot 源码 | **cwd 必须是 `TradeBot_China/main`** |
| `./GuiSettings.xml` | `Main.cpp:63` | cwd 敏感；不是 exe 相对路径 |
| `/home/dalong/Qt5.3.1/...` | GUI 二进制 RPATH | 部署机没有这个用户/路径；必须 `LD_LIBRARY_PATH` |

【V】`04 §9.2`；`03 §6.4`

**结论**：这套系统**不可重定位**；迁移必须保留 `/home/{TradeBot,leon,piyush,infra,GUI}` 的形状，或做全局路径替换并重编译。任何“拷到别处直接跑”的想法都会失败。

### 6.6 日志与磁盘

- GUI 日志 0.9 GB/天（7/24 单日 386 MB + 588 MB），10 天 9 GB；没有应用级 `logrotate`。【V】`05 §6.2`
- ORS 2.4 GB；DataService 866 MB；MD 40 MB；TradeBot 8 MB；`3/leon/log` **39 GB**。【V】
- `/home` 78 GB，日志约 50 GB；再跑几天就可能满。没有磁盘告警/自动清理。【V/I】
- `ZipLogs.sh` 只 gzip“当天” TradeBot 日志，未挂 cron；当前没有 `.gz`，说明最后一次没跑或已被清理。【V】`04 §5.5`
- 7/7 出现异常大日志（ORS 368 MB、DataService 299 MB），说明没有大小上限/调试日志可能爆量。【V】`05 §6.2`

### 6.7 陈旧/重复的 controls/models

| 项 | 数字/现状 | 风险 |
|---|---|---|
| controls | **2,006** 个，143 个日期（20150209–20150725），18 个策略族 | 扁平目录；无版本控制 |
| models | **1,958** 个，70,021 行 | 比 controls 少 48 个 `eve.print` |
| 归一化重复度 | controls **24** 种内容；models **65** 种 md5 | 绝大多数是每日 `sed` 日期克隆，不是重新拟合 |
| 策略族使用 | `TB_AGGRESSIVE_STRAT` 1172、`TB_COMMS_STRAT` 406、`TB_AGGRESSIVEPASSIVE_STRAT` 380、`TB_DEP_AGGPASS_STRAT` 41、`TB_FAK_STRAT` 6、`TB_PASSIVE_STRAT` 1 | 其余 25 个分支从未在生产使用 |
| 时段 | GMT；`0230-0330`、`0530-0700`、`1300-1830` 等 | 与日志 GMT 对齐；换 CST 要 +8h |
| `CHECK_PNL` | **437** 个 model 设为 0 | 不做单笔 PnL 过滤，任何价位都可能挂 |
| 风险阈值 | 1,955/1,958 个 model 的 `UPNL_LOSS=STOP_LOSS=MAX_LOSS` | 三层风控同时触发，等于没有分层 |
| `MAX_POS_SIZE` | 1,000,000 手 | 对 GOLD 约 1,000 吨名义量，持仓上限事实失效 |
| `MAX_ORDERS` | 450 | 真正的日单量预算；主动策略约 200–400 次重报价就撞线 |
| `REJECT_LIMIT` | 200（硬编码） | 超过即 `exit(1)`，不平仓 |
| `signal.txt` | NIFTY 期权 | `SIGTERM` 对 GOLD 不生效 |
| `NSEHolidays2015` | 只有 4 个 2014 日期 | 2015 NSE 假日全部漏判（本部署不用 NSE，但模板误导） |
| SFE 节假日 | **没有** | TradeBot 不会因周末/中国节假日拒绝交易 |
| `RolloverOverrideFile` | GOLD/SILVER 到 2015-11-15；COPPER 到 2015-05-29 | 之后回退到按月推算，可能选错合约 |
| `ForexAlerts` | 到 2015-04-07 | 新闻过滤在 6/7 月失效 |
| `GOLD.eve.print` | 48 个 control，**0 个 model** | `temp.sh` 按原文必然启动失败 |

【V】`04 §2.4,§2.6,§3.5,§3.7,§4.4,§9.1,§9.3`

> 这套 controls/models **不是“训练数据”，而是每日克隆的参数模板**；只有 24/65 种内容。把它们当“模型历史”会高估模型的新鲜度。P1（保存/复盘）。

### 6.8 故障模式表

| 错误/故障 | 症状 | 根因/证据 |
|---|---|---|
| 策略在 ORS 之前启动 | 进程启动即 abort；日志只到 Config/Control 就没了 | `Connector` attach `727272` 失败 → `IpcException`；`main.cpp:1065-1074` 的 catch 被注释 → `std::terminate` |
| 策略在 MD 接收之前 | 同上；即使 ORS 在，`registerMDClient(10201)` 失败 | `connector.cpp:70` |
| ORS 在网关之前 | 登录 7776/7777 失败；可能没有 SHM | `05 §4.4` |
| DataService stream 在 ORS/MD 之前 | stream 启动但无数据；GUI 表格空 | `configStream_CTP.xml:16-31` |
| GUI 在 DataService 之前 | 每个 collector `waitForConnected()` 最长 30 s；界面冻结/空白 | `DataCollector.cpp:45-56` |
| GUI 在策略之前 | 安全：策略行离线；心跳到达后自动 `connectRequest` | `Container.cpp:57-80` |
| 策略在 GUI 之前 | 交易不受影响；心跳 PUSH 可能阻塞/丢遥测 | `StrategyMsgHub.cpp:33-59`（`ZMQ_SNDTIMEO=-1`） |
| ORS 脚本 `ipcrm` 但旧 ORS 未死 | 旧进程用已删除段，新进程建新段；策略连错段 | `runORS_extreme_new.sh:4-10` |
| MD 重复启动 | 同一 UDP 包被多个进程消费；SHM 头错乱 | `SO_REUSEADDR`；`05 §3.3` |
| 策略端口被抢 | GUI 行号/策略名错位；Start/Stop 打到错误行 | `cfgField.cpp:687-735`；`03 §3.7` |
| 磁盘满 | 日志写失败；交易/审计同时受损 | `05 §6.2` |
| `SIGTERM` 平仓 | 对 GOLD 不生效，进程继续跑 | `signal.txt` NIFTY；`04 §1.3` |
| `kill -9` | 挂单/仓位留在交易所；重启空仓 | `2/var/spool/cron/root:8-10` |
| 手工单 `OrdType` 未初始化 | ORS 可能按随机枚举解释（限价/市价/其他） | `Order.cpp:58-63`；`GuiUtils.h:77-95`；`PlaceOrderWidget.cpp:177-207` |
| GUI 关闭 | 不发 `GuiClose`；策略仍认为 GUI 在线 | `Container.cpp:18-25`；`sclock.cpp:263-269` |
| GUI 重启 | 策略不回 `status#start`；GUI 可能显示 stopped 而策略仍在跑 | `03 §3.6` |

---

## 7. 代码级风险

> 本节只列**直接读到源码**的问题（V）；“后果”部分含推断（I）。完整清单见 `02 §8`、`03 §8`，这里按安全/可用性重排，并补上本次新核对的证据。

### 7.1 内存/字符串/未初始化/越界

| # | 位置 | 问题 | 后果 | 级别 |
|---|---|---|---|---|
| C1 | `main.cpp:1041-1055` + `TradeBotUtils.h:657,685` + `CommonClient.cpp:424,443` | `m_simConfigList[100]` / `m_instruList[100]` 用 `uint16_t symbolID` **无界索引**；启动时写、每 tick 读 | symbolID ≥100 时越界读写；最坏是每 tick 的堆/全局内存破坏 | **P0** |
| C2 | `main.cpp:860,884` | `char interestlist[50][50]` + `strcpy(interestlist[count], ...)`，`count` 无上限 | 同进程 >50 合约时栈溢出 | **P1** |
| C3 | `TradeBotUtils.cpp:1662-1669` | `LoadControlList` 用 `simConfig[count]`，不检查 `MAX_SIM_CONFIG=20` | `--controlList` >20 行时越界写 | **P1** |
| C4 | `common/Tokenizer.cpp:4-14` + `TradeBotUtils.cpp:1679,1730` | `Tokens[10]` 无界；`strtok` 非线程安全 | 多一个 token 就栈溢出；多线程下串扰 | **P1** |
| C5 | `TradeBotUtils.cpp:1701-1717` + `TradeBotUtils.h:575-578` | `strcpy` 到 `m_startTime[5]`、`m_endTime[5]`、`m_id[10]`、`m_baseName[50]`、`m_secondName[50]` | 控制文件一个手误/恶意长字段即越界 | **P1** |
| C6 | `main.cpp:410,417,589,612,902` + `ExecutionStrategy.h:233` | `strcpy` 到 `m_logFile[1024]`、`m_configFile[1024]`、`m_account[11]` | 超长路径/账户覆盖相邻字段 | **P1** |
| C7 | `Indicators/include/Indicator.h:42-50` | 构造函数不初始化 `isValid`、`strategyIndex`、`exe_strategy` | 新指标忘置 `isValid` → `Value()` 返回随机 bool → 目标价随机废弃 | **P1** |
| C8 | `ExecutionStrategy.cpp:1981-1984` | `m_openQty < 0` 时 `assert(0)`；release 未定义 `NDEBUG` | 交易所超成交/重复回报 → 进程 abort，持仓裸奔 | **P0** |
| C9 | `Indicators/include/Indicator.h:41-56` + `TradeBotUtils.cpp:2034-2035` | `m_level` 可被 `MAX_QUOTE_LEVEL` 抬高，但 `Instrument` 的 `bookDepth=10` 只初始化前 10 档 | 读到未初始化档位价格/量 | **P2** |
| C10 | `main.cpp:2241-2265` | `LoadArgMap` 未知键静默保留；缺少 value 也返回 true | 拼错 `--adjustLTP` 不报错，策略按默认值跑（可能完全不报价） | **P2** |
| C11 | `main.cpp:623-624`、`CommonClient.cpp:392-394` | `sprintf` 拼 shell 命令 + `system()`，输入来自 `--controlList`/control 的 `m_modelFile` | **root 命令注入**；同时阻塞业务线程 | **P0** |

### 7.2 线程与生命周期

| # | 位置 | 问题 | 后果 | 级别 |
|---|---|---|---|---|
| T1 | `GuiMsgHub.cpp:37-38` | `recv_thr = std::thread(...); recv_thr.detach();` | GUI 关闭时接收线程仍可能调用 `Container::onMsg`；`GuiMsgHub` 从不 delete，`Container` 无析构/无 `zmq_ctx_term` → use-after-free | **P1** |
| T2 | `GuiMsgHub.cpp:87` | `onMsgCallback(msg)` 在 ZMQ 接收线程**直接调用**（不是 Qt queued signal） | 回调里若碰 GUI 对象/非线程安全状态，就是数据竞争；正常路径的 `emit` 会排队，但直接回调不会 | **P1** |
| T3 | `StrategyMsgHub.cpp:26-30` | `poll_thr.detach()` + `heartBeatThr.detach()` | 策略退出时线程仍在跑；无 join/stop；`zmq_ctx` 不终止 | **P1** |
| T4 | `StrategyMsgHub.cpp:83,114` | `int64_t more;` 未初始化；`status = zmq_getsockopt(...) != 0` 是**赋值比较结果**，不是错误码 | 多段消息循环可能读错 `more`；错误处理失效 | **P2** |
| T5 | `CommonClient.cpp:171-174,1099-1111` + `main.cpp:90-164` | 信号线程直接改 `m_onExit/m_onFlat/m_Active/m_netpos`，业务线程同时遍历 `m_bidMap/m_askMap` | 数据竞争/迭代器失效/重复下单；无锁/无原子 | **P0** |
| T6 | `CommonClient.cpp:909-1086` | 所有下单/改单/撤单共用成员 `m_reqMsg`，非重入 | 开 `VOLTHREAD` 或未来多线程化时必然串包 | **P1** |
| T7 | `DataCollector.cpp:43-56,96-101` | 在 GUI 线程做阻塞 `waitForConnected/waitForBytesWritten/waitForReadyRead`（默认 30 s） | 启动/手工单/撤单时 UI 冻结；操作员可能重复点击/杀进程 | **P1** |
| T8 | `OpenOrder.cpp:54-64`、`ExchangeWidget.cpp:752-762` | `cancelAll`/`SquareOffAll` 对每张单/每个仓位新建一次 TCP 连接/登录 | 仓位多时 UI 冻结数十秒；部分成功/失败无汇总 | **P1** |

### 7.3 ZMQ 错误处理

| # | 位置 | 问题 | 后果 | 级别 |
|---|---|---|---|---|
| Z1 | `GuiMsgHub.cpp:77-84` | `zmq_msg_recv` 返回 -1 时，`std::string(msg_data, status)` 的 `status` 被转成 `size_t(-1)` | 抛 `length_error`/`bad_alloc` 或读越界；接收线程崩溃，GUI 失去控制面 | **P1** |
| Z2 | `GuiMsgHub.cpp:74-92` | 每轮 `zmq_msg_init`，但**从不 `zmq_msg_close`** | 每条消息泄漏；300 万条/日 → 百 MB/日；确定性泄漏 | **P2** |
| Z3 | `GuiMsgHub.cpp:10-16,64-72` | `zmq_ctx_new`/`zmq_socket` 失败只 `ILOG(FATAL)`，不退出；`FATAL` 只是日志级别 | 后续用 NULL socket → 空指针崩溃；`zmq_bind` 失败才 `exit(-1)` | **P1** |
| Z4 | `StrategyMsgHub.cpp:99-117` | 同样缺 `zmq_msg_close`；`status` 只在 -1 时 continue，其他错误不处理 | 泄漏 + 错误静默 | **P2** |
| Z5 | `GuiMsgHub.cpp:45-50` + `Container.cpp:287-291` | `ZMQ_DONTWAIT` 失败只 WARN；调用方忽略返回值并返回 0 | **Start/Stop/参数命令可能丢失且不可见** | **P0** |
| Z6 | `Container.cpp:222-260` | 未知 `port` 打 `ILOG(FATAL)` 后 `continue`；`FATAL` 不退出 | 策略若占了配置外的端口，GUI 静默丢弃其所有消息 | **P2** |

### 7.4 SHM attach / ORS

| # | 位置 | 问题 | 后果 | 级别 |
|---|---|---|---|---|
| S1 | `connector.cpp:62,70,75,80` | Live 模式按顺序 attach client store → MD → response → request；任一段不存在就抛异常 | 启动顺序错/ORS 未起 → 进程 abort（`main.cpp:1065-1074` catch 被注释） | **P0（运维）** |
| S2 | `shmmanager.h:245,260,300,308,456` | 所有 SHM 0666 | 本机任意用户可读/写订单队列 | **P0** |
| S3 | `05 §3.3` | `mdreceiverX` attach 已存在 10201，`Header already existing` | 跨重启读到旧行情/旧队列；无版本/无清空 | **P1** |
| S4 | `runORS_extreme_new.sh:4-10` | `ipcrm` 不先杀旧进程 | 双实例/策略连错段 | **P0（运维）** |
| S5 | `shmmanager.h` + `05 §8.4` | 无 magic/version/length；布局靠头文件人工对齐 | 版本漂移时静默解析错位 | **P1** |

### 7.5 UI 阻塞与手工单

| # | 位置 | 问题 | 后果 | 级别 |
|---|---|---|---|---|
| U1 | `PlaceOrderWidget.cpp:142-144` | `QString theOptionType; theOptionType[0] = ...;` 对空 QString 下标写入 | 未定义行为；Qt5 debug 可能 assert；release 写垃圾 | **P2** |
| U2 | `PlaceOrderWidget.cpp:179-188` | `strcpy` 到 `AccountID[11]`、`Symbol[50]`、`InstrumentName[32]`，UI 无 `setMaxLength` | 超长输入覆盖相邻字段/栈 | **P1** |
| U3 | `ContractWidget.cpp:126` | `strcpy(Symbol, m_name)`，`m_name` 来自 `contractName` 消息（可被策略/伪造者控制） | 同上；远程可控 | **P1** |
| U4 | `MDCollector.cpp:38-40` | `strcpy(temp.m_symbol, theSymbol)`，symbol 来自 UI/策略 | 同上 | **P1** |
| U5 | `DataCollector.cpp:56,99` + `loginreplymessage.h:35` | `read()` 不检查字节数；`setDescription` 用 `strcpy` 到 `char[30]` | 短读 → 结构体错位/未初始化 bool（可能误判登录成功）；服务端长描述 → 客户端栈溢出 | **P1** |
| U6 | `ContractWidget.cpp:281-298` | 撤单构造了 `PlaceOrderWidget` 但**没有 `exec()`**，直接发送 | 右键误触即撤单，无二次确认 | **P1** |
| U7 | `OpenOrderMsgHub.cpp:4-15,17-82` | 600 ms 轮询 + `singleShot` 重新排程 | 周期漂移；挂单表最多滞后 600 ms；锁竞争时可能清空某交易所表 | **P2** |
| U8 | `PositionModel.cpp:142-178` | 只用 `m_symbol` 做键，不区分 account/exchange | 同 symbol 跨账户/交易所合并成一行；手工平仓可能打错账户 | **P1** |
| U9 | `FillResponse.cpp:124-125` | 只看 `getOrderDescription()`，不区分 `Fill m_status` | 被拒绝的成交也显示成“成交”；操作员误判仓位 | **P1** |
| U10 | `PositionModel.cpp:232-315` + `Position.cpp:60-70` | `Position.csv` 只读；`AddToCsv` 未调用 | Group/Mult/Fees 改动关窗即丢；重启后 PnL 归零 | **P2** |
| U11 | `DataService/include/order.h:58-63` + `GuiUtils.h:77-95` + `PlaceOrderWidget.cpp:177-207` | 手工新单的 `RequestMsg.OrdType` **从未初始化**；`ManualOrderSender` 只补 `Duration/PxType` | ORS 可能按随机枚举解释为限价/市价/其他；手工单可能变成市价单 | **P0** |
| U12 | `TradingSystemsGUI/ExchangeDetails.h:6-11` + `OpenOrderMsgHub.cpp:6-10` + `OrdersCollector.cpp:24-38` | `ExchangeDetails::m_WindowNumber` 没有默认值，`GuiSettings.xml` 也不设置；直接用于订单订阅 | 订阅窗口号是栈上垃圾值；挂单表时有时无/串窗口 | **P1** |

### 7.6 路径/环境假设

| # | 位置 | 问题 | 后果 | 级别 |
|---|---|---|---|---|
| H1 | `main.cpp:1041-1062` + `RunStrategies.sh:1` | 所有 `../data`、`../Config`、`../Connector` 相对 cwd；必须 `cd .../main` | 从别处启动 → 缺文件 `exit(1)` 或读错配置 | **P1** |
| H2 | `Main.cpp:63` | `./GuiSettings.xml` 相对 cwd | 从别处启动 → `exit(-1)`；日志/CSV 写到调用目录 | **P1** |
| H3 | GUI binary RPATH | `/home/dalong/Qt5.3.1/...` | 部署机无此路径 → 必须 `LD_LIBRARY_PATH` | **P1** |
| H4 | `main.cpp:685` | pid 路径少 `_China` | 无 pid 文件；运维只能按进程名 `pkill` | **P1** |
| H5 | `runChinaGui.sh:2`、`receive_new.sh:1`、`receive.shBak:1` | `taskset -c -p N cmd` 不是标准语法 | 按原文不能启动/绑核；实际靠人工绕过 | **P1** |
| H6 | `SkylineFL_GUI.pro:18-31` | `$$(HOME)/infrastructure` | 构建用户 HOME 必须是 `/home/dalong` 或手工改 | **P2** |

### 7.7 金融逻辑/风控

| # | 位置 | 问题 | 后果 | 级别 |
|---|---|---|---|---|
| F1 | `ExecutionStrategy.cpp:308,945` | 拒绝超 200 / 当日订单超限 → `exit(1)`，**不平仓不撤单** | 持仓/挂单留在交易所；重启空仓 → 双向叠加 | **P0** |
| F2 | `ExecutionStrategy.cpp:1981-1984` | 超成交 `assert(0)`；release 未定义 `NDEBUG` | 进程 abort；同上 | **P0** |
| F3 | `ExecutionStrategy.h:43` vs `ButterflyStrategy.h:36` | `HandleSquareoff()` 基类**非虚**；蝶式 `virtual` 不构成覆盖 | 信号/收盘平仓对蝶式完全失效；`m_thirdStrat->HandleSquareoff(m_secondinstru)` 的错腿 bug 也因此不可达 | **P0（若启用蝶式）** |
| F4 | `ExecutionStrategy.cpp:2170-2189` | 停损命中后 `m_thold->UPNL_LOSS += m_thold->UPNL_LOSS` | 阈值 2x/4x 放大；越亏越不止损 | **P0** |
| F5 | `ExecutionStrategy.cpp:2038-2070` | 收盘前 3 分钟/1 分钟平仓依赖“还有行情到达” | 行情停止时不会触发；挂单留在市场 | **P1** |
| F6 | `CommonClient.cpp:384-405` | 行情陈旧只置 `onExit/onCancel/onFlat`，不撤已有挂单；要等下一 tick 的 `HandleSquareoff` | 合约彻底没行情时，老单一直挂着，参考价冻结 | **P0** |
| F7 | `main.cpp:477-481` + `TradeBotUtils.cpp:3572-3573` | `CHECK_PNL 0` 时 `targetBidPNL[]` 保持 1.0，PnL 过滤形同不存在 | 任何价位都算“有正 PnL”；437 个 model 如此 | **P1** |
| F8 | `Config/StrategyConfig.cfg:2` + `ExecutionStrategy.cpp:68` | `MAX_POS_SIZE=1000000` 手 | 持仓上限事实失效；真正闸门是 `MAX_ORDERS=450` 和 `MAX_LOSS` | **P1** |
| F9 | `main.cpp:240-250,301-359` + `CommonClient.cpp:440` | MD/IND 回调用全局 `m_simConfig`（最后一个策略） | `--controlList` 多策略时所有行情只喂最后一个策略 | **P1** |
| F10 | `ExecutionStrategy.cpp:1329-1330` | `m_bidMap/m_askMap` 以价格为键，同价只允许一张单 | 多合约/多账户会互相覆盖；被迫 cancel/replace | **P2（设计约束）** |
| F11 | `ExecutionStrategy.cpp:2170-2193` | `UPNL_LOSS/STOP_LOSS/MAX_LOSS` 三值相同（1,955/1,958 model） | 三层风控同时触发，等于没有分层 | **P1** |

### 7.8 严重度排序（建议修复顺序）

1. **P0**：C1（symbolID 越界）、C8/F2（assert/超成交）、F1（exit(1) 持仓）、F4（止损阈值翻倍）、F6（陈旧行情不撤单）、F3（蝶式非虚）、C11（`system()` 注入）、U6（撤单无确认）、U11（手工单 `OrdType` 未初始化）、T5（信号线程竞态）、Z5（控制命令丢失）。
2. **P1**：C2-C7（字符串/越界/未初始化）、T1-T3（detach/生命周期）、T7/T8（UI 阻塞）、Z1/Z3（ZMQ 错误）、S1-S3（SHM 顺序/旧队列）、U2-U5/U8/U9/U12（手工单/持仓/成交显示/订阅窗口）、F5/F7-F9（风控/路由）。
3. **P2**：C9/C10、T4、Z2/Z4/Z6、U1/U7/U10、H5/H6、F10。

> 注意：`-w` 关闭了所有编译警告（`main/Makefile:15`、`Strategies/Makefile:6`），release 没有 `NDEBUG`，没有单测/ASan；这些 UB 能长期存在不是偶然。复刻/移植时先把警告和 sanitizer 打开，否则同样的坑会再踩一遍。

---

## 8. 版本谱系

### 8.1 `2/` vs `3/`：谁是源码、谁是运行、谁是备份

| 位置 | 是什么 | 大小 | 判读 |
|---|---|---|---|
| `$R/1` | 空目录 | 0 B | 忽略（备份工具预留槽位）【V】 |
| `$R/2` | CentOS 6.6 **根文件系统**（LVM `lv_root`） | 17 GB / 175,017 文件 | OS 镜像；不是 `/home`；内含 3 的副本与唯一构建依赖 |
| `$R/3` | 同一台机器的 **`/home` 数据盘**（LVM `lv_home`） | 58 GB / 59,737 文件 | 源码/运行/日志/备份的权威位置 |

【V】`00 §2.1`

**`2/` 的三种东西**：

1. **真正的根 FS**：`etc/ bin/ usr/ lib64/ var/ root/ opt/`；`2/etc/fstab:9-12` 证明 `lv_root` + `lv_home` + `lv_swap`。
2. **7/25–7/26 的 `cp -a` 副本（时间戳/完整性证据支持，推断）**：`2/TradeBot` = `3/TradeBot`（10,296 文件/778 MB，`diff -rq` 零输出）、`2/TradeBot.bak` = `3/TradeBot.bak`（1.0 GB）、`2/GUI/SH` = `3/GUI/SH`（排除 `*.log/*.csv/*.swp` 后相同，9.0 GB）。这些是**冗余**，不是独立版本。【V/I】`00 §2.2,§9.1`
3. **唯一的构建依赖**：`2/bld`（471 MB，`libconnectormwmr.a`、`liblogger.a`、`libxsim*.a`、`libdatamanip.a`、`libcommonutils.a`、`libxsimdataserver.a`）、`2/include/illuminati/dev_multi`、`2/usr/local/lib/libsnappy.a`、`2/usr/share/API/{sgit,sfit,CTP_20140811}`、`2/opt/Qt5.3.2`（未使用）。【V】`00 §6.2,§6.3`

**`2/` 的不可信项**：

- `2/dalong/infrastructure` **不完整**（缺 `.build_debug/.build_release` 等；`git status` 显示成批 `D`）→ 不要用。【V】`00 §2.2`
- `2/infra` 只有 `prod/{bin,config,scripts,log}` 骨架（3 文件/244 K）→ 不要用。【V】
- `2/home` 空；`2/TradeBot` 在根上，不是 `/home/TradeBot`。若把 `2/` 当运行盘启动，路径全错。【V】

**结论**：源码/运行看 `3/`；构建依赖看 `2/`；`2/` 的 TradeBot/GUI 副本是纯冗余；`2/dalong`、`2/infra` 是过期/不完整副本。保存时必须 **`3/` + `2/bld` + `2/include` + `2/usr/share/API` + `2/usr/local/lib/libsnappy.a`** 一起，否则 r2375 只能读不能编。

### 8.2 TradeBot 四代：r1918 → r1936 → r2023 → r2375

| 工作副本 | 仓库 URL | rev | 日期 | 作者 | 说明 |
|---|---|---|---|---|---|
| `3/TradeBot.bak`（根 WC） | `svn+ssh://…@<内网 SVN 主机 A>/…/TradeBot_Multi` | **1918** | 2015-02-05 | `TradeBot` | 2 月全量归档 `ttt.tar.gz` 也停在这里 |
| `3/TradeBot.bak/TradeBot_Multi` | 同上 | **1936** | 2015-02-11 | `shiva` | `TradeBot.bak` 成形 |
| `3/tempTradeBot/TradeBot/TradeBot_Multi` | 同上 | **2023** | 2015-02-26 | `avijit` | 仍在旧仓库 |
| **`3/TradeBot/TradeBot_China`** | **`…@<内网 SVN 主机 B>/…`** | **2375** | **2015-06-10** | **`avijit`** | 最高 rev；本档案的源码权威 |

【V】`00 §4.2`

- **同一 SVN 的搬迁**：rev 连续（1918→1936→2023→2375），2/26 之后、6/10 之前从主机 A 迁到主机 B；不是新建仓库。【I】
- **目录名不是上游名**：上游是 `TradeBot_Multi`，本地 checkout 成 `TradeBot_China`；`svn co <url>/TradeBot_Multi TradeBot_China` 的产物。【V/I】`00 §3.2`
- **逐目录 revision 不等**：`Config` r1819、`controls` r1560、`models` r1552、`Indicators` r2373、`Strategies` r2375、`Connector` r2354、`data` r2372 → 运行配置也被提交进 SVN，不是纯代码库。【V】
- **工作副本干净**：`main/main.cpp`、`Makefile`、`Tradebot.sln` 与 `.svn/text-base` 逐字节一致；`2/TradeBot` 与 `3/TradeBot` 也逐字节一致。【V】`00 §3.2,§4.3`
- **代码祖先**：`UpgradeLog.XML` 记录 2012-12-22 从 `D:\shiva\TradeBot_Russia_Code\...` 由 VC2008 升级 VS2010 → **TradeBot_Russia → TradeBot_Multi → TradeBot_China**。这解释了 NIFTY ticker、`signal.txt`、印度节假日、Bovespa 分支等“看起来过期”的遗留：它们不是 China 配置，而是多市场引擎的默认值没清。【V/I】`00 §3.3`
- **r2375 的实质变化**：`main.cpp` 938→951→1077 行；新增 `CommsPassive/DepAggressivePassive/PassiveStrategyAE/Sweep/FAK/SimpleHedging/Hit`；删除 `DateConfig::m_simActive`；`MDCallBack` 分派改写；`main/Makefile` 删除 `PARALLELSIM` 开关、无条件 `-lxsimdataserver`、加 `-w`；`Config/StrategyConfig.cfg` 的 `MAX_ORDERS` 50,000,000→400→**450**。【V】`00 §4.4`；`04 §1.2`

### 8.3 二进制谱系：源码不等于线上

| 产物 | 路径 | 时间 | BuildID/大小 | 判读 |
|---|---|---|---|---|
| `TradeBot` | `3/TradeBot/TradeBot_China/main/TradeBot` | 2015-06-17 | `65f23d3c…` | 线上主二进制；**晚于 r2375 6/10** |
| `TradeBot_2015xxxx` 快照 | 同目录 | 多次 | — | 9 个构建快照；用于对照 |
| `Obama` | 同目录 | — | — | `TradeBot` 的改名副本（`temp.sh` 用它跑 print） |
| `TradeBot_Print` | 同目录 | — | 与 `TradeBot_20150427` 同 md5 | 打印/回归版 |
| `TradeBot_sliver` | `3/TradeBot.bak/...` | 2015-02-13 | 3,063,965 B / `1bfb9b7e…` | 早期“细长版”实验 ELF，不是源码 |
| `china_ors_extreme_new` | `3/infra/prod/bin` | 2015-04-26 | `beaa7b6d…` | 生产 ORS（SGIT） |
| `china_ors_ctp` | 同目录 | 2014-12-04 | — | 遗留 CTP 二进制，不是生产 |
| `mdreceiverX` | `3/re` | 2015-06-02 | `6e73c47b…` | 单 feed 新构建 |
| `mdreceiverX_bothfeeds` | `3/re` | 2015-02-11 | `69db68c5…` | 双 feed 旧构建 |
| `dataservice` | `3/infra/dataservice_deploy` | 2014-09-30 | `ebb2a27f…` | DataService |

【V】`00 §4.1,§5.6`；`05 §2.9,§7.1`

**含义**：

- 线上 TradeBot 二进制**比最高 SVN rev 新 7 天**；`.bash_history` 显示 6/10 后仍在改 `ExecutionStrategy.cpp`/`AggressiveStrategy.cpp` → 线上含**未提交改动**。不能声称“r2375 = 线上行为”。【V】`05 §7.1`
- 没有构建日志/版本号写入二进制；只能靠 BuildID/mtime/日志行号做弱关联。【V】
- `Obama`/`TradeBot_Print`/`TradeBot_2015xxxx` 多份改名副本让“哪个是生产”更难判断；必须先按 BuildID/md5 去重。【V】

### 8.4 GUI 两代：Qt4 → Qt5

```
infrastructure/TradingSystemsGUI  (git, 2014-01-29 创建, 最后改动 2014-10-07)
   │  共享控件：MDCollector/PNLCollector/OrdersCollector/ManualOrderSender/
   │            PlaceOrderWidget/SquareOffAllDialog/Mainwindow/ExchangeWidget...
   ├── TradingSystemsGUI.pro (Qt4/Qt5 兼容垫片) ──► 3/infra/TradingSystemsGUI
   │        Qt 4.8.6 随包，二进制 2014-09-26，BuildID 76f8f101  [旧运行态]
   └── SkylineFL_GUI.pro (Qt 5.3.1) ──► 3/GUI/SH
            二进制 2014-12-21，BuildID a2e432bd  [线上]
            └── 源码树自编 2015-03-19，BuildID 1aecd50d  [未部署]
```

【V】`03 §1.1,§6.1`

- **Qt5 不是 fork 控件层**：`SkylineFL_GUI.pro:31` 设 `INFRA = $$(HOME)/infrastructure/TradingSystemsGUI`，`:52-58` 直接编译共享的 `MDCollector/PNLCollector/ManualOrderSender/PlaceOrderWidget/DataCollector/OrdersCollector/SquareOffAllDialog.cpp`；旧主窗 `Mainwindow.cpp`/`ExchangeWidget.cpp` 不编译。【V】
- **线上二进制与源码同源**：SkylineFL 的 `.cpp/.h` 全部 2014-11-20；线上二进制 2014-12-21；日志行号 `Container.cpp:59`、`GuiMsgHub.cpp:85`、`Position.cpp:29`、`ContractWidget.cpp:20` 与源码逐行对得上。`00-inventory` 的“旧 3 个月”是拿线上二进制和源码树 2015-03-19 的本机构建比，不是和源码内容比。【V/I】`03 §6.2`
- **真正的问题是 3/19 的构建没有部署**：源码树里有一个 2015-03-19 的 1,862,816 B 二进制（`1aecd50d…`），但 `/home/GUI/SH` 从未更新。是“新版只在 `w2w-shanghai` 跑”，还是“有 bug 回滚”，没有证据。【I】`00 §5.6`
- **Qt4 二进制比源码旧 11 天**：二进制 2014-09-26；共享源码 git 最后三条提交 2014-10-06/07（净敞口/隔夜净敞口修复）。用归档源码重编 Qt4 GUI 会得到**不同行为**。【V】`03 §6.3`
- **Qt4 运行目录缺 SONAME 符号链接**：只有 `libQtCore.so.4.8.6` 等，没有 `libQtCore.so.4`；`runGUI.sh` 只设 `LD_LIBRARY_PATH=.`；按原样不能独立启动。`2/GUI/TradingSystemsGUI.tar.gz` 里有符号链接。【V】`03 §6.3`

### 8.5 部署二进制 vs 源码：一张表

| 产物 | 源码 | 部署 | 关系 | 能否“重编即等价” |
|---|---|---|---|---|
| TradeBot | r2375，6/10 | 6/17 `65f23d3c…` | 二进制晚于源码；含未提交改动 | **不能** |
| ORS | git HEAD 2014-10-27（1287 dirty） | 4/26 `beaa7b6d…`；配置 7/13 | 三者不同步 | **不能** |
| MD 接收 | 2015-03-30 | 6/2 `mdreceiverX` / 2/11 `bothfeeds` | 两套并存 | **不能确定** |
| DataService | 2014 | 2014-09-30 `ebb2a27f…` | 基本同步，但 `dataservice.ChinaNew` 缺失 | **部分** |
| Qt5 GUI | 2014-11-20 | 2014-12-21 `a2e432bd…` | 同源；3/19 构建未部署 | **行为近似，不保证字节** |
| Qt4 GUI | git 2014-10-07 | 2014-09-26 `76f8f101…` | 二进制缺 10/6–10/7 修复 | **不能** |
| 网关 | 无源码（厂商） | 2014-12 | 黑盒 | **不能** |

【V】`05 §7.1`

### 8.6 缺失版本控制：SkylineFL_GUI

- `3/dalong/FromDaya/SkylineFL_GUI` **没有 `.git`/`.svn`**；`git rev-parse` 失败。它只有目录、`3/unknown/SkylineFL_GUI.tar.gz`（1.2 MB）、`tosendgui.tar.gz`（582 K）和部署二进制。【V】`03 §1.4`；`00 §6.5`
- 共享控件层 `3/dalong/infrastructure/TradingSystemsGUI` 在 git 里（58 文件，最后提交 `345637ee` 2014-10-07），但**新壳**（`Container`、`Strategy`、`ContractWidget`、`Position`、`FairValue`、`OpenOrder`、`FillResponse`、`PositionModel`…）不在任何 VCS 里。【V】
- 这意味着：
  - 无法知道 2014-12-21 的部署二进制对应哪次改动；
  - 无法回滚/比较/归因；
  - 只能靠目录 + tarball + 二进制 + 日志行号做“物证”。
- **保存含义**：SkylineFL 是**最该先抢救的资产**，优先级高于任何 C++ 重构；先把目录做成 git 仓库（保留原始 mtime/权限的 tar 作为证物），再谈修改。

### 8.7 对保存/复刻的含义

1. **保存“环境”，不是“源码”**：TradeBot 离开 `/include/illuminati/dev_multi` + `/bld/dev_multi` + `libsnappy.a` 无法链接；ORS 还依赖 `/usr/share/API/sgit`；GUI 离开 Qt 5.3.1 + `libzmq.so.3` + infra 的 `liblogger.a/libcommonutils.a` 无法构建。【V】
2. **保存“二进制 + 日志 + BuildID”**：源码不能字节级重建线上；二进制/日志是行为证据，必须和源码一起存。
3. **保存“运行目录”**：`controls`/`models`/`Config`/`data`/`livescripts` 是运行态，不在 SVN；必须原样快照 + 哈希 + 日志头。
4. **保存“时间/时区/权限”**：APFS 压平 uid/gid；tar 里的 owner 可能保留原始 uid/gid；TradeBot GMT vs GUI CST 是复盘关键。
5. **不要“清理”**：`.svn`/`.git` 的 dirty 状态、`bckp/`、`.bash_history`、空日志、core、VNC 日志都是证据；`git checkout .` 会丢厂商 SDK 修改。【V】`05 §8.6`
6. **区分“证据镜像”和“工作副本”**：证据镜像只读、带哈希；工作副本在隔离 VM 中恢复，允许改路径/编译，但不能回写证据。

---

## 9. 演进教训：原版 vs 现代 `quantlink-trading`

> 现代系统只做架构级对比，不重复其细节。参考 `quantlink-trading-architecture/01-system-architecture.md`、`08-security-gaps.md`（2026-11-18，commit `5cee3dd5…`）。

### 9.1 对比总表

| 维度 | 2015 原版 | 现代 `quantlink-trading` | 判定 |
|---|---|---|---|
| 进程模型 | 代码支持 `--controlList` 多策略，但全局 `m_simConfig`/`m_orderIDStrategyMap` 会串；生产靠“一个 control 一行、一个进程”脚本规避 | 明确“一策略一进程”，有 `strategyID`、per-sid 配置、策略注册；但 `main.cpp` 的 N-control 循环仍是遗留路径，缺隔离 | **部署层修了，代码层重复** |
| IPC | SysV SHM：872/10201/3872/4872/727272，0666，无版本/无背压 | SysV SHM：4097/8193/12289/16385 + memlog 789，仍 0666、无 IDL/版本协商、`isFull()` 恒 false、丢消息静默 | **重复**（换 key，不换信任模型） |
| 风控 | ORS 静态 RMS + 策略内 kill switch；`MAX_POS_SIZE=1e6` 事实失效；`STOP_LOSS_CHECK` 注释 | ORS 静态 RMS + 策略内 kill switch；仍不检查可用资金/保证金/涨跌停/时段；`STOP_LOSS_CHECK` 仍未启用 | **重复** |
| 管理面 | 没有 admin；GUI + cron + VNC；攻击面小但可观测性差 | `tbadmin` agent/admin + Flask/WS + PostgreSQL；可观测性提升，但 ZMQ 9980/9981 无认证、HTTP 无认证、`popen()`/SQL 注入 | **加了能力，退了安全** |
| DB | **无 DB**；文件即配置、进程即状态 | PostgreSQL `dbtrade`：策略注册、手工单、时段、合约元数据；运行时仓位/PnL 仍内存 + `position.csv` | **控制面持久化修了，交易状态没修** |
| 停机 | cron `pkill -9`；手工 `SIGTSTP` 是唯一安全路径 | `SIGTERM` 只对 `signal.txt` 合约平仓；10 s 后 `pkill -9`；仍无强制对账 | **重复** |
| 凭据 | ORS/网关/策略配置明文；GUI 默认值；DataService 口令文件 | CTP/DB/webhook/SSH 明文；日志打印 CTP 密码/DSN；git-tracked DSN | **重复/更差** |
| 可观测性 | TradeBot/GUI/DataService/ORS 文本日志；无轮转；无审计 | memlog + admin + DB + 前端；但无不可篡改审计、日志仍含密、前端状态可陈旧 | **可见性提升，审计性未修** |
| 部署 | 手工、绝对路径、无 CI、无签名 | 脚本/DB 同步/RDS，但仍无 reproducible build/签名；root | **部分改善** |
| HA/备份 | 单机、无异地、无 PITR | 单机 190、无异地备份、无 `pg_dump`/PITR、无双人复核 | **重复** |

### 9.2 五个关键维度展开

**（1）一策略一进程**

- 原版：`control` 一行 = 一个 `SimConfig` = 一个 `ExecutionStrategy` 子类对象；生产 `RunStrategies.sh` 每个策略一行 `nohup taskset -c N TradeBot ...`。这是**运维约定**，不是代码强制：`--controlList` 仍能在一个进程里塞多个策略，而 `m_simConfig`/`m_orderIDStrategyMap` 是全局的，行情会喂给最后一个策略、回报按 ID 路由，容易串。【V】`02 §4.3`；`main.cpp:642-844`
- 现代：明确“一策略一进程”，每个进程有 `strategyID`、per-sid config、策略注册；这是真正的进步。但 `main.cpp` 的 N-control 循环还在，且缺 per-strategy ID/路由隔离；如果谁再用 `--controlList`，老问题会回来。【V】`quantlink-trading-architecture/01-system-architecture.md §0,§1`
- **教训**：进程隔离是对的，但要在代码里**拒绝**多策略同进程，或把全局状态改成 per-strategy；不能只靠启动脚本。

**（2）SHM**

- 原版：SysV SHM 0666、无版本、无背压；attach 顺序是硬依赖；ORS 的 `ipcrm` 不杀旧进程；MD 接收 attach 旧队列。优点是低延迟、实现简单；缺点是“任何本机进程可读写、任何版本漂移都静默错位”。【V】`shmmanager.h`；`05 §3.3,§4.4`
- 现代：换了 key（4097/8193/12289/16385）+ memlog 789，但**仍是 SysV SHM、仍 0666、仍无 IDL/版本协商、仍静默丢消息**；还多了 memlog 这个可伪造的监控面。【V】`quantlink-trading-architecture/08-security-gaps.md §1.3,§3`
- **教训**：SHM 不是问题，**没有所有权/版本/背压的 SHM** 才是问题。至少要做到：单写者、0600、magic+version+length、队列满可见、消费者可检测丢包。

**（3）RMS**

- 原版：ORS 侧静态额度（`PerTickerNetQuantity=1000`、`OpenValue=500000`、`OpenQuantity=1000`、`OpenOrders=1000`、`InstrumentLevelLossFatalLimit=10000`）；策略侧 `UPNL_LOSS/STOP_LOSS/MAX_LOSS`。`STOP_LOSS_CHECK` 被注释；没有可用资金/保证金/涨跌停/时段检查；`MAX_POS_SIZE=1e6` 使仓位上限失效；`REJECT_LIMIT=200` 触发 `exit(1)`。【V】`04 §3.5`；`ExecutionStrategy.cpp:308,945`
- 现代：同样的静态 RMS，同样的 `STOP_LOSS_CHECK` 未启用，同样的“不检查资金/保证金/可平量”；只是配置换成了新文件/新 key。【V】`quantlink-trading-architecture/08-security-gaps.md §0#10`；`03-ors-connectors.md §5`
- **教训**：RMS 不是“加一个配置文件”就有的；真正的 pre-trade gate 需要**资金/保证金/可平量/涨跌停/时段/账户级净额**，并且失败要**拒绝**而不是 `exit(1)`。原版和现代都没有。

**（4）Admin**

- 原版：没有 admin；只有 GUI（ZMQ 控制/遥测 + DataService 数据面）和 cron/VNC。攻击面小，但“谁在跑/为什么停/仓位多少”靠人和日志。
- 现代：`tbadmin` agent/admin + Flask/WS + PostgreSQL；可观测性大幅提升，但引入了**未认证 ZMQ 管理通道**（可 `popen()`）、**未认证 HTTP**（可改风险/下单）、**SQL/shell 注入**、**CORS `*`**、**前端跳过登录**。这是“用新组件把旧信任模型放大”。【V】`quantlink-trading-architecture/08-security-gaps.md §0#1-#3,§1.4`
- **教训**：管理面不是“加一个 Web 就行”；它必须和交易面**同样的认证/授权/审计**，否则就是把 root 遥控器放到网上。

**（5）DB**

- 原版：**无 DB**；`grep psql/mysql/sqlite` 零命中；链接库无 DB 客户端；唯一的“DB”是 `Brazil_db2` 目录（文本文件，且不存在）。【V】`04 §7.2`
- 现代：PostgreSQL `dbtrade` 用于策略注册、手工单、时段、合约元数据、审计/遗留表；但**运行时仓位/PnL 仍不在 DB**，`position.csv` 仍是 ORS 的时点快照；两本账仍然存在；DB 还带来 DSN/权限/备份/注入等新风险。【V】`quantlink-trading-architecture/01-system-architecture.md §0#5,§3.4`；`05-data-model.md`
- **教训**：DB 适合做**配置/注册/审计**，不适合做 tick 热路径；但“有 DB”不等于“有交易真相”。如果不同时做**订单/成交/仓位的 append-only 账本 + 对账**，DB 只是多了一个不一致的副本。

### 9.3 真正的进步、重复与退步

**进步**：
- 一策略一进程 + `strategyID` + per-sid 配置（现代）；
- 管理面/监控（memlog/admin/DB）让“谁在跑”可见；
- 策略注册/手工单/时段的 DB 化，减少“文件即配置”的漂移；
- 更系统的 ops 脚本/会话管理。

**重复**：
- SysV SHM 0666/无版本/无背压；
- 静态 RMS、无资金/保证金检查；
- 两本账、无自动对账；
- `kill -9`/条件平仓/不可靠停止；
- 明文凭据、日志含密、root 运行；
- 无 HA/异地备份/PITR。

**退步**：
- 管理面从“没有”变成“未认证的远程命令执行面”；
- 凭据从“ORS/网关”扩散到“DB/webhook/SSH/前端”，且部分 git-tracked；
- 日志从“文本”变成“文本 + DB + 前端”，但审计完整性没有提升，泄露面更大。

### 9.4 对移植的启示

1. **不要移植进程模型/SHM/协议**：这些是 2015 年的部署约束，不是业务资产；移植应保留**策略语义**（control/model 解析、指标、订单状态机、PnL/风控规则），重写运行时。
2. **不要用“加 DB/admin”当现代化**：先做**认证控制面 + 仓位对账 + append-only 审计 + 优雅停机**；这四件事比 DB/前端更能降低风险。
3. **保留原版的“简单性”**：一个二进制 + 文件 + 文本日志，容易归档/复盘；现代的多进程/DB/Web 增加了可观测性，也增加了攻击面。移植时按需引入，不要一次性全搬。
4. **把“配置”当代码管理**：control/model 要有 schema、版本、hash、审批、回滚；否则无论新老系统，都会回到“vim + SIGUSR2”。
5. **先修“会错单”的，再修“好看”的**：symbolID 越界、exit(1)、assert、手工单 OrdType、陈旧行情不撤单、非虚 squareoff——这些直接造成错误下单/持仓裸奔；UI/日志是第二优先级。

---

## 10. P0/P1/P2 建议

> 目标分三类：**保存（preserve）**、**受控运行（run）**、**移植/重写（port）**。每条都给出“为什么”和“验收”。不建议在原始 APFS 盘上直接运行任何 ELF。

### 10.1 P0：不做就不要运行/对外提供

| # | 动作 | 为什么 | 验收 |
|---|---|---|---|
| P0-1 | **证据镜像只读 + 哈希清单**：对 `$R/2`、`$R/3` 做整盘/目录 SHA256，记录 `stat`、BuildID、tar 内 owner/mtime；工作副本另存。 | 防止误改/误删；APFS 已压平 uid/gid，原盘是唯一物证。 | 哈希清单可复算；工作副本与证据镜像分离。 |
| P0-2 | **轮换/吊销所有 2015 凭据**：ORS/broker、网关、`.leonConfig.cfg`、DataService、GUI 默认值、VNC/SSH。 | 明文、同盘、可能已泄露；2015 凭据不应在 2026 年有效。 | 旧口令全部失效；新凭据不在源码/日志里。 |
| P0-3 | **网络隔离**：默认 deny；VNC/SSH 只经跳板/内网；ZMQ 15213/15300–15333、DataService 20000/1732/1733、ORS 7776/7777 只 bind `127.0.0.1` 或防火墙白名单。 | 当前是 `tcp://*` + root VNC + 明文协议；任何可达者都能下单/启停。 | 外部 `nmap` 不可见；本机 `ss -lntp` 只看到回环。 |
| P0-4 | **先修“会错单”的代码路径**：C1 symbolID 边界、C8/F2 assert、F1 exit(1)、F3 非虚 squareoff、F4 阈值翻倍、F6 陈旧行情撤单、手工单 `OrdType`。 | 这些直接造成错误下单/持仓裸奔；比 UI/日志优先。 | 每个修复有单测/断言；故障注入验证不越界、不裸奔。 |
| P0-5 | **启动对账**：读 ORS/柜台仓位，与 `position.csv`/本地账本比对；不一致拒绝启动；订单/成交/仓位 append-only 落盘。 | 当前 TradeBot 重启归零，旧仓仍在交易所；`kill -9` 后无对账。 | 人为制造“本地 0/柜台非 0”，系统拒绝启动并告警。 |
| P0-6 | **优雅停机**：禁止 cron `pkill -9`；改为“停止报价 → 撤单 → 平仓 → 确认 → 退出”；超时才 `-9`，并记录未平仓位。 | 当前 15:05/02:35 直接 `-9`；`SIGTERM` 对 GOLD 还是 no-op。 | 停机演练：无残留挂单/仓位；日志有完整步骤。 |
| P0-7 | **配置/模型完整性**：control/model 只读 + hash + 版本目录；禁止盘中 `vim`；`SIGUSR2` 记录旧/新 hash；修 `signal.txt`。 | 配置即代码，且 `system()` 可注入；盘中改动无审计。 | 每次启动日志带 control/model hash；改动有 diff/审批。 |
| P0-8 | **保存 SkylineFL 源码**：立即建 git 仓库（含原始 tar/mtime），把 `Container/Strategy/Position/...` 纳入；保存部署二进制。 | 新 GUI 无任何 VCS；丢失即无法恢复。 | `git log` 有初始提交；tar SHA256 存档。 |
| P0-9 | **移除 hot path 的 `system()`/`mailx`**：改异步告警/本地 socket；对 `modelFile`/symbol 做 shell 转义或干脆不拼 shell。 | 阻塞单线程 + root 命令注入。 | 行情陈旧告警不阻塞 tick；注入测试无效。 |
| P0-10 | **SHM 权限 0600 + 单写者**：至少先 `chmod`/`ipcperm` 限制本机用户；记录 owner；禁止未知进程 attach。 | 0666 让任何本地用户可读/写订单队列。 | `ipcs -m` 权限 600；非 owner attach 失败。 |

### 10.2 P1：受控运行/移植前

| # | 动作 | 为什么 |
|---|---|---|
| P1-1 | **ZMQ 控制面认证**：CURVE/mTLS + 每策略独立 key + 请求 ID + ACK/重试；至少 bind `127.0.0.1` + 来源白名单。 | 当前无认证、无 ACK，Start/Stop 可能丢/被伪造。 |
| P1-2 | **DataService TLS + RBAC**：只读/交易/风控/管理员角色；禁止共享 `OWN`；登录失败锁定/速率限制。 | 当前登录即可下单；ACL 只有查看位。 |
| P1-3 | **审计日志**：订单/手工单/启停/Lock/配置改动，字段含 actor、timestamp(UTC)、before/after hash、request_id；append-only/集中存储。 | 当前手工单/Lock/配置几乎无痕。 |
| P1-4 | **日志轮转/保留**：按天/大小滚动 + 压缩 + 保留策略；GUI 遥测降级/采样；磁盘/日志告警。 | 9 GB/10 天 + 39 GB leon + 2.4 GB ORS；磁盘满会停交易。 |
| P1-5 | **修 C++ 字符串/越界/未初始化**：C2-C7、U2-U5、`Tokenizer`、`m_account[11]`、`sprintf` 缓冲区；开 `-Wall -Wextra`/ASan。 | `-w` 掩盖了多年 UB；一次超长输入即可崩溃/覆盖。 |
| P1-6 | **线程生命周期**：ZMQ 线程 joinable + stop/close；不 detach；不直接回调 UI 对象；collector 移到工作线程。 | detach + UAF + UI 阻塞。 |
| P1-7 | **修 ZMQ 错误路径**：`status<=0` 直接 continue/close；每轮 `zmq_msg_close`；初始化失败 `exit(1)`；`send` 失败要回传 UI。 | 当前可抛 `length_error`、泄漏、静默丢命令。 |
| P1-8 | **SHM 版本/背压**：magic+version+length、队列满可见、丢包计数、消费者检测；布局用 IDL/生成代码。 | 当前静默错位/丢消息；跨版本不可维护。 |
| P1-9 | **端口/身份固定**：策略端口按 `strategyID` 固定分配，不从“第一个空闲”抢；GUI 用 `strategyID` 而不是 `port` 做行键。 | 重启后行错位，Start/Stop 可能打到别的策略。 |
| P1-10 | **手工单安全**：显式 `OrdType/Duration/PxType`；价格/数量/账户校验；撤单/改单/平仓二次确认 + 回执；`SquareOffAll` 真正双人复核。 | `OrdType` 未初始化可能变市价；撤单无确认；随机码不是授权。 |
| P1-11 | **持仓/成交显示**：按 account/exchange 分行；区分 reject/fill；`Position.csv` 持久化 Group/Mult/Fees；启动对账。 | 当前同 symbol 合并、reject 显示成 fill、改动丢失。 |
| P1-12 | **构建可复现**：固定 gcc/Qt/SDK；CI；制品 SHA256/签名；记录 BuildID 与源码 commit。 | 当前源码/二进制/配置三者漂移，无法证明等价。 |

### 10.3 P2：长期/重写

| # | 动作 | 为什么 |
|---|---|---|
| P2-1 | 用版本化 IPC（共享内存 ring + IDL 或本地 socket）替代裸 SysV SHM；单写者/多读者、背压、权限。 | 降低“0666 + 无版本”的系统性风险。 |
| P2-2 | 订单表改为 `orderID` 主键 + 按 account/strategy 分表；价格索引只做辅助。 | 当前价格主键限制多账户/多合约，迫使 cancel/replace。 |
| P2-3 | 策略语义重实现：control/model parser、指标库、订单状态机、PnL/风控规则；不要搬 GUI/SHM/进程模型。 | 保留业务资产，丢掉 2015 部署约束。 |
| P2-4 | 服务用户 + cgroup/namespace/只读 root；禁止 root 跑交易进程。 | 当前任一 RCE = root。 |
| P2-5 | 配置/模型注册中心：schema、版本、审批、灰度、回滚；禁止原地改。 | 当前 `vim + SIGUSR2` 是主要调参方式。 |
| P2-6 | 可观测性：metrics/tracing、PnL 对账、订单/仓位差异告警、心跳/延迟/丢包。 | 当前靠 `ps/grep` 和 GUI 心跳。 |
| P2-7 | 归档/仿真：CentOS 6.6 VM + Qt 5.3.1 + `/bld`/`/include` + SGIT API；定期恢复演练。 | 确保 5 年后还能打开/解释，而不是“只能看文本”。 |
| P2-8 | 合规/脱敏：日志/配置/截图的秘密扫描；分享前 redact；保留窗口。 | 2015 日志含账户/合约/内网信息。 |

### 10.4 不要复制的东西

| 不要复制 | 原因 | 替代 |
|---|---|---|
| `tcp://*:15213/15300-15333` 明文 ZMQ | 无认证、可伪造、可丢命令 | 认证 ROUTER/DEALER + 每策略 key + ACK |
| `port` 作为策略身份 | 可抢占、重启漂移 | `strategyID` + 固定端口/证书 |
| SysV SHM 0666 | 本机任意用户可读写订单 | 0600 + 单写者 + IDL/版本 |
| `system("... mailx ...")` | 阻塞 tick + root 注入 | 异步告警/本地队列 |
| `exit(1)` 处理风险限额 | 持仓裸奔 | 撤单/平仓/降级/告警，不退出 |
| `assert(0)` in release | abort 裸奔 | 拒绝该笔/对账/告警 |
| cron `pkill -9` | 不撤单/不平仓 | 优雅停机 + 超时兜底 + 对账 |
| 价格主键订单表 | 同价一单、多账户冲突 | orderID 主键 + 价格索引 |
| 全局 `m_simConfig`/`m_orderIDStrategyMap` | 多策略串单 | per-strategy 上下文 |
| 硬编码 `/home/...` + RPATH | 不可重定位 | 配置/环境变量/相对安装根 |
| 手工 CSV 当审计 | 截断/可丢/无 actor | append-only 订单/成交账本 |
| `signal.txt` 白名单当平仓选择 | 过期符号导致 no-op | 显式策略/合约列表 + 校验 |
| 盘中 `vim` + `SIGUSR2` | 无审计/无回滚 | 版本化配置 + 审批/灰度 |
| `MAX_POS_SIZE=1e6`/`CHECK_PNL 0` | 风控事实失效 | 名义金额/保证金/分层限额 |
| Qt4/Qt5.3/GCC4.4/CentOS6 作为平台 | EOL、无补丁、ABI 老 | 现代工具链 + 容器/VM 隔离 |

---

## 11. 证据索引

> 以下命令均在 `$R` 只读执行；未运行任何 ELF。行号以归档文件为准。

| # | 断言 | 命令/文件 | 类型 |
|---|---|---|---|
| E1 | 单机 root + VNC 无 `-localhost` | `2/etc/sysconfig/vncservers:20-21`；`2/etc/ssh/sshd_config:42,64-66` | V |
| E2 | ZMQ bind `*`、detach、无 close、status=-1 | `3/dalong/FromDaya/SkylineFL_GUI/GuiMsgHub.cpp:8,37-38,45-50,74-92` | V |
| E3 | 策略 ZMQ bind `*`、明文命令、无认证 | `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/StrategyMsgHub.cpp:12,26-30,92-111`；`sclock.cpp:251-291` | V |
| E4 | GUI 忽略 send 返回值 | `3/dalong/FromDaya/SkylineFL_GUI/Container.cpp:287-291` | V |
| E5 | SHM 0666 | `3/dalong/infrastructure/Ipc/include/shmmanager.h:245,260,300,308,456` | V |
| E6 | ORS 先 ipcrm、不杀旧进程 | `3/infra/prod/scripts/runORS_extreme_new.sh:1-10` | V |
| E7 | ORS SGIT、CTP 注释 | `2/bld/build_dev_multi.20150330_1447/China/build.py:39-66` | V |
| E8 | RMS 检查/注释 | `3/infra/prod/config/rms/prod.china.rms.xml:2-9,23-46` | V |
| E9 | DataService 登录不检查 read；bool 未初始化 | `3/dalong/infrastructure/TradingSystemsGUI/DataCollector.cpp:96-101`；`loginreplymessage.h:23-46` | V |
| E10 | ACL 只有查看位 | `3/infra/dataservice_deploy/accesscontrol.xml:1-37` | V |
| E11 | GUI 硬编码默认凭据 | `3/dalong/infrastructure/TradingSystemsGUI/ConnectionDetails.h:17-18` | V |
| E12 | 明文保存会话 | `3/dalong/infrastructure/TradingSystemsGUI/ConnectDialog.cpp:88-96,176` | V |
| E13 | 手工单无字段日志、无确认 | `3/dalong/FromDaya/SkylineFL_GUI/ContractWidget.cpp:117-141,281-298` | V |
| E14 | Lock 不打日志 | `3/dalong/FromDaya/SkylineFL_GUI/Strategy.cpp:258-272` | V |
| E15 | TradeBot GMT 日志 | `3/TradeBot/TradeBot_China/main/main.cpp:428-431`；`04 §2.5` | V |
| E16 | 信号语义/`signal.txt` | `3/TradeBot/TradeBot_China/main/main.cpp:90-164`；`Config/signal.txt` | V |
| E17 | cron `pkill -9` | `2/var/spool/cron/root:8-10,17-20` | V |
| E18 | pid 路径少 `_China` | `3/TradeBot/TradeBot_China/main/main.cpp:683-690` | V |
| E19 | `m_simConfigList[100]` + symbolID | `3/TradeBot/TradeBot_China/main/include/TradeBotUtils.h:657,685`；`main.cpp:1041-1055`；`CommonClient.cpp:424,443` | V |
| E20 | `interestlist[50][50]` + strcpy | `3/TradeBot/TradeBot_China/main/main.cpp:860,884` | V |
| E21 | `LoadControlList` 无上限 | `3/TradeBot/TradeBot_China/main/TradeBotUtils.cpp:1662-1669` | V |
| E22 | `Tokenizer` 无界 | `3/TradeBot/TradeBot_China/common/Tokenizer.cpp:4-14` | V |
| E23 | control 字段 strcpy 到定长 | `3/TradeBot/TradeBot_China/main/TradeBotUtils.cpp:1701-1717`；`TradeBotUtils.h:570-578` | V |
| E24 | `system()` + modelFile | `3/TradeBot/TradeBot_China/main/CommonClient.cpp:392-394`；`main.cpp:623-624` | V |
| E25 | exit(1)/assert/阈值翻倍 | `3/TradeBot/TradeBot_China/Strategies/ExecutionStrategy.cpp:308,945,1981-1984,2170-2189` | V |
| E26 | 非虚 HandleSquareoff | `Strategies/include/ExecutionStrategy.h:43`；`Strategies/include/ButterflyStrategy.h:36` | V |
| E27 | 手工单 OrdType 缺失 | `3/dalong/infrastructure/DataService/include/order.h:58-63`；`GuiUtils.h:77-95`；`PlaceOrderWidget.cpp:177-207` | V |
| E28 | GUI 阻塞 collector | `DataCollector.cpp:43-56,96-101`；`Container.cpp:39-40,262-285` | V |
| E29 | 端口“第一个空闲” | `3/leon/CL/StrategyLeon/cfgField.cpp:687-735` | V |
| E30 | GUI 34 槽/15213 | `3/GUI/SH/GuiSettings.xml:7,18-291` | V |
| E31 | 2 vs 3 同字节 | `diff -rq 2/TradeBot 3/TradeBot`（无输出）；`00 §9.1` | V |
| E32 | SVN 四代 | `3/TradeBot/TradeBot_China/.svn/entries`；`00 §4.2` | V |
| E33 | GUI 无 VCS | `3/dalong/FromDaya/SkylineFL_GUI` 无 `.git/.svn`；`03 §1.4` | V |
| E34 | 部署 GUI 与源码同源 | 日志行号 `Container.cpp:59`、`GuiMsgHub.cpp:85`；`03 §6.2` | V/I |
| E35 | 源码/二进制漂移 | `05 §7.1`；`00 §5.6` | V/I |
| E36 | 现代对比 | `quantlink-trading-architecture/01-system-architecture.md`、`08-security-gaps.md` | V（该档案） |

### 11.1 本次新增/修正的证据

- **`LoadArgMap` 返回值**：`main.cpp:2241-2265` 在缺少 value 时仍 `return true`，不是 `02 §R14` 说的“直接 false”。影响：拼错参数更隐蔽，按默认值跑。【V】
- **`DataCollector::LogIn` 未初始化 bool**：`loginreplymessage.h:25` 的 `bool m_loginAuthenticated;` 无默认值，`DataCollector.cpp:99` 不检查 `read` 返回；这是 `03` 未列出的**认证绕过/崩溃**风险。【V/I】
- **`LoginCommand::setPassword` 无长度检查**：`logincommand.h:55-58` 的 `strcpy` 到 `char[20]`；长口令可栈溢出。【V】
- **`accesscontrol.xml` 只有查看位**：`03/04` 提到 ACL，但没有指出“没有下单/撤单权限位”；这是授权模型的核心缺口。【V】
- **`receive.sh` 不存在**：只有 `receive_new.sh` 与 `receive.shBak`；口述的“receive.sh”是回滚后的名字。【V】
- **`runORS_extreme_new.sh` 的 `LD_LIBRARY_PATH` 指向 `/home/piyush`**：跨用户依赖，缺目录可能加载失败。【V/I】
- **`Container::sendToStrategy` 忽略 send 失败**：控制命令可能静默丢失。【V】

---

## 12. 未决问题（需要人/外部输入）

1. **这台机器在 2015 年是否真的以“无防火墙 + 公网 VNC”运行？**
   证据：`iptables` 配置只放行 22，但 `boot.log` 没有启动记录，VNC 日志有外部客户端；`vncservers` 没有 `-localhost`。需要原机器的 `service iptables status`、`ss -lntp`、`/var/log/secure` 才能定论。若是，则 2015 年存在“公网 root 桌面”这一最高风险。【V/I】

2. **线上 TradeBot 二进制到底对应哪份源码？**
   二进制 6/17、r2375 6/10；`.bash_history` 显示 6/10 后还在改 `ExecutionStrategy.cpp`/`AggressiveStrategy.cpp`。没有 build log/diff；需要反汇编/符号对比或找到当时的构建机，才能知道线上行为与 r2375 的差异。【V/I】

3. **7/24 实际跑的是 `mdreceiverX` 还是 `mdreceiverX_bothfeeds`？**
   cron 指向 `receive_new.sh`→`mdreceiverX`（6/2 单 feed），但 `receive.shBak`→`bothfeeds`（2/11 双 feed）的存在说明发生过回滚；日志不记录 BuildID。需要当时进程的 `/proc/<pid>/exe`/md5 或操作员确认。【V/I】

4. **`symbolID` 在生产中是否始终 <100？**
   `m_simConfigList[100]`/`m_instruList[100]` 用 `symbolID` 无界索引；是否越界取决于 Connector/xsim 的分配规则（按订阅顺序/全市场位置）。需要 `ConnectorConfig::INTERESTED_SYMBOLS` 的 owner 确认，或在隔离环境打印最大 `symbolID`。这是最可能“潜伏但致命”的内存破坏。【V/I】

5. **手工单的 `OrdType` 未初始化时，ORS 实际按什么处理？**
   代码路径确定没有设置 `OrdType`；线上手工单 CSV 有 `TRADE_CONFIRM`，说明用过。是 ORS 对 0/垃圾值默认限价，还是默认市价？需要 ORS 的 `ManualOrderCommand` 处理代码或一次抓包。若默认市价，手工单风险远高于操作员认知。【V/I】

6. **TradeBot 重启后的仓位对账流程是什么？**
   ORS 启动会读 `position.csv`；TradeBot 不读。是靠人工先平仓，还是靠 ORS 拒绝重复仓位？这决定了这套系统能否安全重放/迁移。【V/I】

7. **`Config/signal.txt` 的 NIFTY 符号是“忘了改”还是“故意保留”？**
   `SIGTERM` 对 GOLD 不生效；如果操作员一直用 `SIGTSTP`/`37`，这可能只是无害遗留；如果有人用 `SIGTERM` 当全平，就是事故。需要当时的 stop 脚本/操作员确认。【V/I】

---

### 附：一句话运维口诀（仅用于理解历史，不是推荐）

> **网关先起，持仓先拉；ORS 再起，行情随后；策略最后，GUI 随意；平仓用 TSTP，杀进程用 -9；改脚本先改 cron，删 SHM 先杀进程。**

> 但本文的结论是：**这套口诀里“杀进程用 -9”“GUI 随意”“改脚本先改 cron”三条，正是 2015 系统最不安全的部分；复刻时不要照抄。**

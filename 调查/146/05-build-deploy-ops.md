# 05 — 构建、部署与运维：2015 原始 TradeBot 系统

> 对象：`/Volumes/DevDisk/146`（下文 `$R`）。`$R/2` = CentOS 6.6 根文件系统，`$R/3` = 同一台机器的 `/home` 数据盘。
> 范围：主机/OS、工具链、构建、部署布局、启动顺序、停机/重载、日常运维、源码与二进制漂移、沙箱复刻 runbook。
> 方法：只读 `ls/stat/file/strings/md5/diff/du/grep/git`；**未复制、未修改、未运行任何 ELF**。
> 证据标记：**V** = 直接读到文件/命令输出并给 `file:line`；**I** = 由结构、时间戳、日志、二进制字符串推断；**P** = 计划/假设，无法在本次验证。
> 本文不含口令、密钥、账号号；涉及凭据只记位置。内网/公网地址仅用于定位，按需脱敏。

---

## 0. 一页结论

| # | 结论 | 证据 |
|---|---|---|
| 1 | 这是一台 **48 vCPU / 32 GB / CentOS 6.6 / kernel 2.6.32** 的单机，不是集群；`/` 约 50 GiB、`/home` 约 78 GiB。 | 【V】`2/var/log/dmesg:272,307,401`；`2/var/log/boot.log:10-12` |
| 2 | `2/` 是根盘，`3/` 是 `/home`；`2/home` 为空。要复刻必须把 `3/` 挂/拷成 `/home`，并从 `2/` 取 `/bld`、`/include`、`/usr/local/lib/libsnappy.a`、`/usr/share/API`。 | 【V】`2/etc/fstab:9-12`；`2/etc/mtab:1,7`；`2/home` 空 |
| 3 | 生产启动是 **root crontab 驱动**，不是 systemd：07:15 网关 → 08:10 拉持仓 → 08:11 ORS → 08:55 行情接收 → 08:56 策略；晚上 19:15/20:20/20:21/20:55/20:56 再来一遍；15:05 与 02:35 `kill -9`。 | 【V】`2/var/spool/cron/root:5,7,13-16,17-20`；`2/var/log/cron:1721,1726,1727,1872,1877,1878` |
| 4 | 依赖顺序是：**本地网关 → ORS → 行情接收机 → 策略**；DataService 在 ORS 之后（若要读 CME 的 10201，则还需行情接收机）、GUI 之前；GUI 可以早于策略，但不能早于 DataService。 | 【V】`connector.cpp:62,70,75,80`；`shmmanager.h:256-265`；日志时序 |
| 5 | 构建是四套并行体系：TradeBot `Makefile`（g++ 4.4.x + `/bld`/`/include`）、infrastructure `SCons`（git `DEV`）、Qt5 `qmake`、Qt4 `qmake`；没有统一 CI，也没有锁版本。 | 【V】`main/Makefile:5,9-12`；`SConstruct:339-347`；`SkylineFL_GUI.pro:18-31` |
| 6 | 源码与运行态有实质漂移：TradeBot 二进制 6/17 晚于源码 r2375 6/10；线上 GUI 是 2014-12-21，源码树 2015-03-19 的构建从未部署；ORS 二进制 4/26，配置 7/13。 | 【V】`main/TradeBot` mtime/BuildID；`GUI/SH/SkylineFL_GUI`；`prod.china.ors_new.cfg` |
| 7 | 停机基本是 **按进程名 `kill -9`**；`main.cpp` 的 pid 文件路径已漂移，实际不存在，不能依赖。 | 【V】`main.cpp:683-689`；`/home/TradeBot/TradeBot/data/` 不存在 |
| 8 | 运维很“手工”：VNC root 直连、应用日志无轮转、GUI 单日 386–588 MB、`/home/leon/log` 39 GB；没有应用级监控/告警。 | 【V】`2/etc/sysconfig/vncservers:20-21`；`du -sh` |
| 9 | `receive_new.sh` 与 `receive.shBak` 是**一次回滚的痕迹**；两个脚本的 `taskset -c -p ...` 都不是标准 util-linux 用法，不能按字面得到“在 CPU N 上启动”。 | 【V】`3/re/receive_new.sh:1`；`3/re/receive.shBak:1`；`2/bin/taskset` strings |
| 10 | 沙箱复刻不要启动真实 ORS/网关/`reqPos`；用 DataService 空跑 + Sim 模式 + 自写 SHM stub 分层验证。 | 【P】本文 §8 |

一句话：**这是一套“cron + VNC + 手写脚本 + SysV SHM”的 2015 年单机交易栈；能跑，但启动顺序靠人、停机靠 `kill -9`、状态靠柜台和 ORS 的 `position.csv`，没有任何自愈能力。**

---

## 1. 主机、OS、工具链

### 1.1 硬件与 OS

| 项 | 值 | 证据 |
|---|---|---|
| 发行版 | CentOS release 6.6 (Final) | 【V】`2/etc/issue:1` |
| 内核 | `2.6.32-504.1.3.el6.x86_64`，2014-11-11 构建 | 【V】`2/var/log/messages:35` |
| CPU | 48 逻辑 CPU（`SMP: Allowing 48 CPUs`，`Brought up 48 CPUs`） | 【V】`2/var/log/dmesg:272,401` |
| 内存 | 约 32 GB（`Memory: 32801508k/34586620k available`） | 【V】`2/var/log/dmesg:307` |
| 主机名 | `685` | 【V】`2/etc/sysconfig/network:2` |
| 时区 | `Asia/Shanghai` | 【V】`2/etc/sysconfig/clock` |
| 运行级 | 5（图形） | 【V】`2/etc/inittab:26` |
| SELinux | disabled | 【V】`2/etc/selinux/config:7` |
| 最后开机 | 2015-07-20 08:30（此前 08:25 init 收到 TERM，发生一次重启） | 【V】`2/var/log/messages:20-38` |

**磁盘/LV**（`2/etc/fstab:9-12`，【V】）：

| LV | 挂载点 | 大小（块数 × 4K） | 说明 |
|---|---|---|---|
| `VolGroup-lv_root` | `/` | 13,107,200 ≈ 50 GiB | 系统 + `/bld` + `/include` + `/opt` |
| `VolGroup-lv_home` | `/home` | 20,546,560 ≈ 78 GiB | 全部交易源码/运行数据/日志 |
| `VolGroup-lv_swap` | swap | — | — |
| `/dev/sda1` | `/boot` | 512,000 ≈ 2 GiB | — |

> `2/` 实际文件约 17 GB，`3/` 约 58 GB；开机时 `/home` 已用约 30 GB（`boot.log:12`），之后 7/21–7/24 又产生大量 GUI/策略日志。**不要用 `du` 数字直接推算剩余空间**。

### 1.2 `/home` 布局（部署的“根”）

`3/` 顶层就是 `/home`：

| 路径 | 角色 | 证据 |
|---|---|---|
| `/home/TradeBot/TradeBot_China` | TradeBot 源码 + 构建目录（SVN r2375） | 【V】`.svn/entries` |
| `/home/TradeBot/{controls,models,log,livescripts,bckp}` | 运行配置、模型、日志、启动脚本、昨日备份 | 【V】目录 + `CopyControlsModels` |
| `/home/infra/prod/{bin,config,scripts,log}` | ORS 二进制/配置/脚本/日志 | 【V】`runORS_extreme_new.sh` |
| `/home/infra/dataservice_deploy` | DataService 二进制 + XML + 日志 | 【V】`runDataService.sh` |
| `/home/infra/TradingSystemsGUI` | Qt4 旧 GUI 运行态 | 【V】`runGUI.sh` |
| `/home/re` | CME 行情接收机 + 配置 + 录制日志 | 【V】`receive_new.sh` |
| `/home/GUI/SH` | Qt5 SkylineFL_GUI 部署态（自带 Qt5/ZMQ） | 【V】`runChinaGui.sh` |
| `/home/dalong/{Qt5.3.1,infrastructure,FromDaya/SkylineFL_GUI}` | Qt5 SDK、infra 源码、GUI 源码/本机构建 | 【V】`.pro`/`Makefile` |
| `/home/leon/{CL,bin,log,pyScripts}` | 2015-07 实际在跑的另一套策略（SHStrategy_new） | 【V】`startAll_new2.sh` |
| `/home/jfs/linux-64bin/{quotgate,tradegate}` | 本地柜台网关（7776/7777） | 【V】`startfs` |
| `/home/piyush/ORS_CHINA_extreme/log/position.csv` | ORS 唯一持久化持仓文件 | 【V】ORS cfg `POSITION_FILE` |

**用户**：`2/etc/passwd` 只有 `jfs:500`、`TradeBot:501`、`Midas:502`、`leon:503`；`dalong`、`piyush`、`punit` **不是本机用户**，他们的目录是从别的机器拷来的（`3/dalong`、`3/piyush`）。这解释了 GUI 的 RPATH 为什么指向 `/home/dalong/Qt5.3.1` 却在本机不存在。

### 1.3 网络

`2/etc/sysconfig/network-scripts/` 是多网卡静态配置（【V】各 `ifcfg-eth*:8`）：

| 网卡 | 角色 | 备注 |
|---|---|---|
| `eth0` | 管理/公网 | `222.72.161.42/27`，`ONBOOT=yes` |
| `eth4` | 第二公网/默认网关 | `222.71.161.22/26`，`GATEWAY=222.71.161.12` |
| `eth10` | 行情专线 | 地址与 `cme.recv.quincy.data.cfg:18` 的 `Host` **同址**；接收机 bind UDP 12345 |
| `eth11` | 内网 | `172.16.1.91/28`；`route-eth11` 把 `192.168.11.0/24`、`192.168.12.0/24` 指向 `172.16.1.94` |
| `eth1/2/3/5/6/7` | 未启用/历史 | `boot.log:21-24` 报 `eth0/eth1 does not seem to be present`，说明重启后网卡命名发生变化 |

**关键路径**：

- 行情：上游 → `eth10` → `mdreceiverX` 绑 `0.0.0.0:12345` → SHM `10201`。
- 交易：`china_ors_extreme_new` → `tcp://127.0.0.1:7776`（tradegate）/`7777`（quotgate）→ 券商 FENS/交易/行情前置（`192.168.12.0/24`）。
- 本地控制面：DataService `20000`、stream `1732/1733`、GUI ZMQ `15213`、策略 `15300–15333`。
- **没有 NFS**：`/etc/fstab` 无 nfs/cifs；`/etc/exports` 为空；`autofs` 只有默认 `/net`、`/misc` 且未使用。跨机交换靠 `scp`/tar（`2/root/.bash_history:592` 有 `scp ... leon@...`）。

> 防火墙配置 `2/etc/sysconfig/iptables:10-11` 只放行 22，但 `boot.log` 没有 “Starting iptables”，`rc3.d` 符号链接又被备份裁掉；而 VNC 日志里确有外部客户端连入。**推断：iptables 实际未启用，VNC 5901 直接暴露。**【I】

### 1.4 工具链 / Qt / 库

| 组件 | 位置/版本 | 用途 | 证据 |
|---|---|---|---|
| gcc/g++ | 驱动字符串 `4.4.7 20120313`；`libexec` 下是 `4.4.4` 的 `cc1plus`；`libstdc++.so.6.0.13` | TradeBot/ORS/GUI 构建 | 【V】`strings 2/usr/bin/gcc`；`2/usr/libexec/gcc/.../4.4.4/cc1plus` |
| make | GNU make（`2/usr/bin/make`） | Makefile | 【V】 |
| SCons | 2.2.0 | infrastructure/ORS/MD | 【V】`2/usr/bin/scons` |
| Python | 2.6.6 | SCons、`SetAffinity.py`、`reqPosition` 周边 | 【V】`2/root/install.log` |
| Qt 4.6.2 | 系统 `/usr/lib64/libQtCore.so.4.6.2` + `/usr/include/Qt*`；**无 qmake** | 旧 GUI 的兜底 ABI | 【V】`ls` |
| Qt 4.8.6 | 只在 `3/infra/TradingSystemsGUI/*.so.4.8.6`，无 SDK | 旧 GUI 运行库 | 【V】`ls` |
| Qt 5.3.1 | `/home/dalong/Qt5.3.1/5.3/gcc_64`；官方构建 `GCC 4.6.1` | **唯一实际使用的 Qt5** | 【V】`InstallationLog.txt:1`；`libQt5Core.so.5.3.1` |
| Qt 5.3.2 | `2/opt/Qt5.3.2`；安装日志 2012-09-15，内部串 2014-09-11 | **未发现任何产物依赖 → 不要用** | 【V】`InstallationLog.txt:1`；`strings` |
| snappy | `2/usr/local/lib/libsnappy.a` 1.1.3；`/usr/lib64/libsnappy.so.1.1.4` | xsim/MD 压缩 | 【V】`ls` |
| ZeroMQ | 头/静态库 4.0.5（`2/usr/local`）；GUI bundle 运行库 3.2 ABI（`libzmq.so.3.1.0`） | GUI/策略控制面 | 【V】`zmq.h:32-34`；`strings` |
| 券商 API | `2/usr/share/API/{sgit,sfit,CTP_20140811}` | ORS/网关重建 | 【V】`ls` |
| VS2010 | Windows 侧 legacy | 非生产路径 | 【V】`Tradebot.sln:2-3` |

> **编译器不是单一版本**：镜像里 `4.4.4/4.4.5/4.4.6/4.4.7` 的 `.comment` 都能在产物里找到（`strings ... | grep 'GCC:'`）。这意味着“用同一 gcc 重编”本身就不成立；复刻时以**能链接**为准，不要追求字节级一致。

### 1.5 CPU 亲和与 VNC/X

**CPU 亲和的实际做法**（48 核，见 §1.1）：

| 进程 | 方式 | 核 | 证据 |
|---|---|---|---|
| `quotgate`/`tradegate` | `SetAffinity.py` 按 CPU 时间分配 | 33–35,40–42 / 43–47 | 【V】`3/leon/pyScripts/SetAffinity.py:68-69` |
| ORS 线程 | 配置文件内部 `sched_setaffinity` | logger/stats/reqresp=0，SHM_REQ=1，CHINA_MD=2，CHINA_RESP=3 | 【V】`prod.china.ors_new.cfg:48-53`；`cmd.ors_20150724:3,27,33,36` |
| DataService stream/service | `taskset -c 0/1` | 0/1 | 【V】`runDataStream_CTP.sh:1`；`runDataService.sh:1` |
| GUI（Qt5） | `taskset -c -p 7` | 7 | 【V】`runChinaGui.sh:2`（**语法可疑**） |
| GUI（Qt4） | `taskset -c 15` | 15 | 【V】`runGUI.sh:4` |
| TradeBot | `taskset -c 21/29` | 21/29 | 【V】`RunStrategies.sh:13`；`RunStrategies_noon.sh:6` |
| leon 策略 | `taskset -c 7,8` | 7,8 | 【V】`newBB_new2.sh:18` |
| MD 接收机 | `taskset -c -p 5,6` / `8` | 5,6 / 8 | 【V】`receive.shBak:1`；`receive_new.sh:1`（**语法可疑**） |

> **`taskset -c -p N cmd` 不是标准 util-linux 用法**。标准写法是 `taskset -c N cmd`（启动新进程）或 `taskset -cp N PID`（改已有进程）。`-p` 是“对已有 PID 操作”，`-c` 是“按 CPU list 解释”；`taskset -c -p N cmd` 会把 `-p`/`N` 当成 list 或 PID，**不会执行后面的 `cmd`**。镜像里的 `/bin/taskset` 是标准 util-linux（strings 有 `failed to parse CPU list`）。因此 `runChinaGui.sh`、`receive_new.sh`、`receive.shBak`、`SetAffinity.py:41` 这几处**按原文执行不会得到预期效果**。但日志又证明 GUI/接收机确实启动过 → 实际执行路径与归档脚本不完全一致（人工绕过、旧版脚本、或别的 wrapper）。【V/I】

**VNC / X**：

- `2/etc/sysconfig/vncservers:20-21`：`VNCSERVERS="1:root"`，`VNCSERVERARGS[1]="-geometry 800x600 -nolisten tcp"`。
- `2/root/.vnc/xstartup:30`：`gnome-session &`；没有 GUI 自启动项。
- `boot.log:53-57`：开机启动 VNC `:1`。
- `Xorg.0.log`、`Xorg.2–5.log` 都有 2015-07-20 的记录；GUI 实际显示在 VNC/本地 X 上，分辨率只有 800×600（34 行策略表会很挤）。
- 没有 `~/.config/autostart` 里的交易 GUI；GUI 是操作员进 VNC 后手动拉起的（见 §6.3）。

---

## 2. 构建

### 2.1 源码树与构建单元

| 源码树 | 构建系统 | 产物 | 说明 |
|---|---|---|---|
| `3/TradeBot/TradeBot_China` | 顶层 `Makefile` + 4 个子目录 `Makefile` | `main/TradeBot`、`watchMarket`、`get_symbol_on_date`、`startDataServer` | 生产策略引擎；SVN r2375 |
| `3/dalong/infrastructure` | `SConstruct` + `Makefile`（SCons） | `bin/<mode>/<project>/...`、`*.a`/`*.so` | Connector/Ipc/Logger/DataService/China 等 |
| `2/bld/build_dev_multi.20150330_1447` | 同一套 SCons + `build.py` | `bin/release/<project>/...` | 2015-03-30 的 infra 全量源码/构建快照 |
| `3/dalong/FromDaya/SkylineFL_GUI` | qmake 3.0 / Qt 5.3.1 | `SkylineFL_GUI` | Qt5 前端源码 + 本机构建 |
| `3/dalong/infrastructure/TradingSystemsGUI` | qmake / Qt4+Qt5 双兼容 | `TradingSystemsGUI` | 旧 GUI 共享控件层 |
| `3/dalong/Qt5.3.1` | 官方安装包 | Qt5 SDK | 仅构建期需要 |

### 2.2 TradeBot Linux 构建

顶层 `Makefile`（【V】`3/TradeBot/TradeBot_China/Makefile:1-16`）：

```make
ll:
	cd common;      make DEBUG=$(DEBUG) LOGGER=$(LOGGER) VOLTHREAD=$(VOLTHREAD) ORDER=$(ORDER)
	cd Indicators;  make ...
	cd Strategies;  make ...
	cd main;        make ...
clean: ...
debug: ...
```

`main/Makefile` 的关键点（【V】）：

| 行 | 内容 | 影响 |
|---|---|---|
| `:5` | `INFRAPATH=/include/illuminati/dev_multi` | 头文件必须放在 `/include`（来自 `2/include`） |
| `:9` / `:12` / `:16` | `-L/bld/dev_multi`、`-lconnectormwmr -llogger -lxsim -ldatamanip -lcommonutils -lrt /usr/local/lib/libsnappy.a ... -lxsimdataserver` | 静态库必须放在 `/bld`（来自 `2/bld`） |
| `:15` | `-std=c++0x -O3 -w -D_GLIBCXX_USE_SCHED_YIELD -DGCC_44 -DUSE_MWMRQ_{REQ,RESP,MD}SHM` | C++11 子集；`-w` 关闭所有警告 |
| `:12` | `../Strategies/*.o` | **通配链接**：改完策略不 `make clean` 会把旧 `.o` 链进去 |
| `:47-60` | 四个 `SOURCES` 组 | 同一套对象产出 4 个可执行 |

实际生产命令（`3/TradeBot/.bash_history:4-5,47-48`）：

```bash
cd /home/TradeBot/TradeBot_China
make clean
make -j LOGGER=1
```

`LOGGER=1` 会加 `-DLOGGER -DORDER`（`main/Makefile:23-24`），这是生产日志格式的前提；不带它则是 `-DPRINTIND`。

**构建陷阱**：

1. 所有路径都是绝对 `/include`、`/bld`、`/usr/local/lib`；源码树放在 `/home/TradeBot/TradeBot_China` 才能直接编。
2. `main/command.txt:1` 和 `main/runTradeBot.sh:2-3` 的示例命令**都没有 `--configFile`**；照抄会在 `main.cpp:414-426` 直接 `exit(1)`。
3. 顶层 `make ll` 是串行 `cd ...; make`，没有 `-j`；生产用 `make -j` 在 `main` 里并发。
4. 没有 `install` target，也没有版本号写入二进制；只能靠 BuildID/mtime 区分。

### 2.3 TradeBot VS2010（legacy，不是生产路径）

`3/TradeBot/TradeBot_China/Tradebot.sln`：

- 【V】`:2-3` `Format Version 11.00` / `# Visual C++ Express 2010`。
- 【V】`:4` 只有一个工程 `Tradebot`；`:8-9` 只有 `Debug|Win32`、`Release|Win32`，**没有 x64**。
- 【V】`Tradebot.vcxproj:49` include 全部是 `D:\shiva\TradeBot_Russia_Code\...`；`:61` 链接 `pthreadVC2.lib`（pthreads-w32）。
- 【V】`UpgradeLog.XML:3,5,9-13`：2012-12-22 从 `D:\shiva\TradeBot_Russia_Code\...\Tradebot.vcproj` 升级到 VS2010。

结论：这是 **Windows 历史分支**（代码祖先 `TradeBot_Russia`），只用于阅读/对照；Linux 生产用 Makefile。不要试图在 Windows 上跑 Live（`CommonClient` 的 Windows 信号分支直接返回，见 02 §2.4）。

### 2.4 infrastructure：SCons + git

`3/dalong/infrastructure`（【V】）：

- `SConstruct:41-64` 的 `PROJECT_LIST` 包含 `Logger/SysUtils/CommonUtils/Networks/Ipc/RMS_NEW/Connector/China/...`。
- `SConstruct:339-347`：`mode=debug|release`；`project=<name>` 时把 `PROJECT_LIST` 替换为单项目。
- `SConstruct:69-70`：构建根 `../.build_<mode>`，目标 `../bin/<mode>/<project>`。
- `Makefile:1-7`：`make release` = `scons -j10 mode=release`；`make all` = debug+release。
- git：HEAD `6efe348f 2014-10-27 Salil "RMS bugfix"`，分支 `DEV`，remote 是内网 `ssh://...:2727/opt/git/infrastructure.git`；`git status --porcelain` **1287 项**（厂商 SDK 头/`.so` 被改）。【V】
- `bin/debug` 为空，`bin/release` 只有一个 2014-10-20 的 `china_ors`；**源码树里的二进制不能当运行态**。【V】
- 镜像里**没有 `svn`/`git` 客户端**（`find 2 -name svn/git` 空）；`TradeBot/.bash_history` 里的 `svn up` 是在别的机器/更早环境执行的。【V/I】

**构建示例**（【V】`2/bld/build_dev_multi.20150330_1447/China/Makefile:1-7`、`MDReceiverX/Makefile:1-7`）：

```bash
cd /bld/build_dev_multi.20150330_1447/China
make release          # => cd ..; scons -j5 mode=release project=China
# 产物：../bin/release/China/china_ors_extreme

cd ../MDReceiverX
make release          # => scons -j2 mode=release project=MDReceiverX
# 产物：../bin/release/MDReceiverX/mdreceiverX
```

> **不要只跑 `scons mode=release`**：`build_dev_multi.20150330_1447/SConstruct:41-64` 的默认 `PROJECT_LIST` 只有库（`Connector`/`China`/`MDReceiverX` 都被注释掉），全量构建不会编出 ORS/MD。必须带 `project=`。

### 2.5 ORS / MDReceiverX 的构建细节

`2/bld/build_dev_multi.20150330_1447/China/build.py`：

- 【V】`:39-51` 的 `china_ors_ctp` 整段被 `'''...'''` 注释掉；`:56-66` 的 `china_ors_extreme` 是**活动目标**。
- 【V】`:57` `BINARY_NAME='china_ors_extreme'`；`:63` 链接 `pthread/commonutils/rmschecks/logger/rt`；`:65` `-Wl,/usr/share/API/sgit/libsgitquotapi.so.64,/usr/share/API/sgit/libsgittradeapi.so.64`。
- 这说明 **2015 生产 ORS 走 SGIT/上海期货柜台，不是 CTP**；CTP 是旧分支。`3/infra/prod/bin/china_ors_ctp`（2014-12-04）只是遗留二进制。

`MDReceiverX/build.py`：

- 【V】`:61` 默认 `mdreceiverX`；`:75` `mdreceiverX.seqnumenabled`；`:90` `mdreceiverX.snapshot.seqnumenabled`；`:105` `mdreceiverX.oldpricequantenabled`。
- 【V】`:18-25` 链接 `pthread/rt/logger/networks/snappy/commonutils/syssighandler`；release 还加 `-D_USE_LZ4`（`:53`），但产物里没有 LZ4 符号，实际可能未启用。
- 这解释了 `/home/re` 为什么会有 `mdreceiverX`、`mdreceiverX_bothfeeds`、`mdreceiverX20150602` 三个近亲。

### 2.6 DataService 构建

源码在 `3/dalong/infrastructure/DataService`，产物是 `3/infra/dataservice_deploy/dataservice`。本次没有逐行核对它的 `build.py`（**P**），但部署目录里有 5 个历史版本：

| 文件 | 大小 | mtime | BuildID |
|---|---|---|---|
| `dataservice` | 1,133,207 | 2014-09-30 | `ebb2a27f…` |
| `dataservice_orig` | 1,130,321 | 2014-09-18 | `38f1de3f…` |
| `dataservice_orig_dalong` | 1,130,353 | 2014-09-22 | — |
| `dataservice.old` | 1,133,346 | 2014-09-26 | `17873359…` |
| `dataservice.Old_1` | 1,115,703 | 2014-09-11 | — |

`restartNew.sh` 引用的 `dataservice.ChinaNew` **不存在**（【V】`ls`），所以这个“新版重启脚本”按原文不能工作。

### 2.7 Qt5 SkylineFL_GUI

`3/dalong/FromDaya/SkylineFL_GUI/SkylineFL_GUI.pro`（【V】）：

- `:3` QtCreator 创建于 2014-08-08。
- `:9` `greaterThan(QT_MAJOR_VERSION, 4): QT += widgets`。
- `:13-16` `-std=c++0x -D_GLIBCXX_USE_SCHED_YIELD -D_GLIBCXX_USE_NANOSLEEP -DSHOW_TRADES`。
- `:18-26` `INCLUDEPATH` 全部指向 `$$(HOME)/infrastructure/...`。
- `:28-29` `LIBPATH += /usr/local/lib /usr/lib $$(HOME)/infrastructure/bin/debug`；`LIBS += -lzmq -llogger -lcommonutils`。
- `:31` `INFRA = $$(HOME)/infrastructure/TradingSystemsGUI`。
- `:52-58` 直接编译 `$$INFRA/{MDCollector,PNLCollector,ManualOrderSender,PlaceOrderWidget,DataCollector,OrdersCollector,SquareOffAllDialog}.cpp`。

`Makefile`（【V】）：

- `:3-5` `Generated by qmake (3.0) (Qt 5.3.1)`；命令 `/home/dalong/Qt5.3.1/5.3/gcc_64/bin/qmake -o Makefile SkylineFL_GUI.pro`。
- `:20` `-Wl,-rpath,/home/dalong/Qt5.3.1/5.3/gcc_64`。
- `:21` `-L/home/dalong/infrastructure/bin/debug -lzmq -llogger -lcommonutils ...`。
- `:44` `OBJECTS_DIR = ./`；目录里没有 `.o`，不能增量链接。

**重建命令**（【P】，未执行）：

```bash
export HOME=/home/dalong
cd /home/dalong/FromDaya/SkylineFL_GUI
/home/dalong/Qt5.3.1/5.3/gcc_64/bin/qmake -o Makefile SkylineFL_GUI.pro
make -j4
```

前提：`/home/dalong/infrastructure/bin/debug` 里要有 `liblogger.a`/`libcommonutils.a`；实际为空，所以要么先 `scons mode=debug`，要么把 `LIBPATH` 指到 `2/bldBak/dev_multi_20141127_2011`。

### 2.8 Qt4 TradingSystemsGUI

`3/dalong/infrastructure/TradingSystemsGUI/TradingSystemsGUI.pro`（【V】）：

- `:3` 创建于 2014-01-29。
- `:9` Qt5 时加 `widgets`，否则 Qt4。
- `:32-57` 编译旧主窗 `Mainwindow.cpp`/`ExchangeWidget.cpp`、4 个 collector、4 个 model、`MarketData*`、`TableView`、`PlaceOrder*`、`CancelModifyOrderWidget`、`SquareOffAllDialog`。
- `VersionHeaders.h:4-12` 用 `QT_VERSION` 切 `setSectionResizeMode/setResizeMode`、`setSectionsMovable/setMovable`；`:14-18` 还兼容 Qt < 4.7。

运行态在 `3/infra/TradingSystemsGUI`：二进制 2014-09-26，Qt4.8.6 库随包，`runGUI.sh:2-4` 设 `LD_LIBRARY_PATH=.` + `taskset -c 15`。**缺 `libQt*.so.4` 符号链接**，按原样不能独立启动；`2/GUI/TradingSystemsGUI.tar.gz` 里有符号链接。

### 2.9 构建产物 → 运行目录

| 产物 | 构建树 | 部署位置 | 备注 |
|---|---|---|---|
| `china_ors_extreme_new` | `2/bld/build_dev_multi.20150330_1447/China` | `3/infra/prod/bin/` | 4/26，BuildID `beaa7b6d…` |
| `mdreceiverX` | `2/bld/.../MDReceiverX` | `3/re/` | 6/2，BuildID `6e73c47b…` |
| `TradeBot` | `3/TradeBot/TradeBot_China/main` | 同目录 | 6/17，BuildID `65f23d3c…` |
| `dataservice` | `3/dalong/infrastructure/DataService` | `3/infra/dataservice_deploy/` | 2014-09-30 |
| `SkylineFL_GUI` | `3/dalong/FromDaya/SkylineFL_GUI` | `3/GUI/SH/` | 线上是 2014-12-21，不是源码树 2015-03-19 |
| `TradingSystemsGUI` | `3/dalong/infrastructure/TradingSystemsGUI` | `3/infra/TradingSystemsGUI/` | 2014-09-26 |

> **构建树里的 `bin/release` 不是运行态**：`2/bld/build_dev_multi.20150330_1447/bin/release` 里只有 `lib*.a` 和测试工具，没有 `china_ors_extreme`/`mdreceiverX`；运行二进制是后来单独拷到 `/home` 的。不要以为“build 目录 = 可运行”。

---

## 3. 部署

### 3.1 文件系统拼装（复刻第一步）

历史机器：

```
/            <- 2/  (CentOS 6.6 root LV)
/home        <- 3/  (home LV)
/bld         <- 2/bld
/include     <- 2/include
/usr/local   <- 2/usr/local
/usr/share/API <- 2/usr/share/API
/opt/Qt5.3.2 <- 2/opt/Qt5.3.2 (未使用，可不带)
```

用户口述“把 `3/` 下所有目录拷到 `/home`”是对的，但要**选择性拷贝**：

- 必带：`TradeBot`、`infra`、`re`、`GUI`、`dalong`、`leon`、`jfs`、`piyush`。
- 可选：`TradeBot.bak`、`tempTradeBot`、`Midas*`、tarball（占空间，只用于对照）。
- 不要带：`lost+found`、`.Trash-0`、39 GB 的 `leon/log`（除非就是要复现磁盘压力）。
- 权限：APFS 把 uid/gid 压成 `501:20`；到 Linux 后要按 `2/etc/passwd` 重新 `chown`（`jfs:500`、`TradeBot:501`、`leon:503`），否则 `/home/TradeBot` 下脚本/日志会写不进去。

### 3.2 ORS 部署

**脚本** `3/infra/prod/scripts/runORS_extreme_new.sh`（【V】）：

```bash
ulimit -c unlimited
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:/home/piyush/ORS_CHINA_extreme/
ipcrm -M 3872
ipcrm -M 727272
ipcrm -M 4872
ipcrm -M 872

cd /home/infra/prod/
nohup /home/infra/prod/bin/china_ors_extreme_new \
  /home/infra/prod/config/prod.china.ors_new.cfg \
  >> /home/infra/prod/log/cmd.ors_$(date +%Y%m%d) &
```

要点：

1. **先删 4 个 SysV SHM**（3872 请求、727272 client store、4872 响应、872 行情），再启动。删之前**不会** `pkill` 旧 ORS；如果旧进程还在，会出现“旧进程用已删除段、新进程建新段”的双实例。`2/root/.bash_history:598-601` 的标准做法是先 `pkill -9 ors` 再跑脚本。
2. 没有 `taskset`；亲和性由配置里的 `*_CPU_AFFINITY` 在进程内设置（`prod.china.ors_new.cfg:48-53`）。
3. 日志：`cmd.ors_YYYYMMDD` 是 stdout；详细日志由 `LOG_FILE=/home/infra/prod/log/extremeors-log` 生成 `extremeors-log-YYYYMMDD-HH.MM.SS.log`（`prod.china.ors_new.cfg:29`）。**详细日志时间是 UTC，文件名是本地时间（CST），相差 8 小时**（`extremeors-log-20150724-20.21.01.log:3` 是 `12:21:01`）。【V】
4. `POSITION_FILE=/home/piyush/ORS_CHINA_extreme/log/position.csv`（`:39`）；这是 ORS 唯一持久化持仓，启动时读、运行中写。7/24 内容是 `ag1512,8,0,8,0` / `cu1510,1,0,1,0`。【V】
5. `RMS_CONFIG_FILE`/`RMS_FIRMWIDE_CONFIG_FILE`（`:42-44`）指向 `config/rms/`；启用的检查只有 `TICKER_LIMIT_CHECK`、`QUANTITY_FIRMLEVEL_CHECK`、`CANCEL_CONFIRMS_COUNT_CHECK`，**`STOP_LOSS_CHECK` 被注释掉**（`prod.china.rms.xml:2-9`）。账户级/品种级亏损限额写在 `:43-46`，但未启用对应检查，实际不生效。【V】
6. `FRONT_ADDR_ORS=tcp://127.0.0.1:7776`、`FRONT_ADDR_MD=tcp://127.0.0.1:7777`（`:1,5`）——7/13 从直连 `192.168.1.1` 改成**本地网关**；`prod.china.ors_new.cfg.bak` 还是旧地址。这是 7 月最重要的拓扑变更。【V】

**网关**：

- `3/jfs/linux-64bin/startfs:5-9` 启动 `quotgate`（7777 行情）和 `tradegate`（7776 交易）。
- `2/var/spool/cron/jfs:1-4`：工作日 07:15/19:15 启动，16:30/03:00 停止。
- `tradegate.ini:51-53`、`quotgate.ini:38-40` 指向券商 FENS/交易/行情前置（内网 `192.168.12.0/24`）。
- 这两个 ini 里有**明文柜台口令**（`[ContrlCenter]/Password`、`[SFE]/Password`）；本文不复制。【V】

### 3.3 行情接收机（MDReceiverX）部署

**两个脚本，一字之差**（【V】）：

```bash
# 3/re/receive_new.sh:1
taskset -c -p 8 nohup ./mdreceiverX cme.recv.quincy.data.cfg &

# 3/re/receive.shBak:1
taskset -c -p 5,6 nohup ./mdreceiverX_bothfeeds cme.recv.quincy.data.cfg &
```

**配置** `3/re/cme.recv.quincy.data.cfg`：

- `:13-22` `[CHINA_CME]`，`MultiCastRecv=FALSE`，`Host` = 本机 `eth10` 地址，`Port=12345`，`ShmKey=10201`，`ShmSize=1000`。
- 只定义一个 channel；没有第二个 feed section。
- 日志由进程按 `cme.recv.quincy.data.cfg.<start>-<end>.log` 命名；每天 08:55:07 / 20:55:07 左右新建一个，正好是 cron 08:55:01 / 20:55:01 后 6 秒。【V】`3/re/...20150724-08.55.01...log:3-9`

**`nohup.out` 里的真实启动痕迹**（【V】`3/re/nohup.out:1-9`）：

```
FATAL: config error file=cme.recv.quincy.data.cfg key=LOGGER_THREAD_SCHED_POLICY
Setting affinity of 6863(LOGGER_THREAD) to 23
FATAL: config error ... STATS_COLLECTOR_THREAD_SCHED_POLICY
size=1024|header=8|T=824
shmkey=10201 shmsize=847872 flag=950
shm already existing...: flag=950
SHMID = 851984 ...
Header already existing: head=10174
```

说明：

1. `SCHED_POLICY` 是**非致命**配置缺失，只打 FATAL 然后继续；不要被吓到。
2. 它**默认 attach 已存在的 10201**，不是每次重建；`Header already existing: head=...` 表示沿用旧队列头。这意味着**跨重启可能读到旧消息**，是数据完整性风险。
3. `SO_REUSEADDR` 成功（`...20150724...log:7-9`），同一 UDP 端口可以被多个接收进程 bind；重复启动不会报错，但会抢包/重复写 SHM。这是“看起来启动了、其实没数据”的常见原因。

**为什么 `receive_new.sh` 起不来 / 为什么要回滚 `receive.shBak`**——按证据分四层：

| # | 可能原因 | 证据 | 置信度 |
|---|---|---|---|
| 1 | `taskset -c -p 8` 不是标准 util-linux 用法；`-p` 是“对已有 PID 操作”，后面的 `nohup` 不会被当成要执行的命令（要么被当 CPU list，要么变成 `taskset` 改 PID 8 的亲和性） | 【V】`2/bin/taskset` strings；`receive_new.sh:1` | 高（语法层） |
| 2 | 但日志显示每天 08:55:07 确有接收进程启动 → 当时实际执行的**不是**这份 7/7 的文件，或由人工绕过脚本启动 | 【V】`3/re/...20150724-08.55.01...log:3`；`2/var/log/cron:1726` | 高（矛盾存在） |
| 3 | `mdreceiverX`（2015-06-02，BuildID `6e73c47b…`）是**单 feed** 新构建；`mdreceiverX_bothfeeds`（2015-02-11，`69db68c5…`）是双 feed 旧构建；配置只有 `[CHINA_CME]`，新二进制可能按新 feed/新队列布局启动而失败 | 【V】`file/mtime/BuildID`；cfg `:13-22` | 中 |
| 4 | 旧进程仍占着 12345 / 10201；新进程 attach 旧 SHM 后“启动成功”但不拥有队列，或者被 `SO_REUSEADDR` 分流 | 【V】`nohup.out:6-9`；日志 `SO_REUSEADDR` | 中 |

**结论**：把 `receive.shBak` 改名为 `receive.sh` 是**回滚到 2 月的双 feed 版本**，不是“修复新脚本”。正确做法：

```bash
cd /home/re
cp -a receive.shBak receive.sh
# 标准 taskset 写法；如果不需要绑核，直接 ./mdreceiverX_bothfeeds ...
taskset -c 5,6 ./mdreceiverX_bothfeeds cme.recv.quincy.data.cfg
```

如果希望 cron 也回滚，必须把 `2/var/spool/cron/root:7,15` 的 `./receive_new.sh` 改成 `./receive.sh`；**只改文件名、不改 cron，等于没改**。

### 3.4 策略（TradeBot）部署

`3/TradeBot/livescripts/RunStrategies.sh`（【V】）：

```bash
cd /home/TradeBot/TradeBot_China/main
nohup taskset -c 21 /home/TradeBot/TradeBot_China/main/TradeBot --Live \
  --controlFile /home/TradeBot/controls/control.GOLD_F_0_SFE.eve.ltp.20150725 \
  --startDate 20150725 --endDate 20150725 --strategyID 420 \
  --configFile /home/TradeBot/TradeBot_China/Connector/config_CHINA_CME.cfg \
  --adjustLTP 1 \
  --logFile /home/TradeBot/log/log.live.control.GOLD_F_0_SFE.eve.ltp.20150725 \
  >> /home/TradeBot/log/log.live.control.GOLD_F_0_SFE.eve.ltp.20150725 &
```

要点：

1. **脚本只启动一个策略**（GOLD 夜盘 ltp），不是“启动所有策略”。`RunStrategies_noon.sh:6` 是另一个（GOLD 午盘 agg）。生产上每个策略一行，人工按需启用。
2. `cd .../main` 是必须的：`../data`、`../Config`、`../Connector` 都是相对路径（`main.cpp:414-426`、`CommonClient.cpp`）。
3. `--adjustLTP 1` 是 China 版必须：SHFE 经常只有单边盘口，不开这个参数 `GetBidPrice` 会拿到 0 并直接 `return`，策略完全不报价（02 §9.5）。
4. `--strategyID 420` 写死；control 文件里的策略类型决定实际子类。
5. `RunStrategies*.sh` 每天由 `copymodels.sh` 改日期（见 §6.6），不要手工改 20150725 后忘了日切。

**配置/模型**：

- `control.<symbol>.<session>.<date>`：一行一个策略配置；2006 个历史文件。
- `model.<symbol>.<session>.<date>`：指标模型；1958 个。
- `Config/StrategyConfig.cfg`：`ACCOUNT=OWN`、`MAX_POS_SIZE=1000000`、`MAX_ORDERS=450`。
- `Config/signal.txt`：仍是 NIFTY 符号（`NIFTY_O_C_0_11/12`），对 GOLD 的 `SIGTERM` 选择性平仓**不会命中**；不要用 SIGTERM 当“全平”。【V】

### 3.5 DataService / DataStream 部署

它们**不是二选一**，而是三层：

| 进程 | 脚本 | 配置 | 端口 | 作用 |
|---|---|---|---|---|
| Streaming（China） | `runDataStream_CTP.sh` | `configStream_CTP.xml` | 1732 | 读 SHM 872/3872/4872 → TCP 行情/订单给 GUI |
| Streaming（CME） | 无独立脚本，`restart.sh:12` | `configStream_CME.xml` | 1733 | 读 SHM 10201/55555/66666 → CME 行情给 GUI |
| Service | `runDataService.sh` | `configService.xml` | 20000 | 登录、订单、持仓、PnL、访问控制；GUI 主连接 |

`restart.sh` 的顺序就是标准顺序（【V】`:11-23`）：

```bash
taskset -c 1 dataservice configStream_CTP.xml &
taskset -c 1 dataservice configStream_CME.xml &
sleep 10
taskset -c 1 dataservice configService.xml &
sleep 7
cd /home/infra/TradingSystemsGUI/
export LD_LIBRARY_PATH=.
taskset -c 15 ./TradingSystemsGUI > `date +%Y%m%d-%H.%M.%S`.log 2>&1 &
```

要点：

1. **先 stream，后 service，再 GUI**；stream 负责把 SHM 里的行情/订单转成 TCP，service 负责登录/权限/订单路由。只起 service 不起 stream，GUI 能登录但没行情/没订单推送；只起 stream 不起 service，GUI 连不上 20000。
2. `configService.xml:3` `ServerPort=20000`；`:6` ACL 文件；`:7` password 文件；`:40-56` China 交易所 `127.0.0.1:1732`，CME `127.0.0.1:1733`。
3. `configStream_CTP.xml:16-31` 读 `872/3872/4872`，`ClientStoreKey=727272`，`Exchange=57`；`:11` `SymbolSpecs=/home/infra/dataservice_deploy/inst_def.csv` —— 该文件 **0 字节**（【V】`ls -l`），中国合约元数据实际为空。
4. `configStream_CME.xml:16-18` 读 `10201`；`:30-38` 读 `55555/66666`。但 ORS 配置里没有 55555/66666，CME 的订单流在这套 China 部署里基本没接通（【I】）。
5. `configService.xml:45` China 的 `InstrumentDefenitionFilePath=/home/illuminati/brazil_instrdef.txt`，该路径在 `3/` 下**不存在**（【V】`find`）。可能只是未使用的巴西遗留字段，但重建时要补或删。
6. `restartNew.sh:11-17` 用 `dataservice.ChinaNew`，文件不存在 → 这个脚本不可用（【V】）。

### 3.6 GUI 部署

**Qt5 线上** `3/GUI/SH`：

- 自带 `libQt5Core/Gui/Widgets/Network/DBus.so.5`、`libicu*.so.52`、`platforms/libqxcb.so`、`libzmq.so.3`；二进制 `SkylineFL_GUI` 2014-12-21，BuildID `a2e432bd…`。【V】
- `GuiSettings.xml:7` `ServerPort=15213`；`:18-291` 共 **34 个** `<Strategy>`，端口 `15300–15333`，策略名/合约留空，运行时由 `strategyName`/`contractName` 填。【V】
- `Position.csv` 存在但**过期**：8 行，最后 2015-04-07，含 `ag1506/au1506/cu1505` 等已到期合约；GUI 启动会加载它，表格里会出现僵尸行。【V】
- `fills.csv` 0 字节；成交确认在 `*.csv`（50 个，每约 500 行）和 DataService 日志里。
- 日志 `SkylineGUI-YYYYMMDD-HH.MM.SS.log`，每次启动一个；7/13–7/24 共 25 个，9 GB；单日两个（早/晚），386 MB + 588 MB。【V】
- `SkylineFL_GUI` 的 RPATH 仍是 `/home/dalong/Qt5.3.1/...`；必须 `LD_LIBRARY_PATH=/home/GUI/SH/`，否则找不到 Qt5。【V】`strings`
- `Main.cpp:63` 用 `./GuiSettings.xml`；`runChinaGui.sh` 没有 `cd`，从别的目录执行会读不到配置并 `exit(-1)`；日志/CSV 也会写到调用目录。【V】

**启动**：

```bash
cd /home/GUI/SH
export LD_LIBRARY_PATH=/home/GUI/SH/
taskset -c 7 ./SkylineFL_GUI        # 修正 runChinaGui.sh 的 -c -p
```

`runChinaGui.sh:2` 的 `taskset -c -p 7` 按标准语法无效；历史 GUI 能起来，说明操作员大概率是直接 `./SkylineFL_GUI` 或用了别的 wrapper。【I】

**Qt4 旧 GUI** `3/infra/TradingSystemsGUI`：

- `runGUI.sh:2-4`：`LD_LIBRARY_PATH=.` + `taskset -c 15 ./TradingSystemsGUI`。
- `FrontEndConfig.xml:4` autosave `/home/punit/pnl/`，本机无此用户/目录 → 17:00 保存静默失败。
- 148 个日志里 146 个 0 字节；仅 `20150504-20.42.41.log` 与 `20150608-08.57.19.log` 有内容。每天 08:xx/20:xx 与 Qt5 GUI 几乎同秒创建空日志 → 有一套脚本/人工同时拉两套 GUI，Qt4 那套大多立即退出（缺 `libQt*.so.4` 符号链接）。【V/I】

### 3.7 SHM / 端口矩阵（部署真相）

| Key/Port | 拥有者 | 消费者 | 大小/说明 | 证据 |
|---|---|---|---|---|
| `727272` | ORS | 策略、DataService | client store，4096 | `ors_new.cfg:31`；`configStream_CTP.xml:27` |
| `3872` | ORS | 策略、DataService | request queue，100000 | `:32-33`；`config_CHINA_CME.cfg:18-19` |
| `4872` | ORS | 策略、DataService | response queue，100000 | `:34-35`；`:20-21` |
| `872` | ORS | 策略、DataService | SHFE/China MD，100000 | `cmd.ors_20150724:29-30`；`config_CHINA_CME.cfg:22` |
| `10201` | MD receiver | 策略、DataService | CME MD，1000 | `cme.recv...cfg:21-22`；`config_CHINA_CME.cfg:22` |
| `20000/tcp` | DataService service | GUI | 登录/订单/持仓/PnL | `configService.xml:3`；`ConnectionDetails.h:15-16` |
| `1732/tcp` | DataService stream CTP | GUI | China 行情/订单 | `configStream_CTP.xml:3` |
| `1733/tcp` | DataService stream CME | GUI | CME 行情 | `configStream_CME.xml:3` |
| `7776/tcp` | tradegate | ORS | 交易前置 | `tradegate.ini:22` |
| `7777/tcp` | quotgate | ORS | 行情前置 | `quotgate.ini:12` |
| `15213/tcp` | GUI | 策略 PUSH | GUI 收心跳/遥测 | `GuiSettings.xml:7`；`GuiMsgHub.cpp:8` |
| `15300–15333/tcp` | 策略 | GUI | 每策略一个 PULL | `GuiSettings.xml:18-291`；`.PortsFile` |

> 策略端口不是“配置里写死哪个就用哪个”：`cfgField::getSocketPort()` 从 `.PortsFile` 里**顺序找第一个 bind 失败的端口**。日志 `au1512-GCQ5-B-FAKL-6.log:1-5` 显示 15300–15304 被占，它拿了 15305。GUI 却按“端口=行号”映射；重启顺序一变，策略就会显示在错误的行上。【V/I】

---

## 4. 启动顺序：历史真相与依赖

### 4.1 历史 cron 时序（V）

`2/var/spool/cron/root`（工作日 `1-5`）：

| 时间 | 命令 | 行 |
|---|---|---|
| 07:15 | `jfs` 用户 `~/linux-64bin/startfs`（quotgate/tradegate） | `2/var/spool/cron/jfs:1` |
| 08:10 | `cd /home/leon/bin && ./reqPositionFile.sh` | `root:4` |
| 08:11 | `cd /home/infra/prod/scripts && ./runORS_extreme_new.sh` | `root:5` |
| 08:55 | `cd /home/re && ./receive_new.sh` | `root:7` |
| 08:56 | `cd /home/leon/CL/scripts && ./startAll_new2.sh`（策略） | `root:6` |
| 15:05 | `pkill -9 rec` / `pkill -9 ors` / `pkill -9 Trade` / `killAllStrategy.sh` | `root:8-11` |
| 16:30 | `jfs` `stopfs`（网关） | `jfs:3` |
| 19:15 | `jfs` `startfs` | `jfs:2` |
| 20:20 | `reqPositionFile.sh` | `root:13` |
| 20:21 | `runORS_extreme_new.sh` | `root:14` |
| 20:55 | `receive_new.sh` | `root:15` |
| 20:56 | `startAll_new2.sh` | `root:16` |
| 02:35 | `killAllStrategy.sh` + `pkill -9 rec/ors/Trade` + `copymodels.sh` | `root:17-21` |
| 03:00 | `jfs` `stopfs` | `jfs:4` |

**日志实证**（`2/var/log/cron`）：

```
Jul 24 08:11:01 ... runORS_extreme_new.sh
Jul 24 08:55:01 ... receive_new.sh
Jul 24 08:56:01 ... startAll_new2.sh
Jul 24 20:21:01 ... runORS_extreme_new.sh
Jul 24 20:55:01 ... receive_new.sh
Jul 24 20:56:01 ... startAll_new2.sh
```

**进程日志时间**：

- ORS：`extremeors-log-20150724-08.11.02.log:3`（UTC 00:11:02 = CST 08:11:02）。
- 接收机：`...20150724-08.55.01...log:3`（08:55:07）。
- 策略：`au1512-GCQ5-B-FAKL-6.log:2`（`Start Trading 20150724205611`）。
- DataService：`DataService-20150724-08.12.41.log:3`（08:12:41 stream），`...08.12.45.log:3`（08:12:45 service）。
- GUI：`SkylineGUI-20150724-08.12.49.log:1-5`（08:12:49），DataService 日志 `:28-29` 在同一秒收到 GUI client。

> 注意：cron 里的 `startAll_new2.sh` 启动的是 **leon 的 `SHStrategy_new`**，不是 `RunStrategies.sh` 的 TradeBot。7 月实际在跑的是 leon 那套；TradeBot 日志只到 6/30。两者共用 ORS/SHM/GUI 协议，所以运维模型相同。**用户口述的 `RunStrategies.sh` 是 TradeBot 时代的启动方式，和 7 月 cron 不是同一套策略。**

### 4.2 依赖图

```
[quotgate 7777] [tradegate 7776]        (jfs, 07:15/19:15)
          │              │
          └──────┬───────┘
                 ▼
        reqPositionFile.sh  ──► /home/piyush/.../position.csv
                 │
                 ▼
     china_ors_extreme_new  ──creates──► SHM 727272 / 3872 / 4872 / 872
                 │
                 │        mdreceiverX ──creates──► SHM 10201
                 │              │
                 └──────┬───────┘
                        ▼
              TradeBot / SHStrategy_new
              (attach 727272, 3872, 4872, 872, 10201)
                        │
                        ▼
        DataService stream 1732/1733  +  service 20000
                        │
                        ▼
              SkylineFL_GUI  (bind 15213, connect 20000)
                        ▲
                        │ ZMQ PUSH 15213 / PULL 15300-15333
                        └──────── 策略遥测/控制 ────────┘
```

### 4.3 最小可复现顺序

按历史证据，正确的顺序是：

1. **网关**：`/home/jfs/linux-64bin/startfs`（或沙箱 stub）。
2. **拉持仓**：`/home/leon/bin/reqPositionFile.sh` → 更新 `position.csv`。
3. **ORS**：`pkill -9 ors`（如有）→ `/home/infra/prod/scripts/runORS_extreme_new.sh`。
4. **行情接收**：`cd /home/re && taskset -c 5,6 ./mdreceiverX_bothfeeds cme.recv.quincy.data.cfg`（或 `receive.shBak` 回滚版）。
5. **策略**：`cd /home/TradeBot/TradeBot_China/main && sh /home/TradeBot/livescripts/RunStrategies.sh`（或 leon 的 `startAll_new2.sh`）。
6. **DataService**：stream `configStream_CTP.xml`/`configStream_CME.xml` → sleep 10 → `configService.xml`。
7. **GUI**：`cd /home/GUI/SH && LD_LIBRARY_PATH=. taskset -c 7 ./SkylineFL_GUI`。

历史实际执行时，步骤 6/7 发生在 08:12（ORS 之后、接收机之前），比步骤 4/5 早；这不影响交易，因为 GUI 只是监控/手工单，策略不依赖 DataService。

### 4.4 顺序错误的故障模式

| 错误顺序 | 症状 | 根因/证据 |
|---|---|---|
| 策略在 ORS 之前 | 策略进程启动即 abort；日志可能只到 “Config File/Control File” 就没了 | `Connector` 构造时 `initClientStore(727272)` attach 失败 → `IpcException`；`main.cpp:949,1065-1074` 的 try/catch **被注释** → `std::terminate`（`connector.cpp:62`；`shmmanager.h:256-265`） |
| 策略在 MD 接收之前 | 同上；即使 ORS 在，`registerMDClient(10201)` 也失败 | `connector.cpp:70`；`shmmanager.h:292-300` |
| ORS 在网关之前 | ORS 登录 `7776/7777` 失败；可能重试，也可能没有 SHM | ORS 日志 `ORSServer.cpp:353` “Logging in to ORS ...”；`Main.cpp` 启动即连 |
| DataService stream 在 ORS/MD 之前 | stream 启动但无数据；GUI 能连 1732/1733 但表格空 | `configStream_CTP.xml:16-31` attach 872/3872/4872 |
| GUI 在 DataService 之前 | GUI 启动时每个 collector `waitForConnected()` 最长 30 秒；界面长时间无响应/空白 | `DataCollector.cpp:43-56` |
| GUI 在策略之前 | 安全：策略行显示离线，等心跳到达后自动 `connectRequest` | `Container.cpp:34,57-80`；`Strategy.cpp:274-277` |
| 策略在 GUI 之前 | 交易不受影响；但心跳 PUSH 可能阻塞/丢遥测 | `StrategyMsgHub.cpp:33-59`（`ZMQ_SNDTIMEO=-1`） |
| MD 在 ORS 之前 | 安全；两者各自创建自己的 SHM（10201 / 872） | 日志/配置 |

**最危险的错误**不是“起不来”，而是“看起来起来了”：

- `mdreceiverX` attach 旧 10201，`Header already existing`；策略读到重启前的旧行情/旧队列。
- ORS 脚本 `ipcrm` 删段但没杀旧进程；新旧 ORS 同时写，策略可能连到旧段。
- 策略端口动态抢占；重启后端口变了，GUI 行错位，操作员以为某策略停了/开了。

### 4.5 用户口述序列的校正

| 口述 | 校正 |
|---|---|
| 1. 把 `3/` 所有目录拷到 `/home` | 对；但要排除 `lost+found`/`.Trash-0`，并修 uid/gid；`/bld`、`/include`、`/usr/local`、`/usr/share/API` 从 `2/` 取 |
| 2. 启动 `runORS_extreme_new.sh` | 对；但先确认网关在跑、先 `pkill -9 ors`、先 `reqPositionFile.sh`；脚本本身不杀旧进程 |
| 3. `receive_new.sh` 起不来 → `receive.shBak` → `receive.sh` | 这是回滚到 2 月双 feed 版；两个脚本的 `taskset -c -p` 都要改成 `taskset -c N`；cron 也要同步改，否则明天还是跑 `receive_new.sh` |
| 4. `RunStrategies.sh` | 对；但它只启动一个策略，不是全部；必须在 ORS+MD 之后；cwd 必须在 `main/` |
| 5. DataService 或 DataStream | **不是二选一**：stream 1732/1733 + service 20000 都要；顺序 stream → service → GUI |
| 6. GUI | 对；先 `cd /home/GUI/SH`，`LD_LIBRARY_PATH=.`；`runChinaGui.sh` 的 `taskset -c -p` 要修 |

---

## 5. 停机、重载、信号

### 5.1 TradeBot 的信号语义（V，`main.cpp:90-164`）

| 信号 | 语义 | 动作 |
|---|---|---|
| `SIGTERM` / `SIGRTMIN` / `36` | 按 `../Config/signal.txt` 选择性平仓 | 读文件，只对命中 symbol 置 `onExit/onCancel/onFlat` |
| `SIGTSTP` | **全平** | 不看 symbol，全部平 |
| `SIGUSR1` | 恢复交易 | `onExit/onCancel/onFlat=false; m_Active=true` |
| `SIGUSR2` | 重载阈值 | `LoadThresholds(simConfig)`；期权模式再重载 `OptionsParams` |
| `37` / `SIGRTMIN+3` | **强平**（对手价 ±1 tick） | 额外 `m_aggFlat=true` |
| 其它 | 只打日志 | — |

重要：

- 所有信号在 `CommonClient::Initialize` 里被 `sigfillset + pthread_sigmask(SIG_BLOCK)` 屏蔽，只有主线程 `sigwait` 接（`CommonClient.cpp:171-174,1099-1111`）。
- **`signal.txt` 是 NIFTY 符号，不是 GOLD**；所以 `SIGTERM` 对当前 China 策略基本无效，必须用 `SIGTSTP` 或 `37`。
- 平完不会退出：`HandleSquareoff()` 净仓 0 且无挂单时只 `m_Active=false`，进程继续等信号（`ExecutionStrategy.cpp:2270-2278`）。
- 真正会 `exit(1)` 的是：`SetTargetValue` 超限（`:308`）、`ORDERS_PER_DAY_LIMIT_REJECT`（`:945`）、启动配置缺失。

### 5.2 历史停机方式

`2/var/spool/cron/root:8-11,17-20`：

```cron
05 15 * * 1-5 pkill -9 rec
05 15 * * 1-5 pkill -9 ors
05 15 * * 1-5 pkill -9 Trade
05 15 * * 1-5 cd /home/leon/CL/scripts && ./killAllStrategy.sh
...
35 02 * * 1-6 pkill -9 rec
35 02 * * 1-6 pkill -9 ors
35 02 * * 1-6 pkill -9 Trade
35 02 * * 1-6 cd /home/leon/CL/scripts && ./killAllStrategy.sh
35 02 * * *   cd /home/TradeBot/livescripts && ./copymodels.sh
```

- 先 `rec`（接收机），再 `ors`，再 `Trade`，最后策略；顺序合理（先断行情/柜台，再断策略），但全是 `-9`。
- `15:05` 是下午收盘后 5 分钟；`02:35` 是夜盘收盘后。正常交易日此时应已由策略内部 `endTime` 平仓；`-9` 只是兜底。
- `2/root/.bash_history:598-601` 的手工重启是 `pkill -9 ors` → `./runORS_extreme_new.sh`；**必须显式杀旧进程**。

`3/TradeBot/.bash_history` 里的安全模式：

```
pkill -SIGTSTP TradeBot     # 先全平
pkill -9 TradeBot           # 再杀
pkill -SIGUSR1 TradeBot     # 恢复
pkill -SIGUSR2 TradeBot     # 重载阈值
pkill -37 TradeBot          # 强平
```

这是唯一“先平后杀”的证据；日常 cron 没有这么做。

### 5.3 pid 文件：路径已漂移，实际不存在

`main.cpp:683-689`：

```cpp
std::ofstream pidFile;
char pid[1024];
sprintf(pid, "/home/TradeBot/TradeBot/data/pid.%s", simConfig[i].m_dateConfig.m_currDate);
pidFile.open(pid, ios::app);
sprintf(pid, "%d %d", strategyID, getpid());
pidFile.write(pid, strlen(pid));
pidFile.close();
```

- 期望路径 `/home/TradeBot/TradeBot/data/`；实际源码/运行在 `/home/TradeBot/TradeBot_China/data/`，`/home/TradeBot/TradeBot` 不存在（【V】`ls`）。
- `ofstream` 没有 `is_open()` 检查；打开失败静默，**不会创建任何 pid 文件**（【V】`find /home -name 'pid.2015*'` 空）。
- 结论：不要用 pid 文件管理；实际就是 `pkill` 按进程名。

### 5.4 SHM 清理

| 脚本 | 清理的 key | 风险 |
|---|---|---|
| `runORS_extreme_new.sh:4-7` | `3872, 727272, 4872, 872` | 不杀旧 ORS；旧进程继续用已删除段 → 双实例/策略连错段 |
| `runORS_ctp.sh:4` + `removeShm.sh` | `3872..3972, 727272, 872, 4872` | 循环删 101 个 key；更彻底，但也更危险 |
| `3/leon/bin/removeShm.sh` | `3873, 737373, 873, 4873` | 另一套端口偏移（策略侧） |
| `mdreceiverX` | **不删 10201** | 每次 attach 旧队列，`Header already existing`；旧消息可能被消费 |

> SysV SHM 不会因为进程退出自动删除；`ipcrm` 是运维的一部分。正确顺序：`pkill` 旧进程 → 确认 `ipcs -m` 无残留 → `ipcrm` → 启动新进程。

### 5.5 数据丢失面

| 动作 | 可能丢什么 | 缓解 |
|---|---|---|
| `kill -9 ors` | 最后一次 `position.csv` 写入、在途报单/回报 | 收盘后杀；次日 `reqPositionFile.sh` 从柜台重新拉 |
| `kill -9 TradeBot` | 策略内存中的挂单/净仓；不会自动平仓 | 先 `SIGTSTP` 全平；或用 `squareoff` 工具 |
| `ipcrm` 时旧进程未死 | 旧进程继续写已删除段；新进程读不到 | 先 `pkill -9`，再 `ipcs/ipcrm` |
| `mdreceiverX` 重复启动 | 同一 UDP 包被多个进程消费；SHM 头错乱 | 只保留一个；启动前 `pkill -9 mdreceiver` |
| GUI 关闭 | 不发 `GuiClose`；策略仍认为 GUI 在线，直到 6 秒心跳超时 | 重启 GUI 后会自动 `connectRequest`，但可能显示 “stopped” 而策略仍在跑（03 §3.6） |
| `copymodels.sh` `rm bckp/*` | 前一天的 control/model 备份被清空 | 只保留一天；需要更长保留就自己 tar |

---

## 6. 日常运维

### 6.1 cron 全表（root + jfs）

`2/var/spool/cron/root`（【V】）：

| 行 | 时间 | 命令 | 作用 |
|---|---|---|---|
| 1-2 | 07:59/08:00 | `ntpdate` | 对时（内网/公网 NTP） |
| 3 | 07:59 | `getDay.py` | 计算交易日 |
| 4 | 08:10 | `reqPositionFile.sh` | 从柜台拉持仓 → `position.csv` |
| 5 | 08:11 | `runORS_extreme_new.sh` | 早盘 ORS |
| 6 | 08:56 | `startAll_new2.sh` | 早盘策略 |
| 7 | 08:55 | `receive_new.sh` | 早盘行情接收 |
| 8-11 | 15:05 | `pkill rec/ors/Trade` + `killAllStrategy` | 下午收盘清理 |
| 12 | 15:30 | `backPnlLog.sh` | 把 `CL/log/*` 移到日期目录 |
| 13-16 | 20:20-20:56 | 同早盘 | 夜盘 |
| 17-21 | 02:35 | 同 15:05 + `copymodels.sh` | 夜盘收盘 + 日切 |
| 22-23 | 07:50/19:50 | `SetAffinity.py` | 网关绑核（脚本本身语法可疑） |
| 25-32 | 09:00-21:00 | `Dump.sh` + `pkill DUMP` | 盘中 dump，间隔启动/停止 |

`jfs` 用户（【V】`2/var/spool/cron/jfs:1-4`）：07:15/19:15 `startfs`，16:30/03:00 `stopfs`。

### 6.2 日志与磁盘

| 目录 | 大小 | 文件数 | 轮转 | 证据 |
|---|---|---|---|---|
| `3/GUI/SH` | 9.0 GB | 25 个 `SkylineGUI-*.log`（86 KB–606 MB）+ 50 CSV | **无**；每次启动新文件 | 【V】`du/ls` |
| `3/infra/prod/log` | 2.4 GB | 137 个 `extremeors-log-*` + 64 个 `cmd.ors_*` | 每次启动新详细日志；cmd 按日 append；**无删除** | 【V】 |
| `3/infra/dataservice_deploy` | 872 MB | 296 个 `DataService-*.log` | 每次启动新文件；无删除 | 【V】 |
| `3/re` | 40 MB | 87 个 config 日志 + 140 个 stats | 每次启动新文件；无删除 | 【V】 |
| `3/TradeBot/log` | 8.1 MB | 12 个 | 手工 `mv`/`ZipLogs.sh`（未挂 cron） | 【V】`ZipLogs.sh:1-2` |
| `3/leon/log` | 39 GB | 大量策略日志 | `backPnlLog.sh` 按日期目录移动，**不删除** | 【V】`backPnlLog.sh:1-4` |
| `3/jfs/.../log` | — | 网关日志 | `stopfs` 每月备份 + 16–21 点 `rmlog` | 【V】`stopfs:8-29` |

**风险**：

- GUI 日志按“每条 ZMQ 消息一行”记录；7/24 单日 3,415,011 行 / 386 MB；没有 `logrotate` 配置（`2/etc/logrotate.d` 只有系统服务）。【V】
- 7/7 出现异常大日志：`extremeors-log-20150707-08.01.01.log` 368 MB，`DataService-20150707-08.52.31.log` 299 MB → 某次调试/异常把日志打爆；没有大小上限。【V】
- `/home` 78 GB，`3/leon/log` 39 GB + GUI 9 GB + ORS 2.4 GB ≈ 50 GB；再跑几天就可能满。**生产上没有自动清理。**

### 6.3 VNC / X / GUI 启动

- VNC `:1` root，800×600，`-nolisten tcp`；`xstartup` 启 gnome-session；没有交易 GUI 自启动。【V】
- 历史 GUI 启动时间：08:12:49、20:36:10；关闭时间 20:35:50。说明操作员每天**收盘后关 GUI、夜盘前重开**，不是 24×7 挂着。【V】`SkylineGUI-20150724-08.12.49.log:3415005-3415011`；`...20.36.10.log:1-5`
- DataService 与 GUI 几乎同时启动（08:12:41/45/49），说明是人工在 VNC 里按 `restart.sh` 或逐条命令拉起。
- Qt4 GUI 也被同一波脚本拉起（空日志时间与 Qt5 同秒），但多数立即退出；不要把它当主 GUI。【I】

### 6.4 网络运维

- 行情接收机 bind `0.0.0.0:12345`，`SO_REUSEADDR`；上游是 `eth10` 同址的专线。**没有鉴权/加密**，任何能到达该网段的人都能注入 UDP 包。【V/I】
- ORS/网关/DataService/GUI 全部 `127.0.0.1`，不跨机；跨机只有券商前置和行情。
- ZMQ 控制面 `tcp://*:15213`、`tcp://*:15300-15333` 没有认证/CURVE；本机任何用户都能发 `startOrStop`。【V】03 §3.9
- `net.core.rmem_max=536870912`、`tcp_rmem/wmem` 调得很大（`2/etc/sysctl.conf:57-64`），是为行情吞吐；`tcp_tw_recycle=1`（`:72`）在现代网络里是隐患，但 2015 年单机无所谓。
- 没有 NFS/CIFS；`/home/dalong`、`/home/piyush` 是拷贝，不是共享盘。跨机同步靠 `scp`/tar（`2/root/.bash_history:592`）。

### 6.5 日切 / 模型滚动（`copymodels.sh`）

`3/TradeBot/livescripts/copymodels.sh:1`：

```bash
sh /home/TradeBot/livescripts/CopyControlsModels \
  `date --date="yesterday" +"%Y%m%d"` `date +"%Y%m%d"`
```

`CopyControlsModels`（【V】）：

1. `:20-21` `rm /home/TradeBot/bckp/*` **两次**（重复，无意义）。
2. `:23-25` 把 `controls/control.*.<昨天>` 拷到 `bckp/`，再 `sed` 成 `<今天>`；对已存在的今天文件再做一次日期替换。
3. `:28-29` 同样处理 `models/model.*.<昨天>`。
4. `:32-33` 对 `livescripts/RunStrategies*.sh` 做 `sed s/<昨天>/<今天>/g`，`chmod +x`。

风险：

- **只保留一天备份**；脚本重跑一次就把 `bckp` 清空。
- `rm` 没有 `-f`/错误检查；如果当天目录不可写，后续 `cp` 失败但脚本继续。
- 依赖 GNU `date --date=yesterday`；时区/日期错位会生成错误文件名。
- 它只改 `RunStrategies*.sh`，不改 `temp.sh`/`run.sh` 等手工脚本；这些脚本里的日期会过期。
- 02:35 与 `killAllStrategy` 同一分钟；如果 kill 慢，可能边跑边改文件。

### 6.6 监控/告警缺口

- 没有应用级健康检查；ORS/策略/接收机是否活着，靠人 `ps -ef | grep` 和 GUI 心跳。
- 没有磁盘/日志告警；9 GB GUI 日志和 39 GB leon 日志是手工清理。
- 没有进程 supervisor；挂了不会自动拉起，只能等下一次 cron（早/晚）或人工。
- `prod.env.sh:47-54` 的邮件告警全被注释；`prod.start.quincy.mdreceiver.sh:25` 的 `mailSimple` 也注释。
- `abrtd` 会捕获 core（7/20 tradegate segfault 16 MB core），但 `ProcessUnpackaged=no` 导致 core 被删；没有留存分析。

### 6.7 数据保留建议（只记录，不执行）

| 数据 | 保留 | 理由 |
|---|---|---|
| `3/GUI/SH/*.log` | 首尾各 1 周 + 每日 1 个样本 | 9 GB，99% 是 `impliedBidFairValue`/`bidPrice` 遥测 |
| `3/infra/prod/log/extremeors-*` | 每日 1 个 + 月末 | 2.4 GB；含登录/RMS/订单，复盘有用 |
| `3/infra/dataservice_deploy/DataService-*` | 每日 1 个 | 872 MB；订单/成交确认在 CSV 也有 |
| `3/TradeBot/log` | 全留（8 MB） | 策略行为证据 |
| `3/re/*.log` + `log/*.stats` | 全留（40 MB） | 行情质量/丢包 |
| `3/leon/log` | 按业务窗口 | 39 GB，最大头 |
| `position.csv` | 每日快照 | 唯一持久化持仓，只有 30 字节 |

---

## 7. 源码 vs 二进制漂移

### 7.1 漂移矩阵

| 组件 | 源码 | 构建 | 线上 | 判定 |
|---|---|---|---|---|
| TradeBot | `TradeBot_China` r2375，2015-06-10 | `main/TradeBot` 6/17，BuildID `65f23d3c…` | 同左；日志到 6/30 | **二进制晚于源码**；`.bash_history` 显示 6/10 后还在改 `ExecutionStrategy/AggressiveStrategy` → 线上含未提交改动 |
| ORS | `infrastructure/China`（git HEAD 2014-10-27，1287 dirty） | `2/bld/.../China` 2015-03-30 | `china_ors_extreme_new` 4/26，`beaa7b6d…` | 二进制晚于 build 快照；配置 7/13 又晚于二进制；三者都不同步 |
| MD 接收 | `MDReceiverX` 2015-03-30 | `mdreceiverX` 6/2 `6e73c47b…`；`bothfeeds` 2/11 `69db68c5…` | `/home/re` 两套并存 | 不知道 7/24 实际跑的是哪套；cron 指 `receive_new.sh`→`mdreceiverX` |
| DataService | `infrastructure/DataService` | 2014-09-30 | `dataservice` `ebb2a27f…` | 配置/二进制都是 2014；`dataservice.ChinaNew` 缺失 |
| Qt5 GUI | `.cpp/.h` 2014-11-20 | 源码树 2015-03-19 `1aecd50d…` | `GUI/SH` 2014-12-21 `a2e432bd…` | 线上 12/21 与源码同源（日志行号对得上）；3/19 构建**未部署** |
| Qt5 配置 | 源码 `GuiSettings.xml` 15150 / 4 策略 | — | 部署 15213 / 34 策略 | 部署版是运行期超集；源码配置不能直接用 |
| Qt4 GUI | `TradingSystemsGUI` git 2014-10-07 | 二进制 2014-09-26 `76f8f101…` | `3/infra/TradingSystemsGUI` | 二进制**缺** 10/6–10/7 的净敞口修复 |
| 网关 | 无源码（厂商） | 2014-12 | `3/jfs/linux-64bin` | 黑盒；配置 2015 年更新 |

### 7.2 `2/` vs `3/`：哪些是副本，哪些是唯一

| `2/` 路径 | 对应 `3/` | 关系 | 用途 |
|---|---|---|---|
| `2/TradeBot` | `3/TradeBot` | `diff -rq` 无差异（778 MB） | 冗余；可只留 3 |
| `2/TradeBot.bak` | `3/TradeBot.bak` | 完全相同（1.0 GB） | 冗余 |
| `2/GUI/SH` | `3/GUI/SH` | 排除 `*.log/*.csv/*.swp` 后相同 | 冗余；9 GB |
| `2/dalong` | `3/dalong` | **不完整**（缺 `.build_*` 等） | 不要用 |
| `2/infra` | `3/infra` | 只有 `prod/{bin,config,scripts,log}` 骨架 | 不要用 |
| `2/bld` | — | 唯一构建产物 | **必须保留** |
| `2/include` | — | 唯一头文件 | **必须保留** |
| `2/opt/Qt5.3.2` | — | 唯一但未使用 | 可留作对照，不要链接 |

结论：**源码/运行态看 `3/`，构建依赖看 `2/`；`2/` 的 TradeBot/GUI 副本是纯冗余。**

### 7.3 build 目录 vs 运行目录

| 目录 | 是什么 | 不是什么 |
|---|---|---|
| `2/bld/dev_multi` | 与 `dev_multi_20150330_1447` 完全相同的 infra 静态库/头文件快照（mtime 6/17），`main/Makefile` 的 `-L/bld/dev_multi` 目标 | 不是运行目录；没有 `TradeBot`/`china_ors` |
| `2/bld/build_dev_multi.20150330_1447` | infra 源码 + SCons + `.build_release` + `bin/release` 库 | `bin/release` 没有 ORS/MD 可执行；需 `scons project=` 重编 |
| `2/bld/dev_multi_20150330_1447` | 上述日期的库快照 | 与 `dev_multi` 内容基本相同 |
| `3/dalong/infrastructure` | git 源码 + 部分 `.build_*` | `bin/debug` 空，不能直接链 GUI |
| `3/GUI/SH` | Qt5 运行 bundle | 不是源码；源码在 `3/dalong/FromDaya/SkylineFL_GUI` |
| `3/dalong/FromDaya/SkylineFL_GUI` | 源码 + 2015-03-19 本机构建 | 该构建未部署 |
| `3/infra/TradingSystemsGUI` | Qt4 运行态 | 缺 `libQt*.so.4` 符号链接；源码在 `3/dalong/infrastructure/TradingSystemsGUI` |

### 7.4 漂移的后果

1. **不能从归档源码字节级重建线上二进制**：TradeBot 有 6/17 的本地改动；ORS 有 4/26 的未提交改动；GUI 的 3/19 构建和 12/21 部署不是同一次链接。
2. **配置比二进制新**：ORS 7/13 改成 `127.0.0.1:7776/7777`，二进制还是 4/26；如果二进制不认识新键，会静默忽略或退出（`FATAL: config error` 只打日志，不一定退出）。
3. **Qt4 源码比二进制新**：用归档源码重编 Qt4 GUI 会得到不同行为（净敞口/隔夜逻辑）。
4. **MD 三版本**：`mdreceiverX`/`bothfeeds`/`20150602` 的 feed 处理不同；复刻时选错会“进程在、没数据”。
5. **`position.csv` 是唯一状态**：源码/二进制怎么漂，最后都以这个 30 字节文件 + 柜台为准；它被覆盖/删除就是事故。

---

## 8. 沙箱复刻 / 安全 runbook

### 8.1 原则

- **不要在 `/Volumes/DevDisk/146` 上原地运行/修改**；APFS 不能执行 ELF，且会污染证据。
- **不要接真实柜台/行情**：不启动 `quotgate`/`tradegate`、不跑 `china_ors_extreme_new`、不跑 `reqPosAMd_sgitNew`、不让 `mdreceiverX` 绑到有行情的网卡。
- **先只读验证，再分层启动**；每层都有可观测的成功标志。
- **不追求字节级复现**；目标是“能解释启动顺序、能看 GUI、能复现策略初始化”。

### 8.2 沙箱规格

| 项 | 建议 | 理由 |
|---|---|---|
| OS | CentOS 6.6 x86_64（或同代 RHEL 6） | 2.6.32 内核、SysV SHM、老 glibc |
| CPU/RAM | 8 vCPU / 16 GB 起 | 48 核不是必须；SHM 872 约 108 MB |
| 磁盘 | 100 GB | `3/` 58 GB + 构建空间 |
| 网络 | 仅 host-only / 无出站 | 防止误连券商/行情 |
| 显示 | Xvfb 或 VNC `:1` 1024×768 | GUI 需要 X |
| 用户 | `TradeBot:501`、`leon:503`、`jfs:500` | 路径/权限 |

### 8.3 铺盘

```bash
# 只读源
SRC=/mnt/146

# 1) 基础 root：建议用干净 CentOS 6.6，只拷构建依赖，不要整盘覆盖 /etc
sudo mkdir -p /bld /include /usr/local/lib /usr/share/API
sudo rsync -aHAX "$SRC/2/bld/" /bld/
sudo rsync -aHAX "$SRC/2/include/" /include/
sudo rsync -aHAX "$SRC/2/usr/local/lib/libsnappy.a" /usr/local/lib/
sudo rsync -aHAX "$SRC/2/usr/share/API/" /usr/share/API/

# 2) /home：选择性拷贝
sudo rsync -aHAX --exclude 'lost+found' --exclude '.Trash-0' \
  "$SRC/3/TradeBot" "$SRC/3/infra" "$SRC/3/re" "$SRC/3/GUI" \
  "$SRC/3/dalong" "$SRC/3/leon" "$SRC/3/jfs" "$SRC/3/piyush" /home/

# 3) 修属主（按 2/etc/passwd）
sudo chown -R 501:501 /home/TradeBot
sudo chown -R 503:503 /home/leon
sudo chown -R 500:500 /home/jfs
```

> 不要 `rsync 2/ /` 覆盖沙箱的 `/etc`/`/usr`；会破坏 yum/ssh。只取 `/bld`、`/include`、`/usr/local/lib/libsnappy.a`、`/usr/share/API`，必要时再取 `/opt/Qt5.3.2`（但不要用）。

### 8.4 stub 分层

| 层 | 真实组件 | 沙箱 stub | 成功标志 |
|---|---|---|---|
| L0 构建 | g++/SCons/qmake | 只编译，不运行 | `TradeBot`/`china_ors_extreme`/`mdreceiverX` 链接成功 |
| L1 GUI 空跑 | DataService + GUI | 只跑 `dataservice configService.xml`（不跑 stream/ORS） | GUI 能登录 20000，表格空但不崩 |
| L2 策略 Sim | TradeBot `--Sim` | `ExchSim`，不需要 SHM/ORS | 日志出现 `TradeBot started in Sim Mode`、指标/目标价 |
| L3 SHM stub | ORS/MD | 用 `infrastructure/Ipc` 写一个小程序：`createClientStore(727272)`、`createMarketDataClient(872/10201)`、`createResponseClient(4872)`，按 `MarketUpdateNew` 结构喂合成 tick | 策略 attach 成功，日志出现 `shmkey=...`、`GetIndicator` |
| L4 端到端 | 全部 | L3 + `RunStrategies.sh` + GUI | GUI 心跳、策略 `initComplete`、模拟下单 |

**L3 的注意点**：

- `MarketUpdateNew` 的布局必须与 `2/include/illuminati/dev_multi` 的头一致；用同一套头编译，不要手写字节偏移。
- `ShmManager::createMarketDataClient` 是 owner 侧；策略用 `registerMDClient` attach。先启动 stub，再启动策略。
- `ORSServer` 的 response 消息需要 `ResponseMsg` 布局；如果只验证行情/指标，可以先不喂 response，策略会停在“等回报”。
- 不要用 `ipcmk` 代替；它只创建裸段，没有队列头，策略 attach 会失败。

**L1 的注意点**：

- `dataservice configService.xml` 会读 `passwordfile.xml`、`accesscontrol.xml`、`inst_def_cme.csv`；`inst_def.csv` 为空也能启动，但 China 合约元数据缺失。
- GUI 仍需要 `GuiSettings.xml`（15213/34 槽）和 `Position.csv`（可删/清空，避免僵尸行）。
- 没有 stream 时，GUI 的 MD/PNL collector 可能等 30 秒；属正常。

**L2 的注意点**：

- `--Sim` 仍需 `--configFile`；`config_CHINA_CME.cfg` 的 `INTERACTION_MODE=LIVE` 会被命令行模式覆盖（`main.cpp` 的 `GetMode`）。
- `--Sim` 不创建 ORS SHM；`Connector` 走 `ExchSim` 分支（`connector.cpp:169-178`）。
- 用 `controls/` 里的 China control（不是源码树自带的 NSE sample）。

### 8.5 验收命令

```bash
# SHM
ipcs -m | grep -E '727272|3872|4872|872|10201'

# 端口
ss -lntp | grep -E '20000|1732|1733|15213|153[0-3][0-9]|7776|7777'

# ORS
tail -F /home/infra/prod/log/extremeors-log-$(date +%Y%m%d)-*.log
# 期望：Starting China MD and ORS component / OnRspUserLogin / ErrorCode=[0]

# 接收机
tail -F /home/re/cme.recv.quincy.data.cfg.*.log
# 期望：Binding datagram socket to 12345...Succcess / Creating new book builder

# 策略
tail -F /home/TradeBot/log/log.live.control.*.log
# 期望：TradeBot started in Live Mode / GetIndicator / Indicator Level

# GUI
tail -F /home/GUI/SH/SkylineGUI-*.log
# 期望：Init heartbeat 15300 / recv [15300|heartBeat#15300]
```

### 8.6 不要碰的东西

| 路径 | 原因 |
|---|---|
| `3/piyush/ORS_CHINA_extreme/log/position.csv` | 唯一持仓状态；覆盖=第二天仓位错 |
| `3/TradeBot/controls`、`models`、`bckp` | 生产配置/模型；`copymodels` 会改日期 |
| `3/TradeBot/TradeBot_China/.svn` | 干净 r2375 基线；不要 `svn revert`/`clean` |
| `3/dalong/infrastructure/.git` | 1287 项 dirty；`git checkout .` 会丢厂商 SDK 修改 |
| `3/GUI/SH/*.log`、`*.csv` | 运行证据；只读 |
| `3/jfs/**/*.ini` | 含明文柜台凭据；不要外发 |
| `2/` 整盘 | 只读证据；不要原地写 |

---

## 9. 证据索引（可复现）

| # | 命令/文件 | 证明 |
|---|---|---|
| E1 | `cat 2/etc/issue; grep -n 'Linux version\|Brought up 48\|Memory:' 2/var/log/dmesg` | CentOS 6.6 / 48 CPU / 32 GB |
| E2 | `cat 2/etc/fstab; cat 2/etc/mtab` | root/home LV 布局 |
| E3 | `nl -ba 2/var/spool/cron/root; nl -ba 2/var/spool/cron/jfs` | 启动/停机 cron |
| E4 | `grep -n 'Jul 24.*receive\|Jul 24.*runORS\|Jul 24.*startAll' 2/var/log/cron` | 7/24 实际执行时序 |
| E5 | `nl -ba 3/infra/prod/scripts/runORS_extreme_new.sh` | ORS 启动/ipcrm |
| E6 | `nl -ba 3/infra/prod/config/prod.china.ors_new.cfg \| sed -n '28,52p'` | SHM/端口/亲和/持仓文件 |
| E7 | `diff -u 3/infra/prod/config/prod.china.ors_new.cfg.bak 3/infra/prod/config/prod.china.ors_new.cfg` | 7/13 网关地址/账号变更 |
| E8 | `nl -ba 3/re/receive_new.sh; nl -ba 3/re/receive.shBak; nl -ba 3/re/cme.recv.quincy.data.cfg` | 两套接收脚本 + 10201 |
| E9 | `head -20 3/re/nohup.out; head -10 3/re/...20150724-08.55.01...log` | 接收机 attach 旧 SHM / SO_REUSEADDR |
| E10 | `nl -ba 3/TradeBot/livescripts/RunStrategies.sh; nl -ba 3/TradeBot/livescripts/CopyControlsModels` | 策略启动/日切 |
| E11 | `nl -ba 3/infra/dataservice_deploy/restart.sh; nl -ba configService.xml; nl -ba configStream_CTP.xml` | DataService 三层/端口 |
| E12 | `nl -ba 3/GUI/SH/runChinaGui.sh; grep -n ServerPort 3/GUI/SH/GuiSettings.xml` | GUI 启动/15213 |
| E13 | `head -25 3/GUI/SH/SkylineGUI-20150724-08.12.49.log; tail -10 ...` | GUI 启动/关闭/心跳停止 |
| E14 | `nl -ba 3/TradeBot/TradeBot_China/main/main.cpp \| sed -n '90,164p;683,689p'` | 信号/pid 路径 |
| E15 | `nl -ba 3/dalong/infrastructure/Connector/src/connector.cpp \| sed -n '53,90p'` | 策略 attach SHM 的顺序 |
| E16 | `nl -ba 3/dalong/infrastructure/Ipc/include/shmmanager.h \| sed -n '256,300p;738,757p'` | initClientStore/registerMDClient/单线程 |
| E17 | `nl -ba 3/TradeBot/TradeBot_China/main/Makefile` | 绝对 `/include`/`/bld`/`libsnappy` |
| E18 | `nl -ba 3/TradeBot/TradeBot_China/Tradebot.sln; grep -n 'D:\\\\shiva\|pthreadVC2' Tradebot.vcxproj` | VS2010 legacy |
| E19 | `nl -ba 3/dalong/infrastructure/SConstruct \| sed -n '41,70p;339,347p'` | SCons project/mode |
| E20 | `nl -ba 2/bld/build_dev_multi.20150330_1447/China/build.py \| sed -n '39,66p'` | CTP 注释 / extreme 活动 |
| E21 | `nl -ba 2/bld/build_dev_multi.20150330_1447/MDReceiverX/build.py \| sed -n '57,69p'` | MD 变体 |
| E22 | `head -25 3/dalong/FromDaya/SkylineFL_GUI/Makefile; nl -ba SkylineFL_GUI.pro` | Qt5 qmake/rpath/源列表 |
| E23 | `git -C 3/dalong/infrastructure log -1; git status --porcelain \| wc -l` | HEAD 6efe348f / 1287 dirty |
| E24 | `file 3/GUI/SH/SkylineFL_GUI 3/TradeBot/.../TradeBot 3/re/mdreceiverX 3/infra/prod/bin/china_ors_extreme_new` | BuildID/时间 |
| E25 | `du -sh 3/GUI/SH 3/infra/prod/log 3/infra/dataservice_deploy 3/re 3/leon/log` | 磁盘/日志 |
| E26 | `nl -ba 2/etc/sysconfig/vncservers; nl -ba 2/root/.vnc/xstartup; grep -n 'VNC server' 2/var/log/boot.log` | VNC |
| E27 | `grep -n 'tradegate.*segfault' 2/var/log/messages` | 7/20 网关崩溃/重启 |
| E28 | `nl -ba 3/TradeBot/.bash_history \| sed -n '1,60p'` | 实际 make/pkill/SIGTSTP |

---

## 10. 结论与 5 个开放问题

### 10.1 结论

- **能复刻“行为”，不能复刻“字节”**：源码、构建快照、运行二进制三者都不同步；任何“重编即等价”的说法都不成立。
- **启动顺序是硬约束**：策略在 ORS/MD 之前必死（attach SHM 抛异常）；GUI 在 DataService 之前会长时间无响应；网关在 ORS 之前会让 ORS 登录失败。
- **停机没有优雅路径**：cron 全是 `kill -9`；唯一的安全模式是手工 `SIGTSTP` 先平仓，再 `-9`。
- **运维靠人**：VNC、cron、`ps/grep`、手工清日志；没有 supervisor、没有告警、没有日志轮转。
- **最该先救的资产**：`3/piyush/.../position.csv`（唯一持仓）、`3/TradeBot/controls|models`（策略配置）、`3/dalong/FromDaya/SkylineFL_GUI`（无版本控制的 GUI 源码）、`3/dalong/infrastructure/.git`（唯一有历史的 infra 仓库）。

### 10.2 5 个开放问题

1. **`receive_new.sh` 到底为什么失败？** 归档脚本的 `taskset -c -p 8` 在标准 util-linux 上必失败，但 7/22–7/24 的接收日志又证明每天 08:55:07 有进程启动。是当时 `/bin/taskset` 被替换/包装，还是操作员绕过了脚本？需要原机器的 `history`/`ps`/`/proc/<pid>/cmdline` 才能定论。
2. **7/24 实际跑的是 `mdreceiverX` 还是 `mdreceiverX_bothfeeds`？** cron 指向 `receive_new.sh`→`mdreceiverX`，但 `receive.shBak`→`bothfeeds` 的存在说明发生过回滚。日志不记录二进制 BuildID；需要当时进程的 `/proc/<pid>/exe` 或 `md5`。
3. **r2375 之后 TradeBot 改了哪些没提交的代码？** 线上 `main/TradeBot` 是 6/17，源码 r2375 是 6/10；`.bash_history` 显示 6/10 后还在改 `ExecutionStrategy.cpp`/`AggressiveStrategy.cpp`。没有 diff，无法判断线上行为与 r2375 的差异。
4. **ORS 从直连 `192.168.1.1` 切到本地 `127.0.0.1:7776/7777` 是谁、何时、为什么切的？** `prod.china.ors_new.cfg.bak`（4/27）还是直连，当前配置（7/13）是本地网关；这决定了网关 `startfs` 是不是 ORS 的硬依赖。需要变更单/操作员确认。
5. **Qt4 `TradingSystemsGUI` 在 7 月到底是什么角色？** 它每天和 Qt5 同时创建日志，但 146/148 个日志是 0 字节；是失败的旧启动器、人工兜底，还是某个脚本仍在拉它？需要当时的 `ps`/cron/桌面快捷方式确认。

---

### 附：一句话运维口诀

> **网关先起，持仓先拉；ORS 再起，行情随后；策略最后，GUI 随意；平仓用 TSTP，杀进程用 -9；改脚本先改 cron，删 SHM 先杀进程。**

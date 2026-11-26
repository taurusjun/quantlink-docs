# 00 — 磁盘清单：布局、源码 vs 运行 vs 备份、版本谱系

> 调查对象：`/Volumes/DevDisk/146`（用户口中的 `/DevDisk/146`），只读。
> 输出：`/Users/wangjun/PG/quantlink-new/146/00-inventory.md`
> 证据标记：**V** = 直接读到（文件/命令输出），**I** = 由结构/时间戳/日志推断，**P** = 假设/无法验证。
> 不含任何口令、密钥、Token；只记录位置与风险。

---

## 0. 一页结论

| 位置 | 是什么 | 大小 | 判读 |
|---|---|---|---|
| `1/` | 空目录 | 0 B | **忽略**（可能是备份工具预留的空槽位）[V] |
| `2/` | 一台 CentOS 6.6 主机的**根文件系统**（LVM `lv_root`） | 17 GB / 175,017 文件 | **操作系统镜像**，不是源码；但内含 3 的完整副本（见 §2.2） |
| `3/` | 同一台主机的**/home 数据盘**（LVM `lv_home`） | 58 GB / 59,737 文件 | **全部源码、运行数据、备份、其它用户目录的所在地** |

一句话：**源码的权威副本在 `3/`；`2/` 是"能开机的运行盘 + 一份迟到的拷贝"；两者拼起来才是完整的一台 2015 年生产机（hostname `685`，上海，222.72.161.42）。**

关键权威结论（详细见 §4、§5、§9）：

1. **TradeBot 源码权威** = `3/TradeBot/TradeBot_China`（SVN r2375，2015-06-10，作者 avijit）。`2/TradeBot/TradeBot_China` 与之**逐字节相同**（`diff -rq` 无输出）[V]。
2. **TradeBot 运行态权威** = `3/TradeBot/{controls,models,log,livescripts,bckp}`（数据到 2015-07-25）。
3. **GUI 源码权威** = `3/dalong/FromDaya/SkylineFL_GUI`（Qt5.3.1）+ 共享控件源 `3/dalong/infrastructure/TradingSystemsGUI`（git 跟踪）。
4. **GUI 部署权威** = `3/GUI/SH`（Qt5.3.1 运行时，二进制 2014-12-21，比源码旧约 3 个月）。
5. **不要信任** `2/dalong/infrastructure`（不完整）、`3/infra/TradingSystemsGUI`（被 Qt5 取代的 Qt4 运行时）、任何 `*.o`/`Tradebot.sdf`/`*.suo`。

---

## 1. 证据规则与不可信项

- 备份盘是 **APFS**（`diskutil info /dev/disk7s1`：1.0 TB，`/Volumes/DevDisk`，挂载选项 `noowners`）→ **所有文件 uid/gid 被压平成 `501:20`**，`ls -l` 的属主不可用；只能靠 `2/etc/passwd`、`tar -tv` 里的名字、`.bash_history` 恢复"谁"。[V]
- 因此本文**不用属主**做证据，只用：文件内容、`file`、ELF BuildID、SVN/git 元数据、路径、mtime、日志。
- **mtime 不可盲信**：`/opt/Qt5.3.2` 全部文件时间是 2012-09-16，但该 Qt 版本的内部构建串是 `Qt 5.3.2 (Sep 11 2014, ...)`[V] —— 说明机器时钟曾错位约 2 年，或归档时保留了原始时间戳。凡是"只靠 mtime"的结论都标了 **I**。
- 未运行任何二进制；只用了 `file`、`strings`、`md5`、`tar -t/-O`、`diff`、`git log`。

---

## 2. 顶层 `1/ 2/ 3/`

### 2.1 尺寸与文件系统证据

| 目录 | `du -sh` | 文件数 | 目录 mtime | 判定 |
|---|---|---|---|---|
| `1/` | 0 B | 0 | 2015-07-25 11:21 | 空占位 [V] |
| `2/` | 17 GB | 175,017 | 2015-07-26 15:35 | 根 FS [V] |
| `3/` | 58 GB | 59,737 | 2015-07-26 03:24 | /home FS [V] |

`2/` 是根 FS 的直接证据（全部 V）：

- `2/etc/issue:1` → `CentOS release 6.6 (Final)`；`2/root/install.log`、`anaconda-ks.cfg` 为 2012-09-10 装机产物。
- `2/etc/fstab:9-12` → `VolGroup-lv_root /`、`UUID=06efe4a7-… /boot`、`VolGroup-lv_home /home`、`lv_swap`。
- `2/etc/sysconfig/network:2` → `HOSTNAME=685`。
- `2/etc/sysconfig/network-scripts/ifcfg-eth0:8` → `IPADDR=222.72.161.42`（上海电信段）。
- `2/var/log/messages:35`（2015-07-20 08:30:13）→ 内核命令行 `ro root=/dev/mapper/VolGroup-lv_root … rd_LVM_LV=VolGroup/lv_root`；`:1022/:1311/:1312` → `dm-0`(root)、`sda1`(/boot)、`dm-2`(/home) 依次挂载。
- `2/lost+found/` 存在（ext4 根）；`2/home/` 是空目录且 mtime = 2012-09-10（**装机后从未写入**）。

`3/` 是 /home 的直接证据（V）：

- 顶层有 `lost+found/`（mtime 2012-09-10）→ 它自己就是一个 ext4 文件系统根。
- **没有 `etc/ bin/ usr/ lib64/`**，只有用户数据；`2/etc/passwd` 的非系统用户 `jfs:500`、`TradeBot:501`、`Midas:502`、`leon:503` 与 `3/` 下的 `jfs/ TradeBot/ Midas* leon/` 一一对应。
- 运行脚本硬编码 `/home/...`：`3/GUI/SH/runChinaGui.sh:1-2` → `export LD_LIBRARY_PATH=/home/GUI/SH/` + `/home/GUI/SH/SkylineFL_GUI`；`3/TradeBot/log/log.live.control.GOLD_F_0_SFE.noon.agg.20150630:5` → `configFile : /home/TradeBot/TradeBot_China/Connector/config_CHINA_CME.cfg`。

### 2.2 `2/` 为什么"不像"纯根 FS

`2/` 顶部同时出现 `TradeBot/ TradeBot.bak/ GUI/ dalong/ infra/ bld/ include/ opt/Qt5.3.2/`，而 `2/home/` 是空的。经 `diff -rq` 验证：

| `2/` 下 | 对应 `3/` 下 | 结果 | 空间 |
|---|---|---|---|
| `2/TradeBot`（10,296 文件/778 M） | `3/TradeBot` | **完全相同**（`diff -rq` 零输出） | 重复 778 M |
| `2/TradeBot.bak`（9,472/1.0 G） | `3/TradeBot.bak` | **完全相同** | 重复 1.0 G |
| `2/GUI`（9.0 G） | `3/GUI` | **完全相同**（排除 `*.log *.csv *.swp`） | 重复 9.0 G |
| `2/dalong`（521 M） | `3/dalong`（1.4 G） | **不完整**：只有 `infrastructure/`，且缺 `.build_debug/.build_release` 等 | 过期副本 |
| `2/infra`（3 文件/244 K） | `3/infra`（3.3 G） | 只有 `prod/{bin,config,scripts,log}` 骨架 | 过期副本 |

判读（**I**，两种可能，本文倾向第二种）：

1. 原机器的 `/TradeBot` 等是 **bind mount**，备份时被展开成实体目录 —— 但 `2/dalong/infrastructure` 与 `3/` 内容不一致，bind mount 解释不通；
2. **有人在 7/25–7/26 用 `cp -a` 把 /home 里"要紧的"目录拷到根盘上**，为的是"只恢复根盘也能跑"。支持证据：两侧目录 mtime 完全一致（`2/TradeBot` 与 `3/TradeBot` 都是 `2015-06-17 11:31`，`2/GUI` 与 `3/GUI` 都是 `2014-12-11 12:15`，`2/TradeBot.bak` 与 `3/` 都是 `2015-02-28 18:50`）→ 典型的 `cp -a` 保时间戳签名；而 `2/dalong`(4/27) 与 `2/infra`(2/11) 的目录时间与 `3/` 不同 → 是**更早、另外一次、且不完整**的拷贝。备份盘两个顶层目录的写入次序也吻合：`3` 先（7/26 03:24），`2` 后（7/26 15:35）。

> 影响：`2/` 里那 11 GB 是**纯冗余**；但 `2/bld`、`2/include`、`2/opt/Qt5.3.2` 是**唯一的构建产物/SDK**，不能一起丢（见 §6.2）。

---

## 3. 主源码树：`3/TradeBot/TradeBot_China` vs `2/TradeBot/TradeBot_China`

### 3.1 规模

| 项 | `2/.../TradeBot_China` | `3/.../TradeBot_China` |
|---|---|---|
| 文件 / 目录 | 6,260 / 675 | 6,260 / 675 |
| 体积 | 752 M | 752 M |
| `.cpp` / `.h` | 250 / 239 | 250 / 239 |
| `.o` 目标文件 | 224 | 224 |
| `.svn` 目录 | 75 | 75 |
| `diff -rq` 全树 | — | **无差异**（同盘顺序读，2.3 s 跑完）[V] |

`md5` 抽查：`Makefile f25a8fe6…`、`Tradebot.sln 13aedda5…`、`Tradebot.vcxproj 160d528e…`、`main/main.cpp 3ce53a1b…` —— 两侧一致 [V]。

### 3.2 SVN 元数据（这是全套档案里最硬的版本证据）

`3/TradeBot/TradeBot_China/.svn/entries`（format 10，SVN 1.6 风格）[V]：

```
1   10
3   dir
4   2375
5   svn+ssh://TradeBot@10.30.49.7/TradeBotRepository/TradeBot_Multi
6   svn+ssh://TradeBot@10.30.49.7/TradeBotRepository
10  2015-06-10T10:09:45.394484Z
11  2375
12  avijit
```

- 工作副本根 URL 是 `…/TradeBot_Multi`，**但本地目录叫 `TradeBot_China`** → 是 `svn co <url>/TradeBot_Multi TradeBot_China` 的产物；上游并没有 "China" 这个名字。[V/I]
- 逐目录 revision 不等（212–2375）：`Config` r1819、`controls` r1560、`models` r1552、`Indicators` r2373、`Strategies` r2375、`Connector` r2354、`data` r2372 —— 说明 **运行配置（controls/models/Config/data）也被提交进 SVN**，而不是纯代码库。[V]
- 只有 75 个 `.svn/`（675 个目录）→ 工作副本被裁剪过（或缺 `--depth infinity` 的部分），但 `text-base` 齐全。
- 抽查 `main/main.cpp`、`main/Makefile`、`Strategies/Makefile`、`Tradebot.sln` 与各自 `.svn/text-base/*.svn-base` **逐一 `cmp` 相同** → **工作副本是干净 checkout，没有本地改动**，可当"源码真相"。[V]

### 3.3 构建系统

- 顶层 `Makefile`（579 B，17 行）：`ll` 目标依次 `make` `common → Indicators → Strategies → main`；`clean`/`debug` 同理。`Connector` **没有 Makefile**，它只是 47 个 `config_*.cfg`（`Connector/` 下 0 个 cpp）——**Connector 库来自 infrastructure**。[V]
- `main/Makefile`：
  - `:5` `INFRAPATH=/include/illuminati/dev_multi`
  - `:9/:12/:16` `LDFLAGS = … -L/bld/dev_multi ../Strategies/*.o -lconnectormwmr -llogger -lxsim -ldatamanip -lcommonutils -lpthread -lrt /usr/local/lib/libsnappy.a ../common/*.o ../Indicators/*.o -DDEBUGX -lz -lxsimdataserver`
  - `:15` `CFLAGS=-std=c++0x -O3 -w …`
  - `:75-80` 四个产物：`TradeBot`、`watchMarket`、`get_symbol_on_date`、`startDataServer`
  → 与 `2/include/illuminati/dev_multi`、`2/bld/dev_multi` **严丝合缝**：这套源码的构建依赖正指向这台机器的 `/include` 与 `/bld`。[V]
- Windows 侧：`Tradebot.sln` 是 `Format Version 11.00 / # Visual C++ Express 2010`，**只有一个工程、只有 Win32**（无 x64）[V]；`Tradebot.vcxproj` ToolsVersion 4.0；另有历史遗留 `Tradebot.vcproj`+`.sln.old`+`.suo.old`。
- `UpgradeLog.XML` 记录了 2012-12-22 从 `D:\shiva\TradeBot_Russia_Code\TradeBot_Russia_Code\Tradebot.sln` 由 VC2008 工程升级到 VS2010 —— **代码库的祖先是 "TradeBot_Russia"**。[V]

### 3.4 源码完整性判定

| 子项目 | cpp | h | 说明 |
|---|---|---|---|
| `common` | 18 | 16 | 基础类型/工具 |
| `Indicators` | 172 | 173 | 指标库，345 个子目录（含 `include/`） |
| `Strategies` | 40 | 41 | 策略实现（含 2015 年新增的 `CommsPassive/FAK/Hit/Sweep/DepAggressivePassive` 等） |
| `main` | 7 | 5 | `main.cpp`(1077 行) `CommonClient.cpp`(45 KB) `TradeBotUtils.cpp`(160 KB) 等 |
| `Tools`/`regress` | 2/11 | 0 | 工具与回归 |
| `Connector` | 0 | 0 | 仅配置，库在 infra |
| `scripts` | 0 | 0 | 335 个 perl/py/sh（运维脚本，值得单独归档） |
| `windows` | 0 | 4 | Windows 兼容层 |

结论：**业务源码齐全、结构自洽**，但**离开 `/include/illuminati/dev_multi` + `/bld/dev_multi` 无法链接**（本次未编译，只做静态核对）。它不缺业务源码，缺的是外部头文件与静态库（本磁盘的 `2/include`、`2/bld` 里正好有）。

---

## 4. `TradeBot` vs `TradeBot.bak` vs `tempTradeBot`

### 4.1 构成对照

| | `3/TradeBot` | `3/TradeBot.bak` | `3/tempTradeBot` |
|---|---|---|---|
| 体积 / 文件 | 778 M / 10,296 | 1.0 G / 9,472 | 848 M / 6,133 |
| 目录 mtime | 2015-06-17 | 2015-02-28 | 2015-03-02 |
| 源码子目录 | `TradeBot_China`（SVN r2375） | `TradeBot_Multi`（r1936） | `TradeBot/TradeBot_Multi`（r2023） |
| `controls` | **2,006** 个，20150209–20150725 | 29 个，20150301–20150427 | 47 个，20150209–20150427 |
| `models` | 1,958 个 | 13 个 | 45 个 |
| `log` 内容 | 12 项，行情/策略日志到 20150630 | 65 项，20150209–20150427 | 98 项，20150209–20150427 |
| 二进制 | `main/` 下 9 个构建快照 | `TradeBot_sliver`（3.06 MB ELF，2015-02-13） | 无（只有 tarball） |
| 其它 | `bckp/`（2015-07-24 的 control 备份）、`.bash_history`(32 KB) | `bak20150212/`、空的 `TradeBot/` | `TradeBot_20150213.tar.gz`(158 M)、`TradeBot_20150302.tar.gz`(87 M) |

### 4.2 三代 SVN（同一条谱系，换过仓库主机）

| 工作副本 | 仓库 URL | rev | 日期 | 作者 |
|---|---|---|---|---|
| `3/TradeBot.bak`（根 WC） | `svn+ssh://TradeBot@192.168.0.31/TradeBotRepository/TradeBot_Multi` | 1918 | 2015-02-05T08:28:02Z | `TradeBot` |
| `3/TradeBot.bak/TradeBot_Multi` | 同上 | 1936 | 2015-02-11T08:45:21Z | `shiva` |
| `3/tempTradeBot/TradeBot/TradeBot_Multi` | 同上 | 2023 | 2015-02-26T05:11:56Z | `avijit` |
| **`3/TradeBot/TradeBot_China`** | **`…@10.30.49.7/…`** | **2375** | **2015-06-10T10:09:45Z** | **`avijit`** |
| `3/ttt.tar.gz`（归档） | `192.168.0.31`… | 1918 | 2015-02-05 | `TradeBot` |

→ **仓库在 2015-02-26 之后、06-10 之前从 `192.168.0.31` 迁到 `10.30.49.7`**（两个都是内网/专线地址），rev 连续（1918→1936→2023→2375），说明是同一 SVN 的搬迁而非新建。[I]

### 4.3 谁是"最新/权威"

- **源码权威**：`3/TradeBot/TradeBot_China`（r2375）。理由：rev 最高、工作副本与 `text-base` 一致（无本地改动）、`main.cpp` 最长（1077 行）、策略类型最多。
- **运行权威**：`3/TradeBot`（controls 到 20150725、`bckp/` 到 20150724）。日志 `…20150630:5` 证明它就是用 `TradeBot_China` 编出来的。
- **历史档**：`TradeBot.bak`（r1936）与 `tempTradeBot`（r2023）**只应作为差异对照**，不要当成可运行系统（缺新策略、缺 `-lxsimdataserver`）。
- **`TradeBot_sliver`** 是一个单独的 ELF（3,063,965 B，BuildID `1bfb9b7e…`），与 `main/TradeBot` 系列都不同 → 早期"细长版"实验产物，**是二进制不是源码**。[V]

### 4.4 版本漂移（`diff -u` 实测，非全树）

`main/main.cpp` 行数：`938 (r1936) → 951 (r2023) → 1077 (r2375)` [V]

- r1936→r2023：新增 `#include "CommsPassiveStrategy.h"`，新增 `TB_COMMS_STRAT` 与 `TB_SIMPLEAGGRESSIVE_STRAT` 两个策略分支。
- r2023→r2375：新增 `DepAggressivePassive / PassiveStrategyAE / Sweep / FAK / SimpleHedging / Hit` 六个策略；删除全局 `bool DateConfig::m_simActive;`；`MDCallBack` 分派逻辑改写。
- `main/Makefile`：r2023 里还有 `ifeq ($(PARALLELSIM),1) … -DPARALLEL … -lxsimdataserver` 的开关，r2375 **整段删除**并改为**无条件** `-lxsimdataserver`；优化档加了 `-w`。顶层 `Makefile:5` 同步去掉了 `PARALLELSIM=$(PARALLELSIM)`。
- `Connector/config_CHINA_CME.cfg`：**三代完全相同**（diff 无输出）→ 这份联调配置从 2 月到 6 月没动过。[V]

---

## 5. Qt 前端四条线

### 5.1 谱系

```
infrastructure/TradingSystemsGUI  (git 跟踪, 58 文件, 2014-01→2014-10, vikas)
   │  共享控件源: MDCollector/PNLCollector/ManualOrderSender/PlaceOrderWidget/
   │              DataCollector/OrdersCollector/SquareOffAllDialog
   ├── TradingSystemsGUI.pro (Qt4/Qt5 兼容垫片) ──► 3/infra/TradingSystemsGUI
   │        Qt 4.8.6 随包, 二进制 2014-09-26 (Mainwindow.cpp)      [旧运行态]
   └── SkylineFL_GUI.pro    (Qt 5.3.1)          ──► 3/GUI/SH
            二进制 2014-12-21 (Container.cpp/Strategy.cpp)          [线上部署]
            └── 3/dalong/FromDaya/SkylineFL_GUI/SkylineFL_GUI 2015-03-19
                    (自己编的最新版, 未部署)
```

### 5.2 `3/dalong/FromDaya/SkylineFL_GUI` — **Qt5 源码（权威）**

- 60 文件 / 3.2 M；`SkylineFL_GUI.pro`（100 行），头注释 `Project created by QtCreator 2014-08-08T16:21:57`[V]。
- `.pro:9` `greaterThan(QT_MAJOR_VERSION, 4): QT += widgets` → Qt5 优先；`.pro:19-26` 的 `INCLUDEPATH` 全部指向 `$$(HOME)/infrastructure/{DataService,Networks,Logger,CommonUtils,Ipc,LibSecurity,SysUtils,TradingSystemsGUI}`；`.pro:31` `INFRA = $$(HOME)/infrastructure/TradingSystemsGUI`；`.pro:52-58` 直接编译 `$$INFRA/*.cpp` → **它复用旧 GUI 的控件层，不是 fork 一份 copy**。[V]
- `Makefile`（1,160,013 B，qmake 生成）头三行给出铁证：
  `# Generated by qmake (3.0) (Qt 5.3.1)` / `# Command: /home/dalong/Qt5.3.1/5.3/gcc_64/bin/qmake -o Makefile SkylineFL_GUI.pro`；`LFLAGS` 里 rpath 固定 `/home/dalong/Qt5.3.1/5.3/gcc_64`。[V]
- 源码目录里同时躺着一个 2015-03-19 的 1,862,816 B 二进制（BuildID `1aecd50d…`）→ 该目录**既是源码树也是本机构建目录**。
- `Main.cpp:63` `std::string configPath("./GuiSettings.xml")` → 配置必须与二进制同目录（cwd 敏感）。

### 5.3 `3/dalong/infrastructure/TradingSystemsGUI` — **源码（Qt4/Qt5 双兼容）**

- 58 文件 / 332 K，**全部被 git 跟踪**（`git ls-files TradingSystemsGUI | wc -l` = 58）；最后一次改动 `345637ee 2014-10-07 vikas "removed showing of junk in market data widget"`。[V]
- `VersionHeaders.h:4-12` 是典型的双版本垫片：
  `#if (QT_VERSION >= 0x050000) … setSectionResizeMode / setSectionsMovable … #else … setResizeMode / setMovable`；`:14-18` 还有 `QT_VERSION < 0x040700` 的 placeholder 分支 → **支持 Qt4.6 起**。[V]
- 项目创建时间 `2014-01-29T14:11:34`（`.pro:3`）。

### 5.4 `3/infra/TradingSystemsGUI` — **Qt4 运行态（已被取代）**

- 155 文件 / 17 M；随包 `libQtCore.so.4.8.6` / `libQtGui.so.4.8.6` / `libQtNetwork.so.4.8.6`（2014-08-21）+ `TradingSystemsGUI`（533,963 B，2014-09-26）+ `TradingSystemsGUI.Old`。
- 二进制里嵌的源文件名是 `Mainwindow.cpp`（不是 `Container.cpp`）→ **它是旧 GUI，不是 SkylineFL**。[V]
- `runGUI.sh:4` `taskset -c 15 ./TradingSystemsGUI`（`:2` 只设 `LD_LIBRARY_PATH=.`）；`FrontEndConfig.xml:4` `AutoSave path="/home/punit/pnl/"` → 早期使用者是 punit/punit。[V]
- **148 个日志文件，其中 146 个精确为 0 字节**；只有 `20150504-20.42.41.log`(552 K) 与 `20150608-08.57.19.log` 有内容。最后几个空日志：`20150724-08.12.47.log`、`20150724-20.36.07.log` —— 与 Qt5 GUI 的 `SkylineGUI-20150724-08.12.49.log` 几乎同一秒启动 → **两套 GUI 每天被同一个脚本各拉一次，Qt4 那套只创建空日志**（未能初始化/立即退出）。[V/I]

### 5.5 `3/GUI/SH` — **部署态（Qt5.3.1，线上）**

- 100 文件 / **9.0 G**（几乎全是日志）。Qt5 运行库：`libQt5Core/Gui/Widgets/Network/DBus.so.5`（2014-11-19）、`libicu*.so.52`、`platforms/libqxcb.so`、`libzmq.so.3.1.0`。
- 版本铁证：`strings libQt5Core.so.5` → `Qt 5.3.1 (Jun 19 2014, GCC 4.6.1, 64 bit, release build)`。[V]
- 二进制：`SkylineFL_GUI` 1,882,103 B / 2014-12-21 / BuildID `a2e432bd…`；`SkylineFL_GUI.bak` 1,882,007 B / 2014-12-03 / `5f15f309…`；`a.out` 1,767,638 B（11-19）。
- `GuiSettings.xml`（2014-12-03）：`<ServerPort>15213</ServerPort>`；`<Strategy>` **34 条**、`<Port>` 34 个，区间 `15300–15333`（步长 1）。对比源码树同名文件：`ServerPort` 仍是 `15150`，且**没有任何策略条目** —— 部署版是运行期补齐的超集。[V]
- 运行痕迹：50 个 `*.csv`（20150505–20150724，首行如 `ag1512,AG,15,1.5`，合约/交易所/手数/最小变动快照）；25 个 `SkylineGUI-*.log`（2015-07-13 → 07-24，单文件 0–606 MB）；`.CLog.swp`（vim 7.2，`root@w2w-shanghai`，路径 **`/home/dalong/SH/CLog`**，2014-11-19）→ **该目录是从 `w2w-shanghai` 主机的 `/home/dalong/SH` 整体搬过来、后改名为 `/home/GUI/SH` 的**。[V/I]

### 5.6 版本/新鲜度对照（关键差异）

| 产物 | Qt | 构建/落盘 | BuildID | 与源码关系 |
|---|---|---|---|---|
| `3/GUI/SH/SkylineFL_GUI` | 5.3.1 | 2014-12-21 | `a2e432bd` | **比源码旧**：源码树自编版本是 2015-03-19 |
| `3/dalong/FromDaya/SkylineFL_GUI/SkylineFL_GUI` | 5.3.1 | 2015-03-19 | `1aecd50d` | 源码树本机构建，**未见部署** |
| `3/GUI/SH/SkylineFL_GUI.bak` | 5.3.1 | 2014-12-03 | `5f15f309` | 上一版 |
| `3/infra/TradingSystemsGUI/TradingSystemsGUI` | 4.8.6 | 2014-09-26 | `76f8f101` | 旧 GUI（Mainwindow.cpp） |
| 系统 Qt（CentOS6） | 4.6.2 | 装机自带 | — | `2/usr/lib64/libQtCore.so.4.6.2`，无人使用 |

**结论：线上 GUI 是 2014-12-21 的构建，落后源码约 3 个月；2015-03-19 的构建从未出现在 `/home/GUI/SH`。** 这是本档案里最大的"源码 vs 运行"漂移。[V/I]

---

## 6. 基础设施与工具链

### 6.1 `3/dalong/infrastructure`（git，唯一有完整历史的仓库）

- 114 个子目录 / 115 个顶层条目；`.git` 完整；`SConstruct` + `Makefile`（Scons 构建）。
- `git log -1`：`6efe348f 2014-10-27 10:02:55 +0530 Salil "RMS bugfix"`；分支 `DEV`，`origin/DEV` 同点。[V]
- `git remote -v`：`ssh://Salil@14.140.97.104:2727/opt/git/infrastructure.git` → 提交者集中在 +0530 时区（Salil/Pratik/vikas/arun），推断为印度团队。[V/I]
- `git status` **不干净**：大量 `M`（`AlphaGrepOMXComponents/OMXApi/OSE/include/*.h`、`lib/libcrypto.so`、`liboapilnx.so`）→ 厂商 SDK 头文件/二进制被改动或换行被改，**不要 `git checkout .`**。[V]
- 关键子项目：`DataService`、`Connector`、`Ipc`、`Logger`、`CommonUtils`、`Networks`、`LibSecurity`、`SysUtils`、`TradingSystemsGUI`、`China`、`CME`、`BSE`、`NSE`、`Reuters`、`RFA`、`ORSBridge`、`TradingMonitor`。
- `TradingSystemsGUI` 只到 2014-10，之后 GUI 开发转到 `FromDaya/SkylineFL_GUI`（不在 git 里）→ **GUI 的新代码没有版本控制**，这是重大资产风险。[V]

### 6.2 `2/bld`、`2/include`、`2/bldBak`（infra 构建产物，唯一副本）

- `2/bld/`（471 M）：`dev_multi`（128 项）、`build_dev_multi.20150330_1447`、`dev_multi_20150330_1447`。
  `2/bld/dev_multi/` 内含 `libconnectormwmr.a`、`libconnector*.a`、`libxsim*.a`、`liblogger.a`、`libloggerso.so`、`libcommonutils.a`、`libcommonutilsso.so`、`libdatamanip.a`、`libxsimdataserver.a` 等 —— **正是 `main/Makefile:9` 里 `-l…` 要找的东西**。[V]
- `2/include/illuminati/dev_multi/`（+ `dev_multi_20150330_1447`）→ 对应 `INFRAPATH=/include/illuminati/dev_multi`。[V]
- `2/bldBak/`（347 M）：`dev_china`、`dev_china_20140930`、`dev_china_20141011`、`dev_multi_20141015_1403`、`dev_multi_20141127_2011`、`dev_old` + `prod.china.rms*.xml` → **两条 infra 分支（`dev_china` / `dev_multi`）的构建快照**，是"版本谱系"的物证。[V]
- `2/includeBak/illuminati/{dev_china, dev_china_20141011, dev_multi_20141015_1403, dev_multi_20141127_2011, dev_old, dev_china.tgz}` 与之配对。[V]

### 6.3 Qt SDK

| SDK | 位置 | 体积 | 安装时间证据 | 谁在用 |
|---|---|---|---|---|
| Qt 5.3.1 | `3/dalong/Qt5.3.1`（`5.3/gcc_64`） | 859 M | `InstallationLog.txt:1` `Invoked: Fri Sep 26 15:51:21 2014`，安装到 `/home/dalong/Qt5.3.1`；同文件 `:16` 记 `/` 仅剩 1.79 GiB、`/home` 剩 247.12 GiB | **SkylineFL_GUI 源码树 + `/GUI/SH` 运行库** |
| Qt 5.3.2 | `2/opt/Qt5.3.2`（`5.3/gcc_64`） | 863 M | 文件 mtime 全为 2012-09-16（时钟错位）；`InstallationLog.txt:1` 记 `Sat Sep 15 16:41:26 2012`；内部串 `Qt 5.3.2 (Sep 11 2014…)` | **未发现任何产物依赖它 → 归档/未使用** |
| Qt 4.8.6 | `3/infra/TradingSystemsGUI/*.so.4.8.6` | ~16 M | 2014-08-21 | 旧 GUI 运行态（随包分发，磁盘上无 SDK 安装） |
| Qt 4.6.2 | `2/usr/lib64/libQtCore.so.4.6.2` | — | CentOS 6.6 自带 | 系统库 |

→ **5.3.1 是"真用"的，5.3.2 是"装了没用"的**；别把 `/opt/Qt5.3.2` 当新版权威。[V/I]

### 6.4 运行侧 `3/infra`

| 子项 | 内容 | 时间 |
|---|---|---|
| `infra/prod/bin` | `china_ors_extreme_new`(630 K)、`china_ors_ctp`、`china_ors_extreme0426`、`*.bak` | 2014-11-27 → 2015-04-26 |
| `infra/prod/config` | ORS/chinanet 配置 | 2015-07-13 |
| `infra/prod/log` | 407 个 `cmd.ors_*` / `extremeors-log-*`，**2.4 G** | 到 2015-07-24 |
| `infra/prod/scripts` | `runORS_extreme_new.sh`、`runORS_ctp.sh`、`prod.recv.cme.sh`、`prod.china.start.distr.toCME2.src.sh` | — |
| `infra/dataservice_deploy` | `dataservice` + `dataservice_orig` + `dataservice_orig_dalong` + `dataservice.old` + `*.Old_1`（2014-09-11→09-30）+ 323 个日志 | 2014-09 → 2015-07 |
| `infra/re` | `cme.recv.quincy.data.cfg` + `mdreceiverX_bothfeeds` | 2015-02-11 |
| `3/re` | 87 个 CME 行情录制日志（另有 `log/ temp/`），20150602–20150724，40 M | 到 07-24 |
| `3/jfs` | `linux-64bin/{tradegate,quotgate,psp,pk,startfs,stopfs}` + 备份 tar（20141204 / 20150624），373 M | cron `7:15/19:15 startfs` |
| `3/leon` | **40 G**（`log/` 39 G、`CL/` 520 M 策略源码、`stats/` 320 M） | 到 2015-07-21 |

### 6.5 其它备份/归档（`3/` 顶层）

| 文件 | 大小 | 日期 | 内容判读 |
|---|---|---|---|
| `ttt.tar.gz` | 83 M | 2015-02-06 | `/home/TradeBot` 全量，内含 `.svn`（r1918） |
| `infrastruct20150427.tar.gz` | 366 M | 2015-04-27 | `infrastructure/` 源码树（无 `.git`） |
| `Midas.tar.gz` / `Midas_old.tar.gz` / `Midas20150521.tar.gz` | 35/101/35 M | 2015-07-02 / 05-21 | 另一个交易引擎 `Midas/CountingCards/TradeEngine`（SHFE/CME/LME），**独立系统，不属 TradeBot** |
| `re.bak/` | 240 K | 2015-02-11 | `mdreceiverX_bothfeeds` + cme cfg 的旧版 |
| `3/unknown/` | 933 M | 2014-11-26 → 2015-06-17 | **传输中转站**：`Qt5.3.1.tar.gz`(827 M)、`TradeBot20150617.tar.gz`(88 M, 9,388 项, owner `dayashankar`)、`SkylineFL_GUI.tar.gz`(1.2 M)、`tosendgui.tar.gz`(582 K)、pandas/numpy/scipy/ranger |
| `3/TradeBot.bak/bak20150212/` | — | 2015-02-12 | controls/models/livescripts/log + 一份 `TradeBot_Multi` 的定点快照 |

---

## 7. 权威路径地图（canonical map）

| 资产 | **源码真相 (SOT)** | 运行副本 | 备份 | 忽略 |
|---|---|---|---|---|
| TradeBot C++ | `3/TradeBot/TradeBot_China`（r2375） | `3/TradeBot/`（同一个 dir 兼作 run dir） | `2/TradeBot`（同字节）、`3/unknown/TradeBot20150617.tar.gz` | `3/TradeBot.bak`、`3/tempTradeBot`、`3/ttt.tar.gz`（仅作历史对照） |
| TradeBot 旧代源码 | `3/TradeBot.bak/TradeBot_Multi`(r1936)、`3/tempTradeBot/…`(r2023) | — | `3/ttt.tar.gz`(r1918) | — |
| TradeBot 运行配置 | `3/TradeBot/{controls,models,Config,livescripts}` | 同上（`~TradeBot` 目录即 home） | `3/TradeBot/bckp/`、`3/TradeBot.bak/bak20150212` | `.o`、`*.ncb/.sdf/.suo`、`ipch/` |
| TradeBot 二进制 | 可重建（需 §6.2 的头/库） | `3/TradeBot/TradeBot_China/main/{TradeBot,TradeBot_2015xxxx,…}` | 同左（快照文件） | `TradeBot_Print`（与 `TradeBot_20150427` 同 md5） |
| GUI 源码（新） | `3/dalong/FromDaya/SkylineFL_GUI` | — | `3/unknown/SkylineFL_GUI.tar.gz`(11-26)、`tosendgui.tar.gz` | 目录内 2015-03-19 的旧二进制（可作对照样本） |
| GUI 共享控件源码 | `3/dalong/infrastructure/TradingSystemsGUI`（git） | — | `infrastruct20150427.tar.gz` | — |
| GUI 部署（新） | — | `3/GUI/SH`（Qt5.3.1） | `2/GUI/SH`（同）、`2/GUI/TradingSystemsGUI.tar.gz`（2014-11 旧包） | `GUI/SH/*.log`（9 G）可压可删 |
| GUI 部署（旧） | — | `3/infra/TradingSystemsGUI`（Qt4.8.6） | `2/infra/prod`（残缺） | 146 个空日志 |
| infra 源码 | `3/dalong/infrastructure`（git，HEAD 6efe348f） | — | `infrastruct20150427.tar.gz`、`2/dalong/infrastructure`（**不完整，勿用**） | — |
| infra 构建产物 | 源码 + `SConstruct` | `2/bld/dev_multi` + `2/include/illuminati/dev_multi` | `2/bldBak/*`、`2/includeBak/*` | `2/bld/build_dev_multi.20150330_1447`（可重建） |
| ORS 运行时 | — | `3/infra/prod/{bin,config,scripts}` | `3/infra/prod/bin/*.bak` | `3/infra/prod/log`（2.4 G 日志） |
| 行情录制 | — | `3/re` | `3/re.bak`、`3/infra/re` | 日志 |
| Qt SDK | — | `3/dalong/Qt5.3.1`（用这个） | `3/unknown/Qt5.3.1.tar.gz` | `2/opt/Qt5.3.2`（未使用） |
| 其它用户 | — | `3/leon`（40 G 日志）、`3/jfs`、`3/pu`、`3/piyush` | `3/Midas*.tar.gz` | `3/leon/log`（39 G）、`3/.Trash-0` |
| `1/` | — | — | — | **全部忽略** |

---

## 8. 时间线（2012-09 → 2015-07）

| 时间 | 事件 | 证据 |
|---|---|---|
| 2012-09-10 | CentOS 6.6 装机（VolGroup + lv_root/lv_home/lv_swap） | `2/root/anaconda-ks.cfg`、`install.log`、`2/lost+found` 时间 |
| 2012-12-22 | TradeBot 工程由 VC2008 升级 VS2010，源路径 `D:\shiva\TradeBot_Russia_Code\…` | `TradeBot_China/UpgradeLog.XML` |
| 2013-11-23 | 一次带 SELinux relabel 的重启（`.autorelabel`；`/net /misc` 目录时间） | `2/.autorelabel`(0 B) [V/I] |
| 2014-08-08 | `SkylineFL_GUI.pro` 由 QtCreator 创建 | `.pro:3` |
| 2014-08-21 | 旧 GUI 的 Qt4.8.6 库 + `TradingSystemsGUI.Old` 落盘 | `3/infra/TradingSystemsGUI/*` |
| 2014-09-11→09-30 | `dataservice` 连续 5 个版本（orig/orig_dalong/old/Old_1） | `3/infra/dataservice_deploy/` |
| 2014-09-26 | **Qt 5.3.1 装到 `/home/dalong`**；同日旧 GUI 二进制产出 | `Qt5.3.1/InstallationLog.txt:1`、`:16` |
| 2014-10-07 | infrastructure 最后一次改动 GUI 控件 | `git log 345637ee` |
| 2014-10-15 | infrastructure 工作树基本定型（大量目录 mtime） | `3/dalong/infrastructure/*` |
| 2014-10-27 | infra git HEAD `6efe348f` "RMS bugfix" | `git log -1` |
| 2014-11-19 | `/GUI/SH` 部署（Qt5 库 + SkylineFL 二进制 + vim 残留 `.CLog.swp`） | 文件 mtime、swp 内 `/home/dalong/SH/CLog`、host `w2w-shanghai` |
| 2014-11-20 | GUI/dataservice 打包外发 | `2/GUI/*.tar.gz` |
| 2014-12-03 | `GuiSettings.xml` 定稿：15213 + 34 策略 15300–15333 | `3/GUI/SH/GuiSettings.xml` |
| 2014-12-21 | 线上 GUI 二进制重建（current） | BuildID `a2e432bd` |
| 2015-02-05/06 | SVN r1918；`ttt.tar.gz` 全量归档 | `.svn/entries`、tar 内 `.svn` |
| 2015-02-11/12 | r1936（shiva）+ `TradeBot.bak` 成形 | `.svn/entries` |
| 2015-02-13 | `TradeBot_sliver` + `TradeBot_20150213.tar.gz` | 文件时间 |
| 2015-02-26 | r2023（avijit），仍在 `192.168.0.31` | `.svn/entries` |
| 2015-03-02 | `tempTradeBot` 解包（`TradeBot_20150302.tar.gz`） | 目录 mtime |
| 2015-03-19 | **SkylineFL_GUI 最新一次本地构建**（1,862,816 B）；infra 目录定型 | 二进制 mtime / BuildID `1aecd50d` |
| 2015-04-12 | SkylineFL_GUI 源码目录最后修改 | 目录 mtime |
| 2015-04-27 | `infrastruct20150427.tar.gz`；旧 run dir 的 controls 到此为止；新 ORS `china_ors_extreme0426` | 文件时间 |
| 2015-05-04 | Qt5 GUI 首次有内容的日志（20:42） | `20150504-20.42.41.log` |
| 2015-06-10 | **SVN r2375**（`10.30.49.7`，avijit）——本档案最高 rev | `.svn/entries:10-12` |
| 2015-06-17 | `/home/TradeBot` 全量复制/打包（`TradeBot20150617.tar.gz`，owner `dayashankar`），WC 全部文件 mtime 被重置为 6/17 | tar 内部时间 + 3067 个文件 mtime |
| 2015-06-30 | 最后一条 TradeBot 策略日志；`main/nohup.out` | `3/TradeBot/log/…20150630` |
| 2015-07-02 | `Midas.tar.gz` / `Midas_old.tar.gz` | 文件时间 |
| 2015-07-20 08:30 | **最后一次开机**（`mtab` 同时刻写入） | `2/etc/mtab` mtime、`messages:35` |
| 2015-07-25 02:21 | 最后一条系统日志；最后一批 control 文件（20150725） | `2/var/log/messages` 尾、`controls/` |
| 2015-07-25/26 | 把 `/home` 关键目录 `cp -a` 到根盘；随后两块盘被复制到 APFS 备份盘 | §2.2；`1/` 7-25 11:21、`3/` 7-26 03:24、`2/` 7-26 15:35 |

> 2013-11 → 2015-07 的"故事线"：**2013 年底一次重装/relabel → 2014 年 8-12 月是 Qt GUI 的黄金期（旧 GUI → SkylineFL，Qt4→Qt5，11 月部署）→ 2015 年 2 月 SVN/运行目录重组（仓库迁址、.bak/temp 三份并存）→ 3-6 月 TradeBot 高频迭代（40 个策略、每日构建快照）→ 6 月 17 日做全量归档 → 7 月只剩运行与日志，7 月 25 日停机归档。**

---

## 9. 重复与漂移分析

### 9.1 完全重复（可按校验和后删除）

| A | B | 校验 |
|---|---|---|
| `2/TradeBot` | `3/TradeBot` | `diff -rq` 空；10,296 文件 / 778 M |
| `2/TradeBot.bak` | `3/TradeBot.bak` | `diff -rq` 空；1.0 G |
| `2/GUI/SH` | `3/GUI/SH` | 排除 `*.log/*.csv/*.swp` 后 `diff -rq` 空；9.0 G |
| `TradeBot_Print` | `TradeBot_20150427` | md5 同为 `c28270cf…`（3,088,825 B） |
| `■ 合计冗余` | | **≈ 10.8 GB** |

### 9.2 同名不同内容（真漂移，必须选边）

| 文件 | A | B | 差异 |
|---|---|---|---|
| `main/main.cpp` | r1936: 938 行 | r2375: 1,077 行 | +6 策略、删 `DateConfig::m_simActive`、改 `MDCallBack` |
| `main/Makefile` | r2023: 有 `PARALLELSIM` 开关 | r2375: 开关删除、无条件 `-lxsimdataserver`、`-w` | 链接行为变了 |
| `SkylineFL_GUI`（二进制） | `/GUI/SH` 2014-12-21 `a2e432bd` 1,882,103 B | 源码树 2015-03-19 `1aecd50d` 1,862,816 B | **不是同一次构建**（大小差 19 KB） |
| `GuiSettings.xml` | 源码树 2014-10-20 `ServerPort 15150`，无策略列表 | 部署 2014-12-03 `15213` + 34 策略 | 部署版是超集，**以部署版为准** |
| `2/dalong/infrastructure` | HEAD 同 `6efe348f` | `3/dalong/infrastructure` | 2 版缺 `.build_*`、缺大量文件（`git status` 显示成批 `D`）→ **不完整** |
| `2/infra` | 只有 `prod` 骨架（3 文件） | `3/infra` 3.3 G | 只剩目录名 |
| `3/TradeBot` 控制文件 | 2,006 个 | `3/TradeBot.bak` 29 个 | 后者是历史切片，不能合并 |

### 9.3 未漂移（常被误以为会变）

- `Connector/config_CHINA_CME.cfg` 在三代源码树中**完全相同**。
- `3/GUI/SH/GuiSettings.xml` 与 `2/GUI/SH/GuiSettings.xml` 相同（md5 `ac1ea7b5…`）。
- `main/main.cpp`、`main/Makefile`、`Strategies/Makefile`、`Tradebot.sln` 与 `.svn/text-base` **一致**（工作副本干净）。

---

## 10. 风险与保留建议（不做任何修改，仅记录）

1. **空间**：`3/leon/log` 39 G、`3/GUI/SH` 9 G、`3/infra/prod/log` 2.4 G、`2` 与 `3` 的 10.8 G 冗余 —— 共约 61 G 是日志/重复。归档前先按 §9.1 去重，日志可只留首尾各一周。
2. **凭据位置（未读取内容）**：`3/TradeBot/.ssh/`、`2/root/.ssh/`、`3/leon/.ssh/`、`2/root/.gnupg/`。`3/TradeBot/.subversion/auth/svn.simple/` 为**空**（未缓存 SVN 口令）——这一点算好消息。[V]
3. **不可外发的运行标识**：内网 SVN `10.30.49.7` / `192.168.0.31`、git `14.140.97.104:2727`、公网 `222.72.161.42`、主机名 `685` / `w2w-shanghai`。分享文档时应按需替换。[V]
4. **GUI 新代码无版本控制**：`SkylineFL_GUI` 不在任何 git/svn 里，只有目录和两个 tarball。**这是最该先抢救的资产。**
5. **源码不可独立构建**：缺 `infrastructure` 头文件/静态库就链接不了；`2/include` + `2/bld` 必须与 `3/TradeBot_China` 一起保存，否则 r2375 变成"只能读不能编"。
6. **Qt5.3.2 陷阱**：`/opt/Qt5.3.2` 看起来"更新"，但没有任何产物依赖它；用错 SDK 会导致 rpath/ABI 不兼容。

---

## 11. 证据索引（可复现命令）

| # | 命令 | 作用 |
|---|---|---|
| E1 | `cat 2/etc/issue; cat 2/etc/fstab; grep -n HOSTNAME 2/etc/sysconfig/network` | 确认根 FS 身份、LV 布局、主机名 |
| E2 | `grep -n "EXT4-fs\|Command line" 2/var/log/messages` | 确认 dm-0/dm-2 挂载与最后开机 |
| E3 | `diff -rq 2/TradeBot 3/TradeBot` （无输出） | 证明两份 TradeBot 同字节 |
| E4 | `nl -ba 3/TradeBot/TradeBot_China/.svn/entries \| sed -n 1,14p` | SVN URL/rev/date/author |
| E5 | `md5 -q {2,3}/TradeBot/TradeBot_China/{Makefile,Tradebot.sln,Tradebot.vcxproj,main/main.cpp}` | 关键文件一致性 |
| E6 | `cmp 3/…/main/main.cpp 3/…/main/.svn/text-base/main.cpp.svn-base` | 工作副本无本地改动 |
| E7 | `diff -u 3/TradeBot.bak/TradeBot_Multi/main/main.cpp 3/TradeBot/TradeBot_China/main/main.cpp` | 三代漂移 |
| E8 | `head -6 3/dalong/FromDaya/SkylineFL_GUI/Makefile` | `Generated by qmake (Qt 5.3.1)` + qmake 绝对路径 |
| E9 | `strings 3/GUI/SH/libQt5Core.so.5 \| grep "Qt 5.3"` | 部署运行时 Qt 版本 |
| E10 | `file 3/GUI/SH/SkylineFL_GUI` + `strings \| grep -oE "(Container\|Mainwindow)\.cpp"` | 区分新旧 GUI 二进制 |
| E11 | `git -C 3/dalong/infrastructure log -1 --pretty='%h %ad %an %s' --date=iso` | infra HEAD |
| E12 | `git -C 3/dalong/infrastructure ls-files TradingSystemsGUI \| wc -l` → 58 | GUI 控件源受 git 管理 |
| E13 | `tar -tvzf 3/unknown/TradeBot20150617.tar.gz \| head` | 6/17 归档的属主/时间 |
| E14 | `tar -xzOf 3/ttt.tar.gz TradeBot/.svn/entries \| head -12` | 2 月前的 SVN 状态（r1918） |
| E15 | `strings 3/GUI/SH/.CLog.swp \| head -6` | `/home/dalong/SH/CLog` + `w2w-shanghai` |
| E16 | `stat -f "%Sm %N" 1 2 3 2/TradeBot 3/TradeBot` | `cp -a` 时间戳签名 |

---

## 12. 未决问题（需要人/外部输入）

1. **`2/` 根上的 `/TradeBot`、`/GUI`、`/TradeBot.bak` 到底是 `cp -a` 还是 bind mount？** 两侧目录 mtime 完全一致、且 `2/dalong` 又是不完整的另一批拷贝，说明至少发生过两次人工搬运；但"谁在 7/25 深夜搬了 11 GB"没有日志证据（`2/root/.bash_history` 只覆盖 leon 的操作）。
2. **线上 GUI 为什么停在 2014-12-21？** 源码 2015-03-19 有更新的构建（`1aecd50d`），但 `/home/GUI/SH` 从未更新。是"新版本只在 `w2w-shanghai` 上跑"，还是"新版有 bug 被回滚"？
3. **`w2w-shanghai` 与 `685` 是不是同一台机器？** vim swp 里的 hostname 是前者（2014-11），系统日志里全是后者（2015-06/07）。若是两台，`/GUI/SH` 就是跨机拷贝，`/home/dalong` 的归属也要重判。
4. **SVN 是否还有 r2375 之后的提交？** 本档案止于 r2375（6/10），但运行日志到 7/24、策略代码 6/12-6/16 还在改（`.bash_history`）→ 存在**未提交的本地改动**或**另一份工作副本**。仓库 `10.30.49.7` 已不可达，无法验证。
5. **`3/leon/log` 39 GB 该不该留？** 里面是 2015-07 的逐笔/延迟统计（`stats/latency*`、`extremeors-log-*`），对复盘有价值，但占全盘 2/3；需要业务方给保留窗口。

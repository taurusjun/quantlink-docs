# 06 — 构建、打包、发布、部署与运维机制

> 证据约定：**V** = 直接读代码/配置/脚本确认；**I** = 由结构/脚本推断，未在运行环境验证；**P** = 计划/文档描述但未实现。
> 源码快照：`/Users/wangjun/PG/RD/quantlink-trading`，commit `5cee3dd5b3322ec21c1958aac20ad38ba0d8ca40`，分支 `main`，2026-11-18。
> 生产平台：Linux。macOS 仅本地开发，且只能覆盖部分构建。
> 范围：构建/打包/发布/部署机制、主机、配置、启停、升级/回滚。**不含** `web-go` 内部实现；**不含**日常监控与故障处置 runbook（见 `07-operations-runbook.md`）。
> 本文不复制任何口令/token/账号；只记录文件位置、键名、加载方式和保护方式。

---

## 0. 给复刻者的十行结论

1. 这套系统**没有 systemd、没有 RPM/DEB、没有版本化发布包**。部署 = `git clone` 到 `/root/quantlink-trading` + `./scripts/build_deploy_cpp.sh` 生成 `deploy_cpp/` + `crontab ops/crontab.txt`。（**V**）
2. 唯一的“编排器”是**cron + shell**：日盘 `08:50` 启、`15:05` 停；夜盘整套已注释停用（2026-11-04）。（**V**，`ops/crontab.txt:43-50`）
3. `deploy_cpp/bin` 是**运行时 cwd**；`deploy_cpp/data` 是 `../data`；`/root/quantlink-trading/data_cpp` 是**配置唯一事实源**。（**V**）
4. 启停脚本 `start_all.sh` / `start_ors.sh` / `start_strategy.sh` / `stop_all.sh` **不在 git 里**，由 `build_deploy_cpp.sh` 用 heredoc 生成，每次构建都覆盖。（**V**，`scripts/build_deploy_cpp.sh:293-754`）
5. 进程模型：`ors_server`（1 个）+ `TradeBot`（**每策略 1 个**）+ `memlog-reader` + 可选 `tbadmin admin/agent`。（**V**）
6. SHM 是进程间唯一总线：`4097` 行情 / `8193` 请求 / `12289` 回报 / `16385` ClientStore / `789` MemLog。（**V**）
7. 配置同步是**“存在即跳过”**（`cp -Rn`），所以改已有配置必须用 `--config-only`，否则改动静默不生效。（**V**，`scripts/build_deploy_cpp.sh:777-791`）
8. 构建产物**原地覆盖**，没有自动备份；回滚 = `git reset` + 重新编译，或事先手工备份二进制。（**V**）
9. 最危险的两个操作：`build_deploy_cpp.sh --clean`（删掉整个 `deploy_cpp/`，含运行时数据/日志）和 ORS 重启窗口（CTP 同账号双登录互踢，见 §7.6）。（**V** / **I**）
10. 生产主机是单台 190 云主机：4 核、单盘 178G、无异地备份、本机 PostgreSQL。（**V**，`docs/RISK_NO_OFFSITE_BACKUP.md:20-40`）

---

## 1. 构建矩阵

### 1.1 总表

| 组件 | 构建系统 | 标准/编译器 | 产物 | 产物去向 | 证据 |
|---|---|---|---|---|---|
| ORS | CMake ≥3.16 + GNU Make | C++17，`-D_USE_CTP_`，`-Wall -O2` | `ors_server`、`fee_refresh` | `deploy_cpp/bin/` | `ors/CMakeLists.txt:1-13,118-180`；`scripts/build_deploy_cpp.sh:192-250` |
| TradeBot（生产路径） | CMake ≥3.14 + Make | C++17，`-w -g -O2` | `TradeBot` | `deploy_cpp/bin/` | `tbsrc/CMakeLists.txt:1-7,60,103`；`scripts/build_deploy_cpp.sh:253-284` |
| TradeBot（遗留路径） | GNU Make 递归 | C++0x，`-O3 -w` | `tbsrc_bin/TradeBot` | `tbsrc_bin/` | `tbsrc/Makefile:1-5`；`tbsrc/main/Makefile:18-19,37,97,106-107` |
| hftbase（TradeBot 依赖） | SCons | C++（老代码） | `lib*.a/.so` | `tbsrc/hftbase/libs/`（**已入库**） | `tbsrc/hftbase/Makefile:1-17`；`tbsrc/CMakeLists.txt:39,103` |
| tbadmin | GNU Make | C++17 | `tbadmin`、`testmemlog/writemlog` | `tbadmin/` | `tbadmin/Makefile:1-49` |
| CTP SDK | 预编译二进制入库 | C++ API | `libthosttraderapi_se.so`、`libthostmduserapi_se.so` + 头文件 | `ors/third_party/ctp/linux/{lib,include}` | `ors/third_party/ctp/README.md:1-60`；`ls ors/third_party/ctp/linux/lib` |
| memlog-reader（Go） | `go build` | Go ≥1.21 | `memlog-reader` | `deploy_cpp/bin/` | `scripts/build_deploy_cpp.sh:846-886`；`docs/GETTING_STARTED.md:35-40` |
| check-md / md-recorder（Go） | **无构建入口** | Go | `check-md`、`md-recorder` | `deploy_cpp/bin/` | 见 §1.7（**未验证**） |
| Vue 管理前端 | npm/Vite | Node | `dist/` → nginx | `/var/www/quantlink-admin` | `scripts/deploy_admin_front.sh:1-30`；`ops/nginx/quantlink-admin.conf` |

> 两套 hftbase 并存：ORS 编译 `C++_deps/hftbase` 的**源码**（`ors/CMakeLists.txt:16,33-40`），TradeBot 链接 `tbsrc/hftbase/libs` 的**预编译库**（`tbsrc/CMakeLists.txt:39,103`）。它们是两份独立快照，升级要分别核对（`00-source-map.md:62`）。

### 1.2 ORS（CMake）

**命令（脚本实际执行的）：**

```bash
cd /root/quantlink-trading/ors
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
# 产物：ors/build/ors_server, ors/build/fee_refresh
```

证据：`scripts/build_deploy_cpp.sh:195-210`（`ORS_BUILD=ors/build`、`cmake .. -DCMAKE_BUILD_TYPE=Release`、`make -j${NPROC}`）。

**编译内容：**

- CTP 宏：`add_definitions(-D_USE_CTP_)`（`ors/CMakeLists.txt:13`）。
- hftbase 源码只编 6 个文件：`Logger/{log,active,bglogworker,sighandler}.cpp`、`RMS_NEW/src/rmschecks.cpp`、`CommonUtils/src/tinyxml2.cpp`；**`rmsimpl.cpp` 刻意排除**（RMS 走 header-only `rmsimpl.hpp`）（`ors/CMakeLists.txt:28-40`）。
- ORS 业务源码 8 个：`main.cpp`、`ORSServer.cpp`、`MdSpi.cpp`、`MDHandler.cpp`、`marketdatahandler.cpp`、`tradedatahandler.cpp`、`reutersdecoder.cpp`、`dumprecorder.cpp`（`ors/CMakeLists.txt:45-56`）。
- 链接：`pthread`（`ors/CMakeLists.txt:132-134`）。

**CTP 链接方式（关键）：**

| 平台 | include | link | rpath |
|---|---|---|---|
| Linux | `ors/third_party/ctp/linux/include` | `.../linux/lib/libthosttraderapi_se.so`、`libthostmduserapi_se.so` | `.../linux/lib`（**源码树绝对路径**） |
| macOS | `*.framework/Versions/A/Headers` | `*.framework/Versions/A/thostXXX_se` | `.../macos` |

证据：`ors/CMakeLists.txt:71-115`。

> **部署影响（I）**：`INSTALL_RPATH` 指向 `/root/quantlink-trading/ors/third_party/ctp/linux/lib`。因此 `deploy_cpp/lib/ctp/*.so` 的拷贝（`scripts/build_deploy_cpp.sh:242-246`）在默认情况下**不是**运行时实际加载路径；仓库目录被移动/删除会导致二进制起不来。要真正使用部署副本，需要 `LD_LIBRARY_PATH=../lib/ctp` 或改 rpath。

**fee_refresh：**

- 独立 target，只链 trader API，不链 hftbase Logger/RMS、不链行情 API（`ors/CMakeLists.txt:145-180`）。
- 用途：CTP 直查费率生成 `fee.csv`（`ors/tools/fee_refresh/fee_refresh.cpp:1-60`）。
- 构建脚本**不把它当硬依赖**：编不出来只告警（`scripts/build_deploy_cpp.sh:221-230`）。

**工具链假设：** CMake ≥3.16（`ors/CMakeLists.txt:1`）、支持 C++17 的 g++（190 为系统 GCC 11.5，`docs/GETTING_STARTED.md:37-38,130`）、`make`、`nproc`。

### 1.3 TradeBot

#### 1.3.1 生产路径：CMake（`build_deploy_cpp.sh` 使用）

```bash
cd /root/quantlink-trading/tbsrc
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
# 产物：tbsrc/build/TradeBot
```

证据：`scripts/build_deploy_cpp.sh:256-280`。

关键设置：

| 项 | 值 | 证据 |
|---|---|---|
| 标准 | C++17 | `tbsrc/CMakeLists.txt:3` |
| 全局 flags | `-w -pthread -g -O2 -Wl,-rpath=.:bin:/home/hft/tbsrc_bin` | `:7` |
| include | `hftbase/{snappy,CommonUtils,Logger,Ipc,SysUtils,Connector,ExchangeSimulator,Instinet,memlog,libpqxx-6.4.8,DataTools}` + `common/Indicators/Strategies/main` | `:19-37` |
| 源文件 | hftbase 5 个 + `common/*.cpp`、`Indicators/*.cpp`、`Strategies/*.cpp`、`main/*.cpp` | `:41-57` |
| 宏 | `_PRINT_UPDATE`、`LOGGER`、`PRINTTRADES`、`EXCHSIMSTATS`、`_GLIBCXX_USE_SCHED_YIELD`、`USE_MWMRQ_{REQ,RESP,MD}SHM`、`_XSIM_USE_CERR` | `:63-99` |
| 链接 | `commonutils.a xsim xsimdataserver datamanip snappy pq pqxx z pthread` | `:103` |
| GCC<9 补丁 | 追加 `stdc++fs` | `:105-107` |

**依赖来源：** `tbsrc/hftbase/libs/` 里 9 个预编译产物（`libcommonutils.a`、`libdatamanip.a`、`libpq.so`、`libpqxx.so`、`libsnappy.so`、`libxsim*.a`），已入库（`.gitignore:11-14` 白名单；`ls tbsrc/hftbase/libs`）。它们被 `file` 判定为 **Linux x86-64 ELF**（本地实测），因此 **macOS 无法链接出 TradeBot**（**I**）。

**运行时库查找：** 二进制 rpath 只有 `.:bin:/home/hft/tbsrc_bin`，`libpqxx.so`/`libsnappy.so` 实际靠 `start_strategy.sh` 注入的 `LD_LIBRARY_PATH`：

```bash
PROJ_ROOT="$(cd "$(dirname "$SCRIPT_DIR")/../../" && pwd)"   # = 仓库根
for libdir in "$PROJ_ROOT/tbsrc/hftbase/libs" "$PROJ_ROOT/tbsrc/hftbase/libs_local/lib64"; do
    [ -d "$libdir" ] && export LD_LIBRARY_PATH="${libdir}:${LD_LIBRARY_PATH}"
done
```

证据：`scripts/build_deploy_cpp.sh:496-500`。⇒ **手工直接跑 `./TradeBot` 而不经脚本，可能因找不到 `libpqxx.so` 失败**（**I**）。

#### 1.3.2 遗留路径：GNU Make（当前部署不使用）

```bash
cd tbsrc
make                 # 或 make DEBUG=1 LOGGER=1 VOLTHREAD=1 ORDER=1
# 产物：../tbsrc_bin/TradeBot
```

- 顶层只做 4 次递归：`common` → `Indicators` → `Strategies` → `main`（`tbsrc/Makefile:1-5`）。
- 编译器 `g++`，`-std=c++0x`，release `-O3 -w`（`tbsrc/main/Makefile:4,18`）。
- 链接目录 `/usr/lib64` 与 `$(INFRAPATH)/release`（`tbsrc/main/Makefile:19`），假设 hftbase 已用 SCons 产出 release 库。
- 输出目录硬编码 `../../tbsrc_bin`（`tbsrc/main/Makefile:37`）。
- `SURFACE=1` 会链 `-lpython2.6`（`:64-67`），是 2012 年代遗留，现代镜像上不可用。

**结论：** 这是迁移前的原始构建方式，`build_deploy_cpp.sh` **不调用**它；复刻时可忽略，除非要重建 `tbsrc_bin/` 或跑回测。（**V**）

### 1.4 hftbase（SCons）

```bash
cd tbsrc/hftbase
scons -j8 mode=release      # 或 make release / make debug / make clean
```

- `Makefile` 只是 `scons` 包装（`tbsrc/hftbase/Makefile:1-17`）。
- `SConstruct` 的 `PROJECT_LIST` 仅含 `TestFramework/Logger/SysUtils/CommonUtils/Networks/Ipc/RMS_NEW`（`tbsrc/hftbase/SConstruct:41-66`）。
- 输出前缀 `../bin`、构建根 `../.build_`（`:74-76`），**不是** `libs/`。⇒ 重建后需要人工把库搬进 `libs/` 才能被 CMake 使用（**I**）。

**生产是否需要它：** 不需要。`libs/` 已入库，CMake 直接链接。只有在修改 hftbase 源码或换编译器/ABI 时才需要重建，且必须保证 `libs/` 与 `C++_deps/hftbase`（ORS 用）行为一致（**I**）。

### 1.5 tbadmin（GNU Make）

```bash
cd /root/quantlink-trading/tbadmin
make
# 产物：tbadmin/tbadmin
cd testmemlog && make     # 可选：writemlog 测试写入器
```

（`docs/STARTUP_GUIDE.md:155-168`，**V**）

Makefile 关键点：

| 项 | 值 | 证据 |
|---|---|---|
| 编译器 | `g++`，`-std=c++17 -g -Wall -lrt` | `tbadmin/Makefile:1,31` |
| include | `./inc` + `../C++_deps/hftbase/{,CommonUtils,Ipc,Logger,memlog}/include` | `:4-9` |
| 源 | `admin.cpp Timer.cpp main.cpp client_yd.cpp` + 已生成的 `admingpb.pb.cc`、`msggpb.pb.cc` | `:15-17` |
| 链接 | `-L./lib -lyd -lmemlog -lpthread -lzmq -lprotobuf -lpqxx -lpqhelper` | `:25` |
| rpath | `./lib/` | `:28` |
| 输出 | `tbadmin/tbadmin` | `:12` |

**外部依赖：**

- 系统包：`zeromq-devel`、`protobuf-devel`（+ `protoc`）、`libpqxx-devel`（`docs/STARTUP_GUIDE.md:152-156`）。
- `./lib` 下的私有 `.so`：`libyd`（易达柜台客户端）、`libpqhelper`、`libmemlog`。**`tbadmin/lib/` 不在 git 里**（`*.so` 被 `.gitignore:9` 排除；`ls tbadmin` 无 `lib/`）。集成测试文档明确记录“本地 scp `tbadmin/lib/*.so` 到服务器”（`docs/INTEGRATION_TEST_TBSRC_TBADMIN.md:431`）。⇒ **复刻者拿不到 `libyd` 的来源/版本，这是 tbadmin 复刻的最大缺口**（**V/I**）。
- `admingpb.pb.*` / `msggpb.pb.*` 已预生成入库；若 `protoc` 版本不匹配需重新生成（`docs/INTEGRATION_TEST_TBSRC_TBADMIN.md:429`）。

**运行方式：** `./tbadmin admin` / `./tbadmin agent`，cwd 必须是 `tbadmin/`（读 `./cfg/*.cfg`）（`tbadmin/main.cpp:6-20`；`tbadmin/start_admin.sh:7,17`）。

> **文档/配置冲突（V）**：`docs/STARTUP_GUIDE.md:244-252` 要求实盘 `agent.cfg` 启用 `RSP_Q_LIST=12289`（订单回报），但仓库里的 `tbadmin/cfg/agent.cfg:1-19` **没有这一项**。若现场 agent 确实需要转发回报，说明生产 cfg 有未入库的改动；复刻时需自行决定是否补上（**I**，功能影响未验证）。

### 1.6 CTP SDK

| 项 | 事实 | 证据 |
|---|---|---|
| 版本 | 仓库 README 推荐 **6.7.11+**；Linux 目录内为 6.7.11 头/库 | `ors/third_party/ctp/README.md:100-104`；`ors/CMakeLists.txt:62,90` |
| Linux 内容 | `include/ThostFtdc{Md,Trader}Api.h`、`ThostFtdcUserApi{DataType,Struct}.h`；`lib/{libthostmduserapi_se.so,libthosttraderapi_se.so,error.xml,error.dtd}` | `ls ors/third_party/ctp/linux/*` |
| macOS 内容 | `thostmduserapi_se.framework`、`thosttraderapi_se.framework`（universal x86_64+arm64） | `file .../thosttraderapi_se` |
| 入库策略 | 二进制与头文件均入 git（`.gitignore:10-12` 例外规则） | `ors/third_party/ctp/.gitignore:1-5` |
| 部署拷贝 | 只拷 `linux/lib/*.so` 到 `deploy_cpp/lib/ctp/`；**`error.xml`/`error.dtd` 不拷** | `scripts/build_deploy_cpp.sh:242-246` |

**注意事项：**

- CTP API 运行时会读同目录 `error.xml`；部署副本缺这两个文件，但 rpath 指向源码目录，所以实际仍读仓库内那份（**I**）。
- `bIsProductionMode` 由 `PRODUCTION_MODE` 驱动，缺省 `true`；评测环境必须设 `0/false`，否则报 `ErrorID=4040 shake hand err`（`ors/China/src/ORSServer.cpp:125-145`；`openspec/specs/ctp-production-mode/spec.md:1-30`）。**这是切换实盘/评测最容易踩的开关。**
- 评测柜台与生产柜台的地址/凭据只在 `ors_server.cfg`（不入库）与 `docs/test/` 里，本文不复制。

### 1.7 Go 辅助二进制（部分在范围内、实现不在范围内）

`build_deploy_cpp.sh` **只构建 `memlog-reader`**：

```bash
GO_CMD="$(which go 2>/dev/null || echo /usr/local/go/bin/go)"
cd web-go && "$GO_CMD" build -o "${BIN_DIR}/memlog-reader" ./cmd/memlog-reader/
```

证据：`scripts/build_deploy_cpp.sh:849-886`。

但 cron 还会运行两个 Go 工具：

| 二进制 | 调用方 | 构建入口 | 状态 |
|---|---|---|---|
| `check-md` | `ops_check_md.sh`、`ops_md_liveness_watchdog.sh`、`ops_preopen_check.sh` | **无** | 只能人工 `go build ./cmd/check-md`（**I**） |
| `md-recorder` | `ops_start_md_recorder.sh` | **无** | 只能人工 `go build ./cmd/md-recorder`（**I**） |

证据：`scripts/ops_check_md.sh:31-46`；`scripts/ops_start_md_recorder.sh:16-33`；`web-go/cmd/{check-md,md-recorder}/main.go` 存在。⇒ **复刻时若只跑构建脚本，`check-md`/`md-recorder` 缺失，行情看门狗和录制器全部静默降级**（`ops_md_liveness_watchdog.sh:137-140` 会 `[WARN]` 后跳过）。

### 1.8 macOS 与 Linux 的差异

| 维度 | Linux（190，生产） | macOS（本地开发） | 证据 |
|---|---|---|---|
| ORS | 可编译（CTP `.so`） | CMake 有 `APPLE` 分支，框架为 universal；**本地 `ors/build` 只有 `fee_refresh`，无 `ors_server`** | `ors/CMakeLists.txt:71-115`；`ls ors/build` |
| TradeBot | 可编译（Linux ELF 预编译库） | **不可链接**（`libpqxx.so` 等为 ELF） | `file tbsrc/hftbase/libs/libpqxx.so` |
| 配置文件拷贝语义 | GNU `cp -n` 跳过已存在文件仍返回 0 | BSD `cp -n` 只要有跳过就返回 1 ⇒ 触发脚本兜底分支 | 脚本注释明确记录：`scripts/build_deploy_cpp.sh:782-786` |
| 日期解析 | `date -d` | `date -j -f` | `scripts/is_trading_day.sh:84-92` |
| CPU 亲和 | `sched_setaffinity` 生效 | 头文件降级（`__APPLE__`） | `ors/CMakeLists.txt:87-88`；`C++_deps/hftbase/SysUtils/include/processsettings.h:1-10` |
| `ipcs/ipcrm` | 有 | macOS 语法/行为不同 | `start_all/stop_all` 生成脚本 |
| 脚本可测性 | 生产真值 | **构建脚本在 macOS 上测不出真行为**（作者原话） | `scripts/build_deploy_cpp.sh:786` |

> **结论（V/I）**：macOS 只能做 ORS 的编译冒烟和配置编辑；**TradeBot/tbadmin/整链启停必须在 Linux 验证**。任何“本地跑通了”的结论都不适用于生产。

### 1.9 常见构建失败与判据

| 症状 | 根因 | 处理 | 证据 |
|---|---|---|---|
| `CMake Error: CTP framework not found` | macOS 缺 framework | 从 SimNow 下载放回 `ors/third_party/ctp/macos/` | `ors/CMakeLists.txt:77-79` |
| `cannot find -lthosttraderapi_se` | Linux 缺 `.so` | 补 `ors/third_party/ctp/linux/lib/` | `ors/CMakeLists.txt:94-96` |
| `undefined reference to pqxx::...` | `tbsrc/hftbase/libs/libpqxx.so` 缺失/ABI 不符 | 确认 `libs/` 完整；ABI 必须与编译器一致 | `tbsrc/CMakeLists.txt:103` |
| `cannot find -lyd / -lpqhelper` | `tbadmin/lib/` 缺失 | 人工恢复 `.so`（来源需问原维护者） | `tbadmin/Makefile:25` |
| `protobuf` 版本冲突 | 系统 `libprotobuf` 与预生成 pb 不匹配 | `protoc --cpp_out` 重新生成 | `docs/INTEGRATION_TEST_TBSRC_TBADMIN.md:429` |
| `go: command not found` | 无 Go 或不在 PATH | 安装 Go ≥1.21，或放 `/usr/local/go/bin/go` | `scripts/build_deploy_cpp.sh:851` |
| `fee_refresh` 未生成 | 只影响费率刷新，不影响 ORS | 看 `make` 输出；cron 会在 15:40 告警 | `scripts/build_deploy_cpp.sh:224-230` |
| `cp: cannot create regular file` | 目标目录不存在（历史 bug） | 已由 `mkdir -p` 修掉 | `scripts/build_deploy_cpp.sh:779-788` |

---

## 2. `scripts/build_deploy_cpp.sh` 深读（925 行）

### 2.1 参数

| 参数 | 语义 | 实现细节 | 证据 |
|---|---|---|---|
| 无参数 | 编译 ORS + TradeBot + 同步配置 + 构建 Go Dashboard | `BUILD_ORS=true BUILD_TRADER=true` | `:59-63` |
| `--ors` | 只编 ORS | `BUILD_TRADER=false` | `:77` |
| `--trader` | 只编 TradeBot | `BUILD_ORS=false` | `:78` |
| `--clean` | 先 `rm -rf deploy_cpp/`，并删 `ors/build`、`tbsrc/build` | **破坏性**，见 §2.7 | `:79,173-176,198-201,259-262` |
| `--config-only` | 只把 `data_cpp/bin/{config,controls,models}` **覆盖**同步到 `deploy_cpp/bin`，不编译 | 早退，且**不**同步 `live/`、`data/` | `:80,148-169` |
| `--mode sim|live` | 只校验并打印 | **没有下游使用者**；对拷贝内容零影响 | `:81-90,110` |
| `--help/-h` | 帮助 | — | `:91-102` |
| 其它 | 报错退出 1 | — | `:103` |

> `--mode` 是**死参数**：`grep -n DEPLOY_MODE` 只有定义、赋值、打印三处（`:62,90,110`）。不要以为 `--mode live` 会切凭据/端口。（**V**）

**平台探测：** `uname == Darwin` → `macOS` + `sysctl -n hw.ncpu`；否则 `Linux` + `nproc`（`:65-72`）。

**退出策略：** 顶部 `set -e`（`:32`）；任何 `make` 失败立即中止，**不会**把半成品拷进 `deploy_cpp`（拷贝在 `make` 之后）。

### 2.2 执行阶段（按顺序）

| # | 阶段 | 行为 | 证据 |
|---|---|---|---|
| 1 | 旧名包装 | 拷贝 13 个运维包装到 `deploy_cpp/bin/scripts/`：`tbstart/tbstop/tbreload` + `.sh` 别名 + `tbstartall.sh/tbstopall.sh/tbstartpar.sh/tbstoppar.sh` + `check_md/cplog/single_check` | `:115-142` |
| 2 | config-only 早退 | 覆盖同步 `config/controls/models`，建 `live/data`、`ctp_flow`，退出 0 | `:144-170` |
| 3 | clean（可选） | 删整个 `deploy_cpp/` | `:172-176` |
| 4 | 建目录 | `bin/{config,log,scripts,live/data}`、`data/`、`lib/ctp/` | `:178-189` |
| 5 | 编 ORS | cmake/make → 拷 `ors_server`、`fee_refresh`；拷 CTP `.so`/framework | `:191-250` |
| 6 | 编 TradeBot | cmake/make → 拷 `TradeBot` | `:252-284` |
| 7 | 生成启停脚本 | heredoc 写 `start_ors.sh`、`start_strategy.sh`、`start_all.sh`、`stop_all.sh` 并 `chmod +x` | `:286-760` |
| 8 | 同步配置 | `data_cpp/bin/{config,controls,models,live}` → `bin/`；清理改名残留；`data_cpp/data/*` → `deploy_cpp/data/` | `:762-844` |
| 9 | 编 Go | `memlog-reader` + 配置（含备份/alt/secret） | `:846-886` |
| 10 | 打印布局 | 仅提示 | `:888-925` |

### 2.3 目录布局

生成的 `deploy_cpp/`：

```text
deploy_cpp/
├── bin/                        # 运行时 cwd（所有 start/stop 脚本都 cd 到这里）
│   ├── ors_server
│   ├── TradeBot
│   ├── fee_refresh
│   ├── memlog-reader
│   ├── config/                 # ← data_cpp/bin/config
│   ├── controls/{day,night}/   # ← data_cpp/bin/controls
│   ├── models/                 # ← data_cpp/bin/models
│   ├── live/data/position.csv  # ← data_cpp/bin/live（ORS 的 POSITION_FILE）
│   ├── scripts/                # 生成脚本 + 包装 + 部分 ops_*.sh
│   ├── log/                    # 运行日志（NOT in git）
│   ├── log.bak/<YYYYMMDD>/     # 轮转归档
│   ├── ctp_flow/               # CTP 流文件
│   └── ctp_flow.bak/
├── data/                       # 硬编码的 ../data（daily_init / fee / contractfile ...）
├── lib/ctp/*.so
├── daily_init_bak/<YYYYMMDD>/
├── money_bak/money_<日期>_<am|pm|night>/
└── report_bak/report_<交易日>_<day|night>.txt
```

证据：`scripts/build_deploy_cpp.sh:7-17,178-189,891-907`；快照目录由 `ops_snapshot_*.sh`/`ops_eod_report.sh` 创建（`ops_snapshot_daily_init.sh:22-24`、`ops_snapshot_money.sh:24-26`、`ops_eod_report.sh:125-126`）。

### 2.4 复制白名单与覆盖语义

#### `data_cpp/bin/*` → `deploy_cpp/bin/`

白名单 **4 个子目录**：`config`、`controls`、`models`、`live`（`:777`）。

```bash
mkdir -p "${BIN_DIR}/${subdir}"
cp -Rn "${DATA_CPP}/bin/${subdir}" "${BIN_DIR}/" 2>/dev/null || \
cp -Rn "${DATA_CPP}/bin/${subdir}/"* "${BIN_DIR}/${subdir}/" 2>/dev/null || true
```

- `-n` = **不覆盖已存在文件**。⇒ 修改已有 `config_CHINA.*.cfg` / `control.*` / `model.*` 后跑完整构建，**不会**更新 `deploy_cpp`；必须 `--config-only`。（**V**，`:771-791`）
- 兜底分支曾漏 `-n`，会覆盖运行时 `position.csv`；已修（`:782-788`）。
- `live/` 是后补的：此前 `position.csv` 从未部署，导致 ORS 读写全失败（2026-07-28→10-04，成功 0 次）（`:772-776`）。

#### 改名残留清理（`prune_stale_renamed`）

换月是“改文件名”，而 `cp -Rn` 不会删源端已消失的旧文件。脚本在**同一 SID** 下，若源头没有同名文件、但仍存在别的 `control.*.par.txt.<SID>` / `model.*.par.txt.<SID>`，就删除旧副本（`:793-823`）。

> 只删 `*.par.txt.<SID>` 形状，**不碰** `live/data/position.csv` 等运行时数据（`:802-803`）。
> 这是真实事故的修复：`deploy_cpp` 里留着 `IF2610/IF2612`，`data_cpp` 已是 `IF2703/IF2706`；`start_strategy.sh` 的 glob 取到旧文件，于是“仓库已换月、机器还在跑旧合约”同时成立，而 `ops_f_contract_check.py` 读 `data_cpp` 会报 OK（`.claude/CLAUDE.md:843-915`）。

#### `data_cpp/data/*` → `deploy_cpp/data/`

- 只处理 `maxdepth 1` 的普通文件（`:828-839`）。
- 默认“目标不存在才拷”。
- **`trading_days.txt` 例外：无条件覆盖**。原因：旧逻辑使 190 的副本停在 `20241231`，日历门控永久失效（`:826-836`）。

#### Go 配置文件

| 文件 | 行为 | 证据 |
|---|---|---|
| `config/memlog-reader.yaml` | 源优先 `data_cpp/bin/config/memlog-reader.yaml`，否则 `web-go/config.yaml`；目标已存在且内容不同 → 先备份 `*.bak.<ts>` 再覆盖 | `:856-872` |
| `config/feishu.secret.yaml` | **只在目标不存在时**拷贝（secret 不随代码变） | `:869-871` |
| `config/memlog-reader.alt.yaml` | **无条件覆盖**（避免 `cp -Rn` 挡住更新） | `:873-879` |

### 2.5 `--config-only` 模式

```bash
./scripts/build_deploy_cpp.sh --config-only
```

- 前置：`data_cpp/` 存在（`:150-153`）。
- 行为：`cp -R data_cpp/bin/{config,controls,models}/. deploy_cpp/bin/<sub>/` —— **覆盖**（`:155-161`）。
- 额外 `mkdir -p bin/ctp_flow bin/live/data`（`:162-167`）。
- **不**编译、**不**动 `deploy_cpp/data/`（daily_init、fee、position 全部保持现场值）、**不**清改名残留。

**适用场景：** 只改已有配置内容（参数、CPU 亲和、SHM 大小）。  
**不适用：** 换月改名（旧文件不会被删，需要跑一次完整构建触发 `prune_stale_renamed`）、新增策略（建议完整构建以便生成/校验）。

### 2.6 生成的启停脚本（内容摘要）

| 脚本 | 生成位置（build 脚本行号） | 关键行为 |
|---|---|---|
| `bin/scripts/start_ors.sh` | `:293-381` | `sim|ctp`；写 `.gateway_mode`；**双启动硬拒绝**；`ulimit -c 0`；`ipcrm -m` 清当前用户全部 SHM；`./ors_server config/ors_server.cfg > log/ors_server.<DATE>.log 2>&1 &`；`sleep 3` |
| `bin/scripts/start_strategy.sh` | `:384-528` | 参数 `<sid> [day|night] [--fg]`；自动判时段；找 control/config；PID 文件 + `pgrep` 双检；注入 `LD_LIBRARY_PATH`；`nohup TradeBot ...`；`sleep 3` 后验活 |
| `bin/scripts/start_all.sh` | `:531-666` | 日历门控 → ORS → 建 MemLog SHM → 遍历 `config_CHINA.*.cfg` → 启动 `memlog-reader` |
| `bin/scripts/stop_all.sh` | `:669-754` | 停 TradeBot → memlog-reader → ORS（等 ≤90s）→ 清 SHM → `sync_data_back.sh` |

**`start_strategy.sh` 的完整命令行：**

```bash
./TradeBot --Live \
  --controlFile controls/<day|night>/control.<leg1>.<leg2>.par.txt.<SID> \
  --strategyID <SID> \
  --configFile config/config_CHINA.<SID>.cfg \
  --logFile ./log/log.<control_basename>.<YYYYMMDD> \
  --printMode 1 --updateInterval 7200
```

证据：`scripts/build_deploy_cpp.sh:502-505`。参数解析在 `tbsrc/main/main.cpp:388-472`。

> `--updateInterval 7200`（2 小时）是刻意覆盖午休 11:30–13:30，避免触发 `MARKET DATA is not valid` 退出（脚本注释 `:503-504`；`.claude/CLAUDE.md:665-675`）。

### 2.7 幂等、覆盖与破坏性

| 对象 | 重复执行结果 | 风险 |
|---|---|---|
| 目录 | `mkdir -p` 幂等 | 无 |
| `ors_server`/`TradeBot`/`memlog-reader` | 每次覆盖 | 无自动备份 ⇒ 回滚需重编 |
| 生成的 4 个启停脚本 | 每次覆盖 | **在 deploy 上手改会被静默冲掉** |
| 13 个旧名包装 | 每次覆盖 | 同上 |
| `config/controls/models/live` | 跳过已存在 | 配置更新不生效（需 `--config-only`） |
| `data/*` | 跳过已存在；`trading_days.txt` 强制覆盖 | `fee.csv`/`contractfile` 可能长期陈旧 |
| 改名残留 | 删除 | 只删 `*.par.txt.<SID>` |
| `memlog-reader.yaml` | 覆盖 + `.bak.<ts>` | 备份目录会累积 |
| `feishu.secret.yaml` | 只在缺失时拷 | 轮换需手工替换 |
| `--clean` | `rm -rf deploy_cpp/` | **删掉 log/、log.bak/、daily_init_bak/、money_bak/、report_bak/、live/position.csv**；只有 `data_cpp` 有副本的数据能恢复 |

> **强烈建议（复刻改进）**：把 `--clean` 改成“只清 `bin/` 下的二进制与 `scripts/`”，或先做 `deploy_cpp` 快照。当前语义与“清理重编译”名称不符。（**V**）

### 2.8 与仓库文档的冲突（必须知道）

| 文档说法 | 代码事实 | 结论 |
|---|---|---|
| `build_deploy_cpp.sh --cpp` / `--go`（`.claude/CLAUDE.md:258-266`、`:536-543`） | 参数只有 `--ors/--trader/--clean/--config-only/--mode` | **文档过期**；`--cpp/--go` 会报 `Unknown option` |
| `./scripts/start_tradebot.sh 92201`（`.claude/CLAUDE.md:290`） | 生成的是 `start_strategy.sh <sid>` | 文档过期 |
| `./scripts/start_all.sh` 在 `scripts/` 下 | **不存在**；只在 `deploy_cpp/bin/scripts/` | `start_all_with_tbadmin.sh:37-39` 已修正为部署路径 |
| `ops_stop_session.sh` 注释引用 `stop_all.sh:28-35` | 生成脚本行号已变（memlog 在 697-704） | 注释过期，不影响行为 |
| `memlog-reader.alt.yaml` 头注释“18080/18081” | 实际 `28080/28081` | 注释过期（`data_cpp/bin/config/memlog-reader.alt.yaml:1-15`） |

---

## 3. 部署布局

### 3.1 生产路径

| 路径 | 角色 | 证据 |
|---|---|---|
| `/root/quantlink-trading` | git 仓库根；配置事实源 | `ops/crontab.txt:5` |
| `/root/quantlink-trading/data_cpp/` | **唯一可编辑的配置源**（入 git） | `docs/GETTING_STARTED.md:114-117`；`.claude/skills/deploy-cpp/skill.md:9-14` |
| `/root/quantlink-trading/deploy_cpp/` | 构建产物 + 运行时（**gitignored**） | `.gitignore:33`；`scripts/build_deploy_cpp.sh:55-58` |
| `/root/quantlink-trading/deploy_cpp/bin` | 所有进程的 cwd | `scripts/build_deploy_cpp.sh:26-29,289-290` |
| `/root/quantlink-trading/tbadmin` | tbadmin 的 cwd（读 `./cfg`、`./lib`） | `tbadmin/start_agent.sh:3-7` |
| `/home/hft/tbdata` | **硬编码数据目录**（`fee.csv`/`contractfile`/`RolloverOverrideFile`） | `tbsrc/main/TradeBotUtils.cpp:2463`；`tbsrc/common/Instrument.cpp:440,1548,1575` |
| `/home/u50_data` | MD 录制输出 | `data_cpp/bin/config/md-recorder.yaml:11`；`ops_start_md_recorder.sh:31` |
| `/var/log/quantlink` | cron 脚本日志（preopen/liveness/strategy_sync） | `ops_preopen_check.sh:24-27`；`ops/crontab.txt:67,103` |
| `/var/lib/pgsql/16/data` | 本机 PostgreSQL 数据 | `docs/RISK_NO_OFFSITE_BACKUP.md:74` |
| `/root/quantlink-backups` | CTP 凭据 `.bak`（仍在同一块盘） | `docs/RISK_NO_OFFSITE_BACKUP.md:71` |
| `/usr/local/bin/tbstart...` | 10 个 shim（运维 PATH） | `scripts/ops_install_tb_path.sh:22-57` |

### 3.2 `data_cpp` 是事实源，但不是唯一读取点（重要）

运行时数据实际来自 **三个根**：

| 读取方 | 路径 | 解析根 | 证据 |
|---|---|---|---|
| TradeBot | `../data/daily_init.<SID>` | `deploy_cpp/data/`（相对 cwd） | `tbsrc/Strategies/PairwiseArbCSOStrategy.cpp:24,297` |
| TradeBot | `/home/hft/tbdata/fee.csv` | **绝对路径** | `tbsrc/main/TradeBotUtils.cpp:2463` |
| TradeBot | `/home/hft/tbdata/contractfile` | **绝对路径** | `tbsrc/common/Instrument.cpp:1548,1575` |
| TradeBot | `/home/hft/tbdata/RolloverOverrideFile` | **绝对路径** | `tbsrc/common/Instrument.cpp:440` |
| ORS | `./live/data/position.csv`（`POSITION_FILE`） | `deploy_cpp/bin/` | `ors/China/src/ORSServer.cpp:111`；`scripts/build_deploy_cpp.sh:184-186` |
| ORS/TradeBot | `./config/*`、`./controls/*`、`./models/*` | `deploy_cpp/bin/` | 生成的 `start_strategy.sh`（模板 `scripts/build_deploy_cpp.sh:445-459`） |

`ops_install_deps.sh` 用**符号链接**把 `/home/hft/tbdata/*` 指回 `data_cpp/data/*`，从而让“绝对路径”也落在 git 管理的事实源上（`:45-68`）：

```text
/home/hft/tbdata/{contractfile,fee.csv,OptionsParams,RolloverOverrideFile,
                  SimpleChinaInstruments,name.csv,sections.csv,trading_days.txt}
        → /root/quantlink-trading/data_cpp/data/<同名>
```

> **复刻必做**：漏掉这组软链，TradeBot 启动会在 `LoadTCost2` 找不到合约费率直接 `exit(1)`（`tbsrc/main/TradeBotUtils.cpp:2463-2495`）。  
> **陷阱**：`deploy_cpp/data/fee.csv` 也会存在（构建时从 `data_cpp` 拷），但 **TradeBot 不读它**。改费率要改 `data_cpp/data/fee.csv`（`ops_refresh_fee.sh:95` 的 `--apply` 正是写这里；落盘实现见 `ors/tools/fee_refresh/fee_refresh.cpp:1821`）。`ops_setup_arbi.sh:154-158` 往 `deploy_cpp/data/fee.csv` 兜底拷贝只对旧路径有意义（**I**）。

### 3.3 运行时数据与归档

| 数据 | 生产者 | 归档 | 是否入 git |
|---|---|---|---|
| `daily_init.<SID>` | TradeBot 平仓退出时写 | `ops_snapshot_daily_init.sh` 每日 07:00 → `deploy_cpp/daily_init_bak/<日期>/` | ✅ 由 `ops_sync_git.sh` 每日提交 |
| `position.csv` | ORS（启动/关机/CTP 查询回调） | `ops_snapshot_money.sh` → `money_bak/` | ✅ 每日提交 |
| 交易日志 | TradeBot/ORS | `ops_rotate_logs.sh` → `log.bak/<文件名日期>/` | ❌ 仅本地 |
| CTP 流文件 | CTP API | `ctp_flow.bak/` | ❌ 仅本地 |
| 日终报告 | `ops_eod_report.sh` | `report_bak/` | ❌ 仅本地 |
| MD 录制 | `md-recorder` | `/home/u50_data` | ❌ 仅本地 |

证据：`ops_sync_git.sh:25`；`ops_rotate_logs.sh:8-13,35-70`；`ops_snapshot_daily_init.sh:5,22-31`；`ops_snapshot_money.sh:5-6,24-44`；`ops_eod_report.sh:14,125-126`；`docs/RISK_NO_OFFSITE_BACKUP.md:44-75`。

---

## 4. 配置

### 4.1 配置总表

| 文件/目录 | 作用 | 入 git | 部署目标 | 证据 |
|---|---|---|---|---|
| `data_cpp/bin/config/config_CHINA.<SID>.cfg` | 每策略运行参数（SHM/CPU/交易所/产品） | ✅ | `deploy_cpp/bin/config/` | `data_cpp/bin/config/config_CHINA.92221.cfg:1-24` |
| `data_cpp/bin/config/StrategyConfig.cfg` | 账户级全局参数 | ✅ | 同上 | `StrategyConfig.cfg:1-4` |
| `data_cpp/bin/config/strategies.disabled` | 启动跳过清单 | ✅ | 同上 | `strategies.disabled:1-10` |
| `data_cpp/bin/config/memlog-reader.yaml` | Dashboard 主配置（端口/SHM/飞书） | ✅ | `deploy_cpp/bin/config/` | `memlog-reader.yaml:1-30` |
| `data_cpp/bin/config/memlog-reader.alt.yaml` | 备用端口实例 | ✅ | 同上（强制覆盖） | `memlog-reader.alt.yaml:1-15` |
| `data_cpp/bin/config/check-md.yaml` | 断流检测 | ✅ | 同上 | `check-md.yaml:1-20` |
| `data_cpp/bin/config/md-recorder.yaml` | 行情录制 | ✅ | 同上 | `md-recorder.yaml:1-15` |
| `data_cpp/bin/config/ors/contracts/contracts.csv` | ORS 订阅合约 | ✅ | `deploy_cpp/bin/config/ors/contracts/` | `ls`；`ors/China/src/ORSServer.cpp:110` |
| `data_cpp/bin/config/ors/configs/rms/*.xml` | RMS 前置检查规则 | ✅ | 同上 | `ls data_cpp/bin/config/ors/configs/rms` |
| `data_cpp/bin/config/ors_server.cfg` | **CTP 凭据 + ORS 全量参数** | ❌ **gitignored** | `deploy_cpp/bin/config/`（随 `config/` 目录） | `.gitignore:42`；`docs/STARTUP_GUIDE.md:88` |
| `data_cpp/bin/controls/{day,night}/control.<leg1>.<leg2>.par.txt.<SID>` | 合约对 + 时段窗口 | ✅ | `deploy_cpp/bin/controls/` | 文件首行；`ops_setup_arbi.sh:77-109` |
| `data_cpp/bin/models/model.<leg1>.<leg2>.par.txt.<SID>` | 策略阈值 | ✅ | `deploy_cpp/bin/models/` | 示例文件 |
| `data_cpp/bin/live/data/position.csv` | ORS 持仓快照 | ✅（每日变） | `deploy_cpp/bin/live/data/` | `.claude/CLAUDE.md:920` |
| `data_cpp/data/*` | 日初/合约/费率/日历 | ✅ | `deploy_cpp/data/` + `/home/hft/tbdata` 软链 | `ops_install_deps.sh:50-68` |
| `ops/db.conf` | PG 凭据 + 企微 webhook | ❌ **gitignored** | 原地 source | `.gitignore:100-101` |
| `/root/.quantlink/strategy_sync.env` | RDS/本地 PG 凭据 | ❌ 仓库外 | 原地，600 | `tools/strategy_sync/README.md:24-29` |
| `tbadmin/cfg/{admin,agent}.cfg` | tbadmin 端口/SHM/DB 地址 | ✅ | 原地（cwd=tbadmin） | `tbadmin/cfg/admin.cfg:1-5`；`agent.cfg:1-19` |
| `tbadmin/cfg/order_ref.json` | 订单引用持久化 | ✅（初始 `{}`） | 原地，每日 `clear.sh` 重置 | `tbadmin/clear.sh:5` |
| `feishu.secret.yaml` | 飞书告警 | ❌ `*.secret.yaml` | `deploy_cpp/bin/config/`（仅缺失时） | `.gitignore:36`；`build_deploy_cpp.sh:869-871` |
| `.env`（仓库根） | 历史遗留环境文件 | ❌ `.gitignore:95` | 不参与部署 | 本档案**不读取内容** |

### 4.2 `config_CHINA.<SID>.cfg`

示例结构（`data_cpp/bin/config/config_CHINA.92221.cfg:1-30`）：

```ini
LOGGER_THREAD_CPU_AFFINITY =
LOGGER_THREAD_SCHED_POLICY = SCHED_BATCH
SHM_MD_RESP_THREAD_CPU_AFFINITY = 2
SHM_MD_RESP_THREAD_SCHED_POLICY = SCHED_FIFO
INTERACTION_MODE = LIVE
DATA_FORMAT_ENGINE = TBTMode
XSIM_CONFIG_PATH = ../SimConfig/SimConfig.cfg
SANITY_CHECK_FILE = ../config/sanitycheck.cfg

EXCHANGES=CHINA_SHFE,CHINA_CFFEX,CHINA_ZCE
MONITORSHMKEY = 789
MONITORSHMSIZE = 1024
PRODUCT = AU

[CHINA_SHFE]
MDSHMKEY = 4097
ORSREQUESTSHMKEY = 8193
ORSRESPONSESHMKEY = 12289
CLIENTSTORESHMKEY = 16385
MDSHMSIZE = 2048
...
```

| 键 | 含义/约束 | 证据 |
|---|---|---|
| `SHM_MD_RESP_THREAD_CPU_AFFINITY` | **每策略必须唯一**；`ops_setup_arbi.sh` 会校验冲突并拒绝生成 control | `ops_setup_arbi.sh:45-58` |
| `MONITORSHMKEY` / `MONITORSHMSIZE` | MemLog SHM；`start_all.sh` 从**第一个** `config_CHINA.*.cfg` 取值建 SHM（缺省 789） | `build_deploy_cpp.sh:595-601` |
| `MDSHMKEY` / `ORSREQUESTSHMKEY` / `ORSRESPONSESHMKEY` / `CLIENTSTORESHMKEY` | 四个全局总线；所有策略/交易所共用同一组 key | 各 cfg `[CHINA_*]` 段 |
| `MDSHMSIZE=2048` | 槽位数；`tbadmin agent` 的 `MD_LEN_LIST` 必须一致，否则 `shmget EINVAL` | `tbadmin/cfg/agent.cfg:4-6` |
| `INTERACTION_MODE=LIVE` | 实盘 | — |
| `XSIM_CONFIG_PATH=../SimConfig/SimConfig.cfg` | 回测/数据服务路径；`deploy_cpp` 不部署 `SimConfig`，实盘（`--Live --controlFile`）路径**推测**不读它（**I**） | `tbsrc/main/startDataServer.cpp:24`；`tbsrc/main/main.cpp:1107`；`build_deploy_cpp.sh` 无拷贝 |
| `SANITY_CHECK_FILE` | 同上，`deploy_cpp` 无此文件 | **I**（未验证是否被读取） |

> **多策略 CPU 是共享资源**：190 只有 4 核（`.claude/CLAUDE.md:630-632`），策略占 0/2/3，ORS 自旋线程与 MD 线程锁 1。新增策略前必须先查亲和唯一性，否则 SCHED_FIFO 互饿死（这是 D15 的根因）。

### 4.3 `StrategyConfig.cfg`

```ini
ACCOUNT=OWN
MAX_POS_SIZE=1000
MAX_ORDERS=5000
LOGGER_THREAD_CPU_AFFINITY=0
```

证据：`data_cpp/bin/config/StrategyConfig.cfg:1-4`。

> 语义坑：`MAX_POS_SIZE` 在 TradeBot 里是**累计成交量上限**（`m_maxTradedQty`），不是持仓上限；真实持仓限制在各策略 model 的 `MAX_SIZE/BID_MAX_SIZE/ASK_MAX_SIZE`（详见 `02-runtime-strategy.md`，`00-source-map.md:147-149`）。

### 4.4 `controls/` 与 `models/`

**control 首行格式**（空格分隔，UTC HHMM）：

```text
IF_F_3_CFFEX ./models/model.IF2703.IF2706.par.txt.92203 CFFEX 16 TB_PAIR_STRAT 0130 0700 IF_F_6_CFFEX
```

| 字段 | 含义 | 证据 |
|---|---|---|
| 1 | 近/远月模板符号（`_F_<MM>_<EXCH>`） | `.claude/CLAUDE.md:846-850` |
| 2 | model 文件相对路径 | 同上 |
| 3 | 交易所 | — |
| 4 | client id | — |
| 5 | 策略类型 `TB_PAIR_STRAT` | — |
| 6/7 | 时段 start/end（**UTC HHMM**） | `ops_setup_arbi.sh:60-68,97-109` |
| 8 | 第二腿模板符号 | — |

**model 格式**：前两行是两条腿（`FUTCOM Dependant 0 MID_PX`），随后是 `KEY VALUE` 阈值（`BEGIN_PLACE/LONG_PLACE/SHORT_PLACE/...`）。示例：`data_cpp/bin/models/model.IF2703.IF2706.par.txt.92203:1-30`。

**时段窗口来源：** `data_cpp/data/session_rules.csv`，由 `ops_setup_arbi.sh` 用北京时间→UTC 重算（`:71-124`）。**但该脚本当前不在生效 cron 里**（只在被注释的夜盘块，`ops/crontab.txt:923-939`）⇒ **当前 control 的时段是静态值，不会随 `session_rules.csv` 自动更新**（**V**，需人工跑或恢复 cron）。

### 4.5 `data/` 关键文件

| 文件 | 用途 | 消费方 | 证据 |
|---|---|---|---|
| `fee.csv` | 手续费（8 列，每行必须全非空） | `LoadTCost2`（绝对路径） | `tbsrc/main/TradeBotUtils.cpp:2463-2495`；`ors/tools/fee_refresh/fee_refresh.cpp:15-32` |
| `contractfile` | 合约规格 | `Instrument.cpp`（绝对路径） | `tbsrc/common/Instrument.cpp:1548` |
| `RolloverOverrideFile` | 换月覆盖 | `Instrument.cpp:440` | — |
| `trading_days.txt` | 交易日历（每行 `YYYYMMDD`，升序） | 启动门控/看门狗 | `scripts/is_trading_day.sh:5-16` |
| `session_rules.csv` | 品种交易时段真值 | `ops_setup_arbi.sh`、`ops_feed_db.py` | `ops_setup_arbi.sh:72-75` |
| `sections.csv` | 板块/时段表 | TradeBot/监控 | `ops_setup_arbi.sh:126-152` |
| `daily_init.<SID>` | 昨仓/均价种子 | TradeBot | 示例文件 12 列 |
| `position.csv` | ORS 持仓快照 | 运维/对账 | `ORS` 注释；`.claude/CLAUDE.md:920` |
| `OptionsParams` | 期权参数 | 期权策略 | `README`/文件 |
| `SimpleChinaInstruments` / `name.csv` | 品种/合约名映射 | 展示/解析 | — |

**`daily_init` 实际列数**：`StrategyID 2day avgPx m_origbaseName1 m_origbaseName2 ytd1 ytd2 px1 px2 max_pnl pnl`（12 列，示例 `daily_init.92204`）。文档里常写成 8 列，**以文件为准**（**V**）。

**`position.csv` 格式**：`symbol,ONLong,todayLong,ONShort,todayShort`（示例 `data_cpp/bin/live/data/position.csv`；`.claude/CLAUDE.md:921`）。

### 4.6 `ors_server.cfg`（不入库，键名清单）

文件不在仓库（`.gitignore:42`；`ls data_cpp/bin/config/` 无此文件），但 ORS 启动**必需**：`./ors_server config/ors_server.cfg`（生成脚本 `:369`）。

从代码提取的键（**不含值**）：

| 分组 | 键 | 证据 |
|---|---|---|
| 文件/日志 | `LOG_FILE`、`STATS_FILE`、`API_LOG_DIR`、`CONTRACT_FILE`、`POSITION_FILE` | `ors/China/src/main.cpp:60-66`；`ORSServer.cpp:64,102-111,132-150` |
| SHM | `REQUEST_SHMKEY`、`REQUEST_SHMSIZE`、`RESPONSE_SHMKEY`、`RESPONSE_SHMSIZE`、`CLIENT_STORE_KEY`、`MAX_CLIENTS` | `ORSServer.cpp:104-109` |
| RMS | `RMS_CONFIG_FILE`、`RMS_FIRMWIDE_CONFIG_FILE` | `ORSServer.cpp:102-103` |
| CTP | `FRONT_ADDR_ORS`、`FRONT_ADDR_MD`、`MULTICAST_ADDR`、`BROKER_ID`、`INVESTOR_ID`、`INVESTOR_ID_{SHFE,CFFEX,DCE,ZCE}`、`PASSWORD`、`NEWPASSWORD`、`AUTH_CODE`、`APP_ID`、`PRODUCTION_MODE` | `ORSServer.cpp:403-415,131` |
| 线程调度 | `SHM_REQ_THREAD_CPU_AFFINITY`、`SHM_REQ_THREAD_SCHED_POLICY`、`CHINA_MD_THREAD_*` | `C++_deps/hftbase/Ipc/include/shmmanager.h:543-573`；`ors/China/src/MdSpi.cpp:99` |

**安全事实（必须记录）：**

- `ORSServer::Login()` 把 `m_PASSWORD` **明文写进日志**（`ors/China/src/ORSServer.cpp:420,430,443,460`）。ORS 日志因此属于**敏感文件**，不能外发。（**V**）
- `fee_refresh` 明确不打印凭据（`ors/tools/fee_refresh/fee_refresh.cpp:44-50`），是对 ORS 行为的刻意纠正。
- 文件权限：仓库内没有 `chmod`；本机 `ops/db.conf` 为 `644`。生产是否收紧**未验证**（**I**）。

### 4.7 外部黑盒配置（不在本档案范围）

| 文件 | 关键键 | 说明 |
|---|---|---|
| `memlog-reader.yaml` | `http.{dashboard_port:8080,monitor_port:8081}`、`shm.{memlog_key:789,response_key:12289,md_key:4097,request_key:8193}`、`feishu.secret_file`、`manual_order.enabled:false`、`strategies.<SID>` | `data_cpp/bin/config/memlog-reader.yaml:1-30` |
| `memlog-reader.alt.yaml` | 同上，端口 28080/28081 | 190 上 8080 被 nginx 占用时的替代（`start_all` 可用 `ops/db.conf` 的 `MEMLOG_READER_CONFIG` 覆盖，`build_deploy_cpp.sh:637-656`） |
| `check-md.yaml` | `shm_key:4097`、`stale_sec:5`、`trade_windows` | `data_cpp/bin/config/check-md.yaml:1-20` |
| `md-recorder.yaml` | `shm_key:4097`、`out_dir:/home/u50_data` | `data_cpp/bin/config/md-recorder.yaml:1-15` |

> `memlog-reader` 的 Go 实现细节不在本档案范围；这里只把它当“读 SHM 的 HTTP 黑盒”，用于日终快照和验收（`ops_eod_report.sh:88-108`）。

### 4.8 配置流向

```text
             (git, 唯一可编辑源)
  data_cpp/bin/{config,controls,models,live}
  data_cpp/data/*
        │
        │ build_deploy_cpp.sh  (cp -Rn / 强制 trading_days)
        ▼
  deploy_cpp/bin/{config,controls,models,live}     deploy_cpp/data/
        │                                               │
        │ 进程 cwd                                      │ ../data
        ▼                                               ▼
   ors_server / TradeBot  ────────────────►  daily_init.<SID>
        │
        │ 绝对路径（软链）
        ▼
  /home/hft/tbdata/{fee.csv,contractfile,...} ──► data_cpp/data/*
```

**写入回流的唯一路径：** TradeBot 写 `deploy_cpp/data/daily_init.*` → `stop_all.sh` 调 `sync_data_back.sh` → 拷回 `data_cpp/data/` → `ops_sync_git.sh` 15:20 提交推送（`sync_data_back.sh:1-55`；`ops_sync_git.sh:25-35`）。

> `sync_data_back.sh` 有**双向 mtime 规则**：`deploy` 较新→回灌；`data_cpp` 较新（人工改过）→ 反向下发，但**仅当该策略未运行**（`:21-40`）。这是为了防止换月人工改动被运行时旧值拉回。

---

## 5. 会话生命周期

### 5.1 启动链

```text
cron 08:50
  └─ scripts/ops_start_session.sh day
       ├─ PATH 固定（/usr/local/sbin:...）
       ├─ 交易日历门控 is_trading_day.sh --today
       │    rc=0 继续 / rc=1 跳过(exit 0) / rc=2 故障(exit 1, fail-closed)
       ├─ 残留 ors_server? → deploy_cpp/bin/scripts/stop_all.sh
       └─ deploy_cpp/bin/scripts/start_all.sh ctp day
            ├─ 再次日历门控（ctp 模式）
            ├─ start_ors.sh ctp
            │    ├─ 已有 ors_server → 拒绝
            │    ├─ ulimit -c 0
            │    ├─ ipcrm -m 全部当前用户 SHM
            │    └─ ./ors_server config/ors_server.cfg（nohup 到 log/ors_server.<date>.log）
            ├─ sleep 2 + python3 shmget(789, 16MB)
            ├─ 读 strategies.disabled
            ├─ for config_CHINA.*.cfg（有该时段 control 且未停用）
            │    └─ start_strategy.sh <SID> <session>
            └─ memlog-reader -config config/memlog-reader[.alt].yaml
```

证据：`scripts/ops_start_session.sh:15-61`；`scripts/build_deploy_cpp.sh:531-666`。

### 5.2 `start_all.sh`

| 步骤 | 细节 | 证据（生成模板行号） |
|---|---|---|
| 参数 | `$1`=mode（默认 `sim`），`$2`=session（空则按时间判断） | `:541-542,579-584` |
| 日历门控 | 仅 `ctp`；`TDFILE` 回退 `../data/trading_days.txt` → `data_cpp/data/trading_days.txt`；`--night-ok` 用于夜盘 | `:549-577` |
| 时段判定 | 21:00–02:30 夜盘；08:30–15:00 日盘；否则报错退出 | `:579-584` |
| ORS | `./scripts/start_ors.sh "$MODE"`；`sleep 2` | `:590-591` |
| MemLog SHM | 从第一个 `config_CHINA.*.cfg` 取 `MONITORSHMKEY`（默认 789），`shmget(key, 16MB, 0666|01000)` | `:593-601` |
| 停用清单 | 优先 `data_cpp/bin/config/strategies.disabled`，回退 deploy 副本 | `:603-611` |
| 策略循环 | 只启动“有 `controls/<session>/control.*.par.txt.<SID>`”的 SID；单策略失败不阻断 | `:615-635` |
| Dashboard | `memlog-reader` 可由 `ops/db.conf` 的 `MEMLOG_READER_CONFIG` 覆盖；写 `memlog-reader.pid` | `:637-656` |
| 结果 | 有失败 SID → exit 1（cron 日志可见） | `:662-665` |

**当前停用清单（V）**：`92201`（ag 已交割）、`92202`（au 已交割）、`92203`（IF + ORS 拒 FAK）⇒ 实际自动启动的是 `92204`、`92221`、`92222`（若当日有 control）。

> `strategies.disabled` 只影响**一键/cron 启动**；手动 `start_strategy.sh` 不受影响（`data_cpp/bin/config/strategies.disabled:1-5`）。

### 5.3 `start_ors.sh`

| 行为 | 细节 | 证据 |
|---|---|---|
| 参数 | `sim|ctp`，默认 `sim` | `:309-315` |
| 模式记录 | `echo $MODE > .gateway_mode` | `:317` |
| 配置检查 | ctp 必须有 `config/ors_server.cfg` | `:329-335` |
| **双启动防护** | `pgrep -x ors_server` + `/proc/<pid>/stat` 排除僵尸；有活实例直接退出 1 | `:337-361` |
| core | `ulimit -c ${CORE_LIMIT:-0}` | `:362` |
| SHM 清理 | `ipcs -m | grep $(whoami) | awk '{print $2}' | xargs ipcrm -m`（**清当前用户全部 SHM 段**） | `:363` |
| 启动 | `./ors_server config/ors_server.cfg > log/ors_server.<YYYYMMDD>.log 2>&1 &`，`sleep 3` | `:367-371` |
| sim | 明确不启动 ORS（仅 CTP） | `:372-374` |

> **没有登录成功校验**：`sleep 3` 后只打印“已启动”。ORS 可能仍在 `Waiting for trader login`（`ors/China/src/main.cpp:88-95`），真正校验靠 `ops_preopen_check.sh` 的 MD SHM head（§6.6）。（**V**）

### 5.4 `start_strategy.sh`

| 行为 | 细节 | 证据 |
|---|---|---|
| 参数 | `<SID> [day|night] [--fg]` | `:400-421` |
| 时段推断 | 21:00–02:30 / 08:30–15:00；否则要求手填 | `:423-441` |
| control 查找 | `controls/<session>/control.*.par.txt.<SID>`，glob 第一个 | `:445-453` |
| config 检查 | `config/config_CHINA.<SID>.cfg` 必须存在 | `:455-459` |
| 重复启动 | PID 文件 `trader.<SID>.pid` + `pgrep -f "strategyID <SID>"` | `:461-477` |
| 日志 | `log/log.<control_basename>.<date>`；nohup `log/nohup.<control_basename>.<date>` | `:481-482,511-512` |
| 库路径 | `tbsrc/hftbase/libs`、`tbsrc/hftbase/libs_local/lib64` | `:496-500` |
| 命令 | 见 §2.6 | `:505` |
| 前台 | `--fg` → `eval ... | tee -a` | `:507-509` |
| 启后校验 | `sleep 3` + `kill -0`，失败 tail 20 行并 exit 1 | `:519-526` |

**日志时间**：策略日志用 **UTC**，服务器用 CST（`ops_tb_signal.sh:136`；`docs/GETTING_STARTED.md:203`）。排障时不要按本地时间对齐。

### 5.5 `stop_all.sh`

| 顺序 | 行为 | 证据 |
|---|---|---|
| 1 | 遍历 `trader.*.pid` → `kill -TERM`，删 pid | `:682-688` |
| 2 | 最多等 10s；仍有 `pgrep -f TradeBot` → `pkill -9 -f TradeBot` | `:690-694` |
| 3 | `memlog-reader.pid` → TERM；再 `pkill -f memlog-reader` | `:697-704` |
| 4 | ORS：`pkill -TERM -x ors_server`，轮询直到退出，默认上限 `ORS_WAIT_SEC=90`；超时 `SIGKILL` | `:706-737` |
| 5 | `ipcrm -m/-s/-q` 清当前用户**全部**共享内存/消息队列/信号量 | `:739-741` |
| 6 | `rm -f .gateway_mode` | `:743` |
| 7 | 调 `scripts/sync_data_back.sh`（daily_init + position.csv 回灌 `data_cpp`） | `:747-752` |

> **ORS 必须等真退出**：CTP `Release()` 约 70s，且退出时会在 `libthostmduserapi_se` 里崩一次（core ~180MB）。若发完 TERM 就 `ipcrm` 并 3 秒后拉起新实例，会 CTP 同账号双登录互踢 ⇒ 全天零行情（`scripts/build_deploy_cpp.sh:706-709`；`.claude/CLAUDE.md:594-642`）。（**V**）

### 5.6 信号语义

| 进程 | 信号 | 行为 | 证据 |
|---|---|---|---|
| TradeBot | `SIGUSR1`（10） | 激活：`m_Active=true` + `HandleSquareON()`；日志 `Strategy is active now.` | `tbsrc/main/main.cpp:150-159` |
| TradeBot | `SIGTSTP`（20） | **平仓 + 停用**：`m_onExit/onCancel/onFlat=true` + `HandleSquareoff()`；日志 `Squareoff is called.` | `main.cpp:142-149` |
| TradeBot | `SIGUSR2`（12） | 重载阈值 `LoadThresholds()`；日志 `Strategy Thresholds Reset.` | `main.cpp:169-176` |
| TradeBot | `SIGTERM` / `SIGRTMIN`(34) / `36` | 按 `./config/signal.txt` 里的品种列表平仓 | `main.cpp:110-141` |
| TradeBot | `37` / `36+symbol` | 激进平仓（`m_aggFlat`） | `main.cpp:160-168` |
| ORS | `SIGTERM` | CTP Release，约 70s；可能 core | `stop_all` 注释；`.claude/CLAUDE.md:600-610` |

**运维工具**：`ops_tb_signal.sh <SID|all> <activate|deactivate|reload>`，通过扫 `/proc/<pid>/cmdline` 精确匹配 `--strategyID`（避免 `92201` 命中 `922010`）（`ops_tb_signal.sh:78-98`）。旧名包装 `tbstart/tbstop/tbreload` 转调它（`scripts/tbstart:1-12`）。

> `deactivate` **会真的平仓**，不是“暂停信号”（`ops_tb_signal.sh:24-27`）。`SIGTSTP` 默认动作是挂起；若处理器未就绪，进程会被挂起——先确认日志出现 `Strategy is active now.` 再操作。

### 5.7 进程、PID、端口

| 进程 | comm 名 | PID 文件 | 端口 | 证据 |
|---|---|---|---|---|
| `ors_server` | `ors_server` | 无（靠 pgrep） | 出站 CTP | `start_ors.sh` |
| `TradeBot` | `TradeBot` | `trader.<SID>.pid` | 无监听 | `start_strategy.sh:462,515` |
| `memlog-reader` | `memlog-reader` | `memlog-reader.pid` | 8080/8081（或 28080/28081） | `start_all.sh`；`memlog-reader.yaml:2-3` |
| `md-recorder` | `md-recorder` | `md-recorder.pid` | 无 | `ops_start_md_recorder.sh:27-33` |
| `check-md` | `check-md` | `check-md.pid` | 无 | `ops_check_md.sh:44-46` |
| `tbadmin admin` | **`AdminLoop`** | `tbadmin/admin.pid` | ZMQ 9980/9981 | `tbadmin/start_admin.sh:17-18`；`ops_check_status.sh:155-163` |
| `tbadmin agent` | **`AgentLoop`** | `tbadmin/agent.pid` | 连 9980/9981 | `tbadmin/start_agent.sh:19-20`；`ops_check_status.sh:156` |
| `message_forwarding.py` | python | `/tmp/flask.pid` | 8882 | `start_all_with_tbadmin.sh:98-104` |
| `vue3-admin` 后端 | python | 无 | 5004 | `start_tbadmin.sh:47-52` |
| nginx（管理前端） | nginx | systemd | 50003 | `ops/nginx/quantlink-admin.conf:1-25` |
| PostgreSQL | postgres | systemd | 5432（仅 127.0.0.1） | `tools/strategy_sync/README.md:9` |

> `pgrep -x tbadmin` **永远匹配不到**——tbadmin 用 `prctl(PR_SET_NAME)` 改成了 `AdminLoop`/`AgentLoop`（`ops_check_status.sh:155-158`）。复刻时别写错。

### 5.8 启停的“两个入口”

| 入口 | 用途 | 是否含 tbadmin | 证据 |
|---|---|---|---|
| `deploy_cpp/bin/scripts/start_all.sh` / `stop_all.sh` | 核心（ORS+TradeBot+Dashboard） | ❌ | 生成脚本 |
| `scripts/start_all_with_tbadmin.sh` / `stop_all_with_tbadmin.sh` | 核心 + tbadmin + Flask | ✅（`no_tbadmin` 可关） | `start_all_with_tbadmin.sh:37-112` |
| `scripts/start_all_with_frontend.sh` | 上面 + 防火墙放行 8080/8081/8882 | ✅ | `start_all_with_frontend.sh:37-50` |
| `scripts/start_tbadmin.sh` | tbadmin + Flask + vue3-admin（开发/调试用，`pkill -9` 前置） | ✅ | `start_tbadmin.sh:20-60` |

**cron 不使用这些“with_tbadmin”脚本**：它分别调度 `ops_start_session.sh` 和 `tbadmin/start_*.sh`（`ops/crontab.txt:43-47,919-921`）。

---

## 6. 调度与主机运维

### 6.1 crontab 的组织方式

`ops/crontab.txt`（946 行）不是“一行一条”，而是**带迁移史的操作手册**：

| 区段 | 行号 | 性质 |
|---|---|---|
| 文件头/铁律/安装说明 | 1-33 | 说明 |
| PATH + NTP | 35-39 | **当前生效** |
| 交易会话/DB/同步/快照/费率/轮转/检查/日历/录制/断流/看门狗/体检 | 41-131 | **当前生效**（夜盘行被注释） |
| 已移除旧任务与理由 | 133-913 | **历史对照，不执行** |
| 日盘固定块 | 915-921 | **当前生效** |
| 夜盘受管块 | 923-939 | **全部注释**（2026-11-04 停用） |
| 期权快照 / tbadmin 守护 | 941-946 | **当前生效** |

**安装方式：整份替换** `crontab /root/quantlink-trading/ops/crontab.txt`。任何 `crontab -e` 直接加的行会在下次重装时被清掉（文件头铁律 6，`:27-31`；真实事故：strategy_sync 被静默清除，`:60-67`）。

### 6.2 当前生效的日盘时间线（工作日）

| 时间 | 任务 | 说明 | 证据 |
|---|---|---|---|
| 06:00 | `chronyc -a makestep` | 校时（替代旧 ntpdate） | `:39` |
| 07:00 | `ops_snapshot_daily_init.sh` | 盘前 daily_init 快照 | `:70` |
| 08:28 | `tbadmin/stop_agent.sh` | 先停（`stop_agent` 按进程名会连 admin 一起杀） | `:919`；`ops_ensure_tbadmin.sh:3-5` |
| 08:30 | `tbadmin/start_agent.sh` + `start_admin.sh` | 加载昨夜 20:30 同步的策略表 | `:920-921` |
| 08:47 | `ops_start_md_recorder.sh` | 行情录制（读 MD SHM） | `:917` |
| **08:50** | **`ops_start_session.sh day`** | 日盘会话启动 | `:43` |
| 08:55 / 09:00 | `ops_preopen_check.sh` | 开盘前体检（MD head 绝对值） | `:123-125` |
| 09:05 | `is_trading_day.sh && ops_tb_signal 92221/92222 activate` | 自动激活测试策略 | `:46` |
| 09:20 | `ops_delta_snapshot.py --tag open` | 期权 Delta 快照 | `:942` |
| 09:01 | `ops_check_md.sh start` | 断流检测启动 | `:111` |
| 09:35 / 13:35 / 21:35 | `ops_watchdog_memlog.sh` | Dashboard 缺失即拉起 | `:115` |
| 每 5 分钟 09-11,13-14 | `ops_md_liveness_watchdog.sh` | MD SHM head 不增长 → 重启会话 | `:118` |
| 每 5 分钟 09-11,13-15 | `ops_ensure_tbadmin.sh` | agent/admin 存活守护 | `:946` |
| 10:30 / 20:30 | `strategy_sync`（flock） | RDS → 本地策略表 | `:67` |
| 11:46 | `ops_snapshot_money.sh am` | 资金/持仓快照 | `:91` |
| 14:50 | `ops_delta_snapshot.py --tag close` | 收盘前快照 | `:943` |
| **15:05** | **`ops_stop_session.sh day`** | 日终报告 → stop_all → 数据回灌 | `:47` |
| 15:15 | `ops_rotate_logs.sh` | 日志/ctp_flow 轮转 | `:96` |
| 15:16 | `ops_snapshot_money.sh pm` | 盘后快照 | `:92` |
| 15:20 | `ops_sync_git.sh day` | 提交/推送 daily_init + position.csv | `:71` |
| 15:30 | `tbadmin/clear.sh` | 重置 order_ref / 删 `cfg/*.dat` | `:131` |
| 15:30 | `ops_check_md.sh stop` | 断流检测停止 | `:112` |
| 15:40 | `ops_refresh_fee.sh apply` | CTP 直查刷新 fee.csv + commit/push | `:88` |
| 17:00 | `ops_feed_db.sh` | 合约 dump → DB + contractfile 同步 | `:55` |
| 00:00 | `ops_check_status.sh` | 9 项健康检查 | `:99` |
| 01-02 06:10 | `update_trading_days.py --check` | 年度日历巡检 | `:103` |

**夜间（全部注释，V）**：`ops_setup_arbi.sh 20:10`、`ops_start_session.sh night 20:13`、tbadmin 20:28/20:30、md recorder 20:47、`ops_check_status --evening 20:50`、`ops_stop_session night 02:40`、`ops_sync_git night 02:50`、money night 02:56（`:923-939`）。

> **夜盘为什么停**：夜盘柜台实测 6 周 0 连接（ORS 日志停在 `Waiting for trader login`），2026-11-04 手动停用（`ops/crontab.txt:49-50`；`.claude/CLAUDE.md:643-660`）。**这是环境事实，不是代码能力**；若换柜台/换前置，需用 `ops_night_session.py enable` 恢复。

### 6.3 交易日历门控

`scripts/is_trading_day.sh`：

| 模式 | 语义 | 退出码 | 证据 |
|---|---|---|---|
| `--today` | 今天在 `trading_days.txt` 中 | 0 是 / 1 否 / 2 日历故障 | `:56-70` |
| `--next` | 输出下一个交易日 | 0 / 2 | `:71-76` |
| `--night-ok` | 今天是交易日 **且** 下一交易日距今 ≤3 自然日（节前夜盘取消；周五→周一=3 放行） | 0/1/2 | `:77-101` |

- 日历源：`data_cpp/data/trading_days.txt`，可用 `TDFILE` 覆盖（`:15,27-34`）。
- **fail-closed**：文件缺失/为空/无有效日期 → `exit 2`，调用方必须视为“不启动”（`:13,36-54`）。
- 三重门控：`ops_start_session.sh`（`:30-47`）、`start_all.sh ctp`（`:549-577`）、看门狗/体检（`ops_md_liveness_watchdog.sh:78-86`、`ops_preopen_check.sh:67-73`）。

**日历生成**：`tools/trading_calendar/update_trading_days.py` 用“周一~周五 − 内嵌节假日表”推算，**不是**交易所日历接口；文件头明确记录曾误用 SHFE `calendar_<YYYY>.dat` 导致缺 94/105 天（`:1-20`）。`--check` 只报告不写（cron 仅做年度巡检）。

### 6.4 `ops_setup_arbi.sh`（当前未调度）

| 功能 | 细节 | 证据 |
|---|---|---|
| CPU 亲和唯一性 | 冲突 → 告警 + `exit 1`，拒绝生成 | `:45-58` |
| 重算 control 时段 | 读 `session_rules.csv`，北京时间→UTC HHMM；`day` 用 am_start/pm_end，`night` 用 night_start/night_end | `:60-124` |
| 重生成 `sections.csv` | 从 DB `tbtrade_sections` 生成 7 列 parity 格式 | `:126-152` |
| `fee.csv` 兜底 | 只在 deploy 缺失时从 `data_cpp` 拷 | `:154-158` |
| 日志 | `deploy_cpp/bin/log/cron_setup_arbi.log` | `:29` |

**现状（V）**：唯一调用点是夜盘受管块（`:925`，已注释）⇒ **日盘 control 时段不会被每日重算**。`ops_setup_arbi.sh` 支持 `--dry-run`（`:31-32`），复刻时建议先 dry-run 再恢复 cron。

### 6.5 数据/DB 同步任务

| 脚本 | 频率 | 做什么 | 证据 |
|---|---|---|---|
| `ops_feed_db.sh` → `ops_feed_db.py` | 17:00 | 读 ORS 合约 dump `log/contracts_YYYY_MM_DD` → UPSERT `tbinstrument_info/name`；`trading_days.txt`→`tbtrading_days`；`session_rules.csv`→`tbtrade_sections`（全量重建）；`contractfile`→`/home/hft/tbdata/contractfile` | `ops_feed_db.py:1-14,272-280` |
| `ops_sync_git.sh` | 15:20（夜盘另有 02:50，已停） | `git add data_cpp/data/daily_init.* data_cpp/bin/live/data/position.csv`；无变更跳过；有则 commit+push | `:25-35` |
| `ops_snapshot_daily_init.sh` | 07:00 | 拷 `deploy_cpp/data/daily_init.*` → `daily_init_bak/<日期>/` | `:22-31` |
| `ops_snapshot_money.sh` | 11:46 / 15:16 | 拷 daily_init + position.csv → `money_bak/money_<日期>_<label>/` | `:24-44` |
| `ops_rotate_logs.sh` | 15:15 | 按文件名日期归档 `log/*`；`ctp_flow/*` 平铺到 `ctp_flow.bak/` | `:35-70` |
| `ops_refresh_fee.sh` | 15:40 | 门控 → `fee_refresh --apply` → 写成功戳 → 只提交 `fee.csv` | `:69-186` |
| `strategy_sync` | 10:30 / 20:30 | 阿里云 RDS `appdb.tbhft_strategy` → 本机 `dbtrade.tbhft_strategy`；单事务；备份表 | `tools/strategy_sync/README.md:1-60`；`ops/crontab.txt:67` |

**并发控制：** `ops_refresh_fee.sh` 用 `flock -n /tmp/fee_refresh.lock`（拿不到就跳过）；`strategy_sync` 用 cron 的 `flock -n /tmp/strategy_sync.lock`。两者与 `ops_sync_git.sh` 抢同一个 `.git/index.lock`（`ops_refresh_fee.sh:26-31,103-108`）。

**顺序约束（付费知识）：** `fee.csv` 刷新刻意放在 **15:40**：① 必须在 ORS 停机窗口（15:05–20:13），因为“同 INVESTOR_ID 并发登录会不会踢掉 ORS”**未验证**；② 在 git sync 15:20 之后；③ 在日志轮转 15:15 之后（`ops/crontab.txt:74-88`）。（**V**）

### 6.6 看门狗与体检（部署相关部分）

| 脚本 | 判据 | 动作 | 证据 |
|---|---|---|---|
| `ops_preopen_check.sh` | 08:48–09:04；ORS 不在 / 运行 >10min 且 MD head ≤1 / SHM attach 失败 | `ops_stop_session day` → `ops_start_session day` → 激活 92221/92222；600s 冷却 | `:60-146` |
| `ops_md_liveness_watchdog.sh` | 09:05–11:25 / 13:35–14:55；`check-md -probe` 15s 内 head 不增长 | 同上网重启；1800s 冷却；ORS 预热 180s | `:65-192` |
| `ops_watchdog_memlog.sh` | `pgrep -x memlog-reader` | 缺失则拉起并写 pid | `:24-46` |
| `ops_ensure_tbadmin.sh` | `agent.pid`/`admin.pid` + `kill -0` | 缺失则 `start_*.sh` | `:13-25` |
| `ops_check_status.sh` | 9 项（git 漂移、日历、fee、进程、磁盘、daily_init 漂移、contractfile、`_F_` 预检、刷新链路） | 企微告警 | `:1-30,155-167` |

> 部署验收时，这几个脚本是“系统是否真的在工作”的**可执行判据**；尤其 `check-md -probe`（读 MD SHM head）比读日志可靠（ORS 日志异步刷盘会滞后十几分钟，`.claude/CLAUDE.md:598-606`）。

### 6.7 主机引导与一次性安装

`scripts/ops_install_deps.sh`（190 上一次性）：

| 步骤 | 行为 | 证据 |
|---|---|---|
| 1 | 检查 `python3/psql/go/ntpdate/curl`；CentOS7 的 py3.6 警告 | `:19-32` |
| 2 | `pip3 install psycopg2-binary pandas requests sqlalchemy pyzmq schedule protobuf` | `:34-38` |
| 3 | `mkdir -p /home/u50_data /home/hft/tbdata`；建 9 个软链到 `data_cpp/data`；已存在真实文件先备份 | `:40-68` |
| 4 | 从 `*.example` 生成 6 个 `config.json` 与 `ops/db.conf`（占位需人工填） | `:70-86` |
| 5 | 备份现有 crontab 到 `/root/crontab_backup_<ts>.txt` | `:88-92` |
| 6 | 企微 webhook 连通性测试 | `:94-105` |

`scripts/ops_install_tb_path.sh`：把 10 个 `tb*` 名字装成 `/usr/local/bin` 下的**绝对路径 shim**（不是软链，因为包装靠 `dirname $BASH_SOURCE` 自定位）（`:9-13,44-57`）。

---

## 7. 升级与回滚

### 7.1 标准发布流程（当前实际做法）

```bash
# 0) 时机：只在停盘后（15:05 之后）或开盘前（08:50 之前）。盘中/午休不重启 TradeBot。
# 1) 开发机
git add ... && git commit -m ... && git push

# 2) 190
cd /root/quantlink-trading
git pull --ff-only
git rev-parse HEAD > /root/deploy_head.txt      # 记录回滚点（建议，当前脚本未做）

# 3) 构建（三选一）
./scripts/build_deploy_cpp.sh                   # 全量
./scripts/build_deploy_cpp.sh --ors             # 只 ORS
./scripts/build_deploy_cpp.sh --trader          # 只 TradeBot

# 4) 配置（若只改已有配置内容）
./scripts/build_deploy_cpp.sh --config-only

# 5) 启动（二选一）
#    a. 等次日 08:50 cron
#    b. 手动：./scripts/ops_start_session.sh day
```

证据：`.claude/skills/deploy-cpp/skill.md:20-120`；`docs/GETTING_STARTED.md:113-175`。

### 7.2 变更类型 → 动作矩阵

| 变更 | 必做 | 不能做 | 证据 |
|---|---|---|---|
| ORS 代码 | `--ors`；重启 ORS | 盘中重启；不等旧实例退出就起新实例 | §5.5 |
| TradeBot 代码 | `--trader`；**下一个交易日**启动 | 盘中重启 TradeBot（持仓计数器清零） | `.claude/CLAUDE.md:665-667` |
| 已有配置值（参数/亲和/SHM） | `--config-only` | 只跑全量构建（`cp -Rn` 不覆盖） | `build_deploy_cpp.sh:777-791` |
| 新增/改名 control/model（换月） | 全量构建（触发 `prune_stale_renamed`）+ `ops_f_contract_check.py` | 直接 `cp`；只跑 `--config-only` | §2.4；`.claude/CLAUDE.md:890-915` |
| `fee.csv` | `ops_refresh_fee.sh dry-run` → `apply` | 手工补行 | `ops_refresh_fee.sh:1-35` |
| 交易日历 | 更新 `data_cpp/data/trading_days.txt`；跑全量构建（该文件强制覆盖）或手工 `cp` 到 `deploy_cpp/data/` | 只跑 `--config-only`（它**不同步 `data/`**）；依赖旧副本（曾在 20241231） | `build_deploy_cpp.sh:148-169,826-836` |
| 策略库 | `strategy_sync --apply` + 重启 tbadmin admin | 期望 admin 自动热加载 | `tools/strategy_sync/README.md:44-48` |
| 管理前端 | `scripts/deploy_admin_front.sh`（rsync assets 保留 14 天） | 直接 `rm -rf` 旧 assets（在线用户白屏） | `deploy_admin_front.sh:1-30` |
| crontab | 改 `ops/crontab.txt` 后整份安装 | `crontab -e`（下次重装被清） | `ops/crontab.txt:27-31` |

### 7.3 重启顺序与健康门禁

**启动顺序（不可乱）：**

1. `ors_server`（创建/接管 4097/8193/12289/16385）
2. 等 ORS 真正登录（不是 `sleep 3`；看 `Trader login done` 或 MD head）
3. 建/确认 MemLog SHM 789
4. 各 `TradeBot`（attach 回报 SHM）
5. `memlog-reader`（读 789/12289/4097）
6. 可选：`tbadmin admin` → `tbadmin agent`（agent 是 `zmq_connect`，admin 必须先 bind）
7. 可选：Flask/前端

证据：`docs/STARTUP_GUIDE.md:172-200`；`start_all_with_tbadmin.sh:65-84`；`docs/STARTUP_GUIDE.md:244`。

**健康门禁（建议写成脚本）：**

| # | 检查 | 通过判据 | 命令 |
|---|---|---|---|
| 1 | 二进制存在且可执行 | `-x deploy_cpp/bin/{ors_server,TradeBot,memlog-reader}` | `ls -l` |
| 2 | 动态库可解析 | `ldd` 无 `not found` | `ldd deploy_cpp/bin/TradeBot` |
| 3 | ORS 进程 | `pgrep -x ors_server` | — |
| 4 | ORS 登录 | 日志 `Trader login done`（`ors/China/src/main.cpp:93-95`） | `grep` |
| 5 | SHM | `ipcs -m` 有 4097/8193/12289/789，nattch 合理 | `ipcs -m` |
| 6 | 策略进程 | `pgrep -x TradeBot` 数量 = 预期 SID 数；`trader.<SID>.pid` 存活 | — |
| 7 | 策略激活 | 日志 `Strategy is active now.`（需发过 SIGUSR1） | `tail log/log.control.*` |
| 8 | 行情流动 | `check-md -probe -probe-wait 15s` 返回 0（head 增长） | `ops_md_liveness_watchdog.sh` 同款 |
| 9 | Dashboard | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/strategies` = 200 | `ops_eod_report.sh:108` |
| 10 | 收盘 | 停后无 `ors_server/TradeBot/memlog-reader`；SHM 清空；`sync_data_back` 已跑 | `stop_all` 输出 |

### 7.4 回滚

系统**没有版本化发布物**，因此回滚只有三种手段：

#### A. 代码回滚（推荐）

```bash
cd /root/quantlink-trading
git log --oneline -5
git checkout <previous-commit>        # 或 git revert <bad-commit>
./scripts/build_deploy_cpp.sh         # 必须重新编译；deploy_cpp 不是 git 管理的
# 下一交易日启动
```

**注意：**

- `deploy_cpp/` 在 `.gitignore:33`，**不在版本控制**；回滚代码不会回滚二进制，必须重编。
- 重编会原地覆盖 `deploy_cpp/bin/{ors_server,TradeBot}`；若新版本编译失败，旧二进制仍在（`set -e` 在 `cp` 之前中止），但**没有“已知良好”的副本**。
- 建议复刻时加：每次发布前 `cp -a deploy_cpp/bin/{ors_server,TradeBot,memlog-reader} /root/releases/<ts>/`，保留最近 3 份。

#### B. 配置回滚

```bash
git checkout <prev> -- data_cpp/bin/config/config_CHINA.92221.cfg
./scripts/build_deploy_cpp.sh --config-only   # 覆盖语义，能回退
```

- **不要**用全量构建回滚配置：`cp -Rn` 会跳过已存在的目标文件，回滚不生效。
- `trading_days.txt` 例外（强制覆盖）。
- 回滚 `position.csv`/`daily_init` 时注意 `sync_data_back.sh` 的 mtime 规则（§4.8）；策略运行中反向下发会被拒绝（`:34-36`）。

#### C. 数据/DB 回滚

| 对象 | 回滚方式 | 证据 |
|---|---|---|
| `daily_init.*` / `position.csv` | `git log` 找收盘提交 → `git checkout <commit> -- data_cpp/...`；再 `--config-only`（daily_init 在 `data/`，需手工 `cp` 或下次构建） | `ops_sync_git.sh:25-33` |
| `fee.csv` | `git revert` 对应提交；`/home/hft/tbdata/fee.csv` 是软链，自动跟随 | `ops_refresh_fee.sh:172-186` |
| `tbhft_strategy` | 同步脚本每次变更生成 `tbhft_strategy_bak_sync_<ts>`；`DELETE` + `INSERT ... SELECT` 恢复 | `tools/strategy_sync/README.md:58-70` |
| `tbhft_schedule/action/product` | 设计为空表；`ops/db/hft_control_tables.sql` 可重建 | `ops/db/hft_control_tables.sql:1-32` |
| 日历 | `data_cpp/data/trading_days.txt.bak.<ts>`（工具生成，gitignored） | `.gitignore`；`ls data_cpp/data` |

### 7.5 数据兼容性约束

| 约束 | 违反后果 | 证据 |
|---|---|---|
| `fee.csv` 每行 8 列全非空；instrument 必须是查询名前缀；**不能有重复行** | `LoadTCost2` 匹配失败 `exit(1)` 或取错行 | `ors/tools/fee_refresh/fee_refresh.cpp:15-32`；`TradeBotUtils.cpp:2463-2495` |
| `daily_init` 的 `avgPx` 不能为 0 | 首笔行情触发 `AVG_SPREAD_AWAY` → 平仓 + 停用 | `.claude/CLAUDE.md:893-899` |
| `daily_init` 列数/顺序 | 解析错位/启动失败 | 示例文件；`02-runtime-strategy.md` |
| `position.csv` 5 列 | ORS 读写异常 | `.claude/CLAUDE.md:921` |
| SHM 结构 `MarketUpdateNew` = 816B、队列元素 824B、qlen 4096 | `check-md`/`md-recorder`/memlog-reader 读错位 | `data_cpp/bin/config/check-md.yaml:5-9` |
| `MD_LEN_LIST` 必须 = ORS `MD_SHMSIZE=2048` | `shmget EINVAL`，agent 启动 FATAL | `tbadmin/cfg/agent.cfg:4-6` |
| control/model 文件名与 SID 绑定 | `start_strategy` 找不到文件 | `build_deploy_cpp.sh:445-453` |
| 两腿合约时间顺序 | 价差方向反了但**启动不报错**（静默错误） | `.claude/CLAUDE.md:852-870` |

### 7.6 已知坑（按伤害排序）

1. **CTP 双登录互踢**：ORS 退出要 ~70s；`stop_all` 已改为等待（默认 90s），`start_ors` 硬拒绝双启动。**不要绕过脚本手工 `pkill` 后立刻起新实例。**（`build_deploy_cpp.sh:337-361,706-737`）
2. **`--clean` 删运行时数据**：`rm -rf deploy_cpp` 会连 `log.bak/`、`money_bak/`、`live/position.csv` 一起删。只有 `data_cpp` 有副本的能恢复（`build_deploy_cpp.sh:173-176`）。
3. **配置改了不生效**：全量构建的 `cp -Rn` 跳过已存在文件（`:777-791`）。判断方法：`diff data_cpp/bin/config/X deploy_cpp/bin/config/X`。
4. **换月旧文件残留**：`start_strategy` 的 glob 可能取到旧 control；必须全量构建触发 `prune_stale_renamed`，并人工确认 deploy 里旧文件消失（`:793-823`）。
5. **`/home/hft/tbdata` 软链缺失/指向旧仓库**：TradeBot 读不到 `fee.csv`/`contractfile` 直接 `exit(1)`；`ops_install_deps.sh:45-68` 是修复脚本。
6. **ORS 退出 core**：每次 ~180MB；`start_ors` 默认 `ulimit -c 0`。要现场才 `CORE_LIMIT=unlimited`（`:338-345`）。
7. **`ipcrm` 误删别人的 SHM**：`start_ors`/`stop_all` 清的是**当前用户全部** SHM/队列/信号量，不是只清本系统 key（`:363,739-741`）。单机专用可接受，多租户不可。
8. **rpath 指向源码树**：移动仓库目录会导致 CTP 库找不到（§1.2）。
9. **`LD_LIBRARY_PATH` 依赖**：TradeBot 的 `libpqxx/libsnappy` 靠 `start_strategy.sh` 注入（§1.3.1）。
10. **tbadmin `lib/` 不在 git**：换机/重装后 `make` 会失败（§1.5）。
11. **`check-md`/`md-recorder` 无构建入口**：只跑构建脚本会缺（§1.7）。
12. **文档与代码漂移**：`--cpp/--go`、`start_tradebot.sh`、`stop_all.sh:28-35`、alt 端口 18080/18081（§2.8）。
13. **crontab 整份替换**：手工加的行会被清（§6.1）。
14. **ORS 日志含明文密码**：日志不能外发（§4.6）。
15. **夜盘“看起来配了但没跑”**：cron 注释 + 柜台不可用；`ops_check_md.sh start` 仍在 21:01 启动（`:111`），属于残留（**I**，可能产生无意义告警）。

---

## 8. 主机拓扑

### 8.1 生产主机（190）

| 项 | 值 | 证据 |
|---|---|---|
| 地址 | `root@101.43.54.190` | `ops/crontab.txt:4`；`docs/INTEGRATION_TEST_TBSRC_TBADMIN.md:18` |
| 系统 | Rocky Linux 9.4 / 9.8（两处文档不一致），x86_64 | `docs/GETTING_STARTED.md:37`；`:130` |
| 编译器 | 系统 GCC 11.5，**无 devtoolset** | `docs/GETTING_STARTED.md:130` |
| CPU | **4 核**（策略占 0/2/3，ORS 锁 1） | `.claude/CLAUDE.md:630-632` |
| 磁盘 | 单盘 `/dev/vda1` 178G（2026-10-05：46G used / 27%） | `docs/RISK_NO_OFFSITE_BACKUP.md:22-26` |
| 网络挂载 | **无** NFS/CIFS；`/mnt` 空；内网 `172.31.x`/`10.192.x` 不可达 | 同上 `:28-38` |
| 时区 | CST（北京时间）；C++ 策略日志 UTC | `ops/crontab.txt:7`；`docs/GETTING_STARTED.md:203` |
| 校时 | chronyd（06:00 makestep） | `ops/crontab.txt:37-39` |
| 进程管理 | 无 systemd unit；cron + nohup + pid 文件 | `find . -name '*.service'` 为空 |
| 数据库 | 本机 PostgreSQL 16，`dbtrade` 库，仅监听 127.0.0.1 | `docs/RISK_NO_OFFSITE_BACKUP.md:74`；`tools/strategy_sync/README.md:9` |

### 8.2 端口与暴露面

| 端口 | 服务 | 监听 | 说明 | 证据 |
|---|---|---|---|---|
| 22 | SSH | 0.0.0.0 | 运维入口 | — |
| 5432 | PostgreSQL | 127.0.0.1 | 本机 | `tools/strategy_sync/README.md:9` |
| 8080/8081 | memlog-reader | 0.0.0.0（默认） | 190 上 8080 曾被 nginx 占用 → 用 28080/28081 | `memlog-reader.yaml:1-3`；`ops/crontab.txt` 注释；`memlog-reader.alt.yaml` |
| 8882 | Flask message_forwarding | 0.0.0.0 | Socket.IO | `start_all_with_tbadmin.sh:98-110` |
| 9980/9981 | tbadmin admin ZMQ | 127.0.0.1（cfg 默认） | PUB/SUB | `tbadmin/cfg/admin.cfg:1-2` |
| 5004 | vue3-admin 后端 | 0.0.0.0 | Flask | `start_tbadmin.sh:47-52` |
| 50003 | nginx 管理前端 | 0.0.0.0 | 静态站 | `ops/nginx/quantlink-admin.conf:1-3` |
| 出站 CTP | 交易/行情前置 | — | 评测前置端口 34205/34213（地址见配置/文档，本文不复制） | `.claude/CLAUDE.md:643-660` |

> 防火墙：`start_all_with_frontend.sh` 会 `firewall-cmd --add-port=8080/8081/8882`（`:38-43`）；50003/5004 的放行状态**未验证**（**I**）。

### 8.3 拓扑图（逻辑）

```text
                 Internet / 期货公司
                        │ CTP (tcp)
                        ▼
┌──────────────────────── 190 (单台, 4C/178G) ────────────────────────┐
│                                                                     │
│  ors_server ──SHM 4097/8193/12289/16385──► TradeBot × N             │
│      │                                        │                     │
│      │ CTP flow                               │ SHM 789             │
│      ▼                                        ▼                     │
│  ctp_flow/                              memlog-reader :8080/8081    │
│                                               ▲                     │
│  tbadmin agent (AgentLoop) ──ZMQ 9980/9981──► tbadmin admin         │
│                                               │ (AdminLoop)         │
│                                               ▼                     │
│                                     message_forwarding :8882        │
│                                     vue3-admin backend :5004        │
│                                     nginx :50003                     │
│                                                                     │
│  PostgreSQL 16 (127.0.0.1:5432, dbtrade) ◄── tbadmin / ops 脚本     │
│  /home/hft/tbdata ──symlink──► /root/quantlink-trading/data_cpp/data│
│  /home/u50_data ◄── md-recorder                                     │
└─────────────────────────────────────────────────────────────────────┘
                        │ GitHub (代码/配置)
                        │ 阿里云 RDS appdb (策略表, 仅 190 可达)
```

### 8.4 网络假设（复刻必须满足）

1. 主机能出站访问 **CTP 前置**（评测/生产不同地址；生产地址仓库内无记录）。
2. 能出站访问 **GitHub**（`ops_sync_git.sh` 每日 push；`ops_refresh_fee.sh` 也 push）。
3. 能访问 **阿里云 RDS**（strategy_sync；只有 190 同时能访问 RDS 与本机 PG，`tools/strategy_sync/README.md:9`）。
4. 时间同步可用（chrony；交易时段判断和日志对齐都依赖）。
5. 无内网共享盘可用（`/mnt/hft` 已不存在）；不要在设计里假设它（`docs/RISK_NO_OFFSITE_BACKUP.md:31-38`）。

### 8.5 未验证/待确认（主机层）

- 190 是否仍是当前生产机、`deploy_cpp` 是否与 `5cee3dd` 一致（**未验证**）。
- 生产 CTP 前置地址/BrokerID/账号（不在仓库；**不记录**）。
- 防火墙实际开放端口（只看到脚本意愿）。
- 当前 crontab 是否与 `ops/crontab.txt` 完全一致（文件说“整份替换”，但现场可能被手改）。
- 夜盘是否会重新启用（2026-11-04 停用；代码仍支持）。
- 磁盘/内存当前余量、是否有 swap（RISK 文档只有 2026-10-05 快照）。

---

## 9. 复刻要点

### 9.1 最小可运行集

| 类别 | 必需项 | 说明 |
|---|---|---|
| 主机 | 1 台 Linux x86_64，≥4C/8G/100G，Rocky/EL9 或同等 | 单机即可；多机需要改 `tbadmin` 的 PUB/SUB 地址与共享路径 |
| 工具链 | gcc≥11、cmake≥3.16、make、go≥1.21、python3+psycopg2、psql | `docs/GETTING_STARTED.md:35-40` |
| 代码 | `quantlink-trading` 仓库（含 CTP SDK、hftbase 预编译库） | CTP 二进制已入库 |
| CTP | 一个可用账号 + 前置地址（评测或生产） | 写进 `data_cpp/bin/config/ors_server.cfg` |
| 数据库 | PostgreSQL 16，库 `dbtrade`，用户可读写 `tbhft_*` | tbadmin 与 ops 脚本依赖 |
| 配置 | `data_cpp/bin/{config,controls,models,live}` + `data_cpp/data/*` | 已在 git |
| 密钥 | `ors_server.cfg`、`ops/db.conf`、`feishu.secret.yaml`（可选）、`strategy_sync.env`（可选） | 见 §4.1 |
| 数据目录 | `/home/hft/tbdata` 软链、`/home/u50_data` | `ops_install_deps.sh` |
| 调度 | `crontab ops/crontab.txt` | 整份替换 |
| Dashboard | `memlog-reader`（构建脚本产出） | 8080/8081 |
| 可选监控 | `tbadmin`（需 `tbadmin/lib/*.so`）、Flask、nginx | 不影响交易主链 |

**最小“能下单”的子集：** `ors_server` + 1 个 `TradeBot` + `ors_server.cfg` + `config_CHINA.<SID>.cfg` + `control/model` + `daily_init` + `/home/hft/tbdata/{fee.csv,contractfile}` + 手动 `SIGUSR1` 激活。Dashboard/tbadmin/cron 都可以后补。（**I**，由代码依赖推出）

### 9.2 外部服务清单

| 服务 | 必需 | 用途 | 失败影响 |
|---|---|---|---|
| CTP 柜台 | ✅ | 行情/交易 | 无法交易 |
| PostgreSQL | ✅（tbadmin/ops） | 策略表、合约表、控制表 | 监控/喂数失败；交易主链可继续（TradeBot 不读 DB） |
| GitHub | ⚠️ | 发布/每日数据 commit | 不能发版；数据仍在本机 |
| 阿里云 RDS | ⚠️ | 策略表上游 | 策略库不更新 |
| 企微 webhook | ❌ | 告警 | 只写日志（所有脚本有空值守卫） |
| 飞书 | ❌ | Dashboard 告警 | 无 |
| nginx | ❌ | 管理前端 | 只影响页面 |

### 9.3 验收检查（按顺序执行）

```bash
# 1) 构建产物
ls -l /root/quantlink-trading/deploy_cpp/bin/{ors_server,TradeBot,memlog-reader}
ldd /root/quantlink-trading/deploy_cpp/bin/TradeBot | grep -i "not found" && echo FAIL

# 2) 数据软链
ls -l /home/hft/tbdata/{fee.csv,contractfile,RolloverOverrideFile}

# 3) 密钥文件（只看存在与权限，不打印内容）
test -f data_cpp/bin/config/ors_server.cfg && echo OK
stat -c '%a %n' data_cpp/bin/config/ors_server.cfg ops/db.conf

# 4) 起会话（非交易日用 sim 或手工单启）
./scripts/ops_start_session.sh day
tail -50 deploy_cpp/bin/log/cron_start_day.log

# 5) 进程/SHM
pgrep -x ors_server; pgrep -x TradeBot; pgrep -x memlog-reader
ipcs -m | egrep '0x00001001|0x00002001|0x00003001|0x00000315'

# 6) ORS 登录
grep -E "Trader login done|OnFrontConnected" deploy_cpp/bin/log/ors_server.$(date +%Y%m%d).log

# 7) 行情活性（15s 窗口）
cd deploy_cpp/bin && ./check-md -probe -probe-wait 15s -config ./config/check-md.yaml; echo rc=$?

# 8) 策略激活
./scripts/ops_tb_signal.sh 92221 activate
grep "Strategy is active now" deploy_cpp/bin/log/log.control.*.$(date +%Y%m%d)

# 9) Dashboard
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/strategies

# 10) 停会话 + 数据回灌
./scripts/ops_stop_session.sh day
tail -20 deploy_cpp/bin/log/cron_stop_day.log
git -C /root/quantlink-trading status --porcelain -- data_cpp
```

**通过标准：** 1-3 全 OK；4 后 `ors_server` 在 90s 内登录；5 的四个 SHM 存在；7 返回 0；8 日志出现激活；9 返回 200；10 后无残留进程、`data_cpp` 出现当日 `daily_init`/`position.csv` 变更。

### 9.4 建议自动化/改进（按收益排序）

1. **版本化发布**：`releases/<git-sha>/{bin,lib}` + `current` 软链；保留最近 3 版；发布前记录 SHA 与校验和。现在回滚只能重编（§7.4）。
2. **二进制备份**：`build_deploy_cpp.sh` 在覆盖前 `cp -a` 旧 `ors_server/TradeBot` 到 `releases/prev/`。成本极低，收益极大。
3. **把 `check-md`/`md-recorder` 纳入构建**：现在漏构建会静默失去看门狗/录制（§1.7）。
4. **启动后等登录**：`start_ors.sh` 的 `sleep 3` 改为轮询日志 `Trader login done`（超时告警），把 D18 类故障前置到启动阶段。
5. **精确清 SHM**：只删本系统已知 key（4097/8193/12289/16385/789），不要 `ipcrm` 全用户（§7.6-7）。
6. **配置同步显式化**：把 `cp -Rn` 换成“清单 + `rsync --checksum`”，或构建时打印 `diff` 摘要，避免“改了没生效”。
7. **`--clean` 拆分**：`--clean-bin`（只删二进制/脚本）与 `--clean-all`（当前语义），并要求确认。
8. **systemd/supervisor 化**：cron 只负责**会话时点**，进程存活交给 systemd（`Restart=on-failure`），可去掉 `ops_ensure_tbadmin.sh`/`ops_watchdog_memlog.sh` 这类轮询。
9. **配置校验器**：启动前校验 SHM 大小、CPU 亲和唯一、control/model 配对、`_F_` 合约解析、`fee.csv` 覆盖（把 `ops_setup_arbi.sh` 的校验变成强制门禁）。
10. **密钥治理**：`ors_server.cfg`/`ops/db.conf` 统一 600 + 单独目录；去掉 ORS 明文打印密码；`tbadmin` 的硬编码 DSN 改为环境变量（`tbadmin/admin.cpp:583`，弱口令）。
11. **`tbadmin/lib` 可重建**：把 `libyd`/`libpqhelper` 的来源、版本、构建方式写进仓库，否则无法复刻 tbadmin。
12. **CI**：在 Linux 容器里跑 `build_deploy_cpp.sh` + `--config-only` 冒烟，提前发现 macOS 无法暴露的问题。
13. **夜盘开关显式化**：`ops_night_session.py status` 纳入发布检查，避免“cron 注释了但没人知道”。
14. **恢复 `ops_setup_arbi.sh`**（或把时段重算并入启动路径），否则 `session_rules.csv` 改了不生效（§6.4）。

---

## 10. 证据索引（V/I/P）

| # | 结论 | 证据 | 级别 |
|---|---|---|---|
| 1 | 无 systemd/包管理，cron+nohup 部署 | `find . -name '*.service'` 为空；`ops/crontab.txt:1-33` | V |
| 2 | 190 单机、4 核、单盘 178G、无异地备份 | `docs/RISK_NO_OFFSITE_BACKUP.md:20-40`；`.claude/CLAUDE.md:630` | V |
| 3 | 构建脚本 6 个参数；`--mode` 无效果 | `scripts/build_deploy_cpp.sh:75-105,110` | V |
| 4 | ORS 用 CMake/C++17/`_USE_CTP_` | `ors/CMakeLists.txt:1-13` | V |
| 5 | ORS 只编 6 个 hftbase 源文件，排除 `rmsimpl.cpp` | `ors/CMakeLists.txt:28-40` | V |
| 6 | ORS/fee_refresh 的 CTP rpath 指向源码树 | `ors/CMakeLists.txt:83-100` | V |
| 7 | TradeBot CMake 链 `hftbase/libs` 预编译库 | `tbsrc/CMakeLists.txt:39,103` | V |
| 8 | `libs/*.so` 是 Linux ELF ⇒ macOS 不可链接 | `file tbsrc/hftbase/libs/libpqxx.so` | V |
| 9 | TradeBot 遗留 Make 输出 `tbsrc_bin/`，生产不用 | `tbsrc/main/Makefile:37,97,106` | V |
| 10 | hftbase 用 SCons，输出 `../bin` 不是 `libs/` | `tbsrc/hftbase/Makefile:1-17`；`SConstruct:68-69` | V |
| 11 | tbadmin Make 依赖 `./lib` 的 `-lyd -lpqhelper -lmemlog` | `tbadmin/Makefile:25,28` | V |
| 12 | `tbadmin/lib` 不在 git，需 scp | `docs/INTEGRATION_TEST_TBSRC_TBADMIN.md:431`；`ls tbadmin` | V |
| 13 | 构建脚本生成 4 个启停脚本并每次覆盖 | `scripts/build_deploy_cpp.sh:293-760` | V |
| 14 | 配置同步 `cp -Rn` 不覆盖；`trading_days.txt` 例外 | `scripts/build_deploy_cpp.sh:777-839` | V |
| 15 | 改名残留清理逻辑 | `scripts/build_deploy_cpp.sh:793-823` | V |
| 16 | `--config-only` 覆盖 config/controls/models，不动 data/live | `scripts/build_deploy_cpp.sh:148-169` | V |
| 17 | `--clean` 删整个 deploy_cpp | `scripts/build_deploy_cpp.sh:173-176` | V |
| 18 | `start_ors` 双启动防护 + core=0 + 全量 ipcrm | `scripts/build_deploy_cpp.sh:337-363` | V |
| 19 | `stop_all` 等 ORS 90s 再清 SHM | `scripts/build_deploy_cpp.sh:706-741` | V |
| 20 | `start_strategy` 命令行与 `--updateInterval 7200` | `scripts/build_deploy_cpp.sh:496-526` | V |
| 21 | TradeBot 信号语义 | `tbsrc/main/main.cpp:108-176`；`ops_tb_signal.sh:17-27` | V |
| 22 | ORS 明文打印密码 | `ors/China/src/ORSServer.cpp:420,430,443,460` | V |
| 23 | `ors_server.cfg` 不入 git，键名清单 | `.gitignore:42`；`ORSServer.cpp:102-111,403-415` | V |
| 24 | `fee.csv`/`contractfile` 走 `/home/hft/tbdata` 绝对路径 | `TradeBotUtils.cpp:2463`；`Instrument.cpp:440,1548` | V |
| 25 | 软链由 `ops_install_deps.sh` 建立 | `scripts/ops_install_deps.sh:45-68` | V |
| 26 | daily_init 走 `../data`，position.csv 走 `./live/data` | `PairwiseArbCSOStrategy.cpp:24`；`ORSServer.cpp:111` | V |
| 27 | 日历门控 fail-closed，三重 | `is_trading_day.sh:13,36-54`；`ops_start_session.sh:30-47`；`build_deploy_cpp.sh:549-577` | V |
| 28 | 日盘 08:50 启 / 15:05 停 | `ops/crontab.txt:43,47` | V |
| 29 | 夜盘整套注释停用（2026-11-04） | `ops/crontab.txt:49-50,923-939` | V |
| 30 | `ops_setup_arbi.sh` 当前不调度 | `ops/crontab.txt:925`（注释）；`:45-158` | V |
| 31 | fee 刷新 15:40 的三重时刻约束 | `ops/crontab.txt:74-88` | V |
| 32 | crontab 整份替换，手改会被清 | `ops/crontab.txt:27-31` | V |
| 33 | 夜盘柜台 6 周 0 连接 | `.claude/CLAUDE.md:643-660`；`ops/crontab.txt:49` | V |
| 34 | 健康检查 9 项；tbadmin comm 是 AdminLoop/AgentLoop | `ops_check_status.sh:1-30,155-167` | V |
| 35 | 日终快照必须在 stop_all 之前 | `ops_stop_session.sh:33-38`；`ops_eod_report.sh:8-11` | V |
| 36 | 数据回灌 mtime 双向规则 | `sync_data_back.sh:16-45` | V |
| 37 | 每日提交 daily_init + position.csv | `ops_sync_git.sh:25-35` | V |
| 38 | fee.csv 每次全量、不可重复行 | `ors/tools/fee_refresh/fee_refresh.cpp:15-32` | V |
| 39 | `check-md`/`md-recorder` 无构建入口 | `ops_check_md.sh:31`；`ops_start_md_recorder.sh:16`；`build_deploy_cpp.sh:846-886` | V |
| 40 | 文档 `--cpp/--go`、`start_tradebot.sh` 与代码不符 | `.claude/CLAUDE.md:258-266,290` vs `build_deploy_cpp.sh:75-105` | V |
| 41 | ORS 登录失败退避重试（最多 3 次，3s/6s/12s） | `ors/China/src/ORSServer.cpp:2052-2085`（`OnLoginFailure`） | V |
| 42 | 190 上 8080 被 nginx 占用 → 28080/28081 | `ops/crontab.txt` 注释；`memlog-reader.alt.yaml:1-15` | V（配置）/ I（现场） |
| 43 | 生产前置地址与账号 | 不在仓库（`ors_server.cfg` gitignored） | 未验证 |
| 44 | 现场 crontab 与文件一致 | 无现场证据 | 未验证 |
| 45 | `tbadmin/lib` 的具体版本/来源 | 仓库无记录 | 未验证 |

---

## 11. 未决问题（交给下一份文档/现场确认）

1. **现场一致性**：190 的 `deploy_cpp` 是否由 `5cee3dd` 构建？当前 crontab 是否等于 `ops/crontab.txt`？
2. **生产 CTP 前置**：实盘地址/端口/BrokerID/账号是什么？与评测前置如何切换？`PRODUCTION_MODE` 现场取值？
3. **tbadmin 依赖**：`libyd`、`libpqhelper`、`libmemlog` 的来源、版本、ABI、许可？没有它们 tbadmin 无法复刻。
4. **夜盘**：是永久停用还是等柜台？若恢复，`ops_night_session.py enable` 后哪些校验必须先做（并发登录、CPU 亲和、`ops_setup_arbi`）？
5. **`--mode sim|live`**：是遗留死参数还是计划中？当前 `sim` 模式实际只启动策略（ORS 不启动），是否会误用？
6. **`ops_setup_arbi.sh`**：是否应恢复日盘调度？若不恢复，`session_rules.csv` 的维护流程是什么？
7. **`check-md`/`md-recorder`**：现场二进制由谁、何时、用哪个 commit 构建？要不要纳入 `build_deploy_cpp.sh`？
8. **`--clean` 的运维约定**：是否有人真的用它？有没有因此丢过 `log.bak`/`position.csv`？
9. **数据库备份**：`pg_dump`/PITR 是否存在（RISK 文档说没有）？属于 07 文档范围。
10. **`error.xml`**：CTP 运行时是否强依赖 `deploy_cpp/lib/ctp/error.xml`？当前只拷 `.so`。
11. **`XSIM_CONFIG_PATH`/`SANITY_CHECK_FILE`**：实盘路径是否读取？`deploy_cpp` 不部署它们是否有影响？
12. **主机余量**：4 核/178G 是否仍是现状？新增策略的 CPU 亲和如何分配？

---

### 附：一页命令卡

```bash
# 构建
cd /root/quantlink-trading
./scripts/build_deploy_cpp.sh                 # ORS + TradeBot + 配置 + Go Dashboard
./scripts/build_deploy_cpp.sh --ors           # 只 ORS
./scripts/build_deploy_cpp.sh --trader        # 只 TradeBot
./scripts/build_deploy_cpp.sh --config-only   # 只覆盖同步 config/controls/models

# 启停（核心；cwd 必须是 deploy_cpp/bin）
cd /root/quantlink-trading/deploy_cpp/bin
./scripts/start_all.sh ctp day
./scripts/stop_all.sh

# 启停（含监控；脚本自定位仓库根）
cd /root/quantlink-trading
./scripts/start_all_with_tbadmin.sh ctp day
./scripts/stop_all_with_tbadmin.sh

# 会话（cron 同款；仓库根，任意目录均可）
cd /root/quantlink-trading
./scripts/ops_start_session.sh day
./scripts/ops_stop_session.sh day

# 策略信号（仓库根）
cd /root/quantlink-trading
./scripts/ops_tb_signal.sh 92221 activate
./scripts/ops_tb_signal.sh 92221 deactivate
./scripts/ops_tb_signal.sh 92221 reload

# 诊断
ipcs -m
pgrep -x ors_server; pgrep -x TradeBot; pgrep -x memlog-reader
tail -f deploy_cpp/bin/log/ors_server.$(date +%Y%m%d).log
tail -f deploy_cpp/bin/log/log.control.*.$(date +%Y%m%d)

# 配置一致性
diff -r data_cpp/bin/config deploy_cpp/bin/config
diff -r data_cpp/bin/controls deploy_cpp/bin/controls
diff -r data_cpp/bin/models deploy_cpp/bin/models
```

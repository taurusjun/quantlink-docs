# 07 — 保存、复刻与沙箱运行 Playbook

> 目标：把 `/Volumes/DevDisk/146` 这套 2015 年原始 TradeBot + Qt 前端**安全保存**，并在不接真实柜台的前提下复现到“能启动、能看到 GUI、能读懂数据流”的程度。
> 原则：只读原盘；先保存证据，再谈运行；不要在原始盘上改文件、重命名、启动二进制。
> 证据约定：V/I/P 见 `README.md`。

## 1. 先保存什么（按价值排序）

| 优先级 | 资产 | 路径 | 理由 |
|---|---|---|---|
| P0 | TradeBot 源码 | `3/TradeBot/TradeBot_China` | SVN r2375，唯一可读的策略/订单/风控源码 |
| P0 | Qt5 GUI 源码 | `3/dalong/FromDaya/SkylineFL_GUI` | 没有 git/svn，只有目录 + tarball，最容易丢 |
| P0 | 共享 infra 源码 | `3/dalong/infrastructure` | DataService/Connector/Ipc/Logger/GUI 控件；git 仓库 |
| P0 | 运行配置/控制/模型 | `3/TradeBot/TradeBot_China/{Config,controls,models,data,livescripts}` | 策略实际输入；含 2,006 controls / 1,958 models |
| P1 | Qt4 GUI 运行态 | `3/infra/TradingSystemsGUI` | 线上实际 GUI；二进制 + 配置 + 日志 |
| P1 | Qt5 部署目录 | `3/GUI/SH` | 部署态 Qt5 GUI + libs + 配置 + 日志 |
| P1 | ORS/MD 源码与构建 | `2/bld/build_dev_multi.20150330_1447/{China,MDReceiverX}` | 历史真实启动入口 |
| P1 | 启动脚本 | `3/infra/prod/scripts`、`3/re`、`3/TradeBot/livescripts`、`3/infra/dataservice_deploy` | 还原启动顺序 |
| P2 | 日志/CSV | `3/TradeBot/TradeBot_China/log`、`3/GUI/SH/*.log`、`3/infra/TradingSystemsGUI/*.log`、`3/re/log` | 行为取证/时间线 |
| P2 | OS/环境 | `2/` 根盘（CentOS 6.6、Qt5.3.2、/bld、/include） | 复现老 ABI/依赖 |

> 不要先保存 `3/leon/log` 的 39GB；它是最大项，先确认是否含唯一证据。不要复制整个 58GB 盘到工作区。

## 2. 原始盘的只读保护

建议（不在本次执行范围内）：

```bash
# 1) 原盘/镜像校验
shasum -a 256 /Volumes/DevDisk/146/...   # 至少对关键目录做 manifest

# 2) 只读挂载/只读副本；不要在 /Volumes/DevDisk/146 上写
# 3) 用 rsync --dry-run 先看范围，再复制到独立 preservation 盘
# 4) 保存 .svn/.git 元数据、tar.gz、BuildID、mtime
```

本次调查只读，没有改动任何文件。

## 3. 版本/资产判定（先看 00）

- **权威 TradeBot 源码**：`3/TradeBot/TradeBot_China`，SVN `svn+ssh://TradeBot@10.30.49.7/TradeBotRepository/TradeBot_Multi`，r2375（2015-06-10，avijit）。
- `2/TradeBot/TradeBot_China` 与 `3/` 同名树基本逐字节相同；`2/` 更像运行根盘副本。
- `TradeBot.bak` / `tempTradeBot` 是更早备份（r1936/r2023），不是权威。
- **线上 GUI**：`3/infra/TradingSystemsGUI`（Qt4，2014-09-26）。
- **Qt5 GUI 源码**：`3/dalong/FromDaya/SkylineFL_GUI`（2014-11-20），归档中未见部署；`3/GUI/SH` 是 2014-12-21 的 Qt5 部署态，和源码树 2015-03-19 构建不同。
- **源码 ≠ 线上二进制**：TradeBot 二进制 6/17 晚于源码 r2375 6/10；不要假设源码能解释线上全部行为。

## 4. 最小沙箱复现（不接真实柜台）

### 4.1 目录映射

历史方式是把 `3/` 下目录铺到 `/home`：

```text
/home/GUI
/home/infra
/home/leon
/home/re
/home/TradeBot
/usr/share/API
```

同时需要 `2/` 里的构建/依赖：

```text
/bld
/include
/usr/local/lib/libsnappy.a
/opt/Qt5.3.2 或 /home/dalong/Qt5.3.1
```

> 不要在原盘上做这些复制；在独立沙箱/容器/VM 中做。路径是脚本硬编码的，`/home` 布局不是可选。

### 4.2 依赖检查

- g++ 4.4.x / CentOS 6.6 ABI；老 `libstdc++`；`libsnappy`；`libzmq`；Qt4/Qt5；`pthread`；`rt`。
- ORS/SH M keys：`3872/727272/4872/872`（脚本 `ipcrm`），以及策略/行情相关 key。
- DataService：`configService.xml` 或 `configStream_CTP.xml`。
- GUI：`libQt*.so`、`libzmq.so`、`LD_LIBRARY_PATH`；Qt4 GUI 需要 Qt4 SONAME 链接。

### 4.3 启动顺序（历史）

```text
1) /home/infra/prod/scripts/runORS_extreme_new.sh
2) /home/re/receive.sh
   - 归档 receive_new.sh 不能启动；把 receive.shBak 改成 receive.sh
   - 二进制：mdreceiverX 或 mdreceiverX_bothfeeds
3) /home/TradeBot/livescripts/RunStrategies.sh
4) /home/infra/dataservice_deploy/runDataService.sh
   或 runDataStream_CTP.sh
5) /home/infra/TradingSystemsGUI/TradingSystemsGUI
```

依赖：

- ORS、行情接收必须在 TradeBot 之前；否则 ClientStore/SHM attach 失败，进程可能 terminate。
- DataService 在 GUI 之前；GUI 需要它拉行情/持仓/订单/PNL。
- GUI 可早于策略，但会显示空/断线。

### 4.4 安全沙箱建议

- **不要接真实柜台**：`runORS_extreme_new.sh` 会连生产网关/柜台；用 stub/模拟网关或在隔离网络里跑。
- **不要直接 `kill -9` 原盘进程**；在沙箱里用 `SIGTSTP`/自写 stop 脚本。
- **不要启动真实 `reqPos`/持仓查询**；会碰真实账户。
- 先验证：SHM attach、DataService TCP、ZMQ 端口、GUI 启动；再验证策略。
- 用 `--Sim`/历史回放（如果可用）代替 Live；`TradeBot` 的 Live 默认 `m_Active=false`，需要 SIGUSR1 激活。

## 5. 构建复现

### 5.1 TradeBot

- Linux：`3/TradeBot/TradeBot_China/Makefile` + `main/Makefile`，依赖 `/include/illuminati/dev_multi`、`/bld/dev_multi`、`-lconnectormwmr -llogger -lxsim -ldatamanip -lcommonutils -lxsimdataserver` 等。
- Windows：`Tradebot.sln` / `Tradebot.vcxproj`，VS2010/Win32，路径 `D:\shiva\...`；只是历史 legacy。
- 源码 r2375 与二进制 6/17 有漂移；构建结果不一定等于线上。

### 5.2 infrastructure

- `3/dalong/infrastructure`：git + SCons；`SConstruct`；debug/release 构建到 `.build_debug/.build_release` 或 `bin/`。
- GUI 控件在 `infrastructure/TradingSystemsGUI/`；Qt5 GUI `.pro` 通过 `$(HOME)/infrastructure/...` 引用。
- Qt5 SDK：`/opt/Qt5.3.2` 或 `3/dalong/Qt5.3.1`；Qt4 GUI 需要 Qt4.8.6。

### 5.3 GUI

- Qt5 源码：`3/dalong/FromDaya/SkylineFL_GUI/SkylineFL_GUI.pro`，qmake + make。
- Qt4 运行态：`3/infra/TradingSystemsGUI/TradingSystemsGUI`（二进制）+ `runGUI.sh`；运行目录缺 SONAME 链接时从 tarball 补。
- 部署态 Qt5：`3/GUI/SH` + `runChinaGui.sh`；注意 `taskset -c -p 7` 语法可疑，不要照抄。

## 6. 验收清单

### 6.1 保存验收

- [ ] TradeBot 源码、SkylineFL_GUI、infrastructure 三份源码有 checksum + tar 包。
- [ ] `.svn/entries`、`.git` 元数据、BuildID、mtime 保存。
- [ ] 关键配置/controls/models/data/livescripts 打包。
- [ ] 线上 GUI/ORS/MD 二进制与对应源码的版本差异有记录。
- [ ] 没有把明文凭据写入新文档/工单。

### 6.2 沙箱启动验收

- [ ] `/home` 布局、`/bld`、`/include`、`/usr/share/API` 就位。
- [ ] ORS/行情进程能启动（或 stub 提供 SHM/网关）。
- [ ] TradeBot 能 attach SHM，读取 control/model，进入 `inactive`。
- [ ] SIGUSR1 激活后能产生日志/订单（Sim/回放，不接真实柜台）。
- [ ] DataService 能起，GUI 能连上并显示行情/持仓/订单/PNL。
- [ ] `receive.sh` 的 `taskset` 行为被验证；`receive_new.sh` 失败原因有结论。
- [ ] 停止流程不会留下未平仓/不会破坏原盘。

## 7. 不要照抄的东西

- 无认证 ZMQ/端口即身份；GUI/策略控制面暴露所有网卡。
- root/VNC 无 localhost 限制；X11 桌面。
- `pkill -9` 停机；没有优雅平仓。
- 无订单/仓位/PnL 持久化；两本账不核对。
- 源码/二进制漂移不记录；SkylineFL_GUI 无 VCS。
- `MAX_POS_SIZE=1000000` 之类“名义上限”当真实风控。
- 硬编码 `/home/...`、`/bld/...`、`/usr/share/API` 路径。
- 把 `receive_new.sh` 的 `taskset -c -p 8` 当可用命令。
- 直接在原盘上运行/改名/清理。

## 8. 未决问题（先现场确认）

1. `receive_new.sh` 到底为什么不能启动？`taskset -c -p 8` 在标准 util-linux 不成立，但日志显示 08:55 有进程；是包装脚本/旧版 taskset/人工绕过？
2. 7/24 实际跑的是 `mdreceiverX` 还是 `mdreceiverX_bothfeeds`？cron 与 `receive.shBak` 矛盾。
3. 线上 6/17 TradeBot 二进制相对 r2375 改了哪些未提交代码？
4. SkylineFL_GUI 是否真的部署过？`3/GUI/SH` 与源码树构建是什么关系？
5. 2015 机器是否真的公网 + root VNC + ZMQ 全网卡？需要 `iptables`/`ss`/`/var/log/secure`。
6. `symbolID` 是否始终 <100（`m_simConfigList[100]` 风险）？
7. `position.csv` 与 TradeBot 账本从未对账，重启后人工流程是什么？

## 9. 结论

这套系统的价值不在“直接照搬上线”，而在于：

- 它是后来 `quantlink-trading` 的**前身/对照物**：单策略进程、SHM、ORS、策略内风控、Qt GUI。
- 它保留了早期 CME/SGIT/China 网关、Qt4/Qt5 GUI、DataService、控制/模型文件的真实形态。
- 复刻时应只取“架构与业务语义”，不要复制它的安全/运维缺陷；先保存源码和配置，再在隔离沙箱里复现启动链。

# 04 — 配置、controls、models、data、livescripts、日志与持久化

> 调查对象：`/Volumes/DevDisk/146`（只读）。
> 主范围：`3/TradeBot/TradeBot_China/{Config,controls,models,data,livescripts}`、`3/TradeBot/{controls,models,log,livescripts,bckp}`、`3/re/`、`3/GUI/SH/*.csv` 与 `*.log`、`3/infra/dataservice_deploy/*.log`。
> 证据标记：**V** = 直接读到源码/配置/脚本/日志；**I** = 由结构、时间戳、日志推断；**P** = 计划/假设/无法验证。
> 脱敏：不复制口令、密钥、Token、真实账户号、内网地址原文；只记位置、权限、风险。日志与配置中的示例均保留业务字段、隐去敏感值。
> 未运行任何二进制；仅使用 `ls`、`cat`、`grep`、`awk`、`md5`、`stat`、`strings`、`file`。

---

## 0. 一页结论

| 维度 | 数字/结论 | 证据 |
|---|---|---|
| 配置 | `Config/` 31 个 `ShmConfig*.cfg` + `StrategyConfig.cfg` + `signal.txt`；`Connector/` 24 个 `config_*.cfg`；`SimConfig/` 46 个 | V |
| 控制文件 | **2,006** 个，143 个日期（20150209–20150725），18 个策略族，扁平目录，全部 7 字段 | V |
| 模型 | **1,958** 个（比 controls 少 48 个 `eve.print`），70,021 行，平均 4.55 条指标 + 15.66 条阈值 | V |
| 重复度 | controls 归一化日期后只有 **24** 种内容；models 只有 **65** 种内容 | V |
| 数据 | `data/` 563 MB / 4,280 文件，其中 BSE 历史数据 492 MB；真正被 Live 中国链路使用的只有十几个小文件 | V |
| 脚本 | SVN 版 12 个 perl/sh（面向 `TradeBot_Multi`，已过时）；运行版 8 个（`RunStrategies*.sh` 才是实际入口） | V |
| 日志 | TradeBot 8.1 MB 目录 / 3 个运行日志（6.5 MB）；GUI **9.0 GB** / 25 个；DataService 866 MB / 296 个；CME 录制 40 MB / 79 个 | V |
| 持久化 | **无数据库**；TradeBot 的订单/仓位/PnL 全在内存；唯一落盘的仓位快照是 ORS 侧 `position.csv`（2 行） | V |
| 最大陷阱 | 控制文件的时段是 **GMT**，TradeBot 日志也是 **GMT**；GUI/DataService 日志是 **本地 CST（UTC+8）** | V/I |
| 最大缺口 | 无仓位/PnL 持久化：TradeBot 重启即空仓，cron 又直接 `pkill -9`；唯一快照是 ORS 侧 `position.csv` | V |

一句话：**这套系统是“文件即配置、进程即状态”的 2015 年单机架构。controls/models 是每日复制出来的参数模板，TradeBot 只读一次；运行参数的真实历史只保存在日志头里，控制文件本身会被事后改写。**

---

## 1. 配置层：`Config/`、`Connector/`、`SimConfig/`

### 1.1 目录与“谁读它”

| 路径 | 数量/大小 | 格式 | 读取者 | 读取点 |
|---|---|---|---|---|
| `Config/StrategyConfig.cfg` | 1 个，77 B | `KEY=VALUE` | TradeBot（每个策略实例） | `Strategies/ExecutionStrategy.cpp:64` |
| `Config/signal.txt` | 1 个，30 B | 每行一个 baseName | TradeBot 信号处理 | `main/main.cpp:98` |
| `Config/ShmConfig*.cfg` | 31 个，77–145 B | `KEY=VALUE` | **无读者** | 全树/二进制 strings 均无命中 |
| `Connector/config_*.cfg` | 24 个，约 0.5–0.7 KB | INI 风格（`[EXCHANGE]` 段） | Connector 库（`Connector::init`） | `main/main.cpp:426`、`:993-994` |
| `SimConfig/SimConfig_*.cfg` | 46 个，388 KB | `KEY=VALUE` | 仅 Sim/ParallelSim 回放 | `main/main.cpp:999` |
| `data/OptionsParams` | 1 个，44 行 | `KEY=VALUE` | 仅期权策略 `--optionStrategy` | `main/main.cpp:593`、`common/OptionManager.cpp:10` |
| `params/` | **空目录** | — | Regress 模式 `--paramFile` | `main/main.cpp:631-636` |
| `Config/sanitycheck.cfg` | **不存在** | — | 被 Connector 配置引用 | `Connector/config_CHINA_CME.cfg:9` |

> 结论：**真正决定生产行为的只有两类**——`Connector/config_CHINA_*.cfg`（连接/共享内存）与 `Config/StrategyConfig.cfg`（账户/总量上限）。其余要么是历史模板（ShmConfig、SimConfig），要么是采样文件（params、sample control/model）。**[V/I]**

**二进制 ↔ 配置对照** **[V/I]**：

| 二进制 | 读取 | 明确不读 |
|---|---|---|
| `main/TradeBot`（及改名副本 `Obama`、快照 `TradeBot_20150610`） | `--configFile`、control、model、`Config/StrategyConfig.cfg`、`Config/signal.txt`、`data/*` | `ShmConfig*.cfg`、`SimConfig/*`（LIVE 模式）、`GuiSettings.xml` |
| `main/startDataServer` | `argv[1]` 配置 + `XSIM_CONFIG_PATH` + `argv[2]` 信号文件 | `Config/` |
| `main/watchMarket` / `marketStats` | Connector 配置的 `EXCHANGES/MDSHMKEY/MDSHMSIZE` | `Config/` |
| `squareoff`（TradeBot 根目录） | `config_CHINA_squareoff_ag/au/cu` | `Config/` |
| `3/re/mdreceiverX_bothfeeds` | `cme.recv.quincy.data.cfg` | 其它 |
| `3/infra/dataservice_deploy/dataservice` | `configServiceChinaNew.xml` / `configStream*.xml` / `accesscontrol.xml` / `passwordfile.xml` | TradeBot 配置 |
| `3/infra/prod/bin/china_ors_extreme_new` | `prod.china.ors_new.cfg` | TradeBot 配置 |
| `3/GUI/SH/SkylineFL_GUI` | `GuiSettings.xml`、`Position.csv`、`QSettings` | TradeBot 配置 |

### 1.2 `Config/StrategyConfig.cfg`：全局风险与账户

原文（4 行）**[V]**：

```
ACCOUNT=OWN
MAX_POS_SIZE=1000000
MAX_ORDERS=450
LOGGER_THREAD_CPU_AFFINITY=0
```

解析与生效 **[V]**：

- `ConfigfileTB` 只做 `KEY=VALUE`，无段（section），`#`/`;` 开头跳过；找不到键返回调用方给的默认值（`common/ConfigfileReader.cpp:36-51`、`common/include/ConfigfileReader.h:34-58`）。
- `ExecutionStrategy` 构造时读取：`ACCOUNT` 默认 `<内部账户>`、`MAX_POS_SIZE` 默认 10,000,000、`MAX_ORDERS` 默认 5,000,000,000（`Strategies/ExecutionStrategy.cpp:63-69`）。
- `m_maxTradedQty = m_maxPosSize`（SFE 的 `m_sendInLots=true`，不再乘 lotSize）→ **1,000,000 手**；GOLD 每手 1,000 g，等于 10 亿克（1,000 吨）名义量。**[V]**（`Strategies/ExecutionStrategy.cpp:68`、`common/Instrument.cpp:1482-1483`）
- 因此**真正的每策略闸门是 `MAX_ORDERS=450` 和模型里的 `MAX_LOSS`**，不是持仓上限。**[V/I]**

版本漂移（同一文件三代）**[V]**：

| 代 | `MAX_ORDERS` | md5 |
|---|---|---|
| `3/TradeBot.bak/TradeBot_Multi`（r1936） | 50,000,000 | `3bdc9f88…` |
| `3/tempTradeBot/...`（r2023） | 400 | `c1e224d0…` |
| `3/TradeBot/TradeBot_China`（r2375，运行） | **450** | `e91d83ac…` |

### 1.3 `Config/signal.txt`：停机平仓的“符号白名单”

内容 **[V]**：

```
NIFTY_O_C_0_11
NIFTY_O_C_0_12
```

消费逻辑在 `main/main.cpp:90-160` **[V]**：

- 收到 `SIGTERM`、`SIGRTMIN(34)`、`36` 时，先读 `../Config/signal.txt`，逐行放入 `SymbolList`。
- 只有 `m_instru->m_origbaseName` 在列表里，才对该策略执行“平仓/恢复/激进平仓”。
- 当前文件是 **NIFTY 期权**，与 SFE 的 `GOLD_F_0_SFE` 完全不匹配；若有人直接 `kill -TERM <pid>` 而不先写文件，**不会平仓**。正常脚本会先 `echo $dep > signal.txt` 再发信号（见 §5），所以生产上“能用”，但这是一个只靠脚本兜底的隐式契约。**[V/I]**

三代源码树中的 `signal.txt` **完全相同**（`TradeBot.bak`、`tempTradeBot`、`TradeBot_China`）→ 说明它从 Multi 时代起就没被清理过。**[V]**

### 1.4 `Config/ShmConfig*.cfg`：31 个“孤儿配置”

格式（以 `ShmConfig.cfg` 为例）**[V]**：

```
CLIENTSTOREKEY=930000
MD=900000,200000,55555,200000
ORS_REQUEST=910000,100000
ORS_RESPONSE=920000,100000
```

语义（按字段名）**[I]**：`MD` 是“共享内存 key, 大小”对；`ORS_REQUEST`/`ORS_RESPONSE` 是下单请求/响应队列；`CLIENTSTOREKEY` 是客户端订单存储。

关键发现 **[V]**：

- `Config/` 下共 **31** 个 `ShmConfig*.cfg`（BSE、CME_CURR、CME_INDEX、CME_TRS、CURR、FORTS、KRX、LME、MCX、NSEFO、PLAZA、PUMA 等）。
- `grep -rn "ShmConfig"` 在 `TradeBot_China` 源码里 **零命中**；对 `main/TradeBot`、`squareoff`、`china_ors_ctp`、`china_ors_extreme_new`、`dataservice`、`mdreceiverX_bothfeeds` 做 `strings | grep CLIENTSTOREKEY` 也 **零命中**。
- 实际生效的是 `Connector/config_*.cfg` 里的 `MDSHMKEY/ORSREQUESTSHMKEY/ORSRESPONSESHMKEY/CLIENTSTORESHMKEY`（§1.5）。
- 因此这 31 个文件是**旧 Connector 约定的遗留模板**，在本快照中不参与运行；保留价值仅在于历史对照。**[V/I]**

### 1.5 `Connector/config_*.cfg`：生产真正用的配置

`config_CHINA_CME.cfg`（GOLD/SILVER 使用）**[V]**：

```ini
LOGGER_THREAD_CPU_AFFINITY = 0
INTERACTION_MODE = LIVE

TICKERS = BANKNIFTY… ,NIFTY… ,UNIONBANK… ,
TICKERS_10LEN =

DATA_FORMAT_ENGINE = TBTMode
XSIM_CONFIG_PATH = ../SimConfig/SimConfig_CHINA.cfg
SANITY_CHECK_FILE = ../Config/sanitycheck.cfg

EXCHANGES=CHINA_SHFE

[CHINA_SHFE]
CLIENTSTORESHMKEY  = 727272
ORSREQUESTSHMKEY   = 3872
ORSREQUESTSHMSIZE  = 100000
ORSRESPONSESHMKEY  = 4872
ORSRESPONSESHMSIZE = 100000
MDSHMKEY           = 872,10201
MDSHMSIZE          = 100000,1000
```

要点 **[V/I]**：

- `TICKERS` 里的 NIFTY/BANKNIFTY 是**印度遗留**；TradeBot 在启动时用模型里出现的所有 instrument 覆盖 `TICKERS/TICKERS_10LEN`（`main/main.cpp:860-958`），所以这行不影响中国链路。**[V]**
- `EXCHANGES=CHINA_SHFE` 只决定 ORS 侧交易所；行情侧由 `MDSHMKEY` 列表决定：`872`（中国 SHFE，100k）+ `10201`（CME，1k）。
- `SANITY_CHECK_FILE` 指向 **不存在的** `Config/sanitycheck.cfg`；只在 `INTERACTION_MODE=SANITYCHECK` 时打开，LIVE 不受影响，但属于悬空引用。**[V]**
- `CLIENTSTORESHMKEY=727272` 与 ORS/DataService 的客户端订单存储一致；`config_CHINA_LME.cfg` 改成 `737373`、`ORS*HMSIZE=10000`、`MDSHMKEY=58735,10201,10202`（多一个 LME 行情 key），COPPER 策略用这份。**[V]**
- 24 份 `config_*.cfg` 覆盖 Brazil/CME/BSE/KRX/MCX/NSE/OSE/SGX 等；**只有 `config_CHINA_CME.cfg` 与 `config_CHINA_LME.cfg` 在中国生产被 `RunStrategies*.sh` 使用**。**[V]**

共享内存的上下游对齐 **[V]**：

| 队列 | Connector 配置 | DataService 配置 | ORS 配置 | 生产者 |
|---|---|---|---|---|
| 中国 MD | `MDSHMKEY=872` | `configStream_CTP.xml:16` `Key=872` | — | **未归档**（CTP/SHFE MD 网关或 `mdpublisherX`；`3/re` 只产 10201） |
| CME MD | `MDSHMKEY=10201` | `configStream.xml:15` `Key=10201` | — | `3/re` 接收进程 |
| ORS 请求 | `3872` | `configStream_CTP.xml:23` | `prod.china.ors_new.cfg:32` | TradeBot/Connector |
| ORS 响应 | `4872` | `configStream_CTP.xml:30` | `prod.china.ors_new.cfg:34` | ORS |
| Client store | `727272` | `ClientStoreKey 727272` | `ipcrm -M 727272` | ORS/Connector |

`3/re/cme.recv.quincy.data.cfg:18-22` 的 `Host=<内网IP>`、`Port=12345`、`ShmKey=10201`、`ShmSize=1000` 与上表一致；日志里实际连的 Host 与配置文件不同（见 §4.9 漂移）。**[V]**

### 1.6 `SimConfig/`、`params/`、`OptionsParams`

- `SimConfig/` 46 个 `*.cfg`，例如 `SimConfig_CHINA.cfg`：`MDDUMP=/home/Dumps3/ProcessedData`、`CHINA_MDDUMP=/home/Dumps2/ProcessedData`、`EXCHID=CHINA, CME_360_ON_CHINA`、`DATA_FORMAT=CHINA:BinDeltaWithSnappy`、`DATES=20130510`。只在 `INTERACTION_MODE=SIMULATION/PARALLELSIM` 时由 `cfg.LoadCfg(XSIM_CONFIG_PATH)` 加载（`main/main.cpp:997-1000`）。**[V]**
- `params/`、`tholds/`、`trade/` 都是**空目录**；`--paramFile` 的样例不在归档里。**[V]**
- `data/OptionsParams` 是期权做市参数：`WIDE_MODE/SAFE_MODE/IOC_MODE/START_DELAY/MAX_DELTA_ADJ/.../ORDER=NIFTY_F_0,NIFTY_O_C_1_09,...`。只有 `--optionStrategy 1|2` 才读（`main/main.cpp:563-593`），中国 SFE 生产未启用。**[V]**

### 1.7 解析器行为与失败模式

`ConfigfileTB`（`common/ConfigfileReader.cpp`）**[V]**：

- 文件打不开 → `exit(1)`；所以缺少 `Config/StrategyConfig.cfg` 时 TradeBot **直接退出**。
- 没有 `=` 的行：`posEqual = npos`，`substr(0,npos)` 得到整行，`substr(npos+1)` 因无符号回绕得到整行 → name 和 value 都变成整行；不会报错。
- `[SECTION]` 不会被识别为段，只会变成 key=`[SECTION]`、value=`[SECTION]` 的普通条目；`StrategyConfig.cfg`/`OptionsParams` 都是平文件，所以没影响。
- 值不做类型校验：`atoi/atof` 失败即 0。

`Configfile`（Connector 用）支持 `[EXCHANGE]` 段与 `getStringListStrict`；`watchMarket.cpp:271` 从 `MDSHMKEY` 读列表，若 key/size 数量不一致会断言（strings 里有 `MDSHMKEYLIST.size() == MDSHMSIZELIST.size()`）。**[V]**

---

## 2. `controls/`：命名、格式、策略 ID、腿、时段、2,006 个文件

### 2.1 两套 controls：源码样例 vs 运行目录

| 位置 | 数量 | 性质 |
|---|---|---|
| `3/TradeBot/TradeBot_China/controls/` | **5** | SVN 样例（`nifty_samplecontrol1/2`、`nifty_modifysamplecontrol`、`nifty_newstrategysamplecontrol`、`control.squareoff.list`） |
| `3/TradeBot/controls/` | **2,006** | **生产运行目录**，20150209–20150725 |
| `3/TradeBot.bak/.../controls` | 29 | 2 月历史切片 |
| `3/tempTradeBot/.../controls` | 47 | 2 月历史切片 |

生产目录是**扁平的**：没有子目录、没有符号链接、没有非 `control.*` 文件、没有 0 字节文件。**[V]**

### 2.2 命名约定

```
control.<BASE>.<session>[.<variant>].<YYYYMMDD>
```

- `<BASE>`：基础合约/策略族，例如 `GOLD_F_0_SFE`、`SILVER_F_0_SFE`、`COPPER_F_0_SFE`。
- `<session>`：`morn` / `noon` / `eve` / `gold` / `ltp` / `print` / `nomkt` 等，**只是标签**，不代表真实交易所时段（§2.5）。
- `<variant>`：可选的二级标签，`agg`（Aggressive）、`agp`（AggressivePassive）、`print`（打印/回归）。
- 段数：4 段（无 variant）1,176 个，5 段（有 variant）830 个。**[V]**

### 2.3 文件格式：一行 7 个空格分隔字段

示例 `control.COPPER_F_0_SFE.eve.20150302` **[V]**：

```
COPPER_F_0_SFE /home/TradeBot/models/model.COPPER_F_0_SFE.eve.20150302 SFE 16 TB_AGGRESSIVE_STRAT 1300 1830
```

| # | 字段 | 结构体成员 | 语义 | 生产取值 |
|---|---|---|---|---|
| 0 | `baseName` | `m_baseName[50]` | 依赖合约/策略族；也是 `AddInstrument` 的 key | GOLD/SILVER/COPPER + `_F_0_SFE` |
| 1 | `modelFile` | `m_modelFile[1024]` | **绝对路径** | `/home/TradeBot/models/model.<...>.<date>` |
| 2 | `exchange` | `m_exchange[50]` | 交易所代码 | `SFE` |
| 3 | `id` | `m_id[10]` | 策略 ID（告警/日志用） | **全部是 `16`** |
| 4 | `execStrat` | `m_execStrat[50]` | 策略类型字符串 | 见 §2.4 |
| 5 | `startTime` | `m_startTime[5]` | **GMT HHMM** | `0230`、`0530`、`1300` 等 |
| 6 | `endTime` | `m_endTime[5]` | **GMT HHMM** | `0330`、`0700`、`1655`、`1830` |
| 7（可选） | `secondName` | `m_secondName[50]` | 第二腿（pair） | 生产未使用 |
| 8（可选） | `thirdName` | `m_thirdName[50]` | 第三腿（arb） | 生产未使用 |

解析代码 **[V]**：

- `LoadControlFile()`：读**第一行**，`Tokenizer(..., " ")`；`TokenCount < 7` → `exit(1)`；`==8` 置 `pairStrat=true`；`>8` 置 `arbStrat=true`（`main/TradeBotUtils.cpp:1676-1722`）。
- `LoadControlList()`：逐行读列表文件，每个 token[0] 是一个 control 路径；`#` 开头跳过；`simConfig[count]` 无 20 个上限检查（`main/TradeBotUtils.cpp:1646-1674`，`MAX_SIM_CONFIG=20` 见 `main/include/TradeBotUtils.h:59`）。
- `pairStrat`/`arbStrat` 是**文件级全局变量**（`main/TradeBotUtils.cpp:215-216`），解释完一个 8 字段文件后不会复位；若 `controlList` 混排，后续 7 字段文件会被误判为 pair。生产全是 7 字段，所以未触发。**[V]**

### 2.4 实际分布（2,006 个）

策略族 × session **[V]**：

| 族 | 数量 |
|---|---|
| `GOLD_F_0_SFE.eve` | 143 |
| `GOLD_F_0_SFE.morn` | 142 |
| `SILVER_F_0_SFE.eve` | 141 |
| `GOLD_F_0_SFE.eve.nomkt` | 141 |
| `GOLD_F_0_SFE.noon` | 138 |
| `SILVER_F_0_SFE.noon` | 136 |
| `COPPER_F_0_SFE.noon` | 133 |
| `COPPER_F_0_SFE.eve` | 133 |
| `COPPER_F_0_SFE.eve.agp` | 128 |
| `SILVER_F_0_SFE.eve.agp` | 127 |
| `GOLD_F_0_SFE.eve.agp` | 124 |
| `GOLD_F_0_SFE.eve.agg` | 123 |
| `GOLD_F_0_SFE.noon.agg` | 88 |
| `SILVER_F_0_SFE.gold` | 81 |
| `COPPER_F_0_SFE.gold` | 69 |
| `SILVER_F_0_SFE.ltp` | 60 |
| `GOLD_F_0_SFE.eve.ltp` | 51 |
| `GOLD_F_0_SFE.eve.print` | 48 |

按品种汇总：GOLD 998、SILVER 545、COPPER 463，合计 2,006。**[V]**

策略类型分布 **[V]**：

| `execStrat` | 数量 |
|---|---|
| `TB_AGGRESSIVE_STRAT` | 1,172 |
| `TB_COMMS_STRAT` | 406 |
| `TB_AGGRESSIVEPASSIVE_STRAT` | 380 |
| `TB_DEP_AGGPASS_STRAT` | 41 |
| `TB_FAK_STRAT` | 6 |
| `TB_PASSIVE_STRAT` | 1 |

对应的 `main.cpp` 分支在 `main/main.cpp:702-811`；`TB_AGGRESSIVEPASSIVE_STRAT` 对应 `AggressivePassiveStrategy`，`TB_DEP_AGGPASS_STRAT` 对应 `DepAggressivePassiveStrategy`。**[V]**

### 2.5 时段：控制文件是 GMT，TradeBot 日志也是 GMT

这是本档案里最容易读错的一处。

代码证据 **[V]**：

- `Watch::GetNanoSecsFromEpoch(uint64_t t_date, uint64_t t_time)` 的注释写明 `t_time as GMT hhmm in int`（`common/Watch.cpp:46-49`）。
- 实现是 `mktime(&time_info) - timezone`（`common/Watch.cpp:59`）。在 `Asia/Shanghai` 主机上，`mktime` 先把“GMT 字段”当本地时间解释，再减 `timezone`（-28800）正好抵消，得到**正确的 UTC epoch**。
- TradeBot 启动时调用 `Logger::SetGMTimeStamp()`（`main/main.cpp:430`），logger 的 `m_bUseGMTime=true`（`3/dalong/infrastructure/Logger/include/bglogworker.h:45`）→ **日志时间戳是 GMT**。

因此：**control 的 `HHMM` 和 TradeBot 日志里的 `HHMM` 是同一套 GMT 时钟**，可直接对齐；要换成中国本地时间需 +8 小时。

| 控制时段（GMT） | 中国本地（CST） | 对应 SFE 时段 | 出现家族 |
|---|---|---|---|
| `02:30–03:30` | 10:30–11:30 | 上午盘 | `noon.agg`（26 个） |
| `05:30–07:00` | 13:30–15:00 | 下午盘 | `noon`、`morn`、`COMMS`（611） |
| `13:00–16:55` | 21:00–00:55 | 夜盘前段 | `COPPER.eve.agp`（128） |
| `13:00–17:00` | 21:00–01:00 | 夜盘 | `gold`（150） |
| `13:00–18:30` | 21:00–02:30 | 夜盘全程 | `eve`、`ltp`、`agg`、`agp`（1,043） |
| `00:00–18:30` | 08:00–02:30 | 全天 | 1 个异常文件 |

> 窗口如何生效：`CommonClient::SendINDUpdate()` 每条行情先 `Watch::UpdateTime()`，再 `m_dateConfig->UpdateActive()`（`main/CommonClient.cpp:418-422,441`）；只有 `m_simActive` 为真才调用指标/策略回调（`:452-458`）。所以 control 的 start/end 是**硬门**，不是装饰。**[V]**
>
> 验证：`log.live.control.GOLD_F_0_SFE.eve.ltp.20150617` 的窗口是 `1300 1830`，首笔 `Trade:` 在 `13:21:09`，最后 `IND` 在 `18:29:59`；换成 CST 就是 21:21–02:29，正好落在 SFE 夜盘。**[V/I]**
>
> 更硬的时区证据：该文件 mtime 是本地 `2015-06-18 02:30:00`，最后一行时间戳是 `20150617 18:29:59.51`；`noon.agg.20150630` 的 mtime 是本地 `10:40:12`，最后一行是 `02:40:12`。**TradeBot 日志 = UTC，文件 mtime = 本地 CST，固定差 8 小时。** GUI 日志则相反：mtime `2015-07-22 08:54:12`，最后一行 `20150722-08:54:12.322502` → GUI 日志 = 本地 CST。**[V]**

### 2.6 2,006 个文件是怎么来的：每日克隆 + 周末也克隆

`livescripts/CopyControlsModels`（运行目录）**[V]**：

```bash
# 1) 把 date1 的 control/model 复制到 bckp
# 2) 用 sed 把文件名里的 date1 换成 date2，生成 date2 的文件
# 3) 用 sed 把文件内容里的 date1 换成 date2
# 4) 对 RunStrategies*.sh 做同样的日期替换
```

调用入口 `livescripts/copymodels.sh` **[V]**：

```bash
sh /home/TradeBot/livescripts/CopyControlsModels `date --date="yesterday" +"%Y%m%d"` `date +"%Y%m%d"`
```

cron **[V]**（`2/var/spool/cron/root:21`）：

```
35 02 * * * cd /home/TradeBot/livescripts && ./copymodels.sh
```

注意是 `* * *`（**每天**，含周末），不是 `1-5`。这解释了：

- 2015-05-01（中国劳动节）、2015-06-20（端午）、2015-07-04/05/11/12/18/19（周末）都有 18 个 control 文件。**[V]**
- 2015-02-14/15（早期周末）为 0，说明 2 月时还不是每日 cron，后来才改成每天。**[I]**
- 文件内容只换了日期；`diff` 两个相邻交易日的 `GOLD_F_0_SFE.noon` 除了日期完全一致。**[V]**

重复度 **[V]**：

- 2,006 个 control，按 `s/[0-9]{8}/DATE/g` 归一化后只有 **24** 种内容。
- 1,958 个 model 只有 **65** 种内容（md5）。
- `bckp/` 只保留**前一天**的 18 个 control + 17 个 model + 2 个 `RunStrategies*.sh`（共 37 项，148 KB）；`CopyControlsModels` 开头连续两次 `rm /home/TradeBot/bckp/*`（`CopyControlsModels:20-21`），无 `-f`，空目录时会报错但继续。**[V]**

### 2.7 样本分析

**样本 A：`control.GOLD_F_0_SFE.noon.agg.20150630`** **[V]**

```
GOLD_F_0_SFE /home/TradeBot/models/model.GOLD_F_0_SFE.noon.agg.20150630 SFE 16 TB_AGGRESSIVE_STRAT 0230 0330
```

- 对应模型只有 3 条指标（Dependant / DynamicBeta / MT_SimpleTrend）+ 15 条阈值。
- 日志 `log.live.control.GOLD_F_0_SFE.noon.agg.20150630` 只有 525 行、32 KB，`IND` 从 `02:35:52` 到 `02:40:12` → 这是一个**只跑了约 4.5 分钟的测试/打印实例**，不是完整上午盘。**[V]**

**样本 B：`control.COPPER_F_0_SFE.eve.agp.20150310`** **[V]**

```
COPPER_F_0_SFE /home/TradeBot/models/model.COPPER_F_0_SFE.eve.agp.20150310 SFE 16 TB_AGGRESSIVEPASSIVE_STRAT 1300 1655
```

- 模型含 5 条指标，其中 3 条引用 `COPPER_F_0_CME` / `COPPER_F_0_LME`（跨交易所多腿）。
- 阈值 `CROSS -4`、`MAX_LONG_CROSS 10`、`MAX_SHORT_CROSS 10`、`UPNL_LOSS/STOP_LOSS/MAX_LOSS=1000`。
- 该族 128 天全部使用 `CROSS -4`，因此更像“有意为之的负 cross 阈值”，而不是单日笔误；但语义未在文档中说明（§3.5）。**[V/I]**

### 2.8 控制文件不是审计记录（重要）

`log.live.control.GOLD_F_0_SFE.eve.ltp.20150618` 里有 **4 次** `*****TradeBot started in Live Mode*****`（第 2、7090、7280、12278 行），全部引用**同一个** control 路径，但打印的窗口不同 **[V]**：

| 运行 | 日志行 | 打印的窗口（GMT） |
|---|---|---|
| 1 | 2 | `100 215` |
| 2 | 7090 | `100 215` |
| 3 | 7280 | `1300 1830` |
| 4 | 12278 | `1300 1830` |

而当前归档的 `control.GOLD_F_0_SFE.eve.ltp.20150618` 只有 `1300 1830`。**[V]**

结论：

- 控制文件在**盘中被人改过**（`vim control...` + `kill -SIGUSR2` 在 `.bash_history` 里多次出现）；归档的是最后一次编辑后的版本。
- **只有日志头保存了每次运行真正使用的 start/end、control/model 路径、`adjustLTP` 等参数**。要做历史复盘，必须以日志头为准，不能以 controls 目录为准。**[V]**
- 同一天多次重启会**追加**到同一个日志文件（`RunStrategies.sh:13` 用 `>>`），所以一个日志文件可能包含多个不同参数集的运行，必须先按 `TradeBot started` 分段。**[V]**

---

## 3. `models/`：参数/阈值格式、解析、关键字段、样本量

### 3.1 文件结构

一个 model 文件由三类行组成 **[V]**：

1. **指标行**（≥3 token）：
   ```
   <baseName> <instruType> <indicatorName> <coefficient> <arg1> <arg2> ... <argN>
   ```
2. **阈值行**（恰好 2 token，且不以 `#` 开头）：
   ```
   <KEY> <VALUE>
   ```
3. **注释/元数据行**（`#` 开头）：训练统计、标准差、tick size、lookahead 等。

生产样本 `model.GOLD_F_0_SFE.noon.agg.20150630` **[V]**：

```
GOLD_F_0_SFE FUTCOM Dependant 0 MID_PX2
GOLD_F_0_SFE FUTCOM DynamicBeta 20.079541 10 GOLD_F_0_CME 1 1 1
GOLD_F_0_CME FUTCOM MT_SimpleTrend 0.272934 5
#INSAMPLE_CORR  0.215066
#TRAIN_COMPLETE_CORR 0.215066
...
#DEP_STD_DEV 0.453911
#TRGT_STD_DEV 0.291325
#STD_DEV_1 0.263625
#STD_DEV_2 0.059058
#LOOKAHEAD 5
#TICKSIZE 0.05
#AVG_PX 239.382
CHECK_PNL 0
SIZE 3
MAX_SIZE 12
PERCENT_SIZE 100
BEGIN_PLACE 0.036415625
LONG_PLACE 0.050981875
SHORT_PLACE 0.021849375
CROSS 0.0
MAX_LONG_CROSS 50
MAX_SHORT_CROSS 50
SUPPORTING_ORDERS 0
UPNL_LOSS 1500.0
STOP_LOSS 1500.0
MAX_LOSS 1500.0
```

### 3.2 解析流程（`LoadModelFile`，`main/TradeBotUtils.cpp:1840-2039`）

按顺序 **[V]**：

1. 打开 `controlConfig.m_modelFile`；失败 → `exit(1)`。
2. 若 `baseName != "BASKET"`：`AddInstrument(baseName)`；若 control 有第 8/9 字段，再 `AddInstrument(second/third)` 并置 `m_bUseArbStrat`。
3. 逐行 `getline`，循环 `while(1)`：
   - `buf[0]=='#'`：
     - `TokenCount==2` 且名字是 `#DEP_STD_DEV` / `#LOOKAHEAD` / `#TRGT_STD_DEV` → `tholdSet.AddThreshold()`；
     - 否则用 `_` 再分词；若 `#STD_DEV_<n>` 形式（3 段且首段 `#STD`）→ 插入 `m_instruStatMap[n] = value`；其余 **静默 `continue`**。
   - 普通行 `Tokenizer(..., " ")`；`TokenCount<=0` → **`break`（空行=文件结束）**。
   - `TokenCount>2` → 指标行：`baseName/type/indName` + 余下参数；`m_coefficient=arg[0]`；`GetIndicator()` 构造指标对象。
   - `TokenCount==2` → 阈值行：`tholdMap.insert()`（**先到先得**）+ `tholdSet.AddThreshold()`；并用 `MAX_QUOTE_LEVEL` 抬高 `m_instru->m_level`。
4. 若 instrument 名以 `C_` 开头 → 打开 `../data/CombinedInstruments`，解析 `C_* <leg1> <leg2> MULTIPLY/DIVIDE <factor> <ticksize>`，建立组合腿。
5. `LoadTCost(&simConfig)`。

### 3.3 指标行语义

| 字段 | 例子 | 说明 |
|---|---|---|
| baseName | `COPPER_F_0_SFE` | 该指标作用在哪个 instrument |
| type | `FUTCOM` | 合约类型，用于 `ExchTransCharges` 匹配 |
| indicatorName | `Dependant` / `DynamicBeta` / `RelReturns` / `RelBollingerLead` / `MT_SimpleTrend` / `PxMomentum` / `PastReturn` / `Bollinger` / `PriceLag` / `WindowlessTradeImbalance` / `PullQtyImbalance` / `TradeTS` / `MT_DiffPriceType` | 指标实现名 |
| coefficient | `0.291422` | 线性组合权重；`0` 的那条被当作 `signalInd`（`TradeBotUtils.cpp:2015-2016`） |
| args | `2000 1 COPPER_F_0_CME 0.4 MID_PX` | 指标自己的窗口/腿/价格类型 |

生产指标频率（全量 1,958 个 model）**[V]**：

| 指标 | 出现次数 |
|---|---|
| `Dependant` | 1,958（每个 model 一条） |
| `MT_SimpleTrend` | 1,531 |
| `DynamicBeta` | 1,243 |
| `RelBollingerLead` | 1,093 |
| `RelReturns` | 775 |
| `Bollinger` | 687 |
| `PriceLag` | 599 |
| `PxMomentum` | 553 |
| `MT_DiffPriceType` | 281 |
| `WindowlessTradeImbalance` | 93 |
| `PastReturn` | 65 |
| `PullQtyImbalance` | 22 |
| `TradeTS` | 6 |

> 多腿关系不在 control 里，而在 model 的指标参数里：`COPPER_F_0_SFE` 的 model 引用 `COPPER_F_0_CME` / `COPPER_F_0_LME`；`GOLD_F_0_SFE` 引用 `GOLD_F_0_CME`。control 的第 8/9 字段是另一套“显式 pair/arb”机制，生产未用。**[V]**

### 3.4 阈值键：生产实际出现的 30 个

全量 `models/*` 中恰好 2 token、非 `#` 的 key 共 **30** 个 **[V]**：

```
BEGIN_PLACE BEGIN_REMOVE CHECK_PNL CLOSE_CROSS CLOSE_IMPROVE CROSS
CROSS_TARGET CROSS_TICKS IMPROVE LONG_PLACE LONG_REMOVE MAX_LONG_CROSS
MAX_LOSS MAX_QUOTE_LEVEL MAX_SHORT_CROSS MAX_SIZE OPP_QTY PAUSE
PERCENT_SIZE PIL_FACTOR PLACE_SPREAD QUOTE_MAX_QTY SHORT_PLACE
SHORT_REMOVE SIZE SQROFF_AGG SQROFF_TIME STOP_LOSS SUPPORTING_ORDERS
UPNL_LOSS
```

解析入口 `ThresholdSet::AddThreshold()`（`main/TradeBotUtils.cpp:2465-2760`）支持更多键（`NOTIONAL_SIZE`、`TA_SIZE`、`SWEEP_*`、`STDEV_*`、`PCA_COEFF*`、`MODEL_ALGO`、`HIDDEN_NEURONS` 等），但生产 model 只用了上面 30 个。**[V]**

### 3.5 关键字段与风险阈值

**下单/报价几何** **[V]**：

| 键 | 含义（按代码/命名） | 生产取值 |
|---|---|---|
| `SIZE` | 每档基础手数；`MAX_SIZE/SIZE` 算 `SMS_RATIO` | 1,2,3,4,5,8 |
| `MAX_SIZE` | 最大手数 | 1,2,3,4,6,8,10,12 |
| `PERCENT_SIZE` | 百分比模式；置 100 即启用 | 全部 100 |
| `BEGIN_PLACE` | 开始报价的价格偏移 | 0.02 … 26.85（随品种价位量级） |
| `LONG_PLACE` / `SHORT_PLACE` | 多/空方向的报价偏移 | 0.028 … 26.85 / 0.004 … 12 |
| `BEGIN_REMOVE` / `LONG_REMOVE` / `SHORT_REMOVE` | 撤单偏移 | 仅 4/4/425 个文件出现 |
| `CROSS` | 穿越价差阈值；负值会放宽穿越条件 | `0.0` 为主；COPPER agp 全族 `-4` |
| `CLOSE_CROSS` / `CROSS_TARGET` / `CROSS_TICKS` | 平仓穿越/目标价/按 tick 穿越 | 0/1/0–50 |
| `MAX_LONG_CROSS` / `MAX_SHORT_CROSS` | 允许穿越的最大 spread | 1/2/5/10/50 |
| `IMPROVE` / `CLOSE_IMPROVE` / `PLACE_SPREAD` / `PIL_FACTOR` | 改善/挂价差/被动改善因子 | 少量文件使用 |
| `MAX_QUOTE_LEVEL` | 报价档位 | 1（786 个文件） |
| `QUOTE_MAX_QTY` | 只报最大档数量 | 1（761 个） |
| `OPP_QTY` / `SUPP_TOLERANCE` / `SUPPORTING_ORDERS` | 对手量/支撑单过滤 | 0/1 |

**风险阈值** **[V]**：

| 键 | 含义 | 生产取值 |
|---|---|---|
| `UPNL_LOSS` | 未实现亏损上限 | 1000/1500/2000/3000/5000/6000/10000/100000 |
| `STOP_LOSS` | 止损 | 同上 |
| `MAX_LOSS` | 总亏损上限 | 同上 |
| `CHECK_PNL` | 是否检查 PnL | `0`（437 个文件关闭）或未出现（默认 true） |
| `PT_LOSS` / `PT_PROFIT` | 单笔/目标盈亏 | 生产未出现 |
| `PAUSE` / `CANCELREQ_PAUSE` / `SQROFF_TIME` / `SQROFF_AGG` | 暂停/撤单暂停/定时平仓 | 少量 |

**服务端 RMS 才是最后一道闸门** **[V]**：

`3/infra/prod/config/rms/prod.china.rms.xml` 是 ORS 侧风控，和 TradeBot 的 model 阈值是两套：

| 项 | 值 | 行 |
|---|---|---|
| 启用的检查 | `TICKER_LIMIT_CHECK`、`QUANTITY_FIRMLEVEL_CHECK`、`CANCEL_CONFIRMS_COUNT_CHECK` | `:5,7,9` |
| `STOP_LOSS_CHECK` | **被注释掉** | `:6` |
| `PerTickerNetQuantity` | 1,000 | `:23` |
| `OpenValue`（单笔金额） | 500,000 | `:24` |
| `OpenQuantity`（单笔数量） | 1,000 | `:25` |
| `OpenOrders`（每 instrument 挂单数） | 1,000 | `:27` |
| `AccountLevelLossFatalLimit` | 800,000 | `:43` |
| `InstrumentLevelLossFatalLimit` | 10,000 | `:45` |
| `InstrumentLevelLossWarningLimit` | 8,000 | `:46` |
| `MaxCancelConfirmationLimit` | 50,000 | — |

> 也就是说：**TradeBot 的 `MAX_LOSS` 是策略自己平仓；ORS RMS 的 `InstrumentLevelLossFatalLimit=10000` 才是交易所前的硬拒绝。** 两者数量级不同（TradeBot 常见 1,000–3,000；RMS 10,000），迁移/复盘时必须区分是哪一层触发的。**[V/I]**

**风险设计上的三个事实** **[V]**：

1. **1,955 个 model 的 `UPNL_LOSS`、`STOP_LOSS`、`MAX_LOSS` 三值完全相同**（只有 3 个文件例外，且是缺 `MAX_LOSS`）。这等于没有分层风控：三个条件在同一时刻触发，谁先谁后只影响日志文案（`ExecutionStrategy.cpp:2047-2058`）。
2. `CHECK_PNL 0` 出现在 437 个 model 中 → 这些策略**不检查 PnL**，只靠 `MAX_LOSS` 的定时/订单计数路径（具体是否受 `CHECK_PNL` 影响取决于策略实现）。
3. `MAX_POS_SIZE=1000000` 手使持仓上限事实上失效（§1.2），所以**每策略真正的硬闸门是 `MAX_ORDERS=450` 和 `MAX_LOSS`**。

**异常值** **[V]**：

- `CROSS -4`：COPPER `eve.agp` 全 128 天一致；不是单日笔误，但负 cross 的语义未文档化，迁移时必须确认。
- `BEGIN_PLACE 0.0364`（GOLD，tick=0.05）小于一个 tick → 报价条件几乎恒真，属于“始终挂”风格。
- `SCALE` 级差异：GOLD 的 `BEGIN_PLACE` 是 0.02–0.07，COPPER 是 12–27，因为单位分别是“元/克”和“元/吨”。

### 3.6 `#` 元数据：哪些被用、哪些被静默丢弃

| 行 | 是否被解析 | 去向 |
|---|---|---|
| `#DEP_STD_DEV` | 是 | `HISTORICAL_STDDEV` |
| `#TRGT_STD_DEV` | 是 | `TARGET_STD_DEV` |
| `#LOOKAHEAD` | 是 | **`LOOKBACK_TIME = value * 1e6`**（名字叫 lookahead，存的是 lookback） |
| `#STD_DEV_1..7` | 是 | `m_instruStatMap[n] = value` |
| `#TICKSIZE` | **否** | 被 `#` 分支 `continue` 丢弃；`AddThreshold` 里只有不带 `#` 的 `TICKSIZE` 分支，而生产 model 从不写不带 `#` 的 `TICKSIZE` |
| `#AVG_PX` | **否** | 丢弃 |
| `#INSAMPLE_CORR` / `#TRAIN_*` | **否** | 丢弃（只作训练报告） |
| `###TRAIN_*` / `###TRGT_STD_DEV`（41 个 model） | **否** | `###` 前缀导致 `strtok("_")` 首段不是 `#STD`，静默丢弃 |
| `#STD_DEV_n` 的 n 非整数 | 是（`atof`） | 可能得到 0 键 |

> 影响：`#TICKSIZE` 是“看起来生效、实际不生效”的典型。tick size 实际来自 `data/contractfile`（§4.2），model 里的 `#TICKSIZE` 只是生成器的注释。**[V]**

### 3.7 统计

| 指标 | 数值 |
|---|---|
| model 文件数 | 1,958 |
| 总行数 | 70,021 |
| 指标行 | 8,906（平均 4.55/文件） |
| 阈值行 | 30,666（平均 15.66/文件） |
| `#` 行 | 30,449 |
| 最小/中位/最大文件 | 713 / 864 / 1,194 B |
| 目录大小 | 7.6 MB |
| 不同内容（md5） | **65** |
| 每个 model 的阈值键数 | 13–19（常见 14–18） |

生产 model 家族与 controls 一一对应，唯独 `GOLD_F_0_SFE.eve.print`：**48 个 control 没有对应 model**（§9.1）。**[V]**

### 3.8 热重载：`SIGUSR2` 只重读阈值

`main/main.cpp:152-159` **[V]**：

```cpp
else if( sig == SIGUSR2 ) {
    LoadThresholds( simConfig );
    TBLOG << "Strategy Thresholds Reset." << endl;
    ...
}
```

`LoadThresholds()`（`main/TradeBotUtils.cpp:2121-2165`）**[V]**：

- 重新打开每个 `controlConfig.m_modelFile`；
- 跳过 `#` 行；
- 只处理 `TokenCount<=2` 的行 → `AddThreshold()`；
- 重新计算 `m_instru->m_level`；
- **不会重新加载指标行、不会重新读 control、不会重置仓位/PnL**。

运维证据：`.bash_history` 多次出现 `vim ~/models/model...` 后 `kill -SIGUSR2 <pid>`，说明这是当时调参的主要手段。**[V]**

### 3.9 解析器的健壮性风险

| 风险 | 证据 | 影响 |
|---|---|---|
| 空行终止解析 | `if (TokenCount <= 0) break;`（`TradeBotUtils.cpp:1940-1943`） | 未来在 model 中间加空行，后面的阈值全部丢失，且**不报错** |
| `Tokens[10]` 无界 | `Tokenizer` 不检查 `TokenCount`（`common/Tokenizer.cpp:4-14`）；`char* Tokens[10]`（`TradeBotUtils.cpp:1844`） | 当前最大 9 token；超过 10 会栈溢出 |
| 固定缓冲区 + `strcpy` | `m_modelFile[1024]`、`m_startTime[5]`、`m_endTime[5]`、`m_id[10]`（`TradeBotUtils.h:570-575`）；`LoadControlFile` 直接 `strcpy` | 超长路径/时间会越界 |
| control 数量无上限 | `simConfig[count]`（`TradeBotUtils.cpp:1668`），`MAX_SIM_CONFIG=20` | 列表模式 >20 会越界 |
| 未知键静默忽略 | `AddThreshold` 最后的 `else` 无日志 | 拼错的 `UPNL_LOS` 不会报错，只会用默认值（默认 1e10 = 几乎无风控） |
| 数值不校验 | `atoi/atof` | `SIZE abc` → 0，后续除法可能异常 |

---

## 4. `data/`：合约、费用、日历、初始化、持仓、其它

### 4.1 规模与构成

`data/` 共 **563 MB / 4,280 文件** **[V]**：

| 子项 | 大小 | 说明 |
|---|---|---|
| `BSE/` | 492 MB | 印度 BSE 历史/模拟数据，Live 中国链路不用 |
| `SIGNS/` | 8.7 MB（1,038 目录 / 2,192 文件） | 每 instrument 一个正则文件；Live C++ 无读者，`regress/` Python 脚本读取 |
| `BASKET/` | 5.1 MB（75 个目录 + `baskets`） | 篮子指标成分 |
| `MCX/` | 1.6 MB | MCX 历史数据 |
| `KRX/` | 12 KB | KRX 现金数据 |
| `REUTERS/` | 44 KB | Reuters RIC 映射 |
| 根目录文件 | ~55 MB | `contractfile`、`NSECDSTokens`(27 MB)、`ForexAlerts`、holidays、instruments 等 |

### 4.2 合约/品种定义

| 文件 | 行数 | 格式 | 读取者 |
|---|---|---|---|
| `contractfile` | 1,863（含 1 行表头） | `#INSTRUMENT TICKSIZE LOTSIZE EXCHANGE STRIKEGAP SEGMENT [ENDTIME PRICEFACTOR CONTRACTFACTOR]`；实际 4/5/6/9 列不等 | `common/Instrument.cpp:1414,1442`、`Tools/marketMonitor.cpp:137` |
| `ChinaInstruments` | 19 | `<base> <exchangeCode> <month>...`，如 `GOLD au 6 12` | `Instrument::FillChinaFields()`（`common/Instrument.cpp:566`） |
| `CMEInstruments` | 28 | `GOLD GC 1 GC` | `FillCMEFields()`（`:660`） |
| `LMEInstruments` | 5 | `COPPER CA` | `FillLMEFields()` |
| `KoreaInstruments` / `OSEInstruments` / `SGXInstruments` / `ICEInstruments` / `RussiaInstruments` / `BrazilInstruments` | 小 | 各自 `base code` | 各自 `Fill*Fields()` |
| `CombinedInstruments` | 30 | `C_<name> <leg1> <leg2> MULTIPLY/DIVIDE <factor> <ticksize>` | `LoadModelFile()`（`TradeBotUtils.cpp:2066`） |
| `RolloverOverrideFile` | 18 | `<base> <symbol> <startDate> <endDate>` | `Instrument::RolloverOverride()`（`Instrument.cpp:419-452`） |

生产 SFE 合约规格（来自 `contractfile`）**[V]**：

```
GOLD_F_0_SFE     0.05  1000  SFE  0  FUTCOM
SILVER_F_0_SFE   1     15    SFE  0  FUTCOM
COPPER_F_0_SFE   10    5     SFE  0  FUTCOM
COPPER_F_0_CME   5     25000 CME  0  FUTCOM
COPPER_F_0_LME   0.25  25    LME
GOLD_F_0_CME     1     100   CME  0  FUTCOM
SILVER_F_0_CME   5     5000  CME  0  FUTCOM
```

`RolloverOverrideFile` 的生产相关行 **[V]**：

```
GOLD_F_0_CME   GCQ5   20150528 20150615
SILVER_F_0_CME SIN5   20150428 20150430
GOLD_F_0_SFE   au1512 20150518 20151115
SILVER_F_0_SFE ag1512 20150518 20151115
COPPER_F_0_SFE cu1507 20150518 20150529
```

这与 2015-06-30 日志里的 `au1512`、`ag1512` 完全一致；`Instrument.cpp:435` 用 `m_currDate` 做区间判断，**过了 2015-11-15 就回退到 `ChinaInstruments` 的按月推算**。**[V/I]**

### 4.3 费用

`ExchTransCharges`（75 行，CSV）**[V]**：

```
NSE_CM,EQ,0.00003905,0.00028905,0,0
NSE,FUTSTK,0.00002366,0.00012366,0,0
...
SFE,FUTCOM,0,0,12,2,GOLD
SFE,FUTCOM,0.00006,0.00001,0,0,SILVER
SFE,FUTCOM,0.00006,0.00001,0,0,COPPER
SFE,FUTCOM,0.000054,0.000054,0,0,RUBBER
SFE,FUTCOM,0.000054,0.000054,0,0,STEEL
```

- 列：`exchange, instruType, buyTx, sellTx, buyContractTx, sellContractTx, [baseNameFilter]`。
- `LoadTCost()` 用 `control.exchange` + 第一条指标的 `type` 匹配；第 7 列存在时还要求 `baseName` 前缀匹配（`TradeBotUtils.cpp:2210-2223`）。
- **找不到就 `exit(1)`**（`:2238-2241`）。新增品种/改类型必须同时改这张表，否则 TradeBot 起不来。**[V]**
- GOLD 的 `0,0,12,2` 与 SILVER/COPPER 的百分比形式不同，单位/含义未在代码里注释；迁移前必须确认（§11 未决问题）。**[V/I]**

### 4.4 节假日/日历

| 文件 | 覆盖范围 | 读取者 | 状态 |
|---|---|---|---|
| `DIHolidays.csv` | 2008-01-01 → 2050-12-25（516 行） | Brazil DI `Instrument.cpp:1076` | 未来日期到 2050，像“生成器一次写满” |
| `DIBusinessDays.csv` | 2013-07 → 2025-03（141 行） | Brazil DI | 到 2025，已过期 |
| `LMEHolidays.csv` | 2015 年有 112 条 | LME `Instrument.cpp:879` | 仅 LME |
| `NSEHolidays` | 9 B | NSE `Instrument.cpp:2872` | 只有 1 行 |
| `NSEHolidays2012/2013/2014/2015` | 9/72/36/36 B | NSE `Instrument.cpp:2941` | **`NSEHolidays2015` 里只有 4 个 2014 年日期**（`20140226/20140327/20140729/20140827`）→ 2015 年匹配不到任何假日 |
| `OSEHolidays` | 351 B | OSE `Instrument.cpp:2578` | 2014 年日期为主 |

**中国/SFE 没有任何节假日文件，也没有 `IsTradingDay()`/`IsHoliday()` 调用**（全树 grep 零命中）。**[V]**

影响：

- TradeBot 不会因为周末/中国节假日拒绝交易；是否交易完全取决于“有没有人启动进程”。
- `CopyControlsModels` 每天生成 control/model，包括周末和 2015-05-01/06-20，进一步掩盖了“非交易日”这件事。**[V]**

### 4.5 每日初始化/开盘价/映射

| 文件 | 格式 | 读取者 | 用途 |
|---|---|---|---|
| `<EXCHANGE>Prices`（`CMEPrices`、`NSEPrices`、`BSEPrices`、`KRXPrices`、`OSEPrices`、`BOVESPA_EQPrices`、`NSE_CDSPrices`） | 首行 symbol 列表，后续行 `date px...` | `Instrument::FillOptionFields()`（`Instrument.cpp:1602`） | 期权行权价/开盘价 |
| `KRXPrices.main` | `date px...`，**append** | `FillOpeningPrices()`（`main/main.cpp:279-299`） | KRX 开盘价；生产中国未用；文件不存在 |
| `NSET2T` / `BSE/BSET2T` | 小文本 | `Instrument.cpp:134,157` | NSE/BSE tick-to-trade 映射 |
| `NSECDSTokens` / `BSE/BSECDSTokens` | 27 MB / 小 | `Instrument.cpp:130,461` | NSE/BSE CDS token 映射 |
| `OptionsParams` | `KEY=VALUE` | `OptionManager::LoadOptionsParams()` | 期权做市参数 |
| `ForexAlerts` | `date,time,currency,importance,event` | `common/NewsHandler.cpp` | 新闻事件；只对 CME IR / BOVESPA DOL 生效（`ExecutionStrategy.cpp:113-114`） |

`ForexAlerts` 的日期范围是 **20141001–20150407**（155 个日期），对 2015-06/07 的运行已经过期；但中国 SFE 策略不使用 `NewsHandler`，所以无直接影响。**[V]**

### 4.6 仓位/PnL 持久化文件：代码里有，磁盘上没有

代码会写这些文件 **[V]**：

| 文件 | 写入点 | 内容 |
|---|---|---|
| `../data/positions<strategy_id>` | `ButterflyStrategy::LoadPositions()` 读；`SavePositions()` 写 | 日期 + 三腿 netpos + 三腿价格 |
| `../data/final_positions_<date>_<id>` | `ButterflyStrategy.cpp:610` | 日期 + 三腿 netpos + 平仓价 |
| `../data/final_PNL_<date>_<id>` | `ButterflyStrategy.cpp:657` | `DATE NUM_FLY OVNPNL1..3 PNL1..3 OVNPNLSUM INTRADDAYPNL SUMPNL IMP1..3 AGG1..3` |
| `../data/begin_prices_calendar_<id>` | `PairwiseArbStrategy.cpp:64`（读） | 期初价日历 |

磁盘现状 **[V]**：

- `3/TradeBot/TradeBot_China/data/` 下 **没有** `positions*`、`final_positions*`、`final_PNL*`、`begin_prices_calendar*`、`KRXPrices.main`、`dataDumpFile`。
- 说明 `ButterflyStrategy` / `PairwiseArbStrategy` 在中国生产**从未启用**（controls 里也没有 `BUTTERFLY_STRAT`/pair 类）。**[V/I]**
- 这两个类的 `LoadPositions()`/`LoadSpread()` **不检查 `ifstream.good()`**，文件不存在时 `t1/t2/t3`（`ButterflyStrategy.h:47`）保持未初始化 → 若启用会以随机仓位启动。**[V]**

**唯一的真实仓位快照**在 ORS 侧 **[V]**：

```
/home/piyush/ORS_CHINA_extreme/log/position.csv
ag1512,8,0,8,0
cu1510,1,0,1,0
```

- 30 B，mtime 2015-07-24，2 行。
- 由 `3/leon/bin/reqPosAMd_sgitNew` 通过 CTP `OnRspQryInvestorPositionDetail` 查询后覆盖写（strings 里有 `getDetailPosition`、`writePositionfile`）。
- 配置在 `/home/leon/CL/config/.leonConfig.cfg:21`；cron 每天 08:10/20:20 各跑一次（`2/var/spool/cron/root:4,13`）。
- **没有历史**：每次覆盖同一文件；列语义未文档化（§11）。

### 4.7 其它数据

| 路径 | 说明 | 使用者 |
|---|---|---|
| `BASKET/<name>` | 每行 `<instrument> <type> <weight>` | `AddIndicatorBasket()`（`TradeBotUtils.cpp:1724-1812`） |
| `BASKET/baskets` | 篮子定义，如 `DI1_1_2_5 -0.77 DI1Y_F_1 0.63 ...` | 篮子策略 |
| `SIGNS/<instrument>/...` | 每 instrument 的正则/权重文件（例：`NIFTY_F_[\w]* [\w\s]*,1`） | **Live C++ 无读者**；`regress/CreateTempSignFile:10`、`regress/Filter:230`、`regress/Filter_plusRandoomSamples:129` 读取，用于模型/样本过滤 |
| `MCX/MCX*DATA_<yyyymm>`、`BSE/BSEDATA_<yyyymm>` | 历史逐笔/快照 | Sim/Regress 回放 |
| `KRX/KRX_CASH_DATA` | KRX 现金数据 | KRX 模拟 |
| `REUTERS/{CMX,DGX,GLOBAL,MCX,rics}` | Reuters RIC 映射 | Reuters 数据源 |

### 4.8 生产者/消费者矩阵（生产中国链路）

| 数据 | 生产者 | 消费者 | 频率 |
|---|---|---|---|
| `contractfile` | 人工/交易所 dump（未归档生成器） | TradeBot 启动时 | 每次启动 |
| `ChinaInstruments` | 人工 | `FillChinaFields` | 每次启动 |
| `RolloverOverrideFile` | 人工 | `RolloverOverride` | 每次启动 |
| `ExchTransCharges` | 人工 | `LoadTCost` | 每次启动 |
| `OptionsParams` | 人工 | `OptionManager` | 启动/`SIGUSR2` |
| `controls/*` | `CopyControlsModels` + 人工编辑 | TradeBot `--controlFile` | 每日 |
| `models/*` | 离线工具链：`scripts/AutoGenerateModels` 跑 regress 并按 `PnL/TPc` 过滤，`scripts/copyControl.pl` 复制 control+model 到 `ModelRepository`；具体拟合步骤未归档 | TradeBot | 每日/`SIGUSR2` |
| 行情（shm 10201） | `3/re` 接收进程 | Connector → TradeBot | tick |
| 行情（shm 872） | **生产者未归档**（CTP/MD 网关） | Connector → TradeBot | tick |
| 订单/成交（shm 3872/4872） | TradeBot → Connector | ORS | 事件 |
| 仓位快照 | ORS `reqPosAMd_sgitNew` | 人工/GUI | 每日 2 次 |
| 成交 CSV | GUI 手工导出 | 人工 | 不定期 |

### 4.9 过期数据与漂移

| 项 | 现状 | 风险 |
|---|---|---|
| `NSEHolidays2015` | 只有 4 个 2014 日期 | 2015 年 NSE 假日全部漏判（本部署不用 NSE，但模板会误导） |
| `LMEHolidays.csv` | 2015 有 112 条 | 2016 以后无覆盖 |
| `DIBusinessDays.csv` | 到 2025-03 | 2025-04 以后无覆盖 |
| `ForexAlerts` | 到 2015-04-07 | 新闻过滤在 6/7 月失效 |
| `RolloverOverrideFile` | COPPER 到 2015-05-29；GOLD/SILVER 到 2015-11-15 | 之后回退到按月推算，可能选错合约 |
| `3/re/cme.recv.quincy.data.cfg` | 配置 Host 与 2015-06-02 日志里的 Host 不同 | 配置被改过/日志是旧版本；无法判断哪份对应生产 |
| `Config/signal.txt` | NIFTY 期权 | 直接 `kill -TERM` 不会平仓 |
| `Connector/config_CHINA_CME.cfg` | `TICKERS` 是 NIFTY | 仅 cosmetic（运行时覆盖），但会误导排障 |
| `Position.csv`（GUI） | 含 `cu1505`（2015-05 到期）、`GCJ5` | 过期合约仍在费用/乘数表里 |
| `3/GUI/SH` 二进制 | 2014-12-21，比源码旧 3 个月 | 见 00/03 文档 |

---

## 5. `livescripts/`：启停、信号、pid、日志、运行时状态

### 5.1 两套脚本，别混用

| 位置 | 文件 | 目标二进制 | 状态 |
|---|---|---|---|
| `TradeBot_China/livescripts/`（SVN） | `runExec.pl`、`runExecMulti.pl`、`startTrade.pl`、`startTradeMulti.pl`、`stopTrade.pl`、`stopTradeMulti.pl`、`stopCrossMulti.pl`、`reloadParams.pl`、`killExec.pl`、`killExecMulti.pl`、`pnl_watch.pl`、`pnl_watch.sh` | `/home/TradeBot/TradeBot_Multi/main/TradeBot`（`runExec.pl:15`）或 `TradeBot_testbook`（`runExecMulti.pl:15`） | **过时**：本机没有 `TradeBot_Multi` 目录 |
| `3/TradeBot/livescripts/`（运行） | `RunStrategies.sh`、`RunStrategies_noon.sh`、`run.sh`、`temp.sh`、`CopyControlsModels`、`copymodels.sh`、`ZipLogs.sh` | `/home/TradeBot/TradeBot_China/main/TradeBot` | **实际使用** |

`nohup.out` 是过时脚本失败的直接证据 **[V]**：

```
execvp: No such file or directory
failed to execute /home/TradeBot/TradeBot_Multi/main/TradeBot
```

### 5.2 信号表

TradeBot 的信号处理在 `main/main.cpp:90-160`（`Squareoff(int32_t sig)`），注册在 `main/CommonClient.cpp:241`。**[V]**

| 信号 | 数值 | 行为 | 是否读 `signal.txt` |
|---|---|---|---|
| `SIGUSR1` | 10 | 恢复策略（`m_Active=true`，清除 exit/cancel/flat） | 否 |
| `SIGUSR2` | 12 | **重载模型阈值**（`LoadThresholds`） | 否 |
| `SIGTSTP` | 20 | 平仓（非激进） | 否（对所有策略） |
| `SIGTERM` | 15 | 平仓（非激进） | **是**（只对列表内 baseName） |
| `SIGRTMIN` | 34 | 恢复 | **是** |
| `36` | `SIGRTMIN+2` | **激进平仓**（单进程/单符号） | **是** |
| `37` | `SIGRTMIN+3` | **激进平仓**（整组） | 否 |

脚本侧 **[V]**：

| 脚本 | 发的信号 | 备注 |
|---|---|---|
| `startTrade.pl` | `SIGUSR1`（`startTrade.pl:23`） | 单策略恢复 |
| `startTradeMulti.pl` | `34`（`:37`） | 写 `signal.txt` 后恢复 |
| `stopTrade.pl` | `SIGTSTP`（`:23`） | 单策略平仓 |
| `stopTradeMulti.pl` | `SIGTERM`（`:36`） | 写 `signal.txt` 后平仓 |
| `stopCrossMulti.pl` | `36`（`:36`） | 写 `signal.txt` 后激进平仓 |
| `reloadParams.pl` | `SIGUSR2`（`:23`） | 热重载阈值 |
| `killExec.pl` | `pkill -9 -P <sh_pid>`（`:18`） | 硬杀 |
| `killExecMulti.pl` | 遍历 lock 文件，`rm` 同 pid 的所有 lock | 硬杀 |

**缺口**：没有任何脚本发送 `37`（整组激进平仓）；`stopTradeMulti.pl` 注释说“group”，实际发的是 `36`（单符号）。**[V]**

### 5.3 lock 文件与 pid 语义

`runExec.pl:34-47` **[V]**：

```perl
my $lock_file="$LOCK_DIR/lock.$strategy_id";
if ( -e $lock_file ) { print "Could not acquire lock"; exit; }
open( $lock_fd, ">$lock_file" );
print $lock_fd "$$ $dep_basename $pwd";
```

- lock 文件内容：`<perl_pid> <dep> <cwd>`。
- 后续 `startTrade*.pl`/`stopTrade*.pl` 通过 `ps -o pid --ppid $process_id` 两次取到**孙子进程**（perl → `sh -c` → TradeBot）的 pid，再发信号。**[V]**
- 本快照 **没有 `/home/TradeBot/locks/` 目录**，也没有任何 `lock.*` 文件 → 运行时状态未被归档（或已清理）。**[V]**
- `killExec.pl` 只 `pkill -P` 杀 shell 的子进程，不杀 shell 本身；随后 `rm -f lock`。**[V]**

### 5.4 日志命名与追加

`runExec.pl:31` **[V]**：

```perl
my $logfile = "$LOG_DIR/log.live.control.$dep_basename.$strategy_id.$date";
```

`runExecMulti.pl` 把多个 dep/id 拼进同一个文件名 **[V]**：

```perl
my $logfile = "$LOG_DIR/log.live.control";
for(...) { $logfile .= ".".$depNames[$i].".".$stratIds[$i]; }
$logfile .= ".$date";
```

`RunStrategies.sh` 直接传 `--logFile /home/TradeBot/log/log.live.control.<...>.<date>`，并对持续运行的 `ltp` 用 `>>` 追加（`:13`）。**[V]**

### 5.5 运行时脚本实际做了什么（2015-07-25 版本）

`RunStrategies.sh` **[V]**：

- `cd /home/TradeBot/TradeBot_China/main`（**cwd 必须是 main**，否则 `../Config`、`../data`、`../models` 全部找不到）。
- 9 条 `nohup taskset -c <cpu> .../TradeBot --Live --controlFile ... --startDate 20150725 --endDate 20150725 --strategyID 420 --configFile ... --logFile ...`，其中 **8 条被注释**，只有 `GOLD_F_0_SFE.eve.ltp` 在跑。
- CPU 绑定：`21`（ltp）；注释掉的有 `4/5/6/7/8`。
- `--adjustLTP 1` 只给 `eve.ltp` 和 `eve.agg`。

`RunStrategies_noon.sh` **[V]**：

- 只有 `GOLD_F_0_SFE.noon.agg` 在跑，`taskset -c 29`，其余注释。

`run.sh` **[V]**：

- 硬编码 `20150519`、`control.COPPER_F_0_SFE.gold.20150519`、`strategyID 420`、`taskset -c 7`；是**一次性调试脚本**。

`temp.sh` **[V]**：

- 用 `main/Obama`（TradeBot 的改名副本）跑 `eve.print` 和 `SILVER.ltp`，带 `--regressTime 5 --adjustLTP 1`；
- 输出重定向到 `log.live.control.GOLD_F_0_SFE.eve.print.$today`（不是 `--logFile`），说明 `Obama` 把 `IND` 打到 stdout；
- `control.GOLD_F_0_SFE.eve.print.*` 没有对应 model（§9.1），所以这条脚本在当前归档上**必然启动失败**。

`ZipLogs.sh` **[V]**：

```bash
cd /home/TradeBot/log/
ls *`date +"%Y%m%d"` | xargs gzip
```

- 只压缩“当天”的 TradeBot 日志；当前 `log/` 里 **没有 `.gz`**，说明最后一次没跑或已被清理。

**人工操作序列（`.bash_history` 证据）** **[V]**：

1. `sh ~/livescripts/RunStrategies.sh`（启动所有需要的实例）。
2. **`pkill -SIGUSR1 TradeBot`** —— 这一步不在脚本里，但 `grep` 到 **19 次**；Live 模式构造时 `m_Active=false`（`ExecutionStrategy.cpp:116-119`），不发 `SIGUSR1` 就**只连行情、不下单**。
3. 盘中调参：`vim models/...` → `kill -SIGUSR2 <pid>`（热重载阈值）。
4. 盘中停止：`pkill -SIGTSTP TradeBot`（全部平仓）或 `pkill -37 TradeBot`（激进平仓）。
5. 收盘：cron `pkill -9 Trade` 或手动 `pkill -9 TradeBot`。

> 这是一个**隐式启动契约**：`RunStrategies.sh` 本身不激活策略；忘记第 2 步时，日志里只有 `IND:`，没有 `NewOrder:`，看起来“进程正常”但完全没交易。**[V/I]**

`CopyControlsModels` **[V]**：

- 见 §2.6；它还会把 `RunStrategies*.sh` 里的日期全部替换，并 `chmod +x`。
- `bckp/RunStrategies.sh` 是 7/24 版本，和 7/25 的差别只有日期，证明它每天被覆盖一次。

### 5.6 cron 时间线（生产日）

来自 `2/var/spool/cron/root` **[V]**：

| 时间 | 动作 |
|---|---|
| 07:50 | `SetAffinity.py` |
| 08:10 | `reqPositionFile.sh`（查 ORS 仓位，写 `position.csv`） |
| 08:11 | `runORS_extreme_new.sh`（**先 `ipcrm -M 3872/727272/4872/872`**，再起 ORS） |
| 08:55 | `3/re/receive_new.sh`（重建 CME 行情 shm 10201；872 的产者不在本目录） |
| 08:56 | `startAll_new2.sh`（起 SHStrategy 进程；**不起 TradeBot**） |
| 15:05 | `pkill -9 Trade`（**硬杀 TradeBot**）、`pkill -9 ors/rec`、`killAllStrategy.sh` |
| 15:30 | `backPnlLog.sh` |
| 19:50 | `SetAffinity.py` |
| 20:20 | 再查仓位 |
| 20:21 | 再起 ORS（再次清 shm） |
| 20:55 | 再起行情接收 |
| 20:56 | 再起 SHStrategy |
| 次日 02:35 | `killAllStrategy.sh`、`pkill -9 rec/ors/Trade`、**`copymodels.sh`**（生成次日 control/model） |

关键结论 **[V/I]**：

- **TradeBot 不在 cron 里启动**，只由人手动 `sh ~/livescripts/RunStrategies.sh`（`.bash_history:533,555,592`）。
- cron 负责“杀”，人负责“起”；所以“某天有没有跑”只能看日志，不能看 cron。
- `runORS_extreme_new.sh` 每次启动都 `ipcrm -M 872`（中国 MD）→ 如果 TradeBot 在 ORS 重启后没重启，会失去行情/订单通道。**[V]**

---

## 6. 日志：格式、内容、轮转、可重建性

### 6.1 四类日志

| 类别 | 路径 | 文件数/大小 | 命名 | 时区 |
|---|---|---|---|---|
| TradeBot 策略日志 | `3/TradeBot/log/log.live.control.*` | 3 个 / 6.5 MB（目录 8.1 MB） | `log.live.control.<dep>.<id>.<yyyymmdd>` | **GMT** |
| GUI 日志 | `3/GUI/SH/SkylineGUI-*.log` | 25 个 / **9.0 GB** | `SkylineGUI-<yyyymmdd-HH.MM.SS>.log` | 本地 CST |
| DataService 日志 | `3/infra/dataservice_deploy/DataService-*.log` | 296 个 / 866 MB | `DataService-<yyyymmdd-HH.MM.SS>.log` | 本地 CST |
| CME 录制日志 | `3/re/*.log` + `log/*.stats` | 79 个 / 40 MB（log 25 MB） | `cme.recv.quincy.data.cfg.<start>-<end>.log` | 本地 CST |

> 注意：提示里的 `3/GUI/SH/logs/` **不存在**；GUI 日志直接放在 `3/GUI/SH/` 根下。**[V]**

**源码树 `3/TradeBot/TradeBot_China/log/`（6 个研究/回归产物，不是运行日志）** **[V]**：

| 文件 | 大小 | 内容 |
|---|---|---|
| `INDfile.21061433510089173630` / `FinalINDfile.*` | 283/291 KB | 回归模式的指标 dump；`Final` 是过滤后的版本 |
| `tempfile.21061433510089173630` / `...112210096` | 199/205 KB | 回归中间文件 |
| `IndicatorsCorelationList` | 11.5 KB | 指标相关性表 |
| `ord` | 61 KB / 310 行 | 2015-06-01 单日 GOLD 的 `NewOrder/New Confirmation/Trade` 手工摘录 |
| `pnl_multi.sh` | 2.1 KB | 与运行版 `livescripts/pnl_watch.sh` 同类的 PnL 汇总脚本 |

### 6.2 TradeBot 日志格式

启动头（每个 run 一段）**[V]**：

```
initialized SpreadState historicIndRet=0 indepStatus=0
*****TradeBot started in Live Mode*****
########################################
Input Parameters
configFile : /home/TradeBot/TradeBot_China/Connector/config_CHINA_CME.cfg
logFile : /home/TradeBot/log/log.live.control.GOLD_F_0_SFE.noon.agg.20150630
controlFile : /home/TradeBot/controls/control.GOLD_F_0_SFE.noon.agg.20150630
endDate : 20150630
startDate : 20150630
strategyID : 420
########################################
Config File: ...
Option Param File:../data/OptionsParams
Control File: ...
Model File: ...
230 330                     ← 实际生效的 GMT 窗口
Contract Specs:GOLD_F_0_SFE 0.05 1000 SFE
Current Day:...
SFE Expiry Date:...
GOLD au
China Symbol: au1512,RollOver Date: ...,Expiry Month:...
OverRiding Rollover date and symbol for : GOLD_F_0_SFE with: au1512
Inserted InstruSim: au1512|
```

事件行 **[V]**：

| 行型 | 例子（截断） | 可提取信息 |
|---|---|---|
| `IND:` | `20150630 02:35:52.439537 GOLD_F_0_SFE IND: 238.221056 238.225000 -0.025461 -0.053416` | 时间、instrument、目标价/中间价/两个信号值（列义未文档化，推断 I） |
| `NewOrder:` | `20150601 13:08:51.195278 NewOrder: GOLD_F_0_SFE Side: 1 Px: 241.2 Qty: 4 Level: 0 OrdID: 1000000 CPx: 241.075 TPx: 241.243 42 241.05 X 241.1 16 BPNL: ... APNL: ... NetPos: 0 OrdHitType: 2` | 下单参数、盘口、预期 PnL |
| `New Confirmation:` | `... New Confirmation: GOLD_F_0_SFE OrdID: 1000000 Px: 241.2 Qty: 4` | ORS 确认 |
| `Trade:` | `... Trade: GOLD_F_0_SFE OrdID: 13000000 Px: 240.05 Qty: 4 Side: 2 NetPos: -4 NetPNL: -256 RPNL: 0 UPNL: -256 TPx: ... BPx: ... APx: ... BQty: ... AQty: ... Imp: 0 Cx: 100 TPc: 0.0632511 ORatio: inf TRatio: 0.25 MaxPNL: 0 DrawDown: -256` | **成交 + 仓位 + PnL + 改善/穿越比例 + 回撤** |
| `Limit reached.` | `... Limit reached. Square off is Called. Strategy Exiting.. Order Count:... Limit Reason: END TIME limit got hit!!` | 触发平仓的原因（END TIME / MAX LOSS / MAX ORDERS / MAX TRADED） |
| `Invalid Indicator Value` | `Invalid Indicator Value : GOLD_F_0_SFE DynamicBeta 10 0` | 指标未就绪（启动初期常见） |
| `Error while opening...` | — | 缺文件，通常随后 `exit(1)` |

`Trade:` 的列顺序与 `pnl_multi.sh`/`pnl_watch.pl` 的取值完全对应：NetPos=$14、NetPNL=$16、RPNL=$18、UPNL=$20、Cx=$34、TPc=$36、DrawDown=$44、MaxPNL=$42（1-based awk 字段）。**[V]**

### 6.3 GUI 日志格式

格式 **[V]**：

```
YYYYMMDD-HH:MM:SS.ffffff LEVEL  [file.cpp:line] |message
```

示例 **[V]**：

```
20150713-08:59:48.656798 INFO  [GuiMsgHub.cpp:85] |recv [15302|initComplete#true]
20150713-08:59:48.665431 INFO  [GuiMsgHub.cpp:85] |recv [15312|contractName#au1512,57,quoting;15312|contractName#GCQ5,54,driving;...]
20150713-08:59:48.665471 INFO  [GuiMsgHub.cpp:85] |recv [15312|initBidFairValue#1,1;...;initBidExlim#1000,100;initAskExlim#0,500]
20150713-09:02:34.235171 INFO  [OpenOrderMsgHub.cpp:89] |TRADE_CONFIRM OrderID :14000003 ...
20150713-09:02:34.235206 INFO  [FillResponse.cpp:122] |FillResponse process trade_confirm14000003
20150713-09:01:10.478604 INFO  [GuiMsgHub.cpp:85] |recv [15312|console#au1512 GCQ5 P-16strategy stop]
```

内容统计（20150713-08.59.48 单文件，约 2.8M 行）**[V]**：

| 消息 | 次数 |
|---|---|
| `impliedBidFairValue#` / `impliedAskFairValue#` | 1,465,005 each |
| `bidPrice#` / `askPrice#` | 881,298 each |
| `FVMidAverage#` | 364,450 |
| `heartBeat#` | 97,264 |
| `bidStatus#` / `askStatus#` | 3,427 / 3,111 |
| `console#` | 1,017 |
| `askFills#` / `bidFills#` | 531 / 528 |
| `init*`（每个策略 12 条） | 36 组 |
| `strategyName#` | 36 |

`b * / *` 日志是**二进制匹配**（grep 会提示 “Binary file matches”），因为消息里混有 NUL/控制字符；分析时需 `grep -a`。**[V]**

GUI 日志**不记录 PnL 数值**，只记录 UI 更新与消息；仓位/PnL 来自 DataService 的实时流（`Position.cpp:24-31`、`PNLCollector`），不落日志。**[V]**

### 6.4 DataService / CME 录制日志

- DataService：每次启动一个 `DataService-<timestamp>.log`；启动阶段打印 store 列表（`servicemanager.cpp:99`、`datastoremanager.h:56`）；运行期大量 `serviceorderdatastore.cpp:83/116`（单文件 70 万行）。**是订单存储的调试流水，不是成交流水**。**[V]**
- CME 录制：每个 run 一个日志，只有启动 14 行 + `bookbuilder.h:331/333` 的丢包/跳号告警；payload 不进日志。`log/*.stats` 是 CME 会话统计。**[V]**
- 两类日志都**没有轮转**，按进程启动次数增长。

### 6.5 CSV 输出

`3/GUI/SH/*.csv` 共 50 个 **[V]**：

| 类型 | 数量 | 内容 |
|---|---|---|
| `TRADE_CONFIRM` 导出 | **40** | `TRADE_CONFIRM,<orderId>,<symbol>,<qty>,<B/S>,<px>,<yyyyMMdd-HH:MM:SS.ffffff>,<exchangeType>` |
| 空文件 | 9 | 0 B（导出时无数据） |
| `Position.csv` | 1 | `symbol,group,multiplier,fees`，8 行 |

- 40 个成交 CSV 覆盖 **26 个日期**（20150505–20150724），共 **14,918 行**，每个文件最多 **500 行**（明显的导出上限，不是全量成交）。**[V]**
- 成交品种：`au1512` 5,183、`ag1512` 3,711、`cu1509` 3,621、`ni1509` 809、`cu1510` 494、`zn1509` 419…。**[V]**
- 这些 CSV 是 GUI `FillResponse` 对话框手工导出的（`FillResponse.cpp:66-90`：输入文件名 → 追加 `.csv` → 遍历表格写 CSV），**不是自动落盘**。**[V]**
- `Position.csv` 是 GUI 的**合约/乘数/费率表**，不是仓位表：`PositionModel::AddFromCsv()` 把它读进 symbol/group/mult/fees 四列，并把 PNL 列置 0（`PositionModel.cpp:269`）；`AddToCsv()` 只在注释里被调用（`Position.cpp:68`）。**[V]**

### 6.6 轮转与保留

| 日志 | 轮转 | 压缩 | 保留 |
|---|---|---|---|
| TradeBot | 按日期新文件；同日重启**追加** | `ZipLogs.sh` 只 gzip 当天 | 当前只有 3 个运行日志 + 6 个研究文件 |
| GUI | 每次启动新文件 | 无 | 10 天 25 个文件，9.0 GB（≈0.9 GB/天） |
| DataService | 每次启动新文件 | 无 | 60 天 296 个文件，866 MB |
| CME 录制 | 每次启动新文件 | 无 | 79 个文件，40 MB |
| CSV | 手工导出 | 无 | 50 个文件 |

> 容量风险：GUI 日志按 0.9 GB/天线性增长，3 个月约 80 GB；本快照 10 天已占 9 GB。**[V/I]**

### 6.7 能重建什么、不能重建什么

**能** **[V]**：

- 每个 TradeBot run 的启动参数（config/control/model 路径、start/end、strategyID、adjustLTP）。
- 每个订单的下单/确认/成交序列（NewOrder → New Confirmation → Trade）。
- 成交后的净仓位、NetPNL、RPNL、UPNL、MaxPNL、DrawDown、改善率/穿越率。
- 指标时间序列（IND 行），可用于复算信号。
- GUI 侧的盘口/FV 更新、策略心跳、手工成交 CSV。
- DataService 的进程/客户端/订单存储活动。

**不能** **[V/I]**：

- 运行前的初始仓位（TradeBot 不落盘；只有 ORS 每日两次快照，且被覆盖）。
- 运行时的完整模型文件（只保留归档版本；盘中可能被 `vim` 改过）。
- 运行时的完整 control 文件（同上；6/18 已证明同一天两种窗口）。
- 完整订单簿（只有成交时刻的 BB0/BA0/BQty/AQty）。
- GUI 的 PnL 历史（只在内存/界面，不落日志）。
- 任何跨进程的全局订单 ID 映射（TradeBot OrdID 与 GUI/ORS 的 ID 段不同，无法直接 join）。

---

## 7. 持久化：什么是耐久的、什么是内存、有没有 DB

### 7.1 三层状态

| 层 | 内容 | 耐久性 |
|---|---|---|
| **文件** | controls、models、Config、data、日志、CSV、`position.csv` | 耐久（但会被覆盖/改写） |
| **进程内存** | `SimConfig`、`ExecutionStrategy` 的 `m_netpos/m_netPNL/m_orderMap/m_bidMap/m_askMap`、`CalculatePNL`、指标窗口 | **进程退出即丢** |
| **共享内存** | MD 872/10201、ORS 3872/4872、client store 727272 | 进程退出即丢；ORS 启动时 `ipcrm` 主动清 |
| **DB** | 无 | — |

### 7.2 没有数据库（证据）

- `grep -rniE "psql|postgres|mysql|sqlite|libpq|odbc|db2|oracle"` 在 `TradeBot_China` 的 `*.cpp/*.h/Makefile` 中**零命中**。**[V]**
- 唯一像 DB 的字符串是 `common/GetBeta.cpp:12` 的 `const char* BRAZIL_BETA_DB = "/home/TradeBot/Brazil_db2";`，它其实是一个**目录**，里面是 `DB_file.<dur>.<date>.3` 文本文件；该目录在本快照中不存在。**[V]**
- `main/Makefile:9,12,16` 的链接库是 `connectormwmr/logger/xsim/datamanip/commonutils/snappy/z/xsimdataserver`，**没有 DB 客户端库**。**[V]**
- 对 `china_ors_ctp`、`china_ors_extreme_new`、`dataservice`、`mdreceiverX_bothfeeds` 做 `strings | grep -iE "sqlite|libpq|postgres|mysql"` 均无命中。**[V]**
- `3/dalong/infrastructure` 里确有 `CommonDbApi/`、`FastDb/` 两个库，但 TradeBot 源码/链接均未引用。**[V]**

### 7.3 交易/仓位/PnL 的持久化现状

| 数据 | 是否落盘 | 位置/机制 |
|---|---|---|
| 订单 | 否（仅日志文本） | `NewOrder:`/`New Confirmation:` |
| 成交 | 否（仅日志文本 + GUI 手工 CSV） | `Trade:` / `TRADE_CONFIRM` |
| 当前仓位 | 否（内存） | `ExecutionStrategy::m_netpos` |
| 已实现/未实现 PnL | 否（内存 + 日志快照） | `m_netPNL/m_realizedPNL/m_unrealizedPNL` |
| 日终仓位 | 仅 ORS 快照 | `position.csv`，覆盖写 |
| 日终 PnL | 否 | 只有 TradeBot 日志最后一条 `Trade:` |
| 策略参数 | 是（controls/models） | 但会被每日复制/盘中编辑 |
| GUI 合约/费率 | 是 | `Position.csv` |
| GUI 表格列宽 | 是 | `QSettings("Test")`（`Position.cpp:61-69`） |

**重启语义** **[V/I]**：

- TradeBot 重启后 `m_netpos=0`、`m_netPNL=0`，不会从 ORS 拉仓位；策略会按“空仓”重新开始报价。
- 真正的仓位对账靠 cron 的 `reqPositionFile.sh` 写 `position.csv`，供人看，不回灌 TradeBot。
- 因此**重启是高风险操作**：旧仓位仍在交易所，新进程不知道，可能双向叠加。唯一缓解是 15:05 的 `pkill -9 Trade` 之前先发平仓信号（但 cron 是直接 `pkill -9`）。**[V/I]**

### 7.4 pid 文件路径 bug

`main/main.cpp:683-690` **[V]**：

```cpp
sprintf( pid, "/home/TradeBot/TradeBot/data/pid.%s", simConfig[i].m_dateConfig.m_currDate );
pidFile.open( pid, ios::app );
sprintf( pid, "%d %d", strategyID, getpid());
pidFile.write( pid, strlen(pid) );
```

- 实际数据目录是 `/home/TradeBot/TradeBot_China/data`，**不是 `/home/TradeBot/TradeBot/data`**。
- 该目录不存在 → `ofstream.open` 失败但**不检查**，`write` 静默无效 → **没有任何 pid 文件**。
- 运维实际用的是 `locks/` 里的 perl pid（§5.3），不是这个文件。

### 7.5 其它“写文件”的代码路径

`grep -rn "ofstream" main Strategies common` 只有 4 处 **[V]**：

| 位置 | 写什么 | 生产是否发生 |
|---|---|---|
| `main/main.cpp:279` | `../data/KRXPrices.main`（append） | 否（KRX 未用） |
| `main/main.cpp:683` | `pid.<date>`（路径错误） | 否（目录不存在） |
| `Strategies/ButterflyStrategy.cpp:608` | `final_positions_<date>_<id>` | 否（策略未用） |
| `Strategies/ButterflyStrategy.cpp:654` | `final_PNL_<date>_<id>` | 否（策略未用） |

> 结论：**Live 中国链路的 TradeBot 实际上不写任何业务状态文件**，只写日志（Logger 内部）。

---

## 8. 数据流：配置/模型/控制 → TradeBot；行情 → GUI/策略；订单/仓位 → GUI/日志

### 8.1 启动时序（单策略）

```
RunStrategies.sh
  └─ cd /home/TradeBot/TradeBot_China/main
     └─ TradeBot --Live --controlFile ... --configFile ... --logFile ...
        1. LoadArgMap                       (main.cpp:388)
        2. cfg.LoadCfg(configFile)          (main.cpp:426)
        3. LoadControlFile                  (main.cpp:613)
        4. LoadDateConfig                   (main.cpp:645)  ← control 的 start/end（GMT）
        5. LoadModelFile                    (main.cpp:646)  ← 指标 + 阈值
        6. LoadDateConfigEpoch              (main.cpp:649)
        7. CalculatePNL / 策略构造           (main.cpp:669, 702+)
        8. ExecutionStrategy ctor           → 读 ../Config/StrategyConfig.cfg
        9. 汇总 TICKERS/TICKERS_10LEN        (main.cpp:860-958)
       10. ConnectorConfig.init(cfg)         (main.cpp:993)
       11. new Connector(...)                (main.cpp:1032)
       12. connector->StartAsync()           (main.cpp:1062)
```

要点 **[V]**：

- `LoadModelFile` 在 `LoadDateConfig` 之后，所以 `m_currDate` 已就绪，`RolloverOverride` 能按日期选合约。
- `TICKERS` 是从 `simConfig[i].m_instruMap` 里**动态汇总**的，覆盖配置文件里的静态值。
- `ExecutionStrategy` 构造函数**每个实例**都重新打开 `../Config/StrategyConfig.cfg`（`ExecutionStrategy.cpp:64`），不是全局单例。

### 8.2 行情与订单的共享内存链路

```
[CME UDP]
   └─ 3/re/mdreceiverX  (config: cme.recv.quincy.data.cfg)
        └─ shm 10201 (CME, 1000)

[CTP/SHFE MD]  ← 生产者未归档（3/re 只配了 CHINA_CME/10201）
        └─ shm 872 (CHINA SHFE, 100000)

shm 872 / 10201
   ├─ TradeBot Connector (config_CHINA_CME.cfg: MDSHMKEY=872,10201)
   │     └─ CommonClient::SendInfraMDUpdate → 指标 → 策略
   │
   └─ DataService (configStream_CTP.xml: Key 872 / 3872 / 4872)
         ├─ ServerPort 1732  (StreamingApplication)
         └─ ServerPort 20000 (ServiceApplication)  ← GUI 默认连这个

TradeBot → Connector → shm 3872 (ORSREQ) → china_ors_extreme_new → CTP 7776
                                      ← shm 4872 (ORSRES) ←
```

证据 **[V]**：

- `Connector/config_CHINA_CME.cfg:16-23`。
- `3/infra/dataservice_deploy/configStream_CTP.xml:3,16-31`。
- `3/infra/prod/config/prod.china.ors_new.cfg:1,5,32,34`（`FRONT_ADDR_ORS/MD=tcp://127.0.0.1:7776/7777`）。
- `3/infra/prod/scripts/runORS_extreme_new.sh:3-7`（`ipcrm -M` 清 3872/727272/4872/872）。
- `3/leon/CL/config/.leonConfig.cfg:1-2`（`MDIP/TRADEIP` 同 7776/7777）。

### 8.3 GUI / SHStrategy 是另一条独立链路

**关键结论：TradeBot 不连接 GUI。** **[V]**

- `grep -rn "15213|zmq|ZMQ"` 在 `TradeBot_China` 源码/Makefile 中零命中。
- GUI 的 `ServerPort 15213` 是它自己的 ZMQ hub，供 `/home/leon/CL` 的 `SHStrategy_new` 进程推送/拉取（`GuiSettings.xml:7`、`cfg_*:Z|15213`、`sendMsg2GUI.cpp:17`）。
- GUI 的 34 个策略窗口（端口 15300–15333）对应 `GuiSettings.xml` 的 `<StrategyList>`；策略名在运行时由 `strategyName#<quoting> <driving> <name>` 填（日志里可见 `au1512 GCQ5 P-16`、`ag1512 SIU5 B-FAKL-0`）。
- 因此 GUI 表里的 `edge/size/slope/lean/exlim` **不是 TradeBot model 参数**，而是 SHStrategy 的 `cfg_*` 参数（§8.4）。
- 但两者并非完全隔离：DataService 同时读 ORS 请求/响应 shm（`configStream_CTP.xml:23,30`），所以 GUI 的 PnL/订单视图仍可能**间接**看到 TradeBot 的订单（`ServiceOrderStore`），只是不经过 GUI 的 ZMQ 策略通道。**[V/I]**

GUI 与 DataService 的连接 **[V]**：

- `ConnectionDetails` 默认 `127.0.0.1:20000`（`3/dalong/infrastructure/TradingSystemsGUI/ConnectionDetails.h:14-16`）。
- `Position.cpp:24` 用默认 `connDetails` 构造 `PNLCollector`，对应 `configServiceChinaNew.xml:4` 的 `ServerPort 20000`。
- GUI 的 PnL/仓位是**实时流**，不落盘（`Position.cpp:24-31`、`PositionModel::SetData`）。

### 8.4 `edge/size/slope/lean/exlim` 到底在哪

**不在** `/home/TradeBot/models/*`：全量 grep `EDGE|SLOPE|LEAN|EXLIM` 零命中（只有 `SIZE`）。**[V]**

它们在 **[V]**：

- `3/leon/CL/config/cfg_*`（41 个）与 `.strategy*.cfg` 的图例：
  ```
  #NAME,A|BSIZE,B|OSIZE,C|SIZEInc,D|DSIZE,E|QSIZE,F|ROUNDPOINT,
  G|BEDGE,H|OEDGE,I|EDGEInc,J|BSLOP,K|OSLOP,L|SLOPInc,
  M|BLEAN,N|OLEAN,O|LEANInc,P|BFV,Q|OFV,R|FVInc,S|DMUL,T|QMUL,
  U|BTicks,V|OTicks,W|DProperties,X|QProperties,Y|FakeTicks,Z|PUSHPort,...
  ```
- `3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/sendMsg2GUI.cpp:114-150`：把 `bidEdge/offerEdge/edgeIncrement`、`bidSlop/offerSlop/slopIncrement`、`bidLean/offerLean/leanIncrement`、`bidSize/offerSize/sizeIncrement`、`bidFV/offerFV/FVIncrement` 拼成 `initBidEdge#...;initAskEdge#...` 发给 GUI。
- `3/dalong/FromDaya/SkylineFL_GUI/Strategy.cpp:26-58`：`nameToCol["initBidEdge"]=bidEdge` 等；表头是 `Bid Exlim,Bid Size,Bid Edge,Bid Slope,Bid Lean,...`（`Strategy.cpp:113-115`）。

> 所以：**TradeBot 的 `SIZE/MAX_SIZE/BEGIN_PLACE/LONG_PLACE/SHORT_PLACE/CROSS/UPNL_LOSS/STOP_LOSS/MAX_LOSS` 与 GUI 的 `edge/size/slope/lean/exlim` 是两套完全不同的参数体系**。把两者混为一谈会导致迁移时把 GUI 的做市参数当成风控阈值，或反之。**[V]**

一个可见的漂移：GUI 支持 `initBidExlim/initAskExlim`（`Container.cpp:144,166`），但当前 `sendMsg2GUI.cpp` **不发送 exlim**；所以 GUI 的 Exlim 列在该版本里保持默认/空。**[V]**

### 8.5 订单/仓位 → GUI/日志

| 流 | 路径 | 落点 |
|---|---|---|
| TradeBot 自动单 | TradeBot → Connector → ORS 3872/4872 → 交易所 | TradeBot `NewOrder/New Confirmation/Trade` 日志；DataService `ServiceOrder` store |
| SHStrategy 手工/做市单 | SHStrategy → GUI 153xx → ORS | GUI `OpenOrderMsgHub`/`FillResponse` 日志；手工 CSV |
| 仓位 | ORS → DataService → GUI `Position` 表 | 内存；`position.csv` 仅 ORS 侧快照 |
| PnL | TradeBot 内存 + 日志；DataService `NetPnlStore` → GUI | 日志 `Trade:`；GUI 不落盘 |

**无法直接 join**：TradeBot 日志的 `OrdID`（如 `13000000`）与 GUI CSV 的 `OrderID`（如 `18000375`）不在同一命名空间；没有共享的全局订单 ID。**[V/I]**

---

## 9. 缺口、绝对路径、过期、重复、秘密

### 9.1 缺失文件/悬空引用

| 引用 | 出处 | 状态 |
|---|---|---|
| `../Config/sanitycheck.cfg` | `Connector/config_CHINA_CME.cfg:9` | **不存在**（仅 SANITYCHECK 模式用） |
| `../scripts/squareoffcontrols.sh` | `main/main.cpp:623` | **不存在**（`--squareoff` 模式不可用） |
| `../controls/control.squareoff.list` | `main/main.cpp:626` | 运行目录**不存在**；源码树样例只有 2 行，指向 `control.CRUDEOIL_F_0/1.squareoff`（MCX），且这两个文件也不存在 |
| `../models/model.squareoff.list` | `main/main.cpp:625` | 运行目录**不存在** |
| `data/positions<id>` | `ButterflyStrategy.cpp:70` | 不存在（策略未用） |
| `data/final_positions_*` / `final_PNL_*` | `ButterflyStrategy.cpp:610,657` | 不存在 |
| `data/begin_prices_calendar_<id>` | `PairwiseArbStrategy.cpp:64` | 不存在 |
| `data/KRXPrices.main` | `main.cpp:279` | 不存在 |
| `data/dataDumpFile` | `main.cpp:855` | 不存在（仅 Regress） |
| `data/<EXCHANGE>Prices`（SFE） | `Instrument.cpp:1602` | **没有 `SFEPrices`**（SFE 期权不支持） |
| `/home/TradeBot/TradeBot/data/pid.*` | `main.cpp:685` | 目录不存在（路径少了 `_China`） |
| `/home/TradeBot/locks/` | 所有 perl 脚本 | 未归档/已清理 |
| `GOLD_F_0_SFE.eve.print` 的 model | 48 个 control | **48 个 control 指向不存在的 model** |
| `main/TradeBot_Multi` | `runExec.pl:15` | 不存在（脚本过时） |
| `3/infra/prod/config/prod.china.pubX.cfg` | `prod.china.start.distr.toCME2.src.sh:7` | **不存在**；因此 **shm 872 的生产者无法从归档中确认**（`3/re` 只配了 10201） |

`GOLD_F_0_SFE.eve.print` 缺失是最大的“成对缺口” **[V]**：

```
controls: 48 个 control.GOLD_F_0_SFE.eve.print.<date>
models:   0 个 model.GOLD_F_0_SFE.eve.print.<date>
```

原因：`temp.sh` 用 `Obama` + `--regressTime 5` 跑 print 模式，**不读 model**（或读的是另一个路径），所以 `CopyControlsModels` 只复制了 control，没有对应 model。用正常 `TradeBot --Live --controlFile` 起这些文件会 `exit(1)`。**[V/I]**

### 9.2 硬编码/绝对路径

| 路径 | 出处 | 问题 |
|---|---|---|
| `/home/TradeBot/models/...` | 所有 control 第 2 字段 | 换机器/换用户必须整体改 |
| `/home/TradeBot/TradeBot_China/...` | `RunStrategies*.sh` | 目录名写死 |
| `/home/TradeBot/TradeBot_Multi/main/TradeBot` | `runExec.pl:15` | 树名错误 |
| `/home/TradeBot/TradeBot/data/pid...` | `main.cpp:685` | 少 `_China` |
| `/home/TradeBot/Brazil_db2` | `GetBeta.cpp:12` | 目录不存在 |
| `/home/leon/CL/config/cfg_` | `cfgField.cpp:38` | 策略配置根 |
| `/home/piyush/ORS_CHINA_extreme/log/position.csv` | `.leonConfig.cfg:21` | 跨用户路径 |
| `/home/infra/dataservice_deploy/...` | `configServiceChinaNew.xml:5-6` | 部署路径 |
| `/home/GUI/SH/...` | `runChinaGui.sh` | 部署路径 |
| `../data/...`、`../Config/...`、`../models/...` | TradeBot 源码 | **cwd 必须是 `TradeBot_China/main`** |

> 结论：这套系统**不可重定位**；迁移必须保持 `/home/TradeBot`、`/home/leon`、`/home/piyush`、`/home/infra` 的目录形状，或做一次全局路径替换并重编译。**[V/I]**

### 9.3 过期日期/内容

| 项 | 过期点 | 影响 |
|---|---|---|
| `Config/signal.txt` | NIFTY 期权 | 直接 kill 不平仓 |
| `Connector/config_CHINA_CME.cfg` `TICKERS` | NIFTY | 运行时被覆盖；误导排障 |
| `NSEHolidays2015` | 只有 2014 日期 | 2015 NSE 假日漏判 |
| `LMEHolidays.csv` | 只到 2015 | 2016+ 漏判 |
| `DIBusinessDays.csv` | 到 2025-03 | 之后漏判 |
| `ForexAlerts` | 到 2015-04-07 | 新闻过滤失效 |
| `RolloverOverrideFile` | COPPER 到 2015-05-29；GOLD/SILVER 到 2015-11-15 | 之后选错合约 |
| `data/ChinaInstruments` | 静态月份表（无年份） | 依赖 override；override 过期后按月推算 |
| `controls`/`models` | 到 2015-07-25 | 之后没有参数 |
| `GuiSettings.xml`（源码树） | `ServerPort 15150`、4 个策略 | 与部署版 15213/34 个不一致 |
| `Position.csv` | 含 `cu1505`（已到期） | 费率/乘数表过期 |
| `3/re` 配置 Host | 与日志 Host 不同 | 不知道哪份是生产 |

### 9.4 重复配置/重复数据

| 重复项 | 规模 | 判定 |
|---|---|---|
| `2/TradeBot` vs `3/TradeBot` | 10,296 文件 / 778 MB | 逐字节相同（00-inventory §9.1）**[V]** |
| `2/GUI/SH` vs `3/GUI/SH` | 9.0 GB | 排除日志/CSV 后相同 **[V]** |
| `controls` 2,006 个 | 归一化后 24 种 | 每日克隆 **[V]** |
| `models` 1,958 个 | 65 种 md5 | 每日克隆 + 少量重训 **[V]** |
| `Config/ShmConfig*.cfg` 31 个 | 大量重叠 key | 无读者 **[V]** |
| `Connector/config_CHINA_CME.cfg` vs `_LME.cfg` | 仅 shm 大小/key 不同 | 两套并存，易混 **[V]** |
| `TradeBot.bak` / `tempTradeBot` | 1.0 G / 848 M | 历史切片，不应合并 **[V]** |

### 9.5 秘密/敏感信息（只记位置，不记值）

| 位置 | 内容类型 | 风险 |
|---|---|---|
| `/home/leon/CL/config/.leonConfig.cfg:7` | **明文 `PASSWORD=`**（券商/CTP） | 最高；同文件还有 `USERID/BROKERID/INVESTORID` |
| `/home/infra/dataservice_deploy/passwordfile.xml` | 141 B，权限 `rw-rw-r--` | DataService 认证口令；被 `configServiceChinaNew.xml:6` 引用 |
| `3/GUI/SH/ConnectDialog.cpp:87-95` | 代码会把 `user,password` 明文写入 `QSettings`（`~/.config/<Company>/<App>.conf`） | 若用户勾选 “Save Session”，口令落盘；本快照未发现该 QSettings 文件 |
| `3/TradeBot/.ssh/known_hosts` | 2 条主机指纹 | 仅主机信息；无私钥 |
| `3/TradeBot/.subversion/auth/` | **0 文件** | 未缓存 SVN 口令（好消息） |
| `config_CHINA_squareoff_*.cfg` | `ACCOUNT=<内部账户>` | 账户代码，非口令但敏感 |
| 日志/配置中的内网地址 | `10.30.49.x`、`192.168.0.x`、`222.72.161.x`、`14.140.97.x:2727` | 分享前替换 |

> 未读取 `passwordfile.xml` 和 `.leonConfig.cfg` 的口令值；文档中不出现明文。

### 9.6 逻辑/配置缺陷清单

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| 1 | Live 模式无仓位/PnL 持久化、无启动对账 | `grep ofstream` 只有 Butterfly/KRX/pid 三处死路径（§7.5）；`pkill -9 Trade`（cron `:20`） | 重启即空仓；旧仓位仍在交易所，可能双向叠加 |
| 2 | 无中国节假日/交易日判断 | `grep IsTradingDay/IsHoliday` 零命中；无 SFE holiday 文件 | 周末/节假日可交易 |
| 3 | `MAX_POS_SIZE=1000000` 手 | `StrategyConfig.cfg:2` + `ExecutionStrategy.cpp:68` | 持仓上限事实失效 |
| 4 | 三层风控阈值相同 | 1,955/1,958 model 的 `UPNL_LOSS=STOP_LOSS=MAX_LOSS` | 无分层，先触发者只影响日志 |
| 5 | `LoadTCost` 找不到费用就 `exit(1)` | `TradeBotUtils.cpp:2238-2241` | 新合约/改类型直接起不来 |
| 6 | 空行终止 model 解析 | `TradeBotUtils.cpp:1940-1943` | 加空行静默丢阈值 |
| 7 | `#TICKSIZE` 被忽略 | `TradeBotUtils.cpp:1919-1936` vs `:2736-2737` | 以为生效，实际只用 `contractfile` |
| 8 | pid 路径少 `_China` | `main.cpp:685` | 无 pid 文件 |
| 9 | `pairStrat/arbStrat` 全局不复位 | `TradeBotUtils.cpp:215-216` | controlList 混排会误判 |
| 10 | `control.squareoff.list`/脚本缺失 | §9.1 | `--squareoff`/`--controlList` 平仓模式不可用 |
| 11 | GUI 的 `Position.csv` 被误当仓位表 | `PositionModel.cpp:232-310` | 实际是合约/费率表；PNL 每次启动归零 |
| 12 | GUI 二进制落后源码 3 个月 | 00-inventory §5.6 | 部署行为与源码不一致 |
| 13 | CME 录制配置 Host 与日志不一致 | `cme.recv.quincy.data.cfg:18` vs 20150602 日志 | 不知道哪份是生产 |
| 14 | `BUTTERFLY/PAIRWISE` 状态文件缺失且不检查 `good()` | `ButterflyStrategy.cpp:64-84`、`PairwiseArbStrategy.cpp:58-66` | 若启用会以未初始化仓位启动 |
| 15 | 31 个 `ShmConfig*.cfg` 无读者 | §1.4 | 维护噪音，易误改 |

---

## 10. 证据索引（可复现命令）

| # | 命令 | 作用 |
|---|---|---|
| E1 | `ls 3/TradeBot/controls \| wc -l` → 2006；`ls 3/TradeBot/models \| wc -l` → 1958 | 文件数 |
| E2 | `ls 3/TradeBot/controls \| grep -oE '[0-9]{8}$' \| sort -u \| wc -l` → 143 | 日期跨度 |
| E3 | `for f in 3/TradeBot/controls/control.*; do sed -E 's/[0-9]{8}/DATE/g' $f \| md5 -q; done \| sort -u \| wc -l` → 24 | 控制模板重复度 |
| E4 | `md5 -q 3/TradeBot/models/model.* \| sort -u \| wc -l` → 65 | 模型重复度 |
| E5 | `cat 3/TradeBot/models/model.* \| awk 'NF==2 && $1!~/^#/{print $1}' \| sort \| uniq -c` | 阈值键频率 |
| E6 | `grep -n "LoadControlFile\|LoadModelFile\|LoadThresholds\|LoadTCost" 3/TradeBot/TradeBot_China/main/TradeBotUtils.cpp` | 解析器位置 |
| E7 | `sed -n '1676,1722p' 3/TradeBot/TradeBot_China/main/TradeBotUtils.cpp` | 7/8/9 字段解析 |
| E8 | `sed -n '1916,2039p' 3/TradeBot/TradeBot_China/main/TradeBotUtils.cpp` | model 逐行解析/# 分支/空行终止 |
| E9 | `sed -n '2465,2760p' 3/TradeBot/TradeBot_China/main/TradeBotUtils.cpp` | `AddThreshold` 全部键 |
| E10 | `sed -n '90,160p' 3/TradeBot/TradeBot_China/main/main.cpp` | 信号语义 |
| E11 | `sed -n '46,63p' 3/TradeBot/TradeBot_China/common/Watch.cpp` | GMT HHMM → epoch |
| E12 | `grep -n "SetGMTimeStamp" 3/TradeBot/TradeBot_China/main/main.cpp` | 日志 GMT |
| E13 | `grep -c "TradeBot started in Live Mode" 3/TradeBot/log/log.live.control.GOLD_F_0_SFE.eve.ltp.20150618` → 4 | 同日多次运行 |
| E14 | `awk '/TradeBot started/{n++} n>0 && /^[0-9]{3,4} [0-9]{3,4}$/{print n,$0}' 3/TradeBot/log/...20150618` | 每次运行的窗口 |
| E15 | `grep -E "NewOrder:\|Trade:\|Limit reached" 3/TradeBot/log/log.live.control.GOLD_F_0_SFE.eve.ltp.20150617 \| head` | 订单/成交/风控行格式 |
| E16 | `grep -a "initBidEdge" 3/GUI/SH/SkylineGUI-20150713-08.59.48.log \| head -1` | GUI 参数推送 |
| E17 | `grep -n "initBidEdge\|initBidSlop\|initBidLean" 3/leon/CL/SHSHFAK/SHSHFAKAutoFrog/sendMsg2GUI.cpp` | 参数来源 |
| E18 | `cat 3/leon/CL/config/Bak.strategy_new.cfg \| head -1` | `A\|BSIZE…Z\|PUSHPort` 图例 |
| E19 | `sed -n '232,310p' 3/dalong/FromDaya/SkylineFL_GUI/PositionModel.cpp` | Position.csv 是合约表 |
| E20 | `nl -ba 2/var/spool/cron/root \| sed -n '1,35p'` | cron 时间线 |
| E21 | `cat 3/TradeBot/livescripts/CopyControlsModels` | 每日克隆 |
| E22 | `cat 3/TradeBot/livescripts/nohup.out` | `TradeBot_Multi` 路径失效 |
| E23 | `cat 3/piyush/ORS_CHINA_extreme/log/position.csv` | 唯一仓位快照 |
| E24 | `grep -rniE "psql\|postgres\|mysql\|sqlite\|libpq" 3/TradeBot/TradeBot_China` （无输出） | 无 DB |
| E25 | `strings 3/TradeBot/TradeBot_China/main/TradeBot \| grep -E "^\.\./(Config\|data)/"` | 二进制真实文件依赖 |
| E26 | `for b in ...; do strings $b \| grep -c CLIENTSTOREKEY; done` （全 0） | ShmConfig 无读者 |
| E27 | `cat 3/re/cme.recv.quincy.data.cfg` | 行情 shm 10201 |
| E28 | `grep -n "Key>" 3/infra/dataservice_deploy/configStream_CTP.xml` | 872/3872/4872 对齐 |

---

## 11. 未决问题（需要人/外部输入）

1. **控制文件到底以哪一版为准？** `20150618` 同一个 control 路径在日志里出现 `01:00–02:15` 与 `13:00–18:30` 两种窗口，说明盘中被人改过。归档的 controls 是最后一次编辑的结果；历史复盘是否应完全以日志头为准？谁拥有这些文件的编辑记录？
2. **TradeBot 重启后的仓位对账流程是什么？** 代码不读 `position.csv`，cron 又直接 `pkill -9 Trade`；是靠人工在重启前先平仓，还是靠 ORS 侧拒绝重复仓位？是否计划补仓位/PnL 持久化？这决定了这套系统能否安全重放/迁移。
3. **`ExchTransCharges` 的 SFE 行 `0,0,12,2` 和 `position.csv` 的 5 列各是什么单位/语义？** 前者看起来不是百分比（GOLD 与 SILVER/COPPER 形式不同），后者 `ag1512,8,0,8,0` 的 0 是“今仓/昨仓”还是“买/卖”？没有注释，也没有生成器源码。
4. **models 的 65 种内容 / controls 的 24 种模板是“每日重新拟合”还是纯复制？** 如果是重新拟合，为什么 1,958 个文件只有 65 种内容？`scripts/AutoGenerateModels` 的实际调用参数和训练窗口没有归档，无法判断模型新鲜度。
5. **shm 872（中国 SHFE 行情）由谁生产？** `3/re` 只配置了 CME 10201；`prod.china.start.distr.toCME2.src.sh` 引用的 `prod.china.pubX.cfg` 不在归档里。没有 872 的生产者，TradeBot/DataService 的中国行情无法重建。**[V/I]**
6. **`passwordfile.xml` 与 `.leonConfig.cfg` 的口令轮换/归属**（不读值）：这两个文件都是明文/弱权限，且跨用户目录；在生产恢复前必须确认是否仍有效、是否需要先吊销。

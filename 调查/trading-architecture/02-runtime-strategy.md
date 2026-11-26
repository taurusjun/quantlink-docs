# 02 — TradeBot 运行时与策略层（tbsrc）

> 证据约定：**V** = 直接读代码/配置/脚本确认；**I** = 由代码结构、脚本、部署推断，未在运行环境验证；**P** = 计划/文档描述，当前代码未实现。
> 本文正文结论只用 V 和 I；凡与仓库 `docs/`、`openspec/` 或旧架构文档不一致的地方，集中在 §10.1 对照，**不把文档当事实**（那些条目相当于 P）。
> 源码快照：`/Users/wangjun/PG/RD/quantlink-trading`，commit `5cee3dd5b3322ec21c1958aac20ad38ba0d8ca40`，分支 `main`，调查日期 2026-11-18。
> 本文只覆盖 `tbsrc`（TradeBot 进程）与策略层。ORS/CTP、SHM 槽位细节见 `03-ors-connectors.md`；管理面下发 control/model 的过程见 `04-admin-control-plane.md`；表结构见 `05-data-model.md`。

---

## 0. 先读这一节：十个决定复刻成败的事实

| # | 事实 | 证据 |
|---|---|---|
| 1 | **一个 TradeBot 进程 = 一个 control 文件 = 一个策略对象**。唯一例外是 `--controlList` + `--optionStrategy 1` 的 OptionManage 容器（N 个 simConfig 共享一个进程与一个 `OptionManager`）。 | V: `tbsrc/main/main.cpp:635-660`、`tbsrc/main/TradeBotUtils.cpp:1872-1900`、`tbadmin/admin.cpp:1878` |
| 2 | 行情回调与订单回报回调**在同一个线程**里串行执行（Connector 的 SHM 轮询线程）；策略对象内部**零锁**。 | V: `tbsrc/hftbase/Connector/src/connector.cpp:599-666`、`tbsrc/hftbase/Ipc/include/shmmanager.h:751-783`、`ExecutionStrategy.cpp` 全文无 mutex（grep 计数 0） |
| 3 | 决策链路是 **MD → 指标更新 → 目标价 → 报价门控 → 发单**；而**风控检查（亏损/时间/拒单）在发单之后**才跑。 | V: `tbsrc/main/CommonClient.cpp:776-790`（先 `m_INDCallBack` 后 `m_MDCallBack`），`ExecutionStrategy.cpp:434-494`、`:786-835`、`:2180-2371` |
| 4 | 订单表以**价格为主键**（`m_bidMap`/`m_askMap`），同一侧同一价格只能有一张单；重复价格直接拒发。 | V: `ExecutionStrategyStructs.h:10-15`、`ExecutionStrategy.cpp:1535-1549` |
| 5 | `MAX_POS_SIZE` **不是持仓上限**，而是"累计成交手数上限"（`m_maxTradedQty`）；持仓上限来自 model 的 `MAX_SIZE/BID_MAX_SIZE/ASK_MAX_SIZE`。 | V: `ExecutionStrategy.cpp:70`、`:2191`、`:2201`、`:607-701`、`:1329-1341` |
| 6 | `--Live` 启动后策略默认 **`m_Active=false`，不发任何单**；必须由 `tbstart`（SIGUSR1）激活。 | V: `ExecutionStrategy.cpp:389-392`、`:466-485`、`main.cpp:150-159`、`scripts/ops_tb_signal.sh:66-74` |
| 7 | `SIGTERM` **不会退出进程**，且只有在 `./config/signal.txt` 列出该合约时才平仓；文件缺失时直接 return。真正的停机靠 `kill -9`。 | V: `main.cpp:110-128`、`scripts/build_deploy_cpp.sh:676-695` |
| 8 | 持仓恢复靠本地文件，共三种：pair 系读 `../data/daily_init.<sid>`；MMF 系读 `../position/<sid>`（CSV）；对冲/拆单系读 `../position/<sid>`（KEY=VALUE，**文件缺失即 exit(-1)**）。其余单腿策略无恢复。 | V: `PairwiseArbStrategy.cpp:24-54`、`MMFPassiveStrategy.cpp:247-310`、`PassiveHedgingStrategy.cpp:555-560`、`SimpleHedgingStrategy.cpp:146-240` |
| 9 | 券商侧持仓是**账户级净额**（ORS 按 `InstrumentID` 汇总后决定开/平今/平昨），TradeBot 侧持仓是**策略级本地账本**，两者从不自动对账。 | V: `ors/China/src/ORSServer.cpp:509-593`、`CommonClient.cpp:957-1026`（请求不带开平标志） |
| 10 | 运行时依赖三个**硬编码绝对路径**：`/home/hft/tbdata/contractfile`、`/home/hft/tbdata/fee.csv`、`/home/hft/tbdata/RolloverOverrideFile`；缺失即 `exit(1)`。部署脚本用软链把 `data_cpp/data` 挂过去。 | V: `Instrument.cpp:1548`、`:1575`、`:440`、`TradeBotUtils.cpp:2463`、`scripts/ops_install_deps.sh:42-66` |

---

## 1. 进程启动

### 1.1 入口与模式

`main()` 在 `tbsrc/main/main.cpp:388`。程序版本串是硬编码的 `"2026-2-27 -2"`（`main.cpp:394`），与 git commit 无关 —— 排障时不能靠版本串判断代码版本（V）。

模式由 **`argv[1]` 位置参数**决定，不是 `--key value`（V: `main.cpp:404-413`）：

```text
--Regress | --Sim | --Live | --LeadLag
```

`GetMode()` 把字符串映射到 `ModeType` 枚举（V: `TradeBotUtils.cpp:2694-2712`，枚举定义 `TradeBotUtils.h:181-187`）。

> **Regress/LeadLag 的退出时序（V 代码路径 + I 结果）**：main 在非 Live 模式把 cfg 的 `INTERACTION_MODE` 设成 `SIMULATION`（`main.cpp:1076-1086`）。若 config 里确实是 `SIMULATION`，`connector->StartAsync()` 会被放进一个 **detach 的线程**（`:1170-1177`），主线程立刻走到 `HandleSignals()`；而 `HandleSignals` 只对 Live/Sim 进入 `sigwait`，对 Regress/LeadLag 直接 `exit(1)`（`CommonClient.cpp:248-254`）→ **仿真线程还没跑就被退出**。若 config 用 `PEEK`（从 `MDDUMP` 同步读盘），`StartAsync()` 是阻塞调用，跑完才到 `HandleSignals`，Regress 才能正常完成。复刻时把这条时序当成"取决于配置的陷阱"，不要依赖 Regress 做回归。

| 模式 | 数据来源 | 是否交易 | 备注 |
|---|---|---|---|
| `--Regress` | `--paramFile` + `--dateFile/startDate/endDate` | 否（`IndicatorCallBack` 只打印指标） | 跑完由 `HandleSignals` 直接 `exit(1)`（`CommonClient.cpp:248-254`） |
| `--Sim` | `XSIM_CONFIG_PATH` 指定的 SimConfig | 是（`m_Active=true` 起手） | 由 `ExchSim` 撮合；`sigwait` 常驻 |
| `--Live` | ORS 的 SHM | 是（但需 SIGUSR1 激活） | 生产模式 |
| `--LeadLag` | 同 Sim | 是 | 走 LeadLag 指标集；跑完同样 `exit(1)` |

### 1.2 参数表（全量，代码实际读取的 39 个键）

`LoadArgMap()` 从 `argv[2]` 开始按 `--key value` 成对解析，存进 `unordered_map`（V: `TradeBotUtils.cpp:2541-2566`）。**未识别的键不会报错**，只是永远没人读 —— 所以 `--printMod 1` 这种拼写错误会静默失效（V: `tbadmin/admin.cpp:1878`、`main.cpp:463-633` 无该键）。

| 键 | 读取位置 | 作用 | 缺省 |
|---|---|---|---|
| `configFile` | main.cpp:443 | Connector 配置；**缺失直接 exit(1)** | 无（必填） |
| `logFile` | main.cpp:437 | Logger 文件名 | `TradeBotStrategy` |
| `controlFile` | main.cpp:638 | 单策略控制文件 | 无 |
| `controlList` | main.cpp:644 | 多策略控制文件清单（OptionManage） | 无 |
| `paramFile` | main.cpp:663 | Regress 参数文件 | 无 |
| `strategyID` | main.cpp:702 | 写入 `RequestMsg.StrategyID`、pid 文件、daily_init 名 | 0 |
| `refStrategyID` | main.cpp:720 | 仅存进 `ConfigParams` | 0 |
| `printMode` | main.cpp:463 | 日志级别门控（`<2/<3/<4`） | -1（全打） |
| `updateInterval` | main.cpp:468 | 行情陈旧判定阈值，**单位秒**，内部 ×1e9 | 120 s |
| `selfBook` / `selfTrade` | main.cpp:474/483 | 自成交撮合/自簿 | false |
| `fillReject` | main.cpp:490 | 撤单拒绝且量为 0 时按成交处理 | false |
| `squareOff` | main.cpp:498 | 启动即平仓模式（见 §5.5） | false |
| `endPkt` | main.cpp:519 | 用 endPkt 作为指标/回调边界 | false |
| `useInvisibleBook` | main.cpp:525 | 报价按 tick 外推 | false |
| `useCMESmartBook` / `useBrazilSmartBook` | main.cpp:532/539 | 交易所专有簿 | false |
| `useDSTShift` | main.cpp:548 | 读 `../data/DSTFile` 调时间 | false |
| `adjustLTP` | main.cpp:557 | CME 用 LTP 修簿 | false |
| `crossBook` / `crossBookEnd` / `crossBook2` | main.cpp:564/571/578 | 跨合约簿 | false |
| `commonBook` | main.cpp:585 | 同账户多进程共享簿 + 放开回报过滤 | false |
| `optionStrategy` | main.cpp:592 | 1=组合期权，2=另一种 | 0 |
| `sweepStrategy` | main.cpp:601 | 扫单模式 | false |
| `deltaStrategy` | main.cpp:608 | Delta 加权目标价 | false |
| `optionParams` | main.cpp:615 | 期权参数文件 | `../data/OptionsParams` |
| `dateFile` / `startDate` / `endDate` | TradeBotUtils.cpp:2598 | 回测日期 | Live 用当天 |
| `startTime` / `endTime` | TradeBotUtils.cpp:2598 | 仅 Regress/LeadLag 用；Live/Sim 用 control 文件里的时间 | — |
| `outputFile` | main.cpp:956 | Regress 指标输出 | `../data/dataDumpFile` |
| `regressTime` / `regressL1Event` / `regressTrade` | TradeBotUtils.cpp:2714 | 回测打印节奏 | — |
| `getTicker` | main.cpp:1069 | 只打印 TICKERS 后 `return 0`（自检用） | — |
| `parallelSim` | main.cpp:1081 | `INTERACTION_MODE=PARALLELSIM` | — |
| `shmKey` | main.cpp:1122 | 覆盖 SimConfig 的 SHMKEY | — |

`argc==1` 时打印示例命令并 `return 1`（V: `main.cpp:396-401`）。示例命令本身已经过时（含 `--regressTime` 等），不要照抄。

### 1.3 启动顺序（按代码执行序）

| # | 步骤 | 代码 | 失败行为 |
|---|---|---|---|
| 1 | 打印版本、校验 argc、解析模式 | main.cpp:394-413 | `return 1/-1` |
| 2 | 解析全部 `--key value` | main.cpp:416 | `return -1` |
| 3 | 读 `logFile`、`configFile`，`cfg.LoadCfg()` | main.cpp:437-455 | 无 configFile → `exit(1)` |
| 4 | `Logger::InitLogger(STRATEGY, TO_FILE, logFile, "", true, false, false)` | main.cpp:457-461 | 日志目录不存在则静默失败（I） |
| 5 | 解析 30+ 个布尔/数值开关 | main.cpp:463-633 | 未知键静默忽略 |
| 6 | `LoadControlFile()` 或 `LoadControlList()` 或 `LoadParamFile()` | main.cpp:635-667 | 文件打不开 → `exit(1)` |
| 7 | `Watch::CreateUniqueInstance(0)`：行情时钟从 0 开始 | main.cpp:669 | — |
| 8 | `new CommonClient()`（构造为空实现） | main.cpp:670 | — |
| 9 | 逐策略：`LoadDateConfig` → `LoadModelFile` → `LoadDateConfigEpoch` → `LoadPrintStats` → basket/NN 初始化 → `new CalculatePNL` | main.cpp:671-700 | 模型/合约/fee 缺失 → `exit(1)` |
| 10 | `strategyID`/`refStrategyID`；Live 下追加写 `./pid/pid.<date>` | main.cpp:702-725 | `./pid` 不存在则静默不写（`ofstream` 打开失败） |
| 11 | 判定 `strategyType`（1=普通，2=Basket） | main.cpp:727-730 | — |
| 12 | **策略工厂** if/else 构造策略对象 | main.cpp:732-946 | 未知 token → `exit(1)` |
| 13 | `OptionManager::PortfolioGreeks()`（仅 `optionStrategy!=0`） | main.cpp:949-952 | — |
| 14 | 汇总 `interestlist`/`TICKERS`/`TICKERS_10LEN`，用 config 的 `ACCOUNT` 覆盖策略账户 | main.cpp:968-1014 | `interestlist[50][50]` 无越界检查（见 §7） |
| 15 | `--squareOff` 时预置 `m_netpos`/`m_buyTotalQty`/`m_sellTotalQty` | main.cpp:1016-1053 | 见 §5.5 |
| 16 | `client->Initialize(...)`：注册 4 个回调、屏蔽信号、加载交易簿 | main.cpp:1056、CommonClient.cpp:143-192 | — |
| 17 | 写 `INTERACTION_MODE`、`TICKERS_FOR_ORS`、`RESPONSE_FILTER_TYPE` | main.cpp:1076-1097 | — |
| 18 | `ConnectorConfig::init(cfg)` | main.cpp:1101-1104 | 缺 section/key → `Configfile::getStringStrict` 抛异常 → `terminate`（V: `configreader.h:458-470`） |
| 19 | 指标绑定 `setIndex(i)` | main.cpp:1130-1137 | — |
| 20 | `new Connector(md_cb, ors_cb, mode, cfg)`：挂 SHM 队列 | main.cpp:1139-1146、connector.cpp:60-200 | 队列不存在 → `assert(0)`/抛异常 |
| 21 | 建立 `symbolID → simConfigList` 映射 | main.cpp:1148-1167 | 见 §7 的 100 槽问题 |
| 22 | `StartAsync()` | main.cpp:1169-1181 | Live 下起轮询线程后立即返回 |
| 23 | `HandleSignals(&Squareoff)`：`sigwait` 死循环 | main.cpp:1184、CommonClient.cpp:227-255 | 永不返回 |

**关键点**：第 22 步之后主线程只做信号等待，所有业务逻辑都在 Connector 那一个线程里。因此"策略线程"这个概念在 tbsrc 里不存在 —— 复刻时不要引入工作线程池去"加速"，会立刻引入数据竞争。

### 1.4 配置 / 控制 / 模型 / 日初数据：到底加载了什么

#### (a) Connector 配置 `config/config_CHINA.<sid>.cfg`

样例：`data_cpp/bin/config/config_CHINA.92201.cfg`（23 行，含 2 处空行）。

```ini
INTERACTION_MODE = LIVE
DATA_FORMAT_ENGINE = TBTMode
XSIM_CONFIG_PATH = ../SimConfig/SimConfig.cfg      # 只有 Sim 用
MONITORSHMKEY = 789
MONITORSHMSIZE = 1024
PRODUCT = AG
EXCHANGES=CHINA_SHFE
[CHINA_SHFE]
MDSHMKEY           = 4097
ORSREQUESTSHMKEY   = 8193
ORSRESPONSESHMKEY  = 12289
CLIENTSTORESHMKEY  = 16385
MDSHMSIZE = 2048 / ORSREQUESTSHMSIZE = 1024 / ORSRESPONSESHMSIZE = 1024
```

- `PRODUCT`、`MONITORSHMKEY`、`MONITORSHMSIZE` 由 `getStringStrict` 读取，**缺一个就抛异常**（V: `ExecutionStrategy.cpp:95-98`、`configreader.h:458-470`）。
- 每个交易所 section：`ORSREQUESTSHMKEY/ORSREQUESTSHMSIZE/ORSRESPONSESHMKEY/ORSRESPONSESHMSIZE/CLIENTSTORESHMKEY` 五个走 strict；`MDSHMKEY/MDSHMSIZE` 走 `getStringList`（**缺失只是空列表，不会报错**，表现是"进程正常但收不到行情"）（V: `connectorconfig.h:292-340`）。
- `MDSHMSIZE` 等值原样传给 SHM 队列构造函数，**不做单位换算**（V: `connectorconfig.h:292-301`）。单位与最小值必须与 ORS 侧一致，否则启动即失败或读到垃圾；这一项留给 `03` 交叉验证。
- 顶层 `ACCOUNT` 若存在，会**覆盖** `StrategyConfig.cfg` 的账户（V: `main.cpp:1008-1012`）。

#### (b) 全局策略配置 `config/StrategyConfig.cfg`

样例只有 4 行（V: `data_cpp/bin/config/StrategyConfig.cfg:1-4`）：

```ini
ACCOUNT=OWN
MAX_POS_SIZE=1000
MAX_ORDERS=5000
LOGGER_THREAD_CPU_AFFINITY=0
```

读取位置 `ExecutionStrategy.cpp:59-70`，缺省值在 `:16-19`（`MAX_POS_SIZE=10000000`、`MAX_ORDERS=5000000000`）。可选 `DSN`（`:69`）用于 pair 策略写库。

**这是全局文件，不是每策略文件**：tbadmin 每次同步策略都会重写 `bin/config/StrategyConfig.cfg`（V: `tbadmin/admin.cpp:1849-1855`）。因此所有 TradeBot 进程共享同一份 `ACCOUNT`/`MAX_POS_SIZE`/`MAX_ORDERS`/`DSN`；最后一次同步的值生效。DSN 内含数据库凭据，本文不复制其值，只记录"它被写进这个文件"这一事实（V，安全影响见 `08`）。

#### (c) 控制文件 `controls/<session>/control.*.par.txt.<sid>`

解析器 `LoadControlFile()`（V: `TradeBotUtils.cpp:1902-1947`）：

```text
字段: baseName  modelFile  exchange  id  execStrat  startTime  endTime  [instrument2]  [exchange2]
```

- 少于 7 个 token → `exit(1)`。
- 恰好 8 个 token → `pairStrat=true`，第 8 个是第二腿。
- 多于 8 个 token → 第 9 个是第二腿交易所。
- `startTime`/`endTime` 是 **UTC HHMM**（例：`0100 0700` = 北京 09:00–15:00；`1300 1830` = 北京 21:00–02:30）。V: `data_cpp/bin/controls/day/control.ag2606.ag2608.par.txt.92201`、`.../night/...`；时间换算见 `Watch.cpp:46-64` 的 `- timezone`。
- `pairStrat` 是**全局变量**，一旦某个 control 带 8 个 token，后续所有 control 都会被当成 pair（V: `TradeBotUtils.cpp:1935-1943`、文件头 `:217` 附近）。当前每个 control 都显式写 8 个 token，所以无感；复刻时改成 per-config 字段。

`LoadControlList()` 逐行读清单，每行只取第 1 个 token 当 control 路径（V: `TradeBotUtils.cpp:1889-1899`），并把 `m_strategyCount` 设为行数。

#### (d) 模型文件 `models/model.*.<sid>`

`LoadModelFile()` 是启动期最复杂的一段（V: `TradeBotUtils.cpp:2065-2380`）。两种行：

```text
指标行（>2 token）:  <baseName> <type> <indName> <arg1> <arg2> ...   例: ag_F_6_SFE FUTCOM Dependant 0 MID_PX
阈值行（<=2 token）:  <KEY> <VALUE>                                  例: MAX_QUOTE_LEVEL 3
注释行: # 开头；特殊形式 #DEP_STD_DEV/#LOOKAHEAD/#TRGT_STD_DEV/#STD_x 有专门分支
```

行为：
- 第一行指标行的 `m_coefficient` 若为 0，会被记成 `ConfigParams::signalInd`（V: `:2274-2275`）。
- 指标工厂 `GetIndicator()` 是 200+ 个 `strcmp` 分支（V: `TradeBotUtils.cpp:506-1870`），未识别 → `exit(1)`（`:1863-1866`）。
- `MAX_QUOTE_LEVEL` 会抬高 `instru->m_level`（V: `:2293-2294`）。
- 文件末尾调 `LoadTCost2()` 读 `/home/hft/tbdata/fee.csv`，缺失 `exit(1)`（V: `:2379`、`:2460-2469`）。

`LoadThresholds()` 是 `SIGUSR2` 热重载用的简化版：只重读阈值行，**不重建指标**，也**不重新做** `MAX_PRICE/MIN_PRICE *= priceFactor`（对比 `ExecutionStrategy.cpp:60-61`）。所以热重载与重启不等价（V，详见 §7）。

#### (e) 合约静态数据

`AddInstrument()` → `Instrument::FillInstrument()` → `FillContractSpecs()`：

- 打开 `/home/hft/tbdata/contractfile`（V: `Instrument.cpp:1575`），缺文件 `exit(1)`（`:1578-1581`）。
- 从行里取 `tickSize / lotSize / exchange / type`（V: `:1593-1602`）。
- 按交易所决定 `m_priceFactor`、`m_sendInLots`、`m_bSnapshot`、`m_bUseAvgTradePrice` 等（V: `:1604-1674`）。**这些开关直接决定"数量单位是手还是股"**，是复刻时最容易搞错的一处。
- `m_priceMultiplier = (m_sendInLots ? m_lotSize : 1) * m_contractFactor / m_priceFactor`（V: `:428-431`）。
- `tickSize/lotSize` 仍为 -1 → `exit(1)`（V: `:1676-1680`）。

#### (f) 持仓/日初数据（启动期读取，缺失即失败或静默 0 仓）

| 文件 | 使用方 | 缺失行为 | 证据 |
|---|---|---|---|
| `../data/daily_init.<sid>` | `TB_PAIR*` | `exit(-1)` | `PairwiseArbStrategy.cpp:24-54` |
| `../position/<sid>`（CSV） | `TB_MMF_PASSIVE_STRAT` / `_CLOSE_` | 警告 + 0 仓 | `MMFPassiveStrategy.cpp:247-266` |
| `../position/<sid>`（KEY=VALUE） | `TB_PASSIVE_HEDGING*` / `TB_SIMPLEHEDGING_STRAT` / `TB_TWAP_STRAT` | **`exit(-1)`**（行数 ≤3） | `PassiveHedgingStrategy.cpp:555-560`、`:636-650` |
| `../data/OptionsParams[.<sid>]` | 期权策略（**仅 SIGUSR2 重载时**） | `ConfigfileTB` 打不开 → 在信号处理器里 `exit(1)` | `OptionManager.cpp:7-12`、`ConfigfileReader.cpp:25-32`、`main.cpp:169-178` |

详见 §5.4。

### 1.5 SHM / Connector 初始化

`Connector` 构造函数按 `INTERACTION_MODE` 分支（V: `connector.cpp:60-200`）：

```text
LIVE / INSTINETLIVE : initClientStore(CLIENTSTORESHMKEY)
                      registerMDClient(MDSHMKEY, MDSHMSIZE)          // 可多个
                      registerResponseClient(ORSRESPONSESHMKEY, ...)
                      registerRequestClient(ORSREQUESTSHMKEY, ...)   // 分配 clientId
                      connectWithParam(HandleUpdates / HandleOrderResponse)
SIMULATION / PARALLELSIM / PEEK : 只建 ExchSim，不碰 ORS SHM
PAPERTRADING / SANITYCHECKSHM   : 只读 MD SHM
```

- `clientId = clientStore.getClientIdAndIncrement()`，client store 是一个 SHM 里的原子计数器（V: `shmmanager.h:512-516`、`shmlocklessclientstore.h:78-84`），上限 `MAX_ORS_CLIENTS = 250`（V: `orderresponse.h:17`），实际到 249 就抛 `IpcException`（V: `shmmanager.h:577-596`）。**每个交易所、每次进程启动消耗一个 id 槽**；耗尽后进程起不来。
- 行情线程与回报线程：默认 `ASYNC_MD_AND_RESPONSE=false` → `startMonitorAsyncMarketDataAndResponse()` 起**一个**线程，循环 `loopMD(); loopResponse();`（V: `shmmanager.h:758-783`、`connectorconfig.h:85`）。设成 true 会拆成两个线程 —— 那会破坏 §4 依赖的单线程不变量，**不要开**。
- `HandleUpdates()` 只把配置里 `TICKERS` 命中的 symbol 往上送，并回填 `symbolID`（V: `connector.cpp:752-784`）；`TICKERS` 是 main.cpp 根据 model 文件里的合约自动拼出来的（V: `main.cpp:982-1007`、`:1060-1067`），不需要手工维护。
- `HandleOrderResponse()` 的默认过滤是 `STRATEGY_FILTER`：`clientId = msg->OrderID / 1000000`，只把属于自己的回报往上送（V: `connector.cpp:825-846`、`constants.h:14`）。`--commonBook` 会改成 `TICKERS_ON_ONE_ACCOUNT_FILTER`（按账户+合约，**会看到别人的单**）（V: `main.cpp:1094-1096`、`connectorconfig.h:229-237`）。

### 1.6 信号与运行期控制

`Initialize()` 在 Live/Sim 下调用 `BlockSignals()`：`sigfillset` + `pthread_sigmask(SIG_BLOCK)`（V: `CommonClient.cpp:170-173`、`:1160-1172`）。随后主线程 `sigwait`，把信号转给 `Squareoff(int32_t)`（V: `CommonClient.cpp:227-246`、`main.cpp:106-181`）。

| 信号 | 语义 | 代码 | 注意 |
|---|---|---|---|
| `SIGTSTP`（20） | 平仓 + 停用（tbstop） | main.cpp:142-149 | 会真平仓；若持仓与 ORS 不一致，平仓单可能被标成开仓 |
| `SIGUSR1`（10） | 激活（tbstart） | main.cpp:150-159 | 清 `m_onExit/m_onCancel/m_onFlat`，`m_Active=true`，调 `HandleSquareON()` |
| `SIGUSR2`（12） | 热重载 model 阈值（tbreload） | main.cpp:169-178 | 只重读阈值行；`MIN/MAX_PRICE` 不再乘 `priceFactor` |
| `SIGTERM`（15） | 仅对 `./config/signal.txt` 列出的 contract 平仓 | main.cpp:110-149 | 文件缺失 → 打日志后 `return`，**什么都不做**；进程也不退出 |
| `SIGRTMIN`（34） | **激活** `signal.txt` 列出的合约 | main.cpp:110,150-159 | 与 SIGUSR1 同分支；不是平仓 |
| `36` = SIGRTMIN+2 | 单合约激进平仓（`m_aggFlat=true`） | main.cpp:160-168 | 仍受 signal.txt 过滤（只平列出的合约） |
| `37` = SIGRTMIN+3 | 整组激进平仓 | main.cpp:160-168 | 不看 signal.txt |

`Squareoff()` 遍历 `configParams->m_strategyCount`，对每个 `simConfig[i].m_execStrategy` 置标志并调用 `HandleSquareoff()`/`HandleSquareON()`（V: `main.cpp:130-180`）。

生产脚本：
- `tbstart`/`tbstop`/`tbreload` → `scripts/ops_tb_signal.sh`，按 `/proc/<pid>/cmdline` 精确匹配 `--strategyID <id>` 再 `kill -USR1/-TSTP/-USR2`（V: `ops_tb_signal.sh:82-131`）。
- 停止用 `kill -TERM` 然后等 10 秒 `pkill -9`（V: `build_deploy_cpp.sh:683-695`）。**因为 SIGTERM 不平仓，这个脚本等于"直接杀"**；要平仓必须先 `tbstop`。

### 1.7 生命周期与关闭

```text
[启动] → 加载 → 构造策略(m_Active=false) → 挂 SHM → 轮询线程
   ↓
[SIGUSR1] m_Active=true → 开始报价
   ↓
[盘中] 每 tick: 指标→目标→下单；每 tick 后: PnL/限额检查
   ↓
[收盘前3min] m_onExit/m_onCancel/m_onFlat=true → 撤单+平仓
[收盘前1min] m_aggFlat=true → 对手价+1tick 激进平仓
   ↓
[净仓=0 且无挂单] m_Active=false（进程仍在，等下一个信号或被杀）
   ↓
[kill -9] 进程消失（无 atexit、无 flush、无状态落盘）
```

- **没有优雅退出路径**：`HandleSignals` 是死循环，只有 `ORDERS_PER_DAY_LIMIT_REJECT` 会 `exit(1)`（V: `ExecutionStrategy.cpp:1141-1146`），Regress 结束会 `exit(1)`（V: `CommonClient.cpp:253`）。
- 因此**进程内状态（挂单表、netpos、PnL）在 kill 时全部丢失**，除了 pair 策略在 `HandleSquareoffNow()` 里写过一次的 `daily_init.<sid>`。
- `Watch` 的时钟是**行情驱动**的：`UpdateTime` 只在 `t_time > current_time_` 时前进（V: `Watch.cpp:27-37`）。**行情停了，策略的"现在"也停了** —— 所有基于 `GetCurrentTime()` 的收盘/超时判断都不会触发。

### 1.8 启动期已知缺陷（都能在启动 10 秒内观察到）

| 现象 | 原因 | 证据 |
|---|---|---|
| 启动即 abort，无日志 | config 缺 `PRODUCT`/`MONITORSHMKEY`/`MONITORSHMSIZE` 或某交易所 section 缺 key → `getStringStrict` 抛 `""`，main 无 try/catch | V: `ExecutionStrategy.cpp:95-98`、`configreader.h:458-470`、`main.cpp:1058`（`// try` 被注释） |
| `exit(1)` + "Error in opening Contract File" | 缺 `/home/hft/tbdata/contractfile` | V: `Instrument.cpp:1575-1581` |
| `exit(1)` + "Error in opening Transaction Charges File" | 缺 `/home/hft/tbdata/fee.csv` | V: `TradeBotUtils.cpp:2463-2469` |
| pair 策略 `exit(-1)` + "daily_init ERROR" | 缺 `../data/daily_init.<sid>` 或缺列 | V: `PairwiseArbStrategy.cpp:24-54` |
| 策略起来但一单不发 | Live 模式未 `tbstart`（`m_Active=false`） | V: `ExecutionStrategy.cpp:389-392` |
| 策略起来但一单不发（另一种） | `IndicatorCallBack` 只在 `m_dateConfig.m_simActive` 为真时跑；控制文件时间窗之外全是静默 | V: `main.cpp:323-327`、`CommonClient.cpp:463` |
| 进程在，日志不动 | 行情断了；`Watch` 时钟冻结，且 `CheckLastUpdate` 也依赖"收到下一条行情"才会执行 | V: `Watch.cpp:32-37`、`CommonClient.cpp:360-364` |
| 进程正常、订单正常、但**永远没有行情** | config 的 `MDSHMKEY` 拼错/缺失不会报错（`getStringList` 返回空） | V: `connectorconfig.h:292-301`、`connector.cpp:84-90` |
| `--squareOff 1` 段错误 | 没有 `--controlList` 时 `iter` 是 `end()` 仍被 `sprintf("%s", iter->second.c_str())` 解引用；且 `../scripts/squareoffcontrols.sh`、`../models/model.squareoff.list` 在仓库中不存在 | V: `main.cpp:644-656`；文件不存在见 `find` 结果 |

---

## 2. 策略层

### 2.1 类契约

`ExecutionStrategy`（`tbsrc/Strategies/include/ExecutionStrategy.h:32-327`，实现 `ExecutionStrategy.cpp` 2529 行）是所有策略的基类。构造函数签名统一为：

```cpp
ExecutionStrategy(CommonClient *client, SimConfig *simConfig);
```

构造期做的事（V: `ExecutionStrategy.cpp:20-135`）：

1. 保存 `m_client/m_simConfig/m_instru`（若 `m_bUseArbStrat` 再取 `m_instru_sec`）。
2. `m_strategyID = ConfigParams::m_strategyID`（全局，来自 `--strategyID`）。
3. 由 `m_dateConfig.m_endTime` 算出两个收盘闸门：
   - `m_endTimeEpoch = 收盘 - 180s`（撤单+平仓）
   - `m_endTimeAggEpoch = 收盘 - 60s`（激进平仓）
   （V: `:44-47`）
4. 读 `./config/StrategyConfig.cfg` → `m_account`、`m_maxPosSize`、`m_maxOrderCount`、`m_dsn`、`m_maxTradedQty`（V: `:65-70`）。
5. `Reset()`（V: `:78`、`:289-408`）。
6. 读 `PRODUCT`/`MONITORSHMKEY`/`MONITORSHMSIZE`，`new tbadmin::memlog(...)`（V: `:93-126`）。
7. 首次上报 `STRATEGY_STATUS` + `POSITION`（pair 系跳过，由子类自己发；V: `:127-134`）。

**纯虚函数只有一个**：`virtual void SendOrder() = 0;`（V: `ExecutionStrategy.h:41`）。这就是"策略"的全部语义：*在给定目标价与阈值下，决定发什么单*。

可覆写的钩子：

| 钩子 | 基类行为 | 典型覆写 |
|---|---|---|
| `SendOrder()` | 纯虚 | 所有策略 |
| `MDCallBack(up)` | 脏簿过滤 → 更新 `m_ltp`/时间戳 → 变价才 `CalculatePNL()` → `CheckSquareoff()` → 可选 `SetQuantAhead()`/成交量均值 | Pair 系重写以驱动两腿 + 价差校验（`PairwiseArbStrategy.cpp:831-905`） |
| `ORSCallBack(resp)` | 查 `m_ordMap` → 按 `Response_Type` 分发到 Process* | Pair 系重写以按 `ordMap1/ordMap2` 分流 + 停止态处理（`:504-631`） |
| `AuctionCallBack(up)` | 仅 BOVESPA + Live 时平仓 | 无其他覆写（grep 只有 RepoTrade 空实现） |
| `HandleSquareoff()` | `m_onExit` 语义的平仓 | Pair 系改为"先看 exposure"（`:1024-1037`） |
| `HandleSquareON()` | 上报状态 | Pair 系同时清两腿标志（`:1009-1022`） |
| `SetTargetValue()` | 存目标价 → 拒单告警 → 120s 心跳 → `SendOrder()` | 无 |
| `SetThresholds()` / `SetLinearThresholds()` | 把 model 阈值换算成"发单价差" | Pair 系按价差重算（`:1248-1293`） |

### 2.2 共享 vs 覆写：责任边界

| 关注点 | 归属 | 说明 |
|---|---|---|
| 订单表/状态机/撤改拒 | **基类** | 所有策略共用一套 `SendNewOrder/SendCancelOrder/SendModifyOrder` + `Process*` |
| 成交入账、netpos、PnL、手续费 | **基类** | `ProcessTrade()` / `CalculatePNL()` |
| 限额检查（时间/亏损/单数/成交量/拒单） | **基类** | `SetTargetValue()` + `CheckSquareoff()` |
| 收盘平仓、信号平仓 | **基类** | `HandleSquareoff()` / `HandleTimeLimitSquareoff()` |
| 监控上报（memlog） | **基类** | 5 种 `SendMonitorStrat*` |
| 目标价计算 | **基类 + `CalculatePNL`** | 指标线性组合，见 §3.1 |
| 报价价差/挂撤逻辑 | **子类** | `SetThresholds()` + `SendOrder()` |
| 多腿编排 | **子类**（Pair 系 + `ExtraStrategy`） | 见 §2.4 |

这个切分是这套系统最值得复刻的部分：**执行/记账/风控在基类，alpha 在子类**。缺点是基类把"单合约、双边报价"写进了 DNA（价格主键、`m_instru` 单数），多腿只能靠组合对象绕过。

### 2.3 策略工厂：47 个 `strcmp` 分支

`main.cpp:732-946` 是一个平铺的 if/else 链，键是 control 文件第 5 个 token（`m_execStrat`），值是一个 `new`。共 **47 个 `strcmp` 分支 = 46 个真实策略 + `NO_STRAT`**（V: 逐行统计 `main.cpp:737-934`）。

| token | 类 | token | 类 |
|---|---|---|---|
| `TB_PASSIVE_STRAT` | PassiveStrategy | `TB_PAIR_STRAT` | PairwiseArbStrategy |
| `TB_PASSIVE_STRAT_NEW` | PassiveStrategyPNL | `TB_PAIR_MN_STRAT` | PairwiseArbStrategyMN |
| `TB_PASSIVE_STRAT_AE` | PassiveStrategyAE | `TB_PAIR_CFFEX_STRAT` | PairwiseArbStrategyCffex |
| `TB_BONDS_PASSIVE_STRAT` | BondsPassiveStrategy | `TB_PAIR_CSO_STRAT` | PairwiseArbCSOStrategy |
| `TB_COMMS_STRAT` | CommsPassiveStrategy | `TB_PAIR_MN_CSO_STRAT` | PairwiseArbCSOStrategyMN |
| `TB_DEP_PASSIVE_STRAT` | DepPassiveStrategy | `TB_PAIR_ETF_STRAT` | PairwiseArbETFStrategy |
| `TB_DEP_AGGPASS_STRAT` | DepAggressivePassiveStrategy | `TB_PAIR_OPT_STRAT` | PairwiseArbStrategyOpt |
| `TB_AGGRESSIVE_STRAT` | AggressiveStrategy | `TB_PAIR_TEST_STRAT` | PairwiseArbTestStrategy |
| `TB_AGGRESSIVEPASSIVE_STRAT` | AggressivePassiveStrategy | `BUTTERFLY_STRAT` | ButterflyStrategy |
| `TB_IND_AGGRESSIVE_STRAT` | AggressiveStrategyInd | `TB_TARGET_STRAT` | TargetStrategy |
| `TB_SIMPLEAGGRESSIVE_STRAT` | SimpleAggressiveStrategy | `TB_SPREAD_STRAT` | SpreadStrategy |
| `TB_HIT_STRAT` | HitStrategy | `VWAP_STRAT` | VWAPStrategy |
| `TB_DIME_STRAT` | AntiDimeStrategy | `TB_TWAP_STRAT` | TwapStrategy |
| `TB_FAK_STRAT` | FAKStrategy | `LATENCY_STRAT` | LatencyStrategy |
| `TB_EQ_QUOTE_STRAT` | EquityQuotingStrategy | `TB_OPTION_QUOTING_STRAT` | OptionQuotingStrategy |
| `TB_MODIFY_STRAT` | ModifyStrategy | `TB_HEDGING_STRAT` | HedgingStrategy |
| `TB_SWEEP_STRAT` | SweepStrategy | `TB_SIMPLEHEDGING_STRAT` | SimpleHedgingStrategy |
| `TB_UNIFORM_STRAT` | UniformStrategy | `TB_SUPPTAIL_STRAT` | SuppTailStrategy |
| `TB_RETAGG_STRAT` | AggReturnStrategy | `TB_PASSIVE_HEDGING_STRAT` | PassiveHedgingStrategy |
| `TB_MOVINGStd_STRAT` | MovingStdStrategy | `TB_PASSIVE_HEDGING_ETF_STRAT` | PassiveHedgingETFStrategy |
| `TB_DYNAMIC_STDEV_STRAT` | DynamicStdevStrategy | `TB_MMF_PASSIVE_STRAT` | MMFPassiveStrategy |
| `TB_DELAY_TEST` | DelayTest | `TB_MMF_PASSIVE_CLOSE_STRAT` | MMFPassiveStrategyClose |
| `DUMMY_STRAT` | DummyStrategy | `TB_REPO_STRAT` | RepoTrade |

工厂之后：`simConfig[i].m_execStrategy = Strategy;`（V: `main.cpp:944`）。

**两个必须在复刻时改掉的工厂缺陷**：

1. `strategyType==2`（第一行指标名是 `Basket`）时，`else {}` 是空的 → `Strategy` 保持 `NULL`（V: `main.cpp:727-730`、`:941-943`）。而 `MDcallback` 对 `strategyType==2` 走 `MultiInstruStrategy`，该全局指针**从未被赋值**（V: `main.cpp:87`、`:265-268`）。结论：**Basket 模型在当前代码里是死路径**，会得到一个永远不下单、且把回报丢进空 `m_orderIDStrategyMap` 的进程。
2. 未知 token 直接 `exit(1)`（V: `main.cpp:935-939`），没有"加载策略插件失败但继续跑其它策略"的容错；配合"一策略一进程"这没问题，在 OptionManage 容器里就是整容器起不来。

### 2.4 复合策略：`ExtraStrategy` 承担"腿"

`PairwiseArbStrategy` 自己不是双边报价者，而是**两腿的编排器**（V: `PairwiseArbStrategy.cpp:9-134`）：

```cpp
m_firstStrat  = new ExtraStrategy(client, simConfig);   // 腿1
m_secondStrat = new ExtraStrategy(client, simConfig);   // 腿2
m_secondStrat->m_instru = m_secondStrat->m_instru_sec;  // 换合约
m_ordMap1 = &m_firstStrat->m_ordMap;  m_ordMap2 = &m_secondStrat->m_ordMap;
```

`ExtraStrategy : public ExecutionStrategy`（V: `include/ExtraStrategy.h:6`）覆写了 `SendNewOrder/SendModifyOrder/SendCancelOrder/SendBidOrder/SendAskOrder`，把 `m_instru` 变成**每次调用传入的参数**（V: `ExtraStrategy.cpp:205-260`）。于是：

- 每腿有**独立的** `m_ordMap`、`m_bidMap`、`m_netpos`、`m_buyTotalQty`、PnL、拒单计数。
- 三个对象（parent + 2 legs）各自 `new` 一个 `tbadmin::memlog`，指向同一段 SHM（V: `ExecutionStrategy.cpp:120-126`）。构造期基类因 `m_bUseArbStrat` 跳过上报（`:129`），由 `PairwiseArbStrategy` 构造函数补发 **1 条 STRATEGY_STATUS + 2 条 POSITION（每条腿一条）**（V: `PairwiseArbStrategy.cpp:126-128`）。之后的成交回报也只由 parent 上报两腿仓位（`:585-605`）。
- 订单在 `m_orderIDStrategyMap` 里注册的是 **ExtraStrategy 指针**，但 main 因为 `useArbStrategy=1` 把**所有回报都送给 parent**（V: `main.cpp:284-287`、`main.cpp:859-898`），parent 再按 `ordMap1/ordMap2` 分流（V: `PairwiseArbStrategy.cpp:563-606`）。`m_orderIDStrategyMap` 对 pair 来说是死数据。
- 腿的 PnL 互相独立；组合盈亏要自己加（`Exposure()`/`UpdateNetPnl()`，V: `:633-638`、`:1410-1438`）。

`PairwiseArbStrategyMN` 结构相同，只是多了 `m_size_ratio`、`m_leg1_multi/m_leg2_multi` 与"二腿可拆"的对冲逻辑（V: `PairwiseArbStrategyMN.h:66-105`）。

### 2.5 加一个策略：需要动什么

最小改动集（按当前代码结构）：

1. 新增 `tbsrc/Strategies/MyStrategy.cpp` + `tbsrc/Strategies/include/MyStrategy.h`，继承 `ExecutionStrategy`，实现 `SendOrder()`；需要的话覆写 `SetThresholds/MDCallBack/ORSCallBack/HandleSquareoff`。
2. `tbsrc/main/main.cpp` 顶部 `#include "MyStrategy.h"`（`:20-72` 区）。
3. 在工厂链里加一个 `else if (!strcmp(..., "TB_MY_STRAT")) Strategy = new MyStrategy(client, simConfig + i);`（`:732-946`）。
4. 编译：CMake 用 `file(GLOB SRCS ... Strategies/*.cpp)`（V: `tbsrc/CMakeLists.txt:41-52`），新文件自动进构建；Makefile 用 `../Strategies/*.o` 通配（V: `tbsrc/main/Makefile` LDFLAGS 行）。
5. 新增 control 文件：`controls/<session>/control.<任意名>.<sid>`，第 5 个字段写 `TB_MY_STRAT`。
6. 新增 model 文件：至少一行 `<base> <type> <indName> <args...>` + 需要的阈值。
7. 新增 `config/config_CHINA.<sid>.cfg`（可直接复制同交易所的样例，只改 `PRODUCT`/`MONITORSHMKEY`/SHM key）。
8. 若要用 `MAX_POS_SIZE`/`ACCOUNT` 之外的东西，确认 `StrategyConfig.cfg`（全局）里的值符合预期。

**不需要改**：Connector、CommonClient、TradeBotUtils、CMake 源列表、main 的参数解析。这就是这套设计的扩展点。

**注意事项**：
- 新策略如果走"多腿"，必须自己保证 `useArbStrategy` 被置 1（当前是在工厂分支里手写的，V: `main.cpp:857/862/867/...`），否则回报会被 `m_orderIDStrategyMap` 路由到 `ExtraStrategy`，而 parent 永远收不到。
- 新策略如果在 `SendOrder()` 里直接 `m_client->SendNewOrder(...)` 而不经过 `ExecutionStrategy::SendNewOrder`，订单不会进 `m_ordMap`，回报会被丢弃（V: `ORSCallBack` 的 `find` 失败分支 `:976-985`）。
- 新策略的 `m_description` 必须自己 `memcpy` 填（很多策略忘了，见 §7）。

### 2.6 为什么这个工厂式设计重要

- **好处**：策略是编译期绑定的，没有动态库/反射/配置 schema；一个 token 就能上线，调试时直接看源码。
- **代价**：每加一个策略都在改 `main.cpp`（1187 行的巨型文件）；策略之间无法组合（除了手写 Pair 系）；所有策略共享同一套订单/风控语义，想改一个策略的风控就要改基类，影响全部。
- **复刻建议**：保留"基类执行/记账 + 子类 alpha"的切分，但把工厂换成注册表（`map<string, factory>`），把 `useArbStrategy` 变成策略自身的属性（`legs() > 1`），把 `PairwiseArb*` 的 8 个近亲合并成参数化实现。这三处是当前代码里重复度最高、最容易出错的地方（8 个 Pair 文件合计约 1.1 万行，逻辑 80% 相同）。

---

## 3. 热路径

### 3.1 MD → 指标 → 目标价 → 发单

```text
[Connector SHM 线程]
  loopMD()
   └ HandleUpdates(update)                     connector.cpp:752
      └ m_mdcb = CommonClient::SendInfraMDUpdate   CommonClient.cpp:322
         ├ update->m_endPkt==1 → (可选) m_INDCallBack + return     :343-358
         ├ 每 updateInterval 检查一次行情陈旧                         :360-364
         ├ UpdateTime(!m_bUseExchTS ? m_timestamp : m_exchTS)  ← 策略时钟 :413-416
         └ SendINDUpdate(update)                                  :402
            ├ m_dateConfig->UpdateActive(now)                    :417
            ├ simIter = m_simConfigList[update->m_symbolID]       :419
            ├ for each simConfig registered for this symbol:      :432
            │   ├ 不在本 simConfig 的 instruList → skip            :453-455
            │   ├ !m_simActive → skip（时间窗之外）                 :463
            │   ├ FEED_AUCTION → m_AuctionCallBack(update)        :465-468
            │   ├ totalTradedQty/firstTrade 过滤                    :494-503
            │   ├ lastTick.FillTick / FillOrderBook                :522-533
            │   ├ tickType==INVALID 或 optionStrategy&&level>1 → return :563-576
            │   ├ significantUpdate 判定（tickLevel > m_level）      :577-585
            │   ├ [optionStrategy / deltaStrategy 分支]             :616-747
            │   ├ Update(iter, tick) → 逐指标 QuoteUpdate/TickUpdate :750-763, :867-883
            │   ├ significantUpdate && !endPkt → m_INDCallBack(指标表) :776-787
            │   └ isStratSymbol → m_MDCallBack(update)             :789-790
            └ ...
[同一线程，紧接着]
  IndicatorCallBack(indicatorList)              main.cpp:323
   ├ 仅 Live/Sim/LeadLag 且 strategyType==1                 :364-366
   ├ CalculateTargetPNL(currPrice, targetPrice, bidPNL[], askPNL[])  :368
   └ 成功 → m_execStrategy->SetTargetValue(...)              :371
        └ if (!m_onFlat && m_Active) SendOrder()             :466-485
```

**顺序上的含义**（很重要）：

1. 指标回调**先于** `MDCallBack`。也就是说，`SendOrder()` 在 `CheckSquareoff()` 之前执行 —— 风控永远慢一拍。若本 tick 刚好触发 `MAX_LOSS`，这一 tick 还是会先发单再平仓（V: `CommonClient.cpp:776-790`）。
2. 目标价是"上一个 tick 的指标值 + 本 tick 更新后的指标"混合算出来的，因为 `CalculateTargetPNL` 用的是 `m_lastInstruMapIter`（最近一次 `Update()` 的合约）（V: `TradeBotUtils.cpp:4001`、`CommonClient.cpp:882`）。多腿策略靠这个机制让每个 tick 只更新"刚动的那条腿"的目标价。
3. `SetTargetValue` 只在 `CalculateTargetPNL` 返回 true 时被调用；返回 false 的条件是**任一指标 `Value(status)` 为 false**，或所有层的 bid/ask PnL 都 ≤ 0（V: `TradeBotUtils.cpp:4086-4095`、`:4204-4207`）。所以"指标没热身好 → 不下单"是设计行为，不是 bug。
4. **`MDCallBack` 只在"策略主合约"（`m_instru`）的 tick 上触发**：`isStratSymbol` 比较的是 `m_simConfig->m_instru->m_instrument`（V: `CommonClient.cpp:765-790`）。对 pair 策略，`m_instru` 是腿 1，所以 `CheckSquareoff()`（亏损/收盘/拒单检查）、pair 的价差校验、`EndTimeEpoch/EndTimeAggEpich` **只在腿 1 有行情时运行**；腿 2 的 tick 只触发指标 + `SendOrder()`。腿 2 行情长期不动时，pair 的风控实际上被冻结（I，由调用链直接推出）。

### 3.2 触发频率与三道门

| 门 | 条件 | 效果 | 证据 |
|---|---|---|---|
| 时间窗 | `m_dateConfig.m_simActive` | 窗口外整段 `SendINDUpdate` 直接跳过（含指标、回调） | `CommonClient.cpp:463`、`TradeBotUtils.h:612-623` |
| 显著性 | `instru->lastTick.tickLevel <= m_level` | 深度不足的更新不触发指标/回调（除 `sendAllUpdates`，DI1 特例） | `CommonClient.cpp:577-585`、`:177-184` |
| endPkt | `--endPkt 1` | 单条更新不触发，等 `m_endPkt==1` 时统一触发一次 | `CommonClient.cpp:343-358`、`:776` |
| 自簿/公共簿 | `--selfBook` / `--commonBook` | 会在指标前修改/短路订单簿 | `CommonClient.cpp:535-561` |
| 限价簿 | `m_optionStrategy && tickLevel>1` | 期权策略只要最优档 | `CommonClient.cpp:563` |

### 3.3 报价决策：`GetBidPrice` / `GetAskPrice`

以 `PassiveStrategy::SendOrder()` 为例（V: `PassiveStrategy.cpp:7-173`），这是所有被动报价策略的模板：

1. `SetThresholds()`（或 `SetLinearThresholds()`）把 `BEGIN_PLACE/LONG_PLACE/SHORT_PLACE/MAX_SIZE/...` 换算成当前净仓下的**四道价差**：`m_tholdBidPlace/m_tholdBidRemove/m_tholdAskPlace/m_tholdAskRemove`（V: `ExecutionStrategy.cpp:607-701`）。
2. 先撤"已经不该挂"的单：买单价差 ≥ `m_tholdBidRemove` → 撤；卖单同理（V: `PassiveStrategy.cpp:31-53`）。
3. 逐层（`MAX_QUOTE_LEVEL`）判断 `bidDiff > m_tholdBidPlace && targetBidPNL[level] > 0`（V: `:86`）。`targetBidPNL` 是"在该层买入、到目标价卖出"的**含费盈亏**（V: `TradeBotUtils.cpp:4180-4183`）。这是"只在有正期望时才报价"的核心。
4. `GetBidPrice()` 决定最终价格与订单类型（V: `ExecutionStrategy.cpp:1231-1315`）：
   - 默认取 `bidPx[level]`；
   - 若跨价差可盈利（`bidCross > place + CROSS` 且 `bidCrossPNL>0`）→ `ordType=CROSS`，价格 = `askPx[0]`（或 `CROSS_TICKS`/`CROSS_TARGET` 修正）；
   - 若在平仓且 `CLOSE_IMPROVE>0` → 按盘口比例改善，`ordType=IMPROVE`；
   - 若 `bidImprove > place + IMPROVE` 且前方有量 → 改善一 tick。
5. `SendBidOrder()` 做**数量裁剪**（净仓/上限/百分比），先 `SendCancelOrder(price, SELL)` 撤掉同价对手单，再 `SendNewOrder`（V: `:1317-1361`）。

`TargetStrategy` 是另一个极端：它不算价差，直接算出 `targetBid = bid0 + MAX_IMPROVE*tick`、`targetAsk = ask0 - MAX_IMPROVE*tick`（`MAX_IMPROVE` 未初始化，缺省为 0，见 §7.3 #35），只在 `buyPNL/sellPNL > 0` 时挂；有仓时只挂平仓方向（V: `TargetStrategy.cpp:7-222`）。适合"只想成交、不想做市"的场景。

### 3.4 回报路径：confirm / trade → 订单表 / 仓位 / PnL

```text
loopResponse()
 └ Connector::HandleOrderResponse(msg)          connector.cpp:792
    ├ clientId = OrderID / 1'000'000，过滤非本进程   :825-846
    └ m_orscb = CommonClient::SendInfraORSUpdate   CommonClient.cpp:278
       ├ (commonBook 特例：负数量取反 + OrderID+1e6)  :290-300
       ├ m_ORSCallBack(response) = main.cpp:281 ORScallback
       │   ├ useArbStrategy → parent->ORSCallBack        main.cpp:284-287
       │   └ else m_orderIDStrategyMap[OrderID]->ORSCallBack  :288-294
       └ (commonBook) 再送一份给 CommonBook              :302-311
 └ ExecutionStrategy::ORSCallBack(resp)          ExecutionStrategy.cpp:967
    ├ m_ordMap.find(OrderID) 失败 → 日志 + return（**回报被丢弃**） :976-985
    └ switch(Response_Type):
       NEW_ORDER_CONFIRM   :997-1033   状态→NEW_CONFIRM，rejectCount=0，算 quantAhead
       MODIFY_ORDER_CONFIRM:1034-1039  ProcessModifyConfirm
       CANCEL_ORDER_CONFIRM:1040-1045  ProcessCancelConfirm
       TRADE_CONFIRM       :1046-1074  ProcessTrade；sweep；可选 selfTrade；上报 memlog
       ORS/RMS/SIM_REJECT  :1075-1106  见 §4.4
       NEW_ORDER_FREEZE/ORDER_ERROR :1107-1118 → NEW_REJECT
       MODIFY_ORDER_REJECT :1119-1124
       CANCEL_ORDER_REJECT :1125-1132
       ORDERS_PER_DAY_LIMIT_WARNING :1133-1140 → 平仓
       ORDERS_PER_DAY_LIMIT_REJECT  :1141-1146 → exit(1)
```

`ProcessTrade()`（V: `ExecutionStrategy.cpp:1988-2127`）是唯一的"账本入口"：

```cpp
openQty -= resp.Quantity;  doneQty += resp.Quantity;
if BUY:  buyTotalValue += px*qty; buyTotalQty += qty; buyAvgPrice = buyTotalValue/buyTotalQty;
         buyQty += qty; buyPrice = buyValue/buyQty; buyOpenQty -= qty;
else:    sellTotalValue/sellTotalQty/sellAvgPrice/sellQty/sellPrice/sellOpenQty 同理
m_netpos = m_buyTotalQty - m_sellTotalQty;      // 唯一净仓定义
m_transValue = 手续费(本轮回合);  if (m_netpos==0) { m_transTotalValue=总手续费; m_realisedPNL=...; 清空 buy/sellValue/Qty; }
CalculatePNL();
if (openQty==0) { status=TRADED; RemoveOrder(); }
else if (openQty<0) assert(0);                  // 超成交直接 abort
```

### 3.5 集合竞价

- 分流点在 `CommonClient::SendINDUpdate`：`update->m_feedType == FEED_AUCTION` → `m_AuctionCallBack(update)`，**不走指标、不走报价**（V: `CommonClient.cpp:465-468`）。
- 基类 `AuctionCallBack` 只处理一种情况：Live + BOVESPA 且未在平仓 → 立即 `m_onExit/m_onCancel/m_onFlat=true` 并 `HandleSquareoff()`（V: `ExecutionStrategy.cpp:771-784`）。
- **中国市场没有竞价特判**：CTP 的集合竞价（如 08:59–09:00）对 TradeBot 来说就是普通行情，策略照常按限价单报价，能不能成交由交易所决定。复刻时不要发明"竞价阶段禁发单"，那是行为变更。
- 唯一的例外是 `RepoTrade` 把 `AuctionCallBack` 覆写成空（V: `include/RepoTrade.h:60`）。

### 3.6 收盘路径

两条闸门，都在 `MDCallBack → CheckSquareoff()` 里（V: `ExecutionStrategy.cpp:2180-2371`）：

```text
（按时间顺序；代码里先判 60s 闸门，再判 180s 闸门）
now >= endTime - 180s 且 !m_onExit:
    m_onExit = m_onCancel = m_onFlat = true                  // 被动平仓（挂 bid0/ask0）
now >= endTime - 60s 且 !m_aggFlat:
    m_aggFlat = m_onExit = m_onCancel = m_onFlat = true      // 对手价 + 1 tick 的 CROSS 平仓
```

之后每个 tick：`if (m_onFlat) HandleSquareoff()`（V: `:2343-2369`）。`HandleSquareoff()`（V: `:2385-2460`）：

1. 若 `m_netpos==0 && m_onExit && 双边挂单为空` → `m_Active=false`（策略完成，进程还在）。
2. 计算平仓价：`m_aggFlat ? 对手价±1tick : 同向一档`；DI1 有薄簿特判（V: `:2402-2413`）。
3. 撤掉所有"价格不对/该撤"的单（V: `:2417-2436`）。
4. 双边清空后，按净仓方向发一张 `qty=abs(netpos)`（受 `m_rmsQty` 限制）的单（V: `:2443-2459`）。**注意是 DAY 限价单，不是 IOC**；如果价格跑掉，下一个 tick 会撤了重发。
5. `PairwiseArbStrategy` 覆写了这条路径：`m_wating_stop` 状态下不报价，只补齐 exposure，归零才真正退出（V: `PairwiseArbStrategy.cpp:196-206`、`:521-558`、`:1024-1056`）。收盘前 1 分钟直接 `HandleSquareoffNow()`（V: `:951-968`）。

`HandleTimeLimitSquareoff()`（V: `:2465-2529`）是另一条：当 `SQROFF_TIME>0` 且距最后成交超过该秒数时，按 `m_tholdBeginPos` 分批平（不是一次全平）。`PassiveStrategy` 每 tick 检查（V: `PassiveStrategy.cpp:17-27`）。

### 3.7 每 tick 的真实成本

- 生产构建定义了 `LOGGER`、`PRINTTRADES`、`_PRINT_UPDATE`，**没有**定义 `PRINTORDERS`、`VOLTHREAD`（V: `tbsrc/CMakeLists.txt:62-95`）。
- `TBLOG` 在 `LOGGER` 下展开为 `LOGP`（异步文件日志），不是 `cout`（V: `TimeManager.h:17-21`）。
- 但热路径里仍有**无条件**的日志：
  - 每条行情一行 `ALOG ... INCOMING MD[...]`（V: `CommonClient.cpp:428`）；
  - 每条行情若命中本策略，还有 4–5 行 `ALOG`（`:437-457`、`:566`、`:583`）；
  - 每次发单 `SendNewOrder` 一行（V: `ExecutionStrategy.cpp:1540`、`:1552`）；
  - 每次成交 `CalculatePNL()` 里一行（V: `:2154`）。
- `PairwiseArbStrategy::SendOrder()` 每 tick 打 **7 行以上**含十几个浮点的日志（V: `PairwiseArbStrategy.cpp:247`、`:278`、`:280`、`:286`、`:290`、`:308`、`:341`、`:346`、`:365`）。
- 结论：这套运行时的延迟下限由**字符串格式化 + 异步日志队列**决定，不是由策略算术决定。复刻时第一件该做的事是把逐 tick 日志降级为采样/条件日志，否则同样的策略会慢一个量级（I，基于代码结构的性能推断，未做基准测试）。

---

## 4. 订单状态机与路由键

### 4.1 三张表 + 一张全局表

| 结构 | 类型 | 键 | 值 | 生命周期 | 证据 |
|---|---|---|---|---|---|
| `m_ordMap` | `map<uint32_t, OrderStats*>` | 客户端 OrderID | 订单对象 | 下单插入，TRADED/NEW_REJECT/撤完删除 | `ExecutionStrategy.h:272` |
| `m_bidMap` | `map<double, OrderStats*>` | **价格** | 订单对象 | 下单/改单插入，撤单确认/成交删除 | `:274` |
| `m_askMap` | 同上 | 价格 | 订单对象 | 同上 | `:275` |
| `m_orderIDStrategyMap` | `map<uint32_t, ExecutionStrategy*>` | 客户端 OrderID | 策略对象 | 全局（`ConfigParams`），下单插入、删除见下 | `TradeBotUtils.h:152-153`、`ExecutionStrategy.cpp:1590`、`:1212` |
| `m_bidMapCache/askMapCache(+Del)` | 价格 → 订单 | 价格 | 订单 | 仅 `--selfBook` 时用于自簿 | `:276-279`、`:837-849` |
| `m_sweepordMap` | OrderID → 订单 | OrderID | 订单 | 仅 `--sweepStrategy` 的 CROSS 单 | `:273`、`:1584-1588` |
| `m_totalOrderMap` | OrderID → 订单 | OrderID | 订单 | **只增不删**（`ExtraStrategy`，用于停止态反手） | `ExtraStrategy.cpp:253` |

**"价格主键"的四个后果**：

1. 同一侧同一价格不可能有两张单：`SendNewOrder` 发现价格已存在直接 `return m_ordMap.end()`（V: `:1535-1549`），调用方必须检查返回值（多数策略检查了，`TargetStrategy` 也检查了：`TargetStrategy.cpp:81`）。
2. 撤单可以按价格撤：`SendCancelOrder(price, side)` 只撤 `NEW_CONFIRM/MODIFY_CONFIRM/MODIFY_REJECT` 状态的单（V: `:1724-1748`）。
3. 改单会**同时存在于新旧两个价格**下，直到 `MODIFY_ORDER_CONFIRM` 才删旧价（V: `:1687-1694`、`:1897-1919`）。这期间按新价撤单能撤到，按旧价也能撤到。
4. 市价/对手价单如果和已有挂单同价，会被静默拒绝 —— 平仓时表现为"这个 tick 没发平仓单"，下一 tick 再试。

### 4.2 状态机

状态枚举（V: `ExecutionStrategyStructs.h:20-33`）与全部赋值点：

```text
                 SendNewOrder()
                       │
                       ▼
                  ┌──────────┐   NEW_ORDER_CONFIRM   ┌─────────────┐
                  │ NEW_ORDER│ ────────────────────► │ NEW_CONFIRM │
                  └────┬─────┘                       └──┬───────┬──┘
        reject/error   │                                │       │ SendCancelOrder()
                       ▼                                │       ▼
                  ┌───────────┐                         │  ┌─────────────┐
                  │ NEW_REJECT│ (RemoveOrder)            │  │ CANCEL_ORDER│
                  └───────────┘                         │  └──┬───────┬──┘
                                                        │     │       │ CANCEL_ORDER_CONFIRM
                       SendModifyOrder()                │     │       ▼
                       ┌──────────────┐                 │     │  ┌───────────────┐
                       │ MODIFY_ORDER │◄────────────────┘     │  │ CANCEL_CONFIRM│
                       └──┬────────┬──┘                       │  └───────┬───────┘
       MODIFY_ORDER_CONFIRM│        │MODIFY_ORDER_REJECT       │          │ openQty<=0
                          ▼        ▼                          │          ▼
                  ┌───────────────┐ ┌──────────────┐          │     RemoveOrder
                  │MODIFY_CONFIRM │ │ MODIFY_REJECT│          │
                  └───────────────┘ └──────────────┘          │
                                                               │ CANCEL_ORDER_REJECT
                                                               ▼
                                                        NEW_CONFIRM（不是 CANCEL_REJECT！）
```

要点（全部 V）：

- `CANCEL_REJECT` 在 `ExecutionStrategy` 的状态机里**从未被赋值**；撤单拒绝后状态被改回 `NEW_CONFIRM`（`:1125-1132`）。全仓库唯一赋值点在另一个策略 `SymbolSpecificExecution.cpp:381`（该类未被工厂使用）。
- `TRADE_CONFIRM` 时若当前不是 `MODIFY_ORDER/CANCEL_ORDER`，状态置 `NEW_CONFIRM`（`:1047-1048`）—— 即"部分成交后仍是活单"。
- 成交把 `openQty` 打到 0 → `TRADED` + `RemoveOrder`（`:2106-2115`）。
- `RemoveOrder` 的删除条件是：`!selfBook || snapshot || status∈{TRADED,NEW_REJECT} || (CANCEL_CONFIRM && m_cancel)`（V: `:1204-1214`）。非 selfBook（默认）永远删。
- `m_status` 之外还有两个布尔在起作用：`m_modifywait`（改单在途）、`m_cancel`（撤单已发出）。它们决定 selfBook 场景下是否提前删除。

### 4.3 ID 体系：客户端单号 / ORS 单号 / 交易所单号

```text
TradeBot 侧：
  OrderID = clientId * 1'000'000 + seq      (connector.h:362-372, constants.h:14)
  clientId = SHM client store 的原子自增     (shmmanager.h:512-516)
  seq 由 Connector::m_OrderCount 自增；满 1e6 时重新申请 clientId (connector.cpp:1153-1217)

请求里同时带：
  OrderID    = 上述客户端单号
  StrategyID = --strategyID                  (CommonClient.cpp:969)
  AccountID  = m_account（"OWN" 或 config ACCOUNT）(CommonClient.cpp:971-972)

ORS 侧：
  m_ordLocalMap[request->OrderID] = ordinfo  (ORSServer.cpp:998)
  m_ordExchMap[req.OrderRef]      = request->OrderID  (ORSServer.cpp:1002)
  CTP OrderRef 是 ORS 自己的 12 位计数器（ORSServer.cpp:875-877），与客户端单号无关
  所有回报把 OrderID 还原成 ordinfo.localID = 客户端单号（ORSServer.cpp:2370/2438/2502/2579/2801）
```

因此：**TradeBot 永远只看得到自己生成的 OrderID**；ORS 与交易所之间的 `OrderRef/FrontID/SessionID/ exchID` 对它不可见。这也是为什么"客户端重启后单号不重复"要靠 clientId 自增来保证（同一 ORS 生命周期内），而不是靠时间戳。

`refStrategyID` 存进 `ConfigParams`（V: `main.cpp:720-725`）后只被 `MMFPassiveStrategyClose` 使用：它把 `../position/<refStrategyID>` 当作"要平的参考仓位"来读（V: `MMFPassiveStrategyClose.cpp:36-90`）。其余策略不读它。

### 4.4 撤单 / 改单 / 拒单的精确行为

**撤单**（V: `ExecutionStrategy.cpp:1750-1812`）：

```cpp
if (status 不是 NEW_CONFIRM/MODIFY_CONFIRM/MODIFY_REJECT) return false;
if (ordType == CROSS) return false;                       // IOC 单不撤
if (上次该单撤单被拒 且 距上次 < CANCELREQ_PAUSE) return false;  // 退避
status = CANCEL_ORDER;  m_client->SendCancelOrder(...);  m_cancelCount++;
```

- `CROSS` 单（IOC/FAK）永远不撤，靠交易所自己撤（V: `:1771-1774`）。
- 撤单被拒会设置 `m_lastCancelReqRejectSet/Time/OrderID`，在 `CANCELREQ_PAUSE` 内不再对同一单发撤单（V: `:1864-1895`）。

**改单**（V: `:1661-1722`）：

- 新价格已存在 或 当前已是 `MODIFY_ORDER` → 拒绝（`:1670-1679`）。
- 插入新价格到 price map、`m_buyOpenQty += (newQty - oldQty)`（可能是负数）。
- `m_modify++`、`m_modifywait=true`（非 snapshot）。
- `MODIFY_ORDER_REJECT` → 从 price map 删**新价**，`m_modifywait=false`（`:1840-1862`）；订单留在原价。
- `MODIFY_ORDER_CONFIRM` → 删旧价、`price=newprice`、`Qty=openQty=newQty`（`:1897-1919`）。
- 实际使用很少：只有 `PassiveStrategyPNL`、`ButterflyStrategy`、`SymbolSpecificExecution` 调 `SendModifyOrder`（V: grep）；其余策略都是"撤了重发"。

**拒单**（V: `:1075-1132`）：

| 回报类型 | 处理 | 计数 |
|---|---|---|
| `ORS_REJECT` / `RMS_REJECT` / `SIM_REJECT` | 若状态是 `CANCEL_ORDER/MODIFY_ORDER` → 走对应 Process*Reject 后 `break`；**否则穿透到 `NEW_ORDER_FREEZE` 分支** → `NEW_REJECT` + `ProcessNewReject` + `RemoveOrder` | `m_rejectCount++` |
| 其中 `E_RMS_ORDER_QTY_LIMIT_BREACHED` / `ORDER_VALUE` / `TICKER_OO` / `TICKER_VALUE` / `QUANTITY_PERORDER_IN_LOTS` / `TOTAL_POSITION_IN_LOTS` | 额外：`m_aggFlat=true; m_onExit=m_onCancel=m_onFlat=true; m_rmsQty=...`（把平仓单拆小） | 同上 |
| `NEW_ORDER_FREEZE` / `ORDER_ERROR` | `NEW_REJECT` + `ProcessNewReject`（从 price map 删、退 openQty、`RemoveOrder`） | `m_rejectCount++` |
| `MODIFY_ORDER_REJECT` | 删新价、保留原单 | `m_rejectCount++` |
| `CANCEL_ORDER_REJECT` | 状态回 `NEW_CONFIRM`，记录退避时间；若 `Quantity==0 && --fillReject` 则**伪造一笔成交** | `m_rejectCount++` |
| `ORDERS_PER_DAY_LIMIT_WARNING` | 平仓 | 不加 |
| `ORDERS_PER_DAY_LIMIT_REJECT` | `exit(1)` | 不加 |
| 任何回报后 `E_RMS_ORDER_FREQUENCY_LIMIT_BREACHED` / `E_RMS_UNEXPECTED_ORDERID` | **`m_rejectCount--`**（这类拒单不算策略的错） | -1 |

`m_rejectCount` 的语义是"连续拒单数"：任何 confirm/trade 都会把它清零（`:1000`、`:1037`、`:1042`、`:1064`）。所以只有**连续** 100 次拒单才告警、连续 200 次才平仓停机（`SetTargetValue`，`:444-493`）。

### 4.5 不变量与破例

| 不变量 | 是否成立 | 破例 |
|---|---|---|
| 下单先注册再可能收到回报 | 成立（同线程） | 若开 `ASYNC_MD_AND_RESPONSE` 则破 |
| 每个 OrderID 在 `m_ordMap` 唯一 | 成立 | `map::insert` 不覆盖，重复 ID 会**静默丢弃新单**但单已发出（`:1583`） |
| 成交必能找到订单 | 不成立 | 撤单确认先到 → `RemoveOrder` → 后续成交被丢（`:976-985`） |
| `openQty >= 0` | 成立 | 超成交直接 `assert(0)`（`:2116-2119`） |
| 每个价格最多一张单 | 成立 | 改单在途时新旧价同时存在（设计如此） |
| 状态机只走合法边 | 不成立 | 撤单拒绝回 `NEW_CONFIRM`；`CANCEL_REJECT` 在基类里从不使用 |

---

## 5. 仓位与 PnL 所有权

### 5.1 字段所有权

所有字段都在 `ExecutionStrategy` 上（V: `ExecutionStrategy.h:122-195`），**每个策略对象（含 `ExtraStrategy` 腿）一份**：

| 组 | 字段 | 含义 |
|---|---|---|
| 净仓 | `m_netpos` | `m_buyTotalQty - m_sellTotalQty`，唯一权威 |
| 分腿净仓 | `m_netpos_pass` / `m_netpos_pass_ytd` / `m_netpos_agg` | pair 用：被动腿/昨仓/主动腿 |
| 累计量 | `m_buyTotalQty` / `m_sellTotalQty` | 当日累计成交（不因平仓回退） |
| 回合量 | `m_buyQty` / `m_sellQty` | 当前"开→平"回合内的量，净仓归零时清零 |
| 累计额 | `m_buyTotalValue` / `m_sellTotalValue` | 价格×数量 累计 |
| 回合额 | `m_buyValue` / `m_sellValue` | 当前回合；净仓归零时清零 |
| 均价 | `m_buyAvgPrice` / `m_sellAvgPrice` | 累计均价 |
| 回合均价 | `m_buyPrice` / `m_sellPrice` | 当前回合均价 |
| 在途 | `m_buyOpenQty` / `m_sellOpenQty` / `m_buyOpenOrders` / `m_sellOpenOrders` | 已发未成 |
| 费用 | `m_transValue` / `m_transTotalValue` | 本回合 / 当日累计手续费 |
| 盈亏 | `m_realisedPNL` / `m_unrealisedPNL` / `m_grossPNL` / `m_netPNL` / `m_maxPNL` / `m_drawdown` | 见 §5.3 |
| 限额 | `m_maxTradedQty` / `m_maxOrderCount` / `m_maxPosSize` | 见 §5.6 |

### 5.2 从成交到净仓

```text
成交 qty @ px (side=BUY)
  m_buyTotalQty += qty
  m_buyTotalValue += px*qty
  m_buyQty += qty            // 回合量
  m_buyValue += px*qty       // 回合额
  m_buyAvgPrice = m_buyTotalValue / m_buyTotalQty
  m_buyPrice    = m_buyValue / m_buyQty
  m_netpos      = m_buyTotalQty - m_sellTotalQty
```

净仓归零时（`:2072-2096`）：重算 `m_transTotalValue`、`m_realisedPNL = (sellTotalValue - buyTotalValue) * priceMultiplier`（`perYield` 时反向），并清空回合量/额/均价。**这就是"回合制"记账**：只有回到零仓才结算一次已实现盈亏。

`m_netpos_pass/agg` 只在 `ProcessTrade` 里按订单类型累加（V: `:2046-2062`）：`CROSS/MATCH → m_netpos_agg`，`STANDARD → m_netpos_pass`。pair 策略用它们区分主动腿/被动腿。

### 5.3 PnL 公式

`CalculatePNL()`（V: `ExecutionStrategy.cpp:2129-2155`）：

```text
非 perYield:
unrealised = netpos > 0
    ?  netpos * ((bidPx0 - buyPrice - bidPx0*sellExchTx) * priceMultiplier - sellExchContractTx)
    : -netpos * ((sellPrice - askPx0 - askPx0*buyExchTx) * priceMultiplier - buyExchContractTx)
unrealised += qty * (sellPrice - buyPrice) * priceMultiplier      // qty = netpos>0 ? sellQty : buyQty
unrealised -= m_transValue                                        // 本回合手续费
gross      = realised + unrealised
net        = gross - m_transTotalValue
maxPNL     = max(maxPNL, net)
drawdown   = net - maxPNL
```

- `realised` 只在净仓归零时更新，其余时间是**上一次归零时的值**。
- 手续费口径：`m_transValue`（本回合）被减进 `unrealised`，`m_transTotalValue`（当日累计）又被减一次 → **平仓侧的百分比手续费在浮盈里被重复扣了一次**（`bidPx0*sellExchTx` 与 `m_transValue` 里的 `sellExchTx*sellValue` 重叠）。这是代码事实，不是笔误推断（V: 公式逐项对照）；影响是浮盈偏保守，方向安全，但**不能拿它和券商对账单对账**（I）。
- `perYield`（债券）走 `BondPrice()` 折现（V: `:1224-1228`、`:2133-2137`、`TradeBotUtils.cpp:3927-3930`）。
- 这个 PnL **不包含** ORS 侧的实际成交价差/滑点以外的任何东西，也不含资金费用、交易所返还。

### 5.4 持仓恢复（三条路径，都不是"实时对账"）

TradeBot 没有任何"向券商查询持仓"的代码路径；重启后的仓位完全依赖本地文件。共有三种文件格式，分别属于不同的策略族：

#### (a) pair 系：`../data/daily_init.<strategyID>`

`PairwiseArbStrategy` 构造函数（V: `PairwiseArbStrategy.cpp:24-97`）：

```text
读 ../data/daily_init.<strategyID>
第一行必须是表头: StrategyID 2day avgPx m_origbaseName1 m_origbaseName2 ytd1 ytd2 [px1 px2 max_pnl pnl]
文件空/缺列 → exit(-1)
取 mx.begin()->second（最小 StrategyID 那行，忽略 --strategyID！）
  avgSpreadRatio_ori = avgPx
  leg1.netpos = leg1.netpos_pass = leg1.netpos_pass_ytd = ytd1 + 2day
  leg2.netpos = leg2.netpos_agg = ytd2
  若存在 px1/px2/max_pnl/pnl：恢复两腿均价、maxPNL、累计 pnl（m_test_pnl=true）
```

写入端（V: `:1039-1056`、`:1083-1133`）：`HandleSquareoffNow()` 写文件 + 写 `tbhft_strategy.posdetail`，内容是

```text
<strategyID> 0 <avgSpreadRatio_ori> <base1> <base2> <leg1.netpos> <leg2.netpos> [px1 px2 maxPnL pnl]
                  ^2day 恒为 0
```

#### (b) MMF/平仓类：`../position/<strategyID>`，CSV 行

`MMFPassiveStrategy::GetPosition()` / `DumpPosition()`（V: `MMFPassiveStrategy.cpp:247-310`、`:615-663`）：

```text
instrument,netpos,costprice[,lowestPrice]
```

- 读：找不到合约行 → `m_netpos` 保持 0；找到则把 `netpos` 拆成 buy/sell 侧的量与均价（`netpos` 先按 100 取整）。
- 写：`DumpPosition()` 在 `HandleSquareoff()`、收盘 1 分钟闸门、以及部分 `CheckSquareoff` 分支调用（V: `:61-76`、`:685-690`）。
- `MMFPassiveStrategyClose` 读的是 `../position/<--refStrategyID>`（**别人的**仓位文件），语义是"专门平掉参考策略的仓"（V: `MMFPassiveStrategyClose.cpp:36-90`）。

#### (c) 对冲/拆单类：`../position/<strategyID>`，`KEY=VALUE` 行

`PassiveHedgingStrategy` / `SimpleHedgingStrategy` / `TwapStrategy` 用同一套 `LoadPosition/DumpPosition`（V: `PassiveHedgingStrategy.cpp:499-560`、`:555-640`；`SimpleHedgingStrategy.cpp:78-230`）：

```text
BUY_QTY / SELL_QTY / BUY_PRICE / SELL_PRICE / BUY_TOTAL_QTY / SELL_TOTAL_QTY
BUY_AVG_PRICE / SELL_AVG_PRICE
#below for display
REALISED_PNL / REALISED_FEE / UNREALISED_PNL / UNREALISED_FEE / GROSS_PNL / NET_PNL
```

- **启动硬依赖**：`LoadPosition` 在文件缺失或行数 ≤3 时直接 `exit(-1)` + "position file is bad, exit"（V: `PassiveHedgingStrategy.cpp:636-650`、`SimpleHedgingStrategy.cpp:226-240`）。所以这几类策略**没有仓位文件就起不来**。
- `DumpPosition` 在 `ExitStrategy()`（平仓完成）里写（V: `PassiveHedgingStrategy.cpp:446-460`、`SimpleHedgingStrategy.cpp:135-142`）。
- **已知 bug**：`LoadPosition` 的 `UNREALISED_PNL` 分支写的是 `m_transValue`（应为 `m_unrealisedPNL`），与 `UNREALISED_FEE` 撞车（V: `PassiveHedgingStrategy.cpp:617-626`、`SimpleHedgingStrategy.cpp:207-216`）。恢复后 `m_unrealisedPNL` 恒为 0，`m_transValue` 被覆盖。

#### (d) 其余单腿策略

`PassiveStrategy` / `TargetStrategy` / `Aggressive*` / `Spread` / `VWAP` 等**完全没有恢复**：重启即 `netpos=0`，与券商持仓脱节。

**共同的真实语义**（I，但由代码直接推出）：

- 文件保存的是"**上次停策略那一刻的残仓**"，不是"当前实时仓位"。正常 `tbstop` 时一般已归零；异常/强制退出时可能是残仓。
- 盘中崩溃后重启：文件仍是**上一次停策略时**的内容 → 恢复出的净仓与券商实际持仓不一致，且策略自己不知道。
- 这也解释了为什么 ORS 侧要按账户净额决定开平（§6.7）：TradeBot 的"平仓"只是"卖出"，是不是平仓由 ORS 看账户持仓决定。

`daily_init` 的外部快照：`scripts/ops_snapshot_daily_init.sh` 每天把 `deploy_cpp/data/daily_init.*` 复制到 `deploy_cpp/daily_init_bak/<date>/`（V: 脚本 22-33 行）；它**只备份不生成**。`../position/` 目录没有对应的快照脚本。

### 5.5 squareoff 的三条路径

| 路径 | 触发 | 行为 | 证据 |
|---|---|---|---|
| A. 信号平仓 | `SIGTSTP` / `36` / `37` / `SIGTERM`+signal.txt | 置 `m_onExit/m_onCancel/m_onFlat`（`36/37` 再加 `m_aggFlat`），调 `HandleSquareoff()`；之后每个 tick 继续推进 | `main.cpp:142-168`、`ExecutionStrategy.cpp:2385-2460` |
| B. 收盘平仓 | `now >= endTime-180s` / `-60s` | 同 A，60s 闸门带 `m_aggFlat` | `ExecutionStrategy.cpp:2180-2189`、`:2191-2215` |
| C. 启动即平仓 | `--squareOff 1 --controlList <list>` | 跑 `../scripts/squareoffcontrols.sh`（仓库中不存在），读 `../models/model.squareoff.list`（不存在）给每个策略预置 `m_netpos`/`m_buyTotalQty`/`m_sellTotalQty`，然后按 A 平仓 | `main.cpp:1016-1053` |

路径 C 在**当前仓库里是坏的**：脚本与两个 list 文件都不存在（V: `find` 无结果），且没有 `--controlList` 时还会解引用 `end()` 迭代器（V: `main.cpp:644-656`）。复刻时要么实现它（从 ORS 持仓文件生成 list），要么删掉。

路径 A 的语义细节：`SendCancelOrder` 对 `CROSS` 单返回 false，所以 IOC 单不会被撤；`HandleSquareoff` 先用同向一档挂单（被动），只有 `m_aggFlat` 才用对手价+1tick（主动）。**被动平仓可能一直不成交**，直到下一个 tick 重新计算价格。

### 5.6 限额表（谁检查、检查什么、触发后做什么）

| 限额 | 来源 | 检查点 | 语义 | 触发动作 | 可恢复 |
|---|---|---|---|---|---|
| `MAX_LOSS` | model | `CheckSquareoff` `:2191` | `m_netPNL < -MAX_LOSS`（含浮盈） | 置平仓三标志；`m_onExit=true` → **不会自动恢复** | 否（需重启/重激活） |
| `UPNL_LOSS` | model | `:2309` | `m_unrealisedPNL < -UPNL_LOSS` | 平仓 + `m_onStopLoss=true`；**并把阈值翻倍**（`:2321-2324`） | 15 分钟后自动恢复（`:2345-2350`） |
| `STOP_LOSS` | model | `:2309` | `m_netPNL < -STOP_LOSS` | 同上，阈值翻倍 | 同上 |
| `MAX_ORDERS` | `StrategyConfig.cfg` | `:2191` | `m_orderCount >= m_maxOrderCount`（当日累计报单数） | 平仓 + `m_onExit` | 否 |
| `MAX_POS_SIZE` → `m_maxTradedQty` | `StrategyConfig.cfg` | `:2191` | `m_buyTotalQty >= m_maxTradedQty` 或 `m_sellTotalQty >= m_maxTradedQty`（**累计成交量**，不是持仓） | 平仓 + `m_onExit` | 否 |
| `MAX_ORDERS`（另一套） | model | `EquityQuotingStrategy.cpp:100/155` | 在途单数 `m_buyOpenOrders` | 停止加单 | 是 |
| `REJECT_LIMIT`（硬编码 200） | 代码 | `SetTargetValue` `:444-493` | 连续拒单 > 100 告警，> 200 平仓 + `m_Active=false` | 平仓 + 停用 | 否（需 tbstart） |
| `MAX_SIZE/BID_MAX_SIZE/ASK_MAX_SIZE` | model | 各策略 `SendOrder`（如 `PassiveStrategy.cpp:93`、`:136`） | 持仓/在途上限 | 撤单/不发 | 是 |
| `BID_SIZE/ASK_SIZE` | model | 同上 | 单笔报单量 | 裁剪数量 | 是 |
| 时间闸门 | control `endTime` | `:2182-2189` | 收盘前 3min / 1min | 平仓 | 每交易日一次 |

**两处极易混淆**：
- `MAX_ORDERS` 有两个：`StrategyConfig.cfg` 的（当日累计，基类用）和 model 里的 `MAX_ORDERS`（在途单数，只有 `EquityQuotingStrategy` 用）（V: `TradeBotUtils.cpp:2854-2855`、`EquityQuotingStrategy.cpp:100`）。
- `MAX_POS_SIZE` 名字像持仓上限，实际是**累计成交手数上限**；真正的持仓上限是 model 的 `MAX_SIZE`。这一条与 `00-source-map.md:152` 的结论一致（V 复核）。

### 5.7 与 ORS 的持仓口径

- TradeBot 的请求**不携带开平标志**：`CommonClient::SendNewOrder` 只填 `Request_Type/Token/Transaction_Type/Price/Quantity/Discretion/AccountID/Contract/Symbol/OrdType/Duration/StrategyID`（V: `CommonClient.cpp:957-1013`）。`PosDirection` 字段存在但从未赋值。
- ORS 用 `mapContractPos[InstrumentID]`（**只按合约，不按策略**）决定 `Open / CloseToday / Close`（V: `ORSServer.cpp:513-593`）。选择规则是"整笔"：`qty <= todayPos` → 平今；`qty <= ONPos` → 平昨；否则 → 开仓。
- `mapContractPos` 在**发单时**就扣减（`:546`、`:562`），不是成交后；被拒的单不会回滚（源码注释明确提到这会"误标开平方向"，`:1430`、`:1502`）。
- 因此：**账户级净额 + 策略级账本是两套独立真相**，只在"一个策略、一个合约、无外部干扰"时才一致。

---

## 6. 风控与健康

### 6.1 策略内检查（TradeBot 自己做的）

| 检查 | 位置 | 触发 | 动作 |
|---|---|---|---|
| 脏簿过滤 | `MDCallBack` `:788-791` | `bidPx[0]<=0` 或 `askPx[0]<=0` 或 `>MAX_DOUBLE_VALUE` | 本 tick 直接 return（不更新 PnL、不做风控） |
| pair 脏簿 | `PairwiseArbStrategy::MDCallBack:834-837` | 任一条腿 `bid/ask<=0` | return |
| 时间闸门 | `CheckSquareoff:2182-2189` | 收盘前 3min/1min | 平仓 |
| 净亏损 | `:2191` | `netPNL < -MAX_LOSS` | 平仓 + 退出 |
| 浮亏 | `:2309` | `unrealisedPNL < -UPNL_LOSS` | 平仓 + 阈值翻倍 + 15min 后恢复 |
| 净亏损（更严） | `:2309` | `netPNL < -STOP_LOSS` | 同上 |
| 报单数 | `:2191` | `orderCount >= maxOrderCount` | 平仓 + 退出 |
| 累计成交量 | `:2191` | `buyTotalQty/sellTotalQty >= maxTradedQty` | 平仓 + 退出 |
| 连续拒单 | `SetTargetValue:444-493` | >100 告警，>200 平仓停用 | 见 §4.4 |
| 价格带 | `:2257-2307` | `targetPrice` 的 20s 均值超 `MIN_PRICE/MAX_PRICE` 或 delta 过低或模型 IV 无效 | 平仓；回到带内且非 `onExit` 则自动恢复 |
| Delta 带 | `:2217-2255` | 期权 delta 绝对值（`abs(GetDelta())`）的 20s 均值超 `min/maxDeltaToTrade` | 平仓/恢复 |
| 新闻 | `:2334-2340` | `useNewsHandler && NEWS_FLAT && getFlat()` | 平仓 |
| 时间止损 | `HandleTimeLimitSquareoff` | 距最后成交 > `SQROFF_TIME` | 分批平仓 |
| 累计盈亏回撤 | `m_drawdown` | **只计算、不触发任何动作** | 无（`MAX_DRAWN_DOWN` 字段存在但基类未使用） |

**结论**：策略内风控是"**事后止血**"型 —— 先报价，再按 PnL/时间的快照平仓。没有事前敞口上限（除了 `MAX_SIZE` 这类报价裁剪）、没有单笔最大亏损、没有盘中资金检查。

### 6.2 ORS / RMS 的边界

- RMS 在 ORS 侧、CTP 发单前执行：`rms.executeNewOrderChecks(*request)`（V: `ORSServer.cpp:676-683`）。失败会回一个 `RMS_REJECT` 响应，TradeBot 只看到错误码（`E_RMS_*`，V: `errorcodes.h:49-76`）。
- TradeBot 对 RMS 的反应只有两类：① 6 个数量/价值/持仓类错误码 → 平仓 + 把平仓单拆小（`m_rmsQty`）；② 其它 → 计入连续拒单（V: `ExecutionStrategy.cpp:1080-1091`）。
- RMS 规则本身（限额、频率、账户/合约黑名单）不在 tbsrc 里，见 `03-ors-connectors.md`。
- 关键结论：**TradeBot 无法预知 RMS 限额**。一个策略可能因为"账户级"限额被拒，而它自己的 `MAX_SIZE` 完全正常 —— 这正是 §6.7 的净额问题的另一面。

### 6.3 行情健康 / 陈旧数据

`CheckLastUpdate()`（V: `CommonClient.cpp:379-400`）：

```text
触发：SendInfraMDUpdate 中，若 (update->m_timestamp - m_lastUpdate) > m_updateInterval
检查：对每个策略的每个合约，若 (m_lastUpdate - instru->lastLocalTime) > m_updateInterval
     且 lastLocalTime>0 且 now < endTime
动作：mailx 发告警（system() 同步调用！）+ 置该策略 onExit/onCancel/onFlat
```

五个致命细节（全部 V）：

1. **它只在"收到下一条行情"时运行**。对单合约进程，如果该合约的行情彻底停了，`SendInfraMDUpdate` 不再被调用 → 检查永不执行 → 策略既不报警也不平仓。
2. `m_lastUpdate` 在比较**之前**就被更新为当前 update 的时间戳（`:360-363`）→ 检查用的是"上一条 vs 当前条"的间隔，不是"现在 vs 最后一条"。
3. 判定使用 `update->m_timestamp`（ORS 打的时间戳），不是本地墙钟；行情时间戳若不前进（复用/回放），检查失效。
4. 生产启动参数 `--updateInterval 7200`（2 小时，为跨午休设计，V: `build_deploy_cpp.sh:505`）→ **在任何一个交易时段内都不可能触发**。该保护在生产配置下等于关闭。
5. 告警用 `system("echo ... | mailx ...")`，在行情线程里同步 fork/exec —— 一旦真的触发，会阻塞整个进程（V: `:388-389`）。

`Watch` 时钟同样依赖行情（§1.7），所以"行情停了"在这套系统里是**双重静默**：既不报警，也不平仓，连"现在几点"都停住。

### 6.4 无效订单簿

- `tickType == INVALID` 或（期权模式且 `tickLevel > 1`）→ 直接 return，不更新指标、不回调（V: `CommonClient.cpp:563-576`）。
- `tickLevel > m_level` → `significantUpdate=false` → 不触发指标/回调（`:577-585`）。
- 价格 ≤ 0 或 > `MAX_DOUBLE_VALUE (999999999999.0)` → `MDCallBack` return（V: `ExecutionStrategy.cpp:788-791`、`:28`）。
- 策略在发单前也会检查 `price == 0` 并放弃（V: `ExecutionStrategy.cpp:1348-1352`、`:1478-1482`）。
- **没有**"盘口交叉/负价差"检查（除 DI1 的薄簿特判，`ExecutionStrategy.cpp:2405-2411`）。交叉簿会直接进入 `GetBidPrice` 的 `bidCross` 分支；是否会发出自成交单取决于 `--selfBook/--crossBook` 配置。

### 6.5 价格 / Delta 限额

见 §6.1 的"价格带"与"Delta 带"。两点补充：

- Delta 判断的条件写成了 `(delta != 0 || delta != delta || std::isnan(delta))`（V: `:2227`）—— `delta != 0 || delta != delta` 恒为真（除非 delta 同时等于 0 且不是 NaN），所以**只要 `m_optionStrategy` 为真且该合约在 OptionManager 里，这段逻辑就总会执行**。这不是"delta 非零才检查"，而是"总是检查"。复刻时按意图写成 `std::isfinite(delta) && delta != 0`。
- 价格带用的是 `m_targetPrice` 的 20 秒滑动均值，且 `m_currAvgPrice` 初始为 0 时用瞬时值兜底（V: `:2275-2296`）。

### 6.6 Reject 处理

见 §4.4 表。补充三条运维含义：

1. **连续**才计数：一个"每 10 单被拒 1 单"的策略永远不会触发 200 次上限。
2. `E_RMS_ORDER_FREQUENCY_LIMIT_BREACHED` 和 `E_RMS_UNEXPECTED_ORDERID` 会把计数减 1（V: `:1160-1164`），即"限频"和"未知单号"被视为环境问题。
3. 200 次触发后 `m_Active=false` + 平仓，但**进程不退**；要恢复必须 `tbstart`，而如果根因（例如 RMS 限额）没解决，会再次循环。

### 6.7 `ACCOUNT=OWN` 的账户级净额：真实含义

所有策略默认用同一个账户字串（`StrategyConfig.cfg:1` 的 `OWN`，或 config 顶层 `ACCOUNT` 覆盖，V: `main.cpp:1008-1012`、`tbadmin/admin.cpp:1849-1853`）。由此产生：

1. **券商只认一个净仓**。策略 A 买 10 手、策略 B 卖 4 手 → 账户净多 6 手；两个策略各自记着 +10 和 -4。
2. **开平由 ORS 按净仓猜**。B 的"卖 4 手"会被标成 `CloseToday`（如果账户有多头今仓），而不是"开空"。B 的账本认为自己在建空头，券商认为在平多 —— 两边对"这笔成交"的语义不同，但成交价和数量一致，所以短期 PnL 还能对上，**持仓方向会在下一次平仓时爆雷**。
3. **平仓可能平掉别人的仓**。A 想平自己的多单，卖出的却是 B 持有的多头（账户净额），A 的 `m_netpos` 归零、B 的 `m_netpos` 不变，账户净仓却少了一块。
4. **同一合约不允许两个策略同时跑**（尤其是"一个 pair 腿 + 一个单腿策略"跑同一合约）。当前 control 文件按 `(baseName1, baseName2)` 分 pair，理论上不重叠，但 `TA701/TA702` 与 `IF2612/IF2610` 共用 sid `92221`（V: `data_cpp/bin/controls/day/` 目录），一旦两个 control 同时被启动，就是同一账户、可能同一合约的双策略。
5. **没有账户级对冲器/聚合器**：`OptionManager` 只做 Greeks 汇总（`PortfolioGreeks`），不下"组合层"的单；`CommonBook` 只共享行情簿，不共享仓位（V: `main.cpp:949-952`、`CommonClient.cpp:535-547`）。

复刻建议（明确的产品决策，不是代码事实）：要么强制"一合约一策略"并在启动时校验 control 文件集合，要么引入账户级 position keeper（按 strategyID 拆分成交）并把开平决策从 ORS 移到策略侧。当前系统两者都没有。

---

## 7. 故障模式与已知坑

按"是否会直接造成资金/数据损失"排序。**V** = 代码确认；**I** = 由代码结构推断的后果。

### 7.1 高危（会错单、丢仓、无法平仓）

| # | 问题 | 后果 | 证据 |
|---|---|---|---|
| 1 | 平仓单是 DAY 限价单，`HandleSquareoff` 每 tick 撤了重发；价格跑掉就永远平不掉，直到收盘后进程被杀 | 隔夜残仓，且 `daily_init` 只有 pair 系会记 | V: `ExecutionStrategy.cpp:2443-2459` |
| 2 | `SIGTERM` 不平仓（无 signal.txt 时直接 return），而 `stop_all.sh` 正是先 SIGTERM 再 `kill -9` | 停机脚本 = 直接杀，仓留在券商 | V: `main.cpp:110-128`、`build_deploy_cpp.sh:683-695` |
| 3 | 单腿策略无持仓恢复；重启后 `m_netpos=0`，ORS 仍按账户净仓判开平 | 重启后的第一笔"开仓"可能被标成平仓，账面方向反了 | V: §5.4、`ORSServer.cpp:513-593` |
| 4 | 撤单确认先于成交回报到达时，`RemoveOrder` 已删单 → 后续成交被 `ORSCallBack` 丢弃 | 本地净仓少算，PnL 与持仓偏离 | V: `:976-985`、`:1204-1214` |
| 5 | `ProcessTrade` 的 `openQty<0` 直接 `assert(0)` | 重复/超量成交回报 → 进程 abort（core） | V: `:2116-2119` |
| 6 | `interestlist[50][50]` 无越界检查，按"不同合约数"写入 | >50 个合约（期权组合很容易）→ 栈溢出/踩内存 | V: `main.cpp:968`、`:982-1000` |
| 7 | `m_simConfigList[100]` 按 `symbolID` 下标写入，无越界检查 | >100 个 symbolID → 越界写 `ConfigParams` | V: `TradeBotUtils.h:726`、`main.cpp:1161`、`CommonClient.cpp:419` |
| 8 | `m_targetBidPNL/AskPNL` 指向 main 的 5 元素数组（`targetBidPNL[5]`），而 `CalculateTargetPNL` 按 `i < MAX_QUOTE_LEVEL` **写入**，策略再按 `level` 读 | model 里 `MAX_QUOTE_LEVEL>5` → 越界**写**（栈/全局相邻内存） | V: `main.cpp:85`、`TradeBotUtils.cpp:4155-4202`、`PassiveStrategy.cpp:86` |
| 9 | `m_instruType[10]` 用 `strcpy` 从 model 的 `type` 字段复制 | `BASKETRIGHT`(11) 等长 type → 越界写 | V: `ExecutionStrategy.h:281`、`ExecutionStrategy.cpp:384` |
| 10 | 账户级净额 + 无策略级拆分（§6.7） | 跨策略平仓/开平误判 | V/I: §6.7 |

### 7.2 中危（会静默失效、难排障）

| # | 问题 | 后果 | 证据 |
|---|---|---|---|
| 11 | `m_description` 未初始化（只有 8 个策略填了） | 每次 MD 的 `ALOG` 打印野指针内容，可能越界读 | V: `ExecutionStrategy.h:282`、`CommonClient.cpp:457`、`:566` |
| 12 | `Watch` 时钟由行情驱动，且只前进不后退 | 行情停 → 收盘/超时判断永不触发 | V: `Watch.cpp:27-44` |
| 13 | 行情陈旧检查只在"收到下一条行情"时跑，且生产 `--updateInterval 7200` | 实盘等于关闭 | V: `CommonClient.cpp:360-364`、`build_deploy_cpp.sh:505` |
| 14 | 告警用 `system("...mailx...")` 在行情线程里同步执行 | 真触发时阻塞热路径 | V: `CommonClient.cpp:388-389` |
| 15 | `SIGUSR2` 热重载只重读阈值，不重建指标、不重做 `MAX/MIN_PRICE *= priceFactor` | 重载后价格带与启动时不一致 | V: `main.cpp:169-178`、`ExecutionStrategy.cpp:60-61`、`TradeBotUtils.cpp:2382-2426` |
| 16 | `StrategyConfig.cfg` 是全局文件，tbadmin 每次同步都重写 | 策略间互相覆盖 `ACCOUNT/MAX_POS_SIZE/MAX_ORDERS/DSN`；DSN 含明文凭据 | V: `tbadmin/admin.cpp:1849-1855` |
| 17 | 同一 session 目录下同一 SID 有两个 control 文件（92221 的 IF 与 TA） | `start_strategy.sh` 只取 glob 第一个，另一个静默不启动 | V: `build_deploy_cpp.sh:445-460`、`data_cpp/bin/controls/day/` |
| 18 | `--squareOff` 路径依赖不存在的脚本/list，且可能解引用 `end()` | 启动崩溃或什么都不做 | V: `main.cpp:644-656` |
| 19 | `strategyType==2`（Basket）工厂为空，`MultiInstruStrategy` 永不赋值 | Basket 模型起得来但不交易、回报全丢 | V: `main.cpp:87`、`:727-730`、`:941-943` |
| 20 | `LoadMatrix2` 只取 `mx.begin()->second`（最小 StrategyID 行），不校验 `--strategyID` | 一个 daily_init 文件放多行时恢复错仓位 | V: `PairwiseArbStrategy.cpp:36`、`:162-194` |
| 21 | `m_rejectCount` 被任何 confirm/trade 清零 | 间歇性拒单永远触发不了 200 上限 | V: `:1000`、`:1037`、`:1042`、`:1064` |
| 22 | `ORDERS_PER_DAY_LIMIT_REJECT` 直接 `exit(1)` | 无平仓、无落盘，持仓留在券商 | V: `:1141-1146` |
| 23 | `OrderStats` 每单 `new`，从不 `delete`（只 `erase` map 项） | 按报单量线性泄漏；5000 单/日量级可忽略，长跑/高频会积累 | V: `:1565`、`:1213`；`m_totalOrderMap` 更是只增不删（`ExtraStrategy.cpp:253`） |
| 24 | 日志每 tick 多行 + `std::string`/`stringstream` 拼接 | 热路径延迟被日志主导 | V: §3.7（I：未做基准） |
| 25 | `Pipeline` 无 try/catch：`getStringStrict`/SHM/`std::stod` 任一异常 → `terminate` | 启动期任何配置错误都是 core，不是可读错误 | V: `main.cpp:1058`（`// try` 被注释） |
| 26 | 对冲/拆单类策略**强依赖** `../position/<sid>`（KEY=VALUE），文件缺失或行数 ≤3 直接 `exit(-1)` | 新部署/换机/清目录后这些策略起不来；且 `../position/` 没有快照脚本 | V: `PassiveHedgingStrategy.cpp:636-650`、`SimpleHedgingStrategy.cpp:226-240` |
| 27 | `LoadPosition` 把 `UNREALISED_PNL` 写进 `m_transValue`（应为 `m_unrealisedPNL`），与 `UNREALISED_FEE` 撞车 | 重启后浮盈恒为 0、`m_transValue` 被覆盖 → 以浮亏/浮盈为条件的风控失真 | V: `PassiveHedgingStrategy.cpp:617-626`、`SimpleHedgingStrategy.cpp:207-216` |

### 7.3 低危/卫生问题

| # | 问题 | 证据 |
|---|---|---|
| 28 | `m_onMaxPx` 声明未初始化，`Reset()` 里只有一句 `m_onMaxPx;`（无赋值），当前无人读 | `ExecutionStrategy.h:101`、`:329` |
| 29 | `m_bUseExchTS` 永远是 false（没有任何参数设置它） | `TradeBotUtils.h:656`、grep 无写入 |
| 30 | `m_description` 之外的 `m_instruType` 在 `Reset()` 里从指标 type 复制，语义是"合约类型"却当成"InstrumentName"传给 ORS（`memcpy(..., instType, 6)` 固定 6 字节） | `ExecutionStrategy.cpp:384`、`CommonClient.cpp:977` |
| 31 | `AccountID` 用 `memcpy(dst, Account, strlen(Account))`，`ACCOUNT` 超过 10 字节会越界 | `CommonClient.cpp:972`、`orderresponse.h:18` |
| 32 | pid 文件写成 `"<sid> <pid>"` 无换行，多次启动会粘成一行；目录不存在时静默失败 | `main.cpp:710-716` |
| 33 | `pairStrat`/`arbStrat` 是全局变量，跨 control 泄漏 | `TradeBotUtils.cpp:217-218`、`:1933-1943` |
| 34 | `EndTimeEpoch` 里 `static uint8_t cnt` 是函数级静态，不随策略重置 | `PairwiseArbStrategy.cpp:997` |
| 35 | `ThresholdSet::MAX_IMPROVE` 未在构造函数里初始化（`TargetStrategy` 直接用它算价格）；当前靠 `SimConfig` 是全局数组被零初始化才等于 0，一旦换成栈/堆对象就是随机值 | `TradeBotUtils.h:361`、`:240-326`、`TargetStrategy.cpp:11-12`、`main.cpp:80` |

### 7.4 "没有"的东西（复刻时不要假设存在）

- 没有策略级线程/协程；没有异步下单队列（`SendNewOrder` 直接写 SHM）。
- 没有订单持久化/恢复（重启即忘单）。券商侧挂单还在，但 TradeBot 不再追踪；这些单只能靠 ORS/柜台撤。
- 没有独立的风控定时器：所有检查都挂在行情回调上；pair 的 `MDCallBack` 只由腿 1 的 tick 驱动（§3.1 第 4 条）。行情停 → 风控停。
- 没有心跳/健康端点；进程活着但"卡住"只能靠日志和 memlog 判断。
- 没有配置热加载（除了 SIGUSR2 的阈值重读）。
- 没有多账户支持（一个进程一个账户字串）。
- 没有单元测试（`tests/` 只有脚本/夹具）。
- 没有 atexit/flush；`kill -9` 后 memlog 里最后几条可能丢。

---

## 8. 如何复刻这套运行时

### 8.1 最小可运行组件

按依赖顺序，缺一不可：

| # | 组件 | 作用 | 本文对应 |
|---|---|---|---|
| 1 | 行情接入 + 订单接入（两个方向） | 本系统是 SysV SHM；复刻可用 TCP/UDP/共享内存，但必须保证**同一线程串行投递** | §1.5、`03` |
| 2 | 合约静态数据加载器 | tickSize/lotSize/priceFactor/sendInLots/交易所行为开关 | §1.4(e) |
| 3 | control/model 解析器 | 7/8/9 字段 control + "指标行/阈值行" model | §1.4(c)(d) |
| 4 | 指标库 | 至少实现 model 里用到的那些；`Value(status)` 必须能表达"未热身" | §3.1 |
| 5 | 目标价计算 | 指标线性组合 + 手续费感知的目标 PnL | §3.1、`CalculateTargetPNL` |
| 6 | 报价引擎 | 阈值 → 价差 → 价格/类型/数量 → 撤/发 | §3.3 |
| 7 | 订单状态机 + 价格主键订单表 | 见 §4 | §4 |
| 8 | 账本 | netpos / 回合制 PnL / 累计量 | §5 |
| 9 | 风控定时器 | 收盘/亏损/拒单/成交量 | §5.6 |
| 10 | 监控输出 | 至少 POSITION/PNL/STATUS 三种；本系统是 memlog SHM | §5.1、`04` |
| 11 | 信号控制面 | 激活/停用/重载 | §1.6 |

最小策略集：`PassiveStrategy`（做市模板）+ `TargetStrategy`（追价模板）+ 一个 pair（跨期套利）。有这三个就能覆盖 90% 的部署形态。

### 8.2 必须实现的配置键（按文件）

```ini
# config/StrategyConfig.cfg  —— 全局，每进程都读
ACCOUNT=OWN
MAX_POS_SIZE=1000          # 累计成交手数上限（不是持仓！）
MAX_ORDERS=5000            # 当日累计报单数上限
DSN=                       # 仅 pair 写库需要；不要明文入库

# config/config_CHINA.<sid>.cfg
INTERACTION_MODE=LIVE
MONITORSHMKEY=789
MONITORSHMSIZE=1024
PRODUCT=AG
EXCHANGES=CHINA_SHFE
[CHINA_SHFE]
MDSHMKEY=4097 / MDSHMSIZE=...
ORSREQUESTSHMKEY=8193 / ORSREQUESTSHMSIZE=...
ORSRESPONSESHMKEY=12289 / ORSRESPONSESHMSIZE=...
CLIENTSTORESHMKEY=16385
# 可选：ACCOUNT、ASYNC_MD_AND_RESPONSE（保持 false）、RESPONSE_FILTER_TYPE

# controls/<session>/control.<name>.<sid>   —— 7/8/9 个空格分隔字段
<base1> <modelPath> <EXCH> <sid> <TB_*_STRAT> <HHMM> <HHMM> [<base2>] [<EXCH2>]

# models/model.*.<sid>
<base> <TYPE> <IND> <coef> <args...>       # 指标行
MAX_QUOTE_LEVEL 3
SIZE 4 / MAX_SIZE 16 / BID_SIZE 4 / BID_MAX_SIZE 32 / ASK_SIZE 4 / ASK_MAX_SIZE 32
BEGIN_PLACE 5.0 / LONG_PLACE 7.5 / SHORT_PLACE 2.5
BEGIN_REMOVE 2.0 / LONG_REMOVE 3.0 / SHORT_REMOVE 1.0
CROSS 3 / SUPPORTING_ORDERS 2
UPNL_LOSS 100000 / STOP_LOSS 100000 / MAX_LOSS 100000
```

`MAX_QUOTE_LEVEL` 必须 ≤ 5（见 §7 #8）。

### 8.3 目录布局（运行时 cwd 决定一切）

```text
<run>/                       # cwd = deploy_cpp/bin
├── TradeBot
├── config/  StrategyConfig.cfg, config_CHINA.<sid>.cfg, signal.txt(可选)
├── controls/day|night/control.*.<sid>
├── models/model.*.<sid>
├── data/ -> ../../data_cpp/data   (合同静态数据、fee.csv、daily_init.<sid>、OptionsParams)
├── log/     log.*, nohup.*
├── pid/     pid.<yyyymmdd>
├── ../position/<sid>              # MMF/对冲/拆单系的持仓文件
└── ../scripts/, ../data/          # 代码里写死了 ../data、../scripts

/home/hft/tbdata/            # 硬编码绝对路径，必须是软链或真实目录
├── contractfile
├── fee.csv
├── RolloverOverrideFile
└── cash                     # 仅 RepoTrade
```

`ops_install_deps.sh:42-66` 就是干这件事的：`mkdir -p /home/hft/tbdata` + 逐个 `ln -sfn data_cpp/data/<f>`。复刻时要么保留这个软链约定，要么把三个硬编码路径改成配置项（推荐后者，改动量 3 行）。

### 8.4 操作序列（从零到能下单）

```text
1) 静态数据就位
   - data_cpp/data/{contractfile,fee.csv,RolloverOverrideFile} 存在
   - /home/hft/tbdata 软链正确（或改代码去掉绝对路径）
   - trading_days.txt 覆盖当天（日历门控在 start_all.sh 里）

2) 进程基础设施
   - ors_server 启动，创建 MD/REQ/RESP/CLIENTSTORE 四类 SHM
   - 创建 memlog SHM（key = config 的 MONITORSHMKEY，size ≥ 16MB 实测安全）
     （原版代码只 attach，部署脚本用 python shmget 预创建：build_deploy_cpp.sh:593-601）

3) 配置
   - config/StrategyConfig.cfg（ACCOUNT/MAX_POS_SIZE/MAX_ORDERS）
   - config/config_CHINA.<sid>.cfg（PRODUCT/MONITORSHMKEY + 4 个 SHM key 及其 size）
   - controls/<session>/control.<name>.<sid>（第 5 字段 = 策略 token）
   - models/model.*.<sid>（指标 + 阈值）
   - 持仓文件：pair → ../data/daily_init.<sid>；MMF → ../position/<sid>（CSV）；
     对冲/拆单 → ../position/<sid>（KEY=VALUE，缺文件会 exit(-1)）

4) 启动
   ./TradeBot --Live --controlFile <control> --strategyID <sid> \
              --configFile <cfg> --logFile <log> --printMode 1 --updateInterval 7200
   # 检查日志：MAX LOSS/UPNL/STOPLOSS/MAXPOS/MAXORDERS/ACCOUNT 那一行
   # 检查日志：total symbols registered are - N
   # 检查日志：Symbol ID: <instru> <id>

5) 激活
   tbstart <sid>        # SIGUSR1 → 日志出现 "Strategy is active now."
   # 未激活前 m_Active=false，一单不发 —— 这是最常见的"策略不工作"原因

6) 盘中
   - 看 log 里的 NewOrder/Trade/NetPos/NetPNL
   - 看 memlog 的 POSITION/PNL/STRATEGY_STATUS
   - 异常: tbstop <sid>（平仓+停用） → 确认净仓=0 → kill -9

7) 收盘
   - endTime-3min：撤单+被动平仓
   - endTime-1min：对手价+1tick 激进平仓
   - 净仓=0 后 m_Active=false（进程仍在）
   - pair 系此时写 daily_init.<sid>

8) 次日
   - 换 control（日盘/夜盘目录不同）
   - pair 系读 daily_init.<sid>（前一天收盘写的）
   - 单腿策略从 0 仓开始 —— 必须人工确认券商侧无残仓
```

### 8.5 验收用例（可执行、有明确期望）

| # | 用例 | 期望 |
|---|---|---|
| 1 | 只给 `--Live` 不带 `--configFile` | 打印 "Config file not provided for Connector" 后 `exit(1)`（V: `main.cpp:449-453`） |
| 2 | control 第 5 字段写 `TB_NOPE` | 打印 "Strategy not found !!" 后 `exit(1)`（V: `:935-939`） |
| 3 | 正常启动但**不**发 SIGUSR1 | 有行情日志、有指标日志，但**零** NewOrder（V: `:466-485`） |
| 4 | `tbstart` 后 | 出现 "Strategy is active now."，随后出现 NewOrder/New Confirmation（V: `main.cpp:150-159`） |
| 5 | 把 model 的 `MAX_LOSS` 改成 1 | 下一个 tick 后出现 "MAX LOSS limit got hit!!" + 平仓单（V: `:2197-2214`） |
| 6 | 把 `MAX_POS_SIZE` 改成 1 | 累计成交 1 手后出现 "MAX TRADED limit got hit!!"（V: `:2201-2202`） |
| 7 | 连续制造 100 次拒单 | 出现 "REJECT Limit reached so cancelling orders..."（V: `:444-448`） |
| 8 | 收盘前 1 分钟 | `m_aggFlat` 路径：平仓价为对手价 ± 1 tick（V: `:2182-2189`、`:2447-2457`） |
| 9 | `tbstop` 后 | 净仓归零、`m_Active=false`；pair 系 `daily_init.<sid>` 被重写（V: `PairwiseArbStrategy.cpp:1039-1056`） |
| 10 | `kill -TERM` 且无 `config/signal.txt` | 日志 "Error while opening the signal file."，进程**仍在**，仓位不变（V: `main.cpp:116-120`） |
| 11 | 重启同一 sid | 日志里 clientId 递增（SHM client store 自增），订单号段变化（V: `shmmanager.h:512-516`） |
| 12 | pair 策略删掉 `daily_init.<sid>` | 启动即 `exit(-1)` + "daily_init ERROR! Missing"（V: `PairwiseArbStrategy.cpp:25-29`） |

### 8.6 复刻时可以明确删掉/简化的部分

| 可删 | 理由 | 风险 |
|---|---|---|
| `VOLTHREAD` 分支 | CMake 未定义，编译不进；期权波动率线程是死代码 | 若原系统用 Makefile 开了 `-DVOLTHREAD`，需保留（I：生产用 CMake，见 `build_deploy_cpp.sh:268`） |
| `Basket` / `strategyType==2` / `MultipleInstrument*` | 工厂为空，永不实例化 | 无（除非有外部 control 用 Basket） |
| `--squareOff` 路径 | 依赖不存在的脚本/文件 | 无（当前已坏） |
| `m_bidMapCache*` 自簿 | 只在 `--selfBook` 下用；生产未开 | 自成交场景需要 |
| CME/BOVESPA/KRX/MICEX/... 分支 | 中国部署用不到 | 换交易所时需恢复 |
| `commonBook` | 同账户多进程共享簿，生产未开 | 多策略同合约时需要 |
| `RepoTrade`/`MMFPassive*`/`BondsPassive` | 债券/货币基金专用 | 换品种时需恢复 |
| `m_tvar/m_tcache` | 只在 model 配了 `TVAR_KEY/TCACHE_KEY` 时启用 | 无 |
| `NewsHandler` | 只对 CME IR / BOVESPA DOL 生效 | 无 |

**不能删**：价格主键订单表（撤单/改单逻辑依赖它）、单线程串行投递、回合制 PnL（限额判断依赖它）、收盘双闸门、`m_Active` 激活语义。

---

## 9. 证据索引（文件:行）

> 全部基于 commit `5cee3dd5`。行号为该 commit 的实际行号。

### 9.1 启动与配置

| 主题 | 位置 |
|---|---|
| main / 参数解析 / 模式 | `tbsrc/main/main.cpp:388-419` |
| configFile 必填 + LoadCfg | `main.cpp:443-455` |
| Logger 初始化 | `main.cpp:457-461` |
| 开关解析 | `main.cpp:463-633` |
| controlFile/controlList/paramFile | `main.cpp:635-667` |
| 逐策略加载 | `main.cpp:671-700` |
| strategyID + pid | `main.cpp:702-725` |
| 策略工厂 | `main.cpp:732-946` |
| ACCOUNT 覆盖 | `main.cpp:1008-1012` |
| squareOff 预置 | `main.cpp:1016-1053` |
| Initialize + TICKERS | `main.cpp:1055-1097` |
| Connector 配置/构造/Async | `main.cpp:1101-1181` |
| LoadArgMap | `TradeBotUtils.cpp:2541-2566` |
| LoadControlFile / List | `TradeBotUtils.cpp:1872-1947` |
| LoadModelFile | `TradeBotUtils.cpp:2065-2380` |
| LoadThresholds | `TradeBotUtils.cpp:2382-2426` |
| LoadTCost2（fee.csv） | `TradeBotUtils.cpp:2460-2495` |
| LoadDateConfig / Epoch | `TradeBotUtils.cpp:2598-2692` |
| AddThreshold | `TradeBotUtils.cpp:2765-2920` |
| 合约静态数据 | `tbsrc/common/Instrument.cpp:1554-1690` |
| priceMultiplier | `Instrument.cpp:428-431` |
| Watch 时钟 | `tbsrc/common/Watch.cpp:27-64` |
| Configfile strict | `tbsrc/hftbase/CommonUtils/include/configreader.h:458-484` |

### 9.2 运行时/回调

| 主题 | 位置 |
|---|---|
| Initialize / BlockSignals | `CommonClient.cpp:143-192`、`:1160-1172` |
| HandleSignals | `CommonClient.cpp:227-255` |
| SendInfraMDUpdate | `CommonClient.cpp:322-377` |
| CheckLastUpdate | `CommonClient.cpp:379-400` |
| SendINDUpdate | `CommonClient.cpp:402-806` |
| IND 先于 MD 回调 | `CommonClient.cpp:776-790` |
| 指标更新 | `CommonClient.cpp:867-883` |
| SendNewOrder（请求字段） | `CommonClient.cpp:957-1026` |
| SendModifyOrder / Cancel | `CommonClient.cpp:1028-1147` |
| MD/ORD/IND/AUC 回调入口 | `main.cpp:257-384` |
| Squareoff 信号处理 | `main.cpp:106-181` |
| Connector StartAsync | `tbsrc/hftbase/Connector/src/connector.cpp:599-666` |
| HandleUpdates | `connector.cpp:752-784` |
| HandleOrderResponse（clientId 过滤） | `connector.cpp:792-858` |
| 订单号生成 | `connector.cpp:1153-1217`、`include/connector.h:362-372` |
| 单线程 MD+RESP 轮询 | `tbsrc/hftbase/Ipc/include/shmmanager.h:751-783` |
| client store / 250 上限 | `shmmanager.h:512-516`、`orderresponse.h:17` |

### 9.3 策略层

| 主题 | 位置 |
|---|---|
| 基类声明 | `tbsrc/Strategies/include/ExecutionStrategy.h:32-327` |
| 纯虚 SendOrder | `ExecutionStrategy.h:41` |
| 构造函数/限额来源 | `ExecutionStrategy.cpp:20-135` |
| Reset（m_Active 初值） | `ExecutionStrategy.cpp:289-408`（`:389-392`） |
| SetTargetValue（拒单+心跳+下单） | `ExecutionStrategy.cpp:434-494` |
| SetThresholds / Linear | `ExecutionStrategy.cpp:607-701`、`:512-605` |
| MDCallBack / CheckSquareoff | `ExecutionStrategy.cpp:786-835`、`:2180-2371` |
| GetBidPrice / GetAskPrice | `ExecutionStrategy.cpp:1231-1315`、`:1363-1446` |
| SendBidOrder / SendAskOrder | `ExecutionStrategy.cpp:1317-1361`、`:1448-1491` |
| SendNewOrder（价格主键） | `ExecutionStrategy.cpp:1528-1614` |
| SendModifyOrder | `ExecutionStrategy.cpp:1661-1722` |
| SendCancelOrder | `ExecutionStrategy.cpp:1724-1812` |
| Process*（reject/confirm/trade） | `ExecutionStrategy.cpp:1814-2127` |
| CalculatePNL | `ExecutionStrategy.cpp:2129-2155` |
| HandleSquareoff | `ExecutionStrategy.cpp:2385-2460` |
| HandleTimeLimitSquareoff | `ExecutionStrategy.cpp:2465-2529` |
| OrderStatus / OrderHitType / OrderStats | `ExecutionStrategyStructs.h:20-68` |
| 订单表声明 | `ExecutionStrategy.h:272-279` |
| PassiveStrategy | `tbsrc/Strategies/PassiveStrategy.cpp:7-173` |
| TargetStrategy | `tbsrc/Strategies/TargetStrategy.cpp:7-222` |
| PairwiseArbStrategy | `tbsrc/Strategies/PairwiseArbStrategy.cpp:9-134`（ctor）、`:196-402`（SendOrder）、`:504-631`（回报）、`:831-905`（MD）、`:951-1056`（收盘/停用） |
| PairwiseArbStrategyMN | `tbsrc/Strategies/PairwiseArbStrategyMN.cpp:9-150` |
| ExtraStrategy（腿） | `tbsrc/Strategies/include/ExtraStrategy.h:6-31`、`ExtraStrategy.cpp:205-260` |
| CalculateTargetPNL | `TradeBotUtils.cpp:3971-4208` |
| pair 持仓恢复/落盘 | `PairwiseArbStrategy.cpp:24-97`、`:1039-1056`、`:1083-1133` |
| MMF 持仓文件（CSV） | `MMFPassiveStrategy.cpp:247-310`、`:615-663`；`MMFPassiveStrategyClose.cpp:36-90` |
| 对冲/拆单持仓文件（K=V） | `PassiveHedgingStrategy.cpp:499-560`、`:555-650`；`SimpleHedgingStrategy.cpp:78-240` |

### 9.4 配置/部署/运维

| 主题 | 位置 |
|---|---|
| StrategyConfig 样例 | `data_cpp/bin/config/StrategyConfig.cfg:1-4` |
| Connector 配置样例 | `data_cpp/bin/config/config_CHINA.92201.cfg:1-23` |
| control 样例（日/夜） | `data_cpp/bin/controls/day/control.ag2606.ag2608.par.txt.92201`、`night/...` |
| model 样例 | `data_cpp/bin/models/model.ag2606.ag2608.par.txt.92201:1-28` |
| 启动命令 | `scripts/build_deploy_cpp.sh:503-505` |
| 启动脚本的 control 选择 | `scripts/build_deploy_cpp.sh:445-465` |
| 停止脚本 | `scripts/build_deploy_cpp.sh:676-695` |
| memlog SHM 预创建 | `scripts/build_deploy_cpp.sh:593-601` |
| 信号工具 | `scripts/ops_tb_signal.sh:1-140` |
| 硬编码路径软链 | `scripts/ops_install_deps.sh:42-66` |
| daily_init 快照 | `scripts/ops_snapshot_daily_init.sh:22-33` |
| tbadmin 生成 config/StrategyConfig/control/start | `tbadmin/admin.cpp:1810-1900`（`:1878` OptionManage 命令） |
| daily_init posfile 约定 | `tbadmin/admin.cpp:3428` |
| ORS 开平标志 | `ors/China/src/ORSServer.cpp:509-593` |
| ORS 订单映射 | `ORSServer.cpp:875-877`、`:981-1002`、`:2370` |
| RMS 前置检查 | `ORSServer.cpp:676-683` |
| RMS 错误码 | `tbsrc/hftbase/CommonUtils/include/errorcodes.h:49-76` |

---

## 10. 与旧文档的冲突 / 未解决问题

### 10.1 代码与文档冲突（以代码为准）

| 说法 | 代码事实 | 判定 |
|---|---|---|
| "main.cpp 的 N 策略循环是遗留/回归路径"（`00-source-map.md:150`） | 循环是活的，`--controlList` 下真的会构造多个策略；生产上由 OptionManage 使用（`tbadmin/admin.cpp:1878`） | 部分正确：单 control 下恒为 1；多策略路径存在且有唯一真实用户 |
| "`MAX_POS_SIZE` 是持仓上限"（若其他文档如此描述） | 它是累计成交手数上限（`ExecutionStrategy.cpp:70`、`:2191`） | 代码为准；`00-source-map.md:152` 已修正 |
| "`position.csv` 是实时持仓" | ORS 只在启动/关机/查询回调写（详见 `03`/`07`） | 时点文件，不可当实时流 |
| "`SIGTSTP` 平仓使用 daily_init 的虚拟昨仓" | 平仓用内存里的 `m_netpos`；daily_init 只在 **启动时** 读进内存 | 语义正确但顺序要说清：先恢复、后平仓 |
| "多策略共享账户会有组合对冲" | 没有账户级对冲器；只有 `OptionManager` 的 Greeks 汇总 | 代码为准 |

### 10.2 未验证 / 需要其他文档补的

1. **SHM 队列的 `MDSHMSIZE`/`ORSREQUESTSHMSIZE` 单位与最小值**：TradeBot 原样透传（`connectorconfig.h:292-301`），ORS 侧如何解释、样例配置的 2048 是否意味着"槽位数"或"字节数"，需要 `03` 用 ORS 源码确认。配错的表现是启动即 `assert`/异常，不是运行期降级。
2. **client store 在 ORS 重启后是否重置**：`createClientStore` 用 `IPC_CREAT` 且 placement-new 一个原子变量（`shmmanager.h:281-295`、`shmlocklessclientstore.h:48-92`），从代码看会重置为 0，但 SHM 段是否被删除、旧 clientId 的残留队列是否复用，需要 ORS 侧和现场确认。若不重置，250 个 id 槽会被重启次数耗尽。
3. **`m_dateConfig.m_currDate` 的时区语义**：Live 下取 `localtime` 的日期（`TradeBotUtils.cpp:2631-2638`），而 control 的 `HHMM` 按 UTC 解释（`Watch.cpp:59`）。夜盘跨本地午夜后，进程内的 `m_currDate` 仍是启动日；哪些下游（日志名、pid 文件、daily_init 命名）依赖它、会不会错位，未逐一验证。
4. **生产实际启用的策略清单**：仓库里 `data_cpp/bin/config/strategies.disabled` 列了 3 个停用（92201/92202/92203），但 control 目录里仍有 6 个 SID；现场到底跑哪几个、`92221` 的 IF 与 TA 两个 control 是否同时启动，需要现场 `ps` + `tbhft_strategy` 表确认。
5. **`CommonBook` / `--commonBook` 的生产使用情况**：代码路径完整（`CommonClient.cpp:535-547`、`:290-311`），但样例配置都未开启。如果生产用"多进程共享一个合约簿"，§6.7 的净额问题会更复杂（多个进程看到彼此的单），需要 `04`/现场确认。
6. **`m_bNewSim` 与 `m_bUseEndPkt` 的真实取值**：`m_bNewSim` 默认 true 且无参数可关（`TradeBotUtils.h:652`），`m_bUseEndPkt` 默认 false（`:655`）。生产是否曾用 `--endPkt 1` 改变回调边界，未在脚本中找到证据（I：未使用）。
7. **`options` 相关路径**（`TB_OPTION_QUOTING_STRAT` + OptionManage 容器）的行为只做了结构确认：一个进程内 N 个 simConfig、共享 `OptionManager`、由 `m_simConfigList[symbolID]` 分发。其 Greeks 汇总、对冲腿联动、`control.OptionManage.<sid>` 的实际内容需要 `04` 补齐。另：`OptionManager::LoadOptionsParams()` 只在 SIGUSR2 调用（`main.cpp:175`），意味着**期权参数在启动时并不加载**，全部使用 `OptionManager` 成员默认值，直到第一次 `tbreload` —— 这一点需要现场确认是否是预期行为。
8. **`../position/` 在生产上的内容与生成方**：仓库里只有读取代码和 `DumpPosition`，没有任何脚本生成/备份这个目录。生产上它是谁写的（策略自己的 `ExitStrategy`？外部工具？），以及清目录/换机后如何恢复，未验证。

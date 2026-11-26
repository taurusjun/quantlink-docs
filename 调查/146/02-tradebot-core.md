# 02 — 原始 TradeBot C++ 核心与策略实现（SVN r2375）

> 对象：`/Volumes/DevDisk/146/3/TradeBot/TradeBot_China`（源码权威，r2375，2015-06-10，作者 avijit）。
> 对照：`/Volumes/DevDisk/146/2/TradeBot/TradeBot_China`（只读校验）。
> 范围：**C++ 核心 + 策略实现**。Qt GUI、构建/部署/运维不在本文（见 `03`、`05`）。
> 证据约定：**V** = 直接读源码/配置/日志确认并给 `file:line`；**I** = 由结构/调用链/日志推断；**P** = 假设或无法验证。
> 不复制口令/密钥/账号明文；只记位置。未运行任何二进制，未修改任何源文件。

---

## 0. 一页结论

| # | 结论 | 证据 |
|---|---|---|
| 1 | TradeBot 是**单进程 = 单策略实例**的做市/主动报价引擎：一个 control 文件一行 → 一个 `SimConfig` → 一个 `ExecutionStrategy` 子类对象。生产 controls 全部只有 1 行。 | 【V】`main/main.cpp:606-638,698-843`；`3/TradeBot/controls/control.GOLD_F_0_SFE.noon.agg.20150630`（1 行） |
| 2 | 全进程只有**一条业务线程**：Connector 的 `SHM_MD_RESP_THREAD` 同时轮询行情 SHM 与回报 SHM，MD 回调、指标、目标价、下单、成交处理全在这条线程上串行执行。 | 【V】`3/dalong/infrastructure/Ipc/include/shmmanager.h:712-758`；`main/main.cpp:1032-1062` |
| 3 | 策略层是**模板方法**：基类 `ExecutionStrategy` 包办挂单簿、订单状态机、PnL、撤单/改单、squareoff；子类基本只实现 `SendOrder()`（少量还覆盖 `MDCallBack/ORSCallBack/SetThresholds/SetTargetValue/HandleSquareoff`）。 | 【V】`Strategies/include/ExecutionStrategy.h:18-266`；`Strategies/PassiveStrategy.cpp:7-173` |
| 4 | 目标价来自**线性指标模型**：模型文件首行是 `Dependant`（依赖指标）+ 价格类型，其余指标按 `系数 × 指标差分/取值` 累加；期权模式下改用 IV/Black-Scholes。 | 【V】`main/TradeBotUtils.cpp:3401-3503`；`3/TradeBot/models/model.GOLD_F_0_SFE.noon.agg.20150630:1-3` |
| 5 | 生产真正跑过的策略只有 6 种：`TB_AGGRESSIVE_STRAT`(1172)、`TB_COMMS_STRAT`(406)、`TB_AGGRESSIVEPASSIVE_STRAT`(380)、`TB_DEP_AGGPASS_STRAT`(41)、`TB_FAK_STRAT`(6)、`TB_PASSIVE_STRAT`(1)；其余 25 个分支（含 `NO_STRAT`）是"能编能选但没跑过"。 | 【V】`awk` 统计 `3/TradeBot/controls/control.*`（2006 个文件） |
| 6 | 风控是**策略内嵌**而非独立风控进程：拒绝次数、单边成交总量、下单数、停损、结束时间、盘口异常、行情陈旧 —— 全部在 `ExecutionStrategy`/`CommonClient` 内部判断；RSL/RMS 侧另有一层（在 ORS）。 | 【V】`Strategies/ExecutionStrategy.cpp:19,264-309,2036-2231`；`main/CommonClient.cpp:384-405` |
| 7 | 代码里有**多处真实的 UB / 未初始化 / 越界 / 错误路由**（不是风格问题）：`m_simConfigList[100]` 用 `symbolID` 直接索引、`AddInstrument` 里把赋值写成比较、蝶式平仓函数因非虚而完全失效、两处 `exit(1)` 在持仓状态下直接杀进程。 | 【V】见 §8 R1–R28 |
| 8 | 这套源码**离开 `/include/illuminati/dev_multi` + `/bld/dev_multi` 无法链接**；`Connector/` 里只有 24 个 `config_*.cfg`，没有任何 `connector.cpp`。 | 【V】`main/Makefile:5,9-12`；`ls Connector/`（0 个 cpp） |

一句话概括行为：**行情进 SHM → Tick → 指标 → 目标价 → 子类决定挂/撤 → 基类发单 → 回报回同一线程改订单表/净仓/PnL → 每次行情都跑一遍风控与 squareoff 判定。**

---

## 1. 代码地图与构建单元

### 1.1 目录与体量（全部 V）

| 目录 | 内容 | 规模 |
|---|---|---|
| `main/` | 进程入口、Connector 封装、配置/模型解析、PnL 计算 | 7 cpp / 5 h；`main.cpp` 1077 行、`CommonClient.cpp` 1111 行、`TradeBotUtils.cpp` **3629** 行 |
| `Strategies/` | 策略基类 + 30 个具体策略 + 三腿蝶式 | 40 cpp / 41 h；`ExecutionStrategy.cpp` 2430 行 |
| `Indicators/` | 指标库（`Indicators/*.cpp` + `Indicators/include/*.h`） | 172 cpp / 173 h，无子目录（`ls -d */` 只有 `include/`） |
| `common/` | `Instrument`/`Tick`/`Bar`/`OptionManager`/`Watch`/`CommonBook`/`Logger` | 18 cpp / 16 h；`Instrument.cpp` 3462 行 |
| `Connector/` | **只有 24 个 `config_*.cfg`**（`config_CHINA_CME.cfg` 等），无源码 | 0 cpp |
| `Config/` | `StrategyConfig.cfg`、`ShmConfig*.cfg`（33 个）、`signal.txt` | — |
| `data/` | `contractfile`、`ChinaInstruments`、`ExchTransCharges`、`OptionsParams`、`RolloverOverrideFile`、`BASKET/`、`SIGNS` | — |
| `controls/` `models/` | 源码树里的**样本**（NSE/Nifty），不是生产用的 China 配置 | 5 / 3 个文件 |

> `Connector/` 没有源码这一点很关键：**Connector 库来自 infrastructure**（`libconnectormwmr`），TradeBot 只是它的调用方。见 §9.1。

### 1.2 构建单元（V）

`Makefile:1-8`（顶层）：`ll` 目标依次 `make` `common → Indicators → Strategies → main`。

| 子项目 | Makefile 关键行 | 产物 |
|---|---|---|
| `common` | `common/Makefile:21-37` | 只产 `.o`（无库、无 exe） |
| `Indicators` | 同构 | 只产 `.o` |
| `Strategies` | `Strategies/Makefile:31-64` 列出 33 个 cpp | 只产 `.o` |
| `main` | `main/Makefile:47-70`（源文件）、`:14-24`（`-O3 -w -DUSE_MWMRQ_{REQ,RESP,MD}SHM`）、`:9-12`（链接） | `TradeBot`、`watchMarket`、`get_symbol_on_date`、`startDataServer` |

链接命令里的关键依赖（`main/Makefile:12`）：

```
-L/bld/dev_multi ../Strategies/*.o -lconnectormwmr -llogger -lxsim \
-ldatamanip -lcommonutils -lpthread -lrt /usr/local/lib/libsnappy.a \
../common/*.o ../Indicators/*.o -lz -lxsimdataserver
```

- `INFRAPATH=/include/illuminati/dev_multi`（`main/Makefile:5`）→ 与 `2/include/illuminati/dev_multi`、`2/bld/dev_multi` 完全对应（`00-inventory.md §6.2`）。
- `../Strategies/*.o` 是**通配符**：目录里残留的 `.o` 会被一起链接。这解释了为什么 `Strategies/Makefile` 的 `SOURCES` 与 `main` 的链接输入必须靠"清干净再编"来保证一致。

### 1.3 编译开关的实际含义（V）

| 宏 | 打开后行为 | 位置 |
|---|---|---|
| `LOGGER` + `ORDER` | `TBLOG` 变成异步队列日志 `LOGQ(PLAIN, TBResponseMsgSerializer(...))` | `common/include/TimeManager.h:20-24`；`Strategies/ExecutionStrategy.cpp:959-966` |
| 未开 `LOGGER` | `TBLOG` 就是 `cout`；`Strategies` 侧改定义 `PRINTORDERS/PRINTTRADES`，`main` 侧定义 `PRINTIND` | `Strategies/Makefile:13-17`；`main/Makefile:23-27` |
| `VOLTHREAD` | 起一条期权波动率后台线程 + `sem_t`/`deque<Tick>` 队列 | `main/CommonClient.cpp:68-142,185-190` |
| `STATS` | `TBStatsRecorder` 记录 ORS/MD/策略延迟分位 | `main/CommonClient.cpp:160-168,315-317,337-376` |
| `PROFILER` | 6 个 profile 点（MD/ORS/IND/Option/Underlying/NonUnderlying） | `main/main.cpp:597-605` |
| `SIM` / `SURFACE` | 引入 xsim 头 / Python2.6 曲面 | `main/CommonClient.cpp:20-34`；`main/Makefile:44-48` |

> `-w`（关全部警告）在 `main`、`Strategies`、`common`、`Indicators` 的 release 档里都开着 —— 这是 §8 里那些 UB 长期没被发现的结构性原因之一。【V】`main/Makefile:15`、`Strategies/Makefile:6`、`common/Makefile:6`

---

## 2. 启动与生命周期

### 2.1 `main()` 全流程（`main/main.cpp:361-1076`）

```
argv[1] 必须是 --Regress/--Sim/--Live/--LeadLag        (376-385)
  └─ GetMode() → ConfigParams::m_modeType
LoadArgMap(argv[2..]) → ArgMap{"key"->"value"}          (388-391, 2241-2266)
必填 --configFile → cfg.LoadCfg()                       (414-426)  ← 缺失即 exit(1)
[LOGGER] Logger::InitLogger(STRATEGY, TO_FILE, logFile)  (428-432)
一堆布尔开关（selfBook/selfTrade/fillReject/squareOff/endPkt/
  invisibleBook/CMESmartBook/BrazilSmartBook/useDSTShift/
  adjustLTP/crossBook(End/2)/commonBook/optionStrategy/
  sweepStrategy/deltaStrategy）                          (434-595)
--optionParams 默认 ../data/OptionsParams                (586-595)
[PROFILER] 注册 6 个 profile                             (597-605)
Sim/Live/LeadLag: --controlFile → LoadControlFile(simConfig[0])   (607-614)
                  --controlList → LoadControlList(simConfig, file) (615-631)
                  --squareOff 1 → system("../scripts/squareoffcontrols.sh")  (620-627)
Regress:          --paramFile → LoadParamFile()          (632-638)
Watch::CreateUniqueInstance(0)                           (640)
new CommonClient()                                       (641)
for i in 0..m_strategyCount-1:                           (642-844)
    m_index=i; LoadDateConfig(); LoadModelFile(); LoadDateConfigEpoch();
    LoadPrintStats(); baskets/state list; [MODEL_ALGO==1] AR 参数;
    new CalculatePNL(); 写 pid 文件(Live); 判定 strategyType;
    [Sim|Live] 策略工厂 if-else → m_execStrategy          (698-843)
[Regress|LeadLag] 打开 outputFile                        (846-858)
拼 TICKERS / TICKERS_10LEN / TICKERS_FOR_ORS（按 exchange 分 SFE 特例）(860-905)
--squareOff: 读 model.squareoff.list → 直接设 netpos/buy/sell/onFlat  (907-944)
client->Initialize(MDcb, ORScb, INDcb, AUCcb, interestlist, count, mode, simConfig)  (947)
cfg.setProperty(TICKERS/INTERACTION_MODE/TICKERS_FOR_ORS/…)          (951-1020)
每个指标 setIndex(i)                                     (1022-1029)
new Connector(bind(CommonClient::SendInfraMDUpdate),
              bind(CommonClient::SendInfraORSUpdate), mode, &cfg)    (1032-1037)
把 connector 的 symbolID 回写到 Instrument + 建 m_simConfigList[] 索引 (1041-1060)
connector->StartAsync()                                  (1062)
cerr << "Async stopped!!!" ;                             (1063)
client->HandleSignals(&Squareoff)                        (1075)  ← Live 下永久 sigwait
```

**几个容易看错的点（全部 V）：**

1. `argv[1]` 必须是模式；参数从 `argv[2]` 开始成对出现（`LoadArgMap` 严格 `--key value`，落单/奇数个参数直接 `return false`）。
2. **`--configFile` 对所有模式都是必填**（`414-424`），但 `main/command.txt`、`main/runTradeBot.sh`、`main.cpp:370` 打印的示例命令都**没有** `--configFile` —— 按示例敲会立刻 `exit(1)`。【V】`main/command.txt:1`、`main/runTradeBot.sh:4-6`
3. `LoadControlList` 允许一个 control list 里多行 → 多策略；但 `LoadControlFile` 每行必须是 ≥7 个 token（否则 `exit(1)`）；第 8 个 token 会让 `pairStrat=true`，第 9 个让 `arbStrat=true`，**这两个是全局变量**（`TradeBotUtils.cpp:215-217,1708-1718`）。
4. `Squareoff` 之前，`configParams->m_simConfig` 只是"最后一个被处理的 SimConfig"（`CommonClient.cpp:440`），所以 `--controlList` 多策略时 MD 回调只会送到最后一个策略（§8 R3）。
5. `StartAsync()` 返回后打印 `Async stopped!!!` 是**正常路径**（LIVE 下 `startMonitorAsyncMarketDataAndResponse` 只是起线程就返回），随后进入 `sigwait` 死循环。【V】`infrastructure/Ipc/include/shmmanager.h:712-715`；`Connector/src/connector.cpp:431-448`

### 2.2 运行期启动序列（实测日志，V）

`3/TradeBot/log/log.live.control.GOLD_F_0_SFE.noon.agg.20150630:1-20`：

```
initialized SpreadState historicIndRet=0 indepStatus=0        ← 全局对象构造顺序副作用
*****TradeBot started in Live Mode*****
Input Parameters / configFile / logFile / controlFile /
  endDate / startDate / strategyID 420
Config File: .../Connector/config_CHINA_CME.cfg
Option Param File:../data/OptionsParams
Control File: .../controls/control.GOLD_F_0_SFE.noon.agg.20150630
Model File: .../models/model.GOLD_F_0_SFE.noon.agg.20150630
230 330                                                       ← startTime/endTime（HHMM）
Contract Specs:GOLD_F_0_SFE 0.05 1000 SFE                     ← tickSize/lotSize/exchange
Current Day:2 15 11 115 20151215 ...                          ← 到期/交易日推算
SFE Expiry Date:20151215 / GOLD au / China Symbol: au1512
OverRiding Rollover date and symbol for : GOLD_F_0_SFE with: au1512
Inserted InstruSim: au1512|
GetIndicator: indicator Name=Dependant FUTCOM
Indicator Level: 3 1
```

→ 说明"逻辑合约名 `GOLD_F_0_SFE`"在启动时被 `data/ChinaInstruments` + `data/RolloverOverrideFile` 映射成**真实可交易合约 `au1512`**（`common/Instrument.cpp:415-453,558-...`）。这是"China 版"最实质的本地化改动。

### 2.3 信号与退出（V）

`main.cpp:90-164` 的 `Squareoff(int32_t sig)` 是唯一信号处理体：

| 信号 | 语义 | 动作 |
|---|---|---|
| `SIGTERM` / `SIGRTMIN` / `36` | 按 `../Config/signal.txt` 里列出的品种**选择性**平仓 | 读文件 → 只对命中的 symbol 置 `onExit/onCancel/onFlat` → `HandleSquareoff()` |
| `SIGTSTP` | 全平 | 同上，不看 symbol |
| `SIGUSR1` | 恢复交易 | `onExit/onCancel/onFlat=false; m_Active=true` |
| `SIGUSR2` | 重载阈值 | `LoadThresholds(simConfig)`；期权模式再 `OptionManager::LoadOptionsParams()` |
| `37` / `SIGRTMIN+3` | 强平（对手价 ±1 tick） | 额外置 `m_aggFlat=true` |
| 其它 | 只打日志 | — |

- 符号映射：`36 = SIGRTMIN+2`、`37 = SIGRTMIN+3`（`main.cpp:93` 注释 + `CommonClient.cpp:240`）。
- 所有信号在 `CommonClient::Initialize` 里先被 `sigfillset + pthread_sigmask(SIG_BLOCK)` 屏蔽，只有主线程 `sigwait` 接（`CommonClient.cpp:171-174,1099-1111,236-245`）。
- **信号线程与业务线程无任何锁**：`Squareoff()` 直接改 `m_onExit/m_onFlat/m_Active/m_netpos`，业务线程正在遍历 `m_bidMap/m_askMap` → §8 R4。
- **进程不会"平完就退"**：`HandleSquareoff()` 在净仓 0 且无挂单时只把 `m_Active=false`（`ExecutionStrategy.cpp:2270-2278`），进程继续活着等下一条信号。
- 真正会杀进程的是三处 `exit(1)`：`SetTargetValue` 拒绝超限（`:308`）、`ORDERS_PER_DAY_LIMIT_REJECT`（`:945`）、启动期配置缺失。

### 2.4 Windows vs Linux（V，差异其实很小）

| 维度 | Linux | Windows | 位置 |
|---|---|---|---|
| 进程入口 | `unistd.h` | `<process.h>` + `<signal.h>` | `main.cpp:8-13` |
| 共享内存键 | SysV 数字键：`FO_MD=276`、`CM_MD=3276`、`FO_UPDATES=4276`… | 命名对象 `Global\W2W_ORS_MARKET_DATA` 等 | `CommonClient.h:25-53` |
| 信号 | `sigset_t` + `sigwait` 循环 | 无信号；`SIGTSTP/SIGUSR1` 被宏定义成 `0/1`，`HandleSignals` 只保存回调就返回 | `CommonClient.h:25-27`；`CommonClient.cpp:228-255` |
| 合约描述字段 | 不做 `InstrumentName` 预填 | 先 `strncpy("           ",11)` 再填 | `CommonClient.cpp:921-925` |
| `Per Sec` 拒绝 | 计入 reject | 命中 `"Per Sec"` 时不计 | `ExecutionStrategy.cpp:915-920` |
| 构建 | Makefile + g++ | `Tradebot.sln`/`vcxproj`（VS2010，仅 Win32） | `00-inventory.md §3.3` |

**判断（I）**：Windows 分支是历史遗留（代码祖先 `TradeBot_Russia`，`UpgradeLog.XML`），Linux 才是生产路径；Windows 侧 `HandleSignals` 直接返回意味着 `main()` 会结束，只有在 `StartAsync()` 本身阻塞时才能跑起来 —— 而 Linux 的 `startMonitorAsync*` 明确是**非阻塞起线程**，所以 Windows 版大概率跑不了 Live。标 **P**（未验证，无 Windows 运行产物）。

---

## 3. 核心运行时

### 3.1 数据结构总览

| 结构 | 作用 | 关键字段 | 位置 |
|---|---|---|---|
| `Instrument` | 单个合约的**全部状态**：合约静态属性 + 20 档盘口 + 策略盘口 + 成交累计 + tick | `bidPx[20]/askPx[20]/bidQty[20]`、`bidPxStrat[20]`、`m_level`、`m_symbolID`、`m_lotSize`、`m_tickSize`、`m_priceFactor`、`m_contractFactor`、`m_priceMultiplier`、`totalTradedQty`、`lastTick` | `common/include/Instrument.h:63-416` |
| `Tick` | 一次变化的快照（含 `tickLevel`） | `tickType ∈ {BIDQUOTE,ASKQUOTE,BIDTRADE,ASKTRADE,TRADEINFO,INVALID}`、`tickLevel`、`exchTS`、`symbolID` | `common/include/Tick.h:16-42` |
| `IndElem` | 模型文件里的一行指标（原始字符串 + 实例指针） | `m_baseName/m_type/m_indName/m_coefficient/m_argList[20]/m_indicator` | `main/include/TradeBotUtils.h:218-228` |
| `InstruElem` | 合约 ↔ 指标列表 | `m_instrument`、`m_indList` | `TradeBotUtils.h:230-234` |
| `SimConfig` | **一个策略实例**的全部配置（合约、指标、阈值、日期、PnL、策略对象） | `m_instru`、`m_instruMap`、`m_indicatorList`、`m_tholdSet`、`m_dateConfig`、`m_execStrategy`、`m_calculatePNL` | `TradeBotUtils.h:671-711` |
| `ConfigParams` | **全局单例**：模式、开关、`m_orderIDStrategyMap`、`m_simConfigMap`、`m_instruCBMap`、`m_baseConfigMap`… | 见右 | `TradeBotUtils.h:582-669` |
| `ThresholdSet` | 一个策略的全部阈值（**155** 个字段，构造函数给默认值） | `SIZE/MAX_SIZE/BEGIN_PLACE/CROSS/STOP_LOSS/…` | `TradeBotUtils.h:236-470` |
| `OrderStats` | 一张挂单的本地状态机 | `m_status`、`m_price/m_newprice`、`m_Qty/m_openQty/m_doneQty/m_cxlQty`、`m_quantAhead/m_quantBehind`、`m_ordType` | `Strategies/include/ExecutionStrategyStructs.h:41-70` |
| `DateConfig` | 交易日 + 起止时间 + 激活标志 | `m_startTimeEpoch/m_endTimeEpoch/m_simActive` | `TradeBotUtils.h:523-566` |

**结构层面的两个设计事实：**

1. **`Instrument` 是可变全局状态**：`m_simConfigMap[symbol] → SimConfigList` 让"同一个合约"被多个策略共享（`AddInstrument` 命中已存在时 `delete` 新建的、复用旧指针，`TradeBotUtils.cpp:377-386`）。因此同进程多策略时，盘口/`lastTick` 是共享的，而 `m_indList` 是各自挂上去的。
2. **指标对象被 `IndElem` 裸指针持有，永不释放**（`LoadModelFile` 里 `new IndElem` → `push_back`，没有 `delete`）。这是有意的进程生命周期内存模型，但意味着**重载模型 = 泄漏**（实际没有重载路径）。

### 3.2 行情路径：SHM → Tick → 指标 → 目标价 → 策略

```
[ORS/xsim] --SHM(key 872/10201)--> Connector(infra)
        └─ ShmManager::loopMD() 在同一条 SHM_MD_RESP_THREAD 上
             └─ callback = CommonClient::SendInfraMDUpdate   (main.cpp:1033)
                  ├─ LastMDUpdate::last_update = update      (CommonClient.cpp:335)
                  ├─ endPkt==1 → 可能补一次 IND 回调后 return  (345-360)
                  ├─ 超过 updateInterval → CheckLastUpdate()（陈旧行情告警）(363-367)
                  └─ SendINDUpdate(update)                   (369)
                       ├─ Watch::UpdateTime(...)   （时间轴推进）      (418-421)
                       ├─ m_dateConfig->UpdateActive(now)  （是否在交易时段）(422)
                       ├─ 按 symbolID 找 SimConfigList → 逐策略        (424,437)
                       │    ├─ FEED_AUCTION → AuctionCallBack()        (454-456)
                       │    ├─ 首笔成交判定 / implied trade 去重        (469-489)
                       │    ├─ snapshot/combined/delta/option 分支     (503-712)
                       │    ├─ Update(iter,tick) → QuoteUpdate/TickUpdate  (725,827-843)
                       │    ├─ 未用 endPkt → m_INDCallBack(indicatorList)  (741-752)
                       │    └─ isStratSymbol → m_MDCallBack(update)    (754-755)
                       └─ (endPkt 模式) 在下一包 endPkt 处补 IND 回调    (354-357)  ← 实际永不触发，见 R28
```

要点（V）：

- **"是否触发指标/策略"由 `significantUpdate` 决定**：`tick->tickLevel > instru->m_level` → `significantUpdate=false` → 直接 `return`（`CommonClient.cpp:552-555`）。例外：`DI1*`（巴西 DI）合约 `sendAllUpdates=true`（`178-183`）。
- **`m_level` 是"关心的档数"**，默认 3（`Instrument.cpp:57`），可被模型里的 `MAX_QUOTE_LEVEL` 抬高（`TradeBotUtils.cpp:2034-2035`）；`Tick::SetTickLevel` 把"第几档发生变化"写进 `tickLevel`，最深 50 = 无意义（`common/Tick.cpp:23-34`）。
- **`Update()` 只做两件事**：按 `tickType` 调 `QuoteUpdate` 或 `TickUpdate`；记录 `m_lastInstruMapIter`（供 `CalculateTargetPNL` 取该合约的指标表）。`CommonClient.cpp:827-843`
- **`CalculateTargetPNL` 才是"策略大脑"**（`TradeBotUtils.cpp:3401-3523`）：
  - `depPrice = 依赖指标.value`（首行 `Dependant`）；
  - 遍历**该合约**的指标表，只取 `!isDep && index == m_simConfig->m_index` 的项（即"属于本策略、非依赖"的指标）；
  - `MKTW_PX`：`targetPrice += pxOffset * depPrice / 10000`（基点）；
  - `MKTW_PX2`：`targetPrice += pxOffset`（价格差，单位=价格）；
  - `RATIO`：`targetPrice *= 系数 × 指标值`；
  - `VOL`（期权）：`targetPrice = Option::modelIV → BlackSchole()` 或 delta 递推；
  - 任一指标 `status==false` → 返回 false，本轮**不下单**（`3505-3513`）。
- **`CHECK_PNL` 决定"目标价是否要能赚钱才挂"**：`CHECK_PNL 0` 时直接在 `3572-3573` `return true`，而 `targetBidPNL[]` 保持 `main.cpp:477-481` 初始化的 `1.0` —— 于是**任何价位都算"有正 PnL"**，`GetBidPrice/GetAskPrice` 的 PnL 过滤形同不存在。生产模型正是 `CHECK_PNL 0`（见 §7.2）。

### 3.3 回报路径：ORS → 订单表 → 净仓

```
[ORS] --SHM(key 4872)--> ShmManager::loopResponse()（同一条线程）
   └─ callback = CommonClient::SendInfraORSUpdate            (main.cpp:1034)
        ├─ 非 Live + commonBook + Quantity<0 → 翻转符号/ID+1e6，走 CommonBook (CommonClient.cpp:291-300)
        ├─ 否则 m_ORSCallBack(response) → main.cpp::ORScallback (299)
        │     ├─ useArbStrategy（蝶式）→ 全部丢给当前 m_execStrategy (main.cpp:265-268)
        │     └─ 否则 orderIDStrategyMap.find(OrderID) → 对应策略 ORSCallBack (270-273)
        └─ commonBook 时再投给 m_instruCBMap[symbol]->ORSCallBack (302-311)
```

- 订单表是**每个策略一份**：`ExecutionStrategy::m_ordMap(map<orderID,OrderStats*>)`、`m_bidMap/m_askMap(map<price,OrderStats*>)`（`ExecutionStrategy.h:225-232`）。
- 另有**全局路由表** `ConfigParams::m_orderIDStrategyMap`（`TradeBotUtils.h:662`），在 `SendNewOrder` 里 `insert(m_orderIDStrategyMap.begin(), ...)`，在 `RemoveOrder` 里 `erase`（`ExecutionStrategy.cpp:1405,1008`）。
- **同一个 `ResponseMsg` 只会进一个策略**（除了 commonBook 复制一份）—— 这是"单策略单进程"假设的直接体现。

### 3.4 线程模型

| 线程 | 谁创建 | 干什么 | 证据 |
|---|---|---|---|
| main | 进程 | 解析、构造、`StartAsync()`、随后 `sigwait` | `main.cpp:361,1062,1075` |
| `SHM_MD_RESP_THREAD`（1 条） | `Connector` → `ShmManager::startMonitorAsyncMarketDataAndResponse` | `loopMD()` + `loopResponse()` 交替；**MD 回调、指标、下单、回报、PnL 全在这里** | `Ipc/include/shmmanager.h:712-758`；`Connector/src/connector.cpp:431-448` |
| `VolUpdate`（可选，`-DVOLTHREAD`） | `pthread_create` in `Initialize` | 期权 vol/greeks 重算，`sem_wait/sem_post` 与主线程同步 | `CommonClient.cpp:68-142,185-190` |
| logger（`-DLOGGER`） | `Logger::InitLogger`（infra） | 异步写策略日志 | `main.cpp:428-432` |
| Connector 内部 | infra | SHM 读、xsim 仿真 | — |

**结论（V+I）**：业务逻辑是**事实上的单线程**，所以基类里那些 `m_reqMsg` 复用、`m_level` 复用、无锁 map 遍历是"能用"的；一旦开 `VOLTHREAD`（会从另一线程读 `execStrategy->m_volParams`、`option->lastTargetPx`）或从信号线程改状态，就出现真实竞态。见 §8 R4/R5。

---

## 4. 策略层

### 4.1 基类契约（`Strategies/include/ExecutionStrategy.h`）

纯虚/可覆盖：

| 成员 | 类型 | 基类是否实现 | 子类典型用法 |
|---|---|---|---|
| `SendOrder()` | **纯虚** | 否 | 每个策略唯一的必需实现 |
| `MDCallBack(up)` | virtual | 是（更新 `m_ltp/m_exchTS`、按需 `CalculatePNL`、`CheckSquareoff`） | 少数前置/后置调用基类 |
| `ORSCallBack(resp)` | virtual | 是（订单状态机，见 §5.3） | 蝶式/延迟策略覆盖做多腿路由 |
| `AuctionCallBack(up)` | virtual | 是（BOVESPA 集合竞价强平） | 基本不覆盖 |
| `SetThresholds()` | virtual | 是（离散阈值） | 被动类策略重写 |
| `SetLinearThresholds()` | virtual | 是（按净仓线性插值） | `PASSIVE/RETAGG/HIT` 用 `USE_LINEAR_THOLD` 时走这条 |
| `SetTargetValue()` | virtual | 是（保存目标价 + 拒绝计数 + 调 `SendOrder`） | `AggReturn` 覆盖 |
| `HandleSquareoff()` | **非虚**（`ExecutionStrategy.h:43`） | 是 | 蝶式在派生类里写了 `virtual void HandleSquareoff()`，但**不构成覆盖**（基类非虚），见 §4.4/R26 |
| `SendNewOrder/SendModifyOrder/SendCancelOrder` | 非虚 | 是 | `ExtraStrategy` 重载成"带 Instrument 参数"的版本 |
| `GetBidPrice/GetAskPrice` | 非虚 | 是（cross/improve 判定） | 不覆盖 |
| `OnTradeUpdate()` | virtual，空实现 | 是 | `BondsPassive/Comms` 用 |

**基类构造里就完成的事**（`ExecutionStrategy.cpp:22-90`）：

1. `m_endTime = dateConfig.m_endTime - 180000`（收盘前 3 分钟），`m_endTimeAgg = endTime - 60000`（收盘前 1 分钟）；
2. 读 `../Config/StrategyConfig.cfg`：`ACCOUNT`、`MAX_POS_SIZE`、`MAX_ORDERS` → `m_account/m_maxPosSize/m_maxOrderCount`，再按 `sendInLots` 换算 `m_maxTradedQty`；
3. `m_thold->MAX_PRICE/MIN_PRICE *= m_instru->m_priceFactor`（**就地改阈值，乘以价格因子**）；
4. `Reset()` 把 ~80 个成员一次性归零（`104` 行单行赋值，其中 `m_onMaxPx ;` 是**无效语句**）；
5. `SetCheckCancelQuantity()`：只有 `FORTS/KRX/SFE/SGX` 认为"撤单确认带回数量"（`:92-100`）；
6. Live 模式取 `gethostname()` 写进告警邮件正文。

### 4.2 共享机制 vs 各策略覆盖

**所有策略共享（基类提供）：**

- 三张表 + 状态机：`m_ordMap / m_bidMap / m_askMap`，`NEW_ORDER → NEW_CONFIRM → (MODIFY_*/CANCEL_*/TRADED/NEW_REJECT)`；
- `m_quantAhead/m_quantBehind` 排队量估算（`ORSCallBack` 里 `NEW_ORDER_CONFIRM` 时按盘口档位赋值，`:824-844`；`SetQuantAhead` 按 trade/delete/add 事件衰减）；
- 目标价/PnL：`CalculatePNL()`、`CalculatePNL(buy,sell)`、`m_realisedPNL/m_unrealisedPNL/m_netPNL/m_drawdown`；
- 风控：`CheckSquareoff()`（每次 MD）、`SetTargetValue()`（每次目标价刷新）；
- 平仓：`HandleSquareoff()` / `HandleTimeLimitSquareoff()`；
- self-book：`m_bidMapCache/m_askMapCache/m_bidMapCacheDel`（`-selfBook 1` 时把自己挂单从盘口剔除）；
- 告警：`SendAlert()`（`mailx`）；
- 日志：`TBRequestMsgSerializer/TBResponseMsgSerializer`（`-DLOGGER`）。

**子类改动量的分布（V，行数即复杂度）：**

| 策略文件 | 行数 | 覆盖 | 一句话逻辑 |
|---|---|---|---|
| `PassiveStrategy.cpp` | 174 | `SendOrder` | 目标价上下 `BEGIN_PLACE/LONG_PLACE/SHORT_PLACE` 挂多档，超过 `*_REMOVE` 撤；支持 `SUPPORTING_ORDERS` 上限与"先撤最低再挂更高" |
| `AggressiveStrategy.cpp` | 111 | `SendOrder` | **每次调用先撤光所有 NEW_CONFIRM**，然后用对手价 `askPx[0]`/`bidPx[0]` 判断 `bidDiff > thold` 就吃；`PAUSE` 控制同向连发；`OPP_QTY` 过滤对手盘过厚 |
| `AggressivePassiveStrategy.cpp` | 275 | `SendOrder`+4 个内部函数 | 净仓 0 → 双边主动；净仓 >0 → 主动买 + 被动卖；反之对称；被动侧带 `TARGET_DELTA × HISTORICAL_STDDEV` 的"目标价移动才换价"门限 |
| `CommsPassiveStrategy.cpp` | 302 | `SendOrder`+`OnTradeUpdate`+`AnalyseOrders`+8 个 helper | **`BondsPassiveStrategy` 的近似拷贝**（见 §8 R12）：分层挂单/撤单、supporting orders 定时刷新（`support_interval`） |
| `BondsPassiveStrategy.cpp` | 318 | 同上 + `MDCallBack` | 在 Comms 基础上多"冷却/允许买/允许卖"状态机（`PRICE_COOLOFF`） |
| `DepPassiveStrategy.cpp` | 181 | `SendOrder` | 依赖型（价差）被动：用 `m_targetPrice` 与盘口距离挂单 |
| `DepAggressivePassiveStrategy.cpp` | 249 | `SendOrder`+内部 | 依赖型主动/被动混合，`bidCross/askCross` 按净仓方向加 `CROSS` |
| `FAKStrategy.cpp` | 100 | `SendOrder` | 全部用 `CROSS`（Fill-And-Kill）：`askPx + CROSS_TICKS×tick` 立即成交，未成交即废 |
| `SweepStrategy.cpp` | 151 | `SendOrder`+`PlaceLowLevelOrders` | 在 `SWEEP_PLACE_LEVEL` 起逐档铺 `MAX_OS_ORDER` 张单，专吃扫单（sweep）后的回补 |
| `HitStrategy.cpp` | 559 | `SendOrder`+5 个内部 | 用"系数为 0 的指标"当**信号**（`ConfigParams::signalInd`），信号 > `BEGIN_PLACE` 主动买、< 负值主动卖，之后被动减仓 |
| `AntiDimeStrategy.cpp` | 216 | `SendOrder` | 反"dime"（跟一档）：对手盘过厚时撤同侧单，按 `bidDiff/askDiff` 决定挂/撤 |
| `PassiveStrategyAE.cpp` | 347 | `SendOrder` 等 | "AE"版被动：带 `AHEAD_PERCENT/AHEAD_SIZE/SZAHEAD_NOCXL/BOOKSZ_NOCXL` 的排队量条件撤单 |
| `PassiveStrategyPNL.cpp` | 261 | 构造函数带 `true` | 在被动基础上用 PnL 门限 |
| `ModifyStrategy.cpp` | 172 | `SendOrder` | 大量 `SendModifyOrder` 而非撤+新（省消息） |
| `MovingStdStrategy.cpp` | 420 | `SendOrder`+`SetThresholds` | 目标价 ±`LOCAL_STD` 动态带宽 |
| `DynamicStdevStrategy.cpp` | 368 | 同上 | 双窗口 std（`STDDEV_LP/LR/BP/BR/SP/SR`）门限 |
| `UniformStrategy.cpp` | 409 | `SendOrder`+`MDCallBack` | 把目标价映射成 [0,1] 报价强度，按 `highthold/lowthold` 挂 |
| `AggReturnStrategy.cpp` | 230 | `SetTargetValue`+`SendOrder` | 以"预期收益"（而非价格差）为门限 |
| `TargetStrategy.cpp` | 202 | `SendOrder` | 目标价即挂单价，逐档追 |
| `SpreadStrategy.cpp` | 160 | `SendOrder` | 双边价差报价 |
| `VWAPStrategy.cpp` | 251 | `SendOrder` | 按 `VWAP_RATIO/VWAP_COUNT/VWAP_DEPTH` 跟 VWAP |
| `LatencyStrategy.cpp` | 59 | `MDCallBack`+`ORSCallBack` | 测延迟用：2 秒撤单、拿到回报即 `exit(1)` |
| `OptionQuotingStrategy.cpp` | 587 | `SendOrder` | 期权做市：`theo = targetPrice`，按 `delta/vega/quoteWidth/hedgeWidth` 生 bid/ask，挂不中即 cross |
| `HedgingStrategy.cpp` | 307 | `SendOrder` | delta/vega 组合对冲，按 score 队列选标的 |
| `SimpleHedgingStrategy.cpp` | 60 | `SendOrder` | 单标的 delta 对冲：`totalDelta = portDelta + netpos`，abs(Δ)>`deltaHedgeThreshold` 就反向市价 |
| `EquityQuotingStrategy.cpp` | 176 | `SendOrder` | 股票报价，用 `m_thold->MAX_ORDERS` 限制未成交单数（**唯一用它的人**） |
| `SuppTailStrategy.cpp` | 634 | `SendOrder`+内部 | "support tail"：给大单尾盘提供流动性 |
| `ButterflyStrategy.cpp` | 737 | 全套（见 §4.4） | 三腿蝶式，唯一存活的多品种策略 |
| `ExtraStrategy.cpp` | 593 | 重载全部交易原语 | **不是策略**：给蝶式做"单腿容器"，每个 `ExtraStrategy` 有自己的 `m_ordMap/m_bidMap` |

### 4.3 策略工厂：一条 31 分支的 if-else（`main/main.cpp:698-843`）

| 行 | 字符串 | 类 | 生产使用 |
|---|---|---|---|
| 702 | `TB_PASSIVE_STRAT` | `PassiveStrategy` | 1 |
| 706 | `TB_BONDS_PASSIVE_STRAT` | `BondsPassiveStrategy` | 0 |
| 710 | `TB_COMMS_STRAT` | `CommsPassiveStrategy` | **406** |
| 714 | `TB_HIT_STRAT` | `HitStrategy` | 0 |
| 718 | `TB_DIME_STRAT` | `AntiDimeStrategy` | 0 |
| 722 | `TB_FAK_STRAT` | `FAKStrategy` | 6 |
| 726 | `TB_EQ_QUOTE_STRAT` | `EquityQuotingStrategy` | 0 |
| 730 | `TB_DEP_PASSIVE_STRAT` | `DepPassiveStrategy` | 0 |
| 734 | `TB_DEP_AGGPASS_STRAT` | `DepAggressivePassiveStrategy` | **41** |
| 738 | `TB_PASSIVE_STRAT_NEW` | `PassiveStrategyPNL(…,true)` | 0 |
| 742 | `TB_PASSIVE_STRAT_AE` | `PassiveStrategyAE` | 0 |
| 746 | `TB_MODIFY_STRAT` | `ModifyStrategy` | 0 |
| 750 | `TB_SWEEP_STRAT` | `SweepStrategy` | 0 |
| 754 | `TB_SIMPLEAGGRESSIVE_STRAT` | `SimpleAggressiveStrategy` | 0 |
| 758 | `TB_AGGRESSIVE_STRAT` | `AggressiveStrategy` | **1172** |
| 762 | `TB_IND_AGGRESSIVE_STRAT` | `AggressiveStrategyInd` | 0 |
| 766 | `TB_AGGRESSIVEPASSIVE_STRAT` | `AggressivePassiveStrategy` | **380** |
| 770 | `TB_MOVINGStd_STRAT` | `MovingStdStrategy` | 0 |
| 773 | `TB_DYNAMIC_STDEV_STRAT` | `DynamicStdevStrategy` | 0 |
| 776 | `TB_UNIFORM_STRAT` | `UniformStrategy` | 0 |
| 779 | `TB_RETAGG_STRAT` | `AggReturnStrategy` | 0 |
| 782 | `TB_TARGET_STRAT` | `TargetStrategy` | 0 |
| 785 | `TB_SPREAD_STRAT` | `SpreadStrategy` | 0 |
| 788 | `VWAP_STRAT` | `VWAPStrategy` | 0 |
| 791 | `LATENCY_STRAT` | `LatencyStrategy` | 0 |
| 794 | `TB_OPTION_QUOTING_STRAT` | `OptionQuotingStrategy` | 0 |
| 797 | `TB_HEDGING_STRAT` | `HedgingStrategy` | 0 |
| 800 | `TB_SIMPLEHEDGING_STRAT` | `SimpleHedgingStrategy` | 0 |
| 803 | `TB_SUPPTAIL_STRAT` | `SuppTailStrategy` | 0 |
| 806 | `BUTTERFLY_STRAT` | `ButterflyStrategy` + `useArbStrategy=1` | 0 |
| 811 | `NO_STRAT` | `NULL`（只跑指标/告警） | 0 |
| 815 | 其它 | `TBLOG("Strategy not found") + exit(1)` | — |

**编译进来但永远构造不到 / 根本没编：**

- `PauseStrategy.cpp` 在 `Strategies/Makefile:19` 编译，但 `main.cpp` 只有 `#include`（`:29`），**没有工厂分支** → 死代码。
- 7 个 `.cpp` **没有对应 `.o`**（从未参与构建）：`LeadLagStrategy`、`MeanRevertingAggressiveStrategy`、`MeanRevertingPassiveStrategy`、`MultipleInstrumentExecutionStrategy`、`MultipleInstrumentStrategy`、`PairwiseArbStrategy`、`SymbolSpecificExecution`。【V】`for f in *.cpp; [ -f ${f%.cpp}.o ] || echo` 输出即此 7 个
- 与 `main.cpp:820-840` 的"多品种策略"整段被 `/* */` 注释完全吻合 —— **r2375 的多品种框架是半拆除状态**（除蝶式）。

### 4.4 唯一存活的多品种：Butterfly（三腿）

`ButterflyStrategy`（`Strategies/ButterflyStrategy.cpp`）：

- 构造函数建 3 个 `ExtraStrategy` 当"腿容器"，把 `m_instru` 分别指向 `m_instru/m_instru_sec/m_instru_third`，并用三个独立的 `m_ordMap/m_bidMap/m_askMap`（`ButterflyStrategy.cpp:8-62`）。
- **仓位恢复**：`LoadPositions(date, strategyID)` 读 `../data/positions<strategyID>`（空格分隔：`date t1 t2 t3 px1 px2 px3`），把昨日三腿净仓灌回 `m_netpos/m_buyTotalQty`，并用昨收价初始化 `m_buyValue/m_sellValue` 以算隔夜 PnL（`:64-91,262-...`）。
- **指标**：`fly = w1*p1 + w2*p2 + w3*p3`（`Index_Value`，`:94-128`），`p_i` 是**微价**（`ask*bidQty + bid*askQty)/(bidQty+askQty)`，再按时间加权平滑 `smooth_fly`；`index_ready` 需累积 `duration`。
- **报价**：`GetLeaderPrice(smooth_fly)` 反解 leader 腿的 bid/ask（按 w2/w3 的正负分 4 种组合，`:131-227`），再对齐到 tick（`sell_px_level/buy_px_level` 用 for 循环数出来的 —— 效率极低但语义正确）。
- **回报路由**：`ORSCallBack` 先按 `m_ordMap1/2/3` 判断这条回报属于哪条腿，再调对应 `ExtraStrategy::ORSCallBack`，并用 `multiplier=|wi|/wi` 累计 `traded_fly_value`（`:515-578`）。
- **落盘**：`MDCallBack` 每次都调 `SavePositions()`，只有过了 `m_endTimeAggEpoch` 才真正写 `../data/final_positions_<date>_<id>` 与 `../data/final_PNL_<date>_<id>`（`:504-577,579-669`）。
- **三个"看起来存在、实际不生效"的机制（V）**：
  1. `ButterflyStrategy::HandleSquareoff()`（`:671-691`）**永远不会被调用** —— 基类 `ExecutionStrategy::HandleSquareoff()` 不是虚函数（`ExecutionStrategy.h:43`），`main.cpp:132,150` 与 `ExecutionStrategy.cpp:593,2228` 都是通过基类指针/基类作用域调用的；
  2. 因此它内部"第三腿传成 `m_secondinstru`"的 bug（`:687`）目前是**死代码里的 bug**；
  3. 三条腿用的是 `ExtraStrategy`，其 `MDCallBack` 里 `//CheckSquareoff(up)` 是**注释掉的**（`ExtraStrategy.cpp:475`）→ 蝶式**没有任何自动平仓/停损检查**；`SavePositions` 里置 legs 的 `onFlat` 也只是置标志，legs 不会自己报价（`ExtraStrategy::SendOrder` 为空）。

> 这就是"多品种/配对逻辑"在 r2375 的全部真相：**配对框架只以蝶式一种形态活着，且只按"腿容器 + 手工乘数"实现，没有通用的 `Pair`/`Leg` 抽象**。`PairwiseArbStrategy.cpp`（49 KB）虽然存在，但未编译、无工厂分支。

### 4.5 期权/对冲路径（V，仅在 `-optionStrategy 1|2` 时启用）

- `OptionManager`（`common/OptionManager.cpp`，550 行）是**单例 + 全局组合状态**：`m_optionMap/m_underlyingMap`、`m_portDelta/m_portVega/m_portPnl`、`hedgeScoreQueue/iocScoreQueue`、几十个 `useDeltaAdj/parityMode/volCalcMode/...` 开关，全部来自 `../data/OptionsParams`（`LoadOptionsParams`）。
- 行情侧：`SendINDUpdate` 里对 underlying 调 `Option::QuoteUpdate/TickUpdate`，对每个 option 调 `parity->...`；`ProcessTrade` 后调 `OptionManager::PortfolioGreeks()`（`ExecutionStrategy.cpp:1986-2001`）。
- 目标价侧：`m_priceType==VOL` 时 `targetPrice = Option::modelIV → BlackSchole()`，`useDeltaAdj` 时用 `(parity_now - parity_last)*delta + lastTargetPx` 递推（`TradeBotUtils.cpp:3468-3498`）。
- 对冲侧：`SimpleHedgingStrategy` 用 `portDelta + netpos` 与 `deltaHedgeThreshold` 比较后反向吃掉（`SimpleHedgingStrategy.cpp:14-40`）。

> 生产 controls 里**没有任何** `TB_OPTION_QUOTING/TB_HEDGING/BUTTERFLY` 记录（§4.3 计数为 0）→ 期权链路是"能编译、逻辑完整、但没有 2015 年运行证据"的部分。标 **I**。

---

## 5. 订单 / 仓位 / PnL

### 5.1 订单对象与三张表（V）

`OrderStats`（`ExecutionStrategyStructs.h:41-70`）字段语义：

| 字段 | 含义 |
|---|---|
| `m_status` | `NEW_ORDER→NEW_CONFIRM→{MODIFY_ORDER→MODIFY_CONFIRM/MODIFY_REJECT, CANCEL_ORDER→CANCEL_CONFIRM/CANCEL_REJECT, TRADED, NEW_REJECT}` |
| `m_Qty` | 当前"有效总量"（改单确认后 = `m_newQty`） |
| `m_openQty` | 未成交量；**成交时先减、撤单确认时再减** |
| `m_doneQty` | 已成交量（改单时作为 `QuantityFilled` 上送） |
| `m_cxlQty` | 已撤量（self-book 用） |
| `m_quantAhead/m_quantBehind` | 同价位"我前面/后面"的量，用于 `USE_AHEAD_PERCENT/SZAHEAD_NOCXL` 决策 |
| `m_ordType` | `STANDARD / IMPROVE / CROSS / DETECT` |

三张表的分工：

| 表 | 键 | 用途 |
|---|---|---|
| `m_ordMap` | `uint32_t orderID` | 主表，回报按 ID 查 |
| `m_bidMap` / `m_askMap` | `double price` | **同价只允许一张单**（`SendNewOrder` 若价已存在直接 `return m_ordMap.end()`，`ExecutionStrategy.cpp:1329-1330`），也是"按价撤单"的索引 |
| `m_sweepordMap` | orderID | 仅 `sweepStrategy` + `CROSS` 单的旁路表（`:1400-1403`） |

> **设计后果**：因为 `m_bidMap` 以价格为键，**同价改量必须走 modify**，不同价改单必须"先撤旧价、再插新价"（`SendModifyOrder` 会把新价插进 map，旧价由 `MODIFY_CONFIRM` 里 `erase`，`:1483-1516,1767-1790`）。

### 5.2 订单 ID 与路由

- `ExecutionStrategy::SendNewOrder()` 把 `OrderID` 传 **0**，由 Connector 分配并返回（`ExecutionStrategy.cpp:1351`；`CommonClient::SendNewOrder` 里 `OrderID = m_connector->SendNewOrder(m_reqMsg)`，`CommonClient.cpp:957`）。
- 新单在**发出去之后**才插入三张表 + 全局路由表（`1405`）→ 若回报在"插入"之前到达就是"Response OrderID not found"。因为同一线程串行执行，实际不会发生（**I**）。
- `RemoveOrder()` 同时清 `m_bidMap/m_askMap`、`m_sweepordMap`、`m_orderIDStrategyMap`、`m_ordMap`（`:978-1015`）；self-book 打开且非 snapshot 时**故意不删 `m_ordMap`**，只置 `m_cancel=true`，等 `CANCEL_CONFIRM` 再删（`:1001-1014`）。
- 蝶式以外的多品种没有任何"按合约分表"机制 —— `m_bidMap` 的价格键在多合约下会互相覆盖，这也是多品种框架被拆掉的原因之一（**P**）。

### 5.3 下单 / 改单 / 撤单实现细节

**下单**（`ExecutionStrategy.cpp:1322-1438` → `CommonClient.cpp:909-970`）：

1. 价格查重 → 计数/开仓量累加（`m_buyOpenOrders/m_buyOpenQty`）；
2. `isBidOrderCrossing` 为真时强制 `ordtype=CROSS`；
3. `CommonClient::SendNewOrder` 填 `m_reqMsg`：
   - `Request_Type=NEWORDER`、`Token`、`Transaction_Type`（`BUY→SIDE_BUY`）、`Price`、`Quantity`、`DisclosedQnty=Quantity`；
   - `AccountID`：先 `memcpy("          ",10)` 再用 `strlen(Account)` 覆盖（**不检查长度**）；
   - `Contract_Description.Symbol`：`memcpy(..., strlen(ticker))`（**不检查长度**）；
   - `Duration`：`CROSS → FAK`，否则 `DAY`（`:950-953`）；
   - `OrdType=LIMIT`、`PxType=PERUNIT`、`Exchange_Type`（`FillReqInfo`，`:1088-1097`）。
4. 插入本地表 → `m_orderCount++`。

**改单**（`:1483-1572`）：不改 ID；`m_status=MODIFY_ORDER`；新价插入 map；`m_buyOpenQty += (qty - m_Qty)`；`m_modify/m_modifywait` 记录"改单中"；`MODIFY_CONFIRM` 时把 `m_price/m_Qty/m_openQty` 换成新值并 `erase` 旧价（`:1784-1789`）。

**撤单**（`:1600-1683`）：
- `CROSS` 单**不允许撤**（`:1618-1620`，FAK 本来就是即死）；
- 只有 `NEW_CONFIRM/MODIFY_CONFIRM/MODIFY_REJECT` 可撤；
- **撤单被拒后的退避**：`m_lastCancelReqRejectSet/m_lastCancelRejectOrderID/m_lastCancelRejectTime` + `CANCELREQ_PAUSE`（`:1621-1626`）—— 这是唯一针对"撤单风暴"的节流；
- 撤单失败/被拒不重试，靠下一轮 `SendOrder` 重新评估。

**成交后**：`ProcessTrade`（`:1863-2002`）：
- `m_openQty -= qty; m_doneQty += qty`；
- 累加 `m_buyTotalQty/m_buyValue/m_buyAvgPrice`（或 sell 侧）；
- `m_netpos = m_buyTotalQty - m_sellTotalQty`；
- `m_netpos == 0` 时结算 `m_realisedPNL` 并**清零 `m_buyValue/m_buyQty/m_sellValue/m_sellQty/m_transValue`**（`:1937-1956`）；
- `m_openQty == 0` → `m_status=TRADED` + `RemoveOrder`；`m_openQty < 0` → **`assert(0)`**（`:1981-1984`，release 下也会 abort，因为 Makefile 没定义 `NDEBUG`）。

### 5.4 PnL 公式（V）

单笔"买@buy、卖@sell"：

```
PNL = (sell - buy - buyTx*buy - sellTx*sell) * priceMultiplier
      - (buyContractTx + sellContractTx)                            // ExecutionStrategy.cpp:1023
priceMultiplier = sendInLots ? lotSize : 1
                  * contractFactor / priceFactor                    // Instrument.cpp:407-408
```

持仓：

```
netpos>0: UPNL = netpos * ((bid0 - buyPrice - bid0*sellTx)*mult - sellContractTx)
netpos<0: UPNL = -netpos * ((sellPrice - ask0 - ask0*buyTx)*mult - buyContractTx)
UPNL += qty * (sellPrice - buyPrice) * mult      // qty = 已平掉的那部分
UPNL -= m_transValue                              // 本轮已发生的交易成本
GROSS = realised + UPNL
NET   = GROSS - m_transTotalValue                 // 累计成本
maxPNL = max(maxPNL, NET); drawdown = NET - maxPNL
```

`m_realisedPNL` 只在**净仓回到 0** 时被覆盖（所以它是"上一轮完整往返"的已实现盈亏，不是累计已实现 —— 若一轮未平完就再开，之前的 realized 会被下一次归零覆盖）。这是"单轮往返"记账，不是"账户级"记账。**（V，语义解释为 I）**

### 5.5 持久化与"daily_init"的真相

- **r2375 里没有 `daily_init` 这个符号**（`grep -rn daily_init` 在 `3/TradeBot/TradeBot_China`、`3/TradeBot.bak/TradeBot_Multi`、`3/tempTradeBot` 三处均为空）。任务描述里的 "daily_init" 在本版本**不存在**。
- 唯一的仓位持久化在蝶式：`../data/positions<strategyID>`（读）/ `../data/final_positions_<date>_<id>`、`../data/final_PNL_<date>_<id>`（写）。【V】`ButterflyStrategy.cpp:70,610-663`
- 普通策略**不落仓位**：每天靠 `--squareOff` 或收盘前自动平仓保证"隔夜为零"。日切是**运维脚本**完成的：
  - `livescripts/CopyControlsModels <old> <new>`：把 `control.*.old`/`model.*.old` 复制成新日期名、`bckp/` 备份、并把 `RunStrategies*.sh` 里的日期 `sed` 掉；【V】`3/TradeBot/livescripts/CopyControlsModels:1-40`
  - `livescripts/RunStrategies.sh`：每个策略一行 `nohup taskset -c <core> TradeBot --Live --controlFile … --configFile … --logFile …`。【V】
- 进程级"我跑过"的痕迹本应是 pid 文件：Live 模式下往 `/home/TradeBot/TradeBot/data/pid.<currDate>` **追加** `"<strategyID> <pid>"`（无换行、无锁、无清理）。但**该目录不存在**（真实源码/数据目录是 `/home/TradeBot/TradeBot_China`，见 §9.5 的 cwd），`ofstream.open` 失败被忽略 → `3/TradeBot` 下 `find -name 'pid.*'` **没有任何产物**。【V】`main.cpp:681-690`；`find 3/TradeBot -maxdepth 3 -name 'pid.*'`（空）

### 5.6 squareoff 的 4 条触发路径

| 触发 | 入口 | 行为 |
|---|---|---|
| 收盘前 3 分钟 | `CheckSquareoff` → `now >= m_endTimeEpoch` | 置 `onExit/onCancel/onFlat`，被动价平（`askPx[0]`/`bidPx[0]`） |
| 收盘前 1 分钟 | `CheckSquareoff` → `now >= m_endTimeAggEpoch` | 置 `aggFlat`，**对手价 ±1 tick + CROSS**（`HandleSquareoff:2295-2296,2349-2358`） |
| 信号 | `Squareoff()`（§2.3） | 按 symbol 选择或全量，可 agg |
| 外部工具 | `--squareOff 1` + `model.squareoff.list` | **不起策略报价**，直接把 netpos 灌进 `m_netpos` 并置 `onFlat`，只做平仓（`main.cpp:907-944`） |

`HandleSquareoff()` 的实际动作（`:2264-2362`）：

1. 净仓 0 且无挂单 → `m_Active=false`（不退出）；
2. `m_askMap/m_bidMap` 里**价格比平仓价更差**的单 → 撤；
3. 两侧都空了 → 用净仓量发一张 `CROSS`（agg）或对手价（非 agg）单；
4. `m_rmsQty` 非 0 时限制单次平仓量（RMS 拒绝后减半）。

`HandleTimeLimitSquareoff()`（`:2367-2430`）：`SQROFF_TIME` 到期后的"最后一笔成交超时"平仓，**单次最多 `m_tholdBeginPos`**，可分批。

---

## 6. 风控与健康检查

### 6.1 阈值清单（`ThresholdSet`，模型文件里的 KEY VALUE）

| 类别 | 键 | 作用点 |
|---|---|---|
| 仓位 | `SIZE`、`BEGIN_SIZE`、`MAX_SIZE`、`PERCENT_SIZE/PERCENT_LEVEL`、`NOTIONAL_SIZE/NOTIONAL_MAX_SIZE` | `SetThresholds/SetLinearThresholds`（`ExecutionStrategy.cpp:328-514`）→ `m_tholdSize/m_tholdMaxPos` |
| 报价距离 | `BEGIN_PLACE/BEGIN_REMOVE`、`LONG_PLACE/LONG_REMOVE`、`SHORT_PLACE/SHORT_REMOVE`、`*_PLACE_HIGH` | 同上；`USE_LINEAR_THOLD` 时按净仓线性插值 |
| 主动/跨价 | `CROSS`、`CLOSE_CROSS`、`CROSS_TICKS`、`CROSS_TARGET`、`MAX_LONG_CROSS/MAX_SHORT_CROSS`、`IMPROVE`、`CLOSE_IMPROVE` | `GetBidPrice/GetAskPrice`（`:1027-1239`） |
| 节奏 | `PAUSE`、`CANCELREQ_PAUSE`、`AGG_COOL_OFF`、`PRICE_COOLOFF`、`SQROFF_TIME`、`SQROFF_AGG` | 策略内 time-diff 判断 |
| 亏损 | **`UPNL_LOSS`、`STOP_LOSS`、`MAX_LOSS`** | `CheckSquareoff`（`:2047,2170-2193`） |
| 价格带 | `MIN_PRICE/MAX_PRICE` + `USE_PRICE_LIMIT` | `CheckSquareoff`（`:2131-2168`），`m_targetPrice` 的 50 秒均值（注释写 20 秒，见 R19） |
| 单量/单数 | `SUPPORTING_ORDERS`、`MAX_ORDERS`、`MAX_OS_ORDER`、`TAILING_ORDERS` | 各策略 + `EquityQuotingStrategy:100,154` |
| 盘口条件 | `OPP_QTY`、`SUPP_TOLERANCE`、`AHEAD_PERCENT/AHEAD_SIZE`、`SZAHEAD_NOCXL/BOOKSZ_NOCXL`、`AGGFLAT_BOOKSIZE/BOOKFRAC` | `SetQuantAhead`、`PassiveStrategy`、`HandleSquareoff:2298-2304` |
| 期权 | `DELTA/DELTA_HEDGE/TARGET_DELTA/MIN_EXTR_IND` | 期权策略 |
| 统计 | `STAT_DURATION_SMALL/LONG`、`STAT_TRADE_THRESH`、`STAT_DECAY` | `GetInstrumentStats`（`:137-159`）→ `SET_HIGH` 切换 `*_PLACE_HIGH` |
| 开关 | `CHECK_PNL`、`CLOSE_PNL`、`QUOTE_MAX_QTY`、`NEWS_FLAT`、`USE_NOTIONAL`… | 见 §3.2 |

**代码里还有一套不写在模型里的硬限制**（`ExecutionStrategy.cpp:16-19,64-68` + `Config/StrategyConfig.cfg`）：

| 限制 | 默认（代码） | 实际（`Config/StrategyConfig.cfg:1-4`） |
|---|---|---|
| `MAX_POS_SIZE` | 10,000,000 | 1,000,000 |
| `MAX_ORDERS`（当日下单数） | 5,000,000,000 | **450** |
| 拒绝上限 `REJECT_LIMIT` | 200（硬编码） | 不可配 |
| 账户默认 | 代码宏 `ACCOUNT`（`ExecutionStrategy.cpp:16`） | `Config/StrategyConfig.cfg:1`（值不在此复述；`--configFile` 里的 `ACCOUNT` 会再覆盖，`main.cpp:899-903`） |

> 450 这个数字是理解生产行为的关键：**主动策略每次 `SendOrder` 都先撤后挂**（`AggressiveStrategy.cpp:29-43`），一波行情就能吃掉几十个 order 额度；450 意味着**当天最多 450 张新单**（撤单不计数）；按主动策略每次重报价 1–2 张新单估算，**约 200–400 次重报价就会撞线**并进入平仓（`CheckSquareoff:2055-2056`）。这与 `REJECT_LIMIT=200` 的 100/200 两级告警共同构成"当天能折腾多少次"的硬预算。

### 6.2 谁在哪里检查什么

| 检查 | 位置 | 触发频率 | 后果 |
|---|---|---|---|
| 目标价是否有效（指标 `status`） | `CalculateTargetPNL:3505-3513` | 每次 IND 回调 | 返回 false → 不调 `SetTargetValue` → 不报价 |
| 拒绝次数 > 100 | `SetTargetValue:264-272` | 每次目标价刷新 | 置 `onExit/onCancel/onFlat` + 邮件 |
| 拒绝次数 > 200 | `SetTargetValue:303-309` | 同上 | **`exit(1)`** |
| RMS 数量/金额/开单数/持仓超限 | `ORSCallBack:880-895` | 每次 RMS 拒绝 | 强平 + `m_rmsQty` 置为净仓（后续减半） |
| 当日下单数超限警告 | `ORSCallBack:935-941` | 每次 | 平仓 |
| 当日下单数超限拒绝 | `ORSCallBack:942-946` | 每次 | **`exit(1)`** |
| 结束时间 | `CheckSquareoff:2038-2070` | 每次 MD | 先 agg（-60s）后普通（-180s） |
| 最大亏损 / 未实现亏损 | `CheckSquareoff:2047-2054,2170-2193` | 每次 MD | 平仓，并把阈值**翻倍**（见 R8） |
| 价格带（50s 均值） | `CheckSquareoff:2131-2168` | 每次 MD | 平/恢复 |
| delta 带 | `CheckSquareoff:2078-2106` | 每次 MD（期权） | 平/恢复 |
| 收藏/新闻 | `CheckSquareoff:2195-2201` | 每次 MD | 平 |
| 行情陈旧 | `CommonClient::CheckLastUpdate:384-405` | **有新行情到达、且距上次更新 > `m_updateInterval`（默认 120s，`-updateInterval` 可改）时**，再逐合约比对 `lastLocalTime` | `mailx` 告警 + 对该策略置平仓标志（**不 exit、不主动撤挂单**） |
| 集合竞价 | `AuctionCallBack:585-598` | `FEED_AUCTION` | 仅 BOVESPA：强平 + 告警 |
| 撤单被拒退避 | `SendCancelOrder:1621-1626` | 每次撤单 | 同 ID 在 `CANCELREQ_PAUSE` 内不再撤 |
| 单笔 PnL < 0 不挂 | `GetBidPrice/GetAskPrice` | 每次报价 | 除非 `CHECK_PNL 0`（§7.2） |

### 6.3 拒绝处理状态机（`ORSCallBack:778-965`，V）

```
NEW_ORDER_CONFIRM  → 状态置位；按盘口档位初始化 quantAhead；m_rejectCount=0
MODIFY_ORDER_CONFIRM → 换价/换量；m_rejectCount=0
CANCEL_ORDER_CONFIRM → 减 openQty；可能 RemoveOrder；m_rejectCount=0
TRADE_CONFIRM      → ProcessTrade（+ sweep 触发 + self-trade 模拟）；m_rejectCount=0
ORS_REJECT/RMS_REJECT/SIM_REJECT
   ├─ 5 类 RMS 限额码 → 强平 + 邮件（仅首次）
   ├─ 若当前状态是 CANCEL_ORDER/MODIFY_ORDER/TRADED → 走对应 reject 处理
   ├─ m_rejectCount++
   └─ 注意：这个 case 没有 break，会**贯穿**到 NEW_ORDER_FREEZE/ORDER_ERROR
NEW_ORDER_FREEZE/ORDER_ERROR → NEW_REJECT + ProcessNewReject + m_rejectCount++
MODIFY_ORDER_REJECT → ProcessModifyReject + m_rejectCount++
CANCEL_ORDER_REJECT → 若未 TRADED 则回 NEW_CONFIRM；m_rejectCount++
ORDERS_PER_DAY_LIMIT_WARNING → 平仓 + 邮件
ORDERS_PER_DAY_LIMIT_REJECT → 邮件 + exit(1)
```

- `E_RMS_ORDER_FREQUENCY_LIMIT_BREACHED`、`E_RMS_UNEXPECTED_ORDERID` 会 `m_rejectCount--`（`:960-964`），即"频率限制不算我的错"。
- `m_rejectCount` 是**全局计数**（不分订单/不分方向），只在收到任何 confirm/trade 时清零 —— 意味着一串"纯拒绝"就会累积到 200。

### 6.4 覆盖不到的地方（V，重要）

1. **没有"单笔名义金额/价格合理性"检查**：`MAX_PRICE/MIN_PRICE` 有，但只在 `USE_PRICE_LIMIT` 且**50 秒均值**上生效（注释写 20 秒，见 R19）；单笔离谱价格（如 0 或 10 倍）不会被拦。
2. **没有"每合约最大挂单数"**（除 `EquityQuotingStrategy` 用 `m_thold->MAX_ORDERS`）；`MAX_OS_ORDER` 只被 `SweepStrategy` 用。
3. **行情陈旧不会撤掉已有挂单**：`CheckLastUpdate` 只给策略置 `onExit/onCancel/onFlat`（`CommonClient.cpp:397-399`），真正撤单要等 `HandleSquareoff()`，而它只在 `CheckSquareoff`（需要**再来一条行情**）或信号里被调用。如果该合约彻底没有行情了，**挂着的老单会一直留在市场上，参考价是冻结的**。这是比"陈旧告警"更实质的缺口（**I**，需运行验证）。
4. **`assert(0)` 在 `ProcessTrade` 的 over-fill 分支**：release 编译未定义 `NDEBUG` → 直接 abort（`ExecutionStrategy.cpp:1981-1984`；`main/Makefile:15` 只加 `-O3 -w`）。
5. **两条 `exit(1)` 在持仓中执行**：不下撤单、不发告警邮件以外的任何动作（`308`、`945`）。

---

## 7. 指标（Indicators/）

### 7.1 清单与归属

| 事实 | 值 | 证据 |
|---|---|---|
| 指标实现文件 | **172** 个 `.cpp` + `include/` 下 **173** 个 `.h` | `ls Indicators/*.cpp | wc -l` |
| 目录结构 | 只有一层（`Indicators/` + `Indicators/include/`），无二级子目录 | `ls -d Indicators/*/` → 仅 `include/` |
| 工厂分支 | **151** 个 `strcmp(m_indName,...)` + 2 个 `BASKET/BASKETRIGHT` | `grep -c 'strcmp( indElem->m_indName' TradeBotUtils.cpp` = 151 |
| 归属 | **指标不是"策略的"，是"合约的"**：`Instrument ↔ IndList`，由 `InstruElem::m_indList` 持有 | `TradeBotUtils.h:230-234`；`LoadModelFile:2012` |
| 所有权 | `IndElem*` 裸指针，`new` 后挂到 `simConfig.m_indicatorList` 与 `instruElem->m_indList`，**进程内永不 delete** | `TradeBotUtils.cpp:1947-2013` |
| 实例化点 | 唯一：`GetIndicator(indElem, instru, simConfig)` | `TradeBotUtils.cpp:487-1644` |
| 更新点 | 唯一：`CommonClient::Update()` → `QuoteUpdate` / `TickUpdate` | `CommonClient.cpp:827-843` |

**指标基类**（`Indicators/include/Indicator.h:37-97`）：

```cpp
virtual void QuoteUpdate(Tick*) = 0;
virtual void TickUpdate(Tick*)  = 0;
virtual void OrderBookStratUpdate(Tick*) {}   // 只有 self-book/蝶式用
virtual void Reset() = 0;
virtual double Value(bool &status) { status = isValid; return value; }
virtual double diffValue(bool &status) { ... }
inline void Calculate() { if(!isValid) value=0; diff_value = value-last_value; last_value=value; }
Bar* bar; Instrument* instrument; int level; string description;
bool isValid; bool isDep; double value,last_value,diff_value,index; ...
```

- `level`：指标需要的盘口深度，`LoadModelFile` 用它抬升 `instrument->m_level`（`:1975-1978`）—— 即**指标决定要几档行情**。
- `index`：`GetIndicator` 末尾赋 `simConfig.m_index`；`CalculateTargetPNL` 用 `index == m_simConfig->m_index` 过滤"本策略的指标"（`:3433`）。
- `isDep`：首行 `Dependant` 的那个指标为依赖项；`isDep` 由各指标自报（如 `MT_*`、`Dependant`）。
- `isValid`：**基类构造函数没有初始化它**（`Indicator.h:41-56`）；172 个实现文件中只有 `Helper.cpp` **通篇没有** `isValid` 赋值。新增指标若忘记，`Value()` 会返回未初始化的 bool（§8 R9）。

### 7.2 配置与更新

模型文件语法（`LoadModelFile:1916-2039`）：

```
<Base> <Type> <IndName> <arg0> <arg1> ...      # TokenCount > 2 → 指标行
<KEY> <VALUE>                                   # TokenCount == 2 → 阈值
#...                                            # 注释；特例 #DEP_STD_DEV/#LOOKAHEAD/#TRGT_STD_DEV 与 #STD_<n>_<x>
```

真实样本（`3/TradeBot/models/model.GOLD_F_0_SFE.noon.agg.20150630:1-6`）：

```
GOLD_F_0_SFE FUTCOM Dependant 0 MID_PX2                       ← 依赖项：GOLD 的 MID_PX2
GOLD_F_0_SFE FUTCOM DynamicBeta 20.079541 10 GOLD_F_0_CME 1 1 1
GOLD_F_0_CME FUTCOM MT_SimpleTrend 0.272934 5                 ← 另一合约的指标，靠符号ID联动
#...                                                          ← 训练统计量（仅供人看）
CHECK_PNL 0
SIZE 3 / MAX_SIZE 12 / PERCENT_SIZE 100 / BEGIN_PLACE … / STOP_LOSS 1500.0
```

→ 从行文推测这是**跨市场（SHFE 金 vs CME 金）的动态 beta 价差模型**：`targetPrice ≈ MID_PX2(GOLD_SFE) + beta × trend(GOLD_CME)`。这也解释了为什么启动开关里要有 `useCMESmartBook`、以及 `TICKERS` 需要同时包含 SFE 与 CME 合约。【I】

**更新语义**：

| 事件 | 调用 | 说明 |
|---|---|---|
| 盘口变化（`tickType ∈ {BIDQUOTE,ASKQUOTE}`） | `QuoteUpdate(tick)` | 逐指标 |
| 成交（`BIDTRADE/ASKTRADE`） | `TickUpdate(tick)` | 逐指标 |
| self-book | `OrderBookStratUpdate(tick)` | 仅 `ProcessSelfTrade`/`ProcessCancelConfirm` 里调 |
| 重置 | `Reset()` | `CommonClient::LoadInterestList:194-212`（启动时把所有指标清零） |

指标更新的**触发门槛**见 §3.2：`tickLevel > m_level` 直接跳过；`m_bUseEndPkt` 时改为"包尾统一算一次"。

### 7.3 指标层的实际风险

1. **指标 = 全局可变状态，无快照**：`CalculateTargetPNL` 里对每个指标调 `Calculate()` 并累加 `diff_value`，**这会原地推进指标内部状态**（`last_value`）；同一次行情里如果被调用两次（例如 `ProcessSelfTrade` 也调），差分会被吃掉一次（`ExecutionStrategy.cpp:766` vs `main.cpp:347`）。这是"self-trade 打开后 PnL 行为会变"的隐藏原因（**I**）。
2. **指标数量 × 每 tick 全量遍历**：`Update()` 对每个 `IndElem` 都调一次，模型里 2 个指标时无所谓；但 `AggressiveStrategy` 那种"每 tick 撤+挂"的用法会把指标更新与报价绑在同一条线程上，指标越重延迟越高。
3. **`Bar` 型指标依赖 `BarIndicator`**（`Indicators/BarIndicator.cpp`），而 bar 数据来自 `Instrument` 自身成交（不是外部 bar 源）—— 没有独立 bar 服务。
4. **`#STD_*` 只进 `m_instruStatMap`**，被 `DynamicStdevStrategy` 一类使用；普通策略读了也不用。

---

## 8. 已知代码级风险（按严重度）

> 全部为源码事实（V），"后果"部分含推断（I）。编号供后续引用。

| # | 位置 | 问题 | 后果 |
|---|---|---|---|
| **R1** | `TradeBotUtils.h:657,685` + `CommonClient.cpp:424,443` + `main.cpp:1054-1055` | `m_simConfigList[100]` / `m_instruList[100]` 用 **`uint16_t m_symbolID`** 直接索引，**无边界检查** | symbolID ≥ 100 时越界写/读（启动时写、每 tick 读）。Connector 的 symbolID 分配规则在 infra，若按订阅顺序递增且合约数 >100 就必踩。这是**最危险的单点** |
| **R2** | `main.cpp:860,884` | `char interestlist[50][50]` + `strcpy(interestlist[count], …)`，`count` 无上限 | 同进程合约数 >50 时栈溢出（多策略 `--controlList` 场景） |
| **R3** | `main.cpp:240-250,301-359` + `CommonClient.cpp:440` | MD/IND 回调用**全局** `configParams->m_simConfig`（最后一个被处理的策略），而非按 symbol 查表 | `--controlList` 多策略时，所有行情都喂给最后一个策略；生产靠"一个 control 一行"规避 |
| **R4** | `main.cpp:90-164` + `CommonClient.cpp:236-245` | 信号线程直接改 `m_onExit/m_onFlat/m_Active/m_netpos` 并调 `HandleSquareoff()`，业务线程同时在遍历 `m_bidMap/m_askMap` | 数据竞争 / 迭代器失效 / 重复下单。无锁、无原子 |
| **R5** | `CommonClient.cpp:909-1086`（`m_reqMsg` 是成员） | 所有下单/改单/撤单共用同一个 `m_reqMsg`，非重入 | 开 `VOLTHREAD` 或未来多线程化时必然串包 |
| **R6** | `TradeBotUtils.cpp:395` | `listIter == simIter->second->begin() ;` —— **把赋值写成了比较**（无副作用语句），`listIter` 可能未初始化 | 未定义行为；`--controlList` 下 `m_simConfigMap` 的列表可能挂错 |
| **R7** | `ButterflyStrategy.cpp:687` | `m_thirdStrat->HandleSquareoff(m_secondinstru);` —— **第三条腿传了第二个合约** | 若该函数被调用，第三腿会去平/报**错误的合约**。当前不可达（见 R26），属"修 R26 时必须先修的雷" |
| **R8** | `ExecutionStrategy.cpp:2184-2189` | 停损命中后 `m_thold->UPNL_LOSS += m_thold->UPNL_LOSS`（翻倍），**直接改共享的 ThresholdSet** | 第二次触发阈值变 2 倍、第三次 4 倍…；且 `SIGUSR2` 重载阈值也救不回来（`LoadThresholds` 只重读模型文件，会覆盖，但期间行为已变） |
| **R9** | `Indicators/include/Indicator.h:41-56` | 基类 ctor 不初始化 `isValid/strategyIndex/exe_strategy` | 新指标若忘置 `isValid`，`Value()` 返回随机 bool → 目标价被随机废弃 |
| **R10** | `ExecutionStrategy.cpp:1981-1984` | `m_openQty < 0` 时 `assert(0)`；release 未定义 `NDEBUG` | 交易所超成交/重复回报 → 进程 abort（持仓裸奔） |
| **R11** | `ExecutionStrategy.cpp:308,945` | 拒绝超 200、当日订单超限 → `exit(1)`，**不平仓不撤单** | 持仓与挂单留在交易所，需人工/外部工具收拾 |
| **R12** | `CommsPassiveStrategy.cpp` vs `BondsPassiveStrategy.cpp` | 后者是前者的拷贝改（diff 仅 ~20 处），两套 600+ 行几乎相同 | 修 bug 要改两处；生产 406 次用 Comms，等于在跑"未维护分支" |
| **R13** | `common/Instrument.cpp:79-96` + `FillOrderBook:2000-2040` | `bookDepth=10` 只初始化数组前 10 档，但循环按 `m_level`（可被 `MAX_QUOTE_LEVEL` 抬到 >10）清零/拷贝 | 读到未初始化档位价格/量 |
| **R14** | `TradeBotUtils.cpp:2241-2266` | `LoadArgMap` 未知键**静默忽略**；`--` 后落单直接 `return false`（但 main 只 `return -1`，无提示） | 拼错参数名不会报错，策略按默认值跑（例如 `--adjustLTP` 拼错 → 不造 book，只挂单在空盘口上） |
| **R15** | `main.cpp:414-424` vs `command.txt:1`/`runTradeBot.sh:4-6`/`main.cpp:370` | 代码要求 `--configFile` 必填，**所有文档化示例都没带** | 按示例启动直接 `exit(1)`（`nohup.out:1-2` 里就有一条失败 exec 记录） |
| **R16** | `main.cpp:620-627` | `--squareOff 1` 调 `../scripts/squareoffcontrols.sh`，**该脚本在源码树中不存在**（`find` 无结果） | `system()` 返回非 0 被忽略，随后读 `../models/model.squareoff.list`，行为取决于该文件是否存在 |
| **R17** | `CommonClient.cpp:393`、`ExecutionStrategy.cpp:972-974` | 热点路径里 `system("echo ... \| mailx ...")`（fork+exec+SMTP） | MD 线程被阻塞数百 ms～数秒；陈旧行情/限额告警时正好是最不该卡的时候 |
| **R18** | `ExecutionStrategy.cpp:2082` | `m_optionStrategy && (delta != 0 \|\| delta != delta \|\| std::isnan(delta))` —— 逻辑恒真（`delta!=delta` 即 `isnan`），NaN 反而进不来 | 期权 delta 保护在 NaN 时失效；条件本身也冗余 |
| **R19** | `ExecutionStrategy.cpp:2083` | 注释写 "20 secs"，实际 `50000000000` ns = **50 秒** | 均值窗口与设计意图差 2.5 倍（同样问题见 `2114`、`2134`、`2206` 的 "15 mins" 是对的） |
| **R20** | `ExecutionStrategy.cpp:390-399` | 分支 `m_netpos <= 0 && m_netpos > -BEGIN_SIZE` 在 `SET_HIGH` 为真时给 **`m_tholdBidPlace`** 赋值，而 `else` 分支给 `m_tholdAskPlace` 赋值 | 不对称赋值，`SET_HIGH` 时该分支的卖价阈值保持 `-1` → 该分支可能完全不挂卖 |
| **R21** | `ButterflyStrategy.cpp:515-578` | `ORSCallBack` 里若 orderID 不在三条腿任一表中，`multiplier` **未初始化**就被用于 `traded_fly_value +=` | 随机累计值 |
| **R22** | `main/include/CrossBook.h:3-30` | 头文件里定义**非 inline 全局函数**（`GetLevel`、`OnCrossBook`） | 目前只有 `CommonClient.cpp` include，一旦第二个 TU 引入就重复定义 |
| **R23** | `common/Tokenizer.cpp:5-14` + 各调用点的 `Tokens[10]/[20]/[200]` | `Tokenizer` 把 `TokenCount` 无限递增写入固定数组（`Tokens[10]/[20]/[200]`），且用非线程安全的 `strtok` | 模型/控制文件里多一个 token 就栈溢出 |
| **R24** | `main/include/CommonClient.h:92` | 声明了 `void AddIndicator(TradeBot::Indicator*)`，**全树没有定义、也没有调用**（`grep -rn 'CommonClient::AddIndicator'` 空） | 只是死声明；一旦有人调用就是链接错误 |
| **R25** | `main.cpp:71,820-840` | 多品种策略段整段注释，`MultiInstruStrategy` 永远 NULL；`strategyType==2`（Basket 首指标）时 MD 回调无人接 | 组合型模型（`BASKET`）只能算指标、不能交易 |
| **R26** | `ExecutionStrategy.h:43` vs `ButterflyStrategy.h:36` | `HandleSquareoff()` 在基类**不是虚函数**，蝶式在派生类声明 `virtual` 也无法覆盖 | 信号平仓/收盘平仓对蝶式**完全失效**（走基类，`m_netpos=0`→空操作）；R7 因此不可达 |
| **R27** | `main.cpp:685` | pid 文件写 `/home/TradeBot/TradeBot/data/pid.<date>`，**该目录不存在**（真实目录是 `TradeBot_China/data`） | 写失败被静默忽略；实际没有任何 pid 文件，运维无法靠它判断"哪个策略在跑" |
| **R28** | `CommonClient.cpp:351,741-752` | `m_bMDUpdate` 只在 `!m_bUseEndPkt` 的分支里置 `true`，而 endPkt 分支又只在 `m_bMDUpdate==true` 时才补 IND 回调 | **`--endPkt 1` 会让指标回调永不触发 → 完全不报价**。幸存脚本（`livescripts/*.sh`）都没有 `--endPkt`，所以没被踩到 |

---

## 9. 最小重建 / 运行理解

### 9.1 必需的外部依赖（V，缺一不可）

| 依赖 | 位置（本档案内） | 用途 |
|---|---|---|
| `include/illuminati/dev_multi/*.h` | `2/include/illuminati/dev_multi`（+ `_20150330_1447`） | Connector/ShmManager/logger/xsim 头 |
| `libconnectormwmr.a`、`liblogger.a`、`libxsim*.a`、`libdatamanip.a`、`libcommonutils.a`、`libxsimdataserver.a` | `2/bld/dev_multi/` | 链接 |
| `libsnappy.a` | `/usr/local/lib`（本机也有副本） | xsim 数据压缩 |
| g++ with `-std=c++0x` | 镜像自带 `gcc 4.4.4`（`2/usr/lib/gcc/x86_64-redhat-linux/4.4.4`、`libstdc++.so.6.0.13`） | 源码用 `std::tr1::bind`、`auto`、`unordered_map`、`std::atomic`（4.4 起可用） |
| zlib | `-lz` | 同上 |

> 三条链接路径（`main/Makefile:5` 的 `INFRAPATH`、`:9` 的 `-L/bld/dev_multi`、`:12` 的 `libsnappy.a`）都是**绝对路径**，意味着源码树必须在 `/home/TradeBot/TradeBot_China` 或手工改 Makefile。这是"最小重建"的第一道坎。

### 9.2 构建顺序（V）

```bash
# 在 TradeBot_China/
cd common     && make -j8
cd ../Indicators && make -j8
cd ../Strategies && make -j8
cd ../main    && make -j8          # 产出 TradeBot / watchMarket / get_symbol_on_date / startDataServer
```

或 `make ll`（顶层 `Makefile:1-6`）。可选 `LOGGER=1`、`VOLTHREAD=1`、`DEBUG=1`。

> **注意**：`make` 不会清理 `Strategies/*.o`，而链接用 `../Strategies/*.o` 通配 —— 改完策略要 `make clean` 或至少删掉对应 `.o`，否则会把旧目标文件链进去（**V**，`main/Makefile:12`）。

### 9.3 运行前必须准备好的东西（V）

| 项 | 路径（相对 `main/`） | 缺失后果 |
|---|---|---|
| Connector 配置 | `--configFile ../Connector/config_CHINA_CME.cfg` | `exit(1)` |
| 策略账户上限 | `../Config/StrategyConfig.cfg` | 用代码默认（1e7 仓位 / 5e9 单数），**等于无限制** |
| 期权参数（即使不用期权） | `../data/OptionsParams` | `OptionManager` 构造时 `LoadOptionsParams` 会读，缺失行为取决于实现（P） |
| 交易成本 | `../data/ExchTransCharges` | `LoadTCost` → `exit(1)` |
| 合约静态表 | `../data/contractfile` | `FillInstrument` 找不到 → 合约字段为默认 |
| China 映射 | `../data/ChinaInstruments` + `../data/RolloverOverrideFile` | `exit(1)`（`Instrument.cpp:569-573,422-426`） |
| 控制文件 | 生产用绝对路径 `/home/TradeBot/controls/control.<...>`（= `3/TradeBot/controls`，2006 个）；源码树自带的 `../controls/*` 是 **NSE/Nifty 样本**，用它起不了 China 策略 | `exit(1)` 或按 Nifty 模型跑错 |
| 模型文件 | 同样在 `/home/TradeBot/models/`（= `3/TradeBot/models`，1958 个） | `exit(1)` |
| signal 文件（仅 SIGTERM 用） | `../Config/signal.txt` | 打日志后 return（不平仓） |
| 日志目录 | `../log/`（`--logFile` 绝对路径时由运维保证） | 日志丢失 |
| SHM 对端 | ORS/DataService 已在跑，键见 §9.4 | Connector 卡在 `loopMD` 空转 |

### 9.4 关键配置键

**`Connector/config_CHINA_CME.cfg`**（V，已脱敏；只有白名单键）：

```
INTERACTION_MODE = LIVE
DATA_FORMAT_ENGINE = TBTMode
XSIM_CONFIG_PATH = ../SimConfig/SimConfig_CHINA.cfg     ← Sim 模式才会被加载
SANITY_CHECK_FILE = ../Config/sanitycheck.cfg
EXCHANGES = CHINA_SHFE

[CHINA_SHFE]
CLIENTSTORESHMKEY  = <n>        # TradeBot 自己的 store
ORSREQUESTSHMKEY   = 3872       # ↔ ORS REQUEST_SHMKEY
ORSREQUESTSHMSIZE  = 100000
ORSRESPONSESHMKEY  = 4872       # ↔ ORS RESPONSE_SHMKEY
ORSRESPONSESHMSIZE = 100000
MDSHMKEY           = 872,10201  # 两路行情（SHFE + 另一路）
MDSHMSIZE          = 100000,1000
```

对端证据：`3/infra/prod/config/prod.china.ors_new.cfg:32-35` 的 `REQUEST_SHMKEY=3872` / `RESPONSE_SHMKEY=4872` —— **完整握手**（V）。

> 注意：源码里 `CommonClient.h:41-51` 还定义了一套**硬编码的 SysV 键**（`FO_MD_SHMKEY=276`、`CM_MD_SHMKEY=3276`、`FO_UPDATES=4276`…），但**没有任何 `.cpp` 使用它们**（`grep` 只命中定义本身）；r2375 的真实路径是"配置驱动 + `Connector` 内部 `ShmManager`"。而且 `common/include/MDBase.h:14-16` 又有一套**已经漂移**的同名常量（`CM_MD_SHMKEY=1276`，`MDBase.h` 的 include 在 `CommonClient.h:12` 被注释掉）。这是**源码与运行态漂移**的典型（V）。

**`Config/StrategyConfig.cfg`**（V）：`ACCOUNT`、`MAX_POS_SIZE`、`MAX_ORDERS`、`LOGGER_THREAD_CPU_AFFINITY`。

**命令行参数全集**（V，`main.cpp` 中出现过的 key）：

```
--Regress | --Sim | --Live | --LeadLag        (argv[1]，必填)
--configFile  (必填)     --controlFile   --controlList   --paramFile
--startDate --endDate --startTime --endTime --dateFile
--strategyID --logFile --printMode --updateInterval
--selfBook --selfTrade --fillReject --squareOff --endPkt
--useInvisibleBook --useCMESmartBook --useBrazilSmartBook --useDSTShift
--adjustLTP --crossBook --crossBookEnd --crossBook2 --commonBook
--optionStrategy 1|2 --optionParams --sweepStrategy --deltaStrategy
--parallelSim --shmKey --getTicker
--regressTime --regressL1Event --regressTrade --outputFile
```

### 9.5 启动顺序（Live，可复现的最小序列）

```
 1. 确认 ORS / DataService 在跑，且 SHM 键与 config 一致          (§9.4)
 2. 确认 ../data/{contractfile,ChinaInstruments,RolloverOverrideFile,
                 ExchTransCharges,OptionsParams} 存在
 3. 确认 ../Config/StrategyConfig.cfg 存在（否则限额=无限制！）
 4. cd .../main                                       ← cwd 必须在这里（所有 ../data、../Config 都是相对路径）
 5. nohup taskset -c 21 ./TradeBot --Live \
        --controlFile /home/TradeBot/controls/control.GOLD_F_0_SFE.eve.ltp.20150725 \
        --startDate 20150725 --endDate 20150725 --strategyID 420 \
        --configFile ../Connector/config_CHINA_CME.cfg \
        --adjustLTP 1 \
        --logFile /home/TradeBot/log/log.live...20150725 \
        >> /home/TradeBot/log/log.live...20150725 &
 6. 观察日志前 20 行是否走到 "GetIndicator/Indicator Level"（§2.2）
 7. 收盘前 3 分钟自动平仓、前 1 分钟强平；进程不退出，等信号
```

> `--adjustLTP 1` 是 China 版**必须**的参数：SHFE 行情经常只有单边（`bidPx[0]==0` 或 `askPx[0]==0`），`Instrument::FillOrderBook` 会用"最新成交价 ±1 tick"造出对侧（`Instrument.cpp:2038-2040,1943-1995`）。不开这个参数，`GetBidPrice` 会拿到 0 价并直接 `return`（`ExecutionStrategy.cpp:1142-1145`）→ **完全不报价**。

### 9.6 验收自检（不依赖运行二进制）

| 检查 | 命令 | 期望 |
|---|---|---|
| 源码完整性 | `cmp main/main.cpp main/.svn/text-base/main.cpp.svn-base` | 无输出（工作副本干净） |
| 2 vs 3 一致 | `md5 -q {2,3}/TradeBot/TradeBot_China/main/main.cpp` | 相同（已验：`3ce53a1b…`） |
| 编译单元一致 | `for f in Strategies/*.cpp; do [ -f ${f%.cpp}.o ] \|\| echo $f; done` | 7 个（§4.3） |
| 工厂覆盖 | `sed -n '700,820p' main/main.cpp \| grep -c 'm_execStrat'` | 31（30 个具名策略 + `NO_STRAT`；不含末尾 `else`） |
| 指标覆盖 | `grep -c 'strcmp( indElem->m_indName' main/TradeBotUtils.cpp` | 151 |
| 死参数 | `grep -n 'interestList' main/CommonClient.cpp` | 只在签名里 |
| 缺脚本 | `find . -name 'squareoffcontrols.sh'` | 空（R16） |

---

## 10. 证据索引

| # | 断言 | 命令/文件 |
|---|---|---|
| E1 | 启动流程 | `nl -ba main/main.cpp \| sed -n '361,470p'` |
| E2 | 策略工厂 31 分支 | `grep -n 'm_execStrat, "TB_\|m_execStrat, "VWAP\|m_execStrat, "LATENCY\|m_execStrat, "BUTTERFLY\|m_execStrat, "NO_STRAT' main/main.cpp` |
| E3 | 单线程业务 | `sed -n '712,760p' 3/dalong/infrastructure/Ipc/include/shmmanager.h`（`std::thread` + 同 loop 处理 MD/response） |
| E4 | 行情→指标→策略 | `nl -ba main/CommonClient.cpp \| sed -n '324,382p;407,470p;715,760p'` |
| E5 | 目标价 | `nl -ba main/TradeBotUtils.cpp \| sed -n '3401,3520p'` |
| E6 | PnL | `nl -ba Strategies/ExecutionStrategy.cpp \| sed -n '1863,2033p'` |
| E7 | 风控/平仓 | `nl -ba Strategies/ExecutionStrategy.cpp \| sed -n '253,310p;2036,2231p;2264,2362p'` |
| E8 | 订单表/状态机 | `nl -ba Strategies/ExecutionStrategy.cpp \| sed -n '778,1015p;1322,1440p'` |
| E9 | 阈值定义 | `nl -ba main/include/TradeBotUtils.h \| sed -n '236,470p'` |
| E10 | 指标工厂/所有权 | `nl -ba main/TradeBotUtils.cpp \| sed -n '487,520p;1945,2040p'` 与 `Indicators/include/Indicator.h` |
| E11 | 蝶式多腿 | `nl -ba Strategies/ButterflyStrategy.cpp \| sed -n '8,130p;515,700p'` |
| E12 | SHM 握手 | `cat 3/TradeBot/TradeBot_China/Connector/config_CHINA_CME.cfg` + `grep SHMKEY 3/infra/prod/config/prod.china.ors_new.cfg` |
| E13 | 运行实证 | `head -20 3/TradeBot/log/log.live.control.GOLD_F_0_SFE.noon.agg.20150630` |
| E14 | 策略使用统计 | `awk '{print $5}' 3/TradeBot/controls/control.* \| sort \| uniq -c \| sort -rn` |
| E15 | 限额 | `cat 3/TradeBot/TradeBot_China/Config/StrategyConfig.cfg` |
| E16 | 编译单元缺失 | `for f in Strategies/*.cpp; do [ -f ${f%.cpp}.o ] \|\| echo $f; done` |
| E17 | 缺脚本 | `find 3/TradeBot/TradeBot_China -name 'squareoffcontrols.sh'`（空） |
| E18 | 2 vs 3 同字节 | `md5 -q {2,3}/TradeBot/TradeBot_China/main/{main.cpp,CommonClient.cpp,TradeBotUtils.cpp}` |

---

## 11. 未决问题（需要人/外部输入）

1. **`m_simConfigList[100]` 用 `symbolID` 索引到底有没有真的越界？**
   这取决于 Connector（infra）里 `getSymbolIDMap()` 的分配规则：如果是"全市场订阅表里的位置"，100 个合约就爆；如果是"每个进程只登记自己订阅的合约"，就安全。infra 源码在 `3/dalong/infrastructure/Connector`，但 `symbolID` 的生成在 xsim/SHM 侧，**本次未追到**。需要一位熟悉 `ConnectorConfig::INTERESTED_SYMBOLS` 的人确认，或在隔离环境打印 `symbolID` 最大值。

2. **`REJECT_LIMIT=200` 的下调（100 触发平仓）在 2015 年是否被实际触发过？**
   日志里能搜到 `REJECT Limit reached` / `MAX ORDERS limit got hit` 吗？`3/TradeBot/log` 只剩 12 个文件（到 20150630），更早的日志在 `bckp/` 或已丢。需要业务方确认"450 单预算"是否就是当时调出来的经验值。

3. **`ButterflyStrategy.cpp:687` 传错腿的 bug 是"从未上线"还是"上线后靠人工兜底"？**
   生产 controls 里 `BUTTERFLY_STRAT` 计数为 0（§4.3），但 `TradeBot.bak`（r1936）里的 controls 是否用过蝶式？如果从未上线，这条只是"死代码里的 bug"；如果上线过，需要查 2015-02～04 的 `final_positions_*` 是否出现第三腿异常。

4. **`Config/StrategyConfig.cfg` 的 `MAX_ORDERS=450` 是"每策略"还是"每账户"？**
   代码是每进程（每策略）读一次，但交易所/ORS 侧可能按账户累计。如果 ORS 侧也有日单量限制，两者谁先触发、行为是否一致（TradeBot 是平仓，ORS 是拒绝）—— 需要 ORS 配置（`3/infra/prod/config/rms*`）的 owner 确认。

5. **`--adjustLTP` 造出来的合成盘口，是否被用于 PnL/风控判断？**
   `AdjustBookWithLTP` 直接改 `bidPx[0]/askPx[0]/bidQty[0]/askQty[0]`，随后 `CalculatePNL` 与 `CheckSquareoff` 都读这些字段。也就是说**停损/价格带判断建立在"合成价"上**。这是有意设计（无 book 时也要能风控）还是权宜之计？需要原始作者/策略 owner 确认，否则复刻时会误以为"盘口就是真的"。

---

### 附：本文跳过的部分

- Qt GUI（`SkylineFL_GUI` / `TradingSystemsGUI`）→ `03-qt-gui.md`
- `Config/controls/models/data` 的逐文件清单 → `04-config-data.md`
- 构建/部署/启停/日志运维 → `05-build-deploy-ops.md`
- `watchMarket`、`startDataServer`、`get_symbol_on_date`、`TBStatsRecorder` 只作为"同源二进制"提及，未展开
- 未运行任何二进制；所有"行为"结论来自源码阅读 + 2015 年日志/配置交叉验证

> 风险提示：`R1`（symbolID 越界索引）、`R11`（持仓中 exit(1)）、`R26`（蝶式平仓完全失效）是**会直接造成错误下单或持仓裸奔**的三条，复刻/重写时必须先解决；其余多为稳定性与可维护性问题。

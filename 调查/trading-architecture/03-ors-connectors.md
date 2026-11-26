# 03 — ORS、CTP 连接器、RMS、SHM 与模拟/回放

> 证据约定：**V** = 直接读代码/配置/脚本并核对（附 `文件:行号`）；**I** = 由代码结构/配置/脚本推断，未在运行环境验证；**P** = 文档/提案里的计划或已过时的描述，当前代码未按此实现。
> 源码快照：`/Users/wangjun/PG/RD/quantlink-trading`，commit `5cee3dd5b3322ec21c1958aac20ad38ba0d8ca40`，分支 `main`，2026-11-18。
> 本文**不含** `web-go`（Go Dashboard）的任何内容；只在必要处提到"另一个读者"以说明 SHM 拓扑。
> 本文不记录任何凭据值。`ors_server.cfg` 的凭据键只写键名，值一律 `<redacted>`。

---

## 0. 范围与结论摘要

### 0.1 本文覆盖

| 主题 | 主要代码 |
|---|---|
| ORS 进程启动/关停 | `ors/China/src/main.cpp`、`ors/China/src/ORSServer.cpp` |
| CTP 行情/交易 API 适配 | `ors/China/src/MdSpi.cpp`、`ORSServer.cpp`、`ors/third_party/ctp/linux/` |
| 共享内存与消息 | `C++_deps/hftbase/Ipc/include/{shmmanager,multiwritermultireadershmqueue,shmallocator,sharedmemory,locklessshmclientstore}.h`、`C++_deps/hftbase/CommonUtils/include/{marketupdateNew,orderresponse,mdshmwriter}.h` |
| 订单路由（含 TradeBot 侧） | `tbsrc/hftbase/Connector/{include/connector.h,src/connector.cpp}`、`tbsrc/hftbase/Ipc/include/multiclientstoreshmreader.h`、`tbsrc/main/CommonClient.cpp` |
| RMS | `C++_deps/hftbase/RMS_NEW/`、`C++_deps/hftbase/CommonUtils/include/{rmslimits.h,errorcodes.h}` |
| 行情/合约/费率/日历 | `data_cpp/data/*`、`ors/tools/fee_refresh/fee_refresh.cpp`、`tbsrc/common/Instrument.cpp`、`tbsrc/main/TradeBotUtils.cpp` |
| 模拟/回测 | `tbsrc/main/main.cpp`、`tbsrc/hftbase/Connector/src/connector.cpp`、`tbsrc/hftbase/ExchangeSimulator/`、`tbsrc/SimConfig/SimConfig.cfg`、`docs/BACKTEST_GUIDE.md` |

### 0.2 本文的取证方式（可复现）

1. 逐行读 ORS/Connector/RMS 源码，**不采信 `docs/` 结论**，冲突处单列（见 §7.6）。
2. 结构体大小不是抄注释，而是**直接编译 hftbase 头文件**得到（macOS clang / C++17，与 Linux x86-64 对这些 POD 类型的 ABI 一致）：

```bash
clang++ -std=c++17 -w \
  -I C++_deps/hftbase/CommonUtils/include -I C++_deps/hftbase/Ipc/include \
  -I C++_deps/hftbase/Logger/include -I C++_deps/hftbase/SysUtils/include \
  -I C++_deps/hftbase/LibSecurity/include /tmp/sizes.cpp -o /tmp/sizes
# 输出（V）：MarketUpdateNew 816 / RequestMsg 256 / ResponseMsg 176
#            QueueElem<MU> 824 / QueueElem<Req> 320 / QueueElem<Resp> 184
#            MDHeaderPart 96 / MDDataPart 720
```

3. 队列**真实槽数**用 `getMinHighestPowOf2()` 的实现语义复算（该函数对任何非零值都会翻倍，见 §3.2），
   并用运维侧 `md-recorder.yaml` 的"必须是 4096"反向印证。

### 0.3 十条必须知道的结论

1. **ORS 只做三件事**：CTP 行情落 SHM、CTP 订单/回报双向转发（含 SHM 编解码）、RMS 前置检查。它**不做**仓位管理、不做撮合、不做资金/保证金校验（V，§2、§5）。
2. **ORS 不支持改单**：`SendModifyOrder()` 无条件 `RejectOrder(request, "Modify orders not allowed")`（V，`ORSServer.cpp:1075-1081`）。策略层的"改单"在实盘一律变成 `MODIFY_ORDER_REJECT`。
3. **开平仓由 ORS 按本地持仓镜像决定，且不拆单**：`SetCombOffsetFlag()` 用 `position.csv` + CTP 查询得到的 `mapContractPos` 判断"平今/平昨/开仓"，数量超出可平量时**整笔转为开仓**，不会自动拆成"平 4 + 开 6"（V，`ORSServer.cpp:513-594`；§4.5）。
4. **SHM 没有背压**：队列 `isFull()` 永远返回 `false`，写端 `fetch_add` 后直接覆盖环形槽；读端靠 `seqNo` 追赶，**丢消息是静默的**（V，`multiwritermultireadershmqueue.h:252-255`、`:196-211`；§3.3）。
5. **配置里的 `*_SHMSIZE` 不是字节、也不是最终槽数**：它是"节点数"，会被 `getMinHighestPowOf2()` **翻倍**（2048→4096、1024→2048）（V，§3.2）。
6. **RMS 是"下单前的静态额度检查"**，只看账户/合约/公司三档的数量与名义价值，以及下单频率；**完全不看可用资金、保证金、可平量、涨跌停价、交易时段、交易所状态**（V，§5.7）。
7. **生产 RMS 实际只启用了 4 条规则**：`TICKER_LIMIT_CHECK`、`QUANTITY_FIRMLEVEL_CHECK`、`CANCEL_CONFIRMS_COUNT_CHECK`、`ORDER_FREQUENCY_CHECK`；`ORDER_LIMIT_CHECK`（单笔数量/金额）和 `ALLOWED_SYMBOL_CHECK` 是**注释掉的**（V，`data_cpp/bin/config/ors/configs/rms/prod.china.rms.xml:2-10`）。
8. **ORS 重启会丢订单上下文**：`m_ordLocalMap`/`m_ordExchMap` 只在内存；重启后 CTP 推来的旧单回报因 `OrderRef` 查不到而被丢弃（`ILOG(FATAL) ... not found in map`），旧单也**无法撤**（V，`ORSServer.cpp:2287-2321`、`:3237-3245`；§8.4）。
9. **`position.csv` 是时点快照，不是实时流**：只在启动、每轮持仓查询结束、正常关停时写（V，`ORSServer.cpp:207-233`、`:1444`、`:1558`、`:264`）。
10. **ORS 与 TradeBot 是两套不同的 hftbase 拷贝**（`C++_deps/hftbase` vs `tbsrc/hftbase`），SHM key/结构体必须**人工保持二进制一致**；仓库里没有 IDL/版本协商（V，`ors/CMakeLists.txt:16`、`tbsrc/CMakeLists.txt`；§9.3）。

---

## 1. ORS 进程启动

### 1.1 构建与产物

| 项 | 内容 | 证据 |
|---|---|---|
| 构建系统 | CMake ≥3.16 + C++17 | `ors/CMakeLists.txt:1-5`（V） |
| 模式宏 | `-D_USE_CTP_`（源码保留 Sgit/飞鼠分支，但只编译 CTP） | `ors/CMakeLists.txt:13`（V） |
| 依赖根 | `${CMAKE_CURRENT_SOURCE_DIR}/../C++_deps/hftbase` | `ors/CMakeLists.txt:16-26`（V） |
| hftbase 源文件 | `log.cpp`、`active.cpp`、`bglogworker.cpp`、`sighandler.cpp`、`rmschecks.cpp`、`tinyxml2.cpp`；**`rmsimpl.cpp` 不参与编译**（RMS 走 header-only `rmsimpl.hpp`） | `ors/CMakeLists.txt:29-40`（V） |
| ORS 源文件 | `main.cpp`、`ORSServer.cpp`、`MdSpi.cpp`、`MDHandler.cpp`、`marketdatahandler.cpp`、`tradedatahandler.cpp`、`reutersdecoder.cpp`、`dumprecorder.cpp` | `ors/CMakeLists.txt:45-56`（V） |
| 产物 | `ors_server`、`fee_refresh` | `ors/CMakeLists.txt:118-143`、`:160-180`（V） |
| CTP SDK | Linux：`ors/third_party/ctp/linux/{include,lib}`，链 `libthosttraderapi_se.so` + `libthostmduserapi_se.so`；RPATH 写死到该目录 | `ors/CMakeLists.txt:71-115`（V） |
| 平台 | 生产只有 Linux；macOS 分支存在但 `ORSServer.cpp:132` 用的是双参数 `CreateFtdcTraderApi`，仓内 macOS framework 是旧版单参数 → **macOS 编不过**（作者自己确认） | `fee_refresh.cpp:1648-1657`（V，注释）；本机 `ors/build/` 是旧产物，不可当源码 |

> 坑：`ors/build/` 里有 macOS 的 `link.txt`/`.o`，是历史生成物，不代表当前可构建状态（V，读 `ors/build/CMakeFiles/ors_server.dir/link.txt` 可见 `-arch arm64` + macOS framework 路径）。**不要**把它当"已验证构建"证据。

### 1.2 启动契约（argv / CWD / 日志）

```text
cd <deploy_cpp>/bin
./ors_server config/ors_server.cfg > log/ors_server.$(date +%Y%m%d).log 2>&1 &
```

| 项 | 行为 | 证据 |
|---|---|---|
| argc | `argc < 2` 打印 `Requires config file as argument` 并 `return -1`；**没有 usage、没有 `--help`、不接受其它参数** | `main.cpp:50-57`（V） |
| 配置 | `Configfile::GetInstance().LoadCfg(argv[1])`，文件不存在直接 throw（未捕获 → terminate） | `main.cpp:58`、`configreader.h:115-126`（V） |
| CWD | 必须是 `<deploy_cpp>/bin`；`start_ors.sh` 顶部注释明确写了这条，且所有相对路径（log、flow、position.csv、contracts）都相对它 | `scripts/build_deploy_cpp.sh:296-302`、`.claude/CLAUDE.md:785`（V 脚本 / I 现场） |
| 日志 1（logger） | `LOG_FILE`（默认 `./log/prod.china.ors.ctp`）+ `-YYYYMMDD.log` | `main.cpp:52,62,66`、`bglogworker.cpp:41-60`（V） |
| 日志 2（stdout） | 启动脚本重定向到 `log/ors_server.<YYYYMMDD>.log`；`ipcs -m`、`shmkey=...` 等 `std::cout` 都在这里 | `scripts/build_deploy_cpp.sh:369`（V） |
| 环境变量 | 代码里**不读任何环境变量**；只有启动脚本用 `CORE_LIMIT`、`ORS_WAIT_SEC` 控制 ulimit/等待 | `build_deploy_cpp.sh:362,700-719`（V） |
| 单实例 | 启动脚本先 `pgrep -x ors_server`，活着就**硬拒绝**启动（原因：CTP 同账号双登录会把先登录的 MD 静默踢掉且 ORS 不重连） | `build_deploy_cpp.sh:346-361`（V） |
| core dump | 默认 `ulimit -c 0`；CTP 退出时会在 `libthostmduserapi_se` 的 RSA 握手代码里崩一次（~180MB core） | `build_deploy_cpp.sh:342-345,362`（V 脚本；崩溃为 I，来自现场记录） |

### 1.3 配置文件键表（`ors_server.cfg`）

`ors_server.cfg` **不入 git**（含密码），仓库里没有任何模板（V：`git ls-files | grep ors_server.cfg` 为空）。因此下表是从**读取代码**反推的完整契约——这是复刻时的第一手依据。

`getStringStrict/getIntStrict` 在键缺失时抛异常（`configreader.h:460-470`），所以标"必填"的键**少一个进程就起不来**。

| 键 | 类型 | 必填 | 默认 | 用途 | 证据 |
|---|---|---|---|---|---|
| `FRONT_ADDR_ORS` | string | ✅ | — | 交易前置 `tcp://ip:port` | `ORSServer.cpp:403`（V） |
| `FRONT_ADDR_MD` | string | ✅ | — | 行情前置 | `:404`（V） |
| `MULTICAST_ADDR` | string | ✅ | — | **CTP 分支不使用**（只赋给局部变量），但缺了会抛 | `:405`（V） |
| `BROKER_ID` | string | ✅ | — | 经纪商代码 | `:406`（V） |
| `INVESTOR_ID` | string | ✅ | — | 交易账号（CTP 下单/登录都用它） | `:407`、`:873`、`:2134`（V） |
| `INVESTOR_ID_SHFE/CFFEX/DCE/ZCE` | string | ✅ | — | **CTP 分支不使用**（仅 Sgit 用），但四个都必须存在 | `:408-411`、`:894-908`（V） |
| `PASSWORD` | string | ✅ | — | 交易密码（**会被明文写进日志**，见 §2.9） | `:412`、`:420`、`:430`、`:2146`（V） |
| `NEWPASSWORD` | string | ❌ | `""` | 未使用 | `:413`（V） |
| `AUTH_CODE` | string | ✅ | — | 穿透式监管认证码 | `:414`、`:2118`（V） |
| `APP_ID` | string | ✅ | — | 认证 AppID | `:415`、`:2119`（V） |
| `API_LOG_DIR` | string | ✅ | — | CTP flow 目录；MD 用其下 `md/` 子目录 | `:132,140-145`（V） |
| `PRODUCTION_MODE` | bool | ❌ | `true` | CTP SE 版握手密钥选择；连评测前置必须 `0`，否则 `ErrorID=4040` | `:131`、`openspec/specs/ctp-production-mode/spec.md`（V 代码 / V 规范） |
| `LOG_FILE` | string | ❌ | `./log/prod.china.ors.ctp` | logger 文件名前缀 | `main.cpp:52,62`（V） |
| `STATS_FILE` | string | ✅ | — | 统计 CSV 前缀（`StatCollector` 初始化） | `ORSServer.cpp:64`（V） |
| `CONTRACT_FILE` | string | ✅ | — | 每日合约 dump 前缀，实际文件名 `<CONTRACT_FILE>_YYYY_MM_DD` | `:110,161-162`（V） |
| `POSITION_FILE` | string | ❌ | `""`（空=不读写文件） | 持仓快照；生产为 `./live/data/position.csv`（相对 bin/） | `:111`、`openspec/changes/archive/2026-10-05-fix-position-csv-deploy/proposal.md:14`（V 代码 / V 提案） |
| `REQUEST_SHMKEY` | int | ✅ | — | 订单请求队列 key（生产 8193） | `:104`（V） |
| `REQUEST_SHMSIZE` | int | ✅ | — | 节点数（生产 1024 → 实际 2048 槽） | `:105`（V，§3.2） |
| `RESPONSE_SHMKEY` | int | ✅ | — | 回报队列 key（12289） | `:108`（V） |
| `RESPONSE_SHMSIZE` | int | ✅ | — | 1024 → 2048 槽 | `:109`（V） |
| `CLIENT_STORE_KEY` | int | ✅ | — | 客户端 ID 分配段（16385） | `:107`（V） |
| `MAX_CLIENTS` | int | ✅ | — | 必须 1..250（否则 `initRmsImpl` throw）；**只做校验，不参与实际分配**（订单对象池固定 10 万） | `:106`、`rmsimpl.hpp:42-46,58`（V） |
| `RMS_CONFIG_FILE` | string | ✅ | — | 账户级 XML | `:102`（V） |
| `RMS_FIRMWIDE_CONFIG_FILE` | string | ✅ | — | 公司级 XML | `:103`（V） |
| `SHM_REQ_THREAD_SCHED_POLICY` / `_CPU_AFFINITY` | string | ❌ | 空 | 请求自旋线程调度策略/绑核（D15 修复项） | `shmmanager.h:551`、`processsettings.h:74-110`（V） |
| `SHM_MD_THREAD_*` | string | ❌ | 空 | MD 分发线程（ORS 侧未用，TradeBot 用） | 同上（V） |
| `CHINA_MD_THREAD_*` | string | ❌ | 空 | CTP 行情回调线程（由 CTP 创建） | `MdSpi.cpp:98-99`（V） |
| `CHINA_RESP_THREAD_*` | string | ❌ | 空 | CTP 交易回调线程 | `ORSServer.cpp:1954-1955`（V） |
| `LOGGER_THREAD_*` | string | ❌ | 空 | 异步日志线程 | `active.cpp:54`（V） |
| `REQRESP_LOGGER_THREAD_*` | string | ❌ | 空 | 请求/回报人肉日志线程 | `ORSServer.cpp:277-278`（V） |

> 复刻提示：`MULTICAST_ADDR` 与四个 `INVESTOR_ID_*` 是**"必填但无用"**的键。抄配置时漏了它们，进程会在 `Login()` 里抛异常退出，而日志只显示 `FATAL: config error file=... key=...`。

### 1.4 启动时序（逐跳）

```
main()
 ├─ LoadCfg(argv[1])                                    main.cpp:58
 ├─ InitLogger(INFRA, TO_FILE, LOG_FILE..., addDate)    main.cpp:66-68
 ├─ new ORSServer()                                     main.cpp:75
 │   ├─ 读全部 cfg（缺键抛）                              ORSServer.cpp:101-111
 │   ├─ createClientStore(16385)                        :113
 │   ├─ createRequestClient (8193, IPC_CREAT|EXCL)      :114-115
 │   ├─ createResponseClient(12289, IPC_CREAT|EXCL)     :116-117
 │   ├─ connectWithParam(ProcessRequest, ORSRequestAvailable)  :119-120
 │   ├─ registerStats()（STATS_FILE）                    :122
 │   ├─ CreateFtdcTraderApi(API_LOG_DIR, PRODUCTION_MODE) :132
 │   ├─ CreateFtdcMdApi(API_LOG_DIR/md/, ...) + mkdir    :140-145
 │   ├─ 打开 <CONTRACT_FILE>_YYYY_MM_DD（写）             :161-162
 │   └─ updatePositionFromFile()（读 POSITION_FILE）      :164
 ├─ new MDHandler()  → 创建/attach MD SHM 4097          main.cpp:76 / MDHandler.cpp:29
 ├─ new MarketUpdateNew()，m_exchangeName=50, side='N', updateType='O', feedType='W'   main.cpp:77-81
 ├─ g_pORS->Login()                                     main.cpp:83
 │   ├─ MD: RegisterSpi → RegisterFront(FRONT_ADDR_MD) → Init()      ORSServer.cpp:422-426
 │   └─ Trade: RegisterSpi → SubscribePrivateTopic(QUICK) → RegisterFront → Init()  :432-438
 ├─ while(!m_connected) usleep(10)   ← 忙等（10µs）       main.cpp:89-92
 ├─ g_pORS->Start()                                     main.cpp:97
 │   ├─ 再等 m_connected（冗余）                          ORSServer.cpp:245-247
 │   ├─ startMonitorAsyncORSRequest()（自旋线程）         :248
 │   ├─ 起 reqresp 日志线程                               :250-252
 │   ├─ ProcessSettings("LOGGER_THREAD")                 :254-255
 │   └─ installSignals() + HandleSignals()（阻塞）        :257-258
 └─ Join()/Release()  ← 永远到不了（HandleSignals 不返回）  main.cpp:98-99
```

`m_connected` 的唯一置位点（CTP 分支）：

| 场景 | 位置 |
|---|---|
| 持仓查询 `bIsLast` 且无持仓（`pPos==NULL`） | `ORSServer.cpp:1446-1449` |
| 持仓查询 `bIsLast` 正常完成 | `:1561-1564` |
| 持仓查询发送 3 次全失败 → 降级启动（保留 position.csv 值） | `:2038-2042` |

也就是说：**ORS 只有在"登录 → 结算确认 → 合约查询 → 持仓查询"都走完之后才开始处理订单**。设计意图正确（避免用假持仓误判开平），代价是启动期长且依赖查询限流（§2.6）。

### 1.5 登录 / 认证 / 重连

```text
OnFrontConnected()
  └─ Authenticate()  ── ReqAuthenticate(BrokerID, UserID, AuthCode, AppID, ++reqId)   :2112-2124
       └─ OnRspAuthenticate()  ← 不看 pRspInfo 成败，直接 ReqUserLogin()              :1941-1945
            └─ OnRspUserLogin()
                 ├─ iNextOrderRef = atoi(MaxOrderRef)                                :1973
                 ├─ FRONT_ID / SESSION_ID 保存                                        :1977-1978
                 ├─ 等 MD 登录：while (m_pUserMDSpi->m_iLoginMD == 0)  ← 纯自旋          :1991-1993
                 ├─ ReqSettlementInfoConfirm()                                       :1995 / :2102-2109
                 ├─ rms.initRmsImpl(MAX_CLIENTS, RMS_CONFIG_FILE, RMS_FIRMWIDE...)    :2003-2004
                 ├─ connect(RMS_ERROR/RMS_WARNING)                                    :2005-2008
                 ├─ usleep(1.1s) 后 ReqQryInvestorPosition()（最多 3 次，1.1s 间隔）    :2020-2043
                 └─ 失败 3 次 → m_connected = true（降级，用文件持仓）                  :2038-2042
OnRspSettlementInfoConfirm(bIsLast) → ReqQryInstrument(NULL)                           :2187-2190
OnRspQryInstrument(bIsLast)
  ├─ 关闭合约 dump 文件                                                                 :1879-1882
  ├─ rms.setExchangeInstrDefinitionMap(symbolMap, true, true, false)                     :1883
  └─ m_pUserMDSpi->SubscribeMarketData()   ← 按 symbolMap 全量订阅                        :1876
```

几个必须知道的细节：

| 细节 | 说明 | 证据 |
|---|---|---|
| MD 登录用的 `UserID` 是 `BROKER_ID` | `CMdSpi::OnFrontConnected()` 把 `m_BROKER_ID` 当第一个参数传入，`ReqUserLogin()` 里 `strcpy(req.UserID, BROKER_ID)`。若经纪商 `BROKER_ID != INVESTOR_ID`，MD 登录会失败 | `MdSpi.cpp:56-61,64-78`（V） |
| MD 登录发送失败直接 `exit(1)` | `ReqUserLogin` 返回非 0（如 CTP 未就绪/流控）就杀进程，没有重试 | `MdSpi.cpp:83-89`（V） |
| 交易登录失败退避 5 次 | 3/6/12/24/30 秒，约 75 秒；**在独立 detach 线程里 sleep**，不阻塞 CTP 回调线程；全失败才 `exit(1)` | `ORSServer.cpp:2072-2099`（V，D18 修复） |
| 重连没有自研逻辑 | 依赖 CTP API 自身的 `RegisterFront` 重连；`OnFrontDisconnected` 只 `m_connected=false` + 打日志，**不重订阅、不重查询**。重连后走的是同一套 `OnFrontConnected→…→OnRspQryInstrument` 链路，因此会重新订阅 MD（`OnRspUserLogin` 148 行也补了一次订阅，幂等） | `ORSServer.cpp:1888-1893`、`MdSpi.cpp:139-149`（V） |
| 订单发送**不检查** `m_connected` | `ProcessRequest()` 直接进 `SendNewOrder()`；断线期间订单靠 CTP 返回非 0 → `RejectOrder` | `ORSServer.cpp:491-507`、`:969-974`（V） |
| `OnRspOrderAction` / `OnErrRtnOrderAction` 中 CTP 分支只打日志 | 真正的撤单成功/失败靠 `OnRtnOrder` 的 `OrderStatus==Canceled` | `ORSServer.cpp:2346-2354`（V） |

### 1.6 结算确认

`ReqSettlementInfoConfirm` 发送**空** `SettlementID/ConfirmDate`（只填 BrokerID/InvestorID），即"不看待结算单直接确认"（V，`ORSServer.cpp:2102-2109`）。CTP 语义上这是合法的"确认最新结算单"，但**没有任何校验**：不读结算单内容、不比对持仓/权益、不判断是否需要手工确认。对复刻而言这是**合规缺口**，也是"隔日持仓/资金异常无人发现"的结构性原因（I）。

### 1.7 关停

```text
信号: SIGTSTP / SIGTERM / SIGINT → Stop()
      SIGUSR1 → rms.reset()          （日志说 "Resetting RMS state"，实际只重载配置，见 §5.8）
      SIGUSR2 → ReqQryPosition() + updatePositionFromFile()   （盘中重查持仓 + 重读文件）
```

| 步骤 | 行为 | 证据 |
|---|---|---|
| 信号屏蔽 | 主线程 `pthread_sigmask(SIG_BLOCK)` 屏蔽 SIGUSR1/2、SIGTSTP、SIGINT、SIGTERM | `ORSServer.cpp:3340-3354`（V） |
| 信号处理线程 | `sigwait` 循环，所有信号在**同一个线程**串行处理（含 `usleep(1.1s)` 的重查） | `:3356-3413`（V） |
| `Stop()` | `writePositionToFile()` → `m_connected=false` → join 日志线程 → `DoLoggOff()`（`ReqUserLogout`）→ `exit(0)` | `:261-273`（V） |
| 不做的事 | 不撤在途单、不等 CTP 回报、不 `Release()` API、不销毁 SHM（`g_pORS`/`g_pMDHandler` 是 `new` 出来且从不 delete，`exit(0)` 不会跑它们的析构；段只能靠脚本 `ipcrm`） | `:261-273`、`main.cpp:75-76,98-99`（V） |
| 退出慢 | 现场记录 pkill 后约 70 秒才真正退出（CTP Release 卡住/崩溃）→ `stop_all.sh` 默认等 90 秒再 SIGKILL | `build_deploy_cpp.sh:706-733`（V 脚本 / I 现场） |
| 关停脚本会清空**所有**该用户的 SysV 段 | `ipcs -m | grep $(whoami) | awk '{print $2}' | xargs ipcrm` | `build_deploy_cpp.sh:736-738`（V） |

> 风险：`Stop()` 里 `exit(0)` 发生在信号线程，此时订单线程可能正在 `ReqOrderInsert`。若恰好在"CTP 已接单、本地还没写 map"的窗口退出，重启后这张单**既无本地记录也无法撤**（§8.4）。

### 1.8 线程模型与 CPU 亲和

| 线程 | 创建者 | 亲和键 | 备注 |
|---|---|---|---|
| main | 进程 | — | `while(!m_connected) usleep(10)` 忙等；之后进 `sigwait` |
| ORS 请求自旋 | `startMonitorORSRequestHighPerf` | `SHM_REQ_THREAD_*` | `setpriority(-20)` + 纯 `while + pause`（V，`shmmanager.h:543-573`） |
| reqresp 日志 | `std::thread(startReqRespLogger)` | `REQRESP_LOGGER_THREAD_*` | 自己在 resp SHM 上再挂一个读端，只打日志 |
| CTP 交易回调 | CTP API 内部 | `CHINA_RESP_THREAD_*` | 所有 `OnRsp*/OnRtn*` 都在这里 → 会阻塞下单（§2.6 的 1.1s 睡眠就在这条线程上） |
| CTP 行情回调 | CTP API 内部 | `CHINA_MD_THREAD_*` | `OnRtnDepthMarketData` 做 SHM 写 + RMS LTP 更新 |
| logger | `Active` | `LOGGER_THREAD_*` | 异步落盘（因此日志不能当实时判活依据） |

现场定论（D15，2026-11-02 实证）：请求自旋线程 `SCHED_FIFO` + 未绑核，会与 `CHINA_MD_THREAD`（同为 FIFO）落同一颗 CPU，FIFO 同优先级不抢占 → MD 回调线程被饿死 → 表现为"柜台在发、我们不读"（`Recv-Q` 持续增长）。修复：`SHM_REQ_THREAD_SCHED_POLICY=SCHED_OTHER` + 两条线程都绑 CPU1（V 脚本注释 + I 现场，`.claude/CLAUDE.md:607-637`）。

### 1.9 启动期竞态（值得在复刻时修掉）

1. **RMS 仪器表 vs 首笔订单**：`initRmsImpl()` 在 `OnRspUserLogin` 里**立即**执行，而 `setExchangeInstrDefinitionMap()` 要等 `OnRspQryInstrument` 的 `bIsLast`。若持仓查询先完成（`m_connected=true`）而合约流还没结束，首笔订单可能命中 `E_RMS_BLOCKED_SYMBOL`（V 代码顺序 / I 概率）。**修法**：把 `m_connected=true` 挪到"合约 + 持仓都完成"之后。
2. **`usleep(1.1s)` 在 CTP 回调线程里**：会阻塞后续所有交易回调（含回报）。启动期无害，但 `SIGUSR2` 盘中重查走同一路径（`:3401-3402`），会卡 1.1 秒（V）。
3. **`ReqQryInstrument` 失败 3 次才 `exit(1)`，成功 1 次立即返回**，但**没有核对"合约数是否合理"**：查询返回 0 条也会 `bIsLast` → 订阅 0 个合约 → 全天无行情却"启动成功"（V，`ORSServer.cpp:1700-1749`、`:1870-1884`）。

---

## 2. CTP API 使用

### 2.1 两个 API 实例与 flow 目录

| API | 创建 | flow 目录 | 说明 |
|---|---|---|---|
| Trader | `CreateFtdcTraderApi(API_LOG_DIR, PRODUCTION_MODE)` | `API_LOG_DIR` | 私有流 `SubscribePrivateTopic(THOST_TERT_QUICK)`：**只收当日/本次会话**，不重放历史（V，`ORSServer.cpp:435`） |
| Md | `CreateFtdcMdApi(API_LOG_DIR/md/, false, false, PRODUCTION_MODE)` | 独立 `md/` 子目录 | 必须独立：共用一个目录时两个实例争用 `Private.con/DialogRsp.con`，表现为"MD 启动几秒后停止读 socket"（V 注释 `:133-145`） |

### 2.2 交易回调矩阵

| 回调 | 触发 | ORS 行为 | 证据 |
|---|---|---|---|
| `OnFrontConnected` | 连上前置 | `Authenticate()` | `:2167-2174`（V） |
| `OnFrontDisconnected(reason)` | 断线 | 只打日志 + `m_connected=false`；**不重连** | `:1888-1893`（V） |
| `OnHeartBeatWarning` | 心跳超时 | 只打日志 | `:1903-1910`（V） |
| `OnRspAuthenticate` | 认证响应 | **不看结果**，直接登录 | `:1941-1945`（V） |
| `OnRspUserLogin` | 登录响应 | 见 §1.5；失败退避重试 | `:1948-2064`（V） |
| `OnRspUserLogout` | 登出 | 置 `m_logoffResp` | `:474-488`（V） |
| `OnRspSettlementInfoConfirm` | 结算确认 | 查合约 | `:2177-2191`（V） |
| `OnRspQryInstrument` | 合约查询 | 写 dump + 建 `m_symbolMap` + 订阅 MD + 建 RMS 仪器表 | `:1806-1885`（V） |
| `OnRspQryInvestorPosition` | 持仓查询 | 累加到临时 map，`bIsLast` 整表替换 `mapContractPos` + 写 position.csv | `:1422-1566`（V） |
| `OnRtnInstrumentStatus` | 合约状态变更 | 首次见到的合约补进 `m_symbolMap` 并 dump | `:1632-1698`（V） |
| `OnRspOrderInsert` | 报单被前置/柜台**同步**拒绝 | `ORDER_ERROR` / `CANCEL_ORDER_REJECT` | `:2356-2423`（V） |
| `OnErrRtnOrderInsert` | 报单在交易所环节被拒 | 同上 | `:2487-2547`（V） |
| `OnRtnOrder` | 报单状态推送 | 状态机（§4.3） | `:2565-2782`（V） |
| `OnRspOrderAction` | 撤单响应 | **只打日志**（不产生回报） | `:2346-2354`（V） |
| `OnErrRtnOrderAction` | 撤单错误推送 | 生成 `CANCEL_ORDER_REJECT` | `:2425-2485`（V） |
| `OnRtnTrade` | 成交推送 | `TRADE_CONFIRM`（含 `ExchangeTradeId`） | `:3207-3338`（V） |
| `OnRspError` | 其它错误 | 只打日志 | `:1913-1923`（V） |

**未实现/未调用**：`ReqQryOrder`、`ReqQryTrade`、`ReqQryTradingAccount`（`ReqQryAccount()` 第一行 `return;`）、`ReqQrySettlementInfo`（只有声明）、`ReqQryInstrumentMarginRate`、`ReqQryInvestorPositionDetail`（仅 Sgit 分支）（V，全仓 grep）。

### 2.3 行情回调

| 回调 | ORS 行为 | 证据 |
|---|---|---|
| `OnFrontConnected` | `ReqUserLogin`（UserID 用 BROKER_ID，见 §1.5） | `MdSpi.cpp:56-61`（V） |
| `OnRspUserLogin` | 用**本机日期**构造当日 0 点 epoch；登录成功即 `SubscribeMarketData()`（重连后可恢复行情） | `:93-150`（V，D13 修复） |
| `OnRspSubMarketData` | 打印 + 错误检查（逐合约订阅，`iResult` 被覆盖，只看最后一次结果） | `:152-209`（V） |
| `OnRtnDepthMarketData` | 填 `MarketUpdateNew` → `MDHandler::ProcessMDUpdate` → SHM；同时 `rms.updateLTPFromMD()` | `:231-329`（V） |
| `OnFrontDisconnected` | 只打日志（**不重订阅、不退出**） | `:40-46`（V） |

### 2.4 报单字段映射（CTP 分支）

| CTP 字段 | 取值 | 备注 |
|---|---|---|
| `BrokerID` / `InvestorID` | `m_BROKER_ID` / `m_INVESTOR_ID` | `ORSServer.cpp:872-873`（V） |
| `InstrumentID` | `request->Contract_Description.Symbol` | `:874`（V） |
| `OrderRef` | `sprintf("%012d", iNextOrderRef++)` | `:875-877`（V）；从 `MaxOrderRef` 起算（**未 +1**，见 §2.8） |
| `Direction` | `Transaction_Type=='B'/'S'` → Buy/Sell；其它 → 拒单 | `:879-891`（V） |
| `CombOffsetFlag[0]` | 由 `SetCombOffsetFlag()` 决定 Open/Close/CloseToday | `:954-960`（V，§4.5） |
| `CombHedgeFlag[0]` | `THOST_FTDC_HF_Speculation`（投机，硬编码） | `:961`（V） |
| `OrderPriceType` / `TimeCondition` / `VolumeCondition` / `MinVolume` | 见下表 | `:689-869`（V） |
| `ContingentCondition` | `Immediately` | `:963`（V） |
| `ForceCloseReason` | `NotForceClose` | `:964`（V） |
| `IsAutoSuspend` / `UserForceClose` | `0` / `0` | `:965-966`（V） |
| `RequestID` | `m_iRequestID + 1`（与实参 `++m_iRequestID` 同值） | `:967-969`（V） |

价格/时效组合（**这是唯一决定 FAK/FOK/GFD 的地方**）：

| 输入（`RequestMsg`） | `OrderPriceType` | `TimeCondition` | `VolumeCondition` | `MinVolume` | 语义 |
|---|---|---|---|---|---|
| `OrdType=MARKET`，`Duration=FOK/IOC` | `AnyPrice` | `IOC` | `CV`（全部成交） | `Quantity` | FOK |
| `OrdType=MARKET`，`Duration=FAK` | `AnyPrice` | `IOC` | `AV`（任意数量） | `1` | FAK |
| `OrdType=MARKET`，其它 | `LimitPrice`（**LimitPrice=0**） | `GFD` | `AV` | `1` | 事实上是"0 价限价单"，会被柜台拒 |
| `OrdType=LIMIT`，`FOK/IOC` | `LimitPrice` | `IOC` | `CV` | `Quantity` | FOK |
| `OrdType=LIMIT`，`FAK` | `LimitPrice` | `IOC` | `AV` | `1` | FAK |
| `OrdType=LIMIT`，其它（含 `DAY`） | `LimitPrice` | `GFD` | `AV` | `1` | 普通限价 |

证据：`ORSServer.cpp:689-869`（V）。

> **TradeBot 实际只会发两种**：`FillReqInfo()` 硬编码 `OrdType=LIMIT`、`PxType=PERUNIT`；`SendNewOrder` 里 `ordHitType==CROSS ? FAK : DAY`（V，`CommonClient.cpp:957-1013,1149-1158`）。所以 `OrdType=MARKET` 分支在现网是死路径，`MARKET + DAY` 那个"0 价限价"的坑不会被触发。

### 2.5 撤单字段映射

| 字段 | 取值 | 证据 |
|---|---|---|
| `BrokerID` / `InvestorID` | 固定账号 | `:1116-1118` |
| `InstrumentID` | 请求里的 symbol | `:1119` |
| `OrderRef` | 本地 map 里存的 `OrderRef` | `:1120` |
| `FrontID` / `SessionID` | 登录时保存 | `:1121-1122` |
| `ActionFlag` | `THOST_FTDC_AF_Delete`（只支持全撤） | `:1123` |
| `ExchangeID` | `SHFE/CFFEX/CZCE/DCE` 四选一 | `:1127-1141` |
| `OrderSysID` | 本地 map 里存的交易所单号 | `:1142` |
| `LimitPrice` / `VolumeChange` | 请求里的 price/qty（**CTP 撤单不用这两个字段**） | `:1125-1126` |

> **GFEX 撤单是坏的**：`switch(Exchange_Type)` 没有 `CHINA_GFEX` 分支 → `req.ExchangeID` 为空串 → CTP 无法定位报单（V，`:1127-1141`；对照 `marketupdateNew.h:86` 有 `CHINA_GFEX=61`，TradeBot 也会发 `GFEX`）。同理 `SetCombOffsetFlag` 只对 `CHINA_SHFE` 用 `CloseToday`（`:544,566`）。

### 2.6 查询与限流

| 查询 | 时机 | 限流处理 | 证据 |
|---|---|---|---|
| `ReqQryInstrument("")` | 结算确认后 | 失败退避 1.1s × 3，全失败 `exit(1)` | `:1700-1749`（V） |
| `ReqQryInvestorPosition("")` | 登录后 1.1s；`SIGUSR2` | 登录路径 3 次 × 1.1s；失败降级启动 | `:2020-2043`、`:1751-1782`（V） |
| `ReqQryInvestorPosition` 响应错误 | 查询进行中 | `usleep(1.1s)` 后重发（在回调线程里） | `:1453-1462`（V） |

CTP 官方限制（每秒查询数、每秒报单数）没有任何本地节流器；只有 RMS 的 `ORDER_FREQUENCY_CHECK`（20 笔/秒窗口）间接限制报单速率——**这个值高于 CTP 的实际许可**，所以柜台侧 `-2/-3` 仍会发生（V 配置 + I 柜台行为）。

### 2.7 错误处理的三条路径

```text
(a) 本地拒绝（RMS / 前置校验 / API 返回非 0）
      SendNewOrder → RejectOrder() → Response_Type=ORS_REJECT, ErrorCode=1000101
      SendCancelOrder → RejectOrder() → CANCEL_ORDER_REJECT, ErrorCode=0（未设置）
(b) CTP 同步拒绝（前置/柜台校验失败）
      OnRspOrderInsert(pInputOrder, pRspInfo) → ORDER_ERROR, ErrorCode=pRspInfo->ErrorID
(c) CTP 异步拒绝（交易所拒绝）
      OnErrRtnOrderInsert / OnRtnOrder(OrderSubmitStatus=InsertRejected) → ORDER_ERROR
```

| 问题 | 说明 | 证据 |
|---|---|---|
| `ORS_REJECT` 的 `ErrorCode` 恒为 `1000101` | 宏名 `ERROR_CODE_CROSS_REJECT`，与"交叉检查"毫无关系，任何本地拒单都用它 → 客户端**无法区分原因**（只能看日志） | `:27`、`:1394`（V） |
| `CANCEL_ORDER_REJECT` / `MODIFY_ORDER_REJECT` 不带 `ErrorCode` | `RejectOrder()` 只给 `NEWORDER` 赋 `ErrorCode`；其余沿用构造默认 0（`E_NO_ORS_RMS_ERROR`） | `:1387-1417`（V） |
| `OnRspOrderInsert` 注释掉了 `ErrorID != 0` 判断 | 因为"ErrorID=0 也可能进这个回调"，所以任何进这里的报单都当错误处理（合理但粗暴） | `:2361-2363`（V） |
| `OnRtnOrder(pOrder, pRspInfo)` 版本 | `pOrder->OrderSysID == NULL` 或 `ErrorID!=0` 时强改 `OrderSubmitStatus = InsertRejected-'0'`；注意 `'0'` 运算：`THOST_FTDC_OSS_InsertRejected` 是 char `'4'`，减 `'0'` 得 `4`，恰好等于枚举序号写法——能用但极其脆弱 | `:2549-2563`（V） |
| 找不到 `OrderRef` 的回报直接丢 | `GetOrderInfo` 失败只打 `ILOG(FATAL)`，不合成任何回报 → 客户端永远等不到这张单的终态 | `:2287-2321`（V，§8.4） |

### 2.8 请求 ID 与 OrderRef

| 计数器 | 作用域 | 初始化 | 递增 | 证据 |
|---|---|---|---|---|
| `m_iRequestID` | 整个进程，**交易+行情+查询共用**（MD 用另一个全局 `g_RequestId`） | 0 | `++m_iRequestID`（`Authenticate()` 用 `m_iRequestID++`，风格不一致） | `ORSServer.cpp:95,2120,2150,967-969,1124,1718`（V） |
| `iNextOrderRef` | 报单引用 | `atoi(pRspUserLogin->MaxOrderRef)`（**CTP 分支不加 1**；Sgit 分支 `+1`） | 每笔新单 `++` | `:1973,875-877`（V） |
| `ORDER_REF` | `char[13]`，`%012d` | — | — | `ORSServer.h:274`（V） |

> 风险（I，需柜台验证）：CTP 的 `MaxOrderRef` 是该账户当日已用的**最大**报单引用。CTP 分支直接以它作为下一笔（而不是 `+1`），若同一 `FrontID/SessionID` 下重登或 ORS 重启后重新登录，第一笔新单可能与历史单**引用重复**，柜台返回"重复的报单引用"。原代码在 Sgit 分支是 `+1` 的，CTP 分支大概是移植时漏了。

### 2.9 已知缺陷清单（ORS/CTP 层）

| # | 问题 | 影响 | 证据 |
|---|---|---|---|
| O-1 | **改单不支持**，一律拒 | 策略层所有 `SendModifyOrder` 在实盘变成 `MODIFY_ORDER_REJECT`；策略必须用"撤+新"实现 | `:1075-1081`（V） |
| O-2 | **登录密码明文进日志**（三处：MD 登录、交易登录、`ReqUserLogin`） | 任何能读日志的人拿到交易密码；日志还会被 `ops_rotate_logs.sh` 搬来搬去 | `:420,430,2146`（V） |
| O-3 | `ORS_REJECT` 统一错误码 1000101 | 无法区分"RMS 拒/参数错/API 失败"；RMS 拒单走另一条路（`RmsError`）才有真错误码 | `:27,1394`（V） |
| O-4 | 撤单/改单拒绝不带错误码 | 客户端只能靠 `Response_Type` | `:1399-1412`（V） |
| O-5 | GFEX 撤单缺 `ExchangeID` | GFEX 合约无法撤单 | `:1127-1141`（V） |
| O-6 | `SetCombOffsetFlag` 只对 SHFE 用 `CloseToday` | CZCE 平今被标成 `OF_Close`（通常被解释为平昨）→ 可能"平今失败/平昨错误"；需柜台实测（I） | `:544-547,566-569`（V 代码） |
| O-7 | 数量超过可平量时整笔转开仓，不拆单 | 想"平 4 手"却发 10 手 → 实际开 10 手（净仓反向 6 手）。作者已把拆单版本回滚，理由写在注释里（拆单导致 map 覆盖/回报丢失） | `:509-511,557-561`（V） |
| O-8 | `MD OnRspUserLogin` 用本机日期构造行情时间 | 夜盘跨 00:00 后 `m_exchTS` 会回跳约 20.5 小时；依赖交易所时间的逻辑会错 | `MdSpi.cpp:126-138,221-228`（V 代码 / I 影响） |
| O-9 | `strcpy(g_pUpdate->m_symbol, InstrumentID)` 无长度检查（目标 48 字节） | 超长合约名（组合合约）溢出 | `MdSpi.cpp:238`、`marketupdateNew.h:174`（V） |
| O-10 | `MDHandler.cpp` 只对 `m_bidUpdates/m_askUpdates` 做了 memset，其余字段（`m_endPkt` 等）从未初始化 | `g_pUpdate = new MarketUpdateNew()` 是 POD 默认初始化（值不确定）；RMS 的 `updateLTPFromMD` 第一行就看 `m_endPkt` | `main.cpp:77`、`MdSpi.cpp:250-251`、`rmsimpl.hpp:197`（V） |
| O-11 | `ReqUserLogin` 发送失败 `exit(0)`（成功码退出） | 运维脚本/看门狗看到 0 会当正常退出 | `:2157-2163`（V） |
| O-12 | `ppInstrumentID[200][30]` / `iInstrumentID` 是死全局 | 不要以为订阅走的是这个数组 | `main.cpp:40-41`（V） |
| O-13 | `marketdatahandler.cpp` / `tradedatahandler.cpp` 是**示例代码**，内含明文账号密码常量且不参与实际链路 | 会被误读为"ORS 的登录实现"；也是凭据泄漏面（本文不复述具体值） | `marketdatahandler.cpp:33-39`、`tradedatahandler.cpp:17-24`（V） |
| O-14 | `OrderCrossCheck()` / `ReqQryAccount()` / `ReqQrySettlementInfo()` 死代码 | 交叉检查从未启用 | `:2193-2222,1784-1803`（V） |

---

## 3. SHM / 消息

### 3.1 key 表

| key(hex) | 十进制 | 内容 | 创建者（owner） | 读者 | 证据 |
|---|---|---|---|---|---|
| `0x1001` | 4097 | `MarketUpdateNew` 行情队列 | `ors_server`（`MDHandler` 构造时） | 每个 TradeBot、md-recorder、tbadmin agent、check-md | `MDHandler.h:17,21`；`config_CHINA.92201.cfg:17`（V） |
| `0x2001` | 8193 | `RequestMsg` 订单请求队列（多写单读） | `ors_server`（`IPC_CREAT|IPC_EXCL`） | `ors_server` 请求自旋线程 | `ORSServer.cpp:114-115`；`config_CHINA.92201.cfg:18`（V） |
| `0x3001` | 12289 | `ResponseMsg` 回报队列（多写多读） | `ors_server`（EXCL，已存在则**拒绝启动**） | 所有 TradeBot + tbadmin agent；ORS 自己也挂一个只读日志端 | `ORSServer.cpp:116-117,280-283`（V） |
| `0x4001` | 16385 | `LocklessShmClientStore<uint64_t>` 客户端 ID 计数器 | `ors_server` | 每个 TradeBot（`initClientStore` → `fetch_add` 取号） | `ORSServer.cpp:107,113`；`locklessshmclientstore.h:43-64,78-81`（V） |
| `789` | 789 | MemLog（策略内部状态） | TradeBot | tbadmin agent / dashboard | `config_CHINA.92201.cfg:12-13`（V，本文不展开） |

> **"谁的 key 说了算"**：ORS 的 key 来自 `ors_server.cfg` 的 `REQUEST_SHMKEY/RESPONSE_SHMKEY/CLIENT_STORE_KEY`，MD key 是**硬编码** `4097`（`MDHandler.h:17`）。TradeBot 的 key 来自 `config_CHINA.<id>.cfg` 的 `[CHINA_*]` 段。两边**没有任何握手**，配错就是"连上了但永远没数据/永远没回报"。

### 3.2 段布局与"翻倍"行为

```text
segment = [ Header ][ slot0 ][ slot1 ] ... [ slot(N-1) ]
Header(MWMR) = std::atomic<int64_t> head   (初值 1)          multiwritermultireadershmqueue.h:15-23
slot(T)      = T data + uint64_t seqNo                        :25-30
N            = getMinHighestPowOf2(cfg_shmsize)               :84-91
```

`getMinHighestPowOf2()` 的实现有运算符优先级/取反错误（`if (!value & (!(value & (value - 1))))`），**对任何非零值都走"翻倍到严格大于它的 2 的幂"**：

| 配置值 | 真实槽数 | 备注 |
|---|---|---|
| 2048（MD） | **4096** | `md-recorder.yaml` 要求写 `qlen: 4096`，正是这个原因（V，`md-recorder.yaml:6`） |
| 1024（Req） | **2048** | |
| 1024（Resp） | **2048** | |

段大小 = `sizeof(Header) + N*sizeof(T)`，再按页向上取整（V，`shmallocator.h:46-67`、`sharedmemory.h:49-54`）。实测（编译头文件得到，§0.2）：

| 队列 | `sizeof(T)` | `sizeof(QueueElem<T>)` | 槽数 | 数据区字节 |
|---|---|---|---|---|
| MD | 816 | 824 | 4096 | 3,375,104 |
| Req | 256 | 320（`alignas(64)` 补齐） | 2048 | 655,360 |
| Resp | 176 | 184 | 2048 | 376,832 |

> 注意 `RequestMsg` 带 `__attribute__((aligned(64)))`（`orderresponse.h:295`），导致 `QueueElem<RequestMsg>` 从 264 被补到 **320**。这一点直接影响 SHM 段大小与 Java/Python 侧的对齐计算。
> 现场若 `ipcs -m` 看到的字节数与上表不符，说明配置值或结构体版本不一致——这是最快的"二进制契约"体检点。

### 3.3 队列语义（关键：无背压、静默覆盖）

```cpp
// 写端
int64_t myHead = header->head.fetch_add(1, acq_rel);
slot = m_updates + (myHead & (size-1));
memcpy(&slot->data, &value, sizeof(T));
slot->seqNo = myHead;            // 普通 store，无 release fence
// 读端
QueueElem* v = m_updates + (tail & (size-1));
memcpy(data, &v->data, sizeof(T));
tail = v->seqNo + 1;             // 直接跳到写端序号
bool isEmpty() { return slot(tail)->seqNo < tail; }
bool isFull()  { return false; } // 永远不满
```

| 属性 | 行为 | 后果 | 证据 |
|---|---|---|---|
| 容量 | 固定环形 N 槽 | 读端落后 > N 条时，写端覆盖未读数据 | `:118-133`（V） |
| 背压 | **无**。`isFull()` 恒 false；写端不检查读者位置 | 写端永不阻塞（对交易热路径是优点），代价是"丢最新还是丢最旧"由覆盖自然决定：**丢最旧** | `:252-255`（V） |
| 丢消息检测 | **无**。读端 `tail = seqNo+1` 直接前跳；不比较期望序号 | 丢包**静默**，上层不会知道"中间少了 N 条行情/回报" | `:196-211`（V） |
| 撕裂读 | 写端先 `memcpy(data)` 再写 `seqNo`（无 release）；读端先读 `data` 再读 `seqNo` | x86 TSO 下实践可行，但**不是标准无锁正确性**；在 ARM 上会读到半新半旧 | `:123-127`（V） |
| 多写者 | `head.fetch_add` 保证每写者拿到唯一槽 | 请求队列可被 N 个 TradeBot 同时写 | `:121`（V） |
| 多读者 | 每个读者维护**自己的 tail**（进程内成员） | 同一进程重启后 `tail = header->head`（`init` 里 `tail = head.load()`），即**从最新开始，不补历史** | `:96-100`（V） |
| 序号起点 | `head` 初值 1 | 第一槽索引 1，索引 0 永远空置（无实际影响） | `:21`（V） |

**为什么这在本系统里"能工作"**：TradeBot 的 MD+回报由同一个线程紧循环消费（`startMonitorMarketDataAndResponse`），正常时读者几乎不落后；MD 峰值约 15–100 tick/s，4096 槽 ≈ 40 秒以上的缓冲。真正会丢的场景是：进程被 SIGSTOP/换页/长 GC/断点，或某进程只写不读导致队列反向积压（不存在，因为单读）。

### 3.4 结构体

#### `MarketUpdateNew`（816B = Header 96 + Data 720）

| 字段 | 类型 | ORS 实际填的值 | 说明 |
|---|---|---|---|
| `m_exchTS` | uint64 | `mktime(当日 0 点 + UpdateTime)*1000 + UpdateMillisec` | **本机时区**、毫秒；非交易所原生 ns |
| `m_timestamp` | uint64 | `clock_gettime(CLOCK_REALTIME)` ns | 本地收包时间 |
| `m_seqnum` | uint64 | `++m_seqNum`（进程内自增） | 仅 MD 队列单调；**不是每合约序号** |
| `m_rptseqnum` | uint64 | **从不赋值** | 恒为 0/垃圾 |
| `m_tokenId` | uint64 | 从不赋值 | |
| `m_symbol` | char[48] | `InstrumentID` | |
| `m_symbolID` | uint16 | TradeBot 侧按 `INTERESTED_SYMBOLS` 重填；ORS 不填 | `connector.cpp:780` |
| `m_exchangeName` | uchar | **恒 50（CHINA）**，不区分 SHFE/DCE/... | `main.cpp:78`（V） |
| `m_lastTradedPrice` / `m_totalTradedQuantity` / `m_totalTradedValue` | double/int64/double | CTP `LastPrice`/`Volume`/`Turnover` | |
| `m_lastTradedTime` | uint64 | = `m_exchTS` | |
| `m_lastTradedQuantity` | int32 | **恒 0** | 没算增量 |
| `m_bidUpdates[20]` / `m_askUpdates[20]` | bookElement | 只填 5 档（CTP 只有 5 档），其余 memset 0 | `MdSpi.cpp:250-325` |
| `m_validBids` / `m_validAsks` | int8 | 0..5（遇到 Volume==0 就停） | 注意：**遇到 0 量档直接截断**，不跳档 |
| `m_updateType` | uchar | **恒 'O'（ORDER_ENTRY）** | 见 §5.9 的连锁后果 |
| `m_side` / `m_feedType` | uchar | 'N' / 'W'（快照） | |
| `m_endPkt` | uint8 | **从不赋值** | 未初始化 |

证据：`main.cpp:77-81`、`MdSpi.cpp:231-329`、`MDHandler.cpp:65-68`、`marketupdateNew.h:166-557`（V）。

#### `RequestMsg`（256B，`aligned(64)`）

| 字段 | 用途 | TradeBot 填法 | ORS 用法 |
|---|---|---|---|
| `Contract_Description.Symbol[50]` | 合约 | `memcpy(ticker)` | 直接进 `InstrumentID` |
| `Request_Type` | NEW/MODIFY/CANCEL/... | 枚举 | switch 只处理前三个 |
| `OrdType` | LIMIT/MARKET | **恒 LIMIT** | 决定 CTP 价格类型 |
| `Duration` | DAY/IOC/FOK/FAK | CROSS→FAK，否则 DAY | 决定 CTP 时效 |
| `OrderID` | 本地单号 | `clientId*1e6 + counter` | map 主键；回报原样带回 |
| `Quantity` / `QuantityFilled` | 数量/已成交 | | 撤单时 `VolumeChange=Quantity` |
| `Price` | 价格 | | `LimitPrice` |
| `TimeStamp` | ns | `ITime_ClockRT::GetCurrentTime()` | RMS 频率窗口、时延统计 |
| `AccountID[11]` | 账户 | `"OWN"` 左对齐补空格 | RMS 账户查找键（**空格敏感**） |
| `Transaction_Type` | `'B'/'S'` | `ConvertSide()` | 方向 |
| `Exchange_Type` | `CHINA_*`（57..61） | `execStrategy->m_instru->m_exchangeType` | 开平仓判断、撤单 `ExchangeID` |
| `Product[32]` / `StrategyID` | 归因 | 策略填 | 原样回填进 `ResponseMsg` |

证据：`orderresponse.h:134-295`、`CommonClient.cpp:957-1026`（V）。

#### `ResponseMsg`（176B）

| 字段 | 语义 | ORS 填法 |
|---|---|---|
| `Response_Type` | 19 种（见 `orderresponse.h:379-401`） | 实际只产出 7 种：`NEW_ORDER_CONFIRM`/`CANCEL_ORDER_CONFIRM`/`TRADE_CONFIRM`/`ORDER_ERROR`/`CANCEL_ORDER_REJECT`/`ORS_REJECT`/`RMS_REJECT`（+`ORDERS_PER_DAY_LIMIT_*`/`STOP_LOSS_WARNING` 由 RMS 发） |
| `OrderID` | 本地单号 | 原样带回 |
| `ErrorCode` | `E_RMS_*` / CTP `ErrorID` / 1000101 | 见 §2.7 |
| `Quantity` / `Price` | 成交或撤单剩余量 | 成交= `Trade.Volume`；撤单=`Order.VolumeTotal`（剩余） |
| `Side` / `Symbol` / `AccountID` / `StrategyID` | 归因 | 从 `m_ordLocalMap` 回填（2026 改动新增，Dashboard 需要） |
| `ExchangeTradeId[21]` | 交易所成交号 | `Trade.TradeID`（**不保证唯一**跨交易所） |
| `TimeStamp` | ns | `PushUpdate` 里打时间 |
| `Child_Response` | 中间系统标记 | ORS 恒为 `NULL_RESPONSE_MIDDLE` |

### 3.5 谁读谁写

```text
                       ┌──────────────── 4097 (MD) ────────────────┐
CTP MdSpi ──写──► MDHandler ──► MarketDataShmWriter ──► [slot] ──► 每个 TradeBot 的 MD 线程
                                                   ├──► md-recorder（qlen=4096）
                                                   ├──► tbadmin agent
                                                   └──► check-md 探针

TradeBot(Connector::PushRequest) ──写──► 8193 (Req) ──读──► ORS 请求自旋线程 ──► CTP ReqOrderInsert

ORS(CTP 回调线程) ──写──► 12289 (Resp) ──读──► 每个 TradeBot 的回报线程（按 clientId 过滤）
                                        ├──► tbadmin agent
                                        └──► ORS 自己的 reqresp 日志线程
```

| 进程 | 4097 | 8193 | 12289 | 16385 |
|---|---|---|---|---|
| `ors_server` | 写 | 读 | 写（+一个只读日志端） | 创建 + 读 |
| `TradeBot` | 读 | 写 | 读 | attach + `fetch_add` |
| `tbadmin agent` | 读 | 不读 | 读 | — |
| `md-recorder` | 只读 | — | — | — |

证据：`MDHandler.cpp:29,68`；`connector.cpp:79-98,113-115`；`ORSServer.cpp:113-120,280-283`（V）。

### 3.6 容量与背压估算

| 场景 | 估算 | 结论 |
|---|---|---|
| MD 稳态 | 现网单日约 30 万条（2026-11-02 实测 305,343），5.5h ≈ 15/s | 4096 槽 ≈ **4.5 分钟**缓冲 |
| MD 开盘瞬时 | 数十~数百 tick/s（全市场 1000+ 合约同时订阅） | 4096 槽 ≈ **10–40 秒** |
| 回报队列 | 单策略每秒个位数 | 2048 槽几乎不可能写满 |
| 请求队列 | 受 RMS 20/s 限制 | 2048 槽余量巨大 |

> 真正的"背压点"不在 SHM，而在 **CTP 回调线程**：ORS 的 `OnRtnOrder/OnRtnTrade/OnRtnDepthMarketData` 全在 CTP 线程上执行，其中还有 `ILOG`（异步但会分配内存）、`std::map` 加锁、`UpdateOrWrite`。SHM 写只是 memcpy。

### 3.7 生命周期与重启

| 事件 | 行为 | 证据 |
|---|---|---|
| ORS 启动 | Req/Resp/ClientStore 用 `IPC_CREAT|IPC_EXCL`；**已存在则抛 `Queue already exists` → 进程终止** | `ORSServer.cpp:114-117`；`shmmanager.h:369-378,520-529`（V） |
| MD 段已存在 | `createMarketDataClient` 用 `IPC_CREAT|0666`（非 EXCL）→ **attach 复用**，head 从旧值继续 | `shmmanager.h:314-326`；`shmemory.h:57-80`（V） |
| ORS 退出 | `SharedMemory::~SharedMemory()` 里确实有 `shmctl(IPC_RMID)`，但 ORS 的 `g_pORS`/`g_pMDHandler` 是 `new` 出来且永不 `delete`，`exit(0)` 不会触发 → **实际清段只靠 `stop_all.sh`/`start_ors.sh` 的 `ipcrm`** | `sharedmemory.h:33-38`；`main.cpp:75-76`；`build_deploy_cpp.sh:363,736-738`（V） |
| 段被 `ipcrm` 后 | 已 attach 的进程**仍然持有旧映射**（内核引用计数），看不到新段 → 表现为"进程活着、数据不动" | 内核语义（V，标准行为） |
| 客户端 ID | 段重建 → 计数器归 0；存活进程的旧 clientId 会与新进程**冲突** | `locklessshmclientstore.h:43-64`（V） |

**运维铁律**：重启 ORS 必须同时重启所有 TradeBot（`start_all.sh` / `stop_all.sh` 就是这么做的）；不能只重启 ORS。

---

## 4. 订单生命周期端到端

### 4.1 时序

```text
策略 ExecutionStrategy
  └─ CommonClient::SendNewOrder(...)                      tbsrc/main/CommonClient.cpp:957
       ├─ FillReqInfo(): OrdType=LIMIT, PxType=PERUNIT     :1149
       └─ Connector::SendNewOrder(RequestMsg&)             connector.h:269
            ├─ OrderID = clientId*1_000_000 + m_OrderCount++   connector.h:360-372
            ├─ Request_Type = NEWORDER
            └─ m_requestQueue[Exchange_Type]->enqueue(msg)     connector.h:218
                    │
                    ▼  8193
ORS 请求线程 loopRequest()                                  shmmanager.h:168-187
  └─ ProcessRequest(req)                                   ORSServer.cpp:491
       └─ SendNewOrder(req)                                :663
            ├─ rms.executeNewOrderChecks(req)              :679   ← 失败: RmsError→RMS_REJECT
            ├─ 组 CTP 字段（价格/时效/开平）                  :689-967
            ├─ m_pUserTradeApi->ReqOrderInsert(&req, ++id) :969
            ├─ rc!=0 → RejectOrder("New order Send Error") :970-974
            └─ 写 m_ordLocalMap[OrderID] / m_ordExchMap[OrderRef]  :997-1003
                    │
                    ▼  CTP
              ┌─ OnRspOrderInsert  → ORDER_ERROR（前置/柜台拒）
              ├─ OnRtnOrder        → NEW_ORDER_CONFIRM（Accepted+排队/部成）
              │                       CANCEL_ORDER_CONFIRM（Canceled）
              │                       ORDER_ERROR（InsertRejected）
              └─ OnRtnTrade        → TRADE_CONFIRM（每笔成交一条）
                    │
                    ▼  12289（PushUpdate → m_responseInterface->enqueue）
TradeBot 回报线程 loopResponse()                            shmmanager.h:224-236
  └─ Connector::HandleOrderResponse(msg, queueNum)          connector.cpp:792
       ├─ clientId = OrderID / 1_000_000                     :825
       ├─ 只把 clientId 属于本进程的回报交给上层（STRATEGY_FILTER）  :826-843
       └─ CommonClient::SendInfraORSUpdate → ExecutionStrategy::ORSCallBack
```

### 4.2 OrderID 编码与多策略隔离

| 事实 | 说明 | 证据 |
|---|---|---|
| `ORDERID_RANGE = 1_000_000` | 一个客户端最多 100 万张单/进程生命周期 | `tbsrc/hftbase/CommonUtils/include/constants.h:14` |
| `OrderID = clientId * 1e6 + counter` | `clientId` 来自 SHM 计数器（ORS 创建，各 TradeBot `fetch_add`） | `connector.h:360-372`（V） |
| 回报过滤 | `clientId = OrderID / 1e6`，与本地 `m_all_clientIds[exchId][*]` 比对 | `connector.cpp:824-843`（V） |
| 溢出 | `m_OrderCount >= 1e6` 时 `GetOrderNumberWithNewClientId()` 重新取号（V） | `connector.cpp:1153+` |
| 结论 | **同一个 ORS 下多个 TradeBot 共用一个回报队列，靠 OrderID 高位区分**；ORS 完全不懂"策略"，只认 OrderID | — |

> 这也解释了为什么 `ResponseMsg.StrategyID` 必须是 ORS 从请求里回填的：OrderID 只编码了"哪个进程"，不编码"哪个策略"。

### 4.3 状态映射（ORS 的 CTP 状态机）

`OnRtnOrder` 以 `OrderSubmitStatus` 为一级、`OrderStatus` 为二级：

| `OrderSubmitStatus` | `OrderStatus` | ORS 动作 | ResponseType | 证据 |
|---|---|---|---|---|
| `InsertSubmitted` | `AllTraded` | 只打日志（成交靠 `OnRtnTrade`） | — | `:2594-2603` |
| `InsertSubmitted` | `Canceled` | `Qty -= VolumeTotal`；`Qty==0` 则删表 | `CANCEL_ORDER_CONFIRM` | `:2614-2632` |
| `InsertSubmitted` | `Unknown` | 复位 `Qty=VolumeTotalOriginal` | — | `:2633-2638` |
| `InsertSubmitted` | 其它 | 打 "unhandled order status" | — | `:2645-2651` |
| `Accepted` | `PartTradedQueueing` / `NoTradeQueueing` | 若 `orderSent` 还没发过确认 → 发一次 | `NEW_ORDER_CONFIRM` | `:2663-2675` |
| `Accepted` | `AllTraded` | 只打日志 | — | `:2657-2662` |
| `Accepted` | `Canceled` | 同 InsertSubmitted/Canceled | `CANCEL_ORDER_CONFIRM` | `:2682-2700` |
| `InsertRejected` | * | 按 `ordinfo.requestType` 分派；NEW 删表 | `ORDER_ERROR` / `CANCEL_ORDER_REJECT` | `:2718-2748` |
| 其它（`CancelSubmitted` / `ModifySubmitted` / `*Rejected`） | * | 只打 "unhandled status" | — | `:2749-2763` |

要点：

1. **`NEW_ORDER_CONFIRM` 只发一次**（靠 `orderSent` 标志），且只在"已被交易所接受且在排队/部成"时发。若报单瞬间全成（`AllTraded`），**可能一张 `NEW_ORDER_CONFIRM` 都收不到**，直接收 `TRADE_CONFIRM`（V，`:2597-2602` + `:2665`）。
2. **`TRADE_CONFIRM` 每笔成交一条**，`Quantity=Trade.Volume`、`Price=Trade.Price`，并带 `ExchangeTradeId`（V，`:3297-3307`）。
3. **部分成交**：`ordinfo.Qty -= Trade.Volume`；`openQty>0` 保留在 map，`==0` 时 `RemoveFromMap`（V，`:3274-3276,3320-3331`）。
4. **`OnRspOrderInsert`（同步拒）与 `OnErrRtnOrderInsert`（异步拒）都会删表**（NEWORDER 分支 `bRemoveOrder=true`），随后 `RemoveFromMap`（V，`:2391,2518`）。
5. **撤单成功不删表的情况**：`Canceled` 时若 `Qty != 0`（即之前有部分成交）会保留，等 `OnRtnTrade` 把最后一条成交处理完再删（V，`:2622-2631`）。逻辑正确但依赖"成交总在撤单确认之前/之后都到"。
6. **`OnRspOrderAction` 不产生任何回报**（CTP 分支只打日志）；撤单的"成功"只由 `OnRtnOrder(Canceled)` 体现（V，`:2346-2354`）。

> 对比：Sgit 分支（未编译）在 `OnRspOrderAction` 里就发 `CANCEL_ORDER_CONFIRM`。CTP 分支的行为差异是移植时留下的，不是设计。

### 4.4 拒单/撤单/改单小结

| 场景 | 客户端收到 | ErrorCode 来源 | 是否删本地表 |
|---|---|---|---|
| RMS 拒新单 | `RMS_REJECT` 或 `ORDERS_PER_DAY_LIMIT_REJECT` | `E_RMS_*` | 不写表（RMS 在 API 之前） |
| ORS 本地拒（API 返回非 0 / 方向非法） | `ORS_REJECT` | 恒 1000101 | 不写表 |
| CTP 同步拒 | `ORDER_ERROR` | `pRspInfo->ErrorID` | 删 |
| CTP 异步拒 | `ORDER_ERROR` | `pRspInfo->ErrorID` | 删 |
| 撤单本地拒（表里没有） | `CANCEL_ORDER_REJECT` | 0 | 不改 |
| 撤单 CTP 拒 | `CANCEL_ORDER_REJECT` | `pRspInfo->ErrorID` | 不删 |
| 撤单成功 | `CANCEL_ORDER_CONFIRM`（`Quantity`=剩余量） | 0 | 成交清零后删 |
| 改单 | `MODIFY_ORDER_REJECT` | 0 | 不改（ORS 从不改单） |

### 4.5 开平仓决策（`SetCombOffsetFlag`）

```text
按 symbol 查 mapContractPos（无则插入全 0）
BUY（买入 = 平空或开多）:
    Qty <= todayShortPos  → SHFE? CloseToday : Close ; todayShort -= Qty ; CLOSE_TODAY
    Qty <= ONShortPos     → Close                    ; ONShort    -= Qty ; CLOSE_YESTERDAY
    else                  → Open                     ; 不动持仓      ; OPEN_ORDER
SELL 对称（todayLong / ONLong）
```

| 事实 | 说明 | 证据 |
|---|---|---|
| 决策依据是**本地镜像**，不是柜台实时可平量 | 镜像来自 `position.csv`（启动）+ CTP 持仓查询（启动/`SIGUSR2`/重连）+ 成交回报累加 | `:513-594`、`:1422-1566` |
| **下单前就扣减**可平量 | 订单被拒时在 `updatePosition(ORDER_ERROR)` 里加回去 | `:548,570`、`:1298-1326`（V） |
| 撤单时按 `response.Quantity` 加回 | `CANCEL_ORDER_CONFIRM` 的 Quantity 是**剩余未成交量** | `:1340-1359`（V） |
| 成交时只对 `OPEN_ORDER` 加仓 | 平仓在发单时已扣，成交不再动 | `:1362-1380`（V） |
| 不做"平今/平昨拆分" | 见 O-7 | `:509-511`（V） |
| CZCE 平今可能标错 | 见 O-6 | `:544-547`（V） |

> **这是全系统最危险的语义**：如果本地镜像比柜台"多"了持仓（例如手工在柜台平了仓、或 ORS 重启前有在途平仓单），ORS 会继续发"平仓"单 → 柜台拒"平仓量超过持仓量"。如果镜像"少"了（例如手工开了仓），ORS 会把平仓单标成开仓 → **反向开仓**。`position.csv` 与 CTP 查询的整表替换（`:1498-1548`）就是为了收敛这个镜像，但它只在启动/重查时发生。

### 4.6 幂等 / 重复单

| 层 | 是否有去重 | 说明 |
|---|---|---|
| SHM | 无 | 同一 `RequestMsg` 被重复入队就重复执行 |
| ORS | 无 | `m_ordLocalMap[OrderID] = ...` 是覆盖写；重复 OrderID 会**覆盖**前一张单的上下文（前一张的回报将错配到新单） | `:997-999`（V） |
| CTP | 有（`OrderRef` 唯一性） | 同一会话重复 `OrderRef` 被拒 |
| TradeBot | 有（策略层） | `ExecutionStrategy` 维护 `m_orderMap`，用 `m_rejectCount`/`m_confirmCount` 做退避（详见 `02-runtime-strategy.md`） | `ExecutionStrategy.cpp:997-1132`（V） |

> 复刻建议：**必须**在 ORS 侧加 `OrderID` 去重（保留最近 N 个终态 ID），否则一次 SHM 重放或客户端 bug 就会造成重复下单。当前靠"SHM 只写一次 + CTP OrderRef 唯一"兜底，属于运气。

### 4.7 TradeBot 侧消费（只列与 ORS 相关的部分）

| ResponseType | `ExecutionStrategy` 动作 | 证据 |
|---|---|---|
| `NEW_ORDER_CONFIRM` | `m_status=NEW_CONFIRM`，`m_rejectCount=0`，`m_confirmCount++` | `ExecutionStrategy.cpp:997-1005` |
| `TRADE_CONFIRM` | `ProcessTrade()` 更新持仓/PnL；可能触发 sweep/hedge | `:1046-1054` |
| `CANCEL_ORDER_CONFIRM` | `ProcessCancelConfirm()` | `:1040-1045` |
| `ORDER_ERROR` | `m_status=NEW_REJECT`，`ProcessNewReject()`，`m_rejectCount++` | `:1108-1118` |
| `CANCEL_ORDER_REJECT` | 回滚到 `NEW_CONFIRM`，`ProcessCancelReject()` | `:1125-1132` |
| `MODIFY_ORDER_REJECT` | `m_status=MODIFY_REJECT` | `:1119-1124` |
| `ORS_REJECT` / `RMS_REJECT` / `SIM_REJECT` | `m_rejectCount++`；命中数量/额度类错误码时**主动平仓并告警** | `:1075-1107` |
| `ORDERS_PER_DAY_LIMIT_WARNING` | 只记录 | `:1133+` |

### 4.8 时延埋点（ORS 侧 `StatsCollector`）

| 指标 | 含义 | 阈值（warn/alert） | 证据 |
|---|---|---|---|
| `MsgCreation` | 组包耗时（RMS 后 → API 前） | 2000/5000 ns | `:66` |
| `RMS` | RMS 检查耗时 | 2000/5000 | `:85` |
| `checkCross` | 交叉检查耗时（函数已死，恒 ~0） | 300/500 | `:86` |
| `ApiLatency` | `ReqOrderInsert` 调用耗时 | 2000/20000 | `:88` |
| `ResponseEnqueue` | 写回报 SHM 耗时 | 1000/20000 | `:89` |
| `New/Cancel <EXCH>` | 报单/撤单"发单→回报"端到端 | SHFE 2.5ms/6ms；DCE 25/30ms；ZCE 200/400ms；CFFEX 3/6ms（值单位 ns） | `:68-83` |

> 这些阈值是**印度市场遗留的数量级**（ZCE 200ms 告警），在 CTP 上几乎没有意义；复刻时应按柜台实测重设。

---

## 5. RMS

### 5.1 位置与角色

| 事实 | 说明 | 证据 |
|---|---|---|
| 代码 | `C++_deps/hftbase/RMS_NEW/`（ORS 专用）；`tbsrc/hftbase/RMS_NEW` 是另一份拷贝（TradeBot 不用） | `ors/CMakeLists.txt:22,38`（V） |
| 运行位置 | **ORS 进程内**，在 `SendNewOrder`/`SendCancelOrder` 里同步调用 | `ORSServer.cpp:679,1097`（V） |
| 通信方式 | 通过 `DEFINE_SIGNAL(RMS_ERROR, RMS_WARNING)` 回调到 `ORSServer::RmsError/RmsWarning` → 写回报 SHM | `:2005-2008,328-361`（V） |
| 定位 | **下单前的额度闸门**，不是策略风控、不是资金风控、不是交易所合规检查 | §5.7（V） |

### 5.2 初始化

```text
OnRspUserLogin
  └─ rms.initRmsImpl(MAX_CLIENTS, RMS_CONFIG_FILE, RMS_FIRMWIDE_CONFIG_FILE, "")
       ├─ 校验 1 <= MAX_CLIENTS <= 250（否则 throw）
       ├─ reset():
       │    ├─ 读 RMS key 文件（可选，XOR 加密的 firmwide 配置）
       │    ├─ m_rmsConfig.loadConfig(账户 XML, 公司 XML)   ← 缺标签/缺值直接 throw
       │    ├─ loadAccountPosCacheAndRMSLimits()（按 XML 里的 Account 名建账户表，ID 空格补齐到 10 位）
       │    └─ m_rmsChecks.reset(cache, instrCache, config)（解析 EnabledChecks → 绑定规则函数）
       └─ m_orderPositionsPool.allocate(100000)（订单位置对象池，10 万个）
```

证据：`rmsimpl.hpp:39-118,122-160`；`rmslimits.h:299-400,417-650`（V）。

> **初始化顺序陷阱**：`m_rmsChecks.reset()` 里 `m_instrDefCache` 还是空的（合约查询可能没结束），但 `setExchangeInstrDefinitionMap()` 之后会往同一个 map 里插——因为 `RmsChecks` 存的是**指针**，所以后续插入可见（V，`rmschecks.cpp:31-36`）。这也是 §1.9 竞态的根。

### 5.3 配置文件

#### 账户级 XML（`RMS_CONFIG_FILE`，生产：`prod.china.rms.xml`）

```xml
<Rms>
  <EnabledChecks>
    <Check>TICKER_LIMIT_CHECK</Check>
    <Check>QUANTITY_FIRMLEVEL_CHECK</Check>
    <Check>CANCEL_CONFIRMS_COUNT_CHECK</Check>
    <Check>ORDER_FREQUENCY_CHECK</Check>
  </EnabledChecks>
  <!-- <BannedSymbols><Symbol>...</Symbol></BannedSymbols> -->
  <Limits><AccountWise>
    <Account name="OWN">
      <DefaultLimits>
        <PerTickerNetValue>1</PerTickerNetValue>
        <PerTickerNetQuantity>1000</PerTickerNetQuantity>
        <OpenValue>500000</OpenValue>
        <OpenQuantity>1000</OpenQuantity>
        <EnableExposureCheck>FALSE</EnableExposureCheck>
        <OpenOrders>450</OpenOrders>
        <OrdersPerDayLowerLimit>0.80</OrdersPerDayLowerLimit>
        <OrdersPerDayUpperLimit>0.90</OrdersPerDayUpperLimit>
        <OrdersPerTrade>20</OrdersPerTrade>
        <OrdersPerTradeLowerLimit>0.21</OrdersPerTradeLowerLimit>
        <OrdersPerTradeUpperLimit>0.32</OrdersPerTradeUpperLimit>
        <TransactionCostCalculator>2</TransactionCostCalculator>
        ...
        <AccountLevelLossFatalLimit>800000</AccountLevelLossFatalLimit>
        <AccountLevelLossWarningLimit>500000</AccountLevelLossWarningLimit>
        <InstrumentLevelLossFatalLimit>10000</InstrumentLevelLossFatalLimit>
        <InstrumentLevelLossWarningLimit>8000</InstrumentLevelLossWarningLimit>
        <MaxCancelConfirmationLimit>1000</MaxCancelConfirmationLimit>
      </DefaultLimits>
      <!-- <InstrumentLimits type="NoDefaults"><Limits>...</Limits><Instrument name="..."/></InstrumentLimits> -->
    </Account>
  </AccountWise></Limits>
</Rms>
```

证据：`data_cpp/bin/config/ors/configs/rms/prod.china.rms.xml:1-55`（V）。

#### 公司级 XML（`RMS_FIRMWIDE_CONFIG_FILE`，生产：`prod.china.rms.firmwide.xml`）

| 标签 | 生产值 | 语义 | 必填 |
|---|---|---|---|
| `EnabledSymbols/Symbol` | 一个空 `<Symbol></Symbol>` | 允许交易的合约白名单（只有启用 `ALLOWED_SYMBOL_CHECK` 才生效） | ✅（缺标签 throw） |
| `OrderFrequencyWindow` | 1（秒） | 频率窗口 | 缺省 1 |
| `OrderFrequencyLimit` | 20 | 窗口内最大报单数 | ✅ |
| `OrderFreqCalcMode` | 未写 → `ROLLING` | `ROLLING`/`DISCRETE` | 否 |
| `PerTickerNetQuantity` | 1000 | **公司级**单合约净持仓上限（手） | ✅（0 则 throw） |
| `OpenQuantity` | 1000 | **公司级**单笔最大数量（手） | ✅（0 则 throw） |
| `OrderToCommisionFactor` | 1 | `ORDERS_PER_DAY_CHECK` 用 | 否 |
| `TradedValueMultiplyFactor` | 1 | 同上 | 否 |
| `FirmLevelLossFatalLimit` | 800000 | 公司级止损（只有 `STOP_LOSS_CHECK` 用） | ✅（0 则 throw） |

证据：`data_cpp/bin/config/ors/configs/rms/prod.china.rms.firmwide.xml:1-16`；`rmslimits.h:369-399`（V）。

#### `RMSLimits` 字段全表（与 XML 标签对应）

| 结构体字段 | XML 标签 | 类型 | 归属 |
|---|---|---|---|
| `singleOrderOpenQtyLimit` | `OpenQuantity` | double | 账户/合约 |
| `singleOrderOpenValueLimit` | `OpenValue` | double | 账户/合约 |
| `singleTickerOpenOrdersLimit` | `OpenOrders` | double | 账户/合约 |
| `singleTickerNetValueLimit` | `PerTickerNetValue` | double | 账户/合约 |
| `m_checkForExposure` | `EnableExposureCheck` | bool | 账户/合约 |
| `m_ordersPerDayFixedLimit` | `OrdersPerDay` | int64 | 账户/合约 |
| `m_orderPerDayLowerLimit/UpperLimit` | `OrdersPerDayLowerLimit/UpperLimit` | double | 账户/合约 |
| `m_orderPerTradeLimit` | `OrdersPerTrade` | int64 | 账户/合约 |
| `m_orderPerTradeLowerLimit/UpperLimit` | `OrdersPerTradeLowerLimit/UpperLimit` | double | 账户/合约 |
| `m_singleTickerNetPositionInLotsLimit` | `PerTickerNetQuantity` | double | 账户/合约 |
| `m_firmwideNetPositionInLotsLimit` | `PerTickerNetQuantity`（Firmwide 段） | double | 公司 |
| `m_firmwideOpenQtyLimit` | `OpenQuantity`（Firmwide 段） | double | 公司 |
| `m_orderFrequencyWindow` / `m_orderFrequencyLimit` | `OrderFrequencyWindow/Limit` | double/uint32 | 公司 |
| `m_orderFreqCalcMode` | `OrderFreqCalcMode` | enum | 公司 |
| `m_transactionCostCalculator` | `TransactionCostCalculator` | uint32（0/1/2） | 账户/合约 |
| `m_buy/sellTransactionCostFactorOnQty/Value` | `Buy/SellTransactionCostOnQty/ValueFactor` | double | 账户/合约 |
| `m_accountLevelLossWarning/FatalLimit` | `AccountLevelLossWarning/FatalLimit` | double | 账户 |
| `m_firmLevelLossFatalLimit` | `FirmLevelLossFatalLimit` | double | 公司 |
| `m_tickerLevelLossWarning/FatalLimit` | `InstrumentLevelLossWarning/FatalLimit` | double | 账户/合约 |
| `m_percentageAwayFromLTPLimit` | `PercentageAwayFromLTPLimit` | double | 账户/合约 |
| `m_maxCancelConfirmationLimit` | `MaxCancelConfirmationLimit` | uint32 | 账户/合约 |

证据：`rmslimits.h:19-160`、`:500-527`、`:538-618`（V）。

### 5.4 规则清单（`RmsChecks`）

规则名（XML 里的字符串）→ 实现函数 → 实际语义：

| 规则 | 函数 | 检查内容 | 生产是否启用 |
|---|---|---|---|
| `VALID_SYMBOL_CHECK` | `IsSymbolAllowed` | 合约**不在** `BannedSymbols` | ❌ |
| `ALLOWED_SYMBOL_CHECK` | `IsSymbolEnabled` | 合约**在** `EnabledSymbols` | ❌（且白名单是空串，启用会全拒） |
| `ORDER_LIMIT_CHECK` | `SingleOrderThresholdChecks` | 单笔 `Qty > OpenQuantity*RoundLotForThreshold`（本项目 RoundLot 不参与 → 手数）；单笔 `Qty*VolumeMultiple*LTP > OpenValue` | ❌ |
| `TICKER_LIMIT_CHECK` | `SingleTickerThresholdChecks` | 单合约**未成交开仓单数** +1 > `OpenOrders`；`EnableExposureCheck` 时还查净敞口名义值 | ✅ |
| `QUANTITY_FIRMLEVEL_CHECK` | `QuantityFirmLevelCheck` | 公司级 `|Σ(netSell - netBuy)| > PerTickerNetQuantity`；单笔 `Qty > OpenQuantity` | ✅ |
| `NET_POSITION_FIRMLEVEL_CHECK` | `NetPositionFirmLevelCheck` | 同上但用 `net*TradedQty`（更严格） | ❌ |
| `STOP_LOSS_CHECK` | `StopLossCheck`/`StopLossPerTickerCheck` | 账户/合约/公司级浮动+已实现亏损 | ❌ |
| `ORDER_FREQUENCY_CHECK` | `OrderFrequencyThresholdChecks` | 窗口内报单数（`OrderQueue` 满）→ 拒 | ✅ |
| `ORDERS_PER_DAY_CHECK` | `OrdersPerDayThresholdChecks` | 当日报单数/动态额度 的 warning/breach 比例 | ❌ |
| `ORDERS_PER_TRADE_CHECK` | `OrdersPerTradeThresholdChecks` | 报单数/成交笔数比例 | ❌ |
| `KRX_ORDERS_PER_TRADE_CHECK` | ... | 韩交所专用 | ❌ |
| `X_PERCENT_AWAY_FROM_LTP_CHECK` | `XPercentAwayFromLTPCheck` | 价格偏离 LTP 超过 X% | ❌ |
| `CANCEL_CONFIRMS_COUNT_CHECK` | `CancelConfirmationCountCheck` | **仅 `LIMIT+DAY`** 单：单合约撤单确认数 > `MaxCancelConfirmationLimit` | ✅ |
| `NEGATIVE_PRICE_OR_QUANTITY_CHECK` | `NegativePriceOrQuantityCheck` | 价格/数量为负 | ❌ |

证据：`rmschecks.cpp:66-130,141-233,330-485,520-592,873-1058`；`rmsimpl.hpp:249-293`（V）。

规则执行顺序 = XML 里 `<Check>` 的顺序，**第一个失败就 break**（V，`rmschecks.cpp:289-297`）。

### 5.5 关键实现细节（决定"能不能挡住"）

| 细节 | 影响 | 证据 |
|---|---|---|
| 单笔数量按**手**，不乘合约乘数（`applyRoundLotValueOnIncomingQuanityChecks=false`） | `OpenQuantity=1000` 表示 1000 手，不是 1000 吨 | `ORSServer.cpp:1883`；`rmsimpl.h:79-98`（V） |
| 单笔金额按 `Qty * VolumeMultiple * price` | `OpenValue` 是名义金额 | `rmschecks.cpp:380`（V） |
| `TICKER_LIMIT_CHECK` 数的是**开仓挂单数**（`buyOpenOrdersCount/sellOpenOrdersCount`），不是总挂单数 | 平仓单不受 `OpenOrders` 限制 | `rmschecks.cpp:418,433`（V） |
| `QUANTITY_FIRMLEVEL_CHECK` 的净头寸 = 账户表里**所有账户**该合约的 `netBuy/netSell` + 未成交开仓 + 本次数量 | 严格说是"公司净敞口（按手）" | `rmschecks.cpp:951-994`（V） |
| 平仓单也会增加 `netSell/netBuy`，没有"平仓不占额度"的豁免 | 高频对锁会把净头寸推到上限 | `rmschecks.cpp:968-989`（V） |
| `CANCEL_CONFIRMS_COUNT_CHECK` 只统计 `LIMIT && DAY` | FAK/IOC 撤单不计数 | `rmschecks.cpp:1048-1055`（V） |
| 频率统计用请求的 `TimeStamp`（ns），窗口 = 秒 × 1e9；`ROLLING` 用固定 20 槽队列 | 21 笔/秒开始拒 | `rmsimpl.hpp:571-603`；`rmschecks.cpp:520-537`（V） |
| 频率的 `isFull()` 在**入队前**判断 | 严格 20 笔/窗口 | 同上（V） |
| `AccountID` 必须**空格补齐到 10 位**后才能匹配（XML 的 `OWN` 与请求的 `"OWN       "`） | 账户名写错 → `E_RMS_BLOCKED_ACCOUNT` 全拒 | `rmsimpl.hpp:127-130,426-432`；`rmslimits.h:402-415`（V） |
| 合约必须在 `m_instrDefCache` 里，否则 `E_RMS_BLOCKED_SYMBOL` | 新上市合约若合约查询没返回 → 全拒 | `rmsimpl.hpp:439-448`（V） |
| 拒单立即 `EMIT_PARAM(RMS_ERROR, ...)`，**在 API 调用之前** | 被 RMS 拒的单不会到柜台 | `ORSServer.cpp:679-684`（V） |

### 5.6 错误码

基址 `E_ORS_RMS_BASE = 100000`（`errorcodes.h:12-13`）。

| 常量 | 值 | 含义 | 触发规则 |
|---|---|---|---|
| `E_RMS_BLOCKED_ACCOUNT` | 100100 | 账户未配置/ID 不匹配 | 任意（`getTradingStatSoFar` 返回 NULL） |
| `E_RMS_BLOCKED_SYMBOL` | 100101 | 合约不在仪器表 | 任意 |
| `E_RMS_ORDER_QTY_LIMIT_BREACHED` | 100102 | 单笔数量超限 | ORDER_LIMIT |
| `E_RMS_ORDER_VALUE_LIMIT_BREACHED` | 100103 | 单笔金额超限 | ORDER_LIMIT |
| `E_RMS_UNEXPECTED_ORDERID` | 100104 | 改单/撤单找不到单 | modify |
| `E_RMS_TICKER_OO_LIMIT_BREACHED` | 100105 | 单合约开仓挂单数超限 | TICKER_LIMIT |
| `E_RMS_TICKER_VALUE_LIMIT_BREACHED` | 100106 | 单合约净敞口超限 | TICKER_LIMIT（需 EnableExposureCheck） |
| `E_RMS_ORDER_FREQUENCY_LIMIT_BREACHED` | 100107 | 报单频率超限 | ORDER_FREQUENCY |
| `E_RMS_MODIFY_ORDER_NOT_FOUND` | 100108 | 改单找不到 | modify |
| `E_RMS_CANCEL_ORDER_NOT_FOUND` | 100109 | 撤单找不到（RMS 侧） | cancel |
| `E_RMS_TOTAL_ORDERS_PER_DAY_LIMIT_BREACHED / WARNING` | 100110 / 100111 | 当日报单超限/预警 | ORDERS_PER_DAY |
| `E_RMS_INCOMPLETE_INIT` | 100112 | 频率队列未初始化 | 启动竞态 |
| `E_RMS_STRAT_WITH_MORE_ACCOUNTS` | 100113 | 未使用 | — |
| `E_RMS_TOTAL_ORDERS_PER_TRADE_LIMIT_WARNING / BREACHED` | 100114 / 100115 | 报单/成交比 | ORDERS_PER_TRADE |
| `E_RMS_ACCOUNT_LEVEL_STOP_LOSS_LIMIT_WARNING / BREACHED` | 100116 / 100117 | 账户止损 | STOP_LOSS |
| `E_RMS_FIRM_LEVEL_STOP_LOSS_LIMIT_BREACHED` | 100118 | 公司止损 | STOP_LOSS |
| `E_RMS_TOTAL_POSITION_IN_LOTS_FIRMLEVEL` | 100119 | 公司净持仓 | NET_POSITION_FIRMLEVEL |
| `E_RMS_QUANTITY_PERORDER_IN_LOTS_FIRMLEVEL` | 100120 | 公司单笔数量 | QUANTITY_FIRMLEVEL |
| `E_RMS_NOT_ALLOWED_SYMBOL` | 100121 | 不在白名单 | ALLOWED_SYMBOL |
| `E_RMS_TICKER_LEVEL_STOP_LOSS_LIMIT_WARNING / BREACHED` | 100122 / 100123 | 合约止损 | STOP_LOSS |
| `E_RMS_MAX_CANCEL_CONFIRMS_LIMIT_BREACHED` | 100124 | 撤单数超限 | CANCEL_CONFIRMS |
| `E_RMS_TICKER_LEVEL_PERCENTAGE_AWAY_FROM_X_FAILED` | 100125 | 偏离 LTP | X_PERCENT |
| `E_RMS_ORDER_LEVEL_FILL_QUANTITY_MISMATCH` | 100126 | 改单 `QuantityFilled` 不一致 | modify |
| `E_RMS_NET_POSITION_IN_LOTS_FIRMLEVEL` | 100127 | 公司净持仓（另一实现） | NET_POSITION |
| `E_RMS_FOUND_NEGATIVE_PRICE / QUANTITY` | 100128 / 100129 | 负数 | NEGATIVE_* |

证据：`errorcodes.h:46-76,166-224`（V）。

### 5.7 RMS **不**检查什么（最重要的一节）

| 不检查 | 后果 | 证据 |
|---|---|---|
| **可用资金 / 保证金 / 权益** | 资金不足只能在柜台侧被拒（`ORDER_ERROR`），ORS 不预判；没有"资金预占" | 全仓 grep `Available/Balance/Margin` 在 RMS 中 0 命中（V） |
| **可平量 / 持仓是否足够** | 平仓量超过持仓由柜台拒；ORS 的 `mapContractPos` 只是"尽力而为"的镜像 | §4.5（V） |
| **涨跌停价 / 最小变动价位 / 合约乘数合法性** | 离谱价格直接送柜台 | `SingleOrderThresholdChecks` 只用 LTP 算金额（V） |
| **交易时段 / 合约状态 / 交易所是否开盘** | ORS 不判断 `IsTrading`、不看 `OnRtnInstrumentStatus` 的状态位；非交易时段报单由柜台拒 | `OnRtnInstrumentStatus` 只建表（V） |
| **自成交 / 对锁** | 无自成交预防（`E_ORS_SELF_TRADE` 定义了但没人用） | `errorcodes.h:30`（V 定义，无使用） |
| **单账户多策略的归因隔离** | 所有策略共用 `ACCOUNT=OWN`，RMS 只按账户聚合 → 一个策略打满额度，其他策略全被拒 | `data_cpp/bin/config/StrategyConfig.cfg:1`（V） |
| **LTP 正确性** | 见 §5.9：本部署里 RMS 的 LTP 实际恒 0 | V |
| **订单去重** | 见 §4.6 | V |

> 一句话：**RMS 是"数量/频率"闸门，不是风险引擎**。真正的资金风险、持仓风险、策略风险全在策略层（`02-runtime-strategy.md`）和人工。

### 5.8 开关 / 热重载

| 操作 | 实际行为 | 证据 |
|---|---|---|
| 启用/禁用规则 | 改账户 XML 的 `<EnabledChecks>` → **重启 ORS** | `rmschecks.cpp:45-130`（V） |
| 改额度 | 改 XML → 重启 ORS；`SIGUSR1` 只重载配置（`rms.reset()`） | `ORSServer.cpp:3392-3397`（V） |
| `SIGUSR1` 的真实语义 | `reset()` 重读 XML、重建规则、重建 `m_orderFrequency`；**但不清空** `m_orderToPositions` / `m_tickerToLTUpdates` / `m_accountPosStartUpCache` 里的累计量。日志写 "Resetting RMS state" 是**误导** | `rmsimpl.hpp:64-118`（V，函数体里没有清理这些 map） |
| 关闭 RMS | 没有开关；只能把 `<EnabledChecks>` 清空（`m_subscribedRules` 为空 → `execute` 直接返回 true） | `rmschecks.cpp:277-301`（V） |
| 加密配置 | firmwide 配置可用 XOR key（`RmsLoginStruct` 从文件加载 key）；**账户级不支持加密** | `rmslimits.h:299-344`（V） |

### 5.9 本部署里 LTP 恒为 0（连锁失效）

```text
1. main.cpp:80 设 g_pUpdate->m_updateType = 'O'（ORDER_ENTRY），此后每个 tick 都不再改
2. MdSpi.cpp:231-329 填价格/量/盘口，但从不设 m_updateType / m_endPkt
3. rms.updateLTPFromMD(g_pUpdate)
     - 第一行: if (mdUpdate->m_endPkt) return;      ← m_endPkt 未初始化（POD 默认构造）
     - isTrade = (updateType=='T'||'X'||'I')        ← 'O' 永远 false
     - isLTP0  = m_ticketIsLTPSet[symbol]==false     ← 表里只有 ""（EnabledSymbols 的空 Symbol），查不到 → false
   ⇒ 两个条件都不成立 → m_tickerToLTUpdates 永不写入真实 LTP
4. RmsChecks 里 price = (lastTradePrice) ? lastTradePrice : req.Price;  ← lastTradePrice==0 → 用请求价
```

结论：

- `ORDER_LIMIT_CHECK`（金额）即使启用也**用请求价而不是 LTP**；
- `X_PERCENT_AWAY_FROM_LTP_CHECK` 若启用，`ltp=0` → 任何正价格都"偏离 100%"→ 全拒；
- `STOP_LOSS_CHECK` 的浮动盈亏按 `lastTrdPx=0` 算 → 失效。

证据：`main.cpp:77-81`、`MdSpi.cpp:231-251,327-328`、`rmsimpl.hpp:195-244`、`rmschecks.cpp:374-388,1018-1038`、`rmslimits.h:346-366`（V 代码路径；`m_endPkt` 是否恰好为 0 取决于堆内存，属 I）。

> 复刻时**必须**修：让 `m_updateType` 正确反映"有成交"（`MDUPDTYPE_TRADE`）并初始化 `m_endPkt=0`，否则 RMS 的价格类规则全部不可用。

---

## 6. 行情与日初数据

### 6.1 行情链路

```text
CTP MdApi ──OnRtnDepthMarketData──► CMdSpi
   ├─ 填 g_pUpdate（复用全局对象）
   ├─ MDHandler::ProcessMDUpdate: m_timestamp=now, m_seqnum=++seq, write(MD SHM 4097)
   └─ ORS::rms.updateLTPFromMD(g_pUpdate)   ← 见 §5.9
TradeBot: Connector::HandleUpdates
   ├─ m_endPkt==1 或 无 INTERESTED_SYMBOLS → 全量转发
   ├─ 否则按 m_interestedsymbols_for_md 过滤，并回填 m_symbolID（0..N）
   └─ CommonClient::SendInfraMDUpdate → 策略回调
```

证据：`MdSpi.cpp:231-329`、`MDHandler.cpp:32-71`、`connector.cpp:770-784`（V）。

### 6.2 订阅范围

- ORS 在 `OnRspQryInstrument` 里把 **`ProductClass == '1'`（期货）** 的全部合约放进 `m_symbolMap`，然后**逐合约** `SubscribeMarketData(&symbol, 1)`（V，`ORSServer.cpp:1827-1862`、`MdSpi.cpp:152-163`）。
- **期权（`ProductClass=='2'`）不订阅、不进 `m_symbolMap`** → 期权行情永远不会出现在 SHM。若策略要交易期权，必须改这里（这是"期权策略不可用"的根因之一，V）。
- 订阅是"全市场期货"，不是"策略关心的合约"：现网 1000+ 合约 → 行情洪峰。TradeBot 侧再做过滤（`INTERESTED_SYMBOLS`）。
- `m_symbolID` 由 TradeBot 侧按 `INTERESTED_SYMBOLS` 的插入顺序重编号（V，`connector.cpp:50-62`），ORS 不填。

### 6.3 时间戳与夜盘

| 字段 | 语义 | 坑 |
|---|---|---|
| `m_exchTS` | `mktime(登录日的 0 点 + CTP UpdateTime) * 1000 + UpdateMillisec` | 用**本机时区**；`tepoch` 只在 MD 登录时算一次 → **夜盘跨 00:00 后回跳 ~20.5 小时** |
| `m_timestamp` | ORS 本机 `CLOCK_REALTIME` ns | 可信 |
| `m_lastTradedTime` | = `m_exchTS` | 同上 |
| `m_totalTradedQuantity` | CTP `Volume`（当日累计） | 可用于算增量；ORS 不算（`m_lastTradedQuantity` 恒 0） |

证据：`MdSpi.cpp:126-138,221-228,238-244`（V）。

### 6.4 `contractfile`（合约规格表）

**消费者**（策略启动时读，路径硬编码）：

```cpp
Instrument::FillContractSpecs()   → /home/hft/tbdata/contractfile   （打开失败 exit(1)）
Instrument::FillOptionStrikeSpread() → 同路径（打开失败只打日志）
```

证据：`tbsrc/common/Instrument.cpp:1572-1581`、`:1545-1553`（V）。

**格式**（空格分隔，6 列 + 表头）：

```text
INSTRUMENT TICKSIZE LOTSIZE EXCHANGE PRICEFACTOR CONTRACTFACTOR
AP_F_0_ZCE 1.0 10 ZCE 0 FUTCOM
ag_F_6_SFE 1.0 15 SFE 0 FUTCOM
```

- 第 1 列是**内部合约名**（`<product>_F_<月>_<exch>` / `_O_` 期权 / 组合），不是 CTP `InstrumentID`。
- `EXCHANGE` 用**旧名**：SHFE 写作 `SFE`；`Instrument::SetExchangeType` 把 `SFE→CHINA_SHFE`（V，`Instrument.cpp:640-641`）。
- 匹配规则：`m_exchFlag != '0'` 用 `strcmp`（精确），否则用 `strncmp` 前缀（V，`:1592`）。
- 仓库内 `data_cpp/data/contractfile` 共 26,382 行（含表头，V：`wc -l`）；其中期货/期权/组合的分解（1,742 / 23,716 / 923）来自 `docs/UPSTREAM_SYNC.md:300`（P，未逐行复核）。仓库内**没有生成器**，190 上是软链到该文件（V，`scripts/ops_check_status.sh:211-245`）。

**ORS 的"合约 dump"不是这个文件**：ORS 每次启动把 CTP 查询结果写成 `<CONTRACT_FILE>_YYYY_MM_DD`，格式 `ScripCode|RoundLot|DecimalLocator|ExpiryDate|ExchangeID|PriceTick|IsTrading`（V，`ORSServer.cpp:1672-1678`）。两者**列数、分隔符、命名全不同**，只对期货家族有效，需要跨日累积才能补齐（V，`docs/UPSTREAM_SYNC.md:322-340`）。复刻时不要混用。

### 6.5 `fee.csv` 与 `fee_refresh`

**消费者（关键路径）**：

```cpp
LoadTCost2(simConfig)                       // 启动时对每个策略调用
  open("/home/hft/tbdata/fee.csv")          // 打不开 exit(1)
  for each line: Tokenizer(line, ",", ...)
     if (strncmp(instrument, Tokens[1], strlen(Tokens[1]))) continue;   // 前缀匹配、大小写敏感
     m_buyExchTx=Tokens[2]; m_sellExchTx=Tokens[3];
     m_buyExchContractTx=Tokens[4]; m_sellExchContractTx=Tokens[5];
  if (!found) exit(1);
```

证据：`tbsrc/main/TradeBotUtils.cpp:2460-2495`（V）。

**格式**（8 列，全非空）：

```text
exchange,instrument,fee_money_buy,fee_money_sell,fee_volume_buy,fee_volume_sell,multiplier,prevSettle
CFFEX,HO2610-C-2500,0,0,15.01,15.01,1,0
```

三条硬约束（读 `LoadTCost2` + `Tokenizer` 得出）：

1. 每行 8 字段非空——`strtok` 会跳过前导分隔符，空 `exchange` 会让整行左移一列，导致匹配不上（V，`fee_refresh/README.md:60-68`）。
2. `instrument` 大小写逐字照抄 CTP（CFFEX/ZCE 大写，DCE/SFE/GFEX 小写）；`strncmp` 大小写敏感（V）。
3. 无重复 instrument——`LoadTCost2` 匹配到不 `break`，**最后一行生效**（V）。

**生成器**：`ors/tools/fee_refresh`（独立二进制，不链 ORS/RMS/Logger，只链 `libthosttraderapi_se.so`）：

| 能力 | 实现 |
|---|---|
| 合约全集 | `ReqQryInstrument`（空 ID）→ 保留 `ProductClass ∈ {'1','2'}` |
| 费率 | `ReqQryInstrumentCommissionRate`（多 BizType，优先 `'1'`，按 instrument 去重） |
| 昨结算 | `ReqQryDepthMarketData`（`--with-settle`，默认从现表结转） |
| 保证金 | `ReqQryInstrumentMarginRate`（`--margin-out`，写单独 CSV） |
| 输出 | `--apply` 写 `data_cpp/data/fee.csv`（默认 dry-run），写前备份到 `/root/quantlink-backups` |
| 凭据 | 复用 `ors_server.cfg`（只读，**不打印**） |
| flow | 独立 `<API_LOG_DIR>/fee_refresh/`（**必须带尾斜杠**，否则 `.con` 文件落到 CWD 覆盖 ORS 的流文件） |
| 限流 | 柜台连续查询 ~400 笔会 4097 断连 → 支持 `--skip N` 分段重跑、断线续跑 |

证据：`ors/tools/fee_refresh/fee_refresh.cpp:127-145,1600-1645,1648-1664`；`README.md:18-90`；`scripts/ops_refresh_fee.sh`（V）；cron `40 15 * * 1-5`（V，`ops/crontab.txt`）。

> 与 TradeBot 的路径不一致：工具写 `data_cpp/data/fee.csv`，策略读 `/home/hft/tbdata/fee.csv`。中间靠部署脚本/软链（`build_deploy_cpp.sh` 的 `--config-only` 只同步 `config/controls/models`，**不含 data/**）。复刻时要把这一步显式化（I，见 §9.6）。

### 6.6 `trading_days` / `session_rules` / 日历门控

| 文件 | 消费者 | 说明 |
|---|---|---|
| `data_cpp/data/trading_days.txt` | `scripts/is_trading_day.sh`（启停门控）、md-recorder | 每行一个 `YYYYMMDD`，升序；仓库自带 2006-04-17 → 2027-12-31（V，`UPSTREAM_SYNC.md:20`） |
| `data_cpp/data/session_rules.csv` | `ops_night_session.py`（重算 control 的时段窗口）、`ops_feed_db.py`（写 `tbtrade_sections`） | 列：`product,exchange,am_start,am_end,pm_start,pm_end,night_start,night_end,is_trading`（V，文件 9 行） |
| control 文件时段 | TradeBot 自己 | `control.<...>.par.txt.<sid>` 末尾的 `0100 0700` 是 **UTC**（北京 09:00–15:00）（V，`BACKTEST_GUIDE.md:159-166` + control 文件样例） |
| 日历门控 | `start_all.sh ctp` / `ops_start_session.sh` | 非交易日/节前夜盘 → **拒绝启动**（fail-closed，日历读不到也拒） | `build_deploy_cpp.sh:547-567`、`scripts/ops_start_session.sh:33-48`（V） |

> 注意：TradeBot **自己不读** `trading_days.txt`，也不读 `session_rules.csv`；它只按 control 文件里的 UTC 窗口交易。日历门控是**启动脚本**的职责（V，grep 在 `tbsrc/` 0 命中）。

### 6.7 md recorder（行情落盘）

| 项 | 内容 | 证据 |
|---|---|---|
| 作用 | 只读 MD SHM 4097 → `u50_YYYYMMDD.csv`（回测/复盘输入） | `data_cpp/bin/config/md-recorder.yaml:1-13`（V） |
| 硬约束 | `qlen: 4096`（因为 ORS 实际建 4096 槽）、`data_size: 816`、`node_size: 824`、`seqno_off: 816` | 同上（V，数值与 §0.2 实测一致） |
| 启停 | cron `20:47` / `08:47` 启动；`scripts/ops_stop_md_recorder.sh` 停 | `scripts/ops_start_md_recorder.sh:1-45`（V） |
| 源码 | **不在本仓库**（`deploy_cpp/bin/md-recorder` 来自外部/其它仓库） | `ops/crontab.txt`（V 引用，源码缺失 I） |
| 与 check-md 的关系 | `check-md` 也是"只读 attach + 比较 head"的探针（Go 重写），用于判活而非录制 | `scripts/check_md:1-11`、`.claude/CLAUDE.md:618-620`（V 脚本 / I 实现） |

---

## 7. 模拟 / 回放 / 回测

### 7.1 模式矩阵

TradeBot 只有四个 CLI 模式（`main.cpp:404-413`）：

| 模式 | 参数 | `INTERACTION_MODE` | 数据来源 | 是否撮合 | 是否用 SHM |
|---|---|---|---|---|---|
| 实盘 | `--Live` | `LIVE` | SHM 4097（ORS） | 交易所 | ✅ 4097/8193/12289/16385 |
| 模拟 | `--Sim` | `SIMULATION` | `MDDUMP/<date>/<EXCH>_DATA.dat` | **ExchSim 本地撮合** | ❌ |
| 回归 | `--Regress` | `SIMULATION`（同一分支） | 同上 + `--paramFile` | 同上 | ❌ |
| LeadLag | `--LeadLag` | 同 Sim 分支 | 同上 | 同上 | ❌ |

证据：`main.cpp:404-413,636-666,1076-1128`；`connector.cpp:71-197,599-660`（V）。

`Connector` 库里还有 `GUI / REPLAY / REPLAYPROC / PARALLELSIM / SANITYCHECK / PEEK / INSTINETLIVE` 等模式（`connectorconfig.h:14-40`），但 **TradeBot 主程序不用它们**；`PARALLELSIM` 通过 `--parallelSim` 打开，从独立 SHM（`SHMKEY`）读 `SimDataWrapper`，由外部回放器喂数据（V，`main.cpp:1080-1127`、`connector.cpp:1061-1110`）。

### 7.2 `SimConfig.cfg` 键

```ini
MDDUMP = /home/hft/convert_md/data/   # 数据根目录（<MDDUMP>/<date>/<EXCH>_DATA.dat）
NEW_EXCHDELAY = 2                     # 模拟撮合的"交易所时延"参数
CXL_EXCHDELAY = 3
TIMEWISEPRIORITY = true               # 同价位按时间优先
DATES = 20230822                      # 回放日期（多日逗号分隔）
EXCHID = CHINA                        # 交易所/文件前缀
ENDPACKETINTERVAL = 0
SEQUENCER = LOCAL_TIME
DATA_FORMAT = NSEFO:MetaDataWithSnappy
COLLECT_STATS = true
SETTIMEASGLOBAL = true
APPLY_MD_TAMPER = false
STAT_TYPES = ...
MATCH_THRESHOLD = 0
SEND_MISSING_TS = false
CLOCK_MOVEMENT = ON_LOCAL_TIME
MD_BOOK_TYPE = EXCHANGE
```

证据：`tbsrc/SimConfig/SimConfig.cfg:1-20`；解析在 `connectorconfig.h:219-260`（`DATA_FORMAT_ENGINE` 等）+ `exchsim.hpp`（V）。

### 7.3 `--Sim` 到底做了什么（与文档冲突）

```text
Connector(SIMULATION) → new ExchSim(mdCb, ordCb)
  └─ StartAsync → StartSimulation
       ├─ FileReader<SimDataWrapper&, SequencerBasedDataProcessorV2>
       ├─ fileReader.configure(INTERESTED_SYMBOLS)
       ├─ m_exchSim->init(responsePath)
       └─ fileReader.start_processing()   → 每个 tick → ExchSim::UpdateOrderBook → SimEngine::ProcessOnMarketUpdate
订单: Connector::PushRequest → m_exchSim->SendRequest(msg) → tick->PostRequest(msg) → 撮合 → m_orscb(ResponseMsg)
```

证据：`connector.cpp:188-197,648-652,1112-1147`；`exchsim.hpp:599-639`；`simengine.h:24-75`（V）。

| 结论 | 证据 |
|---|---|
| **`--Sim` 会撮合**（ExchSim + SimEngine 按盘口/成交撮合），不是"只回放不成交" | V |
| 撮合器每合约最多 **50 张挂单/50 条请求**（`OrderReq m_req[50]; OrderReq m_openOrders[50]`），超出行为未定义/丢弃 | V，`simengine.h:61-62` |
| 模拟成交也走**同一套 `ResponseMsg` 回调路径**（`TRADE_CONFIRM`/`NEW_ORDER_CONFIRM`），但**不经过 SHM、不经过 ORS、不经过 RMS** | V，`connector.cpp:787-790` |
| 因此模拟盘**测不到** RMS、SHM 编解码、CTP 语义、开平仓决策 | V |

> `docs/BACKTEST_GUIDE.md:293` 写"DisconnectedSimEngine 不撮合订单：SendOrder 只是策略逻辑输出，不会产生成交回报和持仓变化"——**与当前代码矛盾**：仓库里没有 `DisconnectedSimEngine` 这个类（全仓 grep 0 命中），且 `ExchSim::SendRequest → PostRequest → 撮合 → m_orscb` 明确产生回报。该文档段落为 **P（过时）**，回测结果的可信度要以"是否有成交日志"为准。

### 7.4 数据格式与转换

| 项 | 内容 | 证据 |
|---|---|---|
| 单合约数据块 | `[compressed_size 8B][tick_count 8B][snappy(MarketUpdateNew[])]` | `docs/BACKTEST_GUIDE.md:18`（P，未在代码里核对；`convert_data/convert_md/main.cpp:633-672` 是按 `sizeof(MarketUpdateNew)` 拼 buffer，V） |
| 文件名 | `<EXCHID>_DATA.dat` + `<EXCHID>_METADATA.dat`（`EXCHID=CHINA_SHFE` → `CHINA_SHFE_DATA.dat`） | `BACKTEST_GUIDE.md:50-51,290`（P/I） |
| 转换工具 1 | `convert_futures <date> --symbols a,b --input /home/u50_data` → `./source/<date>/CHINA_{DATA,METADATA}.dat` | `BACKTEST_GUIDE.md:63-73`（P） |
| 转换工具 2 | `convert_data/convert_md`（新版，`ag.sh`/`dce.sh`/`zce.sh`… 封装）→ `./data/<date>/` | `convert_data/convert_md/main.cpp`、`BACKTEST_GUIDE.md:79-119`（V 代码存在 / P 用法） |
| 输入 CSV | u50 43 列 CTP 格式（含 5 档） | `BACKTEST_GUIDE.md:75,295`（P） |
| MD 录制 | 现网用 `md-recorder` 直接产 u50 CSV（§6.7） | V |

### 7.5 回测 vs 实盘的差异（决定"回测能不能信"）

| 维度 | 实盘 | `--Sim` | 影响 |
|---|---|---|---|
| 行情来源 | CTP → SHM | 本地 snappy 文件回放 | 回放没有网络抖动/丢包/乱序 |
| 行情时间 | 本机 `m_timestamp` + CTP `m_exchTS` | 文件里的 `m_exchTS` 直接驱动 | 回测时间轴是"交易所时间"，实盘是"到达时间" |
| 撮合 | 交易所 | SimEngine（盘口/成交驱动，50 单上限） | 排队位置、部分成交、撤单竞争都不真实 |
| 手续费 | `fee.csv`（`LoadTCost2`，按合约前缀匹配） | 同一份 `fee.csv` | 一致；但费率可能过期 |
| 滑点 | 真实 | 由 `NEW_EXCHDELAY/CXL_EXCHDELAY/TIMEWISEPRIORITY` 近似 | 回测偏乐观 |
| 保证金/资金 | 柜台校验 | **完全不校验** | 回测可以"零资金"跑出巨额成交 |
| RMS | ORS 前置检查 | **不经过** | 回测不会出现 `RMS_REJECT`，`MAX_*` 额度形同虚设 |
| 拒单 | 柜台各种原因 | 只有撮合器内部规则 | 回测看不到"平仓量超过持仓""资金不足""报单过于频繁" |
| 持仓 | CTP 持仓 + `position.csv` | `daily_init.<sid>` 初始化 + 策略内部记账 | `avgPx` 不能为 0（否则策略启动即退出）（P，`BACKTEST_GUIDE.md:168-178`） |
| 时间 | 北京时间 | 策略日志 UTC；control 时段 UTC | 差 8 小时，容易看错（`BACKTEST_GUIDE.md:21`） |
| 进程拓扑 | ORS + N×TradeBot + tbadmin | 单 TradeBot（`--Sim` 不需要 ORS） | 回测测不到 SHM/多策略争抢 |

### 7.6 文档漂移清单（本文核对结果）

| 文档说法 | 代码事实 | 判定 |
|---|---|---|
| `BACKTEST_GUIDE.md:19,293`：`--Sim` 用 `DisconnectedSimEngine`，不撮合 | 无此类；`ExchSim` 撮合，产生 `ResponseMsg` | **P（错）** |
| `BACKTEST_GUIDE.md:123`：`LoadTCost2` 从 `/home/hft/tbdata/fee.csv` | 代码一致（硬编码） | V |
| `BACKTEST_GUIDE.md:206`：`--printMod 1` | 实际参数是 `--printMode` | **P（错字）** |
| `BACKTEST_GUIDE.md:31`：`config_CHINA.99201.cfg` | 仓库内是 `.92201/92202/...`（99201 是回测环境编号） | P（环境差异） |
| `STARTUP_GUIDE.md:255`：agent `MD_LEN_LIST=2048`，"写 4096 会 shmget EINVAL" | `md-recorder.yaml` 明确写 `qlen: 4096`（同样 attach 4096 槽段） | **冲突，未验证**（见 §11 Q3） |
| `docs/INTEGRATION_TEST_TBSRC_TBADMIN.md:783`：`ors_server sim 模式不启动 ORS` | 一致（`start_ors.sh` 的 sim 分支只打 WARN） | V |
| `.claude/CLAUDE.md` 的"示例"里写 ORS 用 YAML 读 SHM key | 实际用 `Configfile`（`key = value`） | **P（示例，勿当真）** |
| `README`（仓库根）链路图 | 与代码一致（4097/8193/12289） | V |

### 7.7 `tbsrc/regress`（回归/参数拟合）

- 目录里是**离线回归工具**（`StepRegress*.cpp`、`PartRegress.cpp`、`TwoStepRegress.cpp`、`CoefBoost.cpp`、`shift*.cpp` 等），各自有 `main()`，独立 `Makefile`（V，`tbsrc/regress/Makefile`）。
- 与 ORS/CTP **无任何关系**：输入是历史 tick/指标，输出是模型参数文件（`data_cpp/bin/models/model.*.par.txt.<sid>` 那种）（V：读 `tbsrc/regress/README` 与文件结构；具体算法属 `02-runtime-strategy.md`）。
- `--Regress` 模式（TradeBot 内）是"用参数文件跑一遍"（`LoadParamFile` 而非 `LoadControlFile`），也不是回测撮合器（V，`main.cpp:661-665`）。

---

## 8. 故障处理

### 8.1 故障矩阵

| # | 故障 | 现象 | 当前行为 | 安全? | 证据 |
|---|---|---|---|---|---|
| F1 | CTP 交易前置断开 | `OnFrontDisconnected`，交易回调停止 | `m_connected=false`，**订单仍可被接收并送 CTP**（会失败）；CTP 自动重连后重新认证/登录/查询 | ⚠️ 半安全：有重登，但断线期间的单全部 `ORS_REJECT` | `ORSServer.cpp:1888-1893,491-507`（V） |
| F2 | CTP 行情前置断开 | 无 tick，策略冻结在最后一帧 | `MdSpi::OnFrontDisconnected` 只打日志；CTP 自动重连 → `OnRspUserLogin` 里**重新订阅** | ✅ 已修（D13） | `MdSpi.cpp:40-46,139-149`（V） |
| F3 | 行情静默断流（socket CLOSE-WAIT / Recv-Q 积压） | 进程活着、日志无错、无 tick | 无自愈；靠外部看门狗（`ops_md_liveness_watchdog.sh`，读 SHM head 差值） | ⚠️ 依赖外部 | `.claude/CLAUDE.md:594-637`（I） |
| F4 | 下单过频被柜台拒 | `ORDER_ERROR`（CTP ErrorID） | 原样转发给策略；策略层无退避时会连环重发（D9/D10） | ❌ | `docs/test/2026-10-12_上线测试清单_国盛柜台.md:60-64`（P 计划 / I 现场） |
| F5 | SHM 写满（读者落后 > N） | 无报错，静默丢最旧 | 无检测、无告警；读者 `tail=seqNo+1` 直接跳 | ❌ | §3.3（V） |
| F6 | SHM 段被清（`ipcrm`/ORS 重启） | 存活 TradeBot 数据冻结 | 不重连、不重建；只能重启进程 | ❌ | §3.7（V） |
| F7 | ORS 重启 | 本地订单表清空 | 旧单回报被丢（FATAL 日志）、旧单无法撤；持仓重新查询 | ⚠️ 持仓安全，订单不安全 | `ORSServer.cpp:2287-2321`（V） |
| F8 | 柜台返回 `ErrorID=7 还没有初始化` | 开盘前登录失败 | 退避 5 次（3/6/12/24/30s）后 `exit(1)` | ⚠️ 比原来好，仍需看门狗 | `ORSServer.cpp:2072-2099`（V） |
| F9 | 双启动 / 双登录 | 先登录的 MD 被静默踢掉，**全天零行情** | 启动脚本硬拒绝 + 等待 90s | ✅ | `build_deploy_cpp.sh:338-361,700-733`（V） |
| F10 | CTP 流控（`-2/-3`） | `ReqOrderInsert` 返回非 0 | `ORS_REJECT`（1000101），无重试 | ⚠️ 无退避 | `ORSServer.cpp:969-974`（V） |
| F11 | 持仓查询失败 3 次 | 启动降级 | `m_connected=true`，用 `position.csv` 开跑 | ❌ 可能用陈旧持仓误判开平 | `:2038-2042`（V） |
| F12 | 合约查询返回 0 条 | "启动成功"但无行情 | 无校验 | ❌ | §1.9（V） |
| F13 | 结算单未确认 | 柜台拒交易 | ORS 自动确认（不读内容） | ⚠️ 合规缺口 | `:2102-2109`（V） |
| F14 | 磁盘满 / 日志写失败 | logger 构造抛异常 | `throw("Unable to open the log file")` → 未捕获 → terminate | ⚠️ 快速失败（可接受） | `bglogworker.cpp:59-61`（V） |

### 8.2 CTP 断连的完整时序

```text
[断]
OnFrontDisconnected(reason)  → m_connected=false（不影响订单入口）
[CTP 内部重连]
OnFrontConnected → Authenticate → OnRspAuthenticate → ReqUserLogin
  ├─ 成功 → 结算确认 → 合约查询（重建 symbolMap、重新订阅 MD、重建 RMS 仪器表）
  │        → 1.1s 后持仓查询 → 整表替换 mapContractPos → 写 position.csv → m_connected=true
  └─ 失败 → OnLoginFailure 退避 5 次
```

坑：

1. **重连后 `m_ordLocalMap` 不清空**（只在进程重启时清空）。若柜台在断连期间已经撤销/成交了旧单，重连后 `OnRtnOrder` 可能用**旧 OrderRef** 找到旧记录并更新——这其实是好事；但若 SessionID 变了，旧单的 `OrderRef` 在新会话里可能已失效，撤单会失败（I）。
2. **持仓整表替换会覆盖断连期间的人工操作**：重连查询结果为准（V）。
3. **重连期间 `m_connected` 为 false 但订单入口不拦**（§8.1 F1）。

### 8.3 SHM 满 / 覆盖 / 丢消息

| 问题 | 结论 |
|---|---|
| 会不会阻塞生产者？ | 不会（`isFull()` 恒 false） |
| 丢了什么？ | 读者落后超过 N 时，**最旧的未读消息被覆盖** |
| 能发现吗？ | 不能。读端不校验期望序号；`m_seqnum` 只在 MD 里自增，回报里根本没有序号 |
| 怎么观测？ | 只能间接：MD `m_seqnum` 跳变、`getMinHighestPowOf2` 推算的段大小 vs `ipcs -m`、或加一个"写者 head - 读者 tail"的探针（check-md 就是这么做的） |
| 复刻建议 | 在 slot 里加 CRC/长度；读端检测 `seqNo != tail` 时打 `SHM_GAP` 告警并计数（**不改协议**也能做，因为 seqNo 已存在） |

### 8.4 ORS 重启（最常见、最危险的操作）

**重启前必须知道**：

1. `createResponseClient`/`createRequestClient` 用 `IPC_EXCL`，**旧段还在就拒绝启动**（`Queue already exists`）。所以脚本先 `ipcrm`（V，`build_deploy_cpp.sh:363,736-738`）。
2. `ipcrm` 会让存活 TradeBot 的映射变成"孤儿"，数据冻结（§3.7）。
3. 本地订单表为空 → 重启前所有在途单：
   - 成交回报：`OnRtnTrade` 查 `m_ordExchMap[OrderRef]` 失败 → `ILOG(FATAL)` + **丢弃**（V，`:3237-3245`）；
   - 状态回报：`OnRtnOrder` → `GetOrderInfo` 失败 → **丢弃**（V，`:2573-2576`）；
   - 策略想撤：`SendCancelOrder` 查 `m_ordLocalMap` 失败 → `CANCEL_ORDER_REJECT "New not found for Cancel request"`（V，`:1105-1111`）。
4. 持仓会重新查询并对齐（V，`:1422-1566`）。
5. `position.csv` 会被重写为柜台真值（V，`:1444,1558`）。

**安全的重启顺序（I，建议写进 runbook）**：

```text
1) stop 所有 TradeBot（先停策略，停止发单）
2) 人工/脚本撤掉所有在途单（柜台 App 或 tbadmin）
3) stop ORS（等 ≥90s，或确认进程消失）
4) ipcrm 所有相关段（脚本已做）
5) start ORS（等 m_connected：日志出现 "Position query done, ORS ready"）
6) 核对 position.csv 与柜台
7) start TradeBot（走日历门控）
```

**不安全的做法**：只 `kill -9 ors_server` 然后立刻拉起（双登录风险 + 在途单失联 + TradeBot 段失效）。

### 8.5 序列 gap

| 队列 | 有序号吗 | 能检测 gap 吗 |
|---|---|---|
| MD (4097) | `slot.seqNo` + `m_seqnum`（ORS 自增） | 可以（读者比较连续 seqNo），但**当前没有代码做** |
| Req (8193) | `slot.seqNo` | 可以，没有做 |
| Resp (12289) | `slot.seqNo` | 可以，没有做；`ResponseMsg` 无业务序号 |

复刻时建议：把"读者期望序号 vs slot.seqNo"的差异做成计数器 + 周期性日志，这是**唯一**能发现 SHM 丢消息的手段。

### 8.6 带仓 / 带单启动

| 场景 | ORS 行为 | 安全? |
|---|---|---|
| 有隔夜仓，无在途单 | 启动查询 CTP 持仓 → 整表替换 → `position.csv` 对齐 | ✅ |
| 有隔夜仓 + 有在途单 | 持仓会包含"已冻结"的量（CTP `Position` 含挂单占用？实际 `Position` 是持仓，挂单在 `Frozen` 里）；ORS **不查挂单** → 可能重复平仓 | ❌ |
| `position.csv` 与 CTP 不一致 | 打 `POSITION MISMATCH`，以 CTP 为准 | ✅ |
| `position.csv` 里有 CTP 没有的合约 | 打 `POSITION STALE ... cleared`，整表替换清掉 | ✅（2026 修复） |
| 持仓查询 3 次失败 | 用 `position.csv` 直接开跑 | ❌（F11） |
| `POSITION_FILE` 路径不存在 | 打 `Unable to load position file`，`mapContractPos` 为空；之后 CTP 查询会补上 | ⚠️（启动会慢/降级） |

### 8.7 `position.csv` 语义（必须精确理解）

```
文件格式（无表头）:
  <symbol>,<ONLongPos>,<todayLongPos>,<ONShortPos>,<todayShortPos>
例:
  au2612,0,0,3,0
  au2701,2,0,0,0
```

| 属性 | 说明 | 证据 |
|---|---|---|
| 写入时机 | 启动查询完成、空仓查询完成、每轮持仓查询完成、`Stop()` | `ORSServer.cpp:1444,1558,264`（V） |
| 不是实时 | 成交后**不会**立即更新文件（只在内存 `mapContractPos` 里加减） | `:1290-1385`（V） |
| 读者 | 只有 ORS 自己（`POSITION_FILE` 是 ORS 独有键）；TradeBot 读的是 `daily_init.<sid>` | `.claude/CLAUDE.md:790-792`（V 断言 + I 现场） |
| 与 `daily_init` 的区别 | `position.csv` = "CTP 查询结果快照"；`daily_init.<sid>` = "策略的昨仓/均价初始化"，格式 `StrategyID 2day avgPx name1 name2 ytd1 ytd2` | `data_cpp/data/daily_init.92201:1-2`（V） |
| 可否当对账源 | **不可以**（时点文件，且可能停留在上一轮查询） | V |

### 8.8 双启动 / 双登录（现场事故形态）

- 起因：`stop_all.sh` 发完 TERM 就返回，上层 3 秒后拉起新 ORS；旧 ORS 还在 CTP Release（~70s）。
- 结果：同账号双登录 → CTP 把先登录的 MD 连接**静默踢掉**（只发 FIN），而 `MdSpi::OnFrontDisconnected` 不重连 → 当天零行情。
- 现在的防线：`start_ors.sh` 硬拒绝 + `stop_all.sh` 等 90s + `start_all.sh` 先 `stop_all` 兜底（V，`build_deploy_cpp.sh:338-361,700-733`、`ops_start_session.sh:52-58`）。
- 仍存在的窗口：`kill -9` 后 3 秒内手动 `./ors_server`（绕过脚本）（I）。

### 8.9 判活（不要把日志当心跳）

- logger 是异步队列，`log/ors_server*` 里的 `RECVMD` 可能十几分钟不落盘（V，`active.cpp` + 现场记录）。
- 正确判活：读 MD SHM 的 `head`，两次采样差值 > 0（`check-md -probe` / `ops_md_liveness_watchdog.sh`）（V 脚本 / I 实现）。

---

## 9. 复刻要点

### 9.1 最小可运行集

| 组件 | 必需 | 作用 |
|---|---|---|
| Linux x86-64 + GCC（C++17） | ✅ | 生产是 Rocky 9.8 + GCC 11.5（无 devtoolset） |
| CTP SDK 6.7.11（`libthosttraderapi_se.so` + `libthostmduserapi_se.so` + 4 个头） | ✅ | 与头文件版本必须一致（6.7.11 vs 6.7.13 的 `CreateFtdcMdApi` 签名不同） |
| `ors_server` | ✅ | 行情 + 路由 + RMS |
| `TradeBot` | ✅ | 策略引擎（另一个仓库/文档） |
| `fee.csv` + `contractfile` + `daily_init.<sid>` + `trading_days.txt` | ✅ | 策略启动硬依赖（缺 → `exit(1)`） |
| `ors_server.cfg` | ✅ | **含凭据，不入 git** |
| `config_CHINA.<sid>.cfg` | ✅ | TradeBot 侧 SHM key（必须与 ORS 一致） |
| RMS 两个 XML | ✅ | 缺标签/缺值 → 启动 throw |
| PostgreSQL / tbadmin / Vue / web-go | ❌ | 与本链路无关（管理面） |

### 9.2 配置键对照（ORS ↔ TradeBot，必须一致）

| 语义 | ORS 键（`ors_server.cfg`） | TradeBot 键（`config_CHINA.<sid>.cfg`，`[CHINA_*]` 段） | 生产值 |
|---|---|---|---|
| 行情 SHM | 硬编码 `MD_SHMKEY 4097` | `MDSHMKEY` | 4097 |
| 行情槽数 | 硬编码 `MD_SHMSIZE 2048` | `MDSHMSIZE` | 2048 → 实际 4096 |
| 请求 SHM | `REQUEST_SHMKEY` / `REQUEST_SHMSIZE` | `ORSREQUESTSHMKEY` / `ORSREQUESTSHMSIZE` | 8193 / 1024 |
| 回报 SHM | `RESPONSE_SHMKEY` / `RESPONSE_SHMSIZE` | `ORSRESPONSESHMKEY` / `ORSRESPONSESHMSIZE` | 12289 / 1024 |
| 客户端 ID | `CLIENT_STORE_KEY` | `CLIENTSTORESHMKEY` | 16385 |
| 最大客户端 | `MAX_CLIENTS` | — | ≤250 |
| 账户 | （RMS XML 的 `Account name`） | `ACCOUNT`（`StrategyConfig.cfg`） | `OWN` |
| 回报过滤 | — | `RESPONSE_FILTER_TYPE`（默认 `STRATEGY_FILTER`） | 默认 |
| 行情/回报同线程 | — | `ASYNC_MD_AND_RESPONSE`（默认 false） | 默认 |

证据：`ORSServer.cpp:104-109`、`MDHandler.h:17-21`、`config_CHINA.92201.cfg:16-23`、`connectorconfig.h:283-340`（V）。

### 9.3 二进制契约（跨语言复刻必须遵守）

| 项 | 值 | 说明 |
|---|---|---|
| `sizeof(MarketUpdateNew)` | **816** | Header 96 + Data 720 |
| `sizeof(RequestMsg)` | **256**（align 64） | 含 `char padding[20]` 与 `Product[32]`、`StrategyID` |
| `sizeof(ResponseMsg)` | **176** | |
| `QueueElem<T>` | `sizeof(T)` 向上补齐到 `alignof(T)` + 8 | Req → 320（不是 264） |
| Slot 布局 | `data` 在前，`seqNo`（uint64）在后 | `seqno_off = sizeof(T)` |
| 队列头 | `atomic<int64_t> head`（8 字节），初值 1 | |
| 槽数 | `getMinHighestPowOf2(cfg)` = 2 的幂且 **严格大于** cfg | 2048→4096 |
| 字节序 | 本机（x86-64 小端） | 没有 hton/ntoh |
| 字符串 | 定长 `char[]`，不保证 `\0` 结尾（`memcpy` 填） | |

> 建议复刻时**生成**一份 `shm_layout.json`（offset/size/align 全部导出），Java/Python/Rust 侧按它建结构，并把"编译期 static_assert(sizeof(...)==816)"写进 CI。当前仓库只有 `C++_deps/platform/shm_alignment_test.cpp` 这个手工工具（V）。

### 9.4 测试计划（最小充分集）

| # | 用例 | 通过标准 | 依赖 |
|---|---|---|---|
| T1 | 无配置启动 | 打印 `Requires config file as argument`，退出码 -1=255 | — |
| T2 | 缺 `MULTICAST_ADDR` / `INVESTOR_ID_SHFE` | 打印 `FATAL: config error file=... key=...`，不进入网络 | — |
| T3 | 正常启动 | 日志出现 `Trader login done` → `Position query done, ORS ready`；`ipcs -m` 段大小符合 §3.2 | 柜台 |
| T4 | `PRODUCTION_MODE` 配错 | 评测前置：`ErrorID=4040`；生产前置：认证通过 | 柜台 |
| T5 | 下单 → 确认 → 成交 | 收到 `NEW_ORDER_CONFIRM`（或直接 `TRADE_CONFIRM`）+ 每笔 `TRADE_CONFIRM`；`position.csv` 在查询后一致 | 柜台 |
| T6 | 部分成交后撤单 | 收到 `CANCEL_ORDER_CONFIRM`，`Quantity`=剩余量；成交总量=原量 | 柜台 |
| T7 | 平仓量 > 持仓 | `ORDER_ERROR`（柜台拒），本地 `mapContractPos` 回滚 | 柜台 |
| T8 | RMS 频率打满 | 第 21 笔/秒收到 `RMS_REJECT`，`ErrorCode=100107` | 本地 |
| T9 | RMS 单合约挂单 > 450 | `RMS_REJECT`，`ErrorCode=100105` | 本地 |
| T10 | 撤单 1001 次（LIMIT+DAY） | `RMS_REJECT`，`ErrorCode=100124` | 本地 |
| T11 | 断网 30s 恢复 | 行情自动恢复（`RECVMD` 继续）；持仓重新查询；无重复下单 | 柜台 |
| T12 | `kill -9` ORS → 重启 → 旧单成交 | 观测到 `OrderRef ... not found in map`（FATAL），确认**没有**错配回报 | 柜台 |
| T13 | 双启动 | 第二个进程被脚本拒绝；手动绕过时观察 MD 是否被踢 | 柜台 |
| T14 | SHM 覆盖 | 人为让读者停 60s，恢复后应观测到 `m_seqnum` 跳变（当前无告警，只能人工看） | 本地 |
| T15 | `--Sim` 回放一日 | 有 `TRADE_CONFIRM` 日志（证明确实撮合）；成交笔数与盘口流动性大致相符 | 本地数据 |
| T16 | 持仓文件缺失 | 启动仍成功（`Unable to load position file`），持仓以 CTP 为准 | 柜台 |

### 9.5 改进项（按"复刻时是否必须"排序）

**必须（否则复刻出来不能用）**

1. **加 `OrderID` 去重**（§4.6）。至少保留最近 1 万个终态 ID。
2. **修 `m_updateType` / `m_endPkt`**，让 RMS 的 LTP 真正可用（§5.9）。
3. **撤单补齐 `CHINA_GFEX`**，并按交易所正确处理平今/平昨（§2.9 O-5/O-6）。
4. **去掉密码日志**（§2.9 O-2）。
5. **启动顺序**：合约查询完成后再 `m_connected=true`（§1.9）。
6. **二进制契约 CI**：`static_assert` + 导出 offset 表（§9.3）。

**强烈建议（生产可用性）**

7. **SHM gap 检测 + 告警**（§8.3）。成本极低（seqNo 已存在）。
8. **订单查询补齐**：启动 `ReqQryOrder` 重建在途单表，或在 `position.csv` 旁落一份 `orders.csv`（§8.4）。
9. **`ORS_REJECT` 分错误码**（§2.9 O-3）。
10. **RMS 增加资金/可平量检查**，或明确文档化为"不做"（§5.7）。
11. **`SIGUSR1` 真正清空 RMS 累计量**，或改日志文案（§5.8）。
12. **MD 时间戳**用 `mktime` 前先做"跨日修正"（夜盘 00:00 后 +1 天）（§6.3）。

**可选（架构演进）**

13. 用"每策略独立请求队列"替代"共享 8193 + clientId 编码"（当前 `MAX_CLIENTS=250` 且 clientId 单调，重启会冲突）。
14. 用无锁 SPSC + 明确 backpressure 取代 MWMR 覆盖式队列。
15. ORS 增加 health/readiness 端点（当前只能看日志/探针）。

---

## 10. 证据索引（本文引用到的关键位置）

| 主题 | 文件:行 |
|---|---|
| ORS 构建/宏/依赖 | `ors/CMakeLists.txt:13,16-26,33-40,45-56,71-115,118-143,160-180` |
| ORS 入口/argv/日志 | `ors/China/src/main.cpp:50-58,62-68,75-99` |
| 配置键读取 | `ors/China/src/ORSServer.cpp:102-117,131-145,403-415` |
| SHM 创建 | `ORSServer.cpp:113-120`；`shmmanager.h:280-294,314-378,494-541,890-938` |
| 队列实现 | `multiwritermultireadershmqueue.h:15-30,73-106,118-133,196-211,245-255` |
| 段分配 | `shmallocator.h:46-67`；`sharedmemory.h:33-38,41-108` |
| 客户端 ID | `locklessshmclientstore.h:43-64,78-81` |
| 请求处理/下单 | `ORSServer.cpp:491-507,663-1073` |
| 改单拒绝 | `ORSServer.cpp:1075-1081` |
| 撤单 | `ORSServer.cpp:1083-1200` |
| 开平仓 | `ORSServer.cpp:513-594` |
| 回报推送/持仓更新 | `ORSServer.cpp:1208-1288,1290-1385` |
| 本地拒单 | `ORSServer.cpp:1387-1417` |
| 持仓查询/整表替换 | `ORSServer.cpp:1422-1566` |
| 合约查询/dump/RMS 仪器表 | `ORSServer.cpp:1806-1885` |
| 登录/重试/结算 | `ORSServer.cpp:1941-2165,2177-2191` |
| 订单状态机 | `ORSServer.cpp:2549-2782` |
| 成交 | `ORSServer.cpp:3207-3338` |
| 信号 | `ORSServer.cpp:3340-3413` |
| MD SPI | `ors/China/src/MdSpi.cpp:40-46,56-90,93-150,152-163,231-329` |
| MD SHM key/size | `ors/China/include/MDHandler.h:14-22`；`MDHandler.cpp:24-30,32-71` |
| 消息结构 | `C++_deps/hftbase/CommonUtils/include/marketupdateNew.h:166-557`；`orderresponse.h:17-22,59-84,134-295,379-561` |
| 错误码 | `C++_deps/hftbase/CommonUtils/include/errorcodes.h:12-76` |
| RMS 限值/XML 解析 | `C++_deps/hftbase/CommonUtils/include/rmslimits.h:19-160,198-651` |
| RMS 实现 | `C++_deps/hftbase/RMS_NEW/include/rmsimpl.h:39-215`；`rmsimpl.hpp:39-118,195-293,370-483,571-603,1288-1300,1493-1578` |
| RMS 规则 | `C++_deps/hftbase/RMS_NEW/src/rmschecks.cpp:31-237,277-301,330-537,541-592,873-1058` |
| 生产 RMS 配置 | `data_cpp/bin/config/ors/configs/rms/prod.china.rms.xml:1-55`；`prod.china.rms.firmwide.xml:1-16` |
| TradeBot 配置键 | `data_cpp/bin/config/config_CHINA.92201.cfg:1-23`；`connectorconfig.h:70-90,127,219-260,283-340` |
| TradeBot 连接器 | `tbsrc/hftbase/Connector/include/connector.h:171-249,269-372,389-405`；`src/connector.cpp:71-116,599-660,770-858,1061-1147` |
| 客户端注册 | `tbsrc/hftbase/Ipc/include/multiclientstoreshmreader.h:265-368` |
| TradeBot 下单 | `tbsrc/main/CommonClient.cpp:885-942,957-1026,1028-1089,1091-1147,1149-1158` |
| 费用表读取 | `tbsrc/main/TradeBotUtils.cpp:2460-2495` |
| 合约表读取 | `tbsrc/common/Instrument.cpp:610-650,1545-1608` |
| fee 生成器 | `ors/tools/fee_refresh/fee_refresh.cpp:110-189,127-145,1600-1664`；`README.md:18-90` |
| 回测指南 | `docs/BACKTEST_GUIDE.md:1-314`（多处为 P） |
| 启停脚本 | `scripts/build_deploy_cpp.sh:150-190,290-381,440-528,700-740` |
| cron/会话 | `ops/crontab.txt:41-58`；`scripts/ops_start_session.sh:1-66` |
| SHM 实测值 | `data_cpp/bin/config/md-recorder.yaml:1-13`；`check-md.yaml:1-9` |
| 现场缺陷记录 | `.claude/CLAUDE.md:594-660,770-800`（I，属运维笔记，非代码证据） |

---

## 11. 未验证 / 待确认

1. **`ors_server.cfg` 的真实内容**（尤其 `MAX_CLIENTS`、`REQUEST_SHMSIZE`、`POSITION_FILE`、`SHM_REQ_THREAD_*`）——文件不入 git，只能从现场读（**不要再把内容贴进任何文档**）。
2. **`ipcs -m` 的实际段大小**与 §3.2 的推算是否一致（决定 Java/tbadmin 侧的对齐契约）。
3. **agent `MD_LEN_LIST=2048` vs md-recorder `qlen=4096`** 的矛盾：两者都是 attach 同一个 MD 段，理论上一个用 2048 槽/一个用 4096 槽都能 attach（`shmget` 只要求请求 size ≤ 段 size），但 `STARTUP_GUIDE.md:255` 声称写 4096 会 `EINVAL`。需现场用 `ipcs -m` 定论（§7.6）。
4. **CZCE 平今用 `OF_Close` 是否被柜台接受**（O-6）：需在 CZCE 合约上实盘验证一次。
5. **`MaxOrderRef` 不 +1 是否会导致重复 OrderRef**（§2.8）：需在同一会话内重启 ORS 验证。
6. **夜盘 `m_exchTS` 回跳**对策略决策的实际影响（O-8）：需看策略是否用 `m_exchTS`（`MarketUpdateNew::m_lastTradedTime`）做时间窗判断。
7. **`--Sim` 撮合结果的真实性**：需要一次"有成交日志"的回放，与实盘同日的成交笔数对比（§7.3）。

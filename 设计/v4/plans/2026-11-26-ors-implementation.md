# ORS 实施计划

> **给执行代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项执行。步骤使用 `- [ ]` 跟踪。

**目标：** 用公司 ORS 的 CTP 订单/RMS 行为重写 ORS：一个账户一个进程，删除 SHM 和状态文件，改为 Aeron transport，只在 account/position/instrument 查询接入方式上做新增。

**架构：** 以 `/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/ors/China` 的 CTP 分支为业务主干，保留 `ORSServer`、`OrderInfo`、`m_ordLocalMap`、`m_ordExchMap`、RMS 和 CTP 回调；把 SHM 输入/输出和状态文件替换为 `OrsTransport` 与 CTP 查询。Aeron 只承载 contract 1.0.0 消息，不把旧 `OrderStatus/CancelState` 状态机带进核心。

**技术栈：** C++20、CMake、CTP TraderApi/MdApi、Aeron C++ 客户端、contract 1.0.0 SBE、Rocky Linux 190。

**规格：** `quantlink-docs/设计/v4/003-ors-v4.md`

**Contract：** `quantlink-venue-contract/abi/sbe/quantlink-fin-sbe.xml`

## 前置条件

C++ contract 头文件由 contract 仓库生成，不属于本 ORS 计划。开始任务 4 前，`OrsRequest`、`OrsResponse`、`AccountQuery`、`AccountSnapshot`、`MarketUpdate`、`SessionEvent`、`ClientRegister`、`ClientRegisterResponse` 的生成头文件必须位于 ORS 构建的 `CONTRACT_GENERATED_DIR`。不要在 ORS 里重复实现或手写 SBE 编解码。

## 全局约束

```text
公司 ORS 是订单/RMS/账户/持仓业务基线
CTP only：编译时固定 _USE_CTP_，不导入 Sgit 分支、Sgit 头文件或 Sgit 回调
一个 ORS 进程 = 一个 CTP 账户 = 一个 TraderApi = 一个 MdApi
不保留 SHM request/response/client-store
不保留 position.csv / contract 状态文件；配置文件和凭据文件仍可读
不沿用旧 CtpAdapter 的 OrderStatus/CancelState 状态机
不重写公司 ORS 的订单、撤单、RMS、终态逻辑
account query 是唯一新增业务接口；position/instrument 只改成查询初始化
OrderID 保持 clientId * 1_000_000 + orderCount
contract 固定 1.0.0；不引入旧 contract
纳入 003 §3.1 的生产修复：4040 模式、MD/Trader flow 目录拆分、登录重试/退避、MD 重订阅、MD 档位清零、查询限流
```

## 审查重点

- 未知或已从 map 删除的订单撤单：必须返回 `CANCEL_ORDER_REJECT`，不能静默丢，不能重新插入订单。
- 成交先于终态：`TRADE_CONFIRM` 不能让订单提前从 map 删除；只有公司 ORS 认定的终态才能清理。
- 旧 `FrontID/SessionID` 或旧 `OrderRef` 的延迟回报：必须丢弃，不能影响新订单或 RMS。
- 查询失败/空仓：不能回退到旧内存持仓，也不能让 session 进入 READY；空查询结果必须清空持仓表。
- Aeron back-pressure 或 publication 未连接：不能静默丢订单/撤单响应，必须上抛失败并保持订单状态可恢复。
- `ClientRegister` 重启复用：不能让新 `clientId` 复用 CTP 上仍存活订单的 OrderID 段。

---

### 任务 1：导入公司 ORS CTP-only 核心

**文件：**
- 新建：`ctp/core/ORSServer.h`
- 新建：`ctp/core/ORSServer.cpp`
- 新建：`ctp/core/MdSpi.h`
- 新建：`ctp/core/MdSpi.cpp`
- 新建：`ctp/core/MDHandler.h`
- 新建：`ctp/core/MDHandler.cpp`
- 新建：`ctp/core/main.cpp`
- 新建：`ctp/core/OrsTypes.h`
- 新建：`ctp/core/OrsConfig.h`
- 新建：`ctp/core/OrsConfig.cpp`
- 新建：`ctp/transport/OrsTransport.h`
- 新建：`ctp/transport/InMemoryOrsTransport.h`
- 新建：`ctp/transport/InMemoryOrsTransport.cpp`
- 新建：`ctp/vendor/hftbase/`，只放最小传递依赖头文件
- 修改：`ctp/CMakeLists.txt`
- 删除：`ctp/include/ors/ctp/`、`ctp/src/Aeron*.cpp`、`ctp/src/Contract*.cpp`、`ctp/src/Ctp*.cpp`、`ctp/src/InboundValidation.cpp`、`ctp/src/MarketDataFreshness.cpp`、`ctp/src/OfferRetry.cpp`、`ctp/src/QueryCadence.cpp`、`ctp/src/RuntimeConfig.cpp`、`ctp/src/SessionRecovery.cpp`、`ctp/src/Smoke*.cpp`、`ctp/src/TextEncoding.cpp`、`ctp/src/main.cpp`、`ctp/tests/`
- 保留：`ctp/include/ors/base/`、`ctp/src/base/`、`third_party/inih/`
- 测试：`ctp/tests/CoreLinkTest.cpp`

**接口：**
- `struct OrsConfig { std::string brokerId, investorId, password, authCode, appId, tradeFront, mdFront, flowDir, logPath, accountId, venueId, orsId; int requestStream, responseStream, accountStream, marketDataStream, sessionStream, controlStream; };`
- `OrsTypes.h` 定义 transport 使用的值：
  - `struct AccountQueryRequest { uint64_t requestId; std::string accountId; uint64_t timestamp; };`
  - `struct AccountSnapshot { uint64_t requestId; std::string accountId, tradingDay; double balance, available, margin, frozenMargin, commission, closeProfit, positionProfit, deposit, withdraw; uint32_t errorCode; std::string errorMsg; uint64_t timestamp; };`
  - `struct SessionEvent { std::string venueId, accountId, orsId, state, reason; uint64_t timestamp; };`
  - `struct ClientRegisterRequest { uint64_t requestId; std::string instanceId, accountId, environment; uint64_t timestamp; };`
  - `struct ClientRegisterResult { uint64_t requestId; uint32_t clientId, errorCode; std::string errorMsg; uint64_t timestamp; };`
- `class OrsTransport`：
  - `using RequestHandler = std::function<void(illuminati::infra::RequestMsg*)>;`
  - `using AccountQueryHandler = std::function<void(const AccountQueryRequest&)>;`
  - `using ClientRegisterHandler = std::function<void(const ClientRegisterRequest&)>;`
  - `virtual bool start(RequestHandler, AccountQueryHandler, ClientRegisterHandler) = 0;`
  - `virtual bool sendResponse(const illuminati::infra::ResponseMsg&) = 0;`
  - `virtual bool sendMarketData(const illuminati::md::MarketUpdateNew&) = 0;`
  - `virtual bool sendSession(const SessionEvent&) = 0;`
  - `virtual bool sendAccount(const AccountSnapshot&) = 0;`
  - `virtual bool sendClientRegisterResponse(const ClientRegisterResult&) = 0;`
  - `virtual void stop() = 0;`
- `class ORSServer`：
  - `ORSServer(OrsConfig, OrsTransport&);`
  - `void Start();`
  - `void Stop();`
  - `void ProcessRequest(illuminati::infra::RequestMsg*);`
  - `void PushUpdate(illuminati::infra::ResponseMsg*);`
  - `void QueryAccount(const AccountQueryRequest&);`
  - `void RegisterClient(const ClientRegisterRequest&);`
- `ORSServer` 构造函数不得创建 CTP API、读取 position/contract 文件或启动线程。CTP 创建和登录只在 `Start()` 中发生，测试才能在不连网的情况下构造核心。

- [ ] **步骤 1：先写失败的链接测试**

```cpp
// ctp/tests/CoreLinkTest.cpp
#include "core/ORSServer.h"
#include "transport/InMemoryOrsTransport.h"

int main() {
  static_assert(sizeof(ors::ORSServer) > 0);
  ors::InMemoryOrsTransport transport;
  return transport.responseCount() == 0 ? 0 : 1;
}
```

- [ ] **步骤 2：运行测试，确认失败**

运行：

```bash
cmake -S . -B build
cmake --build build -j4 --target ctp_core_link_test
```

预期：失败，因为 `ctp/core/ORSServer.h` 和 `ctp/transport/InMemoryOrsTransport.h` 不存在。

- [ ] **步骤 3：导入公司 CTP-only 文件**

从 `/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/ors/China` 复制：

```text
src/ORSServer.cpp
src/MdSpi.cpp
src/MDHandler.cpp
include/ORSServer.h
include/MdSpi.h
include/MDHandler.h
```

不要导入 `SgitFtdc*`、`TraderSpi.*`、`reuters*`、`dumprecorder.*`、`marketdatahandler.*`、`tradedatahandler.*`。

把每个 `#ifdef _USE_CTP_` 改为只保留 CTP 分支。从 `ORSServer.h/cpp` 和 `MdSpi.h/cpp` 删除 Sgit 重载和 Sgit 字段。在 `ctp/CMakeLists.txt` 定义 `_USE_CTP_`。

同一次任务中删除旧 active 实现，不保留并行目录：

```text
ctp/include/ors/ctp/
ctp/src/Aeron*.cpp
ctp/src/Contract*.cpp
ctp/src/Ctp*.cpp
ctp/src/InboundValidation.cpp
ctp/src/MarketDataFreshness.cpp
ctp/src/OfferRetry.cpp
ctp/src/QueryCadence.cpp
ctp/src/RuntimeConfig.cpp
ctp/src/SessionRecovery.cpp
ctp/src/Smoke*.cpp
ctp/src/TextEncoding.cpp
ctp/src/main.cpp
ctp/tests/
```

保留 `ctp/include/ors/base/`、`ctp/src/base/`、`third_party/inih/`，新核心继续使用。

- [ ] **步骤 4：增加 OrsConfig 和 transport seam**

`OrsConfig::load(path)` 只读配置：

```text
BROKER_ID, INVESTOR_ID, PASSWORD, AUTH_CODE, APP_ID
TRADE_FRONT, MD_FRONT, FLOW_DIR, LOG_FILE
ACCOUNT_ID, VENUE_ID, ORS_ID
AERON_DIR, AERON_CHANNEL
REQUEST_STREAM, RESPONSE_STREAM, ACCOUNT_STREAM
MARKET_DATA_STREAM, SESSION_STREAM, CONTROL_STREAM
RMS_CONFIG_FILE, RMS_FIRMWIDE_CONFIG_FILE
```

使用 `ors::base::ConfigFile`。不要新增 `POSITION_FILE`、`CONTRACT_FILE`、`REQUEST_SHMKEY`、`RESPONSE_SHMKEY`、`CLIENT_STORE_KEY`、`MAX_CLIENTS`。

`InMemoryOrsTransport` 保存发送的 `ResponseMsg`、`MarketUpdateNew`、`SessionEvent`、`AccountSnapshot`、`ClientRegisterResult`；`start()` 保存回调并返回 true。它是测试替身，也是初始占位实现。

- [ ] **步骤 5：把 CTP 启动移出构造函数**

`ORSServer::ORSServer` 只初始化配置、map、锁、RMS 和 transport 引用。

`ORSServer::Start` 执行：

```text
创建 TraderApi/MdApi
注册 front
Init/Join
```

不调用 `createClientStore`、`createRequestClients`、`createResponseClient`、`startMonitorAsyncORSRequest`、`updatePositionFromFile`、`writePositionToFile`。

从 `ORSServer` 删除：

```text
ShmMgr m_shmmanager;
ShmMgr::RespShmQ* m_responseInterface;
m_requestShmKey/m_responseShmKey/m_requestShmSize/m_responseShmSize
m_clientStoreKey/m_maxClients
startReqRespLogger()
```

`PushUpdate`、`RmsError`、`RmsWarning` 调用 `transport_.sendResponse(...)`；之后保留原有 RMS/持仓更新。`Start()` 不调用 `startMonitorAsyncORSRequest()`。

此时 `MDHandler` 仍引用 `mdshmwriter.h`。在 `ctp/vendor/hftbase/mdshmwriter.h` 放一个临时 no-op writer，丢弃写入、不创建 SHM。任务 9 删除它。

`ORSServer::Stop` 不写持仓文件，不关闭 SHM。

- [ ] **步骤 6：构建并运行链接测试**

```bash
cmake -S . -B build
cmake --build build -j4 --target ctp_core_link_test
ctest --test-dir build -R ctp_core_link --output-on-failure
```

预期：通过。旧 active 源码在本任务中删除，git 历史是唯一副本。

- [ ] **步骤 7：提交**

```bash
git add ctp
git commit -m "feat(ors): import ctp-only company core with transport seam"
```

---

### 任务 2：删除状态文件，改为 CTP 查询初始化

**文件：**
- 新建：`ctp/core/PositionTable.h`
- 新建：`ctp/core/PositionTable.cpp`
- 修改：`ctp/core/ORSServer.cpp`
- 修改：`ctp/core/ORSServer.h`
- 测试：`ctp/tests/PositionTableTest.cpp`

**接口：**
- `struct ContractPosition { int onLongPos; int todayLongPos; int onShortPos; int todayShortPos; };`
- `struct PositionRow { std::string instrumentId; char direction; int position; int todayPosition; };`
- `struct OffsetReservation { char offsetFlag; int qtyType; };`
- `class PositionTable`：
  - `void replaceFromQuery(std::vector<PositionRow> rows);`
  - `ContractPosition get(std::string_view symbol) const;`
  - `OffsetReservation reserveForOrder(std::string_view symbol, char side, int qty, char exchange);`
  - `void restoreOnFailure(const OrderInfo&, const ResponseMsg&);`
  - `void applyTrade(const OrderInfo&, const ResponseMsg&);`
  - `bool empty() const;`
- `void ORSServer::onInstrumentQueryComplete();`
- `void ORSServer::onPositionQueryComplete();`

- [ ] **步骤 1：先写失败的持仓表测试**

```cpp
void replaceMergesLongAndShort();
void emptyQueryClearsPreviousPositions();
void queryFailureLeavesTableEmpty();
void missingInstrumentReturnsZeroPosition();
void reserveCloseTodayDeductsTodayQuantity();
void reserveCloseYesterdayDeductsYesterdayQuantity();
void reserveOpenLeavesPositionUnchanged();
void orderErrorRestoresReservedQuantity();
void cancelConfirmRestoresReservedQuantity();
void openTradeAddsTodayQuantity();
void closeTradeDoesNotDoubleCount();
```

测试直接构造持仓行和公司形状的 `OrderInfo`/`ResponseMsg`，不打开 `position.csv` 或 `contract_*.csv`。

- [ ] **步骤 2：运行测试，确认失败**

```bash
cmake --build build -j4 --target ctp_position_table_test
ctest --test-dir build -R ctp_position_table --output-on-failure
```

预期：失败，因为 `PositionTable` 不存在。

- [ ] **步骤 3：实现 PositionTable**

`replaceFromQuery()` 在锁外构造新的 `std::map<std::string, ContractPosition>`，再在 `std::mutex` 内交换。处理 CTP 多空行：

```text
Direction == THOST_FTDC_PD_Long:
  todayLongPos = TodayPosition
  onLongPos = Position - TodayPosition
  onShortPos = 0
  todayShortPos = 0
Direction == THOST_FTDC_PD_Short:
  todayShortPos = TodayPosition
  onShortPos = Position - TodayPosition
  onLongPos = 0
  todayLongPos = 0
```

`Position == 0` 的行忽略。空查询结果必须清空整张表。

`reserveForOrder()` 必须完全复刻公司 `SetCombOffsetFlag`：

```text
BUY  且 qty <= todayShort -> CloseToday（SHFE）或 Close（其他）；todayShort -= qty
BUY  且 qty <= onShort    -> Close；onShort -= qty
SELL 且 qty <= todayLong  -> CloseToday（SHFE）或 Close（其他）；todayLong -= qty
SELL 且 qty <= onLong     -> Close；onLong -= qty
否则                       -> Open，不扣减
```

`restoreOnFailure()` 对 `ORDER_ERROR` / `CANCEL_ORDER_CONFIRM` 的平仓预扣做反向加法；`OPEN` 不处理。

`applyTrade()` 对 `OPEN` 增加 today 持仓；`CLOSE_TODAY` / `CLOSE_YESTERDAY` 不重复加，因为下单前已扣。

- [ ] **步骤 4：接入 CTP 查询初始化**

登录完成后：

```text
发布 CONNECTING/AUTHENTICATING/LOGGING_IN/SETTLEMENT_CONFIRMING
ReqQryInstrument
  -> OnRspQryInstrument 收集 MasterData
  -> bIsLast：m_symbolMap = collected；发布 QUERYING_INSTRUMENTS
  -> ReqQryInvestorPosition
  -> OnRspQryInvestorPosition 收集 PositionRow
  -> bIsLast：positionTable.replace(rows)；onPositionQueryComplete()
  -> 发布 READY
```

任何查询错误或超时，发布 `SessionEvent.state = FAILED`，带 CTP 错误/reason；不得进入 READY，不得回退到旧文件或旧内存持仓。

Trader/MD 使用 `OrsConfig` 中分开的 flow 目录。这里纳入 `quantlink-trading` 的生产修复：

```text
登录重试 + 退避；开盘前检查，重试由定时器/主循环调度，不在 CTP 回调 usleep
instrument query 限流，不允许背靠背查询
position query 整表替换；空结果清空
4040 生产/评测模式由配置驱动
CTP 6.7.11 登录签名/构建兼容
```

`SetCombOffsetFlag` 通过 `PositionTable::reserveForOrder` 读取并预扣；`PushUpdate` 通过 `restoreOnFailure` / `applyTrade` 更新。删除：

```text
m_positionFile
m_contractFile
fpContractFile
updatePositionFromFile()
writePositionToFile()
OnRtnInstrumentStatus 中的 CONTRACT_FILE 写入
OnRspQryInvestorPositionDetail 的文件比对分支
```

- [ ] **步骤 5：确认没有文件状态**

```bash
rg 'POSITION_FILE|CONTRACT_FILE|position\.csv|contract_' ctp
```

预期：生产代码无匹配；只剩测试名或本文档中的说明。

- [ ] **步骤 6：运行测试**

```bash
cmake --build build -j4
ctest --test-dir build -R 'ctp_position_table|ctp_core_link' --output-on-failure
```

预期：通过。

- [ ] **步骤 7：提交**

```bash
git add ctp
git commit -m "feat(ors): replace position and contract files with ctp queries"
```

---

### 任务 3：替换基础库并统一日志

**文件：**
- 新建：`ctp/log/Log.h`
- 新建：`ctp/log/Log.cpp`
- 新建：`ctp/tests/LogFacadeTest.cpp`
- 修改：`ctp/core/ORSServer.cpp`
- 修改：`ctp/core/MdSpi.cpp`
- 修改：`ctp/core/MDHandler.cpp`
- 修改：`ctp/vendor/hftbase/`
- 修改：`ctp/CMakeLists.txt`

**接口：**
- `void ors::log::info(std::string_view event, std::initializer_list<LogField> fields);`
- `void ors::log::warn(...)`、`error(...)`、`metrics(const Metrics&)`。
- 内部可以使用 `ors_base::logEvent` / spdlog；业务代码不得直接调用 spdlog、`ILOG`、`std::cerr`、`StatsCollector`。

- [ ] **步骤 1：先写失败的日志测试**

```cpp
void eventIsOneJsonLine();
void requiredFieldsArePresent();
void credentialsAreRedacted();
void metricsAreAggregatedNotPerTick();
```

- [ ] **步骤 2：运行测试，确认失败**

```bash
cmake --build build -j4 --target ctp_log_facade_test
ctest --test-dir build -R ctp_log_facade --output-on-failure
```

预期：失败，因为日志 facade 不存在。

- [ ] **步骤 3：替换基础设施**

用 std/`ors_base` 替换：

```text
Configfile          -> ors::base::ConfigFile
CasLock             -> std::mutex / std::atomic
ITime_ClockRT       -> std::chrono
StatsCollector      -> 计数 + 60 秒 metrics 事件
ILOG                -> ors::log facade
ProcessSettings     -> std::filesystem / config
```

保留 `orderresponse.h`、`marketupdateNew.h`、`rmsimpl.hpp` 的检查逻辑和必需时的 tinyxml2。不要重写 RMS 规则。

删除生产代码中的 `std::cerr`/`std::cout`；只允许 `--help`、`--version`、配置摘要、smoke 工具保留。删除 `[ctp]` 文本日志。

- [ ] **步骤 4：验证**

```bash
cmake --build build -j4
ctest --test-dir build -R ctp_log_facade --output-on-failure
rg 'ILOG|StatsCollector|std::cerr' ctp/core ctp/transport ctp/query
```

预期：通过；生产代码无禁用 logger。

- [ ] **步骤 5：提交**

```bash
git add ctp
git commit -m "refactor(ors): replace illuminati infrastructure and unify logs"
```

---

### 任务 4：增加 contract 1.0.0 编解码映射

**文件：**
- 新建：`ctp/contract/OrsCodec.h`
- 新建：`ctp/contract/OrsCodec.cpp`
- 新建：`ctp/contract/OrsCodecTest.cpp`
- 修改：`ctp/CMakeLists.txt`

**接口：**
- `illuminati::infra::RequestMsg decodeRequest(const com::quantlink::contract::sbe::OrsRequestDecoder&);`
- `std::size_t encodeResponse(const illuminati::infra::ResponseMsg&, char* dst, std::size_t capacity);`
- `std::size_t encodeMarketUpdate(const illuminati::md::MarketUpdateNew&, char* dst, std::size_t capacity);`
- `AccountQueryRequest decodeAccountQuery(const com::quantlink::contract::sbe::AccountQueryDecoder&);`
- `std::size_t encodeAccountSnapshot(const AccountSnapshot&, char* dst, std::size_t capacity);`
- `ClientRegisterRequest decodeClientRegister(const com::quantlink::contract::sbe::ClientRegisterDecoder&);`
- `std::size_t encodeClientRegisterResponse(const ClientRegisterResult&, char* dst, std::size_t capacity);`

所有编码器包装调用方提供的目标缓冲区，返回包含 SBE header 的编码长度。解码器接收已包装的 decoder；帧校验由 transport 负责。

- [ ] **步骤 1：先写失败的编解码测试**

```cpp
void requestMatchesCompanyRequestMsg();
void responseKeepsCancelRejectAndDoubleExchangeOrderId();
void marketUpdateKeepsTwentyLevelsAndSequence();
void accountSnapshotKeepsRequestIdAndFields();
void clientRegisterResponseKeepsClientIdAndError();
```

使用一份真实公司 `RequestMsg` 样例和一份 `ResponseMsg` 样例。断言字节字段、定宽字符串、`double ExchangeOrderId` 和 20 档买卖盘。

- [ ] **步骤 2：运行测试，确认失败**

```bash
cmake --build build -j4 --target ctp_ors_codec_test
ctest --test-dir build -R ctp_ors_codec --output-on-failure
```

预期：失败，因为 `OrsCodec` 和生成头文件不可用。

- [ ] **步骤 3：逐字段实现映射**

不要在 codec 中定义 ORS 订单状态。映射规则：

```text
OrsRequest.orderId          -> RequestMsg.OrderID
OrsRequest.requestType     -> RequestMsg.Request_Type
OrsRequest.transactionType -> RequestMsg.Transaction_Type
OrsRequest.exchangeType    -> RequestMsg.Exchange_Type
OrsRequest.contractDescription -> RequestMsg.Contract_Description
ResponseMsg.ExchangeOrderId -> OrsResponse.exchangeOrderId（double，不转类型）
```

定宽字符串使用现有 `ors::base::fitContractField` 或显式复制并截断，不能依赖 `strcpy`。

- [ ] **步骤 4：运行测试**

```bash
cmake --build build -j4
ctest --test-dir build -R ctp_ors_codec --output-on-failure
```

预期：通过。修改字段宽度前先跑 contract 仓库的 Java round-trip 测试。

- [ ] **步骤 5：提交**

```bash
git add ctp/contract ctp/CMakeLists.txt
git commit -m "feat(ors): map contract 1.0.0 frames to company messages"
```

---

### 任务 5：实现 Aeron transport

**文件：**
- 新建：`ctp/transport/AeronOrsTransport.h`
- 新建：`ctp/transport/AeronOrsTransport.cpp`
- 新建：`ctp/transport/FakeFramePublisher.h`
- 测试：`ctp/tests/AeronOrsTransportTest.cpp`
- 修改：`ctp/CMakeLists.txt`

**接口：**
- `AeronOrsTransport(OrsConfig, FramePublisher&, FrameSubscriber&);`
- `bool sendResponse(const ResponseMsg&) override;`
- `bool sendMarketData(const MarketUpdateNew&) override;`
- `bool sendSession(const SessionEvent&) override;`
- `bool sendAccount(const AccountSnapshot&) override;`
- `bool sendClientRegisterResponse(const ClientRegisterResult&) override;`
- `void poll(int fragmentLimit);`

`FramePublisher`/`FrameSubscriber` 是现有 `AeronPublisher` 和 Aeron subscription 的薄包装。不要复制 offer-retry 逻辑。

- [ ] **步骤 1：先写失败的 transport 测试**

```cpp
void responseUsesResponseStream();
void marketDataUsesMarketDataStream();
void accountUsesAccountStream();
void sessionUsesSessionStream();
void backPressureIsReportedAndRetried();
void controlFrameRoutesToClientRegisterHandler();
void requestFrameRoutesToProcessRequest();
void accountQueryOnRequestStreamRoutesToQueryAccount();
```

- [ ] **步骤 2：运行测试，确认失败**

```bash
cmake --build build -j4 --target ctp_aeron_transport_test
ctest --test-dir build -R ctp_aeron_transport --output-on-failure
```

预期：失败，因为 `AeronOrsTransport` 不存在。

- [ ] **步骤 3：实现发送路径**

一个 Aeron frame 只放一个 SBE message。使用 contract stream：

```text
REQUEST=1, RESPONSE=2, ACCOUNT=3, MARKET_DATA=4, SESSION=5, CONTROL=6
```

`sendResponse` 编码 `OrsResponse`；`sendMarketData` 编码 `MarketUpdate`；`sendSession` 编码 `SessionEvent`；`sendAccount` 编码 `AccountSnapshot`；`sendClientRegisterResponse` 编码 `ClientRegisterResponse`。

使用 `ors/ctp/OfferRetry.h` 的 `offerWithRetry`。`Published` 返回 true；back-pressure/not-connected/closed 返回 false 并发布 `publish.fail` 事件；不能静默丢弃。

- [ ] **步骤 4：实现接收路径**

`poll()` 每次解码一个 frame：

```text
REQUEST -> 按 templateId 分流：
  OrsRequest      -> decodeRequest -> RequestHandler
  AccountQuery    -> decodeAccountQuery -> AccountQueryHandler
CONTROL -> decodeClientRegister -> ClientRegisterHandler
```

未知 template ID 记录日志并拒绝，不修改 ORS 状态。

- [ ] **步骤 5：运行测试**

```bash
cmake --build build -j4
ctest --test-dir build -R ctp_aeron_transport --output-on-failure
```

预期：使用 fake publisher 通过，不需要 Aeron 网络。

- [ ] **步骤 6：提交**

```bash
git add ctp/transport ctp/tests ctp/CMakeLists.txt
git commit -m "feat(ors): add aeron transport for contract 1.0.0"
```

---

### 任务 6：增加 ClientRegister 和重启安全的 clientId

**文件：**
- 新建：`ctp/control/ClientRegistry.h`
- 新建：`ctp/control/ClientRegistry.cpp`
- 新建：`ctp/control/OpenOrderGuard.h`
- 新建：`ctp/control/OpenOrderGuard.cpp`
- 测试：`ctp/tests/ClientRegistryTest.cpp`
- 测试：`ctp/tests/OpenOrderGuardTest.cpp`
- 修改：`ctp/core/ORSServer.h`
- 修改：`ctp/core/ORSServer.cpp`

**接口：**
- `ClientRegisterResult ClientRegistry::registerClient(std::string_view instanceId);`
- `void ClientRegistry::releaseIfFlat(uint32_t clientId, const OrderAccountMap& orders);`
- `uint32_t clientIdFromOrderId(uint32_t orderId);`
- `uint32_t makeOrderId(uint32_t clientId, uint32_t orderCount);`
- `bool OpenOrderGuard::hasLiveOrders(const std::vector<CThostFtdcOrderField>& rows);`

- [ ] **步骤 1：先写失败的注册表测试**

```cpp
void allocatesSequentialClientIds();
void neverReusesClientIdWhileOrdersLive();
void releasesClientIdOnlyWhenNoLiveOrder();
void rejectsWhenClientIdRangeExhausted();
void orderIdUsesCompanyFormula();
void clientIdExtractionRejectsOutOfRange();
```

`clientId` 范围是 `1..4294`；`OrderID` 是 `uint32`，`ORDERID_RANGE` 是 `1_000_000`。

- [ ] **步骤 2：先写失败的重启保护测试**

```cpp
void allTradedAndCanceledRowsAreTerminal();
void anyOpenOrderBlocksReady();
void guardFailurePublishesSessionFailed();
```

保护查询是登录后的 `ReqQryOrder`，在允许 `ClientRegister` 之前执行。任何非终态订单意味着：

```text
SessionEvent.state = FAILED
reason = "open orders present; reconcile before client registration"
```

不分配 `clientId`，不接受订单请求。

- [ ] **步骤 3：运行测试，确认失败**

```bash
cmake --build build -j4 --target 'ctp_client_registry_test|ctp_open_order_guard_test'
ctest --test-dir build -R 'ctp_client_registry|ctp_open_order_guard' --output-on-failure
```

预期：失败，因为两个类不存在。

- [ ] **步骤 4：实现 ClientRegistry**

从 1 开始单调分配。不要从 `instanceId` 派生 `clientId`；`instanceId` 只用于诊断。重连分配新的 `clientId`；旧 `clientId` 一直保留，直到 `releaseIfFlat` 看到没有该高位段订单。

`releaseIfFlat` 扫描 `OrderAccountMap`；只要还有 `orderId / 1_000_000 == clientId` 的订单，就不能释放。

- [ ] **步骤 5：实现 OpenOrderGuard**

`hasLiveOrders` 读取 CTP `OrderStatus`，除以下状态外都算未终态：

```text
THOST_FTDC_OST_AllTraded
THOST_FTDC_OST_Canceled
```

查询失败也阻止 READY。不要用 `position.csv`、`contract_*` 或 SHM 推断未完成订单。

- [ ] **步骤 6：接入 ClientRegister 和订单门禁**

`ORSServer::RegisterClient` 调用 `ClientRegistry::registerClient`，并通过 `transport_.sendClientRegisterResponse` 发送 `ClientRegisterResult`。

注册成功前，`ProcessRequest` 对 `NEWORDER`、`MODIFYORDER`、`CANCELORDER` 返回明确错误，不能进入 CTP。测试：

```cpp
void orderBeforeClientRegisterIsRejected();
```

- [ ] **步骤 7：验证**

```bash
cmake --build build -j4
ctest --test-dir build -R 'ctp_client_registry|ctp_open_order_guard' --output-on-failure
```

预期：通过。

- [ ] **步骤 8：提交**

```bash
git add ctp/control ctp/tests ctp/core ctp/CMakeLists.txt
git commit -m "feat(ors): allocate client ids with restart safety"
```

---

### 任务 7：增加 account query 和查询节流

**文件：**
- 新建：`ctp/query/QueryMapping.h`
- 新建：`ctp/query/QueryMapping.cpp`
- 新建：`ctp/query/AccountQueryState.h`
- 测试：`ctp/tests/AccountQueryTest.cpp`
- 测试：`ctp/tests/AccountQueryStateTest.cpp`
- 修改：`ctp/core/ORSServer.cpp`

**接口：**
- `AccountSnapshot mapAccountSnapshot(const CThostFtdcTradingAccountField&, uint64_t requestId, const OrsConfig&);`
- `PositionRow mapPositionRow(const CThostFtdcInvestorPositionField&);`
- `std::vector<PositionRow> mergePositionRows(std::vector<PositionRow> rows);`
- `bool ORSServer::QueryAccount(const AccountQueryRequest&);`
- `bool ORSServer::acceptAccountResponse(int ctpRequestId, const CThostFtdcTradingAccountField* row, const CThostFtdcRspInfoField* error);`
- `class AccountQueryState { bool tryBegin(uint64_t requestId, std::chrono::steady_clock::time_point now); void bindCtpRequest(int ctpRequestId); std::optional<uint64_t> requestIdFor(int ctpRequestId) const; void finish(); };`

**查询代码来源：**
- `AccountQuery` / `AccountSnapshot` 字段：contract 1.0.0，不使用旧 contract。
- CTP 行到 snapshot 的字段映射：从当前 v3 的 `ctp/src/CtpQueryService.cpp` 提取 `mapAccountSnapshot`、`mapPositionRow`、`mergePositionRows` 的映射逻辑；只取映射，不保留 `CtpQueryService` 的 service、阻塞查询和 session 状态机。任务 1 已删除该文件时，用 `git show b017507:ctp/src/CtpQueryService.cpp` 作为代码参考。
- 查询触发、回调顺序、限流、重试：参考 `quantlink-trading/ors/China/src/ORSServer.cpp` 的 `ReqQryInstrument`、`ReqQryInvestorPosition`、`ReqQryTradingAccount` 和对应 `OnRsp...`；只取查询逻辑，不复制 `writePositionToFile` / `updatePositionFromFile`。
- 公司 ORS `fromCompany/.../China` 的 `ReqQryPosition()` / `ReqQryAccount()` 是禁用或直接 `return`，持仓来自 `position.csv`，不能作为查询代码来源。
- `ORSServer::QueryAccount`、`acceptAccountResponse`、`AccountQueryState`、requestId 关联是 v4 新增接线代码，不是从公司 ORS 原样复制。
- 查询采用生产 ORS 内联模式：`ReqQry...` / `OnRspQry...` 都在 `ORSServer`，不引入 `QueryService` / `QueryCoordinator`。
- 生产 ORS 的 `usleep` 重试和查询失败降级 READY 不进入 v4；重试由定时器/主循环调度，失败保持 FAILED。

- [ ] **步骤 1：先写失败的 account 测试**

```cpp
void successEmitsSnapshotWithRequestId();
void ctpErrorEmitsErrorSnapshotAndKeepsSessionState();
void secondQueryInsideIntervalIsRejected();
void successDoesNotChangeReadyStateOrOrderMap();
void nanAndDblMaxAreSanitized();

// AccountQueryStateTest.cpp
void stateRejectsSecondQueryInsideInterval();
void stateMapsCtpRequestIdBackToSdkRequestId();
void finishAllowsNextQuery();
```

- [ ] **步骤 2：运行测试，确认失败**

```bash
cmake --build build -j4 --target 'ctp_account_query_test|ctp_account_state_test'
ctest --test-dir build -R 'ctp_account_query|ctp_account_state' --output-on-failure
```

预期：失败，因为 account query 路径不存在。

- [ ] **步骤 3：实现映射、节流和 ORSServer 查询路径**

把 `git show b017507:ctp/src/CtpQueryService.cpp` 中的 `mapAccountSnapshot`、`mapPositionRow`、`mergePositionRows` 字段映射复制到 `ctp/query/QueryMapping.cpp`；不要复制旧 `CtpQueryService` 的 service 或 session 状态机。

不要把 account query 做成独立 `AccountQueryService`。查询入口和响应回调放在 `ORSServer`，requestId 关联和节流放在 `AccountQueryState`，与公司 ORS 的 `ReqQry...`/`OnRspQry...` 结构一致。

账户字段：

```text
Balance, Available, CurrMargin, FrozenMargin, Commission,
CloseProfit, PositionProfit, Deposit, Withdraw
```

`requestId` 是 SDK 查询关联键；`tradingDay` 来自 CTP 行。`DBL_MAX` 和 NaN 映射为 `0.0`。

`AccountQueryState::tryBegin` 负责 account query 的 pending 和 1000 ms 节流；间隔内第二次查询返回拒绝结果，不能静默丢弃。它只保存 requestId 关联，不发送请求、不处理超时/重试/回调顺序。position/instrument 启动查询使用启动屏障和退避重试，不使用这个状态。

- [ ] **步骤 4：接入 CTP 回调**

`ORSServer::QueryAccount(AccountQueryRequest)` 先调用 `AccountQueryState::tryBegin`，成功且 READY 时调用 `ReqQryTradingAccount`，再 `bindCtpRequest`。`AccountQueryState` 是 `ORSServer` 成员。

`OnRspQryTradingAccount` 调用 `acceptAccountResponse`，先用 `requestIdFor(nRequestID)` 找到 SDK requestId，再映射为 `AccountSnapshot` 并调用 `transport.sendAccount`；错误或空结果发布错误 snapshot，最后 `finish()`。它不得调用 `PushUpdate`、修改 `m_ordLocalMap` 或改变 READY。

- [ ] **步骤 5：运行测试**

```bash
cmake --build build -j4
ctest --test-dir build -R 'ctp_account_query|ctp_account_state' --output-on-failure
```

预期：通过。

- [ ] **步骤 6：提交**

```bash
git add ctp/query ctp/tests ctp/core ctp/CMakeLists.txt
git commit -m "feat(ors): add throttled account query"
```

---

### 任务 8：增加订单/RMS 一致性测试

**文件：**
- 新建：`ctp/core/OrderMapper.h`
- 新建：`ctp/core/OrderMapper.cpp`
- 新建：`ctp/tests/OrderParityTest.cpp`
- 测试样例：`ctp/tests/CompanyFixtures.h`
- 修改：`ctp/core/ORSServer.cpp`

**接口：**
- `CThostFtdcInputOrderField mapNewOrder(const RequestMsg&, const OrderInfo&, const ContractPosition&);`
- `CThostFtdcInputOrderActionField mapCancel(const RequestMsg&, const OrderInfo&);`
- `void ORSServer::seedOrderForTest(const OrderInfo&);`，只在 `ORS_TESTING` 下编译。

- [ ] **步骤 1：先写失败的一致性测试**

```cpp
void unknownCancelReturnsCancelOrderReject();
void eraseThenCancelReturnsCancelOrderReject();
void cancelRejectLeavesOriginalOrderInMap();
void tradeBeforeTerminalDoesNotEraseOrder();
void terminalOrderIsErasedOnlyAfterAllTradedOrCanceled();
void staleFrontSessionResponseIsIgnored();
void rmsRejectDoesNotCallCtpAndKeepsOrderAbsent();
void newOrderMapsSideOffsetAndPrice();
```

测试用 `InMemoryOrsTransport` 构造 `ORSServer`，不调用 `Start()`，所以不会连接 CTP。撤单拒绝和成交回调直接用公司形状的行调用。

- [ ] **步骤 2：运行测试，确认失败**

```bash
cmake --build build -j4 --target ctp_order_parity_test
ctest --test-dir build -R ctp_order_parity --output-on-failure
```

预期：失败，因为测试钩子、mapper 或行为缺失。

- [ ] **步骤 3：抽取纯映射辅助函数**

只从 `SendNewOrder`/`SendCancelOrder` 抽取字段构造：

```text
RequestMsg + OrderInfo + ContractPosition -> CThostFtdcInputOrderField
RequestMsg + OrderInfo                  -> CThostFtdcInputOrderActionField
```

不要移动 map 修改、RMS 检查、`PushUpdate` 或 CTP 回调。

保持公司行为：

```text
BUY  平今空头 -> SHFE CloseToday，其他市场 Close
BUY  平昨空头 -> Close
SELL 平今多头 -> SHFE CloseToday，其他市场 Close
SELL 平昨多头 -> Close
其余          -> Open
```

- [ ] **步骤 4：只修复测试暴露的行为**

未知撤单必须调用 `RejectOrder`，返回 `CANCEL_ORDER_REJECT` 和原 `OrderID`；不得向 `m_ordLocalMap` 插入新订单。

撤单拒绝必须推送 `CANCEL_ORDER_REJECT`，不删除已有订单。

成交回调不得删除订单；只有公司终态路径才能移除。

旧 `FrontID/SessionID`/`OrderRef` 的回报在修改 map 前丢弃。

- [ ] **步骤 5：运行测试**

```bash
cmake --build build -j4
ctest --test-dir build -R ctp_order_parity --output-on-failure
```

预期：通过。

- [ ] **步骤 6：提交**

```bash
git add ctp/core ctp/tests ctp/CMakeLists.txt
git commit -m "test(ors): pin company order and rms parity"
```

---

### 任务 9：把 MDHandler 的 SHM 改为 transport sink

**文件：**
- 修改：`ctp/core/MDHandler.h`
- 修改：`ctp/core/MDHandler.cpp`
- 新建：`ctp/md/MarketDataSink.h`
- 测试：`ctp/tests/MDHandlerTest.cpp`
- 修改：`ctp/core/MdSpi.cpp`

**接口：**
- `class MarketDataSink { virtual bool send(const illuminati::md::MarketUpdateNew&) = 0; };`
- `MDHandler(MarketDataSink&);`
- `void MDHandler::ProcessMDUpdate(char*);`

- [ ] **步骤 1：先写失败的 MD 测试**

```cpp
void preservesTwentyBidAndAskLevels();
void incrementsSequenceAndSetsTimestamp();
void callsSinkExactlyOncePerTick();
void sinkFailureIsReportedNotIgnored();
void reconnectResubscribesAllSymbols();
void firstTickAfterReconnectDoesNotReuseOldLevels();
```

- [ ] **步骤 2：运行测试，确认失败**

```bash
cmake --build build -j4 --target ctp_md_handler_test
ctest --test-dir build -R ctp_md_handler --output-on-failure
```

预期：失败，因为 `MDHandler` 仍依赖 SHM 且没有 sink。

- [ ] **步骤 3：替换 SHM writer**

删除 `mdshmwriter.h`、`MD_SHMKEY`、`MD_SHMSIZE`、`MarketDataShmWriter`。

`ProcessMDUpdate` 执行：

```text
update->m_timestamp = nowNanos()
update->m_seqnum = ++m_seqNum
sink.send(*update)
```

`MdSpi` 传入 transport 支持的 sink。不要改变 20 档 `MarketUpdateNew` 布局。

MD 重连时：

```text
重新订阅 m_symbolMap 中的所有 symbol
重连后第一个 tick 前清空买卖档
不发布上一会话的旧 tick
```

- [ ] **步骤 4：运行测试**

```bash
cmake --build build -j4
ctest --test-dir build -R ctp_md_handler --output-on-failure
```

预期：通过。

- [ ] **步骤 5：提交**

```bash
git add ctp/core ctp/md ctp/tests ctp/CMakeLists.txt
git commit -m "feat(ors): publish market data through transport sink"
```

---

### 任务 10：全量验证和 live gate

**文件：**
- 修改：`docs/live-gate-YYYYMMDD.md`
- 修改：`ctp/configs/`，如果测试配置变化

- [ ] **步骤 1：全量构建和测试**

```bash
cmake -S . -B build
cmake --build build -j4
ctest --test-dir build --output-on-failure
```

预期：全部通过。旧 active 源码已在任务 1 删除，不存在并行目录。

- [ ] **步骤 2：运行 SimNow live 生命周期测试**

只在交易时段，使用有效 SimNow 账户：

```text
login -> instrument query -> position query -> READY
new order -> NEW_ORDER_CONFIRM
cancel unknown -> CANCEL_ORDER_REJECT
cancel live -> CANCEL_ORDER_CONFIRM
partial/full fill -> TRADE_CONFIRM
terminal -> order removed
account query -> AccountSnapshot
MD -> MarketUpdate
```

非交易时段不得运行真实下单测试。把配置和结果记录到 `docs/live-gate-YYYYMMDD.md`。

- [ ] **步骤 3：提交**

```bash
git add docs ctp
git commit -m "test(ors): record live gate"
```

---

## 计划决定

- **ClientId 重启安全：** 登录后执行 `ReqQryOrder`；只要存在非 `AllTraded`/`Canceled` 订单，就不进入 READY、不分配 clientId。代价是多一次启动查询，但能防止 CTP 仍有存活订单时复用 OrderID 段。
- **不做 SHM 兼容层：** `OrsTransport` 是新 seam；不要把 `ShmMgr` 藏在适配器后面。
- **不做文件回退：** 持仓/合约状态只来自 CTP 查询；查询失败就是启动失败，不能读旧 CSV。
- **Contract 代码生成在外部：** ORS 只使用 contract 仓库生成的头文件，不复制或重写 SBE schema。
- **不引入独立 query service：** `ReqQry...` / `OnRspQry...` 都放在 `ORSServer`，与 `quantlink-trading` 生产 ORS 一致；只抽 `QueryMapping`（纯字段映射）和 `AccountQueryState`（account query pending/requestId/节流）。
- **只新增 account query：** position/instrument 查询是初始化语义，不是新订单状态机。
- **原地重写：** 所有新代码直接进入 `ctp/`，不建 `ctp/v4`，不保留 v3/v4 双轨。

## 验证矩阵

| 行为 | 测试 |
|---|---|
| 未知/已删除订单撤单 | `ctp_order_parity` |
| 撤单拒绝保留订单 | `ctp_order_parity` |
| 成交先于终态 | `ctp_order_parity` |
| 旧 front/session 回报 | `ctp_order_parity` |
| RMS 拒绝不调用 CTP | `ctp_order_parity` |
| 空持仓查询清空表 | `ctp_position_table` |
| 平仓预扣/失败回滚/成交更新 | `ctp_position_table` |
| 查询失败阻止 READY | `ctp_position_table`、`ctp_open_order_guard` |
| account query 错误不改变 READY | `ctp_account_query` |
| Aeron back-pressure 上报 | `ctp_aeron_transport` |
| clientId 存活期间不复用 | `ctp_client_registry` |
| MD 20 档和 sequence | `ctp_md_handler` |
| JSONL 字段和脱敏 | `ctp_log_facade` |

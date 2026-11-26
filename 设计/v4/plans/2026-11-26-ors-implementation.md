# ORS v4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用公司 ORS 的 CTP 订单/RMS 行为重写 ORS：一个账户一个进程，删除 SHM 和状态文件，改为 Aeron transport，并只在 account/position/instrument 查询接入方式上做新增。

**Architecture:** 以 `/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/ors/China` 的 CTP 分支为业务主干，保留 `ORSServer`、`OrderInfo`、`m_ordLocalMap`、`m_ordExchMap`、RMS 和 CTP 回调；把 SHM 输入/输出和状态文件替换为 `OrsTransport` 与 CTP 查询。Aeron 只承载 contract 1.0.0 消息，不把 v3 `OrderStatus/CancelState` 状态机带进核心。

**Tech Stack:** C++20, CMake, CTP TraderApi/MdApi, Aeron C++ client, contract 1.0.0 SBE, Rocky Linux 190.

**Spec:** `quantlink-docs/设计/v4/003-ors-v4.md`

**Contract:** `quantlink-venue-contract/abi/sbe/quantlink-fin-sbe.xml`

## Prerequisite

C++ contract headers are produced by the contract repository, not by this ORS plan. Before Task 4, the generated headers for `OrsRequest`, `OrsResponse`, `AccountQuery`, `AccountSnapshot`, `MarketUpdate`, `SessionEvent`, `ClientRegister`, and `ClientRegisterResponse` must exist under the ORS build's `CONTRACT_GENERATED_DIR`. Do not duplicate or hand-write SBE codecs in ORS.

## Global Constraints

```text
公司 ORS 是订单/RMS/账户/持仓业务基线
CTP only: 编译时固定 _USE_CTP_，不导入 Sgit 分支、Sgit 头文件或 Sgit 回调
一个 ORS 进程 = 一个 CTP 账户 = 一个 TraderApi = 一个 MdApi
不保留 SHM request/response/client-store
不保留 position.csv / contract 状态文件；配置文件和凭据文件仍可读
不沿用 v3 CtpAdapter 的 OrderStatus/CancelState 状态机
不重写公司 ORS 的订单、撤单、RMS、终态逻辑
account query 是唯一新增业务接口；position/instrument 只改成查询初始化
OrderID 保持 clientId * 1_000_000 + orderCount
contract 固定 1.0.0；不引入 v3/v4 双 contract
纳入 003 §3.1 的生产修复：4040 模式、MD/Trader flow 目录拆分、登录重试/退避、MD 重订阅、MD 档位清零、查询限流
```

## Review Focus

- 未知或已从 map 删除的订单撤单：必须返回 `CANCEL_ORDER_REJECT`，不能静默丢，不能重新插入订单。
- 成交先于终态：`TRADE_CONFIRM` 不能让订单提前从 map 删除；只有公司 ORS 认定的终态才能清理。
- 旧 `FrontID/SessionID` 或旧 `OrderRef` 的延迟回报：必须丢弃，不能影响新订单或 RMS。
- 查询失败/空仓：不能回退到旧内存持仓，也不能让 session 进入 READY；空查询结果必须清空持仓表。
- Aeron back-pressure 或 publication 未连接：不能静默丢订单/撤单响应，必须上抛失败并保持订单状态可恢复。
- `ClientRegister` 重启复用：不能让新 `clientId` 复用 CTP 上仍存活订单的 OrderID 段。

---

### Task 1: Import CTP-only company ORS core

**Files:**
- Create: `ctp/v4/core/ORSServer.h`
- Create: `ctp/v4/core/ORSServer.cpp`
- Create: `ctp/v4/core/MdSpi.h`
- Create: `ctp/v4/core/MdSpi.cpp`
- Create: `ctp/v4/core/MDHandler.h`
- Create: `ctp/v4/core/MDHandler.cpp`
- Create: `ctp/v4/core/main.cpp`
- Create: `ctp/v4/core/OrsTypes.h`
- Create: `ctp/v4/core/OrsConfig.h`
- Create: `ctp/v4/core/OrsConfig.cpp`
- Create: `ctp/v4/transport/OrsTransport.h`
- Create: `ctp/v4/transport/InMemoryOrsTransport.h`
- Create: `ctp/v4/transport/InMemoryOrsTransport.cpp`
- Create: `ctp/v4/vendor/hftbase/` for the minimum transitive headers
- Create: `ctp/v4/CMakeLists.txt`
- Modify: `ctp/CMakeLists.txt`
- Test: `ctp/v4/tests/CoreLinkTest.cpp`

**Interfaces:**
- `struct OrsConfig { std::string brokerId, investorId, password, authCode, appId, tradeFront, mdFront, flowDir, logPath, accountId, venueId, orsId; int requestStream, responseStream, accountStream, marketDataStream, sessionStream, controlStream; };`
- `OrsTypes.h` defines the transport-facing values:
  - `struct AccountQueryRequest { uint64_t requestId; std::string accountId; uint64_t timestamp; };`
  - `struct AccountSnapshot { uint64_t requestId; std::string accountId, tradingDay; double balance, available, margin, frozenMargin, commission, closeProfit, positionProfit, deposit, withdraw; uint32_t errorCode; std::string errorMsg; uint64_t timestamp; };`
  - `struct SessionEvent { std::string venueId, accountId, orsId, state, reason; uint64_t timestamp; };`
  - `struct ClientRegisterRequest { uint64_t requestId; std::string instanceId, accountId, environment; uint64_t timestamp; };`
  - `struct ClientRegisterResult { uint64_t requestId; uint32_t clientId, errorCode; std::string errorMsg; uint64_t timestamp; };`
- `class OrsTransport`:
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
- `class ORSServer`:
  - `ORSServer(OrsConfig, OrsTransport&);`
  - `void Start();`
  - `void Stop();`
  - `void ProcessRequest(illuminati::infra::RequestMsg*);`
  - `void PushUpdate(illuminati::infra::ResponseMsg*);`
  - `void QueryAccount(const AccountQueryRequest&);`
  - `void RegisterClient(const ClientRegisterRequest&);`
- `ORSServer` constructor must not create CTP APIs, read position/contract files, or start threads. CTP creation and login happen only in `Start()`, so tests can construct the core without a network.

- [ ] **Step 1: Write the failing link test**

```cpp
// ctp/v4/tests/CoreLinkTest.cpp
#include "v4/core/ORSServer.h"
#include "v4/transport/InMemoryOrsTransport.h"

int main() {
  static_assert(sizeof(ors::v4::ORSServer) > 0);
  ors::v4::InMemoryOrsTransport transport;
  return transport.responseCount() == 0 ? 0 : 1;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cmake -S . -B build-v4
cmake --build build-v4 -j4 --target ctp_v4_core_link_test
```

Expected: FAIL because `ctp/v4/core/ORSServer.h` and `ctp/v4/transport/InMemoryOrsTransport.h` do not exist.

- [ ] **Step 3: Import the CTP-only company files**

Copy from `/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/ors/China`:

```text
src/ORSServer.cpp
src/MdSpi.cpp
src/MDHandler.cpp
include/ORSServer.h
include/MdSpi.h
include/MDHandler.h
```

Do not import `SgitFtdc*`, `TraderSpi.*`, `reuters*`, `dumprecorder.*`, `marketdatahandler.*`, or `tradedatahandler.*`.

Change every `#ifdef _USE_CTP_` to keep only the CTP branch. Remove the Sgit overloads and Sgit fields from `ORSServer.h/cpp` and `MdSpi.h/cpp`. Set `_USE_CTP_` in `ctp/v4/CMakeLists.txt`.

- [ ] **Step 4: Add OrsConfig and transport seam**

`OrsConfig::load(path)` reads only configuration:

```text
BROKER_ID, INVESTOR_ID, PASSWORD, AUTH_CODE, APP_ID
TRADE_FRONT, MD_FRONT, FLOW_DIR, LOG_FILE
ACCOUNT_ID, VENUE_ID, ORS_ID
AERON_DIR, AERON_CHANNEL
REQUEST_STREAM, RESPONSE_STREAM, ACCOUNT_STREAM
MARKET_DATA_STREAM, SESSION_STREAM, CONTROL_STREAM
RMS_CONFIG_FILE, RMS_FIRMWIDE_CONFIG_FILE
```

Use `ors::base::ConfigFile`. Do not add `POSITION_FILE`, `CONTRACT_FILE`, `REQUEST_SHMKEY`, `RESPONSE_SHMKEY`, `CLIENT_STORE_KEY`, or `MAX_CLIENTS`.

`InMemoryOrsTransport` stores sent `ResponseMsg`, `MarketUpdateNew`, `SessionEvent`, `AccountSnapshot`, and `ClientRegisterResult`; `start()` stores callbacks and returns true. It is a test double and an initial stand-in.

- [ ] **Step 5: Move CTP startup out of the constructor**

`ORSServer::ORSServer` only initializes config, maps, locks, RMS, and transport reference.

`ORSServer::Start` does:

```text
create TraderApi/MdApi
register fronts
Init/Join
```

No `createClientStore`, `createRequestClients`, `createResponseClient`, `startMonitorAsyncORSRequest`, `updatePositionFromFile`, or `writePositionToFile`.

Remove from `ORSServer`:

```text
ShmMgr m_shmmanager;
ShmMgr::RespShmQ* m_responseInterface;
m_requestShmKey/m_responseShmKey/m_requestShmSize/m_responseShmSize
m_clientStoreKey/m_maxClients
startReqRespLogger()
```

`PushUpdate`, `RmsError`, and `RmsWarning` call `transport_.sendResponse(...)`; keep the existing RMS/position updates after that call. `Start()` does not call `startMonitorAsyncORSRequest()`.

`MDHandler` still includes `mdshmwriter.h` at this stage. Add a temporary `ctp/v4/vendor/hftbase/mdshmwriter.h` no-op writer that discards writes and does not create SHM. Task 9 removes it.

`ORSServer::Stop` does not write position files and does not shut down SHM.

- [ ] **Step 6: Build and run the link test**

```bash
cmake -S . -B build-v4
cmake --build build-v4 -j4 --target ctp_v4_core_link_test
ctest --test-dir build-v4 -R ctp_v4_core_link --output-on-failure
```

Expected: PASS. The old v3 targets may still build; do not remove them yet.

- [ ] **Step 7: Commit**

```bash
git add ctp/v4 ctp/CMakeLists.txt
git commit -m "feat(ors): import ctp-only company core with transport seam"
```

---

### Task 2: Remove state files and initialize positions from CTP

**Files:**
- Create: `ctp/v4/core/PositionTable.h`
- Create: `ctp/v4/core/PositionTable.cpp`
- Modify: `ctp/v4/core/ORSServer.cpp`
- Modify: `ctp/v4/core/ORSServer.h`
- Test: `ctp/v4/tests/PositionTableTest.cpp`

**Interfaces:**
- `struct ContractPosition { int onLongPos; int todayLongPos; int onShortPos; int todayShortPos; };`
- `class PositionTable`:
  - `void replace(std::vector<PositionRow> rows);`
  - `ContractPosition get(std::string_view symbol) const;`
  - `bool empty() const;`
- `struct PositionRow { std::string instrumentId; char direction; int position; int todayPosition; };`
- `void ORSServer::onInstrumentQueryComplete();`
- `void ORSServer::onPositionQueryComplete();`

- [ ] **Step 1: Write failing table tests**

```cpp
void replaceMergesLongAndShort();
void emptyQueryClearsPreviousPositions();
void queryFailureLeavesTableEmpty();
void missingInstrumentReturnsZeroPosition();
```

The test constructs rows directly; it never opens `position.csv` or `contract_*.csv`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cmake --build build-v4 -j4 --target ctp_v4_position_table_test
ctest --test-dir build-v4 -R ctp_v4_position_table --output-on-failure
```

Expected: FAIL because `PositionTable` does not exist.

- [ ] **Step 3: Implement PositionTable**

`replace()` builds a new `std::map<std::string, ContractPosition>` outside the lock and swaps it under `std::mutex`. It handles CTP long/short rows:

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

A row with `Position == 0` is ignored. An empty query result clears the table.

- [ ] **Step 4: Integrate CTP query initialization**

After login completes:

```text
publish CONNECTING/AUTHENTICATING/LOGGING_IN/SETTLEMENT_CONFIRMING
ReqQryInstrument
  -> OnRspQryInstrument collects MasterData
  -> bIsLast: m_symbolMap = collected; publish QUERYING_INSTRUMENTS
  -> ReqQryInvestorPosition
  -> OnRspQryInvestorPosition collects PositionRow
  -> bIsLast: positionTable.replace(rows); onPositionQueryComplete()
  -> publish READY
```

On any query error or timeout, publish `SessionEvent.state = FAILED` with the CTP error/reason; do not enter READY and do not fall back to old file or old in-memory positions.

Use separate Trader/MD flow directories from `OrsConfig`. Apply the `quantlink-trading` production fixes here:

```text
login retry with backoff; pre-open health check
instrument query rate limit (no back-to-back queries)
position query full-table replacement; empty result clears
4040 production/evaluation mode from config
CTP 6.7.11 login signature/build compatibility
```

`SetCombOffsetFlag` reads only `PositionTable`. Remove:

```text
m_positionFile
m_contractFile
fpContractFile
updatePositionFromFile()
writePositionToFile()
CONTRACT_FILE write in OnRtnInstrumentStatus
OnRspQryInvestorPositionDetail file comparison branch
```

- [ ] **Step 5: Verify no file-backed state**

```bash
rg 'POSITION_FILE|CONTRACT_FILE|position\.csv|contract_' ctp/v4
```

Expected: no production matches; only test names or this plan may mention them.

- [ ] **Step 6: Run tests**

```bash
cmake --build build-v4 -j4
ctest --test-dir build-v4 -R 'ctp_v4_position_table|ctp_v4_core_link' --output-on-failure
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ctp/v4
git commit -m "feat(ors): replace position and contract files with ctp queries"
```

---

### Task 3: Replace base libraries and unify logging

**Files:**
- Create: `ctp/v4/log/Log.h`
- Create: `ctp/v4/log/Log.cpp`
- Create: `ctp/v4/tests/LogFacadeTest.cpp`
- Modify: `ctp/v4/core/ORSServer.cpp`
- Modify: `ctp/v4/core/MdSpi.cpp`
- Modify: `ctp/v4/core/MDHandler.cpp`
- Modify: `ctp/v4/vendor/hftbase/`
- Modify: `ctp/v4/CMakeLists.txt`

**Interfaces:**
- `void ors::v4::log::info(std::string_view event, std::initializer_list<LogField> fields);`
- `void ors::v4::log::warn(...)`, `error(...)`, `metrics(const Metrics&)`.

- [ ] **Step 1: Write failing log tests**

```cpp
void eventIsOneJsonLine();
void requiredFieldsArePresent();
void credentialsAreRedacted();
void metricsAreAggregatedNotPerTick();
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cmake --build build-v4 -j4 --target ctp_v4_log_facade_test
ctest --test-dir build-v4 -R ctp_v4_log_facade --output-on-failure
```

Expected: FAIL because the facade does not exist.

- [ ] **Step 3: Replace infrastructure**

Replace with std/`ors_base`:

```text
Configfile          -> ors::base::ConfigFile
CasLock             -> std::mutex / std::atomic
ITime_ClockRT       -> std::chrono
StatsCollector      -> counters + 60s metrics event
ILOG                -> ors::v4::log facade
ProcessSettings     -> std::filesystem / config
```

Keep `orderresponse.h`, `marketupdateNew.h`, `rmsimpl.hpp` checks, and tinyxml2 where required. Do not rewrite RMS rules.

Remove production `std::cerr`/`std::cout`; keep them only for `--help`, `--version`, config summary, and smoke tools. Delete `[ctp]` text logs.

- [ ] **Step 4: Verify**

```bash
cmake --build build-v4 -j4
ctest --test-dir build-v4 -R ctp_v4_log_facade --output-on-failure
rg 'ILOG|StatsCollector|std::cerr' ctp/v4/core ctp/v4/transport ctp/v4/query
```

Expected: PASS; no production matches for the forbidden loggers.

- [ ] **Step 5: Commit**

```bash
git add ctp/v4
git commit -m "refactor(ors): replace illuminati infrastructure and unify logs"
```

---

### Task 4: Add contract 1.0.0 codec mapping

**Files:**
- Create: `ctp/v4/contract/OrsCodec.h`
- Create: `ctp/v4/contract/OrsCodec.cpp`
- Create: `ctp/v4/contract/OrsCodecTest.cpp`
- Modify: `ctp/v4/CMakeLists.txt`

**Interfaces:**
- `illuminati::infra::RequestMsg decodeRequest(const com::quantlink::contract::sbe::OrsRequestDecoder&);`
- `std::size_t encodeResponse(const illuminati::infra::ResponseMsg&, char* dst, std::size_t capacity);`
- `std::size_t encodeMarketUpdate(const illuminati::md::MarketUpdateNew&, char* dst, std::size_t capacity);`
- `AccountQueryRequest decodeAccountQuery(const com::quantlink::contract::sbe::AccountQueryDecoder&);`
- `std::size_t encodeAccountSnapshot(const AccountSnapshot&, char* dst, std::size_t capacity);`
- `ClientRegisterRequest decodeClientRegister(const com::quantlink::contract::sbe::ClientRegisterDecoder&);`
- `std::size_t encodeClientRegisterResponse(const ClientRegisterResult&, char* dst, std::size_t capacity);`

All encoders wrap the supplied destination buffer and return encoded length including the SBE header. Decoders receive an already-wrapped decoder; the transport owns frame validation.

- [ ] **Step 1: Write failing codec tests**

```cpp
void requestMatchesCompanyRequestMsg();
void responseKeepsCancelRejectAndDoubleExchangeOrderId();
void marketUpdateKeepsTwentyLevelsAndSequence();
void accountSnapshotKeepsRequestIdAndFields();
void clientRegisterResponseKeepsClientIdAndError();
```

Use one real company `RequestMsg` fixture and one `ResponseMsg` fixture. Assert byte fields, fixed-width strings, `double ExchangeOrderId`, and 20 bid/ask levels.

- [ ] **Step 2: Run test to verify it fails**

```bash
cmake --build build-v4 -j4 --target ctp_v4_ors_codec_test
ctest --test-dir build-v4 -R ctp_v4_ors_codec --output-on-failure
```

Expected: FAIL because `OrsCodec` and generated headers are not available.

- [ ] **Step 3: Implement field-by-field mapping**

Do not define ORS order state in the codec. Mapping rules:

```text
OrsRequest.orderId          -> RequestMsg.OrderID
OrsRequest.requestType     -> RequestMsg.Request_Type
OrsRequest.transactionType -> RequestMsg.Transaction_Type
OrsRequest.exchangeType    -> RequestMsg.Exchange_Type
OrsRequest.contractDescription -> RequestMsg.Contract_Description
ResponseMsg.ExchangeOrderId -> OrsResponse.exchangeOrderId (double, no cast)
```

Fixed-width strings use the existing `ors::base::fitContractField` or an explicit copy with truncation; never rely on `strcpy`.

- [ ] **Step 4: Run tests**

```bash
cmake --build build-v4 -j4
ctest --test-dir build-v4 -R ctp_v4_ors_codec --output-on-failure
```

Expected: PASS. Also run the contract repository's Java round-trip tests before changing field widths.

- [ ] **Step 5: Commit**

```bash
git add ctp/v4/contract ctp/v4/CMakeLists.txt
git commit -m "feat(ors): map contract 1.0.0 frames to company messages"
```

---

### Task 5: Implement Aeron transport

**Files:**
- Create: `ctp/v4/transport/AeronOrsTransport.h`
- Create: `ctp/v4/transport/AeronOrsTransport.cpp`
- Create: `ctp/v4/transport/FakeFramePublisher.h`
- Test: `ctp/v4/tests/AeronOrsTransportTest.cpp`
- Modify: `ctp/v4/CMakeLists.txt`

**Interfaces:**
- `AeronOrsTransport(OrsConfig, FramePublisher&, FrameSubscriber&);`
- `bool sendResponse(const ResponseMsg&) override;`
- `bool sendMarketData(const MarketUpdateNew&) override;`
- `bool sendSession(const SessionEvent&) override;`
- `bool sendAccount(const AccountSnapshot&) override;`
- `bool sendClientRegisterResponse(const ClientRegisterResult&) override;`
- `void poll(int fragmentLimit);`

`FramePublisher`/`FrameSubscriber` are thin wrappers around the existing `AeronPublisher` and Aeron subscription. Do not duplicate offer-retry logic.

- [ ] **Step 1: Write failing transport tests**

```cpp
void responseUsesResponseStream();
void marketDataUsesMarketDataStream();
void accountUsesAccountStream();
void sessionUsesSessionStream();
void backPressureIsReportedAndRetried();
void controlFrameRoutesToClientRegisterHandler();
void requestFrameRoutesToProcessRequest();
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cmake --build build-v4 -j4 --target ctp_v4_aeron_transport_test
ctest --test-dir build-v4 -R ctp_v4_aeron_transport --output-on-failure
```

Expected: FAIL because `AeronOrsTransport` does not exist.

- [ ] **Step 3: Implement send paths**

One SBE message per Aeron frame. Use contract stream IDs:

```text
REQUEST=1, RESPONSE=2, ACCOUNT=3, MARKET_DATA=4, SESSION=5, CONTROL=6
```

`sendResponse` encodes `OrsResponse`; `sendMarketData` encodes `MarketUpdate`; `sendSession` encodes `SessionEvent`; `sendAccount` encodes `AccountSnapshot`; `sendClientRegisterResponse` encodes `ClientRegisterResponse`.

Use `offerWithRetry` from `ors/ctp/OfferRetry.h`. On `Published` return true. On back-pressure/not-connected/closed, return false and publish a `publish.fail` event; do not drop silently.

- [ ] **Step 4: Implement receive paths**

`poll()` decodes one frame at a time:

```text
REQUEST -> decodeRequest -> RequestHandler
CONTROL -> decodeClientRegister -> ClientRegisterHandler
ACCOUNT_QUERY -> decodeAccountQuery -> AccountQueryHandler
```

Unknown template IDs are rejected with a log event and do not mutate ORS state.

- [ ] **Step 5: Run tests**

```bash
cmake --build build-v4 -j4
ctest --test-dir build-v4 -R ctp_v4_aeron_transport --output-on-failure
```

Expected: PASS with a fake publisher; no Aeron network required.

- [ ] **Step 6: Commit**

```bash
git add ctp/v4/transport ctp/v4/tests ctp/v4/CMakeLists.txt
git commit -m "feat(ors): add aeron transport for contract 1.0.0"
```

---

### Task 6: Add ClientRegister and restart-safe clientId allocation

**Files:**
- Create: `ctp/v4/control/ClientRegistry.h`
- Create: `ctp/v4/control/ClientRegistry.cpp`
- Create: `ctp/v4/control/OpenOrderGuard.h`
- Create: `ctp/v4/control/OpenOrderGuard.cpp`
- Test: `ctp/v4/tests/ClientRegistryTest.cpp`
- Test: `ctp/v4/tests/OpenOrderGuardTest.cpp`
- Modify: `ctp/v4/core/ORSServer.h`
- Modify: `ctp/v4/core/ORSServer.cpp`

**Interfaces:**
- `ClientRegisterResult ClientRegistry::registerClient(std::string_view instanceId);`
- `void ClientRegistry::releaseIfFlat(uint32_t clientId, const OrderAccountMap& orders);`
- `uint32_t clientIdFromOrderId(uint32_t orderId);`
- `uint32_t makeOrderId(uint32_t clientId, uint32_t orderCount);`
- `bool OpenOrderGuard::hasLiveOrders(const std::vector<CThostFtdcOrderField>& rows);`

- [ ] **Step 1: Write failing registry tests**

```cpp
void allocatesSequentialClientIds();
void neverReusesClientIdWhileOrdersLive();
void releasesClientIdOnlyWhenNoLiveOrder();
void rejectsWhenClientIdRangeExhausted();
void orderIdUsesCompanyFormula();
void clientIdExtractionRejectsOutOfRange();
```

`clientId` range is `1..4294`; `OrderID` is `uint32` and `ORDERID_RANGE` is `1_000_000`.

- [ ] **Step 2: Write failing restart guard tests**

```cpp
void allTradedAndCanceledRowsAreTerminal();
void anyOpenOrderBlocksReady();
void guardFailurePublishesSessionFailed();
```

The guard query is `ReqQryOrder` after login, before accepting `ClientRegister`. Any non-terminal order means:

```text
SessionEvent.state = FAILED
reason = "open orders present; reconcile before client registration"
```

No `clientId` is allocated and no order request is accepted.

- [ ] **Step 3: Run tests to verify they fail**

```bash
cmake --build build-v4 -j4 --target 'ctp_v4_client_registry_test|ctp_v4_open_order_guard_test'
ctest --test-dir build-v4 -R 'ctp_v4_client_registry|ctp_v4_open_order_guard' --output-on-failure
```

Expected: FAIL because both classes do not exist.

- [ ] **Step 4: Implement ClientRegistry**

Allocate monotonically from 1. Do not derive `clientId` from `instanceId`; `instanceId` is diagnostic only. A reconnect receives a new `clientId`; the old `clientId` stays reserved until `releaseIfFlat` sees no order with that high bits.

`releaseIfFlat` scans `OrderAccountMap`; it must not release a `clientId` if any order with `orderId / 1_000_000 == clientId` remains.

- [ ] **Step 5: Implement OpenOrderGuard**

`hasLiveOrders` reads CTP `OrderStatus` and returns true for any status other than:

```text
THOST_FTDC_OST_AllTraded
THOST_FTDC_OST_Canceled
```

A query failure also blocks READY. Do not use `position.csv`, `contract_*`, or SHM to infer open orders.

- [ ] **Step 6: Wire ClientRegister and the order gate**

`ORSServer::RegisterClient` calls `ClientRegistry::registerClient` and sends `ClientRegisterResult` through `transport_.sendClientRegisterResponse`.

Before a successful registration, `ProcessRequest` for `NEWORDER`, `MODIFYORDER`, or `CANCELORDER` responds with an explicit error and never reaches CTP. The test is:

```cpp
void orderBeforeClientRegisterIsRejected();
```

- [ ] **Step 7: Verify**

```bash
cmake --build build-v4 -j4
ctest --test-dir build-v4 -R 'ctp_v4_client_registry|ctp_v4_open_order_guard' --output-on-failure
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ctp/v4/control ctp/v4/tests ctp/v4/core ctp/v4/CMakeLists.txt
git commit -m "feat(ors): allocate client ids with restart safety"
```

---

### Task 7: Add account query and query cadence

**Files:**
- Create: `ctp/v4/query/QueryMapping.h`
- Create: `ctp/v4/query/QueryMapping.cpp`
- Create: `ctp/v4/query/AccountQueryService.h`
- Create: `ctp/v4/query/AccountQueryService.cpp`
- Create: `ctp/v4/query/QueryCadence.h`
- Test: `ctp/v4/tests/AccountQueryTest.cpp`
- Test: `ctp/v4/tests/QueryCadenceTest.cpp`
- Modify: `ctp/v4/core/ORSServer.cpp`

**Interfaces:**
- `AccountSnapshot mapAccountSnapshot(const CThostFtdcTradingAccountField&, uint64_t requestId, const OrsConfig&);`
- `bool AccountQueryService::query(uint64_t requestId, std::chrono::steady_clock::time_point now);`
- `bool AccountQueryService::acceptResponse(int ctpRequestId, const CThostFtdcTradingAccountField* row, const CThostFtdcRspInfoField* error);`
- `bool QueryCadence::tryAcquire(std::chrono::steady_clock::time_point now);`

- [ ] **Step 1: Write failing account tests**

```cpp
void successEmitsSnapshotWithRequestId();
void ctpErrorEmitsErrorSnapshotAndKeepsSessionState();
void secondQueryInsideIntervalIsRejected();
void successDoesNotChangeReadyStateOrOrderMap();
void nanAndDblMaxAreSanitized();
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cmake --build build-v4 -j4 --target 'ctp_v4_account_query_test|ctp_v4_query_cadence_test'
ctest --test-dir build-v4 -R 'ctp_v4_account_query|ctp_v4_query_cadence' --output-on-failure
```

Expected: FAIL because the query service does not exist.

- [ ] **Step 3: Implement mapping and cadence**

Copy the field mapping from `ctp/src/CtpQueryService.cpp` into `ctp/v4/query/QueryMapping.cpp`, but do not copy the v3 `CtpQueryService` service or its session state machine.

Account fields:

```text
Balance, Available, CurrMargin, FrozenMargin, Commission,
CloseProfit, PositionProfit, Deposit, Withdraw
```

`requestId` is the SDK query correlation key. `tradingDay` comes from the CTP row. Sanitize `DBL_MAX` and NaN to `0.0`.

Use a 1000 ms cadence. The second query inside the interval returns a rejected result, not a silently dropped request.

- [ ] **Step 4: Integrate CTP callbacks**

`QueryAccount(AccountQueryRequest)` calls `ReqQryTradingAccount` only in READY. Store `requestIdByCtpRequestId`.

`OnRspQryTradingAccount` maps a successful row to `AccountSnapshot` and calls `transport.sendAccount`. An error or empty result publishes an error snapshot. It must not call `PushUpdate`, change `m_ordLocalMap`, or change session READY.

- [ ] **Step 5: Run tests**

```bash
cmake --build build-v4 -j4
ctest --test-dir build-v4 -R 'ctp_v4_account_query|ctp_v4_query_cadence' --output-on-failure
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ctp/v4/query ctp/v4/tests ctp/v4/core ctp/v4/CMakeLists.txt
git commit -m "feat(ors): add throttled account query"
```

---

### Task 8: Add order/RMS parity tests

**Files:**
- Create: `ctp/v4/core/OrderMapper.h`
- Create: `ctp/v4/core/OrderMapper.cpp`
- Create: `ctp/v4/tests/OrderParityTest.cpp`
- Test fixtures: `ctp/v4/tests/CompanyFixtures.h`
- Modify: `ctp/v4/core/ORSServer.cpp`

**Interfaces:**
- `CThostFtdcInputOrderField mapNewOrder(const RequestMsg&, const OrderInfo&, const ContractPosition&);`
- `CThostFtdcInputOrderActionField mapCancel(const RequestMsg&, const OrderInfo&);`
- `void ORSServer::seedOrderForTest(const OrderInfo&);` compiled only under `ORS_V4_TESTING`.

- [ ] **Step 1: Write failing parity tests**

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

The tests construct `ORSServer` with `InMemoryOrsTransport` and do not call `Start()`, so no CTP network is touched. Cancel-reject and trade callbacks are invoked directly with company-shaped rows.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cmake --build build-v4 -j4 --target ctp_v4_order_parity_test
ctest --test-dir build-v4 -R ctp_v4_order_parity --output-on-failure
```

Expected: FAIL because the test hook, mapper, or behavior is missing.

- [ ] **Step 3: Extract pure mapping helpers**

Move only the field construction out of `SendNewOrder`/`SendCancelOrder`:

```text
RequestMsg + OrderInfo + ContractPosition -> CThostFtdcInputOrderField
RequestMsg + OrderInfo                  -> CThostFtdcInputOrderActionField
```

Do not move map mutation, RMS checks, `PushUpdate`, or CTP callbacks.

Preserve company behavior:

```text
BUY  against short today  -> CloseToday on SHFE, Close elsewhere
BUY  against short yesterday -> Close
SELL against long today   -> CloseToday on SHFE, Close elsewhere
SELL against long yesterday -> Close
otherwise                 -> Open
```

- [ ] **Step 4: Fix only the behavior the tests expose**

Unknown cancel must call `RejectOrder` with `CANCEL_ORDER_REJECT` and the original `OrderID`; it must not insert a new order into `m_ordLocalMap`.

Cancel reject must push `CANCEL_ORDER_REJECT` without erasing the existing order.

Trade callback must not erase the order; only the company terminal path removes it.

Stale `FrontID/SessionID`/`OrderRef` responses are discarded before map mutation.

- [ ] **Step 5: Run tests**

```bash
cmake --build build-v4 -j4
ctest --test-dir build-v4 -R ctp_v4_order_parity --output-on-failure
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ctp/v4/core ctp/v4/tests ctp/v4/CMakeLists.txt
git commit -m "test(ors): pin company order and rms parity"
```

---

### Task 9: Replace MDHandler SHM with transport sink

**Files:**
- Modify: `ctp/v4/core/MDHandler.h`
- Modify: `ctp/v4/core/MDHandler.cpp`
- Create: `ctp/v4/md/MarketDataSink.h`
- Test: `ctp/v4/tests/MDHandlerTest.cpp`
- Modify: `ctp/v4/core/MdSpi.cpp`

**Interfaces:**
- `class MarketDataSink { virtual bool send(const illuminati::md::MarketUpdateNew&) = 0; };`
- `MDHandler(MarketDataSink&);`
- `void MDHandler::ProcessMDUpdate(char*);`

- [ ] **Step 1: Write failing MD tests**

```cpp
void preservesTwentyBidAndAskLevels();
void incrementsSequenceAndSetsTimestamp();
void callsSinkExactlyOncePerTick();
void sinkFailureIsReportedNotIgnored();
void reconnectResubscribesAllSymbols();
void firstTickAfterReconnectDoesNotReuseOldLevels();
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cmake --build build-v4 -j4 --target ctp_v4_md_handler_test
ctest --test-dir build-v4 -R ctp_v4_md_handler --output-on-failure
```

Expected: FAIL because `MDHandler` still requires SHM and no sink exists.

- [ ] **Step 3: Replace SHM writer**

Remove `mdshmwriter.h`, `MD_SHMKEY`, `MD_SHMSIZE`, and `MarketDataShmWriter`.

`ProcessMDUpdate` does:

```text
update->m_timestamp = nowNanos()
update->m_seqnum = ++m_seqNum
sink.send(*update)
```

`MdSpi` passes the transport-backed sink. Do not change the 20-level `MarketUpdateNew` layout.

On MD reconnect:

```text
re-subscribe every symbol in m_symbolMap
reset bid/ask levels to empty before the first tick after reconnect
do not publish old ticks from the previous session
```

- [ ] **Step 4: Run tests**

```bash
cmake --build build-v4 -j4
ctest --test-dir build-v4 -R ctp_v4_md_handler --output-on-failure
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ctp/v4/core ctp/v4/md ctp/v4/tests ctp/v4/CMakeLists.txt
git commit -m "feat(ors): publish market data through transport sink"
```

---

### Task 10: Cut over and run the live gate

**Files:**
- Modify: `ctp/CMakeLists.txt`
- Modify: `CMakeLists.txt`
- Remove: active v3 `ctp/src`, `ctp/include`, `ctp/tests`
- Keep: `docs/v3` as history only

- [ ] **Step 1: Remove the v3 active build**

Remove the old `ors_ctp`, `ors_ctp_core`, `ors_aeron`, and v3 tests from the root build. The v4 binary becomes `ors_ctp`.

Do not keep v3/v4 dual active targets.

- [ ] **Step 2: Run the full build and tests**

```bash
cmake -S . -B build-v4
cmake --build build-v4 -j4
ctest --test-dir build-v4 --output-on-failure
```

Expected: all tests pass.

- [ ] **Step 3: Run the live SimNow lifecycle test**

Only during a trading session, with a valid SimNow account:

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

Do not run live order tests outside trading hours. Record the exact config and result in `docs/v4/live-gate-YYYYMMDD.md`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ors): cut over to ctp company core"
```

---

## Plan Decisions

- **ClientId restart safety:** ORS uses `ReqQryOrder` after login; if any order is not `AllTraded`/`Canceled`, it does not enter READY and does not allocate clientIds. This costs one startup query but prevents reusing OrderID segments while CTP still has live orders.
- **No SHM compatibility layer:** `OrsTransport` is a new seam; do not keep `ShmMgr` behind an adapter.
- **No file fallback:** position/instrument state comes only from CTP queries. A failed query is a failed startup, not a reason to read an old CSV.
- **Contract codegen is external:** ORS consumes generated headers from the contract repository; it does not own or duplicate the SBE schema.
- **Account query only:** position/instrument query changes are initialization semantics, not a new order state machine.

## Verification Matrix

| Behavior | Test |
|---|---|
| unknown/erased cancel | `ctp_v4_order_parity` |
| cancel reject keeps order | `ctp_v4_order_parity` |
| trade before terminal | `ctp_v4_order_parity` |
| stale front/session report | `ctp_v4_order_parity` |
| RMS reject no CTP call | `ctp_v4_order_parity` |
| empty position query clears table | `ctp_v4_position_table` |
| query failure blocks READY | `ctp_v4_position_table`, `ctp_v4_open_order_guard` |
| account query error does not change READY | `ctp_v4_account_query` |
| Aeron back-pressure is reported | `ctp_v4_aeron_transport` |
| clientId never reused while live | `ctp_v4_client_registry` |
| MD 20 levels and sequence | `ctp_v4_md_handler` |
| JSONL fields and redaction | `ctp_v4_log_facade` |

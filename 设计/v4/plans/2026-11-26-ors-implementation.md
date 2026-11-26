# ORS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current ORS with a company-ORS-compatible implementation: account-level order authority, RMS, CTP sessions, Aeron transport, and account query.

**Architecture:** One ORS process per CTP account. Company ORS order/RMS logic remains the core. SHM request/response is replaced by an `OrsTransport` interface backed by Aeron. Contract 1.0.0 carries `OrsRequest`, `OrsResponse`, `AccountQuery`, `AccountSnapshot`, `MarketUpdate`, `SessionEvent`, and `ClientRegister` frames.

**Tech Stack:** C++20, CMake, CTP TraderApi/MdApi, Aeron C++ client, contract 1.0.0 SBE, 190 Rocky Linux.

**Spec:** `quantlink-docs/设计/v4/003-ors-v4.md`

**Contract:** `quantlink-venue-contract/abi/sbe/quantlink-fin-sbe.xml`

## Global Constraints

```text
公司 ORS 是订单/RMS/账户/持仓业务基线
account query + 去掉 POSITION_FILE / CONTRACT_FILE 状态读写，改为 CTP 查询
不保留 SHM 请求/响应
不沿用 v3 CtpAdapter 的 OrderStatus/CancelState 状态机
不保留 v3/v4 双实现
一个 ORS 进程 = 一个 CTP 账户
SDK 不维护订单状态
```

## Review Focus

- 未知/已删除订单撤单必须返回 `CANCEL_ORDER_REJECT`，不能静默丢。
- `NEW_ORDER_CONFIRM` / `TRADE_CONFIRM` / `ORDER_ERROR` 时序必须与公司 ORS 一致。
- `ClientRegister` 的 `clientId` 不能与仍存活订单冲突。
- account query 节流失败不能改变订单状态或 READY。
- `MarketUpdate` 不能把 v3 的 20 档结构当成公司行情语义。

---

### Task 1: C++ contract codegen

**Files:**
- Modify: `tools/gen_contract_cpp.sh`
- Modify: `ctp/CMakeLists.txt`
- Test: `build/generated/contract` compile target

**Interfaces:**
- Produces generated C++ namespace/classes for `OrsRequest`, `OrsResponse`, `AccountSnapshot`, `MarketUpdate`, `SessionEvent`, `ClientRegister`.
- Consumes contract schema at `quantlink-venue-contract/abi/sbe/quantlink-fin-sbe.xml`.

- [ ] **Step 1: Generate C++ from contract 1.0.0**

Update `gen_contract_cpp.sh` to target the canonical schema and output directory. Run:

```bash
SBE_JAR=/Users/wangjun/PG/quantlink-fin/.tools/sbe-all-1.35.6.jar \
CONTRACT_HOME=/Users/wangjun/PG/quantlink-new/quantlink-venue-contract \
./tools/gen_contract_cpp.sh
```

Expected: generated headers for the new messages, no v3 `OrderUpdate`/`Trade` classes required by ORS v4.

- [ ] **Step 2: Add a compile-only codec smoke target**

Add a C++ test that encodes/decodes one `OrsRequest` and one `OrsResponse` using generated code.

- [ ] **Step 3: Verify**

```bash
cmake -S . -B build
cmake --build build -j4
ctest --test-dir build -R ctp_contract_codec --output-on-failure
```

---

### Task 2: Import company ORS core

**Files:**
- Create: `ctp/core/ORSServer.cpp`, `ctp/core/ORSServer.h`
- Create: `ctp/core/MdSpi.cpp`, `ctp/core/MDHandler.cpp`, `ctp/core/marketdatahandler.cpp`, `ctp/core/tradedatahandler.cpp`
- Create: `ctp/core/main.cpp`
- Create: `ctp/vendor/hftbase/` for the exact headers/sources ORS needs
- Modify: `ctp/CMakeLists.txt`

**Interfaces:**
- Core exposes `ORSServer::ProcessRequest(RequestMsg*)` and `ORSServer::PushUpdate(ResponseMsg*)`.
- Core retains `m_ordLocalMap`, RMS, CTP callbacks, terminal behavior.

- [ ] **Step 1: Import company ORS files**

Copy from:

```text
/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/ors/China
```

Do not import `Sgit*` sources or the old `mdshmwriter` path.

- [ ] **Step 2: Vendor only required hftbase pieces**

Keep only `orderresponse.h`, `marketupdateNew.h`, RMS implementation/checks, and the minimum temporary utilities needed to compile Task 2. Do not vendor the SHM manager. Task 2B removes the remaining illuminati config/lock/time/log utilities.

- [ ] **Step 3: Build the baseline**

Add a CMake target for ORS core with CTP Trader/Md libraries.

- [ ] **Step 4: Replace file-backed initialization**

Remove:
- `POSITION_FILE` read/write
- `CONTRACT_FILE` write
- `updatePositionFromFile()`
- `writePositionToFile()`
- `fpContractFile` persistence

Use CTP queries from `quantlink-trading/ors/China` as reference, but do not copy its file-write calls:
- `ReqQryInstrument`
- `ReqQryInvestorPosition`
- `ReqQryTradingAccount`

Include the production fixes listed in `003-ors-v4.md` §3.1:
- 4040 production mode
- MD/Trader flow directory split
- login retry/backoff
- MD resubscribe
- MD level reset
- instrument/position query rate limit and full-table replacement

Do not import StrategyID, split-order changes, CFFEX/ZCE behavior changes, SHM fixes, or file-backed state.

- [ ] **Step 5: Verify baseline**

```bash
cmake --build build -j4 --target ors_core
```

Expected: company ORS core compiles without file-backed state, with SHM symbols unresolved or stubbed only where transport will replace them.

---

### Task 2B: Simplify base libraries and unify logging

**Files:**
- Create: `ctp/include/ors/log.h`
- Create: `ctp/src/log.cpp`
- Create: `ctp/tests/LogFacadeTest.cpp`
- Modify: `ctp/core/ORSServer.cpp`, `ctp/core/MdSpi.cpp`, `ctp/core/main.cpp`
- Modify: `ctp/vendor/hftbase/` and `ctp/CMakeLists.txt`
- Reference: `005-ors-code-cleanup.md`

**Interfaces:**
- `ors::log::info|warn|error(event, fields)`
- `ors::log::metrics(fields)`
- Internally may use `ors_base::logEvent` / spdlog; business code must not call spdlog, `ILOG`, `std::cerr`, or `StatsCollector` directly.

- [ ] **Step 1: RED**

Add `LogFacadeTest.cpp` asserting:
- one event produces one JSONL line
- required fields `ts`, `level`, `event` are present
- credentials are not emitted
- no `[ctp]` prefix outside JSON

- [ ] **Step 2: Replace illuminati infrastructure**

Remove or replace with std/`ors_base`:
- `Configfile` -> `ors_base::ConfigFile`
- `CasLock` -> `std::mutex` / `std::atomic`
- `ITime_ClockRT` -> `std::chrono`
- `StatsCollector` -> counters + 60s `metrics`
- `ILOG` -> `ors::log` facade
- `ProcessSettings` -> `std::filesystem` / config

Do not rewrite RMS or order-state logic. Keep `orderresponse.h`, `marketupdateNew.h`, RMS checks, and tinyxml2 where required.

- [ ] **Step 3: Replace logging calls**

- Define the event dictionary from `005-ors-code-cleanup.md`
- Replace business `std::cout` / `std::cerr` with the facade
- Delete `[ctp]` text logs
- Hot paths use counters, not per-tick logs
- Keep human-readable output only for `--help`, `--version`, config summary, and smoke tests

- [ ] **Step 4: GREEN**

```bash
cmake --build build -j4
ctest --test-dir build -R 'ctp_log_facade' --output-on-failure
rg 'ILOG|StatsCollector|std::cerr' ctp/core ctp/src ctp/include
```

Expected: no production `ILOG`, `StatsCollector`, or `std::cerr`; JSONL parses; no per-tick MD log.

---

### Task 3: Introduce transport seam

**Files:**
- Create: `ctp/include/ors/transport/OrsTransport.h`
- Modify: `ctp/core/ORSServer.cpp`
- Modify: `ctp/core/MDHandler.cpp`
- Test: `ctp/tests/FakeOrsTransportTest.cpp`

**Interfaces:**
- `OrsTransport::sendResponse(const ResponseMsg&)`
- `OrsTransport::sendMarketData(const MarketUpdateNew&)`
- `OrsTransport::sendSession(const SessionEvent&)`
- `OrsTransport::start(RequestHandler, AccountHandler)`

- [ ] **Step 1: RED**

Write a fake transport test asserting:
- request handler reaches `ORSServer::ProcessRequest`
- `PushUpdate` reaches `sendResponse`
- MD update reaches `sendMarketData`
- session event reaches `sendSession`

- [ ] **Step 2: Implement seam**

Remove `m_shmmanager` / `m_responseInterface` from `ORSServer`. Route `PushUpdate` and `MDHandler` through the transport. Do not change order/RMS logic.

- [ ] **Step 3: GREEN**

```bash
cmake --build build -j4
ctest --test-dir build -R ctp_fake_transport --output-on-failure
```

---

### Task 4: Aeron transport

**Files:**
- Create: `ctp/include/ors/transport/AeronOrsTransport.h`
- Create: `ctp/src/transport/AeronOrsTransport.cpp`
- Modify: `ctp/CMakeLists.txt`
- Test: `ctp/tests/AeronTransportTest.cpp`

**Interfaces:**
- Uses contract 1.0.0 streams: request=1, response=2, account=3, market=4, session=5, control=6.
- Encodes `OrsRequest` into `ProcessRequest`.
- Encodes `ResponseMsg` into `OrsResponse`.
- Encodes `MarketUpdateNew` into `MarketUpdate`.
- Encodes session state into `SessionEvent`.

- [ ] **Step 1: RED**

Test request/response frame round-trip through fake Aeron publications/subscriptions.

- [ ] **Step 2: Implement**

Add Aeron connect, publication/subscription lookup, offer failure handling, and frame decode/encode.

- [ ] **Step 3: GREEN**

```bash
cmake --build build -j4
ctest --test-dir build -R ctp_aeron_transport --output-on-failure
```

- [ ] **Step 4: Failure cases**

Test `BACK_PRESSURED`, `NOT_CONNECTED`, and malformed frames. A failed order request must not be reported as accepted.

---

### Task 5: ClientRegister and OrderID

**Files:**
- Create: `ctp/include/ors/ClientRegistry.h`
- Create: `ctp/src/ClientRegistry.cpp`
- Modify: `ctp/src/transport/AeronOrsTransport.cpp`
- Test: `ctp/tests/ClientRegistryTest.cpp`

**Interfaces:**
- `ClientRegisterResponse` returns `clientId`.
- `clientId` is unique per ORS account while any order using it may still be live.
- OrderID remains `clientId * 1_000_000 + orderCount`.

- [ ] **Step 1: RED**

Test:
- first registration gets a clientId
- second active registration gets a different clientId
- released/expired clientId can be reused only after no live orders
- bad request/account gets an error response

- [ ] **Step 2: Implement**

Add `ClientRegistry` to ORS, wire control stream, and reject order requests before registration.

- [ ] **Step 3: GREEN**

```bash
ctest --test-dir build -R ctp_client_registry --output-on-failure
```

---

### Task 6: Account query

**Files:**
- Modify: `ctp/core/ORSServer.cpp`
- Modify: `ctp/core/ORSServer.h`
- Create: `ctp/tests/AccountQueryTest.cpp`
- Modify: `ctp/CMakeLists.txt`

**Interfaces:**
- `AccountQuery` request → CTP `ReqQryTradingAccount`
- `OnRspQryTradingAccount` → `AccountSnapshot`
- Query throttle minimum 1s.

- [ ] **Step 1: RED**

Test:
- account query success emits snapshot
- error response emits error fields
- second query inside interval is rejected/throttled
- query failure does not change session READY or order state
- startup instrument/position query is the only source of contract/position state
- no position.csv / contract file is read or written

- [ ] **Step 2: Implement**

Enable CTP account query, add throttle, map fields to `AccountSnapshot`, publish on account stream. Ensure instrument/position initialization is query-based and has no file fallback.

- [ ] **Step 3: GREEN**

```bash
ctest --test-dir build -R ctp_account_query --output-on-failure
```

---

### Task 7: Order/RMS parity tests

**Files:**
- Create: `ctp/tests/CompanyOrsParityTest.cpp`
- Modify: `ctp/CMakeLists.txt`

**Interfaces:**
- Uses fake CTP request sender / fake transport.
- Asserts company `ResponseMsg` types and order map state.

- [ ] **Step 1: RED**

Cover:
- new order confirms
- cancel confirm
- cancel reject keeps order working
- unknown cancel emits `CANCEL_ORDER_REJECT`
- insert reject
- trade then terminal
- duplicate callbacks
- old front/session drop
- RMS rejection

- [ ] **Step 2: GREEN**

Fix only deviations from company ORS. Do not add new order states.

- [ ] **Step 3: Verify**

```bash
ctest --test-dir build -R ctp_company_parity --output-on-failure
```

---

### Task 8: MD and cutover

**Files:**
- Modify: `ctp/core/MDHandler.cpp`
- Modify: `ctp/CMakeLists.txt`
- Delete: old v3 CTP implementation paths
- Update: README and v3 design references

- [ ] **Step 1: MD tests**

Cover first tick, 20 levels, duplicate tick, stale, timestamp, reconnect/resubscribe.

- [ ] **Step 2: Remove v3 ORS code**

Delete the old `CtpAdapter`/`ContractRuntime` implementation after v4 parity and integration pass. No compatibility aliases.

- [ ] **Step 3: Full build/test**

```bash
cmake --build build -j4
ctest --test-dir build --output-on-failure
```

- [ ] **Step 4: Live SimNow**

Run login/MD/query, then order/cancel/fill during market hours. No production order test outside trading hours.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ors): replace SHM with Aeron and keep company ORS order semantics"
```

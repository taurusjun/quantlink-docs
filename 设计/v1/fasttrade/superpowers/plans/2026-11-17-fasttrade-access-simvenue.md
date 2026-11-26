# FastTrade Access -> SimVenue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal FastTrade AccessSDK that connects directly to SimVenue and prove order, trade, position, cancel and restart on 190.

**Architecture:** One `access-sdk` library owns the contract Aeron subscriptions/publications and callbacks. One `fasttrade-smoke` application drives a real order/cancel flow. No separate AccessRuntime process; SIM uses SimVenue, LIVE uses a contract-capable CTP adapter.

**Tech Stack:** Java 25, Gradle 9.8.2, Aeron 1.54.0, Agrona 2.1.0, venue-contract 0.1.8, JUnit 5.

**Spec:** `docs/superpowers/specs/2026-11-17-fasttrade-access-simvenue-design.md`

## Global Constraints

- Depend on `com.quantlink.contract:venue-contract:0.1.8`, never on SimVenue source.
- Use `aeron:ipc` only.
- One execution stream; `OrderUpdate` and `Trade` share one sequence.
- SimVenue must publish `lastSeqByStream` with the configured stream IDs; verify `--stream-base 9000` produces keys `9001` and `9004`.
- All callbacks run on the `poll` thread.
- No silent drop of order/cancel requests.
- Java 25; build on 190, not locally.
- Version starts at `0.1.0`.

## Review Focus

- Session not READY: submit/cancel must fail loudly, not send.
- Execution gap/duplicate: count and continue, never crash.
- Client restart: new source session and order IDs, snapshots readable.
- SimVenue restart: new session resets sequence high-water, old snapshots not trusted.
- Publication not connected: fail before encode/offer; no false success.

---

### Task 1: Bootstrap Gradle project

**Files:**
- Create: `build.gradle.kts`
- Create: `settings.gradle.kts`
- Create: `access-sdk/build.gradle.kts`
- Create: `fasttrade-smoke/build.gradle.kts`
- Create: `gradlew`, `gradlew.bat`, `gradle/wrapper/*`
- Create: `fasttrade-smoke/src/main/resources/logback.xml`

**Interfaces:**
- Produces: root project `quantlink-fasttrade`, modules `:access-sdk`, `:fasttrade-smoke`.

- [ ] **Step 1: Add and commit the Gradle 9.8.2 wrapper files (`gradlew`, `gradlew.bat`, `gradle/wrapper/*`). A clean checkout must build without a sibling repo; generate with `gradle wrapper --gradle-version 9.8.2`, or copy the wrapper once from an existing Gradle 9.8.2 repo, commit it, and do not depend on that repo afterward.**
- [ ] **Step 2: Write root build/settings with Java 25 toolchain and `mavenLocal()` before `mavenCentral()`.**
- [ ] **Step 3: Write module build files with contract 0.1.8, Aeron 1.54.0, Agrona 2.1.0, SLF4J, logback runtime.**
- [ ] **Step 4: Sync this checkout to `/opt/quantlink-fasttrade` on 190 (rsync, excluding `.git`, `.gradle`, `build`) and set owner `quantlink`.**
- [ ] **Step 5: Run `./gradlew projects` on 190; expect `:access-sdk` and `:fasttrade-smoke`.**
- [ ] **Step 6: Commit.**

### Task 2: AccessConfig and SequenceGuard

**Files:**
- Create: `access-sdk/src/main/java/com/quantlink/fasttrade/access/AccessConfig.java`
- Create: `access-sdk/src/main/java/com/quantlink/fasttrade/access/SequenceGuard.java`
- Test: `access-sdk/src/test/java/com/quantlink/fasttrade/access/AccessConfigTest.java`
- Test: `access-sdk/src/test/java/com/quantlink/fasttrade/access/SequenceGuardTest.java`

**Interfaces:**
- Produces:
  - `AccessConfig.forStreamBase(String aeronDir, String venueId, String accountId, String environment, long sourceSessionId, long sourcePublicationEpoch, int streamBase)`
  - `AccessConfig.defaults(...)`
  - `SequenceGuard.acceptExecution(long seq) -> SequenceGuard.Result`
  - `SequenceGuard.acceptMarketData(String key, long seq) -> SequenceGuard.Result`
  - `SequenceGuard.resetExecution(long highWater)`
  - `SequenceGuard.resetMarketData()`
  - `enum Result { FIRST, NEXT, DUPLICATE, GAP }`

- [ ] **Step 1: Write failing tests for `9000 -> 9001..9007`, defaults, invalid blank venue/account/environment.**
- [ ] **Step 2: Run tests on 190; expect compile failure.**
- [ ] **Step 3: Implement `AccessConfig` record and validation.**
- [ ] **Step 4: Write failing tests for MD continuity, duplicate, gap, per-key isolation, execution reset.**
- [ ] **Step 5: Implement `SequenceGuard`.**
- [ ] **Step 6: Run `:access-sdk:test`; expect PASS.**
- [ ] **Step 7: Commit.**

### Task 3: AccessListener and AccessHealth

**Files:**
- Create: `access-sdk/src/main/java/com/quantlink/fasttrade/access/AccessListener.java`
- Create: `access-sdk/src/main/java/com/quantlink/fasttrade/access/AccessHealth.java`

**Interfaces:**
- Produces:
  - `AccessListener` default methods for MD/order/trade/position/account/session.
  - `AccessHealth(boolean connected, boolean ready, long lastSessionAtNanos, long lastMarketDataAtNanos, long lastExecutionAtNanos, long lastAccountAtNanos, long marketDataGap, long executionGap, long duplicateMarketData, long duplicateExecution, long orphanExecution, long missingSessionHighWater, long malformedFrames, long submitFailures, boolean accountFresh, boolean positionsFresh)`

- [ ] **Step 1: Add the listener interface.**
- [ ] **Step 2: Add the health record.**
- [ ] **Step 3: Run `:access-sdk:compileJava`; expect PASS.**
- [ ] **Step 4: Commit.**

### Task 4: AccessClient contract boundary

**Files:**
- Create: `access-sdk/src/main/java/com/quantlink/fasttrade/access/AccessClient.java`
- Test: `access-sdk/src/test/java/com/quantlink/fasttrade/access/AccessClientTest.java`

**Interfaces:**
- Consumes: `AccessConfig`, `AccessListener`, `SequenceGuard`.
- Produces:
  - `AccessClient(Aeron aeron, AccessConfig config, AccessListener listener)`
  - `int poll(int fragmentLimit)`
  - `boolean submit(OrderRequestEnvelope request)`
  - `boolean cancel(CancelRequestEnvelope request)`
  - `boolean ready()`, `boolean connected()`
  - `Optional<AccountSnapshotEnvelope> account()`
  - `Optional<VenueSessionEnvelope> session()`
  - `Map<String, PositionEnvelope> positions()`
  - `AccessHealth health()`
  - `void close()`

- [ ] **Step 1: Write `AccessClientTest` with an embedded MediaDriver and a fake venue. Cover: session not READY rejects submit; execution or MD subscription disconnected rejects submit; READY delivers an OrderRequest to the fake venue; the fake session uses the configured `executionStream` key; a missing key increments `missingSessionHighWater`; the known-order-ID window is bounded; execution shares one sequence; duplicate is ignored; gap is counted; MD and snapshots reach the listener.**
- [ ] **Step 2: Run `:access-sdk:test --tests '*AccessClientTest'` on 190; expect compile failure.**
- [ ] **Step 3: Create subscriptions/publications in the constructor.**
- [ ] **Step 4: Implement `poll` for session, execution, MD, position, account, with decode/counter handling.**
- [ ] **Step 5: Implement session readiness and new-session reset using `sourceSessionId/sourcePublicationEpoch` and `lastSeqByStream`.**
- [ ] **Step 6: Implement order/cancel scope validation, readiness check, 250ms publish retry and failure counters.**
- [ ] **Step 7: Implement latest account, position map, stale flags and health.**
- [ ] **Step 8: Run `:access-sdk:test`; expect PASS.**
- [ ] **Step 9: Commit.**

### Task 5: Smoke client

**Files:**
- Create: `fasttrade-smoke/src/main/java/com/quantlink/fasttrade/smoke/AccessSmokeMain.java`
- Modify: `fasttrade-smoke/build.gradle.kts`

**Interfaces:**
- Consumes: `AccessClient`, `AccessConfig`, contract envelopes.
- Produces: executable `com.quantlink.fasttrade.smoke.AccessSmokeMain`.

- [ ] **Step 1: Parse defaults `SIMVENUE / SIMVENUE-001 / SHADOW / au2612 / streamBase 9000 / timeout 15s`; default `sourceSessionId = System.currentTimeMillis()` and `sourcePublicationEpoch = 1`, with `--source-session-id` / `--source-publication-epoch` overrides; use `clientOrderIdBase = Math.max(1, (sourceSessionId % 1_000_000_000) * 1000)`.**
- [ ] **Step 2: Connect Aeron and wait for session READY and the first MD with positive bid, ask and last price.**
- [ ] **Step 3: Submit an IOC buy at `bestAsk + max(1.0, 1% of bestAsk)`; accept ACK followed by a positive fill; fail on a rest or reject.**
- [ ] **Step 4: Submit resting buy at 99% of best bid (at least 1.0 below the bid); wait for ACK; cancel immediately; wait for CANCELED.**
- [ ] **Step 5: Wait for fresh position long >= qty and fresh account snapshot.**
- [ ] **Step 6: Print one machine-readable line before success: `FASTTRADE_HEALTH sessionId=<id> epoch=<epoch> initialSessionHighWater=<seq> firstExecutionSeq=<seq> executionGap=<n> duplicateExecution=<n>`; then print `FASTTRADE_E2E_OK` and exit 0. Any timeout prints `FASTTRADE_E2E_FAIL` and exits 1. Capture `initialSessionHighWater` when the session first becomes READY, before sending any order.**
- [ ] **Step 7: Run `:fasttrade-smoke:installDist` on 190; expect PASS.**
- [ ] **Step 8: Commit.**

### Task 6: 190 E2E and restart

**Files:**
- Create: `tools/e2e-simvenue.sh`
- Modify: `docs/v1/access-architecture.md`
- Modify: `README.md` run instructions
- Modify: `docs/version-matrix.md` in `quantlink-deploy`

**Interfaces:**
- Consumes: SimVenue installDist at `/opt/quantlink-simvenue`, FastTrade installDist at `/opt/quantlink-fasttrade`.

- [ ] **Step 1: Verify `README.md` and `docs/v1/access-architecture.md` state SIM direct to SimVenue and LIVE direct to the contract-capable CTP adapter; no separate AccessRuntime process.**
- [ ] **Step 2: Remove or replace `/opt/quantlink-simvenue/state-e2e` before the first start; start SimVenue with `--stream-base 9000` and isolated `/opt/quantlink-simvenue/aeron-e2e`, state under `/opt/quantlink-simvenue/state-e2e`; verify its `VenueSession.lastSeqByStream` keys are `9001` and `9004`.**
- [ ] **Step 3: Run smoke; save its `FASTTRADE_HEALTH` line; expect `FASTTRADE_E2E_OK`.**
- [ ] **Step 4: Run smoke a second time with a different `--source-session-id`; expect position/account readable, a different session id/epoch from step 3, and `FASTTRADE_E2E_OK`.**
- [ ] **Step 5: Stop SimVenue; restart with the same state; run smoke. Assert the `FASTTRADE_HEALTH` line shows a new session id/epoch, `firstExecutionSeq == initialSessionHighWater + 1`, `executionGap == 0`, and `duplicateExecution == 0`; expect `FASTTRADE_E2E_OK`.**
- [ ] **Step 6: Confirm `quantlink-fin` remains running.**
- [ ] **Step 7: Record `fasttrade 0.1.1 + contract 0.1.8 + simvenue 0.2.0` in deploy matrix.**
- [ ] **Step 8: Commit both repos; push only if a remote exists.**

## Self-Review

- Session readiness, sequence gaps, restart and no-silent-drop each have a task.
- `AccessClientTest` covers session readiness, disconnected execution/MD, configured stream high-water keys, shared sequence, duplicate/gap and snapshots.
- Smoke verifies ACK, Trade, position, account, cancel, and two client runs.
- No AccessRuntime process is added; LIVE CTP adapter is future work and must speak contract directly.
- V1 docs are marked historical; SIM-direct and LIVE-ctp-direct do not contradict.
- Gradle wrapper is committed; no sibling repo is required.
- Build/test commands target 190 because local disk is constrained.

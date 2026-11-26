# Venue Contract v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish two independent v0.1 artifacts — `venue-contract-sbe` and `venue-contract` — containing only the canonical 9-message venue contract.

**Architecture:** Gradle multi-module library. `shared/sbe` owns generated SBE code with package `com.quantlink.contract.sbe`; `venue-contract` owns envelopes/codecs/guards with package `com.quantlink.contract.venue`; a separate `smoke-consumer` resolves the published artifact from `mavenLocal`.

**Tech Stack:** Java 25, Gradle 9.8.2 wrapper, SBE 1.35.6, Aeron 1.54.0, Agrona 2.1.0, JUnit 5.

**Spec:** `docs/superpowers/specs/2026-11-15-venue-contract-design.md`

**Field dictionary:** `docs/contract-fields.md`

## Global Constraints

```text
Group: com.quantlink.contract
Artifacts: venue-contract-sbe, venue-contract
Version: 0.1.0 (no SNAPSHOT for 190 acceptance)
Java toolchain: 25
SBE package: com.quantlink.contract.sbe
Contract package: com.quantlink.contract.venue
Canonical messages: Instrument, MarketData, OrderRequest, CancelRequest,
  OrderUpdate, Trade, PositionSnapshot, AccountSnapshot, VenueSession
No V1/V2 duplicates, no strategyId, no bookId, no publishTime,
  no replay*, no eventTime, no GatewayHealth.
No runtime handshake. No ContractMetadata. No schema hash.
quantlink-fin is out of scope.
Acceptance only on 190.
```

## Review Focus

- Removed V1/V2 messages must not remain in schema or generated code.
- `Trade` must carry `tradingDay` and `feeKnown`; `tradeId` must be non-empty; idempotency is `(venueId, accountId, tradingDay, tradeId)`.
- `OrderUpdate.sequence` is stream/session/epoch scoped, not a per-order gap promise.
- `OrderUpdate` and `Trade` share one execution stream per ORS/account and one `sequence`; do not split by message type.
- Unknown `clientOrderId` must be cached, not silently dropped.
- `OrderUpdate` carries `side`, `offsetFlag`, `orderQty`, `price`, and `errorCode`; trading `ResponseMsg` relies on these.
- `Trade` carries `offsetFlag`; trading `ResponseMsg.OpenClose` relies on it.
- `timeInForce` mapping is adapter-owned: `DAY -> GFD+AV`, `IOC/FAK -> IOC+AV`, `FOK -> IOC+CV`; the FastTrade adapter must test all four.
- `VenueSession` remains a pure trading-session message; no contract version fields.
- Published `venue-contract` POM must resolve `venue-contract-sbe`, and smoke-consumer must resolve both from `mavenLocal`.

---

### Task 1: Canonical SBE artifact

**Files:**
- Create: `settings.gradle.kts`
- Create: `build.gradle.kts`
- Create: `gradlew`, `gradlew.bat`, `gradle/wrapper/*` (copy from `../quantlink-fin`)
- Create: `shared/sbe/build.gradle.kts`
- Replace: `abi/sbe/quantlink-fin-sbe.xml`
- Create: `tools/gen_sbe.sh`
- Create: `shared/sbe/src/test/java/com/quantlink/contract/sbe/SbeCanonicalRoundTripTest.java`
- Delete: old copied V1/V2 tests and generated classes that are not in the 9-message set

**Interfaces:**
- Produces: Gradle project `:shared:sbe`
- Produces: package `com.quantlink.contract.sbe`
- Produces: canonical SBE encoders/decoders for the 9 messages
- Produces: `./gradlew :shared:sbe:test`

- [ ] **Step 1: Copy the Gradle wrapper**

```bash
cp ../quantlink-fin/gradlew .
cp ../quantlink-fin/gradlew.bat .
mkdir -p gradle/wrapper
cp ../quantlink-fin/gradle/wrapper/gradle-wrapper.jar gradle/wrapper/
cp ../quantlink-fin/gradle/wrapper/gradle-wrapper.properties gradle/wrapper/
```

Expected: `./gradlew --version` prints Gradle 9.8.2.

- [ ] **Step 2: Write the independent build**

`build.gradle.kts`:

```text
allprojects.group = "com.quantlink.contract"
allprojects.version = "0.1.0"
subprojects.java.toolchain.languageVersion = 25
JUnit Platform
slf4j-api 2.0.16
JUnit BOM 5.11.4 + junit-jupiter
```

`settings.gradle.kts`:

```text
rootProject.name = "quantlink-venue-contract"
include(":shared:sbe")
```

- [ ] **Step 3: Replace the schema with the canonical 9 messages**

Rewrite `abi/sbe/quantlink-fin-sbe.xml` using `docs/contract-fields.md`:

```text
package="com.quantlink.contract.sbe"
messages:
  Instrument, MarketData, OrderRequest, CancelRequest, OrderUpdate,
  Trade, PositionSnapshot, AccountSnapshot, VenueSession
```

Delete all V1/V2 duplicates and all non-contract messages listed in the field dictionary.  
Add `Trade.tradingDay` and `Trade.feeKnown`.  
Rename `counterpartyId` fields to `venueId`.

- [ ] **Step 4: Write the regeneration script**

`tools/gen_sbe.sh` must run:

```bash
java -jar "${SBE_JAR:-.tools/sbe-all-1.35.6.jar}" \
  -Dsbe.target.language=Java \
  -Dsbe.output.dir=shared/sbe/src/main/java \
  abi/sbe/quantlink-fin-sbe.xml
```

It must fail if the SBE jar is missing, not silently generate nothing.

- [ ] **Step 5: Regenerate and remove stale generated files**

```bash
rm -rf shared/sbe/src/main/java/com/quantlink/contract/sbe
./tools/gen_sbe.sh
```

Expected: only the 9 canonical SBE messages exist; no `*V2` classes.

- [ ] **Step 6: Write canonical SBE round-trip tests**

Create `SbeCanonicalRoundTripTest` with tests:

```text
instrumentRoundTrip
marketDataRoundTrip
orderRequestRoundTrip
cancelRequestRoundTrip
orderUpdateRoundTrip
tradeRoundTrip
positionAccountSessionRoundTrip
```

`marketDataRoundTrip` must assert `environment`, `lastTradeQty`, `lastTradeTime`, `turnover`, `exchangeTimestamp`, `ingestTimestamp`.
`instrumentRoundTrip` must assert `expiryDate` format and `callPut=NONE` for futures.
`positionAccountSessionRoundTrip` must assert PositionSnapshot `tradingDay`, `staleAfterMs`, `environment`, and AccountSnapshot/VenueSession `environment`.
`tradeRoundTrip` must assert non-empty `tradeId`, `tradingDay`, `feeKnown`, `offsetFlag`, `exchangeOrderId`, `sequence`, `exchangeTimestamp`, `ingestTimestamp`.
`orderUpdateRoundTrip` must assert `sequence`, `sourceSessionId`, `sourcePublicationEpoch`, `side`, `offsetFlag`, `orderQty`, `price`, `errorCode`, `tradingDay`, `cancelState`, `exchangeTimestamp`, `ingestTimestamp`.
`VenueContractConformanceTest` must verify `OrderUpdate` and `Trade` share one sequence and an unknown `clientOrderId` is cached, not dropped.

- [ ] **Step 7: Run SBE tests**

On 190:

```bash
JAVA_HOME=/usr/lib/jvm/java-25-openjdk \
  ./gradlew :shared:sbe:test --no-daemon
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 8: Commit**

```bash
git add settings.gradle.kts build.gradle.kts gradlew gradlew.bat gradle \
  abi/sbe shared/sbe tools/gen_sbe.sh
git commit -m "feat: add canonical v0.1 SBE contract"
```

### Task 2: Venue contract artifact

**Files:**
- Modify: `settings.gradle.kts` — add `:venue-contract`
- Create: `venue-contract/build.gradle.kts`
- Create: `venue-contract/src/main/java/com/quantlink/contract/venue/`
  - `AeronStreams.java`
  - `MarketDataCodec.java`
  - `MarketDataEnvelope.java`
  - `MarketDataMessage.java`
  - `OrderRequestEnvelope.java`
  - `CancelRequestEnvelope.java`
  - `OrderUpdateEnvelope.java`
  - `TradeEnvelope.java`
  - `PositionEnvelope.java`
  - `VenueSessionEnvelope.java`
  - `VenueExecutionCodec.java`
  - `VenueSessionCodec.java`
  - `VenueEnvelopeValidator.java`
  - `VenueContractGuards.java`
  - `FatalExecutionException.java`
- Create: adapted tests under `venue-contract/src/test/java/com/quantlink/contract/venue/`
  - `MarketDataCodecTest.java`
  - `VenueEnvelopeCodecTest.java`
  - `VenueEnvelopeValidatorTest.java`
  - `VenueContractConformanceTest.java`
  - `RecordedCtpOrderTradeFramesTest.java` + `ctp-order-trade.bin`

**Interfaces:**
- Consumes: `com.quantlink.contract.sbe` from `:shared:sbe`
- Produces: `AeronStreams`, codecs, envelopes, validator, guards
- Produces: `:venue-contract:test`

- [ ] **Step 1: Add the module**

```text
include(":shared:sbe", ":venue-contract")
```

- [ ] **Step 2: Write `venue-contract/build.gradle.kts`**

```text
plugins: java-library
api("io.aeron:aeron-client:1.54.0")
api("org.agrona:agrona:2.1.0")
api(project(":shared:sbe"))
implementation("io.aeron:aeron-driver:1.54.0")
```

No business module dependencies.

- [ ] **Step 3: Port and rename contract sources**

Copy the listed classes from:

```text
../quantlink-fin/backend/shared/aeron/src/main/java/com/quantlink/fin/aeron/
```

Change package to `com.quantlink.contract.venue`.  
Adapt imports to `com.quantlink.contract.sbe`.  
Remove V1 branches from `MarketDataCodec`; only canonical `MarketData` is accepted.  
Rename `OrderUpdateV2`/`TradeV2`/`CancelRequestV2` references to canonical names.  
Remove `eventTime` usage.

- [ ] **Step 4: Port tests**

Copy the listed conformance tests and change package/imports.  
Adapt recorded-frame expectations to canonical message names and fields.  
Delete any test that depends on `VenuePorts`, `AeronVenueMarketDataPort`, or V1 messages.

- [ ] **Step 5: Run contract tests**

On 190:

```bash
JAVA_HOME=/usr/lib/jvm/java-25-openjdk \
  ./gradlew :venue-contract:test --no-daemon
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 6: Commit**

```bash
git add settings.gradle.kts venue-contract
git commit -m "feat: add canonical venue contract envelopes"
```

### Task 3: Publish two artifacts and prove consumption

**Files:**
- Modify: `shared/sbe/build.gradle.kts` — add `maven-publish`, artifactId `venue-contract-sbe`
- Modify: `venue-contract/build.gradle.kts` — add `maven-publish`, artifactId `venue-contract`
- Create: `smoke-consumer/settings.gradle.kts`
- Create: `smoke-consumer/build.gradle.kts`
- Create: `smoke-consumer/src/main/java/com/quantlink/contract/smoke/ConsumerSmokeMain.java`
- Modify: `../quantlink-deploy/docs/version-matrix.md`

**Interfaces:**
- Produces: `com.quantlink.contract:venue-contract-sbe:0.1.0`
- Produces: `com.quantlink.contract:venue-contract:0.1.0`
- Produces: smoke consumer decoding `MarketData`

- [ ] **Step 1: Configure publication for both modules**

Both modules use:

```text
plugins: maven-publish
group = "com.quantlink.contract"
version = "0.1.0"
publication from components.java
```

Artifact IDs:

```text
shared/sbe       -> venue-contract-sbe
venue-contract   -> venue-contract
```

`venue-contract` POM must depend on `venue-contract-sbe`.

- [ ] **Step 2: Build and publish on 190**

```bash
JAVA_HOME=/usr/lib/jvm/java-25-openjdk \
  ./gradlew clean build publishToMavenLocal --no-daemon
```

Expected: both artifacts under:

```text
~/.m2/repository/com/quantlink/contract/venue-contract-sbe/0.1.0/
~/.m2/repository/com/quantlink/contract/venue-contract/0.1.0/
```

Use the same OS user that will build SimVenue and FastTrade.

- [ ] **Step 3: Create the independent smoke consumer**

`smoke-consumer/build.gradle.kts`:

```text
repositories { mavenLocal(); mavenCentral() }
dependencies {
    implementation("com.quantlink.contract:venue-contract:0.1.0")
    implementation("org.agrona:agrona:2.1.0")
}
```

`ConsumerSmokeMain` must:

```text
encode one MarketData frame
decode it through MarketDataCodec
assert instrumentId, venueId, seq, exchangeTimestamp
print CONTRACT_SMOKE_OK
```

Run:

```bash
cd smoke-consumer
JAVA_HOME=/usr/lib/jvm/java-25-openjdk ./gradlew run --no-daemon
```

Expected output: `CONTRACT_SMOKE_OK`.

- [ ] **Step 4: Verify dependency isolation**

```bash
./gradlew :venue-contract:dependencies --configuration runtimeClasspath
```

Expected: no `quantlink-fin`, `sim-exchange`, `sim-venue`, `control-plane`, `runtime`, `runtime-runner`.

- [ ] **Step 5: Update deploy matrix**

In `../quantlink-deploy/docs/version-matrix.md`, set:

```text
contract: 0.1.0
simvenue: pending
fasttrade: pending
fin: pending
```

Commit in the deploy repo separately.

- [ ] **Step 6: Commit contract repo**

```bash
git add shared/sbe/build.gradle.kts venue-contract/build.gradle.kts smoke-consumer
git commit -m "feat: publish venue contract 0.1.0 artifacts"
```

## Self-Review Notes

- Spec coverage: canonical 9 messages, two artifacts, 190-only acceptance, smoke consumer, fin out of scope.
- Removed: V1/V2, ContractMetadata, schemaHash, handshake, replay fields, bookId, strategyId, eventTime.
- Tests: canonical SBE round-trip, envelope codec/validator, sequence conformance, recorded CTP frames, smoke consumption.
- Type consistency: `com.quantlink.contract.sbe` for SBE; `com.quantlink.contract.venue` for contract classes.
- Cross-repo: deploy matrix is a separate commit in `quantlink-deploy`; fin is untouched.

## 0.1.4 Addendum: Codec Completion

The original 0.1.0 plan ported `VenueExecutionCodec` and `VenueSessionCodec` from the old
source, which only exposed decode methods. 0.1.4 closes that one-way gap.

Added:

```text
VenueExecutionCodec.encodeOrderUpdate
VenueExecutionCodec.encodeTrade
VenueSessionCodec.encode
```

Acceptance:

```text
all 9 canonical messages have encode -> decode round-trip tests
wrong templateId is rejected
missing required fields are rejected
```

The historical 0.1.0 steps above are unchanged.

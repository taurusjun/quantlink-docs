# SimVenue Independence Design

- Date: 2026-11-16
- Status: DRAFT — waiting for approval
- Repo: `quantlink-simvenue`
- Contract: `com.quantlink.contract:venue-contract:0.1.8`
- Old source: `quantlink-fin/backend/sim-exchange` + `quantlink-fin/backend/sim-venue`
- Old plan: [`docs/independence-plan.md`](../../independence-plan.md)

## Intent

Move SimVenue out of `quantlink-fin` into an independent simulated venue that
depends only on the published venue contract. The first version keeps the
existing matching, persistence, health and market-data behavior, but removes
the old V2 contract and old cross-repo paths.

This is a port plus cleanup, not a new exchange design.

## Goals

```text
independent Gradle build
Java 25
sim-exchange = pure matching library
sim-venue = one standalone process
contract 0.1.8 only
one execution stream
no V2 / deployment / fencing / route fields
VenueStore restart recovery
standalone 190 smoke
```

## Non-goals

```text
AccessRuntime
AccessSDK
TradeBot
CTP
multi-account
multi-venue
control-plane
quantlink-fin dependency
```

## Approaches

### A. Port both modules and clean them (chosen)

Copy `sim-exchange` and `sim-venue`, rename packages, replace the old
Aeron/SBE boundary with contract 0.1.8 codecs, delete duplicate gateway code.

- Fastest path to preserved behavior.
- Keeps existing matching and persistence tests.
- Cost: the old code must be scrubbed, not copied blindly.

### B. Rewrite a minimal SimVenue

Smaller code, but loses tested matching, snapshot, journal and health behavior.
Rejected for v0.1.

### C. Port only `sim-exchange`

Produces a matching engine, but no standalone venue process or contract
boundary. Rejected because it does not meet the SimVenue goal.

## Target Layout

```text
quantlink-simvenue/
├── settings.gradle.kts
├── build.gradle.kts
├── sim-exchange/
│   └── com.quantlink.simvenue.exchange
├── sim-venue/
│   └── com.quantlink.simvenue.venue
├── docs/
└── smoke/
```

`sim-exchange` has no Aeron or SBE dependency.  
`sim-venue` owns all Aeron/SBE/contract code.

## Cleanup Rules

Delete, do not port:

```text
SimExchangeAeronGateway
SimExchangeAeronMain
SimOrderCodec
P0EndToEndTest
P0AeronEndToEndTest
old MarketDataSubscriber / MarketDataPublisher wrappers
V2 messages
deploymentId / deploymentGeneration / orderEpoch / fencingToken / routeId
separate update/trade publications
```

There is exactly one runnable process: `sim-venue`.
`sim-exchange` is a library, not a second process.

Keep and adapt:

```text
SimExchange and its tests
SimFill / SimMarketData / order model records
VenueStore / VenueSnapshot
SimVenueMain
SimVenueGateway
SimVenueMarketDataGenerator
health file behavior
```

Package rename:

```text
com.quantlink.fin.sim   -> com.quantlink.simvenue.exchange
com.quantlink.fin.venue -> com.quantlink.simvenue.venue
```

## Contract Boundary

SimVenue uses these contract codecs:

```text
OrderRequestCodec.decode
CancelRequestCodec.decode

MarketDataCodec.encode
VenueExecutionCodec.encodeOrderUpdate
VenueExecutionCodec.encodeTrade
VenueSessionCodec.encode
PositionSnapshotCodec.encode
AccountSnapshotCodec.encode
```

Streams:

```text
MARKET_DATA       1001
ORDER_REQUEST     2001
CANCEL_REQUEST    2002
EXECUTION         2003   OrderUpdate + Trade, shared sequence
POSITION_SNAPSHOT 2004
ACCOUNT_SNAPSHOT  2005
VENUE_SESSION     2006
```

There is no separate order-update or trade publication.

These are contract defaults, not a shared-host requirement. On 190,
SimVenue must use its own Aeron directory and a separate stream namespace,
for example `--stream-base 9000` (`9001..9007`), so it does not collide with
the already-running `quantlink-fin` services on 1001/2001.

## SimVenue Config

Required:

```text
venueId
accountId
orsId
environment
aeronDir
snapshotFile
journalFile
healthFile
```

Generated once per process start:

```text
sourceSessionId
sourcePublicationEpoch
```

Optional:

```text
orderChannel / orderStream
cancelChannel / cancelStream
executionChannel / executionStream
mdChannel / mdStream
position/account/session channels and streams
instrument list: id / exchange / basePrice / tickSize / multiplier / marginRate
initial cash / fee rate
```

No `agentId`, `fencingToken`, `deploymentId`, `routeId`.

## Flows

### Market data

Market data must go through the contract. There is no in-process bypass.

```text
SimVenueMarketDataGenerator
  -> MarketDataEnvelope
  -> MarketDataCodec.encode
  -> MARKET_DATA stream
  -> SimVenueGateway subscribes to MARKET_DATA
  -> MarketDataCodec.decodeEnvelope
  -> SimExchange.updateMarketData
  -> match resting orders
```

- 5 levels, synthetic=true, source=SIM
- sequence per instrument
- one sourceSessionId/publicationEpoch for the process
- environment is required
- the gateway keeps the MD subscription and uses it as the only matching input

### Orders

```text
ORDER_REQUEST -> OrderRequestCodec.decode -> SimExchange.submit
CANCEL_REQUEST -> CancelRequestCodec.decode -> SimExchange.cancel
```

Validate venue/account/environment/session before matching.  
Reject wrong account/venue and stale request IDs explicitly.

### Execution

```text
SimExchange result
  -> OrderUpdateEnvelope -> VenueExecutionCodec.encodeOrderUpdate
  -> TradeEnvelope       -> VenueExecutionCodec.encodeTrade
  -> EXECUTION stream, one shared sequence
```

Unknown `clientOrderId` must not be dropped by consumers.

### Snapshots

```text
PositionSnapshotCodec.encode  -> POSITION_SNAPSHOT
AccountSnapshotCodec.encode   -> ACCOUNT_SNAPSHOT
VenueSessionCodec.encode      -> VENUE_SESSION
```

All snapshots carry:

```text
venueId / accountId / environment / tradingDay
snapshotId / source=SIM / staleAfterMs / snapshotTimestamp
```

Position snapshots have no batch-end sentinel. All rows in one batch share
`snapshotId` and `snapshotTimestamp`; consumers replace by instrument and
never mix different snapshot IDs.

`VenueSession` carries `orsId` and `lastSeqByStream` for MD and execution.
At startup both high-water marks are 0.

### AccountSnapshot CTP semantics

The account fields use the same meaning as CTP:

```text
balance       = CTP Balance / dynamic equity
available     = CTP Available
margin        = CTP CurrMargin
frozenMargin  = CTP FrozenMargin
commission    = CTP Commission
closeProfit   = CTP CloseProfit
positionProfit= CTP PositionProfit
deposit       = CTP Deposit
withdraw      = CTP Withdraw
```

SimVenue v0.1 uses a simple nominal margin model. It does not implement
CTP's option-seller margin formula.

Each internal instrument has:

```text
multiplier
marginRate
```

Formula:

```text
margin = sum(abs(netQty) * markPrice * multiplier * marginRate)
```

- `markPrice` comes from the current order book; fall back to `avgPrice`
  when no valid mark exists.
- `frozenMargin = 0`
- `available = balance - margin`
- `balance = cash + marketValue`
- `positionProfit = sum(netQty * (markPrice - avgPrice))`
- `closeProfit = realisedPnl`
- `commission = fees`

`marginRate` is SimVenue configuration, not a contract field. It must not
change `Instrument`, `AccountSnapshot`, or the contract schema.

If `available` becomes negative, publish it as negative and reject new
opening orders. Do not clamp it to zero.

An `available = cash` shortcut is not CTP-consistent and is not allowed.

### Persistence and health

Keep the current VenueStore snapshot + journal design.  
Remove old contract fields from the snapshot/order records.  
Health file remains JSON and reports sequence, gaps, connection state and
matching counters.

## Tests

Port and adapt:

```text
SimExchangeTest
VenueStoreTest
SimVenueGatewayTest
SimVenueGatewaySecurityTest
SimExchangeMarginTest
```

Add:

```text
SimVenueContractRoundTripTest
SimVenueMarketDataGeneratorTest
one execution stream / shared sequence test
restart recovery test
standalone smoke
```

Acceptance on 190:

```text
./gradlew clean build installDist
start sim-venue
health file exists
subscribe MARKET_DATA
send OrderRequest -> OrderUpdate ACK + Trade
receive POSITION / ACCOUNT / SESSION
restart and recover VenueStore
runtimeClasspath has no quantlink-fin
```

## Risks

| Risk | Handling |
|---|---|
| Old contract fields leak into new code | grep whole tree for V2/deployment/fencing/route |
| Two execution publications remain | one `EXECUTION` publication only |
| Market data sequence resets | persist/session metadata and publish epoch |
| Snapshot format changes | explicit snapshot version and restart test |
| Start-up session has no stream high-water marks | define session bootstrap rule before coding |

## What Is Left to the Builder

- exact CLI option names and defaults
- snapshot JSON field names and version
- how the first VenueSession is published during startup
- default instrument margin rates
- instrument list and trading-day source
- expected health-file thresholds

# T-059 P3 runtime / 1d verification

## Runtime scaffold

`IndicatorRuntime` + `ControlPlaneIndicatorClient` + `RemoteLeaseAuthority`:

```text
register engine
acquire lease/fencing
load catalog
apply delta
ACK APPLIED
heartbeat
renew/release
onEvent -> IndicatorEngine -> ValueStore
```

Unit test uses a local fake HTTP server, so it does not depend on 190.

## 1d

`IndicatorSpec` now accepts `1m` and `1d`.
`IndicatorEngine` uses `IndicatorState`:

```text
EMA(1m)     -> EmaState
DailyBar(1d)-> DailyBarState
```

Snapshot/restart carries `stateType` + `stateJson`.

Test:

```text
DailyBarIndicatorEngineTest
  dailyBarIsFirstClassIndicatorAndRestores PASS
```

## Still open

- production live/replay feed wiring
- journal PREPARED/APPLIED integration with engine
- ACK READY after first OK
- strategy gate

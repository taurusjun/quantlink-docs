# Indicator strategy gate

`IndicatorGate` pure decision:

```text
engine ACTIVE
lease active
lease tokenEpoch/fencingToken == value tokenEpoch/fencingToken
value status OK
value asOf within maxAge
-> allow open

REPLAYING / FENCED / LOST / WARMUP / STALE / token mismatch
-> deny open

close -> always allowed
```

Tests: `IndicatorGateTest` PASS.

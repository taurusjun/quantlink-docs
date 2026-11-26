# P3 deployment verification

## Engine

```text
systemd: quantlink-fin-indicator-engine
engineId: indicator-engine-simnow
counterparty: SIMNOW
input: Aeron 1100
lease: control-plane acquire/renew
catalog: EMA(13) au2612 1m
```

Live ValueKV observed:

```text
value=830.69
tokenEpoch=6
fencingToken=6
seq=5207
```

After simulated PITR/epoch bump:

```text
old tokenEpoch=6
new tokenEpoch=7
new value tokenEpoch=7 fencingToken=7
old epoch value invalid by lease/fencing
```

## 24h soak

Started `quantlink-fin-indicator-soak.service`; it appends engine status/value every 5 minutes to
`/var/log/quantlink-fin/indicator-soak.log`. Final 24h pass still pending elapsed time.

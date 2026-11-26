# T-059 P2 catalog/lease/ACK verification

Environment: 190 `quantlink_fin_shadow`, control-plane 2026-11-12.

## Catalog

```text
POST /api/v1/indicators
  indicatorId=ik1_m2h8qacq03g6cdec4gn4qx5a3t
  created=true
  catalogVersion=1

same POST
  same indicatorId
  created=false
  catalogVersion=1

GET /catalog/SIMNOW/delta?fromVersion=0
  one DELTA outbox row
  payload_sha256 non-empty
```

## Lease

```text
engine-a acquire -> ACTIVE tokenEpoch=1 fencingToken=1
engine-b acquire -> 409 lease is held by engine-a
engine-a renew -> ACTIVE
engine-a release -> released=true
```

## ACK

```text
APPLIED -> 200
READY -> 200 (upgrade)
REJECTED_RETRYABLE after READY -> 409
  ACK status cannot move backwards: READY -> REJECTED_RETRYABLE
```

## Engine registration

```text
engine-d / SIMNOW -> replayStreamId=9001 replayEpoch=4
engine-e / SIMNOW -> 409 counterparty already has engine engine-d
heartbeat -> ACTIVE
producer-lost -> latestFenced=0 (no latest row yet)
```

Test rows were removed after verification so the real engine can register cleanly.

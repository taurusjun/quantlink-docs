# 2026-11-12 190 log growth incident

## Symptom

`/var/log/quantlink-fin/agent-simvenue/deploy-PAIR-SIMVENUE-MW9C01BR.log`
grew from ~100MB to 1.2GB in minutes.

## Root cause

1. Old runtime-runner (2026-11-11) could not decode `MarketDataV2` (template 29);
   every frame threw `Invalid TEMPLATE_ID: 29`.
2. After the runner was replaced, the remaining growth was a different loop:
   reconciliation gate rejection logged a full stack trace on every pair tick.
3. Truncating an open log file did not help: the Java process kept the old file
   offset and recreated a sparse file.

## Fix

- Deployed runtime-runner with `MarketDataV2` decoder.
- Throttled reconciliation-gate logs in `PairSpreadRunner` and
  `RuntimeRunnerModeAwareOrderSink` to one line per 30s; no stack trace.
- Stopped the offending SimVenue runner, removed the open log, restarted agent.
- Also fixed CTP snapshot empty-set sentinel and `TradingMapper.findAccount`
  `balance/margin` projection so reconciliation can pass.

## Evidence

- log size after fix: ~1.3KB and stable
- `docs/evidence/T-060/20261112-190-deploy/verify.txt`

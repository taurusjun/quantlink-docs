# SimVenue 策略 PnL E2E（2026-11-13 18:47-18:50）

- 策略：`TEST-STRAT-PAIR-01`，deployment 7，SIMVENUE。
- 先修复：零仓 instrument 没有 `position_baselines` item，导致对账把成交后的平仓残行当 since-baseline。
  回退基线时间到最近 `position_snapshot_run.cutoff_at`。
- `simvenue-pnl.mjs` 验证：
  - `source=AGENT`
  - `markSource=SCOPED_TICK`
  - `stale=false`
  - `ag2612` 策略仓存在
  - 同一仓位 5s 内 PnL `13.133526342062396 → 4.421752060155995`
- 未使用 strategy-center 仓位兜底；runner 只使用本地 trade 归属。
- 测试期间 runner 仍会在 ACTIVE 模式自动加仓；验证后已 stop deployment 7 并 KILL runner，
  当前 `runtime_instances` 为 DOWN。E2E 默认不自动平仓，`QF_PNL_CLEANUP=1` 才尝试平仓。

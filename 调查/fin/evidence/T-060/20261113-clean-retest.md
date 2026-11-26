# 2026-11-13 SimVenue 干净重测

## 重置范围

- 停止 control-plane / indicator-engine / SimVenue / runtime agents / soak。
- `DROP SCHEMA public CASCADE`，重建 schema-shadow + t039-t059 migrations + seed。
- 清空 SimVenue `snapshot.json` / `journal.jsonl` / `health.json`。
- 补 accounts/venue_id、runtime_agents、ORS、T-060、indicator V2、月分区、operator。

## 结果

首次下单后：

```text
positions=0
position_ledger=2
venue=2
```

gate 仍失败，证明不是历史数据，是本地 read path bug。

修复后：

```text
3 笔 B2 成交 + 1 笔平仓 1
position_ledger long=6
positions long=6
venue long=6
venue reconciliation passed=true

策略单 TEST-STRAT-PAIR-01 两笔成交
strategy_positions long=2 source=LEDGER
```

撤单：`900000000003` `CANCELED`。
策略单 `900000000006` 和 `900000001000` `FILLED`。

## 修复

1. `SimVenueGateway` 每秒发布 `PositionSnapshotV2`，含 account/venue/source/snapshotId 和结束哨兵。
2. SimVenue position 使用独立 stream `2014`；control-plane 同时订阅 2006/2014。
3. `SimVenueReconciler` 本地侧改读 `position_ledger`。
4. `TradingController` 的平仓策略改读 `position_ledger`。
5. `VenueReconciliationRouter` 按 venueType/account 选择 reconciler，核心不再写死 `if SIMVENUE`。
6. runner 的 venueAvailable 判断去掉具体 venueId。
7. SimVenue 重启后 positions 由 2014 snapshot 写入，venue/ledger 一致。

## 仍未覆盖

- strategy_positions 只覆盖策略单；manual 单不写策略仓位，符合设计。
- 24h soak 继续运行。

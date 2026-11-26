# T-015 遥测接入证据（2026-11-08）

## 后端

控制面已创建异步 ClickHouse sink：

```text
TelemetryConfig
  AsyncTelemetrySink
  ClickHouseTelemetrySink
```

事件来源：

```text
MarketDataService       → market_data_ticks
AeronOrderUpdateConsumer→ order_events / trade_events
RunnerMetrics           → strategy_metrics
TelemetrySnapshotScheduler → account_snapshots / position_snapshots
```

## ClickHouse 实时计数

```text
market_data_ticks      55
order_events           19
trade_events            2
strategy_metrics       109
account_snapshots       4
position_snapshots      2
```

计数持续增长，`AsyncTelemetrySink`：

```text
written > 0
dropped = 0
queue = 0
```

## 控制面状态接口

```text
GET /api/v1/telemetry/status
runtime = TEST-STRAT-HEDGE-01 / TEST-STRAT-PAIR-01 / TEST-STRAT-OPT-01
clickhouse.enabled = true
```

## UI

Monitoring 页面已接入：

```text
Runtime p99 延迟
Aeron 队列 / 背压
ClickHouse 遥测写入数
WebSocket /ws/telemetry
```

桌面实机验证：

```text
monitor=true
hasP99=true
hasClickHouse=true
stillUnconnected=false
```

截图：`docs/evidence/T-023/desktop-monitor-telemetry.png`

网关健康也已写入：`gateway_health`，SimLocal 为 UP，SimNow/Shengli 为 DOWN。

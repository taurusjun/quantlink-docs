# T-015 Telemetry 与监控 — 阶段证据

- 日期：2026-11-06
- 状态：PASS

## ClickHouse

- 190 已安装 ClickHouse 26.10.3.7
- 服务 active，监听 127.0.0.1:8123
- 数据库：`quantlink_fin`
- 7 张表，全部 TTL 366 天

```text
account_snapshots
gateway_health
market_data_ticks
order_events
position_snapshots
strategy_metrics
trade_events
```

## SDK

- `backend/telemetry`
- `ClickHouseTelemetrySink`：HTTP JSONEachRow，无 JDBC 依赖
- 事件：行情/订单/成交/策略指标/网关健康/资金/持仓
- 单元测试通过

## 验证

```bash
./gradlew :backend:telemetry:test
```

## WebSocket / 告警

- `/ws/telemetry` 已注册，支持 ping/pong、广播
- `AlertEngine` 连续 N 次越限触发、连续 M 次恢复
- `AlertService` 广播 alert JSON
- 4 条规则：latency-p99-ms / queue-depth / available-funds / gateway-last-tick-age-ms

## 真实 ClickHouse 写入

```bash
QF_CLICKHOUSE_TEST=1 QF_CLICKHOUSE_HOST=127.0.0.1 QF_CLICKHOUSE_PORT=18123 \
  ./gradlew :backend:telemetry:test --tests '*ClickHouseIntegrationTest'
```

7 张表均写入成功：

```text
market_data_ticks 3
order_events 1
trade_events 1
strategy_metrics 1
gateway_health 1
account_snapshots 1
position_snapshots 1
```

## Runtime 接入

- `RuntimeEngine` 每 tick 写 `MarketDataTick`
- `AsyncTelemetrySink` 非阻塞队列 + 批量写入
- 队列满丢弃，不阻塞交易线程

## TTL

- 7 张表均为 `TTL toDateTime(ts) + INTERVAL 366 DAY`

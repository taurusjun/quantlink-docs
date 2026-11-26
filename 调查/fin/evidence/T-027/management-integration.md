# 模拟交易所接入管理系统

- 日期：2026-11-06
- 状态：PASS（进程内 Java SimExchange）
- 配置：`qf.sim.enabled=true`（默认，开发/测试）

## 链路

```text
Control Plane MarketDataService (SIM tick)
  → SimExchangeService 更新盘口
  → 手工单 API
  → SimExchange.submitOrder
  → orders / trades / positions 回写
  → /api/v1/portfolio/live
  → 前端驾驶舱 2s 刷新
```

## 实测

```bash
curl -u test_trader:test -H 'Content-Type: application/json' \
  -d '{"accountId":"TEST-001","instrumentId":"au2612","side":"B","price":900,"qty":1,"confirm":true}' \
  http://127.0.0.1:8080/api/v1/manual/orders
# {"clientOrderId":900000005,"status":"FILLED","filledQty":1,"simEnabled":true,"simAvgPrice":873.78}
```

数据库：

```text
orders: 900000005 FILLED filled_qty=1
trades: SIM-900000005-1 au2612 B 873.78 1
positions: au2612 long_qty=1 avg=873.78
```

组合：

```json
{"pnl":136324.18,"delta":-3044.34,"positions":[{"instrumentId":"au2612","netQty":1}]}
```

## 策略信号 → 影子单

`POST` 策略信号不会发真实单，只写 `shadow_orders`：

```json
{"strategy_id":"TEST-STRAT-OPT-01","instrument_id":"au2612","side":"B",
 "price":873.76,"qty":1,"signal":"WIDE_SPREAD_QUOTE","status":"SHADOW_RECORDED"}
```

API：`GET /api/v1/strategies/shadow-orders?limit=20`

## 注意

- 这是**进程内 Java SimExchange**，用于管理系统开发测试。
- C++ T-027 `SimulatedCtpSession` 是独立进程，用于 CTP Adapter 验收；两者暂未互连。
- 生产/真实 CTP 环境应设置 `QF_SIM_ENABLED=false`，手工单走 Aeron/CTP。

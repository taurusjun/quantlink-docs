# 模拟交易所 / 多执行场所切换

- 日期：2026-11-06
- 状态：PASS（SIM 可用；CTP 需 Aeron bridge）

## 管理面

顶栏新增「执行场所」下拉：

- `SIM`：进程内 SimExchange，即时成交
- `CTP`：真实 CTP Adapter 未接入，当前禁用
- `ORS-SIM`：已删除（不是设计组件）
- 选择结果保存在 `localStorage.qf_venue`，手工单/策略部署自动带 venue

API：

```bash
curl -u test_admin:test http://127.0.0.1:8080/api/v1/exchanges
```

```json
[
  {"id":"SIM","name":"模拟交易所","enabled":true},
  {"id":"CTP","name":"CTP / SimNow","enabled":false}
]
```

## SIM 手工单

```json
{"clientOrderId":900000021,"status":"FILLED","venue":"SIM",
 "filledQty":1,"simAvgPrice":873.80}
```

## CTP 未连接

```text
HTTP 422 CTP bridge not connected
```

接上 Aeron/ORS gateway 后，`CTP` 会自动变为 enabled。

## 策略 CANARY

`WIDE_SPREAD_QUOTE` 每 10 秒生成：

- `shadow_orders` 影子单
- `orders` 中 `source=strategy` 的 CANARY 模拟单

实测：

```text
900000023 au2612 OPEN filled=0 source=strategy venue=SIM
```

`qf.strategy.canary=true` 默认开启；生产可关闭。

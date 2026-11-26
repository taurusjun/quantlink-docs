# T-022 并行验证与对账 — 阶段证据

- 状态：DOING
- `backend/reconciliation` 已实现订单/持仓对账
- 差异类型：MISSING_OURS / MISSING_VENUE / FIELD_MISMATCH
- 3 个测试通过
- 控制面 API：`GET /api/v1/reconciliation/local`、`POST /api/v1/reconciliation/compare`

## 控制面验证

本地 6 笔订单、4 个持仓与相同 venue 快照对比：

```json
{"passed":true,"orders":{"ours":6,"venue":6,"differences":[]},"positions":{"ours":4,"venue":4,"differences":[]}}
```

```bash
./gradlew :backend:reconciliation:test
```

待完成：CTP 实盘成交导入、日报表、切换门禁。

## 2026-11-06 扩展

控制面对账现在覆盖：

- orders
- positions
- trades
- accounts（balance/available/margin/commission）

本地 4 单 / 4 持仓 / 2 成交 / 2 账户与 venue 快照对比：

```json
{"passed":true,"orders":{...},"positions":{...},"trades":{"ours":2,"venue":2,"differences":[]},"accounts":{"ours":2,"venue":2,"differences":[]}}
```

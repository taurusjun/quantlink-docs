# T-021 New ORS Core — 验证证据

- 日期：2026-11-06
- 状态：PASS（模拟）
- 测试：`./gradlew :backend:ors-core:test`

## 覆盖

- InstrumentRegistry：期货/期权、期权链排序、交易所索引
- AccountLedger：现金/手续费/保证金/持仓/已实现盈亏
- OrsCore：SHFE / CFFEX 多交易所路由
- OrsAeronGateway：Aeron MarketData + OrderRequest -> OrderUpdate/Trade
- 5 个测试通过

## 验收对照

| 验收 | 结果 |
|---|---|
| 期权合约可查询/订阅 | ✅ |
| 期货/期权订单路由 | ✅ |
| 持仓/资金一致 | ✅ |
| 健康/指标可观测 | ✅ `OrsCore.health()` |
| 真实 CTP 联调 | ⏳ 交易时段 |

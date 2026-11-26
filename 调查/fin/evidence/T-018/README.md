# T-018 交易驾驶舱/期权链 — 阶段证据

- 状态：PASS
- 已接 API：`/api/v1/positions`、`/api/v1/orders`
- 已有页面：驾驶舱指标、持仓、策略状态、期权链、报价 ladder
- 指标中心 `/indicators`：定义/最新值/阈值/数据龄；驾驶舱顶部 6 个指标卡
- 指标 API：`/api/v1/indicators`、`/{id}/history`、`/{id}/values`
- 已加入 ECharts 波动率微笑图（T-018）
- 未完成：真实行情 WebSocket 订阅、组合 Greeks 实时刷新

API 不可用时自动回退 mock，保证视觉基线可离线跑。


## 期权链交易员版

- Call/Put 双边：Bid/Ask/IV/Delta/Gamma/Vega/OI/Vol
- ATM 高亮、仅双边过滤、到期切换
- 点击 Bid/Ask 打开快捷下单 Drawer
- 快捷下单复用 `/manual/orders/preview` 风控预检
- 波动率微笑图保留

# v4 设计

- 状态：DRAFT（2026-11-26）
- 当前架构：`001-v4-architecture.md`
- Contract v4 方案：`002-contract-v4.md`
- ORS v4 实施方案：`003-ors-v4.md`
- ORS 基线比较：`ref/001-ors-baseline-comparison.md`
- 历史：`../v3/` 保留，不再作为实现基线

```text
TradeBot + 多策略
  -> ORS SDK（L1）
  -> Aeron
  -> ORS（公司 ORS 核心）
  -> CTP
```

核心边界：

```text
ORS 持有订单状态、RMS、账户/持仓和撤单语义
SDK 只做 Aeron、消息关联和 orderID
L2 取消
TradeBot 多策略和策略级订单视图保持不变
LocalAgent 数据获取待确认
```

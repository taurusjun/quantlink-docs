# T-058 指标生产者所有权（ARCHIVED）

- 状态：**ARCHIVED — 2026-11-12**
- 结论：本文旧方案不再实施。
- 现行设计：
  - P0 协议：`docs/architecture/adr/ADR-001-indicator-replay-contract.md`（APPROVED）
  - P1 协议：`docs/architecture/adr/ADR-002-indicator-p1-closure.md`
  - V1 背景：`docs/architecture/27-指标目录与Agent内存热加载.md`（P0 已 superseded）

## 不再实施的内容

以下旧模型全部废弃：

```text
PRIVATE / STRATEGY_GROUP 指标
indicator_defs.strategy_id 私有归属
每个策略 Runner 自己计算私有指标
旧 indicator_values / indicator_daily_history 迁移
控制面全局指标
跨柜台/跨交易所 pair
```

V1 实际模型：

```text
所有指标绑定 counterparty
同柜台指标共享，不存在策略私有指标
pair 指标同柜台/同交易所共享
IndicatorEngine 单 writer，运行期不读指标 DB
```

## 历史

旧的详细方案保留在 git history 中，仅用于追溯，不得作为实现依据。
如需查看，使用本文件在归档前的 commit。

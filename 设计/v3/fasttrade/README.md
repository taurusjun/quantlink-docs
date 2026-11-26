# v3 架构

- 状态：DRAFT（2026-11-26）
- 范围：L0-L6 逻辑分层、职责归属、依赖方向、状态所有权和失败边界
- 关联：
  - `001-layer-boundaries.md`
  - `ref/001-legacy-mapping.md`

## 文档定位

v3 只描述新系统的当前设计，不复述 v2 的历史冲突。

核心边界：

```text
L0 只提供 venue 访问和 venue facts
L1 只负责传输、序列和路由
L2 拥有通道订单状态、orderRef、预扣和 AUTO
L3 拥有策略意图和策略归属
AccountSnapshotService / LocalAgent / ReadModel 是旁路，不反写交易
```

## 与 v2 的关系

v2 继续保留为历史设计记录。v3 开始作为当前架构基线：

- v2 中 L3 图里的 `OrderRegistry / FillLedger` 归 L2；
- v2 中未决的 RMS 归属在 v3 定为独立 RiskService；
- v2 中 AccountSnapshot 的消费边界在 v3 固定；
- v2 没有 DataService；L4 LocalAgent 采集 Fact，L5 ReadModel 重建读模型。

## 待实现状态

代码实现状态不写进本目录的“设计”段落；实现差距放在各仓库的 plan / acceptance 文档。

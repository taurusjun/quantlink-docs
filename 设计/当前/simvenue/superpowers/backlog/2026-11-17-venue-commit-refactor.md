# VenueCommit 存储重构（Deferred）

- 日期：2026-11-17
- 状态：DONE（SimVenue 0.2.1）
- 目标版本：SimVenue 0.2.1
- 触发条件：需要崩溃一致性，或 FastTrade E2E 暴露出状态/回报不一致

## 为什么

当前持久化拆成多个文件：

```text
snapshot.json
snapshot.ids
snapshot.ids.journal
snapshot.outbox
```

订单状态、clientOrderId、execution outbox 不是同一次原子提交。崩溃窗口可能导致：

- 客户端看到成交，但 venue 状态丢失
- venue 状态存在，但 execution 回报丢失
- clientOrderId 已记录，但订单未持久化

## 目标设计

每次事件写一条 `VenueCommit`：

```text
VenueCommit {
  state: VenueSnapshot
  newClientOrderIds: [...]
  outboxFrames: [...]
  commitSequence: ...
}
```

顺序：

```text
apply exchange
  -> append VenueCommit atomically
  -> send outbox frames
  -> write ack marker
```

启动：

```text
load last complete VenueCommit
  -> restore state
  -> merge newClientOrderIds
  -> restore unacked outbox frames
```

## 必须删除

- `snapshot.ids` 独立写路径
- `snapshot.ids.journal` 独立写路径
- `snapshot.outbox` 独立写路径
- `VenueStore` 里分开的 snapshot/journal/outbox 逻辑

## 验收

1. crash injection: commit 后、send 前崩溃，重启补发。
2. crash injection: send 后、ack 前崩溃，允许重复但序号可去重。
3. crash injection: 订单接受后、状态写入前崩溃，不产生假重复。
4. 100,000 个 clientOrderId 下，每次事件写入量不随历史 ID 数增长。
5. `./gradlew clean test installDist` 和 190 smoke 通过。
6. 版本升级并更新 `quantlink-deploy/docs/version-matrix.md`。

## 不在本任务

- 不改变撮合规则。
- 不改变 venue-contract。
- 不引入数据库；先做单文件/WAL 方案。

## 当前进度

SimVenue 0.1.10 已包含：

- 有界 execution outbox
- outbox 持久化
- clientOrderId 增量日志
- health 中的 execution backlog

剩余的是把三套写入合并成一次原子 commit。

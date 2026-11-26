# 27 号指标目录文档第三轮独立架构复审

- 日期：2026-11-12
- 审查基线：`b4f4eb6`（doc 27 + `schema-indicator-v2.sql`）
- 前两轮：
  - `docs/reviews/2026-11-12-indicator-catalog-architecture-review.md`
  - `docs/reviews/2026-11-12-indicator-catalog-architecture-review-v2.md`
- 审查方式：独立只读，未修改文件、未执行 SQL
- 结论：**REJECT**
- 方向：**APPROVE**

## 1. 总体结论

本轮明显收敛：

- State 旁路线程创建：关闭
- 部署单元与 `1 Agent = 1 ORS`：关闭
- lease API + DB CAS：基本关闭
- asOf/heartbeat/STALE：关闭
- debug reset：关闭
- displayName 唯一性冲突：关闭
- heartbeat per-indicator：关闭
- ValueKV 清空 vs 墓碑：关闭
- 跨进程 ValueKV 协议：关闭
- pair 语义：关闭

剩余 3 个 P0：

```text
P0-A 生产者失联后，策略侧没有关门信号
P0-B warmup/回放没有 watermark 连续性证明
P0-C 期权链输入没有进入 key 的规范定义
```

以及 13 个 P1，其中 6 个是文档与 SQL 的直接冲突。

## 2. 前两轮问题关闭情况

### 2.1 第一轮 P0

| 编号 | 结论 |
|---|---|
| P0-1 key 身份/canonicalization | PARTIALLY CLOSED：JCS 与 BigDecimal 冲突；JSONB 不保 canonical bytes；option_chain 未进 canonicalSpec |
| P0-2 State 旁路线程创建 | CLOSED |
| P0-3 producer 部署/lease/fencing | PARTIALLY CLOSED：缺 RESTARTING 退出、token 跨 reset/PITR 单调、engine 注册/心跳 API |
| P0-4 asOf/heartbeat/STALE | CLOSED |
| P0-5 seq/epoch/副本失效 | PARTIALLY CLOSED：缺 latest/history 单调 guard、engine 崩溃 invalidate 路径 |
| P0-6 warmup/stateSnapshot | PARTIALLY CLOSED：artifact 只有 bars、to 固定、tick/1s replay 未定义、watermark 连续性无证明 |
| P0-7 期权链输入 | PARTIALLY CLOSED：缺 option_chain 身份、chain snapshot 持久化、IV Rank 日序列 |
| P0-8 cutover/调试重置 | CLOSED（范围变更） |

### 2.2 第二轮新 P0

| 编号 | 结论 |
|---|---|
| 新-P0-1 State 创建/回放越界 | CLOSED |
| 新-P0-2 部署单元与 1 Agent=1 ORS 冲突 | CLOSED |
| 新-P0-3 lease/fencing 不足 | PARTIALLY CLOSED |
| 新-P0-4 failover 状态交接 | PARTIALLY CLOSED |
| 新-P0-5 cutover 不可执行 | CLOSED（范围变更） |

### 2.3 第二轮 P1

| 编号 | 结论 |
|---|---|
| P1-1 key canonicalization | PARTIALLY CLOSED |
| P1-2 displayName 唯一性 | CLOSED |
| P1-3 状态机 | CLOSED |
| P1-4 heartbeat 粒度 | CLOSED |
| P1-5 ValueKV 墓碑 | CLOSED |
| P1-6 tick 零分配 | PARTIALLY CLOSED：仍写 `Set<indicatorId>`，drain/reject 与无丢 tick 冲突 |
| P1-7 跨进程 ValueKV | CLOSED |
| P1-8 outbox/签名/ACK | PARTIALLY CLOSED：snapshot ACK 不能入库，outbox 缺版本/重试 |
| P1-9 warmup artifact | PARTIALLY CLOSED |
| P1-10 期权链展开/订阅/IV Rank | PARTIALLY CLOSED |
| P1-11 pair 语义 | CLOSED |
| P1-12 binding 生命周期 | PARTIALLY CLOSED：DELETE 与 FK RESTRICT 冲突 |
| P1-13 operator SPI | PARTIALLY CLOSED：Registry 与 DB 投影权威未定 |
| P1-14 历史写入 | PARTIALLY CLOSED |
| P1-15 跨文档冲突 | PARTIALLY CLOSED：横幅已加，正文仍冲突 |
| P1-16 API/安全 | PARTIALLY CLOSED |
| P1-17 容量组合 | PARTIALLY CLOSED |

## 3. 新 P0

### P0-A 生产者失联后，策略侧没有关门信号

**问题**

- 文档承诺 engine 崩溃后“策略继续运行，但禁止新开仓”。
- `isFresh` 只看 `eventAsOf/lastInputAsOf/nextExpectedAt`。
- 日线 `nextExpectedAt` 是下一交易日收盘，engine 死亡后策略仍可能认为 `OK && fresh`。
- lease 过期后 engine 已死，无法“本地自 fence”。
- 心跳是 engine 级，但没有 engine liveness 消息给策略。

**影响**

`EMA(200,1d)` 在 10:00 为 OK，10:05 engine 被 kill；策略副本仍持有 OK，未来数小时可继续新开仓。

**建议**

- 增加 `VALUE_ENGINE_STATE` 消息：engineId、counterparty、producerEpoch、fencingToken、leaseExpiresAt、heartbeatAt、status。
- 策略 Runner 维护 `engineLease`。
- 新开仓 gate：`engineLease.active && producerEpoch 匹配 && now-heartbeat < threshold`。
- 控制面 lease sweeper 在 lease 过期时主动发布 `PRODUCER_LOST`。
- order gateway/risk 统一执行 gate。
- 补 T21。

### P0-B warmup/回放没有 watermark 连续性证明

**问题**

- warmup artifact 只有 bars，`to` 是生成时固定时间。
- tick/1s 没有 replay；snapshot 每 30s 写一次。
- 本地 bar/event cache 没有定义。
- “gap 可补齐才 OK”没有判定依据。
- 热加载时 artifact.to 到 apply 时刻之间的缺口没有强制回放。

**影响**

09:00 生成 warmup 到 08:55，09:30 apply；EMA 回放到 08:55，第一笔 09:30 tick 后直接 OK，08:55-09:30 的 35 根 bar 缺失。tick/1s 重启最多丢 30s，日线可能丢一天。

**建议**

- apply/restore 增加 `warmupTo` 和 `applyWatermark`。
- 必须回放 `[artifact.to, applyWatermark]` 才 OK。
- StateSnapshot 增加 per-input `lastProcessedInputSeq`。
- 行情流带 per-input 单调 seq；恢复时首笔 live seq 必须等于 snapshot seq+1。
- 定义本地 bar/event cache 路径、格式、保留期。
- tick/1s 无 replay 时不得直接 OK，必须显式 re-warmup。
- 补 T22。

### P0-C 期权链输入没有进入 key 的规范定义

**问题**

- canonicalSpec 只定义 instrument input。
- OptionChainInput 只有 selector。
- 编译后 input 增加 `chainSnapshotId/resolvedContracts`。
- 新 expiry/strike 会生成新 chain snapshot / catalog version。
- 文档又说 inputs 变化 -> 新 indicatorId。

**影响**

两种实现都错：

- resolvedContracts 进 spec：chain roll 后 indicatorId 变化，所有策略 binding 失效。
- 不进 spec：不同 resolvedContracts 共用一个 ID，state/warmup/refCount 无法区分。

**建议**

- canonical chain input 只包含 selector tuple。
- `resolvedContracts` 作为 catalog 派生元数据，不进 key。
- 新增 `indicator_chain_snapshot` 表。
- chain roll 时同一 indicatorId + catalogVersion+1；合约 state carry-over/新增 WARMUP/移除 close。
- 补 option_chain golden vectors 和 chain roll 测试。

## 4. 主要 P1

| 编号 | 问题 | 建议 |
|---|---|---|
| P1-01 | JCS 与 BigDecimal 冲突；JSONB 不保 canonical bytes | 存 `spec_canonical TEXT`；一种数字语法；golden vectors |
| P1-02 | lease RESTARTING 死状态；token 跨 reset/PITR 回绕 | 删除 RESTARTING 或允许 acquire；加 token epoch |
| P1-03 | snapshot ACK 无法入库；outbox 缺版本/重试 | delta_id 可空、request_id 唯一；加 catalog_version/retryable |
| P1-04 | timer 线程未绑定 producer | timer 只入队，producer 执行 onTimer |
| P1-05 | 订阅 refCount 单位错误 | subscriptionRef 按 instrument；routeRef 按 instrument+field |
| P1-06 | snapshot/history I/O 预算不成立 | snapshot 每秒预算、dirty、批量 fsync；历史默认 1m |
| P1-07 | 期权链 fanout 未限流 | 每链 coalescing 窗口；增量 IV/Greeks |
| P1-08 | IV Rank 日序列来源缺失 | `series` warmup artifact 或日序列表 |
| P1-09 | DELETE 与 FK RESTRICT 矛盾 | 明确软删除；硬删除由 retention job |
| P1-10 | reset runbook 与当前代码不可执行 | 停控制面 → SQL → 部署 V2 → seed operator → 启动 |
| P1-11 | latest/history 无单调 guard/去重 | token/seq guard；history 唯一键 |
| P1-12 | displayKey 不完备 | 追加 indicatorId 短 hash；包含 keySchemaVersion/input type |
| P1-13 | operator schema 权威未定 | Java Registry 权威；启动 upsert DB 投影；schemaHash 校验 |

## 5. SQL 与文档冲突

1. `indicator_latest/history` 缺 `catalog_epoch`。
2. ACK 缺 `request_id/retryable/applied_at`，`delta_id NOT NULL` 导致 snapshot ACK 无法插入。
3. warmup 表缺 `type/signature/key_schema_version`。
4. 无 `indicator_chain_snapshot` 表。
5. `indicator_id LIKE 'ik1_%'` 的 `_` 是通配符；未限制 26 位 Crockford。
6. SQL 守卫 `NOT LIKE '%_shadow'` 的 `_` 是通配符。
7. `RESTARTING` 只出现在 CHECK/状态机，无进入/退出路径。
8. `DELETE` 与 `indicator_latest/history/warmup` 的 `ON DELETE RESTRICT` 冲突。
9. `indicator_operator` 为空时 Builder 全部 `OPERATOR_NOT_FOUND`。
10. 当前 Java 代码仍写 `indicator_defs`；reset 后管理面 500。

## 6. 仍需决策

| # | 决策 | 建议 |
|---|---|---|
| D1 | 策略侧感知 producer 失联 | engine lease/heartbeat 广播 + 统一 order gate |
| D2 | warmup 连续性 | warmupTo/applyWatermark/per-input seq；tick/1s 要么 replay，要么不放 V1 热加载 |
| D3 | option_chain 身份/roll | selector 进 key；resolvedContracts 不进 key；chain snapshot 表 |
| D4 | canonical bytes | `spec_canonical TEXT`；JCS 或自定义语法二选一 |
| D5 | DELETE 语义 | 软删除 + retention purge |
| D6 | 历史采样/容量 | 默认 1m+状态变化；分区/保留 |
| D7 | 订阅 vs 路由单位 | CTP 按 instrument；路由按 instrument+field |
| D8 | timer 执行模型 | 只入队，producer 执行 |
| D9 | operator schema 权威 | Java Registry 权威；DB 投影 |
| D10 | token 跨 reset/PITR | token epoch/generation |
| D11 | engine 注册/心跳 API | register/heartbeat/deregister |
| D12 | reset runbook | 停旧 → SQL → V2 代码 → seed operator → 启动 |
| D13 | IV Rank 冷启动 | series warmup 或日序列表 |

## 7. 建议测试

- T21 engine 死亡后策略新开仓门禁
- T22 warmup 缺口/ tick 重启
- T23 期权链 roll / binding 不变
- T24 key golden vectors / JSONB round-trip
- T25 lease RESTARTING / reset token 回绕
- T26 instrument vs field refCount
- T27 timer 与 tick 并发顺序
- T28 value 重复/乱序/latest 回退
- T29 reset 脚本重复执行/守卫
- T30 snapshot ACK / outbox 重试
- T31 5000 合约链 fanout
- T32 20k snapshot/history 预算
- T33 DELETE vs binding 并发
- T34 reset 后 IV Rank 冷启动

## 8. 最终意见

```text
方向 APPROVE
文档 REJECT
```

剩余问题局部，不需要推翻整体架构。  
优先修：

```text
1. producer liveness / order gate
2. warmup watermark 连续性
3. option_chain 身份和 chain roll
4. SQL/文档字段冲突
5. reset runbook
```

本次审查只读，未修改文件、未执行 SQL。

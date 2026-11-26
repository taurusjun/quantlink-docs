# 27 号指标目录文档第二轮独立架构复审

- 日期：2026-11-12
- 审查对象：`docs/architecture/27-指标目录与Agent内存热加载.md`（commit `941afb9`）
- 上一轮评审：`docs/reviews/2026-11-12-indicator-catalog-architecture-review.md`（REJECT）
- 审查方式：独立只读复审，未修改文档或代码
- 结论：**REJECT**

## 1. 总体结论

方向正确，修订幅度很大，上一轮多数 P0 已有结构性答案。  
但仍有 5 个会直接导致错误实现的 P0：

```text
State 由旁路线程创建，违反 producer 独占
indicator engine 部署单元与“1 Agent = 1 ORS”冲突
lease/epoch 协议不足以防止双写
failover 没有状态交接，warmup 断点会产生错误 OK
cutover 仍不可执行
```

因此当前版本仍不能作为 V1 实施基线。

## 2. 当前代码事实基线

- `IndicatorDefMapper.java:11-16` 仍查询全部 `EMA/SPREAD`，无 counterparty/strategy/operator_version 过滤。
- `RuntimeRunnerMain.java:129-130` 仍为每个策略 Runner 创建 `IndicatorPublisher`。
- `IndicatorPublisher.java:84-96` 在 Runner 内加载定义。
- `IndicatorPublisher.java:239-272` 无值时仍发布 `value=0`，消息只有 `strategyId/indicatorId/value/timestamp/stale`。
- `IndicatorStreamConsumer.java:75-97` 按 `indicator_id` 直接入库，无 owner/epoch/seq 校验。
- `schema-shadow.sql:131-158` 的 `indicator_defs` 没有 `counterparty_id/key/operator_version/key_schema_version`。
- `indicator_values` 仍是 `ON DELETE CASCADE`。
- `RuntimeAgentMain.java:15-30` 当前 `runtime-agent` 是进程 supervisor，负责拉起 ORS 和策略 runner；`AgentServer` 只暴露 health/instances/ors，不是指标计算进程。
- `941afb9` 只改了 doc 27，T-058、doc 24、doc 22/23 没有同步。

## 3. 上一轮 P0 关闭情况

| 编号 | 结论 | 理由 |
|---|---|---|
| P0-1 key 身份 | PARTIALLY CLOSED | 已改为 canonicalSpec + hash + 不透明 ID；但 canonical JSON 标准、大小写、`keySchemaVersion`/`schema` 双轨、base32 长度、主数据规范化仍未定。 |
| P0-2 CatalogPlan/State | PARTIALLY CLOSED | 已拆分 Plan 和 StateStore；但 §10.5 又写“旁路线程创建新 key State”，违反 producer 独占，缺少 happens-before 和构造期/活跃期状态。 |
| P0-3 producer 部署/lease | PARTIALLY CLOSED | 已定义 engine/lease 字段；但与 doc 22 的“1 ORS = 1 Runtime Agent”冲突；缺 TTL、续约、CAS、lease API、旧 producer 自 fence。 |
| P0-4 asOf/heartbeat/STALE | CLOSED | 时间字段、heartbeat 不改 eventAsOf、freshness、timer 已补齐；剩余是状态矩阵/P1 细化。 |
| P0-5 seq/epoch/副本失效 | PARTIALLY CLOSED | 字段有了；但 seq 作用域、比较规则、重启/热加载重置、旧副本失效、RTO 未定义。 |
| P0-6 warmup | PARTIALLY CLOSED | warmupRef/APPLIED/READY 有了；但 URI 协议、artifact 格式、签名、刷新、接管补算未定义。 |
| P0-7 期权链 | PARTIALLY CLOSED | OptionChainInput 有了；展开责任、chain 版本、per-contract 订阅、25Δ 缺侧、IV Rank 历史未闭合。 |
| P0-8 cutover | PARTIALLY CLOSED | Phase 0-3 有了；缺 flag、旧 id 映射、shadow 对比、切换门槛、回滚 DDL。 |

## 4. 第二轮新 P0

### 新-P0-1 State 创建/回放越过 producer 线程

**证据**

- §3.3：State 只允许 producer 线程访问。
- §10.5：StateStore 只由 producer 线程拥有。
- §10.5 同节又写：

```text
1. 旁路线程解析/校验 delta，构建候选 CatalogPlan
2. 创建新 key 的 State
3. 将 apply 命令放入 producer 有界队列
4. producer 在两次 tick 之间消费命令
```

- §9.2 要求创建 State 后回放 bars/restore snapshot。

**影响**

State 在旁路线程被 `createState/restoreState/warmup` 访问，tick 线程随后直接使用；没有发布屏障和构造期/活跃期分离，会产生数据竞争或半初始化状态。

**建议**

定义 State 生命周期：

```text
CONSTRUCTING(side) -> READY(producer) -> ACTIVE -> CLOSED
```

只有 READY 后才允许 tick 访问。  
旁路线程只生成不可变 `PreparedSpec`/`WarmupArtifact`；`createState/restoreState/closeState` 由 producer 线程执行。  
若必须旁路回放，回放产物必须是不可变 `StateSnapshot`，由 producer 线程 restore，不能共享可变 State。

### 新-P0-2 部署单元与“1 Agent = 1 ORS”冲突

**证据**

- §2/§6.1：一个 runtime-agent 内可包含多个 `CounterpartyIndicatorEngine`。
- doc 22：`1 柜台 = 1 账户`、`1 账户 = 1 ORS`、`1 ORS = 1 Runtime Agent`。
- doc 14：`1 Runtime Agent 最多托管 1 个 ACTIVE ORS`。
- 当前 `RuntimeAgentMain` 是 supervisor，`AgentServer` 只暴露 health/instances/ors；`AeronMarketData` 连接本机 Aeron。

**影响**

按 doc 27 实现会出现：

1. engine 放在 supervisor，但 supervisor 没有行情订阅；
2. 一个 Agent 放多个 counterparty engine，但只能有 1 个 ACTIVE ORS，拿不到第二个柜台行情；
3. standby 只有 catalog/warmup，没有该柜台 CTP/ORS 行情，接管后无法计算。

**建议**

拆成三个对象：

```text
RuntimeAgentSupervisor
IndicatorEngineProcess
ORS / StrategyRunner
```

V1 建议每个 ACTIVE ORS/counterparty 一个独立 indicator engine 进程/模块，与 ORS 同机、共享该 ORS 的行情流。  
standby 要么同机 ORS 级热备并共享 md stream，要么定义为完整 ORS 切换并明确账户/登录迁移。

### 新-P0-3 Lease/fencing 仍不足以防止双写

**证据**

- `producer_epoch` 要求单调递增，但使用 ULID/UUID。
- 只有 lease 字段和状态名，没有 TTL、续约周期、CAS、lease API。
- `Agent 运行期不读 DB`，但 lease 表在 DB，未说明 Agent 如何访问。
- 消费端拒绝消息，不代表旧 producer 本地策略读不到自己的旧 ValueKV。

**建议**

- `producerEpoch` 只做身份/审计，不透明 ID 即可。
- `fencingToken` 用 DB sequence 分配的单调 long，消费端只按 token 排序。
- 增加控制面 lease service 或 DB CAS：

```text
acquire: UPDATE ... WHERE status IN ('STANDBY','EXPIRED') AND expires_at < now()
renew:   UPDATE ... WHERE lease_id=? AND fencing_token=?
release: 显式状态迁移 + 历史表
```

- active 每次发布前检查本地 fencingToken 是否仍为当前值。
- 续约失败超过阈值必须本地自 fence：停止计算、ValueKV 标记 PRODUCER_LOST、拒绝新开仓。
- 控制面分区时禁止新 lease；active 在 TTL 后自 fence。
- 明确 indicator lease 与 ORS fencing 的关系。

### 新-P0-4 Failover 没有状态交接

**证据**

- §6.3 接管流程只写“加载 warmup → 清空旧 ValueKV → 发布新 epoch”。
- warmup artifact 的 `from/to` 是生成时固定时间。
- 没有从旧 producer 获取 `stateSnapshot` 的协议。
- 没有 warmup.to 到接管时刻的补算。

**影响**

EMA(200,1m) 在 10:00 故障，warmup 只到昨天 15:00，新 producer 缺 10:00 前 bar，却可能收到第一笔 tick 后进入 OK。策略会在错误值上新开仓。

**建议**

两种接管：

- 优雅交接：active 释放 lease 前写 `StateSnapshot`（watermark/catalogVersion/operatorVersion/checksum）；standby restore 后从 watermark 回放到当前。
- 崩溃接管：加载最近 snapshot；没有 snapshot 则 warmup 回放到 `warmup.to`，再用本地历史/控制面补到接管时刻；补不齐保持 WARMUP/NO_DATA。

明确 RTO、最大可接受缺口、snapshot 保留个数、snapshot 与 warmup 优先级。没有 snapshot 时不允许直接 ACTIVE。

### 新-P0-5 Cutover 仍不可执行

**证据**

- §23 只有 Phase 0-3 名称。
- 当前控制面 `IndicatorEngine` 还在计算。
- 每个 Runner 仍有 `IndicatorPublisher`。
- `IndicatorPublisher` 仍发布 `value=0`。
- `IndicatorStreamConsumer` 仍按 id 入库。

**影响**

- Phase 0 shadow 无法对比：旧 `indicator_id` 与新 `indicatorId` 不同命名空间。
- Phase 1 无法安全停控制面：没有 flag、没有“Agent 已成为唯一 writer”的判定。
- Phase 2 没有旧 id→新 key 映射。
- 当前代码迁移期会双写。

**建议**

增加：

```text
indicator_id_map(old_id, new_indicator_id, counterparty_id, key_schema_version, status)
flag: indicator.agent.write.enabled
flag: indicator.control.compute.enabled
flag: indicator.read.source = OLD | NEW | SHADOW
shadow 对比任务：mismatch rate / age / status
cutover gate：连续 N 分钟 mismatch=0、catalog APPLIED、无旧 writer
rollback：先恢复 old read，再启控制面 writer，最后停 Agent writer
```

并给出 `indicator_defs/indicator_values/indicator_daily_history` 的 DDL/backfill 脚本。

## 5. 主要新 P1

1. **Key canonicalization 未定**：JCS/序列化、大小写、schema 双轨、base32 长度、主数据 ID、默认值、无序 input 排序、排除字段。
2. **displayName 唯一性冲突**：模板不含 `field/operatorVersion/timeframe`，`EMA(last)`/`EMA(mid)` 会 409；operator v1/v2 无法共存。
3. **状态机不完整**：`LOADED` 不在枚举；缺 trigger/guard/优先级；没有 `timeSource`；`nextExpectedAt` 计算未定义。
4. **heartbeat 粒度**：per-indicator heartbeat 会重写 20k value；`isFresh` 可能被 heartbeat/publishedAt 误判。
5. **ValueKV 清空 vs 墓碑冲突**：§6.3/§22 写清空，§10.2 要求 STOPPED 墓碑；`IndicatorValue` 没有 `removedAt`。
6. **tick 路径零分配矛盾**：`Set<indicatorId>`、`Double`、record 会分配；`localId` 跨 plan 不稳定。
7. **跨进程 ValueKV 协议缺失**：没有 snapshot-on-join、streamSeq、分片、缺口恢复、背压；runtime-runner 独立进程是同进程路径不成立。
8. **Outbox/签名/ACK 不足**：outbox DDL/重试/分区、delta 签名、ACK 幂等、snapshot ACK、PITR epoch 单调性。
9. **Warmup artifact 协议未定义**：`warmup://` 不可解析；`uri` 与内联 bars 权威不明；1d 无 warmup 是拒绝还是 WARMUP 两处冲突。
10. **期权链展开责任/订阅/IV Rank 未闭合**：Builder vs Agent、chain refCount、CTP per-contract 上限、25Δ 缺侧、sigma 循环、IV Rank 样本。
11. **Pair 语义**：field 是否一致、缺 leg NO_DATA/STALE、负 ratio、binding 同柜台约束。
12. **Binding 生命周期**：check-then-delete 竞态、FK、generation、readiness gate。
13. **Operator SPI 不完整**：缺 `closeState`；`OperatorSchema/StateSnapshot/TimerEvent/Emit/FreshnessPolicy` 未定义；控制面/Agent schema 权威未定。
14. **历史写入路径缺失**：20k×1Hz 采样/分区/保留、cascade 删除、epoch/key 列、回填。
15. **跨文档冲突未解决**：doc 24 仍写控制面全局指标；T-058 仍允许指标依赖和 pair 私有；doc 22/23 的 Agent 关系冲突；C++ tbsrc 是否在 V1 范围未定。
16. **API/安全缺口**：无列表/更新 API、无 lease/warmup API、HMAC 不是签名、无 keyId/轮换/防重放。
17. **容量组合约束不成立**：20k 指标 × 16 inputs = 320k 订阅 > 20k 订阅上限；期权链展开未计入。

## 6. 仍缺失的关键决策

| # | 决策 | 建议 |
|---|---|---|
| D1 | Indicator engine 的进程/部署单元 | 每 ACTIVE ORS/counterparty 一个 engine 进程/模块，supervisor 只管理 |
| D2 | 策略是否随 engine failover | 明确 V1 只做 engine 热备还是完整 ORS/策略切换 |
| D3 | lease authority 与分区策略 | 控制面 lease service + DB CAS；分区禁止新 lease，active TTL 后自 fence |
| D4 | epoch/token 类型与排序 | epoch 不透明 ID，token 单调 long；只按 token 排序 |
| D5 | failover 状态交接/RTO | stateSnapshot + watermark + 补算；补不齐保持 WARMUP |
| D6 | warmup artifact 传输/格式/刷新 | 定义 endpoint、压缩、签名、checksum、刷新、缓存 |
| D7 | 期权链展开责任 | Builder 展开 + chainSnapshotId + 重建触发 |
| D8 | 跨进程 ValueKV 协议 | snapshot-on-join + streamSeq + gap + backpressure |
| D9 | ValueKV 清空 vs tombstone | 原子替换预填充 tombstone 的 map |
| D10 | 状态/时间/日历矩阵 | 迁移表 + timeSource + nextExpectedAt + 交易日历 |
| D11 | 历史写入/采样/保留 | 1s/1m/close 采样、批量、分区、tombstone |
| D12 | binding 生命周期/readiness | FK + 事务 + generation + 统一 order gate |
| D13 | operator schema 权威/版本保留 | 共享 schema artifact + codeHash + 保留所有被引用版本 |
| D14 | C++ tbsrc 是否在 V1 范围 | Java-only V1，或定义 C++ bridge |
| D15 | cutover flag/映射/回滚 | flag + id_map + shadow 对比 + runbook |
| D16 | key canonicalization 标准 | JCS/固定 serializer + golden vectors + 主数据规范化 |

## 7. 建议补充的测试

在 T1-T18 基础上增加：

- T19 key golden vectors / 跨实现 byte-identical
- T20 displayName 冲突与 operator 版本共存
- T21 旁路 createState + 回放 + plan 切换 + 旧 localId
- T22 lease CAS/TTL/分区/旧 producer/本地读者
- T23 failover 状态交接/无 snapshot/warmup 缺口
- T24 warmup 404/超时/签名/缓存损坏/1d 无数据
- T25 期权链展开/chain roll/订阅上限/ATM 缺 strike/25Δ 单侧/IV Rank 样本
- T26 pair field/负 ratio/self-pair/缺 leg 状态/跨柜台 binding
- T27 outbox 重复/乱序/ACK 丢失/PITR epoch
- T28 跨进程 snapshot 分片/丢片/慢消费者/重连
- T29 20k 指标/320k inputs/5k chain/1k fanout/JFR 分配
- T30 删除 vs 绑定并发/旧 generation/WARMUP 启动/order gate
- T31 旧 id→新 key/双写/回滚/历史 cascade
- T32 重放旧 snapshot/delta/伪造 HMAC/key 轮换
- T33 迟到 tick/夜盘换日/节假日/session close/heartbeat

## 8. 最终意见

```text
方向 APPROVE
文档 REJECT
```

优先修：

```text
1. engine 部署单元与行情来源
2. State 生命周期 / producer 独占
3. lease/token/failover 状态交接
4. warmup 协议与补算
5. cutover flag/id_map/shadow/回滚
```

这五个问题不解决，开始编码会在并发、双写和故障切换上返工。

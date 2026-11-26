# 27 号指标目录文档独立架构评审

- 日期：2026-11-12
- 审查对象：`docs/architecture/27-指标目录与Agent内存热加载.md`
- 审查方式：独立架构师只读评审
- 结论：**REJECT**

## 1. 总体结论

“柜台级共享 + 版本化目录 + 内存 KV”的方向成立，但当前文档在以下三处存在自相矛盾或关键协议缺失：

```text
指标身份 key
Catalog / State 原子切换
producer 唯一性与 fencing
```

按当前文字实现，会出现：

- 不同指标生成相同 key
- 热加载导致全柜台指标重置
- 多个策略 Runner 同时发布同一个 key
- 重启后旧 seq/旧值覆盖新值
- 长周期指标无法热加载

因此当前文档不能作为实施基线。

## 2. 当前代码与设计的主要落差

| 能力 | 当前事实 | 定性 |
|---|---|---|
| 指标定义加载 | `IndicatorDefMapper` 查询全部 enabled EMA/SPREAD，无 counterparty/strategy 过滤 | 实现缺口 |
| 生产者 | 每个策略 Runner 各建一个 `IndicatorPublisher`，共用 INDICATOR 2012 流 | 实现缺口，单 writer 未定义 |
| 值发布 | 无值时发布 `value=0`，无 `seq/asOf/status/catalogVersion/producerEpoch` | 实现缺口 |
| 消费端 | 按 `indicatorId` 直接入库，无 owner/producer 校验 | 实现缺口 |
| DB schema | 无 `counterparty_id/key/operator_version/catalog_version/producer_id` | 实现缺口 |
| 策略绑定 | 当前在 `config_json.indicators`，文档假设 `strategy_indicator_binding` 表 | 实现缺口 |
| 控制面计算 | 仍有 `IndicatorEngine` 计算指标，与 doc 27 冲突 | 迁移缺口 |

## 3. P0 问题

### P0-1 key 身份规则与示例冲突

文档 §3 的格式没有 `operatorVersion`，但正文写“operatorVersion 参与 key”；示例中有的含 `field=last`，有的不含。

影响：

- `EMA(last)` 与 `EMA(mid)` 可能同 key
- EMA v1/v2 可能同 key
- 参数含 `|`、`,`、`=` 时破坏解析
- 策略绑定到错误指标或历史值混写

建议：

- 以唯一的 `IndicatorSpec` 为语义源，key 由 spec 派生
- key 包含：key schema version、counterparty、每个 input 的 exchange/instrument/field、operator、operatorVersion、timeframe、合并默认值后的 effective params
- 使用 canonical JSON + SHA-256 + base32 作为不透明 key
- 另存 `displayKey`，只用于展示
- 明确 input 顺序：有序算子保留顺序，无序算子排序，重复 leg 拒绝
- 补属性测试：参数顺序、13/13.0、1e-1/0.1、分隔符、大小写、默认值、operatorVersion、field

### P0-2 CatalogPlan 包含可变 State，COW 原子切换不成立

文档 §7.4 说新 plan 包含 `specs + routeIndex + states`，在途 tick 继续用旧 plan；但 §2.3 又说 State 可变、只由 producer 线程写。

只有两种实现，且都有问题：

1. 复用旧 state：旁路线程与 tick 线程竞争
2. 创建新 state：每次热加载重置所有窗口，所有指标 WARMUP

建议：

- `CatalogPlan` 只包含不可变的 specs + routeIndex + localIdMap
- `StateStore` 独立，只由 producer 线程拥有
- delta 进入有界命令队列，由 producer 线程在两次 tick 之间消费
- 同 key 复用 state；语义变更生成新 key；删除由 producer 线程释放
- 不要依赖“引用归零释放”；定义 plan 生命周期和 state close 责任

### P0-3 每个柜台一个 active producer 没有部署单元和 fencing

文档只写“Agent 一个 active producer”和“用 lease/fencing 保证唯一”，但没有：

- producer 是独立进程、Agent 内组件，还是策略 Runner 内对象
- lease 表、TTL、续约、fencing token
- `producerEpoch`
- 旧 producer 恢复后的拒绝规则

当前代码恰好是反例：每个策略 Runner 各建 publisher，共用一条流，消费端不校验 owner。

建议：

- 新增 `counterparty-indicator-engine`，每柜台一个 active 实例
- 增加 `indicator_lease`：lease_id, counterparty_id, agent_id, producer_epoch, fencing_token, expires_at
- 值、ACK、心跳都带 producerId + producerEpoch + fencingToken
- 消费端拒绝低 epoch 消息
- 明确 standby 是 compute-shadow 还是 load-only

### P0-4 asOf / heartbeat / STALE 语义未定义

`IndicatorValue` 只有 `asOf`；heartbeat 是否更新 asOf 未定义；没有 per-operator freshness；策略调用未定义的 `stale(v)`。

影响：

- heartbeat 更新 asOf 会让停止更新的指标永远“新鲜”
- 1 分钟 bar 天然比 tick 旧 60 秒
- 无行情时没有 timer，状态永远不会变 STALE

建议：

- 拆时间字段：`eventAsOf`、`lastInputAsOf`、`publishedAt`、`heartbeatAt`、`nextExpectedAt`
- heartbeat 不改 `eventAsOf`
- operator schema 声明 freshness 策略：tick/bar/daily/event 分别定义 maxAge
- status 加 reason：NO_TICK / WARMUP_INSUFFICIENT / INPUT_STALE / PRODUCER_LOST / DISABLED
- 提供 `isFresh(value, now)`，不让策略自己判断

### P0-5 重启/切换后 seq 重置，跨进程副本无失效机制

`seq` 没有 `producerEpoch`；新 producer 从 1 开始，消费端可能丢弃新值或保留旧值。

建议：

- `(producerEpoch, seq)` 作为值版本
- epoch 由 lease 单调分配，重启/切换递增
- 跨进程副本 snapshot-on-join + heartbeat/lease timeout
- epoch 变化时清空旧值并重新拉快照
- 定义切换 RTO，期间策略只允许平仓

### P0-6 新增指标 warmup 来源未定义

新增 EMA(200, 1d) 无法只靠实时行情在当天可用；本地 warmup 历史新 key 没有。

建议：

- catalog snapshot/delta 携带 warmup 数据或 `warmupRef`
- 或明确 Agent 有本地历史库，并单独同步
- ACK 拆 `APPLIED` 和 `READY`
- Operator 增加 snapshotState/restoreState
- V1 明确支持的热加载 timeframe；日线暂不支持则排除

### P0-7 期权链输入模型缺失

`inputs` 只有单合约，无法表达“au2612 所有行权价/到期”的期权链；ATM IV、25Δ RR、IV Rank 无法实现。

建议：

- 增加 `InstrumentInput` 与 `OptionChainInput`
- OptionChainInput 含 underlying/expiry/strikeSelector/callPut/field
- RouteIndex 加载时展开为具体期权合约
- 订阅管理器做 chain 级引用计数和上限
- 若 V1 不做 OPT，明确排除并同步 T-058

### P0-8 控制面与 Agent 双生产者迁移未定义

doc 27 说控制面不计算指标；doc 24 仍写“控制面（全局指标）流式计算”；当前控制面仍有 IndicatorEngine。

影响：

- 迁移期同一个 indicator 有两个生产者
- 管理页显示两个值，策略读到哪个取决于最后写入

建议：

- 增加 cutover 章节
- feature flag：shadow read -> agent write only -> control-plane compute disabled -> old path removed
- 旧 indicator_id 到新 indicator_key 的迁移脚本
- 禁止双写的开关和回滚方案

## 4. P1 问题

1. `catalogVersion` 作用域和序列来源未定义：全局 vs 按柜台；DB 恢复后版本回退。
2. Delta 没有 checksum；ACK 不能证明应用了什么；重复/乱序 ACK 未定义。
3. last-known-good catalog 文件格式、原子写、损坏恢复未定义。
4. 缺少 timer/clock：bar close、session close、STALE 检测、heartbeat 不会发生。
5. 指标依赖图与拓扑排序缺失；T-058 允许指标依赖其他指标，doc 27 无表达。
6. 路由热更新与订阅增删没有责任模型；CTP 订阅上限、退订、缺失 leg 未定义。
7. Pair 的交易所维度、leg 顺序和可见性未定义；顶层 exchange 与 per-input exchange 冲突。
8. `strategy_indicator_binding` 表不存在；删除保护没有事务边界。
9. 历史表会丢审计/混版本；删除 cascading 删历史。
10. 多 Agent lease/fencing 只有原则，没有状态机。
11. 内部目录接口无认证；checksum 不是签名；创建/删除权限缺失。
12. 容量与性能没有数字和上限；全量载入可能 OOM。
13. operatorVersion 升级会让旧 key 全部失效，没有兼容策略。
14. STOPPED 墓碑语义不完整；删除后 ValueKV 条目是否保留未定义。
15. 跨进程值分发没有 snapshot-on-join、gap recovery、背压。
16. API 用可读 key 做 URL path；displayName 唯一性和可编辑性矛盾。

## 5. 缺失的关键决策

| # | 决策 | 当前状态 | 建议 |
|---|---|---|---|
| D1 | catalogVersion 全局还是按柜台 | 两种迹象都有 | 按 counterparty 单调 + catalogEpoch |
| D2 | producer 部署单元 | “Agent”含义不明 | per-counterparty indicator-engine |
| D3 | lease 来源 | 只有原则 | 独立 indicator_lease 或复用 ORS lease |
| D4 | standby 是否计算 | “可加载不发布” | 明确 compute-shadow 或 load-only |
| D5 | warmup 数据来源 | 只说 warmup | catalog 带 bars/ref 或本地历史库 |
| D6 | asOf/freshness | 只有一个 asOf | 拆分 event/published/heartbeat/lastInput |
| D7 | key 可读串还是 hash | doc 27 可读，T-058 两说 | 不透明 hash 身份 + displayKey |
| D8 | 期权链输入 | 只有 instrument | OptionChainInput 或 V1 排除 OPT |
| D9 | 指标能否依赖指标 | T-058 允许，doc 27 无表达 | V1 禁止或加 INDICATOR input |
| D10 | 策略绑定存哪里 | 文档假设表，代码 config_json | 新 binding 表 + 部署快照 |
| D11 | 跨进程值分发 | 只说快照/增量 | snapshot-on-join + streamSeq + 背压 |
| D12 | 历史写入频率 | 未定义 | 热路径 Aeronom，历史按 1s/1m 采样 |
| D13 | 安全模型 | 内部接口无认证 | mTLS + 签名 + RBAC + 配额 |
| D14 | 旧 IndicatorEngine 如何退场 | 未定义 | 单写切换、feature flag、禁止双写 |
| D15 | 资源上限 | 无 | 每 Agent 指标/输入/窗口/订阅/内存硬上限 |
| D16 | 控制面长时间不可用 | 只说 LKG | catalogMaxAge，超龄禁止新开仓 |

## 6. 建议补充的测试矩阵

| # | 类别 | 场景 | 期望 |
|---|---|---|---|
| T1 | Key | 参数顺序、13/13.0、分隔符、大小写、默认值、operatorVersion、field | 语义相同 key 相同；不同 key 不同 |
| T2 | Key | pair leg 顺序、重复 leg、不同 exchange、ratio=0/负/NaN | 按 schema 接受或拒绝 |
| T3 | Catalog | 重复 delta、旧 delta 后到、版本跳跃、checksum 损坏 | 幂等；旧不覆盖新；拉全量 |
| T4 | Catalog | snapshot 部分非法、operator 缺失、key/spec 不一致 | 保留旧 plan，ACK REJECTED |
| T5 | 原子切换 | tick 风暴中新增/删除/改参 | 无丢 tick、无半更新、无全量 WARMUP |
| T6 | Warmup | 新增 1m/1d EMA、无历史、文件损坏 | APPLIED/READY 正确；长周期拒绝或预置 |
| T7 | Producer | 两个 active、lease 过期、旧 producer 恢复、standby 提升 | 只有当前 epoch 被接受 |
| T8 | 重启 | kill -9 在 catalog/warmup 写入中、seq 重置 | 状态可恢复；副本不保留旧 OK |
| T9 | 新鲜度 | 无 tick、迟到/乱序 tick、bar close、session close、heartbeat | 状态正确；heartbeat 不改 eventAsOf |
| T10 | 路由 | 同合约多柜台、同柜台多交易所、pair 缺 leg、期权链、订阅超限 | 不跨柜台泄漏；状态明确 |
| T11 | 跨进程 | 晚启动、丢增量、重复增量、重连、背压 | snapshot-on-join；可恢复 |
| T12 | 控制面 | 无 LKG、控制面宕机、DB 版本回退、ACK 丢失 | fail closed 或 LKG + 告警 |
| T13 | 并发 | 删除 vs 绑定 vs 部署；catalog 变更 vs tick | 无竞态；删除 409 |
| T14 | 安全 | 未认证 catalog push、伪造 producer、越权创建 | 拒绝并告警 |
| T15 | 性能 | 10k/50k 指标、期权链 50k、tick 突发 | 内存/延迟在预算内 |
| T16 | 迁移 | 旧 indicator_id、控制面引擎停用 | 旧策略可运行；无双写 |

## 7. 文档改写建议

按顺序：

1. §1/§2：定义 Agent 部署单元、V1 范围（是否含 OPT、跨交易所 pair、指标依赖）
2. §3：重写 key 为 canonical spec + 不透明 hash；统一所有示例
3. §4：画真实进程/线程边界和 producer/lease
4. §5/§6：LKG 格式、启动状态机、catalogVersion 作用域、delta checksum
5. §7：新增/修改/删除/禁用/改名状态机；APPLIED vs READY；state carry-over
6. §8：补 timer/bar close/STALE sweep/期权链/订阅管理/依赖图
7. §9：拆时间字段、heartbeat 语义、状态优先级、墓碑、epoch/seq
8. §10/§11：binding 表、部署 generation、pair 交易所/顺序/ratio 校验
9. §13：lease 状态机、standby 模式、切换 RTO、双写禁止
10. §14：给出 sizing 数字和硬上限
11. §15：选定 Aeron 或 HTTP+WS；认证/幂等/错误码
12. §18：改成可执行的故障注入/并发/重启/性能验收

## 8. 最终意见

```text
方向：APPROVE
文档：REJECT
```

在 P0-1 ~ P0-7 改写完成、P0-8 补迁移顺序之前，不建议开始编码。  
否则 key、state 生命周期和 producer 所有权会在实现中反复返工。

本次评审未修改任何代码或设计文档。

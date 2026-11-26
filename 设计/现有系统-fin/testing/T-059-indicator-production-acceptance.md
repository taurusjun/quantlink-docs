# T-059 指标生产验收测试矩阵

- 状态：**DESIGN — 测试评审 CHANGES REQUIRED，暂不可执行**
- 日期：2026-11-12
- 关联计划：`docs/tasks/T-059-indicator-production-plan.md`
- 测试评审：`docs/reviews/2026-11-12-t059-test-review.md`
- 设计依据：ADR-001 / ADR-002 / ADR-003
- 环境约定：
  - schema/DB：`*_shadow`，禁止在生产库执行
  - 柜台：`SIMNOW`
  - 交易所：`SHFE`
  - 合约：`au2612`
  - 指标：`EMA(1m, period=13)`
  - Archive 真实 golden：recording `1021`

> 每个 Case 的“期望”是验收断言；没有证据（日志/截图/SQL/测试报告）不算通过。

## Phase 0：冻结与基线

| ID | 级别 | 类型 | 前置 | 步骤 | 期望 |
|---|---|---|---|---|---|
| T059-P0-01 | P0 | unit | operator 源码/构建产物 | 两次生成 operator manifest | 同一 code/version 的 `codeHash/schemaHash` 字节级一致 |
| T059-P0-02 | P0 | unit | 两个 manifest 文件 | 修改构建产物后重算 | `codeHash` 变化；版本不匹配必须拒绝 |
| T059-P0-03 | P0 | integration | 测试 fixture | 生成 au2612 1m EMA(13) canonical spec | builder 与 engine 得到同一 `indicatorId` |
| T059-P0-04 | P0 | integration | 两个 instrument 同 session 的 fixture | 生成 spec/seq fixture | 不出现跨 instrument seq 碰撞 |
| T059-P0-05 | P1 | doc/ops | 190 Archive | 记录 recording 1021 元数据 | fixture 中 recordingId/from/to/session/seq 可复现 |

退出标准：manifest 可重复、fixture 固定、indicatorId 一致。

## Phase 1：schema shadow

| ID | 级别 | 类型 | 前置 | 步骤 | 期望 |
|---|---|---|---|---|---|
| T059-P1-01 | P0 | schema | 非 `_shadow` 库 | 执行 schema 脚本 | 在 `BEGIN` 前拒绝，库不变 |
| T059-P1-02 | P0 | schema | `_shadow` 空库 | 执行 schema reset 两次 | 第二次可重复成功；无残留旧表 |
| T059-P1-03 | P0 | schema | schema 已建 | 插入相同 `(counterparty,catalog_version)` 两行 outbox | 第二行唯一键失败 |
| T059-P1-04 | P0 | schema | outbox 已建 | 插入 ACK `READY -> APPLIED` | trigger 拒绝状态回退 |
| T059-P1-05 | P0 | schema | ACK 已建 | 插入 `REJECTED_FINAL -> APPLIED` | trigger 拒绝 |
| T059-P1-06 | P0 | schema | latest 已建 | 写 `source=CONTROL,status=OK` | CHECK 拒绝 |
| T059-P1-07 | P0 | schema | latest 已建 | 写 `source=PRODUCER,status=PRODUCER_LOST` | CHECK 拒绝 |
| T059-P1-08 | P0 | schema | engine 已建 | 同 stream 插入两个非 RECLAIMABLE engine | partial unique 拒绝 |
| T059-P1-09 | P0 | schema | engine 已建 | RECLAIMABLE 后同 stream 新 epoch 插入 | 成功；旧 epoch 仍不可复用 |
| T059-P1-10 | P0 | schema | history 已建 | 调 `ensure_indicator_history_partitions(2)` | 当前月+2 月分区存在，default 保留 |
| T059-P1-11 | P0 | schema | default 已有目标月数据 | 再 ensure 同月分区 | 明确报错并给 runbook，不静默迁移 |
| T059-P1-12 | P1 | schema | history 分区 | 跨月写 history | 数据进入对应 YYYYMM 分区 |

退出标准：所有约束/trigger 正反向通过；重复 reset 成功；分区脚本可执行。

## Phase 2：control-plane catalog / lease / ACK

| ID | 级别 | 类型 | 前置 | 步骤 | 期望 |
|---|---|---|---|---|---|
| T059-P2-01 | P0 | integration | operator manifest 已注册 | 创建 EMA(13) | 返回 indicatorId；outbox DELTA 一行；catalogVersion+1 |
| T059-P2-02 | P0 | integration | 同 canonical spec | 再次创建 | 复用同一 indicatorId；不新增第二条指标 |
| T059-P2-03 | P0 | integration | 已有 indicator | PATCH displayName | indicatorId 不变 |
| T059-P2-04 | P0 | integration | 已有 indicator | 修改 period=21 | 生成新 indicatorId，旧指标保留 |
| T059-P2-05 | P0 | integration | 有 strategy binding | DELETE indicator | 409，不删除 |
| T059-P2-06 | P0 | integration | engine 在线 | 下发 DELTA | ACK APPLIED；RouteIndex 插入且非 routable |
| T059-P2-07 | P0 | integration | ACK 丢失 | 同 requestId 重发 | 只更新原 ACK，不插第二行 |
| T059-P2-08 | P0 | integration | REJECTED_RETRYABLE | 修复后同 requestId 重试 | 可升级 APPLIED；不回退 |
| T059-P2-09 | P0 | integration | REJECTED_FINAL | 再次发送同 requestId | 拒绝升级 |
| T059-P2-10 | P0 | integration | outbox PUBLISHED | 超时未 ACK | 回到 PENDING；attempts 增加 |
| T059-P2-11 | P0 | integration | 两个 engine | 同时 acquire | 只有当前 fencing 的 engine 能续约/发布 |
| T059-P2-12 | P0 | integration | catalogEpoch E1->E2 | 恢复/重建 | tokenEpoch bump；旧 lease FENCED；旧值失效 |
| T059-P2-13 | P0 | chaos | 旧 producer 存活 | 控制面写 PRODUCER_LOST | 旧 producer 同 epoch 不能写回 OK |
| T059-P2-14 | P0 | integration | 两个 engine | 注册 replay grant | replay_stream/epoch/session 各不相同 |

退出标准：catalog/outbox/ACK/lease 全链路通过；旧 epoch/fencing 全部拒绝。

## Phase 3：IndicatorEngine runtime

| ID | 级别 | 类型 | 前置 | 步骤 | 期望 |
|---|---|---|---|---|---|
| T059-P3-01 | P0 | e2e | 真实 recording 1021 | hot add EMA(13) | replay 最后一帧 included；`lastFrameEnd == to` |
| T059-P3-02 | P0 | e2e | 真实 recording 1021 | 校验 frame length | `frameLength != payloadLength`；nextPosition 正确 |
| T059-P3-03 | P0 | chaos | applyCut PREPARED 后 | kill -9 重启 | 同 applyId 续跑，不生成新 cut |
| T059-P3-04 | P0 | chaos | replay 中 | kill -9 重启 | 恢复后 state 与连续运行一致 |
| T059-P3-05 | P0 | chaos | state durable 前 | 崩溃 | 恢复时重建 state |
| T059-P3-06 | P0 | failure | APPLIED 但 state 缺失 | 重启 | 强制重建，不幂等跳过 |
| T059-P3-07 | P0 | failure | journal 尾 torn | 启动 | 截断最后完整 offset，前面记录保留 |
| T059-P3-08 | P0 | failure | 中间 CRC 错 | 启动 | fail closed，不跳过 |
| T059-P3-09 | P0 | e2e | live image 可用 | 订阅 live 后捕获 cut | replay 与 buffer 无丢无重 |
| T059-P3-10 | P0 | e2e | live 在 cut 后可用 | 触发 barrier | WARMUP/REJECT，不静默继续 |
| T059-P3-11 | P0 | e2e | 两 contract 同 session seq=1 | 回放/实时去重 | 不碰撞；按 instrument 分桶 |
| T059-P3-12 | P0 | e2e | 42->43 队列有 pre-cut tick | hot add | 新指标不接收 pre-cut tick，旧指标不丢 |
| T059-P3-13 | P0 | e2e | 多 input pair | 旧 plan drain | 每个 input lastSeq 独立，不互相误判 |
| T059-P3-14 | P0 | e2e | 新 input 不在 cut | hot add | 从 replay 起点初始化，不沿用其他 input seq |
| T059-P3-15 | P0 | e2e | snapshot 含 partial bar | 重启 | replay 从 `nextPosition` 开始，不重复切点 |
| T059-P3-16 | P0 | e2e | archive gap | 恢复 | WARMUP，不能把 gap 当连续 |
| T059-P3-17 | P0 | e2e | publisher restart P2 | live barrier | 新 epoch seq=1 不被当重复；旧 epoch 拒绝 |
| T059-P3-18 | P0 | e2e | 两个 engine | 同 stream 尝试 | 只能订阅各自 grant；旧 replay session 丢弃 |
| T059-P3-19 | P1 | unit | 1m bar builder | 跨分钟 tick | bar close 时间/EMA 更新正确 |
| T059-P3-20 | P1 | e2e | 删除/禁用指标 | catalog 变更 | RouteIndex 移除；tombstone STOPPED |

退出标准：D1 golden、kill -9、live barrier、pre-cut tick、多 input 全部通过。

## Phase 4：Value / 策略 gate

| ID | 级别 | 类型 | 前置 | 步骤 | 期望 |
|---|---|---|---|---|---|
| T059-P4-01 | P0 | integration | engine ACTIVE | 发布 VALUE_DELTA | control-plane 写 latest/history；策略读到 OK |
| T059-P4-02 | P0 | perf | 高频 tick | producer 更新 | engine 不做 DB I/O；tick 不阻塞 |
| T059-P4-03 | P0 | concurrency | 队列满 | 连续更新同 key | latest generation 不丢；中间值可合并 |
| T059-P4-04 | P0 | failure | control-plane DB 失败 | 持续发布 | 策略仍能读 Aeron；persistLag 告警 |
| T059-P4-05 | P0 | e2e | PRODUCER_LOST | 策略读取 | 禁止新开仓；平仓允许 |
| T059-P4-06 | P0 | e2e | REPLAYING | 策略读取 | 禁止新开仓 |
| T059-P4-07 | P0 | e2e | FENCED/LOST | 策略读取 | 本地副本失效；旧 tokenEpoch 拒绝 |
| T059-P4-08 | P0 | e2e | 值 stale/NO_DATA | 策略读取 | gate 关闭，不把 null/0 当 OK |
| T059-P4-09 | P1 | e2e | 两个策略共享 indicator | 同时读取 | 同一值，不重复计算 |

退出标准：策略 gate 在 OK/REPLAYING/LOST/STALE 下行为正确；DB 不参与实时 gate。

## Phase 5：旧链路删除

| ID | 级别 | 类型 | 前置 | 步骤 | 期望 |
|---|---|---|---|---|---|
| T059-P5-01 | P0 | grep | 合并前 | `rg indicator_defs` | backend 生产代码为 0 |
| T059-P5-02 | P0 | grep | 合并前 | `rg indicator_values\|indicator_daily_history` | 生产代码/迁移为 0 |
| T059-P5-03 | P0 | build | 删除旧 mapper | 编译全仓 | 无引用、无运行期 SQL 错误 |
| T059-P5-04 | P0 | e2e | 旧 API/UI 路径 | 访问旧指标页/API | 返回 404/410 或新页面，不读旧表 |
| T059-P5-05 | P0 | test | shadow | 删除旧表 | 新链路仍可启动/运行 |
| T059-P5-06 | P0 | grep | 合并前 | `rg StrategyIndicatorOwnership\|migrate-t056` | 为 0 |

退出标准：旧表/旧代码/旧迁移全部消失；新链路不依赖旧表。

## Phase 6：运维 / UI

| ID | 级别 | 类型 | 前置 | 步骤 | 期望 |
|---|---|---|---|---|---|
| T059-P6-01 | P0 | ui | 管理员登录 | 创建/编辑/禁用/删除指标 | 页面状态与 DB/ACK 一致 |
| T059-P6-02 | P0 | ui | 指标详情 | 查看 | 显示 operatorVersion/codeHash/status/warmup/producer |
| T059-P6-03 | P0 | ui | engine 详情 | 查看 | 显示 lease/tokenEpoch/fencing/replayEpoch/session |
| T059-P6-04 | P0 | ops | 收盘时间 | 触发 archive roll | 新 recording segment；active 唯一 |
| T059-P6-05 | P0 | ops | 有 warmup ref | 执行 retention | `--protected-file` 必须存在；受保护 recording 不删 |
| T059-P6-06 | P0 | ops | HWM 文件 | 启动 control-plane | leader 唯一；非 leader 不写 |
| T059-P6-07 | P0 | alert | archive gap/active age | 注入 | 告警产生；页面可见 |
| T059-P6-08 | P1 | ui | ACK 失败 | 查看 | 显示 REJECTED_RETRYABLE/FINAL、error_code |

退出标准：运维可 roll、可保护、可观察；UI 不展示假值。

## Phase 7：最终验收 / 性能 / 安全

| ID | 级别 | 类型 | 前置 | 步骤 | 期望 |
|---|---|---|---|---|---|
| T059-P7-01 | P0 | perf | 20k catalog | 加载/启动 | 在预算内；无 DB 查询 tick 路径 |
| T059-P7-02 | P0 | perf | 高频 tick | 1m 稳态 | 无大对象分配/日志/DB；publisher 不阻塞 |
| T059-P7-03 | P0 | e2e | 两个 engine | 同时运行 | stream/epoch 隔离；无跨 engine 消息 |
| T059-P7-04 | P0 | chaos | PITR 同 epoch | 恢复 | restore_generation 触发 tokenEpoch bump |
| T059-P7-05 | P0 | chaos | PITR 旧 engine 存活 | 恢复 | 旧值被拒；策略 gate 关闭 |
| T059-P7-06 | P0 | security | 旧 replay session | 注入消息 | 按 `(engineId,replayEpoch,session)` 丢弃 |
| T059-P7-07 | P0 | long-run | shadow | 连续 24h | 无 WARMUP 泄漏、无 partition 失败、无 ACK 卡死 |
| T059-P7-08 | P0 | acceptance | 全部 Phase | 交易员/运维验收 | 指标可见、gate 正确、恢复可操作 |

退出标准：T-059 Phase 0-7 全部通过；旧链路为 0；24h shadow 稳定；真实 Archive 和 PITR 通过。

## 执行规则

```text
1. 每个 Case 必须记录：环境、commit、命令、结果、证据路径。
2. P0 失败 -> 阶段不通过，不允许进入下一 Phase。
3. P1 失败 -> 记录豁免/修复计划，不能静默跳过。
4. 真实 CTP 相关 Case 标注“需要开市/CTP 会话”，不能用 mock 代替验收。
5. 测试数据只写 `_shadow`；真实 Archive 只读。
```

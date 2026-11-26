# T-059 测试评审整改与新增用例

- 状态：**ADDENDUM — 关键 P0 已执行，R5/P14/P17/D2/D4/D5/E2E 未完成**
- 日期：2026-11-12
- 上游评审：`docs/reviews/2026-11-12-t059-test-review.md`
- 主矩阵：`docs/testing/T-059-indicator-production-acceptance.md`
- 关联：T-060 `docs/testing/T-060-venue-acceptance.md`

> 本文件不是替代 82 条主矩阵，而是补齐评审指出的 P0 覆盖缺口。
> 执行时 Case ID 可以映射回主矩阵；证据路径统一为
> `docs/evidence/T-059/<runId>/<caseId>/`。

## 1. 数据源与隔离修正

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| T059-TR-01 | P0 | static | 检查测试环境是否固定 `SIMNOW/au2612` | 改为 `SIMNOW_T059_<runId>` 或专用 `qf_indicator_shadow`；串行锁 |
| T059-TR-02 | P0 | fixture | 为 recording 1021 记录 sha256、from/to、session/seq、archive_ref | fixture 可离线复现；190 只做最终确认 |
| T059-TR-03 | P0 | static | 扫描用例的数据源列 | 每条用例标明 synthetic/SimVenue/Archive/CTP；不能用 SimVenue 证明 CTP |
| T059-TR-04 | P0 | cleanup | 每个 case 结束清理 outbox/ACK/lease/catalogVersion | 不跨 case 污染；token 序列不重置 |
| T059-TR-05 | P0 | clock | 月界/收盘/超时/heartbeat 使用可注入 clock | 不依赖真实墙钟；结果可重复 |

## 2. D6 1d barCut（原零覆盖）

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| T059-TR-D6-01 | P0 | unit | 15:00 收盘 tick / 15:00:00.001 tick | 15:00 前归当日；收盘后不重复切 bar |
| T059-TR-D6-02 | P0 | unit | 夜盘 21:00 -> 次日 02:30 | 夜盘归下一交易日；02:30 后不再切 |
| T059-TR-D6-03 | P0 | unit | Friday 夜盘 -> Monday | 归 Monday；周末不生成空 bar |
| T059-TR-D6-04 | P0 | unit | holiday 前夜盘 -> 节后首日 | 归节后首日；calendar 驱动 |
| T059-TR-D6-05 | P0 | unit | 同日 15:00 前后 partial/CLOSED | partial 保留；CLOSED 才发布最终 1d |
| T059-TR-D6-06 | P0 | e2e | replay 跨 15:00/02:30 | barCut 与 streamCut 分离；eventAsOf 不被覆盖 |
| T059-TR-D6-07 | P0 | e2e | 1d snapshot + replay | 从 nextPosition 续跑；不重复切点 |
| T059-TR-D6-08 | P1 | unit | 无 tick 的交易日 | 不生成假 bar；状态标记 NO_DATA |

## 3. R1 Journal 恢复协议

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| T059-TR-R1-01 | P0 | unit | checkpoint 指向 PREPARED 之后、APPLIED 之前 | 恢复从 PREPARED 重放，不越过未完成 cut |
| T059-TR-R1-02 | P0 | unit | header 位翻转 / CRC 错 | fail closed，不跳过损坏记录 |
| T059-TR-R1-03 | P0 | unit | 尾段 torn record | 截断到最后完整 offset，前面的记录保留 |
| T059-TR-R1-04 | P0 | unit | 同 cutId 两条记录、不同 offset | 以最大完整 offset 为准，不重复应用 |
| T059-TR-R1-05 | P0 | unit | ABORTED cut | 恢复时丢弃该 cut，不发布 value |
| T059-TR-R1-06 | P0 | unit | batch cut 多 input | 每个 input cursor 独立；整批原子 |
| T059-TR-R1-07 | P0 | unit | segment 清理边界 | 不删未 checkpoint 的 segment；引用计数正确 |
| T059-TR-R1-08 | P0 | integration | kill -9 在 PREPARED 后 | 同 applyId 续跑；不生成第二 cut |
| T059-TR-R1-09 | P0 | integration | POC journal 反向验证 | 生产协议测试在 POC 上失败；否则测试无效 |
| T059-TR-R1-10 | P1 | unit | checkpoint 文件损坏 | 明确错误和 runbook，不静默全量重放 |

## 4. R5 HWM / PITR

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| T059-TR-R5-01 | P0 | unit | HWM 文件缺失 | 启动失败或 maintenance，不降级为 1 |
| T059-TR-R5-02 | P0 | unit | HWM 文件损坏/截断 | fail closed；保留现场 |
| T059-TR-R5-03 | P0 | integration | bump tokenEpoch 后 DB 写失败 | 进入 maintenance；不继续发布旧 epoch |
| T059-TR-R5-04 | P0 | integration | bump 失败后重试 | 幂等；成功后只允许新 epoch |
| T059-TR-R5-05 | P0 | integration | 两个 control-plane 同时启动 | 单 leader；非 leader 不写 HWM |
| T059-TR-R5-06 | P0 | integration | PITR 同 epoch 恢复 | restore_generation 触发 bump；旧值失效 |
| T059-TR-R5-07 | P0 | integration | setval 回退 sequence | 检测并拒绝；不生成重复 epoch |
| T059-TR-R5-08 | P0 | chaos | 旧 engine 存活 + PITR | 旧 token 被拒；策略 gate 关闭 |
| T059-TR-R5-09 | P1 | ops | HWM 备份/恢复演练 | runbook 可执行；结果可验证 |

## 5. P1-4 Outbox 字节级一致性

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| T059-TR-P14-01 | P0 | unit | 同 spec 两次 canonical builder | `payload_jcs` 字节一致 |
| T059-TR-P14-02 | P0 | unit | 字段顺序/Unicode/数字格式变化 | JCS 规范化后 hash 仍一致 |
| T059-TR-P14-03 | P0 | integration | ACK 丢失后同 requestId 重发 | outbox 行不新增；字节与首次一致 |
| T059-TR-P14-04 | P0 | integration | FAILED -> PENDING 重试 | attempts+1；payload 不变 |
| T059-TR-P14-05 | P0 | integration | 同 catalogVersion 两个 delta | 唯一键拒绝或合并策略明确 |
| T059-TR-P14-06 | P1 | integration | SNAPSHOT 消息 | 排序/版本/分页正确 |

## 6. P1-7 Operator / CodeHash 拒绝路径

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| T059-TR-P17-01 | P0 | unit | 固定源码/manifest 生成 hash | 与 golden 字节一致 |
| T059-TR-P17-02 | P0 | integration | engine 上报错误 codeHash | `REJECTED_FINAL`，不 APPLIED |
| T059-TR-P17-03 | P0 | integration | manifest 缺失 | 启动失败；不加载未注册指标 |
| T059-TR-P17-04 | P0 | integration | operatorVersion 不匹配 | 拒绝；error_code 明确 |
| T059-TR-P17-05 | P0 | integration | schemaHash 不匹配 | 拒绝；不得降级 |
| T059-TR-P17-06 | P1 | ops | manifest 轮换 | 新旧版本窗口明确；旧 engine 不静默继续 |

## 7. D2 / D4 / D5 边界

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| T059-TR-D2-01 | P0 | integration | live image 晚于 cut | WARMUP/REJECT，不静默继续 |
| T059-TR-D2-02 | P0 | integration | liveStart > cut | 回放/缓冲策略明确；不丢 tick |
| T059-TR-D2-03 | P0 | integration | buffer 溢出 | 告警/WARMUP；不丢最新值 |
| T059-TR-D2-04 | P0 | integration | archive durable head 不足 | 不切 live；保持 WARMUP |
| T059-TR-D4-01 | P0 | unit | seq gap 在预算内/超预算 | 预算内等待；超预算 WARMUP/告警 |
| T059-TR-D4-02 | P0 | unit | 旧 epoch / 未注册 session | 丢弃并告警；不更新 cursor |
| T059-TR-D4-03 | P0 | unit | 两 instrument 同 session seq=1 | 按 instrument 分桶，不碰撞 |
| T059-TR-D5-01 | P0 | integration | snapshot 跨 recording | 从 nextPosition 续跑；不重放已应用帧 |
| T059-TR-D5-02 | P0 | integration | initialReplayFrom 边界 | 半开区间；from 帧包含 |
| T059-TR-D5-03 | P0 | integration | CUMULATIVE/lookback | 窗口正确；不把 warmup 当正式值 |
| T059-TR-D5-04 | P0 | integration | watermark 约束 | 不发布早于 watermark 的值 |

## 8. P1-1 / P1-3 / P1-5 / R4

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| T059-TR-P11-01 | P0 | integration | APPLIED 但未 READY | RouteIndex 不可路由；gate 关闭 |
| T059-TR-P11-02 | P0 | integration | READY 但首个 OK 未到 | 仍不可路由；不把 READY 当 OK |
| T059-TR-P13-01 | P0 | integration | CONTROL 写 PRODUCER_LOST | 覆盖 ACTIVE lease；新 epoch 才能恢复 |
| T059-TR-P13-02 | P0 | integration | latest + history 事务失败 | 原子回滚；不出现半写 |
| T059-TR-P15-01 | P0 | integration | active recording | 永不 purge；retention 跳过 |
| T059-TR-P15-02 | P0 | integration | protected-file 缺失 | 拒绝执行，给出 runbook |
| T059-TR-P15-03 | P0 | integration | archive gap 两种恢复态 | WARMUP 或明确失败；不静默当连续 |
| T059-TR-R4-01 | P0 | integration | 9001 无 slot | NO_SLOT；不共用他人 stream |
| T059-TR-R4-02 | P0 | integration | DRAINING | 确认后才回收；旧 session 丢弃 |
| T059-TR-R4-03 | P0 | integration | 同 engine 重启旧 session | 新 session 生效；旧消息拒绝 |

## 9. B13 E2E 指标 V2

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| E2E-B13-001 | P0 | e2e | 创建 EMA -> APPLIED/READY/ACTIVE -> 首个 OK | 10s 内 READY；值可见 |
| E2E-B13-002 | P0 | e2e | 两策略共享同一 indicator | 只计算一次；值一致 |
| E2E-B13-003 | P0 | e2e | displayName/period/delete/disable/re-enable | 语义符合 ADR-002/003 |
| E2E-B13-004 | P0 | e2e | 1000 pre-cut tick 下 hot add | 不重复/不丢 |
| E2E-B13-005 | P0 | e2e | PREPARED/replay/snapshot 前 kill -9 | 恢复一致 |
| E2E-B13-006 | P0 | e2e | archive roll + gap | WARMUP/READY 正确 |
| E2E-B13-007 | P0 | e2e | 两 engine 隔离，注入对方 grant | 丢弃并告警 |
| E2E-B13-008 | P0 | e2e | 错误 codeHash | REJECTED_FINAL |
| E2E-B13-009 | P0 | e2e | DB down 仍按 Aeron 值交易 | 策略不被 DB 阻塞 |
| E2E-B13-010 | P0 | e2e | PITR -> tokenEpoch bump | gate 关闭/恢复 |
| E2E-B13-011 | P0 | e2e | retention 缺 protected-file | 拒绝；active/ref 不删 |
| E2E-B13-012 | P0 | e2e | UI | 显示 codeHash/status/lease/replayEpoch/error |

## 10. 回归映射与 P0 重划

```text
1. e2e-regression-map.yaml 增加：
   backend/indicator-engine/**
   tools/db/schema-indicator-v2.sql
   tools/db/indicator-history-partitions.sql
   web/src/pages/Indicators*
   web/src/pages/Engines*

2. B7 标记 LEGACY V1；B13 作为 V2 唯一指标 E2E。
3. B7-005/t030-pair.mjs 删除“策略私有 3 指标”断言。
4. B7-004 与 T-059 统一：
   DELETE 有 binding -> 409
   disable -> 允许，RouteIndex 移除，gate 关闭，平仓放行
5. P0 收敛到协议/安全不变量（约 40-45 条）：
   提升 P1-12/P3-19/P3-20/P4-09 和 TR 反例；
   降级简单 CRUD/单次 UI 渲染/无预算性能/主观签字。
```

## 11. 执行规则

```text
1. 每个 TR case 必须绑定主矩阵 Phase 和目标 Case ID。
2. P0 反例必须有正控；没有正控记为 FAIL。
3. 真实 Archive/CTP 用例标注 source，不能用 SimVenue 代替。
4. 证据缺失 = FAIL；测试报告不能只写“通过”。
5. T-059 Phase 0 前先完成 TR-D6/R1/R5/P14/P17 的用例实现。
```


## 12. 2026-11-13 补跑

- 已执行 D6（含节假日/partial/no-data）、R1（含 ABORTED/max offset）、P2 runtime/canonical、P3 snapshot/restore、P4 gate、SBE V2/interop。
- 新增 `VenueResolverTest`、`VenueReconciliationRouterTest`，修复 SimVenue position 2014 与 reset 可复现性。
- 结果：`docs/evidence/T-059/20261113/tests.md`、`docs/evidence/T-061/20261113/gradle-tests.log`。

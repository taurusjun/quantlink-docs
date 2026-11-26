# T-061 V2 统筹执行计划

- 状态：**EXECUTING**
- 日期：2026-11-12
- 范围：
  - T-060 统一交易场所接入
  - T-059 指标生产实现
- 依据：
  - ADR-001 / ADR-002 / ADR-003（指标协议，APPROVED）
  - ADR-004 / `docs/architecture/venue-contract.md`（统一接入，APPROVED）
  - `docs/tasks/T-060-venue-integration-migration.md`
  - `docs/testing/T-060-venue-acceptance.md`
  - `docs/tasks/T-059-indicator-production-plan.md`
  - `docs/testing/T-059-indicator-production-acceptance.md`
  - `docs/testing/T-059-test-remediation.md`

> 本计划是唯一执行队列。  
> 每个任务必须先有测试/验收，再实现；P0 失败立即停，不进入下一任务。  
> 破坏性 DB 操作、真实 CTP 验收、开市窗口单独标记，不得用 mock 冒充。

## 1. 执行原则

```text
1. 契约先于代码：身份、SBE 字段、stream 分配先冻结。
2. ORS 是 stream 唯一事实源，不按 venueType 推导，不硬编码 1001/2100/3140。
3. T-060 A0 先于 T-059 测试最终冻结；T-059 的 D6/R1/R5 可并行实现。
4. 先 shadow/双读/双订阅，再切写，最后删旧分支。
5. 每个任务必须有：代码/文档、测试、证据、回滚说明。
6. POC/SimVenue 不能单独证明 CTP 契约；最终 CTP 验收必须真实会话。
7. 不把“编译通过”当验收；不把“POC 通过”当生产验证。
```

## 2. 当前基线（2026-11-12）

### 2.1 设计

```text
ADR-001/002/003：APPROVED
ADR-004：APPROVED（设计层）
venue-contract：APPROVED
T-060：APPROVED（stream 章节已按 190 实际配置修正）
T-059：DRAFT，测试评审 CHANGES REQUIRED；整改用例已补
```

### 2.2 190 实际 ORS

| venueId | accountId | orsId | adapter | MD | order | cancel | update | trade | position |
|---|---|---|---:|---:|---:|---:|---:|---:|
| SIMNOW | TEST-001 | ors-simnow-test-001 | CTP | 1100 | 2100 | 2101 | 2102 | 2103 | 2006 |
| SIMSHENGLI | TEST-SHENGLI | ors-shengli-test-shengli | CTP | 1110 | 2110 | 2111 | 2112 | 2113 | 2013 |
| SIMVENUE | SIMVENUE-001 | ors-simvenue-001 | SIM | 1001 | 3140 | 3141 | 3142 | 3143 | 2014 |

已知冲突：

```text
position 已拆分：SimNow=2006，Shengli=2013，SimVenue=2014
SimVenue MD=1001 只是模拟行情，不是 CTP 行情
archive-replay 引用 2102/2103 等 live stream，需确认只读
```

### 2.3 实现状态

```text
T-060 生产代码：已实现；SimVenue/CTP/Replay wire 已接入
T-059 生产 Java：P2/P3 已实现并运行；P4 gate 已接入
indicator schema：已应用到 190 shadow（2026-11-13 reset）
SBE 新字段：已生成并通过 Java/C++ interop
旧 CTP/SIMVENUE 分支：核心路径已清；V1 指标 UI/旧表仍保留，见 §6
```

## 3. 执行总览

| 顺序 | 阶段 | 任务 | 依赖 | 验收 |
|---:|---|---|---|---|
| 0 | S0 | 契约/测试基线冻结 | 无 | V-A0-01/11、T059-TR-01..05 |
| 1 | V-A0 | 身份 + SBE + golden | S0 | V-A0-01..12 |
| 2 | I-P0 | operator manifest + fixtures | S0 | T059-P0-01..05 |
| 3 | V-A1 | conformance harness | V-A0 | V-A1-01/02、V-01..12 |
| 4 | I-TR | T-059 测试整改实现 | S0 | T059-TR-D6/R1/R5/P14/P17 |
| 5 | V-A2 | Registry/Descriptor | V-A1 | V-A2-01..08 |
| 6 | I-P1 | schema shadow | V-A0 + 用户确认 | T059-P1-01..12 |
| 7 | V-B | stream/ORS 迁移 | V-A2 | V-B-01..08 |
| 8 | I-P2 | catalog/lease/ACK | I-P1 | T059-P2-01..14 |
| 9 | V-C1 | CTP adapter | V-B | V-C1-01..10 |
| 10 | V-C2 | SimVenue adapter | V-B | V-C2-01..06 |
| 11 | V-C3 | Replay adapter | V-B | V-C3-01..05 |
| 12 | I-P3 | engine runtime | I-P2 + V-A0 | T059-P3-01..20 |
| 13 | V-D | Venue Ports | V-C1..C3 | V-D-01..08 |
| 14 | I-P4 | value/gate | I-P3 | T059-P4-01..09 |
| 15 | V-F | 三 adapter conformance | V-D | V-F-01..04 |
| 16 | I-P5 | 旧指标链路删除 | I-P4 + V-F | T059-P5-01..06 |
| 17 | V-E | 旧交易分支删除 | V-F | V-E-01..03 |
| 18 | I-P6 | 运维/UI | I-P5 | T059-P6-01..08 |
| 19 | I-P7 | 最终验收/24h | I-P6 + V-E | T059-P7-01..08、V-ACC-01..06 |

## 4. 任务明细

### S0 契约/测试基线

| ID | 交付 | 验收 | 状态 |
|---|---|---|---|
| S0-01 | T-060 stream/ORS 修正 | 190 实际 inventory 写入 T-060/ADR/contract | DONE |
| S0-02 | T-060 验收矩阵 | `docs/testing/T-060-venue-acceptance.md` | DONE |
| S0-03 | T-059 测试整改用例 | `docs/testing/T-059-test-remediation.md` | DONE |
| S0-04 | 冻结清单：venue/account/ORS/stream/SBE ID | 文档 hash + 评审记录 | TODO |

S0 退出：

```text
T-060 与 ADR/contract 无 stream 矛盾
T-060 验收矩阵覆盖 A0-F/E
T-059 评审 P0 缺口均有 case
```

### V-A0 身份 + SBE

| ID | 交付 | 验收 |
|---|---|---|
| V-A0-01 | 身份映射 SQL/约束 | V-A0-01/11 |
| V-A0-02 | SimVenue env 拆分 | V-A0-02 |
| V-A0-03 | `position_channel/position_stream` 迁移 | V-A0-12 |
| V-A0-04 | `MarketDataV2` id=29 | V-A0-03/04/09 |
| V-A0-05 | `VenueSession` id=28 + group | V-A0-05 |
| V-A0-06 | Order/Trade/Account/Position/Cancel 新字段 | V-A0-06/07 |
| V-A0-07 | C++/Java codegen + golden | V-A0-07/08 |
| V-A0-08 | 兼容策略/未知消息拒绝 | V-A0-10 |

退出：V-A0 P0 全绿；SBE 字段 ID 冻结。

### I-P0 operator + fixtures

| ID | 交付 | 验收 |
|---|---|---|
| I-P0-01 | manifest 生成脚本 | T059-P0-01/02 |
| I-P0-02 | recording 1021 fixture + sha256 | T059-P0-03/05、TR-02 |
| I-P0-03 | au2612 1m EMA(13) spec | T059-P0-03 |
| I-P0-04 | 双 instrument session/seq fixture | T059-P0-04、TR-D4-03 |
| I-P0-05 | shadow 隔离/串行锁/清理 | TR-01/04 |

退出：manifest 可重复；fixture 可离线复现。

### V-A1 conformance harness

| ID | 交付 | 验收 |
|---|---|---|
| V-A1-01 | fake adapter | V-A1-01 |
| V-A1-02 | CTP 录制帧回放 | V-A1-02 |
| V-A1-03 | V-01..12 套件 | V-01..12 |
| V-A1-04 | 负向正控 | V-A1 负向 case |

退出：同一 suite 可对 fake/CTP 录制帧运行。

### I-TR 测试整改实现

| ID | 交付 | 验收 |
|---|---|---|
| I-TR-01 | D6 1d barCut 测试 | TR-D6-01..08 |
| I-TR-02 | R1 journal 测试 | TR-R1-01..10 |
| I-TR-03 | R5 HWM/PITR 测试 | TR-R5-01..09 |
| I-TR-04 | P1-4/P1-7 测试 | TR-P14/TR-P17 |
| I-TR-05 | D2/D4/D5/P1-1/P1-3/P1-5/R4 | 对应 TR |
| I-TR-06 | B13 E2E + 回归映射 | E2E-B13-001..012 |

退出：TR P0 用例可执行；POC 反证按预期失败。

### V-A2 Registry

| ID | 交付 | 验收 |
|---|---|---|
| V-A2-01 | descriptor 读模型 | V-A2-01/08 |
| V-A2-02 | `(channel,stream,writerRole)` 唯一校验 | V-A2-03/06 |
| V-A2-03 | descriptor/ORS 优先级 | V-A2-02/05 |
| V-A2-04 | adapter 参数一致性校验 | V-A2-07 |
| V-A2-05 | account/venue 校验 | V-A2-04 |

### I-P1 schema shadow

| ID | 交付 | 验收 |
|---|---|---|
| I-P1-01 | schema reset smoke | T059-P1-01/02 |
| I-P1-02 | outbox/ACK trigger 测试 | T059-P1-03..05 |
| I-P1-03 | latest/engine/gap/ref 约束 | T059-P1-06..09 |
| I-P1-04 | history 分区 | T059-P1-10..12 |

> 实际 apply 需要用户确认 shadow DB 与破坏性 reset；未确认前只写脚本/本地测试。

### V-B Stream/ORS

| ID | 交付 | 验收 |
|---|---|---|
| V-B-01 | position 2006/2007 拆分 | V-B-03/04/07 |
| V-B-02 | ORS 行/adapter 参数同步 | V-B-01/08 |
| V-B-03 | MD 绑定 1100/1110/1001 | V-B-05 |
| V-B-04 | replay 发布只允许 9xxx | V-B-06 |
| V-B-05 | 无硬编码 stream 分支 | V-B-02 |

### I-P2 catalog/lease/ACK

| ID | 交付 | 验收 |
|---|---|---|
| I-P2-01 | canonical catalog API | T059-P2-01..05 |
| I-P2-02 | outbox 字节一致 | T059-P2-06..10、TR-P14 |
| I-P2-03 | lease/tokenEpoch/HWM | T059-P2-11..14、TR-R5 |
| I-P2-04 | PRODUCER_LOST | T059-P2-13、TR-P13 |

### V-C1/C2/C3 adapters

| ID | 交付 | 验收 |
|---|---|---|
| V-C1 | CTP channel/session/seq/cancel/account | V-C1-01..10 |
| V-C2 | SimVenue 同 envelope/身份 | V-C2-01..06 |
| V-C3 | Replay 上下文/9xxx | V-C3-01..05 |

### I-P3 engine runtime

| ID | 交付 | 验收 |
|---|---|---|
| I-P3-01 | catalog/plan/RouteIndex | T059-P3-01..20 |
| I-P3-02 | journal/WAL | TR-R1 |
| I-P3-03 | live/replay/barrier | TR-D1/D2/D4/D5 |
| I-P3-04 | state/value/heartbeat | T059-P3-15..19 |
| I-P3-05 | hot reload | T059-P3-12..14/20 |

### V-D Ports

| ID | 交付 | 验收 |
|---|---|---|
| V-D-01 | Registry/MD/Execution/Account/Health Port | V-D-01..08 |
| V-D-02 | feature flag + shadow compare | V-D-07/08 |

### I-P4 value/gate

| ID | 交付 | 验收 |
|---|---|---|
| I-P4-01 | VALUE consumer/latest/history | T059-P4-01..04 |
| I-P4-02 | 策略 gate | T059-P4-05..09 |
| I-P4-03 | stale/DB down | T059-P4-02/04/08 |

### V-F / I-P5 / V-E

| ID | 交付 | 验收 |
|---|---|---|
| V-F | 三 adapter conformance | V-F-01..04 |
| I-P5 | 删除旧指标表/代码/迁移 | T059-P5-01..06 |
| V-E | 删除旧交易分支/默认 stream | V-E-01..03 |

### I-P6 / I-P7

| ID | 交付 | 验收 |
|---|---|---|
| I-P6-01 | 指标 UI/engine/ACK | T059-P6-01..03/08 |
| I-P6-02 | archive roll/ref/retention | T059-P6-04..07、TR-P15 |
| I-P7-01 | 性能/安全/24h | T059-P7-01..08 |
| I-P7-02 | T-060 总验收 | V-ACC-01..06 |

## 5. 门禁

```text
G0 S0：文档无矛盾；测试矩阵齐备
G1 A0：SBE/golden/identity 全绿
G2 A1：conformance harness 可重复
G3 A2：registry 唯一性/优先级通过
G4 P1：schema shadow 通过（需用户确认）
G5 B：position/stream 隔离通过
G6 C：三 adapter 契约通过
G7 P3：D1 golden/kill -9/live barrier 通过
G8 D：Ports/feature flag 通过
G9 F：三 adapter conformance 全绿
G10 P5/E：旧链路为 0
G11 P6/P7：24h + 最终验收
```

任何 P0 fail：停止队列，记录证据，修复后从该任务重跑。

## 6. 外部阻塞

| 任务 | 缺什么 | 处理 |
|---|---|---|
| I-P1 schema apply | shadow DB 连接 + 破坏性 reset 确认 | 先写脚本/本地测试；确认后 apply |
| V-C1 真实回调 | 开市/CTP 会话 | 标 `needs_market`，mock 只做预验收 |
| V-B position 拆分 | 收盘维护窗口 | 先改 DB/参数/双订阅脚本，窗口执行 |
| I-P7 24h | 连续运行窗口 | 单独排期 |
| 非零出入金/费率/成交复验 | 真实事件 | 独立 `needs_market` 清单 |

## 7. 证据与提交

```text
docs/evidence/T-061/<taskId>/<runId>/
  result.json
  stdout.log
  sql/
  artifacts/
  metrics.csv
  screenshots/
```

提交格式：

```text
feat(venue): T-060 A0 ...
test(venue): T-060 A1 ...
feat(indicator): T-059 P2 ...
```

每个提交必须附：

```text
测试命令
通过数量
证据路径
未覆盖/阻塞
```

## 8. 执行日志

| 时间 | 任务 | 结果 | 证据 |
|---|---|---|---|
| 2026-11-12 | S0-01 | DONE | T-060/ADR/contract |
| 2026-11-12 | S0-02 | DONE | T-060 acceptance |
| 2026-11-12 | S0-03 | DONE | T-059 remediation |
| 2026-11-12 | S0-04 | DONE | `docs/architecture/venue-freeze-2026-11-12.md` |
| 2026-11-12 | V-A0 | PARTIAL | SBE/golden/validator done；DB migration 未应用、190 SimVenue env 未切 |
| 2026-11-12 | V-A1 | PARTIAL | V-01..12 guards/tests done；真实 CTP 录制帧待接 |
| 2026-11-12 | V-A2 | PARTIAL | account/venue、adapterKind、stream 冲突校验 done；DB 约束/registry 独立服务待接 |
| 2026-11-12 | V-C1 | PARTIAL | CTP channel/venueId/session/epoch/seq/cancel guard done；190 重编译/重启待维护窗口 |
| 2026-11-12 | V-A1/V-C1 | PARTIAL | MarketDataCodec 兼容 id2/id29；真实 CTP 录制帧待接 |
| 2026-11-12 | V-C2 | PARTIAL | SimVenue V2 行情/账户上下文 done；190 env 身份切换待维护窗口 |
| 2026-11-12 | V-C3 | PARTIAL | Replay V2 上下文/1011/9xxx gate done；真实 Archive 联调待接 |
| 2026-11-12 | I-TR-D6 | PARTIAL | TradingCalendar + DailyBar 日夜盘/周末/节假日/15:00/partial 基线 done；完整 barCut 集成待接 |
| 2026-11-12 | V-D | PARTIAL | VenuePorts 接口/内存 registry/异步 submit/stale/health 测试 done；DB 实现待接 |
| 2026-11-12 | I-TR-R1 | DONE（unit） | AQJ1/CRC32C/PREPARED/APPLIED/torn tail/checkpoint 测试通过；engine 接入待接 |
| 2026-11-12 | 190 重部署 | DONE | schema reset、position 2013、CTP/SimVenue/control-plane 已切换；见 evidence |
| 2026-11-12 | 真实 OrderSysID | PASS | 900000000035 FILLED, exchange_order_id=118156 |
| 2026-11-12 | 日志止血 | DONE | 1.2GB -> 19MB；Pair gate 日志 30s 节流 |
| 2026-11-12 | 190 最终验证 | PASS | 5 services active、18 张 indicator 表、V2 quote 双 venue、OrderSysID=118156 |
| 2026-11-12 | I-P2 catalog/lease/ACK | DONE（core） | create/idempotent/outbox/delta/ACK/lease/engine 9001；P3 runtime 待接 |
| 2026-11-12 | I-P3 runtime / 1d | DONE（code/test） | HTTP client/lease/ACK/catalog + 1d state + gate + Aeron live/V2 decode/Archive replay/ACK READY 测试通过；生产 24h/真实 feed 待验收 |
| 2026-11-12 | IndicatorEngine 部署 | PASS | systemd 9001/1100，EMA13 ValueKV，PITR epoch 6->7 |
| 2026-11-12 | 夜盘 trade-day 对账 | FIXED | CTP snapshot day authoritative；preview 不再报 CTP trades day 20261113 |
| 2026-11-12 | CTP 异步拒单 | PASS | 900000000037 REJECTED with CTP ErrorID/ErrorMsg |
| 2026-11-12 | 24h soak | RUNNING | indicator-soak.service started |
| 2026-11-13 | SimVenue clean retest | PASS | positions=6 / ledger=6 / strategy_positions=2 / venue recon passed=true |
| 2026-11-13 | 统一接入收口 | DONE | SimVenue position 2014 + VenueReconciliationRouter + 无 SIMVENUE 字面量核心分支 |
| 2026-11-12 | I-P0 | PARTIAL | manifest + canonical indicatorId done；recording fixture/隔离待补 |

## 9. 第一批执行

```text
1. S0-04 冻结清单
2. V-A0 身份 + SBE
3. I-P0 operator manifest
4. V-A1 conformance harness
5. I-TR D6/R1/R5 测试
```

S0-04 完成后立即进入 V-A0；不等待 T-059 schema apply。


## 6. 2026-11-13 干净重测与验收状态

```text
shadow reset：schema -> seed -> t046/... -> indicator V2 -> T-060 -> ORS seed（scratch RC=0）
SimVenue position：独立 stream 2014，control-plane 订阅 2006/2014
干净重测：positions=6 / position_ledger=6 / venue recon passed=true
策略单：strategy_positions=2，source=LEDGER
撤单：CANCELED
T-060 P0 核心：PASS；矩阵多项 PARTIAL/NOT_RUN
T-059 D6/R1/P2/P3/P4：PASS；R5/P14/P17/D2/D4/D5/E2E：未完成
24h soak：engine 自 2026-11-13 00:56:41 运行，soak 自 00:56:57，目标 2026-11-14 00:56:57
```

证据：`docs/evidence/T-060/20261113/`、`docs/evidence/T-059/20261113/`、`docs/evidence/T-061/20261113/`。

V1 清理：
- 删除 control-plane `IndicatorEngine`、`IndicatorStreamConsumer`、`IndicatorMapper`、`IndicatorHistoryTask`、`StrategyIndicatorOwnership/Remap`。
- 删除 runner `IndicatorPublisher`/`IndicatorDefMapper`。
- 删除旧迁移 t037/t040/t043/t055-pair/t056 与 seed-t030。
- 删除 `schema-shadow.sql` 的 V1 表；legacy controller 已删除。
- 策略详情/策略视图/fork 改读 V2 `strategy_indicator_binding` + `indicator_latest`。
- 190 shadow `indicator_defs`/`indicator_values` 已不存在；V2 `indicator_engine` 存在。

Snapshot streams：SimNow account/order/trade=2007/2008/2009，Shengli=2015/2016/2017，SimVenue account=2018；control-plane consumer 已订阅。
UI：去掉 ManualBook/OptionChainV2/StrategyWizard/StrategyCenter 的 SIMVENUE 默认偏好。

双 CTP 日盘（2026-11-13）：
- SimNow/Shengli 均 LOGGED_IN；account/order/trade/position 快照已按柜台分流。
- SimNow `900000001001` OPEN；Shengli `900000001003` CLOSE CANCELED；仓位 4/3/6 按账户隔离。
- 证据：`docs/evidence/T-060/20261113/dual-ctp-day.md`。

新增（2026-11-13）：
- R5：`TokenEpochHwm` + `/api/v1/indicators/recovery/bump`、`/recovery/hwm`；文件损坏 fail-closed，PITR 文件高水位不回退。
- P14：outbox `payload_jcs` 与 `payload_sha256` 已用 DB sha256 复核；同 requestId ACK 两次只落一行。
- P3 value：engine 每 5s 上报 `indicator_latest`；B13 `EMA5` 已有值 842.94/OK，`EMA13` 同步更新。
- T-060：`/api/v1/reconciliation/shadow` 做 positions(venue truth) vs position_ledger 只读比较；`tools/db/rollback-t060-venue-streams.sql` 回滚脚本。

遗留：
- SimShengli MD tick 停在 10:44，CTP CLOSE 被 CANCELED；成交隔离待完成。
- 双 CTP/夜盘/真实 CTP 重连/rollback 未验收。
- R5/P14/P17/D2/D4/D5/B13 全量 E2E 未完成。
- control-plane 重启窗口内 engine 会 fail-fast 重启；已验证自动恢复，但尚未做 24h 连续故障演练。


## 7. 2026-11-13 下午补充

- 双 CTP 成交：SimNow 900000001005 FILLED；SimShengli 900000001004 CLOSE 3 FILLED。
- SimShengli 平仓成交进入 `unassigned_trade`，ledger 未归属；venue position 已正确平掉。
- A1 真实 update/trade fixture 已入仓并通过测试。
- P4 gate、VenueRegistry、V2 指标详情/历史/绑定、Engine/Lease/ACK 状态接口已上线。
- E2E `t030-pair` 全绿；`readonly-smoke` 仅 `/execution` 表格单元格断言失败；`t030-lifecycle` 全绿。
- rollback SQL 事务 dry-run 通过；shadow compare 无差异。

- ACK 非法状态 400；REJECTED_RETRYABLE 200。
- 手工平仓账本补种修复已提交/部署，待 2026-11-16 开盘真实平仓复测。
- readonly-smoke 24/24 通过；t030-pair 全绿。
- 最终 24h soak 窗口：2026-11-16 09:00 → 2026-11-17 09:00 CST（周一开盘起算）。
  2026-11-13 17:21:27 起为预跑，不计最终 PASS。
- P4 已覆盖控制面 `/strategy/orders` 与 runtime-runner `AeronOrderGateway` 两条开仓路径。
- P2 故障注入通过：engine FAILED / lease FENCED / latest PRODUCER_LOST / 旧 fencing 409 / 新 fencing 200。

## 8. 2026-11-14 V-D 运行面接入补齐

- `VenuePorts` 运行面从 `MarketDataMessage` 迁到 typed envelope：
  `MarketDataEnvelope` / `OrderUpdateEnvelope` / `TradeEnvelope` /
  `PositionEnvelope` / `VenueSessionEnvelope` / `OrderRequestEnvelope` /
  `CancelRequestEnvelope`。
- `MarketDataCodec.decodeEnvelope()` 保留 venueId / sourceSessionId /
  sourcePublicationEpoch / seq / publishTime / environment，不再在解码后丢弃。
- 新增 `AeronVenueMarketDataPort`：Aeron poll 限定在 I/O 线程，按 venue/instrument
  回调，带 seq 重复/缺口统计。
- 新增 `AeronVenueExecutionPort`：通过 `AeronOrderGateway` 的成交/订单事件提供
  venue-scoped execution subscribe；submit/cancel 只返回“已受理发布”，不冒充成交。
- runner 行情改走 `AeronVenueMarketDataPort`；成交通过 Port 事件入队，并在策略
  主循环应用，不再只依赖 5 秒 `Portfolio` 同步。
- 状态：V-D 仍为 **PARTIAL**。DB-backed VenueRegistry、完整 VenueAccountPort
  position/session 流、真实 adapter conformance 和 runner StrategyEventLoop 尚未完成。
- `VenueRegistryService` 直接实现 `VenuePorts.VenueRegistryPort`（DB-backed + capability filter）。
- 新增 `ControlPlaneVenueAccountPort`：提供 account/position snapshot，明确仅用于 bootstrap/reconciliation；position/session 实时流仍未接。
- Conformance（2026-11-14）：新增 `AeronVenueMarketDataPortTest`（真实 Aeron IPC 发布→venue callback）与
  `RecordedCtpOrderTradeFramesTest` 的 Envelope 断言；真实 CTP 订单/成交录制帧通过。
- 仍未完成：真实 CTP 行情录制帧、SimVenue/Replay adapter 的 envelope conformance、runner 事件循环验收。
- 2026-11-14 验证：`:backend:shared:aeron:test`、`:backend:runtime-runner:test`、
  `:backend:sim-venue:test`、`:backend:replay-gateway:test` 全部通过；
  CTP order/trade 录制帧、Aeron venue market-data port、SimVenue/Replay 现有 conformance 均绿。
- 仍待 live 验收：真实 CTP MD 录制帧、跨进程 SimVenue/Replay envelope 抓包、24h soak。

## 9. 2026-11-14 Ports P0 修复（第一批）

- `Snapshot` 增加 `staleAfterMs/tradingDay/snapshotId/source`；`PositionSnapshot`
  补齐 today/yesterday、long/short avg、settlement、venue/exchange/environment/source/asOf；
  `VenueSession` 补齐 login/settlement/lease/adapterSession/reason。
- `ControlPlaneVenueAccountPort` 不再用 `Instant.now()` 伪造 asOf；位置时间取
  `strategy_positions.updated_at`，缺字段/超时返回 stale。
- `AeronVenueMarketDataPort` 增加 gap/health；gap 后阻塞该 key，必须 `resetGap`
  才能恢复；首个 seq 作为基线，避免重启必然 WARMUP。
- `AeronMarketData` 删除 Aeron 路径的 HTTP fallback，禁止双源。
- `AeronVenueExecutionPort` 返回结构化 submit/cancel 结果（reason/retryable），
  并按 clientOrderId 做 monotonic sequence 过滤。
- CTP adapter outbound 满/执行 publication closed 不再静默丢：置 fatal 并记录，
  由主进程 fail-stop + 重启对账。
- 仍未完成：CTP order sequence 的 wire 契约（当前全局递增）、真实 MD snapshot 恢复、
  runner 唯一账本与 pending 敞口、live conformance。
- runner 双重记账止血：`refreshPositions` 只做初始 bootstrap；已有非零仓位后不再
  用 gateway 快照覆盖 Portfolio。Fill 事件仍是唯一增量来源。
- 新增 CTP trade dedup key：`venueId|tradingDay|tradeId`，避免跨日 TradeID 误杀。
- 执行链路 fatal：新增 `FatalExecutionException` + gateway fatal handler；runner 收到
  listener fatal 直接 halt(70)，不再吞异常继续跑。
- wire 语义收口：`OrderUpdateV2.sequence` 明确为 stream-global；Port 的 per-order
  filter 只拒绝同订单回退，不推断 per-order gap。
- hot reload：版本切换前先撤旧 generation 的 working orders，再替换策略，避免新策略继承幽灵挂单。
- risk-thread reconcile：控制面 openOrders 缺失只记录 drift，不再从本地 working book 删除，
  避免延迟快照把真实 pending exposure 清零。
- 2026-11-14 CTP adapter 验证：把 `ctp_aeron_bridge.h` 临时同步到 190
  `/opt/quantlink-fin-src`，用 `tools/build_ctp_aeron.sh` 编译成功（仅 SBE
  生成代码的 memcpy 警告）；未部署，源文件已恢复。
- M0a 进展：新增 `/strategy-center/accounts/{id}` 的 `serverTime` 与 `updated_at` 透出；
  `ControlPlaneVenueAccountPort` 改读 account/venue 位置真值（positions），不再读
  strategy ledger 投影；缺 serverTime/位置列表返回 stale，不使用 Instant.now 伪造。
  仍待：requestSeq、registry 默认值清理、真实 account position stream。
- M0a-1 groundwork：新增 `ors_instances.session_channel/session_stream`（4100/4110/4120
  测试分配）、`VenueSessionCodec`、`AeronVenueSessionPort`。CTP adapter 发布点尚未接，
  需要 `--session-stream/--ors-id` 参数和部署窗口；tradingDay 仍未进入 TradeEnvelope。
- 2026-11-14 VenueSession 验证：SimVenue 新增 `--session-stream 4120` 并在 4120 成功发布
  `SIMVENUE / tradingDay=20261114 / READY / 6 streams`；CTP adapter 因非交易时段登录失败，
  已回滚旧二进制，待交易时段再验证。session_stream migration 已应用到 190 shadow。

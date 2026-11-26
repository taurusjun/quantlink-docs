# T-060 可执行验收记录（2026-11-13）

- 代码基线：`6bb6eaa`（V1 清理与 venue 解析提交）
- 环境：190 shadow `quantlink_fin_shadow`、SimVenue `SIMVENUE-001`、SimNow `TEST-001`
- 证据目录：`docs/evidence/T-060/20261113/`
- 结论：**P0 核心链路通过；多项矩阵条目仍为 PARTIAL/NOT_RUN，见第 6 节**

## 1. 本次执行命令

```bash
./gradlew :backend:shared:sbe:test :backend:shared:aeron:test \
  :backend:control-plane:test :backend:sim-venue:test \
  :backend:runtime-runner:test :backend:indicator-engine:test \
  :backend:replay-gateway:test
bash tools/run_sbe_interop.sh
QF_PG_DB=qf_reset_probe_shadow ... bash tools/db/reset-shadow.sh
psql ... -f tools/db/validate-t060-venue-streams.sql
```

结果：Gradle `BUILD SUCCESSFUL`，SBE interop `RC=0`，scratch reset `RC=0`，
live/scratch stream validation 均 0 冲突。

## 2. A0 身份 / SBE

| ID | 结果 | 证据 |
|---|---|---|
| V-A0-01 | PASS | `live-validate.txt`、`scratch-reset-validate.txt`：venue/account/ORS 无孤儿、无 venue 不一致 |
| V-A0-02 | PASS | 190 `sim-venue.env`：venueId=SIMVENUE，accountId=SIMVENUE-001；进程参数一致 |
| V-A0-03 | PASS | `sbe-schema-check.txt`：21 条 message id 唯一；VenueSession=28、MarketDataV2=29；字段 30-39 无重复 |
| V-A0-04/05/06 | PASS | `SbeV2RoundTripTest`（MarketDataV2/VenueSession/execution V2） |
| V-A0-07 | PASS | `sbe-interop.log`：C++ codec、Java->C++、V2 codec 全通过 |
| V-A0-08 | PARTIAL | `VenueEnvelopeValidatorTest` 覆盖 fail-closed；未做真实 producer 缺字段注入 |
| V-A0-09 | PASS | schema check：id=29，旧 MarketData id=2 保留 |
| V-A0-10 | PARTIAL | 旧 consumer 无专门 id=29 拒绝用例 |
| V-A0-11 | PASS | `live-validate.txt` ORS inventory：SimNow 1100/2100-2103/2006，Shengli 1110/2110-2113/2013，SimVenue 1001/3140-3143/2014 |
| V-A0-12 | PASS | scratch reset 成功；T-060 migration 二次执行 `t060-idempotent.log` RC=0 |

## 3. A1 / A2 / B

| ID | 结果 | 证据 |
|---|---|---|
| V-A1-01/02 | PARTIAL | 统一 wire 单测/互操作通过；未回放录制的真实 CTP 帧 |
| V-01..V-12 | PASS | `VenueContractConformanceTest` 12 个用例全绿 |
| V-A2-01/02/04/05 | PASS | `VenuePortsTest` + registry fail-closed/capability 过滤 |
| V-A2-03 | PARTIAL | SQL 诊断可查冲突；未做 adapter 启动时冲突拒绝的集成用例 |
| V-A2-06 | PASS | live/scratch 均 0 position/MD/execution writer 冲突 |
| V-A2-07 | PARTIAL | adapter 参数与 ORS 一致性未做启动拒绝用例 |
| V-B-01 | PASS | 见 `live-validate.txt` |
| V-B-02 | PASS | 核心 Java 已无 `"SIMVENUE"` 行为分支；stream 字面量只保留在 adapter/常量/部署默认值 |
| V-B-03/04/05 | PARTIAL | SimNow 在线、Shengli STOPPED；双 CTP 同时在线未执行 |
| V-B-06 | PARTIAL | replay gateway 测试通过；未做 2102 注入拒绝用例 |
| V-B-08 | PASS | live/scratch validation 0 冲突 |

## 4. C1 / C2 / C3 / D

| ID | 结果 | 证据 |
|---|---|---|
| V-C1-04 | PASS | `docs/evidence/T-060/20261112-async-reject.md`：`900000000037` REJECTED，含 CTP ErrorID/ErrorMsg |
| V-C1-05 | PASS | 终端态保护代码 + `AeronOrderUpdateConsumerTest` |
| V-C1-08 | PARTIAL | 只有 SimNow 在线；两 CTP 同时隔离未执行 |
| V-C1-10 | PARTIAL | 断线重连未做真实 SimNow 演练 |
| V-C2-01/02/03 | PASS | SimVenue 测试 + 190 进程/stream + 干净重测 |
| V-C2-04/05 | PARTIAL | seed 可重放；calendar capability 未做 SimVenue 专项 E2E |
| V-C3-01/02/03 | PARTIAL | replay 单测通过；9001 slot/旧 session 丢弃未做完整 E2E |
| V-D-01..05 | PASS | `VenuePortsTest` |
| V-D-06 | PASS | C++ 只实现 wire，不实现 Java interface |
| V-D-07/08 | PARTIAL | feature flag/shadow compare 未演练 |

## 5. F / E / ACC

| ID | 结果 | 说明 |
|---|---|---|
| V-E-01 | PASS | `rg '"SIMVENUE"' backend/control-plane/src/main backend/runtime-runner/src/main backend/indicator-engine/src/main` 无输出 |
| V-E-02 | PASS（核心） | 无按 stream 字面量路由；`AeronStreams`/adapter 默认值除外 |
| V-F-01..04 | PARTIAL | 同一 conformance suite 已覆盖 V-01..12；未接全部真实 CTP/Replay 录制 |
| V-ACC-01..06 | NOT_RUN | 新 deployment/双 venue 同 stream/两 CTP/UI 新 venue/rollback 演练未执行 |

## 6. 本次发现并修复

1. `migrate-t060-venue-identity.sql` 仍把 SimVenue position 设为 0；改为 2014。
2. `reset-shadow.sh` 顺序错误：t046 在 seed 前执行，导致 orders.book_id NULL；改为 schema -> seed -> migrations。
3. `shadow-seed.sql` 未写 accounts.venue_id，未建 runtime_agents，trades 缺 account_id；已修。
4. `seed-t028-ors.sql` 缺 SimVenue ORS；已补 3140-3143/1001/2014。
5. `schema-shadow.sql` 的 trades 无唯一键，seed `ON CONFLICT (trade_id)` 失败；补 `uq_trades_trade_id`。
6. `TradingController` 的 venue 默认值和 `SIMVENUE` 分支改为 `VenueResolver`（账户绑定 + venue_type）。
7. `SimVenue` position 独立 2014；control-plane 同时订阅 2006/2014。

## 7. 仍缺的验收

- 双 CTP 同时在线隔离、SimShengli 夜盘（依赖开盘）。
- 真实 CTP 帧回放 / 断线重连 / 2102 注入拒绝。
- 两个 ORS 配同一 stream 的启动拒绝用例（目前是 SQL 诊断）。
- replay 9001 slot、旧 session、PITR 与 24h soak 最终 PASS。


## 8. V1 清理后的复核（2026-11-13 00:57）

| 检查 | 结果 |
|---|---|
| `to_regclass('indicator_defs')` / `indicator_values` | NULL |
| `to_regclass('indicator_engine')` | `indicator_engine` |
| `/api/v1/legacy-indicators` | 410，返回 replacement `/api/v1/indicators` |
| `/api/v1/strategy-center/strategies/TEST-STRAT-PAIR-01` | 200（指标读取改 V2 binding） |
| `/api/v1/manual/orders/preview`（blank venue） | 200 allowed=true（market fresh） |
| 仓位/账本 | positions=6，position_ledger=6 |
| venue recon | passed=true |

新增修复：
- `IndicatorRuntimeMain` 顶层 fail-fast：启动/续租失败 `System.exit(1)`，避免 Aeron 非 daemon 线程造成僵尸 JVM。
- `reset-shadow.sh` 全链路在 scratch DB 通过；V1 表和 V1 seed 已移除。

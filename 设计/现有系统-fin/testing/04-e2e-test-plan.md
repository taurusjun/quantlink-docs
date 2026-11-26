# 04 端到端测试计划与回归基线

- 状态：ACTIVE
- 日期：2026-11-11
- 范围：quantlink-fin V2 全链路（B1–B12）
- 环境基线：`https://101.43.54.190:8443`（SHADOW）
- 配套文件：
  - 回归映射 `docs/testing/e2e-regression-map.yaml`
  - 选择器 `tools/testing/regression_select.py`
  - 执行器 `tools/testing/run-regression.sh`
  - 只读 API 探测 `tools/testing/checks/api_readonly_check.py`
  - 只读 UI smoke `tools/e2e/readonly-smoke.mjs`

本文回答三件事：已有测试资产还能不能用、每个功能块现在靠什么回归、缺的用例长什么样。
所有“期望”都写成可断言的字段、HTTP 状态或日志关键字，不写“应该正常”。

> **读法**：`AUTO/MANUAL/NONE` 只表示“有没有可执行命令”，**不代表已经跑过**。
> 是否通过看第 3 节新增的「最近结果」列（PASS / FAIL / SKIP / NOT_RUN），
> 该列以 `docs/testing/last-run.json`（由 `run-regression.sh` 生成）为准。
>
> 本文新增的自动化资产：`tools/testing/checks/api_readonly_check.py`（只读 API 断言，
> 含价格不变量）与 `tools/e2e/readonly-smoke.mjs`（19 个路由的 UI smoke）。两者都不写数据。

---

## 1. 评审结论

### 1.1 一句话结论

用例文档的总量足够（253 条），但**可执行率低**：只有 37/70 条新编 E2E 用例有自动化命令覆盖，
历史文档里 03 与 PAIR 两份基本停留在“表格描述”，且基线仍在引用已退役的 SimLocal。
真正的资产是 129 条 Java 测试和 13 个 Playwright 脚本，但两者没有被组织成“按功能块回归”的入口。
本次补齐了映射、选择器、执行器和 2 条只读自动化探测，把“改了什么文件跑什么”变成一条命令。

### 1.2 资产打分

| 资产 | 用例/测试数 | 可执行性 | 自动化 | 主要问题 |
|---|---|---|---|---|
| `docs/testing/02-测试策略.md` | 0（规范） | 3/5 | — | L2/L4/L6/L7 无落地；环境变量名与实际不一致（`QF_PG_URL` vs `QF_IT_DB_URL`）；`dump-shadow.sh` 不存在 |
| `docs/testing/03-交易执行与开平仓测试用例.md` | 70 | 2/5 | 0/70 | 表格无断言字段与清理；“已知缺口：无今昨仓拆分”已过期；SimLocal 已退役 |
| `docs/testing/PAIR业务测试用例.md` | 112 | 2/5 | 约 6 条被单测间接覆盖 | 基线 `SIMLOCAL-001`/`ors-simlocal-001` 已退役；`P0-ORDER-02` 的 2120–2123 已改为 3140–3143 |
| `docs/testing/T-030-策略中心V2测试用例.md` | 71 | 3/5 | 约 8 条有脚本/单测 | 结构最好（有前置/步骤/期望），但无清理、无用例级执行结论 |
| `tools/e2e/*.mjs` | 13 脚本（12 既有 + 1 新增） | 4/5 | 10 只读 / 3 写 | `t030-pair.mjs` / `t030-lifecycle.mjs` 已改为唯一 ID、`QF_BASE_URL`/`QF_WEB_URL` 注入、失败 `exit(1)`、`finally` 删除策略/fork/指标/部署；在 SimVenue（隔离测试柜台）上纳入常规回归 |
| Java 测试 | 53 类 / 129 条 | 4/5 | 129 | 8 条默认 skipped；`ExecutionOffsetPolicy`、`ApprovalGuard`、`IndicatorPublisher` 无测试 |
| `.github/workflows/ci.yml` | 3 job + CTP 单测步骤 | 3/5 | — | `--tests` 只绑定到它前面那一个 test task；CI 的 `*IT` 步骤实际让控制面跑了全量（已实测，见 §7.10），建议改成逐 task 传参 |
| `tests/visual` | 2 spec | 3/5 | 有基线 | `webServer` 只起 web 不起控制面，本地无 8080 时全部 ECONNREFUSED；未进 CI |

### 1.3 过期清单（2026-11-11 已按 R8 修正）

| 位置 | 过期内容 | 处理 |
|---|---|---|
| `PAIR业务测试用例.md` §2 | 账户 `SIMLOCAL-001`、ORS `ors-simlocal-001`、策略 `PAIR-SIM-001` | 已改 `SIMVENUE-001` / `ors-simvenue-001` / `PAIR-SIMVENUE-001`，补 Agent 与流号 |
| `PAIR业务测试用例.md` P0-ORDER-02 | 订单流 2120/2121/2122/2123 | 已改 3140/3141/3142/3143，并注明“原 2120–2123 已废弃” |
| `PAIR业务测试用例.md` §H | “SimLocal 撮合模型” | 已改“SimVenue 撮合模型（原 SimLocal）”，写明独立进程 |
| `03-...测试用例.md` §1 已知缺口 | “`positions` 只有 long_qty/short_qty” | 已改为“缺口已关闭”，并指向 4 个今昨仓字段 |
| `03-...测试用例.md` §2.1 | “已停用夹具账户 已从系统删除” | 已删除该行，账户表改为 SIMVENUE-001 / TEST-001 / TEST-SHENGLI |
| `T-030-...测试用例.md` §2 | 基础数据 `SIMLOCAL-001` | 已改 SIMVENUE-001 / TEST-001 / TEST-SHENGLI，手工簿改 `MANUAL-SIMVENUE-001` |
| `02-测试策略.md` §2.2 | `tools/db/dump-shadow.sh` | 已改为实际脚本清单（reset/seed/backup/verify/apply-v2 + prepare-contract-db） |
| `02-测试策略.md` §8 | `QF_PG_URL` / `QF_CH_URL` | 已拆成“应用期”与“契约测试”两组，补 `QF_IT_DB_URL` |
| `tests/seed/shadow-seed.sql` | 账户 `SIMLOCAL-001` | 已改 `SIMVENUE-001` |
| `tests/seed/README.md` | 计划中的分表种子 | 已改为实际两个文件 |

各文档末尾均加“最后核对：2026-11-11”。

### 1.4 从未执行清单

| 资产 | 证据 | 结论 |
|---|---|---|
| `03-交易执行与开平仓测试用例.md` | 文件头写明“本文只定义测试，不代表已经执行”；无 evidence 目录 | 70 条全部未执行 |
| `PAIR业务测试用例.md` | 无状态、无执行记录；但 190 上存在 `PAIR-SIMVENUE-*` 策略，说明 `t030-pair.mjs` 跑过 | 约 10 条被 `t030-pair.mjs` 覆盖，其余未执行 |
| `T-030-策略中心V2测试用例.md` | `docs/evidence/T-030/README.md` 有 2026-11-09 自测记录与截图 | 约 20 条有证据，其余无用例级结论 |
| `tests/visual` | 有基线截图与历史 `diffs/.last-run.json`，本次尝试运行失败 | 未纳入 CI |
| `SchemaIntegrationTest` | 本地无 Docker，2 条 skipped | 本次未真正执行 |
| `ClickHouseIntegrationTest` | 无 ClickHouse 实例，1 条 skipped | 从未在本地执行 |

---

## 2. 功能块定义

| 块 | 名称 | 归属模块 |
|---|---|---|
| B1 | 行情链路（CTP Adapter → Aeron md → runner） | control-plane/market、runtime-runner、shared/aeron、sim-venue |
| B2 | 策略执行（pair / option_quoting / simple_hedging） | runtime/strategy、runtime-runner、control-plane/api |
| B3 | 本地风控（快照、fail-closed、限仓、价格偏离、节流） | runtime/risk、runtime-runner、control-plane/api |
| B4 | 下单与 ORS（Aeron order/cancel → ORS → CTP，回报/成交） | control-plane/aeron、ors-core、sim-venue、runtime/oms |
| B5 | 持仓/盈亏/结算（strategy_positions、position_ledger、PnL、closeout） | control-plane/ledger、reconciliation |
| B6 | 策略中心（CRUD、版本、fork、部署/激活/停止/回滚、生命周期） | control-plane/api、mapper、web/pages |
| B7 | 指标（Agent 计算 → 2012 → 控制面入库 → 时间戳） | runtime-runner/IndicatorPublisher、control-plane/market |
| B8 | 告警与消息（生成、去重、ack/all-ack、跨日） | control-plane/api、telemetry |
| B9 | 权限与审计（账户范围、SHADOW vs LIVE 审批、audit_log） | control-plane/config、api |
| B10 | Web UI（策略中心、告警、仪表盘、手工下单） | web/src、tools/e2e |
| B11 | 运维（market watch、归档/回放、定时任务、备份、健康检查） | control-plane/api、replay-gateway、tools/db |
| B12 | 配置契约（版本快照写入 → runner 读取 → 回滚） | control-plane/api、runtime-runner、shared/config |

编号规则：`E2E-<块>-<三位序号>`。序号在块内不重复，删除用例后编号不复用。

---

## 3. 覆盖矩阵

三个维度必须分开读：

- **自动化状态**：`AUTO` 有可执行命令 / `MANUAL` 有步骤但需人工或 190 / `NONE` 缺执行条件。
- **最近结果**：`PASS` / `FAIL` / `SKIP` / `NOT_RUN`，来自 `docs/testing/last-run.json`
  与本次实测（2026-11-11）。**AUTO ≠ 已通过**。
- **缺口**：该用例当前缺什么。

> 结果列的粒度：`run-regression.sh` 按命令记录状态，用例继承所属功能块的状态
> （`last-run.json` 的 `cases[].status`）。
>
> **两个来源**：矩阵里的「最近结果」是该用例**最近一次真正被执行**的结果（带时间，
> 含 10:33 线上探测）；`docs/testing/last-run.json` 是最近一次 `--all` 的完整快照
> （11:06，190 已不可用，故 B1/B3/B6/B7/B8/B9/B11 多为 SKIP/FAIL）。
> 两者不一致时以时间较晚者为准，且 **SKIP 表示环境不可用，不是回归失败**。
> 对齐命令：`python3 tools/testing/last_run_report.py [--block B6] [--commands]`。

### B1 行情链路（AUTO 2 / MANUAL 3 / NONE 0）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B1-001 | AUTO | PASS 11-11 | `api_readonly_check.py --suite ops`（market/status + marketFresh 自洽） |
| E2E-B1-002 | MANUAL | NOT_RUN | 缺：行情老化 → OPEN 被拒的自动化断言 |
| E2E-B1-003 | MANUAL | NOT_RUN | 缺：断行情不 fallback 他柜台价 |
| E2E-B1-004 | MANUAL | NOT_RUN | 缺：多柜台同合约不串价 |
| E2E-B1-005 | AUTO | PASS 11-11 | `tools/testing/ctp-price-test.sh`（DBL_MAX/NaN/Inf/负数/超界）+ `AeronMarketDataPriceTest` + `--suite market` |

### B2 策略执行（AUTO 3 / MANUAL 3 / NONE 0）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B2-001 | AUTO | PASS 11-11 | `FuturesPairStrategyTest.opensBothLegsWhenSpreadIsBelowAverage` |
| E2E-B2-002 | MANUAL | NOT_RUN | 缺：区间内不发单的 runner 级断言 |
| E2E-B2-003 | MANUAL | NOT_RUN | 缺：腿 2 对冲 FAK 的端到端断言 |
| E2E-B2-004 | AUTO | PASS 11-11 | `OptionQuotingStrategyTest.quotesBothSidesAroundTheo` |
| E2E-B2-005 | AUTO | PASS 11-11 | `SimpleHedgingStrategyTest.sellsFuturesWhenPortfolioDeltaIsPositive` |
| E2E-B2-006 | MANUAL | NOT_RUN | 缺：INACTIVE 策略只告警不下单 |

### B3 本地风控（AUTO 5 / MANUAL 2 / NONE 0）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B3-001 | MANUAL | NOT_RUN | `AeronOrderGateway.ready()` 的 fail-closed 无单测（190 观测到报错告警） |
| E2E-B3-002 | AUTO | PASS 11-11 | `api_readonly_check.py --suite risk`（pnlKnown/pnlSource 语义） |
| E2E-B3-003 | AUTO | PASS 11-11 | `RiskEngineTest.rejectsPriceDeviation` |
| E2E-B3-004 | AUTO | PASS 11-11 | `RiskEngineTest.rejectsLargeOrder` |
| E2E-B3-005 | AUTO | PASS 11-11 | `RiskEngineTest.rejectsPositionLimit` |
| E2E-B3-006 | MANUAL | NOT_RUN | 缺：`minOpenOrderIntervalMillis` 节流 |
| E2E-B3-007 | AUTO | PASS 11-11 | `PairSpreadRunnerTest` 的 5 个 alignPrice 用例 |

### B4 下单与 ORS（AUTO 3 / MANUAL 4 / NONE 1）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B4-001 | AUTO | PASS 11-11 | `ManualOrderPublisherTest.manualOrderReachesOrsGatewayOverAeron` |
| E2E-B4-002 | MANUAL | NOT_RUN | 缺：`Idempotency-Key` 幂等 |
| E2E-B4-003 | MANUAL | NOT_RUN | 缺：ORS 非 RUNNING 时 422 |
| E2E-B4-004 | AUTO | PASS 11-11 | `ManualOrderPublisherTest.cancelRequestReachesOrsGateway` |
| E2E-B4-005 | MANUAL | NOT_RUN | 缺：重复撤单 |
| E2E-B4-006 | MANUAL | NOT_RUN | 缺：Aeron 桥断 → `CANCEL_FAILED` |
| E2E-B4-007 | AUTO | PASS 11-11 | `AeronOrderUpdateConsumerTest` 的 fencing/stale 三条 |
| E2E-B4-008 | NONE | NOT_RUN | CTP ORS 未登录：`ors_instances.login_status` 只被写入，没有任何下单/部署路径读取它 |

### B5 持仓/盈亏/结算（AUTO 5 / MANUAL 1 / NONE 0）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B5-001 | AUTO | PASS 11-11 | `ExecutionLedgerServiceTest.appliesOneTradeAtomicallyAndIgnoresDuplicate` |
| E2E-B5-002 | AUTO | PASS 11-11 | `StrategyPositionServiceTest.closeableUsesStricterStrategyAndAccountLimit` |
| E2E-B5-003 | AUTO | PASS 11-11 | `CloseoutGuardTest.queuesOnceInsideTheCloseWindowAndSubmitsOnDrain` |
| E2E-B5-004 | AUTO | PASS 11-11 | `StrategyPositionServiceTest.applyFillClosesOnlyAttributedQuantity` |
| E2E-B5-005 | MANUAL | NOT_RUN | 缺：`strategy_pnl_snapshot` 的 as_of/source |
| E2E-B5-006 | AUTO | PASS 11-11 | `SettlementServiceTest.settlesLongAndShortSeparately` |

### B6 策略中心（AUTO 3 / MANUAL 6 / NONE 1）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B6-001 | AUTO（自清理） | PASS 11-11 | `t030-pair.mjs` 建策略 → 部署 → fork → finally 删除；SimVenue 隔离 |
| E2E-B6-002 | MANUAL | NOT_RUN | 缺：删除保护（ACTIVE/持仓/历史 → 409） |
| E2E-B6-003 | AUTO（自清理） | PASS 11-11 | `t030-pair.mjs` fork 断言（含指标 ID 重映射）；`finally` 删除副本 |
| E2E-B6-004 | AUTO | PASS 11-11 | `StrategyVersionContractIT`；断言已对齐新文案 `is owned by strategy` |
| E2E-B6-005 | MANUAL | NOT_RUN | 缺：换 Agent/ORS → 409 |
| E2E-B6-006 | MANUAL | NOT_RUN | 缺：有持仓改版本 → 409 carry |
| E2E-B6-007 | MANUAL | NOT_RUN | 缺：`/rollback` API 本身（IT 只验证 pin 后 runner 读取） |
| E2E-B6-008 | MANUAL | NOT_RUN | 缺：activate/deactivate/stop 状态机 |
| E2E-B6-009 | MANUAL | NOT_RUN | 缺：未分配认领（`t030-claim.mjs` 需夹具成交） |
| E2E-B6-010 | NONE | NOT_RUN | 无 VIEWER/TRADER 账号；执行 `tests/seed/viewer_trader_accounts.sql` 后可转 AUTO |

### B7 指标（AUTO 2 / MANUAL 5 / NONE 0）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B7-001 | AUTO | PASS 11-11 | `--suite indicators`（值 + value_ts） |
| E2E-B7-002 | AUTO | PASS 11-11 | `--suite indicators`（NO_DATA 断言，含 DEF-01 XFAIL） |
| E2E-B7-003 | MANUAL | NOT_RUN | 缺：指标写库不阻塞行情线程（需压测） |
| E2E-B7-004 | MANUAL | NOT_RUN | 缺：被策略引用的指标禁止禁用（409） |
| E2E-B7-005 | MANUAL | NOT_RUN | 新增：柜台隔离（两柜台同合约，指标只用绑定柜台价） |
| E2E-B7-006 | MANUAL | NOT_RUN | 新增：时效 STALE（单腿停更 > 60s） |
| E2E-B7-007 | MANUAL | NOT_RUN | 新增：并发灌 tick + 读指标（L2，不进 CI 主链路） |

### B8 告警与消息（AUTO 1 / MANUAL 6 / NONE 0）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B8-001 | MANUAL | NOT_RUN | 缺：告警生成 + WebSocket 推送 |
| E2E-B8-002 | AUTO | FAIL（DEF-02） | `--suite alerts`（同键 NEW ≤ 3，当前 50） |
| E2E-B8-003 | MANUAL | NOT_RUN | 缺：ack 幂等 |
| E2E-B8-004 | MANUAL | NOT_RUN | 缺：silence 窗口 |
| E2E-B8-005 | MANUAL | NOT_RUN | 缺：7 天清理 |
| E2E-B8-006 | MANUAL | NOT_RUN | 缺：ack 后 30 分钟内静默 |
| E2E-B8-007 | MANUAL | NOT_RUN | 新增：DEF-02 修复后的去重回归（reason_code 稳定，ageMs 只进 message） |

### B9 权限与审计（AUTO 1 / MANUAL 0 / NONE 3）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B9-001 | NONE | NOT_RUN | 无 VIEWER/TRADER 矩阵；seed 后可用 `--suite access` + 手工补全 |
| E2E-B9-002 | NONE | NOT_RUN | 无跨账户用户；seed 后 `--suite access` 的 viewer 段可覆盖 |
| E2E-B9-003 | NONE | NOT_RUN | 当前只有 SHADOW，LIVE 审批分支不可执行 |
| E2E-B9-004 | AUTO | PASS 11-11 | `--suite access`（audit 字段） |

### B10 Web UI（AUTO 5 / MANUAL 0 / NONE 0）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B10-001 | AUTO | PASS 11-11 | `readonly-smoke.mjs` + `t030-smoke.mjs`；19 页面 0 失败 |
| E2E-B10-002 | AUTO | NOT_RUN | `t030-manual-preview.mjs`；未执行 |
| E2E-B10-003 | AUTO | PASS 11-11 | `readonly-smoke.mjs` `/alerts`；19 页面 0 失败 |
| E2E-B10-004 | AUTO | PASS 11-11 | `readonly-smoke.mjs` `/`；19 页面 0 失败 |
| E2E-B10-005 | AUTO | PASS 11-11 | `readonly-smoke.mjs` venueSelectorCount == 0；19 页面 0 失败 |

### B11 运维（AUTO 3 / MANUAL 1 / NONE 1）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B11-001 | AUTO | PASS 11-11 | `--suite ops`（system/status） |
| E2E-B11-002 | AUTO | PASS 11-11 | `--suite ops`（scheduled-jobs 结构） |
| E2E-B11-003 | AUTO | PASS 11-11 | `:backend:replay-gateway:test` |
| E2E-B11-004 | MANUAL | NOT_RUN | 缺：手动触发 + 审计 |
| E2E-B11-005 | NONE | NOT_RUN | 无独立恢复库，备份演练不可执行 |

### B12 配置契约（AUTO 5 / MANUAL 0 / NONE 0）

| 用例 | 状态 | 最近结果 | 覆盖命令 / 缺口 |
|---|---|---|---|
| E2E-B12-001 | AUTO | PASS 11-11 | `StrategyVersionContractIT` |
| E2E-B12-002 | AUTO | PASS 11-11 | `DeploymentVersionConfigIT.rollbackChangesTheConfigTheRunnerLoads` |
| E2E-B12-003 | AUTO | PASS 11-11 | `StrategyConfigValidatorTest` |
| E2E-B12-004 | AUTO | PASS 11-11 | `StrategyVersionContractIT.versionApiRejectsConfigTheRunnerCannotStart` |
| E2E-B12-005 | AUTO | PASS 11-11 | `StrategyVersionContractIT.versionTableRejectsDuplicateVersionNumbers` |

### 统计

| 状态 | 数量 | 占比 | 说明 |
|---|---|---|---|
| AUTO | 38 | 50.7% | 有命令，不等于通过 |
| MANUAL | 31 | 41.3% | 需 190 / 人工 / 压测 |
| NONE | 6 | 8.0% | 缺环境或功能 |
| 合计 | 75 | 100% | |

| 最近结果 | 数量 |
|---|---|
| PASS | 29 |
| FAIL | 2（B8-002 / DEF-02；B6-004 / 他人未提交用例） |
| SKIP | 4（B10，190 不可达） |
| NOT_RUN | 40 |

## 4. 端到端用例规格

环境代号：

- `SV` = SimVenue，账户 `SIMVENUE-001`，ORS `ors-simvenue-001`，Agent `agent-simvenue-01`，流 3140/3141/3142/3143/1001。
- `SN` = SimNow，账户 `TEST-001`，ORS `ors-simnow-test-001`，**仅日盘**。
- `SL` = SimShengli，账户 `TEST-SHENGLI`，ORS `ors-shengli-test-shengli`，**仅日盘**，`PRODUCTION_MODE=0`。
- `LOCAL` = 本地 Gradle/契约库，不碰 190。

### B1 行情链路

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B1-001 | 正常 | 行情在 5s 内到达且新鲜度自洽 | SV | `agent-simvenue-01` ONLINE、`ors-simvenue-001` RUNNING、sim-venue 发布 1001 | 1) `GET /api/v1/system/status` ×3，间隔 1s；2) `GET /api/v1/market/status` | ① 三次响应 `controlPlane=="UP"`；② 至少两次 `marketAgeMs < 5000`；③ 每次 `marketFresh == (0 <= marketAgeMs < 5000)`；④ `market/status` 返回 `instruments > 0` 且 `sessions >= 1` | 无 | 否 |
| E2E-B1-002 | 边界 | 行情老化时开仓被拒、平仓不受影响 | SV | 同 B1-001；自然休市或暂停 sim-venue md | 1) 等到 `marketAgeMs > 5000`；2) `GET /api/v1/system/status`；3) `POST /api/v1/manual/orders/preview`（`OPEN`，ag2612，1 手，价格 = 最新价） | ① `marketFresh == false`；② preview `allowed == false`；③ `reasons` 含 `行情已过期` 或 `缺少最新行情`；④ `orders` 表行数不变 | 恢复 md | 是（仅动行情，不下单） |
| E2E-B1-003 | 失败 | 断行情不 fallback 其他柜台价格 | SV + SN | 两柜台均有 ag2612；断 SV md | 1) `GET /api/v1/strategy-center/strategies/{SV 策略}`；2) 同时读 `{SN 策略}` | ① SV 策略 `quotes` 不含 ag2612（或 `timestampMs` 已超 5s 且无新值）；② SV 策略 `quotes.ag2612.lastPrice` **不得等于** SN 的 `lastPrice`；③ 手工 preview 返回 `allowed=false` | 恢复 md | 是 |
| E2E-B1-004 | 正常 | 同合约不同柜台不串价 | SV + SN | 两柜台 ag2612 报价不同 | 1) 分别 `GET /api/v1/strategy-center/strategies/{A}`、`{B}`，A 绑 SV、B 绑 SN | ① 两个 `quotes` 的 `counterpartyId` 分别是 `SIMVENUE` / `SIMNOW`；② `lastPrice` 不相等；③ 每个 quote 的 `timestampMs` 单调递增 | 无 | 否 |
| E2E-B1-005 | 失败 | 适配器不得把 DBL_MAX 当价格发布 | LOCAL + SV | `ctp-adapter/src/price_sanitize.h`；CTP 空档位返回 `DBL_MAX` | 1) `bash tools/testing/ctp-price-test.sh`；2) 190：`GET /api/v1/market/ticks?counterpartyId=SIMSHENGli&exchange=SHFE&instrumentId=au2612`（或任一曾出现空档位的合约）；3) `--suite market` | ① C++ 单测输出 `price sanitizer ok`，exit 0；② API 返回的 `lastPrice/bidPrice/askPrice` 满足 `isfinite && v>=0 && v<1e12`，且 `lastPrice>0`；③ 不得出现 `1.7976931348623157e+308`；④ 若该档位无报价应为 `0` 而不是哨兵值 | 无 | 否 |

### B2 策略执行

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B2-001 | 正常 | PAIR 在价差低于均值时建双腿 | LOCAL + SV | 策略 `TEST-PAIR`，leg1=ag2612、leg2=ag2706，`mode=SHADOW` | 1) 跑 `FuturesPairStrategyTest`；2) SV 场景：喂 longSpread < avg-BEGIN_PLACE | ① 单测：两条腿都产生 BUY 意图；② SV：`orders` 出现 leg1 `BUY OPEN`，`strategy_id=TEST-PAIR` | 删 `TEST-PAIR` 及其订单 | 是 |
| E2E-B2-002 | 边界 | 价差在区间内不发单 | LOCAL | avg=50，longSpread=48、shortSpread=52 | 跑策略单 tick | ① 无 `OrderIntent`；② `orders` 不新增 | 无 | 否 |
| E2E-B2-003 | 正常 | 腿 1 成交后腿 2 FAK 对冲 | SV | leg1 多 1、leg2 0 | 1) 手工制造 leg1 成交；2) 等 2 个 tick；3) 查 `orders` | ① 出现 leg2 `SELL OPEN`；② `time_in_force=="FAK"`；③ `price` 为合法 tick（`price % tick == 0`）；④ `qty == 1` | 平掉双腿 | 是 |
| E2E-B2-004 | 正常 | 期权做市双边报价 | LOCAL | `OptionQuotingStrategyTest` 夹具 | 跑单测 | ① 同时产生 bid/ask 两条意图；② 价格围绕 theo 且 tick 对齐 | 无 | 否 |
| E2E-B2-005 | 正常 | Delta 为正时卖出期货对冲 | LOCAL | `SimpleHedgingStrategyTest` 夹具 | 跑单测 | ① 产生 SELL 意图；② 数量 = 对冲比例 × abs(delta) | 无 | 否 |
| E2E-B2-006 | 失败 | 非 ACTIVE 只告警不下单 | SV | 策略 `deployment=INACTIVE` | 1) 触发信号；2) 查 `orders` 与 `/api/v1/strategy/alerts` | ① `orders` 不新增；② 告警表新增 `reason` 含 `INACTIVE`；③ 无 HTTP 5xx | 删除告警 | 否 |

### B3 本地风控

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B3-001 | 失败 | 风控快照过期时 OPEN fail-closed | SV | runner 已加载风险，`riskMaxAgeMillis=15000`；阻断 `/api/v1/strategy-runtime/risk` 刷新 20s | 1) 等 20s；2) 让策略发 OPEN | ① runner 日志含 `local risk snapshot is stale; loaded=true ageMs=`；② `orders` 无新 OPEN；③ `strategy_alerts.reason` 含同一句；④ CLOSE 仍可提交成功 | 恢复刷新 | 是 |
| E2E-B3-002 | 边界 | PnL 未知时禁止 OPEN | SV | Agent 未发布 PnL | 1) `GET /api/v1/strategy-runtime/risk?strategyId=X`；2) 触发 OPEN | ① `pnlKnown == false`；② `pnlSource == "NO_AGENT_DATA"`；③ OPEN 被拒（日志 `agent PnL is not available yet; OPEN is fail-closed`） | 无 | 否 |
| E2E-B3-003 | 失败 | 价格偏离 > 5% 拒单 | LOCAL | 最新价 100，报 106 | 跑 `RiskEngineTest` | ① `allowed == false`；② `reason == "price deviation exceeded"`；③ 若走手工单，preview `reasons` 含 `价格偏离最新价超过 5%` | 无 | 否 |
| E2E-B3-004 | 失败 | 单笔超限拒单 | LOCAL | `maxOrderQty=5`，报 6 手 | 跑 `RiskEngineTest` | `reason == "max order qty exceeded"` | 无 | 否 |
| E2E-B3-005 | 失败 | 超持仓上限拒单 | LOCAL | `maxPosition=5`，已有 5 手 | 跑 `RiskEngineTest` | `reason == "max position exceeded"` | 无 | 否 |
| E2E-B3-006 | 边界 | 开仓节流 | SV | `minOpenOrderIntervalMillis=1000` | 1s 内连发两笔 OPEN | ① 第二笔被拒；② 日志含 `opening order rate limit: 1000ms`；③ `orders` 只增 1 条 | 撤单 | 是 |
| E2E-B3-007 | 边界 | tick 对齐按方向取整 | LOCAL | tick=0.5，价格 100.25 | 跑 `PairSpreadRunnerTest` | ① BUY → 100.5；② SELL → 100.0；③ 合法 tick 不变 | 无 | 否 |

### B4 下单与 ORS

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B4-001 | 正常 | 手工单经 Aeron 到 ORS 并落库 | SV | `aeronConnected=true` | 1) `POST /api/v1/manual/orders`（ag2612，B，1 手，合法 tick）；2) 轮询订单 | ① HTTP 200 且返回 `clientOrderId`；② `orders.status` 从 `NEW` → `OPEN/FILLED`；③ `request_id` 与请求头一致；④ `trades` 与 `orders.filled_qty` 一致 | 撤单/平仓 | 是 |
| E2E-B4-002 | 边界 | 重复 Idempotency-Key 不重复下单 | SV | 同 B4-001 | 1) 带 `Idempotency-Key: K1` 下单；2) 同 key 再发一次 | ① 第二次 `duplicate == true`；② `clientOrderId` 相同；③ `orders` 只增 1 条 | 撤单 | 是 |
| E2E-B4-003 | 失败 | ORS 非 RUNNING 拒绝部署 | SV | 停 `ors-simvenue-001`（不重启，只读校验用已停实例） | `POST /api/v1/strategy-deployments` | ① HTTP 422；② body 含 `ORS is not RUNNING`；③ 无 `strategy_deployments` 新行 | 无 | 否（只读校验） |
| E2E-B4-004 | 正常 | 撤单到达 ORS | LOCAL/SV | 存在 OPEN 单 | 1) `POST /api/v1/strategy/orders/{id}/cancel`；2) 轮询 | ① 状态先 `CANCEL_REQUESTED` 再 `CANCELED`；② 不得直接 `CANCELED` | 无 | 是 |
| E2E-B4-005 | 边界 | 重复撤单幂等 | SV | 已 `CANCELED` 的单 | 再撤一次 | ① 返回 200 且状态仍 `CANCELED`，或 409；② 不得产生第二条撤单消息（`cancel` 流计数不变） | 无 | 是 |
| E2E-B4-006 | 失败 | 撤单发送失败标记 CANCEL_FAILED | SV | 断 Aeron cancel 流 | 撤单 | ① `orders.status == "CANCEL_FAILED"`；② 页面可见；③ 不得显示 `CANCELED` | 恢复 | 是 |
| E2E-B4-007 | 失败 | 旧回报不覆盖新成交 | LOCAL | 新 ORS `FILLED` 后旧 ORS 发 `CANCELED` | 跑 `AeronOrderUpdateConsumerTest` | ① fencing 不符 → `FENCED` + 告警；② `generation` 落后 → `STALE_UPDATE` + 告警；③ 状态保持 `FILLED` | 无 | 否 |
| E2E-B4-008 | 失败 | ORS 未登录禁止开仓 | SN/SL | `ors_instances.login_status = NOT_LOGGED_IN`，`status = RUNNING` | 1) `POST /api/v1/manual/orders/preview`（OPEN，CTP 柜台）；2) `POST /api/v1/strategy-deployments` | 期望：① preview `allowed=false` 且 `reasons` 含 `未登录`；② 部署 422。**现状**：两条路径都只判断 `status='RUNNING'`，`login_status` 未被读取，因此该断言当前必然失败（功能缺口） | 无 | 否 |

### B5 持仓/盈亏/结算

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B5-001 | 正常 | 成交幂等入账且缺订单进 UNASSIGNED | LOCAL | trade 无对应 order | 跑 `ExecutionLedgerServiceTest` | ① 重复 `tradeId` 只入账一次；② 缺 order → `unassigned_trade` 有行，不丢成交 | 无 | 否 |
| E2E-B5-002 | 边界 | 可平量取策略与账户的严格值 | LOCAL | 策略归属 2、账户 5 | 跑 `StrategyPositionServiceTest` | ① `closeable == 2`；② 不出现负持仓 | 无 | 否 |
| E2E-B5-003 | 正常 | 收盘窗口内每次会话只平一次 | LOCAL | 持仓 2 手，窗口内 | 跑 `CloseoutGuardTest` | ① `evaluate` 两次只入队 1 条；② `drain()` 提交 1 条 SELL/CLOSE/FAK；③ 无报价时不下单（`no scoped tick`） | 无 | 否 |
| E2E-B5-004 | 失败 | 平仓不得超出归属 | LOCAL | 归属 1，请求平 2 | 跑 `StrategyPositionServiceTest` | ① 抛 `STRATEGY_POSITION_INSUFFICIENT`；② 只平归属量 | 无 | 否 |
| E2E-B5-005 | 正常 | 策略 PnL 快照带 as_of/source | SV | 策略有持仓与成交 | 1) `GET /api/v1/strategies/{id}/pnl`；2) 查 `strategy_pnl_snapshot` | ① 返回 `asOf` 非空；② `source` 非空；③ 快照行数随时间增长；④ 平仓后已实现 PnL 保留 | 无 | 否 |
| E2E-B5-006 | 正常 | 日终结算 today→yesterday | LOCAL | 多空各 1 手 | 跑 `SettlementServiceTest` | ① 多空分别结算；② 重复结算不重复动资金 | 无 | 否 |

### B6 策略中心

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B6-001 | 正常 | 建策略 → 配对配置 → 部署 → 激活 | SV | `ors-simvenue-001` RUNNING | 1) `POST /api/v1/strategies`；2) `PUT .../pair-config`；3) `POST /api/v1/agents/agent-simvenue-01/strategies`；4) `POST /api/v1/strategy-deployments`；5) `POST /api/v1/strategies/{id}/status` | ① 每步 HTTP 200；② deployment 返回 `generation=1`、`status=INACTIVE`；③ 策略 `bound_account_id=SIMVENUE-001`；④ overview 中 `target` 含双腿 | 删除策略与部署（脚本 finally 自动清理） | 否 |
| E2E-B6-002 | 失败 | 删除保护 | SV | 策略处于 ACTIVE | `DELETE /api/v1/strategy-center/strategies/{id}` | ① HTTP 409；② body 含 `策略处于 ACTIVE`；③ `strategies` 行仍在。有持仓时 body 含 `策略仍有持仓`；有历史时含 `删除会破坏归属` | 无 | 否 |
| E2E-B6-003 | 正常 | Fork 不继承绑定/持仓/PnL | SV | 已绑定且有持仓的策略 | `POST .../fork` | ① 新 `strategyId`；② `parentStrategyId` 指向源；③ 新策略 `accountId/agentId/orsId` 均为空；④ `positions` 为空 | 删除 fork | 是 |
| E2E-B6-004 | 正常 | 版本行是完整快照 | LOCAL | 契约库 | `PUT /api/v1/strategy-center/strategies/{id}/versions` | ① 新版本 `config_json` 含旧字段 + 新字段（不是 patch）；② `strategies.current_version` 更新；③ runner `DeploymentConfigLoader.load()` 读到新值 | 清理 IT 夹具 | 否 |
| E2E-B6-005 | 失败 | 换绑定上下文被拒 | SV | 策略已绑 SV | 部署到 `ors-simnow-test-001` | ① HTTP 409；② body 含 `STRATEGY_BOUND_TO_CONTEXT`；③ 四个 bound 字段不变 | 无 | 否 |
| E2E-B6-006 | 失败 | 有持仓改版本需 carry | SV | 策略有持仓，`current_version=v1` | 部署 `v2` 且不带 `carry` | ① HTTP 409；② body 含 `POSITION_CARRY_CONFIRMATION_REQUIRED`；③ 带 `carry=true` 后 200 | 无 | 是 |
| E2E-B6-007 | 正常 | 回滚回到上一版本 | SV | 有 ≥2 条 history | `POST /api/v1/strategy-deployments/{id}/rollback` | ① 返回 `rolledBackTo` 为上一版本；② `generation` 增大；③ `strategies.current_version` 同步；④ `audit_log` 有 `DEPLOY_ROLLBACK` | 无 | 是 |
| E2E-B6-008 | 正常 | 停止状态机 | SV | 部署 ACTIVE | `POST /{id}/deactivate` → `POST /api/v1/strategies/{id}/status` | ① deactivate 返回 `INACTIVE`；② 直接置 ACTIVE 返回 409（必须走 deployment）；③ `audit_log` 有 `DEPLOY_DEACTIVATE` | 无 | 是 |
| E2E-B6-009 | 正常 | 未分配成交认领 | SV | `unassigned_trade` 1 条 OPEN | `POST /api/v1/strategy-center/unassigned/{tradeId}/claim` | ① 200；② `trades.book_id` 变更；③ `position_assignment` 新增；④ `audit_log` 有 `UNASSIGNED_ASSIGN`；⑤ 再次认领 409 `trade already claimed` | 删除夹具成交 | 是 |
| E2E-B6-010 | 失败 | 越权访问策略详情 | — | 需要非授权账户的 VIEWER | `GET .../strategies/{id}` with viewer | ① 403；② 不返回空列表伪装成功 | — | 否 |

### B7 指标

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B7-001 | 正常 | Agent 发布的指标带值和时间戳 | SV | 至少 1 个 enabled 指标，策略 ACTIVE | `GET /api/v1/indicators` | ① 每个 enabled 指标 `value != null` 或 `status == "NO_DATA"`；② 有值时 `value_ts` 可解析；③ `value_version >= 1` | 无 | 否 |
| E2E-B7-002 | 边界 | 未采集不显示空白 | SV | 新建指标但 runner 未启动 | `GET /api/v1/strategy-center/strategies/{id}` | ① `indicators` 长度 ≥ 1；② 未采集项 `value` 为 null 且 `status == "NO_DATA"`；③ 不出现缺字段 | 删除指标 | 是 |
| E2E-B7-003 | 边界 | 指标写库不阻塞行情 | SV | 指标队列打满 | 压测 10s | ① 行情 `marketAgeMs` 仍 < 5000；② 日志有丢弃计数；③ 不出现线程阻塞告警 | 无 | 是（压测） |
| E2E-B7-004 | 失败 | 被策略引用的指标禁止禁用 | SV | 指标 `strategy_id` 非空 | `PUT /api/v1/indicators/{id}` `enabled=false` | ① HTTP 409；② body 含 `indicator is referenced by a strategy` | 无 | 否 |
| E2E-B7-005 | 正常 | 指标只用绑定柜台的价格（柜台隔离） | SV + SL | ag2612 在 SIMVENUE 与 SIMSHENGli 同时有 tick，价格不同；策略 `TEST-PAIR` 绑 SIMVENUE | 1) 1s 内两个柜台各推 5 个 tick；2) `GET /api/v1/indicators` 过滤 `strategy_id=TEST-PAIR` 的 `PAIR_SPREAD`；3) `GET /api/v1/strategy/pair-state/TEST-PAIR` | ① 指标值等于用 SIMVENUE 两侧 mid 计算的价差，误差 ≤ 1 tick；② 不等于用 SIMSHENGli 价格算出的值；③ `pair-state.state_json` 的 `leg1Bid/leg1Ask` 与 SIMVENUE 报价一致；④ 副本策略的指标 id 指向自己的 `strategy_id`，不复用源策略 id | 删除夹具策略/指标 | 是 |
| E2E-B7-006 | 边界 | 单腿停更 → STALE，恢复后重算 | SV | 腿 2 停止推 tick > 60s，腿 1 正常 | 1) 停 leg2 md；2) 等 65s；3) 读指标；4) 恢复 leg2 再等 5s | ① `status=="STALE"`（不是 OK）；② `message` 含停更腿与 `age`；③ 恢复后 `status` 回到 `OK/WARMUP`，且 z-score 历史窗口被清空后重新累积；④ 期间不出现用旧 leg2 价格算出的新值 | 恢复 md | 是 |
| E2E-B7-007 | 边界 | 并发灌 tick 与读指标不串值 | LOCAL | 4 线程 × 5000 tick，2 个柜台同合约 | JMH/单测并发跑 30s，同时 10 线程 `GET /api/v1/indicators` | ① 无异常、无死锁；② 每个样本都能追溯到唯一柜台；③ 不存在同一 `value_version` 对应两个不同值；④ 队列满时丢弃并计数，不阻塞行情线程 | 无 | 否（L2，不进 CI 主链路） |

### B8 告警与消息

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B8-001 | 正常 | 告警生成并推送 | SV | INACTIVE 策略产生信号 | `POST /api/v1/strategy/alerts` | ① 返回 `alertId` + `status=NEW`；② `created_at` 有值；③ WS 收到 `type=strategy-alert` | 删除告警 | 是 |
| E2E-B8-002 | 边界 | 同键告警去重 | SV | 同一 strategy/instrument/side/reason | 连续发 10 次 | ① 第一次 NEW；② 后续返回 `duplicate=true` 且 `alertId` 相同；③ 表内同键 NEW ≤ 1 | 删除告警 | 是 |
| E2E-B8-003 | 边界 | ack 幂等 | SV | NEW 告警 | `POST /{id}/ack` 两次 | ① 第一次 200 `status=ACK`；② 第二次 200 `duplicate=true`；③ 不返回 404 | 无 | 是 |
| E2E-B8-004 | 边界 | silence 窗口内抑制 | SV | NEW 告警 | `POST /{id}/silence {minutes:10}` 后再生成同键 | ① 返回 `silencedMinutes=10`；② 再生成返回 `status=SILENCED`、`silenced=true` | 取消静默 | 是 |
| E2E-B8-005 | 边界 | 7 天清理 | LOCAL | 造 8 天前告警 | 跑 `purgeOldAlerts()` | ① 8 天前的行被删；② 7 天内保留 | 无 | 否 |
| E2E-B8-006 | 边界 | ack 后 30 分钟内静默 | SV | ACK 告警 | 5 分钟内再生成同键 | ① 返回 `status=ACK`、`muted=true`；② 不新增行 | 无 | 是 |
| E2E-B8-007 | 边界 | 去重键不含动态数值（DEF-02 回归） | SV | 同一 `(strategy_id, instrument_id, side, reason_code)`；`ageMs` 每次不同 | 连续 `POST /api/v1/strategy/alerts` 5 次，reason 用 `RISK_SNAPSHOT_STALE`，message 里带不同 `ageMs` | ① 只产生 1 条 `NEW`；② 后 4 次返回 `duplicate=true` 且 `alertId` 相同；③ `message` 保留最新 `ageMs`；④ ack 后 30 分钟内再发同键 → `muted=true`；⑤ silence 生效期间 → `SILENCED` | 删除夹具告警 | 是 |

### B9 权限与审计

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B9-001 | 正常 | VIEWER/TRADER/ADMIN 矩阵 | — | 三个账号 | 分别访问策略/订单/下单/应急 | ① VIEWER 只能 GET，POST 403；② TRADER 只能操作授权账户；③ ADMIN 无交易权时下单 403 | — | 否 |
| E2E-B9-002 | 失败 | 账户范围过滤 | — | 用户只授权 SIMVENUE | `GET /api/v1/strategy-center/overview` | ① `accounts` 只含 SIMVENUE-001；② 访问他账户策略 403；③ 不返回空列表 | — | 否 |
| E2E-B9-003 | 失败 | LIVE 高风险动作需审批 | LIVE | `qf.environment=LIVE` | `POST /{id}/activate` 不带审批头 | ① HTTP 428 且 body 含 `LIVE change requires X-Approval-Id`；② 带他人已批 ID 通过；③ 带自己审批 412 | — | 否 |
| E2E-B9-004 | 正常 | 审计字段完整 | SV | 已有写操作 | `GET /api/v1/audit` | ① 每行含 `actor/action/target/created_at`；② 关键动作可见 `DEPLOY_ACTIVATE`、`STRATEGY_VERSION`、`UNASSIGNED_ASSIGN` | 无 | 否 |

### B10 Web UI

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B10-001 | 正常 | 策略中心渲染 | SV | `test_admin` | `node tools/e2e/readonly-smoke.mjs` | ① `/strategy-center` body 含 `策略中心`；② 无 `pageerror`；③ 无 5xx；④ `[data-testid="venue-selector"]` 计数为 0 | 无 | 否 |
| E2E-B10-002 | 正常 | 手工单预览 | SV | ag2612 有行情 | `node tools/e2e/t030-manual-preview.mjs` | ① `POST /api/v1/manual/orders/preview` 200；② `notional` 是数字；③ 页面出现 `名义 ... 保证金`；④ 无 pageerror | 无 | 否 |
| E2E-B10-003 | 正常 | 告警页渲染 | SV | 有 NEW 告警 | readonly-smoke `/alerts` | ① body 含 `消息中心`；② 无 5xx | 无 | 否 |
| E2E-B10-004 | 正常 | 驾驶舱渲染 | SV | 有策略 | readonly-smoke `/` | ① body 含 `交易驾驶舱`；② 无 5xx | 无 | 否 |
| E2E-B10-005 | 边界 | 顶部柜台选择器已移除 | SV | — | 遍历 19 个路由 | ① 所有页面 `venue-selector` 计数 0；② 无页面依赖 `qf_venue` | 无 | 否 |

### B11 运维

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B11-001 | 正常 | 健康状态是真值 | SV | 三 Agent 在线 | `GET /api/v1/system/status` | ① `controlPlane=="UP"`；② `environment in {SHADOW,LIVE}`；③ `marketFresh` 与 `marketAgeMs` 自洽；④ `orsRunning` 为布尔 | 无 | 否 |
| E2E-B11-002 | 正常 | 定时任务清单可用 | SV | `scheduled_jobs` 有行 | `GET /api/v1/scheduled-jobs` | ① 非空；② 每行含 `jobKey`、`nextRunAt`、`lastStatus`；③ `nextRunAt` 可解析 | 无 | 否 |
| E2E-B11-003 | 正常 | 回放网关可解析并发布 | LOCAL | U50 CSV 夹具 | `:backend:replay-gateway:test` | ① CSV 解析行数 > 0；② 发布到 1001 的消息可被解码 | 无 | 否 |
| E2E-B11-004 | 正常 | 手动触发任务并留审计 | SV | 任一 INTERNAL 任务 | `POST /api/v1/scheduled-jobs/{key}/run` | ① 返回 run id；② `runs` 出现新行；③ `audit_log` 有触发记录 | 无 | 是 |
| E2E-B11-005 | 正常 | 备份与恢复演练 | — | 独立恢复库 | `tools/db/backup.sh` → 恢复 | ① 行数一致；② 恢复库可启动控制面 | — | 是 |

### B12 配置契约

| ID | 类型 | 目标 | 环境 | 前置数据 | 步骤 | 期望（可断言） | 清理 | 破坏性 |
|---|---|---|---|---|---|---|---|---|
| E2E-B12-001 | 正常 | 写版本 → runner 读到 | LOCAL | `qf_it_config_shadow` | 跑 `StrategyVersionContractIT` | ① 版本行是完整快照（含 `underlying`）；② `DeploymentConfigLoader.load()` 读到 `optionId=au2612C920`；③ `version=v2` | IT 自清理 | 否 |
| E2E-B12-002 | 正常 | 回滚改变 runner 读取 | LOCAL | 同上 | 跑 `DeploymentVersionConfigIT.rollbackChangesTheConfigTheRunnerLoads` | ① pin `v1` 后读到 `au2612C900`；② `version=v1` | 还原 v2 | 否 |
| E2E-B12-003 | 失败 | 非法配置保存被拒 | LOCAL | `option_quoting` 缺 `optionId` | 跑 `StrategyConfigValidatorTest` / `PUT .../versions` | ① HTTP 400；② body 含 `optionId`；③ `strategy_versions` 无新行 | 无 | 否 |
| E2E-B12-004 | 失败 | 部署前校验同一规则 | SV | 同上 | `POST /api/v1/strategy-deployments` | ① HTTP 400；② 不创建 deployment | 无 | 否 |
| E2E-B12-005 | 边界 | 版本号唯一 | LOCAL | 已存在 `v-dup` | 重复插入 | ① SQLSTATE `23505`；② 不产生第二行 | 删除 | 否 |

---

## 5. 已知缺陷（本次实测发现）

### DEF-2026-11-11-01 启用指标可能既无 value 也无 status（已修复 2026-11-11 18:10）

- 现象：`GET /api/v1/indicators` 中 `enabled=true` 的
  `STRAT-SIMNOW-PAIR-VEDO8-delta-1`、`STRAT-SIMNOW-PAIR2-VFKM4-delta-1`
  两条记录 `value=null`、`status=null`，其余 12 条状态正常。
- 影响：策略详情“指标”区无法区分“未采集”和“没这个指标”，违反
  `T-030 TC-068/TC-070` 的“不得显示空白”。
- 断言位置：`tools/testing/checks/api_readonly_check.py` 的
  `启用指标要么有 value 要么 status=NO_DATA` 与 `status 在 OK/WARN/CRIT/NO_DATA/STALE 内`。
- 修复：`IndicatorMapper` 读取层 `COALESCE(v.status,'NO_DATA')`；并补齐 DELTA 生产者
  （净持仓 × 每手 delta，期货=1，期权按策略配置做 Black-Scholes）。
- 验证：`STRAT-SIMNOW-PAIR-VEDO8-delta-1`、`...VFKM4-delta-1` 返回 `0.0 / OK`。
- 待办：从 `KNOWN_DEFECTS` 删除这两条（探测脚本下次运行时确认）。

### DEF-2026-11-11-02 告警去重实际失效（已修复 2026-11-11 18:05）

- 现象：190 上同一策略/合约/方向连续产生 50+ 条 `status=NEW` 告警，
  `reason` 形如 `PAIR order rejected: local risk snapshot is stale; loaded=true ageMs=153989 maxAgeMs=15000`。
- 根因：去重键是 `(strategy_id, instrument_id, side, reason)`，而 `reason`
  里带了每次变化的 `ageMs`，导致每条都是新键。
- 影响：告警页刷屏，交易员无法识别“同一个故障”；`PAIR-DATA-005` 的
  “同策略/合约/方向不重复刷屏”不成立。
- 建议：去重键改用稳定的 reason code（如 `RISK_SNAPSHOT_STALE`），
  动态数值放 `message` 字段。

---

## 6. 回归选择器与执行器

### 6.1 选择器

```bash
python3 tools/testing/regression_select.py --changed <文件...>
python3 tools/testing/regression_select.py --git-diff origin/main
python3 tools/testing/regression_select.py --block B6
python3 tools/testing/regression_select.py --list
python3 tools/testing/regression_select.py --changed <文件> --json
```

输出包含：命中功能块（含命中路径）、用例 ID、按顺序的命令、每条命令的必需环境变量
（缺失会标注）、是否需要契约库、是否含破坏性用例。

### 6.2 执行器

```bash
bash tools/testing/run-regression.sh --changed <文件...>
bash tools/testing/run-regression.sh --block B6 --dry-run
bash tools/testing/run-regression.sh --all --yes
```

规则：

1. `destructive: true` 的命令不加 `--yes` 一律 SKIP。
2. 需要 `QF_IT_DB_URL` 而变量缺失时，打印 `prepare-contract-db.sh` 的用法并 SKIP。
3. 需要 `QF_BASE_URL` / `QF_WEB_URL` 而变量缺失或 `/api/v1/health` 非 200 时 SKIP 并说明。
4. 脚本返回 3 视为 SKIP（探测脚本用它表示“不可达”）。
5. 汇总输出 `PASS/FAIL/SKIP`，有 FAIL 时退出码 1。

### 6.3 映射维护规则

- 新增源码目录必须同步 `paths`，否则选择器会漏跑（`--changed` 会打印“未命中任何功能块”）。
- 新增用例必须同时写进 `cases`，否则矩阵与映射会漂移。
- 新增迁移脚本时同步扩展 `tools/testing/prepare-contract-db.sh`，否则契约库缺表。

---

## 7. 本次执行记录

时间：2026-11-11 10:28–10:45 CST。主机：macOS，JDK `25.0.5+8`，PostgreSQL 14（本地 127.0.0.1:5432）。

### 7.1 契约库

```bash
$ bash tools/testing/prepare-contract-db.sh qf_it_config_shadow
contract database ready: qf_it_config_shadow        # 0.88s
```

### 7.2 契约 / 集成测试

```bash
$ JAVA_HOME=.tools/jdk-25.0.5+8/Contents/Home \
  QF_IT_DB_URL=jdbc:postgresql://127.0.0.1:5432/qf_it_config_shadow \
  QF_IT_DB_USER=$(whoami) QF_IT_DB_PASSWORD= \
  ./gradlew :backend:control-plane:test :backend:runtime-runner:test --tests '*IT'
BUILD SUCCESSFUL in 5s
```

结果（读取 `build/test-results/test/*.xml`）：

```text
StrategyVersionContractIT    tests=3  failures=0  errors=0  skipped=0
DeploymentVersionConfigIT    tests=2  failures=0  errors=0  skipped=0
SchemaIntegrationTest        tests=2  failures=0  errors=0  skipped=2   # 无 Docker
```

**注意（已实测，见 §7.10）**：`--tests` 是 **task option**，只作用于它前面那一个
test task。`./gradlew :a:test :b:test --tests '*IT'` 中只有 `:b:test` 被过滤，
`:a:test` 跑全量；反过来写则 `:a:test` 被过滤。CI 的
`... :control-plane:test :runtime-runner:test --tests '*IT'` 因此让控制面跑了全量
（不是 `*IT`），只是恰好没报错。映射里每条命令只带一个模块，正是为了绕开这个语义。

### 7.3 全量单元测试

```bash
$ JAVA_HOME=.tools/jdk-25.0.5+8/Contents/Home ./gradlew test
BUILD SUCCESSFUL in 2s          # 大部分 up-to-date

$ JAVA_HOME=.tools/jdk-25.0.5+8/Contents/Home ./gradlew test --rerun
BUILD SUCCESSFUL in 25s
58 actionable tasks: 14 executed, 44 up-to-date
```

汇总 53 个测试类、129 条测试：

```text
tests=129  failures=0  errors=0  skipped=8
skipped: StrategyVersionContractIT 3（无 QF_IT_DB_URL）
         DeploymentVersionConfigIT 2（无 QF_IT_DB_URL）
         SchemaIntegrationTest     2（无 Docker）
         ClickHouseIntegrationTest 1（无 ClickHouse）
```

### 7.4 映射内 25 条 Gradle 命令逐条执行

```bash
# 用 QF_IT_DB_URL 指向契约库后逐条执行
gradle commands: PASS=25 FAIL=0
```

覆盖 `shared/aeron`、`shared/sbe`、`shared/config`、`runtime`、`runtime-runner`、
`control-plane`、`ors-core`、`sim-exchange`、`telemetry`、`reconciliation`、
`replay-gateway` 共 11 个模块。
其中 `SchemaIntegrationTest` 返回 PASS 但 2 条被 Docker 条件跳过。

### 7.5 只读 API 契约探测（190 SHADOW）

```bash
$ QF_BASE_URL=https://101.43.54.190:8443 \
  python3 tools/testing/checks/api_readonly_check.py
...
57 项检查，0 项失败，3 项已知缺陷(XFAIL)
```

XFAIL 即 §5 两个缺陷。其余检查覆盖：health、system/status、market/status、
scheduled-jobs、strategy-center overview/unassigned/deployments/detail、
strategy-runtime risk、indicators、strategy alerts、me、audit、approvals、emergency/state。

### 7.6 UI 只读 smoke（190）

```bash
$ QF_WEB_URL=https://101.43.54.190:8443 node tools/e2e/readonly-smoke.mjs
SKIP  control plane unreachable: https://101.43.54.190:8443
exit=3
```

原因：10:37 CST 起 190 的 nginx 对 `/api/v1/health` 返回 **502 Bad Gateway**
（`Server: nginx/1.20.1`）；10:52 再测，TCP 8443 可连但 HTTPS 8s 无响应
（`curl` 返回 `000`，`Operation timed out`）。10:32 时同一地址
`/api/v1/health`、`/api/v1/me`、`/api/v1/strategy-center/overview` 仍是 200。
本次未重启 190 上任何服务（硬约束），因此 B10 全部记为 SKIP。
脚本在探测到后端整体 5xx 且复探失败时返回 3，避免把环境故障误报成 UI 回归。

### 7.7 选择器样例

样例 1（单文件 → B6）：

```bash
$ python3 tools/testing/regression_select.py \
  --changed backend/control-plane/src/main/java/com/quantlink/fin/control/api/StrategyCenterController.java
命中功能块
  B6   策略中心（CRUD/版本/fork/部署/激活/停止/回滚）
用例（10）E2E-B6-001 … E2E-B6-010
执行计划（5 条）
  1. [gradle][safe] ./gradlew :backend:control-plane:test --tests '*StrategyVersionContractIT*'
  2. [gradle][safe] ./gradlew :backend:control-plane:test --tests '*StrategyConfigMergeTest*' --tests '*StrategyConfigValidatorTest*'
  3. [python][safe] python3 tools/testing/checks/api_readonly_check.py --suite strategy
  4. [node][safe] node tools/e2e/readonly-smoke.mjs
  5. [node][safe] node tools/e2e/t030-pair.mjs   # SimVenue 隔离 + 自清理
契约库：需要   破坏性：无（写路径脚本自带清理）
```

样例 2（按块）：`--block B6` 输出同上（无变更文件列表）。

样例 3（多文件跨块）：

```bash
$ python3 tools/testing/regression_select.py \
  --changed backend/runtime-runner/src/main/java/com/quantlink/fin/runner/IndicatorPublisher.java \
            web/src/pages/Alerts.tsx
命中功能块 B7 / B8 / B10
用例（15）E2E-B7-001…004, E2E-B8-001…006, E2E-B10-001…005
执行计划（8 条，含 1 条 DESTRUCTIVE）
```

样例 4（git diff）：

```bash
$ python3 tools/testing/regression_select.py --git-diff origin/main
变更文件 2 个
  - backend/control-plane/src/main/java/com/quantlink/fin/control/aeron/AeronOrderUpdateConsumer.java
  - backend/control-plane/src/main/java/com/quantlink/fin/control/ledger/ExecutionLedgerService.java
命中功能块 B4 / B5，用例 13 条，命令 9 条
```

（这两个文件是他人未提交的修改，选择器正确地选中了 B4/B5，未触碰内容。）

### 7.8 执行器实测

```bash
$ bash tools/testing/run-regression.sh --block B3
PASS  RiskEngineTest
PASS  CloseoutGuardTest
SKIP  缺少 QF_BASE_URL（控制面地址）
汇总：PASS=2 FAIL=0 SKIP=1
REAL_EXIT=0

$ bash tools/testing/run-regression.sh --block B12 --dry-run
SKIP  缺少 QF_IT_DB_URL（先 bash tools/testing/prepare-contract-db.sh qf_it_config_shadow）
（其余 2 条 DRY-RUN 未执行）

$ QF_IT_DB_URL=... bash tools/testing/run-regression.sh --all
汇总：PASS=26 FAIL=1 SKIP=12 NOT_RUN=0
EXIT=1
```

`--all` 的 12 条 SKIP 全部是缺环境变量（`QF_BASE_URL` / `QF_WEB_URL`），
其中包含 `t030-pair.mjs` 与 `t030-lifecycle.mjs`：设置变量后它们会直接执行，
并在 `finally` 删除自己创建的策略/fork/指标/部署，不再需要 `--yes`。
唯一的 FAIL 是他人正在修改的 `StrategyVersionContractIT`（详见 §10.4）。
```

`run-regression.sh` 在 `JAVA_HOME` 未设置时会自动选用仓库内
`.tools/jdk-25.0.5+8/Contents/Home`，否则系统默认 JVM 11 会让 Gradle 直接失败。

### 7.9 视觉回归（不可执行，阻塞：无控制面）

```bash
$ npx playwright test
[WebServer] 10:45:01 [vite] http proxy error: /api/v1/ws-ticket
[WebServer] Error: connect ECONNREFUSED 127.0.0.1:8080
...
Killed by SIGTERM   # 手动终止，避免无限重试
```

结论：`playwright.config.ts` 的 `webServer` 只启动 `vite preview`（4173），
但页面依赖 `/api/v1/*` 代理到 `127.0.0.1:8080` 的控制面，本地没有该进程，
所有请求 `ECONNREFUSED`，截图断言不可能成立。
按 R5 采用**方案 2**：记为 `N/A（阻塞：无控制面）`，不是“未执行”；
恢复条件与修复路径见 §8.3。

---

## 7.10 Q1 实测：Gradle `--tests` 在多模块多 test task 下的真实行为

结论先行：**`--tests` 是 task option，只绑定到它前面那一个 test task；不 fan-out，
也不会被静默忽略 —— 绑定到的 task 没有匹配用例时直接失败。**

`AeronMarketDataPriceTest` 只存在于 `runtime-runner`，正好可以当探针。

### 实验 A：filter 放在两个 task 之后

```bash
rm -rf backend/control-plane/build/test-results/test backend/runtime-runner/build/test-results/test
./gradlew :backend:control-plane:cleanTest :backend:runtime-runner:cleanTest \
  :backend:control-plane:test :backend:runtime-runner:test \
  --tests '*AeronMarketDataPriceTest*'
# BUILD SUCCESSFUL in 6s
# control-plane XML 类数 = 17
# runtime-runner XML 类数 = 1（AeronMarketDataPriceTest）
```

`--no-configuration-cache` 复跑（结果 FROM-CACHE）：`control-plane=17`、`runtime-runner=1`，
说明不是 configuration cache 造成的假象。

只有 `runtime-runner`（紧邻 `--tests` 之前的 task）被过滤；控制面**全量跑了 17 个类**。

### 实验 B：把顺序反过来（证明绑定位置）

```bash
./gradlew --no-configuration-cache :backend:runtime-runner:cleanTest \
  :backend:control-plane:cleanTest :backend:runtime-runner:test \
  :backend:control-plane:test --tests '*AeronMarketDataPriceTest*'
# GRADLE_EXIT=1
# > No tests found for given includes: [*AeronMarketDataPriceTest*](--tests filter)
# control-plane XML 类数 = 0
# runtime-runner XML 类数 = 6（全量）
```

这次 filter 落到 `:control-plane:test`（紧邻之前），它没有这个类 →
**直接 BUILD FAILED，exit 1**，不是“忽略后跑全量”。反过来 `runtime-runner` 跑了全部 6 个类。

### 实验 C：每个 task 各带自己的 filter（推荐写法）

```bash
./gradlew --no-configuration-cache \
  :backend:control-plane:cleanTest :backend:runtime-runner:cleanTest \
  :backend:control-plane:test --tests '*StrategyConfigMergeTest*' \
  :backend:runtime-runner:test --tests '*CloseoutGuardTest*'
# BUILD SUCCESSFUL in 3s
# control-plane XML = 1（StrategyConfigMergeTest）
# runtime-runner XML = 1（CloseoutGuardTest）
```

### 结论

| 写法 | 控制面 | runtime-runner | 结果 |
|---|---|---|---|
| `:cp:test :rr:test --tests X`（X 只在 rr） | 全量 17 类 | 只 1 类 | 成功，**但控制面没被过滤** |
| `:rr:test :cp:test --tests X` | 0 类 + **BUILD FAILED** | 全量 6 类 | exit 1，`No tests found for given includes` |
| `:cp:test --tests A :rr:test --tests B` | 只 A | 只 B | 成功，语义符合预期 |

对 CI 的影响与建议：

1. 现有 `Contract tests (write path -> read path)` 步骤实际让控制面跑了**全量**，
   只是恰好全绿，所以没人发现；名字与行为不符，且一旦控制面有无关测试失败，
   会被误读成“契约测试挂了”。
2. 二选一：
   - **改命令（最小改动）**：
     `./gradlew :backend:control-plane:test --tests '*IT' :backend:runtime-runner:test --tests '*IT'`；
   - **拆 task（更清晰）**：在 `control-plane/build.gradle.kts` 增加
     `tasks.register<Test>("contractTest")`，CI 只跑 `:backend:control-plane:contractTest`。
3. 本仓库的映射已按“一条命令一个模块”编写，不受该语义影响。

> 说明：测量时 `StrategyVersionContractIT` 正被另一对话修改（新增
> `versionApiRejectsAnIndicatorOwnedByAnotherStrategy`，当前失败），
> 因此实验 C 改用 `StrategyConfigMergeTest`/`CloseoutGuardTest` 两个稳定类，
> 避免把他人的在途失败误记到 filter 语义上。

---

## 8. 仍缺什么

### 8.1 环境缺口（阻塞 NONE 用例）

1. **VIEWER / TRADER 授权缺失**：B6-010、B9-001、B9-002 无法执行。
   账号本身已存在于 `tests/seed/shadow-seed.sql`（`test_viewer` / `test_trader` / `test_risk`，
   密码均为 `test`），但 `user_account_permission` 没有种子，`AccountAccessService`
   是显式授权模型，所以实际是“能登录、读不到”。
   修复：执行 `tests/seed/viewer_trader_accounts.sql`（见 §10 R9）。
2. **无 LIVE 环境**：B9-003 的 `ApprovalGuard` 分支（428/412）只能在 LIVE 触发，
   当前只能靠代码审阅。
3. **无独立恢复库**：B11-005 备份演练没有目标实例。
4. **无 Docker**：`SchemaIntegrationTest` 与 `Testcontainers` 相关用例默认跳过。
5. **无 ClickHouse**：`ClickHouseIntegrationTest` 跳过。

### 8.2 自动化缺口（按价值排序）

| 缺口 | 影响 | 建议实现 |
|---|---|---|
| 手工单校验链（tick/lot/100 手/资金/保证金/行情过期） | `03` 文档 ORD-001~010 全部无用例 | 给 `TradingController.validateOrder` 抽纯函数并单测 reason 文案 |
| `ExecutionOffsetPolicy`（今平今/平昨/跨今昨） | OFS 16 条无自动化 | 直接对 `resolve()` 做参数化单测 |
| `Idempotency-Key` 幂等 | B4-002 | MockMvc 或契约库直调 |
| 告警 ack/silence/去重 | B8-003/004/006 | `StrategyAlertController` 单测 + 固定时钟 |
| 指标 Publisher（2012） | B7-001/003 | 用 Aeron 回环 + 固定 tick 序列 |
| 关闭/收盘 backstop | B5-003 只测了 runner 侧 | 补 `StrategyCloseoutScheduler` 单测 |
| `ors_instances.login_status` 未参与门禁 | B4-008 是必失败用例 | 在 `StrategyOrderService` 与 `StrategyDeploymentController` 加 `LOGIN_STATUS_GUARD` |

### 8.3 流程缺口

- ~~用例执行结果没有落库~~ 已修：`run-regression.sh` 现在写
  `docs/testing/last-run.json`（`commands[]` + `blocks[]` + `cases[]`），
  覆盖矩阵的「最近结果」列以它为准。仍未做的是把它接进 CI artifact。
- 190 的可用性没有监控：本次 502 是人工发现的。`readonly-smoke` 已能在后端整体
  不可用时返回 3（SKIP），但没有定时任务，也没有外部探活告警。
- 视觉回归 `tests/visual`：**N/A（阻塞：无控制面）**。
  恢复条件（满足任一即可跑）：
  1. 本地起控制面并监听 `127.0.0.1:8080`（`web` 的 vite 代理目标），或
  2. 把 `web/vite.config.ts` 的 `/api` 代理指向 `https://101.43.54.190:8443`（需 `secure:false`），
     且 `playwright.config.ts` 增加 `ignoreHTTPSErrors: true`，或
  3. 在 `playwright.config.ts` 里再加一个 `webServer` 条目启动 control-plane。
  当前三者都没做，因此视觉回归不属于“待执行”，而是“不可执行”；在恢复前
  B10 的视觉部分不应计入覆盖率。

---

## 9. 最值得先补的 3 条用例

### 1) E2E-B3-001 本地风控快照过期时 OPEN fail-closed，CLOSE 放行

- 理由：这是资金安全的最后一道闸门，`AeronOrderGateway.ensureRisk()` 里
  有明确分支但没有任何测试；190 上已经实际触发过（告警 `local risk snapshot is stale`），
  说明它会在真实运行时发生。
- 可执行性：纯 runner 单测即可，不需要 190；构造一个 `ready()` 为 false 的
  gateway，断言 OPEN 抛 `IllegalStateException`、CLOSE 正常提交。
- 风险：如果不补，任何一次“风控快照刷新变慢”都可能静默停止所有开仓，
  而回归完全发现不了。

### 2) E2E-B6-002 策略删除保护（ACTIVE / 持仓 / 历史 → 409）

- 理由：`deleteStrategy` 里 4 个分支全是中文错误文案，一旦被改坏就会
  孤儿化订单与成交归属；目前零测试、零脚本。
- 可执行性：需要契约库（`qf_it_config_shadow`）直接调用 controller，
  与 `StrategyVersionContractIT` 同一套 MyBatis 装配，工程量小。
- 风险：删除是不可逆操作，回归缺席时代价最高。

### 3) E2E-B4-002 手工单 `Idempotency-Key` 幂等

- 理由：`TradingController.manualOrder` 已有 `duplicate` 分支，
  但没有任何测试；交易员双击、网络重试都会走到这里，重复下单=真实资金风险。
- 可执行性：`ManualOrderPublisherTest` 已经能在进程内跑通 Aeron → ORS，
  扩一个“同 key 两次”的用例即可，不需要 190。
- 风险：幂等键失效时的表现是“多下一手”，而不是报错，最难被发现。

---

## 10. 评审响应（2026-11-11）

评审文件：`docs/testing/05-测试计划评审意见-2026-11-11.md`（A1–A5 成立，R1–R9 逐条处理）。

### 10.1 R1–R9 处理结论

| 编号 | 结论 | 改了什么 | 验证 |
|---|---|---|---|
| R1 映射漏 CTP 适配器 | **接受** | `e2e-regression-map.yaml` B1 `paths` 增加 `ctp-adapter/src/**`、`ctp-adapter/tests/**`、`ctp-adapter/include/**`；新增 `E2E-B1-005`；命令增加 `bash tools/testing/ctp-price-test.sh` 与 `*AeronMarketDataPriceTest*`；`notes` 加“适配器/采集端改动必须命中 B1” | `regression_select.py --changed ctp-adapter/src/price_sanitize.h` → 命中 B1（输出见 §10.3）；`ctp-price-test.sh` → `price sanitizer ok`；`AeronMarketDataPriceTest` 3 tests 全过 |
| R2 AUTO 与执行状态混读 | **接受** | 文档开头加读法说明；§3 增加「最近结果」列（PASS/FAIL/SKIP/NOT_RUN）并重算统计；`run-regression.sh` 落 `docs/testing/last-run.json`（commands/blocks/cases + summary） | `run-regression.sh --block B3 --dry-run` → `last-run.json` 中 blocks/cases 全为 `NOT_RUN`；`--all` 后 summary 为 `PASS=26 FAIL=1 SKIP=12`（见 §10.4） |
| R3 B7 缺隔离/时效/并发 | **接受** | 新增 `E2E-B7-005`（柜台隔离）、`E2E-B7-006`（时效 STALE）、`E2E-B7-007`（并发，L2 不进 CI）；B7 `notes` 说明两类真实故障 | `--block B7` 输出 7 条用例；矩阵 B7 行数 7 |
| R4 缺价格不变量 | **接受（部分调整）** | `api_readonly_check.py` 新增 `--suite market`：策略报价、`/api/v1/market/ticks`、`pair_state.state_json` 三处断言 `isfinite && 0<=v<1e12`，`lastPrice` 额外 `>0`；未放入 `KNOWN_DEFECTS` | 本地 stub 四组：good=4 PASS；`lastPrice=DBL_MAX`→2 FAIL；`askPrice=DBL_MAX`→1 FAIL；`leg1Ask=-1`→1 FAIL（见 §10.5）。**调整点**：bid/ask 允许 0，因为 0 是清洗后的“无报价”哨兵，强制 >0 会把合法单边盘口误报 |
| R5 视觉回归不可用 | **接受方案 2** | §7.9 改为“不可执行（阻塞：无控制面）”；§8.3 给出三条恢复条件；§1.4 同步 | 未改 `playwright.config.ts`/`web/**`（硬约束），文档明确不计入覆盖 |
| R6 `--tests` 语义 | **接受** | §7.10 记录 A/B/C3 组实验（命令 + XML 类数 + 退出码）；§1.2、§7.2 改为实测结论；给出 CI 两种改法 | 实验 A：cp=17 类 / rr=1 类；实验 B：cp=0 + `No tests found` + exit 1；实验 C：cp=1 / rr=1（见 §7.10） |
| R7 DEF-02 回归用例 | **接受** | 新增 `E2E-B8-007`（5 次同键只 1 条 NEW、ageMs 只进 message、ack/silence 不变）；B8 `notes` 写目标契约 | `--block B8` 输出 7 条用例 |
| R8 过期文档 | **接受** | `02-测试策略.md`（dump-shadow.sh、QF_PG_URL、种子清单）；`03-...md`（SimLocal→SimVenue、今昨仓缺口关闭、账户表）；`PAIR业务测试用例.md`（SIMLOCAL-001→SIMVENUE-001、2120–2123→3140–3143、H 节）；`T-030-...md`（基础数据）；`tests/seed/README.md` | 各文件末尾加“最后核对：2026-11-11”；`grep -n SIMLOCAL` 仅剩历史说明 |
| R9 环境缺口 | **接受** | 新增 `tests/seed/viewer_trader_accounts.sql`（3 用户 + 4 条 `user_account_permission`，故意不授权 TEST-SHENGLI）；`api_readonly_check.py --suite access` 支持 `QF_VIEWER_USER/QF_VIEWER_PASSWORD`，只读验证“账户范围”与“越权 403” | `psql -f` 后自检 SQL 应 4 行；带 viewer 凭据跑 `--suite access`，越权用例转 AUTO |

### 10.2 Q1–Q4

**Q1：`--tests` 的真实行为。**
已定论（完整证据见 §7.10）：`--tests` 是 task option，**只绑定到它前面那一个 test task**。

- `:control-plane:test :runtime-runner:test --tests X` → 只有 runtime-runner 被过滤，
  控制面跑全量（实测 17 个类，`--no-configuration-cache` 复跑同为 17）。
- 顺序反过来 → 控制面拿到 filter 但无匹配，**BUILD FAILED / exit 1**，
  报 `No tests found for given includes: [*AeronMarketDataPriceTest*](--tests filter)`。
- 每个 task 各带 `--tests` → 两个模块各只跑 1 个类，成功。

所以 CI 现状是“控制面全量 + runner 只 IT”，不是“两个模块只跑 IT”。
建议改为 `:control-plane:test --tests '*IT' :runtime-runner:test --tests '*IT'`，
或拆独立 `contractTest` task（需要改 `build.gradle.kts`，本次未做，因为属于生产构建文件）。

**Q2：不依赖 190 的可离线子集。**
`--all` 共 39 条命令：26 gradle + 1 shell + 7 python + 5 node。
其中 **27 条不依赖 190**：

- 25 条无环境变量要求（含 `ctp-price-test.sh`、`shared/aeron`、`shared/sbe`、
  `runtime`、`runtime-runner`、`control-plane` 单测、`replay-gateway`、`reconciliation` 等）；
- 2 条只需要本地契约库（`QF_IT_DB_URL` 指向 `qf_it_config_shadow`）：
  `StrategyVersionContractIT`、`DeploymentVersionConfigIT`。

需要 190 的 12 条：8 条 `QF_BASE_URL`（`--suite *`）、4 条 `QF_WEB_URL`（Playwright）。
用 `python3 tools/testing/regression_select.py --all --json` 可直接过滤
（`requires` 为空或只含 `QF_IT_DB_URL` 即为离线）。

**Q3：DEF-01 按哪种修法写回归。**
建议**先按“默认 `NO_DATA`”写回归，DELTA 生产者另立 NONE 用例**。理由：

1. 可断言的不变量与实现无关：每个 `enabled` 指标必须有 `status`，没值就是
   `NO_DATA`。这条今天就能写成 XFAIL 并在修复后转 PASS，不需要等产品决策。
2. 若把回归写成“DELTA 必须有值”，在生产者落地前会永久红灯，团队会习惯性忽略，
   反而降低门禁价值。
3. 评审指出的本质（没有 `"DELTA"` 生产者）是**功能缺口**，应记录为一条
   `E2E-B7-008`（NONE）由产品决定语义，而不是塞进结构断言。

因此：`--suite indicators` 的两条断言保留并把 DEF-01 记为 XFAIL；
新增的 DELTA 用例在 §8.2 缺口表跟踪，不在本文件标 AUTO。

**Q4：`ctp-adapter` 的 C++ 用例与 CI。**
现有 CI 已足够，无需新增 job：

- GitHub `ubuntu-latest` 预装 g++（build-essential），`tools/testing/ctp-price-test.sh`
  只用 `g++ -std=c++17 -Wall -Wextra`，不依赖 CTP SDK；
- CI 已在 `backend` job 里加了 `CTP price sanitizer unit test` 步骤，且位于
  `./gradlew test` 之前，失败会立刻拦住后续步骤。

两点建议（本次未改，避免动他人刚加的 CI/脚本）：

1. 给脚本加 `-Werror`，否则 `-Wall -Wextra` 的告警不会失败；
2. 该步骤只编译一个文件，建议把 `g++ --version` 打出来，便于区分
   “编译器缺失”与“断言失败”。

### 10.3 R1 验证：`--changed ctp-adapter/src/price_sanitize.h`

```bash
$ python3 tools/testing/regression_select.py --changed ctp-adapter/src/price_sanitize.h
变更文件 1 个
  - ctp-adapter/src/price_sanitize.h

命中功能块
  B1   行情链路（CTP Adapter -> Aeron md -> runner）
        <- ctp-adapter/src/price_sanitize.h

用例（5）
  E2E-B1-001 … E2E-B1-005

执行计划（按顺序，5 条）
  1. [shell][safe] bash tools/testing/ctp-price-test.sh
  2. [gradle][safe] ./gradlew :backend:shared:aeron:test --tests '*MarketDataCodecTest*' --tests '*AeronEchoTest*' --tests '*AeronUdpLoopbackTest*'
  3. [gradle][safe] ./gradlew :backend:runtime-runner:test --tests '*AeronMarketDataPriceTest*'
  4. [gradle][safe] ./gradlew :backend:control-plane:test --tests '*MarketDataServiceTest*'
  5. [python][safe] python3 tools/testing/checks/api_readonly_check.py --suite market
契约库：不需要    破坏性：无
```

实测：`ctp-price-test.sh` → `price sanitizer ok`（exit 0）；
`AeronMarketDataPriceTest` → 3 tests / 0 failures。

### 10.4 R2 验证：`last-run.json`

```bash
$ bash tools/testing/run-regression.sh --block B3 --dry-run
汇总：PASS=0 FAIL=0 SKIP=1 NOT_RUN=2
last-run → docs/testing/last-run.json（3 条命令 / 7 条用例）

$ python3 -c "import json;d=json.load(open('docs/testing/last-run.json'));print(d['blocks']);print({c['status'] for c in d['cases']})"
[{'id': 'B3', 'name': '本地风控（快照/fail-closed/限仓/价格偏离/节流）', 'status': 'NOT_RUN', 'commands': 3}]
{'NOT_RUN'}
```

结构：`generatedAt`、`dryRun`、`assumeYes`、`summary{commands,PASS,FAIL,SKIP,NOT_RUN}`、
`commands[]`（block/kind/name/run/status/exitCode/note/at）、
`blocks[]`（id/name/status/commands）、`cases[]`（caseId/block/status）。
`dryRun` 时块与用例一律 `NOT_RUN`，避免“计划过”被读成“跑过”。

`--all` 实跑（`QF_IT_DB_URL` 指向本地契约库）：

```text
汇总：PASS=26 FAIL=1 SKIP=12 NOT_RUN=0
last-run → docs/testing/last-run.json（39 条命令 / 75 条用例）
EXIT=1
```

唯一的 FAIL 是 `:backend:control-plane:test --tests '*StrategyVersionContractIT*'`：
另一对话在 `ac7a6dd` 新增的 `versionApiRejectsAnIndicatorOwnedByAnotherStrategy`
断言失败（`expected true but was false`），与版本快照/回滚无关；
其余 4 条用例（含快照写入、回滚、唯一约束）均通过。修复后重跑即恢复；
本次不修改他人未提交文件。12 条 SKIP = 7 条缺 `QF_BASE_URL`（190 不可用）
+ 3 条缺 `QF_WEB_URL`（UI smoke）+ 2 条破坏性用例未加 `--yes`。

### 10.5 R4 验证：价格不变量（本地 stub）

```text
MODE=good      4 项检查，0 失败
MODE=bad_last  2 失败：ag2612.lastPrice=1.7976931348623157e+308；ticks 与 quotes 不一致
MODE=bad_ask   1 失败：ag2612.askPrice=1.7976931348623157e+308
MODE=bad_pair  1 失败：S1 leg1Ask=-1.0
```

190 在 10:37–11:05 期间 502/无响应，`--suite market` 的线上验证未能完成；
恢复后直接跑 `QF_BASE_URL=... python3 tools/testing/checks/api_readonly_check.py --suite market`。

### 10.6 本轮改动的文件

测试资产与文档（未触碰 `backend/**`、`ctp-adapter/**`、`web/**` 的实现）：

| 文件 | 变更 |
|---|---|
| `docs/testing/04-e2e-test-plan.md` | 读法说明、§1.2/§1.3/§1.4、§3 矩阵 + 最近结果、§4 新增 5 条规格、§7.9、§7.10、§8.1、§8.3、§10 |
| `docs/testing/e2e-regression-map.yaml` | B1 paths/cases/commands/notes、B7 +3 用例、B8 +1 用例与目标契约 |
| `docs/testing/02-测试策略.md` | 种子脚本清单、环境变量分组、最后核对 |
| `docs/testing/03-交易执行与开平仓测试用例.md` | SimLocal→SimVenue、今昨仓缺口关闭、账户表、最后核对 |
| `docs/testing/PAIR业务测试用例.md` | 基线账户/ORS/流号、H 节、最后核对 |
| `docs/testing/T-030-策略中心V2测试用例.md` | 基础数据账户 |
| `tools/testing/checks/api_readonly_check.py` | 新增 `--suite market`、价格不变量、viewer 账户范围/403 检查 |
| `tools/testing/run-regression.sh` | `last-run.json`、NOT_RUN 统计、dry-run 语义 |
| `tools/testing/regression_select.py` | `--list` 命令数去重（42 → 39），避免跨块复用被重复计数 |
| `tools/testing/last_run_report.py` | 新增：把 `last-run.json` 渲染成用例/命令视图，用于核对矩阵 |
| `tests/seed/viewer_trader_accounts.sql` | 新增：VIEWER/TRADER/RISK 授权夹具 |
| `tests/seed/README.md` | 实际种子文件清单 |
| `tests/seed/shadow-seed.sql` | `SIMLOCAL-001` → `SIMVENUE-001` |

## 11. 交易端改造增量用例（2026-11-11，PLANNED）

来源：`docs/reviews/2026-11-11-trader-review.md`、`docs/reviews/2026-11-11-ux-review.md`、
`docs/reviews/2026-11-11-remediation-task-breakdown.md`。

### 11.1 新增用例

| 用例 | 场景 | 依赖任务 | 自动化脚本（待落地） |
|---|---|---|---|
| E2E-B3-008 | 风控快照过期拒单在驾驶舱可见 | T-W1-02 | `tools/e2e/trader-cockpit.mjs` |
| E2E-B3-009 | 限仓超限被拒并给原因 | T-W2-04 | `tools/e2e/trader-cockpit.mjs` |
| E2E-B6-011 | 单一 runState，无状态词并存 | T-W1-01 | `tools/e2e/trader-cockpit.mjs` |
| E2E-B6-012 | 带仓发布拦截、无 emergency 请求 | T-W2-02 | `tools/e2e/version-safety.mjs` |
| E2E-B6-013 | 危险动作影响面确认 | T-W1-05 | `tools/e2e/version-safety.mjs` |
| E2E-B6-014 | 版本表单 + diff | T-W2-01 | `tools/e2e/version-safety.mjs` |
| E2E-B6-016 | 已部署策略编辑改道版本表单 | T-W0-05 | `tools/e2e/version-safety.mjs` |
| E2E-B6-017 | PnL 双口径标注 | T-W3-03 | `tools/e2e/trader-cockpit.mjs` |
| E2E-B6-018 | 未归属 KPI 下钻/批量认领 | T-W3-05 | `tools/e2e/trader-cockpit.mjs` |
| E2E-B8-008 | 告警同指纹聚合 + count | T-W1-03 | `tools/e2e/alerts-aggregation.mjs` |
| E2E-B10-007 | 批量撤单逐单回执 | T-W1-06 | `tools/e2e/orders-blotter.mjs` |
| E2E-B10-008 | 900px 功能可达 | T-W1-07 | `tools/e2e/responsive-900.mjs` |
| E2E-B10-009 | 手工单 tick 合规 | T-W1-08 | `tools/e2e/manual-tick.mjs` |
| E2E-B10-010 | 逐柜台健康 | T-W1-04 | `tools/e2e/trader-cockpit.mjs` |
| E2E-B10-011 | 数据新鲜度降级 | T-W3-01 | `tools/e2e/trader-cockpit.mjs` |
| E2E-B10-013 | 执行页表头/单元格对齐 | T-W0-01 | `tools/e2e/readonly-smoke.mjs`（扩展） |
| E2E-B10-014 | 时区一致 | T-W0-02 | `tools/e2e/readonly-smoke.mjs`（扩展） |
| E2E-B10-015 | 首屏持仓计数 | T-W0-03 | `tools/e2e/orders-blotter.mjs` |
| E2E-B10-016 | 快照覆盖标记 | T-W0-04 | `tools/e2e/trader-cockpit.mjs` |
| E2E-B10-017 | 单笔撤单 ≤2 次点击 | T-W0-06 | `tools/e2e/orders-blotter.mjs` |
| E2E-B10-018 | 手工单合约选择 | T-W2-03 | `tools/e2e/manual-tick.mjs` |
| E2E-B10-019 | 只减仓常驻 banner | T-W2-05 | `tools/e2e/manual-tick.mjs` |
| E2E-B10-020 | 订单/成交实时 | T-W3-02 | `tools/e2e/orders-blotter.mjs` |
| E2E-B10-021 | 导航 ≤16 项 + 旧路由重定向 | T-W4-02 | `tools/e2e/readonly-smoke.mjs`（扩展） |
| E2E-B10-022 | 快捷键 F2/F3/F8/F12 | T-W4-03 | `tools/e2e/trader-cockpit.mjs` |
| E2E-B11-006 | 收盘 checklist | T-W4-04 | `tools/e2e/trader-cockpit.mjs` |

> 2026-11-11 更新：`shortcuts-smoke`、`trader-cockpit`、`orders-blotter`、
> `version-safety`、`edit-deployed`、`manual-tick`、`alerts-aggregation`、`w4-layout.spec.ts`
> 已落地并加入映射 `commands`；`responsive-900` 由 readonly-smoke 的
> 900px 断言覆盖；`trader-cockpit` 合并了原计划中的多个只读用例。

### 11.2 受影响的现有用例

- `E2E-B6-001/003/006`（Pair/生命周期）：动作收敛、危险确认框后需更新选择器与断言。
- `E2E-B6-004`（版本契约 IT）：新增 `runState`/diff 字段后扩展断言，不破坏现有。
- `E2E-B10-001..005`（smoke）：导航 5 组、PageHeader/DataTable 改造后更新 marker 与路由；旧路由保留重定向。
- `E2E-B12-001`（版本快照）：版本表单化后由 JSON 文本框改为表单字段。
- `VIS-*`：三档基线在 Wave 1/4 各重拍一次。

### 11.3 门禁

- 每个 Wave 结束：`run-regression --all` 必须 39/39；新增脚本计入 PASS。
- 映射与本文矩阵必须同步；未同步视为该任务未完成。

# Reconciliation Gate 误拦 PAIR 订单：诊断与修复计划

- 事件编号：INC-2026-11-08-01
- 日期：2026-11-08
- 状态：已修复，待交易日回归验证
- 严重级别：P1（本地风控误拦，订单未发出，未造成成交/资金损失）
- 现象：`ag2612 S 1@11802.00 · PAIR order rejected: reconciliation gate is not passed`
- 影响：PAIR 在本地风控层被拒绝，订单未进入 Aeron/SimLocal；不是交易所拒单
- 关联：
  - `docs/reviews/architecture-review-2026-11-08.md`（ARCH-P0-05 / ARCH-P0-06）
  - `docs/reviews/remediation-plan-2026-11-08.md`（R-P0-14 / R-P0-16 / R-P0-18）

---

## 1. 结论先行

```text
这是本地风控的 reconciliation gate 误拦/过度拦截，
不是 Aeron、SimLocal 或 CTP 的拒单。
```

错误链路：

```text
PairSpreadRunner 想卖 ag2612 1 手 @11802
  → AeronOrderGateway.submit()
  → ensureRisk()
  → 读取本地 risk snapshot
  → reconciliationGateEnabled = true
  → reconciliationPass = false
  → 抛异常 "reconciliation gate is not passed"
  → PairSpreadRunner catch
  → alert("PAIR order rejected: ...")
```

对应代码：

```text
backend/runtime-runner/src/main/java/com/quantlink/fin/runner/PairSpreadRunner.java
  submit() catch → alert(...)

backend/runtime-runner/src/main/java/com/quantlink/fin/runner/AeronOrderGateway.java
  ensureRisk()

backend/control-plane/src/main/java/com/quantlink/fin/control/api/StrategyRuntimeController.java
  /strategy-runtime/risk

backend/control-plane/src/main/java/com/quantlink/fin/control/api/ReconciliationController.java
  consistency()
```

---

## 2. 现场证据

### 2.1 告警

```text
strategy_alerts:
  alert 1  TEST-STRAT-PAIR-01  ag2612  B  11798  NEW  2026-11-08 13:06:28
  alert 2  TEST-STRAT-PAIR-01  ag2612  S  11802  NEW  2026-11-08 13:07:47
```

两条都是：

```text
PAIR order rejected: reconciliation gate is not passed
```

### 2.2 当前对账状态（评审时点）

```text
/api/v1/reconciliation/consistency:
  passed = true
  issueCount = 0

/strategy-runtime/risk?strategyId=TEST-STRAT-PAIR-01:
  reconciliationGateEnabled = true
  reconciliationPass = true
```

说明：

```text
错误发生时 gate = false
现在 gate 已恢复 true
两条历史告警仍为 NEW，未被 ACK
```

### 2.3 当前是周末

Pair 最新日志：

```text
[pair] submit failed ag2612: not a trading day or trading calendar unavailable
```

因此当前不会再发单，当前状态不能证明问题已经彻底修复，只能说明 gate 当前为 true。

### 2.4 当前账本

```text
positions:
  SIMLOCAL-001 au2612C920 short 3

trades:
  au2612C920 S 1 × 3

strategy_positions:
  TEST-STRAT-OPT-01 au2612C920 short 3
```

当前 `positions` 与 `trades` 净额一致，所以 `consistency=true`。

但现有系统**没有保存 consistency 的历史 issue 明细**，因此无法从历史记录精确还原 13:06/13:07 当时具体是哪条不一致。

---

## 3. 为什么会被拦住

### 3.1 Gate 是全局的

`StrategyRuntimeController.risk()` 当前：

```java
out.put("reconciliationPass", reconciliationGateEnabled
    ? Boolean.TRUE.equals(reconciliation.consistency().get("passed")) : true);
```

`consistency()` 不按账户、不按策略、不按合约隔离。

结果：

```text
任何一个账户/策略出现不一致
→ 所有策略的 reconciliationPass = false
→ PAIR 的 ag2612 也被一起拒绝
```

即使 PAIR 本身没有持仓、没有成交、没有不一致，也会被其他策略的问题连坐。

### 3.2 对账查询不是事务快照

`ReconciliationController.consistency()` 的执行方式是：

```text
1. 查 positions
2. 对每个 instrument 查 trades 净额
3. 查 FILLED 但没有 trade 的订单
```

这些查询不是同一个数据库快照，也没有和成交写入共享事务。

### 3.3 成交写入不是事务性的

`AeronOrderUpdateConsumer.applyTrade()` 大致顺序：

```text
1. insert trade
2. strategyPositions.applyFill()
3. 更新 positions
4. 更新 order 状态
```

中间存在窗口：

```text
trade 已插入
position 还没更新
→ 另一个 HTTP 线程执行 consistency()
→ positions != trades
→ reconciliationPass = false
```

### 3.4 risk snapshot 会缓存 false

`AeronOrderGateway` 默认每 5 秒刷新一次 risk snapshot：

```text
riskRefreshMillis = 5000
```

一次瞬时 false 会在这段时间内持续生效；Pair 每个 tick 都重试，于是日志出现连续拒绝，数据库里留下多条告警（UI 侧按 NEW 去重为两条）。

### 3.5 历史状态可能是“重置/回放/部分成交”造成的真实不一致

在当前告警时间点（13:06/13:07）附近，没有对应成交记录；`positions` 可能来自更早的状态，而 `trades` 为空或尚未补齐。这样 `positions != trades` 也会让 gate 变 false。

由于没有保存当时的 issue 明细，无法断定是“瞬时写窗口”还是“真实账本不一致”。这两种情况都必须处理，但修复方式不同。

---

## 4. 影响

```text
1. PAIR 的合法报价被误拦，策略无法正常工作
2. 一个策略/账户的问题会阻断所有策略
3. 告警只显示一句笼统原因，无法定位是哪个合约/哪条不一致
4. 同一原因每个 tick 重复尝试，日志和告警噪声大
5. 如果为了绕过问题直接关闭 gate，会把真正的账本错误放过去
```

---

## 5. 修复原则

```text
1. 不直接全局关闭 reconciliation gate
2. Gate 必须按 account / strategy / instrument scope 生效
3. 对账必须读一致快照，不能用多次查询拼出一个假状态
4. 成交、持仓、订单、策略持仓必须事务化
5. 对瞬时窗口要有宽限和重试，但不能永久放过真实差异
6. 拒绝原因必须包含具体 issue
7. 告警必须去重/冷却
```

---

## 6. 实施计划

### RG-01 成交落库事务化

**目标**

一笔成交对应的以下变更必须原子提交：

```text
orders.filled_qty / status
trades
positions
strategy_positions
审计/事件
```

**建议实现**

- 新增 `ExecutionLedgerService`，把 `applyTrade` 从 `AeronOrderUpdateConsumer` 中抽出来；
- 在同一个 `@Transactional` 方法中完成所有写操作；
- `AeronOrderUpdateConsumer` 只负责解码和调用 ledger service；
- 失败时整笔回滚，不能让 trade 留在 DB 而 position 未更新。

**验收**

```text
[ ] 注入延迟/异常，trade 插入后 position 失败时整笔回滚
[ ] 不存在 trade 已提交但 position 未提交的中间态
[ ] 重复 trade 幂等，不重复更新持仓
```

---

### RG-02 对账结果缓存与作用域

**目标**

不要让 `/risk` 每次现场跑多表查询，也不要让一个策略的问题阻断全部策略。

**建议表**

```sql
reconciliation_status (
  scope_type       TEXT NOT NULL,   -- ACCOUNT / STRATEGY / INSTRUMENT
  scope_id         TEXT NOT NULL,
  passed           BOOLEAN NOT NULL,
  issue_count      INTEGER NOT NULL,
  issues_json      JSONB NOT NULL DEFAULT '[]',
  last_success_at  TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id)
)
```

**刷新方式**

```text
独立 ReconciliationJob
  → 事务内读取一致快照
  → 计算 account/strategy/instrument 结果
  → upsert reconciliation_status
  → 记录 issues_json
```

**risk 接口**

```text
读取 account/strategy 对应状态
  → passed=true 且 last_success_at 未过期
  → reconciliationPass=true
  → 否则 false
```

**验收**

```text
[ ] 期权策略不一致时，PAIR 的 ag2612 不被误拦（除非 PAIR/账户也不一致）
[ ] PAIR 自身不一致时，仍然拒绝 OPEN
[ ] 状态过期超过阈值时，拒绝 OPEN
[ ] 状态查询不触发多表现场对账
```

---

### RG-03 Gate 语义收紧

**规则建议**

```text
OPEN:
  - 相关 account/strategy/instrument 必须 passed
  - last_success_at 超过阈值 → 拒绝
  - 只拒绝受影响 scope

CLOSE / CANCEL:
  - 始终允许（用于降风险）
```

**注意**

- 不要因为一个账户的问题阻断其他账户；
- 不要把“本地一致性”伪装成“场所级对账”；
- 场所级对账完成前，gate 名称/UI 必须明确标注“本地一致性”。

**验收**

```text
[ ] 账户 A 不一致不影响账户 B
[ ] 策略 A 不一致不影响策略 B（同一账户时按策略 scope 判断）
[ ] CLOSE/CANCEL 不被 gate 阻断
```

---

### RG-04 瞬时窗口宽限

**目标**

避免一次异步写窗口导致 5 秒错误缓存。

**建议**

```text
1. reconciliation job 连续 N 次（如 2 次）读到不一致才置 false
2. FILLED_WITHOUT_TRADE 允许 1~2 秒等待 trade 到达
3. trade 先于 order 到达时进入 pending，不立即判定不一致
4. false 状态保留 issue 详情和首次发现时间
```

**验收**

```text
[ ] 模拟 trade/position 写入延迟 100ms，gate 不误报
[ ] 真实持续不一致超过宽限期，gate 仍然 false
```

---

### RG-05 拒绝原因与告警去重

**当前**

```text
reconciliation gate is not passed
```

**建议**

```text
reconciliation gate is not passed:
scope=STRATEGY:TEST-STRAT-OPT-01
issues=[POSITION_MISMATCH au2612C920 position=-3 trades=-2]
lastSuccess=2026-11-08T13:06:20+08:00
```

**Pair 侧**

- 同一 reason/scope 在 30 秒内只发一次 alert；
- 记录 `lastReconciliationAlertAt`；
- 恢复时可选发一条 RECOVERED 事件。

**验收**

```text
[ ] 告警/日志包含具体 scope 和 issue
[ ] 同一原因 30 秒内不重复写 alert
[ ] 恢复后不会继续显示 NEW 误拦告警
```

---

### RG-06 对账历史与诊断

**目标**

下一次出现 false 时，能回答“当时到底哪条不一致”。

**建议**

```text
reconciliation_run (
  run_id,
  started_at,
  finished_at,
  scope_type,
  scope_id,
  passed,
  issue_count,
  issues_json
)
```

保留最近 N 天；UI 可查看最近一次失败和历史趋势。

**验收**

```text
[ ] 每次 job 运行有记录
[ ] 失败时能看到具体 issue、时间、scope
[ ] 能从告警跳到对应 run
```

---

### RG-07 测试

**单元/集成**

```text
[ ] applyTrade 事务回滚测试
[ ] 并发 consistency 读 vs trade/position 写
[ ] 多档成交 + 部分成交 + 撤单
[ ] trade 先于 order 到达
[ ] FILLED_WITHOUT_TRADE 宽限
[ ] 按 account/strategy scope 的 gate
```

**端到端**

```text
[ ] SimLocal 期权策略制造不一致，PAIR ag2612 不被误拦
[ ] PAIR 自身制造不一致，PAIR OPEN 被拒绝
[ ] 控制面 risk 接口返回具体 issue
[ ] 告警去重与恢复
```

---

## 7. 临时处置

### 推荐

```text
保持 QF_RECON_GATE_ENABLED=true
先修事务/作用域/缓存，不直接关闭 gate
```

### 仅用于 SimLocal 调试的临时方案

```text
方案 A：增加 scope 开关
  QF_RECON_GATE_SCOPE=SIMLOCAL
  只让 SimLocal 的 gate 生效/放宽

方案 B：本地测试 profile 关闭 gate
  QF_RECON_GATE_ENABLED=false
  仅在显式 SIMLOCAL + 非生产 profile 下允许

方案 C：保留 gate，但加 2 秒宽限
  用于验证瞬时窗口
```

**禁止**

```text
生产/影子环境全局关闭 gate
用 UPDATE 直接把 consistency 改成 true
为了绕过误拦而删除统一风控
```

---

## 8. 执行顺序

```text
1. RG-01 事务化 ledger
2. RG-02 reconciliation_status + job
3. RG-03 scope gate
4. RG-04 宽限
5. RG-05 诊断/告警
6. RG-06 历史
7. RG-07 测试
```

预计：

```text
RG-01/02/03：2–4 天
RG-04/05/06：1–2 天
测试与回归：1–2 天
```

---

## 9. 验收门槛

```text
[ ] 13:06/13:07 这类 PAIR 误拦不再出现
[ ] 期权策略不一致不会阻断 PAIR
[ ] PAIR 自身不一致仍然阻断 OPEN
[ ] CLOSE/CANCEL 不被 gate 阻断
[ ] 对账失败原因包含 account/strategy/instrument/issue
[ ] 对账历史可查
[ ] 同一原因告警 30 秒内不重复
[ ] 真实持续不一致超过宽限期仍然 false
[ ] 控制面/DB 短暂延迟不产生 5 秒错误缓存
```

---

## 10. 待确认

1. 历史 13:06/13:07 的具体 issue 是什么？
   - 现有系统没有保存，需先补 RG-06 或查日志/审计。
2. Gate 的作用域应该是 `ACCOUNT` 还是 `STRATEGY`？
   - 建议：默认 `ACCOUNT`，策略级 issue 再细化。
3. 场所级对账未完成前，UI 是否把当前 gate 明确标为“本地一致性”？
   - 建议：必须明确，避免误认为是 CTP 场所对账。
4. SimLocal 调试是否允许临时关闭 gate？
   - 建议：仅显式 SIMLOCAL + 非生产 profile，且审计记录。

---

*本文件为修复计划，不包含代码变更。*


---

## 7. 修复落地（2026-11-08）

### RG-01 成交事务化

新增：

```text
ExecutionLedgerService.applyTrade(...)
@Transactional
```

同一事务内完成：

```text
trades
orders.filled_qty/status（从 trades 汇总）
ledger_entries 手续费/已实现盈亏
strategy_positions
positions
```

`AeronOrderUpdateConsumer` 只负责解码、pending 和广播。

### RG-02/03 作用域对账

新增：

```text
reconciliation_status
ScopedReconciliationService
```

策略级结果：

```text
scope_type = STRATEGY
scope_id   = strategyId
passed
issue_count
issues_json
last_success_at
consecutive_failures
```

`/api/v1/strategy-runtime/risk` 改为：

```text
localReconciliationScope=STRATEGY
localReconciliationPass
localReconciliationIssues
localReconciliationLastSuccess
```

PAIR 不再被 OPT 策略的不一致连坐。

### RG-04 宽限

```text
FILLED_WITHOUT_TRADE 只在订单 updated_at 超过 2 秒后判定
```

`ExecutionLedgerService` 事务提交后 trade/position 同时可见，消除中间态。

### RG-05 原因与去重

reject reason 现在包含：

```text
scope=STRATEGY:<id>
issues=[...]
lastSuccess=...
```

Pair 对 reconciliation reason 做 30 秒告警去重。

### RG-06 诊断

新增：

```text
GET /api/v1/reconciliation/status
```

Monitoring 增加“策略级对账 Gate”卡片，显示 PASS/FAIL 和 issue 数。

### 告警消失补充

```text
StrategyView 确认后重新加载 ALL 历史，但“触发提醒”区域只渲染 NEW；
Alerts 页 ACK 后先乐观移除再 reload；
ACK 接口幂等，重复确认返回 duplicate=true。
```

### 当前证据

```text
/api/v1/reconciliation/status:
  TEST-STRAT-PAIR-01  passed=true
  TEST-STRAT-OPT-01   passed=true

/strategy-runtime/risk:
  localReconciliationScope=STRATEGY
  localReconciliationPass=true
  venueReconciliationPass=true
```

仍需下一交易日验证真实 PAIR 发单不被误拦。

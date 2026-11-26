# FastTrade 订单成交与仓位校准计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 FastTrade 的订单状态、成交数量、仓位和撤单在 FILLED/Trade 任意到达顺序下保持一致，并以 `quantlink-trading` 的成交/仓位基线校准。

**Architecture:** 用独立的 `FillLedger` 保存每个 `clientOrderId` 的累计成交量、是否收到 OrderUpdate、Trade 去重集合；仓位只从累计成交增量更新；OrderUpdate 负责订单状态，Trade 负责审计和 OrderUpdate 缺失时的回退；仓位快照只做恢复和对账，不能被旧快照覆盖新成交。

**Tech Stack:** Java 25、Gradle、JUnit 5、SLF4J。

**Spec:**
- `docs/baselines/2026-11-18-quantlink-trading-order-state-baseline.md`
- `docs/superpowers/specs/2026-11-18-fasttrade-tradebot-mvp-design.md`

## Global Constraints

- 一个进程、一个账户、一个 venue、一个策略。
- 同一时间只允许一个 open order。
- 成交数量必须单调不减。
- 仓位只能由成交数量累计得到，不能由订单终态反推。
- `openQty == 0` 才是完成；撤单请求本身不减少仓位。
- 成交/订单回报不能依赖到达顺序。
- 状态和仓位写入失败时 fail-closed。
- 不引入数据库；先保持本地 state + 文件日志。
- 所有关键日志必须能按 `requestId/clientOrderId/tradeId` 串联。

## Current State

已经完成：

```text
ee19498 fix: apply cumulative fills before clearing orders
```

当前行为：

- `TargetPositionStrategy.onOrderUpdate` 通过 `FillLedger` 的累计 `filledQty` 更新仓位。
- `FillLedger` 使用 `max(reportedFilledQty, tradedQty)`，支持 ACK 后只收到 Trade，也支持 Trade 先于 OrderUpdate。
- `FillLedger` 对未知/已淘汰订单的迟到成交先缓存，快照覆盖后丢弃；不会静默忽略或抛异常。
- `FillLedger` 用执行 sequence 去重成交；订单表保留 24 小时或 10 万单，超出后的迟到成交进入 pending。
- 启动时若有 open order，先撤单，再用订单清除后的 quiet snapshot 建立仓位基线；撤单前的成交不直接累加。
- `BotListener.onOrderUpdate` 先更新策略，再交给 `OrderManager` 清订单。
- 已有 `filledUpdateDoesNotSubmitSecondOrderBeforeTrade`、重启基线、未知成交缓存和 190 单订单 E2E 回归。

仍需校准：

- 真实 CTP adapter 的重连重发语义需要在接入时验证。

## Review Focus

1. **FILLED 先于 Trade**：订单终态先到，仓位不能被延迟到下一次快照。
2. **Trade 先于 OrderUpdate**：成交先到，后续累计 OrderUpdate 不能重复加仓。
3. **部分成交后撤单**：撤单确认前已成交的数量必须保留，撤单只减少剩余量。
4. **重复 Trade/重复 OrderUpdate**：同一 `tradeId` 或同一累计成交量不能重复应用。
5. **旧仓位快照**：旧 snapshot 不能把新成交后的仓位改回去。

---

### Task 1: 建立 FillLedger

**Files:**
- Create: `fasttrade-tradebot/src/main/java/com/quantlink/fasttrade/tradebot/FillLedger.java`
- Test: `fasttrade-tradebot/src/test/java/com/quantlink/fasttrade/tradebot/FillLedgerTest.java`

**Interfaces:**
- Produces:
  - `long applyOrderUpdate(long clientOrderId, Side side, int cumulativeFilledQty, long ingestTimestampNanos)`
  - `long applyTrade(long clientOrderId, String tradeId, Side side, int qty, long ingestTimestampNanos)`
  - 两者都返回本次应加到仓位的增量，调用方只应用一次。

规则：

```text
每个 clientOrderId 保存：
  appliedQty
  reportedFilledQty
  tradedQty
  seenTradeIds
```

`applyOrderUpdate`：

```text
reportedFilledQty = max(reportedFilledQty, cumulativeFilledQty)
target = max(reportedFilledQty, tradedQty)
delta = max(0, target - appliedQty)
appliedQty = target
return side == BUY ? delta : -delta
```

`applyTrade`：

```text
if tradeId already seen: return 0
seenTradeIds.add(tradeId)
tradedQty += qty
target = max(reportedFilledQty, tradedQty)
delta = max(0, target - appliedQty)
appliedQty = target
return side == BUY ? delta : -delta
```

订单表使用有界 LRU：

```text
MAX_RECENT_ORDERS = 100_000
保留 24 小时或 10 万单
每订单只保存最后成交 sequence，不保存 Trade ID 集合
```

- [ ] **Step 1: Write failing tests**

Test cases:

```text
orderUpdate 1 -> +1
orderUpdate 2 -> +1 (cumulative, not +2)
ACK filledQty=0 -> 0
trade after ACK qty=1 -> +1
trade same clientOrderId after orderUpdate -> 0
trade first 1 -> +1
orderUpdate later 2 -> +1
duplicate tradeId -> 0
partial after cancel -> only the unfilled delta is added
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
cd /Users/wangjun/PG/quantlink-new/quantlink-fasttrade
JAVA_HOME=<jdk25> ./gradlew :fasttrade-tradebot:test \
  --tests com.quantlink.fasttrade.tradebot.FillLedgerTest
```

Expected: FAIL because `FillLedger` does not exist.

- [ ] **Step 3: Implement `FillLedger`**

最小实现只保存内存账本；不写 state 文件，不引入数据库。

- [ ] **Step 4: Run test to verify green**

```bash
JAVA_HOME=<jdk25> ./gradlew :fasttrade-tradebot:test \
  --tests com.quantlink.fasttrade.tradebot.FillLedgerTest
```

- [ ] **Step 5: Commit**

```bash
git add fasttrade-tradebot/src/main/java/com/quantlink/fasttrade/tradebot/FillLedger.java \
        fasttrade-tradebot/src/test/java/com/quantlink/fasttrade/tradebot/FillLedgerTest.java
git commit -m "feat: add idempotent fill ledger"
```

---

### Task 2: 让策略使用 FillLedger

**Files:**
- Modify: `fasttrade-tradebot/src/main/java/com/quantlink/fasttrade/tradebot/TargetPositionStrategy.java`
- Modify: `fasttrade-tradebot/src/main/java/com/quantlink/fasttrade/tradebot/TradeBotMain.java`
- Test: `fasttrade-tradebot/src/test/java/com/quantlink/fasttrade/tradebot/TargetPositionStrategyTest.java`

**Interfaces:**
- Consumes: Task 1 的 `FillLedger.applyOrderUpdate/applyTrade`.
- Produces: `TargetPositionStrategy.onOrderUpdate(OrderUpdateEnvelope)` 和 `onTrade(TradeEnvelope)` 只通过 ledger 修改 `positionQty`。

Implementation rules:

```text
onOrderUpdate:
    delta = ledger.applyOrderUpdate(...)
    positionQty += delta
    lastTradeIngestNanos = max(...)
    lastPositionAtNanos = lastTradeIngestNanos

onTrade:
    delta = ledger.applyTrade(...)
    positionQty += delta
    lastTradeIngestNanos = max(...)
    lastPositionAtNanos = lastTradeIngestNanos
```

`BotListener.onOrderUpdate` 必须先调用 strategy，再调用 OrderManager。

- [ ] **Step 1: Write failing test**

Add `filledUpdateDoesNotSubmitSecondOrderBeforeTrade` to `TargetPositionStrategyTest`. `FillLedgerTest` already covers ACK-then-Trade at the ledger level.

Required setup:

```text
position 0, target 1
strategy.onTick -> exactly one submit
orderUpdate FILLED filledQty=1
strategy.onTick -> still exactly one submit
positionQty == 1
```

Do not stop at a position assertion. The test must run the next `onTick` and count submits.

- [ ] **Step 2: Run tests and verify failure**

```bash
JAVA_HOME=<jdk25> ./gradlew :fasttrade-tradebot:test \
  --tests com.quantlink.fasttrade.tradebot.TargetPositionStrategyTest
```

- [ ] **Step 3: Replace ad-hoc `filledOrderId/knownFilledQty` fields with `FillLedger`**

Keep `lastTradeIngestNanos` and `lastPositionAtNanos` in the strategy.

- [ ] **Step 4: Run all tradebot tests**

```bash
JAVA_HOME=<jdk25> ./gradlew :fasttrade-tradebot:test
```

- [ ] **Step 5: Commit**

```bash
git add fasttrade-tradebot/src/main/java/com/quantlink/fasttrade/tradebot/TargetPositionStrategy.java \
        fasttrade-tradebot/src/main/java/com/quantlink/fasttrade/tradebot/TradeBotMain.java \
        fasttrade-tradebot/src/test/java/com/quantlink/fasttrade/tradebot/TargetPositionStrategyTest.java
git commit -m "fix: apply fills from one idempotent ledger"
```

---

### Task 3: 校准 OrderManager 的终态与撤单

**Files:**
- Modify: `fasttrade-tradebot/src/main/java/com/quantlink/fasttrade/tradebot/OrderManager.java`
- Test: `fasttrade-tradebot/src/test/java/com/quantlink/fasttrade/tradebot/OrderManagerTest.java`

**Interfaces:**
- Consumes: `OrderUpdateEnvelope.status()`, `filledQty()`, `remainingQty()`.
- Produces: no position mutation; only order lifecycle.

Rules:

```text
PENDING --ACK/PARTIAL--> OPEN
OPEN --FILLED/CANCELED--> NONE
CANCELING --CANCELED--> NONE
CANCELING --REJECTED(other)--> stays CANCELING
CANCELING --REJECTED(unknown)--> NONE
```

Required tests:

```text
FILLED clears the open order once
CANCELED clears the open order once
unknown cancel clears state
cancel reject retries, then fails closed
```

Do not test Trade in OrderManager. Trade is handled by `TargetPositionStrategy`.

- [ ] **Step 1: Write the four failing tests**
- [ ] **Step 2: Run and verify failure**
- [ ] **Step 3: Keep position out of OrderManager and log transitions**
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

```bash
git add fasttrade-tradebot/src/main/java/com/quantlink/fasttrade/tradebot/OrderManager.java \
        fasttrade-tradebot/src/test/java/com/quantlink/fasttrade/tradebot/OrderManagerTest.java
git commit -m "test: lock order terminal transitions"
```

---

### Task 4: 仓位快照恢复验证

**Files:**
- Test: `fasttrade-tradebot/src/test/java/com/quantlink/fasttrade/tradebot/TargetPositionStrategyTest.java`

规则：

```text
localFillsApplied == false:
    snapshot.timestamp < lastTradeIngest -> ignore
    otherwise accept as bootstrap/recovery
localFillsApplied == true:
    ignore all snapshots; local fill ledger is authoritative
```

已实现 `acceptedSnapshotCannotOverwriteLocalFill` 和 `oldSnapshotCannotUndoFill`。

- [ ] **Step 1: Run both snapshot tests**
- [ ] **Step 2: Verify they pass**
- [ ] **Step 3: Do not add snapshot overwrite logic**
- [ ] **Step 4: Run all tradebot tests**
- [ ] **Step 5: Commit only if tests changed**

```bash
git add fasttrade-tradebot/src/test/java/com/quantlink/fasttrade/tradebot/TargetPositionStrategyTest.java
git commit -m "test: pin local fill authority"
```

---

### Task 5: 190 行为验收

**Files:** none.

Preconditions:

```text
SimVenue 0.2.2
FastTrade on branch feat/access-simvenue-implementation
fresh state directory
targetQty=1
```

- [ ] **Step 1: Start fresh SimVenue and TradeBot**
- [ ] **Step 2: Verify exactly one order and one trade**

```bash
# STRATEGY_KEY comes from the TradeBot config
grep -c "simvenue.order.received.*strategyKey=${STRATEGY_KEY}" "${SIMVENUE_LOG}"
grep -c "simvenue.trade.*strategyKey=${STRATEGY_KEY}" "${SIMVENUE_LOG}"
```

Expected: both `1`.

- [ ] **Step 3: Verify final state**

```text
TradeBot health: positionQty=1, orderState=NONE
SimVenue health: positions=1, orders=0
```

- [ ] **Step 4: Re-run cancel/reprice smoke**

Expected:

```text
OPEN -> CANCELING reason=reprice timeout
CANCELED
```

- [ ] **Step 5: Commit any test-only adjustments**

No production change is expected in this task.

## Self-Review

- Baseline invariants 1-10 map to FillLedger, OrderManager, strategy snapshot tests, and Task 5 E2E.
- FILLED-before-Trade and Trade-before-OrderUpdate both have explicit tests.
- Partial cancel, duplicate trade, and stale snapshot have explicit tests.
- No database, no new framework, no position update in OrderManager.
- Current commit `ee19498` remains the starting point; this plan adds idempotent trade fallback and locks the invariants with tests.

## Execution Handoff

Plan saved. Please review it. Which execution approach do you want?

- **Subagent-driven** — fresh implementer/reviewer per task; better when the fill ledger and order lifecycle interfaces must stay exact.
- **Native** — I implement the tasks in this session and then run one review; cheaper and faster.

# Contract 0.2.0 Conformance 收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 contract 0.2.0 的枚举/必填字段 conformance 测试，更新 README，并发布 `0.2.0` artifact。

**Architecture:** 不改 SBE schema。`OrderRequest` / `ModifyRequest` 的 envelope 已经校验必填字段，但漏了 `offsetFlag`；先写失败测试，再补校验。枚举覆盖用 parameterized round-trip 测试固定 wire 值。最后更新 README、运行全量测试、`publishToMavenLocal`。

**Tech Stack:** Java 25、Gradle 9.8.2、SBE、JUnit 5。

**Spec:** `docs/superpowers/specs/2026-11-23-l0-contract-design.md`

## Global Constraints

```text
Contract 版本：0.2.0
不新增字段、不改 SBE schema
不把 L2 的交易所规则放进 contract
Java toolchain 25
```

## Review Focus

- `offsetFlag` 为 null 时，OrderRequest/ModifyRequest 必须在编码前拒绝。
- `timeInForce` 为 null 时同样拒绝。
- 所有 Offset / TimeInForce 枚举值必须能 round-trip。
- contract 不按 exchange 拒绝 CLOSE_TODAY/CLOSE_YESTERDAY；这是 L2 规则。
- README 只描述当前 0.2.0，不保留 v0.1 迁移/兼容说明。

---

### Task 1: 补必填字段校验

**Files:**
- Modify: `venue-contract/src/test/java/com/quantlink/contract/venue/VenueEnvelopeRequiredFieldsTest.java`
- Modify: `venue-contract/src/main/java/com/quantlink/contract/venue/OrderRequestEnvelope.java`
- Modify: `venue-contract/src/main/java/com/quantlink/contract/venue/ModifyRequestEnvelope.java`

**Interfaces:**
- Consumes: existing `OrderRequestEnvelope` / `ModifyRequestEnvelope` constructors.
- Produces: same constructors, now reject null `offsetFlag`.

- [ ] **Step 1: Write the failing test**

Add to `VenueEnvelopeRequiredFieldsTest`:

```java
@Test
void orderRequestRequiresOffsetFlag() {
    assertThrows(IllegalArgumentException.class, () -> new OrderRequestEnvelope(
        "SIMNOW", "SHFE", "TEST-001", "req", "SHADOW", 1, "au2612",
        Side.BUY, null, OrderType.LIMIT, TimeInForce.DAY, 1, 1, 1, 1));
}

@Test
void modifyRequestRequiresOffsetFlag() {
    assertThrows(IllegalArgumentException.class, () -> new ModifyRequestEnvelope(
        "SIMNOW", "SHFE", "TEST-001", "req", "SHADOW", 1, "au2612",
        Side.BUY, null, OrderType.LIMIT, TimeInForce.DAY, 1, 1, 0, 1, 1, 1));
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@25 ./gradlew :venue-contract:test \
  --tests com.quantlink.contract.venue.VenueEnvelopeRequiredFieldsTest --no-daemon
```

Expected: FAIL because null `offsetFlag` is accepted.

- [ ] **Step 3: Add null check**

In both envelope constructors, change:

```java
if (side == null || orderType == null || timeInForce == null) {
```

to:

```java
if (side == null || offsetFlag == null || orderType == null || timeInForce == null) {
```

- [ ] **Step 4: Run tests to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add venue-contract/src/test/java/com/quantlink/contract/venue/VenueEnvelopeRequiredFieldsTest.java \
  venue-contract/src/main/java/com/quantlink/contract/venue/OrderRequestEnvelope.java \
  venue-contract/src/main/java/com/quantlink/contract/venue/ModifyRequestEnvelope.java
git commit -m "test(contract): require offsetFlag on order and modify"
```

---

### Task 2: 枚举 conformance coverage

**Files:**
- Create: `venue-contract/src/test/java/com/quantlink/contract/venue/VenueEnumConformanceTest.java`

**Interfaces:**
- Consumes: `OrderRequestCodec`, `OrderRequestEnvelope`, `Offset`, `TimeInForce`.
- Produces: no production code; pins all enum values round-trip.

- [ ] **Step 1: Write the test**

Create a parameterized JUnit test:

```java
@ParameterizedTest
@EnumSource(Offset.class)
void orderRequestRoundTripsEveryOffset(Offset offset) { ... }

@ParameterizedTest
@EnumSource(TimeInForce.class)
void orderRequestRoundTripsEveryTimeInForce(TimeInForce tif) { ... }
```

Use exchange `SHFE`, qty 1, price 1, session 1, epoch 1. Encode with `OrderRequestCodec`, decode, assert the enum equals the input.

- [ ] **Step 2: Run tests**

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@25 ./gradlew :venue-contract:test \
  --tests com.quantlink.contract.venue.VenueEnumConformanceTest --no-daemon
```

Expected: PASS. This is a pin of existing wire behavior, not new code.

- [ ] **Step 3: Commit**

```bash
git add venue-contract/src/test/java/com/quantlink/contract/venue/VenueEnumConformanceTest.java
git commit -m "test(contract): cover every offset and timeInForce value"
```

---

### Task 3: README 与发布

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README to 0.2.0**

Replace the `v0.1` block with the current 0.2.0 links:

```text
v0.2.0：
- [设计文档](docs/superpowers/specs/2026-11-23-l0-contract-design.md)
- [字段字典](docs/contract-fields.md)
- [与 trading 的字段差异](docs/trading-field-diff.md)
- [实施计划](docs/superpowers/plans/2026-11-23-l0-contract.md)
```

- [ ] **Step 2: Full test**

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@25 ./gradlew test --no-daemon
```

Expected: PASS.

- [ ] **Step 3: Publish to Maven local**

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@25 ./gradlew publishToMavenLocal --no-daemon
```

Expected: BUILD SUCCESSFUL; `~/.m2/repository/com/quantlink/contract/venue-contract/0.2.0` and `venue-contract-sbe/0.2.0` exist.

- [ ] **Step 4: Commit and push**

```bash
git add README.md
git commit -m "docs(contract): update README to 0.2.0"
git push origin dev
```

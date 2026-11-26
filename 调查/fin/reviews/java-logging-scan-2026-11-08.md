# Java 日志统一扫描（2026-11-08）

## 规则

已加入 `java-code-review` skill：

```text
/Users/wangjun/.claude/skills/java-code-review/SKILL.md
```

新增规则 5：统一日志（SLF4J）。

- 应用/服务代码必须使用 `org.slf4j.Logger` + `LoggerFactory`
- 禁止 `System.out` / `System.err` / `printStackTrace`
- 独立模块补 `slf4j-api` + `logback-classic`
- 异常对象作为最后一个日志参数
- 关键日志带 `requestId/clientOrderId/accountId/strategyId/orsId/instrumentId`
- 禁止打印密码、AuthCode、完整 token
- CLI/测试的输出属于明确例外

## 扫描范围

```text
backend/**/src/main/**/*.java
```

扫描命令：

```bash
rg -n "System\.(out|err)\.(print|printf|println)|printStackTrace" \
  backend --glob '*.java' --glob '!**/src/test/**'

rg -n "log\.(info|warn|error|debug|trace)\([^;]*\+" \
  backend --glob '*.java' --glob '!**/src/test/**'
```

## 扫描结果

```text
主代码 System.out/err          14 行（全部是 CLI 输出，已加注释例外）
主代码 printStackTrace          0
使用 SLF4J Logger 的主代码类     20
SLF4J 日志调用                  70
```

### 已统一

- Control Plane：SLF4J + Logback（Spring Boot）
- Runtime Runner：SLF4J + Logback
- Runtime Agent：SLF4J + Logback
- Sim Venue：SLF4J + Logback
- Sim Exchange：SLF4J
- 日志格式统一为：

```text
yyyy-MM-dd'T'HH:mm:ss.SSSXXX LEVEL [thread] logger requestId=... - message
```

- Control Plane 请求日志继续通过 `RequestIdFilter` 写入 MDC。
- 异常日志统一使用 `log.error("...", ex)`，不再 `printStackTrace`。

### CLI 例外

以下类保留标准输出，并在类声明处注释说明：

```text
backend/ors-core/.../OrsBench.java
backend/replay-gateway/.../ReplayCli.java
backend/shared/aeron/.../AeronEchoCli.java
backend/shared/config/.../ConfigCheck.java
backend/synthetic-chain/.../SyntheticChainCli.java
```

这些是 CLI/benchmark 结果输出，不是服务日志。

### 剩余 P2

仍有 35 处历史日志使用字符串拼接，例如：

```java
log.info("[pair] strategy=" + config.strategyId() + " leg1=" + leg1 + " leg2=" + leg2);
```

这些不在 tick 成功热路径上，且多数为启动/错误日志，因此列为 P2，不阻塞。
后续可逐步改为：

```java
log.info("[pair] strategy={} leg1={} leg2={}", config.strategyId(), leg1, leg2);
```

## 验证

```text
./gradlew test       PASS
printStackTrace      main=0
System.out/err       main=14（CLI 例外）
```

## 结论

```text
COMMENT
```

- P0：0
- P1：0
- P2：35 处字符串拼接日志（非热路径）
- CLI/测试输出：允许，已显式标注

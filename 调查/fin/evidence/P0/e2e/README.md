# P0-8 端到端（Java 直连版）— 验证证据

- 日期：2026-11-06
- 状态：PASS（流程验证；Aeron 版待做）
- 任务：T-005 + T-006 + T-007

## 1. 测试

```bash
source .tools/env.sh
./gradlew :backend:sim-exchange:test --tests '*P0EndToEndTest' --no-daemon
```

结果：PASS。

## 2. 流程

1. 从 `tests/fixtures/u50_sample.csv` 读取 `ad2605` 期货 tick（23800）
2. 生成 `ad2605` 模拟期权链（5 档 × Call/Put = 10 个期权）
3. 将每个期权的 bid/ask 注入 SimExchange
4. 对第一个期权下 BUY 2 手限价单
5. 验证：FILLED、持仓 +2、现金减少

## 3. 说明

- 当前是 Java 直连验证，不经过 Aeron
- Aeron 版端到端需要 Replay/Synthetic 发布 SBE MarketData，再经 SimExchange 消费
- 作为 P0-8 的第一阶段证据

## 4. Aeron 版端到端（2026-11-06 补）

```bash
./gradlew :backend:sim-exchange:test --tests '*P0AeronEndToEndTest' --no-daemon
```

结果：PASS。

流程：

1. Replay 读取 `ad2605` 期货 tick
2. 生成 synthetic 期权链
3. 通过 Aeron `MarketData` 发布
4. SimExchange gateway 消费并更新订单簿
5. 通过 Aeron `OrderRequest` 下 BUY 2 手
6. 收到 `OrderUpdate` FILLED，持仓 +2

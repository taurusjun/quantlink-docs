# T-007 Sim Exchange — 阶段证据

- 日期：2026-11-06
- 状态：DOING（撮合核心完成，Aeron gateway 待接）
- 任务：T-007

## 1. 测试

```bash
source .tools/env.sh
./gradlew :backend:sim-exchange:test --no-daemon
```

结果：6 tests passed。

覆盖：

- 限价买入按卖一成交
- 市价单穿越多档
- FAK 部分成交后撤销剩余
- DAY 挂单 + 撤单
- 卖出按买一成交
- FOK 不足量时全撤、不产生成交
- 持仓/现金同步更新

## 2. 后续

- 接入 Aeron + SBE order-request/order-update
- 支持期权保证金、手续费、部分成交回报
- 与 SyntheticOptionChain 联合做 P0-8 端到端

## 3. Aeron gateway（2026-11-06 补）

```bash
./gradlew :backend:sim-exchange:test --no-daemon
```

`SimExchangeAeronGatewayTest` 通过：

- 通过 Aeron 发布 `MarketData`
- 通过 Aeron 提交 `OrderRequest`
- 通过 Aeron 收到 `OrderUpdate` + `Trade`
- FILLED、持仓 +3

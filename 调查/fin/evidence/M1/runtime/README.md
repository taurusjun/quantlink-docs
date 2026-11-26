# M1 Runtime MVP — 验证证据

- 日期：2026-11-06
- 状态：PASS（单元/组件级）
- 任务：T-008 / T-009 / T-010 / T-011 / T-012

## 测试

```bash
source .tools/env.sh
./gradlew :backend:runtime:test --no-daemon
```

结果：13 tests passed。

| 测试类 | 数量 | 覆盖 |
|---|---:|---|
| RuntimeEngineTest | 1 | 行情→指标→策略→意图 |
| RuntimeAeronServiceTest | 1 | Aeron 行情进、订单出 |
| OptionPricingTest | 3 | BS、IV 反解、Parity、Greeks |
| PortfolioTest | 1 | 持仓/现金/Delta/Vega |
| RiskEngineTest | 4 | 手数/持仓/价格偏离/正常单 |
| OrderManagerTest | 1 | 新建/部分成交/完成/撤单 |
| OptionQuotingStrategyTest | 1 | 双边报价、价差 |
| SimpleHedgingStrategyTest | 1 | Delta 对冲方向/数量 |

## 结论

Runtime MVP 核心链路成立：

```
Aeron MarketData → RuntimeEngine → Indicator → Strategy → Risk/OMS → Aeron OrderRequest
```

下一步：

- 与 SimExchange gateway 做完整闭环
- 增加指标 DAG 配置化
- 增加期权链/组合 Greeks 实时更新

# T-025 热路径指标与 soak 证据

执行日期：2026-11-08
环境：SimLocal / Aeron 直连 / 4 vCPU

## 热路径指标

Pair runner 多次采样范围：

```text
tickToDecisionP50Ns  ≈ 0.96 ~ 1.11 ms
tickToDecisionP99Ns  ≈ 4.9 ~ 6.3 ms
decisionToOrderP50Ns ≈ 0.29 ~ 1.05 ms
decisionToOrderP99Ns ≈ 3.0 ~ 4.1 ms
aeronBackpressure    = 0
runnerQueueDepth     = 0 ~ 2
controlPlaneLagMs    = 1 ~ 5 ms
```

指标由 `RunnerMetrics` 每 30 秒写入 runner 日志：

```text
[metrics] {strategyId=..., tickToDecisionP99Ns=..., decisionToOrderP99Ns=...,
           aeronBackpressure=..., runnerQueueDepth=..., controlPlaneLagMs=...}
```

## Soak

```bash
/opt/quantlink-fin/tools/soak-simlocal.sh 3600 30
```

当前日志：

```text
/var/log/quantlink-fin/soak-20261108-114010.log
```

截至目前：

```text
运行 6+ 分钟
FAIL 0
reconciliation true:0
aeronBackpressure 0
```

期间执行了 SimLocal 网关重启、控制面/策略重连等故障演练，soak 仍保持
`reconciliation=true:0`。

说明：完整 1 小时/5 个交易日长稳仍需更长时间窗口；本证据为可重复的
非交易时段 soak 样本。

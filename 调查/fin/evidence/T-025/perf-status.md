# T-025 性能/稳定性当前状态

执行日期：2026-11-08

## 已达标

Aeron Java ↔ C++ 100k 双向延迟基线（P0 报告）：

```text
Java client: count=100000 p50=292ns p99=3041ns p999=12542ns
```

p99 = 3.041µs < 100µs。

SimLocal 本地一致性门禁：

```text
reconciliation passed=true
issueCount=0
```

## 未完成/阻塞

```text
连续 5 个交易日无重大故障      需要交易日
场所级对账无差异              需要 CTP 交易时段
影子/小资金试点                需要交易日
回滚演练                       可在非交易时段补做
```

性能基线可复用 `docs/evidence/P0/T-003/README.md`。

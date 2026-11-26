# T-025 性能、稳定性与试点 — 阶段证据

- 日期：2026-11-06
- 状态：DOING（本地基准通过，长稳/试点待做）

## 测试

```bash
./gradlew test
# 45 tests, 0 failures
```

## ORS 路由吞吐

```bash
./gradlew :backend:ors-core:run --args='100000'
# orders=1000000 elapsed_ms=313.47 throughput=3190061 orders/s
```

说明：本地内存模拟，不含网络/CTP/Aeron；用于回归趋势，不作为生产 SLA。

## Aeron 延迟

沿用 P0 报告：Java↔C++ 双向 100k，p99≈3µs，0 丢失。

## 待完成

- 30 分钟/4 小时长稳
- 影子库 + Replay 全天压力
- CTP 评测盘 1 手连续报单/撤单
- 内存/句柄/磁盘增长监控

## 2026-11-06 稳定性补充

```bash
bash tools/run_stability.sh 20
# sim-exchange acceptance: 20/20 rounds passed
```

ORS 100 万单：

```text
orders=1000000 elapsed_ms=303.45 throughput=3295463 orders/s
```

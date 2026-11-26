# T-005 Replay Gateway — 阶段证据

- 日期：2026-11-06
- 状态：DOING（解析器 MVP 完成，Aeron 发布/全天文件待做）
- 任务：T-005

## 1. 测试

```bash
source .tools/env.sh
./gradlew :backend:replay-gateway:test --no-daemon
```

结果：4 tests passed。

## 2. CLI 验证

```bash
java -cp backend/replay-gateway/build/classes/java/main \
  com.quantlink.fin.replay.ReplayCli \
  --file tests/fixtures/u50_sample.csv --sample 3
```

输出摘要：

```
ad2604C26200 option=true bid1=5.00 ask1=0.00 last=61.00 ts=1773752341056000000
...
ReplayStats{total=100, futures=1, options=99, malformed=0, filtered=0, symbols=100}
```

## 3. 说明

- fixture 来自 190 `/data/u50_data/20260318/source/u50_20260318.csv` 前 100 行
- 包含真实期权 tick（`ad2604C/P`）
- 第一批数据在 20:59 集合竞价前后，ask 可能为 0，属正常
- 后续：接 Aeron + SBE 发布，跑全天文件并核对总行数

## 4. 全天文件统计（2026-11-06 补）

190 `/data/u50_data/20260318/source/u50_20260318.csv`（9.5GB）单遍统计：

```text
rows=25664907 options=17309485 futures=8355422
```

结论：

- 全天共 25,664,907 行数据
- 期权 17,309,485 行
- 期货 8,355,422 行
- 证明该文件确实包含大量真实期权 tick

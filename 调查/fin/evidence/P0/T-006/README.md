# T-006 Synthetic Option Chain — 阶段证据

- 日期：2026-11-06
- 状态：DOING（生成器完成，Aeron 发布待做）
- 任务：T-006

## 1. 测试

```bash
source .tools/env.sh
./gradlew :backend:synthetic-chain:test --no-daemon
```

结果：6 tests passed。

覆盖：

- 10 个行权价 → 20 个期权（Call/Put）
- 相同输入确定性
- 负 skew：低行权价 IV 更高
- Call-Put Parity 成立
- bid < ask、Greeks 合理
- 到期日过去时按 1 天处理

## 2. CLI 输出

```bash
java -cp backend/synthetic-chain/build/classes/java/main \
  com.quantlink.fin.synthetic.SyntheticChainCli --strikes 5 --step 20
```

摘要：

```
au2612C870,870.00,C,0.1909,57.2252,57.2052,57.2452,0.776372,105.5955
au2612P870,870.00,P,0.1909,8.9509,8.9309,8.9709,-0.220619,105.5955
...
```

## 3. 后续

- 通过 Aeron + SBE `MarketData` 发布 synthetic 行情
- 与 Replay Gateway 联合，形成 P0-8 端到端

## 4. Aeron 发布（2026-11-06 补）

```bash
./gradlew :backend:synthetic-chain:test --no-daemon
```

`SyntheticChainPublisherTest` 通过：10 个 synthetic 期权通过 Aeron `MarketData` 发布并订阅成功，`synthetic=true`。

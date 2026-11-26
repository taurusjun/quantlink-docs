# T-009 期权定价与组合 Greeks

- 状态：DONE
- 阶段：P2
- 依赖：T-008
- 负责人：AI

## 1. 目标

实现 BS 定价、IV 反解、Parity、Basis EMA、Greeks、组合 Delta/Vega/PnL。

## 2. 范围

### 做

- BS call/put
- Newton/Bisection IV
- Parity/basis
- Delta/Vega/Gamma/Theta
- 组合 Greeks/乘数

### 不做

- 不做行权
- 不做复杂波动率曲面拟合

## 3. 交付物

- option/pricing
- option/greeks
- option/portfolio
- 黄金测试

## 4. 设计要点

纯函数优先；价格 long 缩放；IV 失败回退；Greeks 每 tick 或 100ms 更新。

## 5. 验收标准

- [x] BS 价格与已知值一致
- [x] IV roundtrip 误差 < 1e-6
- [x] Parity 关系成立
- [x] 组合 Delta 与手工汇总一致

## 6. 测试用例

| 用例 ID | 类型 | 场景 | 步骤 | 期望结果 | 测试数据 |
|---|---|---|---|---|---|
| TC-T009-01 | unit | BS call/put | 已知 F/K/T/r/IV | 价格匹配基准 | 黄金数据 |
| TC-T009-02 | unit | IV 反解 | 价格→IV→价格 | 误差 < 1e-6 | 多组 |
| TC-T009-03 | unit | Parity | C-P 与 F-K | 容差内 | 固定参数 |
| TC-T009-04 | unit | 组合 Greeks | 两手期权+期货 | Delta/Vega 汇总正确 | 固定持仓 |

## 7. 可视化验证

Greeks 曲线、IV 微笑、组合 Delta 柱状图。

## 8. 风险

公式与 C++ 基线差异；IV 不收敛。

## 9. DoD

- [x] 代码/文档已提交
- [x] 已 commit 并 push 到 origin
- [x] 测试用例全部通过
- [x] 可视化证据已归档
- [x] 任务状态更新为 DONE
- [x] 里程碑验收清单已更新

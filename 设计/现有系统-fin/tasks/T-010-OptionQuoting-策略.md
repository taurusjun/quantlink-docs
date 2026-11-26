# T-010 OptionQuoting 策略

- 状态：DONE
- 阶段：P2
- 依赖：T-009, T-007
- 负责人：AI

## 1. 目标

实现期权双边做市报价：理论价、价差、偏置、最大持仓、撤改。

## 2. 范围

### 做

- theo bid/ask
- quote width
- delta/vega/position bias
- max quote level
- cancel/replace

### 不做

- 不做复杂波动率套利

## 3. 交付物

- optionquoting 策略
- 配置
- 回放+Sim 集成测试
- 报价截图

## 4. 设计要点

基于组合 Greeks 偏置；禁止穿价；库存超限只减仓；报价粘性 slop。

## 5. 验收标准

- [x] 能生成双边报价
- [x] 不穿过对手价
- [x] 达到最大持仓停止同方向报价
- [x] Sim 中可成交并更新持仓

## 6. 测试用例

| 用例 ID | 类型 | 场景 | 步骤 | 期望结果 | 测试数据 |
|---|---|---|---|---|---|
| TC-T010-01 | integration | 生成报价 | 回放 1 分钟 | bid/ask 存在且合法 | synthetic 链 |
| TC-T010-02 | unit | 不穿价 | theo 穿越市场 | 报价被夹住 | 固定盘口 |
| TC-T010-03 | unit | 最大持仓 | netpos 达上限 | 同方向停止报价 | 固定持仓 |
| TC-T010-04 | integration | 成交/撤改 | Sim 成交后 | 持仓/报价更新 | Sim |

## 7. 可视化验证

报价 Ladder 截图、持仓/Greeks 截图。

## 8. 风险

偏置公式错误；报价抖动；Greeks 滞后。

## 9. DoD

- [x] 代码/文档已提交
- [x] 已 commit 并 push 到 origin
- [x] 测试用例全部通过
- [x] 可视化证据已归档
- [x] 任务状态更新为 DONE
- [x] 里程碑验收清单已更新

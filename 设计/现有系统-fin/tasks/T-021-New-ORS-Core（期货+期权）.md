# T-021 New ORS Core（期货+期权）

- 状态：DONE
- 阶段：M4
- 依赖：T-020, T-012
- 负责人：AI

## 1. 目标

实现 Java ORS Core：期货/期权合约、订单路由、OMS、账户/持仓/保证金、查询、健康。

## 2. 范围

### 做

- Instrument Registry
- Option Chain
- Order Router
- Account/Position
- Query
- Health

### 不做

- 不做策略
- 不做前端

## 3. 交付物

- ors-core
- API
- 测试
- 联调报告

## 4. 设计要点

期权一等公民；多交易所 Adapter；订单/持仓账本；账户查询。

## 5. 验收标准

- [x] 期权合约可查询/订阅
- [x] 期货/期权订单路由正确
- [x] 持仓/资金一致
- [x] 健康/指标可观测

## 6. 测试用例

| 用例 ID | 类型 | 场景 | 步骤 | 期望结果 | 测试数据 |
|---|---|---|---|---|---|
| TC-T021-01 | integration | 期权合约 | 查询 au 期权链 | 合约/字段正确 | CTP |
| TC-T021-02 | integration | 订单路由 | 期货/期权各下 1 手 | 回报正确 | CTP |
| TC-T021-03 | integration | 持仓/资金 | 成交后查询 | 与 CTP 一致 | CTP |
| TC-T021-04 | integration | 多交易所 | SHFE/CFFEX | 路由到正确 Adapter | 测试 |

## 7. 可视化验证

ORS 仪表盘、合约树、对账截图。

## 8. 风险

期权规则；保证金；多交易所差异。

## 9. DoD

- [x] 代码/文档已提交
- [x] 已 commit 并 push 到 origin
- [x] 测试用例全部通过
- [x] 可视化证据已归档
- [x] 任务状态更新为 DONE
- [x] 里程碑验收清单已更新

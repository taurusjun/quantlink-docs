# T-006 Synthetic Option Chain

- 状态：DONE
- 阶段：M1
- 依赖：T-002, T-005
- 负责人：AI

## 1. 目标

在缺少实时期权行情的日期/场景，基于期货回放生成模拟期权链（平值 IV + 简单 skew），并支持后续切换到真实期权 replay。

## 2. 范围

### 做

- 按标的/到期/行权价生成期权合约
- BS 定价、IV skew、bid/ask 价差
- Greeks 计算
- Aeron + SBE 发布，标记 synthetic
- 确定性 seed
- 可切换真实期权 replay（20260318 样本）

### 不做

- 不模拟真实期权流动性
- 不做行权

## 3. 交付物

- synthetic-chain 模块
- 配置样例
- CLI
- 单元测试

## 4. 设计要点

F 来自期货中间价；IV = base + skew*(K/F-1) + term；bid/ask 围绕 theo；synthetic=true。

## 5. 验收标准

- [x] 期权链数量/行权价正确
- [x] 看涨看跌 parity 合理
- [x] Greeks 与 BS 公式一致
- [x] 相同 seed 输出确定

## 6. 测试用例

| 用例 ID | 类型 | 场景 | 步骤 | 期望结果 | 测试数据 |
|---|---|---|---|---|---|
| TC-T006-01 | unit | 期权链生成 | au2612 + 10 个行权价 | 生成 20 个期权合约 | 配置 |
| TC-T006-02 | unit | IV skew | K/F 偏离 | IV 按 skew 变化 | 固定 F |
| TC-T006-03 | unit | Parity 检查 | C-P 与 F-K 关系 | 在容差内 | 固定 T/r |
| TC-T006-04 | integration | Aeron 发布 | 回放 1 分钟 | Runtime 收到 synthetic 行情 | Sim 环境 |

## 7. 可视化验证

期权链表格、波动率微笑曲线、Greeks 曲线截图。

## 8. 风险

模拟数据误导策略；IV 参数不合理。

## 9. DoD

- [x] 代码/文档已提交
- [x] 已 commit 并 push 到 origin
- [x] 测试用例全部通过
- [x] 可视化证据已归档
- [x] 任务状态更新为 DONE
- [x] 里程碑验收清单已更新

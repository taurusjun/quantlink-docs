# T-008 Runtime 核心管线

- 状态：DONE
- 阶段：M1/P2
- 依赖：T-002, T-003, T-005
- 负责人：AI

## 1. 目标

实现行情→指标 DAG→策略→风控→OMS 的热路径框架。

## 2. 范围

### 做

- Aeron 订阅/发布
- MarketData 归一化
- Indicator DAG 与算子
- Strategy 接口/生命周期
- Risk/OMS 接口
- Telemetry 快照

### 不做

- 不实现具体期权策略
- 不做 Web

## 3. 交付物

- runtime 模块
- 示例策略
- 指标算子
- 集成测试

## 4. 设计要点

单 Shard 单线程；Agrona RingBuffer；热路径零分配；定时器独立。

## 5. 验收标准

- [x] 回放 tick 能驱动完整管线
- [x] 指标按 DAG 顺序计算
- [x] 策略收到 OnTick/OnTimer
- [x] 优雅停止无丢失订单

## 6. 测试用例

| 用例 ID | 类型 | 场景 | 步骤 | 期望结果 | 测试数据 |
|---|---|---|---|---|---|
| TC-T008-01 | integration | tick 驱动 | 回放 1000 tick | 指标/策略回调次数正确 | 固定数据 |
| TC-T008-02 | unit | 指标 DAG 顺序 | A→B→C 依赖 | 计算顺序正确 | 测试 DAG |
| TC-T008-03 | integration | 策略下单 | 示例策略产生 OrderIntent | OMS 收到 | Sim |
| TC-T008-04 | perf | 热路径分配 | 跑 10 万 tick | 无持续堆增长/低 GC | JFR |

## 7. 可视化验证

管线时序图、tick 处理速率、延迟直方图。

## 8. 风险

热路径分配；线程模型错误；指标依赖环。

## 9. DoD

- [x] 代码/文档已提交
- [x] 已 commit 并 push 到 origin
- [x] 测试用例全部通过
- [x] 可视化证据已归档
- [x] 任务状态更新为 DONE
- [x] 里程碑验收清单已更新

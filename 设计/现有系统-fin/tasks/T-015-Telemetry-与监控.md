# T-015 Telemetry 与监控

- 状态：DONE
- 阶段：M3
- 依赖：T-013, T-008
- 负责人：AI

## 1. 目标

Runtime 状态/事件上报，写 ClickHouse，WebSocket 推送，告警。

## 2. 范围

### 做

- 状态快照
- 订单/成交事件
- 指标/PnL
- 延迟
- 告警规则
- TTL

### 不做

- 不做前端页面

## 3. 交付物

- telemetry 模块
- ClickHouse schema
- WebSocket
- 告警
- 测试

## 4. 设计要点

热路径旁路；批量异步；快照+增量；序列号；采样。

## 5. 验收标准

- [x] 状态快照写入 ClickHouse
- [x] WebSocket 收到更新
- [x] 阈值告警触发/恢复
- [x] TTL 366 天配置生效

## 6. 测试用例

| 用例 ID | 类型 | 场景 | 步骤 | 期望结果 | 测试数据 |
|---|---|---|---|---|---|
| TC-T015-01 | integration | 状态上报 | Runtime 启动 | CH 有快照 | 影子 CH |
| TC-T015-02 | integration | 订单事件 | Sim 下单 | CH 有事件 | Sim |
| TC-T015-03 | unit | 告警阈值 | 连续 N 次超阈值 | 触发告警 | 阈值配置 |
| TC-T015-04 | integration | TTL | 插入旧数据 | 按 366 天 TTL 清理 | CH |

## 7. 可视化验证

监控面板截图、告警列表、延迟曲线。

## 8. 风险

热路径阻塞；数据膨胀。

## 9. DoD

- [x] 代码/文档已提交
- [x] 已 commit 并 push 到 origin
- [x] 测试用例全部通过
- [x] 可视化证据已归档
- [x] 任务状态更新为 DONE
- [x] 里程碑验收清单已更新

## 2026-11-08 接入补充

控制面已接入 AsyncTelemetrySink + ClickHouse，行情/订单/成交/策略指标/账户持仓快照均已写入；UI Monitoring 展示 Runtime p99、队列/背压和 ClickHouse 写入状态。证据：`docs/evidence/T-015/telemetry-integration.md`。

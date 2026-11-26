# T-003 Aeron IPC 基础设施

- 状态：DONE
- 阶段：M0
- 依赖：T-001
- 负责人：AI

## 1. 目标

建立 Java 与 C++ 通过 Aeron IPC + SBE 双向通信的基础设施与延迟基线。

## 2. 范围

### 做

- Aeron media driver 配置（aeron:ipc、独立 CnC）
- Java publisher/subscriber 封装
- C++ publisher/subscriber PoC
- stream id 分配、消息分片、背压处理
- 延迟/吞吐测试工具

### 不做

- 不做业务路由
- 不做持久化

## 3. 交付物

- shared/aeron 模块
- ctp-adapter/aeron PoC
- 配置样例
- 延迟报告

## 4. 设计要点

单 writer 单 publication；BusySpinIdleStrategy；固定 stream id；启动校验 schema/stream。

## 5. 验收标准

- [x] Java→C++、C++→Java 双向 10 万条消息无丢失
- [x] p99 延迟报告（单机）
- [x] 背压/重启可恢复
- [x] 无内存泄漏

## 6. 测试用例

| 用例 ID | 类型 | 场景 | 步骤 | 期望结果 | 测试数据 |
|---|---|---|---|---|---|
| TC-T003-01 | integration | Java→C++ echo | 发送 10 万条 SBE 消息 | 全部收到且内容一致 | 固定消息 |
| TC-T003-02 | integration | C++→Java echo | 反向发送 10 万条 | 全部收到 | 固定消息 |
| TC-T003-03 | perf | 延迟基准 | 1 万条往返，记录 p50/p99/p999 | 输出 HDR 报告 | 空载 |
| TC-T003-04 | chaos | media driver 重启 | kill media driver 后重启 | 客户端重连/明确报错 | 测试环境 |

## 7. 可视化验证

Aeron 拓扑图、延迟直方图、吞吐曲线。

## 8. 风险

C++ Aeron client 构建失败；/dev/shm 权限；CPU 绑核冲突。

## 9. DoD

- [x] 代码/文档已提交
- [x] 已 commit 并 push 到 origin
- [x] 测试用例全部通过
- [x] 可视化证据已归档
- [x] 任务状态更新为 DONE
- [x] 里程碑验收清单已更新

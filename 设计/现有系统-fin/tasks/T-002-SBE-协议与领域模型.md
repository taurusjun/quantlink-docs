# T-002 SBE 协议与领域模型

- 状态：DONE
- 阶段：M0
- 依赖：T-001
- 负责人：AI

## 1. 目标

定义期货/期权统一 SBE schema、消息版本策略与 Java/C++ 生成代码。

## 2. 范围

### 做

- Instrument（FUTURE/OPTION + 期权字段）
- MarketData、OrderRequest、OrderUpdate、Trade
- AccountSnapshot、PositionSnapshot、GatewayHealth
- SBE schema 版本与兼容规则
- Java/C++ codegen 与互操作测试

### 不做

- 不实现业务逻辑
- 不接 CTP

## 3. 交付物

- abi/sbe/*.xml
- Java/C++ 生成代码
- ABI 文档
- roundtrip 测试

## 4. 设计要点

固定字段、小端、只追加字段；消息头含 schemaId/version；期权字段可选但布局固定。

## 5. 验收标准

- [x] 所有消息 Java 编解码 roundtrip 一致
- [x] C++ 与 Java 对同一字节流解析一致
- [x] 未知字段/版本可安全拒绝
- [x] 字段 offset/size 文档化

## 6. 测试用例

| 用例 ID | 类型 | 场景 | 步骤 | 期望结果 | 测试数据 |
|---|---|---|---|---|---|
| TC-T002-01 | unit | Instrument 期货/期权 roundtrip | 编码再解码 | 字段完全一致 | au2612、au2612C600 |
| TC-T002-02 | unit | MarketData 五档盘口 roundtrip | 编码再解码 | 价格/数量/时间戳一致 | 固定 tick |
| TC-T002-03 | contract | Java/C++ 互操作 | Java 编码→C++ 解码；反向 | 字段一致 | 同一 schema |
| TC-T002-04 | unit | 版本不兼容 | 注入未知 schema version | 明确拒绝/降级策略 | 伪造 header |

## 7. 可视化验证

输出消息字段表、hexdump、Java/C++ 解码对照截图。

## 8. 风险

Schema 演进破坏兼容；期权字段遗漏；C++ 生成代码差异。

## 9. DoD

- [x] 代码/文档已提交
- [x] 已 commit 并 push 到 origin
- [x] 测试用例全部通过
- [x] 可视化证据已归档
- [x] 任务状态更新为 DONE
- [x] 里程碑验收清单已更新

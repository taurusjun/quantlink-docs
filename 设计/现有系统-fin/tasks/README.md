# 任务索引

- 每个任务一个文档，文档内包含测试用例与可视化验证
- 状态：`TODO` / `DOING` / `DONE` / `BLOCKED`
- **P0 技术验证门禁**：`docs/validation/P0-技术验证.md`（M0 完成后开始）
- 完成必须更新状态、附验证证据、更新里程碑

| ID | 任务 | 阶段 | 状态 | 文档 |
|---|---|---|---|---|
| T-001 | 仓库与工程骨架 | M0 | DONE | [T-001](T-001-仓库与工程骨架.md) |
| T-002 | SBE 协议与领域模型 | M0 | DONE | [T-002](T-002-SBE-协议与领域模型.md) |
| T-003 | Aeron IPC 基础设施 | M0 | DONE | [T-003](T-003-Aeron-IPC-基础设施.md) |
| T-004 | 配置、密钥与环境管理 | M0 | DONE | [T-004](T-004-配置、密钥与环境管理.md) |
| T-005 | Replay Gateway（期货+期权） | M1 | DONE | [T-005](T-005-Replay-Gateway（期货+期权）.md) |
| T-006 | Synthetic Option Chain | M1 | DONE | [T-006](T-006-Synthetic-Option-Chain.md) |
| T-007 | Sim Exchange（期货+期权） | M1 | DONE | [T-007](T-007-Sim-Exchange（期货+期权）.md) |
| T-008 | Runtime 核心管线 | M1/P2 | DONE | [T-008](T-008-Runtime-核心管线.md) |
| T-009 | 期权定价与组合 Greeks | P2 | DONE | [T-009](T-009-期权定价与组合-Greeks.md) |
| T-010 | OptionQuoting 策略 | P2 | DONE | [T-010](T-010-OptionQuoting-策略.md) |
| T-011 | 期货/期权对冲策略 | P2 | DONE | [T-011](T-011-期货-期权对冲策略.md) |
| T-012 | Risk 与 OMS | P2 | DONE | [T-012](T-012-Risk-与-OMS.md) |
| T-013 | Control Plane 基础 | M3 | DONE | [T-013](T-013-Control-Plane-基础.md) |
| T-014 | 指标/策略配置与一键部署 | M3 | DONE | [T-014](T-014-指标-策略配置与一键部署.md) |
| T-015 | Telemetry 与监控 | M3 | DONE | [T-015](T-015-Telemetry-与监控.md) |
| T-016 | 手工交易与审计 | M3 | DONE | [T-016](T-016-手工交易与审计.md) |
| T-017 | Web UI 基础（React/MUI） | M3 | DONE | [T-017](T-017-Web-UI-基础（React-MUI）.md) |
| T-018 | Web 交易驾驶舱/期权链/Greeks | M3 | DONE | [T-018](T-018-Web-交易驾驶舱-期权链-Greeks.md) |
| T-019 | Web 管理页（配置/部署/监控） | M3 | DONE | [T-019](T-019-Web-管理页（配置-部署-监控）.md) |
| T-020 | CTP Adapter（盛立 CTP） | M4 | DONE | [T-020](T-020-CTP-Adapter（盛立-CTP）.md) |
| T-021 | New ORS Core（期货+期权） | M4 | DONE | [T-021](T-021-New-ORS-Core（期货+期权）.md) |
| T-022 | 并行验证与对账 | M4 | BLOCKED | [T-022](T-022-并行验证与对账.md) |
| T-023 | Electron Desktop Shell | M5 | DONE | [T-023](T-023-Electron-Desktop-Shell.md) |
| T-024 | 离线缓存与更新服务器 | M5 | DONE | [T-024](T-024-离线缓存与更新服务器.md) |
| T-026 | 影子库与测试数据 | M1 | DONE | [T-026](T-026-影子库与测试数据.md) |
| T-027 | 模拟交易所（CTP Adapter 接口） | M4 | DONE | [T-027](T-027-模拟交易所（CTP-Adapter-接口）.md) |
| T-029 | 独立模拟交易所（Sim Venue） | M6 | DOING | [T-029](T-029-独立模拟交易所.md) |
| T-025 | 性能、稳定性与试点 | M6 | BLOCKED | [T-025](T-025-性能、稳定性与试点.md) |

---

## 任务文档模板

```markdown
# T-xxx 标题

- 状态：TODO
- 阶段：Mx
- 依赖：
- 负责人：AI

## 1. 目标
## 2. 范围（做/不做）
## 3. 交付物
## 4. 设计要点
## 5. 验收标准
## 6. 测试用例
## 7. 可视化验证
## 8. 风险
## 9. DoD
- [ ] 代码/文档已提交
- [ ] 已 commit 并 push 到 origin
- [ ] 测试用例全部通过
- [ ] 可视化证据已归档
```

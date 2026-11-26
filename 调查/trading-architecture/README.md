# quantlink-trading 复刻级架构档案

本目录不是 `quantlink-trading` 仓库的一部分，也不修改该仓库。它是对现有系统的独立调查档案，目标是让另一个工程 agent 只读这套资料，就能理解、复刻并改进 `quantlink-trading`。

## 调查对象

| 项 | 值 |
|---|---|
| 源码仓库 | `/Users/wangjun/PG/RD/quantlink-trading` |
| 当前 commit | `5cee3dd5b3322ec21c1958aac20ad38ba0d8ca40` |
| 分支 | `main` |
| 调查日期 | 2026-11-18 |
| 代码形态 | C++ 主运行时 + C++/Python 管理面 + Vue/前端 + PostgreSQL + 脚本/运维 |
| 部署形态 | 多进程、按策略启动 TradeBot；ORS、tbadmin、监控工具分进程 |

## 核心结论（先看这 6 条）

1. **一策略一进程**是生产模型；`main.cpp` 的多 control 循环不是受支持的多策略运行时（OptionManage 容器是例外）。
2. **ORS 是 CTP/SHM/RMS 网关**；交易决策、策略仓位/PnL 在 TradeBot；管理面不是交易真相。
3. **策略账本与账户净额是两套真相**；所有策略默认 `ACCOUNT=OWN`，没有账户级对冲器，也没有自动对账。
4. **风控分两层**：ORS/RMS 静态额度 + TradeBot 策略内 kill switch；都不检查可用资金/保证金/可平量/时段。
5. **单机、无 systemd、无 HA、无异地备份/PITR、管理面无认证**；复刻前必须先补底座。
6. **文件是策略启动真相**：control/model/`daily_init`/fee/contract；DB 是策略注册/手工单，不是运行时仓位。

> 详细论证见 `01-system-architecture.md`；风险与改进见 `08-security-gaps.md` 和 `09-replication-playbook.md`。

## 这套资料怎么读

建议顺序：

1. `00-source-map.md`：仓库地图、模块、构建、依赖、版本。
2. `01-system-architecture.md`：系统边界、进程拓扑、端到端数据流、所有权。
3. `02-runtime-strategy.md`：`tbsrc` 启动、策略层、订单/成交/仓位、PnL、squareoff。
4. `03-ors-connectors.md`：ORS、CTP/Connector、session、订单路由、模拟/回放。
5. `04-admin-control-plane.md`：`tbadmin`、`tbadmin-py`、Vue、DB 管理面。
6. `05-data-model.md`：`tbhft_*` 表、配置/状态/审计数据、数据保留。
7. `06-build-deploy-ops.md`：Make/CMake、打包、systemd/cron、环境、启停、升级/回滚。
8. `07-operations-runbook.md`：监控、日志、告警、日常运维、故障处理、备份恢复。
9. `08-security-gaps.md`：安全模型、故障模式、已知缺口、改进建议。
10. `09-replication-playbook.md`：从零复刻的执行顺序、验收门禁、扩展点。

## 证据约定

- **V** = 直接读代码/配置/脚本确认，附文件与行号或命令。
- **I** = 由代码结构、脚本、部署文件推断，未在运行环境验证。
- **P** = 计划/文档描述，当前代码未完全实现；必须在文中标出，不能当成事实。
- 运行结果、主机状态、数据库内容如果没有现场证据，一律标 **I** 或 **未验证**。
- 不记录明文密钥、token、密码。只记录密钥文件位置、权限、加载方式和轮换流程。

## 文档地图

| 文件 | 内容 |
|---|---|
| `00-source-map.md` | 仓库目录、模块、入口、构建系统、外部依赖、代码规模 |
| `01-system-architecture.md` | 进程/主机拓扑、组件职责、端到端链路、热路径边界 |
| `02-runtime-strategy.md` | TradeBot 生命周期、策略工厂、回调、订单/成交/仓位/PnL、风控、squareoff |
| `03-ors-connectors.md` | ORS、CTP/Connector、柜台 session、请求/响应、模拟盘/回放 |
| `04-admin-control-plane.md` | tbadmin C++/Python、admin 协议、Vue、策略同步 |
| `05-data-model.md` | PostgreSQL schema、关键表、状态机、数据流、保留/备份 |
| `06-build-deploy-ops.md` | 构建、发布、主机、systemd、cron、环境变量、启停、升级/回滚 |
| `07-operations-runbook.md` | 监控、日志、告警、日常检查、故障处置、备份/PITR |
| `08-security-gaps.md` | 信任边界、认证、密钥、网络暴露、审计、风险与改进 |
| `09-replication-playbook.md` | 复刻步骤、最小可运行集、验收用例、演进路线 |
| `appendix/service-matrix.md` | 进程/端口/SHM/日志/启停/事实源矩阵 |
| `appendix/glossary.md` | 本系统术语表 |
| `appendix/open-questions.md` | 需现场/外部确认的未决问题清单 |

## 重要边界

- **范围排除**：`web-go` / Go Dashboard 不在本次调查范围。文档只在部署/运维确实依赖其二进制/端口时作为外部黑盒提及，不分析其内部实现。
- `quantlink-trading` 是 **旧 C++ 体系**；`quantlink-fin` 是另一个新系统。不要把两者的架构混写。
- 本档案以当前 commit 的代码为准；仓库里的 `docs/` 设计文档只能作为线索，结论必须回到代码/配置/脚本。
- `quantlink-trading` 的“生产部署”不等于仓库默认值：主机、账号、柜台、数据库地址以 `ops/`、`scripts/`、`deploy` 类文件和现场配置为准。
- 任何“应该”“计划”“未来”都必须显式标注 **P**，不能写成已实现。

## 维护规则

- 新增结论必须附证据（文件:行号、命令、配置键）。
- 发现代码与旧文档冲突时，以代码为准，并在文中记录冲突。
- 不把推测写成事实；无法验证的部署细节放到“未验证/待确认”。
- 变更本目录不需要改 `quantlink-trading`；不要把本目录变成父级 git 仓库。

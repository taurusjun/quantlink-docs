# 09 — 复刻与改进 Playbook

> 目标：让另一个工程 agent 从这套资料出发，能够复刻 `quantlink-trading` 的最小可运行系统，并明确哪些部分应该重做而不是照抄。
> 证据约定：**V** = 代码/配置/脚本确认；**I** = 推断；**P** = 建议/计划。
> 先读 `01-system-architecture.md` 和 `00-source-map.md`；细节按需要跳到 02–08。

## 1. 先选复刻目标

不要一开始就“复刻整个平台”。先选一个目标：

| 目标 | 范围 | 适用 | 不建议 |
|---|---|---|---|
| **A. 研究/回放栈** | 历史行情 + 指标 + 策略逻辑，不接 CTP | 验证策略/指标 | 用它证明实盘执行正确 |
| **B. 单策略实盘** | 1 个 CTP 账户 + 1 个 ORS + 1 个 TradeBot + 1 个策略 | 最小生产 | 直接扩成多策略 |
| **C. 多策略平台** | 多策略、多账户、控制面、对账、风控 | 长期 | 复用现有 `main.cpp` 多策略循环 |
| **D. 只复刻管理面/监控** | tbadmin/DB/前端 | 替换旧管理面 | 把它当交易真相 |

本 playbook 默认 **B（单策略实盘）**，然后给出 C 的改造清单。

## 2. 复刻前置决策（必须先定）

1. **策略进程模型**：一策略一进程（推荐，贴近现有生产）还是单进程多策略（需要重做 ID/路由/OptionManager）？
2. **账户模型**：一个账户一个 ORS，还是多账户？是否允许同账户同合约多策略（隐式净额/对冲）？
3. **持仓真相**：策略账本 vs 账户净额，谁对账谁？不一致时 fail closed 还是人工处理？
4. **风控边界**：策略内 pre-trade gate、ORS/RMS 静态限额、账户级敞口 gate，分别负责什么？
5. **状态存储**：文件、PostgreSQL、SHM 各自存什么？哪些状态必须跨重启恢复？
6. **停止/平仓**：谁负责 flatten？是否允许 `kill -9`？收盘后如何确认空仓？
7. **管理面安全**：管理面是否暴露在网络？是否需要认证/审计？是否允许远程命令？
8. **部署底座**：是否继续 cron+shell，还是 systemd/容器/编排？是否要 HA/备份/PITR？

> 这些决策不先定，复刻会变成“把旧系统的坑重新踩一遍”。

## 3. 分阶段复刻顺序

### Phase 0 — 冻结契约与数据字典

产出：

- SHM key/结构体/队列大小表（`03` §3）。
- control/model/config 文件格式（`02` §1.4/§8.2）。
- `daily_init`/`position.csv`/`fee.csv`/`contractfile` 格式（`05` §5）。
- DB 表/字段/写入方（`05` §2–§4）。
- 进程/端口/日志/启停矩阵（`appendix/service-matrix.md`）。

验收：另一个 agent 只看这些表，能画出进程图和字段流。

### Phase 1 — 外部依赖与数据

1. 安装 CTP SDK（Linux 6.7.11 头文件 + `.so`），确认 `ors/third_party/ctp/linux`。
2. 准备 PostgreSQL `dbtrade`（或最小 schema；见 `05` §8）。
3. 准备 `data_cpp` 等价目录：`config/controls/models/live/data`。
4. 准备 `contractfile`、`fee.csv`、`trading_days.txt`、`session_rules.csv`、`daily_init.<sid>`。
5. 确认硬编码路径 `/home/hft/tbdata/*` 的软链/替代方案（`02` §0）。

验收：`fee.csv`/`contractfile` 能被启动读取；缺失时明确 fail closed，不静默用 0。

### Phase 2 — ORS / CTP / SHM

1. 构建 `ors_server`（CMake，C++17，CTP SDK）。
2. 实现/复用 SHM 队列（4097/8193/12289/16385），保证结构体大小和槽数一致。
3. 实现 CTP 登录、行情回调、报单/撤单、回报/成交、查询持仓。
4. 实现 RMS 静态检查（或明确不做，但必须在策略层补 pre-trade gate）。
5. 实现安全重启：先停策略、撤单、等回报、再停 ORS；禁止双登录。

验收：

- ORS 登录成功，行情进入 SHM。
- 手工/测试请求能到 CTP（sim/仿真）。
- 回报能回到请求方。
- ORS 重启后旧单上下文丢失的行为被显式处理（撤单/对账/告警），不是静默。

### Phase 3 — TradeBot 单策略运行时

1. 实现 Connector：轮询 SHM、解析行情/回报。
2. 实现 `CommonClient`：指标更新 → 目标价 → 策略回调；订单回报 → 订单表/PnL/仓位。
3. 实现 `ExecutionStrategy` 的最小契约：订单表、发单/撤单、成交处理、净仓、PnL、信号/激活、squareoff。
4. 实现一个具体策略（建议先 `TargetStrategy` 或 `PairwiseArbStrategy` 的最小版本）。
5. 实现 control/model/`daily_init` 加载和策略 ID（每个进程必须显式 `--strategyID`）。
6. 实现停止语义：`SIGTSTP`/显式 flatten、等待成交、确认空仓；不要依赖 `SIGTERM`/`kill -9`。

验收：

- Live 启动后 `inactive`，显式激活后才发单。
- 下单、撤单、成交、PnL、净仓与预期一致。
- 重复价格/重复订单被拒绝。
- 重启后策略仓位按 `daily_init`/position 恢复；没有恢复源的策略明确 fail closed。

### Phase 4 — 策略层扩展

1. 用**一个具体工厂类 + switch/注册表**替代 47 个 `strcmp` 分支（`02` §2.3；`08` P1）。
2. 每个策略配置/参数独立，不塞进共享 `ThresholdSet`。
3. 复合策略（pair/butterfly）用显式 leg 对象/上下文，不靠全局 `m_simConfig`。
4. 如果要做单进程多策略：per-strategy ID、per-strategy order map、per-strategy OptionManager/portfolio context、per-strategy PnL/position；否则不要做。
5. 为每个策略定义：

   - 输入：行情/指标/参数/仓位/风控限额。
   - 输出：订单意图/撤单意图/健康状态。
   - 不变量：同一时间一个 open order（或明确允许多个）。
   - 失败模式：数据陈旧、下单拒绝、状态写失败、停止超时。

验收：新增一个策略只改“配置 + 策略实现 + 工厂注册”，不改 ORS/管理面/路由。

### Phase 5 — 管理面与 DB（可选但推荐）

1. 最小管理面：策略列表/状态、订单/成交、持仓/PnL、启停/激活、配置查看。
2. `tbhft_strategy` 最小 schema + 同步工具；不要照抄 `ref` 类型冲突/覆盖 `active` 的坑（`05` §6）。
3. 管理面必须只读/转发，不计算交易真相（`04` §3）。
4. 管理面加认证/授权/审计；禁止无认证 ZMQ/HTTP 命令通道（`08` P0）。
5. 手工单/撤单要写审计；不要用前端内存当订单真相。

验收：TradeBot/ORS 停掉时管理面不伪造“运行中”；数据陈旧有明确标识；命令有审计。

### Phase 6 — 部署与运维底座

1. 用 systemd/容器/编排替代 cron+shell（至少给交易进程加 `Restart=`/健康检查）。
2. 构建产物版本化：`/opt/quantlink/releases/<version>` + `current` 软链；支持回滚。
3. 配置/密钥分离：代码库不含明文；用 secret store/环境变量/限权文件。
4. 日志轮转/保留/异地；磁盘水位告警。
5. DB：`pg_dump` + WAL 归档/PITR + 异地副本；明确 RPO/RTO。
6. 监控：进程、行情活性、订单流、持仓对账、DB、磁盘、日志新鲜度；告警可达。
7. 收盘/故障 flatten 流程：确认空仓、写 `daily_init`、对账、审计。
8. 安全：管理面认证、ZMQ/HTTP 绑定回环、最小权限、CTP/DB 凭据轮换。

验收：按 `07` 的 runbook 做一次开盘/收盘/故障演练；按 `08` 的 P0 清单过一遍。

## 4. 复刻验收门禁

### 4.1 构建与启动

- [ ] ORS/TradeBot/tbadmin 在目标 Linux 上可重复构建。
- [ ] CTP SDK 版本、`rpath`、`LD_LIBRARY_PATH` 正确。
- [ ] 数据文件/软链/权限齐全；缺失时启动失败而不是静默 0。
- [ ] 每个 TradeBot 显式 `--strategyID`，ID 唯一。
- [ ] ORS/TradeBot 使用同一套 SHM 结构体/槽数；有二进制契约测试。

### 4.2 交易正确性

- [ ] 行情 → 指标 → 策略 → 订单链路在 sim/仿真柜台跑通。
- [ ] 下单/撤单/拒绝/部分成交/全成交状态正确。
- [ ] 订单表价格主键、重复价格拒绝行为符合预期。
- [ ] 策略净仓/PnL 与成交流水一致。
- [ ] 账户净额与策略净仓的差异有对账/告警，不静默。
- [ ] 停止/flatten 后账户空仓；有确认步骤。
- [ ] 重启恢复：`daily_init`/position/open order 的行为明确；无恢复源 fail closed。

### 4.3 风控与安全

- [ ] 策略内 pre-trade gate：仓位、单笔数量/名义、未成交订单数、价格带、行情/会话新鲜度。
- [ ] 账户级敞口 gate：按账户汇总策略仓位 + 在途单。
- [ ] RMS/ORS 静态限额与策略 gate 不重复、不互相绕过。
- [ ] 管理面认证/授权/审计；ZMQ/HTTP 不暴露公网。
- [ ] 凭据不在 git/日志；轮换流程可用。
- [ ] SHM 权限最小化；请求 SHM 写入方受控。

### 4.4 运维与恢复

- [ ] 进程/端口/日志/DB/磁盘/行情活性监控可用。
- [ ] 告警可达（至少一个非本机通道）。
- [ ] `pg_dump`/PITR/异地备份演练通过。
- [ ] 坏盘/换机恢复演练：从 git + 数据文件 + DB 备份重建最小交易集。
- [ ] 收盘/故障后对账：账户/策略/DB/文件一致。

## 5. 明确不要照抄的东西

| 不要照抄 | 原因 | 替代 |
|---|---|---|
| 无认证 ZMQ/HTTP 管理面 | 可远程下单/执行 shell/SQL | 认证 + 授权 + 审计 + 回环绑定 |
| `popen()` 执行外部输入 | 命令注入 | 白名单命令/参数化 API |
| 明文 CTP/DB 凭据进日志 | 凭据泄露 | 脱敏日志 + secret store |
| SHM 0666 | 本机任意进程可读/写订单 | 最小权限/ACL |
| `SIGTERM`/`stop_all` 当平仓 | 可能留仓/硬杀 | 显式 flatten + 确认空仓 |
| `MAX_POS_SIZE` 当持仓上限 | 实际是累计成交限额 | 明确的 position limit |
| 47 分支 `strcmp` 工厂 | 每个策略改 main.cpp | 单工厂 + 注册表/switch |
| 全局 `m_simConfig` 路由 | 多策略串单 | per-strategy context/order map |
| 无备份/PITR 单机 | 磁盘坏 = 全丢 | 版本化发布 + 备份/异地 |
| 用账户净仓 seed 策略 | 无法拆回策略 | 策略账本 + 对账 |
| 只靠 ORS RMS 做风控 | 不看资金/保证金/可平量/时段 | 策略/账户 pre-trade gate |

## 6. 改进路线图

### P0 — 复刻/上线前必须

1. 管理面认证/授权/审计；ZMQ/HTTP 不暴露公网；移除 `popen()` 外部输入。
2. 凭据移出 git/日志；轮换 CTP/DB/SSH/webhook。
3. 可靠的 flatten/closeout：显式工具，确认空仓，写 `daily_init`。
4. SHM 权限/来源校验；请求 SHM 写入方白名单。
5. 持仓对账：策略净仓 + 账户净额 + `position.csv`/`daily_init`，差异告警/fail closed。
6. 数据库备份/PITR/异地；发布产物版本化/可回滚。
7. pre-trade 风控：资金/保证金/可平量/价格带/时段，不只依赖 RMS。

### P1 — 两周到一个月

1. systemd/编排替代 cron+shell；进程级 watchdog/自动重启。
2. 策略工厂/注册表；去掉 `main.cpp` 47 分支。
3. 单进程多策略（如果确有必要）：per-strategy ID/路由/OptionManager/PnL。
4. 管理面数据链修复：订单/成交/仓位/策略状态不丢消息、不陈旧。
5. 日志结构化/脱敏/保留策略；磁盘水位告警。
6. 交易时段/夜盘/节假日的单一真值源。

### P2 — 架构演进

1. 事件驱动/持久化状态机；订单/成交/仓位可恢复。
2. 账户级组合风控/对冲（如果业务需要）。
3. 多账户/多 ORS/HA；控制面与交易面分离。
4. 审计/合规：不可篡改事件日志、双人复核、回放。

## 7. 未决问题（复刻前必须现场确认）

汇总自各文档，按重要性：

1. `ors_server.cfg` 现场实际值（`MAX_CLIENTS`/`REQUEST_SHMSIZE`/`POSITION_FILE`/SHM 线程/亲和）。
2. `ipcs -m` 实际 SHM 段大小是否与推算一致（MD 4096 槽）。
3. `STARTUP_GUIDE.md` 的 `MD_LEN_LIST=4096` 与 `md-recorder.yaml` 矛盾，需现场定论。
4. `tbadmin/lib` 的 `libyd/libmemlog/libpqhelper` 来源/版本/ABI。
5. `check-md`/`md-recorder` 现场二进制构建来源（仓库没有构建入口）。
6. 190 的 `deploy_cpp`/crontab 是否与本 commit/`ops/crontab.txt` 一致。
7. 生产 CTP 前置/`PRODUCTION_MODE`/双登录窗口。
8. `daily_init` 是否有未入库的自动修正器；当前代码只读，不自动修正。
9. `92204` 开盘后由谁激活；`92221` 实际跑 IF 还是 TA（两个 control 并存）。
10. `signal.txt` 是否存在；`stop_all` 的 SIGTERM 是否真的平仓。
11. DB 真实 DDL/索引/权限/`pg_hba`/PITR 状态；`ref` 列类型。
12. 管理面/端口/防火墙：9980/9981/8882/5004/8080/8081/50003 的实际暴露与认证。
13. `tbhft_strategy` 的 RDS 来源/冲突处理/`active/core/corebind/path` 覆盖是否符合预期。
14. `ops/db.conf` 的 `WECHAT_WEBHOOK`/`MEMLOG_READER_CONFIG` 现场值（不要打印值）。
15. 生产实际启用策略集合（6 个 sid?）与停用清单。

## 8. 复刻完成后的最小交付物

- 版本化源码 + 可重复构建脚本。
- 配置模板 + 密钥注入说明（不含明文）。
- 数据文件/DB schema/seed 脚本。
- 启动/停止/激活/flatten/对账 runbook。
- 监控/告警/日志/备份/PITR。
- 测试：构建、SHM 契约、交易状态机、重启、停止、对账、安全。
- 架构决策记录（ADR）：进程模型、账户模型、持仓真相、风控边界、状态存储、部署底座。

---

配套附录：

- `appendix/service-matrix.md`：进程/端口/SHM/日志/启停矩阵。
- `appendix/glossary.md`：术语表。
- `appendix/open-questions.md`：按主题汇总的未决问题。

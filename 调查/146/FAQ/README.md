# FAQ — 146 原始 TradeBot / Qt 前端问答

本目录只放本次调查中与 `/Volumes/DevDisk/146` 直接相关的问答，每个问题一个文件；后续问答也按同一规则追加并更新本索引。  
详细证据和完整分析见上级目录的 `00`–`07` 文档。

| 文件 | 问题 |
|---|---|
| `001-architecture-diagram.md` | 146 能否给一个大致的架构图？ |
| `002-gui-controls-strategy-trades.md` | GUI 是怎么控制策略成交的？ |
| `003-gui-functions-data-source-enableflag.md` | GUI 的功能、数据来源、是否集中管理、enableFlag 前后行为、交易员视角 |
| `004-why-dataservice-and-zmq.md` | 为什么数据源要分成 DataService 和 ZMQ？ |
| `005-enableflag-command-path.md` | enableFlag 是交易员通过 GUI 下达、经 ZMQ 到具体策略吗？ |
| `006-strategy-order-data-to-dataservice.md` | 策略触发下单后，数据怎么到 DataService？ |
| `007-dataservice-deployment-with-ors.md` | DataService 读 SHM，是否部署在 ORS 一起？ |
| `008-gui-cross-host.md` | GUI 只能单机吗？能否跨机收集信息？ |
| `009-account-isolated-new-system-structure.md` | 按照账户隔离，新系统的大致结构 |
| `010-accounthost-responsibilities.md` | AccountHost 具体干什么？ |
| `012-accounthost-design-and-146-comparison.md` | AccountHost 自上而下设计，以及与 146 的对比 |
| `013-indicator-strategy-system-design.md` | 指标-策略体系设计（指标快照 / StrategyDecision / ExecutionPlanner） |
| `014-optionmanager-design.md` | OptionManager 新系统设计：进程、指标-策略、AccountHost 路由、风险及 146 逐组件对照 |
| `015-accounttradingengine-design.md` | AccountTradingEngine 设计：分层、组件、ADT、状态机与调用关系（旧模型） |
| `016-venue-contract-stream-design.md` | Venue Contract 通道设计：五通道模型、序列与 AccessClient 边界（旧模型） |
| `201-tb-ipc-model.md` | TB IPC 整体模型：TB 只看到 TradingChannel / MarketDataChannel；ORS/账户快照在边界外 |
| `202-trading-channel-and-routing.md` | TradingChannel、MarketDataChannel、ContractRoute、订单/回报/行情路由与故障恢复 |
| `203-configuration.md` | 配置模型：TB 只写 IPC 通道；ORS 配置独立；校验规则 |
| `204-strategy-runtime-and-optionmanager.md` | 多策略运行时隔离、OptionManager 归属、策略生命周期 |
| `205-gui-data-and-control-plane.md` | GUI 数据/控制面：Facts、ReadModels、BotGateway、策略控制、手工单 |
| `206-contract-catalog.md` | 合约与期权目录：ContractKey、ContractCatalog、OptionCatalog、OptionLeg、读模型 join |
| `207-tbadmin-ui-fields-vs-146.md` | tbadmin UI 字段与 146 差异；PyBot 字段单独归类；补齐逻辑与 205 对齐 |
| `208-pythonbot-analysis.md` | PythonBot 运行架构、tVar/tCache 闭环、风险与迁移建议 |

> 说明：009 起包含按用户要求追加的新系统结构问答和设计文档；更早关于 `quantlink-trading` / `quantlink-fin` / FastTrade 设计的问题不属于 146，未放入本目录。
>
> `207`–`208` 是 146 对照分析和外部运行时分析，不是 `quantlink-trading` 的仓库设计文档。
>
> `201`–`206` 是当前设计模型；`207`–`208` 是对照/分析；`009`–`013`、`015`、`016` 是早期设计，术语与当前模型不一致时，以 `201`–`206` 为准。`014` 的 OptionManager 命名已按当前模型统一为 `strategyId`。

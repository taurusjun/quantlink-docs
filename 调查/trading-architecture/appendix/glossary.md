# 附录 B — 术语表

> 只解释本档案/本系统里的含义，不是通用金融词典。标 * 的词在代码里有特定实现。

| 术语 | 含义 | 备注 |
|---|---|---|
| **ORS** | Order Routing Service，`ors_server` | CTP 行情/交易接入 + SHM + RMS；不做仓位管理/PnL |
| **RMS** | Risk Management System，前置风控 | 静态额度/频率检查；不检查资金/保证金/可平量/时段 |
| **TradeBot** | C++ 策略进程 | 生产一策略一进程；`tbsrc/main/main.cpp` |
| **tbadmin** | C++ 管理面，双角色 | `agent` 读 SHM；`admin` 聚合/前端/DB |
| **agent/admin** | tbadmin 的两种模式 | 进程名 `AgentLoop`/`AdminLoop` |
| **SHM** | System V shared memory | 本系统跨进程总线；key 4097/8193/12289/16385/789 |
| **memlog** | 策略状态/PnL/订单事件共享内存 | TradeBot → tbadmin agent；key 789 |
| **Response SHM** | 订单/成交回报队列 | ORS → TradeBot；key 12289 |
| **Request SHM** | 订单/撤单请求队列 | TradeBot → ORS；key 8193 |
| **MD SHM** | 行情队列 | ORS → TradeBot；key 4097 |
| **control 文件** | 策略控制文件 | 7/8/9 个空格分隔字段：合约、模型、交易所、ID、策略类型、起止、第二腿... |
| **model 文件** | 策略参数/阈值文件 | `ThresholdSet` 等；按策略加载 |
| **daily_init.\<sid\>** | 策略日初持仓/状态文件 | pair 系启动读取；不是实时流 |
| **position.csv** | ORS 账户持仓时点快照 | 启动/查询/正常关停时写；不是实时流 |
| **fee.csv** | 合约费率表 | TradeBot 启动读取；缺失/不匹配可 `exit(1)` |
| **contractfile** | 合约规格表 | 合约乘数/最小变动/到期等 |
| **session_rules.csv** | 品种交易时段规则 | cron/策略窗口的输入 |
| **trading_days.txt** | 交易日历 | 会话门控 |
| **tbhft_strategy** | 策略注册表 | 生产全量镜像；TradeBot 不直接读 |
| **tbhft_man_order** | 手工单表 | 审计/手工交易；不完整 |
| **tbhft_product** | 产品 ↔ SHM key 映射 | 管理面/部署 |
| **tbtrade_sections** | 交易时段表 | 新 schema |
| **tbinstrument_info** | 合约元数据 | 到期/乘数等 |
| **strategy_sync** | RDS→本地策略表同步工具 | 10:30/20:30；有 diff/备份/冲突处理 |
| **m_netpos** | 策略自己的净仓 | 由本策略成交累计；不等于账户净仓 |
| **账户净额** | CTP/ORS 账户级净持仓 | 交易所只认这个；所有策略共享 `ACCOUNT=OWN` 时会隐式净额 |
| **策略账本** | TradeBot 本地仓位/PnL | 与账户净额不自动对账 |
| **open order** | 未终态订单 | TradeBot 内存 + ORS 内存；DB 没有完整表 |
| **clientOrderId / OrderID / OrderRef** | 三套订单标识 | TradeBot/ORS/CTP 各自使用；复刻必须对齐 |
| **m_ordMap** | TradeBot 订单表（按 OrderID） | 订单状态/PnL |
| **m_bidMap / m_askMap** | TradeBot 买/卖订单表（价格为主键） | 同价不能重复挂单 |
| **squareoff** | 平仓/收尾 | `tbstop`/信号/收盘；不保证一定平光 |
| **flatten** | 强制平掉账户/策略仓位 | 本档案建议单独实现，不依赖 `SIGTERM` |
| **pair / leg** | 配对套利策略/腿 | `PairwiseArbStrategy`/`ExtraStrategy` 等 |
| **leg 1 / leg 2** | 配对的两条腿 | 策略只由腿 1 驱动的情况存在 |
| **OptionManager** | 进程级期权组合上下文 | 单例；多期权策略共享会串 |
| **ConfigParams** | 进程级全局配置单例 | 包含策略数/模式/全局参数 |
| **ThresholdSet** | 策略阈值集合 | `MAX_LOSS`/`STOP_LOSS`/`MAX_ORDERS` 等 |
| **MAX_POS_SIZE** | *实际是累计成交手数上限* | 不是持仓上限；易误读 |
| **m_maxTradedQty** | 累计成交上限 | 由 `MAX_POS_SIZE` 算出 |
| **m_tholdMaxPos / MAX_SIZE** | 策略持仓上限 | 来自 model/策略参数 |
| **ACTIVE / INACTIVE** | 策略是否可发单 | Live 启动默认 inactive；需激活 |
| **tbstart/tbstop** | 策略信号包装 | SIGUSR1/SIGTSTP 等 |
| **kill -9** | 硬杀 | `stop_all` 最终手段；可能留仓 |
| **systemd** | 系统服务管理 | 本系统交易进程**没有** systemd 单元 |
| **cron + shell** | 本系统实际编排 | `ops/crontab.txt` + `ops_*`/`start_all` |
| **deploy_cpp** | 构建产物/运行时目录 | `bin` 是 cwd；`data` 是 `../data` |
| **data_cpp** | 配置/数据事实源 | `bin/{config,controls,models,live}` + `data` |
| **/home/hft/tbdata** | TradeBot 硬编码数据路径 | 软链到 `data_cpp/data`；缺失即 exit |
| **CTP** | 上期技术柜台 API | 行情/交易；SimNow/SimShengli 等 |
| **OrderRef** | CTP 订单引用 | ORS 生成/映射 |
| **平今/平昨/开仓** | 期货开平方向 | ORS 按账户持仓镜像决定；不自动拆单 |
| **V / I / P** | 本档案证据标记 | V=代码确认；I=推断；P=计划/未实现 |

# PAIR 业务测试用例

## 1. 目的

覆盖 PAIR 价差策略从配置、报价、成交、对冲、平仓、风控、夜盘、异常到数据对账的完整业务链路。

本文件只定义**业务用例**，不绑定具体测试框架。

参考实现：

```text
tbsrc/Strategies/PairwiseArbOptStrategy.cpp
tbsrc/Strategies/PairwiseArbETFStrategy.cpp
tbsrc/Strategies/PairwiseArbStrategyCffex.cpp
```

平台扩展：

```text
exitSpread：平台新增的价差盈利平仓阈值
closeout：按日盘/夜盘时段收盘前停止/强平
```

## 2. 测试环境基线

```text
账户：SIMVENUE-001          （2026-11-11：SimLocal 已退役，基线迁移到 SimVenue）
ORS：ors-simvenue-001
Agent：agent-simvenue-01
策略：PAIR-SIMVENUE-001
腿1：ag2612
腿2：ag2706
tick：1
手数：1
乘数：15
Aeron：order 3140 / cancel 3141 / update 3142 / trade 3143 / md 1001
```

基线配置：

```text
priceRatio         1
BEGIN_PLACE        5
LONG_PLACE         8
SHORT_PLACE        2
BEGIN_REMOVE       3
LONG_REMOVE        5
SHORT_REMOVE       1
SIZE               1
BID_SIZE           1
ASK_SIZE           1
MAX_SIZE           5
BID_MAX_SIZE       5
ASK_MAX_SIZE       5
MAX_QUOTE_LEVEL    1
SUPPORTING_ORDERS  1
SLOP_TICKS         0.5
HEDGE_SIZE_RATIO   1
HEDGE_THRES        0.5
AVG_SPREAD_AWAY    100
exitSpread         2
closeoutBeforeEnd  3 分钟
aggressiveBeforeEnd 1 分钟
```

**注意：**

```text
avg / exit / shock 使用 mid spread；
entry / remove 使用交叉价差 longSpread / shortSpread。
```

ag 日盘不是连续 09:00-15:00：

```text
09:00-10:15
10:30-11:30
13:30-15:00
```

当前 `instrument_trading_sessions` 只有一段 DAY + 一段 NIGHT，
无法表达 10:15-10:30 和 11:30-13:30 断点；这是已知模型缺口。

SHFE 夜盘也不是全部 02:30：

```text
ag / au              02:30
cu / al / zn / pb / ni / sn  01:00
rb / hc / ru / bu    23:00
```

基线市场：

```text
avgSpread = 50
腿1 bid/ask = 100 / 102
腿2 bid/ask = 50 / 52
longSpread  = leg1.ask - priceRatio * leg2.bid = 52
shortSpread = leg1.bid - priceRatio * leg2.ask = 48
```

注意：trading 原始 PAIR 使用**交叉价差**，不是中间价。

## 3. 用例分级

```text
P0：交易正确性/资金安全，必须通过
P1：主要业务路径，必须通过
P2：边界/体验/可恢复性
```

## 4. 用例清单

### A. 配置与初始化

| ID | 优先级 | 场景 | 步骤 | 期望 |
|---|---|---|---|---|
| PAIR-CFG-001 | P0 | PAIR 配置加载 | 保存 leg1/leg2、priceRatio、tick、BEGIN/LONG/SHORT、REMOVE、SIZE、HEDGE 参数，重启 runner | runner 加载到全部字段；日志中 leg1/leg2、avg、sessions 正确 |
| PAIR-CFG-002 | P0 | 初始 avg 来自 daily state | `strategy_daily_state.avg_px=50`，启动 runner | 首笔报价使用 avg=50，不用首 tick 重新初始化 |
| PAIR-CFG-003 | P1 | 无 daily state 时首 tick 初始化 | 清空 avg，首 tick spread=50 | avg 初始化为 50，不立即发单 |
| PAIR-CFG-004 | P0 | 非法配置 | leg1=leg2、tick<=0、priceRatio<=0 | 保存被拒绝，返回明确错误 |
| PAIR-CFG-005 | P1 | 日盘/夜盘时段加载 | 配置 DAY 09:00-15:00、NIGHT 21:00-02:30 | runtime 返回两段 session；收盘时间按各自时段计算 |

### B. 腿1被动报价

| ID | 优先级 | 场景 | 市场/仓位 | 期望 |
|---|---|---|---|---|
| PAIR-ENTRY-001 | P0 | 零仓位做多价差 | avg=50，longSpread=44（<50-5），净仓 0 | 腿1 BUY OPEN，价格=腿1 bid，qty=SIZE |
| PAIR-ENTRY-002 | P0 | 零仓位做空价差 | avg=50，shortSpread=56（>50+5），净仓 0 | 腿1 SELL OPEN，价格=腿1 ask，qty=SIZE |
| PAIR-ENTRY-003 | P0 | 价差在区间内 | longSpread=48，shortSpread=52 | 不发单 |
| PAIR-ENTRY-004 | P1 | 多仓 50% 仓位偏置 | leg1 净多 2，max=5；LONG_PLACE=8，BEGIN=5 | bidPlace=5+(8-5)*2/5=6.2；askPlace=5-(5-2)*2/5=3.8 |
| PAIR-ENTRY-005 | P1 | 空仓 50% 仓位偏置 | leg1 净空 2，max=5 | bidPlace=5+(5-2)*(-2)/5=3.8；askPlace=5-(8-5)*(-2)/5=6.2 |
| PAIR-ENTRY-006 | P0 | 买侧仓位上限 | BID_MAX_SIZE=5，已有 5 手多 | 不再发腿1 BUY |
| PAIR-ENTRY-007 | P0 | 卖侧仓位上限 | ASK_MAX_SIZE=5，已有 5 手空 | 不再发腿1 SELL |
| PAIR-ENTRY-008 | P1 | MAX_SIZE 截断 | SIZE=5，MAX_SIZE=2 | 实际下单 qty=2 |
| PAIR-ENTRY-009 | P1 | 撤买阈值 | 已有腿1 BUY，longSpread 回到 avg-BEGIN_REMOVE 以上 | 撤销腿1 BUY |
| PAIR-ENTRY-010 | P1 | 撤卖阈值 | 已有腿1 SELL，shortSpread 回到 avg+BEGIN_REMOVE 以下 | 撤销腿1 SELL |
| PAIR-ENTRY-011 | P2 | 多仓撤单偏置 | 净多 2，LONG_REMOVE=5，BEGIN_REMOVE=3 | bidRemove=3+(5-3)*2/5=3.8 |
| PAIR-ENTRY-012 | P1 | 最小 tick 对齐 | 腿1 tick=1，计算价为 100.5 | BUY→101，SELL→100，按方向取整 |
| PAIR-ENTRY-013 | P2 | SUPPORTING_ORDERS | 单边已有 1 笔挂单，SUPPORTING_ORDERS=1 | 不再新增第二笔同向挂单 |
| PAIR-ENTRY-014 | P2 | MAX_QUOTE_LEVEL | 配置 3 档，盘口 3 档 | 按配置档位报价；未实现时标记 SKIP |

### C. 腿2对冲

| ID | 优先级 | 场景 | 持仓/市场 | 期望 |
|---|---|---|---|---|
| PAIR-HEDGE-001 | P0 | 腿1多头成交后对冲 | leg1 多 1，leg2 0，腿2 bid/ask=50/52 | 腿2 SELL OPEN，价格=50-0.5=49.5→49，FAK，qty=1 |
| PAIR-HEDGE-002 | P0 | 腿1空头成交后对冲 | leg1 空 1，leg2 0 | 腿2 BUY OPEN，价格=52+0.5=52.5→53，FAK，qty=1 |
| PAIR-HEDGE-003 | P1 | HEDGE_SIZE_RATIO 语义 | leg1 多 2，ratio=0.5，HEDGE_THRES=0.5 | 参考公式 dr=2/0.5=4，应发 4 手对冲；不是 1 手 |
| PAIR-HEDGE-003A | P1 | ratio=2，leg1 多 1 | dr=0.5；HEDGE_THRES=0.5 时按严格 `>` 不应发；按平台 `>=` 会发 1 手，需明确采用哪种 |
| PAIR-HEDGE-003B | P1 | ratio=0.5，leg1 多 2 | 应发 4 手 |
| PAIR-HEDGE-003C | P1 | ratio=0.5，leg1 多 1 | 应发 2 手 |
| PAIR-HEDGE-003D | P1 | ratio=0.5，leg1 空 2 | 应对称发 4 手 BUY |
| PAIR-HEDGE-004 | P1 | HEDGE_THRES 未触发 | 用 ratio=3、leg1 多 1 → dr=0.333；HEDGE_THRES=0.5 | 不发对冲单（严格 `>` 与平台 `>=` 此处结论相同） |
| PAIR-HEDGE-005 | P1 | HEDGE_THRES 触发/取整 | ratio=1.5、leg1 多 1 → dr=0.667；HEDGE_THRES=0.5 | 参考取整：0.667-floor=0.667>0.5 → ceil=1 手 |
| PAIR-HEDGE-005A | P1 | 取整边界 | dr=1.5，HEDGE_THRES=0.5 | 参考：1.5-floor=0.5 不大于 0.5 → floor=1；平台 round=2，必须二选一 |
| PAIR-HEDGE-005B | P1 | 阈值高于整手 | ratio=2、leg1 多 1、HEDGE_THRES=0.6 | dr=0.5，不触发；1 手 leg1 全裸，必须告警/禁止该配置 |
| PAIR-HEDGE-006 | P0 | 对冲价格必须是合法 tick | 腿2 tick=1，slop=0.5 | 最终价格必须是整数 tick，不能出现 11866.5 |
| PAIR-HEDGE-007 | P0 | 对冲被拒绝时不误平仓 | leg1 多 1，leg2 0，对冲单被 422 拒绝 | 不发送 CLOSE；保留 leg1 持仓，下一 tick 重试 |
| PAIR-HEDGE-008 | P1 | 对冲部分成交 | leg2 只成交 1/2 | 继续对冲剩余 1 手 |
| PAIR-HEDGE-009 | P1 | 已有未完成对冲单 | hedgeOrderId 存在 | 不重复发同方向对冲单 |
| PAIR-HEDGE-010 | P2 | 对冲超时 | 超过 hedgeTimeout | 撤单并重新对冲；不得裸腿长期保留 |

### D. 平仓与收盘

| ID | 优先级 | 场景 | 持仓/时间 | 期望 |
|---|---|---|---|---|
| PAIR-EXIT-001 | P0 | 多头价差平仓（mid 口径） | leg1 多 1，leg2 空 1，mid spread≥avg-exitSpread | 腿1 SELL CLOSE，腿2 BUY CLOSE |
| PAIR-EXIT-001A | P0 | 交叉价差不应触发 mid 平仓 | longSpread 已≥avg-exitSpread，但 mid spread 未到 | 不应平仓；先明确口径 |
| PAIR-EXIT-002 | P0 | 空头价差平仓（mid 口径） | leg1 空 1，leg2 多 1，mid spread≤avg+exitSpread | 腿1 BUY CLOSE，腿2 SELL CLOSE |
| PAIR-EXIT-002A | P0 | exit 以 entry 还是 avg 为基准 | 建仓后 avg 漂移，mid spread 在 avg 附近但低于实际 entry | 必须明确；建议以实际 entrySpread 为盈利基准，avg 只做风控 |
| PAIR-EXIT-002B | P0 | exitSpread 覆盖成本 | 真实 ag 价格/费率，exitSpread=2 tick | 双边手续费+滑点 > 2 tick 时，配置应拒绝或告警 |
| PAIR-EXIT-003 | P0 | 单腿不是价差持仓 | leg1 多 1，leg2 0，spread 达到平仓条件 | 不发 CLOSE；走对冲 |
| PAIR-EXIT-004 | P0 | 日盘收盘停止 | 14:58，日盘 session，已有价差持仓 | 撤单，平掉双腿；14:57 后不再开新仓 |
| PAIR-EXIT-005 | P0 | 夜盘收盘停止 | 02:28，SHFE 夜盘，已有价差持仓 | 撤单，平掉双腿；21:00 不误触发收盘 |
| PAIR-EXIT-006 | P0 | 夜盘 21:00 开盘 | 21:00，价差在区间内 | 不因为时间晚于 14:57 而误平仓 |
| PAIR-EXIT-007 | P0 | 收盘前强平 | 强平时间到达，仍有持仓 | 撤单并 FAK 强平 |
| PAIR-EXIT-008 | P0 | AVG_SPREAD_AWAY | 偏离均值超过 100 tick | 撤单、平仓、告警/停策略 |
| PAIR-EXIT-009 | P1 | 非交易时段 | 15:30 或 20:00 | 不发新单；撤销遗留挂单 |
| PAIR-EXIT-010 | P1 | 收盘后同 session 不再开仓 | 14:58 已平仓，继续有行情 | 不再发 leg1 开仓单 |
| PAIR-EXIT-011 | P1 | 跨日 session key | 夜盘 21:00 开始，跨 00:00 到 02:29 | 同一夜盘只触发一次收盘，不因日期变化重复 |

### E. 风控与异常

| ID | 优先级 | 场景 | 条件 | 期望 |
|---|---|---|---|---|
| PAIR-RISK-001 | P0 | 最大开仓单数 | MAX_OPEN_ORDERS=2 | 第 3 笔被拒绝 |
| PAIR-RISK-002 | P0 | 最大订单数 | MAX_ORDERS=2 | 超限被拒绝 |
| PAIR-RISK-003 | P0 | 最大成交总量 | MAX_TRADED_QTY=10 | 超过被拒绝 |
| PAIR-RISK-004 | P0 | 最大亏损 | MAX_LOSS=1000，pnl≤-1000 | 参考是 squareoff；平台若只拦 OPEN，必须允许 CLOSE 并明确不自动 flat |
| PAIR-RISK-005 | P0 | UPNL/STOP LOSS | 阈值触发 | 拆成 UPNL_LOSS / STOP_LOSS / MAX_LOSS 三个独立用例，明确动作和优先级 |
| PAIR-RISK-016 | P0 | MAX_LOSS 不能拦 CLOSE | 亏损触发后持仓仍在 | CLOSE 必须放行；否则越亏越平不掉 |
| PAIR-RISK-017 | P0 | 收盘时 MAX_OPEN_ORDERS 满 | 2 笔挂单，MAX_OPEN_ORDERS=2 | 先撤单，CLOSE 不能被未确认撤单拦住 |
| PAIR-RISK-018 | P0 | MAX_TRADED_QTY 不能拦平仓 | 已达成交上限，仍有持仓 | CLOSE 放行 |
| PAIR-RISK-019 | P0 | MAX_SIZE 不能拦降风险 CLOSE | MAX_SIZE=1，需平 2 手 | CLOSE 允许拆单/按规则放行 |
| PAIR-RISK-006 | P0 | 价格非法 tick | 买 11866.5，tick=1 | 422，错误信息明确；不落 orders |
| PAIR-RISK-007 | P0 | 数量不满足 lot | qty=0 或 qty%lot≠0 | 422 |
| PAIR-RISK-008 | P0 | 可平不足 | 无持仓却发 CLOSE | 422，且 runner 不误判为价差持仓 |
| PAIR-RISK-009 | P0 | 策略非 ACTIVE | deployment=INACTIVE | 只告警，不发单 |
| PAIR-RISK-010 | P0 | ORS 不 RUNNING | ORS STOPPED | 下单被拒绝，runner 告警 |
| PAIR-RISK-011 | P1 | 控制面超时 | 下单 HTTP 超时 | 指数退避重试；不得生成重复订单 |
| PAIR-RISK-012 | P1 | 重复请求幂等 | 相同 requestId 重试 | 返回同一 clientOrderId，不重复下单 |
| PAIR-RISK-013 | P1 | 撤单失败 | cancel 返回失败 | 记录告警，下一轮重试，不重复发新单 |
| PAIR-RISK-014 | P1 | 进程重启 | 有持仓/挂单时 kill runner | 重启后从控制面恢复持仓、挂单、avg、session |
| PAIR-RISK-015 | P1 | 单腿裸仓 | 腿1成交，腿2未成交 | 告警；持续对冲，不误发 CLOSE |

### F. 数据、费用、告警、UI

| ID | 优先级 | 场景 | 条件 | 期望 |
|---|---|---|---|---|
| PAIR-DATA-001 | P0 | 费用按账户+合约 | SIMVENUE-001/ag2612、ag2706 | 两条腿读取各自 fees；缺费用告警 |
| PAIR-DATA-002 | P0 | 成交与持仓一致 | 下单→成交 | orders/trades/positions 数量一致 |
| PAIR-DATA-003 | P0 | 日状态快照 | 收盘后 snapshot | avg_px、px1、px2、today/ytd 正确落库 |
| PAIR-DATA-004 | P1 | 已实现盈亏 | 多次开平 | PnL = 价差收益 - 手续费，数量正确 |
| PAIR-DATA-005 | P1 | 告警去重 | INACTIVE 连续触发 | 同策略/合约/方向不重复刷屏 |
| PAIR-DATA-006 | P1 | 告警已读 | 打开策略详情 | 当日告警自动已读；7 天后清理 |
| PAIR-DATA-007 | P1 | WebSocket 状态 | 持仓/orders 变化 | PAIR 页面刷新 spread、avg、leg net、挂单数 |
| PAIR-DATA-008 | P1 | 页面与 DB 一致 | 查看订单/成交/持仓 | 数量、方向、价格、状态一致 |

### G. 夜盘与多日

| ID | 优先级 | 场景 | 条件 | 期望 |
|---|---|---|---|---|
| PAIR-NIGHT-001 | P0 | 夜盘正常开仓 | 21:30，spread 越过 BEGIN_PLACE | 正常报价/成交 |
| PAIR-NIGHT-002 | P0 | 夜盘收盘 | 02:27/02:29 | 停止新单、撤单、平仓 |
| PAIR-NIGHT-003 | P1 | 夜盘跨日 | 00:00 前后 | 同一 session 状态连续，不因日期重置 |
| PAIR-NIGHT-004 | P1 | 日盘切夜盘 | 15:00 后到 21:00 | 空白时段不下单；21:00 恢复 |
| PAIR-NIGHT-005 | P1 | 夜盘后日盘 | 02:30 后到 09:00 | 不下单；09:00 恢复 |
| PAIR-NIGHT-006 | P1 | DCE/CZCE 夜盘 23:00 | 22:58 | 22:57 停止、22:59 强平 |

### H. SimVenue 撮合模型（原 SimLocal）

> 2026-11-11：SimLocal 的进程内撮合已删除，改为独立进程 `sim-venue`，
> 订单走 Aeron 3140/3141，回报走 3142/3143。下表断言不变，撮合归属变了。

| ID | 优先级 | 场景 | 条件 | 期望 |
|---|---|---|---|---|
| PAIR-SIM-001 | P0 | 被动 DAY 单 rest→成交 | 腿1 挂单后对手价穿越 | orders/trades/positions 全链路落库，clientOrderId 正确 |
| PAIR-SIM-002 | P0 | FAK 部分成交 | 腿2 FAK 只成交一部分 | 残量立即撤销，状态/持仓正确 |
| PAIR-SIM-003 | P0 | FAK 0 成交 | 腿2 无可成交价 | 不产生持仓，返回明确状态 |
| PAIR-SIM-004 | P0 | 无报价/涨跌停 | 腿2 bid/ask 为 0 或封板 | 不静默返回；撤腿1、告警、保留可平仓位 |
| PAIR-SIM-005 | P0 | 委托价 vs 成交价 | 腿2 FAK 委托 49，对手价 50 | 分开断言委托价、成交价、滑点 |
| PAIR-SIM-006 | P0 | TIF 不被忽略 | Pair runner 发 FAK | `sim-venue` 必须按 FAK 撮合，不能落成 DAY |

### I. 交易员干预 / 紧急操作

| ID | 优先级 | 场景 | 条件 | 期望 |
|---|---|---|---|---|
| PAIR-OPS-001 | P0 | 一键紧急平仓 | 双腿有持仓/挂单 | 先撤单再平双腿；position=0；暂停报价直到手工 resume |
| PAIR-OPS-002 | P0 | 暂停 | 裸腿状态 | 只禁止 OPEN，仍允许对冲/CLOSE |
| PAIR-OPS-003 | P0 | 手工平一条腿 | 策略持仓中手工平腿1 | 策略应平另一条腿或暂停，不能重新开腿2 |
| PAIR-OPS-004 | P0 | 手工单干扰 | 同账户/合约手工单 | 策略不得和交易员对打 |
| PAIR-OPS-005 | P0 | 并发幂等 | 紧急平仓与收盘/对冲同时 | 不重复平仓，不重复下单 |
| PAIR-OPS-006 | P0 | 风控绕过 | MAX_LOSS/MAX_OPEN_ORDERS 已触发 | 紧急平仓/CLOSE 必须放行 |
| PAIR-OPS-007 | P1 | 审计/权限 | 交易员执行紧急操作 | 记录 who/when/target/action |

### J. 重启与双活

| ID | 优先级 | 场景 | 条件 | 期望 |
|---|---|---|---|---|
| PAIR-RESTART-001 | P0 | 重启有 live 挂单 | runner 重启 | adopt 或 cancel，不能重复挂单 |
| PAIR-RESTART-002 | P0 | 重启有裸腿 | leg1 有仓、leg2 无 | 先补对冲，不新开价差 |
| PAIR-RESTART-003 | P0 | 双 runner | 两个进程同 strategyId | 只能一个 leader 发单，另一个只读/退出 |
| PAIR-RESTART-004 | P0 | ORS 重启 | 腿1成交后、对冲前 ORS 重启 | 恢复后补对冲 |
| PAIR-RESTART-005 | P0 | 持仓中改合约 | 持仓时改 leg1/leg2 | 拒绝或强制先平仓 |
| PAIR-RESTART-006 | P0 | 对账不一致 | 控制面/ORS/柜台持仓不同 | fail closed：停止报价+告警 |

### K. 交易时段断点

| ID | 优先级 | 场景 | 条件 | 期望 |
|---|---|---|---|---|
| PAIR-SESSION-001 | P0 | ag 10:15 断点 | 10:14:59 | 撤单；10:15-10:30 不报价；10:30 恢复 |
| PAIR-SESSION-002 | P0 | 午休对冲在途 | 11:29 发对冲，13:30 成交 | hedgeTimeout 不把午休算入 |
| PAIR-SESSION-003 | P0 | 集合竞价 | 08:55-09:00 / 20:55-21:00 | 不报价，不用竞价价更新 avg |
| PAIR-SESSION-004 | P0 | 01:00 夜盘品种 | cu/al 等 | 01:00 前停止，不是统一 02:30 |
| PAIR-SESSION-005 | P0 | 两腿时段交集 | 任一腿已收盘 | 停止双边报价/对已成交腿做保护 |

## 5. 覆盖矩阵

| 模块 | 用例 |
|---|---|
| 配置 | CFG-001~005 |
| 报价/仓位偏置 | ENTRY-001~014 |
| 对冲 | HEDGE-001~010 |
| 平仓/收盘 | EXIT-001~011 |
| 风控/异常 | RISK-001~015 |
| 数据/费用/告警/UI | DATA-001~008 |
| 夜盘/多日 | NIGHT-001~006 |
| SimVenue 撮合 | SIM-001~006 |
| 交易员干预/紧急操作 | OPS-001~007 |
| 重启/双活 | RESTART-001~006 |
| 交易时段断点 | SESSION-001~005 |

## 6. 验收标准

P0 全部通过，且满足：

```text
不出现裸腿长期不处理
不出现单腿被误判为价差持仓
不出现非法 tick 价格
不出现重复下单
不出现收盘后继续开仓
不出现 21:00 误触发收盘
orders / trades / positions / daily_state 一致
```

## 7. 暂不作为本轮验收

```text
真实 CTP 柜台成交回报
交易所撮合细节
跨交易所套利
多策略共享账户的保证金优化
```

## P0 直连链路补充用例

| 编号 | 场景 | 预期 |
|---|---|---|
| P0-ORDER-01 | runner 直接发 OrderRequest，不调用 HTTP 下单 | 订单行由控制面 Aeron consumer 建立，`request_id` 一致 |
| P0-ORDER-02 | SimVenue 订单经 3140/3141/3142/3143 | 窗口/成交/撤单均可在 UI 看到（原 2120–2123 已废弃） |
| P0-ORDER-03 | 控制面停止后 runner 撤单 | CancelRequest 仍发到 Aeron，恢复后状态对账 |
| P0-ORDER-04 | 风险快照超过 riskMaxAgeMillis | OPEN 被拒绝，CLOSE 仍允许 |
| P0-ORDER-05 | CTP OrderUpdate/Trade | `request_id`、`strategyKey` 与 OrderRequest 一致 |
| P0-ORDER-06 | 127 订单号 | CTP OrderRef 不超过 12 位，回报可关联 |

---

最后核对：2026-11-11（基线 SIMLOCAL-001 → SIMVENUE-001、2120–2123 → 3140–3143、
SimLocal 进程内撮合 → 独立进程 `sim-venue`）。逐块自动化映射见
`docs/testing/e2e-regression-map.yaml` 的 B2 块。

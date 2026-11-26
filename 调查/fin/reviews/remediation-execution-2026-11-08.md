# 修复执行报告（2026-11-08）

输入：

```text
docs/reviews/architecture-review-2026-11-08.md
docs/reviews/ui-design-review-2026-11-08.md
docs/reviews/remediation-plan-2026-11-08.md
```

## 1. 已完成

### 1.1 Mock / 假数据

```text
web/src 中 mock/MOCK 常量与 API 失败静默回退已删除
useVenues 不再伪造场所
Dashboard/Orders/Audit/Indicators/Strategies 失败进入 ERROR/只读
Java 代码审查规则增加“禁止生产 Mock/Fake/静默回退”
```

### 1.2 UI 安全

```text
手工单默认价改为实时最新价
价格偏离 >0.5% 提示
预检与提交强制两段
订单页单笔撤单
策略/执行/柜台/合约危险动作确认
策略详情不再自动 ack 提醒
Dashboard 删除第二套 /positions 竞态覆盖
期权链不再过滤 ATM 行
```

### 1.3 环境与健康

```text
新增 /api/v1/system/status
顶栏显示 SHADOW、control/ORS/行情年龄
底部账户从当前场所上下文读取
```

### 1.4 SimLocal 执行语义

```text
tradeId 唯一化
撤单保留 filledQty
filledQty 累计语义
account/offset/reduce-only 校验
CLOSE 不得反向开仓
价格-时间优先撮合
```

### 1.5 控制面故障与应急

```text
control-plane UNKNOWN 不再触发 runner cancelAll
stop-all 同步暂停 strategy_deployments
stop-all 触发 cancel-all
PAUSED 策略允许 EMERGENCY_FLATTEN
```

### 1.6 风控与账务

```text
交易日历门禁（runner + 手工/策略入口）
行情龄门禁
手续费按 instrument_fees 计算并扣账户
audit_log append-only trigger
新增 instrument_margins 静态保证金表 + import API
保证金与手续费分表：CTP ReqQryInstrumentMarginRate / CommissionRate 两套查询
```

### 1.7 场所对账

```text
SimLocal venue snapshot reconciler
QF_RECON_SIMLOCAL_ENABLED=true
当前 reconciliationScope=SIMLOCAL_VENUE
venueReconciliationPass=true
```

### 1.8 本轮新增（P0/P1）

```text
期权链：真实 instruments + ticks，服务端计算 IV/Greeks；OI/成交量无源保持 null
账本：ledger_entries 双分录（手续费/已实现盈亏）；SettlementService 按 CTP 公式结算
保证金：instrument_margins 静态表 + import API；Fees 页面展示
账户风控：account_risk_limits + 账户级 open/traded/gross 校验；策略入口同样校验
Aeron：Archive 录制 1001/2001-2004/2120-2123；ArchiveReplayTool；consumer checkpoint
Drain：Pair + generic runner；本地 kill file；Aeron 断线重连撤单；agent 180s
配置：config_hash、history、rollback、ACK 超时 FAILED
安全：WS Origin 白名单；Agent token 多值轮换；LIVE 激活四眼审批
UI：单一行情 WS；Monitoring 三层状态；告警筛选/批量 ack；CSV 导出；⌘K 搜索；skip link
CI：backend/web/SBE；备份：tools/db/backup.sh + PITR 文档
```

## 2. 验证结果

```text
./gradlew test        PASS
web build             PASS
system status         SHADOW / control UP / ORS RUNNING / market fresh
manual preview        non-trading-day OPEN rejected
SimLocal cancel       gateway cancel -> CANCELED verified
venue reconciliation  passed=true
```

当前风险快照：

```text
tradingDay=false
calendarAvailable=true
reconciliationScope=SIMLOCAL_VENUE
venueReconciliationPass=true
reconciliationPass=true
```

## 3. 未完成/阻塞

### 3.1 Aeron Archive

```text
状态：DONE
已完成：aeron-archive-1.54.0 + archive/recorder 服务
已完成：1001/2001-2004/2120-2123 持续录制
已完成：ArchiveReplayTool 可列 recording / 重放
已完成：启动时自动重放最新 2120/2121/2122/2123
已完成：consumer checkpoint + OrderUpdate 时间戳防回退
```

### 3.2 完整账本/保证金/结算

```text
状态：DONE（CTP 实盘验证 BLOCKED）
已完成：ledger_entries 双分录、手续费、已实现盈亏、账户限额
已完成：instrument_margins 静态表 + import API + Fees 展示
已完成：SettlementService（CTP逐日盯市/保证金/today-yesterday）
已完成：fee_refresh 扩展 ReqQryInstrumentMarginRate，输出 margin CSV
已完成：quantlink-fin-fee-refresh.sh 同时导入 fee/margin
BLOCKED：CTP 实盘账户权益对账等交易日
```

### 3.3 R-P0-15

```text
状态：DONE
已完成：Pair + generic runner SIGTERM drain（cancel → flatten → flat 确认）
已完成：agent 等待 180s；本地 kill file；Aeron publication 断线重连撤单
已验证：pair/opt runner 均出现 drain complete；kill file 停止后移除可恢复
```

### 3.4 R-P0-18 / R-P0-19

```text
状态：DONE
已完成：交易日历、行情龄、价格笼子、可选开仓间隔、本地自成交防护
已完成：account_risk_limits 账户级 open/traded/gross 限额；策略入口同步
已完成：PAIR 两腿时段取交集；任一腿关闭则停止新开仓/对冲；closeout 按较早收盘
```

### 3.5 R-P0-08

```text
状态：DONE
已完成：删除合成期权行；/api/v1/option-chain 真实合约+实时 ticks
已完成：服务端 IV/Greeks；ATM 实时；到期/标的绑定；无报价显示 —
未完成：OI/成交量数据源（无源时 null，不造假）
```

### 3.6 P1/P2

```text
P1 已完成：CI、单一行情WS、通知收件箱筛选/批量ack、未保存保护、设计 token/format、
            WS Origin、Agent token 轮换、PAIR/期权链真实指标、备份/PITR 脚本、
            SimLocal ORS 由 Agent 读取 sim-exchange 健康文件并上报 RUNNING/stale
P1 剩余：CTP 凭据加密（按用户确认暂缓）、期权行权/换月（等交易日）、HA（无第二主机）
P2 已完成：图表主题、表格列配置/密度/导出、登录品牌、Inter 字体、语义清理
P2 BLOCKED：多主机 Aeron、Windows Electron、CTP 5日长稳
P2 BLOCKED：多主机 Aeron、Windows Electron、CTP 5日长稳/场所对账
```

## 4. 下一步

```text
1. 安装/配置 Aeron Archive（阻塞）
2. 获取 CTP 保证金率/结算口径，完成账本（阻塞）
3. drain / local kill switch / cancel-on-disconnect
4. 账户级聚合风控 / 价格笼子 / 频率限制
5. UI 信息架构与设计系统改造
6. 交易日：SimShengli/CTP/手续费/5 日长稳
```


## 5. 最终状态（2026-11-08）

### 已完成

```text
P0 全部关闭（CTP 实盘数据验证除外）
P1 除 HA、期权的 CTP 到期数据外全部关闭
P2 除外部资源阻塞项外全部关闭
```

关键收口：

```text
fee_refresh 扩展 ReqQryInstrumentMarginRate
Archive 启动自动重放 + OrderUpdate 时间戳防回退
WS ticket 鉴权 + Origin 白名单 + 写接口限流
审计哈希链 + append-only
告警静默/批量确认 + runner 指标自动进入 AlertEngine
策略健康板 + 配置历史/回滚 UI + 变更审批页
StrategyView tabs + Monitoring sparkline/kiosk
Orders 列配置/密度/CSV/筛选持久化
Inter 字体自托管 + tabular numbers
```

### BLOCKED

```text
R-P1-07 HA/主备       无第二台主机
R-P1-08 期权行权/换月  需 CTP 到期/行权数据，等交易日
R-P2-06 多主机 Aeron   无第二台主机
R-P2-07 Windows Electron 无 Windows 测试机
R-P2-08 CTP 日盘/5日长稳/场所对账 等交易日
SimNow / SimShengli   按用户要求暂不验证
```

### 取舍说明

```text
orders/trades 已带 trading_day，保留策略已脚本化；
物理分区留到数据量增长后执行，不在单机试点阶段做在线分区迁移。
CTP 凭据加密按用户确认暂缓。
```

# T-028 ORS 生命周期 + INACTIVE 策略提醒

- 日期：2026-11-07
- 环境：190 / `quantlink_fin_shadow`

## 1. ORS 跟随 Agent

```text
agent-control-local  → ors-simlocal-001         RUNNING
agent-simnow-01      → ors-simnow-test-001      STOPPED
agent-shengli-01     → ors-shengli-test-shengli STOPPED
```

ORS 没有 activate / drain / release。Agent 启动 ORS，Agent 停止 ORS 停止。

使用 `sleep 120` 代替真实 CTP 进程验证：

```text
启动 agent-simnow-01
→ ors_instances.status=RUNNING, pid=192386

恢复配置并重启 Agent
→ ors_instances.status=STOPPED, pid=0
```

## 2. 策略状态

```text
UNDEPLOYED  没有 deployment
INACTIVE    已部署，进程运行，只提醒不下单
ACTIVE      已激活，进程运行，允许自动下单
FAILED      Agent 启动失败
```

当前：

```text
TEST-STRAT-HEDGE-01  ACTIVE    RUNNING
TEST-STRAT-OPT-01    ACTIVE    RUNNING
TEST-STRAT-PAIR-01   INACTIVE  STOPPED   (没有 runner)
```

## 3. 手动激活/停止

```text
POST /api/v1/strategy-deployments/4/deactivate
→ status=INACTIVE, actual_state=RUNNING
→ runner 进程继续运行
→ 触发时写 strategy_alerts

POST /api/v1/strategy-deployments/4/activate
→ status=ACTIVE, generation++
→ runner 恢复自动下单
```

验证：

```text
INACTIVE 后 30 秒内产生 6 条提醒
alert: TEST-STRAT-OPT-01 / au2612C920 / B / 1.90
ACTIVE 后 15 秒内新增提醒 = 0，订单恢复
```

## 4. Runner 不持有账户

Runner 配置只保留：

```properties
strategyId=...
orsId=ors-simlocal-001
```

账户由控制面从 ORS 解析。Runner 先查：

```text
GET /api/v1/execution/contexts
→ ors_id → account_id
```

再提交：

```text
POST /api/v1/strategy/orders
```

订单接口不再需要 `accountId`。

## 5. 提醒接口

```text
POST /api/v1/strategy/alerts
GET  /api/v1/strategy/alerts?status=NEW
POST /api/v1/strategy/alerts/{id}/ack
```

执行页面展示：

```text
策略提醒（INACTIVE 触发）
  策略 / 合约 / 方向 / 价格 / 数量 / 原因 / 时间 / 确认
```

## 6. 测试

```text
./gradlew test
BUILD SUCCESSFUL

npx tsc --noEmit
通过
```

## 7. 提醒通知 UI

- 执行拓扑页不再展示提醒列表
- 侧边栏“策略详情”显示 NEW 提醒数量 Badge
- 新提醒到达时全局 Snackbar 提示，可点击“查看策略”
- 交易驾驶舱增加“策略提醒”卡片
- 点击“策略详情”自动选中最新触发策略
- 策略详情显示“已触发 N”标记与触发详情
- INACTIVE 触发时提供“手动激活”按钮
- ACTIVE 但仍有未确认提醒时提供“确认提醒”
- “停止”统一改为“停止自动交易”

## 8. 提醒保留与交易日历

提醒：

```text
strategy_alerts 保留 7 天
页面默认只显示当天
GET /api/v1/strategy/alerts?status=NEW&today=true
每小时清理 created_at < now() - 7 days
```

交易日历：

```text
数据源：backend/control-plane/src/main/resources/trading_days.txt
逻辑搬运自 trading:
  today / next / night-ok
  gap > 3 自然日 → 夜盘取消
  calendar expired → fail-closed 提示

接口：
  GET /api/v1/calendar/status
  GET /api/v1/calendar/month?year=2026&month=11
  GET /api/v1/calendar/upcoming?limit=10

页面：
  /calendar
  AppShell 顶部下一交易日提醒
  驾驶舱休市/下一交易日提示
```

2026-11-07 验证：

```json
{
  "today": "2026-11-07",
  "todayTradingDay": false,
  "nextTradingDay": "2026-11-09",
  "nextGapDays": 2,
  "nightSessionOk": false,
  "firstDay": "2006-04-17",
  "lastDay": "2027-12-31",
  "totalDays": 5298
}
```


## 9. 交易日历爬虫/检查

已迁移：

```text
tools/trading_calendar/update_trading_days.py
```

支持：

```text
--check
--year
--file
```

生产文件：

```text
/etc/quantlink-fin/trading_days.txt
QF_CALENDAR_FILE=/etc/quantlink-fin/trading_days.txt
```

定时检查：

```text
quantlink-fin-calendar-check.timer
每天 06:15
只检查覆盖范围/内部缺口，不自动改文件
```

手动更新：

```bash
python3 /opt/quantlink-fin/tools/trading_calendar/update_trading_days.py   --file /etc/quantlink-fin/trading_days.txt
```

## 10. PAIR Java 第一版

新增：

```text
FuturesPairStrategy
```

当前：

```text
sim-local-pair runner UP
deployment 2 INACTIVE
```

只读价差信号模式，不自动下单。


## 11. PAIR 专用页面

```text
/strategy-view?strategy=TEST-STRAT-PAIR-01
```

页面顶部为两腿专用面板：

```text
当前价差 / 价差均值 / 价差持仓 / AVG_SPREAD_AWAY
腿1 盘口 + 净持仓
腿2 盘口 + 净持仓
entry / exit / tick
腿1挂单中状态
runner 状态更新时间
```

PAIR 状态由 runner 每 2 秒写入 `pair_state`。

## 12. PAIR 页面与在线日历

PAIR 专用面板已验证：

```text
/strategy-view?strategy=TEST-STRAT-PAIR-01
leg1=ag2612 / leg2=ag2706
spread=-56 / avg=-50
entryPending=true / entrySide=LONG
PAIR deployment=INACTIVE
```

PAIR runner 每 2 秒写 `pair_state`。

在线日历：

```bash
python3 tools/trading_calendar/update_trading_days.py --online --year 2026
```

使用 `timor.tech` 公共节假日 API，失败回退内嵌 `HOLIDAYS`。
更新外部文件后可 reload：

```text
POST /api/v1/calendar/reload
```

## 13. PAIR 专用 Runner

新增：

```text
PairSpreadRunner
```

职责：

```text
腿1 被动 DAY
挂单查询/撤单
腿1 成交后腿2 FAK 对冲
价差回归平仓
AVG_SPREAD_AWAY 撤单/平仓
14:55 收盘前平仓
pair_state 上报
```

当前：

```text
sim-local-pair UP
TEST-STRAT-PAIR-01 INACTIVE
腿1=ag2612 腿2=ag2706
```

PAIR 提醒：

```text
同一策略/合约/方向 NEW 未确认前只保留一条
确认后才允许下一条
```

## 14. PAIR 配置入库

```text
strategy_pair_configs
strategy_daily_state
instrument_fees
```

验证：

```text
GET /api/v1/strategies/TEST-STRAT-PAIR-01/pair-config
PUT /api/v1/strategies/TEST-STRAT-PAIR-01/pair-config
POST /api/v1/strategies/TEST-STRAT-PAIR-01/daily-state/snapshot
POST /api/v1/instrument-fees/import
```

日状态当前：

```text
avg_px ≈ -62.01
ytd1=0 today1=0 ytd2=0
px1=11798 px2=11858
```

真实费率已导入：

```text
ag2612 5.005e-05
ag2706 0.00015
```


## 15. 柜台账户与消息已读

- MetaConfig 新增「柜台账户」配置，写入 accounts。
- 策略详情打开后自动把该策略的 NEW 提醒置为 ACK/已读。
- 详情页仍保留当天触发标记，用于展示和手动激活。
- instrument_fees 改为 (account_id, instrument_id) 复合主键。
- SimLocal 当前测试费率按 0 配置；TEST-001 已导入 CTP 实际费率。

# T-029 独立模拟交易所（Sim Venue）— 实现证据

- 日期：2026-11-08
- 状态：核心链路已实现；跨主机/长稳/双跑仍受环境阻塞
- 设计：`docs/architecture/19-独立模拟交易所与正式接入.md`
- 任务：`docs/tasks/T-029-独立模拟交易所.md`

## 1. 已实现

### 1.1 独立 Sim Venue 进程

```text
backend/sim-venue
  SimVenueMain
  SimVenueGateway
  VenueStore
  VenueSnapshot
```

能力：

```text
- 独立 JVM / 独立 systemd 服务
- 配置化 Aeron channel + stream
- OrderRequest / CancelRequest
- OrderUpdate / Trade
- MarketData 订阅与可选转发
- account / targetAgent / fencingToken 校验
- snapshot + journal
- 重启恢复
```

### 1.2 channel/stream 配置

数据库迁移：

```text
tools/db/migrate-t029-venue-channels.sql
```

新增字段：

```text
order_channel / order_stream
cancel_channel / cancel_stream
update_channel / update_stream
trade_channel / trade_stream
md_channel / md_stream
```

已应用到影子库：

```text
SIMLOCAL-001: order 2120 / md 1001 / aeron:ipc
SimNow:       order 2100 / md 1100 / aeron:ipc
Shengli:      order 2110 / md 1110 / aeron:ipc
SIMVENUE-001: order 3120 / md 1001 / aeron:ipc
```

### 1.3 控制面 / Runner 接入

- `ExecutionController` 新增 `POST /api/v1/execution/ors`
- `ExecutionMapper` / `AeronOrderMapper` 返回 channel + stream
- `AeronOrderGateway` 使用 execution context 的 channel
- `ManualOrderPublisher` 按 route channel 发布
- `MarketDataAeronConsumer` 按 route channel 订阅
- `RuntimeRunner` 支持 `mdChannel` / `orderChannel` 等配置
- `AeronOrderUpdateConsumer` 按 route channel 订阅

### 1.4 验证

```text
./gradlew :backend:sim-venue:test
  VenueStoreTest: PASS
  SimVenueGatewayTest: PASS（订单经自定义 channel 成交并持久化）

./gradlew test
  PASS
```

服务：

```text
quantlink-fin-sim-venue.service: active
account=SIMVENUE-001
order=aeron:ipc:3120
update=aeron:ipc:3122
md=aeron:ipc:1001
recovered=0
```

## 2. 当前阻塞

```text
[ ] 独立主机/第二 media driver：当前只有单机环境
[ ] 跨主机 aeron:udp 实测
[ ] 多客户端 update/trade fan-out
[x] venue health / sequence gap / journalLag / journalBytes（venue recon 待补）
[ ] 断网/重启/重复/backpressure/磁盘慢/时钟偏移故障注入
[ ] 旧 SimLocal 与 SimVenue 双跑切换
```

## 3. 已知限制

```text
1. 当前 SimVenue v1 仍是 one account per venue instance
2. SimVenue 与 SimLocal 同时运行时使用不同 stream（3120-3123）
3. 手工单正式链路已通过 7×24 Sim Venue 例外验证（非交易日可用）
4. SimVenue health.json 已暴露 sequence / journalLag / journalBytes
5. SimVenue 的 MD 订阅 1001；跨主机时需配置 aeron:udp 和 md channel
6. 手工单/策略单的旧 simInprocess 分支已删除；SimExchangeService 仅保留行情/本地 canary 用途
```

## 4. 已验证（2026-11-08，非交易日）

```text
[x] 手工单经 OrderRouter 到 SimVenue（非交易日 24×7 验证）
[x] OrderUpdate / Trade 回到 Control Plane
[x] 策略单经 StrategyOrderService → OrderRouter → SimVenue
[ ] OrderUpdate / Trade 回到 Runner（Runner 侧 SimVenue 绑定待部署）
[ ] 场所 vs 本地 orders/trades/positions/accounts 对账
[ ] SimNow / SimShengli CTP 行情与 SimVenue 并发运行
```

## 5. 2026-11-08 正式链路验收（非交易日）

Sim Venue 作为 7×24 模拟交易所，被允许绕过真实交易日历。

```text
手工单 API
  → T-029 OrderRouter
  → Aeron 3120
  → SimVenue
  → OrderUpdate/Trade 3122/3123
  → Control Plane
```

结果：

```text
900000000003  OPEN
900000000004  FILLED  @ 11802
900000000005  FILLED  @ 11800
900000000006  FILLED  @ 11801
900000000007  CANCELED
```

控制面 `orders` / `trades` 均能观察；SimVenue 状态文件：

```text
/var/lib/quantlink-fin/sim-venue-simvenue/snapshot.json
/var/lib/quantlink-fin/sim-venue-simvenue/journal.jsonl
/var/lib/quantlink-fin/sim-venue-simvenue/health.json
```

健康接口：

```json
{
  "venueId": "SIMVENUE-001",
  "accountId": "SIMVENUE-001",
  "sequence": 8,
  "sequenceGap": 0,
  "journalBytes": 2653,
  "journalLagMs": 0,
  "lastEventAgeMs": 0,
  "connected": true,
  "orders": 0,
  "positions": 1
}
```

已接入 `/api/v1/system/status` 的 `simVenue` 字段，Monitoring 页面显示 Sim Venue 状态、sequence、journal 大小、journal lag、未完成订单。

## 6. 策略单验证（2026-11-08，非交易日）

使用临时策略 `T029-SIMVENUE-STRAT`，显式指定 `orsId=ors-simvenue-001`：

```text
记账请求 → StrategyOrderService
  → 7×24 豁免（venue_type=SIM）
  → OrderRouter → Aeron 3120
  → SimVenue
  → OrderUpdate/Trade 3122/3123
  → Control Plane
```

结果：

```text
900000000009  B OPEN @11805  FILLED @11802
900000000010  S CLOSE @11800 FILLED @11800
```

策略 risk snapshot（绑定 SimVenue 时）：

```json
{
  "venueType": "SIM",
  "simulatedVenue": true,
  "calendarRequired": false,
  "tradingDay": false,
  "accountId": "SIMVENUE-001"
}
```

验证后临时策略、绑定、测试订单/成交/持仓已清理。

## 7. 下一交易日

```text
2026-11-09
```

交易日历查询结果：`today=2026-11-08` 非交易日，`nextTradingDay=2026-11-09`，`nextGapDays=1`。

## 8. 移除 simInprocess 后复测

2026-11-08 再次验证（非交易日）：

```text
900000000011  手工单 B @11700  → NEW → CANCELED
900000000012  策略单 B @11700  → NEW → CANCELED
```

两条订单均经 `ManualOrderPublisher` / `OrderRouter` → Aeron 3120 → SimVenue，
再经 3122/3123 回到 Control Plane；控制面不再调用本地 `SimExchangeService` 下单。

当前 health：

```json
{
  "sequence": 12,
  "sequenceGap": 0,
  "journalBytes": 4455,
  "journalLagMs": 0,
  "lastEventAgeMs": 5491,
  "connected": true,
  "orders": 0,
  "positions": 1
}
```

## 9. 测试数据清理

2026-11-08 已完成清理：

```text
临时策略 T029-SIMVENUE-STRAT       已删除
测试 orders                          8 条删除
测试 trades                          5 条删除
测试 positions                       1 条删除
测试 strategy_positions              1 条删除
SIMVENUE-001 账户余额/可用资金       重置为 1,000,000
SimVenue snapshot/journal/health     重置，恢复后 sequence=0、positions=0
```

`ledger_entries` 和 `audit_log` 是追加式审计表，按设计未删除；它们保留测试动作的审计痕迹。

## 10. 第二轮验证（2026-11-08）

### 10.1 场所级对账

新增 `GET /api/v1/reconciliation/venue`，同时返回 SimLocal 与 SimVenue：

```json
{
  "simLocal": {"passed": true, "scope": "SIMLOCAL_VENUE", "available": true,
               "localOrders": 0, "venueOrders": 0, "differences": []},
  "simVenue": {"passed": true, "scope": "SIMVENUE_VENUE", "available": true,
               "localOrders": 0, "venueOrders": 0, "differences": []}
}
```

比较内容：

- 控制面 open orders vs SimVenue snapshot open orders
- remaining / filled / price / side
- 控制面净持仓 vs SimVenue `positions[].netQty`
- SimVenue health `sequenceGap`
- health 新鲜度（10s）与行情连接状态

测试过程中发现并修复了撤单竞态：`StrategyOrderController.cancel` 原先在发布撤单后无条件写
`CANCEL_REQUESTED`，可能覆盖 SimVenue 已回传的 `CANCELED`。现在先写意图，再发布；失败才写
`CANCEL_FAILED`。

### 10.2 Health 指标

`SimVenue` health 已包含：

```text
sequence / sequenceGap / journalBytes / journalLagMs / lastEventAgeMs
ordersReceived / ordersRejected / tradesFilled
lastMatchLatencyMs / maxMatchLatencyMs / snapshotAgeMs
duplicateOrders / backpressureEvents / persistenceErrors
```

其中：

- `journalLagMs=0`：journal 同步写入
- `snapshotAgeMs`：最近一次 snapshot 写入年龄
- `backpressureEvents`：5s publication 超时计数
- `persistenceErrors`：journal/snapshot 写失败计数

Monitoring 已展示 Sim Venue 卡及 `seq / gap / match / reject / trades / journalLag / snapshotAge`。

### 10.3 单机故障测试

已通过：

```text
SimVenueGatewayTest.orderFlowsAcrossConfiguredChannelsAndPersists
SimVenueGatewayTest.persistenceFailureIsVisibleInHealth
SimVenueGatewayTest.publicationBackpressureIsBoundedAndVisibleInHealth
SimVenueGatewaySecurityTest.rejectsWrongAccountAndFencingBeforeMatching
VenueStoreTest.snapshotSurvivesRestart
VenueStoreTest.journalSequenceGapIsReported
AeronUdpLoopbackTest.twoMediaDriversCommunicateOverUdp
```

重启恢复实测：SimVenue 在存在 resting order 时重启，恢复 `sequence=6`、open order=1、
position=1，对账仍为 0 差异；重启后可继续撤单。

### 10.4 Runner 直连与切换 pilot

SimVenue 独立 agent（`agent-simvenue-01`）已启动：

```text
runner -> Aeron 3120/3121
SimVenue -> 3122/3123
Control Plane 索引订单与成交
```

实测订单（历史数据，已清理）：

```text
428120943001 OPEN
428120953002 FILLED
428125978003 OPEN
...
```

受控切换：

```text
旧 SimLocal OPT deployment 4  STOPPED
新 SimVenue OPT deployment 9  ACTIVE / RUNNING
runtime_instances: sim-local-opt STOPPED, sim-venue-opt UP
```

对账通过；随后 rollback：

```text
SimVenue deployment 9 STOPPED
SimLocal deployment 4 ACTIVE / RUNNING
```

切换/回滚脚本：

```text
tools/sim-venue/cutover.sh
tools/sim-venue/rollback.sh
```

### 10.5 长稳与跨主机边界

1 小时行情长时间运行：

```text
qf-sim-long --seconds 3600 --interval-ms 100
16:18:11 → 17:18:11（3600s）正常结束
期间 marketFresh=true，marketAge 持续为数十 ms，无 API/服务异常
```

新增两 media driver 的 UDP loopback 测试通过，但真实跨主机仍缺第二台 Linux 主机：

```text
AeronUdpLoopbackTest: PASS（同机双 media driver，aeron:udp）
真实 host-to-host UDP: BLOCKED（环境无第二主机）
```

时钟偏移/真实磁盘慢盘未做（需要第二主机或受控内核/磁盘故障注入）；单机 journal 写失败已由
`persistenceErrors` 测试覆盖。

## 11. 最终运行状态（2026-11-08 17:20 CST）

```text
quantlink-fin-control              active
quantlink-fin-runtime-agent        active
quantlink-fin-runtime-agent-simvenue active（无策略 deployment 时保持空闲）
quantlink-fin-sim-venue            active
```

SimVenue：

```text
sequence=0 sequenceGap=0 orders=0 positions=0
reconciliation/venue.simVenue.passed=true
```

SimLocal 旧路径仍运行，其旧快照有 2 笔未被当前控制面索引的 open orders，因此
`reconciliation/venue.simLocal.passed=false`；这是 SimLocal 退役前遗留状态，不影响
SimVenue 验收。全量退役/清理需在切换确认后执行。

下一交易日：

```text
2026-11-09
```

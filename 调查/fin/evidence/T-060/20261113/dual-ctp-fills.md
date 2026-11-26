# 双 CTP 成交隔离（2026-11-13 日盘）

## 结果

| 柜台 | clientOrderId | 动作 | 状态 | filled |
|---|---|---|---:|---:|
| SIMNOW | 900000001005 | B 1 OPEN au2612 | FILLED | 1 |
| SIMSHENGLI | 900000001004 | B 3 CLOSE au2612 | FILLED | 3 |

- SimNow 成交写入 `trades`：`TEST-001|2026-11-13|249807`，账户/venue 正确。
- SimShengli 平仓 3 手全部成交，`positions` 中 TEST-SHENGLI short 行被柜台快照移除。
- SimShengli 3 笔成交进入 `unassigned_trade`（trade_id 8335/8333/8272），没有进入账户 ledger。
  这是平仓归属/账本缺口，venue truth 仍然正确。
- 两柜台订单、成交流、仓位、快照没有串柜台。
- `/api/v1/reconciliation/shadow` 返回 `passed=true, differences=[]`。

## 真实帧 fixture

- 抓取 stream 2102/2103/2112/2113：`2102=4 2103=1 2112=6 2113=3`
- fixture：`backend/shared/aeron/src/test/resources/ctp-order-trade.bin`
- 测试：`RecordedCtpOrderTradeFramesTest` 通过，覆盖两个柜台 OrderUpdateV2/TradeV2。

## P4 / Registry

- 策略 `TEST-STRAT-PAIR-01` 绑定 SIMVENUE EMA13 但无 OK 值；OPEN 被 422：
  `指标 gate 未通过，禁止开仓：indicator ... status=null`。
- `GET /api/v1/venue-registry` 返回 SIMVENUE/SIMNOW/SIMSHENGLI 及 ORS 能力，200。
- `GET /api/v1/indicators/engines|leases|acks` 200。
- rollback SQL 在事务中 dry-run 后 ROLLBACK，三条 ORS 更新成功。

## 遗留

1. SimShengli 平仓成交未归属到 MANUAL/account ledger（unassigned_trade）。
2. 4 核 load≈42，3 个 TradeBot 各 ~96%，CTP MD 有调度饥饿风险；建议迁走/限 quota。
3. 24h soak 计时被多次部署重启打断，需重新连续计时。

## 收尾修复（2026-11-13 16:xx）

- ACK 非法状态：`BOGUS` 从 500 改为 **400**；`REJECTED_RETRYABLE` 合法 ACK 返回 200。
- `unassigned_trade` 根因：CTP 隔夜仓在 `position_ledger`/`book_positions` 中没有种入，
  平仓成交触发 `book close exceeds yesterday short`，事务回滚后被降级为 unassigned。
- 修复：平仓成交应用前，按 venue `positions` 补种空/不足的账本和 MANUAL book；
  新增 `BookPositionServiceTest`。已部署，**下一个交易时段需真实平仓复测**（2026-11-16 09:00）。
- `readonly-smoke` 24/24 页面通过（修正空表 `colSpan` 误报断言）。
- 最终 soak 窗口：**2026-11-16 09:00 → 2026-11-17 09:00 CST**；
  2026-11-13 起为预跑，不计最终 PASS。
- P4 runner 路径：`AeronOrderGateway.submit` 在发布 OPEN 前调用
  `/api/v1/indicators/gate`；无绑定放行，有绑定但无 OK 值拒绝。控制面重启不重启
  indicator-engine（PID 463150 持续运行），soak 起点不变。

## P3 旧 session

- `MarketEventSequencer` 已接入 `IndicatorRuntime.onEvent`：重复/过期事件直接丢弃，
  新 session 到达后旧 session 事件返回 `OLD_SESSION` 并丢弃。
- 单测覆盖 `dropsEventsFromOlderSession`。
- 手工下单预览改为真实 `au2612`：HTTP 200，`allowed=true`，notional=839000，
  margin=100680，reasons=[]。原 `ag2612` 是无效测试合约。

## P2 故障注入（2026-11-13 17:18-17:21）

- SIGKILL `indicator-engine` 且 `systemctl stop` 防自动拉起。
- 租约过期后 watchdog 5s 内执行：`indicator_engine.status=FAILED`、
  `indicator_lease.status=FENCED`、`indicator_latest.status=PRODUCER_LOST/source=CONTROL`。
- 旧 fencing token 写值：HTTP 409 `producer lease is not active`；
  engine 重启后旧 token 仍 409 `stale/fenced producer token`。
- 新 fencing token 写值 HTTP 200；`seq=0` 被 watermark 忽略，latest 未被测试值污染。
- engine 恢复：PID 480888，启动 2026-11-13 17:21:27，lease fencing=31 ACTIVE。
- `publishValue` 现在强制校验 ACTIVE lease + tokenEpoch + fencingToken + expires_at。
- 最终 soak 起点：**2026-11-13 17:21:27 CST**，目标 **2026-11-14 17:21:27 CST**。
  周末无行情，本段 soak 验证进程/租约/心跳稳定性；指标值恢复在周一开盘验证。

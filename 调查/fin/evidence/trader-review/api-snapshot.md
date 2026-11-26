# A 系统只读接口快照（2026-11-11 18:56–19:10 CST）

环境：SHADOW，`https://101.43.54.190:8443`，只读 GET。

## 1. 总体

| 项 | 值 |
| --- | --- |
| 策略数 | 6 |
| 账户数 | 3（SIMVENUE-001 / TEST-001 / TEST-SHENGLI） |
| 未归属成交 | 1 笔 / 2 手（ag2612 买 11797，16:36:47，来源 AERON） |
| 今日委托 | 0 |
| 今日成交 | 0 |
| 历史委托 / 成交 | 530 / 31（全量） |
| 运行中 ORS | 1 / 3（simvenue RUNNING；shengli、simnow HALTED） |
| NEW 告警 | ≥500（接口上限 500），全部同一指纹 |

## 2. 策略状态自相矛盾（`/api/v1/strategy-center/overview`）

| strategy_id | strategyStatus | deploymentState | actualState | environment | pnlSource |
| --- | --- | --- | --- | --- | --- |
| PAIR-SIMVENUE-MW9C01BR | ACTIVE | ACTIVE | RUNNING | LIVE | AGENT |
| SIMNOW-NIGHT-OPT | ACTIVE | ACTIVE | RUNNING | LIVE | **NO_AGENT_DATA** |
| SIMVENUE-OPT-01 | ACTIVE | **INACTIVE** | **RUNNING** | SHADOW | AGENT |
| STRAT-PAIR-EDITED-…-FXII8 | PAUSED | INACTIVE | STOPPED | SHADOW | NO_AGENT_DATA |
| STRAT-SIMNOW-PAIR-…-VEDO8 | **DRAFT** | INACTIVE | **RUNNING** | SHADOW | AGENT |
| STRAT-SIMNOW-PAIR2-…-VFKM4 | ACTIVE | ACTIVE | RUNNING | LIVE | NO_AGENT_DATA |

驾驶舱 KPI「3 个运行中」= 按 `deploymentState ∈ {ACTIVE, RUNNING}` 计数（`Dashboard.tsx:167-168`），因此与 `actualState` /
`strategyStatus` 都不是同一口径。`/execution` 页同时显示 `SIMVENUE-OPT-01` 的 desired/actual 均为 `RUNNING`，但部署状态为 `INACTIVE`。

## 3. 告警风暴（`/api/v1/strategy/alerts?status=NEW`）

```
count = 500（limit 上限）
strategy_id = PAIR-SIMVENUE-MW9C01BR × 500
reason = "PAIR order rejected: local risk snapshot is stale; loaded=true ageMs=221947 maxAgeMs=15000"
first   = 2026-11-11T11:15:02.537+08:00
last    = 2026-11-11T11:11:53.914+08:00   ← 3 分 9 秒内产生
status  = NEW（采集时 18:56，未 ack、未过期）
```

同一时间窗内，固定为“本地风控快照过期 221.9 秒（阈值 15 秒）”导致**每一笔报单都被拒**。
`/orders` 今日委托数仍为 **0** —— 被拒的报单没有以订单形式出现在订单表，只存在于告警里。

## 4. 指标（`/api/v1/indicators`）

```
PAIR_HEDGE_LATENCY  value=269081.321 ms  status=CRIT  warning_threshold=0.0 critical_threshold=0.0
PAIR_SPREAD         value=11272.04       status=CRIT  warning_threshold=0.0 critical_threshold=0.0
PAIR_ZSCORE         value=0.172           status=OK    warning_threshold=2.0 critical_threshold=3.0
```

阈值 0/0 时任何数值都满足 `>= critical`，因此前两个指标**永久 CRIT**；`/indicators` 同屏另有十余个指标 STALE（1142m / 2615m）。

## 5. 持仓（`/api/v1/positions`）

| account | instrument | long | short | avg | updated_at |
| --- | --- | --- | --- | --- | --- |
| SIMVENUE-001 | ag2612 | 0 | 0 | 0 | 2026-11-10 21:06:35 |
| SIMVENUE-001 | au2612 | 0 | 0 | 0 | 2026-11-10 21:05:22 |
| SIMVENUE-001 | au2612C920 | 1 | 0 | 1.81 | **2026-11-09 21:46:29** |
| TEST-001 | ag2706 | 0 | 88 | 12803 | 2026-11-11 18:01:50 |
| TEST-001 | au2612 | 4 | 0 | 885.72 | 2026-11-11 18:01:50 |
| TEST-SHENGLI | au2612 | 0 | 3 | 1051.98 | 2026-11-11 18:01:50 |

`/orders` 的「总持仓」页以完全相同的样式展示 11-09 / 11-10 的行与 18:01 的行，没有新鲜度降级；
同时 0/0 的空行也占据列表。

## 6. 可复用的写接口（本次未调用）

| 能力 | 接口 | 前端是否已用 |
| --- | --- | --- |
| 策略单撤单 | `POST /api/v1/strategy/orders/{id}/cancel` | **否（全站无调用方）** |
| 未完成策略单 | `GET /api/v1/strategy/orders/open` | 否 |
| 手工单预览 | `POST /api/v1/manual/orders/preview` | 是 |
| 全撤 / 停全部 / 只减仓 | `POST /api/v1/emergency/{cancel-all,stop-all,reduce-only}` | 是 |
| 部署 激活/停用/停止/回滚 | `POST /api/v1/strategy-deployments/{id}/{activate,deactivate,stop,rollback}` | 是 |
| 版本 | `PUT /api/v1/strategy-center/strategies/{id}/versions`（服务端 merge patch） | 是（但要求手写 JSON） |
| 告警确认/静默 | `POST /api/v1/strategy/alerts/{id}/{ack,silence}` | 是 |
| 未归属认领 | `POST /api/v1/strategy-center/unassigned/{tradeId}/claim` | 是（二级 Tab） |

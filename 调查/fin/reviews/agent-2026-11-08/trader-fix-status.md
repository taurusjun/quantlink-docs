# 交易员审查修复状态（fix/trader-review）

基线：`main@708a5fb`  
分支：`fix/trader-review`

## P0

| 编号 | 状态 | 修复 |
|---|---|---|
| TRD-P0-01 | 已修 | 单策略 activate/deactivate 不再 bump generation、不 reload、不平仓；停止文案改为“停止报价，保留仓位”；stop-all 仍暂停+撤单+平仓 |
| TRD-P0-02 | 已修 | cancel-all/cancel-strategy 覆盖 SENT/ACK_TIMEOUT/CANCEL_FAILED/CANCEL_REQUESTED |
| TRD-P0-03 | 已修 | 手工单、HTTP 策略单统一走 ReconciliationGateService；venue 对账按账户过滤；CLOSE/CANCEL 不拦 |
| TRD-P0-04 | 已修（CTP 待验） | 手工单保证金改用 instrument_margins；Dashboard 不再二次扣保证金，使用 accounts.margin/available；无账户显示无数据；编辑账户不再改余额/可用/保证金 |
| TRD-P0-05 | 已修 | 期权 Greeks 用 tick 反算 IV；无行情/无 IV 显示 stale/—，不再用固定 18% IV 和理论价冒充最新价 |
| TRD-P0-06 | 已修 | 策略横幅只用实时 NEW 告警；historyAlerts 仅用于“今日已触发”计数；ack 后立即消失 |
| TRD-P0-07 | 已修 | 手工确认按钮提交中禁用；Idempotency-Key + orders.request_id 唯一索引；重复请求返回同一订单 |

## P1

| 编号 | 状态 | 修复 |
|---|---|---|
| TRD-P1-01 | 已修 | 激活/停止二次确认；激活不自动 ack 告警；文案说明不平仓 |
| TRD-P1-02 | 已修 | 撤单状态机保留；cancel-all 覆盖所有可能在场状态 |
| TRD-P1-03 | 已修 | 开启只减仓自动撤 OPEN 挂单；禁止买卖两侧开仓；文案同步 |
| TRD-P1-04 | 已修 | 一键 stop-all 平仓文案；Pair drain bid/ask=0 跳过并告警，不发 1 tick 假单 |
| TRD-P1-05 | 已修 | Pair 状态增加 unpairedQty；残余腿自动 flatten/告警 |
| TRD-P1-06 | 已修 | 夜盘 21:00-02:30 归属下一交易日；周五夜盘跨零点允许 OPEN |
| TRD-P1-07 | 已修 | 告警去重/静默按 reason；不同原因不会被旧 ACK 静默 |
| TRD-P1-08 | 已修 | 新增“账务与结算”页：权益/可用/保证金、today/yesterday、逐笔手续费、结算历史 |
| TRD-P1-09 | 已修 | 手工单服务端价格笼子/时段/行情龄；切换合约清空旧价，无行情禁止提交 |
| TRD-P1-10 | 已修 | 部署/激活/停止/回滚写审计；回滚走审批；部署/回滚 busy 防连点 |
| TRD-P1-11 | 已修 | 账户限额缺失 fail-closed；全账户补限额 |
| TRD-P1-12 | 已修 | StrategyView 展示策略级对账 PASS/FAIL、issue、lastSuccess；Monitoring 5s 刷新并展开 issue |
| TRD-P1-13 | 已修 | Runner 重复单判断加入 offset |
| TRD-P1-14 | 已修 | Runner 缓存 execution context/instruments/sessions/risk/order-id block；控制面不可用时只平仓/撤单 |
| TRD-P1-15 | 已修 | account_risk_limits.max_daily_loss + 定时账户日亏损熔断；触发后账户级只减仓、撤开仓单、P0 告警，需人工复位 |
| TRD-P1-16 | 已修 | 手工单切换合约清价；无行情禁止提交；服务端价格笼子 |
| TRD-P1-17 | 已修 | 手工单统一检查 Aeron 下单桥；无 route 不再回退 legacy；发布失败置 SEND_FAILED |

## P2

P2 已处理：Dashboard 环境、消息中心策略/合约筛选与多选、审计筛选/日期/操作者/CSV、审批 before/after diff、
订单搜索/5s 刷新/CSV、账务结算页、Monitoring 对账 issue 展开、Pair 告警 30s 去重、组合持仓 account key、
Alt+C 全撤/Alt+S 停全部并平仓/ / 合约搜索。

## 验证

```text
./gradlew test PASS
web npm run build PASS
Playwright 38 passed
控制面宕机 + Runner 离线缓存启动 PASS
备份 pg_restore 到临时库 PASS
190 control-plane/runtime-agent/runner/sim-exchange/sim-venue active
SimLocal reconciliationPass=true
accountReconciliationPass=true
venueReconciliationPass=true
```

## 仍需交易日验证

```text
CTP 实际保证金/权益/结算
CTP 手工单/撤单/只减仓
CTP Adapter kill -9
真实夜盘跨零点
```

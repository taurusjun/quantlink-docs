# 下一交易日验证清单

日期：待定（下一交易日）

## 0. 前置

```bash
systemctl is-active quantlink-fin-control quantlink-fin-runtime-agent \
  quantlink-fin-aeron-archive quantlink-fin-archive-recorder
curl -s -u test_admin:test http://127.0.0.1:18081/api/v1/calendar/status
```

必须看到：

```json
{"todayTradingDay": true, ...}
```

## 1. CTP 手续费 + 保证金刷新

```bash
/opt/quantlink-fin/bin/qf-fee-refresh \
  --config /etc/quantlink-fin/ctp/ors_server_simnow.cfg \
  --out /tmp/fee.csv \
  --margin-out /tmp/margin.csv \
  --timeout 600
```

导入：

```bash
python3 /opt/quantlink-fin/tools/fee/import_fee_csv.py \
  --file /tmp/fee.csv --url http://127.0.0.1:18081 --account TEST-001

python3 /opt/quantlink-fin/tools/margin/import_margin_csv.py \
  --file /tmp/margin.csv --url http://127.0.0.1:18081 --account TEST-001
```

核对：

```bash
curl -s -u test_admin:test http://127.0.0.1:18081/api/v1/instrument-fees \
  | python3 -m json.tool | head
curl -s -u test_admin:test http://127.0.0.1:18081/api/v1/instrument-margins \
  | python3 -m json.tool | head
```

验收：

```text
instrument_fees 非零
instrument_margins 非零
multiplier/prev_settle 与 CTP 终端一致
重复执行不产生重复行
```

## 2. 日结算

用 CTP 结算价调用：

```bash
curl -s -u test_admin:test -H 'Content-Type: application/json' \
  -X POST 'http://127.0.0.1:18081/api/v1/settlements/run?accountId=TEST-001' \
  -d '{"tradingDay":20261109,"prices":{"au2612":900.0}}'
```

验收：

```text
today_* 清零，yesterday_* = 原持仓
avg_price = settlement price
account_daily_settlements 有记录
ledger_entries 有 SETTLE-* 双分录
accounts.margin 与 CTP 保证金一致
```

## 3. 期权到期 / 行权 / 换月

```text
到期前 3 日只减仓：OPEN 被拒绝，CLOSE 通过
到期日/行权/指派：以 CTP 柜台数据为准
主力换月：确认新合约在 instruments 中启用、旧合约只减仓
```

## 4. CTP 5 日长稳

连续 5 个交易日检查：

```text
control-plane 无重启
runtime-agent 无重启
ORS/CTP 断线重连正常
Aeron 背压 = 0
venueReconciliationPass = true
账户权益与 CTP 一致
```

## 5. 证据

保存到：

```text
docs/evidence/next-trading-day/
```

包括：

```text
fee/margin CSV
instrument_fees/instrument_margins 查询结果
settlement API 响应
ledger_entries 双分录
5 日系统状态/对账结果
```

## 6. 配置真相与行情 provenance

```bash
sudo cat /etc/quantlink-fin/control.env
curl -s -u test_admin:test http://127.0.0.1:18081/api/v1/market/ticks \
  | python3 -m json.tool | head -60
curl -s -u test_admin:test http://127.0.0.1:18081/api/v1/system/status \
  | python3 -m json.tool
```

验收：

```text
QF_AERON_ENABLED=true
QF_MARKET_AUTO=false
QF_RECON_GATE_ENABLED=true
QF_STRATEGY_CANARY=false（SHADOW/LIVE）
所有行情 source 为 aeron/ctp，不能出现 simulated 覆盖
停掉行情源 5 秒后 marketFresh=false，OPEN 被拒
```

## 7. stop-all / 控制面宕机 / Archive 重放

```bash
# 有持仓和挂单时
curl -s -u test_admin:test -X POST http://127.0.0.1:18081/api/v1/emergency/stop-all
```

验收：

```text
5 秒内无新单
orders 全部终态
positions 净额为 0
Runner/Agent 进程退出
agent 日志出现 drain complete
```

控制面宕机：

```bash
sudo systemctl stop quantlink-fin-control
# 保持 10 分钟，期间确认 Runner 仍收到 Aeron 行情、能撤单/平仓
sudo systemctl start quantlink-fin-control
sudo systemctl restart quantlink-fin-archive-replay
journalctl -u quantlink-fin-archive-replay --since '-5min'
```

验收：

```text
replay 日志从 consumer checkpoint 开始
宕机期间成交恰好入库一次
Runner 本地持仓不翻倍
```

## 8. CTP Adapter 重启

```text
保留未完成订单，kill -9 CTP Adapter
重启 Adapter
```

验收：

```text
旧订单回报仍带 requestId/strategyKey
撤单使用原 FrontID/SessionID
控制面订单归属不变
account_snapshots 有最新权益，CTP_VENUE 对账通过
```

## 9. 本次新增证据清单

```text
order_id_blocks 分配不重复
aeron_consumer_failures 无 OPEN 行
aeron_consumer_positions 与 replay 起点一致
trades 主键 (account_id,trading_day,trade_id) 生效
positions.long_avg_price/short_avg_price 与 CTP 分方向一致
```

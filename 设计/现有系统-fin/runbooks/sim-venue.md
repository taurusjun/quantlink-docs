# Sim Venue 运行手册

## 组成

```text
quantlink-fin-sim-venue.service
  → /opt/quantlink-fin/sim-venue/bin/sim-venue
  → /etc/quantlink-fin/sim-venue.env
  → /var/lib/quantlink-fin/sim-venue/
```

## 启动 / 停止

```bash
systemctl start quantlink-fin-sim-venue
systemctl stop quantlink-fin-sim-venue
systemctl status quantlink-fin-sim-venue
journalctl -u quantlink-fin-sim-venue -f
```

## 配置

```text
QF_SIM_VENUE_ID
QF_SIM_VENUE_ACCOUNT
QF_SIM_VENUE_CASH
QF_SIM_VENUE_AERON_DIR
QF_SIM_VENUE_STATE_DIR
QF_SIM_VENUE_ORDER_CHANNEL / STREAM
QF_SIM_VENUE_CANCEL_CHANNEL / STREAM
QF_SIM_VENUE_UPDATE_CHANNEL / STREAM
QF_SIM_VENUE_TRADE_CHANNEL / STREAM
QF_SIM_VENUE_MD_CHANNEL / STREAM
```

同机 Phase 1（190 当前实际值）：

```text
channel = aeron:ipc
order/cancel/update/trade = 3140 / 3141 / 3142 / 3143
md = 1001
venueId = SIMVENUE
accountId = SIMVENUE-001
```

独立主机 Phase 2：

```text
order/cancel/update/trade/md channel = aeron:udp?endpoint=<peer>:<port>
```

## 状态恢复

```text
snapshot.json   原子快照
journal.jsonl   状态 journal

启动时选择 sequence 最大的有效状态
```

snapshot v2 会保存净持仓和 today/yesterday 四个持仓桶；加载 v1 旧快照时，
缺失的桶按 today 持仓恢复，兼容升级。

手工恢复：

```bash
ls -l /var/lib/quantlink-fin/sim-venue-simvenue/
# 不要手工编辑 snapshot；损坏时保留文件并联系运维
```

## 验收

```text
1. service active
2. order/update/trade publication 有订阅者
3. 手工单经控制面 route 到 venue
4. OrderUpdate / Trade 回到控制面
5. 重启后 sequence/orders/positions 恢复
```

## 24×7

Sim Venue 是模拟交易所，不受真实交易日历/交易时段限制。

```text
venue_type = SIM
  → Control Plane 跳过日历/时段门禁
  → Runner risk snapshot calendarRequired=false
  → CTP / SimNow / SimShengli 仍走真实日历
```

TIF 说明：

- `DAY` 在 24×7 模拟中不会自动跨日撤销，会保留到成交或撤单。
- `CLOSE_YESTERDAY` 只有在快照或种子数据中存在 yesterday 桶时可用。
- 资金口径是现金账户：开仓扣/加名义本金，平仓回补名义本金并计手续费；
  `equity = cash + 持仓市值`。不是期货保证金账户模型。

Pair Runner 如需在周末运行，需在策略配置中设置：

```text
trading247=true
```

## 注意

```text
- 不要和 SimLocal 使用同一组 stream/channel 同时跑同一账户
- 一个 account 只能有一个 ACTIVE ORS
- health.json 由 SimVenue 每秒更新，Control Plane 通过 system/status 读取
```

## 健康与场所对账

```bash
curl -s -u "$QF_USER:$QF_PASS" \
  http://127.0.0.1:18081/api/v1/system/status | jq '.simVenue'
curl -s -u "$QF_USER:$QF_PASS" \
  http://127.0.0.1:18081/api/v1/reconciliation/venue | jq .
```

`simVenue.sequenceGap` 是 journal 恢复时检测到的序号缺口；`journalLagMs` 同步写入为 0；
`lastEventAgeMs` 空闲时增大是正常的。`available=false` 或 `venueReconciliationPass=false`
时，SimVenue Runner 会拒绝新增风险订单。

## 历史行情回放

服务器已有包含期权的 u50 tick 样本：

```text
/data/u50_data/20260318/source/u50_20260318.csv
```

回放前先启动一个隔离 venue，避免和生产 `SIMVENUE/SIMVENUE-001`、`1001` 混流：

```text
venue:   SIMVENUE-RPL
account: SIMREPLAY-001
md:      1011（测试 replay 预留；禁止 3150 作 MD）
order:   3151
cancel:  3152
update:  3153
trade:   3154
state:   /var/lib/quantlink-fin/sim-venue-replay
```

启动隔离 venue（示例）：

```bash
export JAVA_HOME=/usr/lib/jvm/java-25-openjdk
/opt/quantlink-fin/sim-venue/bin/sim-venue \
  --aeron-dir /var/lib/quantlink-fin/aeron \
  --venue-id SIMVENUE-RPL --account SIMREPLAY-001 \
  --agent-id agent-simvenue-rpl --fencing-token 0 --cash 10000000 \
  --order-stream 3151 --cancel-stream 3152 \
  --update-stream 3153 --trade-stream 3154 \
  --md-channel aeron:ipc --md-stream 1011 \
  --snapshot-file /var/lib/quantlink-fin/sim-venue-replay/snapshot.json \
  --journal-file /var/lib/quantlink-fin/sim-venue-replay/journal.jsonl \
  --health-file /var/lib/quantlink-fin/sim-venue-replay/health.json
```

回放 au2612/ag2612 的 10 秒窗口：

```bash
export JAVA_HOME=/usr/lib/jvm/java-25-openjdk
/opt/quantlink-fin/replay-gateway/bin/replay-gateway \
  --file /data/u50_data/20260318/source/u50_20260318.csv \
  --prefix au2612 --prefix ag2612 \
  --start "2026-03-18 09:00:00" \
  --end "2026-03-18 09:00:10" \
  --limit 5000 \
  --publish --channel aeron:ipc --stream 1011 \
  --aeron-dir /var/lib/quantlink-fin/aeron \
  --speed 10 --sample 3
```

验证：

```bash
cat /var/lib/quantlink-fin/sim-venue-replay/health.json
# marketDataTicks > 0，且 sequence/orders 按回放订单变化
```

注意：

- 账户 ID 受 SBE `AccountSnapshot` 长度限制，使用短 ID，例如 `SIMREPLAY-001`。
- `--speed 0` 表示尽快回放；`1` 为实时；`10` 为 10 倍速。
- 喂给 Pair runner 时加 `--rebase-timestamps`，把 tick 时间改为当前时间，避免 runner 把历史行情判成过期；做历史 IV 计算时不要 rebase。
- 回放后检查 venue health 的 `marketDataTicks`，确认行情确实进入 SimVenue。
- 回放前最好使用独立 state 目录或清空目标 venue 的快照，避免和已有持仓混在一起。
- 生产 `SIMVENUE`（account `SIMVENUE-001`）当前订阅 `md-stream=1001`；不要把回放直接接到生产配置。
- u50 文件按 `LocalTime` 顺序读取，`--end` 到达后停止；时间戳按 `Asia/Shanghai` 解析。

## 受控切换 / 回滚

前提：新旧 deployment 均已创建，且目标账户只有一个 ACTIVE ORS。

```bash
export QF_CONTROL_URL=http://127.0.0.1:18081
export QF_CONTROL_USER=test_admin
export QF_CONTROL_PASSWORD=test

# 旧 owner -> 新 owner
tools/sim-venue/cutover.sh <oldDeploymentId> <newDeploymentId>

# 回滚
tools/sim-venue/rollback.sh <newDeploymentId> <oldDeploymentId>
```

切换前先确认旧策略无未完成订单/持仓，并确认 `reconciliation/venue` 为 0 差异。

# 历史行情回放验收（2026-11-10）

## 数据

```text
/data/u50_data/20260318/source/u50_20260318.csv
```

- u50 tick，43 列，5 档盘口
- 2026-03-17 夜盘 + 2026-03-18 日盘
- 本次 Pair 回放：`au2612` / `ag2612`，09:00-09:05，10x

## Pair 历史 E2E

回放统计：

```text
ReplayStats{total=1167, futures=1167, options=0, malformed=0,
            symbols=2, filtered=12059863}
```

成交：

| client_order_id | 合约 | 方向 | 开平 | 价格 | 数量 | 成交 | 状态 |
|---|---|---|---:|---:|---:|---:|---|
| 1280752202 | ag2612 | S | OPEN | 20056/20043 | 2 | 2 | FILLED（两笔成交） |
| 1280752203 | au2612 | B | OPEN | 1126.42 | 2 | 2 | FILLED |
| 1280752204 | ag2612 | B | CLOSE | 20107 | 2 | 1 | REJECTED（剩余 1 手撤销） |
| 1280752205 | au2612 | S | CLOSE | 1126.08 | 2 | 1 | REJECTED（剩余 1 手撤销） |
| 1280752384 | ag2612 | B | CLOSE | 20037 | 1 | 1 | FILLED |
| 900000000033 | au2612 | S | CLOSE_TODAY | 1125.36 | 1 | 1 | FILLED（清理平仓） |

结果：

```text
Pair open:  ag 卖 2 + au 买 2，双腿 FILLED
Pair close: ag 买 1 + au 卖 1（策略平仓）
Drain/清理: ag 买 1 + au 卖 1，venue 最终 ag/au 均 flat
```

- SimVenue snapshot：`ag2612 netQty=0`、`au2612 netQty=0`
- 控制面 `positions` / `strategy_positions`：ag/au 均 0
- `pair_state.pairPosition=0`
- Pair 未完成订单：0
- 60 分钟内 au/ag 成交 7 笔，`strategy_id` 全部为 `PAIR-SIMVENUE-MW9C01BR`，未归属成交 0
- `reconciliation/venue`：`simVenue.passed=true`，差异 0
- `strategy-runtime/risk`：`localReconciliationPass=true`、`accountReconciliationPass=true`、`reconciliationPass=true`

说明：策略 drain 的平仓单在部分成交后剩余 1 手被撤销；最后 1 手 au 通过手工清理单在 venue 成交，并按 Pair 归因补记，保证 venue/本地账本对账一致。

### 剩余缺口

- 这批订单/成交行的 `deployment_id`、`route_id`、`fencing_token` 仍为 `0/null`，说明控制面按 OrderRequest 落库的字段链路未完全生效；策略成交本身和持仓归属已验证，但该字段验收未通过。
- 部分 Pair drain 平仓单的状态是 `REJECTED` 但 `filled_qty=1`，状态语义需要收敛。

## IV Rank / 25Δ 历史数据

来源：上期所 2026 年期权年度数据包中的月度 XLSX，使用 `au2612` 期权日线、结算价优先、无风险利率 2%、到期月月末。

写入 `indicator_daily_history`：

```text
iv_atm_au   20 行，2026-09-28 ~ 2026-10-30
iv_rank_au  20 行，2026-09-28 ~ 2026-10-30
rr25_au     20 行，2026-09-28 ~ 2026-10-30
source = SHFE_OPTION_DAILY
```

明细见：[iv_rank_25d_history_20261110.csv](iv_rank_25d_history_20261110.csv)

指标引擎实测（用 2026-10-30 au2612 全期权链快照喂入）：

```text
iv_atm_au = 16.633419 %   status=OK
iv_rank_au = 35.000000    status=OK  message=samples=20
rr25_au = 0.023727 vol pt status=OK
```

对照 Python 独立计算（2026-10-30、按 2026-10-30 估值日）：

```text
ATM IV = 15.089190 %
25Δ RR = 0.030440 vol pt
call delta = 0.230046, put delta = -0.273272
```

差异来源：指标引擎用当前 2026-11-10 作为估值日计算到期时间，Python 报告按 2026-10-30 估值日；方向和量级一致，且 `iv_rank=35` 对应 20 个历史样本中 7 个小于等于当前 IV。

### 修复的代码问题

- `au2612` 的 `YYMM` 到期被解析成公元 26 年，导致到期时间只剩 1 天、IV 被放大到 118%；现已统一为 `20YY`。
- `IndicatorEngine` 的期权到期时间改为使用 tick 时间戳，而不是只使用 `LocalDate.now()`。
- `OptionChainController` 和 `AeronOrderGateway` 的到期月解析同步修正。

## 最新字段复验（P0-05 后）

用最新 runner/SimVenue 代码再回放 10 秒：

```text
订单 deployment_id=25
deployment_generation=1
route_id=ors-simvenue-001
fencing_token=0（当前 route 配置即为 0）
order_epoch=0
```

因此**订单侧字段链路已通过**。成交行仍显示 `deployment_id=null / route_id=null`；已补 `AeronOrderMapper.insertTradeIfAbsent` 从订单透传这些字段，但本次回放发生在补丁部署前，成交侧尚未重跑验证。

另修复 Pair runner 不发布 Agent PnL 导致最新 P0-03 gate 拒绝所有开仓的问题：Pair 路径现在每秒发布 flat/持仓 PnL 快照。

## 验收后状态说明

- 验收完成后已恢复 `quantlink-fin-sim-feed`；当前 `indicator_values` 的最新值会随 live feed 变化，可能显示 IV 44 / IV Rank 100 / RR `NO_QUOTE`（当前 SimVenue 只有 C920/P900 两个期权报价）。历史快照验收值以本文件上方记录为准，`indicator_daily_history` 的 20 行样本不受影响。
- 最新 HEAD 已包含 P0-05 的 deployment/route/fencing 字段透传修复，但本文件列出的 Pair 订单来自该修复部署前的一次回放，字段仍为 0/null；字段链路尚未在本轮重新跑一次订单验证。

## 复现命令

```bash
# Pair 回放（3150 或 1001，按隔离方式配置）
/opt/quantlink-fin/replay-gateway/bin/replay-gateway \
  --file /data/u50_data/20260318/source/u50_20260318.csv \
  --symbol au2612 --symbol ag2612 \
  --start "2026-03-18 09:00:00" --end "2026-03-18 09:05:00" \
  --publish --channel aeron:ipc --stream 1001 \
  --aeron-dir /var/lib/quantlink-fin/aeron \
  --speed 10 --rebase-timestamps

# 指标历史写入
psql ... -f /tmp/iv_history_insert.sql

# 查询指标
select indicator_id, value, status, message
from indicator_values
where indicator_id in ('iv_atm_au','iv_rank_au','rr25_au')
order by ts desc limit 3;
```

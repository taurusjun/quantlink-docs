# T-026 影子库 reset/seed/verify 证据

执行日期：2026-11-08

## 命令

```bash
export PGPASSWORD=quantlink
QF_PG_DB=quantlink_reset_test_shadow QF_PG_HOST=127.0.0.1 QF_PG_USER=quantlink \
  bash tools/db/reset-shadow.sh
QF_PG_DB=quantlink_reset_test_shadow QF_PG_HOST=127.0.0.1 QF_PG_USER=quantlink \
  bash tools/db/reset-shadow.sh
QF_PG_DB=quantlink_reset_test_shadow QF_PG_HOST=127.0.0.1 QF_PG_USER=quantlink \
  bash tools/db/verify-shadow.sh
```

## 结果

```text
reset1=0
reset2=0

users       4
accounts    2
instruments 7
strategies  3
orders      4
positions   2
audit_log   1

instrument_id   pos_net  trade_net
au2612             -1       -1
au2612C920          2        2
filled_without_trade = 0
```

影子库种子已与成交一致，可直接开启 `QF_RECON_GATE_ENABLED=true`。

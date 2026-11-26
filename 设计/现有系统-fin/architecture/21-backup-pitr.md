# 备份与 PITR

## 逻辑备份

```bash
PGHOST=127.0.0.1 PGDATABASE=quantlink_fin_shadow tools/db/backup.sh
```

默认写到 `/var/backups/quantlink-fin`，保留 14 天。恢复：

```bash
pg_restore -h 127.0.0.1 -U quantlink -d quantlink_fin_shadow \
  /var/backups/quantlink-fin/quantlink_fin_shadow-<stamp>.dump
```

## PITR

PostgreSQL 开启：

```text
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /var/lib/postgresql/wal-archive/%f && cp %p /var/lib/postgresql/wal-archive/%f'
```

定期做 basebackup，并保留 `wal-archive`。恢复时：

```text
restore basebackup
restore_command = 'cp /var/lib/postgresql/wal-archive/%f %p'
recovery_target_time = '<timestamp>'
```

## RTO/RPO 目标

```text
RPO <= 5 分钟（WAL 归档）
RTO <= 30 分钟（单机恢复）
```

控制面/DB 主备和多主机 Aeron 属于 P2，当前环境没有第二台主机，状态 BLOCKED。

## 保留

`tools/db/retention.sql` 提供保守保留窗口：

```text
orders/trades 365 天
audit/ledger  730 天
alerts         90 天
```

生产规模化前应按 `trading_day` 分区，再缩短分区删除窗口。

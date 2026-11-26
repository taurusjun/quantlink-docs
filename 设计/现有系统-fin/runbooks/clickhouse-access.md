# ClickHouse 访问规范

- **不要**把 8123/9000 暴露到公网。
- 190 当前只监听 `127.0.0.1:8123`，这是正确配置。
- 控制面如果部署在 190：直接用 `127.0.0.1:8123`。
- 控制面如果在本地 mac：用 SSH 隧道：

```bash
bash tools/db/tunnel-clickhouse.sh
# 本地 18123 -> 190 127.0.0.1:8123

QF_CLICKHOUSE_HOST=127.0.0.1 \
QF_CLICKHOUSE_PORT=18123 \
QF_CLICKHOUSE_DB=quantlink_fin \
./gradlew :backend:control-plane:bootRun
```

- 多机生产：走内网/VPN，或每台机器本地 tunnel；不要改 `listen_host` 为 `0.0.0.0`。
- 如需临时排查：`ssh -L 18123:127.0.0.1:8123 root@101.43.54.190`。

结论：**不需要暴露 ClickHouse**。

# T-014 配置与一键部署 — 阶段证据

- 状态：DOING
- 已完成：deployments 表、GET/POST `/api/v1/deployments`、影子库写入、审计
- 未完成：策略/指标配置 CRUD、Runtime 实际部署/回滚、Web 页面

验证：

```bash
curl -u test_admin:test -H 'Content-Type: application/json' \
  -d '{"strategyId":"TEST-STRAT-OPT-01","version":"v0.1.1","target":"sim-1","mode":"SHADOW"}' \
  http://127.0.0.1:18081/api/v1/deployments
# {"strategyId":"TEST-STRAT-OPT-01","id":4,"status":"SHADOW"}
```

## Runtime 状态（2026-11-06 补）

- `runtime_instances` 表：instance_id / strategy_id / actual_version / status / pid / last_heartbeat
- `GET /api/v1/runtime/instances`
- `POST /api/v1/runtime/instances/{id}/heartbeat`
- 控制面只写配置/状态，不直接控制进程；Runtime 控制方案见 `docs/architecture/10-Runtime控制设计.md`

验证：

```json
[{"instance_id":"sim-1-au-opt","strategy_id":"TEST-STRAT-OPT-01","actual_version":"v0.1.0","status":"UP","pid":41001}]
```

心跳后 `actual_version` 更新为 `v0.1.1`、`pid` 更新为 `42001`。

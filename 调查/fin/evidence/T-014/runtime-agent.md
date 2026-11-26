# Runtime Agent 验证证据

- 日期：2026-11-06
- 模块：`backend/runtime-agent`
- 测试：`./gradlew :backend:runtime-agent:test` -> 3 passed

## 能力

- 读取 properties 实例配置
- 进程 start/stop/reload
- 日志追加到 `agent-logs/<id>.log`
- HTTP API（默认 127.0.0.1:19100）
  - `GET /health`
  - `GET /instances`
  - `POST /instances/{id}/start`
  - `POST /instances/{id}/stop`
  - `POST /instances/{id}/reload`
- 可选 `X-Agent-Token`
- 向控制面 `/api/v1/runtime/instances/{id}/heartbeat` 上报

## 启动

```bash
./tools/run_runtime_agent.sh --config backend/runtime-agent/runtime-agent.properties.example
```

## systemd

`deploy/quantlink-fin-runtime-agent.service`

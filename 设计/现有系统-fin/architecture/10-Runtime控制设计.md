# Runtime 控制设计建议

- 日期：2026-11-06
- 结论：**控制面只写“期望状态”，不直接 SSH/杀进程；由本机 runtime-agent 收敛到期望状态。**

---

## 1. 为什么不建议控制面直接控制进程

- Spring Boot 进程没有权限/职责去 `kill` 交易进程；一旦控制面重启或网络抖动，容易误杀。
- 直接 SSH 执行命令不可审计、不可回滚、难做并发保护。
- 交易 Runtime 需要低延迟、独立 JVM、独立 GC；不能塞进控制面。
- 进程崩溃后必须由 systemd 拉起，而不是靠控制面轮询再启动。

---

## 2. 推荐架构

```text
Control Plane (Spring Boot)
   │  写 desired_state / deployment 记录
   ▼
PostgreSQL (desired + actual + generation)
   ▲
   │  runtime-agent 轮询/订阅
Runtime Agent (本机 systemd 服务)
   │  校验配置、生成版本、start/stop/reload
   ▼
Runtime JVM (交易进程，systemd 管理)
```

### 关键原则

1. **期望状态 vs 实际状态**
   - `runtime_deployments`: strategy_id, desired_version, config_hash, generation, status。
   - `runtime_instances`: instance_id, actual_version, pid, started_at, health, last_heartbeat。
2. **幂等收敛**
   - agent 每 1s 比较 desired/actual；只有 generation 变化才动作。
   - 重复部署同一版本是 no-op。
3. **配置版本化**
   - 每次部署生成不可变 `config_version`（hash）。
   - Runtime 启动时加载指定版本；失败自动回退到上一稳定版本。
4. **健康与心跳**
   - Runtime 写 `GatewayHealth` / heartbeat 到 DB 或 Aeron。
   - agent 超过 N 秒无心跳则重启并告警。
5. **灰度/回滚**
   - 先 `SHADOW`（只读/不下单）→ `CANARY`（小额度）→ `ACTIVE`。
   - 回滚 = 把 desired_version 指回上一版本，agent 重新加载。
6. **权限**
   - agent 只监听 `127.0.0.1`，mTLS 或本机 Unix socket。
   - 控制面不能传任意 shell 命令，只能传结构化部署意图。

---

## 3. MVP 落地顺序

1. 先做 **配置/状态**（当前 T-014 范围）：控制面写 `deployments`，Runtime 读取配置并 ack。
2. 加 `runtime-agent`：
   - systemd unit `quantlink-fin-runtime@.service`
   - 读取 `/etc/quantlink-fin/runtime/<instance>.json`
   - `start/stop/reload/status`
3. 控制面加 `desired_state` 与 `actual_state` 对比页面。
4. 最后才做自动灰度/自动回滚。

---

## 4. 当前实现边界

- T-014 现在只做：策略 CRUD、部署记录、状态、审计。
- 不直接把 Runtime 进程控制塞进控制面。
- 后续新增 `runtime-agent` 作为独立任务，避免权限和稳定性风险。

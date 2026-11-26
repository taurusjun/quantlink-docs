# 项目状态

- 日期：2026-11-06
- 当前阶段：**P0 PASS；M1 Runtime / 管理面 / 模拟 CTP 已打通；实盘 CTP 待交易时段**
- 代码基线：`main`

---

## 1. 已完成 / 可运行

### P0（PASS）

- SBE Java/C++、Aeron 100k 双向、p99≈3µs
- 全天 u50 25,664,907 行统计
- Replay → Synthetic → Aeron → SimExchange 端到端
- 影子库 reset/seed/verify

报告：`docs/validation/P0-报告.md`

### M1 Runtime

- RuntimeEngine / RuntimeAeronService
- 期权定价、IV、Greeks、Portfolio
- OptionQuoting / SimpleHedging
- RiskEngine / OrderManager
- 13 tests

### ORS Core（模拟）

- InstrumentRegistry：期货/期权/期权链
- 多交易所 Adapter 路由（SHFE/CFFEX）
- AccountLedger：现金/保证金/手续费/持仓/PnL
- OrsAeronGateway：MD + OrderRequest → OrderUpdate/Trade
- 5 tests
- 100k 路由 ≈ 1.0M orders/s（本地内存）

### CTP Adapter（模拟）

- 复用 quantlink-trading `ors_server.cfg` 键
- 配置解析 + 秘钥脱敏
- 登录/订阅/下单/撤单/资金/持仓模拟
- `tools/run_ctp_sim.sh`

### 管理面

- Spring Boot 4.1.2 + Java 25
- Basic Auth + RBAC
- instruments/accounts/positions/orders/strategies/audit
- 策略 CRUD、部署、手工单、可选 Aeron 桥
- Telemetry WebSocket `/ws/telemetry` + 阈值告警
- 52 个后端测试通过（1 个 ClickHouse 集成测试默认跳过）
- CTP 实盘代码已在 190 用 CTP SDK 编译通过（非交易时间未登录）

### 数据/监控

- 190 ClickHouse 26.10.3.7
- 7 张表，TTL 366 天
- Java ClickHouse HTTP sink
- ClickHouse 真实写入已验证（7 张表）
- Runtime 异步遥测上报
- 更新服务器 190:8443 已开放，外部可访问
- SQLite 离线缓存 + 断线禁单

### Web / Electron

- React + MUI：登录、驾驶舱、期权链、订单、手工交易、策略、监控
- 真实 API + mock 回退
- 14 个 Playwright 视觉基线
- Electron：单实例、多窗口、托盘、快捷键、窗口状态、通知
- 更新检查（`QF_UPDATE_URL`）+ 发布脚本

---

## 2. 进行中

| 任务 | 状态 | 已完成 | 未完成 |
|---|---|---|---|
| T-014 配置/部署 | DONE | 策略 CRUD、部署 API、审计、runtime_instances 心跳 | 进程启停由后续 runtime-agent 做 |
| T-015 Telemetry | DONE | CH 表、SDK、WS、告警、Runtime 上报 | 监控页曲线可增强 |
| T-016 手工交易 | DOING | API、审计、RBAC、Aeron 桥 | 经 Runtime 风控、Web 页面、全撤/平仓 |
| T-018 驾驶舱 | DONE | 持仓/订单 API、ECharts 波动率图、CTP 行情 ticker | 期权链真实期权 tick 待接 |
| T-019 管理页 | DONE | 策略/部署/监控/手工/审计 | 编辑/回滚可增强 |
| T-020 CTP Adapter | DONE | SimNow 登录/MD/报单/成交/撤单/持仓；222 前置当前不可用 | 盛立正式前置恢复后复测 |
| T-022 对账 | BLOCKED | 本地一致性门禁、对账 API | 场所级对账待 CTP 交易时段 |
| T-023 Electron | DONE | 启动、多窗口、托盘/快捷键、通知、布局恢复、截图 | — |
| T-024 更新服务器 | DONE | 发布/回滚/迁移、离线只读、断线下单禁止 | — |
| T-025 性能/稳定性 | BLOCKED | p99≈3.04µs、回滚演练 | 5 个交易日长稳、试点、场所对账 |
| T-027 模拟交易所 | DOING | 20 条验收；SIM 场所；策略 CANARY；LocalCTP 对照 | C++ sim 经 CTP Adapter 接管理面 |

---

## 3. 阻塞/需要确认

1. **CTP 实盘联调**：非交易时间无法登录；需交易时段用现有 `ors_server.cfg` 验证。
2. **CTP Adapter Aeron/SBE**：SPI 已编译，Aeron 桥接待接。
3. **打包/签名**：测试阶段手动放行；正式签名后续。
4. **ClickHouse 不暴露**：保持 190 `127.0.0.1:8123`；本地用 SSH 隧道，见 `docs/runbooks/clickhouse-access.md`。

---

## 4. Runtime 控制建议

见 `docs/architecture/10-Runtime控制设计.md`：控制面只写期望状态，由本机 `runtime-agent` 收敛，不在 Spring Boot 里直接杀进程。

## 4.1 实时链路现状

```text
CTP tick → ctp_tick_bridge.py → /api/v1/market/ticks
  → /ws/market → ticker / 期权链现价
  → IndicatorEngine → spread_au / fut_ema_au → /ws/market
  → StrategySignalService → WIDE_SPREAD_QUOTE / FLAT → 策略页
```

仍未接：IV/IV Rank/25Δ RR 等真实期权指标、策略实际报单、Runtime 持仓/PNL/Greeks 重算。

## 5. 下一步

1. 交易时段：CTP 登录/行情/1 手报撤/查询
2. CTP Adapter 接入 Aeron+SBE
3. T-014/T-016 Web 表单与 Runtime 闭环
4. T-023 Electron 打包 + 桌面截图
5. T-024 云安全组放行 + electron-updater
6. T-025 长稳/全天回放/试点
7. T-027 模拟交易所（见 `docs/architecture/12-模拟交易所.md`）

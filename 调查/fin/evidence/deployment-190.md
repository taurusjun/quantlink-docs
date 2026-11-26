# 190 部署

- 日期：2026-11-06
- 状态：PASS

## 地址

- Web/API：`https://101.43.54.190:8443/`
- 健康：`https://101.43.54.190:8443/api/v1/health`
- 更新：`https://101.43.54.190:8443/latest.json`

## 进程

- systemd：`quantlink-fin-control.service`
- Java：`/usr/lib/jvm/java-25-openjdk/bin/java`
- 控制面：`127.0.0.1:18081`
- 前端：`/opt/quantlink-fin/web`
- 数据库：PostgreSQL 16 `quantlink_fin_shadow`（用户 `quantlink`）
- nginx：8443 静态 + `/api` `/ws` 反代；`/latest.json` `/releases/` 保留更新服务

## 配置

- `/etc/quantlink-fin/control.env`
- `/etc/systemd/system/quantlink-fin-control.service`
- `/etc/nginx/conf.d/quantlink-fin-update.conf`

## 验证

```bash
curl -sk https://101.43.54.190:8443/api/v1/health
# {"service":"quantlink-fin-control-plane","status":"UP"}

curl -sk https://101.43.54.190:8443/latest.json
# {"version":"0.1.0",...}
```

前端已用 Playwright 对 190 截图验证，驾驶舱显示 API 数据。

## 注意

- 本机不再作为部署环境；本机仅用于构建/测试。
- 8443 同时承载 Web、API、WebSocket 和更新文件。
- `/api` 与 `/ws` 只反代到 18081，不暴露控制面端口。

## CTP venue

- `quantlink-fin-ors-gateway.service`
  - embedded Aeron dir `/var/lib/quantlink-fin/aeron`
  - SimExchangeAdapter, au2612/ag2612
- 控制面 `QF_AERON_ENABLED=true`
- `/api/v1/exchanges` CTP=enabled
- 历史临时 gateway 验证已废弃，不计入架构验收

## 1h sim feed

- `quantlink-fin-sim-feed.service`
- `/opt/quantlink-fin/sim/qf-sim-long --seconds 3600 --emit-ticks`
- 通过 `/opt/quantlink-fin/tools/ctp_tick_bridge.py` 写入 `127.0.0.1:18081/api/v1/market/ticks`
- 管理面 `/api/v1/market/ticks` source=external
- 服务重启后继续下一轮 1h

## 执行场所（修正）

- `SIM`：进程内 SimExchange，开发测试可用
- `CTP`：真实 CTP Adapter 尚未接入管理面，当前 disabled
- `quantlink-fin-ors-gateway.service`：**临时测试 harness，不是设计中的交易场所**，已停止/禁用

原设计只有：CTP Adapter（真实/模拟模式）→ ORS Core。管理面不应出现 `ORS-SIM` 这种额外场所。

## 三个测试场所（最终命名）

- `SimLocal`：进程内模拟交易所，仅开发测试
- `SimNow`：C++ CTP Adapter → SimNow 测试柜台
- `SimShengli`：盛立模拟环境，前置未配置时 disabled

不接真实交易所；真实交易所不在当前系统范围内。

## CTP 实链路

- `quantlink-fin-aeron-driver.service`：Aeron media driver
- `quantlink-fin-ctp-adapter.service`：C++ CTP Adapter，订阅 Aeron OrderRequest，调用 CTP API
- Control plane CTP venue：Aeron OrderRequest → CTP Adapter → SimNow
- CTP 回调 → Aeron OrderUpdate/Trade → 控制面 DB

验证：`900000168 SIMNOW FILLED`，持仓更新。

## 2026-11-06 追加

- 顶部品牌在窄窗口被压缩换行的问题已修复：`quantlink-fin` 强制单行，窄屏隐藏行情/路径等次要控件。
- SimShengli 前置沿用已有配置（`222.71.253.5:34205/34213`），夜盘前置关闭，因此界面显示“仅日盘可用（夜盘前置关闭）”。
- CTP 回报消费增加异常隔离；成交写入增加幂等判断，Aeron 重放不会重复加仓。

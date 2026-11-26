# T-024 更新服务器 — 阶段证据

- 日期：2026-11-06
- 状态：DOING（离线缓存/更新服务/迁移脚本 PASS；自动下载安装待做）

## 190 上已完成

- `/opt/quantlink-fin/updates/{releases,web}`
- 自签证书 `/etc/pki/tls/certs/quantlink-fin-update.crt`
- nginx `quantlink-fin-update.conf`，监听 8443 ssl
- `firewall-cmd` 已放行 8443
- 本机验证：`curl -k https://127.0.0.1:8443/health` -> `{"status":"UP",...}`

## 外部访问

- 2026-11-06 云安全组已放行 8443
- `curl -k https://101.43.54.190:8443/health` -> UP
- `curl -k https://101.43.54.190:8443/latest.json` -> 0.1.0

## 发布验证

```bash
bash tools/update-server/publish.sh 0.1.0 /tmp/quantlink-fin-0.1.0.txt
```

190 `latest.json` 与 `https://127.0.0.1:8443/latest.json` 均返回：

```json
{"version":"0.1.0","file":"releases/quantlink-fin-0.1.0.txt",...}
```

## 客户端

- Electron `update.ts` 读取 `latest.json`，比较版本
- 发现新版本后自动下载、SHA256 校验、弹窗打开安装包
- `QF_UPDATE_URL` 可覆盖默认地址

## 离线缓存

- Electron `offline.ts` 使用 `node:sqlite`
- 页面通过 `apiGetOrCache` 在 API 失败时读缓存
- `navigator.onLine === false` 时手工下单禁用

## 脚本

- `tools/update-server/install.sh`
- `tools/update-server/publish.sh`
- `tools/update-server/migrate.sh`
- `tools/update-server/publish-electron.sh`

## 回滚

```bash
bash tools/update-server/rollback.sh 0.1.0
```

`publish.sh` 会把每次发布写入 `history/<version>.json`，rollback 只切换 `latest.json`，不重传安装包。

- 离线只读/禁止下单/更新回滚：见 `offline-smoke.md`、`update-rollback.md`

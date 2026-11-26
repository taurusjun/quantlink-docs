# T-024 更新服务器发布/回滚/迁移证据

执行日期：2026-11-08

## 1. 更新服务器健康

```text
GET https://101.43.54.190:8443/health
{"status":"UP","service":"quantlink-fin-update"}
```

## 2. 发布 0.1.1

```bash
bash tools/update-server/publish.sh 0.1.1 /tmp/qf-update-0.1.1.txt
```

latest.json：

```json
{
  "version": "0.1.1",
  "file": "releases/qf-update-0.1.1.txt",
  "sha256": "4de22582e4ef5e551aaa4864310ebc6649182c5bbf4dfa45f0651f617674a041"
}
```

## 3. 回滚 0.1.0

```bash
bash tools/update-server/rollback.sh 0.1.0
# rolled back latest.json -> 0.1.0
```

回滚后 latest.json 恢复为 `0.1.0`，SHA256 与发布前一致。

## 4. 迁移脚本

```bash
bash tools/update-server/migrate.sh 101.43.54.190
```

脚本成功检查 `/health` 与 `/latest.json`，并输出客户端迁移变量：

```text
QF_UPDATE_URL=https://<new-host>:8443/latest.json
```

## 5. 客户端构建/类型检查

```text
pnpm --filter @quantlink-fin/web build      PASS
pnpm --filter @quantlink-fin/desktop typecheck PASS
```

离线缓存代码、断线禁止下单代码已存在；Electron e2e 需要可用的 Electron 二进制和桌面显示环境，当前环境无法下载/启动 Electron。

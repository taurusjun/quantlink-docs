# T-024 离线只读与更新回滚验收证据

执行日期：2026-11-08
应用：`desktop/release/mac-arm64/quantlink-fin.app`

## 离线缓存

```text
offlineStatus = {"available":true,"rows":116}
offlineSave('smoke', [...]) = true
offlineLoad('smoke') = [{"id":"one","value":1}]
```

## 断线禁止下单

Playwright Electron：

```text
page.context().setOffline(true)
navigator.onLine = false
manual-submit disabled = true
页面包含“离线只读：恢复网络后才能下单。”
```

截图：`docs/evidence/T-024/offline-manual.png`

## 更新服务器

见 `docs/evidence/T-024/update-rollback.md`：

```text
health = UP
publish 0.1.1 = OK
rollback 0.1.0 = OK
migrate.sh = OK
```

## 客户端构建

```text
pnpm --filter @quantlink-fin/web build      PASS
pnpm --filter @quantlink-fin/desktop typecheck PASS
```

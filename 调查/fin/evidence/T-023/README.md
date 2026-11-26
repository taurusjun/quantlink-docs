# T-023 Electron Desktop Shell — 阶段证据

- 状态：DONE（见 desktop-smoke.md 与截图）
- 单实例锁
- 主窗口 + 监控窗口 + 期权链/订单窗口
- 窗口位置/大小持久化
- 托盘菜单
- 全局快捷键 Ctrl/Cmd+Shift+Q（显示/隐藏）、Ctrl/Cmd+Shift+M（监控）
- 系统通知 + beep
- contextIsolation + sandbox + preload 白名单
- 更新检查：`QF_UPDATE_URL`，默认 190:8443/latest.json

```bash
cd desktop && pnpm typecheck
```

## 打包

```bash
cd desktop
./node_modules/.bin/tsc -p electron/tsconfig.json
electron-builder --dir
```

产物：`desktop/release/mac-arm64/quantlink-fin.app`（269MB，未签名）。

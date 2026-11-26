# T-017 Web UI 基础 — 验证证据

- 日期：2026-11-06
- 状态：PASS
- 16 个 Playwright 视觉基线通过（1920x1080 / 1440x900）
- 登录页支持控制面 Basic Auth，失败可「离线演示」
- 侧栏/顶栏/MUI 主题/账户信息

```bash
pnpm --filter @quantlink-fin/web build
pnpm exec playwright test
```

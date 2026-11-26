# T-023 macOS Electron 启动冒烟

- 日期：2026-11-07
- 产物：`desktop/release/mac-arm64/quantlink-fin.app`
- 启动方式：Playwright Electron

## 结果

```text
Electron 启动成功
主窗口 URL: https://101.43.54.190:8443/login
登录 test_admin 成功
进入交易驾驶舱
```

说明：

- 190 使用自签名证书，测试启动时传 `--ignore-certificate-errors`
- 打包产物当前未签名
- 已修复打包后 `web/dist/index.html` 路径错误：应为 `web/index.html`
- 打包模式默认加载 `https://101.43.54.190:8443`，可通过 `QF_WEB_URL` 覆盖

## 截图

- `macos-login.png`
- `macos-dashboard.png`

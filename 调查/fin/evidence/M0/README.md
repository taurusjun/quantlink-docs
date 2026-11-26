# M0 验证证据

- 日期：2026-11-06
- 范围：文档、工程骨架、MUI Web 骨架、视觉基线
- 环境：macOS arm64 / Node 22 / pnpm 10

## 1. 文档与结构

```bash
bash tools/verify_m0.sh
```

结果：

```
[OK] docs link check
[OK] README exists
...
M0 verification OK
```

## 2. Web 构建

```bash
pnpm --filter @quantlink-fin/web build
```

结果：Vite build 成功，产出 `web/dist/`。

## 3. 视觉基线

```bash
pnpm visual:update   # 首次生成
pnpm visual:test     # 回归
```

结果：12 passed。

基线：

| 页面 | 1920x1080 | 1440x900 |
|---|---|---|
| 登录 | `tests/visual/baselines/web-dark-1920x1080/login.png` | `tests/visual/baselines/web-dark-1440x900/login.png` |
| 交易驾驶舱 | `tests/visual/baselines/web-dark-1920x1080/dashboard.png` | `tests/visual/baselines/web-dark-1440x900/dashboard.png` |
| 期权链 | `tests/visual/baselines/web-dark-1920x1080/option-chain.png` | `tests/visual/baselines/web-dark-1440x900/option-chain.png` |
| 订单/成交 | `tests/visual/baselines/web-dark-1920x1080/orders.png` | `tests/visual/baselines/web-dark-1440x900/orders.png` |
| 策略配置 | `tests/visual/baselines/web-dark-1920x1080/strategies.png` | `tests/visual/baselines/web-dark-1440x900/strategies.png` |
| 系统监控 | `tests/visual/baselines/web-dark-1920x1080/monitoring.png` | `tests/visual/baselines/web-dark-1440x900/monitoring.png` |

## 4. 说明

- 当前页面是 **M0 mock 数据骨架**，不是 P0 技术验证结果
- 视觉基线用于后续 T-017/T-018/T-019 的回归
- 数据、时间戳固定为 2026-11-06 09:30:00 / SIM

## 5. 后端构建

JDK 25 与 Gradle 通过 `tools/install_toolchain.sh` 安装到 `.tools/`：

```bash
source .tools/env.sh
./gradlew build
```

结果：`BUILD SUCCESSFUL`。

## 6. 未完成

- P0 技术验证（T-002/T-003/T-005/T-006/T-007）尚未开始
- 当前 Web 仍是 mock 数据骨架

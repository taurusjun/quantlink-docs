# T-017 Web UI 基础（React/MUI）

- 状态：DONE
- 阶段：M3
- 依赖：T-013
- 负责人：AI

## 1. 目标

建立 React + MUI Web 基础：登录、布局、导航、主题、API SDK、WebSocket。

## 2. 范围

### 做

- Vite/React/TS
- MUI 主题
- 登录页
- 主布局/侧栏
- API client
- WebSocket
- 路由

### 不做

- 不做交易页面

## 3. 交付物

- web 应用
- packages/ui
- packages/api-client
- 截图基线

## 4. 设计要点

MUI Core + X Community；暗色交易主题；响应式；data-testid。

## 5. 验收标准

- [x] 登录/退出
- [x] 导航可用
- [x] 1366/1440/1920 无溢出
- [x] 深色/浅色通过截图

## 6. 测试用例

| 用例 ID | 类型 | 场景 | 步骤 | 期望结果 | 测试数据 |
|---|---|---|---|---|---|
| TC-T017-01 | e2e | 登录 | 正确账号 | 进入首页 | 影子库 |
| TC-T017-02 | visual | 登录页截图 | 1920 dark | 与基线一致 | 固定数据 |
| TC-T017-03 | visual | 主布局截图 | 1440 light | 与基线一致 | 固定数据 |
| TC-T017-04 | e2e | 响应式 | 1366 视口 | 无横向滚动 | 固定数据 |

## 7. 可视化验证

登录/布局/导航截图（Web）。

## 8. 风险

MUI 主题差异；截图不稳定。

## 9. DoD

- [x] 代码/文档已提交
- [x] 已 commit 并 push 到 origin
- [x] 测试用例全部通过
- [x] 可视化证据已归档
- [x] 任务状态更新为 DONE
- [x] 里程碑验收清单已更新

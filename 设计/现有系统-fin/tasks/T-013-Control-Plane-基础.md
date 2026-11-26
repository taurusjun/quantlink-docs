# T-013 Control Plane 基础

- 状态：DONE
- 阶段：M3
- 依赖：T-001
- 负责人：AI

## 1. 目标

建立 Spring Boot 管理面：本地账号、RBAC、PostgreSQL、Flyway、审计基础。

## 2. 范围

### 做

- 用户/角色/权限
- 登录/JWT/会话
- Flyway migration
- 审计表
- OpenAPI

### 不做

- 不做业务页面

## 3. 交付物

- control-plane 模块
- migration
- API 文档
- 测试

## 4. 设计要点

Argon2id/bcrypt；RBAC；审计切面；test/prod profile。

## 5. 验收标准

- [x] 登录成功/失败
- [x] 角色权限拒绝
- [x] migration 可重复
- [x] 审计记录写入

## 6. 测试用例

| 用例 ID | 类型 | 场景 | 步骤 | 期望结果 | 测试数据 |
|---|---|---|---|---|---|
| TC-T013-01 | integration | 登录成功 | 正确用户名/密码 | 返回 token | 影子库用户 |
| TC-T013-02 | integration | 登录失败 | 错误密码 | 401 且审计 | 影子库用户 |
| TC-T013-03 | integration | RBAC | 只读用户调用写接口 | 403 | 角色配置 |
| TC-T013-04 | integration | Flyway | 空库启动 | 表结构创建成功 | 影子库 |

## 7. 可视化验证

OpenAPI/Swagger 截图、审计表截图。

## 8. 风险

密码安全；权限遗漏。

## 9. DoD

- [x] 代码/文档已提交
- [x] 已 commit 并 push 到 origin
- [x] 测试用例全部通过
- [x] 可视化证据已归档
- [x] 任务状态更新为 DONE
- [x] 里程碑验收清单已更新

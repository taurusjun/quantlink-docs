# T-013 Control Plane 基础 — 验证证据

- 日期：2026-11-06
- 状态：PASS
- 任务：T-013

## 启动

```bash
source .tools/env.sh
./gradlew :backend:control-plane:bootRun --args='--server.port=18081'
```

## 验证

```bash
curl -s http://127.0.0.1:18081/api/v1/health
# {"status":"UP", ...}

curl -s -u test_admin:test http://127.0.0.1:18081/api/v1/instruments
# 返回影子库 7 个合约

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18081/api/v1/instruments
# 401
```

## 覆盖

- Spring Boot 4.1.2 + Java 25
- 本地账号 + Basic Auth + RBAC
- PostgreSQL 影子库查询：instruments/accounts/positions/orders/strategies/audit
- CORS 允许 5173/4173
- `/api/v1/health` 公开，其余需认证


## 2026-11-06 更新：数据库用户 + BCrypt

- 去掉内存账号
- `UserDetailsService` 查 `users` 表
- `BCryptPasswordEncoder` 校验
- `test_admin/test` 200，`test_viewer/test` GET 200 / POST 403，错误密码 401

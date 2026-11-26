# T-004 配置、密钥与环境管理证据

执行日期：2026-11-08

## 单元测试

```bash
./gradlew :backend:shared:config:test
```

覆盖：

```text
YAML 合法加载
profile overlay（test/prod 隔离）
QF_* 环境变量覆盖（QF_SECTION__KEY）
secret-file 加载
密码/token/key 脱敏
非法配置字段路径
```

## ConfigCheck CLI

合法配置：

```bash
java -cp config.jar:snakeyaml.jar com.quantlink.fin.config.ConfigCheck \
  /tmp/qf-config-valid.yml deploy/config/config-schema.json
```

输出：

```yaml
control_plane:
  password: '***'
config OK profile=dev
```

非法配置：

```text
config invalid: control_plane: required
```

启动/CI 可通过该命令 fail-fast，并得到字段路径。

## 模块

```text
backend/shared/config
  ConfigLoader
  ConfigDocument
  ConfigSchema
  ConfigCheck
```

样例：

```text
deploy/config/runner.yml.example
deploy/config/runtime-agent.yml.example
deploy/config/config-schema.json
deploy/config/secrets.example
```

## 接入

- `RunnerConfig`：缺少 `strategyId/strategyType/orsId/controlPlaneUrl` 或数值越界时抛出 `ConfigException`。
- `AgentConfig`：端口、心跳周期、必填命令字段启动校验。
- 控制面既有 `QF_*` 环境变量继续生效；新的 YAML 配置支持 `QF_SECTION__KEY` 覆盖。

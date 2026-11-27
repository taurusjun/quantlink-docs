# QuantLink 日志系统设计

**状态：** DRAFT  
**范围：** 190 单机、现有 ORS/SimVenue/FastTrade/SDK 日志  
**目标：** 用尽量少的组件，把 C++/Java 日志统一成可查询的结构化日志。  
**选型：** Vector → VictoriaLogs → Grafana。

## 1. 结论

第一阶段只做一条最小链路：

```text
C++ / Java 本地 JSONL 日志
        │
        ▼
Vector（tail、解析、补字段、脱敏）
        │  HTTP /insert/jsonline
        ▼
VictoriaLogs（单机存储、LogsQL 查询、TTL）
        │
        ▼
Grafana（VictoriaLogs 数据源、Explore、Dashboard）
```

明确不做：

- 不做 HA、集群、Kafka、ClickHouse；
- 不做跨机房采集；
- 不把查询服务放进交易进程；
- 不承诺日志零丢失；
- 第一阶段不做复杂告警，只保留 Grafana 查询和基础错误面板。

## 2. 现状与约束

### 2.1 已有日志

- ORS：JSONL，一行一个 JSON，字段为 `ts/level/event/message` 加动态字段。
- SimVenue：Logback 纯文本格式，不是 JSON。
- FastTrade：目前只有 `access-sdk` 和 smoke，没有真正的策略运行时。
- ORS SDK：SLF4J API，库本身不配置输出。
- 190 上 ORS 日志路径：

```text
/var/log/quantlink/instances/<instance-id>/ors.log
```

当前 ORS 日志存在两个问题：

1. 缺少 `schema_version/service/instance/host/pid/thread`；
2. `ORS_LOG` 旧接口把 C++ 函数名写成 `event`，不适合作为稳定查询维度。

### 2.2 约束

- 交易热路径不能同步写远端日志；
- 日志采集不能反压 ORS；
- 4 vCPU 单机，组件必须轻量；
- 单机故障可接受，但不能因此影响交易进程；
- 日志包含账户、订单信息，必须限制访问；
- 当前 `simvenue.log` 还是文本，接入前要先改 JSON，或第一阶段只接 ORS。

## 3. 日志格式 v1

### 3.1 基础规则

- UTF-8；
- 一行一个完整 JSON（JSONL）；
- 不允许跨行；内部换行转义为 `\n`；
- 字段名统一 `snake_case`；
- 新字段只能追加，不重命名、不删除；破坏性变更提升 `schema_version`；
- 交易进程只写本地文件，不直接写 VictoriaLogs。

### 3.2 必填字段

```json
{
  "schema_version": "1",
  "ts": "2026-11-27T09:30:12.345Z",
  "level": "INFO",
  "service": "ors",
  "instance": "ors-simnow",
  "host": "VM-0-10-rockylinux",
  "pid": 12345,
  "thread": "ors-poll",
  "type": "order",
  "event": "ors.order.ack",
  "message": "order acknowledged"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `schema_version` | string | 是 | 当前 `"1"` |
| `ts` | string | 是 | UTC RFC3339，毫秒，必须以 `Z` 结尾 |
| `level` | string | 是 | `TRACE/DEBUG/INFO/WARN/ERROR/CRITICAL` |
| `service` | string | 是 | `ors`、`simvenue`、`fasttrade`、`ors-sdk`、`control-plane` |
| `instance` | string | 是 | 实例 ID，如 `ors-simnow` |
| `host` | string | 是 | 主机名 |
| `pid` | integer | 是 | 进程 ID |
| `thread` | string | 否 | 线程名；建议 C++ 和 Java 都填 |
| `type` | string | 是 | 业务语义分类，见 3.3 |
| `event` | string | 是 | 稳定事件名，见 3.3 |
| `message` | string | 是 | 纯人类可读语义；禁止 ID、时间戳、函数名、`key=value`、管道分隔字段 |

### 3.3 `type` 与事件名

`type` 表示业务语义，不是日志级别：

| type | 用途 |
|---|---|
| `order` | 新单、撤单、成交、拒单、订单状态 |
| `account` | 账户、持仓、资金、查询结果 |
| `market_data` | 行情订阅、行情 tick、行情连接 |
| `session` | 登录、认证、断线、会话、启动 |
| `rms` | 风控检查、风控拒绝、风控告警 |
| `transport` | Aeron、消息发布、背压 |
| `system` | 指标、配置、内部状态、未分类 |

新代码统一使用：

```text
<service>.<domain>.<action>
```

示例：

```text
ors.startup.live_orders
ors.startup.orders_flat
ors.order.new
ors.order.ack
ors.order.reject
ors.order.cancel
ors.order.trade
ors.query.account_timeout
ors.rms.reject
ors.transport.aeron_backpressure
simvenue.order.accepted
fasttrade.order.submitted
ors_sdk.client.registered
```

规则：

- 全小写，点分隔，只允许 `[a-z0-9_]`；
- 不使用 C++ `__FUNCTION__` 或 Java 方法名；
- 旧 `ORS_LOG` 函数名事件保留但视为 legacy，查询服务不依赖它做业务统计；
- 新代码不再新增 legacy 事件。

### 3.4 `message` 规范

`message` 只描述“发生了什么”，不承载查询字段。正确：

```json
{"event":"ors.md.subscribe_response","instrument":"ao_o","message":"market data subscription response"}
{"event":"ors.instrument.definition","instrument":"PX","round_lot_for_value_calc":1,"price_factor":1,"message":"instrument definition loaded"}
```

禁止：

```text
|1795782853359670333|Instrument ad_o
Instument name: PX|RoundLotForValueCalc : 1|PriceFactor : 1
message=order_id=123 price=725
```

- 时间放 `ts`，不要放 `message`；
- 函数名放 `event`，不要放 `message`；
- 合约、订单号、价格、数量、错误码放独立字段；
- 不拼接 `key=value` 或管道分隔字符串；
- 同一事件的消息文本保持稳定，便于聚合；
- 需要保留原始报文时，放 `raw` 字段，不放 `message`。

### 3.5 可选字段

常用字段放顶层，方便索引：

| 字段 | 类型 | 说明 |
|---|---|---|
| `environment` | string | `PROD/SHADOW/TEST` |
| `request_id` | string | SDK/客户端请求关联 |
| `order_id` | string | 订单关联；不要用 JSON number |
| `order_ref` | string | CTP OrderRef，字符串 |
| `client_id` | string | ORS clientId，字符串 |
| `account_id` | string | 账户，访问受控 |
| `venue_id` | string | `SIMNOW/SIMVENUE/CTP` |
| `instrument` | string | 合约 |
| `error_code` | string | 业务/CTP 错误码，统一字符串 |
| `error_message` | string | 错误描述，已脱敏 |
| `duration_us` | integer | 耗时，微秒 |
| `trace_id` | string | 可选；当前 contract 没有 trace 字段，暂不保证跨 Aeron 传播 |
| `attrs` | object | 组件扩展字段，见 3.6 |

ID 统一用字符串：

```json
{"order_id":"1000001","client_id":"1","request_id":"42"}
```

### 3.6 `attrs`

组件私有字段放 `attrs`，只允许一层对象：

```json
{
  "attrs": {
    "count": 2,
    "order_refs": ["000000000001", "000000000002"],
    "queue_depth": 12,
    "severity": "P1"
  }
}
```

约束：

- 值允许 string / number / boolean / scalar array；
- 单条日志建议不超过 64KB；
- 高频循环日志必须限流或降级；
- 当前 `setExchangeInstrDefinitionMap` 逐合约刷日志，接入前要降到 DEBUG 或采样。

### 3.7 级别与时间

| level | 用途 |
|---|---|
| `TRACE` | 本地诊断，生产默认关闭 |
| `DEBUG` | 开发/联调，生产默认关闭 |
| `INFO` | 生命周期、正常订单结果 |
| `WARN` | 可恢复降级、重试、节流 |
| `ERROR` | 需要人工关注的业务失败 |
| `CRITICAL` | 进程不可用、无法交易 |

- `ts` 统一 UTC；展示时转 Asia/Shanghai；
- 告警级别放 `attrs.severity`（`P0/P1/P2/P3`），不要滥用 `level`；
- 不能把闭市正常拒单写成 `CRITICAL`。

### 3.8 安全

禁止记录：

```text
password / passwd
auth_code
app_id 密钥
token / secret / api_key
完整身份证/银行卡
```

- C++ 现有 logger 只按 key 名过滤敏感字段，`attrs` 和 `error_message` 也要检查；
- `account_id/order_id` 可以记录，但查询服务必须做权限控制；
- Vector 侧再做一层 key 级脱敏，不能把脱敏完全依赖调用方。

### 3.9 示例

订单生命周期：

```json
{"schema_version":"1","ts":"2026-11-27T09:30:12.345Z","level":"INFO","service":"ors","instance":"ors-simnow","host":"VM-0-10-rockylinux","pid":12345,"thread":"ors-poll","type":"order","event":"ors.order.ack","message":"order acknowledged","order_id":"1000001","order_ref":"000000000001","client_id":"1","account_id":"simnow","instrument":"au2612"}
```

启动报警：

```json
{"schema_version":"1","ts":"2026-11-27T09:30:12.345Z","level":"ERROR","service":"ors","instance":"ors-simnow","host":"VM-0-10-rockylinux","pid":12345,"thread":"main","type":"system","event":"ors.startup.live_orders","message":"CTP has live orders at startup","error_code":"LIVE_ORDERS","attrs":{"severity":"P1","count":2,"order_refs":["000000000001","000000000002"]}}
```

### 3.10 C++ 与 Java 落地

C++ ORS：

- 保留 `ors::log`，新增公共字段注入 helper；
- `schema_version/service/instance/host/pid/thread` 由 helper 统一填；
- 新代码使用 `event + message + fields`，不再用函数名作为新事件；
- 时间改成 UTC `Z`；
- `ORS_LOG` 只做旧代码兼容，不进入新模块；
- 避免在每个调用点重复拼公共字段。

Java：

- 当前没有策略运行时；后续 FastTrade/策略进程启动时注入：
  `service=fasttrade`、`instance`、`host`、`pid`、`schema_version=1`；
- 使用 SLF4J + JSON encoder（Logback JSON 或自定义 encoder）；
- 禁止 `log.info("orderId=" + id + " price=" + price)`；
- `event` 用结构化字段，不用字符串拼接；
- SimVenue 当前是纯文本 Logback，接入 VictoriaLogs 前必须改成 JSON；
- SDK 是库，不强制配置输出，由使用方注入编码器。

## 4. 选型

### 4.1 选定链路

```text
Vector → VictoriaLogs → Grafana
```

| 组件 | 作用 | 选择理由 |
|---|---|---|
| Vector | 采集、解析、补字段、脱敏、发送 | 单二进制、VRL 转换强、文件 checkpoint、无 JVM |
| VictoriaLogs | 日志存储与 LogsQL 查询 | 单机轻量、JSON 字段查询、压缩和 TTL 简单 |
| Grafana | 查询 UI 和 Dashboard | 现成 VictoriaLogs 插件，Explore 可直接排查 |

### 4.2 为什么不选

- **ClickHouse**：适合结构化订单分析，但需要额外建表、写入和运维；当前日志查询用 VictoriaLogs 更轻。后续升级条件见第 12 节。
- **Loki**：标签基数容易失控，`order_id` 不能做 label；当前团队没有现成 Loki 运维经验。
- **Elasticsearch/OpenSearch**：4 vCPU 单机资源成本过高。
- **自研文件查询**：轮转、并发、权限、性能都不可控。

### 4.3 简单原则

- 单机 VictoriaLogs，不做集群；
- 本地磁盘，先 30 天保留，磁盘不足再降 7 天；
- 不做 Kafka，不做跨机采集；
- 不做自定义查询 Web，先用 Grafana Explore；
- 告警第二阶段再做。

## 5. 架构

```text
┌──────────────────────────┐
│ ORS / SimVenue / Java    │
│ 本地 JSONL 日志           │
└────────────┬─────────────┘
             │ file tail
             ▼
┌──────────────────────────┐
│ Vector                   │
│ - 解析 JSON              │
│ - 补 service/instance    │
│ - 脱敏                   │
│ - 批量 HTTP 发送          │
└────────────┬─────────────┘
             │ /insert/jsonline
             ▼
┌──────────────────────────┐
│ VictoriaLogs :9428       │
│ - stream fields          │
│ - 30d retention          │
└────────────┬─────────────┘
             │ LogsQL
             ▼
┌──────────────────────────┐
│ Grafana :3001            │
│ - Explore                │
│ - Dashboard              │
└──────────────────────────┘
```

VictoriaLogs 只绑定 `127.0.0.1`；Grafana 绑定 `0.0.0.0:3001`，通过防火墙开放 3001/tcp，使用 Grafana 登录认证访问。

## 6. 实现

### 6.1 目录与端口

```text
/opt/quantlink/observability/
  docker-compose.yml

/etc/quantlink/observability/
  vector.toml
  grafana.ini
  grafana/provisioning/datasources/victoria-logs.yml

Docker named volumes:
  victoria-logs-data
  vector-data
```

| 服务 | 端口 | 绑定 |
|---|---:|---|
| VictoriaLogs | 9428 | 127.0.0.1 |
| Grafana | 3001 | 0.0.0.0（防火墙限制来源） |

### 6.2 VictoriaLogs + Vector + Grafana

190 上 Docker Hub 直连不可用，但可以通过 `docker.m.daocloud.io` 镜像拉取；实际部署使用 Docker Compose 管理 VictoriaLogs 和 Vector 两个容器，Grafana 使用 RPM 原生安装：

- `victoriametrics/victoria-logs:v1.55.0`
- `timberio/vector:0.62.0-debian`

Vector 容器只读挂载 `/var/log/quantlink`，配置挂载到 `/etc/vector/vector.toml`；数据使用 named volume。Grafana 在 190 上用 RPM 原生安装，监听 `0.0.0.0:3001`；宿主机 `3000` 已被 `dietitian-api` 占用，不能复用。

`docker-compose.yml` 关键部分：

```yaml
services:
  victorialogs:
    image: docker.m.daocloud.io/victoriametrics/victoria-logs:v1.55.0
    command:
      - -retentionPeriod=30d
      - -httpListenAddr=:9428
      - -storageDataPath=/victoria-logs-data
    volumes:
      - victoria-logs-data:/victoria-logs-data
    ports:
      - "127.0.0.1:9428:9428"

  vector:
    image: docker.m.daocloud.io/timberio/vector:0.62.0-debian
    command: ["--config", "/etc/vector/vector.toml"]
    volumes:
      - /var/log/quantlink:/var/log/quantlink:ro
      - /etc/quantlink/observability/vector.toml:/etc/vector/vector.toml:ro
      - vector-data:/var/lib/vector

```

Grafana 数据源 provisioning：

```yaml
apiVersion: 1
datasources:
  - name: VictoriaLogs
    type: victoriametrics-logs-datasource
    access: proxy
    url: http://victorialogs:9428
    isDefault: true
```

启动后检查：

```bash
curl -s http://127.0.0.1:9428/health
curl -s http://127.0.0.1:9428/select/logsql/query \
  --data-urlencode 'query=*' \
  --data-urlencode 'limit=1'
```

如果 190 没有 Docker，改用三个 systemd 服务：VictoriaLogs、Grafana、Vector；端口和配置不变。

### 6.3 Vector

第一阶段只接 ORS 的 JSONL；SimVenue 改成 JSON 后再加入。

`/etc/vector/vector.toml` 骨架：

```toml
data_dir = "/var/lib/vector"

[sources.quantlink_logs]
type = "file"
include = ["/var/log/quantlink/instances/*/ors.log"]
read_from = "beginning"
ignore_older_secs = 86400

[transforms.normalize]
type = "remap"
inputs = ["quantlink_logs"]
source = '''
file_path = .file
raw = .message
parsed, err = parse_json(raw)
if err == null {
  . = parsed
} else {
  . = {
    "schema_version": "legacy",
    "level": "ERROR",
    "event": "log.parse_error",
    "message": raw,
    "parse_error": err
  }
}
.file = file_path

# 旧日志没有公共字段，先从文件路径补
if !exists(.schema_version) { .schema_version = "legacy" }
if !exists(.service) { .service = "ors" }
parsed_path, path_err = parse_regex(.file, r'/instances/(?P<instance>[^/]+)/')
if path_err == null && exists(parsed_path.instance) {
  .instance = parsed_path.instance
}
if !exists(.instance) { .instance = "unknown" }
if !exists(.host) { .host = get_hostname!() }
if !exists(.level) { .level = "INFO" }
if !exists(.event) { .event = "log.unknown" }
if !exists(.message) { .message = raw }

# 最小脱敏；生产日志仍应由写入方负责
del(.password)
del(.passwd)
del(.auth_code)
del(.secret)
del(.token)
del(.api_key)

.ingest_pipeline = "vector"
'''

[sinks.victorialogs]
type = "http"
inputs = ["normalize"]
uri = "http://victorialogs:9428/insert/jsonline?_stream_fields=service,instance,host&_time_field=ts&_msg_field=message"
method = "post"
encoding.codec = "json"
framing.method = "newline_delimited"
batch.max_events = 1000
batch.timeout_secs = 2
request.retry_attempts = 10
```

说明：

- `read_from = "beginning"` 首次会读历史文件，上线前先确认磁盘和保留量；
- Vector checkpoint 在 `/var/lib/vector`，重启后从上次位置继续；
- 文件轮转和 truncate 由 Vector 处理，不依赖 `tail -f`；
- Vector 发送失败会重试，但不保证零丢失；不能用它替代审计存储；
- `ts` 目前是 `+0800`，Vector 只透传；C++ 侧改成 UTC `Z` 后再由 VictoriaLogs 按 `_time_field=ts` 建时间索引。若暂时不改，需在 Vector 里做时间格式归一化。

### 6.4 Grafana

- 安装 `victoriametrics-logs-datasource` 插件；
- 数据源指向 `http://victorialogs:9428`；
- 先用 Explore 验证字段和查询；
- 第一版 Dashboard 只做四个面板：
  1. 日志量按 `service/level`；
  2. `ERROR/CRITICAL` 最近 24h；
  3. `ors.startup.live_orders` 最近事件；
  4. 按 `order_id` 查询订单链路。

Grafana 对外访问：

```text
http://101.43.54.190:3001
```

需要开放防火墙 `3001/tcp`；Grafana 使用 admin 密码登录，匿名访问关闭。

### 6.5 应用侧改造顺序

1. C++ ORS：
   - 增加公共字段注入；
   - 时间改 UTC；
   - 新增稳定事件名；
   - 降低 `setExchangeInstrDefinitionMap` 日志量。
2. SimVenue：
   - Logback 改成 JSON encoder；
   - 补 `schema_version/service/instance/host/pid/thread`；
   - 再接入 Vector。
3. Java FastTrade/策略：
   - 当前没有策略运行时；新增运行时必须从第一天使用同一编码器；
   - `event`、订单字段使用结构化字段；
   - 不把业务字段拼进 `message`。
4. ORS SDK：
   - 库不强制配置日志输出；
   - 使用方注入 JSON encoder；
   - 关键客户端事件补 `event` 和 `request_id`。

## 7. 查询示例

Grafana Explore 或 LogsQL：

```text
service:ors
service:ors level:ERROR
service:ors event:ors.order.reject
order_id:"1000001"
client_id:"1" and level:ERROR
instance:ors-simnow _time:1h
```

按订单查：

```text
order_id:"1000001"
```

查启动在途单：

```text
event:ors.startup.live_orders
```

curl：

```bash
curl -sG http://127.0.0.1:9428/select/logsql/query \
  --data-urlencode 'query=service:ors level:ERROR' \
  --data-urlencode 'limit=50'
```

`order_id` 只作为字段查询，不作为 VictoriaLogs stream field，避免高基数。

## 8. 运维

### 8.1 保留与磁盘

- 初始 `-retentionPeriod=30d`；
- 磁盘不足先降到 `7d`，不要直接删数据目录；
- 上线前测一天日志量，估算：

```text
每日日志量 × 30 × 压缩比
```

- 当前 ORS 日志存在逐合约刷屏，先降噪再谈 30 天。

### 8.2 轮转

- ORS：现有 spdlog 100MB × 5；
- SimVenue：Logback 50MB × 30 天，总上限 2GB；
- VictoriaLogs 自己管理存储 TTL；
- Vector 记录 checkpoint，处理 rotate/truncate；
- Grafana 数据源不要直接读活跃文件。

### 8.3 安全

- 9428 只绑定 `127.0.0.1`，不把 VictoriaLogs 暴露到公网；
- Grafana 3001 对外，但必须限制防火墙来源、设置强密码、禁用匿名访问；
- 日志中的账户/订单字段做访问控制；
- Vector 脱敏只是兜底，写入方必须先脱敏；
- 日志采集用户只读 `/var/log/quantlink`，不要用 root 运行 Vector。

### 8.4 监控

至少监控：

- Vector 进程存活、发送失败数；
- VictoriaLogs 磁盘使用率、写入错误；
- Grafana 存活；
- 交易时段日志是否停止增长；
- ORS 日志量异常增长。

日志停止增长本身要报警，不能把“没有日志”当成“没有问题”。

## 9. 验收

第一阶段验收项：

1. 一条测试 JSON 写入后，Grafana 能查到；
2. 必填字段 `schema_version/ts/level/service/instance/host/pid/type/event/message` 可见；
3. `order_id` 能查出完整订单链路；
4. ORS 日志轮转后 Vector 继续采集；
5. 重启 Vector 后从 checkpoint 继续，不重复大量数据；
6. Vector/VictoriaLogs 不反压 ORS，ORS CPU 无明显变化；
7. 日志中看不到密码、AuthCode、token；
8. 9428 未对公网开放；3001 已开放但需要登录认证；
9. 磁盘使用在预算内；
10. SimVenue/Java 接入后同样能按 `service/event` 查询。

## 10. 风险与回滚

| 风险 | 处理 |
|---|---|
| VictoriaLogs 单点故障 | 第一阶段接受；日志查询不可用不影响交易；后续再考虑双写/集群 |
| 日志丢失 | Vector 重试 + checkpoint；不承诺零丢失；审计需求另建可靠链路 |
| 磁盘写满 | TTL、容量监控、先降噪；必要时降保留天数 |
| 高基数 | `order_id` 不做 stream field/label；只做字段查询 |
| 旧日志非 JSON | 先接 ORS；SimVenue 改 JSON 后再接 |
| 时间不一致 | 主机 chrony；C++/Java 统一 UTC；Vector 做兼容归一化 |
| Vector 读权限 | 单独用户，加入 `quantlink` 组，目录只读 |
| 交易受影响 | Vector 独立进程；停止 Vector 即可回滚，ORS 不受影响 |

回滚：

```text
停止 Vector
→ 停止 VictoriaLogs/Grafana
→ 删除 compose 和数据目录（确认不需要历史日志）
```

交易进程不需要改配置，回滚不影响下单。

## 11. 实施顺序

1. 先降 ORS 噪声日志，确认日增量；
2. 部署 VictoriaLogs + Grafana，验证健康检查；
3. 部署 Vector，只接 ORS JSONL；
4. Grafana 配数据源，跑通 `service/order_id` 查询；
5. C++ 补公共字段和 UTC 时间；
6. SimVenue 改 JSON 后接入；
7. Java FastTrade/策略运行时按同一标准接入；
8. 观察一周，再决定是否加告警、扩容或换 ClickHouse。

## 12. 后续升级 ClickHouse 的评估

**当前决策不变：** 第一阶段仍用 VictoriaLogs，不引入 ClickHouse，不做双写，不做 Kafka。  
**评估结论：** ClickHouse 是后续可选升级方向，不是当前必需组件；升级时保持日志格式 v1 和 Vector 采集层不变。

### 12.1 什么时候评估

满足以下任意一类条件时，再启动 ClickHouse 评估：

- 需要按 `order_id`、`account_id`、`instrument` 做复杂 SQL 聚合、关联订单/持仓数据；
- 需要 90 天以上明细保留，VictoriaLogs 单机磁盘或查询延迟开始不可接受；
- 日日志量增长到 VictoriaLogs 单机难以稳定承载，或查询影响采集；
- 需要多个消费方（审计、风控、运营、策略分析）共享同一份结构化日志；
- 需要固定报表、批量导出、复杂 join，而 LogsQL 表达和维护成本过高；
- 团队已经有稳定的 ClickHouse 运维能力，并且能提供独立资源。

以下情况不构成升级理由：

- 只是想要一个日志查询页面；
- 日志量很小，VictoriaLogs 查询延迟正常；
- 只是为了“技术更先进”；
- 没有明确的数据量、查询延迟和保留周期指标。

### 12.2 方案对比

| 方案 | 结构 | 适用阶段 | 代价 |
|---|---|---|---|
| 当前基线 | Vector → VictoriaLogs → Grafana | 第一阶段 | 最轻，SQL 能力弱 |
| 过渡评估 | Vector 同时写 VictoriaLogs 和 ClickHouse staging | 1–2 周影子对比 | 双份磁盘/CPU，需对账 |
| 目标升级 | Vector → ClickHouse → Grafana | 日志量或分析需求明确后 | 需要建表、调优、TTL 和运维 |
| 强可靠链路 | Vector → Kafka → ClickHouse | 多消费方/审计级可靠性 | 组件多，当前不做 |

建议升级路径：

1. 先建 ClickHouse staging 表，不切流量；
2. Vector 同时写 VictoriaLogs 和 staging，观察 1–2 周；
3. 对比查询结果、延迟、磁盘、CPU、重复率；
4. 验收通过后，Grafana 切换到 ClickHouse；
5. VictoriaLogs 保留 7 天作为回滚，再决定是否下线。

不建议长期双写：维护两套存储、两套 TTL、两套权限，复杂度会超过收益。

### 12.3 ClickHouse 表设计草案

```sql
CREATE DATABASE IF NOT EXISTS quantlink_logs;

CREATE TABLE quantlink_logs.events
(
    ts             DateTime64(3, 'UTC'),
    schema_version LowCardinality(String),
    level          LowCardinality(String),
    service        LowCardinality(String),
    instance       LowCardinality(String),
    host           LowCardinality(String),
    pid            UInt32,
    thread         LowCardinality(String),
    type           LowCardinality(String),
    event          LowCardinality(String),
    message        String,
    order_id       String,
    request_id     String,
    client_id      String,
    account_id     String,
    venue_id       LowCardinality(String),
    instrument     LowCardinality(String),
    error_code     String,
    error_message  String,
    duration_us    UInt64,
    attrs          String,
    raw            String,
    INDEX idx_order_id order_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_request_id request_id TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (service, instance, event, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY;
```

约束：

- `attrs` 存 JSON 字符串，查询用 `JSONExtractString(attrs, 'severity')`；
- `order_id` 不进排序键，避免高基数影响写入；用 bloom filter 辅助查询；
- `MergeTree` 不保证实时去重；Vector 是 at-least-once，重复日志可接受时直接查询，要求精确去重时再增加 `event_id`；
- 事件字段仍使用日志格式 v1，ClickHouse 只做存储和查询，不改变写入方语义；
- 建表、TTL、索引都以 190 的实际日志量和查询模式验证后再定。

### 12.4 Vector 接入草案

```toml
[transforms.clickhouse_prepare]
type = "remap"
inputs = ["normalize"]
source = '''
if exists(.attrs) {
  .attrs = encode_json(.attrs)
} else {
  .attrs = "{}"
}
'''

[sinks.clickhouse_staging]
type = "clickhouse"
inputs = ["clickhouse_prepare"]
endpoint = "http://127.0.0.1:8123"
database = "quantlink_logs"
table = "events"
format = "json_each_row"
skip_unknown_fields = true
date_time_best_effort = true
```

说明：

- `skip_unknown_fields` 允许日志新增字段时先不建列；
- `date_time_best_effort` 用于兼容 RFC3339 时间；
- ClickHouse 写入使用本机 HTTP 8123，不对公网开放；
- 写入用户只给 `INSERT`，Grafana 使用只读用户；
- ClickHouse 与交易库隔离，独立 database、用户、TTL，不复用交易表。

### 12.5 评估指标

影子对比至少记录：

| 指标 | 目标 |
|---|---|
| 查询结果 | 关键 `order_id` 链路与 VictoriaLogs 一致 |
| 查询延迟 | 常用 1h/24h/7d 查询 p95 可接受 |
| 写入延迟 | Vector → ClickHouse 秒级，无明显积压 |
| 资源 | 4 vCPU 下 CPU、内存、磁盘不挤占交易 |
| 存储 | 每 GB 原始日志的压缩后占用、90 天容量 |
| 重复率 | 可接受或可去重 |
| 运维 | 建表、TTL、备份、升级成本可承受 |

### 12.6 迁移与回滚

切换步骤：

1. 建 `quantlink_logs` 独立库和 staging 表；
2. Vector 增加 ClickHouse sink，保留 VictoriaLogs sink；
3. 用真实日志做 1–2 周影子对比；
4. Grafana 增加 ClickHouse 数据源，先做只读查询；
5. 验收后切换 Dashboard，VictoriaLogs 保留 7 天；
6. 确认无回滚需求后再停 VictoriaLogs。

回滚：

- Grafana 切回 VictoriaLogs 数据源；
- Vector 删除 ClickHouse sink；
- 停止 ClickHouse 写入，不影响 ORS；
- 交易进程和日志格式不需要变更。

### 12.7 结论

- **现在不升级**：当前日志量和查询需求先用 VictoriaLogs 满足；
- **保留升级路径**：日志格式、Vector 解析和 Grafana 查询层都按可替换后端设计；
- **升级前提**：有明确的数据量、查询延迟、保留周期或 SQL 分析需求，并在 190 上完成影子对比；
- **不提前引入**：Kafka、双写、集群和复杂审计链路都不属于第一阶段。


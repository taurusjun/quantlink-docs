# ORS v4 代码整理任务：日志与 illuminati 依赖

- 状态：DRAFT（已并入实施计划 `plans/2026-11-26-ors-implementation.md` Task 2B，待执行）
- 范围：ORS v4 核心代码整理；v3 实现不再清理，只作为历史
- 关联：
  - `003-ors-v4.md`
  - `004-ors-sdk.md`

---

## 1. 结论

需要整理，但方向是：

```text
基础设施去 illuminati
  -> std + ors_base + Aeron
业务逻辑保留
  -> 公司 ORS 订单/RMS/状态机
日志统一
  -> 事件 JSONL + 计数 metrics，不混用
```

不建议引入一套新的大型基础框架来“替换 illuminati”。  
能用标准库的用标准库，能用现有 `ors_base` 的复用，RMS 只做隔离，不做重写。

---

## 2. 日志现状

当前 ORS 有两套风格：

```text
ors_base::logEvent / logMetrics
  JSONL
  字段结构化
  异步 rotating

std::cerr / std::cout
  [ctp] ...
  纯文本
  部分在 session、query、smoke

ILOG / StatsCollector
  公司 ORS 旧日志/统计
```

问题：

- 同一运行路径可能同时出现 JSONL 和 `[ctp]` 文本
- 有些地方是“计数”，有些地方直接打印
- 事件名不统一：`session.state`、`md.stale`、`order.rejected`、`publish.fail` 等
- `std::cerr` 绕过异步 logger，可能阻塞或丢字段
- `ILOG` 格式与 JSONL 不一致
- 计数和日志边界不清，容易出现每 tick 打印

---

## 3. 日志统一规则

### 3.1 两类输出

```text
事件日志：低频、可诊断、可复现
  订单、撤单、成交、回报、连接、重连、查询、错误

指标计数：高频、只递增
  MD tick、回调次数、publish 成功/失败、back-pressure
```

规则：

- 热点路径只 `atomic++`，不每 tick 打日志
- 状态变化、订单/撤单/成交、错误才写事件日志
- 指标每 60 秒汇总一次 `metrics` 事件
- 不给每个 MD tick 打一条日志

“count 还是 Log”不是二选一：

```text
计数用于量和健康
日志用于因果关系和复现
```

### 3.2 统一格式

所有生产日志统一 JSONL：

```json
{"ts":"2026-11-26T15:00:00.123+0800","level":"INFO","event":"order.rtn","venue_id":"SIMNOW","account_id":"142266","order_id":42,"response_type":"TRADE_CONFIRM","quantity":1,"price":735.0}
```

固定字段：

```text
ts, level, event
venue_id, account_id, environment
order_id / request_id
strategy_id（如适用）
symbol, exchange
response_type / request_type
price, quantity, error_code
reason
```

规则：

- 数字保持 JSON number
- reason 先脱敏再截断
- 不输出密码、APP_ID、AUTH_CODE
- 缺失字段不写 null
- 不在 JSON 外拼 `[ctp]` 前缀

### 3.3 API 统一

业务代码不直接调用：

```text
spdlog
ILOG
std::cerr
std::cout（生产路径）
StatsCollector
```

统一通过 ORS 自己的 facade：

```cpp
ors::log::info("order.rtn", { ... });
ors::log::warn("session.disconnected", { ... });
ors::log::error("publish.fail", { ... });
ors::log::metrics(...);
```

内部实现可以继续用 spdlog + `ors_base::logEvent`，但业务代码只认 facade。

### 3.4 允许保留的 stdout/stderr

只允许：

- `--help` / `--version`
- 配置摘要（脱敏）
- smoke 工具的人类可读结果

生产运行时不得用 `std::cout` / `std::cerr` 写业务日志。

---

## 4. 日志整理任务

### 任务 L1：建立事件字典

固定事件名和字段：

```text
ors.start / ors.start_failed / ors.shutdown
session.state / session.disconnected / session.failed / session.handshake
order.recv / order.send / order.rtn / order.rejected
cancel.recv / cancel.send / cancel.rtn / cancel.rejected
trade.rtn
publish.order / publish.trade / publish.fail
query.account / query.position / query.failed
reconnect.epoch / reconnect.ready
md.first_tick / md.stale / md.recovered
metrics
```

每个事件定义必填字段，不允许同名事件字段漂移。

### 任务 L2：ORS 日志 facade

新增：

```text
ors/include/ors/log.h
ors/src/log.cpp
```

业务代码只调用 facade；facade 内部使用 `ors_base::Log`/spdlog。

### 任务 L3：替换旧调用

- `ILOG(...)` -> facade
- `std::cerr` 业务输出 -> facade
- `StatsCollector::record` -> metrics 计数或汇总
- 删除旧 `[ctp]` 文本日志
- smoke 的 stdout 保留，但标记为 CLI/test 输出

### 任务 L4：日志字段与脱敏

- 订单相关日志必须带 `order_id`、`request_id`（如可用）、`symbol`、`price`、`quantity`
- 连接日志带 session/reason
- 错误日志带 `error_code` 和脱敏后的 reason
- 不打印凭据
- 固定宽度文本用 UTF-8 安全截断

### 任务 L5：验证

- JSONL 每行可解析
- 事件字段集合符合字典
- 热点路径无逐 tick 日志
- 60 秒 metrics 正常
- 日志轮转/异步线程退出正常
- `rg 'ILOG|std::cerr|StatsCollector'` 在生产代码中只剩允许项

---

## 5. illuminati 依赖盘点

公司 ORS 主要依赖：

| illuminati 组件 | 用途 | v4 处理 |
|---|---|---|
| `Configfile` | 配置读取 | 替换为 `ors_base::ConfigFile` + 强类型配置 |
| `ShmManager` / `MarketDataShmWriter` | SHM 通信 | 删除，改 Aeron transport |
| `CasLock` | 互斥 | `std::mutex` / `std::atomic` |
| `ITime_ClockRT` | 时间戳 | `std::chrono` |
| `StatsCollector` | 统计 | ORS metrics + 60s 汇总 |
| `ILOG` / logger | 日志 | ORS log facade + spdlog |
| `ProcessSettings` | 进程设置 | `std::filesystem` / 配置 |
| `RequestMsg` / `ResponseMsg` | 订单消息 | contract v4 或公司 POD 结构 |
| `MarketUpdateNew` | 行情 | v4 MarketUpdate |
| `RmsImpl` / `RmsChecks` | RMS | 保留，隔离到 `rms/` |
| `tinyxml2` | RMS 配置 | 保留；已是轻量库 |

---

## 6. 替换策略

### 可以替换

```text
Configfile -> ors_base::ConfigFile
CasLock -> std::mutex / std::atomic
ITime_ClockRT -> std::chrono
StatsCollector -> metrics + log
ILOG -> log facade
ShmManager -> Aeron transport
ProcessSettings -> std/config
```

### 必须保留/隔离

```text
RmsImpl / RmsChecks
  业务规则，不能换成通用库
  先隔离到 rms/，接口不变

tinyxml2
  已是轻量 XML 库，可继续用
  不建议为了“去依赖”再换

CTP SDK / Aeron
  必需依赖，不替换
```

### 不建议

- 引入新的“大而全”基础库
- 为了替换 `RmsImpl` 自己重写 RMS
- 把 `RequestMsg/ResponseMsg` 改成另一套订单状态机
- 在日志 facade 里塞业务状态

---

## 7. 依赖整理步骤

1. 建 `v4/core`、`v4/rms`、`v4/transport`、`v4/log`
2. 用 `ors_base` 替换配置/日志/文本工具
3. 用 std 替换锁/时间/文件系统
4. 删除 SHM 依赖，接 transport 接口
5. 把 RMS 隔离成独立模块，保留业务代码
6. 删除 hftbase Logger/Stats/Ipc/SysUtils 依赖
7. 保留 CTP SDK、Aeron、tinyxml2
8. 跑 ORS 行为回归和日志格式检查

---

## 8. 验收

```text
生产代码中不再出现：
  ILOG
  StatsCollector
  ShmManager
  MarketDataShmWriter
  CasLock
  ITime_ClockRT
```

例外：

- `rms/` 内如果暂时还引用 illuminati 类型，必须隔离并有替换计划
- `tinyxml2` 保留

日志验收：

- 全部生产事件 JSONL
- 事件名/字段符合字典
- 订单/撤单/成交/错误可关联
- 热点路径只计数
- 日志轮转和异步退出正常

---

## 9. 顺序建议

```text
1. 日志 facade + 事件字典
2. 替换 ILOG / std::cerr / StatsCollector
3. std 替换 Configfile/CasLock/ITime
4. 删除 SHM，接 Aeron
5. 隔离 RMS
6. 删除 hftbase 基础设施依赖
7. 全量回归
```

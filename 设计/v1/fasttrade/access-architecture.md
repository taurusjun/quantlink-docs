# V1 Access 架构（定稿）

- 日期：2026-11-15
- 状态：HISTORICAL / SUPERSEDED（2026-11-17）
- 关联：[`architecture.md`](architecture.md)

> **本文档是历史设计，不再作为实现依据。**
>
> 当前边界：
>
> ```text
> SIM:  AccessSDK <-> SimVenue
> LIVE: AccessSDK <-> CTP adapter（venue-contract）<-> CTP
> ```
>
> 不实现独立的 `AccessRuntime` 进程。LIVE 由新的 CTP adapter 直接输出
> venue-contract。下文出现的 `AccessRuntime` / `SimExchange adapter` 仅保留为历史记录。
>
> 当前设计见
> [`../superpowers/specs/2026-11-17-fasttrade-access-simvenue-design.md`](../superpowers/specs/2026-11-17-fasttrade-access-simvenue-design.md)。

## 0. 结论

V1采用：

```text
TradeBot
  └─ AccessSDK
        ↕ Aeron IPC（aeron:ipc）
AccessRuntime
  ├─ SimExchange adapter
  └─ ORS + MD adapter
```

CTP `TraderApi/MdApi` 放在 **AccessRuntime / ORS** 内，不放进 TradeBot。

```text
一个 ORS = 一个账户
一个账户 = 一个 TradeBot 进程
```

### 0.1 V1进一步简化

```text
一个 TradeBot
  = 一个 account
  = 一个 ORS
  = 一个 MD 登录
```

因此V1明确不做：

```text
多 ORS
多 venue
MD 共享
mdQueue[venue] 轮询
多账户 ORS
```

队列也简化为：

```text
一条 mdQueue
一条 executionQueue
一个 SdkEventDispatcher
```

传输明确为：

```text
Aeron IPC：aeron:ipc
不采用 trading 自定义 raw SHM
不是 TCP/HTTP
```

## 1. 组件边界

| 组件 | 职责 | 不负责 |
|---|---|---|
| `AccessRuntime` | 单 ORS/单 MD/单账户：MD 接入、订单路由、session/account snapshot、Sim/Live adapter 切换 | 策略逻辑、PnL 计算 |
| `AccessSDK` | Aeron IPC 客户端、MD/execution 回调、单线程 dispatcher | CTP 登录、ORS 管理 |
| `TradeBot` | `ConfigParams/SimConfig/ExecutionStrategy/OptionManager` | 直接连接 CTP/ORS |
| `StrategyConfigCenter` | 静态配置、版本、热加载 | 运行状态 |
| `AccessConfigCenter` | ORS/MD/账户绑定、权限、凭据引用 | 订单/行情转发 |
| `RuntimeReporter` | 策略持仓/PnL/订单簿/心跳上报 | 控制面计算 |
| `ControlPanel` | 配置/监控/账户状态展示 | 交易热路径 |
| `Agent` | 启停、重启、健康 | 交易逻辑 |

## 2. 行情链路

```text
CTP MdApi / SimExchange
  -> AccessRuntime
  -> Aeron MD stream
  -> AccessSDK
  -> SdkEventDispatcher（单线程）
  -> CommonClient.sendInfraMDUpdate
  -> SendINDUpdate
  -> ExecutionStrategy
```

## 3. 交易链路

```text
ExecutionStrategy.sendOrder
  -> CommonClient
  -> AccessSDK
  -> Aeron order stream
  -> AccessRuntime
  -> ORS / SimExchange

OrderUpdate / Trade
  -> AccessRuntime
  -> Aeron execution stream
  -> AccessSDK
  -> SdkEventDispatcher
  -> CommonClient.orsCallback
  -> OrderIdStrategyMap
  -> ExecutionStrategy
```

## 4. 线程与队列

```text
AccessSDK
├─ md-io 线程
│    └─> mdQueue
├─ exec-io 线程
│    └─> executionQueue
└─ SdkEventDispatcher（单线程）
     ├─ drainExecution
     ├─ drainMd
     └─ applyAccountState

TradeBot 的 CommonClient / OptionManager / ExecutionStrategy
只在 SdkEventDispatcher 线程访问
```

队列：

```text
mdQueue          一条，有界，可丢/可合并
executionQueue   一条，有界，订单/成交不可静默丢
account state slots   position/account/session 最新版本
```

禁止：

```text
MD 回调线程直接调策略
Trader 回调线程直接调策略
策略回调线程访问 CTP API
```

## 5. 配置与状态

静态配置：

```text
ConfigParams
SimConfig[]
model / indicator
OptionParams
position_init
config_version
```

运行状态：

```text
strategy_state
position_state
pnl_snapshot
order_book_snapshot
session_state
```

规则：

- 配置热加载只做参数；
- 拓扑变化重启 TradeBot；
- 运行状态不回写配置表；
- 控制面板只读运行态，不在管理面计算 PnL/持仓。

## 6. 监控与账户管理

`RuntimeReporter` 异步上报：

```text
strategyKey / positions / pnl / orderBook / lastTick / session / asOf / stale
```

`AccessConfigCenter` 管理：

```text
venue
ors_instance
md_source
account
account -> ors
credentials_ref
```

控制面板显示：

```text
ORS 登录状态
MD 登录状态
账户登录状态
账户余额 / 可用资金 / 保证金
TradeBot 在线状态
最后更新时间
```

数据来源是 `AccessRuntime` 的 `VenueSession` / `AccountSnapshot`，不是控制面板自行推导。

## 7. V1不做

```text
多账户共享 ORS
多客户端共享账户
多租户
外部量化系统 Gateway
复杂 AccountSession/lease/fencing
AccessRuntime 多活
```

## 8. V1落地顺序

1. 冻结 `AccessSDK` 接口与事件 schema（MD/order/trade/account/session）。
2. `AccessRuntime` + SimExchange adapter + `AccessSDK` 单账户 E2E。
3. `TradeBot`：`ConfigParams/SimConfig` + `CommonClient` + 一个策略。
4. `StrategyConfigCenter`：配置版本与参数热加载。
5. 运行状态 DB + `RuntimeReporter` + ControlPanel。
6. `AccessConfigCenter`：ORS/账户/凭据管理。
7. ORS + MD adapter 接入实盘。
8. CTP `TraderApi/MdApi` 进入 `AccessRuntime`。

# 001 系统总览

- 状态：DRAFT
- 日期：2026-11-23
- 范围：新系统的目标、角色、边界、拓扑和核心不变量
- 关联：`README.md`、`../../../146/FAQ/201-tb-ipc-model.md`、`../../../146/FAQ/204-strategy-runtime-and-optionmanager.md`、`../../../146/FAQ/205-gui-data-and-control-plane.md`

---

## 1. 目标

新系统要同时满足：

```text
1. 交易运行时可靠
2. 多策略、多交易通道可扩展
3. GUI 只通过 BotGateway 访问，不直连 venue IPC
4. 账户/持仓/PnL 有明确事实源
5. 不依赖 146 的 PID/数据文件/memlog 作为账户真相
6. 重启后通过对账恢复，不靠历史数据库
```

## 2. 非目标

首版明确不做：

```text
146 源码改造
动态策略注册/发现
策略自己注册到中央服务
用 GUI 替代交易运行时
把 tbadmin memlog 当核心事实总线
保留 146 的 PID/position 文件作为账户权威
```

---

## 3. 系统上下文

```text
                         GUI
                          |
                    WebSocket / HTTP
                          |
                     BotGateway
                          |
                    LocalAgent
                          |
              ┌───────────┴───────────┐
              |                       |
        TradeBot (TB)              Account/ORS
        - StrategyRuntime          - 账户快照
        - TradingChannel           - 订单/成交
        - OrderRegistry            - 持仓
        - FillLedger
        - Fact/ReadModel
```

GUI 不直接访问：

```text
COMMAND / EXECUTION / STATE / MARKET_DATA
venue IPC
TradingChannel
StrategyRuntime
```

---

## 4. 角色

| 角色 | 职责 |
|---|---|
| `StrategyRuntime` | 单策略实例；指标、决策、下单意图、策略仓位 |
| `TradingChannel` | 单交易通道；订单/回报/通道 epoch |
| `OrderRegistry` | 订单状态、clientOrderId -> 通道订单 |
| `FillLedger` | 成交事实与归属 |
| `LocalAgent` | 本机采集、缓存、上传 Fact |
| `BotGateway` | GUI 数据/控制入口、认证、订阅、ACK |
| `AccountSnapshotService` | 账户/保证金快照，不参与订单路由 |
| `ORS` | venue 连接、账户登录、订单执行 |

---

## 5. 标识

```text
tbId          TB 实例
strategyId    策略实例 ID，数字，启动配置指定，TB 内唯一
strategyName  显示名，仅展示
accountId     146 ACCOUNT，trim 后使用（业务归属，不是 venue 账户）
contractKey   (exchange, instrumentId)
tradingChannelKey  channelId
```

规则：

```text
全局策略身份 = (tbId, strategyId)
accountId 不参与路由
strategyId 不参与 exchange/contract 路由
ContractKey -> TradingChannelKey 才是交易路由
```

`accountId` 来源：

```text
146 ACCOUNT / m_account / m_reqMsg.AccountID / NetPnlInfo.m_accountId
```

上面是业务账户。contract 0.2.0 的 `accountId` 是 **venue 账户**（等于 ORS `FIX_TRADING_ACCOUNT`），
146 `ACCOUNT` 到它的映射由 L1/L2 持有并在下单前校验；L0 不按 `accountId` 切换 venue 账户。

`OWN` 只是 146 示例配置值，不是固定常量。

---

## 6. 运行时注册

```text
TB 启动
  -> 读取策略配置列表
  -> 校验 strategyId 唯一
  -> 创建 StrategyRuntime
  -> 写入本地 StrategyRegistry
```

没有动态注册：

```text
无注册 API
无心跳注册
无租约
无中央注册中心
```

GUI 的“策略列表”来自配置和 `StrategyStatusReadModel`，不是注册服务。

---

## 7. 交易路径

```text
StrategyRuntime
  -> OrderIntent(strategyId, contractKey, ...)
    -> TradeBotOrderGateway
      -> ContractRoute(tradingChannelKey)
        -> TradingChannel
          -> COMMAND IPC
            -> ORS
```

回报：

```text
EXECUTION IPC
  -> TradingChannel
    -> OrderRegistry / FillLedger
      -> ExecutionEventRouter
        -> StrategyRuntime[strategyId]
```

策略可以跨多个 TradingChannel；TB 只按 `ContractKey` 路由，不管通道后面是否同一个 ORS。

---

## 8. 数据面

```text
交易事实（不可变）
  OrderFact
  TradeFact
  PositionSnapshot
  AccountSnapshot
  StrategyStatusFact
  SpreadTradeFact
  OptionDelta 输入

读模型（可重建、可丢弃）
  OrderReadModel
  TradeReadModel
  PositionReadModel
  PnlReadModel
  StrategyPnlReadModel
  StrategyPositionReadModel
  AccountSnapshotReadModel
  StrategyStatusReadModel
```

原则：

```text
读模型不反写交易状态
GUI 不直接访问 venue IPC
不提供历史数据库查询
重启恢复靠对账，不靠读模型回放
```

---

## 9. 146 兼容边界

```text
PID                       进程级，不是策略事实
begin_prices_calendar     可选策略种子
positions<id>             策略本地 checkpoint，不是账户真相
final_positions...        策略收盘记录，不是恢复权威
日志                      保留
tbadmin memlog            仅 Plan A/兼容层
```

如果直接复用 146 策略，它可能仍会写这些文件；新系统可以兼容，但不能依赖它们做账户/持仓真相。

---

## 10. 核心不变量

```text
1. 一个 strategyId 在一个 TB 内只有一个 StrategyRuntime
2. (tbId, strategyId) 是全局策略身份
3. accountId（146 ACCOUNT）是业务归属，不参与路由；L0 contract 的 accountId 是 venue 账户
4. ContractKey -> TradingChannelKey 是唯一交易路由
5. OrderFact/TradeFact 不复制 expiry/strike/underlying
6. 读模型不反写交易状态
7. GUI 不直连 venue IPC
8. 手工单必须经过 TradeBotOrderGateway
9. 控制命令必须有 commandId + ACK
10. 账户/持仓恢复以执行/成交、对账和可选 venue 查询为准，不依赖 ORS 快照
11. PositionSnapshot / AccountSnapshot 是 L0 必需消息，但不是账户真相，也不是恢复权威
```

---

## 11. 未决问题

```text
1. orderRef/clientOrderId 的最终格式和跨重启规则
2. TradingChannel 与 ORS 进程的部署关系
3. 多 TB 聚合时 BotGateway 的查询/排序口径
4. Fact 传输格式：SBE IDL / WebSocket 编码
5. read model journal 保留时间
6. 是否需要策略级 journal，以及它与 channel journal 的边界
7. AccountSnapshotService 与 TB 同进程还是独立进程
```

---

## 12. 下一步

```text
003-l0-ors-venue.md
  ORS/venue 会话、订单/回报、账户快照、行情和 L0/L1 边界

004-l1-ipc-transport.md
  OrsAccountStream / 每 exchange ChannelStreamSet、序列、epoch、背压、断线不续传
```

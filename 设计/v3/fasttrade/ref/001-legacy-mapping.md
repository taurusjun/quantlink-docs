# v3 参考：公司 ORS 与 tb_origin 职责映射

- 状态：参考记录，不是 v3 运行时组件清单
- 日期：2026-11-26
- 范围：公司 ORS 和 tb_origin 的职责如何映射到 v3 L0-L6

---

## 1. 两个参考系统不是一回事

```text
公司 ORS   = CTP 网关 + 订单 map + RMS + SHM
tb_origin  = TradeBot 策略框架 + Connector + 历史 DataService + RMS_NEW
```

它们都不是新系统的整体基线。

---

## 2. 映射表

| 参考组件 | 原职责 | v3 归属 | 说明 |
|---|---|---|---|
| 公司 ORS `ORSServer` | CTP 登录/下单/撤单/回报 | L0 ORS | 只保留 venue 访问和 live 路由 |
| 公司 ORS 订单 map | live 订单寻址 | L0 临时 map | 终态即删 |
| 公司 ORS RMS | 预交易/撤单计数 | L2 RiskService | 不进入 L0 |
| 公司 ORS SHM Request/Response | 传输 | L1 contract/Aeron | 不再使用 SHM 作为新系统边界 |
| tb_origin `Strategies/*` | 策略决策 | L3 StrategyRuntime | 只发 OrderIntent |
| tb_origin `Connector::GetUniqueOrderNumber` | OrderID 分配 | L2 TradingChannel | 统一成 orderRef |
| tb_origin `Connector::HandleOrderResponse` | 回报归属 | L1/L2 | L1 路由，L2 写订单状态 |
| tb_origin strategy `OrderMap` | 策略级订单视图 | L3 StrategyOrderView | 不是 channel OrderRegistry |
| tb_origin `DataService/ServiceOrderDataStore` | open/closed 订单读模型 | L3 FactPublisher + L4 LocalAgent + L5 ReadModel | 历史读模型参考，不是 v3 服务 |
| tb_origin `NetPnlStore` / PnL | PnL 读模型 | AccountSnapshotService / ReadModel | 不参与路由 |
| tb_origin `RMS_NEW` | 风控 | L2 RiskService | 不进入 L0 |
| tb_origin `hftbase/Ipc` | SHM 基础设施 | L1 IPC | 被 contract/Aeron 替代 |
| tb_origin `ExchangeSimulator` | 模拟交易所 | simvenue / 测试环境 | 不是生产 L0 |

---

## 3. 关键结论

```text
公司 ORS 的订单 map ≠ L2 OrderRegistry
公司 ORS RMS ≠ L0 风控
tb_origin Connector OrderID ≠ ORS orderRef
tb_origin DataService ≠ v3 运行时组件
tb_origin 策略 OrderMap ≠ channel OrderRegistry
```

因此不能：

```text
直接把公司 ORS 当 L0
直接把 tb_origin Connector 当 L1/L2
直接把 DataService 当订单权威
把 RMS 塞回 ORS
```

v3 只吸收它们的业务语义，不复制它们的传输和多层订单 ID 结构。

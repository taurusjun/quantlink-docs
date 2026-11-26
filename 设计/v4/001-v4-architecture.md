# v4 架构：公司 ORS + Aeron + ORS SDK

- 状态：DRAFT（2026-11-26）
- 范围：ORS、ORS SDK、TradeBot、LocalAgent 的边界
- 取代：v3 的 L0/L1/L2 分层设计
- 权威业务基线：公司 ORS + `tb_origin`
- 关联：
  - `ref/001-ors-baseline-comparison.md`
  - `../v3/fasttrade/001-layer-boundaries.md`（历史，不再作为实现基线）

---

## 1. 核心决策

```text
1. ORS 完全复刻公司 ORS 的业务行为。
   唯一业务改动：account query。
   订单 map、RMS、撤单、终态、回报时序、账户/持仓查询均以公司 ORS 为准。

2. ORS 的传输从公司 SHM 改为 Aeron。
   Aeron 只替换传输，不重新定义订单语义。

3. 取消 v3 的 L2。
   不再有 TradingChannel、OrderRegistry、FillLedger、平仓预扣。
   ORS 是订单状态权威。

4. L1 变成“ORS 通信 SDK”。
   SDK 只负责 Aeron、消息编解码、请求/响应关联、断线重连和 orderID 分配；
   SDK 不维护订单状态。

5. TradeBot + 多策略框架保持 tb_origin 设计不变。
   OrderStats、OrderIDStrategyMap、策略级订单视图继续留在 TradeBot。

6. LocalAgent 的数据获取逻辑不在本设计定稿，单独确认。
```

原则：

```text
可以改传输、部署和账户查询接入方式；
不能重新发明订单状态机；
不能让 SDK 或 TradeBot 再维护一份通道订单权威。
```

---

## 2. 目标与非目标

### 目标

- 复用公司 ORS 已被实盘验证的订单、撤单、RMS、账户和持仓行为
- 用 Aeron 替换 SHM，获得新的进程边界和可观测性
- 保持 tb_origin 的策略、订单视图和多策略运行方式
- 去掉 v3 L2 带来的第二套订单状态

### 非目标

- 不按交易所拆分 ORS 订单管理
- 不在 SDK 里做订单状态、风控或预扣
- 不把公司 ORS 的 SHM 结构原样嵌入 Aeron
- 不重构 TradeBot 的策略逻辑
- 不在本设计里确定 LocalAgent 的数据源和保留策略

---

## 3. 目标分层

```text
TradeBot + 多策略（L3）
  ├─ StrategyRuntime
  ├─ OrderStats / OrderIDStrategyMap
  └─ 策略级订单视图
        |
        v
ORS SDK（L1）
  ├─ Aeron 连接
  ├─ RequestMsg / ResponseMsg 编解码
  ├─ OrderID 分配
  ├─ 请求/响应关联
  └─ 断线重连
        |
        v
Aeron
        |
        v
ORS（L0，公司 ORS 核心）
  ├─ CTP TraderApi / MdApi
  ├─ 账户级订单 map
  ├─ RMS
  ├─ 撤单/终态/回报
  ├─ account/position query
  └─ 行情发布
        |
        v
CTP / 交易所
```

L2 不再存在。

---

## 4. ORS

### 4.1 定位

```text
一个 ORS 实例
  = 一个 CTP 账户
  + 一个 TraderApi 会话
  + 一个 MdApi 会话
  + 一张账户级订单 map
  + 一套账户级 RMS
```

一个账户可以交易多个交易所。**交易所不是订单管理边界**，只是订单字段和路由字段。

### 4.2 必须保留的公司 ORS 行为

- `RequestMsg` / `ResponseMsg` 语义
- `m_ordLocalMap` / `m_ordExchMap` 账户级订单映射
- `OrderInfo` 生命周期
- `NEW_ORDER_CONFIRM`、`CANCEL_ORDER_CONFIRM`、`CANCEL_ORDER_REJECT`、`TRADE_CONFIRM`、`ORDER_ERROR` 等响应
- 未知订单撤单的 `CANCEL_ORDER_REJECT`
- 撤单拒绝后原订单继续有效
- 终态订单清理
- RMS、撤单计数、账户级可平/预扣语义
- 账户查询和持仓查询
- 旧 front/session 过滤

### 4.3 唯一业务改动

account query 的接入方式和响应映射可以调整；**订单、撤单、RMS、持仓和终态逻辑不改**。

账户查询的字段、响应消息和 Aeron 映射在实现计划中单独列清楚，不能借 account query 改动顺手改订单状态。

### 4.4 源码基线

```text
业务基线：/Volumes/DevDisk/146/3/dalong/infrastructure/China
生产修复来源：/Users/wangjun/PG/RD/quantlink-trading/ors/China
Aeron 传输参考：当前 quantlink-ors 的 Aeron/发布/订阅实现
```

不直接把 `quantlink-trading/ors/China` 整体当成公司 ORS：

- 它是公司 ORS 的生产修复分支，不是 Aeron 分支
- 它包含 StrategyID、拆单尝试、Dashboard 相关改动
- 这些不属于“只改 account query”

详见 `ref/001-ors-baseline-comparison.md`。

---

## 5. Aeron 通信

### 5.1 原则

Aeron 只负责传输以下语义，不创造新订单状态：

```text
SDK -> ORS: RequestMsg
ORS -> SDK: ResponseMsg
ORS -> SDK: 行情/账户/持仓数据（具体主题在实现计划中确定）
```

订单主键仍是公司 ORS 的 `OrderID`。不在 SDK/ORS 之间重新引入一套 `orderRef` 状态。

### 5.2 消息边界

Aeron frame 必须能承载公司 ORS 的必要字段：

```text
OrderID
StrategyID / Product（如公司 ORS 使用）
AccountID
Symbol / Instrument
Side
Price / Quantity
Request_Type / Response_Type
ErrorCode / ErrorMsg
Exchange_Type
OrderSysID / TradeID
时间戳
```

具体编码使用公司 `RequestMsg` / `ResponseMsg` 的语义。是否使用现有 SBE 作为编码实现，必须另行确认；**编码格式不能改变字段语义**。

### 5.3 可靠性

- SDK 重连后允许重发未确认请求，但 ORS 必须按公司 OrderID/订单 map 做幂等或明确拒绝
- Aeron back-pressure 不能静默丢订单请求
- Response 必须可关联到 OrderID
- 断线期间不能把旧 Response 当新状态
- ORS 重启后的订单恢复策略按公司 ORS 行为，不新增 L2 对账层

---

## 6. ORS SDK（L1）

### 6.1 职责

```text
Aeron 连接/断线重连
RequestMsg 编码和发送
ResponseMsg 解码和回调
OrderID 分配（沿用公司 Connector 的唯一编号语义）
请求/响应关联
超时和错误上抛
```

### 6.2 不负责

```text
订单状态
订单 map
成交账本
RMS
平仓预扣
策略归属
读模型
```

### 6.3 与 TradeBot 的接口

SDK 向 TradeBot 提供与 `tb_origin` 兼容的回调：

```text
SendNewOrder
SendCancelOrder
ORSCallBack(ResponseMsg)
```

TradeBot 继续维护：

```text
OrderStats
m_ordMap
m_bidMap / m_askMap
OrderIDStrategyMap
```

SDK 不替 TradeBot 决定订单状态。

### 6.4 部署形态

默认作为 TradeBot 进程内的库使用。  
如果后续需要独立进程，SDK 进程也只能做传输和关联，不能演化成第二个 L2。

---

## 7. TradeBot 与多策略

保持不变：

- tb_origin 的 `Strategies/*`
- 多策略运行和 `OrderIDStrategyMap`
- 策略级 `OrderStats` / `OrderMap`
- `ORSCallBack` 状态处理
- 策略级 PnL 和信号计算

删除的只是 v3 L2 的通道订单状态和预扣，不是 TradeBot 的策略订单视图。

---

## 8. LocalAgent

本设计暂不定义 LocalAgent 的数据获取方式。

待确认问题：

- 从 Aeron Response 流读取，还是从 ORS 查询接口读取
- 是否单独订阅 account/position query 结果
- 订单/成交事实保留多久
- 是否允许 LocalAgent 反写任何交易状态（默认不允许）
- 与 TradeBot 的 MemLog/其他读模型如何分工

在确认前，LocalAgent 不进入交易主链路，不作为订单权威。

---

## 9. 状态所有权

| 状态 | 所有者 |
|---|---|
| CTP session / 登录 | ORS |
| 账户级订单 map | ORS |
| 订单状态、撤单、终态 | ORS |
| RMS、撤单计数、预扣 | ORS |
| 账户/持仓 venue fact | ORS |
| Aeron 请求/响应关联 | SDK |
| OrderID 分配 | SDK（沿用公司 Connector 语义） |
| 策略订单视图 | TradeBot |
| 策略 PnL / 信号 | TradeBot |
| 订单历史/读模型 | LocalAgent/ReadModel（待确认） |

---

## 10. 失败边界

- Aeron 不可用：SDK 拒绝新请求，明确上抛，不假装成功
- ORS 不可用：SDK 重连；TradeBot 不能自行补订单状态
- 未知订单撤单：ORS 按公司行为返回 `CANCEL_ORDER_REJECT`
- 订单已终态：ORS 按公司行为处理；不能由 SDK 静默吞掉
- 旧 front/session 回报：ORS 过滤
- 响应乱序/重复：按 OrderID 和公司 ORS 语义处理
- ORS 重启：按公司 ORS 的订单恢复行为，不新增 L2 对账

---

## 11. 与 v3 的关系

v3 的以下设计不再作为实现基线：

```text
L2 TradingChannel / OrderRegistry / FillLedger
L0 不持有订单状态权威
RMS 移到 L2 RiskService
v3 contract 的订单状态机作为 ORS 内部状态机
```

v3 文档保留为历史记录。  
v4 不要求兼容 v3 的 L2 运行时代码。

---

## 12. 待确认

1. Aeron 编码：公司 `RequestMsg/ResponseMsg` 结构直接序列化，还是映射到现有 SBE？
2. account query 的具体字段和响应格式。
3. SDK 是库还是独立进程；默认库。
4. 多账户部署：一账户一 ORS，沿用公司 ORS 模型。
5. LocalAgent 数据源和保留策略。

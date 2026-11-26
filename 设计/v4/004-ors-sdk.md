# ORS Java SDK 设计（FastTrade）

- 状态：DRAFT（2026-11-26）
- 使用方：`quantlink-fasttrade`
- 实现：Java 25
- 依赖：contract 1.0.0 Java 生成代码 + Aeron Java client
- 位置：独立工程 `quantlink-ors-sdk`，不放进 contract，也不放进 ORS 源码

---

## 1. 定位

```text
FastTrade / TradeBot
  -> quantlink-ors-sdk（Java 库）
  -> Aeron
  -> ORS v4
```

SDK 是 **L1 通信库**，不是订单状态层，不是 L2。

一个 SDK 客户端 = 一个 ORS 账户连接。  
一个 FastTrade 进程可以创建多个客户端，但每个客户端只对应一个 ORS 账户。

---

## 2. 一句话边界

SDK 负责：

```text
Aeron 连接/重连
contract 1.0.0 编解码
OrderID 分配
请求/响应关联
超时和错误上抛
回调分发
```

SDK 不负责：

```text
订单状态
订单 map
RMS
终态判断
平仓预扣
策略归属
交易所路由
```

订单状态仍由 ORS 持有；FastTrade 只保留自己的策略订单视图。

---

## 3. 工程形态

```text
quantlink-ors-sdk/
  build.gradle.kts
  settings.gradle.kts
  src/main/java/com/quantlink/ors/sdk/
    OrsClient.java
    OrsConfig.java
    OrsListener.java
    OrderIdAllocator.java
    OrsException.java
    internal/AeronTransport.java
    internal/Codec.java
  src/test/java/...
```

发布：

```text
com.quantlink.ors:ors-sdk:4.0.0
```

FastTrade 通过 Gradle/Maven 依赖该 artifact，不复制 SDK 源码。  
contract 通过 `com.quantlink.contract:venue-contract:1.0.0` 引入。

---

## 4. 公共 API

### `OrsConfig`

```java
public record OrsConfig(
    String aeronDirectory,
    String channel,              // aeron:ipc
    int requestStream,
    int responseStream,
    int accountStream,
    int marketDataStream,
    int sessionStream,
    String accountId,
    String venueId,
    String environment,
    Duration requestTimeout
) {}
```

### `OrsClient`

```java
public final class OrsClient implements AutoCloseable {
    public OrsClient(OrsConfig config, OrsListener listener);
    public void start();
    public long nextOrderId();

    public void submitNewOrder(OrsOrderRequest request);
    public void submitCancel(OrsCancelRequest request);
    public void queryAccount(AccountQuery request);

    @Override public void close();
}
```

### `OrsListener`

```java
public interface OrsListener {
    default void onResponse(OrsResponse response) {}
    default void onAccount(AccountSnapshot snapshot) {}
    default void onMarketData(MarketUpdate update) {}
    default void onSession(SessionEvent event) {}
    default void onError(OrsSdkException error) {}
}
```

### 请求对象

SDK 的请求对象是 contract 1.0.0 的 Java DTO/builder，不让 FastTrade 直接拼 SBE：

```text
OrsOrderRequest
  orderId / symbol / exchangeType / side / price / quantity
  orderType / duration / accountId / timestamp
  contractDescription ...
```

取消请求至少包含：

```text
OrderID
symbol
accountId
```

不要求调用方知道 CTP 的 `FrontID/SessionID`；这些由 ORS 订单 map 维护。

---

## 5. OrderID（参考 tb_origin）

按 `tb_origin` Connector 的编号语义：

```text
ORDERID_RANGE = 1_000_000
OrderID = clientId * ORDERID_RANGE + orderCount++
```

规则：

- `clientId` 是某个 ORS 账户下的客户端编号
- `orderCount` 是该客户端的递增序号
- `clientId` 必须唯一，不能只用进程内计数器
- `orderCount` 到达 `ORDERID_RANGE` 时必须换新的 `clientId`，不能回绕复用
- OrderID 是请求/回报关联键，不是订单状态
- FastTrade 的 `OrderIDStrategyMap` 继续按 OrderID 归属策略

`tb_origin` 的 `clientId` 来自 Connector 的 ClientStore。v4 没有 SHM ClientStore，所以需要等价的 Aeron 注册机制：

```text
OrsClient 启动
  -> ClientRegister(instanceId)
  -> ORS 返回 clientId
  -> SDK 用 clientId * 1_000_000 + orderCount
```

不能简单地固定 `clientId=0` 并在进程重启后从 0 重新计数；否则会与 ORS 里仍存活的订单发生 OrderID 冲突。

ClientRegister 需要加入 contract 1.0.0 的控制消息；具体字段在 contract 实现阶段补。

SDK 侧：

```java
AtomicInteger orderCount
int clientId
```

`clientId` 是启动注册结果，不写死在配置里。

---

## 6. 线程模型

Aeron Java client 是单 poller 模式：

```text
一个 SDK 客户端
  -> 一个 Aeron poll 线程
  -> 单线程分发 OrsListener 回调
  -> 用户回调不得阻塞
```

规则：

- `submitNewOrder` / `submitCancel` 可从调用线程加锁或投递队列
- `OrsListener` 回调在 SDK poll 线程执行
- 回调里的慢操作由 FastTrade 自己投递到业务线程
- 不在回调线程做订单状态大数据处理
- `close()` 停止 poll 线程并释放 publication/subscription

---

## 7. Aeron 可靠性

- `offer > 0` 才算发布成功
- `BACK_PRESSURED` 有限重试；失败上抛 `OrsSdkException`
- `NOT_CONNECTED` / `CLOSED` 不能当成功
- SDK 不静默丢订单请求
- 重连后不能把旧响应当新状态
- Response 按 OrderID 关联；account 按 requestId 关联
- SDK 不做自动重发已提交订单，避免重复下单；重试策略由 FastTrade 显式决定

---

## 8. 与 FastTrade 当前 AccessSDK 的关系

当前 FastTrade `access-sdk` 是 v3 venue-contract 客户端：

```text
AccessConfig + ChannelConfig
  -> 每个交易所一个 order/cancel stream
  -> AccessClient.submit(tradingChannelKey, OrderRequest)
  -> OrderUpdate / TradeEnvelope
```

v4 SDK 改成：

```text
OrsConfig（账户级，不按交易所分 channel）
  -> OrsClient.submitNewOrder(OrsOrderRequest)
  -> OrsResponse（公司 ORS ResponseType）
```

迁移时：

- 不复用 `ChannelConfig` 的按交易所路由
- 一个 OrsClient 对应一个账户/ORS
- FastTrade 的策略订单视图和 `OrderIDStrategyMap` 保留
- 不保留 v3 `OrderUpdate` / `CancelState` 作为 SDK 公共 API

---

## 9. SIM 与 LIVE（参考 tb_origin）

按 `tb_origin` 的方式，由上层决定运行模式：

```text
FastTrade --Sim  -> ModeType_Sim
FastTrade --Live -> ModeType_Live
```

SDK 不做 SIM/LIVE 模式判断，只接收目标 Aeron 配置：

```text
LIVE: FastTrade -> OrsClient -> Aeron -> ORS v4 -> CTP
SIM:  FastTrade -> OrsClient -> Aeron -> SimVenue v4
```

FastTrade 在启动参数/配置中选择目标；SDK 只负责连接对应 ORS/SimVenue。

SimVenue 必须实现同一 v4 语义，否则 SDK 在 SIM/LIVE 下会产生两套行为。

---

## 10. 测试

单元测试：

- contract 1.0.0 encode/decode golden frame
- OrderID 分配
- 请求/响应关联
- Aeron back-pressure 错误
- 回调线程不阻塞
- close 后不再发布

集成测试：

- SDK -> ORS v4：新单/撤单/未知撤单/成交/拒单
- SDK -> SimVenue v4：同样场景
- account query
- 多客户端多账户
- 断线重连

---

## 11. 不做

- 不把 SDK 放进 `quantlink-venue-contract`
- 不把 SDK 放进 ORS 核心源码
- 不在 SDK 维护订单状态或订单 map
- 不按交易所拆 SDK channel
- 不把 v3 `OrderUpdate` 状态机带进 v4 SDK

---

## 12. 已确认

1. SDK 使用独立仓库 `quantlink-ors-sdk`。
2. 使用 Java 回调接口，不使用 `CompletableFuture` 作为订单主链路。
3. OrderID 参考 `tb_origin`：`clientId * 1_000_000 + orderCount`。
4. 同时提供 Java 版行情和账户监听 API。
5. SIM/LIVE 由 FastTrade 上层决定，SDK 只连接目标 ORS/SimVenue。

## 13. 待确认

1. `ClientRegister` 的 Aeron 控制消息和 ORS 侧实现。
2. `clientId` 的分配/释放规则，以及跨重启复用边界。
3. OrderID 计数在交易日切换时是否重置；参考 tb_origin 的进程生命周期。
4. ClientRegister 和 contract 1.0.0 的最终消息布局。

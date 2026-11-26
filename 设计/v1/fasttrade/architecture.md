# QuantLink FastTrade 架构设计

- 日期：2026-11-14
- 状态：DRAFT
- 目标：Java 实现的交易运行时，架构与 `quantlink-trading` 保持一致
- 边界：本文只描述架构与契约，不包含代码实现

---

## 0. 结论先行

FastTrade 采用 trading 的运行时模型，而不是当前 V3/runner 的模型。

```text
一个 strategyID / OptionManage sid = 一个 TradeBot 进程
一个进程 = 多个 SimConfig = 多个 ExecutionStrategy
所有策略共享一个 ConfigParams、一个 OptionManager、一个回调线程
leg 就是 strategy，不是某个组合模块的内部对象
```

配置和运行状态分开：

```text
配置：ConfigParams + SimConfig + model/indicator + OptionsParams + position_init
      -> 数据库，版本化，可热加载参数

状态：持仓 + 策略运行字段
      -> 数据库，周期 checkpoint + 停止时 final snapshot
      -> 下次启动作为输入恢复
```

明确约束：

1. **绝不复用 C++ `quantlink-trading` 的代码、二进制或进程。**
2. **架构与 trading 一致**：进程模型、对象模型、回调链、多策略/OptionManage 语义保持一致。
3. **不引入 V3/current runner 的抽象**：不使用 `RuntimeEngine(List<Strategy>)`、`StrategyGroup`、`OptionPortfolioModule`、`AccountBook`、`PositionKeeper`、`AccountLedger`、lease、WAL 状态机。
4. 传输层可以使用 Java/Aeron IPC/SBE，但 `Connector` 的 callback 语义与 trading 一致。

---

## 1. 目标与非目标

### 1.1 目标

1. 一个 sid 一个进程，进程级隔离。
2. 一个进程可以运行多个 control entry / strategy。
3. 所有策略在同一回调线程串行执行，策略内部无锁。
4. 组合级共享状态由 `OptionManager` 单例维护。
5. `ConfigParams`、`SimConfig`、模型、期权参数、初始仓位从数据库加载。
6. 参数调整支持热加载，不重建策略、不影响持仓。
7. 运行状态（持仓、策略字段）写入数据库，作为下次启动输入。
8. 拓扑变化走进程重启，不做进程内拓扑热加载。
9. 回调线程内无 JDBC、HTTP、文件 IO、同步日志刷盘。

### 1.2 非目标

v1 明确不做：

- 多 venue 聚合；
- 多账户聚合；
- 一个账户多个 runner 共享账本；
- 线程级策略隔离；
- 一个策略一个线程；
- 进程内策略拓扑热加载；
- 完整 WAL/checkpoint/lease/fencing 状态机；
- shadow 事件总线；
- 多策略通用 SPI / StrategyGroup / AccountBook。

### 1.3 与 trading 的关系

只参考 trading 的架构和行为：

- `ConfigParams` + `SimConfig[]` 的进程内模型；
- `CommonClient` 的行情/ORS callback 分发；
- `ExecutionStrategy` 继承体系；
- `OptionManager` 组合级单例；
- `OptionManage` 作为控制面部署容器；
- 一个 sid 一个进程；
- 信号式 activate/deactivate/reload。

不复制：

- C++ 源码、二进制、共享内存布局；
- 全局 `m_simConfig` 指针的线程不安全实现细节；
- position 文件作为唯一运行状态来源；
- 无幂等、无状态持久化的缺陷。

### 1.4 明确不采用的设计

以下来自当前系统/V3 的设计，不作为 FastTrade 基础：

```text
RuntimeRunnerMain 单策略模型
RuntimeEngine(List<Strategy>)
StrategyContext 只读视图
AccountBook / PositionKeeper / AccountLedger
StrategyGroup / OptionPortfolioModule
单写者 + WAL/checkpoint + lease + 7 状态机
进程内 hot reload 状态机
```

FastTrade 的“热加载”只做参数，不做拓扑；FastTrade 的“状态持久化”是简单的周期快照，不是 WAL 账本。

---

## 2. 硬约束

```text
1. 一个 strategyID = 一个 TradeBot 进程。
2. 一个进程内可以存在 N 个 SimConfig / ExecutionStrategy。
3. 所有策略在同一个回调线程执行，禁止 per-strategy thread。
4. OptionManager 是进程级单例；一个进程只有一个组合上下文。
5. 配置读取、状态写入、热加载监听都在独立线程；回调线程不碰 DB。
6. 配置和运行状态分表；持仓不写回配置表。
7. 参数热加载不影响持仓/挂单；拓扑变化必须重启进程。
8. 进程崩溃时，只能恢复到最近一次状态 checkpoint；必须和柜台/ORS 对账。
9. 交易主路径禁止 HTTP、JDBC、文件 IO、同步日志刷盘。
```

---

## 3. 进程与线程模型

### 3.1 进程模型

```text
Agent / 运维
  └─ TradeBotMain --strategyID <sid>
       ├─ ConfigParams
       │    ├─ SimConfig[0]  DUMMY_STRAT
       │    ├─ SimConfig[1]  SIMPLE_HEDGING_STRAT
       │    └─ SimConfig[2..] OPTION_QUOTING_STRAT
       ├─ OptionManager
       ├─ CommonClient
       ├─ Connector
       ├─ ConfigWatcher
       └─ StateWriter
```

规则：

```text
一个 OptionManage sid = 一个进程
一个进程 = N 个 SimConfig = N 个 ExecutionStrategy
N 个 leg 共享 OptionManager 和回调线程
```

`OptionManage` 不是运行时类，是控制面的部署容器：

```text
OptionManage sid
├─ dummy underlying
├─ SimpleHedgingStrategy
├─ OptionQuotingStrategy C920
├─ OptionQuotingStrategy P920
└─ OptionQuotingStrategy C930
```

### 3.2 线程模型

```text
TradeBot 进程
├─ 回调线程
│    ├─ 行情 callback
│    ├─ ORS callback
│    ├─ 所有 ExecutionStrategy
│    └─ OptionManager 读写
├─ ConfigWatcher 线程
│    └─ 读数据库、校验版本、生成 pending reload
├─ StateWriter 线程
│    └─ 接收状态快照、批量写数据库
└─ 信号线程
     └─ SIGUSR1 / SIGTSTP / SIGUSR2
```

- 策略执行、订单状态、持仓状态、OptionManager 只在回调线程读写；
- ConfigWatcher 不直接修改策略对象；
- StateWriter 只接收不可变快照，不读取策略对象；
- 没有 per-strategy 线程；
- 没有线程级隔离。

### 3.3 隔离边界

```text
进程之间：隔离。一个 sid 崩溃不影响另一个 sid。
进程内部：不隔离。所有 leg 共享回调线程和全局状态。
```

这是 trading 的模型，不是缺陷。OptionManage 的 leg 本来就是一个组合，部分 leg 继续运行比整组停止更危险。

---

## 4. 运行时对象模型

### 4.1 对象映射

| trading C++ | FastTrade Java | 职责 |
|---|---|---|
| `TradeBot` main | `TradeBotMain` | 参数解析、DB 加载、策略创建、Connector 启动、信号处理 |
| `ConfigParams` | `ConfigParams` | 进程级配置与运行时索引 |
| `SimConfig` | `SimConfig` | 一个 control entry：instrument、model、指标、PnL、exec strategy |
| `ExecutionStrategy` | `ExecutionStrategy` | 策略基类：订单、仓位、MD/ORSCallBack、SendOrder |
| `OptionQuotingStrategy` | `OptionQuotingStrategy` | 单期权双边报价 |
| `SimpleHedgingStrategy` | `SimpleHedgingStrategy` | 期货 Delta 对冲 |
| `HedgingStrategy` | `HedgingStrategy` | 期权腿 IOC/被动对冲 |
| `OptionManager` | `OptionManager` | 进程级组合状态：option map、组合 Greeks、bias、hedge queues |
| `CommonClient` | `CommonClient` | 行情/ORS 回调、策略分发、信号处理 |
| `Connector` | `Connector` | 行情/订单 I/O；Java 可用 Aeron IPC/SBE |
| `OrderIDStrategyMap` | `OrderIdStrategyMap` | ORS 回报按 OrderID 路由到策略 |
| position files | `StateRepository` | 从 DB 加载/写入运行状态 |

### 4.2 ConfigParams

进程级单例，保存持久化配置和运行时索引。

持久化字段：

```text
sid
product
accountId
venueId
runMode
orsId
optionStrategy
updateIntervalMs
globalParams（JSONB）
activeConfigVersion
enabled
```

运行时派生字段：

```text
m_strategyCount
m_simConfig[]
m_baseConfigMap       baseName -> SimConfig
m_simConfigMap        symbol -> SimConfig 列表
m_simConfigList       symbolID -> SimConfig 列表
m_simConfig           当前正在回调的策略
m_indicatorMap
m_orderIdStrategyMap
```

数据库加载后由 `ConfigBuilder` 构建派生字段；这些字段不存库。

### 4.3 SimConfig

一个 control entry = 一个 SimConfig。

持久化字段：

```text
sid
configVersion
strategyKey          跨版本稳定
seq                  control list 顺序
strategyType         DUMMY / OPTION_QUOTING / SIMPLE_HEDGING / HEDGING
instrument
instrument2
exchange
baseName
modelId
sessionStart / sessionEnd
enabled
riskParams（JSONB）
strategyParams（JSONB）
```

运行时派生字段：

```text
m_execStrategy
m_instruMap
m_indicatorList
m_option
m_dateConfig
m_calculatePNL
```

### 4.4 ExecutionStrategy

每个 SimConfig 对应一个 `ExecutionStrategy` 子类。

```java
abstract class ExecutionStrategy {
    SimConfig simConfig;
    Instrument instrument;

    long netPosition;
    double buyPrice;
    double sellPrice;
    long buyQty;
    long sellQty;
    long buyTotalQty;
    long sellTotalQty;
    double realizedPnl;
    double fees;

    boolean active;
    boolean onFlat;
    boolean onCancel;
    boolean onExit;

    Map<Long, Order> bidOrders;
    Map<Long, Order> askOrders;

    abstract void sendOrder();

    void mdCallBack(MarketDataMessage update) { ... }
    void orsCallBack(OrderResponse response) { ... }
    void setTargetValue(...) { ... }
    void handleSquareOff() { ... }
    void handleSquareOn() { ... }

    StrategyState snapshotState() { ... }
    void restoreState(StrategyState state) { ... }
}
```

leg 就是 strategy：

- 自己的 `m_netpos`；
- 自己的订单簿；
- 自己的 `SendOrder()`；
- 自己的 `MDCallBack()` / `ORSCallBack()`；
- 自己的状态快照。

### 4.5 OptionManager

进程级单例。

```java
final class OptionManager {
    Map<String, Option> optionMap;
    Map<String, Option> underlyingMap;

    double portDelta;
    double portDeltaWithMultiplier;
    double portVega;
    double portPnl;

    OptionRuntimeParams params;
    List<ScoreElem> hedgeScoreQueue;
    List<ScoreElem> iocScoreQueue;

    void portfolioGreeks() { ... }
    void setBiasParameters() { ... }
    void setHedgingParameters() { ... }
    void reloadParams(OptionRuntimeParams params) { ... }
}
```

- `portfolioGreeks()` 遍历 `ConfigParams.m_baseConfigMap`，汇总所有 option leg；
- `SimpleHedgingStrategy` 使用 `portDeltaWithMultiplier`；
- `HedgingStrategy` 消费 `hedgeScoreQueue` / `iocScoreQueue`；
- Greeks/PnL 是派生值，不持久化；
- `OptionRuntimeParams` 来自数据库，可热加载。

### 4.6 CommonClient / Connector

`Connector` 负责行情和订单回报 I/O：

- Java 实现可以使用 Aeron IPC/SBE；
- 对上层暴露与 trading 相同的 callback 语义；
- 回调线程调用 `CommonClient`，再由 `CommonClient` 分发给策略。

`CommonClient` 负责：

```text
sendInfraMdUpdate
sendIndUpdate
sendInfraOrsUpdate
orsCallback
handleSignals
```

### 4.7 OrderIdStrategyMap

ORS 回报按 `OrderID` 找到对应 `ExecutionStrategy`：

```java
Map<Long, ExecutionStrategy> orderIdStrategyMap;
```

策略发单时注册；回报到达时路由到 `ORSCallBack`。进程内所有策略共用这个 map。

---

## 5. 行情与订单回调链

### 5.1 行情回调

```text
Connector 收到行情
  -> CommonClient.sendInfraMdUpdate(update)
  -> CommonClient.sendIndUpdate(update)
      -> simIter = m_simConfigList[update.symbolID]
      -> 遍历该 symbol 对应的所有 SimConfig
          -> m_simConfig = 当前策略
          -> 更新 Instrument/Tick
          -> IndicatorCallback
              -> calculateTargetPnl
              -> ExecutionStrategy.setTargetValue
                  -> sendOrder()
          -> MDCallback
              -> ExecutionStrategy.mdCallBack(update)
```

### 5.2 订单/成交回报

```text
Connector 收到 ORS response
  -> CommonClient.sendInfraOrsUpdate(response)
  -> orsCallback
      -> orderIdStrategyMap[response.orderId]
      -> ExecutionStrategy.orsCallBack(response)
```

### 5.3 线程语义

- 上述所有调用都在**同一个回调线程**；
- 没有 per-strategy 线程；
- 一个策略慢，后面所有策略等待；
- 一个策略抛异常/崩溃，整个进程受影响；
- 这是 trading 的 callback 模型。

### 5.4 ORS 行情事件如何触发 TradeBotMain

`TradeBotMain` 不是每笔行情的处理函数，它只在启动时完成装配：

```text
TradeBotMain
  -> 创建 ConfigParams / SimConfig[] / ExecutionStrategy[]
  -> 创建 CommonClient
  -> 创建 Connector(mdChannel, mdStream, execChannel, execStream)
  -> 启动 Connector 回调循环
```

行情事件的触发链：

```text
CTP adapter / 模拟交易所 / 行情源
  -> Aeron publication: MarketDataV2
  -> FastTrade Connector 的 MD subscription.poll
  -> 解码 MarketDataV2
  -> 校验 venue/instrument/session/epoch/seq
  -> 映射为 MarketUpdateNew / Instrument
  -> CommonClient.onMarketData(update)
  -> CommonClient.sendIndUpdate(update)
  -> m_simConfigList[symbolID] 对应的所有 SimConfig
  -> IndicatorCallback -> setTargetValue -> sendOrder
  -> MDCallback -> ExecutionStrategy.mdCallBack
```

关键点：

1. **ORS 不是行情的最终来源。**  
   当前链路里 CTP adapter 发布 `MarketDataV2`，ORS core 自己也订阅 `MarketDataSubscriber` 用于撮合。  
   FastTrade 应该作为另一个独立订阅者，直接订阅同一个 `mdChannel/mdStream`，而不是让 ORS 通过 HTTP/回调调用 `TradeBotMain`。

2. **如果 ORS 以后输出归一化行情**，FastTrade 就订阅 ORS 的 MD stream；无论发布者是 adapter 还是 ORS，触发方式不变：`Connector.poll -> CommonClient -> strategies`。

3. **不要在 `TradeBotMain` 里写行情处理逻辑。**  
   `TradeBotMain` 只负责装配和启动；策略分发在 `CommonClient`；策略逻辑在 `ExecutionStrategy`。

4. **MD 和 ORS 回报必须串行进入策略。**  
   推荐一个 `Connector` 线程同时 poll MD 和 exec subscription，按顺序调用 `CommonClient`；或者 I/O 线程只入队，由一个回调线程统一消费。  
   禁止 MD 线程和 ORS 线程同时直接调用策略。

5. **按 instrumentId 分发。**  
   启动时构建：

   ```text
   instrumentId -> List<SimConfig>
   ```

   等价于 trading 的 `m_simConfigList[symbolID]`。  
   一笔行情命中多个 SimConfig 时，按 `seq` 顺序依次执行。

6. **行情入口不做 DB/HTTP。**  
   行情解码、分发、策略回调都在 Connector 回调线程；配置和状态由 ConfigWatcher/StateWriter 独立线程处理。

7. **可选 gap 检测。**  
   使用 `MarketDataV2.sourceSessionId/sourcePublicationEpoch/seq` 按 `(venue, exchange, instrument)` 检测缺口；缺口时停止该 scope 的开仓，恢复后继续。  
   v1 至少记录日志和指标；不要静默跳过。

### 5.5 trading `loopMD` 与 FastTrade `poll` 的对应

两者语义一致：**主动轮询 + 同步回调**，不是内核事件推送。

```text
trading:
  while (active) {
      loopMD();      // 每个 SHM MD client 取一条
      loopResponse();
  }

FastTrade:
  while (running) {
      mdSub.poll(handler, fragmentLimit);
      execSub.poll(handler, fragmentLimit);
      idle();
  }
```

差异：

| 维度 | trading `loopMD` | FastTrade `poll` |
|---|---|---|
| 数据源 | 多个 SHM MD client queue | Aeron subscription fragments |
| 每轮处理 | 每个 client 一条 | 最多 fragmentLimit 条 |
| 空闲策略 | busy-spin；无绑核时 1ns sleep | `IdleStrategy` |
| 线程 | 默认 MD + ORS response 同一线程 | Connector 单线程 |
| 回调 | `MarketUpdateAvailable -> HandleUpdates -> m_mdcb` | `poll handler -> CommonClient` |
| 丢失 | ring 覆盖/丢弃 | Aeron `offer` 失败/断连 |

实现要求：

- `Connector` 内部保留 `handleMarketData -> CommonClient.sendInfraMdUpdate` 的层次，不要在 poll handler 里直接调用策略；
- 默认把 MD 和 ORS response 放在同一个回调线程，对应 trading 的 `ASYNC_MD_AND_RESPONSE=false`；
- 如果订阅多个 MD stream，按 trading `loopMD` 的方式轮询，避免一个 stream 饿死其他 stream 和订单回报；
- 每个 stream 每轮使用较小的 `fragmentLimit`，保证订单回报和多个 venue 的公平性。

---

## 6. 多策略与 OptionManage

### 6.1 control list

数据库中的 `tradebot_strategy` 按 `seq` 排序，等价于 trading 的 control list：

```text
seq=0  DUMMY_STRAT          标的期货 dummy
seq=1  SIMPLE_HEDGING_STRAT 期货对冲
seq=2  OPTION_QUOTING_STRAT 期权 C920
seq=3  OPTION_QUOTING_STRAT 期权 P920
```

校验规则：

1. dummy 标的必须在最前；
2. SimpleHedging 必须在 OptionQuoting 之前；
3. 每个策略的 instrument/exchange/model 必须有效；
4. OptionQuoting 必须有期权参数和合约；
5. strategyKey 在同一 sid 内唯一且跨版本稳定。

### 6.2 OptionManage

`OptionManage` 是控制面部署容器，不是运行时类。

控制面负责：

```text
1. 生成/更新 tradebot_process、tradebot_strategy、tradebot_indicator、
   tradebot_option_params、tradebot_position_init
2. 发布 config_version
3. 启动/停止对应 sid 的 TradeBot 进程
```

运行时只负责：

```text
读取 active version -> 构建 ConfigParams + SimConfig[] -> 创建 ExecutionStrategy
```

### 6.3 leg 是一等策略

每个 leg 都是独立的 `ExecutionStrategy`：

```text
OptionQuotingStrategy C920
OptionQuotingStrategy P920
SimpleHedgingStrategy
```

它们共享：

```text
ConfigParams
OptionManager
回调线程
进程
```

但它们不是：

```text
某个 OptionPortfolioModule 的内部对象
某个 StrategyGroup 的成员
```

没有 `OptionPortfolioModule`，没有 `StrategyGroup`。

---

## 7. 配置数据库

### 7.1 表设计

```sql
-- 配置版本
CREATE TABLE tradebot_config_version (
  sid          BIGINT NOT NULL,
  version      BIGINT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED')),
  config_hash  TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  PRIMARY KEY (sid, version)
);

CREATE UNIQUE INDEX ux_tradebot_active_version
  ON tradebot_config_version (sid)
  WHERE status = 'ACTIVE';

-- 进程级配置
CREATE TABLE tradebot_process (
  sid                 BIGINT PRIMARY KEY,
  product             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  venue_id            TEXT NOT NULL,
  run_mode            TEXT NOT NULL,
  ors_id              TEXT NOT NULL,
  option_strategy     INT NOT NULL DEFAULT 0,
  update_interval_ms  INT NOT NULL,
  global_params       JSONB NOT NULL DEFAULT '{}',
  active_version      BIGINT NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT true
);

-- 一个 SimConfig 一行
CREATE TABLE tradebot_strategy (
  id               BIGSERIAL PRIMARY KEY,
  sid              BIGINT NOT NULL REFERENCES tradebot_process(sid),
  config_version   BIGINT NOT NULL,
  strategy_key     TEXT NOT NULL,
  seq              INT NOT NULL,
  strategy_type    TEXT NOT NULL,
  instrument       TEXT NOT NULL,
  instrument2      TEXT,
  exchange         TEXT NOT NULL,
  base_name        TEXT,
  model_id         BIGINT,
  session_start    TIME,
  session_end      TIME,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  risk_params      JSONB NOT NULL DEFAULT '{}',
  strategy_params  JSONB NOT NULL DEFAULT '{}',
  UNIQUE (sid, config_version, strategy_key),
  UNIQUE (sid, config_version, seq)
);

-- 原先 model 文件里的 indicator 行
CREATE TABLE tradebot_indicator (
  id              BIGSERIAL PRIMARY KEY,
  strategy_id     BIGINT NOT NULL REFERENCES tradebot_strategy(id),
  seq             INT NOT NULL,
  indicator_type  TEXT NOT NULL,
  params          JSONB NOT NULL DEFAULT '{}',
  UNIQUE (strategy_id, seq)
);

-- 原先 OptionsParams 文件
CREATE TABLE tradebot_option_params (
  sid             BIGINT NOT NULL,
  config_version  BIGINT NOT NULL,
  params          JSONB NOT NULL,
  PRIMARY KEY (sid, config_version)
);

-- 原先 position/<sid>.<instrument> 的初始值
CREATE TABLE tradebot_position_init (
  sid             BIGINT NOT NULL,
  config_version  BIGINT NOT NULL,
  strategy_key    TEXT NOT NULL,
  instrument      TEXT NOT NULL,
  buy_qty         BIGINT NOT NULL DEFAULT 0,
  sell_qty        BIGINT NOT NULL DEFAULT 0,
  buy_avg         NUMERIC(18, 6),
  sell_avg        NUMERIC(18, 6),
  PRIMARY KEY (sid, config_version, strategy_key, instrument)
);
```

### 7.2 配置版本发布

```sql
BEGIN;

INSERT INTO tradebot_config_version (sid, version, status, config_hash)
VALUES (?, ?, 'DRAFT', ?);

INSERT INTO tradebot_process (...) VALUES (...);
INSERT INTO tradebot_strategy (..., config_version, ...) VALUES (...);
INSERT INTO tradebot_indicator (...) VALUES (...);
INSERT INTO tradebot_option_params (..., config_version, ...) VALUES (...);
INSERT INTO tradebot_position_init (..., config_version, ...) VALUES (...);

-- 校验通过后
UPDATE tradebot_config_version
SET status = 'SUPERSEDED'
WHERE sid = ? AND status = 'ACTIVE';

UPDATE tradebot_config_version
SET status = 'ACTIVE', published_at = now()
WHERE sid = ? AND version = ?;

COMMIT;
```

规则：

- 所有子表与版本行同一事务；
- 同一 sid 只能有一个 ACTIVE；
- `config_hash` 覆盖全部子表；
- watcher 不会看到“版本已激活但子表未写完”的状态。

### 7.3 映射

```text
ConfigParams        <- tradebot_process + tradebot_config_version
SimConfig[]         <- tradebot_strategy ORDER BY seq
SimConfig.model     <- tradebot_indicator
OptionManager 参数  <- tradebot_option_params
初始仓位            <- tradebot_position_init
运行状态            <- tradebot_strategy_state / tradebot_position_state
```

### 7.4 校验规则

启动和热加载共用校验：

```text
- sid 存在且 enabled
- ACTIVE version 唯一
- 所有子表 config_version 一致
- config_hash 匹配
- strategy_key 在 sid 内唯一
- seq 不重复
- strategy_type 合法
- OptionManage：
  - 必须有 dummy underlying
  - dummy 在最前
  - SimpleHedging 在 OptionQuoting 之前
- OptionQuoting 必须有 option 参数和合约
- instrument / exchange 有效
- account / venue / ORS 与 agent 绑定一致
- position_init 的 instrument 属于对应策略
```

校验失败：

- 启动：退出，不进入交易；
- 热加载：保留旧配置，告警，不应用。

---

## 8. 启动流程

```text
TradeBotMain --strategyID <sid>
  1. 读取 ACTIVE config_version
  2. 读取 tradebot_process
  3. 读取 tradebot_strategy ORDER BY seq
  4. 读取 tradebot_indicator
  5. 读取 tradebot_option_params
  6. 读取 tradebot_position_init
  7. 校验 config_hash / topology
  8. 构建 ConfigParams
  9. 构建 SimConfig[] / m_baseConfigMap / m_simConfigMap / m_simConfigList
 10. 按 strategy_type 创建 ExecutionStrategy
 11. 加载运行状态（见 §10）
 12. 初始化 CommonClient / Connector
 13. 启动 ConfigWatcher
 14. 启动 StateWriter
 15. 进入回调循环
```

不再读取：

```text
control.OptionManage.<sid>
config_CHINA.<sid>.cfg
model.*
OptionsParams.<sid>
position/<sid>.*
```

日志仍可写文件；配置/模型/期权参数/初始仓位/运行状态全部从数据库来。

---

## 9. 参数热加载

### 9.1 范围

可以热加载：

```text
风险阈值：maxPosition / maxLoss / maxOrders / maxOrderQty
期权参数：delta/vega/position bias、hedge threshold、quote width
策略标量参数：cooldown、hedgeRatio、order slop
全局安全开关：可安全切换的布尔参数
```

需要重启：

```text
增加/删除/重排 SimConfig
strategy_type 变化
instrument / instrument2 / exchange 变化
account / venue / ORS 变化
model / indicator 拓扑变化
option chain / 合约集合变化
position_init 变化
```

原则：

> 参数热加载，拓扑不热加载。

### 9.2 ConfigWatcher

```text
ConfigWatcher 线程：
  每 1s 查询 ACTIVE version
  发现新版本：
    用 REPEATABLE READ 一次性读取 process/strategy/indicator/option params
    校验 config_hash
    计算 topology fingerprint
    如果 topology 变化 -> 标记 RESTART_REQUIRED，告警，不应用
    如果只是参数变化 -> 构建 PendingConfig，放入 AtomicReference
```

- ConfigWatcher 不直接修改 `ConfigParams` / `SimConfig` / `OptionManager`；
- 它只读 DB、校验、生成不可变参数快照；
- 可选 PostgreSQL `LISTEN/NOTIFY` 立即唤醒；轮询作为兜底。

### 9.3 在回调线程应用

```text
回调线程在每次行情/定时入口检查 pendingConfig：
  如果有：
    1. 校验 topology 仍未变化
    2. 替换 ConfigParams 的标量参数
    3. 替换每个策略的 StrategyRuntimeParams
    4. 替换 OptionManager 的 OptionRuntimeParams
    5. 记录 configVersion / hash
    6. 清空 pendingConfig
```

为什么必须在回调线程：

- 策略和 `OptionManager` 不是线程安全的；
- 只有回调线程能安全读写；
- 不需要锁；
- 不会出现“改了一半”的状态。

### 9.4 参数对象整包替换

不要逐字段修改全局对象。

```java
final class StrategyRuntimeParams {
    final int maxPosition;
    final double maxLoss;
    final int maxOrders;
    final double quoteWidth;
    final double deltaBias;
    // ...
}

final class OptionRuntimeParams {
    final double deltaHedgeThreshold;
    final double iocHedgeThreshold;
    final double deltaBias;
    final double vegaBias;
    // ...
}
```

应用时一次性替换引用；旧对象由 GC 回收。这样回调线程不会看到中间状态。

### 9.5 失败处理

- 加载失败：保留旧配置，告警，下个周期重试；
- hash 不匹配：拒绝；
- topology 变化：`RESTART_REQUIRED`，不应用；
- 应用异常：保留旧参数，记录错误，必要时进入 reduce-only。

### 9.6 SIGUSR2

保留 trading 的 `SIGUSR2` 语义：

```text
SIGUSR2 -> 立即触发一次 ConfigWatcher 检查
        -> 仍然在回调线程应用
```

轮询和信号可以共存。

---

## 10. 运行状态持久化

### 10.1 配置与状态分开

```text
配置：策略应该怎么跑
状态：策略现在跑到哪了
```

持仓是运行状态，不是配置。禁止把持仓写回 `tradebot_process` / `tradebot_strategy` / `tradebot_position_init`。

`position_init` 只是初始 seed；运行状态是 `tradebot_position_state`。

### 10.2 状态表

```sql
-- 每次 checkpoint 的元信息
CREATE TABLE tradebot_state_checkpoint (
  sid             BIGINT NOT NULL,
  state_seq       BIGINT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('RUNNING', 'STOPPED', 'RESET')),
  config_version  BIGINT,
  strategy_count  INT NOT NULL,
  state_hash      TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (sid, state_seq)
);

-- 策略级运行状态
CREATE TABLE tradebot_strategy_state (
  sid             BIGINT NOT NULL,
  strategy_key    TEXT NOT NULL,
  trading_day     DATE NOT NULL,
  state_seq       BIGINT NOT NULL,
  config_version  BIGINT,
  state_json      JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (sid, strategy_key)
);

-- 持仓级运行状态，替代 position 文件
CREATE TABLE tradebot_position_state (
  sid              BIGINT NOT NULL,
  strategy_key     TEXT NOT NULL,
  instrument       TEXT NOT NULL,
  trading_day      DATE NOT NULL,
  buy_qty          BIGINT NOT NULL DEFAULT 0,
  sell_qty         BIGINT NOT NULL DEFAULT 0,
  buy_avg          NUMERIC(18, 6),
  sell_avg         NUMERIC(18, 6),
  buy_total_qty    BIGINT NOT NULL DEFAULT 0,
  sell_total_qty   BIGINT NOT NULL DEFAULT 0,
  realized_pnl     NUMERIC(18, 6) NOT NULL DEFAULT 0,
  fees             NUMERIC(18, 6) NOT NULL DEFAULT 0,
  state_seq        BIGINT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (sid, strategy_key, instrument)
);
```

### 10.3 运行中 checkpoint

```text
每 1s / 5s（可配）：
  回调线程生成不可变 StrategyStateSnapshot
  -> 放入有界队列
  -> StateWriter 批量 upsert DB
```

- 回调线程只拷贝内存，不碰 JDBC；
- StateWriter 独立线程；
- 队列满：跳过本次周期 checkpoint，计数/告警，不阻塞回调；
- 一份 checkpoint 用一个 `state_seq`，所有行同事务写入。

### 10.4 停止时 final snapshot

```text
1. 停止新开仓
2. 撤掉 working orders
3. 按配置决定是否平仓
4. 生成最终状态快照
5. StateWriter 事务写入，等 commit
6. 标记 status = STOPPED
7. 退出进程
```

- 如果停止语义是平仓，最终状态是 flat；
- 如果停止语义是保留仓位，最终状态带仓位；
- final snapshot 写失败不能静默退出，必须重试/告警。

### 10.5 启动恢复

优先级：

```text
1. 加载 config
2. 构建 ExecutionStrategy
3. 查 tradebot_state_checkpoint 最新 state_seq
   - 有有效 checkpoint -> 用 state 恢复
   - 没有 -> 用 tradebot_position_init
4. 校验 strategy_key/config topology 兼容
5. 可选：与 ORS/账户持仓快照对账
6. 进入回调循环
```

状态缺失：

```text
新策略 -> 用 position_init
旧状态存在但 strategy_key 不存在 -> orphan，保留并告警
strategy_key 存在但 instrument/strategy_type 变化 -> 拒绝恢复，要求 reset/restart
```

### 10.6 崩溃恢复

崩溃时只能恢复到最近一次 checkpoint。

```text
DB state
  vs
ORS / 账户持仓 / 挂单快照
```

处理：

| 情况 | 动作 |
|---|---|
| 一致 | 恢复，进入正常交易 |
| 数量差异 ≤ 容差 | 记录告警，继续观察 |
| 数量差异 > 容差 | `RECONCILE_REQUIRED`，禁止开仓，人工确认或 reduce-only |
| 快照不可信/缺失 | 禁止开仓，人工处理 |
| 读到的 checkpoint 不完整 | 使用上一份完整 checkpoint，告警 |

不要静默用账户快照覆盖策略状态。

### 10.7 事务

```sql
BEGIN;

INSERT INTO tradebot_state_checkpoint
  (sid, state_seq, status, config_version, strategy_count, state_hash, updated_at)
VALUES (?, ?, 'RUNNING', ?, ?, ?, now());

INSERT INTO tradebot_strategy_state
  (sid, strategy_key, trading_day, state_seq, config_version, state_json, updated_at)
VALUES (...)
ON CONFLICT (sid, strategy_key)
DO UPDATE SET ...;

INSERT INTO tradebot_position_state
  (sid, strategy_key, instrument, trading_day, state_seq, ...)
VALUES (...)
ON CONFLICT (sid, strategy_key, instrument)
DO UPDATE SET ...;

COMMIT;
```

读取：

```text
取 max(state_seq)
-> 读 checkpoint
-> 读该 seq 下的所有 strategy/position 行
-> 校验 strategy_count / state_hash
-> 才认为是一份完整快照
```

### 10.8 不持久化的内容

```text
组合 Delta / Vega / Gamma
期权理论价 / IV / basisEMA（除非策略明确要求）
未实现 PnL
行情缓存
```

这些启动后从持仓 + 行情重新计算。

### 10.9 挂单

持仓状态不包含 working orders。

启动时：

```text
1. 查询 ORS/柜台挂单快照
2. 撤掉本 sid 的旧挂单
3. 与 DB 状态对账
```

v1 不把订单簿写进状态表；订单簿以 ORS/柜台为准。后续如果需要，可以把 working order 摘要写入 `state_json`，但不改变主模型。

---

## 11. 生命周期与信号

### 11.1 启动

```text
Agent -> TradeBotMain --strategyID <sid>
  -> 从 DB 加载 config
  -> 从 DB/position_init 恢复状态
  -> 启动 Connector
  -> 启动 ConfigWatcher / StateWriter
```

### 11.2 信号

```text
SIGUSR1 -> activate
SIGTSTP -> squareoff + deactivate
SIGUSR2 -> 立即检查配置版本
```

信号处理影响进程内所有策略，不是某个策略线程。

### 11.3 停止

```text
SIGTSTP / 运维 stop
  -> 停止新开仓
  -> 撤单
  -> 可选平仓
  -> final snapshot 写 DB
  -> status=STOPPED
  -> 退出
```

### 11.4 拓扑变化

```text
新增/删除/重排策略
strategy_type/instrument/account/venue/ORS 变化
model/option chain 变化
```

处理：

```text
控制面发布新 config_version
ConfigWatcher 标记 RESTART_REQUIRED
Agent 停止旧进程
启动新进程
新进程加载新配置
```

不在进程内做拓扑热加载。

---

## 12. 风险、对账与故障

### 12.1 风控

v1 沿用 trading 的进程内风控：

```text
每个 ExecutionStrategy 的 m_thold
账户级/全局 riskParams
下单前本地检查
ORS/柜台最终校验
```

没有 V3 的 lease/fencing/risk cache 状态机。

### 12.2 对账

- 策略持仓以 `tradebot_position_state` / 内存 `m_netpos` 为准；
- 账户/柜台持仓通过 ORS/账户快照定期对账；
- 对账只用于校验/告警/reduce-only，不自动覆盖策略状态；
- 对账差异超过阈值时禁止开仓。

### 12.3 故障

| 故障 | 行为 |
|---|---|
| 进程崩溃 | 重启；加载最近 checkpoint；与柜台对账 |
| 策略异常 | 整个进程受影响；由 agent 重启 |
| 行情断流 | 策略停止开仓；告警；恢复后继续 |
| DB 不可用 | 启动失败；运行中 checkpoint 失败只告警，final 失败必须重试/告警 |
| 配置加载失败 | 保留旧配置；启动失败则不交易 |
| 状态写失败 | 周期失败告警；final 失败不能静默退出 |

---

## 13. 性能设计

1. 回调线程内禁止 JDBC/HTTP/文件 IO/同步日志。
2. ConfigWatcher、StateWriter 独立线程。
3. 状态快照只拷贝必要字段，不阻塞回调。
4. 行情/订单 buffer 预分配，避免热路径分配。
5. 一个进程一个回调线程，不做 per-strategy 线程。
6. OptionManager 的 Greeks 计算按策略需要触发，不必每 tick 全量重算。
7. 状态 checkpoint 周期可配，默认 1s/5s，按日志量调整。
8. 用 Aeron IPC/SBE 时，保持单 writer、无锁、无阻塞。

延迟目标沿用现有约束：

```text
tick -> decision p99 < 5ms
decision -> Aeron publish p99 < 1ms
```

---

## 14. 模块规划

建议新模块：

```text
backend/tradebot-runtime/
  src/main/java/com/quantlink/fasttrade/
    TradeBotMain.java
    config/
      ConfigParams.java
      SimConfig.java
      ConfigLoader.java
      ConfigWatcher.java
      ConfigBuilder.java
      ConfigValidator.java
    client/
      CommonClient.java
      Connector.java
      OrderIdStrategyMap.java
    strategy/
      ExecutionStrategy.java
      OptionQuotingStrategy.java
      SimpleHedgingStrategy.java
      HedgingStrategy.java
    option/
      OptionManager.java
      Option.java
      Instrument.java
    state/
      StrategyState.java
      StateSnapshot.java
      StateWriter.java
      StateRepository.java
      StateRestorer.java
    position/
      PositionStateRepository.java
    signal/
      SignalHandler.java
    metrics/
      RuntimeMetrics.java
```

约束：

- 不依赖当前 `runtime-runner` / `RuntimeEngine` / V3 设计；
- 可以复用 `shared/aeron`、SBE、控制面 DB/API、agent、模拟交易所/CTP adapter；
- 交易主路径不使用 Spring/HTTP/JDBC。

---

## 15. 分阶段落地与验收

### Phase 1：配置与启动

- 建表；
- `ConfigLoader` / `ConfigBuilder` / `ConfigValidator`；
- `TradeBotMain` 从 DB 构建 `ConfigParams + SimConfig[]`；
- 启动一个 `SimpleHedgingStrategy`；
- 验收：不读 control/config/model/position 文件。

### Phase 2：回调链与多策略

- `Connector` + `CommonClient`；
- 行情分发 `m_simConfigList`；
- ORS 回报 `OrderIdStrategyMap`；
- 一个进程两个策略；
- 验收：同一行情命中多个策略，订单回报正确路由。

### Phase 3：OptionManage

- 多个 `OptionQuotingStrategy` + `SimpleHedgingStrategy`；
- `OptionManager.portfolioGreeks()`；
- `SetBiasParameters` / `SetHedgingParameters` 接线；
- 验收：组合 Delta/Vega 汇总、leg 独立订单/持仓。

### Phase 4：热加载

- `ConfigWatcher`；
- 只热加载参数；
- topology 变化标记 `RESTART_REQUIRED`；
- 验收：改阈值/期权参数不重启生效；改 instrument 必须重启。

### Phase 5：状态持久化

- `tradebot_state_checkpoint` / `strategy_state` / `position_state`；
- 周期 checkpoint；
- final snapshot；
- 启动恢复 + 对账；
- 验收：正常停止后重启恢复；kill -9 后恢复最近 checkpoint；不一致进入 reduce-only。

### Phase 6：模拟交易所 / CTP

- 模拟交易所 端到端；
- CTP adapter；
- 成交/订单/持仓对账；
- 验收：下单、成交、撤单、持仓、重启恢复。

---

## 16. 未决问题

1. `strategy_key` 的生成规则：由控制面分配 UUID，还是 `sid + 业务 code`。
2. checkpoint 周期与崩溃容忍度：1s、5s 还是按成交笔数触发。
3. 是否把 working orders 也写入状态表，还是完全依赖 ORS 快照。
4. `OptionManager` 的 `basisEMA`、模型 IV 等状态是否需要跨重启保留。
5. `position_init` 的人工 reset 流程和权限。
6. DB 不可用时，停止阶段是否允许写本地 emergency snapshot。
7. model/indicator 的 JSONB schema 如何版本化。
8. 传输层是否统一用 Aeron IPC，还是保留可替换的 Connector 实现。
9. 进程 supervisor 的 restart 策略：失败次数、退避、告警。
10. 多账户/多 venue 是否需要，若需要，不在 v1 范围内。

---

## 附录 A：OptionManage 数据库示例

```text
tradebot_process
  sid=92201, product=ax3, account=..., mode=LIVE,
  option_strategy=1, active_version=7

tradebot_strategy (config_version=7)
  seq=0, strategy_key=au_dummy,   type=DUMMY_STRAT,           instrument=au_F_6_SFE
  seq=1, strategy_key=au_hedge,   type=SIMPLE_HEDGING_STRAT,  instrument=au_F_6_SFE
  seq=2, strategy_key=au_c920,    type=OPTION_QUOTING_STRAT,  instrument=au2612C920
  seq=3, strategy_key=au_p920,    type=OPTION_QUOTING_STRAT,  instrument=au2612P920

tradebot_option_params (sid=92201, config_version=7)
  delta_hedge_threshold=...
  ioc_hedge_threshold=...
  delta_bias=...
  vega_bias=...
  position_bias=...
  quote_width=...

tradebot_position_init (sid=92201, config_version=7)
  strategy_key=au_c920, instrument=au2612C920, buy_qty=0, sell_qty=0
```

运行时：

```text
TradeBotMain --strategyID 92201
  -> ConfigParams
  -> SimConfig[4]
  -> ExecutionStrategy[4]
  -> OptionManager
  -> 回调线程
```

## 附录 B：热加载示例

```text
控制面：
  发布 config_version=8
  只修改 tradebot_option_params.delta_hedge_threshold

ConfigWatcher：
  读到 version=8
  topology fingerprint 不变
  -> pendingConfig

回调线程：
  替换 OptionManager.params
  记录 version=8
  -> 不重启、不影响持仓
```

拓扑变化：

```text
控制面：
  tradebot_strategy 新增 seq=4

ConfigWatcher：
  topology fingerprint 变化
  -> RESTART_REQUIRED

Agent：
  停止 TradeBot
  启动 TradeBot
  -> 新进程加载 version=8
```

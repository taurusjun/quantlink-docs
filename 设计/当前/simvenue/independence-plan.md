# SimVenue 独立方案

> 已被 [独立设计](superpowers/specs/2026-11-16-simvenue-design.md) 取代。
> 本文保留为历史草案；其中的 V2 消息和不存在的 contract 路径不再适用。

- 日期：2026-11-15
- 状态：SUPERSEDED
- 范围：把 SimVenue 从 `quantlink-fin` 拆为独立模拟交易所
- 不包含：AccessRuntime、TradeBot、CTP、多账户、多 venue

## 0. 目标

```text
SimVenue = 独立进程 + 独立仓库 + 独立发布
quantlink-fin 不再构建 SimVenue
AccessRuntime / 其他系统只通过 Aeron 合同连接
```

最终仓库：

```text
quantlink-venue-contract/
  └─ shared/sbe + venue-contract

quantlink-simvenue/
  ├─ sim-exchange
  └─ sim-venue

quantlink-fasttrade/
  └─ access-runtime / access-sdk
```

## 1. 边界

SimVenue 负责：

```text
MD
Order / Cancel
OrderUpdate / Trade
Position / Account / Session
SimExchange 撮合
VenueStore 状态持久化
健康文件
```

SimVenue 不负责：

```text
策略
AccessSDK / TradeBot
控制面
多账户
多 venue
真实 CTP
```

## 2. 依赖独立合同

SimVenue 不拥有 `venue-contract`，也不复制合同源码。

```text
SimVenue 依赖 contract
AccessRuntime 依赖 contract
两者不互相依赖
```

合同设计、版本、发布见：

```text
../../quantlink-venue-contract/docs/plan.md
```

## 3. SimVenue 仓库结构

```text
quantlink-simvenue/
├── settings.gradle.kts
├── build.gradle.kts
├── sim-exchange/
│   ├── SimExchange
│   ├── SimOrderCodec（内部/测试用）
│   └── SimExchangeAeronMain
├── sim-venue/
│   ├── SimVenueMain
│   ├── SimVenueGateway
│   ├── SimVenueMarketDataGenerator
│   ├── VenueStore
│   └── resources/logback.xml
└── docs/
```

依赖：

```text
com.quantlink.contract:venue-contract:<version>
```

不依赖：

```text
quantlink-fin
control-plane
runtime
runtime-runner
```

## 4. SimVenue 使用的合同

具体合同定义见 `../../quantlink-venue-contract/docs/plan.md`。SimVenue 只实现/使用以下 V2 消息：

```text
MD              MarketDataV2
Order           OrderRequestV2
Cancel          CancelRequestV2
OrderUpdate     OrderUpdateV2
Trade           TradeV2
Position        PositionSnapshotV2
Account         AccountSnapshot
Session         VenueSession
```

`SimOrderCodec` 只保留在 SimVenue 内部或测试中，不作为 Access 合同。

## 5. 构建与发布

工具链：

```text
Java 25
```

发布物：

```text
sim-venue-<version>.tar
sim-venue-<version>.zip
```

启动：

```bash
JAVA_HOME=<jdk25> \
./bin/sim-venue \
  --aeron-dir /var/lib/quantlink-fin/aeron \
  --venue-id SIMVENUE \
  --account SIMVENUE-001 \
  --snapshot-file state/sim-venue-snapshot.json \
  --journal-file state/sim-venue-journal.jsonl \
  --health-file state/sim-venue-health.json
```

运行环境必须显式指定 Java 25，避免系统默认 Java 11 启动失败。

## 6. 测试

单元/网关测试：

```text
SimExchangeTest
SimExchangeAeronGatewayTest
SimVenueGatewayTest
SimVenueGatewaySecurityTest
VenueStoreTest
```

独立进程验收：

```text
1. installDist
2. 启动 SimVenue
3. 写健康文件
4. Aeron MD 有输出
5. order/cancel 能收到 update/trade
6. 重启后 VenueStore 恢复
```

跨仓库 E2E 放到 Access 方案，不在本方案内。

## 7. 迁移步骤

1. 创建 `quantlink-venue-contract`
2. 冻结 contract v0.1（SBE 哈希、stream 默认值、envelope）
3. 创建 `quantlink-simvenue`
4. 复制 `sim-exchange` + `sim-venue`
5. 修改 Gradle 依赖为 contract artifact
6. 删除跨仓库测试依赖：
   - `P0EndToEndTest`
   - `P0AeronEndToEndTest`
   这些属于 quantlink-fin 集成测试，不进入独立 SimVenue 仓库
7. 跑 `:sim-exchange:test`、`:sim-venue:test`
8. 跑 `installDist` 和 standalone smoke
9. 从 `quantlink-fin` 删除 SimVenue 构建
10. AccessRuntime 后续只依赖 contract

## 8. 验收

```text
quantlink-simvenue 独立构建成功
不依赖 quantlink-fin
standalone 启动成功
health 文件生成
MD / OrderUpdate / Trade 可被外部订阅
restart 后状态恢复
```

## 9. 风险

| 风险 | 处理 |
|---|---|
| contract 两边漂移 | 只保留 `quantlink-venue-contract` 一份 |
| Java 版本不一致 | 发布脚本固定 Java 25 |
| 跨仓库测试丢失 | 保留核心测试；P0 集成测试留在 quantlink-fin |
| SBE 变更 | contract 版本化 + 哈希冻结 |
| state 文件格式变化 | 独立版本号 + 兼容读取 |
| 两个仓库发布顺序 | 先发布 contract，再发布 SimVenue |

## 10. 不包含

```text
AccessRuntime
AccessSDK
TradeBot
CTP
多账户
多 venue
MD 共享
```

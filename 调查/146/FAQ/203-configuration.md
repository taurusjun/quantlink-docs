# 配置模型

- 日期：2026-11-21
- 状态：DRAFT（设计文档，未写代码）
- 范围：TB 的 IPC 通道配置、策略配置、ORS 配置边界和校验规则
- 关联：`201-tb-ipc-model.md`、`202-trading-channel-and-routing.md`、`204-strategy-runtime-and-optionmanager.md`、`206-contract-catalog.md`

---

## 1. 原则

保持 146 的扁平风格：

```text
key = value
交易所是 section
stream key 直接写
一个进程一份配置
不引入 connections 中间层
```

边界：

```text
TB 配置：IPC 通道 + CONTRACTS + 策略列表
策略配置：策略参数 + leg ContractKey
ORS 配置：登录 + 自己绑定的通道
```

TB 配置不写：

```text
ORS_ID
BROKER_ID
INVESTOR_ID
ACCOUNT_KEY
账户快照
```

TB 只认 IPC；ORS 在通道后面。

---

## 2. 文件角色

```text
tradebot.cfg          一个 TradeBot 进程
strategies/<key>.cfg  一个策略实例
ors-<id>.cfg          一个 ORS 进程（部署侧）
```

TB 不需要知道 `ors-<id>.cfg` 是否存在；部署时让 ORS 和 TB 绑定同一组 stream。

---

## 3. TB 配置

```ini
TB_ID = tb-metals-01
ENVIRONMENT = LIVE
CHANNEL = aeron:ipc

EXCHANGES = BSE, NSE_FO

[BSE]
COMMAND_STREAM      = 44444
EXECUTION_STREAM    = 55555
STATE_STREAM        = 55556
SESSION_STREAM      = 55558
MARKET_DATA_STREAM  = 12988
CONTRACTS           = BANKNIFTY1088260200-10

[NSE_FO]
COMMAND_STREAM      = 555555
EXECUTION_STREAM    = 666666
STATE_STREAM        = 666667
SESSION_STREAM      = 666669
MARKET_DATA_STREAM  = 1907
CONTRACTS           = BANKNIFTY1088260200-10

[STRATEGIES]
14526 = strategies/pair-01.cfg
```

字段：

| 字段 | 含义 |
|---|---|
| `TB_ID` | TB 实例标识 |
| `ENVIRONMENT` | 部署标识 |
| `CHANNEL` | IPC channel |
| `EXCHANGES` | 通道 section 列表 |
| `[EXCHANGE]` | 一组交易/行情 IPC；section 名就是 `TradingChannelKey` |
| `COMMAND_STREAM` | 订单命令 |
| `EXECUTION_STREAM` | 订单/成交回报 |
| `STATE_STREAM` | 仓位/账户快照 |
| `SESSION_STREAM` | channel/session/READY/水位 |
| `MARKET_DATA_STREAM` | 行情 |
| `CONTRACTS` | 该通道可见的 instrument 列表 |
| `[STRATEGIES]` | `strategyId = 策略配置路径`；strategyId 为数字 |

`CONTRACTS` + section 名构成 `ContractKey`：

```text
[BSE] CONTRACTS = BANKNIFTY1088260200-10
  -> BSE:BANKNIFTY1088260200-10
```

同一个 symbol 可以出现在两个 section，得到两个不同 `ContractKey`。

`CONTRACTS` 只负责“这个通道可见哪些合约”，不在这里写 expiry / strike / underlying。

合约元数据统一来自 `206-contract-catalog.md` 的 `ContractCatalog`：

```text
ContractKey -> ContractCatalogEntry
```

策略配置只引用 `ContractKey`；缺目录或目录字段非法时，不进入 READY。

### 3.1 同一交易所多通道

```ini
[BSE-01]
EXCHANGE = BSE
COMMAND_STREAM = 44444
...

[BSE-02]
EXCHANGE = BSE
COMMAND_STREAM = 64444
...
```

`TradingChannelKey` 是 section 名，不是 exchange 名。

---

## 4. 策略配置

```ini
STRATEGY_ID = 14526
STRATEGY_NAME = pair-01
TYPE = pairwise-arb
URGENCY = NORMAL
ACCOUNT = OWN

LEG_A = BSE:BANKNIFTY1088260200-10
LEG_B = NSE_FO:BANKNIFTY1088260200-10

MAX_LEG_IMBALANCE = 1
```

`STRATEGY_ID` 是数字策略实例 ID，必须在 TB 内唯一；`STRATEGY_NAME` 只用于显示。

`ACCOUNT` 就是 146 的 `accountID`（146 `ACCOUNT` / `m_account` / `m_reqMsg.AccountID` / `NetPnlInfo.m_accountId`），用于账户快照、持仓和 PnL 读模型，不参与订单路由。示例 `OWN` 只是 146 的配置值，不能写死；配置和读取时统一 trim 尾部空格。

策略不写：

```text
ORS_ID
BROKER_ID
INVESTOR_ID
COMMAND_STREAM
AccessClient
clientOrderId
```

需要显式通道时：

```ini
LEG_A_CHANNEL = BSE
```

---

## 5. ORS 配置

ORS 配置是部署侧，不是 TB 交易模型：

```ini
ORS_ID = ors-bse-01
CHANNEL = aeron:ipc
EXCHANGE = BSE

FRONT_ADDR_ORS = tcp://127.0.0.1:7776
FRONT_ADDR_MD  = tcp://127.0.0.1:7777

BROKER_ID = 8699001
INVESTOR_ID = 02332426
PASSWORD = ******

COMMAND_STREAM      = 44444
EXECUTION_STREAM    = 55555
STATE_STREAM        = 55556
SESSION_STREAM      = 55558
MARKET_DATA_STREAM  = 12988
```

ORS 配置保留 `ORS_ID` / `BROKER_ID` / `INVESTOR_ID`；TB 配置不需要这些字段。

一个 ORS 进程服务多个交易所时，部署侧为每个交易所绑定一套通道；TB 看到的是多个 section。

---

## 6. 校验

```text
EXCHANGES 中的每个 section 都存在
每个 section 的五条 stream 完整
同一 section 的 stream 不重复
CONTRACTS 只出现在允许的 section
默认一个 ContractKey 只有一条 ContractRoute
策略文件存在，strategyId 唯一
[STRATEGIES] 的 key 与策略文件 STRATEGY_ID 一致
每个策略显式配置 ACCOUNT（146 accountId），不能写死默认值
策略 leg 的 ContractKey 存在
策略 leg 的 ContractKey 在 ContractCatalog 中存在
OPTION 的 expiryDate / strikePrice / optionType / underlyingSymbol 完整
策略 leg 的 channel 覆盖存在
TB 配置不得包含 ORS_ID / BROKER_ID / INVESTOR_ID / ACCOUNT_KEY（策略配置里的 ACCOUNT 除外）
```

校验失败：

```text
不进入 READY
不启动策略
不静默选默认通道
```

---

## 7. 与 146 的对照

| 146 | 新系统 |
|---|---|
| `[BSE] ORSREQUESTSHMKEY` | `[BSE] COMMAND_STREAM` |
| `[BSE] ORSRESPONSESHMKEY` | `[BSE] EXECUTION_STREAM` |
| `[BSE] MDSHMKEY` | `[BSE] MARKET_DATA_STREAM` |
| `[BSE] CLIENTSTORESHMKEY` | 不使用；TB/channel 管理订单号 |
| `TICKERS` | `CONTRACTS` per section |
| `ORS_ID` | 只放 ORS 配置 |
| `INVESTOR_ID_<EXCH>` | 只放 ORS 配置 |
| response queue -> exchange map | 每通道独立 EXECUTION |
| `AccountID` / 账户统计 | 只用于 AccountSnapshotService 与读模型，不进入 TB 路由 |

---

## 8. 示例文件

```text
../examples/146-style/tradebot.cfg
../examples/146-style/ors-bse.cfg
../examples/146-style/ors-nse-fo.cfg
../examples/146-style/strategies/pair-01.cfg
```

示例中的密码、地址、investor 都是占位值。

---

## 9. 未决问题

1. 同一合约多通道的显式覆盖规则。
2. 一个 ORS 进程多交易所时，部署侧如何组织多套通道。
3. `CHANNEL` 是否允许每个 section 不同。
4. 是否允许 `include`；当前保持扁平。
5. 某合约独立行情通道的配置形式。
6. `AccountSnapshotService` 是否与 TB 同进程。

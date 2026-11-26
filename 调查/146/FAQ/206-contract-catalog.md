# 合约与期权目录（ContractCatalog / OptionCatalog）

- 日期：2026-11-23
- 状态：DRAFT（设计文档，未写代码）
- 范围：合约身份、合约元数据、期权目录、OptionManager 腿视图、205 读模型 join
- 关联：`201-tb-ipc-model.md`、`202-trading-channel-and-routing.md`、`203-configuration.md`、`204-strategy-runtime-and-optionmanager.md`、`205-gui-data-and-control-plane.md`、`014-optionmanager-design.md`

---

## 0. 一页结论

```text
ContractKey
  = (exchange, instrumentId)
  = 只做身份和路由

ContractCatalog
  = 合约元数据的唯一来源

OptionCatalog
  = ContractCatalog 的 Option 专用投影/索引

OptionLeg
  = OptionManager 内部的腿视图，不复制目录事实
```

字段统一命名：

```text
expiryDate
strikePrice
optionType
underlyingContractKey
underlyingSymbol
exerciseStyle
multiplier
tickSize
```

关键规则：

```text
expiry / strike / underlying 不进 ContractKey
expiry / strike / underlying 不进 OrderFact / TradeFact
ContractRoute / MarketDataRoute 只带 contractKey
需要元数据时统一 join ContractCatalog
```

---

## 1. 为什么需要单独一层

`ContractKey` 只回答“这是哪个合约”：

```text
ContractKey = (exchange, instrumentId)
```

它不回答：

```text
到期日
行权价
Call / Put
标的
乘数
tick size
行权方式
```

这些字段如果塞进 `ContractKey`：

- key 会变长、变复杂
- 同一合约在行情/订单/持仓里出现不同的 key 形式
- expiry/strike 变更会污染路由身份
- 读模型无法稳定 join

所以统一为：

```text
ContractKey -> ContractCatalogEntry
```

`ContractCatalog` 是只读共享目录，`OptionCatalog` 是它的 Option 视图。

---

## 2. `ContractCatalogEntry`

```text
ContractCatalogEntry
  contractKey
  exchange
  instrumentId
  symbol
  instrumentName
  instrumentType
  currency
  multiplier
  tickSize
  expiryDate?
  strikePrice?
  optionType?
  underlyingContractKey?
  underlyingSymbol?
  exerciseStyle?
  catalogVersion
  updatedAt
  source
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `contractKey` | `ContractKey` | 是 | `(exchange, instrumentId)`，唯一 |
| `exchange` | string | 是 | ContractKey 的 exchange 部分，便于查询 |
| `instrumentId` | string | 是 | ContractKey 的 instrumentId 部分 |
| `symbol` | string | 是 | 显示/交易 symbol |
| `instrumentName` | string | 否 | 146 `InstrumentName` 对应的短名 |
| `instrumentType` | enum | 是 | `FUTURE / OPTION / EQUITY / SPREAD / OTHER` |
| `currency` | string | 否 | 币种 |
| `multiplier` | decimal | 是 | 合约乘数，> 0 |
| `tickSize` | decimal | 是 | 最小变动价位，> 0 |
| `expiryDate` | `u32 YYYYMMDD` | 条件 | FUTURE / OPTION 需要；EQUITY 可为空 |
| `strikePrice` | decimal | 条件 | OPTION 必填；非 OPTION 必须为空 |
| `optionType` | enum | 条件 | `CALL / PUT`；非 OPTION 必须为空 |
| `underlyingContractKey` | `ContractKey?` | 否 | 标的可交易时填写；指数期权可为空 |
| `underlyingSymbol` | string | 条件 | OPTION 必填；用于指数/不可交易标的 |
| `exerciseStyle` | enum | 条件 | `EUROPEAN / AMERICAN`；OPTION 必填 |
| `catalogVersion` | `u64` | 是 | 单调递增目录版本 |
| `updatedAt` | timestamp | 是 | 最后更新时间 |
| `source` | enum | 是 | `VENUE / CONFIG / MANUAL` |

### 2.1 `instrumentType`

```text
FUTURE
OPTION
EQUITY
SPREAD
OTHER
```

不把 `pair / cso / hedge` 放进 `instrumentType`：

```text
pair / cso / hedge 是策略/腿语义
instrumentType 是合约类型
```

### 2.2 `optionType`

统一值：

```text
CALL
PUT
```

非期权为 `null`。

146 映射：

```text
146 CE -> CALL
146 PE -> PUT
146 X / 空 -> null
```

### 2.3 `expiryDate`

统一格式：

```text
YYYYMMDD
```

例如：

```text
20150625
```

不使用本地化日期字符串，也不使用浮点年份。

### 2.4 `underlying`

分两个字段：

```text
underlyingContractKey?
underlyingSymbol
```

规则：

```text
标的本身是可交易合约 -> underlyingContractKey 填写
标的是指数/不可交易品种 -> underlyingContractKey 为空，underlyingSymbol 填写
OPTION 至少要有 underlyingSymbol
```

不要从 `instrumentId` 字符串里解析 underlying。

### 2.5 `catalogVersion`

```text
u64
```

每次目录内容变化递增。读模型/查询可以记录自己使用的版本。

不要把 `catalogVersion` 放进 `ContractKey`。

---

## 3. `OptionCatalogEntry`

```text
OptionCatalogEntry
  contractKey
  exchange
  underlyingContractKey?
  underlyingSymbol
  expiryDate
  strikePrice
  optionType
  exerciseStyle
  multiplier
  tickSize
  catalogVersion
  updatedAt
  source
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `contractKey` | `ContractKey` | 是 | 期权合约 key，唯一 |
| `exchange` | string | 是 | ContractKey 的 exchange 部分，便于查询 |
| `underlyingContractKey` | `ContractKey?` | 否 | 标的可交易时填写 |
| `underlyingSymbol` | string | 是 | 标的显示/查询名 |
| `expiryDate` | `u32 YYYYMMDD` | 是 | 到期日 |
| `strikePrice` | decimal | 是 | 行权价 |
| `optionType` | enum | 是 | `CALL / PUT` |
| `exerciseStyle` | enum | 是 | `EUROPEAN / AMERICAN` |
| `multiplier` | decimal | 是 | 合约乘数 |
| `tickSize` | decimal | 是 | 最小变动价位 |
| `catalogVersion` | `u64` | 是 | 与 ContractCatalog 一致 |
| `updatedAt` | timestamp | 是 | 更新时间 |
| `source` | enum | 是 | `VENUE / CONFIG / MANUAL` |

### 3.1 它不是第二套事实

```text
OptionCatalog = ContractCatalog 的 Option 投影
```

不是独立维护的第二份 expiry/strike/underlying。

要求：

```text
OptionCatalogEntry.contractKey 必须存在于 ContractCatalog
OptionCatalogEntry 的 expiryDate/strikePrice/optionType/multiplier/tickSize
  必须与 ContractCatalog 对应记录一致
```

如果存储上为了查询性能单独建表，也必须由 `ContractCatalog` 生成/校验，不能手写两套。

### 3.2 来源

```text
VENUE   = 交易所/柜台合约查询
CONFIG  = 虚拟期权、合成合约、测试合约
MANUAL  = 人工覆盖，必须带审计
```

冲突处理：

```text
同一 contractKey 的 venue/config 冲突 -> 启动/刷新失败
不静默选一个
MANUAL 覆盖必须显式标记 source=MANUAL 并记录操作者
```

---

## 4. `OptionLeg`

`OptionLeg` 是 OptionManager 内部视图，不是全局目录。

```text
OptionLeg
  legKey
  strategyId
  role              OPTION | HEDGE | UNDERLYING
  contractKey
  underlyingContractKey?
  underlyingSymbol
  expiryDate
  strikePrice
  optionType
  multiplier
```

规则：

```text
legKey 在 StrategyRuntime 内稳定
同一个 contractKey 可以出现在不同策略/不同腿
不能因为 contractKey 相同就合并 OptionLeg
```

`role` 是策略/腿语义：

```text
OPTION
HEDGE
UNDERLYING
```

它不是 `instrumentType`，也不是 `ContractCatalog` 字段。

---

## 5. Key 与元数据的边界

### 5.1 身份

```text
ContractKey = (exchange, instrumentId)
```

只做：

```text
订单路由
行情路由
持仓 key
PnL key
事实关联
```

### 5.2 元数据

```text
ContractCatalogEntry
```

只做：

```text
合约展示
期权语义
校验
读模型 join
OptionManager 目录
```

### 5.3 不进入交易事实

`OrderFact` / `TradeFact` 不复制：

```text
expiryDate
strikePrice
optionType
underlyingContractKey
underlyingSymbol
```

它们只带 `contractKey`。

读模型需要时统一 join `ContractCatalog` / `OptionCatalog`。

### 5.4 不进入路由

`ContractRoute`：

```text
contractKey -> tradingChannelKey
```

`MarketDataRoute`：

```text
contractKey -> marketDataChannelKey + streamId
```

路由只回答“发到哪”，不回答“这个合约是什么”。

---

## 6. 读模型 join 规则

### 6.1 `OrderReadModel`

```text
contractKey
symbol
instrumentName
optionType?
strikePrice?
expiryDate?
underlyingContractKey?
underlyingSymbol?
exchange
...
```

### 6.2 `PnlReadModel`

```text
contractKey
symbol
instrumentName
optionType?
strikePrice?
expiryDate?
underlyingContractKey?
underlyingSymbol?
exchange
...
```

### 6.3 `PositionReadModel`

```text
contractKey
optionType?
strikePrice?
expiryDate?
underlyingContractKey?
underlyingSymbol?
...
```

### 6.4 `MarketDataSnapshot`

行情事实和快照只保留 `contractKey`。

如果 GUI 需要显示 underlying/strike/expiry：

```text
MarketDataSnapshot -> join ContractCatalog
```

不要把元数据写进每一帧行情。

### 6.5 `OptionDeltaReadModel`

205 已把 `OptionDeltaReadModel` 作为正式读模型；206 提供它的合约/期权元数据。

```text
OptionDeltaReadModel
  contractKey
  underlyingContractKey?
  underlyingSymbol
  underlyingPrice
  expiryDate
  strikePrice
  optionType
  volatility
  delta
  position
  symbolDelta
  groupDelta
  asOf
  source
```

Delta 是计算值，不是 `ContractCatalog` 字段。

---

## 7. 校验

### 7.1 ContractCatalog

```text
contractKey 唯一
multiplier > 0
tickSize > 0
source ∈ VENUE | CONFIG | MANUAL
OPTION:
  expiryDate 必填
  strikePrice 必填
  optionType 必填
  underlyingSymbol 必填
  exerciseStyle 必填
非 OPTION:
  strikePrice 必须为空
  optionType 必须为空
  underlyingSymbol 必须为空
FUTURE:
  expiryDate 必填
```

### 7.2 OptionCatalog

```text
contractKey 唯一
contractKey 必须存在于 ContractCatalog
exchange 必须等于 contractKey.exchange
source 必须与 ContractCatalog 一致
对应 ContractCatalog.instrumentType = OPTION
字段必须与 ContractCatalog 一致
underlyingContractKey 如果存在，必须存在于 ContractCatalog
```

### 7.3 路由

```text
ContractRoute 的 contractKey 必须在 ContractCatalog
MarketDataRoute 的 contractKey 必须在 ContractCatalog
缺目录 -> 不进入 READY
缺目录 -> 不启动策略
```

### 7.4 禁止

```text
禁止从 instrumentId 字符串解析 expiry
禁止从 instrumentId 字符串解析 strike
禁止从 instrumentId 字符串解析 underlying
禁止从 instrumentId 字符串猜 Call/Put
```

这些必须在目录里显式存在。

---

## 8. 146 映射

| 146 字段/对象 | 206 字段 |
|---|---|
| `ContractDescription.InstrumentName` | `instrumentName` |
| `ContractDescription.Symbol` | `symbol` |
| `ContractDescription.ExpiryDate` | `expiryDate` |
| `ContractDescription.StrikePrice` | `strikePrice` |
| `ContractDescription.OptionType` | `optionType`（CE→CALL，PE→PUT，X→null） |
| `OptionManager.m_underlyingMap` | `underlyingContractKey` / `underlyingSymbol` |
| `OptionCatalog`（014） | `OptionCatalogEntry` |
| `OptionLeg`（014） | `OptionLeg`（统一命名） |

146 的 `ExpiryDate` 是 `YYYYMMDD` 整数，和 206 的 `expiryDate` 一致。

---

## 9. tbadmin 字段来源对照

tbadmin 的 Option Delta 相关字段来源：

| tbadmin 字段 | 来源 | 新系统落点 |
|---|---|---|
| `ExpiryDate / ExpireYear` | `ContractDescription` / DB | `ContractCatalog.expiryDate` |
| `Strike / StrikePrice` | `ContractDescription` / DB / VirtualOption model | `ContractCatalog.strikePrice` |
| `OptionType` | `ContractDescription` / 字符串解析 | `ContractCatalog.optionType` |
| `Underlying` | `GetOptionUnderlying(instrument)` / DB | `ContractCatalog.underlyingContractKey` / `underlyingSymbol` |
| `UnderlyingPrice` | 最新行情 | 行情事实 / Delta 读模型 |
| `Vol` | 常量 / model 文件 | 定价配置或 OptionDelta 读模型 |
| `Delta` | tbadmin 本地计算 | OptionGreeks 计算，不进 ContractCatalog |
| `SymbolDelta` | `Delta * Pos` | OptionDelta 读模型 |
| `GroupDelta` | tbadmin 聚合 | OptionDelta 读模型 |

结论：

```text
tbadmin 的 expiry/strike/underlying 是运行时从 DB / instrument 字符串 / model 里拼出来的
新系统统一放到 ContractCatalog
```

---

## 10. 版本与刷新

```text
ContractCatalog.catalogVersion
OptionCatalog.catalogVersion
```

建议：

```text
目录更新 -> catalogVersion + 1
读模型/查询记录使用的 catalogVersion
刷新使用原子替换
不要原地修改正在被读的 entry
```

如果 venue 与 config 冲突：

```text
拒绝刷新
保留旧版本
报警
```

不要静默覆盖。

---

## 11. 未决问题

1. 指数期权没有可交易 `underlyingContractKey` 时，`underlyingSymbol` 的唯一来源。
2. `SPREAD` / 组合合约的 `underlyingContractKey` 如何表达。
3. 期权 `exerciseStyle` 的 venue 来源和默认值。
4. `catalogVersion` 是否要进入 `OrderReadModel` / `PnlReadModel` 做审计。
5. 同一合约在多个 venue 的 metadata 冲突处理。
6. 盘中 multiplier / tickSize 变更是否允许；默认视为 immutable。
7. 虚拟期权的 `source=CONFIG` 与真实期权的优先级。

---

## 12. 与其他文档的关系

```text
201  定义 ContractKey
202  定义 ContractRoute / MarketDataRoute
203  定义 CONTRACTS 只做身份列表
204  引用 ContractCatalog / OptionCatalog
205  OrderReadModel / PnlReadModel / PositionReadModel join 本目录
014  OptionManager 使用 OptionCatalog / OptionLeg 视图
```

本文件是合约/期权元数据的唯一权威；其他文档不再各自定义 `expiry / strike / underlying` 字段。

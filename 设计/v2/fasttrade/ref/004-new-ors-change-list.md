# 004 新系统 ORS 改动清单

- 状态：DRAFT
- 日期：2026-11-25
- 范围：新系统 `quantlink-ors`（CTP）
- 基准：
  - TB：`tb_origin = /Volumes/DevDisk/git/tb_origin/tbsrc`
  - ORS：`/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/ors/China`
  - 历史对照：`003-146-ors-parity.md`
- 已定决策：
  - CTP 持仓查询：保留
  - STP：默认关闭，可选开启
  - MARKET：允许
  - 当前只做 SHFE；CFFEX/ZCE 暂不实施

---

## 1. 结论

新 ORS 保持薄适配器：

```text
不加 offset 推断
不加平仓预扣/释放
不拆单
不做 STP
不做 RMS
```

ORS 只改 CTP 语义和状态机：

```text
1. TIF/FAK 映射
2. OnRspOrderInsert ErrorID=0
3. 订单/成交状态时序
4. CTP 持仓查询的昨仓计算
5. 平昨 flag
6. 撤单中间态/终态
7. CFFEX/ZCE 的 TIF 拒绝（当前只做 SHFE，暂不实施）
```

真正影响开平正确性的 AUTO/预扣/整笔 fallback 在 L2 改。

### 1.1 改动总表

| 类别 | 改动 | 位置 | 为什么 |
|---|---|---|---|
| ORS 必改 | TIF/FAK 映射 | `CtpAdapter::fillInsert` | `tb_origin` 的 CROSS 全部走 FAK；当前 `FAK -> CV` 会让 aggressive 单变成全成或全撤 |
| ORS 必改 | `OnRspOrderInsert` ErrorID=0 | `CtpAdapter::onInsertRejected` | 公司 China ORS 对 NEWORDER 一律按拒单处理；新 ORS 直接 return 会把订单挂死 |
| ORS 必改 | 订单/成交状态时序 | `onRtnOrder` / `onRtnTrade` | 公司 ORS：ACK 一次、Trade 前不 FILLED、Trade 更新 `filledQty`、终态移除 |
| ORS 必改 | 昨仓计算 | `CtpQueryService` | `YdPosition` 是过期结转值；应使用 `Position - TodayPosition` |
| ORS 必改 | CTP 持仓查询保留 | `CtpQueryService` | 已定：保留，作为 L2 预扣账本的对账基线 |
| ORS 决策 | 平昨 flag | `CtpAdapter::ctpOffset` | 公司 CTP ORS 平昨发 `Close`；新系统可能发 `CloseYesterday` |
| ORS 决策 | 撤单中间态/终态 | `onCancelRequest` / `onRtnOrder` | 公司 ORS 无 `REQUESTED` 中间态；终态订单要清理 |
| ORS 范围 | CFFEX/ZCE FOK/IOC/FAK | `CtpAdapter` | 当前只做 SHFE，不实施；后续接入再按公司 ORS 评估 |
| L2 必改 | AUTO 开平推断 | L2 | `tb_origin` 不发 offset/PosDirection，只发 side+qty |
| L2 必改 | 平仓预扣/释放 | L2 | `tb_origin` squareoff 是整笔净仓；不预扣会超平 |
| L2 必改 | 整笔 fallback | L2 | 公司 ORS 单边放不下时整笔 OPEN；不拆单 |
| L2 必改 | 字段/状态映射 | L2 | `StrategyID/Product/AccountID/OrderID` 不进 L0；TB ResponseMsg 要映射 |
| ORS 不改 | STP | L2 可选 | 已定：默认关闭；公司 China ORS 的 `OrderCrossCheck` 是死代码 |
| ORS 不改 | MARKET | `CtpAdapter` | 已定：允许；`tb_origin` 不走 MARKET，手工/API 可用 |
| ORS 不改 | RMS | L2/独立 | 新架构 L0 不做账户级 RMS；不要塞回 ORS |
| ORS 不改 | `position.csv` | 新 ORS 无 | 权威是 `PositionSnapshot` + 成交/对账，不是本地文件 |

---

## 2. ORS 必须改

### 2.1 TIF / FAK 映射

**现状**

`ors/ctp/src/CtpAdapter.cpp:536-576`：

```text
IOC -> IOC + AV
FAK -> IOC + CV
FOK -> IOC + CV + MinVolume=qty
DAY -> GFD + AV
MARKET -> AnyPrice + request.price
```

**基准行为**

公司 `China` ORS `SendNewOrder`（`China/src/ORSServer.cpp:607`）：

```text
DAY:
  GFD + AV + MinVolume=1 + LimitPrice=price

FAK:
  IOC + AV + MinVolume=1 + LimitPrice=price

IOC:
  IOC + CV + MinVolume=qty + LimitPrice=price

FOK:
  IOC + CV + MinVolume=qty + LimitPrice=price
```

**为什么必须改**

`tb_origin` 只有 `LIMIT + DAY/FAK`，且 `CROSS` 全部走 FAK：

```text
main/CommonClient.cpp:999-1001
  Duration = FAK if ordHitType == CROSS else DAY
```

新 adapter 的 `FAK -> CV` 会把 aggressive/squareoff 单变成“全成或全撤”，与 CROSS 意图不符。

**改动**

```text
FAK: IOC + AV + MinVolume=1
DAY: GFD + AV + MinVolume=1
IOC: IOC + CV + MinVolume=qty（保留给手工/API）
FOK: IOC + CV + MinVolume=qty（保留给手工/API）
```

并补测试：

```text
FAK 部分成交
FAK 全撤
DAY 挂单
```

---

### 2.2 OnRspOrderInsert ErrorID=0

**现状**

`ors/ctp/src/CtpAdapter.cpp:315-321`：

```cpp
if (info->ErrorID == 0) {
  return;  // accepted
}
```

**基准行为**

公司 `China` ORS `OnRspOrderInsert`（`China/src/ORSServer.cpp:1999`）：

```text
对 NEWORDER 一律按 ORDER_ERROR 处理
即使 ErrorID == 0 也处理
```

146 也明确注释：

```text
// Changed since error code 0 is also valid in this case
```

**为什么必须改**

CTP 在 ErrorID=0 的 `OnRspOrderInsert` 场景下，新 ORS 可能把订单永远留在 NEW，既不 REJECTED 也不进入终态。

**改动**

```text
NEWORDER 的 OnRspOrderInsert 一律按拒单处理
返回 REJECTED + reason/errorCode
释放 L2 预扣
```

补测试：`ErrorID=0` 也必须进入 REJECTED。

---

### 2.3 订单/成交状态时序

**现状**

`ors/ctp/src/CtpAdapter.cpp`：

```text
onOrderRequest 成功后立即发 NEW
每次 onRtnOrder 都发 ACK/PARTIAL/FILLED
AllTraded 先发 FILLED，Trade 可能后到
onRtnTrade 不更新 orders_ 的 filledQty
终态订单不移除
```

**基准行为**

公司 `China` ORS：

```text
不发本地 NEW
Accepted + NoTrade/PartTraded -> 只发一次 NEW_ORDER_CONFIRM
AllTraded -> 不先发 FILLED，等 Trade
Trade -> TRADE_CONFIRM，更新 Qty/openQty，openQty=0 移除
Canceled -> CANCEL_ORDER_CONFIRM，释放剩余，Qty=0 移除
InsertRejected -> ORDER_ERROR，移除
```

**为什么必须改**

- 策略不能在 Trade 之前看到 FILLED。
- 不能重复发 ACK/PARTIAL。
- `filledQty/remainingQty` 必须随 Trade 更新。
- 终态订单不能无限保留。

**改动**

```text
1. NEW 只作为本地状态，策略不得当 ACK
2. ACK 只发一次
3. FILLED 与 Trade 原子发布，或 Trade 先于 FILLED
4. onRtnTrade 更新 filledQty/remainingQty
5. 终态订单移除或归档
```

补测试：Trade 先到、OrderUpdate 后到、重复 OrderUpdate、部分成交后撤单。

---

### 2.4 CTP 持仓查询的昨仓

**现状**

`ors/ctp/src/CtpQueryService.cpp:80`：

```cpp
const int yesterday =
    row.YdPosition != 0 ? row.YdPosition : position - today;
```

**基准行为**

公司原版 `China` ORS 在 CTP 下不查持仓（`ReqQryPosition()` 直接 return），所以没有这条计算。  
后续生产分支 `quantlink-trading` 新增 CTP 持仓查询时明确：

```text
CTP 的 YdPosition 是昨日结转的历史值，平仓后不减少；
正确的隔夜仓 = Position - TodayPosition
```

**为什么必须改**

`YdPosition` 非 0 时可能已经过期，导致昨仓可平量偏大，平昨/平今选错。

**改动**

```cpp
const int yesterday = std::max(0, position - today);
```

补测试：昨日仓被平掉后，`YdPosition` 仍非 0，快照的 `yesterdayLong/Short` 必须按 `Position - TodayPosition`。

---

### 2.5 平昨 flag

**现状**

`ors/ctp/src/CtpAdapter.cpp:65-75`：

```text
Offset::CloseYesterday -> THOST_FTDC_OF_CloseYesterday
```

**基准行为**

公司 `China` ORS CTP 分支（`SetCombOffsetFlag`，`China/src/ORSServer.cpp:488`）：

```text
SHFE today -> THOST_FTDC_OF_CloseToday
非 SHFE today -> THOST_FTDC_OF_Close
ON bucket -> THOST_FTDC_OF_Close
```

CTP 分支从未使用 `THOST_FTDC_OF_CloseYesterday`。

**为什么必须改/确认**

如果 L2 对 CTP 昨仓返回 `CLOSE_YESTERDAY`，新 ORS 会发 `CloseYesterday`，与公司 ORS 的 `Close` 不同。  
如果 CTP/交易所两者等价，可能只是 wire flag 不同；但按“以原代码为准”，应对齐。

**改动选项**

```text
A. L2 对 CTP 昨仓返回 CLOSE；ORS 收到 CloseYesterday 时拒绝或映射为 Close。
B. 确认 CTP 支持 CloseYesterday 且业务接受与公司 ORS 不同的 wire flag。
```

---

### 2.6 撤单中间态/终态

**现状**

`ors/ctp/src/CtpAdapter.cpp:240-290`：

```text
撤单发送成功后发 CancelState::REQUESTED
front/session 未知时直接拒绝
终态订单不移除
```

**基准行为**

公司 `China` ORS：

```text
撤单发送成功后不立即回中间态
终态靠 OnRtnOrder / OnErrRtnOrderAction
成功撤单 -> CANCEL_ORDER_CONFIRM
撤单失败 -> CANCEL_ORDER_REJECT，原订单继续
```

**为什么必须确认**

`REQUESTED` 是新 contract 的中间态，不是公司 ORS 的行为。策略是否能处理要确认。  
如果严格对齐公司 ORS，可以不把 `REQUESTED` 暴露给策略，只在 L2 内部记录。

**改动**

```text
1. 确认是否保留 CancelState::REQUESTED
2. 终态订单按公司 ORS 移除/归档
3. 撤单成功后最终状态仍以 OnRtnOrder 为准
```

---

### 2.7 CFFEX/ZCE 的 TIF 拒绝（当前只做 SHFE，暂不实施）

决策：当前只做 SHFE，不实现 CFFEX/ZCE 的 FOK/IOC/FAK 本地拒绝；后续接入再按公司 ORS 评估。

公司 `China` ORS CTP：

```text
CFFEX/ZCE 的 FOK/IOC/FAK -> 本地拒绝
SHFE market -> 不本地拒绝
```

后续生产分支 `quantlink-trading`：

```text
删除了 CFFEX/ZCE 的 FOK/IOC/FAK 本地拒绝
注释 D9：CTP 原生支持，旧拒绝导致 IF 对冲腿连续被拒
```

`tb_origin`：

```text
CROSS -> FAK
```

**冲突**

如果 `tb_origin` 在 CFFEX/ZCE 发 CROSS（FAK），公司原版 ORS 会本地拒绝；后续生产分支允许。  
新 ORS 当前不拒绝，和后继生产分支一致，但和公司原版不一致。

**需要决策**

```text
A. 按公司 China ORS：CFFEX/ZCE FOK/IOC/FAK 本地拒绝
B. 按后续生产分支：允许，依赖 CTP
```

---

## 3. ORS 不要加

| 不加 | 原因 |
|---|---|
| AUTO offset / 开平推断 | 公司 ORS 用账户级 `mapContractPos` 推断；新 ORS 只收最终 `offsetFlag`，应在 L2 做。 |
| 平仓预扣/释放账本 | 公司 ORS 在 ORS 内维护；新架构下 L2 拥有 OrderRegistry/Position，预扣应在 L2。 |
| 拆单 | 公司 ORS 和 tb_origin 都是单笔；产品确认不拆。 |
| STP / `OrderCrossCheck` | 公司 China ORS 只有函数定义，`SendNewOrder` 没调用；生产路径没有 STP。建议 L2 可选、默认关闭。 |
| RMS | 公司 ORS 有 RMS，但新设计把账户级风控放 L2/独立组件；不要塞回 ORS。 |
| `StrategyID` / `Product` | 公司 ORS 的 `RequestMsg` 有，但 CTP ORS 不回填 `StrategyID`；TB 用 `OrderIDStrategyMap` 找策略。新 contract 不含这些字段，L2/L3 映射即可。 |
| `position.csv` | 新 ORS 不做本地持仓文件；权威是 `PositionSnapshot` + 成交/对账。 |

---

## 4. L2 必须同步改

ORS 改完还不够，以下必须在 L2 落地：

### 4.1 AUTO offset

`tb_origin` 不发 `PosDirection`/offset，只发 side+qty。  
L2 必须按**账户级今昨仓**推断：

```text
BUY:
  qty <= 今空 -> 平今
  qty <= 昨空 -> 平昨
  否则 -> 整笔 OPEN
SELL:
  对称使用今多/昨多
```

### 4.2 平仓预扣/释放

`tb_origin` squareoff 是 `qty = abs(m_netpos)`，一笔发出。  
L2 必须：

```text
发单预扣
拒单/撤单释放
开仓成交加仓
平仓成交不重复加
```

### 4.3 整笔平仓保留原语义

单边放不下时整笔 OPEN，不拆单、不改拒单。  
这是公司 ORS 原逻辑，也是 tb_origin 依赖的行为。

### 4.4 字段映射

```text
TB StrategyID        -> L2 OrderRegistry.strategyId
TB Product           -> L2/L3 监控字段
TB AccountID         -> L2 业务账户 -> L0 venue accountId
TB OrderID           -> L2 clientOrderId/orderRef -> 回报映射
```

### 4.5 TB ResponseMsg 映射

```text
NEW_ORDER_CONFIRM   -> OrderUpdate.status=ACK
TRADE_CONFIRM       -> Trade
CANCEL_ORDER_CONFIRM-> OrderUpdate.status=CANCELED
CANCEL_ORDER_REJECT -> OrderUpdate.cancelState=REJECTED
ORDER_ERROR/ORS_REJECT/RMS_REJECT -> OrderUpdate.status=REJECTED
```

---

## 5. 为什么

```text
tb_origin：
  只发 LIMIT + DAY/FAK
  CROSS=FAK
  整笔净仓平仓
  不发 offset/PosDirection

公司 China ORS：
  账户级今昨仓
  单笔
  整笔 fallback
  发单预扣
  状态机以 Trade 为准

新 ORS：
  只做 CTP 1:1 映射
```

因此：

- CTP 字段/时序错误 → 在 ORS 改。
- 开平/预扣/整笔语义 → 在 L2 改。
- STP/RMS → 不是 ORS 必需；STP 建议 L2 可选默认关闭，RMS 放 L2/独立组件。

---

## 6. 验收清单

```text
[ ] FAK 部分成交/全撤符合公司 ORS
[ ] DAY MinVolume=1
[ ] OnRspOrderInsert ErrorID=0 -> REJECTED
[ ] Trade 先于 FILLED
[ ] Trade 更新 filledQty/remainingQty
[ ] 终态订单清理
[ ] 昨仓 = Position - TodayPosition
[ ] CTP 持仓查询保留，查询完成前不放单
[ ] 平昨 wire flag 与公司 ORS 一致/已确认
[ ] 撤单中间态已确认
[ ] 当前 SHFE 不实施 CFFEX/ZCE 拒绝
[ ] MARKET 允许
[ ] STP 默认关闭
[ ] L2 AUTO/预扣/整笔 fallback 已落地
[ ] StrategyID/Product/AccountID/OrderID 映射已落地
```

---

## 7. 相关文档

```text
ref/001-tb-origin-parity.md
ref/002-china-ctp-ors-parity.md
ref/003-146-ors-parity.md
```

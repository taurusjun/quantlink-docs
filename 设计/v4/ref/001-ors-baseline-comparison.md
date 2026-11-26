# v4 参考：ORS 基线比较

- 状态：参考记录，不是运行时组件清单
- 日期：2026-11-26
- 目的：确定 v4 ORS 的源码基线、可回移修复和不可回移改动

---

## 1. 三个 ORS 候选

```text
公司 ORS 原始代码
/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/ors/China

quantlink-trading ORS 分支
/Users/wangjun/PG/RD/quantlink-trading/ors/China

当前新 ORS
/Users/wangjun/PG/quantlink-new/quantlink-ors
```

---

## 2. 对比

| 维度 | 公司 ORS 原始 | quantlink-trading ORS | 当前新 ORS |
|---|---|---|---|
| 定位 | 公司实盘 ORS | 公司 ORS 的生产修复分支 | v3 新写的 L0 |
| 传输 | SysV SHM | SysV SHM | Aeron |
| 订单状态权威 | 有，账户级 `m_ordLocalMap` | 有，沿用公司结构 | 无，L2 OrderRegistry |
| RMS | 有 | 有 | 无 |
| 账户/持仓查询 | 公司原路径 | 有 CTP 查询/持仓修复 | 有 account/position 快照 |
| 订单状态机 | 公司语义 | 公司语义 + 局部修改 | 新写的 contract 状态机 |
| 生产修复 | 旧代码 | 多 | 少，主要是新架构 |
| 适合作为 v4 业务基线 | 是 | 部分可参考 | 否 |

---

## 3. `quantlink-trading/ors/China` 的实际差异

它确实是公司 ORS 的生产 fork，包含一批实战修复，例如：

- 登录重试、开盘前检查
- CTP 4040 生产/评测模式
- MD/Trader flow 目录拆分
- MD 断线重订阅
- CTP 持仓查询、账户查询
- 行情档位残留清理
- CFFEX/ZCE 的 FAK/FOK/IOC 处理
- `StrategyID` 回填
- 拆单尝试及部分回退

这些修复有价值，但它**不是“只改 account query”的公司 ORS**：

```text
StrategyID / Dashboard 字段
拆单/回退历史
本地配置/路径适配
其他生产补丁
```

如果 v4 以“完全复刻公司 ORS、只改 account query”为原则，则：

- 业务基线用公司 ORS 原始代码
- 从 quantlink-trading 只挑经过验证、且不改变订单语义的修复
- 不回移 StrategyID、Dashboard 相关字段和拆单逻辑

---

## 4. Aeron 部分

`quantlink-trading/ors/China` **没有 Aeron**，仍然是 SHM。

当前 `quantlink-ors` 有：

```text
AeronPublisher
AeronCommandSubscriber
ContractSink
contract 0.2.0 SBE
```

这些可以作为 Aeron 传输和发布/订阅的实现参考，但不能直接拿来当公司 ORS 的订单状态机：

- 当前新 ORS 的订单语义是 v3 的
- 公司 ORS 的语义是 `RequestMsg/ResponseMsg` + `OrderInfo`
- 直接套用会让 v4 又变成“自己一套”

v4 应采用：

```text
公司 ORS 业务结构
  +
公司 RequestMsg / ResponseMsg 语义
  +
Aeron 传输层
```

---

## 5. 结论

```text
主基线：公司 ORS 原始代码（`fromCompany/gitrepo/ors/China`）
修复来源：quantlink-trading/ors/China（逐项 cherry-pick）
传输参考：当前 quantlink-ors 的 Aeron 实现
```

不做：

```text
直接使用 quantlink-trading ORS 整包（它带有非 account query 的改动）
继续使用 v3 L2 订单状态
把当前新 ORS 的 contract 状态机当成公司 ORS 语义
```

第一版 v4 ORS 的验收标准应该是：

- 公司 ORS 的订单/撤单/RMS 行为逐项对齐
- account query 是唯一业务差异
- SHM 被 Aeron 替换，但消息语义不变
- 未知撤单返回明确的 `CANCEL_ORDER_REJECT`
- 订单状态仍由 ORS 持有，SDK/TradeBot 不另建订单权威

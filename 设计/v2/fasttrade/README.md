# 146 新系统设计

- 状态：DRAFT
- 开始日期：2026-11-23
- 定位：正式系统设计；`../../../146/FAQ/` 是调查、对照和差异记录，不自动成为设计。

---

## 1. 设计边界

```text
146 源码只读
新系统设计必须显式
不能把 FAQ 里的推测直接写成设计
不能为了新模型改动 146 的行为
```

每条设计至少能追溯到：

```text
146 已验证行为
或新系统的明确决策
或仍未决的问题
```

---

## 2. 已确认约束

### 2.1 账户

```text
accountViewKey 删除
accountId = trim(146 ACCOUNT / m_account / m_reqMsg.AccountID / NetPnlInfo.m_accountId)
```

`accountId`：

```text
来自策略启动配置
用于订单请求、账户快照、持仓、PnL 读模型
不参与 exchange / contract / TradingChannel 路由
不能写死成 OWN；OWN 只是 146 示例配置值
```

### 2.2 策略

```text
strategyKey 删除
strategyId = 数字，启动配置指定，TB 内唯一
strategyName = 显示名，可选
全局身份 = (tbId, strategyId)
```

### 2.3 注册

```text
TB 启动时读取策略配置
  -> 校验 strategyId 唯一
  -> 创建 StrategyRuntime
  -> 写入本地 StrategyRegistry
```

没有：

```text
动态注册 API
心跳注册
租约/发现
中央注册中心
```

### 2.4 路由

```text
ContractKey -> TradingChannelKey
```

`strategyId` 和 `accountId` 都不是路由键。

### 2.5 146 运行期文件

```text
PID 文件               进程级，不是策略事实
begin_prices_calendar  可选策略种子
positions<id>          策略本地 checkpoint，不是账户真相
final_positions...     策略收盘记录，不是恢复权威
日志                   保留
tbadmin memlog         仅 Plan A/兼容层，不是核心事实源
```

账户/持仓恢复以执行/成交、对账和可选 venue 查询为准；不依赖 ORS 快照。
`PositionSnapshot` / `AccountSnapshot` 是 L0 必需消息，但不是账户真相或恢复权威。

---

## 3. 文档索引

| 文件 | 内容 |
|---|---|
| `001-system-overview.md` | 系统目标、角色、边界、拓扑、核心不变量 |
| `002-system-layers.md` | 逻辑分层、依赖方向、交易/行情/观测控制平面、失败边界 |
| `003-l0-ors-venue.md` | ORS/venue 会话、订单/回报、必需快照（Position/Account）、20 档行情、`accountId`=venue 账户（`FIX_TRADING_ACCOUNT`）与 L0/L1 边界 |
| `004-l1-ipc-transport.md` | OrsAccountStream（account+execution）/ 每 exchange ChannelStreamSet、序列、epoch、背压、断线不续传 |
| `005-l2-trading-channel.md` | TradingChannel、OrderRegistry、FillLedger、订单/回报归属 |
| `006-l3-runtime-registration.md` | StrategyRuntime、启动注册、生命周期、失败处理 |
| `007-l3-orders-and-positions.md` | OrderFact、TradeFact、Position、PnL |
| `008-identities-and-config.md` | `strategyId`、`accountId`、`tbId`、配置与校验 |
| `009-account-boundary.md` | ORS/账户快照与 TB 的边界 |
| `010-gui-and-control.md` | LocalAgent、BotGateway、读模型、控制命令 |
| `011-recovery.md` | 重启、对账、事实恢复 |
| `012-security-and-audit.md` | 认证、授权、审计 |
| `013-open-questions.md` | 未决问题与决策记录 |

### Reference

对照记录放在 `ref/`，不占正式设计编号：

| 文件 | 内容 |
|---|---|
| `ref/001-tb-origin-parity.md` | `tb_origin` TB 与报单行为对照 |
| `ref/002-china-ctp-ors-parity.md` | 公司 ORS（China/CTP）对照 |
| `ref/003-146-ors-parity.md` | 146 ORS 历史对照 |
| `ref/004-new-ors-change-list.md` | 新系统 ORS 改动清单 |

> `001`–`006` 已建；`ref/` 是对照记录；其余设计文档按 L0 → L1 → L2 → L3 顺序逐步补齐，不先写空壳。

---

## 4. 决策记录

| 日期 | 决策 |
|---|---|
| 2026-11-23 | `accountViewKey` 作废，统一 `accountId` |
| 2026-11-23 | `accountId` 来自 146 `ACCOUNT`，不作为路由键 |
| 2026-11-23 | `strategyKey` 作废，统一 `strategyId` |
| 2026-11-23 | `strategyId` 启动配置指定，TB 内唯一；全局用 `(tbId, strategyId)` |
| 2026-11-23 | 策略只在启动时注册，不做动态注册/发现 |
| 2026-11-23 | 146 运行期文件不作为账户/持仓真相 |
| 2026-11-23 | 146 源码不动；新系统差异显式记录 |
| 2026-11-23 | 层是逻辑边界，不是进程边界；同进程也不能绕过接口 |
| 2026-11-23 | 只有 TradingChannel 能写通道订单状态；只有 TradeBotOrderGateway 能送 OrderIntent |
| 2026-11-23 | L0（ORS/Venue）只认账户/合约/订单，不认 strategyId 和 GUI |
| 2026-11-23 | 一个 ORS 只绑定一个 venue 账户；`accountId` 不能切换 venue 账户 |
| 2026-11-23 | `orderRef` 由 L2/TradingChannel 分配，L0 只消费；跨重启按 epoch 隔离 |
| 2026-11-23 | L0 不提供账户/持仓真相；146 的 NetPnl 由 DataService 上层计算 |
| 2026-11-23 | 行情走独立 MD 链路，不要求经过 ORS |
| 2026-11-23 | 不依赖 ORS 未完成订单查询；恢复靠回报/对账/可选 venue 查询 |
| 2026-11-24 | contract 是 L1 线格式；L1 只定义 transport 行为，不重复定义字段 |
| 2026-11-24 | 一个 ORS 账户一个 OrsAccountStream（account + account-level execution）；每个 exchange 一个 ChannelStreamSet 和逻辑 VenueSession；OrderRequest+Modify 共流，Cancel 独立 |
| 2026-11-24 | OrderUpdate+Trade 保持 contract 0.2.0 的每 ORS 账户一条 execution stream；L1 按 exchange 分发给 L2 |
| 2026-11-24 | L1 不做 handshake/discovery/历史回放；旧 schema/旧 epoch fail closed |
| 2026-11-24 | L1 v1 是 L2/TB 进程内库；execution gap 由 L1 标记、L2 对账 |
| 2026-11-24 | 命令背压返回 RETRYABLE / NOT_RETRYABLE，L1 不内部重试，L2 同 epoch 幂等重试 |
| 2026-11-24 | v1 同主机 aeron:ipc；多 TB 共享 Aeron dir，stream ID 全局唯一；每个 ORS 账户只由一个 TB 拥有，一个 TB 可拥有多个 ORS |
| 2026-11-24 | AccountSnapshot 每个 ORS 账户一条，不按 exchange 拆；快照无 epoch，按 snapshotId/timestamp/stale 处理 |
| 2026-11-24 | MD sequence 包含 session/epoch；CTP ModifyRequest 由 L0 拒绝，L2 不模拟 cancel+new |
| 2026-11-25 | CTP 持仓查询保留；昨仓用 `Position - TodayPosition` |
| 2026-11-25 | STP 默认关闭，按 account/channel 可选开启 |
| 2026-11-25 | MARKET 允许；当前只做 SHFE，CFFEX/ZCE 的 FOK/IOC/FAK 暂不实施 |

---

## 5. 写作规则

1. 先写边界，再写字段；不先画大而全的图。
2. 字段必须有来源、生命周期、唯一性范围和归属。
3. 事实、读模型、控制命令分开写。
4. 146 对照放 `../../../146/FAQ/`；本文只写新系统设计。
5. 未决问题直接写“未决”，不猜默认值。

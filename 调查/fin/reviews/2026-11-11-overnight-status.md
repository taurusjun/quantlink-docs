# 夜间运维与修复记录（2026-11-11 凌晨）

用户 00:30 离开，要求：修完所有问题、08:30 开盘后观察 1 小时、确认数据正常。

## 1. 部署（190，均已备份）

| 组件 | 部署时间 | 备份 |
|---|---|---|
| control-plane.jar | 02:12 | `app/control-plane.jar.bak-20261111-021216` |
| runtime-runner | 02:50 | `runtime-runner.old` |
| runtime-agent | 03:0x | `runtime-agent.bak-20261111-002944`（内含旧版本） |
| web | 00:29 | `web.bak-20261111-002944` |

重启顺序：control-plane → simvenue → simnow → shengli。控制面 23s 就绪，三个 agent active，SimNow ORS `loggedIn=true`。

## 2. 夜间发现并修复的问题

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 消息页跨日后看不到任何消息；详情页消息永远为空 | `/strategy/alerts` 的 `today` 默认 `true`；详情页未传参 | 消息页默认近 7 天；详情页 `today=false` |
| 2 | 详情页点消息进不去「消息」tab | `initialTab` 只在组件首次挂载生效 | 增加 `initialTab` 同步 effect |
| 3 | 消息无法确认、无法激活 | 消息 tab 只有展示列 | 增加逐条/全部确认 + 激活策略按钮 |
| 4 | 指标更新时间显示 1970/1/1 08:00 | runner 把 `System.nanoTime()` 当 epoch 纳秒发布 | 改发 `currentTimeMillis()*1e6`；消费端对 <1e12 兜底；前端对 0 显示 `-` |
| 5 | 策略没有删除入口 | 后端从未实现 DELETE | 新增 `DELETE /strategy-center/strategies/{id}`：ACTIVE / 有持仓 / 有订单成交一律 409；否则事务内清依赖后删除，并写审计 |
| 6 | `STRAT-SIMNOW-PAIR2-VFKM4` 等部署 FAIL | `activate` 把 `actual_state` 重置为 UNKNOWN，而 agent 的 ack 按 `state:generation` 永久去重 → 不再上报 → 60s 后 ACK 超时 | agent 每 30s 重发一次 ack；`markFailed` 不再改写 `status`（保留激活性，可自愈） |
| 7 | `SIMNOW-NIGHT-OPT` 每 500ms 刷 `instrumentId is required` | `option_quoting` 缺 `optionId`，策略持续产出空合约订单 | 启动期校验：option_quoting 必须有 optionId、futures_pair 必须两个不同 leg、simple_hedging 必须有 hedgeInstrumentId |
| 8 | 校验失败后仍留下「半启动」runner 进程 | Aeron client 线程是非 daemon，main 抛异常后 JVM 不退出 | 校验失败 `System.exit(2)` |
| 9 | agent 对同一坏配置无限重启 | 动态 `start(id, config)` 每轮重置失败计数 | 仅配置变化时重置；连续 3 次 10s 内退出 → `FAILED` 并停止重启 |

## 3. 当前状态（04:00）

```text
23 SIMNOW-NIGHT-OPT          INACTIVE / FAILED   optionId 未配置（预期）
24 SIMVENUE-OPT-01           INACTIVE / RUNNING
25 PAIR-SIMVENUE-MW9C01BR    ACTIVE   / RUNNING
27 STRAT-SIMNOW-PAIR-VEDO8   INACTIVE / RUNNING
28 STRAT-SIMNOW-PAIR2-VFKM4  ACTIVE   / RUNNING
```

策略持仓 0，挂单 0；`indicator_values` 近 5 分钟 1800+ 行，时间戳正常（非 1970）。

## 4. 开盘观察

`quantlink-fin-market-watch.timer` 已启用：**工作日 08:30 启动，持续 1 小时，每分钟采样**。

- 明细：`/var/log/quantlink-fin/market-watch-YYYYMMDD.jsonl`
- 结论：`/var/log/quantlink-fin/market-watch-YYYYMMDD.summary.txt`

采样项：CP 健康、agent 数、runner 数、ORS 登录数、指标 5 分钟行数与最新时间、PnL 快照时间、当日订单/成交数、NEW 告警数、策略持仓数、ACTIVE 部署失败数。判定规则：CP 非 200、agent < 3、指标超过 3 分钟未更新、ACTIVE 部署失败，任一出现即 `verdict=CHECK`。

脚本：`tools/ops/market_watch.py`；单元：`deploy/quantlink-fin-market-watch.{service,timer}`。

## 5. 仍未处理（不影响今日开盘）

1. ~~`SIMNOW-NIGHT-OPT` 需要补 `optionId`~~：已写入 v2 完整快照（`optionId=au2612C920`，14 个 key），部署 23 已 `ACTIVE / RUNNING / RUNNING`（generation 2），runner 正常进入策略循环，无配置错误。
2. 期权 IV Rank 仍无生产者：ATM IV 已由 Agent 发布，IV Rank 需要定时任务从 `indicator_daily_history` 计算。
3. 组合 DELTA/VEGA 仍在控制面聚合（`24-边界` 允许）。
4. 策略循环里 `toMessage(tick)`、`lastTicks.put`、`lastTimestamp` 装箱仍是每 tick 分配（既有问题）。

## 6. 配置唯一来源（方案 A）与测试补齐

2026-11-11 09:30 用户决定：**版本表是唯一来源**，修掉「更新版本后 runner 仍跑旧配置」。

变更：

- `PUT /strategies/{id}/versions`：提交的 patch 合并到当前生效配置后，写入**完整快照**（`StrategyConfigMerge`）。
- runner `DeploymentMapper`：按部署固定的 `strategy_version` 读取 `strategy_versions.config_json`，缺行才回退 `strategies.config_json`；回滚立即生效。
- 策略详情、fork、草稿编辑统一读当前版本快照，避免 base 模板与版本快照分叉。
- `tools/db/migrate-t055-version-config-snapshot.sql`：把历史半截版本行补成完整快照（已在 190 执行，`SIMVENUE-OPT-01` 从 2 个 key 恢复为 14 个，`optionId=au2612C920`）。

测试（关键：跨「写 API → runner 读库」边界）：

- `StrategyConfigMergeTest`：patch 合并、覆盖、非法 JSON。
- `StrategyVersionContractIT`：真实 Mapper + 真实 Controller 写版本 → `findStrategy` → `DeploymentConfigLoader.load` 断言新值；回滚断言旧值；版本号唯一约束。
- `DeploymentVersionConfigIT`：runner 侧部署版本/回滚读取。
- `SchemaIntegrationTest`：测试库跑完整 V2 迁移，断言 `strategy_versions(strategy_id, version)` 唯一。
- CI 新增 Postgres 服务 + `tools/testing/prepare-contract-db.sh` + 契约测试步骤。
- 测试策略文档新增「写→读契约门禁（P0）」：禁止只 mock mapper 断言调用。

已知未处理：

1. `SIMNOW-NIGHT-OPT` 仍缺 `optionId`（等待选定合约）。
2. 告警未按 `(strategy_id, reason)` 去重：`PAIR-SIMVENUE-MW9C01BR` 今日写入 1881 条 "local risk snapshot is stale"。
3. 190 上 CP 在 09:32/09:42/09:53 被反复重启（非本次操作），叠加宿主机 load≈67（外部 TradeBot 占满 CPU），runner 的风险快照请求持续超时（fail-closed，不报价）。

## 7. shengli 行情与指标隔离修复（2026-11-11 11:00–11:45）

### 7.1 shengli WS 行情（Bug 1）

现象：`SIMSHENGLI` 的 WS tick 里 ask 为 `1.797e308`，`pair_state.avgSpread` 为 `6.5e300`，策略无法报价。

根因：CTP 用 `DBL_MAX` 表示空档位，适配器原样写入 Aeron，控制面缓存/WS/策略计算全程未清洗。

修复（三层）：

- 适配器 `ctp-adapter/src/price_sanitize.h`：非有限、非正、`>=1e12` 的价格归零；
- 控制面 `MarketDataService`：入库与广播前清洗，整条无效的 tick 丢弃；
- runner `AeronMarketData`：同样清洗，`ask=0` 视为无报价。

验证：WS 推送样本 `SIMSHENGLI/au2612` 的 `bidPrices=[1000.08,0,0,0,0]`、`askPrices=[1101.08,0,0,0,0]`，不再出现 `1.79e308`。

遗留：shengli CTP 测试前置的行情本身很稀疏（au2612 最新交易所时间戳约 5 分钟前，ag2612 只有买价、无卖价），runner 的 `maxTickAgeMillis=5000` 会按陈旧行情拒单；这是数据源问题，不是 WS 链路。

### 7.2 指标跨策略复用（Bug 2）

根因一：`fork` 复制 `config_json` 时把 `indicators` 原样带过去，副本仍指向源策略的指标 ID（`PAIR-SIMVENUE-*`），UI 显示的是源策略/源 Agent 的实时指标。

修复：fork 时克隆指标定义并生成副本自己的 ID，重写 `config_json.indicators`；版本保存与草稿编辑校验指标归属；`t056` 迁移修正已存在的 3 个策略。

根因二：控制面 `IndicatorEngine.pairSpread` 使用**全局** `lastTicks`，同一品种在 SimVenue/SimNow/SimShengli 的价格会互相污染。

修复：配对指标只按策略的 `bound_counterparty_id` 读取 scoped tick，缺腿或未绑定柜台直接 `STALE`，不再回退到其他柜台。

## 8. SimVenue 行情源排查（2026-11-11 15:00–15:35）

现象：SimVenue 的 `PAIR_SPREAD` 在指标 TTL 上线后恒为 `STALE`，UI 行情不变。

定位到的原因（按发现顺序）：

1. `qf-sim-long` 在启动瞬间把整小时 tick 全部输出，`SimMdPublisher` 逐条直发，时间戳全部落在启动时刻，随后一小时无数据。
2. 1001 流上还有一个未结束的 **Aeron Archive replay** 发布（16MB term，旧时间戳），订阅者先读到它；重启 Archive 后释放。
3. SimVenue 的 `md_channel` 是 `aeron:ipc`，与新发布的 `aeron:ipc?term-length=65536` 不匹配，CP/runner 收不到新发布。
4. 回放数据里没有 `ag2612`（配对策略的第一腿），只有 au2612/期权。

修复：

- `SimMdPublisher` 改为 100ms 节奏重放 + 队列空时轮播最后快照 + 缺失合约用合成快照补齐（含 `au2612`）；
- `sim-feed` 改为合成模式（不再依赖 `qf-sim-long`），`deploy/quantlink-fin-sim-feed.service` 同步；
- `ors_instances.md_channel` 对齐 `aeron:ipc?term-length=65536`；
- 指标 TTL 30s → 60s。

效果：15:26 时 `PAIR-SIMVENUE-MW9C01BR-PAIR_SPREAD = 10925.55`，链路已打通；但控制面每次重启后会再次读到旧 tick（订阅加入的是旧 image/term），需要重启顺序或 join-at-tail 才能稳定。shengli 真实行情仍是分钟级，`STALE` 正确。

## 9. SimVenue 行情收口到模拟交易所（2026-11-11 16:40）

SimLocal 遗留的 `SimMdPublisher`（`qf-sim-long → 1001`）已删除：

- 行情生成移入 `sim-venue`（`SimVenueMarketDataGenerator`），默认 5 个合约、100ms 一条、时间戳为当前时间；
- `sim-venue` 成为 1001 的唯一写入方，删除 `--md-out-*` 回显路径；
- `quantlink-fin-sim-feed.service`（含 190 上的 drop-in）已停用并删除；
- `ors_instances.md_channel` 恢复默认 `aeron:ipc`（64KB term 在小 term 轮转下会冻结发布位置）；
- 消费端保留 synthetic 过期过滤（>60s 丢弃），作为回放场景的兜底。

验证：1001 上 `ag2612/au2612` 的 tick age < 1s；控制面 scoped tick age 0.1s；
`PAIR-SIMVENUE-MW9C01BR-PAIR_SPREAD = 10889.37`（17:19:12），链路恢复。

补充：venue 的 IPC publication 在运行约 2 分钟后会再次冻结（`offer` 持续失败）。
`SimVenueMarketDataGenerator` 现在连续失败 100 次就关闭并重建 publication，已实测
跨过该时间点后仍持续发布。

# 交易员评审：多柜台接入与管理系统设计稿

- 日期：2026-11-08
- 评审对象：`docs/architecture/22-多柜台接入与管理系统设计.md`
- 评审视角：期货/期权交易员（SHFE au/ag，做市 + 方向 + 对冲），兼交易系统评审
- 参考：`docs/architecture/14-多Runtime-Agent与柜台账号绑定.md`、`docs/architecture/19-独立模拟交易所与正式接入.md`、`docs/reviews/trader-review-2026-11-06.md`、`docs/reviews/architecture-review-2026-11-08.md`
- 结论：**BLOCK**（P0 11 项、P1 13 项、P2 10 项）

> 方向是对的：把“当前柜台”从一个小过滤器提升为执行上下文，把登录用户和交易账户分开，把页面范围与执行上下文分开。这三件事必须保留。
>
> 但现稿还没有把“执行上下文”变成系统里唯一、可验证、贯穿行情/路由/回报/权限/应急/对账的键。按现稿进入开发，最可能的结果是：交易员看到“当前柜台: SIMVENUE”，实际价格、订单、持仓或撤单却来自 SIMLOCAL / SimNow。这比现在“切换后页面没变化”更危险，因为新的标签看起来更权威。

---

## 0. 结论与放行条件

### 0.1 三条硬结论

1. **`counterparty.exchange` 和“1 柜台 = 1 账户”在真实 CTP 下会失效。** 设计稿 §2.1 把“柜台（Counterparty / Exchange）”写成同一个东西，§6.1 又给 `counterparty` 只留一个 `exchange` 字段。真实 CTP 里，SimNow 是模拟 CTP 前置、SimShengli 是券商 CTP 前置；一个柜台可以接 SHFE、DCE、CZCE、CFFEX 多个交易所，一个 InvestorID 也可以交易多个交易所。按现模型，要么一个真实账户被拆成多个假“柜台”，要么多交易所订单被 `instrument.exchange compatible with counterparty` 错误拒绝。
2. **“行情和下单都跟着柜台”目前只写在 §2.1 / §4.3，没有落到数据键。** 设计稿 §8.1 说“独立行情流，或消息中携带 `counterpartyId`”，但没规定控制面行情存储、WS 推送、期权链/Greeks、手工单价格校验都必须以 `(counterpartyId, instrumentId)` 为键。现状 `MarketDataService` 只按 `instrumentId` 存一份 tick，`TradingController.validateOrder` 也按 `instrumentId` 取全局最新价；同合约在两个柜台有报价时，必然串价。
3. **Phase 1 先改 UI 文案、Phase 2 才做页面范围，会原样复现用户已反馈的“切换后页面没变化”。** §12 的 Phase 1 只联动“手工单、期权链、行情 ticker”，订单/成交/持仓/策略还在 Phase 2。改完名字后，交易员更会相信“当前柜台”已经生效，实际订单页、持仓页仍是全部账户，这是典型的“看起来生效、实际没生效”。

### 0.2 放行条件（全部满足才建议进入开发）

- [ ] 第 2/3/6 章重写：`Counterparty`（接入通道）与 `Exchange`（市场）分离；`Account`、`ORS`、`ExecutionContext` 分层；明确 v1 的 1:1 只是“SIM 柜台的部署约束”，不是 CTP 市场事实。
- [ ] 定义唯一执行上下文 `ExecutionContext = counterpartyId + accountId + orsId + environment + contextVersion`，所有下单/撤单/回报/持仓/对账/权限都以它为准。
- [ ] 行情、订单、回报、持仓、对账五个面全部按上下文做服务端过滤；禁止前端拉全量后过滤（§7.2 已写，但需要落到每个接口和每个消费方）。
- [ ] 删除所有静默 fallback：无 ACTIVE ORS 不得回退 legacy stream；选择器不得自动切到另一个可用柜台；顶部“系统连接”不得用“任意 ORS RUNNING”冒充当前柜台可用。
- [ ] 权限、应急范围、LIVE/SHADOW 环境隔离、旧回报/fencing 四件事有明确的服务端合同和验收用例。
- [ ] Phase 1 先做后端上下文与过滤，再改 UI 名称；改名必须带 feature flag 和“6 个页面同时变化”的 e2e 测试。

---

## 1. 设计稿中值得保留的部分

1. **§2.1 “柜台是执行边界”**：把行情、下单、撤单、回报、账户、ORS、日历、风控、对账放在同一个边界里，这是正确的总方向。
2. **§2.3 登录用户与交易账户分离**：`登录用户 test_admin` 与 `交易账户 SIMVENUE-001` 不是同一个概念，这条必须坚持，并且要在权限模型里落实，而不只是 UI 文案。
3. **§2.5 页面范围与柜台选择分离**：顶部是执行上下文，页面范围是查询条件；这个区分能解决“在全部柜台视图里误下单”的一类问题。
4. **§4.4 “不允许静默 fallback 到其他柜台”**：意图完全正确，问题只在于设计稿没有把它写成路由、选择器、状态栏三条具体规则。
5. **§5.2 “全部柜台只读”**：方向正确，但需要把“只读”从“不能下单”扩展到“不能撤单/改单/平仓/批量操作”。
6. **§10 每个柜台独立对账**：正确；现系统的 `simLocal` / `simVenue` 硬编码对账和“本地一致即通过”的假阳性，正好说明必须重做。
7. **§14 把问题留给交易员确认**：态度对；但其中几个问题（默认范围、切换草稿、手工单是否允许临时选非当前柜台）应该由设计给出推荐答案，而不是把决策成本全推给交易员。

---

## 2. 交易员工作流视角：现稿哪里不顺手

| 场景 | 交易员实际动作 | 现稿的问题 | 直接后果 |
|---|---|---|---|
| 08:45 盘前 | 逐个柜台看登录、结算确认、行情龄、对账、持仓、可用资金 | §5.3 柜台总览有卡片，但 §4.1 顶栏仍只有一个全局“系统连接: UP”；没有“全柜台是否可开盘”的汇总 | 一个柜台没准备好，顶栏仍是绿的；开盘后才发现不能下单 |
| 09:00 多柜台盯盘 | 同时看 SimVenue 的期权链、SimNow 的期货对冲腿、SimLocal 的策略 | §5.2 订单/成交/持仓默认“当前柜台”；监控默认“全部柜台”；两者切换不在同一屏，且没有“其他柜台还有多少风险”的常驻提示 | 盯 A 柜台时，B 柜台持仓/挂单/策略失控看不见 |
| 盘中手工单 | 看准当前柜台，填合约/方向/开平/价格/数量，预检，确认 | §5.1 说“只选择合约、方向、价格、数量”，漏了开平/平今/平昨/TIF；确认框也没有这些字段 | 想平今变成开仓，或平仓被拒；SHFE/INE 的平今平昨是硬需求 |
| 盘中应急 | 发现一个柜台异常，想只撤该柜台或只对该柜台只减仓 | §4.1 顶栏“全撤/停全部/只减仓”没有范围；现状 `cancel-all` 默认 `scope=ALL`，`stop-all` 会全策略平仓 | 想救一个柜台，结果把另一个正在跑的实盘策略也停了/平了 |
| 策略部署 | 看当前柜台有哪些策略，部署/停止/回滚 | §4.3 “策略部署页面筛选到当前柜台”；当前柜台是 SimVenue 时，SimLocal 上的 ACTIVE 部署被隐藏 | 以为没有策略在跑，实际另一个柜台还在报价 |
| 跨柜台套利 | 两条腿分别在不同柜台/账户/ORS，想看组合风险 | §9 一边说“同一策略不能同时部署到多个 ORS”，一边说“跨柜台套利必须显式配置两条腿”；§6.1 只有单个 `target_ors_id` | 模型自相矛盾，交易员无法表达两条腿，也无法做组合保证金/对账 |

---

## 3. P0（上模拟盘/试点前必须解决）

### P0-01 概念模型：`counterparty.exchange` 把“柜台”和“交易所”压成一个对象

**设计稿位置**：§2.1 架构图、§2.2 不变量、§3 概念表、§6.1 `counterparty.exchange`、§7.3 校验 `instrument.exchange compatible with counterparty`、§13 验收。

**问题**：
- §2.1 写的是“柜台（Counterparty / Exchange）”，把接入通道和市场当成同义词；§3 又把 `Exchange` 描述为“合约属性；v1 与柜台一起展示”。
- §6.1 的 `counterparty` 只有一个 `exchange` 字段（SHFE / DCE / CZCE / CFFEX / SIM）。真实 CTP 里 SimNow 是模拟 CTP 前置、SimShengli 是券商 CTP 前置，一个柜台可以接多个交易所；一个 InvestorID 也可以在多个交易所交易。
- §2.2 的“1 柜台 = 1 账户”作为 v1 部署约束可以接受，但设计稿把它写成了业务事实；真实 CTP 一个柜台可以有多个资金账户，一个账户也可以有多个交易所编码。

**交易员影响**：
- 一个 SimNow 账户想同时做 au2612（SHFE）和 TA701（CZCE），按现模型要么建两个“柜台”，账户/ORS 被复制，违反 1:1；要么保留一个柜台，但 `instrument.exchange compatible with counterparty` 会把另一个交易所的订单判错。
- 切换“柜台”实际变成切换“交易所”，行情、持仓、对账被拆成碎片；交易员看到的“当前柜台”和券商实际前置不是一回事。
- 同一个 InvestorID 被两个假柜台/两个 ORS 同时登录，CTP 会互踢，盘中直接断线。

**具体修改建议**：
1. 拆成四层，并在文档里给一张对照表：
   - `Counterparty`（接入通道/CTP 前置）：SimLocal、SimVenue、SimNow、SimShengli；
   - `Exchange`（市场）：SHFE、DCE、CZCE、CFFEX、INE、SIM；
   - `Account`（BrokerID + InvestorID，挂在 Counterparty 下）；
   - `ExecutionContext`（Counterparty + Account + ORS + Environment）。
2. 删掉 `counterparty.exchange`，改为 `counterparty_exchange` 关联表或 `supported_exchanges`；`instrument.exchange` 是合约属性，`orders` 同时快照 `counterparty_id` 和 `exchange`。
3. v1 的 1:1 明确写成：“当前四个 SIM 柜台按 1 柜台 1 账户 1 ORS 部署；真实 CTP 允许 1 柜台 N 账户、N 交易所，模型不得阻止”。在 §12 加迁移路径，而不是以后重做表。
4. API 的 `counterpartyId` 只解决“哪个前置”，订单校验再加 `exchange` 与 `instrument.exchange` 一致；页面筛选的“交易所”与“柜台”分开，不要互相替代。
5. 验收加一条：`SimNow 一个账户同时下 au2612（SHFE）与 TA701（CZCE），行情/持仓/对账不串`。

---

### P0-02 “当前柜台”选择器仍然混淆柜台、账户、ORS，而且账号仍可独立选择

**设计稿位置**：§2.4 顶部选择器、§4.1 布局、§4.2 下拉内容、§5.1 “交易账户只读”、§6.3 `CounterpartyContext`。

**问题**：
- §2.4 说选择器表示 `Counterparty + Account + ORS + MarketData + OrderRoute + Calendar`，但 §4.2 的每一项写成 `SIMLOCAL-001 · SIMLOCAL · RUNNING`，把账户和柜台并列展示；交易员会以为“柜台”和“账户”是两个可独立选择的东西。
- 设计稿没有定义选择器的**值**是什么：是 `counterpartyId`、`accountId` 还是 `orsId`。§6.3 的 `CounterpartyContext` 三个都有，但 §7.1 `GET /execution/contexts` 实际返回的是 ORS 行。
- 现状实现里，`useVenues` 把 `id` 设成 `ors_id`，名称是 `account_id · venue_name`；侧栏又单独显示“账户”；`ManualOrder` 仍有账户下拉框，且用户可以把它改成与顶部柜台不一致的账户。设计稿 §5.1 说“不再单独选择账户”，但没有说删除侧栏账户、删除手工单账户下拉、服务端如何拒绝不一致。

**交易员影响**：
- 顶部显示 `SIMVENUE`，手工单账户下拉却可以选 `SIMLOCAL-001`；`ManualOrder` 的 `exchange` 仍取当前柜台的 `venueId`，服务端 `TradingController` 又不校验 `account.venue_id == exchange`，结果可能是“SIMVENUE 的通道 + SIMLOCAL 的账户”，或者被柜台拒单。
- 用户以为切的是“柜台”，实际切的是“ORS”；ORS 重启换 `ors_id` 后，`lastCounterpartyId` 丢失，默认回到第一个可用柜台。
- 同一柜台下有两个账户时，顶部无法分别选择；只能改代码或改 URL，交易员做不到。

**具体修改建议**：
1. 明确选择器身份：`ExecutionContext`，字段为 `contextId / counterpartyId / accountId / orsId / environment / status / contextVersion`；选择器存 `contextId`，不存 `orsId`。
2. 显示改为两行：主行 `SimVenue`（柜台），副行 `SIMVENUE-001 · ors-simvenue-001 · RUNNING · SIM`；账户是上下文的一部分，不再是独立下拉。
3. 删除侧栏“账户”块和 `ManualOrder` 的账户 `<TextField select>`；手工单只显示只读的“柜台 / 账户 / ORS / 环境”四行。
4. `OptionChain` 的请求字段从 `exchange: venue` 改为 `contextId` / `counterpartyId`；服务端按上下文解析账户和 ORS，禁止客户端传一个和上下文不一致的 `accountId`。
5. 旧的 `qf_venue`、`preferredOrsId` 做一次迁移：`preferredOrsId → contextId`，找不到就显示“上次柜台不可用，请重新选择”，不要自动选第一个可用。

---

### P0-03 行情没有按柜台建键：同合约多柜台必然串价，手工单校验用的是全局最新价

**设计稿位置**：§3 `MarketData 1:1 柜台`、§4.3 `marketDataScope`、§8.1 行情隔离、§7.3 下单校验。

**问题**：
- §8.1 说“每个柜台必须使用独立行情流，或消息中携带 `counterpartyId`”，但用了“或”；示例里 `SIMLOCAL md_stream=1001`、`SIMVENUE md_stream=1001`，又补一句“如果数据源相同，仍需带 counterpartyId”。这等于没有规定唯一性：同 channel 同 stream 时两条流无法区分，SBE 消息也没有说加字段。
- 设计稿没有规定控制面行情存储的键。现状 `MarketDataService.latest` 是 `Map<String, Tick>`，只按 `instrumentId`；WS `toJson` 不带 `counterpartyId`；`/api/v1/market/ticks` 返回所有；`OptionChainController`、`PortfolioController`、`IndicatorEngine`、`StrategyPnlService` 全部按 `instrumentId` 取全局 tick。
- 现状 `TradingController.validateOrder` 的价格偏离校验也是 `marketData.tick(request.instrumentId())`，不区分柜台；同合约在 SimVenue 和 SimNow 都有报价时，可能拿 SimNow 的价格去校验 SimVenue 的订单。
- `MarketDataService.seedFixedTicks` 在启动时写入 `"fixed"` 的 au2612/ag2612 固定价，时间戳是当前时间；`isSyntheticSource("fixed")` 为 false，所以它能停留 5 秒并通过“行情龄 < 5s”的校验。

**交易员影响**：
- 切到 SIMVENUE 后，ticker 可能显示 SimNow 的 au2612；看到的价格和实际能成交的柜台不是同一个市场。
- 手工单的“偏离最新价 5%”校验用了错柜台的价格，可能把正常单判为异常，也可能放过真正偏离当前柜台价格的单。
- 启动后前几秒，固定种子价可以充实行情，交易员在真实行情还没到时就能下单。
- 一个模拟柜台的 tick 可能被全局“真实行情优先”规则丢弃（`isSyntheticSource` 直接 return），导致切到 SimVenue 后一直没有行情，但顶部仍显示“行情 WS 已连接”。

**具体修改建议**：
1. 行情唯一键改为 `(counterpartyId, instrumentId, source)`；`md_channel + md_stream` 必须成对唯一，不能只要求 stream 唯一。
2. SBE `MarketData` 增加 `counterpartyId` / `venueId`；WS 消息和 `/api/v1/market/ticks` 必须带 `counterpartyId`，且接口参数必填；没有 `counterpartyId` 的请求默认拒绝，而不是返回全部。
3. `OptionChainController`、`IndicatorEngine`、`PortfolioController`、`StrategyPnlService`、`TradingController.validateOrder` 全部改为接收 `ExecutionContext`，按同一 `(counterpartyId, instrumentId)` 取价。
4. 删除 `seedFixedTicks`，或改成显式的 `FIXTURE` 数据源：只在开发构建出现，标注 `FIXTURE`，且所有下单/预检直接拒绝；SHADOW/LIVE 不允许固定种子价。
5. 行情断线/无报价时，当前柜台进入 `NO_MARKET_DATA`，下单按钮禁用，服务端拒绝；不允许 fallback 到其他柜台的价格。
6. 验收用例：同一 `au2612` 同时在 SIMVENUE 和 SIMNOW 有不同价格，切柜台后 ticker、期权链、预检、成交回报全部使用各自价格；断开其中一个，另一个不受影响。

---

### P0-04 路由/回报没有所有权闭环：无 ACTIVE ORS 会回退 legacy，旧 ORS 的回报能覆盖新 ORS

**设计稿位置**：§2.2 `1 账户 = 1 ACTIVE ORS`、§4.4 “不允许静默 fallback”、§6.1 `fencing_token`、§8.2 “当前柜台订单不得发到 SIMLOCAL 的 2120”、§13 验收。

**问题**：
- 设计稿只写了“不允许”，没有写“路由解析失败时怎么办”。现状 `ManualOrderPublisher.routeInfo(accountId)` 在找不到 RUNNING 路由或抛异常时，会返回 `legacy` 的 `AeronStreams.CHANNEL` / `ORDER_REQUEST`；这条 legacy stream 可能被 SimLocal 或旧进程消费。也就是说，SIMVENUE 的 ORS 停了，订单仍可能被发到 SIMLOCAL 的流。
- 选择器也有同样的 fallback：`useVenues` 在 `preferredOrsId` 不可用或 `selected.enabled == false` 时，自动选第一个 `enabled` 的上下文；交易员没有看到“切换了”，但实际执行上下文已经变了。
- `SystemStatusController` 的 `agentOnline` / `orsRunning` 用 `anyMatch`：任意一个 ORS RUNNING、任意一个 Agent ONLINE，顶栏就显示可用；切到 STOPPED 的柜台，顶栏仍是“交易通道已连接”。
- 回报侧 `AeronOrderUpdateConsumer` 按 `clientOrderId` 应用更新，`applyOrderUpdate` 只有 `last_update_seq` / `last_update_ts` 的保护，没有任何 `orsId` / `fencingToken` / `generation` 校验；ORS 重启后 sequence 归零，可能出现“新 ORS 的更新被 `GREATEST` 丢掉”，或者“旧 ORS 的 CANCELED 覆盖新 ORS 的 FILLED”。

**交易员影响**：
- 柜台 A 的 ORS 停了，下一笔单可能静默走 legacy/柜台 B 的通道；成交回报的账户/柜台与交易员看到的当前柜台不一致。
- 交易员在 A 柜台以为什么都没发生，实际 B 柜台已经成交；或者看到“已撤”，实际新 ORS 已经成交，导致重复下单。
- 这类错误不会在页面上明显暴露，属于最危险的“看似生效、实际错柜台”。

**具体修改建议**：
1. `OrderRouter` 严格 fail-closed：没有 `RUNNING + fencingToken 有效 + account 匹配` 的路由，返回 `NO_ACTIVE_ROUTE`，不插订单、不发 Aeron、不更新本地状态；删除 `legacy` 回退常量和 `catch` 里的默认路由。
2. 选择器删除“自动选第一个 enabled”；当前上下文不可用时显示不可用原因，要求交易员手动选择或切换到其他柜台；切换动作必须写审计（旧/新 contextId、contextVersion）。
3. `SystemStatus` 改为按 `contextId` 返回 `orsStatus / agentStatus / mdStatus / orderChannelStatus / lastHeartbeat / error`；顶栏只显示当前上下文的健康，不再用“任意 ORS”汇总。全局汇总另外放“柜台总览”，并明确标注“全部柜台”。
4. `OrderUpdate` / `Trade` 增加 `orsId`、`fencingToken`、`generation`；消费端只接受与订单快照匹配的回报，旧 `fencingToken` / 旧 generation 直接丢弃并记录 `STALE_UPDATE`；订单表保存最后接受的 `orsId` / `fencingToken`，不能只靠 `clientOrderId`。
5. ORS 重启/换 generation 时，旧 stream 上的未完成回报要有明确的“冻结/丢弃/人工核对”策略；不能靠 sequence 大小猜。
6. 验收用例：停掉 SIMVENUE ORS 后下单，必须返回 `NO_ACTIVE_ROUTE` 且 Aeron 无消息；旧 ORS 发一个 CANCELED，新 ORS 已 FILLED，页面必须保持 FILLED 并产生 `STALE_UPDATE` 告警。

---

### P0-05 切换柜台没有 contextVersion：已打开的预检/确认框会把订单发到新柜台

**设计稿位置**：§4.3 “切换柜台时原子更新”、§4.4 只提到“手工单表单有未提交内容时确认”、§5.1 提交确认、§6.3 `CounterpartyContext`。

**问题**：
- §4.3 说切换时原子更新 `accountId / orsId / orderChannel / ...`，但 §6.3 的 `CounterpartyContext` 没有 `contextVersion` / `generation`；设计稿没有规定“切换后旧的预检、确认框、批量撤单对话框怎么办”。
- §4.4 只保护“手工单表单有未提交内容”；期权链快捷下单、订单确认弹窗、策略部署弹窗、批量撤单弹窗都没有保护。
- 现状 `OptionChain` 的 `currentPreviewKey` 只包含 `instrument|action|price|qty`，不包含柜台/账户；切换柜台后旧的 preview 仍然 `previewKey === currentPreviewKey`，提交时 `accountId` 和 `exchange` 已经变成新柜台，价格却是旧柜台预检时的价格。`ManualOrder` 的 `submit` 只检查 `preview.allowed`，不校验价格/柜台/账户是否变化。

**交易员影响**：
- 在 SIMVENUE 看到价格 11800，预检通过；切到 SimLocal 后确认框还在，按回车，订单以 SimLocal 的账户/通道、11800 的价格发出。两边价格可能差很多。
- 交易员以为自己只是“切过去看一眼”，实际把待确认单带到了另一个柜台。这是最典型的错柜台下单路径。

**具体修改建议**：
1. `ExecutionContext` 增加 `contextVersion`（单调递增），每次切换柜台/账户/ORS/环境都递增；切换后所有旧 `previewId` 立即失效。
2. `preview` 响应返回 `previewId + contextVersion + contextId`；下单请求必须带 `previewId + contextVersion`；服务端校验不一致则 409 `CONTEXT_CHANGED`，要求重新预检。
3. 前端在 `contextVersion` 变化时：关闭所有确认框/批量操作框，清空 `preview`，显示“执行上下文已从 SIMVENUE 切换到 SimLocal，请重新预检”，不要只弹一个 toast。
4. 把手工单、期权链快捷下单、批量撤单、策略部署统一到同一个“上下文感知表单”规范；每个危险动作在提交时都带 `contextVersion`。
5. 验收用例：预检后切柜台，提交必须被拒绝；确认框必须自动关闭/置灰；日志里能看到旧/新 contextVersion。

---

### P0-06 权限只写在 §11，服务端没有账户级授权，任何 TRADER 可以看/交易所有账户

**设计稿位置**：§2.3 登录用户与交易账户分离、§6.1 `user_account_permission`、§7.1 `GET /me/counterparties`、§11 权限与审计。

**问题**：
- §11 说“用户只能看到有权限的柜台/账户”“交易员只能对授权账户下单”，但 §7 的 API 没有定义权限过滤的语义，§6.1 的 `user_account_permission` 也没有唯一键、默认拒绝、角色继承、权限变更审计。
- 现状 `SecurityConfig` 只做全局角色：GET 只要 ADMIN/TRADER/RISK/VIEWER 即可，POST 只要 ADMIN/TRADER；`/api/v1/execution/contexts` 返回所有 RUNNING ORS；`TradingController` 对手工单只校验账户存在且 active，不校验当前用户是否有该账户权限，也不校验账户是否属于请求的柜台。
- `VIEWER` 也能 GET 所有账户、持仓、订单；多柜台实盘下这是数据隔离和合规问题。

**交易员影响**：
- 一个交易员在手工单账户下拉里能选到别的交易台账户；一旦误选，订单真的会发到那个账户。
- 管理员以为“权限已经按柜台分”，实际只是前端少显示一个选项；脚本/直接调用 API 可以绕过。
- 事后审计只能看到“谁点了”，看不出“他是否有权对该账户下单”。

**具体修改建议**：
1. `user_account_permission` 加 `(user_id, account_id)` 唯一键，字段 `role TRADER/VIEWER/ADMIN`、`granted_by`、`granted_at`、`expires_at`；默认拒绝。
2. 服务层统一 `AuthorizationService.require(accountId, action)`：`VIEW` / `TRADE` / `CANCEL` / `EMERGENCY`；所有数据接口和下单接口都走它，不能只靠 Controller 注解。
3. `/execution/contexts`、`/me/counterparties`、`/orders`、`/trades`、`/positions` 全部按用户权限过滤；无权限的 `counterpartyId` 返回 403，不要返回空列表冒充“没有数据”。
4. 手工单不再信任客户端 `accountId`：只接受 `contextId`，服务端从上下文解析账户；请求里的 `accountId` 只能作为“期望值”用于一致性校验，不匹配就拒绝。
5. 审计增加 `DENIED_ORDER` / `DENIED_VIEW` / `PERMISSION_CHANGE`；权限变更必须四眼或 ADMIN，且立即让已打开的页面失效（contextVersion 或权限版本）。
6. 验收矩阵：VIEWER 只能看授权账户；TRADER 只能对授权账户下单；ADMIN 可管理但不默认拥有交易权（是否给 ADMIN 交易权请交易员确认）；越权请求 403 且有审计。

---

### P0-07 应急操作没有范围：当前柜台按“全撤”，会撤掉/平掉所有柜台

**设计稿位置**：§4.1 顶栏“系统连接 / 只减仓 / 紧急操作”、§5.2 “全部柜台只读”、§11 “紧急操作记审计”。

**问题**：
- §4.1 把“只减仓 / 紧急操作”放在全局顶栏，但没有定义作用域；§5.2 只说“全部柜台不能直接下单”，没有说“全撤/停全部/只减仓”的范围。
- 现状 `AppShell` 的“全撤”调用 `/api/v1/emergency/cancel-all`，请求体固定 `{ scope: 'ALL' }`；`EmergencyController.cancelAll` 支持 `ALL / account:<id> / instrument:<id>`，没有 `counterparty:<id>`；`stopAll` 会 pause 所有策略、pause 所有 deployment、cancelAll(ALL)、并逐个策略 flatten；`reduce_only` 是全局 `system_state`。
- 设计稿 §4.4 只保护“切柜台”，没有保护“应急操作的范围”。

**交易员影响**：
- 在 SIMVENUE 发现一个策略失控，点“全撤”，结果把 SimNow 实盘账户的挂单也撤了；点“停全部”，把另一个柜台的策略平仓。
- 反过来，交易员以为“只减仓”只作用于当前柜台，实际全局禁止开仓，另一个柜台的正常策略突然停止开仓，错过行情。
- 紧急操作没有“影响范围预览”，交易员在盘中不敢用，或者用错。

**具体修改建议**：
1. 定义 `EmergencyScope = CURRENT | SELECTED(counterpartyIds[]) | ALL`；顶栏默认 `CURRENT`，按钮文案写清“全撤当前柜台”；`ALL` 必须显式选择并输入 `ALL` 或柜台数量确认。
2. `cancel-all` 增加 `counterpartyId` / `accountId` 过滤，返回逐柜台、逐订单回执；`stop-all` 增加 scope，`ALL` 时必须列出受影响柜台/账户/策略/持仓，二次确认。
3. `reduce-only` 改为按 `counterpartyId` / `accountId` 存储（或至少支持全局+柜台覆盖），顶栏显示“只减仓: 全局”或“只减仓: SIMVENUE”，不能只显示一个开关。
4. 紧急操作对话框固定显示：范围、每个柜台的未完成订单数、持仓名义、ACTIVE 策略数、预计影响；默认焦点在“取消”。
5. 审计记录 `scope`、`counterpartyIds`、`orderCount`、`flattenCount`、逐柜台结果；部分失败必须保留失败列表。
6. 验收用例：两个柜台各有挂单，选择“当前柜台全撤”，另一个柜台订单数不变；选择“全部”必须二次确认并显示两个柜台的清单。

---

### P0-08 对账/持仓/成交没有真正按柜台隔离，且对账门禁没有接到下单

**设计稿位置**：§7.2 `positions?counterpartyId`、`trades?counterpartyId`、§10 “每个柜台独立对账”、§13 “柜台级对账失败只阻塞该柜台”。

**问题**：
- §10 写了每个柜台独立对账，但没有定义对账结果的数据模型（`counterpartyId / accountId / tradingDay / scope / status / diffCount / lastRunAt`）、没有定义 API、没有定义“失败时阻塞哪个动作”。§13 的验收只有一句话，无法测试。
- 现状 `VenueReconciliationController` 只返回硬编码的 `simLocal` / `simVenue` 两个对象；`/api/v1/positions` 返回全部账户，`/api/v1/trades/page` 没有 account/counterparty 参数；`TradingController.validateOrder` 没有检查 reconciliation gate。
- 架构评审已经出现过：`local openOrders = 2`、`venue openOrders = 31`、`differences = 29 missing_locally`，但 reconciliation/consistency 仍显示 `passed=true`。这说明“本地一致”不等于“柜台一致”。

**交易员影响**：
- 页面显示“对账通过”，实际柜台还有 29 笔挂单没同步；交易员按本地持仓做对冲，实际敞口更大。
- 切到 SIMVENUE 看持仓，页面可能混入 SimNow/SimLocal 的账户；平仓时以为平的是当前柜台，实际平了另一个账户。
- 对账失败时，要么全系统禁止开仓（过度），要么完全不拦（危险）；设计稿没有说清。

**具体修改建议**：
1. 建 `reconciliation_run`：`run_id / counterparty_id / account_id / trading_day / scope(orders|trades|positions|account) / status(PASS|FAIL|RUNNING|STALE) / diff_count / details_json / started_at / finished_at`；每个柜台独立跑、独立展示、独立 gate。
2. `reconciliationGate` 按 `accountId` / `counterpartyId` 判定：失败只阻塞该账户/该柜台的新开仓，不影响其他柜台；手工单、策略单、算法单都走同一个 gate。
3. `/positions`、`/trades`、`/orders` 增加 `counterpartyId` / `accountId` / `contextId` 过滤；默认按页面范围（订单/成交当前柜台，持仓见 P1-12 的建议）。
4. 顶栏/柜台下拉显示每个柜台的 `recon: PASS/FAIL/STALE + lastRunAt`；对账失败时当前柜台的“下单”按钮禁用，并显示差异摘要和“查看差异”入口。
5. 对账结果必须和柜台/账户的实际快照比对，不能用本地 orders 自洽结果；对账失败不得用“全局 passed”放行。
6. 验收用例：只让 SIMVENUE 的 venue 快照少 1 笔订单，必须只有 SIMVENUE 的 OPEN 被阻塞，SIMLOCAL/SimNow 不受影响，页面显示差异明细。

---

### P0-09 Phase 1 先改 UI 名称、后做页面范围，会复现“切换后页面没变化”

**设计稿位置**：§12 Phase 1 / Phase 2、§4.3 “订单/持仓默认范围切换到新柜台”、§5.2 默认范围、§13 验收。

**问题**：
- Phase 1 只写“UI 将场所/账户改为当前柜台；切换柜台联动手工单、期权链、行情 ticker”；订单、成交、持仓、策略的柜台过滤在 Phase 2。也就是说，Phase 1 完成后，交易员切到 SIMVENUE，订单页/持仓页/策略页仍然可能是全部账户或旧账户。
- §4.3 却承诺“切换后订单/持仓默认范围切换到新柜台”，与 Phase 1 的范围不一致；§13 验收又要求“切换 SIMVENUE 后行情、账户、ORS、下单通道、日历一起切换”，没有覆盖订单/持仓/策略页面。
- 用户已经明确反馈“切换后页面没变化”；现稿的 Phase 1 会让这个反馈继续存在，而且新的“当前柜台”标签会让用户更相信它已经生效。

**交易员影响**：
- 切到 SIMVENUE 后，订单页仍显示 SIMLOCAL 的挂单，交易员以为 SIMVENUE 没有挂单，可能重复下单。
- 持仓页仍显示全部账户，交易员以为当前柜台持仓很小，实际另一柜台有大敞口。
- 策略页仍显示全部策略，交易员以为当前柜台没有 ACTIVE 策略，实际另一个柜台在报价。

**具体修改建议**：
1. 调整顺序：Phase 1 先做后端 `ExecutionContext` + `/orders`、`/trades`、`/positions`、`/strategies` 的柜台过滤 + 删除 fallback + 顶栏按上下文显示健康；Phase 2 再做 UI 名称和视觉。
2. 如果必须保留 Phase 1 改名，加 feature flag：未完成页面过滤前，顶部显示“当前柜台（仅影响手工单/期权链/行情）”，订单/持仓页显示“范围：全部柜台”；不要用一个“当前柜台”骗所有页面。
3. 在 §13 增加明确验收：
   - 切换 SIMVENUE 后，订单/成交/持仓/策略 4 个页面的默认范围和页面标题同时变化；
   - 任一页面不跟随，视为 Phase 1 未完成；
   - 用 e2e 截图对比切换前后 6 个页面（手工单、期权链、订单、成交、持仓、策略）。
4. 给 Phase 1 加“旧页面回归清单”，不要只写“UI 改名”。

---

### P0-10 手工单/确认框漏掉开平、平今平昨、TIF，交易员会把平仓做成开仓

**设计稿位置**：§5.1 “用户只选择合约、方向、价格、数量”、§5.1 提交确认的 6 行字段。

**问题**：
- §5.1 明确写“用户只选择合约、方向、价格、数量”，没有开平、平今/平昨、订单类型、TIF、只减仓；提交确认框也只列 `柜台/账户/ORS/合约/方向/价格/数量`。
- 现状 `ManualOrder` 已经有 `OPEN / CLOSE / CLOSE_TODAY / CLOSE_YESTERDAY`，并且对 SHFE/INE 区分平今/平昨；`OptionChain` 快捷下单却固定 `offset: 'OPEN'`。设计稿如果按“只选四个字段”实现，会把已有能力砍掉，或者把开平藏到默认值里。
- 设计稿 §7.3 的下单 JSON 也没有 `offset` / `timeInForce` / `orderType` / `reduceOnly`，与 UI 现状和 §5.1 的“只选四个字段”互相印证，说明模型确实漏了。

**交易员影响**：
- 想平今，系统按开仓发；或者想平仓，系统默认开仓，持仓翻倍。
- SHFE/INE 的平今/平昨手续费和保证金不同；错误 offset 会被柜台拒绝，盘中错过平仓时机。
- 期权链快捷下单无法平仓，只能开新仓；到期/行权前无法从链上直接减仓。

**具体修改建议**：
1. §5.1 改成“用户选择：合约、方向、开平（开仓/平仓/平今/平昨）、价格、数量、订单类型、TIF、只减仓”；账户/柜台/ORS 只读。
2. 确认框增加：`开平（请求）→ 实际解析（OPEN/CLOSE_TODAY/CLOSE_YESTERDAY）`、TIF、订单类型、名义金额、预计保证金、可用资金、价格偏离、`source=MANUAL`。
3. 服务端返回 `resolvedOffset` 和原因（例如“SHFE 今仓优先平今”）；前端必须展示，不能只显示请求的 `CLOSE`。
4. `OptionChain` 快捷下单增加开平选择，默认“开仓”，但平仓/平今必须显式；到期前默认只允许平仓。
5. 验收用例：SHFE 有今仓和昨仓，选择“平仓”时服务端按规则拆成平今/平昨；确认框显示实际解析；错误 offset 被拒绝且原因可读。

---

### P0-11 LIVE/SHADOW 环境没有按柜台隔离，切柜台可能从模拟切到实盘

**设计稿位置**：§6.1 `counterparty.environment SHADOW / LIVE`、§4.1 顶栏单一 `SHADOW`、§4.2 下拉项没有环境字段、§11 权限。

**问题**：
- 模型里 `environment` 是 `counterparty` 的属性，但 §4.1 顶栏只有一个全局 `SHADOW` chip；§4.2 的每个柜台项只显示 `账户 · 柜台 · ORS 状态`，没有 `SIM/SHADOW/LIVE`。
- 设计稿没有定义从 SIM 柜台切到 LIVE 柜台时的额外确认、颜色带、水印、审批；也没有定义手工单确认框如何显示环境。§5.1 的确认字段没有环境。
- 现状 `AppShell` 的环境 chip 来自 `/system/status` 的全局 `environment`，不是当前柜台；登录页还写死 `SHADOW ENVIRONMENT`。

**交易员影响**：
- 在 SimVenue 模拟环境点一下下拉，切到 SimNow 实盘，页面布局完全一样，只是账户名变了；预检、确认、下单都可能以为还在模拟。
- 交易员在 LIVE 柜台看到 `SHADOW` 顶栏，或者反过来，直接违反“先模拟后实盘”的操作纪律。

**具体修改建议**：
1. `ExecutionContext` 必须包含 `environment`；顶部主色带、下拉项、订单确认框、持仓页水印都显示当前柜台的环境。
2. `SIM`（蓝）/`SHADOW`（紫）/`LIVE`（红）三套不能只靠 chip，至少要有顶栏色带 + 页面角标；LIVE 的确认框必须显示红色“实盘”并重复账户/柜台。
3. 从非 LIVE 切到 LIVE 时：要求重新输入登录密码或输入柜台名确认；切换后强制重新预检，不能复用旧 preview；记录审计。
4. v1 如果没有实盘计划，明确写“LIVE 柜台在 v1 禁用”，不要只留一个 `environment` 字段让实现者猜。
5. 验收用例：SIM→LIVE 切换必须二次确认；LIVE 下单确认框包含 `LIVE`；把 LIVE 柜台当 SIM 下单的路径不存在。

---

## 4. 边界场景逐项核查（对应评审要求 5）

| 场景 | 现稿行为 | 风险 | 必须在设计里补的规则 |
|---|---|---|---|
| 切柜台时手工单有未提交内容 | §4.4 要求确认，列出旧/新柜台和账户 | 只保护“手工单表单”，不保护期权链快捷下单、批量撤单、策略部署弹窗 | 所有订单入口统一 `contextVersion`；确认框列出旧/新上下文；禁止静默保留 |
| 切柜台时已打开确认框/预检 | 未定义；现状 `OptionChain` previewKey 不含柜台/账户 | 旧预览在新柜台提交，价格/账户/通道错配 | 切换即失效所有 `previewId`；提交带 `previewId + contextVersion`；服务端 409 |
| 行情断线/当前柜台无行情 | §4.4 只说“柜台 STOPPED/OFFLINE 不能下单”；没有行情断线规则 | 用其他柜台的价格下单，或用旧价下单 | 当前上下文 `NO_MARKET_DATA` 时禁用/拒绝下单；不得 fallback 到其他柜台 tick |
| 柜台 STOPPED/OFFLINE | §4.2 置灰；§4.4 不能下单 | 选择器只查 RUNNING，STOPPED 柜台直接消失；自动 fallback 到其他柜台 | 返回全部上下文（含 STOPPED/OFFLINE/ERROR），显示原因；不自动切换；下单 `NO_ACTIVE_ROUTE` |
| ORS ERROR/HALTED/重启 | §6.3 状态只有 RUNNING/STOPPED/OFFLINE；没有 STARTING/SETTLING | 页面显示 RUNNING 但实际不能交易；重启后旧回报/新序列冲突 | 增加 `STARTING/ERROR/HALTED/SETTLING/SETTLEMENT_CONFIRMED/TRADING_READY`；回报带 generation/fencing |
| 旧回报/fencing | §6.1 有 `fencing_token`，§8.2 有路由约束；但没有回报校验 | 旧 ORS 的 CANCELED 覆盖新 ORS 的 FILLED；或新回报被 sequence 丢弃 | 回报带 `orsId/fencingToken/generation`；旧值丢弃并告警；事件日志可重放 |
| 全部柜台只读 + 行内撤单 | §5.2 只说“不能直接下单”，没有说撤单/平仓 | 在“全部柜台”视图里点行内撤单/平仓，目标柜台不明确 | “全部柜台”禁止下单/撤单/改单/平仓；行内动作只能“切换到该柜台后操作” |
| 对账失败 | §10 说独立对账；§13 说只阻塞该柜台 | 现状对账硬编码且假阳性；没有 gate | 按账户/柜台 gate；失败只阻塞该柜台开仓；页面显示差异 |
| 权限被收回/切换中 | §11 只说“只能看到有权限的柜台” | 已打开页面仍可提交；contextVersion 不变 | 权限版本变化让页面失效；提交时再校验；403 + 审计 |
| 切柜台时策略部署弹窗打开 | §4.3 说“不改变已有部署”，但没有说弹窗目标 | 部署弹窗的目标 ORS 还是旧柜台，点确认部署到旧柜台 | 部署弹窗显示目标上下文；切换时关闭或重选；部署请求带 `contextVersion` |

---

## 5. P1（试点期内必须解决）

### P1-01 下拉项展示仍像“账户选择器”，缺少环境、角色、可用性原因

**设计稿位置**：§4.2、§6.3 `CounterpartyContext.status`。

**问题**：§4.2 每项是 `账户 · 柜台 · ORS 状态`，但选择器叫“当前柜台”；没有 `environment`、当前用户在该柜台的 `role`（TRADER/VIEWER）、`lastHeartbeat`、`error`。§6.3 的 `status` 只有 `RUNNING|STOPPED|OFFLINE`，与 §14 文档里的 `STARTING/ERROR/HALTED` 不一致。

**交易员影响**：看到 `SIMVENUE-001` 不知道自己是只读还是可交易；看到 `RUNNING` 不知道是“进程在”还是“可下单”；STOPPED 项被置灰但没有原因。

**修改建议**：下拉项两行显示：主行柜台名 + 环境色点，副行 `账户 · ORS · 状态 · 角色`；不可用项可聚焦，展开显示 `lastHeartbeat / error / 原因`；`CounterpartyContext.status` 与 §14 状态机对齐，另加 `tradable: boolean`。

---

### P1-02 `/execution/contexts` 只返回 RUNNING，STOPPED/OFFLINE 柜台在 UI 里直接消失

**设计稿位置**：§4.2 “不可用柜台置灰”、§7.1 `GET /execution/contexts`。

**问题**：现状 `ExecutionMapper.xml` 的 `listContexts` 带 `WHERE o.status = 'RUNNING'`；设计稿 §4.2 却要求显示 STOPPED/OFFLINE。两者不一致。用户切到停掉的 SimNow 时，下拉里根本没有它，系统会自动选另一个可用柜台。

**交易员影响**：不知道 SimNow 是停了还是没配置；以为自己在 SimNow，实际已经在 SimLocal；无法主动切到一个“登录中/停止”的柜台排查。

**修改建议**：`/execution/contexts` 返回全部上下文（至少包含当前用户有权限的），字段加 `tradable / statusReason / lastHeartbeat / error`；选择器保留不可用项并置灰；不要自动 fallback，改为提示“上次柜台不可用，请重新选择”。

---

### P1-03 顶栏“系统连接/行情延迟”是全局汇总，不是当前柜台

**设计稿位置**：§4.1 顶栏 `系统连接: UP`、§4.3 `marketDataScope`。

**问题**：`SystemStatusController` 的 `agentOnline`、`orsRunning` 用 `anyMatch`，`marketFresh` 用全市场最新 tick；当前柜台 ORS 停了，只要另一个柜台在跑，顶栏仍是“交易通道已连接”。

**交易员影响**：切到 STOPPED 的柜台，顶栏绿色；下单后才发现不能交易。行情延迟也是另一个柜台的数据，误导判断。

**修改建议**：`/system/status` 按 `contextId` 返回 `controlPlane / agent / ors / market / orderChannel` 五项；顶栏只显示当前上下文；全局汇总放到“柜台总览”，并标注“全部柜台”。

---

### P1-04 页面范围控件把“当前柜台/全部柜台/具体柜台”混在一起，且没有“非当前柜台只读”提示

**设计稿位置**：§5.2 `范围：[当前柜台 ▼] [全部柜台] [SimNow] [SimVenue]`。

**问题**：同一个控件里同时有“当前柜台”“全部柜台”“具体柜台”，交易员无法一眼看出当前是执行上下文还是页面范围；选择 SimNow 时顶部可能还是 SimVenue，页面没有“你正在看非当前柜台”的提示。

**交易员影响**：以为页面范围就是执行柜台，直接在行内下单/撤单；或者以为切了页面范围就切了执行上下文。

**修改建议**：范围控件改成 `当前柜台 / 全部柜台（只读） / 自定义多选`；页面标题旁显示 `范围: 全部柜台 · 只读` 或 `范围: SimNow · 非当前柜台`；任何行内下单/撤单/平仓按钮在“非当前柜台”时禁用，只保留“切换至该柜台”。

---

### P1-05 策略页按当前柜台筛选，会隐藏其他柜台的 ACTIVE 部署

**设计稿位置**：§4.3 “策略部署页面筛选到当前柜台，但不会改变已有部署”、§5.1 策略页、§5.2 默认范围没提策略。

**问题**：当前柜台是 SimVenue 时，SimLocal 的 ACTIVE 部署被过滤掉；页面没有任何“其他柜台还有 N 个 ACTIVE 部署”的提示。§5.2 的默认范围只列了订单/成交/持仓/监控/管理，没有列策略。

**交易员影响**：以为没有策略在跑，实际另一个柜台在报价/持仓；收盘复盘漏掉一个柜台；出事故时找不到“哪个策略在哪个柜台”。

**修改建议**：策略页默认“全部柜台”，按柜台分组；或者默认当前柜台但顶部常驻 `其他柜台: 2 个 ACTIVE / 3 个 INACTIVE`，点击可切换。部署列表必须显示 `柜台 / 账户 / ORS / 环境 / 状态 / 最后心跳`，不能只显示策略名。

---

### P1-06 API 合同不完整：缺幂等键、offset/TIF、分页，且与现有 `/orders/page` 不一致

**设计稿位置**：§7.2、§7.3。

**问题**：
- §7.3 的 JSON 只有 `counterpartyId/accountId/orsId/instrumentId/side/price/qty`，缺 `offset/timeInForce/orderType/reduceOnly`，也没有 `clientRequestId` 幂等键；§11 却要求日志带 `clientOrderId/requestId`。
- §7.2 写 `GET /api/v1/orders?counterpartyId=...`，现状是 `/api/v1/orders/page?page=&size=&status=&accountId=`；`/trades/page` 没有 account/counterparty 参数。
- `PageScope.counterpartyId?` 是可选的，空值语义没有定义：是“全部”还是“当前”？这会给“全部柜台只读”留下绕过口子。

**交易员影响**：双击/超时重试可能重复下单；切换柜台后旧请求重放，落到新柜台；分页/筛选行为不一致，页面显示不全。

**修改建议**：统一下单合同：`contextId / clientRequestId / previewId / offset / timeInForce / orderType / reduceOnly`；服务端按 `clientRequestId` 幂等；`PageScope` 改成显式 `scope: CURRENT | ALL | LIST`，空值拒绝；`orders/trades/positions` 都支持 `counterpartyId/accountId`，并更新现有分页接口而不是再开一套。

---

### P1-07 §9 的“同一策略不能多 ORS”与“跨柜台两条腿”自相矛盾

**设计稿位置**：§6.1 `strategy_deployment.target_ors_id`、§9 策略与多柜台、§13 验收“跨柜台策略必须显式配置”。

**问题**：§9 同时写“同一策略不能同时部署到多个 ORS”和“跨柜台套利必须显式配置两条腿”。如果同一策略不能多 ORS，两条腿如何归属同一策略？§6.1 只有一个 `target_ors_id` / `account_id`，无法表达 leg A/leg B。现状唯一索引是 `(strategy_id, account_id)`，又允许同一策略部署到多个账户，和文档不一致。

**交易员影响**：跨柜台套利（例如 SimVenue 的期权腿 + SimNow 的期货对冲腿）无法建模；只能建两个策略，组合保证金/Greeks/对账无法合并，风险看不全。

**修改建议**：v1 明确“单腿策略，跨柜台暂不支持”，删除 §9 的跨柜台条目，避免实现者猜；如果 v1 要支持，增加 `strategy_leg(leg_id, strategy_id, counterparty_id, account_id, ors_id, ratio, role)`，部署摘要显示两腿，风险/对账按 leg 汇总。二者选一，不能同时写在文档里。

---

### P1-08 ORS 生命周期只有 RUNNING/STOPPED/OFFLINE，无法表达 CTP 登录/结算确认/可交易

**设计稿位置**：§4.2、§6.1 `ors_instance.status`、§2.2。

**问题**：真实 CTP 登录后有“结算确认”环节；`RUNNING` 不等于 `TRADABLE`。设计稿没有 `STARTING / LOGIN_FAILED / SETTLING / SETTLEMENT_CONFIRMED / TRADING_READY / HALTED` 等状态；也没有 `lastHeartbeat` 的 freshness 规则。§2.2 只写了“1 ORS = 1 Runtime Agent”，没有写文档 14 的“1 Runtime Agent 最多托管 1 个 ACTIVE ORS”；两者需要合并成一条完整约束。

**交易员影响**：看到绿色 RUNNING，下单被 CTP 拒绝“未结算确认”；早盘登录失败但页面显示正常；ORS 反复重启被当成正常。

**修改建议**：补状态机：`STARTING → LOGIN → SETTLING → TRADING_READY`，异常分支 `LOGIN_FAILED / SETTLEMENT_REQUIRED / HALTED`；顶栏显示 `ORS: TRADING_READY` 而不是笼统 `RUNNING`；`lastHeartbeat` 超时降级；接真实 CTP 前把这条列为 P0。

---

### P1-09 `calendar_mode` 只写在表里，没有定义 SimVenue 7×24 与 CTP 日历的执行差异

**设计稿位置**：§6.1 `counterparty.calendar_mode REAL / ALWAYS_ON`、§4.3 `calendar`。

**问题**：设计稿有字段，但没有说谁读它、怎么影响下单、怎么显示。现状 `TradingController` 用全局 `TradingCalendarService`，并用 `isSimulatedVenue(request.exchange())` 字符串判断跳过日历；`SimVenue` 的 `exchange` 如果传成 ORS id 或 `SIM`，判断就会错。

**交易员影响**：周末在 SimVenue 下单被“非交易日”拒绝；或者 CTP 柜台在非交易时段被错误放行；夜盘归属下一交易日的显示不统一。

**修改建议**：日历按 `counterparty.calendar_mode` 解析；`SIM/ALWAYS_ON` 跳过真实交易日/时段，`CTP/REAL` 强制执行；顶栏显示 `交易日 + 时段`（夜盘归属下一交易日）；服务端按 `contextId` 取日历，不用 `exchange` 字符串猜。

---

### P1-10 “1 柜台 = 1 账户 = 1 ORS”只写在文档，没有数据库约束、迁移和历史生命周期

**设计稿位置**：§2.2、§6.1 `account.counterparty_id UNIQUE (v1)`、`ors_instance.account_id UNIQUE (v1)`、§13 “不变量可验证”。

**问题**：
- 现状 `accounts.venue_id` 没有唯一索引；`Accounts.tsx` 允许管理员直接改账户的 `venue_id`，运行中的 ORS 不会感知；`ors_instances.account_id` 有唯一索引，导致同一账户换 ORS/重启不能保留历史，fencing token 历史也丢失。
- 设计稿 §6.1 写 `UNIQUE (v1)`，但 §12 迁移步骤没有加约束、没有处理历史重复、没有提供不变量检查 API。§13 的“可验证”没有对应测试。

**交易员影响**：管理员改一下账户柜台，旧 ORS 还在跑，新 ORS 又起来，两个进程同时交易同一账户；或者旧 ORS 的历史订单查不到，复盘/对账断链。

**修改建议**：加 `account.counterparty_id` 唯一约束（如果 v1 坚持 1:1）+ `ors_instance` 的 `retired_at` / `generation`，唯一索引改为 `(account_id, generation)` 或 `WHERE status='RUNNING'` 的部分唯一索引；账户改柜台必须 drain → cancel → reconcile → 释放 ORS；启动时跑 `invariants` 检查并在 UI 显示。

---

### P1-11 审计只写了“切换柜台、部署、紧急操作”，缺权限拒绝、订单上下文、切换前后值

**设计稿位置**：§11。

**问题**：§11 说“切换柜台、部署策略、紧急操作记审计”，但没有定义字段；§5.1/§7.3 要求订单日志带 `counterpartyId/accountId/orsId/clientOrderId/requestId`，但审计表现状只有 `actor/action/target/payload_json`，payload 可截断。切换柜台本身是高频 UI 动作，全记会淹没真正的事件；权限拒绝、对账失败、路由 fallback、旧回报丢弃反而没记。

**交易员影响**：事后查不到“谁在 09:31 把订单下到了哪个柜台”；查不到“为什么我的权限没了”；审计被切换噪音淹没。

**修改建议**：定义结构化审计事件：`CONTEXT_SWITCH(oldContextId,newContextId,contextVersion)`、`ORDER_SUBMIT(contextId,accountId,orsId,clientOrderId,requestId,previewId,source)`、`ORDER_REJECT(reasonCode)`、`DENIED_TRADE`、`RECON_BLOCK`、`STALE_UPDATE`、`EMERGENCY(scope,counterpartyIds,receipts)`；审计页支持按 `counterpartyId/accountId` 过滤；切换柜台可按会话聚合，不必每次鼠标移动都写一条。

---

### P1-12 持仓默认“当前柜台”不符合风险直觉，建议持仓/监控默认全部柜台

**设计稿位置**：§5.2 默认“订单/成交/持仓：当前柜台；监控/柜台总览：全部柜台”。

**问题**：订单/成交是“操作流水”，默认当前柜台合理；持仓是“风险敞口”，默认当前柜台会让交易员漏看其他柜台的净头寸、保证金、Greeks。设计稿没有“其他柜台持仓汇总”常驻条。

**交易员影响**：在 SimVenue 看持仓，以为总敞口很小；实际 SimNow 还有一大笔对冲腿，组合 Delta/Gamma 失真；保证金占用也可能被低估。

**修改建议**：持仓页默认“全部柜台”，按柜台分组并给出合计；或者默认当前柜台，但顶部常驻 `其他柜台: 持仓名义 X / 保证金 Y / Delta Z`，可一键展开。监控/驾驶舱始终显示全部柜台风险，并标明“当前执行柜台”与“查看范围”的区别。

---

### P1-13 账户余额/可用/保证金仍可手工编辑，真实 CTP 下会破坏对账和风控

**设计稿位置**：§6.1 `account.balance / available / margin`、§10 对账。

**问题**：设计稿没有说明这些字段的来源、更新时间和权威性。现状 `Accounts.tsx` 允许直接编辑余额/可用/保证金；真实 CTP 下这些值应由柜台资金查询/结算单驱动，手工编辑会让风控和 UI 全部失真。

**交易员影响**：可用资金显示错误，导致超限下单或误判强平距离；对账永远对不上。

**修改建议**：真实账户的资金字段只读，来自 `AccountSnapshot`，带 `asOf / source / stale`；模拟账户可编辑但标注 `FIXTURE`；手工调整必须走“资金调整”审计流程，不能直接改表。

---

## 6. P2（体验与打磨）

| ID | 问题 | 交易员影响 | 具体修改建议 |
|---|---|---|---|
| P2-01 | 术语仍混用：§2.1/§4.2 把“柜台/交易所/通道”当同义词 | 交易员无法判断当前是“接入前置”还是“市场”，也不知道切换会改变什么 | 文档开头加术语表：`柜台=接入通道（SimNow/SimShengli/SimLocal/SimVenue）`、`交易所=SHFE/DCE/CZCE/CFFEX`、`账户=BrokerID+InvestorID`、`ORS=执行实例`、`上下文=当前执行组合`；§14.1 由设计给推荐答案 |
| P2-02 | 下拉不可用项用 `MenuItem disabled`，MUI 不会触发 hover，§4.2 “置灰并显示原因”实现不了 | 交易员只看到灰色项，不知道为什么不能选 | 改用可聚焦的 `ListItem` + 右侧原因文本；不可用项仍可展开看 `lastHeartbeat / error / 原因` |
| P2-03 | §5.2 的 `[SimNow] [SimVenue]` 与顶部选择器重复，同一屏出现两个“SimVenue” | 一个改执行上下文，一个改页面范围，容易误点 | 改成 `当前柜台 / 全部柜台（只读） / 自定义多选`；具体柜台用多选下拉，不用并列 chip |
| P2-04 | `PageScope.exchange` 在 v1 是冗余字段：柜台 1:1 交易所时重复，柜台多交易所时又不够 | 筛选条件与执行上下文重叠，交易员不知道该用哪个 | 先删除；等 P0-01 的四层模型定稿后，再决定 `exchange` 是筛选维度还是上下文属性 |
| P2-05 | §4.3 “原子更新”措辞过强：`calendar / riskLimits / reconciliationScope` 不是前端能原子更新的对象 | 实现者可能以为前端本地切状态即可，服务端并没有切换 | 改为“切换提交后，服务端返回新的 `contextVersion`；前端以该版本重新拉取所有依赖数据，旧版本请求作废” |
| P2-06 | `reconciliationScope` 不应是前端上下文字段 | 切换柜台被误认为改变对账范围，实际对账任务没变 | 从 `CounterpartyContext` 删除，换成只读的 `reconStatus / lastReconAt`；对账范围由服务端任务定义 |
| P2-07 | §2.2 只写了“1 ORS = 1 Runtime Agent”，没有写文档 14 的“1 Agent 最多 1 个 ACTIVE ORS” | 部署/运维对“一个 Agent 能托管几个 ORS”理解不一致 | 统一为“1 个 ACTIVE ORS 必须绑定 1 个 Agent；1 个 Agent 最多托管 1 个 ACTIVE ORS” |
| P2-08 | 偏好迁移与命名：`qf_venue` 存的是 `orsId`，`preferredOrsId` 也是 ORS 级 | 改成 `preferredContextId` 后老用户默认柜台丢失，回到第一个可用柜台 | 写迁移说明和一次性映射；找不到时显示“请选择”，不要自动 fallback |
| P2-09 | §4.1 顶栏密度过高：登录、当前柜台、系统连接、只减仓、紧急操作全在一行 | 1440 下挤掉行情条；状态 chip 太多，真正异常不突出 | 把“系统连接/行情龄/对账”收进当前柜台的 popover；顶栏只保留环境、当前柜台、关键 KPI 三个主项 |
| P2-10 | §14 的问题没有推荐答案（默认范围、草稿清空/保留等） | 评审成本转嫁给交易员，且不同人会给相反答案 | 每个问题给“推荐值 + 理由 + 备选”，交易员只做确认/否决；尤其 §14.4 和 §14.6 |

---

## 7. 交易员必须确认的问题

以下问题不是“实现细节”，会直接改变页面默认值、权限和应急流程，必须由交易员给出明确选择。设计稿 §14 已有 7 个问题，这里补充/收敛为 9 个：

1. **真实 CTP 的“柜台”是否允许一个柜台接多个交易所？** 请确认 SimNow / SimShengli 实际要接 SHFE、DCE、CZCE、CFFEX 中的哪几个。若一个柜台多交易所，是否接受 P0-01 的四层模型（柜台 / 交易所 / 账户 / 上下文）？如果不接受，请明确“一个柜台只做一个交易所”的运维前提。
2. **同一柜台下是否需要多个交易账户？** 如果一个 SimNow 前置下有多个资金账户，顶部“当前柜台”是否必须变成“当前柜台 + 账户”两级选择？还是接受“一个账户一个柜台/一个 ORS”的部署约定？
3. **手工单是否允许临时选择非当前柜台/非当前账户？** 建议不允许：必须先切顶部上下文，切后重新预检。请确认这是否符合盘中习惯。
4. **“全撤 / 停全部 / 只减仓”的默认范围是什么？** 建议默认“当前柜台”，全柜台必须显式选择并二次确认。请确认“停全部”是否应该平仓，还是只撤单/停策略；平仓是交易员手动做的事，不应由“停全部”默认执行。
5. **订单/成交/持仓的默认范围？** 建议订单/成交默认当前柜台，持仓默认全部柜台（按柜台分组）；监控/驾驶舱始终全部柜台。请确认持仓是否接受“全部柜台默认”。
6. **同一策略是否允许跨两个柜台做套利？** 若 v1 不做，请确认删除 §9 的跨柜台条目；若要做，是否接受 `strategy_leg` 两条腿、分别绑定柜台/账户/ORS，并在部署摘要显示两腿？
7. **同一合约在多个柜台有行情时，默认显示哪个？** 建议只显示当前柜台，其他柜台只在监控页；当前柜台无行情时禁止下单，不自动 fallback。请确认是否需要在同一屏对比两个柜台的同一合约。
8. **交易员是否需要“同柜台 VIEWER、另一柜台 TRADER”的混合权限？** 建议支持，权限按账户授予；请确认管理员是否也应该默认没有交易权（四眼原则）。
9. **真实 CTP 结算确认前是否允许下单？** 建议不允许；`RUNNING` 但未 `SETTLEMENT_CONFIRMED` 时显示“不可交易”。请确认早盘/夜盘的结算确认由谁做、超时怎么告警。

---

## 8. 上线前最小改造顺序（建议）

| 顺序 | 改造 | 完成标志 | 对应问题 |
|---|---|---|---|
| 1 | 冻结术语与模型：Counterparty / Exchange / Account / ORS / ExecutionContext | 设计稿第 2/3/6 章重写；评审通过；一张图能说清 SimNow 多交易所 | P0-01 |
| 2 | 后端 `ExecutionContext` + contextVersion + 全接口过滤 | `/execution/contexts` 返回全状态；订单/成交/持仓/策略默认按 context 过滤；无权限 403 | P0-02、P0-06、P0-09 |
| 3 | 行情按 `(counterpartyId, instrumentId)` 建键 | 同合约两柜台不串价；无行情时下单被拒；删除 fixed seed | P0-03 |
| 4 | 路由 fail-closed + 回报 fencing/generation | 停 ORS 下单返回 `NO_ACTIVE_ROUTE`；旧回报被丢弃并告警 | P0-04 |
| 5 | 订单入口统一 contextVersion + previewId + 开平/TIF | 切柜台后旧预检/确认框失效；确认框显示开平/TIF/名义/保证金 | P0-05、P0-10 |
| 6 | 应急范围 + 对账 gate + 环境隔离 | 当前柜台全撤不影响其他柜台；单柜台对账失败只阻塞该柜台；SIM→LIVE 二次确认 | P0-07、P0-08、P0-11 |
| 7 | 最后才改 UI 文案与导航 | 6 个页面切换 e2e 通过；用户不再反馈“切换后页面没变化” | P0-09 |

**建议的最小验收用例（与设计稿 §13 合并）**：

- `TC-MC-01`：切到 SIMVENUE，订单/成交/持仓/策略/手工单/期权链 6 个页面同时变化；任一不变即失败。
- `TC-MC-02`：同一 `au2612` 在 SIMVENUE 与 SIMNOW 价格不同；切柜台后 ticker、期权链、预检、价格校验全部使用各自价格。
- `TC-MC-03`：停掉 SIMVENUE ORS 后下单；返回 `NO_ACTIVE_ROUTE`，不插订单、不发 Aeron，页面不自动切到 SimLocal。
- `TC-MC-04`：在 SIMVENUE 预检后切到 SimLocal；提交被 409 `CONTEXT_CHANGED` 拒绝，确认框关闭。
- `TC-MC-05`：全部柜台视图；下单/撤单/改单/平仓按钮全部禁用，只能“切换至该柜台”。
- `TC-MC-06`：VIEWER / TRADER / ADMIN 权限矩阵；越权请求 403 且有审计。
- `TC-MC-07`：只让 SIMVENUE 对账失败；只有 SIMVENUE 开仓被阻塞，其他柜台正常。
- `TC-MC-08`：两个柜台各有挂单；当前柜台全撤只影响当前柜台；“全部”需要二次确认并显示逐柜台回执。

---

## 9. 附录：本次评审引用的现状证据

以下是“设计稿之外的现状”，用来证明上述风险不是假设；评审只读代码，没有修改。

1. `web/src/hooks/useVenues.ts`：`id: String(row.ors_id)`、`name: account_id · venue_name`；`preferredOrsId` 不可用时自动选第一个 `enabled` 上下文。
2. `web/src/components/AppShell.tsx`：侧栏单独显示“账户”；顶栏环境/连接状态来自全局 `/system/status`；“全撤”固定调用 `scope: 'ALL'`。
3. `web/src/pages/ManualOrder.tsx`：仍有“账户”下拉；`body.exchange = venueInfo?.venueId ?? venue`；预检后改价/改柜台不会强制失效 preview。
4. `web/src/pages/OptionChain.tsx`：请求体 `exchange: venue`，而 `venue` 实际是 `ors_id`；`currentPreviewKey` 不包含柜台/账户。
5. `backend/control-plane/.../TradingController.java`：`ManualOrderRequest` 没有 `counterpartyId/orsId/clientRequestId`；`validateOrder` 只按 `instrumentId` 取全局行情，不校验 `account.venue_id == exchange`。
6. `backend/control-plane/.../aeron/ManualOrderPublisher.java`：`routeInfo()` 找不到 RUNNING route 或异常时返回 legacy `AeronStreams.CHANNEL` / `ORDER_REQUEST`，存在静默回退。
7. `backend/control-plane/src/main/resources/mapper/ExecutionMapper.xml`：`listContexts` 带 `WHERE o.status = 'RUNNING'`，STOPPED/OFFLINE 柜台不会出现在下拉。
8. `backend/control-plane/.../market/MarketDataService.java`：`latest` 是 `Map<String, Tick>`，只按 `instrumentId`；`seedFixedTicks` 写入固定价；`toJson` 不含 `counterpartyId`。
9. `backend/control-plane/.../api/SystemStatusController.java`：`orsRunning` / `agentOnline` 用 `anyMatch`，任意 ORS/Agent 在线即顶栏可用。
10. `backend/control-plane/.../api/EmergencyController.java`：`cancelAll` 只有 `ALL/account/instrument` 范围，没有 `counterparty`；`stopAll` 会全策略 pause + cancel-all + flatten。
11. `backend/control-plane/.../config/SecurityConfig.java`：只有全局角色，没有账户级权限；GET 任意账户对 VIEWER 可见。
12. `backend/control-plane/.../api/VenueReconciliationController.java`：只返回硬编码 `simLocal` / `simVenue`，没有通用柜台对账模型。
13. `web/src/pages/Accounts.tsx`：允许直接编辑账户 `venue_id`、余额、可用、保证金；没有 drain/对账约束。

---

*本评审只针对设计稿，不修改源代码，不实现功能。建议修改后按第 8 节顺序重新评审，重点验证 P0-01 ~ P0-11 的证据链是否闭合。*

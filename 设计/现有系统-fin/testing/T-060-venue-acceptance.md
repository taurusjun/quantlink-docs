# T-060 统一交易场所接入验收矩阵

- 状态：**EXECUTING — 2026-11-13 核心 P0 已跑，矩阵仍有 PARTIAL/NOT_RUN**
- 日期：2026-11-12
- 关联计划：`docs/tasks/T-060-venue-integration-migration.md`
- 设计依据：ADR-004 / `docs/architecture/venue-contract.md`
- 环境：
  - `SIMNOW / TEST-001 / ors-simnow-test-001`
  - `SIMSHENGLI / TEST-SHENGLI / ors-shengli-test-shengli`
  - `SIMVENUE / SIMVENUE-001 / ors-simvenue-001`
  - shadow DB：`quantlink_fin_shadow`（只读核对；写操作必须显式确认）

> 每个 Case 必须记录：环境、commit、命令、结果、证据路径。
> P0 失败 -> 阶段不通过；P1 失败 -> 记录豁免/修复计划，不能静默跳过。
> 真实 CTP 回调用例必须标注 `needs_market`，mock 不能代替最终验收。

## 0. 证据规则

```text
docs/evidence/T-060/<runId>/<caseId>/
  result.json
  stdout.log
  sql/
  artifacts/
  metrics.csv
  screenshots/ 或 trace.zip
```

没有证据不算通过。负向断言必须有正控。

## 1. A0 身份与 SBE

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| V-A0-01 | P0 | integration | 对比 `venue_configs`、`accounts`、`ors_instances` | 三张表 venueId 一致；无孤儿账户/ORS |
| V-A0-02 | P0 | static | 检查 SimVenue env 与启动参数 | `venueId=SIMVENUE`、`accountId=SIMVENUE-001`，不再用 `SIMVENUE-001` 作 venueId |
| V-A0-03 | P0 | static | 解析 `abi/sbe/quantlink-fin-sbe.xml` | message id 28/29 唯一；字段 30-39 无重复；现有 id 不变 |
| V-A0-04 | P0 | unit | 编码/解码 `MarketDataV2` 全字段 | 固定字段在 Bids/Asks group 之前；字段值字节级回读一致 |
| V-A0-05 | P0 | unit | `VenueSession.lastSeqByStream` 两行 group | group 数量/streamId/lastSeq 回读一致；state 枚举可解码 |
| V-A0-06 | P0 | unit | `OrderUpdateV2` 写入 `exchangeOrderId="123456"` | 回读为 `123456`，不得等于 instrumentId |
| V-A0-07 | P0 | unit | 对 CTP/SimVenue/Replay 各生成固定 golden | 三次生成字节一致；Java/C++ 双向解码一致 |
| V-A0-08 | P0 | unit | `MarketDataV2` 缺 venueId/sourceSessionId/seq | 编码端拒绝或消费端 fail-closed，不落默认值 |
| V-A0-09 | P0 | static | 扫描生成代码与 schema | `MarketDataV2` 使用 id=29；旧 `MarketData` id=2 保留 |
| V-A0-10 | P1 | integration | 旧 consumer 收到 id=29 | 明确拒绝/跳过并告警，不误解为旧 MarketData |
| V-A0-11 | P0 | SQL | 查询 `ors_instances` 当前 inventory | 与 T-060 §2.2 完全一致；差异必须解释 |
| V-A0-12 | P0 | SQL | 增加 `position_channel/position_stream` 迁移脚本 dry-run | 可重复执行；默认值不改变旧行语义 |

退出：V-A0-01..09、11、12 全绿；10 记录兼容策略。

## 2. A1 Conformance Harness

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| V-A1-01 | P0 | integration | fake adapter 依次发 MD/Order/Trade/Account/Position/Session | 全部 envelope 可编码/解码，无字段丢失 |
| V-A1-02 | P0 | integration | 回放录制的 CTP 帧 | 解码字段与录制元数据一致；不依赖 instrumentId 猜 venue |
| V-01 | P0 | conformance | identity：venueId/account/exchange | 三者一致；错误组合拒绝 |
| V-02 | P0 | conformance | MD 字段完整 | 所有必需字段非默认；group 顺序正确 |
| V-03 | P0 | conformance | seq 1,2,3 / 重复 3 / 跳到 5 | 1,2,3 接受；重复丢弃；gap 告警并 WARMUP |
| V-04 | P0 | conformance | session A -> B，epoch 1 -> 2 | 新 session/epoch 接受；旧 epoch 拒绝 |
| V-05 | P0 | conformance | 同一 clientOrderId 重发 | 只应用一次，不重复下单 |
| V-06 | P0 | conformance | cancel 带旧 fencing/orderEpoch | 拒绝，不发送到 adapter |
| V-07 | P0 | conformance | update/trade 全字段 | venueOrderId/tradeId/route/deployment/environment 正确 |
| V-08 | P0 | conformance | account/position today/yesterday | 多空、今昨仓、均价、结算价正确 |
| V-09 | P0 | conformance | snapshot asOf 超 staleAfterMs | 标记 stale；策略 gate 不视作 OK |
| V-10 | P0 | conformance | 未知 venue/capability | fail-closed，不默认 CTP/SIMVENUE |
| V-11 | P0 | conformance | 同一 channel/stream 注入两个 venue | 按 venueId 分桶，不交叉归因 |
| V-12 | P0 | conformance | replay 五个上下文字段 | 回读一致；旧 replay session 丢弃 |

退出：V-A1-01/02 与 V-01..12 全绿；负向 case 有正控。

## 3. A2 Descriptor / Registry

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| V-A2-01 | P0 | integration | 加载三个 venue descriptor | SIMNOW/SIMSHENGLI/SIMVENUE 均可用，能力正确 |
| V-A2-02 | P0 | integration | descriptor 默认 stream 与 ORS 不同 | ORS 显式值生效；不静默用默认 |
| V-A2-03 | P0 | integration | 两个 ORS 配同一 `(channel,stream,writerRole)` | 启动失败，错误含冲突键 |
| V-A2-04 | P0 | integration | account.venue_id != request.venueId | 拒绝 |
| V-A2-05 | P0 | integration | 未知 venue / 未声明 capability | 拒绝；不按 venueType 兜底 |
| V-A2-06 | P0 | SQL | 两个 CTP position 都配 2006 | 诊断查询报冲突；拆分后 2006/2007 通过 |
| V-A2-07 | P0 | integration | ORS 行与 adapter 启动参数不一致 | adapter 拒绝启动并告警 |
| V-A2-08 | P1 | integration | descriptor 声明 REPLAY | `venue_type`/normalizeType 接受；旧仅 SIM/CTP 的校验不再拒绝 |

退出：V-A2-01..07 全绿；08 完成。

## 4. B Stream / ORS 迁移

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| V-B-01 | P0 | SQL | 读取三个 active ORS 行 | 与 T-060 §2.2 一致 |
| V-B-02 | P0 | static | `rg '1001|2100|3140'` 生产代码 | 无按 venueType/字面量的路由分支；配置除外 |
| V-B-03 | P0 | integration | 双订阅 SimNow position 2006/2007 | 无丢包；切换后只读新 stream |
| V-B-04 | P0 | integration | 两 CTP 同时启动 | position/order/update/trade 不交叉 |
| V-B-05 | P0 | integration | 订阅 SimNow 1100、Shengli 1110、SimVenue 1001 | 每个 venue 只收到自己的 MD；venueId 正确 |
| V-B-06 | P0 | integration | 向 replay 发布目标注入 2102 | 被拒绝；只允许 9001-9999 |
| V-B-07 | P0 | ops | 回滚 position 2007 -> 2006 | 在途订单/回报不丢；旧路径可恢复 |
| V-B-08 | P1 | SQL | 运行唯一性诊断 SQL | 无重复 writer；无 account/venue 不一致 |

退出：V-B-01..07 全绿；08 无告警。

## 5. C1 CTP Adapter

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| V-C1-01 | P0 | static | 检查 CTP channel 配置 | 从 ORS/参数读取，不硬编码 `aeron:ipc`；`IPC_ONLY` 必须显式 |
| V-C1-02 | P0 | integration | 发布连续 tick | sourceSessionId/publicationEpoch/seq 单调；重启后 seq 不倒退 |
| V-C1-03 | P0 | integration | `OnRtnOrder` 带 OrderSysID | exchangeOrderId = OrderSysID，不是 instrumentId |
| V-C1-04 | P0 | integration | `OnErrRtnOrderInsert` 注入 | 订单 REJECTED；reason 有 ErrorID/ErrorMsg |
| V-C1-05 | P0 | integration | 迟到的 OPEN/ACK 在 REJECTED 后到达 | 不覆盖终态 REJECTED |
| V-C1-06 | P0 | integration | cancel 带旧 orderEpoch/fencing | 拒绝；不发给 CTP |
| V-C1-07 | P0 | integration | account/position 回报 | venue/environment/account 正确 |
| V-C1-08 | P0 | e2e | 两 CTP 同时在线 | 订单/成交/持仓按 venue 隔离 |
| V-C1-09 | P1 | unit | `OrderErr` 无 OrderSysID | 允许空；不得回填 instrumentId |
| V-C1-10 | P1 | failure | CTP 断线重连 | 新 session/epoch；旧 session 回报丢弃 |

`V-C1-04/05/08/10` 标记 `needs_market`，最终验收必须真实 SimNow/CTP。

退出：V-C1-01..08 全绿；09/10 有记录。

## 6. C2 SimVenue Adapter

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| V-C2-01 | P0 | integration | SimVenue 发 MD/Order/Trade/Account/Position | 与 CTP 同一 envelope |
| V-C2-02 | P0 | static | env/启动参数 | venueId=SIMVENUE，accountId=SIMVENUE-001 |
| V-C2-03 | P0 | integration | 订阅 ORS 配置 | MD 1001；order/cancel/update/trade 3140-3143 |
| V-C2-04 | P0 | integration | virtual clock/seed 重放 | 同一 seed 结果一致 |
| V-C2-05 | P0 | integration | calendar capability | 非交易日/夜盘行为符合 calendar |
| V-C2-06 | P1 | integration | 修改 venueId 后重启 | 新 venue 路由生效；旧 deployment 不串流 |

退出：V-C2-01..05 全绿。

## 7. C3 Replay Adapter

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| V-C3-01 | P0 | integration | replay 发 MarketDataV2 | engineId/replayEpoch/replaySessionId/recordingId/framePosition 正确 |
| V-C3-02 | P0 | static | 扫描 stream 分配 | replay 只在 9001-9999；不写 1001/1100/1110 |
| V-C3-03 | P0 | integration | 注入旧 replay session | 按 `(engineId,epoch,session)` 丢弃并告警 |
| V-C3-04 | P0 | integration | replay 追平 live | 切回 live 无重复/乱序 |
| V-C3-05 | P1 | ops | 现有 2102/2103 archive-replay 引用 | 确认只读或改 9xxx；文档记录 |

退出：V-C3-01..04 全绿；05 有结论。

## 8. D Venue Ports

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| V-D-01 | P0 | unit | `VenueRegistryPort.require/list` | 未知 venue fail-closed；capability 过滤正确 |
| V-D-02 | P0 | unit | `VenueMarketDataPort.subscribe` | 按 ORS 订阅；取消订阅关闭 |
| V-D-03 | P0 | unit | `VenueExecutionPort.submit/cancel` | 返回 acceptedForPublication；不谎报成交 |
| V-D-04 | P0 | unit | `VenueAccountPort` stale snapshot | stale=true；asOf 正确 |
| V-D-05 | P0 | unit | `VenueHealthPort.session` | 返回 lease/fencing/stream 状态 |
| V-D-06 | P0 | static | C++ adapter | 不实现 Java interface；只实现 wire |
| V-D-07 | P0 | integration | feature flag 关闭 | 回退旧路径；新路径不双写 |
| V-D-08 | P1 | integration | shadow compare 差异 | 告警并阻断切换 |

退出：V-D-01..07 全绿。

## 9. F / E 最终验收

| ID | 级别 | 类型 | 步骤 | 期望 |
|---|---|---|---|---|
| V-F-01 | P0 | conformance | CTP 录制帧全量 | V-01..12 通过 |
| V-F-02 | P0 | conformance | SimVenue 全量 | 同一 suite 通过 |
| V-F-03 | P0 | conformance | Replay 全量 | 同一 suite 通过 |
| V-F-04 | P0 | integration | capability 缺失 | 只按 capability skip，不按 venueType |
| V-E-01 | P0 | static | `rg 'CTP|SIMVENUE'` 交易核心 | 无行为分支/字面量路由 |
| V-E-02 | P0 | static | `rg '1001|2100|3140'` | 无硬编码 stream/venue 分支 |
| V-E-03 | P0 | build | ArchUnit/grep gate | 全绿；旧 controller/reconciler 删除 |
| V-ACC-01 | P0 | e2e | 同一策略代码/配置新建 deployment | 指向新 venue/account/ORS，无需改代码 |
| V-ACC-02 | P0 | e2e | 两 venue 同 stream 注入 | 不交叉归因 |
| V-ACC-03 | P0 | e2e | 两 CTP 同时运行 | position/order/trade 隔离 |
| V-ACC-04 | P0 | e2e | seq gap/旧 session/旧 fencing | 告警/拒绝，不静默继续 |
| V-ACC-05 | P0 | e2e | 新 venueId UI | 不依赖字面量 |
| V-ACC-06 | P0 | ops | rollback 演练 | 按 T-060 §5 阈值触发并恢复 |

退出：V-F/E/ACC 全绿；rollback 记录归档。

## 10. 执行顺序

```text
A0 -> A1 -> A2 -> B -> C1/C2/C3 -> D -> F -> E
```

B 的 position 拆分必须在两个 CTP 同时启动前完成；C1 的真实回调验收可以后置到 `needs_market` 窗口。


## 11. 2026-11-13 执行记录

- 结果与证据：`docs/evidence/T-060/20261113/acceptance.md`
- 核心通过：A0 身份/SBE、V-01..12、VenuePorts、SimVenue 干净重测、stream 冲突 0、SBE interop。
- 未通过/未跑：双 CTP 同时在线、真实 CTP 回放/重连、replay 9001 slot、rollback、UI 新 venue、ACC-01..06。
- 本次修复了 reset 顺序、SimVenue position=2014、accounts.venue_id、SimVenue ORS、trades 唯一键。

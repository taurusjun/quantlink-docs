# ADR-001 定向评审

- 日期：2026-11-12
- 评审对象：`docs/architecture/adr/ADR-001-indicator-replay-contract.md`（commit `e795dfd`）
- 评审范围：仅第六轮 6 个 P0，不重审 27 号文档全文，不重审 POC
- 结论：**APPROVED WITH CHANGES（条件式）**
- 生产状态：**BLOCKED，ADR 尚未 APPROVED**

> 这不是 APPROVED。按 ADR §11 的 gate，第六轮 6 个 P0 没有全部闭合：
> **D3 CLOSED；D1/D2/D4/D5 PARTIAL；D6 OPEN。**
> 当前文本不能直接解除 production BLOCKED。

## 1. 六项逐项判定

| # | 判定 | 证据（ADR 章节） | 理由 |
|---|---|---|---|
| D1 position/cursor | **PARTIAL** | §3 Decision / StreamCut / 跨 recording；POC `AeronArchiveAdapter` 62-68、100-101；`MarketEvent` 30-32；A1 `maxPosition==to`，A2 `samples=23298` | 方向对，但 `fragmentLength` 未定义 frame vs payload。POC 用 `Header.position()`（帧结束）+ payload `length`，`nextPosition` 错位；`lastCut()` 又设 `position=nextPosition=stopPosition`，直接违反 §3；`eventAsOf=0`；`StreamCut.sessionId` 未定义。P0-N1 只闭合了文字，未闭合可实现性。 |
| D2 live barrier | **PARTIAL** | §4 步骤 1-7、禁止项、Buffer、同步屏障 | 顺序正确（先订阅缓冲再捕获 cut），但步骤 6 `> applyCut.nextPosition` 是 position 切片，直接违反同节“不能用 position 直接切片 live buffer”和 §3“跨 recording/live 不能直接比较 position”；未要求 `Image.available()`/`liveStartCut`；未要求校验 replay 真正到达 cut。P0-N2 只闭合了顺序。 |
| D3 tokenEpoch | **CLOSED** | §5 Acquire / Renew / Release / PITR / guard | Renew/Release 同时校验 `token_epoch/fencing_token/status`；PITR 显式 bump；guard 先 tokenEpoch 后 fencingToken；POC `oldLeaseCannotRenewOrPublishAfterEpochBump` PASS。P0-N3 的三个点都有。剩余是 P1 澄清（authority store/bump 值、guard 的 `seq` 不是市场 seq）。 |
| D4 seq 去重 | **PARTIAL** | §6 去重键 / sessionId 语义 / Consequences | 键 `(sessionId, counterpartyId, exchange, instrumentId, seq)` 正确解决了“同 session 两 instrument seq=1”碰撞；`seq` 消息级 per instrument 也对。但 `sessionId` 只写“优先 CTP/adapter publication session”，没有决定生成者、持久化、重启语义；`ReplayEnvelope.sourceSessionId` 未提；无 publisherEpoch fencing。P0-N4 的 scope 闭合，authority 未闭合。 |
| D5 snapshot/warmup | **PARTIAL** | §7 两条路径 / Partial bar / 新指标 / Consequences | 主区间数学正确：snapshot `[nextPosition, applyCut.nextPosition)` exclusive；新指标 `[artifact.startPosition, applyCut.position]` inclusive；watermark 只做 freshness；CUMULATIVE 不允许部分回放。但 `artifact.startPosition` 与 `initialReplayFrom` 是两个未统一的 lower bound；`max(initialReplayFrom, earliestRecording)` 把 event-time 和 recording id 比较；`artifact.startPosition` 无 recordingId；可选“snapshot 只含已收盘 bar”未定义 replay 起点；跨 recording 回放未定义。P0-N5 核心闭合，细节未闭合。 |
| D6 1d barCut | **OPEN** | §8；§7 partial bar；§3 eventAsOf | `barCut` 只有名字没有字段；`applyCut.streamCut.eventAsOf = 最后已收盘交易日` 与 §3/§7 把 eventAsOf 当“最后 tick 事件时间”冲突；§7 说 snapshot 含 partial bar，§8 说盘中不把未完成日 bar 纳入 applyCut。按字面执行会把 cut 放在昨日收盘，live buffer 只从 hot-add 开始，`[昨日收盘, now]` 既不 replay 也不 buffer；或者把当日未完成 bar 写成 OK。P0-N6 未闭合。 |

**合计：1 CLOSED + 4 PARTIAL + 1 OPEN，不足以解除第六轮全部 P0。**

## 2. 自洽性与 POC 证据冲突

- **D1 ↔ D2**：§3 禁止“跨 recording/live 直接比较 position”，§4 又禁止“用 position 直接切片 live buffer”，但 §4 步骤 6 明确写 `> applyCut.nextPosition`。这是 ADR 自身最明显的矛盾。
- **D1 ↔ D4**：`StreamCut` 只有一个全局 `sessionId`，而 D4 的 `sessionId` 是 per-publisher/per-instrument 的。1001 是多柜台/多合约复用流时，一个全局 sessionId 无法表示所有 input；若实现拿 `StreamCut.sessionId` 做去重，会跨合约串值。
- **D1/D5 ↔ D6**：D1 把 `eventAsOf` 放进全局 `StreamCut`，D5 用它算 `initialReplayFrom`；D6 又把同一个字段改成“最后已收盘交易日”。同一个字段不能同时表示 tick 时间和日线 cut。
- **D5 ↔ D6**：D5 说 `snapshot.state` 包含当前 partial bar；D6 说盘中不把未完成日 bar 纳入 applyCut。1d 的 partial bar 到底在不在 state/snapshot 内，没有一致答案。
- **D3 ↔ D4**：D3 的 guard 写 `(tokenEpoch, fencingToken, seq)`；D4 的 `seq` 是 1001 市场消息 seq。两个 seq 同名不同域，消费端可能拿市场 seq 做值 guard。
- **D5 内部**：`max(initialReplayFrom, earliestRecording)` 一边是 event-time，一边是 recording id，类型上不可实现。
- **ADR ↔ POC 证据**：Aeron 1.54 的 `Header.position()` 由 `nextTermOffset` 计算，是**帧结束位置**；`FragmentHandler.length` 是 **payload 长度**。POC 的 `AeronArchiveAdapter` 用 `header.position()` 当 `position`、`length` 当 `fragmentLength`，`MarketEvent.nextPosition = position + length` 必然错位；`lastCut()` 又设 `position=next=stopPosition`，违反 §3。A1 的 `maxPosition==to` 正好佐证 `Header.position()` 是 end。A2 的 `samples=23298` 按该路径很可能少最后一帧（`position < toPositionExclusive` 过滤掉 end==to 的帧），所以 **190 证据只能证明 SBE decode + EMA，不证明 D1 的 cut/position 语义**。

## 3. 新问题（只列会阻止生产的）

### P0

1. **D1 的 position 在真实适配器/190 证据中不成立。** `Header.position()` 是帧结束，`length` 是 payload；`nextPosition` 错位，`lastCut()` 的 `position=next=stop` 不是 D1 的“最后 fragment 起始”。影响：replay 起止点错位、最后一帧重复或丢失、`liveCut` 超出真实流。ADR 只写了公式，没有 Aeron API 映射，也没有要求重跑 190 golden。
2. **D2 步骤 6 的 position 切片自相矛盾。** 与 §3/§4 自身禁令冲突；publisher 重启导致 session 变化/position 归零时，buffer 里的 tick 会被整段丢掉。影响：丢 tick；同 session 下又可能重复。必须改为 per-input seq 去重，position 不能单独使用。
3. **D2 缺 live image 可用性屏障。** `addSubscription` 返回不代表 `Image.available()`；若 image 在 cut 之后才可用，`[cut, liveStart)` 不在 replay 也不在 buffer。影响：丢 tick。必须等 image available，记录 `liveStartPosition`，并断言其 <= `applyCut.position`。
4. **D2/D5 缺 replay 完成校验与 Archive lag 处理。** Archive recording head 可能落后于 applyCut；replay 提前结束，步骤 6 又会把缺失尾段过滤掉。影响：静默丢 tick。必须断言 `lastAppliedPosition == applyCut.position`，且 `applyCut.position <= durableArchiveHead`；否则有界等待或 WARMUP。
5. **D4 的 session/publisher 权威未定，旧 producer 可写。** `sessionId` 可能是 CTP session、Aeron publication session 或 9001 replay session；`ReplayEnvelope.sourceSessionId` 未提。publisher 重启复用 session + seq 归零会把新 tick 当重复丢掉；旧 publisher 仍存活会双写/重复。影响：丢 tick、重复、旧 producer 写入。
6. **D6 的 1d cut 仍会错值/丢 tick。** `barCut` 无结构；`eventAsOf` 重载；partial bar 与 §7 冲突；夜盘归属未定义；applyCut 放到最后收盘会让 `[lastClose, now]` 既无 replay 也无 buffer。影响：1d hot-add 丢 tick，或把当日未完成 bar 写成 OK，或长时间 REPLAYING。

### P1

- **P1-1 D5 lower bound/recording**：`artifact.startPosition` 与 `initialReplayFrom` 未统一；`max(time, recordingId)` 类型错误；裸 position 无 recordingId；跨 recording replay 未定义。
- **P1-2 D5 区间 API**：POC 的 `Archive.replay` 是 upper exclusive，ADR 新指标路径写 upper inclusive；直接套用会漏最后一帧。要么统一半开区间，要么要求 API 支持 inclusive 并加 golden。
- **P1-3 D3 authority/valueSeq**：tokenEpoch 与 lease 行是否同一 PITR 一致存储、bump 取什么值未写死；guard 的 `seq` 与 D4 市场 seq 同名；guard 是否覆盖 outbox/DB 等所有外部写未定义。
- **P1-4 D4 seq gap**：同 epoch 内 `seq != last+1` 没有 gap 政策；`lastInputSeq` 会静默跳过缺失 tick。
- **P1-5 D2/D5 snapshot 原子性与 lease 续约**：周期 snapshot 的状态与 `streamCut` 必须在同一 producer 临界区捕获；replay 可能超过 lease TTL，必须独立线程续约，否则自 fence。
- **P1-6 D6 日线收盘事件/日历**：未定义 15:00 日盘收盘（或夜盘品种收盘）触发 bar close、OK 发布；无此规则，1d 永远不知道何时从 PARTIAL 转 CLOSED。

## 4. 必须修改的具体条目

1. **§3 D1 — 把 position 公式落到 Aeron API**
   - 明确：
     ```text
     frameStart   = header.position() - header.frameLength()
     frameLength  = header.frameLength()   // 含 Aeron frame header + padding
     nextPosition = header.position()      // Aeron 1.54: position() 是帧结束
     ```
   - `fragmentLength` 不得取 `FragmentHandler.length`（payload）。
   - `StreamCut` 不变量：非空 cut `nextPosition > position`；`eventAsOf` 取最后一条已应用消息的 SBE timestamp，禁止 0/墙钟；`sessionId` 定义为 source publication session（见 D4）。
   - 修 `AeronArchiveAdapter.lastCut()`：`position = stopPosition - lastFrameLength`，`nextPosition = stopPosition`，`eventAsOf = lastEventTimestamp`；replay filter 用 `frameStart >= from && nextPosition <= to`，确保 `nextPosition == to` 的最后一帧被消费。
   - 新增 190 golden：`fragments`、最后一帧 included、`frameLength != payloadLength`、`nextPosition == header.position()`；重跑并更新 `samples/ema`。

2. **§4 D2 — barrier 补三个断言**
   - 步骤 0：`await Image.available()`；记录 `liveStartPosition`；`liveStartPosition > applyCut.position` -> WARMUP/REJECT。
   - 步骤 4a：replay 结束断言 `lastAppliedPosition == applyCut.position`，且 `applyCut.position <= durableArchiveHead`；否则有界等待或 WARMUP；跨 recording 逐段 replay。
   - 步骤 6：改为 drain + per-input `(sourceSessionId, counterparty, exchange, instrument, seq)` 去重；position 只在 same source session 且不能单独使用；删除 `> applyCut.nextPosition` 的绝对写法。

3. **§5 D3 — authority 与 seq 域**
   - 写死 tokenEpoch 权威：与 lease 行同一 PITR 一致存储；`bump = max(restoredEpoch, lastIssuedEpoch) + 1`，在 acquire 前持久化；若用 DB 外源，明确它不被 PITR 回滚。
   - guard 的 `seq` 改名 `valueSeq`（per indicator 单调）；市场 seq 只用于 D4 去重。
   - 明确 guard 适用于 ValueKV/outbox/DB 所有外部写；如果 outbox 不在本 ADR，至少写“所有写路径必须带 tokenEpoch/fencingToken 条件”。

4. **§6 D4 — publisher epoch**
   - 定义 `publicationEpoch`：publisher 启动生成、持久化、单调/唯一；1001 携带；`seq` 每 epoch 从 1 开始；publisher 重启必须换 epoch。
   - `ReplayEnvelope` 携带 `sourceSessionId/sourcePublicationEpoch`；去重只用 source，不用 9001 transport session。
   - 控制面登记每个 `(counterparty, exchange, instrument)` 的 current epoch；消费端拒绝非 current；旧 epoch 消息告警/丢弃。
   - seq gap：同 epoch 内 `seq != last+1` 记 gap，超过预算 WARMUP/NO_DATA；不允许静默跳过。

5. **§7 D5 — lower bound/recording/API**
   - 用 `ArtifactReplayStart {recordingId, sourceSessionId, position, eventAsOf}` 替代裸 `artifact.startPosition`。
   - `initialReplayFrom` 是 event-time；`earliestRecording` 必须解析成 `(recordingId, position)`；不要 `max(time, recordingId)`。
   - 跨 recording：按 `(recordingId, from, to)` 逐段 replay，用 seq 校验连续；session/epoch 变化 -> WARMUP。
   - 统一半开区间 `[from, toNext)`；若保留新指标 upper inclusive，必须要求 replay API 支持并加 golden；可选 closed-bar snapshot 要么删除，要么从 `barCut.startPosition` replay。

6. **§8 D6 — BarCut/partial/night**
   - 定义 `BarCut { tradingDay, calendarId, barStartEventAsOf, barEndEventAsOf, cutPosition, cutNextPosition, closedAt, status }`。
   - `streamCut.eventAsOf` 保持“最后 tick 事件时间”；不要把 1d 的最后收盘日塞进去。
   - 1d state = closed daily bars + separate current-day PARTIAL bar；`applyCut` 仍在当前流位置；`barCut` 只标记最后已收盘日；只有 CLOSED 才发 OK。
   - 夜盘 tick 归属下一交易日，不能丢；给出 Friday night -> Monday、holiday eve -> next trading day 的规则；`tradingDay` 用交易所日历。
   - 日盘收盘/夜盘收盘触发 bar close；测试 15:00/02:30/09:30/20:00/21:00。

7. **§2 Decision Summary**：同步修正 D1/D6 的措辞，避免 summary 与 body 不一致（尤其 `eventAsOf` 和 `barCut`）。

## 5. 审核边界

本次只读审查 **ADR-001**，并引用其关联的第六轮评审、POC 结论、POC 代码作为证据；**没有重审 27 号文档全文，也不要求 27 已更新**。27 仍是 **REJECT**；ADR 通过后再由后续变更更新/取代 27。未修改文件、未执行 SQL、未提交代码。POC 代码只作为证据引用，不是对 POC 的完整代码审查。

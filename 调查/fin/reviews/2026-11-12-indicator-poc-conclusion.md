# 指标引擎 POC 结论

- 日期：2026-11-12
- 代码：`backend/indicator-engine`，commit `f73879e`
- 设计参考：`docs/architecture/27-指标目录与Agent内存热加载.md`
- 状态：**POC CLOSED（核心语义 PASS）；27 作为生产实施规范仍未通过；生产 BLOCKED**

## 1. POC 目的

验证四个高风险假设：

```text
1. 同柜台指标只算一份，能否被多个策略共享
2. stateful 指标能否用 snapshot + Archive replay 恢复
3. 热加载能否在 applyCut 处不丢 tick、不重复
4. lease/fencing 能否保证单 writer，旧 engine 不能继续写
```

不是完整生产实现。

## 1.1 POC 与 27 号文档的关系

POC **基于 27 号文档的方向**，但不是 27 的完整实现或验收。

POC 做了这些简化：

```text
logical position    代替真实 Aeron byte position
内存 lease            代替控制面 lease API + DB CAS
LiveFeed             代替真实 Aeron live image/handoff
单 engine / 单指标    代替多策略共享
内存 Archive          代替真实 Archive 读取（仅真实 spike 例外）
无 DB/catalog/outbox/ACK
无 1d / pair / 期权链
```

因此：

```text
POC PASS
  = 核心机制可行
  ≠ 27 号文档已经是生产可实施规范
```

27 号文档仍存在第六轮评审指出的 position/live barrier/tokenEpoch/seq/applyCut/1d 六个 P0。POC 通过不能替代这些协议决策。

## 2. POC 范围

```text
counterparty: SIMNOW
exchange:     SHFE
instrument:   au2612
indicator:    1m EMA(period=3)
engine:       单 writer
archive:      内存 Archive（逻辑 position + fragmentLength）
lease:        内存 CAS lease（tokenEpoch + fencingToken）
snapshot:     内存 EngineSnapshot
```

## 3. 已验证

| # | 场景 | 结果 |
|---|---|---|
| 1 | 热加载只 replay 到 applyCut，不消费未来事件 | PASS |
| 2 | snapshot 后从 `nextPosition` exclusive replay，结果与连续运行一致 | PASS |
| 3 | lease epoch bump 后旧 engine 不能 renew/publish | PASS |
| 4 | 同 session 重复 seq 只计算一次 | PASS |
| 5 | applyCut journal 写入/读取 | PASS |
| 6 | replay 中途异常后从 journal applyCut 继续 | PASS |

测试结果：

```text
tests=6 skipped=0 failures=0 errors=0
BUILD SUCCESSFUL
```

## 4. 验证结论

```text
共享指标计算            可行
snapshot + replay       可行
applyCut 热加载         可行
单 writer fencing       可行
journal 崩溃续跑        可行（异常注入）
```

因此架构方向可以继续，不需要推翻。

## 5. 真实 Archive 回放结果

在 190 上执行 `ArchiveReplaySpike`：

```text
recordingId = 0
sourceStream = 1001
from = 70298624
to = 77944576
replayStream = 9001
fragments = 29867
maxPosition = 77944576
active = false
```

结论：

```text
Archive 1001 可真实重放
replay 到专用 9001，未写回 live 1001
maxPosition 精确到达 recording stop
```

这证明 Archive transport/replay 路径成立。

### A2：真实 Archive -> SBE -> Engine

在 190 上执行 `ArchiveToEngineSpike`：

```text
recordingId = 1021
sourceStream = 1001
sessionId = -306253239
from = 0
to = 33554592
instrument = au2612
samples = 23298
ema = 873.4737274374
```

结论：

```text
1001 fragment 可被 SBE MarketData 解码
MarketEvent 可驱动 EmaState
真实 tick 样本数 23298
```

### A2 原始证据边界与 D1 golden（2026-11-12 补充）

A2 最初只证明 SBE 解码与 EMA 计算，不证明 position/cut 语义。
最初的 `AeronArchiveAdapter` 把 Aeron `Header.position()` 当作 fragment 起点，并把 `FragmentHandler.length`（payload 长度）当作 `fragmentLength`：

```text
Header.position()       = 帧结束位置（Aeron 1.54: termOffset + aligned frame length）
FragmentHandler.length  = payload 长度
```

该实现已修正为：

```text
frameStart = header.position() - header.frameLength()
nextPosition = header.position()
payload length 仅用于 SBE 解码
```

在 190 上重跑真实 recording 1021，golden 结果：

```json
{"recordingId":1021,"sessionId":-306253239,"from":0,"to":33554592,
 "instrument":"au2612","fragments":116509,
 "lastFrameStart":33554319,"lastFrameEnd":33554592,
 "lastFrameLength":273,"lastPayloadLength":241,
 "lastEventTimeMillis":1794317080150,
 "samples":23298,"ema":873.4737274374}
```

校验：

```text
lastFrameStart + lastFrameLength == lastFrameEnd   PASS
lastFrameEnd == toPositionExclusive                PASS
lastFrameLength != lastPayloadLength                PASS (273 vs 241)
```

这证明 Archive replay 的最后一帧被消费，frameStart/frameEnd 与 payload length 已分离。
`lastCut()` 仍使用 descriptor stopPosition 作为范围终点，production 必须按 ADR-001 改为 journal/tail replay。

仍未验证：

```text
真实 streamCut/applyCut 连续性
真实 live 切换/kill -9 续跑
DB/catalog/outbox/ACK
```

这些属于生产实现，不是 POC 退出条件。

## 6. POC 明确不做

```text
完整 indicator SQL schema 落地
现有 Java Mapper/Publisher/Consumer 迁移
shadow 数据库破坏性 reset
管理页面
期权链 / pair / 1d / IV Rank
完整状态机 / 六轮协议评审
```

## 7. 建议

```text
1. 冻结 POC，不再扩展切片
2. 真实 Archive 1001 replay + SBE -> Engine 已完成
3. POC 收口
4. 另开生产阶段：先把 27 的六个 P0 收敛成生产 ADR
5. 再决定 SQL/Java 迁移/UI
```

POC 的交付物是：

```text
结论 + 可丢弃验证代码
```

不是生产 schema 或完整协议实现。

## 8. 当前结论

```text
核心架构假设：PASS
真实 Archive transport/replay：PASS
真实 Archive -> SBE -> 指标 Engine：PASS
D1 最后一帧 golden：PASS
27 作为生产实施规范：REJECT（第六轮）
生产实现：未开始
```

下一步：

```text
POC 收口
-> 把第六轮 6 个 P0 收敛成一页生产 ADR
-> ADR targeted review
-> APPROVED 后才进入生产实现
```

## 9. POC 状态

```text
POC：CLOSED（CORE PASS）
D1 最后一帧 golden：PASS
27 号文档：REJECT（作为生产实施规范）
ADR-001：APPROVED（协议决策）
生产：BLOCKED，等待 27 更新/取代
```

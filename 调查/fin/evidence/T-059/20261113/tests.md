# T-059 测试补跑记录（2026-11-13）

- 代码基线：`6bb6eaa`（V1 清理与 venue 解析提交）
- 结论：**P0 协议/恢复/gate 关键用例通过；审查矩阵仍有大量未实现项，见第 3 节**

## 1. 已执行

| 范围 | 用例 | 结果 |
|---|---|---|
| D6 1d/日历 | `DailyBarTest`：15:00 收盘、夜盘归属、周五->周一 | PASS |
| D6 新增 | 节假日前夜盘 -> 节后首日、15:00 前 partial / 15:00 CLOSED、无 tick 不生成假 bar | PASS |
| R1 Journal | PREPARED/APPLIED/ABORTED、torn tail、CRC fail-closed、checkpoint 不越过 PREPARED、segment roll | PASS |
| R1 新增 | ABORTED 不当作 APPLIED、同 applyId 取最大 offset | PASS |
| P4 gate | REPLAYING/FENCED/LOST/WARMUP/STALE/token/fencing 不匹配全部拒绝；平仓放行 | PASS |
| P2 runtime | register / catalog / delta / ACK / lease / value 发布 | PASS |
| P2 canonical | 同 spec 同 id、period/venue/instrument 变化新 id、canonical bytes 稳定 | PASS |
| P3 snapshot/restore | 1d state、hot add、exclusive gap、kill 后 journal 续跑 | PASS |
| SBE V2 | MarketDataV2/VenueSession/execution/account/position 全字段 | PASS |
| SBE interop | C++ codec、Java->C++、V2 | PASS |

证据：`docs/evidence/T-061/20261113/gradle-tests.log`、`docs/evidence/T-060/20261113/sbe-interop.log`。

## 2. 新增/修改测试

- `DailyBarTest`：+3 用例（holiday / partial-CLOSED / no-data）。
- `SegmentedApplyCutJournalTest`：+2 用例（aborted / same applyId max offset）。
- `VenueResolverTest`：账户绑定、CTP/SIM alias、未知 venue fail-closed。
- `VenueReconciliationRouterTest`：按 venueType/account 选择 reconciler，无 venue 字面量。

## 3. 未完成（不能标记 PASS）

- R5 HWM/PITR、P14 outbox 字节级、P17 codeHash、D2/D4/D5 边界、P11/P13/P15、R4 slot、B13 全量 E2E。
- 真实 Archive 1021 / CTP 录制帧 fixture（T059-TR-02/03）。
- 24h soak：engine 自 2026-11-13 00:56:41 起运行，soak 自 00:56:57，目标 2026-11-14 00:56:57；当前不判定 PASS。


## 4. V1 清理与运行时修复

- 删除 V1 control-plane `IndicatorEngine`/`IndicatorStreamConsumer`/`IndicatorMapper`/`IndicatorHistoryTask`。
- 删除 runner `IndicatorPublisher`/`IndicatorDefMapper`。
- 删除 `schema-shadow.sql` V1 表与 `shadow-seed.sql` V1 seed；scratch reset 通过。
- 策略详情/视图/fork 改读 V2 binding。
- `IndicatorRuntimeMain` 启动/续租失败改为顶层 fail-fast + `System.exit(1)`；control-plane 重启后 engine 自动恢复，值继续更新。

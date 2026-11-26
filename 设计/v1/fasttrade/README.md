# V1

第一版架构文档目录。

当前方案：

- [FastTrade Access -> SimVenue 设计](../superpowers/specs/2026-11-17-fasttrade-access-simvenue-design.md)
- [FastTrade Access -> SimVenue 执行计划](../superpowers/plans/2026-11-17-fasttrade-access-simvenue.md)

总体架构：

- [总体架构](architecture.md)

历史文档（不再作为实现依据）：

- [Access 架构（历史，已 superseded）](access-architecture.md)
- [Access 层实施方案（历史，已 superseded）](access-layer-plan.md)

当前边界：

```text
SIM:  AccessSDK <-> SimVenue
LIVE: AccessSDK <-> CTP adapter（venue-contract）<-> CTP
```

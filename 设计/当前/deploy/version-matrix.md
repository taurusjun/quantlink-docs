# Version Matrix

| contract | simvenue | fasttrade | fin | status |
|---|---|---|---|---|
| 0.1.0 | pending | pending | pending | contract 0.1.0 accepted on 190 |
| 0.1.1 | pending | pending | pending | contract 0.1.1 accepted on 190 |
| 0.1.2 | pending | pending | pending | contract 0.1.2 accepted on 190 |
| 0.1.3 | pending | pending | pending | contract 0.1.3 accepted on 190 |
| 0.1.4 | pending | pending | pending | contract 0.1.4 accepted on 190 |
| 0.1.5 | pending | pending | pending | contract 0.1.5 accepted on 190 |
| 0.1.6 | pending | pending | pending | contract 0.1.6 accepted on 190 |
| 0.1.7 | 0.2.2 | 0.1.2 | pending | contract 0.1.7 + simvenue 0.2.2 (VenueCommit + rolling reconstructable logs) + fasttrade 0.1.2 order-fill baseline accepted on 190 |
| 0.1.7 | 0.2.3 | 0.1.3 | pending | FastTrade audit hardening (session scope, late fills, cancel, restart baseline) + SimVenue nanosecond timestamps; one-order E2E accepted on 190 |
| 0.1.8 | 0.2.4 | 0.1.4 | pending | deploy.sh E2E accepted on root@101.43.54.190 at 2026-11-18T11:48:41Z |

规则：

- 每个发布记录固定 contract 版本。
- simvenue / fasttrade 升级 contract 必须一起跑跨仓库 E2E。
- 生产不使用 `SNAPSHOT` 或 `LATEST`。
| 0.1.8 | 0.2.5 | 0.1.5 | pending | deploy.sh E2E accepted on root@101.43.54.190 at 2026-11-18T12:23:28Z |

# 双 CTP 日盘验收（2026-11-13）

## 环境

- SimNow `TEST-001` / `ors-simnow-test-001` RUNNING，LOGGED_IN
- SimShengli `TEST-SHENGLI` / `ors-shengli-test-shengli` RUNNING，LOGGED_IN
- 独立快照流：SimNow account/order/trade=2007/2008/2009；Shengli=2015/2016/2017
- position：SimNow=2006，Shengli=2013

## 结果

- SimNow 900000001001：`OPEN`，venue/counterparty=`SIMNOW`，exchange=`SHFE`，无串柜台。
- SimShengli 900000001002：订单请求已发布；因当时 `books` 缺少 TEST-SHENGLI MANUAL 行，DB 未落库（已修复 books）。
- SimShengli 900000001003：CLOSE 订单落库，venue=`SIMSHENGLI`，状态 `CANCELED`（CTP 未成交，未串柜台）。
- 仓位：TEST-001 long=4；TEST-SHENGLI short=3；SIMVENUE long=6，三者按账户隔离。
- 账户/订单/成交快照：两个 CTP 均有独立 state，时间在 2s 内。
- `CtpVenueReconciler` 已加入 trade baseline（73485），SimNow 开仓对账通过。
- SimShengli 行情 tick 在 CTP MD 重启后仍停留 10:44，行情 stale；CLOSE 不受 stale 限制，但 CTP 仍 CANCELED。

## 结论

**订单/快照/仓位隔离已验证；成交隔离未完成**。SimShengli MD tick 与 CTP 订单成交是剩余阻塞。

## 备注

- `books` 已补 TEST-SHENGLI MANUAL/UNASSIGNED；`shadow-seed` 在 t046 之前运行，后续 reset 会自动生成。
- `web.bak-*` 7 个旧目录已删除，只保留当前 `/opt/quantlink-fin/web`。

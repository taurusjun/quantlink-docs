# Night-session trade-day reconciliation

Before: reconciler compared `calendar.tradingDayForNow()` with CTP snapshot day.
At night CTP trades carry `20261113`, local rows may be `20261112`, so gate failed.

Fix: `CtpSnapshotMapper.latestTradingDay(account)` is now authoritative.
If the local set for CTP day is empty, reconciler checks the previous calendar day
(night session order creation day). CTP trade count/qty must still match.

Result: manual-order preview no longer reports `CTP trades day=20261113 local=0/ctp=1`.

# P3 live seam + journal + ACK READY

- `MarketDataFeed` seam added; `IndicatorRuntime.start(feed)` subscribes and routes to engine.
- `ApplyCutSink` added; `FileApplyCutJournal` and `SegmentedApplyCutJournal` both implement it.
- `IndicatorEngine.addIndicator(..., ApplyCutSink)` accepts either journal.
- `IndicatorRuntime` ACKs APPLIED after catalog delta, then ACK READY after the first live event has a value.
- `IndicatorRuntimeTest` fake HTTP + fake feed verifies register/lease/catalog/delta/APPLIED/READY/ValueKV.

Still not wired: real Aeron live image and Archive replay orchestration.

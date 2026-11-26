# P3 live/replay wiring

- `SbeMarketEventDecoder` handles both legacy `MarketData` (id=2) and `MarketDataV2` (id=29).
- `AeronMarketDataFeed` polls a live Aeron subscription and maps frames to `MarketEvent`.
- `IndicatorRuntime.start()` now:
  1. register + lease
  2. seed liveCut from `archive.lastCut()`
  3. replay each catalog spec through `IndicatorEngine.addIndicator`
  4. ACK APPLIED, then ACK READY after the first live value
  5. subscribe the live feed
- `ApplyCutSink` allows `SegmentedApplyCutJournal` to be used in place of the POC text journal.

Tests:
- `SbeMarketEventDecoderTest` PASS (V2 counterparty/seq/frame fields)
- `IndicatorRuntimeTest` PASS (fake HTTP + fake live feed + APPLIED/READY)

# T-002 SBE 协议与领域模型 — 验证证据

- 日期：2026-11-06
- 状态：PASS
- 任务：T-002

## 1. 生成

```bash
bash tools/gen_sbe.sh
```

- Java: `backend/shared/sbe/src/main/java/com/quantlink/fin/sbe/`
- C++: `ctp-adapter/include/generated/quantlink_fin_sbe/`
- Schema: `abi/sbe/quantlink-fin-sbe.xml`

## 2. 测试

```bash
bash tools/run_sbe_interop.sh
```

结果：

```
BUILD SUCCESSFUL
C++ SBE codec OK
Java -> C++ SBE interop OK
SBE interop OK
```

## 3. 覆盖

- Instrument（期货/期权）
- MarketData（5 档 group）
- OrderRequest
- OrderUpdate
- Trade
- AccountSnapshot
- PositionSnapshot
- GatewayHealth
- MessageHeader template/schema/version

## 4. 结论

P0-1 通过：SBE schema + Java/C++ 编解码 + Java→C++ 互操作成立。

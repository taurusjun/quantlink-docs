# T-022 SimLocal 场所级对账演练

执行日期：2026-11-08

## 方式

SimLocal 网关每秒写出：

```text
/var/lib/quantlink-fin/sim-exchange-snapshot.json
```

脚本对比：

```bash
python3 tools/reconcile-simlocal.py \
  /var/lib/quantlink-fin/sim-exchange-snapshot.json
```

对比项：

```text
控制面未完成订单 vs SimLocal 网关挂单
clientOrderId / instrument / side / price / qty / remaining
控制面 positions 净持仓 vs SimLocal 网关 positions.netQty
```

## 结果（清理历史数据后）

```json
{
  "passed": true,
  "openOrders": 1,
  "venueOrders": 1,
  "positions": 1,
  "differences": []
}
```

## 说明

该演练验证了对账框架、差异分类和 SimLocal 场所数据对齐。
真实 CTP 场所级对账仍需交易日完成；当前 `QF_RECON_GATE_ENABLED=true`
使用本地一致性作为门禁。

## 网关重启恢复

```text
systemctl restart quantlink-fin-sim-exchange
[sim-exchange] seeded positions from snapshot
```

挂单不在网关重启后恢复，由策略重新报价；约 30 秒后控制面与网关重新对齐。

重启后再次对账：

```json
{"passed": true, "openOrders": 3, "venueOrders": 3, "positions": 1, "differences": []}
```

说明：SimLocal 网关从 `sim-exchange-snapshot.json` 恢复持仓，避免持仓发散；
挂单由策略重新报价，避免恢复已取消的陈旧挂单。

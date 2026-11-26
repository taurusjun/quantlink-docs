# T-022 对账门禁当前状态

执行日期：2026-11-08

## 已完成

本地订单/成交/持仓一致性检查已接入正式门禁：

```text
GET /api/v1/reconciliation/consistency
passed=true
issueCount=0
```

风险快照：

```text
reconciliationGateEnabled=true
reconciliationPass=true
```

门禁行为：

```text
对账失败 → 禁止 OPEN
对账失败 → 允许 CLOSE / CANCEL
```

影子库历史差异已清理，种子数据已修正为与成交一致。

## 未完成

```text
CTP 场所级订单/成交/持仓/资金逐笔对账
切换门禁（真实场所对比通过后）
```

需要交易日 CTP 数据。

## SimLocal 场所对账演练

见 `docs/evidence/T-022/simlocal-reconcile.md`：`passed=true, differences=[]`。

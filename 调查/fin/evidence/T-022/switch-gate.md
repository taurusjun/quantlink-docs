# T-022 切换门禁

## 进入并行验证

- 控制面 / ORS Core / CTP Adapter 版本固定
- 交易日历和交易时段配置一致
- 影子账户资金、持仓、手续费率与柜台对齐
- 当日无未解释的订单/成交/持仓差异

## 每日对账门禁

`POST /api/v1/reconciliation/compare` 必须四项全过：

- orders：0 missing，0 field mismatch
- trades：0 missing，0 field mismatch
- positions：0 missing，0 field mismatch
- accounts：balance/available/margin/commission 差异在阈值内

## 切换前门禁

- 连续 2 个交易日四项全过
- 手工单/策略单/撤单/平今/反手均有样本
- 断线/重连/重复登录无异常
- 回滚演练通过：停策略 → 全撤 → 切回旧系统 → 对账一致

## 回滚条件

- 任一订单/成交缺失
- 持仓或资金差异超过阈值
- 撤单失败/重复成交
- 风控或审计不可用

## 当前状态

对账 API 已实现，等待 CTP 正式前置恢复后做双日并行。

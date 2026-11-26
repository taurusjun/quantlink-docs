# T-027 模拟交易所验收证据

执行日期：2026-11-08

## 命令

```bash
c++ -std=c++17 -O2 \
  -I ctp-adapter/src -I ctp-adapter/include/generated \
  ctp-adapter/test/sim_exchange_acceptance_test.cpp \
  -o /tmp/sim_exchange_acceptance_test
/tmp/sim_exchange_acceptance_test
```

## 结果

```text
[PASS] TC-T027-01 登录/订阅
[PASS] TC-T027-02 限价成交
[PASS] TC-T027-03 部分成交
[PASS] TC-T027-04 FAK/FOK
[PASS] TC-T027-05 撤单
[PASS] TC-T027-06 异步延迟 (26ms)
[PASS] TC-T027-07 拒单
[PASS] TC-T027-08 断线重连
[PASS] TC-T027-09 资金/持仓查询
[PASS] TC-T027-10 固定 seed 可复现
[PASS] TC-T027-11 5 档盘口扫单
[PASS] TC-T027-12 u50 CSV 回放
[PASS] TC-T027-13 SHFE 规则拒单
[PASS] TC-T027-14 乘数/手续费
[PASS] TC-T027-15 故障注入断线
[PASS] TC-T027-16 期权撮合
[PASS] TC-T027-17 队列成交概率
[PASS] TC-T027-18 条件单触发
[PASS] TC-T027-19 保证金计算
[PASS] TC-T027-20 结算
ACCEPTANCE PASSED: 20/20
```

`sim_exchange_test` 同样通过，输出 `sim exchange test OK`。

# T-027 模拟交易所 — 首版证据

- 日期：2026-11-06
- 状态：DOING（首版撮合/延迟/抖动已实现）
- 文件：`ctp-adapter/src/sim_exchange.h`
- 测试：`bash tools/run_sim_exchange_test.sh`

## 已实现

- `SimulatedExchangeSession : CtpSession`
- 配置：seed / jitterTicks / tickSize / latencyP50/P99 / rejectRate / partialFill
- `feedTick` 投喂行情，价格加随机抖动
- 异步事件队列 + 随机延迟，`poll()` 回调
- 价格优先撮合
- 部分成交
- DAY 剩余挂单，FAK/IOC 剩余撤，FOK 全成否则撤
- 撤单
- 资金/持仓/手续费
- 5 档盘口扫单
- SHFE 规则：tick/lot/涨跌停
- 乘数/手续费
- 故障注入断线
- 条件单 LAST_GE/LAST_LE/ASK_LE/BID_GE
- 保证金计算
- 结算盯市
- u50 CSV Replay（`--replay`）
- 固定 seed 可复现
- `--simulate` 主程序已接入，先投喂 tick 再下单

## Replay

```bash
./.tools/bin/qf-ctp-adapter --config ~/.quantlink-fin/ors_server.cfg \
  --simulate --instrument ad2605 --replay tests/fixtures/u50_sample.csv
# replay rows=100 emitted=1 malformed=0
# async report 1 FILLED filled=1
```

## 测试结果

```text
sim exchange test OK
[ctp] order 1 au2612 status=SENT
[ctp] async report 1 FILLED filled=1 remaining=0
[ctp] account balance=999082 available=999082
[ctp] position au2612 long=1 short=0
```

## 待完成

- u50 CSV Replay 接入
- 5 档盘口 + 队列位置
- 交易所规则表（SHFE au/ag）
- 故障注入（断线/重连/重复登录）
- LocalCTP 行为对照
- 期权保证金/行权

## LocalCTP 成交对照

已成功用 LocalCTP v6.5.1 跑通 1 手 sc2506 成交，详见 `localctp-comparison.md`。

## 期权保证金

当前使用 `InstrumentRule.marginRate` 统一近似，**不是** SPAN/交易所真实期权保证金公式。真实公式需要你提供规则表后替换。

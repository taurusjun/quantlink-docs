# T-027 长时间模拟交易

- 默认：1 小时
- 命令：

```bash
bash tools/run_sim_exchange_long.sh
```

参数：

```bash
--seconds 3600          # 运行时长
--interval-ms 100       # 行情 tick 间隔
--order-interval 5      # 每 5 秒下一单
--instrument au2612
--replay <u50.csv>      # 可选，默认合成随机游走
--seed 42
--jitter 0.5
```

## 验证

3 秒 smoke：

```text
[sim] report 1 FILLED filled=1 remaining=0 avg=873.893
[sim] report 2 FILLED filled=1 remaining=0 avg=873.869
[sim] report 3 FILLED filled=1 remaining=0 avg=873.979
[sim] done seconds=3 ticks=29 orders=3 balance=999724
```

1 小时运行日志：`/tmp/qf_sim_long.log`

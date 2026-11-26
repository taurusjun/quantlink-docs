# T-027 与 LocalCTP 行为对照

- 日期：2026-11-06
- 状态：TODO（对照清单已建，尚未跑 LocalCTP 二进制）
- LocalCTP：<https://github.com/dearleeyoung/LocalCTP>（MIT）

## 对照矩阵

| 行为 | LocalCTP | 我们 SimulatedCtpSession | 差异/待确认 |
|---|---|---|---|
| CTP 接口 | 完全兼容（替换 so/dll） | CtpSession | 层级不同，但 SPI 行为可对照 |
| 本地运行 | ✅ | ✅ | — |
| 行情 | 需外部投喂 | `feedTick` + u50 Replay | 我们内置回放 |
| 限价成交 | ✅ 对手价 | ✅ 价格-时间/5 档 | 需对照成交价 |
| 部分成交 | SimNow 做市模式通常不部分 | ✅ | 我们更细，但需验证真实感 |
| FAK/FOK | ✅ | ✅ | 对照剩余处理 |
| 条件单 | ✅ | ❌ | 后续补 |
| 期权 | ✅ | ✅ 基本撮合 | 保证金/行权未做 |
| 资金/持仓 | SQLite | 内存账本 | 字段口径需对照 |
| 手续费 | 费率表 | `InstrumentRule` | 需真实费率表 |
| 结算 | 17:00 | 未做 | 后续 |
| 抖动 | ❌ | ✅ | 我们扩展 |
| 随机延迟 | ❌ | ✅ | 我们扩展 |
| 固定 seed | ❌ | ✅ | 我们扩展 |

## 下一步

1. 在 190 编译 LocalCTP v6.5.1/v6.6.9。
2. 用同一组 16 条验收用例跑 LocalCTP。
3. 对比：成交价、部分成交、FAK/FOK、拒单、资金/持仓、手续费。
4. 差异写入本文件，决定哪些行为向 LocalCTP 靠齐。

## LocalCTP 本地构建结果

- 在 190 上 clone + `buildLinux.sh` 成功生成：
  - `/tmp/LocalCTP/bin/linux/libthosttraderapi_se_v6.5.1.so`
  - `/tmp/LocalCTP/bin/linux/TestLocalCTP.out`
- 用 LocalCTP 交易库 + 我们 CTP Adapter `--no-md` 测试：
  - 登录成功：`frontId=1793968934 sessionId=0`
  - 账户查询：balance=2e7, available=0
  - 下单被拒：`order insert rejected: -1 CTP:...`（本次 instrument.csv 只有 sc2506，账户初始化/结算状态需再调）
- 结论：LocalCTP 接口兼容性可验证；要做完整成交对照，需要准备 instrument.csv、账户初始化、行情投喂。

## 2026-11-06 LocalCTP 成交对照成功

环境：

- LocalCTP v6.5.1（190 本地编译）
- 交易库：`/tmp/LocalCTP/bin/linux/libthosttraderapi_se.so`
- `localctp.config`: `running_mode=0`
- 系统 locale：`zh_CN.GB18030`

命令：

```bash
cd /tmp/LocalCTP/bin/linux
LC_ALL=zh_CN.GB18030 \
  /tmp/qf-ctp-live-local \
  --config /root/quantlink-trading/data_cpp/bin/config/ors_server.cfg \
  --instrument sc2506 --no-md --localctp-feed --price 100.0 --order
```

结果：

```text
[ctp] login ready frontId=1793969324 sessionId=0
[ctp] LocalCTP snapshot fed: sc2506
[ctp] order 1 sc2506 status=SENT
[ctp] order update ref=1 status=3 traded=0/1 sys=1793969324546
[ctp] trade id=1793969324546 ref=1 price=100 volume=1
[ctp] order update ref=1 status=0 traded=1/0 sys=1793969324546
[ctp] account balance=2e+07 available=1.999e+07
[ctp] position sc2506 long=1 short=0
```

对照：

| 项 | LocalCTP | 我们 Sim |
|---|---|---|
| 成交价 | 100.0 | 100.0 |
| 成交量 | 1 | 1 |
| 初始资金 | 2000 万 | 100 万（可配） |
| 保证金率 | 约 10% | 10% |
| 持仓 | long=1 | long=1 |
| 条件单 | 支持 | 支持 LAST_GE/LAST_LE/ASK_LE/BID_GE |
| 行情投喂 | `RegisterFensUserInfo` | `feedTick` |
| 抖动/延迟/seed | 无 | 有 |

结论：**LocalCTP 可作为成交/账户行为的有效对照基准；我们的模拟器在成交结果上已对齐，差异主要在资金规模、行情投喂方式、抖动/延迟扩展。**

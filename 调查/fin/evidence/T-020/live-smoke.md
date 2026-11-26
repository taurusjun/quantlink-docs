# T-020 CTP 实盘 Smoke

- 运行时间：**交易时段**
- 默认：**只读**（登录/订阅/资金/持仓）
- 下单：必须显式 `QF_CTP_ORDER=1`，且人工确认

## 命令

```bash
CTP_HOME=/opt/finrobot/ors/third_party/ctp/linux \
  bash tools/ctp_live_smoke.sh
```

只读输出应包含：

```text
[ctp] mode=live CTP
[ctp] login ready frontId=... sessionId=...
[ctp] subscribed au2612
[ctp] subscribed ag2612
[ctp] read-only: no order sent (add --order to send)
[ctp] account balance=... available=...
[ctp] position ...
```

## 单手测试

```bash
QF_CTP_ORDER=1 bash tools/ctp_live_smoke.sh
```

仅限交易时段、人工确认、1 手、最小合约。

## 配置

`~/.quantlink-fin/ors_server.cfg`，前置 `222.71.253.5:34205/34213`，
BrokerID 88888，InvestorID 99000943，PRODUCTION_MODE=0。

## 2026-11-06 实测

- `222.71.253.5:34205/34213` 在 20:35 连接被拒绝（非交易时段/前置未开）
- 使用 `/opt/finrobot/data_cpp/bin/config/ors_server.cfg`（SimNow `182.254.243.31:30001/30011`）只读测试成功：

```text
[ctp] login ready frontId=1 sessionId=-915798770
[ctp] login ok, state=3
[ctp] subscribed au2612
[ctp] subscribed ag2612
[ctp] account balance=2.27913e+07 available=1.96332e+07
[ctp] position ag2706 long=0 short=88
```

- 20:35 发单手 au2612 被柜台拒绝：

```text
[ctp] order insert rejected: 21 CTP:该交易所席位未连接到交易所
```

- 已安排 21:00 夜盘再跑：
  - `222.71.253.5` 配置：`/tmp/qf-ctp-order-222-2100.log`
  - SimNow 配置：`/tmp/qf-ctp-order-2100.log`

## 21:00 夜盘实盘 Smoke（测试环境）

### SimNow 配置：完整下单成功

```text
[ctp] config loaded: trader=tcp://182.254.243.31:30001 md=tcp://182.254.243.31:30011
[ctp] login ready frontId=1 sessionId=-815549977
[ctp] subscribed au2612
[ctp] order 1 au2612 status=SENT
[ctp] tick au2612 last=873.86 bid=873.82 ask=873.96 volume=1035
[ctp] order update ref=1 status=a traded=0/1
[ctp] order update ref=1 status=0 traded=1/0 sys=4506
[ctp] trade id=3015 ref=1 price=873.82 volume=1
[ctp] position au2612 long=1 short=0
```

结论：

- CTP 登录/认证/结算确认成功
- MD 订阅成功，收到 au2612 tick
- 报单被接受
- 成交 1 手，成交价 873.82
- 持仓更新 long=1

### 222.71.253.5 配置

21:00 仍然：

```text
[ctp] login failed
```

判断：`222.71.253.5:34205/34213` 当前前置不可用，暂用 SimNow 测试环境完成完整验证。

## 21:0x 撤单实测（SimNow）

下 1 手 au2612 低价挂单，再撤：

```text
[ctp] order 1 au2612 status=SENT
[ctp] order update ref=1 status=a traded=0/1
[ctp] order update ref=1 status=3 traded=0/1 sys=19107
[ctp] cancel 1 status=SENT
[ctp] order update ref=1 status=3 traded=0/1 sys=19107
[ctp] order update ref=1 status=5 traded=0/1 sys=19107
```

`status=5` 为已撤。原有多头 `au2612 long=1` 保留，未平仓。

命令：

```bash
/tmp/qf-ctp-live --config /opt/finrobot/data_cpp/bin/config/ors_server.cfg \
  --instrument au2612 --no-md --order --price 800.0 --cancel 1
```

## 21:2x 平仓/反手实测（SimNow）

### 平掉 au2612 long=1

`CLOSE` 被拒：

```text
[ctp] order insert rejected: 51 CTP:平仓仓位不足
```

改用 `CLOSE_TODAY` 成功：

```text
[ctp] order 1 au2612 status=SENT
[ctp] order update ref=1 status=0 traded=1/0 sys=24548
[ctp] trade id=16226 ref=1 price=872.36 volume=1
[ctp] position au2612 long=0 short=0
```

### 反手做空 1 手

```text
[ctp] order 1 au2612 status=SENT
[ctp] trade id=16302 ref=1 price=872.32 volume=1
[ctp] position au2612 long=0 short=1
```

### 再平空 1 手

```text
[ctp] trade id=16360 ref=1 price=872.4 volume=1
[ctp] position au2612 long=0 short=0
```

结论：

- 上期所当日仓必须用 `CLOSE_TODAY`，`CLOSE` 会报“平仓仓位不足”
- 开仓/平今/反手链路均已实测

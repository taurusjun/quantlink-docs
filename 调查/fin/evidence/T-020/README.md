# T-020 CTP Adapter — 阶段证据

- 日期：2026-11-06
- 状态：DOING（模拟模式 PASS；实盘待交易时段）
- 配置键来自 quantlink-trading `ors_server.cfg`

## 已完成

- C++ `CtpConfig` 解析全部 CTP 键
- 秘钥脱敏日志
- `CtpSession` 接口 + `SimCtpSession`
- 登录/订阅/下单/撤单/资金/持仓模拟
- `tools/run_ctp_sim.sh`

## 验证

```text
ctp config/sim test OK
[ctp] config loaded: trader=tcp://127.0.0.1:34205 md=tcp://127.0.0.1:34213 broker=9999 investor=000001 production=0 authCode=*** appId=***
[ctp] mode=simulation (non-trading hours)
[ctp] login ok, state=3
[ctp] subscribed 2 instruments
[ctp] order 1 au2612 status=FILLED filled=1 avg=918.42
[ctp] account balance=999082 available=999082
[ctp] position au2612 long=1 short=0
```

## 实盘编译（Linux 190）

```bash
CTP_HOME=/opt/finrobot/ors/third_party/ctp/linux bash tools/build_ctp_live.sh
```

正式配置：`~/.quantlink-fin/ors_server.cfg`（来自 `/root/quantlink-trading`，前置 `222.71.253.5:34205/34213`，BrokerID 88888，InvestorID 99000943，PRODUCTION_MODE=0）

已在 190 用 g++ 11.5 + CTP SDK 编译通过：

```text
/tmp/qf-ctp-live (ELF 64-bit)
```

实现：认证→登录→结算确认、MD 登录/订阅、报单/撤单、资金/持仓查询、断线状态。

## 待完成

- 交易时段实盘登录/报单联调
- Aeron + SBE 发布/订阅
- 断线自动重连/双登录保护

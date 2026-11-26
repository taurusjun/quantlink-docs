# ADR-001 最终定向复审

- 日期：2026-11-12
- 复审对象：`docs/architecture/adr/ADR-001-indicator-replay-contract.md`
- 复审范围：仅在首轮评审基础上的 D2/D6 两条 P0 修订
- 结论：**APPROVED（协议决策）**
- 生产状态：**仍 BLOCKED**；APPROVED 不替代 §11 的 production 准入 gate

## 1. 复审过程

首轮定向评审（`docs/reviews/2026-11-12-adr-001-targeted-review.md`）：

```text
D1 / D3 / D4 / D5：CLOSED
D2 / D6：PARTIAL
```

修订后第二轮复审：

```text
D1 / D3 / D4 / D5：保持 CLOSED
D2 / D6：CLOSED
仍会阻止生产的 P0：无
必须修改项：无
结论：APPROVED
```

## 2. D2 live barrier

判定：**CLOSED**

修订后的 §4.1 步骤 9：

```text
同 (sourceSessionId, sourcePublicationEpoch)：
  seq > lastSeq  -> 接受
  seq <= lastSeq -> 重复丢弃
不同 session/epoch：
  不能沿用旧 lastSeq
  current epoch -> 重新捕获 applyCut 或 WARMUP
  非 current    -> 丢弃并告警
```

§4.2 的 position 比较也限定在同 source session/epoch；跨代 position 不可比时走 epoch 规则。  
上一轮“publisher 重启后新 epoch seq 从 1 开始被整段当重复丢掉”已关闭。

## 3. D6 1d barCut

判定：**CLOSED**

修订后的 §8.3：

```text
日盘收盘（交易日最后一个日盘 session 结束）：
  daily bar close
  barCut.status = CLOSED

夜盘收盘：
  只结束 night segment
  当前交易日 bar 仍为 PARTIAL
  不置 CLOSED

若交易所日历定义 tradingDayEnd 在夜盘：
  按 calendar 触发 CLOSED
```

测试要求同步改为：

```text
15:00 日盘收盘 -> CLOSED
02:30 夜盘收盘 -> 仍 PARTIAL
```

上一轮“02:30 夜盘收盘提前发布缺日盘的 1d bar”已关闭。

## 4. 仍阻止生产的项

不是 ADR 协议 P0，而是 §11 的 production gate：

```text
D1 真实 Archive 最后一帧 golden：PENDING
27 号文档：REJECT，尚未更新/取代
```

因此：

```text
ADR-001: APPROVED（协议决策）
Production: BLOCKED
```

## 5. 审核边界

本次只确认 D2、D6 两条 P0 及其修订是否引入新矛盾；没有重审 27 号文档全文，没有审生产代码迁移，没有修改文件、执行 SQL 或提交代码。

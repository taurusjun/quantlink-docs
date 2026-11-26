# Drain 语义：quantlink-trading 对照

日期：2026-11-08

## trading 的做法

trading 没有单独命名为 `drain()` 的函数，实际由信号 + 策略状态机完成：

```text
SIGTSTP / SIGTERM / SIGRTMIN
  → m_onExit = true
  → m_onCancel = true
  → m_onFlat = true
  → HandleSquareoff()
```

含义：

```text
m_onExit   停止新开仓/新报价
m_onCancel 撤掉活动挂单
m_onFlat   按净持仓平仓
```

策略只有在以下条件全部满足时才退出交易：

```cpp
m_netpos == 0 && m_onExit && m_askMap.size() == 0 && m_bidMap.size() == 0
```

此时：

```cpp
m_Active = false;
```

trading 不会在 `HandleSquareoff()` 里直接 kill 进程；它等待净仓归零和订单簿清空。

### 信号

```text
SIGUSR1             → 重新激活：m_onExit/m_onCancel/m_onFlat = false；HandleSquareON()
SIGRTMIN + 2 (36)   → 单策略 aggressive squareoff：m_aggFlat = true
SIGRTMIN + 3 (37)   → 组 aggressive squareoff
SIGUSR2             → reload thresholds（不是完整进程重启）
SIGTSTP/SIGTERM     → squareoff
```

### 关键点

```text
1. drain 是“先停新单，再撤单，再平仓，确认 flat，最后 inactive”
2. 不是先 kill 进程
3. aggressive 只改变平仓价格，不跳过 flat 确认
4. 挂单簿为空和净仓为零必须同时满足
```

## quantlink-fin 应对齐

当前 fin：

```text
stop-all 已暂停 deployments 并 cancel-all
flatten-strategy 已允许 PAUSED 策略
```

还缺：

```text
DRAINING 状态
runner 本地 drain hook
cancel → flatten → wait flat → stop process
ProcessManager.reload/stop 等待 drain 完成
本地 kill switch
断线 cancel-on-disconnect
```

建议 fin 的状态机：

```text
ACTIVE
  → DRAINING（停止新单，撤单，平仓）
  → FLAT_CONFIRMED（netpos=0 且 openOrders=0）
  → INACTIVE / STOPPED
```

Agent 在 `deactivate` / reload 前必须等待 `FLAT_CONFIRMED`，不能用固定 5 秒强杀。

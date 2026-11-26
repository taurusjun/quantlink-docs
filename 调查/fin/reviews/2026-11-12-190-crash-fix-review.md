# 190 崩溃修复提交评审

- 日期：2026-11-12
- 评审范围：
  - `5757b8d fix(control-plane): 修复 Aeron 消费者关闭竞态并限制 journal 日志`
  - `f5f445c fix(ctp-adapter): 不再从 Aeron 后台线程 exit，消除 CTP 段错误`
- 评审方式：代码静态审查 + control-plane 定向测试 + 190 运行状态检查
- 结论：**方向正确，但不能判定为“已正确完成”；存在两处会复现同类崩溃的关闭竞态。**

## 1. 结论摘要

```text
5757b8d  Java 关闭顺序修复：PARTIAL
f5f445c  C++ 退出路径修复：PARTIAL
190 当前状态：核心服务 active，但 archive-replay 在重启循环
生产可用性：NOT APPROVED
```

两个提交都修到了真实根因的一部分：

```text
默认 Aeron errorHandler 从 conductor 线程 exit()
-> 静态析构时 CTP 回调线程仍在运行
-> SIGSEGV
```

但当前实现仍保留“worker 未停止就关闭 native 资源”的路径，以及“先关 Aeron、后停 CTP 回调”的顺序。

## 2. Java：5757b8d

### 2.1 做对的部分

- 新增 `AeronWorker.stop(worker, timeout)`，先 `interrupt` 再 `join`。
- `IndicatorStreamConsumer` 已正确处理：
  - 先停止 worker；
  - join 失败时保留 subscription/Aeron，不再关闭。
- `IndicatorStreamConsumer` 对 MediaDriver 失联/订阅关闭停止 poll。
- `ThrottledLog` 避免日志风暴。
- 定向测试通过：

```text
AeronWorkerTest
ThrottledLogTest
tests=3 failures=0 errors=0
```

### 2.2 仍未闭合的 P1

`AeronWorker.stop` 返回值在多数消费者中被忽略，join 超时后仍然关闭 native 资源：

| 文件 | 当前行为 | 风险 |
|---|---|---|
| `AccountSnapshotConsumer.java` | 忽略返回值，继续 close | worker 仍可能使用已释放 buffer |
| `AeronOrderUpdateConsumer.java` | 忽略返回值，继续 close 三组 subscription | 同上 |
| `CtpSnapshotConsumer.java` | 忽略返回值，继续 close | 同上 |
| `PositionSnapshotConsumer.java` | 忽略返回值，继续 close | 同上 |
| `StrategyRuntimeConsumer.java` | 忽略返回值，继续 close | 同上 |
| `MarketDataAeronConsumer.java` | join 失败仍 close subscribers | 直接违反本次修复目标 |

`MarketDataAeronConsumer.stop()` 当前是：

```java
if (!AeronWorker.stop(worker, 5000)) {
    subscribers.forEach(route -> route.subscriber().close());
    return;
}
```

join 失败说明 worker 可能还在 `poll()` 的 native 栈里；此时关闭 subscriber 仍可能复现 SIGSEGV。

### 2.3 建议

统一为：

```java
if (worker != null && !AeronWorker.stop(worker, 5000)) {
    log.warn("worker did not stop; keeping Aeron resources open");
    return;
}
// 只有 join 成功后才 close subscription/Aeron
```

不要把 `subscription.close()` 放在 join 失败分支。

更彻底的做法是让 worker 自己在 `finally` 中关闭资源，`@PreDestroy` 只负责停 worker 和等待；这样资源生命周期只有一个 owner。

## 3. C++：f5f445c

### 3.1 做对的部分

- 不再让 Aeron 默认 errorHandler 从 conductor 线程 `exit()`。
- 改为设置 `fatal_`，主循环检测后正常退出。
- 190 已重新编译并替换 `qf-ctp-aeron`。
- 190 上旧的 hs_err 停留在 11/11，17:10 后没有新的 hs_err。

### 3.2 P0：关闭顺序仍然先 Aeron、后 CTP

`main.cpp` 当前正常退出路径：

```cpp
if (bridge) bridge->close();
session->logout();
```

`CtpLiveSession::logout()` 才调用 `md_->Release()` / `trader_->Release()`，也就是停止 CTP 回调线程。  
但 `publishTick()` 是 CTP MD 回调线程直接调用的：

```cpp
session_.setTickHandler([this](const Tick& tick) { publishTick(tick); });
```

`publishTick()` 直接使用 `mdPub_`：

```cpp
if (mdPub_->offer(buffer, 0, ...) < 0L) { ... }
```

因此 `bridge->close()` 执行 `mdPub_.reset()` 时，CTP 回调线程仍可能正在 `mdPub_->offer()`：

```text
main:   mdPub_.reset()
CTP:    mdPub_->offer()   <-- use-after-free / data race
```

这和原崩溃不是同一个栈，但属于同一类“关闭时仍有回调线程使用已释放 native 对象”的问题。

### 3.3 P0：异常路径会先析构 bridge

`bridge` 在 `try` 块内部声明：

```cpp
try {
    std::unique_ptr<qf::CtpAeronBridge> bridge;
    ...
    bridge = std::make_unique<...>();
    ...
} catch (...) {
    ...
}
```

如果 `bridge->poll()` 抛异常，栈展开会先析构 `bridge`，而 `session` 仍在外层存活，CTP 回调线程也可能仍在运行。  
这等价于“先关 Aeron、后停 CTP”，异常路径没有修复。

### 3.4 P1：errorHandler 捕获 `this` 的生命周期

```cpp
context.errorHandler([this](const std::exception& ex) {
    fatal_.store(true, ...);
    ...
});
```

成员声明顺序是：

```cpp
std::shared_ptr<aeron::Aeron> aeron_;
std::atomic<bool> fatal_{false};
```

析构按声明逆序：`fatal_` 先于 `aeron_` 销毁。若 `aeron_` 析构期间 errorHandler 被调用，lambda 会访问已结束生命周期的 `fatal_`。  
应把 `fatal_` 声明在 `aeron_` 之前，或改用不依赖 `this` 的 shared state。

### 3.5 建议的最小修复

```text
1. bridge 声明移到 try 外，保证异常路径也由同一处 shutdown 管理。
2. 退出顺序改为：
      session->logout()   // 停止 CTP 回调线程
      bridge->close()     // 再关闭 Aeron native 对象
3. bridge 增加 closing_ 标志；publishTick 在 closing_ 时直接返回。
4. fatal_ 声明移到 aeron_ 之前，或 errorHandler 捕获 shared_ptr<atomic<bool>>。
5. publishTick 对 mdPub_ 做空指针检查。
```

注意：`session->logout()` 之后 `CtpLiveSession` 析构还会再次调用 `logout()`，当前实现是幂等的；修改顺序时要保持这一点。

## 4. 190 运行状态

检查时间：2026-11-12 17:24-17:27 CST。

```text
quantlink-fin-control                  active
quantlink-fin-aeron-archive            active
quantlink-fin-archive-recorder         active
quantlink-fin-runtime-agent-simnow     active
quantlink-fin-runtime-agent-shengli    active
quantlink-fin-runtime-agent-simvenue   active
quantlink-fin-sim-venue                active
```

- journal 使用 891.6M，低于 1G 限额。
- `/var/lib/systemd/coredump` 为空。
- 最新的 hs_err 仍是 11/11，17:10 后没有新文件。
- 未发现 `qf-ctp-aeron` 进程（可能因收盘未启动，不能据此判断修复已在线验证）。

### 新的独立问题：archive-replay 重启循环

```text
quantlink-fin-archive-replay.service
Active: activating (auto-restart)
restart counter: 77
```

日志：

```text
requested replay start position=0 must be less than the limit position=0 for recording 3608
```

这是一个零长度 recording 导致的启动回放失败，和本次两个提交无直接关系，但会持续重启/写日志。建议：

```text
1. 暂停该 timer/service，避免无效重启
2. ArchiveReplayTool 跳过 length==0 的 recording
3. 或清理/标记 recording 3608
```

## 5. 验证边界

已执行：

```text
:backend:control-plane:test
  --tests AeronWorkerTest
  --tests ThrottledLogTest
tests=3 failures=0 errors=0
```

未独立复跑：

```text
control-plane 全量 47/47
190 上 CTP 实盘/模拟连接
kill -9 + 重启回归
```

因此 `5757b8d` 的单测声明可信，但不能替代关闭竞态的故障注入验证。

## 6. 最终判定

```text
f5f445c 根因判断：正确
f5f445c 修复完整性：不完整（P0 关闭顺序 + 异常路径）
5757b8d 方向：正确
5757b8d 覆盖完整性：不完整（多数消费者忽略 join 超时）
190 当前：核心服务已恢复，但 archive-replay 仍在失败重启
生产/长期运行：不建议在修复上述两处前判定完成
```

另外，`f5f445c` 目前只在本地 `main`，尚未 push 到 `origin/main`。

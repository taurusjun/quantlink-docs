# T-003 Aeron IPC — 验证证据

- 日期：2026-11-06
- 状态：PASS
- 任务：T-003
- 环境：macOS arm64、JDK 25、Aeron 1.54.0、C++ clang、C media driver

## 1. 构建

```bash
bash tools/build_aeron_cpp.sh
```

- Aeron C++ 源码：`.tools/aeron-src`
- C++ echo 客户端/服务端：`.tools/bin/aeron_echo_client`、`.tools/bin/aeron_echo_server`
- Java：`backend/shared/aeron`

## 2. 双向 100k

```bash
bash tools/run_aeron_interop.sh
```

结果：

```
==> Java client -> C++ server (100000)
Aeron Java client: count=100000 p50=292ns p99=3041ns p999=12542ns
C++ Aeron echo server received 100000

==> C++ client -> Java server (100000)
C++ Aeron client: count=100000 p50=292ns p99=2750ns p999=12459ns
Aeron server done: 100000

Aeron interop PASS
```

## 3. 结论

- Java ↔ C++ 双向各 100,000 条，0 丢失
- 单机 IPC p50 ≈ 0.3µs、p99 ≈ 3µs（echo 往返，含调度）
- `aeron:ipc` + 独立 C media driver 可用
- 满足 P0-2/P0-3 门禁

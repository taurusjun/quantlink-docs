# P0-7 影子库 — 验证证据

- 日期：2026-11-06
- 状态：PASS
- 任务：T-026

## 1. 重置

```bash
bash tools/db/reset-shadow.sh
```

## 2. 校验

```bash
bash tools/db/verify-shadow.sh
```

结果：

| table | rows |
|---|---:|
| users | 3 |
| accounts | 2 |
| instruments | 7 |
| strategies | 3 |
| orders | 4 |
| positions | 4 |
| audit_log | 1 |

## 3. 安全

脚本拒绝任何不以 `_shadow` 结尾的数据库名。

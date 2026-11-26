# T-028 Phase 0 执行域只读拓扑

- 日期：2026-11-07
- 页面：`/execution`
- 接口：`GET /api/v1/execution/topology`

结果：

```text
Agents: 1
Active Bindings: 1
Active Routes: 1
Deployments: 3
```

当前拓扑：

```text
agent-simnow-01
  → SIMNOW / TEST-001
  → order 2001 / cancel 2004 / update 2002 / trade 2003
  → route-TEST-001-SIMNOW
```

说明：Phase 0 只读，不改变订单路由。

截图：`execution-topology.png`

## 2026-11-07 ORS 简化模型

- 页面：`/execution`
- 模型：1 ORS = 1 柜台 = 1 账户
- 当前 ACTIVE：`ors-simlocal-001` / `SIMLOCAL-001`
- 过渡表 `agent_account_bindings` / `agent_leases` / `order_routes` 已删除
- 截图：`ors-simplified.png`

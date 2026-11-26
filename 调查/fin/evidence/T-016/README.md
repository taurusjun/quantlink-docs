# T-016 手工交易与审计 — 阶段证据

- 状态：DOING
- 已完成：POST `/api/v1/manual/orders`、写入 orders(source=manual)、审计、RBAC
- 已完成：`ManualOrderPublisher` 经 Aeron 发送到 ORS Gateway，测试成交并更新持仓
- 已完成：Web 手工交易页、可选 Aeron 桥
- 已完成：`POST /api/v1/manual/orders/cancel-all` + Web 全撤按钮
- 已完成：服务端预检 `/manual/orders/preview`（tick/lot/合约/账户/可用资金/名义金额/只减仓）
- 已完成：名义金额 ≥5 万强制二次确认（输入合约代码）
- 已完成：撤单指令 SBE `CancelRequest` + Aeron；Aeron 未连接时明确 `CANCEL_FAILED`，不假装已撤
- 未完成：CTP 撤单回执回写

验证：

```bash
curl -u test_trader:test -H 'Content-Type: application/json' \
  -d '{"accountId":"TEST-001","instrumentId":"au2612","side":"B","price":918.42,"qty":1}' \
  http://127.0.0.1:18081/api/v1/manual/orders
# {"clientOrderId":900000005,"status":"NEW","source":"manual"}

curl -o /dev/null -w '%{http_code}' -u test_viewer:test ... 
# 403
```


## 撤单链路测试

`ManualOrderPublisherTest.cancelRequestReachesOrsGateway`：

1. 下限价单 99.00（不成交）→ OrderUpdate OPEN
2. 发 CancelRequest
3. ORS Gateway → SimExchange → OrderUpdate CANCELED

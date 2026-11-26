# CTP OnErrRtnOrderInsert verification

A test order row was inserted with clientOrderId `900000000037` and a huge qty.
`OrderRequestV2` was injected directly into Aeron 2100 to bypass the local risk layer.

Result in `orders`:

```text
client_order_id: 900000000037
status: REJECTED
exchange_order_id: empty
error_msg: 31:CTP:<ErrorMsg>
```

This confirms `OnErrRtnOrderInsert` reaches `OrderUpdateV2` and control-plane persists REJECTED
with the CTP ErrorID/ErrorMsg. CTP ErrorMsg is GBK; display encoding is a separate UI issue.

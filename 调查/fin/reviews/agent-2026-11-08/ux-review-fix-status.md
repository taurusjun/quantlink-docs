# UX 复审修复状态

日期：2026-11-08

## P0

```text
UX-P0-01  FIXED  确认后 historyAlerts 乐观 ACK + loadHistory；ACK 锁；单一入口
UX-P0-02  FIXED  手动激活走确认 Dialog；仅 INACTIVE/FAILED 且已部署显示
UX-P0-03  FIXED  无行情合约清空价格/禁用预检；行情刷新不覆盖输入
UX-P0-04  FIXED  确认按钮 busy 锁定；提交防双击
UX-P0-05  FIXED  期权快捷单 previewKey；未预检/失效禁止提交；Drawer 避开 AppBar
```

## P1（主要项）

```text
UX-P1-02  FIXED  行情条 lg 断点，1366/1440 可见
UX-P1-03  FIXED  策略详情标题/返回策略中心/侧栏高亮
UX-P1-04  FIXED  期权链隐藏 OI/Vol、Strike sticky、缩小 minWidth
UX-P1-05  FIXED  Drawer top 偏移
UX-P1-06  FIXED  订单默认 OPEN、5s 刷新、搜索、sticky、批量撤单、详情
UX-P1-07  FIXED  撤单确认/逐单回执/时间格式化/来源
UX-P1-08  FIXED  策略状态筛选、搜索、ACTIVE 隐藏部署、生命周期
UX-P1-09  FIXED 逐步校验、创建 busy、关闭未保存确认
UX-P1-10  FIXED 独立系统告警入口、severity、ack/silence/resolve/runbook
UX-P1-11  FIXED 5s 自动刷新、kiosk、状态色、系统告警 ack/silence/runbook
UX-P1-12  FIXED  审批确认/busy/拒绝/详情 payload
UX-P1-13  FIXED  账户选择器、tick/lot、盘口 bid/ask
UX-P1-14  FIXED  MUI focus-visible、badge 0、日历 aria-label
UX-P1-15  FIXED  买/卖/涨跌 token 分离
UX-P1-16  FIXED  Electron monitor kiosk、两列布局
UX-P1-17  FIXED  Dashboard 环境/保证金语义、移除重复日历 Alert
UX-P1-18  FIXED 更新 reload、策略向导、CommonConfig、PAIR 关闭未保存确认
UX-P1-19  FIXED  connected 纳入 agent/ORS/market
UX-P1-20  FIXED  审批选择器 + X-Approval-Id
```

## P2

```text
FIXED: maxWidth 1680、订单时间格式、无报价禁用、Tabs 面板、PnL 语义、
       全局待处理计数、空态、Skeleton 变体、顶栏清理、登录用户名/品牌、
       badge/chip、审计筛选、向导视觉断言
FIXED: format 时间接线、生产隐藏离线演示、Playwright 交互用例 10 passed
```

## 说明

```text
导航归属按用户指定保留：策略中心/指标中心在交易，日历在数据接入。
系统告警为独立入口，Monitoring 复用同一 ack/silence/runbook。
Playwright 已覆盖 ACK、双击下单、期权预检、系统告警、Runbook。
```

## 部署

```text
web build PASS
已部署 190
```

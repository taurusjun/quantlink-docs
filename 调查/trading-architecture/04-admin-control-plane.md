# 04 — 管理面：tbadmin（C++）、tbadmin-py、Vue 前端、策略表同步、admin 协议

> 证据约定：**V** = 直接读代码/配置/脚本确认，附 `文件:行号`；**I** = 由代码结构/脚本/部署文件推断，未在运行环境验证；**P** = 计划/文档描述，当前代码未实现或未按此运行。
> 源码快照：`/Users/wangjun/PG/RD/quantlink-trading`，commit `5cee3dd5b3322ec21c1958aac20ad38ba0d8ca40`，`main`，2026-11-18。
> 范围：`tbadmin/`、`tbadmin-py/`、`tbadmin-front/`、`vue3-admin/`、`tools/strategy_sync/`、`ops/crontab.txt`、`ops/nginx/`。
> 明确排除：`web-go/`（Go Dashboard、`memlog-reader`、`:8080`）整块不分析；本文只在“数据链断在哪”时把它当外部黑盒提一句。
> 本文不含任何明文口令/token/webhook key。凡涉及凭据只记录**位置与风险**。

---

## 0. 结论摘要（先看这 12 条）

1. **tbadmin 是一个“旁路监控 + 有限控制”面，不是交易主链路**。它只读 SHM、只发 ZMQ、只写少量管理表；它死了 TradeBot/ORS 照跑（`tbadmin/Makefile:25` 的库、`tbadmin/admin.cpp:4557-4591` 的只读消费）。
2. **两种角色同一个二进制**：`tbadmin agent` 读本机 SHM 转发；`tbadmin admin` 聚合、算派生量、写 DB、对前端广播（`main.cpp:5-22`、`admin.cpp:1518`、`:4445`）。
3. **进程名不是 `tbadmin`**：`prctl(PR_SET_NAME)` 改成 `AgentLoop`/`AdminLoop`（`admin.cpp:1520`、`:4447`）。任何 `pgrep -x tbadmin` 都是假检查；仓库里的健康检查已经改对（`scripts/ops_check_status.sh:154-167`）。
4. **状态是“事件推送 + 进程内内存”，没有回放、没有心跳、没有序列号校验**。丢一条 memlog 消息，前端就永久停在旧值，直到下一条同类型消息（`admin.cpp:294-425`、`:4557-4591`）。
5. **策略列表来自 DB，只在 admin 启动时读一次**（`admin.cpp:595-735`、`:4459`）。所以 `strategy_sync` 写完库必须重启 admin；cron 用 08:28/08:30（`ops/crontab.txt:917-921`）实现，代码里那条 `case 1` 热重载**没有任何调用方**（全库 grep 只有 admin 自己）。
6. **`tbhft_strategy` 是唯一真值源**，但字段语义被三套代码各自解释：C++ 管理面、Flask 后端（SQLAlchemy）、FastAPI 半成品（另一套 `admin_db`）。三者的 `server` 字段约定还不一致（见 §4.5）。
7. **前端的“仓位/账户”页在本仓库链路里没有数据源**：`Position` 表只渲染 `strategyID == -99` 的 ORS 仓位（`admin.cpp:4223-4245`），而全仓库只有 `tbadmin/testmemlog` 会写 `-99`（`testmemlog/main.cpp:106`）；`Account` 消息来自被注释掉的 YD 客户端（`admin.cpp:788-818`），并且前端把 `msg.Account` 的处理也注释了（`tbcheck/index.vue:596-599`）。
8. **命令通道是一条无认证的 ZMQ PUB/SUB**，`admin` 在 `*:9980/9981` 上 bind（`admin.cpp:509`、`:781`），任何能连 9981 的进程都能发 `toadmin|-1|{"msgtype":"orderReq",...}` 触发真实报单。`agent` 侧还会 `popen()` 执行远端下发的 `cmd` 字符串（`admin.cpp:2068`、`:2092`）。
9. **当前 190 单体部署跑的是 `tbadmin-py/new/message_forwarding`（:8882）**，它只订阅 `tofront/ordermsg/mdmsg`（`tbadmin-py/new/message_forwarding/message_forwarding.py:20`）。admin 的 `strategyRsp` 走 `tomanage`（`admin.cpp:3174`、`:4489`），因此**策略保存的成功/失败/超时提示在 190 上永远看不到**；旧 forwarder 订阅了 `tomanage`（`vue3-admin/back_end/message_forwarding/message_forwarding.py:36-41`）但指向旧内网。
10. **`tbadmin-py` 绝大多数是退役件**：`ops/crontab.txt:172-209` 明确记录 7 件监控层整体退役；仍在用的是 `new/message_forwarding` 与 `admin_backend`（同段 `:208-209`）。其余子目录的 DB 地址、共享盘路径、柜台 IP 都指向旧机房，直接跑会连错库或写假挂载点。
11. **策略表同步工具有独立单测、备份表、冲突拒绝、批次跳过**（`tools/strategy_sync/sync_tbhft_strategy.py:135-169`、`:204-239`、`:314-320`），是全仓管理面里工程质量最好的一块。
12. **复刻时最小可用管理面 ≈ 600 行**：读 memlog + 读 response SHM + 一个 WS/HTTP 出口 + 4 张表。期权 Delta、PythonBot、YD 账户、CPU 绑核、control 文件生成全都可以先砍（见 §9）。

---

## 1. `tbadmin` 进程角色、启动、生命周期

### 1.1 入口与角色判定

```cpp
int main(int argc, char **argv) {
    if (argc > 2) {                       // 测试模式：argv[2] 当 info 写一条 STRATEGY_DETAIL
        tba = new tbadmin::admin("agent"); tba->Init();
        tba->WriteMemLog("myproduct", argv[2], 1234, 1, MemLogType::STRATEGY_DETAIL);
        return 0;
    }
    if (0 == strncmp(argv[1], "agent", 5)) tba = new tbadmin::admin("agent");
    else                                   tba = new tbadmin::admin("admin");
    tba->Init(); tba->Run();
}
```

- **V** `tbadmin/main.cpp:5-46`。角色只看 `argv[1]` 前 5 字节：`agent` → AGENT_MODE，**其他任何字符串**（含拼错、`admin`、空）→ ADMIN_MODE（`main.cpp:15-22`、`admin.cpp:86-99`）。也就是说 `tbadmin agnet` 会静默起成 admin，然后去 bind 9980 与现有 admin 抢端口。
- 参数个数 >2 时走“写一条 memlog”的测试分支（`main.cpp:8-14`），**这条分支不做任何权限/环境检查**，在生产目录误敲 `tbadmin agent foo` 会往 789 里塞一条假告警。
- `Init()` 里只做配置加载 + SHM attach（`admin.cpp:4592-4638`）；DB 连接、ZMQ、策略表加载都在 `RunAgent`/`RunAdmin` 里（`admin.cpp:1518-1527`、`:4445-4460`）。
- 异常处理：`Init()`/`Run()` 抛 `std::string`、`std::exception`、未知异常都被 main 捕获并打印 `[FATAL]` 后 `return 1`（`main.cpp:23-43`）。好处是不会静默死；坏处是**任何未捕获的类型都会进程退出**，没有重试。

### 1.2 启动脚本与目录约定

| 脚本 | 行为 | 证据 |
|---|---|---|
| `tbadmin/start_agent.sh` | `cd $(dirname $0)`（必须，配置是相对路径 `./cfg/agent.cfg`）→ 导出 `LD_LIBRARY_PATH=./lib` → 已有 `agent.pid` 且活着就退出 → `nohup ./tbadmin agent >> log/agent.log` → 写 `agent.pid` | `tbadmin/start_agent.sh:1-24`（V） |
| `tbadmin/start_admin.sh` | 同上，`./tbadmin admin`，`admin.pid`，`log/admin.log` | `tbadmin/start_admin.sh:1-22`（V） |
| `tbadmin/stop_agent.sh` | 先按 `agent.pid` kill -9，再 `ps -ef \| grep -w './tbadmin'` **兜底把所有 tbadmin（含 admin）一起杀** | `tbadmin/stop_agent.sh:9-19`（V） |
| `tbadmin/clear.sh` | `echo "{}" > cfg/order_ref.json`；`rm -f cfg/*.dat` | `tbadmin/clear.sh:1-9`（V）；cron 15:30 调用（`ops/crontab.txt:131`） |
| `scripts/start_tbadmin.sh` | admin → agent → `tbadmin-py/new/message_forwarding`(:8882) → `vue3-admin/back_end` Flask(:5004)；**不写 pid 文件** | `scripts/start_tbadmin.sh:24-56`（V） |
| `scripts/start_all_with_tbadmin.sh` | 先 `start_all.sh` 起核心，再 admin/agent，可选 forwarder；pid 写到 `/tmp/*.pid` | `scripts/start_all_with_tbadmin.sh:9-16`、`:67-84`（V） |
| `scripts/ops_ensure_tbadmin.sh` | 交易时段每 5 分钟按 `agent.pid`/`admin.pid` 补拉 | `scripts/ops_ensure_tbadmin.sh:13-21`（V）；cron `*/5 9-11,13-15`（`ops/crontab.txt:946`） |

**运维冲突（V+I）**：`start_tbadmin.sh` 不写 pid 文件，`ops_ensure_tbadmin.sh` 只认 pid 文件。用前者启动后，后者会认为两者都缺，再拉一遍：第二个 admin 会在 `zmq_bind` 失败后 `assert(false)` 退出（`admin.cpp:781-785`），第二个 agent 会正常 attach 并**重复向 admin 推送同一批 SHM 数据**（agent 没有单实例锁）。这是“页面偶发重复行/进程数对不上”的一个可解释来源。

### 1.3 进程名与生命周期

- `RunAgent()` 第一行 `prctl(PR_SET_NAME, "AgentLoop")`（`admin.cpp:1520`，V）。
- `RunAdmin()` 第一行 `prctl(PR_SET_NAME, "AdminLoop")`（`admin.cpp:4447`，V）。
- 主循环 `while (m_active)`：`m_active` 是成员默认 `true`（`admin.h:472`），**没有任何代码把它置 false**；因此两个角色都只能被信号杀死，`zmq_ctx_term` 之后的清理代码（`admin.cpp:4525-4529`）实际上不会执行。
- 没有 systemd unit（全库 `find -name '*.service'` 为空，V）；没有 `@reboot`；存活靠 cron 的 `ops_ensure_tbadmin.sh` 与 08:28/08:30 的 `stop_agent.sh`/`start_agent.sh`/`start_admin.sh`（`ops/crontab.txt:917-921`）。
- **重启代价（V+I）**：策略状态、持仓、PnL、挂单、成交、账户、Delta 表全在进程内存；重启后靠 (a) 重读 `tbhft_strategy`、(b) 等 TradeBot 下一次 memlog 推送、(c) agent 的 `cfg/*.dat` 仓位缓存（`admin.cpp:874-886`）恢复。没有 DB 快照，也没有 replay。

### 1.4 生命周期里的三个“静默失效点”

1. **MD 订阅白名单只下发一次**：agent 的 `m_agent_md_filter` 只由 `case 301` 增加（`admin.cpp:2149-2165`），而 admin 只在 `InitStList()` 里对每个策略合约发 `301`（`admin.cpp:644-675`）。PUB/SUB 无重传：如果 agent 还没连上（或刚好重启），这条消息丢失，agent 的过滤器为空，`ProcessMd` 直接 `return`（`admin.cpp:257-258`），**盘口/标的价/Delta 全天为 0**，直到有人在前端重新订阅或 admin 重启。
2. **策略热重载是死代码**：`case 1` 会 `InitStList()`（`admin.cpp:2285-2295`），但前端/运维脚本没有任何地方发 `toadmin|1|`（全库 grep 只命中 admin 自己）。
3. **`clear.sh` 与内存分叉**：15:30 清 `cfg/order_ref.json` 和 `cfg/*.dat`（`ops/crontab.txt:131`），但 admin/agent 仍在跑，内存里的 `m_orderID2ordRef`（`admin.cpp:226-239` → `:867`）与磁盘不一致；下一次重启才对齐。如果 15:30 后立刻重启 agent，`userref` 映射丢失，**当天历史委托的前端回查会错位**。

---

## 2. 端到端数据流

### 2.1 拓扑（单机 190 形态）

```
TradeBot ──write──> SHM 789 (memlog: SlotData ring, 1024 slots)
   │                    │
   │                    └──> tbadmin agent (AgentLoop)  ──ZMQ PUB──> 127.0.0.1:9981
   │                                                                       │
ors_server ─write─> SHM 12289 (ResponseMsg) ──> agent 的 RspShmQ ──┘        │
ors_server ─write─> SHM 4097  (MarketUpdateNew) ──> agent 的 MdShmQ ────────┤
                                                                            ▼
                                                              tbadmin admin (AdminLoop)
                                                              SUB bind 9981 / PUB bind 9980
                                                                            │
                    ┌───────────────────────────────────────────────────────┤
                    ▼                                                       ▼
      message_forwarding.py :8882 (ZMQ SUB 9980)                其它 SUB（脚本/诊断）
      Socket.IO /server /order /md                                        │
                    │                                                     │
                    ▼                                                     ▼
      Vue (tbadmin-front/my-admin) 静态站 :50003            ops_delta_snapshot.py
                    │
                    └──HTTP──> vue3-admin Flask :5004/admin_backend（策略/用户/手工单查询）
                    └──HTTP──> :8882/tbadmin/transmit（命令通道，转成 toadmin|-1|JSON）
```

- ZMQ 端口与方向：admin `PUB bind tcp://*:9980`、`SUB bind tcp://*:9981`（`admin.cpp:737-787`、`:468-523`，V）；agent `PUB connect PUB_ADDR:PUB_PORT`、`SUB connect SUB_ADDR:SUB_PORT`（同两处），仓库配置正好是 agent→9981、admin→9980（`tbadmin/cfg/agent.cfg`、`cfg/admin.cfg`，V）。
- 帧格式：`<topic>|<code>|<payload>`。`Pub()` 在发送前拼 `topic + "|"`（`admin.cpp:427-439`），接收侧 `split(str,'|',2)` 取 `vec[1]` 为 code、`vec[2]` 为 payload（`admin.cpp:2279-2281`、`:1619-1626`）。
- topic 集合：`toagent / toadmin / tofront / tomanage / mdmsg / ordermsg / warnmsg / tosound`（`admin.h:387-394`，V）。
- 编码：payload 是 **protobuf 二进制**（除 `-1` 是 JSON 字符串、以及前端表格是单引号“伪 JSON”字符串）。`Pub` 用 `zmq_send(..., msg.c_str(), msg.size())`，二进制里出现 `|` 也不影响，因为接收端只 split 前两刀（`admin.cpp:431`、`:1619`）。

### 2.2 上行：memlog → agent → admin

`ProcessLog()` 是唯一的 memlog 解码点（`admin.cpp:294-425`，V）：

| memlog `MemLogType` | 生产方（TradeBot） | agent 转发 code | payload | admin 落点 |
|---|---|---|---|---|
| `STRATEGY_STATUS` | `ExecutionStrategy::SendMonitorStratStatus`（`tbsrc/Strategies/ExecutionStrategy.cpp:238-257`） | `2` | `admingpb.StrategyStatusMsg` | `m_controlAux[sid]`（`admin.cpp:2296-2332`） |
| `STRATEGY_DETAIL`（key=="TValue"） | 策略自定义/`ProcessPyBotValue` | 不转发 | — | agent 本地 `m_pymonitor`（`admin.cpp:318-322`、`:1436-1457`） |
| `STRATEGY_DETAIL`（其他） | `SendMonitorStratDetail`（`ExecutionStrategy.cpp:176-200`） | `4` | `StrategyDetail` | `m_controlAux` 的 key/value/info/alert（`admin.cpp:2339-2466`） |
| `PNL` | `SendMonitorStratPNL`（`ExecutionStrategy.cpp:206-226`） | `5` | `StrategyPNL` | `m_controlAux[sid].m_pnl = netpnl`（`admin.cpp:2467-2495`） |
| `POSITION` | `SendMonitorStratPos`（`ExecutionStrategy.cpp:148-174`） | `6` | `Position` | `sid != -99` → `m_position[sid][instr]`；`sid == -99` → `ors_position[product][instr]` + `m_total_position` + `m_rest_position`（`admin.cpp:2496-2593`） |
| `CANCEL_STS` | `SendMonitorStratCancelSts`（`ExecutionStrategy.cpp:259-278`） | `11` | `OrderCancel` | `m_position[sid][instr].orderCnt/cancelCnt`，再按 product 聚合成 `ors_position` 的比率（`admin.cpp:3026-3072`） |
| `ORS_DETAIL` | **只有 tbsrc 的 `msg.h` 有该枚举，tbadmin 未处理**（`C++_deps/hftbase/memlog/include/msg.h:19-26` vs `tbsrc/hftbase/memlog/include/msg.h:20-27`） | — | — | 丢弃（`admin.cpp:395-407` 是注释掉的） |

**memlog 结构体契约（V）**：一槽定长 2048B（`SLOG_DATA_SIZE`），`SlotData{MemLogType type; char data[2048];}`（`C++_deps/hftbase/memlog/include/msg.h:10-30`）。两套 hftbase 的 `msg.h` **不相同**：`tbsrc` 版在 `CANCEL_STS` 之后多一个 `ORS_DETAIL`、并多一个 `ORSDetail` 结构（diff 实测）。当前所有共享枚举值一致（`CANCEL_STS` 都是 5），但**这是一条只能靠“不要在中间插枚举”维持的隐式 ABI**；tbadmin 编译时 include 的是 `C++_deps/hftbase`（`tbadmin/Makefile:4-9`），TradeBot 编译时 include 的是 `tbsrc/hftbase`（`tbsrc/CMakeLists.txt:21-38`），任何人在 `C++_deps` 版中间插一个类型，`ProcessLog` 会把 PnL 当 Position 解，且**不会报错**。

### 2.3 上行：Response SHM → agent → admin

- agent 在 `LoopAllShm()` 里对每个 `m_rsp_q_arr[i]` 取一条 → `ProcessRsp()`（`admin.cpp:4569-4576`）。
- `ProcessRsp()` 把 `illuminati::infra::ResponseMsg` 逐字段抄进 `admingpb.ResponseMsg`：`Response_Type`、`OrderID`、`ErrorCode`、`Quantity`、`Price`、`TimeStamp`、`Side`、`Symbol`、`AccountID`、`ExchangeOrderId→SysId`、`ExchangeTradeId`、`StrategyID`、`Product`、`ExchangeID→Exchange`、`OpenClose→PosDirection`、`Server=LOCAL_IP`、`UserRef=m_orderID2ordRef[OrderID]`（`admin.cpp:222-251`）。
- 然后 `out = "7|" + pb; ToAdmin(out)`（`:249-250`）。
- admin `case 7` 是最大的分支：前端人工单入库、挂单表增删、成交表追加、报单错误告警、以及订单状态到 DB（`admin.cpp:2595-2991`）。

### 2.4 上行：MD SHM → agent → admin → 前端

- agent 每个循环至多取一条 MD：`if (!isEmpty()) ProcessMd(dequeue())`（`admin.cpp:4559-4568`）。
- `ProcessMd` 只转发 `m_feedType == 'W'` 且在 `m_agent_md_filter` 白名单里的合约；按 `m_validBids/m_validAsks` 截断档位，剩余档位填 0（`admin.cpp:252-293`；注释解释了 au2612 出现 118.x 假档位的根因）。
- admin `case 18`：写入 `m_market_datas[instr]` 与 `m_market_cache[instr]`，若该合约在 `m_md_filter_for_order_board` 里就推前端 `mdmsg`（`admin.cpp:3093-3130`）。`m_md_filter_for_order_board` 的来源有两个：`InitStList` 里所有非 `TB_PAIR` 策略的合约（`:642-676`）以及前端 `subscribe`（`:3891-3955`）。

### 2.5 账户（YD）：设计存在，运行时不产生

- `client_yd` 是一个完整的易达 API 回调实现：登录、`notifyCaughtUp` 后 `getExtendedAccount()` 取 `TotalAsset=staticCash+dynamicCash`、`availableCash=useable`（`tbadmin/client_yd.cpp:82-105`、`:159-167`）。
- **但实例化代码整段被注释**（`admin.cpp:788-818`），`clients` map 永远为空，`checkAndExecuteGetAccount()` 的 120 秒轮询因此什么都不做（`admin.cpp:889-915`）。`case 14` 永远收不到消息，`m_account` 永远空（`:3074-3091`）。
- 结论：**YD 账户面板在本仓库的默认构建里是死功能**（V）。要复活只有两条路：取消注释并放 `cfg/file.json`，或改成查 CTP 资金（当前没有实现）。
- 另：`client_yd` 构造函数里硬编码了 `_appID`/`_authCode`（`client_yd.cpp:23`）——安全文档会把它列为必须外置/轮换的项；本文不复述值。

### 2.6 前端出口：谁在什么节奏收到什么

| 出口 | 触发 | 频率 | 证据 |
|---|---|---|---|
| `tofront` `{'StrategyInfo':[...]}` | 空闲循环 + 初始化 | **1 秒**（有消息时被消息处理挤掉） | `admin.cpp:4497-4503`、`:709-710` |
| `tofront` `{'Order':...}` / `{'OrderSymbol':...}` | 新单确认、撤单确认、成交、报单错误 | 事件驱动 | `:2724-2729`、`:2783-2785`、`:2875-2876`、`:2909-2910` |
| `tofront` `{'Fill':...}` `{'FillStrategy':...}` `{'FillSymbol':...}` | 成交 | 事件驱动 | `:2806-2812` |
| `tofront` `{'Position':...}` + `mdmsg` `{'Exposition':...}` | `-99` 仓位消息 | 事件驱动 | `:2580-2588` |
| `tofront` `{'DeltaTables':[...]}` | 期权 Delta 变化 | **≥0.5 秒节流** | `:988-1002` |
| `tofront` `{'PyBotTables':[...]}` | PythonBot 状态变化 | **≥1 秒节流**，进程检查 5 秒 | `:1470-1484`、`:1369-1375` |
| `tofront` `{'Account':...}` | `case 14` | 理论 120 秒，实际永不 | `:889-915` |
| `ordermsg` `{'orderRsp':...}` | 人工单响应 | 事件驱动 | `:2673-2682` |
| `warnmsg` `{'alert2':...}` | 策略 `isAlert` 或报单错误 | 事件驱动，**同策略 60 秒去重** | `:2363-2432`、`:2912-2937` |
| `tofront` `{'alert1':...}` | 成交 | 事件驱动（前端播提示音） | `:2814-2825` |
| `tomanage` `{'strategyRsp':...}` | 策略增改结果 / 3 秒超时 | 事件驱动 | `:3171-3175`、`:4486-4490` |
| `tofront` `{'opRsp':...}` | 启停/杀进程结果 | 事件驱动 | `:3202-3206` |
| `optmsg` `"opt"` | 策略变更后 | 事件驱动 | `:3181` |

> **注意**：`strategyRsp` 与 `optmsg` 在 190 的 forwarder 里**没有订阅**（见 §5.5），所以上表最后两行在 190 上到不了浏览器。

---

## 3. 职责边界：谁是实时、谁是轮询、谁在计算

### 3.1 admin vs agent

| 维度 | agent | admin |
|---|---|---|
| 模式常量 | `AGENT_MODE 0`（`admin.h:23`） | `ADMIN_MODE 1`（`admin.h:24`） |
| ZMQ | PUB connect / SUB connect（`admin.cpp:771-778`、`:515-522`） | PUB bind `*:9980` / SUB bind `*:9981`（`:779-786`、`:507-514`） |
| 读 SHM | memlog / MD / Response / Request（`Init()` + `LoopAllShm`） | **不读任何 SHM** |
| 写 DB | 只读：core 占用、交易时段、`tbadmin_position` 初始化（`initialize()`） | 读写：策略 CRUD、人工单、人工仓、`tbhft_product` |
| 写文件 | `cfg/order_ref.json`、`cfg/*.dat`（`admin.cpp:2236-2239`、`:390-391`） | 无（策略文件由 agent 写） |
| 对外 | 只对 admin 说话 | 对前端、对 agent、对 DB |
| 状态 | 无长活业务状态（除 pybot 缓存） | **全部业务状态都在这里** |

**边界的关键含义（V）**：agent 是“多机部署”遗迹——每台策略机一个 agent，中心一台 admin。190 单机部署把两者放同一台，于是 9980/9981 全在 `127.0.0.1`（`cfg/agent.cfg`、`cfg/admin.cfg`）。这也意味着**agent 的“远端命令执行”能力在单机形态下等价于本机 shell**，风险不会因为“只是监控”而降低。

### 3.2 实时 vs 轮询

| 数据 | 机制 | 周期 | 失效表现 |
|---|---|---|---|
| 策略状态/明细/PnL/仓位/撤单计数 | memlog 推送 | 由策略决定（通常 init + 每次状态变化） | 丢消息即永久旧值 |
| 挂单/成交/报单错误 | Response SHM 推送 | 事件 | 丢消息即漏单 |
| 行情 | MD SHM 推送 | tick | 过滤器为空则全 0 |
| 策略清单 | **DB 读取（启动时一次）** | 一次性 + 1 秒重发内存快照 | 新策略不出现，直到重启 |
| 人工仓 | DB 读取（启动时一次） | 一次性 | 之后不再刷新（见 §3.4） |
| 账户 | YD 回调轮询 | 120 秒 | 功能未接线 |
| PythonBot 进程 | `ps -ef \| grep PythonBot` | 5 秒 | 只监控 `./py/<sid>.json` 里登记过的 sid；没有 json 就整表为空 |
| Delta 表 | 内存 + 行情驱动 | ≥0.5 秒 | 无标的行情则 Delta 不更新 |
| 孤儿请求 | `m_req_time` 超时扫描 | 3 秒（仅在循环空闲时执行） | 忙碌时超时提示延后 |

### 3.3 计算 vs 转发

**纯转发**：`StrategyInfo`（从 DB 抄）、`Order`、`Fill`、`Position`（策略仓，fir/sec）、`PNL`（只取 netpnl）、`OrderCancel`（策略级原始计数）、`MdMsg`。

**admin 计算**：
1. **人工仓/总仓/剩余仓**：`m_total_position = ors_position`，`m_rest_position = total - manual`（`admin.cpp:1229-1294`）。
2. **product 级撤单率**：把同一 product+instrument 下所有策略的 `orderCnt/cancelCnt` 求和写进 `ors_position`（`admin.cpp:3047-3071`）。
3. **期权 Delta**：Black-Scholes delta（`tb_utils.h:97-110`），`SymbolDelta = Delta * Pos`，按 `(product, variety)` 分组求和 `GroupDelta`（`admin.h:227-231`、`admin.cpp:1070-1114`）。虚拟期权从模型文件行解析（`admin.cpp:1004-1068`）。
4. **CPU 核分配**：从 `tbhft_strategy.core` + `tbors_core.corestr` 建已用集合，新增策略时从 `hardware_concurrency()-1` 往下找 ≥10 的空闲核（`admin.cpp:819-846`、`:1757-1798`）。
5. **交易时段**：从 `tbtrade_sections` 读出，按 09/13/21 点前缀映射成 day_start/day_end/night_start/night_end，写进 control 文件的时段字段（`admin.cpp:847-859`、`:1700-1728`）。
6. **策略文件生成**：config / StrategyConfig / start/stop 脚本 / control / model / option 参数（`admin.cpp:1729-2056`）。这是 admin 唯一“写实盘输入”的地方，风险最高。
7. **告警去重**：同 sid 60 秒（`admin.cpp:2912-2937`）；报单错误另有 300 秒抑制（`:2896-2908`，注意这段 `return` 在循环里会**直接退出整个 `ProcessStr`**，后续订单处理被跳过——见 §8.6）。

**admin 不做**：不做风控、不做仓位限制、不做 PnL 校验、不做订单状态机对账、不落任何历史快照。

### 3.4 手工仓的断链（重要）

- 手工成交只认 `fill->StrategyID == TSLINKER_STRATEGY_ID == 0`（`admin.h:27`、`admin.cpp:1160-1161`）。
- 前端应急交易的报单固定 `strategyID = WEB_STRATEGY_ID = -1`（`admin.h:26`、`admin.cpp:3744`、`:3787`、`:3818`）。
- 因此 **Web 人工单成交永远不会更新 `m_manual_position` / `tbadmin_position`**（V）。`UpdateManualPosition` 的调用点在 `case 7` 的 TRADE_CONFIRM 分支（`admin.cpp:2878`），进去后第一行就 return。
- 结论：`tbadmin_position` 的 `MANUAL` 行只会在启动时被读一次（`admin.cpp:1116-1153`），之后只能靠旧的 tslinker（strategyID=0）驱动。复刻时要么把常量改成 -1，要么统一“人工单 sid”的定义。

### 3.5 `-99` ORS 仓位的断链（重要）

- `case 6` 里 `strategyid == -99` 走 ORS 仓位分支，并额外用未成交挂单修正 `buyTotalQty/sellTotalQty`（`admin.cpp:2512-2591`）。
- `dumpPosition()` 只遍历 `ors_position`（`admin.cpp:4223-4245`），前端 `Position` 表就吃这一份（`tbcheck/index.vue:615-618`）。
- 全仓库唯一写 `-99` 的地方是测试工具 `tbadmin/testmemlog/main.cpp:106-158`；`ors/` 目录完全没有 memlog 写入代码（`grep -rn "memlog|MemLogType" ors` 为空，V）。
- 因此在本仓库的 190 链路上：**Position 页、Exposition（total/manual/rest）、期权 Delta 的 `Pos` 都拿不到真实数据**。除非另有一个仓库外的 ORS 侧 agent 在写 `-99`（旧系统是 tslinker 干的，已排除）。

---

## 4. 策略表同步（`tbhft_strategy`）

### 4.1 任务定义

- 脚本：`tools/strategy_sync/sync_tbhft_strategy.py`（353 行，V）。
- 源：阿里云 RDS `appdb.public.tbhft_strategy`；目标：190 本机 `dbtrade.tbhft_strategy`（`README.md:3-6`、脚本 docstring `:4-20`）。
- 只能跑在 190：本机 PG 只监听 127.0.0.1（`README.md:7`，V/I）。
- cron：`30 10,20 * * 1-5 flock -n /tmp/strategy_sync.lock python3 .../sync_tbhft_strategy.py --apply`（`ops/crontab.txt:67`，V）。10:30/20:30 的选择理由写在 README：RDS 观察到的刷新时间是每日 10:05（`README.md:47-50`）。
- 配置：`/root/.quantlink/strategy_sync.env`（600，不进 git；模板 `tools/strategy_sync/strategy_sync.env.template`）；状态：`/root/.quantlink/strategy_sync_state.json`（脚本 `:29-30`）。
- 单测：`tools/strategy_sync/test_sync_tbhft_strategy.py`（3 个测试类、6 个用例，V）。

### 4.2 算法（可直接照抄的部分）

```
rds_rows[ id ]  ← SELECT 22 列 + imported_at
local_rows[id]  ← SELECT 22 列
batch           = max(imported_at)

first_run       = (state is None)
synced_before   = (local ∩ rds)  if first_run else set(state.synced_ids)

inserts   = rds - local
deletes   = (synced_before ∩ local) - rds      # 只删“我们同步过、现在源没了”的行
collisions= (rds ∩ local) - synced_before      # 本地手工建的行撞了 RDS 新 id
updates   = 两边都有、非 collision、逐列比较有差异
local_only= local - rds - deletes              # 永不动
```

- **V** `sync_tbhft_strategy.py:135-169`。列清单在 `:37-43`（22 列，`CONTENT_COLUMNS` 去掉 `id`）。
- 类型归一：RDS 文本列 → int，接受 `"3"`/`"3.0"`，拒绝 `"1.5"`/`"abc"`（`:92-107`）。
- `server` 字段强制改写为 `SERVER_OVERRIDE`（默认 `127.0.0.1`，`:110-123`、模板 `:60`）——这是“RDS 是逻辑配置、190 是物理位置”的解耦点。
- 空串与 NULL 视为相等，避免无意义 update（`:126-132`）。

### 4.3 写库与冲突处理

| 情况 | 行为 | 证据 |
|---|---|---|
| 有 insert/update/delete | 单事务内：`CREATE TABLE tbhft_strategy_bak_sync_<ts> AS SELECT *` → DELETE → UPDATE → INSERT → `setval(seq, GREATEST(max(id), last_value))` → 清理旧备份（保留 `BACKUP_KEEP=10`） | `:204-239` |
| 存在 id 冲突 | **不写库，退出码 2**，打印冲突行 | `:314-316` |
| RDS 批次未变 | `--apply` 跳过写库（`--force` 强制） | `:318-320` |
| 写后校验 | 本地 id 集合必须等于 `synced_ids ∪ local_only`，否则报错并提示用备份表恢复（退出码 1） | `:324-330` |
| 序列 | 无论有无数据变更都修正序列；`setval` 不受事务回滚影响，所以只往大调 | `:229-231`、`README.md:67-70` |

**为什么这个设计是对的（V/I）**：它把“源端删除”和“本地新建”区分开了。没有 state 文件的第一次运行会**禁用删除检测**（`synced_before = local ∩ rds`），避免把本地独有策略误删；这是唯一安全的冷启动语义。

**同步后必须重启 admin**（V）：脚本末尾自己打印“tbadmin admin 启动时读取策略表，需重启 admin”（`:348`），README 也重复（`README.md:43-44`）。cron 用 08:28 stop → 08:30 start 实现（`ops/crontab.txt:917-921`），夜盘那组已被 `[night-off 2026-11-04]` 注释（`:128-130`、`:926-929`）。

### 4.4 `tbhft_strategy` 的字段语义（跨三套代码）

| 列 | 含义 | C++ 用法 | Flask 模型 | 备注 |
|---|---|---|---|---|
| `id` | 自增主键（同步键） | `rsp.dbid`、`where id=` | PK | RDS 与本地共用同一 id 空间（冲突检测的前提） |
| `sid` | 策略号 | control 文件名、`--strategyID` | 普通列 | 一个 sid 可有多行（parent/子策略、OptionManage） |
| `parent` | 0=主策略，>0=子策略 | `aux_id = -1000*sid + n`（`admin.cpp:679-685`） | int | 子策略用负数 key 区分 |
| `type` | 策略类型字符串 | 生成 control/脚本；`TB_PAIR`/`OptionManage`/`MMF` 分支 | String(20) | 分支逻辑硬编码字符串匹配 |
| `active` | 是否启用 | `where active=1`（`admin.cpp:597`） | int | 1 启用 / 0 停用 |
| `status` | 自动/手动 | 原样透传 | int | `1: auto, 0: manual`（前端注释 `admin.cpp:3308`） |
| `core` | 绑核 | 0=重分配，-2=不绑，>0=指定 | int | 与 `tbors_core.corestr` 一起去重 |
| `corebind` | 是否允许绑核 | 0/1/-1 | int | 前端 `corebind`（`admin.cpp:3311`） |
| `ref` | 参考策略 + 释放的核 | `"0"` 或 `sid`，停用时追加 `,<core>`（`admin.cpp:3523`） | **Integer** | **类型冲突**：C++ 会写 `"12,3"`，Flask 模型声明 Integer（`vue3-admin/back_end/server/models.py:337`），SQL 会报错（见 §8.4） |
| `path` | 产品部署目录 | 生成文件根 | String | 190 被硬编码成 `/root/quantlink-trading/deploy_cpp`（`admin.cpp:3250`、`:3403`） |
| `server` | 归属机器 | 与 `LOCAL_IP` 全等比较 | String(20) | **三种写法混用**，见 §4.5 |
| `modelfile/modeldetail` | 模型文件名/内容 | 写 `models/`，同时把内容存库 | String | 内容里带换行，SQL 拼接高危 |
| `posfile/posdetail` | 仓位文件名/内容 | 写 `position/` 或 `daily_init.<sid>` | String | 同上 |
| `optfile/optdetail` | 期权参数 | `OptionManage` 用 | String | 同上 |

### 4.5 `server` 字段的三种写法（真实的配置坑）

1. `agent.cfg` 的 `LOCAL_IP=127.0.0.1`（`tbadmin/cfg/agent.cfg`，V）。
2. `strategy_sync` 把 RDS 的 `server` 统一改写成 `127.0.0.1`（`sync_tbhft_strategy.py:120`，V）。
3. 前端新增策略时，admin 把 `server` 取 **IP 最后一段**：`server = split(server, '.').back()`（`admin.cpp:3296-3297`，V）；`product` 消息同样（`:3241-3242`）。

于是 UI 新建的策略在库里是 IP 最后一段（`101.43.54.190` → `190`，`127.0.0.1` → `1`），而 agent 判断 `m_st.server() == m_local_ip`（`admin.cpp:1671`）要求 `'127.0.0.1'` → **不会部署任何文件**，而且 `case 21` 仍会返回成功。反过来，`operation` 分支不做 `.back()`（`admin.cpp:3652-3656`），原样使用前端传来的值：如果前端从库里读到 `190` 就传 `190`，能对得上；读到 `127.0.0.1` 就传 `127.0.0.1`，也对得上。**唯一稳定错位的是“写路径”（新建/编辑时被截断）与 `LOCAL_IP` 的比较**。复刻时必须统一成一个 canonical server id（建议用主机名/短码，不要用 IP，也不要用“最后一段”）。

### 4.6 同步工具的已知边界

- **备份表会一直在 `public` schema 里堆积**：只按 `BACKUP_KEEP` 清理自己前缀的表（`:233-237`），但每张表都是全表拷贝；`tbhft_strategy` 不大（几十行），可接受（V/I）。
- **状态文件丢失 = 删除检测失效一次**（`:143-144`）：不会误删，但源端已删的行会永远留在本地，直到下一次有 state。
- **回滚后必须删 state 文件**，否则下一次同步会按回滚前的 id 集合判删除（`README.md:65`）。
- **`imported_at` 是批次键**：RDS 若在 10:05 刷新但 `imported_at` 没变（例如手工 UPDATE），`--apply` 会跳过；此时用 `--force`（`:318-320`）。
- **不校验业务合法性**：不检查 `parent` 是否存在、`type` 是否可识别、`instrument` 是否能解析成合约。坏行会原样进 190，然后在 admin 生成 control 文件时炸（或静默生成错文件）。

### 4.7 从一行 `tbhft_strategy` 到可启动的进程（control/model/config 生成）

> 这一段是 `case 102` 的全部产物（`admin.cpp:1667-2063`，V）。它是“一策略一进程”部署事实的实现处；同步工具只负责搬这一行，真正的落地在这里。

目标目录：`path`（190 固定 `/root/quantlink-trading/deploy_cpp`，`admin.cpp:3250`、`:3403`），agent 先建目录树（`/data /position /position/bak /bin/{log,models,models/bak,scripts,controls/{day,night,am,pm},config}`，`:1638-1643`），再把 `deploy_cpp/bin/TradeBot` 拷进 `<path>/bin`（`:1647`）。

| 产物 | 路径 | 内容/规则 | 证据 |
|---|---|---|---|
| 模型文件 | `<path>/bin/models/<modelfile>` | 直接把 `modeldetail` 原文写盘；`OptionManage` 时写 `" "` | `:1730-1736`、`:3417-3423` |
| 仓位文件 | `<path>/position/<posfile>`；`TB_PAIR` 用 `<path>/data/daily_init.<sid>` | `posdetail` 原文；parent 子策略用 `<sid>.<instrument>` | `:1738-1745`、`:3426-3434` |
| 运行配置 | `<path>/bin/config/config_CHINA.<sid>.cfg` | SHM key 来自 `tbhft_product`（client/monitor/orsreq/orsrsp/md），`MDSHMSIZE/ORSREQUESTSHMSIZE/ORSRESPONSESHMSIZE=100000`，`PRODUCT=<product>`，`EXCHANGES=CHINA_<exchange>`；`MMF` 类型额外带 `DSN=` | `:1747-1819` |
| 策略公共配置 | `<path>/bin/config/StrategyConfig.cfg` | `ACCOUNT=OWN / MAX_POS_SIZE=1000 / MAX_ORDERS=5000 / LOGGER_THREAD_CPU_AFFINITY=0 / DSN=` | `:1822-1828` |
| 启停薄壳 | `<path>/bin/tbstart.<sid>.sh`、`tbstop.<sid>.sh` | 只调 PATH 里的 `tbstart <sid>` / `tbstop <sid>`（即 `kill -10` / `kill -20` 的 shim） | `:1830-1847` |
| 日盘/夜盘 control | `<path>/bin/controls/{day,night}/control.<type>.<sid>` | 一行：`<instrument> <model_name> <exchange> 16 <type> <start> <end> <instrument2>`；`REPO` 类型强制 `end=0730` | `:2027-2035`、`:2029-2030` |
| 启动脚本 | `<path>/bin/start.<section>.<sid>.sh` | `ulimit -c unlimited` → `sysctl core_pattern` → **`ps aux \| grep -w TradeBot \| grep -w <sid> \| xargs kill -9`** → `nohup ./TradeBot --Live --controlFile ... --strategyID <sid> [--refStrategyID <ref>] --configFile ... --adjustLTP 1 --printMod 1 --updateInterval 300000 --logFile <log> >> nohup.out.<sid>` | `:2037-2054` |
| OptionManage 主 control | `controls/<section>/control.OptionManage.<sid>` | 先 kill 同 sid，再 `--optionStrategy 1 --optionParams ../data/OptionsParams.<sid> --controlList <主 control>`；主 control 里逐行列出子/报价/对冲/dummy control | `:1863-1884`、`:1894-2023` |
| 子策略 control | `controls/<section>/control.<type>.<instrument>.<sid>` | `16` 是固定字段（数量级/权限位，原样照抄）；`parent>0` 时 instrument/instrument2 从 model 第一/第二行解析 | `:1885-1893`、`:3333-3346` |
| dummy 模型/control | `models/model.dummy.<tb_contract>`、`controls/.../control.dummy.<tb_contract>.<sid>` | 给 OptionManage 补齐每个标的期货腿，`15 DUMMY_STRAT` | `:1966-1979` |
| 期权参数 | `<path>/data/OptionsParams.<sid>`（部署时先清空 `<path>/data/OptionsParams`） | `optdetail` 原文 | `:1653-1655`、`:1866-1872` |

**两个必须知道的实现细节**：

1. **启动脚本会先杀同 sid 的进程**（`kill -9`），这是“重新拉起”而不是“热加载”；`operation action=2` 在 190 上又改成调用 `bin/scripts/start_strategy.sh`（`admin.cpp:3673-3676`），**仓库里没有这个脚本**（`deploy_cpp/bin/scripts/` 是构建产物，V/I）。复刻时必须自己提供等价物，否则 UI 的“拉起”按钮在 190 上是空操作。
2. **`16` 是硬编码**（`:1888`、`:2031`）。它对应 TradeBot control 行格式里的字段位；换 TradeBot 版本必须核对（`docs/STARTUP_GUIDE.md` 的 control 说明也只写“16”）。
3. **`StrategyConfig.cfg` 没有 sid 后缀**（`:1826`），190 上所有策略共用 `<path>/bin/config/StrategyConfig.cfg`。每次新建/修改策略都会覆盖它，**最后一个写入的策略的 `ACCOUNT/MAX_POS_SIZE/MAX_ORDERS/DSN` 成为所有策略的值**。多策略单实例部署时这是一个确定的串味点（V）；除非 TradeBot 启动时另有覆盖，否则必须改成 per-sid 文件。

---

## 5. 前端：`tbadmin-front/my-admin` 与 `vue3-admin`

### 5.1 两个前端的关系（先厘清，避免“以为有两个系统”）

| 目录 | 是什么 | 状态 | 证据 |
|---|---|---|---|
| `tbadmin-front/my-admin/` | Vue 3 + Vite + Element Plus **源码**，base `/`，dev 端口 50003 | **当前源码**（有 190 适配注释、全新 dashboard） | `package.json:1-37`、`vite.config.js:5-20`、`tbcheck/index.vue:742-748` 的“未配置就跳过”注释 |
| `tbadmin-front/.env.*` | 父目录的旧环境文件，指向 `amois.intranet.citicsf.com` / `172.31.152.132:81` | **历史**，Vite 只读 `my-admin/.env.*` | `tbadmin-front/.env.production2:10`（V） |
| `tbadmin-front/my-admin/.env.development` | `VITE_BASE_URL=http://101.43.54.190:5004/admin_backend`、`VITE_BASE_WEB_SOCKET_URL=http://101.43.54.190:8882`、`VITE_TBADMIN_URL=...:8882` | **190 部署实际用的**（注意：文件名是 development） | `.env.development:10-15`（V） |
| `vue3-admin/frontend/dist/` | 旧前端**构建产物**（base `/admin/`，28 个 assets），无源码 | **遗留**（源码就是 my-admin 的旧版本） | `dist/index.html:4-9`（V） |
| `vue3-admin/back_end/` | Flask + SQLAlchemy 后端，78 个 HTTP 路由，`BASE_URL=/admin_backend` | **在用的 HTTP API**（190 上 uwsgi :5004 / 直跑） | `runserver.py:1-40`、`uwsgi_conf.ini:1-10`、`server/config.py:37`（V） |
| `vue3-admin/back_end/message_forwarding/` | 旧版 Socket.IO 转发器（多 namespace：`/server /md /order /manage /ts_order /ts_sec_order /md_ts`）+ Redis + 旧内网 ZMQ 地址 | **遗留**（`admin_rcv=tcp://172.31.124.6:10982`） | `message_forwarding/config.py:15-17`、`message_forwarding.py:30-41`（V） |
| `tbadmin-py/new/message_forwarding/` | 精简版转发器（只 `/server /md /order`，ZMQ `127.0.0.1:9980/9981`，Flask-SocketIO :8882） | **190 当前在用** | `message_forwarding.py:17-24`、`:150-153`；`ops/crontab.txt:208-209`（V） |
| `tbadmin-py/admin_backend/` | FastAPI 半成品，`admin_db`，只实现 P0（用户增删改 + 产品/策略查询） | **并行/实验**，crontab 说在用，但与前端 env 不匹配（见 §5.5） | `admin_backend/README.md:1-40`、`main.py:1-40`（V/I） |

**一句话**：源码在 `tbadmin-front/my-admin`，HTTP 在 `vue3-admin/back_end`，实时在 `tbadmin-py/new/message_forwarding`，静态站在 `ops/nginx/quantlink-admin.conf`（:50003）。`vue3-admin/frontend/dist` 是旧包，`vue3-admin/back_end/message_forwarding` 是旧实时层。

### 5.2 页面/路由清单（`tbadmin-front/my-admin`）

`src/router/models/nested.js`（V）：

| 路由 | 页面 | 干什么 | 数据来源 |
|---|---|---|---|
| `/dashboard` | `views/dashboard/index.vue` | KPI（策略/挂单/成交/告警）+ 入口卡片 | Socket.IO `toadmin\|8\|` 快照 + 增量 |
| `/product_management/check` | `views/tbcheck/index.vue` | **主监控页**：KPI、策略表、挂单、成交、持仓、账户、期权、PyBot、Spread | Socket.IO `/server` + `/md` + `/order` |
| `/product_management/config` | `views/tbcheck/config/index.vue` | 策略增删改、模型/仓位文本编辑 | HTTP `getOneStrategy` + `transmit` |
| `/product_management/transaction` | `views/tbcheck/transaction/index.vue` | **应急交易**：报单/撤单/盘口/持仓 | `transmit` + `tbhftManOrder/getOrder` |
| `/risk_management/...` | `views/nested/risk/*` | 风控规则/产品配置/操作日志 | Flask `tbrisk/tbproduct_risk/tbunit_risk/risk_edit_log` |
| `/ts/...` | `views/ts/*` | 期货/股票/期权/多产品交易（旧业务） | Flask `tsorder/tscommon/tsstrategy` + `/tbadmin/tstransmit`、`/sptransmit` |
| `/user/...` | `views/user/*` | 用户管理 | Flask `user/tbuser` |
| `/trader_management` | `views/nested/trader/TraderPage.vue` | 测试页 | — |

`tbcheck/index.vue` 的表格组件：`product.vue`（策略）、`orders.vue`（挂单）、`fills.vue`（成交）、`position.vue`（持仓）、`account.vue`、`option.vue`（Delta）、`pyBotTables.vue`、`spreadTrades.vue`（V，目录 `views/tbcheck/indexTable/`）。

### 5.3 前端与后端的接口面

**实时（Socket.IO，`:8882`）**
- 连接：`socketIO(VITE_BASE_WEB_SOCKET_URL + "/server")`（`tbcheck/index.vue:452`、`:456-460`）。
- 连上后立刻发 `"toadmin|8|"` 要全量快照（`:460`）；`dashboard` 同样（`dashboard/index.vue:153`）。
- 收：`ws.on("server_message", ...)`（`:678-680`），`analyticMsg()` 按 key 分发：`StrategyInfo / PyBotTables / Fill / Order / Position / Spread / DeltaTables / StrategyinfoProduct / SpreadModel / OrderModel / OrderSymbol / FillSymbol / FillStrategy / alert1 / alert2 / opRsp`（`:588-676`）。
- 发：`ws.emit("client_message", "toadmin|8|")`（唯一的 socket 发送；报单不走 socket，走 HTTP）。
- 第二路 WebSocket：`VITE_BASE_WEB_SOCKET2_URL + "/on_table_msg/"`，只处理 `AccountTable`（`:738-780`）。**Flask 后端没有这个路由**（`server/api/other_function.py` 只有 `judgePathExist`/`generateCsv`，V），所以在配了 `production2` 的环境里必然是 404 + 账户表空。

**命令通道（HTTP，`:8882`）**
- `transmit(data)` → `POST /tbadmin/transmit`（`api/tbcheck_config.js:6-9`），body 是 form-urlencoded，转成 `toadmin|-1|<json>`（`message_forwarding.py:109-133`）。
- 旧的 `/tbadmin/tstransmit`、`/tbadmin/sptransmit` 只在旧 forwarder 里有（`vue3-admin/back_end/message_forwarding/message_forwarding.py:636`、`:746`）→ **`/ts/*` 页面在 190 上不可用**（V）。

**查询（HTTP，`:5004/admin_backend`）**
- 策略：`/strategy/getAllsids|getAllStrategies|getOneStrategy|getOneStrategyById|getPosDetail|getModelDetail|getAllStrategyType|getStrategySelect`（`vue3-admin/back_end/server/api/tbhft_strategy.py:9-127`）。
- 人工单：`/tbhftManOrder/getOrder`（`tbhft_man_order.py:10`）——按 `trading_day_begin` 过滤、只取 `status in (0,1,2,5)`、每个 `order_id` 取 `MAX(id)`（`:20-55`）。
- 其余：`tsorder` 13 个、`tbuser` 11 个、`user` 6 个、`instrument_info` 6 个、风控 15 个、`otherFunction` 2 个……共 78 个（`grep -c "@.*\.route"`，V）。

### 5.4 前端可见的“操作 → 消息 → 执行”映射

| UI 动作 | 发出的 JSON | admin 分支 | 最终动作 |
|---|---|---|---|
| 策略保存/新增 | `{msgtype:"strategy", action:1, sid, type, product, modeldetail, ...}` | `-1` → `strategy`（`admin.cpp:3282-3599`） | 写 `tbhft_strategy`（SQL 回传）+ `ToAgent 102` 生成文件 |
| 策略删除 | `{msgtype:"strategy", action:0, id}` | 同上（`:3600-3633`） | `DELETE FROM tbhft_strategy` |
| 清除告警 | `{msgtype:"refresh", strategyid}` | `:3635-3649` | 清 `m_controlAux.m_alert` 并重推 |
| 重新拉起（跑 start 脚本） | `{msgtype:"operation", action:2, strategyid, server}` | `:3659-3678` | `cd <path>/bin; bash scripts/start_strategy.sh <sid> <day\|night>` |
| tbstart（激活） | `action:3` | `:3679-3682` | `kill -10`（SIGUSR1） |
| tbstop（平仓停用） | `action:4` | `:3683-3686` | `kill -20`（SIGTSTP） |
| 杀进程 | `action:5` | `:3687-3690` | `kill -9` |
| 热重载参数 | `action:6` | `:3691-3694` | `kill -12`（SIGUSR2） |
| 批量停止 | `{msgtype:"batchOp", action:4, stop_st:"[...]"}` | `:3701-3737` | 对每个 `{ip,sid}` 发 `103` |
| 报单 | `{msgtype:"orderReq", action:1, product, exchange, ip, instrument_id, qty, price, buy_sell, Duration}` | `:3738-3803` | `ToAgent 201` → `send_new_order` |
| 撤单 | `{msgtype:"orderReq", action:2, orderID, InstrumentID, ...}` | `:3805-3827` | `ToAgent 201` → `send_cancel_order` |
| 批量撤单 | `{msgtype:"batchReq", action:2, cxl_orders:"[...]"}` | `:3840-3890` | 逐条 `201` |
| 订阅盘口 | `{msgtype:"subscribe", action:1, instrument, exchange, product, server}` | `:3891-3955` | 推缓存 + `ToAgent 301` 加白名单 |
| 取消订阅 | `action:2` | `:3950-3953` | 只从 admin 的 `m_md_filter_for_order_board` 删除，**不通知 agent**（白名单泄漏） |

前端源码坐标：报单 `transaction/index.vue:948-966`、撤单 `:946-955`、订阅 `:878-889`、`ex_position` `:872`、策略操作 `product.vue:621-686`、批量停止 `:600-613`。

### 5.5 前端/后端错配清单（V）

1. **策略保存结果不可见**：`strategyRsp` 发 `tomanage`（`admin.cpp:3174`、`:4489`），190 forwarder 未订阅 `tomanage`（`message_forwarding.py:20`）→ 前端 `config/index.vue:1213-1228` 的“修改成功/失败”永远不触发。旧 forwarder 订阅了 `tomanage`（`vue3-admin/.../message_forwarding.py:36-41`），但连的是旧内网（`:15-17`）。
2. **账户页三处断**：YD 未接线（§2.5）+ `case 14` 无源 + 前端把 `msg.Account` 注释（`tbcheck/index.vue:596-599`）+ 第二路 WS 路由不存在（`:738-780`）。`account.vue` 只可能显示 `total_accounts`，而它只由第二路 WS 填。
3. **`/ts/*` 页不可用**：`tstransmit/sptransmit` 只在旧 forwarder。
4. **两套后端并存**：`admin_backend`（FastAPI，`admin_db`，无 `/admin_backend` 前缀）与 Flask（`admin_db`+`dbtrade`，有前缀）。前端 env 指向 Flask 前缀，所以 FastAPI 只能被直接访问，不能被本前端使用（除非改 `VITE_BASE_URL`）。
5. **`.env.development` 承担生产角色**：190 的地址写在 development 档里，`npm run build:prod` 会打出旧内网地址。部署脚本/文档没有说明这一点（`start_tbadmin.sh:85-88` 只打印地址）。

### 5.6 构建/运行

```bash
# 前端（源码）
cd tbadmin-front/my-admin
npm install
npm run dev        # Vite :50003，base '/'，直连 .env.development 的 190 地址
npm run build:dev  # 产物给 190 用（因为 190 地址在 development 档）
npm run build:prod # 产物指向 amois.intranet（旧内网）
```

- **V** `package.json:6-13`、`vite.config.js:5-20`。`base:'/'`，所以 nginx 直接挂在 `/`；旧 `vue3-admin/frontend/dist` 的 `base` 是 `/admin/`（`dist/index.html:4-9`），两者不能互换。
- nginx：`listen 50003`、`root /var/www/quantlink-admin`、`/index.html` 不缓存、`/assets/` 7 天 immutable（`ops/nginx/quantlink-admin.conf:1-24`，V）。**注意：这份 nginx 不代理 `/tbadmin/transmit` 也不代理 `/admin_backend`**，所以跨端口全靠前端 env 里的绝对 URL；生产如果同源部署，必须在仓库外另加 proxy（I）。
- 旧 Flask 后端：`uwsgi --ini uwsgi_conf.ini`，`http=127.0.0.1:5004`，`processes=1 threads=1`（`vue3-admin/back_end/uwsgi_conf.ini:1-11`，V）。单进程单线程 + SQLAlchemy 连接池 5（`server/config.py:24-30`），并发能力很低。
- `start_tbadmin.sh` 是 190 的事实启动顺序（admin → agent → forwarder → Flask），但它绕过了 pid 文件（§1.2）。

---

## 6. `tbadmin-py`：逐个子包定性（当前 / 退役 / 危险）

> 判定规则：**当前** = 在 190 有启动入口或 crontab/脚本引用；**退役** = `ops/crontab.txt` 明示退役或指向旧机房；**危险** = 能连旧库/写共享盘/执行远端起进程，误跑会造成副作用。
> 关键证据：`ops/crontab.txt:12-16`（总述）、`:172-209`（7 件退役 + 2 件仍在用）、`:340-350`（旧名映射）。**活动 crontab 里没有任何 tbadmin-py 任务**（grep 全文件，V）。

| 子包 | 是什么 | 判定 | 证据/理由 |
|---|---|---|---|
| `new/message_forwarding/` | Flask + Socket.IO :8882，ZMQ 9980 收 / 9981 发 | **当前** | `message_forwarding.py:17-24`、`:150-153`；crontab `:208-209` 明示在用；`start_tbadmin.sh:44-49` 启动 |
| `admin_backend/` | FastAPI :8000，`admin_db`，P0 用户增删改 + 产品/策略查询 | **当前（但半成品）** | crontab `:208-209` 明示在用；`README.md:7-32` 只列 P0、其余标“未实现”，`main.py:1-40` 自述“本地模式跳过真实鉴权” |
| `check_PB/` | 逐策略 TradeBot 进程看护 + 企微告警 | **退役（功能本身是好的）** | crontab `:172-205` 把它列进 7 件退役，同时更正“它是好的”；代码已适配 190 库与 `deploy_cpp/bin/config`（`check_PB.py:16-45`） |
| `check_before_running/` | 开盘前体检（tbadmin/内存/SHM/柜台端口/网关） | **退役** | crontab `:177-193`；已把 `/mnt/hft`、counter 检查置空（`check_status.py:145-146`） |
| `check_core/` | CPU 绑核唯一性 | **退役** | crontab `:191`（职能被 `ops_setup_arbi.sh` 覆盖）；`white_list.txt` 缺失（`:177-179`） |
| `check_file_update/` | `cp_fee.py` master→slave 分发 + 文件时效检查 | **退役 / 危险** | `cp_fee.py` 是旧 master/slave 架构（crontab `:307-320` 详解）；`check_files_update.py:12` 读 `/mnt/hft/...`，该挂载在 190 不存在 |
| `check_server_port/` | 一批旧内网 IP 的 22 端口探活 | **退役 / 危险** | `check_server_port.py:15` 硬编码旧库 `172.31.37.238:5435`；`config.json`（**已入 git**）含 9 个旧内网 IP 与一个企微 webhook；与 190 无关 |
| `exposure_monitor/` | C++ 写的独立持仓对账（YD 数据源） | **退役 / 危险** | crontab `:186-206`：缺配置、未编译、YD 源已不存在；源码保留作算法参考 |
| `hft_control/` | 按 `tbhft_schedule/tbhft_action` 定时发激活/停用信号 | **退役 / 危险** | `hft_control/hft_control.py` 用 schedule 循环 + `tbhft_schedule`；crontab `:178` 记“缺 log/”；`ops/db/hft_control_tables.sql:1-4` 明确要求这三张表**保持空表**（空表=不发任何盘中信号） |
| `riskManage/` | 旧风控控制（ZMQ 6666、Redis、GZ 主机） | **退役 / 危险** | `riskControl.py:29-48`、`:140` 全是旧内网地址；无 190 适配 |
| `tbadmin_check/` | `tbporcess_wx.py` 进程告警 + `tbstate_send.py` 伪造 `toadmin\|2\|` 状态 | **退役 / 危险** | `tbstate_send.py:180` 直接 PUB 假 StrategyStatus；protobuf 与当前 `admingpb` 不兼容（crontab `:177`）；库账号硬编码（`:26-29`，不复制） |
| `TBMonitor/` | 旧 C++ 监控 + 邮件/共享盘下载 | **退役 / 危险** | `download_mail.py:42` 读 `/mnt/hft/trading_days.txt`；`bin/start.sh:3` 指向 `/home/hft/build_dev_multi...` |
| `tbmonpage/` | 旧“一产品一进程”的 HTML 页面生成器（含 YD 仓位） | **退役** | crontab `:186-188`（缺 `../tmp/`）；`src/tbmonpage_process.py:33-34` 指向 `/home/hft/TradeBot_China` |

**另外两处同名副本（V）**：
- `tbadmin/py/hft_control.py` 与 `tbadmin-py/hft_control/hft_control.py` 是同一职能的两份；前者 `DB_ADDR="172.31.37.238"`、`DB_PORT=5435`（`tbadmin/py/hft_control.py:11-12`），是**旧库硬编码**，在 190 上必然连不上。
- `tbadmin/py/{hft_manager,hft_op,bktblog}.py`：`bktblog.py` 的 `bkfile()` 会在根盘创建 `/mnt/hft/...` 假挂载点再 `shutil.move` 日志进去（crontab `:441-448` 有专门警告），**误跑会把日志搬进同盘假目录并让原文件消失**。

**结论（V/I）**：复刻时 `tbadmin-py/` 只需保留两个东西——`new/message_forwarding`（或自己重写 30 行）与（可选）`admin_backend`；其余整目录可以删掉，删掉不会损失任何 190 在跑的能力。

---

## 7. Admin 协议

### 7.1 proto 文件与实际生成的代码

- `tbadmin/proto/admingpb.proto`（163 行）定义：`OneControl/ContrilList/StrategyStatusMsg/StrategyDetail/StrategyPNL/OrsDetail/Position/OrderCancel/Account/ProductInfo/ProductRsp/StrategyInfo/StrategyRsp/StrategyOp/StrategyOpRsp/Subscribe/PyMonitor`（V）。
- `tbadmin/proto/msggpb.proto`（142 行）定义：`ContractDescription`、`RequestType`、`OrderType`、`OrderDuration`、`PriceType`、`PositionDirection`、`RequestMsg`、`ResponseType`、`SubResponseType`、`ResponseMsg`、`MdMsg`（V）。
- **两个 proto 都是 `package admingpb`**（`admingpb.proto:2`、`msggpb.proto:2`），所以 C++ 里统一是 `admingpb::` 命名空间；生成物 `inc/admingpb.pb.h` + `inc/msggpb.pb.h` 被 `admin.h:9-10` 同时 include。
- **工程债（V）**：仓库里 `proto/` 目录与 `inc/*.pb.h` 是两份互不引用的产物——Makefile 编译的是 `admingpb.pb.cc`/`msggpb.pb.cc`（`Makefile:16`），`proto/*.proto` 只是文档；没有 `protoc` 生成步骤，也没有版本校验。改 `.proto` 不会改代码。
- 消息命名大小写混用（`StrategyID`、`m_onCancel`、`buyPx`），protobuf 生成的是 `strategyid()/m_oncancel()/buypx()`；前端直接吃 C++ 手拼的 key（`StrategyID`、`pnl`），**不是** protobuf JSON 映射，二者不要混。

### 7.2 帧与类型码总表

帧：`<topic>|<code>|<payload>`（§2.1）。

**agent → admin**（`ProcessStrAgent`，`admin.cpp:1617-2185`）

| code | 名字 | payload | agent 行为 | 回包 |
|---|---|---|---|---|
| `101` | deploy product | `ProductInfo` | 建目录树（`/data /position /bin/{log,models,scripts,controls,config}`）、`cp TradeBot`、清空 `OptionsParams` | `20` `ProductRsp` |
| `102` | add/update strategy | `StrategyInfo` | 写 model/pos/config/start/stop/control 文件、分配 CPU 核、OptionManage 子控制文件 | `21` `StrategyRsp`（含要执行的 SQL、target core、reqid） |
| `103` | operation | `StrategyOp` | `popen(cmd)`，检查退出码；start 前先查“同 sid 是否已在跑” | `22` `StrategyOpRsp` |
| `201` | order request | `RequestMsg` | `send_new_order` / `send_cancel_order` → 写 ORS Request SHM | 走 `7`（来自 Response SHM） |
| `301` | subscribe MD | `Subscribe` | `action==1` 且 server 属于本机 → 加入 `m_agent_md_filter` | 无 |
| `501` | 要 PyBot 表 | 字符串 `PyBot` | `SendPyBotToAdmin(force)` | `23` × N |
| `601` | 要仓位缓存 | 字符串 `Position` | 逐条回放 `m_position_cache`（50µs 间隔） | `6` × N |

**admin → 前端 / admin → agent**（`ProcessStr`，`admin.cpp:2277-3960`）

| code | 名字 | payload | admin 行为 | 去向 |
|---|---|---|---|---|
| `1` | reload strategy | — | `InitStList()`（**无调用方**） | — |
| `2` | strategy status | `StrategyStatusMsg` | 更新 `m_controlAux` | 内存 |
| `3` | clear market cache | — | `m_market_cache.clear()` | 内存 |
| `4` | strategy detail | `StrategyDetail` | key/value/info/alert + 告警去重 + Spread 解析 | `tofront`/`warnmsg` |
| `5` | PnL | `StrategyPNL` | `m_pnl`（只取 netpnl） | 内存 |
| `6` | position | `Position` | `sid!=-99` 策略仓 / `sid==-99` ORS 仓 + 总仓/剩余仓 + Delta | `tofront`/`mdmsg` |
| `7` | order/trade response | `ResponseMsg` | 人工单入库、挂单增删、成交、错误告警 | `tofront`/`ordermsg`/`warnmsg` |
| `8` | 全量快照请求 | 空 | 拼 `StrategyInfo/Spread/Order/Position/Fill/Account/.../DeltaTables/PyBotTables` | `tofront` |
| `9` | ORS detail | `OrsDetail` | 转 JSON 推前端 | `tofront` |
| `11` | 报撤单计数 | `OrderCancel` | 策略级 + product 级聚合 | 内存 |
| `14` | account | `Account` | `m_account[product][exchange]` | `tofront` |
| `18` | market data | `MdMsg` | 缓存 + 白名单过滤 | `mdmsg` |
| `20` | product rsp | `ProductRsp` | **空实现** | — |
| `21` | strategy rsp | `StrategyRsp` | 执行 SQL、改 core/corebind、`InitStList()`、回 `strategyRsp` | `tomanage` |
| `22` | operation rsp | `StrategyOpRsp` | 回 `opRsp` | `tofront` |
| `23` | pybot | `PyMonitor` | 合并 model_file | `tofront` |
| `-1` | 前端 JSON 命令 | JSON 文本 | 见 §7.4 | 见 §5.4 |

> **没有“查询类”请求协议**：账户/持仓/挂单/成交都没有 request/response 查询消息。持仓靠 memlog 推送（`6`），挂单/成交靠 SHM 推送（`7`），账户靠 `14`（未接线）；`501/601` 只是“把 agent 内存里的缓存再发一遍”，`8` 只是“把 admin 内存里的快照再拼一遍”。复刻时如果要有可恢复的查询，必须自己加 DB 查询接口（现有 Flask `/tbhftManOrder/getOrder` 是唯一的持久化查询，见 §5.3）。

### 7.3 报单/撤单的字段映射（人工单）

**报单**（`send_new_order`，`admin.cpp:2187-2240`）：

| `admingpb.RequestMsg` 字段 | 值 | 说明 |
|---|---|---|
| `Contract_Description.symbol` | 前端 `instrument_id` 经 `FormatInstrument` | 例：`ag2612` → 内部格式 |
| `AccountID` | 固定 `"OWN"` | 与 `StrategyConfig.cfg:1 ACCOUNT=OWN` 一致 |
| `OrdType` | `ConvertOrderType(req.ordtype())`，前端固定 `LIMIT` | `admin.cpp:3778` |
| `Duration` | `DAY` 或 `FAK` | `:3780` |
| `PosDirection` | `ConvertPositionDirection` | 前端未传则默认（开仓） |
| `Quantity/Price` | 原样 | `DisclosedQnty = Quantity` |
| `PxType` | `PERUNIT` | 写死 |
| `Transaction_Type` | `"B"`/`"S"` 首字节 | `:2211` |
| `Exchange_Type` | 前端 exchange；INE 品种强制 `"INE"` | `:3765-3769` |
| `StrategyID` | `-1`（WEB） | 与手工仓常量 0 不同（§3.4） |
| `Token` | `-1` | 写死 |
| `OrderID` | `++m_productOrdID[product]` | 每产品独立、进程内单调 |
| `UserRef` | `baseOrderRef++`（启动时用 `HHMMSS*1000` 初始化） | `admin.cpp:92` |

- 产品不在 `m_reqShmQ` 里 → **不报单**，直接构造 `ResponseMsg{ErrorCode=ERR_INVALID_PRODUCT(11)}` 走 `ProcessRsp()`，前端收到“无效的产品名称”（`admin.cpp:2219-2230`）。
- 下完单立刻把整个 `m_orderID2ordRef` 序列化覆盖写 `cfg/order_ref.json`（`:2236-2239`）——**每单一次全量 JSON 落盘**，且不是原子写。

**撤单**（`send_cancel_order`，`admin.cpp:2242-2275`）：
- 只带 `OrderID` + `Symbol` + `Exchange_Type` + `Product` + `StrategyID(-1)`；`padding` 原样透传（`:2251`）。
- 产品不在 `m_reqShmQ` → 同样用 `ERR_INVALID_PRODUCT` 走响应（`:2262-2272`）。
- `CANCEL_ORDER_REJECT` 不入库（`admin.cpp:2660`），其余响应只要 `OrderID != 0` 就插一行 `tbhft_man_order`（`:2662-2671`）。

### 7.4 前端 JSON 命令（`case -1`）

`admin.cpp:3223-3956`。进入前先 `nlohmann::json::parse`，失败仅 `LOG_ERROR` 并 return（`:3226-3235`）。

| `msgtype` | 必填 | 关键分支 |
|---|---|---|
| `product` | product/exchange/server/clientkey/mdkey/monitorkey/orsreqkey/orsrspkey | 写 `tbhft_product`（含硬编码 path）+ `ToAgent 101` |
| `ex_position` | — | 对每个 product 重推 `Exposition` |
| `strategy` | `sid`、`action` | `action=1` 增/改；`action=0` 删；`action` 其他值静默 |
| `refresh` | `strategyid` | 清告警 |
| `operation` | `strategyid`、`server`、`action` | 2/3/4/5/6 → 组 `cmd` → `ToAgent 103` |
| `batchOp` | `action=4`、`stop_st` | 逐条 `ToAgent 103` |
| `orderReq` | `action=1/2` | 报单/撤单 → `ToAgent 201` |
| `batchReq` | `action=2`、`cxl_orders` | 逐条 `ToAgent 201` |
| `subscribe` | `action=1/2`、instrument、exchange | 加/减盘口白名单 → `ToAgent 301` |

**默认值陷阱（V）**：`server` 缺省是 `"0.0"`（`:3296`、`:3653`、`:3743`、`:3897`）。`product`/`strategy`/`subscribe` 会 `split(server,'.').back()` → `"0"`；`operation` 不截断，直接把 `"0.0"` 塞进 `StrategyOp`，agent 侧 `op_req.server() == m_local_ip` 永远为假 → **命令静默丢弃，无任何回包**。

### 7.5 错误码

**自定义码（`tbadmin/inc/admin.h:40-43`）**：

| 码 | 含义 | 产生点 |
|---|---|---|
| `11` `ERR_INVALID_PRODUCT` | 无效产品名 | 报单/撤单时产品不在 `m_reqShmQ`（`admin.cpp:2227`、`:2269`） |
| `12` `ERR_INVALID_ACTION` | 无效操作 | `orderReq` 的 action 不是 1/2（`admin.cpp:3834`） |
| `1048` `ERR_NOT_TICK_SIZE` | 价格不是最小变动价位整数倍 | 只在错误码表里，没有本地产生点 |
| `41052` `ERR_NO_TRADE_SECTION` | 非交易时段 | 同上（由 ORS/柜台返回） |

**错误码描述分派（`getErrorCodeDesciption`，`admin.cpp:4772-4794`）**：

```
1. 先查 getDefaultErrorCodeDesciption()  —— ORS/RMS/SANITY 码表（:5800-5978）
2. server == "126"           → CTP 码表（:4796-5282）
3. exchange == "SH"/"SZ"     → 纯数字 symbol ? 证券码表(:5468) : SOP 码表(:5715)
4. exchange == "CZCE"        → Dstar 码表(:5283)
5. 否则返回 "ORS:未知错误代码"
```

- `server == "126"` 是“IP 最后一段”约定的又一例（`getExchange`/`split` 同源）。
- 默认表末尾把 `found=false` 交回上层（`admin.cpp:5973-5977`），这是唯一“未知码”判定。
- 所有码表都是 `switch` 返回中文字符串；新增码必须同时改这 5 张表，否则前端显示“未知错误代码”。

---

## 8. 故障模式与运维行为

### 8.1 进程死亡

| 死的是 | 现象 | 自动恢复 | 恢复后的状态 |
|---|---|---|---|
| `tbadmin admin` | 前端不再刷新（socket 仍连着，ZMQ 静默丢包）；agent 的 PUB 无订阅者，消息直接丢 | `ops_ensure_tbadmin.sh` 每 5 分钟（仅 9-11/13-15） | 全部内存状态清零；策略表重读；等下一次 memlog |
| `tbadmin agent` | admin 仍每 1 秒推缓存快照（看起来“还活着”），但没有新数据 | 同上 | 需要 admin 重发 `301` 才有行情（§1.4） |
| 两者都死 | 页面完全冻结在最后一帧；无任何错误提示 | 同上 | 同上 |
| `message_forwarding` | 页面 socket 断开/重连失败；HTTP `transmit` 500 | **无 cron 守护**（crontab 无该进程） | 手工 `start.sh` |
| Flask `:5004` | 页面能看实时，但策略/用户/人工单查询失败 | 无守护 | 手工 `reload.sh` |

- **前端不会告诉你数据是旧的**：没有 `last_update` 校验、没有心跳、没有“断流 N 秒”提示。唯一的时间戳是策略表的 `update_time`（`product.vue:173`），而它只在收到消息时更新，停了就停在旧值。
- **重连会补快照**：`ws.on("connect")` 每次连接都发 `toadmin|8|`（`tbcheck/index.vue:456-460`），所以浏览器侧断线重连能恢复；但**服务端数据本身没恢复**。

### 8.2 memlog 陈旧 / 溢出

- 环形队列，容量 = 配置值向上取到 2 的幂（`mwmrq.h:33-44`、`:67-70`），生产是 1024（`data_cpp/bin/config/config_CHINA.9220*.cfg:13`）。
- 生产快于消费时**静默覆盖**：`isFull()` 永远返回 false（`mwmrq.h:104-107`），没有丢包计数，没有告警。
- 消费端每次循环**每个队列只取一条**（`admin.cpp:4563-4583`），循环里还有 5µs sleep（`:1546`）→ 单队列吞吐上限约 10 万条/秒（理论），但四个队列串行 + ZMQ 发送 + `ProcessLog` 的 protobuf 序列化会显著降低；高峰期（开盘、平仓）溢出是现实风险（I）。
- 溢出后的行为：`dequeue()` 用 `seqNo` 自愈，`tail = value->seqNo + 1`（`mwmrq.h:94-100`），会**直接跳到最新**，中间的仓位/PnL/状态永久丢失（V）。

### 8.3 断线/重连

- ZMQ 自动重连，但 **PUB/SUB 不补发**。所有“只在启动时发一次”的消息都是单点：`301`（MD 白名单）、`501/601`（PyBot/仓位缓存请求）、`101/102`（部署/建策略）。
- admin 的 `InitPyBotTable()` 里 `sleep 3s` 再发 `501`，再 `sleep 1s` 发 `601`（`admin.cpp:1459-1468`），这是**唯一的启动握手延时**；agent 若 4 秒内没连上，仓位缓存回放就丢了（V）。
- 没有应用层心跳；TCP keepalive 2 分钟（`admin.cpp:483-495`、`:752-764`）只能发现死连接，不能发现“对端活着但不发数据”。

### 8.4 DB 故障

**启动期（V，会崩）**：
- `InitDb()` 捕获异常后只打印并返回，`m_db_trade` 保持 `nullptr`（`admin.cpp:580-593`）。
- `RunAdmin()` 紧接着 `InitManualPosition()`（有 null 检查，返回 false，`:1116-1122`），然后 `InitStList()` **直接 `m_db_trade->exec_sql(...)`**（`:606`）→ 空指针解引用 → 段错误。
- `RunAgent()` 顺序是 `InitDb(10000)` → `initialize()` → `initialize()` 里同样直接解引用（`:820-821`）。
- 结论：**数据库在启动时不可用 = 进程必崩**，不是降级。cron 的 `ops_ensure_tbadmin` 会反复拉起 → 崩溃循环（I）。

**运行期（V）**：
- `PqHelper` 只有**一个** `pqxx::connection` + 一个 `nontransaction`（`persistence/pqhelper.cpp:3-17`），所有 SQL 同步执行。一次慢查询（`statement_timeout` 5s/10s，`admin.cpp:583`）会**阻塞整个事件循环**：ZMQ 不读、memlog 不消费、前端不推。
- `broken_connection` 会重建连接并重试一次（`pqhelper.cpp:48-64`）；其他异常只返回 `nullptr` + 打印 SQL（`:33-38`、`:65-70`）。**错误 SQL 会被完整打进 stdout**（含 `modeldetail` 内容，可能含敏感/超长文本）。
- 大量调用点只 `LOG_ERROR` 不处理 `nullptr`（如 `:3142-3145`、`:3484-3487`），UI 表现为“操作成功但没生效”。

**典型 SQL 失败（V）**：
- 策略 `ref` 列被当整数用，但代码会写 `"<sid>,<core>"`（`admin.cpp:3523` 拼进 `:3489` 的 update）→ 列类型为 integer 时 PostgreSQL 报 `invalid input syntax`，整条 update 失败，**策略保存静默不生效**（Flask 模型确实声明 `ref = Column(Integer)`，`vue3-admin/back_end/server/models.py:337`）。
- 所有 SQL 都是字符串拼接（`admin.cpp:3489`、`:3556`、`:2662`），`modeldetail/posdetail` 里的单引号会直接截断语句。前端可以构造任意 `modeldetail`，所以这既是**功能炸弹**也是**注入面**（V）。

**HTTP 后端的连带故障（V+I）**：
- `runserver.py:56-75` 的 `get_trading_day_time()` 依赖 `tbtrading_days` 表：若“上一个/下一个交易日”查不到（节假日、日历缺口），会抛 `AttributeError`；`before_request` 捕获后把 `TRADING_DAY_BEGIN` 置空（`runserver.py:89-113`）。
- 空值被直接拼进 `/tbhftManOrder/getOrder` 的 `ta.create_time >= ''`（`tbhft_man_order.py:20`）→ PostgreSQL `invalid input syntax for type timestamp` → **手工单查询整页 500**，而监控页仍正常（它不走这条 SQL）。

### 8.5 前端状态陈旧

- 只在“收到消息”时更新，不校验时间；`dataShowPackag()` 还有 300ms debounce（`tbcheck/index.vue:719-735`）。
- 表格是**全量替换**（`msg.Order` 覆盖 `data.orders`），不是增量；一次乱序/丢包就会让表格缺行，直到下一次全量。
- 老页面残留：router 在 chunk 加载失败时会强制整页刷新一次（`router/index.js:24-36`），这是为“部署替换 assets 后旧页面”专门加的补丁（V）。

### 8.6 已知缺口清单（按严重度）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| 1 | ZMQ 无认证，9980/9981 bind 在 `*` | `admin.cpp:509`、`:781` | 任何能连 9981 的人可报单/改策略/杀进程 |
| 2 | agent 执行远端 `cmd` | `admin.cpp:2068`、`:2092` | 设计上的 RCE（前端 `operation` 模板可被绕过，因为 `cmd` 是 protobuf 字段） |
| 3 | `ProcessStr` 不校验 `split` 长度 | `admin.cpp:2279-2281` | 一条 `toadmin\|x` 就能越界读/崩 admin |
| 4 | `case 2` 的 aux_id 循环写错 | `admin.cpp:2304-2319`（循环内改 `aux_id` 后仍继续用） | OptionManage 子策略状态写到错误 key |
| 5 | `case 21` `erase(end())` | `admin.cpp:3167-3175` | DB 失败 + 未知 reqid 时 UB |
| 6 | `case 7` 报单错误去重里 `return` | `admin.cpp:2896-2908` | 300 秒内的重复错误会**跳过后续所有订单处理**（含挂单表更新） |
| 7 | 内存无上限 | `m_fills`（`:2804`）、`m_spd`（`:2455`）、`m_orderRef2TotalQty`（`:2633`）、`m_last_error_timetmsp`（`:2896`） | 全天累积，收盘才随进程消失 |
| 8 | `dumpStrategyInfo` 拼字符串再 parse | `admin.cpp:4051-4174`，10KB 栈 buffer/策略 | model/product 名里有 `'` 或 `"` → 整表变 `[]` |
| 9 | `order_ref.json` 非原子写 | `admin.cpp:2236-2239` | 断电/并发 → JSON 截断 → 下次启动 `initialize()` 抛异常 → agent 起不来（`:861-872`） |
| 10 | `clear.sh` 与内存分叉 | `ops/crontab.txt:131` | §1.4 |
| 11 | `getInitOrdID` 依赖 ClientStore | `admin.cpp:4749-4756` | 若 ORS 未创建 16385，agent 启动即抛（I） |
| 12 | `MEMLOG_LEN_LIST` 与 `MONITORSHMSIZE` 必须相等 | `cfg/agent.cfg`（1024） vs `admin.cpp:1806`（新策略写 100000） | UI 新建策略 → 队列长度不一致 → 读错槽位（§8.8） |
| 13 | 策略 `server` 三种写法 | §4.5 | UI 新建策略不落地 |
| 14 | `-99` / `sid=0` 两个常量断链 | §3.4、§3.5 | 持仓页/手工仓空 |
| 15 | `strategyRsp` 通道未订阅 | §5.5 | 保存无反馈 |
| 16 | `StrategyConfig.cfg` 无 sid 后缀，多策略共用 | `admin.cpp:1826` | 最后一次写入的限额/DSN 覆盖所有策略（§4.7） |

### 8.7 凭据与敏感配置的位置（只记位置，不记值）

| 位置 | 内容 | 风险 |
|---|---|---|
| `tbadmin/client_yd.cpp:23` | YD `appID` / `authCode` 硬编码在构造函数初始化列表 | 源码即凭据；换柜台无法改配置 |
| `tbadmin/admin.cpp:583`、`:1816`、`:1825` | PostgreSQL DSN 里内嵌固定用户名/口令（`user=... password=<redacted>`），并被**写进每个新策略的 config 与 `StrategyConfig.cfg`** | 口令散落到 `deploy_cpp/bin/config/*`；改库口令要重生成所有策略配置 |
| `tbadmin-py/admin_backend/main.py:42-49` | `admin_db` 的用户/口令写在 `DB_CONFIG` | 明文入库；文件随 git 分发 |
| `vue3-admin/back_end/server/config.py:2-9` | 两套 DB URL 均带账号口令（`admin` 库、`dbtrade` 库） | 同上 |
| `vue3-admin/back_end/message_forwarding/config.py:3-32` | 旧内网 Redis/DB/ZMQ 地址（含端口），无口令 | 误连旧生产 |
| `tbadmin-py/check_server_port/config.json`（**git 跟踪**）、多个 `*.py` 注释、`tbadmin-py/*/config.json.example` | 企微 webhook、旧内网代理地址 | 真实 key 已进 git 历史；必须轮换，不能只删文件 |
| `tools/strategy_sync/strategy_sync.env.template` | RDS 主机名与用户名（口令留空） | 模板本身安全；实际文件在 `/root/.quantlink/`（600） |

复刻时应当：全部改为环境变量/密钥文件，**生成策略配置时不要把 DSN 写进去**（TradeBot 的 DSN 只用于它自己的持久化，和 admin 的库账号不应共用）。

### 8.8 `MEMLOG_LEN_LIST` 的隐藏契约（复刻必读）

- 生产端：`memlog(shmkey, MONITORSHMSIZE)`，`MONITORSHMSIZE=1024`（`data_cpp/bin/config/config_CHINA.92204.cfg:13`）。
- 消费端：`memlog(atoi(key), atoi(len))`，`len=1024`（`tbadmin/cfg/agent.cfg`、`admin.cpp:4600`）。
- 队列把 `qlen` 向上取到 2 的幂，并用 `& (m_size-1)` 做下标（`mwmrq.h:33-44`、`:80-98`）。
- **admin 给新策略生成的配置写的是 `MONITORSHMSIZE = 100000`**（`admin.cpp:1806`、`:1813`），取整后是 131072；而 agent 仍按 1024 取模 → 头 1024 条之后生产者/消费者下标分叉，`seqNo` 自愈会随机跳读。**这是“UI 新建的策略监控数据错乱”的一个确定机制**（V 代码 + I 影响）。
- 复刻时应当：把队列长度写进一个共享常量/契约，或者让消费端从 SHM 头里读容量，而不是各自配。

---

## 9. 复刻建议

### 9.1 最小管理面（能看、能下单、能改策略）

**必须有的 4 个能力**：

1. **读 memlog**（789）：`SlotData{type,data[2048]}`，按 `MsgLogType` 解码 5 种结构。
2. **读 Response SHM**（12289）：订单/成交回报。
3. **一个出口**：建议直接 WebSocket + JSON（不要 ZMQ→Python→Socket.IO 两跳），并提供 `GET /snapshot`。
4. **一张策略表 + 两张手工表**：`tbhft_strategy`（读）、`tbhft_man_order`（写）、`tbadmin_position`（可选）。

**可以整块砍掉的**：

| 砍掉 | 理由 |
|---|---|
| `tbadmin-py/*`（除 forwarder 外全部） | 190 已退役；见 §6 |
| `vue3-admin/frontend/dist` | 旧构建产物 |
| `vue3-admin/back_end/message_forwarding` | 旧内网地址，已被精简版替代 |
| YD `client_yd` | 默认构建里就是注释掉的（`admin.cpp:788-818`） |
| PythonBot 监控 | 只在 `PYBOT_PATH`（默认 `./py`）下存在**纯数字文件名**的 `<sid>.json` 时才建表（`admin.cpp:525-578`）；`PYBOT_KEY=0` 只是不接 shm 日志（`admin.cpp:4634-4637`） |
| 期权 Delta / 虚拟期权 | 依赖 `-99` 仓位 + MD；没有上游就是空表 |
| Spread 解析 | 从日志字符串 `Trade2` 里 `split(' ')` 抠字段（`admin.cpp:2435-2463`），极脆 |
| CPU 绑核分配 | 只在“UI 新建策略”路径用；静态 control 文件不需要 |
| control/model/config 文件生成 | 如果复刻版把策略配置当“只读输入”，这块完全不用（但要保留人工“重新拉起”） |
| `warnmsg`/`tosound`/`optmsg` | 前端没用到或不可达 |

**建议保留但重写的**：

- **策略表同步**：直接复用 `sync_tbhft_strategy.py` 的 diff/备份/冲突逻辑（它是纯函数 + 单测，最容易移植）。
- **手工单落库**：`tbhft_man_order` 的“一响应一行 + 前端取 MAX(id)”模型可以保留，但建议改成 upsert 到订单主表 + 成交流水表。
- **错误码映射**：把 4 张 switch 表抽成数据文件（CSV/JSON），不要继续写在 C++ 里。

### 9.2 建议的新架构（同等功能，代码量更小）

```
TradeBot ──memlog──┐
ORS ──response─────┼──> admin-core (单进程，Go/Rust/Python 均可)
ORS ──md───────────┘        │
                            ├── SQLite/Postgres: strategy_snapshot, orders, fills, positions
                            ├── WebSocket /ws  (snapshot + delta, 带 seq + heartbeat)
                            └── HTTP /api/*  (策略 CRUD、手工单、查询)

浏览器 ── ws/http ──> admin-core        # 不再需要 forwarder 这一跳
```

关键差异（每一条都对应上面的一个缺口）：

1. **消息带 `seq` 和 `ts`**，前端能判断“多久没更新”；断流 3 秒显式置灰。
2. **快照 + 增量**：客户端重连时先 `GET /snapshot` 再订阅，不依赖 PUB/SUB 补发。
3. **订单/成交落库**（而不是只在内存），重启可恢复。
4. **鉴权**：至少一个共享 token（WS 握手 + HTTP header），ZMQ/内部总线只 bind 127.0.0.1。
5. **不做远端 shell**：把“启停策略”做成白名单动作（`systemctl start tradebot@<sid>` 或固定脚本），不要接受任意 `cmd`。

### 9.3 必须测试的用例（按优先级）

| # | 用例 | 通过标准 |
|---|---|---|
| 1 | memlog 结构体 ABI | 用生产同版本 `msg.h` 编译生产者和消费者；写一条 `CANCEL_STS`，消费者拿到的 `type==5` 且字段正确 |
| 2 | 队列容量一致 | 生产者 1024 / 消费者 1024；灌 10 万条，消费者最终 `netpos` 与最后一条一致 |
| 3 | 环形溢出 | 灌 10 倍容量，验证“跳到最新”而非读脏；有丢包计数 |
| 4 | 启动竞态 | 先起消费者再起生产者、反过来各 10 次；MD 白名单/仓位缓存都不丢 |
| 5 | 报单往返 | 前端下单 → SHM 请求字段正确 → 收到 `NEW_ORDER_CONFIRM` → `TRADE_CONFIRM` → 挂单减量、成交表新增、DB 一行 |
| 6 | 撤单往返 | 撤单 → `CANCEL_ORDER_CONFIRM` → 挂单移除；`CANCEL_ORDER_REJECT` 不入库 |
| 7 | 无效产品 | 报单产品不在 SHM 表 → 前端收到 `errNO=11` |
| 8 | DB 启动不可用 | 进程不崩（或明确 fatal + 退出码），不能段错误 |
| 9 | DB 运行中断 | 事件循环不阻塞超过 N 秒；恢复后能继续写 |
| 10 | 非法消息 | 发 `toadmin\|x`、`toadmin\|8`、`toadmin\|-1\|notjson`，进程不崩 |
| 11 | 重启恢复 | kill -9 admin → 重启 → 策略表/挂单/成交/持仓与重启前一致（或明确标注“已丢失”） |
| 12 | 策略同步 | 首次运行不删本地行；冲突退出码 2；备份表可恢复；批次未变跳过 |
| 13 | 15:30 清理 | 清理后进程不重启，内存与磁盘不一致被显式处理（或干脆取消该任务） |
| 14 | 时钟/时区 | `>=18:00` 过滤 CFFEX/SH/SZ/GFEX（`admin.cpp:602-605`）行为符合预期 |

### 9.4 复刻时最容易踩的 10 个坑

1. 把 `tbadmin` 当进程名去 `pgrep`（真实名是 `AgentLoop`/`AdminLoop`）。
2. 以为 `strategy_sync` 写完库 admin 会自动刷新（不会，必须重启）。
3. 以为 `Position` 页是策略仓（其实是 `-99` 的 ORS 仓，默认无源）。
4. 以为手工单会更新手工仓（不会，`sid` 常量不匹配）。
5. 以为 `Account` 页能用（YD 客户端被注释，前端也注释了）。
6. 用 `MEMLOG_LEN_LIST` 随便填（必须等于生产端 `MONITORSHMSIZE`）。
7. 只启 forwarder 不启 Flask（实时有了，查询 404）。
8. 用 `start_tbadmin.sh` 起服务又开 `ops_ensure_tbadmin`（pid 文件不匹配 → 重复进程）。
9. 把 `vue3-admin/frontend/dist` 当最新前端（它是旧包，base 还是 `/admin/`）。
10. 忘了 `tbhft_product` 必须先有行（否则建策略直接报 “query product db shmkey error”，`admin.cpp:3458-3467`）。

---

## 10. 证据索引与未解问题

### 10.1 关键文件索引

| 主题 | 文件:行 |
|---|---|
| 角色判定/入口 | `tbadmin/main.cpp:5-46`；`admin.cpp:86-99` |
| 进程名 | `admin.cpp:1520`（AgentLoop）、`:4447`（AdminLoop） |
| ZMQ 拓扑 | `admin.cpp:468-523`、`:737-787`；`admin.h:387-394` |
| memlog 消费 | `admin.cpp:294-425`、`:4557-4591`；`msg.h:10-88`；`mwmrq.h:80-107` |
| MD 消费 | `admin.cpp:252-293`、`:3093-3130`、`:4531-4556` |
| 订单回报 | `admin.cpp:222-251`、`:2595-2991` |
| 人工单 | `admin.cpp:2187-2275`、`:3738-3890`、`:2660-2671` |
| 策略文件生成 | `admin.cpp:1667-2063` |
| 策略表读取 | `admin.cpp:595-735` |
| 快照/推送节奏 | `admin.cpp:4445-4530`、`:4497-4503` |
| Delta 计算 | `admin.cpp:917-1114`；`tb_utils.h:97-110` |
| 错误码 | `admin.cpp:4772-4794`、`:4796-5977`；`admin.h:40-43` |
| DB 封装 | `persistence/pqhelper.cpp:1-71` |
| 配置 | `tbadmin/cfg/agent.cfg`、`cfg/admin.cfg`、`cfg/order_ref.json` |
| 启停 | `tbadmin/start_agent.sh`、`start_admin.sh`、`stop_agent.sh`、`clear.sh` |
| 策略同步 | `tools/strategy_sync/sync_tbhft_strategy.py:1-353`；`test_sync_tbhft_strategy.py:1-71` |
| 前端源码 | `tbadmin-front/my-admin/src/views/tbcheck/index.vue:452-680`、`indexTable/*.vue`、`transaction/index.vue:583-965` |
| 前端路由 | `tbadmin-front/my-admin/src/router/models/nested.js:1-120` |
| 实时转发 | `tbadmin-py/new/message_forwarding/message_forwarding.py:17-153` |
| HTTP 后端 | `vue3-admin/back_end/runserver.py:1-40`、`server/api/*.py`（78 路由） |
| 静态站 | `ops/nginx/quantlink-admin.conf:1-24` |
| cron/退役 | `ops/crontab.txt:12-16`、`:61-67`、`:127-131`、`:172-209`、`:917-946` |
| 健康检查 | `scripts/ops_check_status.sh:150-167`；`scripts/ops_ensure_tbadmin.sh:1-25` |

### 10.2 与旧文档的冲突（以代码为准）

| 旧文档说法 | 代码事实 | 结论 |
|---|---|---|
| `docs/INTEGRATION_TEST_TBSRC_TBADMIN.md`：`ProcessMd()` 是空实现，MD 不转发（文档 `:218-232`） | 当前 `ProcessMd` 会按白名单转发 `18\|MdMsg`（`admin.cpp:252-293`），admin `case 18` 会推 `mdmsg`（`:3093-3130`） | **文档过期**，MD 现在是通的（前提是白名单非空） |
| 同上：agent.cfg 用 `RSP_Q_LIST=12289`、`MD_LEN_LIST=4096`（文档 `:70-100`） | 当前 `LoadAgentConfig` 不读 `RSP_Q_LIST`，改成 `PRODUCTS` + 每产品 `ORS_RESPONSE_SHMKEY`（`admin.cpp:4674-4696`）；`MD_LEN_LIST` 必须等于 ORS 的 `MD_SHMSIZE=2048`（`cfg/agent.cfg` 注释） | **文档过期**，照抄会起不来 |
| `docs/STARTUP_GUIDE.md`：agent.cfg 启用 `RSP_Q_LIST=12289`（`:246-252`） | 同上 | **文档过期** |
| `ops/crontab.txt:652`：`AgentLoop` 在 `admin.cpp:1500`、`AdminLoop` 在 `:4422` | 实际 `:1520`、`:4447` | 行号漂移（不影响结论） |
| `tools/strategy_sync/README.md`：同步后需重启 admin | 正确；但代码里 `case 21` 写库后会 `InitStList()`（`admin.cpp:3154`） | 两种路径并存，**重启仍是唯一可靠路径** |

### 10.3 未解/待现场确认

1. **生产 `tbadmin/cfg/agent.cfg` 是否真的没有 `PRODUCTS`**（仓库版没有，V）。若生产也没有，则 agent 不建 `m_reqShmQ`/`m_rsp_q_arr`，前端报单必然返回 `ERR_INVALID_PRODUCT`、且所有订单回报都收不到——这与“应急交易可用”的运维预期矛盾，需要用现场文件确认（I）。
2. **谁在写 `strategyID=-99` 的 ORS 仓位**。仓库内只有 `testmemlog`；旧系统是 tslinker（已排除）。若 190 上没有替代品，Position/Exposition/Delta 三块就是空壳（V 代码 + I 现场）。
3. **`ops/delta_snapshot.py` 抓到的 `DeltaTables` 是否非空**（脚本存在：`scripts/ops_delta_snapshot.py:1-60`，cron 09:20/14:50：`ops/crontab.txt:942-944`）。这能直接判定第 2 条。
4. **190 上 `admin_backend`（FastAPI :8000）到底有没有在跑**。crontab 注释说在用（`:208-209`），但 `start_tbadmin.sh` 启的是 Flask :5004，且前端 env 指向 :5004 —— 两者只能有一个是真入口（V 矛盾）。
5. **`vue3-admin/back_end/server/config.py` 的 `admin` 库与 `admin_db` 是不是同一个库**（前者 `ADMIN_URL` 指向 `admin`，后者 README 说 `admin_db`）。表结构 `tb_user/tb_product/tb_strategy` 在仓库里没有 DDL，无法核对（I）。
6. **策略表 `ref` 列的真实类型**。C++ 当字符串用、Flask 模型当 Integer；只有现场 `\d tbhft_strategy` 能定论（I）。
7. **9980/9981 是否被防火墙限制在 127.0.0.1**。代码 bind `*`（V）；`ops/` 里没有 firewall 规则（I）。这是安全文档的第一优先级项。
8. **`tbadmin/lib/` 的 `.so` 来源与版本**（`-lyd -lmemlog -lpqhelper`，`Makefile:25`）。仓库里没有 `lib/`，也没有构建脚本；复刻时必须先解决这三个库（I）。

### 10.4 一句话给复刻者

> 这套管理面的**协议和派生逻辑值得抄，运行时架构不值得抄**：它把“实时状态”放在一个会随时重启的进程内存里、用无认证的 PUB/SUB 传订单、用字符串拼 SQL、用注释掉的客户端查账户。复刻时保留 `tbhft_strategy` 的字段语义、`tbhft_man_order` 的落库模型、memlog 的 5 种结构、以及 `sync_tbhft_strategy.py` 的 diff 算法；其余（ZMQ 拓扑、forwarder、Vue 旧包、tbadmin-py）都可以用更小的东西替代。

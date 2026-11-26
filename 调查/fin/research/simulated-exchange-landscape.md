# 模拟交易所调研（2026-11-06）

- 目标：为 T-027 找到可复用/可参考的模拟交易所，避免从零重复造轮子。
- 结论：**有非常接近的产品，尤其是 LocalCTP；但没有任何一个同时满足“本地 + CTP Adapter 接口 + 真实数据回放 + 可配置抖动 + 可配置异步延迟 + 固定 seed”。**

---

## 1. 最接近：LocalCTP

- 仓库：<https://github.com/dearleeyoung/LocalCTP>
- License：MIT
- Stars：约 187（2026-11 查询）
- 语言：C++
- 形态：**本地嵌入式仿 CTP 柜台**，用它的 `thosttraderapi_se.dll/so` 替换真实 CTP 交易库
- 关键能力：
  - 不联网，本地撮合
  - 接口与 CTP 完全兼容
  - 支持期货、期权、套利组合
  - 支持 FAK/FOK、条件单
  - 成交逻辑同 SimNow：按行情对手价判断
  - 支持 Windows/Linux/macOS/FreeBSD
  - 通过 `RegisterFensUserInfo` / `ReqQuoteInsert` **投喂外部行情快照**
  - 支持实时仿真和回测两种模式
  - 资金/持仓/订单/成交/结算单写 SQLite
  - 支持多 CTP 版本（6.5.1 默认，可脚本生成其他版本）
- 限制：
  - **不包含行情 API**，只包含交易 API；行情需要外部投喂
  - 没有随机抖动、随机延迟、固定 seed 的内置能力
  - 撮合偏 SimNow 做市逻辑，部分成交/队列行为需要验证
  - 期权保证金复用期货逻辑，不是真实期权保证金公式
  - 假期识别有限

**判断：这是和我们需求最接近的开源实现。** 可以直接作为：
1. CTP API 兼容性参考实现；
2. 可选的 `LocalCtpSession` 后端；
3. 撮合/结算/查询行为的对照基准。

---

## 2. OpenCTP 模拟环境

- 仓库：<https://github.com/openctp/openctp>
- 官网：<http://www.openctp.cn/Trading.html>
- 仓库 License：BSD-3-Clause（但**模拟柜台核心不是开源代码**，仓库主要是 CTPAPI 兼容适配层/客户端/工具）
- 形态：远程托管的 TTS 模拟柜台
- 能力：
  - 7x24 环境、仿真环境、VIP 仿真环境
  - CTPAPI 兼容
  - 5 档行情
  - 支持部分成交、部分撤销
  - 支持 FAK/FOK、市价单
  - 期货/期权/股票期权/股票等
  - 做市模式 + 撮合模式（TEST/BTC/MINUS 三个合约）
- 限制：
  - 依赖外部服务，不是本地实现
  - 撮合核心不开源，不能改抖动/延迟/seed
  - 仿真环境做市模式不部分成交
  - VIP 收费
  - 不符合“MVP 不依赖远程 CTP”的原则

**判断：适合做外部对照/验收环境，不适合作为本地 MVP 核心。**

---

## 3. SimNow

- 官网：<https://www.simnow.com.cn/>
- 官方 CTP 模拟环境，闭源
- 能力：CTP 官方接口、7x24/仿真
- 限制：
  - 不稳定、经常维护
  - 业务覆盖有限
  - 不能控制撮合、抖动、延迟
  - 不能作为 CI/自动化测试依赖

**判断：只作为最终 CTP 兼容性抽查，不作为日常测试环境。**

---

## 4. NautilusTrader（架构参考）

- 仓库：<https://github.com/nautechsystems/nautilus_trader>
- License：LGPL-3.0-or-later
- 语言：Python + Rust
- 相关能力：
  - Simulated Exchange / Sandbox Execution
  - 撮合引擎
  - Fill Model：`DefaultFillModel`、`BestPriceFillModel`、`TwoTierFillModel` 等
  - Latency Model：`StaticLatencyModel`，分别延迟 insert/update/delete
  - 确定性 trade ID、固定 `random_seed`
  - 流动性消费、概率成交、滑点模型
- 限制：
  - 不是 CTP 接口
  - 不是中国期货/期权规则
  - LGPL 引入需评估
  - Python/Rust 技术栈与我们的 C++ CTP Adapter 不同

**判断：不直接复用，但它的“Fill Model + Latency Model + 固定 seed + 确定性成交 ID”设计非常值得照搬。**

参考：
- <https://nautilustrader.io/docs/latest/concepts/backtesting/execution-flow/>
- <https://nautilustrader.io/docs/latest/concepts/backtesting/fill-models/>
- <https://nautilustrader.io/docs/latest/concepts/behavioral_models/>

---

## 5. 通用 C++ 撮合引擎（可复用核心）

这些项目只做撮合核心，不含 CTP、账户、期权、结算，但可以作为 `MatchingEngine` 的实现参考或直接依赖（需评估 license/质量）。

| 项目 | License | 特点 | 适不适合直接用 |
|---|---|---|---|
| [Hridye5h/Match_Engine](https://github.com/Hridye5h/Match_Engine) | MIT | 价格-时间优先、LIMIT/MARKET/IOC/FOK/MODIFY、O(1) cancel、整数价格、确定性、13M orders/s | 可参考/可复用核心 |
| [TheYellowDuck/limit-order-book](https://github.com/TheYellowDuck/limit-order-book) | 未确认 | 价格-时间/Pro-Rata、PostOnly/Stop/Iceberg/Pegged、集合竞价、STP、风控 | 功能最全，需确认 license |
| [JohnAdeoye/matching-engine](https://github.com/JohnAdeoye/matching-engine) | MIT | Header-only、30 tests、整数价格、IOC/FOK、amend | 轻量可参考 |
| [Sid110406/fast-matching-engine](https://github.com/Sid110406/fast-matching-engine) | 未确认 | C++ + FastAPI、多 symbol、价格-时间 | 偏 demo |
| [diegourda/Liquidity-Arena](https://github.com/diegourda/Liquidity-Arena) | MIT | 撮合 + 多 agent + Hawkes + 延迟套利 + 可视化 | 研究/仿真参考 |

**判断：撮合核心可以借鉴，但 CTP 兼容、账户/持仓/保证金、中国交易所规则仍需我们自己补。**

---

## 6. 横向对比

| 项目 | CTP 接口 | 本地 | 开源 | 期权 | 外部行情投喂 | 抖动 | 随机延迟 | 固定 seed | 适合 T-027 |
|---|---|---|---|---|---|---|---|---|---|
| LocalCTP | ✅ 完全兼容 | ✅ | ✅ MIT | ✅ | ✅ | ❌ | ❌ | ❌ | **最接近，可复用/对照** |
| OpenCTP 模拟 | ✅ | ❌ 远程 | ❌ 核心 | ✅ | ❌ | ❌ | ❌ | ❌ | 外部验收 |
| SimNow | ✅ | ❌ 远程 | ❌ | 部分 | ❌ | ❌ | ❌ | ❌ | 抽查 |
| NautilusTrader | ❌ | ✅ | ✅ LGPL | 部分 | ✅ | 模型可扩展 | ✅ LatencyModel | ✅ | 架构参考 |
| Match_Engine | ❌ | ✅ | ✅ MIT | ❌ | ❌ | ❌ | ❌ | ✅ 确定性 | 撮合核心参考 |
| 我们 T-027 | ✅ CtpSession | ✅ | 自有 | ✅ 目标 | ✅ Replay | ✅ 目标 | ✅ 目标 | ✅ 目标 | 自建 |

---

## 7. 建议路线

### 路线 A：自建 `SimulatedCtpSession`（推荐作为主路线）

- 保持 CTP Adapter 的 `CtpSession` 接口不变
- 复用 LocalCTP 的 CTP 行为/字段/结算经验
- 撮合核心参考 MIT 项目或自写价格-时间优先
- 自己加：
  - 真实 tick 回放 + 抖动
  - 随机延迟队列
  - 固定 seed
  - 故障注入
- 优点：完全可控，符合本地/CI/可复现要求
- 缺点：工作量大，期权/保证金/交易所规则要自己补

### 路线 B：LocalCTP 作为可选后端

- 新加 `LocalCtpSession`，链接 LocalCTP 的 `thosttraderapi_se.so`
- 用 `RegisterFensUserInfo`/`ReqQuoteInsert` 投喂我们的 Replay 行情
- 优点：CTP 兼容性最高，开发量小
- 缺点：
  - 不能控制撮合内部细节
  - 没有抖动/延迟/seed
  - 依赖 LocalCTP 的 SQLite 和 CTP 版本
  - License/维护风险

### 推荐组合

1. **T-027 主实现**：自建 `SimulatedCtpSession`
2. **LocalCTP 作为对照**：同一组用例跑 LocalCTP，比较成交/拒单/持仓差异
3. **OpenCTP/SimNow 作为最终抽查**：交易时段/外部环境
4. **NautilusTrader 模型设计**：借鉴 Fill/Latency/Seed，不引入依赖

---

## 8. 对 T-027 的调整

- 增加“LocalCTP 行为对照”验收项
- 增加“固定 seed 可复现”验收项
- 增加“延迟分布断言区间”而不是精确值
- 增加“模拟不了的行为显式标注”
- 在报告中写明 LocalCTP/OpenCTP/Nautilus 的参考点与 license

---

## 9. 参考链接

- LocalCTP：<https://github.com/dearleeyoung/LocalCTP>
- OpenCTP：<https://github.com/openctp/openctp> / <http://www.openctp.cn/Trading.html>
- SimNow：<https://www.simnow.com.cn/>
- NautilusTrader：<https://github.com/nautechsystems/nautilus_trader>
- Nautilus 执行流：<https://nautilustrader.io/docs/latest/concepts/backtesting/execution-flow/>
- Nautilus Fill Model：<https://nautilustrader.io/docs/latest/concepts/backtesting/fill-models/>
- Match_Engine：<https://github.com/Hridye5h/Match_Engine>
- limit-order-book：<https://github.com/TheYellowDuck/limit-order-book>

# PythonBot 分析报告

- 日期：2026-11-23
- 源码：`/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/py`
- 关联：`quantlink-trading` tbadmin PyBot 表、`tbsrc` 的 `tvar/tcache`
- 结论：PythonBot 是独立的 Python 信号运行时，不属于 146；tbadmin 的 PyBot 表只是它的部分监控视图

---

## 0. 一页结论

```text
PythonBot
  = 独立 Python 进程
  = 读 MD 共享内存
  = 读 tCache 仓位
  = 计算指标 / 信号
  = 写 tVar
```

```text
C++ TradeBot
  = 读 tVar
  = 把 tVar 转成 memlog TValue
  = 实际下单/执行
```

tbadmin 的 PyBot 表：

```text
State    = ps 进程探测
StrategyID = PythonBot settings 文件名
Model    = tbhft_strategy.ModelFile（不是 PythonBot 模型）
Value    = PythonBot tVar -> C++ TB -> memlog TValue
Log      = PythonBot 写文件日志；tbadmin 读 PYBOT_KEY ShmLog，当前没接上
```

关键判断：

```text
PythonBot 不在 146
PythonBot 不在 quantlink-trading 当前源码树
它是另一个独立仓库/运行时
146 的 C++ pair 策略 + OptionManager 也不依赖 PythonBot
```

---

## 1. 源码与版本

目录：

```text
/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/py
```

Git：

```text
6f62842 2024-12-23 update bot
129c60a 2024-12-23 ini
550fde9 2024-12-23 update
4c0e3ea 2024-11-29 first commit
```

关键文件：

| 文件 | 作用 |
|---|---|
| `run_PythonBot.py` | PythonBot 主入口 |
| `settings/<sid>.json` | 策略参数 |
| `strategyShm.ini` | tVar/tCache key |
| `man/createShm.py` | 创建 tVar/tCache |
| `man/rmShm.py` | 删除 tVar/tCache |
| `md.cpython-38-x86_64-linux-gnu.so` | MD/共享内存 Python 扩展 |
| `strategy/strategyCSO.py` | CSO 价差/虚拟期权策略 |
| `strategy/strategyLogit.py` | Logit 模型策略 |
| `models/*.csv` | Logit 模型数据 |
| `stop.sh` | 进程停止脚本 |

`md.so`：

```text
ELF 64-bit x86-64 Linux
Python 3.8
pybind11
hftlib::Bot / hftlib::tvar<double> / hftlib::tcache<double>
```

所以它不能直接在 macOS 上运行，也不是纯 Python 实现。

---

## 2. 运行架构

```text
┌──────────────────────┐
│ MD SHM (md_key)      │
│ MarketUpdateNew      │
└──────────┬───────────┘
           │ md.Bot().Connect(md_key)
           ▼
┌──────────────────────┐
│ PythonBot            │
│ run_PythonBot.py     │
│ StrategyCSO/Logit    │
└──────┬────────┬──────┘
       │        │
       │        │ read tCache
       │        ▼
       │   ┌──────────────────────┐
       │   │ C++ TradeBot         │
       │   │ m_tcache->store(...) │
       │   └──────────┬───────────┘
       │              │
       ▼              │
┌──────────────────────┐
│ tVar (tvar_key)      │
│ atomic<double>       │
└──────────┬───────────┘
           │ C++ m_tvar->load()
           ▼
┌──────────────────────┐
│ C++ PairwiseArb      │
│ SendMonitorStratDetail│
│ key=TValue           │
└──────────┬───────────┘
           │ memlog
           ▼
┌──────────────────────┐
│ tbadmin              │
│ ProcessPyBotValue    │
│ PyBot.Value          │
└──────────────────────┘
```

---

## 3. 启动参数与配置

启动方式：

```text
python run_PythonBot.py <strategy_id> <tvar_key> <tcache_key> <md_key>
```

例如：

```text
python run_PythonBot.py 41131 111 222 872
```

无参数时是本地调试模式：

```text
strategy_id = 62131
tvar_key = 111
tcache_key = 222
md_key = 874
is_real = False
```

`settings/<strategy_id>.json` 是策略参数。

示例 `settings/41131.json`：

```json
{
  "name": "strategyCSO-rb",
  "className": "StrategyCSO",
  "contracts": ["rb2501", "rb2505"],
  "ticksize_list": [1, 1],
  "exchange_list": ["SHFE", "SHFE"],
  "multiplier_list": [10, 10],
  "sid": 41131,
  "coef_mul": 3,
  "cso_para": [
    {
      "name": "rb2501rb2505C1455-rb2501-rb2505",
      "Strike": 145.5,
      "const": 195.5,
      "sigma": 0.6,
      "r": 0.01,
      "expire_date": "2025-01-15",
      "contracts_size": -10,
      "call_put_flag": "C"
    }
  ]
}
```

`strategyShm.ini`：

```ini
[ax3-41231]
tVar_key=111
tCache_key=222

[ky1-41331]
tVar_key=112
tCache_key=223
```

---

## 4. 数据接口

### 4.1 MD 行情

PythonBot：

```python
bt = md.Bot()
bt.Connect(md_key, 100000)
```

循环：

```python
if not bt.Empty():
    m = bt.LastMd()
```

`m` 是 `MarketUpdateNew`，包含：

```text
symbol
exchange timestamp
last traded price
total traded qty/value
valid bids/asks
bid/ask updates
```

PythonBot 的 `HTick` 取前 5 档：

```python
self.bids_price = np.zeros(5)
self.bids_qty = np.zeros(5)
self.asks_price = np.zeros(5)
self.asks_qty = np.zeros(5)
```

注意：PythonBot 只使用 5 档，而 146/205 盘口事实是 20 档。

### 4.2 tCache：仓位

C++ 策略写：

```cpp
m_tcache->store(
    std::to_string(m_strategyID) + "_pos_" + instrument,
    netpos
);
```

PythonBot 读：

```python
cache = md.dcache()
cache.init(tcache_key)
netpos = cache.load(pos_str)
```

`StrategyCSO` 使用：

```python
self.pos_str = f"{self.sid}_pos_{self.contracts[0]}"
```

只读第一腿仓位；第二腿没有直接读。

### 4.3 tVar：指标/信号

PythonBot 写：

```python
var = md.tdouble()
var.init(tvar_key)
var.store(indicator)
```

C++ 策略读：

```cpp
auto val = m_tvar->load();
if (tValue != val) {
    tValue = val;
    SendMonitorStratDetail(m_product, "TValue", ...);
}
```

`tVar` 是单个 `atomic<double>`，一个 key 只有一个值。

---

## 5. 策略实现

### 5.1 `StrategyCSO`

CSO 参数：

```text
contracts
Strike
const
sigma
r
expire_date
contracts_size
call_put_flag
```

`onInit()` 为每个 CSO 参数创建虚拟期权指标：

```python
factor_name = 'VirtualOption'
para_dict = {
    'expiry': pd.Timestamp(para['expire_date']),
    'sigma': para['sigma'],
    'strike': para['Strike'],
    'call_put_flag': para['call_put_flag'],
    'qty': para['contracts_size'],
    'const': para['const'],
    'rate': para['r'],
}
```

`onTick()`：

```text
更新 HTick
更新所有 VirtualOption 指标
current_delta = sum(mid)
hedge_qty = current_delta - pos
signal = 1 / -1 / 0
value_add = (coef_mul + min(abs(hedge_diff/lot_size),1))
            * tick_size * signal
```

返回：

```python
{
  'signal': real_model_signal,
  'value_add': value_add,
  'ind_info': ind_info,
  'sid': sid,
  'pos_str': pos_str
}
```

`run_PythonBot.py` 把 `value_add` 写进 `tVar`：

```python
var.store(indicator)
```

所以 `tVar` 里不是“价格”，而是 **策略输出的指标/偏移量**，具体由 C++ 策略解释。

### 5.2 `StrategyLogit`

`StrategyLogit` 使用：

```text
up_model_path
dn_model_path
models/*.csv
```

它是另一类模型策略，和 CSO 共用同一个运行框架，但模型来自 CSV。

---

## 6. 与 C++ TB 的闭环

```text
C++ PairwiseArb
  m_tcache->store("<sid>_pos_<instrument>", netpos)
        │
        ▼
PythonBot
  cache.load(pos_str)
  onPos(netpos)
        │
        ▼
PythonBot 计算 value_add
  var.store(value_add)
        │
        ▼
C++ PairwiseArb
  m_tvar->load()
  SendMonitorStratDetail("TValue", value)
        │
        ▼
tbadmin
  ProcessPyBotValue
  PyBot.Value
```

重要结论：

```text
PyBot.Value 不是 PythonBot 直接上报
它是 C++ 策略读取 tVar 后再写入 memlog 的值
```

如果 C++ TB 不在跑，或者没有配置 `TVAR_KEY`，PythonBot 即使运行，`PyBot.Value` 也不会更新。

---

## 7. 与 tbadmin PyBot 表的映射

| tbadmin 字段 | 实际来源 | 当前状态 |
|---|---|---|
| `State` | `ps -ef | grep PythonBot` | 进程存在性，不是心跳 |
| `StrategyID` | PythonBot `settings/<sid>.json` 文件名 / 命令行 | tbadmin 扫描路径可能对不上 |
| `Model` | `tbhft_strategy.ModelFile` | 不是 PythonBot 的 `settings`/`models` |
| `Value` | PythonBot `tVar` -> C++ `TValue` memlog | 需要 C++ TB 运行 |
| `Log` | PythonBot 写文件日志；tbadmin 读 `PYBOT_KEY` ShmLog | 当前没有接上 |

### 7.1 `PYBOT_PATH` 路径错位

tbadmin：

```text
PYBOT_PATH=./py
InitPyBot() 只扫描该目录下的 <id>.json
```

PythonBot：

```text
settings/<sid>.json
```

当前仓库布局是：

```text
py/settings/41131.json
```

tbadmin 不会递归扫描 `settings/`。生产环境可能通过拷贝/软链解决，但当前源码布局不一致。

### 7.2 `PYBOT_KEY` 日志没有生产者

PythonBot 的 `writeLog()`：

```python
filehandler = logging.FileHandler(
    WORKDIR + '/logs/python_signal_<sid>_<date>.log'
)
```

它写文件，不写 `ShmLog`。

tbadmin 读：

```text
PYBOT_KEY -> ShmLog
```

默认：

```text
PYBOT_KEY=0
```

当前 PythonBot 源码里没有写 `PYBOT_KEY` ShmLog 的代码。因此：

```text
PyBot.Log 很可能为空
```

### 7.3 `Model` 语义不一致

tbadmin：

```text
Model = m_ctls[strategyID].ModelFile
```

PythonBot：

```text
settings/<sid>.json
models/*.csv
StrategyCSO / StrategyLogit
```

所以 `Model` 列不是 PythonBot 的模型配置，可能是空的或指向 C++ 策略 model。

---

## 8. 与 146 的关系

146 没有 PythonBot。

146 有：

```text
C++ PairwiseArbStrategy
OptionManager
DataService / ZMQ
```

PythonBot 是独立的：

```text
Python 3.8
md.so
tVar/tCache
CSO/Logit
```

它也不在 `quantlink-trading` 当前源码树中；`quantlink-trading` 只保留了 tbadmin 的监控壳。

结论：

```text
PythonBot 不是 146 的组件
146 的 C++ 策略也不依赖 PythonBot
```

---

## 9. 风险与缺陷

### 9.1 一个进程多个策略共用一个 tVar

`run_PythonBot.py`：

```python
for sid in signal_dict.keys():
    signal = signal_dict[sid]
    var.store(signal['value_add'])
```

一个 PythonBot 进程如果加载多个策略，它们会依次写同一个 `tVar`，最后一个策略覆盖前面所有策略。

当前 `settings/41131.json` 看起来只有一个策略，但框架允许多个。

### 9.2 只读第一腿仓位

`StrategyCSO`：

```python
self.pos_str = f"{self.sid}_pos_{self.contracts[0]}"
```

只读第一腿净仓，第二腿仓位不参与 `hedge_qty`。

### 9.3 `tickStrategyDict` 代码路径可疑

`loadStrategy()`：

```python
for vtSymbol in strategy.contracts:
    if vtSymbol in self.tickStrategyDict:
        l = self.strategyDict[strategy.vtSymbol]
```

这里看起来应该用 `self.tickStrategyDict[vtSymbol]`，而不是 `self.strategyDict[strategy.vtSymbol]`。多策略/多合约共享 symbol 时可能出错。

### 9.4 异常处理过强

`callStrategyFunc()` 捕获异常后：

```python
os.system("tbstop {}".format(strategy.sid))
time.sleep(5)
os.system("ps aux | grep TradeBot ... | xargs kill -9")
sys.exit()
```

一个策略异常会停止/杀死相关 TradeBot 进程，影响范围大。

### 9.5 `stop.sh` 用 `kill -9`

```bash
kill -9 $pid
```

PythonBot 的 `cleanup()` 捕获 SIGTERM/SIGINT 并写 `var.store(0)`，但 `kill -9` 不会触发 cleanup，`tVar` 可能保留旧值。

### 9.6 配置和共享内存路径硬编码

`man/createShm.py`：

```python
cfgFile = '/home/hft/tbdata/strategyShm.ini'
```

仓库根目录也有 `strategyShm.ini`，路径不一致。

### 9.7 平台绑定

`md.cpython-38-x86_64-linux-gnu.so`：

```text
Linux x86-64
Python 3.8
```

不能直接在新平台/Python 版本使用。

### 9.8 没有心跳/健康状态

tbadmin `State` 来自 `ps`，不是 PythonBot 主动心跳。

无法区分：

```text
进程在，但策略循环卡死
进程在，但 MD 没数据
进程在，但 tVar 没更新
```

---

## 10. 新系统迁移建议

如果保留 PythonBot，建议把它定义成外部信号运行时，而不是继续用 ps/共享内存黑盒：

### 10.1 明确接口

```text
PythonBotStatusFact
  strategyId
  state          RUNNING / DEGRADED / STOPPED
  heartbeatAt
  modelFile
  tvarKey
  tcacheKey
  mdKey
  reason?
```

```text
PythonBotSignalFact
  strategyId
  indicator
  signal
  position
  indInfo
  occurredAt
```

```text
PythonBotLogFact / ReadModel
  strategyId
  level
  message
  occurredAt
```

### 10.2 替代共享内存

```text
MD 输入       -> MarketDataFact / 读侧 IPC
仓位输入      -> StrategyPositionView
信号输出      -> PythonBotSignalFact
日志          -> 结构化事件
心跳          -> PythonBotStatusFact
```

### 10.3 保持执行边界

```text
PythonBot 只算信号
C++ TradeBot 负责下单/执行
PythonBot 不直接发订单
```

### 10.4 如果不保留

直接从 tbadmin/新 GUI 删除 PyBot 表：

```text
PythonBot 已废弃
没有可复现的 PythonBot 数据源
PyBot 表只剩历史壳
```

146 的 205 已经按这个方向移除 `PyBotStatusReadModel`。

---

## 11. 关键源码索引

### PythonBot

```text
run_PythonBot.py
  settings/<sid>.json
  md.Bot().Connect(md_key)
  md.tdouble() -> tVar
  md.dcache() -> tCache
  var.store(indicator)
  writeLog -> logs/python_signal_<sid>_<date>.log

strategy/strategyCSO.py
  StrategyCSO
  cso_para
  onTick
  value_add
  pos_str

strategy/strategyLogit.py
  StrategyLogit
  up_model_path / dn_model_path
  models/*.csv

man/createShm.py
  tVar_key
  tCache_key

man/rmShm.py
  ipcrm -M

stop.sh
  kill -9
```

### C++ / tbadmin

```text
tbsrc/Strategies/ExecutionStrategy.cpp
  m_tvar->init(TVAR_KEY)
  m_tcache->init(TCACHE_KEY)

tbsrc/Strategies/PairwiseArbStrategy.cpp
  m_tvar->load()
  SendMonitorStratDetail("TValue", ...)
  m_tcache->store("<sid>_pos_<instrument>", netpos)

tbadmin/admin.cpp
  InitPyBot()
  CheckPyBot()
  ProcessPyBotValue()
  ProcessPyBotLogMsg()
  DumpPyBotTable()

tbadmin/cfg/agent.cfg
  PYBOT_PATH=./py
  PYBOT_KEY=0
```

---

## 12. 最终判断

```text
PythonBot 是一个真实存在的独立 Python 信号运行时
有完整源码、配置、模型和共享内存接口
但它不是 146 的组件
也不是 quantlink-trading 当前源码树的一部分
```

tbadmin 的 PyBot 表是：

```text
PythonBot 进程 + settings 文件名
+ C++ TValue 回传
+ 一个没有接通的日志通道
+ 一个来自 DB 的 Model 列
```

所以它不能作为新系统的核心字段模型，只能作为兼容层或历史监控视图。

> 本报告只做只读分析，没有运行 PythonBot，也没有修改 PythonBot / tbsrc / tbadmin 代码。

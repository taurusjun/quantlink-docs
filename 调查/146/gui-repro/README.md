# 146 Qt HTML Repro

基于 `146/03-qt-gui.md` 和 Qt5 `SkylineFL_GUI` 的结构做的静态 HTML 复现。

打开：

```text
index.html
```

文件：

```text
index.html   窗口、表格、弹窗结构
styles.css   Qt 桌面风格
app.js       MockHub / 表格渲染 / 窗口拖动 / 交互
```

复现的窗口：

```text
Strategy
FairValue
Position
OpenOrder
FillResponse
OrderResponse
Console
ContractWindow
```

交互：

```text
Connect / Start / Stop / Lock
参数编辑
右键策略行打开 ContractWindow
点击盘口价格打开下单弹窗
右键盘口撤销最近挂单
双击 OpenOrder 改单
Cancel All 随机码确认
Position Group / Mult / Fees 编辑并重算 PNL
Fills CSV 导出
窗口拖动 / 置顶 / 关闭 / 最小化
```

这是 demo：

```text
没有真实 ZMQ
没有真实 DataService
没有真实 ORS
```

`MockHub` 只在浏览器内模拟 `port|key#args` 消息。

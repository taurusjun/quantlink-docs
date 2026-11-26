# T-023 Electron 桌面壳验收证据

执行日期：2026-11-08
平台：macOS arm64（Windows 安装包待 Windows 测试机）
应用：`desktop/release/mac-arm64/quantlink-fin.app`
连接：`https://101.43.54.190:8443`

## 启动与 preload

```text
title=quantlink-fin
bridge=true
electron=45.2.3
chrome=156.0.8078.80
version=0.1.0
```

## 多窗口

```text
openWindow('/orders') = true
openMonitor() = true
windows = 3
```

## 离线缓存

```text
offlineSave('smoke', [...]) = true
offlineLoad('smoke') = [{"id":"one","value":1}]
offlineStatus = {"available":true,"rows":116}
```

## 通知 / 置顶

```text
notify = true
setAlwaysOnTop = true
```

## 快捷键

```text
CommandOrControl+Shift+Q = registered
CommandOrControl+Shift+M = registered
toggleWindow = true
```

## 窗口布局恢复

首次设置并关闭：

```json
{"x":120,"y":80,"width":1520,"height":940}
```

重新启动后：

```json
{"x":120,"y":80,"width":1385,"height":875}
```

坐标恢复；宽高被当前屏幕可用区域约束。

## 截图

- `docs/evidence/T-023/desktop-main.png`
- `docs/evidence/T-023/desktop-monitor.png`

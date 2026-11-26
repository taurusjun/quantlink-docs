# 146 Qt4 GUI HTML Reproduction

Static HTML facsimile of the old Qt4 `TradingSystemsGUI`.

Source of truth:

```text
/Volumes/DevDisk/146/3/dalong/infrastructure/TradingSystemsGUI
146/03-qt-gui.md
```

Open:

```text
index.html
```

Files:

```text
index.html   window, menu bar, exchange tabs, three sub-tabs
styles.css   Qt4 / CentOS-era desktop styling
app.js       mock data, table rendering, menus, dialogs, MDI books
```

## Reproduced structure

```text
Trading Systems Monitor
  Connection / Action / Help
  [NSE_FO] [BSE] [CME]
    Orders | Net Positions | Market Data
  status bar
```

### Orders

- `Open Orders:` search box
- 16-column open-order table: Account / Symbol / Instr / Status / ID / Trans / OpType / SPrice / Expiry / Price / Qty / LTT / QtyFill / Type / DQty / Source
- `Cancel All`, `Cancel/Modify Order`, `Place Order`
- Right-click order: Cancel Order / Modify Order
- `Place Order` opens the `Send Order` dialog from `PlaceOrderWidget`

### Net Positions

- 30-column table in `NetPnlModel` order: Account / Symbol / Instr / Qty / PnL / Yield / Expiry / SPrice / OpType / LTP / LTT / Trade% / Source / RPnL / URPnl / NetBuyQty / NetSellQty / NetBuy(L) / NetSell(L) / NetVal(L) / NetExp(L) / 1MinPnL / 5MinPnL / 10MinPnL / 1MinDiff / 5MinDiff / 10MinDiff / OVNNetExp(L) / OVNPnL / IDPnL
- PnL background: positive green, negative red
- bottom totals grid: Options / Futures / Equities / Total × PnL / Inst / Buy Value(L) / Sell Value(L) / Net Value(L) / Net Exp(L) / Open / 1 Min / 5 Min / 10 Min / Ovn / IDay
- search, `Use Dynamic Sort`, `PnL in K?`
- right-click position: Square Off / View Market Data

### Market Data

- `Ticker:` input + exchange combo
- `QMdiArea`-style canvas
- `MarketDataWidget`-style 20-level book: Buy Qty / Buy / Sell / Sell Qty
- ticker Enter opens a book
- right-click a price: Place Order
- MDI windows can be focused, dragged and closed

## Mock data

All rows are local mock values inspired by the 2015 NSE/BSE/CME setup:

```text
NSE_FO : NIFTY / BANKNIFTY / RELIANCE / HDFCBANK / INFY / TCS / SBIN / AXISBANK
BSE    : SENSEX / SBIN / RELIANCE / TCS / BANKEX
CME    : GOLD / SILVER / COPPER / CRUDE / NATGAS
```

No real account, credential, order, ORS, DataService or ZMQ traffic is used.

## Differences from the source

- Source default tab is `Orders` because it is added first to the inner `QTabWidget`; this repro defaults to `Net Positions` to show the 30-column table first.
- `Completed Orders` is not rendered because `SHOW_TRADES` is not defined in the archived build.
- `ConnectDialog` / `ChooseExchangeDialog` are not reproduced; menu entries show a demo notice.
- PnL totals are recomputed from the mock rows, not from `NetPnlInfo`.
- Source uses `QTableView` / `QTableWidget`; this is an HTML table with the same column order.
- Geometry is approximate; the source-only archive has no Qt4 screenshot.

## Interactions

```text
exchange tabs           switch NSE_FO / BSE / CME
Orders / Net Positions / Market Data   switch sub-tab
header click             sort column
Search...                filter rows
PnL in K?                toggle total PnL units
Use Dynamic Sort         sort positions by PnL descending
right-click              context menu
Ticker + Enter           open 20-level book
Place Order              Send Order dialog (mock)
title bar double-click   maximize / restore
```

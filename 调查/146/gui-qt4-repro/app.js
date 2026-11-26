/* 146 Qt4 TradingSystemsGUI — static HTML reproduction.
 * Source: 3/dalong/infrastructure/TradingSystemsGUI
 * No ZMQ, DataService, ORS or real orders.
 */

const EXCHANGES = ["NSE_FO", "BSE", "CME"];

const NET_COLUMNS = [
  { key: "account", label: "Account", width: 78, align: "left" },
  { key: "symbol", label: "Symbol", width: 148, align: "left" },
  { key: "instr", label: "Instr", width: 76, align: "left" },
  { key: "qty", label: "Qty", width: 54, align: "num" },
  { key: "pnl", label: "PnL", width: 68, align: "num" },
  { key: "yield", label: "Yield", width: 58, align: "num" },
  { key: "expiry", label: "Expiry", width: 66, align: "num" },
  { key: "sprice", label: "SPrice", width: 62, align: "num" },
  { key: "optype", label: "OpType", width: 58, align: "left" },
  { key: "ltp", label: "LTP", width: 72, align: "num" },
  { key: "ltt", label: "LTT", width: 60, align: "num" },
  { key: "trade", label: "Trade%", width: 58, align: "num" },
  { key: "source", label: "Source", width: 66, align: "left" },
  { key: "rpnl", label: "RPnL", width: 66, align: "num" },
  { key: "urpnl", label: "URPnl", width: 66, align: "num" },
  { key: "netBuyQty", label: "NetBuyQty", width: 78, align: "num" },
  { key: "netSellQty", label: "NetSellQty", width: 80, align: "num" },
  { key: "netBuyVal", label: "NetBuy(L)", width: 76, align: "num" },
  { key: "netSellVal", label: "NetSell(L)", width: 80, align: "num" },
  { key: "netVal", label: "NetVal(L)", width: 76, align: "num" },
  { key: "netExp", label: "NetExp(L)", width: 78, align: "num" },
  { key: "pnl1", label: "1MinPnL", width: 70, align: "num" },
  { key: "pnl5", label: "5MinPnL", width: 70, align: "num" },
  { key: "pnl10", label: "10MinPnL", width: 74, align: "num" },
  { key: "diff1", label: "1MinDiff", width: 70, align: "num" },
  { key: "diff5", label: "5MinDiff", width: 70, align: "num" },
  { key: "diff10", label: "10MinDiff", width: 74, align: "num" },
  { key: "ovnNetExp", label: "OVNNetExp(L)", width: 90, align: "num" },
  { key: "ovnPnl", label: "OVNPnL", width: 68, align: "num" },
  { key: "idPnl", label: "IDPnL", width: 66, align: "num" }
];

const ORDER_COLUMNS = [
  { key: "account", label: "Account", width: 78, align: "left" },
  { key: "symbol", label: "Symbol", width: 148, align: "left" },
  { key: "instr", label: "Instr", width: 76, align: "left" },
  { key: "status", label: "Status", width: 76, align: "left" },
  { key: "id", label: "ID", width: 76, align: "num" },
  { key: "trans", label: "Trans", width: 52, align: "center" },
  { key: "optype", label: "OpType", width: 58, align: "left" },
  { key: "sprice", label: "SPrice", width: 62, align: "num" },
  { key: "expiry", label: "Expiry", width: 66, align: "num" },
  { key: "price", label: "Price", width: 66, align: "num" },
  { key: "qty", label: "Qty", width: 54, align: "num" },
  { key: "ltt", label: "LTT", width: 60, align: "num" },
  { key: "qtyFill", label: "QtyFill", width: 62, align: "num" },
  { key: "type", label: "Type", width: 46, align: "num" },
  { key: "dqty", label: "DQty", width: 52, align: "num" },
  { key: "source", label: "Source", width: 66, align: "left" }
];

const TOTALS_COLUMNS = [
  "PnL",
  "Inst",
  "Buy Value(L)",
  "Sell Value(L)",
  "Net Value(L)",
  "Net Exp(L)",
  "Open",
  "1 Min",
  "5 Min",
  "10 Min",
  "Ovn",
  "IDay"
];

const TOTALS_ROWS = ["Options", "Futures", "Equities", "Total"];

function makePosition(config) {
  const {
    account = "A1",
    symbol,
    instr,
    qty,
    pnl,
    optype = "X",
    ltp,
    ltt = "15:22:08",
    source,
    expiry = "20150625",
    sprice = 0,
    yieldPct = 0,
    tradePct = 0,
    mult = 1,
    ovnPnl
  } = config;

  const absQty = Math.abs(qty);
  const netBuyQty = qty > 0 ? qty : 0;
  const netSellQty = qty < 0 ? -qty : 0;
  const notional = absQty * ltp * mult;
  const netBuyVal = qty > 0 ? Math.round(notional / 100000) : 0;
  const netSellVal = qty < 0 ? Math.round(notional / 100000) : 0;
  const netVal = netBuyVal - netSellVal;
  const netExp = Math.abs(netVal);
  const unrealized = Math.round(pnl * 0.18);
  const realized = pnl - unrealized;
  const ovn = ovnPnl ?? Math.round(pnl * 0.94);
  const pnl1 = pnl - 1200;
  const pnl5 = pnl1 - 300;
  const pnl10 = pnl1 - 700;

  return {
    account,
    symbol,
    instr,
    qty,
    pnl,
    yield: yieldPct,
    expiry,
    sprice,
    optype,
    ltp,
    ltt,
    trade: tradePct,
    source,
    rpnl: realized,
    urpnl: unrealized,
    netBuyQty,
    netSellQty,
    netBuyVal,
    netSellVal,
    netVal,
    netExp,
    pnl1,
    pnl5,
    pnl10,
    diff1: pnl - pnl1,
    diff5: pnl - pnl5,
    diff10: pnl - pnl10,
    ovnNetExp: netExp,
    ovnPnl: ovn,
    idPnl: pnl - ovn
  };
}

function makeOrder(config) {
  const {
    account = "A1",
    symbol,
    instr,
    status = "NEW",
    id,
    trans,
    optype = "X",
    sprice = 0,
    expiry = "20150625",
    price,
    qty,
    ltt,
    qtyFill = 0,
    type = 0,
    dqty,
    source
  } = config;

  return {
    account,
    symbol,
    instr,
    status,
    id,
    trans,
    optype,
    sprice,
    expiry,
    price,
    qty,
    ltt,
    qtyFill,
    type,
    dqty: dqty ?? qty,
    source
  };
}

const rawData = {
  NSE_FO: {
    positions: [
      makePosition({ symbol: "NIFTY_F_0_NSE", instr: "NIFTY", qty: 150, ltp: 8123.5, pnl: 182400, yieldPct: 0.214, tradePct: 0.412, mult: 75, source: "NSE_FO" }),
      makePosition({ symbol: "BANKNIFTY_F_0_NSE", instr: "BANKNIFTY", qty: -75, ltp: 17840.2, pnl: -96400, yieldPct: -0.118, tradePct: 0.287, mult: 40, source: "NSE_FO" }),
      makePosition({ symbol: "RELIANCE_EQ_NSE", instr: "RELIANCE_EQ", qty: 1200, ltp: 892.4, pnl: 52800, yieldPct: 0.064, tradePct: 0.152, optype: "", expiry: "", source: "NSE_FO" }),
      makePosition({ symbol: "HDFCBANK_EQ_NSE", instr: "HDFCBANK_EQ", qty: -800, ltp: 1042.6, pnl: -31200, yieldPct: -0.042, tradePct: 0.117, optype: "", expiry: "", source: "NSE_FO" }),
      makePosition({ symbol: "NIFTY15JUN9000CE", instr: "NIFTY", qty: -75, ltp: 148.25, pnl: -48200, yieldPct: -0.087, tradePct: 0.203, optype: "CE", sprice: 9000, mult: 75, source: "NSE_FO" }),
      makePosition({ symbol: "NIFTY15JUN8200PE", instr: "NIFTY", qty: 150, ltp: 96.4, pnl: 27400, yieldPct: 0.051, tradePct: 0.168, optype: "PE", sprice: 8200, mult: 75, source: "NSE_FO" }),
      makePosition({ symbol: "INFY_F_0_NSE", instr: "INFY", qty: 300, ltp: 1985.5, pnl: 84300, yieldPct: 0.096, tradePct: 0.231, mult: 125, source: "NSE_FO" }),
      makePosition({ symbol: "TCS_F_0_NSE", instr: "TCS", qty: -150, ltp: 2540.0, pnl: -22600, yieldPct: -0.029, tradePct: 0.143, mult: 125, source: "NSE_FO" }),
      makePosition({ symbol: "SBIN_EQ_NSE", instr: "SBIN_EQ", qty: 2000, ltp: 278.3, pnl: 18600, yieldPct: 0.038, tradePct: 0.091, optype: "", expiry: "", source: "NSE_FO" }),
      makePosition({ symbol: "AXISBANK_F_0_NSE", instr: "AXISBANK", qty: 450, ltp: 612.8, pnl: 39100, yieldPct: 0.073, tradePct: 0.164, mult: 625, source: "NSE_FO" })
    ],
    orders: [
      makeOrder({ symbol: "NIFTY_F_0_NSE", instr: "NIFTY", status: "NEW", id: 18000375, trans: "B", price: 8124.0, qty: 75, ltt: "15:21:42", source: "NSE_FO" }),
      makeOrder({ symbol: "BANKNIFTY_F_0_NSE", instr: "BANKNIFTY", status: "PARTIAL", id: 18000374, trans: "S", price: 17845.0, qty: 75, ltt: "15:21:36", qtyFill: 30, source: "NSE_FO" }),
      makeOrder({ symbol: "NIFTY15JUN9000CE", instr: "NIFTY", status: "NEW", id: 18000373, trans: "S", optype: "CE", sprice: 9000, price: 149.5, qty: 75, ltt: "15:20:58", source: "NSE_FO" }),
      makeOrder({ symbol: "RELIANCE_EQ_NSE", instr: "RELIANCE_EQ", status: "MODIFIED", id: 18000372, trans: "B", optype: "", expiry: "", price: 891.8, qty: 600, ltt: "15:20:12", source: "NSE_FO" }),
      makeOrder({ symbol: "INFY_F_0_NSE", instr: "INFY", status: "NEW", id: 18000371, trans: "B", price: 1984.5, qty: 150, ltt: "15:19:44", source: "NSE_FO" }),
      makeOrder({ symbol: "TCS_F_0_NSE", instr: "TCS", status: "NEW", id: 18000370, trans: "S", price: 2542.0, qty: 150, ltt: "15:19:10", source: "NSE_FO" }),
      makeOrder({ symbol: "NIFTY15JUN8200PE", instr: "NIFTY", status: "CANCELLED", id: 18000369, trans: "B", optype: "PE", sprice: 8200, price: 95.8, qty: 75, ltt: "15:18:52", source: "NSE_FO" }),
      makeOrder({ symbol: "SBIN_EQ_NSE", instr: "SBIN_EQ", status: "NEW", id: 18000368, trans: "S", optype: "", expiry: "", price: 278.6, qty: 1000, ltt: "15:18:20", source: "NSE_FO" })
    ]
  },
  BSE: {
    positions: [
      makePosition({ symbol: "SENSEX_F_0_BSE", instr: "SENSEX", qty: 60, ltp: 27420.5, pnl: 64200, yieldPct: 0.087, tradePct: 0.192, mult: 25, source: "BSE" }),
      makePosition({ symbol: "SBIN_EQ_BSE", instr: "SBIN_EQ", qty: 1500, ltp: 278.1, pnl: 12400, yieldPct: 0.031, tradePct: 0.074, optype: "", expiry: "", source: "BSE" }),
      makePosition({ symbol: "RELIANCE_EQ_BSE", instr: "RELIANCE_EQ", qty: -900, ltp: 891.9, pnl: -18800, yieldPct: -0.026, tradePct: 0.083, optype: "", expiry: "", source: "BSE" }),
      makePosition({ symbol: "TCS_EQ_BSE", instr: "TCS_EQ", qty: 400, ltp: 2538.5, pnl: 9600, yieldPct: 0.019, tradePct: 0.061, optype: "", expiry: "", source: "BSE" }),
      makePosition({ symbol: "BANKEX_F_0_BSE", instr: "BANKEX", qty: -30, ltp: 20810.0, pnl: -14200, yieldPct: -0.023, tradePct: 0.088, mult: 15, source: "BSE" })
    ],
    orders: [
      makeOrder({ symbol: "SENSEX_F_0_BSE", instr: "SENSEX", status: "NEW", id: 28000241, trans: "B", price: 27425.0, qty: 30, ltt: "15:21:48", source: "BSE" }),
      makeOrder({ symbol: "RELIANCE_EQ_BSE", instr: "RELIANCE_EQ", status: "PARTIAL", id: 28000240, trans: "S", optype: "", expiry: "", price: 892.1, qty: 900, ltt: "15:21:12", qtyFill: 300, source: "BSE" }),
      makeOrder({ symbol: "SBIN_EQ_BSE", instr: "SBIN_EQ", status: "NEW", id: 28000239, trans: "B", optype: "", expiry: "", price: 278.0, qty: 500, ltt: "15:20:39", source: "BSE" }),
      makeOrder({ symbol: "BANKEX_F_0_BSE", instr: "BANKEX", status: "NEW", id: 28000238, trans: "S", price: 20815.0, qty: 15, ltt: "15:20:04", source: "BSE" })
    ]
  },
  CME: {
    positions: [
      makePosition({ symbol: "GOLD_F_0_CME", instr: "GOLD", qty: 5, ltp: 1184.3, pnl: 15600, yieldPct: 0.044, tradePct: 0.103, mult: 100, source: "CME", expiry: "20150626" }),
      makePosition({ symbol: "SILVER_F_0_CME", instr: "SILVER", qty: -3, ltp: 16.12, pnl: -8400, yieldPct: -0.031, tradePct: 0.087, mult: 5000, source: "CME", expiry: "20150626" }),
      makePosition({ symbol: "COPPER_F_0_CME", instr: "COPPER", qty: 10, ltp: 2.742, pnl: 6200, yieldPct: 0.027, tradePct: 0.079, mult: 25000, source: "CME", expiry: "20150626" }),
      makePosition({ symbol: "CRUDE_F_0_CME", instr: "CRUDE", qty: -4, ltp: 59.84, pnl: -11200, yieldPct: -0.041, tradePct: 0.112, mult: 1000, source: "CME", expiry: "20150626" }),
      makePosition({ symbol: "NATGAS_F_0_CME", instr: "NATGAS", qty: 6, ltp: 2.83, pnl: 4300, yieldPct: 0.018, tradePct: 0.058, mult: 10000, source: "CME", expiry: "20150626" })
    ],
    orders: [
      makeOrder({ symbol: "GOLD_F_0_CME", instr: "GOLD", status: "NEW", id: 38000126, trans: "B", price: 1184.5, qty: 2, ltt: "15:21:31", source: "CME", expiry: "20150626" }),
      makeOrder({ symbol: "SILVER_F_0_CME", instr: "SILVER", status: "NEW", id: 38000125, trans: "S", price: 16.14, qty: 2, ltt: "15:20:47", source: "CME", expiry: "20150626" }),
      makeOrder({ symbol: "COPPER_F_0_CME", instr: "COPPER", status: "PARTIAL", id: 38000124, trans: "B", price: 2.744, qty: 5, ltt: "15:20:06", qtyFill: 2, source: "CME", expiry: "20150626" }),
      makeOrder({ symbol: "CRUDE_F_0_CME", instr: "CRUDE", status: "NEW", id: 38000123, trans: "S", price: 59.88, qty: 2, ltt: "15:19:28", source: "CME", expiry: "20150626" })
    ]
  }
};

const data = {};
for (const exchange of EXCHANGES) {
  data[exchange] = {
    positions: rawData[exchange].positions.map((row, index) => ({
      ...row,
      _id: `${exchange}-p-${index}`
    })),
    orders: rawData[exchange].orders.map((row, index) => ({
      ...row,
      _id: `${exchange}-o-${index}`
    }))
  };
}

const BASE_PRICES = {
  NIFTY15JUNFUT: 8123.5,
  BANKNIFTY15JUNFUT: 17840.2,
  SENSEX15JUNFUT: 27420.5,
  GOLDQ5: 1184.3,
  SILVERN5: 16.12,
  COPPERQ5: 2.742,
  CRUDEN5: 59.84
};

const marketWindows = {
  NSE_FO: [
    { ticker: "NIFTY15JUNFUT", x: 24, y: 18, w: 320, h: 424 },
    { ticker: "BANKNIFTY15JUNFUT", x: 360, y: 54, w: 320, h: 424 }
  ],
  BSE: [{ ticker: "SENSEX15JUNFUT", x: 34, y: 24, w: 320, h: 424 }],
  CME: [{ ticker: "GOLDQ5", x: 40, y: 28, w: 320, h: 424 }]
};

const state = {
  exchange: "NSE_FO",
  tab: "net",
  netSearch: "",
  orderSearch: "",
  pnlInK: true,
  dynamicSort: false,
  netSort: { key: null, dir: 1 },
  orderSort: { key: null, dir: 1 },
  selectedNetId: null,
  selectedOrderId: null,
  marketZ: 10
};

let toastTimer = null;
let modalActionHandler = null;
let dragState = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function fmt(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function getPositions() {
  return data[state.exchange].positions;
}

function getOrders() {
  return data[state.exchange].orders;
}

function getFilteredPositions() {
  const query = state.netSearch.trim().toLowerCase();
  let rows = getPositions().filter((row) => {
    if (!query) return true;
    return NET_COLUMNS.some((column) => String(row[column.key]).toLowerCase().includes(query));
  });

  if (state.dynamicSort) {
    rows = rows.slice().sort((a, b) => b.pnl - a.pnl);
  }
  if (state.netSort.key) {
    rows = sortRows(rows, state.netSort.key, state.netSort.dir);
  }
  return rows;
}

function getFilteredOrders() {
  const query = state.orderSearch.trim().toLowerCase();
  let rows = getOrders().filter((row) => {
    if (!query) return true;
    return ORDER_COLUMNS.some((column) => String(row[column.key]).toLowerCase().includes(query));
  });
  if (state.orderSort.key) {
    rows = sortRows(rows, state.orderSort.key, state.orderSort.dir);
  }
  return rows;
}

function sortRows(rows, key, dir) {
  return rows.slice().sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (typeof left === "number" && typeof right === "number") {
      return (left - right) * dir;
    }
    return String(left).localeCompare(String(right), undefined, { numeric: true }) * dir;
  });
}

function renderNetColumns() {
  $("#positionCols").innerHTML = NET_COLUMNS
    .map((column) => `<col style="width:${column.width}px">`)
    .join("");
}

function renderOrderColumns() {
  $("#orderCols").innerHTML = ORDER_COLUMNS
    .map((column) => `<col style="width:${column.width}px">`)
    .join("");
}

function sortMark(key, sort) {
  if (sort.key !== key) return "";
  return `<span class="sort-mark">${sort.dir > 0 ? "▲" : "▼"}</span>`;
}

function renderNet() {
  const rows = getFilteredPositions();
  $("#positionHead").innerHTML = `<tr>${NET_COLUMNS.map((column) => {
    const classes = [column.align === "num" ? "num" : "", "sortable"].filter(Boolean).join(" ");
    return `<th data-key="${column.key}" class="${classes}">${escapeHtml(column.label)}${sortMark(column.key, state.netSort)}</th>`;
  }).join("")}</tr>`;

  const body = $("#positionBody");
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="${NET_COLUMNS.length}">No positions match the current filter.</td></tr>`;
  } else {
    body.innerHTML = rows.map((row) => {
      const selected = state.selectedNetId === row._id ? " is-selected" : "";
      const cells = NET_COLUMNS.map((column) => {
        const value = row[column.key];
        const classes = [];
        if (column.align === "num") classes.push("num");
        if (column.key === "pnl") classes.push("pnl-cell", row.pnl >= 0 ? "pos" : "neg");
        const title = value === null || value === undefined ? "" : ` title="${escapeHtml(value)}"`;
        return `<td class="${classes.join(" ")}"${title}>${escapeHtml(fmt(value))}</td>`;
      }).join("");
      return `<tr data-id="${row._id}" class="${selected.trim()}">${cells}</tr>`;
    }).join("");
  }

  renderTotals(rows);
  updateSelectedRowClasses();
}

function renderOrders() {
  const rows = getFilteredOrders();
  $("#orderHead").innerHTML = `<tr>${ORDER_COLUMNS.map((column) => {
    const classes = [column.align === "num" ? "num" : "", "sortable"].filter(Boolean).join(" ");
    return `<th data-key="${column.key}" class="${classes}">${escapeHtml(column.label)}${sortMark(column.key, state.orderSort)}</th>`;
  }).join("")}</tr>`;

  const body = $("#orderBody");
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="${ORDER_COLUMNS.length}">No open orders match the current filter.</td></tr>`;
  } else {
    body.innerHTML = rows.map((row) => {
      const selected = state.selectedOrderId === row._id ? " is-selected" : "";
      const cells = ORDER_COLUMNS.map((column) => {
        const value = row[column.key];
        const classes = [];
        if (column.align === "num") classes.push("num");
        if (column.align === "center") classes.push("center");
        const title = value === null || value === undefined ? "" : ` title="${escapeHtml(value)}"`;
        return `<td class="${classes.join(" ")}"${title}>${escapeHtml(fmt(value))}</td>`;
      }).join("");
      return `<tr data-id="${row._id}" class="${selected.trim()}">${cells}</tr>`;
    }).join("");
  }
  updateSelectedRowClasses();
}

function blankTotals() {
  return {
    pnl: 0,
    inst: 0,
    buy: 0,
    sell: 0,
    netVal: 0,
    netExp: 0,
    open: 0,
    pnl1: 0,
    pnl5: 0,
    pnl10: 0,
    ovn: 0
  };
}

function addTotals(target, row) {
  target.pnl += row.pnl;
  target.inst += 1;
  target.buy += row.netBuyVal;
  target.sell += row.netSellVal;
  target.netVal += row.netVal;
  target.netExp += row.netExp;
  target.open += row.qty !== 0 ? 1 : 0;
  target.pnl1 += row.pnl1;
  target.pnl5 += row.pnl5;
  target.pnl10 += row.pnl10;
  target.ovn += row.ovnPnl;
}

function groupOf(row) {
  if (String(row.instr).includes("EQ")) return "Equities";
  if (String(row.optype).trim().toUpperCase() === "X") return "Futures";
  return "Options";
}

function renderTotals(rows) {
  const groups = {
    Options: blankTotals(),
    Futures: blankTotals(),
    Equities: blankTotals(),
    Total: blankTotals()
  };

  for (const row of rows) {
    const group = groupOf(row);
    addTotals(groups[group], row);
    addTotals(groups.Total, row);
  }

  const pnlText = (value) => String(Math.round(value / (state.pnlInK ? 1000 : 1)));
  const valueClass = (value) => value < 0 ? "neg" : value > 0 ? "pos" : "";

  const html = [
    `<thead><tr><th></th>${TOTALS_COLUMNS.map((label) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead>`,
    "<tbody>",
    TOTALS_ROWS.map((name) => {
      const group = groups[name];
      const idPnl = group.pnl - group.ovn;
      const values = [
        pnlText(group.pnl),
        String(group.inst),
        String(group.buy),
        String(group.sell),
        String(group.netVal),
        String(group.netExp),
        String(group.open),
        pnlText(group.pnl1),
        pnlText(group.pnl5),
        pnlText(group.pnl10),
        pnlText(group.ovn),
        pnlText(idPnl)
      ];
      const numericValues = [group.pnl, 0, 0, 0, 0, 0, 0, group.pnl1, group.pnl5, group.pnl10, group.ovn, idPnl];
      const cells = values.map((value, index) => {
        const cls = index === 1 || index >= 7 ? valueClass(numericValues[index]) : "";
        return `<td class="${cls}">${escapeHtml(value)}</td>`;
      }).join("");
      return `<tr class="${name === "Total" ? "total-row" : ""}"><td>${escapeHtml(name)}:</td>${cells}</tr>`;
    }).join(""),
    "</tbody>"
  ].join("");

  $("#totalsTable").innerHTML = html;
}

function renderMarketData() {
  const area = $("#mdiArea");
  const windows = marketWindows[state.exchange] || [];
  if (!windows.length) {
    area.innerHTML = `<div class="mdi-empty">Type a ticker above and press Enter.</div>`;
    return;
  }

  area.innerHTML = windows.map((window, index) => {
    const book = makeBook(window.ticker);
    const rows = book.map((level) => `<tr>
      <td>${escapeHtml(level.bidQty)}</td>
      <td>${escapeHtml(level.bid)}</td>
      <td>${escapeHtml(level.ask)}</td>
      <td>${escapeHtml(level.askQty)}</td>
    </tr>`).join("");

    return `<div class="mdi-window" data-ticker="${escapeHtml(window.ticker)}" style="left:${window.x}px;top:${window.y}px;width:${window.w}px;height:${window.h}px;z-index:${10 + index}">
      <div class="mdi-titlebar">
        <span class="mdi-title">${escapeHtml(window.ticker)}</span>
        <button type="button" class="mdi-close" data-close-book="${escapeHtml(window.ticker)}" aria-label="Close ${escapeHtml(window.ticker)}">×</button>
      </div>
      <div class="mdi-body">
        <table class="book-table">
          <colgroup><col style="width:25%"><col style="width:25%"><col style="width:25%"><col style="width:25%"></colgroup>
          <thead><tr><th>Buy Qty</th><th>Buy</th><th>Sell</th><th>Sell Qty</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }).join("");
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function makeBook(ticker) {
  const base = BASE_PRICES[ticker] || 100 + (hashString(ticker) % 900);
  const tick = base > 1000 ? 0.5 : base > 100 ? 0.05 : 0.001;
  const decimals = base >= 100 ? 2 : 4;
  const seed = hashString(ticker);

  return Array.from({ length: 20 }, (_, index) => {
    if (index >= 12) {
      return { bidQty: "-", bid: "-", ask: "-", askQty: "-" };
    }
    const bid = base - index * tick;
    const ask = base + tick + index * tick;
    const bidQty = 75 + ((seed + index * 37) % 900);
    const askQty = 75 + ((seed + index * 53 + 19) % 900);
    return {
      bidQty: String(bidQty),
      bid: bid.toFixed(decimals),
      ask: ask.toFixed(decimals),
      askQty: String(askQty)
    };
  });
}

function renderTabs() {
  $$(".exchange-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.exchange === state.exchange);
  });
  $$(".sub-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === state.tab);
  });
  $$(".page").forEach((page) => {
    page.hidden = page.dataset.page !== state.tab;
  });
  $("#marketExchange").value = state.exchange;
}

function renderAll() {
  renderTabs();
  renderNet();
  renderOrders();
  if (state.tab === "market") renderMarketData();
  updateStatus();
}

function selectExchange(exchange) {
  if (!EXCHANGES.includes(exchange)) return;
  state.exchange = exchange;
  state.selectedNetId = null;
  state.selectedOrderId = null;
  renderAll();
}

function selectTab(tab) {
  state.tab = tab;
  renderTabs();
  if (tab === "net") renderNet();
  if (tab === "orders") renderOrders();
  if (tab === "market") renderMarketData();
  updateStatus();
}

function updateStatus() {
  $("#statusExchange").textContent = state.exchange;
  $("#statusCount").textContent = `${getPositions().length} positions · ${getOrders().length} orders`;
  $("#statusConnection").textContent = "DataService connected";
  $("#statusDot").style.background = "#2e9b4f";
}

function updateSelectedRowClasses() {
  $$("#positionBody tr[data-id]").forEach((row) => {
    row.classList.toggle("is-selected", row.dataset.id === state.selectedNetId);
  });
  $$("#orderBody tr[data-id]").forEach((row) => {
    row.classList.toggle("is-selected", row.dataset.id === state.selectedOrderId);
  });
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2800);
}

function closeMenus() {
  $$(".menu-wrap.open").forEach((menu) => menu.classList.remove("open"));
}

function setupMenus() {
  $$(".menu-wrap > .menu-label").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const wrap = button.parentElement;
      const wasOpen = wrap.classList.contains("open");
      closeMenus();
      if (!wasOpen) wrap.classList.add("open");
    });
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-wrap")) closeMenus();
  });
}

function setupTabs() {
  $$(".exchange-tab").forEach((button) => {
    button.addEventListener("click", () => selectExchange(button.dataset.exchange));
  });
  $$(".sub-tab").forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
  });
}

function setupFilters() {
  $("#positionSearch").addEventListener("input", (event) => {
    state.netSearch = event.target.value;
    renderNet();
  });

  $("#orderSearch").addEventListener("input", (event) => {
    state.orderSearch = event.target.value;
    renderOrders();
  });

  $("#dynamicSort").addEventListener("change", (event) => {
    state.dynamicSort = event.target.checked;
    renderNet();
  });

  $("#pnlInK").addEventListener("change", (event) => {
    state.pnlInK = event.target.checked;
    renderNet();
  });

  $("#positionHead").addEventListener("click", (event) => {
    const cell = event.target.closest("th[data-key]");
    if (!cell) return;
    const key = cell.dataset.key;
    state.netSort = state.netSort.key === key
      ? { key, dir: -state.netSort.dir }
      : { key, dir: 1 };
    renderNet();
  });

  $("#orderHead").addEventListener("click", (event) => {
    const cell = event.target.closest("th[data-key]");
    if (!cell) return;
    const key = cell.dataset.key;
    state.orderSort = state.orderSort.key === key
      ? { key, dir: -state.orderSort.dir }
      : { key, dir: 1 };
    renderOrders();
  });
}

function setupTableInteractions() {
  $("#positionBody").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (!row) return;
    state.selectedNetId = row.dataset.id;
    updateSelectedRowClasses();
  });

  $("#positionBody").addEventListener("contextmenu", (event) => {
    const rowElement = event.target.closest("tr[data-id]");
    if (!rowElement) return;
    event.preventDefault();
    state.selectedNetId = rowElement.dataset.id;
    updateSelectedRowClasses();

    const row = getFilteredPositions().find((item) => item._id === rowElement.dataset.id);
    if (!row) return;

    showContextMenu(event.clientX, event.clientY, [
      {
        label: "Square Off",
        shortcut: "F2",
        action: () => openPlaceOrder({
          side: row.qty < 0 ? "BUY" : "SELL",
          symbol: row.symbol,
          qty: Math.abs(row.qty),
          price: 0,
          account: row.account,
          exchange: row.source
        })
      },
      {
        label: "View Market Data",
        shortcut: "F3",
        action: () => {
          selectTab("market");
          openBook(row.symbol, state.exchange);
        }
      }
    ]);
  });

  $("#orderBody").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (!row) return;
    state.selectedOrderId = row.dataset.id;
    updateSelectedRowClasses();
  });

  $("#orderBody").addEventListener("contextmenu", (event) => {
    const rowElement = event.target.closest("tr[data-id]");
    if (!rowElement) return;
    event.preventDefault();
    state.selectedOrderId = rowElement.dataset.id;
    updateSelectedRowClasses();

    const row = getFilteredOrders().find((item) => item._id === rowElement.dataset.id);
    if (!row) return;

    showContextMenu(event.clientX, event.clientY, [
      {
        label: "Cancel Order",
        shortcut: "F4",
        action: () => cancelOrder(row._id)
      },
      {
        label: "Modify Order",
        shortcut: "F5",
        action: () => openPlaceOrder({ order: row })
      }
    ]);
  });
}

function selectedOrder() {
  return getOrders().find((order) => order._id === state.selectedOrderId) || null;
}

function cancelOrder(id) {
  const list = getOrders();
  const index = list.findIndex((order) => order._id === id);
  if (index < 0) return;
  const [order] = list.splice(index, 1);
  state.selectedOrderId = null;
  renderOrders();
  updateStatus();
  showToast(`Cancel request sent for order ${order.id} (mock).`);
}

function setupActions() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    closeMenus();

    if (action === "cancel-all") {
      showToast(`Cancel All sent for ${state.exchange} (mock).`);
      return;
    }
    if (action === "cancel-modify") {
      const order = selectedOrder();
      showToast(order ? `Cancel/Modify request sent for order ${order.id} (mock).` : "Select an open order first.");
      return;
    }
    if (action === "place-order") {
      openPlaceOrder({ order: selectedOrder() });
      return;
    }
    if (action === "square-off-all") {
      showToast("Square Off All requires the 146 random-code confirmation; this is a mock.");
      return;
    }
    if (action === "save-positions") {
      showToast("Positions saved to pnl_20150625.csv (mock).");
      return;
    }
    if (action === "new-connection") {
      showToast("Connect To Exchange dialog is not reproduced in this page.");
      return;
    }
    if (action === "load-connection") {
      showToast("No saved sessions in this static repro.");
      return;
    }
    if (action === "save-connection") {
      showToast("Session save is not available in this static repro.");
      return;
    }
    if (action === "close-connection") {
      showToast("No active DataService connection to close.");
      return;
    }
    if (action === "about") {
      openAbout();
      return;
    }
    if (action === "about-qt") {
      openAboutQt();
    }
  });
}

function setupMarketData() {
  $("#tickerInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    openTicker();
  });

  $("#marketExchange").addEventListener("change", (event) => {
    selectExchange(event.target.value);
  });

  $("#mdiArea").addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-close-book]");
    if (closeButton) {
      removeBook(closeButton.dataset.closeBook, state.exchange);
      return;
    }
    const windowElement = event.target.closest(".mdi-window");
    if (windowElement) bringToFront(windowElement);
  });

  $("#mdiArea").addEventListener("mousedown", (event) => {
    const titlebar = event.target.closest(".mdi-titlebar");
    if (!titlebar || event.target.closest(".mdi-close")) return;
    const windowElement = titlebar.closest(".mdi-window");
    const areaRect = $("#mdiArea").getBoundingClientRect();
    const windowRect = windowElement.getBoundingClientRect();
    dragState = {
      windowElement,
      ticker: windowElement.dataset.ticker,
      offsetX: event.clientX - windowRect.left,
      offsetY: event.clientY - windowRect.top,
      areaRect
    };
    bringToFront(windowElement);
    event.preventDefault();
  });

  $("#mdiArea").addEventListener("contextmenu", (event) => {
    const cell = event.target.closest("td");
    if (!cell) return;
    const windowElement = cell.closest(".mdi-window");
    if (!windowElement) return;
    event.preventDefault();

    const columnIndex = cell.cellIndex;
    const price = cell.textContent.trim();
    if (price === "-") return;
    const side = columnIndex < 2 ? "BUY" : "SELL";
    showContextMenu(event.clientX, event.clientY, [
      {
        label: "Place Order",
        action: () => openPlaceOrder({
          side,
          symbol: windowElement.dataset.ticker,
          price,
          exchange: state.exchange
        })
      }
    ]);
  });

  document.addEventListener("mousemove", (event) => {
    if (!dragState) return;
    const { windowElement, offsetX, offsetY, areaRect } = dragState;
    let left = event.clientX - areaRect.left - offsetX;
    let top = event.clientY - areaRect.top - offsetY;
    left = Math.max(0, Math.min(areaRect.width - windowElement.offsetWidth, left));
    top = Math.max(0, Math.min(areaRect.height - windowElement.offsetHeight, top));
    windowElement.style.left = `${left}px`;
    windowElement.style.top = `${top}px`;
  });

  document.addEventListener("mouseup", () => {
    if (!dragState) return;
    const { windowElement, ticker } = dragState;
    const item = (marketWindows[state.exchange] || []).find((window) => window.ticker === ticker);
    if (item) {
      item.x = parseInt(windowElement.style.left, 10);
      item.y = parseInt(windowElement.style.top, 10);
    }
    dragState = null;
  });
}

function openTicker() {
  const input = $("#tickerInput");
  const ticker = input.value.trim().toUpperCase();
  if (!ticker) {
    showToast("Enter a ticker first.");
    return;
  }
  const exchange = $("#marketExchange").value;
  if (exchange !== state.exchange) selectExchange(exchange);
  openBook(ticker, exchange);
  input.value = "";
}

function openBook(ticker, exchange) {
  const list = marketWindows[exchange] || (marketWindows[exchange] = []);
  let item = list.find((window) => window.ticker === ticker);
  if (!item) {
    const count = list.length;
    item = {
      ticker,
      x: 24 + (count % 3) * 34,
      y: 18 + (count % 3) * 28,
      w: 320,
      h: 424
    };
    list.push(item);
  }

  if (exchange !== state.exchange) selectExchange(exchange);
  selectTab("market");
  renderMarketData();
  window.setTimeout(() => {
    const windowElement = $$(".mdi-window").find((element) => element.dataset.ticker === ticker);
    if (windowElement) bringToFront(windowElement);
  }, 0);
}

function removeBook(ticker, exchange) {
  marketWindows[exchange] = (marketWindows[exchange] || []).filter((window) => window.ticker !== ticker);
  if (exchange === state.exchange) renderMarketData();
}

function bringToFront(windowElement) {
  state.marketZ += 1;
  windowElement.style.zIndex = String(state.marketZ);
}

function setupContextMenu() {
  document.addEventListener("click", hideContextMenu);
  document.addEventListener("scroll", hideContextMenu, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideContextMenu();
  });
}

function showContextMenu(x, y, items) {
  const menu = $("#contextMenu");
  menu.innerHTML = items.map((item, index) => {
    const shortcut = item.shortcut ? `<span class="shortcut">${escapeHtml(item.shortcut)}</span>` : "";
    return `<button type="button" data-index="${index}">${escapeHtml(item.label)}${shortcut}</button>`;
  }).join("");
  menu.hidden = false;

  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 4);
  const top = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;

  menu.onclick = (event) => {
    const button = event.target.closest("button[data-index]");
    if (!button) return;
    const item = items[Number(button.dataset.index)];
    hideContextMenu();
    if (item) item.action();
  };
}

function hideContextMenu() {
  const menu = $("#contextMenu");
  menu.hidden = true;
  menu.onclick = null;
}

function openModal(title, body, footer, handler) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = body;
  $("#modalFooter").innerHTML = footer;
  modalActionHandler = handler;
  $("#modalBackdrop").hidden = false;
}

function closeModal() {
  $("#modalBackdrop").hidden = true;
  modalActionHandler = null;
}

function setupModal() {
  $("#modalClose").addEventListener("click", closeModal);
  $("#modalBackdrop").addEventListener("click", (event) => {
    if (event.target === $("#modalBackdrop")) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#modalBackdrop").hidden) closeModal();
  });
  $("#modalFooter").addEventListener("click", (event) => {
    const button = event.target.closest("[data-modal-action]");
    if (!button) return;
    if (button.dataset.modalAction === "close") {
      closeModal();
      return;
    }
    if (modalActionHandler) modalActionHandler(button.dataset.modalAction);
  });
}

function openAbout() {
  openModal(
    "About Menu",
    `<div class="about-box">
      <div class="about-logo">TS</div>
      <div>
        <b>Trading Systems Monitor</b><br>
        AlphaGrep Securities<br>
        Version 1<br>
        <span class="muted">146 Qt4 HTML reproduction · mock data only</span>
      </div>
    </div>`,
    `<button type="button" class="qt-button" data-modal-action="close">OK</button>`
  );
}

function openAboutQt() {
  openModal(
    "About Qt",
    `<div class="about-box">
      <div class="about-logo">Qt</div>
      <div>
        <b>Qt 4.8.6</b><br>
        This page is a static HTML facsimile of the Qt4 TradingSystemsGUI.<br>
        <span class="muted">No Qt runtime is loaded.</span>
      </div>
    </div>`,
    `<button type="button" class="qt-button" data-modal-action="close">OK</button>`
  );
}

function option(value, expected) {
  return value === expected ? " selected" : "";
}

function openPlaceOrder(prefill = {}) {
  const order = prefill.order || null;
  const side = prefill.side || (order && order.trans === "S" ? "SELL" : "BUY");
  const exchange = prefill.exchange || (order && order.source) || state.exchange;
  const symbol = prefill.symbol || (order && order.symbol) || "";
  const qty = prefill.qty ?? (order && order.qty) ?? "";
  const price = prefill.price ?? (order && order.price) ?? "";
  const account = prefill.account || (order && order.account) || "A1";
  const instr = (order && order.instr) || "";
  const optype = (order && order.optype) || "";
  const expiry = (order && order.expiry) || "20150625";
  const sprice = (order && order.sprice) || 0;
  const dqty = (order && order.dqty) || qty;
  const orderId = (order && order.id) || 0;

  const body = `<div class="order-form">
    <label><span>Transaction:</span><select id="poSide">
      <option value="BUY"${option(side, "BUY")}>BUY</option>
      <option value="SELL"${option(side, "SELL")}>SELL</option>
    </select></label>
    <label><span>Price:</span><input id="poPrice" class="qt-input" type="text" value="${escapeHtml(price)}"></label>
    <label><span>Exchange:</span><select id="poExchange">
      ${EXCHANGES.map((name) => `<option${option(exchange, name)}>${name}</option>`).join("")}
    </select></label>
    <label><span>Disclosed Qty:</span><input id="poDqty" class="qt-input" type="text" value="${escapeHtml(dqty)}"></label>
    <label><span>Quantity:</span><input id="poQty" class="qt-input" type="text" value="${escapeHtml(qty)}"></label>
    <label><span>Account ID:</span><input id="poAccount" class="qt-input" type="text" value="${escapeHtml(account)}"></label>
    <label><span>Symbol:</span><input id="poSymbol" class="qt-input" type="text" value="${escapeHtml(symbol)}"></label>
    <label><span>Option Type:</span><input id="poOptType" class="qt-input" type="text" value="${escapeHtml(optype)}"></label>
    <label><span>Instrument Type:</span><input id="poInstr" class="qt-input" type="text" value="${escapeHtml(instr)}"></label>
    <label><span>Strike Price:</span><input id="poStrike" class="qt-input" type="text" value="${escapeHtml(sprice)}"></label>
    <label><span>Expiry Date:</span><input id="poExpiry" class="qt-input" type="text" value="${escapeHtml(expiry)}"></label>
    <label><span>Token:</span><input id="poToken" class="qt-input" type="text" value=""></label>
    <label><span>Request Type:</span><span class="readonly">NEW_ORDER</span></label>
    <label><span>Order ID:</span><input id="poOrderId" class="qt-input readonly" type="text" value="${escapeHtml(orderId)}" readonly></label>
  </div>`;

  openModal(
    "Send Order",
    body,
    `<button type="button" class="qt-button" data-modal-action="close">CLOSE</button>
     <button type="button" class="qt-button qt-button-primary" data-modal-action="send-order">SEND</button>`,
    (action) => {
      if (action !== "send-order") return;
      const sendSymbol = $("#poSymbol").value.trim();
      const sendQty = Number($("#poQty").value);
      if (!sendSymbol || !Number.isFinite(sendQty) || sendQty <= 0) {
        showToast("Symbol and quantity are required.");
        return;
      }
      const sendSide = $("#poSide").value;
      const sendPrice = $("#poPrice").value.trim() || "MKT";
      closeModal();
      showToast(`${sendSide} ${sendQty} ${sendSymbol} @ ${sendPrice} sent (mock).`);
    }
  );
}

function setupWindowControls() {
  $$("[data-win]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.win;
      if (action === "max") {
        const maximized = document.body.classList.toggle("is-max");
        $("#appWindow").classList.toggle("maximized", maximized);
        return;
      }
      if (action === "min") {
        showToast("Minimize is handled by the window manager in Qt4.");
        return;
      }
      if (action === "close") {
        openModal(
          "Close",
          `<div>This is a static HTML reproduction. Closing the Qt4 window is not simulated.</div>`,
          `<button type="button" class="qt-button" data-modal-action="close">OK</button>`
        );
      }
    });
  });

  $("#titlebar").addEventListener("dblclick", (event) => {
    if (event.target.closest("button")) return;
    const maximized = document.body.classList.toggle("is-max");
    $("#appWindow").classList.toggle("maximized", maximized);
  });
}

function startClock() {
  const tick = () => {
    $("#statusClock").textContent = new Date().toLocaleTimeString("en-GB");
  };
  tick();
  window.setInterval(tick, 1000);
}

function init() {
  renderNetColumns();
  renderOrderColumns();
  setupMenus();
  setupTabs();
  setupFilters();
  setupTableInteractions();
  setupActions();
  setupMarketData();
  setupContextMenu();
  setupModal();
  setupWindowControls();
  renderAll();
  startClock();
}

init();

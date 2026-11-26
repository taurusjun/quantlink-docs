(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const fmt2 = (n) => Number(n).toFixed(2);
  const fmtInt = (n) => Number(n).toLocaleString('en-US');
  const now = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

  const state = {
    strategies: [
      {
        key: 'pair-01', port: '15300', name: 'pair-01',
        connected: true, running: true, locked: false,
        quoting: 'BANKNIFTY', driving: 'BANKNIFTY',
        bidPrice: 218.90, askPrice: 219.10,
        bidFills: 9, askFills: 9,
        bidStatus: 'hedged', askStatus: 'unhedged',
        fairBid: 218.95, fairAsk: 219.05, fvma: 219.00, group: '15300',
        params: {
          bidExlim: 1000, bidSize: 3, bidEdge: 0.30, bidSlope: 0.00, bidLean: 1,
          askExlim: 1000, askSize: 3, askEdge: 0.30, askSlope: 0.00, askLean: 1
        }
      },
      {
        key: 'mm-01', port: '15301', name: 'mm-01',
        connected: true, running: false, locked: true,
        quoting: 'BANKNIFTY', driving: 'BANKNIFTY',
        bidPrice: 442.10, askPrice: 442.30,
        bidFills: 4, askFills: 2,
        bidStatus: 'cancel', askStatus: 'reject',
        fairBid: 442.10, fairAsk: 442.30, fvma: 442.20, group: '15301',
        params: {
          bidExlim: 500, bidSize: 2, bidEdge: 0.20, bidSlope: 0.00, bidLean: 1,
          askExlim: 500, askSize: 2, askEdge: 0.20, askSlope: 0.00, askLean: 1
        }
      },
      {
        key: 'arb-02', port: '15302', name: 'arb-02',
        connected: true, running: true, locked: false,
        quoting: 'BANKNIFTY', driving: 'BANKNIFTY',
        bidPrice: 1204.50, askPrice: 1205.20,
        bidFills: 7, askFills: 4,
        bidStatus: 'hedged', askStatus: 'hedged',
        fairBid: 1204.70, fairAsk: 1205.00, fvma: 1204.85, group: '15302',
        params: {
          bidExlim: 1000, bidSize: 1, bidEdge: 0.50, bidSlope: 0.00, bidLean: 1,
          askExlim: 1000, askSize: 1, askEdge: 0.50, askSlope: 0.00, askLean: 1
        }
      }
    ],
    selected: 'pair-01',
    contractKey: 'pair-01',
    contractChannel: 'BSE',
    editingOrderId: null,
    pendingSide: 'BUY',
    pendingPrice: 218.90,
    fairAuto: false,
    nextOrderId: 1844,
    confirmCode: String(Math.floor(Math.random() * 900) + 100),
    market: {
      BSE: { base: 218.90, step: 0.05, last: 218.90, volume: 1284320 },
      NSE_FO: { base: 1204.50, step: 0.50, last: 1204.50, volume: 842190 }
    },
    positions: [
      { account: 'OWN', avgBuy: 217.90, netBuyQty: 4, symbol: 'BANKNIFTY', netSellQty: 0, avgSell: 0, netPosition: 4, group: '', mult: 1, fees: 0, channel: 'BSE', strategy: 'pair-01' },
      { account: 'OWN', avgBuy: 0, netBuyQty: 0, symbol: 'BANKNIFTY', netSellQty: 4, avgSell: 220.10, netPosition: -4, group: '', mult: 1, fees: 0, channel: 'NSE_FO', strategy: 'pair-01' },
      { account: 'OWN', avgBuy: 0, netBuyQty: 0, symbol: 'BANKNIFTY', netSellQty: 2, avgSell: 443.20, netPosition: -2, group: '15301', mult: 1, fees: 0, channel: 'BSE', strategy: 'mm-01' }
    ],
    orders: [
      { id: '1842', strategy: 'pair-01', channel: 'BSE', side: 'BUY', type: 'LIMIT', price: 218.90, qty: 2, filled: 0, status: 'WORKING', time: '10:42:18' },
      { id: '1843', strategy: 'pair-01', channel: 'NSE_FO', side: 'SELL', type: 'LIMIT', price: 219.10, qty: 2, filled: 0, status: 'WORKING', time: '10:42:19' },
      { id: '1839', strategy: 'mm-01', channel: 'BSE', side: 'SELL', type: 'LIMIT', price: 443.00, qty: 1, filled: 0, status: 'REJECTED', time: '10:41:22' }
    ],
    fills: [
      { status: 'TRADE_CONFIRM', id: '1840', symbol: 'BANKNIFTY', qty: 1, side: 'B', price: 218.85, time: '10:41:33', exchange: 'BSE' },
      { status: 'TRADE_CONFIRM', id: '1835', symbol: 'BANKNIFTY', qty: 1, side: 'S', price: 1205.20, time: '10:41:56', exchange: 'NSE_FO' },
      { status: 'TRADE_CONFIRM', id: '1832', symbol: 'BANKNIFTY', qty: 2, side: 'B', price: 218.80, time: '10:40:12', exchange: 'BSE' }
    ],
    orderResponses: [
      '10:41:22  BANKNIFTY 443.00 S 1 REJECTED : price outside band',
      '10:40:58  BANKNIFTY 218.85 B 1 NEW_ORDER_CONFIRM',
      '10:40:57  BANKNIFTY 218.85 B 1 CANCEL_ORDER_CONFIRM'
    ],
    console: [
      '10:42:19  pair-01: state → RUNNING',
      '10:42:18  pair-01: bidPrice 218.90 / askPrice 219.10',
      '10:41:58  BSE: market data healthy',
      '10:41:44  mm-01: strategy paused'
    ]
  };

  function strategy(key) {
    return state.strategies.find((s) => s.key === key);
  }

  function selectedStrategy() {
    return strategy(state.selected) || state.strategies[0];
  }

  function contractStrategy() {
    return strategy(state.contractKey) || selectedStrategy();
  }

  function logConsole(text) {
    state.console.push(`${now()}  ${text}`);
    state.console = state.console.slice(-4096);
    renderConsole();
  }

  function logOrderResponse(text) {
    state.orderResponses.push(`${now()}  ${text}`);
    state.orderResponses = state.orderResponses.slice(-6096);
    renderOrderResponse();
  }

  function showToast(text) {
    const toast = $('#toast');
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function statusBadge(status, side) {
    if (side === 'bid') return `<span class="fill-badge ${status}">${status}</span>`;
    return `<span class="fill-badge ${status}">${status}</span>`;
  }

  function renderStrategyTable() {
    const table = $('#strategyTable');
    const headers = [
      'Connect', 'Name', 'Bid Exlim', 'Bid Size', 'Bid Edge', 'Bid Slope', 'Bid Lean',
      'Bid Price', 'Bid Fills', 'Offer Fills', 'Offer Price', 'Offer Lean', 'Offer Slope',
      'Offer Edge', 'Offer Size', 'Offer Exlimit', 'Start', 'Stop', 'Lock'
    ];
    const paramFields = [
      ['bidExlim', 'Bid Exlim'], ['bidSize', 'Bid Size'], ['bidEdge', 'Bid Edge'],
      ['bidSlope', 'Bid Slope'], ['bidLean', 'Bid Lean'], ['askExlim', 'Ask Exlim'],
      ['askSize', 'Ask Size'], ['askEdge', 'Ask Edge'], ['askSlope', 'Ask Slope'], ['askLean', 'Ask Lean']
    ];
    const rows = state.strategies.map((s) => {
      const startDisabled = !s.connected || s.running || s.locked;
      const stopDisabled = !s.running;
      return `
        <tr data-strategy="${s.key}" class="${state.selected === s.key ? 'selected' : ''}">
          <td><button class="qt-btn" data-action="connect" data-key="${s.key}" ${s.connected ? 'disabled' : ''}>${s.connected ? 'Connected' : 'Connect'}</button></td>
          <td><span class="status-dot ${s.running ? 'running' : 'paused'}"></span><b>${s.name}</b> <span class="dim">${s.running ? 'RUNNING' : 'PAUSED'}</span></td>
          <td><input class="param-input" data-param="bidExlim" data-key="${s.key}" type="number" step="1" value="${s.params.bidExlim}"></td>
          <td><input class="param-input" data-param="bidSize" data-key="${s.key}" type="number" step="1" value="${s.params.bidSize}"></td>
          <td><input class="param-input" data-param="bidEdge" data-key="${s.key}" type="number" step="0.01" value="${fmt2(s.params.bidEdge)}"></td>
          <td><input class="param-input" data-param="bidSlope" data-key="${s.key}" type="number" step="0.01" value="${fmt2(s.params.bidSlope)}"></td>
          <td><input class="param-input" data-param="bidLean" data-key="${s.key}" type="number" step="1" value="${s.params.bidLean}"></td>
          <td class="num blue">${fmt2(s.bidPrice)}</td>
          <td class="center">${statusBadge(s.bidStatus, 'bid')} ${s.bidFills}</td>
          <td class="center">${statusBadge(s.askStatus, 'ask')} ${s.askFills}</td>
          <td class="num red">${fmt2(s.askPrice)}</td>
          <td><input class="param-input" data-param="askLean" data-key="${s.key}" type="number" step="1" value="${s.params.askLean}"></td>
          <td><input class="param-input" data-param="askSlope" data-key="${s.key}" type="number" step="0.01" value="${fmt2(s.params.askSlope)}"></td>
          <td><input class="param-input" data-param="askEdge" data-key="${s.key}" type="number" step="0.01" value="${fmt2(s.params.askEdge)}"></td>
          <td><input class="param-input" data-param="askSize" data-key="${s.key}" type="number" step="1" value="${s.params.askSize}"></td>
          <td><input class="param-input" data-param="askExlim" data-key="${s.key}" type="number" step="1" value="${s.params.askExlim}"></td>
          <td><button class="qt-btn green" data-action="start" data-key="${s.key}" ${startDisabled ? 'disabled' : ''}>Start</button></td>
          <td><button class="qt-btn red" data-action="stop" data-key="${s.key}" ${stopDisabled ? 'disabled' : ''}>Stop</button></td>
          <td><button class="qt-btn ${s.locked ? 'locked' : ''}" data-action="lock" data-key="${s.key}">${s.locked ? 'Unlock' : 'Lock'}</button></td>
        </tr>
      `;
    }).join('');

    table.innerHTML = `
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    `;
    $('#strategyWinMeta').textContent = `${state.strategies.length} strategies · ports 15300–15302`;
  }

  function renderFairTable() {
    const table = $('#fairTable');
    const rows = state.strategies.map((s) => {
      const impliedBid = s.bidPrice - 0.10;
      const impliedAsk = s.askPrice + 0.10;
      return `
        <tr data-strategy="${s.key}">
          <td class="center"><input type="checkbox" data-fair-auto="${s.key}" ${state.fairAuto ? 'checked' : ''}></td>
          <td>${s.name}</td>
          <td class="num blue">${fmt2(impliedBid)}</td>
          <td><input class="param-input" data-fair-field="fairBid" data-key="${s.key}" type="number" step="0.01" value="${fmt2(s.fairBid)}" ${state.fairAuto ? 'disabled' : ''}></td>
          <td><input class="param-input" data-fair-field="fairAsk" data-key="${s.key}" type="number" step="0.01" value="${fmt2(s.fairAsk)}" ${state.fairAuto ? 'disabled' : ''}></td>
          <td class="num red">${fmt2(impliedAsk)}</td>
          <td><button class="qt-btn" data-match="bid" data-key="${s.key}" ${state.fairAuto ? 'disabled' : ''}>Match</button></td>
          <td><button class="qt-btn" data-match="ask" data-key="${s.key}" ${state.fairAuto ? 'disabled' : ''}>Match</button></td>
          <td><input class="param-input" data-fair-group="${s.key}" type="text" value="${s.group}" style="width:62px"></td>
          <td class="num violet">${fmt2(s.fvma)}</td>
        </tr>
      `;
    }).join('');
    table.innerHTML = `
      <thead><tr><th>Use</th><th>Name</th><th>Implied Bid</th><th>Bid</th><th>Ask</th><th>Implied Ask</th><th>Bid Match</th><th>Ask Match</th><th>Group</th><th>FV Mid Avg</th></tr></thead>
      <tbody>${rows}</tbody>
    `;
  }

  function positionPnl(pos) {
    const mark = state.market[pos.channel] ? state.market[pos.channel].base : pos.avgBuy;
    const avg = pos.netPosition >= 0 ? pos.avgBuy : pos.avgSell;
    const gross = pos.netPosition * (mark - avg) * pos.mult;
    const fees = pos.fees * (pos.netBuyQty + pos.netSellQty);
    return gross - fees;
  }

  function renderPositionTable() {
    const table = $('#positionTable');
    const rows = state.positions.map((p, i) => `
      <tr>
        <td>${p.account}</td>
        <td class="num">${fmt2(p.avgBuy)}</td>
        <td class="num">${p.netBuyQty}</td>
        <td>${p.symbol}<span class="dim"> · ${p.channel}</span></td>
        <td class="num">${p.netSellQty}</td>
        <td class="num">${fmt2(p.avgSell)}</td>
        <td class="num ${p.netPosition > 0 ? 'green' : p.netPosition < 0 ? 'red' : ''}">${p.netPosition}</td>
        <td><input class="param-input" data-pos="${i}" data-pos-field="group" type="text" value="${p.group}" style="width:50px"></td>
        <td><input class="param-input" data-pos="${i}" data-pos-field="mult" type="number" step="1" value="${p.mult}"></td>
        <td><input class="param-input" data-pos="${i}" data-pos-field="fees" type="number" step="0.01" value="${fmt2(p.fees)}"></td>
        <td class="num ${positionPnl(p) >= 0 ? 'green' : 'red'}">${positionPnl(p).toFixed(0)}</td>
      </tr>
    `).join('');
    table.innerHTML = `
      <thead><tr><th>Account</th><th>AvgBuy</th><th>NetBuyQty</th><th>Symbol</th><th>NetSellQty</th><th>AvgSell</th><th>NetPosition</th><th>Group</th><th>Mult</th><th>Fees</th><th>PNL</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="11" class="dim">No positions</td></tr>'}</tbody>
    `;
  }

  function renderOpenOrders() {
    const table = $('#openOrderTable');
    const rows = state.orders.filter((o) => o.status === 'WORKING' || o.status === 'PARTIAL' || o.status === 'REJECTED').map((o) => `
      <tr data-order-id="${o.id}">
        <td>${o.strategy}</td>
        <td>${o.channel}:${(strategy(o.strategy) || contractStrategy()).quoting}</td>
        <td>${o.status}</td>
        <td class="mono">${o.id}</td>
        <td class="${o.side === 'BUY' ? 'green' : 'red'}">${o.side}</td>
        <td class="num">${fmt2(o.price)}</td>
        <td class="num">${o.qty}</td>
        <td>${o.time}</td>
        <td>${o.channel}</td>
      </tr>
    `).join('');
    table.innerHTML = `
      <thead><tr><th>Account</th><th>Symbol</th><th>Status</th><th>ID</th><th>Side</th><th>Price</th><th>Quantity</th><th>Time Stamp</th><th>Exchange</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="dim">No working orders</td></tr>'}</tbody>
    `;
    $('#openOrderMeta').textContent = `${state.orders.filter((o) => o.status === 'WORKING' || o.status === 'PARTIAL').length} working · ${state.orders.length} today`;
  }

  function renderFills() {
    const table = $('#fillTable');
    const rows = state.fills.slice(0, 500).map((f) => `
      <tr>
        <td>${f.status}</td>
        <td class="mono">${f.id}</td>
        <td>${f.symbol}<span class="dim"> · ${f.exchange}</span></td>
        <td class="num">${f.qty}</td>
        <td class="${f.side === 'B' ? 'green' : 'red'}">${f.side === 'B' ? 'BUY' : 'SELL'}</td>
        <td class="num">${fmt2(f.price)}</td>
        <td>${f.time}</td>
        <td>${f.exchange}</td>
      </tr>
    `).join('');
    table.innerHTML = `
      <thead><tr><th>Status</th><th>Order Id</th><th>Symbol</th><th>Quantity</th><th>Side</th><th>Price</th><th>Time Stamp</th><th>Exchange</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="dim">No fills</td></tr>'}</tbody>
    `;
  }

  function renderOrderResponse() {
    const el = $('#orderResponse');
    el.textContent = state.orderResponses.join('\n');
    el.scrollTop = el.scrollHeight;
  }

  function renderConsole() {
    const el = $('#console');
    el.textContent = state.console.join('\n');
    el.scrollTop = el.scrollHeight;
  }

  function renderContract() {
    if ($('#win-contract').classList.contains('hidden')) return;
    const s = contractStrategy();
    const channel = state.contractChannel;
    const m = state.market[channel];
    const contractName = `${channel}:${s.quoting}`;
    $('#contractTitle').textContent = `ContractWindow · ${s.name}`;
    $('#contractMeta').textContent = contractName;
    $('#contractLtp').textContent = fmt2(m.last);
    $('#contractTime').textContent = now();
    $('#contractVolume').textContent = fmtInt(m.volume);
    const rows = [];
    for (let i = 0; i < 20; i += 1) {
      const bid = m.base - i * m.step;
      const ask = m.base + (i + 1) * m.step;
      const bidQty = 2 + (i % 4);
      const askQty = 3 + (i % 3);
      rows.push(`
        <div class="book-row">
          <span class="bid-qty">${bidQty}</span>
          <span class="bid-px bid-cell" data-side="BUY" data-price="${fmt2(bid)}">${fmt2(bid)}</span>
          <span class="ask-px ask-cell" data-side="SELL" data-price="${fmt2(ask)}">${fmt2(ask)}</span>
          <span class="ask-qty">${askQty}</span>
        </div>
      `);
    }
    $('#contractBook').innerHTML = rows.join('');
    const working = state.orders.filter((o) => o.strategy === s.key && o.channel === channel && (o.status === 'WORKING' || o.status === 'PARTIAL'));
    $('#contractWorking').innerHTML = working.length ? working.map((o) => `
      <div class="working-row" data-contract-order="${o.id}">
        <span class="${o.side === 'BUY' ? 'buy' : 'sell'}">${o.side}</span>
        <span>${fmt2(o.price)}</span>
        <span>${o.qty}</span>
        <span>${o.status}</span>
      </div>
    `).join('') : '<div class="dim" style="padding:7px">No working orders</div>';
  }

  function renderAll() {
    renderStrategyTable();
    renderFairTable();
    renderPositionTable();
    renderOpenOrders();
    renderFills();
    renderOrderResponse();
    renderConsole();
    renderContract();
  }

  function connectStrategy(s) {
    if (s.connected) return;
    s.connected = true;
    logConsole(`${s.port}|connectRequest`);
    logConsole(`${s.port}|initComplete#true`);
    logOrderResponse(`${s.name} CONNECT initComplete#true`);
    showToast(`${s.name}: Connection acknowledged · Start enabled`);
    renderStrategyTable();
  }

  function startStrategy(s) {
    if (!s.connected) {
      showToast(`${s.name}: Connect first`);
      return;
    }
    if (s.locked) {
      showToast(`${s.name}: Locked · Start is disabled`);
      return;
    }
    if (s.running) return;
    s.running = true;
    s.bidStatus = 'hedged';
    s.askStatus = 'unhedged';
    logConsole(`${s.port}|startOrStop#true`);
    logConsole(`${s.port}|status#start`);
    logOrderResponse(`${s.name} STATUS start`);
    showToast(`${s.name}: start accepted · RUNNING`);
    renderStrategyTable();
    renderContract();
  }

  function stopStrategy(s) {
    if (!s.running) return;
    s.running = false;
    logConsole(`${s.port}|startOrStop#false`);
    logConsole(`${s.port}|status#stop`);
    logOrderResponse(`${s.name} STATUS stop`);
    showToast(`${s.name}: stop accepted · PAUSED`);
    renderStrategyTable();
    renderContract();
  }

  function toggleLock(s) {
    s.locked = !s.locked;
    logConsole(`${s.name}: UI lock ${s.locked ? 'engaged' : 'released'} (local)`);
    showToast(`${s.name}: ${s.locked ? 'Locked · click order disabled' : 'Unlocked'}`);
    renderStrategyTable();
    renderContract();
  }

  function selectStrategy(key) {
    state.selected = key;
    state.contractKey = key;
    renderStrategyTable();
    renderFairTable();
    renderContract();
  }

  function openContract(key) {
    state.contractKey = key;
    const win = $('#win-contract');
    win.classList.remove('hidden');
    renderContract();
    bringToFront(win);
    updateLauncher();
  }

  function openOrderModal(side, price) {
    const s = contractStrategy();
    if (s.locked) {
      showToast(`${s.name}: Locked · click order disabled`);
      return;
    }
    state.pendingSide = side;
    state.pendingPrice = Number(price);
    state.editingOrderId = null;
    $('#orderModalTitle').textContent = `Place ${side} order · ${s.name}`;
    $('#orderSymbol').value = `${state.contractChannel}:${s.quoting}`;
    $('#orderQty').value = $('#contractSize').value || '2';
    $('#orderPrice').value = fmt2(price);
    $('#orderSubmit').textContent = 'Send';
    $$('.side-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.side === side));
    openModal('#orderModal');
  }

  function editOrder(orderId) {
    const order = state.orders.find((o) => o.id === String(orderId));
    if (!order) return;
    state.editingOrderId = order.id;
    state.pendingSide = order.side;
    state.pendingPrice = order.price;
    $('#orderModalTitle').textContent = `Modify order · ${order.id}`;
    $('#orderSymbol').value = `${order.channel}:${contractStrategy().quoting}`;
    $('#orderQty').value = order.qty;
    $('#orderPrice').value = fmt2(order.price);
    $('#orderSubmit').textContent = 'Modify';
    $$('.side-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.side === order.side));
    openModal('#orderModal');
  }

  function submitOrder(side, qty, price, type) {
    const s = contractStrategy();
    if (state.editingOrderId) {
      const order = state.orders.find((o) => o.id === state.editingOrderId);
      if (order) {
        order.price = Number(price);
        order.qty = Number(qty);
        order.status = 'WORKING';
        order.time = now();
        logOrderResponse(`${s.name} ${order.id} MODIFY_ORDER_CONFIRM ${fmt2(price)}`);
        logConsole(`${s.name}: modify ${order.id} → ${fmt2(price)} (${qty})`);
        showToast(`${s.name}: modify accepted · ${order.id}`);
      }
      state.editingOrderId = null;
      closeModal('#orderModal');
      renderOpenOrders();
      renderContract();
      return;
    }

    const id = String(state.nextOrderId++);
    const order = {
      id,
      strategy: s.key,
      channel: state.contractChannel,
      side,
      type,
      price: Number(price),
      qty: Number(qty),
      filled: 0,
      status: 'WORKING',
      time: now()
    };
    state.orders.unshift(order);
    logConsole(`${s.port}|${side === 'BUY' ? 'bidSize' : 'askSize'}#${qty}`);
    logConsole(`${s.name}: manual ${side} ${qty} @ ${fmt2(price)} routed to TradeBotOrderGateway`);
    logOrderResponse(`${s.name} ${id} NEW_ORDER_CONFIRM ${fmt2(price)} ${side} ${qty}`);
    showToast(`${s.name}: ${side} ${qty} @ ${fmt2(price)} accepted · ${id}`);
    closeModal('#orderModal');
    renderOpenOrders();
    renderContract();
    setTimeout(() => fillOrder(id), 1400);
  }

  function fillOrder(id) {
    const order = state.orders.find((o) => o.id === id);
    if (!order || !['WORKING', 'PARTIAL'].includes(order.status)) return;
    order.status = 'FILLED';
    order.filled = order.qty;
    const owner = strategy(order.strategy) || contractStrategy();
    state.fills.unshift({
      status: 'TRADE_CONFIRM',
      id: order.id,
      symbol: owner.quoting,
      qty: order.qty,
      side: order.side === 'BUY' ? 'B' : 'S',
      price: order.price,
      time: now(),
      exchange: order.channel
    });
    const s = strategy(order.strategy);
    if (s) {
      if (order.side === 'BUY') s.bidFills += 1;
      else s.askFills += 1;
    }
    logConsole(`${s ? s.name : 'manual'}: TRADE_CONFIRM ${order.side} ${order.qty} @ ${fmt2(order.price)}`);
    logOrderResponse(`${order.strategy} ${order.id} TRADE_CONFIRM ${fmt2(order.price)} ${order.side} ${order.qty}`);
    showToast(`${order.strategy}: fill ${order.side} ${order.qty} @ ${fmt2(order.price)}`);
    renderStrategyTable();
    renderOpenOrders();
    renderFills();
    renderContract();
  }

  function cancelOrder(id) {
    const order = state.orders.find((o) => o.id === String(id));
    if (!order) return;
    order.status = 'CANCELED';
    logOrderResponse(`${order.strategy} ${order.id} CANCEL_ORDER_CONFIRM`);
    logConsole(`${order.strategy}: cancel ${order.id} acknowledged`);
    showToast(`${order.strategy}: cancel ${order.id} accepted`);
    renderOpenOrders();
    renderContract();
  }

  function openCancelAll() {
    state.confirmCode = String(Math.floor(Math.random() * 900) + 100);
    $('#confirmCode').textContent = state.confirmCode;
    $('#confirmInput').value = '';
    openModal('#cancelModal');
  }

  function cancelAll() {
    const working = state.orders.filter((o) => o.status === 'WORKING' || o.status === 'PARTIAL');
    working.forEach((o) => { o.status = 'CANCELED'; });
    logOrderResponse(`CANCEL_ALL ${working.length} orders acknowledged`);
    logConsole(`Cancel All: ${working.length} orders acknowledged`);
    showToast(`Cancel All accepted · ${working.length} orders`);
    closeModal('#cancelModal');
    renderOpenOrders();
    renderContract();
  }

  function exportFills() {
    const header = 'Status,OrderId,Symbol,Quantity,Side,Price,Time,Exchange';
    const rows = state.fills.map((f) => [f.status, f.id, f.symbol, f.qty, f.side, f.price, f.time, f.exchange].join(','));
    const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fills-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Fills CSV exported');
  }

  function moveMarket() {
    const b = state.market.BSE;
    const n = state.market.NSE_FO;
    b.base = Math.max(1, b.base + (Math.random() - 0.5) * 0.10);
    n.base = Math.max(1, n.base + (Math.random() - 0.5) * 0.80);
    b.last = b.base;
    n.last = n.base;
    b.volume += Math.floor(Math.random() * 800);
    n.volume += Math.floor(Math.random() * 600);
    renderContract();
  }

  function openModal(selector) {
    const el = $(selector);
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
  }

  function closeModal(selector) {
    const el = $(selector);
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
  }

  function bringToFront(win) {
    let top = 10;
    $$('.window').forEach((w) => {
      const z = Number(w.style.zIndex || 0);
      if (z > top) top = z;
      w.classList.remove('active');
    });
    win.style.zIndex = String(top + 1);
    win.classList.add('active');
  }

  function showWindow(name) {
    const win = $(`#win-${name}`);
    if (!win) return;
    win.classList.remove('hidden');
    bringToFront(win);
    updateLauncher();
  }

  function hideWindow(win) {
    win.classList.add('hidden');
    updateLauncher();
  }

  function updateLauncher() {
    $$('#windowLauncher button').forEach((btn) => {
      const win = $(`#win-${btn.dataset.window}`);
      btn.classList.toggle('active', !!win && !win.classList.contains('hidden'));
    });
  }

  function setupWindowManager() {
    $$('.window').forEach((win) => {
      const title = win.querySelector('.win-title');
      title.addEventListener('pointerdown', (event) => {
        if (event.target.closest('button')) return;
        bringToFront(win);
        const start = { x: event.clientX, y: event.clientY, left: win.offsetLeft, top: win.offsetTop };
        const move = (e) => {
          const desktop = $('#desktop');
          const maxLeft = Math.max(0, desktop.clientWidth - win.offsetWidth);
          const maxTop = Math.max(0, desktop.clientHeight - win.offsetHeight);
          win.style.left = `${Math.min(maxLeft, Math.max(0, start.left + e.clientX - start.x))}px`;
          win.style.top = `${Math.min(maxTop, Math.max(0, start.top + e.clientY - start.y))}px`;
        };
        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      });

      win.addEventListener('pointerdown', () => bringToFront(win));
      win.querySelector('[data-close]').addEventListener('click', () => hideWindow(win));
      win.querySelector('[data-min]').addEventListener('click', () => {
        win.classList.toggle('minimized');
        if (!win.classList.contains('minimized')) bringToFront(win);
      });
    });

    $$('#windowLauncher button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const win = $(`#win-${btn.dataset.window}`);
        if (!win) return;
        if (win.classList.contains('hidden')) showWindow(btn.dataset.window);
        else {
          bringToFront(win);
          showToast(`${btn.textContent.trim()} window focused`);
        }
      });
    });
  }

  function setupEventHandlers() {
    $('#strategyTable').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const s = strategy(btn.dataset.key);
      if (!s) return;
      if (btn.dataset.action === 'connect') connectStrategy(s);
      if (btn.dataset.action === 'start') startStrategy(s);
      if (btn.dataset.action === 'stop') stopStrategy(s);
      if (btn.dataset.action === 'lock') toggleLock(s);
    });

    $('#strategyTable').addEventListener('change', (event) => {
      const input = event.target.closest('.param-input');
      if (!input) return;
      const s = strategy(input.dataset.key);
      if (!s) return;
      s.params[input.dataset.param] = Number(input.value);
      logConsole(`${s.port}|${input.dataset.param}#${input.value}`);
      showToast(`${s.name}: ${input.dataset.param} → ${input.value} (parameter message)`);
    });

    $('#strategyTable').addEventListener('contextmenu', (event) => {
      const row = event.target.closest('tr[data-strategy]');
      if (!row) return;
      event.preventDefault();
      selectStrategy(row.dataset.strategy);
      openContract(row.dataset.strategy);
    });

    $('#strategyTable').addEventListener('dblclick', (event) => {
      const row = event.target.closest('tr[data-strategy]');
      if (!row) return;
      selectStrategy(row.dataset.strategy);
      openContract(row.dataset.strategy);
    });

    $('#fairTable').addEventListener('change', (event) => {
      const auto = event.target.closest('[data-fair-auto]');
      if (auto) {
        state.fairAuto = auto.checked;
        logConsole(`FairValue: FVAuto#${state.fairAuto}`);
        renderFairTable();
        return;
      }
      const input = event.target.closest('[data-fair-field]');
      if (input) {
        const s = strategy(input.dataset.key);
        if (!s) return;
        s[input.dataset.fairField] = Number(input.value);
        logConsole(`${s.port}|${input.dataset.fairField}#${input.value}`);
        return;
      }
      const group = event.target.closest('[data-fair-group]');
      if (group) {
        const s = strategy(group.dataset.fairGroup);
        if (s) s.group = group.value;
      }
    });

    $('#fairTable').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-match]');
      if (!btn) return;
      const s = strategy(btn.dataset.key);
      if (!s) return;
      if (btn.dataset.match === 'bid') {
        s.fairBid = s.bidPrice - 0.10;
        logConsole(`${s.port}|bidFairValue#${fmt2(s.fairBid)}`);
        showToast(`${s.name}: Match bid → ${fmt2(s.fairBid)}`);
      } else {
        s.fairAsk = s.askPrice + 0.10;
        logConsole(`${s.port}|askFairValue#${fmt2(s.fairAsk)}`);
        showToast(`${s.name}: Match ask → ${fmt2(s.fairAsk)}`);
      }
      renderFairTable();
    });

    $('#positionTable').addEventListener('change', (event) => {
      const input = event.target.closest('[data-pos]');
      if (!input) return;
      const idx = Number(input.dataset.pos);
      const field = input.dataset.posField;
      const pos = state.positions[idx];
      if (!pos) return;
      pos[field] = field === 'group' ? input.value : Number(input.value);
      logConsole(`Position: ${pos.symbol} ${field}=${input.value}`);
      renderPositionTable();
    });

    $('#openOrderTable').addEventListener('contextmenu', (event) => {
      const row = event.target.closest('tr[data-order-id]');
      if (!row) return;
      event.preventDefault();
      cancelOrder(row.dataset.orderId);
    });

    $('#openOrderTable').addEventListener('dblclick', (event) => {
      const row = event.target.closest('tr[data-order-id]');
      if (!row) return;
      editOrder(row.dataset.orderId);
    });

    $('#contractTabs').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-channel]');
      if (!btn) return;
      state.contractChannel = btn.dataset.channel;
      $$('#contractTabs button').forEach((b) => b.classList.toggle('active', b === btn));
      renderContract();
      showToast(`ContractWindow channel → ${state.contractChannel}`);
    });

    $('#contractBook').addEventListener('click', (event) => {
      const cell = event.target.closest('[data-price]');
      if (!cell) return;
      openOrderModal(cell.dataset.side, cell.dataset.price);
    });

    $('#contractBook').addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const working = state.orders.filter((o) => o.strategy === state.contractKey && o.channel === state.contractChannel && o.status === 'WORKING');
      if (working.length) cancelOrder(working[0].id);
      else showToast('No working order to cancel');
    });

    $('#contractWorking').addEventListener('contextmenu', (event) => {
      const row = event.target.closest('[data-contract-order]');
      if (!row) return;
      event.preventDefault();
      cancelOrder(row.dataset.contractOrder);
    });

    $$('.side-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.pendingSide = btn.dataset.side;
        $$('.side-btn').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    $('#orderForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitOrder(state.pendingSide, $('#orderQty').value, $('#orderPrice').value, $('#orderType').value);
    });

    $('#orderModal').addEventListener('click', (event) => {
      if (event.target === $('#orderModal') || event.target.closest('[data-modal-close]')) closeModal('#orderModal');
    });

    $('#cancelModal').addEventListener('click', (event) => {
      if (event.target === $('#cancelModal') || event.target.closest('[data-modal-close]')) closeModal('#cancelModal');
    });

    $('#confirmCancelAll').addEventListener('click', () => {
      if ($('#confirmInput').value.trim() !== state.confirmCode) {
        showToast('Cancel All: confirmation code mismatch');
        return;
      }
      cancelAll();
    });

    $('#connectAll').addEventListener('click', () => {
      state.strategies.forEach((s) => connectStrategy(s));
    });

    $('#startAll').addEventListener('click', () => {
      state.strategies.forEach((s) => { if (s.connected && !s.locked) startStrategy(s); });
    });

    $('#stopAll').addEventListener('click', () => {
      state.strategies.forEach((s) => { if (s.running) stopStrategy(s); });
    });

    $('#lockAll').addEventListener('click', () => {
      state.strategies.forEach((s) => { s.locked = true; });
      logConsole('Lock All: local UI locks applied');
      showToast('Lock All: local UI locks applied');
      renderStrategyTable();
      renderContract();
    });

    $('#cancelAll').addEventListener('click', openCancelAll);
    $('#exportFills').addEventListener('click', exportFills);
  }

  function init() {
    setupWindowManager();
    setupEventHandlers();
    renderAll();
    updateLauncher();
    setInterval(moveMarket, 1100);
    setInterval(() => {
      state.strategies.forEach((s) => {
        if (s.connected) {
          const p = s.bidPrice + (Math.random() - 0.5) * 0.02;
          s.bidPrice = Math.max(0.01, p);
          s.askPrice = s.bidPrice + 0.20;
        }
      });
      if (!['INPUT', 'SELECT'].includes(document.activeElement.tagName)) renderStrategyTable();
    }, 3000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();

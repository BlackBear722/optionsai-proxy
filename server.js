const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query('CREATE TABLE IF NOT EXISTS bot_state (id SERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT)');
  await pool.query('CREATE TABLE IF NOT EXISTS scan_log (id SERIAL PRIMARY KEY, ts TIMESTAMP DEFAULT NOW(), type TEXT, message TEXT)');
  await pool.query('CREATE TABLE IF NOT EXISTS trades (id SERIAL PRIMARY KEY, ts TIMESTAMP DEFAULT NOW(), ticker TEXT, type TEXT, strike NUMERIC, expiry TEXT, contracts INT, premium NUMERIC, order_id TEXT, result TEXT, pnl NUMERIC)');
  console.log('DB ready');
}

async function getState(key, fallback) {
  try {
    var r = await pool.query('SELECT value FROM bot_state WHERE key=$1', [key]);
    return r.rows.length ? JSON.parse(r.rows[0].value) : fallback;
  } catch(e) { return fallback; }
}

async function setState(key, value) {
  try {
    await pool.query('INSERT INTO bot_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [key, JSON.stringify(value)]);
  } catch(e) { console.error('setState:', e.message); }
}

async function addLog(type, message) {
  console.log('[' + type + '] ' + message);
  try { await pool.query('INSERT INTO scan_log(type,message) VALUES($1,$2)', [type, message]); } catch(e) {}
}

async function addTrade(t) {
  try {
    await pool.query('INSERT INTO trades(ticker,type,strike,expiry,contracts,premium,order_id,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [t.ticker, t.type, t.strike, t.expiry, t.contracts, t.premium, t.orderId, t.result || 'open']);
  } catch(e) { console.error('addTrade:', e.message); }
}

// Get next monthly expiry (third Friday of current or next month)
function getNextExpiry() {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  
  function thirdFriday(year, month) {
    var d = new Date(year, month, 1);
    var count = 0;
    while (true) {
      if (d.getDay() === 5) {
        count++;
        if (count === 3) return new Date(d);
      }
      d.setDate(d.getDate() + 1);
    }
  }

  var tf = thirdFriday(et.getFullYear(), et.getMonth());
  var daysAway = Math.floor((tf - et) / 86400000);
  if (daysAway < 3) {
    var nextMonth = et.getMonth() + 1;
    var nextYear = et.getFullYear();
    if (nextMonth > 11) { nextMonth = 0; nextYear++; }
    tf = thirdFriday(nextYear, nextMonth);
  }

  var yy = String(tf.getFullYear()).slice(2);
  var mm = ('0' + (tf.getMonth() + 1)).slice(-2);
  var dd = ('0' + tf.getDate()).slice(-2);
  var formatted = tf.getFullYear() + '-' + mm + '-' + dd;
  console.log('Expiry: ' + formatted);
  return { formatted: formatted, yy: yy, mm: mm, dd: dd };
}

// Build OCC option symbol
function buildSymbol(ticker, type, strike) {
  var exp = getNextExpiry();
  var t = ticker.toUpperCase().trim();
  // Tradier does NOT want space padding — just ticker + date + type + strike
  var ticker6 = t;  // no padding
  var s = parseFloat(strike);
  // Round to nearest $5 for high-priced ETFs, $1 for everything else
  if (t === 'SPY' || t === 'QQQ' || t === 'IWM') {
    s = Math.round(s / 5) * 5;
  } else {
    s = Math.round(s);
  }
  var strikeInt = Math.round(s * 1000);
  var strikeStr = ('00000000' + strikeInt).slice(-8);
  var symbol = ticker6 + exp.yy + exp.mm + exp.dd + type[0].toUpperCase() + strikeStr;
  console.log('Symbol: [' + symbol + '] expiry:' + exp.formatted + ' strike:' + s);
  return { symbol: symbol, expiry: exp.formatted, strike: s };
}

// Fetch market data
async function fetchQuote(ticker) {
  // Use Tradier quotes API — real-time, no rate limits, already authenticated
  var session = await getState('session', null);
  if (session && session.token) {
    try {
      var base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
      var r = await fetch(base + '/markets/quotes?symbols=' + ticker + '&greeks=false', {
        headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json' }
      });
      var data = await r.json();
      var q = data && data.quotes && data.quotes.quote;
      if (q && q.last && parseFloat(q.last) > 0) {
        var price = parseFloat(q.last);
        var prev = parseFloat(q.prevclose) || price;
        var chgPct = prev > 0 ? ((price - prev) / prev * 100) : 0;
        var high = parseFloat(q.high) || price;
        var low = parseFloat(q.low) || price;
        var vol = parseInt(q.volume) || 0;
        var avgVol = parseInt(q.average_volume) || vol || 1;
        var volRatio = vol / avgVol;
        var vwap = ((high + low + price) / 3).toFixed(2);
        var spread = (q.ask && q.bid) ? (((parseFloat(q.ask) - parseFloat(q.bid)) / price) * 100).toFixed(3) : (((high-low)/price)*100).toFixed(3);
        // RSI approximation from price change
        var rsi = chgPct > 3 ? 68 : chgPct > 1 ? 58 : chgPct > 0 ? 52 : chgPct > -1 ? 46 : chgPct > -3 ? 38 : 30;
        var bull = chgPct > 0.5 ? 2 : chgPct > 0 ? 1 : 0;
        var bear = chgPct < -0.5 ? 2 : chgPct < 0 ? 1 : 0;
        var etNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        var etD = new Date(etNow);
        var mid = (etD.getHours() - 9) * 60 + etD.getMinutes() - 30;
        var isOpen = q.tradeable === true || (mid >= 0 && mid <= 390);
        console.log('Tradier ' + ticker + ' $' + price + ' ' + chgPct.toFixed(2) + '% spread:' + spread + '%');
        return {
          ticker: ticker, price: price.toFixed(2), changePct: chgPct.toFixed(2),
          volume: vol, volumeRatio: volRatio.toFixed(2), barVolumeRatio: volRatio.toFixed(2),
          rsi: rsi.toString(), ma9: price.toFixed(2), vwap: vwap,
          spreadEstPct: spread,
          last3Candles: [{ open: prev.toFixed(2), close: price.toFixed(2), bullish: price > prev, vol: vol }],
          consecutiveBull: bull, consecutiveBear: bear,
          intradayHigh: high.toFixed(2), intradayLow: low.toFixed(2),
          bid: q.bid, ask: q.ask,
          isMarketOpen: isOpen, minutesIntoDay: mid,
          marketState: isOpen ? 'REGULAR' : 'CLOSED', source: 'tradier'
        };
      }
    } catch(e) { console.error('Tradier quote error ' + ticker + ': ' + e.message); }
  }

  // Yahoo Finance fallback
  try {
    var r2 = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=5m&range=1d', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com/'
      }
    });
    var data2 = await r2.json();
    var res2 = data2 && data2.chart && data2.chart.result && data2.chart.result[0];
    if (!res2) throw new Error('no yahoo data');
    var meta = res2.meta;
    var price2 = meta.regularMarketPrice;
    if (!price2 || price2 === 0) throw new Error('zero price');
    var prev2 = meta.previousClose || meta.chartPreviousClose || price2;
    var chgPct2 = ((price2 - prev2) / prev2 * 100);
    var vol2 = meta.regularMarketVolume || 0;
    var q2 = res2.indicators && res2.indicators.quote && res2.indicators.quote[0];
    var closes2 = q2 && q2.close ? q2.close.filter(function(v) { return v != null; }) : [];
    var opens2 = q2 && q2.open ? q2.open.filter(function(v) { return v != null; }) : [];
    var highs2 = q2 && q2.high ? q2.high.filter(function(v) { return v != null; }) : [];
    var lows2 = q2 && q2.low ? q2.low.filter(function(v) { return v != null; }) : [];
    var high2 = highs2.length ? Math.max.apply(null, highs2) : price2;
    var low2 = lows2.length ? Math.min.apply(null, lows2) : price2;
    var bull2 = 0, bear2 = 0;
    for (var i = closes2.length - 1; i >= Math.max(0, closes2.length - 4); i--) { if (closes2[i] > opens2[i]) bull2++; else break; }
    for (var j = closes2.length - 1; j >= Math.max(0, closes2.length - 4); j--) { if (closes2[j] < opens2[j]) bear2++; else break; }
    var rsi2 = 50;
    if (closes2.length > 14) {
      var g = 0, l = 0;
      for (var k = closes2.length - 14; k < closes2.length; k++) { var diff = closes2[k] - closes2[k-1]; if (diff > 0) g += diff; else l += Math.abs(diff); }
      var ag = g/14, al = l/14;
      rsi2 = al === 0 ? 100 : Math.round(100-(100/(1+ag/al)));
    }
    var vwap2 = price2.toFixed(2);
    try { var vols2 = q2 && q2.volume ? q2.volume.filter(function(v){return v!=null;}) : []; var sp=0,sv=0; for(var vi=0;vi<closes2.length;vi++){if(closes2[vi]&&vols2[vi]){sp+=closes2[vi]*vols2[vi];sv+=vols2[vi];}} if(sv>0)vwap2=(sp/sv).toFixed(2); } catch(e2) {}
    var spread2 = (high2 && low2 && price2 && high2 > low2) ? (((high2-low2)/price2)*100).toFixed(3) : '0.20';
    var etNow2 = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    var etD2 = new Date(etNow2);
    var mid2 = (etD2.getHours()-9)*60+etD2.getMinutes()-30;
    var isOpen2 = mid2>=0&&mid2<=390;
    console.log('Yahoo ' + ticker + ' $' + price2 + ' ' + chgPct2.toFixed(2) + '%');
    return {
      ticker: ticker, price: price2.toFixed(2), changePct: chgPct2.toFixed(2),
      volume: vol2, barVolumeRatio: '1.50', rsi: rsi2.toString(),
      ma9: price2.toFixed(2), vwap: vwap2, spreadEstPct: spread2,
      last3Candles: [], consecutiveBull: bull2, consecutiveBear: bear2,
      intradayHigh: high2.toFixed(2), intradayLow: low2.toFixed(2),
      isMarketOpen: isOpen2, minutesIntoDay: mid2,
      marketState: meta.marketState, source: 'yahoo'
    };
  } catch(e) { console.error('Yahoo error ' + ticker + ': ' + e.message); }
  return null;
}


app.get('/quote/:ticker', async function(req, res) {
  var d = await fetchQuote(req.params.ticker.toUpperCase());
  if (!d) return res.status(404).json({ error: 'No data' });
  res.json(d);
});

// Claude scan
var CLAUDE_MODEL = 'claude-sonnet-4-20250514';
var SCAN_SYSTEM = 'You are an options trading bot. Given real-time stock data, find a tradeable setup. BUY_CALL if price is up and RSI under 70. BUY_PUT if price is down and RSI above 30. Only NONE if market is closed. Confidence must be exactly HIGH, MEDIUM, or LOW. Strike = nearest whole dollar to current price. Premium = 0.5 to 2 percent of stock price. Respond ONLY with: <SCAN_RESULT>{"ticker":"X","signal":"BUY_CALL","confidence":"MEDIUM","strike":500,"premium":1.50,"reason":"brief"}</SCAN_RESULT>';

async function scanTicker(ticker, settings) {
  var d = await fetchQuote(ticker);
  if (!d) { await addLog('skip', 'no data: ' + ticker); return { ticker: ticker, signal: 'NONE', confidence: 'LOW', reason: 'no data' }; }
  if (!d.isMarketOpen) { await addLog('skip', 'market closed: ' + ticker); return { ticker: ticker, signal: 'NONE', confidence: 'LOW', reason: 'market closed' }; }

  var rsi = parseFloat(d.rsi) || 50;
  var spread = parseFloat(d.spreadEstPct) || 0;
  if (rsi > 80 || rsi < 20) { await addLog('skip', 'extreme RSI ' + rsi + ': ' + ticker); return { ticker: ticker, signal: 'NONE', confidence: 'LOW', reason: 'extreme RSI', d: d }; }
  if (spread > 2.0) { await addLog('skip', 'wide spread ' + spread + ': ' + ticker); return { ticker: ticker, signal: 'NONE', confidence: 'LOW', reason: 'wide spread', d: d }; }

  await addLog('entry', 'scanning ' + ticker + ' $' + d.price + ' (' + d.changePct + '%) RSI:' + d.rsi + ' src:' + d.source);

  try {
    var userMsg = 'Stock: ' + ticker + ' | Price: $' + d.price + ' | Change: ' + d.changePct + '% today | RSI: ' + d.rsi + ' | VWAP: $' + d.vwap + ' | High: $' + d.intradayHigh + ' | Low: $' + d.intradayLow + ' | Bull candles: ' + d.consecutiveBull + ' | Bear candles: ' + d.consecutiveBear + '\n\nProfit target: $' + settings.profitTarget + ' | Stop: $' + settings.stopLoss + '\n\nRespond ONLY with a <SCAN_RESULT> block. No expiry field needed.';
    var apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { await addLog('stop', 'No ANTHROPIC_API_KEY'); return { ticker: ticker, signal: 'NONE', confidence: 'LOW', reason: 'no api key' }; }
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 150, system: SCAN_SYSTEM, messages: [{ role: 'user', content: userMsg }] })
    });
    var data = await r.json();
    if (data.error) { await addLog('stop', 'Claude error: ' + JSON.stringify(data.error)); return { ticker: ticker, signal: 'NONE', confidence: 'LOW', reason: 'claude error', d: d }; }
    var text = (data.content || []).map(function(b) { return b.text || ''; }).join('');
    var match = text.match(/<SCAN_RESULT>([\s\S]*?)<\/SCAN_RESULT>/);
    if (match) {
      var result = JSON.parse(match[1]);
      await addLog(result.confidence === 'HIGH' || result.confidence === 'MEDIUM' ? 'trade' : 'skip',
        'Claude ' + ticker + ': ' + result.signal + ' (' + result.confidence + ') $' + result.premium + ' — ' + result.reason);
      return { ticker: ticker, signal: result.signal, confidence: result.confidence, premium: result.premium, strike: parseFloat(d.price), reason: result.reason, d: d };
    } else {
      await addLog('skip', 'Claude no block for ' + ticker + '. Raw: ' + text.slice(0, 150));
    }
  } catch(e) { await addLog('stop', 'Claude exception ' + ticker + ': ' + e.message); }
  return { ticker: ticker, signal: 'NONE', confidence: 'LOW', reason: 'error', d: d };
}

// Trade execution
async function tradierReq(path, method, body, session) {
  var base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  var opts = { method: method, headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } };
  if (method !== 'GET') opts.body = new URLSearchParams(body).toString();
  var r = await fetch(base + path, opts);
  var text = await r.text();
  console.log('Tradier (' + r.status + '): ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch(e) { return { error: text, status: r.status }; }
}

async function getPositions(session) {
  var data = await tradierReq('/accounts/' + session.accountId + '/positions', 'GET', null, session);
  var raw = data && data.positions && data.positions.position;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

async function getValidStrike(ticker, expiry, type, targetStrike, session) {
  // Look up real available strikes from Tradier
  try {
    var base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
    var url = base + '/markets/options/strikes?symbol=' + ticker + '&expiration=' + expiry;
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json' } });
    var text = await r.text();
    var data = JSON.parse(text);
    var strikes = data && data.strikes && data.strikes.strike;
    if (!strikes) { console.log('No strikes found for ' + ticker + ' ' + expiry); return targetStrike; }
    var arr = Array.isArray(strikes) ? strikes : [strikes];
    // Find closest strike to target
    var closest = arr.reduce(function(prev, curr) {
      return Math.abs(curr - targetStrike) < Math.abs(prev - targetStrike) ? curr : prev;
    });
    console.log('Target strike: ' + targetStrike + ' -> Closest available: ' + closest);
    return closest;
  } catch(e) {
    console.error('getValidStrike error:', e.message);
    return targetStrike;
  }
}

async function getValidExpiry(ticker, session) {
  // Get available expiration dates from Tradier
  try {
    var base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
    var url = base + '/markets/options/expirations?symbol=' + ticker + '&includeAllRoots=true';
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json' } });
    var data = await r.json();
    var dates = data && data.expirations && data.expirations.date;
    if (!dates) return null;
    var arr = Array.isArray(dates) ? dates : [dates];
    // Find next expiry at least 2 days from now
    var now = new Date();
    var cutoff = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    var valid = arr.filter(function(d) { return new Date(d) >= cutoff; });
    if (!valid.length) return null;
    console.log('Valid expiries for ' + ticker + ':', valid.slice(0, 3));
    return valid[0]; // nearest valid expiry
  } catch(e) {
    console.error('getValidExpiry error:', e.message);
    return null;
  }
}

async function placeTrade(trade, session) {
  // Get real expiry from Tradier
  var expiry = await getValidExpiry(trade.ticker, session);
  if (!expiry) {
    var built0 = buildSymbol(trade.ticker, trade.type, trade.strike);
    expiry = built0.expiry;
  }
  await addLog('entry', 'Using expiry: ' + expiry + ' for ' + trade.ticker);

  // Get real strike from Tradier
  var validStrike = await getValidStrike(trade.ticker, expiry, trade.type, trade.strike, session);

  // Build symbol with real expiry and strike
  var exp = { formatted: expiry };
  var dt = new Date(expiry + 'T12:00:00Z');
  exp.yy = String(dt.getUTCFullYear()).slice(2);
  exp.mm = ('0' + (dt.getUTCMonth() + 1)).slice(-2);
  exp.dd = ('0' + dt.getUTCDate()).slice(-2);
  var t = trade.ticker.toUpperCase().trim();
  var strikeInt = Math.round(parseFloat(validStrike) * 1000);
  var strikeStr = ('00000000' + strikeInt).slice(-8);
  var symbol = t + exp.yy + exp.mm + exp.dd + trade.type[0].toUpperCase() + strikeStr;

  var orderBody = {
    class: 'option',
    symbol: trade.ticker,
    option_symbol: symbol,
    side: 'buy_to_open',
    quantity: String(trade.contracts),
    type: 'market',
    duration: 'day'
  };
  await addLog('entry', 'ORDER: sym=' + symbol + ' expiry=' + expiry + ' strike=' + validStrike + ' price=' + trade.limitPrice);
  var result = await tradierReq('/accounts/' + session.accountId + '/orders', 'POST', orderBody, session);
  await addLog('entry', 'RESULT: ' + JSON.stringify(result));
  return result;
}

async function closePos(pos, session) {
  var sym = (pos.symbol || '').trim();
  var ticker = sym.substring(0, 6).trim();
  return tradierReq('/accounts/' + session.accountId + '/orders', 'POST', {
    class: 'option', symbol: ticker, option_symbol: sym,
    side: 'sell_to_close', quantity: String(Math.abs(pos.quantity || 1)),
    type: 'market', duration: 'day'
  }, session);
}

// Engine
var engineTimer = null, monitorTimer = null;

async function runEngine() {
  var engineOn = await getState('engineOn', false);
  if (!engineOn) return;
  var settings = await getState('settings', { profitTarget: 0.50, stopLoss: 0.25, dailyMax: 500, maxPositions: 2, contracts: 1, schedule: '1min' });
  var session = await getState('session', null);
  var watchlist = await getState('watchlist', ['AAPL', 'MSFT', 'NVDA', 'META', 'QQQ']);
  var dailyLoss = await getState('dailyLoss', 0);
  var killSwitch = await getState('killSwitch', false);
  if (!session) { await addLog('skip', 'no session'); return; }
  if (killSwitch) { await addLog('stop', 'kill switch on'); return; }
  if (dailyLoss >= settings.dailyMax) { await addLog('stop', 'daily limit hit $' + settings.dailyMax); await setState('engineOn', false); return; }
  var positions = [];
  try { positions = await getPositions(session); } catch(e) { await addLog('stop', 'positions error: ' + e.message); return; }
  await addLog('entry', 'open positions: ' + positions.length + '/' + settings.maxPositions);
  if (positions.length >= settings.maxPositions) { await addLog('skip', 'max positions reached (' + positions.length + '/' + settings.maxPositions + ') — not buying'); return; }
  await addLog('entry', 'scanning ' + watchlist.length + ' tickers: ' + watchlist.join(', '));
  var results = [];
  for (var i = 0; i < watchlist.length; i++) {
    var result = await scanTicker(watchlist[i], settings);
    results.push(result);
    // No delay needed - Tradier API has no rate limits
  }
  var signals = results.filter(function(r) { return r.signal === 'BUY_CALL' || r.signal === 'BUY_PUT'; });
  if (signals.length > 0) {
    var best = signals.sort(function(a, b) { return (parseFloat(b.premium) || 0) - (parseFloat(a.premium) || 0); })[0];
    await addLog('trade', 'BEST: ' + best.ticker + ' ' + best.signal + ' @ $' + best.premium);
    var trade = { action: 'BUY', type: best.signal.indexOf('CALL') >= 0 ? 'CALL' : 'PUT', ticker: best.ticker, strike: parseFloat(best.d && best.d.price ? best.d.price : best.strike), contracts: settings.contracts, limitPrice: best.premium };
    try {
      var orderResult = await placeTrade(trade, session);
      var orderId = orderResult && orderResult.order && orderResult.order.id;
      if (orderId) {
        await addLog('trade', 'ORDER PLACED: ' + best.ticker + ' ' + trade.type + ' ID:' + orderId);
        await addTrade({ ticker: trade.ticker, type: trade.type, strike: trade.strike, expiry: '', contracts: trade.contracts, premium: trade.limitPrice, orderId: orderId, result: 'open' });
        // Wait for position to register before next scan
        await new Promise(function(r) { setTimeout(r, 10000); });
      } else {
        await addLog('stop', 'order failed: ' + JSON.stringify(orderResult));
      }
    } catch(e) { await addLog('stop', 'order exception: ' + e.message); }
  } else {
    await addLog('skip', 'no signals found');
  }
}

async function runMonitor() {
  var engineOn = await getState('engineOn', false);
  var killSwitch = await getState('killSwitch', false);
  var session = await getState('session', null);
  var settings = await getState('settings', { profitTarget: 0.50, stopLoss: 0.25 });
  if (!engineOn || killSwitch || !session) return;
  try {
    var positions = await getPositions(session);
    var dailyLoss = await getState('dailyLoss', 0);
    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      if (!pos.cost_basis || !pos.market_value) continue;
      var pnlPer = (pos.market_value - pos.cost_basis) / Math.abs(pos.quantity || 1);
      if (pnlPer >= settings.profitTarget) {
        await addLog('trade', 'PROFIT TARGET: ' + pos.symbol + ' +$' + pnlPer.toFixed(2));
        await closePos(pos, session);
        setTimeout(runEngine, 3000);
      } else if (pnlPer <= -settings.stopLoss) {
        await addLog('stop', 'STOP LOSS: ' + pos.symbol + ' -$' + Math.abs(pnlPer).toFixed(2));
        await closePos(pos, session);
        dailyLoss += Math.abs(pos.market_value - pos.cost_basis);
        await setState('dailyLoss', dailyLoss);
        setTimeout(runEngine, 3000);
      }
    }
  } catch(e) { console.error('monitor error:', e.message); }
}

function startTimers(schedule) {
  clearInterval(engineTimer);
  clearInterval(monitorTimer);
  var msMap = { '1min': 60000, '2min': 120000, '5min': 300000, '10min': 600000, '15min': 900000, '30min': 1800000 };
  var ms = msMap[schedule] || 300000;
  engineTimer = setInterval(runEngine, ms);
  monitorTimer = setInterval(runMonitor, 30000);
  console.log('timers: ' + schedule);
}

// API routes
app.post('/api/connect', async function(req, res) {
  var token = req.body.token, mode = req.body.mode;
  if (!token) return res.status(400).json({ error: 'No token' });
  var isLive = mode === 'live';
  var base = isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  try {
    var r = await fetch(base + '/user/profile', { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
    if (!r.ok) return res.status(401).json({ error: 'Invalid token' });
    var data = await r.json();
    var accountId = (data.profile && data.profile.account && data.profile.account.account_number) ||
      (data.profile && data.profile.accounts && data.profile.accounts.account && data.profile.accounts.account[0] && data.profile.accounts.account[0].account_number);
    var name = (data.profile && data.profile.name) || 'Trader';
    var session = { token: token, accountId: accountId, isLive: isLive, name: name };
    await setState('session', session);
    await addLog('entry', 'connected: ' + accountId);
    res.json({ ok: true, accountId: accountId, name: name, isLive: isLive });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/session', async function(req, res) { await setState('session', req.body); res.json({ ok: true }); });

app.post('/api/settings', async function(req, res) {
  await setState('settings', req.body.settings);
  await setState('watchlist', req.body.watchlist);
  startTimers(req.body.settings.schedule);
  await addLog('entry', 'settings saved');
  res.json({ ok: true });
});

app.post('/api/engine', async function(req, res) {
  var on = req.body.on;
  await setState('engineOn', on);
  if (on) {
    var s = await getState('settings', { schedule: '5min' });
    startTimers(s.schedule);
    await addLog('entry', 'engine on');
    runEngine();
  } else {
    clearInterval(engineTimer);
    clearInterval(monitorTimer);
    await addLog('entry', 'engine off');
  }
  res.json({ ok: true, engineOn: on });
});

app.post('/api/killswitch', async function(req, res) {
  var on = req.body.on;
  await setState('killSwitch', on);
  if (on) { clearInterval(engineTimer); clearInterval(monitorTimer); }
  await addLog(on ? 'stop' : 'entry', on ? 'KILL SWITCH ON' : 'kill switch off');
  res.json({ ok: true });
});

app.get('/api/state', async function(req, res) {
  var engineOn = await getState('engineOn', false);
  var settings = await getState('settings', { profitTarget: 0.50, stopLoss: 0.25, dailyMax: 500, maxPositions: 2, contracts: 1, schedule: '1min' });
  var watchlist = await getState('watchlist', ['AAPL', 'MSFT', 'NVDA', 'META', 'QQQ']);
  var killSwitch = await getState('killSwitch', false);
  var dailyLoss = await getState('dailyLoss', 0);
  var session = await getState('session', null);
  res.json({ engineOn: engineOn, settings: settings, watchlist: watchlist, killSwitch: killSwitch, dailyLoss: dailyLoss, hasSession: !!session, accountId: session && session.accountId, isLive: session && session.isLive });
});

app.get('/api/logs', async function(req, res) {
  try { var r = await pool.query('SELECT ts,type,message FROM scan_log ORDER BY ts DESC LIMIT 100'); res.json(r.rows); }
  catch(e) { res.json([]); }
});

app.get('/api/trades', async function(req, res) {
  try { var r = await pool.query('SELECT * FROM trades ORDER BY ts DESC LIMIT 50'); res.json(r.rows); }
  catch(e) { res.json([]); }
});

app.post('/api/resetdaily', async function(req, res) { await setState('dailyLoss', 0); res.json({ ok: true }); });

app.use('/tradier', async function(req, res) {
  var session = await getState('session', null);
  var isLive = (session && session.isLive) || req.headers['x-tradier-live'] === 'true';
  var base = isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  var token = (req.headers['authorization'] || '').replace('Bearer ', '') || (session && session.token) || '';
  try {
    var opts = { method: req.method, headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } };
    if (req.method !== 'GET') opts.body = new URLSearchParams(req.body).toString();
    var response = await fetch(base + req.url, opts);
    var text = await response.text();
    res.status(response.status).set('Content-Type', 'application/json').send(text);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function scheduleMidnightReset() {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setHours(24, 0, 0, 0);
  setTimeout(async function() {
    await setState('dailyLoss', 0);
    console.log('daily reset');
    scheduleMidnightReset();
  }, et - now);
}

app.get('/', function(req, res) { res.sendFile(__dirname + '/public/index.html'); });

var PORT = process.env.PORT || 3001;
pool.connect()
  .then(function() { return initDB(); })
  .then(function() {
    app.listen(PORT, function() { console.log('running on port ' + PORT); });
    scheduleMidnightReset();
    getState('engineOn', false).then(function(on) {
      if (on) {
        getState('settings', { schedule: '5min' }).then(function(s) {
          startTimers(s.schedule);
          runEngine();
        });
      }
    });
  })
  .catch(function(e) {
    console.error('DB failed:', e.message);
    app.listen(PORT, function() { console.log('running on port ' + PORT + ' no DB'); });
  });

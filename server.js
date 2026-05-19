'use strict';
var express = require('express');
var fetch = require('node-fetch');
var bodyParser = require('body-parser');
var { Pool } = require('pg');

var app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS bot_state (id SERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS account_transactions (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT NOW(), type TEXT NOT NULL,
    ticker TEXT, description TEXT, amount NUMERIC NOT NULL, balance NUMERIC NOT NULL, position_id TEXT
  )`);
  try {
    var balRow = await pool.query("SELECT value FROM bot_state WHERE key='accountBalance'");
    if (!balRow.rows.length) {
      await pool.query("INSERT INTO bot_state(key,value) VALUES('accountBalance','10000') ON CONFLICT(key) DO NOTHING");
      console.log('Account initialized with $10,000 starting balance');
    }
  } catch(e) {}
  console.log('DB initialized');
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


// ═══════════════════════════════════════════════════════════════════════
// TREND FOLLOWING BOT — inlined
// 30-45 day options | $200 profit target | Scans once daily at 10am ET
// ═══════════════════════════════════════════════════════════════════════

async function initTrendDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS trend_positions (
    id SERIAL PRIMARY KEY, ticker TEXT, direction TEXT, strike TEXT,
    expiry TEXT, premium NUMERIC, contracts INTEGER DEFAULT 1, order_id TEXT,
    entry_price NUMERIC, target_price NUMERIC, stop_price NUMERIC,
    status TEXT DEFAULT 'open', pnl NUMERIC, reason TEXT,
    entered_at TIMESTAMPTZ DEFAULT NOW(), exited_at TIMESTAMPTZ
  )`);
  // Migrate strike column from NUMERIC to TEXT if needed (for spread support)
  try {
    await pool.query(`ALTER TABLE trend_positions ALTER COLUMN strike TYPE TEXT USING strike::TEXT`);
    console.log('Trend DB: strike column migrated to TEXT');
  } catch(e) {
    // Already TEXT or migration not needed
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS trend_logs (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT NOW(), type TEXT, message TEXT
  )`);
  console.log('Trend bot DB ready');
}

async function trendLog(type, message) {
  console.log('[TREND] ' + message);
  try { await pool.query('INSERT INTO trend_logs (type,message) VALUES ($1,$2)', [type, message]); } catch(e) {}
}

// ── Account Balance Tracker ───────────────────────────────────────────────────
async function getBalance() {
  var val = await getState('accountBalance', 10000);
  return parseFloat(val) || 10000;
}

async function recordTransaction(type, ticker, description, amount, positionId) {
  try {
    var balance = await getBalance();
    var newBalance = balance + amount;
    await setState('accountBalance', newBalance);
    await pool.query(
      'INSERT INTO account_transactions (type, ticker, description, amount, balance, position_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [type, ticker || null, description, amount.toFixed(2), newBalance.toFixed(2), positionId || null]
    );
    console.log('[ACCOUNT] ' + type + ' ' + (amount >= 0 ? '+' : '') + '$' + amount.toFixed(2) + ' → balance $' + newBalance.toFixed(2));
    return newBalance;
  } catch(e) { console.error('recordTransaction error:', e.message); return null; }
}

var TREND_SYSTEM = 'You are a trend-following options bot analyzing daily charts to find multi-week momentum trades. You use VERTICAL SPREADS to reduce cost and risk.\n\nTREND RULES:\n- UPTREND: Price above 20-day MA AND week change positive. Bonus if 20MA also above 50MA.\n- DOWNTREND: Price below 20-day MA AND week change negative. Bonus if 20MA below 50MA.\n- FLAT: Price chopping around 20MA with no clear weekly direction — do NOT trade.\n\nENTRY RULES:\n- BUY_CALL_SPREAD: Uptrend confirmed, RSI 40-65, price near or pulling back to 20MA.\n- BUY_PUT_SPREAD: Downtrend confirmed, RSI 35-60, price rejected at or below 20MA.\n- IDEAL entries: pullback to 20MA in uptrend (RSI 40-55), OR early breakout continuation (RSI 55-65).\n- SPY direction is context only.\n- NEVER enter RSI above 65 (too extended) or below 20 (extreme oversold).\n\nSPREAD CONSTRUCTION:\n- BUY_CALL_SPREAD: Buy ATM call + Sell call 5-10 points higher. Net cost $1.50-$2.50.\n- BUY_PUT_SPREAD: Buy ATM put + Sell put 5-10 points lower. Net cost $1.50-$2.50.\n- Expiry: 30-40 days out.\n- Max net premium: $2.50 per spread.\n- The short strike should be at a realistic target price for the trend move.\n\nEXAMPLE — Stock at $215, uptrend:\n  Buy $215 call for $3.75, Sell $225 call for $2.00 = net $1.75 cost\n  Max profit = ($225-$215-$1.75) x 100 = $825 if stock reaches $225\n  Max loss = $1.75 x 100 = $175\n\nPROFIT TARGET: 80% of max spread width (e.g. $8 wide spread targets $640). STOP LOSS: 50% of net premium paid.\n\nHIGH confidence: trend clearly established, clean pullback entry near 20MA, RSI confirms direction.\nNONE: trend unclear, RSI extreme, price too extended from 20MA, or stock just had huge move.\n\nRespond ONLY with: <TREND_RESULT>{"ticker":"X","signal":"BUY_CALL_SPREAD","confidence":"HIGH","long_strike":200,"short_strike":210,"expiry":"2026-06-06","net_premium":1.75,"contracts":1,"reason":"brief reason"}</TREND_RESULT>';

async function callTrendClaude(msg) {
  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: TREND_SYSTEM, messages: [{ role: 'user', content: msg }] })
    });
    var data = await r.json();
    var text = (data.content || []).map(function(b) { return b.text || ''; }).join('');
    var match = text.match(/<TREND_RESULT>([\s\S]*?)<\/TREND_RESULT>/);
    if (!match) return null;
    var result = JSON.parse(match[1]);
    // Normalize signal names — support both old (BUY_CALL) and new (BUY_CALL_SPREAD) formats
    if (result.signal === 'BUY_CALL') result.signal = 'BUY_CALL_SPREAD';
    if (result.signal === 'BUY_PUT') result.signal = 'BUY_PUT_SPREAD';
    // Normalize premium field — use net_premium if present
    if (result.net_premium) result.premium = result.net_premium;
    return result;
  } catch(e) { console.error('Trend Claude error:', e.message); return null; }
}

async function fetchDailyCandles(ticker) {
  // Retry logic — try up to 2 times with different user agents
  var userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
  ];
  for (var attempt = 0; attempt < 2; attempt++) {
  try {
    // Fetch daily candles (3 months) for MA, RSI, trend
    var r = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1d&range=3mo&nocache=' + Date.now(), {
      headers: {
        'User-Agent': userAgents[attempt],
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    });
    if (!r.ok) { await new Promise(function(res){setTimeout(res,2000);}); continue; }
    var data = await r.json();
    var res = data && data.chart && data.chart.result && data.chart.result[0];
    if (!res) { await new Promise(function(res){setTimeout(res,2000);}); continue; }
    var q = res.indicators && res.indicators.quote && res.indicators.quote[0];
    if (!q || !q.close) return null;
    var closes = q.close.filter(function(v) { return v != null && !isNaN(v); });
    var volumes = (q.volume || []).filter(function(v) { return v != null; });
    if (closes.length < 50) return null;
    var price = closes[closes.length - 1];
    var ma20 = closes.slice(-20).reduce(function(s, v) { return s + v; }, 0) / 20;
    var ma50 = closes.slice(-50).reduce(function(s, v) { return s + v; }, 0) / 50;
    var gains = 0, tlosses = 0;
    for (var i = closes.length - 14; i < closes.length; i++) { var d = closes[i] - closes[i-1]; if (d > 0) gains += d; else tlosses += Math.abs(d); }
    var rsi = tlosses === 0 ? 100 : Math.round(100 - (100 / (1 + (gains/14) / (tlosses/14))));
    var prevClose = closes[closes.length - 2] || price;
    var weekAgo = closes[closes.length - 6] || price;
    var monthAgo = closes[closes.length - 21] || price;
    var trend = 'FLAT';
    if (price > ma20 && price > weekAgo) trend = 'UP';
    else if (price < ma20 && price < weekAgo) trend = 'DOWN';

    // Fetch weekly candles (6 months) for multi-week trend confirmation
    var weeklyTrend = 'UNKNOWN';
    var weeklyRsi = 50;
    var weeklyMa10 = 0;
    try {
      var rw = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1wk&range=6mo', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      var wdata = await rw.json();
      var wres = wdata && wdata.chart && wdata.chart.result && wdata.chart.result[0];
      var wq = wres && wres.indicators && wres.indicators.quote && wres.indicators.quote[0];
      if (wq && wq.close) {
        var wcloses = wq.close.filter(function(v) { return v != null && !isNaN(v); });
        if (wcloses.length >= 10) {
          // 10-week MA (roughly 50-day equivalent on weekly)
          weeklyMa10 = wcloses.slice(-10).reduce(function(s, v) { return s + v; }, 0) / 10;
          var wPrice = wcloses[wcloses.length - 1];
          var w4ago = wcloses[wcloses.length - 5] || wPrice; // 4 weeks ago
          // Weekly RSI
          var wgains = 0, wlosses2 = 0;
          for (var wi = wcloses.length - 14; wi < wcloses.length; wi++) {
            if (wi < 1) continue;
            var wd = wcloses[wi] - wcloses[wi-1];
            if (wd > 0) wgains += wd; else wlosses2 += Math.abs(wd);
          }
          weeklyRsi = wlosses2 === 0 ? 100 : Math.round(100 - (100 / (1 + (wgains/14) / (wlosses2/14))));
          // Weekly trend: price above 10-week MA and above where it was 4 weeks ago
          if (wPrice > weeklyMa10 && wPrice > w4ago) weeklyTrend = 'UP';
          else if (wPrice < weeklyMa10 && wPrice < w4ago) weeklyTrend = 'DOWN';
          else weeklyTrend = 'FLAT';
        }
      }
    } catch(we) { console.error('weekly candles ' + ticker + ':', we.message); }

    return {
      ticker: ticker, price: price.toFixed(2), ma20: ma20.toFixed(2), ma50: ma50.toFixed(2),
      rsi: rsi, trend: trend,
      weeklyTrend: weeklyTrend, weeklyRsi: weeklyRsi, weeklyMa10: weeklyMa10.toFixed(2),
      chgPct: ((price - prevClose) / prevClose * 100).toFixed(2),
      weekChgPct: ((price - weekAgo) / weekAgo * 100).toFixed(2),
      monthChgPct: ((price - monthAgo) / monthAgo * 100).toFixed(2),
      distFromMa20Pct: ((price - ma20) / ma20 * 100).toFixed(2),
      nearMa20: Math.abs((price - ma20) / ma20 * 100) < 2
    };
  } catch(e) {
    console.error('fetchDailyCandles ' + ticker + ' attempt ' + attempt + ':', e.message);
    await new Promise(function(res){setTimeout(res,2000);});
  }
  } // end retry loop
  return null;
}

var trendWatchCache = { date: null, tickers: [] };
var trendLastScan = null;

async function buildTrendWatchlist() {
  var etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var todayStr = etNow.toLocaleDateString('en-CA');
  if (trendWatchCache.date === todayStr && trendWatchCache.tickers.length > 0) return trendWatchCache.tickers;

  // Broad universe of trending-friendly stocks across sectors
  // AAPL removed from trend watchlist — 2 same-day losses, options too expensive/tight
  var anchors = [
    // Mega-cap tech — highest volume, most reliable data
    'NVDA', 'TSLA', 'META', 'MSFT', 'AMD', 'GOOGL', 'AMZN',
    // High-momentum
    'MSTR', 'PLTR', 'COIN', 'CRWD', 'SMCI',
    // Semis
    'TSM', 'AVGO', 'QCOM', 'ARM',
    // Cybersecurity & cloud
    'PANW', 'DDOG',
    // Finance
    'JPM', 'GS',
    // Energy & commodities
    'XOM', 'GLD',
    // Consumer momentum
    'NFLX', 'SHOP', 'AXON'
  ];

  // Also add dynamic daily movers as bonus candidates
  var extras = [];
  try {
    var r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=30', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    var data = await r.json();
    var quotes = data && data.finance && data.finance.result && data.finance.result[0] && data.finance.result[0].quotes || [];
    quotes.forEach(function(q) {
      if (!q || !q.symbol) return;
      var sym = q.symbol.toUpperCase();
      if (anchors.indexOf(sym) >= 0 || sym.length > 5 || sym.indexOf('.') >= 0) return;
      var price = parseFloat(q.regularMarketPrice) || 0;
      if (price < 20 || price > 1500) return;
      var chg = parseFloat(q.regularMarketChangePercent) || 0;
      var volR = q.averageDailyVolume3Month > 0 ? q.regularMarketVolume / q.averageDailyVolume3Month : 0;
      if (Math.abs(chg) >= 3 && volR >= 2.0) extras.push(sym);
    });
  } catch(e) {}

  var final = anchors.concat(extras.slice(0, 5));
  trendWatchCache = { date: todayStr, tickers: final };
  await trendLog('entry', '📋 Trend watchlist (' + final.length + ' tickers): ' + final.join(', '));
  return final;
}

// ── Trend Position Monitor — runs every 5 min during market hours ─────────
// ── Gap Protection — runs at 9:05am to catch overnight gaps through stop loss ─
async function gapProtectionCheck() {
  try {
    var openPos = await pool.query("SELECT * FROM trend_positions WHERE status='open'");
    if (!openPos.rows.length) return;
    await trendLog('entry', '🌅 Gap protection check — ' + openPos.rows.length + ' open position(s)');

    for (var i = 0; i < openPos.rows.length; i++) {
      var pos = openPos.rows[i];
      try {
        // Fetch current premarket/opening price
        var r = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/' + pos.ticker + '?interval=1m&range=1d', {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        var data = await r.json();
        var meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
        var currentStockPrice = meta && meta.regularMarketPrice ? parseFloat(meta.regularMarketPrice) : null;
        if (!currentStockPrice) continue;

        var entryPrice = parseFloat(pos.entry_price) || 0;
        // Handle spread positions — strike stored as "200/210"
        var isSpread = pos.direction === 'CALL_SPREAD' || pos.direction === 'PUT_SPREAD';
        var isPut2 = pos.direction === 'PUT' || pos.direction === 'PUT_SPREAD';
        var strikeParts = String(pos.strike).split('/');
        var longStrike2 = parseFloat(strikeParts[0]) || currentStockPrice;
        var shortStrike2 = strikeParts[1] ? parseFloat(strikeParts[1]) : null;
        var spreadWidth2 = shortStrike2 ? Math.abs(shortStrike2 - longStrike2) : 0;
        var stockMove = currentStockPrice - longStrike2;
        var pctMove = longStrike2 > 0 ? ((currentStockPrice - longStrike2) / longStrike2) : 0;
        // Spread delta is lower than single option — net delta ~0.3 for ATM spread
        var delta = isSpread
          ? (pctMove > 0.03 ? 0.40 : pctMove < -0.03 ? 0.20 : 0.30)
          : (pctMove > 0.03 ? 0.65 : pctMove < -0.03 ? 0.35 : 0.50);
        if (isPut2) delta = -delta;
        // Cap spread value at spread width
        var estimatedOptionPrice = entryPrice + (stockMove * Math.abs(delta));
        if (isSpread && spreadWidth2 > 0) {
          estimatedOptionPrice = Math.min(estimatedOptionPrice, spreadWidth2 - 0.05); // cap at max spread value
        }
        estimatedOptionPrice = Math.max(0.01, estimatedOptionPrice);
        var pnlPerContract = (estimatedOptionPrice - entryPrice) * 100 * (pos.contracts || 1);
        var hardStop = entryPrice * 0.60;

        await trendLog('entry', 'Gap check ' + pos.ticker + ': stock=$' + currentStockPrice.toFixed(2) +
          ' option~$' + estimatedOptionPrice.toFixed(2) +
          ' stop=$' + hardStop.toFixed(2) +
          ' pnl=$' + pnlPerContract.toFixed(0));

        // If option is below hard stop — close immediately
        if (estimatedOptionPrice <= hardStop) {
          await pool.query(
            "UPDATE trend_positions SET status='loss', pnl=$1, exited_at=NOW() WHERE id=$2",
            [pnlPerContract.toFixed(2), pos.id]
          );
          await trendLog('stop', '🚨 GAP PROTECTION: ' + pos.ticker + ' opened below stop loss — closed at $' +
            pnlPerContract.toFixed(0) + ' (stock gapped to $' + currentStockPrice.toFixed(2) + ')');
        } else {
          await trendLog('entry', 'Gap check ' + pos.ticker + ' OK — above stop loss');
        }
      } catch(posErr) {
        console.error('Gap check error for ' + pos.ticker + ':', posErr.message);
      }
    }
  } catch(e) {
    console.error('gapProtectionCheck error:', e.message);
  }
}

// In-memory peak price tracker for trend trailing stops { posId: peakOptionPrice }
var trendPeakPrices = {};

async function monitorTrendPositions() {
  try {
    var openPos = await pool.query("SELECT * FROM trend_positions WHERE status='open'");
    if (!openPos.rows.length) return;
    await trendLog('entry', 'Monitoring ' + openPos.rows.length + ' open trend position(s)');

    for (var i = 0; i < openPos.rows.length; i++) {
      var pos = openPos.rows[i];
      try {
        // ── Fetch current stock price — Tradier primary, Yahoo fallback ─────────
        var currentStockPrice = null;
        try {
          var session = await getState('session', null);
          if (session && session.token) {
            var tBase = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
            var tqR = await fetch(tBase + '/markets/quotes?symbols=' + pos.ticker + '&greeks=false', {
              headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json' }
            });
            var tqData = await tqR.json();
            var tqQ = tqData && tqData.quotes && tqData.quotes.quote;
            if (tqQ && (tqQ.last || tqQ.bid)) {
              currentStockPrice = parseFloat(tqQ.last || ((tqQ.bid + tqQ.ask) / 2));
            }
          }
        } catch(tradierErr) { console.error('Tradier price fetch:', tradierErr.message); }

        // Yahoo fallback if Tradier fails
        if (!currentStockPrice) {
          try {
            var yR = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/' + pos.ticker + '?interval=5m&range=1d', {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' }
            });
            var yData = await yR.json();
            var yMeta = yData && yData.chart && yData.chart.result && yData.chart.result[0] && yData.chart.result[0].meta;
            currentStockPrice = yMeta && yMeta.regularMarketPrice ? parseFloat(yMeta.regularMarketPrice) : null;
          } catch(yahooErr) { console.error('Yahoo price fetch:', yahooErr.message); }
        }

        if (!currentStockPrice) {
          await trendLog('entry', 'Monitor ' + pos.ticker + ': price fetch failed — skipping this check');
          continue;
        }

        // ── Estimate option price using delta model ───────────────────────────
        var entryPrice = parseFloat(pos.entry_price);
        var isSpreadPos = pos.direction === 'CALL_SPREAD' || pos.direction === 'PUT_SPREAD';
        var isPutPos = pos.direction === 'PUT' || pos.direction === 'PUT_SPREAD';
        var strikeParts = String(pos.strike).split('/');
        var longStrikeM = parseFloat(strikeParts[0]) || currentStockPrice;
        var shortStrikeM = strikeParts[1] ? parseFloat(strikeParts[1]) : null;
        var spreadWidthM = shortStrikeM ? Math.abs(shortStrikeM - longStrikeM) : 0;
        var stockMove = currentStockPrice - longStrikeM;
        var pctMove = longStrikeM > 0 ? ((currentStockPrice - longStrikeM) / longStrikeM) : 0;
        // Spread delta is lower — net delta ~0.30 ATM vs ~0.50 for single options
        var delta = isSpreadPos
          ? (pctMove > 0.03 ? 0.40 : pctMove < -0.03 ? 0.20 : 0.30)
          : (pctMove > 0.03 ? 0.65 : pctMove < -0.03 ? 0.35 : 0.50);
        if (isPutPos) delta = -delta;
        var estimatedOptionPrice = entryPrice + (stockMove * Math.abs(delta));
        if (isSpreadPos && spreadWidthM > 0) {
          estimatedOptionPrice = Math.min(estimatedOptionPrice, spreadWidthM - 0.05);
        }
        estimatedOptionPrice = Math.max(0.01, estimatedOptionPrice);

        // ── P&L calculation ───────────────────────────────────────────────────
        var pnlPerContract = (estimatedOptionPrice - entryPrice) * 100 * (pos.contracts || 1);
        var pnlPct = ((estimatedOptionPrice - entryPrice) / entryPrice * 100).toFixed(1);
        var daysHeld = pos.entered_at ? Math.floor((Date.now() - new Date(pos.entered_at)) / (1000 * 60 * 60 * 24)) : 0;

        // ── Trailing stop — activates at +50% gain ────────────────────────────
        var posKey = 'trend_' + pos.id;
        if (!trendPeakPrices[posKey]) trendPeakPrices[posKey] = entryPrice;
        if (estimatedOptionPrice > trendPeakPrices[posKey]) {
          trendPeakPrices[posKey] = estimatedOptionPrice;
        }
        var peakPrice = trendPeakPrices[posKey];
        var peakGainPct = ((peakPrice - entryPrice) / entryPrice * 100);
        var trailStopPrice = peakGainPct >= 40 ? peakPrice * 0.80 : null; // activates at 40% gain, trails 20% below peak

        await trendLog('entry', 'Monitor ' + pos.ticker + ' ' + pos.direction +
          ': stock=$' + currentStockPrice.toFixed(2) +
          ' option~$' + estimatedOptionPrice.toFixed(2) +
          ' peak=$' + peakPrice.toFixed(2) +
          ' PnL=$' + pnlPerContract.toFixed(0) + ' (' + pnlPct + '%)' +
          ' held:' + daysHeld + 'd' +
          (trailStopPrice ? ' trailStop=$' + trailStopPrice.toFixed(2) : ''));

        // ── Exit decisions ────────────────────────────────────────────────────
        // No fixed profit target — let winners run via trailing stop
        // Trail activates at 40% gain, trails 20% below peak
        // Hard stop at 40% of premium | Expiry exit at 7 days remaining

        // 1. Trailing stop — activates at 40% gain, trails 20% below peak
        if (trailStopPrice && estimatedOptionPrice <= trailStopPrice) {
          var isWin = pnlPerContract > 0;
          await pool.query("UPDATE trend_positions SET status=$1, pnl=$2, exited_at=NOW() WHERE id=$3", [isWin ? 'win' : 'loss', pnlPerContract.toFixed(2), pos.id]);
          delete trendPeakPrices[posKey];
          var entryPaid = parseFloat(pos.entry_price) * 100 * (pos.contracts || 1);
          await recordTransaction(isWin ? 'TRADE_WIN' : 'TRADE_LOSS', pos.ticker,
            'TRAILING STOP: ' + pos.direction + ' closed at $' + estimatedOptionPrice.toFixed(2),
            entryPaid + pnlPerContract, pos.id
          );
          await trendLog(isWin ? 'trade' : 'stop', '📉 TRAILING STOP: ' + pos.ticker +
            ' ' + (isWin ? '+' : '') + '$' + pnlPerContract.toFixed(0) +
            ' (' + pnlPct + '%) peak=$' + peakPrice.toFixed(2) + ' in ' + daysHeld + 'd');
          continue;
        }

        // 2. Hard stop loss: 40% of premium paid
        var hardStop = entryPrice * 0.60;
        if (estimatedOptionPrice <= hardStop) {
          await pool.query("UPDATE trend_positions SET status='loss', pnl=$1, exited_at=NOW() WHERE id=$2", [pnlPerContract.toFixed(2), pos.id]);
          delete trendPeakPrices[posKey];
          var entryPaid2 = parseFloat(pos.entry_price) * 100 * (pos.contracts || 1);
          await recordTransaction('TRADE_LOSS', pos.ticker,
            'STOP LOSS: ' + pos.direction + ' closed at $' + estimatedOptionPrice.toFixed(2),
            entryPaid2 + pnlPerContract, pos.id
          );
          await trendLog('stop', '🛑 STOP LOSS: ' + pos.ticker + ' -$' + Math.abs(pnlPerContract).toFixed(0) + ' — closing');
          continue;
        }

        // 3. Expiry exit — 7 days before expiry to avoid theta decay
        if (pos.expiry) {
          var expiryDate = new Date(pos.expiry + 'T12:00:00Z');
          var daysLeft = Math.floor((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
          if (daysLeft <= 7) {
            var isWinExp = pnlPerContract > 0;
            await pool.query("UPDATE trend_positions SET status=$1, pnl=$2, exited_at=NOW() WHERE id=$3", [isWinExp ? 'win' : 'loss', pnlPerContract.toFixed(2), pos.id]);
            delete trendPeakPrices[posKey];
            var entryPaid3 = parseFloat(pos.entry_price) * 100 * (pos.contracts || 1);
            await recordTransaction(isWinExp ? 'TRADE_WIN' : 'TRADE_LOSS', pos.ticker,
              'EXPIRY EXIT ' + daysLeft + 'd left: ' + pos.direction,
              entryPaid3 + pnlPerContract, pos.id
            );
            await trendLog(isWinExp ? 'trade' : 'stop', '⏰ EXPIRY EXIT (' + daysLeft + 'd left): ' + pos.ticker + ' $' + pnlPerContract.toFixed(0));
          }
        }

      } catch(posErr) { console.error('Monitor position error ' + pos.ticker + ':', posErr.message); }
    }
  } catch(e) { console.error('monitorTrendPositions error:', e.message); }
}

// Mutex to prevent concurrent scans
var trendScanRunning = false;

async function runTrendScanLogic() {
  // Fix 1: Race condition guard
  if (trendScanRunning) {
    await trendLog('skip', 'Scan already in progress — skipping concurrent scan');
    return;
  }
  trendScanRunning = true;
  try {
  var etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var todayStr = etNow.toLocaleDateString('en-CA');
  var etHour = etNow.getHours(), etMin = etNow.getMinutes(), etDay = etNow.getDay();

  // HARD MARKET HOURS GATE — no new positions outside 9:30am-3:45pm ET Mon-Fri
  var isWeekday = etDay >= 1 && etDay <= 5;
  var minOfDay = etHour * 60 + etMin;
  if (!isWeekday || minOfDay < 570 || minOfDay > 945) {
    await trendLog('skip', 'Market closed (' + etHour + ':' + String(etMin).padStart(2,'0') + ' ET) — no new positions allowed');
    return;
  }

  await trendLog('entry', 'Trend scan running — ' + todayStr);

  // Fix 2: Fetch full open position rows (not just count) for ticker checking
  var openPos = await pool.query("SELECT * FROM trend_positions WHERE status='open'");
  if (openPos.rows.length >= 2) { await trendLog('skip', 'Max positions (2) reached'); return; }

  // Position sizing — max 10% of available cash per trade
  var accountBalance = await getBalance();
  var capitalAtRisk = 0;
  openPos.rows.forEach(function(p) { capitalAtRisk += parseFloat(p.entry_price) * 100 * (p.contracts || 1); });
  var availableCash = accountBalance - capitalAtRisk;
  var maxTradeCapital = availableCash * 0.10; // 10% of available cash
  var maxPremium = Math.max(0.50, Math.min(2.50, maxTradeCapital / 100)).toFixed(2); // per share, min $0.50 max $2.50
  await trendLog('entry', 'Position sizing: balance=$' + accountBalance.toFixed(0) + ' available=$' + availableCash.toFixed(0) + ' max_trade=$' + maxTradeCapital.toFixed(0) + ' max_premium=$' + maxPremium);

  if (maxTradeCapital < 50) {
    await trendLog('skip', 'Insufficient capital — need at least $50 to trade (available: $' + availableCash.toFixed(0) + ')');
    return;
  }

  // Fix 3: Same-ticker cooldown — don't open same ticker twice in one day
  var todayRows = await pool.query("SELECT DISTINCT ticker FROM trend_positions WHERE entered_at::date = CURRENT_DATE");
  var todayTickerList = todayRows.rows.map(function(r) { return r.ticker; });
  if (todayTickerList.length > 0) {
    await trendLog('entry', 'Already traded today: ' + todayTickerList.join(', ') + ' — will skip these');
  }
  var spyData = await fetchDailyCandles('SPY');
  var spyTrend2 = spyData ? spyData.trend : 'UNKNOWN';
  await trendLog('entry', 'SPY daily trend: ' + spyTrend2);
  var watchlist2 = await buildTrendWatchlist();
  var expDate = new Date(); expDate.setDate(expDate.getDate() + 35);
  while (expDate.getDay() === 0 || expDate.getDay() === 6) expDate.setDate(expDate.getDate() + 1);
  var expiry = expDate.getFullYear() + '-' + ('0'+(expDate.getMonth()+1)).slice(-2) + '-' + ('0'+expDate.getDate()).slice(-2);
  for (var i = 0; i < watchlist2.length; i++) {
    var ticker = watchlist2[i];

    // Fix 3: Skip if ticker already traded today or already in open position
    if (todayTickerList.indexOf(ticker) >= 0) {
      await trendLog('skip', ticker + ' already opened today — cooldown active');
      continue;
    }
    if (openPos.rows.some(function(p) { return p.ticker === ticker; })) {
      await trendLog('skip', ticker + ' already in open position — skipping');
      continue;
    }

    // Delay between requests to avoid Yahoo Finance rate limiting
    await new Promise(function(res) { setTimeout(res, 1500); }); // 1.5s delay to avoid Yahoo rate limiting
    var d2 = await fetchDailyCandles(ticker);
    if (!d2) { await trendLog('skip', ticker + ' no data'); continue; }
    await trendLog('entry', ticker + ' $' + d2.price + ' trend:' + d2.trend + ' RSI:' + d2.rsi + ' week:' + d2.weekChgPct + '%');
    if (d2.trend === 'FLAT') { await trendLog('skip', ticker + ' flat — no clear MA direction'); continue; }
    // Wider RSI range for trend following — elevated RSI in uptrend = momentum, not overbought
    // RSI filter: 45-65 for trend entries — tightened floor to avoid weak momentum entries
    if (d2.rsi > 65) { await trendLog('skip', ticker + ' RSI ' + d2.rsi + ' too extended (>65) — wait for pullback'); continue; }
    if (d2.rsi < 45) { await trendLog('skip', ticker + ' RSI ' + d2.rsi + ' too weak (<45) — insufficient momentum'); continue; }
    if (d2.rsi >= 48 && d2.rsi <= 52) { await trendLog('skip', ticker + ' RSI ' + d2.rsi + ' in neutral zone (48-52) — no edge'); continue; }
    // SPY alignment is informational only — don't block trades that conflict with SPY
    // Best trend trades often happen in stocks moving independently of the market
    if (d2.trend === 'FLAT') { await trendLog('skip', ticker + ' no clear trend direction'); continue; }
    // Weekly trend confirmation — skip if weekly contradicts daily
    if (d2.weeklyTrend !== 'UNKNOWN' && d2.weeklyTrend !== 'FLAT' && d2.weeklyTrend !== d2.trend) {
      await trendLog('skip', ticker + ' daily:' + d2.trend + ' conflicts weekly:' + d2.weeklyTrend + ' — skipping');
      continue;
    }
    // Fix 3: Require price within 8% of 20MA — avoid chasing extended moves
    var distFromMa = parseFloat(d2.distFromMa20Pct) || 0;
    if (Math.abs(distFromMa) > 8) {
      await trendLog('skip', ticker + ' price ' + distFromMa.toFixed(1) + '% from 20MA — too extended, wait for pullback');
      continue;
    }

    await trendLog('entry', ticker + ' $' + d2.price + ' daily:' + d2.trend + ' RSI:' + d2.rsi + ' weekly:' + d2.weeklyTrend + ' wRSI:' + d2.weeklyRsi + ' week%:' + d2.weekChgPct);

    var msg = 'Ticker: ' + ticker +
      '\nPrice: $' + d2.price +
      '\nDAILY — 20MA: $' + d2.ma20 + ' | 50MA: $' + d2.ma50 + ' | RSI: ' + d2.rsi + ' | Trend: ' + d2.trend +
      '\nWEEKLY — 10-week MA: $' + d2.weeklyMa10 + ' | RSI: ' + d2.weeklyRsi + ' | Trend: ' + d2.weeklyTrend +
      '\nNear 20MA: ' + d2.nearMa20 + ' | Week chg: ' + d2.weekChgPct + '% | Month chg: ' + (d2.monthChgPct||'N/A') + '%' +
      '\nSPY daily trend: ' + spyTrend2 +
      '\nTarget expiry: ' + expiry +
      '\nMAX NET PREMIUM: $' + maxPremium + ' per share (HARD LIMIT — net spread cost must not exceed this)' +
      '\nStop: 40% of net premium. Trail stop activates at 40% gain.' +
      '\n\nUse weekly trend for conviction, daily for entry timing. Respond with TREND_RESULT.';
    var result2 = await callTrendClaude(msg);
    if (!result2) { await trendLog('skip', ticker + ' no Claude response'); continue; }
    await trendLog(result2.confidence === 'HIGH' ? 'trade' : 'skip', 'Claude ' + ticker + ': ' + result2.signal + ' (' + result2.confidence + ') — ' + result2.reason);
    if (result2.confidence === 'HIGH') {
      try {
        var isCall = result2.signal === 'BUY_CALL_SPREAD' || result2.signal === 'BUY_CALL';
        var isPut = result2.signal === 'BUY_PUT_SPREAD' || result2.signal === 'BUY_PUT';
        var direction = isCall ? 'CALL_SPREAD' : 'PUT_SPREAD';
        var netPremium = parseFloat(result2.net_premium || result2.premium) || 2.00;
        // Use stock price as fallback for strike if Claude didn't provide it
        var currentPrice = parseFloat(d2.price) || 100;
        var longStrike = parseFloat(result2.long_strike || result2.strike) || Math.round(currentPrice);
        var shortStrike = parseFloat(result2.short_strike) || (isCall ? longStrike + 10 : longStrike - 10);
        var spreadWidth = Math.abs(shortStrike - longStrike);
        var maxSpreadValue = spreadWidth - netPremium;
        var stopPrice2 = netPremium * 0.60;
        var trailActivatesAt = (netPremium * 1.40).toFixed(2);
        var strikeStr = longStrike + '/' + shortStrike;
        // Enforce position sizing — reject if Claude exceeded max premium
        if (netPremium > parseFloat(maxPremium) + 0.10) { // allow 10 cent tolerance
          await trendLog('skip', ticker + ' spread net=$' + netPremium + ' exceeds max_premium=$' + maxPremium + ' — position too large for current balance');
          break;
        }
        await trendLog('entry', 'Inserting: ' + ticker + ' ' + direction + ' strikes=' + strikeStr + ' net=$' + netPremium + ' (max_allowed=$' + maxPremium + ') expiry=' + (result2.expiry || expiry));
        await pool.query(
          'INSERT INTO trend_positions (ticker,direction,strike,expiry,premium,contracts,order_id,entry_price,target_price,stop_price,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [ticker, direction, strikeStr, result2.expiry || expiry,
           netPremium, 1, 'PAPER-' + Date.now(), netPremium, 0, stopPrice2.toFixed(2), result2.reason]
        );
        var tradeCost = netPremium * 100; // 1 contract = 100 shares
        await recordTransaction('TRADE_OPEN', ticker,
          direction + ' $' + longStrike + '/$' + shortStrike + ' (net $' + netPremium + '/share)',
          -tradeCost, 'PAPER-' + Date.now()
        );
        await trendLog('trade', 'OPENED SPREAD: ' + ticker + ' ' + direction +
          ' $' + longStrike + '/$' + shortStrike +
          ' net=$' + netPremium +
          ' cost=$' + tradeCost.toFixed(0) +
          ' trail_at=$' + trailActivatesAt +
          ' hard_stop=$' + stopPrice2.toFixed(2) +
          ' max_spread=$' + (maxSpreadValue * 100).toFixed(0));
        // Run monitor immediately after opening
        setTimeout(function() { monitorTrendPositions().catch(console.error); }, 5000);
      } catch(insertErr) {
        await trendLog('stop', 'ERROR inserting position for ' + ticker + ': ' + insertErr.message);
        console.error('Position insert error:', insertErr);
      }
      break;
    }
    await new Promise(function(r3) { setTimeout(r3, 1000); });
  }
  await trendLog('entry', 'Scan complete');
  trendLastScan = todayStr;
  } finally {
    trendScanRunning = false;
  }
}

// Track which scan windows have fired today: { 'YYYY-MM-DD': { s1: bool, s2: bool, s3: bool } }
var trendScanWindows = {};

async function runTrendScan() {
  try {
    var etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    var isWd = etNow.getDay() >= 1 && etNow.getDay() <= 5;
    var hour = etNow.getHours(), min = etNow.getMinutes();
    if (!isWd || hour < 9 || hour >= 16) return;

    var todayStr = etNow.toLocaleDateString('en-CA');
    if (!trendScanWindows[todayStr]) trendScanWindows[todayStr] = { s1: false, s2: false, s3: false, s4: false };
    var w = trendScanWindows[todayStr];

    // Scan 1: 10:00am ET
    if (hour === 10 && min === 0 && !w.s1) {
      w.s1 = true;
      await trendLog('entry', '⏰ Trend scan 1/4 — 10:00am ET');
      await runTrendScanLogic();
      return;
    }
    // Scan 2: 12:00pm ET
    if (hour === 12 && min === 0 && !w.s2) {
      w.s2 = true;
      await trendLog('entry', '⏰ Trend scan 2/4 — 12:00pm ET');
      await runTrendScanLogic();
      return;
    }
    // Scan 3: 2:00pm ET
    if (hour === 14 && min === 0 && !w.s3) {
      w.s3 = true;
      await trendLog('entry', '⏰ Trend scan 3/4 — 2:00pm ET');
      await runTrendScanLogic();
      return;
    }
    // Scan 4: 3:30pm ET — last window before close
    if (hour === 15 && min === 0 && !w.s4) {
      w.s4 = true;
      await trendLog('entry', '⏰ Trend scan 4/4 — 3:00pm ET');
      await runTrendScanLogic();
      return;
    }
  } catch(e) { console.error('runTrendScan error:', e.message); }
}

// ── Trend Bot Routes ──────────────────────────────────────────────────────────

app.post('/api/resetdaily', async function(req, res) { await setState('dailyLoss', 0); res.json({ ok: true }); });

// Account balance and transaction history
app.get('/api/account', async function(req, res) {
  try {
    var balance = await getBalance();
    var startingBalance = 10000;
    var transactions = await pool.query('SELECT * FROM account_transactions ORDER BY ts DESC LIMIT 100');
    var totalDeposited = startingBalance;
    var totalPnl = balance - startingBalance;
    var openCost = 0;
    // Calculate capital currently tied up in open positions
    var openPos = await pool.query("SELECT entry_price, contracts FROM trend_positions WHERE status='open'");
    openPos.rows.forEach(function(p) {
      openCost += parseFloat(p.entry_price) * 100 * (p.contracts || 1);
    });
    res.json({
      balance: balance.toFixed(2),
      startingBalance: startingBalance.toFixed(2),
      totalPnl: totalPnl.toFixed(2),
      availableCash: (balance - openCost).toFixed(2),
      capitalAtRisk: openCost.toFixed(2),
      transactions: transactions.rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set starting balance
app.post('/api/account/set-balance', async function(req, res) {
  try {
    var amount = parseFloat(req.body.amount);
    if (!amount || amount < 0) return res.status(400).json({ error: 'Invalid amount' });
    await setState('accountBalance', amount);
    await pool.query('DELETE FROM account_transactions');
    await pool.query(
      'INSERT INTO account_transactions (type, description, amount, balance) VALUES ($1,$2,$3,$4)',
      ['DEPOSIT', 'Starting balance set', amount, amount]
    );
    res.json({ ok: true, balance: amount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bulk close all phantom open trades (MXL, ARM etc stuck as open)
app.post('/api/bulk-close-phantoms', async function(req, res) {
  try {
    // Close all trades that are still 'open' but older than 2 days
    var result = await pool.query(
      "UPDATE trades SET result='loss', pnl=-0.50 WHERE result='open' AND ts < NOW() - INTERVAL '2 days' RETURNING id, ticker"
    );
    var closed = result.rows;
    console.log('Bulk closed ' + closed.length + ' phantom trades');
    res.json({ ok: true, closed: closed.length, tickers: closed.map(function(r){ return r.ticker; }) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All trend positions — last 5 days
app.get('/api/trend-positions', async function(req, res) {
  try {
    var positions = await pool.query(
      "SELECT * FROM trend_positions WHERE entered_at > NOW() - INTERVAL '5 days' ORDER BY entered_at DESC"
    );
    var stats = await pool.query(
      "SELECT COUNT(*) FILTER (WHERE status='win') as wins, COUNT(*) FILTER (WHERE status='loss') as losses, " +
      "COALESCE(SUM(pnl) FILTER (WHERE status IN ('win','loss')),0) as total_pnl, " +
      "COUNT(*) FILTER (WHERE status='open') as open_pos FROM trend_positions WHERE entered_at > NOW() - INTERVAL '5 days'"
    );
    res.json({ positions: positions.rows, stats: stats.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Close a trend position manually — capitalize on current profit
app.post('/api/trend-positions/:id/close', async function(req, res) {
  try {
    var id = parseInt(req.params.id);
    var pnl = parseFloat(req.body.pnl) || 0;
    var result = pnl >= 0 ? 'win' : 'loss';
    await pool.query(
      "UPDATE trend_positions SET status=$1, pnl=$2, exited_at=NOW() WHERE id=$3",
      [result, pnl.toFixed(2), id]
    );
    await trendLog('trade', 'MANUAL CLOSE: position #' + id + ' closed with ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(0) + ' (' + result + ')');
    res.json({ ok: true, result: result, pnl: pnl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Combined logs endpoint for auto-refresh
app.get('/api/combined-logs', async function(req, res) {
  try {
    var sl = await pool.query('SELECT ts, type, message FROM scan_log ORDER BY ts DESC LIMIT 80');
    var tl = await pool.query('SELECT ts, type, message FROM trend_logs ORDER BY ts DESC LIMIT 40');
    res.json({ scalperLogs: sl.rows, trendLogs: tl.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Combined stats endpoint — all live data for dashboard auto-refresh
app.get('/api/combined-stats', async function(req, res) {
  try {
    var scalperTrades = await pool.query('SELECT * FROM trades ORDER BY ts DESC');
    var closed = scalperTrades.rows.filter(function(t){return t.result==='win'||t.result==='loss';});
    var scalperWins = closed.filter(function(t){return t.result==='win';});
    var scalperPnl = closed.reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
    var scalperWr = closed.length ? (scalperWins.length/closed.length*100).toFixed(1) : '0';
    var recentScalper = scalperTrades.rows.slice(0,6);

    var trendTrades = await pool.query('SELECT * FROM trend_positions ORDER BY entered_at DESC');
    var trendClosed = trendTrades.rows.filter(function(t){return t.status==='win'||t.status==='loss';});
    var trendWins = trendClosed.filter(function(t){return t.status==='win';});
    var trendPnl = trendClosed.reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
    var trendWr = trendClosed.length ? (trendWins.length/trendClosed.length*100).toFixed(1) : '0';
    var trendOpenPos = trendTrades.rows.filter(function(t){return t.status==='open';});

    // Fetch current stock price for each open trend position
    for (var opi = 0; opi < trendOpenPos.length; opi++) {
      var op = trendOpenPos[opi];
      try {
        // Try Yahoo Finance quote endpoint first (more reliable for real-time)
        var currentStockPrice = null;
        try {
          var opR = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/' + op.ticker + '?interval=1m&range=1d', {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
          });
          var opData = await opR.json();
          var opMeta = opData && opData.chart && opData.chart.result && opData.chart.result[0] && opData.chart.result[0].meta;
          currentStockPrice = opMeta && (opMeta.regularMarketPrice || opMeta.chartPreviousClose) ? parseFloat(opMeta.regularMarketPrice || opMeta.chartPreviousClose) : null;
        } catch(fetchErr) { console.error('Price fetch error ' + op.ticker + ':', fetchErr.message); }

        // Fallback: try Tradier quote if Yahoo fails
        if (!currentStockPrice) {
          try {
            var session = await getState('session', null);
            if (session) {
              var tBase = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
              var tR = await fetch(tBase + '/markets/quotes?symbols=' + op.ticker, {
                headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json' }
              });
              var tData = await tR.json();
              var tQ = tData && tData.quotes && tData.quotes.quote;
              if (tQ && tQ.last) currentStockPrice = parseFloat(tQ.last);
            }
          } catch(tErr) { console.error('Tradier price fallback error:', tErr.message); }
        }
        if (currentStockPrice) {
          // Handle spread positions — strike stored as "130/120"
          var isSpreadPos = op.direction === 'CALL_SPREAD' || op.direction === 'PUT_SPREAD';
          var isPutPos = op.direction === 'PUT' || op.direction === 'PUT_SPREAD';
          var strikeParts2 = String(op.strike).split('/');
          var longStrikePos = parseFloat(strikeParts2[0]) || currentStockPrice;
          var stockMove = currentStockPrice - longStrikePos;
          var pctMove = longStrikePos > 0 ? ((currentStockPrice - longStrikePos) / longStrikePos) : 0;
          // Spread delta is lower than single option
          var delta = isSpreadPos
            ? (pctMove > 0.03 ? 0.40 : pctMove < -0.03 ? 0.20 : 0.30)
            : (pctMove > 0.03 ? 0.65 : pctMove < -0.03 ? 0.35 : 0.50);
          if (isPutPos) delta = -delta;
          var entryPrice = parseFloat(op.entry_price) || 0;
          var currentOptionEst = Math.max(0.01, entryPrice + (stockMove * Math.abs(delta)));
          var pnlNow = (currentOptionEst - entryPrice) * 100 * (op.contracts || 1);
          var pnlPct = entryPrice > 0 ? ((currentOptionEst - entryPrice) / entryPrice * 100) : 0;
          op.currentStockPrice = currentStockPrice.toFixed(2);
          op.currentOptionEst = currentOptionEst.toFixed(2);
          op.pnlNow = pnlNow.toFixed(0);
          op.pnlPct = pnlPct.toFixed(1);
          op.daysHeld = Math.floor((Date.now() - new Date(op.entered_at)) / (1000 * 60 * 60 * 24));
          // Trail status for dashboard
          var entryP2 = parseFloat(op.entry_price) || 0;
          var peakEst = Math.max(currentOptionEst, entryP2);
          var trailActive = currentOptionEst >= entryP2 * 1.40;
          op.trailActive = trailActive;
          op.trailStop = trailActive ? (peakEst * 0.80).toFixed(2) : null;
        }
      } catch(opErr) { console.error('price fetch for ' + op.ticker + ':', opErr.message); }
    }

    var engineOn = await getState('engineOn', false);
    var dailyProfit = await getState('dailyProfit', 0);
    var dailyLoss = await getState('dailyLoss', 0);
    var settings = await getState('settings', {});
    var todayLossCount = 0, todayConsecLosses = 0, todayTradeCount = 0;
    try {
      var tlRows = await pool.query("SELECT result FROM trades WHERE result != 'open' AND ts::date = CURRENT_DATE ORDER BY ts ASC");
      var tlTrades = tlRows.rows;
      todayTradeCount = tlTrades.length;
      todayLossCount = tlTrades.filter(function(t){return t.result==='loss';}).length;
      for (var tci = tlTrades.length-1; tci >= 0; tci--) { if (tlTrades[tci].result==='loss') todayConsecLosses++; else break; }
    } catch(e) {}

    res.json({
      scalper: { pnl: scalperPnl.toFixed(2), wr: scalperWr, wins: scalperWins.length, losses: closed.length - scalperWins.length, recent: recentScalper, trades: closed.length },
      trend: { pnl: trendPnl.toFixed(2), wr: trendWr, wins: trendWins.length, losses: trendClosed.length - trendWins.length, openPositions: trendOpenPos, trades: trendClosed.length },
      engine: { on: engineOn, dailyProfit: dailyProfit, dailyLoss: dailyLoss, todayLossCount: todayLossCount, todayConsecLosses: todayConsecLosses, todayTradeCount: todayTradeCount },
      settings: settings,
      totalPnl: (scalperPnl + trendPnl).toFixed(2)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

// Returns true if date is a weekday (Mon-Fri)
function isWeekday(d) { var day = d.getDay(); return day >= 1 && day <= 5; }

// Schedule midnight reset of daily loss + profit counters
function scheduleMidnightReset() {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var nextMidnight = new Date(et);
  nextMidnight.setHours(24, 0, 0, 0);
  var msUntil = nextMidnight - et;
  setTimeout(async function() {
    await setState('dailyLoss', 0);
    await setState('dailyProfit', 0);
    await setState('profitTargetHit', false);
    await setState('lastOrderRejected', false); // clear circuit breaker each new day
    dynamicWatchlistCache = { date: null, tickers: [] }; // force watchlist rebuild at open
    prevCloseCache = {}; prevCloseCacheDate = null; // force prevclose refresh at open
    console.log('Daily counters reset at midnight ET — watchlist and prevclose cache will rebuild at market open');
    scheduleMidnightReset();
  }, msUntil);
}

// Schedule engine auto-restart at 9:30am ET on next trading day
function scheduleMarketOpenRestart() {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var target = new Date(et);
  target.setHours(9, 30, 0, 0);
  // Move to tomorrow if 9:30 already passed today
  if (target <= et) target.setDate(target.getDate() + 1);
  // Skip weekends
  while (!isWeekday(target)) target.setDate(target.getDate() + 1);
  var msUntil = target - et;
  console.log('Auto-restart scheduled for ' + target.toDateString() + ' 9:30am ET (' + Math.round(msUntil / 3600000) + 'h away)');
  setTimeout(async function() {
    var killSwitch = await getState('killSwitch', false);
    var session = await getState('session', null);
    if (killSwitch) { console.log('9:30am restart skipped — kill switch on'); return; }
    if (!session) { console.log('9:30am restart skipped — no session'); return; }
    // Reset all daily counters regardless of why engine stopped
    await setState('profitTargetHit', false);
    await setState('dailyLoss', 0);
    await setState('dailyProfit', 0);
    await setState('lastOrderRejected', false);
    await setState('engineOn', true);
    // Reset dynamic watchlist and prevclose cache for new day
    dynamicWatchlistCache = { date: null, tickers: [] };
    prevCloseCache = {}; prevCloseCacheDate = null;
    var s = await getState('settings', { schedule: '1min' });
    startTimers(s.schedule);
    await addLog('trade', '🟢 Engine auto-restarted at market open — new trading day');
    runEngine();
    scheduleMarketOpenRestart(); // schedule next day
  }, msUntil);
}


app.get('/trend/dashboard', async function(req, res) {
  try {
    var positions = await pool.query('SELECT * FROM trend_positions ORDER BY entered_at DESC LIMIT 20');
    var stats = await pool.query("SELECT COUNT(*) FILTER (WHERE status='open') as open_pos, COUNT(*) FILTER (WHERE status='win') as wins, COUNT(*) FILTER (WHERE status='loss') as losses, COALESCE(SUM(pnl) FILTER (WHERE status IN ('win','loss')),0) as total_pnl FROM trend_positions");
    var logs2 = await pool.query('SELECT * FROM trend_logs ORDER BY ts DESC LIMIT 30');
    var s2 = stats.rows[0];
    var total2 = parseInt(s2.wins) + parseInt(s2.losses);
    var wr2 = total2 > 0 ? (parseInt(s2.wins)/total2*100).toFixed(1) : '0';
    var data3 = { positions: positions.rows, stats: s2, winRate: wr2, logs: logs2.rows };
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Trend Bot</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#e8e8e8;padding:20px}.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}.metric{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:14px 16px}.ml{font-size:11px;color:#888;margin-bottom:6px;text-transform:uppercase}.mv{font-size:22px;font-weight:500}.pos{color:#1D9E75}.neg{color:#E24B4A}.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:16px 20px;margin-bottom:16px}.ct{font-size:11px;color:#888;text-transform:uppercase;margin-bottom:12px}.tr{display:grid;grid-template-columns:80px 60px 50px 60px 70px 1fr;gap:8px;font-size:12px;padding:8px 0;border-bottom:1px solid #2a2a2a}.th{font-size:11px;color:#666}.badge{padding:2px 8px;border-radius:999px;font-size:11px}.bw{background:#0a2e1f;color:#1D9E75}.bl{background:#2e0a0a;color:#E24B4A}.bo{background:#2a2a1a;color:#BA7517}.log{font-size:11px;color:#888;padding:4px 0;border-bottom:1px solid #1a1a1a}.rb{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:7px 16px;font-size:12px;color:#e8e8e8;cursor:pointer}</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
  <div><h1 style="font-size:20px;font-weight:500;color:#fff">Trend Following Bot</h1><p style="font-size:12px;color:#666;margin-top:4px">30-45 day options | $200 profit target | Scans at 10am, 12pm, 2pm & 3:30pm ET</p></div>
  <div style="display:flex;gap:8px">
    <a href="/combined" style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:7px 16px;font-size:12px;color:#e8e8e8;text-decoration:none">Combined View</a>
    <button class="rb" onclick="location.reload()">Refresh</button>
  </div>
</div>
<div class="g4"><div class="metric"><div class="ml">Total P&L</div><div class="mv" id="spnl">-</div></div><div class="metric"><div class="ml">Win Rate</div><div class="mv" id="swr">-</div></div><div class="metric"><div class="ml">Open</div><div class="mv" id="sop">-</div></div><div class="metric"><div class="ml">W / L</div><div class="mv" id="swl">-</div></div></div>
<div class="card"><div class="ct">Positions</div>
<div class="tr th" style="grid-template-columns:70px 55px 45px 60px 70px 65px 1fr"><span>Date</span><span>Ticker</span><span>Dir</span><span>Status</span><span>Entry</span><span>P&L</span><span>Details</span></div>
<div id="tb"></div></div>
<div class="card"><div class="ct">Recent Logs</div><div id="lb"></div></div>
<p style="font-size:12px;color:#666;margin-top:8px">Auto-scans at 10am, 12pm &amp; 2pm ET daily | <a href="#" style="color:#1D9E75" onclick="fetch('/trend/scan',{method:'POST'}).then(function(){alert('Scan triggered — refresh in 30 seconds');});return false">Force scan now</a></p>
<script>
var D=` + JSON.stringify(data3) + `;
var s=D.stats,pnl=parseFloat(s.total_pnl)||0;
var pe=document.getElementById('spnl');pe.textContent=(pnl>=0?'+':'')+'$'+Math.abs(pnl).toFixed(2);pe.className='mv '+(pnl>0?'pos':pnl<0?'neg':'');
document.getElementById('swr').textContent=D.winRate+'%';
document.getElementById('sop').textContent=s.open_pos+'/2';
document.getElementById('swl').textContent=s.wins+' / '+s.losses;
var tb=document.getElementById('tb');
tb.innerHTML=D.positions.length?D.positions.map(function(p){
  var ts=new Date(p.entered_at).toLocaleDateString([],{month:'short',day:'numeric'});
  var daysHeld=Math.floor((Date.now()-new Date(p.entered_at))/(1000*60*60*24));
  var pnl2=parseFloat(p.pnl)||0;
  var entryP=parseFloat(p.entry_price)||0;
  var targetP=parseFloat(p.target_price)||0;
  var stopP=parseFloat(p.stop_price)||0;
  var isSpread3=p.direction==='CALL_SPREAD'||p.direction==='PUT_SPREAD';
  var dirLabel3=isSpread3?p.direction.replace('_SPREAD',' SPD'):p.direction;
  var badge=p.status==='open'?'<span class="badge bo">Open</span>':p.status==='win'?'<span class="badge bw">Win</span>':'<span class="badge bl">Loss</span>';
  var pstr=p.status==='open'?
    '<span style="color:#888">day '+daysHeld+'</span>':
    '<span style="color:'+(pnl2>=0?'#1D9E75':'#E24B4A')+';font-weight:500">'+(pnl2>=0?'+':'')+'$'+Math.abs(pnl2).toFixed(0)+'</span>';
  var progress='';
  if(p.status==='open'){
    progress=isSpread3
      ?'<div style="font-size:10px;color:#666">strikes '+(p.strike||'')+'  net $'+entryP.toFixed(2)+'  stop $'+stopP.toFixed(2)+'  trail @40%</div>'
      :'<div style="font-size:10px;color:#666">$'+entryP.toFixed(2)+(targetP>0?' → $'+targetP.toFixed(2):'  trail @40%')+'  stop $'+stopP.toFixed(2)+'</div>';
  } else {
    progress='<span style="color:#555;font-size:10px">'+(p.reason||'').slice(0,35)+'</span>';
  }
  return'<div class="tr" style="grid-template-columns:70px 55px 55px 60px 70px 65px 1fr;align-items:start"><span style="color:#666">'+ts+'</span><span style="font-weight:500">'+p.ticker+'</span><span style="font-size:10px">'+dirLabel3+'</span>'+badge+'<span style="color:#888;font-size:11px">$'+entryP.toFixed(2)+'</span>'+pstr+progress+'</div>';
}).join(''):'<div style="text-align:center;color:#666;padding:20px;font-size:13px">No positions yet — scans at 10am, 12pm & 2pm ET</div>';
document.getElementById('lb').innerHTML=D.logs.map(function(l){return'<div class="log">'+new Date(l.ts).toLocaleTimeString()+' ['+l.type+'] '+l.message+'</div>';}).join('');
<\/script></body></html>`);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/trend/status', async function(req, res) {
  try {
    var positions = await pool.query('SELECT * FROM trend_positions ORDER BY entered_at DESC LIMIT 10');
    var stats = await pool.query("SELECT COUNT(*) FILTER (WHERE status='open') as open_pos, COUNT(*) FILTER (WHERE status='win') as wins, COUNT(*) FILTER (WHERE status='loss') as losses, COALESCE(SUM(pnl) FILTER (WHERE status IN ('win','loss')),0) as total_pnl FROM trend_positions");
    res.json({ ok: true, positions: positions.rows, stats: stats.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/trend/sync-session', async function(req, res) {
  var session = await getState('session', null);
  if (session) res.json({ ok: true, message: 'Session active', accountId: session.accountId });
  else res.json({ ok: false, message: 'No session — connect via OptionsAI first' });
});

app.post('/trend/scan', async function(req, res) {
  res.json({ message: 'Trend scan triggered — refresh dashboard in 30 seconds' });
  runTrendScanLogic().catch(function(e) { console.error('Force scan error:', e.message); });
});

// ── Combined Dashboard — both bots on one page ────────────────────────────────
app.get('/combined', function(req, res) {
  res.sendFile(__dirname + '/public/combined.html');
});


app.get('/', function(req, res) { res.sendFile(__dirname + '/public/index.html'); });


var PORT = process.env.PORT || 3001;
pool.connect()
  .then(function() { return initDB(); })
  .then(function() {
    app.listen(PORT, function() { console.log('OptionsAI Trend Bot running on port ' + PORT); });
    initTrendDB().then(function() {
      // Trend scan every minute (fires at 10am, 12pm, 2pm, 3pm ET)
      setInterval(function() { runTrendScan().catch(console.error); }, 60 * 1000);
      // Monitor positions every 5 minutes during market hours
      setInterval(function() {
        var etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        var isWd = etNow.getDay() >= 1 && etNow.getDay() <= 5;
        var minOfDay = etNow.getHours() * 60 + etNow.getMinutes();
        if (isWd && minOfDay >= 570 && minOfDay < 960) monitorTrendPositions().catch(console.error);
      }, 5 * 60 * 1000);
      // Gap protection at 9:35am ET
      setInterval(function() {
        var etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        var isWd = etNow.getDay() >= 1 && etNow.getDay() <= 5;
        var h = etNow.getHours(), m = etNow.getMinutes();
        if (isWd && h === 9 && m >= 35 && m <= 37) gapProtectionCheck().catch(console.error);
      }, 60 * 1000);
      console.log('Trend bot ready — scans 4x daily, monitors every 5min, gap check 9:35am ET');
    }).catch(function(e) { console.error('Trend init error:', e.message); });
  })
  .catch(function(err) { console.error('Startup error:', err); process.exit(1); });

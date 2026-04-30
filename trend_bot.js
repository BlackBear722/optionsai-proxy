// ── Trend Following Bot ───────────────────────────────────────────────────────
// Strategy: Buy 30-45 day call/put options on stocks in strong multi-week trends
// Target: $200 profit per trade | Capital: $500 allocated
// Holds positions days to weeks — NOT a scalper
// Runs alongside the scalping bot on the same Railway server
// ─────────────────────────────────────────────────────────────────────────────

'use strict';
var fetch = require('node-fetch');
var { Pool } = require('pg');

// ── Database ──────────────────────────────────────────────────────────────────
var trendPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function trendQuery(sql, params) {
  var client = await trendPool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

async function initTrendDB() {
  await trendQuery(`
    CREATE TABLE IF NOT EXISTS trend_state (
      key TEXT PRIMARY KEY,
      value JSONB
    )
  `);
  await trendQuery(`
    CREATE TABLE IF NOT EXISTS trend_positions (
      id SERIAL PRIMARY KEY,
      ticker TEXT NOT NULL,
      direction TEXT NOT NULL,
      strike NUMERIC,
      expiry TEXT,
      premium NUMERIC,
      contracts INTEGER DEFAULT 1,
      order_id TEXT,
      entry_price NUMERIC,
      target_price NUMERIC,
      stop_price NUMERIC,
      status TEXT DEFAULT 'open',
      pnl NUMERIC,
      reason TEXT,
      entered_at TIMESTAMPTZ DEFAULT NOW(),
      exited_at TIMESTAMPTZ
    )
  `);
  await trendQuery(`
    CREATE TABLE IF NOT EXISTS trend_logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      type TEXT,
      message TEXT
    )
  `);
  console.log('Trend bot DB initialized');
}

async function trendGetState(key, def) {
  try {
    var r = await trendQuery('SELECT value FROM trend_state WHERE key=$1', [key]);
    return r.rows.length > 0 ? r.rows[0].value : def;
  } catch(e) { return def; }
}

async function trendSetState(key, value) {
  await trendQuery(
    'INSERT INTO trend_state (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
    [key, JSON.stringify(value)]
  );
}

async function trendLog(type, message) {
  console.log('[TREND] ' + type.toUpperCase() + ': ' + message);
  try { await trendQuery('INSERT INTO trend_logs (type,message) VALUES ($1,$2)', [type, message]); }
  catch(e) {}
}

// ── Claude API ────────────────────────────────────────────────────────────────
var TREND_MODEL = 'claude-haiku-4-5-20251001';
var TREND_SYSTEM = 'You are a trend-following options bot analyzing daily and weekly charts to find stocks in strong multi-week uptrends or downtrends.\n\nTREND IDENTIFICATION RULES:\n- UPTREND: Price above both 20-day MA and 50-day MA. 20-day MA above 50-day MA. Higher highs and higher lows on daily chart. Volume increasing on up days.\n- DOWNTREND: Price below both 20-day MA and 50-day MA. 20-day MA below 50-day MA. Lower highs and lower lows. Volume increasing on down days.\n- FLAT/NO TREND: Price chopping between MAs or MAs converging — DO NOT TRADE.\n\nENTRY RULES:\n- BUY_CALL: Stock in confirmed uptrend, RSI 45-65 (not overbought), recent pullback to 20-day MA or consolidation breakout, SPY also in uptrend.\n- BUY_PUT: Stock in confirmed downtrend, RSI 35-55 (not oversold), recent bounce to 20-day MA rejected, SPY in downtrend or neutral.\n- NEVER chase — only enter on pullbacks to MA or clean breakouts from consolidation.\n- NEVER enter if RSI above 70 (calls) or below 30 (puts).\n\nOPTION SELECTION:\n- Always buy options 30-45 days to expiry (enough time for the trend to play out).\n- Strike = nearest whole dollar AT or slightly IN the money.\n- Premium target: $2.00-$5.00 per contract (not cheap lotto tickets).\n\nPROFIT TARGET: $200 per trade (e.g. option goes from $3.00 to $5.00 on 1 contract = $200).\nSTOP LOSS: 40% of premium paid (e.g. paid $3.00, stop at $1.80).\n\nCONFIDENCE:\n- HIGH: All trend conditions clearly met, clean entry point, SPY aligned.\n- NONE: Any doubt, trend unclear, RSI extreme, or entry is chasing.\n\nRespond ONLY with: <TREND_RESULT>{"ticker":"X","signal":"BUY_CALL","confidence":"HIGH","strike":200,"expiry":"2026-05-30","premium":3.50,"contracts":1,"reason":"brief reason including MA alignment and entry trigger"}</TREND_RESULT>';

async function callTrendClaude(userMsg) {
  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: TREND_MODEL, max_tokens: 300, system: TREND_SYSTEM, messages: [{ role: 'user', content: userMsg }] })
    });
    var data = await r.json();
    var text = data.content && data.content[0] && data.content[0].text || '';
    var match = text.match(/<TREND_RESULT>([\s\S]*?)<\/TREND_RESULT>/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch(e) {
    console.error('Trend Claude error:', e.message);
    return null;
  }
}

// ── Market Data ───────────────────────────────────────────────────────────────
async function fetchDailyData(ticker) {
  try {
    // Yahoo Finance daily candles — 3 months for MA calculation
    var r = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1d&range=3mo', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    var data = await r.json();
    var res = data && data.chart && data.chart.result && data.chart.result[0];
    if (!res) return null;

    var meta = res.meta;
    var q = res.indicators && res.indicators.quote && res.indicators.quote[0];
    var timestamps = res.timestamp;
    if (!q || !timestamps) return null;

    var closes = q.close.filter(function(v) { return v != null && !isNaN(v); });
    var volumes = q.volume.filter(function(v) { return v != null && !isNaN(v); });
    var highs   = q.high.filter(function(v)   { return v != null && !isNaN(v); });
    var lows    = q.low.filter(function(v)    { return v != null && !isNaN(v); });

    if (closes.length < 50) return null;

    var price = closes[closes.length - 1];

    // 20-day and 50-day simple moving averages
    var ma20 = closes.slice(-20).reduce(function(s, v) { return s + v; }, 0) / 20;
    var ma50 = closes.slice(-50).reduce(function(s, v) { return s + v; }, 0) / 50;

    // 14-period RSI
    var rsi = calcTrendRSI(closes);

    // Volume trend — avg last 5 days vs avg last 20 days
    var vol5  = volumes.slice(-5).reduce(function(s, v) { return s + v; }, 0) / 5;
    var vol20 = volumes.slice(-20).reduce(function(s, v) { return s + v; }, 0) / 20;
    var volRatio = vol20 > 0 ? (vol5 / vol20) : 1;

    // Recent high and low (20 days)
    var recentHigh = Math.max.apply(null, highs.slice(-20));
    var recentLow  = Math.min.apply(null, lows.slice(-20));

    // Day change
    var prevClose = closes[closes.length - 2] || price;
    var chgPct = ((price - prevClose) / prevClose * 100);

    // Week change (5 days)
    var weekAgoClose = closes[closes.length - 6] || price;
    var weekChgPct = ((price - weekAgoClose) / weekAgoClose * 100);

    // Month change (20 days)
    var monthAgoClose = closes[closes.length - 21] || price;
    var monthChgPct = ((price - monthAgoClose) / monthAgoClose * 100);

    // Trend determination
    var aboveMa20 = price > ma20;
    var aboveMa50 = price > ma50;
    var ma20AboveMa50 = ma20 > ma50;
    var trend = 'FLAT';
    if (aboveMa20 && aboveMa50 && ma20AboveMa50 && weekChgPct > 0) trend = 'UP';
    else if (!aboveMa20 && !aboveMa50 && !ma20AboveMa50 && weekChgPct < 0) trend = 'DOWN';

    // Pullback detection — price within 2% of 20-day MA
    var distFromMa20Pct = ((price - ma20) / ma20 * 100);
    var nearMa20 = Math.abs(distFromMa20Pct) < 2;

    return {
      ticker: ticker,
      price: price.toFixed(2),
      ma20: ma20.toFixed(2),
      ma50: ma50.toFixed(2),
      rsi: Math.round(rsi),
      trend: trend,
      aboveMa20: aboveMa20,
      aboveMa50: aboveMa50,
      ma20AboveMa50: ma20AboveMa50,
      volRatio: volRatio.toFixed(2),
      recentHigh: recentHigh.toFixed(2),
      recentLow: recentLow.toFixed(2),
      chgPct: chgPct.toFixed(2),
      weekChgPct: weekChgPct.toFixed(2),
      monthChgPct: monthChgPct.toFixed(2),
      distFromMa20Pct: distFromMa20Pct.toFixed(2),
      nearMa20: nearMa20
    };
  } catch(e) {
    console.error('fetchDailyData error ' + ticker + ':', e.message);
    return null;
  }
}

function calcTrendRSI(closes) {
  if (closes.length < 15) return 50;
  var gains = 0, losses = 0;
  for (var i = closes.length - 14; i < closes.length; i++) {
    var diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  var ag = gains / 14, al = losses / 14;
  return al === 0 ? 100 : Math.round(100 - (100 / (1 + ag / al)));
}

// ── SPY Trend for daily context ───────────────────────────────────────────────
async function getSpyDailyTrend() {
  try {
    var spyData = await fetchDailyData('SPY');
    if (!spyData) return 'UNKNOWN';
    return spyData.trend;
  } catch(e) { return 'UNKNOWN'; }
}

// ── Dynamic Trending Watchlist ────────────────────────────────────────────────
// Scans Yahoo Finance for stocks with strong weekly momentum
var trendWatchlistCache = { date: null, tickers: [] };

async function buildTrendWatchlist() {
  var etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var todayStr = etNow.getFullYear() + '-' + ('0'+(etNow.getMonth()+1)).slice(-2) + '-' + ('0'+etNow.getDate()).slice(-2);
  if (trendWatchlistCache.date === todayStr && trendWatchlistCache.tickers.length > 0) {
    return trendWatchlistCache.tickers;
  }

  var candidates = [];
  var blocked = ['SPY','QQQ','IWM','GLD','TLT','VXX','UVXY','SQQQ','TQQQ'];

  try {
    // Week gainers — stocks with sustained weekly momentum
    var r = await fetch('https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=50', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' }
    });
    var data = await r.json();
    var quotes = data && data.finance && data.finance.result && data.finance.result[0] && data.finance.result[0].quotes;
    if (quotes) {
      quotes.forEach(function(q) {
        if (!q || !q.symbol) return;
        var sym = q.symbol.toUpperCase();
        if (blocked.indexOf(sym) >= 0) return;
        if (sym.indexOf('.') >= 0 || sym.indexOf('-') >= 0) return;
        if (sym.length > 5) return;
        var price = parseFloat(q.regularMarketPrice) || 0;
        if (price < 20 || price > 1000) return; // Need liquid options
        candidates.push({
          ticker: sym,
          price: price,
          chgPct: parseFloat(q.regularMarketChangePercent) || 0,
          volRatio: q.averageDailyVolume3Month > 0 ? (q.regularMarketVolume / q.averageDailyVolume3Month) : 0
        });
      });
    }
  } catch(e) { console.error('Trend watchlist fetch error:', e.message); }

  // Filter for meaningful movers with good volume
  var filtered = candidates.filter(function(c) {
    return Math.abs(c.chgPct) >= 2 && c.volRatio >= 1.5;
  }).sort(function(a, b) {
    return (Math.abs(b.chgPct) * b.volRatio) - (Math.abs(a.chgPct) * a.volRatio);
  }).slice(0, 8).map(function(c) { return c.ticker; });

  // Always include proven trend tickers as anchors
  var anchors = ['NVDA', 'TSLA', 'META', 'MSFT'];
  var final = anchors.slice();
  filtered.forEach(function(t) {
    if (final.indexOf(t) < 0 && final.length < 12) final.push(t);
  });

  trendWatchlistCache = { date: todayStr, tickers: final };
  await trendLog('entry', '📋 Trend watchlist: ' + final.join(', '));
  return final;
}

// ── Position Monitor ──────────────────────────────────────────────────────────
async function monitorTrendPositions() {
  try {
    var session = await trendGetState('session', null);
    if (!session || !session.token) return;

    var r = await trendQuery("SELECT * FROM trend_positions WHERE status='open' ORDER BY entered_at ASC");
    var positions = r.rows;
    if (!positions.length) return;

    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      try {
        // Fetch current option price from Yahoo
        var optSymbol = pos.ticker;
        var quoteR = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/' + optSymbol + '?interval=1d&range=1d', {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        var quoteData = await quoteR.json();
        var meta = quoteData && quoteData.chart && quoteData.chart.result && quoteData.chart.result[0] && quoteData.chart.result[0].meta;
        var currentPrice = meta && meta.regularMarketPrice ? parseFloat(meta.regularMarketPrice) : null;
        if (!currentPrice) continue;

        var entryPrice = parseFloat(pos.entry_price);
        var pnlPerShare = (currentPrice - entryPrice) * 100; // per contract
        var pnlTotal = pnlPerShare * pos.contracts;
        var pnlPct = ((currentPrice - entryPrice) / entryPrice * 100);

        await trendLog('entry', 'Monitor ' + pos.ticker + ' ' + pos.direction + ': entry=$' + entryPrice.toFixed(2) + ' live=$' + currentPrice.toFixed(2) + ' PnL=$' + pnlTotal.toFixed(0) + ' (' + pnlPct.toFixed(1) + '%)');

        // Check profit target — $200 per trade
        if (pnlTotal >= 200) {
          await closeTrendPosition(pos, currentPrice, 'PROFIT TARGET HIT +$' + pnlTotal.toFixed(0));
          continue;
        }

        // Check stop loss — 40% of premium paid
        var stopPrice = entryPrice * 0.60; // Stop at 60% of entry = 40% loss
        if (currentPrice <= stopPrice) {
          await closeTrendPosition(pos, currentPrice, 'STOP LOSS -$' + Math.abs(pnlTotal).toFixed(0));
          continue;
        }

        // Check expiry — exit 7 days before expiry to avoid theta crush
        if (pos.expiry) {
          var expiryDate = new Date(pos.expiry);
          var daysToExpiry = Math.floor((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
          if (daysToExpiry <= 7) {
            await closeTrendPosition(pos, currentPrice, 'APPROACHING EXPIRY (' + daysToExpiry + ' days left)');
            continue;
          }
        }

      } catch(posErr) { console.error('Monitor position error:', posErr.message); }
    }
  } catch(e) { console.error('monitorTrendPositions error:', e.message); }
}

async function closeTrendPosition(pos, currentPrice, reason) {
  var entryPrice = parseFloat(pos.entry_price);
  var pnl = ((currentPrice - entryPrice) * 100 * pos.contracts);
  var result = pnl >= 0 ? 'win' : 'loss';

  await trendQuery(
    "UPDATE trend_positions SET status=$1, pnl=$2, exited_at=NOW() WHERE id=$3",
    [result, pnl.toFixed(2), pos.id]
  );
  await trendLog(result === 'win' ? 'trade' : 'stop',
    '🔒 CLOSED ' + pos.ticker + ' ' + pos.direction + ' — ' + reason + ' | PnL: $' + pnl.toFixed(2)
  );
}

// ── Place Order ───────────────────────────────────────────────────────────────
async function placeTrendOrder(session, result, stockData) {
  try {
    var base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
    var optType = result.signal === 'BUY_CALL' ? 'call' : 'put';

    // Place order via Tradier
    var orderBody = new URLSearchParams({
      class: 'option',
      symbol: result.ticker,
      option_symbol: result.ticker + result.expiry.replace(/-/g,'').slice(2) + (optType === 'call' ? 'C' : 'P') + String(Math.round(result.strike * 1000)).padStart(8, '0'),
      side: 'buy_to_open',
      quantity: result.contracts || 1,
      type: 'limit',
      duration: 'day',
      price: result.premium.toFixed(2)
    });

    var r = await fetch(base + '/accounts/' + session.accountId + '/orders', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: orderBody.toString()
    });
    var data = await r.json();
    var orderId = data && data.order && data.order.id;

    if (orderId) {
      // Record position in DB
      var targetPrice = result.premium + (200 / 100); // $200 profit on 1 contract = $2.00 per share
      var stopPrice = result.premium * 0.60;

      await trendQuery(
        `INSERT INTO trend_positions (ticker, direction, strike, expiry, premium, contracts, order_id, entry_price, target_price, stop_price, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [result.ticker, result.signal === 'BUY_CALL' ? 'CALL' : 'PUT',
         result.strike, result.expiry, result.premium, result.contracts || 1,
         orderId.toString(), result.premium, targetPrice.toFixed(2), stopPrice.toFixed(2), result.reason]
      );

      await trendLog('trade',
        '📈 TREND ORDER: ' + result.ticker + ' ' + (result.signal === 'BUY_CALL' ? 'CALL' : 'PUT') +
        ' strike=$' + result.strike + ' expiry=' + result.expiry +
        ' premium=$' + result.premium + ' target=$' + targetPrice.toFixed(2) +
        ' stop=$' + stopPrice.toFixed(2) + ' | ' + result.reason
      );
      return true;
    }
    return false;
  } catch(e) {
    console.error('placeTrendOrder error:', e.message);
    return false;
  }
}

// ── Main Scan Engine ──────────────────────────────────────────────────────────
async function runTrendScan() {
  try {
    var session = await trendGetState('session', null);
    if (!session || !session.token) {
      // Share session with scalping bot
      var r = await trendQuery("SELECT value FROM trend_state WHERE key='session'");
      if (!r.rows.length) {
        // Try to read from main bot state table
        var r2 = await trendQuery("SELECT value FROM state WHERE key='session'").catch(function() { return { rows: [] }; });
        if (r2.rows.length) {
          session = r2.rows[0].value;
          await trendSetState('session', session);
        }
      }
      if (!session) { console.log('Trend bot: no session found'); return; }
    }

    // Only scan on weekdays during market hours
    var etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    var isWeekday = etNow.getDay() >= 1 && etNow.getDay() <= 5;
    var hour = etNow.getHours();
    var isMarketHours = isWeekday && hour >= 9 && hour < 16;
    if (!isMarketHours) return;

    // Only scan once per day at 10:00am ET (trend bot doesn't need to scan every minute)
    var scanHour = etNow.getHours() === 10 && etNow.getMinutes() === 0;
    var lastScan = await trendGetState('lastScanDate', null);
    var todayStr = etNow.toLocaleDateString('en-CA');
    if (lastScan === todayStr) return; // Already scanned today
    if (!scanHour) return; // Not scan time yet

    await trendSetState('lastScanDate', todayStr);
    await trendLog('entry', '🔍 Daily trend scan starting — ' + todayStr);

    // Check max open positions (max 2 at a time with $500 capital)
    var openPos = await trendQuery("SELECT COUNT(*) FROM trend_positions WHERE status='open'");
    var openCount = parseInt(openPos.rows[0].count);
    if (openCount >= 2) {
      await trendLog('skip', 'Max positions reached (' + openCount + '/2) — monitoring only');
      return;
    }

    // Get SPY daily trend for market context
    var spyTrend = await getSpyDailyTrend();
    await trendLog('entry', '📊 SPY daily trend: ' + spyTrend);

    // Build dynamic watchlist
    var watchlist = await buildTrendWatchlist();
    await trendLog('entry', 'Scanning ' + watchlist.length + ' tickers for trends');

    var candidates = [];

    for (var i = 0; i < watchlist.length; i++) {
      var ticker = watchlist[i];
      try {
        var data = await fetchDailyData(ticker);
        if (!data) continue;

        // Pre-filters before calling Claude
        if (data.trend === 'FLAT') {
          await trendLog('skip', ticker + ' — no clear trend (flat MAs)');
          continue;
        }
        if (data.rsi > 75) {
          await trendLog('skip', ticker + ' — RSI ' + data.rsi + ' overbought for trend entry');
          continue;
        }
        if (data.rsi < 25) {
          await trendLog('skip', ticker + ' — RSI ' + data.rsi + ' oversold for trend entry');
          continue;
        }
        // Trend must align with SPY
        if (spyTrend !== 'UNKNOWN' && spyTrend !== 'FLAT' && data.trend !== spyTrend) {
          await trendLog('skip', ticker + ' — trend ' + data.trend + ' conflicts with SPY ' + spyTrend);
          continue;
        }

        // Calculate target expiry — 35 days out
        var expDate = new Date();
        expDate.setDate(expDate.getDate() + 35);
        // Roll to Friday if on weekend
        while (expDate.getDay() === 0 || expDate.getDay() === 6) expDate.setDate(expDate.getDate() + 1);
        var expiry = expDate.getFullYear() + '-' + ('0'+(expDate.getMonth()+1)).slice(-2) + '-' + ('0'+expDate.getDate()).slice(-2);

        var userMsg = 'Ticker: ' + ticker +
          '\nCurrent price: $' + data.price +
          '\n20-day MA: $' + data.ma20 + ' | Price vs MA20: ' + data.distFromMa20Pct + '%' +
          '\n50-day MA: $' + data.ma50 +
          '\nMA alignment: 20MA ' + (data.ma20AboveMa50 ? 'ABOVE' : 'BELOW') + ' 50MA' +
          '\nPrice vs MAs: ' + (data.aboveMa20 ? 'ABOVE' : 'BELOW') + ' 20MA, ' + (data.aboveMa50 ? 'ABOVE' : 'BELOW') + ' 50MA' +
          '\nRSI (14-period daily): ' + data.rsi +
          '\nVolume ratio (5-day vs 20-day avg): ' + data.volRatio + 'x' +
          '\nDay change: ' + data.chgPct + '%' +
          '\nWeek change: ' + data.weekChgPct + '%' +
          '\nMonth change: ' + data.monthChgPct + '%' +
          '\n20-day high: $' + data.recentHigh + ' | 20-day low: $' + data.recentLow +
          '\nNear 20-day MA (pullback): ' + (data.nearMa20 ? 'YES — potential entry' : 'NO') +
          '\nIdentified trend: ' + data.trend +
          '\nSPY daily trend: ' + spyTrend +
          '\nTarget expiry: ' + expiry + ' (35 days)' +
          '\nProfit target: $200 per contract | Stop loss: 40% of premium' +
          '\n\nAnalyze this trend setup and respond with a TREND_RESULT block.';

        await trendLog('entry', 'Analyzing ' + ticker + ' $' + data.price + ' trend:' + data.trend + ' RSI:' + data.rsi + ' week:' + data.weekChgPct + '%');

        var result = await callTrendClaude(userMsg);
        if (!result) continue;

        await trendLog(result.confidence === 'HIGH' ? 'trade' : 'skip',
          'Claude ' + ticker + ': ' + result.signal + ' (' + result.confidence + ') — ' + result.reason
        );

        if (result.confidence === 'HIGH' && (result.signal === 'BUY_CALL' || result.signal === 'BUY_PUT')) {
          candidates.push({ result: result, data: data });
        }

        // Small delay between Claude calls
        await new Promise(function(resolve) { setTimeout(resolve, 1000); });

      } catch(tickerErr) { console.error('Trend scan error ' + ticker + ':', tickerErr.message); }
    }

    // Place the best trade (highest conviction, best trend alignment)
    if (candidates.length > 0 && openCount < 2) {
      var best = candidates[0]; // Already filtered to HIGH only
      await trendLog('trade', 'Best trend setup: ' + best.result.ticker + ' ' + best.result.signal + ' @ $' + best.result.premium);
      var placed = await placeTrendOrder(session, best.result, best.data);
      if (!placed) await trendLog('stop', 'Order placement failed for ' + best.result.ticker);
    } else if (candidates.length === 0) {
      await trendLog('skip', 'No high-confidence trend setups found today');
    }

  } catch(e) { console.error('runTrendScan error:', e.message); }
}

// ── API Routes ────────────────────────────────────────────────────────────────
function registerTrendRoutes(app) {
  // Trend bot status and positions
  app.get('/trend/status', async function(req, res) {
    try {
      var positions = await trendQuery("SELECT * FROM trend_positions ORDER BY entered_at DESC LIMIT 20");
      var stats = await trendQuery(`
        SELECT
          COUNT(*) FILTER (WHERE status='open') as open_positions,
          COUNT(*) FILTER (WHERE status='win') as wins,
          COUNT(*) FILTER (WHERE status='loss') as losses,
          COALESCE(SUM(pnl) FILTER (WHERE status IN ('win','loss')), 0) as total_pnl
        FROM trend_positions
      `);
      var logs = await trendQuery("SELECT * FROM trend_logs ORDER BY ts DESC LIMIT 50");
      res.json({
        positions: positions.rows,
        stats: stats.rows[0],
        logs: logs.rows
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Force a scan (for testing)
  app.post('/trend/scan', async function(req, res) {
    await trendSetState('lastScanDate', null); // Reset so it scans again
    runTrendScan().catch(console.error);
    res.json({ message: 'Trend scan triggered' });
  });

  // Sync session from main bot
  app.post('/trend/sync-session', async function(req, res) {
    try {
      var r = await trendQuery("SELECT value FROM state WHERE key='session'");
      if (r.rows.length) {
        await trendSetState('session', r.rows[0].value);
        res.json({ message: 'Session synced', accountId: r.rows[0].value.accountId });
      } else {
        res.json({ message: 'No session found in main bot' });
      }
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Dashboard
  app.get('/trend/dashboard', async function(req, res) {
    try {
      var positions = await trendQuery("SELECT * FROM trend_positions ORDER BY entered_at DESC LIMIT 20");
      var stats = await trendQuery(`
        SELECT
          COUNT(*) FILTER (WHERE status='open') as open_positions,
          COUNT(*) FILTER (WHERE status='win') as wins,
          COUNT(*) FILTER (WHERE status='loss') as losses,
          COALESCE(SUM(pnl) FILTER (WHERE status IN ('win','loss')), 0) as total_pnl,
          COALESCE(AVG(pnl) FILTER (WHERE status='win'), 0) as avg_win,
          COALESCE(AVG(pnl) FILTER (WHERE status='loss'), 0) as avg_loss
        FROM trend_positions
      `);
      var s = stats.rows[0];
      var totalTrades = parseInt(s.wins) + parseInt(s.losses);
      var winRate = totalTrades > 0 ? (parseInt(s.wins) / totalTrades * 100).toFixed(1) : '—';
      var data = JSON.stringify({ positions: positions.rows, stats: s, winRate: winRate });

      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Trend Bot Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;color:#e8e8e8;padding:20px}
h1{font-size:20px;font-weight:500;margin-bottom:6px;color:#fff}
.sub{font-size:13px;color:#666;margin-bottom:20px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.metric{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:14px 16px}
.ml{font-size:11px;color:#888;margin-bottom:6px;text-transform:uppercase}
.mv{font-size:24px;font-weight:500}
.pos{color:#1D9E75}.neg{color:#E24B4A}.neu{color:#fff}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:16px 20px;margin-bottom:16px}
.ct{font-size:11px;color:#888;text-transform:uppercase;margin-bottom:14px}
.tr{display:grid;grid-template-columns:80px 60px 50px 60px 70px 70px 1fr;gap:8px;align-items:center;font-size:12px;padding:8px 0;border-bottom:1px solid #2a2a2a}
.tr:last-child{border-bottom:none}
.th{font-size:11px;color:#666;font-weight:500}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500}
.bw{background:#0a2e1f;color:#1D9E75}.bl{background:#2e0a0a;color:#E24B4A}.bo{background:#2a2a1a;color:#BA7517}
.rb{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:7px 16px;font-size:12px;color:#e8e8e8;cursor:pointer}
.rb:hover{background:#222}
.info{font-size:12px;color:#666;margin-top:8px}
@media(max-width:600px){.g4{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px">
  <div>
    <h1>📈 Trend Following Bot</h1>
    <div class="sub">30-45 day options | $200 profit target | 40% stop loss | Scans daily at 10am ET</div>
  </div>
  <button class="rb" onclick="location.reload()">Refresh</button>
</div>
<div class="g4">
  <div class="metric"><div class="ml">Total P&L</div><div class="mv" id="spnl"></div></div>
  <div class="metric"><div class="ml">Win Rate</div><div class="mv" id="swr"></div></div>
  <div class="metric"><div class="ml">Open Positions</div><div class="mv neu" id="sop"></div></div>
  <div class="metric"><div class="ml">Wins / Losses</div><div class="mv neu" id="swl"></div></div>
</div>
<div class="card">
  <div class="ct">Positions</div>
  <div class="tr th"><span>Entered</span><span>Ticker</span><span>Dir</span><span>Status</span><span>Entry</span><span>P&L</span><span>Reason</span></div>
  <div id="tb"></div>
</div>
<div class="info">Next scan: tomorrow at 10:00am ET &nbsp;|&nbsp; <a href="/trend/scan" style="color:#1D9E75" onclick="fetch('/trend/scan',{method:'POST'});return false">Force scan now</a></div>
<script>
var D=${data};
var s=D.stats;
var pnl=parseFloat(s.total_pnl)||0;
var pe=document.getElementById('spnl');
pe.textContent=(pnl>=0?'+':'')+'$'+Math.abs(pnl).toFixed(2);
pe.className='mv '+(pnl>0?'pos':pnl<0?'neg':'neu');
document.getElementById('swr').textContent=D.winRate+'%';
document.getElementById('sop').textContent=s.open_positions+'/2';
document.getElementById('swl').textContent=s.wins+' / '+s.losses;
var tb=document.getElementById('tb');
if(!D.positions.length){tb.innerHTML='<div style="text-align:center;color:#666;padding:20px;font-size:13px">No positions yet — next scan at 10am ET</div>';}
else{tb.innerHTML=D.positions.map(function(p){
  var ts=new Date(p.entered_at).toLocaleDateString([],{month:'short',day:'numeric'});
  var pnl2=parseFloat(p.pnl)||0;
  var ps=p.status==='open'?'<span class="badge bo">Open</span>':p.status==='win'?'<span class="badge bw">Win</span>':'<span class="badge bl">Loss</span>';
  var pnlStr=p.status==='open'?'<span style="color:#666">—</span>':'<span style="color:'+(pnl2>=0?'#1D9E75':'#E24B4A')+'">$'+pnl2.toFixed(0)+'</span>';
  var reason=(p.reason||'').slice(0,50)+(p.reason&&p.reason.length>50?'…':'');
  return'<div class="tr"><span style="color:#666">'+ts+'</span><span style="font-weight:500">'+p.ticker+'</span><span>'+p.direction+'</span>'+ps+' <span style="color:#888">$'+parseFloat(p.entry_price||0).toFixed(2)+'</span>'+pnlStr+'<span style="color:#666;font-size:11px">'+reason+'</span></div>';
}).join('');}
</script>
</body>
</html>`);
    } catch(e) { res.status(500).send('Dashboard error: ' + e.message); }
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  initTrendDB: initTrendDB,
  runTrendScan: runTrendScan,
  monitorTrendPositions: monitorTrendPositions,
  registerTrendRoutes: registerTrendRoutes
};

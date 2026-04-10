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

// Get next weekly expiry (nearest Friday at least 1 day away)
// SPY/QQQ/IWM have daily 0DTE options — all others use nearest weekly Friday
function getNextExpiry(ticker) {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var etHour = et.getHours();

  // For 0DTE tickers: use today if before 3:30pm ET, otherwise next trading day
  var zeroTickers = ['SPY', 'QQQ', 'IWM'];
  var t = (ticker || '').toUpperCase().trim();
  if (zeroTickers.indexOf(t) >= 0) {
    // After 3:30pm ET, today's 0DTE is too close — use next Friday
    if (etHour < 15 || (etHour === 15 && et.getMinutes() < 30)) {
      // Use today only if it's a weekday (Mon-Fri)
      if (et.getDay() >= 1 && et.getDay() <= 5) {
        var yy0 = String(et.getFullYear()).slice(2);
        var mm0 = ('0' + (et.getMonth() + 1)).slice(-2);
        var dd0 = ('0' + et.getDate()).slice(-2);
        var fmt0 = et.getFullYear() + '-' + mm0 + '-' + dd0;
        console.log('0DTE expiry for ' + t + ': ' + fmt0);
        return { formatted: fmt0, yy: yy0, mm: mm0, dd: dd0 };
      }
    }
  }

  // Find nearest Friday at least 1 day away
  var candidate = new Date(et);
  candidate.setDate(candidate.getDate() + 1); // start from tomorrow
  while (candidate.getDay() !== 5) {
    candidate.setDate(candidate.getDate() + 1);
  }

  var yy = String(candidate.getFullYear()).slice(2);
  var mm = ('0' + (candidate.getMonth() + 1)).slice(-2);
  var dd = ('0' + candidate.getDate()).slice(-2);
  var formatted = candidate.getFullYear() + '-' + mm + '-' + dd;
  console.log('Weekly expiry for ' + (t || 'unknown') + ': ' + formatted);
  return { formatted: formatted, yy: yy, mm: mm, dd: dd };
}

// Build OCC option symbol
function buildSymbol(ticker, type, strike) {
  var exp = getNextExpiry(ticker);
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

// Calculate real 14-period RSI from an array of closing prices
function calcRSI(closes) {
  if (!closes || closes.length < 15) return 50;
  var gains = 0, losses = 0;
  for (var i = closes.length - 14; i < closes.length; i++) {
    var diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  var ag = gains / 14, al = losses / 14;
  if (al === 0) return 100;
  return Math.round(100 - (100 / (1 + ag / al)));
}

// Calculate VWAP from parallel arrays of closes and volumes
function calcVWAP(closes, highs, lows, volumes) {
  var sp = 0, sv = 0;
  for (var i = 0; i < closes.length; i++) {
    if (closes[i] && volumes[i]) {
      var tp = (closes[i] + (highs[i] || closes[i]) + (lows[i] || closes[i])) / 3;
      sp += tp * volumes[i];
      sv += volumes[i];
    }
  }
  return sv > 0 ? (sp / sv) : closes[closes.length - 1];
}

// Count consecutive bullish or bearish 5-min candles from the end
function countConsecutive(opens, closes, direction) {
  var count = 0;
  for (var i = closes.length - 1; i >= Math.max(0, closes.length - 6); i--) {
    if (direction === 'bull' && closes[i] > opens[i]) count++;
    else if (direction === 'bear' && closes[i] < opens[i]) count++;
    else break;
  }
  return count;
}

// Fetch market data
async function fetchQuote(ticker) {
  // Use Tradier quotes API + 5-min candles for real RSI/VWAP
  var session = await getState('session', null);
  if (session && session.token) {
    try {
      var base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';

      // Fetch real-time quote and 5-min candles in parallel
      var etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      var dateStr = etNow.getFullYear() + '-' + ('0'+(etNow.getMonth()+1)).slice(-2) + '-' + ('0'+etNow.getDate()).slice(-2);

      var [quoteRes, candleRes] = await Promise.all([
        fetch(base + '/markets/quotes?symbols=' + ticker + '&greeks=false', {
          headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json' }
        }),
        fetch(base + '/markets/timesales?symbol=' + ticker + '&interval=5min&start=' + dateStr + '%2009:30&session_filter=open', {
          headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json' }
        })
      ]);

      var quoteData = await quoteRes.json();
      var candleData = await candleRes.json();
      var q = quoteData && quoteData.quotes && quoteData.quotes.quote;

      if (q && q.last && parseFloat(q.last) > 0) {
        var price = parseFloat(q.last);
        var prev = parseFloat(q.prevclose) || price;
        var chgPct = prev > 0 ? ((price - prev) / prev * 100) : 0;
        var high = parseFloat(q.high) || price;
        var low = parseFloat(q.low) || price;
        var vol = parseInt(q.volume) || 0;
        var avgVol = parseInt(q.average_volume) || vol || 1;
        var volRatio = vol / avgVol;
        var spread = (q.ask && q.bid) ? (((parseFloat(q.ask) - parseFloat(q.bid)) / price) * 100).toFixed(3) : (((high-low)/price)*100).toFixed(3);
        var mid = (etNow.getHours() - 9) * 60 + etNow.getMinutes() - 30;
        var isOpen = q.tradeable === true || (mid >= 0 && mid <= 390);

        // Parse 5-min candles for real RSI, VWAP, consecutive candles
        var rsi = 50, vwap = ((high + low + price) / 3).toFixed(2);
        var bull = 0, bear = 0;
        try {
          var series = candleData && candleData.series && candleData.series.data;
          if (series) {
            var candles = Array.isArray(series) ? series : [series];
            var closes = candles.map(function(c) { return parseFloat(c.close); }).filter(function(v) { return !isNaN(v); });
            var opens  = candles.map(function(c) { return parseFloat(c.open);  }).filter(function(v) { return !isNaN(v); });
            var highs  = candles.map(function(c) { return parseFloat(c.high);  }).filter(function(v) { return !isNaN(v); });
            var lows   = candles.map(function(c) { return parseFloat(c.low);   }).filter(function(v) { return !isNaN(v); });
            var vols   = candles.map(function(c) { return parseFloat(c.volume);}).filter(function(v) { return !isNaN(v); });

            if (closes.length >= 15) rsi = calcRSI(closes);
            if (closes.length > 0)   vwap = calcVWAP(closes, highs, lows, vols).toFixed(2);
            bull = countConsecutive(opens, closes, 'bull');
            bear = countConsecutive(opens, closes, 'bear');
            console.log('5-min candles: ' + candles.length + ' RSI:' + rsi + ' VWAP:' + vwap + ' bull:' + bull + ' bear:' + bear);
          } else {
            // Not enough candles yet (early in day) — fall back to day-change estimate
            rsi = chgPct > 3 ? 65 : chgPct > 1 ? 57 : chgPct > 0 ? 52 : chgPct > -1 ? 47 : chgPct > -3 ? 40 : 35;
            console.log('No 5-min candles yet for ' + ticker + ' — using fallback RSI:' + rsi);
          }
        } catch(ce) { console.error('candle parse error ' + ticker + ': ' + ce.message); }

        console.log('Tradier ' + ticker + ' $' + price + ' ' + chgPct.toFixed(2) + '% RSI:' + rsi + ' spread:' + spread + '%');
        return {
          ticker: ticker, price: price.toFixed(2), changePct: chgPct.toFixed(2),
          volume: vol, volumeRatio: volRatio.toFixed(2), barVolumeRatio: volRatio.toFixed(2),
          rsi: rsi.toString(), ma9: price.toFixed(2), vwap: vwap,
          spreadEstPct: spread,
          last3Candles: [],
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
var SCAN_SYSTEM = 'You are an options scalping bot analyzing 5-minute candle data. Use RSI, VWAP, and candle momentum to find high-probability setups.\n\nRules:\n- BUY_CALL: RSI 45-65, price above VWAP, 2+ consecutive bull candles, positive day change\n- BUY_PUT: RSI 35-55, price below VWAP, 2+ consecutive bear candles, negative day change\n- HIGH confidence: all conditions clearly met\n- MEDIUM confidence: most conditions met, one borderline\n- LOW or NONE: mixed signals, RSI overbought/oversold, or no clear direction\n- Strike = nearest whole dollar to current price. Premium = 0.5 to 2 percent of stock price.\n\nRespond ONLY with: <SCAN_RESULT>{"ticker":"X","signal":"BUY_CALL","confidence":"MEDIUM","strike":500,"premium":1.50,"reason":"brief reason"}</SCAN_RESULT>';

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
    var priceVsVwap = parseFloat(d.price) > parseFloat(d.vwap) ? 'ABOVE' : 'BELOW';
    var userMsg = 'Ticker: ' + ticker +
      '\nPrice: $' + d.price + ' | Change: ' + d.changePct + '% today' +
      '\nRSI (14-period, 5-min): ' + d.rsi +
      '\nVWAP: $' + d.vwap + ' | Price is ' + priceVsVwap + ' VWAP' +
      '\nIntraday High: $' + d.intradayHigh + ' | Low: $' + d.intradayLow +
      '\nConsecutive bull candles: ' + d.consecutiveBull + ' | bear candles: ' + d.consecutiveBear +
      '\nVolume ratio vs avg: ' + d.volumeRatio + 'x' +
      '\nBid: $' + (d.bid||'?') + ' | Ask: $' + (d.ask||'?') + ' | Spread: ' + d.spreadEstPct + '%' +
      '\nProfit target: $' + settings.profitTarget + '/contract | Stop-loss: $' + settings.stopLoss + '/contract' +
      '\n\nRespond ONLY with a <SCAN_RESULT> block.';
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
  // Get available expiration dates from Tradier and pick best weekly/0DTE expiry
  try {
    var base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
    var url = base + '/markets/options/expirations?symbol=' + ticker + '&includeAllRoots=true';
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json' } });
    var data = await r.json();
    var dates = data && data.expirations && data.expirations.date;
    if (!dates) return null;
    var arr = Array.isArray(dates) ? dates : [dates];

    var etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    var today = etNow.getFullYear() + '-' + ('0'+(etNow.getMonth()+1)).slice(-2) + '-' + ('0'+etNow.getDate()).slice(-2);
    var etHour = etNow.getHours();
    var etMin = etNow.getMinutes();

    // 0DTE tickers: use today if before 3:30pm ET on a weekday
    var zeroTickers = ['SPY', 'QQQ', 'IWM'];
    var t = ticker.toUpperCase().trim();
    if (zeroTickers.indexOf(t) >= 0 && etNow.getDay() >= 1 && etNow.getDay() <= 5) {
      var todayOk = (etHour < 15 || (etHour === 15 && etMin < 30));
      if (todayOk && arr.indexOf(today) >= 0) {
        console.log('0DTE expiry confirmed for ' + t + ': ' + today);
        return today;
      }
    }

    // All others: nearest Friday (weekly) at least 1 day away
    var tomorrow = new Date(etNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    var future = arr.filter(function(d) { return new Date(d + 'T12:00:00Z') >= tomorrow; });
    if (!future.length) return null;
    var fridays = future.filter(function(d) { return new Date(d + 'T12:00:00Z').getUTCDay() === 5; });
    var chosen = fridays.length ? fridays[0] : future[0];
    console.log('Weekly expiry chosen for ' + ticker + ': ' + chosen);
    return chosen;
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
  var settings = await getState('settings', { profitTarget: 0.50, stopLoss: 0.25, dailyMax: 500, dailyProfitTarget: 200, maxPositions: 2, contracts: 1, schedule: '5min' });
  var session = await getState('session', null);
  var watchlist = await getState('watchlist', ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'AMD']);
  var dailyLoss = await getState('dailyLoss', 0);
  var dailyProfit = await getState('dailyProfit', 0);
  var killSwitch = await getState('killSwitch', false);
  if (!session) { await addLog('skip', 'no session'); return; }
  if (killSwitch) { await addLog('stop', 'kill switch on'); return; }
  if (dailyLoss >= settings.dailyMax) { await addLog('stop', 'daily loss limit hit $' + settings.dailyMax); await setState('engineOn', false); return; }

  // Daily profit target check — close all positions, stop engine, schedule 9:30am restart
  if (settings.dailyProfitTarget > 0 && dailyProfit >= settings.dailyProfitTarget) {
    await addLog('trade', '🎯 DAILY PROFIT TARGET HIT $' + dailyProfit.toFixed(2) + ' — closing positions & stopping until tomorrow');
    await setState('engineOn', false);
    await setState('profitTargetHit', true);
    try {
      var allPos = await getPositions(session);
      for (var pi = 0; pi < allPos.length; pi++) {
        await closePos(allPos[pi], session);
        await addLog('trade', 'Closed: ' + allPos[pi].symbol);
      }
    } catch(pe) { await addLog('stop', 'Error closing positions: ' + pe.message); }
    clearInterval(engineTimer);
    clearInterval(monitorTimer);
    scheduleMarketOpenRestart();
    return;
  }
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
  var settings = await getState('settings', {
    profitTarget: 0.50, stopLoss: 0.25,
    trailActivate: 0.15, trailAmount: 0.10,
    maxHoldMinutes: 20
  });
  if (!engineOn || killSwitch || !session) return;

  // Load trailing stop high-water marks: { symbol: highWaterMark }
  var trailMarks = await getState('trailMarks', {});

  try {
    var positions = await getPositions(session);
    var dailyLoss = await getState('dailyLoss', 0);

    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      if (!pos.cost_basis) continue;
      var sym = (pos.symbol || '').trim();

      // ── Live price ──────────────────────────────────────────────────────────
      var currentPrice = null;
      try {
        var base2 = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
        var qr = await fetch(base2 + '/markets/quotes?symbols=' + sym + '&greeks=false', {
          headers: { 'Authorization': 'Bearer ' + session.token, 'Accept': 'application/json' }
        });
        var qdata = await qr.json();
        var quote = qdata && qdata.quotes && qdata.quotes.quote;
        if (quote && quote.last && parseFloat(quote.last) > 0) {
          currentPrice = parseFloat(quote.last);
        } else if (quote && quote.bid && quote.ask) {
          currentPrice = (parseFloat(quote.bid) + parseFloat(quote.ask)) / 2;
        }
      } catch(qe) { console.error('quote fetch error:', qe.message); }

      var entryPricePerContract = pos.cost_basis / Math.abs(pos.quantity || 1) / 100;
      var livePricePerContract = currentPrice || (pos.market_value ? pos.market_value / Math.abs(pos.quantity || 1) / 100 : entryPricePerContract);
      var pnlPer = livePricePerContract - entryPricePerContract;

      // ── How long has this position been open? ───────────────────────────────
      var heldMinutes = 9999;
      try {
        var ticker4 = sym.slice(0, 4).trim();
        var tRow = await pool.query("SELECT ts FROM trades WHERE result='open' AND ticker=$1 ORDER BY ts DESC LIMIT 1", [ticker4]);
        if (tRow.rows.length) {
          heldMinutes = (Date.now() - new Date(tRow.rows[0].ts).getTime()) / 60000;
        }
      } catch(te) { console.error('held time error:', te.message); }

      // ── Trailing stop logic ─────────────────────────────────────────────────
      var trailActivate = parseFloat(settings.trailActivate) || 0.15;
      var trailAmount   = parseFloat(settings.trailAmount)   || 0.10;
      var maxHold       = parseFloat(settings.maxHoldMinutes) || 20;

      if (pnlPer >= trailActivate) {
        // Update high-water mark
        if (!trailMarks[sym] || livePricePerContract > trailMarks[sym]) {
          trailMarks[sym] = livePricePerContract;
          await setState('trailMarks', trailMarks);
        }
      }

      var trailStop = trailMarks[sym] ? trailMarks[sym] - trailAmount : null;
      var trailingTriggered = trailStop !== null && livePricePerContract <= trailStop;

      await addLog('entry',
        'monitor ' + sym +
        ' entry:$' + entryPricePerContract.toFixed(2) +
        ' live:$' + livePricePerContract.toFixed(2) +
        ' pnl:$' + pnlPer.toFixed(2) +
        (trailMarks[sym] ? ' peak:$' + trailMarks[sym].toFixed(2) : '') +
        ' held:' + Math.round(heldMinutes) + 'min'
      );

      // ── Close helpers ───────────────────────────────────────────────────────
      async function closeTrade(reason, pnlLabel, isWin) {
        var totalPnl = pnlPer * Math.abs(pos.quantity || 1);
        await addLog(isWin ? 'trade' : 'stop', reason + ': ' + sym + ' ' + pnlLabel + '$' + Math.abs(totalPnl).toFixed(2));
        await closePos(pos, session);
        // Clear trail mark for this symbol
        delete trailMarks[sym];
        await setState('trailMarks', trailMarks);
        if (isWin) {
          var dp = await getState('dailyProfit', 0);
          dp += totalPnl;
          await setState('dailyProfit', dp);
          try {
            var wt = sym.slice(0, 4).trim();
            await pool.query("UPDATE trades SET result='win', pnl=$1 WHERE result='open' AND ticker=$2 AND ts=(SELECT MAX(ts) FROM trades WHERE result='open' AND ticker=$3)", [totalPnl.toFixed(2), wt, wt]);
            await addLog('trade', 'Journal: WIN +$' + totalPnl.toFixed(2) + ' on ' + wt + ' | Daily profit: $' + dp.toFixed(2));
          } catch(e) { console.error('win record error:', e.message); }
        } else {
          var loss = Math.abs(totalPnl);
          dailyLoss += loss;
          await setState('dailyLoss', dailyLoss);
          try {
            var lt = sym.slice(0, 4).trim();
            await pool.query("UPDATE trades SET result='loss', pnl=$1 WHERE result='open' AND ticker=$2 AND ts=(SELECT MAX(ts) FROM trades WHERE result='open' AND ticker=$3)", [totalPnl.toFixed(2), lt, lt]);
            await addLog('stop', 'Journal: LOSS -$' + loss.toFixed(2) + ' on ' + lt);
          } catch(e) { console.error('loss record error:', e.message); }
        }
        setTimeout(runEngine, 3000);
      }

      // ── Exit decisions (in priority order) ─────────────────────────────────

      // 1. Hard profit target hit
      if (pnlPer >= settings.profitTarget) {
        await closeTrade('PROFIT TARGET', '+', true);

      // 2. Trailing stop triggered (locked in some profit)
      } else if (trailingTriggered) {
        var isProfit = pnlPer > 0;
        await closeTrade('TRAILING STOP', pnlPer >= 0 ? '+' : '-', isProfit);

      // 3. Hard stop loss
      } else if (pnlPer <= -settings.stopLoss) {
        await closeTrade('STOP LOSS', '-', false);

      // 4. Time-based exit — held too long
      } else if (heldMinutes >= maxHold) {
        var isProfit = pnlPer > 0;
        await closeTrade('TIME EXIT (' + Math.round(heldMinutes) + 'min)', pnlPer >= 0 ? '+' : '-', isProfit);
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
  var settings = await getState('settings', { profitTarget: 0.50, stopLoss: 0.25, dailyMax: 500, dailyProfitTarget: 200, maxPositions: 2, contracts: 1, schedule: '5min' });
  var watchlist = await getState('watchlist', ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'AMD']);
  var killSwitch = await getState('killSwitch', false);
  var dailyLoss = await getState('dailyLoss', 0);
  var dailyProfit = await getState('dailyProfit', 0);
  var profitTargetHit = await getState('profitTargetHit', false);
  var session = await getState('session', null);
  res.json({ engineOn: engineOn, settings: settings, watchlist: watchlist, killSwitch: killSwitch, dailyLoss: dailyLoss, dailyProfit: dailyProfit, profitTargetHit: profitTargetHit, hasSession: !!session, accountId: session && session.accountId, isLive: session && session.isLive });
});

app.get('/api/logs', async function(req, res) {
  try { var r = await pool.query('SELECT ts,type,message FROM scan_log ORDER BY ts DESC LIMIT 100'); res.json(r.rows); }
  catch(e) { res.json([]); }
});

app.get('/api/trades', async function(req, res) {
  try { var r = await pool.query('SELECT * FROM trades ORDER BY ts DESC LIMIT 200'); res.json(r.rows); }
  catch(e) { res.json([]); }
});

// Journal stats endpoint
app.get('/api/journal', async function(req, res) {
  try {
    var r = await pool.query('SELECT * FROM trades ORDER BY ts DESC');
    var trades = r.rows;
    var closed = trades.filter(function(t){return t.result==='win'||t.result==='loss';});
    var wins = closed.filter(function(t){return t.result==='win';});
    var losses = closed.filter(function(t){return t.result==='loss';});
    var totalPnl = closed.reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
    var winPnl = wins.reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
    var lossPnl = losses.reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
    var avgWin = wins.length ? winPnl/wins.length : 0;
    var avgLoss = losses.length ? lossPnl/losses.length : 0;
    var winRate = closed.length ? (wins.length/closed.length*100) : 0;
    var profitFactor = Math.abs(lossPnl) > 0 ? winPnl/Math.abs(lossPnl) : 0;
    // Group by day
    var byDay = {};
    closed.forEach(function(t){
      var day = t.ts.toISOString ? t.ts.toISOString().slice(0,10) : String(t.ts).slice(0,10);
      if(!byDay[day]) byDay[day]={date:day,trades:0,wins:0,losses:0,pnl:0};
      byDay[day].trades++;
      if(t.result==='win')byDay[day].wins++;
      else byDay[day].losses++;
      byDay[day].pnl+=parseFloat(t.pnl)||0;
    });
    var dailyStats = Object.values(byDay).sort(function(a,b){return b.date.localeCompare(a.date);});
    res.json({
      totalTrades:closed.length, openTrades:trades.filter(function(t){return t.result==='open';}).length,
      wins:wins.length, losses:losses.length, winRate:winRate.toFixed(1),
      totalPnl:totalPnl.toFixed(2), avgWin:avgWin.toFixed(2), avgLoss:avgLoss.toFixed(2),
      profitFactor:profitFactor.toFixed(2), dailyStats:dailyStats, recentTrades:trades.slice(0,20)
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Update trade result when closed
app.post('/api/trades/:id/close', async function(req, res) {
  try {
    var pnl = parseFloat(req.body.pnl) || 0;
    var result = pnl >= 0 ? 'win' : 'loss';
    await pool.query('UPDATE trades SET result=$1, pnl=$2 WHERE id=$3',[result,pnl,req.params.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
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
    console.log('Daily counters reset at midnight ET');
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
    var profitHit = await getState('profitTargetHit', false);
    var killSwitch = await getState('killSwitch', false);
    var session = await getState('session', null);
    if (killSwitch) { console.log('9:30am restart skipped — kill switch on'); return; }
    if (!profitHit) { console.log('9:30am restart skipped — profit target was not the stop reason'); return; }
    if (!session) { console.log('9:30am restart skipped — no session'); return; }
    await setState('profitTargetHit', false);
    await setState('dailyLoss', 0);
    await setState('dailyProfit', 0);
    await setState('engineOn', true);
    var s = await getState('settings', { schedule: '5min' });
    startTimers(s.schedule);
    await addLog('trade', '🟢 Engine auto-restarted at market open — new trading day');
    runEngine();
    scheduleMarketOpenRestart(); // schedule next day
  }, msUntil);
}

app.get('/', function(req, res) { res.sendFile(__dirname + '/public/index.html'); });

var PORT = process.env.PORT || 3001;
pool.connect()
  .then(function() { return initDB(); })
  .then(function() {
    app.listen(PORT, function() { console.log('running on port ' + PORT); });
    scheduleMidnightReset();
    scheduleMarketOpenRestart();
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

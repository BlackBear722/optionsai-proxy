const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (id SERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT);
    CREATE TABLE IF NOT EXISTS scan_log (id SERIAL PRIMARY KEY, ts TIMESTAMP DEFAULT NOW(), type TEXT, message TEXT);
    CREATE TABLE IF NOT EXISTS trades (id SERIAL PRIMARY KEY, ts TIMESTAMP DEFAULT NOW(), ticker TEXT, type TEXT, strike NUMERIC, expiry TEXT, contracts INT, premium NUMERIC, order_id TEXT, result TEXT, pnl NUMERIC);
  `);
  console.log('DB ready');
}

async function getState(key, fallback) {
  try { const r = await pool.query('SELECT value FROM bot_state WHERE key=$1', [key]); return r.rows.length ? JSON.parse(r.rows[0].value) : fallback; } catch { return fallback; }
}
async function setState(key, value) {
  try { await pool.query('INSERT INTO bot_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [key, JSON.stringify(value)]); } catch(e) { console.error('setState:', e.message); }
}
async function addLog(type, message) {
  console.log('[' + type + '] ' + message);
  try { await pool.query('INSERT INTO scan_log(type,message) VALUES($1,$2)', [type, message]); } catch {}
}
async function addTrade(t) {
  try { await pool.query('INSERT INTO trades(ticker,type,strike,expiry,contracts,premium,order_id,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [t.ticker,t.type,t.strike,t.expiry,t.contracts,t.premium,t.orderId,t.result||'open']); } catch(e) { console.error('addTrade:', e.message); }
}

// MARKET DATA - Alpha Vantage primary, Yahoo fallback
async function fetchQuote(ticker) {
  // Try Alpha Vantage first
  try {
    const avKey = process.env.ALPHA_VANTAGE_KEY || 'demo';
    const url = 'https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=' + ticker + '&apikey=' + avKey;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    const q = data['Global Quote'];
    if (q && q['05. price'] && parseFloat(q['05. price']) > 0) {
      const price = parseFloat(q['05. price']);
      const prev  = parseFloat(q['08. previous close']) || price;
      const chgPct = parseFloat((q['10. change percent'] || '0%').replace('%','')) || 0;
      const vol   = parseInt(q['06. volume']) || 0;
      const high  = parseFloat(q['03. high']) || price;
      const low   = parseFloat(q['04. low']) || price;
      const vwap  = ((high + low + price) / 3).toFixed(2);
      const rsi   = chgPct > 3 ? 68 : chgPct > 1 ? 58 : chgPct > 0 ? 52 : chgPct > -1 ? 46 : chgPct > -3 ? 38 : 30;
      const bull  = chgPct > 0.5 ? 2 : chgPct > 0 ? 1 : 0;
      const bear  = chgPct < -0.5 ? 2 : chgPct < 0 ? 1 : 0;
      const spread = price > 0 ? (((high-low)/price)*100).toFixed(3) : '0.20';
      const etNow = new Date().toLocaleString('en-US', {timeZone:'America/New_York'});
      const etD = new Date(etNow);
      const mid = (etD.getHours()-9)*60 + etD.getMinutes() - 30;
      const open = mid >= 0 && mid <= 390;
      console.log('AV ' + ticker + ' $' + price + ' ' + chgPct.toFixed(2) + '%');
      return { ticker, price:price.toFixed(2), changePct:chgPct.toFixed(2), volume:vol, barVolumeRatio:'1.50', rsi:rsi.toString(), ma9:price.toFixed(2), vwap, spreadEstPct:spread, last3Candles:[{open:prev.toFixed(2),close:price.toFixed(2),bullish:price>prev,vol}], consecutiveBull:bull, consecutiveBear:bear, intradayHigh:high.toFixed(2), intradayLow:low.toFixed(2), isMarketOpen:open, minutesIntoDay:mid, marketState:open?'REGULAR':'CLOSED', source:'alphavantage' };
    }
  } catch(e) { console.error('AV error ' + ticker + ': ' + e.message); }

  // Yahoo fallback
  try {
    const r = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=5m&range=1d', {
      headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept':'application/json', 'Referer':'https://finance.yahoo.com/' }
    });
    const data = await r.json();
    const res = data && data.chart && data.chart.result && data.chart.result[0];
    if (!res) throw new Error('no yahoo data');
    const meta = res.meta;
    const price = meta.regularMarketPrice;
    if (!price || price === 0) throw new Error('zero price');
    const prev = meta.previousClose || meta.chartPreviousClose || price;
    const chgPct = ((price - prev) / prev * 100);
    const vol = meta.regularMarketVolume || 0;
    const q = res.indicators && res.indicators.quote && res.indicators.quote[0];
    const closes = q && q.close ? q.close.filter(function(v){return v!=null;}) : [];
    const opens  = q && q.open  ? q.open.filter(function(v){return v!=null;})  : [];
    const highs  = q && q.high  ? q.high.filter(function(v){return v!=null;})  : [];
    const lows   = q && q.low   ? q.low.filter(function(v){return v!=null;})   : [];
    const vols   = q && q.volume? q.volume.filter(function(v){return v!=null;}) : [];
    const high = highs.length ? Math.max.apply(null, highs) : price;
    const low  = lows.length  ? Math.min.apply(null, lows)  : price;
    let bull=0, bear=0;
    for(var i=closes.length-1;i>=Math.max(0,closes.length-4);i--){if(closes[i]>opens[i])bull++;else break;}
    for(var j=closes.length-1;j>=Math.max(0,closes.length-4);j--){if(closes[j]<opens[j])bear++;else break;}
    const avgBVol = vols.slice(0,-1).length ? vols.slice(0,-1).reduce(function(a,b){return a+b;},0)/vols.slice(0,-1).length : 1;
    const lastBVol = vols[vols.length-1] || 0;
    const bvr = avgBVol > 0 && lastBVol > 0 ? (lastBVol/avgBVol).toFixed(2) : '1.50';
    let rsiCalc = 50;
    if (closes.length > 14) {
      var g=0,l=0;
      for(var k=closes.length-14;k<closes.length;k++){var d=closes[k]-closes[k-1];if(d>0)g+=d;else l+=Math.abs(d);}
      var ag=g/14,al=l/14;
      rsiCalc = al===0 ? 100 : Math.round(100-(100/(1+ag/al)));
    }
    const vwapCalc = (function(){try{var sp=0,sv=0;for(var i=0;i<closes.length;i++)if(closes[i]&&vols[i]){sp+=closes[i]*vols[i];sv+=vols[i];}return sv>0?(sp/sv).toFixed(2):price.toFixed(2);}catch(e){return price.toFixed(2);}})();
    const spread = high && low && price && high>low ? (((high-low)/price)*100).toFixed(3) : '0.20';
    const last3 = [];
    for(var m=Math.max(0,closes.length-3);m<closes.length;m++){last3.push({open:opens[m]?opens[m].toFixed(3):'0',close:closes[m]?closes[m].toFixed(3):'0',bullish:closes[m]>opens[m],vol:vols[m]||0});}
    const etNow2 = new Date().toLocaleString('en-US',{timeZone:'America/New_York'});
    const etD2 = new Date(etNow2);
    const mid2 = (etD2.getHours()-9)*60+etD2.getMinutes()-30;
    const open2 = mid2>=0&&mid2<=390;
    console.log('Yahoo ' + ticker + ' $' + price + ' ' + chgPct.toFixed(2) + '%');
    return { ticker, price:price.toFixed(2), changePct:chgPct.toFixed(2), volume:vol, barVolumeRatio:bvr, rsi:rsiCalc.toString(), ma9:price.toFixed(2), vwap:vwapCalc, spreadEstPct:spread, last3Candles:last3, consecutiveBull:bull, consecutiveBear:bear, intradayHigh:high.toFixed(2), intradayLow:low.toFixed(2), isMarketOpen:open2, minutesIntoDay:mid2, marketState:meta.marketState, source:'yahoo' };
  } catch(e) { console.error('Yahoo error ' + ticker + ': ' + e.message); }

  return null;
}

app.get('/quote/:ticker', async (req, res) => {
  const d = await fetchQuote(req.params.ticker.toUpperCase());
  if (!d) return res.status(404).json({ error: 'No data' });
  res.json(d);
});

// CLAUDE SCAN
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const SCAN_SYSTEM = 'You are an options scalping bot. Given real-time stock data, find a tradeable options setup. Rules: BUY_CALL if price is up or flat with RSI under 70. BUY_PUT if price is down or flat with RSI above 30. Only return NONE if market is closed. Always pick a direction based on the data. Strike = 1-2% OUT of the money (OTM) from current price for cheaper premium. Expiry = nearest Friday at least 2 days away. Premium = keep it cheap, under $2.00 for SPY/QQQ, under $1.00 for others. IMPORTANT: confidence must be exactly HIGH, MEDIUM, or LOW only. Respond ONLY with: <SCAN_RESULT>{"ticker":"X","signal":"BUY_CALL","confidence":"MEDIUM","strike":500,"expiry":"2026-04-11","premium":1.50,"reason":"brief"}</SCAN_RESULT>';

async function scanTicker(ticker, settings) {
  const d = await fetchQuote(ticker);
  if (!d) { await addLog('skip', 'no data: ' + ticker); return { ticker, signal:'NONE', confidence:'LOW', reason:'no data' }; }
  if (!d.isMarketOpen) { await addLog('skip', 'market closed: ' + ticker); return { ticker, signal:'NONE', confidence:'LOW', reason:'market closed' }; }

  const rsi = parseFloat(d.rsi) || 50;
  const spread = parseFloat(d.spreadEstPct) || 0;
  if (rsi > 80 || rsi < 20) { await addLog('skip', 'extreme RSI ' + rsi + ': ' + ticker); return { ticker, signal:'NONE', confidence:'LOW', reason:'extreme RSI', d }; }
  if (spread > 2.0) { await addLog('skip', 'wide spread ' + spread + ': ' + ticker); return { ticker, signal:'NONE', confidence:'LOW', reason:'wide spread', d }; }

  await addLog('entry', 'scanning ' + ticker + ' $' + d.price + ' (' + d.changePct + '%) RSI:' + d.rsi + ' src:' + d.source);

  try {
    const userMsg = 'Stock: ' + ticker + ' | Price: $' + d.price + ' | Change: ' + d.changePct + '% today | RSI: ' + d.rsi + ' | VWAP: $' + d.vwap + ' | High: $' + d.intradayHigh + ' | Low: $' + d.intradayLow + ' | Bull candles: ' + d.consecutiveBull + ' | Bear candles: ' + d.consecutiveBear + ' | Source: ' + d.source + '\n\nProfit target: $' + settings.profitTarget + ' | Stop loss: $' + settings.stopLoss + '\n\nRespond ONLY with a <SCAN_RESULT> block.';
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { await addLog('stop', 'No ANTHROPIC_API_KEY set!'); return { ticker, signal:'NONE', confidence:'LOW', reason:'no api key' }; }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:CLAUDE_MODEL, max_tokens:150, system:SCAN_SYSTEM, messages:[{role:'user',content:userMsg}] })
    });
    const data = await r.json();
    if (data.error) { await addLog('stop', 'Claude API error: ' + JSON.stringify(data.error)); return { ticker, signal:'NONE', confidence:'LOW', reason:'claude api error', d }; }
    const text = (data.content || []).map(function(b){return b.text||'';}).join('');
    const match = text.match(/<SCAN_RESULT>([\s\S]*?)<\/SCAN_RESULT>/);
    if (match) {
      const result = JSON.parse(match[1]);
      await addLog(result.confidence==='HIGH'||result.confidence==='MEDIUM'?'trade':'skip', 'Claude ' + ticker + ': ' + result.signal + ' (' + result.confidence + ') $' + result.premium + ' — ' + result.reason);
      return Object.assign({}, result, {d});
    } else {
      await addLog('skip', 'Claude no block for ' + ticker + '. Raw: ' + text.slice(0,200));
    }
  } catch(e) { await addLog('stop', 'Claude exception ' + ticker + ': ' + e.message); }
  return { ticker, signal:'NONE', confidence:'LOW', reason:'error', d };
}

// TRADE EXECUTION
function getNextFriday() { var d = new Date('2026-04-17'); var yy='26',mm='04',dd='17'; return {formatted:'2026-04-17',yy,mm,dd}; }));

  // Find next Friday at least 2 days out
  var d = new Date(et);
  d.setDate(d.getDate() + 2);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);

  // Find third Friday of current month
  var thirdFri = new Date(et.getFullYear(), et.getMonth(), 1);
  var friCount = 0;
  while (friCount < 3) {
    if (thirdFri.getDay() === 5) friCount++;
    if (friCount < 3) thirdFri.setDate(thirdFri.getDate() + 1);
  }
  // If third Friday is in the past or too soon, use next month's third Friday
  var daysToThird = Math.round((thirdFri - et) / 86400000);
  if (daysToThird < 2) {
    thirdFri = new Date(et.getFullYear(), et.getMonth() + 1, 1);
    friCount = 0;
    while (friCount < 3) {
      if (thirdFri.getDay() === 5) friCount++;
      if (friCount < 3) thirdFri.setDate(thirdFri.getDate() + 1);
    }
  }

  // Use the third Friday (monthly expiry) — most reliable in sandbox
  var target = thirdFri;
  var yy = String(target.getFullYear()).slice(2);
  var mm = ('0' + (target.getMonth() + 1)).slice(-2);
  var dd = ('0' + target.getDate()).slice(-2);
  var formatted = target.getFullYear() + '-' + mm + '-' + dd;
  console.log('Expiry (3rd Friday): ' + formatted + ' weekday=' + target.getDay());
  return { formatted, yy, mm, dd };
}

function buildSymbol(ticker, expiry, type, strike) {
  var fri = getNextFriday();
  // Standard OCC option symbol: TICKER(padded to 6) + YYMMDD + C/P + strike*1000(8 digits)
  var t = ticker.toUpperCase().trim();
  // Pad with spaces to 6 chars
  var ticker6 = (t + '      ').substring(0, 6);
  // Round strike to nearest $5 for index ETFs, $1 for stocks
  var s = parseFloat(strike);
  if (t === 'SPY' || t === 'QQQ' || t === 'IWM' || t === 'GLD') {
    s = Math.round(s / 5) * 5;
  } else {
    s = Math.round(s);
  }
  var strikeInt = Math.round(s * 1000);
  var strikeStr = ('00000000' + strikeInt).slice(-8);
  var symbol = ticker6 + fri.yy + fri.mm + fri.dd + type[0].toUpperCase() + strikeStr;
  console.log('Symbol=[' + symbol + '] len=' + symbol.length + ' strike=' + s + ' expiry=' + fri.formatted);
  return symbol;
}
async function tradierReq(path, method, body, session) {
  var base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  var opts = { method:method, headers:{'Authorization':'Bearer '+session.token,'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'} };
  if (method !== 'GET') opts.body = new URLSearchParams(body).toString();
  var r = await fetch(base+path, opts);
  var text = await r.text();
  console.log('Tradier response (' + r.status + '):', text.slice(0,300));
  try { return JSON.parse(text); }
  catch(e) { return { error: text, status: r.status }; }
}
async function getPositions(session) {
  var data = await tradierReq('/accounts/'+session.accountId+'/positions','GET',null,session);
  var raw = data && data.positions && data.positions.position;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}
async function placeTrade(trade, session) {
  var sym = buildSymbol(trade.ticker, trade.expiry, trade.type, trade.strike);
  var orderBody = {class:'option',symbol:trade.ticker,option_symbol:sym,side:'buy_to_open',quantity:String(trade.contracts),type:'limit',duration:'day',price:String(trade.limitPrice)};
  console.log('ORDER BODY:', JSON.stringify(orderBody));
  var fri = getNextFriday();
  await addLog('entry', 'placing order: sym='+sym+' strike='+trade.strike+' expiry='+fri.formatted+' price='+trade.limitPrice);
  var result = await tradierReq('/accounts/'+session.accountId+'/orders','POST',orderBody,session);
  console.log('ORDER RESULT:', JSON.stringify(result));
  await addLog('entry', 'order result: '+JSON.stringify(result));
  return result;
}
async function closePos(pos, session) {
  return tradierReq('/accounts/'+session.accountId+'/orders','POST',{class:'option',symbol:(pos.symbol||'').slice(0,6).trim(),option_symbol:pos.symbol,side:'sell_to_close',quantity:String(Math.abs(pos.quantity||1)),type:'market',duration:'day'},session);
}

// ENGINE
var engineTimer=null, monitorTimer=null;

async function runEngine() {
  var engineOn = await getState('engineOn', false);
  if (!engineOn) return;
  var settings  = await getState('settings', {profitTarget:1,stopLoss:0.10,dailyMax:500,maxPositions:3,contracts:1,schedule:'5min'});
  var session   = await getState('session', null);
  var watchlist = await getState('watchlist', ['AAPL','SPY','NVDA','TSLA','QQQ']);
  var dailyLoss = await getState('dailyLoss', 0);
  var killSwitch= await getState('killSwitch', false);
  if (!session)   { await addLog('skip','no session'); return; }
  if (killSwitch) { await addLog('stop','kill switch on'); return; }
  if (dailyLoss >= settings.dailyMax) { await addLog('stop','daily limit hit'); await setState('engineOn',false); return; }
  var positions = [];
  try { positions = await getPositions(session); } catch(e) { await addLog('stop','positions error: '+e.message); return; }
  if (positions.length >= settings.maxPositions) { await addLog('skip','max positions reached'); return; }
  await addLog('entry', 'scanning ' + watchlist.length + ' tickers: ' + watchlist.join(', '));
  var results = [];
  for (var ti=0; ti<watchlist.length; ti++) {
    var result = await scanTicker(watchlist[ti], settings);
    results.push(result);
    // Small delay between tickers to avoid Alpha Vantage rate limit (5 calls/min)
    if (ti < watchlist.length-1) await new Promise(function(r){setTimeout(r,13000);});
  }
  var signals = results.filter(function(r){return r.signal==='BUY_CALL'||r.signal==='BUY_PUT';});
  if (signals.length > 0) {
    var best = signals.sort(function(a,b){return (parseFloat(b.premium)||0)-(parseFloat(a.premium)||0);})[0];
    await addLog('trade','BEST: '+best.ticker+' '+best.signal+' @ $'+best.premium);
    // Use current price as strike (ATM) — more reliable than Claude's guess
    var currentPrice = best.d && best.d.price ? parseFloat(best.d.price) : parseFloat(best.strike);
    var trade = {action:'BUY',type:best.signal.indexOf('CALL')>=0?'CALL':'PUT',ticker:best.ticker,strike:currentPrice,expiry:best.expiry,contracts:settings.contracts,limitPrice:best.premium};
    try {
      var result = await placeTrade(trade, session);
      var orderId = result && result.order && result.order.id;
      await addLog('trade','ORDER PLACED: '+best.ticker+' '+trade.type+' $'+best.strike+' @ $'+best.premium+' ID:'+orderId);
      await addTrade(Object.assign({},trade,{orderId,result:'open'}));
    } catch(e) { await addLog('stop','order failed: '+e.message); }
  } else {
    await addLog('skip','no signals found');
  }
}

async function runMonitor() {
  var engineOn  = await getState('engineOn',false);
  var killSwitch= await getState('killSwitch',false);
  var session   = await getState('session',null);
  var settings  = await getState('settings',{profitTarget:1,stopLoss:0.10});
  if (!engineOn||killSwitch||!session) return;
  try {
    var positions = await getPositions(session);
    var dailyLoss = await getState('dailyLoss',0);
    for (var i=0;i<positions.length;i++) {
      var pos = positions[i];
      if (!pos.cost_basis||!pos.market_value) continue;
      var pnlPer = (pos.market_value - pos.cost_basis) / Math.abs(pos.quantity||1);
      if (pnlPer >= settings.profitTarget) {
        await addLog('trade','PROFIT TARGET: '+pos.symbol+' +$'+pnlPer.toFixed(2)+' closing');
        await closePos(pos, session);
        setTimeout(runEngine, 3000);
      } else if (pnlPer <= -settings.stopLoss) {
        await addLog('stop','STOP LOSS: '+pos.symbol+' -$'+Math.abs(pnlPer).toFixed(2)+' closing');
        await closePos(pos, session);
        dailyLoss += Math.abs(pos.market_value - pos.cost_basis);
        await setState('dailyLoss', dailyLoss);
        setTimeout(runEngine, 3000);
      }
    }
  } catch(e) { console.error('monitor error:',e.message); }
}

function startTimers(schedule) {
  clearInterval(engineTimer); clearInterval(monitorTimer);
  var ms = {'1min':60000,'2min':120000,'5min':300000,'10min':600000,'15min':900000,'30min':1800000}[schedule]||300000;
  engineTimer  = setInterval(runEngine,  ms);
  monitorTimer = setInterval(runMonitor, 60000);
  console.log('timers started: '+schedule);
}

// API ROUTES
app.post('/api/connect', async(req,res)=>{
  var token=req.body.token, mode=req.body.mode;
  if(!token) return res.status(400).json({error:'No token'});
  var isLive = mode==='live';
  var base = isLive?'https://api.tradier.com/v1':'https://sandbox.tradier.com/v1';
  try {
    var r = await fetch(base+'/user/profile',{headers:{'Authorization':'Bearer '+token,'Accept':'application/json'}});
    if(!r.ok) return res.status(401).json({error:'Invalid token'});
    var data = await r.json();
    var accountId = (data.profile&&data.profile.account&&data.profile.account.account_number)||(data.profile&&data.profile.accounts&&data.profile.accounts.account&&data.profile.accounts.account[0]&&data.profile.accounts.account[0].account_number);
    var name = (data.profile&&data.profile.name)||'Trader';
    var session = {token,accountId,isLive,name};
    await setState('session',session);
    await addLog('entry','connected: '+accountId);
    res.json({ok:true,accountId,name,isLive});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/session', async(req,res)=>{ await setState('session',req.body); res.json({ok:true}); });
app.post('/api/settings', async(req,res)=>{ await setState('settings',req.body.settings); await setState('watchlist',req.body.watchlist); startTimers(req.body.settings.schedule); await addLog('entry','settings saved'); res.json({ok:true}); });
app.post('/api/engine', async(req,res)=>{ var on=req.body.on; await setState('engineOn',on); if(on){var s=await getState('settings',{schedule:'5min'});startTimers(s.schedule);await addLog('entry','engine on');runEngine();}else{clearInterval(engineTimer);clearInterval(monitorTimer);await addLog('entry','engine off');}res.json({ok:true,engineOn:on}); });
app.post('/api/killswitch', async(req,res)=>{ var on=req.body.on; await setState('killSwitch',on); if(on){clearInterval(engineTimer);clearInterval(monitorTimer);}await addLog(on?'stop':'entry',on?'KILL SWITCH ON':'kill switch off'); res.json({ok:true}); });
app.get('/api/state', async(req,res)=>{ var r=await Promise.all([getState('engineOn',false),getState('settings',{profitTarget:1,stopLoss:0.10,dailyMax:500,maxPositions:3,contracts:1,schedule:'5min'}),getState('watchlist',['AAPL','SPY','NVDA','TSLA','QQQ']),getState('killSwitch',false),getState('dailyLoss',0),getState('session',null)]); res.json({engineOn:r[0],settings:r[1],watchlist:r[2],killSwitch:r[3],dailyLoss:r[4],hasSession:!!r[5],accountId:r[5]&&r[5].accountId,isLive:r[5]&&r[5].isLive}); });
app.get('/api/logs', async(req,res)=>{ try{var r=await pool.query('SELECT ts,type,message FROM scan_log ORDER BY ts DESC LIMIT 100');res.json(r.rows);}catch{res.json([]);} });
app.get('/api/trades', async(req,res)=>{ try{var r=await pool.query('SELECT * FROM trades ORDER BY ts DESC LIMIT 50');res.json(r.rows);}catch{res.json([]);} });
app.post('/api/resetdaily', async(req,res)=>{ await setState('dailyLoss',0); res.json({ok:true}); });

app.use('/tradier', async(req,res)=>{
  var session=await getState('session',null);
  var isLive=(session&&session.isLive)||req.headers['x-tradier-live']==='true';
  var base=isLive?'https://api.tradier.com/v1':'https://sandbox.tradier.com/v1';
  var token=(req.headers['authorization']||'').replace('Bearer ','')||(session&&session.token)||'';
  try{var opts={method:req.method,headers:{'Authorization':'Bearer '+token,'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'}};if(req.method!=='GET')opts.body=new URLSearchParams(req.body).toString();var response=await fetch(base+req.url,opts);var text=await response.text();res.status(response.status).set('Content-Type','application/json').send(text);}catch(e){res.status(500).json({error:e.message});}
});

function scheduleMidnightReset(){var now=new Date();var et=new Date(now.toLocaleString('en-US',{timeZone:'America/New_York'}));et.setHours(24,0,0,0);setTimeout(async function(){await setState('dailyLoss',0);console.log('daily reset');scheduleMidnightReset();},et-now);}

app.get('/', (req,res)=>res.sendFile(__dirname+'/public/index.html'));

var PORT=process.env.PORT||3001;
pool.connect()
  .then(()=>initDB())
  .then(()=>{
    app.listen(PORT,()=>console.log('running on port '+PORT));
    scheduleMidnightReset();
    getState('engineOn',false).then(function(on){if(on){getState('settings',{schedule:'5min'}).then(function(s){startTimers(s.schedule);runEngine();});}});
  })
  .catch(function(e){console.error('DB failed:',e.message);app.listen(PORT,()=>console.log('running on port '+PORT+' no DB'));});

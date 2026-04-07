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

// ── DATABASE ───────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS scan_log (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP DEFAULT NOW(),
      type TEXT,
      message TEXT
    );
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP DEFAULT NOW(),
      ticker TEXT, type TEXT, strike NUMERIC,
      expiry TEXT, contracts INT, premium NUMERIC,
      order_id TEXT, result TEXT, pnl NUMERIC
    );
  `);
  console.log('✅ DB initialized');
}

async function getState(key, fallback = null) {
  try {
    const r = await pool.query('SELECT value FROM bot_state WHERE key=$1', [key]);
    return r.rows.length ? JSON.parse(r.rows[0].value) : fallback;
  } catch { return fallback; }
}

async function setState(key, value) {
  try {
    await pool.query(
      'INSERT INTO bot_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
      [key, JSON.stringify(value)]
    );
  } catch(e) { console.error('setState error:', e.message); }
}

async function addLog(type, message) {
  console.log(`[${type}] ${message}`);
  try { await pool.query('INSERT INTO scan_log(type,message) VALUES($1,$2)', [type, message]); } catch {}
}

async function addTrade(trade) {
  try {
    await pool.query(
      'INSERT INTO trades(ticker,type,strike,expiry,contracts,premium,order_id,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [trade.ticker, trade.type, trade.strike, trade.expiry, trade.contracts, trade.premium, trade.orderId, trade.result||'open']
    );
  } catch(e) { console.error('addTrade error:', e.message); }
}

// ── YAHOO FINANCE ──────────────────────────────────────────────────────────────
async function fetchQuote(ticker) {
  try {
    const [intraRes, dailyRes] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=6mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    ]);
    const intraData = await intraRes.json();
    const dailyData = await dailyRes.json();
    const intra = intraData?.chart?.result?.[0];
    const daily = dailyData?.chart?.result?.[0];
    if (!intra) return null;
    const meta = intra.meta;
    const q5 = intra.indicators?.quote?.[0];
    const qD = daily?.indicators?.quote?.[0];
    const closes5m = q5?.close?.filter(v=>v!=null)||[];
    const volumes5m = q5?.volume?.filter(v=>v!=null)||[];
    const highs5m   = q5?.high?.filter(v=>v!=null)||[];
    const lows5m    = q5?.low?.filter(v=>v!=null)||[];
    const opens5m   = q5?.open?.filter(v=>v!=null)||[];
    const dailyCloses = qD?.close?.filter(v=>v!=null)||[];
    const dailyVols   = qD?.volume?.filter(v=>v!=null)||[];
    const price     = meta.regularMarketPrice;
    const prevClose = meta.previousClose||meta.chartPreviousClose;
    const changePct = ((price-prevClose)/prevClose)*100;
    const volume    = meta.regularMarketVolume;
    const avgDailyVol = dailyVols.length>=5 ? dailyVols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,dailyVols.length) : volume;
    const volumeRatio = volume/avgDailyVol;
    const avg5mVol = volumes5m.length>1 ? volumes5m.slice(0,-1).reduce((a,b)=>a+b,0)/(volumes5m.length-1) : volumes5m[0]||1;
    const lastBarVol = volumes5m[volumes5m.length-1]||0;
    const barVolumeRatio = lastBarVol/avg5mVol;
    const rsi = calcRSI(dailyCloses,14);
    const ma9  = calcMA(closes5m,9);
    const ma20 = calcMA(dailyCloses,20);
    const ma50 = calcMA(dailyCloses,50);
    const vwap = calcVWAP(q5);
    const last3Candles=[];
    const len=Math.min(closes5m.length,opens5m.length,3);
    for(let i=closes5m.length-len;i<closes5m.length;i++){
      last3Candles.push({open:opens5m[i]?.toFixed(3),close:closes5m[i]?.toFixed(3),bullish:closes5m[i]>opens5m[i],vol:volumes5m[i]});
    }
    const lastHigh=highs5m[highs5m.length-1]||price;
    const lastLow=lows5m[lows5m.length-1]||price;
    const spreadEstPct=((lastHigh-lastLow)/price*100).toFixed(3);
    let consecutiveBull=0,consecutiveBear=0;
    for(let i=closes5m.length-1;i>=Math.max(0,closes5m.length-5);i--){if(closes5m[i]>opens5m[i])consecutiveBull++;else break;}
    for(let i=closes5m.length-1;i>=Math.max(0,closes5m.length-5);i--){if(closes5m[i]<opens5m[i])consecutiveBear++;else break;}
    const etNow = new Date().toLocaleString('en-US',{timeZone:'America/New_York'});
    const etDate = new Date(etNow);
    const minutesIntoDay=(etDate.getHours()-9)*60+etDate.getMinutes()-30;
    const isMarketOpen = minutesIntoDay>=0 && minutesIntoDay<=390;
    return {
      ticker, price:price?.toFixed(2), changePct:changePct?.toFixed(2),
      volume, volumeRatio:volumeRatio?.toFixed(2), barVolumeRatio:barVolumeRatio?.toFixed(2),
      rsi:rsi?.toFixed(1), ma9:ma9?.toFixed(2), ma20:ma20?.toFixed(2), ma50:ma50?.toFixed(2),
      vwap:vwap?.toFixed(2), spreadEstPct, last3Candles,
      consecutiveBull, consecutiveBear,
      intradayHigh:highs5m.length?Math.max(...highs5m).toFixed(2):price,
      intradayLow:lows5m.length?Math.min(...lows5m).toFixed(2):price,
      isMarketOpen, minutesIntoDay, marketState:meta.marketState,
    };
  } catch(e) { console.error(`fetchQuote ${ticker}:`,e.message); return null; }
}

app.get('/quote/:ticker', async (req, res) => {
  const d = await fetchQuote(req.params.ticker.toUpperCase());
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
});

function calcRSI(closes,period=14){if(closes.length<period+1)return null;let g=0,l=0;for(let i=closes.length-period;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l+=Math.abs(d);}const ag=g/period,al=l/period;if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcMA(closes,period){if(closes.length<period)return null;return closes.slice(-period).reduce((a,b)=>a+b,0)/period;}
function calcVWAP(q){try{const c=q?.close||[],v=q?.volume||[];let sp=0,sv=0;for(let i=0;i<c.length;i++)if(c[i]&&v[i]){sp+=c[i]*v[i];sv+=v[i];}return sv>0?sp/sv:null;}catch{return null;}}

// ── CLAUDE SCAN ────────────────────────────────────────────────────────────────
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const SCAN_PROMPT = `You are OptionsAI, a scalping bot. You receive REAL-TIME market data and apply Rotter-style rules.

HIGH confidence CALL: consecutiveBull>=3, barVolumeRatio>=2.0, price>vwap, price>ma9, RSI 45-65, spreadEstPct<0.5, changePct>0.2
HIGH confidence PUT:  consecutiveBear>=3, barVolumeRatio>=2.0, price<vwap, price<ma9, RSI 35-55, spreadEstPct<0.5, changePct<-0.2
SKIP if: spreadEstPct>0.8, barVolumeRatio<1.5, consecutiveBull<2 AND consecutiveBear<2, RSI>75 or RSI<25

Strike: nearest ATM. Expiry: nearest Friday 2+ days out. Premium: 0.5-2% of stock price.
Respond ONLY with: <SCAN_RESULT>{"ticker":"X","signal":"BUY_CALL" or "BUY_PUT" or "NONE","confidence":"HIGH" or "MEDIUM" or "LOW","strike":0,"expiry":"YYYY-MM-DD","premium":0.00,"reason":"RSI/vol/candles summary"}</SCAN_RESULT>`;

async function scanTicker(ticker, settings) {
  const d = await fetchQuote(ticker);
  if (!d) return { ticker, signal: 'NONE', confidence: 'LOW', reason: 'no data' };
  if (!d.isMarketOpen) return { ticker, signal: 'NONE', confidence: 'LOW', reason: 'market closed' };

  // Pre-filter
  const rsi = parseFloat(d.rsi)||50;
  const bvr = parseFloat(d.barVolumeRatio)||0;
  const spread = parseFloat(d.spreadEstPct)||99;
  if (spread > 0.8)   return { ticker, signal:'NONE', confidence:'LOW', reason:`spread too wide (${spread}%)`, d };
  if (bvr < 1.5)      return { ticker, signal:'NONE', confidence:'LOW', reason:`low volume (${bvr}x)`, d };
  if (d.consecutiveBull < 2 && d.consecutiveBear < 2)
                      return { ticker, signal:'NONE', confidence:'LOW', reason:`no momentum (${d.consecutiveBull}bull/${d.consecutiveBear}bear)`, d };
  if (rsi > 75 || rsi < 25) return { ticker, signal:'NONE', confidence:'LOW', reason:`extreme RSI (${rsi})`, d };

  const candleStr = d.last3Candles?.map(c=>`${c.bullish?'🟢':'🔴'} O:${c.open} C:${c.close}`).join(' | ')||'N/A';
  const dataStr = `LIVE DATA: ${ticker} $${d.price} (${d.changePct}%) | RSI:${d.rsi} | VWAP:$${d.vwap} | MA9:$${d.ma9} | BarVol:${d.barVolumeRatio}x | Spread:${d.spreadEstPct}% | Bull:${d.consecutiveBull} Bear:${d.consecutiveBear} | Candles: ${candleStr}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 200, system: SCAN_PROMPT, messages: [{ role: 'user', content: `${dataStr}\n\nScalp scan for $${settings.profitTarget} target / $${settings.stopLoss} stop. Respond ONLY with <SCAN_RESULT>.` }] })
    });
    const data = await res.json();
    const text = data.content?.map(b=>b.text||'').join('')||'';
    const match = text.match(/<SCAN_RESULT>(.*?)<\/SCAN_RESULT>/s);
    if (match) { const r = JSON.parse(match[1]); return { ...r, d }; }
  } catch(e) { console.error('Claude error:', e.message); }
  return { ticker, signal: 'NONE', confidence: 'LOW', reason: 'claude error', d };
}

// ── TRADE EXECUTION ────────────────────────────────────────────────────────────
function buildOptionSymbol(ticker,expiry,type,strike){
  const dt=new Date(expiry);
  return `${ticker.padEnd(6)}${String(dt.getFullYear()).slice(2)}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}${type[0]}${String(Math.round(strike*1000)).padStart(8,'0')}`;
}

async function placeTrade(trade, session) {
  const sym = buildOptionSymbol(trade.ticker, trade.expiry, trade.type, trade.strike);
  const body = { class:'option', symbol:trade.ticker, option_symbol:sym, side:'buy_to_open', quantity:String(trade.contracts), type:'limit', duration:'day', price:String(trade.limitPrice) };
  const base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  const res = await fetch(`${base}/accounts/${session.accountId}/orders`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.token}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  });
  return res.json();
}

async function closePosition(pos, session) {
  const base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  const body = { class:'option', symbol:pos.symbol?.slice(0,6)?.trim(), option_symbol:pos.symbol, side:'sell_to_close', quantity:String(Math.abs(pos.quantity||1)), type:'market', duration:'day' };
  const res = await fetch(`${base}/accounts/${session.accountId}/orders`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.token}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  });
  return res.json();
}

async function getPositions(session) {
  const base = session.isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  const res = await fetch(`${base}/accounts/${session.accountId}/positions`, {
    headers: { 'Authorization': `Bearer ${session.token}`, 'Accept': 'application/json' }
  });
  const data = await res.json();
  const raw = data?.positions?.position;
  return raw ? (Array.isArray(raw) ? raw : [raw]) : [];
}

// ── ENGINE ─────────────────────────────────────────────────────────────────────
let engineTimer = null;
let monitorTimer = null;

async function runEngine() {
  const engineOn = await getState('engineOn', false);
  if (!engineOn) return;

  const settings  = await getState('settings', { profitTarget:1.00, stopLoss:0.10, dailyMax:500, maxPositions:3, contracts:1, schedule:'5min' });
  const session   = await getState('session', null);
  const watchlist = await getState('watchlist', ['AAPL','SPY','NVDA','TSLA','QQQ']);
  const dailyLoss = await getState('dailyLoss', 0);
  const killSwitch = await getState('killSwitch', false);

  if (!session) { await addLog('skip', 'No session — engine waiting for connection'); return; }
  if (killSwitch) { await addLog('stop', 'Kill switch active — skipping scan'); return; }
  if (dailyLoss >= settings.dailyMax) { await addLog('stop', `Daily loss limit $${settings.dailyMax} reached`); await setState('engineOn', false); return; }

  // Check open positions
  let positions = [];
  try { positions = await getPositions(session); } catch(e) { await addLog('stop', `Position fetch failed: ${e.message}`); return; }
  if (positions.length >= settings.maxPositions) { await addLog('skip', `Max positions (${settings.maxPositions}) reached`); return; }

  await addLog('entry', `🔍 Parallel scan: ${watchlist.join(', ')}`);

  // Scan all tickers in parallel
  const results = await Promise.all(watchlist.map(t => scanTicker(t, settings)));

  for (const r of results) {
    if (r.signal !== 'NONE' && r.confidence === 'HIGH') {
      await addLog('trade', `✅ ${r.ticker}: ${r.signal} @ $${r.premium} — ${r.reason}`);
    } else {
      await addLog('skip', `⏭ ${r.ticker}: ${r.confidence} — ${r.reason}`);
    }
  }

  const signals = results.filter(r => r.signal !== 'NONE' && r.confidence === 'HIGH');
  if (signals.length > 0) {
    const best = signals.sort((a,b) => (b.premium||0)-(a.premium||0))[0];
    await addLog('trade', `🏆 Best: ${best.ticker} ${best.signal} — placing order`);
    const trade = { action:'BUY', type:best.signal.includes('CALL')?'CALL':'PUT', ticker:best.ticker, strike:best.strike, expiry:best.expiry, contracts:settings.contracts, limitPrice:best.premium };
    try {
      const result = await placeTrade(trade, session);
      const orderId = result?.order?.id;
      await addLog('trade', `🚀 ORDER PLACED: ${best.ticker} ${trade.type} $${best.strike} @ $${best.premium} ID:${orderId}`);
      await addTrade({ ...trade, orderId, result:'open' });
    } catch(e) { await addLog('stop', `❌ Order failed: ${e.message}`); }
  } else {
    await addLog('skip', `💤 No HIGH confidence signals found`);
  }
}

async function runMonitor() {
  const engineOn  = await getState('engineOn', false);
  const killSwitch = await getState('killSwitch', false);
  const session   = await getState('session', null);
  const settings  = await getState('settings', { profitTarget:1.00, stopLoss:0.10 });
  if (!engineOn || killSwitch || !session) return;

  try {
    const positions = await getPositions(session);
    let dailyLoss = await getState('dailyLoss', 0);
    let changed = false;
    for (const pos of positions) {
      if (!pos.cost_basis || !pos.market_value) continue;
      const pnlPerContract = (pos.market_value - pos.cost_basis) / Math.abs(pos.quantity||1);
      if (pnlPerContract >= settings.profitTarget) {
        await addLog('trade', `💰 PROFIT TARGET: ${pos.symbol} +$${pnlPerContract.toFixed(2)}/contract — closing`);
        await closePosition(pos, session);
        changed = true;
        // Trigger immediate rescan
        setTimeout(runEngine, 3000);
      } else if (pnlPerContract <= -settings.stopLoss) {
        await addLog('stop', `🛑 STOP-LOSS: ${pos.symbol} -$${Math.abs(pnlPerContract).toFixed(2)}/contract — closing`);
        await closePosition(pos, session);
        dailyLoss += Math.abs(pos.market_value - pos.cost_basis);
        await setState('dailyLoss', dailyLoss);
        changed = true;
        setTimeout(runEngine, 3000);
      }
    }
  } catch(e) { console.error('Monitor error:', e.message); }
}

function startTimers(schedule) {
  clearInterval(engineTimer);
  clearInterval(monitorTimer);
  const ms = {'1min':60000,'2min':120000,'5min':300000,'10min':600000,'15min':900000,'30min':1800000}[schedule]||300000;
  engineTimer  = setInterval(runEngine,  ms);
  monitorTimer = setInterval(runMonitor, 60000); // check profit/stop every 60s
  console.log(`⏱ Engine: every ${schedule} | Monitor: every 60s`);
}

// ── API ROUTES ─────────────────────────────────────────────────────────────────

// Save session (token + account)
app.post('/api/session', async (req, res) => {
  const { token, accountId, isLive, name } = req.body;
  await setState('session', { token, accountId, isLive, name });
  await addLog('entry', `🔌 Session saved: ${accountId} (${isLive?'LIVE':'PAPER'})`);
  res.json({ ok: true });
});

// Save settings + watchlist
app.post('/api/settings', async (req, res) => {
  await setState('settings', req.body.settings);
  await setState('watchlist', req.body.watchlist);
  const s = req.body.settings;
  startTimers(s.schedule);
  await addLog('entry', `⚙️ Settings updated: target $${s.profitTarget} stop $${s.stopLoss}`);
  res.json({ ok: true });
});

// Toggle engine
app.post('/api/engine', async (req, res) => {
  const { on } = req.body;
  await setState('engineOn', on);
  if (on) {
    const s = await getState('settings', { schedule:'5min' });
    startTimers(s.schedule);
    await addLog('entry', '🟢 Engine started (server-side)');
    runEngine();
  } else {
    clearInterval(engineTimer);
    clearInterval(monitorTimer);
    await addLog('entry', '🔴 Engine stopped');
  }
  res.json({ ok: true, engineOn: on });
});

// Kill switch
app.post('/api/killswitch', async (req, res) => {
  const { on } = req.body;
  await setState('killSwitch', on);
  if (on) { clearInterval(engineTimer); clearInterval(monitorTimer); }
  await addLog(on?'stop':'entry', on?'🚨 KILL SWITCH ACTIVATED':'✅ Kill switch deactivated');
  res.json({ ok: true });
});

// Get full dashboard state
app.get('/api/state', async (req, res) => {
  const [engineOn, settings, watchlist, killSwitch, dailyLoss, session] = await Promise.all([
    getState('engineOn', false),
    getState('settings', { profitTarget:1.00, stopLoss:0.10, dailyMax:500, maxPositions:3, contracts:1, schedule:'5min' }),
    getState('watchlist', ['AAPL','SPY','NVDA','TSLA','QQQ']),
    getState('killSwitch', false),
    getState('dailyLoss', 0),
    getState('session', null),
  ]);
  res.json({ engineOn, settings, watchlist, killSwitch, dailyLoss, hasSession: !!session, accountId: session?.accountId, isLive: session?.isLive });
});

// Get logs
app.get('/api/logs', async (req, res) => {
  try {
    const r = await pool.query('SELECT ts,type,message FROM scan_log ORDER BY ts DESC LIMIT 100');
    res.json(r.rows);
  } catch { res.json([]); }
});

// Get trades
app.get('/api/trades', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM trades ORDER BY ts DESC LIMIT 50');
    res.json(r.rows);
  } catch { res.json([]); }
});

// Reset daily loss (called at midnight or manually)
app.post('/api/resetdaily', async (req, res) => {
  await setState('dailyLoss', 0);
  res.json({ ok: true });
});

// Tradier proxy
app.use('/tradier', async (req, res) => {
  const session = await getState('session', null);
  const isLive = session?.isLive || req.headers['x-tradier-live'] === 'true';
  const base = isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  const url = `${base}${req.url}`;
  const token = req.headers['authorization']?.replace('Bearer ','') || session?.token || '';
  try {
    const opts = { method:req.method, headers:{ 'Authorization':`Bearer ${token}`, 'Accept':'application/json', 'Content-Type':'application/x-www-form-urlencoded' } };
    if (req.method !== 'GET') opts.body = new URLSearchParams(req.body).toString();
    const response = await fetch(url, opts);
    const text = await response.text();
    res.status(response.status).set('Content-Type','application/json').send(text);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reset daily loss at midnight ET
function scheduleMidnightReset() {
  const now = new Date();
  const etMidnight = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  etMidnight.setHours(24, 0, 0, 0);
  const ms = etMidnight - now;
  setTimeout(async () => {
    await setState('dailyLoss', 0);
    console.log('🌅 Daily loss reset at midnight ET');
    scheduleMidnightReset();
  }, ms);
}

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

const PORT = process.env.PORT || 3001;
pool.connect()
  .then(() => initDB())
  .then(() => {
    app.listen(PORT, () => console.log(`✅ OptionsAI running on port ${PORT}`));
    scheduleMidnightReset();
    // Resume engine if it was on before restart
    getState('engineOn', false).then(on => {
      if (on) {
        getState('settings', { schedule:'5min' }).then(s => {
          startTimers(s.schedule);
          console.log('🔄 Engine resumed after restart');
          runEngine();
        });
      }
    });
  })
  .catch(e => {
    console.error('DB connection failed:', e.message);
    console.log('Starting without DB...');
    app.listen(PORT, () => console.log(`✅ OptionsAI running on port ${PORT} (no DB)`));
  });

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
    CREATE TABLE IF NOT EXISTS bot_state (id SERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT);
    CREATE TABLE IF NOT EXISTS scan_log (id SERIAL PRIMARY KEY, ts TIMESTAMP DEFAULT NOW(), type TEXT, message TEXT);
    CREATE TABLE IF NOT EXISTS trades (id SERIAL PRIMARY KEY, ts TIMESTAMP DEFAULT NOW(), ticker TEXT, type TEXT, strike NUMERIC, expiry TEXT, contracts INT, premium NUMERIC, order_id TEXT, result TEXT, pnl NUMERIC);
  `);
  console.log('✅ DB initialized');
}

async function getState(key, fallback=null) {
  try { const r=await pool.query('SELECT value FROM bot_state WHERE key=$1',[key]); return r.rows.length?JSON.parse(r.rows[0].value):fallback; } catch { return fallback; }
}
async function setState(key, value) {
  try { await pool.query('INSERT INTO bot_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',[key,JSON.stringify(value)]); } catch(e){console.error('setState:',e.message);}
}
async function addLog(type, message) {
  console.log(`[${type}] ${message}`);
  try { await pool.query('INSERT INTO scan_log(type,message) VALUES($1,$2)',[type,message]); } catch {}
}
async function addTrade(trade) {
  try { await pool.query('INSERT INTO trades(ticker,type,strike,expiry,contracts,premium,order_id,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[trade.ticker,trade.type,trade.strike,trade.expiry,trade.contracts,trade.premium,trade.orderId,trade.result||'open']); } catch(e){console.error('addTrade:',e.message);}
}

// ── MARKET DATA (Polygon.io free tier + Yahoo fallback) ───────────────────────
const POLYGON_KEY = process.env.POLYGON_API_KEY || '';

async function fetchQuote(ticker) {
  // Try Polygon.io first (reliable from servers)
  if (POLYGON_KEY) {
    try {
      const [snapRes, aggRes] = await Promise.all([
        fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${POLYGON_KEY}`),
        fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/5/minute/2024-01-01/${new Date().toISOString().split('T')[0]}?adjusted=true&sort=desc&limit=20&apiKey=${POLYGON_KEY}`)
      ]);
      const snap = await snapRes.json();
      const agg  = await aggRes.json();

      const day   = snap?.ticker?.day;
      const prev  = snap?.ticker?.prevDay;
      const min   = snap?.ticker?.min;
      const price = snap?.ticker?.lastTrade?.p || day?.c || 0;
      const prevClose = prev?.c || price;
      const changePct = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
      const volume = day?.v || 0;
      const avgVol = prev?.v || volume || 1;
      const volumeRatio = volume / avgVol;

      const bars = agg?.results || [];
      const closes = bars.map(b=>b.c).reverse();
      const opens  = bars.map(b=>b.o).reverse();
      const vols   = bars.map(b=>b.v).reverse();

      const lastBarVol = vols[vols.length-1] || 0;
      const avgBarVol  = vols.slice(0,-1).reduce((a,b)=>a+b,0) / Math.max(1, vols.length-1);
      const barVolumeRatio = (avgBarVol > 0 && lastBarVol > 0) ? lastBarVol / avgBarVol : 0;

      const rsi   = calcRSI(closes, 14);
      const ma9   = calcMA(closes, 9);
      const vwap  = min?.av > 0 ? (min?.vw || price) : price;

      let consecutiveBull=0, consecutiveBear=0;
      for(let i=closes.length-1;i>=Math.max(0,closes.length-5);i--){if(closes[i]>opens[i])consecutiveBull++;else break;}
      for(let i=closes.length-1;i>=Math.max(0,closes.length-5);i--){if(closes[i]<opens[i])consecutiveBear++;else break;}

      const last3 = bars.slice(0,3).map(b=>({open:b.o?.toFixed(3),close:b.c?.toFixed(3),bullish:b.c>b.o,vol:b.v}));
      const lastH = bars[0]?.h || price;
      const lastL = bars[0]?.l || price;
      const spreadEstPct = (lastH && lastL && price && lastH > lastL) ? ((lastH - lastL) / price * 100).toFixed(3) : '0.20';

      const etNow = new Date().toLocaleString('en-US',{timeZone:'America/New_York'});
      const etDate = new Date(etNow);
      const minutesIntoDay = (etDate.getHours()-9)*60+etDate.getMinutes()-30;
      const isMarketOpen = minutesIntoDay>=0 && minutesIntoDay<=390;

      console.log(`📊 ${ticker} [Polygon]: $${price} ${changePct.toFixed(2)}% RSI:${rsi?.toFixed(1)} BarVol:${barVolumeRatio.toFixed(1)}x Bull:${consecutiveBull} Bear:${consecutiveBear}`);

      return {
        ticker, price: price?.toFixed(2), changePct: changePct?.toFixed(2),
        volume, volumeRatio: volumeRatio?.toFixed(2), barVolumeRatio: barVolumeRatio?.toFixed(2),
        rsi: rsi?.toFixed(1), ma9: ma9?.toFixed(2), ma20: null, ma50: null,
        vwap: vwap?.toFixed(2), spreadEstPct, last3Candles: last3,
        consecutiveBull, consecutiveBear,
        intradayHigh: day?.h?.toFixed(2)||price, intradayLow: day?.l?.toFixed(2)||price,
        isMarketOpen, minutesIntoDay, marketState: isMarketOpen?'REGULAR':'CLOSED',
        source: 'polygon'
      };
    } catch(e) { console.error(`Polygon error ${ticker}:`, e.message); }
  }

  // Fallback: Yahoo Finance
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=1d`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com/',
      }
    });
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No Yahoo data');

    const meta = result.meta;
    const q = result.indicators?.quote?.[0];
    const closes = q?.close?.filter(v=>v!=null)||[];
    const opens   = q?.open?.filter(v=>v!=null)||[];
    const vols    = q?.volume?.filter(v=>v!=null)||[];
    const highs   = q?.high?.filter(v=>v!=null)||[];
    const lows    = q?.low?.filter(v=>v!=null)||[];

    const price     = meta.regularMarketPrice;
    const prevClose = meta.previousClose||meta.chartPreviousClose||price;
    const changePct = ((price-prevClose)/prevClose*100);
    const volume    = meta.regularMarketVolume||0;
    const avgBarVol = vols.slice(0,-1).reduce((a,b)=>a+b,0)/Math.max(1,vols.length-1);
    const barVolumeRatio = (avgBarVol>0&&vols[vols.length-1]>0)?(vols[vols.length-1]||0)/avgBarVol:0;

    const rsi = calcRSI(closes,14);
    const ma9 = calcMA(closes,9);
    const vwap = calcVWAP(q);

    let consecutiveBull=0,consecutiveBear=0;
    for(let i=closes.length-1;i>=Math.max(0,closes.length-5);i--){if(closes[i]>opens[i])consecutiveBull++;else break;}
    for(let i=closes.length-1;i>=Math.max(0,closes.length-5);i--){if(closes[i]<opens[i])consecutiveBear++;else break;}

    const last3=[];
    for(let i=Math.max(0,closes.length-3);i<closes.length;i++){last3.push({open:opens[i]?.toFixed(3),close:closes[i]?.toFixed(3),bullish:closes[i]>opens[i],vol:vols[i]});}
    const lastH=highs[highs.length-1]||price,lastL=lows[lows.length-1]||price;
    const spreadEstPct=(lastH&&lastL&&price&&lastH>lastL)?((lastH-lastL)/price*100).toFixed(3):'0.20';

    const etNow=new Date().toLocaleString('en-US',{timeZone:'America/New_York'});
    const etDate=new Date(etNow);
    const minutesIntoDay=(etDate.getHours()-9)*60+etDate.getMinutes()-30;
    const isMarketOpen=minutesIntoDay>=0&&minutesIntoDay<=390;

    console.log(`📊 ${ticker} [Yahoo]: $${price} ${changePct.toFixed(2)}% RSI:${rsi?.toFixed(1)} BarVol:${barVolumeRatio.toFixed(1)}x Bull:${consecutiveBull} Bear:${consecutiveBear}`);

    return {
      ticker, price:price?.toFixed(2), changePct:changePct?.toFixed(2),
      volume, volumeRatio:'1.00', barVolumeRatio:barVolumeRatio?.toFixed(2),
      rsi:rsi?.toFixed(1), ma9:ma9?.toFixed(2), ma20:null, ma50:null,
      vwap:vwap?.toFixed(2), spreadEstPct, last3Candles:last3,
      consecutiveBull, consecutiveBear,
      intradayHigh:highs.length?Math.max(...highs).toFixed(2):price,
      intradayLow:lows.length?Math.min(...lows).toFixed(2):price,
      isMarketOpen, minutesIntoDay, marketState:meta.marketState,
      source:'yahoo'
    };
  } catch(e) {
    console.error(`Yahoo fallback ${ticker}:`, e.message);
    return null;
  }
}

app.get('/quote/:ticker', async (req, res) => {
  const d = await fetchQuote(req.params.ticker.toUpperCase());
  if (!d) return res.status(404).json({ error: 'No data available' });
  res.json(d);
});

function calcRSI(closes,period=14){if(closes.length<period+1)return 50;let g=0,l=0;for(let i=closes.length-period;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l+=Math.abs(d);}const ag=g/period,al=l/period;if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcMA(closes,period){if(closes.length<period)return closes[closes.length-1]||0;return closes.slice(-period).reduce((a,b)=>a+b,0)/period;}
function calcVWAP(q){try{const c=q?.close||[],v=q?.volume||[];let sp=0,sv=0;for(let i=0;i<c.length;i++)if(c[i]&&v[i]){sp+=c[i]*v[i];sv+=v[i];}return sv>0?sp/sv:null;}catch{return null;}}

// ── CLAUDE SCAN ────────────────────────────────────────────────────────────────
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const SCAN_PROMPT = `You are OptionsAI, a scalping bot. Use REAL-TIME data to find tradeable options setups.

HIGH confidence CALL (need at least 3 of these 5):
- consecutiveBull >= 2
- barVolumeRatio >= 1.3
- price > vwap
- RSI between 40-70
- changePct > 0.1

HIGH confidence PUT (need at least 3 of these 5):
- consecutiveBear >= 2
- barVolumeRatio >= 1.3
- price < vwap
- RSI between 30-60
- changePct < -0.1

SKIP only if: market closed, RSI>80 or RSI<20, spreadEstPct>1.5

Strike: nearest ATM to current price. Expiry: nearest Friday at least 2 days away.
Premium: estimate 0.5-2% of stock price for ATM options.
Respond ONLY with: <SCAN_RESULT>{"ticker":"X","signal":"BUY_CALL" or "BUY_PUT" or "NONE","confidence":"HIGH" or "MEDIUM" or "LOW","strike":0,"expiry":"YYYY-MM-DD","premium":0.00,"reason":"key stats"}</SCAN_RESULT>`;

async function scanTicker(ticker, settings) {
  const d = await fetchQuote(ticker);
  if (!d) { await addLog('skip', `⏭ ${ticker}: no market data`); return { ticker, signal:'NONE', confidence:'LOW', reason:'no data' }; }
  if (!d.isMarketOpen) { await addLog('skip', `⏭ ${ticker}: market closed`); return { ticker, signal:'NONE', confidence:'LOW', reason:'market closed' }; }

  const rsi    = parseFloat(d.rsi)||50;
  const bvr    = parseFloat(d.barVolumeRatio)||0;
  const spread = parseFloat(d.spreadEstPct)||99;

  if (spread > 1.5)   { await addLog('skip',`⏭ ${ticker}: spread too wide (${spread}%)`); return { ticker, signal:'NONE', confidence:'LOW', reason:`spread ${spread}%`, d }; }
  // Volume pre-filter removed — let Claude decide based on full data
  // Momentum pre-filter removed — let Claude decide
  if (rsi > 80 || rsi < 20) { await addLog('skip',`⏭ ${ticker}: extreme RSI (${rsi})`); return { ticker, signal:'NONE', confidence:'LOW', reason:`RSI ${rsi}`, d }; }

  const candleStr = d.last3Candles?.map(c=>`${c.bullish?'🟢':'🔴'} O:${c.open} C:${c.close}`).join(' | ')||'N/A';
  const dataStr = `${ticker} $${d.price} (${d.changePct}%) | RSI:${d.rsi} | VWAP:$${d.vwap} | MA9:$${d.ma9} | BarVol:${d.barVolumeRatio}x | Spread:${d.spreadEstPct}% | Bull:${d.consecutiveBull} Bear:${d.consecutiveBear} | Candles: ${candleStr} | Source:${d.source}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:CLAUDE_MODEL, max_tokens:200, system:SCAN_PROMPT, messages:[{role:'user',content:`${dataStr}\n\nTarget: $${settings.profitTarget} / Stop: $${settings.stopLoss}. <SCAN_RESULT> only.`}] })
    });
    const data = await res.json();
    const text = data.content?.map(b=>b.text||'').join('')||'';
    const match = text.match(/<SCAN_RESULT>(.*?)<\/SCAN_RESULT>/s);
    if (match) { const r=JSON.parse(match[1]); return {...r,d}; }
  } catch(e) { console.error('Claude scan error:',e.message); }
  return { ticker, signal:'NONE', confidence:'LOW', reason:'claude error', d };
}

// ── TRADE EXECUTION ────────────────────────────────────────────────────────────
function buildOptionSymbol(ticker,expiry,type,strike){
  const dt=new Date(expiry);
  return `${ticker.padEnd(6)}${String(dt.getFullYear()).slice(2)}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}${type[0]}${String(Math.round(strike*1000)).padStart(8,'0')}`;
}
async function tradierReq(path, method, body, session) {
  const base = session.isLive?'https://api.tradier.com/v1':'https://sandbox.tradier.com/v1';
  const opts = { method, headers:{'Authorization':`Bearer ${session.token}`,'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'} };
  if (method!=='GET') opts.body=new URLSearchParams(body).toString();
  const r = await fetch(`${base}${path}`, opts);
  return r.json();
}
async function getPositions(session) {
  const data = await tradierReq(`/accounts/${session.accountId}/positions`,'GET',null,session);
  const raw = data?.positions?.position;
  return raw?(Array.isArray(raw)?raw:[raw]):[];
}
async function placeTrade(trade, session) {
  const sym = buildOptionSymbol(trade.ticker,trade.expiry,trade.type,trade.strike);
  return tradierReq(`/accounts/${session.accountId}/orders`,'POST',{class:'option',symbol:trade.ticker,option_symbol:sym,side:'buy_to_open',quantity:String(trade.contracts),type:'limit',duration:'day',price:String(trade.limitPrice)},session);
}
async function closePosition(pos, session) {
  return tradierReq(`/accounts/${session.accountId}/orders`,'POST',{class:'option',symbol:pos.symbol?.slice(0,6)?.trim(),option_symbol:pos.symbol,side:'sell_to_close',quantity:String(Math.abs(pos.quantity||1)),type:'market',duration:'day'},session);
}

// ── ENGINE ─────────────────────────────────────────────────────────────────────
let engineTimer=null, monitorTimer=null;

async function runEngine() {
  const engineOn  = await getState('engineOn',false);
  if (!engineOn) return;
  const settings  = await getState('settings',{profitTarget:1.00,stopLoss:0.10,dailyMax:500,maxPositions:3,contracts:1,schedule:'5min'});
  const session   = await getState('session',null);
  const watchlist = await getState('watchlist',['AAPL','SPY','NVDA','TSLA','QQQ']);
  const dailyLoss = await getState('dailyLoss',0);
  const killSwitch= await getState('killSwitch',false);

  if (!session)    { await addLog('skip','⏭ No session configured'); return; }
  if (killSwitch)  { await addLog('stop','⛔ Kill switch active'); return; }
  if (dailyLoss >= settings.dailyMax) { await addLog('stop',`🛑 Daily loss limit $${settings.dailyMax} hit`); await setState('engineOn',false); return; }

  let positions=[];
  try { positions=await getPositions(session); } catch(e) { await addLog('stop',`❌ Position fetch failed: ${e.message}`); return; }
  if (positions.length>=settings.maxPositions) { await addLog('skip',`⏭ Max positions (${settings.maxPositions}) reached`); return; }

  await addLog('entry',`🔍 Parallel scan (${watchlist.length} tickers): ${watchlist.join(', ')}`);
  const results = await Promise.all(watchlist.map(t=>scanTicker(t,settings)));

  for(const r of results){
    if(r.signal!=='NONE'&&r.confidence==='HIGH') await addLog('trade',`✅ ${r.ticker}: ${r.signal} @ $${r.premium} — ${r.reason}`);
  }

  const signals=results.filter(r=>r.signal!=='NONE'&&(r.confidence==='HIGH'||r.confidence==='MEDIUM'));
  if(signals.length>0){
    const best=signals.sort((a,b)=>(b.premium||0)-(a.premium||0))[0];
    await addLog('trade',`🏆 Best signal: ${best.ticker} ${best.signal} — placing order`);
    const trade={action:'BUY',type:best.signal.includes('CALL')?'CALL':'PUT',ticker:best.ticker,strike:best.strike,expiry:best.expiry,contracts:settings.contracts,limitPrice:best.premium};
    try {
      const result=await placeTrade(trade,session);
      const orderId=result?.order?.id;
      await addLog('trade',`🚀 ORDER PLACED: ${best.ticker} ${trade.type} $${best.strike} @ $${best.premium} ID:${orderId}`);
      await addTrade({...trade,orderId,result:'open'});
    } catch(e) { await addLog('stop',`❌ Order failed: ${e.message}`); }
  } else {
    await addLog('skip',`💤 No HIGH confidence signals`);
  }
}

async function runMonitor() {
  const engineOn =await getState('engineOn',false);
  const killSwitch=await getState('killSwitch',false);
  const session  =await getState('session',null);
  const settings =await getState('settings',{profitTarget:1.00,stopLoss:0.10});
  if(!engineOn||killSwitch||!session) return;
  try {
    const positions=await getPositions(session);
    let dailyLoss=await getState('dailyLoss',0);
    for(const pos of positions){
      if(!pos.cost_basis||!pos.market_value) continue;
      const pnlPer=(pos.market_value-pos.cost_basis)/Math.abs(pos.quantity||1);
      if(pnlPer>=settings.profitTarget){
        await addLog('trade',`💰 PROFIT TARGET HIT: ${pos.symbol} +$${pnlPer.toFixed(2)}/contract — closing`);
        await closePosition(pos,session);
        setTimeout(runEngine,3000);
      } else if(pnlPer<=-settings.stopLoss){
        await addLog('stop',`🛑 STOP-LOSS HIT: ${pos.symbol} -$${Math.abs(pnlPer).toFixed(2)}/contract — closing`);
        await closePosition(pos,session);
        dailyLoss+=Math.abs(pos.market_value-pos.cost_basis);
        await setState('dailyLoss',dailyLoss);
        setTimeout(runEngine,3000);
      }
    }
  } catch(e) { console.error('Monitor error:',e.message); }
}

function startTimers(schedule) {
  clearInterval(engineTimer); clearInterval(monitorTimer);
  const ms={'1min':60000,'2min':120000,'5min':300000,'10min':600000,'15min':900000,'30min':1800000}[schedule]||300000;
  engineTimer  = setInterval(runEngine,ms);
  monitorTimer = setInterval(runMonitor,60000);
  console.log(`⏱ Engine every ${schedule} | Monitor every 60s`);
}

// ── API ROUTES ─────────────────────────────────────────────────────────────────
app.post('/api/session', async(req,res)=>{ await setState('session',req.body); await addLog('entry',`🔌 Session: ${req.body.accountId} (${req.body.isLive?'LIVE':'PAPER'})`); res.json({ok:true}); });

// Server-side token verification — avoids CORS on mobile
app.post('/api/connect', async(req,res)=>{
  const { token, mode } = req.body;
  if (!token) return res.status(400).json({ error: 'No token provided' });
  const isLive = mode === 'live';
  const base = isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  try {
    const r = await fetch(`${base}/user/profile`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    if (!r.ok) return res.status(401).json({ error: 'Invalid token or connection failed.' });
    const data = await r.json();
    const accountId = data.profile?.account?.account_number || data.profile?.accounts?.account?.[0]?.account_number;
    const name = data.profile?.name || 'Trader';
    const session = { token, accountId, isLive, name };
    await setState('session', session);
    await addLog('entry', `🔌 Connected: ${accountId} (${isLive?'LIVE':'PAPER'})`);
    res.json({ ok: true, accountId, name, isLive });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/settings', async(req,res)=>{ await setState('settings',req.body.settings); await setState('watchlist',req.body.watchlist); startTimers(req.body.settings.schedule); await addLog('entry',`⚙️ Settings: target $${req.body.settings.profitTarget} stop $${req.body.settings.stopLoss}`); res.json({ok:true}); });
app.post('/api/engine', async(req,res)=>{ const{on}=req.body; await setState('engineOn',on); if(on){const s=await getState('settings',{schedule:'5min'});startTimers(s.schedule);await addLog('entry','🟢 Engine started');runEngine();}else{clearInterval(engineTimer);clearInterval(monitorTimer);await addLog('entry','🔴 Engine stopped');}res.json({ok:true,engineOn:on}); });
app.post('/api/killswitch', async(req,res)=>{ const{on}=req.body; await setState('killSwitch',on); if(on){clearInterval(engineTimer);clearInterval(monitorTimer);}await addLog(on?'stop':'entry',on?'🚨 KILL SWITCH ON':'✅ Kill switch off'); res.json({ok:true}); });
app.get('/api/state', async(req,res)=>{ const[engineOn,settings,watchlist,killSwitch,dailyLoss,session]=await Promise.all([getState('engineOn',false),getState('settings',{profitTarget:1.00,stopLoss:0.10,dailyMax:500,maxPositions:3,contracts:1,schedule:'5min'}),getState('watchlist',['AAPL','SPY','NVDA','TSLA','QQQ']),getState('killSwitch',false),getState('dailyLoss',0),getState('session',null)]); res.json({engineOn,settings,watchlist,killSwitch,dailyLoss,hasSession:!!session,accountId:session?.accountId,isLive:session?.isLive}); });
app.get('/api/logs', async(req,res)=>{ try{const r=await pool.query('SELECT ts,type,message FROM scan_log ORDER BY ts DESC LIMIT 100');res.json(r.rows);}catch{res.json([]);} });
app.get('/api/trades', async(req,res)=>{ try{const r=await pool.query('SELECT * FROM trades ORDER BY ts DESC LIMIT 50');res.json(r.rows);}catch{res.json([]);} });
app.post('/api/resetdaily', async(req,res)=>{ await setState('dailyLoss',0); res.json({ok:true}); });

// Tradier proxy
app.use('/tradier', async(req,res)=>{ const session=await getState('session',null); const isLive=session?.isLive||req.headers['x-tradier-live']==='true'; const base=isLive?'https://api.tradier.com/v1':'https://sandbox.tradier.com/v1'; const token=req.headers['authorization']?.replace('Bearer ','')||session?.token||''; try{const opts={method:req.method,headers:{'Authorization':`Bearer ${token}`,'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'}};if(req.method!=='GET')opts.body=new URLSearchParams(req.body).toString();const response=await fetch(`${base}${req.url}`,opts);const text=await response.text();res.status(response.status).set('Content-Type','application/json').send(text);}catch(e){res.status(500).json({error:e.message});} });

function scheduleMidnightReset(){ const now=new Date(); const et=new Date(now.toLocaleString('en-US',{timeZone:'America/New_York'})); et.setHours(24,0,0,0); setTimeout(async()=>{await setState('dailyLoss',0);console.log('🌅 Daily reset');scheduleMidnightReset();},et-now); }

app.get('/',(req,res)=>res.sendFile(__dirname+'/public/index.html'));

const PORT=process.env.PORT||3001;
pool.connect()
  .then(()=>initDB())
  .then(()=>{
    app.listen(PORT,()=>console.log(`✅ OptionsAI on port ${PORT}`));
    scheduleMidnightReset();
    getState('engineOn',false).then(on=>{if(on){getState('settings',{schedule:'5min'}).then(s=>{startTimers(s.schedule);console.log('🔄 Engine resumed');runEngine();});}});
  })
  .catch(e=>{console.error('DB failed:',e.message);app.listen(PORT,()=>console.log(`✅ OptionsAI on port ${PORT} (no DB)`));});

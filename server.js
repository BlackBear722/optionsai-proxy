const express = require('express');
const fetch = require('node-fetch');
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

// ── YAHOO FINANCE QUOTE + INDICATORS ──────────────────────────────────────────
app.get('/quote/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const [intraRes, dailyRes] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=6mo`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    ]);

    const intraData = await intraRes.json();
    const dailyData = await dailyRes.json();

    const intra = intraData?.chart?.result?.[0];
    const daily = dailyData?.chart?.result?.[0];
    if (!intra) return res.status(404).json({ error: 'Ticker not found' });

    const meta = intra.meta;
    const q5 = intra.indicators?.quote?.[0];
    const qD = daily?.indicators?.quote?.[0];

    const closes5m = q5?.close?.filter(v => v != null) || [];
    const volumes5m = q5?.volume?.filter(v => v != null) || [];
    const highs5m   = q5?.high?.filter(v => v != null)  || [];
    const lows5m    = q5?.low?.filter(v => v != null)   || [];
    const opens5m   = q5?.open?.filter(v => v != null)  || [];
    const dailyCloses = qD?.close?.filter(v => v != null) || [];
    const dailyVols   = qD?.volume?.filter(v => v != null) || [];

    const price     = meta.regularMarketPrice;
    const prevClose = meta.previousClose || meta.chartPreviousClose;
    const change    = price - prevClose;
    const changePct = (change / prevClose) * 100;
    const volume    = meta.regularMarketVolume;

    // Average daily volume (20-day)
    const avgDailyVol = dailyVols.length >= 5
      ? dailyVols.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, dailyVols.length)
      : volume;
    const volumeRatio = volume / avgDailyVol;

    // Intraday volume ratio vs avg 5m bar
    const avg5mVol = volumes5m.length > 1
      ? volumes5m.slice(0,-1).reduce((a,b)=>a+b,0) / (volumes5m.length-1)
      : volumes5m[0] || 1;
    const lastBarVol = volumes5m[volumes5m.length-1] || 0;
    const barVolumeRatio = lastBarVol / avg5mVol;

    // RSI 14 on daily
    const rsi = calcRSI(dailyCloses, 14);

    // Moving averages
    const ma9  = calcMA(closes5m, 9);   // fast intraday MA
    const ma20 = calcMA(dailyCloses, 20);
    const ma50 = calcMA(dailyCloses, 50);

    // VWAP intraday
    const vwap = calcVWAP(q5);

    // Last 3 x 5m candles — for consecutive candle check
    const last3Candles = [];
    const len = Math.min(closes5m.length, opens5m.length, 3);
    for (let i = closes5m.length - len; i < closes5m.length; i++) {
      last3Candles.push({
        open:  opens5m[i]?.toFixed(3),
        close: closes5m[i]?.toFixed(3),
        high:  highs5m[i]?.toFixed(3),
        low:   lows5m[i]?.toFixed(3),
        bullish: closes5m[i] > opens5m[i],
        vol: volumes5m[i]
      });
    }

    // Bid/ask spread estimate from last bar high-low range
    const lastHigh = highs5m[highs5m.length-1] || price;
    const lastLow  = lows5m[lows5m.length-1]  || price;
    const spreadEst = ((lastHigh - lastLow) / price * 100).toFixed(3);

    // Consecutive candle direction
    let consecutiveBull = 0, consecutiveBear = 0;
    for (let i = closes5m.length-1; i >= Math.max(0, closes5m.length-5); i--) {
      if (closes5m[i] > opens5m[i]) consecutiveBull++;
      else break;
    }
    for (let i = closes5m.length-1; i >= Math.max(0, closes5m.length-5); i--) {
      if (closes5m[i] < opens5m[i]) consecutiveBear++;
      else break;
    }

    // Market hours check (ET)
    const etHour = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
    const etMin  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' });
    const marketHour = parseInt(etHour);
    const marketMin  = parseInt(etMin);
    const minutesIntoDay = (marketHour - 9) * 60 + marketMin - 30;
    const inPrimeWindow = minutesIntoDay >= 0 && minutesIntoDay <= 120; // first 2 hours

    console.log(`📊 ${ticker}: $${price} RSI:${rsi?.toFixed(1)} Vol:${volumeRatio.toFixed(1)}x BarVol:${barVolumeRatio.toFixed(1)}x Bull:${consecutiveBull} Bear:${consecutiveBear}`);

    res.json({
      ticker, price: price?.toFixed(2), change: change?.toFixed(2),
      changePct: changePct?.toFixed(2), volume, avgDailyVol: Math.round(avgDailyVol),
      volumeRatio: volumeRatio?.toFixed(2), barVolumeRatio: barVolumeRatio?.toFixed(2),
      rsi: rsi?.toFixed(1), ma9: ma9?.toFixed(2), ma20: ma20?.toFixed(2), ma50: ma50?.toFixed(2),
      vwap: vwap?.toFixed(2), spreadEstPct: spreadEst,
      last3Candles, consecutiveBull, consecutiveBear,
      intradayHigh: Math.max(...highs5m).toFixed(2),
      intradayLow: Math.min(...lows5m).toFixed(2),
      inPrimeWindow, minutesIntoDay,
      marketState: meta.marketState,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh?.toFixed(2),
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow?.toFixed(2),
    });
  } catch (e) {
    console.error(`Quote error ${ticker}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

function calcRSI(closes, period=14) {
  if (closes.length < period+1) return null;
  let gains=0, losses=0;
  for (let i=closes.length-period; i<closes.length; i++) {
    const d=closes[i]-closes[i-1];
    if(d>0) gains+=d; else losses+=Math.abs(d);
  }
  const ag=gains/period, al=losses/period;
  if(al===0) return 100;
  return 100-(100/(1+ag/al));
}

function calcMA(closes, period) {
  if(closes.length<period) return null;
  return closes.slice(-period).reduce((a,b)=>a+b,0)/period;
}

function calcVWAP(q) {
  try {
    const c=q?.close||[], v=q?.volume||[];
    let sp=0,sv=0;
    for(let i=0;i<c.length;i++) if(c[i]&&v[i]){sp+=c[i]*v[i];sv+=v[i];}
    return sv>0?sp/sv:null;
  } catch{return null;}
}

// ── TRADIER PROXY ──────────────────────────────────────────────────────────────
app.use('/tradier', async (req, res) => {
  const isLive = req.headers['x-tradier-live'] === 'true';
  const base = isLive ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  const url = `${base}${req.url}`;
  console.log(`→ ${req.method} ${url}`);
  try {
    const opts = { method: req.method, headers: { 'Authorization': req.headers['authorization']||'', 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } };
    if(req.method!=='GET') opts.body=new URLSearchParams(req.body).toString();
    const response = await fetch(url, opts);
    const text = await response.text();
    console.log(`← ${response.status}: ${text.slice(0,120)}`);
    res.status(response.status).set('Content-Type','application/json').send(text);
  } catch(e) {
    console.error('Error:',e.message);
    res.status(500).json({error:e.message});
  }
});

app.get('/', (req, res) => res.sendFile(__dirname+'/public/index.html'));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));

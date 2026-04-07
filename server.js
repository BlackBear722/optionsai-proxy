const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — allow everything
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.use('/tradier', async (req, res) => {
  const isLive = req.headers['x-tradier-live'] === 'true';
  const base = isLive
    ? 'https://api.tradier.com/v1'
    : 'https://sandbox.tradier.com/v1';

  const url = `${base}${req.url}`;
  console.log(`→ ${req.method} ${url}`);

  try {
    const opts = {
      method: req.method,
      headers: {
        'Authorization': req.headers['authorization'] || '',
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };
    if (req.method !== 'GET') {
      opts.body = new URLSearchParams(req.body).toString();
    }
    const response = await fetch(url, opts);
    const text = await response.text();
    console.log(`← ${response.status}: ${text.slice(0, 120)}`);
    res.status(response.status).set('Content-Type', 'application/json').send(text);
  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('OptionsAI proxy is running ✅'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));

const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Handle CORS manually for all requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-tradier-live, ngrok-skip-browser-warning');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
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
    const fetchOptions = {
      method: req.method,
      headers: {
        'Authorization': req.headers['authorization'] || '',
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };

    if (req.method !== 'GET') {
      fetchOptions.body = new URLSearchParams(req.body).toString();
    }

    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    console.log(`← ${response.status}: ${text.slice(0, 100)}`);

    res.status(response.status).set('Content-Type', 'application/json').send(text);
  } catch (e) {
    console.error('Proxy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('OptionsAI proxy is running ✅'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ OptionsAI proxy running on port ${PORT}`));

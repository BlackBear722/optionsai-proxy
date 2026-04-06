const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.listen(3001, () => console.log('✅ OptionsAI proxy running at http://localhost:3001'));

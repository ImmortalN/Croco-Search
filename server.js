require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// ─────────────────────────────
// 📊 СТАТУС СИНХРОНИЗАЦИИ
// ─────────────────────────────
let syncStatus = {
  loading: false,
  progress: 'Не запускалась'
};

// ─────────────────────────────
// 🗄️ БАЗА
// ─────────────────────────────
const db = new sqlite3.Database('./intercom.db');

db.serialize(() => {
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS articles USING fts5(
      id UNINDEXED,
      title,
      body,
      url UNINDEXED,
      tokenize='porter unicode61'
    )
  `);
});

// ─────────────────────────────
// 🔵 INTERNAL
// ─────────────────────────────
async function loadInternalArticles() {
  const headers = {
    'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
    'Accept': 'application/json',
    'Intercom-Version': 'Unstable'
  };

  let all = [];
  let page = 1;
  let total = 1;

  while (page <= total) {
    syncStatus.progress = `Internal: страница ${page}`;

    const res = await fetch(`https://api.intercom.io/internal_articles?page=${page}&per_page=150`, { headers });
    const data = await res.json();

    const items = data.data || [];

    items.forEach(a => {
      all.push({
        id: `int_${a.id}`,
        title: a.title || '',
        body: (a.body || '').replace(/<[^>]+>/g, ' '),
        url: `https://app.intercom.com/a/apps/${process.env.INTERCOM_WORKSPACE_ID}/articles/articles/${a.id}/show`
      });
    });

    total = data.pages?.total_pages || 1;
    if (items.length < 150) break;

    page++;
  }

  return all;
}

// ─────────────────────────────
// 🌍 PUBLIC
// ─────────────────────────────
async function loadPublicArticles() {
  const headers = {
    'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
    'Accept': 'application/json',
    'Intercom-Version': '2.11'
  };

  let all = [];
  let page = 1;
  let total = 1;

  while (page <= total) {
    syncStatus.progress = `Public: страница ${page}`;

    const res = await fetch(`https://api.intercom.io/articles?page=${page}&per_page=150`, { headers });
    const data = await res.json();

    const items = data.data || [];

    items.forEach(a => {
      all.push({
        id: `pub_${a.id}`,
        title: a.title || '',
        body: (a.body || '').replace(/<[^>]+>/g, ' '),
        url: a.url || '#'
      });
    });

    total = data.pages?.total_pages || 1;
    if (items.length < 150) break;

    page++;
  }

  return all;
}

// ─────────────────────────────
// 🔗 EXTERNAL
// ─────────────────────────────
async function loadExternalPages() {
  const headers = {
    'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
    'Accept': 'application/json',
    'Intercom-Version': '2.14'
  };

  let all = [];
  let page = 1;
  let total = 1;

  while (page <= total) {
    syncStatus.progress = `External: страница ${page}`;

    const res = await fetch(`https://api.intercom.io/external_pages?page=${page}&per_page=150`, { headers });
    const data = await res.json();

    const items = data.data || [];

    items.forEach(p => {
      all.push({
        id: `ext_${p.id}`,
        title: p.title || '',
        body: (p.body || '').replace(/<[^>]+>/g, ' '),
        url: p.url || '#'
      });
    });

    total = data.pages?.total_pages || 1;
    if (items.length < 150) break;

    page++;
  }

  return all;
}

// ─────────────────────────────
// 🔄 SYNC
// ─────────────────────────────
app.get('/sync', async (req, res) => {
  if (syncStatus.loading) {
    return res.send('Уже идет синхронизация');
  }

  syncStatus.loading = true;
  syncStatus.progress = 'Старт...';

  try {
    const [internal, pub, ext] = await Promise.all([
      loadInternalArticles(),
      loadPublicArticles(),
      loadExternalPages()
    ]);

    const all = [...internal, ...pub, ...ext];

    syncStatus.progress = 'Сохранение...';

    db.serialize(() => {
      db.run('DELETE FROM articles');

      const stmt = db.prepare('INSERT INTO articles VALUES (?, ?, ?, ?)');

      all.forEach(a => {
        stmt.run(a.id, a.title, a.body, a.url);
      });

      stmt.finalize();
    });

    syncStatus.loading = false;
    syncStatus.progress = 'Готово';

    res.send('OK');

  } catch (e) {
    syncStatus.loading = false;
    syncStatus.progress = 'Ошибка';
    res.status(500).send(e.message);
  }
});

// ─────────────────────────────
// 📡 СТАТУС
// ─────────────────────────────
app.get('/sync-status', (req, res) => {
  res.json(syncStatus);
});

// ─────────────────────────────
// 🔍 ПОИСК
// ─────────────────────────────
app.post('/ask', (req, res) => {
  if (syncStatus.loading) {
    return res.json({ answer: '⏳ Подождите, идет синхронизация' });
  }

  const q = (req.body.question || '').trim();

  const query = q.split(/\s+/).map(w => w + '*').join(' ');

  db.all(
    `SELECT title, url, body FROM articles WHERE articles MATCH ? LIMIT 15`,
    [query],
    (err, rows) => {
      if (err) return res.json({ answer: 'Ошибка поиска' });

      let html = '';

      rows.forEach(r => {
        html += `
          <div style="margin:10px;padding:10px;background:#f5f5f5">
            <a href="${r.url}" target="_blank"><b>${r.title}</b></a>
            <div>${(r.body || '').slice(0, 120)}...</div>
          </div>
        `;
      });

      if (!rows.length) html = 'Ничего не найдено';

      res.json({ answer: html });
    }
  );
});

// ─────────────────────────────
// 🔐 LOGIN
// ─────────────────────────────
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (
    username === process.env.APP_LOGIN &&
    password === process.env.APP_PASSWORD
  ) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// ─────────────────────────────
app.listen(PORT, () => {
  console.log('🚀 Сервер запущен:', PORT);
});

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// ─── СТАТУС СИНХРОНИЗАЦИИ ─────────────────────────────────────
let syncStatus = {
  loading: false,
  progress: 'Не запускалась',
  percent: 0
};

// ─── БАЗА ДАННЫХ ──────────────────────────────────────────────
const db = new sqlite3.Database('./intercom.db');

db.serialize(() => {
  // Добавляем колонку source, чтобы отличать типы гайдов
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS articles USING fts5(
      id UNINDEXED,
      title,
      body,
      url UNINDEXED,
      source UNINDEXED,
      tokenize='porter unicode61'
    )
  `);
});

// ─── 1. INTERNAL ARTICLES ─────────────────────────────────────
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
    syncStatus.progress = `Загрузка Internal: страница ${page}`;
    // Вес этапа: 0-33%
    syncStatus.percent = Math.round((page / (total || 1)) * 33);

    const res = await fetch(`https://api.intercom.io/internal_articles?page=${page}&per_page=150`, { headers });
    const data = await res.json();
    const items = data.data || [];

    items.forEach(a => {
      all.push({
        id: `int_${a.id}`,
        title: a.title || '',
        body: (a.body || '').replace(/<[^>]+>/g, ' '),
        url: `https://app.intercom.com/a/apps/${process.env.INTERCOM_WORKSPACE_ID}/articles/articles/${a.id}/show`,
        source: 'internal'
      });
    });

    total = data.pages?.total_pages || 1;
    if (items.length < 150) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }
  return all;
}

// ─── 2. PUBLIC ARTICLES ───────────────────────────────────────
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
    syncStatus.progress = `Загрузка Public: страница ${page}`;
    // Вес этапа: 34-66%
    syncStatus.percent = 33 + Math.round((page / (total || 1)) * 33);

    const res = await fetch(`https://api.intercom.io/articles?page=${page}&per_page=150`, { headers });
    const data = await res.json();
    const items = data.data || [];

    items.forEach(a => {
      all.push({
        id: `pub_${a.id}`,
        title: a.title || '',
        body: (a.body || '').replace(/<[^>]+>/g, ' '),
        url: a.url || '#',
        source: 'public'
      });
    });

    total = data.pages?.total_pages || 1;
    if (items.length < 150) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }
  return all;
}

// ─── 3. EXTERNAL PAGES (СИНХРОНИЗИРОВАННЫЕ) ───────────────────
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
    syncStatus.progress = `Загрузка External: страница ${page}`;
    // Вес этапа: 67-95%
    syncStatus.percent = 66 + Math.round((page / (total || 1)) * 29);

    const res = await fetch(`https://api.intercom.io/external_pages?page=${page}&per_page=150`, { headers });
    const data = await res.json();
    const items = data.data || [];

    items.forEach(p => {
      all.push({
        id: `ext_${p.id}`,
        title: p.title || '',
        body: (p.body || '').replace(/<[^>]+>/g, ' '),
        url: p.url || '#',
        source: 'external'
      });
    });

    total = data.pages?.total_pages || 1;
    if (items.length < 150) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }
  return all;
}

// ─── СИНХРОНИЗАЦИЯ (ОБЪЕДИНЕНИЕ) ───────────────────────────────
app.get('/sync', async (req, res) => {
  if (syncStatus.loading) return res.send('Уже идет синхронизация');
  syncStatus.loading = true;
  syncStatus.percent = 0;
  syncStatus.progress = 'Старт...';

  try {
    const internal = await loadInternalArticles();
    const pub = await loadPublicArticles();
    const ext = await loadExternalPages();

    const all = [...internal, ...pub, ...ext];
    syncStatus.progress = 'Сохранение в базу...';
    syncStatus.percent = 98;

    db.serialize(() => {
      db.run('DELETE FROM articles');
      const stmt = db.prepare('INSERT INTO articles VALUES (?, ?, ?, ?, ?)');
      all.forEach(a => {
        stmt.run(a.id, a.title, a.body, a.url, a.source);
      });
      stmt.finalize();
    });

    syncStatus.loading = false;
    syncStatus.percent = 100;
    syncStatus.progress = 'Готово';
    res.send('OK');
  } catch (e) {
    console.error('Ошибка синхронизации:', e.message);
    syncStatus.loading = false;
    syncStatus.progress = 'Ошибка';
    res.status(500).send(e.message);
  }
});

app.get('/sync-status', (req, res) => res.json(syncStatus));

// ─── ПОИСК ────────────────────────────────────────────────────
app.post('/ask', (req, res) => {
  const q = (req.body.question || '').trim();
  if (!q) return res.json({ answer: 'Введите запрос' });

  // Формируем запрос для SQLite FTS5 (добавляем звездочку к каждому слову)
  const query = q.split(/\s+/).filter(w => w.length > 0).map(w => w + '*').join(' ');

  db.all(
    `SELECT title, url, body, source FROM articles WHERE articles MATCH ? LIMIT 20`,
    [query],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.json({ answer: 'Ошибка поиска' });
      }
      // Отправляем массив данных на фронтенд для красивой отрисовки
      res.json({ results: rows });
    }
  );
});

// ─── ЛОГИН ────────────────────────────────────────────────────
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.listen(PORT, () => console.log('🚀 Сервер запущен на порту ' + PORT));

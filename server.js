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
  progress: 'Ожидание запуска...',
  percent: 0
};

// ─── БАЗА ДАННЫХ ──────────────────────────────────────────────
const db = new sqlite3.Database('./intercom.db');

db.serialize(() => {
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
  const headers = { 'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`, 'Accept': 'application/json', 'Intercom-Version': 'Unstable' };
  let all = [], page = 1, total = 1;
  while (page <= total) {
    syncStatus.progress = `Загрузка Internal: стр ${page}`;
    syncStatus.percent = Math.round((page / (total || 1)) * 30);
    try {
      const res = await fetch(`https://api.intercom.io/internal_articles?page=${page}&per_page=150`, { headers });
      const data = await res.json();
      const items = data.data || [];
      items.forEach(a => all.push({ id: `int_${a.id}`, title: a.title || '', body: (a.body || '').replace(/<[^>]+>/g, ' '), url: `https://app.intercom.com/a/apps/${process.env.INTERCOM_WORKSPACE_ID}/articles/articles/${a.id}/show`, source: 'internal' }));
      total = data.pages?.total_pages || 1;
      if (items.length < 150) break;
      page++;
    } catch (e) { break; }
  }
  return all;
}

// ─── 2. PUBLIC ARTICLES ───────────────────────────────────────
async function loadPublicArticles() {
  const headers = { 'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`, 'Accept': 'application/json', 'Intercom-Version': '2.11' };
  let all = [], page = 1, total = 1;
  while (page <= total) {
    syncStatus.progress = `Загрузка Public: стр ${page}`;
    syncStatus.percent = 30 + Math.round((page / (total || 1)) * 40);
    try {
      const res = await fetch(`https://api.intercom.io/articles?page=${page}&per_page=150`, { headers });
      const data = await res.json();
      const items = data.data || [];
      items.forEach(a => all.push({ id: `pub_${a.id}`, title: a.title || '', body: (a.body || '').replace(/<[^>]+>/g, ' '), url: a.url || '#', source: 'public' }));
      total = data.pages?.total_pages || 1;
      if (items.length < 150) break;
      page++;
    } catch (e) { break; }
  }
  return all;
}

// ─── 3. EXTERNAL PAGES (СИНХРОНИЗИРОВАННЫЕ ГАЙДЫ) ─────────────
async function loadExternalPages() {
  const headers = { 'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`, 'Accept': 'application/json', 'Intercom-Version': '2.14' };
  let all = [], page = 1, total = 1;
  while (page <= total) {
    syncStatus.progress = `Загрузка External: стр ${page}`;
    syncStatus.percent = 70 + Math.round((page / (total || 1)) * 25);
    try {
      const res = await fetch(`https://api.intercom.io/external_pages?page=${page}&per_page=150`, { headers });
      const data = await res.json();
      const items = data.data || [];
      items.forEach(p => all.push({ id: `ext_${p.id}`, title: p.title || '', body: (p.body || '').replace(/<[^>]+>/g, ' '), url: p.url || '#', source: 'external' }));
      total = data.pages?.total_pages || 1;
      if (items.length < 150) break;
      page++;
    } catch (e) { break; }
  }
  return all;
}

// ─── ФУНКЦИЯ ЗАПУСКА СИНХРОНИЗАЦИИ ────────────────────────────
async function runFullSync() {
  if (syncStatus.loading) return;
  syncStatus.loading = true;
  syncStatus.percent = 0;
  try {
    const [internal, pub, ext] = await Promise.all([
      loadInternalArticles(),
      loadPublicArticles(),
      loadExternalPages()
    ]);
    const all = [...internal, ...pub, ...ext];
    db.serialize(() => {
      db.run('DELETE FROM articles');
      const stmt = db.prepare('INSERT INTO articles VALUES (?, ?, ?, ?, ?)');
      all.forEach(a => stmt.run(a.id, a.title, a.body, a.url, a.source));
      stmt.finalize();
    });
    syncStatus.percent = 100;
    syncStatus.progress = 'Готово';
  } catch (e) {
    syncStatus.progress = 'Ошибка';
  } finally {
    syncStatus.loading = false;
  }
}

app.get('/sync', async (req, res) => {
  runFullSync(); // Запуск в фоне
  res.send('Синхронизация запущена');
});

app.get('/sync-status', (req, res) => res.json(syncStatus));

app.post('/ask', (req, res) => {
  const q = (req.body.question || '').trim();
  if (!q) return res.json({ results: [] });
  const query = q.split(/\s+/).filter(w => w.length > 0).map(w => w + '*').join(' ');
  db.all(`SELECT title, url, body, source FROM articles WHERE articles MATCH ? LIMIT 20`, [query], (err, rows) => {
    if (err) return res.json({ results: [] });
    res.json({ results: rows });
  });
});

app.post('/login', (req, res) => {
  if (req.body.username === process.env.APP_LOGIN && req.body.password === process.env.APP_PASSWORD) {
    res.json({ success: true });
  } else res.json({ success: false });
});

app.listen(PORT, () => {
  console.log('🚀 Сервер запущен');
  runFullSync(); // АВТОМАТИЧЕСКИЙ ЗАПУСК ПРИ СТАРТЕ
});

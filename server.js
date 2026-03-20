require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

let syncStatus = {
  loading: false,
  progress: 'Ожидание...',
  percent: 0
};

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

// Вспомогательная функция для запросов
async function intercomFetch(path, version) {
  const url = `https://api.intercom.io/${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
      'Accept': 'application/json',
      'Intercom-Version': version
    }
  });
  if (!res.ok) throw new Error(`Intercom error: ${res.status}`);
  return res.json();
}

async function runFullSync() {
  if (syncStatus.loading) return;
  syncStatus.loading = true;
  syncStatus.percent = 5;
  syncStatus.progress = 'Начало синхронизации...';

  try {
    let allData = [];

    // 1. Internal Articles
    syncStatus.progress = 'Загрузка Internal...';
    const internalRes = await intercomFetch('internal_articles?per_page=150', 'Unstable');
    (internalRes.data || []).forEach(a => {
      allData.push({
        id: `int_${a.id}`,
        title: a.title || '',
        body: (a.body || '').replace(/<[^>]+>/g, ' '),
        url: `https://app.intercom.com/a/apps/${process.env.INTERCOM_WORKSPACE_ID}/articles/articles/${a.id}/show`,
        source: 'internal'
      });
    });
    syncStatus.percent = 30;

    // 2. Public Articles
    syncStatus.progress = 'Загрузка Public...';
    const publicRes = await intercomFetch('articles?per_page=150', '2.11');
    (publicRes.data || []).forEach(a => {
      allData.push({ id: `pub_${a.id}`, title: a.title || '', body: (a.body || '').replace(/<[^>]+>/g, ' '), url: a.url || '#', source: 'public' });
    });
    syncStatus.percent = 60;

    // 3. AI External Pages (ИСПРАВЛЕННЫЙ ЭНДПОИНТ)
    syncStatus.progress = 'Загрузка Website Guides...';
    const externalRes = await intercomFetch('ai/external_pages?per_page=150', '2.14');
    (externalRes.data || []).forEach(p => {
      allData.push({ id: `ext_${p.id}`, title: p.title || '', body: (p.body || '').replace(/<[^>]+>/g, ' '), url: p.url || '#', source: 'external' });
    });

    // Сохранение
    syncStatus.progress = 'Сохранение в базу...';
    db.serialize(() => {
      db.run('DELETE FROM articles');
      const stmt = db.prepare('INSERT INTO articles VALUES (?, ?, ?, ?, ?)');
      allData.forEach(a => stmt.run(a.id, a.title, a.body, a.url, a.source));
      stmt.finalize();
    });

    syncStatus.percent = 100;
    syncStatus.progress = 'Готово';
  } catch (e) {
    console.error(e);
    syncStatus.progress = 'Ошибка: ' + e.message;
  } finally {
    syncStatus.loading = false;
  }
}

app.get('/sync', (req, res) => {
  runFullSync();
  res.json({ message: 'Started' });
});

app.get('/sync-status', (req, res) => res.json(syncStatus));

app.post('/ask', (req, res) => {
  const q = (req.body.question || '').trim();
  if (!q) return res.json({ results: [] });
  const query = q.split(/\s+/).map(w => w + '*').join(' ');
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
  console.log(`Server running on ${PORT}`);
  runFullSync(); 
});

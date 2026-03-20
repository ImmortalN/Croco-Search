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

// Создаем базу с 5 колонками (включая source для фильтрации)
const db = new sqlite3.Database('./intercom.db');

db.serialize(() => {
  db.run("DROP TABLE IF EXISTS articles"); // Пересоздаем, чтобы колонки точно совпали
  db.run(`
    CREATE VIRTUAL TABLE articles USING fts5(
      id UNINDEXED,
      title,
      body,
      url UNINDEXED,
      source UNINDEXED,
      tokenize='porter unicode61'
    )
  `);
});

// --- ФУНКЦИИ ЗАГРУЗКИ С ПАГИНАЦИЕЙ ---

async function loadInternal() {
  const headers = { 'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`, 'Accept': 'application/json', 'Intercom-Version': 'Unstable' };
  let all = [], page = 1, total = 1;
  while (page <= total) {
    syncStatus.progress = `Загрузка Internal: стр ${page}`;
    const res = await fetch(`https://api.intercom.io/internal_articles?page=${page}&per_page=150`, { headers });
    const data = await res.json();
    const items = data.data || [];
    items.forEach(a => all.push({
      id: `int_${a.id}`,
      title: a.title || '',
      body: (a.body || '').replace(/<[^>]+>/g, ' '),
      url: `https://app.intercom.com/a/apps/${process.env.INTERCOM_WORKSPACE_ID}/articles/articles/${a.id}/show`,
      source: 'internal'
    }));
    total = data.pages?.total_pages || 1;
    if (items.length < 150) break;
    page++;
  }
  return all;
}

async function loadPublic() {
  const headers = { 'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`, 'Accept': 'application/json', 'Intercom-Version': '2.11' };
  let all = [], page = 1, total = 1;
  while (page <= total) {
    syncStatus.progress = `Загрузка Public: стр ${page}`;
    const res = await fetch(`https://api.intercom.io/articles?page=${page}&per_page=150`, { headers });
    const data = await res.json();
    const items = data.data || [];
    items.forEach(a => all.push({
      id: `pub_${a.id}`,
      title: a.title || '',
      body: (a.body || '').replace(/<[^>]+>/g, ' '),
      url: a.url || '#',
      source: 'public'
    }));
    total = data.pages?.total_pages || 1;
    if (items.length < 150) break;
    page++;
  }
  return all;
}

async function loadExternal() {
  const headers = { 'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`, 'Accept': 'application/json', 'Intercom-Version': '2.14' };
  let all = [], page = 1, total = 1;
  while (page <= total) {
    syncStatus.progress = `Загрузка Website Guides: стр ${page}`;
    // ИСПОЛЬЗУЕМ AI/EXTERNAL_PAGES как советовал Интерком
    const res = await fetch(`https://api.intercom.io/ai/external_pages?page=${page}&per_page=150`, { headers });
    const data = await res.json();
    const items = data.data || [];
    items.forEach(p => all.push({
      id: `ext_${p.id}`,
      title: p.title || '',
      body: (p.body || '').replace(/<[^>]+>/g, ' '),
      url: p.url || '#',
      source: 'external'
    }));
    total = data.pages?.total_pages || 1;
    if (items.length < 150) break;
    page++;
  }
  return all;
}

async function runFullSync() {
  if (syncStatus.loading) return;
  syncStatus.loading = true;
  syncStatus.percent = 5;
  
  try {
    const internal = await loadInternal();
    syncStatus.percent = 35;
    
    const publicArticles = await loadPublic();
    syncStatus.percent = 65;
    
    const external = await loadExternal();
    syncStatus.percent = 90;

    const all = [...internal, ...publicArticles, ...external];
    
    syncStatus.progress = 'Сохранение...';
    db.serialize(() => {
      db.run('DELETE FROM articles');
      const stmt = db.prepare('INSERT INTO articles VALUES (?, ?, ?, ?, ?)');
      all.forEach(a => stmt.run(a.id, a.title, a.body, a.url, a.source));
      stmt.finalize();
    });

    syncStatus.percent = 100;
    syncStatus.progress = 'Готово';
    console.log(`✅ Синхронизировано: ${all.length} статей`);
  } catch (e) {
    console.error('Ошибка:', e);
    syncStatus.progress = 'Ошибка: ' + e.message;
  } finally {
    syncStatus.loading = false;
  }
}

// Эндпоинты
app.get('/sync', (req, res) => {
  runFullSync();
  res.json({ status: 'started' });
});

app.get('/sync-status', (req, res) => res.json(syncStatus));

app.post('/ask', (req, res) => {
  const q = (req.body.question || '').trim();
  if (!q) return res.json({ results: [] });
  
  const query = q.split(/\s+/).filter(w => w.length > 0).map(w => w + '*').join(' ');
  
  db.all(`SELECT title, url, body, source FROM articles WHERE articles MATCH ? LIMIT 20`, [query], (err, rows) => {
    if (err) {
      console.error('Search error:', err);
      return res.json({ results: [] });
    }
    res.json({ results: rows });
  });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  runFullSync(); // Автозапуск при старте
});

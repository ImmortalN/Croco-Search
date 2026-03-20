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
  progress: 'Waiting...',
  percent: 0
};

const db = new sqlite3.Database('./intercom.db');

db.serialize(() => {
  db.run("DROP TABLE IF EXISTS articles");
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

// Фильтр для картинок
function isImage(item) {
  const extensions = ['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg'];
  const text = (item.title + item.url).toLowerCase();
  return extensions.some(ext => text.endsWith(ext));
}

async function loadType(path, version, sourceName, weightStart, weightMax) {
  let all = [], page = 1, total = 1;
  const headers = { 
    'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`, 
    'Accept': 'application/json', 
    'Intercom-Version': version 
  };

  while (page <= total) {
    syncStatus.progress = `Loading ${sourceName}: page ${page}`;
    syncStatus.percent = weightStart + Math.round((page / (total || 1)) * weightMax);

    try {
      const res = await fetch(`https://api.intercom.io/${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=150`, { headers });
      const data = await res.json();
      const items = data.data || [];

      items.forEach(item => {
        // Пропускаем, если это картинка
        if (isImage(item)) return;

        let url = item.url || '#';
        if (sourceName === 'Internal') {
          url = `https://app.intercom.com/a/apps/${process.env.INTERCOM_WORKSPACE_ID}/articles/articles/${item.id}/show`;
        }

        all.push({
          id: `${sourceName.toLowerCase()}_${item.id}`,
          title: item.title || '',
          body: (item.body || '').replace(/<[^>]+>/g, ' ').substring(0, 10000), // Ограничим размер текста для скорости
          url: url,
          source: sourceName.toLowerCase()
        });
      });

      total = data.pages?.total_pages || 1;
      if (items.length < 150) break;
      page++;
    } catch (e) { 
      console.error(`Error loading ${sourceName}:`, e.message);
      break; 
    }
  }
  return all;
}

async function runFullSync() {
  if (syncStatus.loading) return;
  syncStatus.loading = true;
  
  try {
    // Запускаем параллельно для скорости
    const [internal, publicA, external] = await Promise.all([
      loadType('internal_articles', 'Unstable', 'Internal', 0, 30),
      loadType('articles', '2.11', 'Public', 30, 30),
      loadType('ai/external_pages', '2.14', 'External', 60, 30)
    ]);

    const all = [...internal, ...publicA, ...external];
    
    syncStatus.progress = 'Saving to Database...';
    db.serialize(() => {
      db.run('DELETE FROM articles');
      const stmt = db.prepare('INSERT INTO articles VALUES (?, ?, ?, ?, ?)');
      all.forEach(a => stmt.run(a.id, a.title, a.body, a.url, a.source));
      stmt.finalize();
    });

    syncStatus.percent = 100;
    syncStatus.progress = 'Done';
    console.log(`Successfully synced: ${all.length} items`);
  } catch (e) {
    syncStatus.progress = 'Error occurred';
  } finally {
    syncStatus.loading = false;
  }
}

app.get('/sync', (req, res) => { runFullSync(); res.json({status: 'started'}); });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on port ${PORT}`);
  runFullSync();
});

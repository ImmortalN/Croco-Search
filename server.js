require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// ─── SQLite ─────────────────────────────────────────────
const db = new sqlite3.Database('./intercom.db', (err) => {
  if (err) {
    console.error('❌ SQLite ошибка:', err.message);
  } else {
    console.log('✅ SQLite подключен');
  }
});

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

// ───────────────────────────────────────────────────────
// 🔵 INTERNAL ARTICLES
// ───────────────────────────────────────────────────────
async function loadInternalArticles() {
  const token = process.env.INTERCOM_TOKEN;
  const workspace = process.env.INTERCOM_WORKSPACE_ID || 'rn7ho5ox';

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Intercom-Version': 'Unstable'
  };

  let allArticles = [];
  let page = 1;
  let totalPages = 1;

  console.log('🔵 Загрузка INTERNAL статей');

  while (page <= totalPages) {
    const url = `https://api.intercom.io/internal_articles?page=${page}&per_page=150`;

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();
      const pageArticles = data.data || [];

      console.log(`INTERNAL стр ${page}: ${pageArticles.length}`);

      pageArticles.forEach(a => {
        allArticles.push({
          id: `int_${a.id}`,
          title: a.title || '(без заголовка)',
          body: (a.body || '').replace(/<[^>]+>/g, ' ').trim(),
          url: `https://app.intercom.com/a/apps/${workspace}/articles/articles/${a.id}/show`
        });
      });

      totalPages = data.pages?.total_pages || 1;

      if (pageArticles.length < 150) break;

      page++;
      await new Promise(r => setTimeout(r, 1200));

    } catch (err) {
      console.error('❌ INTERNAL ошибка:', err.message);
      break;
    }
  }

  console.log(`🔵 INTERNAL всего: ${allArticles.length}`);
  return allArticles;
}

// ───────────────────────────────────────────────────────
// 🌍 PUBLIC ARTICLES (Help Center)
// ───────────────────────────────────────────────────────
async function loadPublicArticles() {
  const token = process.env.INTERCOM_TOKEN;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Intercom-Version': '2.11'
  };

  let allArticles = [];
  let page = 1;
  let totalPages = 1;

  console.log('🌍 Загрузка PUBLIC статей');

  while (page <= totalPages) {
    const url = `https://api.intercom.io/articles?page=${page}&per_page=150`;

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();
      const pageArticles = data.data || [];

      console.log(`PUBLIC стр ${page}: ${pageArticles.length}`);

      pageArticles.forEach(a => {
        allArticles.push({
          id: `pub_${a.id}`,
          title: a.title || '(без заголовка)',
          body: (a.body || '').replace(/<[^>]+>/g, ' ').trim(),
          url: a.url || '#'
        });
      });

      totalPages = data.pages?.total_pages || 1;

      if (pageArticles.length < 150) break;

      page++;
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error('❌ PUBLIC ошибка:', err.message);
      break;
    }
  }

  console.log(`🌍 PUBLIC всего: ${allArticles.length}`);
  return allArticles;
}

// ───────────────────────────────────────────────────────
// 🔄 SYNC
// ───────────────────────────────────────────────────────
app.get('/sync', async (req, res) => {
  try {
    const [internal, publicA] = await Promise.all([
      loadInternalArticles(),
      loadPublicArticles()
    ]);

    const all = [...internal, ...publicA];

    console.log(`📊 ВСЕГО: ${all.length}`);

    db.serialize(() => {
      db.run('DELETE FROM articles');

      const stmt = db.prepare(`
        INSERT INTO articles (id, title, body, url)
        VALUES (?, ?, ?, ?)
      `);

      all.forEach(a => {
        stmt.run(a.id, a.title, a.body, a.url);
      });

      stmt.finalize();
    });

    res.send(`
      <h2 style="color:green">Синхронизация завершена</h2>
      <p>Internal: ${internal.length}</p>
      <p>Public: ${publicA.length}</p>
      <p><b>Всего:</b> ${all.length}</p>
      <a href="/">На главную</a>
    `);

  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// ───────────────────────────────────────────────────────
// 🔍 SEARCH (УЛУЧШЕННЫЙ)
// ───────────────────────────────────────────────────────
async function searchIntercom(query) {
  return new Promise((resolve) => {
    const prepared = query
      .toLowerCase()
      .split(/\s+/)
      .map(w => w + '*')
      .join(' ');

    db.all(
      `SELECT title, url, body
       FROM articles
       WHERE articles MATCH ?
       LIMIT 15`,
      [prepared],
      (err, rows) => {
        if (err) {
          console.error('❌ SEARCH ошибка:', err.message);
          return resolve([]);
        }

        resolve(rows.map(r => ({
          title: r.title,
          url: r.url,
          source: r.url.includes('app.intercom')
            ? 'Intercom (Internal)'
            : 'Intercom (Public)',
          snippet: (r.body || '').slice(0, 140) + '...'
        })));
      }
    );
  });
}

// ───────────────────────────────────────────────────────
// 🎯 ASK
// ───────────────────────────────────────────────────────
app.post('/ask', async (req, res) => {
  const q = (req.body.question || '').trim();

  if (!q) {
    return res.json({ answer: 'Введите вопрос' });
  }

  try {
    const results = await searchIntercom(q);

    let html = `<div style="font-family:sans-serif;">`;

    results.forEach(item => {
      const color = item.source.includes('Internal') ? '#0288d1' : '#43a047';

      html += `
        <div style="margin:10px 0;padding:10px;border-left:4px solid ${color};background:#f9f9f9;">
          <div style="font-size:11px;color:#777;">${item.source}</div>
          <a href="${item.url}" target="_blank">${item.title}</a>
          <div style="font-size:13px;color:#555;">${item.snippet}</div>
        </div>
      `;
    });

    if (!results.length) {
      html += `<p>Ничего не найдено. <a href="/sync">Обновить базу</a></p>`;
    }

    html += `</div>`;

    res.json({ answer: html });

  } catch (err) {
    console.error(err);
    res.json({ answer: 'Ошибка поиска' });
  }
});

// ───────────────────────────────────────────────────────
// 🔐 LOGIN
// ───────────────────────────────────────────────────────
app.post('/login', (req, res) => {
  const { username, password, remember } = req.body;

  if (
    username === process.env.APP_LOGIN &&
    password === process.env.APP_PASSWORD
  ) {
    res.json({ success: true, remember });
  } else {
    res.json({ success: false });
  }
});

// ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Сервер: ${PORT}`);
});

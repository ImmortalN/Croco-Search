require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// ─── SQLite ────────────────────────────────────────────────────────────────
const db = new sqlite3.Database('./intercom.db', (err) => {
  if (err) {
    console.error('❌ Ошибка подключения SQLite:', err.message);
  } else {
    console.log('✅ SQLite база подключена');
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
  `, (err) => {
    if (err) console.error('❌ Ошибка создания таблицы:', err.message);
  });
});

// ─── Полная выгрузка всех internal articles из Intercom ─────────────────────
async function loadAllIntercomArticles() {
  const token = process.env.INTERCOM_TOKEN;
  if (!token) throw new Error('INTERCOM_TOKEN не задан в .env');

  const workspace = process.env.INTERCOM_WORKSPACE_ID || 'rn7ho5ox';
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Intercom-Version': 'Unstable'   // если не работает — попробуйте '2.14'
  };

  let articles = [];
  let startingAfter = null;
  let page = 0;

  console.log('🚀 Начало полной синхронизации Intercom internal articles');

  do {
    page++;
    const params = new URLSearchParams({ per_page: '150' });  // максимум от Intercom
    if (startingAfter) params.append('starting_after', startingAfter);

    const url = `https://api.intercom.io/internal_articles?${params}`;
    console.log(`  Страница ${page} → ${url}`);

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Intercom вернул ${res.status}: ${text}`);
    }

    const data = await res.json();
    const pageItems = data.data || data.articles || [];

    console.log(`    Получено элементов: ${pageItems.length}`);

    pageItems.forEach(item => {
      articles.push({
        id: item.id,
        title: item.title || '(без заголовка)',
        body: (item.body || item.description || '').replace(/<[^>]*>/g, ' ').trim(),
        url: `https://app.intercom.com/a/apps/${workspace}/articles/articles/${item.id}/show`
      });
    });

    // Самый важный момент — правильное получение следующего курсора
    startingAfter = data.pages?.next?.starting_after || null;

  } while (startingAfter !== null);

  console.log(`✅ Всего загружено статей: ${articles.length}`);
  return articles;
}

// ─── Эндпоинт для ручной синхронизации ─────────────────────────────────────
app.get('/sync', async (req, res) => {
  try {
    const articles = await loadAllIntercomArticles();

    // Очистка + вставка
    db.run('DELETE FROM articles');
    const stmt = db.prepare('INSERT INTO articles (id, title, body, url) VALUES (?, ?, ?, ?)');
    articles.forEach(a => stmt.run(a.id, a.title, a.body, a.url));
    stmt.finalize();

    res.send(`
      <h2 style="color:#2e7d32">Готово!</h2>
      <p>Загружено <strong>${articles.length}</strong> статей из Intercom</p>
      <p>Теперь можно искать через форму на главной странице</p>
      <p><a href="/">← На главную</a></p>
    `);
  } catch (err) {
    console.error('Ошибка /sync:', err);
    res.status(500).send(`<h2>Ошибка</h2><pre>${err.message}</pre>`);
  }
});

// ─── Поиск по SQLite ───────────────────────────────────────────────────────
function searchIntercom(question) {
  return new Promise((resolve) => {
    db.all(
      `SELECT title, url, body, rank
       FROM articles
       WHERE articles MATCH ?
       ORDER BY rank LIMIT 15`,
      [question.trim() + '*'],
      (err, rows) => {
        if (err) {
          console.error('SQLite search error:', err);
          return resolve([]);
        }
        resolve(rows.map(r => ({
          title: r.title,
          url: r.url,
          source: 'Intercom',
          snippet: (r.body || '').substring(0, 160) + (r.body.length > 160 ? '…' : '')
        })));
      }
    );
  });
}

// ─── Поиск по ClickUp (строгий фильтр по словам) ────────────────────────────
function matchesQuery(text, query) {
  if (!text || !query) return false;
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const target = text.toLowerCase();
  return words.every(word => target.includes(word));
}

async function searchClickUp(question) {
  if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_TEAM_ID) return [];

  try {
    const url = `https://api.clickup.com/api/v2/team/${process.env.CLICKUP_TEAM_ID}/task?include_closed=true`;
    const res = await fetch(url, {
      headers: { 'Authorization': process.env.CLICKUP_TOKEN }
    });

    if (!res.ok) throw new Error(`ClickUp ${res.status}`);

    const { tasks = [] } = await res.json();

    const matches = tasks
      .filter(t => matchesQuery(t.name, question))
      .slice(0, 10)
      .map(t => ({
        title: t.name,
        url: t.url,
        source: 'ClickUp'
      }));

    return matches;
  } catch (err) {
    console.error('ClickUp ошибка:', err.message);
    return [];
  }
}

// ─── Главный поиск ──────────────────────────────────────────────────────────
app.post('/ask', async (req, res) => {
  const { question } = req.body;
  const q = (question || '').trim();

  if (!q) {
    return res.json({ answer: '<p style="color:#d32f2f">Введите поисковый запрос</p>' });
  }

  try {
    const [intercom, clickup] = await Promise.all([
      searchIntercom(q),
      searchClickUp(q)
    ]);

    let html = `
      <div style="font-family:sans-serif; padding:8px 0;">
        <div style="color:#555; font-size:13px; margin-bottom:12px;">
          Intercom: ${intercom.length} | ClickUp: ${clickup.length}
        </div>`;

    [...intercom, ...clickup].slice(0, 20).forEach(item => {
      const color = item.source === 'Intercom' ? '#0288d1' : '#673ab7';
      html += `
        <div style="margin:10px 0; padding:10px; border-left:4px solid ${color}; background:#fafafa; border-radius:4px;">
          <div style="font-size:11px; color:#777; text-transform:uppercase; margin-bottom:4px;">${item.source}</div>
          <a href="${item.url}" target="_blank" style="color:#0066cc; font-weight:600; text-decoration:none;">${item.title}</a>
          ${item.snippet ? `<div style="margin-top:6px; color:#555; font-size:13px;">${item.snippet}</div>` : ''}
        </div>`;
    });

    if (intercom.length + clickup.length === 0) {
      html += `
        <p style="color:#757575; margin-top:20px;">
          Ничего не найдено по запросу «${q}».<br>
          Попробуйте обновить базу: <a href="/sync" target="_blank" style="color:#d81b60;">/sync</a>
        </p>`;
    }

    html += '</div>';

    res.json({ answer: html });
  } catch (err) {
    console.error('Ошибка в /ask:', err);
    res.json({ answer: '<p style="color:#d32f2f">Произошла ошибка при поиске</p>' });
  }
});

// ─── Логин (без изменений) ──────────────────────────────────────────────────
app.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true, remember });
  } else {
    res.json({ success: false });
  }
});

// ─── Запуск сервера ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`   → Синхронизация:    GET  /sync`);
  console.log(`   → Поиск:            POST /ask`);
});

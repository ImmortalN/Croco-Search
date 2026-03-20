require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Подключаем SQLite (файл создастся автоматически)
const db = new sqlite3.Database('./intercom.db', (err) => {
  if (err) console.error('Ошибка подключения к БД:', err);
  else console.log('SQLite подключена');
});

// Создаём виртуальную таблицу для полнотекстового поиска (один раз)
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

// Функция загрузки всех статей из Intercom
async function loadAllIntercomArticles() {
  const token = process.env.INTERCOM_TOKEN;
  if (!token) throw new Error('Нет INTERCOM_TOKEN');

  const workspace = process.env.INTERCOM_WORKSPACE_ID || 'rn7ho5ox';
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Intercom-Version': 'Unstable'
  };

  let articles = [];
  let startingAfter = null;

  do {
    const params = new URLSearchParams({ per_page: '50' });
    if (startingAfter) params.append('starting_after', startingAfter);

    const url = `https://api.intercom.io/internal_articles?${params}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Intercom ошибка: ${res.status}`);

    const data = await res.json();
    const pageArticles = data.data || [];

    pageArticles.forEach(a => {
      articles.push({
        id: a.id,
        title: a.title || '(без заголовка)',
        body: (a.body || a.description || '').replace(/<[^>]*>/g, ' ').trim(),
        url: `https://app.intercom.com/a/apps/${workspace}/articles/articles/${a.id}/show`
      });
    });

    startingAfter = data.pages?.next?.starting_after || null;
  } while (startingAfter);

  return articles;
}

// Обновление базы (вызывается по /sync)
app.get('/sync', async (req, res) => {
  try {
    console.log('Запуск синхронизации Intercom...');
    const articles = await loadAllIntercomArticles();

    // Очищаем и заполняем заново
    db.run('DELETE FROM articles');
    const stmt = db.prepare('INSERT INTO articles (id, title, body, url) VALUES (?, ?, ?, ?)');
    articles.forEach(a => stmt.run(a.id, a.title, a.body, a.url));
    stmt.finalize();

    res.send(`Готово! Загружено ${articles.length} статей.<br><a href="/">На главную</a>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка синхронизации: ' + err.message);
  }
});

// Поиск по базе
async function searchIntercom(question) {
  return new Promise((resolve) => {
    db.all(
      `SELECT title, url, body, rank
       FROM articles 
       WHERE articles MATCH ?
       ORDER BY rank LIMIT 12`,
      [question.trim() + '*'],
      (err, rows) => {
        if (err) {
          console.error(err);
          return resolve([]);
        }
        resolve(rows.map(row => ({
          title: row.title,
          url: row.url,
          source: 'Intercom',
          snippet: row.body.substring(0, 120) + (row.body.length > 120 ? '...' : '')
        })));
      }
    );
  });
}

// Твоя старая функция ClickUp (можно улучшить позже)
async function searchClickUp(question) {
  if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_TEAM_ID) return [];

  try {
    const res = await fetch(
      `https://api.clickup.com/api/v2/team/${process.env.CLICKUP_TEAM_ID}/task?include_closed=true`,
      { headers: { 'Authorization': process.env.CLICKUP_TOKEN } }
    );
    const data = await res.json();
    if (!data.tasks) return [];

    const matches = data.tasks
      .filter(t => t.name.toLowerCase().includes(question.toLowerCase()))
      .slice(0, 6)
      .map(t => ({ title: t.name, url: t.url, source: 'ClickUp' }));

    return matches;
  } catch (e) {
    console.error('ClickUp ошибка:', e);
    return [];
  }
}

// Главный поиск
app.post('/ask', async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) return res.json({ answer: 'Введите вопрос' });

  const intercomResults = await searchIntercom(question);
  const clickupResults = await searchClickUp(question);

  let html = `<div style="margin-bottom:10px; color:#666;">
    Intercom: ${intercomResults.length} | ClickUp: ${clickupResults.length}
  </div>`;

  [...intercomResults, ...clickupResults].forEach(r => {
    html += `
      <div style="margin:10px 0; padding:8px; border-left:4px solid ${r.source === 'Intercom' ? '#00c2ff' : '#7b68ee'};">
        <small style="color:#888; font-weight:bold;">${r.source}</small><br>
        <a href="${r.url}" target="_blank" style="color:#0066cc; font-weight:500;">${r.title}</a>
        ${r.snippet ? `<div style="margin-top:4px; font-size:0.9em; color:#555;">${r.snippet}</div>` : ''}
      </div>`;
  });

  if (intercomResults.length + clickupResults.length === 0) {
    html += `<p style="color:#e00;">Ничего не найдено. Попробуй <a href="/sync" target="_blank">обновить базу Intercom</a></p>`;
  }

  res.json({ answer: html });
});

// Старый логин оставляем
app.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true, remember });
  } else {
    res.json({ success: false });
  }
});

app.listen(PORT, () => console.log(`Сервер запущен на ${PORT}`));

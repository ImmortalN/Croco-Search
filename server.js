require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// ====================== SQLITE ======================
const db = new sqlite3.Database('./intercom.db', (err) => {
  if (err) console.error('❌ SQLite error:', err);
  else console.log('✅ SQLite база создана/подключена');
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

// ====================== ЗАГРУЗКА ВСЕХ СТАТЕЙ ИЗ INTERCOM (исправленная пагинация) ======================
async function loadAllIntercomArticles() {
  const token = process.env.INTERCOM_TOKEN;
  if (!token) throw new Error('❌ Нет INTERCOM_TOKEN в .env');

  const workspace = process.env.INTERCOM_WORKSPACE_ID || 'rn7ho5ox';
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Intercom-Version': 'Unstable'   // попробуй потом сменить на '2.14', если не будет работать
  };

  let allArticles = [];
  let startingAfter = null;
  let page = 0;

  console.log('🚀 Начинаю полную выгрузку internal_articles...');

  do {
    page++;
    const params = new URLSearchParams({ per_page: '50' });
    if (startingAfter) params.append('starting_after', startingAfter);

    const url = `https://api.intercom.io/internal_articles?${params}`;
    console.log(`📄 Запрос страницы ${page}: ${url}`);

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Intercom ${res.status}: ${errText}`);
    }

    const data = await res.json();

    const pageArticles = data.data || data.articles || [];
    console.log(`   → Получено на странице: ${pageArticles.length}`);

    pageArticles.forEach(a => {
      allArticles.push({
        id: a.id,
        title: a.title || '(без заголовка)',
        body: (a.body || a.description || '').replace(/<[^>]+>/g, ' ').trim(),
        url: `https://app.intercom.com/a/apps/${workspace}/articles/articles/${a.id}/show`
      });
    });

    // Правильный курсор
    startingAfter = data.pages?.next?.starting_after ||
                    data.pages?.next?.href ? null :   // fallback
                    null;

    if (startingAfter) {
      console.log(`   → Следующий курсор получен → продолжаем`);
    } else {
      console.log(`   → Это последняя страница`);
    }

  } while (startingAfter);

  console.log(`🎉 ВСЕГО ЗАГРУЖЕНО СТАТЕЙ: ${allArticles.length}`);
  return allArticles;
}

// ====================== СИНХРОНИЗАЦИЯ ======================
app.get('/sync', async (req, res) => {
  try {
    const articles = await loadAllIntercomArticles();

    // Очищаем и вставляем заново
    db.run('DELETE FROM articles');
    const stmt = db.prepare('INSERT INTO articles (id, title, body, url) VALUES (?, ?, ?, ?)');
    articles.forEach(a => stmt.run(a.id, a.title, a.body, a.url));
    stmt.finalize();

    res.send(`
      <h2>✅ Готово!</h2>
      <p>Загружено <strong>${articles.length}</strong> статей из Intercom</p>
      <p>Теперь можешь искать через /ask</p>
      <a href="/">← На главную</a>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Ошибка: ' + err.message);
  }
});

// ====================== ПОИСК ПО БАЗЕ ======================
async function searchIntercom(q) {
  return new Promise((resolve) => {
    db.all(
      `SELECT title, url, body,
       rank FROM articles 
       WHERE articles MATCH ? 
       ORDER BY rank LIMIT 15`,
      [q.trim() + '*'],
      (err, rows) => {
        if (err || !rows) return resolve([]);
        resolve(rows.map(r => ({
          title: r.title,
          url: r.url,
          source: 'Intercom',
          snippet: (r.body || '').substring(0, 140) + '...'
        })));
      }
    );
  });
}

// ====================== CLICKUP (твой старый фильтр) ======================
function matchesQuery(text, query) {
  if (!text || !query) return false;
  const words = query.toLowerCase().split(' ').filter(w => w.length > 1);
  return words.every(word => text.toLowerCase().includes(word));
}

async function searchClickUp(q) {
  if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_TEAM_ID) return [];
  try {
    const url = `https://api.clickup.com/api/v2/team/${process.env.CLICKUP_TEAM_ID}/task?include_closed=true`;
    const res = await fetch(url, { headers: { 'Authorization': process.env.CLICKUP_TOKEN } });
    const data = await res.json();

    const matches = (data.tasks || []).filter(t => matchesQuery(t.name, q)).slice(0, 8);

    return matches.map(t => ({
      title: t.name,
      url: t.url,
      source: 'ClickUp'
    }));
  } catch (e) {
    console.error('ClickUp error:', e);
    return [];
  }
}

// ====================== ГЛАВНЫЙ ПОИСК ======================
app.post('/ask', async (req, res) => {
  const { question } = req.body;
  const q = (question || '').trim();
  if (!q) return res.json({ answer: 'Введите вопрос' });

  const [intercom, clickup] = await Promise.all([
    searchIntercom(q),
    searchClickUp(q)
  ]);

  let html = `<div style="font-family:sans-serif; font-size:14px;">
    <div style="color:#666; margin-bottom:10px;">
      ✅ Intercom: ${intercom.length} | ClickUp: ${clickup.length}
    </div>`;

  [...intercom, ...clickup].slice(0, 20).forEach(item => {
    const color = item.source === 'Intercom' ? '#00c2ff' : '#7b68ee';
    html += `
      <div style="margin:12px 0; padding-left:12px; border-left:4px solid ${color};">
        <span style="font-size:11px; font-weight:bold; color:${color};">${item.source}</span><br>
        <a href="${item.url}" target="_blank" style="color:#0066ff; font-weight:600;">${item.title}</a>
        ${item.snippet ? `<div style="color:#555; font-size:13px; margin-top:3px;">${item.snippet}</div>` : ''}
      </div>`;
  });

  if (intercom.length + clickup.length === 0) {
    html += `<p>Ничего не найдено.<br>
             Попробуй нажать <a href="/sync" target="_blank">/sync</a> (обновить базу)</p>`;
  }

  html += '</div>';
  res.json({ answer: html });
});

// ====================== ЛОГИН (оставляем) ======================
app.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true, remember });
  } else {
    res.json({ success: false });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`   → Обновить базу: https://твой-сайт.onrender.com/sync`);
  console.log(`   → Поиск: POST /ask`);
});

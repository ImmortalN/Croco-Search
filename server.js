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

// ─── Полная выгрузка всех internal articles (page-based, как в Python-примере) ─
async function loadAllIntercomArticles() {
  const token = process.env.INTERCOM_TOKEN;
  if (!token) throw new Error('INTERCOM_TOKEN не задан в .env');

  const workspace = process.env.INTERCOM_WORKSPACE_ID || 'rn7ho5ox';
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Intercom-Version': 'Unstable'   // можно сменить на '2.14' если не работает
  };

  let allArticles = [];
  let page = 1;
  let totalPages = 1; // начальное значение, обновится после первого запроса

  console.log('🚀 Запуск полной синхронизации Intercom internal_articles (page-based)');

  while (page <= totalPages) {
    const params = new URLSearchParams({
      page: page.toString(),
      per_page: '150'  // максимум
    });

    const url = `https://api.intercom.io/internal_articles?${params.toString()}`;
    console.log(`📄 Страница ${page}/${totalPages} → ${url}`);

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Intercom ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const pageArticles = data.data || data.articles || data.internal_articles || [];

      console.log(`   Получено на странице: ${pageArticles.length} статей`);

      pageArticles.forEach(a => {
        allArticles.push({
          id: a.id,
          title: a.title || '(без заголовка)',
          body: (a.body || a.description || '').replace(/<[^>]+>/g, ' ').trim(),
          url: `https://app.intercom.com/a/apps/${workspace}/articles/articles/${a.id}/show`
        });
      });

      // Обновляем total_pages из ответа (самое важное!)
      const pages = data.pages || {};
      totalPages = pages.total_pages || pages.totalPages || 1;

      console.log(`   total_pages из ответа: ${totalPages}`);

      // Защита от зацикливания
      if (pageArticles.length === 0 || pageArticles.length < 150) {
        console.log('   Получено 0 или <150 статей → завершаем цикл');
        break;
      }

      page++;
      await new Promise(r => setTimeout(r, 1500)); // пауза 1.5 сек между страницами

    } catch (err) {
      console.error(`   Ошибка на странице ${page}: ${err.message}`);
      break;
    }
  }

  console.log(`🎉 Синхронизация завершена. Всего статей: ${allArticles.length}`);
  return allArticles;
}

// ─── Синхронизация ──────────────────────────────────────────────────────────
app.get('/sync', async (req, res) => {
  try {
    const articles = await loadAllIntercomArticles();

    db.run('DELETE FROM articles', (err) => {
      if (err) console.error('DELETE ошибка:', err.message);
    });

    const stmt = db.prepare('INSERT INTO articles (id, title, body, url) VALUES (?, ?, ?, ?)');
    articles.forEach(a => stmt.run(a.id, a.title, a.body, a.url));
    stmt.finalize((err) => {
      if (err) console.error('INSERT finalize ошибка:', err.message);
    });

    res.send(`
      <h2 style="color:green">Готово!</h2>
      <p>Загружено <strong>${articles.length}</strong> статей из Intercom</p>
      <p>Теперь поиск работает на главной странице.</p>
      <a href="/">← На главную</a>
    `);
  } catch (err) {
    console.error('Ошибка /sync:', err.message);
    res.status(500).send(`
      <h2 style="color:red">Ошибка</h2>
      <pre>${err.message}</pre>
      <p>Проверьте логи Render и .env (INTERCOM_TOKEN и т.д.)</p>
      <a href="/">← На главную</a>
    `);
  }
});

// ─── Поиск по SQLite ────────────────────────────────────────────────────────
async function searchIntercom(question) {
  return new Promise((resolve) => {
    db.all(
      `SELECT title, url, body, rank
       FROM articles
       WHERE articles MATCH ?
       ORDER BY rank LIMIT 15`,
      [question.trim() + '*'],
      (err, rows) => {
        if (err) {
          console.error('SQLite ошибка поиска:', err.message);
          return resolve([]);
        }
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

// ─── ClickUp ────────────────────────────────────────────────────────────────
function matchesQuery(text, query) {
  if (!text || !query) return false;
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  return words.every(word => text.toLowerCase().includes(word));
}

async function searchClickUp(question) {
  if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_TEAM_ID) return [];
  try {
    const url = `https://api.clickup.com/api/v2/team/${process.env.CLICKUP_TEAM_ID}/task?include_closed=true`;
    const res = await fetch(url, { headers: { 'Authorization': process.env.CLICKUP_TOKEN } });
    if (!res.ok) throw new Error(`ClickUp ${res.status}`);
    const { tasks = [] } = await res.json();
    const matches = tasks.filter(t => matchesQuery(t.name, question)).slice(0, 10);
    return matches.map(t => ({
      title: t.name,
      url: t.url,
      source: 'ClickUp'
    }));
  } catch (err) {
    console.error('ClickUp ошибка:', err.message);
    return [];
  }
}

// ─── Главный поиск ──────────────────────────────────────────────────────────
app.post('/ask', async (req, res) => {
  const { question } = req.body;
  const q = (question || '').trim();
  if (!q) return res.json({ answer: '<p style="color:#d32f2f">Введите вопрос</p>' });

  try {
    const [intercom, clickup] = await Promise.all([
      searchIntercom(q),
      searchClickUp(q)
    ]);

    let html = `
      <div style="font-family:sans-serif; padding:10px;">
        <div style="color:#555; margin-bottom:12px; font-size:14px;">
          Intercom: ${intercom.length} | ClickUp: ${clickup.length}
        </div>`;

    [...intercom, ...clickup].slice(0, 20).forEach(item => {
      const color = item.source === 'Intercom' ? '#0288d1' : '#673ab7';
      html += `
        <div style="margin:12px 0; padding:12px; border-left:4px solid ${color}; background:#f9f9f9; border-radius:6px;">
          <div style="font-size:11px; color:#777; text-transform:uppercase; margin-bottom:6px;">${item.source}</div>
          <a href="${item.url}" target="_blank" style="color:#0066cc; font-weight:600; text-decoration:none;">${item.title}</a>
          ${item.snippet ? `<div style="margin-top:6px; color:#555; font-size:13px;">${item.snippet}</div>` : ''}
        </div>`;
    });

    if (intercom.length + clickup.length === 0) {
      html += `<p style="color:#757575;">Ничего не найдено. Попробуйте <a href="/sync" target="_blank">обновить базу</a>.</p>`;
    }

    html += '</div>';
    res.json({ answer: html });
  } catch (err) {
    console.error('Ошибка /ask:', err.message);
    res.json({ answer: '<p style="color:#d32f2f">Ошибка при поиске. Проверьте логи Render.</p>' });
  }
});

// ─── Логин ──────────────────────────────────────────────────────────────────
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
  console.log(`   → Обновить базу: GET /sync`);
  console.log(`   → Поиск: POST /ask`);
});

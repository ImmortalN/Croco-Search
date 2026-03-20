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
    if (err) console.error('❌ Ошибка создания таблицы FTS5:', err.message);
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
    'Intercom-Version': 'Unstable'   // если не работает — попробуй сменить на '2.14'
  };

  let allArticles = [];
  let startingAfter = null;
  let page = 0;
  let hasMore = true;

  console.log('🚀 Запуск полной синхронизации Intercom internal_articles');

  while (hasMore) {
    page++;
    const params = new URLSearchParams({ per_page: '150' });
    if (startingAfter) params.append('starting_after', startingAfter);

    const url = `https://api.intercom.io/internal_articles?${params.toString()}`;
    console.log(`📄 Страница ${page} → ${url}`);

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

      // Проверка на следующую страницу
      const next = data.pages?.next;
      if (next && next.starting_after) {
        startingAfter = next.starting_after;
        console.log(`   → Есть следующая (starting_after = ${startingAfter.substring(0, 30)}...)`);
        await new Promise(r => setTimeout(r, 2000)); // 2 секунды паузы
      } else {
        console.log('   → Нет следующей страницы (pages.next или starting_after отсутствует)');
        hasMore = false;
      }

      // Защита: если пришло меньше максимума — вероятно конец
      if (pageArticles.length < 150) {
        console.log('   → Получено <150 → завершаем');
        hasMore = false;
      }

    } catch (err) {
      console.error(`   Ошибка на странице ${page}: ${err.message}`);
      hasMore = false;
    }
  }

  console.log(`🎉 Синхронизация завершена. Всего статей: ${allArticles.length}`);
  return allArticles;
}

// ─── Эндпоинт синхронизации (теперь всегда показывает результат или ошибку) ─
app.get('/sync', async (req, res) => {
  try {
    const articles = await loadAllIntercomArticles();

    // Очистка + вставка
    db.run('DELETE FROM articles', (err) => {
      if (err) console.error('DELETE error:', err);
    });

    const stmt = db.prepare('INSERT INTO articles (id, title, body, url) VALUES (?, ?, ?, ?)');
    articles.forEach(a => stmt.run(a.id, a.title, a.body, a.url));
    stmt.finalize((err) => {
      if (err) console.error('INSERT finalize error:', err);
    });

    res.send(`
      <h2 style="color: green;">Готово!</h2>
      <p>Загружено <strong>${articles.length}</strong> статей из Intercom</p>
      <p>Поиск теперь работает через главную страницу.</p>
      <p><a href="/">← На главную</a></p>
    `);
  } catch (err) {
    console.error('Ошибка в /sync:', err.message);
    res.status(500).send(`
      <h2 style="color: red;">Ошибка синхронизации</h2>
      <pre>${err.message}</pre>
      <p>Проверьте логи Render и переменные в .env (INTERCOM_TOKEN и т.д.)</p>
      <a href="/">← На главную</a>
    `);
  }
});

// ─── ПОИСК ПО SQLITE (это было пропущено!) ────────────────────────────────
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
          console.error('SQLite search error:', err.message);
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

// ─── CLICKUP ────────────────────────────────────────────────────────────────
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

// ─── ГЛАВНЫЙ ПОИСК ──────────────────────────────────────────────────────────
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
      <div style="font-family:sans-serif; padding:8px;">
        <div style="color:#555; margin-bottom:12px;">
          Intercom: ${intercom.length} | ClickUp: ${clickup.length}
        </div>`;

    [...intercom, ...clickup].slice(0, 20).forEach(item => {
      const color = item.source === 'Intercom' ? '#0288d1' : '#673ab7';
      html += `
        <div style="margin:10px 0; padding:10px; border-left:4px solid ${color}; background:#fafafa; border-radius:4px;">
          <div style="font-size:11px; color:#777; text-transform:uppercase;">${item.source}</div>
          <a href="${item.url}" target="_blank" style="color:#0066cc; font-weight:600;">${item.title}</a>
          ${item.snippet ? `<div style="margin-top:6px; color:#555; font-size:13px;">${item.snippet}</div>` : ''}
        </div>`;
    });

    if (intercom.length + clickup.length === 0) {
      html += `<p style="color:#757575;">Ничего не найдено. Обнови базу: <a href="/sync">/sync</a></p>`;
    }

    html += '</div>';
    res.json({ answer: html });
  } catch (err) {
    console.error('Ошибка /ask:', err.message);
    res.json({ answer: '<p style="color:#d32f2f">Произошла ошибка при поиске. Проверь логи Render.</p>' });
  }
});

// ─── ЛОГИН ──────────────────────────────────────────────────────────────────
app.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true, remember });
  } else {
    res.json({ success: false });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер на порту ${PORT}`);
  console.log(`   GET /sync  → обновить базу Intercom`);
  console.log(`   POST /ask → поиск`);
});

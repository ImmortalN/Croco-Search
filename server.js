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
    'Intercom-Version': 'Unstable'   // если не пойдёт — попробуй '2.14'
  };

  let allArticles = [];
  let startingAfter = null;
  let page = 0;
  let hasMore = true;

  console.log('🚀 Запуск полной синхронизации Intercom internal_articles');

  while (hasMore) {
    page++;
    const params = new URLSearchParams({
      per_page: '150'
    });
    if (startingAfter) {
      params.append('starting_after', startingAfter);
    }

    const url = `https://api.intercom.io/internal_articles?${params.toString()}`;
    console.log(`📄 Страница ${page} | URL: ${url}`);

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Intercom ошибка ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const pageArticles = data.data || data.articles || data.internal_articles || [];

      console.log(`   Получено статей на странице: ${pageArticles.length}`);
      console.log(`   Общее количество на данный момент: ${allArticles.length + pageArticles.length}`);

      // Добавляем статьи
      pageArticles.forEach(a => {
        allArticles.push({
          id: a.id,
          title: a.title || '(без заголовка)',
          body: (a.body || a.description || '').replace(/<[^>]+>/g, ' ').trim(),
          url: `https://app.intercom.com/a/apps/${workspace}/articles/articles/${a.id}/show`
        });
      });

      // Проверяем, есть ли следующая страница
      const nextPage = data.pages?.next;
      if (nextPage && nextPage.starting_after) {
        startingAfter = nextPage.starting_after;
        console.log(`   Есть следующая страница (starting_after = ${startingAfter.substring(0, 20)}...)`);
        await new Promise(resolve => setTimeout(resolve, 1200)); // задержка 1.2 сек
      } else {
        console.log('   Нет следующей страницы (pages.next или starting_after отсутствует)');
        hasMore = false;
      }

      // Дополнительная защита: если пришло меньше 150, скорее всего конец
      if (pageArticles.length < 150) {
        console.log('   Получено меньше 150 статей → вероятно последняя страница');
        hasMore = false;
      }

    } catch (err) {
      console.error(`   Ошибка на странице ${page}:`, err.message);
      hasMore = false;
    }
  }

  console.log(`🎉 Синхронизация завершена. Всего статей: ${allArticles.length}`);
  return allArticles;
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

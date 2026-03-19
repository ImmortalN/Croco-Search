require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Логин
app.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true, remember });
  } else {
    res.json({ success: false, message: 'Неверный логин или пароль' });
  }
});

// ====================== ПОИСКОВЫЕ ФУНКЦИИ ======================

async function searchIntercom(question) {
  console.log(`[Intercom] Ищем: "${question}"`);
  let results = [];

  // Попытка 1: точная фраза
  for (const mode of ['exact', 'normal']) {
    try {
      const phrase = mode === 'exact' ? `"${question}"` : question;
      const res = await fetch('https://api.intercom.io/articles/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
          'Accept': 'application/json',
          'Intercom-Version': '2.14',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ phrase, state: 'published', help_center_id: process.env.INTERCOM_HELP_CENTER_ID })
      });

      if (res.ok) {
        const data = await res.json();
        const arts = (data.articles || []).map(a => ({
          title: a.title,
          url: a.web_url,
          snippet: a.highlight?.snippet || '',
          source: 'Intercom (публичный)'
        }));
        results.push(...arts);
        console.log(`[Intercom публичный] найдено ${arts.length}`);
      }
    } catch (e) { console.error('[Intercom public error]', e.message); }

    // Internal
    try {
      const phrase = mode === 'exact' ? `"${question}"` : question;
      const res = await fetch(`https://api.intercom.io/internal_articles/search?phrase=${encodeURIComponent(phrase)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
          'Accept': 'application/json',
          'Intercom-Version': 'Unstable'
        }
      });

      if (res.ok) {
        const data = await res.json();
        const arts = (data.articles || data.data || []).map(a => ({
          title: a.title || a.name || 'Без названия',
          url: a.url || a.web_url || '#',
          snippet: (a.body || a.description || '').substring(0, 120),
          source: 'Intercom (внутренний)'
        }));
        results.push(...arts);
        console.log(`[Intercom internal] найдено ${arts.length}`);
      }
    } catch (e) { console.error('[Intercom internal error]', e.message); }
  }

  return results;
}

async function searchClickUp(question) {
  console.log(`[ClickUp] Ищем: "${question}"`);
  if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_LIST_IDS) return [];

  const listIds = process.env.CLICKUP_LIST_IDS.split(',').map(id => id.trim()).filter(Boolean);
  let tasks = [];
  const qLower = question.toLowerCase().trim();
  const words = qLower.split(/\s+/);

  for (const listId of listIds) {
    try {
      const res = await fetch(
        `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&order_by=date_created&reverse=true&limit=100`,
        { headers: { 'Authorization': process.env.CLICKUP_TOKEN } }
      );

      if (res.ok) {
        const data = await res.json();
        const matching = (data.tasks || []).filter(t => {
          const text = (t.name + ' ' + (t.description || '')).toLowerCase();
          return words.every(w => text.includes(w)) || text.includes(qLower);
        });

        tasks.push(...matching.map(t => ({
          title: t.name,
          url: t.url,
          snippet: (t.description || '').substring(0, 100),
          source: 'ClickUp'
        })));
        console.log(`[ClickUp список ${listId}] найдено ${matching.length}`);
      }
    } catch (e) {
      console.error(`[ClickUp ${listId} error]`, e.message);
    }
  }

  return [...new Map(tasks.map(t => [t.url, t])).values()]; // без дубликатов
}

async function searchCrocoblock(question) {
  console.log(`[Crocoblock] Парсим: "${question}"`);
  const url = `https://crocoblock.com/?s=${encodeURIComponent(question)}`;
  let results = [];

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);

      // Несколько возможных селекторов (на 2026 год)
      const selectors = [
        'article', '.post', '.search-result-item', '.entry', '.jet-search-result',
        '[class*="search"] .item', '.blog-posts .post'
      ];

      for (const sel of selectors) {
        $(sel).slice(0, 5).each((i, el) => {
          const title = $(el).find('h2, h3, .title, .post-title, a').first().text().trim();
          let link = $(el).find('a').first().attr('href');
          const snippet = $(el).find('.excerpt, p, .description, .summary').first().text().trim().substring(0, 100);

          if (title && link) {
            if (!link.startsWith('http')) link = 'https://crocoblock.com' + link;
            results.push({ title, url: link, snippet, source: 'Crocoblock' });
          }
        });
        if (results.length > 0) break;
      }

      console.log(`[Crocoblock] найдено ${results.length} результатов`);
    }
  } catch (e) {
    console.error('[Crocoblock error]', e.message);
  }

  // Если парсинг не сработал — хотя бы ссылка
  if (results.length === 0) {
    results.push({
      title: 'Открыть поиск на Crocoblock',
      url: `https://crocoblock.com/?s=${encodeURIComponent(question)}`,
      snippet: 'Статьи, гайды и документация',
      source: 'Crocoblock (ссылка)'
    });
  }

  return results;
}

// ====================== ГЛАВНЫЙ ЭНДПОИНТ ======================
app.post('/ask', async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) return res.json({ answer: 'Введите вопрос!' });

  const q = question.trim();
  console.log(`\n=== НОВЫЙ ЗАПРОС === "${q}"`);

  let allResults = [];

  const [intercom, clickup, croco] = await Promise.all([
    searchIntercom(q),
    searchClickUp(q),
    searchCrocoblock(q)
  ]);

  allResults = [...intercom, ...clickup, ...croco];

  // Сортируем по длине совпадения (простой способ)
  allResults.sort((a, b) => b.title.length - a.title.length);

  let html = `<strong>Поиск по запросу:</strong> ${q}<br><br>`;

  if (allResults.length === 0) {
    html += `❌ Ничего не найдено по точному запросу.<br><br>`;
    html += `💡 Попробуйте ввести полный заголовок гайда или ключевые слова.<br>`;
  } else {
    html += `✅ Найдено ${allResults.length} результатов:<br><br>`;

    allResults.slice(0, 15).forEach(r => {
      html += `→ <a href="${r.url}" target="_blank">${r.title}</a><br>`;
      html += `<small>${r.source} • ${r.snippet ? r.snippet + '...' : ''}</small><br><br>`;
    });
  }

  html += `<hr><strong>Дополнительно:</strong><br>`;
  html += `• Если ничего не нашлось — напишите полный заголовок гайда<br>`;

  res.json({ answer: html });
  console.log(`[Ответ отправлен] Количество результатов: ${allResults.length}`);
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log('   Логи будут в Render → Logs');
});

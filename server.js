require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// ── Логин ────────────────────────────────────────────────────────
app.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true, remember });
  } else {
    res.json({ success: false, message: 'Неверный логин или пароль' });
  }
});

// ── Поиск по публичным статьям Intercom ──────────────────────────
async function searchIntercomPublic(question) {
  try {
    const res = await fetch('https://api.intercom.io/articles/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Intercom-Version': '2.14',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        phrase: question,
        state: 'published',
        help_center_id: process.env.INTERCOM_HELP_CENTER_ID,
        highlight: true
      })
    });

    if (!res.ok) return [];
    const data = await res.json();
    return (data.articles || []).map(a => ({
      title: a.title,
      url: a.web_url,
      snippet: a.highlight?.snippet || '',
      score: countMatches(question, a.title + ' ' + (a.highlight?.snippet || ''))
    }));
  } catch (err) {
    console.error('Intercom public error:', err.message);
    return [];
  }
}

// ── Поиск по внутренним гайдам Intercom (unstable) ───────────────
async function searchIntercomInternal(question) {
  try {
    const url = `https://api.intercom.io/internal_articles/search?phrase=${encodeURIComponent(question)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Intercom-Version': 'Unstable'
      }
    });

    if (!res.ok) return [];
    const data = await res.json();
    const articles = data.articles || data.data || [];
    return articles.map(a => ({
      title: a.title || a.name || 'Без названия',
      url: a.url || a.web_url || '#',
      snippet: a.body?.substring(0, 150) || a.description?.substring(0, 150) || '',
      score: countMatches(question, a.title + ' ' + (a.body || a.description || ''))
    }));
  } catch (err) {
    console.error('Intercom internal error:', err.message);
    return [];
  }
}

// ── Поиск по ClickUp ─────────────────────────────────────────────
async function searchClickUp(question) {
  if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_LIST_IDS) return [];

  const listIds = process.env.CLICKUP_LIST_IDS.split(',').map(id => id.trim()).filter(Boolean);
  let tasks = [];

  for (const listId of listIds) {
    try {
      const res = await fetch(
        `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&order_by=date_created&reverse=true`,
        { headers: { 'Authorization': process.env.CLICKUP_TOKEN } }
      );

      if (res.ok) {
        const data = await res.json();
        const matching = (data.tasks || []).map(t => ({
          title: t.name,
          url: t.url,
          snippet: t.description?.substring(0, 150) || '',
          score: countMatches(question, t.name + ' ' + (t.description || ''))
        }));
        tasks.push(...matching);
      }
    } catch (err) {
      console.error(`ClickUp list ${listId} error:`, err.message);
    }
  }

  // Убираем дубликаты по url и сортируем по score
  return [...new Map(tasks.map(t => [t.url, t])).values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// Простая функция подсчёта совпадений (для сортировки по релевантности)
function countMatches(query, text) {
  if (!text || !query) return 0;
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = t.indexOf(q, pos)) !== -1) {
    count++;
    pos += q.length;
  }
  return count + (t.includes(q) ? 5 : 0); // бонус за хотя бы одно вхождение
}

// ── Главный эндпоинт ─────────────────────────────────────────────
app.post('/ask', async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) {
    return res.json({ answer: 'Введите вопрос!' });
  }

  const q = question.trim();

  let results = [];
  let html = `<strong>Поиск по запросу:</strong> ${q}<br><br>`;

  // Intercom публичные
  const publicArts = await searchIntercomPublic(q);
  results.push(...publicArts.map(a => ({ ...a, source: 'Intercom (публичная)' })));

  // Intercom internal
  const internalArts = await searchIntercomInternal(q);
  results.push(...internalArts.map(a => ({ ...a, source: 'Intercom (внутренний)' })));

  // ClickUp
  const clickupTasks = await searchClickUp(q);
  results.push(...clickupTasks.map(t => ({ ...t, source: 'ClickUp' })));

  // Сортируем по релевантности
  results.sort((a, b) => b.score - a.score);

  if (results.length === 0) {
    html += 'Ничего не найдено по этому запросу.<br>';
  } else {
    html += `Найдено ${results.length} совпадений:<br><br>`;

    results.slice(0, 12).forEach(r => {  // лимит на 12 лучших
      const snippet = r.snippet ? `<small>${r.snippet}...</small>` : '';
      html += `→ <a href="${r.url}" target="_blank">${r.title}</a><br>`;
      html += `<small>${r.source} · ${snippet}</small><br><br>`;
    });
  }

  // Добавляем ссылку на Crocoblock в конец
  const crocoUrl = `https://crocoblock.com/?s=${encodeURIComponent(q)}`;
  html += `<hr><strong>Поиск по сайту Crocoblock:</strong><br>`;
  html += `<a href="${crocoUrl}" target="_blank">${crocoUrl}</a>`;

  res.json({ answer: html });
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

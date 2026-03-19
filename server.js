require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Логин (без изменений)
app.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true, remember });
  } else {
    res.json({ success: false, message: 'Неверный логин или пароль' });
  }
});

// Поиск по публичным статьям Intercom (Help Center)
async function searchIntercomPublic(question) {
  let articles = [];
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

    if (res.ok) {
      const data = await res.json();
      articles = data.articles?.slice(0, 6) || [];
    }
  } catch (err) {
    console.error('Intercom public error:', err.message);
  }
  return articles;
}

// Поиск по internal articles (внутренние гайды) — Unstable API
async function searchIntercomInternal(question) {
  let articles = [];
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

    if (res.ok) {
      const data = await res.json();
      // структура может быть data.articles или data.type === 'list.item' → articles
      articles = (data.articles || data.data || []).slice(0, 6);
    } else if (res.status === 404 || res.status === 400) {
      console.warn('Internal search endpoint not available or no results');
    }
  } catch (err) {
    console.error('Intercom internal error:', err.message);
  }
  return articles;
}

// Поиск по ClickUp (несколько списков)
async function searchClickUp(question) {
  let tasks = [];
  if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_LIST_IDS) return tasks;

  const listIds = process.env.CLICKUP_LIST_IDS.split(',').map(id => id.trim()).filter(Boolean);
  const qLower = question.toLowerCase();

  for (const listId of listIds) {
    try {
      const res = await fetch(
        `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&order_by=date_created&reverse=true`,
        { headers: { 'Authorization': process.env.CLICKUP_TOKEN } }
      );

      if (res.ok) {
        const data = await res.json();
        const matching = (data.tasks || []).filter(t =>
          (t.name + ' ' + (t.description || '')).toLowerCase().includes(qLower)
        );
        tasks.push(...matching);
      }
    } catch (err) {
      console.error(`ClickUp list ${listId} error:`, err.message);
    }
  }

  // Удаляем дубликаты по id и лимитируем
  tasks = [...new Map(tasks.map(t => [t.id, t])).values()].slice(0, 8);
  return tasks;
}

// Главный обработчик вопроса
app.post('/ask', async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) {
    return res.json({ answer: 'Введите вопрос!' });
  }

  let rawFindings = `Вопрос: ${question}\n\n`;

  // ── Intercom публичные статьи ──
  const publicArticles = await searchIntercomPublic(question);
  if (publicArticles.length > 0) {
    rawFindings += `Публичные статьи Intercom (${publicArticles.length}):\n` +
      publicArticles.map(a => 
        `- ${a.title}\n  URL: ${a.web_url}\n  ${a.highlight?.snippet || 'нет сниппета'}\n`
      ).join('\n') + '\n\n';
  } else {
    rawFindings += 'Публичные статьи Intercom: ничего не найдено.\n\n';
  }

  // ── Intercom internal гайды ──
  const internalArticles = await searchIntercomInternal(question);
  if (internalArticles.length > 0) {
    rawFindings += `Внутренние гайды Intercom (${internalArticles.length}):\n` +
      internalArticles.map(a => 
        `- ${a.title || a.name || 'Без названия'}\n  URL: ${a.url || a.web_url || 'нет ссылки'}\n  ${a.body?.substring(0, 300) || a.description?.substring(0, 300) || 'нет текста'}...\n`
      ).join('\n') + '\n\n';
  } else {
    rawFindings += 'Внутренние гайды Intercom: ничего не найдено или эндпоинт недоступен.\n\n';
  }

  // ── ClickUp ──
  const clickupTasks = await searchClickUp(question);
  if (clickupTasks.length > 0) {
    rawFindings += `ClickUp задачи (${clickupTasks.length}):\n` +
      clickupTasks.map(t => 
        `- ${t.name}\n  URL: ${t.url}\n  ${t.description?.substring(0, 250) || 'нет описания'}...\n`
      ).join('\n') + '\n\n';
  } else {
    rawFindings += 'ClickUp: подходящих задач не найдено.\n\n';
  }

  // ── Crocoblock ──
  const crocoUrl = `https://crocoblock.com/?s=${encodeURIComponent(question)}`;
  rawFindings += `Поиск по сайту Crocoblock (откройте ссылку): ${crocoUrl}\n\n`;

  // ── Gemini ──
  let finalAnswer = 'Не удалось получить ответ от Gemini. Проверьте GEMINI_API_KEY и лимиты.';
  if (process.env.GEMINI_API_KEY) {
    try {
      const prompt = `Ты эксперт по Crocoblock (JetEngine, JetSmartFilters и т.д.), Elementor и внутренним процессам команды.
Отвечай **только на русском**, кратко, по делу.
Используй ТОЛЬКО информацию из контекста ниже. Если ничего релевантного — скажи честно: "В базе ничего подходящего не нашёл".

Контекст (самые релевантные источники):
${rawFindings}

Структура ответа:
1. Краткое решение / объяснение
2. Самые полезные ссылки (Intercom, ClickUp, Crocoblock)
3. Что проверить дальше (если нужно)`;

      const gemRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.35, maxOutputTokens: 800 }
          })
        }
      );

      if (!gemRes.ok) {
        const errText = await gemRes.text();
        if (gemRes.status === 429 || errText.includes('quota') || errText.includes('rate limit')) {
          finalAnswer = 'Лимит бесплатного Gemini исчерпан на сегодня. Попробуйте завтра.';
        } else if (gemRes.status === 403) {
          finalAnswer = 'Доступ к Gemini запрещён (403). Проверьте ключ и регион.';
        } else {
          finalAnswer = `Gemini ошибка: статус ${gemRes.status}`;
        }
        console.error('Gemini status:', gemRes.status, errText);
      } else {
        const data = await gemRes.json();
        finalAnswer = data.candidates?.[0]?.content?.parts?.[0]?.text || '(Gemini вернул пустой ответ)';
      }
    } catch (err) {
      console.error('Gemini fetch error:', err.message);
      finalAnswer = 'Ошибка соединения с Gemini: ' + err.message;
    }
  }

  // Ответ пользователю — только от Gemini, с переносами строк
  const htmlAnswer = finalAnswer.replace(/\n/g, '<br>');

  res.json({ answer: htmlAnswer });
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

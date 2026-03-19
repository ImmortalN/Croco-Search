require('dotenv').config(); // на Render это не обязательно, но вреда не будет
const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Логин (оставляем без изменений)
app.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true, remember });
  } else {
    res.json({ success: false, message: 'Неверный логин или пароль' });
  }
});

// Главный эндпоинт
app.post('/ask', async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) {
    return res.json({ answer: 'Введите вопрос!' });
  }

  let rawFindings = ''; // сюда соберём весь контекст для Gemini

  try {
    // ── 1. Intercom ───────────────────────────────────────────────
    let intercomArticles = [];
    try {
      const icRes = await fetch('https://api.intercom.io/articles/search', {
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

      if (icRes.ok) {
        const ic = await icRes.json();
        if (ic.articles?.length > 0) {
          intercomArticles = ic.articles.slice(0, 6); // берём до 6 самых релевантных
        }
      }
    } catch (err) {
      console.error('Intercom error:', err.message);
    }

    if (intercomArticles.length > 0) {
      rawFindings += `Intercom статьи (самые релевантные):\n` +
        intercomArticles.map(a => 
          `- ${a.title}\n  URL: ${a.web_url}\n  Кратко: ${a.highlight?.snippet || 'нет сниппета'}\n`
        ).join('\n') + '\n\n';
    } else {
      rawFindings += 'Intercom: ничего подходящего не найдено.\n\n';
    }

    // ── 2. ClickUp (несколько листов) ──────────────────────────────
    let clickupTasks = [];
    if (process.env.CLICKUP_TOKEN && process.env.CLICKUP_LIST_IDS) {
      try {
        const listIds = process.env.CLICKUP_LIST_IDS.split(',').map(id => id.trim()).filter(Boolean);

        for (const listId of listIds) {
          const cuRes = await fetch(
            `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&order_by=date_created&reverse=true`,
            { headers: { 'Authorization': process.env.CLICKUP_TOKEN } }
          );

          if (cuRes.ok) {
            const cu = await cuRes.json();
            if (cu.tasks?.length) {
              const qLower = question.toLowerCase();
              const matching = cu.tasks.filter(t =>
                t.name.toLowerCase().includes(qLower) ||
                (t.description && t.description.toLowerCase().includes(qLower))
              );
              clickupTasks.push(...matching);
            }
          }
        }

        // Убираем дубликаты и лимитируем
        clickupTasks = [...new Map(clickupTasks.map(t => [t.id, t])).values()].slice(0, 8);
      } catch (err) {
        console.error('ClickUp error:', err.message);
      }
    }

    if (clickupTasks.length > 0) {
      rawFindings += `ClickUp задачи (релевантные):\n` +
        clickupTasks.map(t => 
          `- ${t.name}\n  URL: ${t.url}\n  Описание: ${t.description?.substring(0, 250) || 'нет описания'}...\n`
        ).join('\n') + '\n\n';
    } else {
      rawFindings += 'ClickUp: подходящих задач не найдено.\n\n';
    }

    // ── 3. Crocoblock ─────────────────────────────────────────────
    const crocoUrl = `https://crocoblock.com/?s=${encodeURIComponent(question)}`;
    rawFindings += `Crocoblock поиск: ${crocoUrl}\n(можно открыть и посмотреть документацию / статьи / FAQ)\n\n`;

    // ── 4. Gemini — единый умный ответ ────────────────────────────
    let finalAnswer = 'Не удалось получить ответ от Gemini. Проверьте GEMINI_API_KEY и лимиты.';

    if (process.env.GEMINI_API_KEY) {
      try {
        const prompt = `Ты эксперт по Crocoblock, JetEngine, JetSmartFilters, Elementor и внутренней документации/задачам команды.
Отвечай **только на русском**, кратко, по делу, структурировано.
Используй **ТОЛЬКО** информацию ниже. Если ничего релевантного — честно скажи: "В доступной базе ничего подходящего не нашёл".

Вопрос пользователя: ${question}

Доступный контекст:
${rawFindings}

Структура ответа:
1. Краткое решение / объяснение (основное, что нужно сделать)
2. Самые полезные ссылки (Intercom статьи, ClickUp задачи, Crocoblock)
3. Что проверить дальше / возможные подводные камни (если есть)

Не добавляй лишнюю информацию, не фантазируй.`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.35,
                maxOutputTokens: 800
              }
            })
          }
        );

        if (!geminiRes.ok) {
          throw new Error(`Gemini status ${geminiRes.status}`);
        }

        const data = await geminiRes.json();
        finalAnswer = data.candidates?.[0]?.content?.parts?.[0]?.text || '(Gemini вернул пустой ответ)';
      } catch (err) {
        console.error('Gemini error:', err.message);
        finalAnswer = `Ошибка Gemini: ${err.message}\n\nСырой контекст для отладки:\n${rawFindings}`;
      }
    }

    // Финальный ответ пользователю — только от Gemini
    const htmlAnswer = finalAnswer
      .replace(/\n/g, '<br>')
      .replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}" target="_blank">${url}</a>`);

    res.json({ answer: htmlAnswer });

  } catch (err) {
    console.error('Global error:', err);
    res.json({ answer: 'Произошла ошибка на сервере. Попробуйте позже.' });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер на порту ${PORT}`);
});

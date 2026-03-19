require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Логин (оставляем как было, но добавили сообщение об ошибке)
app.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
    res.json({ success: true, remember });
  } else {
    res.json({ success: false, message: 'Неверный логин или пароль' });
  }
});

// Главный поиск
app.post('/ask', async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) {
    return res.json({ answer: 'Введите вопрос!' });
  }

  let answer = `<h3>Поиск по запросу: <b>${question}</b></h3>`;

  try {
    // ── 1. Intercom ───────────────────────────────────────────────
    let intercomPart = 'В Intercom ничего не найдено.<br>';
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

      if (!icRes.ok) throw new Error(`Intercom ${icRes.status}`);

      const ic = await icRes.json();

      if (ic.articles?.length > 0) {
        intercomPart = 'Intercom статьи:<br>' +
          ic.articles.slice(0, 4).map(a =>
            `→ <a href="${a.web_url}" target="_blank">${a.title}</a><br>`
          ).join('');
      }
    } catch (err) {
      console.error('Intercom error:', err);
      intercomPart = 'Ошибка Intercom поиска.<br>';
    }
    answer += intercomPart;

    // ── 2. ClickUp (несколько листов) ──────────────────────────────
    let clickupPart = '<br>В ClickUp ничего не найдено.<br>';
    let collectedTasks = [];

    if (process.env.CLICKUP_TOKEN && process.env.CLICKUP_LIST_IDS) {
      try {
        const listIds = process.env.CLICKUP_LIST_IDS.split(',').map(id => id.trim()).filter(Boolean);

        for (const listId of listIds) {
          const cuRes = await fetch(
            `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&order_by=date_created&reverse=true`,
            { headers: { 'Authorization': process.env.CLICKUP_TOKEN } }
          );

          if (!cuRes.ok) continue;

          const cu = await cuRes.json();
          if (cu.tasks) {
            const qLower = question.toLowerCase();
            const matching = cu.tasks.filter(t =>
              t.name.toLowerCase().includes(qLower) ||
              (t.description && t.description.toLowerCase().includes(qLower))
            );
            collectedTasks.push(...matching);
          }
        }

        // Убираем дубликаты по id и берём топ-6
        collectedTasks = [...new Map(collectedTasks.map(t => [t.id, t])).values()]
          .slice(0, 6);

        if (collectedTasks.length > 0) {
          clickupPart = `<br>ClickUp задачи (${collectedTasks.length} найдено):<br>` +
            collectedTasks.map(t =>
              `→ <a href="${t.url}" target="_blank">${t.name}</a><br>`
            ).join('');
        } else if (collectedTasks.length === 0 && listIds.length > 0) {
          // fallback — последние из первого списка
          // можно расширить, но пока просто информируем
          clickupPart = '<br>ClickUp: подходящих задач не найдено (проверьте списки в .env).<br>';
        }
      } catch (err) {
        console.error('ClickUp error:', err);
        clickupPart = '<br>Ошибка ClickUp.<br>';
      }
    }
    answer += clickupPart;

    // ── 3. Crocoblock ссылка ──────────────────────────────────────
    const crocoSearch = `https://crocoblock.com/?s=${encodeURIComponent(question)}`;
    answer += `<br>Crocoblock: <a href="${crocoSearch}" target="_blank">поиск на сайте →</a><br>`;

    // ── 4. Gemini (Google) — умный ответ ──────────────────────────
    let smartAnswer = '(Gemini не ответил — проверьте GEMINI_API_KEY)';
    if (process.env.GEMINI_API_KEY) {
      try {
        const context = `
Intercom:
${ic?.articles?.slice(0,5).map(a => `- ${a.title} → ${a.web_url}`).join('\n') || 'ничего'}

ClickUp задачи:
${collectedTasks.map(t => `- ${t.name} → ${t.url}`).join('\n') || 'ничего'}

Crocoblock поиск: ${crocoSearch}
        `.trim();

        const prompt = `Ты помощник по Crocoblock, JetEngine, Elementor и внутренней документации.
Отвечай кратко, по делу, только на русском.
Используй ТОЛЬКО информацию ниже. Если ничего подходящего — честно скажи "не нашёл точного ответа в базе".

Вопрос: ${question}

Контекст:
${context}

Структура ответа:
1. Краткое решение / объяснение
2. Ссылки на статьи / задачи (если релевантны)
3. Что проверить дальше (если нужно)
`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.4,
                maxOutputTokens: 600
              }
            })
          }
        );

        if (!geminiRes.ok) {
          throw new Error(`Gemini ${geminiRes.status}`);
        }

        const data = await geminiRes.json();
        smartAnswer = data.candidates?.[0]?.content?.parts?.[0]?.text ||
                      '(Gemini вернул пустой ответ)';
      } catch (err) {
        console.error('Gemini error:', err);
        smartAnswer = `Ошибка Gemini: ${err.message}`;
      }
    }

    answer += `<hr><strong>🤖 Умный ответ от Gemini:</strong><br>${smartAnswer.replace(/\n/g, '<br>')}`;

    res.json({ answer });

  } catch (globalErr) {
    console.error('Global error:', globalErr);
    res.json({ answer: 'Произошла ошибка на сервере. Попробуйте позже.' });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер работает на порту ${PORT}`);
});

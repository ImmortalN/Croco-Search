require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
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
    res.json({ success: false });
  }
});

// Модуль поиска Intercom
async function searchIntercom(question) {
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
    if(res.ok) {
      const data = await res.json();
      articles = data.articles?.slice(0,6) || [];
    }
  } catch(err) {
    console.error('Intercom error:', err.message);
  }
  return articles;
}

// Модуль поиска ClickUp
async function searchClickUp(question) {
  let tasks = [];
  if(!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_LIST_IDS) return tasks;

  const listIds = process.env.CLICKUP_LIST_IDS.split(',').map(id => id.trim()).filter(Boolean);
  const qLower = question.toLowerCase();

  for(const listId of listIds) {
    try {
      const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&order_by=date_created&reverse=true`,
        { headers: { 'Authorization': process.env.CLICKUP_TOKEN } });
      if(res.ok) {
        const data = await res.json();
        const matching = data.tasks?.filter(t => ((t.name + ' ' + (t.description||'')).toLowerCase().includes(qLower))) || [];
        tasks.push(...matching);
      }
    } catch(err) {
      console.error('ClickUp error:', err.message);
    }
  }
  // уникальные задачи, лимит до 8
  tasks = [...new Map(tasks.map(t => [t.id, t])).values()].slice(0,8);
  return tasks;
}

// Главный эндпоинт
app.post('/ask', async (req,res) => {
  const { question } = req.body;
  if(!question?.trim()) return res.json({ answer: 'Введите вопрос!' });

  let rawFindings = '';

  const intercomArticles = await searchIntercom(question);
  if(intercomArticles.length > 0) {
    rawFindings += `Intercom статьи:\n` + intercomArticles.map(a => 
      `- ${a.title}\n  URL: ${a.web_url}\n  Кратко: ${a.highlight?.snippet || 'нет сниппета'}\n`
    ).join('\n') + '\n\n';
  } else rawFindings += 'Intercom: ничего подходящего не найдено.\n\n';

  const clickupTasks = await searchClickUp(question);
  if(clickupTasks.length > 0) {
    rawFindings += `ClickUp задачи:\n` + clickupTasks.map(t => 
      `- ${t.name}\n  URL: ${t.url}\n  Описание: ${t.description?.substring(0,250) || 'нет описания'}...\n`
    ).join('\n') + '\n\n';
  } else rawFindings += 'ClickUp: подходящих задач не найдено.\n\n';

  // Crocoblock поиск
  const crocoUrl = `https://crocoblock.com/?s=${encodeURIComponent(question)}`;
  rawFindings += `Crocoblock поиск: ${crocoUrl}\n\n`;

  // Gemini
  let finalAnswer = 'Не удалось получить ответ от Gemini.';
  if(process.env.GEMINI_API_KEY) {
    try {
      const prompt = `Ты эксперт по Crocoblock и внутренним гайдам.
Вопрос: ${question}
Контекст:
${rawFindings}`;
      const gemRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            contents: [{ parts:[{ text: prompt }] }],
            generationConfig: { temperature:0.35, maxOutputTokens:800 }
          })
        }
      );
      const data = await gemRes.json();
      finalAnswer = data.candidates?.[0]?.content?.parts?.[0]?.text || '(Gemini вернул пустой ответ)';
    } catch(err) {
      console.error('Gemini error:', err.message);
      finalAnswer = `Ошибка Gemini: ${err.message}`;
    }
  }

  res.json({ answer: finalAnswer.replace(/\n/g,'<br>') });
});

app.listen(PORT,()=>console.log(`Сервер запущен на ${PORT}`));

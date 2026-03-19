const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// ====================== ПОИСК INTERCOM ======================
async function searchIntercom(q) {
    // Используем INTERCOM_TOKEN из Render
    const token = process.env.INTERCOM_TOKEN;
    if (!token) return [];

    try {
        const res = await fetch('https://api.intercom.io/articles/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Intercom-Version': '2.14',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                phrase: q,
                // Если в Render есть ID хелп-центра, ограничиваем поиск им
                help_center_id: process.env.INTERCOM_HELP_CENTER_ID 
            })
        });
        
        const data = await res.json();
        const articles = data.articles || data.data || [];
        return articles.map(a => ({
            title: a.title,
            url: a.url || a.web_url,
            source: 'INTERCOM GUIDE',
            color: '#00c2ff'
        }));
    } catch (e) {
        return [];
    }
}

// ====================== ПОИСК CLICKUP ======================
async function searchClickUp(q) {
    const token = process.env.CLICKUP_TOKEN;
    const listIds = process.env.CLICKUP_LIST_IDS; // Берем строку из Render (напр. "123,456")

    if (!token || !listIds) return [];

    try {
        // Так как у нас есть только List IDs, нам нужно искать внутри конкретных списков
        const ids = listIds.split(',').map(id => id.trim());
        let allTasks = [];

        // Проходим по каждому списку из Render и ищем таски
        for (const listId of ids) {
            const url = `https://api.clickup.com/api/v2/list/${listId}/task?search=${encodeURIComponent(q)}&include_closed=true`;
            const res = await fetch(url, { headers: { 'Authorization': token } });
            const data = await res.json();
            
            if (data.tasks) {
                allTasks = [...allTasks, ...data.tasks];
            }
        }

        return allTasks.map(t => ({
            title: t.name,
            url: t.url,
            source: 'CLICKUP TASK',
            color: '#7b68ee'
        }));
    } catch (e) {
        return [];
    }
}

// ====================== ЭНДПОИНТ ======================
app.post('/ask', async (req, res) => {
    const { question } = req.body;
    const q = (question || '').trim();

    if (!q) return res.json({ answer: 'Введите запрос.' });

    // Запускаем поиск по Intercom и ClickUp
    const [intercom, clickup] = await Promise.all([
        searchIntercom(q),
        searchClickUp(q)
    ]);

    const results = [...intercom, ...clickup];

    let html = `<div style="font-family: sans-serif;">`;
    // Выводим статистику, чтобы вы видели, что пришло из Render
    html += `<div style="font-size:10px; color:#ccc; margin-bottom:10px;">
        Status: Intercom(${intercom.length}) | ClickUp(${clickup.length})
    </div>`;

    if (results.length === 0) {
        html += `<p>По запросу <strong>"${q}"</strong> ничего не найдено в рабочих базах.</p>`;
    } else {
        results.forEach(item => {
            html += `
            <div style="margin-bottom: 15px; border-left: 4px solid ${item.color}; padding-left: 12px;">
                <span style="font-size: 10px; font-weight: bold; color: ${item.color};">${item.source}</span><br>
                <a href="${item.url}" target="_blank" style="color: #0066ff; text-decoration: none; font-weight: 600;">${item.title}</a>
            </div>`;
        });
    }

    res.json({ answer: html + '</div>' });
});

app.listen(PORT);

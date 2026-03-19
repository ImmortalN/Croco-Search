const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.')); // Раздает index.html и style.css из этой же папки

// ====================== ФУНКЦИЯ ПОИСКА INTERCOM ======================
async function searchIntercom(q) {
    const token = process.env.INTERCOM_TOKEN;
    if (!token) return [];

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };

    let results = [];

    try {
        // 1. Поиск по ПУБЛИЧНЫМ статьям (v2.14)
        const pubRes = await fetch('https://api.intercom.io/articles/search', {
            method: 'POST',
            headers: { ...headers, 'Intercom-Version': '2.14' },
            body: JSON.stringify({ phrase: q })
        });
        const pubData = await pubRes.json();
        if (pubData.articles) {
            pubData.articles.forEach(a => {
                results.push({
                    title: a.title || 'Untitled Guide',
                    url: a.url || a.web_url,
                    source: 'Intercom Public'
                });
            });
        }

        // 2. Поиск по ВНУТРЕННИМ статьям (Unstable)
        const intRes = await fetch(`https://api.intercom.io/internal_articles/search?phrase=${encodeURIComponent(q)}`, {
            method: 'GET',
            headers: { ...headers, 'Intercom-Version': 'Unstable' }
        });
        const intData = await intRes.json();
        const items = intData.data || intData.articles || [];
        items.forEach(a => {
            // Формируем ссылку на админку, если web_url отсутствует
            const adminUrl = a.url || `https://app.intercom.com/a/apps/${process.env.INTERCOM_WORKSPACE_ID || 'rn7ho5ox'}/articles/articles/${a.id}/show`;
            results.push({
                title: a.title || a.name || 'Internal Article',
                url: adminUrl,
                source: 'Intercom Internal'
            });
        });

    } catch (e) {
        console.error('[Intercom Error]:', e.message);
    }
    return results;
}

// ====================== ФУНКЦИЯ ПОИСКА CLICKUP ======================
async function searchClickUp(q) {
    const token = process.env.CLICKUP_TOKEN;
    const listIds = process.env.CLICKUP_LIST_IDS;
    if (!token || !listIds) return [];

    try {
        const ids = listIds.split(',').map(id => id.trim());
        let allTasks = [];

        // Ищем в каждом списке отдельно (особенности API для списков)
        for (const listId of ids) {
            const url = `https://api.clickup.com/api/v2/list/${listId}/task?search=${encodeURIComponent(q)}&include_closed=true`;
            const res = await fetch(url, { headers: { 'Authorization': token } });
            const data = await res.json();
            if (data.tasks) allTasks = [...allTasks, ...data.tasks];
        }

        return allTasks.map(t => ({
            title: t.name,
            url: t.url,
            source: 'ClickUp Task'
        }));
    } catch (e) {
        console.error('[ClickUp Error]:', e.message);
        return [];
    }
}

// ====================== ЭНДПОИНТ ДЛЯ ЧАТА ======================
app.post('/ask', async (req, res) => {
    const { question } = req.body;
    const q = (question || '').trim();

    if (!q) return res.json({ answer: 'Введите, пожалуйста, поисковый запрос.' });

    // Параллельный запуск поиска
    const [intercomResults, clickupResults] = await Promise.all([
        searchIntercom(q),
        searchClickUp(q)
    ]);

    const combined = [...intercomResults, ...clickupResults];

    // Формируем HTML-баббл ответа
    let html = `<div class="search-results" style="font-family: inherit;">`;
    
    // Техническая плашка для мониторинга в чате
    html += `<div style="font-size:10px; color:#aaa; margin-bottom:12px; border-bottom:1px solid #eee; padding-bottom:4px;">
        Источники: Intercom (${intercomResults.length}), ClickUp (${clickupResults.length})
    </div>`;

    if (combined.length === 0) {
        html += `<p>По запросу <strong>"${q}"</strong> ничего не найдено. Попробуйте уточнить ключевые слова.</p>`;
    } else {
        combined.forEach(item => {
            const isIntercom = item.source.includes('Intercom');
            const color = isIntercom ? '#00c2ff' : '#7b68ee';
            
            html += `
            <div style="margin-bottom:16px; border-left:4px solid ${color}; padding-left:12px;">
                <span style="font-size:10px; font-weight:bold; color:${color}; text-transform:uppercase;">${item.source}</span><br>
                <a href="${item.url}" target="_blank" style="color:#0066ff; text-decoration:none; font-weight:600; font-size:16px; display:inline-block; margin-top:2px;">
                    ${item.title}
                </a>
            </div>`;
        });
    }

    html += `</div>`;
    res.json({ answer: html });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Вспомогательная функция для проверки вхождения слов
function matchesQuery(text, query) {
    if (!text || !query) return false;
    const words = query.toLowerCase().split(' ');
    const target = text.toLowerCase();
    // Проверяем, чтобы ВСЕ слова из запроса были в тексте (более строгий поиск)
    return words.every(word => target.includes(word));
}

// ====================== УЛУЧШЕННЫЙ INTERCOM ======================
async function searchIntercom(q) {
    const token = process.env.INTERCOM_TOKEN;
    if (!token) return [];

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Intercom-Version': 'Unstable' // Используем Unstable для внутренних статей
    };

    try {
        // Попробуем сначала поиск (Search API)
        const searchUrl = `https://api.intercom.io/internal_articles/search?phrase=${encodeURIComponent(q)}`;
        const res = await fetch(searchUrl, { headers });
        const data = await res.json();
        
        let found = data.data || data.articles || [];

        // Если поиск вернул 0, попробуем выкачать последние статьи и найти вручную
        if (found.length === 0) {
            const listUrl = `https://api.intercom.io/internal_articles?per_page=50`;
            const listRes = await fetch(listUrl, { headers });
            const listData = await listRes.json();
            const allArticles = listData.data || [];
            
            // Фильтруем вручную по заголовку
            found = allArticles.filter(a => matchesQuery(a.title || a.name, q));
        }

        return found.map(a => ({
            title: a.title || a.name,
            url: a.url || `https://app.intercom.com/a/apps/${process.env.INTERCOM_WORKSPACE_ID || 'rn7ho5ox'}/articles/articles/${a.id}/show`,
            source: 'Intercom Internal'
        }));
    } catch (e) {
        console.error('Intercom Error:', e.message);
        return [];
    }
}

// ====================== УЛУЧШЕННЫЙ CLICKUP ======================
async function searchClickUp(q) {
    const token = process.env.CLICKUP_TOKEN;
    const listIds = process.env.CLICKUP_LIST_IDS;
    if (!token || !listIds) return [];

    try {
        const ids = listIds.split(',').map(id => id.trim());
        let filteredTasks = [];

        for (const listId of ids) {
            // Запрашиваем задачи из списка
            const url = `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true`;
            const res = await fetch(url, { headers: { 'Authorization': token } });
            const data = await res.json();
            
            if (data.tasks) {
                // ЖЕСТКАЯ ФИЛЬТРАЦИЯ: оставляем только то, что подходит под запрос
                const matches = data.tasks.filter(t => matchesQuery(t.name, q));
                filteredTasks = [...filteredTasks, ...matches];
            }
        }

        return filteredTasks.map(t => ({
            title: t.name,
            url: t.url,
            source: 'ClickUp Task'
        }));
    } catch (e) {
        console.error('ClickUp Error:', e.message);
        return [];
    }
}

// ====================== ЭНДПОИНТ ======================
app.post('/ask', async (req, res) => {
    const { question } = req.body;
    const q = (question || '').trim();

    if (!q) return res.json({ answer: 'Введите запрос.' });

    const [intercom, clickup] = await Promise.all([
        searchIntercom(q),
        searchClickUp(q)
    ]);

    const results = [...intercom, ...clickup];

    let html = `<div style="font-family: sans-serif;">
        <div style="font-size:10px; color:#aaa; margin-bottom:10px; border-bottom:1px solid #eee; padding-bottom:4px;">
            Найдено: Intercom (${intercom.length}) | ClickUp (${clickup.length})
        </div>`;

    if (results.length === 0) {
        html += `<p>По запросу <strong>"${q}"</strong> ничего не найдено.</p>`;
    } else {
        // Ограничиваем выдачу 15 результатами, чтобы не спамить
        results.slice(0, 15).forEach(item => {
            const color = item.source.includes('Intercom') ? '#00c2ff' : '#7b68ee';
            html += `
            <div style="margin-bottom: 15px; border-left: 4px solid ${color}; padding-left: 12px;">
                <span style="font-size: 10px; font-weight: bold; color: ${color}; text-transform: uppercase;">${item.source}</span><br>
                <a href="${item.url}" target="_blank" style="color: #0066ff; text-decoration: none; font-weight: 600; font-size: 15px;">${item.title}</a>
            </div>`;
        });
    }

    res.json({ answer: html + '</div>' });
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));

const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Вспомогательная функция для проверки вхождения слов (строгий фильтр)
function matchesQuery(text, query) {
    if (!text || !query) return false;
    const words = query.toLowerCase().split(' ').filter(w => w.length > 1);
    const target = text.toLowerCase();
    // Возвращаем true, только если ВСЕ слова из запроса есть в названии
    return words.every(word => target.includes(word));
}

// ====================== УЛУЧШЕННЫЙ INTERCOM ======================
async function searchIntercom(q) {
    const token = process.env.INTERCOM_TOKEN;
    const workspaceId = process.env.INTERCOM_WORKSPACE_ID || 'rn7ho5ox'; // ← очень желательно вынести в .env

    if (!token) return [];

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Intercom-Version': 'Unstable'
    };

    let results = [];

    try {
        // ─── Попытка №1: поиск по phrase ───────────────────────────────
        const searchUrl = `https://api.intercom.io/internal_articles/search?phrase=${encodeURIComponent(q)}`;
        const searchRes = await fetch(searchUrl, { method: 'GET', headers });
        
        if (!searchRes.ok) {
            console.warn(`Intercom search HTTP ${searchRes.status}: ${await searchRes.text()}`);
        } else {
            const data = await searchRes.json();
            // Самый частый вариант структуры в Unstable
            const articles = data.data || data.articles || [];

            articles.forEach(article => {
                const title = article.title || article.name || '(без названия)';
                // Важно: у внутренних статей нет поля url → формируем вручную
                const url = `https://app.intercom.com/a/apps/${workspaceId}/articles/articles/${article.id}/show`;

                results.push({
                    title,
                    url,
                    source: 'Intercom Internal'
                });
            });
        }

        // ─── Попытка №2: глубокий поиск (если ничего не нашли) ─────────
        if (results.length === 0) {
            console.log('Intercom: основной поиск ничего не дал → запускаем перебор страниц');

            for (let page = 1; page <= 6; page++) {   // можно увеличить до 8–10 при необходимости
                const listUrl = `https://api.intercom.io/internal_articles?page=${page}&per_page=50`;
                const listRes = await fetch(listUrl, { headers });
                
                if (!listRes.ok) break;

                const listData = await listRes.json();
                const articles = listData.data || [];

                if (articles.length === 0) break;

                const matches = articles.filter(a => matchesQuery(a.title || a.name || '', q));

                matches.forEach(a => {
                    const title = a.title || a.name || '(без названия)';
                    const url = `https://app.intercom.com/a/apps/${workspaceId}/articles/articles/${a.id}/show`;

                    results.push({
                        title,
                        url,
                        source: 'Intercom Internal (deep)'
                    });
                });

                if (results.length >= 10) break; // ограничиваем, чтобы не висело долго
            }
        }
    } catch (err) {
        console.error('Intercom fatal error:', err.message);
    }

    return results;
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
            // Запрашиваем задачи (API ClickUp часто игнорирует параметр search в списках)
            const url = `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true`;
            const res = await fetch(url, { headers: { 'Authorization': token } });
            const data = await res.json();
            
            if (data.tasks && Array.isArray(data.tasks)) {
                // Вручную фильтруем полученную сотню задач нашим строгим фильтром
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

// ====================== ГЛАВНЫЙ ОБРАБОТЧИК ======================
app.post('/ask', async (req, res) => {
    const { question } = req.body;
    const q = (question || '').trim();

    if (!q) return res.json({ answer: 'Введите поисковый запрос.' });

    // Запускаем оба поиска одновременно
    const [intercom, clickup] = await Promise.all([
        searchIntercom(q),
        searchClickUp(q)
    ]);

    // Убираем возможные дубликаты по URL
    const allResults = [...intercom, ...clickup];
    const uniqueResults = Array.from(new Map(allResults.map(item => [item.url, item])).values());

    let html = `<div style="font-family: sans-serif;">
        <div style="font-size:10px; color:#aaa; margin-bottom:10px; border-bottom:1px solid #eee; padding-bottom:4px;">
            Найдено: Intercom (${intercom.length}) | ClickUp (${clickup.length})
        </div>`;

    if (uniqueResults.length === 0) {
        html += `<p>Ничего не найдено по запросу <strong>"${q}"</strong>. Попробуйте использовать более общие слова.</p>`;
    } else {
        uniqueResults.slice(0, 20).forEach(item => {
            const isIntercom = item.source.includes('Intercom');
            const color = isIntercom ? '#00c2ff' : '#7b68ee';
            
            html += `
            <div style="margin-bottom: 15px; border-left: 4px solid ${color}; padding-left: 12px;">
                <span style="font-size: 10px; font-weight: bold; color: ${color}; text-transform: uppercase;">${item.source}</span><br>
                <a href="${item.url}" target="_blank" style="color: #0066ff; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block; margin-top: 2px;">
                    ${item.title}
                </a>
            </div>`;
        });
    }

    res.json({ answer: html + '</div>' });
});

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));

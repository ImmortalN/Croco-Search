require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

function cleanText(text) {
    if (!text) return '';
    // Убираем HTML, лишние пробелы и переносы
    return text.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
}

// ====================== ПОИСКОВЫЕ ФУНКЦИИ ======================

async function searchIntercom(question) {
    console.log(`[Intercom] Запрос: "${question}"`);
    const headers = {
        'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Intercom-Version': '2.14',
        'Content-Type': 'application/json'
    };

    try {
        const res = await fetch('https://api.intercom.io/articles/search', {
            method: 'POST',
            headers,
            body: JSON.stringify({ phrase: question })
        });

        if (res.ok) {
            const data = await res.json();
            const list = data.articles || data.data || [];
            console.log(`[Intercom] Найдено: ${list.length}`);
            
            return list.map(a => ({
                title: a.title,
                url: a.url || a.web_url,
                snippet: cleanText(a.description || a.body || '').substring(0, 150),
                source: 'INTERCOM GUIDE',
                priority: 1 // Самый высокий приоритет
            }));
        }
        console.error(`[Intercom] Ошибка API: ${res.status}`);
    } catch (e) {
        console.error('[Intercom Error]', e.message);
    }
    return [];
}

async function searchClickUp(question) {
    console.log(`[ClickUp] Запрос: "${question}"`);
    if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_TEAM_ID) {
        console.error('[ClickUp] Проверьте CLICKUP_TOKEN и CLICKUP_TEAM_ID в .env');
        return [];
    }

    try {
        const url = `https://api.clickup.com/api/v2/team/${process.env.CLICKUP_TEAM_ID}/task?search=${encodeURIComponent(question)}&include_closed=true`;
        const res = await fetch(url, { headers: { 'Authorization': process.env.CLICKUP_TOKEN } });

        if (res.ok) {
            const data = await res.json();
            console.log(`[ClickUp] Найдено: ${data.tasks?.length || 0}`);
            return (data.tasks || []).map(t => ({
                title: t.name,
                url: t.url,
                snippet: cleanText(t.description || '').substring(0, 150),
                source: 'CLICKUP TASK',
                priority: 2
            }));
        }
        console.error(`[ClickUp] Ошибка API: ${res.status}`);
    } catch (e) {
        console.error('[ClickUp Error]', e.message);
    }
    return [];
}

async function searchCrocoblock(question) {
    console.log(`[Crocoblock] Запрос: "${question}"`);
    const url = `https://crocoblock.com/?s=${encodeURIComponent(question)}`;
    let results = [];

    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.ok) {
            const html = await res.text();
            const $ = cheerio.load(html);

            $('article, .jet-listing-dynamic-post').each((i, el) => {
                const titleNode = $(el).find('h1, h2, h3, .entry-title, .title, a').first();
                const link = $(el).find('a').first().attr('href');
                
                // Пробуем разные селекторы для описания, чтобы не было "Без описания"
                const snippet = $(el).find('.entry-content, .entry-excerpt, .excerpt, p').text() || "";

                if (link && link.startsWith('http')) {
                    results.push({
                        title: cleanText(titleNode.text()),
                        url: link,
                        snippet: cleanText(snippet).substring(0, 150),
                        source: 'CROCOBLOCK SITE',
                        priority: 3
                    });
                }
            });
        }
        console.log(`[Crocoblock] Найдено: ${results.length}`);
    } catch (e) {
        console.error('[Crocoblock Error]', e.message);
    }
    return results;
}

// ====================== ЭНДПОИНТ ======================

app.post('/ask', async (req, res) => {
    const { question } = req.body;
    const q = question?.toLowerCase().trim();
    if (!q) return res.json({ answer: 'Введите запрос.' });

    // Запускаем всё разом
    const [intercom, clickup, croco] = await Promise.all([
        searchIntercom(q),
        searchClickUp(q),
        searchCrocoblock(q)
    ]);

    // Объединяем
    let all = [...intercom, ...clickup, ...croco];

    // Удаляем дубликаты
    all = Array.from(new Map(all.map(item => [item.url, item])).values());

    // СОРТИРОВКА
    all.sort((a, b) => {
        // 1. Сначала те, у кого в заголовке есть точное слово
        const aInTitle = a.title.toLowerCase().includes(q);
        const bInTitle = b.title.toLowerCase().includes(q);
        if (aInTitle !== bInTitle) return bInTitle - aInTitle;
        
        // 2. Потом по приоритету источника (Intercom > ClickUp > Site)
        return a.priority - b.priority;
    });

    let html = `<div class="search-results-container">`;
    if (all.length === 0) {
        html += `<p>Ничего не найдено.</p>`;
    } else {
        all.slice(0, 15).forEach(item => {
            const color = item.source === 'INTERCOM GUIDE' ? '#00c2ff' : (item.source === 'CLICKUP TASK' ? '#7b68ee' : '#888');
            html += `
            <div style="margin-bottom: 20px; border-left: 4px solid ${color}; padding-left: 15px;">
                <div style="font-size: 10px; font-weight: bold; color: ${color}; margin-bottom: 4px;">${item.source}</div>
                <a href="${item.url}" target="_blank" style="font-size: 17px; color: #0066ff; text-decoration: none; font-weight: 600;">${item.title}</a>
                <div style="font-size: 14px; color: #444; margin-top: 5px;">${item.snippet || 'Перейдите по ссылке, чтобы прочитать статью'}...</div>
            </div>`;
        });
    }
    html += `</div>`;
    
    res.json({ answer: html });
});

app.listen(PORT, () => console.log(`🚀 Сервер готов на порту ${PORT}`));

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Авторизация
app.post('/login', (req, res) => {
    const { username, password, remember } = req.body;
    if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
        res.json({ success: true, remember });
    } else {
        res.json({ success: false, message: 'Неверный логин или пароль' });
    }
});

// ====================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ======================

function cleanText(text) {
    if (!text) return '';
    return text.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
}

/**
 * Оценка релевантности (чем выше score, тем выше результат)
 */
function getRelevanceScore(title, snippet, query) {
    const q = query.toLowerCase();
    const t = title.toLowerCase();
    const s = snippet.toLowerCase();
    let score = 0;

    if (t.includes(q)) score += 100; // Точное совпадение в заголовке
    else {
        // Проверка по отдельным словам из запроса
        const words = q.split(' ');
        words.forEach(word => {
            if (word.length > 2 && t.includes(word)) score += 20;
        });
    }
    
    if (s.includes(q)) score += 10; // Совпадение в описании
    return score;
}

// ====================== ПОИСКОВЫЕ ФУНКЦИИ ======================

async function searchIntercom(question) {
    console.log(`[Intercom] Поиск: "${question}"`);
    let results = [];
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
            const articles = data.articles || data.data || [];
            articles.forEach(a => {
                const title = cleanText(a.title);
                const snippet = cleanText(a.description || a.body || '');
                results.push({
                    title,
                    url: a.url || a.web_url,
                    snippet: snippet.substring(0, 160),
                    source: 'Intercom Guide',
                    score: getRelevanceScore(title, snippet, question) + 50 // Бонус за источник
                });
            });
        }
    } catch (e) {
        console.error('[Intercom Error]', e.message);
    }
    return results;
}

async function searchClickUp(question) {
    console.log(`[ClickUp] Поиск: "${question}"`);
    if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_TEAM_ID) return [];

    try {
        // Поиск по всей команде с параметром search
        const url = `https://api.clickup.com/api/v2/team/${process.env.CLICKUP_TEAM_ID}/task?search=${encodeURIComponent(question)}&include_closed=true`;
        const res = await fetch(url, {
            headers: { 'Authorization': process.env.CLICKUP_TOKEN }
        });

        if (res.ok) {
            const data = await res.json();
            return (data.tasks || []).map(t => {
                const title = t.name;
                const snippet = cleanText(t.description || '');
                return {
                    title,
                    url: t.url,
                    snippet: snippet.substring(0, 160),
                    source: 'ClickUp Task',
                    score: getRelevanceScore(title, snippet, question) + 40 // Бонус за источник
                };
            });
        }
    } catch (e) {
        console.error('[ClickUp Error]', e.message);
    }
    return [];
}

async function searchCrocoblock(question) {
    console.log(`[Crocoblock] Поиск: "${question}"`);
    const url = `https://crocoblock.com/?s=${encodeURIComponent(question)}`;
    let results = [];

    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.ok) {
            const html = await res.text();
            const $ = cheerio.load(html);

            $('article, .jet-listing-dynamic-post, .post-item').each((i, el) => {
                let titleNode = $(el).find('h1, h2, h3, .entry-title, .title').first();
                if (titleNode.length === 0) titleNode = $(el).find('a').first();

                const title = cleanText(titleNode.text());
                const link = $(el).find('a').first().attr('href');
                const snippet = cleanText($(el).find('.entry-excerpt, .excerpt, p').first().text());

                if (title && link && link.startsWith('http')) {
                    const score = getRelevanceScore(title, snippet, question);
                    // Отсекаем совсем нерелевантный мусор с сайта
                    if (score > 10) {
                        results.push({ 
                            title, 
                            url: link, 
                            snippet: snippet.substring(0, 160), 
                            source: 'Crocoblock Site',
                            score: score
                        });
                    }
                }
            });
        }
    } catch (e) {
        console.error('[Crocoblock Error]', e.message);
    }
    return results;
}

// ====================== ГЛАВНЫЙ ЭНДПОИНТ ======================

app.post('/ask', async (req, res) => {
    const { question } = req.body;
    if (!question?.trim()) return res.json({ answer: 'Введите запрос.' });

    const q = question.trim();
    
    // Параллельный запуск
    const [intercom, clickup, croco] = await Promise.all([
        searchIntercom(q),
        searchClickUp(q),
        searchCrocoblock(q)
    ]);

    // Объединяем и фильтруем дубликаты
    let allResults = [...intercom, ...clickup, ...croco];
    const uniqueResults = Array.from(new Map(allResults.map(item => [item.url, item])).values());

    // Итоговая сортировка по Score (релевантность + приоритет источника)
    uniqueResults.sort((a, b) => b.score - a.score);

    // Сборка ответа
    let htmlOutput = `<div class="search-results-container">`;
    htmlOutput += `<p>Найдено подходящих ресурсов: <strong>${uniqueResults.length}</strong></p><hr style="border:0; border-top:1px solid #eee; margin:15px 0;">`;

    if (uniqueResults.length === 0) {
        htmlOutput += `<p>К сожалению, ничего не найдено по запросу "${q}".</p>`;
    } else {
        uniqueResults.slice(0, 12).forEach(item => {
            htmlOutput += `
            <div class="result-item" style="margin-bottom: 20px; border-left: 3px solid ${item.source.includes('Intercom') ? '#00c2ff' : (item.source.includes('ClickUp') ? '#7b68ee' : '#eee')}; padding-left: 15px;">
                <div class="result-source" style="font-size: 11px; color: #888; font-weight: bold;">${item.source}</div>
                <a href="${item.url}" target="_blank" class="result-link" style="font-size: 17px; color: #0066ff; text-decoration: none; font-weight: 600; display: block; margin: 4px 0;">${item.title}</a>
                <div class="result-snippet" style="font-size: 14px; color: #555; line-height: 1.4;">${item.snippet || 'Без описания'}...</div>
            </div>`;
        });
    }

    htmlOutput += `</div>`;
    res.json({ answer: htmlOutput });
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер на порту ${PORT}`);
});

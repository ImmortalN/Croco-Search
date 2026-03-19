require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Простая авторизация
app.post('/login', (req, res) => {
    const { username, password, remember } = req.body;
    if (username === process.env.APP_LOGIN && password === process.env.APP_PASSWORD) {
        res.json({ success: true, remember });
    } else {
        res.json({ success: false, message: 'Неверный логин или пароль' });
    }
});

// ====================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ======================

// Очистка текста от HTML тегов и лишних пробелов
function cleanText(text) {
    if (!text) return '';
    return text.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
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
        // 1. Публичные статьи
        const publicRes = await fetch('https://api.intercom.io/articles/search', {
            method: 'POST',
            headers,
            body: JSON.stringify({ phrase: question, state: 'published', help_center_id: process.env.INTERCOM_HELP_CENTER_ID })
        });

        if (publicRes.ok) {
            const data = await publicRes.json();
            (data.articles || []).forEach(a => {
                results.push({
                    title: cleanText(a.title),
                    url: a.web_url,
                    snippet: cleanText(a.highlight?.snippet || ''),
                    source: 'Intercom Help Center'
                });
            });
        }

        // 2. Внутренние статьи (Internal)
        const internalRes = await fetch(`https://api.intercom.io/internal_articles/search?phrase=${encodeURIComponent(question)}`, {
            headers: { ...headers, 'Intercom-Version': 'Unstable' }
        });

        if (internalRes.ok) {
            const data = await internalRes.json();
            const items = data.articles || data.data || [];
            items.forEach(a => {
                results.push({
                    title: cleanText(a.title || a.name),
                    url: a.url || a.web_url || '#',
                    snippet: cleanText(a.body || a.description || '').substring(0, 120),
                    source: 'Intercom Internal'
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
    if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_LIST_IDS) return [];

    const listIds = process.env.CLICKUP_LIST_IDS.split(',').map(id => id.trim()).filter(Boolean);
    let tasks = [];
    const query = question.toLowerCase();

    for (const listId of listIds) {
        try {
            const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&limit=100`, {
                headers: { 'Authorization': process.env.CLICKUP_TOKEN }
            });

            if (res.ok) {
                const data = await res.json();
                const filtered = (data.tasks || []).filter(t => {
                    const content = (t.name + ' ' + (t.description || '')).toLowerCase();
                    return content.includes(query);
                });

                filtered.forEach(t => {
                    tasks.push({
                        title: t.name,
                        url: t.url,
                        snippet: cleanText(t.description).substring(0, 120),
                        source: 'ClickUp Task'
                    });
                });
            }
        } catch (e) {
            console.error(`[ClickUp Error List ${listId}]`, e.message);
        }
    }
    return tasks;
}

async function searchCrocoblock(question) {
    console.log(`[Crocoblock] Парсинг: "${question}"`);
    const url = `https://crocoblock.com/?s=${encodeURIComponent(question)}`;
    let results = [];

    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.ok) {
            const html = await res.text();
            const $ = cheerio.load(html);

            // Ищем контейнеры постов
            $('article, .jet-listing-dynamic-post, .post-item, .search-result-item').each((i, el) => {
                if (results.length >= 7) return;

                // Извлекаем заголовок: берем текст только из текстовых узлов, игнорируя <img> и прочее
                let titleNode = $(el).find('h1, h2, h3, .entry-title, .title').first();
                if (titleNode.length === 0) titleNode = $(el).find('a').first();

                let title = cleanText(titleNode.text());
                let link = $(el).find('a').first().attr('href');
                let snippet = cleanText($(el).find('.entry-excerpt, .excerpt, p').first().text());

                if (title && link && link.startsWith('http')) {
                    results.push({ title, url: link, snippet: snippet.substring(0, 150), source: 'Crocoblock Site' });
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
    if (!question?.trim()) return res.json({ answer: 'Пожалуйста, введите запрос.' });

    const q = question.trim();
    
    // Запускаем все поиски параллельно
    const [intercom, clickup, croco] = await Promise.all([
        searchIntercom(q),
        searchClickUp(q),
        searchCrocoblock(q)
    ]);

    let allResults = [...intercom, ...clickup, ...croco];

    // Удаляем дубликаты по URL
    allResults = Array.from(new Map(allResults.map(item => [item.url, item])).values());

    // Сортировка: приоритет тем, где запрос есть в заголовке
    allResults.sort((a, b) => {
        const aTitleMatch = a.title.toLowerCase().includes(q.toLowerCase());
        const bTitleMatch = b.title.toLowerCase().includes(q.toLowerCase());
        return bTitleMatch - aTitleMatch;
    });

    // Формируем HTML ответ
    let htmlOutput = `<div class="search-results-container">`;
    htmlOutput += `<p>Результаты по запросу: <strong>${q}</strong></p><br>`;

    if (allResults.length === 0) {
        htmlOutput += `<p>Ничего не найдено. Попробуйте изменить формулировку.</p>`;
    } else {
        allResults.slice(0, 15).forEach(res => {
            htmlOutput += `
            <div class="result-item" style="margin-bottom: 20px;">
                <div class="result-source" style="font-size: 0.75rem; color: #888; text-transform: uppercase; font-weight: bold;">${res.source}</div>
                <a href="${res.url}" target="_blank" class="result-link" style="font-size: 1.1rem; color: #0066cc; text-decoration: none; font-weight: 600;">${res.title}</a>
                <div class="result-snippet" style="font-size: 0.9rem; color: #444; margin-top: 4px;">${res.snippet || 'Описание отсутствует'}...</div>
            </div>`;
        });
    }

    htmlOutput += `</div>`;
    res.json({ answer: htmlOutput });
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

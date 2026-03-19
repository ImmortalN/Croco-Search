require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Вспомогательная очистка
const clean = (txt) => (txt || '').replace(/\s+/g, ' ').trim();

async function searchIntercom(q) {
    if (!process.env.INTERCOM_TOKEN) return [];
    try {
        const res = await fetch('https://api.intercom.io/articles/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
                'Intercom-Version': '2.14',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ phrase: q })
        });
        const data = await res.json();
        const articles = data.articles || data.data || [];
        console.log(`[Intercom] Найдено: ${articles.length}`);
        return articles.map(a => ({
            title: a.title || 'Без названия',
            url: a.url || a.web_url || '#',
            source: 'INTERCOM',
            type: 'guide'
        }));
    } catch (e) { console.error('Intercom Error:', e.message); return []; }
}

async function searchClickUp(q) {
    if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_TEAM_ID) return [];
    try {
        const url = `https://api.clickup.com/api/v2/team/${process.env.CLICKUP_TEAM_ID}/task?search=${encodeURIComponent(q)}&include_closed=true`;
        const res = await fetch(url, { headers: { 'Authorization': process.env.CLICKUP_TOKEN } });
        const data = await res.json();
        const tasks = data.tasks || [];
        console.log(`[ClickUp] Найдено: ${tasks.length}`);
        return tasks.map(t => ({
            title: t.name || 'Без названия',
            url: t.url || '#',
            source: 'CLICKUP',
            type: 'task'
        }));
    } catch (e) { console.error('ClickUp Error:', e.message); return []; }
}

async function searchCrocoblock(q) {
    try {
        const res = await fetch(`https://crocoblock.com/?s=${encodeURIComponent(q)}`);
        const html = await res.text();
        const $ = cheerio.load(html);
        let results = [];

        // Улучшенный селектор для поиска по сайту
        $('article, .jet-listing-dynamic-post, .post-item').each((i, el) => {
            if (i > 10) return;
            const linkTag = $(el).find('a').first();
            const titleTag = $(el).find('h1, h2, h3, .entry-title, .jet-listing-dynamic-field__content').first();
            
            const title = clean(titleTag.text() || linkTag.text());
            const url = linkTag.attr('href');

            if (title && url && url.startsWith('http')) {
                results.push({ title, url, source: 'SITE', type: 'post' });
            }
        });
        console.log(`[Site] Найдено: ${results.length}`);
        return results;
    } catch (e) { return []; }
}

app.post('/ask', async (req, res) => {
    const { question } = req.body;
    const q = (question || '').trim();
    
    // 1. Запускаем поиск
    const [intercom, clickup, site] = await Promise.all([
        searchIntercom(q),
        searchClickUp(q),
        searchCrocoblock(q)
    ]);

    // 2. Объединяем (Сначала интерком и кликап, потом сайт)
    const all = [...intercom, ...clickup, ...site];

    // 3. Собираем HTML
    let html = `<div style="font-family:sans-serif; line-height:1.5;">`;
    
    // Технический отчет (поможет понять, работают ли токены)
    html += `<div style="font-size:10px; color:#aaa; margin-bottom:10px;">
        Статистика: Intercom(${intercom.length}), ClickUp(${clickup.length}), Site(${site.length})
    </div>`;

    if (all.length === 0) {
        html += `<p>Ничего не найдено.</p>`;
    } else {
        all.slice(0, 15).forEach(item => {
            const labelColor = item.source === 'INTERCOM' ? '#00c2ff' : (item.source === 'CLICKUP' ? '#7b68ee' : '#888');
            
            html += `
            <div style="margin-bottom:18px; border-left:4px solid ${labelColor}; padding-left:12px;">
                <span style="font-size:10px; font-weight:bold; color:${labelColor}; text-transform:uppercase;">${item.source}</span><br>
                <a href="${item.url}" target="_blank" style="color:#0066ff; text-decoration:none; font-weight:600; font-size:16px;">
                    ${item.title}
                </a>
            </div>`;
        });
    }
    
    html += `</div>`;
    res.json({ answer: html });
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));

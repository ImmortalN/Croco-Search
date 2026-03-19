require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Вспомогательная очистка текста
const clean = (txt) => (txt || '').replace(/\s+/g, ' ').trim();

// ====================== ПОИСК INTERCOM ======================
async function searchIntercom(q) {
    if (!process.env.INTERCOM_TOKEN) {
        console.error('Ошибка: INTERCOM_TOKEN не найден в .env');
        return [];
    }
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
        
        // Если API вернуло ошибку (например, 401)
        if (data.errors) {
            console.error('Intercom API Error:', data.errors);
            return [];
        }

        const articles = data.articles || data.data || [];
        return articles.map(a => ({
            title: a.title || 'Untitled Article',
            url: a.url || a.web_url || '#',
            source: 'INTERCOM GUIDE',
            color: '#00c2ff'
        }));
    } catch (e) {
        console.error('Intercom Fetch Exception:', e.message);
        return [];
    }
}

// ====================== ПОИСК CLICKUP ======================
async function searchClickUp(q) {
    if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_TEAM_ID) {
        console.error('Ошибка: CLICKUP_TOKEN или TEAM_ID не найдены в .env');
        return [];
    }
    try {
        const url = `https://api.clickup.com/api/v2/team/${process.env.CLICKUP_TEAM_ID}/task?search=${encodeURIComponent(q)}&include_closed=true`;
        
        const res = await fetch(url, { 
            headers: { 'Authorization': process.env.CLICKUP_TOKEN } 
        });
        
        const data = await res.json();
        
        if (!res.ok) {
            console.error('ClickUp API Error Status:', res.status);
            return [];
        }

        const tasks = data.tasks || [];
        return tasks.map(t => ({
            title: t.name || 'Untitled Task',
            url: t.url || '#',
            source: 'CLICKUP TASK',
            color: '#7b68ee'
        }));
    } catch (e) {
        console.error('ClickUp Fetch Exception:', e.message);
        return [];
    }
}

// ====================== ГЛАВНЫЙ ОБРАБОТЧИК ======================
app.post('/ask', async (req, res) => {
    const { question } = req.body;
    const q = (question || '').trim();

    if (!q) return res.json({ answer: 'Введите поисковый запрос.' });

    console.log(`--- Новый поиск: "${q}" ---`);

    // Запускаем только два источника
    const [intercom, clickup] = await Promise.all([
        searchIntercom(q),
        searchClickUp(q)
    ]);

    const allResults = [...intercom, ...clickup];

    // Формируем HTML
    let html = `<div class="results-container" style="font-family: sans-serif;">`;
    
    // Техническая строка для дебага
    html += `<div style="font-size:11px; color:#999; margin-bottom:15px; border-bottom:1px solid #eee; padding-bottom:5px;">
        Найдено: Intercom (${intercom.length}), ClickUp (${clickup.length})
    </div>`;

    if (allResults.length === 0) {
        html += `
            <div style="padding: 20px; text-align: center; color: #666;">
                <p>Ничего не найдено в Intercom и ClickUp по запросу <strong>"${q}"</strong>.</p>
                <p style="font-size: 13px;">Проверьте правильность написания или настройки API ключей.</p>
            </div>`;
    } else {
        allResults.forEach(item => {
            html += `
            <div class="result-card" style="margin-bottom: 20px; border-left: 4px solid ${item.color}; padding-left: 15px;">
                <div style="font-size: 10px; font-weight: bold; color: ${item.color}; text-transform: uppercase; letter-spacing: 0.5px;">
                    ${item.source}
                </div>
                <a href="${item.url}" target="_blank" style="display: block; font-size: 17px; color: #0066ff; text-decoration: none; font-weight: 600; margin: 5px 0;">
                    ${item.title}
                </a>
                <div style="font-size: 12px; color: #888;">Нажмите на заголовок, чтобы открыть ресурс</div>
            </div>`;
        });
    }

    html += `</div>`;
    res.json({ answer: html });
});

app.listen(PORT, () => console.log(`🚀 Сервер работает на порту ${PORT}`));

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // npm i node-fetch@2
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Базовая авторизация
app.use((req, res, next) => {
  const auth = {
    login: process.env.APP_LOGIN,
    password: process.env.APP_PASSWORD
  };
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  if (login && password && login === auth.login && password === auth.password) return next();
  res.set('WWW-Authenticate', 'Basic realm="Protected"');
  res.status(401).send('Неавторизован');
});

app.post('/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.json({ answer: 'Пожалуйста, введите вопрос' });

  try {
    const searchRes = await fetch('https://api.intercom.io/articles/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Intercom-Version': '2.14'
      },
      body: JSON.stringify({
        phrase: question,
        state: 'published',
        help_center_id: process.env.INTERCOM_HELP_CENTER_ID,
        highlight: true
      })
    });

    const data = await searchRes.json();

    if (data.articles && data.articles.length > 0) {
      const topArticles = data.articles.slice(0, 3)
        .map(a => `<a href="${a.web_url}" target="_blank">${a.title}</a>`).join('<br>');
      res.json({ answer: `Найдены статьи по вашему вопросу:<br>${topArticles}` });
    } else {
      res.json({ answer: 'По вашему запросу ничего не найдено в гайдах Intercom.' });
    }
  } catch (e) {
    console.error(e);
    res.json({ answer: 'Произошла ошибка при поиске гайдов.' });
  }
});

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));

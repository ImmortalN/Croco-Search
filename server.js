require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

// Логин
app.post('/login', (req,res)=>{
  const {username,password,remember} = req.body;
  if(username===process.env.APP_LOGIN && password===process.env.APP_PASSWORD){
    res.json({success:true, remember});
  } else {
    res.json({success:false});
  }
});

// Поиск по Intercom + ClickUp
app.post('/ask', async (req,res)=>{
  const {question} = req.body;
  if(!question) return res.json({answer:'Введите вопрос'});

  try{
    // Intercom
    const ic = await fetch('https://api.intercom.io/articles/search',{
      method:'POST',
      headers:{
        'Authorization':`Bearer ${process.env.INTERCOM_TOKEN}`,
        'Accept':'application/json',
        'Intercom-Version':'2.14'
      },
      body:JSON.stringify({
        phrase:question,
        state:'published',
        help_center_id:process.env.INTERCOM_HELP_CENTER_ID,
        highlight:true
      })
    }).then(r=>r.json());

    let answer = '';
    if(ic.articles && ic.articles.length>0){
      answer += 'Intercom статьи:<br>' + ic.articles.slice(0,3).map(a=>`<a href="${a.web_url}" target="_blank">${a.title}</a>`).join('<br>');
    } else answer += 'В Intercom ничего не найдено.<br>';

    // ClickUp (пример)
    if(process.env.CLICKUP_TOKEN && process.env.CLICKUP_TEAM_ID){
      const cu = await fetch(`https://api.clickup.com/api/v2/team/${process.env.CLICKUP_TEAM_ID}/task?archived=false&order_by=date_created&reverse=true`,{
        headers:{'Authorization':process.env.CLICKUP_TOKEN}
      }).then(r=>r.json());

      if(cu.tasks && cu.tasks.length>0){
        answer += '<br>ClickUp задачи:<br>' + cu.tasks.slice(0,3).map(t=>`<a href="${t.url}" target="_blank">${t.name}</a>`).join('<br>');
      } else answer += '<br>В ClickUp ничего не найдено.';
    }

    res.json({answer});
  } catch(e){
    console.error(e);
    res.json({answer:'Произошла ошибка при поиске.'});
  }
});

app.listen(PORT, ()=>console.log(`Сервер на порту ${PORT}`));

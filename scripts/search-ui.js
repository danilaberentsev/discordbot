import 'dotenv/config';
import { createServer } from 'node:http';
import { YandexMusicClient } from '../src/music/client.js';

const token = process.env.YANDEX_MUSIC_TOKEN;
const PORT = Number(process.env.PORT ?? 8787);

const music = new YandexMusicClient(token);

const HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Яндекс Музыка — поиск</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 16px; color: #e0e0e0; background: #1e1e1e; }
  h1 { font-size: 20px; }
  form { display: flex; gap: 8px; }
  input { flex: 1; padding: 10px; font-size: 16px; background: #2a2a2a; color: #e0e0e0; border: 1px solid #444; border-radius: 4px; }
  button { padding: 10px 18px; font-size: 16px; cursor: pointer; background: #fc0; color: #111; border: 0; border-radius: 4px; }
  pre { background: #111; color: #98c379; padding: 16px; overflow: auto; max-height: 72vh; border-radius: 6px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .hint { color: #888; font-size: 12px; margin: 12px 0; }
</style>
</head>
<body>
<h1>Поиск Яндекс Музыки (сырой ответ API)</h1>
<form id="form">
  <input id="q" placeholder="запрос" autofocus>
  <button type="submit">Искать</button>
</form>
<div class="hint">Ответ логируется в консоль браузера (F12) и дублируется ниже.</div>
<pre id="out">// здесь появится сырой JSON от api.music.yandex.net</pre>
<script>
  const form = document.getElementById('form');
  const input = document.getElementById('q');
  const out = document.getElementById('out');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    out.textContent = 'загрузка…';
    try {
      const res = await fetch('/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      console.log(data);
      out.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      out.textContent = 'Ошибка: ' + err.message;
    }
  });
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/search') {
    const q = url.searchParams.get('q') ?? '';
    try {
      const data = await music.request(
        `/search?text=${encodeURIComponent(q)}&type=all&page=1&pageSize=50`,
      );
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => console.log(`search-ui: http://localhost:${PORT}`));

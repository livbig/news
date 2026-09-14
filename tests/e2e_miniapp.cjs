// М3.3: E2E миниаппа в реальном Chromium (Playwright) против tests/e2e_serve.py.
// Подпись initData — как у Telegram: строка url-encoded, hash по DECODED-парам.
// Сценарии: A) валидный initData → UI жив (источники, toggle, слоты, persist);
//           B) пустой initData → fallback-текст с диагностикой (sdk=да, initData=0).
// env: E2E_BASE, E2E_TOKEN, E2E_CHAT; NODE_PATH до node_modules с playwright.
const { chromium } = require('playwright');
const crypto = require('crypto');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8891';
const TOKEN = process.env.E2E_TOKEN || '70000:E2ETEST';
const CHAT = parseInt(process.env.E2E_CHAT || '700111222', 10);

function signInitData(tok) {
  const fields = {
    auth_date: '1760000000',
    query_id: 'AAFe2etest',
    signature: 'AAIBm3R0YXlrZWQ',
    user: JSON.stringify({ id: CHAT, first_name: 'Тест Юзер' }),
  };
  const encoded = Object.entries(fields)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const check = Object.keys(fields).sort()
    .map(k => `${k}=${fields[k]}`).join('\n');  // hash по DECODED-значениям
  const secret = crypto.createHmac('sha256', tok || TOKEN).update('WebAppData').digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return `${encoded}&hash=${hash}`;
}

async function newPage(ctx, initData) {
  const page = await ctx.newPage();
  // стаб SDK: перехватываем настоящий telegram-web-app.js — детерминированно
  // и без сети; сам факт перехвата доказывает, что страница его подключает.
  await page.route('**/telegram.org/js/telegram-web-app.js', route =>
    route.fulfill({ contentType: 'application/javascript',
      body: 'window.Telegram={WebApp:{initData:' + JSON.stringify(initData) +
            ',ready:function(){},expand:function(){}}};' }));
  return page;
}

(async () => {
  const results = [];
  const step = (name, ok, extra) => {
    results.push({ name, ok });
    console.error((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : ''));
  };
  const browser = await chromium.launch();
  try {
    // --- A: валидный initData → полный UI-путь -----------------------------
    let ctx = await browser.newContext();
    let page = await newPage(ctx, signInitData());
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    step('A1 страница подключает SDK',
         (await page.content()).includes('telegram-web-app.js'));
    await page.waitForSelector('#srcs h3:has-text("E2E Источник Один")',
                               { timeout: 5000 });
    const two = await page.locator('#srcs h3:has-text("E2E Источник Два")').count();
    const c09 = await page.isChecked('label:has-text("09:00") input');
    step('A2 источники и слоты загружены', two === 1 && c09);
    await page.locator('#srcs button:has-text("Выключить")').first().click();
    await page.waitForSelector('#srcs h3.off:has-text("Один")', { timeout: 5000 });
    step('A3 toggle выключает источник', true);
    await page.check('label:has-text("21:00") input');
    await page.click('#save');
    await page.waitForSelector('#msg:has-text("21:00")', { timeout: 5000 });
    step('A4 расписание сохранено', true);
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#srcs h3:has-text("E2E Источник Один")',
                               { timeout: 5000 });
    const stillOff = await page.locator('#srcs h3.off:has-text("Один")').count();
    const c21 = await page.isChecked('label:has-text("21:00") input');
    step('A5 состояние пережило перезагрузку', stillOff === 1 && c21);
    await ctx.close();

    // --- B: пустой initData → fallback с диагностикой ----------------------
    ctx = await browser.newContext();
    page = await newPage(ctx, '');
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('body:has-text("Панель доступна из Telegram")',
                               { timeout: 5000 });
    let body = await page.textContent('body');
    step('B1 fallback показывает диагностику',
         body.includes('sdk=да') && body.includes('initData=0') &&
         body.includes('причина:'),
         body.replace(/\s+/g, ' ').trim().slice(0, 220));
    await ctx.close();

    // --- C: подпись чужим токеном → вердикт «НЕ совпала» + user_id ---------
    ctx = await browser.newContext();
    page = await newPage(ctx, signInitData('9:WRONGTOKEN'));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('body:has-text("НЕ совпала")', { timeout: 5000 });
    body = await page.textContent('body');
    step('C1 чужой токен: вердикт diag виден',
         body.includes('НЕ совпала') && body.includes(`user=${CHAT}`),
         body.replace(/\s+/g, ' ').trim().slice(0, 220));
    await ctx.close();
  } finally {
    await browser.close();
  }
  const ok = results.every(r => r.ok);
  console.log(JSON.stringify({ ok, results }));
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('E2E fatal:', e); process.exit(2); });

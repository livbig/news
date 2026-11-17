// Сторож новостного контура: служба жива, сбор не отстал, канал наружу работает, мост забирает
// апдейты. Если что-то сломано — пишет владельцу в Telegram (одна строка, без стеков).
import { execFileSync } from 'node:child_process';

import { loadConfig } from '/srv/news/server/src/config.js';
import { telegramProblems } from '../src/heartbeat-check.js';

const config = loadConfig();
const token = process.env.NEWS_BOT_TOKEN ?? config.botToken;
const chatId = Number(process.env.NEWS_CHAT_ID ?? config.allowedChatId);

async function say(text) {
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  }).catch(() => {});
}

function bridgeActive() {
  try {
    execFileSync('systemctl', ['is-active', '--quiet', 'news-bridge'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const problems = [];

try {
  const response = await fetch(`http://127.0.0.1:${config.apiPort}/api/health`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) problems.push(`служба newsd отвечает ${response.status}`);
} catch (error) {
  problems.push(`служба newsd не отвечает: ${error?.message ?? error}`);
}

try {
  const state = await (await fetch(`http://127.0.0.1:${config.apiPort}/api/state`, {
    headers: { authorization: `Bearer ${config.apiToken}` },
    signal: AbortSignal.timeout(8000),
  })).json();
  const lastCollect = Date.parse(state.lastCollectAt ?? '');
  if (Number.isFinite(lastCollect)) {
    const lagMin = Math.round((Date.now() - lastCollect) / 60_000);
    if (lagMin > 90) problems.push(`сбор отстал на ${lagMin} мин`);
  }
  const analysis = state.analysis ?? {};
  if ((analysis.pending ?? 0) > 500) problems.push(`не разобрано ${analysis.pending} пунктов`);
} catch (error) {
  problems.push(`состояние не читается: ${error?.message ?? error}`);
}

try {
  const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { signal: AbortSignal.timeout(8000) });
  problems.push(...telegramProblems(await response.json(), { bridgeActive: bridgeActive() }));
} catch (error) {
  problems.push(`Telegram недоступен: ${error?.message ?? error}`);
}

if (problems.length) {
  const text = `⚠️ <b>Новостной контур</b>\n${problems.map((line) => `• ${line}`).join('\n')}`;
  console.log(text);
  await say(text);
  // алерт не дойдёт, если сеть мертва: тогда сигнал — failed-юнит в systemctl --failed
  process.exitCode = 1;
} else {
  console.log('сторож: всё в порядке');
}

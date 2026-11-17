/**
 * Уведомление владельцу от лица бота: node --env-file=... app/scripts/notify.mjs "текст".
 * Токен только из env, в argv и логи не попадает.
 */
const token = process.env.HELPER_BOT_TOKEN;
const chatId = process.env.HELPER_ADMIN_USER_ID;
const text = process.argv.slice(2).join(' ').trim();
if (!token || !chatId) { console.error('нужны HELPER_BOT_TOKEN и HELPER_ADMIN_USER_ID'); process.exit(1); }
if (!text) { console.error('нужен текст'); process.exit(1); }

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_notification: false }),
});
const body = await res.json().catch(() => null);
console.log(res.status, body?.ok ? `отправлено (id ${body.result.message_id})` : body?.description ?? 'ошибка');
process.exit(body?.ok ? 0 : 1);

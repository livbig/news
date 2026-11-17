// Разбор ответа getWebhookInfo в список проблем: канал наружу, токен, живость моста.
// Вынесено из scripts/heartbeat.mjs, чтобы проверялось тестом без сети.

export function telegramProblems(webhookInfo, { bridgeActive } = {}) {
	const problems = [];
	if (!webhookInfo?.ok) {
		problems.push('Telegram недоступен или токен отвергнут (getWebhookInfo)');
	} else if ((webhookInfo.result?.pending_update_count ?? 0) > 0) {
		problems.push(`мост news-bridge не забирает апдейты: ${webhookInfo.result.pending_update_count} в очереди`);
	}
	if (bridgeActive === false) problems.push('служба news-bridge не запущена');
	return problems;
}

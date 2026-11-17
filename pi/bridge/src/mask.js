/**
 * Маскирование секретов и персональных данных для логов и сообщений об ошибках.
 */

const BOT_TOKEN_RE = /(\d{5,}:[A-Za-z0-9_-]{15,})/g;
// Телефоны так, как их пишут люди: +7 916 123-45-67, 8 (916) 123 45 67, 916 123-45-67, 495 123-45-67.
const PHONE_PATTERNS = [
	/(?<![\d+])\+?[78][\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}(?!\d)/g,
	/(?<!\d)9\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g,
	/(?<!\d)(?:495|499)[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g,
];
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/** Никогда не печатает переданное значение целиком. */
export function maskSecret(value) {
	if (typeof value !== 'string' || value.length === 0) return '<пусто>';
	if (value.length <= 10) return '***';
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Прячет всё похожее на токен бота внутри произвольного текста. */
export function redactSecrets(text) {
	if (typeof text !== 'string' || text.length === 0) return text;
	return text.replace(BOT_TOKEN_RE, (m) => maskSecret(m));
}

/**
 * Прячет телефоны и почты клиента: в `bridge-*.txt` цитата сообщения фаундера остаётся, а ПДн — нет.
 * Имена регуляркой не ловятся — поэтому в лог идёт только начало сообщения (120 символов).
 */
export function redactPii(text) {
	if (typeof text !== 'string' || text.length === 0) return text;
	let masked = text;
	for (const pattern of PHONE_PATTERNS) masked = masked.replace(pattern, '[телефон]');
	return masked.replace(EMAIL_RE, '[почта]');
}

/** Оборачивает ошибку в строку без утечки токена. */
export function errorText(error) {
	const raw = error instanceof Error ? error.message || error.name : String(error);
	return redactSecrets(raw);
}

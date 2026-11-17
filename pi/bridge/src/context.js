/**
 * Контекст сообщения для агента. Требование владельца 29.10.2026: напоминание приходит туда, где его
 * попросили, — значит агент должен знать чат, его тип и автора. Значения уходят в окружение процесса pi
 * (PI_CHAT_ID/PI_CHAT_TYPE/PI_USER_ID/PI_USER_NAME/PI_THREAD_ID), инструменты читают их из process.env.
 */

/** Имя автора по-человечески: «Максим», а не «Максим Швец @shvets9o». */
export function userName(from = {}) {
	const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
	return full || from.username || (from.id === undefined ? undefined : String(from.id));
}

/**
 * Окружение для процесса pi: только известные значения, undefined-поля spawn не передаёт.
 * `thread_id` — тема форума; в личке и обычной группе её нет.
 */
export function messageContext(ctx = {}) {
	const chat = ctx.chat ?? {};
	const from = ctx.from ?? {};
	const threadId = ctx.message?.message_thread_id;
	return clean({
		PI_CHAT_ID: chat.id,
		PI_CHAT_TYPE: chat.type,
		PI_USER_ID: from.id,
		PI_USER_NAME: userName(from),
		PI_THREAD_ID: threadId,
	});
}

/** Строка для лога: «чат -1003432441991 · supergroup · тема 12 · Максим (710223847)». */
export function contextLine(context = {}) {
	const parts = [`чат ${context.PI_CHAT_ID ?? '—'}`, context.PI_CHAT_TYPE ?? '—'];
	if (context.PI_THREAD_ID) parts.push(`тема ${context.PI_THREAD_ID}`);
	parts.push(`${context.PI_USER_NAME ?? '—'} (${context.PI_USER_ID ?? '—'})`);
	return parts.join(' · ');
}

function clean(values) {
	const out = {};
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined || value === null || value === '') continue;
		out[key] = String(value);
	}
	return out;
}

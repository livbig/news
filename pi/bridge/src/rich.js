/**
 * Rich Messages — общий «предохранитель» для живого сообщения и ответов команд.
 *
 * Один сбой метода не должен навсегда лишать чат таблиц и разметки: после ошибки
 * пропускаем N сообщений по классическому пути, потом пробуем rich снова.
 */

export const RICH_RETRY_MESSAGES = 10;

export function describeError(error) {
	return error?.description ?? error?.message ?? String(error);
}

export function createRichGate({ retryAfter = RICH_RETRY_MESSAGES } = {}) {
	let cooldown = 0;
	let disabled = false;

	return {
		/** Можно ли пробовать rich для этого сообщения; окно повтора уменьшается на каждом сообщении. */
		take() {
			if (disabled) return false;
			if (cooldown === 0) return true;
			cooldown -= 1;
			return cooldown === 0;
		},
		fail(error, log) {
			cooldown = retryAfter;
			log?.warn(
				`rich-сообщения не сработали (${describeError(error)}); ${retryAfter} сообщений — классический путь, потом попробую снова`,
			);
		},
		ok() {
			cooldown = 0;
		},
		reset(supported = true) {
			disabled = !supported;
			cooldown = 0;
		},
		get cooldown() {
			return cooldown;
		},
		get disabled() {
			return disabled;
		},
	};
}

/**
 * Троттлинг правок живого сообщения: не чаще одного вызова API за intervalMs на ключ (чат).
 * Ждём ближайший допустимый момент, а не отбрасываем обновление: последняя версия текста
 * всегда уходит (core.telegram.org/bots/faq: не больше ~1 сообщения в секунду в чат).
 */

export function createThrottle({
	intervalMs = 750,
	now = Date.now,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
} = {}) {
	const lastRun = new Map();
	const timers = new Map();
	const pending = new Map();

	function run(key) {
		const fn = pending.get(key);
		pending.delete(key);
		timers.delete(key);
		if (!fn) return undefined;
		lastRun.set(key, now());
		return fn();
	}

	/** Интервал может зависеть от режима (число или функция). */
	function interval() {
		return typeof intervalMs === 'function' ? intervalMs() : intervalMs;
	}

	/** Планирует fn: сейчас, если интервал прошёл, иначе — в ближайший допустимый момент. */
	function schedule(key, fn) {
		pending.set(key, fn);
		if (timers.has(key)) return;
		const last = lastRun.get(key);
		const wait = last === undefined ? 0 : Math.max(0, last + interval() - now());
		if (wait === 0) {
			run(key);
			return;
		}
		timers.set(key, setTimer(() => run(key), wait));
	}

	/** Немедленно выполняет отложенное (используется при финализации хода). */
	function flush(key) {
		if (timers.has(key)) {
			clearTimer(timers.get(key));
			timers.delete(key);
		}
		return run(key);
	}

	function cancel(key) {
		if (timers.has(key)) clearTimer(timers.get(key));
		timers.delete(key);
		pending.delete(key);
	}

	return { schedule, flush, cancel, isPending: (key) => pending.has(key) };
}

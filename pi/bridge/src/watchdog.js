/**
 * Два таймера хода: бездействие (сбрасывается на каждом событии pi) и абсолютный потолок.
 * Вынесено из bridge.js, чтобы проверяться на фейковых таймерах без ожидания минут.
 */

export function createTurnWatchdog({
	inactivityMs,
	ceilingMs,
	onIdle,
	onCeiling,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
} = {}) {
	let idleTimer;
	let ceilingTimer;
	let closed = false;

	function armIdle() {
		if (closed) return;
		clearTimer(idleTimer);
		idleTimer = setTimer(() => {
			idleTimer = undefined;
			if (closed) return;
			onIdle?.();
			armIdle();
		}, inactivityMs);
		idleTimer?.unref?.();
	}

	armIdle();
	ceilingTimer = setTimer(() => {
		if (closed) return;
		closed = true;
		clearTimer(idleTimer);
		idleTimer = undefined;
		onCeiling?.();
	}, ceilingMs);
	ceilingTimer?.unref?.();

	return {
		/** Любое событие pi: значит, процесс жив и работает над ходом. */
		touch: armIdle,
		stop() {
			if (closed) return;
			closed = true;
			clearTimer(idleTimer);
			clearTimer(ceilingTimer);
			idleTimer = undefined;
			ceilingTimer = undefined;
		},
		get closed() {
			return closed;
		},
	};
}

/** «40 мс» / «12 с» / «20 мин» — для заметок в чате и логов. */
export function formatSpan(ms) {
	const value = Number(ms ?? 0);
	if (!Number.isFinite(value) || value <= 0) return '0 с';
	if (value >= 60_000) return `${Math.round(value / 60_000)} мин`;
	if (value >= 1_000) return `${Math.round(value / 1_000)} с`;
	return `${Math.round(value)} мс`;
}

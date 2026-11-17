/**
 * Пул процессов pi: **один процесс на сессию** (docs/DECISIONS.md, D12).
 *
 * Зачем так, а не `switch_session` в одном процессе: у каждой сессии свой рабочий каталог,
 * свои расширения/MCP и своя очередь — общий процесс заставлял бы их переключать по кругу.
 * Процесс поднимается лениво (первое сообщение/открытие) и гасится по бездействию.
 * Ключ записи для сессии — её путь, поэтому два чата в одной сессии делят один процесс.
 */

export function createSessionPool({
	cliPath,
	log,
	createPi,
	onEvent = () => {},
	idleMs = 30 * 60_000,
	maxIdle = 3,
	maxProcesses = 4,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	now = Date.now,
} = {}) {
	const entries = new Map();
	const unboundByChat = new Map();
	let counter = 0;

	const keyFor = (sessionPath) => `session:${sessionPath}`;

	function create(sessionPath, cwd, chatKey, env, profile) {
		// env — контекст сообщения (PI_CHAT_*): процесс pi живёт на сессию, поэтому ставится при spawn.
		// shortcut: сессию, открытую из двух чатов, обслуживает процесс с контекстом того чата, что поднял его;
		// когда напоминания понадобятся в общих сессиях — перезапускать процесс при смене чата.
		const pi = createPi({ cliPath, cwd, args: sessionPath ? ['--session', sessionPath] : [], env, profile });
		const entry = {
			key: sessionPath ? keyFor(sessionPath) : `unbound:${(counter += 1)}`,
			chatKey,
			profile,
			pi,
			cwd,
			session: { path: sessionPath, id: undefined, name: undefined },
			busy: false,
			queue: [],
			turn: null,
			/** Индикаторы расширений этого процесса pi: ключ → текст (extension_ui_request setStatus). */
			statuses: new Map(),
			idleTimer: undefined,
			lastUsed: now(),
			disposed: false,
		};
		entries.set(entry.key, entry);
		if (chatKey) unboundByChat.set(chatKey, entry);
		pi.onEvent((event) => onEvent(entry, event));
		log?.debug(`пул: процесс ${entry.key} (cwd ${cwd})`);
		return entry;
	}

	async function refresh(entry) {
		const current = await entry.pi.getState();
		entry.session = { path: current.sessionFile, id: current.sessionId, name: current.sessionName };
		return entry.session;
	}

	function touch(entry) {
		entry.lastUsed = now();
	}

	function dispose(entry) {
		if (entry.disposed) return Promise.resolve();
		entry.disposed = true;
		clearTimer(entry.idleTimer);
		entries.delete(entry.key);
		if (entry.chatKey && unboundByChat.get(entry.chatKey) === entry) unboundByChat.delete(entry.chatKey);
		log?.info(`пул: гашу процесс ${entry.key}`);
		return Promise.resolve(entry.pi.stop()).catch(() => {});
	}

	/** Гасит старые бездействующие процессы: держим maxIdle сверх того, что берут сейчас. */
	function evictIdle(keep) {
		const idle = [...entries.values()].filter(
			(entry) => entry !== keep && !entry.busy && entry.queue.length === 0 && !entry.turn,
		);
		if (idle.length <= maxIdle) return;
		idle.sort((a, b) => a.lastUsed - b.lastUsed);
		for (const victim of idle.slice(0, idle.length - maxIdle)) void dispose(victim);
	}

	function capacityError() {
		return new Error(`занято ${maxProcesses} сессий, попробуй позже или /stop (PI_TG_MAX_PROCESSES)`);
	}

	function assertCapacity() {
		if (entries.size < maxProcesses) return;
		// Сначала освобождаем лишние бездействующие (та же политика, что после spawn), потом отказ.
		evictIdle();
		if (entries.size >= maxProcesses) throw capacityError();
	}

	async function start(entry) {
		// Потолок проверяем до spawn: новый процесс уже вставлен в entries, поэтому > maxProcesses.
		if (entries.size > maxProcesses) {
			await dispose(entry);
			throw capacityError();
		}
		try {
			await entry.pi.start();
		} catch (error) {
			await dispose(entry);
			throw error;
		}
		touch(entry);
		evictIdle(entry);
		if (!entry.idleTimer) release(entry);
		await refresh(entry).catch(() => {});
		return entry;
	}

	/**
	 * Процесс для сессии (по пути) или для чата без сессии.
	 * @param {{ sessionPath?: string, cwd?: string, chatKey?: string, env?: Record<string,string> }} target
	 */
	async function acquire({ sessionPath, cwd, chatKey, env, profile } = {}) {
		if (sessionPath) {
			const existing = entries.get(keyFor(sessionPath));
			if (existing) {
				touch(existing);
				if (!existing.idleTimer) release(existing);
				return existing;
			}
			assertCapacity();
			return start(create(sessionPath, cwd, undefined, env, profile));
		}
		const existing = unboundByChat.get(chatKey);
		if (existing) {
			touch(existing);
			if (!existing.idleTimer) release(existing);
			return existing;
		}
		assertCapacity();
		return start(create(undefined, cwd, chatKey, env, profile));
	}

	/** Новая сессия для чата: старый несвязанный процесс чата гасится. */
	async function acquireNew({ cwd, chatKey, env, profile } = {}) {
		const previous = unboundByChat.get(chatKey);
		if (previous) await dispose(previous);
		assertCapacity();
		const entry = await start(create(undefined, cwd, chatKey, env, profile));
		release(entry);
		return entry;
	}

	/** Сессия стала известна (первое сообщение) — переводим запись под ключ пути. */
	function rekey(entry, sessionPath) {
		const key = keyFor(sessionPath);
		if (entry.key === key) return entry;
		const existing = entries.get(key);
		if (existing && existing !== entry) {
			// та же сессия уже открыта другим чатом — живём в одном процессе
			void dispose(entry);
			return existing;
		}
		entries.delete(entry.key);
		if (entry.chatKey && unboundByChat.get(entry.chatKey) === entry) unboundByChat.delete(entry.chatKey);
		entry.key = key;
		entry.chatKey = undefined;
		entry.session.path = sessionPath;
		entries.set(key, entry);
		touch(entry);
		log?.debug(`пул: ${key}`);
		return entry;
	}

	/** Планирует гашение бездействующего процесса; при возобновлении работы таймер снимается. */
	function release(entry) {
		if (entry.disposed) return;
		clearTimer(entry.idleTimer);
		entry.idleTimer = setTimer(() => {
			entry.idleTimer = undefined;
			if (entry.busy || entry.queue.length > 0 || entry.turn) {
				release(entry);
				return;
			}
			void dispose(entry);
		}, idleMs);
		entry.idleTimer?.unref?.();
	}

	return {
		acquire,
		acquireNew,
		rekey,
		release,
		refresh,
		dispose,
		size: () => entries.size,
		list: () => [...entries.values()],
		get: (sessionPath) => entries.get(keyFor(sessionPath)),
		/** Живая запись для чата/сессии — без создания нового процесса (/stop). */
		find: ({ sessionPath, chatKey } = {}) =>
			sessionPath ? entries.get(keyFor(sessionPath)) : unboundByChat.get(chatKey),
		async stopAll() {
			await Promise.all([...entries.values()].map((entry) => dispose(entry)));
		},
	};
}

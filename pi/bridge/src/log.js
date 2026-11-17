/**
 * Минимальный логгер. Тексты сообщений в чат намеренно не логируются на info.
 */

import { redactSecrets } from './mask.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger({ level = 'info', out = console, name = 'pi-tg' } = {}) {
	const threshold = LEVELS[level] ?? LEVELS.info;

	const emit = (lvl, args) => {
		if (LEVELS[lvl] < threshold) return;
		const parts = args.map((a) => (typeof a === 'string' ? a : stringify(a)));
		const line = `[${new Date().toISOString().slice(11, 19)} ${name} ${lvl}] ${redactSecrets(parts.join(' '))}`;
		(lvl === 'error' || lvl === 'warn' ? out.error : out.log).call(out, line);
	};

	return {
		level,
		debug: (...a) => emit('debug', a),
		info: (...a) => emit('info', a),
		warn: (...a) => emit('warn', a),
		error: (...a) => emit('error', a),
		child: (suffix) => createLogger({ level, out, name: `${name}:${suffix}` }),
	};
}

function stringify(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

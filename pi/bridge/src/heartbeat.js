/**
 * Отметка «мост жив» для сторожа (`scripts/heartbeat.mjs` в ассистенте): файл `bridge-heartbeat.json`
 * обновляется раз в минуту, пока процесс жив. Молчащий файл — мост висит или остановлен.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HEARTBEAT_FILE = 'bridge-heartbeat.json';
export const HEARTBEAT_MS = 60_000;

export function startHeartbeat({ dir, periodMs = HEARTBEAT_MS, now = Date.now, log } = {}) {
	if (!dir) return { path: undefined, beat: () => {}, stop: () => {} };
	const path = join(dir, HEARTBEAT_FILE);
	const beat = () => {
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(path, `${JSON.stringify({ at: new Date(now()).toISOString(), pid: process.pid })}\n`);
		} catch (error) {
			log?.warn(`отметка heartbeat ${path}: ${error.message}`);
		}
	};
	beat();
	const timer = setInterval(beat, periodMs);
	timer.unref?.();
	return {
		path,
		beat,
		stop() {
			clearInterval(timer);
		},
	};
}

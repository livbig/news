/**
 * Перенос данных из pi-telegram (badlogic) — того же бота, но прежнего моста.
 *
 * Старый бот живёт расширением внутри сессии pi и держит свой конфиг в
 * `~/.pi/agent/telegram.json` (см. README pi-telegram: «The extension stores config in
 * ~/.pi/agent/telegram.json»). Если ботом уже пользовались, там лежат спаренный пользователь
 * и offset getUpdates — переносим их, чтобы не спариваться заново и не переигрывать
 * доставленные апдейты. Токен нигде не печатаем и на диск не переносим.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LEGACY_CONFIG_PATH = join(homedir(), '.pi', 'agent', 'telegram.json');

export async function adoptLegacyPairing({ state, botToken, file = LEGACY_CONFIG_PATH, log } = {}) {
	let legacy;
	try {
		legacy = JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return { adopted: false, reason: 'нет файла или он нечитаем' };
	}
	if (!legacy || typeof legacy !== 'object') return { adopted: false, reason: 'не объект' };
	if (legacy.botToken !== botToken) return { adopted: false, reason: 'другой бот' };

	const result = { adopted: false, allowedUserId: undefined, lastUpdateId: undefined };
	if (state.get().allowedUserId === undefined && typeof legacy.allowedUserId === 'number') {
		state.setPairedUser(legacy.allowedUserId);
		result.allowedUserId = legacy.allowedUserId;
	}
	if (state.get().lastUpdateId === undefined && typeof legacy.lastUpdateId === 'number') {
		state.setLastUpdateId(legacy.lastUpdateId);
		result.lastUpdateId = legacy.lastUpdateId;
	}
	result.adopted = result.allowedUserId !== undefined || result.lastUpdateId !== undefined;
	if (result.adopted) {
		await state.save();
		log?.warn(
			`перенёс данные из ${file}: пользователь ${result.allowedUserId ?? '—'}, offset ${result.lastUpdateId ?? '—'}. ` +
				'Старый мост (pi-telegram) должен быть отключён, иначе будет конфликт getUpdates.',
		);
	}
	return result;
}

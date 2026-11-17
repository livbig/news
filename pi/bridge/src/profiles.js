/**
 * Профили пользователей Дворецкого: два человека — две зоны на диске.
 *
 * Ключ доступа — Telegram user id: всё остальное (каталоги, память, сессии, OS-пользователь)
 * выводится из него. Список берётся из HELPER_PROFILES (`slug:userId[:admin]`), корень — HELPER_ROOT.
 * Цифры uid/gid нужны, чтобы дочерний pi работал от имени зоны, а не от root (см. zone-cli.js).
 *
 * Если профилей нет (локальная разработка на Mac, тесты), мост работает по старой схеме —
 * один каталог и спаривание; это осознанный компромисс: боевой режим всегда с профилями.
 */

import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

export class ProfilesError extends Error {}

const SLUG_RE = /^[a-z][a-z0-9-]{1,20}$/;

/**
 * @param {Record<string,string|undefined>} env
 * @param {(name: string) => {uid?: number, gid?: number}} [lookup] — для тестов подменяется
 * @returns {{ root: string, osPrefix: string, profiles: object[], byUser: Map<number, object> }}
 */
export function loadProfiles(env = process.env, lookup = systemIds) {
	const raw = String(env.HELPER_PROFILES ?? '').trim();
	const root = String(env.HELPER_ROOT ?? '/srv/dvoretsky').trim();
	const osPrefix = String(env.HELPER_OS_PREFIX ?? 'dv-').trim();
	if (!isAbsolute(root)) throw new ProfilesError(`HELPER_ROOT должен быть абсолютным путём: «${root}»`);

	if (!raw) return { root, osPrefix, profiles: [], byUser: new Map() };

	const profiles = [];
	const byUser = new Map();
	const seenSlugs = new Set();

	for (const item of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
		const [slugRaw, idRaw, roleRaw] = item.split(':');
		const slug = (slugRaw ?? '').trim();
		if (!SLUG_RE.test(slug)) {
			throw new ProfilesError(`профиль «${item}»: slug — строчные латинские буквы, цифры и дефис, 2–21 символа`);
		}
		if (seenSlugs.has(slug)) throw new ProfilesError(`профиль «${slug}» указан дважды`);
		seenSlugs.add(slug);

		const userId = Number((idRaw ?? '').trim());
		if (!Number.isInteger(userId) || userId <= 0) {
			throw new ProfilesError(`профиль «${slug}»: id пользователя Telegram — целое положительное число`);
		}
		if (byUser.has(userId)) throw new ProfilesError(`id ${userId} указан дважды`);

		const role = (roleRaw ?? '').trim();
		if (role && role !== 'admin') {
			throw new ProfilesError(`профиль «${slug}»: третий элемент — только «admin» или пусто`);
		}
		profiles.push(buildProfile({ slug, userId, admin: role === 'admin', root, osPrefix, lookup }));
		byUser.set(userId, profiles[profiles.length - 1]);
	}

	const admins = profiles.filter((profile) => profile.admin).length;
	if (profiles.length && admins !== 1) {
		throw new ProfilesError(`администратор должен быть ровно один, найдено ${admins}`);
	}
	return { root, osPrefix, profiles, byUser };
}

/** Профиль по Telegram id: единственная точка, где решается «пускать или нет». */
export function profileFor(state, userId) {
	const id = Number(userId);
	return Number.isInteger(id) ? state.byUser.get(id) : undefined;
}

export function buildProfile({ slug, userId, admin, root, osPrefix, lookup }) {
	const home = join(root, 'users', slug);
	const osUser = `${osPrefix}${slug}`;
	const { uid, gid } = lookup(osUser) ?? {};
	if (uid !== undefined && (!Number.isInteger(uid) || uid <= 0)) {
		throw new ProfilesError(`профиль «${slug}»: uid пользователя ${osUser} не число`);
	}
	return {
		slug,
		userId,
		admin,
		osUser,
		uid,
		gid,
		home,
		workDir: join(home, 'work'),
		dataDir: join(home, 'work', 'files'),
		agentDir: join(home, 'pi'),
		sessionDir: join(home, 'pi', 'sessions'),
		memoryDb: join(home, 'memory.db'),
		agentRules: join(home, 'work', 'AGENTS.md'),
	};
}

/**
 * uid/gid OS-пользователя. На Mac профилей нет — вернётся null, и zone-cli запустит pi как есть;
 * на Pi пользователь обязан существовать, иначе ребёнок получит файлы root'а.
 */
export function systemIds(name) {
	try {
		const uid = Number(execFileSync('id', ['-u', name], { encoding: 'utf8' }).trim());
		const gid = Number(execFileSync('id', ['-g', name], { encoding: 'utf8' }).trim());
		if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
		return { uid, gid };
	} catch {
		return null;
	}
}

/** Проверка, что путь лежит внутри зоны профиля (для файлов из чата и маркеров [file:…]). */
export function insideZone(profile, path) {
	const root = resolve(profile.home);
	const target = resolve(path);
	return target === root || target.startsWith(`${root}/`);
}

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProfilesError, buildProfile, insideZone, loadProfiles, profileFor } from '../src/profiles.js';

const env = {
	HELPER_ROOT: '/srv/dvoretsky',
	HELPER_OS_PREFIX: 'dv-',
	HELPER_PROFILES: 'livbig:111:admin,aliiinam:222',
};
const ids = (name) => ({ 'dv-livbig': { uid: 1001, gid: 1002 }, 'dv-aliiinam': { uid: 1002, gid: 1003 } })[name] ?? null;

test('два профиля: пути внутри своей зоны, admin один', () => {
	const state = loadProfiles(env, ids);
	assert.equal(state.profiles.length, 2);
	const livbig = profileFor(state, 111);
	const alina = profileFor(state, 222);
	assert.equal(livbig.admin, true);
	assert.equal(alina.admin, false);
	assert.equal(livbig.workDir, '/srv/dvoretsky/users/livbig/work');
	assert.equal(livbig.agentDir, '/srv/dvoretsky/users/livbig/pi');
	assert.equal(livbig.sessionDir, '/srv/dvoretsky/users/livbig/pi/sessions');
	assert.equal(livbig.memoryDb, '/srv/dvoretsky/users/livbig/memory.db');
	assert.equal(livbig.osUser, 'dv-livbig');
	assert.equal(livbig.uid, 1001);
	assert.equal(profileFor(state, 333), undefined);
});

test('без профилей — пусто (режим разработки)', () => {
	const state = loadProfiles({}, ids);
	assert.deepEqual(state.profiles, []);
	assert.equal(state.byUser.size, 0);
});

test('ошибки конфигурации: slug, дубли, id, роль, admin', () => {
	assert.throws(() => loadProfiles({ ...env, HELPER_PROFILES: 'Livbig:1:admin' }, ids), ProfilesError);
	assert.throws(() => loadProfiles({ ...env, HELPER_PROFILES: 'aa:1:admin,aa:2' }, ids), ProfilesError);
	assert.throws(() => loadProfiles({ ...env, HELPER_PROFILES: 'aa:1:admin,bb:1' }, ids), ProfilesError);
	assert.throws(() => loadProfiles({ ...env, HELPER_PROFILES: 'aa:x:admin' }, ids), ProfilesError);
	assert.throws(() => loadProfiles({ ...env, HELPER_PROFILES: 'aa:1:root' }, ids), ProfilesError);
	assert.throws(() => loadProfiles({ ...env, HELPER_PROFILES: 'aa:1' }, ids), /администратор/);
	assert.throws(() => loadProfiles({ ...env, HELPER_ROOT: 'srv/x', HELPER_PROFILES: 'aa:1:admin' }, ids), ProfilesError);
});

test('нет OS-пользователя — профиль живёт без uid (dev), но пути те же', () => {
	const p = buildProfile({ slug: 'x', userId: 5, admin: true, root: '/srv/dvoretsky', osPrefix: 'dv-', lookup: () => null });
	assert.equal(p.uid, undefined);
	assert.equal(p.workDir, '/srv/dvoretsky/users/x/work');
});

test('insideZone: чужое и обход через .. не проходят', () => {
	const state = loadProfiles(env, ids);
	const livbig = profileFor(state, 111);
	assert.equal(insideZone(livbig, '/srv/dvoretsky/users/livbig/work/files/outbox/a.pdf'), true);
	assert.equal(insideZone(livbig, '/srv/dvoretsky/users/livbig'), true);
	assert.equal(insideZone(livbig, '/srv/dvoretsky/users/aliiinam/work/a.pdf'), false);
	assert.equal(insideZone(livbig, '/srv/dvoretsky/users/livbig/../aliiinam/memory.db'), false);
	assert.equal(insideZone(livbig, '/etc/passwd'), false);
});

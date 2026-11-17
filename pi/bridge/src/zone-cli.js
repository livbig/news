/**
 * Запуск pi от имени зоны профиля.
 *
 * Зачем отдельный файл: RpcClient сам вызывает `spawn("node", [cliPath, "--mode", "rpc"])` без
 * опций и не умеет менять uid. Поэтому мост передаёт ему этот файл вместо CLI, а тот через
 * setpriv сбрасывает привилегии и запускает настоящий pi уже от пользователя зоны.
 * Секрета в argv нет; RPC идёт по тому же stdio, что проброшен (stdio: inherit).
 *
 * Без root (Mac, тесты) или без uid — запускаем как есть: режим разработки, не боевой.
 */

import { spawn } from 'node:child_process';

const cli = process.env.PI_HELPER_CLI;
if (!cli) {
	console.error('zone-cli: не задан PI_HELPER_CLI (путь к dist/cli.js pi)');
	process.exit(1);
}

const uid = Number(process.env.PI_HELPER_UID);
const gid = Number(process.env.PI_HELPER_GID);
const args = [...process.argv.slice(2)];
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const command = isRoot && Number.isInteger(uid) && uid > 0
	? 'setpriv'
	: process.execPath;
const commandArgs = command === 'setpriv'
	? [`--reuid=${uid}`, `--regid=${gid || uid}`, '--init-groups', process.execPath, cli, ...args]
	: [cli, ...args];

const child = spawn(command, commandArgs, {
	stdio: 'inherit',
	env: process.env,
	cwd: process.cwd(),
});

child.on('error', (error) => {
	console.error(`zone-cli: не смог запустить pi: ${error.message}`);
	process.exit(1);
});
child.on('exit', (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});

// Мост гасит процесс через SIGTERM; pi должен получить сигнал и успеть закрыть сессию.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
	process.on(signal, () => child.kill(signal));
}

// Смещение getUpdates для поллера: между запусками не должно быть повторов.
// Пока вебхук не выставлен (нужен новый токен в Serverless-приложении), апдейты
// забирает воркер-поллер; смещение живёт в БД, потому что GitHub Actions без состояния.
import { getFsm, setFsm } from '../lib/store.js';

const KEY = 'poll:offset';

export default async function pollState(input = {}) {
  if (input.set !== undefined) {
    await setFsm(KEY, 'offset', { value: Number(input.set) });
    return JSON.stringify({ value: Number(input.set) });
  }
  const row = await getFsm(KEY);
  let value = 0;
  try {
    value = Number(JSON.parse(row?.data ?? '{}').value) || 0;
  } catch {
    value = 0;
  }
  return JSON.stringify({ value });
}

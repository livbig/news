// Служебный эндпоинт воркера: отметить задачу упавшей/завершённой без сводки.
import { setJob } from '../lib/store.js';

export default async function jobState(input = {}) {
  const jobId = Number(input.jobId);
  if (!jobId) throw new Error('jobState: нужен jobId');
  await setJob(jobId, { status: input.status ?? 'failed', stage: input.stage ?? 'error', detail: String(input.detail ?? '').slice(0, 500) });
  return JSON.stringify({ ok: true });
}

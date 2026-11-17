// HTTP внешнего мира на Pi: обычный fetch Node 22 + таймаут через AbortSignal.
// Логика ретраев та же, что была на платформе (NFR-04): 429/5xx повторяем, 4xx — нет.

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(message, { status = 0, code = 'HTTP' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** @returns {Promise<string>} тело ответа как текст (фиды и t.me/s — всегда текст) */
export async function getText(url, { retries = 3, headers = {}, timeoutMs = 45_000 } = {}) {
  const attempts = Math.max(1, retries);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'user-agent': 'personal-news-digest/3.0 (+pi)', accept: '*/*', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return await response.text();
      const code = statusCode(response.status);
      if (!RETRY_STATUS.has(response.status)) {
        throw new HttpError(`HTTP ${response.status} ${url}`, { status: response.status, code });
      }
      lastError = new HttpError(`HTTP ${response.status} ${url}`, { status: response.status, code });
    } catch (error) {
      if (error instanceof HttpError && error.status && !RETRY_STATUS.has(error.status)) throw error;
      lastError = error instanceof HttpError ? error : new HttpError(`NETWORK ${url}: ${error?.message ?? error}`, { code: 'NETWORK' });
    }
    if (attempt < attempts) await sleep(1000 * 2 ** (attempt - 1)); // backoff 1→2→4 c
  }
  throw lastError ?? new HttpError(`NETWORK ${url}`, { code: 'NETWORK' });
}

function statusCode(status) {
  if (status === 429) return 'HTTP_429';
  if (status === 403) return 'HTTP_403';
  if (status === 404) return 'HTTP_404';
  if (status >= 500) return 'HTTP_5XX';
  return `HTTP_${status}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

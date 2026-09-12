"""Общий HTTP-слой: httpx + ретраи с backoff (NFR-04, A2 сверки)."""
import logging
import time

import httpx

from pipeline.fetch import HEADERS

log = logging.getLogger("bot.http")

# план §3: connect 15 с / total 30 с
TIMEOUT = httpx.Timeout(30.0, connect=15.0)
RETRIES = 3
BACKOFF = (1, 2, 4)


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def http_get(url: str, *, headers: dict | None = None) -> httpx.Response:
    """GET c ретраями: сетевые ошибки/5xx/429 — до RETRIES повторов, backoff
    1→2→4 с. Прочие 4xx и исчерпание попыток — исключение наверх (изоляция
    отказа на вызывающем)."""
    last_exc: Exception = RuntimeError("нет попыток")
    for attempt in range(1, RETRIES + 2):  # 1 запрос + RETRIES повторов
        try:
            response = httpx.get(
                url, headers=headers or HEADERS, timeout=TIMEOUT, follow_redirects=True
            )
            if response.status_code == 429 or response.status_code >= 500:
                last_exc = httpx.HTTPStatusError(
                    f"HTTP {response.status_code}",
                    request=response.request,
                    response=response,
                )
            else:
                response.raise_for_status()
                return response
        except httpx.TransportError as exc:  # сеть: таймаут, обрыв, DNS
            last_exc = exc
        if attempt <= RETRIES:
            pause = BACKOFF[min(attempt - 1, len(BACKOFF) - 1)]
            log.warning(
                "GET %s: %s (попытка %d/%d) — повтор через %dc",
                url, last_exc, attempt, RETRIES + 1, pause,
            )
            _sleep(pause)
    raise last_exc

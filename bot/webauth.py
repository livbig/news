"""Общая авторизация Mini App (М3): проверка initData Telegram — единый код
для локального веб-сервера (webapp.py) и Vercel-функций (api/)."""
import hashlib
import hmac
import json
import urllib.parse


def verify_init_data(raw: str, token: str) -> dict | None:
    """Проверка подписи initData (доки Telegram Mini Apps): secret =
    HMAC_SHA256(key=token, msg=b'WebAppData'); hash = HMAC_SHA256(secret,
    data_check_string) над полученными парами (без hash) в алфавитном порядке."""
    pairs, got_hash = [], None
    for chunk in raw.split("&"):
        k, _, v = chunk.partition("=")
        if k == "hash":
            got_hash = v
        else:
            pairs.append((k, v))
    if not got_hash or not pairs:
        return None
    check = "\n".join(f"{k}={v}" for k, v in sorted(pairs))
    secret = hmac.new(token.encode(), b"WebAppData", hashlib.sha256).digest()
    calc = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, got_hash):
        return None
    try:
        user = json.loads(urllib.parse.unquote(dict(pairs).get("user", "")))
    except ValueError:
        return None
    return user if isinstance(user, dict) and "id" in user else None

"""Общая авторизация Mini App (М3): проверка initData Telegram — единый код
для локального веб-сервера (webapp.py) и Vercel-функций (api/)."""
import hashlib
import hmac
import json
import urllib.parse


def verify_init_data_detailed(raw: str, token: str) -> tuple[dict | None, str | None]:
    """Как verify_init_data, но возвращает (user, reason): reason — стадия
    отказа для диагностики клиенту (no_hash/hash_mismatch/…), без секретов."""
    pairs = urllib.parse.parse_qsl(raw, keep_blank_values=True)
    data = dict(pairs)
    got_hash = data.pop("hash", None)
    if not data:
        return None, "no_fields"
    if not got_hash:
        return None, "no_hash"
    check = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret = hmac.new(token.encode(), b"WebAppData", hashlib.sha256).digest()
    calc = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, got_hash):
        return None, "hash_mismatch"
    try:
        user = json.loads(data.get("user", ""))
    except ValueError:
        return None, "bad_user_json"
    if not (isinstance(user, dict) and "id" in user):
        return None, "no_user_field"
    return user, None


def verify_init_data(raw: str, token: str) -> dict | None:
    """Проверка подписи initData (доки Telegram Mini Apps): secret =
    HMAC_SHA256(key=token, msg=b'WebAppData'); hash = HMAC_SHA256(secret,
    data_check_string). initData приходит url-encoded, но data_check_string
    строится по ДЕКОДИРОВАННЫМ парам (без hash) в алфавитном порядке —
    пример в доках содержит распакованный JSON user={"id":...}."""
    user, _ = verify_init_data_detailed(raw, token)
    return user

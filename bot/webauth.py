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


def diagnose_init_data(raw: str, token: str) -> dict:
    """Диагностика initData БЕЗ авторизации (М3.4): парсит строку, достаёт
    user_id/auth_date/поля и проверяет подпись двумя алгоритмами —
    decoded (наш рабочий) и legacy-raw (encoded-пары). Секретов не возвращает;
    позволяет по одному скриншоту понять: чужой бот подписал (обе false) или
    другой алгоритм (alg_raw_ok=true)."""
    out = {"len": len(raw or ""), "fields": [], "user_id": None,
           "auth_date": None, "alg_decoded_ok": False, "alg_raw_ok": False}
    try:
        pairs = urllib.parse.parse_qsl(raw or "", keep_blank_values=True)
    except ValueError:
        return out
    data = dict(pairs)
    out["fields"] = sorted(data)
    got_hash = data.pop("hash", None)
    out["auth_date"] = data.get("auth_date")
    try:
        user = json.loads(data.get("user") or "null")
        if isinstance(user, dict):
            out["user_id"] = user.get("id")
    except ValueError:
        pass
    if got_hash and data:
        secret = hmac.new(token.encode(), b"WebAppData", hashlib.sha256).digest()
        check = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
        out["alg_decoded_ok"] = hmac.compare_digest(
            hmac.new(secret, check.encode(), hashlib.sha256).hexdigest(), got_hash)
        raw_pairs = sorted(p for p in (raw or "").split("&") if not p.startswith("hash="))
        out["alg_raw_ok"] = hmac.compare_digest(
            hmac.new(secret, "\n".join(raw_pairs).encode(),
                     hashlib.sha256).hexdigest(), got_hash)
    return out

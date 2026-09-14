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
    """Диагностика initData БЕЗ авторизации (М3.4/М3.5): парсит строку, достаёт
    user_id/auth_date/поля и проверяет подпись МАТРИЦЕЙ вариантов — секрет
    (HMAC(token,'WebAppData') | SHA256(token)) × кодировка значений (decoded |
    raw-as-received) × состав полей (все кроме hash | ещё и без signature).
    Возвращает matched-имя совпавшего варианта или None. Секретов не возвращает."""
    out = {"len": len(raw or ""), "fields": [], "user_id": None,
           "auth_date": None, "alg_decoded_ok": False, "alg_raw_ok": False,
           "matched": None, "variants": {}}
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
    if not (got_hash and data):
        return out
    raw_pairs = [p for p in (raw or "").split("&") if not p.startswith("hash=")]
    checks = {
        "decoded_all": "\n".join(f"{k}={v}" for k, v in sorted(data.items())),
        "decoded_nosig": "\n".join(f"{k}={v}" for k, v in
                                   sorted(data.items()) if k != "signature"),
        "raw_all": "\n".join(sorted(raw_pairs)),
        "raw_nosig": "\n".join(sorted(p for p in raw_pairs
                                      if not p.startswith("signature="))),
    }
    secrets = {
        "hmac": hmac.new(token.encode(), b"WebAppData", hashlib.sha256).digest(),
        "sha": hashlib.sha256(token.encode()).digest(),
    }
    for sname, secret in secrets.items():
        for cname, check in checks.items():
            calc = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
            ok = hmac.compare_digest(calc, got_hash)
            out["variants"][f"{sname}_{cname}"] = ok
            if ok and out["matched"] is None:
                out["matched"] = f"{sname}_{cname}"
    out["alg_decoded_ok"] = out["variants"].get("hmac_decoded_all", False)
    out["alg_raw_ok"] = out["variants"].get("hmac_raw_all", False)
    return out

"""М4: FSM-хранилище aiogram в БД (bot.db: PG/Supabase или sqlite-rollback).
Заменяет MemoryStorage для webhook-режима: инстансы serverless-функции
изолированы и перезапускаются, состояние опроса должно жить в БД. Sync-драйвер
psycopg/sqlite прячется за asyncio.to_thread (как хендлеры); коннект один на
инстанс, доступ сериализуется локом (по одному запросу на инстанс функции).
Таблица fsm: key TEXT PK, state TEXT, data TEXT (JSON-строка), updated_at —
касание состояния обновляет её автоматически (точка для cron-sweeper М5)."""
import asyncio
import json
import logging
import threading

from aiogram.fsm.storage.base import BaseStorage, StorageKey

from . import db

log = logging.getLogger("bot.pgstorage")


def _key(key: StorageKey) -> str:
    return f"{key.bot_id}:{key.chat_id}:{key.user_id}:{key.thread_id}"


class PgStorage(BaseStorage):
    def __init__(self, connection):
        self._conn = connection
        self._lock = threading.Lock()  # коннект не потокобезопасен, to_thread

    # --- sync-реализация -------------------------------------------------------

    def _set_state(self, key_str: str, state) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO fsm (key, state, data, updated_at)"
                " VALUES (%s, %s, '{}', %s)"
                " ON CONFLICT (key) DO UPDATE SET state=EXCLUDED.state,"
                " updated_at=EXCLUDED.updated_at",
                (key_str, state, db.now_iso()),
            )
            self._conn.commit()

    def _get_state(self, key_str: str):
        with self._lock:
            row = self._conn.execute(
                "SELECT state FROM fsm WHERE key=%s", (key_str,)
            ).fetchone()
        return row[0] if row else None

    def _set_data(self, key_str: str, data) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO fsm (key, state, data, updated_at)"
                " VALUES (%s, NULL, %s, %s)"
                " ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data,"
                " updated_at=EXCLUDED.updated_at",
                (key_str, json.dumps(data), db.now_iso()),
            )
            self._conn.commit()

    def _get_data(self, key_str: str) -> dict:
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM fsm WHERE key=%s", (key_str,)
            ).fetchone()
        raw = row[0] if row else None
        return json.loads(raw) if raw else {}

    # --- aiogram BaseStorage ----------------------------------------------------

    async def set_state(self, key: StorageKey, state=None) -> None:
        await asyncio.to_thread(self._set_state, _key(key), state)

    async def get_state(self, key: StorageKey):
        return await asyncio.to_thread(self._get_state, _key(key))

    async def set_data(self, key: StorageKey, data) -> None:
        await asyncio.to_thread(self._set_data, _key(key), data)

    async def get_data(self, key: StorageKey) -> dict:
        return await asyncio.to_thread(self._get_data, _key(key))

    async def reset_state(self, key: StorageKey, with_data: bool = True) -> None:
        await self.set_state(key, None)
        if with_data:
            await self.set_data(key, {})

    async def close(self) -> None:  # коннект живёт вместе с инстансом функции
        pass

    async def wait_until_ready(self) -> None:
        pass

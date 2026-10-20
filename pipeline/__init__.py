"""Пиннинг рабочего IP api.telegram.org.

DNS отдаёт 149.154.166.110, который на сети провайдера не отвечает на TCP
(из-за этого сводки не доставлялись неделями). 149.154.167.220 — тот же
балансер Telegram, отвечает напрямую и через VPN. Если однажды перестанет —
убрать пиннинг или заменить IP (симптом: таймауты getUpdates/sendMessage).

BOT_IP_PIN=0 отключает пиннинг (облачный хостинг с чистым DNS, 2026-09-14);
по умолчанию включён — поведение Mac не меняется.
"""
import os
import socket

_PINNED_HOSTS = {"api.telegram.org": "149.154.167.220"}

_getaddrinfo_orig = socket.getaddrinfo


def _getaddrinfo_pinned(host, *args, **kwargs):
    return _getaddrinfo_orig(_PINNED_HOSTS.get(host, host), *args, **kwargs)


if os.environ.get("BOT_IP_PIN", "1") != "0":
    socket.getaddrinfo = _getaddrinfo_pinned

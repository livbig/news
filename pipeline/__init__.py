"""Пиннинг рабочего IP api.telegram.org.

DNS отдаёт 149.154.166.110, который на сети провайдера не отвечает на TCP
(из-за этого сводки не доставлялись неделями). 149.154.167.220 — тот же
балансер Telegram, отвечает напрямую и через VPN. Если однажды перестанет —
убрать пиннинг или заменить IP (симптом: таймауты getUpdates/sendMessage).
"""
import socket

_PINNED_HOSTS = {"api.telegram.org": "149.154.167.220"}

_getaddrinfo_orig = socket.getaddrinfo


def _getaddrinfo_pinned(host, *args, **kwargs):
    return _getaddrinfo_orig(_PINNED_HOSTS.get(host, host), *args, **kwargs)


socket.getaddrinfo = _getaddrinfo_pinned

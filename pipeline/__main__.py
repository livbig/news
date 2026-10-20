import argparse
import sys

from . import bot, channels, config, db, digest, fetch, telegram
from .config import setup_logging


def cmd_run():
    conn = db.connect()
    new = fetch.fetch_all(conn) + channels.fetch_all_channels(conn)
    print(f"Готово: +{new} новых статей")
    conn.close()


def cmd_digest():
    conn = db.connect()
    result = digest.build_digest(conn)
    conn.close()
    if result is None:
        print("Новых статей для сводки нет")
        return
    digest.deliver(result)


def cmd_check():
    ok = fail = 0
    for url, category in fetch.load_feeds():
        try:
            parsed = fetch.parse_feed(url)
            print(f"OK   {url} [{category}] — {len(parsed.entries)} записей")
            ok += 1
        except Exception as exc:
            print(f"FAIL {url} [{category}]: {exc}")
            fail += 1
    print(f"\nИтого: {ok} OK, {fail} FAIL")


def cmd_chatid():
    if not config.TELEGRAM_TOKEN:
        print("Сначала впишите TELEGRAM_TOKEN в .env (см. @BotFather)")
        return
    try:
        chats = telegram.get_chat_ids()
    except Exception as exc:
        print(f"Ошибка Telegram API (токен верный?): {exc}")
        return
    if not chats:
        print("Боту ещё никто не писал. Откройте своего бота в Telegram,")
        print("отправьте ему любое сообщение (например /start) и повторите:")
        print("    python3 -m pipeline chatid")
        return
    for chat in chats:
        print(f"{chat['id']}  ({chat['type']}, {chat['name']})")
    print("\nСкопируйте нужный id в TELEGRAM_CHAT_ID в .env")


def cmd_bot():
    bot.run_bot()


def main():
    setup_logging()
    parser = argparse.ArgumentParser(prog="pipeline", description="News digest pipeline")
    parser.add_argument("command", choices=["run", "digest", "check", "chatid", "bot"])
    args = parser.parse_args()

    commands = {"run": cmd_run, "digest": cmd_digest, "check": cmd_check, "chatid": cmd_chatid, "bot": cmd_bot}
    commands[args.command]()


if __name__ == "__main__":
    sys.exit(main())

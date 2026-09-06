import argparse
import sys

from . import config, db, digest, fetch
from .config import setup_logging


def cmd_run():
    conn = db.connect()
    new = fetch.fetch_all(conn)
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


def main():
    setup_logging()
    parser = argparse.ArgumentParser(prog="pipeline", description="News digest pipeline")
    parser.add_argument("command", choices=["run", "digest", "check"])
    args = parser.parse_args()

    commands = {"run": cmd_run, "digest": cmd_digest, "check": cmd_check}
    commands[args.command]()


if __name__ == "__main__":
    sys.exit(main())

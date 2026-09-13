"""М3.3: E2E-стенд миниаппа — HTTP-мост (stdlib) поверх Starlette-приложения
api/index (через TestClient) с seeded :memory:-БД. Запуск:
`python3 tests/e2e_serve.py <port>`; готовность — строка READY <port>.
Нужен браузерному e2e (tests/e2e_miniapp.cjs), который ходит по http и не
может звать ASGI in-process."""
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from starlette.testclient import TestClient  # noqa: E402

from api import index as api_index  # noqa: E402
from bot import config as bconfig  # noqa: E402
from bot import db  # noqa: E402

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8891
TOKEN = "70000:E2ETEST"  # фейковый, подпись воспроизводит e2e-скрипт
CHAT = 603522950

bconfig.TOKEN = TOKEN
bconfig.ALLOWED_CHAT_ID = str(CHAT)
conn = db.connect(":memory:")
api_index._set_conn(conn)
db.ensure_user(conn, CHAT)
db.add_source(conn, CHAT, "rss", "http://e2e.test/1", "E2E Источник Один", "manual")
db.add_source(conn, CHAT, "rss", "http://e2e.test/2", "E2E Источник Два", "manual")
db.set_send_times(conn, CHAT, ["09:00"])

client = TestClient(api_index.app)
_lock = threading.Lock()  # TestClient не потокобезопасен: сериализуем
HOP = {"content-length", "transfer-encoding", "content-encoding", "connection"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _relay(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        with _lock:
            r = client.request(self.command, self.path,
                               headers=dict(self.headers), content=body)
        self.send_response(r.status_code)
        for k, v in r.headers.items():
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(r.content)))
        self.end_headers()
        self.wfile.write(r.content)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _relay


if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as srv:
        print(f"READY {PORT}", flush=True)
        srv.serve_forever()

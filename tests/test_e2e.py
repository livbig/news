"""М3.3: E2E миниаппа в реальном Chromium (Playwright) против локального
стенда api/index (tests/e2e_serve.py — stdlib-мост над TestClient).
Оркестрация: npm-пакет playwright в temp, сервер-подпроцесс, node-сценарий.
Пропуск (CI без браузеров / нет node): @unittest.skipIf — регрессия не растёт."""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NPMDIR = Path(tempfile.gettempdir()) / "kilo-e2e-npm"
PORT = 8891
PLAYWRIGHT_VERSION = "1.62.0"  # ревизия chromium из локального кэша


def _node_available():
    return bool(shutil.which("node") and shutil.which("npm"))


def _chromium_cached():
    base = Path.home() / "Library" / "Caches" / "ms-playwright"
    return base.exists() and any(base.glob("chromium-*"))


@unittest.skipIf(not (_node_available() and _chromium_cached()),
                 "нет node/npm или закэшированного chromium (CI?)")
class TestMiniAppE2E(unittest.TestCase):
    server: subprocess.Popen | None = None

    @classmethod
    def setUpClass(cls):
        env = dict(os.environ)
        proc = subprocess.run(
            ["node", "-e",
             "const p=require('playwright');console.log(p.chromium.executablePath())"],
            env=env | {"NODE_PATH": str(NPMDIR / "node_modules")},
            capture_output=True, text=True)
        if proc.returncode != 0 or not Path(proc.stdout.strip()).exists():
            subprocess.run(["npm", "install", "--prefix", str(NPMDIR), "--no-audit",
                            "--no-fund", f"playwright@{PLAYWRIGHT_VERSION}"],
                           check=True, capture_output=True)
        cls.server = subprocess.Popen(
            [sys.executable, str(ROOT / "tests" / "e2e_serve.py"), str(PORT)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", PORT), timeout=0.3):
                    break
            except OSError:
                if cls.server.poll() is not None:
                    break
                time.sleep(0.2)
        else:
            cls.tearDownClass()
            raise RuntimeError("e2e-стенд не поднялся")

    @classmethod
    def tearDownClass(cls):
        if cls.server is not None:
            cls.server.terminate()
            try:
                cls.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.server.kill()

    def test_browser_e2e(self):
        env = dict(os.environ) | {
            "NODE_PATH": str(NPMDIR / "node_modules"),
            "E2E_BASE": f"http://127.0.0.1:{PORT}",
            "E2E_TOKEN": "70000:E2ETEST",
            "E2E_CHAT": "700111222",
        }
        proc = subprocess.run(
            ["node", str(ROOT / "tests" / "e2e_miniapp.cjs")],
            env=env, cwd=ROOT, capture_output=True, text=True, timeout=180)
        self.assertEqual(proc.returncode, 0,
                         "e2e упал:\n" + proc.stderr + proc.stdout)
        summary = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(summary["ok"], summary)
        self.assertGreaterEqual(len(summary["results"]), 6)  # A1–A5 + B1
        for r in summary["results"]:
            self.assertTrue(r["ok"], r)


if __name__ == "__main__":
    unittest.main()

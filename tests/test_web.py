"""
Tests for the appliance's web management API (vm/rootfs/usr/local/lib/eve-netboot/
eve_netboot_web.py), with the real eve-netboot module; only what touches the
system (applying settings, passwords, docker, systemctl) is replaced.

    python3 -m unittest discover -s tests -v
"""

import http.client
import http.server
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import socket
import ssl
import tarfile
import tempfile
import threading
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TMP = tempfile.mkdtemp(prefix="eve-netboot-web-")
os.environ["ENI_ETC"] = os.path.join(TMP, "etc")
os.makedirs(os.environ["ENI_ETC"])


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    loader.exec_module(module)
    return module


core = load("eve_netboot_core", os.path.join(ROOT, "vm", "rootfs", "usr", "local", "sbin", "eve-netboot"))
web = load("eve_netboot_web", os.path.join(ROOT, "vm", "rootfs", "usr", "local", "lib", "eve-netboot",
                                           "eve_netboot_web.py"))
PASSWORD = "Right-Pass-1"


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


def pause(seconds):
    """time.sleep is patched away in the tests (login delay)."""
    threading.Event().wait(seconds)


def eve_iso(path):
    pvd = b"\x01CD001\x01\x00" + b" " * 32 + b"EVEISO".ljust(32)
    with open(path, "wb") as f:
        f.write(b"\0" * 0x8000 + pvd + b"\0" * 1024)
    with open(path, "rb") as f:
        return f.read()


class WebTest(unittest.TestCase):

    def setUp(self):
        self.www = tempfile.mkdtemp(dir=TMP)
        self.imp = tempfile.mkdtemp(dir=TMP)
        os.makedirs(os.path.join(self.www, "eve"))
        with open(os.path.join(self.www, "index.html"), "w") as f:
            f.write("<html>ui</html>")
        with open(os.path.join(TMP, "secret.txt"), "w") as f:
            f.write("outside the web root")
        for path in (core.SETTINGS, core.CONFIGURED):
            if os.path.exists(path):
                os.remove(path)
        self.applied = []

        def apply(s, stack=True):
            self.applied.append(dict(s))
            clean = {k: v for k, v in s.items() if k not in core.CONSUMED}
            core.save_settings(clean)
            core.write(core.CONFIGURED, "now\n")
            return clean

        patches = mock.patch.multiple(
            core, WWW=self.www, IMPORT=self.imp, LOG=os.path.join(TMP, "eve-netboot.log"),
            apply=apply, log=mock.DEFAULT, compose=mock.DEFAULT, run=mock.DEFAULT,
            check_password=lambda user, pw: user == core.ADMIN and pw == PASSWORD,
            admin_has_password=lambda: True, smb_has_password=lambda: False,
            ipv4_addresses=lambda: [("enp0s1", "192.0.2.20/24")], primary_ip=lambda: "192.0.2.20",
            primary_interface=lambda: "enp0s1", status_lines=lambda: ["status line"])
        self.mocks = patches.start()
        self.addCleanup(patches.stop)
        self.mocks["compose"].return_value = mock.Mock(stdout="sync log\n", stderr="")
        self.mocks["run"].return_value = mock.Mock(stdout="", stderr="", returncode=0)
        # owner of uploaded files: whoever runs the tests
        user = mock.patch.object(core, "ADMIN", os.environ.get("USER") or "root")
        user.start()
        self.addCleanup(user.stop)
        # no 1 s delay after a wrong password; the appliance's group "admin" does not exist here
        for target, attr, value in ((web.time, "sleep", lambda s: None), (web.shutil, "chown", lambda *a: None)):
            p = mock.patch.object(target, attr, value)
            p.start()
            self.addCleanup(p.stop)

        web.Handler.app = web.App(core)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.cookie = None

    # ---- client helpers
    def request(self, method, path, body=None, headers=None, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        h = {"X-ENI": "1"} if method != "GET" else {}
        if self.cookie:
            h["Cookie"] = self.cookie
        if body is not None:
            raw = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        conn.request(method, path, body=raw, headers=h)
        r = conn.getresponse()
        data = r.read()
        set_cookie = r.getheader("Set-Cookie")
        if set_cookie:
            self.cookie = set_cookie.split(";")[0]
        conn.close()
        ctype = r.getheader("Content-Type") or ""
        return r.status, (json.loads(data) if ctype.startswith("application/json") else data), r

    def login(self):
        status, body, r = self.request("POST", "/api/login", {"password": PASSWORD})
        self.assertEqual(status, 200, body)
        self.assertIn("HttpOnly", r.getheader("Set-Cookie"))
        self.assertIn("Secure", r.getheader("Set-Cookie"))
        self.assertIn("SameSite=Strict", r.getheader("Set-Cookie"))

    def configure(self):
        core.save_settings({"SERVER_IP": "auto"})
        core.write(core.CONFIGURED, "now\n")

    def wait_job(self, job_id):
        for _ in range(100):
            status, body, _ = self.request("GET", f"/api/jobs/{job_id}")
            if body["state"] != "running":
                return body
            pause(0.02)
        self.fail("job did not finish")

    # ---- static files
    def test_serves_the_ui_but_nothing_outside_the_web_root(self):
        status, body, _ = self.request("GET", "/")
        self.assertEqual((status, body), (200, b"<html>ui</html>"))
        for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/eve/../../secret.txt"):
            status, body, _ = self.request("GET", path)
            self.assertEqual(status, 404, path)

    def test_folders_of_the_web_root_are_listed(self):
        rel = os.path.join(self.www, "eve", "releases", "16.0.0")
        os.makedirs(rel)
        for name in ("kernel", "<b>.cfg"):
            with open(os.path.join(rel, name), "w") as f:
                f.write("x")
        status, _, r = self.request("GET", "/eve/releases/16.0.0")
        self.assertEqual((status, r.getheader("Location")), (301, "/eve/releases/16.0.0/"))
        status, page, r = self.request("GET", "/eve/releases/16.0.0/")
        self.assertEqual(status, 200)
        self.assertTrue(r.getheader("Content-Type").startswith("text/html"))
        self.assertIn(b'<a href="kernel">kernel</a>', page)
        self.assertIn(b"&lt;b&gt;.cfg", page)          # names are escaped
        self.assertNotIn(b"<b>", page)
        self.assertEqual(self.request("GET", "/")[1], b"<html>ui</html>")   # the UI itself, not a listing

    def test_ui_from_the_vm_copy_before_the_stack_ever_ran(self):
        os.remove(os.path.join(self.www, "index.html"))
        lib = tempfile.mkdtemp(dir=TMP)
        os.makedirs(os.path.join(lib, "ui", "ui"))
        with open(os.path.join(lib, "ui", "index.html"), "w") as f:
            f.write("<html>baked</html>")
        with mock.patch.object(core, "LIB", lib):
            self.assertEqual(self.request("GET", "/")[:2], (200, b"<html>baked</html>"))
            self.assertEqual(self.request("GET", "/../secret.txt")[0], 404)
            # once the sync wrote the web root, that one wins (newer after an app update)
            with open(os.path.join(self.www, "index.html"), "w") as f:
                f.write("<html>www</html>")
            self.assertEqual(self.request("GET", "/")[1], b"<html>www</html>")

    # ---- session and login
    def test_session_before_and_after_setup(self):
        status, info, _ = self.request("GET", "/api/session")
        self.assertEqual((status, info["appliance"], info["configured"], info["authenticated"]),
                         (200, True, False, False))
        self.configure()
        self.assertTrue(self.request("GET", "/api/session")[1]["configured"])

    def test_changes_need_the_csrf_header(self):
        status, body, _ = self.request("POST", "/api/login", {"password": PASSWORD}, headers={"X-ENI": "0"})
        self.assertEqual(status, 403)

    def test_api_needs_login(self):
        self.configure()
        for method, path in (("GET", "/api/settings"), ("GET", "/api/logs"), ("GET", "/api/diagnostics"),
                             ("POST", "/api/settings"), ("POST", "/api/actions/reboot"), ("DELETE", "/api/images")):
            status, _, _ = self.request(method, path, {} if method != "GET" else None)
            self.assertEqual(status, 401, path)

    def test_texts_in_any_language_also_before_the_setup(self):
        status, body, _ = self.request("GET", "/api/texts?lang=de")
        self.assertEqual((status, body["language"]), (200, "de"))
        self.assertEqual(body["texts"]["adm_sec_network"], core.texts("de")["adm_sec_network"])
        status, body, _ = self.request("GET", "/api/texts")
        self.assertEqual(body["language"], "en")                     # the saved one
        # the stack's copy (newer after an app update) wins for its language
        with open(os.path.join(self.www, "eve", "ui.json"), "w") as f:
            json.dump({"language": "en", "texts": {"adm_sec_network": "Netzwerk (neu)"}}, f)
        self.assertEqual(self.request("GET", "/api/texts?lang=en")[1]["texts"]["adm_sec_network"], "Netzwerk (neu)")
        self.assertNotEqual(self.request("GET", "/api/texts?lang=nl")[1]["texts"]["adm_sec_network"], "Netzwerk (neu)")

    def test_answers_in_the_language_of_the_browser(self):
        self.configure()
        status, body, _ = self.request("POST", "/api/actions/sync", {}, headers={"X-ENI-Lang": "fr"})
        self.assertEqual((status, body["error"]), (401, core.texts("fr")["adm_api_login"]))
        self.assertEqual(self.request("POST", "/api/actions/sync", {})[1]["error"], "Please log in.")

    def test_wrong_passwords_lock_out(self):
        self.configure()
        for _ in range(web.LOCKOUT_AFTER):
            self.assertEqual(self.request("POST", "/api/login", {"password": "wrong"})[0], 401)
        self.assertEqual(self.request("POST", "/api/login", {"password": PASSWORD})[0], 429)

    def test_logout(self):
        self.configure()
        self.login()
        self.assertEqual(self.request("GET", "/api/settings")[0], 200)
        self.request("POST", "/api/logout", {})
        self.assertEqual(self.request("GET", "/api/settings")[0], 401)

    # ---- setup
    def test_setup_is_open_only_until_set_up(self):
        status, body, _ = self.request("POST", "/api/setup", {"settings": {"ENI_LANGUAGE": "nl"}})
        self.assertEqual(status, 400)   # no password
        status, body, _ = self.request("POST", "/api/setup", {
            "settings": {"ENI_LANGUAGE": "nl"}, "secrets": {"ADMIN_PASSWORD": "New-Pass-123"}})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.wait_job(body["job"])["state"], "done")
        applied = self.applied[-1]
        self.assertEqual((applied["ENI_LANGUAGE"], applied["ADMIN_PASSWORD"], applied["WEB_ADMIN"]),
                         ("nl", "New-Pass-123", "yes"))
        self.assertNotIn("ADMIN_PASSWORD", core.load_settings())
        # logged in by the setup; a second setup is refused
        self.assertEqual(self.request("GET", "/api/settings")[0], 200)
        self.assertEqual(self.request("POST", "/api/setup", {"secrets": {"ADMIN_PASSWORD": "x" * 9}})[0], 409)

    def test_setup_can_read_choices_and_import_but_nothing_else(self):
        self.assertEqual(self.request("GET", "/api/settings")[0], 200)
        status, body, _ = self.request("POST", "/api/import", {"text": "ENI_LANGUAGE=de\n"})
        self.assertEqual((status, body["settings"]["ENI_LANGUAGE"]), (200, "de"))
        self.assertEqual(self.request("GET", "/api/logs")[0], 401)
        self.assertEqual(self.request("POST", "/api/settings", {})[0], 401)
        self.configure()
        self.assertEqual(self.request("GET", "/api/settings")[0], 401)
        self.assertEqual(self.request("POST", "/api/import", {"text": "A=b"})[0], 401)

    # ---- settings
    def test_settings_are_validated_and_hide_secrets(self):
        self.configure()
        core.save_settings({"ENI_GITHUB_TOKEN": "ghp_secret", "ENI_LANGUAGE": "en"})
        self.login()
        status, info, _ = self.request("GET", "/api/settings")
        self.assertNotIn("ghp_secret", json.dumps(info))
        self.assertTrue(info["secrets"]["github_token"])
        status, body, _ = self.request("POST", "/api/settings", {"settings": {"HTTP_PORT": "69"}})
        self.assertEqual(status, 400)
        status, body, _ = self.request("POST", "/api/settings", {"settings": {"ENI_LANGUAGE": "de",
                                                                             "DATA_DIR": "/elsewhere"}})
        self.assertEqual(status, 200, body)
        self.assertNotIn("rollback", body)
        self.wait_job(body["job"])
        self.assertEqual(self.applied[-1]["ENI_LANGUAGE"], "de")
        self.assertNotIn("DATA_DIR", self.applied[-1])
        self.assertEqual(self.applied[-1]["ENI_GITHUB_TOKEN"], "ghp_secret")   # kept

    def test_network_change_rolls_back_unless_confirmed(self):
        self.configure()
        self.login()
        with mock.patch.object(web, "ROLLBACK_SECONDS", 0.3):
            status, body, _ = self.request("POST", "/api/settings", {"settings": {
                "NET_MODE": "static", "NET_ADDRESS": "192.0.2.50/24", "NET_GATEWAY": "192.0.2.1"}})
            self.assertEqual(status, 200, body)
            self.assertEqual(body["rollback"]["confirm_url"].split("#")[0], "https://192.0.2.50:8443/")
            self.wait_job(body["job"])
            pause(0.6)
        # not confirmed: the previous settings are applied again
        self.assertEqual(self.applied[-1].get("NET_MODE", "dhcp"), "dhcp")
        self.assertEqual(self.request("POST", "/api/network/confirm", {"token": body["rollback"]["token"]})[0], 400)

    def test_network_change_confirmed(self):
        self.configure()
        self.login()
        status, body, _ = self.request("POST", "/api/settings", {"settings": {
            "NET_MODE": "static", "NET_ADDRESS": "192.0.2.50/24"}})
        self.wait_job(body["job"])
        self.cookie = None   # the new address has no session yet: the token is enough
        status, _, _ = self.request("POST", "/api/network/confirm", {"token": body["rollback"]["token"]})
        self.assertEqual(status, 200)
        self.assertIsNone(web.Handler.app.rollback)
        self.assertEqual(self.applied[-1]["NET_ADDRESS"], "192.0.2.50/24")

    # ---- password
    def test_change_password(self):
        self.configure()
        self.login()
        self.assertEqual(self.request("POST", "/api/password", {"current": "wrong", "new": "x" * 10})[0], 400)
        self.assertEqual(self.request("POST", "/api/password", {"current": PASSWORD, "new": "short"})[0], 400)
        self.assertEqual(self.request("POST", "/api/password", {"current": PASSWORD, "new": "Brand-New-9"})[0], 200)
        self.mocks["run"].assert_called_with(["chpasswd"], input=f"{core.ADMIN}:Brand-New-9\n")

    # ---- upload and delete
    def test_upload_only_eve_installer_isos(self):
        self.configure()
        self.login()
        data = eve_iso(os.path.join(TMP, "good.iso"))
        status, body, _ = self.request("POST", "/api/upload?name=../evil.iso", raw=data)
        self.assertEqual(status, 400)
        status, body, _ = self.request("POST", "/api/upload?name=not-eve.iso", raw=b"\0" * 40000)
        self.assertEqual(status, 400)
        self.assertEqual(os.listdir(self.imp), [])   # nothing left behind
        status, body, _ = self.request("POST", "/api/upload?name=customer-a.iso", raw=data)
        self.assertEqual(status, 200, body)
        with open(os.path.join(self.imp, "customer-a.iso"), "rb") as f:
            self.assertEqual(f.read(), data)
        self.assertEqual(self.request("POST", "/api/upload?name=customer-a.iso", raw=data)[0], 409)
        self.assertEqual(self.request("POST", "/api/upload?name=customer-a.iso&overwrite=1", raw=data)[0], 200)

    def test_delete_only_inside_the_import_folder(self):
        self.configure()
        self.login()
        os.makedirs(os.path.join(self.imp, "sub"))
        eve_iso(os.path.join(self.imp, "sub", "a.iso"))
        self.assertEqual(self.request("DELETE", "/api/images?file=../secret.txt", {})[0], 404)
        self.assertEqual(self.request("DELETE", "/api/images?file=sub/a.iso", {})[0], 200)
        self.assertFalse(os.path.exists(os.path.join(self.imp, "sub", "a.iso")))
        self.assertTrue(os.path.exists(os.path.join(TMP, "secret.txt")))

    # ---- logs, export, diagnostics, actions
    def test_logs_export_and_diagnostics_without_secrets(self):
        self.configure()
        core.save_settings({"ENI_GITHUB_TOKEN": "ghp_secret", "ENI_LANGUAGE": "nl"})
        self.login()
        status, text, _ = self.request("GET", "/api/logs?source=sync&lines=50")
        self.assertEqual((status, text), (200, b"sync log\n"))
        self.assertEqual(self.request("GET", "/api/logs?source=/etc/shadow")[0], 400)
        status, text, _ = self.request("GET", "/api/export")
        self.assertIn(b"ENI_LANGUAGE=nl", text)
        self.assertNotIn(b"ghp_secret", text)
        status, data, r = self.request("GET", "/api/diagnostics")
        self.assertEqual((status, r.getheader("Content-Type")), (200, "application/gzip"))
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            names = tar.getnames()
            everything = b"".join(tar.extractfile(m).read() for m in tar.getmembers())
        self.assertIn("eve-netboot-diagnostics/settings-export.txt", names)
        self.assertNotIn(b"ghp_secret", everything)

    def test_answer_is_not_lost_when_the_body_is_not_needed(self):
        # The server answers 401 without needing the body. Unless it still reads
        # it, closing the connection resets it and the browser loses the answer
        # ("Failed to fetch").
        body = b"x" * (4 << 20)
        with socket.create_connection(("127.0.0.1", self.server.server_address[1]), timeout=10) as sock:
            sock.sendall(b"POST /api/upload?name=a.iso HTTP/1.1\r\nHost: x\r\nX-ENI: 1\r\n"
                         + f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
            answer = b""
            while chunk := sock.recv(65536):
                answer += chunk
        self.assertTrue(answer.startswith(b"HTTP/1.0 401"), answer[:80])
        self.assertIn(b"Please log in.", answer)

    def test_actions(self):
        self.configure()
        self.login()
        self.assertEqual(self.request("POST", "/api/actions/sync", {})[0], 200)
        for _ in range(100):    # the restart runs in the background
            if self.mocks["compose"].called:
                break
            pause(0.02)
        self.mocks["compose"].assert_called_with("restart", "sync", check=False)
        self.assertEqual(self.request("POST", "/api/actions/format-disk", {})[0], 404)
        with mock.patch.object(core, "update_app", lambda say: (say("Downloading ..."), (True, "Updated."))[1]):
            status, body, _ = self.request("POST", "/api/actions/update-app", {})
            job = self.wait_job(body["job"])
        self.assertEqual((job["state"], job["result"]["message"], job["messages"]), ("done", "Updated.", ["Downloading ..."]))


class CertificateTest(unittest.TestCase):
    """The self-signed certificate must be one browsers let you accept:
    macOS/iOS want <= 825 days and serverAuth, Firefox wants CA:FALSE."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(dir=TMP)
        p = mock.patch.multiple(web, TLS_DIR=self.dir)
        p.start()
        self.addCleanup(p.stop)
        self.ip = "192.0.2.50"
        # the host name of the VM, not of the machine running the tests
        q = mock.patch.multiple(core, primary_ip=lambda: self.ip, log=mock.DEFAULT,
                                read=lambda path, default="": ("vm-host\n" if path == "/etc/hostname" else
                                                               open(path).read() if os.path.exists(path) else default))
        q.start()
        self.addCleanup(q.stop)

    def text(self, cert):
        import subprocess
        return subprocess.run(["openssl", "x509", "-in", cert, "-noout", "-text"], capture_output=True,
                              text=True, check=True).stdout

    def test_browser_acceptable_certificate(self):
        cert, key = web.ensure_certificate(core)
        t = self.text(cert)
        self.assertIn("CA:FALSE", t)
        self.assertIn("TLS Web Server Authentication", t)
        self.assertIn("Digital Signature", t)
        self.assertIn("IP Address:192.0.2.50", t)
        self.assertIn("DNS:vm-host", t)
        import datetime
        import subprocess
        end = subprocess.run(["openssl", "x509", "-in", cert, "-noout", "-enddate"], capture_output=True,
                             text=True, check=True).stdout.split("=", 1)[1].strip()
        days = (datetime.datetime.strptime(end, "%b %d %H:%M:%S %Y %Z") - datetime.datetime.utcnow()).days
        self.assertLessEqual(days, 825)
        self.assertEqual(os.stat(key).st_mode & 0o777, 0o600)

    def test_plain_http_on_the_https_port_is_redirected(self):
        # an address typed without https:// (Safari even falls back to http by itself)
        cert, key = web.ensure_certificate(core)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        with mock.patch.object(core, "is_configured", lambda: True), \
                mock.patch.object(core, "load_settings", lambda: {}):
            web.Handler.app = web.App(core)
            server = web.TLSServer(("127.0.0.1", 0), web.Handler, ctx)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            port = server.server_address[1]
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            conn.request("GET", "/#/settings", headers={"Host": f"192.0.2.50:{port}"})
            r = conn.getresponse()
            self.assertEqual((r.status, r.getheader("Location")), (301, f"https://192.0.2.50:{port}/#/settings"))
            conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=10,
                                               context=ssl._create_unverified_context())
            conn.request("GET", "/api/session")
            self.assertEqual(conn.getresponse().status, 200)

    def test_kept_while_valid_and_replaced_when_not(self):
        cert, _ = web.ensure_certificate(core)
        first = open(cert).read()
        self.assertEqual(open(web.ensure_certificate(core)[0]).read(), first)       # kept
        self.ip = "192.0.2.77"                                                        # address changed
        second = open(web.ensure_certificate(core)[0]).read()
        self.assertNotEqual(second, first)
        self.assertIn("IP Address:192.0.2.77", self.text(cert))
        os.remove(os.path.join(self.dir, "profile"))                                  # made by 1.4.0
        self.assertNotEqual(open(web.ensure_certificate(core)[0]).read(), second)


if __name__ == "__main__":
    unittest.main()

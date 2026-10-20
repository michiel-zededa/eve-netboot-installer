"""
Tests for the appliance's web management API (vm/rootfs/usr/local/lib/eve-netboot/
eve_netboot_web.py), with the real eve-netboot module; only what touches the
system (applying settings, passwords, docker, systemctl) is replaced.

    python3 -m unittest discover -s tests -v
"""

import csv
import http.client
import http.server
import importlib.machinery
import importlib.util
import io
import json
import re
import os
import shutil
import socket
import ssl
import sys
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


sys.path.insert(0, os.path.join(ROOT, "vm", "rootfs", "usr", "local", "lib", "eve-netboot"))  # zededa.py
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


class WebBase(unittest.TestCase):
    """A management server on a free port, with the system mocked away."""

    def setUp(self):
        self.www = tempfile.mkdtemp(dir=TMP)
        self.imp = tempfile.mkdtemp(dir=TMP)
        os.makedirs(os.path.join(self.www, "eve"))
        with open(os.path.join(self.www, "index.html"), "w") as f:
            f.write("<html>ui</html>")
        with open(os.path.join(TMP, "secret.txt"), "w") as f:
            f.write("outside the web root")
        for path in (core.SETTINGS, core.CONFIGURED, core.ONBOARDED):
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


class WebTest(WebBase):

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


class FakeZededa:
    """Stands in for zededa.Client: one shared fake controller per test."""
    nodes = {}
    created = []
    logins = []
    states = {}

    def __init__(self, cluster, token=None, opener=None):
        self.cluster, self.token = cluster, token

    def login(self, user, password, enterprise):
        FakeZededa.logins.append((self.cluster, user, enterprise))
        if password != "zededa-pw":
            raise web.zededa.ZededaError(401, "CREDENTIAL_MISMATCH")
        return {"token": "SECRET-TOKEN", "expires": web.time.time() + 4 * 3600, "role": "SysManager"}

    def check(self):
        return {"user": "sso-user", "enterprise": "ACME", "expires": None}

    def logout(self):
        pass

    def project(self, name):
        return {"id": "proj-1", "name": name, "appPolicy": None}

    def device_by_serial(self, serial):
        return FakeZededa.nodes.get(serial)

    def device_status(self, node_id):
        state = FakeZededa.states.get(node_id, "waiting")
        if isinstance(state, Exception):
            raise state
        return {"run_state": "RUN_STATE_X", "state": state, "last_seen": "", "eve": "17.0.0-lts", "error": ""}

    def create_modelless(self, name, title, project_id, serial, key):
        assert self.token == "SECRET-TOKEN"
        FakeZededa.created.append((name, project_id, serial, key))
        FakeZededa.nodes[serial] = {"name": name}
        return "node-1"


class ZededaWebTest(WebBase):
    """The ZEDEDA session in the web management and the boot menu's request."""
    MAC = "52-54-00-12-34-56"

    def setUp(self):
        super().setUp()
        FakeZededa.nodes, FakeZededa.created, FakeZededa.logins, FakeZededa.states = {}, [], [], {}
        p = mock.patch.object(web.zededa, "Client", FakeZededa)
        p.start()
        self.addCleanup(p.stop)
        core.save_settings({"SERVER_IP": "auto", "ZEDEDA_ONBOARDING": "yes", "ZEDEDA_ENTERPRISE": "ENT",
                            "ZEDEDA_USER": "eni@example.net", "ZEDEDA_PROJECT": "netboot"})
        core.write(core.CONFIGURED, "now\n")

    def onboard(self, action="register", mac=MAC, serial="To Be Filled By O.E.M.", name=""):
        """The boot menu's request, over plain HTTP like iPXE sends it."""
        conn = http.client.HTTPConnection("127.0.0.1", self.plain_port, timeout=10)
        conn.request("GET", f"/ipxe/onboard?action={action}&mac={mac}&serial={serial.replace(' ', '%20')}"
                            f"&product=X1&name={name.replace(' ', '%20')}")
        r = conn.getresponse()
        body = r.read().decode()
        self.assertEqual(r.status, 200, body)
        self.assertTrue(body.startswith("#!ipxe\n") and body.isascii(), body)
        return dict(re.findall(r"^set (eve_ob_\w+) (.*)$", body, re.M))

    def start_tls(self):
        p = mock.patch.object(web, "TLS_DIR", tempfile.mkdtemp(dir=TMP))
        p.start()
        self.addCleanup(p.stop)
        cert, key = web.ensure_certificate(core)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        server = web.TLSServer(("127.0.0.1", 0), web.Handler, ctx)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.plain_port = server.server_address[1]

    def test_needs_the_admin(self):
        self.assertEqual(self.request("GET", "/api/zededa")[0], 401)
        self.assertEqual(self.request("POST", "/api/zededa/login", {"password": "zededa-pw"})[0], 401)

    def test_session_in_memory_only(self):
        self.login()
        status, body, _ = self.request("POST", "/api/zededa/login", {"password": "wrong"})
        self.assertEqual(status, 400)
        self.assertIn("CREDENTIAL_MISMATCH", body["error"])
        status, body, _ = self.request("POST", "/api/zededa/login", {"password": "zededa-pw"})
        self.assertEqual(status, 200, body)
        self.assertEqual((body["session"]["user"], body["session"]["project_id"]), ("eni@example.net", "proj-1"))
        self.assertEqual(FakeZededa.logins[-1], ("zedcontrol.zededa.net", "eni@example.net", "ENT"))
        # the token is in the process, nowhere else: not in answers, settings, export or logs
        self.assertEqual(Handler_app().zededa["token"], "SECRET-TOKEN")
        for _status, text, _ in (self.request("GET", "/api/zededa"), self.request("GET", "/api/settings"),
                                self.request("GET", "/api/export")):
            self.assertNotIn("SECRET-TOKEN", json.dumps(text) if not isinstance(text, bytes) else text.decode())
        self.assertNotIn("SECRET-TOKEN", core.read(core.SETTINGS))
        self.assertNotIn("zededa-pw", core.read(core.SETTINGS))
        for call in self.mocks["log"].call_args_list:
            self.assertNotIn("SECRET-TOKEN", str(call))
        self.assertEqual(self.request("POST", "/api/zededa/logout", {})[0], 200)
        self.assertIsNone(Handler_app().zededa)

    def test_pasted_token(self):
        self.login()
        status, body, _ = self.request("POST", "/api/zededa/login", {"token": "PASTED"})
        self.assertEqual((status, body["session"]["via"], body["session"]["user"]), (200, "token", "sso-user"))

    def test_api_token_without_user_or_enterprise(self):
        core.save_settings({"SERVER_IP": "auto", "ZEDEDA_ONBOARDING": "yes", "ZEDEDA_PROJECT": "netboot"})

        class Anonymous(FakeZededa):
            def check(self):
                return {"user": "", "enterprise": "", "expires": None}

        with mock.patch.object(web.zededa, "Client", Anonymous):
            self.start_tls()
            self.login()
            status, body, _ = self.request("POST", "/api/zededa/login", {"password": "zededa-pw"})
            self.assertEqual(status, 400)                      # a password needs user and enterprise
            status, body, _ = self.request("POST", "/api/zededa/login", {"token": "SECRET-TOKEN"})
            self.assertEqual((status, body["session"]["user"], body["session"]["enterprise"]),
                             (200, "", ""))
            self.assertEqual(self.onboard()["eve_ob_ok"], "1")
        self.assertEqual(FakeZededa.created[0][2], self.MAC)

    def test_boot_menu_registers_a_machine_once(self):
        self.start_tls()
        self.assertEqual(self.onboard()["eve_ob_ok"], "0")              # nobody logged in to ZEDEDA
        self.login()
        self.request("POST", "/api/zededa/login", {"password": "zededa-pw"})
        ob = self.onboard("preview")
        self.assertEqual((ob["eve_ob_ok"], ob["eve_ob_s"]),
                         ("1", "eve-52-54-00-12-34-56 in netboot"))
        self.assertEqual(FakeZededa.created, [])                        # a preview creates nothing
        ob = self.onboard()
        self.assertEqual(ob["eve_ob_ok"], "1")
        self.assertEqual(FakeZededa.created, [("eve-52-54-00-12-34-56", "proj-1", self.MAC,
                                               "5d0767ee-0547-4569-b530-387e526f8cb9")])
        ob = self.onboard()                                             # installed again: no duplicate
        self.assertEqual((ob["eve_ob_ok"], ob["eve_ob_s"]), ("1", "already registered as eve-52-54-00-12-34-56"))
        self.assertEqual(len(FakeZededa.created), 1)
        status, body, _ = self.request("GET", "/api/zededa")
        self.assertEqual([(n["mac"], n["result"], n["product"]) for n in body["onboarded"]],
                         [(self.MAC, "created", "X1")])

    def test_boot_menu_requests_are_checked(self):
        self.start_tls()
        self.login()
        self.request("POST", "/api/zededa/login", {"password": "zededa-pw"})
        for mac in ("52:54:00:12:34:56", "x", "52-54-00-12-34-56-78", "${mac}"):
            with self.subTest(mac=mac):
                self.assertEqual(self.onboard(mac=mac.replace("$", "%24"))["eve_ob_ok"], "0")
        self.assertEqual(FakeZededa.created, [])
        # nothing else is served over plain HTTP: still a redirect to https
        conn = http.client.HTTPConnection("127.0.0.1", self.plain_port, timeout=10)
        conn.request("GET", "/api/zededa", headers={"Host": f"192.0.2.50:{self.plain_port}"})
        self.assertEqual(conn.getresponse().status, 301)
        conn = http.client.HTTPConnection("127.0.0.1", self.plain_port, timeout=10)
        conn.request("POST", "/ipxe/onboard?action=register", body=b"", headers={"Host": "x"})
        self.assertEqual(conn.getresponse().status, 301)

    def test_a_role_that_may_only_create_nodes(self):
        """Edge Nodes: Create only. No reading nodes (no duplicate check: a refused
        duplicate counts as registered) and no reading projects (give the ID)."""
        project_id = "46cc7a5d-1d04-444a-a65e-220875d92a87"

        class CreateOnly(FakeZededa):
            def project(self, name):
                raise AssertionError("an ID is not looked up")

            def device_by_serial(self, serial):
                raise web.zededa.ZededaError(403, "permission denied")

            def create_modelless(self, name, title, pid, serial, key):
                if serial in FakeZededa.nodes:
                    raise web.zededa.ZededaError(409, "already exists")
                return super().create_modelless(name, title, pid, serial, key)

        core.save_settings({**core.load_settings(), "ZEDEDA_PROJECT": project_id})
        with mock.patch.object(web.zededa, "Client", CreateOnly):
            self.start_tls()
            self.login()
            status, body, _ = self.request("POST", "/api/zededa/login", {"password": "zededa-pw"})
            self.assertEqual((status, body["warning"], body["session"]["project_id"]), (200, "", project_id))
            self.assertEqual(self.onboard()["eve_ob_ok"], "1")
            self.assertEqual(FakeZededa.created[0][1:3], (project_id, self.MAC))
            ob = self.onboard()                                         # installed again
            self.assertEqual((ob["eve_ob_ok"], ob["eve_ob_s"]), ("1", "already registered as eve-52-54-00-12-34-56"))

    def test_project_that_cannot_be_read(self):
        class NoProjects(FakeZededa):
            def project(self, name):
                raise web.zededa.ZededaError(403, "permission denied")

        with mock.patch.object(web.zededa, "Client", NoProjects):
            self.start_tls()
            self.login()
            status, body, _ = self.request("POST", "/api/zededa/login", {"password": "zededa-pw"})
            self.assertEqual(status, 200)                               # logged in, with a warning
            self.assertIn("enter the project's ID", body["warning"])
            ob = self.onboard()
            self.assertEqual(ob["eve_ob_ok"], "0")
            self.assertIn("enter the project's ID", ob["eve_ob_s"])
            self.assertEqual(FakeZededa.created, [])

    def zededa_login(self):
        self.start_tls()
        self.login()
        self.assertEqual(self.request("POST", "/api/zededa/login", {"password": "zededa-pw"})[0], 200)

    def test_naming_convention_with_a_number(self):
        core.save_settings({**core.load_settings(), "ZEDEDA_NODE_NAME": "bench1-node-{n:3}", "ZEDEDA_NODE_NEXT": "7"})
        self.zededa_login()
        ob = self.onboard("preview")
        self.assertEqual(ob["eve_ob_s"], "bench1-node-007 in netboot (number set at install)")
        macs = [f"52-54-00-00-00-{i:02x}" for i in range(3)]
        for mac in macs:
            self.assertEqual(self.onboard(mac=mac)["eve_ob_ok"], "1")
        self.assertEqual([c[0] for c in FakeZededa.created], ["bench1-node-007", "bench1-node-008", "bench1-node-009"])
        self.assertEqual(core.get(core.load_settings(), "ZEDEDA_NODE_NEXT"), "10")
        self.onboard(mac=macs[0])                                      # installed again: no number used
        self.assertEqual(core.get(core.load_settings(), "ZEDEDA_NODE_NEXT"), "10")

    def test_name_typed_in_the_boot_menu(self):
        core.save_settings({**core.load_settings(), "ZEDEDA_NODE_NAME": "bench-{n}", "ZEDEDA_NODE_NEXT": "1"})
        self.zededa_login()
        ob = self.onboard("preview", name="Rack 3 / Slot 12")
        self.assertEqual(ob["eve_ob_s"], "rack-3-slot-12 in netboot")
        self.onboard(name="Rack 3 / Slot 12")
        self.assertEqual(FakeZededa.created[0][0], "rack-3-slot-12")
        self.assertEqual(core.get(core.load_settings(), "ZEDEDA_NODE_NEXT"), "1")   # the counter is untouched

    def test_name_in_use(self):
        class Taken(FakeZededa):
            def create_modelless(self, name, title, pid, serial, key):
                raise web.zededa.ZededaError(409, "conflict")

        with mock.patch.object(web.zededa, "Client", Taken):
            self.zededa_login()
            ob = self.onboard()
        self.assertEqual((ob["eve_ob_ok"], ob["eve_ob_s"]),
                         ("0", "registration failed: the name eve-52-54-00-12-34-56 is already in use in ZEDEDA"))

    def test_node_deleted_in_zededa_is_created_again(self):
        """Deleted by hand in ZEDEDA, then the machine is installed again: a new node,
        even though the appliance's list still has the old one."""
        self.zededa_login()
        self.onboard()
        FakeZededa.nodes.clear()                                       # deleted in the ZEDEDA UI
        ob = self.onboard("preview")
        self.assertEqual(ob["eve_ob_s"], "eve-52-54-00-12-34-56 in netboot")
        self.assertEqual(self.onboard()["eve_ob_s"], "registered as eve-52-54-00-12-34-56 in project netboot")
        self.assertEqual(len(FakeZededa.created), 2)

    def test_state_of_the_onboarded_nodes(self):
        self.zededa_login()
        self.onboard()
        status, body, _ = self.request("GET", "/api/zededa/status")
        self.assertEqual(body["onboarded"][0]["status"]["state"], "waiting")
        self.assertNotIn("online_since", body["onboarded"][0])
        FakeZededa.states["node-1"] = "online"
        status, body, _ = self.request("GET", "/api/zededa/status")          # within 20 s: not checked again
        self.assertEqual(body["onboarded"][0]["status"]["state"], "waiting")
        status, body, _ = self.request("GET", "/api/zededa/status?force=1")
        node = body["onboarded"][0]
        self.assertEqual((node["status"]["state"], node["status"]["eve"]), ("online", "17.0.0-lts"))
        first = node["online_since"]
        status, body, _ = self.request("GET", "/api/zededa/status?force=1")
        self.assertEqual(body["onboarded"][0]["online_since"], first)      # the first time it was seen online
        rows = list(csv.DictReader(io.StringIO(self.request("GET", "/api/zededa/export")[1].decode())))
        self.assertEqual((rows[0]["state"], rows[0]["eve_version"]), ("online", "17.0.0-lts"))
        self.assertTrue(rows[0]["online_since"])
        # deleted in ZEDEDA by hand; a role that may not read nodes
        FakeZededa.states["node-1"] = web.zededa.ZededaError(404, "not found")
        self.assertEqual(self.request("GET", "/api/zededa/status?force=1")[1]["onboarded"][0]["status"]["state"], "gone")
        FakeZededa.states["node-1"] = web.zededa.ZededaError(403, "forbidden")
        self.assertEqual(self.request("GET", "/api/zededa/status?force=1")[1]["onboarded"][0]["status"]["state"],
                         "noread")

    def test_state_needs_a_session(self):
        self.login()
        status, body, _ = self.request("GET", "/api/zededa/status")
        self.assertEqual((status, body["session"]), (200, None))

    def test_delete_and_export(self):
        deleted = []
        FakeZededa.delete_device = lambda client, node_id: deleted.append(node_id)
        self.addCleanup(delattr, FakeZededa, "delete_device")
        self.zededa_login()
        self.onboard()
        self.onboard(mac="52-54-00-00-00-99")
        status, csv_text, r = self.request("GET", "/api/zededa/export")
        self.assertEqual(status, 200)
        self.assertIn("attachment", r.getheader("Content-Disposition"))
        rows = list(csv.DictReader(io.StringIO(csv_text.decode())))
        self.assertEqual([(x["mac"], x["name"], x["result"], x["product"]) for x in rows],
                         [("52-54-00-00-00-99", "eve-52-54-00-00-00-99", "created", "X1"),
                          (self.MAC, "eve-52-54-00-12-34-56", "created", "X1")])
        self.assertNotIn("SECRET-TOKEN", csv_text.decode())
        self.assertEqual(self.request("POST", "/api/zededa/delete", {"mac": self.MAC})[0], 200)
        self.assertEqual(deleted, ["node-1"])
        status, body, _ = self.request("GET", "/api/zededa")
        self.assertEqual([n["mac"] for n in body["onboarded"]], ["52-54-00-00-00-99"])   # it left the list
        self.assertEqual(self.request("POST", "/api/zededa/delete", {"mac": self.MAC})[0], 404)   # deleted already
        self.assertEqual(self.request("POST", "/api/zededa/delete", {"mac": "52-54-00-aa-aa-aa"})[0], 404)
        # only with the admin
        self.cookie = None
        self.assertEqual(self.request("POST", "/api/zededa/delete", {"mac": "52-54-00-00-00-99"})[0], 401)
        self.assertEqual(self.request("GET", "/api/zededa/export")[0], 401)

    def test_delete_several_and_remove_from_the_list(self):
        deleted = []
        FakeZededa.delete_device = lambda client, node_id: deleted.append(node_id)
        self.addCleanup(delattr, FakeZededa, "delete_device")
        self.zededa_login()
        macs = [f"52-54-00-00-00-0{i}" for i in range(4)]
        for m in macs:
            self.onboard(mac=m)
        status, body, _ = self.request("POST", "/api/zededa/delete", {"macs": macs[:2] + ["52-54-00-aa-aa-aa"]})
        self.assertEqual((status, body["ok"], len(body["deleted"]), [f["mac"] for f in body["failed"]]),
                         (200, False, 2, ["52-54-00-aa-aa-aa"]))
        # remove from the list: this VM only, also without a ZEDEDA session
        self.request("POST", "/api/zededa/logout", {})
        deleted.clear()
        status, body, _ = self.request("POST", "/api/zededa/forget", {"macs": [macs[2]]})
        self.assertEqual((status, body["removed"], deleted), (200, 1, []))
        self.assertEqual([n["mac"] for n in self.request("GET", "/api/zededa")[1]["onboarded"]], [macs[3]])
        self.assertEqual(self.request("POST", "/api/zededa/forget", {"macs": ["not-a-mac"]})[0], 400)
        self.cookie = None
        self.assertEqual(self.request("POST", "/api/zededa/forget", {"macs": [macs[3]]})[0], 401)

    def test_import_a_list(self):
        self.zededa_login()
        self.onboard()
        csv_text = self.request("GET", "/api/zededa/export")[1].decode()
        web.Handler.app = web.App(core)                     # a new VM: an empty list
        web.Handler.app.forget([self.MAC])
        self.login()
        extra = ("\n2026-10-14T20:00:00,eve-x,52-54-00-00-00-77,52-54-00-00-00-77,,X2,netboot,failed,,,,,boom"
                 "\n2026-10-14T20:00:00,eve-y,bad-mac,,,,,created,,,,n9,")
        status, body, _ = self.request("POST", "/api/zededa/import", {"text": csv_text.rstrip("\r\n") + extra})
        self.assertEqual((status, body["imported"], body["skipped"]), (200, 1, 2))
        node = body["onboarded"][0]
        self.assertEqual((node["mac"], node["name"], node["node_id"], node["product"]),
                         (self.MAC, "eve-52-54-00-12-34-56", "node-1", "X1"))
        # importing it again changes nothing
        self.assertEqual(self.request("POST", "/api/zededa/import", {"text": csv_text})[1]["imported"], 0)
        self.assertEqual(self.request("POST", "/api/zededa/import", {"text": "a,b\n1,2"})[0], 400)

    def test_delete_needs_the_right(self):
        def forbidden(client, node_id):
            raise web.zededa.ZededaError(403, "permission denied")
        FakeZededa.delete_device = forbidden
        self.addCleanup(delattr, FakeZededa, "delete_device")
        self.zededa_login()
        self.onboard()
        status, body, _ = self.request("POST", "/api/zededa/delete", {"mac": self.MAC})
        self.assertEqual(status, 403)
        self.assertIn("Edge Nodes: Delete", body["error"])

    def test_list_survives_a_restart_and_holds_no_secrets(self):
        self.zededa_login()
        self.onboard()
        self.assertNotIn("SECRET-TOKEN", core.read(core.ONBOARDED))
        web.Handler.app = web.App(core)                              # the web management restarts
        self.assertIsNone(web.Handler.app.zededa)                    # the session is gone
        self.assertEqual([n["mac"] for n in web.Handler.app.onboarded], [self.MAC])

    def test_the_console_uses_the_local_key(self):
        key = web.Handler.app.local_key
        self.cookie = None
        h = {"X-ENI-Local": key}
        self.assertEqual(self.request("GET", "/api/zededa", headers=h)[0], 200)
        self.assertEqual(self.request("GET", "/api/zededa", headers={"X-ENI-Local": "wrong"})[0], 401)
        status, body, _ = self.request("POST", "/api/zededa/login", {"password": "zededa-pw"}, headers=h)
        self.assertEqual(status, 200, body)

    def test_console_reaches_the_session_over_tls(self):
        """core.web_api (the console) -> the TLS server, with the key from the key file."""
        self.start_tls()
        keyfile = os.path.join(tempfile.mkdtemp(dir=TMP), "web.key")
        with open(keyfile, "w") as f:
            f.write(web.Handler.app.local_key + "\n")
        core.save_settings({**core.load_settings(), "WEB_ADMIN_PORT": str(self.plain_port)})
        with mock.patch.object(core, "WEB_LOCAL_KEY", keyfile):
            status, info = core.web_api("GET", "/api/zededa")
            self.assertEqual((status, info["enabled"], info["session"]), (200, True, None))
            status, answer = core.web_api("POST", "/api/zededa/login", {"password": "zededa-pw"})
            self.assertEqual((status, answer["session"]["user"]), (200, "eni@example.net"))
        with mock.patch.object(core, "WEB_LOCAL_KEY", os.path.join(TMP, "missing.key")):
            self.assertEqual(core.web_api("GET", "/api/zededa")[0], 0)      # web management not running

    def test_off(self):
        self.start_tls()
        core.save_settings({"SERVER_IP": "auto", "ZEDEDA_ONBOARDING": "no"})
        self.assertEqual(self.onboard()["eve_ob_ok"], "0")


def Handler_app():
    return web.Handler.app


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

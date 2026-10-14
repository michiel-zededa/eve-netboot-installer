"""
ZEDEDA onboarding: the API client (vm/rootfs/usr/local/lib/eve-netboot/zededa.py),
the boot menu's onboarding option (app/eve_sync.py) and the appliance's
settings. The web management part is in test_web.py.
"""
import importlib.machinery
import importlib.util
import json
import os
import re
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "vm", "rootfs", "usr", "local", "lib", "eve-netboot")
sys.path.insert(0, LIB)
sys.path.insert(0, os.path.join(HERE, "..", "app"))
os.environ.setdefault("ENI_ETC", tempfile.mkdtemp(prefix="eve-netboot-etc-"))
os.environ.setdefault("ENI_BASE_URL", "http://192.0.2.10:8080")
import zededa  # noqa: E402
import eve_sync  # noqa: E402

_loader = importlib.machinery.SourceFileLoader(
    "eve_netboot_ob", os.path.join(HERE, "..", "vm", "rootfs", "usr", "local", "sbin", "eve-netboot"))
app = importlib.util.module_from_spec(importlib.util.spec_from_loader("eve_netboot_ob", _loader))
_loader.exec_module(app)

MAC = "52-54-00-12-34-56"


class FakeApi:
    """opener for zededa.Client: records requests, answers from a table."""

    def __init__(self, answers):
        self.answers = answers      # (method, path) -> (status, body)
        self.requests = []

    def __call__(self, req, timeout):
        path = req.full_url.split("/api", 1)[1]
        body = json.loads(req.data) if req.data else None
        self.requests.append((req.get_method(), path, body, req.get_header("Authorization")))
        status, answer = self.answers.get((req.get_method(), path), (404, {"error": [{"details": "not found"}]}))
        return status, json.dumps(answer).encode()


class ClientTest(unittest.TestCase):

    def test_login_keeps_the_token_and_its_expiry(self):
        api = FakeApi({("POST", "/v1/login"): (200, {
            "token": {"base64": "TOKEN", "expires": "1792003034371309674"}, "role": {"name": "SysManager"}})})
        c = zededa.Client("zedcontrol.example.net", opener=api)
        info = c.login("user@example.net", "pw", "ENT")
        self.assertEqual((info["token"], int(info["expires"]), info["role"]), ("TOKEN", 1792003034, "SysManager"))
        method, path, body, auth = api.requests[0]
        self.assertEqual((method, path, auth), ("POST", "/v1/login", None))
        self.assertEqual((body["usernameAtRealm"], body["password"], body["enterpriseName"]),
                         ("user@example.net", "pw", "ENT"))

    def test_failed_login_says_why(self):
        api = FakeApi({("POST", "/v1/login"): (401, {"cause": "CREDENTIAL_MISMATCH", "noOfLoginAttemptsLeft": 0})})
        with self.assertRaises(zededa.ZededaError) as e:
            zededa.Client("zedcontrol.example.net", opener=api).login("u", "wrong", "ENT")
        self.assertEqual((e.exception.status, str(e.exception)), (401, "CREDENTIAL_MISMATCH"))

    def test_a_node_without_model_goes_to_the_model_less_endpoint(self):
        api = FakeApi({("POST", "/v1/devices/model-less"): (200, {"objectId": "id-1"})})
        c = zededa.Client("zedcontrol.example.net", token="TOKEN", opener=api)
        self.assertEqual(c.create_modelless("eve-x", "eve-x", "proj-1", MAC, "key-1"), "id-1")
        method, path, body, auth = api.requests[0]
        self.assertEqual((method, path, auth), ("POST", "/v1/devices/model-less", "Bearer TOKEN"))
        self.assertEqual(body, {"name": "eve-x", "title": "eve-x", "projectId": "proj-1", "serialno": MAC,
                                "obkey": "key-1"})
        self.assertNotIn("modelId", body)

    def test_controller_errors_are_reported(self):
        api = FakeApi({("POST", "/v1/devices/model-less"): (400, {"error": [{"ec": "BadReqBody",
                                                                               "details": "Invalid Model"}]})})
        with self.assertRaises(zededa.ZededaError) as e:
            zededa.Client("zedcontrol.example.net", token="T", opener=api).create_modelless("a", "a", "p", MAC, "k")
        self.assertEqual((e.exception.status, str(e.exception)), (400, "Invalid Model"))

    def test_token_check(self):
        api = FakeApi({("GET", "/v1/sessions/self"): (200, {"username": "u@example.net",
                                                             "token": {"expires": "1792003034371309674"}})})
        info = zededa.Client("zedcontrol.example.net", token="T", opener=api).check()
        self.assertEqual((info["user"], int(info["expires"])), ("u@example.net", 1792003034))
        # an API token that may not read its session: accepted, without details
        api = FakeApi({("GET", "/v1/sessions/self"): (403, {"error": [{"details": "forbidden"}]})})
        self.assertEqual(zededa.Client("zedcontrol.example.net", token="T", opener=api).check(),
                         {"user": "", "expires": None})
        api = FakeApi({("GET", "/v1/sessions/self"): (401, {"cause": "UNAUTHENTICATED"})})
        with self.assertRaises(zededa.ZededaError):
            zededa.Client("zedcontrol.example.net", token="T", opener=api).check()

    def test_node_status(self):
        api = FakeApi({("GET", "/v1/devices/id/n1/status"): (200, {
            "runState": "RUN_STATE_ONLINE", "lastUpdate": "2026-10-14T19:00:00Z",
            "swInfo": [{"activated": False, "shortVersion": "16.0.0"}, {"activated": True, "shortVersion": "17.0.0-lts"}],
            "devError": [{"description": "disk almost full"}]})})
        st = zededa.Client("zedcontrol.example.net", token="T", opener=api).device_status("n1")
        self.assertEqual(st, {"run_state": "RUN_STATE_ONLINE", "state": "online", "last_seen": "2026-10-14T19:00:00Z",
                              "eve": "17.0.0-lts", "error": "disk almost full"})
        for run, cat in (("RUN_STATE_UNPROVISIONED", "waiting"), ("RUN_STATE_UNSPECIFIED", "waiting"),
                         ("RUN_STATE_PROVISIONED", "starting"), ("RUN_STATE_BOOTING", "starting"),
                         ("RUN_STATE_OFFLINE", "offline"), ("RUN_STATE_SUSPECT", "offline"),
                         ("RUN_STATE_ERROR", "error"), ("", "waiting")):
            with self.subTest(run=run):
                self.assertEqual(zededa.run_category(run), cat)

    def test_lookup_by_serial(self):
        api = FakeApi({("GET", f"/v1/devices/serial/{MAC}"): (200, {"name": "eve-old"})})
        c = zededa.Client("zedcontrol.example.net", token="T", opener=api)
        self.assertEqual(c.device_by_serial(MAC)["name"], "eve-old")
        self.assertIsNone(c.device_by_serial("52-54-00-00-00-00"))      # 404 = no such node

    def test_no_answer(self):
        def down(req, timeout):
            raise OSError("connection refused")
        with self.assertRaises(zededa.ZededaError) as e:
            zededa.Client("zedcontrol.example.net", opener=down).project("p")
        self.assertEqual(e.exception.status, 0)

    def test_only_host_names_as_cluster(self):
        for bad in ("", "zedcontrol", "http://x.example", "x.example/../y", "a b.example"):
            with self.subTest(bad=bad), self.assertRaises(zededa.ZededaError):
                zededa.Client(bad)

    def test_node_names(self):
        self.assertEqual(zededa.node_name("eve-{mac}", MAC), "eve-52-54-00-12-34-56")
        self.assertEqual(zededa.node_name("site1_{serial}", MAC, "SN 123/AB"), "site1-sn-123-ab")
        # whitebox placeholders are no serial: the MAC address instead
        for junk in ("To Be Filled By O.E.M.", "Default string", "", "0000000", "System Serial Number"):
            with self.subTest(junk=junk):
                self.assertEqual(zededa.node_name("n-{serial}", MAC, junk), "n-52-54-00-12-34-56")
        self.assertLessEqual(len(zededa.node_name("{serial}", MAC, "x" * 200)), 63)


class MenuTest(unittest.TestCase):

    def render(self, url):
        entries = [{"source": "github", "arch": "amd64", "variant": "kvm", "tag": tag,
                    "path": f"releases/{tag}/amd64.kvm", "label": tag, "args": "root=/installer.iso",
                    "console": "console=tty0", "netboot_ok": True, "iso_size": 1}
                   for tag in ("16.0.4-lts", "17.0.0-lts")]
        with mock.patch.object(eve_sync, "ONBOARD_URL", url):
            return eve_sync.render_menu(entries, "2026-01-01 00:00")

    def test_without_onboarding_nothing_changes(self):
        m = self.render("")
        self.assertNotIn("onboard", m.lower())
        self.assertNotIn("#@", m)
        self.assertNotIn("eve_ob", m)

    def test_option_summary_and_registration(self):
        url = "http://192.0.2.20:8443/ipxe/onboard"
        m = self.render(url)
        self.assertTrue(m.isascii())
        self.assertNotIn("#@", m)
        self.assertIn("set eve_onboard 1", m)
        # not among the general installation options (chosen before the image)
        opts = m[m.index(":eve_opt\n"):m.index(":eve_o_disk")]
        self.assertNotIn("ZEDEDA", opts)
        # the summary of an EVE-OS 17+ image is a menu with the option under o
        self.assertIn("iseq ${eve_rel_ok} 1 && goto eve_confirm_ob ||", m)
        confirm = m[m.index(":eve_confirm_ob"):m.index(":eve_boot\n")]
        self.assertIn("item --key i eve_boot ${eve_sp}Install now [i]", confirm)
        self.assertIn("item --key o eve_ob_toggle ${eve_sp}Onboard in ZEDEDA: ${eve_onboard_s}  [o]", confirm)
        self.assertIn("isset ${eve_ob_s} && item --gap ZEDEDA node: ${eve_ob_s} ||", confirm)
        self.assertIn("choose --default eve_menu", confirm)          # Enter alone installs nothing
        # a name for this one machine (key n), sent with both requests
        self.assertIn("iseq ${eve_ob_do} 1 && item --key n eve_ob_rename ${eve_sp}Node name: ${eve_ob_name_s}  [n] ||",
                      confirm)
        self.assertIn("read eve_ob_name", confirm)
        self.assertEqual(m.count("&name=${eve_ob_name:uristring}"), 2)
        self.assertIn("clear eve_ob_name", m[:m.index(":eve_detect")])  # a new machine starts without one
        self.assertIn(f"chain --autofree {url}?action=preview&mac=${{mac:hexhyp}}&serial=${{serial:uristring}}", m)
        self.assertIn(f"chain --autofree {url}?action=register&mac=${{mac:hexhyp}}", m)
        # registered only after i, before the installer is loaded
        boot = m.index(":eve_boot\n")
        self.assertLess(boot, m.index("action=register"))
        self.assertLess(m.index("action=register"), m.index("imgfree", boot))
        # older EVE-OS cannot report its hardware: no onboarding, the summary as before
        rel = re.findall(r"set eve_title EVE-OS (\S+) .*?\nset eve_rel_ok (\d)", m, re.S)
        self.assertEqual(rel, [("16.0.4-lts", "0"), ("17.0.0-lts", "1")])
        check = m[m.index("set eve_ob_do 0"):m.index(":eve_ob_checked")]
        self.assertTrue(check.startswith("set eve_ob_do 0\nclear eve_ob_s\niseq ${eve_rel_ok} 1 || goto eve_ob_checked"))
        # the soft serial (the MAC address) is what ZEDEDA matches on
        self.assertIn("iseq ${eve_softserial} 1 || goto eve_ob_checked", check)

    def test_unsafe_url_is_ignored(self):
        self.assertEqual(eve_sync.release_major({"tag": "17.0.0-lts"}), 17)
        self.assertEqual(eve_sync.release_major({"release": "16.0.4-lts"}), 16)
        self.assertEqual(eve_sync.release_major({"name": "own.iso"}), 0)


class SettingsTest(unittest.TestCase):

    def test_off_by_default_and_nothing_for_the_stack(self):
        self.assertEqual(app.get({}, "ZEDEDA_ONBOARDING"), "no")
        env = app.render_stack_env({}, "192.0.2.20", "img")
        self.assertIn("ENI_ONBOARD_URL=''", env)
        self.assertNotIn("ZEDEDA_", env)        # VM settings, not the stack's

    def test_on(self):
        s = {"ZEDEDA_ONBOARDING": "yes", "ZEDEDA_ENTERPRISE": "ENT", "ZEDEDA_USER": "u@example.net",
             "ZEDEDA_PROJECT": "netboot"}
        self.assertEqual(app.zededa_problems(s), [])
        env = app.render_stack_env(s, "192.0.2.20", "img")
        self.assertIn("ENI_ONBOARD_URL='http://192.0.2.20:8443/ipxe/onboard'", env)
        self.assertEqual(app.onboard_url({**s, "WEB_ADMIN": "no"}, "192.0.2.20"), "")

    def test_problems(self):
        s = {"ZEDEDA_ONBOARDING": "yes", "WEB_ADMIN": "no", "ZEDEDA_CLUSTER": "http://x",
             "ZEDEDA_ONBOARDING_KEY": "abc", "ZEDEDA_NODE_NAME": "fixed-name"}
        keys = sorted(k for k, _ in app.zededa_problems(s))
        self.assertEqual(keys, ["ZEDEDA_CLUSTER", "ZEDEDA_NODE_NAME", "ZEDEDA_ONBOARDING",
                                "ZEDEDA_ONBOARDING_KEY", "ZEDEDA_PROJECT"])

    def test_user_and_enterprise_only_for_a_password(self):
        # an API token needs neither: they are not required settings
        self.assertEqual(app.zededa_problems({"ZEDEDA_ONBOARDING": "yes", "ZEDEDA_PROJECT": "onboarding"}), [])

    def test_naming_convention(self):
        ok = {"ZEDEDA_ONBOARDING": "yes", "ZEDEDA_ENTERPRISE": "E", "ZEDEDA_USER": "u", "ZEDEDA_PROJECT": "p"}
        for name in ("eve-{mac}", "site1-{serial}", "bench1-node-{n:3}", "n{n}"):
            with self.subTest(name=name):
                self.assertEqual(app.zededa_problems({**ok, "ZEDEDA_NODE_NAME": name}), [])
        for name in ("fixed", "x-{n:12}", "a b-{n}", "{foo}-{n}", "x" * 49 + "{n}"):
            with self.subTest(name=name):
                self.assertEqual([k for k, _ in app.zededa_problems({**ok, "ZEDEDA_NODE_NAME": name})],
                                 ["ZEDEDA_NODE_NAME"])
        self.assertEqual([k for k, _ in app.zededa_problems({**ok, "ZEDEDA_NODE_NEXT": "x"})], ["ZEDEDA_NODE_NEXT"])
        self.assertEqual(zededa.node_name("bench1-node-{n:3}", MAC, number=7), "bench1-node-007")
        self.assertEqual(zededa.node_name("b{n}-{mac}", MAC, number=12), "b12-52-54-00-12-34-56")

    def test_every_settings_group_is_in_the_console_menu(self):
        import inspect
        src = inspect.getsource(app.menu)
        for section in app.SECTIONS:
            with self.subTest(section=section):
                self.assertIn(f'("{section}", tr("adm_sec_{section}"))', src)

    def test_no_password_or_token_setting(self):
        # the ZEDEDA password and session are never settings: nothing to store or export
        self.assertFalse([k for k in app.FIELDS if k.startswith("ZEDEDA_") and
                          ("PASSWORD" in k or "TOKEN" in k)])


if __name__ == "__main__":
    unittest.main()

"""
Unit tests for app/eve_sync.py (standard library only).

    python3 -m unittest discover -s tests -v
"""

import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
RELEASES = ["14.5.5-lts", "17.0.0-lts"]

# eve_sync reads its configuration at import time
TMP = tempfile.mkdtemp(prefix="eve-sync-test-")
os.environ.update({
    "ENI_ASSETS": os.path.join(TMP, "assets"),
    "ENI_TFTP_DIR": os.path.join(TMP, "tftp"),
    "ENI_IMPORT": os.path.join(TMP, "import"),
    "ENI_BASE_URL": "http://192.0.2.10:8080",
    "ENI_LANGUAGE": "en",
})
sys.path.insert(0, os.path.join(HERE, "..", "app"))
import eve_sync  # noqa: E402

LINUXKIT_CMDLINE = "console=ttyS0 placeholder=1"


class Later(eve_sync.datetime.datetime):
    """A clock far in the future: generated files must not change with it."""
    @classmethod
    def now(cls, tz=None):
        return cls(2099, 12, 31, 23, 59)


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


def release_dir(tag):
    """A prepared-release directory like prepare_dir() builds it."""
    d = tempfile.mkdtemp(dir=TMP)
    shutil.copytree(os.path.join(FIXTURES, f"eve-{tag}", "EFI"), os.path.join(d, "EFI"))
    with open(os.path.join(d, "cmdline"), "w") as f:
        f.write(LINUXKIT_CMDLINE + "\n")
    return d


def entry(arch="amd64", variant="kvm", tag="17.0.0-lts", **extra):
    e = {"source": "github", "arch": arch, "variant": variant, "tag": tag,
         "path": f"releases/{tag}/{arch}.{variant}", "label": f"{tag}  {variant}  (2026-01-01)",
         "args": "root=/installer.iso x=1", "console": "console=tty0",
         "netboot_ok": True, "ucode": True, "iso_size": 475 << 20}
    e.update(extra)
    return e


class BootArgsTest(unittest.TestCase):
    """build_boot_args() against the real GRUB files of EVE releases."""

    def test_amd64_kvm(self):
        for tag in RELEASES:
            with self.subTest(tag=tag):
                b = eve_sync.build_boot_args(release_dir(tag), "amd64", "kvm")
                args = b["args"].split()
                self.assertTrue(b["netboot_ok"])
                # every installer ISO boots as kvm, also the 'k' ones
                self.assertEqual(b["flavour"], "kvm")
                self.assertEqual(b["console"], "console=tty0")
                self.assertEqual(args[:4], ["root=/installer.iso", "rootimg=/rootfs_installer.img",
                                            "rootaddmount=/config.img:/config.img",
                                            "dom0_mem=640M,max:800M"])
                for want in ("eve_mem=520M,max:650M", "ctrd_mem=320M,max:400M",
                             "dom0_max_vcpus=1", "dom0_vcpus_pin", "eve_max_vcpus=1",
                             "ctrd_max_vcpus=1", "change=500",
                             "pcie_acs_override=downstream,multifunction",
                             "crashkernel=2G-16G:128M,16G-128G:256M,128G-:512M",
                             "panic=120", "rfkill.default_state=0", "split_lock_detect=off",
                             "getty", "rootwait", "placeholder=1"):
                    self.assertIn(want, args)
                self.assertNotIn("$", b["args"])

    def test_new_release_settings_are_picked_up(self):
        self.assertNotIn("log_buf_len=2M", eve_sync.build_boot_args(
            release_dir("14.5.5-lts"), "amd64", "kvm")["args"])
        self.assertIn("log_buf_len=2M", eve_sync.build_boot_args(
            release_dir("17.0.0-lts"), "amd64", "kvm")["args"])

    def test_arm64(self):
        b = eve_sync.build_boot_args(release_dir("17.0.0-lts"), "arm64", "kvm")
        self.assertNotIn("crashkernel", b["args"])
        self.assertEqual(b["console"], "console=tty0 console=ttyS0,115200 console=hvc0")

    def test_fallbacks_without_grub_files(self):
        d = tempfile.mkdtemp(dir=TMP)
        b = eve_sync.build_boot_args(d, "amd64", "k")
        self.assertFalse(b["netboot_ok"])
        self.assertEqual(b["flavour"], "k")
        self.assertIn("dom0_mem=6400M,max:8000M", b["args"])
        self.assertTrue(b["args"].startswith("root=/installer.iso "))


class MenuTest(unittest.TestCase):

    def render(self, entries=None, checked="2026-01-02 03:04"):
        if entries is None:
            entries = [entry(), entry(arch="arm64"),
                       {"source": "local", "arch": "amd64", "variant": "", "name": "own.iso",
                        "file": "own.iso", "path": "local/own", "label": "own.iso  (2026-01-01)",
                        "args": "root=/installer.iso", "console": "console=tty0",
                        "netboot_ok": True, "iso_size": 1},
                       {"source": "local", "file": "bad.iso", "path": "local/bad",
                        "error": "boom", "label": "bad.iso  [ERROR: boom]"}]
        return eve_sync.render_menu(entries, checked)

    def test_independent_of_the_clock(self):
        # regression: a timestamp in the output rewrote the menu every minute
        first = self.render()
        with mock.patch.object(eve_sync.datetime, "datetime", Later):
            self.assertEqual(first, self.render())
            self.assertEqual(eve_sync.render_index([entry()], None),
                             eve_sync.render_index([entry()], None))

    def test_github_checked(self):
        self.assertIn("updated 2026-01-02 03:04)", self.render())
        self.assertIn("updated -)", self.render(checked=None))

    def test_ascii_and_no_placeholders(self):
        m = self.render()
        self.assertTrue(m.isascii())
        self.assertNotIn("@@", m)

    def test_goto_targets_exist(self):
        m = self.render()
        labels = re.findall(r"^:(\S+)", m, re.M)
        self.assertEqual(len(labels), len(set(labels)), "duplicate labels")
        targets = set(re.findall(r"goto (\w+)", m)) | set(re.findall(r"^item (eve_\w+)", m, re.M))
        self.assertEqual(targets - set(labels), set())

    def test_untrusted_names_are_neutralised(self):
        e = entry(source="local", label="evil ${shell}\nchain http://x/", path="local/evil")
        m = self.render([e])
        self.assertNotIn("${shell}", m)
        self.assertNotIn("\nchain http://x/", m)

    def test_errored_local_entry_is_not_bootable(self):
        m = self.render()
        self.assertIn("item --gap ${eve_sp}bad.iso", m)
        self.assertNotIn("local/bad", m)

    def test_every_language(self):
        en = eve_sync.load_texts("en")
        try:
            for lang in ("da", "de", "en", "es", "fr", "nl", "no", "pt"):
                with self.subTest(lang=lang):
                    with open(os.path.join(HERE, "..", "app", "i18n", f"{lang}.json"), encoding="utf-8") as f:
                        self.assertEqual(set(json.load(f)), set(en))
                    eve_sync.T, eve_sync.LANGUAGE = eve_sync.load_texts(lang), lang
                    m = self.render()
                    self.assertTrue(m.isascii())
                    self.assertNotIn("@@", m)
                    self.assertIn(f'lang="{lang}"', eve_sync.render_index([entry()], None))
        finally:
            eve_sync.T, eve_sync.LANGUAGE = en, "en"


class WriteMenusTest(unittest.TestCase):

    def setUp(self):
        shutil.rmtree(eve_sync.ASSETS, ignore_errors=True)
        os.makedirs(eve_sync.REL_ROOT)
        quiet = mock.patch.object(eve_sync, "log")
        quiet.start()
        self.addCleanup(quiet.stop)

    def test_unchanged_content_is_not_rewritten(self):
        eve_sync.save_state(github_checked="2026-01-02 03:04")
        eve_sync.write_menus()
        files = [os.path.join(eve_sync.EVE_ROOT, "eve.ipxe"), os.path.join(eve_sync.EVE_ROOT, "status.json"),
                 os.path.join(eve_sync.ASSETS, "index.html")]
        before = {p: (os.stat(p).st_mtime_ns, eve_sync.read_text(p)) for p in files}
        with mock.patch.object(eve_sync, "log") as log, \
                mock.patch.object(eve_sync.datetime, "datetime", Later):
            eve_sync.write_menus()
        self.assertEqual(before, {p: (os.stat(p).st_mtime_ns, eve_sync.read_text(p)) for p in files})
        log.assert_not_called()

    def test_status_updated_follows_content(self):
        eve_sync.write_menus()
        path = os.path.join(eve_sync.EVE_ROOT, "status.json")
        with open(path) as f:
            first = json.load(f)
        first["updated"] = "2000-01-01T00:00:00"
        with open(path, "w") as f:
            json.dump(first, f)
        eve_sync.write_menus()
        with open(path) as f:
            self.assertEqual(json.load(f)["updated"], "2000-01-01T00:00:00")
        eve_sync.save_state(github_checked="2026-01-02 03:04")
        eve_sync.write_menus()
        with open(path) as f:
            status = json.load(f)
        self.assertNotEqual(status["updated"], "2000-01-01T00:00:00")
        self.assertEqual(status["github_checked"], "2026-01-02 03:04")


class StopLoop(Exception):
    """Ends main() after a number of cycles (unlike SystemExit, which main() raises itself)."""


class WebUiTest(unittest.TestCase):

    def setUp(self):
        shutil.rmtree(eve_sync.ASSETS, ignore_errors=True)
        os.makedirs(eve_sync.REL_ROOT)
        self.ui = tempfile.mkdtemp(dir=TMP)
        os.makedirs(os.path.join(self.ui, "ui", "assets"))
        for rel, text in (("index.html", "<html>v1</html>"), ("ui/assets/app-1.js", "v1"),
                          ("ui/zededa-logo.svg", "<svg/>")):
            with open(os.path.join(self.ui, rel), "w") as f:
                f.write(text)
        patch = mock.patch.multiple(eve_sync, UI_DIR=self.ui, log=mock.DEFAULT)
        patch.start()
        self.addCleanup(patch.stop)

    def read_asset(self, rel):
        with open(os.path.join(eve_sync.ASSETS, rel)) as f:
            return f.read()

    def test_ui_is_installed_and_old_versions_removed(self):
        self.assertTrue(eve_sync.install_ui())
        self.assertEqual(self.read_asset("index.html"), "<html>v1</html>")
        self.assertEqual(self.read_asset("ui/assets/app-1.js"), "v1")
        # a new UI version with another hashed file name
        os.remove(os.path.join(self.ui, "ui", "assets", "app-1.js"))
        with open(os.path.join(self.ui, "ui", "assets", "app-2.js"), "w") as f:
            f.write("v2")
        eve_sync.install_ui()
        self.assertFalse(os.path.exists(os.path.join(eve_sync.ASSETS, "ui", "assets", "app-1.js")))
        self.assertEqual(self.read_asset("ui/assets/app-2.js"), "v2")
        # the mirror itself is never touched
        self.assertTrue(os.path.isdir(eve_sync.REL_ROOT))

    def test_without_built_ui_the_simple_page_is_written(self):
        with mock.patch.object(eve_sync, "UI_DIR", os.path.join(TMP, "no-ui")):
            eve_sync.write_menus()
        self.assertIn("EVE-Netboot-Installer", self.read_asset("index.html"))

    def test_status_and_texts_for_the_ui(self):
        eve_sync.write_menus()
        with open(os.path.join(eve_sync.EVE_ROOT, "status.json")) as f:
            status = json.load(f)
        for key in ("menu_timeout", "defaults", "version", "admin_url", "import_label"):
            self.assertIn(key, status["config"])
        with open(os.path.join(eve_sync.EVE_ROOT, "ui.json"), encoding="utf-8") as f:
            ui = json.load(f)
        self.assertEqual(ui["language"], eve_sync.LANGUAGE)
        self.assertIn("ui_nav_home", ui["texts"])
        self.assertEqual(set(eve_sync.STATUS_FIELDS) >= {"args", "config_img", "published", "mtime"}, True)

    def test_activity(self):
        eve_sync.write_activity("downloading", "17.0.0-lts amd64.kvm", 50 << 20, 200 << 20)
        with open(os.path.join(eve_sync.EVE_ROOT, "activity.json")) as f:
            a = json.load(f)
        self.assertEqual((a["state"], a["item"], a["done_mb"], a["total_mb"], a["percent"]),
                         ("downloading", "17.0.0-lts amd64.kvm", 50, 200, 25))
        self.assertIn("free_gb", a["disk"])
        eve_sync.write_activity()
        with open(os.path.join(eve_sync.EVE_ROOT, "activity.json")) as f:
            self.assertEqual(json.load(f)["state"], "idle")


class MainLoopTest(unittest.TestCase):

    def run_loop(self, interval, cycles=3):
        sleeps = []

        def sleep(_):
            sleeps.append(1)
            if len(sleeps) >= cycles:
                raise StopLoop
        local = mock.Mock(return_value=False)   # the import folder has nothing new
        with mock.patch.multiple(eve_sync, SYNC_INTERVAL=interval, sync_local=local,
                                 sync_github=mock.DEFAULT, write_menus=mock.DEFAULT,
                                 log=mock.DEFAULT) as m, \
                mock.patch.object(eve_sync.time, "sleep", sleep), \
                mock.patch.object(eve_sync.shutil, "which", return_value="/usr/bin/bsdtar"), \
                mock.patch.object(sys, "argv", ["eve_sync.py"]):
            with self.assertRaises(StopLoop):
                eve_sync.main()
        m["sync_local"] = local
        return m

    def test_interval_zero_keeps_watching_imports(self):
        # regression: ENI_SYNC_INTERVAL=0 used to end the process after one cycle
        m = self.run_loop(0)
        self.assertEqual(m["sync_github"].call_count, 1)
        self.assertEqual(m["sync_local"].call_count, 3)

    def test_interval(self):
        m = self.run_loop(86400)
        self.assertEqual(m["sync_github"].call_count, 1)
        # once right at start (before any download), then once per cycle
        self.assertEqual(m["write_menus"].call_count, 1 + 3)


class GithubSelectionTest(unittest.TestCase):

    def test_newest_patch_of_newest_lines(self):
        def rel(tag, iso=True, **kw):
            assets = [{"name": "amd64.kvm.generic.installer.iso"}] if iso else []
            return {"tag_name": tag, "assets": assets, **kw}
        page = [rel("17.0.0-lts"), rel("17.0.1-lts", prerelease=True), rel("16.0.2-lts"),
                rel("16.0.10-lts"), rel("15.0.0"), rel("14.5.5-lts"), rel("13.4.0-lts"),
                rel("11.0.0-lts", iso=False), rel("18.0.0-lts", draft=True)]
        with mock.patch.object(eve_sync, "http_json", side_effect=[page, []]), \
                mock.patch.object(eve_sync, "LTS_LINES", 3):
            got = [r["tag_name"] for r in eve_sync.wanted_lts_releases()]
        self.assertEqual(got, ["17.0.0-lts", "16.0.10-lts", "14.5.5-lts"])


class GithubTokenTest(unittest.TestCase):

    def test_api_url_is_exact(self):
        self.assertTrue(eve_sync.is_api_url("https://api.github.com/repos/lf-edge/eve/releases"))
        for url in ("http://api.github.com/repos", "https://api.github.com.example.org/",
                    "https://example.org/?api.github.com", "https://github.com/lf-edge/eve/releases/download/x",
                    "https://objects.githubusercontent.com/x"):
            self.assertFalse(eve_sync.is_api_url(url), url)

    def headers_sent(self, url, token):
        with mock.patch.object(eve_sync, "TOKEN", token), \
                mock.patch.object(eve_sync._opener, "open") as op:
            eve_sync.http_get(url)
        return op.call_args[0][0].headers

    def test_token_only_to_api(self):
        api = "https://api.github.com/repos/lf-edge/eve/releases"
        self.assertEqual(self.headers_sent(api, "t0k")["Authorization"], "Bearer t0k")
        self.assertNotIn("Authorization", self.headers_sent("https://github.com/x.iso", "t0k"))
        self.assertNotIn("Authorization", self.headers_sent(api, ""))

    def test_token_dropped_on_redirect_to_other_host(self):
        req = eve_sync.urllib.request.Request("https://api.github.com/x",
                                              headers={"Authorization": "Bearer t0k"})
        handler = eve_sync._RedirectHandler()
        same = handler.redirect_request(req, None, 301, "", {}, "https://api.github.com/repositories/1/x")
        other = handler.redirect_request(req, None, 302, "", {}, "https://objects.githubusercontent.com/x")
        self.assertEqual(same.get_header("Authorization"), "Bearer t0k")
        self.assertIsNone(other.get_header("Authorization"))

    def test_compose_does_not_pass_github_token(self):
        with open(os.path.join(HERE, "..", "compose.yaml")) as f:
            compose = f.read()
        self.assertNotRegex(compose, r"(?m)^\s*GITHUB_TOKEN:")
        self.assertIn("ENI_GITHUB_TOKEN: ${ENI_GITHUB_TOKEN:-${EVE_GITHUB_TOKEN:-}}", compose)

    def test_compose_keeps_old_names_working(self):
        with open(os.path.join(HERE, "..", "compose.yaml")) as f:
            compose = f.read()
        uses = set(re.findall(r"\$\{ENI_([A-Z_]+):-", compose))
        # settings renamed in 1.3 need the fallback; newer ENI_ settings (ADMIN_URL) do not
        self.assertEqual(set(eve_sync.RENAMED) - uses, {"SRC_DIR", "IMAGE"} - uses)
        for name in uses & set(eve_sync.RENAMED):
            self.assertIn("${ENI_%s:-${EVE_%s:-" % (name, name), compose)
            self.assertIn("${EVE_%s:+EVE_%s }" % (name, name), compose)


class OldNamesTest(unittest.TestCase):
    """Settings were called EVE_* before 1.3; the old names keep working."""

    def test_env_falls_back_to_old_name(self):
        with mock.patch.dict(os.environ, {"EVE_SOMETHING": "old"}):
            self.assertEqual(eve_sync._env("ENI_SOMETHING", "default"), "old")
        with mock.patch.dict(os.environ, {"EVE_SOMETHING": "old", "ENI_SOMETHING": "new"}):
            self.assertEqual(eve_sync._env("ENI_SOMETHING", "default"), "new")
        self.assertEqual(eve_sync._env("ENI_SOMETHING", "default"), "default")

    def test_legacy_names_reported(self):
        env = {"ENI_LEGACY_NAMES": "EVE_LANGUAGE EVE_MENU_MODE ", "EVE_SYNC_INTERVAL": "0",
               # current names about EVE-OS, never reported
               "EVE_ARCHES": "arm64", "EVE_LTS_LINES": "2", "EVE_GITHUB_REPO": "x/y",
               "EVE_DEFAULT_SERIAL": "ttyS0",
               # the new name is set as well: nothing to report
               "EVE_IMAGE": "x", "ENI_IMAGE": "y"}
        with mock.patch.dict(os.environ, env):
            self.assertEqual(eve_sync.legacy_names(), ["EVE_LANGUAGE", "EVE_MENU_MODE", "EVE_SYNC_INTERVAL"])


class HelpersTest(unittest.TestCase):

    def test_is_eve_iso(self):
        def iso(volume_id):
            p = os.path.join(tempfile.mkdtemp(dir=TMP), "x.iso")
            pvd = b"\x01CD001\x01\x00" + b" " * 32 + volume_id.ljust(32).encode()
            with open(p, "wb") as f:
                f.write(b"\0" * 0x8000 + pvd)
            return p
        self.assertTrue(eve_sync.is_eve_iso(iso("EVEISO")))
        self.assertFalse(eve_sync.is_eve_iso(iso("UBUNTU")))

    def test_chmod_readable(self):
        d = tempfile.mkdtemp(dir=TMP)
        os.makedirs(os.path.join(d, "sub"))
        f = os.path.join(d, "sub", "file")
        open(f, "w").close()
        os.chmod(f, 0o600)
        os.chmod(os.path.join(d, "sub"), 0o700)
        eve_sync.chmod_readable(d)
        self.assertEqual(os.stat(f).st_mode & 0o777, 0o644)
        self.assertEqual(os.stat(os.path.join(d, "sub")).st_mode & 0o777, 0o755)

    def test_ascii_transliteration(self):
        with mock.patch.object(eve_sync, "LANGUAGE", "de"):
            self.assertEqual(eve_sync.ascii_text("Prüfung"), "Pruefung")
        with mock.patch.object(eve_sync, "LANGUAGE", "no"):
            self.assertEqual(eve_sync.ascii_text("Siste sjekk på"), "Siste sjekk paa")


if __name__ == "__main__":
    unittest.main()

"""
Unit tests for the VM appliance helper (vm/rootfs/usr/local/sbin/eve-netboot):
settings parsing, cloud-init input, validation and the generated files.

    python3 -m unittest discover -s tests -v
"""

import importlib.machinery
import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "vm", "rootfs", "usr", "local", "sbin", "eve-netboot")

os.environ["EVE_NETBOOT_ETC"] = tempfile.mkdtemp(prefix="eve-netboot-etc-")
_loader = importlib.machinery.SourceFileLoader("eve_netboot", HELPER)
_spec = importlib.util.spec_from_loader("eve_netboot", _loader)
app = importlib.util.module_from_spec(_spec)
_loader.exec_module(app)

try:
    import yaml  # noqa: F401
    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False

VALID = {"SERVER_IP": "auto", "NET_MODE": "dhcp"}


class ParseEnvTest(unittest.TestCase):

    def test_compose_compatible(self):
        text = """
# comment
SERVER_IP=192.168.1.10          # <- marker
EVE_ARCHES=amd64 arm64
QUOTED="a # not a comment"
SINGLE='x'
export TZ=Europe/Amsterdam
lower=ignored
BROKEN
EMPTY=
"""
        self.assertEqual(app.parse_env(text), {
            "SERVER_IP": "192.168.1.10", "EVE_ARCHES": "amd64 arm64", "QUOTED": "a # not a comment",
            "SINGLE": "x", "TZ": "Europe/Amsterdam", "EMPTY": ""})

    def test_password_with_hash_needs_quotes(self):
        self.assertEqual(app.parse_env("ADMIN_PASSWORD=abc#1")["ADMIN_PASSWORD"], "abc#1")
        self.assertEqual(app.parse_env('ADMIN_PASSWORD="abc #1"')["ADMIN_PASSWORD"], "abc #1")


class UserDataTest(unittest.TestCase):

    def test_plain_key_value(self):
        self.assertEqual(app.parse_user_data("SERVER_IP=auto\nEVE_LANGUAGE=nl\n"),
                         {"SERVER_IP": "auto", "EVE_LANGUAGE": "nl"})

    def test_not_ours(self):
        for text in ("", "   \n", "#!/bin/sh\necho hi\n", "Content-Type: multipart/mixed\n",
                     "#include http://x\n", "just some text\n"):
            self.assertIsNone(app.parse_user_data(text), text)

    @unittest.skipUnless(HAVE_YAML, "python3-yaml not installed")
    def test_cloud_config(self):
        text = """#cloud-config
password: x
eve_netboot:
  server_ip: auto
  EVE_ARCHES: amd64 arm64
  SSH_PASSWORD_LOGIN: false
  EVE_LTS_LINES: 2
"""
        self.assertEqual(app.parse_user_data(text), {
            "SERVER_IP": "auto", "EVE_ARCHES": "amd64 arm64", "SSH_PASSWORD_LOGIN": "no", "EVE_LTS_LINES": "2"})

    @unittest.skipUnless(HAVE_YAML, "python3-yaml not installed")
    def test_cloud_config_without_our_section(self):
        self.assertIsNone(app.parse_user_data("#cloud-config\npackages: [htop]\n"))
        self.assertIsNone(app.parse_user_data("#cloud-config\n: [broken\n"))

    def test_merge_drops_fixed_keys(self):
        self.assertEqual(app.merge({"A": "1", "B": "2"}, {"B": "3", "DATA_DIR": "/x"}), {"A": "1", "B": "3"})


class ValidateTest(unittest.TestCase):

    def test_defaults_are_valid(self):
        self.assertEqual(app.validate({}), [])

    def test_static_network(self):
        s = {"NET_MODE": "static", "NET_ADDRESS": "192.168.1.20/24", "NET_GATEWAY": "192.168.1.1",
             "NET_DNS": "192.168.1.1, 1.1.1.1"}
        self.assertEqual(app.validate(s), [])
        for bad in ({"NET_ADDRESS": "192.168.1.20"}, {"NET_ADDRESS": "nonsense"},
                    {"NET_GATEWAY": "10.0.0.1"}, {"NET_DNS": "dns.example"}):
            with self.subTest(bad=bad):
                self.assertTrue(app.validate({**s, **bad}))

    def test_values(self):
        for bad in ({"SERVER_IP": "host.example"}, {"HTTP_PORT": "69"}, {"HTTP_PORT": "x"},
                    {"HOSTNAME": "bad_name"}, {"EVE_LANGUAGE": "xx"}, {"EVE_ARCHES": "riscv"},
                    {"EVE_FLAVOURS": "xen"}, {"SMB_IMPORT_SHARE": "maybe"},
                    {"EVE_DEFAULT_SERIAL": "ttyUSB0"}, {"EVE_DEFAULT_EXTRA_ARGS": "it's"}):
            with self.subTest(bad=bad):
                self.assertTrue(app.validate(bad))
        # empty means "use the default"
        self.assertEqual(app.validate({"EVE_ARCHES": ""}), [])
        self.assertEqual(app.validate({"EVE_ARCHES": "amd64 arm64", "EVE_FLAVOURS": "kvm k"}), [])


class VersionTest(unittest.TestCase):

    def test_version_tuple(self):
        self.assertEqual(app.version_tuple("ghcr.io/a/b:1.2.3"), (1, 2, 3))
        self.assertEqual(app.version_tuple("v10.0.1"), (10, 0, 1))
        self.assertIsNone(app.version_tuple("ghcr.io/a/b:latest"))
        self.assertIsNone(app.version_tuple("ghcr.io/a/b:dev-abc1234"))
        self.assertLess(app.version_tuple("v1.9.0"), app.version_tuple("v1.10.0"))


class RenderTest(unittest.TestCase):

    def test_settings_never_store_secrets(self):
        text = app.render_settings({"ADMIN_PASSWORD": "pw", "SMB_PASSWORD": "pw2", "HOSTNAME": "x"})
        self.assertNotIn("pw", text)
        self.assertIn("HOSTNAME=x", text)

    def test_export_has_no_secrets_and_round_trips(self):
        s = {"EVE_GITHUB_TOKEN": "ghp_secret123", "ADMIN_PASSWORD": "pw-secret", "EVE_LANGUAGE": "nl",
             "ADMIN_SSH_KEYS": "ssh-ed25519 AAAA x"}
        text = app.render_export(s)
        self.assertNotIn("ghp_secret123", text)
        self.assertNotIn("pw-secret", text)
        self.assertEqual(app.parse_user_data(text), {"EVE_LANGUAGE": "nl", "ADMIN_SSH_KEYS": "ssh-ed25519 AAAA x"})

    def test_stack_env(self):
        s = {"EVE_LANGUAGE": "nl", "HOSTNAME": "vm", "NET_MODE": "static", "DATA_DIR": "/elsewhere",
             "EVE_DEFAULT_INSTALL_SERVER": "zedcloud.zededa.net", "EMPTY": ""}
        env = app.parse_env(app.render_stack_env(s, "192.0.2.5", "img:1"))
        self.assertEqual(env["SERVER_IP"], "192.0.2.5")
        self.assertEqual(env["DATA_DIR"], app.DATA)
        self.assertEqual(env["IMPORT_DIR"], app.IMPORT)
        self.assertEqual(env["EVE_IMAGE"], "img:1")
        self.assertEqual(env["EVE_LANGUAGE"], "nl")
        self.assertEqual(env["HTTP_PORT"], "8080")
        self.assertEqual(env["EVE_DEFAULT_INSTALL_SERVER"], "zedcloud.zededa.net")
        for vm_only in ("HOSTNAME", "NET_MODE", "EMPTY"):
            self.assertNotIn(vm_only, env)

    def test_networkd(self):
        static, dhcp = app.render_networkd({})
        self.assertIsNone(static)
        self.assertIn("DHCP=yes", dhcp)
        self.assertIn("ClientIdentifier=mac", dhcp)
        static, _ = app.render_networkd({"NET_MODE": "static", "NET_INTERFACE": "enp0s1",
                                         "NET_ADDRESS": "192.168.1.20/24", "NET_GATEWAY": "192.168.1.1",
                                         "NET_DNS": "1.1.1.1,9.9.9.9"})
        self.assertIn("Name=enp0s1", static)
        self.assertIn("Address=192.168.1.20/24", static)
        self.assertIn("Gateway=192.168.1.1", static)
        self.assertIn("DNS=1.1.1.1\nDNS=9.9.9.9", static)

    def test_shipped_networkd_file_matches(self):
        path = os.path.join(HERE, "..", "vm", "rootfs", "etc", "systemd", "network", "20-eve-netboot.network")
        with open(path) as f:
            self.assertEqual(f.read(), app.render_networkd({})[1])


if __name__ == "__main__":
    unittest.main()

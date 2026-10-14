#!/usr/bin/env python3
"""Answer the open API questions of zededa-onboarding.md with real calls.

Logs in (the password is asked here and never printed or stored), looks up the
project, creates ONE test edge node without a model, reads it back by serial,
deletes it again and logs out. Only results are printed, never the token.

    python3 zededa_api_probe.py --cluster zedcontrol.zededa.net \
        --enterprise <enterprise> --user <user> --project <project>
"""
import argparse
import datetime
import getpass
import json
import os
import secrets
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_ONBOARDING_KEY = "5d0767ee-0547-4569-b530-387e526f8cb9"


def tls_context():
    """Verifying TLS context. The python.org Python on macOS has no CA store of
    its own: then use the certificates macOS trusts (system keychains, which
    also hold a company TLS proxy's CA)."""
    ctx = ssl.create_default_context()
    if sys.platform == "darwin" and not ctx.get_ca_certs():
        pem = subprocess.run(
            ["security", "find-certificate", "-a", "-p",
             "/System/Library/Keychains/SystemRootCertificates.keychain",
             "/Library/Keychains/System.keychain"],
            capture_output=True, text=True, check=False).stdout
        with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as f:
            f.write(pem)
        try:
            ctx.load_verify_locations(cafile=f.name)
        finally:
            os.unlink(f.name)
    return ctx


class Api:
    def __init__(self, cluster):
        self.base = f"https://{cluster}/api"
        self.token = None
        self.ctx = tls_context()

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", "Bearer " + self.token)
        try:
            with urllib.request.urlopen(req, timeout=30, context=self.ctx) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"raw": raw.decode(errors="replace")[:500]}


def show(title, status, body, keys=None):
    print(f"\n== {title}: HTTP {status}")
    if keys and isinstance(body, dict):
        body = {k: body.get(k) for k in keys if k in body}
    text = json.dumps(body, indent=1, default=str)
    print(text[:3000] + ("\n..." if len(text) > 3000 else ""))


def expires_in(token):
    exp = token.get("expires")
    try:
        t = datetime.datetime.fromisoformat(str(exp).replace("Z", "+00:00"))
        return f"{exp} (in {t - datetime.datetime.now(datetime.timezone.utc)})"
    except ValueError:
        return str(exp)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cluster", default="zedcontrol.zededa.net")
    p.add_argument("--enterprise", required=True)
    p.add_argument("--user", required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--onboarding-key", default=DEFAULT_ONBOARDING_KEY)
    a = p.parse_args()

    api = Api(a.cluster)
    pw = getpass.getpass(f"ZEDEDA password for {a.user} (not shown, not stored): ")
    status, body = api.call("POST", "/v1/login", {
        "usernameAtRealm": a.user, "username": a.user, "password": pw, "enterpriseName": a.enterprise})
    del pw
    token = body.get("token") if isinstance(body, dict) else None
    if status != 200 or not token or not token.get("base64"):
        show("login failed", status, body, ["cause", "error", "detail", "noOfLoginAttemptsLeft", "raw"])
        return 1
    api.token = token["base64"]
    print(f"\n== login: OK, role {body.get('role')}, token expires {expires_in(token)}")

    try:
        status, body = api.call("PUT", "/v1/sessions/refresh")
        print(f"== session refresh: HTTP {status}, answer fields: {sorted(body) if isinstance(body, dict) else body}")
        if isinstance(body, dict):
            for k in ("expires", "token", "tokenExpires", "sessionExpires"):
                if k in body and k != "token":
                    print(f"   {k}: {body[k]}")
            if isinstance(body.get("token"), dict):
                print(f"   token.expires: {body['token'].get('expires')}")

        status, proj = api.call("GET", "/v1/projects/name/" + urllib.parse.quote(a.project, safe=""))
        show("project", status, proj, ["id", "name", "type", "appPolicy", "deployment", "numdevices"])
        if status != 200:
            return 1

        tag = secrets.token_hex(4)
        serial = f"eni-probe-{tag}"
        name = f"eni-probe-{tag}"
        create = {"name": name, "title": "EVE Netboot Installer API probe (delete me)",
                  "projectId": proj["id"], "serialno": serial, "obkey": a.onboarding_key,
                  "adminState": "ADMIN_STATE_INACTIVE"}
        # the ZEDEDA UI posts a node without model to this (unpublished) endpoint
        status, body = api.call("POST", "/v1/devices/model-less", create)
        show("create without model (devices/model-less)", status, body)
        if status != 200:
            print("\n(not created; nothing to delete)")
            return 0

        status, dev = api.call("GET", "/v1/devices/serial/" + urllib.parse.quote(serial, safe=""))
        show("lookup by serial", status, dev,
             ["id", "name", "serialno", "obkey", "modelId", "utype", "adminState", "projectId", "onboarding"])
        dev_id = dev.get("id") if isinstance(dev, dict) else None
        if not dev_id:
            status, dev = api.call("GET", "/v1/devices/name/" + name)
            dev_id = dev.get("id") if isinstance(dev, dict) else None
        status, body = api.call("DELETE", f"/v1/devices/id/{dev_id}")
        show("delete", status, body, ["objectName", "operationStatus", "error"])
        status, _ = api.call("GET", "/v1/devices/serial/" + urllib.parse.quote(serial, safe=""))
        print(f"== lookup after delete: HTTP {status} (404 = gone)")
    finally:
        status, _ = api.call("POST", "/v1/logout")
        print(f"\n== logout: HTTP {status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

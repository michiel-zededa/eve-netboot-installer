"""
zededa -- the few ZEDEDA API calls the appliance uses to onboard nodes
=====================================================================

Standard library only. The session token is held by the caller, in memory;
this module never writes anything to disk. The calls and how the API answers
them: docs/design/zededa-onboarding.md.

- POST /api/v1/login                 -> token {base64, expires (ns since 1970)}
- POST /api/v1/logout
- GET  /api/v1/sessions/self         (check a pasted token)
- GET  /api/v1/projects/name/{name}
- GET  /api/v1/devices/serial/{serial}
- POST /api/v1/devices/model-less    (a node without a model; EVE-OS 17+
                                      reports its hardware itself. Not in the
                                      published definitions: the ZEDEDA UI uses it)
- DELETE /api/v1/devices/id/{id}     (delete a node this appliance created)
- GET  /api/v1/devices/id/{id}/status (runState: did the machine come online?)
"""

import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_CLUSTER = "zedcontrol.zededa.net"
DEFAULT_ONBOARDING_KEY = "5d0767ee-0547-4569-b530-387e526f8cb9"
HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$")
TIMEOUT = 20


class ZededaError(Exception):
    """A failed call: status (0 = no answer) and the controller's own message."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def error_text(body):
    """The controller's explanation of a failed call, as one line."""
    if not isinstance(body, dict):
        return str(body)[:300]
    parts = []
    for e in body.get("error") or []:
        if isinstance(e, dict) and e.get("details"):
            parts.append(str(e["details"]))
    for k in ("cause", "httpStatusMsg", "message", "raw"):
        if body.get(k) and not parts:
            parts.append(str(body[k]))
    return "; ".join(parts)[:300] or "no details"


def expires_seconds(token):
    """token.expires (nanoseconds since 1970, or an ISO time) -> seconds since 1970, or None."""
    exp = token.get("expires") if isinstance(token, dict) else None
    try:
        n = int(exp)
        return n / 1e9 if n > 1e12 else float(n) or None
    except (TypeError, ValueError):
        pass
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(exp).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


class Client:
    def __init__(self, cluster, token=None, opener=None):
        if not HOST_RE.match(cluster or ""):
            raise ZededaError(0, f"invalid cluster address: {cluster!r}")
        self.base = f"https://{cluster}/api"
        self.token = token
        # opener(request, timeout) -> (status, bytes); replaced in the tests
        self.opener = opener or self._urlopen

    @staticmethod
    def _urlopen(req, timeout):
        ctx = ssl.create_default_context()
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def call(self, method, path, body=None, ok=(200,)):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", "Bearer " + self.token)
        try:
            status, raw = self.opener(req, TIMEOUT)
        except (urllib.error.URLError, OSError, ssl.SSLError) as e:
            raise ZededaError(0, f"no answer from {self.base}: {getattr(e, 'reason', e)}") from None
        try:
            answer = json.loads(raw) if raw else {}
        except ValueError:
            answer = {"raw": raw.decode(errors="replace")[:300]}
        if status not in ok:
            raise ZededaError(status, error_text(answer))
        return status, answer

    # ---- session
    def login(self, user, password, enterprise):
        """-> {"token": str, "expires": seconds or None, "role": str}"""
        _, a = self.call("POST", "/v1/login", {"usernameAtRealm": user, "username": user,
                                                "password": password, "enterpriseName": enterprise})
        token = a.get("token") or {}
        if not token.get("base64"):
            raise ZededaError(200, error_text(a))
        role = a.get("role") or {}
        return {"token": token["base64"], "expires": expires_seconds(token),
                "role": role.get("name", "") if isinstance(role, dict) else str(role)}

    def check(self):
        """Check a pasted API or session token: -> {"user": str, "expires": seconds or None}.
        Only "not authenticated" (401) rejects it; an endpoint the token may not
        use for this check is no reason to refuse it."""
        try:
            _, a = self.call("GET", "/v1/sessions/self")
        except ZededaError as e:
            if e.status in (0, 401):
                raise
            return {"user": "", "expires": None}
        token = a.get("token") if isinstance(a.get("token"), dict) else a
        user = a.get("username") or a.get("userName") or a.get("user") or a.get("userId") or ""
        return {"user": str(user), "expires": expires_seconds(token)}

    def logout(self):
        try:
            self.call("POST", "/v1/logout")
        except ZededaError:
            pass

    # ---- objects
    def project(self, name):
        _, a = self.call("GET", "/v1/projects/name/" + urllib.parse.quote(name, safe=""))
        return a

    def device_by_serial(self, serial):
        """The node with this serial number, or None."""
        try:
            _, a = self.call("GET", "/v1/devices/serial/" + urllib.parse.quote(serial, safe=""))
        except ZededaError as e:
            if e.status == 404:
                return None
            raise
        return a or None

    def create_modelless(self, name, title, project_id, serial, onboarding_key):
        """Create a node without a model; -> its id."""
        _, a = self.call("POST", "/v1/devices/model-less", {
            "name": name, "title": title, "projectId": project_id, "serialno": serial,
            "obkey": onboarding_key})
        return a.get("objectId", "")

    def device_status(self, node_id):
        """-> {"run_state", "state", "last_seen", "eve", "error"}; state is one of
        waiting (the machine has not registered yet), starting, online (onboarded
        completely), offline, error."""
        _, a = self.call("GET", "/v1/devices/id/" + urllib.parse.quote(node_id, safe="") + "/status")
        run = str(a.get("runState") or "RUN_STATE_UNSPECIFIED")
        eve = ""
        for sw in a.get("swInfo") or []:
            if isinstance(sw, dict) and (sw.get("activated") or not eve):
                eve = str(sw.get("shortVersion") or sw.get("longVersion") or eve)
        errors = [e.get("description", "") for e in a.get("devError") or [] if isinstance(e, dict)]
        return {"run_state": run, "state": run_category(run), "last_seen": str(a.get("lastUpdate") or ""),
                "eve": eve, "error": "; ".join(x for x in errors if x)[:300]}

    def delete_device(self, node_id):
        self.call("DELETE", "/v1/devices/id/" + urllib.parse.quote(node_id, safe=""))


STARTING = {"PROVISIONED", "INIT", "BOOTING", "REBOOTING", "RESTARTING", "DOWNLOADING", "VERIFYING", "LOADING",
            "BASEOS_UPDATING", "CREATING_VOLUME", "START_DELAYED"}
OFFLINE = {"OFFLINE", "HALTED", "HALTING", "SUSPECT", "UNKNOWN", "PURGING", "MAINTENANCE_MODE",
           "PREPARING_POWEROFF", "POWERING_OFF", "PREPARED_POWEROFF"}


def run_category(run_state):
    """ZEDEDA's runState -> waiting / starting / online / offline / error."""
    s = run_state.replace("RUN_STATE_", "")
    if s == "ONLINE":
        return "online"
    if s == "ERROR":
        return "error"
    if s in STARTING:
        return "starting"
    if s in OFFLINE:
        return "offline"
    return "waiting"                      # UNPROVISIONED, UNSPECIFIED: not registered yet


NUMBER_RE = re.compile(r"\{n(?::(\d))?\}")


def uses_number(template):
    return bool(NUMBER_RE.search(template or ""))


def node_name(template, mac, serial="", number=None):
    """Node name from the naming convention: {mac} (aa-bb-cc-dd-ee-ff), {serial}
    (the hardware serial, the MAC address when the machine has none) and {n} /
    {n:3} (a sequence number, with leading zeros to that width). Lower case
    letters, digits and hyphens only, at most 63 characters."""
    serial = serial if usable_serial(serial) else mac
    name = template.replace("{mac}", mac).replace("{serial}", serial)
    name = NUMBER_RE.sub(lambda m: str(number if number is not None else 0).zfill(int(m.group(1) or 0)), name)
    return clean_name(name)


def clean_name(name):
    """A name as ZEDEDA takes it: lower case letters, digits and hyphens, at most 63."""
    name = re.sub(r"[^a-z0-9-]+", "-", str(name).lower()).strip("-")
    return re.sub(r"-{2,}", "-", name)[:63].strip("-")


def usable_serial(serial):
    """False for the placeholders whitebox boards carry instead of a serial."""
    s = (serial or "").strip().lower()
    junk = ("", "none", "0", "default string", "to be filled by o.e.m.", "to be filled by oem",
            "system serial number", "not specified", "not applicable", "n/a", "123456789", "0123456789")
    return s not in junk and not re.fullmatch(r"[0x\s.-]*", s)


def now():
    return time.time()

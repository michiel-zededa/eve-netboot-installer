"""
eve-netboot web -- HTTPS management UI of the EVE Netboot Installer appliance
============================================================================

Serves the same web UI as the PXE server's port 8080 (from /srv/eve-netboot/www)
plus a JSON API under /api/ that does what the console menu does: setup,
settings, sync, logs, export/import, updates, password, reboot/power off, and
for headless VMs also ISO upload/delete, diagnostics and network changes with
automatic rollback.

Security
- HTTPS only (self-signed certificate made on first start, /etc/eve-netboot/tls).
- Login with the admin password (checked like the console does, libcrypt).
  Sessions in memory: cookie HttpOnly + Secure + SameSite=Strict.
- Every request that changes something must carry the header "X-ENI: 1";
  a browser cannot send it cross-site without a CORS preflight, which this
  server never allows.
- 5 wrong passwords from one address: 60 s lockout.
- Before the appliance is set up, /api/setup is open (first come, first
  served: the owner's decision for headless VMs). Afterwards it is closed.
- Not running at all when WEB_ADMIN=no.

`core` is the eve-netboot module (/usr/local/sbin/eve-netboot); everything
that changes the system goes through its functions, exactly like the console.
"""

import datetime
import html
import http.server
import io
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import tarfile
import threading
import time
import traceback
import urllib.parse

TLS_DIR = "/etc/eve-netboot/tls"
SESSION_IDLE = 2 * 3600
SESSION_MAX = 12 * 3600
LOCKOUT_AFTER, LOCKOUT_SECONDS = 5, 60
ROLLBACK_SECONDS = 120
MAX_JSON = 1 << 20
SECRET_KEYS = ("ADMIN_PASSWORD", "SMB_PASSWORD", "ENI_GITHUB_TOKEN")
NETWORK_KEYS = ("NET_MODE", "NET_INTERFACE", "NET_ADDRESS", "NET_GATEWAY", "NET_DNS", "WEB_ADMIN_PORT")
UPLOAD_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.iso$")


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Job:
    def __init__(self, kind):
        self.id = secrets.token_hex(8)
        self.kind = kind
        self.state = "running"
        self.messages = []
        self.result = None
        self.started = time.time()

    def say(self, text):
        self.messages.append(text)

    def as_dict(self):
        return {"id": self.id, "kind": self.kind, "state": self.state, "messages": self.messages,
                "result": self.result}


class App:
    """State shared by all requests."""

    def __init__(self, core):
        self.core = core
        self.lock = threading.Lock()
        self.sessions = {}      # token -> {"created": t, "seen": t}
        self.failures = {}      # ip -> (count, locked_until)
        self.jobs = {}
        self.job = None         # the running job (one at a time)
        self.rollback = None    # {"token", "deadline", "previous", "timer"}

    # ---- sessions
    def new_session(self):
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self.lock:
            self.sessions[token] = {"created": now, "seen": now}
        return token

    def valid_session(self, token):
        if not token:
            return False
        now = time.time()
        with self.lock:
            s = self.sessions.get(token)
            if not s or now - s["seen"] > SESSION_IDLE or now - s["created"] > SESSION_MAX:
                self.sessions.pop(token, None)
                return False
            s["seen"] = now
            return True

    def drop_session(self, token):
        with self.lock:
            self.sessions.pop(token, None)

    # ---- login rate limit
    def check_lockout(self, ip):
        count, until = self.failures.get(ip, (0, 0))
        if until > time.time():
            raise HttpError(429, self.core.tr("adm_api_locked", seconds=int(until - time.time()) + 1))

    def login_failed(self, ip):
        count, _ = self.failures.get(ip, (0, 0))
        count += 1
        self.failures[ip] = (0, time.time() + LOCKOUT_SECONDS) if count >= LOCKOUT_AFTER else (count, 0)

    # ---- jobs
    def start_job(self, kind, fn):
        with self.lock:
            if self.job and self.job.state == "running":
                raise HttpError(409, self.core.tr("adm_api_busy", task=self.job.kind))
            job = Job(kind)
            self.job = job
            self.jobs[job.id] = job
        language = self.core.thread_language()   # the job answers in the language of its request

        def run():
            self.core.use_language(language)
            try:
                job.result = fn(job)
                job.state = "done"
            except Exception as e:  # noqa: BLE001
                self.core.log(f"web: {kind} failed: {e}")
                job.say(str(e))
                job.state = "failed"

        threading.Thread(target=run, daemon=True).start()
        return job

    # ---- network change with rollback
    def arm_rollback(self, previous):
        token = secrets.token_urlsafe(16)
        timer = threading.Timer(ROLLBACK_SECONDS, self.do_rollback, args=(token,))
        timer.daemon = True
        with self.lock:
            if self.rollback:
                self.rollback["timer"].cancel()
            self.rollback = {"token": token, "deadline": time.time() + ROLLBACK_SECONDS,
                             "previous": previous, "timer": timer}
        timer.start()
        return token

    def confirm_rollback(self, token):
        with self.lock:
            rb = self.rollback
            if not rb or not secrets.compare_digest(rb["token"], token or ""):
                return False
            rb["timer"].cancel()
            self.rollback = None
        self.core.log("web: network change confirmed")
        return True

    def do_rollback(self, token):
        with self.lock:
            rb = self.rollback
            if not rb or rb["token"] != token:
                return
            self.rollback = None
        self.core.log("web: network change not confirmed in time - restoring the previous settings")
        try:
            self.core.apply(rb["previous"])
        except Exception as e:  # noqa: BLE001
            self.core.log(f"web: rollback failed: {e}")


# --------------------------------------------------------------------------
# request handling
# --------------------------------------------------------------------------
class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "eve-netboot-web"
    app: App = None  # set in serve()

    def log_message(self, fmt, *args):  # quiet: no request log in the journal
        pass

    # ---- plumbing
    @property
    def core(self):
        return self.app.core

    def client_ip(self):
        return self.client_address[0]

    def cookie(self, name):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return None

    def authenticated(self):
        return self.app.valid_session(self.cookie("eni_session"))

    def send(self, status, body=b"", ctype="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Strict-Transport-Security", "max-age=31536000")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def read_body(self, size):
        """Read up to size bytes of the request body; keeps track of what is left."""
        data = self.rfile.read(min(size, self.body_left))
        self.body_left -= len(data)
        return data

    def drain_body(self):
        """Read whatever the client sent and nobody read. A connection closed
        with unread data gets a TCP reset, which makes the browser drop the
        response just sent ("Failed to fetch") instead of showing it."""
        try:
            while self.body_left > 0 and self.read_body(1 << 20):
                pass
        except OSError:
            pass

    def json_body(self):
        if self.body_left > MAX_JSON:
            raise HttpError(413, "Request too large.")
        try:
            data = json.loads(self.read_body(self.body_left) or b"{}")
        except ValueError:
            raise HttpError(400, "Invalid JSON.") from None
        if not isinstance(data, dict):
            raise HttpError(400, "Invalid request.")
        return data

    def route(self):
        url = urllib.parse.urlsplit(self.path)
        return url.path, urllib.parse.parse_qs(url.query)

    def handle_safely(self, fn):
        self.core.use_language(self.headers.get("X-ENI-Lang"))
        try:
            self.body_left = max(0, int(self.headers.get("Content-Length") or 0))
        except ValueError:
            self.body_left = 0
        try:
            fn()
        except HttpError as e:
            self.send(e.status, {"error": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            self.core.log(f"web: {self.command} {self.path}: {e}")
            traceback.print_exc()
            self.send(500, {"error": f"Internal error: {e}"})
        finally:
            self.drain_body()

    # ---- HTTP methods
    def do_GET(self):
        self.handle_safely(self.get)

    def do_HEAD(self):
        self.handle_safely(self.get)

    def do_POST(self):
        self.handle_safely(lambda: self.change("POST"))

    def do_DELETE(self):
        self.handle_safely(lambda: self.change("DELETE"))

    # ---- GET
    def get(self):
        path, query = self.route()
        if not path.startswith("/api/"):
            return self.static(path)
        if path == "/api/session":
            return self.send(200, self.session_info())
        if path == "/api/texts":
            return self.send(200, self.texts(query.get("lang", [""])[0]))
        if path.startswith("/api/jobs/"):
            self.require_auth_or_setup()
            job = self.app.jobs.get(path.rsplit("/", 1)[-1])
            if not job:
                raise HttpError(404, "Unknown task.")
            return self.send(200, job.as_dict())
        if path == "/api/settings":
            # also before the setup: the web setup needs the choices and network adapters
            self.require_auth_or_setup()
            return self.send(200, self.settings_info())
        self.require_auth()
        if path == "/api/logs":
            return self.send(200, self.logs(query.get("source", ["sync"])[0],
                                            int(query.get("lines", ["300"])[0] or 300)), "text/plain; charset=utf-8")
        if path == "/api/export":
            return self.send(200, self.core.render_export(self.core.load_settings()), "text/plain; charset=utf-8",
                             {"Content-Disposition": 'attachment; filename="eve-netboot-settings.txt"'})
        if path == "/api/diagnostics":
            name = f"eve-netboot-diagnostics-{datetime.datetime.now():%Y%m%d-%H%M}.tar.gz"
            return self.send(200, self.diagnostics(), "application/gzip",
                             {"Content-Disposition": f'attachment; filename="{name}"'})
        raise HttpError(404, "Unknown API.")

    def static(self, path):
        """The web UI and the status files from the PXE server's web root. The
        UI itself comes from there too (kept current by the sync, also after an
        app update); before the stack ever ran, from the copy made at build time."""
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        full = None
        for base in (self.core.WWW, os.path.join(self.core.LIB, "ui")):
            root = os.path.realpath(base)
            candidate = os.path.realpath(os.path.join(root, rel))
            if not (candidate == root or candidate.startswith(root + os.sep)):
                raise HttpError(404, "Not found.")
            if os.path.isdir(candidate):
                if not os.path.isfile(os.path.join(candidate, "index.html")) and base == self.core.WWW:
                    return self.listing(path, candidate)
                candidate = os.path.join(candidate, "index.html")
            if os.path.isfile(candidate):
                full = candidate
                break
        if full is None:
            raise HttpError(404, "Not found.")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "image/svg+xml"):
            ctype += "; charset=utf-8"
        size = os.path.getsize(full)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store" if not rel.startswith("ui/assets/") else "max-age=31536000")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        if self.command != "HEAD":
            with open(full, "rb") as f:
                shutil.copyfileobj(f, self.wfile, 1 << 20)

    def listing(self, path, folder):
        """A folder of the web root as a page of links, like nginx autoindex on
        the PXE server's port: "Open the files" and "All files" point here."""
        if not path.endswith("/"):
            return self.send(301, b"", "text/plain", {"Location": urllib.parse.quote(path) + "/"})
        rows = []
        for name in sorted(os.listdir(folder), key=str.lower):
            full = os.path.join(folder, name)
            if name.startswith(".") or not (os.path.isdir(full) or os.path.isfile(full)):
                continue
            st = os.stat(full)
            is_dir = os.path.isdir(full)
            link = urllib.parse.quote(name) + ("/" if is_dir else "")
            size = "-" if is_dir else f"{st.st_size:,}"
            when = datetime.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
            rows.append(f'<tr><td><a href="{html.escape(link)}">{html.escape(name)}{"/" if is_dir else ""}</a></td>'
                        f"<td>{when}</td><td class=n>{size}</td></tr>")
        title = html.escape(urllib.parse.unquote(path))
        page = (f"<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                f"<title>{title}</title><style>body{{font:14px system-ui,sans-serif;margin:24px;color:#222}}"
                "table{border-collapse:collapse}td{padding:3px 18px 3px 0}td.n{text-align:right}"
                "a{color:#5b3fd1;text-decoration:none}a:hover{text-decoration:underline}"
                "@media(prefers-color-scheme:dark){body{background:#16161d;color:#ddd}a{color:#a99bff}}</style>"
                f"</head><body><h1>{title}</h1><table><tr><td><a href=\"../\">../</a></td><td></td><td></td></tr>"
                + "".join(rows) + "</table></body></html>")
        self.send(200, page, "text/html; charset=utf-8")

    # ---- POST / DELETE
    def change(self, method):
        if self.headers.get("X-ENI") != "1":
            raise HttpError(403, "Missing X-ENI header.")
        path, query = self.route()
        if method == "POST" and path == "/api/login":
            return self.login()
        if method == "POST" and path == "/api/logout":
            self.app.drop_session(self.cookie("eni_session"))
            return self.send(200, {"ok": True}, headers={"Set-Cookie": self.cookie_header("", 0)})
        if method == "POST" and path == "/api/setup":
            return self.api_setup()
        if method == "POST" and path == "/api/network/confirm":
            ok = self.app.confirm_rollback(self.json_body().get("token"))
            if not ok:
                raise HttpError(400, self.core.tr("adm_api_nothing_to_confirm"))
            return self.send(200, {"ok": True})
        if method == "POST" and path == "/api/import":
            self.require_auth_or_setup()     # the web setup can start from an export
            return self.import_settings()
        self.require_auth()
        if method == "POST" and path == "/api/settings":
            return self.save_settings()
        if method == "POST" and path == "/api/password":
            return self.change_password()
        if method == "POST" and path.startswith("/api/actions/"):
            return self.action(path.rsplit("/", 1)[-1])
        if method == "POST" and path == "/api/upload":
            return self.upload(query.get("name", [""])[0], query.get("overwrite", ["0"])[0] == "1")
        if method == "DELETE" and path == "/api/images":
            return self.delete_image(query.get("file", [""])[0])
        raise HttpError(404, "Unknown API.")

    def require_auth(self):
        if not self.authenticated():
            raise HttpError(401, self.core.tr("adm_api_login"))

    def require_auth_or_setup(self):
        if not self.authenticated() and self.core.is_configured():
            raise HttpError(401, self.core.tr("adm_api_login"))

    def cookie_header(self, value, max_age):
        return f"eni_session={value}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Strict"

    # ---- the individual API calls
    def session_info(self):
        c = self.core
        s = c.load_settings()
        info = {
            "appliance": True,
            "version": c.version(),
            "hostname": c.read("/etc/hostname").strip(),
            "configured": c.is_configured(),
            "authenticated": self.authenticated(),
            "web_admin": c.get(s, "WEB_ADMIN") == "yes",
            "language": c.get(s, "ENI_LANGUAGE"),
            "job": self.app.job.as_dict() if self.app.job and self.app.job.state == "running" else None,
        }
        rb = self.app.rollback
        if rb and info["authenticated"]:
            info["rollback"] = {"seconds_left": max(0, int(rb["deadline"] - time.time()))}
        return info

    def texts(self, lang):
        """Texts of the web UI in a language (default: the saved one). Also before
        the setup: the web setup shows its questions in the chosen language."""
        c = self.core
        if lang not in dict(c.LANGUAGES):
            lang = c.get(c.load_settings(), "ENI_LANGUAGE")
        out = dict(c.texts(lang))
        # the stack's own copy is the newest (an app update brings new texts)
        try:
            ui = json.loads(c.read(os.path.join(c.WWW, "eve", "ui.json")) or "{}")
            if ui.get("language") == lang:
                out.update(ui.get("texts") or {})
        except ValueError:
            pass
        return {"language": lang, "texts": out}

    def login(self):
        ip = self.client_ip()
        self.app.check_lockout(ip)
        password = str(self.json_body().get("password") or "")
        if not self.core.check_password(self.core.ADMIN, password):
            self.app.login_failed(ip)
            time.sleep(1)
            self.core.log(f"web: wrong admin password from {ip}")
            raise HttpError(401, self.core.tr("adm_wrong_password"))
        self.app.failures.pop(ip, None)
        token = self.app.new_session()
        self.core.log(f"web: admin logged in from {ip}")
        self.send(200, {"ok": True}, headers={"Set-Cookie": self.cookie_header(token, SESSION_MAX)})

    def settings_info(self):
        c = self.core
        s = c.load_settings()
        public = {k: v for k, v in s.items() if k not in SECRET_KEYS and k != "GITHUB_TOKEN"}
        return {
            "settings": public,
            "defaults": c.DEFAULTS,
            "secrets": {
                "admin_password": c.admin_has_password(),
                "smb_password": c.smb_has_password(),
                "github_token": bool(s.get("ENI_GITHUB_TOKEN")),
            },
            "network": {
                "interfaces": [{"name": n, "address": a} for n, a in c.ipv4_addresses()],
                "primary_ip": c.primary_ip(),
                "primary_interface": c.primary_interface(),
            },
            "choices": {"languages": c.LANGUAGES, "serials": c.SERIALS},
            # what the DHCP service uses for its empty settings (the VM's own network)
            "dhcp": c.dhcp_defaults(s),
            "image": c.current_image(s),
        }

    def new_settings(self, body, base):
        """Merge a request's settings/secrets into base. None or "" removes a key."""
        changes = body.get("settings") or {}
        secrets_ = body.get("secrets") or {}
        if not isinstance(changes, dict) or not isinstance(secrets_, dict):
            raise HttpError(400, "Invalid settings.")
        s = dict(base)
        for k, v in changes.items():
            k = str(k)
            if not self.core.KEY_RE.match(k) or k in SECRET_KEYS or k in self.core.FIXED:
                continue
            if v is None or v == "":
                s.pop(k, None)
            else:
                s[k] = ("yes" if v else "no") if isinstance(v, bool) else str(v).strip()
        for k in SECRET_KEYS:
            v = secrets_.get(k)
            if v is None:
                continue
            if k == "ENI_GITHUB_TOKEN" and v == "":
                s.pop(k, None)
            elif v != "":
                s[k] = str(v)
        for k in ("ADMIN_PASSWORD", "SMB_PASSWORD"):
            if k in s and len(s[k]) < 8:
                raise HttpError(400, self.core.tr("adm_pw_too_short", n=8))
        errors = self.core.validate(s)
        if errors:
            raise HttpError(400, "; ".join(errors))
        return s

    def api_setup(self):
        c = self.core
        if c.is_configured():
            raise HttpError(409, self.core.tr("adm_api_already_set_up"))
        body = self.json_body()
        s = self.new_settings(body, c.load_settings())
        if not s.get("ADMIN_PASSWORD"):
            raise HttpError(400, self.core.tr("adm_api_choose_password"))
        s["WEB_ADMIN"] = "yes"          # set up in the browser: keep the browser
        c.log(f"web: setup from {self.client_ip()}")
        job = self.app.start_job("setup", lambda j: (j.say(c.tr("adm_applying")), c.apply(s), "ok")[-1])
        token = self.app.new_session()
        self.send(200, {"job": job.id}, headers={"Set-Cookie": self.cookie_header(token, SESSION_MAX)})

    def save_settings(self):
        c = self.core
        previous = c.load_settings()
        s = self.new_settings(self.json_body(), previous)
        network = any(c.get(s, k) != c.get(previous, k) for k in NETWORK_KEYS)
        result = {}
        if network:
            token = self.app.arm_rollback(previous)
            port = c.get(s, "WEB_ADMIN_PORT")
            new_ip = c.get(s, "NET_ADDRESS").split("/")[0] if c.get(s, "NET_MODE") == "static" else None
            result["rollback"] = {
                "seconds": ROLLBACK_SECONDS,
                "confirm_url": f"https://{new_ip}:{port}/#/confirm/{token}" if new_ip else None,
                "token": token,
            }
        changed = sorted(k for k in set(s) | set(previous)
                         if s.get(k) != previous.get(k) and k not in SECRET_KEYS)
        c.log(f"web: settings changed from {self.client_ip()}: {', '.join(changed) or '-'}")
        job = self.app.start_job("settings", lambda j: (j.say(c.tr("adm_applying")), c.apply(s), "ok")[-1])
        result["job"] = job.id
        self.send(200, result)

    def import_settings(self):
        body = self.json_body()
        try:
            found = self.core.fetch_import(str(body.get("url") or "")) if body.get("url") else \
                self.core.parse_env(str(body.get("text") or ""))
        except Exception as e:  # noqa: BLE001
            raise HttpError(400, self.core.tr("adm_imp_failed", error=e)) from None
        if not found:
            raise HttpError(400, self.core.tr("adm_imp_none"))
        merged = self.core.merge(self.core.load_settings(), found)
        self.send(200, {"settings": {k: v for k, v in merged.items() if k not in SECRET_KEYS}})

    def change_password(self):
        body = self.json_body()
        if not self.core.check_password(self.core.ADMIN, str(body.get("current") or "")):
            time.sleep(1)
            raise HttpError(400, self.core.tr("adm_api_current_password"))
        new = str(body.get("new") or "")
        if len(new) < 8:
            raise HttpError(400, self.core.tr("adm_pw_too_short", n=8))
        self.core.run(["chpasswd"], input=f"{self.core.ADMIN}:{new}\n")
        self.core.log(f"web: admin password changed from {self.client_ip()}")
        self.send(200, {"ok": True})

    def action(self, name):
        c = self.core
        if name == "sync":
            # restarting the sync role checks GitHub and the import folder at
            # once; it takes a while, so do not keep the browser waiting for it
            c.log(f"web: check now from {self.client_ip()}")
            threading.Thread(target=c.compose, args=("restart", "sync"), kwargs={"check": False},
                             daemon=True).start()
            return self.send(200, {"ok": True})
        if name == "update-system":
            job = self.app.start_job("update-system", lambda j: dict(zip(("ok", "reboot", "message"),
                                                                        c.update_system(j.say), strict=True)))
            return self.send(200, {"job": job.id})
        if name == "update-app":
            job = self.app.start_job("update-app", lambda j: dict(zip(("ok", "message"), c.update_app(j.say), strict=True)))
            return self.send(200, {"job": job.id})
        if name in ("reboot", "poweroff"):
            c.log(f"web: {name} from {self.client_ip()}")
            threading.Timer(2, lambda: c.run(["systemctl", name], check=False)).start()
            return self.send(200, {"ok": True})
        raise HttpError(404, "Unknown action.")

    def logs(self, source, lines):
        c = self.core
        lines = max(10, min(lines, 5000))
        if source in ("sync", "tftp", "web"):
            p = c.compose("logs", "--no-color", "--tail", str(lines), source, check=False)
            # compose still writes terminal control codes (e.g. "erase line")
            return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", p.stdout + p.stderr)
        if source == "dhcp":
            return c.dhcp_log(lines)
        if source == "appliance":
            text = c.read(c.LOG)
            return "\n".join(text.splitlines()[-lines:]) + "\n"
        if source == "system":
            p = c.run(["journalctl", "--no-pager", "-n", str(lines), "-u", "eve-netboot-setup",
                       "-u", "eve-netboot-web", "-u", "docker"], check=False, quiet=True)
            return p.stdout
        raise HttpError(400, "Unknown log.")

    def upload(self, name, overwrite):
        """Stream an installer ISO into the import folder."""
        c = self.core
        if not UPLOAD_NAME.match(name):
            raise HttpError(400, c.tr("adm_api_upload_name"))
        length = self.body_left
        if length <= 0:
            raise HttpError(411, "The upload needs a Content-Length.")
        if length > shutil.disk_usage(c.IMPORT).free - (1 << 30):
            raise HttpError(507, c.tr("adm_api_disk_full"))
        dest = os.path.join(c.IMPORT, name)
        if os.path.exists(dest) and not overwrite:
            raise HttpError(409, c.tr("adm_api_exists", file=name))
        part = os.path.join(c.IMPORT, f".upload-{secrets.token_hex(4)}.part")
        try:
            with open(part, "wb") as f:
                left = length
                while left:
                    chunk = self.read_body(min(left, 1 << 20))
                    if not chunk:
                        raise HttpError(400, c.tr("adm_api_interrupted"))
                    f.write(chunk)
                    left -= len(chunk)
            if not c.is_eve_iso(part):
                raise HttpError(400, c.tr("adm_api_not_eve_iso"))
            shutil.chown(part, c.ADMIN, c.ADMIN)
            os.chmod(part, 0o644)
            os.replace(part, dest)
        finally:
            if os.path.exists(part):
                os.remove(part)
        c.log(f"web: uploaded {name} ({length >> 20} MB) from {self.client_ip()}")
        self.send(200, {"ok": True, "file": name})

    def delete_image(self, rel):
        c = self.core
        root = os.path.realpath(c.IMPORT)
        full = os.path.realpath(os.path.join(root, rel))
        if not rel or not full.startswith(root + os.sep) or not os.path.isfile(full):
            raise HttpError(404, c.tr("adm_api_no_such_file"))
        if not full.lower().endswith((".iso", "installer-net.tar")):
            raise HttpError(400, c.tr("adm_api_only_isos"))
        os.remove(full)
        c.log(f"web: deleted {rel} from the import folder ({self.client_ip()})")
        self.send(200, {"ok": True})

    def diagnostics(self):
        """A tar.gz for troubleshooting: logs, status and settings without secrets."""
        c = self.core
        files = {
            "status.txt": "\n".join(c.status_lines()) + "\n",
            "settings-export.txt": c.render_export(c.load_settings()),
            "appliance.log": c.read(c.LOG),
            "sync.log": self.logs("sync", 2000),
            "tftp.log": self.logs("tftp", 500),
            "web.log": self.logs("web", 500),
            "dhcp.log": self.logs("dhcp", 1000),
            "dnsmasq.conf": c.read(c.DNSMASQ_CONF),
            "journal.log": self.logs("system", 2000),
            "status.json": c.read(os.path.join(c.WWW, "eve", "status.json")),
            "activity.json": c.read(os.path.join(c.WWW, "eve", "activity.json")),
            "versions.txt": "\n".join([
                f"appliance: {c.version()}", f"image: {c.current_image(c.load_settings())}",
                c.read("/etc/os-release"), self.command_output(["uname", "-a"])]),
            "network.txt": "\n".join(self.command_output(cmd) for cmd in
                                     (["ip", "addr"], ["ip", "route"], ["resolvectl", "status"])),
            "disk.txt": self.command_output(["df", "-h"]),
            "docker.txt": self.command_output(["docker", "ps", "-a"]),
        }
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for name, text in files.items():
                data = (text or "").encode()
                info = tarfile.TarInfo(f"eve-netboot-diagnostics/{name}")
                info.size = len(data)
                info.mtime = int(time.time())
                tar.addfile(info, io.BytesIO(data))
        return buf.getvalue()

    @staticmethod
    def command_output(cmd):
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            return f"$ {' '.join(cmd)}\n{p.stdout}{p.stderr}"
        except (OSError, subprocess.TimeoutExpired) as e:
            return f"$ {' '.join(cmd)}\n{e}\n"


# --------------------------------------------------------------------------
# start
# --------------------------------------------------------------------------
# Browsers only offer "accept the risk" for self-signed certificates that
# otherwise follow the rules; anything else is a hard error:
# - macOS / iOS (Safari, and Chrome through the macOS checks): at most 825
#   days valid and an extendedKeyUsage of serverAuth
# - Firefox: no CA certificate as the server certificate (CA:FALSE)
CERT_DAYS = 825
CERT_RENEW_DAYS = 30
CERT_PROFILE = "2"   # bump to replace certificates made by an older version


def certificate_ok(core, cert, ip):
    """True when cert is ours, current, valid for a while and names ip."""
    if core.read(os.path.join(TLS_DIR, "profile")).strip() != CERT_PROFILE:
        return False
    p = subprocess.run(["openssl", "x509", "-in", cert, "-noout", "-checkend", str(CERT_RENEW_DAYS * 86400),
                        "-ext", "subjectAltName"], capture_output=True, text=True)
    if p.returncode != 0:
        return False       # expires soon, or unreadable
    return not ip or f"IP Address:{ip}" in p.stdout


def ensure_certificate(core):
    cert, key = os.path.join(TLS_DIR, "cert.pem"), os.path.join(TLS_DIR, "key.pem")
    ip = core.primary_ip()
    if os.path.exists(cert) and os.path.exists(key) and certificate_ok(core, cert, ip):
        return cert, key
    os.makedirs(TLS_DIR, mode=0o700, exist_ok=True)
    host = core.read("/etc/hostname").strip() or "eve-netboot"
    san = f"DNS:{host}" + (f",IP:{ip}" if ip else "")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                    "-sha256", "-days", str(CERT_DAYS), "-nodes", "-keyout", key + ".new", "-out", cert + ".new",
                    "-subj", f"/CN={host}/O=EVE Netboot Installer",
                    "-addext", f"subjectAltName={san}",
                    "-addext", "basicConstraints=critical,CA:FALSE",
                    "-addext", "keyUsage=critical,digitalSignature",
                    "-addext", "extendedKeyUsage=serverAuth"],
                   check=True, capture_output=True)
    os.chmod(key + ".new", 0o600)
    os.replace(key + ".new", key)
    os.replace(cert + ".new", cert)
    core.write(os.path.join(TLS_DIR, "profile"), CERT_PROFILE + "\n", 0o600)
    core.log(f"web: created a self-signed certificate for {san}")
    return cert, key


class TLSServer(http.server.ThreadingHTTPServer):
    """TLS handshake per connection, in that connection's thread: a slow or
    broken client cannot hold up the others."""
    daemon_threads = True

    def __init__(self, address, handler, context):
        super().__init__(address, handler)
        self.context = context

    def finish_request(self, request, client_address):
        request.settimeout(120)
        try:
            first = request.recv(1, socket.MSG_PEEK)
        except OSError:
            return
        if first and first != b"\x16":
            # plain HTTP on the HTTPS port: an address typed without https://
            # (Safari then even falls back to http). Send the browser to https.
            return redirect_to_https(request)
        try:
            request = self.context.wrap_socket(request, server_side=True)
        except (ssl.SSLError, OSError):
            return
        self.RequestHandlerClass(request, client_address, self)


def redirect_to_https(sock):
    """Answer one plain HTTP request with a redirect to the same address over https."""
    data = b""
    try:
        while b"\r\n\r\n" not in data and len(data) < 16384:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        head = data.decode("latin-1").split("\r\n")
        path = head[0].split(" ")[1] if len(head[0].split(" ")) > 1 else "/"
        host = next((line.split(":", 1)[1].strip() for line in head[1:] if line.lower().startswith("host:")), "")
        if not path.startswith("/") or not re.fullmatch(r"[A-Za-z0-9.\-\[\]:]+", host or "-"):
            path, host = "/", ""
        body = b"Use https.\n"
        location = f"https://{host}{path}" if host else ""
        sock.sendall((f"HTTP/1.1 301 Moved Permanently\r\nLocation: {location}\r\n" if location else
                      "HTTP/1.1 400 Bad Request\r\n").encode("latin-1") +
                     f"Content-Type: text/plain\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                     + body)
    except (OSError, IndexError):
        pass
    finally:
        sock.close()


def serve(core):
    s = core.load_settings()
    if core.is_configured() and core.get(s, "WEB_ADMIN") != "yes":
        core.log("web: web management is switched off (WEB_ADMIN=no)")
        return 0
    port = int(core.get(s, "WEB_ADMIN_PORT"))
    cert, key = ensure_certificate(core)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    Handler.app = App(core)
    httpd = TLSServer(("0.0.0.0", port), Handler, ctx)
    core.log(f"web: management on https://{core.primary_ip() or '0.0.0.0'}:{port}/")
    httpd.serve_forever()
    return 0

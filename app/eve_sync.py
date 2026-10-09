#!/usr/bin/env python3
"""
eve-sync -- keeps an iPXE boot menu of LF Edge EVE-OS installers up to date
==========================================================================

  1. GitHub: mirrors the newest patch release of the newest N LTS lines
     (e.g. 17.0.x-lts, 16.0.x-lts, 14.5.x-lts) for every requested
     arch/flavour combination, verifies the sha256 and extracts the boot files.
  2. Local: every EVE installer ISO (volume id EVEISO) or *installer-net.tar
     found below the import folder becomes a menu entry as well.
  3. Writes <assets>/eve/eve.ipxe (the iPXE menu), <assets>/eve/status.json
     and <assets>/index.html (a read-only status page).

Why not just 'sanboot' the ISO?  EVE's installer looks for its ISO again once
Linux is running; a SAN-emulated ISO is gone at that moment.  EVE's own
netboot path puts the whole ISO *inside* the initrd (cpio entry
/installer.iso) and boots with root=/installer.iso.  This script reproduces
exactly that kernel command line - parsed from each ISO's own grub.cfg - but
driven by iPXE directly, so no EVE GRUB is needed.

Only the Python standard library and 'bsdtar' (libarchive-tools) are needed.
All settings come from environment variables, see .env.example.
"""

import datetime
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request


def _env(name, default=""):
    """ENI_* settings were called EVE_* before 1.3 (see RENAMED); the old name still works."""
    v = os.environ.get(name)
    if (v is None or v.strip() == "") and name.startswith("ENI_"):
        v = os.environ.get("EVE_" + name[4:])
    return default if v is None or v.strip() == "" else v.strip()


# installer settings that were called EVE_* before 1.3; EVE_ARCHES, EVE_FLAVOURS,
# EVE_LTS_LINES, EVE_GITHUB_REPO (about EVE-OS) and EVE_DEFAULT_* keep their name
RENAMED = ("IMAGE", "SRC_DIR", "LANGUAGE", "MENU_MODE", "MENU_TIMEOUT", "SYNC_INTERVAL",
           "IMPORT_INTERVAL", "IMPORT_LABEL", "GITHUB_TOKEN")


def legacy_names():
    """Settings still given with their pre-1.3 EVE_* name (directly, or as
    reported by compose in ENI_LEGACY_NAMES)."""
    names = set(_env("ENI_LEGACY_NAMES").split())
    names |= {"EVE_" + n for n in RENAMED
              if os.environ.get("EVE_" + n) and not os.environ.get("ENI_" + n)}
    return sorted(names)


def _env_int(name, default):
    try:
        return int(_env(name, str(default)))
    except ValueError:
        print(f"{name} is not a number, using {default}", flush=True)
        return default


def _env_bool(name, default):
    return _env(name, "1" if default else "0").lower() in ("1", "true", "yes", "on")


# --------------------------------------------------------------------------
# configuration (see .env.example for documentation)
# --------------------------------------------------------------------------
ASSETS = _env("ENI_ASSETS", "/assets")
EVE_ROOT = os.path.join(ASSETS, "eve")
REL_ROOT = os.path.join(EVE_ROOT, "releases")
LOC_ROOT = os.path.join(EVE_ROOT, "local")
STATE_FILE = os.path.join(EVE_ROOT, "sync-state.json")
IMPORT_DIR = _env("ENI_IMPORT", "/import")
TFTP_DIR = _env("ENI_TFTP_DIR", "/tftp")
IMPORT_LABEL = _env("ENI_IMPORT_LABEL", "")
APP_DIR = os.path.dirname(os.path.abspath(__file__))
# the built web UI (ui/ in the repository, built into the image as /app/ui)
UI_DIR = _env("ENI_UI_DIR", os.path.join(APP_DIR, "ui"))
VERSION = _env("ENI_VERSION", "dev")
# management UI of the VM appliance, shown as a link in the web UI (empty = none)
ADMIN_URL = _env("ENI_ADMIN_URL")
BASE_URL = _env("ENI_BASE_URL").rstrip("/")
ARCHES = _env("EVE_ARCHES", "amd64").split()
FLAVOURS = _env("EVE_FLAVOURS", "kvm").split()
LTS_LINES = _env_int("EVE_LTS_LINES", 3)
SYNC_INTERVAL = _env_int("ENI_SYNC_INTERVAL", 86400)
IMPORT_INTERVAL = _env_int("ENI_IMPORT_INTERVAL", 60)
REPO = _env("EVE_GITHUB_REPO", "lf-edge/eve")
# ENI_GITHUB_TOKEN, not GITHUB_TOKEN, in compose: a GITHUB_TOKEN exported in the
# shell that runs "docker compose up" would otherwise end up in the container.
# GITHUB_TOKEN still works for plain "docker run -e".
TOKEN = _env("ENI_GITHUB_TOKEN") or _env("GITHUB_TOKEN")
# compose sets this to "set" when GITHUB_TOKEN exists where compose runs (value not passed)
LEGACY_TOKEN_SEEN = _env("ENI_LEGACY_GITHUB_TOKEN") == "set"
API_HOST = "api.github.com"
LANGUAGE = _env("ENI_LANGUAGE", "en").lower()
# standalone: this menu is the top level (exit = boot local disk);
# chained:    the menu is chained from another iPXE menu (exit = go back)
MENU_MODE = _env("ENI_MENU_MODE", "standalone").lower()
STANDALONE = MENU_MODE != "chained"
MENU_TIMEOUT = _env_int("ENI_MENU_TIMEOUT", 300 if STANDALONE else 0)

# defaults of the installation options in the iPXE menu
SERIAL_CHOICES = ("none", "ttyS0", "ttyS1", "ttyAMA0")
DEFAULTS = {
    "reboot": _env_bool("EVE_DEFAULT_REBOOT", True),
    "softserial": _env_bool("EVE_DEFAULT_SOFT_SERIAL", True),
    "nuke": _env_bool("EVE_DEFAULT_NUKE_ALL_DISKS", False),
    "serial": _env("EVE_DEFAULT_SERIAL", "none"),
    "disk": _env("EVE_DEFAULT_INSTALL_DISK"),
    "persist": _env("EVE_DEFAULT_PERSIST_DISK"),
    "server": _env("EVE_DEFAULT_INSTALL_SERVER"),
    "extra": _env("EVE_DEFAULT_EXTRA_ARGS"),
}
if DEFAULTS["serial"] not in SERIAL_CHOICES:
    print(f"EVE_DEFAULT_SERIAL must be one of {SERIAL_CHOICES}, using 'none'", flush=True)
    DEFAULTS["serial"] = "none"

UA = "eve-netboot-installer/1.0 (eve-sync)"
MARKER = "# managed-by: eve-sync"
# files we need from an installer ISO (paths as bsdtar lists them)
WANTED = [
    "boot/kernel", "boot/initrd.img", "boot/ucode.img", "boot/cmdline",
    "EFI/BOOT/grub.cfg", "EFI/BOOT/grub_include.cfg",
]


# --------------------------------------------------------------------------
# translations (app/i18n/<lang>.json, English is the fallback for every key)
# --------------------------------------------------------------------------
def load_texts(lang):
    i18n = os.path.join(APP_DIR, "i18n")
    with open(os.path.join(i18n, "en.json"), encoding="utf-8") as f:
        texts = json.load(f)
    path = os.path.join(i18n, f"{lang}.json")
    if lang != "en":
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                texts.update({k: v for k, v in json.load(f).items() if v})
        else:
            print(f"ENI_LANGUAGE={lang}: no {path}, falling back to English", flush=True)
    return texts


T = load_texts(LANGUAGE)
if not IMPORT_LABEL:
    IMPORT_LABEL = T["import_folder"]

def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def is_api_url(url):
    u = urllib.parse.urlsplit(url)
    return u.scheme == "https" and u.hostname == API_HOST


class _RedirectHandler(urllib.request.HTTPRedirectHandler):
    """urllib keeps all headers on a redirect; never pass the token on to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and not is_api_url(newurl):
            new.remove_header("Authorization")
        return new


_opener = urllib.request.build_opener(_RedirectHandler)


def http_get(url, accept=None):
    headers = {"User-Agent": UA}
    if accept:
        headers["Accept"] = accept
    if TOKEN and is_api_url(url):
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(url, headers=headers)
    return _opener.open(req, timeout=60)


def http_json(url):
    with http_get(url, "application/vnd.github+json") as r:
        return json.load(r)


def http_text(url):
    with http_get(url) as r:
        return r.read().decode("utf-8", "replace")


def download(url, dest, expected_sha=None, retries=3, item=""):
    """Stream url to dest, verifying sha256. Atomic via .part file."""
    part = dest + ".part"
    for attempt in range(1, retries + 1):
        try:
            h = hashlib.sha256()
            done, last = 0, time.time()
            with http_get(url) as r, open(part, "wb") as f:
                total = int(r.headers.get("Content-Length") or 0)
                shown = 0.0
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    h.update(chunk)
                    done += len(chunk)
                    if item and time.time() - shown > 5:
                        write_activity("downloading", item, done, total)
                        shown = time.time()
                    if time.time() - last > 15:
                        pct = f"{done * 100 // total}%" if total else f"{done >> 20} MB"
                        log(f"    ... {pct}")
                        last = time.time()
            digest = h.hexdigest()
            if expected_sha and digest != expected_sha:
                raise ValueError(f"sha256 mismatch: got {digest}, expected {expected_sha}")
            os.replace(part, dest)
            return digest
        except Exception as e:  # noqa: BLE001
            log(f"    download attempt {attempt}/{retries} failed: {e}")
            try:
                os.remove(part)
            except FileNotFoundError:
                pass
            if attempt == retries:
                raise
            time.sleep(10 * attempt)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_text(path, default=""):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return default


def write_if_changed(path, content):
    if read_text(path, None) == content:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)
    return True


def load_state():
    return json.loads(read_text(STATE_FILE, "{}") or "{}")


def save_state(**values):
    state = load_state()
    state.update(values)
    write_if_changed(STATE_FILE, json.dumps(state, indent=2) + "\n")


def chmod_readable(path):
    """chmod -R a+rX: the web container serves the files as another user."""
    for root, _dirs, files in os.walk(path):
        for name in [root] + [os.path.join(root, f) for f in files]:
            mode = os.stat(name).st_mode
            os.chmod(name, mode | 0o444 | (0o111 if os.path.isdir(name) or mode & 0o111 else 0))


def slugify(name):
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
    return s or "iso"


def rmtree(path):
    shutil.rmtree(path, ignore_errors=True)


# --------------------------------------------------------------------------
# ISO handling
# --------------------------------------------------------------------------
def iso_members(iso):
    out = subprocess.run(["bsdtar", "-tf", iso], check=True,
                         capture_output=True, text=True).stdout
    return {line.strip().lstrip("./") for line in out.splitlines() if line.strip()}


def extract_boot_files(iso, outdir):
    """Pull kernel/initrd/ucode/grub cfgs out of the ISO into outdir."""
    members = iso_members(iso)
    want = [m for m in WANTED if m in members]
    efis = sorted(m for m in members if re.fullmatch(r"EFI/BOOT/BOOT\w+\.EFI", m, re.I))
    if "boot/kernel" not in want or "boot/initrd.img" not in want:
        raise ValueError("not an EVE installer ISO (boot/kernel or boot/initrd.img missing)")
    subprocess.run(["bsdtar", "-xf", iso, "-C", outdir] + want + efis, check=True)
    # flatten boot/* next to installer.iso so URLs stay short
    for name in ("kernel", "initrd.img", "ucode.img", "cmdline"):
        src = os.path.join(outdir, "boot", name)
        if os.path.exists(src):
            os.replace(src, os.path.join(outdir, name))
    rmtree(os.path.join(outdir, "boot"))
    return efis, "config.img" in members


def _grub_vals(text, var):
    return re.findall(r'set_global\s+%s\s+"([^"]*)"' % re.escape(var), text)


def build_boot_args(d, arch, flavour_hint):
    """
    Re-create the Linux command line that EVE's own GRUB would build for a
    *netboot* of this installer ISO (see EFI/BOOT/grub.cfg + grub_include.cfg
    inside the ISO).  Values are parsed from the ISO itself where possible so
    a future EVE release with different memory settings is picked up
    automatically; sane defaults otherwise.
    Console arguments are kept separate so the iPXE menu can add a serial one.
    """
    grub = read_text(os.path.join(d, "EFI/BOOT/grub.cfg"))
    inc = read_text(os.path.join(d, "EFI/BOOT/grub_include.cfg"))
    linuxkit = read_text(os.path.join(d, "cmdline")).strip()

    m = re.search(r"set_global\s+eve_flavor\s+(\w+)", inc)
    flavour = m.group(1) if m else flavour_hint
    netboot_ok = "isnetboot" in inc

    def pick(var, default, is_mem=False):
        vals = _grub_vals(grub, var)
        if not vals:
            return default
        if is_mem and len(vals) >= 2:
            # set_generic: first block is the 'k' flavour, second the rest
            return vals[0] if flavour == "k" else vals[1]
        return vals[0]

    k = flavour == "k"
    parts = []
    m = re.search(r'set_global\s+rootfs_root\s+"(/installer\.iso[^"]*)"', inc)
    parts.append("root=" + (m.group(1) if m else
                 "/installer.iso rootimg=/rootfs_installer.img rootaddmount=/config.img:/config.img"))
    parts.append(pick("hv_dom0_mem_settings", "dom0_mem=6400M,max:8000M" if k else "dom0_mem=640M,max:800M", True))
    parts.append(pick("hv_dom0_cpu_settings", "dom0_max_vcpus=1 dom0_vcpus_pin"))
    parts.append(pick("hv_eve_mem_settings", "eve_mem=5200M,max:6500M" if k else "eve_mem=520M,max:650M", True))
    parts.append(pick("hv_eve_cpu_settings", "eve_max_vcpus=1"))
    parts.append(pick("hv_ctrd_mem_settings", "ctrd_mem=3200M,max:4000M" if k else "ctrd_mem=320M,max:400M", True))
    parts.append(pick("hv_ctrd_cpu_settings", "ctrd_max_vcpus=1"))
    parts.append(pick("hv_watchdog_timer", "change=500"))

    # flavour tweaks (set_kvm_boot / set_k_boot)
    fn = re.search(r"function set_%s_boot \{(.*?)\n\}" % re.escape(flavour), grub, re.S)
    body = fn.group(1) if fn else ""
    m = re.search(r'set_global\s+dom0_flavor_tweaks\s+"([^"$]+)"', body)
    parts.append(m.group(1) if m else "pcie_acs_override=downstream,multifunction")
    if arch == "amd64":
        m = re.search(r'"\$dom0_flavor_tweaks\s+([^"]+)"', body)
        parts.append(m.group(1) if m else "crashkernel=2G-16G:128M,16G-128G:256M,128G-:512M")

    # dom0_cmdline = linuxkit cmdline + panic + static extras
    if linuxkit:
        parts.append(linuxkit)
    m = re.search(r'set panic_timeout="([^"]*)"', grub)
    parts.append(m.group(1) if m else "panic=120")
    m = re.search(r'set_global\s+dom0_cmdline\s+"\$linuxkit_cmdline\s+\$panic_timeout\s+([^"]*)"', grub)
    parts.append(m.group(1) if m else "rfkill.default_state=0 split_lock_detect=off")
    m = re.search(r'set_global\s+dom0_extra_args\s+"([^"$]*)"', inc)
    parts.append(m.group(1) if m else "getty rootwait")

    # default console (from the baremetal function of this arch)
    fname = "set_x86_64_baremetal" if arch == "amd64" else "set_arm64"
    fn = re.search(r"function %s \{(.*?)\n\}" % fname, grub, re.S)
    m = re.search(r'set_global\s+dom0_console\s+"([^"]*)"', fn.group(1)) if fn else None
    console = m.group(1) if m else ("console=tty0" if arch == "amd64" else
                                    "console=tty0 console=ttyS0,115200 console=hvc0")

    args = " ".join(p.strip() for p in parts if p and p.strip())
    return {"flavour": flavour, "args": args, "console": console, "netboot_ok": netboot_ok}


def detect_arch(efis, hint=None):
    names = " ".join(efis).upper()
    if "BOOTAA64" in names:
        return "arm64"
    if "BOOTX64" in names:
        return "amd64"
    return hint or "amd64"


def prepare_dir(iso_src, dest, arch_hint, flavour_hint, meta_extra, move=False):
    """
    Build dest/ (installer.iso + boot files + meta.json) atomically.
    iso_src is copied (local import) or moved (fresh download).
    """
    tmp = dest + ".tmp"
    rmtree(tmp)
    os.makedirs(tmp)
    iso = os.path.join(tmp, "installer.iso")
    if move:
        os.replace(iso_src, iso)
    else:
        shutil.copyfile(iso_src, iso)
    efis, has_cfg = extract_boot_files(iso, tmp)
    arch = detect_arch(efis, arch_hint)
    boot = build_boot_args(tmp, arch, flavour_hint)
    meta = {
        "arch": arch,
        "flavour": boot["flavour"],
        "args": boot["args"],
        "console": boot["console"],
        "netboot_ok": boot["netboot_ok"],
        "ucode": os.path.exists(os.path.join(tmp, "ucode.img")),
        "config_img": has_cfg,
        "iso_size": os.path.getsize(iso),
        "prepared": datetime.datetime.now().isoformat(timespec="seconds"),
    }
    meta.update(meta_extra)
    with open(os.path.join(tmp, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    rmtree(dest)
    os.replace(tmp, dest)
    chmod_readable(dest)
    return meta


# --------------------------------------------------------------------------
# GitHub LTS mirror
# --------------------------------------------------------------------------
LTS_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)-lts$")


def wanted_lts_releases():
    releases, page = [], 1
    while page <= 5:
        batch = http_json(f"https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}")
        if not batch:
            break
        releases += batch
        page += 1
    best = {}  # (major, minor) -> (patch, release)
    for r in releases:
        if r.get("draft") or r.get("prerelease"):
            continue
        m = LTS_RE.match(r.get("tag_name", ""))
        if not m:
            continue
        if not any(a["name"].endswith(".installer.iso") for a in r.get("assets", [])):
            continue  # very old LTS lines (11.x) have no ISO
        key = (int(m.group(1)), int(m.group(2)))
        patch = int(m.group(3))
        if key not in best or patch > best[key][0]:
            best[key] = (patch, r)
    lines = sorted(best, reverse=True)[:LTS_LINES]
    return [best[k][1] for k in lines]


def sync_github():
    os.makedirs(REL_ROOT, exist_ok=True)
    releases = wanted_lts_releases()
    log("GitHub: wanted LTS releases: " + ", ".join(r["tag_name"] for r in releases))
    keep = set()
    for rel in releases:
        tag = rel["tag_name"]
        assets = {a["name"]: a for a in rel["assets"]}
        for arch in ARCHES:
            for flav in FLAVOURS:
                variant = f"{arch}.{flav}"
                iso_name = f"{arch}.{flav}.generic.installer.iso"
                if iso_name not in assets:
                    log(f"  {tag} {variant}: no ISO published - skipped")
                    continue
                dest = os.path.join(REL_ROOT, tag, variant)
                keep.add(os.path.join(tag, variant))
                meta = json.loads(read_text(os.path.join(dest, "meta.json"), "{}") or "{}")
                asset = assets[iso_name]
                expected = None
                sums_name = f"{arch}.{flav}.generic.sha256sums"
                if sums_name in assets:
                    try:
                        for line in http_text(assets[sums_name]["browser_download_url"]).splitlines():
                            p = line.split()
                            if len(p) == 2 and p[1].lstrip("*") == iso_name:
                                expected = p[0].lower()
                    except Exception as e:  # noqa: BLE001
                        log(f"  {tag} {variant}: could not fetch sha256sums ({e})")
                if (meta.get("asset_id") == asset["id"] and meta.get("iso_size") == asset["size"]
                        and os.path.exists(os.path.join(dest, "installer.iso"))):
                    continue  # up to date
                need = asset["size"] * 2
                if shutil.disk_usage(ASSETS).free < need:
                    log(f"  {tag} {variant}: not enough free space (need {need >> 20} MB) - skipped")
                    continue
                log(f"  {tag} {variant}: downloading {asset['size'] >> 20} MB ...")
                os.makedirs(os.path.join(REL_ROOT, tag), exist_ok=True)
                part = os.path.join(REL_ROOT, tag, f".{iso_name}")
                digest = download(asset["browser_download_url"], part, expected, item=f"{tag} {variant}")
                log(f"  {tag} {variant}: sha256 {'verified' if expected else 'computed'} {digest[:16]}...")
                prepare_dir(part, dest, arch, flav, {
                    "source": "github", "tag": tag, "asset": iso_name, "asset_id": asset["id"],
                    "sha256": digest, "sha256_verified": bool(expected),
                    "published": rel.get("published_at", "")[:10], "variant": flav,
                }, move=True)
                log(f"  {tag} {variant}: ready")
                write_menus()   # each release is offered as soon as it is ready
    # prune releases/variants that are no longer wanted
    for tag in os.listdir(REL_ROOT):
        tdir = os.path.join(REL_ROOT, tag)
        if not os.path.isdir(tdir):
            continue
        for v in os.listdir(tdir):
            if os.path.join(tag, v) not in keep:
                log(f"  pruning {tag}/{v}")
                p = os.path.join(tdir, v)
                rmtree(p) if os.path.isdir(p) else os.remove(p)
        if not os.listdir(tdir):
            os.rmdir(tdir)
    save_state(github_checked=datetime.datetime.now().strftime("%Y-%m-%d %H:%M"))


# --------------------------------------------------------------------------
# local import folder
# --------------------------------------------------------------------------
def is_eve_iso(path):
    """EVE installer ISOs carry the ISO9660 volume id 'EVEISO'."""
    try:
        with open(path, "rb") as f:
            f.seek(0x8000)
            pvd = f.read(72)
        return pvd[1:6] == b"CD001" and pvd[40:72].strip() == b"EVEISO"
    except OSError:
        return False


def import_candidates():
    """All EVE installers anywhere below IMPORT_DIR (other ISOs are ignored)."""
    found = []
    if not os.path.isdir(IMPORT_DIR):
        return found
    for root, dirs, files in os.walk(IMPORT_DIR):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fn in files:
            low = fn.lower()
            if fn.startswith(".") or not (low.endswith(".iso") or low.endswith("installer-net.tar")):
                continue
            full = os.path.join(root, fn)
            if low.endswith(".iso") and not is_eve_iso(full):
                continue
            rel = os.path.relpath(full, IMPORT_DIR)
            found.append((rel, full))
    return sorted(found)


def sync_local():
    os.makedirs(LOC_ROOT, exist_ok=True)
    changed = False
    keep = set()
    for rel, full in import_candidates():
        slug = slugify(re.sub(r"\.(iso|tar)$", "", rel, flags=re.I))
        keep.add(slug)
        dest = os.path.join(LOC_ROOT, slug)
        st = os.stat(full)
        stamp = f"{st.st_size}:{int(st.st_mtime)}"
        meta = json.loads(read_text(os.path.join(dest, "meta.json"), "{}") or "{}")
        if meta.get("stamp") == stamp:
            continue
        if meta.get("error_stamp") == stamp:
            continue  # known-bad file, don't retry every minute
        # skip files that are still being copied in (size changing)
        time.sleep(2)
        if os.stat(full).st_size != st.st_size:
            log(f"Local: {rel} is still being written - later")
            continue
        log(f"Local: importing {rel} ({st.st_size >> 20} MB)")
        write_activity("importing", rel)
        try:
            src = full
            if rel.lower().endswith(".tar"):
                tmpd = os.path.join(LOC_ROOT, f".{slug}.untar")
                rmtree(tmpd)
                os.makedirs(tmpd)
                subprocess.run(["bsdtar", "-xf", full, "-C", tmpd, "installer.iso"], check=True)
                src = os.path.join(tmpd, "installer.iso")
            # The file name is the only hint: every installer ISO, 'k' included,
            # sets eve_flavor kvm in its grub_include.cfg (the installer itself
            # always boots as kvm), so the ISO cannot tell the variant.
            base = os.path.basename(rel).lower()
            variant = ("k" if re.search(r"(^|[._-])(k|kubevirt)([._-]|$)", base)
                       else "kvm" if "kvm" in base else "")
            m = prepare_dir(src, dest, None, "kvm", {
                "source": "local", "file": rel, "stamp": stamp, "name": os.path.basename(rel),
                "variant": variant,
                "mtime": datetime.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d"),
            })
            if src != full:
                rmtree(os.path.dirname(src))
            log(f"Local: {rel} ready ({m['arch']}, variant={variant or '?'}, netboot_ok={m['netboot_ok']})")
        except Exception as e:  # noqa: BLE001
            log(f"Local: {rel} FAILED: {e}")
            rmtree(dest + ".tmp")
            rmtree(dest)
            os.makedirs(dest, exist_ok=True)
            with open(os.path.join(dest, "meta.json"), "w") as f:
                json.dump({"source": "local", "file": rel, "error": str(e), "error_stamp": stamp}, f)
        changed = True
    for d in os.listdir(LOC_ROOT):
        if d.startswith("."):
            continue
        if d not in keep:
            log(f"Local: {d} removed from import folder - pruning")
            rmtree(os.path.join(LOC_ROOT, d))
            changed = True
    return changed




# --------------------------------------------------------------------------
# menu + status page
# --------------------------------------------------------------------------
def collect_entries():
    entries = []

    def ver_key(tag):
        m = LTS_RE.match(tag)
        return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)

    def variant_key(v):
        arch, _, var = v.partition(".")
        return (arch, var != "kvm", var)   # kvm before k within an arch

    if os.path.isdir(REL_ROOT):
        for tag in sorted(os.listdir(REL_ROOT), key=ver_key, reverse=True):
            tdir = os.path.join(REL_ROOT, tag)
            if not os.path.isdir(tdir):
                continue
            for v in sorted(os.listdir(tdir), key=variant_key):
                meta = json.loads(read_text(os.path.join(tdir, v, "meta.json"), "{}") or "{}")
                if meta.get("args"):
                    meta.setdefault("variant", v.split(".", 1)[-1])
                    meta["path"] = f"releases/{tag}/{v}"
                    meta["label"] = f"{tag}  {meta['variant']}  ({meta.get('published', '')})"
                    entries.append(meta)
    if os.path.isdir(LOC_ROOT):
        for d in sorted(os.listdir(LOC_ROOT)):
            meta = json.loads(read_text(os.path.join(LOC_ROOT, d, "meta.json"), "{}") or "{}")
            if not meta:
                continue
            meta["path"] = f"local/{d}"
            name = meta.get("file", d)
            if meta.get("error"):
                meta["label"] = f"{name}  [{T['label_error']}: {meta['error'][:40]}]"
            else:
                meta["label"] = f"{name}  ({meta.get('mtime', '')})"
            entries.append(meta)
    return entries


_ASCII_MAP = str.maketrans({
    "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss", "œ": "oe", "Œ": "OE",
    "‘": "'", "’": "'", "“": '"', "”": '"', "«": '"', "»": '"', "–": "-", "—": "-",
    "…": "...", " ": " ",
})


# language specific transliteration conventions (applied before the generic one)
_LANG_ASCII = {
    "de": {"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue"},
    "da": {"å": "aa", "Å": "Aa", "ø": "oe", "Ø": "Oe"},
    "no": {"å": "aa", "Å": "Aa", "ø": "oe", "Ø": "Oe"},
}


def ascii_text(s):
    """iPXE consoles (serial, BIOS, many UEFI) are not reliably UTF-8."""
    s = str(s).translate(str.maketrans(_LANG_ASCII.get(LANGUAGE, {})))
    s = s.translate(_ASCII_MAP)
    s = unicodedata.normalize("NFKD", s)
    return s.encode("ascii", "ignore").decode("ascii")


def ipxe_safe(s):
    """Untrusted text (file names, errors): no ${...} expansion, one line."""
    return ascii_text(s).replace("$", "").replace("\n", " ").replace("\r", " ")


def ipxe_value(v):
    return re.sub(r"\s+", " ", ipxe_safe(v)).strip()


def fill(template, extra=None):
    """Replace @@key@@ with the (ASCII) translation."""
    values = dict(T)
    values.update(extra or {})
    return re.sub(r"@@(\w+)@@", lambda m: ascii_text(values[m.group(1)]), template)


def render_menu(entries, github_checked):
    """No timestamps of its own: the output only changes when the content does."""
    gh = [e for e in entries if e.get("source") == "github"]
    lo = [e for e in entries if e.get("source") == "local"]
    D = DEFAULTS
    L = []
    a = L.append
    a("#!ipxe")
    a(MARKER)
    a("# ==========================================================================")
    a("# LF Edge EVE-OS installer menu (EVE Netboot Installer)")
    a(f"# GENERATED by eve-sync (language: {LANGUAGE}, mode: {MENU_MODE})")
    a("# Do not edit - it is overwritten on every change.")
    a("# ==========================================================================")
    a(f"set eve_base {BASE_URL}/eve")
    a("set eve_sp:hex 20:20")
    a("set eve_sp ${eve_sp:string}")
    a("set eve_esc:hex 1b")
    a("set eve_esc ${eve_esc:string}")
    a("")
    a("# ---- the look of EVE-OS's own console: light text on black, the selection")
    a("# inverted, headings in yellow (colour pairs: 0 text, 1 menu, 2 selection,")
    a("# 3 heading, 4 input, 5 alert, 6 link)")
    for pair, fg, bg in ((0, 7, 0), (1, 7, 0), (2, 0, 7), (3, 3, 0), (4, 0, 7), (5, 7, 1), (6, 6, 0)):
        a(f"cpair --foreground {fg} --background {bg} {pair}")
    a("")
    a("# ---- defaults: only on first entry, so options survive menu round trips")
    a("isset ${eve_init} && goto eve_detect ||")
    a(":eve_defaults")
    a("set eve_init 1")
    a("set eve_first 1")
    a(f"set eve_reboot {int(D['reboot'])}")
    a(f"set eve_softserial {int(D['softserial'])}")
    a(f"set eve_serial {D['serial']}")
    a(f"set eve_nuke {int(D['nuke'])}")
    a("set eve_pause 0")
    a("set eve_debug 0")
    a("set eve_blackbox 0")
    for var, key in (("eve_disk", "disk"), ("eve_persist", "persist"),
                     ("eve_server", "server"), ("eve_extra", "extra")):
        val = ipxe_value(D[key])
        a(f"set {var} {val}" if val else f"clear {var}")
    a("set eve_last eve_opt")
    a("set eve_olast eve_o_disk")
    a("")
    a(":eve_detect")
    a("clear eve_arch")
    a("iseq ${buildarch} arm64 && set eve_arch arm64 ||")
    a("iseq ${buildarch} x86_64 && set eve_arch amd64 ||")
    a("isset ${eve_arch} && goto eve_menu ||")
    a("cpuid --ext 29 && set eve_arch amd64 || set eve_arch unsupported")
    a("")
    a("# ---- main menu")
    a(":eve_menu")
    a(fill("isset ${eve_disk} && set eve_disk_s ${eve_disk} || set eve_disk_s @@val_auto@@"))
    a(fill("iseq ${eve_reboot} 1 && set eve_reboot_s @@val_on@@ || set eve_reboot_s @@val_off@@"))
    a(fill("iseq ${eve_nuke} 1 && set eve_nuke_s , @@sum_nuke@@ || clear eve_nuke_s"))
    a(fill("menu EVE Netboot Installer  -  @@menu_title@@  [${eve_arch}]"))
    a(fill("item --gap @@gap_github@@", {"gap_github": T["gap_github"].replace("{date}", github_checked or "-")}))
    if not gh:
        a(fill("item --gap ${eve_sp}@@gap_none_synced@@"))
    labels = {id(e): f"eve_e{i}" for i, e in enumerate(gh + lo)}
    for e in gh:
        a(f"iseq ${{eve_arch}} {e['arch']} && item {labels[id(e)]} ${{eve_sp}}{ipxe_safe(e['label'])} ||")
    a(fill("item --gap @@gap_local@@", {"gap_local": T["gap_local"].replace("{folder}", IMPORT_LABEL)}))
    if not lo:
        a(fill("item --gap ${eve_sp}@@gap_local_none@@",
               {"gap_local_none": T["gap_local_none"].replace("{folder}", IMPORT_LABEL)}))
    for e in lo:
        if e.get("error"):
            a(f"item --gap ${{eve_sp}}{ipxe_safe(e['label'])}")
        else:
            a(f"iseq ${{eve_arch}} {e['arch']} && item {labels[id(e)]} ${{eve_sp}}{ipxe_safe(e['label'])} ||")
    a(fill("item --gap @@gap_options@@"))
    a(fill("item eve_opt ${eve_sp}@@item_options@@  [@@sum_disk@@: ${eve_disk_s}, "
           "@@sum_reboot@@: ${eve_reboot_s}${eve_nuke_s}]"))
    a(fill("item eve_shell ${eve_sp}@@item_shell@@"))
    if STANDALONE:
        a(fill("item eve_exit ${eve_sp}@@item_local@@"))
        a(fill("item eve_reboot ${eve_sp}@@item_reboot_machine@@"))
    else:
        a(fill("item eve_exit ${eve_sp}@@item_back@@"))
    if MENU_TIMEOUT > 0:
        target = T["timeout_local"] if STANDALONE else T["timeout_back"]
        a(fill("iseq ${eve_first} 1 && item --gap ${eve_sp}@@gap_timeout@@ ||",
               {"gap_timeout": T["gap_timeout"].replace("{seconds}", str(MENU_TIMEOUT))
                                               .replace("{target}", target)}))
        a("iseq ${eve_first} 1 && goto eve_choose_first ||")
    a("choose --default ${eve_last} eve_choice || goto eve_exit")
    a("goto eve_chosen")
    a(":eve_choose_first")
    a("clear eve_first")
    a(f"choose --timeout {max(MENU_TIMEOUT, 1) * 1000} --default eve_exit eve_choice || goto eve_exit")
    a(":eve_chosen")
    a("set eve_last ${eve_choice}")
    a("goto ${eve_choice}")
    a("")
    for e in gh + lo:
        if e.get("error"):
            continue
        var = e.get("variant") or ""
        if e.get("source") == "github":
            title = f"EVE-OS {e['tag']} {e['arch']}.{var} (GitHub)"
        else:
            title = f"{e.get('name', e['path'])} [{e['arch']}] ({T['src_local']})"
        a(f":{labels[id(e)]}")
        a(f"set eve_title {ipxe_safe(title)}")
        a(f"set eve_dir ${{eve_base}}/{e['path']}")
        a(f"set eve_args {e['args']}")
        a(f"set eve_con {e['console']}")
        a(f"set eve_ucode {1 if e.get('ucode') else 0}")
        a(f"set eve_netboot {1 if e.get('netboot_ok') else 0}")
        a(f"set eve_isomb {e.get('iso_size', 0) >> 20}")
        a(f"set eve_k {1 if var == 'k' else 0}")
        a("goto eve_confirm")
        a("")
    a(fill(MENU_TAIL))
    if not STANDALONE:
        # back to the calling iPXE menu: give it iPXE's own colours again
        L[-1] = L[-1].replace(":eve_exit\n", ":eve_exit\n" + "".join(
            f"cpair --foreground {fg} --background {bg} {pair}\n" for pair, fg, bg in
            ((0, 9, 9), (1, 7, 4), (2, 7, 1), (3, 6, 4), (4, 0, 6), (5, 7, 1), (6, 6, 4))))
    return "\n".join(L) + "\n"


MENU_TAIL = r"""# ---- options menu
:eve_opt
isset ${eve_disk} && set eve_disk_s ${eve_disk} || set eve_disk_s @@val_auto@@
isset ${eve_persist} && set eve_persist_s ${eve_persist} || set eve_persist_s @@val_same_disk@@
isset ${eve_server} && set eve_server_s ${eve_server} || set eve_server_s @@val_from_iso@@
iseq ${eve_reboot} 1 && set eve_reboot_s @@val_on@@ || set eve_reboot_s @@val_off@@
iseq ${eve_softserial} 1 && set eve_soft_s ${mac:hexhyp} || set eve_soft_s @@val_random@@
iseq ${eve_nuke} 1 && set eve_nuke_s @@val_yes@@ || set eve_nuke_s @@val_no@@
iseq ${eve_pause} 1 && set eve_pause_s @@val_on@@ || set eve_pause_s @@val_off@@
iseq ${eve_debug} 1 && set eve_debug_s @@val_on@@ || set eve_debug_s @@val_off@@
iseq ${eve_blackbox} 1 && set eve_bb_s @@val_bb_yes@@ || set eve_bb_s @@val_no@@
iseq ${eve_serial} none && set eve_serial_s @@val_none@@ || set eve_serial_s ${eve_serial}
isset ${eve_extra} && set eve_extra_s ${eve_extra} || set eve_extra_s -
menu @@opt_title@@
item --gap @@opt_gap_target@@
item eve_o_disk ${eve_sp}@@opt_disk@@: ${eve_disk_s}
item eve_o_persist ${eve_sp}@@opt_persist@@: ${eve_persist_s}
item eve_o_server ${eve_sp}@@opt_server@@: ${eve_server_s}
item --gap @@opt_gap_behaviour@@
item eve_o_reboot ${eve_sp}@@opt_reboot@@: ${eve_reboot_s}
item eve_o_soft ${eve_sp}@@opt_soft@@: ${eve_soft_s}
item eve_o_nuke ${eve_sp}@@opt_nuke@@: ${eve_nuke_s}
item eve_o_pause ${eve_sp}@@opt_pause@@: ${eve_pause_s}
item eve_o_debug ${eve_sp}@@opt_debug@@: ${eve_debug_s}
item eve_o_bb ${eve_sp}@@opt_bb@@: ${eve_bb_s}
item --gap @@opt_gap_console@@
item eve_o_serial ${eve_sp}@@opt_serial@@: ${eve_serial_s}
item eve_o_extra ${eve_sp}@@opt_extra@@: ${eve_extra_s}
item --gap
item eve_o_reset ${eve_sp}@@opt_reset@@
item eve_menu ${eve_sp}<< @@opt_back@@
choose --default ${eve_olast} eve_ochoice || goto eve_menu
set eve_olast ${eve_ochoice}
goto ${eve_ochoice}

:eve_o_disk
echo
echo @@prompt_disk_1@@
echo @@prompt_disk_2@@
echo -n @@opt_disk@@: ${} && read eve_disk ||
goto eve_opt
:eve_o_persist
echo
echo @@prompt_persist_1@@
echo @@prompt_persist_2@@
echo -n @@opt_persist@@: ${} && read eve_persist ||
goto eve_opt
:eve_o_server
echo
echo @@prompt_server_1@@
echo @@prompt_server_2@@
echo -n @@opt_server@@: ${} && read eve_server ||
goto eve_opt
:eve_o_reboot
iseq ${eve_reboot} 1 && set eve_reboot 0 || set eve_reboot 1
goto eve_opt
:eve_o_soft
iseq ${eve_softserial} 1 && set eve_softserial 0 || set eve_softserial 1
goto eve_opt
:eve_o_nuke
iseq ${eve_nuke} 1 && set eve_nuke 0 || set eve_nuke 1
goto eve_opt
:eve_o_pause
iseq ${eve_pause} 1 && set eve_pause 0 || set eve_pause 1
goto eve_opt
:eve_o_debug
iseq ${eve_debug} 1 && set eve_debug 0 || set eve_debug 1
goto eve_opt
:eve_o_bb
iseq ${eve_blackbox} 1 && set eve_blackbox 0 || set eve_blackbox 1
goto eve_opt
:eve_o_serial
iseq ${eve_serial} none && set eve_serial ttyS0 && goto eve_opt ||
iseq ${eve_serial} ttyS0 && set eve_serial ttyS1 && goto eve_opt ||
iseq ${eve_serial} ttyS1 && set eve_serial ttyAMA0 && goto eve_opt ||
set eve_serial none
goto eve_opt
:eve_o_extra
echo
echo @@prompt_extra@@
echo -n @@opt_extra@@: ${} && read eve_extra ||
goto eve_opt
:eve_o_reset
clear eve_init
goto eve_defaults

# ---- confirmation + boot
:eve_confirm
iseq ${eve_netboot} 1 || goto eve_err_netboot
clear eve_opts
iseq ${eve_reboot} 1 && set eve_opts ${eve_opts} eve_reboot_after_install ||
iseq ${eve_softserial} 1 && set eve_opts ${eve_opts} eve_soft_serial=${mac:hexhyp} ||
isset ${eve_disk} && set eve_opts ${eve_opts} eve_install_disk=${eve_disk} ||
isset ${eve_persist} && set eve_opts ${eve_opts} eve_persist_disk=${eve_persist} ||
isset ${eve_server} && set eve_opts ${eve_opts} eve_install_server=${eve_server} ||
iseq ${eve_nuke} 1 && set eve_opts ${eve_opts} eve_nuke_all_disks ||
iseq ${eve_pause} 1 && set eve_opts ${eve_opts} eve_pause_before_install ||
iseq ${eve_debug} 1 && set eve_opts ${eve_opts} eve_install_debug=true linuxkit.runc_console=1 ||
iseq ${eve_blackbox} 1 && set eve_opts ${eve_opts} eve_blackbox ||
clear eve_conx
iseq ${eve_serial} none || set eve_conx console=${eve_serial},115200n8
echo ${cls}
echo ${eve_esc}[33m===========================================================================
echo ${eve_esc}[37m ${eve_title}
echo ${eve_esc}[33m===========================================================================${eve_esc}[37m
echo  @@conf_source@@: ${eve_dir}/
echo  ISO: @@conf_iso_ram@@
echo  @@conf_options@@: ${eve_opts}
isset ${eve_conx} && echo  @@conf_console@@: ${eve_con} ${eve_conx} ||
isset ${eve_extra} && echo  @@conf_extra@@: ${eve_extra} ||
iseq ${eve_k} 1 && echo  ${eve_esc}[33m@@conf_note@@: @@conf_k_warn@@${eve_esc}[37m ||
echo
iseq ${eve_blackbox} 1 && echo  @@conf_bb@@ ||
iseq ${eve_blackbox} 1 || echo  ${eve_esc}[33m@@conf_wipe_warn@@${eve_esc}[37m
iseq ${eve_nuke} 1 && echo  ${eve_esc}[31m@@conf_nuke_warn@@${eve_esc}[37m ||
echo
prompt --key i @@conf_press_i@@ && goto eve_boot || goto eve_menu

:eve_boot
imgfree
echo
echo @@boot_kernel@@
kernel ${eve_dir}/kernel initrd=initrd.magic ${eve_con} ${eve_conx} ${eve_args} ${eve_opts} ${eve_extra} || goto eve_err_boot
iseq ${eve_ucode} 1 || goto eve_boot_initrd
initrd ${eve_dir}/ucode.img || goto eve_err_boot
:eve_boot_initrd
initrd ${eve_dir}/initrd.img || goto eve_err_boot
echo @@boot_iso@@
initrd --name installer.iso ${eve_dir}/installer.iso /installer.iso || goto eve_err_boot
boot || goto eve_err_boot

# ---- errors / misc
:eve_err_netboot
echo
echo ${eve_esc}[31m@@err_netboot_1@@${eve_esc}[37m
echo @@err_netboot_2@@
prompt @@press_any@@
goto eve_menu
:eve_err_boot
echo
echo ${eve_esc}[31m@@err_boot_1@@${eve_esc}[37m
echo @@err_boot_2@@
prompt @@press_any@@
goto eve_menu
:eve_shell
echo @@shell_hint@@
shell
goto eve_menu
:eve_reboot
reboot
goto eve_menu
:eve_exit
exit 0
"""


def render_index(entries, github_checked):
    """Small read-only status page served at http://<host>:<port>/."""
    h = html.escape
    rows = []
    for e in entries:
        ok = not e.get("error")
        src = "GitHub" if e.get("source") == "github" else f"{T['src_local']} ({IMPORT_LABEL})"
        name = e.get("tag") or e.get("file") or e.get("path")
        size = f"{(e.get('iso_size') or 0) / 1048576:.0f} MB" if ok else ""
        sha = (("&#10003; " + h(T["sha_verified"])) if e.get("sha256_verified") else
               (h(T["sha_computed"]) if e.get("sha256") else "")) if ok else ""
        state = (h(T["state_ready"]) if ok and e.get("netboot_ok")
                 else h(e.get("error") or T["state_not_netboot"]))
        rows.append(
            f"<tr><td>{h(str(name))}</td><td>{h(e.get('arch', ''))}</td>"
            f"<td>{h(e.get('variant') or '')}</td><td>{h(src)}</td><td>{size}</td><td>{sha}</td>"
            f"<td>{state}</td><td><a href='eve/{h(e['path'])}/'>{h(T['th_files'])}</a></td></tr>")
    body = "\n".join(rows) or f"<tr><td colspan=8>{h(T['page_empty'])}</td></tr>"
    return f"""<!doctype html><html lang="{h(LANGUAGE)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>EVE Netboot Installer</title><style>
:root{{color-scheme:light dark;--bg:#f6f7f9;--fg:#1d2329;--muted:#5d6872;--line:#d9dee3;--code:#e8ecf0;--link:#0b62c4}}
@media (prefers-color-scheme:dark){{:root{{--bg:#1e2329;--fg:#e6e6e6;--muted:#9aa4ad;--line:#3a414a;--code:#2b3138;--link:#6cb6ff}}}}
body{{font-family:system-ui,sans-serif;margin:2rem;background:var(--bg);color:var(--fg)}}
h1{{font-size:1.4rem}} a{{color:var(--link)}} .wrap{{overflow-x:auto}}
table{{border-collapse:collapse;width:100%;max-width:1100px}}
th,td{{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--line);font-size:.9rem;white-space:nowrap}}
th{{color:var(--muted);font-weight:600}} code{{background:var(--code);padding:.1rem .3rem;border-radius:3px}}
.muted{{color:var(--muted);font-size:.85rem;line-height:1.5}}
@media (max-width:600px){{body{{margin:1rem}}}}</style></head><body>
<h1>EVE Netboot Installer</h1>
<p class="muted">{h(T['page_github_checked'])}: {h(github_checked or '-')} &middot; {h(T['page_refresh'])} &middot;
{h(T['page_lts_lines'])}: {LTS_LINES} &middot; {h(T['page_arches'])}: {h(' '.join(ARCHES))} &middot;
{h(T['page_flavours'])}: {h(' '.join(FLAVOURS))}</p>
<div class="wrap"><table><tr><th>{h(T['th_release'])}</th><th>{h(T['th_arch'])}</th>
<th>{h(T['th_variant'])}</th><th>{h(T['th_source'])}</th><th>ISO</th><th>SHA256</th>
<th>{h(T['th_status'])}</th><th></th></tr>
{body}</table></div>
<p class="muted">{h(T['page_flow'])}: DHCP &rarr; TFTP (iPXE) &rarr;
<a href="eve/eve.ipxe">eve/eve.ipxe</a> &middot; <a href="eve/status.json">status.json</a> &middot;
<a href="eve/">{h(T['page_all_files'])}</a><br>
{h(T['page_add_local'].replace('{folder}', IMPORT_LABEL))}</p>
</body></html>
"""


BOOT_IPXE = r"""#!ipxe
# managed-by: eve-sync
# Second stage, loaded over TFTP by the iPXE binary that ships with
# EVE Netboot Installer. Points iPXE at the HTTP menu; regenerated on start.
chain --autofree @@base@@/eve/eve.ipxe || goto failed
exit 0
:failed
echo
echo @@embed_fail@@ @@base@@/eve/eve.ipxe
prompt --key s --timeout 15000 @@embed_prompt@@ && shell ||
exit 1
"""


def write_boot_ipxe():
    """TFTP side: the generic iPXE binary chains tftp://<next-server>/boot.ipxe."""
    if os.path.isdir(TFTP_DIR):
        write_if_changed(os.path.join(TFTP_DIR, "boot.ipxe"), fill(BOOT_IPXE, {"base": BASE_URL}))


STATUS_FIELDS = ("path", "source", "tag", "file", "name", "arch", "variant", "flavour", "iso_size",
                 "sha256", "sha256_verified", "netboot_ok", "error", "published", "mtime", "prepared",
                 "ucode", "config_img", "args", "console", "label")


def install_ui():
    """Copy the built web UI into the web root: index.html + ui/. Files of an
    older UI version (hashed names) are removed. False when there is no UI."""
    index = os.path.join(UI_DIR, "index.html")
    if not os.path.isfile(index):
        return False
    wanted = set()
    for root, _dirs, files in os.walk(UI_DIR):
        for name in files:
            src = os.path.join(root, name)
            rel = os.path.relpath(src, UI_DIR)
            wanted.add(rel)
            dest = os.path.join(ASSETS, rel)
            with open(src, "rb") as f:
                data = f.read()
            try:
                with open(dest, "rb") as f:
                    if f.read() == data:
                        continue
            except FileNotFoundError:
                pass
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest + ".tmp", "wb") as f:
                f.write(data)
            os.chmod(dest + ".tmp", 0o644)
            os.replace(dest + ".tmp", dest)
    ui_root = os.path.join(ASSETS, "ui")
    for root, _dirs, files in os.walk(ui_root):
        for name in files:
            path = os.path.join(root, name)
            if os.path.relpath(path, ASSETS) not in wanted:
                os.remove(path)
    return True


def write_activity(state="idle", item="", done=0, total=0, next_check=None):
    """eve/activity.json: what the sync is doing right now, plus disk space.
    Separate from status.json, which only changes when its content does."""
    data = {"state": state, "updated": datetime.datetime.now().isoformat(timespec="seconds")}
    if item:
        data["item"] = item
    if total:
        data.update(done_mb=done >> 20, total_mb=total >> 20, percent=done * 100 // total)
    try:
        du = shutil.disk_usage(ASSETS)
        data["disk"] = {"total_gb": round(du.total / 2**30, 1), "free_gb": round(du.free / 2**30, 1),
                        "used_gb": round((du.total - du.free) / 2**30, 1)}
    except OSError:
        pass
    if next_check is not None:
        data["next_github_check"] = next_check
    elif state == "idle":
        data["next_github_check"] = NEXT_GITHUB_CHECK
    write_if_changed(os.path.join(EVE_ROOT, "activity.json"), json.dumps(data, indent=2) + "\n")


NEXT_GITHUB_CHECK = None


def write_menus():
    write_boot_ipxe()
    entries = collect_entries()
    checked = load_state().get("github_checked")
    changed = write_if_changed(os.path.join(EVE_ROOT, "eve.ipxe"), render_menu(entries, checked))
    status = {
        "github_checked": checked,
        "config": {"arches": ARCHES, "flavours": FLAVOURS, "lts_lines": LTS_LINES,
                   "base_url": BASE_URL, "language": LANGUAGE, "menu_mode": MENU_MODE,
                   "menu_timeout": MENU_TIMEOUT, "sync_interval": SYNC_INTERVAL,
                   "import_label": IMPORT_LABEL, "defaults": DEFAULTS,
                   "version": VERSION, "admin_url": ADMIN_URL},
        "entries": [{k: e.get(k) for k in STATUS_FIELDS} for e in entries],
    }
    # "updated" = when the rest of status.json last changed, not when it was last written
    path = os.path.join(EVE_ROOT, "status.json")
    old = json.loads(read_text(path, "{}") or "{}")
    updated = old.pop("updated", None)
    if old != json.loads(json.dumps(status)) or not updated:
        updated = datetime.datetime.now().isoformat(timespec="seconds")
    write_if_changed(path, json.dumps({"updated": updated, **status}, indent=2) + "\n")
    write_if_changed(os.path.join(EVE_ROOT, "ui.json"),
                     json.dumps({"language": LANGUAGE, "texts": T}, ensure_ascii=False, indent=1) + "\n")
    if not install_ui():
        # no built UI (running from a source checkout): the simple status page
        write_if_changed(os.path.join(ASSETS, "index.html"), render_index(entries, checked))
    if changed:
        log(f"Menu updated: {len(entries)} entries")


# --------------------------------------------------------------------------
# main loop
# --------------------------------------------------------------------------
def main():
    global NEXT_GITHUB_CHECK
    if not BASE_URL:
        log("ENI_BASE_URL is not set (e.g. http://192.168.1.10:8080) - aborting")
        sys.exit(2)
    if shutil.which("bsdtar") is None:
        log("bsdtar not found (install libarchive-tools) - aborting")
        sys.exit(2)
    os.makedirs(EVE_ROOT, exist_ok=True)
    old = legacy_names()
    if old:
        log("these settings still use their old name (it keeps working): " + " ".join(old)
            + " - rename EVE_ to ENI_ in .env, e.g. EVE_LANGUAGE -> ENI_LANGUAGE")
    if LEGACY_TOKEN_SEEN and not TOKEN:
        log("GITHUB_TOKEN is set where docker compose runs, but is no longer passed to the "
            "container; set ENI_GITHUB_TOKEN in .env to use a token (GitHub is queried anonymously)")
    log(f"eve-sync start: arches={ARCHES} flavours={FLAVOURS} lts_lines={LTS_LINES} "
        f"base={BASE_URL} import={IMPORT_DIR} language={LANGUAGE} mode={MENU_MODE}")
    once = "--once" in sys.argv
    next_gh = 0
    try:
        # web UI, menu and status right away, not only after the first downloads
        write_menus()
    except Exception as e:  # noqa: BLE001
        log(f"writing the menu failed: {e}")
    while True:
        try:
            if sync_local():
                write_menus()
            if time.time() >= next_gh:
                try:
                    sync_github()
                    # ENI_SYNC_INTERVAL=0: GitHub only at start, the import folder is still watched
                    next_gh = time.time() + SYNC_INTERVAL if SYNC_INTERVAL > 0 else float("inf")
                except Exception as e:  # noqa: BLE001
                    log(f"GitHub sync failed: {e}; retry in 1h")
                    traceback.print_exc()
                    next_gh = time.time() + 3600
            write_menus()
            NEXT_GITHUB_CHECK = (None if next_gh == float("inf") else
                                 datetime.datetime.fromtimestamp(next_gh).strftime("%Y-%m-%d %H:%M"))
            write_activity()
        except Exception as e:  # noqa: BLE001
            log(f"cycle failed: {e}")
            traceback.print_exc()
        if once:
            break
        time.sleep(IMPORT_INTERVAL)


if __name__ == "__main__":
    main()

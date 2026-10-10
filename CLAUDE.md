# EVE Netboot Installer

PXE/iPXE boot server for LF Edge EVE-OS installers, shipped as one Docker image
in three compose roles (`sync`, `tftp`, `web`). See README.md for users and
docs/how-it-works.md for the boot chain.

## Layout

- `app/eve_sync.py`: everything the `sync` role does (GitHub LTS mirror, import
  folder, `eve.ipxe` menu, `boot.ipxe`, status page/JSON). Standard library +
  `bsdtar` only; configuration comes from env vars read at import time.
- `app/i18n/<lang>.json`: menu/status texts, `@@key@@` placeholders in templates.
  `en.json` is the fallback. Files are `indent=1`, `ensure_ascii=False`, no
  trailing newline. Every language must have the same keys as `en.json`.
  `adm_*` keys are the texts of the appliance's console and web management
  (`{name}` placeholders), shared: a setting's label/help/options are
  `adm_f_/adm_h_/adm_o_/adm_p_<key>` in both. ENI_LANGUAGE is the language of
  the tool itself too.
- `docker/`: iPXE build (from source, x86_64 + arm64 EFI), generic embedded
  script, entrypoint that selects the role.
- `vm/`: the VM appliance (Debian 13 + Docker from Debian + the app image).
  `vm/rootfs/usr/local/sbin/eve-netboot` (Python + whiptail) is the setup
  wizard, console, menu, cloud-init input (KEY=VALUE or `eve_netboot:` in a
  #cloud-config), apply, updates with rollback and export/import.
  `vm/build/build.sh` builds the qcow2/VMDK/OVA by booting the Debian cloud
  image in QEMU and running `provision.sh` inside; image.yml does this for
  every `v*` tag and attaches the images to the release.
- `ui/`: the web UI, React 19 + Vite + TypeScript, ZEDEDA product UI look
  (purple accent, sidebar, cards, pills; light/dark/system). Built in a Docker
  stage into /app/ui; the sync copies it into www/ (install_ui). Reads
  eve/status.json, eve/activity.json, eve/ui.json (texts in ENI_LANGUAGE; UI
  strings are ui_* keys in app/i18n, all 8 languages). No CDN: offline LANs.
  On the VM's port 8443 it also talks to /api/ (management; texts from
  /api/texts in any of the 8 languages).
- `vm/rootfs/usr/local/lib/eve-netboot/eve_netboot_web.py`: the appliance's
  HTTPS management API (`eve-netboot web`, stdlib only, uses the eve-netboot
  module as `core`). Serves the UI from www/ or, before the stack ran, from
  the copy provision.sh extracted from the image (/usr/local/lib/eve-netboot/ui).
- `tests/`: unittest suite; `tests/fixtures/eve-<tag>/` are the real GRUB files
  of EVE releases.

## Commands

```bash
python3 -m unittest discover -s tests -v
```

```bash
vm/build/build.sh --arch arm64 --version dev --image ghcr.io/michiel-zededa/eve-netboot-installer:latest
```

```bash
cd ui && npm ci && npm run build
```

`ENI_DEV_SERVER=http://<server>:8080 npm run dev` serves the UI with data from
a running server. `build.sh --image-file` bakes a local `docker save | gzip`
image into the VM (testing an unreleased UI or app).

The appliance tests (`tests/test_appliance.py`) need PyYAML for the
#cloud-config cases; without it those are skipped. They also check that
`vm/examples/eve-netboot.env` and `cloud-config.yaml` mention every setting
of `.env.example` and of the appliance: add new settings there too.

CI (`.github/workflows/test.yml`) also runs `ruff check app tests vm`
(config in `ruff.toml`), `shellcheck --severity=warning` on the shell scripts
and the UI type check + build.
`image.yml` builds and pushes the multi-arch image to GHCR.

## Rules

- The generated iPXE script must be ASCII-only. Untrusted text (file names,
  errors) goes through `ipxe_safe()` so it cannot inject `${...}` or new lines.
- Generated files carry no timestamps of their own; they are only rewritten when
  their content changes (`write_if_changed`). Time shown in the menu is the last
  successful GitHub check from `www/eve/sync-state.json`.
- The kernel command line is rebuilt from each ISO's `EFI/BOOT/grub.cfg` and
  `grub_include.cfg` (`build_boot_args`). When EVE changes those files, add the
  new release as a fixture and a test.
- Every installer ISO, `k` included, sets `eve_flavor kvm` in
  `grub_include.cfg`. For local ISOs version and variant come from
  `/etc/eve-release` in the ISO's `rootfs_installer.img` (squashfs, read with
  `unsquashfs`); the file name is only the fallback.
- Keep env var names and the `DATA_DIR` layout backward compatible: existing
  installations update with a `git pull` or a new image.
- Naming: `ENI_*` = EVE-Netboot-Installer itself; `EVE_*` = about EVE-OS
  (EVE_ARCHES, EVE_FLAVOURS, EVE_LTS_LINES, EVE_GITHUB_REPO = which releases
  are mirrored; EVE_DEFAULT_* = defaults of EVE-OS's installation options).
  Nine ENI_ settings were EVE_* before 1.3 (`RENAMED` in eve_sync.py and in
  the appliance); those old names keep working: compose falls back
  (`${ENI_X:-${EVE_X:-default}}`, tested), `_env()` falls back, the
  appliance migrates them. New ENI_ settings need no fallback.
- The repository is generic for any Docker Compose host. No site-specific
  hosts, paths or NAS-specific instructions.
- Web API (eve_netboot_web.py): every change needs the `X-ENI: 1` header
  (CSRF), sessions are HttpOnly+Secure+SameSite=Strict cookies, setup is open
  only until configured. Never name a Handler method like a
  BaseHTTPRequestHandler/StreamRequestHandler one (`setup`, `handle`, `finish`
  ...): `setup()` silently broke every request once.
- Console and web management are functionally equal: the same settings in the
  same groups (`SECTIONS` in eve-netboot == `ui/src/sections.ts`, tested). A
  change in one belongs in the other. The look of the console and the iPXE menu
  follows EVE-OS's own console (black, inverted selection, coloured states).
- Appliance: the console shows only status without login; the menu needs the
  admin password. Without cloud-init settings nothing starts until the setup
  is done. Passwords (ADMIN_PASSWORD, SMB_PASSWORD) are applied and never
  stored; exports never contain secrets. Files from `vm/rootfs` must end up
  owned by root without changing existing directories (tar --no-same-owner
  --no-overwrite-dir). eve-netboot-setup.service must not order itself after
  cloud-final.service (ordering cycle with multi-user.target).

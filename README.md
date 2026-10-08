<div align="center">

# EVE-Netboot-Installer

**Network-install [LF Edge EVE-OS](https://github.com/lf-edge/eve) on bare metal: PXE boot, pick a release, press `i`.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Image](https://github.com/michiel-zededa/eve-netboot-installer/actions/workflows/image.yml/badge.svg)](https://github.com/michiel-zededa/eve-netboot-installer/actions/workflows/image.yml)
[![Tests](https://github.com/michiel-zededa/eve-netboot-installer/actions/workflows/test.yml/badge.svg)](https://github.com/michiel-zededa/eve-netboot-installer/actions/workflows/test.yml)
![Platforms](https://img.shields.io/badge/platform-amd64%20%7C%20arm64-informational)
![Docker Compose](https://img.shields.io/badge/runs%20on-Docker%20Compose-2496ED?logo=docker&logoColor=white)

</div>

EVE-Netboot-Installer is a self-contained PXE boot server for EVE-OS. It runs as a small Docker Compose stack on any Linux host, NAS or VM, including a VM on an EVE edge node.

What it does:

- **Keeps a mirror up to date:** a local mirror of the latest EVE-OS LTS releases.
- **Includes your own builds:** it adds your own installer ISOs, such as controller-specific builds.
- **Serves one boot menu:** everything is offered in a single iPXE menu. No USB sticks, no BMC virtual media, no per-release fiddling.

```text
 LF Edge EVE-OS
 GitHub LTS releases (local mirror, updated 2026-10-05 11:27):
     17.0.6-lts  kvm  (2026-09-18)
     16.0.4-lts  kvm  (2026-08-27)
     14.5.5-lts  kvm  (2026-06-30)
 Local installers (import folder):
     zedcloud-17.0.6-kvm-amd64.iso  (2026-10-03 14:12)
 Options:
     Installation options...  [disk: automatic, reboot: on]
     iPXE shell
     Boot from local disk
     Reboot
     (no key pressed within 300 s: boot from local disk)
```

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Deployment options](#deployment-options)
- [Configuration](#configuration)
- [DHCP](#dhcp)
- [Your own installer ISOs](#your-own-installer-isos)
- [Operation](#operation)
- [Languages](#languages)
- [Security considerations](#security-considerations)
- [Limitations](#limitations)
- [Repository layout](#repository-layout)
- [Contributing](#contributing)
- [License](#license)

## Features

| | |
|---|---|
| **Always current** | Mirrors the newest patch release of the newest *N* EVE-OS **LTS** lines from GitHub, for `amd64`/`arm64` and the `kvm`/`k` variants. It verifies every download against its sha256 and removes releases you no longer need. |
| **Bring your own installer** | Every EVE installer ISO (volume id `EVEISO`) in the import folder appears in the menu within a minute. This includes controller-specific builds with onboarding certificates in `config.img`. |
| **All installer options at boot** | Set them at boot: target disk, persist disk(s), controller (`eve_install_server`), serial console, soft serial, reboot after install, wipe all disks, debug/pause, and extra kernel arguments. Defaults come from `.env`. |
| **Safe by default** | A summary screen requires an explicit **`i`** before installing. Without input, the menu falls back to the local disk after a timeout, so a machine that PXE boots by accident never stalls. |
| **Own iPXE build** | iPXE (x86_64 and arm64 UEFI) is compiled from the official sources during the image build. Only two DHCP options are needed, with no other boot infrastructure. |
| **Status page** | A read-only web page lists every release and local ISO with its architecture, variant, size and checksum state. It is also available as JSON. |
| **Multilingual** | Menu and status page in English, German, French, Spanish, Portuguese, Dutch, Danish and Norwegian. |
| **One `.env` file** | Every setting lives in `.env`. It is portable across plain Docker, NAS compose plugins and VMs. |
| **Ready-made VM** | A VM appliance (qcow2 for amd64/arm64, OVA for VMware) with a setup menu on its screen or settings through cloud-init, automatic security updates and app updates with rollback. |

## How it works

```mermaid
sequenceDiagram
    autonumber
    participant C as PXE client (UEFI)
    participant D as DHCP server
    participant T as tftp (UDP 69)
    participant W as web (HTTP 8080)
    C->>D: DHCP discover
    D-->>C: next-server = SERVER_IP, boot file = eve-x86_64.efi
    C->>T: TFTP eve-x86_64.efi (iPXE + embedded script)
    C->>T: TFTP boot.ipxe
    C->>W: HTTP /eve/eve.ipxe (menu)
    Note over C: choose release, set options, press i
    C->>W: HTTP kernel, initrd, installer.iso
    Note over C: EVE installer runs from RAM and installs to disk
```

The stack consists of one image in three roles:

| Service | Role |
|---|---|
| `sync` | Mirrors GitHub releases, scans the import folder and generates the iPXE menu, the status page and `boot.ipxe`. |
| `tftp` | Serves the iPXE binaries and `boot.ipxe` (host networking, UDP 69). |
| `web` | nginx: menu, kernels, initrds, ISOs and the status page. |

### Why not `sanboot` the ISO?

The EVE installer searches for its ISO again once Linux is running, and a SAN-emulated CD-ROM is gone by then. EVE's own netboot path therefore puts the whole ISO *inside* the initrd and boots with `root=/installer.iso`. EVE-Netboot-Installer reproduces exactly that kernel command line, parsed from each ISO's own `grub.cfg`, and drives it from iPXE.

See [docs/how-it-works.md](docs/how-it-works.md) for the details.

## Requirements

**Host**

- Linux with Docker Engine and the Compose plugin (v2), on amd64 or arm64.
- The TFTP service uses host networking, so Docker Desktop on macOS/Windows is not suitable.

**Ports**

- UDP 69 (TFTP).
- TCP 8080 (HTTP, configurable).

**Disk**

- About 0.5 GB per mirrored `kvm` variant and 0.7 GB per `k` variant.
- The defaults (3 LTS lines, amd64 `kvm`) need about 2 GB.

**DHCP**

- A server on which you can set *next-server* (option 66) and the *boot file name* (option 67).

**Targets**

- UEFI with network boot enabled.
- RAM: the whole installer ISO is loaded into memory, so plan for at least 2 GB (`kvm`) or 8 GB (`k`).

## Quick start

The fastest way, with the prebuilt image. **[docs/deployment.md](docs/deployment.md)** is the full step-by-step guide, with checks after every step and example settings.

Every [release](https://github.com/michiel-zededa/eve-netboot-installer/releases/latest) has `compose.yaml` and `env.example` (all settings, with `EVE_IMAGE` set to that release's image) attached:

```bash
mkdir -p ~/eve-netboot && cd ~/eve-netboot
curl -fsSLO https://github.com/michiel-zededa/eve-netboot-installer/releases/latest/download/compose.yaml
curl -fsSL -o .env https://github.com/michiel-zededa/eve-netboot-installer/releases/latest/download/env.example
```

Edit `.env` and set one line:

```sh
SERVER_IP=192.168.1.10        # this host's LAN address, as the PXE clients see it
```

Start the stack:

```bash
docker compose pull && docker compose up -d
```

Then:

1. **Point DHCP at the host:** next-server = `SERVER_IP`, boot file = `eve-x86_64.efi`. See [docs/dhcp.md](docs/dhcp.md).
2. **Open the status page** at `http://SERVER_IP:8080/` and wait for the first sync to finish.
3. **Boot a machine:** network boot it, pick a release, review the options and press **`i`**.

To build the image yourself instead, clone the repository, leave `EVE_IMAGE` empty and run `docker compose up -d --build` (the first build takes about 5 minutes).

> [!WARNING]
> The EVE installer wipes the target disk without further confirmation. The menu always shows a summary first and only installs after **`i`** is pressed.

## Deployment options

| Platform | Guide |
|---|---|
| **Any hypervisor**: ZEDEDA / EVE-OS, Proxmox, KVM, VMware, ... (easiest, no Linux knowledge needed) | [VM appliance](vm/README.md): download a ready-made VM (qcow2, OVA), start it, answer a few questions on its screen or pass the settings through cloud-init |
| Any Linux host with Docker Compose | [Deployment guide, path A](docs/deployment.md#path-a-linux-host-with-the-docker-compose-command) |
| A NAS or a web UI that runs compose stacks | [Deployment guide, path B](docs/deployment.md#path-b-nas-or-compose-manager-web-ui) |

## Configuration

Everything is configured in `.env`; [.env.example](.env.example) documents every option. The most important ones:

| Variable | Default | Description |
|---|---|---|
| `SERVER_IP` | *(required)* | Address PXE clients use to reach this host |
| `HTTP_PORT` | `8080` | HTTP port for the menu, files and status page |
| `DATA_DIR` | `./data` | Mirror, menu and TFTP files |
| `IMPORT_DIR` | `./import` | Folder scanned for your own installer ISOs |
| `EVE_LANGUAGE` | `en` | `en` `de` `fr` `es` `pt` `nl` `da` `no` |
| `EVE_ARCHES` | `amd64` | `amd64`, `arm64` or both |
| `EVE_FLAVOURS` | `kvm` | `kvm`, `k` or both |
| `EVE_LTS_LINES` | `3` | Number of LTS lines to mirror |
| `EVE_MENU_TIMEOUT` | `300` | Seconds until the menu boots the local disk (`0` = wait) |
| `EVE_MENU_MODE` | `standalone` | `chained` when called from another iPXE menu (exit returns to that menu instead of the local disk) |
| `EVE_DEFAULT_*` | | Default values of the installation options (disk, persist disk, controller, serial console, …) |
| `IPXE_ALIASES_X86_64` | | Extra file names for the iPXE binary, to match a boot file name your DHCP already hands out |
| `EVE_GITHUB_TOKEN` | | Optional; raises the GitHub API rate limit (formerly `GITHUB_TOKEN`) |

Apply changes with `docker compose up -d`. The menu is regenerated on every start. [docs/deployment.md](docs/deployment.md#2-choose-your-settings) has ready-made examples for common setups.

## DHCP

Two options are enough:

| Option | Value |
|---|---|
| 66 / next-server | `SERVER_IP` |
| 67 / boot file | `eve-x86_64.efi` (x86_64 UEFI) or `eve-arm64.efi` (arm64 UEFI) |

[docs/dhcp.md](docs/dhcp.md) has examples for:

- UniFi;
- dnsmasq;
- ISC dhcpd and Kea;
- OPNsense/pfSense;
- MikroTik, including per-architecture boot files.

## Your own installer ISOs

Drop an EVE installer ISO, or an `*installer-net.tar`, anywhere below `IMPORT_DIR`.

- **Detection:** it is recognised by its volume id `EVEISO`; other ISOs in the same folder are ignored.
- **When it appears:** in the menu within about a minute.
- **Changes:** replacing or deleting the file updates the menu as well.
- **Variant:** the variant is derived from the file name: a `k` or `kubevirt` token (for example `installer.k.iso`) means `k`, anything else `kvm`.

## Operation

| Task | Command |
|---|---|
| Follow logs | `docker compose logs -f sync` (or `tftp`, `web`) |
| Check GitHub now | `docker compose restart sync` |
| Update (prebuilt image) | `docker compose pull && docker compose up -d` |
| Update (own build) | `git pull && docker compose up -d --build` |
| Stop | `docker compose down` (data in `DATA_DIR` is kept) |

The status page (`http://SERVER_IP:HTTP_PORT/`) links to the generated menu (`/eve/eve.ipxe`) and a machine-readable `/eve/status.json`.

## Languages

Set `EVE_LANGUAGE` to one of the languages below:

| Code | Language |
|---|---|
| `en` | English |
| `de` | Deutsch |
| `fr` | Français |
| `es` | Español |
| `pt` | Português |
| `nl` | Nederlands |
| `da` | Dansk |
| `no` | Norsk |

How the translations work:

- Translations live in [app/i18n](app/i18n).
- Missing keys fall back to English.
- iPXE menu text is transliterated to ASCII automatically, for example `ä → ae` and `ø → oe`.

**Adding a language:** copy `en.json`, translate the values and open a pull request.

## Security considerations

- **No authentication:**
  - PXE, TFTP and the HTTP mirror are unauthenticated by design. Run the server in a trusted network or VLAN.
  - Installer ISOs in the import folder may contain controller onboarding certificates, and anyone on that network can download them.
- **Disk wiping:**
  - Installing EVE erases disks. Keep network boot below the local disk in the boot order of production machines, or rely on the menu timeout.
  - The stack never installs without an explicit key press.
- **Integrity:** GitHub downloads are checked against the sha256 published with each release.

## Limitations

- **UEFI only:** legacy BIOS PXE is not supported.
- **Boot file per architecture:** a DHCP server that hands out one boot file to all clients gives arm64 machines the x86 binary. Use per-architecture DHCP rules (see [docs/dhcp.md](docs/dhcp.md)).
- **`config.img` overrides:** `grub.cfg` overrides inside an ISO's `config.img` are not applied with this boot method. The `config.img` itself (controller, certificates) is.
- **arm64 testing:** the arm64 path is built and served but has had less hardware testing than amd64.

## Repository layout

```text
.
├── compose.yaml           # the stack (sync, tftp, web)
├── .env.example           # all settings, documented
├── Dockerfile             # multi-stage: iPXE build + runtime image
├── app/
│   ├── eve_sync.py        # mirror, import, menu and status page generator
│   └── i18n/              # translations
├── docker/                # iPXE build script, embedded iPXE script, entrypoint
├── docs/                  # deployment guide, how it works, DHCP configuration
├── tests/                 # unit tests + EVE GRUB fixtures
└── vm/                    # the VM appliance: setup menu, image build, docs
```

## Contributing

Issues and pull requests are welcome. Useful contributions include:

- reports from real hardware (vendor, model, architecture);
- additional DHCP server examples;
- new translations.

Before submitting:

- run the unit tests: `python3 -m unittest discover -s tests` (standard library only, no Docker needed);
- for the VM appliance: build and boot an image (`vm/build/build.sh`, see [vm/README.md](vm/README.md#build-it-yourself));
- keep the generated iPXE script ASCII-only;
- test a boot in a VM (QEMU with OVMF works well).

CI runs the tests, `ruff` and `shellcheck` on every pull request.

## License

Licensed under the [Apache License 2.0](LICENSE).

## Acknowledgements

- [LF Edge EVE-OS](https://github.com/lf-edge/eve): the edge operating system this project installs.
- [iPXE](https://ipxe.org): network boot firmware. It is built from the [official sources](https://github.com/ipxe/ipxe) during the image build and is licensed under GPLv2.

EVE-Netboot-Installer is an independent community project and is not affiliated with or endorsed by LF Edge.

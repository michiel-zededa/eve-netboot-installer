# Deployment guide

This guide takes you from an empty host to a machine installing EVE-OS over
the network. Every step ends with a check, so you know it worked before you
continue.

| Where do you want to run it? | Follow |
|---|---|
| A Linux host with Docker and the `docker compose` command | [Path A](#path-a-linux-host-with-the-docker-compose-command) |
| A NAS or a web UI that manages compose stacks | [Path B](#path-b-nas-or-compose-manager-web-ui) |
| A VM on any hypervisor: ZEDEDA / EVE-OS, Proxmox, KVM, VMware (easiest) | [VM appliance](../vm/README.md): a ready-made VM, no Docker or Linux knowledge needed |

All paths share [Before you start](#1-before-you-start),
[DHCP](#5-point-dhcp-at-the-server) and [First network boot](#6-first-network-boot).

---

## 1. Before you start

Collect these four answers first. You need them in the configuration.

| # | Question | How to find out | Example |
|---|---|---|---|
| 1 | Which IP address do the PXE clients use to reach this host? | `hostname -I` or `ip -4 route get 1.1.1.1` (the address after `src`) | `192.168.1.10` |
| 2 | Is UDP port 69 (TFTP) free? | `sudo ss -lunp \| grep ':69 '` prints nothing | free |
| 3 | Is TCP port 8080 (HTTP) free? | `sudo ss -ltnp \| grep ':8080 '` prints nothing | free, otherwise pick another port |
| 4 | Can you change your DHCP server's *next-server* and *boot file name*? | Router or DHCP server settings | yes |

Also check:

- **The host:** Linux with Docker Engine and the Compose plugin, amd64 or arm64. Docker Desktop on macOS or Windows does not work, because TFTP needs host networking.
- **The address is stable:** the DHCP server will point clients at it. Use a static address or a DHCP reservation for the host.
- **Disk space:** about 2 GB for the defaults, plus about 0.5 GB per extra `kvm` variant and 0.7 GB per `k` variant.
- **The target machines:** UEFI network boot enabled, and at least 2 GB RAM (`kvm`) or 8 GB (`k`), because the whole installer ISO is loaded into memory.

> [!WARNING]
> The EVE installer wipes the target disk. The menu always shows a summary
> and only installs after you press **`i`**, but do not leave network boot as
> the first boot option on machines that hold data you want to keep.

---

## 2. Choose your settings

All settings live in one `.env` file. Only `SERVER_IP` is required; every
other setting has a sensible default. [.env.example](../.env.example)
documents all of them.

Start from the example that is closest to what you want and change the
values marked `# <-`. The lines already exist in `.env.example`; change their
values there, or put them in an empty file (missing lines use the default).
The `# <-` markers only point out what to change; `docker compose` ignores
them, and you can delete them.

### Minimal

```sh
SERVER_IP=192.168.1.10                                           # <- answer 1
EVE_IMAGE=ghcr.io/michiel-zededa/eve-netboot-installer:1.2.1
```

The `env.example` of a release already has `EVE_IMAGE` set to that release's
image; `:latest` instead follows every change on the main branch.

This mirrors the 3 newest EVE-OS LTS lines for amd64 (`kvm`), serves HTTP on
port 8080 and shows the menu in English.

### Typical lab setup

```sh
SERVER_IP=192.168.1.10                                           # <- answer 1
EVE_IMAGE=ghcr.io/michiel-zededa/eve-netboot-installer:1.2.1

# where your own installer ISOs are (for example controller-specific builds)
IMPORT_DIR=/srv/iso/eve                                          # <- your folder
EVE_IMPORT_LABEL=ISO share

# menu language: en de fr es pt nl da no
EVE_LANGUAGE=en                                                  # <-

# pre-fill the installation options (all can still be changed at boot)
EVE_DEFAULT_INSTALL_SERVER=zedcloud.zededa.net                   # <- your controller
EVE_DEFAULT_SERIAL=ttyS0                                         # <- or none
```

### More architectures and variants

```sh
EVE_ARCHES=amd64 arm64        # no quotes needed
EVE_FLAVOURS=kvm k            # k = Kubernetes variant, needs >= 8 GB RAM on the target
EVE_LTS_LINES=2               # fewer lines = less disk space
```

Every combination costs disk space: up to `EVE_LTS_LINES` x arches x
flavours variants, at about 0.5 GB (`kvm`) or 0.7 GB (`k`) each. The example
above is up to 2 x 2 x 2 = 8 variants, about 5 GB. Combinations that a release
does not publish (older releases have no arm64 `k` ISO) are skipped.

### Port 8080 is taken

```sh
HTTP_PORT=8081
```

### Your DHCP server already hands out a boot file name

If DHCP already points at, for example, `ipxe.efi` on this host and you do
not want to touch DHCP:

```sh
IPXE_ALIASES_X86_64=ipxe.efi
```

The iPXE binary is then published under that name too.

### Called from another iPXE menu

```sh
EVE_MENU_MODE=chained         # "exit" returns to the calling menu instead of booting the local disk
```

Chain it from your menu with `chain http://192.168.1.10:8080/eve/eve.ipxe`.

### Prebuilt image or own build?

| | Prebuilt image (recommended) | Own build |
|---|---|---|
| Setting | `EVE_IMAGE=ghcr.io/michiel-zededa/eve-netboot-installer:1.2.1` (already set in a release's `env.example`) | leave `EVE_IMAGE` empty |
| Needs | `compose.yaml` and `.env`, both attached to every release | a clone of this repository |
| First start | about 1 minute | about 5 minutes (iPXE is compiled) |
| Pin a version | `EVE_IMAGE=ghcr.io/michiel-zededa/eve-netboot-installer:1.0.0` | `git checkout v1.0.0` |

Fixed versions are listed on the [releases page](https://github.com/michiel-zededa/eve-netboot-installer/releases).

---

## Path A: Linux host with the `docker compose` command

### 3A. Get the files

**With the prebuilt image**, two files are enough. Every
[release](https://github.com/michiel-zededa/eve-netboot-installer/releases)
has them attached: `compose.yaml` and `env.example` (all settings, with
`EVE_IMAGE` set to that release). These commands fetch them from the newest
release; save `env.example` as `.env`:

```bash
mkdir -p ~/eve-netboot && cd ~/eve-netboot
```

```bash
curl -fsSLO https://github.com/michiel-zededa/eve-netboot-installer/releases/latest/download/compose.yaml
```

```bash
curl -fsSL -o .env https://github.com/michiel-zededa/eve-netboot-installer/releases/latest/download/env.example
```

For a specific version, replace `latest/download` with `download/v1.2.1`
(or another tag).

**For your own build**, clone the repository instead:

```bash
git clone https://github.com/michiel-zededa/eve-netboot-installer.git ~/eve-netboot && cd ~/eve-netboot && cp .env.example .env
```

### 4A. Configure and start

1. Edit `.env` with the values from [step 2](#2-choose-your-settings):

   ```bash
   nano .env
   ```

2. Check that compose reads what you meant. This prints the resolved
   configuration; look at `EVE_BASE_URL`, `image:` and the volume `source:`
   paths:

   ```bash
   docker compose config
   ```

   An error `set SERVER_IP in .env` means `SERVER_IP` is still empty.

3. Start the stack. With the prebuilt image:

   ```bash
   docker compose pull && docker compose up -d
   ```

   For your own build (the first time takes about 5 minutes):

   ```bash
   docker compose up -d --build
   ```

4. **Check:** all three services are `running`:

   ```bash
   docker compose ps
   ```

5. **Check:** the first GitHub sync is running or done. You see
   `GitHub: wanted LTS releases: ...` and, per release, `ready`:

   ```bash
   docker compose logs -f sync
   ```

   The first sync downloads about 0.5 GB per variant; press Ctrl-C to stop
   following the log, the sync continues.

6. **Check:** from another machine in the same network, both protocols answer:

   ```bash
   curl -s http://192.168.1.10:8080/eve/status.json | head
   ```

   ```bash
   curl -s tftp://192.168.1.10/boot.ipxe
   ```

   The second command prints a short script that starts with `#!ipxe`. If it
   times out, a firewall blocks UDP 69 (see [Troubleshooting](#troubleshooting)).

7. Open the status page `http://192.168.1.10:8080/` in a browser. It lists
   every release and local ISO; *ready* means it can be booted.

Continue with [step 5](#5-point-dhcp-at-the-server).

---

## Path B: NAS or compose manager web UI

Web UIs that run compose stacks (NAS compose plugins, Portainer, Dockge and
similar) keep the stack file and its environment in their own folder. The
stack runs there unchanged; the names of buttons differ per product.

### 3B. Prepare folders

Create two folders on the NAS, for example in a shared folder:

| Folder | Purpose | Example |
|---|---|---|
| data | mirror, menu, iPXE files (several GB) | `/srv/data/eve-netboot` |
| import | your own installer ISOs (may be an existing share) | `/srv/iso/eve` |

### 4B. Create the stack

1. **Create a new stack** in the web UI, for example named `eve-netboot`.
2. **Stack file:** paste the contents of `compose.yaml` from the
   [newest release](https://github.com/michiel-zededa/eve-netboot-installer/releases/latest) unchanged.
3. **Environment:** paste the block below and change the values under each
   comment. Use **absolute paths**: relative paths would resolve against the
   UI's own stack folder.

   ```sh
   # the NAS address, as the PXE clients see it
   SERVER_IP=192.168.1.10
   EVE_IMAGE=ghcr.io/michiel-zededa/eve-netboot-installer:1.2.1
   # data folder and import folder from step 3B
   DATA_DIR=/srv/data/eve-netboot
   IMPORT_DIR=/srv/iso/eve
   EVE_IMPORT_LABEL=ISO share
   # change if 8080 is taken
   HTTP_PORT=8080
   ```

   Not every web UI accepts a comment after a value, so keep comments on
   their own line (or leave them out).

   Add any other setting from [step 2](#2-choose-your-settings).
4. **Start** the stack (*Up* / *Deploy*). The UI pulls the image; that takes
   about a minute.
5. **Check:** the stack shows three running containers: `sync`, `tftp` and `web`.
6. **Check:** the log of `sync` shows `GitHub: wanted LTS releases: ...`.
7. **Check:** open `http://192.168.1.10:8080/` in a browser and wait until
   the releases show *ready*.

Points to watch on a NAS:

- **Port 80:** many NAS web interfaces use port 80 themselves; keep `HTTP_PORT` on 8080 or another free port.
- **One TFTP server:** only one service can use UDP 69. Stop any other PXE or TFTP service on the NAS first.
- **Backups:** `DATA_DIR/www/eve/releases` holds the mirrored ISOs. You can exclude it from backups; it is downloaded again automatically.
- **Own build instead of the image:** clone this repository on the NAS, set `EVE_SRC_DIR` to its absolute path and leave `EVE_IMAGE` empty.

---

## 5. Point DHCP at the server

Set two options on the DHCP scope of the network the target machines boot in:

| Option | Value | Example |
|---|---|---|
| next-server / TFTP server (option 66) | `SERVER_IP` | `192.168.1.10` |
| boot file name (option 67) | `eve-x86_64.efi` for x86_64 UEFI, `eve-arm64.efi` for arm64 UEFI | `eve-x86_64.efi` |

For example, with dnsmasq:

```
dhcp-match=set:efi-x86_64,option:client-arch,7
dhcp-match=set:efi-x86_64,option:client-arch,9
dhcp-match=set:efi-arm64,option:client-arch,11
dhcp-boot=tag:efi-x86_64,eve-x86_64.efi,,192.168.1.10
dhcp-boot=tag:efi-arm64,eve-arm64.efi,,192.168.1.10
```

[dhcp.md](dhcp.md) has the settings for UniFi, ISC dhcpd, Kea,
OPNsense/pfSense and MikroTik.

If you only have x86_64 machines, `eve-x86_64.efi` for everyone is fine.

---

## 6. First network boot

1. **On the target machine,** enable UEFI network boot (often called *PXE*,
   *Network Stack* or *IPv4 PXE*) in the firmware setup.
2. **Boot from the network once,** using the one-time boot menu (often F11,
   F12 or Esc) and the *UEFI: IPv4 / PXE* entry for the right network port.
3. You see `EVE-Netboot-Installer (iPXE ...)`, then the EVE menu with the
   releases that match the machine's architecture.
4. **Optional:** open *Installation options...* to set the target disk,
   controller, serial console and so on. The values you set in `.env` are
   already filled in.
5. **Choose a release.** A summary screen shows the source, the options and a
   warning that the disk will be wiped.
6. **Press `i`** to install. Any other key returns to the menu.
7. The machine loads the kernel and the ISO (about 0.5 GB, usually well under a
   minute on a gigabit network), the installer runs and, by default, reboots when done.

Without a key press, the menu boots the local disk after 300 seconds
(`EVE_MENU_TIMEOUT`).

---

## 7. Add your own installer ISOs

1. Copy an EVE installer ISO into `IMPORT_DIR` (any subfolder is fine), for
   example:

   ```bash
   cp zedcloud-17.0.0-kvm-amd64.iso /srv/iso/eve/
   ```

2. **Check:** within about a minute it shows up on the status page and under
   *Local installers* in the menu.

- Only EVE installer ISOs (volume id `EVEISO`) and `*installer-net.tar` files are picked up; other ISOs in the folder are ignored.
- Put `k` or `kubevirt` as a separate word in the file name (`installer.k.iso`, `eve-k-amd64.iso`) for a `k` ISO; the ISO itself cannot tell.
- Replacing or deleting the file updates the menu as well.

---

## 8. Update, roll back, remove

### With the prebuilt image

| Task | Do |
|---|---|
| Update | `docker compose pull && docker compose up -d` (or *Pull* + *Up* in the web UI) |
| Stay on a version | `EVE_IMAGE=ghcr.io/michiel-zededa/eve-netboot-installer:1.0.0` |
| Roll back | set `EVE_IMAGE` to the previous version, then `docker compose up -d` |

### With your own build

| Task | Do |
|---|---|
| Update | `git pull && docker compose up -d --build` |
| Roll back | `git checkout v1.0.0 && docker compose up -d --build` |

### Remove

1. Stop and remove the containers:

   ```bash
   docker compose down
   ```

2. Your files stay where they were. Delete `DATA_DIR` (default `./data`) to
   free the space. `IMPORT_DIR` is only read, never changed.
3. Remove the next-server and boot file name from your DHCP server.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `docker compose config` says `set SERVER_IP in .env` | `SERVER_IP` is empty, or the UI does not use the environment you entered. |
| Client shows *PXE-E32 TFTP open timeout* or similar | DHCP next-server is really `SERVER_IP`; `curl -s tftp://SERVER_IP/boot.ipxe` works from another machine; `docker compose logs tftp` shows the request. A host firewall must allow UDP 69 and the TFTP replies (see [dhcp.md](dhcp.md#troubleshooting)). |
| `tftp` container does not start: *address already in use* | Another TFTP or PXE service uses UDP 69: `sudo ss -lunp \| grep ':69 '`. |
| iPXE starts but says *Could not load tftp://.../boot.ipxe* | `SERVER_IP` is not the address the clients reach. Fix it in `.env` and run `docker compose up -d`. |
| Menu shows *(nothing synchronised yet)* | The first sync is still running or failed: `docker compose logs sync`. The host needs outbound HTTPS to `api.github.com`, `github.com` and `objects.githubusercontent.com`. |
| `GitHub sync failed: HTTP Error 403` or `429` | Many API users behind the same public IP. Set `EVE_GITHUB_TOKEN` in `.env` (fine-grained token without permissions). |
| Target hangs or reboots after *Loading installer ISO* | Not enough RAM: the whole ISO is held in memory. |
| arm64 machine loads the x86 binary | DHCP gives everyone `eve-x86_64.efi`; use per-architecture rules ([step 5](#5-point-dhcp-at-the-server)). |
| Status page not reachable | `HTTP_PORT` is taken or blocked: `docker compose ps` shows the port; try `curl -I http://localhost:8080/` on the host. |

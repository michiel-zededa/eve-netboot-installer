# EVE-Netboot-Installer Debian VM

A ready-to-run Debian virtual machine that hosts the
[EVE-Netboot-Installer](https://github.com/michiel-zededa/eve-netboot-installer) PXE boot server.

- **Where to find it:** this package lives in [`deploy/debian-vm`](.) of the repository. The only file you need is [`user-data.yaml`](user-data.yaml) (raw download: `https://raw.githubusercontent.com/michiel-zededa/eve-netboot-installer/main/deploy/debian-vm/user-data.yaml`).
- **What it is:** a cloud-init configuration (`user-data.yaml`) for a stock Debian "genericcloud" image.
- **First boot:** the VM installs Docker, fetches the EVE-Netboot-Installer source, builds it and starts it as a Docker Compose stack.
- **After that:** it runs unattended, survives reboots and is managed with one command, `eve-netboot`.
- **Where it runs:** written for an **EVE-OS edge node** managed by ZEDEDA (or any other EVE controller). It works the same on any hypervisor with cloud-init: Proxmox, KVM/libvirt, VMware, Hyper-V, OpenStack, ...

> **Why a VM and not a ZEDEDA Compose app?**
> PXE needs TFTP on UDP 69 and a layer-2 presence in the LAN that the target machines boot from.
> A plain VM on a bridged (Switch) network gets exactly that, with standard Docker Compose inside and no platform-specific packaging.

---

## 1. What you get

```
 LAN ─────────────────────────────────────────────────────────────────
   │                                   │
 PXE client                     EVE node ── Switch network instance (bridged to LAN port)
                                       │
                                 Debian VM  "eve-netboot"   (own LAN IP, e.g. 192.168.1.20)
                                   ├─ docker compose: sync · tftp (UDP 69) · web (TCP 8080)
                                   ├─ /opt/eve-netboot            source + .env (generated)
                                   ├─ /srv/eve-netboot/{www,tftp} mirror, menu, iPXE
                                   ├─ /srv/eve-netboot/import     your own installer ISOs
                                   └─ /etc/eve-netboot/settings.env   ← the only file you edit
```

| Path on the VM | Purpose |
|---|---|
| `/etc/eve-netboot/settings.env` | All settings (source, IP, language, what to mirror, …) |
| `/usr/local/sbin/eve-netboot` | Management command |
| `eve-netboot.service` | systemd unit; starts the stack at boot |
| `/opt/eve-netboot` | Application source and the generated `.env` (do not edit `.env` by hand) |
| `/srv/eve-netboot/` | Data: `www` (mirror + menu), `tftp` (iPXE), `import` (your ISOs) |
| `/var/log/eve-netboot.log` | Log of installation and updates |

## 2. Requirements

### Sizing

| Resource | Minimum | Recommended |
|---|---|---|
| vCPU | 1 | 2 (faster first build) |
| RAM | 1 GB | 2 GB |
| Disk | 16 GB | 32 GB; add ~0.7 GB per extra mirrored variant and room for your own ISOs |

- **Architecture:** amd64 or arm64; use the Debian image matching the EVE node.
- **Internet access:** the VM needs outbound HTTPS to:
  - `deb.debian.org`, `download.docker.com`, Docker Hub;
  - `github.com` and `objects.githubusercontent.com` (source and EVE releases).

### Network

- The VM must be **in the same layer-2 network (VLAN)** as the machines that will PXE boot, or a DHCP relay must forward to it.
  - On EVE this means a **Switch** network instance, not a Local (NAT) one.
- The VM needs a **stable IP address**, because the DHCP server will point PXE clients at it. Use a DHCP reservation for the VM's MAC, or a static address.
- **Your DHCP server** must be able to hand out a *next-server* and a *boot file name*.

### Software

- A Debian **12 (bookworm)** or **13 (trixie)** cloud image with cloud-init:
  - amd64: `https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2`
  - arm64: `https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-arm64.qcow2`
- The **generic** (not "nocloud") image is the right one: it contains cloud-init and the virtio drivers EVE uses.

## 3. Prepare `user-data.yaml`

Open `user-data.yaml` and change the places marked **(1)**, **(2)** and **(3)**.

1. **Access**
   - Put your SSH public key under `ssh_authorized_keys`.
   - Change the initial password `ChangeMe-EVE-1`. It must be changed at first login anyway.
   - If you only want key login, remove the `chpasswd` block and set `ssh_pwauth: false`.
2. **`EVE_SOURCE`** (optional)
   - Where the source is fetched from. The default is this repository; change it only for a fork. A git URL or the URL of a `.tar.gz` both work.
   - `EVE_SOURCE_REF` selects a branch or tag; pin a tag for reproducible installs.
3. **Settings:** everything else in the `settings.env` block. The most common ones:

| Setting | Default | Meaning |
|---|---|---|
| `SERVER_IP` | `auto` | IP that PXE clients use. `auto` = the VM's own address, re-detected at each boot |
| `HTTP_PORT` | `8080` | Menu / status page port |
| `EVE_LANGUAGE` | `en` | `en` `de` `fr` `es` `pt` `nl` `da` `no` |
| `EVE_ARCHES` | `amd64` | `amd64`, `arm64` or both |
| `EVE_FLAVOURS` | `kvm` | `kvm`, `k` or both |
| `EVE_LTS_LINES` | `3` | How many EVE LTS lines to mirror |
| `EVE_MENU_TIMEOUT` | `300` | Seconds before the menu boots the local disk |
| `EVE_DEFAULT_SERIAL` | `none` | Default serial console (`ttyS0`, `ttyS1`, `ttyAMA0`) |
| `EVE_DEFAULT_INSTALL_SERVER` | | Default controller, e.g. `zedcloud.zededa.net` |
| `SMB_IMPORT_SHARE` | `no` | `yes` = share the import folder over SMB as `eve-import` |
| `SMB_USER` / `SMB_PASSWORD` | `eve` / – | Credentials of that share (required when enabled) |

**Other application settings:**

- Any other setting from the application's [`.env.example`](../../.env.example) (for example `IPXE_ALIASES_X86_64` or `EVE_DEFAULT_PERSIST_DISK`) can be added to the same block.
- It is passed through to the stack unchanged.
- Settings that only concern the VM (`EVE_SOURCE*`, `SMB_*`) are not passed through.

> **After editing the helper or the service:** if you change anything in `files/`, regenerate the YAML with `python3 build-user-data.py`. Editing `user-data.yaml` directly is fine as well.

## 4. Deploy on an EVE node (ZEDEDA)

The exact names of buttons and fields differ between ZEDEDA releases. The steps describe *what* to configure; look for the closest matching option in your version of the GUI.

1. **Upload the image**
   - *Library → Images → Add*.
   - Type: VM image (qcow2), architecture matching the node.
   - Give it the Debian genericcloud URL above, or upload the downloaded file.
2. **Create a Switch network instance** on the node (or project)
   - *Network instances → Add → Kind: Switch*.
   - Port: the uplink/adapter that is connected to the LAN where the PXE clients are.
   - A Switch instance bridges the VM straight into that LAN: the VM gets its address from your normal DHCP server, and broadcasts/TFTP work.
3. **Create the Edge App** (*Marketplace → Edge Apps → Add*)
   - Deployment type: **VM** (virtualisation mode HVM/full or "fully virtualised" on amd64; default on arm64).
   - Resources: 2 vCPU, 2048 MB RAM.
   - Drive:
     - the Debian image, with a size of **32 GB** (the image itself is only ~3 GB; EVE grows the volume);
     - Debian's cloud-init grows the file system on first boot.
   - Network: one interface (adapter).
   - Custom configuration: enable **cloud-init / custom config** and paste the complete contents of `user-data.yaml`.
4. **Deploy an instance** of the Edge App to the node
   - Attach its interface to the **Switch** network instance from step 2.
   - Note the MAC address shown for the instance, or set a fixed one.
5. **Reserve the address**
   - Make a DHCP reservation for that MAC on your DHCP server, so `SERVER_IP` never changes.
   - Restart the instance if it already obtained another address.

**First boot takes 5–10 minutes:**

- package installation, Docker installation and building the image (iPXE is compiled from source);
- after that, the first GitHub mirror starts. How long it takes depends on the line speed; count about 0.5 GB per `kvm` variant and 0.7 GB per `k` variant.

### Other hypervisors

Any platform that passes cloud-init user data works:

- **Proxmox:**
  - `qm importdisk` the qcow2 into a VM;
  - add a cloud-init drive;
  - put `user-data.yaml` on a snippets storage;
  - `qm set <id> --cicustom user=local:snippets/user-data.yaml`;
  - bridge the NIC to the LAN bridge.
- **libvirt / virt-install:** `virt-install --import --disk debian-13-genericcloud-amd64.qcow2,size=32 --cloud-init user-data=user-data.yaml --network bridge=br0 ...`
- **Plain QEMU:** create a NoCloud seed ISO with `cloud-localds seed.iso user-data.yaml` and attach it as a CD-ROM.

## 5. Point DHCP at the VM

Set these two options on the DHCP scope of the LAN:

| Option | Value |
|---|---|
| next-server / option 66 (TFTP server) | the VM's IP |
| boot file name / option 67 | `eve-x86_64.efi` (amd64 UEFI), `eve-arm64.efi` (arm64 UEFI) |

- **Per-server examples** (UniFi, dnsmasq, ISC, Kea, OPNsense/pfSense, MikroTik) are in [docs/dhcp.md](../../docs/dhcp.md).
- **Existing boot file name:** if your DHCP already hands out another file name, list it in `IPXE_ALIASES_X86_64`. The VM then serves its iPXE under that name as well.

## 6. Verify

1. **Log in:** `ssh eve@<vm-ip>` (or use the console).
2. **Check the stack:** run `sudo eve-netboot status`. All three containers (`sync`, `tftp`, `web`) should be *running*, and the command prints the status-page URL.
3. **Open the status page:** `http://<vm-ip>:8080/`. It lists the mirrored releases (filling up during the first sync) and your local ISOs.
4. **Boot a test machine:** network-boot a UEFI machine, or a VM on the same LAN. You should see "EVE-Netboot-Installer (iPXE …)" followed by the EVE menu.

**If the first boot did not finish,** look at:

- `/var/log/eve-netboot.log` (installation log);
- `/var/log/cloud-init-output.log`;
- `sudo cloud-init status --long`.

## 7. Daily operation

All commands re-run themselves with `sudo` when needed.

| Command | What it does |
|---|---|
| `eve-netboot status` | Containers, IP, URLs, disk usage |
| `eve-netboot logs [sync\|tftp\|web]` | Follow the logs (Ctrl-C to stop) |
| `eve-netboot sync` | Check GitHub for new LTS releases now |
| `eve-netboot config` | Edit `settings.env` in an editor, then apply it (restart) |
| `eve-netboot update` | Fetch the newest source (`EVE_SOURCE_REF`), rebuild and restart |
| `eve-netboot stop` / `start` | Stop / start the stack (same as `systemctl stop/start eve-netboot`) |
| `eve-netboot install` | Re-run the full installation (idempotent) |

### Adding your own installer ISOs

Copy an EVE installer ISO (volume id `EVEISO`, for example a controller-specific build) into `/srv/eve-netboot/import`. It appears in the menu within about a minute.

- **With scp:** `scp my-eve-installer.iso eve@<vm-ip>:/srv/eve-netboot/import/`
  - The folder is writable by the `eve` user.
- **With SMB:**
  - set `SMB_IMPORT_SHARE=yes` and a `SMB_PASSWORD` (via `eve-netboot config`);
  - then use `\\<vm-ip>\eve-import` (Windows) or `smb://<vm-ip>/eve-import` (macOS) with user `SMB_USER`.

Deleting or replacing the file updates the menu as well.

### Changing settings later

1. Run `sudo eve-netboot config`.
2. Change the values and save.
3. The stack is restarted with the new values.

Changing `EVE_ARCHES`, `EVE_FLAVOURS` or `EVE_LTS_LINES` triggers a new sync: new releases are downloaded and ones no longer wanted are removed.

### Backup

- **What to back up:** only `/etc/eve-netboot/settings.env` and your ISOs in `/srv/eve-netboot/import`.
- **Everything else can be rebuilt:** the mirror is downloaded again and the image rebuilt.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| PXE client shows "PXE-E32 TFTP open timeout" or similar | DHCP next-server really is the VM's IP. The VM is on a **Switch** network instance, not NAT. `eve-netboot logs tftp` shows a request. |
| iPXE loads but says *Could not load tftp://…/boot.ipxe* | `SERVER_IP` is wrong or changed. Run `eve-netboot status`. After fixing the reservation, run `eve-netboot start` (re-detects `auto`). |
| Menu is empty | The first sync is still running (`eve-netboot logs sync`). Or the VM has no internet: test with `curl -I https://github.com`. |
| GitHub rate limit in the sync log | Add `EVE_GITHUB_TOKEN=<fine-grained token without permissions>` with `eve-netboot config`. |
| Target hangs or panics after loading the installer | Too little RAM on the target. The whole ISO is held in memory: ~2 GB for `kvm`, ~8 GB for `k`. |
| Installation started but on the wrong disk | Set *Install disk* in the menu, or `EVE_DEFAULT_INSTALL_DISK`. |
| Status page not reachable | `HTTP_PORT` in use or blocked. Check with `curl -I http://localhost:8080/` on the VM. |
| First boot never finished | `sudo cloud-init status --long`, `/var/log/eve-netboot.log`, then `sudo eve-netboot install`. |

## 9. Security notes

- **No authentication:** the menu, the mirrored images and the TFTP server are unauthenticated, as PXE requires.
  - Run the VM only in a trusted network or VLAN.
  - Your own ISOs (which may contain controller onboarding certificates) can be downloaded by anyone on that network.
- **Disk wiping:** the EVE installer wipes disks.
  - The menu always asks for an explicit **i** before installing.
  - Without input, the menu boots the local disk after `EVE_MENU_TIMEOUT` seconds.
  - Still, do not leave PXE as the first boot option on production machines.
- **Access:**
  - Change the initial password, or disable password login.
  - The `eve` user has passwordless sudo; remove that line in `user-data.yaml` if you do not want it.
- **Updates:** keep Debian up to date with `sudo apt update && sudo apt upgrade`, or enable `unattended-upgrades`.

## Files in this package

| File | Purpose |
|---|---|
| `user-data.yaml` | The cloud-init configuration to paste or attach. Self-contained. |
| `files/eve-netboot` | Management command (embedded in `user-data.yaml`) |
| `files/eve-netboot.service` | systemd unit (embedded) |
| `files/settings.env` | Settings template (embedded) |
| `build-user-data.py` | Regenerates `user-data.yaml` from `files/` |

# OpenMediaVault (openmediavault-compose)

OMV's compose plugin stores each stack in its own folder and replaces the
placeholder `CHANGE_TO_COMPOSE_DATA_PATH` with the path of the shared folder
selected as *Data* in *Services → Compose → Settings*. Use it in the stack's
environment so the setup stays portable.

## 1. Put the source on the NAS

The image is built from this repository, so OMV needs a copy of it, e.g. in
the compose data folder:

```sh
cd /srv/<your-data-share>          # the folder behind CHANGE_TO_COMPOSE_DATA_PATH
mkdir -p eve-netboot && cd eve-netboot
git clone https://github.com/michiel-zededa/eve-netboot-installer.git src
```

(If you use a published image instead, skip this and set `EVE_IMAGE`.)

## 2. Create the stack

*Services → Compose → Files → Add*:

- **Name:** `EVE-Netboot-Installer`
- **File:** paste [compose.yaml](../../compose.yaml) unchanged
- **Environment** (*Show environment*): start from [.env.example](../../.env.example);
  the OMV specific lines are:

```
SERVER_IP=192.168.1.10
DATA_DIR=CHANGE_TO_COMPOSE_DATA_PATH/eve-netboot
EVE_SRC_DIR=CHANGE_TO_COMPOSE_DATA_PATH/eve-netboot/src
IMPORT_DIR=/srv/<your-iso-share>
EVE_IMPORT_LABEL=ISO share
```

Save, then **Up**. The first start builds the image (about 5 minutes; the
progress is in the output window).

## 3. Notes

- OMV's own web interface uses port 80; keep `HTTP_PORT` on 8080 or another
  free port.
- Only one TFTP server can use UDP 69. If another PXE stack runs on the same
  NAS, stop it first (*Stop*), then *Up* this one – and the other way round.
  With `IPXE_ALIASES_X86_64` you can publish the iPXE binary under the boot
  file name your DHCP server already uses, so switching needs no DHCP change.
- Updating: `git -C <data>/eve-netboot/src pull`, then in OMV *Up* with
  *Build* (or `docker compose up -d --build` in the stack folder).
- The stack's data folder is included in the compose plugin backup like any
  other; exclude `eve-netboot/www/eve/releases` if you do not want the
  mirrored ISOs in your backups – they are re-downloaded automatically.

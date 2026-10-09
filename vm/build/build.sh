#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Builds the EVE-Netboot-Installer VM appliance from the Debian 13 cloud image.
#
#   vm/build/build.sh --arch amd64|arm64 --version 1.4.1 [options]
#
#   --image REF       container image baked in (default ghcr.io/michiel-zededa/
#                     eve-netboot-installer:<version>)
#   --out DIR         output directory (default dist/)
#   --disk-size SIZE  virtual disk size (default 16G; the VM grows into a
#                     bigger disk by itself)
#   --timeout MIN     give up after MIN minutes (default 90)
#   --image-file F    use this "docker save | gzip" file instead of pulling
#                     --image from the registry (testing unreleased images)
#
# Output (in --out):
#   eve-netboot-<version>-<arch>.qcow2          all architectures
#   eve-netboot-<version>-amd64.vmdk / .ova     amd64 only (VMware)
#   eve-netboot-<version>-<arch>.sha256         checksums
#
# Runs on Linux (KVM when available) and macOS (HVF for the native
# architecture); anything else falls back to slow emulation (TCG).
# Needs: qemu-system-<arch>, qemu-img, python3, curl, tar.
# ---------------------------------------------------------------------------
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
ARCH="" VERSION="" IMAGE="" IMAGE_FILE="" OUT="$REPO/dist" DISK_SIZE=16G TIMEOUT=90
DEBIAN_URL=${DEBIAN_URL:-https://cloud.debian.org/images/cloud/trixie/latest}

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH=$2; shift 2 ;;
    --version) VERSION=$2; shift 2 ;;
    --image) IMAGE=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --disk-size) DISK_SIZE=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --image-file) IMAGE_FILE=$2; shift 2 ;;
    *) sed -n '2,25p' "$0"; exit 2 ;;
  esac
done
case "$ARCH" in amd64|arm64) ;; *) echo "--arch must be amd64 or arm64" >&2; exit 2 ;; esac
[ -n "$VERSION" ] || { echo "--version is required" >&2; exit 2; }
IMAGE=${IMAGE:-ghcr.io/michiel-zededa/eve-netboot-installer:$VERSION}
NAME="eve-netboot-$VERSION-$ARCH"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK="$OUT/.work-$ARCH"
CACHE="$OUT/.cache"
rm -rf "$WORK" && mkdir -p "$WORK/serve" "$CACHE"
log() { echo "[build $ARCH] $*"; }

# ---- tools and acceleration
QEMU=qemu-system-$([ "$ARCH" = amd64 ] && echo x86_64 || echo aarch64)
for t in "$QEMU" qemu-img python3 curl tar; do
  command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }
done
host=$(uname -m); case "$host" in arm64|aarch64) host=arm64 ;; x86_64) host=amd64 ;; esac
ACCEL=tcg CPU=max
if [ "$host" = "$ARCH" ]; then
  if [ -w /dev/kvm ]; then ACCEL=kvm CPU=host
  elif [ "$(uname -s)" = Darwin ]; then ACCEL=hvf CPU=host
  fi
fi
log "qemu $QEMU, acceleration $ACCEL"

# ---- base image, verified against Debian's SHA512SUMS
BASE="debian-13-genericcloud-$ARCH.qcow2"
curl -fsSL --connect-timeout 30 --retry 3 "$DEBIAN_URL/SHA512SUMS" -o "$CACHE/SHA512SUMS"
want=$(awk -v f="$BASE" '$2 == f {print $1}' "$CACHE/SHA512SUMS")
sha512() { if command -v sha512sum >/dev/null; then sha512sum "$1"; else shasum -a 512 "$1"; fi | cut -d' ' -f1; }
if [ ! -f "$CACHE/$BASE" ] || [ "$(sha512 "$CACHE/$BASE")" != "$want" ]; then
  log "downloading $BASE"
  curl -fSL --connect-timeout 30 --retry 3 --speed-limit 10000 --speed-time 60 -s "$DEBIAN_URL/$BASE" -o "$CACHE/$BASE.part"
  [ "$(sha512 "$CACHE/$BASE.part")" = "$want" ] || { echo "sha512 mismatch for $BASE" >&2; exit 1; }
  mv "$CACHE/$BASE.part" "$CACHE/$BASE"
fi
qemu-img convert -O qcow2 "$CACHE/$BASE" "$WORK/disk.qcow2"
qemu-img resize -q "$WORK/disk.qcow2" "$DISK_SIZE"

# ---- payload and NoCloud seed, served over HTTP
mkdir -p "$WORK/payload"
cp -a "$REPO/vm/rootfs" "$WORK/payload/rootfs"
find "$WORK/payload/rootfs" -name '__pycache__' -prune -exec rm -rf {} +
cp "$HERE/provision.sh" "$REPO/compose.yaml" "$WORK/payload/"
[ -z "$IMAGE_FILE" ] || cp "$IMAGE_FILE" "$WORK/payload/image.tar.gz"
tar czf "$WORK/serve/payload.tar.gz" -C "$WORK/payload" .
python3 "$HERE/build_server.py" "$WORK/serve" "$WORK/port" &
SERVER=$!
QPID=""
cleanup() { kill "$SERVER" 2>/dev/null || true; [ -z "$QPID" ] || kill "$QPID" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done
PORT=$(cat "$WORK/port")
sed -e "s|@@PORT@@|$PORT|g" -e "s|@@VERSION@@|$VERSION|g" -e "s|@@IMAGE@@|$IMAGE|g" \
  "$HERE/user-data.in" > "$WORK/serve/user-data"
printf 'instance-id: eve-netboot-build-%s\nlocal-hostname: eve-netboot\n' "$(date +%s)" > "$WORK/serve/meta-data"
: > "$WORK/serve/vendor-data"

# ---- boot it; provisioning powers the VM off when done
# shellcheck disable=SC2054  # commas belong to qemu options
args=(-m 3072 -smp 2 -accel "$ACCEL" -cpu "$CPU"
      -drive "if=virtio,format=qcow2,file=$WORK/disk.qcow2,discard=unmap"
      -netdev user,id=n0 -device virtio-net-pci,netdev=n0,romfile=  # no PXE ROM needed (and not always installed)
      -smbios "type=1,serial=ds=nocloud;s=http://10.0.2.2:$PORT/"
      -display none -serial "file:$WORK/serial.log" -no-reboot)
if [ "$ARCH" = arm64 ]; then
  fw=""
  for f in /usr/share/AAVMF/AAVMF_CODE.fd /usr/share/qemu-efi-aarch64/QEMU_EFI.fd \
           /opt/homebrew/share/qemu/edk2-aarch64-code.fd /usr/local/share/qemu/edk2-aarch64-code.fd \
           /usr/share/qemu/edk2-aarch64-code.fd; do
    [ -f "$f" ] && { fw=$f; break; }
  done
  [ -n "$fw" ] || { echo "no aarch64 UEFI firmware found (install qemu-efi-aarch64)" >&2; exit 1; }
  cp "$fw" "$WORK/code.fd"; truncate -s 64m "$WORK/code.fd"
  truncate -s 64m "$WORK/vars.fd"
  args+=(-machine virt -drive "if=pflash,format=raw,readonly=on,file=$WORK/code.fd"
         -drive "if=pflash,format=raw,file=$WORK/vars.fd")
else
  args+=(-machine q35)
fi
log "provisioning (image $IMAGE) - this takes a while; serial log: $WORK/serial.log"
"$QEMU" "${args[@]}" &
QPID=$!
deadline=$(( $(date +%s) + TIMEOUT * 60 ))
while kill -0 "$QPID" 2>/dev/null; do
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "timeout after $TIMEOUT minutes" >&2; tail -n 40 "$WORK/serial.log" >&2; exit 1
  fi
  sleep 5
done
wait "$QPID" || true
QPID=""
rc=$(cat "$WORK/serve/rc" 2>/dev/null || echo none)
if [ "$rc" != 0 ] || ! grep -q EVE-NETBOOT-PROVISION-OK "$WORK/serve/provision.log"; then
  echo "provisioning failed (rc=$rc)" >&2
  tail -n 60 "$WORK/serve/provision.log" 2>/dev/null >&2 || tail -n 60 "$WORK/serial.log" >&2
  exit 1
fi
cp "$WORK/serve/provision.log" "$OUT/$NAME.provision.log"
log "provisioned"

# ---- output images
log "writing $NAME.qcow2"
qemu-img convert -c -O qcow2 "$WORK/disk.qcow2" "$OUT/$NAME.qcow2"
files=("$NAME.qcow2")
if [ "$ARCH" = amd64 ]; then
  log "writing $NAME.vmdk and $NAME.ova"
  qemu-img convert -O vmdk -o subformat=streamOptimized,adapter_type=lsilogic "$WORK/disk.qcow2" "$OUT/$NAME.vmdk"
  ovadir="$WORK/ova" && mkdir -p "$ovadir"
  cp "$OUT/$NAME.vmdk" "$ovadir/$NAME-disk1.vmdk"
  size=$(wc -c < "$ovadir/$NAME-disk1.vmdk" | tr -d ' ')
  capacity=$(qemu-img info --output=json "$WORK/disk.qcow2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["virtual-size"])')
  sed -e "s|@@NAME@@|$NAME|g" -e "s|@@VERSION@@|$VERSION|g" -e "s|@@DISK@@|$NAME-disk1.vmdk|g" \
      -e "s|@@SIZE@@|$size|g" -e "s|@@CAPACITY@@|$capacity|g" "$HERE/eve-netboot.ovf.in" > "$ovadir/$NAME.ovf"
  sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
  ( cd "$ovadir"
    { echo "SHA256($NAME.ovf)= $(sha256 "$NAME.ovf")"
      echo "SHA256($NAME-disk1.vmdk)= $(sha256 "$NAME-disk1.vmdk")"; } > "$NAME.mf"
    # OVA = tar with the descriptor first
    tar --format=ustar -cf "$OUT/$NAME.ova" "$NAME.ovf" "$NAME.mf" "$NAME-disk1.vmdk" )
  files+=("$NAME.vmdk" "$NAME.ova")
fi
( cd "$OUT"
  if command -v sha256sum >/dev/null; then sha256sum "${files[@]}"; else shasum -a 256 "${files[@]}"; fi > "$NAME.sha256" )
rm -rf "$WORK"
log "done:"
( cd "$OUT" && ls -lh "${files[@]}" "$NAME.sha256" )

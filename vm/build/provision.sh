#!/bin/sh
# ---------------------------------------------------------------------------
# Runs INSIDE the Debian cloud image while the appliance is built (started by
# build.sh through cloud-init). Turns the stock image into the appliance and
# cleans it up so every deployed copy starts fresh.
#
#   provision.sh <payload dir> <version> <image>
# ---------------------------------------------------------------------------
set -eux
PAYLOAD=$1
VERSION=$2
IMAGE=$3
export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"

# ---- packages: the newest Debian updates plus what the appliance needs
# Docker comes from Debian itself (docker.io, docker-compose): within a Debian
# release it only gets fixes, so "apt upgrade" cannot jump to a new major version.
PACKAGES="docker.io docker-cli docker-compose apparmor whiptail nano less curl ca-certificates
  samba qemu-guest-agent unattended-upgrades cloud-guest-utils
  systemd-resolved openssh-server sudo python3 python3-yaml"
ARCH=$(dpkg --print-architecture)
# Debian's standard kernel instead of the cloud kernel: the cloud kernel has no
# graphics console (the setup menu would be invisible on a VNC/VM screen) and
# lacks VMware disk drivers (pvscsi, LSI)
PACKAGES="$PACKAGES linux-image-$ARCH"
if [ "$ARCH" = amd64 ]; then
  PACKAGES="$PACKAGES open-vm-tools"
fi
apt-get update
# shellcheck disable=SC2086
apt-get -y $APT_OPTS full-upgrade
# shellcheck disable=SC2086
apt-get -y $APT_OPTS install --no-install-recommends $PACKAGES
# never let "apt autoremove" take away something the appliance uses
# shellcheck disable=SC2086
apt-mark manual $PACKAGES cloud-init netplan.io >/dev/null
# the cloud kernel is still running; remove it without asking (it is not used after this boot)
cloud_kernels=$(dpkg -l 'linux-image-*cloud*' 2>/dev/null | awk '/^ii/ {print $2}')
if [ -n "$cloud_kernels" ]; then
  echo "linux-base linux-base/removing-running-kernel boolean false" | debconf-set-selections
  # shellcheck disable=SC2086
  apt-get -y purge $cloud_kernels
fi
KVER=""
for d in /lib/modules/*; do case "$d" in *cloud*) ;; *) KVER=${d##*/} ;; esac; done
[ -n "$KVER" ] || { echo "no standard kernel installed" >&2; exit 1; }
echo "kernel: $KVER"
apt-get -y autoremove --purge
systemctl disable smbd nmbd samba-ad-dc 2>/dev/null || true

# ---- the application image, so the first start needs no download
systemctl start docker
docker pull "$IMAGE"

# ---- appliance files
# owned by root; existing directories (/etc, /usr, ...) keep their owner and mode
tar -C "$PAYLOAD/rootfs" -cf - . | tar -C / -xf - --no-same-owner --no-overwrite-dir
for d in / /etc /etc/sudoers.d /etc/systemd/system /usr /usr/local /usr/local/sbin; do
  [ "$(stat -c %u "$d")" = 0 ] || { echo "$d is not owned by root" >&2; exit 1; }
done
chmod 0755 /usr/local/sbin/eve-netboot
chmod 0440 /etc/sudoers.d/eve-netboot
visudo -cf /etc/sudoers.d/eve-netboot
install -d -m 0755 /usr/local/lib/eve-netboot /opt/eve-netboot /etc/eve-netboot /etc/eve-netboot/authorized_keys
install -d -m 0700 /var/lib/eve-netboot
install -d -m 0755 /srv/eve-netboot/www /srv/eve-netboot/tftp /srv/eve-netboot/import
install -m 0644 "$PAYLOAD/compose.yaml" /opt/eve-netboot/compose.yaml
echo "$VERSION" > /usr/local/lib/eve-netboot/VERSION
echo "$IMAGE" > /var/lib/eve-netboot/image
date -u +%Y-%m-%d > /usr/local/lib/eve-netboot/BUILD_DATE

# ---- the admin user (no password until the setup sets one); no other users
if id debian >/dev/null 2>&1; then userdel -r debian; fi
id admin >/dev/null 2>&1 || useradd -m -s /bin/bash -c "EVE-Netboot-Installer admin" -G adm,sudo admin
passwd -l admin
chown admin:admin /srv/eve-netboot/import

# ---- network: systemd-networkd with the appliance's own files (DHCP by default)
rm -f /etc/netplan/*.yaml
systemctl enable systemd-networkd systemd-resolved
ln -sf ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf

# ---- services: setup at boot, the console on tty1 instead of a login prompt
systemctl enable docker eve-netboot-setup.service eve-netboot-console.service
systemctl mask getty@tty1.service
systemctl enable unattended-upgrades
echo eve-netboot > /etc/hostname
printf '127.0.0.1\tlocalhost\n127.0.1.1\teve-netboot\n::1\t\tlocalhost ip6-localhost ip6-loopback\nff02::1\t\tip6-allnodes\nff02::2\t\tip6-allrouters\n' > /etc/hosts

# ---- check the stack definition with the installed compose version
printf 'SERVER_IP=192.0.2.1\nENI_IMAGE=%s\nDATA_DIR=/srv/eve-netboot\nIMPORT_DIR=/srv/eve-netboot/import\n' "$IMAGE" > /tmp/check.env
docker compose --project-directory /opt/eve-netboot --env-file /tmp/check.env config -q
rm -f /tmp/check.env
/usr/local/sbin/eve-netboot help >/dev/null
# no ordering cycles: systemd would silently skip the setup at boot
if systemd-analyze verify --man=no eve-netboot-setup.service eve-netboot-console.service 2>&1 | grep -i cycle; then
  echo "ordering cycle in the eve-netboot units" >&2; exit 1
fi

# ---- for the build log: drivers for the virtual hardware of other hypervisors
for m in virtio_net virtio_blk vmxnet3 vmw_pvscsi mptspi mptsas ahci e1000 e1000e hv_netvsc hv_storvsc; do
  echo "driver $m: $(modinfo -k "$KVER" -n "$m" 2>/dev/null || echo missing)"
done

# ---- clean up: every deployed copy must start as a new machine
apt-get clean
rm -rf /var/lib/apt/lists/*
cloud-init clean --logs --seed
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
rm -rf /var/lib/eve-netboot/userdata.sha256 /etc/eve-netboot/.configured /etc/eve-netboot/settings.env
rm -f /root/.bash_history /home/*/.bash_history /var/log/eve-netboot.log
find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' \) -delete
find /var/log -type f -exec truncate -s 0 {} +
journalctl --rotate --vacuum-time=1s >/dev/null 2>&1 || true
echo "EVE-NETBOOT-PROVISION-OK"

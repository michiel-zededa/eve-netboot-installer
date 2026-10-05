#!/usr/bin/env python3
"""Assembles user-data.yaml from the files in files/ (run after editing them)."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def block(path, indent=6):
    with open(os.path.join(HERE, "files", path)) as f:
        return "".join((" " * indent + line) if line.strip() else "\n" for line in f)


HEADER = """#cloud-config
# ===========================================================================
# EVE-Netboot-Installer Debian VM - cloud-init user data
#
# Use as the cloud-init / custom configuration of a Debian 12 or 13
# "genericcloud" VM. Before deploying, edit the three marked places:
#   1. the SSH key and/or the initial password of user "eve"
#   2. EVE_SOURCE (where the EVE-Netboot-Installer source is fetched from;
#      the default is the official repository)
#   3. any other setting in /etc/eve-netboot/settings.env below
# Everything else is generic. Progress: /var/log/eve-netboot.log
# ===========================================================================
hostname: eve-netboot
manage_etc_hosts: true
timezone: UTC

users:
  - name: eve
    gecos: EVE-Netboot-Installer admin
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: false
    # (1) replace with your own public key, or remove the two lines
    ssh_authorized_keys:
      - ssh-ed25519 AAAA-REPLACE-WITH-YOUR-PUBLIC-KEY you@example

# (1) initial password for console/SSH login; must be changed at first login
chpasswd:
  expire: true
  users:
    - name: eve
      password: ChangeMe-EVE-1
      type: text
ssh_pwauth: true

package_update: true
packages:
  - ca-certificates
  - curl
  - git
  - nano

write_files:
  # (2)(3) settings - editable later with: sudo eve-netboot config
  - path: /etc/eve-netboot/settings.env
    permissions: "0600"
    content: |
{settings}
  - path: /usr/local/sbin/eve-netboot
    permissions: "0755"
    content: |
{helper}
  - path: /etc/systemd/system/eve-netboot.service
    permissions: "0644"
    content: |
{service}
  - path: /etc/motd
    permissions: "0644"
    content: |

      EVE-Netboot-Installer VM
        sudo eve-netboot status    containers, IP, status page URL
        sudo eve-netboot logs      follow the logs
        sudo eve-netboot config    change settings
        sudo eve-netboot update    newest version
      Manual: https://github.com/michiel-zededa/eve-netboot-installer/tree/main/deploy/debian-vm

runcmd:
  - [/usr/local/sbin/eve-netboot, install]

final_message: "EVE-Netboot-Installer VM ready after $UPTIME s - see /var/log/eve-netboot.log"
"""

out = (HEADER.replace("{settings}", block("settings.env").rstrip("\n"))
             .replace("{helper}", block("eve-netboot").rstrip("\n"))
             .replace("{service}", block("eve-netboot.service").rstrip("\n")))
with open(os.path.join(HERE, "user-data.yaml"), "w") as f:
    f.write(out)
print("user-data.yaml written")

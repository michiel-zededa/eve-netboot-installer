# Boot order of the machines you install

How a machine's firmware boot order works together with the network boot
menu, and how to set it up so that a machine boots EVE-OS from its disk
without delay once it is installed.

## What happens at boot

1. The firmware tries its boot entries in the order of its **boot order**.
   An entry that fails hands over to the next one.
2. On a **network boot (PXE over IPv4)** entry, the machine gets this boot
   server's menu.
3. Installing EVE-OS writes it to the disk; the installer then reboots the
   machine, which starts again at step 1.
4. In the menu, **Boot from local disk** (also what the menu does after its
   timeout, `ENI_MENU_TIMEOUT`, 300 seconds by default) does not boot the
   disk itself: it ends the network boot and hands the machine back to its
   firmware, which goes on with the **next entry of the boot order**. iPXE
   cannot start an operating system from a local disk on UEFI; only the
   firmware can.

So which entry comes after network boot decides what happens next. On many
machines and virtual machines, the next entries are **PXE over IPv6** and
**HTTP Boot** (over IPv4, then IPv6). On a network without IPv6 PXE or HTTP
Boot, each of them waits for answers that never come, typically 10 to 60
seconds each, with screens like:

```
>>Start PXE over IPv6.
  PXE-E16: No valid offer received.
>>Start HTTP Boot over IPv4.....
  Error: Could not retrieve NBP file size from HTTP server.
```

Only then does the firmware reach the disk. Nothing is wrong with the
installation; the time is spent in the firmware.

## Choose a boot order

### Disk first (machines in use, recommended)

Put the **disk first** and **network boot (IPv4) second**.

- A machine with an empty disk has nothing to boot there, so the firmware
  goes on to network boot by itself: new machines get the menu without any
  key press.
- Once EVE-OS is installed, the machine boots from its disk at once, also
  after the installer's reboot. Nobody can reinstall it by accident from the
  network.
- To install a machine that already has an operating system, use the
  firmware's **one-time boot menu** (often F11, F12 or Esc at power-on) and
  choose the IPv4 network boot entry.

### Network first (staging bench, frequent reinstalls)

Put **network boot (IPv4) first** and the **disk directly after it**, and
switch off the network boot entries you do not use.

- Every boot shows the menu; without a key press it continues to the disk
  after `ENI_MENU_TIMEOUT` seconds. On a bench, a shorter timeout (for
  example `30`) saves time; `0` waits for a key.
- Switch off **PXE over IPv6** and **HTTP Boot**, or move them below the
  disk. Otherwise every boot from disk first waits for them, as described
  above.

## Where to set it

The names differ per vendor and version; these are the usual places.

| Platform | Boot order | IPv6 PXE and HTTP Boot |
|---|---|---|
| **Physical machine** (UEFI setup, often F2 or Del at power-on) | *Boot* → *Boot Option Priorities* (or *Boot Sequence*): the disk (or *UEFI OS* / its NVMe or SATA entry) first or right after the IPv4 network entry. | Often under *Advanced* → *Network Stack*: *IPv6 PXE Support* and *IPv4 / IPv6 HTTP Support* to *Disabled*. Some vendors set PXE per network port (*IPv4 only*). |
| **Proxmox VE** | VM → *Options* → *Boot Order*, or `qm set <vmid> --boot order='scsi0;net0'` (the disk, then the network card). | The UEFI firmware (OVMF) adds its own IPv6 and HTTP Boot entries after the devices in *Boot Order*; with the disk in that list they come after it. |
| **libvirt / virt-manager / QEMU** | *Boot Options* in virt-manager, or `<boot order='1'/>` on the disk and `<boot order='2'/>` on the interface in the domain XML. | As with Proxmox: OVMF's own entries come after the listed devices. |
| **Hyper-V** (generation 2) | VM → *Settings* → *Firmware*: move *Hard Drive* up, or `Set-VMFirmware -VMName <vm> -FirstBootDevice (Get-VMHardDiskDrive -VMName <vm>)`. | `Set-VMFirmware -VMName <vm> -IPProtocolPreference IPv4` makes network boot use IPv4 only. |
| **VMware ESXi / Workstation** (EFI) | VM → *Edit settings* → *VM Options* → *Boot Options* → *Force EFI setup*, then in the EFI *Boot Maintenance Manager* change the boot order. | Move the IPv6 / HTTP entries below the disk in the same place. |
| **VirtualBox** | *Settings* → *System* → *Boot Order*: *Hard Disk* above *Network*. | Not applicable. |

## Related

- [Deployment guide: first network boot](deployment.md#6-first-network-boot)
- Menu timeout: `ENI_MENU_TIMEOUT` ([configuration](../README.md#configuration))
- Production machines: keep network boot below the disk
  ([security considerations](../README.md#security-considerations)).

# DHCP configuration

PXE clients need two things from DHCP:

| Setting | Value |
|---|---|
| next-server / TFTP server (option 66, `siaddr`) | `SERVER_IP` |
| boot file name (option 67) | `eve-x86_64.efi` (x86_64 UEFI) or `eve-arm64.efi` (arm64 UEFI) |

If your DHCP server can match the client architecture (option 93), hand out
`eve-arm64.efi` to arch `0x000b` and `eve-x86_64.efi` to `0x0007`/`0x0009`.
Otherwise use `eve-x86_64.efi`.

**VM appliance:** instead of changing your DHCP server, the VM can answer the
network boot requests itself, next to your DHCP server (proxyDHCP), or be the
DHCP server of an isolated network. See
[VM appliance: let the VM answer DHCP itself](../vm/README.md#5b-or-let-the-vm-answer-dhcp-itself).

Already using a boot file name for something else and want to switch without
touching DHCP? Set `IPXE_ALIASES_X86_64` (and/or `IPXE_ALIASES_ARM64`) to that
name; the iPXE binary is then also published under it. Make sure only one TFTP
server runs on the host.

## UniFi (Network application)

*Settings → Networks → (your network) → DHCP Service Management*:
enable **Network Boot**, server `SERVER_IP`, file `eve-x86_64.efi`.
Also set **TFTP Server** to `SERVER_IP`.

## dnsmasq

```
dhcp-match=set:efi-x86_64,option:client-arch,7
dhcp-match=set:efi-x86_64,option:client-arch,9
dhcp-match=set:efi-arm64,option:client-arch,11
dhcp-boot=tag:efi-x86_64,eve-x86_64.efi,,SERVER_IP
dhcp-boot=tag:efi-arm64,eve-arm64.efi,,SERVER_IP
```

## ISC dhcpd

```
option arch code 93 = unsigned integer 16;
next-server SERVER_IP;
if option arch = 00:0b { filename "eve-arm64.efi"; }
else                   { filename "eve-x86_64.efi"; }
```

## Kea

```json
"next-server": "SERVER_IP",
"client-classes": [
  { "name": "efi-arm64",  "test": "option[93].hex == 0x000b", "boot-file-name": "eve-arm64.efi" },
  { "name": "efi-x86_64", "test": "option[93].hex == 0x0007 or option[93].hex == 0x0009", "boot-file-name": "eve-x86_64.efi" }
]
```

## OPNsense / pfSense

*Services → DHCPv4 → (interface) → Network booting*: enable, next server
`SERVER_IP`, UEFI 64-bit file name `eve-x86_64.efi` (and the ARM file name
`eve-arm64.efi` where available).

## MikroTik RouterOS

```
/ip dhcp-server network set [find] next-server=SERVER_IP boot-file-name=eve-x86_64.efi
```

## Troubleshooting

- `tftp SERVER_IP -c get boot.ipxe` from another machine must work.
- The `tftp` service logs every request (`docker compose logs -f tftp`).
- Firewalls: allow UDP 69 *and* the ephemeral UDP ports TFTP replies from.

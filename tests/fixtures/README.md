# Test fixtures

`eve-<tag>/EFI/BOOT/` holds the GRUB files exactly as they end up in an EVE
installer ISO, taken from the [lf-edge/eve](https://github.com/lf-edge/eve)
sources at that tag (Apache License 2.0):

| Fixture file | Source in lf-edge/eve |
|---|---|
| `grub.cfg` | `pkg/grub/rootfs.cfg` |
| `grub_include.cfg` | `pkg/eve/installer/grub_installer.cfg` |

The ISO's `boot/cmdline` (the linuxkit command line) is not in the sources,
so the tests write a placeholder one.

To add a release, copy those two files from the new tag and add the tag to
`RELEASES` in `tests/test_eve_sync.py`.

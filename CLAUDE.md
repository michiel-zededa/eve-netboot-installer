# EVE-Netboot-Installer

PXE/iPXE boot server for LF Edge EVE-OS installers, shipped as one Docker image
in three compose roles (`sync`, `tftp`, `web`). See README.md for users and
docs/how-it-works.md for the boot chain.

## Layout

- `app/eve_sync.py`: everything the `sync` role does (GitHub LTS mirror, import
  folder, `eve.ipxe` menu, `boot.ipxe`, status page/JSON). Standard library +
  `bsdtar` only; configuration comes from env vars read at import time.
- `app/i18n/<lang>.json`: menu/status texts, `@@key@@` placeholders in templates.
  `en.json` is the fallback. Files are `indent=1`, `ensure_ascii=False`, no
  trailing newline. Every language must have the same keys as `en.json`.
- `docker/`: iPXE build (from source, x86_64 + arm64 EFI), generic embedded
  script, entrypoint that selects the role.
- `deploy/debian-vm/`: cloud-init VM. `user-data.yaml` is GENERATED from
  `files/` by `build-user-data.py`; edit `files/`, then regenerate.
- `tests/`: unittest suite; `tests/fixtures/eve-<tag>/` are the real GRUB files
  of EVE releases.

## Commands

```bash
python3 -m unittest discover -s tests -v
```

```bash
python3 deploy/debian-vm/build-user-data.py
```

CI (`.github/workflows/test.yml`) also runs `ruff check app tests deploy`
(config in `ruff.toml`) and `shellcheck --severity=warning` on the shell scripts.
`image.yml` builds and pushes the multi-arch image to GHCR.

## Rules

- The generated iPXE script must be ASCII-only. Untrusted text (file names,
  errors) goes through `ipxe_safe()` so it cannot inject `${...}` or new lines.
- Generated files carry no timestamps of their own; they are only rewritten when
  their content changes (`write_if_changed`). Time shown in the menu is the last
  successful GitHub check from `www/eve/sync-state.json`.
- The kernel command line is rebuilt from each ISO's `EFI/BOOT/grub.cfg` and
  `grub_include.cfg` (`build_boot_args`). When EVE changes those files, add the
  new release as a fixture and a test.
- Every installer ISO, `k` included, sets `eve_flavor kvm` in
  `grub_include.cfg`, so the ISO cannot tell the variant; for local ISOs the
  variant comes from the file name.
- Keep env var names and the `DATA_DIR` layout backward compatible: existing
  installations update with a `git pull` or a new image.
- The repository is generic for any Docker Compose host. No site-specific
  hosts, paths or NAS-specific instructions.

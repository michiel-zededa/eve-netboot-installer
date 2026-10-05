#!/bin/sh
# Builds iPXE EFI binaries (x86_64 + arm64) with docker/embed.ipxe embedded.
# Runs in the "ipxe" build stage of the Dockerfile; output goes to /out.
set -eu
IPXE_VERSION="${IPXE_VERSION:-v2.0.0}"
EMBED="${EMBED:-/build/embed.ipxe}"
OUT="${OUT:-/out}"
mkdir -p "$OUT" /build/src

if [ -f /build/ipxe-src.tar.gz ]; then
  echo "Using bundled iPXE source docker/ipxe-src.tar.gz (offline build)"
  tar xzf /build/ipxe-src.tar.gz -C /build/src --strip-components=1
else
  echo "Fetching iPXE ${IPXE_VERSION}..."
  curl -fsSL "https://github.com/ipxe/ipxe/archive/refs/tags/${IPXE_VERSION}.tar.gz" \
    | tar xz -C /build/src --strip-components=1
fi
cd /build/src/src

# a few extra shell commands that are handy for troubleshooting
cat > config/local/general.h <<'H'
#define PING_CMD
#define NSLOOKUP_CMD
#define IPSTAT_CMD
H

# native compiler for the host architecture, cross compiler for the other one
case "$(uname -m)" in
  x86_64)  X86_CROSS="";                     ARM_CROSS="aarch64-linux-gnu-" ;;
  aarch64) X86_CROSS="x86_64-linux-gnu-";    ARM_CROSS="" ;;
  *) echo "unsupported build host $(uname -m)"; exit 1 ;;
esac

J=$(nproc)
echo "Building x86_64 EFI..."
make -s -j"$J" CROSS="$X86_CROSS" bin-x86_64-efi/ipxe.efi EMBED="$EMBED"
echo "Building arm64 EFI..."
make -s -j"$J" CROSS="$ARM_CROSS" bin-arm64-efi/ipxe.efi EMBED="$EMBED"

install -m 0644 bin-x86_64-efi/ipxe.efi "$OUT/eve-x86_64.efi"
install -m 0644 bin-arm64-efi/ipxe.efi  "$OUT/eve-arm64.efi"
echo "${IPXE_VERSION}" > "$OUT/IPXE_VERSION"
ls -la "$OUT"

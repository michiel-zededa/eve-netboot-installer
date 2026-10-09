# ---------------------------------------------------------------------------
# EVE Netboot Installer
#   stage 1 (ipxe): builds iPXE x86_64 + arm64 EFI binaries with a small
#                   generic embedded script (docker/embed.ipxe)
#   stage 2 (ui):   builds the React web UI (ui/) into static files
#   stage 3:        python + bsdtar (sync), tftp-hpa (tftp), nginx (web)
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM debian:stable-slim AS ipxe
ARG IPXE_VERSION=v2.0.0
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      ca-certificates curl make gcc libc6-dev binutils perl liblzma-dev mtools \
      $(case "$(uname -m)" in \
          x86_64)  echo gcc-aarch64-linux-gnu binutils-aarch64-linux-gnu ;; \
          aarch64) echo gcc-x86-64-linux-gnu binutils-x86-64-linux-gnu ;; \
        esac) \
 && rm -rf /var/lib/apt/lists/*
COPY docker/ /build/
RUN IPXE_VERSION="$IPXE_VERSION" sh /build/build-ipxe.sh

# ---- web UI (React + Vite, ui/): built once, static files in the image
FROM --platform=$BUILDPLATFORM node:22-slim AS ui
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
COPY app/i18n/ /src/app/i18n/
RUN npm run build

FROM python:3.13-alpine
ARG ENI_VERSION=dev
ENV ENI_VERSION=$ENI_VERSION
RUN apk add --no-cache libarchive-tools tftp-hpa nginx \
 && rm -f /etc/nginx/http.d/default.conf
COPY --from=ipxe /out/ /opt/ipxe/
COPY app/ /app/
COPY --from=ui /src/ui/dist/ /app/ui/
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh \
 && python3 -m compileall -q /app
LABEL org.opencontainers.image.title="EVE Netboot Installer" \
      org.opencontainers.image.description="PXE/iPXE boot server for LF Edge EVE-OS installers"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sync"]

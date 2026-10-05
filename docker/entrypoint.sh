#!/bin/sh
# One image, three roles:  sync | tftp | web   (selected with the compose "command")
set -eu
role="${1:-sync}"

case "$role" in
  sync)
    exec python3 -u /app/eve_sync.py
    ;;

  tftp)
    # publish the iPXE binaries (plus optional alias names) into the TFTP root
    mkdir -p /tftp
    install -m 0644 /opt/ipxe/eve-x86_64.efi /opt/ipxe/eve-arm64.efi /tftp/
    for name in ${IPXE_ALIASES_X86_64:-}; do install -m 0644 /opt/ipxe/eve-x86_64.efi "/tftp/$name"; done
    for name in ${IPXE_ALIASES_ARM64:-};  do install -m 0644 /opt/ipxe/eve-arm64.efi  "/tftp/$name"; done
    [ -f /tftp/boot.ipxe ] || echo "note: /tftp/boot.ipxe not there yet - the sync service writes it on start"
    echo "iPXE $(cat /opt/ipxe/IPXE_VERSION) published in /tftp; TFTP listening on ${TFTP_LISTEN:-0.0.0.0:69}"
    exec in.tftpd --foreground --verbose --address "${TFTP_LISTEN:-0.0.0.0:69}" --secure /tftp
    ;;

  web)
    cat > /etc/nginx/http.d/default.conf <<'CONF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    root /srv/www;
    sendfile on;
    tcp_nopush on;
    location / {
        autoindex on;
        index index.html;
    }
}
CONF
    exec nginx -g 'daemon off;'
    ;;

  *)
    exec "$@"
    ;;
esac

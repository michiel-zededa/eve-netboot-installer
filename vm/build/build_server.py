#!/usr/bin/env python3
"""
Tiny HTTP server for build.sh, reachable from the build VM as 10.0.2.2:<port>.

  GET  /user-data, /meta-data, /vendor-data   NoCloud seed (cloud-init)
  GET  /payload.tar.gz                        rootfs + provision.sh + compose.yaml
  POST /done?rc=N                             provision log; rc saved to <dir>/rc

Usage: build_server.py <serve dir> <port file>
Prints nothing; writes the chosen port to <port file>.
"""

import http.server
import os
import sys
import urllib.parse

SERVE, PORT_FILE = sys.argv[1], sys.argv[2]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=SERVE, **kw)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != "/done":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        with open(os.path.join(SERVE, "provision.log"), "wb") as f:
            f.write(body)
        rc = urllib.parse.parse_qs(url.query).get("rc", ["?"])[0]
        with open(os.path.join(SERVE, "rc"), "w") as f:
            f.write(rc + "\n")
        self.send_response(200)
        self.end_headers()

    def log_message(self, fmt, *args):
        with open(os.path.join(SERVE, "server.log"), "a") as f:
            f.write(fmt % args + "\n")


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE, "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()

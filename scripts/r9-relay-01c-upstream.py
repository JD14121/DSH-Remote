#!/usr/bin/env python3
"""
R9-RELAY-01C — stand-in upstream behind the approved HTTPS tunnel.

Listens on loopback only. Its purpose is to give the approved proxy a real local target so a
successful registration means the vhost actually forwards to something.
"""

import http.server
import socketserver


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = b'{"fixture":"r9relay01c-upstream","path":"' + self.path.encode() + b'"}\n'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        return


class Server(socketserver.TCPServer):
    # Reuse the address so a restarted fixture is not blocked by a socket in TIME_WAIT.
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", 7444), Handler) as httpd:
        httpd.serve_forever()

#!/usr/bin/env python3
"""
R9-RELAY-02B — synthetic TLS origin standing in for the PC bridge at 127.0.0.1:9446.

Presents its OWN TLS certificate, which is the point: the frps layer must pass application TLS
through untouched, so a client reaching this origin sees THIS certificate and not an frps one.

Logs every request that actually arrives, so "did the request reach the origin?" is answerable
separately from "did the client parse the response?".
"""
import http.server
import socketserver
import ssl

PORT = 9444
MARKER = "SYNTHETIC-ORIGIN-STANDIN"
LOG = open("/work/origin-requests.log", "a", buffering=1)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):  # noqa: N802
        body = b'{"origin":"' + MARKER.encode() + b'","path":"' + self.path.encode() + b'"}\n'
        LOG.write(f"REQ {self.command} {self.path} Host={self.headers.get('Host')}\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()
        LOG.write(f"RESP 200 {len(body)} bytes\n")

    def log_message(self, *args):
        return


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain("/origin/origin.crt", "/origin/origin.key")
    srv = Server(("127.0.0.1", PORT), Handler)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    LOG.write(f"ORIGIN READY on {PORT}\n")
    srv.serve_forever()

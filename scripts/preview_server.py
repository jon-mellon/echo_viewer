"""Serve site/ for local preview, telling the browser never to cache.

Usage: python3 scripts/preview_server.py PORT

Like `python3 -m http.server`, but every response carries
`Cache-Control: no-store`, so a plain reload always picks up edited
JavaScript modules and styles.
"""
import functools
import http.server
import pathlib
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8767
    site = pathlib.Path(__file__).resolve().parent.parent / "site"
    handler = functools.partial(NoCacheHandler, directory=str(site))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()

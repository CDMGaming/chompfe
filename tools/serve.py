"""Local dev server for web/ that tells the browser not to cache anything,
so a reload always picks up changed JS modules.

    python tools/serve.py            (http://localhost:8080)
    python tools/serve.py 9000
"""
import functools
import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    web = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')
    handler = functools.partial(NoCache, directory=web)
    print(f'Chompfe on http://localhost:{port}  (Ctrl+C to stop)')
    class Server(http.server.ThreadingHTTPServer):
        # the default listen backlog of 5 drops connections when the page
        # loads a sample bank in parallel (Windows then retries after ~3-18 s)
        request_queue_size = 128
        daemon_threads = True

    Server(('127.0.0.1', port), handler).serve_forever()

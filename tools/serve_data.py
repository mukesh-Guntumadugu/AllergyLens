#!/usr/bin/env python3
"""Serve the Lens data live from the GX10 (or any box on the same network).

    python3 tools/serve_data.py --port 8787 [--with-lake]

Endpoints (JSON, CORS open, ETag + Cache-Control so a Lens fetches once per change):
    /menus.json     data/menus.json, with data-lake/gold/lens/menus.json merged in (--with-lake)
    /products.json  data/products.json
    /health         {"ok": true, "restaurants": n, "products": n, "version": "..."}

Point the Lens at it: select `AllergyLens` in Lens Studio and set `menusUrl` to
http://<gx10-ip>:8787/menus.json. The Lens validates the shape and falls back to the
bundled data on any failure, so the demo never depends on the network.
No third-party packages; restart-safe; re-reads the files on every request.
"""
import argparse, hashlib, json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WITH_LAKE = False


def load_menus():
    menus = json.load(open(os.path.join(ROOT, "data", "menus.json"), encoding="utf-8"))
    lake = os.path.join(ROOT, "data-lake", "gold", "lens", "menus.json")
    if WITH_LAKE and os.path.exists(lake):
        by_id = {r["id"]: r for r in menus.get("restaurants", [])}
        for r in json.load(open(lake, encoding="utf-8")).get("restaurants", []):
            by_id[r["id"]] = r  # lake entry wins over the seed
        menus["restaurants"] = list(by_id.values())
    menus["served"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return menus


def load_products():
    return json.load(open(os.path.join(ROOT, "data", "products.json"), encoding="utf-8"))


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload, etag=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=60")
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path in ("/menus.json", "/menus"):
                payload = load_menus()
                stable = dict(payload)
                stable.pop("served", None)
            elif path in ("/products.json", "/products"):
                payload = load_products()
                stable = payload
            elif path in ("/health", "/"):
                m, p = load_menus(), load_products()
                self._send(200, {"ok": True, "restaurants": len(m.get("restaurants", [])), "products": len(p.get("products", [])), "withLake": WITH_LAKE})
                return
            else:
                self._send(404, {"error": "not found", "paths": ["/menus.json", "/products.json", "/health"]})
                return
            etag = '"' + hashlib.sha1(json.dumps(stable, sort_keys=True).encode()).hexdigest()[:16] + '"'
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            self._send(200, payload, etag)
        except Exception as e:  # never take the server down for one bad file
            self._send(500, {"error": str(e)})

    do_HEAD = do_GET

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    global WITH_LAKE
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--with-lake", action="store_true", help="merge data-lake/gold/lens/menus.json into /menus.json")
    a = ap.parse_args()
    WITH_LAKE = a.with_lake
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"AllergyLens data server on http://{a.host}:{a.port}  (menus.json, products.json, health; with-lake={WITH_LAKE})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

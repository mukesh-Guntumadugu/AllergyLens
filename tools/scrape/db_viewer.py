#!/usr/bin/env python3
"""Browse the scraper database in a browser: tables on the left, rows on the right, a SQL box on top.

    .venv/bin/python tools/scrape/db_viewer.py            # http://127.0.0.1:8766
    .venv/bin/python tools/scrape/db_viewer.py --rebuild  # rebuild data-lake/silver/allergylens.duckdb first

Read-only. Local only (binds 127.0.0.1). No dependencies beyond duckdb, which build_db.py already needs.
"""
from __future__ import annotations

import argparse
import html
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

REPO = Path(__file__).resolve().parents[2]
DB = REPO / "data-lake" / "silver" / "allergylens.duckdb"
PAGE_SIZE = 200
STALE_AFTER = 15 * 60          # rebuild the database in the background when a page is served and the file is older than this
_rebuild_lock = threading.Lock()
_rebuilding = {"proc": None}


def rebuild(wait: bool) -> None:
    """Rebuild the database from the lake; at most one rebuild at a time. wait=False returns at once."""
    with _rebuild_lock:
        p = _rebuilding["proc"]
        if p is not None and p.poll() is None:
            proc = p
        else:
            proc = subprocess.Popen([sys.executable, str(REPO / "tools/scrape/build_db.py")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            _rebuilding["proc"] = proc
    if wait:
        proc.wait()


def db_age() -> float | None:
    try:
        return time.time() - DB.stat().st_mtime
    except FileNotFoundError:
        return None

PRESETS = {
    "Dishes with ingredients": "SELECT r.name AS restaurant, r.city, d.name_clean AS dish, d.price, d.section_text, "
                               "string_agg(i.ingredient, ', ' ORDER BY i.support DESC) AS ingredients "
                               "FROM menu_dishes d JOIN restaurants r USING (restaurant_id) JOIN dish_ingredients i ON i.dish_id = d.dish_id "
                               "WHERE i.class = 'typical' GROUP BY 1,2,3,4,5 ORDER BY 1,3",
    "Allergen: peanut": "SELECT r.name AS restaurant, r.city, d.name_clean AS dish, i.ingredient FROM menu_dishes d "
                        "JOIN restaurants r USING (restaurant_id) JOIN dish_ingredients i ON i.dish_id = d.dish_id "
                        "WHERE i.ingredient LIKE '%peanut%' ORDER BY 1,3",
    "Allergen: milk": "SELECT r.name AS restaurant, d.name_clean AS dish, i.ingredient FROM menu_dishes d "
                      "JOIN restaurants r USING (restaurant_id) JOIN dish_ingredients i ON i.dish_id = d.dish_id "
                      "WHERE i.ingredient IN ('milk','cream','butter','cheese','yogurt','paneer','ghee','condensed milk','half-and-half') ORDER BY 1,2",
    "Citations for a dish": "SELECT dish_id, ingredient, url FROM ingredient_sources WHERE dish_id = 'hickory smoked baby back ribs' ORDER BY 2",
    "Coverage per restaurant": "SELECT r.name, r.city, r.county, count(*) AS dish_lines, count(d.dish_id) AS with_ingredients "
                               "FROM menu_dishes d JOIN restaurants r USING (restaurant_id) GROUP BY 1,2,3 ORDER BY 4 DESC",
    "Menu images accepted": "SELECT r.name, g.source_type, g.method, g.width, g.height, g.mean_conf, g.price_count FROM menu_gate g "
                            "JOIN restaurants r USING (restaurant_id) WHERE g.verdict = 'menu' ORDER BY 1",
    "Restaurants per county": "SELECT state, county, count(*) AS restaurants, count(website) AS with_website FROM restaurants GROUP BY 1,2 ORDER BY 1,2",
}

STYLE = """<style>
body{font-family:system-ui,sans-serif;margin:0;display:grid;grid-template-columns:230px 1fr;height:100vh}
aside{border-right:1px solid #ddd;padding:12px;overflow:auto;background:#fafafa}aside a{display:block;padding:3px 6px;color:#124;text-decoration:none;border-radius:4px}
aside a.on,aside a:hover{background:#dde8f5}aside h3{margin:12px 0 4px;font-size:12px;color:#666;text-transform:uppercase}
main{padding:12px;overflow:auto}textarea{width:100%;height:70px;font-family:monospace;font-size:13px}
table{border-collapse:collapse;font-size:12px;margin-top:8px}th,td{border:1px solid #ddd;padding:2px 6px;text-align:left;vertical-align:top;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
th{background:#eef;position:sticky;top:0}.meta{color:#666;font-size:12px}.err{color:#b00;white-space:pre-wrap}button{padding:4px 10px}
</style>"""


def connect():
    import duckdb
    return duckdb.connect(str(DB), read_only=True)


def run_sql(sql: str, offset: int):
    con = connect()
    try:
        cur = con.execute(f"SELECT * FROM ({sql.rstrip().rstrip(';')}) AS q LIMIT {PAGE_SIZE} OFFSET {offset}")
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        return cols, rows, None
    except Exception as e:  # show the database's own message
        return [], [], str(e)
    finally:
        con.close()


def tables():
    con = connect()
    try:
        names = [r[0] for r in con.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY 1").fetchall()]
        counts = {}
        for n in names:
            try:
                counts[n] = con.execute(f"SELECT count(*) FROM {n}").fetchone()[0]
            except Exception:
                counts[n] = "?"
        return counts
    finally:
        con.close()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/rebuild":
            rebuild(wait=True)
            self.send_response(302); self.send_header("Location", "/"); self.end_headers(); return
        age = db_age()
        if age is None or age > STALE_AFTER:
            rebuild(wait=age is None)      # no file yet: build it before answering; stale: refresh in the background, serve the old one now
            age = db_age()
        table = q.get("t", [None])[0]
        sql = q.get("sql", [None])[0] or (f"SELECT * FROM {table}" if table else PRESETS["Dishes with ingredients"])
        offset = int(q.get("o", ["0"])[0] or 0)
        cols, rows, err = run_sql(sql, offset)
        counts = tables()
        side = "<h3>Tables</h3>" + "".join(f"<a class='{'on' if t == table else ''}' href='/?t={t}'>{t} <span class=meta>({c})</span></a>" for t, c in counts.items())
        side += "<h3>Questions</h3>" + "".join(f"<a href='/?sql={html.escape(json.dumps(s)[1:-1]).replace('%', '%25').replace('&', '%26').replace('+', '%2B').replace('#', '%23')}'>{html.escape(n)}</a>" for n, s in PRESETS.items())
        p = _rebuilding["proc"]
        busy = " (refreshing now…)" if p is not None and p.poll() is None else ""
        side += (f"<h3>Data</h3><p class=meta>snapshot built {int((age or 0) // 60)} min ago{busy}<br>refreshed on its own when older than {STALE_AFTER // 60} min</p>"
                 f"<a href='/rebuild'>Rebuild from the lake now</a><p class=meta>{DB.relative_to(REPO)}</p>")
        nav = ""
        if offset: nav += f"<a href='/?sql={html.escape(sql)}&o={max(0, offset - PAGE_SIZE)}'>&larr; previous {PAGE_SIZE}</a> &nbsp; "
        if len(rows) == PAGE_SIZE: nav += f"<a href='/?sql={html.escape(sql)}&o={offset + PAGE_SIZE}'>next {PAGE_SIZE} &rarr;</a>"
        body = (f"<form method=get action='/'><textarea name=sql>{html.escape(sql)}</textarea><br><button>Run</button> "
                f"<span class=meta>rows {offset + 1}–{offset + len(rows)} &nbsp; {nav}</span></form>")
        if err:
            body += f"<p class=err>{html.escape(err)}</p>"
        else:
            body += "<table><tr>" + "".join(f"<th>{html.escape(c)}</th>" for c in cols) + "</tr>"
            for r in rows:
                body += "<tr>" + "".join(f"<td title='{html.escape(str(v))}'>{html.escape('' if v is None else str(v))}</td>" for v in r) + "</tr>"
            body += "</table>"
        page = f"<!doctype html><meta charset=utf-8><title>AllergyLens data</title>{STYLE}<aside><b>AllergyLens data</b>{side}</aside><main>{body}</main>"
        data = page.encode()
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--rebuild", action="store_true")
    args = ap.parse_args()
    if args.rebuild or not DB.exists():
        rebuild(wait=True)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), H)
    print(f"AllergyLens data viewer: http://127.0.0.1:{args.port}/  (Ctrl+C to stop)", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""A SQL prompt on the scraper database, in the terminal. Read-only.

    tools/scrape/db.sh                              # interactive: type SQL, end with ; or Enter on one line
    tools/scrape/db.sh "SELECT count(*) FROM restaurants"
    tools/scrape/db.sh --sqlite                     # the SQLite copy instead of DuckDB

Commands inside the prompt: .tables   .schema <table>   .quit
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DUCK = REPO / "data-lake" / "silver" / "allergylens.duckdb"
SQLITE = REPO / "data-lake" / "silver" / "allergylens.sqlite"


def open_db(sqlite: bool):
    if sqlite:
        import sqlite3
        return sqlite3.connect(f"file:{SQLITE}?mode=ro", uri=True), "sqlite"
    import duckdb
    return duckdb.connect(str(DUCK), read_only=True), "duckdb"


def show(con, sql: str, limit: int = 50) -> None:
    cur = con.execute(sql)
    if cur.description is None:
        print("ok"); return
    cols = [d[0] for d in cur.description]
    rows = cur.fetchmany(limit)
    cell = lambda v: ("" if v is None else str(v))[:40]
    widths = [max([len(c)] + [len(cell(r[i])) for r in rows]) for i, c in enumerate(cols)]
    fmt = lambda vals: " | ".join(cell(v).ljust(w) for v, w in zip(vals, widths))
    print(fmt(cols)); print("-+-".join("-" * w for w in widths))
    for r in rows: print(fmt(r))
    more = cur.fetchmany(1)
    print(f"({len(rows)} rows{' shown, more exist: add LIMIT/OFFSET' if more else ''})")


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--sqlite"]
    con, engine = open_db("--sqlite" in sys.argv)
    tables_sql = ("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY 1" if engine == "sqlite"
                  else "SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY 1")
    if args:
        show(con, " ".join(args), limit=10_000); return 0
    try:
        import readline  # noqa: F401  (arrow keys / history in the prompt)
    except ImportError:
        pass
    print(f"{engine}: {DUCK if engine == 'duckdb' else SQLITE}   (.tables  .schema <t>  .quit)")
    buf = ""
    while True:
        try:
            line = input("sql> " if not buf else "...> ")
        except (EOFError, KeyboardInterrupt):
            print(); return 0
        if not buf and line.strip() in (".quit", ".exit", "exit", "quit"): return 0
        if not buf and line.strip() == ".tables":
            for (t,) in con.execute(tables_sql).fetchall():
                n = con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                print(f"  {t:22s} {n}")
            continue
        if not buf and line.strip().startswith(".schema"):
            t = line.split(maxsplit=1)[1] if " " in line.strip() else ""
            if engine == "sqlite":
                for (s,) in con.execute("SELECT sql FROM sqlite_master WHERE name = ?", (t,)).fetchall(): print(s)
            else:
                for c, ty in con.execute("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position", [t]).fetchall(): print(f"  {c:24s} {ty}")
            continue
        buf += ("\n" if buf else "") + line
        if line.rstrip().endswith(";") or not line.strip():
            sql = buf.strip().rstrip(";"); buf = ""
            if not sql: continue
            try: show(con, sql)
            except Exception as e: print(f"error: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

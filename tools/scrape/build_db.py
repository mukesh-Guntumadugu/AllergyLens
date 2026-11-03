#!/usr/bin/env python3
"""Build the SQL database over the lake: one file, the tables of DESIGN.md §12, rebuilt from the
JSON/JSONL the stages write. Run it any time; it is idempotent and takes seconds.

    .venv/bin/python tools/scrape/build_db.py                 # -> data-lake/silver/allergylens.duckdb
    .venv/bin/python tools/scrape/build_db.py --sqlite        # -> data-lake/silver/allergylens.sqlite (any tool can open it)
    .venv/bin/python tools/scrape/build_db.py --query "SELECT name, price FROM menu_items WHERE restaurant_id='starbrick-bbq-nelsonville'"

Tables
  restaurants        one row per place (OpenStreetMap discovery)
  menu_assets        every menu-like thing fetched per restaurant (image / pdf / html-menu / jsonld)
  menu_gate          the verdict per image: menu or not, why, size, OCR confidence
  menu_items         one row per dish line read off a menu (name, price, section, category, position, image, image_verdict)
  menu_dishes        VIEW: menu_items from images the gate accepted -> the table to query for "what does X serve"
  dish_catalog       one row per distinct dish name that was researched
  dish_ingredients   one row per (dish, ingredient): support 0..1, class typical/sometimes
  ingredient_sources one row per (dish, ingredient, recipe URL): the citation
  products           packaged groceries (Open Food Facts) with ingredient text and label photo path
  product_ingredients one row per (barcode, ingredient)
  review_queue       unknown dishes and blocked sources waiting for a human
  bronze_manifest    every raw fetch (hash, url, type, bytes, time)
  crawl_log          one row per crawled site

The JSON files stay the source of truth for the stages; this is the query layer (DuckDB by default,
SQLite with --sqlite). Scraped data never goes to git: the database lives in data-lake/.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LAKE = REPO / "data-lake"


def rows(p: Path):
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []


def j(v):
    return json.dumps(v, ensure_ascii=False) if v is not None else None


TABLES = {
    "restaurants": "restaurant_id TEXT PRIMARY KEY, name TEXT, amenity TEXT, cuisine TEXT, lat DOUBLE, lon DOUBLE, state TEXT, county TEXT, "
                   "address TEXT, city TEXT, postcode TEXT, website TEXT, phone TEXT, source_ids TEXT, discovered_at TEXT",
    "menu_assets": "restaurant_id TEXT, kind TEXT, sha256 TEXT, ext TEXT, url TEXT, page_url TEXT, width INTEGER, height INTEGER, bytes INTEGER, fetched_at TEXT",
    "menu_gate": "sha256 TEXT PRIMARY KEY, restaurant_id TEXT, verdict TEXT, method TEXT, price_count INTEGER, ocr_lines INTEGER, width INTEGER, height INTEGER, "
                 "mean_conf DOUBLE, source_type TEXT, page_url TEXT, judged_at TEXT",
    "menu_items": "restaurant_id TEXT, item_id TEXT, name_raw TEXT, name_clean TEXT, dish_id TEXT, section_text TEXT, category_printed TEXT, markers TEXT, "
                  "price DOUBLE, printed_description TEXT, printed_ingredients TEXT, layout_x DOUBLE, layout_y DOUBLE, layout_w DOUBLE, layout_h DOUBLE, "
                  "asset_sha256 TEXT, image_verdict TEXT, vision_model TEXT, processed_at TEXT",
    "dish_catalog": "dish_id TEXT PRIMARY KEY, canonical_name TEXT, aliases TEXT, cuisine TEXT, status TEXT, recipes_considered INTEGER, recipes_accepted INTEGER, "
                    "seen_count INTEGER, last_seen TEXT, researched_at TEXT, search_engine TEXT",
    "dish_ingredients": "dish_id TEXT, ingredient TEXT, support DOUBLE, class TEXT, n_sources INTEGER",
    "ingredient_sources": "dish_id TEXT, ingredient TEXT, url TEXT",
    "products": "barcode TEXT PRIMARY KEY, name TEXT, brand TEXT, ingredients_text TEXT, allergens TEXT, traces TEXT, sugar_g DOUBLE, trans_fat_g DOUBLE, "
                "saturated_fat_g DOUBLE, sodium_mg DOUBLE, kcal DOUBLE, high_sugar BOOLEAN, trans_fat BOOLEAN, high_sodium BOOLEAN, image_url TEXT, "
                "label_image_url TEXT, label_image_path TEXT, source_url TEXT, collected TEXT",
    "product_ingredients": "barcode TEXT, position INTEGER, ingredient TEXT",
    "review_queue": "kind TEXT, dish TEXT, canonical TEXT, restaurant_id TEXT, source TEXT, detail TEXT, recipes_considered INTEGER, recipes_accepted INTEGER, created_at TEXT",
    "bronze_manifest": "sha256 TEXT, url TEXT, source_type TEXT, content_type TEXT, bytes INTEGER, fetched_at TEXT, http_status INTEGER, ext TEXT",
    "crawl_log": "restaurant_id TEXT, website TEXT, pages INTEGER, kinds TEXT, brand TEXT, chain_of TEXT, finished_at TEXT",
}


def load_all() -> dict[str, list[tuple]]:
    silver, gold = LAKE / "silver", LAKE / "gold"
    out: dict[str, list[tuple]] = {}
    out["restaurants"] = [(r["restaurant_id"], r.get("name"), r.get("amenity"), r.get("cuisine"), r.get("lat"), r.get("lon"), r.get("state"), r.get("county"),
                           r.get("address"), r.get("city"), r.get("postcode"), r.get("website"), r.get("phone"), j(r.get("source_ids")), r.get("discovered_at"))
                          for r in rows(silver / "restaurants.jsonl")]
    out["menu_assets"] = [(a["restaurant_id"], a.get("kind"), a.get("sha256"), a.get("ext"), a.get("url"), a.get("page_url"), a.get("w") or a.get("width"),
                           a.get("h") or a.get("height"), a.get("bytes"), a.get("fetched_at"))
                          for a in rows(silver / "menu_assets.jsonl") + rows(silver / "menu_photos.jsonl")]
    seen = set(); gate = []
    for g in rows(silver / "menu_gate.jsonl"):
        if g["sha256"] in seen: continue
        seen.add(g["sha256"])
        gate.append((g["sha256"], g.get("restaurant_id"), g.get("verdict"), g.get("method"), g.get("price_count"), g.get("ocr_lines"), g.get("w"), g.get("h"),
                     g.get("mean_conf"), g.get("source_type"), g.get("page_url"), g.get("judged_at")))
    out["menu_gate"] = gate
    # dish catalog first, so menu items can point at it by canonical name / alias
    kb_path = gold / "dishes.json"
    kb = json.loads(kb_path.read_text())["dishes"] if kb_path.exists() else []
    by_key: dict[str, str] = {}
    cat, ings, srcs = [], [], []
    for d in kb:
        did = d["name"]
        by_key[d["name"].lower()] = did
        for a in d.get("aliases", []): by_key[a.lower()] = did
        cat.append((did, d["name"], j(d.get("aliases")), d.get("cuisine"), d.get("status"), d.get("recipes_considered"), d.get("recipes_accepted"),
                    d.get("seen_count"), d.get("last_seen"), (d.get("source") or {}).get("collected"), (d.get("source") or {}).get("search")))
        for ing, ev in (d.get("evidence") or {}).items():
            ings.append((did, ing, ev.get("support"), ev.get("class"), len(ev.get("sources") or [])))
            for u in ev.get("sources") or []: srcs.append((did, ing, u))
    out["dish_catalog"], out["dish_ingredients"], out["ingredient_sources"] = cat, ings, srcs
    verdict = {g[0]: g[2] for g in gate}
    latest: dict[tuple, dict] = {}
    for it in rows(silver / "menu_items.jsonl"):          # an image processed twice appends twice: keep the last pass only
        latest[(it["restaurant_id"], it.get("asset_sha256"), it.get("item_id"))] = it
    items = []
    for it in latest.values():
        lay = it.get("layout") or {}
        items.append((it["restaurant_id"], it.get("item_id"), it.get("name_raw"), it.get("name_clean"), by_key.get((it.get("name_clean") or "").lower()),
                      it.get("section_text"), it.get("category_printed"), j(it.get("markers")), it.get("price"), it.get("printed_description"),
                      j(it.get("printed_ingredients")), lay.get("x"), lay.get("y"), lay.get("w"), lay.get("h"), it.get("asset_sha256"),
                      verdict.get(it.get("asset_sha256"), "unjudged"), it.get("vision_model"), it.get("processed_at")))
    out["menu_items"] = items
    pp = gold / "products.json"
    prods = json.loads(pp.read_text()).get("products", []) if pp.exists() else []
    out["products"] = [(p["barcode"], p.get("name"), p.get("brand"), p.get("ingredientsText"), j(p.get("allergens")), j(p.get("traces")),
                        (p.get("nutrition") or {}).get("sugar_g"), (p.get("nutrition") or {}).get("trans_fat_g"), (p.get("nutrition") or {}).get("saturated_fat_g"),
                        (p.get("nutrition") or {}).get("sodium_mg"), (p.get("nutrition") or {}).get("kcal"), (p.get("fitness") or {}).get("highSugar"),
                        (p.get("fitness") or {}).get("transFat"), (p.get("fitness") or {}).get("highSodium"), p.get("image"), p.get("labelImage"),
                        p.get("labelImagePath"), (p.get("source") or {}).get("url"), (p.get("source") or {}).get("collected")) for p in prods]
    out["product_ingredients"] = [(p["barcode"], i, ing) for p in prods for i, ing in enumerate(p.get("ingredients") or [])]
    out["review_queue"] = [(q.get("kind"), q.get("dish"), q.get("canonical"), q.get("restaurant"), q.get("source"), q.get("detail"), q.get("recipes_considered"),
                            q.get("recipes_accepted"), q.get("created_at")) for q in rows(silver / "review_queue.jsonl")]
    out["bronze_manifest"] = [(m.get("sha256"), m.get("url"), m.get("source_type"), m.get("content_type"), m.get("bytes"), m.get("fetched_at"), m.get("http_status"),
                               m.get("ext")) for m in rows(LAKE / "bronze" / "manifest.jsonl")]
    out["crawl_log"] = [(c.get("restaurant_id"), c.get("website"), c.get("pages"), j(c.get("kinds")), c.get("brand"), c.get("chain_of"), c.get("finished_at"))
                        for c in rows(silver / "crawl_log.jsonl")]
    return out


def connect(sqlite: bool, path: Path):
    if sqlite:
        import sqlite3
        return sqlite3.connect(path), "sqlite"
    try:
        import duckdb
        return duckdb.connect(str(path)), "duckdb"
    except ImportError:
        import sqlite3
        return sqlite3.connect(path.with_suffix(".sqlite")), "sqlite"


def write(con, engine: str, data: dict[str, list[tuple]]) -> None:
    for name, cols in TABLES.items():
        con.execute(f"CREATE TABLE {name} ({cols})")
        rows_ = data.get(name, [])
        if not rows_:
            continue
        if engine == "duckdb":
            # bulk load: executemany in duckdb is one prepared statement per row (150k manifest rows took 10+ minutes)
            import csv, tempfile
            with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, newline="", encoding="utf-8") as f:
                w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
                for r in rows_:
                    w.writerow(["" if v is None else (str(v).lower() if isinstance(v, bool) else v) for v in r])
                tmp_csv = f.name
            try:
                con.execute(f"COPY {name} FROM '{tmp_csv}' (FORMAT CSV, HEADER false, NULL '', QUOTE '\"', ESCAPE '\"')")
            finally:
                os.unlink(tmp_csv)
        else:
            n = cols.count(",") + 1
            con.executemany(f"INSERT INTO {name} VALUES ({','.join('?' * n)})", rows_)
    # the view to query: dish lines from images the gate accepts, one row per line
    con.execute("CREATE VIEW menu_dishes AS SELECT * FROM menu_items WHERE image_verdict = 'menu'")
    con.execute("CREATE TABLE build_info (built_at TEXT, engine TEXT)")
    con.execute("INSERT INTO build_info VALUES (?, ?)", (datetime.now(timezone.utc).isoformat(), engine))
    con.commit() if engine == "sqlite" else None
    con.close()


def build(sqlite: bool, path: Path, data: dict[str, list[tuple]]) -> str:
    """Write the database to <path>.building, then swap it in (readers never see a half-written file)."""
    tmp = path.with_name(path.name + ".building")
    for p in (tmp, tmp.with_name(tmp.name + ".wal"), tmp.with_name(tmp.name + "-journal")):
        if p.exists(): p.unlink()
    con, engine = connect(sqlite, tmp)
    write(con, engine, data)
    if path.exists(): path.unlink()
    tmp.rename(path)
    return engine


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sqlite", action="store_true", help="write only the SQLite file (default: DuckDB plus a SQLite copy)")
    ap.add_argument("--no-sqlite", action="store_true", help="skip the SQLite copy")
    ap.add_argument("--out", default=None)
    ap.add_argument("--query", default=None, help="run one SQL statement against the (re)built database and print it")
    args = ap.parse_args()
    data = load_all()
    built = []
    if args.sqlite:
        path = Path(args.out) if args.out else LAKE / "silver" / "allergylens.sqlite"
        built.append((build(True, path, data), path))
    else:
        path = Path(args.out) if args.out else LAKE / "silver" / "allergylens.duckdb"
        built.append((build(False, path, data), path))
        if not args.no_sqlite:   # same tables in SQLite: opens in DB Browser for SQLite, sqlite3, any SQLite client
            sq = path.with_suffix(".sqlite")
            built.append((build(True, sq, data), sq))
    counts = {k: len(v) for k, v in data.items()}
    for engine, p in built:
        print(f"{engine} -> {p.relative_to(REPO) if p.is_relative_to(REPO) else p}: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    if args.query:
        engine, path = built[0]
        con, _ = connect(engine == "sqlite", path)
        cur = con.execute(args.query)
        cols = [d[0] for d in cur.description]
        print(" | ".join(cols))
        for r in cur.fetchall():
            print(" | ".join("" if v is None else str(v) for v in r))
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

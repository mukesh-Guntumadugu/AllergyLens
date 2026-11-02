#!/usr/bin/env python3
"""Run Stage C on every image the gate called a menu, and write gold JSON per restaurant.

Input : data-lake/silver/menu_gate.jsonl (verdict=menu), data-lake/silver/restaurants.jsonl
Output: data-lake/gold/menus/<restaurant_id>.json      one restaurant entry (menus.json shape)
        data-lake/gold/menus.<state>-<county>.json       all of them, {"version":1,"restaurants":[...]}
        data-lake/silver/menu_items.jsonl                one row per dish line (DESIGN.md §12)
Idempotent: an image already processed (same sha256) is skipped unless --force.

Usage:
    .venv/bin/python tools/scrape/process_menus.py [--limit N] [--vision-model auto] [--force]
Then:
    .venv/bin/python tools/scrape/ingredients_rag.py data-lake/gold/menus.oh-athens.json [--cuisine ...]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from label_menu_lines import ask, b64_image, build_entry  # noqa: E402
from ocr_engines import ocr_lines  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:  # one bad image must not stop the county
        return e


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lake", default=str(REPO / "data-lake"))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--vision-model", default="auto")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--state", default="OH"); ap.add_argument("--county", default="Athens")
    ap.add_argument("--workers", type=int, default=int(os.environ.get("PROCESS_WORKERS", "8")), help="images labelled concurrently (vLLM batches them; use 1 for Ollama); env PROCESS_WORKERS")
    args = ap.parse_args()
    lake = Path(args.lake); silver, gold = lake / "silver", lake / "gold" / "menus"
    gold.mkdir(parents=True, exist_ok=True)
    restaurants = {json.loads(l)["restaurant_id"]: json.loads(l) for l in (silver / "restaurants.jsonl").read_text().splitlines() if l.strip()}
    gate = [json.loads(l) for l in (silver / "menu_gate.jsonl").read_text().splitlines() if l.strip()]
    menus = [g for g in gate if g["verdict"] == "menu"]
    items_path = silver / "menu_items.jsonl"
    done = {json.loads(l)["asset_sha256"] for l in items_path.read_text().splitlines() if l.strip()} if items_path.exists() and not args.force else set()
    todo = [g for g in menus if g["sha256"] not in done][: args.limit or None]
    print(f"{len(menus)} menu images, {len(todo)} to process, {args.workers} at a time")
    lock = threading.Lock()

    def extract(g):
        path = lake / "bronze" / "assets" / g["sha256"][:2] / f"{g['sha256']}.{g.get('ext', 'jpg')}"
        t = time.time()
        lines, (W, H) = ocr_lines(path)
        labels, used = ask(args.vision_model, b64_image(path), lines)
        return g, path, lines, W, H, labels, used, time.time() - t

    # results are written AS EACH IMAGE FINISHES (not at the end), so gold/ fills up while the run is going
    pool = ThreadPoolExecutor(max_workers=max(1, args.workers))
    futures = [pool.submit(_safe, extract, g) for g in todo]
    for i, fut in enumerate(as_completed(futures)):
        res = fut.result()
        if isinstance(res, Exception) or res is None:
            print(f"  [{i + 1}/{len(todo)}] FAILED {res.__class__.__name__}: {str(res)[:100]}", flush=True); continue
        g, path, lines, W, H, labels, used, dt = res
        rid = g["restaurant_id"]; r = restaurants.get(rid, {"name": rid})
        entry = build_entry(lines, labels.get("lines", []), W, H, rid, r["name"], path, used, "rapidocr", 29.7)
        entry["source"] = {"type": g.get("source_type", "website"), "url": g.get("page_url"), "collected": datetime.now(timezone.utc).date().isoformat()}
        entry["cuisine"] = r.get("cuisine")   # OSM tag, e.g. "indian", "mexican"; search hint for ingredients_rag
        # merge with an existing gold file for this restaurant (several menu pages)
        gp = gold / f"{rid}.json"
        if gp.exists() and not args.force:
            prev = json.loads(gp.read_text())
            seen = {d["name"].lower() for d in prev["dishes"]}
            prev["dishes"].extend(d for d in entry["dishes"] if d["name"].lower() not in seen)
            prev.setdefault("menuImages", []).append(entry["menuImage"])
            entry = prev
        else:
            entry["menuImages"] = [entry["menuImage"]]
        gp.write_text(json.dumps(entry, indent=2, ensure_ascii=False) + "\n")
        with items_path.open("a") as f:
            for n, d in enumerate(entry["dishes"]):
                f.write(json.dumps({"restaurant_id": rid, "item_id": d["id"], "name_raw": d["ocr"], "name_clean": d["name"], "section_text": d.get("section_text"),
                                    "category_printed": d.get("category_printed"), "markers": d.get("markers", []), "price": d.get("price"),
                                    "printed_description": d.get("notes"), "printed_ingredients": d.get("ingredients"), "layout": d["layout"],
                                    "asset_sha256": g["sha256"], "vision_model": used, "processed_at": datetime.now(timezone.utc).isoformat()}) + "\n")
        print(f"  [{i + 1}/{len(todo)}] {rid}: {len(entry['dishes'])} dishes ({len(lines)} OCR lines, {used}, {dt:.0f}s)", flush=True)
    pool.shutdown(wait=True)
    # county file in the menus.json shape: only this county's restaurants (the per-restaurant gold files hold every county)
    allr = [json.loads(p.read_text()) for p in sorted(gold.glob("*.json"))]
    where = {}
    rpath = lake / "silver" / "restaurants.jsonl"
    if rpath.exists():
        for l in rpath.read_text().splitlines():
            if l.strip():
                r = json.loads(l); where[r["restaurant_id"]] = (r.get("state"), (r.get("county") or "").lower())
    allr = [e for e in allr if where.get(e.get("id") or e.get("restaurant_id"), (args.state, args.county.lower())) == (args.state, args.county.lower())]
    county = lake / "gold" / f"menus.{args.state.lower()}-{args.county.lower()}.json"
    county.write_text(json.dumps({"version": 1, "restaurants": allr}, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(allr)} restaurants with menus -> {county}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

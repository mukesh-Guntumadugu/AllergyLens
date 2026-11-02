#!/usr/bin/env python3
"""Rebuild data-lake/gold/menus/<restaurant>.json from the per-line extraction table, without
re-running the vision model.

Why: gate rules and junk-name rules change; the expensive part (OCR + vision labels) is already
stored per line in data-lake/silver/menu_items.jsonl with the image it came from. This script keeps
only lines whose image the gate currently calls a menu and whose name passes text_quality, and
writes fresh gold entries plus the per-county files.

    .venv/bin/python tools/scrape/rebuild_gold.py
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from text_quality import is_junk_name  # noqa: E402
from label_menu_lines import slug  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


def rows(p: Path):
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []


def main() -> int:
    lake = REPO / "data-lake"; silver = lake / "silver"; gold = lake / "gold" / "menus"
    gold.mkdir(parents=True, exist_ok=True)
    restaurants = {r["restaurant_id"]: r for r in rows(silver / "restaurants.jsonl")}
    gate = {g["sha256"]: g for g in rows(silver / "menu_gate.jsonl")}
    items = rows(silver / "menu_items.jsonl")
    by_rest: dict[str, list] = defaultdict(list)
    dropped_image = dropped_name = 0
    for it in items:
        g = gate.get(it["asset_sha256"])
        if not g or g["verdict"] != "menu":
            dropped_image += 1; continue
        if is_junk_name(it["name_clean"]):
            dropped_name += 1; continue
        by_rest[it["restaurant_id"]].append((it, g))
    for old in gold.glob("*.json"):
        old.unlink()
    written = 0
    for rid, pairs in sorted(by_rest.items()):
        r = restaurants.get(rid, {"name": rid})
        dishes, seen, images = [], set(), []
        for it, g in pairs:
            key = it["name_clean"].lower()
            if key in seen:
                continue
            seen.add(key)
            img = lake / "bronze" / "assets" / g["sha256"][:2] / f"{g['sha256']}.{g.get('ext', 'jpg')}"
            mi = {"path": str(img), "widthPx": g.get("w"), "heightPx": g.get("h"), "widthCm": 29.7}
            if mi not in images:
                images.append(mi)
            dishes.append({"id": slug(it["name_clean"]), "name": it["name_clean"], "ingredients": it.get("printed_ingredients"), "removable": [],
                           "price": it.get("price"), "section_text": it.get("section_text"), "category_printed": it.get("category_printed") or "unknown",
                           "markers": it.get("markers") or [], "layout": it["layout"], "ocr": it.get("name_raw"),
                           **({"notes": it["printed_description"]} if it.get("printed_description") else {})})
        if not dishes:
            continue
        entry = {"id": rid, "name": r["name"], "source": {"type": pairs[0][1].get("source_type", "website"), "url": pairs[0][1].get("page_url"),
                                                           "collected": date.today().isoformat()},
                 "rating": None, "cuisine": r.get("cuisine"), "menuImage": images[0], "menuImages": images,
                 "extraction": {"ocr_engine": "rapidocr", "vision_model": pairs[0][0].get("vision_model"), "rebuilt": date.today().isoformat()},
                 "dishes": dishes}
        (gold / f"{rid}.json").write_text(json.dumps(entry, indent=2, ensure_ascii=False) + "\n")
        written += 1
    # per-county files
    by_county: dict[tuple, list] = defaultdict(list)
    for p in sorted(gold.glob("*.json")):
        e = json.loads(p.read_text()); r = restaurants.get(e["id"])
        if r:
            by_county[(r["state"].lower(), r["county"].lower().replace(" ", "-"))].append(e)
    for (st, co), entries in by_county.items():
        (lake / "gold" / f"menus.{st}-{co}.json").write_text(json.dumps({"version": 1, "restaurants": entries}, indent=2, ensure_ascii=False) + "\n")
    print(f"{written} restaurants rebuilt from {len(items)} lines; dropped {dropped_image} lines from images no longer judged menus, "
          f"{dropped_name} junk names; county files: {sorted(f'{s}-{c}' for s, c in by_county)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

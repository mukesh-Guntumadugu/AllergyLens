#!/usr/bin/env python3
"""Merge extracted restaurant entries (gold) into the LOCAL Lens snapshot data-lake/gold/lens/menus.json.
Scraped data never goes into data/ (committed, hand-curated seed) and so never into GitHub.

Input : data-lake/gold/menus/*.json  (or files given on the command line, e.g. a .labelled.json)
Output: data-lake/gold/lens/menus.json with those restaurants replaced/added; their menu images copied to
        data-lake/gold/lens/menus/<restaurant_id>/menu-<n>.<ext>. build-data.js --with-lake joins it with the seed.

Maps the extraction's printed category to the Lens' DishCategory (chicken | red_meat | seafood |
vegetarian | dessert | drink | unknown) via CATEGORY_MAP; keeps price, section, markers, layout,
printed ingredients and description. Dish ids are made unique per restaurant.

    .venv/bin/python tools/scrape/merge_gold.py                       # all of data-lake/gold/menus
    .venv/bin/python tools/scrape/merge_gold.py data-lake/silver/star-of-india.menu-1.labelled.v2.json
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LENS_DIR = REPO / "data-lake" / "gold" / "lens"          # local only (data-lake/ is gitignored)
CATEGORY_MAP = {"veg": "vegetarian", "vegan": "vegetarian", "bread": "vegetarian", "rice": "vegetarian", "soup_salad": "vegetarian",
                "side": "vegetarian", "chicken": "chicken", "mutton": "red_meat", "beef": "red_meat", "pork": "red_meat",
                "seafood": "seafood", "dessert": "dessert", "soft_drink": "drink", "alcohol": "drink", "egg": "unknown", "kids": "unknown"}
ICON_BY_CAT = {"vegetarian": "rice_bowl", "chicken": "set_meal", "red_meat": "lunch_dining", "seafood": "set_meal", "dessert": "cake", "drink": "local_pizza"}


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "dish"


from text_quality import is_junk_name  # noqa: E402


def convert(entry: dict) -> dict:
    rid = entry["id"]
    img_dir = LENS_DIR / "menus" / rid; img_dir.mkdir(parents=True, exist_ok=True)
    images = entry.get("menuImages") or ([entry["menuImage"]] if entry.get("menuImage") else [])
    menu_image = None
    for n, mi in enumerate(images, 1):
        src = Path(mi["path"]) if Path(mi["path"]).is_absolute() else REPO / mi["path"]
        if not src.exists():
            continue
        dst = img_dir / f"menu-{n}{src.suffix.lower().replace('.jpeg', '.jpg')}"
        if src.resolve() != dst.resolve() and (not dst.exists() or dst.stat().st_size != src.stat().st_size):
            shutil.copyfile(src, dst)
        rel = str(dst.relative_to(REPO))
        if menu_image is None:
            menu_image = {**mi, "path": rel}
    dishes, seen = [], set()
    for d in entry["dishes"]:
        if is_junk_name(d["name"], d.get("ocr_conf")):
            continue
        did = slug(d["name"]); k = did
        while k in seen:
            k = f"{did}-{len(seen)}"
        seen.add(k)
        cat = CATEGORY_MAP.get(d.get("category_printed", "unknown"), None)
        price = d.get("price")
        price = float(price) if isinstance(price, (int, float)) and 0 < price <= 500 else None   # Lens validation range
        out = {"id": k, "name": d["name"], "icon": ICON_BY_CAT.get(cat or "", "set_meal"),
               "ingredients": d.get("ingredients") or None, "removable": d.get("removable") or [],
               "price": price, "section": d.get("section_text"), "markers": d.get("markers") or []}
        if cat and cat != "unknown":
            out["category"] = cat
        if d.get("layout"):
            out["layout"] = d["layout"]
        if d.get("notes"):
            out["notes"] = d["notes"]
        dishes.append(out)
    return {"id": rid, "name": entry["name"], "source": entry.get("source") or {"type": "photo", "url": None, "collected": date.today().isoformat()},
            "cuisine": entry.get("cuisine"), "rating": entry.get("rating"), "menuImage": menu_image,
            "extraction": entry.get("extraction"), "dishes": dishes}


def main() -> int:
    files = [Path(a) for a in sys.argv[1:]] or sorted((REPO / "data-lake" / "gold" / "menus").glob("*.json"))
    LENS_DIR.mkdir(parents=True, exist_ok=True)
    menus_path = LENS_DIR / "menus.json"
    seed = json.loads((REPO / "data" / "menus.json").read_text())
    menus = json.loads(menus_path.read_text()) if menus_path.exists() else {"version": seed.get("version", 1), "restaurants": []}
    by_id = {r["id"]: r for r in menus["restaurants"]}
    for f in files:
        e = json.loads(f.read_text())
        if not e.get("dishes"):
            print(f"  skip {f.name}: no dishes"); continue
        r = convert(e)
        action = "replaced" if r["id"] in by_id else "added"
        by_id[r["id"]] = r
        print(f"  {action} {r['id']}: {len(r['dishes'])} dishes, image {r['menuImage']['path'] if r['menuImage'] else '-'}")
    menus["restaurants"] = [by_id[k] for k in by_id]
    menus_path.write_text(json.dumps(menus, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(menus['restaurants'])} scraped restaurants in {menus_path.relative_to(REPO)} (local, not committed). "
          f"Next: ingredients_rag.py {menus_path.relative_to(REPO)}; node tools/build-data.js --with-lake")
    return 0


if __name__ == "__main__":
    sys.exit(main())

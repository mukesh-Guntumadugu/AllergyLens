#!/usr/bin/env python3
"""Pipeline 2: packaged grocery products (Walmart / Target / any store).

Pulls ingredient lists, allergen tags and nutrition for packaged foods from
Open Food Facts (open data, 3M+ products, free API, attribution required)
and writes data/products.json for the Lens. Runs on the scraping machine.

Three ways to feed it:
  --barcode 0049000028911 ...          exact products (scan them in the store)
  --search "peanut butter" --n 40      text search
  --category snacks --n 200            whole category (en:snacks, en:cookies, ...)
  --file barcodes.txt                  one barcode or search term per line

Setup once:
    pip install requests

Usage:
    python3 tools/scrape/fetch_products.py --search "peanut butter cookies" --n 25
    python3 tools/scrape/fetch_products.py --barcode 0049000028911 0037600112949
    python3 tools/scrape/fetch_products.py --category en:breakfast-cereals --n 100 --country united-states

Output entry (merged into data/products.json by barcode):
    {
      "barcode": "0049000028911",
      "name": "Jif Creamy Peanut Butter",
      "brand": "Jif",
      "ingredients": ["roasted peanuts", "sugar", "molasses", "fully hydrogenated vegetable oils", "salt"],
      "allergens": ["peanuts"],                 # OFF's own allergen tags, cleaned
      "traces": ["tree nuts"],                  # "may contain"
      "nutrition": {"sugar_g": 6, "trans_fat_g": 0, "saturated_fat_g": 3, "sodium_mg": 140, "kcal": 190},
      "fitness": {"highSugar": false, "transFat": false, "highSodium": false},
      "image": "https://images.openfoodfacts.org/...",
      "source": {"type": "openfoodfacts", "url": "https://world.openfoodfacts.org/product/0049000028911", "collected": "2026-11-02"}
    }

Open Food Facts data is ODbL-licensed: keep the attribution ("Data from Open
Food Facts, https://openfoodfacts.org") in the app/README. Don't hammer the
API: this script sleeps between requests.
"""

import argparse
import json
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests

UA = {"User-Agent": "AllergyLens/0.1 (hackathon project; github.com/mukesh-Guntumadugu/AllergyLens)"}
PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product/{barcode}.json"
SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl"
FIELDS = "code,product_name,brands,ingredients_text,ingredients,allergens_tags,traces_tags,nutriments,image_front_url,image_ingredients_url,countries_tags,last_modified_t"
BRONZE = Path(__file__).resolve().parents[2] / "data-lake" / "bronze" / "products"   # label photos, by barcode

# per 100 g thresholds (FDA "high" ≈ 20 % DV; sugar per WHO guidance)
HIGH_SUGAR_G = 15.0
HIGH_SODIUM_MG = 480.0
TRANS_FAT_G = 0.5


def clean_tag(tag: str) -> str:
    return re.sub(r"^[a-z]{2}:", "", tag).replace("-", " ").strip()


def normalize(p: dict) -> dict | None:
    code = p.get("code")
    name = (p.get("product_name") or "").strip()
    if not code or not name:
        return None
    ings = [i.get("text", "").strip().lower().strip(".,;") for i in (p.get("ingredients") or []) if i.get("text")]
    if not ings and p.get("ingredients_text"):
        ings = [s.strip().lower() for s in re.split(r"[,;()]", p["ingredients_text"]) if s.strip()]
    n = p.get("nutriments") or {}

    def g(key):
        v = n.get(key)
        try:
            return round(float(v), 2) if v is not None else None
        except (TypeError, ValueError):
            return None

    sugar, trans, sat, sodium_g, kcal = g("sugars_100g"), g("trans-fat_100g"), g("saturated-fat_100g"), g("sodium_100g"), g("energy-kcal_100g")
    sodium_mg = round(sodium_g * 1000) if sodium_g is not None else None
    return {
        "barcode": code,
        "name": name,
        "brand": (p.get("brands") or "").split(",")[0].strip() or None,
        "ingredients": ings or None,
        "allergens": sorted({clean_tag(t) for t in p.get("allergens_tags") or []}),
        "traces": sorted({clean_tag(t) for t in p.get("traces_tags") or []}),
        "nutrition": {"sugar_g": sugar, "trans_fat_g": trans, "saturated_fat_g": sat, "sodium_mg": sodium_mg, "kcal": kcal},
        "fitness": {
            "highSugar": sugar is not None and sugar >= HIGH_SUGAR_G,
            "transFat": trans is not None and trans >= TRANS_FAT_G,
            "highSodium": sodium_mg is not None and sodium_mg >= HIGH_SODIUM_MG,
        },
        "image": p.get("image_front_url"),
        # the photo of the printed ingredient list on the pack: the evidence behind "ingredients" (OFF transcribes from it)
        "labelImage": p.get("image_ingredients_url"),
        "ingredientsText": (p.get("ingredients_text") or "").strip() or None,
        "source": {"type": "openfoodfacts", "url": f"https://world.openfoodfacts.org/product/{code}", "collected": date.today().isoformat()},
    }


def keep_label_photo(e: dict) -> None:
    """Download the ingredient-label photo (and front photo) into the lake so the evidence is local."""
    for key, suffix in (("labelImage", "ingredients"), ("image", "front")):
        url = e.get(key)
        if not url:
            continue
        dst = BRONZE / f"{e['barcode']}-{suffix}.jpg"
        if dst.exists():
            e[key + "Path"] = str(dst); continue
        try:
            r = requests.get(url, headers=UA, timeout=60)
            if r.status_code == 200 and r.content[:3] == b"\xff\xd8\xff":
                dst.parent.mkdir(parents=True, exist_ok=True); dst.write_bytes(r.content); e[key + "Path"] = str(dst)
        except requests.RequestException:
            pass
        time.sleep(0.3)


def by_barcode(code: str) -> dict | None:
    r = requests.get(PRODUCT_URL.format(barcode=code), params={"fields": FIELDS}, headers=UA, timeout=60)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    body = r.json()
    return normalize(body.get("product") or {}) if body.get("status") == 1 else None


def search(terms: str | None, category: str | None, n: int, country: str | None):
    params = {"action": "process", "json": 1, "page_size": min(n, 100), "fields": FIELDS, "sort_by": "unique_scans_n"}
    if terms:
        params["search_terms"] = terms
        params["search_simple"] = 1
    if category:
        params.update({"tagtype_0": "categories", "tag_contains_0": "contains", "tag_0": category})
    if country:
        params.update({"tagtype_1": "countries", "tag_contains_1": "contains", "tag_1": country})
    got, page = [], 1
    while len(got) < n:
        params["page"] = page
        r = requests.get(SEARCH_URL, params=params, headers=UA, timeout=90)
        r.raise_for_status()
        prods = r.json().get("products") or []
        if not prods:
            break
        for p in prods:
            e = normalize(p)
            if e and e["ingredients"]:
                got.append(e)
                if len(got) >= n:
                    break
        page += 1
        time.sleep(1.0)
    return got


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--barcode", nargs="*", default=[])
    ap.add_argument("--search", default=None)
    ap.add_argument("--category", default=None, help="OFF category tag, e.g. en:snacks, en:cookies, en:sodas")
    ap.add_argument("--categories-file", default=None, help="one OFF category tag per line (the driver uses tools/scrape/product_categories.txt)")
    ap.add_argument("--no-photos", action="store_true", help="do not download label photos into data-lake/bronze/products")
    ap.add_argument("--file", default=None, help="file with one barcode or search term per line")
    ap.add_argument("--n", type=int, default=25)
    ap.add_argument("--country", default="united-states")
    ap.add_argument("--out", default="data/products.json")
    args = ap.parse_args()

    out_path = Path(args.out)
    db = json.loads(out_path.read_text()) if out_path.exists() else {"version": 1, "attribution": "Data from Open Food Facts, https://openfoodfacts.org (ODbL)", "products": []}
    by_code = {p["barcode"]: p for p in db["products"]}

    jobs_barcodes = list(args.barcode)
    jobs_terms = []
    if args.file:
        for line in Path(args.file).read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            (jobs_barcodes if line.isdigit() else jobs_terms).append(line)
    if args.search:
        jobs_terms.append(args.search)

    added = 0
    for code in jobs_barcodes:
        e = by_barcode(code)
        print(f"  {code}: {e['name'] if e else 'not found'}")
        if e:
            by_code[e["barcode"]] = e
            added += 1
        time.sleep(0.5)
    for term in jobs_terms:
        res = search(term, None, args.n, args.country)
        print(f"  search '{term}': {len(res)} products")
        for e in res:
            by_code[e["barcode"]] = e
        added += len(res)
    cats = [args.category] if args.category else []
    if args.categories_file:
        cats += [l.strip() for l in Path(args.categories_file).read_text().splitlines() if l.strip() and not l.startswith("#")]
    for cat in cats:
        try:
            res = search(None, cat, args.n, args.country)
        except requests.RequestException as ex:
            print(f"  category {cat}: failed ({ex.__class__.__name__})"); continue
        print(f"  category {cat}: {len(res)} products, {sum(1 for e in res if e.get('labelImage'))} with a label photo", flush=True)
        for e in res:
            by_code[e["barcode"]] = e
        added += len(res)
    if not args.no_photos:
        for e in by_code.values():
            if e.get("labelImage") and not e.get("labelImagePath"):
                keep_label_photo(e)

    db["products"] = sorted(by_code.values(), key=lambda p: p["name"].lower())
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(db, indent=2, ensure_ascii=False) + "\n")
    print(f"{added} fetched; {len(db['products'])} products in {out_path}. Next: node tools/build-data.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())

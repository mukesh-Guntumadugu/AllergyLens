#!/usr/bin/env python3
"""Source adapter: a listing's photos through the official Google Places API (New).

This is the sanctioned route to the same photos Google Maps shows (up to 10 per
place). Needs GOOGLE_PLACES_API_KEY with "Places API (New)" enabled. Pricing: Text
Search and Photo requests bill per call; the monthly free tier covers a county-sized
demo, not a national sweep (DESIGN.md §5, §14).

Terms to keep in mind: Places content other than place ids may not be cached for
more than 30 days; what we keep long-term is our own derived data (dish lines),
tagged source_type = "places-api-photo" so it can be purged if ever required.

Per restaurant:
  1. places:searchText  (name + address)  -> place id, displayName, photos[].name
  2. GET v1/{photo.name}/media?maxWidthPx=2000&skipHttpRedirect=true -> photoUri -> download
  3. bronze store + data-lake/silver/menu_photos.jsonl rows (same shape as the web adapter)
Photos are not categorised by the API; the menu gate (Stage C1) sorts menus from food shots.

Usage:
    GOOGLE_PLACES_API_KEY=... .venv/bin/python tools/scrape/sources/places_api_photos.py \
        --query "Star of India, 128 W Union St, Athens, OH" --restaurant-id star-of-india-athens
    GOOGLE_PLACES_API_KEY=... .venv/bin/python tools/scrape/sources/places_api_photos.py --from-restaurants --limit 20
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parents[3]
SEARCH = "https://places.googleapis.com/v1/places:searchText"
MEDIA = "https://places.googleapis.com/v1/{name}/media"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def find_place(key: str, query: str) -> dict | None:
    r = requests.post(SEARCH, headers={"X-Goog-Api-Key": key, "Content-Type": "application/json",
                                       "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.photos,places.googleMapsUri"},
                      json={"textQuery": query, "maxResultCount": 1}, timeout=60)
    r.raise_for_status()
    places = r.json().get("places") or []
    return places[0] if places else None


def fetch_photo(key: str, photo_name: str, max_px: int = 2000) -> tuple[bytes, str] | None:
    r = requests.get(MEDIA.format(name=photo_name), params={"maxWidthPx": max_px, "maxHeightPx": max_px, "skipHttpRedirect": "true", "key": key}, timeout=60)
    if r.status_code != 200:
        return None
    uri = r.json().get("photoUri")
    if not uri:
        return None
    img = requests.get(uri, timeout=60)
    if img.status_code != 200 or not img.headers.get("content-type", "").startswith("image/"):
        return None
    return img.content, img.headers["content-type"]


def store(lake: Path, restaurant_id: str, place: dict, blobs: list[tuple[bytes, str]]) -> int:
    assets = lake / "bronze" / "assets"; manifest = lake / "bronze" / "manifest.jsonl"
    out = lake / "silver" / "menu_photos.jsonl"; out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    for body, ct in blobs:
        sha = hashlib.sha256(body).hexdigest(); ext = "jpg" if "jpeg" in ct else ct.split("/")[-1]
        d = assets / sha[:2]; d.mkdir(parents=True, exist_ok=True)
        p = d / f"{sha}.{ext}"
        if not p.exists(): p.write_bytes(body)
        row = {"sha256": sha, "url": None, "source_type": "places-api-photo", "content_type": ct, "bytes": len(body), "fetched_at": now(),
               "http_status": 200, "ext": ext, "restaurant_id": restaurant_id, "google_place_id": place["id"]}
        with manifest.open("a") as f: f.write(json.dumps(row) + "\n")
        with out.open("a") as f:
            f.write(json.dumps({"restaurant_id": restaurant_id, "sha256": sha, "ext": ext, "gallery_category": "all",
                                "listing_name": place.get("displayName", {}).get("text"), "listing_address": place.get("formattedAddress"),
                                "maps_url": place.get("googleMapsUri"), "google_place_id": place["id"], "source_type": "places-api-photo",
                                "fetched_at": now()}) + "\n")
        n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--query"); ap.add_argument("--restaurant-id")
    ap.add_argument("--from-restaurants", action="store_true", help="all rows of data-lake/silver/restaurants.jsonl")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--max-photos", type=int, default=10)
    ap.add_argument("--lake", default=str(REPO / "data-lake"))
    ap.add_argument("--key", default=os.environ.get("GOOGLE_PLACES_API_KEY"))
    args = ap.parse_args()
    if not args.key:
        sys.exit("set GOOGLE_PLACES_API_KEY (Places API (New) enabled) or pass --key")
    lake = Path(args.lake)
    jobs = []
    if args.from_restaurants:
        for l in (lake / "silver" / "restaurants.jsonl").read_text().splitlines():
            if not l.strip(): continue
            r = json.loads(l)
            q = ", ".join(x for x in [r["name"], r.get("address"), r.get("city") or "Athens County", r.get("state")] if x)
            jobs.append({"query": q, "restaurant_id": r["restaurant_id"]})
    elif args.query and args.restaurant_id:
        jobs = [{"query": args.query, "restaurant_id": args.restaurant_id}]
    else:
        sys.exit("give --query and --restaurant-id, or --from-restaurants")
    if args.limit: jobs = jobs[: args.limit]
    total = 0
    for i, j in enumerate(jobs):
        place = find_place(args.key, j["query"])
        if not place:
            print(f"[{i + 1}/{len(jobs)}] {j['query']}: no place"); continue
        photos = (place.get("photos") or [])[: args.max_photos]
        blobs = [b for b in (fetch_photo(args.key, p["name"]) for p in photos) if b]
        n = store(lake, j["restaurant_id"], place, blobs); total += n
        print(f"[{i + 1}/{len(jobs)}] {place.get('displayName', {}).get('text')}: {n} photos")
        time.sleep(0.5)
    print(f"{total} photos -> data-lake/silver/menu_photos.jsonl (source_type places-api-photo). Next: Stage C gate + OCR.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

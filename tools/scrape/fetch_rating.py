#!/usr/bin/env python3
"""Fetch a restaurant's rating and count how many reviews mention allergy
problems, through the official Google Places API (allowed by Google's terms,
unlike scraping the Maps site). Writes the `rating` block for data/menus.json.

Setup once:
    export GOOGLE_PLACES_API_KEY=...     # Places API (New) enabled on the key
    pip install requests

Usage:
    python3 tools/scrape/fetch_rating.py "Star of India, Athens OH" \
        --out data/menus/star-of-india/rating.json

Note: the Places API returns at most 5 reviews per place, so
`allergyComplaints` is a lower bound from those; fill it from other permitted
sources (your own review export, the restaurant's site) if you have them.
"""

import argparse
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

import requests

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
ALLERGY_RE = re.compile(r"allerg|peanut|nut-free|gluten|dairy|lactose|shellfish|vegan|vegetarian|wrong order|cross.?contam|got sick|reaction", re.I)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("query", help='e.g. "Star of India, Athens OH"')
    ap.add_argument("--out", required=True)
    ap.add_argument("--key", default=os.environ.get("GOOGLE_PLACES_API_KEY"))
    args = ap.parse_args()
    if not args.key:
        print("set GOOGLE_PLACES_API_KEY or pass --key", file=sys.stderr)
        return 2

    r = requests.post(
        SEARCH_URL,
        headers={
            "X-Goog-Api-Key": args.key,
            "X-Goog-FieldMask": "places.id,places.displayName,places.rating,places.userRatingCount,places.reviews,places.googleMapsUri",
            "Content-Type": "application/json",
        },
        json={"textQuery": args.query, "maxResultCount": 1},
        timeout=60,
    )
    r.raise_for_status()
    places = r.json().get("places") or []
    if not places:
        print("no place found", file=sys.stderr)
        return 1
    p = places[0]
    reviews = p.get("reviews") or []
    flagged = [rv for rv in reviews if ALLERGY_RE.search((rv.get("text") or {}).get("text", ""))]
    rating = {
        "stars": p.get("rating"),
        "reviewCount": p.get("userRatingCount"),
        "allergyComplaints": len(flagged),
        "source": {"type": "google-places-api", "url": p.get("googleMapsUri"), "collected": date.today().isoformat()},
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(rating, indent=2) + "\n")
    print(f"{p.get('displayName', {}).get('text')}: ★{rating['stars']} ({rating['reviewCount']} ratings), "
          f"{len(flagged)}/{len(reviews)} fetched reviews mention allergies -> {args.out}")
    for rv in flagged:
        print("  -", (rv.get("text") or {}).get("text", "")[:120].replace("\n", " "))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Stage A: list every restaurant / fast-food place / cafe in a US county from OpenStreetMap.

Writes data-lake/silver/restaurants.jsonl (one row per place, DESIGN.md §12), merging into
existing rows by restaurant_id. Open data (ODbL); the Overpass public servers are shared,
so this is one query per county and retries politely across mirrors.

Usage:
    .venv/bin/python tools/scrape/discover_restaurants.py --state Ohio --state-code OH --county "Athens County"
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parents[2]
UA = {"User-Agent": "AllergyLens/0.2 (hackathon project; github.com/mukesh-Guntumadugu/AllergyLens)"}
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
# The county must be resolved INSIDE the state: an area filter on an area statement does not constrain it,
# so "Adams County" alone returned the Adams Counties of a dozen states (971 "Ohio" restaurants, mostly Colorado).
# Select the county *relation* within the state area, turn it into an area, then search inside that.
QUERY = """[out:json][timeout:120];
area["name"="{state}"]["admin_level"="4"]["boundary"="administrative"]->.state;
rel["name"="{county}"]["admin_level"="6"]["boundary"="administrative"](area.state);
map_to_area->.county;
nwr["amenity"~"^(restaurant|fast_food|cafe)$"](area.county);
out center tags;"""


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48]


def fetch(state: str, county: str, raw_out: Path) -> dict:
    q = QUERY.format(state=state, county=county)
    for attempt in range(6):
        ep = MIRRORS[attempt % len(MIRRORS)]
        try:
            r = requests.post(ep, data={"data": q}, headers=UA, timeout=180)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                raw_out.parent.mkdir(parents=True, exist_ok=True); raw_out.write_text(r.text)
                return r.json()
            print(f"  {ep}: HTTP {r.status_code} ({r.text[:60].strip()!r}); retrying", file=sys.stderr)
        except requests.RequestException as e:
            print(f"  {ep}: {e.__class__.__name__}; retrying", file=sys.stderr)
        time.sleep(min(60, 5 * 2 ** attempt))
    sys.exit("Overpass unavailable after 6 attempts")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state", required=True, help='full name as in OSM, e.g. "Ohio"')
    ap.add_argument("--state-code", required=True, help="e.g. OH")
    ap.add_argument("--county", required=True, help='as in OSM, e.g. "Athens County"')
    ap.add_argument("--lake", default=str(REPO / "data-lake"))
    args = ap.parse_args()
    lake = Path(args.lake)
    county_short = args.county.replace(" County", "")
    data = fetch(args.state, args.county, lake / "bronze" / f"overpass-{slug(county_short)}-{args.state_code.lower()}.json")
    out = lake / "silver" / "restaurants.jsonl"; out.parent.mkdir(parents=True, exist_ok=True)
    existing = {json.loads(l)["restaurant_id"]: json.loads(l) for l in out.read_text().splitlines() if l.strip()} if out.exists() else {}
    by_osm = {r["source_ids"].get("osm"): rid for rid, r in existing.items() if r.get("source_ids", {}).get("osm")}
    added = 0
    for e in data.get("elements", []):
        t = e.get("tags", {})
        if not t.get("name"):
            continue
        lat, lon = (e.get("lat"), e.get("lon")) if "lat" in e else (e.get("center", {}).get("lat"), e.get("center", {}).get("lon"))
        city = t.get("addr:city") or f"{slug(county_short)}-county"
        osm_id = f"{e['type']}/{e['id']}"
        if osm_id in by_osm:
            rid = by_osm[osm_id]            # same OSM element seen before: keep its id even if the name or city tag changed
        else:
            rid = f"{slug(t['name'])}-{slug(city)}"
            if rid in existing and existing[rid]["source_ids"].get("osm") != osm_id:
                rid += f"-{e['id']}"        # two different places with the same name in the same city
        row = {"restaurant_id": rid, "name": t["name"], "amenity": t.get("amenity"), "cuisine": t.get("cuisine"), "lat": lat, "lon": lon,
               "state": args.state_code, "county": county_short,
               "address": " ".join(x for x in [t.get("addr:housenumber"), t.get("addr:street")] if x) or None,
               "city": t.get("addr:city"), "postcode": t.get("addr:postcode"),
               "website": t.get("website") or t.get("contact:website"), "phone": t.get("phone") or t.get("contact:phone"),
               "source_ids": {"osm": f"{e['type']}/{e['id']}"}, "discovered_at": date.today().isoformat()}
        if rid not in existing:
            added += 1
        existing[rid] = {**existing.get(rid, {}), **{k: v for k, v in row.items() if v is not None or k not in existing.get(rid, {})}}
    rows = sorted(existing.values(), key=lambda r: (r["state"], r["county"], r["name"].lower()))
    out.write_text("".join(json.dumps(r) + "\n" for r in rows))
    n = sum(1 for r in rows if r["county"] == county_short and r["state"] == args.state_code)
    print(f"{args.county}, {args.state_code}: {n} places ({added} new), {sum(1 for r in rows if r['county'] == county_short and r.get('website'))} with a website -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

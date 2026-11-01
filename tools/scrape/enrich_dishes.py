#!/usr/bin/env python3
"""Turn dish names into ingredient lists WITH an estimated share of the dish,
so the Lens can say "ask the chef to leave out the cashews" (small share) or
"removing the paneer guts this dish — pick something else" (big share).

For each dish name not yet in data/dishes.json, asks a local open-source LLM
(via Ollama) for the typical recipe. Optionally checks Open Food Facts first
for packaged products (barcode or exact product name).

Runs on the scraping machine. Writes/merges into data/dishes.json.

Setup once:
    ollama pull llama3.1:8b          # any decent text model; qwen2.5:7b also fine
    pip install requests

Usage:
    python3 tools/scrape/enrich_dishes.py data/menus/star-of-india/menu-1.ocr.json \
        [--model llama3.1:8b] [--dishes data/dishes.json] [--off]

Output entry shape in data/dishes.json:
    {
      "name": "paneer shai kurma",
      "aliases": [],
      "typicalIngredients": ["paneer", "cream", "tomato", "onion", "cashews", "ghee"],
      "shares": {"paneer": 40, "cream": 15, "tomato": 15, "onion": 10, "cashews": 5, "ghee": 5},
      "substitutes": {"paneer": "tofu", "cream": "coconut cream", "cashews": null},
      "source": {"type": "llm", "url": null, "collected": "2026-11-02", "model": "llama3.1:8b"}
    }
`shares` are rough percentages of the dish by weight (they need not sum to 100).
`substitutes` maps an ingredient to a common swap, or null when there isn't one.
Everything an LLM produced is marked source.type = "llm" so the Lens can say
"typical recipe" and the user can replace it with verified data later.
"""

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

import requests

OLLAMA_URL = "http://localhost:11434/api/generate"
OFF_SEARCH = "https://world.openfoodfacts.org/cgi/search.pl"

PROMPT = """You are a chef. For the dish "{name}"{cuisine}, list its typical ingredients.
Reply with ONLY a JSON object, no prose, in this exact shape:
{{
  "ingredients": ["ingredient", "..."],
  "shares": {{"ingredient": percent_of_dish_by_weight, ...}},
  "substitutes": {{"ingredient": "common substitute or null", ...}}
}}
Rules: lowercase ingredient names; 4-10 ingredients; percents are rough integers;
include hidden ones that matter for allergies (ghee, cream, cashew paste, fish sauce,
peanut oil, wheat flour, egg). Substitutes must be realistic kitchen swaps or null."""


def ask_llm(model: str, name: str, cuisine: str | None) -> dict | None:
    prompt = PROMPT.format(name=name, cuisine=f" ({cuisine} cuisine)" if cuisine else "")
    r = requests.post(OLLAMA_URL, json={"model": model, "prompt": prompt, "stream": False, "format": "json"}, timeout=300)
    r.raise_for_status()
    text = r.json().get("response", "")
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            return None
        obj = json.loads(m.group(0))
    ings = [str(i).strip().lower() for i in obj.get("ingredients", []) if str(i).strip()]
    if not ings:
        return None
    shares = {str(k).lower(): int(v) for k, v in (obj.get("shares") or {}).items() if str(v).strip().lstrip("-").isdigit()}
    subs = {str(k).lower(): (str(v).lower() if v not in (None, "null", "") else None) for k, v in (obj.get("substitutes") or {}).items()}
    return {"ingredients": ings, "shares": shares, "substitutes": subs}


def ask_off(name: str) -> dict | None:
    """Open Food Facts: only useful for packaged products; returns ingredients + allergen tags."""
    r = requests.get(OFF_SEARCH, params={"search_terms": name, "search_simple": 1, "action": "process", "json": 1, "page_size": 1}, timeout=60,
                     headers={"User-Agent": "AllergyLens/0.1 (hackathon; contact via repo)"})
    r.raise_for_status()
    prods = r.json().get("products") or []
    if not prods:
        return None
    p = prods[0]
    ings = [i.get("text", "").strip().lower() for i in p.get("ingredients", []) if i.get("text")]
    if not ings:
        return None
    shares = {i.get("text", "").strip().lower(): int(float(i["percent_estimate"])) for i in p.get("ingredients", []) if i.get("percent_estimate") is not None}
    return {"ingredients": ings, "shares": shares, "substitutes": {},
            "url": p.get("url"), "allergens": p.get("allergens_tags", [])}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("menu_json", help="a restaurant entry (e.g. from ocr_menu.py) or data/menus.json")
    ap.add_argument("--dishes", default="data/dishes.json")
    ap.add_argument("--model", default="llama3.1:8b")
    ap.add_argument("--cuisine", default=None, help="hint for the LLM, e.g. 'Indian'")
    ap.add_argument("--off", action="store_true", help="try Open Food Facts before the LLM (packaged products)")
    ap.add_argument("--force", action="store_true", help="re-generate dishes already in the knowledge base")
    args = ap.parse_args()

    src = json.loads(Path(args.menu_json).read_text())
    restaurants = src.get("restaurants") or [src]
    kb_path = Path(args.dishes)
    kb = json.loads(kb_path.read_text()) if kb_path.exists() else {"version": 1, "dishes": []}
    known = {d["name"].lower(): d for d in kb["dishes"]}
    for d in kb["dishes"]:
        for a in d.get("aliases", []):
            known.setdefault(a.lower(), d)

    added = 0
    for r in restaurants:
        for dish in r["dishes"]:
            name = re.sub(r"[^a-z0-9 ]+", " ", dish["name"].lower()).strip()
            name = re.sub(r"\s+", " ", name)
            if not name or (name in known and not args.force):
                continue
            info, src_type, url = None, "llm", None
            if args.off:
                try:
                    info = ask_off(dish["name"])
                    if info:
                        src_type, url = "openfoodfacts", info.pop("url", None)
                except requests.RequestException as e:
                    print(f"  OFF failed for {name}: {e}", file=sys.stderr)
            if not info:
                try:
                    info = ask_llm(args.model, dish["name"], args.cuisine)
                except requests.RequestException as e:
                    print(f"  LLM failed for {name}: {e}", file=sys.stderr)
            if not info:
                print(f"  no data for {name}")
                continue
            entry = {
                "name": name,
                "aliases": [],
                "typicalIngredients": info["ingredients"],
                "shares": info.get("shares", {}),
                "substitutes": info.get("substitutes", {}),
                "source": {"type": src_type, "url": url, "collected": date.today().isoformat(), **({"model": args.model} if src_type == "llm" else {})},
            }
            if name in known and args.force:
                kb["dishes"] = [d for d in kb["dishes"] if d["name"].lower() != name]
            kb["dishes"].append(entry)
            known[name] = entry
            added += 1
            big = [f"{k} {v}%" for k, v in sorted(entry["shares"].items(), key=lambda kv: -kv[1])[:3]]
            print(f"  + {name:<32} {', '.join(big)}")

    kb_path.write_text(json.dumps(kb, indent=2, ensure_ascii=False) + "\n")
    print(f"{added} dishes added to {kb_path}. Next: node tools/build-data.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())

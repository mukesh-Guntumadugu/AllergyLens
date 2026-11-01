#!/usr/bin/env python3
"""Sort a folder of restaurant photos into menus vs. not-menus, then read dish
names off the menu photos, using a local open-source vision model via Ollama.

Runs on the scraping machine (ASUS GX10), not inside the Lens.

Setup once:
    curl -fsSL https://ollama.com/install.sh | sh
    ollama pull qwen2.5vl:7b          # or llava:13b, minicpm-v, etc.
    pip install requests

Usage:
    python3 classify_menu_photos.py --photos ./photos/thai-basil \
        --restaurant-id thai-basil --restaurant-name "Thai Basil Kitchen" \
        --out ./out/thai-basil.menu.json

Output is a restaurant entry in the data/menus.json shape (see data/README.md):
dish names only, ingredients: null. Run tools/build-data.js afterwards; it
fills ingredients from data/dishes.json where the dish name is known.

Only use photos you have the right to use: your own, or ones whose source
permits reuse. Bulk-downloading Google Maps photos is against Google's terms.
"""

import argparse
import base64
import json
import re
import sys
from datetime import date
from pathlib import Path

import requests

OLLAMA_URL = "http://localhost:11434/api/generate"

CLASSIFY_PROMPT = (
    "Is this photo a restaurant MENU (a printed or displayed list of dishes with "
    "names and usually prices)? Answer with exactly one word: MENU or NOT_MENU."
)

EXTRACT_PROMPT = (
    "This is a restaurant menu. List every dish name you can read, one per line, "
    "without prices, descriptions, or section headings. If a short ingredient "
    "description is printed under a dish, append it after a ' | ' on the same line. "
    "Output only the lines."
)


def ask(model: str, prompt: str, image_path: Path) -> str:
    img_b64 = base64.b64encode(image_path.read_bytes()).decode()
    resp = requests.post(
        OLLAMA_URL,
        json={"model": model, "prompt": prompt, "images": [img_b64], "stream": False},
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json().get("response", "").strip()


def slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:40] or "dish"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--photos", required=True, help="folder of .jpg/.png photos")
    ap.add_argument("--restaurant-id", required=True)
    ap.add_argument("--restaurant-name", required=True)
    ap.add_argument("--out", required=True, help="where to write the restaurant JSON")
    ap.add_argument("--model", default="qwen2.5vl:7b", help="Ollama vision model")
    ap.add_argument("--icon", default="set_meal", help="default icon name from Assets/Icons")
    args = ap.parse_args()

    photos = sorted(p for p in Path(args.photos).iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
    if not photos:
        print(f"no photos in {args.photos}", file=sys.stderr)
        return 1

    menu_photos = []
    for p in photos:
        verdict = ask(args.model, CLASSIFY_PROMPT, p).upper()
        is_menu = "NOT" not in verdict and "MENU" in verdict
        print(f"{'MENU    ' if is_menu else 'not menu'}  {p.name}")
        if is_menu:
            menu_photos.append(p)

    dishes = {}
    for p in menu_photos:
        text = ask(args.model, EXTRACT_PROMPT, p)
        for line in text.splitlines():
            line = line.strip(" -•*\t")
            if not line or len(line) > 80:
                continue
            name, _, desc = line.partition("|")
            name = name.strip()
            desc = desc.strip().lower()
            if not name or name.lower() in dishes:
                continue
            ingredients = [w.strip() for w in re.split(r"[,;/]", desc) if w.strip()] if desc else None
            dishes[name.lower()] = {
                "id": slug(name),
                "name": name,
                "icon": args.icon,
                "ingredients": ingredients,   # null = unknown; build-data.js fills from the dish KB
                "removable": [],
                "notes": f"read from {p.name}",
            }

    entry = {
        "id": args.restaurant_id,
        "name": args.restaurant_name,
        "source": {"type": "photo", "url": None, "collected": date.today().isoformat()},
        "rating": None,
        "dishes": list(dishes.values()),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(entry, indent=2) + "\n")
    print(f"\n{len(menu_photos)}/{len(photos)} photos were menus; {len(dishes)} dishes -> {args.out}")
    print("Next: paste this entry into data/menus.json 'restaurants' and run: node tools/build-data.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Read a menu photo and output every dish line WITH its position on the page.

The Lens uses the image as a tracking marker and the positions to draw the
green/red/amber highlight over each printed line, so the overlay lands on the
real menu the glasses are looking at.

Pipeline (runs on the scraping machine):
  1. OCR (RapidOCR by default, Tesseract optional) -> text lines with bounding boxes.
  2. Heuristics     -> drop prices, headings, descriptions; keep dish-name lines.
     Optional: a local LLM (Ollama) double-checks which lines are dishes.
  3. Output         -> a restaurant entry in the data/menus.json shape, plus
                       `image` (path) and per-dish `layout` {x, y, w, h} as
                       fractions of the image size (0..1, origin top-left).

Setup once:
    pip install rapidocr-onnxruntime pillow requests      # or: pytesseract + the tesseract binary, with --engine tesseract

Usage:
    python3 tools/scrape/ocr_menu.py data/menus/star-of-india/menu-1.png \
        --restaurant-id star-of-india --restaurant-name "Star of India" \
        --out data/menus/star-of-india/menu-1.ocr.json [--llm qwen2.5vl:7b]

Then merge the entry into data/menus.json and run `node tools/build-data.js`.
"""

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ocr_engines import ocr_lines as engine_ocr_lines  # rapidocr (default) | tesseract

PRICE_RE = re.compile(r"\$?\d{1,3}[.,]\d{2}\b")
HEADING_WORDS = {"corner", "breads", "desserts", "beverages", "appetizers", "entrees", "specialties",
                 "delicacies", "sides", "soups", "salads", "menu", "drinks", "starters", "mains"}


def slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:40] or "dish"


def ocr_lines(image_path: Path, engine: str = "rapidocr"):
    """Return ([{text, x, y, w, h}], (W, H)) in original-image pixels, one per visual line.
    Engines live in ocr_engines.py: RapidOCR returns lines with boxes directly; Tesseract
    returns words that are grouped into lines (rows by vertical centre, split at wide gaps)."""
    return engine_ocr_lines(image_path, engine)


def looks_like_dish(text: str) -> bool:
    t = text.strip()
    if len(t) < 3 or len(t) > 60:
        return False
    letters = re.sub(r"[^A-Za-z]", "", t)
    if len(letters) < 3:
        return False
    low = t.lower()
    if any(w in HEADING_WORDS for w in re.findall(r"[a-z]+", low)) and len(low.split()) <= 3:
        return False
    if t.startswith("(") or low.startswith(("a ", "an ", "the ", "homemade", "made ", "served", "mixture", "golden", "chickpeas", "potatoes", "roasted", "scrambled")):
        return False  # description lines
    # Dish names on menus are mostly UPPERCASE or Title Case; judge only the part before any
    # "(description)" so "PALAK NAN (spinach stuffed Nan)" still counts.
    head = re.sub(r"[^A-Za-z]", "", t.split("(")[0])
    if len(head) < 3:
        return False
    upper_ratio = sum(c.isupper() for c in head) / len(head)
    return upper_ratio > 0.6 or PRICE_RE.search(t) is not None


def clean_name(text: str) -> tuple[str, list[str] | None]:
    """Strip the price and pull a parenthetical description into ingredients."""
    t = PRICE_RE.sub("", text).strip(" -–—.|")
    desc = None
    m = re.search(r"\(([^)]*)\)", t)
    if m:
        desc = m.group(1).lower()
        t = (t[: m.start()] + t[m.end():]).strip()
    name = re.sub(r"\s+", " ", t).strip()
    ingredients = None
    if desc:
        ingredients = [w.strip() for w in re.split(r"[,&/]| and ", desc) if w.strip()] or None
    return name.title() if name.isupper() else name, ingredients


def llm_filter(model: str, candidates: list[str]) -> set[str]:
    """Ask a local Ollama model which candidate lines are dish names. Returns the kept lines."""
    import requests

    prompt = (
        "These lines were read from a restaurant menu. Reply with ONLY the lines that are names of "
        "dishes or drinks a customer can order (not section headings, descriptions, prices, addresses, "
        "or notes). One per line, verbatim.\n\n" + "\n".join(candidates)
    )
    r = requests.post("http://localhost:11434/api/generate", json={"model": model, "prompt": prompt, "stream": False}, timeout=300)
    r.raise_for_status()
    kept = {l.strip() for l in r.json().get("response", "").splitlines() if l.strip()}
    return {c for c in candidates if c in kept or c.strip() in kept}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--restaurant-id", required=True)
    ap.add_argument("--restaurant-name", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--llm", default=None, help="optional Ollama model to double-check dish lines, e.g. qwen2.5vl:7b")
    ap.add_argument("--marker-width-cm", type=float, default=29.7, help="real printed width of this menu page (for the tracker)")
    ap.add_argument("--engine", default="rapidocr", choices=["rapidocr", "tesseract"], help="OCR engine (ocr_engines.py)")
    args = ap.parse_args()

    image_path = Path(args.image)
    lines, (W, H) = ocr_lines(image_path, args.engine)
    candidates = [l for l in lines if looks_like_dish(l["text"])]
    if args.llm:
        keep = llm_filter(args.llm, [c["text"] for c in candidates])
        candidates = [c for c in candidates if c["text"] in keep]

    dishes, seen = [], set()
    for c in candidates:
        name, ingredients = clean_name(c["text"])
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        dishes.append({
            "id": slug(name),
            "name": name,
            "ingredients": ingredients,      # null = unknown; build-data.js fills from data/dishes.json
            "removable": [],
            "layout": {"x": round(c["x"] / W, 4), "y": round(c["y"] / H, 4), "w": round(c["w"] / W, 4), "h": round(c["h"] / H, 4)},
            "ocr": c["text"],
        })

    entry = {
        "id": args.restaurant_id,
        "name": args.restaurant_name,
        "source": {"type": "photo", "url": None, "collected": date.today().isoformat()},
        "rating": None,
        "menuImage": {"path": str(image_path), "widthPx": W, "heightPx": H, "widthCm": args.marker_width_cm},
        "dishes": dishes,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(entry, indent=2) + "\n")
    print(f"{len(lines)} OCR lines -> {len(dishes)} dishes -> {args.out}")
    for d in dishes:
        print(f"  {d['name']:<40} @ x={d['layout']['x']:.2f} y={d['layout']['y']:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

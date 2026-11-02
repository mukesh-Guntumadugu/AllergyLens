#!/usr/bin/env python3
"""Stage C3: menu image + OCR lines -> labelled dish lines (grounded extraction, DESIGN.md §7.3).

The vision model sees the image AND the numbered OCR lines and may only refer to
line ids, so it cannot invent a dish; each dish keeps the OCR box as its layout.
Output is schema-constrained JSON (Ollama `format`). Per line: role, the dish it
belongs to, section text, category (fixed list), printed markers, price, corrected text.

Usage:
    .venv/bin/python tools/scrape/label_menu_lines.py data/menus/star-of-india/menu-1.png \
        --restaurant-id star-of-india --restaurant-name "Star of India" \
        --out data/menus/star-of-india/menu-1.labelled.json [--vision-model qwen2.5vl:7b] [--engine rapidocr]
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ocr_engines import ocr_lines  # noqa: E402

OLLAMA = "http://localhost:11434/api/chat"
# vLLM (or any OpenAI-compatible server): set VLM_API=openai and VLM_BASE_URL=http://localhost:8000/v1, VLM_MODEL=<served name>.
# vLLM enforces the JSON schema with guided decoding, batches requests, and serves Qwen3-VL directly (DESIGN.md §13).
import os
VLM_API = os.environ.get("VLM_API", "ollama")
VLM_BASE_URL = os.environ.get("VLM_BASE_URL", "http://localhost:8000/v1")
VLM_MODEL = os.environ.get("VLM_MODEL", "Qwen/Qwen3-VL-8B-Instruct")
# preference order for --vision-model auto (DESIGN.md §13); the first one that is pulled AND loads wins.
# 2026-11-02 on the GX10: qwen3-vl needs a newer Ollama than 0.24; qwen2.5vl's runner crashes on load;
# llama3.2-vision loads and runs.
VISION_MODELS = ["qwen3-vl:8b", "qwen2.5vl:7b", "llama3.2-vision"]
CATEGORIES = ["veg", "egg", "chicken", "mutton", "beef", "pork", "seafood", "vegan", "dessert", "soft_drink", "alcohol",
              "bread", "rice", "soup_salad", "kids", "side", "unknown"]
ROLES = ["dish", "section", "description", "price", "marker", "other"]
SCHEMA = {
    "type": "object",
    "properties": {"lines": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "line": {"type": "integer"},
            "role": {"type": "string", "enum": ROLES},
            "dish_of": {"type": ["integer", "null"]},
            "section_text": {"type": ["string", "null"]},
            "category": {"type": "string", "enum": CATEGORIES},
            "markers": {"type": "array", "items": {"type": "string"}},
            "price": {"type": ["number", "null"]},
            "text_corrected": {"type": "string"},
        },
        "required": ["line", "role", "dish_of", "section_text", "category", "markers", "price", "text_corrected"]}}},
    "required": ["lines"],
}
PROMPT = """You are labelling a restaurant menu. Below are the OCR lines read from the attached menu image, numbered. Each line carries its column ([L] left, [M] middle, [R] right) and vertical position (y=% of page height). Menus are laid out in columns: a section heading applies ONLY to the lines in the SAME column below it, never to lines in another column on the same row. A price belongs to the dish in the same column at the same y. Some OCR lines have lost their spaces (e.g. "PANEERPALAK" = "PANEER PALAK").

For EVERY line id, output one object:
- role: "dish" if the line is (or starts with) the name of a dish or drink a customer can order; "section" for a heading like "Desserts" or "Tandoori Breads"; "description" for a line describing a dish; "price" for a line that is only a price; "marker" for dietary symbols; "other" for addresses, restaurant name, notes.
- dish_of: for description / price / marker lines, the line id of the dish they belong to (usually the dish line just above or on the same row); for dish lines, their own id; else null.
- section_text: the heading text (as printed) this line sits under, or null.
- category: ONE of {cats}. Judge from the section heading, printed markers and the dish's own description on the menu — not from general knowledge. "veg" = vegetarian dish, "bread" = naan/roti/paratha, "soft_drink" = non-alcoholic drinks, "dessert" = sweets. Use "unknown" when the menu does not say.
- markers: printed dietary symbols or words next to the line (e.g. "V", "GF", "spicy"), else [].
- price: the price printed for this dish (on the line or the price line of the same row), as a number, else null.
- text_corrected: the line's text with spacing and obvious OCR errors fixed, keeping the original wording.

Use only the line ids given. Return JSON only, one object per line id listed under "Lines to label".
{context}
Lines to label:
{lines}"""
BATCH = 10   # lines labelled per model call; llama3.2-vision answers 10 cleanly in ~30 s, longer answers get cut off


def b64_image(path: Path, max_side: int = 1600) -> str:
    from PIL import Image
    im = Image.open(path).convert("RGB")
    if max(im.size) > max_side:
        im.thumbnail((max_side, max_side))
    buf = io.BytesIO(); im.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


def pulled_models() -> set[str]:
    try:
        tags = requests.get("http://localhost:11434/api/tags", timeout=10).json().get("models", [])
        return {m["name"] for m in tags} | {m["name"].split(":")[0] for m in tags}
    except Exception:
        return set()


def resolve_model(wanted: str) -> list[str]:
    if wanted != "auto":
        return [wanted]
    have = pulled_models()
    return [m for m in VISION_MODELS if m in have or m.split(":")[0] in have] or VISION_MODELS


def _parse(content: str) -> dict | None:
    """Full JSON, else salvage every complete per-line object from a cut-off answer."""
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass
    objs = []
    for mm in re.finditer(r"\{[^{}]*\"line\"\s*:\s*\d+[^{}]*\}", content, re.S):
        try:
            objs.append(json.loads(mm.group(0)))
        except json.JSONDecodeError:
            continue
    return {"lines": objs, "salvaged": True} if objs else None


def line_tag(lines: list[dict], i: int, W: int, H: int) -> str:
    l = lines[i]; cx = l["x"] + l["w"] / 2
    col = "L" if cx < W / 3 else "M" if cx < 2 * W / 3 else "R"
    return f"{i} [{col} y={int((l['y'] + l['h'] / 2) / H * 100)}]: {l['text']}"


def ask_openai(image_b64: str, lines: list[dict], batch: int = 40, size: tuple[int, int] | None = None) -> tuple[dict, str]:
    """Same job through an OpenAI-compatible server (vLLM). Bigger batches: guided decoding does not cut off."""
    W, H = size or (max(l["x"] + l["w"] for l in lines) or 1, max(l["y"] + l["h"] for l in lines) or 1)
    out = []
    for lo in range(0, len(lines), batch):
        hi = min(lo + batch, len(lines)) - 1
        numbered = "\n".join(line_tag(lines, i, W, H) for i in range(lo, hi + 1))
        headings = [f"{line_tag(lines, x['line'], W, H)}" for x in out if x.get("role") == "section"]
        context = ("Section headings found earlier on this menu (use them for section_text):\n" + "\n".join(headings[-8:]) + "\n") if headings else ""
        body = {"model": VLM_MODEL, "temperature": 0, "max_tokens": 6000,
                "response_format": {"type": "json_schema", "json_schema": {"name": "menu_lines", "schema": SCHEMA}},
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": PROMPT.format(cats=", ".join(CATEGORIES), lines=numbered, context=context)},
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_b64}}]}]}
        hdr = {"Authorization": "Bearer " + os.environ.get("VLM_API_KEY", "none")}
        r = requests.post(VLM_BASE_URL.rstrip("/") + "/chat/completions", json=body, headers=hdr, timeout=1800)
        r.raise_for_status()
        parsed = _parse(r.json()["choices"][0]["message"]["content"]) or {"lines": []}
        got = [x for x in parsed.get("lines", []) if isinstance(x.get("line"), int) and lo <= x["line"] <= hi]
        out.extend(got)
        print(f"  batch {lo}-{hi}: {len(got)} labels (vllm)", flush=True)
    return {"lines": out}, f"vllm:{VLM_MODEL}"


def ask(model: str, image_b64: str, lines: list[dict]) -> tuple[dict, str]:
    """Returns ({"lines": [...]}, model used). Labels the OCR lines in batches of BATCH;
    tries the auto model list in order when one fails to load. VLM_API=openai routes to vLLM."""
    if VLM_API == "openai":
        return ask_openai(image_b64, lines)
    last = None
    for m in resolve_model(model):
        out, ok = [], True
        for lo in range(0, len(lines), BATCH):
            hi = min(lo + BATCH, len(lines)) - 1
            W, H = max(l["x"] + l["w"] for l in lines) or 1, max(l["y"] + l["h"] for l in lines) or 1
            numbered = "\n".join(line_tag(lines, i, W, H) for i in range(lo, hi + 1))
            headings = [line_tag(lines, x["line"], W, H) for x in out if x.get("role") == "section"]
            prev = [line_tag(lines, i, W, H) for i in range(max(0, lo - 3), lo)]
            context = ""
            if headings:
                context += "Section headings found earlier on this menu (use them for section_text):\n" + "\n".join(headings[-8:]) + "\n"
            if prev:
                context += "The lines just above this batch (context only, do not label them):\n" + "\n".join(prev) + "\n"
            body = {"model": m, "stream": False, "format": SCHEMA, "options": {"temperature": 0, "num_predict": 2500, "num_ctx": 8192},
                    "messages": [{"role": "user", "content": PROMPT.format(cats=", ".join(CATEGORIES), lines=numbered, context=context), "images": [image_b64]}]}
            r = requests.post(OLLAMA, json=body, timeout=1800)
            if r.status_code != 200:
                last = f"{m}: HTTP {r.status_code} {r.text[:160]}"
                print(f"  vision model {m} unavailable ({r.text[:90]}); trying next", file=sys.stderr, flush=True)
                ok = False
                break
            parsed = _parse(r.json()["message"]["content"])
            if parsed is None:
                print(f"  batch {lo}-{hi}: unparsable answer from {m} (done_reason={r.json().get('done_reason')}); skipping batch", file=sys.stderr, flush=True)
                continue
            got = [x for x in parsed.get("lines", []) if isinstance(x.get("line"), int) and lo <= x["line"] <= hi]
            out.extend(got)
            print(f"  batch {lo}-{hi}: {len(got)} labels{' (salvaged from a cut-off answer)' if parsed.get('salvaged') else ''}", flush=True)
        if ok:
            return {"lines": out}, m
    raise RuntimeError(f"no vision model answered: {last}")


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "dish"


def build_entry(lines: list[dict], labels: list[dict], W: int, H: int, rid: str, rname: str, image_path: Path, model: str, engine: str, width_cm: float) -> dict:
    by_id = {l["line"]: l for l in labels if isinstance(l.get("line"), int) and 0 <= l["line"] < len(lines)}
    dishes, seen = [], set()
    for i, l in enumerate(lines):
        lab = by_id.get(i)
        if not lab or lab["role"] != "dish":
            continue
        text = lab.get("text_corrected") or l["text"]
        name = re.sub(r"\$?\d{1,3}[.,]\d{2}\b", "", text).strip(" -–—.|")
        desc_paren = None
        m = re.search(r"[\(（]([^\)）]*)[\)）]", name)
        if m:
            desc_paren = m.group(1).strip().lower(); name = (name[: m.start()] + name[m.end():]).strip()
        name = re.sub(r"\s+", " ", name).strip()
        name = name.title() if name.isupper() else name
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        descs = [by_id[j].get("text_corrected") or lines[j]["text"] for j in by_id if by_id[j]["role"] == "description" and by_id[j].get("dish_of") == i]
        price = lab.get("price")
        if price is None:
            for j, lj in by_id.items():
                if lj["role"] == "price" and lj.get("dish_of") == i:
                    mm = re.search(r"\d{1,3}[.,]\d{2}", lines[j]["text"]); price = float(mm.group(0).replace(",", ".")) if mm else None
        if isinstance(price, (int, float)) and price >= 100 and not re.search(r"\d[.,]\d{2}", l["text"]):
            price = round(price / 100, 2)          # OCR dropped the decimal point ("299" -> 2.99)
        if isinstance(price, (int, float)) and price > 500:
            price = None
        ingredients = [w.strip() for w in re.split(r"[,&/]| and ", desc_paren) if w.strip()] if desc_paren else None
        dishes.append({
            "id": slug(name), "name": name,
            "ingredients": ingredients,                      # restaurant-printed parenthetical only; null = unknown
            "removable": [],
            "price": price,
            "section_text": lab.get("section_text"),
            "category_printed": lab.get("category", "unknown"),
            "markers": lab.get("markers") or [],
            "layout": {"x": round(l["x"] / W, 4), "y": round(l["y"] / H, 4), "w": round(l["w"] / W, 4), "h": round(l["h"] / H, 4)},
            "ocr": l["text"],
            **({"notes": " ".join(descs)} if descs else {}),
        })
    return {"id": rid, "name": rname, "source": {"type": "photo", "url": None, "collected": date.today().isoformat()}, "rating": None,
            "menuImage": {"path": str(image_path), "widthPx": W, "heightPx": H, "widthCm": width_cm},
            "extraction": {"ocr_engine": engine, "vision_model": model, "ocr_lines": len(lines), "labelled": len(by_id)},
            "dishes": dishes}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image"); ap.add_argument("--restaurant-id", required=True); ap.add_argument("--restaurant-name", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--vision-model", default="auto", help="auto = first of " + ", ".join(VISION_MODELS) + " that loads"); ap.add_argument("--engine", default="rapidocr")
    ap.add_argument("--marker-width-cm", type=float, default=29.7)
    args = ap.parse_args()
    image = Path(args.image)
    t = time.time(); lines, (W, H) = ocr_lines(image, args.engine)
    print(f"OCR ({args.engine}): {len(lines)} lines in {time.time() - t:.1f}s", flush=True)
    t = time.time(); result, used = ask(args.vision_model, b64_image(image), lines)
    labels = result.get("lines", [])
    print(f"vision ({used}): {len(labels)} labels in {time.time() - t:.0f}s", flush=True)
    entry = build_entry(lines, labels, W, H, args.restaurant_id, args.restaurant_name, image, used, args.engine, args.marker_width_cm)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(entry, indent=2, ensure_ascii=False) + "\n")
    from collections import Counter
    print(f"{len(entry['dishes'])} dishes -> {args.out}; roles: {dict(Counter(l['role'] for l in labels))}")
    for d in entry["dishes"]:
        print(f"  {d['name']:<34} {str(d['price'] or '-'):>6}  {d['category_printed']:<10} {d['section_text'] or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

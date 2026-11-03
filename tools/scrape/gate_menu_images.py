#!/usr/bin/env python3
"""Stage C1: is this image a menu? Cheap gates first, vision model only when they disagree.

Input : images in the bronze store listed in data-lake/silver/menu_assets.jsonl (kind=image)
        and data-lake/silver/menu_photos.jsonl (listing photos)
Output: data-lake/silver/menu_gate.jsonl  {sha256, restaurant_id, verdict: menu|not_menu, price_count, ocr_lines, method}

Gates (DESIGN.md §7.1):
  0. readability (text_quality.image_quality): long side < 700 px, < 6 OCR lines, or mean OCR
     confidence < 0.70                                                                           -> not_menu
  1. price density: RapidOCR text with >= 5 price patterns, or >= 25 text lines with >= 2 prices  -> menu
  2. otherwise ask the local vision model MENU / NOT_MENU (same fallback list as label_menu_lines)
Images already judged are skipped (idempotent).

Usage:
    .venv/bin/python tools/scrape/gate_menu_images.py [--limit N] [--no-vision]
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ocr_engines import ocr_lines  # noqa: E402
from label_menu_lines import resolve_model  # noqa: E402
from text_quality import image_quality  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
PRICE_RE = re.compile(r"(?:\$\s?\d{1,3}(?:[.,]\d{2})?|\b\d{1,3}[.,]\d{2}\b)")
VISION_PROMPT = ("Is this photo a restaurant MENU (a printed or displayed list of dishes or drinks with names, usually with prices)? "
                 "Answer with exactly one word: MENU or NOT_MENU.")


def vision_verdict(image_path: Path, model: str) -> tuple[str, str]:
    from PIL import Image
    im = Image.open(image_path).convert("RGB"); im.thumbnail((1024, 1024))
    buf = io.BytesIO(); im.save(buf, format="JPEG", quality=85)
    b64 = base64.b64encode(buf.getvalue()).decode()
    import label_menu_lines as L
    if L.VLM_API == "openai":
        body = {"model": L.VLM_MODEL, "temperature": 0, "max_tokens": 5, "messages": [{"role": "user", "content": [
            {"type": "text", "text": VISION_PROMPT}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}}]}]}
        r = requests.post(L.VLM_BASE_URL.rstrip("/") + "/chat/completions", json=body, timeout=600)
        ans = r.json()["choices"][0]["message"]["content"].strip().upper() if r.status_code == 200 else ""
        return ("not_menu" if "NOT" in ans else "menu" if "MENU" in ans else "not_menu"), f"vllm:{L.VLM_MODEL}"
    for m in resolve_model(model):
        r = requests.post("http://localhost:11434/api/generate", json={"model": m, "prompt": VISION_PROMPT, "images": [b64], "stream": False,
                                                                        "options": {"temperature": 0, "num_predict": 5}}, timeout=600)
        if r.status_code != 200:
            continue
        ans = r.json().get("response", "").strip().upper()
        return ("not_menu" if "NOT" in ans else "menu" if "MENU" in ans else "not_menu"), m
    return "not_menu", "none"


def _ocr(path: str):
    """runs in a worker process: RapidOCR loads once per process"""
    return ocr_lines(Path(path))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lake", default=str(REPO / "data-lake"))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--vision-model", default="auto")
    ap.add_argument("--no-vision", action="store_true", help="price-density gate only")
    ap.add_argument("--rejudge", action="store_true", help="judge every image again (rules changed); rewrites menu_gate.jsonl")
    args = ap.parse_args()
    lake = Path(args.lake); silver = lake / "silver"
    out = silver / "menu_gate.jsonl"
    if args.rejudge and out.exists():
        out.rename(out.with_suffix(".jsonl.bak"))
    done = {json.loads(l)["sha256"] for l in out.read_text().splitlines() if l.strip()} if out.exists() else set()
    todo = {}
    for fn, kind_filter in (("menu_assets.jsonl", "image"), ("menu_photos.jsonl", None)):
        p = silver / fn
        if not p.exists():
            continue
        for l in p.read_text().splitlines():
            if not l.strip():
                continue
            row = json.loads(l)
            if kind_filter and row.get("kind") != kind_filter:
                continue
            if row["sha256"] not in done:
                todo.setdefault(row["sha256"], row)
    items = list(todo.values())[: args.limit] if args.limit else list(todo.values())
    print(f"{len(items)} images to judge ({len(done)} already done)")
    counts = {"menu": 0, "not_menu": 0}
    # OCR is CPU work: run it on every core at once (one process each), then decide; vision calls go to vLLM a few at a time
    import os
    from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
    ocr_workers = max(1, int(os.environ.get("OCR_WORKERS", str(max(2, (os.cpu_count() or 4) // 2)))))   # half the cores: crawl and browsers need the rest
    vision_workers = max(1, int(os.environ.get("VISION_WORKERS", "8")))
    paths = {row["sha256"]: lake / "bronze" / "assets" / row["sha256"][:2] / f"{row['sha256']}.{row.get('ext', 'jpg')}" for row in items}
    items = [row for row in items if paths[row["sha256"]].exists()]
    print(f"OCR on {ocr_workers} processes, vision on {vision_workers} threads", flush=True)
    ocr_out: dict[str, tuple] = {}
    with ProcessPoolExecutor(max_workers=ocr_workers) as pool:
        futs = {pool.submit(_ocr, str(paths[row["sha256"]])): row["sha256"] for row in items}
        for n, fut in enumerate(as_completed(futs)):
            sha = futs[fut]
            try:
                ocr_out[sha] = fut.result()
            except Exception as e:
                print(f"  OCR failed {sha[:12]}: {e.__class__.__name__}")
            if (n + 1) % 25 == 0:
                print(f"  OCR {n + 1}/{len(items)}", flush=True)

    def decide(row):
        sha = row["sha256"]
        if sha not in ocr_out:
            return None
        lines, (W, H) = ocr_out[sha]
        text = " ".join(l["text"] for l in lines)
        prices = len(PRICE_RE.findall(text))
        ok, why, mean_conf = image_quality(lines, W, H)
        if not ok:
            verdict, method = "not_menu", why
        elif prices >= 5 or (len(lines) >= 25 and prices >= 2):
            verdict, method = "menu", "price-density"
        elif args.no_vision:
            verdict, method = "not_menu", "undecided-no-vision"
        else:
            verdict, m = vision_verdict(paths[sha], args.vision_model); method = f"vision:{m}"
        return row, verdict, method, prices, len(lines), W, H, mean_conf

    with out.open("a") as f, ThreadPoolExecutor(max_workers=vision_workers) as pool:
        for i, fut in enumerate(as_completed([pool.submit(decide, row) for row in items])):
            res = fut.result()
            if res is None:
                continue
            row, verdict, method, prices, nlines, W, H, mean_conf = res
            counts[verdict] += 1
            f.write(json.dumps({"sha256": row["sha256"], "ext": row.get("ext", "jpg"), "restaurant_id": row["restaurant_id"], "verdict": verdict,
                                "price_count": prices, "ocr_lines": nlines, "w": W, "h": H, "mean_conf": mean_conf, "method": method,
                                "source_type": row.get("source_type", "website"), "page_url": row.get("page_url") or row.get("maps_url"),
                                "judged_at": datetime.now(timezone.utc).isoformat()}) + "\n")
            f.flush()
            print(f"  [{i + 1}/{len(items)}] {verdict:<8} {method:<22} prices={prices:<3} lines={nlines:<3} {W}x{H} conf={mean_conf:.2f} {row['restaurant_id']}")
    print(f"menus: {counts['menu']}, not menus: {counts['not_menu']} -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

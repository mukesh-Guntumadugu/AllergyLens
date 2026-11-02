#!/usr/bin/env python3
"""PDF menus -> page images (for the gate / OCR path) plus the text layer when there is one.

Input : data-lake/silver/menu_assets.jsonl rows with kind=pdf
Output: one PNG per page in the bronze store, appended to menu_assets.jsonl as kind=image
        (page_of=<pdf sha>, page=<n>), so gate_menu_images.py and process_menus.py treat them like photos.
        If the PDF has a text layer, its priced lines are also noted (text_lines) for later use.
Idempotent per PDF.

Usage:
    .venv/bin/python tools/scrape/pdf_menus.py [--max-pages 6] [--dpi 150]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PRICE_RE = re.compile(r"\$\s?\d{1,3}(?:[.,]\d{2})?\b")


def main() -> int:
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz  # older pymupdf

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lake", default=str(REPO / "data-lake"))
    ap.add_argument("--max-pages", type=int, default=6)
    ap.add_argument("--dpi", type=int, default=150)
    args = ap.parse_args()
    lake = Path(args.lake); assets_path = lake / "silver" / "menu_assets.jsonl"
    rows = [json.loads(l) for l in assets_path.read_text().splitlines() if l.strip()]
    done = {r.get("page_of") for r in rows if r.get("page_of")}
    pdfs = [r for r in rows if r["kind"] == "pdf" and r["sha256"] not in done]
    print(f"{len(pdfs)} PDFs to rasterise")
    new = 0
    with assets_path.open("a") as f:
        for r in pdfs:
            p = lake / "bronze" / "assets" / r["sha256"][:2] / f"{r['sha256']}.pdf"
            try:
                doc = fitz.open(p)
            except Exception as e:
                print(f"  {r['restaurant_id']}: cannot open ({e.__class__.__name__})"); continue
            for n, page in enumerate(doc):
                if n >= args.max_pages:
                    break
                pix = page.get_pixmap(dpi=args.dpi)
                png = pix.tobytes("png"); sha = hashlib.sha256(png).hexdigest()
                d = lake / "bronze" / "assets" / sha[:2]; d.mkdir(parents=True, exist_ok=True)
                (d / f"{sha}.png").write_bytes(png)
                text = page.get_text("text") or ""
                priced = [l.strip() for l in text.splitlines() if PRICE_RE.search(l)]
                with (lake / "bronze" / "manifest.jsonl").open("a") as mf:
                    mf.write(json.dumps({"sha256": sha, "url": r["url"], "source_type": "website-pdf-page", "content_type": "image/png", "bytes": len(png),
                                         "fetched_at": datetime.now(timezone.utc).isoformat(), "http_status": 200, "ext": "png", "restaurant_id": r["restaurant_id"], "page": n}) + "\n")
                f.write(json.dumps({"restaurant_id": r["restaurant_id"], "kind": "image", "sha256": sha, "ext": "png", "url": r["url"], "page_url": r.get("page_url"),
                                    "width": pix.width, "height": pix.height, "page_of": r["sha256"], "page": n, "text_lines": len(priced),
                                    "fetched_at": datetime.now(timezone.utc).isoformat()}) + "\n")
                new += 1
            print(f"  {r['restaurant_id']}: {min(len(doc), args.max_pages)} page(s) from {Path(r['url']).name[:50]}")
    print(f"{new} page images appended to {assets_path}. Next: gate_menu_images.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())

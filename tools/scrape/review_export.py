#!/usr/bin/env python3
"""Human-readable view of the lake: one folder per restaurant with its images under readable
names, plus data-lake/review/index.html (thumbnails, gate verdict, extracted dishes).

    .venv/bin/python tools/scrape/review_export.py      # then open data-lake/review/index.html
"""
from __future__ import annotations

import html
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def rows(p: Path):
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []


def main() -> int:
    lake = REPO / "data-lake"; silver = lake / "silver"; out = lake / "review"; out.mkdir(exist_ok=True)
    restaurants = {r["restaurant_id"]: r for r in rows(silver / "restaurants.jsonl")}
    gate = {g["sha256"]: g for g in rows(silver / "menu_gate.jsonl")}
    assets = rows(silver / "menu_assets.jsonl") + rows(silver / "menu_photos.jsonl")
    gate = dict(gate)
    gold = {p.stem: json.loads(p.read_text()) for p in (lake / "gold" / "menus").glob("*.json")} if (lake / "gold" / "menus").exists() else {}
    # extractions kept in the repo (e.g. data/menus/star-of-india/menu-1.labelled.json) show up too
    for lp in (REPO / "data" / "menus").glob("*/*.labelled.json"):
        e = json.loads(lp.read_text()); gold.setdefault(e["id"], e)
        mi = e.get("menuImage") or {}
        if mi.get("path"):
            assets.append({"restaurant_id": e["id"], "kind": "image", "sha256": "repo-" + lp.parent.name, "ext": Path(mi["path"]).suffix.lstrip("."),
                           "repo_path": mi["path"], "page_url": mi["path"]})
    gate["repo-star-of-india"] = {"verdict": "menu", "method": "hand-checked", "price_count": 31}
    by_rest: dict[str, list] = {}
    for a in assets:
        if a.get("kind", "image") in ("image", None) or "gallery_category" in a:
            by_rest.setdefault(a["restaurant_id"], []).append(a)
    parts = ["<!doctype html><meta charset=utf-8><title>AllergyLens data review</title>",
             "<style>body{font-family:sans-serif;margin:20px}img{height:150px;margin:4px;border:3px solid #ccc}img.menu{border-color:#2a2}img.not_menu{border-color:#c33}"
             "table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #ddd;padding:2px 6px}h2{margin-top:36px}.meta{color:#666;font-size:13px}</style>",
             f"<h1>AllergyLens data review</h1><p class=meta>{len(restaurants)} restaurants discovered, {len(by_rest)} with images, {sum(1 for g in gate.values() if g['verdict']=='menu')} images judged menus, {len(gold)} with extracted dishes. Green border = menu, red = not a menu, grey = not judged yet.</p>"]
    for rid, imgs in sorted(by_rest.items()):
        r = restaurants.get(rid) or next((g for g in gold.values() if g["id"] == rid), None) or {"name": rid}
        d = out / rid; d.mkdir(exist_ok=True)
        for stale in d.iterdir():   # verdicts change between runs; rebuild the folder's copies from scratch
            stale.unlink()
        parts.append(f"<h2>{html.escape(r['name'])} <span class=meta>{rid} · {html.escape(str(r.get('cuisine') or ''))} · <a href='{html.escape(str(r.get('website') or ''))}'>site</a></span></h2>")
        seen = set()
        for n, a in enumerate(imgs):
            if a["sha256"] in seen: continue
            seen.add(a["sha256"])
            src = (REPO / a["repo_path"]) if a.get("repo_path") else lake / "bronze" / "assets" / a["sha256"][:2] / f"{a['sha256']}.{a.get('ext','jpg')}"
            if not src.exists(): continue
            g = gate.get(a["sha256"]); cls = g["verdict"] if g else ""
            dst = d / f"{n:02d}-{cls or 'unjudged'}.{a.get('ext','jpg')}"
            if not dst.exists():
                dst.write_bytes(src.read_bytes())   # real copies, not hard links: viewers (and this app) refuse multi-linked files
            title = f"{cls or 'not judged'}; {g['method'] if g else ''}; prices={g['price_count'] if g else '?'}; from {a.get('page_url') or a.get('maps_url') or ''}"
            parts.append(f"<a href='{rid}/{dst.name}'><img class='{cls}' src='{rid}/{dst.name}' title='{html.escape(title)}'></a>")
        if rid in gold:
            e = gold[rid]
            parts.append(f"<p class=meta>Extracted with {html.escape(str(e.get('extraction',{}).get('vision_model','')))}: {len(e['dishes'])} dishes</p><table><tr><th>dish</th><th>price</th><th>category</th><th>section</th><th>markers</th><th>printed description</th></tr>")
            for dsh in e["dishes"]:
                parts.append(f"<tr><td>{html.escape(dsh['name'])}</td><td>{dsh.get('price') or ''}</td><td>{dsh.get('category_printed','')}</td><td>{html.escape(str(dsh.get('section_text') or ''))}</td><td>{', '.join(dsh.get('markers',[]))}</td><td>{html.escape(str(dsh.get('notes') or ''))}</td></tr>")
            parts.append("</table>")
    (out / "index.html").write_text("\n".join(parts))
    print(f"{len(by_rest)} restaurant folders -> {out}/  (open {out / 'index.html'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Source adapter: menu photos from a restaurant's Google Maps listing (web, not API).

OFF BY DEFAULT. This fetches pages from maps.google.com with a plain headless
browser, which Google's Maps terms do not permit (see tools/scrape/DESIGN.md §0.8
and §14). Enable it knowingly with --allow-google-maps-web. Rules this code follows:

  * no CAPTCHA solving, no bot-detection evasion, no user-agent spoofing; the
    browser is stock Chromium. If Google serves a block page ("unusual traffic",
    /sorry/) OR its "limited view" (what it serves to a browser it does not trust:
    no photo gallery, no menu photos, no reviews), the adapter raises Blocked,
    records it in the review queue and stops.

RESULT ON 2026-11-02 (GX10, stock headless Chromium, software GL): Google serves
the limited view on every listing tried, so this lane yields zero menu photos
without disguising the browser, which we do not do. Use the Places API photo
lane (sources/places_api_photos.py) or own captures instead.
  * slow: one listing at a time, a random 4-9 s pause between listings.
  * everything stored carries source_type = "google-maps-web" so it can be purged.

What it does per restaurant:
  1. open  https://www.google.com/maps/search/<name city state>
  2. if a results list shows, open the first result
  3. open the photo gallery's "Menu" category (falls back to "All" photos if the
     listing has no Menu category; those go through the menu gate later)
  4. scroll the gallery, collect photo URLs, download them (≤ --max-photos)
     into the bronze store, append rows to data-lake/silver/menu_photos.jsonl

Usage (single listing, for testing):
    .venv/bin/python tools/scrape/sources/google_maps_web.py --allow-google-maps-web \
        --query "Star of India, Athens, OH" --restaurant-id star-of-india --debug
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

REPO = Path(__file__).resolve().parents[3]
# user photos come from lh*.googleusercontent.com under a path prefix Google changes now and then: /p/, /gps-cs-s/, /grass-cs/ ...
PHOTO_RE = re.compile(r"https://lh\d\.googleusercontent\.com/(?:p|gps-cs-s|grass-cs|gps-proxy|[a-z]+-cs(?:-s)?)/[A-Za-z0-9_\-]{20,}(?:=[A-Za-z0-9\-]+)?")
BLOCK_MARKERS = ("unusual traffic", "/sorry/", "detected unusual", "not a robot", "recaptcha")


class Blocked(RuntimeError):
    pass


class NotFound(RuntimeError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def full_size(url: str) -> str:
    """Ask for a large rendition: strip the size suffix and request w2000."""
    base = url.split("=")[0]
    return base + "=w2000-h2000-k-no"


LIMITED = threading.local()          # per worker: did this listing come as Google's limited view
WRITE_LOCK = threading.Lock()       # one writer at a time for the jsonl files
STOP = threading.Event()            # set when any worker is blocked: every worker stops


def check_block(page) -> None:
    url = page.url.lower()
    try:
        if "limited view of google maps" in page.inner_text("body", timeout=3000).lower():
            LIMITED.seen = True      # limited view: no Menu category; a windowed browser still shows the top photos
    except Exception:
        pass
    if "/sorry/" in url or "consent.google" in url and "sorry" in url:
        raise Blocked(f"block page: {page.url}")
    try:
        body = page.inner_text("body", timeout=3000).lower()
    except Exception:
        return
    if any(m in body for m in BLOCK_MARKERS[:1] + BLOCK_MARKERS[2:]):
        raise Blocked("block text on page")


def dismiss_consent(page) -> None:
    """EU-style consent screen: pick the most privacy-preserving option if it shows."""
    if "consent.google" not in page.url:
        return
    for label in ("Reject all", "Alle ablehnen", "Tout refuser"):
        btn = page.get_by_role("button", name=label)
        if btn.count():
            btn.first.click()
            page.wait_for_load_state("networkidle", timeout=20000)
            return


def open_listing(page, query: str, debug: bool) -> dict:
    page.goto("https://www.google.com/maps/search/" + quote(query) + "?hl=en", wait_until="domcontentloaded", timeout=60000)
    try:
        page.wait_for_selector('h1, div[role="feed"], a[href*="/maps/place/"]', timeout=40000)
    except Exception:
        pass
    page.wait_for_timeout(1500)
    dismiss_consent(page)
    check_block(page)
    # results list (no h1 yet) -> click the first place link; a unique match lands on the place directly
    if page.locator("h1").count() == 0:
        links = page.locator('a[href*="/maps/place/"]')
        if links.count() == 0:
            page.wait_for_timeout(3000)
        if links.count() == 0:
            raise NotFound("no place result")
        links.first.click()
        page.wait_for_timeout(3000)
        check_block(page)
    h1 = page.locator("h1").first
    name = h1.inner_text(timeout=10000).strip() if h1.count() else ""
    maps_url = page.url
    m = re.search(r"!1s(0x[0-9a-f]+:0x[0-9a-f]+)", maps_url)
    cid = m.group(1) if m else None
    addr = ""
    addr_btn = page.locator('button[data-item-id="address"]')
    if addr_btn.count():
        addr = addr_btn.first.get_attribute("aria-label") or ""
        addr = addr.replace("Address: ", "").strip()
    if debug:
        print(f"    listing: {name!r} | {addr} | {maps_url[:90]}")
    return {"name": name, "address": addr, "maps_url": maps_url, "cid": cid}


def open_menu_gallery(page, debug: bool) -> str:
    """Open the photo gallery on the Menu category. Returns which category opened."""
    if getattr(LIMITED, "seen", False):
        # the gallery flag (!10e5) opens the photo grid; in the limited view it holds only the top photos, uncategorised
        target = page.url.split("?")[0]
        if "!10e5" not in target:
            target = re.sub(r"(\?.*)?$", "", page.url)
            target = target + ("" if target.endswith("!10e5") else "!10e5") + "?hl=en"
            page.goto(target, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(5000)
        return "top-photos-limited"
    # 1) category buttons under the header photo carousel ("All", "Menu", "Food & drink", ...)
    for label in ("Menu", "Menus"):
        btn = page.get_by_role("button", name=re.compile(rf"^{label}$", re.I))
        if btn.count():
            btn.first.click()
            page.wait_for_timeout(2500)
            return "menu"
    # 2) open "All" photos then look for a "Menu" tab inside the gallery
    opened = False
    for sel in ('button[aria-label^="Photo of"]', 'button[jsaction*="heroHeaderImage"]', 'button:has-text("All")'):
        loc = page.locator(sel)
        if loc.count():
            loc.first.click()
            page.wait_for_timeout(2500)
            opened = True
            break
    if not opened:
        raise NotFound("no photo gallery")
    tab = page.get_by_role("tab", name=re.compile(r"^Menu", re.I))
    if tab.count():
        tab.first.click()
        page.wait_for_timeout(2500)
        return "menu"
    btn = page.get_by_role("button", name=re.compile(r"^Menu", re.I))
    if btn.count():
        btn.first.click()
        page.wait_for_timeout(2500)
        return "menu"
    if debug:
        names = page.locator('[role="tab"], button').evaluate_all("els => els.map(e => (e.getAttribute('aria-label')||e.innerText||'').trim()).filter(t => t && t.length < 40).slice(0, 60)")
        print("    gallery controls:", names)
    return "all"


def collect_photo_urls(page, max_photos: int, debug: bool) -> list[str]:
    seen: list[str] = []
    stale = 0
    for _ in range(12):
        html = page.content()
        found = [u for u in PHOTO_RE.findall(html)]
        new = 0
        for u in found:
            key = u.split("=")[0]
            if key not in [s.split("=")[0] for s in seen]:
                seen.append(u)
                new += 1
        if debug:
            print(f"    gallery scan: {len(seen)} photos (+{new})")
            dbg = Path("data-lake/debug"); dbg.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(dbg / "maps-gallery.png"))
            srcs = page.locator("img").evaluate_all("els => els.map(e => e.currentSrc || e.src || '').filter(Boolean)")
            bgs = page.locator("[style*='background-image']").evaluate_all("els => els.map(e => e.style.backgroundImage).filter(Boolean)")
            hosts = {}
            for u in srcs + bgs:
                h = u.split("//")[-1].split("/")[0]; hosts[h] = hosts.get(h, 0) + 1
            print(f"    image hosts on page: {hosts}")
            print("    sample srcs:", [u[:110] for u in (srcs + bgs)[:6]])
        if len(seen) >= max_photos:
            break
        stale = stale + 1 if new == 0 else 0
        if stale >= 2:
            break
        # scroll the gallery pane (the dialog/aside that holds the tiles), else the page
        page.mouse.wheel(0, 2500)
        page.wait_for_timeout(1500)
    return seen[:max_photos]


def download(urls: list[str], bronze_root: Path, restaurant_id: str, maps_url: str, category: str) -> list[dict]:
    import requests

    assets = bronze_root / "assets"
    manifest = bronze_root / "manifest.jsonl"
    rows = []
    for u in urls:
        big = full_size(u)
        try:
            r = requests.get(big, timeout=60, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AllergyLens/0.2"})
            if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/"):
                continue
        except requests.RequestException:
            continue
        sha = hashlib.sha256(r.content).hexdigest()
        ext = "jpg" if "jpeg" in r.headers["content-type"] else r.headers["content-type"].split("/")[-1].split(";")[0]
        d = assets / sha[:2]
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{sha}.{ext}"
        if not p.exists():
            p.write_bytes(r.content)
        row = {"sha256": sha, "url": big, "source_type": "google-maps-web", "content_type": r.headers["content-type"], "bytes": len(r.content),
               "fetched_at": now(), "http_status": 200, "ext": ext, "restaurant_id": restaurant_id, "maps_url": maps_url, "gallery_category": category}
        with WRITE_LOCK, manifest.open("a") as f:
            f.write(json.dumps(row) + "\n")
        rows.append(row)
        time.sleep(random.uniform(0.4, 1.0))
    return rows


def scrape_listing(page, query: str, restaurant_id: str, lake: Path, max_photos: int, debug: bool) -> dict:
    info = open_listing(page, query, debug)
    category = open_menu_gallery(page, debug)
    check_block(page)
    urls = collect_photo_urls(page, max_photos, debug)
    rows = download(urls, lake / "bronze", restaurant_id, info["maps_url"], category)
    out = lake / "silver" / "menu_photos.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    with WRITE_LOCK, out.open("a") as f:
        for r in rows:
            f.write(json.dumps({"restaurant_id": restaurant_id, "sha256": r["sha256"], "ext": r["ext"], "gallery_category": category,
                                "listing_name": info["name"], "listing_address": info["address"], "maps_url": info["maps_url"],
                                "cid": info["cid"], "source_type": "google-maps-web", "fetched_at": r["fetched_at"]}) + "\n")
    return {"restaurant_id": restaurant_id, "listing": info, "category": category, "photos": len(rows)}


def record_block(lake: Path, detail: str) -> None:
    q = lake / "silver" / "review_queue.jsonl"
    q.parent.mkdir(parents=True, exist_ok=True)
    with WRITE_LOCK, q.open("a") as f:
        f.write(json.dumps({"kind": "blocked_source", "source": "google-maps-web", "detail": detail, "created_at": now()}) + "\n")


def log_job(lake: Path, row: dict) -> None:
    """one line per listing tried -> data-lake/silver/maps_log.jsonl (resume: a listing is not retried for 30 days)"""
    q = lake / "silver" / "maps_log.jsonl"
    q.parent.mkdir(parents=True, exist_ok=True)
    with WRITE_LOCK, q.open("a") as f:
        f.write(json.dumps({**row, "finished_at": now()}) + "\n")


def run(jobs: list[dict], lake: Path, max_photos: int, debug: bool, headless: bool = True, worker: int = 0, total: int | None = None) -> list[dict]:
    """jobs: [{query, restaurant_id}]. One browser; stops at the first block page (and tells the other workers to stop)."""
    from playwright.sync_api import sync_playwright

    results = []
    total = total or len(jobs)
    tag = f"w{worker} " if worker else ""
    with sync_playwright() as pw:
        # software GL: Google Maps renders nothing in headless Chromium without it. Windowed (--headed, needs a DISPLAY)
        # is placed off-screen; Google's limited view shows the gallery's top photos only to a windowed browser.
        args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        if not headless:
            args += ["--window-position=3000,3000", "--window-size=1300,900"]
        browser = pw.chromium.launch(headless=headless, args=args)
        ctx = browser.new_context(locale="en-US", viewport={"width": 1400, "height": 900})
        page = ctx.new_page()
        for i, job in enumerate(jobs):
            if STOP.is_set():
                print(f"    {tag}stopping: another worker was blocked", file=sys.stderr); break
            print(f"[{tag}{i + 1}/{len(jobs)}] {job['query']}")
            LIMITED.seen = False
            try:
                res = scrape_listing(page, job["query"], job["restaurant_id"], lake, max_photos, debug)
                print(f"    -> {res['photos']} photos from the '{res['category']}' gallery" + (" (Google limited view: top photos only, no Menu category)" if getattr(LIMITED, "seen", False) else ""))
                if getattr(LIMITED, "seen", False) and res["photos"] == 0 and headless:
                    print("    limited view in HEADLESS mode exposes no photos at all; run with --headed on a machine with a display", file=sys.stderr)
                    record_block(lake, "limited view, headless: no photos; use --headed")
                    break
                results.append(res)
                log_job(lake, {"restaurant_id": job["restaurant_id"], "photos": res["photos"], "category": res["category"]})
            except Blocked as e:
                print(f"    BLOCKED by Google ({e}); stopping as designed.", file=sys.stderr)
                record_block(lake, str(e)); STOP.set()
                break
            except Blocked as e:  # pragma: no cover
                print(f"    BLOCKED by Google ({e}); stopping as designed.", file=sys.stderr)
                record_block(lake, str(e))
                if debug:
                    page.screenshot(path=str(lake / "blocked.png"))
                break
            except NotFound as e:
                print(f"    not found: {e}")
                results.append({"restaurant_id": job["restaurant_id"], "photos": 0, "error": str(e)})
                log_job(lake, {"restaurant_id": job["restaurant_id"], "photos": 0, "error": str(e)[:200]})
            except Exception as e:  # keep going on one bad listing
                print(f"    error: {e.__class__.__name__}: {str(e)[:120]}")
                if debug:
                    page.screenshot(path=str(lake / f"error-{job['restaurant_id']}.png"))
                results.append({"restaurant_id": job["restaurant_id"], "photos": 0, "error": str(e)[:200]})
            if i + 1 < len(jobs):
                time.sleep(random.uniform(4, 9))
        browser.close()
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--allow-google-maps-web", action="store_true", help="required; see DESIGN.md §0.8")
    ap.add_argument("--query", help='e.g. "Star of India, Athens, OH"')
    ap.add_argument("--restaurant-id", help="id used in data/ and the lake")
    ap.add_argument("--jobs", help="JSONL file with {query, restaurant_id} per line")
    ap.add_argument("--lake", default=str(REPO / "data-lake"))
    ap.add_argument("--max-photos", type=int, default=15)
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--headed", action="store_true", help="show the browser window (needs a display)")
    ap.add_argument("--force", action="store_true", help="retry listings done in the last 30 days too")
    ap.add_argument("--limit", type=int, default=None, help="at most this many listings this run")
    ap.add_argument("--parallel", type=int, default=int(os.environ.get("MAPS_PARALLEL", "8")), help="browser windows at the same time, each on its own slice of the list; env MAPS_PARALLEL")
    args = ap.parse_args()
    if not args.allow_google_maps_web:
        sys.exit("refusing: this adapter breaches Google Maps' terms (DESIGN.md §0.8). Pass --allow-google-maps-web to run it knowingly.")
    jobs = []
    if args.jobs:
        jobs = [json.loads(l) for l in Path(args.jobs).read_text().splitlines() if l.strip()]
    elif args.query and args.restaurant_id:
        jobs = [{"query": args.query, "restaurant_id": args.restaurant_id}]
    else:
        sys.exit("give --query and --restaurant-id, or --jobs")
    lake = Path(args.lake)
    log = lake / "silver" / "maps_log.jsonl"
    if log.exists() and not args.force:
        from datetime import datetime, timedelta, timezone
        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        done = {json.loads(l)["restaurant_id"] for l in log.read_text().splitlines() if l.strip() and json.loads(l).get("finished_at", "") >= cutoff}
        before = len(jobs); jobs = [j for j in jobs if j["restaurant_id"] not in done]
        if before - len(jobs):
            print(f"{before - len(jobs)} listings done in the last 30 days skipped (maps_log.jsonl); --force to redo")
    if args.limit:
        jobs = jobs[: args.limit]
    if not jobs:
        print("nothing to do"); return 0
    n = max(1, min(args.parallel, len(jobs)))
    if n == 1:
        results = run(jobs, lake, args.max_photos, args.debug, headless=not args.headed)
    else:
        # round-robin slices, one browser per worker (each thread owns its own Playwright instance), staggered starts
        slices = [jobs[k::n] for k in range(n)]
        print(f"{len(jobs)} listings, {n} browsers in parallel ({', '.join(str(len(sl)) for sl in slices)} each)", flush=True)
        results = []
        def worker(k):
            time.sleep(k * 3)
            return run(slices[k], lake, args.max_photos, args.debug, headless=not args.headed, worker=k + 1, total=len(jobs))
        with ThreadPoolExecutor(max_workers=n) as pool:
            for part in pool.map(worker, range(n)):
                results.extend(part)
    print(f"done: {len(results)} listings, {sum(r.get('photos', 0) for r in results)} photos" + (" (stopped early: blocked)" if STOP.is_set() else ""))
    print(json.dumps(results, indent=2)[:3000])
    return 0


if __name__ == "__main__":
    sys.exit(main())

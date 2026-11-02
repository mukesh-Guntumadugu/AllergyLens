#!/usr/bin/env python3
"""Lane 3 (website): find menus on restaurants' own websites.

Input : data-lake/silver/restaurants.jsonl (rows with a `website`)
Output: raw pages / PDFs / images in data-lake/bronze/ and one row per menu asset in
        data-lake/silver/menu_assets.jsonl:
          {restaurant_id, kind: jsonld | html-menu | pdf | image, sha256, url, page_url, items?}
        JSON-LD Menu items (already structured) also go to data-lake/silver/menu_jsonld.jsonl.

Polite: robots.txt honoured, one request every 0.5 s per host, <= 20 pages and 120 s per site,
depth <= 2, identifies itself. JS-only sites are rendered once with Playwright (stock Chromium).
Sites are crawled 8 at a time (one thread per site; the pause is per site, so per host).

Chains: a brand domain (mcdonalds.com, subway.com, ...; known list plus any domain shared by
3+ restaurants) is crawled once, from its home page, and recorded in
data-lake/silver/brand_crawl.jsonl. Every other location of that brand gets a crawl_log row
{chain_of: domain} and no crawl: locator pages hold no menu, and the menu is national anyway.

Usage:
    .venv/bin/python tools/scrape/acquire_websites.py [--limit 10] [--restaurant star-of-india-athens] [--workers 8]
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import time
import urllib.robotparser as robotparser
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import socket
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from bs4 import BeautifulSoup

socket.setdefaulttimeout(20)   # robots.txt is read with urllib, which otherwise has NO timeout and can hang a whole run

REPO = Path(__file__).resolve().parents[2]
UA = "AllergyLens/0.2 (hackathon project; github.com/mukesh-Guntumadugu/AllergyLens)"
HDRS = {"User-Agent": UA, "Accept-Encoding": "gzip, deflate"}
MENU_WORDS = re.compile(r"menu|food|dinner|lunch|breakfast|brunch|eat|dishes|carte|specials|drinks|beer|wine|cocktail", re.I)
ORDER_WORDS = re.compile(r"order", re.I)
PLATFORM_HOSTS = ("toasttab.com", "square.site", "squareup.com", "popmenu.com", "clover.com", "chownow.com", "menufy.com",
                  "gloriafood.com", "owner.com", "bentobox", "getbento.com", "spoton.com", "slicelife.com", "zmenu.com", "singleplatform.com")
BLOCKED_HOSTS = ("doordash.com", "grubhub.com", "ubereats.com", "yelp.com", "facebook.com", "instagram.com", "google.com", "tripadvisor.com")
PRICE_RE = re.compile(r"\$\s?\d{1,3}(?:[.,]\d{2})?\b")
IMG_MIN_BYTES = 40_000
IMG_MIN_SIDE = 600
# national chains whose per-location pages are store locators: crawl the brand once, skip the locations
CHAIN_DOMAINS = {
    "mcdonalds.com", "subway.com", "tacobell.com", "bk.com", "burgerking.com", "wendys.com", "dominos.com", "pizzahut.com",
    "kfc.com", "littlecaesars.com", "papajohns.com", "starbucks.com", "dunkindonuts.com", "dunkin.com", "arbys.com",
    "sonicdrivein.com", "dairyqueen.com", "chick-fil-a.com", "chipotle.com", "pandaexpress.com", "popeyes.com", "wingstop.com",
    "jimmyjohns.com", "jerseymikes.com", "firehousesubs.com", "pennstation.com", "applebees.com", "bobevans.com",
    "buffalowildwings.com", "perkinsrestaurants.com", "dennys.com", "ihop.com", "crackerbarrel.com", "olivegarden.com",
    "redlobster.com", "texasroadhouse.com", "outback.com", "chilis.com", "tgifridays.com", "goldencorral.com", "waffle-house.com",
    "wafflehouse.com", "whitecastle.com", "fiveguys.com", "culvers.com", "steak-n-shake.com", "steaknshake.com", "hardees.com",
    "carlsjr.com", "jackinthebox.com", "longjohnsilvers.com", "captainds.com", "churchs.com", "bojangles.com", "zaxbys.com",
    "raisingcanes.com", "cfacdn.com", "qdoba.com", "moes.com", "noodles.com", "pandarg.com", "panerabread.com", "einsteinbros.com",
    "timhortons.com", "biggby.com", "sbarro.com", "cicis.com", "marcos.com", "donatos.com", "eastofchicago.com", "hungryhowies.com",
    "skylinechili.com", "goldstarchili.com", "frischs.com", "tacotapatiooh.com", "rallys.com", "checkers.com", "a-w.com", "awrestaurants.com",
    "freddys.com", "cookout.com", "bigboy.com", "friendlys.com", "ruthschris.com", "longhornsteakhouse.com", "redrobin.com",
    "cheesecakefactory.com", "pfchangs.com", "hooters.com", "twinpeaksrestaurant.com", "ladybirdcafe.com", "sheetz.com", "wawa.com",
    "caseys.com", "speedway.com", "pilotflyingj.com", "loves.com", "ta-petro.com",
}
LOCATOR_HINTS = ("/locations/", "/location/", "/store-locator", "/stores/", "/restaurants/", "/find-", "/l/", "/us/en-us/location/")
# hosts many unrelated restaurants share (site builders, ordering platforms, social pages): never a chain
GENERIC_HOSTS = ("facebook.com", "instagram.com", "google.com", "yelp.com", "wixsite.com", "wix.com", "godaddysites.com", "weebly.com",
                 "squarespace.com", "wordpress.com", "business.site", "linktr.ee", "m.me", "webs.com", "yolasite.com", "sites.google.com",
                 "menupages.com", "zomato.com", "doordash.com", "grubhub.com", "ubereats.com", "tripadvisor.com", "restaurantji.com",
                 "allmenus.com", "menuism.com", "untappd.com", "bit.ly", "wa.me", "ohio.gov") + PLATFORM_HOSTS


def brand_domain(url: str) -> str:
    """registered domain of a website url: https://locations.subway.com/x -> subway.com"""
    h = urlparse(url if url.startswith("http") else "https://" + url).netloc.lower().split(":")[0]
    parts = [x for x in h.split(".") if x]
    return ".".join(parts[-2:]) if len(parts) >= 2 else h


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Bronze:
    def __init__(self, root: Path):
        self.assets = root / "assets"; self.assets.mkdir(parents=True, exist_ok=True)
        self.manifest = root / "manifest.jsonl"
        self.lock = threading.Lock()      # several sites write the manifest at once

    def put(self, url: str, body: bytes, content_type: str, source_type: str, ext: str, **extra) -> str:
        sha = hashlib.sha256(body).hexdigest()
        d = self.assets / sha[:2]; d.mkdir(exist_ok=True)
        p = d / f"{sha}.{ext}"
        if not p.exists():
            p.write_bytes(body)
        with self.lock, self.manifest.open("a") as f:
            f.write(json.dumps({"sha256": sha, "url": url, "source_type": source_type, "content_type": content_type, "bytes": len(body),
                                "fetched_at": now(), "http_status": 200, "ext": ext, **extra}) + "\n")
        return sha


class Site:
    def __init__(self, start: str, bronze: Bronze, restaurant_id: str, pause: float = 0.5, max_pages: int = 20,
                 budget_s: int = 120, max_images: int = 25):
        self.start = start if start.startswith("http") else "https://" + start
        self.t0, self.budget_s, self.max_images = time.time(), budget_s, max_images
        self.host = urlparse(self.start).netloc.lower().removeprefix("www.")
        self.bronze, self.rid, self.pause, self.max_pages = bronze, restaurant_id, pause, max_pages
        self.rp = robotparser.RobotFileParser()
        try:
            r = requests.get(urljoin(self.start, "/robots.txt"), headers=HDRS, timeout=15)
            if r.status_code == 200:
                self.rp.parse(r.text.splitlines())
            else:
                self.rp = None
        except Exception:
            self.rp = None
        self.visited: set[str] = set()
        self.assets: list[dict] = []
        self.jsonld_items: list[dict] = []
        self._pw = None

    def allowed(self, url: str) -> bool:
        try:
            return self.rp is None or self.rp.can_fetch(UA, url)
        except Exception:
            return True

    def same_site(self, url: str) -> bool:
        h = urlparse(url).netloc.lower().removeprefix("www.")
        return h == self.host or h.endswith("." + self.host) or any(p in h for p in PLATFORM_HOSTS)

    def get(self, url: str, timeout: int = 25) -> requests.Response | None:
        if not self.allowed(url):
            return None
        try:
            time.sleep(self.pause)
            return requests.get(url, headers=HDRS, timeout=timeout, allow_redirects=True)
        except requests.RequestException:
            return None

    def render(self, url: str) -> str | None:
        """JS-only page: render once with stock Chromium."""
        try:
            from playwright.sync_api import sync_playwright
            if self._pw is None:
                self._pw = sync_playwright().start()
                self._browser = self._pw.chromium.launch(headless=True)
            if time.time() - self.t0 > self.budget_s:
                return None
            page = self._browser.new_page(user_agent=UA)
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
            page.wait_for_timeout(3000)
            html = page.content(); page.close()
            return html
        except Exception:
            return None

    def close(self):
        if self._pw:
            try:
                self._browser.close(); self._pw.stop()
            except Exception:
                pass

    # ---- extraction -------------------------------------------------------
    def jsonld_menu(self, soup: BeautifulSoup, page_url: str) -> list[dict]:
        items = []
        def walk(o, section=None):
            if isinstance(o, dict):
                t = o.get("@type"); t = t if isinstance(t, str) else (t[0] if isinstance(t, list) and t else "")
                if t == "MenuSection":
                    section = o.get("name") or section
                if t == "MenuItem":
                    offers = o.get("offers") or {}
                    if isinstance(offers, list): offers = offers[0] if offers else {}
                    items.append({"name": o.get("name"), "description": o.get("description"), "price": offers.get("price") if isinstance(offers, dict) else None,
                                  "section": section, "suitableForDiet": o.get("suitableForDiet"), "page_url": page_url})
                for v in o.values(): walk(v, section)
            elif isinstance(o, list):
                for v in o: walk(v, section)
        for tag in soup.find_all("script", attrs={"type": re.compile("ld\\+json", re.I)}):
            try:
                walk(json.loads(tag.string or tag.get_text() or "null"))
            except Exception:
                continue
        return [i for i in items if i.get("name")]

    def html_menu_lines(self, soup: BeautifulSoup) -> list[str]:
        """Text blocks that carry a price; cheap signal that a page is a menu."""
        for t in soup(["script", "style", "noscript"]): t.decompose()
        lines = [re.sub(r"\s+", " ", l).strip() for l in soup.get_text("\n").split("\n")]
        return [l for l in lines if l and PRICE_RE.search(l) and len(l) < 160]

    def images_on(self, soup: BeautifulSoup, page_url: str, menuish: bool) -> list[str]:
        out = []
        for img in soup.find_all("img"):
            src = img.get("src") or img.get("data-src") or ""
            if not src or src.startswith("data:"): continue
            u = urljoin(page_url, src)
            alt = (img.get("alt") or "") + " " + src
            if MENU_WORDS.search(alt) or menuish:
                out.append(u)
        return list(dict.fromkeys(out))[:20]

    def download_image(self, u: str, page_url: str) -> None:
        r = self.get(u, timeout=40)
        if not r or r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/") or len(r.content) < IMG_MIN_BYTES:
            return
        try:
            from PIL import Image
            im = Image.open(io.BytesIO(r.content)); w, h = im.size
        except Exception:
            return
        if min(w, h) < IMG_MIN_SIDE:
            return
        ext = (im.format or "jpg").lower().replace("jpeg", "jpg")
        sha = self.bronze.put(u, r.content, r.headers["content-type"], "website", ext, restaurant_id=self.rid, page_url=page_url)
        self.assets.append({"restaurant_id": self.rid, "kind": "image", "sha256": sha, "ext": ext, "url": u, "page_url": page_url, "width": w, "height": h})

    def crawl(self) -> None:
        queue: list[tuple[str, int, bool]] = [(self.start, 0, False)]
        while queue and len(self.visited) < self.max_pages:
            if time.time() - self.t0 > self.budget_s:
                print(f"    time budget ({self.budget_s}s) reached; moving on", flush=True); break
            url, depth, menuish = queue.pop(0)
            key = url.split("#")[0].rstrip("/")
            if key in self.visited: continue
            self.visited.add(key)
            r = self.get(url)
            if r is None or r.status_code != 200: continue
            ct = r.headers.get("content-type", "")
            if "pdf" in ct or url.lower().endswith(".pdf"):
                sha = self.bronze.put(url, r.content, ct, "website", "pdf", restaurant_id=self.rid)
                self.assets.append({"restaurant_id": self.rid, "kind": "pdf", "sha256": sha, "ext": "pdf", "url": url, "page_url": url})
                continue
            if "html" not in ct: continue
            html = r.text
            soup = BeautifulSoup(html, "html.parser")
            if len(soup.get_text(" ", strip=True)) < 300 and depth == 0:  # JS shell
                rendered = self.render(url)
                if rendered:
                    html = rendered; soup = BeautifulSoup(html, "html.parser")
            page_sha = self.bronze.put(url, html.encode("utf-8", "ignore"), "text/html", "website", "html", restaurant_id=self.rid)
            items = self.jsonld_menu(soup, url)
            if items:
                self.jsonld_items.extend(items)
                self.assets.append({"restaurant_id": self.rid, "kind": "jsonld", "sha256": page_sha, "ext": "html", "url": url, "page_url": url, "items": len(items)})
            priced = self.html_menu_lines(soup)
            is_menu_page = menuish or bool(MENU_WORDS.search(urlparse(url).path)) or len(priced) >= 8
            if len(priced) >= 5:
                self.assets.append({"restaurant_id": self.rid, "kind": "html-menu", "sha256": page_sha, "ext": "html", "url": url, "page_url": url, "items": len(priced), "sample": priced[:5]})
            for u in self.images_on(soup, url, is_menu_page):   # images may live on a CDN, so no same-site check
                if sum(1 for a in self.assets if a["kind"] == "image") >= self.max_images or time.time() - self.t0 > self.budget_s:
                    break
                self.download_image(u, url)
            if depth >= 2: continue
            for a in soup.find_all("a", href=True):
                href = urljoin(url, a["href"]).split("#")[0]
                text = (a.get_text(" ", strip=True) or "") + " " + href
                host = urlparse(href).netloc.lower()
                if not href.startswith("http") or any(b in host for b in BLOCKED_HOSTS): continue
                if not self.same_site(href) and not any(p in host for p in PLATFORM_HOSTS): continue
                if MENU_WORDS.search(text) or ORDER_WORDS.search(text) or href.lower().endswith(".pdf"):
                    queue.append((href, depth + 1, bool(MENU_WORDS.search(text))))
                elif depth == 0 and self.same_site(href):
                    queue.append((href, depth + 1, False))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lake", default=str(REPO / "data-lake"))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--restaurant", default=None)
    ap.add_argument("--budget", type=int, default=120, help="seconds per site")
    ap.add_argument("--max-pages", type=int, default=20, help="pages per site")
    ap.add_argument("--max-images", type=int, default=25, help="images per site")
    ap.add_argument("--workers", type=int, default=8, help="sites crawled at the same time")
    ap.add_argument("--force", action="store_true", help="re-crawl sites already in crawl_log.jsonl")
    args = ap.parse_args()
    lake = Path(args.lake)
    rows = [json.loads(l) for l in (lake / "silver" / "restaurants.jsonl").read_text().splitlines() if l.strip()]
    rows = [r for r in rows if r.get("website") and (not args.restaurant or r["restaurant_id"] == args.restaurant)]
    if args.limit: rows = rows[: args.limit]
    bronze = Bronze(lake / "bronze")
    out = lake / "silver" / "menu_assets.jsonl"; out_items = lake / "silver" / "menu_jsonld.jsonl"
    crawl_log = lake / "silver" / "crawl_log.jsonl"   # one row per finished site -> resume support
    done_ids = {json.loads(l)["restaurant_id"] for l in crawl_log.read_text().splitlines() if l.strip()} if crawl_log.exists() else set()
    if not args.force:
        skipped = [r for r in rows if r["restaurant_id"] in done_ids]
        rows = [r for r in rows if r["restaurant_id"] not in done_ids]
        if skipped: print(f"{len(skipped)} sites already crawled (crawl_log.jsonl); --force to redo")
    totals = {"jsonld": 0, "html-menu": 0, "pdf": 0, "image": 0}

    # ── chains: one crawl per brand domain, locations skipped ──────────────────────────────────────────
    all_rows = [json.loads(l) for l in (lake / "silver" / "restaurants.jsonl").read_text().splitlines() if l.strip()]
    domain_count: dict[str, int] = {}
    for r in all_rows:
        if r.get("website"):
            d = brand_domain(r["website"]); domain_count[d] = domain_count.get(d, 0) + 1
    def is_chain(url: str) -> bool:
        d = brand_domain(url)
        if any(g == d or g.endswith("." + d) or d.endswith("." + g) or g in url.lower() for g in GENERIC_HOSTS):
            return False
        return d in CHAIN_DOMAINS or domain_count.get(d, 0) >= 3 or any(h in urlparse(url).path.lower() + "/" for h in LOCATOR_HINTS)
    brand_log = lake / "silver" / "brand_crawl.jsonl"
    brands_done = {json.loads(l)["domain"]: json.loads(l) for l in brand_log.read_text().splitlines() if l.strip()} if brand_log.exists() else {}
    jobs: list[tuple[dict, str, str | None]] = []       # (row, start url, brand domain or None)
    skipped_chain = 0
    claimed: set[str] = set()
    for r in rows:
        if not is_chain(r["website"]):
            jobs.append((r, r["website"], None)); continue
        d = brand_domain(r["website"])
        if d in brands_done or d in claimed:
            skipped_chain += 1
            with crawl_log.open("a") as f:
                f.write(json.dumps({"restaurant_id": r["restaurant_id"], "website": r["website"], "pages": 0, "kinds": {},
                                    "chain_of": d, "finished_at": now()}) + "\n")
            continue
        claimed.add(d)
        jobs.append((r, f"https://{d}/", d))            # the brand's home page, not the store locator
    if skipped_chain:
        print(f"{skipped_chain} chain locations skipped (brand crawled once; see brand_crawl.jsonl)")
    print(f"{len(jobs)} sites to crawl, {args.workers} at a time, {args.budget}s / {args.max_pages} pages each", flush=True)

    def crawl_one(job):
        r, start_url, brand = job
        site = Site(start_url, bronze, r["restaurant_id"], budget_s=args.budget, max_pages=args.max_pages, max_images=args.max_images)
        err = None
        try:
            site.crawl()
        except Exception as e:
            err = f"{e.__class__.__name__}: {str(e)[:100]}"
        finally:
            site.close()
        return job, site, err

    pool = ThreadPoolExecutor(max_workers=max(1, args.workers))
    futures = [pool.submit(crawl_one, j) for j in jobs]
    for i, fut in enumerate(as_completed(futures)):
        (r, start_url, brand), site, err = fut.result()
        kinds = {}
        for a in site.assets:
            kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1; totals[a["kind"]] += 1
        with out.open("a") as f:
            for a in site.assets: f.write(json.dumps({**a, "fetched_at": now()}) + "\n")
        with out_items.open("a") as f:
            for it in site.jsonld_items: f.write(json.dumps({**it, "restaurant_id": r["restaurant_id"]}) + "\n")
        with crawl_log.open("a") as f:
            f.write(json.dumps({"restaurant_id": r["restaurant_id"], "website": start_url, "pages": len(site.visited), "kinds": kinds,
                                **({"brand": brand} if brand else {}), "finished_at": now()}) + "\n")
        if brand:
            with brand_log.open("a") as f:
                f.write(json.dumps({"domain": brand, "restaurant_id": r["restaurant_id"], "pages": len(site.visited), "kinds": kinds,
                                    "finished_at": now()}) + "\n")
        tag = f"  [brand {brand}]" if brand else ""
        print(f"[{i + 1}/{len(jobs)}] {r['name']}  {start_url}{tag}\n    pages {len(site.visited)} -> {kinds or 'nothing menu-like'}"
              + (f"  (error: {err})" if err else ""), flush=True)
    pool.shutdown()
    print(f"\nTOTAL {totals} -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

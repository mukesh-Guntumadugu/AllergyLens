#!/usr/bin/env python3
"""Stage E: dish name -> ingredients by WEB RETRIEVAL with citations (no LLM facts).

Replaces enrich_dishes.py. For every menu dish not yet in the dish catalog
(seed data/dishes.json plus the scraped data-lake/gold/dishes.json) this script:

  1. searches the web for recipes of the dish        (ddg | brave | searxng)
  2. fetches the result pages into the bronze store   (data-lake/bronze/, by content hash)
  3. reads the ingredient list from each page's schema.org Recipe markup
     (JSON-LD `recipeIngredient`, microdata fallback) -- prose is never parsed
  4. keeps only recipes that are the same dish (name-token check; optional local judge model)
  5. parses each ingredient string deterministically ("2 tbsp ghee, melted" -> "ghee")
  6. votes: support = recipes containing the ingredient / recipes accepted
  7. writes the catalog entry with per-ingredient source URLs,
     or marks the dish UNKNOWN when fewer than --min-recipes recipes agree.

Cache-first: a dish already in the catalog is not researched again; its
seen_count / last_seen are bumped instead. --force re-researches.

No LLM is involved by default. --judge-model <ollama model> adds a local model
that only answers "is recipe X the same dish as menu item Y?" for the ambiguous
band; it never supplies ingredients.

Usage:
    python3 tools/scrape/ingredients_rag.py data/menus.json --restaurant star-of-india --cuisine Indian
    python3 tools/scrape/ingredients_rag.py data/menus/star-of-india/menu-1.ocr.json --cuisine Indian --force
    python3 tools/scrape/ingredients_rag.py data/menus.json --search brave   # BRAVE_API_KEY in env
    python3 tools/scrape/ingredients_rag.py data/menus.json --search searxng --searxng-url http://localhost:8080

Output: entries in data-lake/gold/dishes.json (see tools/scrape/DESIGN.md §9; the
committed seed data/dishes.json is read but never written, so scraper output stays
out of git), unknown dishes in data-lake/silver/review_queue.jsonl, raw pages in
data-lake/bronze/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import date, timedelta, datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

UA = {"User-Agent": "AllergyLens/0.2 (hackathon project; github.com/mukesh-Guntumadugu/AllergyLens)",
      "Accept-Encoding": "gzip, deflate"}
REPO = Path(__file__).resolve().parents[2]

# ─── name normalisation ──────────────────────────────────────────────────────
# Menu spellings -> the spelling recipe sites use. Data, not model output.
TRANSLITERATION = {
    "nan": "naan", "alu": "aloo", "aaloo": "aloo", "channa": "chana", "chole": "chole", "choley": "chole",
    "mutter": "matar", "mattar": "matar", "muttar": "matar", "bengan": "baingan", "began": "baingan",
    "bartha": "bharta", "bhartha": "bharta", "shai": "shahi", "kurma": "korma", "paratha": "paratha",
    "parantha": "paratha", "panir": "paneer", "pulao": "pulao", "pilau": "pulao", "dal": "dal", "dhal": "dal",
    "daal": "dal", "saag": "saag", "sag": "saag", "jamun": "jamun", "jamoon": "jamun", "gulab": "gulab",
    "tikka": "tikka", "tika": "tikka", "biriyani": "biryani", "briyani": "biryani", "samosa": "samosa",
    "pakora": "pakora", "pakoda": "pakora", "raitha": "raita", "lassi": "lassi", "chai": "chai",
    "navrattan": "navratan", "navarathna": "navratan",
}
# whole menu phrases -> the name recipe sites use (checked before tokenising)
ALIAS_PHRASES = {"indian tea": "masala chai", "masala tea": "masala chai", "chai tea": "masala chai",
                 "regular naan": "naan", "plain naan": "naan", "regular nan": "naan",
                 "mac n cheese": "macaroni and cheese", "mac and cheese": "macaroni and cheese", "mac & cheese": "macaroni and cheese",
                 "pulledpork": "pulled pork", "pulled pork sandwich": "pulled pork sandwich",
                 "americano": "americano coffee", "breve": "breve coffee", "latte": "latte coffee", "mocha": "mocha coffee",
                 "cortado": "cortado coffee", "macchiato": "macchiato coffee"}
# menu scaffolding that OCR hands us as a "dish": section headers, instructions, slogans
MENU_SCAFFOLD = ("choose one", "choose your", "choose a", "pick one", "pick your", "build your own", "select one", "select your",
                 "add ons", "add-ons", "done right", "cup of", "bowl of", "half order", "full order", "favorite", "favorites")   # as the whole name or its start/end
MENU_SCAFFOLD_WHOLE = {"extras", "toppings", "sides", "favorite", "favorites", "small", "medium", "large", "single", "double",
                       "triple", "combo", "kids", "kid's", "best", "specials", "drinks", "beverages", "desserts"}   # only as the whole name
# generic items that are an ingredient, not a dish: no recipe search, no catalog entry
SIMPLE_ITEMS = {"milk", "water", "soft drink", "soft drinks", "soda", "coke", "pepsi", "sprite", "diet coke", "coffee", "beer",
                "wine", "juice", "orange juice", "apple juice", "bottled water", "sparkling water", "fountain drink",
                # sandwich toppings, cheese and bread choices that OCR lists like dishes
                "onion", "onions", "lettuce", "tomato", "tomatoes", "pickles", "pickle", "jalapenos", "mayo", "mayonnaise", "mustard",
                "ketchup", "sour cream", "bacon", "ham", "turkey", "roast beef", "salami", "pepperoni", "avocado", "sprouts", "cucumber",
                "swiss", "cheddar", "provolone", "american", "pepper jack", "mozzarella", "feta", "cream cheese", "cheese",
                "wheat", "white", "rye", "sourdough", "pumpernickel", "everything", "plain", "sesame", "ciabatta", "croissant",
                "raspberry", "strawberry", "blueberry", "vanilla", "chocolate", "caramel", "hazelnut", "butter", "honey", "sugar", "salt"}
# words in a menu name that say nothing about the dish
NAME_STOPWORDS = {"regular", "plain", "special", "house", "our", "the", "with", "and", "style",
                  "fresh", "homemade", "classic", "traditional", "famous", "mixed", "combo"}


_ALIAS_IN_TEXT = sorted(ALIAS_PHRASES.items(), key=lambda kv: -len(kv[0]))   # longest phrase first
# bare words that name a whole category, not a dish: nothing to research ("Chicken", "Salad", "Pizza" as a menu line)
GENERIC_BARE = {"chicken", "beef", "pork", "steak", "fish", "shrimp", "seafood", "salad", "salads", "sandwich", "sandwiches", "pizza",
                "pizzas", "burger", "burgers", "pasta", "soup", "soups", "sides", "side", "wrap", "wraps", "sub", "subs", "bowl", "bowls",
                "dessert", "desserts", "appetizer", "appetizers", "entree", "entrees", "lunch", "dinner", "breakfast", "meal", "meals",
                "platter", "platters", "basket", "baskets", "dinners", "lunches", "snacks", "snack", "blend", "loaded", "spicy", "sweet",
                "square", "deluxe", "fluff", "italian", "hawaiian", "philly", "single", "double", "triple", "lemon", "coconut", "pineapple",
                "pineapples", "mushroom", "mushrooms", "sausage", "reaper", "straws", "mexican", "american", "asian", "greek", "veggie",
                "vegetable", "vegetables", "fruit", "fruits", "meat", "meats", "cheese", "cheeses", "egg", "eggs", "rice", "noodle", "noodles"}


def norm_tokens(name: str) -> list[str]:
    s = re.sub(r"\(.*?\)", " ", name.lower())
    s = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", s)).strip()
    for phrase, full in _ALIAS_IN_TEXT:          # "baked mac n cheese" -> "baked macaroni and cheese"; never twice
        if full not in s:
            s = re.sub(rf"\b{re.escape(phrase)}\b", full, s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    toks = [TRANSLITERATION.get(t, t) for t in s.split()]
    return [t for t in toks if t and t not in NAME_STOPWORDS]


def canonical_name(name: str) -> str:
    return " ".join(norm_tokens(name))


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48] or "dish"


# ─── bronze store ────────────────────────────────────────────────────────────
class Bronze:
    """Raw fetched pages, immutable, keyed by sha256. manifest.jsonl is one row per asset
    (Parquet conversion happens in the lake build, phase 4)."""

    def __init__(self, root: Path):
        self.root = root
        self.assets = root / "bronze" / "assets"
        self.manifest = root / "bronze" / "manifest.jsonl"
        self.assets.mkdir(parents=True, exist_ok=True)
        self._by_url: dict[str, dict] = {}
        self.lock = threading.Lock()      # dishes are researched in parallel; one writer to the manifest
        if self.manifest.exists():
            for line in self.manifest.read_text().splitlines():
                if line.strip():
                    row = json.loads(line)
                    self._by_url[row["url"]] = row

    def cached(self, url: str, max_age_days: int = 30) -> tuple[bytes, dict] | None:
        row = self._by_url.get(url)
        if not row or row.get("http_status") != 200:
            return None
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(row["fetched_at"])).days
        if age > max_age_days:
            return None
        p = self.assets / row["sha256"][:2] / f"{row['sha256']}.{row['ext']}"
        return (p.read_bytes(), row) if p.exists() else None

    def put(self, url: str, body: bytes, status: int, content_type: str, source_type: str, ext: str, **extra) -> dict:
        sha = hashlib.sha256(body).hexdigest()
        d = self.assets / sha[:2]
        d.mkdir(exist_ok=True)
        p = d / f"{sha}.{ext}"
        if not p.exists():
            p.write_bytes(body)
        row = {"sha256": sha, "url": url, "source_type": source_type, "content_type": content_type, "bytes": len(body),
               "fetched_at": datetime.now(timezone.utc).isoformat(), "http_status": status, "ext": ext, **extra}
        with self.lock:
            with self.manifest.open("a") as f:
                f.write(json.dumps(row) + "\n")
            self._by_url[url] = row
        return row


def fetch(url: str, bronze: Bronze, source_type: str, timeout: int = 20, max_bytes: int = 3_000_000) -> tuple[bytes, dict] | None:
    hit = bronze.cached(url)
    if hit:
        return hit
    try:
        r = requests.get(url, headers=UA, timeout=timeout, stream=True)
        body = b""
        for chunk in r.iter_content(65536):
            body += chunk
            if len(body) > max_bytes:
                break
        ct = r.headers.get("content-type", "")
        row = bronze.put(url, body, r.status_code, ct, source_type, "html" if "html" in ct or not ct else "bin")
        return (body, row) if r.status_code == 200 else None
    except requests.RequestException as e:
        print(f"      fetch failed {url[:70]}: {e.__class__.__name__}", file=sys.stderr)
        return None


# ─── search backends ─────────────────────────────────────────────────────────
# One search at a time across all research threads, at most one every SEARCH_GAP seconds, and a shared cooldown
# that grows while the provider rate-limits us: page fetches stay parallel, the search provider sees a slow client.
_search_lock = threading.Lock()
_search_state = {"next_ok": 0.0, "cooldown": 0.0}
SEARCH_GAP = float(os.environ.get("SEARCH_GAP", "2.0"))


def search_ddg(query: str, n: int) -> list[dict]:
    try:
        from ddgs import DDGS  # type: ignore
    except ImportError:
        from duckduckgo_search import DDGS  # type: ignore
    for attempt in range(5):
        with _search_lock:
            wait = _search_state["next_ok"] - time.time()
            if wait > 0:
                time.sleep(wait)
            try:
                res = DDGS().text(query, max_results=n)
                _search_state["cooldown"] = max(0.0, _search_state["cooldown"] / 2)      # recover after a good call
                _search_state["next_ok"] = time.time() + SEARCH_GAP + _search_state["cooldown"]
                return [{"url": r.get("href") or r.get("url"), "title": r.get("title", "")} for r in res if r.get("href") or r.get("url")]
            except Exception as e:  # rate limits etc.: back off for everyone, then retry
                _search_state["cooldown"] = min(120.0, max(5.0, _search_state["cooldown"] * 2))
                _search_state["next_ok"] = time.time() + _search_state["cooldown"]
                print(f"      ddg error ({e.__class__.__name__}), retry {attempt + 1} after {_search_state['cooldown']:.0f}s", file=sys.stderr)
    return []


def search_brave(query: str, n: int) -> list[dict]:
    key = os.environ.get("BRAVE_API_KEY")
    if not key:
        sys.exit("BRAVE_API_KEY not set")
    r = requests.get("https://api.search.brave.com/res/v1/web/search", params={"q": query, "count": min(n, 20)},
                     headers={"X-Subscription-Token": key, "Accept": "application/json"}, timeout=30)
    r.raise_for_status()
    return [{"url": x["url"], "title": x.get("title", "")} for x in r.json().get("web", {}).get("results", [])]


def search_searxng(query: str, n: int, base: str) -> list[dict]:
    r = requests.get(base.rstrip("/") + "/search", params={"q": query, "format": "json"}, headers=UA, timeout=30)
    r.raise_for_status()
    return [{"url": x["url"], "title": x.get("title", "")} for x in r.json().get("results", [])[:n]]


# ─── schema.org Recipe extraction ────────────────────────────────────────────
def _walk(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def _is_recipe(o: dict) -> bool:
    t = o.get("@type")
    if isinstance(t, list):
        return any(str(x).lower() == "recipe" for x in t)
    return str(t).lower() == "recipe"


def _as_text(v) -> str:
    if isinstance(v, dict):
        return str(v.get("name") or v.get("@value") or "")
    return str(v or "")


def recipes_from_html(html: bytes, url: str) -> list[dict]:
    """Return [{name, ingredients[], url, yield}] from JSON-LD, else microdata. Never prose."""
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for tag in soup.find_all("script", attrs={"type": re.compile(r"application/ld\+json", re.I)}):
        raw = tag.string or tag.get_text() or ""
        raw = raw.strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            try:
                data = json.loads(re.sub(r"[\x00-\x1f]", " ", raw))
            except json.JSONDecodeError:
                continue
        for o in _walk(data):
            if not _is_recipe(o):
                continue
            ings = o.get("recipeIngredient") or o.get("ingredients") or []
            if isinstance(ings, str):
                ings = [ings]
            ings = [_as_text(i).strip() for i in ings if _as_text(i).strip()]
            if len(ings) >= 3:
                out.append({"name": _as_text(o.get("name")).strip(), "ingredients": ings,
                            "url": o.get("url") if isinstance(o.get("url"), str) else url, "yield": _as_text(o.get("recipeYield"))})
    if out:
        return out
    ings = [el.get_text(" ", strip=True) for el in soup.find_all(attrs={"itemprop": "recipeIngredient"})]
    if len(ings) >= 3:
        name_el = soup.find(attrs={"itemprop": "name"})
        out.append({"name": name_el.get_text(strip=True) if name_el else (soup.title.get_text(strip=True) if soup.title else ""),
                    "ingredients": ings, "url": url, "yield": ""})
    return out


# ─── same-dish check ─────────────────────────────────────────────────────────
# words that name a kind of dish: a recipe title carrying one the menu name lacks is a different dish
# ("Cheddar" vs "BBQ Cheddar Burger", "Baked Potato" vs "Baked Potato Soup"). Stored singular (trailing s removed).
DISH_HEADS = {w.rstrip("s") for w in """burger burgers pizza pizzas soup soups salad salads sandwich sandwiches sub subs hoagie taco
    tacos burrito burritos wrap wraps pasta curry stew casserole cake cakes pie pies bread cookie cookies muffin muffins pancake pancakes
    waffle waffles omelet omelette quesadilla quesadillas enchilada enchiladas lasagna risotto chowder chili dip sauce dressing marinade
    smoothie cocktail latte nachos fries wings bake skillet bowl bowls roll rolls biscuit biscuits bites balls sticks pudding cheesecake
    brownie brownies fritter fritters dumpling dumplings noodles ramen pho sushi salsa spread jam calzone stromboli flatbread toast bagel
    bagels donut donuts doughnut doughnuts milkshake shake frappe pilaf gratin frittata quiche tart tarts crumble cobbler scone scones
    kebab kebabs skewers meatballs meatloaf pot pie hash slider sliders melt melts panini gyro gyros shawarma tikka pakora samosa
    bhaji biryani dosa idli naan paratha chutney raita kulfi halwa ladoo wonton wontons eggroll eggrolls dumplings tempura teriyaki
    katsu poke bibimbap kimchi pierogi goulash schnitzel paella empanada empanadas tamale tamales tostada tostadas chimichanga
    fajita fajitas nacho crepe crepes souffle mousse parfait sundae popsicle sorbet gelato""".split()}
# title words that do not change what dish it is
NEUTRAL_WORDS = {"easy", "best", "simple", "quick", "homemade", "classic", "recipe", "recipes", "perfect", "ultimate", "healthy", "the",
                 "my", "favorite", "favourite", "authentic", "old", "fashioned", "ever", "crispy", "creamy", "cheesy", "loaded", "slow",
                 "cooker", "instant", "pot", "air", "fryer", "minute", "one", "oven", "stovetop", "vegan", "vegetarian", "keto",
                 "gluten", "free", "low", "carb", "and", "with", "style", "how", "to", "make", "video", "sharp", "aged", "mild", "extra",
                 "mom", "moms", "grandma", "grandmas", "restaurant", "copycat", "southern", "traditional", "famous", "world", "amazing"}


def same_dish(menu_name: str, recipe_name: str) -> str:
    """same | variant | different, from name tokens only (deterministic)."""
    a_list = norm_tokens(menu_name)
    b_list = norm_tokens(recipe_name)
    a, b = set(a_list), set(b_list)
    b |= {t.rstrip("s") for t in b}
    if not a or not b:
        return "different"
    # a recipe for a different kind of dish that merely contains the menu item's words
    a_heads = {t.rstrip("s") for t in a} & DISH_HEADS
    b_heads = {t.rstrip("s") for t in b_list} & DISH_HEADS
    if b_heads - a_heads - {t.rstrip("s") for t in a}:
        return "different"
    if len(a_list) == 1:
        # one-word names ("cheddar", "nachos", "falafel"): the title must be ABOUT that word, i.e. it is the
        # title's last meaningful word ("Loaded Beef Nachos", "Sharp Cheddar"), not one ingredient among others
        meaningful = [t for t in b_list if t not in NEUTRAL_WORDS]
        t = a_list[0]
        if not meaningful or meaningful[-1] not in (t, t.rstrip("s"), t + "s"):
            return "different"
    hit = sum(1 for t in a if t in b or t.rstrip("s") in b)
    ratio = hit / len(a)
    if ratio == 1.0:
        return "same"
    if ratio >= 0.75:          # one missing token in a 4-word name; 2-word names must match fully
        return "variant"
    return "different"


def judge_with_llm(model: str, menu_name: str, description: str | None, recipe: dict) -> str:
    prompt = (f'Menu item: "{menu_name}"' + (f' — printed description: "{description}"' if description else "") +
              f'\nRecipe page title: "{recipe["name"]}"\nFirst ingredients: {", ".join(recipe["ingredients"][:6])}\n'
              'Is the recipe the same dish as the menu item? Answer with exactly one word: same, variant, or different.')
    try:
        r = requests.post("http://localhost:11434/api/generate", json={"model": model, "prompt": prompt, "stream": False}, timeout=120)
        r.raise_for_status()
        ans = r.json().get("response", "").strip().lower()
        for w in ("different", "variant", "same"):
            if w in ans:
                return w
    except requests.RequestException as e:
        print(f"      judge model unavailable ({e.__class__.__name__}); keeping token verdict", file=sys.stderr)
    return "variant"


# ─── deterministic ingredient parsing ────────────────────────────────────────
UNITS = r"(?:cups?|c\.|tbsps?|tablespoons?|tbl|tsps?|teaspoons?|grams?|gms?|g|kgs?|kilograms?|mls?|millilit(?:er|re)s?|lit(?:er|re)s?|l|" \
        r"oz|ounces?|lbs?|pounds?|pinch(?:es)?|dash(?:es)?|cloves?|inch(?:es)?|cm|pieces?|pcs?|slices?|cans?|tins?|packets?|packages?|" \
        r"handfuls?|sprigs?|sticks?|bunch(?:es)?|stalks?|leaves|leaf|pods?|nos?|numbers?|heads?|drops?|scoops?|quarts?|pints?|gallons?|strands?|threads?|fillets?|florets?|wedges?|knobs?|generous)"
NUM = r"(?:\d+\s+\d+\s*/\s*\d+|\d+\s*/\s*\d+|\d+(?:[.,]\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞]|(?:one|two|three|four|five|six|half|a few|few|some|couple of|an?)\b)"
LEAD = re.compile(rf"^\s*(?:about|approx\.?|approximately)?\s*(?:{NUM}\s*(?:-|–|to)?\s*{NUM}?\s*)?(?:{UNITS}\b\.?\s*)?(?:of\s+)?", re.I)
DESCRIPTORS = {"fresh", "freshly", "chopped", "finely", "roughly", "coarsely", "thinly", "diced", "minced", "sliced", "grated",
               "crushed", "melted", "softened", "cubed", "cut", "into", "small", "medium", "large", "big", "whole", "boneless",
               "skinless", "peeled", "deseeded", "seeded", "ripe", "raw", "cooked", "boiled", "roasted", "toasted", "fried",
               "heaped", "heaping", "level", "packed", "lightly", "beaten", "warm", "hot", "cold", "lukewarm", "room",
               "temperature", "optional", "divided", "or", "more", "as", "needed", "required", "to", "taste", "for", "garnish",
               "garnishing", "frying", "deep", "shallow", "greasing", "serving", "plus", "extra", "additional", "good",
               "quality", "organic", "homemade", "store", "bought", "unsalted", "salted", "low", "fat", "full", "reduced",
               "thick", "thin", "soft", "firm", "dry", "dried", "powdered", "in", "pieces", "piece", "from", "each", "of"}
SYNONYMS = {
    "halfandhalf": "half-and-half", "halfandhalf cream": "half-and-half",
    "heavy cream": "cream", "double cream": "cream", "whipping cream": "cream", "heavy whipping cream": "cream",
    "fresh cream": "cream", "thickened cream": "cream", "single cream": "cream", "cooking cream": "cream",
    "curd": "yogurt", "yoghurt": "yogurt", "plain yogurt": "yogurt", "greek yogurt": "yogurt", "dahi": "yogurt",
    "clarified butter": "ghee", "butter ghee": "ghee", "desi ghee": "ghee",
    "cashew": "cashews", "cashew nuts": "cashews", "cashewnuts": "cashews", "kaju": "cashews", "cashew nut": "cashews",
    "raw cashews": "cashews", "cashew paste": "cashews", "cashew powder": "cashews",
    "almond": "almonds", "almonds": "almonds", "badam": "almonds", "almond flakes": "almonds", "slivered almonds": "almonds",
    "cottage cheese": "paneer", "indian cottage cheese": "paneer", "paneer cubes": "paneer",
    "all purpose flour": "wheat flour", "all-purpose flour": "wheat flour", "maida": "wheat flour", "plain flour": "wheat flour",
    "whole wheat flour": "wheat flour", "atta": "wheat flour", "wholemeal flour": "wheat flour", "flour": "wheat flour",
    "bread flour": "wheat flour", "self raising flour": "wheat flour", "self-raising flour": "wheat flour",
    "vegetable oil": "oil", "sunflower oil": "oil", "canola oil": "oil", "cooking oil": "oil", "neutral oil": "oil",
    "refined oil": "oil", "olive oil": "olive oil", "mustard oil": "mustard oil",
    "green chilli": "green chili", "green chillies": "green chili", "green chilies": "green chili", "green chile": "green chili",
    "green chiles": "green chili", "green chilly": "green chili", "serrano": "green chili", "thai chili": "green chili",
    "red chilli powder": "chili powder", "red chili powder": "chili powder", "kashmiri red chilli powder": "chili powder",
    "kashmiri chilli powder": "chili powder", "kashmiri red chili powder": "chili powder", "chilli powder": "chili powder",
    "cayenne pepper": "chili powder", "cayenne": "chili powder", "red chile powder": "chili powder",
    "garam masala powder": "garam masala", "turmeric powder": "turmeric", "haldi": "turmeric", "ground turmeric": "turmeric",
    "coriander powder": "coriander", "ground coriander": "coriander", "coriander seeds": "coriander", "dhania": "coriander",
    "cilantro": "coriander leaves", "coriander leaves": "coriander leaves", "fresh coriander": "coriander leaves", "coriander leaf": "coriander leaves",
    "cumin seeds": "cumin", "jeera": "cumin", "ground cumin": "cumin", "cumin powder": "cumin",
    "onions": "onion", "red onion": "onion", "red onions": "onion", "white onion": "onion", "yellow onion": "onion",
    "tomatoes": "tomato", "tomato puree": "tomato", "tomato paste": "tomato", "canned tomatoes": "tomato", "tomato sauce": "tomato",
    "crushed tomatoes": "tomato", "roma tomatoes": "tomato", "chopped tomatoes": "tomato", "passata": "tomato",
    "garlic cloves": "garlic", "garlic clove": "garlic", "garlic paste": "garlic", "cloves garlic": "garlic", "minced garlic": "garlic",
    "ginger paste": "ginger", "fresh ginger": "ginger", "ginger root": "ginger", "grated ginger": "ginger",
    "ginger garlic paste": "ginger garlic paste", "ginger-garlic paste": "ginger garlic paste",
    "potatoes": "potato", "potatoe": "potato", "aloo": "potato", "baby potatoes": "potato",
    "green peas": "peas", "frozen peas": "peas", "matar": "peas", "fresh peas": "peas",
    "spinach leaves": "spinach", "palak": "spinach", "baby spinach": "spinach", "frozen spinach": "spinach",
    "cauliflower florets": "cauliflower", "gobi": "cauliflower",
    "chickpeas": "chickpeas", "chana": "chickpeas", "garbanzo beans": "chickpeas", "canned chickpeas": "chickpeas", "chole": "chickpeas",
    "eggplant": "eggplant", "aubergine": "eggplant", "brinjal": "eggplant", "baingan": "eggplant",
    "whole milk": "milk", "full cream milk": "milk", "full-fat milk": "milk", "full fat milk": "milk", "milk powder": "milk powder",
    "khoya": "khoya", "mawa": "khoya", "khoa": "khoya", "condensed milk": "condensed milk", "sweetened condensed milk": "condensed milk",
    "sugar": "sugar", "granulated sugar": "sugar", "caster sugar": "sugar", "white sugar": "sugar", "powdered sugar": "sugar",
    "icing sugar": "sugar", "brown sugar": "sugar", "jaggery": "jaggery",
    "eggs": "egg", "large eggs": "egg", "egg yolk": "egg", "egg yolks": "egg", "egg white": "egg", "egg whites": "egg",
    "chicken breast": "chicken", "chicken thighs": "chicken", "chicken thigh": "chicken", "boneless chicken": "chicken",
    "chicken pieces": "chicken", "chicken breasts": "chicken", "chicken drumsticks": "chicken",
    "lamb": "lamb", "mutton": "lamb", "goat meat": "lamb", "lamb shoulder": "lamb", "lamb leg": "lamb",
    "prawns": "shrimp", "prawn": "shrimp", "king prawns": "shrimp", "jumbo shrimp": "shrimp",
    "salt to taste": "salt", "sea salt": "salt", "kosher salt": "salt", "table salt": "salt", "black salt": "salt", "rock salt": "salt",
    "black pepper": "black pepper", "pepper": "black pepper", "ground black pepper": "black pepper", "black pepper powder": "black pepper",
    "bay leaf": "bay leaf", "bay leaves": "bay leaf", "tej patta": "bay leaf",
    "green cardamom": "cardamom", "cardamom pods": "cardamom", "cardamom powder": "cardamom", "elaichi": "cardamom", "cardamoms": "cardamom",
    "cinnamon stick": "cinnamon", "cinnamon sticks": "cinnamon", "ground cinnamon": "cinnamon",
    "cloves": "cloves", "clove": "cloves", "laung": "cloves",
    "kasuri methi": "fenugreek leaves", "dried fenugreek leaves": "fenugreek leaves", "kasoori methi": "fenugreek leaves",
    "fenugreek": "fenugreek leaves", "methi": "fenugreek leaves",
    "mint leaves": "mint", "fresh mint": "mint", "pudina": "mint",
    "lemon juice": "lemon", "lime juice": "lemon", "juice of lemon": "lemon", "lemon": "lemon", "lime": "lemon",
    "basmati rice": "rice", "rice": "rice", "cooked rice": "rice", "long grain rice": "rice",
    "pistachios": "pistachios", "pistachio": "pistachios", "pista": "pistachios",
    "raisins": "raisins", "kishmish": "raisins", "golden raisins": "raisins", "sultanas": "raisins",
    "saffron": "saffron", "saffron strands": "saffron", "saffron threads": "saffron", "kesar": "saffron",
    "rose water": "rose water", "rosewater": "rose water", "kewra water": "kewra water", "kewra essence": "kewra water",
    "baking soda": "baking soda", "bicarbonate of soda": "baking soda", "baking powder": "baking powder",
    "active dry yeast": "yeast", "instant yeast": "yeast", "dry yeast": "yeast",
    "coconut milk": "coconut milk", "coconut cream": "coconut milk", "desiccated coconut": "coconut", "grated coconut": "coconut",
    "mango pulp": "mango", "mango puree": "mango", "ripe mangoes": "mango", "mangoes": "mango", "alphonso mango": "mango",
    "ice cream": "ice cream", "vanilla ice cream": "ice cream", "vanilla extract": "vanilla", "vanilla essence": "vanilla",
    "tea leaves": "black tea", "black tea leaves": "black tea", "tea bags": "black tea", "tea bag": "black tea", "loose tea": "black tea", "tea": "black tea",
    "mixed vegetables": "mixed vegetables", "carrots": "carrot", "carrot": "carrot", "french beans": "green beans", "beans": "green beans",
    "capsicum": "bell pepper", "green bell pepper": "bell pepper", "red bell pepper": "bell pepper", "bell peppers": "bell pepper",
    "corn kernels": "corn", "sweet corn": "corn", "paneer or tofu": "paneer",
    "red lentils": "lentils", "masoor dal": "lentils", "toor dal": "lentils", "moong dal": "lentils", "chana dal": "lentils",
    "urad dal": "black lentils", "whole urad dal": "black lentils", "black urad dal": "black lentils", "whole black lentils": "black lentils",
    "rajma": "kidney beans", "red kidney beans": "kidney beans", "kidney beans": "kidney beans",
    "water": "water", "ice": "water", "ice cubes": "water", "warm water": "water",
    "semolina": "semolina", "sooji": "semolina", "rava": "semolina",
    "poppy seeds": "poppy seeds", "khus khus": "poppy seeds", "melon seeds": "melon seeds", "magaz": "melon seeds",
    "bread crumbs": "breadcrumbs", "corn flour": "cornstarch", "cornflour": "cornstarch", "corn starch": "cornstarch",
    "spring onions": "scallion", "green onions": "scallion", "scallions": "scallion",
    "amchur": "dry mango powder", "amchur powder": "dry mango powder", "dry mango powder": "dry mango powder",
    "asafoetida": "asafoetida", "hing": "asafoetida", "asafetida": "asafoetida",
    "carom seeds": "carom seeds", "ajwain": "carom seeds", "nigella seeds": "nigella seeds", "kalonji": "nigella seeds",
    "sesame seeds": "sesame", "til": "sesame", "white sesame seeds": "sesame",
    "soda": "soda", "club soda": "soda", "sparkling water": "soda", "cola": "soda",
    "lemon zest": "lemon", "orange zest": "orange", "honey": "honey", "chaat masala": "chaat masala", "pav bhaji masala": "garam masala",
}
SKIP = {"", "water", "salt", "oil", "black pepper", "as needed", "to taste", "for garnish", "ice"}  # kept in raw, not exported


def singular(w: str) -> str:
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith("oes") and len(w) > 4:
        return w[:-2]
    if w.endswith("s") and not w.endswith("ss") and len(w) > 3:
        return w[:-1]
    return w


def parse_ingredient(raw: str) -> str | None:
    s = raw.lower().replace("½", " 1/2 ").replace("¼", " 1/4 ").replace("¾", " 3/4 ")
    s = re.sub(r"\(.*?\)", " ", s)                  # (optional), (about 200 g)
    s = re.sub(r"\bhalf[\s-]+and[\s-]+half\b", "halfandhalf", s)   # not a quantity
    s = s.split(",")[0].split(" or ")[0]            # "ghee, melted" / "butter or oil" -> first
    s = re.sub(r"[^a-z0-9/ \-]+", " ", s)
    s = LEAD.sub("", s)                             # quantity + unit
    s = LEAD.sub("", s)                             # "2 x 400 g cans"
    s = re.sub(r"\b\d+(?:[./]\d+)?\b", " ", s)      # stray numbers
    s = re.sub(r"^[\s/.\-]+", "", s)                 # leftovers of a split fraction
    s = re.sub(r"\s+", " ", s).strip(" -")
    if not s:
        return None
    if s in SYNONYMS:
        return SYNONYMS[s]
    words = [w for w in s.split() if w not in DESCRIPTORS]
    s = " ".join(words).strip()
    if not s:
        return None
    if s in SYNONYMS:
        return SYNONYMS[s]
    # longest synonym key contained in the phrase wins ("boneless chicken thighs" -> chicken)
    best = None
    for k, v in SYNONYMS.items():
        if re.search(rf"\b{re.escape(k)}\b", s) and (best is None or len(k) > len(best[0])):
            best = (k, v)
    if best:
        return best[1]
    s = " ".join(singular(w) if i == len(words) - 1 else w for i, w in enumerate(words))
    return s[:40]


# ─── research one dish ───────────────────────────────────────────────────────
@dataclass
class Research:
    name: str
    canonical: str
    status: str = "unknown"
    considered: int = 0
    accepted: int = 0
    ingredients: dict = field(default_factory=dict)   # ingredient -> {support, class, sources}
    accepted_urls: list = field(default_factory=list)
    raw_counts: dict = field(default_factory=dict)


def research(name: str, cuisine: str | None, description: str | None, bronze: Bronze, searcher, n: int,
             min_recipes: int, judge_model: str | None, pause: float) -> Research:
    res = Research(name=name, canonical=canonical_name(name))
    queries = [f'"{res.canonical}" recipe ingredients' + (f" {cuisine}" if cuisine else "")]
    if res.canonical != name.lower():
        queries.append(f'"{name}" recipe')
    seen_urls, candidates = set(), []
    for q in queries:
        for hit in searcher(q, n):
            u = hit["url"]
            host = urlparse(u).netloc
            if u in seen_urls or any(b in host for b in ("youtube.", "pinterest.", "facebook.", "instagram.", "tiktok.", "amazon.", "reddit.")):
                continue
            seen_urls.add(u)
            candidates.append(hit)
        if len(candidates) >= n:
            break
        time.sleep(pause)
    accepted = []
    for hit in candidates[: n + 4]:
        got = fetch(hit["url"], bronze, "recipe-page")
        time.sleep(pause)
        if not got:
            continue
        html, _ = got
        recipes = recipes_from_html(html, hit["url"])
        for rec in recipes[:1]:
            res.considered += 1
            verdict = same_dish(name, rec["name"] or hit["title"])
            if verdict == "variant" and judge_model:
                verdict = judge_with_llm(judge_model, name, description, rec)
            tag = {"same": "+", "variant": "~", "different": "-"}[verdict]
            print(f"      {tag} {rec['name'][:48]:<48} {urlparse(hit['url']).netloc}")
            if verdict in ("same", "variant"):
                accepted.append(rec)
        if len(accepted) >= n:
            break
    res.accepted = len(accepted)
    if res.accepted < min_recipes:
        return res
    counts: dict[str, set] = {}
    for rec in accepted:
        names = {parse_ingredient(i) for i in rec["ingredients"]}
        for ing in names:
            if ing:
                counts.setdefault(ing, set()).add(rec["url"])
    res.raw_counts = {k: len(v) for k, v in counts.items()}
    for ing, urls in sorted(counts.items(), key=lambda kv: -len(kv[1])):
        support = round(len(urls) / res.accepted, 2)
        if ing in SKIP:
            continue
        cls = "typical" if support >= 0.5 else "sometimes" if support >= 0.25 else None
        if cls:
            res.ingredients[ing] = {"support": support, "class": cls, "sources": sorted(urls)}
    res.accepted_urls = [r["url"] for r in accepted]
    res.status = "typical" if any(v["class"] == "typical" for v in res.ingredients.values()) else "unknown"
    return res


# ─── main ────────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("menu_json", help="data/menus.json or one restaurant entry (e.g. an .ocr.json)")
    ap.add_argument("--restaurant", default=None, help="only this restaurant id")
    ap.add_argument("--seed", default=str(REPO / "data/dishes.json"), help="committed catalog, read only")
    ap.add_argument("--dishes", default=None, help="catalog to write (default <lake>/gold/dishes.json)")
    ap.add_argument("--lake", default=str(REPO / "data-lake"))
    ap.add_argument("--cuisine", default=None, help="search hint, e.g. Indian")
    ap.add_argument("--search", choices=["ddg", "brave", "searxng"], default="ddg")
    ap.add_argument("--searxng-url", default=os.environ.get("SEARXNG_URL", "http://localhost:8080"))
    ap.add_argument("--n", type=int, default=10, help="recipes to collect per dish")
    ap.add_argument("--min-recipes", type=int, default=3, help="fewer accepted recipes than this -> unknown")
    ap.add_argument("--judge-model", default=None, help="optional Ollama model for the ambiguous same-dish band (reads only)")
    ap.add_argument("--force", action="store_true", help="re-research dishes already in the catalog")
    ap.add_argument("--only", nargs="*", default=None, help="only these dish names")
    ap.add_argument("--pause", type=float, default=0.7, help="seconds between web requests")
    ap.add_argument("--workers", type=int, default=3, help="dishes researched at the same time")
    ap.add_argument("--dry-run", action="store_true", help="research and print, write nothing to the catalog")
    args = ap.parse_args()

    searcher = {"ddg": search_ddg, "brave": search_brave,
                "searxng": lambda q, n: search_searxng(q, n, args.searxng_url)}[args.search]
    bronze = Bronze(Path(args.lake))
    queue_path = Path(args.lake) / "silver" / "review_queue.jsonl"
    queue_path.parent.mkdir(parents=True, exist_ok=True)

    src = json.loads(Path(args.menu_json).read_text())
    restaurants = src["restaurants"] if isinstance(src, dict) and "restaurants" in src else [src]   # an empty county file is not a restaurant
    if args.restaurant:
        restaurants = [r for r in restaurants if r["id"] == args.restaurant]
    # The written catalog lives in the gitignored lake; the committed seed is only read, so nothing the
    # scraper researches can end up in git. The lake file starts as a copy of the seed.
    kb_path = Path(args.dishes) if args.dishes else Path(args.lake) / "gold" / "dishes.json"
    kb_path.parent.mkdir(parents=True, exist_ok=True)
    seed_path = Path(args.seed)
    kb = json.loads(kb_path.read_text()) if kb_path.exists() else {"version": 1, "dishes": []}
    by_key: dict[str, dict] = {}
    for d in kb["dishes"]:
        for k in [d["name"], *d.get("aliases", [])]:
            by_key[canonical_name(k)] = d
    if seed_path.exists() and seed_path.resolve() != kb_path.resolve():
        for d in json.loads(seed_path.read_text()).get("dishes", []):
            if canonical_name(d["name"]) in by_key:
                continue
            kb["dishes"].append(d)
            for k in [d["name"], *d.get("aliases", [])]:
                by_key[canonical_name(k)] = d

    today = date.today().isoformat()
    # names that came back unknown in the last 14 days: don't repeat the same failed searches on every pass
    recent_unknown: set[str] = set()
    if queue_path.exists() and not args.force:
        cutoff = (date.today() - timedelta(days=14)).isoformat()
        for line in queue_path.read_text().splitlines():
            try:
                q = json.loads(line)
            except ValueError:
                continue
            if q.get("kind") == "dish_unknown" and q.get("created_at", "") >= cutoff:
                recent_unknown.add(q.get("canonical") or "")
    added = hits = unknown = simple = junk = cached_unknown = 0
    todo: list[tuple] = []        # (restaurant, dish, key, cuisine, description, existing entry)
    queued: set[str] = set()
    for r in restaurants:
        cuisine = args.cuisine or (str(r.get("cuisine") or "").split(";")[0].replace("_", " ") or None)
        for dish in r["dishes"]:
            if args.only and dish["name"] not in args.only:
                continue
            key = canonical_name(dish["name"])
            desc = dish.get("notes") or None
            letters = sum(c.isalpha() for c in dish["name"]); 
            low = dish["name"].lower()
            if (len(key) < 4 or letters < 0.6 * max(1, len(dish["name"].replace(" ", ""))) or len(key.split()) > 8
                    or low in MENU_SCAFFOLD_WHOLE
                    or any(low == w or low.startswith(w + " ") or low.endswith(" " + w) for w in MENU_SCAFFOLD)):
                junk += 1          # OCR noise ("Fapdias", "kyfas0Ng [) @8"), a whole sentence, or menu scaffolding ("Choose One Meat")
                continue
            if key in SIMPLE_ITEMS or dish["name"].lower() in SIMPLE_ITEMS or (len(key.split()) == 1 and key in GENERIC_BARE):
                print(f"  {dish['name']}: generic item, not a dish -> no research (restaurant ingredients or unverified)")
                simple += 1
                continue
            if key in recent_unknown:
                cached_unknown += 1      # searched within 14 days and found nothing; try again later
                continue
            existing = by_key.get(key) or next((d for k, d in by_key.items() if k and k in key), None)
            if existing and not args.force:
                existing["seen_count"] = existing.get("seen_count", 0) + 1
                existing["last_seen"] = today
                hits += 1
                continue
            if key in queued:
                hits += 1          # same dish at another restaurant in this run: researched once, matched below
                continue
            queued.add(key)
            todo.append((r, dish, key, cuisine, desc, existing))

    def do_research(item):
        r, dish, key, cuisine, desc, existing = item
        print(f"\n  {dish['name']}  ->  '{key}'", flush=True)
        res = research(dish["name"], cuisine, desc, bronze, searcher, args.n, args.min_recipes, args.judge_model, args.pause)
        if res.status == "unknown" and cuisine and res.accepted < args.min_recipes:
            # the cuisine hint ("bbq") pulled in variants of other dishes; try the plain dish name once
            print(f"    retry '{dish['name']}' without the '{cuisine}' hint", flush=True)
            res = research(dish["name"], None, desc, bronze, searcher, args.n, args.min_recipes, args.judge_model, args.pause)
        return item, res

    print(f"\n{len(todo)} dishes to research, {args.workers} at a time", flush=True)
    results = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for fut in as_completed([pool.submit(do_research, it) for it in todo]):
            try:
                results.append(fut.result())
            except Exception as e:       # one dish must not stop the county
                print(f"    research failed: {e.__class__.__name__}: {str(e)[:120]}", flush=True)
    for (r, dish, key, cuisine, desc, existing), res in sorted(results, key=lambda x: x[0][2]):
        if res.status == "unknown":
            unknown += 1
            if res.accepted >= args.min_recipes:
                print(f"    UNKNOWN: {res.accepted} same-dish recipes agree on no ingredient (none at >=50% support after the skip list)")
            else:
                print(f"    UNKNOWN: {res.accepted} same-dish recipes of {res.considered} with structured ingredients (need {args.min_recipes})")
            if not args.dry_run:
                with queue_path.open("a") as f:
                    f.write(json.dumps({"kind": "dish_unknown", "dish": dish["name"], "canonical": key, "restaurant": r.get("id"),
                                        "recipes_considered": res.considered, "recipes_accepted": res.accepted, "created_at": today}) + "\n")
            continue
        typical = [k for k, v in res.ingredients.items() if v["class"] == "typical"]
        entry = {
            "name": key, "aliases": sorted({dish["name"].lower()} - {key}), "cuisine": (cuisine or "").lower() or None,
            "status": res.status,
            "typicalIngredients": typical,
            "evidence": res.ingredients,
            "recipes_considered": res.considered, "recipes_accepted": res.accepted,
            "seen_count": (existing or {}).get("seen_count", 0) + 1, "last_seen": today,
            "source": {"type": "recipes", "collected": today, "search": args.search, "urls": res.accepted_urls},
        }
        if existing:  # keep hand-curated extras
            for keep in ("shares", "substitutes"):
                if existing.get(keep):
                    entry[keep] = existing[keep]
            entry["aliases"] = sorted(set(entry["aliases"]) | set(existing.get("aliases", [])) | ({existing["name"]} - {key}))
        shown = ", ".join(f"{k} {int(v['support']*100)}%" for k, v in list(res.ingredients.items())[:8])
        print(f"    {res.status.upper()} from {res.accepted}/{res.considered} recipes: {shown}")
        if args.dry_run:
            continue
        if existing:
            kb["dishes"] = [d for d in kb["dishes"] if d is not existing]
        kb["dishes"].append(entry)
        for k in [entry["name"], *entry["aliases"]]:
            by_key[canonical_name(k)] = entry
        added += 1

    if not args.dry_run:
        kb["dishes"].sort(key=lambda d: d["name"])
        kb_path.write_text(json.dumps(kb, indent=2, ensure_ascii=False) + "\n")
    print(f"\n{added} researched, {hits} catalog hits (no research), {simple} generic items skipped, {junk} junk names skipped, "
          f"{cached_unknown} recent unknowns not retried, {unknown} unknown -> {queue_path.name}. "
          f"{'(dry run) ' if args.dry_run else ''}Next: node tools/build-data.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())

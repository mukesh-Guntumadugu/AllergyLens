#!/usr/bin/env python3
"""Serve the Lens data live from the GX10 (or any box on the same network).

    python3 tools/serve_data.py --port 8787 [--with-lake]

Endpoints (JSON, CORS open, ETag + Cache-Control so a Lens fetches once per change):
    /menus.json     data/menus.json, with data-lake/gold/lens/menus.json merged in (--with-lake)
    /products.json  data/products.json
    /health         {"ok": true, "restaurants": n, "products": n, "version": "..."}
    /lookup?dish=<name>&cuisine=<c>
                    dish name -> ingredients. Cache first (data/dishes.json seed, data-lake/gold/dishes.json,
                    data/lookup-cache.json), answered in milliseconds. On a miss, with --research, the dish is
                    queued for web retrieval (tools/scrape/ingredients_rag.py: recipe pages with schema.org
                    markup, citations kept, no model invents a recipe) and the call answers
                    {"status": "researching"} at once; the Lens polls again a few seconds later and the
                    second visitor gets the cached answer. Without --research a miss answers "unknown".
                    --llm: a miss is answered by a small model instead (Claude Haiku 5.5 with ANTHROPIC_API_KEY,
                    or gpt-4.1-nano with OPENAI_API_KEY; the key is read from the environment, never from the
                    Lens), as a fixed JSON list of typical ingredients, cached forever per dish, capped per hour.
                    The call usually answers inside the request (the Lens waits up to 4 s); a slow one answers
                    "researching" and the Lens asks again.

Point the Lens at it: select `AllergyLens` in Lens Studio and set `menusUrl` to
http://<gx10-ip>:8787/menus.json. The Lens validates the shape and falls back to the
bundled data on any failure, so the demo never depends on the network.
No third-party packages; restart-safe; re-reads the files on every request.
"""
import argparse, hashlib, json, os, re, sys, threading, time, queue
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WITH_LAKE = False
RESEARCH = False
LLM = False
LLM_MODEL = os.environ.get("ALLERGYLENS_LLM_MODEL")   # optional override of the per-provider default
LLM_MAX_PER_HOUR = int(os.environ.get("ALLERGYLENS_LLM_MAX_PER_HOUR", "300"))
LLM_WAIT_S = 3.0        # how long /lookup waits for the model before answering "researching"
LAKE = os.path.join(ROOT, "data-lake")
LOCAL_CACHE = os.path.join(ROOT, "data", "lookup-cache.json")   # the VPS has no lake; results land here
SEARCH = "ddg"


# ─── /lookup: dish name -> ingredients, cache first, web retrieval on a miss ─────────────────────
def _norm(name):
    return re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower()).strip()


def _catalogs():
    """Seed + lake + local cache, later files win (same precedence as build-data.js)."""
    paths = [os.path.join(ROOT, "data", "dishes.json"), os.path.join(LAKE, "gold", "dishes.json"), LOCAL_CACHE]
    for path in paths:
        if os.path.exists(path):
            try:
                yield path, json.load(open(path, encoding="utf-8")).get("dishes", [])
            except Exception as e:
                sys.stderr.write(f"lookup: cannot read {path}: {e}\n")


def find_dish(menu_name):
    """A catalog name/alias contained in the menu name, longest key wins — but the key must cover at
    least half of the name's words, so "chicken tikka masala" is not answered by the entry "chicken"
    (build-data.js accepts any contained key; the live path is stricter because a wrong hit here would
    turn a dish green from the wrong recipe)."""
    n = _norm(menu_name)
    words = n.split()
    best = None
    for _, dishes in _catalogs():
        for d in dishes:
            for key in [d.get("name", "")] + list(d.get("aliases", [])):
                k = _norm(key)
                if not k or (" " + k + " ") not in (" " + n + " "):
                    continue
                if len(k.split()) * 2 < len(words):
                    continue
                if best is None or len(k) > len(best[0]):
                    best = (k, d)
    return best[1] if best else None


def _lookup_payload(d, status=None, cached=True):
    typical = [i for i in d.get("typicalIngredients", []) if isinstance(i, str)]
    st = status or d.get("status") or ("typical" if typical else "unknown")
    sources = sorted({u for ev in d.get("evidence", {}).values() for u in ev.get("sources", [])})[:12]
    src = d.get("source", {}) if isinstance(d.get("source"), dict) else {}
    return {"dish": d.get("name"), "status": st, "ingredients": typical if st == "typical" else [],
            "ingredientsSource": "typical" if st == "typical" else "none", "cuisine": d.get("cuisine"),
            "diet": d.get("diet"), "sources": sources, "cached": cached,
            "from": src.get("type", "catalog") + (f" ({src.get('model')})" if src.get("model") else "")}


_research_q = queue.Queue()
_in_flight = set()
_in_flight_lock = threading.Lock()
_unknown_until = {}   # norm name -> time; a failed research is not retried for an hour
_done_events = {}     # norm name -> threading.Event, set when the worker has an answer (so /lookup can wait briefly)
_llm_calls = []       # timestamps of model calls in the last hour (spend cap)
_llm_stats = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "provider": None, "model": None}


# ─── the small-model path: dish name -> typical ingredients as fixed JSON ──────────────────────────
LLM_SYSTEM = (
    "You are an ingredient reference for a food-allergy app used on AR glasses. Given a dish name from a "
    "restaurant menu and an optional cuisine hint, list the ingredients typically used in a standard restaurant "
    "recipe of that dish. Rules: lowercase, simple ingredient names (\"cream\", \"peanut\", \"wheat flour\", "
    "\"fish sauce\"), one per entry, 4 to 20 entries. Always include the typical hidden allergen carriers when they "
    "belong to the standard recipe: ghee, butter, yogurt, cream, milk, cheese, egg, wheat flour, breadcrumbs, soy "
    "sauce, fish sauce, oyster sauce, shrimp paste, peanut, peanut oil, sesame oil, tree nuts, gelatin, lard, "
    "chicken stock, beef stock, pork, beef, alcohol. Do not invent unusual additions. If the text is not a "
    "recognisable dish (a section header, a slogan, a price line, gibberish), set known to false and return an "
    "empty list. Set diet to the most accurate of: vegan, vegetarian, pescatarian, non-vegetarian."
)
LLM_SCHEMA = {
    "type": "object",
    "properties": {
        "known": {"type": "boolean"},
        "dish": {"type": "string"},
        "cuisine": {"type": "string"},
        "diet": {"type": "string", "enum": ["vegan", "vegetarian", "pescatarian", "non-vegetarian", "unknown"]},
        "typical_ingredients": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    },
    "required": ["known", "dish", "cuisine", "diet", "typical_ingredients", "confidence"],
    "additionalProperties": False,
}


def _llm_provider():
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic", LLM_MODEL or "claude-haiku-5-5"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai", LLM_MODEL or "gpt-4.1-nano"
    return None, None


def _llm_guess(name, cuisine):
    """One model call. Returns the parsed JSON dict or raises."""
    provider, model = _llm_provider()
    user = f"Dish: {name}\nCuisine hint: {cuisine or 'unknown'}"
    if provider == "anthropic":
        import anthropic
        client = anthropic.Anthropic()
        try:
            resp = client.messages.create(
                model=model, max_tokens=1024,
                system=[{"type": "text", "text": LLM_SYSTEM, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user}],
                output_config={"format": {"type": "json_schema", "schema": LLM_SCHEMA}},
            )
        except anthropic.AuthenticationError:
            raise RuntimeError("ANTHROPIC_API_KEY rejected")
        except anthropic.RateLimitError as e:
            raise RuntimeError(f"rate limited: {e}")
        except anthropic.APIStatusError as e:
            raise RuntimeError(f"API error {e.status_code}: {e.message}")
        except anthropic.APIConnectionError:
            raise RuntimeError("cannot reach api.anthropic.com")
        if resp.stop_reason == "refusal":
            raise RuntimeError("model declined")
        _llm_stats["input_tokens"] += resp.usage.input_tokens
        _llm_stats["output_tokens"] += resp.usage.output_tokens
        text = next(b.text for b in resp.content if b.type == "text")
        return json.loads(text)
    if provider == "openai":
        from openai import OpenAI
        client = OpenAI()
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": LLM_SYSTEM}, {"role": "user", "content": user}],
            response_format={"type": "json_schema", "json_schema": {"name": "dish", "schema": LLM_SCHEMA, "strict": True}},
        )
        if resp.usage:
            _llm_stats["input_tokens"] += resp.usage.prompt_tokens
            _llm_stats["output_tokens"] += resp.usage.completion_tokens
        return json.loads(resp.choices[0].message.content)
    raise RuntimeError("no API key in the environment (ANTHROPIC_API_KEY or OPENAI_API_KEY)")


def _llm_entry(name, cuisine, guess):
    ings = []
    for i in guess.get("typical_ingredients", []):
        if isinstance(i, str):
            i = i.strip().lower()
            if i and i not in ings:
                ings.append(i)
    known = bool(guess.get("known")) and len(ings) >= 3
    return {"name": name.lower(), "aliases": [], "cuisine": guess.get("cuisine") or cuisine,
            "status": "typical" if known else "unknown", "typicalIngredients": ings if known else [],
            "diet": guess.get("diet"), "confidence": guess.get("confidence"),
            "source": {"type": "llm", "provider": _llm_stats["provider"], "model": _llm_stats["model"],
                       "collected": time.strftime("%Y-%m-%d"), "note": "typical recipe, not this restaurant's"}}


def _llm_worker():
    provider, model = _llm_provider()
    _llm_stats["provider"], _llm_stats["model"] = provider, model
    if not provider:
        sys.stderr.write("lookup: --llm given but no ANTHROPIC_API_KEY / OPENAI_API_KEY in the environment; misses answer unknown\n")
    else:
        sys.stderr.write(f"lookup: model path on ({provider} {model}, cap {LLM_MAX_PER_HOUR}/hour)\n")
    while True:
        name, cuisine = _research_q.get()
        key = _norm(name)
        t0 = time.time()
        try:
            now = time.time()
            _llm_calls[:] = [t for t in _llm_calls if now - t < 3600]
            if len(_llm_calls) >= LLM_MAX_PER_HOUR:
                raise RuntimeError(f"hourly cap of {LLM_MAX_PER_HOUR} model calls reached")
            _llm_calls.append(now)
            _llm_stats["calls"] += 1
            entry = _llm_entry(name, cuisine, _llm_guess(name, cuisine))
            if entry["status"] == "typical":
                _write_local_cache(entry)
            else:
                _unknown_until[key] = time.time() + 24 * 3600   # the model does not know it either; do not pay again today
            sys.stderr.write(f"lookup: model '{name}' -> {entry['status']} ({len(entry['typicalIngredients'])} ingredients, {time.time()-t0:.1f}s)\n")
        except Exception as e:
            _unknown_until[key] = time.time() + 600
            sys.stderr.write(f"lookup: model failed for '{name}': {e}\n")
        finally:
            with _in_flight_lock:
                _in_flight.discard(key)
                ev = _done_events.pop(key, None)
            if ev:
                ev.set()
            _research_q.task_done()


def _write_local_cache(entry):
    with _in_flight_lock:
        cache = {"version": 1, "dishes": []}
        if os.path.exists(LOCAL_CACHE):
            try:
                cache = json.load(open(LOCAL_CACHE, encoding="utf-8"))
            except Exception:
                pass
        cache["dishes"] = [d for d in cache.get("dishes", []) if _norm(d.get("name")) != _norm(entry["name"])] + [entry]
        tmp = LOCAL_CACHE + ".tmp"
        json.dump(cache, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        os.replace(tmp, LOCAL_CACHE)


def _research_worker():
    sys.path.insert(0, os.path.join(ROOT, "tools", "scrape"))
    try:
        import ingredients_rag as rag
    except Exception as e:
        sys.stderr.write(f"lookup: research disabled, cannot import ingredients_rag ({e}); pip install requests beautifulsoup4\n")
        return
    searcher = {"ddg": rag.search_ddg, "brave": rag.search_brave}.get(SEARCH, rag.search_ddg)
    from pathlib import Path
    bronze = rag.Bronze(Path(LAKE))
    while True:
        name, cuisine = _research_q.get()
        t0 = time.time()
        try:
            res = rag.research(name, cuisine, None, bronze, searcher, n=6, min_recipes=3, judge_model=None, pause=0.5)
            entry = {"name": name.lower(), "aliases": [], "cuisine": cuisine, "status": res.status,
                     "typicalIngredients": [i for i, v in res.ingredients.items() if v["class"] == "typical"],
                     "evidence": {i: v for i, v in res.ingredients.items()},
                     "source": {"type": "web-retrieval", "collected": time.strftime("%Y-%m-%d"), "recipes": res.accepted}}
            if res.status == "typical":
                _write_local_cache(entry)
            else:
                _unknown_until[_norm(name)] = time.time() + 3600
            sys.stderr.write(f"lookup: researched '{name}' -> {res.status} ({len(entry['typicalIngredients'])} ingredients, {res.accepted} recipes, {time.time()-t0:.1f}s)\n")
        except Exception as e:
            _unknown_until[_norm(name)] = time.time() + 600
            sys.stderr.write(f"lookup: research failed for '{name}': {e}\n")
        finally:
            with _in_flight_lock:
                _in_flight.discard(_norm(name))
                ev = _done_events.pop(_norm(name), None)
            if ev:
                ev.set()
            _research_q.task_done()


def lookup(name, cuisine):
    name = (name or "").strip()[:80]
    if len(_norm(name)) < 2:
        return 400, {"error": "dish name missing"}
    d = find_dish(name)
    if d:
        return 200, _lookup_payload(d)
    key = _norm(name)
    if not (RESEARCH or LLM):
        return 200, {"dish": name, "status": "unknown", "ingredients": [], "ingredientsSource": "none", "cached": False, "note": "server started without --llm / --research"}
    if _unknown_until.get(key, 0) > time.time():
        return 200, {"dish": name, "status": "unknown", "ingredients": [], "ingredientsSource": "none", "cached": False}
    with _in_flight_lock:
        queued = key in _in_flight
        if not queued:
            _in_flight.add(key)
            _done_events[key] = threading.Event()
        ev = _done_events.get(key)
    if not queued:
        _research_q.put((name, cuisine))
    # The model usually answers in a second or two: wait briefly so the Lens gets the answer on its first ask.
    if LLM and ev is not None and ev.wait(LLM_WAIT_S):
        d = find_dish(name)
        if d:
            return 200, _lookup_payload(d, cached=False)
        return 200, {"dish": name, "status": "unknown", "ingredients": [], "ingredientsSource": "none", "cached": False}
    return 200, {"dish": name, "status": "researching", "ingredients": [], "ingredientsSource": "none", "cached": False, "retryAfterS": 8}


def load_menus():
    # Prefer the joined output of `node tools/build-data.js` (ingredients filled from the dish knowledge
    # base, sources marked) so the Lens sees the same data live as compiled in; the raw seed is the fallback.
    built = os.path.join(ROOT, "data", "menus.lens.json")
    menus = json.load(open(built if os.path.exists(built) else os.path.join(ROOT, "data", "menus.json"), encoding="utf-8"))
    lake = os.path.join(ROOT, "data-lake", "gold", "lens", "menus.json")
    if WITH_LAKE and os.path.exists(lake):
        by_id = {r["id"]: r for r in menus.get("restaurants", [])}
        for r in json.load(open(lake, encoding="utf-8")).get("restaurants", []):
            by_id[r["id"]] = r  # lake entry wins over the seed
        menus["restaurants"] = list(by_id.values())
    menus["served"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return menus


def load_products():
    return json.load(open(os.path.join(ROOT, "data", "products.json"), encoding="utf-8"))


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload, etag=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=60")
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path in ("/menus.json", "/menus"):
                payload = load_menus()
                stable = dict(payload)
                stable.pop("served", None)
            elif path in ("/products.json", "/products"):
                payload = load_products()
                stable = payload
            elif path == "/lookup":
                q = parse_qs(self.path.partition("?")[2])
                status, payload = lookup((q.get("dish") or [""])[0], (q.get("cuisine") or [None])[0])
                self._send(status, payload)
                return
            elif path in ("/health", "/"):
                m, p = load_menus(), load_products()
                self._send(200, {"ok": True, "restaurants": len(m.get("restaurants", [])), "products": len(p.get("products", [])), "withLake": WITH_LAKE,
                                 "research": RESEARCH, "llm": _llm_stats if LLM else False, "researching": len(_in_flight)})
                return
            else:
                self._send(404, {"error": "not found", "paths": ["/menus.json", "/products.json", "/lookup?dish=", "/health"]})
                return
            etag = '"' + hashlib.sha1(json.dumps(stable, sort_keys=True).encode()).hexdigest()[:16] + '"'
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            self._send(200, payload, etag)
        except Exception as e:  # never take the server down for one bad file
            self._send(500, {"error": str(e)})

    do_HEAD = do_GET

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    global WITH_LAKE, RESEARCH, SEARCH, LAKE, LLM
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--with-lake", action="store_true", help="merge data-lake/gold/lens/menus.json into /menus.json")
    ap.add_argument("--research", action="store_true", help="/lookup misses are researched on the web (needs requests + beautifulsoup4)")
    ap.add_argument("--llm", action="store_true", help="/lookup misses are answered by a small model (ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment); wins over --research")
    ap.add_argument("--search", choices=["ddg", "brave"], default="ddg", help="search backend for --research (brave needs BRAVE_API_KEY)")
    ap.add_argument("--lake", default=LAKE, help="data lake folder (gold/dishes.json read; bronze/ written by research)")
    a = ap.parse_args()
    WITH_LAKE, RESEARCH, SEARCH, LAKE, LLM = a.with_lake, a.research, a.search, a.lake, a.llm
    if LLM:
        threading.Thread(target=_llm_worker, name="llm", daemon=True).start()
    elif RESEARCH:
        threading.Thread(target=_research_worker, name="research", daemon=True).start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"AllergyLens data server on http://{a.host}:{a.port}  (menus.json, products.json, lookup, health; with-lake={WITH_LAKE}, llm={LLM}, research={RESEARCH})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

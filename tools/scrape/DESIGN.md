# AllergyLens data pipeline — design (v2)

Status: revised 2026-11-02 after Mukesh's review. v1 was 2026-11-01.
Replaces the pipeline description in `tools/scrape/README.md` once accepted.

Section 0 answers every review note from v1, one by one, and says what changed.
The rest of the document is the revised design. Resolved notes were removed
from the body; new objections go in as `> Q:` / `> NO:` lines as before.

---

## 0. Answers to the v1 review notes

**0.1 "Which vision LLM exactly?"**
`qwen3-vl:8b` from the Ollama library (6.1 GB, image + text, needs Ollama ≥ 0.12.7)
is the default for every vision job in the scraper. `qwen3-vl:32b` (21 GB) is
the escalation for menus the 8B gets wrong. `llama3.2-vision`, already pulled on
this machine, is the tested fallback until the Qwen3-VL pull is done. All three
run through the same Ollama endpoint and the same JSON-schema prompt, so
switching is a flag (`--vision-model`). For the on-glasses, real-time path the
model is whatever Snap's Remote Service Gateway offers (Gemini today), with
the same JSON schema. Details in §7 and §13.

**0.2 "Did the Lens Studio people already solve reading text from a menu?"**
Not as a built-in. I checked Snap's Spectacles docs and samples: there is no
OCR or text-recognition API in Lens Studio. The sanctioned way is Camera Module
frames → Remote Service Gateway → a vision model (Gemini / OpenAI), which is
what the README already planned for the real-device version. The gallery is
not accessible from a Lens. So: the scraper does the heavy reading offline; on
the glasses, a known menu is matched by image marker (already built) and only
an unknown menu goes through RSG. §7.4.

**0.3 "I want to work on all the menus that people upload."**
Understood: the source is the menu *photos* attached to a restaurant's Google
Maps listing (and later, photos our own users capture), not restaurant
websites. The design is now images-first. Website crawl and PDFs are demoted to
optional lanes. §6 is rewritten.

**0.4 "I asked for RAG: give the model internet access so it looks the ingredients up."**
That is exactly what Stage E is, and the v1 text buried it. Restated plainly:
for each dish we *search the web*, *fetch* the recipe pages, *extract* the
ingredient lists from the pages' structured markup, and *store the URLs* next
to every ingredient. The model only reads what was fetched. If the search finds
too little, the dish is `unknown` — the system says "I don't know" instead of
guessing. The old `enrich_dishes.py` (LLM from memory) is deleted and replaced
by `ingredients_rag.py`. §9.

**0.5 "Groceries: the retailer product page has an image of the ingredients panel. Just read that."**
Yes, and it is now one of three lanes, in this order:
1. The package in the user's hand. The SPECS camera sees the actual ingredients
   panel; OCR it (RSG). Most direct, always current, no third party.
2. Barcode → Open Food Facts. It returns the ingredients *text* for most US
   products instantly, plus the label *photos* it holds for that product, so
   when its text is empty we OCR its photo, same as a retailer image.
3. Retailer product-page images (Walmart / Target / Amazon). Same OCR. These
   sites block automated access hard and forbid it in their terms; it is an
   adapter behind a flag, used to fill gaps, not the backbone. §11.

**0.6 "The whole point is to save time: precompute so a visit costs < 1 s instead of 3–5 min."**
Agreed, and this is now the organising idea of the architecture: **cache-first,
on demand, then precompute**. The Lens asks the backend for the restaurant it
is in. Cache hit → answer in well under a second. Miss → the backend fetches
that restaurant's menu photos, processes them, caches, and answers (the first
visitor waits; everyone after does not). In the background the crawler
precomputes the popular restaurants county by county so that misses are rare.
Dishes are cached independently of restaurants (§8), so a brand-new menu whose
dishes are already known costs only OCR time. §4.

**0.7 "We don't need restaurant websites; most restaurants don't have one."**
Correct for independents, and it is now optional (§6.3). It stays in the doc
because when a site *does* exist it often carries the cleanest menu text, and
it costs nothing to try after the photo lane.

**0.8 "We can use Google Maps, we are doing this for free, nobody can touch us."**
Here is the honest version. Google's Maps Platform terms forbid scraping and
forbid building a dataset from Maps content, and they say nothing about free
vs paid: a non-profit use is still a breach of the terms. That breach is a
contract matter between you and Google, not a crime. In practice the
consequences are: IP blocks and CAPTCHAs while crawling, suspension of any
Google Cloud project tied to the same account, and a takedown demand if the
product ever gets attention. For a hackathon demo the realistic risk is "it
stops working", not a lawsuit.
Your friend's Gemini run shows it is technically doable, and it is: a
headless browser opens the place page, opens the photo viewer's "Menu"
category and collects the image URLs. So the design treats Google Maps as a
**source adapter you can switch on**, with three rules: default off; no
CAPTCHA solving or bot-detection evasion in our code (if Google blocks it, it
stops); and derived data is stored with `source.type = "google-maps-web"` so it
can be purged if ever needed. The Places API `photos` field is the sanctioned
alternative for the same photos (up to 10 per place) and is lane 2. §6.1, §14.

*Tested 2026-11-02 on the GX10:* Google serves its **"limited view"** to every
browser we tried that is not a signed-in, cookie-carrying session: headless
Chromium, windowed Chromium, and the Claude app's own browser pane. The limited
view has **no photo categories** (no "Menu" tab). In a *windowed* browser the
gallery still shows the listing's top 7–9 photos, uncategorised; in headless it
shows none. The adapter therefore collects those top photos when a display is
available (`--headed`; use `xvfb-run` on a server, never the user's own desktop
display, which steals focus and keystrokes) and runs them through the menu gate.
Full menu galleries need the Places API or a human session. Not a thinking
problem: Google decides what a robot sees.

**0.9 "Price detection: 'show me what is under $10' highlighted green."**
Added. Prices are already read per line in Stage C; they are now a stored
column on every menu item and exported to the Lens, which gets a price filter
alongside the allergen filter. §7.3, §12, Lens work item in §16.

**0.10 "Can users talk to the Lens and can it talk back?"**
Talking to it already exists: `AllergyLensVoice.ts` listens through the Specs
ASR module ("say the dish name"). Talking back is Lens Studio's
Text-To-Speech module, which Spectacles support; it needs a network. Adding
spoken answers ("Paneer Korma contains cashews and cream") is a Lens work item
in §16, not a scraper change.

**0.11 "In which format, which folder, which columns? For dishes, ingredients, groceries, sources, in detail."**
§12 is rewritten as a full schema: every table, every column, its type and
meaning, the folder layout, and the file formats (Parquet + DuckDB for the
lake, JSON for what the Lens reads, CSV export on request).

**0.12 "Can we really get all US restaurants from open data?"**
No source has 100 %. Google is the most complete single list; Overture +
Foursquare + OpenStreetMap together cover most of it but miss some new and
some tiny places. That is why discovery is no longer load-bearing: the Lens
knows its GPS, and an unknown restaurant is fetched on demand and cached
(0.6). Discovery only decides what to precompute first. §5.

**0.13 "Not PDF. Images."**
Agreed. Images are the primary input for Stage C; PDFs are one optional branch
of the optional website lane. §6, §7.

**0.14 "What do you mean by canonical dish?"**
One master record per dish concept in a **dish catalog**, which every
restaurant's spelling of that dish points to ("Paneer Shai Kurma", "Shahi
Paneer Korma", "Panir Korma" → one `shahi-paneer-korma`). Ingredients are
looked up once per catalog entry and reused by every restaurant that serves it.
Renamed throughout to "dish catalog" / "catalog entry". §8.

**0.15 "If a menu item was already processed, count +1 and skip; only process new ones; if the menu prints ingredients, use those and highlight them."**
That is exactly the cache-first rule, now explicit: every catalog entry has
`seen_count` and `last_seen`; a menu item that matches an existing entry
increments the count and does no retrieval; printed ingredients on the menu are
stored as restaurant-confirmed and shown with the highlight. §8, §9.

**0.16 "Classification needs more than veg / non-veg / dessert."**
The category set is expanded to a fixed list (veg, egg, chicken, mutton/lamb,
beef, pork, seafood, vegan, dessert, soft drink, alcoholic drink, bread, rice,
soup/salad, kids, side) plus independent diet markers (gluten-free, halal,
kosher, jain, nut-free) and a spice level when printed. Tell me what is still
missing; the list is a config file, not code. §10.

**0.17 "Section values: Vegetarian / non vegetarian / soft drink / sweet / or what?"**
Two separate fields now: `section_text` is whatever the menu prints ("From the
Tandoor"); `category` is one value from the fixed list in 0.16. §7.3.

**0.18 "Why fetch from the home page? Fetch from the stored data."**
Agreed. Every stage after acquisition reads only from our own store (§12
bronze), never from the internet again. The home-page crawl was the website
lane, now optional (0.7).

**0.19 "Barcode: can we get ingredients from it?"**
Yes, for most US packaged products, through Open Food Facts (0.5 lane 2). The
barcode is printed on every package, so the SPECS camera can read it. When OFF
has no text, lanes 1 and 3 OCR the label image.

**0.20 (image) "Walmart page shows the Nutrition Facts / ingredients photo. Why not use it?"**
Answered in 0.5: we do use label images, OCR'd by the same code path, and the
retailer page is lane 3 of three. The one caution is operational, not legal
purity: Walmart and Target run aggressive bot protection, so a crawler that
depends on them will break often. The camera in the store and OFF do not.

---

## 1. Purpose

For any restaurant a SPECS wearer sits down in, AllergyLens needs the dishes
on the menu, where each sits on the page, what each is made of, its price, and
which allergens, religious rules and fitness flags that implies. For any
packaged product the wearer picks up, the same from its label. The answer must
arrive in well under a second when the place or product has been seen before.

The Lens keeps reading the `menus.json` / `products.json` shapes in
`data/README.md`, extended with `price`, `category`, `markers` and per-ingredient
sources.

## 2. Where we are (after this revision)

| Piece | File | State |
|---|---|---|
| Menu photo → menu / not-menu, dish names | `classify_menu_photos.py` | works; default model moves to `qwen3-vl:8b`; cheap gates added before it (§7.1) |
| Menu photo → dish lines with positions | `ocr_menu.py` | works on one real menu; OCR engine upgrade planned (§7.2) |
| Dish → ingredients | `ingredients_rag.py` (**new**, replaces `enrich_dishes.py`) | web retrieval with citations, cache-first, unknown when thin (§9) |
| Restaurant rating | `fetch_rating.py` | halted |
| Grocery products | `fetch_products.py` | works (OFF); label-image OCR lanes to add (§11) |
| Restaurant discovery | — | planned (§5), not load-bearing |
| Menu photos from a listing | — | planned (§6) |
| Storage | `data/*.json` | lake layout specified (§12), to build |
| Validation + Lens module | `tools/build-data.js` | works; needs `price`, `category`, `markers` passthrough |

## 3. Principles

1. **An LLM is never the source of a fact.** It reads, labels, normalises and
   judges text or images we fetched. Every ingredient, marker, price and
   category traces to a URL, an image hash, or a dataset row, with a date.
2. **Unknown is never safe.** Too little evidence → `unknown` → amber in the
   Lens ("ask the restaurant"). The pipeline must be able to say "I don't know".
3. **Cache first, fetch once, process once.** Nothing is fetched twice (content
   hash), no dish is researched twice (catalog), no restaurant is re-processed
   unless its menu photos changed.
4. **Deterministic where possible.** Allergen mapping, price parsing, county
   assignment, layout boxes and the category decision are rules and lookups.
5. **Source choice is yours, consequences are written down.** Each data source
   is an adapter with its terms stated in §14; the risky ones ship off by
   default and are switched on by a flag.

## 4. Architecture: cache-first, on demand, then precompute

```
            Lens (SPECS)                              Backend (GX10)
   ┌──────────────────────────┐   place / GPS / photo   ┌─────────────────────────────────┐
   │ known menu? → image marker│ ─────────────────────► │ cache lookup: restaurant → menu  │
   │ unknown?   → camera frame │ ◄───────────────────── │ hit  → gold JSON        (< 1 s) │
   │ product?   → barcode/label│   gold JSON             │ miss → ACQUIRE → PROCESS → cache │
   └──────────────────────────┘                          └─────────────────────────────────┘
                                                                     ▲
                        background precompute, county by county ─────┘

ACQUIRE  (§6)  menu photos from the listing (Places API photos | Google Maps web adapter | own captures)
               [optional] restaurant website: JSON-LD / HTML / PDF
                     │  images, pages → bronze store (§12)
PROCESS  (§7)  gate (price-regex + CLIP) → OCR with boxes → vision LLM labels OCR lines (JSON schema)
                     │  menu items: name, layout, section_text, category, markers, price, printed description
CATALOG  (§8)  match each item to the dish catalog → hit: seen_count+1, reuse ingredients
                     │  miss: new catalog entry
RESEARCH (§9)  web search → fetch recipe pages → structured ingredient lists → vote → cite  (or unknown)
                     │
CLASSIFY (§10) ingredient → allergen (OFF taxonomy + aliases); markers + section + ingredients → category
                     │
GROCERY  (§11) label in hand (OCR) | barcode → OFF | retailer label image (OCR)
                     │
STORE    (§12) bronze (raw) → silver (DuckDB + Parquet) → gold (JSON the Lens reads)
```

Every box is a script with one input table and one output table, idempotent,
re-runnable on a subset (`--restaurant star-of-india`, `--state OH --county Athens`).

## 5. Stage A — Restaurant discovery (what to precompute first)

Discovery decides the precompute order; it no longer has to be complete,
because an unknown restaurant is handled on demand (§4).

1. **Open place data**: Overture Maps `places` and/or Foursquare Open Source
   Places, filtered to food categories. Keep name, category, lat/lon, address,
   phone, website, source ids.
2. **State and county**: spatial join to US Census TIGER county polygons. Every
   later table is partitioned by `state/county`.
3. **Deduplicate** across sources (name similarity + < 50 m + same phone/site).
4. **Google**: the Places API Nearby/Text Search gives the Google `place_id`,
   which is what both photo lanes in §6 key on. Within the free tier it is used
   per county on demand, not as a national sweep. If the Google Maps web
   adapter is enabled, discovery can also come from a Maps search page per
   county, under the same conditions as §6.1.
5. **Priority** for precompute: review count / popularity, demo region first,
   then outward by county.

## 6. Stage B — Menu acquisition (images first)

All lanes write raw files to the bronze store (§12). Every later stage reads
only from there.

### 6.1 Lane 1: menu photos attached to the restaurant's listing (primary)

Two adapters produce the same output (a set of image files + a manifest row):

| Adapter | How | Terms / risk | Default |
|---|---|---|---|
| `places_api_photos` | Place Details → `photos[]` (≤ 10 per place) → photo media endpoint | allowed by the API terms; stored *derived* data is still a grey area under their no-dataset clause | on |
| `google_maps_web` | headless browser (Playwright) opens the place page → photo viewer → "Menu" tab → image URLs → download | breach of Maps terms (0.8); blocks and CAPTCHAs expected; **no evasion code** — on a block the adapter stops and logs | **off**, `--allow-google-maps-web` |

Photos pass through the menu gate (§7.1) so that food and interior photos are
discarded cheaply.

### 6.2 Lane 2: our own captures

Phone photos now; SPECS captures later, with the wearer's consent, uploaded
by the Lens when it meets an unknown menu. Every real use of the app grows the
cache. These are the only photos we fully own, and the ones used as image
markers (record printed width in cm).

### 6.3 Lane 3 (optional): the restaurant's website

Only when discovery supplied a URL. Fetch pages matching `menu|food|order`
(depth ≤ 2, ≤ 30 pages, robots.txt, 1 req/s). Prefer schema.org `Menu`
JSON-LD, then HTML (Playwright if JS-rendered), then PDF (text layer via
`pdfplumber`, scans → §7 as images), then menu images → §7.

## 7. Stage C — Menu understanding (image → dish lines)

### 7.1 Gate: is this image a menu?

| Gate | Signal | Cost |
|---|---|---|
| Price density | OCR text has ≥ 5 price patterns or ≥ 5 right-aligned integers | free (reuses 7.2) |
| Zero-shot classifier | SigLIP 2 / CLIP ViT-L: "printed restaurant menu" vs "plate of food", "restaurant interior", "storefront", "receipt" | ms |
| Vision LLM | only when the two above disagree | seconds |

### 7.2 OCR with word boxes

PaddleOCR by default (multi-column, decorative fonts), Surya as alternative,
Tesseract kept as a flag. The existing line grouping in `ocr_menu.py` (rows by
vertical centre, split at wide gaps) stays. Output: numbered lines with text
and `{x, y, w, h}` as image fractions.

### 7.3 Grounded labelling by the vision model

Model: `qwen3-vl:8b` via Ollama (0.1). It receives the image **and** the
numbered OCR lines and must return JSON matching this schema (Ollama `format`):

```json
{ "line": 17,
  "role": "dish | section | description | price | marker | other",
  "dish_of": 17,
  "section_text": "Vegetarian Entrees",
  "category": "veg | egg | chicken | mutton | beef | pork | seafood | vegan | dessert | soft_drink | alcohol | bread | rice | soup_salad | kids | side | unknown",
  "markers": ["V", "GF", "spicy:2"],
  "price": 12.95,
  "text_corrected": "Paneer Shahi Korma" }
```

Rules: the model may only reference existing line ids (no invented dishes;
layout = OCR box). `category` here is the model's *reading of the menu*
(section heading, printed marker, printed description), stored as
`category_printed`; the final category is decided in §10 with ingredient
evidence. Printed descriptions become restaurant-confirmed ingredient
evidence (§9 tier 1). Icons (green/red dot, leaf, chilli) go through a second
"describe the icon next to line N" prompt and a per-cuisine lookup table.

Hard cases flagged explicitly: handwritten boards, bilingual menus (both
names kept as aliases), prices in a separate column (joined by row in 7.2).

### 7.4 On-glasses path for an unknown menu

Camera Module frame → Remote Service Gateway → vision model with the *same*
schema (without OCR line ids, so layout comes from the model's boxes and is
lower confidence) → the result is uploaded to the backend as a lane-2 capture
so the next visitor gets the cached answer.

## 8. Stage D — Dish catalog (process each dish once)

1. Normalise the menu name (lowercase, strip price and parentheses,
   transliteration table `panir→paneer`, `nan→naan`, `alu→aloo`).
2. Match against the catalog: exact alias → done; else `bge-m3` embedding
   cosine ≥ 0.88 → done; 0.80–0.88 → text LLM confirms "same dish?" on the two
   names plus printed descriptions; else new entry.
3. Hit: `seen_count += 1`, `last_seen = today`, link the menu item, **no
   research**. Miss: create the entry and queue it for §9.
4. Restaurant-specific descriptions stay on the menu item; only the dish
   concept and its researched ingredients are shared.

## 9. Stage E — Ingredients by web retrieval, with citations

Script: `tools/scrape/ingredients_rag.py`. Runs only for catalog entries with
no accepted evidence (cache-first). The model never supplies a recipe.

### Evidence tiers

| Tier | Source | Stored as | Citation |
|---|---|---|---|
| 1 | printed description on the menu / listing | `restaurant` | image hash or page URL |
| 2 | recipe pages found by web search, ingredient list read from their schema.org `Recipe` markup | `typical` | each page URL |
| 3 | Wikipedia / Wikidata "main ingredients" | `typical` | article URL |
| 4 | Open Food Facts product (branded items on a menu) | `label` | OFF URL |

### Procedure

1. **Search** `"<dish>" <cuisine> recipe ingredients` (plus one alias query).
   Backend is pluggable: `ddg` (no key, default for development), `brave`
   (API key), `searxng` (self-hosted URL). Keep the top 10 URLs.
2. **Fetch** each page into bronze. Parse every `<script type="application/ld+json">`;
   keep objects whose `@type` is `Recipe`; read `name`, `recipeIngredient[]`,
   `recipeYield`, `url`. Fall back to `itemprop="recipeIngredient"` microdata.
   Pages with neither are dropped. Prose is never parsed for ingredients.
3. **Same-dish check**: token overlap between the menu name and the recipe
   name, with an optional local text model (`--judge-model`) for the ambiguous
   band. Only `same` / `variant` recipes count.
4. **Parse** each ingredient string deterministically (quantity, unit, name,
   preparation stripped): `"2 tbsp ghee, melted"` → `ghee`. Synonym merge
   from a small table (`heavy cream`, `double cream` → `cream`); an LLM may
   propose merges within the retrieved set but may not add or remove items.
5. **Vote**: `support = recipes containing it / recipes accepted`.
   ≥ 0.5 → `typical`; 0.25–0.5 → `sometimes`; below → kept raw, not exported.
   Tier-1 ingredients are `restaurant` regardless.
6. **Unknown rule**: fewer than 3 accepted recipes → `status = unknown`,
   nothing exported as ingredients, Lens shows amber.
7. **Shares** (optional): from recipe quantities when ≥ 3 recipes have them;
   otherwise none, and the Lens uses the "principal ingredient" rule.
8. **Substitutes**: only when retrieved text says so explicitly.

### Record written to the catalog

```json
{ "name": "shahi paneer korma", "aliases": ["paneer shai kurma"], "cuisine": "indian",
  "status": "typical",
  "typicalIngredients": ["paneer", "cream", "cashews", "onion", "tomato", "ghee"],
  "evidence": {
    "paneer":  { "support": 1.0, "class": "typical", "sources": ["https://…/shahi-paneer", "https://…/paneer-korma"] },
    "cashews": { "support": 0.7, "class": "typical", "sources": ["…"] },
    "ghee":    { "support": 0.4, "class": "sometimes", "sources": ["…"] } },
  "recipes_considered": 10, "recipes_accepted": 7,
  "seen_count": 3, "last_seen": "2026-11-02",
  "source": { "type": "recipes", "collected": "2026-11-02", "search": "ddg" } }
```

`typicalIngredients` stays a plain lowercase list so `build-data.js` and the
Lens keep working; `evidence` carries the per-ingredient citations.

## 10. Stage F — Allergens and category

**Ingredient → allergen** is a lookup: Open Food Facts ingredient taxonomy
(synonyms + allergen links such as `ghee → milk`) with `data/allergens.json`
as overrides (religious and fitness groups are ours). Unmapped ingredients go
to the review queue and the dish stays unverified until mapped.

**Category** (one of the fixed list in 7.3) is decided from evidence in this
order, each stored with its origin: printed marker → section heading → printed
description → verified ingredients (chicken present → `chicken`; any meat or
fish → non-veg family; egg only → `egg`). Diet markers (`gluten_free`, `halal`,
`kosher`, `jain`, `nut_free`, `spicy:n`) are a separate list, never inferred
from the name. Conflicts are flagged and the Lens shows the stricter answer.
The lists live in `tools/scrape/taxonomy.json`, so adding a category is a data
change.

## 11. Stage G — Grocery products (three lanes, one OCR path)

| Lane | Source | When | Output |
|---|---|---|---|
| 1 | the package in hand: SPECS camera frame of the ingredients panel → OCR (RSG or backend) | always available in the store | ingredient text, `source.type = label-ocr`, image hash |
| 2 | barcode → Open Food Facts API (text, allergen tags, nutrition, and OFF's own label photos) | precomputed cache; most US products | as today in `fetch_products.py` |
| 3 | retailer product-page label image (Walmart / Target / Amazon) → same OCR | gap fill when 1 and 2 fail | `source.type = retailer-image`, adapter off by default |

Declared allergen lines ("Contains: wheat, soy") win over ingredient matching.
OFF search moves to `/api/v2/search`; the nightly OFF dump replaces thousands
of calls for category sweeps. The Lens-side barcode read is a Lens work item.

## 12. Storage: folders, formats, columns

### Folder layout (GX10, one tree, `data-lake/` at the repo root, git-ignored)

```
data-lake/
  bronze/                          raw, immutable, never edited
    assets/<sha256[0:2]>/<sha256>.<ext>    jpg | png | webp | html | pdf | json
    manifest.parquet                        one row per asset (columns below)
  silver/                          processed; one DuckDB file, Parquet partitions
    allergylens.duckdb
    restaurants/state=OH/county=Athens/part-*.parquet
    menu_items/state=OH/county=Athens/part-*.parquet
    dish_catalog.parquet  dish_ingredients.parquet  ingredient_sources.parquet
    sources.parquet  allergen_map.parquet  products.parquet  review_queue.parquet
  gold/                            what the Lens reads
    menus/<restaurant_id>.json     data/README.md shape + price, category, markers, evidence
    products.json  dishes.json  allergens.json
```

Formats: **Parquet** for anything big or partitioned (columnar, compressed,
readable by DuckDB, pandas, Spark). **DuckDB** as the SQL layer over those
files (one file, no server). **JSON** only for gold, because the Lens and
`build-data.js` read JSON. **CSV** is an export command (`duckdb -csv`), not a
storage format. The committed `data/` folder is a snapshot of gold for the demo
restaurants, so the Lens never depends on the lake.

### Tables and columns

`bronze.manifest` — every fetched thing
| column | type | meaning |
|---|---|---|
| sha256 | text, PK | content hash; file name in `assets/` |
| url | text | where it came from (null for own captures) |
| source_type | text | `places-api-photo`, `google-maps-web`, `own-capture`, `website`, `recipe-page`, `off-api`, `retailer-image` |
| content_type | text | mime |
| bytes | int | size |
| fetched_at | timestamp | |
| http_status | int | |
| restaurant_id / barcode | text | what it was fetched for (nullable) |

`restaurants`
| column | type | meaning |
|---|---|---|
| restaurant_id | text, PK | stable slug (`star-of-india-athens-oh`) |
| name | text | |
| lat, lon | double | |
| state, county | text | from the TIGER join; partition keys |
| address, phone, website | text | nullable |
| google_place_id | text | nullable |
| source_ids | json | ids in Overture / Foursquare / OSM |
| discovered_at, last_menu_check | timestamp | |

`menu_versions` — one row each time a restaurant's menu was (re)processed
| column | type | meaning |
|---|---|---|
| restaurant_id, menu_version | text, int, PK | |
| asset_hashes | json | the images/pages this version was built from |
| acquired_via | text | lane (`places-api-photo`, …) |
| processed_at | timestamp | |
| model_versions | json | OCR engine, vision model tag, prompt hash |

`menu_items` — one row per printed line that is a dish
| column | type | meaning |
|---|---|---|
| restaurant_id, menu_version, item_id | text, PK | |
| name_raw, name_clean | text | OCR text; normalised |
| dish_id | text, FK | catalog entry (§8) |
| section_text | text | heading as printed |
| category_printed | text | from §7.3 |
| category | text | final, from §10 |
| markers | json | `["V","GF","spicy:2"]` |
| price | decimal | nullable |
| printed_description | text | nullable; tier-1 evidence |
| printed_ingredients | json | parsed from the description, nullable |
| layout_x, layout_y, layout_w, layout_h | double | fractions of the image |
| asset_sha256 | text | the image this line was read from |
| confidence | double | |

`dish_catalog`
| column | type | meaning |
|---|---|---|
| dish_id | text, PK | |
| canonical_name | text | |
| aliases | json | |
| cuisine | text | |
| status | text | `restaurant`, `typical`, `unknown` |
| recipes_considered, recipes_accepted | int | |
| seen_count | int | how many menu items point here |
| first_seen, last_seen, researched_at | timestamp | |

`dish_ingredients` — one row per (dish, ingredient)
| column | type | meaning |
|---|---|---|
| dish_id, ingredient | text, PK | normalised ingredient name |
| class | text | `restaurant`, `typical`, `sometimes` |
| support | double | fraction of accepted recipes containing it |
| share_pct, share_spread | double | nullable |
| substitute | text | nullable |

`sources` and `ingredient_sources` — the citations
| table | columns |
|---|---|
| sources | source_id PK, url, title, source_type (`recipe-jsonld`, `wikipedia`, `menu-image`, `off`), retrieved_at, sha256 |
| ingredient_sources | dish_id, ingredient, source_id (PK over all three) |

`allergen_map`
| column | meaning |
|---|---|
| ingredient PK | normalised name |
| allergen_ids | json, e.g. `["milk"]` |
| origin | `off-taxonomy`, `alias`, `manual` |

`products`
| column | type | meaning |
|---|---|---|
| barcode | text, PK | |
| name, brand | text | |
| ingredients | json | list, or null = unknown |
| ingredients_source | text | `off-text`, `label-ocr`, `retailer-image` |
| declared_allergens, traces | json | from the label's "Contains" / "May contain" |
| sugar_g, trans_fat_g, saturated_fat_g, sodium_mg, kcal | double | per 100 g |
| high_sugar, trans_fat, high_sodium | bool | fitness flags |
| image_sha256 | text | the label image used, nullable |
| source_url, collected_at | text, timestamp | |

`review_queue`
| column | meaning |
|---|---|
| id, kind | `unmapped_ingredient`, `category_conflict`, `low_confidence_menu`, `blocked_source` |
| payload | json |
| created_at, resolved_at | |

Schemas are Pydantic models in `tools/scrape/schemas.py`; the gold JSON is
validated against them by `build-data.js` through an exported JSON Schema.

## 13. Models and hardware

All local on the GX10 (GB10, 128 GB). The real-time on-glasses path uses
whatever RSG offers.

**Serving engine: vLLM for extraction, Ollama for quick checks** (decided
2026-11-02). vLLM batches many menu images through the GPU at once, enforces the
JSON schema with guided decoding (no cut-off answers), and serves Qwen3-VL
directly. The scripts switch with environment variables:
`VLM_API=openai VLM_BASE_URL=http://localhost:8000/v1 VLM_MODEL=Qwen/Qwen3-VL-8B-Instruct`.
Default (no variables) is Ollama with the fallback list below.

Found on this box: the Ollama service runs with `OLLAMA_NUM_PARALLEL=50`, which
multiplies every model's KV cache by 50 (the 72B asks for 471 GB and refuses to
load; the qwen2.5-vl runner crashes). Fix (sudo):
`systemctl edit ollama` → `[Service]` / `Environment=OLLAMA_NUM_PARALLEL=2`, then
`systemctl restart ollama`. Also upgrade Ollama to pull `qwen3-vl`.

| Job | Model | Notes |
|---|---|---|
| Menu gate | SigLIP 2 / CLIP ViT-L zero-shot | ms per image |
| OCR + boxes | PaddleOCR; Surya; Tesseract (flag) | |
| Vision labelling (7.3), icon reading, menu gate | **Qwen3-VL-8B-Instruct on vLLM** (escalation: 32B); Ollama fallback list `qwen3-vl:8b`, `qwen2.5vl:7b`, `llama3.2-vision` | vLLM guided JSON; Ollama `format` |
| Same-dish judge, synonym merge | Qwen3 14B, or `qwen2.5:72b` already pulled | reading only |
| Dish dedupe | `bge-m3` embeddings | |
| Ingredient parsing | deterministic parser | no LLM |
| Allergen mapping | OFF taxonomy lookup | no LLM |

Every model call logs model tag, prompt hash and raw response to bronze.

## 14. Sources and their terms (your call per adapter)

| Source | Use | Terms | Default |
|---|---|---|---|
| Overture / Foursquare OSP / OSM | discovery | open licences | on |
| US Census TIGER | counties | public domain | on |
| Google Places API (search, details, photos) | place ids, menu photos | allowed by API terms; derived storage grey; no caching > 30 days except place_id | on |
| Google Maps website | menu photos, discovery | breach of Maps terms (0.8); blocks expected; no evasion | **off** |
| Own captures (phone, SPECS) | menu images, markers | ours | on |
| Restaurant websites | menus | robots.txt, rate limit | on when a URL exists |
| Recipe sites' schema.org markup | ingredients | published for machine reading; we store lists + URLs | on |
| Wikipedia / Wikidata | dish facts | CC BY-SA | on |
| Open Food Facts | products, taxonomy | ODbL, attribution | on |
| Walmart / Target / Amazon product images | label OCR fill | terms forbid; heavy bot protection | **off** |
| Yelp, DoorDash, Grubhub, Uber Eats | — | forbid; no adapter | — |

## 15. Quality

- Golden set: Star of India (31 hand-checked lines) plus 10 more menu photos of
  different styles from Google listings and our own captures.
- Metrics: gate precision/recall; dish-line recall; category accuracy;
  marker accuracy; price accuracy; layout IoU ≥ 0.5; ingredient precision on 50
  hand-verified dishes; `unknown` rate (must be > 0).
- Review queue CLI writes fixes back to `allergens.json`, `taxonomy.json`,
  the catalog.
- Safety invariant in CI: nothing `unknown` is ever exported as safe.

## 16. Phases

| Phase | Deliverable | Status |
|---|---|---|
| 1 | `ingredients_rag.py`: cache-first web retrieval with citations; run on the Star of India dishes; delete `enrich_dishes.py`; README updated | **in progress** |
| 2 | Stage C: `qwen3-vl:8b` default, gates, schema in 7.3 with category / markers / price; `build-data.js` passes price, category, markers through | next |
| 3 | Lane 1 acquisition: `places_api_photos` adapter; `google_maps_web` adapter behind its flag; on-demand backend endpoint (`GET /menu?place_id=`) with cache | |
| 4 | Lake: DuckDB + Parquet per §12, gold export feeding `build-data.js` | |
| 5 | Dish catalog with embeddings + `seen_count`; precompute loop for one county | |
| 6 | Grocery lanes 1 and 3 (label OCR); OFF v2 search | |
| Lens | price filter (0.9); spoken answers via TTS (0.10); barcode read + product lookup; upload of unknown-menu captures (6.2) | Lens work items |

## 17. Open questions

1. Google Maps web adapter: switch it on for the demo region, knowing 0.8?
2. Category list (0.16): what is missing for the cuisines you care about?
3. Search backend for production: Brave key, or a SearXNG container on the GX10?
4. Demo region for phases 3–5: Athens County, OH?

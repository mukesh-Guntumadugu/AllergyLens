# Scraper pipelines (run on the ASUS GX10)

Design, source policy and storage schema: `tools/scrape/DESIGN.md`.

Two pipelines feed the Lens. Neither runs inside Lens Studio; they produce
JSON under `data/`, and `node tools/build-data.js` turns that into the module
the Lens compiles in. Everything here is plain Python + one Node script.

```
Pipeline 1  restaurants   photo/web menu -> dish lines with positions -> ingredients, shares, substitutes -> rating
Pipeline 2  groceries     barcode / search / category -> ingredients, allergen tags, nutrition, fitness flags
```

## Run the whole thing (three commands, no Claude needed)

```bash
tools/scrape/start_all.sh      # starts the vision server, waits for it, starts ONE driver (safe to re-run; never doubles up)
tools/scrape/watch.sh          # live view: driver state, current stage log, totals (Ctrl+C to leave; the scraper keeps going)
tools/scrape/stop_all.sh       # stops the driver (add --vllm to stop the vision server too)
```

The driver walks every county in `tools/scrape/counties.txt`, stage by stage, and starts over after a pass
(`LOOP=1`). Every stage is resumable: if anything dies, run `start_all.sh` again and it continues where it was.
Results: `data-lake/review/index.html` (open in a browser, or `python3 -m http.server 8765 --bind 127.0.0.1 -d data-lake/review`),
`data-lake/gold/` (per-county menus, dish catalog, products), `Assets/Data/AllergyData.ts` after `node tools/build-data.js --with-lake`.
Optional keys go in `.env` at the repo root (`GOOGLE_PLACES_API_KEY=...`); the driver re-reads it every county.

Why it can stop: the vision server and the driver are ordinary processes. If they were started from a chat
session or a terminal that later closed, they die with it. `start_all.sh` starts them detached (setsid + nohup),
so only a reboot or `stop_all.sh` stops them. After a reboot, run `start_all.sh` once.

## Query the data with SQL (DuckDB)

Every stage still writes its JSON/JSONL files, and `build_db.py` folds them into one database file,
`data-lake/silver/allergylens.duckdb` (the driver rebuilds it after every county; seconds). Tables follow DESIGN.md §12:
`restaurants`, `menu_assets`, `menu_gate`, `menu_items` (+ view `menu_dishes` = lines from accepted images),
`dish_catalog`, `dish_ingredients`, `ingredient_sources`, `products`, `product_ingredients`, `review_queue`,
`bronze_manifest`, `crawl_log`.

**See the data in a browser** (tables on the left, rows on the right, SQL box on top, a few ready-made questions):

```bash
.venv/bin/python tools/scrape/db_viewer.py      # then open http://127.0.0.1:8766
```

```bash
.venv/bin/python tools/scrape/build_db.py            # rebuild now
.venv/bin/python tools/scrape/build_db.py --sqlite   # same tables as data-lake/silver/allergylens.sqlite, for tools without DuckDB
.venv/bin/python tools/scrape/build_db.py --query "SELECT r.name, d.name_clean, d.price, string_agg(i.ingredient, ', ') AS ingredients
   FROM menu_dishes d JOIN restaurants r USING (restaurant_id) JOIN dish_ingredients i ON i.dish_id = d.dish_id
   WHERE r.county = 'Athens' GROUP BY 1,2,3 ORDER BY 1,2"
```

Allergen lookup across every restaurant: `SELECT r.name, d.name_clean FROM menu_dishes d JOIN restaurants r USING (restaurant_id)
JOIN dish_ingredients i ON i.dish_id = d.dish_id WHERE i.ingredient IN ('peanut','peanuts')`. Citations: `ingredient_sources`.
`pip install duckdb` in the venv (done on the GX10); the Python `duckdb` module also opens the file from pandas or a notebook.

## Setup on the GX10 (once)

```bash
git clone https://github.com/mukesh-Guntumadugu/AllergyLens.git && cd AllergyLens
sudo apt install -y tesseract-ocr ffmpeg          # (brew install tesseract ffmpeg on macOS)
pip install pytesseract pillow requests
curl -fsSL https://ollama.com/install.sh | sh      # local vision model for photo classification / dish-line labelling
ollama pull qwen3-vl:8b                            # vision: menu / not-menu, read dish names (needs Ollama >= 0.12.7)
pip install ddgs beautifulsoup4                    # web search + HTML parsing for ingredients_rag.py (no LLM involved)
node --version                                     # any Node 18+ for tools/build-data.js
```

Commit `data/` and the regenerated `Assets/Data/AllergyData.ts` when done;
pull on the Lens machine and Lens Studio picks the data up on the next build.

## Run it yourself (one county, end to end)

**Unattended:** `tools/scrape/run_pipeline.sh` runs every stage below in order for each
county in `tools/scrape/counties.txt`, logs to `data-lake/logs/`, never aborts on one failed
stage, and is safe to restart (every stage resumes). For a 24–48 h run:

```bash
tmux new -d -s allergylens 'LOOP=1 tools/scrape/run_pipeline.sh'     # or nohup ... &
tail -f data-lake/logs/status.log
```

Everything below is a plain script; nothing needs Claude or Lens Studio. Each step is
restartable and skips work it already did. Raw pages/images land in `data-lake/bronze/`,
tables in `data-lake/silver/`, Lens-shaped JSON in `data-lake/gold/` (all git-ignored).

```bash
python3 -m venv .venv && .venv/bin/pip install playwright rapidocr-onnxruntime pymupdf requests beautifulsoup4 ddgs pillow
.venv/bin/playwright install chromium

# A. which restaurants exist (OpenStreetMap, free) -> data-lake/silver/restaurants.jsonl
.venv/bin/python tools/scrape/discover_restaurants.py --state Ohio --state-code OH --county "Athens County"

# B. menus: restaurant websites (menu pages, PDFs, images, schema.org Menu)  -> menu_assets.jsonl
.venv/bin/python tools/scrape/acquire_websites.py
.venv/bin/python tools/scrape/pdf_menus.py                       # PDF pages -> images
#    menus: listing photos through the official Places API (needs GOOGLE_PLACES_API_KEY)
#    Put secrets in .env at the repo root (gitignored), one NAME=value per line. The driver re-reads it before
#    every county, so adding the key while it runs is enough; no restart. For a one-off run, export it in the shell.
echo "GOOGLE_PLACES_API_KEY=paste-your-key-here" >> .env
set -a; . ./.env; set +a; .venv/bin/python tools/scrape/sources/places_api_photos.py --from-restaurants --limit 20
#    menus: Google Maps web adapter — OFF by default, breaches Maps terms (DESIGN.md §0.8). Google serves its
#    "limited view" (no Menu category) to any non-signed-in browser; a WINDOWED browser still gets the top 7-9 photos,
#    headless gets none. So run it windowed on a virtual display (sudo apt install -y xvfb), never on your desktop:
xvfb-run -a .venv/bin/python tools/scrape/sources/google_maps_web.py --allow-google-maps-web --headed --jobs jobs.jsonl

# C. which images are menus; then OCR + vision labelling -> data-lake/gold/menus.oh-athens.json
.venv/bin/python tools/scrape/gate_menu_images.py
.venv/bin/python tools/scrape/process_menus.py

# E. ingredients by web retrieval with citations -> data-lake/gold/dishes.json (seed data/dishes.json is read only)
.venv/bin/python tools/scrape/ingredients_rag.py data-lake/gold/menus.oh-athens.json

# Lens data
node tools/build-data.js
```

Vision model (DESIGN.md §13). Preferred: **vLLM serving Qwen3-VL** — batched, schema-enforced JSON:

```bash
vllm serve Qwen/Qwen3-VL-8B-Instruct --port 8000 --max-model-len 16384 --gpu-memory-utilization 0.45 --limit-mm-per-prompt '{"image":1}'
export VLM_API=openai VLM_BASE_URL=http://localhost:8000/v1 VLM_MODEL=Qwen/Qwen3-VL-8B-Instruct   # before gate / process / run_pipeline
```

Fallback without those variables: Ollama; `--vision-model auto` tries `qwen3-vl:8b`, `qwen2.5vl:7b`,
`llama3.2-vision` in that order and uses the first that loads. On this GX10 the Ollama service has
`OLLAMA_NUM_PARALLEL=50`, which breaks large models — see DESIGN.md §13 for the one-line fix.

## Pipeline 1 — restaurant menus

```bash
# a) mixed photo folder -> which ones are menus + dish names (optional)
python3 tools/scrape/classify_menu_photos.py --photos ./photos/star-of-india \
    --restaurant-id star-of-india --restaurant-name "Star of India" --out ./out/star-of-india.menu.json

# b) menu photo -> dish lines WITH positions (the Lens highlights these on the real page)
python3 tools/scrape/ocr_menu.py data/menus/star-of-india/menu-1.png \
    --restaurant-id star-of-india --restaurant-name "Star of India" \
    --out data/menus/star-of-india/menu-1.ocr.json --marker-width-cm 29.7 [--llm qwen2.5vl:7b]

# c) dish names -> ingredients by WEB RETRIEVAL with citations (no LLM facts; see DESIGN.md §9)
#    searches recipes, reads each page's schema.org Recipe ingredient list, votes across recipes,
#    stores the source URLs per ingredient; dishes with < 3 agreeing recipes stay UNKNOWN (amber in the Lens).
#    Cache-first: dishes already in the seed or the lake catalog are not researched again (seen_count is bumped).
python3 tools/scrape/ingredients_rag.py data/menus.json --restaurant star-of-india --cuisine Indian
#    --search brave|searxng for a production search backend (default ddg needs no key); --force to re-research;
#    --judge-model qwen2.5:72b-instruct-q8_0 adds a local model that only answers "same dish?" (never ingredients)

# d) rating + reviews mentioning allergies (official Google Places API, allowed by its terms)
GOOGLE_PLACES_API_KEY=... python3 tools/scrape/fetch_rating.py "Star of India, Athens OH" \
    --out data/menus/star-of-india/rating.json

# e) paste the restaurant entry (with its rating) into data/menus.json, then
node tools/build-data.js
```

Already done for the test menu: `data/menus/star-of-india/menu-1.png` (a real
printed menu) → 31 dish lines with positions, all with ingredients, shares,
categories.

**Positions are the point of (b).** Each dish gets `layout: {x, y, w, h}` as
fractions of the image. The Lens registers the image as a tracking marker
(`menuImage.widthCm` = printed width), so when the glasses see the real menu,
the mark lands on that printed line. Shoot menus flat, straight-on, bright, no
glare; crop to the page; ≤ 2048 px on the long side.

**(c) evidence.** Each catalog entry carries `evidence[ingredient] = {support,
class, sources[]}`: `support` is the fraction of accepted recipes that list the
ingredient, `sources` are the recipe URLs. `shares` / `substitutes` (the
replacement rule: an allergen under 10 % of the dish → "ask the chef to leave
it out"; over 10 % → swap or order something else) are kept only when the hand-
curated entry had them. Raw fetched pages live in `data-lake/bronze/`
(git-ignored); unknown dishes are listed in `data-lake/silver/review_queue.jsonl`.

**Sources:** restaurant websites, your own printed menus / photos, recipe
sites, Open Food Facts. Don't bulk-download Google Maps pages or photos —
its terms forbid it; use the Places API for ratings/reviews.

## Pipeline 2 — grocery products (Walmart, Target, any store)

Open Food Facts has 3M+ packaged products with ingredient lists, the label's
own allergen and "may contain" tags, and nutrition per 100 g. Free API, open
data (ODbL — keep the attribution line that the script writes into
`data/products.json`).

```bash
# scan barcodes in the store, or search, or pull whole categories
python3 tools/scrape/fetch_products.py --barcode 0049000028911 0037600112949
python3 tools/scrape/fetch_products.py --search "peanut butter cookies" --n 40
python3 tools/scrape/fetch_products.py --category en:breakfast-cereals --n 200 --country united-states
python3 tools/scrape/fetch_products.py --file barcodes.txt      # one barcode or search term per line

node tools/build-data.js                                        # -> PRODUCTS in Assets/Data/AllergyData.ts
```

Each product carries `ingredients`, `allergens` (declared), `traces` ("may
contain"), `nutrition` (sugar, trans fat, saturated fat, sodium, kcal per
100 g) and `fitness` flags (`highSugar` ≥ 15 g, `transFat` ≥ 0.5 g,
`highSodium` ≥ 480 mg). The Lens checks products with the same allergen
aliases as dishes; declared `allergens`/`traces` win over ingredient matching.

Good categories to start with for a store demo: `en:cookies`, `en:snacks`,
`en:breakfast-cereals`, `en:sodas`, `en:ice-creams`, `en:jams`, `en:yogurts`,
`en:chips`, `en:chocolates`, `en:plant-based-milks`.

## Ratings (badge rule the Lens shows on the page)

| badge | when |
|---|---|
| **avoid** | no dish is safe, or `allergyComplaints` ≥ 3 |
| **caution** | fewer than half the dishes are safe, or any dish is unverified, or `allergyComplaints` ≥ 1 |
| **good** | otherwise |

Shown as "Star of India · 10 of 31 safe · ★4.5 · 1 review mentions allergies".

## Regional / aggregate analysis (later)

Because every dish and product is stored with its source, restaurant and
collection date, the same JSON can be rolled up: most common dishes per
cuisine, which allergens appear most in a region, which restaurants publish
ingredients. Nothing in the Lens depends on that; it's a notebook over
`data/` when you want it.

## Where scraped data lives (never in git)

Everything the scraper produces stays in `data-lake/` (gitignored): bronze assets, silver tables, gold county files,
and the local Lens snapshot `data-lake/gold/lens/menus.json` + `data-lake/gold/lens/menus/<restaurant>/menu-n.*`.
`data/` is the committed, hand-curated seed only. `Assets/Data/AllergyData.ts` is committed as the seed-only build;
for a local Lens build with the scraped restaurants run `node tools/build-data.js --with-lake` and do not commit the result.
`.gitignore` blocks `data/menus/*/` (except the hand-checked `star-of-india`) as a backstop.

## Quality rules (tools/scrape/text_quality.py)

One rule set, used by the gate, the labeller, the merge and the ingredient researcher:

- an image is extracted only if its long side is >= 700 px, RapidOCR finds >= 6 lines and the mean
  OCR confidence is >= 0.70; otherwise the gate records `not_menu` with the reason
  (`low-resolution`, `too-little-text`, `unreadable-ocr`). Thumbnails of real menus are rejected on purpose:
  what we cannot read we must not guess.
- a labelled "dish" line is dropped when it is a size (`6"`), mostly symbols or digits (`B.Y.O.B`, `Blt - $9`),
  has no vowel, is only menu scaffolding (`Build Your Own`, `Large`), is a sentence, or carries a price.
- `rebuild_gold.py` re-applies both rules to everything already extracted without re-running the vision model.
- `review_export.py` writes `index.html` (accepted menus and their dishes only) and `index-all.html`
  (every collected image, red = rejected, with the reason in the tooltip).

## Groceries (tools/scrape/fetch_products.py)

Packaged products come from Open Food Facts (open data, ODbL, attribution required). For each product we keep
the ingredient list, allergen and trace tags, nutrition, and the **photo of the printed ingredient label**
(`labelImage`, downloaded to `data-lake/bronze/products/<barcode>-ingredients.jpg`) as the evidence behind it.
The driver runs one pass over `tools/scrape/product_categories.txt` per loop. Store sites such as Walmart sit
behind bot detection, which we do not evade (DESIGN.md §14); scanning a barcode in the store and
`--barcode <code>` reaches the same record.

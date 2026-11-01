# Scraper pipelines (run on the ASUS GX10)

Two pipelines feed the Lens. Neither runs inside Lens Studio; they produce
JSON under `data/`, and `node tools/build-data.js` turns that into the module
the Lens compiles in. Everything here is plain Python + one Node script.

```
Pipeline 1  restaurants   photo/web menu -> dish lines with positions -> ingredients, shares, substitutes -> rating
Pipeline 2  groceries     barcode / search / category -> ingredients, allergen tags, nutrition, fitness flags
```

## Setup on the GX10 (once)

```bash
git clone https://github.com/mukesh-Guntumadugu/AllergyLens.git && cd AllergyLens
sudo apt install -y tesseract-ocr ffmpeg          # (brew install tesseract ffmpeg on macOS)
pip install pytesseract pillow requests
curl -fsSL https://ollama.com/install.sh | sh      # local LLMs for photo classification + dish enrichment
ollama pull qwen2.5vl:7b                           # vision: menu / not-menu, read dish names
ollama pull llama3.1:8b                            # text: dish -> ingredients, shares, substitutes
node --version                                     # any Node 18+ for tools/build-data.js
```

Commit `data/` and the regenerated `Assets/Data/AllergyData.ts` when done;
pull on the Lens machine and Lens Studio picks the data up on the next build.

## Pipeline 1 — restaurant menus

```bash
# a) mixed photo folder -> which ones are menus + dish names (optional)
python3 tools/scrape/classify_menu_photos.py --photos ./photos/star-of-india \
    --restaurant-id star-of-india --restaurant-name "Star of India" --out ./out/star-of-india.menu.json

# b) menu photo -> dish lines WITH positions (the Lens highlights these on the real page)
python3 tools/scrape/ocr_menu.py data/menus/star-of-india/menu-1.png \
    --restaurant-id star-of-india --restaurant-name "Star of India" \
    --out data/menus/star-of-india/menu-1.ocr.json --marker-width-cm 29.7 [--llm qwen2.5vl:7b]

# c) dish names -> typical ingredients with % share and substitutes (local LLM; Open Food Facts optional)
python3 tools/scrape/enrich_dishes.py data/menus/star-of-india/menu-1.ocr.json --cuisine Indian

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

**(c) shares and substitutes** feed the replacement rule: an allergen under
10 % of the dish → "ask the chef to leave it out"; over 10 % → "removing it
guts the dish — you'd pay the same for less; swap: X, or order Y instead".
LLM-generated entries are marked `source.type: "llm"`; replace with verified
data when you have it.

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

# Scraper helpers (run on the ASUS GX10)

These produce entries for `data/menus.json` and `data/dishes.json`. The Lens
never runs them. Full pipeline for one restaurant:

```bash
# 1. photos -> which ones are menus (optional, if you have a folder of mixed photos)
python3 tools/scrape/classify_menu_photos.py --photos ./photos/star-of-india ...

# 2. menu photo -> dish lines WITH positions on the page (the Lens highlights these)
brew install tesseract && pip install pytesseract pillow requests
python3 tools/scrape/ocr_menu.py data/menus/star-of-india/menu-1.png \
  --restaurant-id star-of-india --restaurant-name "Star of India" \
  --out data/menus/star-of-india/menu-1.ocr.json --marker-width-cm 29.7

# 3. dish names -> typical ingredients with % share and substitutes (local LLM via Ollama)
python3 tools/scrape/enrich_dishes.py data/menus/star-of-india/menu-1.ocr.json --cuisine Indian

# 4. rating + allergy complaints (official Google Places API)
GOOGLE_PLACES_API_KEY=... python3 tools/scrape/fetch_rating.py "Star of India, Athens OH" \
  --out data/menus/star-of-india/rating.json

# 5. paste the entry (with its rating) into data/menus.json, then
node tools/build-data.js
```

Already done for the test menu: `data/menus/star-of-india/menu-1.png` (a real
printed menu) and its `menu-1.ocr.json` with 31 dish lines and positions.

## ocr_menu.py — positions are the point

Each dish gets `layout: {x, y, w, h}` as fractions of the image. The Lens
registers the image as a tracking marker (`menuImage.widthCm` is the printed
width), so when the camera sees the real menu, the green/red/amber bar lands
on that printed line. Tips: shoot the menu flat and straight-on, good light,
no glare; crop to the page; keep the file under 2048 px on the long side.

## enrich_dishes.py — shares and substitutes

Adds `shares` (rough % of the dish per ingredient) and `substitutes` to each
dish in the knowledge base. The Lens uses them for the replacement rule: an
allergen under 10% of the dish → "ask the chef to leave it out"; over 10% →
"removing it guts the dish — you'd pay the same for less; substitute: X, or
order Y instead". LLM-generated entries are marked `source.type: "llm"`.

## classify_menu_photos.py

Takes a folder of photos for one restaurant, asks a local open-source vision
model (via [Ollama](https://ollama.com)) which ones are menus, reads the dish
names off the menu photos, and writes one restaurant entry in the
`data/menus.json` shape.

```bash
ollama pull qwen2.5vl:7b
pip install requests
python3 tools/scrape/classify_menu_photos.py \
  --photos ./photos/thai-basil \
  --restaurant-id thai-basil --restaurant-name "Thai Basil Kitchen" \
  --out ./out/thai-basil.menu.json
```

Paste the output entry into `data/menus.json` → `restaurants`, then run
`node tools/build-data.js`. Dishes the photo gave no ingredients for get
`ingredients: null`; the build script fills them from `data/dishes.json` when
the dish name is known (shown in the Lens as "typically contains …, confirm"),
otherwise they stay unverified (amber).

## Ratings

Add a `rating` block to a restaurant to feed the restaurant-level badge:

```json
"rating": {
  "stars": 4.3,
  "reviewCount": 812,
  "allergyComplaints": 2,
  "source": { "type": "google-places-api", "url": null, "collected": "2026-11-02" }
}
```

`allergyComplaints` = how many reviews mention allergy problems or wrong
orders (count them with a keyword filter or the same local LLM over the review
text). Get ratings and reviews through the official Google Places API, which
permits it; don't scrape the Maps web pages.

## Badge rule (what the Lens shows on the Restaurant picker)

For the user's current profile:

| badge | when |
|---|---|
| **avoid** | no dish is safe, or `allergyComplaints` ≥ 3 |
| **caution** | fewer than half the dishes are safe, or any dish is unverified, or `allergyComplaints` ≥ 1 |
| **good** | otherwise |

Shown as "4 of 6 safe · ★4.3 · 2 reviews mention allergies".

# Scraper helpers (run on the ASUS GX10)

These produce entries for `data/menus.json`. The Lens never runs them.

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

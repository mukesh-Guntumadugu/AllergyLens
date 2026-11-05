# AllergyLens

**Look at a menu through SPECS and the dishes you can't eat are underlined in red, the ones you can get a green dot. Pinch a line and a card tells you what's in it, whether the kitchen can leave it out, or what to order instead.**

AllergyLens is a see-through AR Lens for Snap SPECS, built for
[Learn AR with SPECS](https://learn-specs.devpost.com/) on Devpost. It runs
against *your* profile: allergies (peanut, tree nut, milk, egg, wheat, soy,
fish, shellfish, sesame), religious rules (no beef, no pork, no gelatin, no
alcohol) and fitness goals (trans fat, high sugar). Nothing is drawn over the
menu except the line marks, one small badge chip for the restaurant, and the
detail card you asked for.

Repo: https://github.com/mukesh-Guntumadugu/AllergyLens

---

## Status (4 Nov 2026)

| Part | State |
|---|---|
| Profile panel (17 toggles + 6 mood chips) as a separate step before the menu | Working, on the real camera path |
| Real printed menus recognised by the camera (image markers): Star of India, Laurel Café & Co, Tatlılar (the last two from the user's own handheld videos) | Working — marks on the printed lines, confirmed on the handheld Laurel video 4 Nov |
| Three verdicts per dish: safe / contains / unverified, from the data | Working |
| Replacement rule (under 10 % of the dish → "leave it out", over → swap or nearest safe dish) | Working |
| Restaurant badge chip (safe count, stars, allergy reviews) | Working |
| Mood filter ("Vegetarian", "Chicken"…) with "order this" stars and an edge arrow to off-screen matches | Working in the preview |
| Voice: say the dish name instead of pinching (SPECS ASR) | Built; only testable on the glasses |
| Grocery products: label recognised by the camera → outline in the verdict colour + one chip ("Jif Creamy Peanut Butter · contains peanuts") → pinch for the card | Built; the Jif label marker is a placeholder image until a photo of the real jar replaces `Assets/Markers/product-0051500255162.png` |
| Scraper pipeline v2 (restaurant discovery → menu acquisition → OCR + vision labelling → cited ingredient research → data lake), unattended per county on the GX10 | Merged 4 Nov; runs outside the Lens |
| Live fallback when a dish is not in the database (web / LLM) | Designed below; not built yet |
| LEAF integration tests | 9 scenarios, 9/9 pass |

---

## What the demo shows (3 minutes)

The shot list with timings and voice-over is in
[devpost/demo-script.md](devpost/demo-script.md). The flow:

1. **Profile.** A panel floats in front of you. Pinch *Peanut* and *Milk*,
   pick the mood *Vegetarian*, pinch *Done*. The panel disappears. Nothing is
   in the world yet.
2. **Look at the menu.** The camera recognises the printed Star of India menu.
   Within a second the printed lines get marks: thin red underline + red dot
   on *Paneer Nan* and *Kheer* (milk), green dot on *Alu Gobi*, amber dot on
   dishes whose ingredients the restaurant doesn't publish. One badge chip
   sits in the page's top margin: *Star of India · 14 of 31 safe · ★4.5 ·
   1 allergy review*.
3. **Pinch a red line.** A card opens beside it. *Mutter Paneer:* "Paneer is
   about 35% of this dish — leaving it out guts the dish; you'd pay the same
   for less. Ask for a swap: tofu." *Maharani Dal:* "Contains cream (about
   10% of the dish). Ask the chef to leave them out." Pinch again to close.
4. **Mood.** With *Vegetarian* on, only vegetarian lines are marked and the
   safe ones get a green star ("order this"). Lines outside the glasses'
   display band get a small *← Vegetarian* arrow at the edge.
5. **Look away.** The marks fade out; the small Profile button comes back.
6. **(Product segment)** Same profile, pick up a jar of peanut butter: the
   label gets the same red underline + card from the Open Food Facts data.
   *(Not built yet; see Roadmap.)*

---

## How it works

```
 OFFLINE (once per restaurant, on the ASUS GX10)            ON THE GLASSES (every time you look)
 ─────────────────────────────────────────────────           ──────────────────────────────────────────────
 menu photo ──► gate ──► OCR with boxes ──► Qwen3-VL ──┐     camera ──► MarkerTrackingComponent
                labels each printed line: name, box,   │                  (Assets/Markers/MenuMarker.imgmarker)
                section, price, markers, category      ▼                           │ page pose
 dish name ──► web retrieval with citations ──► data/menus.json ──┐                ▼
                recipe pages' schema.org lists,  data/dishes.json  │   AllergyLensMenuOverlayUI
                voted across ≥3 recipes; shares, data/allergens.json ├─► build-data.js ─► Assets/Data/AllergyData.ts
                substitutes from the curated seed data/products.json │        (compiled into the Lens)
 Google Places API ──► stars, allergy reviews ──┘                  │                 │
 Open Food Facts API ──► packaged products ────────────────────────┘                 ▼
                                                                   AllergyLensChecker  (profile × ingredients → verdict)
                                                                                    │
                                                                                    ▼
                                                                   marks on the printed lines · badge · detail card
```

**Recognition.** The printed menu is an image-marker. The OCR step stores each
dish's box as fractions of the page (`layout: {x, y, w, h}`); the Lens knows
the printed width (29.7 cm) so every mark is placed in centimetres on the
page plane. No frames leave the device and nothing is sent anywhere to draw
the marks.

**The check** (`Assets/Scripts/AllergyLensChecker.ts`) is pure string
matching: an ingredient matches an allergen if it contains any alias from
`data/allergens.json` ("ghee", "whey" and "casein" all count as milk). It runs
in microseconds, so the profile can change while the menu is in view and the
marks update instantly.

| verdict | when | drawn as |
|---|---|---|
| safe | ingredients known, nothing matched | green dot (green star in a mood category) |
| contains | ≥ 1 ingredient matches the profile | thin red underline + red dot |
| unverified | restaurant publishes nothing and the dish is not in the knowledge base | amber dot. **Unknown never becomes safe.** |

Ingredients come from the restaurant when published, otherwise from the dish
knowledge base (`data/dishes.json`: what a pad thai or butter chicken is
*typically* made of). Since pipeline v2 a knowledge-base entry is built by
web retrieval, not by a model: recipe pages found by search, their schema.org
ingredient lists voted across at least three agreeing recipes, every
ingredient stored with its source URLs. A dish with fewer than three agreeing
recipes stays unknown (amber). Matches from a typical recipe are always worded
"typically contains … confirm with the restaurant".

**The replacement rule.** Each known ingredient has a share of the dish. Under
10 %: "ask the chef to leave it out". Over 10 %: removing it guts the dish and
you'd pay the same for less, so the card offers the knowledge-base substitute
("tofu for paneer") or the nearest safe dish on the same menu.

**Modules** (`Assets/Scripts/`, all TypeScript, SIK 0.18 + UI Kit):

| file | owns |
|---|---|
| `AllergyLensMain.ts` | the flow: profile → recognition → check → detail; voice; optional remote data |
| `AllergyLensMenuOverlayUI.ts` | one per menu page: marks, badge chip, mood arrow, simulated page for the preview |
| `AllergyLensChecker.ts` | verdicts, badge rule, replacement wording (pure, no scene access) |
| `AllergyLensProfileUI.ts` / `DishDetailUI.ts` / `ProfileButtonUI.ts` | the three UI surfaces |
| `AllergyLensProductOverlayUI.ts` | one per product label: outline, chip, pinch target; `PRODUCT_MARKERS` lists the bundled label markers and Main creates one tracker per entry at start |
| `AllergyLensVoice.ts` | fuzzy dish-name match + SPECS ASR session |
| `AllergyLensMenuData.ts` | typed access to the generated data, remote `menus.json` validation |
| `Assets/LeafTests/` | 9 LEAF scenarios driving the real Lens in the preview |

---

## When the dish is not in the database

The bundled data is tier 0 and always wins. Everything below only runs on a
miss, and nothing below is allowed to turn an unknown dish green.

| tier | source | cost | state |
|---|---|---|---|
| 0 | `Assets/Data/AllergyData.ts` compiled into the Lens (4 restaurants, 49 dishes, 17 allergens, 10 products) | zero, offline | built |
| 1 | `menus.json` fetched once at start from a URL (`menusUrl` input on `AllergyLens`); same shape, validated, bundled data on any failure. `tools/serve_data.py` serves it from the GX10 (seed + data lake, ETag, CORS) | one ~10 KB GET per session | built |
| 2 | Open Food Facts API by barcode for packaged products (`world.openfoodfacts.org/api/v2/product/<barcode>`) | free, ODbL | pipeline built, Lens call not yet |
| 3 | Backend cache on the GX10 by place: a restaurant the pipeline already processed answers from `data-lake/gold/` in under a second (`tools/scrape/DESIGN.md` §4); a miss queues acquire → process → research and answers amber meanwhile | one small GET | designed, backend scripts built |
| 4 | Unknown dish *name* only: web retrieval with citations (the same `ingredients_rag.py` step), or a small model through Snap's **Remote Service Gateway** (OpenAI / Gemini with a Snap-issued token, no personal API key; a user's own key through `InternetModule` for a limited session) | ~150 tokens per dish, cached forever | designed |
| 5 | Menu with no marker: one down-scaled camera frame through the Remote Service Gateway to a vision model with the *same* line schema; the result is uploaded as a capture so the next visitor gets the cached answer (DESIGN.md §7.4) | one image call per *page*, never per frame | designed |

Guardrails that stay the same at every tier: results from a model are stored
with `source.type: "llm"` and worded as *typical*; the amber "ask the
restaurant" state is the default whenever a tier times out (4 s) or disagrees.

---

## Keeping it fast and cheap

1. **The hot path is offline.** Marker tracking, the check and the drawing
   never touch the network. A look at a known menu costs nothing.
2. **Expensive work happens once per restaurant, not once per user.** Menu
   reading runs on the GX10 with local models (RapidOCR for boxes, Qwen3-VL 8B
   served by vLLM with schema-enforced JSON, batched); ingredients come from
   web retrieval, so no model ever invents a recipe and there is no API bill.
   The result is a JSON file every user gets for free, precomputed county by
   county by an unattended driver (`tools/scrape/run_pipeline.sh`).
3. **Cache by menu, not by frame.** A page is recognised by its marker; its
   data is keyed by restaurant id. A model is only ever asked about a dish
   once; the answer goes into `menus.json`.
4. **Small prompts, small models.** The LLM tier sends the dish name and
   cuisine, not the photo, and asks for a fixed JSON (ingredients, shares,
   substitutes). All unknown dishes on a page go in one batched call. A
   Flash / mini class model is enough for "what is usually in a kheer".
5. **One image, not a stream.** For an unmarked menu the vision tier gets a
   single 512-px JPEG, after a stillness check, and the result is cached as a
   marker-less page entry.
6. **Budget caps built in.** Per-session call cap, 4 s timeout, and the Lens
   degrades to amber instead of waiting. No spinner over the menu, ever.
7. **Tiny payloads.** A restaurant entry is ~30 KB of JSON; the compiled data
   module for 4 restaurants, the dish catalog and 10 products is about 50 KB.
   Marker images are capped at 2048 px.
8. **Free, open data where it exists.** Open Food Facts for products (ODbL,
   attribution kept in `data/products.json`); the official Google Places API
   for ratings instead of scraping.

---

## Data pipelines

Two pipelines, both plain Python + one Node script, documented in
[tools/scrape/README.md](tools/scrape/README.md) (how to run) and
[tools/scrape/DESIGN.md](tools/scrape/DESIGN.md) (design, source policy,
storage schema); the data shapes are in [data/README.md](data/README.md).

```
Pipeline 1  restaurants   discover (OpenStreetMap) → menus (website, PDF, Places photos, own captures, or a handheld
                          video: tools/scrape/page_from_video.py picks the sharpest frame and flattens the page)
                          → gate → OCR with boxes → vision labelling → dish catalog → cited ingredient research
                          → allergens + category → data-lake/gold/ → menus.json
Pipeline 2  groceries     barcode / search / category → Open Food Facts → ingredients, allergen tags, nutrition, fitness flags
```

Raw pages and images land in `data-lake/bronze/`, tables in `silver/`,
Lens-shaped JSON in `gold/` (all git-ignored). Every stage is a script with
one input and one output table, restartable, and skips work it already did.

```bash
node tools/build-data.js               # validates data/*.json and regenerates Assets/Data/AllergyData.ts
node tools/build-data.js --with-lake   # local build that also joins the scraped data-lake (never commit that output)
tmux new -d -s allergylens 'LOOP=1 tools/scrape/run_pipeline.sh'   # unattended run over tools/scrape/counties.txt
```

Current contents: 4 restaurants (Star of India is the real one: a printed menu,
31 dish lines with positions, every line with ingredients and a category),
the dish knowledge base, 17 allergens with aliases, 10 Open Food Facts
products with declared allergens and fitness flags (sugar ≥ 15 g, trans fat
≥ 0.5 g, sodium ≥ 480 mg per 100 g).

---

## Testing

Three ways to run it, from most to least real:

| mode | what you need | what it proves |
|---|---|---|
| **SPECS** | the glasses, the printed menu (A4/Letter) | the real thing incl. pinch, voice, see-through display band |
| **Lens Studio Preview → Multimedia** with `data/menus/star-of-india/menu-1-pan.mp4` (or the webcam and a printout), device **SPECS 27** | Lens Studio 5.23.2 | real recognition path: marker lock, marks on the printed lines, badge |
| **Interactive Preview** with `debugSimulateMarker` on | Lens Studio only | profile → marks → pinch → card logic, with the menu image drawn on a simulated page 60 cm ahead |

The step-by-step manual guide is [TESTING.md](TESTING.md).

Automated: 9 LEAF scenarios (`Assets/LeafTests/`) run inside the live Lens:
profile panel and Done, peanut+milk marks and badge on the Star of India
page, the replacement rule, detail card on pinch, marker lost, vegetarian and
chicken moods incl. the edge arrow, light marks in "everything" mode, and the
voice matcher. Turn on `autoRun` on the `LeafRunner` object, refresh, and
read `[LEAF SUMMARY] 9/9 passed` in the Logger. Both debug flags are saved
**off** in the committed scene.

Toolchain: Lens Studio 5.23.2, Spectacles Interaction Kit 0.18, Spectacles UI
Kit, Leaf; built with CLAD (Snap's coding agents) through the Lens Studio MCP;
scrapers run on an ASUS GX10 (vLLM + Ollama, local only).

---

## Repo layout

```
AllergyLens.esproj          Lens Studio project
Assets/Scripts/             AllergyLens*.ts — flow, overlay, checker, UI, voice, audio
Assets/LeafTests/           LEAF scenarios + the test interactor
Assets/Data/AllergyData.ts  generated by tools/build-data.js — do not edit by hand
Assets/Markers/             MenuMarker.imgmarker + menu-1.png (the printed Star of India menu)
Assets/Icons, Materials, GeneratedSFX
data/                       allergens.json, dishes.json, menus.json, products.json, menus/<restaurant>/
tools/build-data.js         validate + join + generate
tools/scrape/               the two pipelines (OCR, enrichment, ratings, Open Food Facts)
devpost/                    design brief, demo script
TESTING.md                  manual test guide
```

## Running it

1. Open `AllergyLens.esproj` in Lens Studio 5.23.2.
2. Preview panel → source dropdown → **Multimedia → Open file…** →
   `data/menus/star-of-india/menu-1-pan.mp4`; device **SPECS 27**.
3. Refresh. The marker locks within a second or two; refresh again if not.
4. Hands-free profile for recording: select `AllergyLens`, set
   `defaultProfile` to `peanut,milk` and `defaultMood` to `everything` or
   `vegetarian`, refresh.
5. Click a marked line (click = pinch) for the card.

### Live data from the GX10

```bash
python3 tools/serve_data.py --port 8787 --with-lake     # on the GX10; /menus.json, /products.json, /health
```

Then select `AllergyLens` in Lens Studio and set `menusUrl` to
`http://<gx10-ip>:8787/menus.json`. The Lens fetches it once at start,
validates the shape, re-checks any menu in view, and keeps the bundled data
if the server is unreachable. `--with-lake` merges every restaurant the
scraper has finished (`data-lake/gold/lens/menus.json`) over the committed
seed, so new menus reach the glasses without a rebuild.

## Roadmap

- Real product label photos (one per product) to replace the placeholder marker;
  more products through `tools/scrape/fetch_products.py --barcode`.
- Tier 3 LLM fallback through the Remote Service Gateway, batched per page,
  cached into `menus.json`.
- More restaurants through Pipeline 1 (one photo + 10 minutes on the GX10 each).
- Regional roll-ups over `data/` (most common allergens per cuisine).

## Data attribution

Product data from [Open Food Facts](https://openfoodfacts.org) (ODbL).
Restaurant data from the restaurants' own printed menus and the Google Places
API. Dish knowledge base from recipe references, each entry carries its
source and collection date.

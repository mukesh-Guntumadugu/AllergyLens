# AllergyLens

**Look at a menu through SPECS and the dishes you can't eat are underlined in red, the ones you can get a thin green underline. Pinch a line and a card tells you what's in it, whether the kitchen can leave it out, or what to order instead.**

AllergyLens is a see-through AR Lens for Snap SPECS, built for
[Learn AR with SPECS](https://learn-specs.devpost.com/) on Devpost. It runs
against *your* profile: the nine major allergens (peanut, tree nut, milk, egg,
wheat, soy, fish, shellfish, sesame), religious or cultural rules (no beef,
no pork, no alcohol; gelatin counts as beef or pork), diet (vegetarian, vegan,
trans fat, high sugar), and anything else you say: "I'm allergic to mango"
adds it on the spot. Nothing is drawn over the
menu except the line marks, one small badge chip for the restaurant, and the
detail card you asked for.

Repo: https://github.com/mukesh-Guntumadugu/AllergyLens

---

## Status (4 Nov 2026)

| Part | State |
|---|---|
| Profile panel (16 toggles in Allergies / Religious-cultural / Diet + 6 mood chips) as a separate step before the menu; chips that contradict the profile are greyed out; custom allergens by voice | Working, on the real camera path; voice only on the glasses |
| Real printed menus recognised by the camera (image markers): Laurel Café & Co and Tatlılar (both from the user's own handheld videos) | Working — marks on the printed lines, confirmed on the handheld Laurel video 4 Nov |
| Three verdicts per dish: safe / contains / unverified, from the data; model-only lists never go green | Working |
| Replacement rule (under 10 % of the dish → "leave it out", over → swap or nearest safe dish) | Working |
| Restaurant badge chip (safe count, stars, allergy reviews) | Working |
| Mood filter ("Veg dishes", "Chicken"…) with "order this" stars and an edge arrow to off-screen matches | Working in the preview |
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
2. **Look at the menu.** The camera recognises the printed Laurel Café menu.
   Within a second the printed lines get marks: thick red underline
   on *Paneer Nan* and *Kheer* (milk), thin green underline on *Alu Gobi*, thin amber underline on
   dishes whose ingredients the restaurant doesn't publish. One badge chip
   sits in the page's top margin: *Laurel Café · 12 of 28 safe*.
3. **Pinch a red line.** A card opens beside it. *Mutter Paneer:* "Paneer is
   about 35% of this dish — leaving it out guts the dish; you'd pay the same
   for less. Ask for a swap: tofu." *Maharani Dal:* "Contains cream (about
   10% of the dish). Ask the chef to leave them out." Pinch again to close.
4. **Mood.** With *Vegetarian* on, only vegetarian lines are marked and the
   safe ones get a green star ("order this"). Lines outside the glasses'
   display band get a small *← Veg dishes* arrow at the edge.
5. **Look away.** The marks fade out; the small Profile button comes back.
6. **(Product segment)** Same profile, pick up a jar of peanut butter: the
   label gets the same red underline + card from the Open Food Facts data.
   *(Not built yet; see Roadmap.)*

---

## Voice first, keyboard when you want it

The profile is a short guided setup, one question per screen, and every step can be
spoken or pinched (rebuilt 7 Nov):

1. **Welcome** — the app mark, "Hi, <your Snapchat display name>", three steps
   announced out loud. Say "start" or pinch Start.
2. **Allergies** — the six common ones as big tiles (peanuts, tree nuts, milk,
   eggs, wheat, shellfish). Everything else is spoken, with no limit: say
   "sesame seeds, olive oil and garlic" and each item becomes a chip (fish,
   soy and sesame are recognised as the known allergens they are). A specific
   food stays your own word: "octopus" is an Octopus chip, not the Shellfish
   tile; only a category's own name ("shellfish", "tree nuts", "dairy") flips
   a tile. A repeated answer counts once ("olive oil olive oil" → olive oil).
   Pinch a chip to remove it. **More…** always follows the last chip; it asks
   "which others?" out loud and opens the typing box with the keyboard, so you
   can say "banana, apple" or type; the field opens empty, Done adds what
   was typed as chips and clears it, so the next More… starts clean. Beyond five
   chips a pager chip ("+N more ›") pinches through the rest, four a page, so
   sixty spoken items stay visible and removable.
3. **Religious / cultural** — no beef, no pork, no alcohol.
4. **Diet** — vegetarian, vegan, low sugar, no trans fat. Vegetarian and vegan
   are one choice (vegan covers vegetarian, milk and eggs inside the checker
   without lighting those tiles). Then **Done**: the panel shrinks and glides
   to the Profile button at the lower left, out of the way of the menu, and
   comes back out of it when reopened.

Every spoken toggle gets its own on/off from the words around it: "a vegan,
not vegetarian" turns vegan on and vegetarian off; "I don't want milk" turns
milk off; "no beef" is the religious tile's own name and turns it on.

No "in the mood for" chips any more: that filter is voice on the menu
("show vegetarian", "chicken", "everything"). The profile is **remembered on
the glasses** (persistent storage), so setup runs once; the Profile button or
"edit profile" reopens it on the allergies screen.

**The Lens speaks.** SPECS has no text-to-speech API in Lens Studio 5.23
(`TextToSpeechModule` is deprecated), so the fixed lines are rendered once on
the Mac (`tools/assets/make_speech.sh`, macOS voice) and bundled as 14 small
MP3s (332 KB): welcome, each step's question, "more", saved, reopened, "didn't
catch that", menu recognised, and the verdict when a dish is pinched
("this dish has something from your profile" / "likely fine, confirm" / "looks
fine" / "ingredients not published"). Say "quiet" to mute and "speak" to
unmute. Anything dynamic (dish names) stays on the card.

**Controls beside the panel:** keyboard, mic (listening on / off) and
speaker (voice on / off); each is both the status and the switch. The
keyboard icon (or More…, or saying "edit") shows a typing field below the
panel, never over it, and a keyboard: on the glasses the SPECS system
keyboard (`TextInputSystem.requestKeyboard`), in the Lens Studio preview the
Lens's own pinch keyboard, styled like the SPECS one (a dark plate under the
field, three letter rows, comma, space, backspace, Done), because the preview
cannot draw the system keyboard. The own keyboard is also the fallback on the
glasses if the system keyboard reports an error. Snap's speech stream ends on
its own after a few minutes; the Lens reconnects with a growing pause and
says "I can hear you now" when it is back. In the Lens Studio preview the
Preview panel's own mic and speaker switches stand in for the glasses'
hardware: a Lens cannot flip them, so when no audio arrives the Lens says
"I can't hear you yet, turn on the microphone in the Preview panel". On the
glasses there is no second switch.

**Sized to the view.** The glasses show about 32° across and every head-locked
size (34 cm panel at 80 cm, 7 cm button, card text) is designed for that.
Lens Studio's preview on phone footage renders about 66° across, which would
shrink the same centimetres to an unreadable stamp, so the head-locked UI
scales by the camera's field of view (×2.3 on such footage, ×1 on the glasses
and in the SPECS 27 room). Marks on the menu stay in page centimetres.

**After Done** the panel glides to a large, see-through account icon in the
lower-right corner of the view (`AllergyLensProfileButtonUI`, 7 cm, Material
"account_circle"); pinch it, or say "edit profile", to come back.

**Commands on the setup screens** (anywhere in a sentence, politeness ignored):
`start`, `next`, `back`, `more`, `edit` / `keyboard`, `done` / `save`, `quiet`,
`speak`, `clear`; a tile name turns it on ("peanuts and milk", "no pork",
"vegan"); "turn off milk" turns it off; "allergies, add mango" / "I'm allergic
to mango" adds a custom item, "remove mango" takes it off; "allergies" /
"diet" jumps to that screen. The
"Heard: …" line under the question shows the transcript and what the Lens did
with it, and the dot before it is green while speech-to-text is listening.

**Speech-to-text:** Snap's ASR module, the engine the glasses use, in the
Lens Studio preview as well since 7 Nov (`previewAsr` input on `AllergyLens`;
off = the older VoiceML engine). The preview's own microphone switch must be
on; the panel's mic icon and the dot before the Heard line show when audio is
actually arriving, and the mic icon toggles listening.

**Icons** are open-source Material Symbols (Apache 2.0), one per screen and
the app mark, fetched by `tools/assets/fetch_icons.sh`; tiles are text only.

## How it works

```
 OFFLINE (once per restaurant, on the ASUS GX10)            ON THE GLASSES (every time you look)
 ─────────────────────────────────────────────────           ──────────────────────────────────────────────
 menu photo ──► gate ──► OCR with boxes ──► Qwen3-VL ──┐     camera ──► MarkerTrackingComponent
                labels each printed line: name, box,   │                  (Assets/Markers/MenuMarker-<id>.imgmarker)
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
| safe | ingredients known, nothing matched | thin green underline (soft green line + star in a mood category) |
| contains | ≥ 1 ingredient matches the profile | thick red underline |
| unverified | restaurant publishes nothing and the dish is not in the knowledge base | thin amber underline. **Unknown never becomes safe.** |
| likely fine | the only ingredient list is the small model's and nothing matched (`ingredientsSource: "model"`) | thin amber underline; card says "Likely fine. A typical recipe has nothing from your profile. Confirm with the restaurant." A model-found allergen is still red, worded *typically contains*. Decided 7 Nov after the accuracy test |

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
| 3 | **Miss path** `GET /lookup?dish=<name>&cuisine=<c>` on the same server: cache first (seed catalog, lake `gold/dishes.json`, `data/lookup-cache.json`) answers in milliseconds; a miss is queued for web retrieval (`ingredients_rag.py`: recipe pages with schema.org markup, citations kept, no model invents a recipe) and answers `"researching"`; the Lens asks again at 8 s and 16 s, the second visitor hits the cache. The Lens asks for up to 12 unknown dishes when a page is recognised, 4 s timeout, amber meanwhile | one small GET per unknown dish, research once per dish ever | built 6 Nov ([#5](https://github.com/mukesh-Guntumadugu/AllergyLens/issues/5)) |
| 4 | **Small model on the server** (`--llm`): a miss is answered by a small model (deployed: gpt-4.1-nano through **OpenRouter**, one key with a hard spend cap set on openrouter.ai; Claude Haiku 5.5 or OpenAI direct also wired) as a fixed JSON list of *typical* ingredients plus a diet class, cached forever per dish, capped at 300 calls/hour. The key sits in `/etc/allergylens.env` on the server, never in the Lens. The call usually answers inside the Lens's first ask (the server waits up to 3 s), otherwise "researching" and the Lens asks again | ~600 input + 150 output tokens per new dish: about $0.0002 with Haiku, so a $20 budget covers ~100,000 dishes | built 6 Nov; the deployed default since web scraping stopped |
| 5 | Menu with no marker: one down-scaled camera frame through the Remote Service Gateway to a vision model with the *same* line schema; the result is uploaded as a capture so the next visitor gets the cached answer (DESIGN.md §7.4) | one image call per *page*, never per frame | designed |

Guardrails that stay the same at every tier: results from retrieval or a model
are stored with `source.type: "web-retrieval"` / `"llm"` and worded as
*typical*; the amber "ask the restaurant" state is the default whenever a tier
times out (4 s) or disagrees. The live match rule is stricter than the build:
a catalog key must cover at least half of the dish name, so "chicken tikka
masala" is researched rather than answered by the entry "chicken".

**How accurate is the model path.** Tested on 150 dishes with trusted
ingredients (printed on the menu or cited recipes): the model catches 83 %
of the real "contains" cases and agrees with the trusted verdict 90 % of the
time; the misses are restaurant-specific extras no generic recipe can know,
which is why printed ingredients always win in the join. Full tables and
method in [docs/model-accuracy-2026-11-07.md](docs/model-accuracy-2026-11-07.md).
Re-run any time: `tools/server/eval_llm.py` on the server, `node tools/eval_llm.js` here.

**Pre-filled, not on demand.** `tools/server/prefill.py` ran every served
dish with no ingredients through the model once on 7 Nov: 4,727 distinct
names in 109 minutes, 2.6 M tokens, about 32 cents. 2,567 came back as
dishes with ingredients; 2,156 the model called not a dish (beer lists,
"choose two sides", price lines) and stay amber by design. The served file
(3.3 MB, one GET at start) now carries ingredients for 4,606 of 8,251 dishes:
289 printed by the restaurant, 1,188 from cited recipes, 3,129 from the
model. The on-demand path remains for dishes outside the data.

**What runs where.** The glasses do tracking, hands, speech-to-text, the
checker and the drawing, all offline; every heavy step (OCR, vision models,
web retrieval, catalogs) runs on a server and comes back as small JSON. The
device limits, the server split and the storage layout are written up in
[issue #2](https://github.com/mukesh-Guntumadugu/AllergyLens/issues/2).

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

Current contents: 3 restaurants (Laurel Café and Tatlılar are the real ones: printed menus,
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
| **Lens Studio Preview → Multimedia** with `data/menus/laurel-cafe/menu-1-pan.mp4` (or the webcam and a printout), device **SPECS 27** | Lens Studio 5.23.2 | real recognition path: marker lock, marks on the printed lines, badge |
| **Interactive Preview** with `debugSimulateMarker` on | Lens Studio only | profile → marks → pinch → card logic, with the menu image drawn on a simulated page 60 cm ahead |

The step-by-step manual guide is [TESTING.md](TESTING.md).

**Test the decisions without the glasses.** `tools/check.js` runs the same
compiled checker the Lens runs, on the same data, and prints every dish's
verdict, category, source and card text for a profile:

```bash
node tools/check.js --list                                   # profile ids, restaurants, products
node tools/check.js --profile milk,peanut                    # everything, bundled data
node tools/check.js --profile meat --restaurant laurel-cafe  # veg / non-veg for one menu
node tools/check.js --profile milk --url http://<gx10-ip>:8787/menus.json   # through the live server + the Lens validator
node tools/check.js --dish "chicken tikka masala" --cuisine indian --profile milk --url https://<server>/menus.json
#   the miss path: the same /lookup call the Lens makes, polled while "researching", then the checker on the answer
```

A local run of the miss path, with no GX10 (`python3 -m venv .venv && .venv/bin/pip install -r tools/server/requirements.txt`):

```bash
ANTHROPIC_API_KEY=… .venv/bin/python tools/serve_data.py --port 8787 --llm   # /lookup asks the small model on a miss
.venv/bin/python tools/serve_data.py --port 8787 --research                   # or: web retrieval (the pre-6-Nov path)
node tools/check.js --dish "chicken tikka masala" --cuisine indian --profile milk --url http://127.0.0.1:8787/menus.json
#   -> researching … 8 s … typical, 16 ingredients from 6 cited recipes, RED for milk (cream); second ask: 37 ms from cache
```

Automated: 9 LEAF scenarios (`Assets/LeafTests/`) run inside the live Lens:
profile panel and Done, peanut+milk marks and badge on the Laurel Café
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
Assets/Markers/             MenuMarker-<id>.imgmarker + page png per printed menu (Laurel Café, Tatlılar) and the product label
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
   `data/menus/laurel-cafe/menu-1-pan.mp4`; device **SPECS 27**.
3. Refresh. The marker locks within a second or two; refresh again if not.

   **Recording your own background video** (what the demo is cut from):
   print `docs/print/laurel-cafe-menu-A4.pdf` at 100 % (no "fit to page"),
   lay it flat or prop it up in good even light, no glare and nothing over
   it. Film **landscape** (phone sideways; portrait squeezes the view and
   makes the panel tiny), 1080p or 720p, 30 fps, about 30 s, H.264 .mp4:
   the whole page in frame and still for the first 3 s at 40–60 cm, then
   slow drifts left / right, a slight tilt, come closer so only part of the
   page is in view, back out, still again at the end. Drop the file in
   `data/menus/laurel-cafe/` and open it the same way.

   **Profile first, then the page.** While the profile panel is open the
   Lens does not react to menus or products in view: no marks, no voice
   line, the panel stays until Done. The moment Done is pinched, whatever
   page is in view is picked up as if it had just been found, so the demo
   flows from "set up your profile" straight into the marks on the live
   video without a cut. In Lens Studio the "live video" is whatever the
   Preview panel's source is set to; the Lens cannot switch the room to a
   video, so set the source to the recording before you start.

   **The Profile icon moves.** Pinch it and drag: it follows the hand and
   keeps the new spot in the view (clamped to the glasses' field of view);
   a plain pinch without moving opens the profile.

   **What gets a mark (rule of 2026-11-08).** Only dishes that are safe for
   the profile get a line: a pen-thin light green underline under the printed
   name. Dishes that contain something, or that are unverified, draw nothing
   but stay pinchable, so a pinch still opens the card that says why. Never
   more than ten lines at once: the ten nearest the centre of the view,
   re-chosen every half second. No lines while the page moves or turns; they
   fade back about a third of a second after it holds still, because the
   tracker's pose lags on a moving page and lines drawn then land beside the
   text. The chip keeps the count ("8 of 28 safe").

   **Use the recording as it is.** The whole phone video, full frame, with
   its sound, is the preview source: `data/menus/menus-2026-11-07.mp4`
   (Chinese Menu, Kitchen Section, Laurel Café, 53 s) and
   `data/products/groceries-2026-11-07.mp4` (56 s). Never crop, pad or
   shrink it. A marker made from the printed page in that footage locks
   within a second even when the page fills the frame; the design file as a
   marker did not, which is what first made it look as if distance was the
   problem. Open the project with **Lens Studio 5.23.2**, not 5.24.1, which
   migrates the project files on open and reports a wrong camera field of
   view in the SPECS 27 room.

   **Adding a menu from a recording** (how `chinese-menu` and
   `kitchen-section` were added on 2026-11-08 from the same phone clip):

   ```bash
   .venv/bin/python tools/scrape/page_from_video.py clip.mp4 --out data/menus/<id>/menu-1.png --width 1400
   .venv/bin/python tools/scrape/ocr_menu.py data/menus/<id>/menu-1.png --restaurant-id <id> --restaurant-name "<Name>" --out data/menus/<id>/menu-1.ocr.json --marker-width-cm 21.59
   ```

   The flattened page is the tracking marker and the OCR input. A marker
   made from the real print tracks the print far better than the design
   file does: the Laurel Café marker is now `menu-2-print.png`, flattened
   from the user's clip, with the dish positions from the design OCR mapped
   onto it by the printed area's bounding box (1.6 % narrower). Resize it
   to the paper's real proportions before using it (Letter: 1400×1812,
   marker height 27.94 cm) or the marks drift down the page, because the
   tracker assumes square pixels. Merge the entry into `data/menus.json`
   (fix the OCR names, add ingredients), copy the page to
   `Assets/Markers/<id>-menu-1.png` with a `MenuMarker-<id>.imgmarker`,
   list it in `MENU_MARKERS` in AllergyLensMenuOverlayUI.ts, run
   `node tools/build-data.js`. Products work the same way from a label
   photo: `data/products/<id>/label-1.png` + `PRODUCT_MARKERS` + an entry in
   `data/products.json` (any readable id works as the barcode).
   The Lens Studio build matters too: open the project with
   **Lens Studio 5.23.2**, not the newer 5.24.1, which migrates the project
   files on open and reports a wrong camera field of view in the SPECS 27
   room.
4. Hands-free profile for recording: select `AllergyLens`, set
   `defaultProfile` to `peanut,milk` and `defaultMood` to `everything` or
   `vegetarian`, refresh.
5. Click a marked line (click = pinch) for the card.

### Live data from the GX10

```bash
python3 tools/serve_data.py --port 8787 --with-lake --research   # on the GX10; /menus.json, /products.json, /lookup, /health
```

Then select `AllergyLens` in Lens Studio and set `menusUrl` to
`http://<gx10-ip>:8787/menus.json`. The Lens fetches it once at start,
validates the shape, re-checks any menu in view, and keeps the bundled data
if the server is unreachable.

As deployed on 5 Nov: the GX10 (`mukesh@gx10-733b.local`, 10.233.204.96 on
the lab network) runs `allergylens-data` as a systemd service from a clone of
`main` in `~/allergylens-serve` (port 8787; `systemctl status allergylens-data`,
`journalctl -u allergylens-data -f`). On every (re)start it rebuilds the data
with the scraper's lake (`data-lake` → `~/AllergyLens/data-lake`) and serves
the result. To pick up new scraper output:

```bash
bash tools/server/sync_lake.sh        # from the Mac: pulls the lake, restarts the service, checks it
```

That serves 193 restaurants (the 6 seed ones plus 187 scraped Ohio menus),
8,251 dishes, and `node tools/check.js --url …/menus.json` passes the Lens
validator. Where those numbers come from (the lake on 7 Nov): 20,212
restaurants discovered, 82,606 files fetched, 26,233 images judged of which
3,164 are menus, 449 of those extracted into 21,600 dish lines (194 restaurants,
8,168 cleaned dishes in `gold/menus/`), merged into the Lens file by
`tools/scrape/merge_gold.py`. 2,715 gated menu images are still unextracted
(a GPU pass on the GX10, no web access needed). The 197 entries in
`data/dishes.json` are recipe *types*, not menu lines. Once `node` is installed on the GX10,
`bash tools/server/install.sh` there turns it into a systemd service that
builds and serves on its own.

**Which miss path runs.** `--llm` wins over `--research`; the deployed services run `--llm`, and a server
with no key in `/etc/allergylens.env` answers every miss "unknown" (amber) and says so in its log. To turn
the model on: put `OPENROUTER_API_KEY=…` (or `ANTHROPIC_API_KEY=…` / `OPENAI_API_KEY=…`) in that file as root and
`systemctl restart allergylens-api` (VPS) / `allergylens-data` (GX10). `/health` then reports the provider,
model, call count and tokens used.

**Plain `http://` is refused by the Lens** ("URL is not secure") unless the
project's Experimental API switch is on, so the GX10 also runs a second
service, `allergylens-tunnel`: a Cloudflare quick tunnel (no account) that
gives the data server a public `https://…trycloudflare.com` address with a
valid certificate, reachable from the glasses on any network. `menusUrl` in
the saved scene points at it, and the Lens logs "loaded 28 restaurants from
https://…" about 0.3 s after start. The hostname changes whenever the tunnel
restarts (GX10 reboot): read the current one with

```bash
bash tools/server/tunnel_url.sh       # prints https://<words>.trycloudflare.com
```

and put `<that>/menus.json` into `menusUrl`. The Lens derives the lookup
address from it (`…/lookup`). If the fetch fails the Lens retries four times,
2 s apart, then logs "remote menus unavailable … using bundled data" and runs
on the compiled snapshot, by design.

### Public copy on a VPS (Hostinger) — the address the Lens uses

As deployed on 6 Nov: `https://srv1619809.hstgr.cloud` (Hostinger KVM 8,
AlmaLinux 10, the same box that serves the user's other sites) runs
`allergylens-api` behind the existing nginx with a Let's Encrypt certificate.
`menusUrl` points there; it does not change on reboot. Verified from the Mac:
**193 restaurants, 8,251 dishes** pass the Lens validator (3.3 MB, one GET at start, 1.6 s); a cached dish answers `/lookup` in
under a second; "Paneer Butter Masala" went researching → typical (16
ingredients, cited) in 10 s and is now cached for everyone. The GX10 keeps
the GPU jobs and the lake and pushes its catalog over:

```bash
bash tools/server/sync_vps.sh        # from the Mac: GX10 gold/ → VPS, git pull there, restart, health
```

To set it up on another box (Ubuntu or AlmaLinux; nginx + certbot if nginx already runs there, Caddy otherwise):

```bash
git clone https://github.com/mukesh-Guntumadugu/AllergyLens.git ~/allergylens && cd ~/allergylens
bash tools/server/install_vps.sh --domain api.<your-domain>     # node, venv, systemd allergylens-api, Caddy with https
rsync -a mukesh@<gx10>:~/AllergyLens/data-lake/gold/ ~/allergylens/data-lake/gold/ && sudo systemctl restart allergylens-api
```

Then `menusUrl` = `https://api.<your-domain>/menus.json`, and
`node tools/check.js --dish "…" --url https://api.<your-domain>/menus.json`
from anywhere. Researched dishes land in `data/lookup-cache.json` on the box
(ignored by git); copy it back into the lake's catalog when it is worth keeping.
The GX10 tunnel (`tools/server/tunnel_url.sh`) stays as the fallback address.

## Roadmap

- Real product label photos (one per product) to replace the placeholder marker;
  more products through `tools/scrape/fetch_products.py --barcode`.
- Tier 4 LLM fallback through the Remote Service Gateway for dishes the web
  has no recipe for; tier 5 reading of an unmarked page from one camera frame.
- Voice on the menu step and spoken feedback
  ([#4](https://github.com/mukesh-Guntumadugu/AllergyLens/issues/4)); mark hold
  on shaky pages ([#3](https://github.com/mukesh-Guntumadugu/AllergyLens/issues/3)).
- More restaurants through Pipeline 1 (one photo + 10 minutes on the GX10 each).
- Regional roll-ups over `data/` (most common allergens per cuisine).

## Data attribution

Product data from [Open Food Facts](https://openfoodfacts.org) (ODbL).
Restaurant data from the restaurants' own printed menus and the Google Places
API. Dish knowledge base from recipe references, each entry carries its
source and collection date.

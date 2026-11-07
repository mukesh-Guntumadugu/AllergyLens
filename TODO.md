# AllergyLens — open work checklist (written 2026-11-06)

Tick as done. Everything above the first unticked box is verified, not assumed.

## 1. Scraper data → Lens (live connection)

What exists today, end to end:

    GX10  ~/AllergyLens/data-lake/gold/lens/menus.json   (scraper output, 28 restaurants)
      → ~/allergylens-serve: node tools/build-data.js --with-lake → data/menus.lens.json
      → tools/serve_data.py  (systemd allergylens-data, port 8787)
      → cloudflared https tunnel (systemd allergylens-tunnel)
      → Lens: AllergyLens.menusUrl = https://<tunnel>/menus.json, one GET at start
      → on any failure the Lens keeps the bundled data (4 restaurants) and says so in the log

- [x] Lake joined into the served file (28 restaurants served, 2026-11-05)
- [x] https tunnel; Lens logged "loaded 28 restaurants from https://visits-fame-wonderful-science.trycloudflare.com/menus.json" (2026-11-05 11:15)
- [x] Retry added: the Lens now tries 4 times, 2 s apart, before falling back (2026-11-06; the first start after opening the project failed with "HTTP 3" because the network was not ready)
- [ ] **GX10 is OFF or off the network right now** (2026-11-06 15:55: LAN ping fails, tunnel answers nothing). Until it is back the Lens runs on bundled data. To restore:
      1. power on / plug in the GX10, wait ~1 min (both services start on boot)
      2. on the Mac: `bash tools/server/tunnel_url.sh` → new https address
      3. paste `<address>/menus.json` into `menusUrl` on the AllergyLens object, save the scene
      4. preview once; the log must say "loaded N restaurants from …"
- [ ] Stable hostname (optional, 15 min): a named Cloudflare tunnel so step 2–3 never repeat. Needs a Cloudflare account and a domain.
- [ ] Demo-day safety: keep the GX10 on mains + Ethernet in the lab, or carry it. If it cannot be online, the bundled data still covers the three printed menus.

## 2. Three new menus (per menu, ~30–45 min each)

A scraped restaurant without a printed page is served (tier 1) but only shows marks when a
marker exists for its page, so each new menu needs steps 1–4.

- [ ] Record a slow handheld video of the printed menu (Letter size, whole page in frame, no glare), as for Laurel Café
- [ ] `python3 tools/scrape/page_from_video.py <video> --out data/menus/<id>/menu-1.png` (use `--frame N --corners …` if auto-detect fails)
- [ ] OCR lines → `data/menus.json` entry: `id`, `name`, `dishes[]` with `line` boxes; ingredients from `data/dishes.json` (add missing dishes with shares + substitutes)
- [ ] Marker: `Assets/Markers/MenuMarker-<id>.imgmarker` + png (MarkerHeight 27.94 cm) and an entry in `MENU_MARKERS` (`AllergyLensMenuOverlayUI.ts`)
- [ ] `node tools/build-data.js` → `node tools/check.js --profile peanut,milk --restaurant <id>` → preview on the video
- [ ] If the restaurant is also in the lake: `bash tools/server/sync_lake.sh` so the GX10 serves the merged entry

## 3. Groceries

- [ ] Real label photo/video of the Jif jar → replace `Assets/Markers/product-0051500255162.png` (placeholder today)
- [ ] One or two more products the same way (`PRODUCT_MARKERS` in `AllergyLensProductOverlayUI.ts`, `data/products.json`)
- [ ] Open Food Facts by barcode (tier 2): pipeline exists, Lens call not wired

## 4. Miss path: cache first, web on a miss, cache the answer (decided 2026-11-06, maybe built today)

Today the Lens answers only from the data it fetched at start; a dish it does not know stays
amber for everyone. Agreed flow:

    dish name → GX10 lookup endpoint
      hit  in data-lake/gold  → answer in < 1 s
      miss                    → ingredients_rag.py (web retrieval with citations) → stored in gold → answer
    Lens: on a miss call the endpoint with a 4 s timeout; amber "ask the restaurant" meanwhile;
          second visitor gets the cached answer instantly

- [x] `GET /lookup?dish=<name>&cuisine=<c>` in `tools/serve_data.py` (cache first, then the retrieval step, result in `data/lookup-cache.json`) — built and tested locally 2026-11-06; GitHub [#5](https://github.com/mukesh-Guntumadugu/AllergyLens/issues/5)
- [x] Lens call on miss (`AllergyLensMain.ts`), timeout 4 s, verdict stays amber until the answer arrives, result merged into the session data (compile clean; preview run still to do)
- [x] `node tools/check.js --dish "<name>" --cuisine <c> --profile <ids> --url …` from the command line
- [ ] Deploy: GX10 (`cd ~/allergylens-serve && git pull && bash tools/server/install.sh`) once it is on; Hostinger VPS (`bash tools/server/install_vps.sh --domain …`) once the SSH details and a DNS name are given
- [ ] GitHub issues to work from: [#2 architecture](https://github.com/mukesh-Guntumadugu/AllergyLens/issues/2), [#3 glanceable UI](https://github.com/mukesh-Guntumadugu/AllergyLens/issues/3), [#4 voice + pinch](https://github.com/mukesh-Guntumadugu/AllergyLens/issues/4)
- [ ] Unknown page (no marker): one 512-px frame through the Remote Service Gateway to read the dish names first, then the lookup above. Needs a Snap gateway token. Second day.

Not from images: a photo of food never turns a dish green (chicken-shaped cake). Images are for
reading text only.

## 5. Beyond name matching (see the discussion in chat, 2026-11-06)

- [ ] Ingredient-list reading: one camera frame → OCR → the same checker. Removes the need for a product marker per item. Route: Remote Service Gateway (Gemini/OpenAI vision) with a fixed JSON schema, one call per package, cached by barcode.
- [ ] Unmarked menu page: same route, one 512-px frame per page, result cached as a marker-less entry (README tier 5).
- [ ] Dish-photo recognition (what is on the plate): possible for the dish *class* only; hidden ingredients (peanut oil, shrimp paste, gelatin) are not visible, so the verdict can never go green from a photo. Keep amber + "ask the restaurant".

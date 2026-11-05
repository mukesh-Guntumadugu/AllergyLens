# How to test AllergyLens in Lens Studio

The Lens draws on a **real menu the camera sees**. So the preview needs a
camera feed that contains the menu. The 3D room ("Interactive Preview") has
no camera and no menu — nothing can be recognized there.

## 1. Feed the menu into the preview (this is the real test)

1. Open `AllergyLens.esproj` in Lens Studio 5.23.2.
2. In the **Preview** panel, click the source dropdown at the top of the panel
   (it says *Interactive Preview*, *Webcam* or a file name) and choose
   **Multimedia → Open file…**, then pick one of:
   - `data/menus/star-of-india/menu-1-pan.mp4` — a slow pan over the real menu
     (best; recognition locks faster on video)
   - `data/menus/laurel-cafe/menu-1-pan.mp4` — the handheld Laurel Café & Co
     menu (28 lines: breakfast, coffee, lunch, drinks, sweets, salads)
   - `data/menus/tatlilar/menu-1-pan.mp4` — the handheld Turkish dessert menu
     (6 items; the marks sit on the price lines because the names are script)
   - `data/menus/star-of-india/menu-1.png` — the still photo
   - **Webcam** — hold a printout of `menu-1.png` (A4/Letter, flat, well lit,
     no glare) in front of the laptop camera
3. Make sure the device at the bottom of the Preview panel says **SPECS 27**.
4. Press the Preview's refresh button. Within a second or two the marker locks
   and the marks appear on the printed lines. If nothing appears after ~5 s,
   refresh again — marker lock after a reset is intermittent (about every
   other try).

What you should see on the page: a thin red underline + red dot on dishes
that conflict with the profile, a small green dot on safe dishes, an amber dot
on dishes with no ingredient data, and one small badge chip above the page
("Star of India · 14 of 31 safe · ★4.5 · 1 allergy review"). Nothing else on
the menu.

The glasses only draw in the middle band of what the camera sees (SPECS'
display field of view, simulated in SPECS 27 mode). Marks on the far left or
right column show when the camera pans to that column.

## 2. Set a profile

- **Hands-free (recommended for recording):** select the `AllergyLens` object
  in the Scene Hierarchy, and in the Inspector set `defaultProfile` to e.g.
  `milk` or `peanut,milk` and `defaultMood` to `everything` or `vegetarian`.
  Refresh. No panel appears; the menu is checked against that profile.
- **With the panel:** leave `defaultProfile` empty; the profile panel shows at
  start. In Multimedia preview, mouse clicks may not count as pinches — if
  Done doesn't react, use the hands-free setting above.

Valid profile ids: `peanut tree_nut milk egg wheat soy fish shellfish sesame
beef pork alcohol meat vegan trans_fat high_sugar` (`meat` = vegetarian; `vegan`
also turns on `meat`, `milk` and `egg`). Any other word, e.g. `mango`, is added
as a custom allergen, exactly as if you had said "I'm allergic to mango".
Mood chips that contradict the profile are greyed out (vegetarian → no
Chicken / Red meat / Seafood; no beef + no pork → no Red meat; fish +
shellfish → no Seafood).
Valid moods: `everything chicken red_meat seafood vegetarian dessert`.

## 3. Pick a dish

- **Pinch:** click a marked line (Interactive/Webcam preview: click = pinch).
  A detail card opens beside it: "Contains cashews (about 6% of the dish). Ask
  the chef to leave them out." / "Paneer is about 40% of this dish — leaving it
  out guts the dish; you'd pay the same for less. Ask for a swap: tofu." /
  "Better pick: Alu Gobi". Click again to close.
- **Voice:** turn on the microphone button in the Preview panel and say the
  dish name ("mixed naan"). If the preview mic gives no transcript, pinch is
  the fallback; voice is meant for the glasses. With the profile panel open
  you can drive the whole panel by voice: a toggle's name switches it on
  ("peanuts", "dairy", "no pork", "vegetarian", "high sugar"), "turn off milk"
  switches it off, a mood name picks the chip ("chicken", "in the mood for
  seafood", "everything"; a chip the profile forbids is refused), "done"
  closes the panel, and "I'm allergic to mango" / "no coriander" / "I can't
  eat okra" adds a food that is not on the panel ("Also avoiding: Mango").
  Every command prints what it understood to the Logger. **Do not tick
  `voiceInPreview`**: starting speech recognition inside the Lens Studio
  5.23.2 preview crashes Lens Studio (reproduced twice, 1 Nov and 4 Nov; the
  app dies within seconds, no Lens error is logged). Voice is tested on the
  glasses only, where the ASR module runs normally. The saved scene keeps the
  switch off.

## 3b. Check the logic on the command line

```bash
node tools/check.js --profile milk --restaurant laurel-cafe
```

prints, for every line on that menu: GREEN / RED / AMBER, the category
(vegetarian, chicken, red_meat, seafood, dessert, drink), where the ingredients
came from (`menu says` = printed on the menu, `typical` = dish knowledge base,
`unknown` = amber), and the exact card text. `--url http://<gx10-ip>:8787/menus.json`
runs the same through the live server. It uses the Lens's own compiled code
from `Cache/TypeScript/Out`, so open the project in Lens Studio once first.

## 4. The 3D room is NOT a menu test

The Interactive Preview room has no camera feed, so the real marker can never
lock there. (The two framed posters in the "Sunlit Room" are part of the room
itself — their black dots and dashes are not AllergyLens marks; ours are
red, green and amber.)

Two debug switches put a **simulated** page 60 cm in front of you instead.
Since this build the simulated page draws the Star of India menu image
(`Assets/Markers/menu-1.png`, 29.7 × 18.2 cm) under the marks, so you can see
that the marks sit on the right printed lines even without a camera. The
image is only ever drawn on a simulated page; when the camera tracker owns
the pose nothing is drawn over the real menu except the marks and the badge.

- **`AllergyLens` → `debugSimulateMarker`**: on start, after 0.5 s the Lens
  pretends the menu was recognised 60 cm ahead. Good for checking the
  profile → marks → pinch → detail flow in the Interactive Preview. Turn it
  off for the real (camera) test; it refuses to run while the camera is
  actually tracking the marker anyway.
- **`LeafRunner` → `autoRun`**: the automated LEAF scenarios run one after
  another, opening the panel, flipping toggles and simulating the page. Keep
  it off unless you want the test run; the result is printed to the Logger
  panel as `[LEAF SUMMARY] n/9 passed`.

Both are saved **off** in the committed scene.

## 4b. Adding a menu from a video

```bash
python3 tools/scrape/page_from_video.py data/menus/<id>/menu-1-pan.mp4 --out data/menus/<id>/menu-1.png \
    [--frame N --corners "x,y x,y x,y x,y"] [--aspect 0.7727]     # Letter = 0.7727, A4 = 0.7071
```

Then OCR the page for line boxes, add the restaurant to `data/menus.json`
(ingredients as printed, or `null` to fall back to the dish knowledge base),
copy the page to `Assets/Markers/<id>-menu-1.png`, add an `.imgmarker` with
the real page height in cm, one line in `MENU_MARKERS`
(`Assets/Scripts/AllergyLensMenuOverlayUI.ts`), and `node tools/build-data.js`.
The Lens creates the tracker for every bundled page at start; nothing in the
scene changes.

## 5. Grocery products

Same profile, same rules, on a packaged product. The camera recognises the
product's front label (an image marker, like the menu); the label gets a thin
outline in the verdict colour and one chip above it, e.g. *Jif Creamy Peanut
Butter · contains peanuts*. Pinch the label for the card ("Contains peanuts —
declared on the label. Put it back; pick one without it."). The label's own
allergen statement wins; the ingredient list is read with the same aliases as
dishes; "may contain" makes it amber; trans fat and high sugar come from the
nutrition numbers, not from the word "sugar" in the list.

Until a photo of the real jar arrives, the bundled marker
`Assets/Markers/product-0051500255162.png` is a placeholder image, so the
camera path cannot lock on a real Jif jar yet. To add or replace a product:
flat straight-on label photo → `Assets/Markers/product-<barcode>.png` (and the
`.imgmarker` next to it, height = real label height in cm) → one line in
`PRODUCT_MARKERS` in `Assets/Scripts/AllergyLensProductOverlayUI.ts` → the data
via `python3 tools/scrape/fetch_products.py --barcode <code>` and
`node tools/build-data.js`.

`AllergyLens → debugSimulateLabel` simulates the first product label 50 cm
ahead (label image drawn, Interactive Preview only). Saved off.

## 6. Recording the demo

Use the Multimedia (video) source with a hands-free profile, SPECS 27 device,
and record the Preview panel. Show: profile → menu recognized → marks on the
lines → pinch a red line → the advice card. Under 3 minutes.

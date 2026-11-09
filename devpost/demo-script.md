# AllergyLens — 3-minute demo script

Target: under 3:00. One take per segment, cut together. Record the Lens
Studio Preview panel (SPECS 27, Multimedia video source) at 1280 wide; add
voice-over after. No slides, the menu is the slide.

## Before you record

- Lens Studio 5.23.2, project open, Preview → **Multimedia** →
  `data/menus/laurel-cafe/menu-1-pan.mp4` (your own handheld recording; the
  the Tatlılar video is the alternate), device **SPECS 27**.
- `AllergyLens` object: `defaultProfile` = `peanut,milk`, `defaultMood` =
  `everything`, `showProfileAtStart` = true (segment 1 shows the panel; for
  segments 2–4 the profile is already set).
- `LeafRunner.autoRun` off, `debugSimulateMarker` off (they are saved off).
- Logger panel closed; preview full width. Screen-record the Preview panel
  only (QuickTime or OBS, 30 fps).
- If the marker doesn't lock within 5 s after refresh, refresh again.

## Shot list — 3:00, half demo, half how it was built

Record the Lens Studio Preview (5.23.2, SPECS 27, Mac camera, Back view) at
30 fps. Voice-over after. The mouse is the finger in the preview. Speak at
an easy pace: each line below is timed to fit its shot.

### Part 1 — the demo (0:00–1:30)

| t | on screen | voice-over |
|---|---|---|
| 0:00–0:10 | Black. Then the live camera: a printed menu lying on the table. | "One in ten adults in the US has a food allergy. Many more don't eat beef, or pork, or meat at all. In a shop you can scan the packet. In a restaurant, you ask the waiter, dish by dish, and hope." |
| 0:10–0:30 | **Profile.** The panel on its grey backdrop. The Lens says "Welcome to AllergyLens." Pinch Start, pinch *Peanuts*, *Tree nuts*, *Next*, *No pork*, *Next*, *Vegetarian*, *Done*. | "AllergyLens is a Lens for SPECS. You set your profile once: allergies, religious rules, diet. Pinch it, or turn on the mic and say it. Then you just look at the menu." |
| 0:30–0:42 | **The reveal.** Done fades the backdrop; the page is already in hand; the chip *Our Kitchen Section · 3 of 24 safe* appears. Nothing else is drawn. | "The camera recognises the printed page and checks every dish against your profile at once. It draws nothing yet. A page covered in marks is noise." |
| 0:42–1:05 | **Point to check.** Rest on *Korean Chicken*: red line, chip *Contains chicken (not vegetarian), wheat (wheat flour, gochujang).* Move to *French Fries*: red fades, bare green line. Move to a dish without an ingredient list: grey, *No ingredient list. Ask the restaurant.* | "Point at a dish and it answers, one at a time, only when your finger rests. Red says exactly what it contains and why that matters to you. Green is clear, nothing to read. Grey means it might, and tells you what to ask." |
| 1:05–1:18 | **Pinch for the card.** Pinch *Korean Chicken*: the card with what to leave out and the closest safe dish. Close. | "Pinch, and you get the decision, not a list: leave it out if it's a garnish, swap if it's the dish, or the nearest safe dish on this menu." |
| 1:18–1:30 | **Product.** Hold the gummi bag's label to the camera: outline, *may contain milk, wheat, soy*. | "Same profile in the grocery store. The label is the marker, the ingredient list is the verdict. Twenty minutes of deciding becomes one." |

### Part 2 — how it was built (1:30–3:00)

| t | on screen | voice-over |
|---|---|---|
| 1:30–1:45 | `devpost/design-brief.md` scrolling: "The one spatial moment". Then this script. | "We planned it with the Learn SPECS skill pack. Its interview wrote the design brief: one spatial moment, the answer painted on the menu you are reading. That sentence survived every change." |
| 1:45–2:05 | Lens Studio with the agent chat: a script edit, *RecompileTypeScript succeeded*, the Preview refreshing. Then the LEAF panel running `allergylens-1-profile-done` → passed. | "Everything was built by an AI agent through CLAD in Lens Studio, over the Lens Studio MCP: the TypeScript, the scene, the image markers, and eleven LEAF scenarios that drive the Lens in the preview and check what it draws." |
| 2:05–2:25 | The README architecture diagram. Then a terminal: `page_from_video.py` flattening a phone clip into a page, `ocr_menu.py` printing dish lines with positions. | "A menu is read once, not per look. A phone clip of the page becomes the tracking marker. OCR gives every dish with its position. A knowledge base of allergens and typical recipes fills the ingredients. Spectacles Interaction Kit handles pinch and hover, UI Kit the panels." |
| 2:25–2:45 | Browser: `https://srv1619809.hstgr.cloud/menus.json` loading; then `/lookup?dish=paneer%20butter%20masala` returning *typical* ingredients. | "A small server serves the catalogue, 193 restaurants, and answers dishes nobody has seen: cache first, then cited web recipes, then a small model, each answer cached for everyone. The key stays on the server. A model answer is never shown as a fact; it is grey, and it says to ask." |
| 2:45–3:00 | Back to the live camera, one last point at a dish, the chip. Title card: *AllergyLens · built with CLAD in Lens Studio · github.com/mukesh-Guntumadugu/AllergyLens*. | "What we learned: draw less, say less, and judge it on real footage, not in the test room. AllergyLens. Point at a dish. Know what to order." |

## Lines to keep if time is short

1. The marks are on the real printed menu, not a rebuilt one.
2. Unknown is never green. Everything you saw was recognised from a handheld video, not a rebuilt menu.
3. Under 10 % → leave it out; over 10 % → swap or a better pick, because you'd pay the same for less.
4. It runs offline; models run once per restaurant, not once per look.

## Judging checklist (Learn AR with SPECS)

- Spatial moment is obvious in the first 45 s (marks appear on the page).
- Why glasses, not a phone: hands stay on the menu, answer painted where you look.
- Built with Lens Studio + SIK + UI Kit, tested with LEAF (9/9), real marker tracking.
- Honest scope: product segment and LLM fallback are shown as next steps unless built before recording.

## Recording the product video (when you send it)

Shoot the product the same way as the menu: flat label, straight on, bright,
no glare, 10–20 s slow pan, 1080p. It becomes `data/products/<barcode>/label-1.png`
(marker) + `label-1-pan.mp4` (preview source), and the barcode goes through
`tools/scrape/fetch_products.py --barcode <code>`.

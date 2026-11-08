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

## Shot list (as the Lens works on 2026-11-08)

Source: the Preview panel on the **Mac camera** (live) or on the joined
phone recording `data/demo-2026-11-07.mp4`. Lens Studio 5.23.2, device
SPECS 27. In the preview the pointer is the mouse; on the glasses it is the
finger.

| t | on screen | voice-over |
|---|---|---|
| 0:00–0:10 | Black → the live camera, a printed menu on the table. | "One in ten adults has a food allergy. Every menu is a reading test with the wrong answer in the hospital. AllergyLens reads the menu with you." |
| 0:10–0:40 | **Profile on a grey backdrop.** The Lens says its one line, "Welcome to Allergy Specs." Pinch Start, pinch *Peanuts*, *Tree nuts*, *Next*, *No pork*, *Next*, *Vegetarian*, *Done*. (Or pinch the mic button on the right and say them.) | "You set your profile once: allergies, religious rules, diet. Say it or pinch it. Then you just look at the menu like everyone else." |
| 0:40–0:55 | **The reveal.** Done fades the backdrop out; the page in your hand is recognised and the chip reads *Our Kitchen Section · 3 of 24 safe*. Nothing else is drawn. | "The camera recognises the printed page and checks every dish against your profile at once. It draws nothing yet, because a page covered in marks is noise." |
| 0:55–1:35 | **Point to check.** Rest the pointer on *Korean Chicken*: a red line fades in under the name with the chip *Contains chicken (not vegetarian), wheat (wheat flour, gochujang).* Move to *French Fries*: the red goes out, a bare green line. Move to a dish with no ingredient list: grey, *No ingredient list. Ask the restaurant.* | "Point at a dish and it answers. Red says exactly what it has and why that matters to you. Green is clear, nothing to read. Grey means it may have something, and tells you to ask. One dish at a time, only after your finger rests." |
| 1:35–2:00 | **Pinch for the card.** Pinch *Korean Chicken*: the card says what to ask the kitchen to leave out, or the closest safe dish on this menu. Close it. | "Pinch and you get the decision, not a list: leave it out if it is a garnish, swap if it is the dish, or the nearest safe dish on the same menu." |
| 2:00–2:20 | **Second page.** Swap to the Chinese Menu (or the Laurel Café page): recognised in a second, point at *Kung Pao Chicken*, red *Contains peanuts*. | "Any menu we have seen once works. A photo or a phone clip of the page is flattened into a tracking marker, read line by line, and compiled into the Lens." |
| 2:20–2:35 | **Product.** Hold up the gummi worms bag, label to the camera: the label outline and *may contain milk, wheat, soy*. | "Same profile in the grocery store: the label is the marker, the ingredient list is the verdict." |
| 2:35–2:50 | **Design process.** Quick cut: the design brief and demo script written with the skill pack, CLAD building scripts in Lens Studio over the MCP, a LEAF scenario running in the preview, the data pipeline in a terminal. | "Planned with the Learn SPECS skill pack, built by an AI agent through CLAD in Lens Studio, tested with LEAF scenarios that drive the preview. What we learned the hard way: draw less, say less, and look at the result on real footage." |
| 2:50–3:00 | Marks fade as the page leaves the view; the Profile icon returns. Title card: AllergyLens · built with CLAD in Lens Studio · github link. | "AllergyLens. Point at a dish. Know what to order." |

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

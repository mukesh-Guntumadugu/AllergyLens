# AllergyLens — 3-minute demo script

Target: under 3:00. One take per segment, cut together. Record the Lens
Studio Preview panel (SPECS 27, Multimedia video source) at 1280 wide; add
voice-over after. No slides, the menu is the slide.

## Before you record

- Lens Studio 5.23.2, project open, Preview → **Multimedia** →
  `data/menus/star-of-india/menu-1-pan.mp4`, device **SPECS 27**.
- `AllergyLens` object: `defaultProfile` = `peanut,milk`, `defaultMood` =
  `everything`, `showProfileAtStart` = true (segment 1 shows the panel; for
  segments 2–4 the profile is already set).
- `LeafRunner.autoRun` off, `debugSimulateMarker` off (they are saved off).
- Logger panel closed; preview full width. Screen-record the Preview panel
  only (QuickTime or OBS, 30 fps).
- If the marker doesn't lock within 5 s after refresh, refresh again.

## Shot list

| t | on screen | voice-over |
|---|---|---|
| 0:00–0:15 | Black → the real menu video, no marks yet. | "One in ten adults has a food allergy. Every menu is a reading test with the wrong answer in the hospital. AllergyLens is a pair of glasses that reads the menu with you." |
| 0:15–0:40 | **Profile panel.** Pinch *Peanut*, *Milk*; mood *Everything*; pinch *Done*. Panel disappears. (Interactive Preview, mouse = pinch, or the saved hands-free profile with the panel shown at start.) | "You set your profile once: allergies, religious rules, fitness goals. Then you just look at the menu like everyone else." |
| 0:40–1:10 | **Recognition.** Cut to the video. The marks appear on the printed lines: red underline on *Paneer Nan*, *Kheer*, *Mango Lassi*; green dots on *Alu Gobi*, *Gobi Nan*; amber on *Soft Drink*. Badge chip at the top: *Star of India · 14 of 31 safe · ★4.5 · 1 allergy review*. | "The camera recognises the printed page and the glasses draw directly on it. Red: it contains something from your profile. Green: safe. Amber: the restaurant doesn't publish ingredients, so we never call it safe. The chip is the restaurant's own score: how many dishes you can eat, its rating, and how many reviews mention allergy problems." |
| 1:10–1:45 | **Pinch.** Click *Mutter Paneer* → card: *"Paneer is about 35% of this dish — leaving it out guts the dish; you'd pay the same for less. Ask for a swap: tofu."* Close. Click *Maharani Dal* → *"Contains cream (about 10% of the dish). Ask the chef to leave them out."* (Kheer gives the swap *oat milk*; Paneer Nan has no share data and says *"Ask the chef whether it can be left out."*) | "Pinch a line and you get the decision, not a list. If the allergen is a garnish, ask the chef to leave it out. If it's the dish, don't pay full price for half a meal: here's the swap, or the closest safe dish on this menu." |
| 1:45–2:10 | **Mood.** Set `defaultMood` = `vegetarian`, refresh (or reopen the panel and pick *Vegetarian*). Only vegetarian lines are marked; safe ones get a green star. Pan the video so the stars leave the display band: the *← Vegetarian* arrow appears at the edge. | "Tell it what you're in the mood for and it only marks that: green stars are 'order this'. The glasses only draw in the middle of your view, so an arrow points at matches off to the side." |
| 2:10–2:30 | **Product.** *(Placeholder until the Lens UI exists: show the Open Food Facts card data for Jif peanut butter from `data/products.json`, or record the product video the way the menu one was recorded.)* | "Same profile in the grocery store: pick up a jar and the label gets the same marks, from the open Open Food Facts database, three million products." |
| 2:30–2:50 | **How.** Quick cut of the pipeline: menu photo → OCR with positions → local LLM → JSON → compiled into the Lens. Terminal with `node tools/build-data.js` and the GX10. | "Nothing leaves the glasses to draw the marks. The expensive part, reading a menu and working out what's in each dish, runs once per restaurant on a local model, and every user gets it for free afterwards. A dish we've never seen falls back to a small model call, cached forever." |
| 2:50–3:00 | Marks fade as the camera looks away; Profile button returns. Title card: AllergyLens · built with CLAD in Lens Studio · github link. | "AllergyLens. Read the menu. Know what to order." |

## Lines to keep if time is short

1. The marks are on the real printed menu, not a rebuilt one.
2. Unknown is never green.
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

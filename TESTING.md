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
beef pork gelatin alcohol trans_fat high_sugar chicken meat`.
Valid moods: `everything chicken red_meat seafood vegetarian dessert drink`.

## 3. Pick a dish

- **Pinch:** click a marked line (Interactive/Webcam preview: click = pinch).
  A detail card opens beside it: "Contains cashews (about 6% of the dish). Ask
  the chef to leave them out." / "Paneer is about 40% of this dish — leaving it
  out guts the dish; you'd pay the same for less. Ask for a swap: tofu." /
  "Better pick: Alu Gobi". Click again to close.
- **Voice:** turn on the microphone button in the Preview panel and say the
  dish name ("mixed naan"). If the preview mic gives no transcript, pinch is
  the fallback; voice is meant for the glasses.

## 4. The 3D room is NOT a menu test

If you see dots and underlines floating in the room (over posters, a
turntable…) with no menu, one of these is on:

- **`LeafRunner` → `autoRun`** is on: the automated test scenarios are running
  and simulating a page in front of you. Select `LeafRunner` in the Scene
  Hierarchy and turn `autoRun` off.
- **`AllergyLens` → `debugSimulateMarker`** is on: the Lens pretends a menu is
  60 cm ahead so the logic can be checked without a camera. Turn it off for
  real testing.

## 5. Recording the demo

Use the Multimedia (video) source with a hands-free profile, SPECS 27 device,
and record the Preview panel. Show: profile → menu recognized → marks on the
lines → pinch a red line → the advice card. Under 3 minutes.

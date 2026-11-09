# AllergyLens — project story (Devpost "About the project")

## Inspiration

One in ten adults has a food allergy. Add religious food rules and diets, and
a restaurant menu becomes a reading test where the wrong answer can end in
hospital. Today the "solution" is pulling out a phone, photographing the menu
and reading a list. We wanted the answer painted on the menu itself, the
moment you look at it, with your hands still on the menu. That is a job for
AR glasses, so we built it as a Lens for SPECS.

## What it does

- **Profile once.** Allergies, religious rules, diet. Pinch them or say them;
  the Lens speaks exactly one line, "Welcome to Allergy Specs", and is quiet
  after that unless you turn its voice on.
- **Look at a real menu.** The printed page is recognised by image-marker
  tracking and every dish is checked against your profile at once.
- **Point at a dish.** Nothing is drawn until you do. Rest your finger on a
  dish and it answers: **red**, it contains something you can't eat, with the
  reason in words ("Contains chicken (not vegetarian), wheat (wheat flour,
  gochujang)"); **grey**, it may contain something, named, "check with the
  restaurant"; **green**, safe to order, a bare line.
- **Pinch for the card.** Whether the kitchen can leave the allergen out,
  how much of the dish it is, and the closest safe dish on the same menu.
- **Same profile in the shop.** A packaged product's label is the marker and
  its ingredient list is the verdict.

## How we built it

- Planned with the Learn AR with SPECS skill pack; the design brief and the
  demo script it produced are in the `devpost` folder of the repo.
- Built by an AI coding agent through **CLAD in Lens Studio 5.23.2** over the
  **Lens Studio MCP**: TypeScript scripts, scene, image markers, LEAF test
  scenarios and the data pipeline all went through it.
- **Spectacles Interaction Kit** for pinch, hover and drag (the profile icon
  is grabbable with SIK's own manipulation component), **UI Kit** for the
  panels and buttons, **LEAF** for eleven integration scenarios that drive
  the Lens in the preview.
- Menus come from a small pipeline: a phone clip or photo of the page is
  flattened into a tracking marker, OCR gives every dish line with its
  position on the page, a knowledge base of allergens and typical recipes
  fills the ingredients, and a small server model answers dishes nobody has
  seen, cached forever. Packaged products come from Open Food Facts by
  barcode.
- Everything runs in the Lens Studio preview, with the Mac camera as a live
  feed or a recorded video as the camera.

## Challenges we ran into

- **The glasses' view is 32° across; phone footage in the preview is 66°.**
  UI sized in centimetres for the glasses became an unreadable stamp on
  footage. The head-locked UI now measures the real camera projection every
  frame and scales to keep its share of the view.
- **A see-through display cannot draw black.** Our dark "backdrop" for the
  profile step can only dim, never curtain. Design for light, not dark.
- **Tracking a print from its design file is a centimetre off.** A marker
  made from a flat photo of the actual print aligns far better, so pages now
  carry both markers and whichever locks first owns the page.
- **The webcam preview is mirrored, like a selfie, whatever you set.** A
  marker never matches a mirrored page. Every page got a mirrored twin
  marker, and the overlay mirrors its line positions for that twin.
- **Twelve trackers on one camera feed flicker and crawl.** Once a page is
  found, only its own trackers keep running until it is lost for a second.
- **Marks on every dish read as noise, and a kindergarten scribble when the
  tracker drifts.** We threw that away for point-to-check: one dish at a
  time, only after the finger rests half a second, with the reason in words.
- **Data replaced itself.** The server's restaurant catalogue overwrote the
  built-in menus two seconds after start, so a recognised page had nothing to
  draw. Bundled menus now always survive the download.
- Two Lens Studio builds on one machine: 5.24.1 migrated the project on
  every open and reported a wrong camera field of view. Everything here is
  built and verified in 5.23.2.

## What we learned

- Draw less. Say less. One spoken line, one lit dish, the reason in a
  sentence a person would say.
- Red and grey must explain themselves; green needs no explanation.
- Look at the result the way the user sees it, on real footage or the live
  camera, not in the 3D test room. Most of what we fixed today was invisible
  in the room.
- A recording the user sends is the camera, not a backdrop: never crop, pad
  or mute it.

## What's next

Live barcode reading for products, more menus straight from a phone clip,
and the hover answer spoken for people who cannot read small print.

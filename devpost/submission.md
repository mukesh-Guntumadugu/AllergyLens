# AllergyLens — Devpost submission text

Short description for the Devpost form (edit freely; it is written to be pasted).

## What it does

AllergyLens is a Lens for SPECS that reads the menu with you. You set your
profile once by voice or pinch (allergies, religious rules, diet), and from
then on you just look at a menu. The Lens recognises the printed page and
checks every dish against your profile at once, but draws nothing until you
point at a dish. The dish under your finger answers in one of three ways:
**red** with the reason ("Contains chicken (not vegetarian), wheat (wheat
flour, gochujang)"), **grey** when it may contain something, naming it and
telling you to check with the restaurant, or **green**, a bare line, nothing
to worry about. Pinch the dish for the full card: how much of the dish the
allergen is, whether the kitchen can leave it out, and the closest safe
dish on the same menu. A small chip on the page gives the count ("3 of 24
safe"). The same profile works in the grocery store: a packaged product's
label is recognised and judged from its ingredient list.

## Who it is for

The one in ten adults with a food allergy, people with religious food
rules, and anyone on a diet who is tired of reading every ingredient line
on every menu. The answer is painted where they are already looking, and
their hands stay on the menu.

## How it was built

- Planned with the Learn AR with SPECS skill pack: the design brief and
  the demo script in this folder came out of its interview.
- Built by an AI coding agent through CLAD in Lens Studio 5.23.2, over the
  Lens Studio MCP: scripts, scene, markers, LEAF tests and data pipeline.
  Spectacles Interaction Kit for pinch, hover and drag, UI Kit for the
  panels, LEAF for 11 integration scenarios that drive the Lens in the
  preview.
- Menu recognition is Lens Studio's image-marker tracking. The data behind
  each menu comes from a small pipeline: a phone recording or photo of the
  page is flattened into a tracking marker, OCR gives every dish line with
  its position, a knowledge base of allergens and typical recipes fills the
  ingredients, and a small server model answers dishes nobody has seen,
  cached forever. Packaged products come from Open Food Facts by barcode.
- Runs in the Lens Studio preview, with the Mac camera as a live feed or
  with a recorded video as the camera.

## What we learned

- The glasses show about 32° across and cannot draw black. Everything
  head-locked is sized for that view and scaled up in the wider preview;
  a "dark backdrop" can only dim, never curtain.
- Tracking from a flat photo of the real print beats tracking from the
  design file by a wide margin, and a mirrored webcam feed needs a mirrored
  marker.
- Marks drawn on everything read as noise. Point to check, one dish at a
  time, after the pointer rests, with the reason in words, is what people
  can actually use. Red and grey must say why; green needs no explanation.
- One spoken line is enough. A Lens that keeps talking is a Lens people
  mute.
- Build, then look at the result the way a user sees it, on real footage,
  not in the 3D room.

## Links

- Repo: https://github.com/mukesh-Guntumadugu/AllergyLens
- Demo video: (YouTube link)

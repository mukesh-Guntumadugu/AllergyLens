# AllergyLens

A SPECS AR Lens for people who can't eat everything on the menu.

You sit down at a restaurant and look at the menu. The dishes light up against
*your* profile — allergies (peanuts, milk, eggs, shellfish, gluten, soy),
religious rules (no beef, no pork) and fitness goals (avoid trans fat, high
sugar). Transparent light green means eat it; light red means it contains
something you avoid. Pinch a red dish and a small card tells you which
ingredient is the problem and whether you can ask the server to leave it out.

Built for [Learn AR with SPECS](https://learn-specs.devpost.com/) on Devpost
Learn. Planned with the Devpost Learn skill pack (see `devpost/design-brief.md`)
and built by CLAD, Snap's coding agents, in Lens Studio 5.23.2 through the
Lens Studio MCP.

## What's in the preview

- **Profile panel** at start with big pinch toggles, grouped into Allergies,
  Religious and Fitness. Pinch **Done** to hide it.
- **Menu card** (35 × 25 cm) standing on a virtual table about 60 cm in front
  of you, with six dishes.
- **Scan menu** button on the table. Pinch it and each dish is highlighted
  directly on the menu: green = safe, red = conflicts with your profile.
- **Dish detail**: pinch a red dish for a 12 cm card next to it
  ("Contains peanuts. Can be left out: ask your server." /
  "Can't be removed (peanut butter)."). Pinch again or X to close.
- **Profile** button reopens the panel; rescanning updates the highlights.

Everything runs in Lens Studio's Interactive Preview with the mouse
(click = pinch, WASD + Q/E to walk, right-drag to look).

## The stand-in

Lens Studio's preview has no camera feed, so the Lens can't read a real menu
there. The menu is placed in the room and each dish's ingredients are wired
in by hand (`Assets/Scripts/AllergyLensMenuData.ts`). The real-device version
would read the menu with the camera (image marker tracking for printed menus,
or a vision model through Snap's Remote Service Gateway) and feed the same
checker. Everything after recognition — the profile, the check, the
highlights, the detail card — is built for real.

## Layout

```
AllergyLens.esproj          Lens Studio project
Assets/Scripts/             AllergyLens*.ts — main flow, menu data, checker, UI modules, audio
Assets/LeafTests/           LEAF scenarios, one per done criterion
Assets/GeneratedMeshes/     Table (SPECS text-to-3D)
Assets/GeneratedSFX/        Click / scan / detail cues
Assets/Icons/               Material icons used in the UI
devpost/design-brief.md     Planning doc written by the plan-lens skill
Packages/                   SpectaclesInteractionKit, SpectaclesUIKit, Leaf
```

## Tests

Six LEAF scenarios cover the five done criteria in the brief plus a
reachability check. Enable `autoRun` on the `LeafRunner` object and refresh
the preview; results print to the Logger. Last run: 6/6 passed.

## Running it

1. Open `AllergyLens.esproj` in Lens Studio 5.22 or later (built with 5.23.2).
2. Switch the Preview panel to **Interactive Preview**.
3. Toggle a few items on the profile panel, pinch **Done**, then **Scan menu**.

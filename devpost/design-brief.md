---
status: approved
---

# Design brief: AllergyLens

<!-- Filled in by plan-lens from the learner's interview. Use the learner's words. Mark any value they didn't choose as (default). -->

## The one spatial moment
You sit down at a restaurant and look at the menu. The dishes on the menu light up based on *your* profile: transparent light green for the ones you can eat, light red for the ones that have something you're allergic to, don't eat for religious reasons, or are avoiding for fitness. "We are gonna save life." You know what to order, and what to ask the server to leave out, without reading every ingredient list.

## Why it belongs on glasses
- Uses: shares your view (it sees the menu you're reading), draws in the world (the highlights sit on the menu itself), leaves your body free (no phone to pull out, no photo to send; you just read the menu like you normally would)
- Why it's better than the phone or laptop version: today you have to open your phone, take a photo, and read a list. On glasses the answer is painted on the menu the moment you look at it, and your hands stay on the menu.

## Product or overlay
- Type: overlay. It responds to something real: the restaurant menu (later: products on a Walmart or Target shelf).
- What the real version would sense: the camera reads the menu (dish names and ingredients) and, later, product labels on a shelf.
- Stand-in for the preview: a menu with five or six dishes is placed in the virtual room as a real-size menu card with dish images and names. Each dish's ingredients are wired in by hand. When the Lens starts, the menu is already on the table in front of the user; a big **Scan menu** pinch button runs the check against the profile and paints the highlights (default: a button rather than auto-scan, so the "moment of recognition" is obvious in the video). The preview doesn't read the images; the answers are hard-coded per dish.

## Where things live
- Where the user is looking during the main task: down and forward at the menu on the table, roughly arm's length away, a little below eye level, like reading a real menu.
- **Menu card**: standing on a virtual table about 60 cm in front of the user, roughly 25 cm tall by 35 cm wide (default), tilted toward the user. Six dishes laid out in two columns with a picture and name each (default count; learner said "5 or 6").
- **Highlights**: painted directly on each dish on the menu. Transparent light green = safe. Light red = contains something from your profile. No separate floating panel; the menu is the display.
- **Profile panel**: appears once at the start, in front of the user at about 80 cm, a little below eye level, roughly 30 cm wide (default). It gets out of the way after Done is pinched.
- **Dish detail**: a small card attached to the edge of a red dish, pointing at it, about 12 cm wide (default). Shows which ingredient is the problem and whether it can be left out.

## Hands and input
- **Set the profile**: pinch big toggles on the profile panel. Groups: *Allergies* (peanuts, milk, eggs, shellfish, gluten, soy), *Religious* ("I don't eat beef", "I don't eat pork"), *Fitness* ("avoid trans fat", "avoid high sugar"). Learner listed peanuts, milk, chicken, beef, pork, and religious choices; the rest are defaults to fill the panel. A **type your own** field uses the SPECS keyboard, with a **Done** button next to it (default: keyboard is a nice-to-have; the toggles carry the demo).
- **Run the check**: pinch the big **Scan menu** button under the menu. Highlights appear on the menu.
- **See why a dish is red**: pinch the red dish (default). A detail card opens next to it: "Contains peanuts. Can be left out: ask your server." or "Contains peanuts. Can't be removed (peanut butter)." Pinch again or pinch another dish to close it (default).
- **Change profile**: a small **Profile** button near the menu reopens the panel; rescanning updates the highlights (default).
- Targets are big and highlight when aimed at.
- Voice (if any) and the button that does the same job: none.

## When things show
- **Profile panel**: shows at Lens start; hides after **Done** is pinched.
- **Menu card**: always visible on the table once the profile is done.
- **Highlights**: appear after **Scan menu**; stay until the profile changes and the menu is rescanned.
- **Dish detail card**: shows only when a red dish is pinched; hides on the next pinch (default).
- If something needs attention out of view: none. Everything sits on the menu in front of the user (default).

## Done criteria
Each one can be checked in Lens Studio's preview.
1. At start, a profile panel is in front of the user with pinchable toggles for at least peanuts, milk, beef and pork; pinching **Done** hides it and shows the menu on the table.
2. With **peanuts** toggled on, pinching **Scan menu** turns the two peanut dishes light red and the other dishes transparent light green, directly on the menu.
3. With **I don't eat beef** toggled on instead, rescanning turns the beef dish red and the peanut dishes green.
4. Pinching a red dish opens a small card next to it naming the ingredient and saying whether it can be left out; pinching again closes it.
5. Walking around the table in the preview, the menu stays on the table at real size and the highlights stay on their dishes.

## Out of scope
- Reading a real menu or product with the camera (the real product's feature; stand-in in the preview).
- The grocery shelf moment (Walmart / Target product ingredients, fitness rating, product images). Planned as the next moment after the menu works.
- Meal suggestions ("these are the meals you could have"). Add-on for later.
- Accounts and remembering the profile between sessions (the preview can't persist; the profile is set each run).

## Risks and open questions
- The learner wants to demo real recognition on a camera device (Meta Quest was mentioned). The hackathon judges only the Lens Studio preview video, so the preview build uses the stand-in above. Real recognition is a later, real-device feature.
- The typed "add your own" field depends on the SPECS keyboard working in the preview; the toggles carry the demo if it doesn't.
- Feel unproven: reading highlights on a real paper menu in daylight (additive display, light colors) can only be judged on real glasses.

## Build notes for CLAD
- Build for SPECS so it runs and can be demonstrated in Lens Studio's preview. No SPECS device is available.
- Use Spectacles Interaction Kit (SIK) and UI Kit for all interactions, so they work with the mouse in Interactive Preview and with LEAF.
- Build any stand-in exactly as described above, and keep it obvious in the scene.
- Use real-world scale in centimeters. Keep content inside the user's view during the main task.
- The display is additive: black renders as transparent. Don't rely on black or very dark content to be seen; keep text light and readable from where the user stands.
- Get the basic flow working first, then add detail.
- Write LEAF scenarios for each done criterion, run them in preview, and report which pass. Say which criteria have no test.
- Don't record, identify, or follow people.

## After the build: judge it
This part is for you, after CLAD finishes.

1. **Does it work?** Ask your agent which LEAF tests passed and which done criteria have no test.
2. **Walk around it.** Open the preview in Interactive Preview. Use WASD to move, Q and E to go down and up, and right-drag (or hold Shift) to look around. Clicking acts as a pinch. Stand where a user would and look at the task.
3. **Ask the three questions.**
   - Does it use what I'm looking at?
   - Does it put something in my space, where it belongs?
   - Does it free my hands or let me keep my eyes up?
   - Would it be just as good on a phone? If so, what would make it need the glasses?
4. **Check comfort.**
   - Everything I need is in view while I do the task. Nothing sits at the edges, behind me, or stuck to my face.
   - Every control is within reach of someone standing there.
   - Text reads easily from where I stand. No dark UI disappearing.
   - Things show when needed and get out of the way.
5. **Label what you know.** Write "logic proven" next to anything the tests and preview show working, and "feel unproven" next to anything only real glasses could tell you (comfort over time, real hand tracking, real recognition).
6. **Fix with design notes, not code.** Tell your agent what to change in design terms, for example: "Move the step card 15 cm lower and next to the pan. Make the Next button twice as big. Re-run the tests." If a fix takes under a minute, like nudging a panel, do it yourself in the scene.
7. **Submit.** Record a video under 3 minutes of your Lens in the preview, public on YouTube. Make your repo public with your Lens Studio project and this `devpost/` folder. Details are on the hackathon site: https://learn-specs.devpost.com/resources

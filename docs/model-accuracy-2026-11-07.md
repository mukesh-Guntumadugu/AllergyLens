# Model accuracy test — 7 Nov 2026

How good is the small model at the one thing we ask it: "which allergens are in a typical version of this dish"?
Method: `tools/server/eval_llm.py` picks 150 dishes whose ingredients we already trust (printed on the
restaurant's own menu, or researched from cited recipes), asks the model about them **without** showing the
answer, and `tools/eval_llm.js` runs the Lens's own checker on both lists for every single-allergen profile.
Model: `openai/gpt-4.1-nano` through OpenRouter. Same 150 dishes both runs (seed 7).

**Reading the table.** "trusted = contains" is how many of the 150 dishes really carry that allergen.
A **miss** is the dangerous case (the trusted list says contains, the model's does not). A **false alarm** is
the safe direction (an unnecessary red). Agreement is the share of dishes where both verdicts match.

## Run 2 — prompt with the allergen-inclusion rule (deployed)

150 dishes tested with openrouter openai/gpt-4.1-nano; model knew 137, 13 unknown, 0 errors

allergen      trusted=contains  hit   MISS  false alarm  agreement
peanut        5                 4     1     1            99%
tree_nut      5                 2     3     0            98%
milk          66                60    6     23           79%
egg           37                31    6     23           79%
wheat         43                40    3     39           69%
soy           5                 5     0     23           83%
fish          22                17    5     10           89%
shellfish     12                8     4     2            96%
sesame        4                 4     0     3            98%
beef          7                 6     1     1            99%
pork          10                7     3     10           91%
alcohol       3                 1     2     1            98%
meat          51                47    4     15           86%
vegan         9                 5     4     3            95%
trans_fat     2                 0     2     0            99%
high_sugar    51                39    12    15           80%

all allergens: 276 hits, 56 misses, 169 false alarms, 89.7% verdict agreement (83% of trusted "contains" caught)

## Run 1 — first prompt

150 dishes tested with openrouter openai/gpt-4.1-nano; model knew 134, 16 unknown, 0 errors

allergen      trusted=contains  hit   MISS  false alarm  agreement
peanut        4                 4     0     1            99%
tree_nut      6                 1     5     0            96%
milk          64                58    6     18           82%
egg           36                31    5     21           81%
wheat         41                35    6     36           69%
soy           5                 5     0     21           84%
fish          22                16    6     8            90%
shellfish     12                8     4     2            96%
sesame        4                 2     2     6            94%
beef          6                 6     0     3            98%
pork          9                 7     2     7            93%
alcohol       3                 1     2     0            99%
meat          49                46    3     14           87%
vegan         9                 4     5     1            96%
trans_fat     2                 0     2     0            99%
high_sugar    50                42    8     14           84%

all allergens: 266 hits, 56 misses, 152 false alarms, 90.3% verdict agreement (83% of trusted "contains" caught)

## What it means

- Both prompts catch **83 % of the real "contains" cases** and agree with the trusted verdict about **90 %**
  of the time. The inclusion rule moved the targeted categories (tree nuts 1/6 → 2/5, sesame 2/4 → 4/4)
  at the cost of a few more false alarms, which is the direction we want for allergies.
- The misses that remain are **restaurant-specific**: cream cheese in an American sushi roll, almonds in
  one café's chicken salad, flour in one kitchen's chili. No "typical recipe" source can know those; only
  the restaurant's own list can, which is why printed ingredients always win over the model in the join.
- Wheat has the most false alarms (39 of 137): the model adds flour/breading where the trusted recipe has
  none. Safe direction, but it is the one to tune if reds feel excessive.
- Verdicts from the model are therefore worded *typically contains* / *typically safe*, never as fact, and
  the card tells the user to confirm with the restaurant.

Raw answers: `data/eval-llm.json` and `data/eval-llm.prompt1.json` on the VPS (not committed).

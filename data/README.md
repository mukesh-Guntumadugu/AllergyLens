# AllergyLens data

The Lens reads two JSON files from this folder. A scraper or a person fills
them; `node tools/build-data.js` validates them and generates
`Assets/Data/AllergyData.ts`, which is what the Lens compiles in.

```
data/allergens.json   allergen knowledge base: allergen -> aliases
data/menus.json       restaurants -> dishes -> ingredients
tools/build-data.js   validate + generate Assets/Data/AllergyData.ts
```

## allergens.json

```json
{
  "version": 1,
  "allergens": [
    {
      "id": "milk",
      "label": "Milk / dairy",
      "group": "allergy",
      "aliases": ["milk", "whey", "casein", "butter", "cheese", "ghee"]
    }
  ]
}
```

- `id`: stable key, lowercase, used in the profile.
- `group`: `allergy` (medical), `religious`, `diet`, or `preference`.
  The profile panel groups toggles by this.
- `aliases`: lowercase words or phrases. A dish ingredient matches an allergen
  if it *contains* any alias (case-insensitive). Add derivatives and regional
  names here, not in the menus.

## menus.json

```json
{
  "version": 1,
  "restaurants": [
    {
      "id": "thai-basil",
      "name": "Thai Basil Kitchen",
      "source": { "type": "website", "url": "https://example.com/menu", "collected": "2026-11-02" },
      "dishes": [
        {
          "id": "pad-thai",
          "name": "Pad Thai",
          "icon": "ramen_dining",
          "ingredients": ["rice noodles", "egg", "peanuts", "shrimp", "fish sauce"],
          "removable": ["peanuts", "shrimp"]
        },
        {
          "id": "chef-special",
          "name": "Chef's Special",
          "icon": "local_pizza",
          "ingredients": null,
          "removable": [],
          "notes": "Ingredients not published."
        }
      ]
    }
  ]
}
```

- `ingredients`: lowercase plain words. **`null` means unknown** — the Lens
  shows the dish as *unverified* (amber, "ask the restaurant"), never safe.
- `removable`: ingredients the kitchen can leave out on request; must also
  appear in `ingredients`.
- `icon`: a file name (without `.png`) in `Assets/Icons/`. Currently
  available: `ramen_dining`, `lunch_dining`, `set_meal`, `local_pizza`,
  `rice_bowl`, `cake`. Add a PNG there to use a new one.
- `source`: where the data came from and when. Use sources that permit reuse
  (the restaurant's own site, your own printed menus, Open Food Facts).
  Don't bulk-scrape Google Maps; its terms forbid it.

## Safety rule

The checker produces three states per dish:

| state | when | colour |
|---|---|---|
| `safe` | every ingredient is known and none matches the profile | light green |
| `contains` | at least one ingredient matches the profile | light red |
| `unverified` | `ingredients` is `null`/empty, or an ingredient matches nothing in the knowledge base and the profile has an allergy toggled | amber |

Unknown never becomes safe.

## Workflow for the scraper (ASUS GX10)

1. Output `menus.json` in the shape above (and extend `allergens.json` if you
   find new ingredient names).
2. Run `node tools/build-data.js`. It fails loudly on anything malformed.
3. Commit `data/` and the regenerated `Assets/Data/AllergyData.ts`.

Optionally the Lens can also `fetch()` the same `menus.json` shape from a URL
at runtime; bundled data is always the fallback so the demo never depends on
a network.

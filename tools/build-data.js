#!/usr/bin/env node
// Generates Assets/Data/AllergyData.ts from:
//   data/allergens.json   allergen -> aliases
//   data/dishes.json      dish name -> typical ingredients (used when a menu has no ingredients)
//   data/menus.json       restaurants -> dishes (+ optional rating)
// Lens Studio can't import .json files directly, so the Lens reads a generated
// TypeScript module instead. Run after changing anything in data/:
//
//   node tools/build-data.js
//
// The join with the dish knowledge base happens here, at build time, so the Lens
// only ever sees one ingredient list per dish plus where it came from.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const allergens = read("data/allergens.json");
const dishKb = read("data/dishes.json");
const menus = read("data/menus.json");

const errors = [];
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// --- allergens -------------------------------------------------------------
const ids = new Set();
for (const a of allergens.allergens) {
  if (!a.id || ids.has(a.id)) errors.push(`allergen id missing or duplicated: ${a.id}`);
  ids.add(a.id);
  if (!Array.isArray(a.aliases) || a.aliases.length === 0) errors.push(`allergen ${a.id} has no aliases`);
  if (!["allergy", "religious", "diet", "preference"].includes(a.group)) errors.push(`allergen ${a.id} bad group ${a.group}`);
}

// --- dish knowledge base ---------------------------------------------------
for (const d of dishKb.dishes) {
  if (!d.name) errors.push(`dish KB entry without name`);
  if (!Array.isArray(d.typicalIngredients) || d.typicalIngredients.length === 0) errors.push(`dish KB "${d.name}" has no typicalIngredients`);
  for (const ing of d.typicalIngredients || []) {
    if (typeof ing !== "string" || ing !== ing.toLowerCase()) errors.push(`dish KB "${d.name}": ingredient "${ing}" must be lowercase text`);
  }
}
function lookupDish(menuName) {
  const n = norm(menuName);
  let best = null;
  for (const d of dishKb.dishes) {
    for (const key of [d.name, ...(d.aliases || [])]) {
      const k = norm(key);
      if (k && n.includes(k) && (!best || k.length > best.key.length)) best = { key: k, dish: d };
    }
  }
  return best ? best.dish : null;
}

// --- menus -----------------------------------------------------------------
const iconDir = path.join(root, "Assets", "Icons");
const icons = fs.existsSync(iconDir)
  ? new Set(fs.readdirSync(iconDir).filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/, "")))
  : null;

const dishIds = new Set();
let typicalCount = 0;
const restaurants = menus.restaurants.map((r) => {
  if (!r.id || !r.name) errors.push(`restaurant missing id/name: ${JSON.stringify(r).slice(0, 60)}`);
  if (r.rating) {
    const rt = r.rating;
    if (typeof rt.stars !== "number" || rt.stars < 0 || rt.stars > 5) errors.push(`${r.id}: rating.stars must be 0-5`);
    if (rt.allergyComplaints != null && typeof rt.allergyComplaints !== "number") errors.push(`${r.id}: rating.allergyComplaints must be a number`);
  }
  const dishes = r.dishes.map((d) => {
    const key = `${r.id}/${d.id}`;
    if (dishIds.has(key)) errors.push(`duplicate dish ${key}`);
    dishIds.add(key);
    if (d.ingredients !== null && d.ingredients !== undefined && !Array.isArray(d.ingredients)) errors.push(`${key}: ingredients must be a list or null`);
    for (const ing of d.ingredients || []) {
      if (typeof ing !== "string" || ing !== ing.toLowerCase()) errors.push(`${key}: ingredient "${ing}" must be lowercase text`);
    }
    for (const rem of d.removable || []) {
      if (!(d.ingredients || []).includes(rem)) errors.push(`${key}: removable "${rem}" is not in ingredients`);
    }
    if (icons && d.icon && !icons.has(d.icon)) errors.push(`${key}: icon "${d.icon}" not found in Assets/Icons`);

    // Join: restaurant ingredients win; otherwise fall back to the dish KB; otherwise unknown.
    let ingredients = d.ingredients && d.ingredients.length ? d.ingredients : null;
    let ingredientsSource = ingredients ? "restaurant" : "none";
    if (!ingredients) {
      const kb = lookupDish(d.name);
      if (kb) {
        ingredients = kb.typicalIngredients;
        ingredientsSource = "typical";
        typicalCount++;
      }
    }
    // shares / substitutes come from the dish KB entry when we have one (either as the
    // ingredient source or as extra knowledge for a restaurant-published list)
    const kbForShares = lookupDish(d.name);
    const shares = kbForShares && kbForShares.shares ? kbForShares.shares : {};
    const substitutes = kbForShares && kbForShares.substitutes ? kbForShares.substitutes : {};

    if (d.layout) {
      for (const k of ["x", "y", "w", "h"]) {
        const v = d.layout[k];
        if (typeof v !== "number" || v < 0 || v > 1) errors.push(`${key}: layout.${k} must be a 0..1 fraction`);
      }
    }
    return {
      id: d.id,
      name: d.name,
      icon: d.icon || null,
      ingredients,
      ingredientsSource,
      removable: d.removable || [],
      shares,
      substitutes,
      layout: d.layout || null,
      ...(d.notes ? { notes: d.notes } : {}),
    };
  });
  if (r.menuImage) {
    const mi = r.menuImage;
    if (!mi.path || typeof mi.widthCm !== "number") errors.push(`${r.id}: menuImage needs path and widthCm`);
    else if (!fs.existsSync(path.join(root, mi.path))) errors.push(`${r.id}: menuImage.path not found: ${mi.path}`);
  }
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    rating: r.rating || null,
    menuImage: r.menuImage || null,
    dishes,
  };
});

if (errors.length) {
  console.error("data validation failed:\n  " + errors.join("\n  "));
  process.exit(1);
}

const banner = `// GENERATED by tools/build-data.js from data/allergens.json, data/dishes.json and data/menus.json.
// Do not edit by hand; edit the JSON and re-run the script.
`;

const out = `${banner}
export type AllergenGroup = "allergy" | "religious" | "diet" | "preference"

export interface AllergenDef {
  id: string
  label: string
  group: AllergenGroup
  aliases: string[]
}

/** Where a dish's ingredient list came from.
 *  restaurant = the restaurant published it (trusted)
 *  typical    = looked up from the dish knowledge base by dish name (show as "typically contains", confirm)
 *  none       = unknown: the dish is UNVERIFIED and never safe */
export type IngredientsSource = "restaurant" | "typical" | "none"

/** Where a dish line sits on the restaurant's menu image, as fractions of the
 *  image (0..1, origin top-left). Used to place the highlight over the printed
 *  line when the menu is marker-tracked. null when unknown. */
export interface DishLayout {
  x: number
  y: number
  w: number
  h: number
}

export interface DishDef {
  id: string
  name: string
  icon: string | null
  /** null when ingredientsSource is "none" */
  ingredients: string[] | null
  ingredientsSource: IngredientsSource
  removable: string[]
  /** rough percent of the dish by weight, per ingredient (from the dish knowledge base; may be empty) */
  shares: { [ingredient: string]: number }
  /** common kitchen substitute per ingredient, or null when there is none (may be empty) */
  substitutes: { [ingredient: string]: string | null }
  layout: DishLayout | null
  notes?: string
}

/** The photo of the real menu page the Lens tracks as an image marker. */
export interface MenuImageDef {
  /** repo-relative path to the image (also imported as a texture under Assets/Markers) */
  path: string
  widthPx: number
  heightPx: number
  /** printed width of the page in centimeters (marker size) */
  widthCm: number
}

export interface RestaurantRating {
  /** 0-5, from the restaurant's public listing (e.g. Google Places API) */
  stars: number
  reviewCount?: number
  /** number of reviews that mention allergy / wrong-order problems */
  allergyComplaints?: number
  source: { type: string; url: string | null; collected: string }
}

export interface RestaurantDef {
  id: string
  name: string
  source: { type: string; url: string | null; collected: string }
  rating: RestaurantRating | null
  /** null for restaurants without a tracked menu image */
  menuImage: MenuImageDef | null
  dishes: DishDef[]
}

export const DATA_VERSION = ${JSON.stringify(`${allergens.version}.${dishKb.version}.${menus.version}`)}

export const ALLERGENS: AllergenDef[] = ${JSON.stringify(allergens.allergens, null, 2)}

export const RESTAURANTS: RestaurantDef[] = ${JSON.stringify(restaurants, null, 2)}
`;

const outDir = path.join(root, "Assets", "Data");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "AllergyData.ts");
fs.writeFileSync(outFile, out);
console.log(
  `wrote ${path.relative(root, outFile)}: ${allergens.allergens.length} allergens, ` +
    `${dishKb.dishes.length} KB dishes, ${restaurants.length} restaurants, ${dishIds.size} menu dishes ` +
    `(${typicalCount} filled from the dish KB)`
);

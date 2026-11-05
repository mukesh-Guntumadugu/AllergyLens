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
let dishKb = read("data/dishes.json");                        // committed, hand-checked seed catalog
const menus = read("data/menus.json");                       // committed, hand-curated seed only
// Scraped restaurants live in the gitignored lake; join them in for a local Lens build, never for a commit.
const withLake = process.argv.includes("--with-lake") || process.env.ALLERGY_WITH_LAKE === "1";
const lakePath = path.join(root, "data-lake", "gold", "lens", "menus.json");
if (withLake && fs.existsSync(lakePath)) {
  const lake = JSON.parse(fs.readFileSync(lakePath, "utf8"));
  const byId = new Map(menus.restaurants.map((r) => [r.id, r]));
  for (const r of lake.restaurants) byId.set(r.id, r);        // lake entry wins over the seed
  menus.restaurants = [...byId.values()];
  console.log(`+ ${lake.restaurants.length} scraped restaurants from ${path.relative(root, lakePath)} (local build; do not commit the result)`);
}
const lakeDishes = path.join(root, "data-lake", "gold", "dishes.json");
if (withLake && fs.existsSync(lakeDishes)) {
  const lake = JSON.parse(fs.readFileSync(lakeDishes, "utf8"));
  const byName = new Map(dishKb.dishes.map((d) => [d.name, d]));
  for (const d of lake.dishes) byName.set(d.name, d);         // researched entry wins over the seed
  dishKb = { ...dishKb, dishes: [...byName.values()] };
  console.log(`+ ${lake.dishes.length} researched dishes from data-lake/gold/dishes.json (local build; do not commit the result)`);
}

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

// --- dish category (what someone "in the mood for X" is looking for) -------
const CATEGORY_RULES = [
  ["drink", /\b(lassi|tea|coffee|soda|soft drink|juice|smoothie|milkshake|cola|water|milk)\b/, "name"],
  ["dessert", /\b(ice cream|kulfi|kheer|jamun|cake|pudding|halwa|dessert|sweet|brownie|cheesecake|pie)\b/, "name"],
  ["chicken", /\b(chicken|poultry|turkey|duck)\b/, "ingredients"],
  ["red_meat", /\b(beef|lamb|mutton|pork|bacon|ham|steak|sausage|veal|goat|prosciutto|pepperoni|salami)\b/, "ingredients"],
  ["seafood", /\b(fish|salmon|tuna|shrimp|prawn|prawns|crab|lobster|anchovy|anchovies|squid|calamari|clam|clams|mussel|mussels|scallop|scallops|cod)\b/, "ingredients"],
];
function deriveCategory(name, ingredients, kb) {
  const n = norm(name);
  const ingText = (ingredients || []).concat(kb ? kb.typicalIngredients || [] : []).join(" ").toLowerCase() + " " + n;
  for (const [cat, re, scope] of CATEGORY_RULES) {
    if (re.test(scope === "name" ? n : ingText)) return cat;
  }
  if (ingredients && ingredients.length) return "vegetarian";
  if (kb) return "vegetarian";
  return "unknown";
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
    const category = d.category || deriveCategory(d.name, ingredients, kbForShares);
    const shares = kbForShares && kbForShares.shares ? kbForShares.shares : {};
    const substitutes = kbForShares && kbForShares.substitutes ? kbForShares.substitutes : {};

    if (d.layout) {
      for (const k of ["x", "y", "w", "h"]) {
        const v = d.layout[k];
        if (typeof v !== "number" || v < 0 || v > 1) errors.push(`${key}: layout.${k} must be a 0..1 fraction`);
      }
    }
    if (d.price != null && (typeof d.price !== "number" || d.price < 0 || d.price > 500)) errors.push(`${key}: price must be a number 0-500 or null`);
    return {
      id: d.id,
      name: d.name,
      icon: d.icon || null,
      ingredients,
      ingredientsSource,
      category,
      removable: d.removable || [],
      shares,
      substitutes,
      layout: d.layout || null,
      price: typeof d.price === "number" ? d.price : null,
      section: d.section || null,
      markers: Array.isArray(d.markers) ? d.markers : [],
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
    cuisine: r.cuisine || null,
    rating: r.rating || null,
    menuImage: r.menuImage || null,
    dishes,
  };
});

// --- packaged products (pipeline 2, optional) ------------------------------
const productsPath = path.join(root, "data", "products.json");
const products = fs.existsSync(productsPath) ? read("data/products.json") : { version: 0, attribution: "", products: [] };
const seenCodes = new Set();
for (const p of products.products) {
  if (!p.barcode || seenCodes.has(p.barcode)) errors.push(`product barcode missing or duplicated: ${p.barcode}`);
  seenCodes.add(p.barcode);
  if (!p.name) errors.push(`product ${p.barcode} has no name`);
  if (p.ingredients !== null && !Array.isArray(p.ingredients)) errors.push(`product ${p.barcode}: ingredients must be a list or null`);
}

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
  /** one line shown under the toggle, e.g. what sesame hides in */
  hint?: string
  /** toggling this on also turns these ids on (vegan → vegetarian, milk, egg) */
  implies?: string[]
  /** phrases that contain an alias but are NOT this allergen ("coconut milk", "almond flour"); stripped before matching */
  exclude?: string[]
  /** how people say it to the panel ("transfer" for trans fat, "pure veg"); voice only, never used on ingredients */
  spoken?: string[]
}

/** Where a dish's ingredient list came from.
 *  restaurant = the restaurant published it (trusted)
 *  typical    = looked up from the dish knowledge base by dish name (show as "typically contains", confirm)
 *  none       = unknown: the dish is UNVERIFIED and never safe */
export type IngredientsSource = "restaurant" | "typical" | "none"

export type DishCategory = "chicken" | "red_meat" | "seafood" | "vegetarian" | "dessert" | "drink" | "unknown"

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
  /** what kind of dish this is, for the "in the mood for" filter; derived from
   *  ingredients/name at build time unless menus.json sets it explicitly */
  category: DishCategory
  removable: string[]
  /** rough percent of the dish by weight, per ingredient (from the dish knowledge base; may be empty) */
  shares: { [ingredient: string]: number }
  /** common kitchen substitute per ingredient, or null when there is none (may be empty) */
  substitutes: { [ingredient: string]: string | null }
  layout: DishLayout | null
  /** printed price in the menu's currency, or null when not read (price filter in the Lens) */
  price: number | null
  /** section heading as printed on the menu ("Tandoori Breads"), or null */
  section: string | null
  /** printed dietary markers next to the line, e.g. ["V", "GF", "spicy:2"] */
  markers: string[]
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
  /** cuisine tag from discovery (OpenStreetMap), e.g. "indian"; null when unknown */
  cuisine: string | null
  rating: RestaurantRating | null
  /** null for restaurants without a tracked menu image */
  menuImage: MenuImageDef | null
  dishes: DishDef[]
}

/** A packaged grocery product (pipeline 2, Open Food Facts). Checked with the
 *  same alias matching as dishes; "allergens" / "traces" are the label's own
 *  declarations and win over ingredient matching when present. */
export interface ProductDef {
  barcode: string
  name: string
  brand: string | null
  ingredients: string[] | null
  allergens: string[]
  traces: string[]
  nutrition: { sugar_g: number | null; trans_fat_g: number | null; saturated_fat_g: number | null; sodium_mg: number | null; kcal: number | null }
  fitness: { highSugar: boolean; transFat: boolean; highSodium: boolean }
  image: string | null
  source: { type: string; url: string | null; collected: string }
}

export const DATA_VERSION = ${JSON.stringify(`${allergens.version}.${dishKb.version}.${menus.version}.${products.version}`)}

export const PRODUCTS_ATTRIBUTION = ${JSON.stringify(products.attribution || "")}

export const ALLERGENS: AllergenDef[] = ${JSON.stringify(allergens.allergens, null, 2)}

export const RESTAURANTS: RestaurantDef[] = ${JSON.stringify(restaurants, null, 2)}

export const PRODUCTS: ProductDef[] = ${JSON.stringify(products.products, null, 2)}
`;

const outDir = path.join(root, "Assets", "Data");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "AllergyData.ts");
fs.writeFileSync(outFile, out);
// The same joined restaurants as JSON, for tools/serve_data.py: what the Lens fetches live must carry the
// knowledge-base ingredients and sources exactly like the compiled snapshot (gitignored; rebuild on the server).
fs.writeFileSync(path.join(root, "data", "menus.lens.json"), JSON.stringify({ version: menus.version, built: new Date().toISOString(), restaurants }, null, 1));
console.log(
  `wrote ${path.relative(root, outFile)}: ${allergens.allergens.length} allergens, ` +
    `${dishKb.dishes.length} KB dishes, ${restaurants.length} restaurants, ${dishIds.size} menu dishes ` +
    `(${typicalCount} filled from the dish KB), ${products.products.length} packaged products`
);

// AllergyLensMenuData — thin adapter over the GENERATED data module
// (Assets/Data/AllergyData.ts, built by `node tools/build-data.js` from data/*.json).
// Owns: group labels/order for the profile panel, the active restaurant list (bundled
// by default, replaceable at runtime from a fetched menus.json), and minimal validation
// of that remote shape. Expects no @inputs. Must not hard-code dishes or allergens.

import {
  ALLERGENS,
  RESTAURANTS,
  DATA_VERSION,
  AllergenDef,
  AllergenGroup,
  DishCategory,
  DishDef,
  RestaurantDef,
} from "../Data/AllergyData"

export type {AllergenDef, AllergenGroup, DishDef, RestaurantDef}
export {ALLERGENS, DATA_VERSION}
export type IngredientsSource = DishDef["ingredientsSource"]
export type RestaurantRating = NonNullable<RestaurantDef["rating"]>
export type DishLayout = NonNullable<DishDef["layout"]>
export type MenuImageDef = NonNullable<RestaurantDef["menuImage"]>

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && isFinite(v) ? v : fallback
}

function parseLayout(v: unknown): DishLayout | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (typeof o.x !== "number" || typeof o.y !== "number" || typeof o.w !== "number" || typeof o.h !== "number") return null
  return {x: o.x, y: o.y, w: o.w, h: o.h}
}

function parseMenuImage(v: unknown): MenuImageDef | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (typeof o.path !== "string") return null
  return {path: o.path, widthPx: numOr(o.widthPx, 0), heightPx: numOr(o.heightPx, 0), widthCm: numOr(o.widthCm, 0)}
}

function parseStringMap<T>(v: unknown, accept: (x: unknown) => x is T): {[k: string]: T} {
  const out: {[k: string]: T} = {}
  if (v && typeof v === "object") {
    for (const k of Object.keys(v as object)) {
      const val = (v as Record<string, unknown>)[k]
      if (accept(val)) out[k] = val
    }
  }
  return out
}

export const DEFAULT_RESTAURANT_ID = "demo-bistro"

export const GROUP_ORDER: AllergenGroup[] = ["allergy", "religious", "diet", "preference"]

export const GROUP_LABELS: Record<AllergenGroup, string> = {
  allergy: "Allergies",
  religious: "Religious",
  diet: "Diet",
  preference: "Preferences",
}

export function allergensInGroup(group: AllergenGroup): AllergenDef[] {
  return ALLERGENS.filter((a) => a.group === group)
}

let activeRestaurants: RestaurantDef[] = RESTAURANTS

export function getRestaurants(): RestaurantDef[] {
  return activeRestaurants
}

export function getRestaurant(id: string): RestaurantDef | undefined {
  return activeRestaurants.find((r) => r.id === id)
}

// ── Mood categories ─────────────────────────────────────────────────────────
export type MoodCategory = DishCategory
/** What the user can pick on the profile panel ("everything" = no filter). */
export type Mood = "everything" | "chicken" | "red_meat" | "seafood" | "vegetarian" | "dessert"

export const MOODS: Array<{id: Mood; label: string}> = [
  {id: "chicken", label: "Chicken"},
  {id: "red_meat", label: "Red meat"},
  {id: "seafood", label: "Seafood"},
  {id: "vegetarian", label: "Vegetarian"},
  {id: "dessert", label: "Dessert"},
  {id: "everything", label: "Everything"},
]

export function moodLabel(mood: Mood): string {
  return MOODS.find((m) => m.id === mood)?.label ?? mood
}

const CHICKEN_WORDS = ["chicken", "poultry"]
const RED_MEAT_WORDS = ["beef", "lamb", "mutton", "pork", "bacon", "ham", "steak", "sausage"]
const SEAFOOD_WORDS = ["fish", "salmon", "tuna", "shrimp", "prawn", "crab", "anchovy", "squid"]
const DRINK_WORDS = ["lassi", "tea", "coffee", "soda", "soft drink", "juice"]
const DESSERT_WORDS = ["sugar", "syrup", "ice cream", "cake", "jamun", "kulfi", "kheer", "pudding"]

function hasWord(haystack: string[], words: string[]): boolean {
  return haystack.some((h) => words.some((w) => h.indexOf(w) >= 0))
}

const CATEGORIES: DishCategory[] = ["chicken", "red_meat", "seafood", "vegetarian", "dessert", "drink", "unknown"]

/** The dish's category from the data; derived only when the field is missing (remote menus). */
export function dishCategory(dish: DishDef): MoodCategory {
  const given = (dish as {category?: string}).category
  if (given && CATEGORIES.indexOf(given as DishCategory) >= 0) return given as DishCategory
  return deriveCategory(dish)
}

/** Tiny fallback: same rules the generator uses (name + ingredients + KB share keys). */
export function deriveCategory(dish: Pick<DishDef, "name" | "ingredients" | "shares">): MoodCategory {
  const name = dish.name.toLowerCase()
  const ingredients = (dish.ingredients ?? []).map((i) => i.toLowerCase())
  for (const k of Object.keys(dish.shares ?? {})) ingredients.push(k.toLowerCase())
  const all = ingredients.concat([name])
  if (hasWord(all, CHICKEN_WORDS)) return "chicken"
  if (hasWord(all, RED_MEAT_WORDS)) return "red_meat"
  if (hasWord(all, SEAFOOD_WORDS)) return "seafood"
  if (hasWord([name], DRINK_WORDS) || name === "milk" || hasWord(ingredients, ["lassi", "soda", "juice", "coffee"])) return "drink"
  if (hasWord(all, DESSERT_WORDS)) return "dessert"
  if (ingredients.length > 0) return "vegetarian"
  return "unknown"
}

/** Restaurants whose real menu page is tracked as an image marker. */
export function restaurantsWithMenuImage(): RestaurantDef[] {
  return activeRestaurants.filter((r) => !!r.menuImage)
}

/** Replace the bundled list (e.g. with a fetched menus.json). Pass a validated list. */
export function setRestaurants(restaurants: RestaurantDef[]): void {
  if (restaurants.length > 0) activeRestaurants = restaurants
}

/**
 * Minimal validation of the data/menus.json shape: {restaurants: [{id, name, dishes: [{id,
 * name, icon, ingredients: string[]|null, removable: string[]}]}]}. Returns null when the
 * shape is wrong so the caller can fall back to bundled data.
 */
export function validateMenus(json: unknown): RestaurantDef[] | null {
  if (!json || typeof json !== "object") return null
  const list = (json as {restaurants?: unknown}).restaurants
  if (!Array.isArray(list) || list.length === 0) return null
  const out: RestaurantDef[] = []
  for (const r of list as Array<Record<string, unknown>>) {
    if (typeof r.id !== "string" || typeof r.name !== "string" || !Array.isArray(r.dishes)) return null
    const dishes: DishDef[] = []
    for (const d of r.dishes as Array<Record<string, unknown>>) {
      if (typeof d.id !== "string" || typeof d.name !== "string") return null
      const ingredients = d.ingredients
      if (ingredients !== null && ingredients !== undefined && !Array.isArray(ingredients)) return null
      const ing = Array.isArray(ingredients) ? ingredients.filter((x) => typeof x === "string").map((x) => String(x).toLowerCase()) : null
      const srcRaw = d.ingredientsSource
      const ingredientsSource: IngredientsSource =
        srcRaw === "typical" || srcRaw === "restaurant" || srcRaw === "none" ? srcRaw : ing && ing.length > 0 ? "restaurant" : "none"
      const removable = Array.isArray(d.removable) ? (d.removable as unknown[]).filter((x) => typeof x === "string").map((x) => String(x).toLowerCase()) : []
      dishes.push({
        id: d.id,
        name: d.name,
        icon: typeof d.icon === "string" ? d.icon : null,
        ingredients: ingredientsSource === "none" ? null : ing,
        ingredientsSource,
        removable,
        shares: parseStringMap<number>(d.shares, (x): x is number => typeof x === "number"),
        substitutes: parseStringMap<string | null>(d.substitutes, (x): x is string | null => x === null || typeof x === "string"),
        layout: parseLayout(d.layout),
        category: "unknown",
        price: typeof d.price === "number" && isFinite(d.price) ? d.price : null,
        section: typeof d.section === "string" ? d.section : null,
        markers: Array.isArray(d.markers) ? (d.markers as unknown[]).filter((x) => typeof x === "string").map((x) => String(x)) : [],
        notes: typeof d.notes === "string" ? d.notes : undefined,
      })
      const last = dishes[dishes.length - 1]
      last.category = typeof d.category === "string" && CATEGORIES.indexOf(d.category as DishCategory) >= 0 ? (d.category as DishCategory) : deriveCategory(last)
    }
    if (dishes.length === 0) return null
    const src = (r.source ?? {}) as Record<string, unknown>
    const rr = r.rating as Record<string, unknown> | null | undefined
    const rating: RestaurantRating | null =
      rr && typeof rr === "object" && typeof rr.stars === "number"
        ? {
            stars: rr.stars,
            reviewCount: typeof rr.reviewCount === "number" ? rr.reviewCount : undefined,
            allergyComplaints: typeof rr.allergyComplaints === "number" ? rr.allergyComplaints : undefined,
            source: (typeof rr.source === "object" && rr.source ? rr.source : {type: "remote", url: null, collected: ""}) as RestaurantRating["source"],
          }
        : null
    out.push({
      rating,
      menuImage: parseMenuImage(r.menuImage),
      id: r.id,
      name: r.name,
      cuisine: typeof r.cuisine === "string" ? r.cuisine : null,
      source: {
        type: typeof src.type === "string" ? src.type : "remote",
        url: typeof src.url === "string" ? src.url : null,
        collected: typeof src.collected === "string" ? src.collected : "",
      },
      dishes,
    })
  }
  return out
}

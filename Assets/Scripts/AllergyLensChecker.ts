// AllergyLensChecker — pure logic. Owns: the profile set (which allergen ids the user
// flagged) and the alias-based check that turns a dish + profile into one of three
// states: "safe" (ingredients known, nothing matched), "contains" (>=1 ingredient
// contains an alias of a flagged allergen), "unverified" (ingredients unknown — never
// safe). Expects no @inputs. Must not touch the scene; Main pushes results into the UI.

import {ALLERGENS, AllergenDef, DishDef, IngredientsSource, ProductDef, RestaurantDef} from "./AllergyLensMenuData"

export type DishVerdict = "none" | "safe" | "contains" | "unverified"

export interface IngredientMatch {
  ingredient: string
  allergenId: string
  allergenLabel: string
  /** The kitchen can leave this ingredient out (dish.removable). */
  removable: boolean
}

export interface DishResult {
  dishId: string
  verdict: DishVerdict
  /** Where the ingredient list came from: published by the restaurant, a typical recipe, or none. */
  source: IngredientsSource
  /** Matched ingredients in dish order (one entry per ingredient x allergen). */
  matches: IngredientMatch[]
}

export type RestaurantBadgeLevel = "good" | "caution" | "avoid"

export interface RestaurantBadge {
  level: RestaurantBadgeLevel
  safeCount: number
  total: number
  unverifiedCount: number
  /** e.g. "4 of 6 safe · ★4.4 · 2 reviews mention allergies" */
  text: string
}

export class Profile {
  private flagged = new Set<string>()

  set(id: string, on: boolean): void {
    if (on) this.flagged.add(id)
    else this.flagged.delete(id)
  }

  has(id: string): boolean {
    return this.flagged.has(id)
  }

  clear(): void {
    this.flagged.clear()
  }

  ids(): string[] {
    return Array.from(this.flagged)
  }

  get isEmpty(): boolean {
    return this.flagged.size === 0
  }
}

const aliasRegexCache = new Map<string, RegExp>()

/** The alias as a whole word (or words) inside the ingredient: "ham" must not match "graham cracker", "egg" not "eggplant". */
function aliasRegex(alias: string): RegExp {
  let re = aliasRegexCache.get(alias)
  if (!re) {
    const escaped = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")
    re = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`)
    aliasRegexCache.set(alias, re)
  }
  return re
}

/**
 * True when the (lowercase) ingredient contains any alias of the allergen as a whole word,
 * after removing the allergen's exclusions: "coconut milk" is not milk, "almond flour" is
 * not wheat, "peanut butter" is not dairy.
 */
export function ingredientMatches(ingredient: string, allergen: AllergenDef): boolean {
  let low = ingredient.toLowerCase()
  for (const ex of allergen.exclude ?? []) {
    if (ex && aliasRegex(ex).test(low)) low = low.replace(aliasRegex(ex), "$1 $2")
  }
  for (const alias of allergen.aliases) {
    if (alias && aliasRegex(alias).test(low)) return true
  }
  return false
}

export function checkDish(dish: DishDef, profile: Profile, allergens: AllergenDef[] = ALLERGENS): DishResult {
  const source: IngredientsSource = dish.ingredientsSource ?? (dish.ingredients ? "restaurant" : "none")
  if (source === "none" || !dish.ingredients || dish.ingredients.length === 0) {
    return {dishId: dish.id, verdict: "unverified", source: "none", matches: []}
  }
  const active = allergens.filter((a) => profile.has(a.id))
  const matches: IngredientMatch[] = []
  // Match the published ingredient lines AND the knowledge-base share keys (a restaurant
  // line like "rice pudding" says nothing about milk; the KB's shares do).
  const candidates = dish.ingredients.slice()
  for (const key of Object.keys(dish.shares ?? {})) if (candidates.indexOf(key) < 0) candidates.push(key)
  for (const ing of candidates) {
    for (const a of active) {
      if (ingredientMatches(ing, a)) {
        matches.push({
          ingredient: ing,
          allergenId: a.id,
          allergenLabel: a.label,
          removable: dish.removable.indexOf(ing) >= 0,
        })
      }
    }
  }
  return {dishId: dish.id, verdict: matches.length > 0 ? "contains" : "safe", source, matches}
}

/**
 * Restaurant-level badge for the CURRENT profile, from the per-dish states:
 *   avoid   — no dish is safe, or allergyComplaints >= 3
 *   caution — fewer than half the dishes are safe, or any dish is unverified, or allergyComplaints >= 1
 *   good    — otherwise
 */
export function rateRestaurant(restaurant: RestaurantDef, profile: Profile, allergens: AllergenDef[] = ALLERGENS): RestaurantBadge {
  const results = checkMenu(restaurant.dishes, profile, allergens)
  const total = results.length
  const safeCount = results.filter((r) => r.verdict === "safe").length
  const unverifiedCount = results.filter((r) => r.verdict === "unverified").length
  const complaints = restaurant.rating?.allergyComplaints ?? 0
  let level: RestaurantBadgeLevel = "good"
  if (safeCount === 0 || complaints >= 3) level = "avoid"
  else if (safeCount < total / 2 || unverifiedCount > 0 || complaints >= 1) level = "caution"
  let text = `${safeCount} of ${total} safe`
  if (restaurant.rating) {
    text += ` · ★${restaurant.rating.stars.toFixed(1)}`
    if (complaints > 0) text += ` · ${complaints} review${complaints === 1 ? "" : "s"} mention${complaints === 1 ? "s" : ""} allergies`
  }
  return {level, safeCount, total, unverifiedCount, text}
}

export function checkMenu(dishes: DishDef[], profile: Profile, allergens: AllergenDef[] = ALLERGENS): DishResult[] {
  return dishes.map((d) => checkDish(d, profile, allergens))
}

// ── Replacement rule (detail card) ──────────────────────────────────────────

const SHARE_THRESHOLD_PCT = 10

function shareOf(dish: DishDef, ingredient: string): number | null {
  const v = dish.shares ? dish.shares[ingredient] : undefined
  return typeof v === "number" && isFinite(v) ? v : null
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/**
 * Nearest SAFE dish on the same menu by printed layout: same column preferred
 * (|dx| < 0.3), smallest |dy|. Returns null when nothing safe has a layout.
 */
export function nearestSafeDish(dish: DishDef, restaurant: RestaurantDef, allResults: DishResult[]): DishDef | null {
  if (!dish.layout) return null
  const safeIds = new Set(allResults.filter((r) => r.verdict === "safe").map((r) => r.dishId))
  let best: DishDef | null = null
  let bestKey = Infinity
  for (const other of restaurant.dishes) {
    if (other.id === dish.id || !other.layout || !safeIds.has(other.id)) continue
    const dx = Math.abs(other.layout.x - dish.layout.x)
    const dy = Math.abs(other.layout.y - dish.layout.y)
    // Same printed section first (a breakfast for a breakfast, not a coffee), then the same
    // kind of dish, then the same column, then vertical distance.
    const sameSection = !!dish.section && !!other.section && dish.section === other.section
    const sameKind = dish.category === other.category
    const key = (sameSection ? 0 : 100) + (sameKind ? 0 : 20) + (dx < 0.3 ? 0 : 10) + dy
    if (key < bestKey) {
      bestKey = key
      best = other
    }
  }
  return best
}

/**
 * The replacement rule — what to say about a dish the user pinched, given the
 * check result. Pure; tests call it directly.
 *   unverified → "Ingredients not published." / "Ask the restaurant before ordering."
 *   contains, lead = matched ingredient with the largest known share:
 *     share unknown → "Contains X." / "Ask the chef whether it can be left out."
 *     share ≤ 10 %  → "Contains X (about 6% of the dish)." / "Ask the chef to leave them out."
 *     share > 10 %  → "X is about 40% of this dish — leaving it out guts the dish; you'd pay
 *                      the same for less." then "Ask for a swap: tofu." or
 *                      "No good swap. Better pick: <nearest safe dish | none on this menu>"
 *   other matches → "Also: …". Typical recipes get "Typically …" + "Confirm with the restaurant."
 */
export function describeChoice(dish: DishDef, result: DishResult, restaurant: RestaurantDef,
    allResults: DishResult[] = []): {headline: string; body: string} {
  if (result.verdict === "unverified") {
    return {headline: "Ingredients not published.", body: "Ask the restaurant before ordering."}
  }
  const typical = result.source === "typical"
  const confirm = typical ? " Confirm with the restaurant." : ""
  if (result.matches.length === 0) {
    return typical
      ? {headline: "Looks fine.", body: "Based on a typical recipe; confirm with the restaurant."}
      : {headline: "Looks fine.", body: "Nothing from your profile."}
  }
  // One entry per ingredient, ordered by known share (largest first; unknown last).
  const byIngredient = new Map<string, IngredientMatch>()
  for (const m of result.matches) if (!byIngredient.has(m.ingredient)) byIngredient.set(m.ingredient, m)
  const ordered = Array.from(byIngredient.values()).sort((a, b) => (shareOf(dish, b.ingredient) ?? -1) - (shareOf(dish, a.ingredient) ?? -1))
  const lead = ordered[0]
  const share = shareOf(dish, lead.ingredient)
  const name = lead.ingredient
  let headline: string
  let body: string
  if (share === null) {
    headline = `${typical ? "Typically contains" : "Contains"} ${name}.`
    body = "Ask the chef whether it can be left out."
  } else if (share <= SHARE_THRESHOLD_PCT) {
    headline = `${typical ? "Typically contains" : "Contains"} ${name} (about ${Math.round(share)}% of the dish).`
    body = "Ask the chef to leave them out."
  } else {
    headline = `${typical ? "Typically, " + name : capitalize(name)} is about ${Math.round(share)}% of this dish — leaving it out guts the dish; you'd pay the same for less.`
    const swap = dish.substitutes ? dish.substitutes[name] : undefined
    if (typeof swap === "string" && swap.length > 0) {
      body = `Ask for a swap: ${swap}.`
    } else {
      const alt = nearestSafeDish(dish, restaurant, allResults)
      body = `No good swap. Better pick: ${alt ? alt.name : "none on this menu"}`
    }
  }
  if (ordered.length > 1) {
    const rest = ordered.slice(1).map((m) => {
      const s = shareOf(dish, m.ingredient)
      return s === null ? m.ingredient : `${m.ingredient} (${Math.round(s)}%)`
    })
    body += `\nAlso: ${rest.join(", ")}.`
  }
  body += confirm
  return {headline, body}
}

/** "No beef" -> "beef", "Avoid trans fat" -> "trans fat", "Vegetarian" -> "meat". */
function substanceName(m: IngredientMatch): string {
  if (m.allergenId === "meat") return "meat"
  return m.allergenLabel.replace(/^(No|Avoid)\s+/i, "").toLowerCase()
}

/**
 * Text for the detail card:
 *   "Contains peanuts (peanut butter)." + "Can't be removed."
 *   "Contains peanuts." + "Can be left out: ask your server."
 *   "Typically contains peanuts (peanut sauce)." + "Confirm with the restaurant."   (typical recipe)
 *   "Looks fine." + "Based on a typical recipe; confirm with the restaurant."       (typical recipe, safe)
 *   "Ingredients not published." + "Ask the restaurant before ordering."
 */
export function describeResult(result: DishResult): {headline: string; body: string} {
  if (result.verdict === "unverified") {
    return {headline: "Ingredients not published.", body: "Ask the restaurant before ordering."}
  }
  const typical = result.source === "typical"
  if (result.matches.length === 0) {
    return typical
      ? {headline: "Looks fine.", body: "Based on a typical recipe; confirm with the restaurant."}
      : {headline: "Looks fine.", body: "Nothing from your profile."}
  }
  const first = result.matches[0]
  const what = substanceName(first)
  const verb = typical ? "Typically contains" : "Contains"
  const headline = what === first.ingredient ? `${verb} ${what}.` : `${verb} ${what} (${first.ingredient}).`
  let body = typical
    ? "Confirm with the restaurant."
    : first.removable ? "Can be left out: ask your server." : "Can't be removed."
  const seen = new Set<string>([first.ingredient])
  const rest: string[] = []
  for (const m of result.matches.slice(1)) {
    if (seen.has(m.ingredient)) continue
    seen.add(m.ingredient)
    rest.push(`${m.ingredient}${m.removable ? " (removable)" : ""}`)
  }
  if (rest.length > 0) body += `\nAlso: ${rest.join(", ")}.`
  return {headline, body}
}

// ── Packaged products (Open Food Facts) ─────────────────────────────────────
export interface ProductMatch {
  allergenId: string
  allergenLabel: string
  /** From the label's own allergen statement (true) or from reading the ingredient list (false). */
  declared: boolean
  /** The tag or ingredient that matched. */
  via: string
}

export interface ProductResult {
  barcode: string
  verdict: DishVerdict
  matches: ProductMatch[]
  /** "May contain" allergens from the profile (labels). */
  traces: string[]
  /** Fitness flags from the profile that the label trips, e.g. "high sugar (18 g per 100 g)". */
  fitness: string[]
}

/** Open Food Facts allergen tags → allergen ids (the rest fall back to alias matching). */
const OFF_TAGS: {[tag: string]: string} = {
  "peanuts": "peanut", "peanut": "peanut",
  "soybeans": "soy", "soy": "soy", "soya": "soy",
  "milk": "milk", "eggs": "egg", "egg": "egg",
  "gluten": "wheat", "wheat": "wheat",
  "nuts": "tree_nut", "tree-nuts": "tree_nut",
  "sesame-seeds": "sesame", "sesame": "sesame",
  "fish": "fish", "crustaceans": "shellfish", "molluscs": "shellfish", "shellfish": "shellfish",
}

function tagToAllergen(tag: string, allergens: AllergenDef[]): AllergenDef | null {
  const clean = tag.toLowerCase().replace(/^[a-z]{2}:/, "").trim()
  const mapped = OFF_TAGS[clean]
  if (mapped) return allergens.find((a) => a.id === mapped) ?? null
  const words = clean.replace(/-/g, " ")
  return allergens.find((a) => ingredientMatches(words, a)) ?? null
}

/**
 * A packaged product against the profile. The label's own allergen statement wins; the
 * ingredient list is read with the same aliases as dishes; "may contain" from the profile
 * makes the product amber (never safe); fitness flags count as "contains" for a profile
 * that avoids trans fat or high sugar. No ingredient list and no statement → unverified.
 */
export function checkProduct(product: ProductDef, profile: Profile, allergens: AllergenDef[] = ALLERGENS): ProductResult {
  const active = allergens.filter((a) => profile.has(a.id))
  const matches: ProductMatch[] = []
  const seen = new Set<string>()
  const add = (a: AllergenDef, declared: boolean, via: string) => {
    if (seen.has(a.id)) return
    seen.add(a.id)
    matches.push({allergenId: a.id, allergenLabel: a.label, declared, via})
  }
  for (const tag of product.allergens) {
    const a = tagToAllergen(tag, active)
    if (a) add(a, true, tag)
  }
  // Diet flags (trans fat, high sugar) come from the nutrition numbers below, not from
  // the word "sugar" in an ingredient list — every cookie would be flagged otherwise.
  const byIngredient = active.filter((a) => a.group !== "diet")
  for (const ing of product.ingredients ?? []) {
    for (const a of byIngredient) if (ingredientMatches(ing, a)) add(a, false, ing)
  }
  const traces: string[] = []
  for (const tag of product.traces) {
    const a = tagToAllergen(tag, active)
    if (a && !seen.has(a.id) && traces.indexOf(a.label) < 0) traces.push(a.label)
  }
  const fitness: string[] = []
  const n = product.nutrition
  if (profile.has("trans_fat") && product.fitness.transFat) fitness.push(`trans fat${n.trans_fat_g !== null ? ` (${n.trans_fat_g} g per 100 g)` : ""}`)
  if (profile.has("high_sugar") && product.fitness.highSugar) fitness.push(`high sugar${n.sugar_g !== null ? ` (${n.sugar_g} g per 100 g)` : ""}`)
  const known = (product.ingredients !== null && product.ingredients.length > 0) || product.allergens.length > 0
  let verdict: DishVerdict
  if (matches.length > 0 || fitness.length > 0) verdict = "contains"
  else if (!known || traces.length > 0) verdict = "unverified"
  else verdict = "safe"
  return {barcode: product.barcode, verdict, matches, traces, fitness}
}

/** One-line chip text for a product, e.g. "contains peanuts, soy" / "may contain milk" / "safe for you". */
export function productChipText(result: ProductResult): string {
  if (result.verdict === "contains") {
    const parts = result.matches.map((m) => m.allergenLabel.toLowerCase()).concat(result.fitness.map((f) => f.replace(/ \(.*\)$/, "")))
    return `contains ${parts.join(", ")}`
  }
  if (result.verdict === "unverified") return result.traces.length > 0 ? `may contain ${result.traces.join(", ").toLowerCase()}` : "ingredients not listed"
  return "safe for you"
}

/** Detail card wording for a product (headline + body). */
export function describeProduct(product: ProductDef, result: ProductResult): {headline: string; body: string} {
  const lines: string[] = []
  if (result.verdict === "contains") {
    const declared = result.matches.filter((m) => m.declared).map((m) => m.allergenLabel.toLowerCase())
    const read = result.matches.filter((m) => !m.declared).map((m) => `${m.allergenLabel.toLowerCase()} (${m.via})`)
    const head = declared.length > 0
      ? `Contains ${declared.join(", ")} — declared on the label.`
      : `Contains ${read.join(", ")}.`
    if (declared.length > 0 && read.length > 0) lines.push(`Also in the ingredients: ${read.join(", ")}.`)
    if (result.fitness.length > 0) lines.push(`${capitalize(result.fitness.join("; "))}.`)
    if (result.traces.length > 0) lines.push(`May contain: ${result.traces.join(", ").toLowerCase()}.`)
    lines.push("Put it back; pick one without it.")
    return {headline: head, body: lines.join("\n")}
  }
  if (result.verdict === "unverified") {
    if (result.traces.length > 0) {
      return {headline: `May contain ${result.traces.join(", ").toLowerCase()}.`, body: "The label says it is made where that is handled. Your call."}
    }
    return {headline: "No ingredient list for this product.", body: "Read the label before buying."}
  }
  return {headline: "Looks fine.", body: "Nothing from your profile on the label."}
}

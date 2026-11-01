// AllergyLensChecker — pure logic. Owns: the profile set (which allergen ids the user
// flagged) and the alias-based check that turns a dish + profile into one of three
// states: "safe" (ingredients known, nothing matched), "contains" (>=1 ingredient
// contains an alias of a flagged allergen), "unverified" (ingredients unknown — never
// safe). Expects no @inputs. Must not touch the scene; Main pushes results into the UI.

import {ALLERGENS, AllergenDef, DishDef, IngredientsSource, RestaurantDef} from "./AllergyLensMenuData"

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

/** True when the (lowercase) ingredient contains any alias of the allergen. */
export function ingredientMatches(ingredient: string, allergen: AllergenDef): boolean {
  const low = ingredient.toLowerCase()
  for (const alias of allergen.aliases) {
    if (alias && low.indexOf(alias.toLowerCase()) >= 0) return true
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
  for (const ing of dish.ingredients) {
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

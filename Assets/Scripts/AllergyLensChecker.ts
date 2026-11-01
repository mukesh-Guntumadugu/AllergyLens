// AllergyLensChecker — pure logic. Owns: the profile set (what the user flagged)
// and the check that turns a dish + profile into "safe" or "flagged + why".
// Expects no @inputs. Must not touch the scene; Main pushes results into the UI.

import {Dish, Ingredient} from "./AllergyLensMenuData"

export type DishVerdict = "none" | "safe" | "flagged"

export interface DishResult {
  dishId: string
  verdict: DishVerdict
  /** Ingredients that matched the profile, in dish order. Empty when safe. */
  matches: Ingredient[]
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

export function checkDish(dish: Dish, profile: Profile): DishResult {
  const matches = dish.ingredients.filter((ing) => profile.has(ing.id))
  return {dishId: dish.id, verdict: matches.length > 0 ? "flagged" : "safe", matches}
}

export function checkMenu(dishes: Dish[], profile: Profile): DishResult[] {
  return dishes.map((d) => checkDish(d, profile))
}

/**
 * Text for the detail card. Leads with the first matched ingredient; lists the
 * others briefly. Mirrors the brief's wording:
 *   "Contains peanuts. Can be left out: ask your server."
 *   "Contains peanuts. Can't be removed (peanut butter)."
 */
export function describeResult(result: DishResult): {headline: string; body: string} {
  if (result.matches.length === 0) {
    return {headline: "Looks fine", body: "Nothing from your profile."}
  }
  const first = result.matches[0]
  const headline = `Contains ${first.name}.`
  let body = first.canLeaveOut
    ? "Can be left out: ask your server."
    : `Can't be removed${first.note ? ` (${first.note})` : ""}.`
  if (result.matches.length > 1) {
    const rest = result.matches.slice(1).map((m) => m.name).join(", ")
    body += `\nAlso: ${rest}.`
  }
  return {headline, body}
}

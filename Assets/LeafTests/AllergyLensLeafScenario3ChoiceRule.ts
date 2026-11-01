// choice-rule: the replacement rule as a pure function (no scene interaction).
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {RESTAURANTS, DishDef, RestaurantDef} from "../Data/AllergyData"
import {Profile, checkDish, checkMenu, describeChoice} from "../Scripts/AllergyLensChecker"

@component
export class AllergyLensLeafScenario3ChoiceRule extends Scenario {
  async run(): Promise<void> {
    const star = RESTAURANTS.find((r) => r.id === "star-of-india")!

    // 1. Paneer Shai Kurma with {milk}: paneer is 40% → "guts the dish" + swap tofu; typical wording.
    const milk = new Profile()
    milk.set("milk", true)
    const kurma = star.dishes.find((d) => d.id === "paneer-sha-kurma")!
    const kurmaResults = checkMenu(star.dishes, milk)
    const t1 = describeChoice(kurma, checkDish(kurma, milk), star, kurmaResults)
    const s1 = `${t1.headline} ${t1.body}`
    expect(s1.includes("40%"), s1).toBe(true)
    expect(s1.includes("tofu"), s1).toBe(true)
    expect(s1.includes("Typically"), s1).toBe(true)
    expect(s1.includes("Confirm with the restaurant"), s1).toBe(true)

    // 2. Butter-chicken-style dish, cashews at 4% with {tree_nut} → ask to leave them out.
    const nuts = new Profile()
    nuts.set("tree_nut", true)
    const butterChicken: DishDef = {
      id: "test-butter-chicken", name: "Butter Chicken", icon: null,
      ingredients: ["chicken", "butter", "cream", "tomato", "cashews"], ingredientsSource: "restaurant",
      removable: [], shares: {chicken: 50, butter: 10, cream: 20, tomato: 16, cashews: 4}, substitutes: {},
      layout: null,
    }
    const t2 = describeChoice(butterChicken, checkDish(butterChicken, nuts), star, [])
    const s2 = `${t2.headline} ${t2.body}`
    expect(s2.includes("Contains cashews (about 4% of the dish)"), s2).toBe(true)
    expect(s2.includes("leave them out"), s2).toBe(true)

    // 3. >10% allergen with no substitute → "Better pick:" with the nearest safe neighbour
    //    in the same column. Under a peanut-only profile Paneer Shai Kurma (y 0.52) is safe
    //    and closer to y 0.60 than Alu Choley (0.73) or Alu Gobi (0.28).
    const peanut = new Profile()
    peanut.set("peanut", true)
    const peanutDal: DishDef = {
      id: "test-peanut-dal", name: "Peanut Dal", icon: null,
      ingredients: ["lentils", "peanuts", "onion"], ingredientsSource: "restaurant",
      removable: [], shares: {lentils: 60, peanuts: 30, onion: 10}, substitutes: {peanuts: null},
      layout: {x: 0.01, y: 0.6, w: 0.08, h: 0.015},
    }
    const menuWithDal: RestaurantDef = {...star, dishes: star.dishes.concat([peanutDal])}
    const dalResults = checkMenu(menuWithDal.dishes, peanut)
    const t3 = describeChoice(peanutDal, checkDish(peanutDal, peanut), menuWithDal, dalResults)
    const s3 = `${t3.headline} ${t3.body}`
    expect(s3.includes("about 30% of this dish"), s3).toBe(true)
    expect(s3.includes("Better pick: Paneer Shai Kurma"), s3).toBe(true)

    // 4. Unverified wording.
    const curry = star.dishes.find((d) => d.id === "curry")!
    const t4 = describeChoice(curry, checkDish(curry, milk), star, kurmaResults)
    expect(t4.headline, t4.headline).toBe("Ingredients not published.")
    expect(t4.body.includes("Ask the restaurant"), t4.body).toBe(true)
  }
}

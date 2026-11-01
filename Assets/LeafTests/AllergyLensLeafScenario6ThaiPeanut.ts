// Data-driven: Thai Basil Kitchen with a peanut profile — Pad Thai and Fresh Spring
// Rolls (peanut sauce) red, Chef's Special (ingredients not published) amber, the rest
// green.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, collectTexts, requireByName} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario6ThaiPeanut extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepare("Thai Basil Kitchen", ["peanut"])
    expect(ui.currentRestaurantName(), "card title").toBe("Thai Basil Kitchen")
    // Badge: 3 of 6 safe, 1 unverified, 2 allergy complaints → "caution".
    const badge = ui.currentBadge()
    expect(badge.level, `thai-basil badge: ${badge.text}`).toBe("caution")
    expect(badge.text.includes("3 of 6 safe"), `badge text: ${badge.text}`).toBe(true)
    expect(badge.text.includes("2 reviews mention allergies"), `badge text: ${badge.text}`).toBe(true)
    await ui.scan()
    ui.expectRed("pad-thai")
    ui.expectRed("spring-rolls")
    ui.expectAmber("chef-special")
    for (const id of ["green-curry", "tom-yum", "mango-rice"]) ui.expectGreen(id)

    // An unverified dish opens the "ask the restaurant" card.
    await ui.tap("Dish-chef-special")
    expect(ui.isVisible("DishDetail"), "detail card open for unverified dish").toBe(true)
    const joined = ui.detailTexts().join(" | ")
    expect(joined.includes("Ingredients not published"), `unverified headline: ${joined}`).toBe(true)
    expect(joined.includes("Ask the restaurant"), `unverified body: ${joined}`).toBe(true)
    await ui.tap("Dish-chef-special")
    expect(ui.isVisible("DishDetail"), "detail card closed").toBe(false)

    // Spring rolls come from a typical recipe: wording says so, name carries the "~" marker.
    await ui.tap("Dish-spring-rolls")
    const typical = ui.detailTexts().join(" | ")
    expect(typical.includes("Typically contains peanuts (peanut sauce)"), `typical headline: ${typical}`).toBe(true)
    expect(typical.includes("Confirm with the restaurant"), `typical body: ${typical}`).toBe(true)
    const tileTexts = collectTexts(requireByName("Dish-spring-rolls")).join(" | ")
    expect(tileTexts.includes("~ Fresh Spring Rolls"), `tile name: ${tileTexts}`).toBe(true)
    await ui.tap("Dish-spring-rolls")
  }
}

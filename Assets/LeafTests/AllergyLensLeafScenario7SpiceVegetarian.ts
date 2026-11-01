// Data-driven: Spice Route Indian with "Vegetarian" (meat) toggled — Butter Chicken,
// Lamb Rogan Josh and Beef Vindaloo red; Chana Masala, Garlic Naan, Gulab Jamun green.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario7SpiceVegetarian extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepare("Spice Route Indian", ["meat"])
    expect(ui.currentRestaurantName(), "card title").toBe("Spice Route Indian")
    await ui.scan()
    for (const id of ["butter-chicken", "lamb-rogan", "beef-vindaloo"]) ui.expectRed(id)
    for (const id of ["chana-masala", "garlic-naan", "gulab-jamun"]) ui.expectGreen(id)

    // The card names the substance, not the toggle label.
    await ui.tap("Dish-lamb-rogan")
    const joined = ui.detailTexts().join(" | ")
    expect(joined.includes("Contains meat (lamb)"), `vegetarian detail: ${joined}`).toBe(true)
    await ui.tap("Dish-lamb-rogan")
  }
}

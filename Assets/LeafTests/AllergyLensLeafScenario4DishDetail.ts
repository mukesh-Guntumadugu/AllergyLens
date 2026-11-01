// Done criterion 4: pinching a red dish opens a small card next to it naming the
// ingredient and saying whether it can be left out; pinching again closes it.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, requireByName} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario4DishDetail extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepare("Demo Bistro", ["peanut"])
    await ui.scan()
    ui.expectRed("noodles")

    // Pinch the red dish: card opens, names peanuts, says it can be left out.
    await ui.tap("Dish-noodles")
    expect(ui.isVisible("DishDetail"), "detail card open after pinching red dish").toBe(true)
    const joined = ui.detailTexts().join(" | ")
    expect(joined.includes("Contains peanuts"), `card names the ingredient: ${joined}`).toBe(true)
    expect(joined.includes("Can be left out"), `card says it can be left out: ${joined}`).toBe(true)

    // The card sits next to the dish: within 20 cm of the tile, not on top of it.
    const tilePos = requireByName("Dish-noodles").getTransform().getWorldPosition()
    const cardPos = requireByName("DishDetail").getTransform().getWorldPosition()
    const dist = tilePos.distance(cardPos)
    expect(dist, `card distance from dish (cm): ${dist.toFixed(1)}`).toBeGreaterThan(6)
    expect(dist, `card distance from dish (cm): ${dist.toFixed(1)}`).toBeLessThan(25)

    // Pinch again: closes.
    await ui.tap("Dish-noodles")
    expect(ui.isVisible("DishDetail"), "detail card closed after second pinch").toBe(false)

    // A dish whose ingredient can't be removed says so; the X button also closes it.
    await ui.tap("Dish-cheesecake")
    expect(ui.isVisible("DishDetail"), "detail card open for cheesecake").toBe(true)
    const joined2 = ui.detailTexts().join(" | ")
    expect(joined2.includes("Can't be removed"), `cheesecake card: ${joined2}`).toBe(true)
    await ui.tap("CloseButton")
    expect(ui.isVisible("DishDetail"), "detail card closed via X").toBe(false)
  }
}

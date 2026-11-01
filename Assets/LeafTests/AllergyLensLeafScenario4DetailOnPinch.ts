// detail-on-pinch: with {milk}, pinch the Paneer Nan bar → the detail card opens beside
// it with the milk text; pinch again closes it.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, requireByName} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario4DetailOnPinch extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepareProfile(["milk"])
    await ui.simulateMarker("star-of-india")
    ui.expectRed("paneer-nan")

    await ui.tap("Bar-paneer-nan")
    expect(ui.isVisible("DishDetail"), "detail card open after pinching the red bar").toBe(true)
    const joined = ui.detailTexts().join(" | ")
    expect(joined.includes("Contains cheese stuffed nan"), `card names the milk ingredient: ${joined}`).toBe(true)
    expect(joined.includes("Ask the chef whether it can be left out"), `unknown share wording: ${joined}`).toBe(true)

    // Beside the bar: within ~20 cm of it, and under the marker so it moves with the page.
    const barPos = requireByName("Bar-paneer-nan").getTransform().getWorldPosition()
    const card = requireByName("DishDetail")
    const dist = card.getTransform().getWorldPosition().distance(barPos)
    expect(dist, `card distance from bar (cm): ${dist.toFixed(1)}`).toBeGreaterThan(4)
    expect(dist, `card distance from bar (cm): ${dist.toFixed(1)}`).toBeLessThan(25)
    expect(card.getParent()?.name, "card parented to the marker").toBe("MenuMarker")

    await ui.tap("Bar-paneer-nan")
    expect(ui.isVisible("DishDetail"), "detail card closed after second pinch").toBe(false)
  }
}

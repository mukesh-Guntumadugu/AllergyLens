// mood-vegetarian with profile {milk}: only vegetarian-category dishes get marks —
// GOBI NAN safe → green full line + star, PANEER NAN contains milk → red underline + dot;
// CHICKEN NAN and the drinks get nothing; badge text names the category.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, LAUREL} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario6MoodVegetarian extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepareProfile(["milk"], "vegetarian")
    await ui.simulateMarker("laurel-cafe")

    ui.expectGreenStar("gobi-nan")
    ui.expectGreenStar("alu-gobi")
    ui.expectRed("paneer-nan")
    for (const id of ["chicken-nan", "iced-tea", "milk", "sweet-lassi", "mango-lassi", "kulfi", "gulab-jamun"]) ui.expectUnmarked(id)
    // Nothing outside the category is marked.
    for (const d of LAUREL.dishes) {
      if (!d.layout) continue
      if (d.category !== "vegetarian") ui.expectUnmarked(d.id)
    }
    const badge = ui.badge()
    expect(badge.text.toLowerCase().includes("veg dish"), badge.text).toBe(true)
    expect(badge.text.includes("safe for you"), badge.text).toBe(true)
  }
}

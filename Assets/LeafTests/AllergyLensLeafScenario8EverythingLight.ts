// everything-mode-light with profile {milk}: red lines get an underline + dot, safe
// lines only a dot, and no full-width green quad exists anywhere on the page.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, LAUREL} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario8EverythingLight extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepareProfile(["milk"], "everything")
    await ui.simulateMarker("laurel-cafe")
    ui.expectRed("paneer-nan")
    ui.expectRed("kheer")
    ui.expectGreenDot("gobi-nan")
    ui.expectGreenDot("iced-tea")
    const unpublished = LAUREL.dishes.find((d) => d.layout && d.ingredientsSource === "none")
    expect(!!unpublished, "data has an unpublished dish").toBe(true)
    ui.expectAmber(unpublished!.id)
    let fullQuads = 0
    let stars = 0
    ui.forEachShownBar((id, b) => {
      if (b.full) fullQuads++
      if (b.star) stars++
    })
    expect(fullQuads, "no full-width quads in Everything mode").toBe(0)
    expect(stars, "no stars in Everything mode").toBe(0)
  }
}

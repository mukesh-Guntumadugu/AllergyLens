// mood-chicken with profile {peanut}: only CHICKEN NAN is marked (green star); the
// arrow chip appears when the chicken line is outside the display band (page shifted
// 30 cm to the left) and disappears when the page is centred again.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, STAR} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario7MoodChicken extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepareProfile(["peanut"], "chicken")

    // Page centred: the chicken line is inside the band → marked, no arrow.
    await ui.simulateMarker("star-of-india", 0)
    ui.expectGreenStar("chicken-nan")
    for (const d of STAR.dishes) if (d.layout && d.id !== "chicken-nan") ui.expectUnmarked(d.id)
    await sleep(400)
    expect(ui.arrow().visible, `arrow with chicken in view: ${ui.arrow().label}`).toBe(false)

    // Page pushed 30 cm to the left: the chicken line leaves the band → "← Chicken" chip.
    await ui.simulateMarker("star-of-india", -30)
    await sleep(600)
    const a = ui.arrow()
    expect(a.visible, "arrow chip when the chicken line is outside the band").toBe(true)
    expect(a.label.includes("Chicken"), a.label).toBe(true)
    expect(a.label.startsWith("←"), `points toward the line: ${a.label}`).toBe(true)

    // Back in view → chip gone.
    await ui.simulateMarker("star-of-india", 0)
    await sleep(600)
    expect(ui.arrow().visible, "arrow hidden once the line is in view").toBe(false)
  }
}

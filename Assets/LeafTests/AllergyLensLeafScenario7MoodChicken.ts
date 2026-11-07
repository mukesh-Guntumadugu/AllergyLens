// mood-chicken with profile {peanut}: only the chicken-category dishes are marked (green star
// when safe); every other line is unmarked. The arrow chip appears when the marked lines are
// outside the display band (page shifted 30 cm to the left) and disappears when the page is
// centred again.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {dishCategory} from "../Scripts/AllergyLensMenuData"
import {AllergyLensLeafInteractor, LAUREL} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario7MoodChicken extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepareProfile(["peanut"], "chicken")

    const chicken = LAUREL.dishes.filter((d) => d.layout && dishCategory(d) === "chicken")
    expect(chicken.length, "the page has chicken dishes").toBeGreaterThan(0)

    // Page centred: chicken lines marked (a printed list without peanut → green star), the rest unmarked.
    await ui.simulateMarker("laurel-cafe", 0)
    for (const d of chicken) {
      if (d.ingredientsSource === "restaurant") ui.expectGreenStar(d.id)
    }
    for (const d of LAUREL.dishes) if (d.layout && dishCategory(d) !== "chicken") ui.expectUnmarked(d.id)
    await sleep(400)
    expect(ui.arrow().visible, `arrow with chicken in view: ${ui.arrow().label}`).toBe(false)

    // Page pushed 30 cm to the left: marked lines leave the band → "← Chicken…" chip.
    await ui.simulateMarker("laurel-cafe", -30)
    await sleep(600)
    const a = ui.arrow()
    expect(a.visible, "arrow chip when the chicken lines are outside the band").toBe(true)
    expect(a.label.includes("Chicken"), a.label).toBe(true)
    expect(a.label.startsWith("←"), `points toward the line: ${a.label}`).toBe(true)

    // Back in view → chip gone.
    await ui.simulateMarker("laurel-cafe", 0)
    await sleep(600)
    expect(ui.arrow().visible, "arrow hidden once the line is in view").toBe(false)
  }
}

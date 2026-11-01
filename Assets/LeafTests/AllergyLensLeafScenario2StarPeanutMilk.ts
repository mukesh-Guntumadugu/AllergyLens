// star-peanut-milk: profile {peanut, milk}, simulated recognition of the Star of India
// page → one bar per dish with a layout; milk dishes red, dairy-free dishes green,
// dishes without published ingredients amber; badge level + text.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, STAR} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario2StarPeanutMilk extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepareProfile(["peanut", "milk"])
    await ui.simulateMarker("star-of-india")

    // Every dish with a layout box has a bar; dishes without one have none.
    for (const d of STAR.dishes) {
      const b = ui.bar(d.id)
      expect(b.exists, `bar for ${d.id} (layout ${d.layout ? "yes" : "no"})`).toBe(!!d.layout)
      if (d.layout) expect(b.shown, `bar for ${d.id} shown`).toBe(true)
    }
    for (const id of ["paneer-nan", "autter-paneer", "gulab-jamun", "kheer", "kulfi", "sweet-lassi", "mango-lassi"]) ui.expectRed(id)
    for (const id of ["alu-gobi", "alu-choley"]) ui.expectGreen(id)
    // In the current data channa-masala has ingredientsSource "none" → amber, never safe.
    for (const id of ["curry", "channa-masala"]) ui.expectAmber(id)

    const badge = ui.badge()
    expect(badge.level, `badge: ${badge.text}`).toBe("caution")
    expect(badge.text.includes("Star of India"), badge.text).toBe(true)
    expect(badge.text.includes("of 31 safe"), badge.text).toBe(true)
    expect(badge.text.includes("★4.5"), badge.text).toBe(true)
    expect(badge.text.includes("1 review mentions allergies"), badge.text).toBe(true)
  }
}

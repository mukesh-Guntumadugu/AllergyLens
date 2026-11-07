// peanut-milk: profile {peanut, milk}, simulated recognition of the Laurel Café page.
// page → one bar per dish with a layout; milk dishes red, dairy-free dishes green,
// dishes without published ingredients amber; badge level + text.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, LAUREL} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario2StarPeanutMilk extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepareProfile(["peanut", "milk"])
    await ui.simulateMarker("laurel-cafe")

    // Every dish with a layout box has a (marked) bar; dishes without one have none.
    for (const d of LAUREL.dishes) {
      const b = ui.bar(d.id)
      expect(b.exists, `bar for ${d.id} (layout ${d.layout ? "yes" : "no"})`).toBe(!!d.layout)
      if (d.layout) expect(b.shown, `bar for ${d.id} marked in Everything mode`).toBe(true)
    }
    // Printed milk (croissant: cheddar; french toast: milk; granola: yogurt) and a typical one (cappuccino) are red.
    for (const id of ["egg-bacon-croissant", "french-toast", "granola-bowl", "cappuccino"]) ui.expectRed(id)
    // Printed lists without milk or peanut are green.
    for (const id of ["grilled-chicken-sandwich", "full-breakfast"]) ui.expectGreenDot(id)
    // Every dish whose ingredients are not published is amber, never safe — whichever they are in this data build.
    let unverified = 0
    for (const d of LAUREL.dishes) {
      if (d.layout && d.ingredientsSource === "none") {
        ui.expectAmber(d.id)
        unverified++
      }
    }
    expect(unverified, "the data has at least one unpublished dish to check").toBeGreaterThan(0)

    const badge = ui.badge()
    expect(badge.level, `badge: ${badge.text}`).toBe("caution")
    expect(badge.text.includes("Laurel"), badge.text).toBe(true)
    expect(badge.text.includes(`of ${LAUREL.dishes.length} safe`), badge.text).toBe(true)
  }
}

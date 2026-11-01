// Done criterion 1: at start a profile panel is in front of the user with pinchable
// toggles for at least peanuts, milk, beef and pork; pinching Done hides it and shows
// the menu on the table.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {findInteractablesByName} from "Leaf.lspkg/Interactors/InteractableUtils"
import {AllergyLensLeafInteractor} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario1Profile extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(1000)
    await ui.ensureProfileOpen()
    expect(ui.isVisible("ProfilePanel"), "profile panel visible").toBe(true)
    for (const id of ["peanuts", "milk", "beef", "pork"]) {
      const hits = findInteractablesByName(`Toggle-${id}`, undefined, true)
      expect(hits.length, `Toggle-${id} is a pinchable interactable`).toBeGreaterThan(0)
    }
    await ui.done()
    expect(ui.isVisible("ProfilePanel"), "profile panel hidden after Done").toBe(false)
    expect(ui.isVisible("MenuCard"), "menu card shown after Done").toBe(true)
    expect(ui.isVisible("ScanBar"), "scan button shown after Done").toBe(true)
  }
}

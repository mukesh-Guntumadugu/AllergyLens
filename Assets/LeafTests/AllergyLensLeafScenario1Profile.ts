// Done criterion 1: at start a profile panel is in front of the user with pinchable
// toggles for at least peanut, milk, beef and pork; pinching Done hides it; the small
// Profile button stays available to reopen it.
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
    for (const id of ["peanut", "milk", "beef", "pork"]) {
      const hits = findInteractablesByName(`Toggle-${id}`, undefined, true)
      expect(hits.length, `Toggle-${id} is a pinchable interactable`).toBeGreaterThan(0)
    }
    await ui.done()
    expect(ui.isVisible("ProfilePanel"), "profile panel hidden after Done").toBe(false)
    expect(findInteractablesByName("ProfileButton", undefined, true).length, "Profile button available (no menu in view)").toBeGreaterThan(0)
    // While a menu is in view nothing else is drawn: button gone, panel stays closed.
    await ui.simulateMarker("star-of-india")
    expect(ui.isVisible("ProfileButton"), "Profile button hidden while a menu is recognised").toBe(false)
    expect(ui.isVisible("ProfilePanel"), "profile panel stays closed").toBe(false)
  }
}

// marker-lost: after simulateMarkerLost() the bars hide within 1.5 s.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario5MarkerLost extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.isolateFromCamera()
    if (ui.isVisible("ProfilePanel")) await ui.done()
    await ui.simulateMarker("laurel-cafe")
    expect(ui.bar("egg-bacon-croissant").shown, "bars shown while tracked").toBe(true)
    await ui.simulateMarkerLost()
    await sleep(1500)
    expect(ui.bar("egg-bacon-croissant").shown, "marks hidden within 1.5 s of losing the marker").toBe(false)
    expect(ui.isVisible("Badge"), "badge hidden too").toBe(false)
    expect(ui.isVisible("ProfileButton"), "Profile button back after the marker is gone").toBe(true)
  }
}

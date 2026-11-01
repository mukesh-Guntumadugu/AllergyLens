// Reachability: a simulated full-arm (IK) user must be able to physically reach and
// pinch the big Scan button lying on the table. A trigger that fails to converge is a
// real placement finding, not a test bug.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {findInteractableByName} from "Leaf.lspkg/Interactors/InteractableUtils"
import {createIKInteractor} from "Leaf.lspkg/Interactors/interactor/ik/visualizer/BitmojiAvatar"
import {AllergyLensLeafInteractor} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenarioIKReach extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepare("Demo Bistro", ["peanut"])
    const ik = createIKInteractor()
    const scan = findInteractableByName("ScanButton")
    await ik.trigger(scan)
    await sleep(600)
    ui.expectRed("noodles")
    expect(ui.isVisible("MenuCard"), "menu still visible after IK scan").toBe(true)
  }
}

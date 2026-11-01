// Done criterion 3: with "I don't eat beef" toggled on instead, rescanning turns the
// beef dish red and the peanut dishes green.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario3BeefRescan extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.ensureProfileOpen()
    await ui.setProfile(["beef"])
    await ui.done()
    await ui.scan()
    ui.expectRed("burger")
    ui.expectGreen("noodles")
    ui.expectGreen("cheesecake")
    for (const id of ["salmon", "pizza", "ricebowl"]) ui.expectGreen(id)
  }
}

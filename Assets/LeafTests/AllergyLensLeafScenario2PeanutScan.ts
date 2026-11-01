// Done criterion 2: with peanuts toggled on, pinching Scan menu turns the two peanut
// dishes light red and the other dishes transparent light green, on the menu.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario2PeanutScan extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.ensureProfileOpen()
    await ui.setProfile(["peanuts"])
    await ui.done()
    await ui.scan()
    ui.expectRed("noodles")
    ui.expectRed("cheesecake")
    for (const id of ["burger", "salmon", "pizza", "ricebowl"]) ui.expectGreen(id)
  }
}

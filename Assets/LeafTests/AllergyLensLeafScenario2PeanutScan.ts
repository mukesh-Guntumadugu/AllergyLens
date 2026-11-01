// Done criterion 2: with peanuts toggled on, pinching Scan menu turns the two peanut
// dishes light red and the other dishes transparent light green, on the menu.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario2PeanutScan extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    await ui.prepare("Demo Bistro", ["peanut"])
    // Badge before scanning: 4 of 6 safe (>= half), 0 unverified, 0 complaints → "good".
    const badge = ui.currentBadge()
    expect(badge.level, `demo-bistro badge: ${badge.text}`).toBe("good")
    expect(badge.text.includes("4 of 6 safe"), `badge text: ${badge.text}`).toBe(true)
    await ui.scan()
    ui.expectRed("noodles")
    ui.expectRed("cheesecake")
    for (const id of ["burger", "salmon", "pizza", "ricebowl"]) ui.expectGreen(id)
  }
}

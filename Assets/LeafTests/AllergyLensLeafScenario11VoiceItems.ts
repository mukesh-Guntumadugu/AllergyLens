// voice items on the setup screens: a repeated answer counts once ("olive oil olive oil olive
// oil" → olive oil), a specific food is its own chip and never a category tile ("Octopus." →
// Octopus, Shellfish stays off), a spoken list gives one chip each, and More… opens the keyboard.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, collectTexts, mainScript, requireByName} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario11VoiceItems extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(1000)
    await ui.ensureProfileOpen()
    const main = mainScript()
    main.resetProfile()
    if (ui.isVisible("StartButton")) await ui.tap("StartButton")
    await sleep(200)

    main.hearVoice("olive oil olive oil olive oil")
    await sleep(200)
    expect(main.hasProfileItem("custom:olive-oil"), "a repeated answer is one item: olive oil").toBe(true)

    main.hearVoice("Octopus.")
    await sleep(200)
    expect(main.hasProfileItem("custom:octopus"), "octopus is its own item").toBe(true)
    expect(main.hasProfileItem("shellfish"), "octopus does not flip the Shellfish tile").toBe(false)

    main.hearVoice("shellfish")
    await sleep(200)
    expect(main.hasProfileItem("shellfish"), "the category's own name flips its tile").toBe(true)

    main.hearVoice("banana, apple")
    await sleep(300)
    expect(main.hasProfileItem("custom:banana"), "banana from a spoken list").toBe(true)
    expect(main.hasProfileItem("custom:apple"), "apple from a spoken list").toBe(true)
    const shown = collectTexts(requireByName("ProfilePanel")).join(" | ")
    expect(shown.indexOf("Banana") >= 0 && shown.indexOf("Apple") >= 0, `both chips are shown (got ${shown.slice(0, 200)})`).toBe(true)

    expect(ui.isVisible("Keyboard"), "keyboard closed before More").toBe(false)
    await ui.tap("MoreButton")
    await sleep(300)
    expect(ui.isVisible("EditRow"), "More… shows the typing box").toBe(true)
    expect(ui.isVisible("Keyboard"), "More… shows the pinch keyboard").toBe(true)
    await ui.tap("Key-Done")
    await sleep(300)
    expect(ui.isVisible("Keyboard"), "Done closes the keyboard").toBe(false)
    expect(main.hasProfileItem("custom:banana") && main.hasProfileItem("custom:olive-oil"), "Done with the list unchanged keeps every item").toBe(true)
  }
}

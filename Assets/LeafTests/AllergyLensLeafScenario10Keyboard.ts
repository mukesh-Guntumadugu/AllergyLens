// keyboard: pinching the keyboard icon shows the text field and the Lens's own pinch keyboard
// under the panel (the preview cannot draw the SPECS system keyboard); pinching letter keys
// types, Done applies the text as a custom item, and the keyboard goes away again.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {ScenarioConfig} from "Leaf.lspkg/Scenarios/scenario/ScenarioConfig"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {findInteractablesByName} from "Leaf.lspkg/Interactors/InteractableUtils"
import {AllergyLensLeafInteractor, collectTexts, mainScript, requireByName} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario10Keyboard extends Scenario {
  /** keepOpen=true: stop with "mango" typed and the keyboard up, for a look at it in the preview. */
  async run(config?: ScenarioConfig): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(1000)
    await ui.ensureProfileOpen()
    mainScript().resetProfile()
    if (ui.isVisible("StartButton")) await ui.tap("StartButton")
    await sleep(200)
    expect(ui.isVisible("Keyboard"), "keyboard hidden before the icon is pinched").toBe(false)

    await ui.tap("KeyboardButton")
    await sleep(300)
    expect(ui.isVisible("EditRow"), "text field shown below the panel").toBe(true)
    expect(ui.isVisible("Keyboard"), "pinch keyboard shown below the field").toBe(true)
    for (const name of ["Key-q", "Key-p", "Key-a", "Key-l", "Key-z", "Key-m", "Key-space", "Key-,", "Key-Done"]) {
      expect(findInteractablesByName(name, undefined, true).length, `${name} is a pinchable key`).toBeGreaterThan(0)
    }

    for (const ch of "mangoo") await ui.tap(`Key-${ch}`)
    await ui.tap("Key-⌫") // backspace the extra o
    await sleep(200)
    const field = collectTexts(requireByName("EditCustomField")).join(" ")
    expect(field.indexOf("mango") >= 0, `field shows the typed word (got "${field}")`).toBe(true)
    if (config?.get("keepOpen") === "true") return

    await ui.tap("Key-Done")
    await sleep(400)
    expect(mainScript().hasProfileItem("custom:mango"), "Done adds the typed food to the profile").toBe(true)
    expect(ui.isVisible("Keyboard"), "keyboard hidden after Done").toBe(false)
    expect(ui.isVisible("EditRow"), "text field hidden after Done").toBe(false)
    expect(ui.isVisible("ProfilePanel"), "panel still open on the allergies step").toBe(true)

    // Once more: the field opens EMPTY and the next Done adds to the profile instead of replacing it.
    await ui.tap("KeyboardButton")
    await sleep(300)
    const again = collectTexts(requireByName("EditCustomField")).join(" ")
    expect(again.indexOf("mango") < 0, `field is empty when the keyboard opens again (got "${again}")`).toBe(true)
    for (const ch of "kiwi") await ui.tap(`Key-${ch}`)
    await ui.tap("Key-Done")
    await sleep(400)
    expect(mainScript().hasProfileItem("custom:kiwi"), "kiwi added").toBe(true)
    expect(mainScript().hasProfileItem("custom:mango"), "mango still there: Done adds, it does not replace").toBe(true)
  }
}

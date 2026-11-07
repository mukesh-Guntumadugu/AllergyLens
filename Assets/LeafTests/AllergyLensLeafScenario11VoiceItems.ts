// voice items on the setup screens: a repeated answer counts once ("olive oil olive oil olive
// oil" → olive oil), a specific food is its own chip and never a category tile ("Octopus." →
// Octopus, Shellfish stays off), a spoken list gives one chip each, and More… opens the keyboard.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {ScenarioConfig} from "Leaf.lspkg/Scenarios/scenario/ScenarioConfig"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, collectTexts, mainScript, requireByName} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario11VoiceItems extends Scenario {
  /** keepOpen=true: stop with eight chips on screen (four, the pager, More…) for a look at it in the preview. */
  async run(config?: ScenarioConfig): Promise<void> {
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

    // More… sits AFTER the last chip; beyond five chips a pager chip pages through the rest.
    const slotOf = (name: string) => {
      const p = requireByName(name).getTransform().getLocalPosition()
      return {x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10}
    }
    expect(slotOf("MoreButton").x > slotOf("Extra-custom:apple").x || slotOf("MoreButton").y < slotOf("Extra-custom:apple").y, "More… comes after the last chip").toBe(true)
    expect(ui.isVisible("ChipPager"), "no pager with four chips").toBe(false)
    main.hearVoice("cherry, date, fig, grape")
    await sleep(400)
    expect(ui.isVisible("ChipPager"), "eight chips: a pager chip appears").toBe(true)
    expect(ui.isVisible("Extra-custom:grape"), "grape is on the second page, not shown yet").toBe(false)
    expect(collectTexts(requireByName("ChipPager")).join(" ").indexOf("+4 more") >= 0, "pager says how many follow").toBe(true)
    if (config?.get("keepOpen") === "true") return
    await ui.tap("ChipPager")
    await sleep(200)
    expect(ui.isVisible("Extra-custom:grape"), "pinching the pager shows the second page").toBe(true)
    expect(ui.isVisible("Extra-custom:olive-oil"), "first page hidden on the second page").toBe(false)
    expect(ui.isVisible("MoreButton"), "More… stays available while paging").toBe(true)
    await ui.tap("ChipPager")
    await sleep(200)
    expect(ui.isVisible("Extra-custom:olive-oil"), "the pager wraps back to the first page").toBe(true)
    for (const w of ["cherry", "date", "fig", "grape"]) main.hearVoice(`remove ${w}`)
    await sleep(300)

    expect(ui.isVisible("Keyboard"), "keyboard closed before More").toBe(false)
    await ui.tap("MoreButton")
    await sleep(300)
    expect(ui.isVisible("EditRow"), "More… shows the typing box").toBe(true)
    expect(ui.isVisible("Keyboard"), "More… shows the pinch keyboard").toBe(true)
    await ui.tap("Key-Done")
    await sleep(300)
    expect(ui.isVisible("Keyboard"), "Done closes the keyboard").toBe(false)
    expect(main.hasProfileItem("custom:banana") && main.hasProfileItem("custom:olive-oil"), "Done with the list unchanged keeps every item").toBe(true)

    main.hearVoice("Mm. Well, next.")
    await sleep(400)
    expect(main.hasProfileItem("custom:next"), '"next" wrapped in filler is never a food').toBe(false)
    expect(ui.isVisible("NextButton-religious"), '"Mm. Well, next." moves on to the religious screen').toBe(true)
  }
}

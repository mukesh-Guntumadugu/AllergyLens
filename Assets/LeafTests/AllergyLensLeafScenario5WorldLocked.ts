// Done criterion 5 (partial): walking around the table, the menu stays on the table
// at real size and the highlights stay on their dishes. LEAF cannot walk the preview
// camera, so this checks the proxies that make that true: the card is world-locked
// (not parented under the camera, transform stable over time), it is real-size
// (35 x 25 cm backplate), and every highlight is a child of its dish tile.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {AllergyLensLeafInteractor, requireByName, ALL_DISH_IDS} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario5WorldLocked extends Scenario {
  async run(): Promise<void> {
    const ui = new AllergyLensLeafInteractor()
    await sleep(500)
    if (ui.isVisible("ProfilePanel")) await ui.done()
    expect(ui.isVisible("MenuCard"), "menu card visible").toBe(true)

    const card = requireByName("MenuCard")
    // Not head-locked: no Camera component anywhere up the parent chain.
    let p: SceneObject | null = card.getParent()
    while (p) {
      expect(p.getComponent("Component.Camera") === null, `ancestor ${p.name} is not a camera`).toBe(true)
      p = p.getParent()
    }
    // World-locked: the transform does not drift over time.
    const t = card.getTransform()
    const p0 = t.getWorldPosition()
    const r0 = t.getWorldRotation()
    await sleep(1500)
    expect(t.getWorldPosition().distance(p0), "card position drift (cm)").toBeLessThan(0.01)
    expect(Math.abs(t.getWorldRotation().dot(r0)), "card rotation stable").toBeGreaterThan(0.9999)
    // Real size: the UIKit BackPlate is 35 x 25 cm (brief default) and the scale is 1.
    const scale = t.getWorldScale()
    expect(scale.x, "card scale x").toBeCloseTo(1, 2)
    expect(scale.y, "card scale y").toBeCloseTo(1, 2)
    const comps = card.getComponents("Component.ScriptComponent") as ScriptComponent[]
    let size: vec2 | null = null
    for (const c of comps) {
      const anyC = c as unknown as {size?: vec2}
      if (anyC.size && typeof anyC.size.x === "number") size = anyC.size
    }
    expect(size !== null, "card has a sized BackPlate").toBe(true)
    expect(size!.x, "card width cm").toBeCloseTo(35, 1)
    expect(size!.y, "card height cm").toBeCloseTo(25, 1)
    // Highlights move with their dish: each is a direct child of its tile, which is under the card.
    for (const id of ALL_DISH_IDS) {
      const tile = requireByName(`Dish-${id}`)
      let found = false
      for (let i = 0; i < tile.getChildrenCount(); i++) if (tile.getChild(i).name === "Highlight") found = true
      expect(found, `Dish-${id} owns its Highlight`).toBe(true)
      let anc: SceneObject | null = tile.getParent()
      let underCard = false
      while (anc) { if (anc === card) underCard = true; anc = anc.getParent() }
      expect(underCard, `Dish-${id} is under MenuCard`).toBe(true)
    }
  }
}

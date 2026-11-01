// AllergyLensLeafInteractor — shared LEAF helpers for the see-through AllergyLens flow.
// Scenarios run back-to-back against one live Lens, so every helper is state-resilient.
// Marker recognition is driven through Main.simulateMarker so tests never depend on
// the camera.

import {DefaultLeafInteractor} from "Leaf.lspkg/Interactors/interactor/DefaultLeafInteractor"
import {findInteractablesByName} from "Leaf.lspkg/Interactors/InteractableUtils"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {ALLERGENS, RESTAURANTS} from "../Data/AllergyData"

/** Every toggle id, straight from the data module. */
export const ALL_PROFILE_IDS: string[] = ALLERGENS.map((a) => a.id)
export const STAR = RESTAURANTS.find((r) => r.id === "star-of-india")!

/** Depth-first search that INCLUDES disabled objects. */
export function findByName(name: string): SceneObject | null {
  const count = global.scene.getRootObjectsCount()
  for (let i = 0; i < count; i++) {
    const hit = findInSubtree(global.scene.getRootObject(i), name)
    if (hit) return hit
  }
  return null
}

function findInSubtree(so: SceneObject, name: string): SceneObject | null {
  if (so.name === name) return so
  for (let i = 0; i < so.getChildrenCount(); i++) {
    const hit = findInSubtree(so.getChild(i), name)
    if (hit) return hit
  }
  return null
}

export function requireByName(name: string): SceneObject {
  const so = findByName(name)
  if (!so) throw new Error(`SceneObject "${name}" not found`)
  return so
}

export function collectTexts(root: SceneObject, out: string[] = []): string[] {
  const texts = root.getComponents("Component.Text") as Text[]
  for (const t of texts) out.push(t.text)
  for (let i = 0; i < root.getChildrenCount(); i++) collectTexts(root.getChild(i), out)
  return out
}

/** Is this object and every ancestor enabled? */
export function isEffectivelyEnabled(so: SceneObject): boolean {
  let cur: SceneObject | null = so
  while (cur) {
    if (!cur.enabled) return false
    cur = cur.getParent()
  }
  return true
}

interface MainApi {
  simulateMarker(id: string): boolean
  simulateMarkerLost(): void
  setCameraTracking(enabled: boolean): void
  markerActive: boolean
}

export function mainScript(): MainApi {
  const root = requireByName("AllergyLens")
  for (const c of root.getComponents("Component.ScriptComponent") as ScriptComponent[]) {
    const api = c as unknown as MainApi
    if (typeof api.simulateMarker === "function") return api
  }
  throw new Error("AllergyLensMain not found on AllergyLens")
}

export interface BarState {
  exists: boolean
  shown: boolean
  color: vec4 | null
}

export class AllergyLensLeafInteractor extends DefaultLeafInteractor {
  async tap(name: string): Promise<void> {
    const target = findInteractablesByName(name, undefined, true)[0]
    if (!target) throw new Error(`Interactable "${name}" not found or not enabled`)
    await this.trigger(target)
    await sleep(250)
  }

  isVisible(name: string): boolean {
    const so = findByName(name)
    return !!so && isEffectivelyEnabled(so)
  }

  /** Tests drive recognition through simulateMarker only — never the camera. */
  async isolateFromCamera(): Promise<void> {
    const main = mainScript()
    main.setCameraTracking(false)
    if (main.markerActive) {
      // A menu is in view (real or simulated): nothing else is drawn, so drop it first and
      // wait for the Profile button to come back (~1 s after the marker is lost).
      main.simulateMarkerLost()
      await sleep(1400)
    }
  }

  async ensureProfileOpen(): Promise<void> {
    await this.isolateFromCamera()
    if (this.isVisible("ProfilePanel")) return
    await this.tap("ProfileButton")
    await sleep(300)
    if (!this.isVisible("ProfilePanel")) throw new Error("ProfilePanel did not open after ProfileButton")
  }

  getToggleState(id: string): boolean {
    const so = requireByName(`Toggle-${id}`)
    for (const c of so.getComponents("Component.ScriptComponent") as ScriptComponent[]) {
      const anyC = c as unknown as {isOn?: boolean}
      if (typeof anyC.isOn === "boolean") return anyC.isOn
    }
    throw new Error(`No UIKit toggle Button on Toggle-${id}`)
  }

  async setToggle(id: string, on: boolean): Promise<void> {
    if (this.getToggleState(id) === on) return
    await this.tap(`Toggle-${id}`)
    if (this.getToggleState(id) !== on) throw new Error(`Toggle-${id} did not flip to ${on}`)
  }

  /** Make the profile exactly `onIds` (everything else off). Panel must be open. */
  async setProfile(onIds: string[]): Promise<void> {
    for (const id of ALL_PROFILE_IDS) await this.setToggle(id, onIds.indexOf(id) >= 0)
  }

  async done(): Promise<void> {
    await this.tap("DoneButton")
  }

  /** Open profile, set exactly `profileIds`, Done. */
  async prepareProfile(profileIds: string[]): Promise<void> {
    await this.ensureProfileOpen()
    await this.setProfile(profileIds)
    await this.done()
  }

  async simulateMarker(id: string): Promise<void> {
    mainScript().setCameraTracking(false)
    if (!mainScript().simulateMarker(id)) throw new Error(`simulateMarker(${id}) returned false`)
    await sleep(600)
  }

  async simulateMarkerLost(): Promise<void> {
    mainScript().simulateMarkerLost()
  }

  bar(dishId: string): BarState {
    const root = findByName(`Bar-${dishId}`)
    if (!root) return {exists: false, shown: false, color: null}
    let color: vec4 | null = null
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const img = root.getChild(i).getComponent("Component.Image") as Image | null
      if (img) color = img.mainMaterial.mainPass.baseColor
    }
    return {exists: true, shown: isEffectivelyEnabled(root), color}
  }

  private expectTint(dishId: string, name: string, test: (c: vec4) => boolean): void {
    const b = this.bar(dishId)
    if (!b.exists) throw new Error(`Bar-${dishId}: no bar`)
    if (!b.shown || !b.color) throw new Error(`Bar-${dishId}: expected a ${name} bar, none shown`)
    if (!test(b.color)) throw new Error(`Bar-${dishId}: expected ${name}, got ${b.color}`)
  }

  expectGreen(dishId: string): void {
    this.expectTint(dishId, "green", (c) => c.y > c.x && c.w > 0)
  }

  expectRed(dishId: string): void {
    this.expectTint(dishId, "red", (c) => c.x > c.y && c.y < 0.6 && c.w > 0)
  }

  expectAmber(dishId: string): void {
    this.expectTint(dishId, "amber", (c) => c.x >= c.y && c.y >= 0.7 && c.z < c.y && c.w > 0)
  }

  /** Badge as the overlay on MenuMarker reports it. */
  badge(): {level: string; text: string} {
    const marker = requireByName("MenuMarker")
    for (const c of marker.getComponents("Component.ScriptComponent") as ScriptComponent[]) {
      const anyC = c as unknown as {badgeLevel?: string; badgeTextValue?: string}
      if (typeof anyC.badgeLevel === "string") return {level: anyC.badgeLevel, text: anyC.badgeTextValue ?? ""}
    }
    throw new Error("MenuMarker has no overlay badge API")
  }

  detailTexts(): string[] {
    return collectTexts(requireByName("DishDetail"))
  }
}

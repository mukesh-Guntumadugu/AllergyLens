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
export const LAUREL = RESTAURANTS.find((r) => r.id === "laurel-cafe")!

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
  simulateMarker(id: string, offsetXcm?: number): boolean
  simulateMarkerLost(): void
  setCameraTracking(enabled: boolean): void
  markerActive: boolean
  currentMood: string
  setMood(id: string): boolean
  resetProfile(): void
}

interface OverlayApi {
  badgeLevel: string
  badgeTextValue: string
  arrowVisible: boolean
  arrowLabel: string
}

export function overlayScript(): OverlayApi {
  const marker = requireByName("MenuMarker")
  for (const c of marker.getComponents("Component.ScriptComponent") as ScriptComponent[]) {
    const api = c as unknown as OverlayApi
    if (typeof api.badgeLevel === "string") return api
  }
  throw new Error("MenuMarker has no overlay API")
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
  full: boolean
  underline: boolean
  dot: boolean
  star: boolean
  /** tint of whichever mark is shown (dot, else underline, else full) */
  color: vec4 | null
}

export type MoodId = "everything" | "chicken" | "red_meat" | "seafood" | "vegetarian" | "dessert"

const TAP_TIMEOUT_MS = 2500

export class AllergyLensLeafInteractor extends DefaultLeafInteractor {
  /**
   * Pinch an Interactable by SceneObject name. The SIK hover → trigger → release sequence
   * is raced against a timeout: when the tap itself hides the target (Done closes the
   * panel, Profile hides the button) SIK never reports the hover exit and the trigger
   * promise would hang for the scenario's 600 s timeout.
   */
  async tap(name: string): Promise<void> {
    const target = findInteractablesByName(name, undefined, true)[0]
    if (!target) throw new Error(`Interactable "${name}" not found or not enabled`)
    let timedOut = false
    const timeout = sleep(TAP_TIMEOUT_MS).then(() => {
      timedOut = true
    })
    await Promise.race([this.trigger(target), timeout])
    if (timedOut) print(`[LEAF] tap("${name}") did not settle within ${TAP_TIMEOUT_MS} ms; continuing`)
    await sleep(250)
  }

  /** The UIKit Button script on a named SceneObject (duck-typed by its `isOn`). */
  private toggleButton(name: string): {isOn: boolean} {
    const so = requireByName(name)
    for (const c of so.getComponents("Component.ScriptComponent") as ScriptComponent[]) {
      const anyC = c as unknown as {isOn?: boolean}
      if (typeof anyC.isOn === "boolean") return anyC as {isOn: boolean}
    }
    throw new Error(`No UIKit toggle Button on ${name}`)
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
    return this.toggleButton(`Toggle-${id}`).isOn
  }

  /**
   * Flip a profile toggle through the UIKit Button's own `isOn` (the same path the pinch
   * state machine uses: it updates the visual and fires onValueChange → Main's profile).
   * Driving 17 consecutive SIK pinches on the panel proved unreliable in the preview
   * (stray triggers landed on neighbouring chips / Done); scenario 1 still proves the
   * toggles and Done are real pinch targets.
   */
  async setToggle(id: string, on: boolean): Promise<void> {
    if (this.getToggleState(id) === on) return
    this.toggleButton(`Toggle-${id}`).isOn = on
    await sleep(60)
    if (this.getToggleState(id) !== on) throw new Error(`Toggle-${id} did not flip to ${on}`)
  }

  /** Make the profile exactly `onIds` (everything else off). Panel must be open. */
  async setProfile(onIds: string[]): Promise<void> {
    for (const id of ALL_PROFILE_IDS) await this.setToggle(id, onIds.indexOf(id) >= 0)
  }

  /**
   * The profile is a guided setup (welcome → allergies → religious → diet): walk forward with
   * Start / Next until the Done screen, then Done. Each tap is a real pinch target.
   */
  async done(): Promise<void> {
    for (let i = 0; i < 4 && this.isVisible("ProfilePanel"); i++) {
      if (this.isVisible("StartButton")) await this.tap("StartButton")
      else if (this.isVisible("NextButton")) await this.tap("NextButton")
      else {
        await this.tap("DoneButton")
        break
      }
      await sleep(150)
    }
  }

  getMood(): string {
    return mainScript().currentMood
  }

  /** The "in the mood for" filter has no chips any more: it is voice on the menu, and Main's API here. */
  async setMood(mood: MoodId): Promise<void> {
    if (this.getMood() === mood) return
    if (!mainScript().setMood(mood)) throw new Error(`mood ${mood} not accepted (contradicts the profile?)`)
  }

  /** Open profile, set exactly `profileIds` (nothing extra from a remembered profile), the mood, Done. */
  async prepareProfile(profileIds: string[], mood: MoodId = "everything"): Promise<void> {
    await this.ensureProfileOpen()
    mainScript().resetProfile()
    await this.setProfile(profileIds)
    await this.setMood(mood)
    await this.done()
  }

  async simulateMarker(id: string, offsetXcm: number = 0): Promise<void> {
    mainScript().setCameraTracking(false)
    if (!mainScript().simulateMarker(id, offsetXcm)) throw new Error(`simulateMarker(${id}) returned false`)
    await sleep(900) // marks fade in over ~0.4 s; the arrow check runs every 0.2 s
  }

  async simulateMarkerLost(): Promise<void> {
    mainScript().simulateMarkerLost()
  }

  bar(dishId: string): BarState {
    const root = findByName(`Bar-${dishId}`)
    const none: BarState = {exists: false, shown: false, full: false, underline: false, dot: false, star: false, color: null}
    if (!root) return none
    const child = (name: string): SceneObject | null => {
      for (let i = 0; i < root.getChildrenCount(); i++) if (root.getChild(i).name === name) return root.getChild(i)
      return null
    }
    const vis = (name: string): boolean => {
      const c = child(name)
      return !!c && c.enabled
    }
    const colorOf = (name: string): vec4 | null => {
      const c = child(name)
      const img = c ? (c.getComponent("Component.Image") as Image | null) : null
      return img ? img.mainMaterial.mainPass.baseColor : null
    }
    const shown = isEffectivelyEnabled(root)
    const dot = vis("Dot"), underline = vis("Underline"), full = vis("Full"), star = vis("Star")
    const color = dot ? colorOf("Dot") : underline ? colorOf("Underline") : full ? colorOf("Full") : star ? colorOf("Star") : null
    return {exists: true, shown, full, underline, dot, star, color}
  }

  private expectTint(dishId: string, name: string, test: (c: vec4) => boolean): BarState {
    const b = this.bar(dishId)
    if (!b.exists) throw new Error(`Bar-${dishId}: no bar`)
    if (!b.shown || !b.color) throw new Error(`Bar-${dishId}: expected a ${name} mark, none shown`)
    if (!test(b.color)) throw new Error(`Bar-${dishId}: expected ${name}, got ${b.color}`)
    return b
  }

  private static isGreen(c: vec4): boolean {
    return c.y > c.x && c.w > 0
  }

  private static isRed(c: vec4): boolean {
    return c.x > c.y && c.y < 0.6 && c.w > 0
  }

  private static isAmber(c: vec4): boolean {
    return c.x >= c.y && c.y >= 0.7 && c.z < c.y && c.w > 0
  }

  /** Everything mode: safe → green dot only. */
  expectGreenDot(dishId: string): void {
    const b = this.expectTint(dishId, "green", AllergyLensLeafInteractor.isGreen)
    if (!b.dot || b.full || b.underline || b.star) throw new Error(`Bar-${dishId}: expected a green dot only, got ${JSON.stringify(b)}`)
  }

  /** Category mode: safe + in category → soft green full line + star. */
  expectGreenStar(dishId: string): void {
    const b = this.expectTint(dishId, "green", AllergyLensLeafInteractor.isGreen)
    if (!b.full || !b.star || b.underline || b.dot) throw new Error(`Bar-${dishId}: expected green full line + star, got ${JSON.stringify(b)}`)
  }

  /** contains → thin red underline + red dot, never a full line. */
  expectRed(dishId: string): void {
    const b = this.expectTint(dishId, "red", AllergyLensLeafInteractor.isRed)
    if (!b.underline || !b.dot || b.full || b.star) throw new Error(`Bar-${dishId}: expected red underline + dot, got ${JSON.stringify(b)}`)
  }

  /** unverified → amber dot only. */
  expectAmber(dishId: string): void {
    const b = this.expectTint(dishId, "amber", AllergyLensLeafInteractor.isAmber)
    if (!b.dot || b.full || b.underline || b.star) throw new Error(`Bar-${dishId}: expected an amber dot only, got ${JSON.stringify(b)}`)
  }

  expectUnmarked(dishId: string): void {
    const b = this.bar(dishId)
    if (!b.exists) throw new Error(`Bar-${dishId}: no bar`)
    if (b.shown) throw new Error(`Bar-${dishId}: expected no mark, but it is shown ${JSON.stringify(b)}`)
  }

  /** Every bar on the page must satisfy `test` (used for "no full-width quads"). */
  forEachShownBar(test: (dishId: string, b: BarState) => void): void {
    for (const d of LAUREL.dishes) {
      if (!d.layout) continue
      const b = this.bar(d.id)
      if (b.shown) test(d.id, b)
    }
  }

  /** Badge as the overlay on MenuMarker reports it. */
  badge(): {level: string; text: string} {
    const o = overlayScript()
    return {level: o.badgeLevel, text: o.badgeTextValue}
  }

  arrow(): {visible: boolean; label: string} {
    const o = overlayScript()
    return {visible: o.arrowVisible, label: o.arrowLabel}
  }

  detailTexts(): string[] {
    return collectTexts(requireByName("DishDetail"))
  }
}

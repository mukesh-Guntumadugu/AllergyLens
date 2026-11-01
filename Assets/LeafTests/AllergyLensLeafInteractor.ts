// AllergyLensLeafInteractor — shared LEAF helpers for the AllergyLens scenarios.
// Scenarios run back-to-back against one live Lens, so every helper is state-
// resilient: it reads the current state and only acts when needed.

import {DefaultLeafInteractor} from "Leaf.lspkg/Interactors/interactor/DefaultLeafInteractor"
import {findInteractablesByName} from "Leaf.lspkg/Interactors/InteractableUtils"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {ALLERGENS, RESTAURANTS} from "../Data/AllergyData"

/** Every toggle id, straight from the data module (17). */
export const ALL_PROFILE_IDS: string[] = ALLERGENS.map((a) => a.id)
export const DEMO_DISH_IDS = ["noodles", "burger", "salmon", "pizza", "ricebowl", "cheesecake"]
export const RESTAURANT_NAMES: string[] = RESTAURANTS.map((r) => r.name)

/** Depth-first search that INCLUDES disabled objects (hidden panels are the point here). */
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

export interface HighlightState {
  enabled: boolean
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
    return !!so && so.enabled
  }

  async ensureProfileOpen(): Promise<void> {
    if (this.isVisible("ProfilePanel")) return
    await this.tap("ProfileButton")
    await sleep(300)
    if (!this.isVisible("ProfilePanel")) throw new Error("ProfilePanel did not open after ProfileButton")
  }

  getToggleState(id: string): boolean {
    const so = requireByName(`Toggle-${id}`)
    const comps = so.getComponents("Component.ScriptComponent") as ScriptComponent[]
    for (const c of comps) {
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

  async scan(): Promise<void> {
    await this.tap("ScanButton")
    await sleep(400)
  }

  /** The restaurant name currently printed as the menu card title. */
  currentRestaurantName(): string {
    const texts = collectTexts(requireByName("MenuCard"))
    for (const t of texts) if (RESTAURANT_NAMES.indexOf(t) >= 0) return t
    throw new Error(`MenuCard title is not a known restaurant: [${texts.join(" | ")}]`)
  }

  /** Cycle the Restaurant button until the card shows `name`. Menu must be visible. */
  async selectRestaurant(name: string): Promise<void> {
    for (let i = 0; i <= RESTAURANT_NAMES.length; i++) {
      if (this.currentRestaurantName() === name) return
      await this.tap("RestaurantButton")
    }
    throw new Error(`Could not reach restaurant "${name}"`)
  }

  /** Open profile, set exactly `profileIds`, Done, then switch to `restaurant`. */
  async prepare(restaurant: string, profileIds: string[]): Promise<void> {
    await this.ensureProfileOpen()
    await this.setProfile(profileIds)
    await this.done()
    await this.selectRestaurant(restaurant)
  }

  highlight(dishId: string): HighlightState {
    const tile = requireByName(`Dish-${dishId}`)
    let hl: SceneObject | null = null
    for (let i = 0; i < tile.getChildrenCount(); i++) {
      if (tile.getChild(i).name === "Highlight") hl = tile.getChild(i)
    }
    if (!hl) throw new Error(`Dish-${dishId} has no Highlight child`)
    const img = hl.getComponent("Component.Image") as Image | null
    const color = img ? img.mainMaterial.mainPass.baseColor : null
    return {enabled: hl.enabled, color}
  }

  expectGreen(dishId: string): void {
    const h = this.highlight(dishId)
    if (!h.enabled || !h.color) throw new Error(`Dish-${dishId}: expected a green highlight, none shown`)
    if (!(h.color.y > h.color.x && h.color.w > 0)) throw new Error(`Dish-${dishId}: expected green, got ${h.color}`)
  }

  expectRed(dishId: string): void {
    const h = this.highlight(dishId)
    if (!h.enabled || !h.color) throw new Error(`Dish-${dishId}: expected a red highlight, none shown`)
    // red: r > g and g low; amber would have g >= 0.7
    if (!(h.color.x > h.color.y && h.color.y < 0.6 && h.color.w > 0)) throw new Error(`Dish-${dishId}: expected red, got ${h.color}`)
  }

  expectAmber(dishId: string): void {
    const h = this.highlight(dishId)
    if (!h.enabled || !h.color) throw new Error(`Dish-${dishId}: expected an amber highlight, none shown`)
    // amber: r >= g, g high, b well below g
    if (!(h.color.x >= h.color.y && h.color.y >= 0.7 && h.color.z < h.color.y && h.color.w > 0)) {
      throw new Error(`Dish-${dishId}: expected amber, got ${h.color}`)
    }
  }

  detailTexts(): string[] {
    return collectTexts(requireByName("DishDetail"))
  }

  /** Restaurant badge as the menu card reports it: {level, text}. */
  currentBadge(): {level: string; text: string} {
    const card = requireByName("MenuCard")
    const comps = card.getComponents("Component.ScriptComponent") as ScriptComponent[]
    for (const c of comps) {
      const anyC = c as unknown as {badgeLevel?: string; badgeTextValue?: string}
      if (typeof anyC.badgeLevel === "string") return {level: anyC.badgeLevel, text: anyC.badgeTextValue ?? ""}
    }
    throw new Error("MenuCard has no badge API")
  }
}

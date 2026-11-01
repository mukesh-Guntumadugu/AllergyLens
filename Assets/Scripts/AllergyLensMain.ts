// AllergyLensMain — orchestrator. Owns: the profile (which allergen ids the user
// flagged), the selected restaurant, the scan results, and the show/hide flow between
// the four UI panels. Expects @inputs wired by the scene bootstrap: profilePanel,
// menuCard, scanBar, dishDetail (typed UI handles). Must not author UI text or
// geometry — it only pushes state into the UI modules and listens to their events.
//
// Flow (devpost/design-brief.md): profile panel shows at start → Done hides it and
// shows the menu + Scan button → Scan paints green / red / amber on the dishes →
// pinching a red or amber dish opens the detail card next to it → pinch again /
// another dish closes it → Restaurant cycles the menu → Profile reopens the panel.
//
// Data comes from Assets/Data/AllergyData.ts (generated). Optionally `menusUrl` fetches
// the same menus.json shape at start and swaps the restaurant list in; any failure
// falls back to the bundled data with one log line.

import {AllergyLensProfileUI} from "./AllergyLensProfileUI"
import {AllergyLensMenuCardUI} from "./AllergyLensMenuCardUI"
import {AllergyLensScanBarUI} from "./AllergyLensScanBarUI"
import {AllergyLensDishDetailUI} from "./AllergyLensDishDetailUI"
import {AllergyLensAudio} from "./AllergyLensAudio"
import {
  DEFAULT_RESTAURANT_ID,
  RestaurantDef,
  getRestaurants,
  setRestaurants,
  validateMenus,
} from "./AllergyLensMenuData"
import {checkMenu, describeResult, DishResult, Profile, rateRestaurant} from "./AllergyLensChecker"

@component
export class AllergyLensMain extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensMain – profile → restaurant → scan → highlights → detail</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">References</span>')
  @ui.group_start("References")
  @input
  @hint("Profile panel UI (toggles + Done).")
  profilePanel!: AllergyLensProfileUI

  @input
  @hint("Menu card UI with the dish tiles.")
  menuCard!: AllergyLensMenuCardUI

  @input
  @hint("Scan menu + Restaurant + Profile buttons.")
  scanBar!: AllergyLensScanBarUI

  @input
  @hint("Small detail card shown next to a red or amber dish.")
  dishDetail!: AllergyLensDishDetailUI
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Show the profile panel when the Lens starts and keep the menu hidden until Done is pinched.")
  showProfileAtStart: boolean = true

  @input
  @hint("Gap (cm) between a dish tile's edge and the detail card that opens beside it.")
  @widget(new SliderWidget(0, 20, 0.5))
  detailGapCm: number = 1.5

  @input
  @hint("Volume for the click / scan / pop cues (0 = silent).")
  @widget(new SliderWidget(0, 1, 0.05))
  sfxVolume: number = 0.8

  @input
  @hint("Optional URL of a menus.json (same shape as data/menus.json). Fetched once at start; on any failure the bundled data is used.")
  menusUrl: string = ""
  @ui.group_end

  private profile = new Profile()
  private restaurants: RestaurantDef[] = getRestaurants()
  private restaurantIndex = 0
  private results: DishResult[] = []
  private openDish = -1
  private audio: AllergyLensAudio | null = null

  onAwake(): void {
    if (!this.profilePanel || !this.menuCard || !this.scanBar || !this.dishDetail) {
      print("AllergyLensMain: required @input not wired (profilePanel / menuCard / scanBar / dishDetail). Check Phase B.")
      return
    }
    const audioHost = global.scene.createSceneObject("Audio")
    audioHost.setParent(this.sceneObject)
    this.audio = new AllergyLensAudio(audioHost, this.sfxVolume)

    this.createEvent("OnStartEvent").bind(() => this.onStart())
  }

  private onStart(): void {
    // Subscribe here, not in onAwake: the UI SceneObjects sit below this root in the
    // hierarchy, so their scripts (and their Event fields) only exist once OnStart runs.
    this.profilePanel.onToggle.add((e) => {
      this.profile.set(e.id, e.on)
      this.audio?.playClick()
      print(`AllergyLens: profile ${e.id} = ${e.on ? "on" : "off"}`)
      this.updateBadge()
    })
    this.profilePanel.onDone.add(() => this.onProfileDone())
    this.scanBar.onScan.add(() => this.runScan())
    this.scanBar.onRestaurant.add(() => this.cycleRestaurant())
    this.scanBar.onProfile.add(() => this.openProfile())
    this.menuCard.onDishPinched.add((i) => this.onDishPinched(i))
    this.dishDetail.onClose.add(() => this.closeDetail())

    const defaultIndex = Math.max(0, this.restaurants.findIndex((r) => r.id === DEFAULT_RESTAURANT_ID))
    this.applyRestaurant(defaultIndex)

    const menuVisible = !this.showProfileAtStart
    this.profilePanel.getSceneObject().enabled = this.showProfileAtStart
    this.menuCard.getSceneObject().enabled = menuVisible
    this.scanBar.getSceneObject().enabled = menuVisible
    this.dishDetail.hideDetail()
    print(`AllergyLens: ready (profile ${this.showProfileAtStart ? "shown" : "hidden"}, ${this.restaurants.length} restaurants)`)

    if (this.menusUrl && this.menusUrl.trim().length > 0) this.loadRemoteMenus(this.menusUrl.trim())
  }

  // ── Profile ────────────────────────────────────────────────────────────
  private onProfileDone(): void {
    this.audio?.playClick()
    this.profilePanel.getSceneObject().enabled = false
    this.menuCard.getSceneObject().enabled = true
    this.scanBar.getSceneObject().enabled = true
    print(`AllergyLens: profile done [${this.profile.ids().join(", ")}] — menu shown`)
  }

  private openProfile(): void {
    this.audio?.playClick()
    this.closeDetail()
    this.profilePanel.getSceneObject().enabled = true
    print("AllergyLens: profile reopened")
  }

  // ── Restaurant ─────────────────────────────────────────────────────────
  private get currentRestaurant(): RestaurantDef {
    return this.restaurants[this.restaurantIndex]
  }

  private cycleRestaurant(): void {
    this.audio?.playClick()
    this.applyRestaurant((this.restaurantIndex + 1) % this.restaurants.length)
  }

  private applyRestaurant(index: number): void {
    this.restaurantIndex = index
    this.closeDetail()
    this.results = []
    this.menuCard.setRestaurant(this.currentRestaurant)
    print(`AllergyLens: restaurant ${this.currentRestaurant.id} (${this.currentRestaurant.name})`)
    this.updateBadge()
  }

  /** Restaurant-level badge for the current profile — before any scan, so the user can judge the place. */
  private updateBadge(): void {
    const badge = rateRestaurant(this.currentRestaurant, this.profile)
    this.menuCard.setBadge(badge.level, badge.text)
    this.scanBar.setBadge(badge.level)
    print(`AllergyLens: badge ${badge.level} — ${badge.text}`)
  }

  private async loadRemoteMenus(url: string): Promise<void> {
    try {
      const internet = require("LensStudio:InternetModule") as InternetModule
      const response = await internet.fetch(url, {method: "GET"})
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const restaurants = validateMenus(json)
      if (!restaurants) throw new Error("menus.json shape not recognised")
      setRestaurants(restaurants)
      this.restaurants = restaurants
      const keep = restaurants.findIndex((r) => r.id === this.currentRestaurant.id)
      this.applyRestaurant(keep >= 0 ? keep : 0)
      print(`AllergyLens: loaded ${restaurants.length} restaurants from ${url}`)
    } catch (e) {
      print(`AllergyLens: remote menus unavailable (${e}); using bundled data`)
    }
  }

  // ── Scan ───────────────────────────────────────────────────────────────
  private runScan(): void {
    this.closeDetail()
    const dishes = this.currentRestaurant.dishes.slice(0, this.menuCard.dishCount)
    this.results = checkMenu(dishes, this.profile)
    for (let i = 0; i < this.results.length; i++) {
      this.menuCard.setDishState(i, this.results[i].verdict)
    }
    this.audio?.playScan()
    const by = (v: string) => this.results.filter((r) => r.verdict === v).map((r) => r.dishId)
    print(`AllergyLens: scan complete — contains [${by("contains").join(", ")}], unverified [${by("unverified").join(", ")}], safe ${by("safe").length}`)
  }

  // ── Dish detail ────────────────────────────────────────────────────────
  private onDishPinched(index: number): void {
    const result = this.results[index]
    if (!result || result.verdict === "safe" || result.verdict === "none") {
      // Green (or unscanned) dish: nothing to explain — just close any open card.
      if (this.openDish >= 0) this.closeDetail()
      return
    }
    if (this.openDish === index) {
      this.closeDetail()
      return
    }
    this.openDish = index
    const dish = this.currentRestaurant.dishes[index]
    const text = describeResult(result)
    this.placeDetailNextTo(index)
    this.dishDetail.showDetail({dishName: dish.name, headline: text.headline, body: text.body})
    this.audio?.playPop()
    print(`AllergyLens: detail open for ${dish.id} — ${text.headline} ${text.body.replace(/\n/g, " ")}`)
  }

  private closeDetail(): void {
    if (this.openDish >= 0) print(`AllergyLens: detail closed for ${this.currentRestaurant.dishes[this.openDish]?.id ?? this.openDish}`)
    this.openDish = -1
    this.dishDetail.hideDetail()
  }

  /** Park the detail card beside the pinched tile, in the card's plane, on the outer side. */
  private placeDetailNextTo(index: number): void {
    const anchor = this.menuCard.getDishAnchor(index)
    if (!anchor) return
    const at = anchor.getTransform()
    const rot = at.getWorldRotation()
    const right = rot.multiplyVec3(vec3.right())
    const forward = rot.multiplyVec3(vec3.forward())
    const side = this.menuCard.getDishSide(index)
    const tileHalfW = (this.menuCard.cardWidthCm - 1.2 * 2 - 0.6) / 4
    const offset = tileHalfW + this.detailGapCm + this.dishDetail.cardWidthCm / 2
    const pos = at.getWorldPosition().add(right.uniformScale(side * offset)).add(forward.uniformScale(0.5))
    const dt = this.dishDetail.getSceneObject().getTransform()
    dt.setWorldPosition(pos)
    dt.setWorldRotation(rot)
  }
}

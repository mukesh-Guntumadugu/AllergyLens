// AllergyLensMain — orchestrator for the see-through flow. Owns: the profile (which
// allergen ids the user flagged), the per-restaurant check results, and the flow
// between the profile panel, the marker overlays (one per real menu page) and the
// detail card. Expects @inputs wired by the scene bootstrap: profilePanel, dishDetail,
// profileButton, markersRoot (the group holding the MenuMarker objects). Must not
// author UI text or geometry — it pushes state into the UI modules and listens to
// their events.
//
// Flow: profile panel (or defaultProfile hands-free) → the camera recognises a menu page
// → ScanReveal + bars (green / red / amber) + badge chip on the page → pinch a red or
// amber bar → detail card beside the line (replacement rule) → marker lost → bars hide
// after ~1 s. Profile changes re-run the check on every active page.

import {AllergyLensProfileUI} from "./AllergyLensProfileUI"
import {AllergyLensProfileButtonUI} from "./AllergyLensProfileButtonUI"
import {AllergyLensDishDetailUI} from "./AllergyLensDishDetailUI"
import {AllergyLensMenuOverlayUI, DishMark, MarkStyle} from "./AllergyLensMenuOverlayUI"
import {AllergyLensAudio} from "./AllergyLensAudio"
import {ALLERGENS, MOODS, Mood, RestaurantDef, dishCategory, getRestaurant, moodLabel, setRestaurants, validateMenus} from "./AllergyLensMenuData"
import {checkMenu, describeChoice, DishResult, Profile, rateRestaurant} from "./AllergyLensChecker"
import {VoiceListener, matchDishByVoice} from "./AllergyLensVoice"

@component
export class AllergyLensMain extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensMain – profile → real menu recognised → bars + badge → detail</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">References</span>')
  @ui.group_start("References")
  @input
  @hint("Profile panel UI (toggles + Done).")
  profilePanel!: AllergyLensProfileUI

  @input
  @hint("Small world-locked Profile button that reopens the panel.")
  profileButton!: AllergyLensProfileButtonUI

  @input
  @hint("Detail card shown beside a pinched red or amber bar.")
  dishDetail!: AllergyLensDishDetailUI

  @input
  @hint("Group whose children are the MenuMarker objects (MarkerTrackingComponent + AllergyLensMenuOverlayUI).")
  markersRoot!: SceneObject
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Show the profile panel when the Lens starts (ignored when defaultProfile is set).")
  showProfileAtStart: boolean = true

  @input
  @hint("Comma-separated allergen ids (e.g. \"peanut,milk\") applied at start — with showProfileAtStart off this gives a hands-free demo.")
  defaultProfile: string = ""

  @input
  @hint("Mood applied at start: everything | chicken | red_meat | seafood | vegetarian | dessert.")
  defaultMood: string = "everything"

  @input
  @hint("Gap (cm) between a bar's end and the detail card placed beside it.")
  @widget(new SliderWidget(0, 10, 0.5))
  detailGapCm: number = 1.0

  @input
  @hint("Volume for the click / scan / pop cues (0 = silent).")
  @widget(new SliderWidget(0, 1, 0.05))
  sfxVolume: number = 0.8

  @input
  @hint("Also let the user say a dish name while a menu is in view (Specs ASR). Pinching a line stays the primary way.")
  voiceEnabled: boolean = true

  @input
  @hint("Start the ASR session inside the Lens Studio preview too. Off by default: starting ASR in the preview crashed Lens Studio 5.23.2 during testing; on the device it runs normally.")
  voiceInPreview: boolean = false

  @input
  @hint("Debug: on start, pretend the first menu marker was recognised 60 cm ahead (for Interactive Preview, which has no camera).")
  debugSimulateMarker: boolean = false

  @input
  @hint("Optional URL of a menus.json (same shape as data/menus.json). Fetched once at start; on any failure the bundled data is used.")
  menusUrl: string = ""
  @ui.group_end

  private profile = new Profile()
  private mood: Mood = "everything"
  private overlays: AllergyLensMenuOverlayUI[] = []
  private results = new Map<string, DishResult[]>()
  private openDish: {restaurantId: string; dishId: string} | null = null
  private audio: AllergyLensAudio | null = null
  private buttonShowTimer: DelayedCallbackEvent | null = null
  private voice: VoiceListener | null = null
  private safeCardTimer: DelayedCallbackEvent | null = null

  onAwake(): void {
    if (!this.profilePanel || !this.profileButton || !this.dishDetail || !this.markersRoot) {
      print("AllergyLensMain: required @input not wired (profilePanel / profileButton / dishDetail / markersRoot). Check Phase B.")
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
      this.recheckActive()
    })
    this.profilePanel.onMood.add((m) => {
      this.mood = m
      this.audio?.playClick()
      print(`AllergyLens: mood ${m}`)
      this.recheckActive()
    })
    this.profilePanel.onDone.add(() => this.onProfileDone())
    this.profileButton.onProfile.add(() => this.openProfile())
    this.dishDetail.onClose.add(() => this.closeDetail())

    // Discover the marker overlays from the authored Markers group (one per real menu).
    for (let i = 0; i < this.markersRoot.getChildrenCount(); i++) {
      const child = this.markersRoot.getChild(i)
      const overlay = child.getComponent(AllergyLensMenuOverlayUI.getTypeName()) as AllergyLensMenuOverlayUI | null
      if (!overlay) continue
      this.overlays.push(overlay)
      overlay.onFound.add((id) => this.onMarkerFound(id))
      overlay.onLost.add((id) => this.onMarkerLost(id))
      overlay.onBarPinched.add((e) => this.onBarPinched(e.restaurantId, e.dishId))
    }

    this.applyDefaultProfile()
    this.applyDefaultMood()
    if (this.voiceEnabled) {
      const inEditor = global.deviceInfoSystem.isEditor()
      if (inEditor && !this.voiceInPreview) print("AllergyLens: voice selection is off in the Lens Studio preview (set voiceInPreview to try it); pinch works")
      else this.voice = new VoiceListener((text) => this.onVoice(text))
    }
    this.safeCardTimer = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.safeCardTimer.bind(() => this.closeDetail())
    this.buttonShowTimer = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.buttonShowTimer.bind(() => {
      if (!this.anyMarkerActive()) this.profileButton.getSceneObject().enabled = true
    })
    // Profile is a separate step before the menu: panel at start (unless a default
    // profile makes the run hands-free); the small Profile button only when the panel is
    // closed and no menu is in view.
    const panelAtStart = this.showProfileAtStart && this.profile.isEmpty
    this.profilePanel.getSceneObject().enabled = panelAtStart
    this.profileButton.getSceneObject().enabled = !panelAtStart
    this.dishDetail.hideDetail()
    print(`AllergyLens: ready (profile panel ${panelAtStart ? "shown" : "hidden"}, profile [${this.profile.ids().join(", ")}], ${this.overlays.length} menu marker(s))`)

    if (this.menusUrl && this.menusUrl.trim().length > 0) this.loadRemoteMenus(this.menusUrl.trim())
    if (this.debugSimulateMarker && this.overlays.length > 0) {
      const t = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
      t.bind(() => this.simulateMarker(this.overlays[0].restaurantId))
      t.reset(0.5)
    }
  }

  // ── Debug / test hooks ─────────────────────────────────────────────────
  /** Drive the real marker-found path for a restaurant id (page parked 60 cm ahead). */
  simulateMarker(restaurantId: string, offsetXcm: number = 0): boolean {
    const overlay = this.overlays.find((o) => o.restaurantId === restaurantId)
    if (!overlay) {
      print(`AllergyLens: simulateMarker — no overlay for "${restaurantId}"`)
      return false
    }
    return overlay.simulateFound(offsetXcm)
  }

  simulateMarkerLost(): void {
    for (const o of this.overlays) if (o.isActive) o.simulateLost()
  }

  /** Debug / tests: enable or disable the camera marker trackers (runtime-only; tests use simulateMarker instead). */
  setCameraTracking(enabled: boolean): void {
    for (const o of this.overlays) o.setCameraTracking(enabled)
    print(`AllergyLens: camera marker tracking ${enabled ? "enabled" : "disabled"}`)
  }

  /** True while any menu marker is recognised or simulated. */
  get markerActive(): boolean {
    return this.anyMarkerActive()
  }

  // ── Profile ────────────────────────────────────────────────────────────
  private applyDefaultProfile(): void {
    const ids = this.defaultProfile.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    for (const id of ids) {
      if (!ALLERGENS.some((a) => a.id === id)) {
        print(`AllergyLens: defaultProfile id "${id}" is not in the allergen list; ignored`)
        continue
      }
      this.profile.set(id, true)
      this.profilePanel.setToggle(id, true)
    }
  }

  private applyDefaultMood(): void {
    const id = this.defaultMood.trim() as Mood
    if (!MOODS.some((m) => m.id === id)) {
      if (id.length > 0) print(`AllergyLens: defaultMood "${id}" unknown; using everything`)
      return
    }
    this.mood = id
    this.profilePanel.setMood(id)
  }

  private onProfileDone(): void {
    this.audio?.playClick()
    this.profilePanel.getSceneObject().enabled = false
    this.profileButton.getSceneObject().enabled = !this.anyMarkerActive()
    print(`AllergyLens: profile done [${this.profile.ids().join(", ")}]`)
    this.recheckActive()
  }

  private openProfile(): void {
    this.audio?.playClick()
    this.closeDetail()
    this.profilePanel.getSceneObject().enabled = true
    this.profileButton.getSceneObject().enabled = false
    print("AllergyLens: profile reopened")
  }

  private anyMarkerActive(): boolean {
    return this.overlays.some((o) => o.isActive)
  }

  // ── Marker lifecycle ───────────────────────────────────────────────────
  private onMarkerFound(restaurantId: string): void {
    this.audio?.playScan()
    print(`AllergyLens: menu recognised — ${restaurantId}`)
    // Nothing but bars, badge and (on pinch) the detail card over the page: an open
    // profile panel closes (its toggles are the profile) and the Profile button hides.
    this.buttonShowTimer?.cancel()
    if (this.profilePanel.getSceneObject().enabled) {
      this.profilePanel.getSceneObject().enabled = false
      print(`AllergyLens: profile panel closed by recognition [${this.profile.ids().join(", ")}]`)
    }
    this.profileButton.getSceneObject().enabled = false
    this.runCheck(restaurantId)
    this.voice?.start()
  }

  private onMarkerLost(restaurantId: string): void {
    print(`AllergyLens: menu lost — ${restaurantId}`)
    if (this.openDish && this.openDish.restaurantId === restaurantId) this.closeDetail()
    if (!this.anyMarkerActive()) {
      this.buttonShowTimer?.reset(1.0)
      this.voice?.stop()
    }
  }

  // ── Voice ──────────────────────────────────────────────────────────────
  /** A final transcript while a menu is in view: match it to a dish and act like a pinch. */
  private onVoice(text: string): void {
    const overlay = this.overlays.find((o) => o.isActive)
    const restaurant = overlay ? getRestaurant(overlay.restaurantId) : undefined
    if (!overlay || !restaurant) return
    const dish = matchDishByVoice(text, restaurant.dishes)
    if (!dish) {
      print(`AllergyLens: voice "${text}" — no dish on this menu`)
      return
    }
    print(`AllergyLens: voice "${text}" → ${dish.id}`)
    const results = this.results.get(restaurant.id) ?? []
    const result = results.find((r) => r.dishId === dish.id)
    if (result && result.verdict === "safe") {
      this.safeCardTimer?.cancel()
      this.openDish = {restaurantId: restaurant.id, dishId: dish.id}
      this.placeDetailBesideBar(overlay, dish.id)
      this.dishDetail.showDetail({dishName: `${dish.name} — safe for you`, headline: "Nothing from your profile.", body: result.source === "typical" ? "Based on a typical recipe; confirm with the restaurant." : "Enjoy."})
      this.audio?.playPop()
      this.safeCardTimer?.reset(3.0)
      return
    }
    this.onBarPinched(restaurant.id, dish.id)
  }

  private recheckActive(): void {
    for (const o of this.overlays) if (o.isActive) this.runCheck(o.restaurantId)
  }

  private runCheck(restaurantId: string): void {
    const overlay = this.overlays.find((o) => o.restaurantId === restaurantId)
    const restaurant = getRestaurant(restaurantId)
    if (!overlay || !restaurant) return
    const results = checkMenu(restaurant.dishes, this.profile)
    this.results.set(restaurantId, results)

    // Highlight rules: Everything → light marks on every line; a category → only that
    // category's dishes, with safe ones as "order this" star lines.
    const everything = this.mood === "everything"
    const marks: DishMark[] = []
    let safeInCategory = 0
    for (const r of results) {
      const dish = restaurant.dishes.find((d) => d.id === r.dishId)
      const inCategory = !everything && !!dish && dishCategory(dish) === this.mood
      let style: MarkStyle = "none"
      if (everything) {
        style = r.verdict === "contains" ? "underline-contains" : r.verdict === "unverified" ? "dot-unverified" : r.verdict === "safe" ? "dot-safe" : "none"
      } else if (inCategory) {
        style = r.verdict === "contains" ? "underline-contains" : r.verdict === "unverified" ? "dot-unverified" : r.verdict === "safe" ? "star-safe" : "none"
        if (r.verdict === "safe") safeInCategory++
      }
      marks.push({dishId: r.dishId, style, inCategory})
    }
    overlay.setMarks(marks, everything ? null : moodLabel(this.mood))

    const badge = rateRestaurant(restaurant, this.profile)
    const stars = restaurant.rating ? ` · ★${restaurant.rating.stars.toFixed(1)}` : ""
    const complaints = restaurant.rating?.allergyComplaints ?? 0
    const reviewsLong = complaints > 0 ? ` · ${complaints} review${complaints === 1 ? "" : "s"} mention${complaints === 1 ? "s" : ""} allergies` : ""
    const reviewsShort = complaints > 0 ? ` · ${complaints} allergy review${complaints === 1 ? "" : "s"}` : ""
    const core = everything
      ? `${badge.safeCount} of ${badge.total} safe`
      : `${safeInCategory} ${moodLabel(this.mood).toLowerCase()} dish${safeInCategory === 1 ? "" : "es"} safe for you`
    // Fit the chip: full wording first, then compact reviews, then drop the restaurant name.
    const capacity = overlay.badgeCapacityChars
    const candidates = [
      `${restaurant.name} · ${core}${stars}${reviewsLong}`,
      `${restaurant.name} · ${core}${stars}${reviewsShort}`,
      `${core}${stars}${reviewsShort}`,
    ]
    const badgeText = candidates.find((c) => c.length <= capacity) ?? candidates[candidates.length - 1]
    overlay.setBadge(badge.level, badgeText)
    const by = (v: string) => results.filter((r) => r.verdict === v).length
    print(`AllergyLens: check ${restaurantId} (${this.mood}) — contains ${by("contains")}, unverified ${by("unverified")}, safe ${by("safe")}; marked ${marks.filter((m) => m.style !== "none").length}; badge ${badge.level}`)
    if (this.openDish && this.openDish.restaurantId === restaurantId) this.closeDetail()
  }

  // ── Detail card ────────────────────────────────────────────────────────
  private onBarPinched(restaurantId: string, dishId: string): void {
    const results = this.results.get(restaurantId) ?? []
    const result = results.find((r) => r.dishId === dishId)
    if (!result || result.verdict === "safe" || result.verdict === "none") {
      if (this.openDish) this.closeDetail()
      return
    }
    if (this.openDish && this.openDish.restaurantId === restaurantId && this.openDish.dishId === dishId) {
      this.closeDetail()
      return
    }
    const restaurant = getRestaurant(restaurantId)
    const overlay = this.overlays.find((o) => o.restaurantId === restaurantId)
    const dish = restaurant?.dishes.find((d) => d.id === dishId)
    if (!restaurant || !overlay || !dish) return
    this.openDish = {restaurantId, dishId}
    const text = describeChoice(dish, result, restaurant, results)
    this.placeDetailBesideBar(overlay, dishId)
    this.dishDetail.showDetail({dishName: dish.name, headline: text.headline, body: text.body})
    this.audio?.playPop()
    print(`AllergyLens: detail open for ${dishId} — ${text.headline} ${text.body.replace(/\n/g, " ")}`)
  }

  private closeDetail(): void {
    this.safeCardTimer?.cancel()
    if (this.openDish) print(`AllergyLens: detail closed for ${this.openDish.dishId}`)
    this.openDish = null
    this.dishDetail.hideDetail()
  }

  /** Park the card on the page plane beside the bar, toward the page centre so it stays in view. */
  private placeDetailBesideBar(overlay: AllergyLensMenuOverlayUI, dishId: string): void {
    const g = overlay.getBarGeometry(dishId)
    if (!g) return
    const cardW = this.dishDetail.cardWidthCm
    const side = g.x < 0 ? 1 : -1
    const lx = g.x + side * (g.w / 2 + this.detailGapCm + cardW / 2)
    const root = this.dishDetail.getSceneObject()
    root.setParent(overlay.getSceneObject())
    const t = root.getTransform()
    t.setLocalPosition(new vec3(lx, g.y, 1.0))
    t.setLocalRotation(quat.quatIdentity())
    t.setLocalScale(new vec3(1, 1, 1))
  }

  // ── Optional remote data ───────────────────────────────────────────────
  private async loadRemoteMenus(url: string): Promise<void> {
    try {
      const internet = require("LensStudio:InternetModule") as InternetModule
      const response = await internet.fetch(url, {method: "GET"})
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const restaurants: RestaurantDef[] | null = validateMenus(json)
      if (!restaurants) throw new Error("menus.json shape not recognised")
      setRestaurants(restaurants)
      this.recheckActive()
      print(`AllergyLens: loaded ${restaurants.length} restaurants from ${url}`)
    } catch (e) {
      print(`AllergyLens: remote menus unavailable (${e}); using bundled data`)
    }
  }
}

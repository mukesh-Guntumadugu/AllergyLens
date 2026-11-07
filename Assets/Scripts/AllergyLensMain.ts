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
import {AllergyLensMenuOverlayUI, DishMark, MarkStyle, MENU_MARKERS} from "./AllergyLensMenuOverlayUI"
import {AllergyLensProductOverlayUI, PRODUCT_MARKERS} from "./AllergyLensProductOverlayUI"
import {AllergyLensAudio} from "./AllergyLensAudio"
import {ALLERGENS, AllergenDef, AllergenGroup, GROUP_LABELS, MOODS, Mood, RestaurantDef, dishCategory, getProduct, getRestaurant, moodLabel, setRestaurants, validateMenus} from "./AllergyLensMenuData"
import {checkMenu, checkProduct, describeChoice, describeProduct, DishResult, Profile, productChipText, ProductResult, rateRestaurant} from "./AllergyLensChecker"
import {VoiceListener, matchDishByVoice, parseAllergyPhrase} from "./AllergyLensVoice"

const WELCOME = 'Welcome. Pinch an option, or just say it: "peanuts", "no pork", "vegetarian", "allergies, add mango", "done".'

/** "allergies, add mango" / "religious, add lamb" / "diet, add keto" → where a spoken addition belongs. */
const SECTION_WORDS: {[word: string]: AllergenGroup} = {
  allergies: "allergy", allergy: "allergy", allergic: "allergy",
  religious: "religious", religion: "religious", cultural: "religious", culture: "religious",
  diet: "diet", dietary: "diet", diets: "diet",
}
const NOT_A_FOOD = /^(this|that|these|those|thing|things|something|anything|it|them|one|one more|more|another|another one|option|options|stuff|here|there|some|some more|the same|same|also|too|as well)$/

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

  @input
  @allowUndefined
  @hint("Optional group whose children are ProductMarker objects (MarkerTrackingComponent + AllergyLensProductOverlayUI).")
  productsRoot: SceneObject
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Show the profile panel when the Lens starts (ignored when defaultProfile is set).")
  showProfileAtStart: boolean = true

  @input
  @hint("Comma-separated allergen ids (e.g. \"peanut,milk\") applied at start — with showProfileAtStart off this gives a hands-free demo. A word that is not an id (e.g. \"mango\") is added as a custom allergen, like saying \"I'm allergic to mango\".")
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
  @hint("Listen in the Lens Studio preview too, through VoiceML and the preview's mic button (on by default; the SPECS ASR module is never used in the preview because starting it there crashes Lens Studio 5.23.2). On the glasses voice runs through ASR regardless of this switch.")
  previewVoice: boolean = true

  @input
  @hint("Debug: on start, pretend the first menu marker was recognised 60 cm ahead (for Interactive Preview, which has no camera).")
  debugSimulateMarker: boolean = false

  @input
  @hint("Debug: on start, pretend the first product label was recognised 50 cm ahead (for Interactive Preview, which has no camera).")
  debugSimulateLabel: boolean = false

  @input
  @hint("Optional URL of a menus.json (same shape as data/menus.json). Fetched once at start; on any failure the bundled data is used.")
  menusUrl: string = ""
  @ui.group_end

  private profile = new Profile()
  /** Things added by voice or defaultProfile that are not in the knowledge base ("mango"). */
  private customAllergens: AllergenDef[] = []
  private mood: Mood = "everything"
  private overlays: AllergyLensMenuOverlayUI[] = []
  private products: AllergyLensProductOverlayUI[] = []
  private results = new Map<string, DishResult[]>()
  private productResults = new Map<string, ProductResult>()
  private openDish: {restaurantId: string; dishId: string} | null = null
  private openProduct: string | null = null
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
      // Vegan implies vegetarian + no milk + no eggs: turn those on too (never off — they may be allergies in their own right).
      const def = ALLERGENS.find((a) => a.id === e.id)
      if (e.on && def && def.implies) {
        for (const id of def.implies) {
          if (!this.profile.has(id)) {
            this.profile.set(id, true)
            this.profilePanel.setToggle(id, true)
            print(`AllergyLens: profile ${id} = on (implied by ${e.id})`)
          }
        }
      }
      this.updateMoodAvailability()
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

    // Discover the marker overlays from the authored Markers group (one per real menu), then
    // create one per bundled page (MENU_MARKERS) that is not authored yet.
    const bindOverlay = (overlay: AllergyLensMenuOverlayUI) => {
      this.overlays.push(overlay)
      overlay.onFound.add((id) => this.onMarkerFound(id))
      overlay.onLost.add((id) => this.onMarkerLost(id))
      overlay.onBarPinched.add((e) => this.onBarPinched(e.restaurantId, e.dishId))
    }
    for (let i = 0; i < this.markersRoot.getChildrenCount(); i++) {
      const overlay = this.markersRoot.getChild(i).getComponent(AllergyLensMenuOverlayUI.getTypeName()) as AllergyLensMenuOverlayUI | null
      if (overlay) bindOverlay(overlay)
    }
    for (const restaurantId of Object.keys(MENU_MARKERS)) {
      if (this.overlays.some((o) => o.restaurantId === restaurantId)) continue
      if (!getRestaurant(restaurantId)) continue
      const def = MENU_MARKERS[restaurantId]
      const so = global.scene.createSceneObject(`MenuMarker-${restaurantId}`)
      so.setParent(this.markersRoot)
      const tracker = so.createComponent("Component.MarkerTrackingComponent") as MarkerTrackingComponent
      tracker.marker = def.marker
      AllergyLensMenuOverlayUI.pending = {restaurantId, texture: def.texture}
      const overlay = so.createComponent(AllergyLensMenuOverlayUI.getTypeName()) as AllergyLensMenuOverlayUI
      AllergyLensMenuOverlayUI.pending = null
      bindOverlay(overlay)
    }
    // Packaged products: authored ProductMarker objects under productsRoot (optional) plus one
    // created here per bundled label marker (PRODUCT_MARKERS) that is not authored yet.
    const productsRoot = this.productsRoot ?? (() => {
      const g = global.scene.createSceneObject("Products")
      g.setParent(this.sceneObject)
      return g
    })()
    const bindProduct = (overlay: AllergyLensProductOverlayUI) => {
      this.products.push(overlay)
      overlay.onFound.add((b) => this.onProductFound(b))
      overlay.onLost.add((b) => this.onProductLost(b))
      overlay.onPinched.add((b) => this.onProductPinched(b))
    }
    for (let i = 0; i < productsRoot.getChildrenCount(); i++) {
      const overlay = productsRoot.getChild(i).getComponent(AllergyLensProductOverlayUI.getTypeName()) as AllergyLensProductOverlayUI | null
      if (overlay) bindProduct(overlay)
    }
    for (const barcode of Object.keys(PRODUCT_MARKERS)) {
      if (this.products.some((p) => p.barcode === barcode)) continue
      const def = PRODUCT_MARKERS[barcode]
      const so = global.scene.createSceneObject(`ProductMarker-${barcode}`)
      so.setParent(productsRoot)
      const tracker = so.createComponent("Component.MarkerTrackingComponent") as MarkerTrackingComponent
      tracker.marker = def.marker
      AllergyLensProductOverlayUI.pending = {barcode, heightCm: def.heightCm, texture: def.texture}
      const overlay = so.createComponent(AllergyLensProductOverlayUI.getTypeName()) as AllergyLensProductOverlayUI
      AllergyLensProductOverlayUI.pending = null
      bindProduct(overlay)
    }

    this.applyDefaultProfile()
    this.applyDefaultMood()
    this.updateMoodAvailability()
    if (this.voiceEnabled) {
      const inEditor = global.deviceInfoSystem.isEditor()
      if (inEditor && !this.previewVoice) print("AllergyLens: voice is off in the Lens Studio preview (tick previewVoice to talk to the panel through the preview mic); pinch works")
      else this.voice = new VoiceListener((text) => this.onVoice(text), inEditor) // preview → VoiceML, glasses → ASR
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
    if (panelAtStart) {
      this.profilePanel.setHeard(WELCOME)
      this.voice?.start() // the panel is voice-driven while it is open
    }
    this.dishDetail.hideDetail()
    print(`AllergyLens: ready (profile panel ${panelAtStart ? "shown" : "hidden"}, profile [${this.profile.ids().join(", ")}], ${this.overlays.length} menu marker(s), ${this.products.length} product marker(s))`)

    if (this.menusUrl && this.menusUrl.trim().length > 0) this.loadRemoteMenus(this.menusUrl.trim())
    if (this.debugSimulateMarker && this.overlays.length > 0) {
      const t = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
      t.bind(() => this.simulateMarker(this.overlays[0].restaurantId))
      t.reset(0.5)
    }
    if (this.debugSimulateLabel && this.products.length > 0) {
      const t = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
      t.bind(() => this.simulateMarker(this.products[0].barcode))
      t.reset(0.5)
    }
  }

  // ── Debug / test hooks ─────────────────────────────────────────────────
  /** Drive the real marker-found path for a restaurant id (page parked 60 cm ahead). */
  simulateMarker(restaurantId: string, offsetXcm: number = 0): boolean {
    const overlay = this.overlays.find((o) => o.restaurantId === restaurantId)
    if (overlay) return overlay.simulateFound(offsetXcm)
    const product = this.products.find((p) => p.barcode === restaurantId)
    if (product) return product.simulateFound(offsetXcm)
    print(`AllergyLens: simulateMarker — no overlay for "${restaurantId}"`)
    return false
  }

  simulateMarkerLost(): void {
    for (const o of this.overlays) if (o.isActive) o.simulateLost()
    for (const p of this.products) if (p.isActive) p.simulateLost()
  }

  /** Debug / tests: enable or disable the camera marker trackers (runtime-only; tests use simulateMarker instead). */
  setCameraTracking(enabled: boolean): void {
    for (const o of this.overlays) o.setCameraTracking(enabled)
    for (const p of this.products) p.setCameraTracking(enabled)
    print(`AllergyLens: camera marker tracking ${enabled ? "enabled" : "disabled"}`)
  }

  /** True while any menu or product marker is recognised or simulated. */
  get markerActive(): boolean {
    return this.anyMarkerActive()
  }

  // ── Profile ────────────────────────────────────────────────────────────
  private applyDefaultProfile(): void {
    const ids = this.defaultProfile.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    for (const id of ids) {
      if (!ALLERGENS.some((a) => a.id === id)) {
        this.addCustomAllergen(id) // "mango" → a custom allergen, exactly like saying it
        continue
      }
      this.profile.set(id, true)
      this.profilePanel.setToggle(id, true)
    }
  }

  /** Everything off: toggles, custom allergens, mood back to Everything. */
  private resetProfile(): void {
    for (const a of ALLERGENS) {
      if (this.profile.has(a.id)) {
        this.profile.set(a.id, false)
        this.profilePanel.setToggle(a.id, false)
      }
    }
    for (const c of this.customAllergens) this.profile.set(c.id, false)
    this.customAllergens = []
    this.showCustomItems()
    this.mood = "everything"
    this.profilePanel.setMood("everything")
    this.audio?.playClick()
    this.updateMoodAvailability()
    this.recheckActive()
  }

  /** Every allergen the checker should know: the knowledge base plus what the user added. */
  private allergens(): AllergenDef[] {
    return this.customAllergens.length > 0 ? ALLERGENS.concat(this.customAllergens) : ALLERGENS
  }

  /** Something not on the list ("mango"): one alias each for the word and its plural; matched like any other allergen. */
  private addCustomAllergen(phrase: string, group: AllergenGroup = "allergy"): void {
    const word = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
    if (word.length < 2) return
    const known = ALLERGENS.find((a) => a.id === word || a.label.toLowerCase() === word || a.label.toLowerCase().replace(/^(no|avoid) /, "") === word
      || a.aliases.indexOf(word) >= 0 || (a.spoken ?? []).indexOf(word) >= 0)
    if (known) {
      // "I'm allergic to cashews" → the tree-nut toggle
      this.profile.set(known.id, true)
      this.profilePanel.setToggle(known.id, true)
      print(`AllergyLens: "${word}" → ${known.id} on`)
      this.updateMoodAvailability()
      this.recheckActive()
      return
    }
    const id = `custom:${word.replace(/ /g, "-")}`
    if (!this.customAllergens.some((a) => a.id === id)) {
      const label = word.charAt(0).toUpperCase() + word.slice(1)
      const aliases = word.endsWith("s") ? [word, word.slice(0, -1)] : [word, word + "s", word + "es"]
      this.customAllergens.push({id, label, group, aliases})
      print(`AllergyLens: added custom ${group} item "${label}" (${aliases.join(", ")})`)
    }
    this.profile.set(id, true)
    this.showCustomItems()
    this.recheckActive()
  }

  /** "Also avoiding: Mango (Allergies) · Lamb (Religious / cultural)". */
  private showCustomItems(): void {
    const active = this.customAllergens.filter((a) => this.profile.has(a.id))
    this.profilePanel.setCustomLabels(active.map((a) => a.group === "allergy" ? a.label : `${a.label} (${GROUP_LABELS[a.group]})`))
  }

  /**
   * Mood chips that contradict the profile are switched off: a vegetarian or vegan gets no
   * Chicken / Red meat / Seafood; no beef + no pork switches off Red meat; fish + shellfish
   * switches off Seafood. A selected chip that goes off falls back to Everything.
   */
  private updateMoodAvailability(): void {
    const veg = this.profile.has("meat") || this.profile.has("vegan")
    const off: {[m: string]: boolean} = {
      chicken: veg,
      red_meat: veg || (this.profile.has("beef") && this.profile.has("pork")),
      seafood: veg || (this.profile.has("fish") && this.profile.has("shellfish")),
    }
    for (const m of MOODS) this.profilePanel.setMoodEnabled(m.id, !off[m.id])
    if (off[this.mood]) {
      print(`AllergyLens: mood ${this.mood} contradicts the profile; back to everything`)
      this.mood = "everything"
      this.profilePanel.setMood("everything")
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
    if (!this.anyMarkerActive()) this.voice?.stop()
    print(`AllergyLens: profile done [${this.profile.ids().join(", ")}]`)
    this.recheckActive()
  }

  private openProfile(): void {
    this.audio?.playClick()
    this.closeDetail()
    this.profilePanel.getSceneObject().enabled = true
    this.profileButton.getSceneObject().enabled = false
    this.profilePanel.setHeard(WELCOME)
    this.voice?.start()
    print("AllergyLens: profile reopened")
  }

  private anyMarkerActive(): boolean {
    return this.overlays.some((o) => o.isActive) || this.products.some((p) => p.isActive)
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
    this.lookupUnknownDishes(restaurantId)
    this.voice?.start()
  }

  // ── Miss path ──────────────────────────────────────────────────────────
  // Dishes the data does not know (ingredientsSource "none", drawn amber) are asked from the
  // lookup server next to menus.json: cache first (answers in ms), web retrieval on a miss
  // ("researching": the Lens asks again a few seconds later). The marks stay amber until an
  // answer arrives; nothing waits on the network and a timeout changes nothing on the page.
  private static readonly LOOKUP_TIMEOUT_S = 4.0
  private static readonly LOOKUP_RETRY_S = 8.0
  private static readonly LOOKUP_ATTEMPTS = 3
  private static readonly LOOKUP_MAX_PER_PAGE = 12
  private lookupAsked = new Set<string>()

  private lookupBase(): string | null {
    const u = (this.menusUrl || "").trim()
    if (!u) return null
    return u.replace(/\/menus(\.json)?(\?.*)?$/, "") + "/lookup"
  }

  private lookupUnknownDishes(restaurantId: string, attempt: number = 1): void {
    const base = this.lookupBase()
    const restaurant = getRestaurant(restaurantId)
    if (!base || !restaurant) return
    const unknown = restaurant.dishes
      .filter((d) => d.ingredientsSource === "none" && (attempt > 1 || !this.lookupAsked.has(`${restaurantId}/${d.id}`)))
      .slice(0, AllergyLensMain.LOOKUP_MAX_PER_PAGE)
    if (unknown.length === 0) return
    print(`AllergyLens: asking ${base} about ${unknown.length} unknown dish(es) (attempt ${attempt})`)
    let pending = unknown.length
    let filled = 0
    let researching = 0
    for (const dish of unknown) {
      this.lookupAsked.add(`${restaurantId}/${dish.id}`)
      this.fetchLookup(base, dish.name, restaurant.cuisine)
        .then(
          (r) => {
            if (r.status === "typical" && r.ingredients.length > 0) {
              dish.ingredients = r.ingredients
              dish.ingredientsSource = r.fromModel ? "model" : "typical"
              filled++
            } else if (r.status === "researching") {
              researching++
            }
          },
          (e) => print(`AllergyLens: lookup failed for "${dish.name}" (${e})`),
        )
        .then(() => {
          if (--pending > 0) return
          if (filled > 0) {
            print(`AllergyLens: ${filled} dish(es) filled from the lookup server`)
            this.recheckActive()
          }
          if (researching > 0 && attempt < AllergyLensMain.LOOKUP_ATTEMPTS) {
            print(`AllergyLens: ${researching} dish(es) being researched; asking again in ${AllergyLensMain.LOOKUP_RETRY_S}s`)
            const t = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
            t.bind(() => this.lookupUnknownDishes(restaurantId, attempt + 1))
            t.reset(AllergyLensMain.LOOKUP_RETRY_S)
          }
        })
    }
  }

  private fetchLookup(base: string, name: string, cuisine: string | null): Promise<{status: string; ingredients: string[]; fromModel: boolean}> {
    const internet = require("LensStudio:InternetModule") as InternetModule
    const url = `${base}?dish=${encodeURIComponent(name)}` + (cuisine ? `&cuisine=${encodeURIComponent(cuisine)}` : "")
    const timeout = new Promise<never>((_, reject) => {
      const t = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
      t.bind(() => reject(new Error(`timeout ${AllergyLensMain.LOOKUP_TIMEOUT_S}s`)))
      t.reset(AllergyLensMain.LOOKUP_TIMEOUT_S)
    })
    const call = internet.fetch(url, {method: "GET"}).then(async (res) => {
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as {status?: unknown; ingredients?: unknown; from?: unknown}
      const status = typeof j.status === "string" ? j.status : "unknown"
      const ingredients = Array.isArray(j.ingredients) ? j.ingredients.filter((x) => typeof x === "string").map((x) => String(x).toLowerCase()) : []
      const fromModel = typeof j.from === "string" && j.from.indexOf("llm") === 0
      return {status, ingredients, fromModel}
    })
    return Promise.race([call, timeout])
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
  /**
   * A final transcript. With the profile panel open: "I'm allergic to mango" / "no coriander"
   * adds it to the profile. With a menu in view: match a dish name and act like a pinch.
   */
  private onVoice(text: string): void {
    if (this.profilePanel.getSceneObject().enabled) {
      this.handlePanelVoice(text)
      return
    }
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

  /**
   * Voice control of the profile panel. In order:
   *   "done" / "finished" / "that's it"              → Done
   *   "turn off milk" / "remove milk" / "clear milk"  → that toggle off
   *   "peanuts", "no pork", "vegan", "avoid high sugar" → that toggle on (label, id or any alias)
   *   "chicken" / "in the mood for seafood" / "everything" → the mood chip (if the profile allows it)
   *   "I'm allergic to mango" / "no mango"            → custom allergen (anything not on the panel)
   *   "allergies" / "religious" / "diet"              → just acknowledged (the whole panel is in view)
   */
  private handlePanelVoice(raw: string): void {
    const text = raw.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim()
    const short = raw.length > 48 ? raw.slice(0, 45) + "…" : raw
    const heard = (what: string) => this.profilePanel.setHeard(`Heard: "${short}" → ${what}`)
    if (/^(done|finished|finish|that's it|thats it|okay done|ok done|i'm done|im done)$/.test(text)) {
      print(`AllergyLens: voice "${raw}" → Done`)
      heard("Done")
      this.onProfileDone()
      return
    }
    if (/^(please |ok |okay )?(clear|clear all|clear everything|reset|reset all|start over|start again|remove everything|remove all)( please)?$/.test(text)) {
      this.resetProfile()
      print(`AllergyLens: voice "${raw}" → profile cleared`)
      heard("profile cleared")
      return
    }
    // Natural speech: drop politeness and filler, then look for every toggle named anywhere in
    // the sentence ("please pick no beef on the religious side, right" → No beef on;
    // "no beef and no pork" → both). "turn off / remove / don't need" anywhere → off.
    const cleaned = text
      .replace(/\b(uh|um|ah|please|okay|ok|right|yeah|yes|so|can you|could you|pick|select|tick|choose|mark|set|put|on the \w+ side|on \w+ side|for me|i want|i'd like|i would like|to do|would like to)\b/g, " ")
      .replace(/\s+/g, " ").trim()
    // "allergies, add mango" / "religious add lamb" / "diet, also keto": an item for that section.
    const sectionAdd = /^(allergies|allergy|allergic|religious|religion|cultural|culture|diet|dietary|diets)\s*,?\s*(add|also|plus|and|include|put)\s+(.+)$/.exec(cleaned)
    if (sectionAdd) {
      const group = SECTION_WORDS[sectionAdd[1]]
      const item = sectionAdd[3].replace(/^(a|an|the|some|one more|more|another)\s+/, "").replace(/\s+(please|too|also|as well)$/, "").trim()
      if (NOT_A_FOOD.test(item) || item.length < 3) {
        heard(`say what to add, e.g. "${sectionAdd[1]}, add mango"`)
        return
      }
      const existing = this.findTogglesInSentence(item)
      if (existing.length > 0) {
        for (const t of existing) { this.profile.set(t.id, true); this.profilePanel.setToggle(t.id, true) }
        heard(existing.map((t) => `${t.label} on`).join(", "))
        this.audio?.playClick()
        this.updateMoodAvailability()
        this.recheckActive()
        return
      }
      print(`AllergyLens: voice "${raw}" → ${group}: add ${item}`)
      heard(`${GROUP_LABELS[group]}: avoid ${item}`)
      this.audio?.playClick()
      this.addCustomAllergen(item, group)
      return
    }
    const off = /\b(turn off|switch off|remove|unselect|deselect|clear|undo|cancel|don't need|do not need|not anymore)\b/.test(cleaned)
    const found = this.findTogglesInSentence(cleaned)
    if (found.length > 0) {
      const on = !off
      for (const toggle of found) {
        this.profile.set(toggle.id, on)
        this.profilePanel.setToggle(toggle.id, on)
        if (on && toggle.implies) for (const id of toggle.implies) { this.profile.set(id, true); this.profilePanel.setToggle(id, true) }
        print(`AllergyLens: voice "${raw}" → ${toggle.id} ${on ? "on" : "off"}`)
      }
      this.audio?.playClick()
      heard(found.map((t) => `${t.label} ${on ? "on" : "off"}`).join(", "))
      this.updateMoodAvailability()
      this.recheckActive()
      return
    }
    const wanted = cleaned
    const mood = this.moodByName(wanted)
    if (mood) {
      const veg = this.profile.has("meat") || this.profile.has("vegan")
      const blocked = (mood.id === "chicken" && veg) || (mood.id === "red_meat" && (veg || (this.profile.has("beef") && this.profile.has("pork"))))
        || (mood.id === "seafood" && (veg || (this.profile.has("fish") && this.profile.has("shellfish"))))
      if (blocked) {
        print(`AllergyLens: voice "${raw}" — ${mood.label} contradicts the profile`)
        heard(`${mood.label} not allowed by your profile`)
        return
      }
      this.mood = mood.id
      this.profilePanel.setMood(mood.id)
      this.audio?.playClick()
      print(`AllergyLens: voice "${raw}" → mood ${mood.id}`)
      heard(`mood ${mood.label}`)
      this.recheckActive()
      return
    }
    if (/^(on |in |under |the )*(allergies|allergy|religious|religious cultural|cultural|diet|dietary|preferences|mood|what am i in the mood for)$/.test(cleaned)) {
      print(`AllergyLens: voice "${raw}" — section is in view; say a toggle, e.g. "peanuts" or "no pork"`)
      heard("that section is in view; say a toggle, e.g. peanuts")
      return
    }
    const item = parseAllergyPhrase(raw)
    if (item) {
      if (NOT_A_FOOD.test(item)) {
        heard('say what to avoid, e.g. "I\'m allergic to mango"')
        return
      }
      print(`AllergyLens: voice "${raw}" → avoid ${item}`)
      heard(`avoid ${item}`)
      this.audio?.playClick()
      this.addCustomAllergen(item)
      return
    }
    if (/\b(done|finished|that's it|thats it|that is it|all set|i'm good|im good)\b/.test(text)) {
      print(`AllergyLens: voice "${raw}" → Done`)
      heard("Done")
      this.onProfileDone()
      return
    }
    print(`AllergyLens: voice "${raw}" — not understood; say a toggle name, a mood, "I'm allergic to …" or "done"`)
    heard("not a command (try: peanuts, no pork, vegetarian, done)")
  }

  /**
   * Every toggle named anywhere in a sentence: by label ("no beef", "milk / dairy"), its core
   * word ("beef", "dairy", "gluten", "sugar"), its id, or an alias ("bacon") — as whole words.
   * Moods are checked first so "chicken" is the chip, not the vegetarian toggle's alias.
   */
  private findTogglesInSentence(sentence: string): AllergenDef[] {
    const s = ` ${sentence} `
    const has = (phrase: string) => phrase.length > 1 && s.indexOf(` ${phrase} `) >= 0
    const out: AllergenDef[] = []
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
    const isMoodWord = !!this.moodByName(sentence)
    const matchedWords = new Set<string>()
    // Pass 1: names. Pass 2: synonyms, but never for the umbrella toggles (Vegetarian and
    // Vegan list beef, pork, chicken… as synonyms; "no pork" must not switch Vegetarian on)
    // and never on a word that already named another toggle.
    for (const a of ALLERGENS) {
      const label = norm(a.label)
      const core = label.replace(/^(no|avoid) /, "")
      const words = core.split(" ").filter((w) => w.length > 2)
      const spoken = (a.spoken ?? []).map(norm)
      const hitWord = [label, core, a.id, a.id.replace("_", " ")].concat(words).concat(spoken).find((w) => has(w))
      if (hitWord !== undefined) {
        out.push(a)
        matchedWords.add(hitWord)
      }
    }
    if (!isMoodWord) {
      for (const a of ALLERGENS) {
        if (out.indexOf(a) >= 0 || a.implies || a.id === "meat") continue
        if (a.aliases.some((al) => has(norm(al)) && !matchedWords.has(norm(al)))) out.push(a)
      }
    }
    // "vegetarian" names the Diet toggle AND a mood chip: with the panel open the toggle wins.
    return out
  }

  /** "chicken", "in the mood for seafood", "red meat", "everything" → the mood chip, or null. */
  private moodByName(phrase: string): {id: Mood; label: string} | null {
    const t = phrase.replace(/^(i'm |im |i am )?(in the mood for|mood|show me|only|just)\s+/, "").replace(/\s+(mood|only|please)$/, "").trim()
    return MOODS.find((m) => m.id === t || m.label.toLowerCase() === t || t === m.id.replace("_", " ")) ?? null
  }

  /**
   * A toggle by what people call it: label ("No pork", "Milk / dairy", "Avoid high sugar"), a
   * word of it ("dairy", "sugar"), its id, or — with aliases — any alias ("gluten", "bacon").
   */
  private findToggleByName(phrase: string, withAliases: boolean): AllergenDef | null {
    const p = phrase.trim()
    if (p.length < 2) return null
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
    for (const a of ALLERGENS) {
      const label = norm(a.label)
      const core = label.replace(/^(no|avoid) /, "")
      if (p === label || p === core || p === "no " + core || p === a.id || p === a.id.replace("_", " ")) return a
      const parts = core.split(" ").filter((w) => w.length > 2)
      if (parts.some((w) => p === w)) return a
    }
    if (withAliases) for (const a of ALLERGENS) if (a.aliases.some((al) => norm(al) === p)) return a
    return null
  }

  private recheckActive(): void {
    for (const o of this.overlays) if (o.isActive) this.runCheck(o.restaurantId)
    for (const p of this.products) if (p.isActive) this.runProductCheck(p.barcode)
  }

  // ── Products ───────────────────────────────────────────────────────────
  private onProductFound(barcode: string): void {
    this.audio?.playScan()
    print(`AllergyLens: product recognised — ${barcode}`)
    this.buttonShowTimer?.cancel()
    if (this.profilePanel.getSceneObject().enabled) {
      this.profilePanel.getSceneObject().enabled = false
      print(`AllergyLens: profile panel closed by recognition [${this.profile.ids().join(", ")}]`)
    }
    this.profileButton.getSceneObject().enabled = false
    this.runProductCheck(barcode)
  }

  private onProductLost(barcode: string): void {
    print(`AllergyLens: product lost — ${barcode}`)
    if (this.openProduct === barcode) this.closeDetail()
    if (!this.anyMarkerActive()) this.buttonShowTimer?.reset(1.0)
  }

  private runProductCheck(barcode: string): void {
    const overlay = this.products.find((p) => p.barcode === barcode)
    const product = getProduct(barcode)
    if (!overlay || !product) return
    const result = checkProduct(product, this.profile, this.allergens())
    this.productResults.set(barcode, result)
    const level = result.verdict === "contains" ? "avoid" : result.verdict === "unverified" ? "caution" : "good"
    const name = product.brand && product.name.toLowerCase().indexOf(product.brand.toLowerCase()) < 0 ? `${product.brand} ${product.name}` : product.name
    const verdictText = productChipText(result)
    const capacity = overlay.chipCapacityChars
    const candidates = [`${name} · ${verdictText}`, `${product.name} · ${verdictText}`, verdictText]
    overlay.setVerdict(level, candidates.find((c) => c.length <= capacity) ?? candidates[candidates.length - 1])
    print(`AllergyLens: product ${barcode} — ${result.verdict}; ${verdictText}`)
    if (this.openProduct === barcode) this.closeDetail()
  }

  private onProductPinched(barcode: string): void {
    if (this.openProduct === barcode) {
      this.closeDetail()
      return
    }
    const overlay = this.products.find((p) => p.barcode === barcode)
    const product = getProduct(barcode)
    const result = this.productResults.get(barcode)
    if (!overlay || !product || !result) return
    this.closeDetail()
    this.openProduct = barcode
    const text = describeProduct(product, result)
    this.placeDetailBeside(overlay.getSceneObject(), overlay.labelGeometry, true)
    this.dishDetail.showDetail({dishName: product.name, headline: text.headline, body: text.body})
    this.audio?.playPop()
    print(`AllergyLens: product detail open for ${barcode} — ${text.headline} ${text.body.replace(/\n/g, " ")}`)
  }

  private runCheck(restaurantId: string): void {
    const overlay = this.overlays.find((o) => o.restaurantId === restaurantId)
    const restaurant = getRestaurant(restaurantId)
    if (!overlay || !restaurant) return
    const results = checkMenu(restaurant.dishes, this.profile, this.allergens())
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

    const badge = rateRestaurant(restaurant, this.profile, this.allergens())
    const stars = restaurant.rating ? ` · ★${restaurant.rating.stars.toFixed(1)}` : ""
    const complaints = restaurant.rating?.allergyComplaints ?? 0
    const reviewsLong = complaints > 0 ? ` · ${complaints} review${complaints === 1 ? "" : "s"} mention${complaints === 1 ? "s" : ""} allergies` : ""
    const reviewsShort = complaints > 0 ? ` · ${complaints} allergy review${complaints === 1 ? "" : "s"}` : ""
    const core = everything
      ? `${badge.safeCount} of ${badge.total} safe`
      : `${safeInCategory} ${moodLabel(this.mood).toLowerCase().replace(/ dishes$/, "")} dish${safeInCategory === 1 ? "" : "es"} safe for you`
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
    if (this.openProduct) print(`AllergyLens: product detail closed for ${this.openProduct}`)
    this.openDish = null
    this.openProduct = null
    this.dishDetail.hideDetail()
  }

  /** Park the card on the page plane beside the bar, toward the page centre so it stays in view. */
  private placeDetailBesideBar(overlay: AllergyLensMenuOverlayUI, dishId: string): void {
    const g = overlay.getBarGeometry(dishId)
    if (!g) return
    this.placeDetailBeside(overlay.getSceneObject(), g)
  }

  /**
   * Park the card on a marker's plane next to a local rectangle (cm): beside it on the side
   * toward the centre (menu lines), or centred below it (a product label, which is wide
   * and sits in the middle of the display band).
   */
  private placeDetailBeside(parent: SceneObject, g: {x: number; y: number; w: number; h: number}, below: boolean = false): void {
    const cardW = this.dishDetail.cardWidthCm
    const side = g.x < 0 ? 1 : -1
    const lx = below ? g.x : g.x + side * (g.w / 2 + this.detailGapCm + cardW / 2)
    const ly = below ? g.y - (g.h / 2 + this.detailGapCm + this.dishDetail.cardHeightCm / 2) : g.y
    const root = this.dishDetail.getSceneObject()
    root.setParent(parent)
    const t = root.getTransform()
    t.setLocalPosition(new vec3(lx, ly, 1.0))
    t.setLocalRotation(quat.quatIdentity())
    t.setLocalScale(new vec3(1, 1, 1))
  }

  // ── Optional remote data ───────────────────────────────────────────────
  // Retried: right after Lens start the network can answer with a transport
  // status (seen as "HTTP 3" in the editor) before it is ready, and the
  // bundled data would then be used for the whole session.
  private static readonly REMOTE_ATTEMPTS = 4
  private static readonly REMOTE_RETRY_S = 2.0

  private loadRemoteMenus(url: string, attempt: number = 1): void {
    this.fetchRemoteMenus(url).then(
      (count) => print(`AllergyLens: loaded ${count} restaurants from ${url}`),
      (e) => {
        if (attempt < AllergyLensMain.REMOTE_ATTEMPTS) {
          print(`AllergyLens: remote menus attempt ${attempt} failed (${e}); retrying`)
          const t = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
          t.bind(() => this.loadRemoteMenus(url, attempt + 1))
          t.reset(AllergyLensMain.REMOTE_RETRY_S)
        } else {
          print(`AllergyLens: remote menus unavailable (${e}); using bundled data`)
        }
      },
    )
  }

  private async fetchRemoteMenus(url: string): Promise<number> {
    const internet = require("LensStudio:InternetModule") as InternetModule
    const response = await internet.fetch(url, {method: "GET"})
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
    const json = await response.json()
    const restaurants: RestaurantDef[] | null = validateMenus(json)
    if (!restaurants) throw new Error("menus.json shape not recognised")
    setRestaurants(restaurants)
    this.recheckActive()
    return restaurants.length
  }
}

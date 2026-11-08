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
import {AllergyLensSpeech, SpeechLine} from "./AllergyLensSpeech"
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {PROFILE_STEPS, ProfileStep, TILE_IDS} from "./AllergyLensProfileUI"

/** What the Heard line shows on each screen before anything was said, and what the Lens says aloud. */
const STEP_HINT: {[s in ProfileStep]: string} = {
  welcome: 'Say "start", or pinch Start.',
  allergies: 'Say yours, any number ("sesame, olive oil and garlic"), or "next".',
  religious: 'Say "no beef", "no pork", "no alcohol", or "next".',
  diet: 'Say "vegetarian", "vegan", "low sugar", "no trans fat", or "done".',
}
const STEP_SPEECH: {[s in ProfileStep]: SpeechLine} = {welcome: "welcome", allergies: "step_allergies", religious: "step_religious", diet: "step_diet"}
/** Horizontal field of view the glasses show (SPECS 27 simulation measures 32.3°); head-locked sizes are designed for it. */
const REF_FOV_H_DEG = 32.3
const STORE_IDS = "allergylens.profile.ids"
const STORE_CUSTOM = "allergylens.profile.custom"

/** "allergies, add mango" / "religious, add lamb" / "diet, add keto" → where a spoken addition belongs. */
const SECTION_WORDS: {[word: string]: AllergenGroup} = {
  allergies: "allergy", allergy: "allergy", allergic: "allergy",
  religious: "religious", religion: "religious", cultural: "religious", culture: "religious",
  diet: "diet", dietary: "diet", diets: "diet",
}
/** Never a food: pronouns, placeholders and every command word, so "Mm. Well, next." can never become a "Next" chip. */
const NOT_A_FOOD = /^(this|that|these|those|thing|things|something|anything|it|them|one|one more|more|another|another one|option|options|stuff|here|there|some|some more|the same|same|also|too|as well|next|back|done|start|begin|continue|skip|finish|finished|save|edit|keyboard|type|quiet|mute|speak|unmute|clear|reset|cancel|stop|wait|again|repeat|previous|yes|no|nope|nah|okay|ok|hello|hi|hey|thanks|thank you|nothing|none|never mind|nevermind)$/
/** Words that carry no food: dropped from a spoken part before it can become a custom item ("well i'm also allergic to" → nothing). */
const FILLER_WORDS = new Set(("well so yeah yes yep okay ok um uh hmm mm mmm hm er erm ah oh eh huh like just really actually basically i i'm im am me my we you he she they it is are was be " +
  "have has had do does did can could would should will also too as well and or but then please thanks thank think guess mean " +
  "allergic allergy allergies allergen allergens intolerant intolerance sensitive sensitivity eat eating food foods to of for with " +
  "the a an some any more another one other others add avoid no not don't dont want need got get").split(" "))

/**
 * Speech-to-text often glues a repeated answer into one transcript ("olive oil olive oil olive oil"
 * when the user said it three times waiting for a reaction): collapse any phrase said twice in a row.
 */
function collapseRepeats(text: string): string {
  const words = text.split(" ").filter((w) => w.length > 0)
  let changed = true
  while (changed) {
    changed = false
    for (let n = 1; n <= 4 && !changed; n++) {
      for (let i = 0; i + 2 * n <= words.length; i++) {
        if (words.slice(i, i + n).join(" ") === words.slice(i + n, i + 2 * n).join(" ")) {
          words.splice(i + n, n)
          changed = true
          break
        }
      }
    }
  }
  return words.join(" ")
}

/** Which group a bare food named on a setup screen belongs to. */
const STEP_GROUP: {[s in ProfileStep]: AllergenGroup} = {welcome: "allergy", allergies: "allergy", religious: "religious", diet: "diet"}

function foodWords(part: string): string {
  return part.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(" ").filter((w) => w.length > 0 && !FILLER_WORDS.has(w)).join(" ")
}

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
  @hint("Use Snap's ASR speech-to-text (the engine the glasses use) in the Lens Studio preview too. Off = the older VoiceML engine with the preview mic.")
  previewAsr: boolean = true

  @input
  @hint("The Lens speaks: welcome, each step's question, saved, menu recognised, and the verdict on a pinch (pre-rendered clips, Assets/Audio/Speech). Say \"quiet\" to mute.")
  speechEnabled: boolean = true

  @input
  @hint("The profile panel stays at a fixed distance in front of the user and turns to face them (lazy follow), so it always reads the same size. Off = it stays where it was placed.")
  panelFollowsHead: boolean = true

  @input
  @hint("Distance (cm) the panel keeps in front of the user while it follows.")
  @widget(new SliderWidget(50, 120, 5))
  panelDistanceCm: number = 80

  @input
  @hint("Remember the profile on the glasses (persistent storage) so setup runs once; the Profile button or \"edit profile\" changes it.")
  rememberProfile: boolean = true

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
  private speech: AllergyLensSpeech | null = null
  private spokenPages = new Set<string>()
  // The panel glides to the Profile button's spot when it closes and out of it when it reopens.
  private panelHome: {pos: vec3; scale: vec3} | null = null
  /** Head-locked UI scale: 1 on the glasses, larger in a wide-angle preview (see applyUiScale). */
  private uiScale = 1
  private uiScaleApplied = false
  private panelTween: {t0: number; dur: number; from: vec3; to: vec3; fromS: number; toS: number; onDone: () => void} | null = null
  private lastTickTime = 0
  private wantListening = false      // what the app wants; a dropped stream is reconnected while this is true
  private micRetryTimer: DelayedCallbackEvent | null = null
  private micRetries = 0
  private micHintSpoken = false
  private micWasLost = false
  private testMode = false   // set by the LEAF tests: no profile is saved on the device, and any saved one is cleared
  private micHintTimer: DelayedCallbackEvent | null = null
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
    if (this.speechEnabled) this.speech = new AllergyLensSpeech(audioHost, 1.0)
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind(() => {
      this.applyUiScale() // the view can change without a Lens reset (preview source, window)
      this.tickPanelTween()
    })
  }

  private onStart(): void {
    // Subscribe here, not in onAwake: the UI SceneObjects sit below this root in the
    // hierarchy, so their scripts (and their Event fields) only exist once OnStart runs.
    this.profilePanel.onToggle.add((e) => {
      this.profile.set(e.id, e.on)
      this.audio?.playClick()
      print(`AllergyLens: profile ${e.id} = ${e.on ? "on" : "off"}`)
      // Vegan covers vegetarian + no milk + no eggs inside the checker (implies); the tiles stay one choice:
      // picking Vegan switches Vegetarian off and vice versa.
      if (e.on && (e.id === "vegan" || e.id === "meat")) {
        const other = e.id === "vegan" ? "meat" : "vegan"
        if (this.profile.has(other)) { this.profile.set(other, false); this.profilePanel.setToggle(other, false) }
      }
      this.updateMoodAvailability()
      this.showCustomItems()
      this.recheckActive()
    })
    this.profilePanel.onStep.add((step) => this.onProfileStep(step))
    this.profilePanel.onMore.add(() => {
      this.audio?.playClick()
      this.onMoreRequested()
    })
    this.profilePanel.onEditCustom.add((text) => this.applyCustomText(text))
    this.profilePanel.onRemoveExtra.add((id) => this.removeExtra(id))
    // Corner controls: mic = listening on/off, speaker = voice on/off.
    this.profilePanel.onMicToggle.add(() => {
      // Off while listening; otherwise (off, or dropped) a fresh start.
      const on = !(this.wantListening && (this.voice?.isListening ?? false))
      this.listen(on)
      this.profilePanel.setHeard(on ? STEP_HINT[this.profilePanel.step] : "Microphone off. Pinch the mic to listen again.")
      this.audio?.playClick()
    })
    this.profilePanel.onSpeakerToggle.add(() => {
      if (!this.speech) return
      this.speech.setMuted(!this.speech.muted)
      this.profilePanel.setSpeaking(!this.speech.muted)
      this.audio?.playClick()
    })
    this.profilePanel.setSpeaking(!!this.speech && !this.speech.muted)
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
      else this.voice = new VoiceListener((text) => this.onVoice(text), inEditor && !this.previewAsr, (live) => this.onMicLive(live)) // glasses → ASR; preview → ASR unless previewAsr is off
    }
    this.safeCardTimer = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.safeCardTimer.bind(() => this.closeDetail())
    // If speech-to-text has not come alive a moment after we asked for it, say so on the panel.
    this.micHintTimer = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.micHintTimer.bind(() => {
      if (!this.profilePanel.getSceneObject().enabled || !this.voice || this.voice.micLive) return
      this.profilePanel.setListening(false)
      this.profilePanel.setHeard(global.deviceInfoSystem.isEditor()
        ? "Mic not live: reconnecting\u2026 (check the Preview panel's mic switch)"
        : "Mic not live: reconnecting\u2026 Pinching works meanwhile.")
      if (global.deviceInfoSystem.isEditor() && !this.micHintSpoken) {
        this.micHintSpoken = true
        this.speech?.say("mic_hint")
      }
    })
    // Snap's speech stream ends on its own after a few minutes: come back with a growing pause.
    this.micRetryTimer = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.micRetryTimer.bind(() => {
      if (!this.wantListening || !this.voice || this.voice.isListening) return
      this.micRetries++
      print(`AllergyLens: voice reconnect attempt ${this.micRetries}`)
      this.voice.start()
      this.profilePanel.setListening(this.voice.micLive)
      if (!this.voice.micLive && this.micRetries < 8) this.micRetryTimer?.reset(Math.min(30, 1.5 * Math.pow(2, this.micRetries - 1)))
    })
    this.buttonShowTimer = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.buttonShowTimer.bind(() => {
      if (!this.anyMarkerActive()) this.profileButton.getSceneObject().enabled = true
    })
    // Profile is a separate step before the menu: panel at start (unless a default
    // profile makes the run hands-free); the small Profile button only when the panel is
    // closed and no menu is in view.
    // The glasses remember the profile; the Lens Studio preview never does, so every preview run starts at Welcome.
    const remember = this.rememberProfile && !global.deviceInfoSystem.isEditor()
    const restored = this.profile.isEmpty && remember && this.restoreProfile()
    const panelAtStart = this.showProfileAtStart && this.profile.isEmpty && !restored
    this.profilePanel.getSceneObject().enabled = panelAtStart
    this.profileButton.getSceneObject().enabled = !panelAtStart
    try {
      global.userContextSystem.requestDisplayName((name: string) => this.profilePanel.setDisplayName(name))
    } catch (e) {
      print(`AllergyLens: no display name (${e})`)
    }
    this.rememberPanelHome()
    if (panelAtStart) {
      if (this.panelFollowsHead) {
        const target = this.panelTarget()
        this.profilePanel.getTransform().setWorldPosition(target.pos)
        this.profilePanel.getTransform().setWorldRotation(target.rot)
      }
      this.profilePanel.setStep("welcome")
      this.profilePanel.setHeard(STEP_HINT.welcome)
      this.listen(true) // the panel is voice-driven while it is open
      this.speech?.say("welcome")
    }
    this.dishDetail.hideDetail()
    this.applyUiScale()
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
    if (!enabled && !this.testMode) {
      // Only the LEAF tests turn the camera off: from here on nothing is remembered on the device.
      this.testMode = true
      this.clearSavedProfile()
    }
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

  /** The "in the mood for" filter: voice on the menu ("show vegetarian") and LEAF set it; no chips any more. */
  get currentMood(): Mood {
    return this.mood
  }

  setMood(id: Mood): boolean {
    if (!MOODS.some((m) => m.id === id)) return false
    this.mood = id
    this.updateMoodAvailability()
    this.recheckActive()
    return this.mood === id
  }

  /** One profile item on/off by id, through the same path a pinch takes (panel tile kept in sync). Public for LEAF. */
  setProfileItem(id: string, on: boolean): boolean {
    const def = ALLERGENS.find((a) => a.id === id)
    if (!def) return false
    this.applyToggle(def, on)
    this.updateMoodAvailability()
    this.showCustomItems()
    this.recheckActive()
    return this.profile.has(id) === on
  }

  hasProfileItem(id: string): boolean {
    return this.profile.has(id)
  }

  /** Everything off: toggles, custom allergens, mood back to Everything. Public for LEAF. */
  resetProfile(): void {
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
    // Only a category's own name flips its tile ("shellfish", "tree nuts", "dairy"). A specific food
    // ("octopus", "cashews", "bacon") stays the user's own word: its own chip, matched as that word.
    const known = ALLERGENS.find((a) => a.id === word || a.label.toLowerCase() === word || a.label.toLowerCase().replace(/^(no|avoid) /, "") === word
      || (a.spoken ?? []).indexOf(word) >= 0)
    if (known) {
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

  /**
   * More… (pinched or said): ask for the rest out loud AND open the typing box with the keyboard, so
   * the user can either say "banana, apple" (each becomes a chip) or type the list.
   */
  private onMoreRequested(): void {
    this.speech?.say("more")
    this.profilePanel.setEditing(true)
    this.profilePanel.setHeard("Say them (\u201csesame, olive oil and garlic\u201d), or type them.")
  }

  /** Tests feed a transcript here, exactly as speech-to-text would deliver it. Public for LEAF. */
  hearVoice(text: string): void {
    if (this.profilePanel.getSceneObject().enabled) this.handlePanelVoice(text)
    else this.onVoice(text)
  }

  /** Chips on the allergies screen: every profile item without a tile (fish, soy, sesame, anything spoken). */
  private showCustomItems(): void {
    const items: Array<{id: string; label: string}> = []
    for (const a of ALLERGENS) if (this.profile.has(a.id) && TILE_IDS.indexOf(a.id) < 0) items.push({id: a.id, label: a.label.replace(/^(No|Avoid) /, "")})
    for (const c of this.customAllergens) if (this.profile.has(c.id)) items.push({id: c.id, label: c.group === "allergy" ? c.label : `${c.label} (${GROUP_LABELS[c.group]})`})
    this.profilePanel.setExtras(items)
  }

  /** A chip was pinched off. */
  private removeExtra(id: string): void {
    this.profile.set(id, false)
    this.customAllergens = this.customAllergens.filter((c) => c.id !== id)
    const known = ALLERGENS.find((a) => a.id === id)
    if (known) this.profilePanel.setToggle(id, false)
    this.audio?.playClick()
    this.showCustomItems()
    this.updateMoodAvailability()
    this.recheckActive()
    print(`AllergyLens: removed ${id} from the profile`)
  }

  /**
   * One spoken item on the allergies screen: a known toggle ("fish", "no pork") goes on, anything
   * else that looks like a food becomes a custom item. Returns what was done, or null.
   */
  private applySpokenItem(part: string, group: AllergenGroup = "allergy"): string | null {
    const item = foodWords(part)
    if (item.length < 3 || NOT_A_FOOD.test(item)) return null
    const toggles = this.findTogglesInSentence(item)
    if (toggles.length > 0) {
      for (const t of toggles) { this.profile.set(t.id, true); this.profilePanel.setToggle(t.id, true) }
      return toggles.map((t) => `${t.label} on`).join(", ")
    }
    if (item.split(" ").length > 4) return null
    this.addCustomAllergen(item, group)
    return `avoid ${item}`
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
    if (off[this.mood]) {
      print(`AllergyLens: mood ${this.mood} contradicts the profile; back to everything`)
      this.mood = "everything"
    }
  }

  private applyDefaultMood(): void {
    const id = this.defaultMood.trim() as Mood
    if (!MOODS.some((m) => m.id === id)) {
      if (id.length > 0) print(`AllergyLens: defaultMood "${id}" unknown; using everything`)
      return
    }
    this.mood = id
  }

  private onProfileDone(): void {
    this.audio?.playClick()
    this.dismissPanel()
    if (!this.anyMarkerActive()) this.listen(false)
    if (this.rememberProfile && !global.deviceInfoSystem.isEditor()) this.saveProfile()
    this.speech?.say("saved")
    print(`AllergyLens: profile done [${this.profile.ids().join(", ")}]`)
    // Hand-over: whatever page or product is already in view is picked up now, as if it had just been found.
    for (const o of this.overlays) if (o.isActive) this.onMarkerFound(o.restaurantId)
    for (const p of this.products) if (p.isActive) this.onProductFound(p.barcode)
    this.recheckActive()
  }

  private openProfile(): void {
    this.audio?.playClick()
    this.closeDetail()
    this.profileButton.getSceneObject().enabled = false
    this.presentPanel()
    this.profilePanel.setStep("allergies")
    this.profilePanel.setHeard(STEP_HINT.allergies)
    this.listen(true)
    this.speech?.say("reopened")
    print("AllergyLens: profile reopened")
  }

  /**
   * The glasses show about 32° across, and every head-locked size here (panel 34 cm at 80 cm, 7 cm
   * button, card text) is designed for that. Lens Studio's preview on phone footage renders about 66°
   * across, so the same centimetres become an unreadable stamp. Scale the head-locked UI so it keeps the
   * share of the view it has on the glasses; marks on the menu stay in page centimetres. ×1 on device.
   *
   * Runs every frame and only touches the scene when the view changes: the preview can switch between the
   * room and a video without a Lens reset, and the camera's fov property is not always what is rendered
   * (Lens Studio 5.24 reports a wide capture-camera fov in the SPECS 27 room while drawing 32°), so the
   * view is measured from the camera's real projection instead.
   */
  private applyUiScale(): void {
    let fovH: number
    try {
      fovH = this.measureViewAcrossDeg()
    } catch (e) {
      if (!this.uiScaleApplied) print(`AllergyLens: camera field of view unavailable (${e})`)
      return
    }
    const k = Math.min(3, Math.max(1, Math.tan((fovH * Math.PI) / 360) / Math.tan((REF_FOV_H_DEG * Math.PI) / 360)))
    if (this.uiScaleApplied && Math.abs(k - this.uiScale) < 0.02) return
    this.uiScale = k
    this.uiScaleApplied = true
    const s = new vec3(k, k, k)
    if (this.panelHome) this.panelHome.scale = s
    if (!this.panelTween) this.profilePanel.getSceneObject().getTransform().setLocalScale(s)
    this.profileButton.getSceneObject().getTransform().setLocalScale(s)
    this.dishDetail.getSceneObject().getTransform().setLocalScale(s)
    print(`AllergyLens: view ${fovH.toFixed(1)}° across${k > 1.01 ? ` — head-locked UI scaled ×${k.toFixed(2)} to stay readable` : ""}`)
  }

  /**
   * Degrees the camera really shows across: project two points 20 cm either side of the view centre, 1 m
   * ahead, and read how much of the screen width they span. Falls back to the camera's fov property when
   * the projection is unusable.
   */
  private measureViewAcrossDeg(): number {
    const cam = WorldCameraFinderProvider.getInstance().getComponent()
    const t = cam.getTransform()
    const rot = t.getWorldRotation()
    const ahead = t.getWorldPosition().add(rot.multiplyVec3(new vec3(0, 0, -100)))
    const right = rot.multiplyVec3(new vec3(20, 0, 0))
    const span = cam.worldSpaceToScreenSpace(ahead.add(right)).x - cam.worldSpaceToScreenSpace(ahead.sub(right)).x
    if (isFinite(span) && span > 0.01 && span < 2) return (2 * Math.atan(0.2 / span) * 180) / Math.PI
    return (2 * Math.atan(Math.tan(cam.fov / 2) * cam.aspect) * 180) / Math.PI
  }

  // ── Panel motion ───────────────────────────────────────────────────────
  private rememberPanelHome(): void {
    if (this.panelHome) return
    const t = this.profilePanel.getTransform()
    this.panelHome = {pos: t.getLocalPosition(), scale: t.getLocalScale()}
  }

  /** Done: the panel shrinks and slides to where the Profile button lives, then the button takes over. */
  private dismissPanel(): void {
    if (this.panelTween) return
    this.rememberPanelHome()
    const panelSO = this.profilePanel.getSceneObject()
    const t = this.profilePanel.getTransform()
    const to = this.profileButton.getTransform().getWorldPosition()
    this.panelTween = {
      t0: getTime(), dur: 0.4, from: t.getWorldPosition(), to, fromS: 1, toS: 0.12,
      onDone: () => {
        panelSO.enabled = false
        t.setLocalPosition(this.panelHome!.pos)
        t.setLocalScale(this.panelHome!.scale)
        this.profileButton.getSceneObject().enabled = !this.anyMarkerActive()
      },
    }
  }

  /** Reopen: out of the button's spot back to its place in front of the user. */
  private presentPanel(): void {
    this.rememberPanelHome()
    const panelSO = this.profilePanel.getSceneObject()
    const t = this.profilePanel.getTransform()
    t.setLocalPosition(this.panelHome!.pos)
    t.setLocalScale(this.panelHome!.scale)
    const home = this.panelFollowsHead ? this.panelTarget().pos : t.getWorldPosition()
    if (this.panelFollowsHead) t.setWorldRotation(this.panelTarget().rot)
    const from = this.profileButton.getTransform().getWorldPosition()
    panelSO.enabled = true
    if (this.panelTween) return
    t.setWorldPosition(from)
    t.setLocalScale(this.panelHome!.scale.uniformScale(0.12))
    this.panelTween = {
      t0: getTime(), dur: 0.35, from, to: home, fromS: 0.12, toS: 1,
      onDone: () => {
        t.setLocalScale(this.panelHome!.scale)
        if (!this.panelFollowsHead) t.setLocalPosition(this.panelHome!.pos)
      },
    }
  }

  private tickPanelTween(): void {
    const now = getTime()
    const dt = this.lastTickTime > 0 ? Math.min(0.1, now - this.lastTickTime) : 0
    this.lastTickTime = now
    this.followHead(dt)
    const tw = this.panelTween
    if (!tw || !this.panelHome) return
    const k = Math.min(1, (getTime() - tw.t0) / tw.dur)
    const e = 1 - (1 - k) * (1 - k) // ease-out
    const t = this.profilePanel.getTransform()
    t.setWorldPosition(vec3.lerp(tw.from, tw.to, e))
    t.setLocalScale(this.panelHome.scale.uniformScale(tw.fromS + (tw.toS - tw.fromS) * e))
    if (k >= 1) {
      this.panelTween = null
      tw.onDone()
    }
  }

  private onProfileStep(step: ProfileStep): void {
    this.audio?.playClick()
    this.profilePanel.setHeard(STEP_HINT[step])
    this.speech?.say(STEP_SPEECH[step])
    print(`AllergyLens: profile step ${step}`)
  }

  /** Move the setup one screen forward / back by voice. */
  private stepBy(delta: number): boolean {
    const i = PROFILE_STEPS.indexOf(this.profilePanel.step) + delta
    if (i < 0 || i >= PROFILE_STEPS.length) return false
    this.profilePanel.setStep(PROFILE_STEPS[i])
    this.onProfileStep(PROFILE_STEPS[i])
    return true
  }

  /** Speech-to-text on/off, with the panel's mic dot following it. */
  private listen(on: boolean): void {
    this.wantListening = on
    this.micRetries = 0
    this.micRetryTimer?.cancel()
    if (on) this.voice?.start()
    else this.voice?.stop()
    this.profilePanel.setListening(on && (this.voice?.micLive ?? false))
    if (on && this.voice && !this.voice.micLive) {
      this.micHintTimer?.reset(2.5)
      this.micRetryTimer?.reset(1.5)
    }
  }

  /** The microphone came alive, or the stream dropped while we wanted it. */
  private onMicLive(live: boolean): void {
    const panelOpen = this.profilePanel.getSceneObject().enabled
    this.profilePanel.setListening(live && (this.voice?.isListening ?? false))
    if (live) {
      this.micRetries = 0
      this.micRetryTimer?.cancel()
      this.micHintTimer?.cancel()
      if (panelOpen) this.profilePanel.setHeard(STEP_HINT[this.profilePanel.step])
      if (this.micWasLost) this.speech?.say("mic_back")
      this.micWasLost = false
      print("AllergyLens: microphone live")
    } else if (this.wantListening) {
      this.micWasLost = true
      if (panelOpen) this.micHintTimer?.reset(0.5)
      this.micRetryTimer?.reset(1.5)
    }
  }

  /** Where the panel belongs: panelDistanceCm straight ahead, a little below eye line, facing the user. */
  private panelTarget(): {pos: vec3; rot: quat} {
    const cam = WorldCameraFinderProvider.getInstance().getTransform()
    const rot = cam.getWorldRotation()
    const look = rot.multiplyVec3(new vec3(0, 0, -1))
    const up = rot.multiplyVec3(new vec3(0, 1, 0))
    // While the typing field and keyboard hang below the plate, the panel rides up by half of them so the whole stack is centred in view.
    const yOff = (this.panelHome ? this.panelHome.pos.y : -2) + (this.profilePanel.belowPanelCm / 2) * this.uiScale
    return {pos: cam.getWorldPosition().add(look.uniformScale(this.panelDistanceCm)).add(up.uniformScale(yOff)), rot}
  }

  /**
   * Where the Profile button lives: lower-right of the view at 55 cm, following the head like the panel.
   * 9 cm right and 8 cm down keep the whole 7 cm icon inside the view (≈13° off centre with the icon's
   * edge; the preview shows about ±15°, the glasses a little more). Further out it is cut off.
   */
  private buttonTarget(): {pos: vec3; rot: quat} {
    const cam = WorldCameraFinderProvider.getInstance().getTransform()
    const rot = cam.getWorldRotation()
    const look = rot.multiplyVec3(new vec3(0, 0, -1))
    const up = rot.multiplyVec3(new vec3(0, 1, 0))
    const right = rot.multiplyVec3(new vec3(1, 0, 0))
    // 9 cm right, 8 cm down at 55 cm is the lower-right corner of the glasses' view; scale the offset with the UI
    // so the button keeps that corner in a wider preview instead of sitting in the middle of the picture.
    // The icon itself is a child of this group: pinch-and-drag (SIK manipulation) moves the child, so the place
    // the user puts it becomes a local offset that rides along with the group.
    const k = this.uiScale
    return {pos: cam.getWorldPosition().add(look.uniformScale(55)).add(right.uniformScale(9 * k)).add(up.uniformScale(-8 * k)), rot}
  }

  /** Lazy follow: the panel drifts back in front of the user when they turn or move, never snapping. */
  private followHead(dt: number): void {
    if (this.panelFollowsHead && !this.panelTween) {
      // The Profile button keeps its corner of the view whenever it is shown (the glide targets this spot too).
      const bt = this.buttonTarget()
      const b = this.profileButton.getTransform()
      if (this.profileButton.getSceneObject().enabled) {
        const k = 1 - Math.exp(-dt * 5)
        b.setWorldPosition(vec3.lerp(b.getWorldPosition(), bt.pos, k))
        b.setWorldRotation(quat.slerp(b.getWorldRotation(), bt.rot, k))
      } else {
        b.setWorldPosition(bt.pos)
        b.setWorldRotation(bt.rot)
      }
    }
    if (!this.panelFollowsHead || this.panelTween || !this.profilePanel.getSceneObject().enabled) return
    const t = this.profilePanel.getTransform()
    const target = this.panelTarget()
    const pos = t.getWorldPosition()
    const dist = pos.distance(target.pos)
    // Dead zone of 6 cm, then ease in: far away → quick, close → gentle.
    if (dist > 6 || this.panelSettling) {
      this.panelSettling = dist > 1.0
      const k = 1 - Math.exp(-dt * (dist > 30 ? 6 : 3))
      t.setWorldPosition(vec3.lerp(pos, target.pos, k))
      t.setWorldRotation(quat.slerp(t.getWorldRotation(), target.rot, k))
    }
  }
  private panelSettling = false

  /** The keyboard field's text ("mango, coriander") adds each item. */
  /** Typed on the keyboard and Done: each comma-separated part is ADDED (a known category lights its tile, anything else is a chip). */
  private applyCustomText(text: string): void {
    const added: string[] = []
    for (const part of text.split(/[,;]+/)) {
      const word = foodWords(part)
      if (word.length < 2 || NOT_A_FOOD.test(word)) continue
      this.addCustomAllergen(word)
      added.push(word)
    }
    this.showCustomItems()
    this.audio?.playClick()
    this.profilePanel.setHeard(added.length > 0 ? `Added: ${added.join(", ")}` : "Nothing typed")
    this.recheckActive()
  }

  // ── Remembered profile (persistent storage on the glasses) ─────────────
  private saveProfile(): void {
    if (this.testMode) return
    try {
      const store = global.persistentStorageSystem.store
      store.putString(STORE_IDS, ALLERGENS.filter((a) => this.profile.has(a.id)).map((a) => a.id).join(","))
      store.putString(STORE_CUSTOM, JSON.stringify(this.customAllergens.filter((c) => this.profile.has(c.id)).map((c) => ({label: c.label, group: c.group}))))
      print("AllergyLens: profile saved on the device")
    } catch (e) {
      print(`AllergyLens: could not save the profile (${e})`)
    }
  }

  /** Tests call this (through setCameraTracking(false)): forget the saved profile so a later manual run starts at Welcome. */
  private clearSavedProfile(): void {
    try {
      const store = global.persistentStorageSystem.store
      store.remove(STORE_IDS)
      store.remove(STORE_CUSTOM)
    } catch (e) {
      print(`AllergyLens: could not clear the saved profile (${e})`)
    }
  }

  /** True when a saved profile was applied (setup is skipped; the Profile button edits it). */
  private restoreProfile(): boolean {
    try {
      const store = global.persistentStorageSystem.store
      const ids = (store.getString(STORE_IDS) || "").split(",").map((x) => x.trim()).filter((x) => x.length > 0)
      const custom = JSON.parse(store.getString(STORE_CUSTOM) || "[]") as Array<{label: string; group: AllergenGroup}>
      if (ids.length === 0 && custom.length === 0) return false
      for (const id of ids) if (ALLERGENS.some((a) => a.id === id)) { this.profile.set(id, true); this.profilePanel.setToggle(id, true) }
      for (const c of custom) if (foodWords(c.label).length >= 3) this.addCustomAllergen(foodWords(c.label), c.group)
      this.updateMoodAvailability()
      print(`AllergyLens: profile restored from the device [${this.profile.ids().join(", ")}]`)
      return true
    } catch (e) {
      print(`AllergyLens: no saved profile (${e})`)
      return false
    }
  }

  private anyMarkerActive(): boolean {
    return this.overlays.some((o) => o.isActive) || this.products.some((p) => p.isActive)
  }

  // ── Marker lifecycle ───────────────────────────────────────────────────
  private onMarkerFound(restaurantId: string): void {
    // While the profile is being set up, the page waits: no marks, no voice line, the panel stays. The moment
    // Done is pinched the pages in view are picked up (see onProfileDone), which is the hand-over from
    // "set up your profile" to "look at the menu".
    if (this.profilePanel.getSceneObject().enabled) {
      print(`AllergyLens: menu in view (${restaurantId}) — waiting for the profile to finish`)
      return
    }
    this.audio?.playScan()
    print(`AllergyLens: menu recognised — ${restaurantId}`)
    // Nothing but bars, badge and (on pinch) the detail card over the page: the Profile button hides.
    this.buttonShowTimer?.cancel()
    this.profileButton.getSceneObject().enabled = false
    this.runCheck(restaurantId)
    this.lookupUnknownDishes(restaurantId)
    this.listen(true)
    if (!this.spokenPages.has(restaurantId)) {
      this.spokenPages.add(restaurantId)
      this.speech?.say("menu_found")
    }
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
      this.listen(false)
    }
  }

  // ── Voice ──────────────────────────────────────────────────────────────
  /**
   * A final transcript. With the profile panel open: "I'm allergic to mango" / "no coriander"
   * adds it to the profile. With a menu in view: match a dish name and act like a pinch.
   */
  private onVoice(text: string): void {
    // The microphone hears the Lens's own voice: while a prompt plays (plus the speech-to-text tail) every
    // transcript is the Lens, and a later transcript that repeats the prompt's words is its echo. Both are dropped,
    // otherwise "step three, any diet, vegetarian, vegan…" would toggle Vegetarian and Vegan on by itself.
    if (this.speech) {
      // Words the Lens itself just said are removed; what the user said over them is kept ("… Olives." → "olives").
      const own = this.speech.stripEcho(text)
      if (own !== text) {
        if (own.trim().length < 3) {
          print(`AllergyLens: voice "${text}" ignored (the Lens's own voice)`)
          return
        }
        print(`AllergyLens: voice "${text}" → the Lens's words removed → "${own}"`)
        text = own
      } else if (this.speech.isSpeaking && this.speech.isEcho(text)) {
        print(`AllergyLens: voice "${text}" ignored (the Lens's own voice)`)
        return
      }
    }
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
      this.speech?.say("safe")
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
    // textC keeps the commas speech-to-text puts between list items ("banana, apple"); text has none.
    const textC = collapseRepeats(raw.toLowerCase().replace(/[^a-z0-9',\s]/g, " ").replace(/\s*,\s*/g, " , ").replace(/\s+/g, " ").trim())
    const text = textC.replace(/ , /g, " ").replace(/\s+/g, " ").trim()
    const short = raw.length > 48 ? raw.slice(0, 45) + "…" : raw
    const heard = (what: string) => this.profilePanel.setHeard(`Heard: "${short}" → ${what}`)
    // A command may come wrapped in filler ("Mm. Well, next."): test it bare as well.
    const bare = text.split(" ").filter((w) => w.length > 0 && !FILLER_WORDS.has(w)).join(" ")
    const isCmd = (re: RegExp) => re.test(text) || re.test(bare)
    if (isCmd(/^(done|finished|finish|that's it|thats it|okay done|ok done|i'm done|im done|save|save it)$/)) {
      print(`AllergyLens: voice "${raw}" → Done`)
      heard("Done")
      this.onProfileDone()
      return
    }
    if (isCmd(/^(start|let's start|lets start|let's go|lets go|begin|go|okay|ok|yes|continue|next|next step|skip|go on|move on)$/)) {
      heard(this.stepBy(1) ? "next" : "already on the last step; say done")
      return
    }
    if (isCmd(/^(back|go back|previous|previous step)$/)) {
      heard(this.stepBy(-1) ? "back" : "this is the first step")
      return
    }
    if (isCmd(/^(more|show more|even more|others|other allergies|something else|one more|another one)$/)) {
      if (this.profilePanel.step !== "allergies") { this.profilePanel.setStep("allergies"); this.onProfileStep("allergies") }
      this.onMoreRequested()
      return
    }
    if (isCmd(/^(edit|keyboard|type|type it|fix it|correct it|that's wrong|thats wrong)$/)) {
      this.profilePanel.openEdit()
      heard("keyboard open; type the foods to avoid, then the check")
      return
    }
    if (isCmd(/^(quiet|mute|be quiet|stop talking|silence)$/)) {
      this.speech?.setMuted(true)
      this.profilePanel.setSpeaking(false)
      heard("voice off")
      return
    }
    if (isCmd(/^(speak|unmute|talk|voice on|talk to me)$/)) {
      this.speech?.setMuted(false)
      this.profilePanel.setSpeaking(true)
      heard("voice on")
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
    const POLITE = /\b(uh|um|ah|please|okay|ok|right|yeah|yes|so|can you|could you|pick|select|tick|choose|mark|set|put|on the \w+ side|on \w+ side|for me|i want|i'd like|i would like|to do|would like to)\b/g
    const cleaned = text.replace(POLITE, " ").replace(/\s+/g, " ").trim()
    const cleanedC = textC.replace(POLITE, " ").replace(/\s+/g, " ").replace(/^(, )+|( ,)+$/g, "").trim()
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
    const off = /\b(turn off|switch off|remove|unselect|deselect|unpick|clear|undo|cancel|don't need|do not need|not anymore)\b/.test(cleaned)
    // "a vegan, not vegetarian" / "I don't want vegetarian, vegan instead": each toggle gets its own polarity
    // from the words right before it, so one sentence can switch one on and another off.
    const polar = this.findTogglesWithPolarity(cleaned)
    if (polar.length > 0 && polar.some((x) => !x.on) && polar.some((x) => x.on)) {
      for (const {toggle, on} of polar) this.applyToggle(toggle, on)
      this.audio?.playClick()
      heard(polar.map((x) => `${x.toggle.label} ${x.on ? "on" : "off"}`).join(", "))
      this.updateMoodAvailability()
      this.showCustomItems()
      this.recheckActive()
      return
    }
    // A list on the allergies screen: "sesame seeds, olive oil and garlic" → three items, known or custom.
    if (this.profilePanel.step === "allergies" && !off) {
      const listText = cleanedC.replace(/^(i'm allergic to|im allergic to|i am allergic to|allergic to|i can't eat|i cannot eat|no|avoid)\s+/, "")
      const parts = listText.split(/\s*,\s*|\s+and\s+|\s+plus\s+|\s+also\s+/).map((x) => x.trim()).filter((x) => x.length > 0)
      if (parts.length > 1) {
        const done = parts.map((x) => this.applySpokenItem(x)).filter((x): x is string => x !== null)
        if (done.length > 0) {
          this.audio?.playClick()
          this.updateMoodAvailability()
          this.showCustomItems()
          this.recheckActive()
          heard(done.join(", "))
          return
        }
      }
    }
    const found = this.findTogglesInSentence(cleaned)
    if (found.length > 0) {
      const negatedAll = off || (polar.length > 0 && polar.every((x) => !x.on))
      const on = !negatedAll
      for (const toggle of found) {
        this.applyToggle(toggle, on)
        print(`AllergyLens: voice "${raw}" → ${toggle.id} ${on ? "on" : "off"}`)
      }
      this.audio?.playClick()
      heard(found.map((t) => `${t.label} ${on ? "on" : "off"}`).join(", "))
      this.updateMoodAvailability()
      this.showCustomItems()
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
      this.audio?.playClick()
      print(`AllergyLens: voice "${raw}" → mood ${mood.id}`)
      heard(`mood ${mood.label}`)
      this.recheckActive()
      return
    }
    const goto = /^(on |in |under |the |go to |open )*(allergies|allergy|religious|religious cultural|cultural|diet|dietary)$/.exec(cleaned)
    if (goto) {
      const step: ProfileStep = /allerg/.test(goto[2]) ? "allergies" : /diet/.test(goto[2]) ? "diet" : "religious"
      this.profilePanel.setStep(step)
      this.onProfileStep(step)
      heard(`${step} screen`)
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
    if (off) {
      // "remove mango" / "take out olive oil": a spoken chip goes away; never a new chip called "remove mango".
      const words = ` ${foodWords(cleaned.replace(/\b(turn off|switch off|remove|unselect|deselect|unpick|clear|undo|cancel|don't need|do not need|not anymore|take out|take off|delete|drop)\b/g, " "))} `
      const gone = this.customAllergens.filter((c) => this.profile.has(c.id) && c.aliases.some((al) => words.indexOf(` ${al} `) >= 0))
      if (gone.length > 0) {
        for (const c of gone) this.removeExtra(c.id)
        heard(`removed ${gone.map((c) => c.label).join(", ")}`)
        return
      }
      heard('say what to remove, e.g. "remove mango"')
      return
    }
    if (this.profilePanel.step !== "welcome" && foodWords(cleaned).split(" ").filter((w) => w.length > 0).length <= 4 && foodWords(cleaned).length >= 3) {
      // On a question screen a bare food name is an answer: "garlic" → avoid garlic, "octopus" → avoid octopus
      // (its own chip, not the Shellfish tile); "well, I'm also allergic to" alone is nothing.
      const did = this.applySpokenItem(cleaned, STEP_GROUP[this.profilePanel.step])
      if (did) {
        this.audio?.playClick()
        this.showCustomItems()
        this.recheckActive()
        heard(did)
        return
      }
    }
    print(`AllergyLens: voice "${raw}" — not understood on the ${this.profilePanel.step} screen`)
    this.speech?.say("heard_nothing")
    heard(`not understood. ${STEP_HINT[this.profilePanel.step]}`)
  }

  /**
   * Every toggle named anywhere in a sentence: by label ("no beef", "milk / dairy"), its core
   * word ("beef", "dairy", "gluten", "sugar"), its id, or an alias ("bacon") — as whole words.
   * Moods are checked first so "chicken" is the chip, not the vegetarian toggle's alias.
   */
  /**
   * Each toggle named in the sentence with its own on/off: the four words before the name decide
   * ("not vegetarian", "don't want milk", "without eggs", "vegetarian off" → off). "No beef" is the
   * toggle's own name, so "no" only negates toggles whose label does not start with No/Avoid.
   */
  private findTogglesWithPolarity(sentence: string): Array<{toggle: AllergenDef; on: boolean}> {
    const s = ` ${sentence} `
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
    const NEG = /\b(not|don't|dont|do not|no longer|without|never|unpick|unselect|deselect|remove|turn off|switch off|cancel|undo|skip|rather than|instead of|except)\b/
    const out: Array<{toggle: AllergenDef; on: boolean}> = []
    for (const a of this.findTogglesInSentence(sentence)) {
      const label = norm(a.label)
      const core = label.replace(/^(no|avoid) /, "")
      const names = [label, core, a.id.replace("_", " ")].concat((a.spoken ?? []).map(norm)).filter((n) => n.length > 1)
      let idx = -1
      let hit = ""
      for (const n of names) {
        const i = s.indexOf(` ${n} `)
        if (i >= 0 && (idx < 0 || i < idx)) { idx = i; hit = n }
      }
      if (idx < 0) { out.push({toggle: a, on: true}); continue }
      const before = s.slice(0, idx).trim().split(" ").slice(-4).join(" ")
      const after = s.slice(idx + hit.length + 2).trim().split(" ").slice(0, 2).join(" ")
      const ownNo = /^(no|avoid) /.test(label) && hit === label
      const negBefore = NEG.test(before) || (!ownNo && /\bno$/.test(before))
      const negAfter = /^(off|out|no more|instead)\b/.test(after) && !/\binstead$/.test(before)
      out.push({toggle: a, on: !(negBefore || negAfter)})
    }
    return out
  }

  /** One toggle on/off in the profile and on the panel. Vegan and Vegetarian are one choice: the other goes off. */
  private applyToggle(toggle: AllergenDef, on: boolean): void {
    this.profile.set(toggle.id, on)
    this.profilePanel.setToggle(toggle.id, on)
    if (on && (toggle.id === "vegan" || toggle.id === "meat")) {
      const other = toggle.id === "vegan" ? "meat" : "vegan"
      if (this.profile.has(other)) { this.profile.set(other, false); this.profilePanel.setToggle(other, false) }
    }
  }

  private findTogglesInSentence(sentence: string): AllergenDef[] {
    const s = ` ${sentence} `
    const has = (phrase: string) => phrase.length > 1 && s.indexOf(` ${phrase} `) >= 0
    const out: AllergenDef[] = []
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
    // Names only (label, its core word, id, spoken forms). Ingredient aliases ("octopus", "bacon",
    // "cashews") deliberately do NOT flip a tile: a specific food the user names becomes its own chip.
    for (const a of ALLERGENS) {
      const label = norm(a.label)
      const core = label.replace(/^(no|avoid) /, "")
      const words = core.split(" ").filter((w) => w.length > 2)
      const spoken = (a.spoken ?? []).map(norm)
      if ([label, core, a.id, a.id.replace("_", " ")].concat(words).concat(spoken).some((w) => has(w))) out.push(a)
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
    if (this.profilePanel.getSceneObject().enabled) {
      print(`AllergyLens: product in view (${barcode}) — waiting for the profile to finish`)
      return
    }
    this.audio?.playScan()
    print(`AllergyLens: product recognised — ${barcode}`)
    this.buttonShowTimer?.cancel()
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
        // The user's rule: mark only what is safe. Risky and unverified dishes draw nothing but stay pinchable.
        style = r.verdict === "safe" ? "dot-safe" : r.verdict === "contains" || r.verdict === "unverified" ? "quiet" : "none"
      } else if (inCategory) {
        style = r.verdict === "safe" ? "star-safe" : r.verdict === "contains" || r.verdict === "unverified" ? "quiet" : "none"
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
    print(`AllergyLens: check ${restaurantId} (${this.mood}) — contains ${by("contains")}, unverified ${by("unverified")}, safe ${by("safe")}; marked ${marks.filter((m) => m.style !== "none" && m.style !== "quiet").length}; badge ${badge.level}`)
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
    this.speech?.say(result.verdict === "contains" ? "contains" : result.source === "model" ? "likely_fine" : "unknown")
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
    t.setLocalScale(new vec3(this.uiScale, this.uiScale, this.uiScale))
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

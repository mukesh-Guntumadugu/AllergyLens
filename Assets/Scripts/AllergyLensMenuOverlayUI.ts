// AllergyLensMenuOverlayUI — sits on a MenuMarker SceneObject (MarkerTrackingComponent +
// ImageMarker of a real menu page) and draws the see-through overlay on the printed
// page: one translucent bar per dish that has a layout box, plus a restaurant badge
// chip just above the page's top edge. Owns: bar/badge construction, found/lost
// handling (bars hide ~1 s after the marker is lost), pinch events on bars, and the
// simulate-marker hook. Expects @input restaurantId (a restaurant with menuImage in the
// data). Must not run the check — Main pushes verdicts and the badge in.
//
// Adding a restaurant = another SceneObject with MarkerTrackingComponent + this script
// and its restaurantId; the page geometry (widthCm, aspect) comes from the data.

import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {DishDef, RestaurantDef, getRestaurant} from "./AllergyLensMenuData"
import {RestaurantBadgeLevel} from "./AllergyLensChecker"
import * as UI from "./AllergyLensSharedUI"

const BAR_TEX = requireAsset("../Icons/square.png") as Texture
const STAR_TEX = requireAsset("../Icons/star_rate.png") as Texture
// The printed page itself, drawn ONLY on a simulated page (debugSimulateMarker / LEAF
// simulateMarker) so the marks are visibly on a menu. Never drawn while the camera
// tracker owns the pose — there the real page is under the marks.

/**
 * Menu pages bundled with the Lens, by restaurant id: the image marker the camera tracks
 * and the page image for the simulated path. Main creates one MenuMarker object per entry
 * that is not authored in the scene. Adding a restaurant = one photo
 * through tools/scrape/page_from_video.py + ocr, its data/menus.json entry, and a line here.
 */
export const MENU_MARKERS: {[key: string]: {marker: MarkerAsset; texture: Texture; restaurantId?: string; mirrored?: boolean}} = {
  // Several markers can describe one page (`restaurantId` points them at the data): Laurel has the printed page
  // flattened from the phone clip (locks on that footage) and the crisp design file (what a live camera matches).
  // Every page also has a horizontally MIRRORED marker: Lens Studio's webcam preview shows the camera mirrored
  // like a selfie, and a marker can only match a page the right way round — the mirrored copy matches that feed
  // and the overlay mirrors its line positions (`mirrored`). On the glasses only the unmirrored ones ever match.
  "laurel-cafe": {marker: requireAsset("../Markers/MenuMarker-laurel-cafe.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/laurel-cafe-menu-1.png") as Texture},
  "laurel-cafe-design": {marker: requireAsset("../Markers/MenuMarker-laurel-cafe-design.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/laurel-cafe-design.png") as Texture, restaurantId: "laurel-cafe"},
  "laurel-cafe-mirror": {marker: requireAsset("../Markers/MenuMarker-laurel-cafe-mirror.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/laurel-cafe-menu-1-mirror.png") as Texture, restaurantId: "laurel-cafe", mirrored: true},
  "laurel-cafe-design-mirror": {marker: requireAsset("../Markers/MenuMarker-laurel-cafe-design-mirror.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/laurel-cafe-design-mirror.png") as Texture, restaurantId: "laurel-cafe", mirrored: true},
  "tatlilar": {marker: requireAsset("../Markers/MenuMarker-tatlilar.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/tatlilar-menu-1.png") as Texture},
  "chinese-menu": {marker: requireAsset("../Markers/MenuMarker-chinese-menu.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/chinese-menu-menu-1.png") as Texture},
  "chinese-menu-mirror": {marker: requireAsset("../Markers/MenuMarker-chinese-menu-mirror.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/chinese-menu-menu-1-mirror.png") as Texture, restaurantId: "chinese-menu", mirrored: true},
  // The Kitchen Section marker comes from a blurry frame and once false-matched the Chinese page on the phone clip;
  // it is on for the live camera because the user holds that page up.
  "kitchen-section": {marker: requireAsset("../Markers/MenuMarker-kitchen-section.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/kitchen-section-menu-1.png") as Texture},
  "kitchen-section-mirror": {marker: requireAsset("../Markers/MenuMarker-kitchen-section-mirror.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/kitchen-section-menu-1-mirror.png") as Texture, restaurantId: "kitchen-section", mirrored: true},
}
const SQUARE_GLYPH_COVERAGE = 0.75 // the glyph fills 18/24 of its canvas
const imageMaterial = requireAsset("../Materials/ImageMaterial.mat") as Material

export interface BarPinchEvent {
  restaurantId: string
  dishId: string
}

/**
 * How a dish line is marked on the page (Main decides, the overlay draws):
 *   none               nothing (and no pinch target)
 *   dot-safe           small green dot at the end of the line
 *   dot-unverified     small amber dot at the end of the line
 *   underline-contains thin red underline at the baseline + red dot
 *   star-safe          soft green full-line highlight + green star ("order this")
 */
export type MarkStyle = "none" | "quiet" | "dot-safe" | "dot-unverified" | "underline-contains" | "star-safe"
// "quiet": nothing drawn, but the line keeps its pinch target (risky dishes under the "mark only what is safe" rule).

export interface DishMark {
  dishId: string
  style: MarkStyle
  /** In the user's chosen mood category (drives the arrow chip). */
  inCategory: boolean
  /** Why it is red or grey ("contains peanuts, tree nuts" / "not sure: ingredients not published"); empty for green. */
  note?: string
}

interface Bar {
  dish: DishDef
  root: SceneObject
  full: SceneObject
  fullMat: Material
  underline: SceneObject
  underlineMat: Material
  dot: SceneObject
  dotMat: Material
  star: SceneObject
  starMat: Material
  style: MarkStyle
  inCategory: boolean
  picked: boolean // among the MAX_MARKS nearest the view centre (drawn); unpicked lines stay pinchable
  revealed: boolean // the user is pointing at it (hover): its verdict is drawn; otherwise nothing is
  hideAt: number // when a revealed line goes quiet again after the finger left (s)
  hoverSince: number // when the pointer arrived on the line (s); -1 when it is not on it
  revealT: number // 0..1 fade of the revealed verdict (lines and chip fade in and out, never pop)
  note: string // the reason shown under a red or grey line while pointed at
  noteRoot: SceneObject | null // built on first use
  noteText: Text | null
  notePlate: BackPlate | null
  /** page-local centre + size in cm */
  x: number
  y: number
  w: number
  h: number
}

const FULL_ALPHA = 0.35
const UNDERLINE_ALPHA = 0.6 // light enough that the printed line above it stays readable
const CONTAINS_ALPHA = 0.75
const MAX_MARKS = 10 // never more lines than this at once; the ten nearest to where the user looks
const REVEAL_LINGER_SEC = 1.2 // a pointed-at verdict stays this long after the finger leaves the line (unless another lights)
const DWELL_SEC = 0.55 // the pointer must rest on a dish this long before its verdict appears: sweeping past lights nothing
const REVEAL_FADE_IN_SEC = 0.2
const REVEAL_FADE_OUT_SEC = 0.15
const UNSURE_GREY = new vec3(0.62, 0.64, 0.66) // "not sure" is drawn grey, not amber (the user's words: red, grey, green)

/** Word-wrap a sentence into at most `maxLines` lines of about `width` characters; the last line gets an ellipsis if cut. */
function wrapWords(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const lines: string[] = []
  let line = ""
  for (const w of words) {
    if (line.length === 0) line = w
    else if (line.length + 1 + w.length <= width) line += " " + w
    else {
      lines.push(line)
      line = w
      if (lines.length === maxLines) break
    }
  }
  if (lines.length < maxLines && line.length > 0) lines.push(line)
  else if (lines.length === maxLines && line.length > 0) lines[maxLines - 1] = lines[maxLines - 1].slice(0, width - 1) + "…"
  return lines.length > 0 ? lines : [text]
}
const STEADY_SEC = 0.15 // the page must hold still this long before lines are drawn
const MOVE_CM_PER_S = 30 // a hand-held page drifts; only real movement hides the lines
const TURN_DEG_PER_S = 60
const DOT_ALPHA = 0.8
const DOT_SIZE = 0.5
const STAR_SIZE = 0.9
const FADE_SEC = 0.4

@component
export class AllergyLensMenuOverlayUI extends BaseScriptComponent {
  /** Set by Main right before createComponent so a runtime-created overlay knows its restaurant (inputs are at defaults then). */
  static pending: {restaurantId: string; texture: Texture; mirrored?: boolean} | null = null
  /** This marker is the mirror image of the page (webcam preview): line positions are mirrored to match. */
  private mirrored = false

  @ui.label('<span style="color: #60A5FA;">AllergyLensMenuOverlayUI – highlights + badge on a tracked real menu</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Restaurant id from the data (must have a menuImage). The marker on this object is that page.")
  restaurantId: string = "laurel-cafe"

  @input
  @hint("Padding (cm) added around each printed line's OCR box; bars are otherwise exactly the line's width and height.")
  @widget(new SliderWidget(0, 0.5, 0.05))
  barPaddingCm: number = 0.2

  @input
  @hint("Left edge of the glasses' display band as a fraction of the camera frame (Phase 1 measurement: 0.23).")
  @widget(new SliderWidget(0, 0.5, 0.01))
  displayBandMin: number = 0.23

  @input
  @hint("Right edge of the glasses' display band as a fraction of the camera frame (Phase 1 measurement: 0.77).")
  @widget(new SliderWidget(0.5, 1, 0.01))
  displayBandMax: number = 0.77

  @input("vec3", "{0.55, 0.95, 0.6}")
  @hint("Bar tint for safe dishes.")
  @widget(new ColorWidget())
  safeColor: vec3

  @input("vec3", "{0.98, 0.45, 0.45}")
  @hint("Bar tint for dishes that contain something from the profile.")
  @widget(new ColorWidget())
  flagColor: vec3

  @input("vec3", "{1.0, 0.8, 0.3}")
  @hint("Bar tint for dishes whose ingredients are not published.")
  @widget(new ColorWidget())
  unverifiedColor: vec3

  @input
  @hint("Seconds to keep the marks after the marker is lost before they fade out (fade takes ~0.4 s).")
  @widget(new SliderWidget(0, 5, 0.1))
  lostHideDelaySec: number = 1.5

  @input
  @hint("Badge chip centre relative to the page's top edge, in cm: negative = inside the page's top margin (default), positive = floating above the edge.")
  @widget(new SliderWidget(-4, 4, 0.1))
  badgeEdgeOffsetCm: number = -0.9

  @input
  @hint("Badge chip width in cm. Keep it inside the glasses' display band (~55% of the page width).")
  @widget(new SliderWidget(8, 30, 0.5))
  badgeWidthCm: number = 15
  @ui.group_end

  private restaurant: RestaurantDef | null = null
  private widthCm = 29.7
  private heightCm = 18.2
  private bars: Bar[] = []
  private barsRoot: SceneObject | null = null
  private pageImage: SceneObject | null = null
  private pageTexture: Texture = MENU_MARKERS["laurel-cafe"].texture
  private badgeRoot: SceneObject | null = null
  private badgeText: Text | null = null
  private badgeDotMat: Material | null = null
  private _badgeLevel: RestaurantBadgeLevel | "" = ""
  private _badgeText = ""
  private _active = false
  private fade = 0
  private fadeTarget = 0
  /** 1 while the page holds still, 0 while it moves or turns: lines are not drawn on a moving page. */
  private motionGate = 1
  private steadyFor = 0
  private lastPos: vec3 | null = null
  private lastRot: quat | null = null
  private pickTimer = 0
  private moodLabel: string | null = null
  private arrowRoot: SceneObject | null = null
  private arrowText: Text | null = null
  private arrowPlate: BackPlate | null = null
  private _arrowVisible = false
  private _arrowLabel = ""
  private viewCheckTimer = 0
  private simulated = false
  private cameraTrackingWanted = true
  private tracker: MarkerTrackingComponent | null = null
  private hideTimer: DelayedCallbackEvent | null = null
  private _onFound = new Event<string>()
  private _onLost = new Event<string>()
  private _onBarPinched = new Event<BarPinchEvent>()

  /** Marker recognised (or simulated): fires with the restaurant id. */
  get onFound(): PublicApi<string> {
    return this._onFound.publicApi()
  }

  /** Marker lost: fires immediately; the bars hide after lostHideDelaySec. */
  get onLost(): PublicApi<string> {
    return this._onLost.publicApi()
  }

  /** A highlight bar was pinched. */
  get onBarPinched(): PublicApi<BarPinchEvent> {
    return this._onBarPinched.publicApi()
  }

  /** True while the marker is tracked or simulated (bars shown). */
  get isActive(): boolean {
    return this._active
  }

  get badgeLevel(): string {
    return this._badgeLevel
  }

  get badgeTextValue(): string {
    return this._badgeText
  }

  get pageWidthCm(): number {
    return this.widthCm
  }

  get pageHeightCm(): number {
    return this.heightCm
  }

  /** How many Caption-size characters fit on the badge chip (for Main's text fitting). */
  get badgeCapacityChars(): number {
    const textW = Math.min(this.widthCm, this.badgeWidthCm) - 2.2
    return Math.floor(textW / (0.5 * 45 / 110))
  }

  /** Arrow chip state (tests). */
  get arrowVisible(): boolean {
    return this._arrowVisible
  }

  get arrowLabel(): string {
    return this._arrowLabel
  }

  onAwake(): void {
    const pending = AllergyLensMenuOverlayUI.pending
    if (pending) {
      this.restaurantId = pending.restaurantId
      this.pageTexture = pending.texture
      this.mirrored = !!pending.mirrored
      AllergyLensMenuOverlayUI.pending = null
    } else if (MENU_MARKERS[this.restaurantId]) {
      this.pageTexture = MENU_MARKERS[this.restaurantId].texture
    }
    this.restaurant = getRestaurant(this.restaurantId) ?? null
    if (!this.restaurant || !this.restaurant.menuImage) {
      print(`AllergyLensMenuOverlayUI: restaurant "${this.restaurantId}" has no menuImage — overlay disabled.`)
      return
    }
    const img = this.restaurant.menuImage
    this.widthCm = img.widthCm
    this.heightCm = img.widthPx > 0 ? img.widthCm * img.heightPx / img.widthPx : img.widthCm * 0.613

    const tracker = this.sceneObject.getComponent("Component.MarkerTrackingComponent") as MarkerTrackingComponent | null
    this.tracker = tracker
    if (tracker) {
      tracker.autoEnableWhenTracking = false // we manage visibility (1 s grace + simulation)
      tracker.onMarkerFound = () => this.handleFound()
      tracker.onMarkerLost = () => this.handleLost()
    } else {
      print(`AllergyLensMenuOverlayUI: no MarkerTrackingComponent on ${this.sceneObject.name}; simulate-only.`)
    }

    this.hideTimer = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.hideTimer.bind(() => {
      this.fadeTarget = 0 // fade out, then hide (see onUpdate)
    })
    this.createEvent("UpdateEvent").bind(() => this.onUpdate())

    this.buildSimulatedPage()
    this.barsRoot = UI.obj(this.sceneObject, "Bars")
    for (const dish of this.restaurant.dishes) {
      if (dish.layout) this.bars.push(this.buildBar(dish))
    }
    this.buildBadge()
    this.buildArrow()
    this.setShown(false)
  }

  // ── Public API (Main pushes state in) ──────────────────────────────────
  /**
   * Apply one mark per dish (by id; unlisted dishes get "none"). `moodLabel` names the
   * chosen category for the arrow chip, or null for "everything".
   */
  setMarks(marks: DishMark[], moodLabel: string | null): void {
    const map = new Map<string, DishMark>()
    for (const m of marks) map.set(m.dishId, m)
    this.moodLabel = moodLabel
    for (const bar of this.bars) {
      const m = map.get(bar.dish.id)
      bar.style = m ? m.style : "none"
      bar.note = m?.note ?? ""
      bar.inCategory = !!m && m.inCategory
      this.applyStyle(bar)
    }
    this.applyFade()
    this.updateArrow(true)
  }

  setBadge(level: RestaurantBadgeLevel, text: string): void {
    this._badgeLevel = level
    this._badgeText = text
    if (!this.badgeText || !this.badgeDotMat) return
    const tint = level === "good" ? this.safeColor : level === "caution" ? this.unverifiedColor : this.flagColor
    this.badgeText.text = text
    this.badgeText.textFill.color = new vec4(tint.x, tint.y, tint.z, 1)
    this.badgeDotMat.mainPass.baseColor = new vec4(tint.x, tint.y, tint.z, 1)
  }

  /** Page-local geometry of a dish bar (cm, centre + size) or null. */
  getBarGeometry(dishId: string): {x: number; y: number; w: number; h: number} | null {
    const bar = this.bars.find((b) => b.dish.id === dishId)
    return bar ? {x: bar.x, y: bar.y, w: bar.w, h: bar.h} : null
  }

  getBarAnchor(dishId: string): SceneObject | null {
    return this.bars.find((b) => b.dish.id === dishId)?.root ?? null
  }

  /**
   * Debug / tests / Interactive Preview: park the page 60 cm ahead, a little below eye
   * level, facing the user, and act as found. Never runs while the camera tracker is
   * actually tracking this marker; while a simulation is active the tracker is switched
   * off so the two can never fight over the object's pose. Returns false when refused.
   */
  simulateFound(offsetXcm: number = 0): boolean {
    if (this.tracker && this.tracker.enabled && this.tracker.isTracking()) {
      print(`AllergyLensMenuOverlayUI: simulateFound ignored — ${this.restaurantId} is being tracked by the camera`)
      return false
    }
    if (this.tracker) this.tracker.enabled = false
    this.simulated = true
    const cam = WorldCameraFinderProvider.getInstance().getTransform()
    const rot = cam.getWorldRotation()
    const look = rot.multiplyVec3(new vec3(0, 0, -1))
    const up = rot.multiplyVec3(new vec3(0, 1, 0))
    const right = rot.multiplyVec3(new vec3(1, 0, 0))
    const pos = cam.getWorldPosition().add(look.uniformScale(60)).add(up.uniformScale(-12)).add(right.uniformScale(offsetXcm))
    const t = this.sceneObject.getTransform()
    t.setWorldPosition(pos)
    t.setWorldRotation(rot) // the page's +Z faces the user
    t.setWorldScale(new vec3(1, 1, 1))
    this.handleFound()
    this.showPage(true)
    return true
  }

  /** End a simulation; the camera tracker (if any, and unless tests disabled it) owns the pose again. */
  simulateLost(): void {
    const wasSimulated = this.simulated
    this.simulated = false
    this.handleLost()
    if (wasSimulated && this.tracker && this.cameraTrackingWanted) this.tracker.enabled = true
  }

  /** Debug / tests: turn the camera tracker on or off so only simulated events fire. Runtime-only. */
  setCameraTracking(enabled: boolean): void {
    this.cameraTrackingWanted = enabled
    if (this.tracker && !this.simulated) this.tracker.enabled = enabled
  }

  // ── Private ────────────────────────────────────────────────────────────
  private handleFound(): void {
    this.hideTimer?.cancel()
    this._active = true
    this.lastPos = null
    this.lastRot = null
    this.steadyFor = 0
    this.motionGate = 0
    this.pickTimer = 0
    this.setShown(true)
    if (!this.simulated) this.showPage(false) // the camera sees the real page
    this.fadeTarget = 1 // fade the marks in (~0.4 s)
    this._onFound.invoke(this.restaurantId)
  }

  private handleLost(): void {
    this._active = false
    this._onLost.invoke(this.restaurantId)
    if (this.lostHideDelaySec <= 0) this.fadeTarget = 0
    else this.hideTimer?.reset(this.lostHideDelaySec)
  }

  private setShown(shown: boolean): void {
    if (this.barsRoot) this.barsRoot.enabled = shown
    if (this.badgeRoot) this.badgeRoot.enabled = shown
    if (!shown) {
      this._arrowVisible = false
      if (this.arrowRoot) this.arrowRoot.enabled = false
      this.showPage(false)
    }
    if (!shown) this.fade = 0
  }

  private showPage(shown: boolean): void {
    if (this.pageImage) this.pageImage.enabled = shown
  }

  /** Full-size image of the printed page (widthCm x heightCm), just behind the marks; off until a simulation. */
  private buildSimulatedPage(): void {
    const so = UI.obj(this.sceneObject, "SimulatedPage", new vec3(0, 0, 0))
    const img = so.createComponent("Component.Image") as Image
    const mat = imageMaterial.clone()
    mat.mainPass.baseTex = this.pageTexture
    mat.mainPass.baseColor = new vec4(1, 1, 1, 1)
    mat.mainPass.depthTest = true
    mat.mainPass.depthWrite = true
    img.clearMaterials()
    img.addMaterial(mat)
    so.getTransform().setLocalScale(new vec3(this.widthCm, this.heightCm, 1))
    so.enabled = false
    this.pageImage = so
  }

  // ── Per-frame: fade + in-view check ──────────────────────────────────
  private onUpdate(): void {
    const dt = getDeltaTime()
    if (this.fade !== this.fadeTarget) {
      const step = dt / FADE_SEC
      this.fade = this.fadeTarget > this.fade ? Math.min(this.fadeTarget, this.fade + step) : Math.max(this.fadeTarget, this.fade - step)
      this.applyFade()
      if (this.fade === 0 && this.fadeTarget === 0 && !this._active) this.setShown(false)
    }
    if (this._active) {
      this.viewCheckTimer -= dt
      if (this.viewCheckTimer <= 0) {
        this.viewCheckTimer = 0.2
        this.updateArrow(false)
      }
      this.trackMotion(dt)
      const now = getTime()
      for (const b of this.bars) {
        // dwell: the pointer has rested long enough → this dish lights, the previous one goes out
        if (!b.revealed && b.hoverSince >= 0 && now - b.hoverSince >= DWELL_SEC && b.style !== "none" && b.style !== "quiet") {
          this.unrevealOthers(b)
          b.revealed = true
          b.hideAt = Number.POSITIVE_INFINITY
        }
        if (b.revealed && now >= b.hideAt) b.revealed = false
        // fades
        const target = b.revealed ? 1 : 0
        if (b.revealT !== target) {
          b.revealT = target > b.revealT ? Math.min(1, b.revealT + dt / REVEAL_FADE_IN_SEC) : Math.max(0, b.revealT - dt / REVEAL_FADE_OUT_SEC)
          this.applyStyle(b)
        }
      }
    }
  }

  /**
   * A moving or turning page gets no lines: the tracker's pose lags and the marks would scribble beside
   * the text. Lines fade out at once when the page moves and come back ~0.3 s after it holds still; the
   * ten nearest the view centre are chosen then (and re-chosen every half second while steady).
   */
  private trackMotion(dt: number): void {
    const t = this.sceneObject.getTransform()
    const pos = t.getWorldPosition()
    const rot = t.getWorldRotation()
    let moving = false
    if (this.lastPos && this.lastRot && dt > 0) {
      const speed = pos.distance(this.lastPos) / dt
      const turn = (quat.angleBetween(this.lastRot, rot) * 180) / Math.PI / dt
      moving = speed > MOVE_CM_PER_S || turn > TURN_DEG_PER_S
    }
    this.lastPos = pos
    this.lastRot = rot
    this.steadyFor = moving ? 0 : this.steadyFor + dt
    const target = this.steadyFor >= STEADY_SEC ? 1 : 0
    const before = this.motionGate
    this.motionGate = target > this.motionGate ? Math.min(1, this.motionGate + dt / 0.15) : Math.max(0, this.motionGate - dt / 0.12)
    if (this.motionGate !== before) this.applyFade()
    if (target === 1) {
      this.pickTimer -= dt
      if (this.pickTimer <= 0 || before === 0) {
        this.pickTimer = 0.5
        this.pickNearest()
      }
    }
  }

  /** Draw at most MAX_MARKS lines: the drawn-style bars nearest the view centre. The rest stay pinchable. */
  private pickNearest(): void {
    const drawn = this.bars.filter((b) => this.drawnStyle(b) !== "none" && this.drawnStyle(b) !== "quiet")
    const scored = drawn.map((b) => {
      const lp = b.root.getTransform().getLocalPosition()
      const sp = this.screenPointOfLocal(lp.x, lp.y)
      const d = sp ? Math.hypot(sp.x - 0.5, sp.y - 0.5) : 9
      return {b, d}
    })
    scored.sort((a, c) => a.d - c.d)
    let changed = false
    scored.forEach((e, i) => {
      const pick = i < MAX_MARKS
      if (e.b.picked !== pick) {
        e.b.picked = pick
        changed = true
      }
    })
    if (changed) for (const e of scored) this.applyStyle(e.b)
  }

  private alpha(): number {
    return this.fade * this.motionGate
  }

  private tintFor(style: MarkStyle): vec3 {
    return style === "star-safe" || style === "dot-safe" ? this.safeColor : style === "underline-contains" ? this.flagColor : this.unverifiedColor
  }

  /** Underline colour: the safe green and the amber are lifted towards white so they read as a light pen line. */
  private underlineTint(style: MarkStyle): vec3 {
    if (style === "dot-unverified") return UNSURE_GREY
    const t = this.tintFor(style)
    const lift = style === "underline-contains" ? 0 : 0.35
    return new vec3(t.x + (1 - t.x) * lift, t.y + (1 - t.y) * lift, t.z + (1 - t.z) * lift)
  }

  private underlineAlpha(style: MarkStyle): number {
    return style === "underline-contains" ? CONTAINS_ALPHA : UNDERLINE_ALPHA
  }

  /** What is drawn for a bar right now: its verdict only while pointed at (mood stars are always drawn). */
  private drawnStyle(bar: Bar): MarkStyle {
    if (bar.style === "none" || bar.style === "quiet") return bar.style
    if (bar.style === "star-safe" || bar.revealed || bar.revealT > 0) return bar.style
    return "quiet"
  }

  /** Fade factor of a bar's revealed verdict (mood stars are always fully drawn). */
  private revealAlpha(bar: Bar): number {
    return bar.style === "star-safe" ? 1 : bar.revealT
  }

  /** The one dish lit right now (if any) goes out at once so a new one can light. */
  private unrevealOthers(keep: Bar): void {
    for (const b of this.bars) {
      if (b !== keep && b.revealed) {
        b.revealed = false
        b.hideAt = 0
      }
    }
  }

  private applyStyle(bar: Bar): void {
    const s = this.drawnStyle(bar)
    const marked = s !== "none"
    bar.root.enabled = marked && this._active
    bar.full.enabled = s === "star-safe" && bar.picked
    bar.underline.enabled = (s === "underline-contains" || s === "dot-safe" || s === "dot-unverified") && bar.picked
    bar.dot.enabled = false
    bar.star.enabled = s === "star-safe" && bar.picked
    // A pen-thin line under the printed name, never on it: the point is that the text stays readable.
    // Red ("contains") is a little heavier; colour tells the rest. A clear gap below the glyph box
    // keeps the line off the text even when the tracker is a millimetre or two high.
    const L = bar.dish.layout!
    const lineW = L.w * this.widthCm
    const lineH = L.h * this.heightCm
    const thick = s === "underline-contains" ? Math.min(0.4, Math.max(0.18, 0.3 * lineH)) : Math.min(0.28, Math.max(0.12, 0.18 * lineH))
    const gap = Math.max(0.08, 0.2 * lineH)
    bar.underline.getTransform().setLocalPosition(new vec3(0, -lineH / 2 - gap - thick / 2, 0.05))
    bar.underline.getTransform().setLocalScale(new vec3((lineW + 0.3) / SQUARE_GLYPH_COVERAGE, thick / SQUARE_GLYPH_COVERAGE, 1))
    this.showNote(bar, (s === "underline-contains" || s === "dot-unverified") && bar.revealed && bar.revealT > 0.5 && bar.note.length > 0, lineW, lineH, thick, gap)
    const t = this.tintFor(s)
    const u = this.underlineTint(s)
    const ra = this.revealAlpha(bar)
    bar.fullMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, FULL_ALPHA * this.alpha())
    bar.underlineMat.mainPass.baseColor = new vec4(u.x, u.y, u.z, this.underlineAlpha(s) * this.alpha() * ra)
    bar.dotMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, DOT_ALPHA * this.alpha())
    bar.starMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, this.alpha())
  }

  /**
   * The reason under a pointed-at red or grey line: a small chip just below the underline, left-aligned with the
   * name ("contains peanuts, tree nuts" / "not sure: ingredients not published"). Green needs no explanation.
   */
  private showNote(bar: Bar, show: boolean, lineW: number, lineH: number, thick: number, gap: number): void {
    if (!show) {
      if (bar.noteRoot) bar.noteRoot.enabled = false
      return
    }
    // A short paragraph: wrapped to ~30 characters a line, up to four lines, the plate grows with it.
    const lines = wrapWords(bar.note, 30, 4)
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
    const W = Math.min(this.widthCm * 0.6, Math.max(5, longest * 0.3 + 1.4))
    const H = 0.6 + 0.85 * lines.length
    const text = lines.join("\n")
    if (!bar.noteRoot) {
      const root = UI.obj(bar.root, "Note", new vec3(0, 0, 0.35))
      root.createComponent("Component.Canvas")
      const plate = root.createComponent(BackPlate.getTypeName()) as BackPlate
      plate.size = new vec2(W, H)
      const content = UI.obj(root, "Content", new vec3(0, 0, UI.CONTENT_Z))
      const row = UI.flexRow(content, W, H, {gap: 0.4, padX: 0.5, justify: FlexJustify.Start, align: FlexAlign.Center})
      bar.noteText = UI.addRowText(row, text, "Caption", 45, W - 1.0, HorizontalAlignment.Left, UI.WHITE_SOFT)
      bar.notePlate = plate
      bar.noteRoot = root
    } else {
      if (bar.noteText) bar.noteText.text = text
      if (bar.notePlate) bar.notePlate.size = new vec2(W, H)
    }
    if (bar.noteText) bar.noteText.layoutRect = Rect.create(-(W - 1.0) / 2, (W - 1.0) / 2, -H / 2, H / 2)
    const startX = (this.mirrored ? 1 : -1) * (lineW / 2 - W / 2) // left-aligned with the (possibly mirrored) name
    bar.noteRoot.getTransform().setLocalPosition(new vec3(startX, -lineH / 2 - gap - thick - 0.25 - H / 2, 0.35))
    bar.noteRoot.enabled = true
  }

  private applyFade(): void {
    for (const bar of this.bars) {
      const t = this.tintFor(bar.style)
      const u = this.underlineTint(bar.style)
      bar.fullMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, FULL_ALPHA * this.alpha())
      bar.underlineMat.mainPass.baseColor = new vec4(u.x, u.y, u.z, this.underlineAlpha(bar.style) * this.alpha() * this.revealAlpha(bar))
      bar.dotMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, DOT_ALPHA * this.alpha())
      bar.starMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, this.alpha())
    }
  }

  /** Screen point (0..1, 0..1) of a page-local point, via the main camera. */
  private screenPointOfLocal(x: number, y: number): vec2 | null {
    const cam = WorldCameraFinderProvider.getInstance().getComponent()
    if (!cam) return null
    const world = this.sceneObject.getTransform().getWorldTransform().multiplyPoint(new vec3(x, y, 0.3))
    return cam.worldSpaceToScreenSpace(world)
  }

  /** Screen x (0..1) of a page-local point, via the main camera. */
  private screenXOfLocal(x: number, y: number): number | null {
    const cam = WorldCameraFinderProvider.getInstance().getComponent()
    if (!cam) return null
    const world = this.sceneObject.getTransform().getWorldTransform().multiplyPoint(new vec3(x, y, 0.3))
    const sp = cam.worldSpaceToScreenSpace(world)
    return sp.x
  }

  /**
   * Arrow chip: when the mood is a category, none of its marked lines is inside the
   * display band, but some exist on the page → a small "Chicken →" / "← Chicken" chip at
   * the band edge nearest to them. Hidden as soon as a matching line is in view.
   */
  private updateArrow(force: boolean): void {
    if (!this.arrowRoot || !this.arrowText || !this.arrowPlate) return
    const want = this.moodLabel !== null && this._active
    const lines = want ? this.bars.filter((b) => b.inCategory && b.style !== "none" && b.style !== "quiet") : []
    if (lines.length === 0) {
      this.showArrow(false, "")
      return
    }
    let anyInView = false
    let sumX = 0
    let sumLocalX = 0
    let sumLocalY = 0
    for (const b of lines) {
      const sx = this.screenXOfLocal(b.x, b.y)
      if (sx === null) return
      if (sx >= this.displayBandMin && sx <= this.displayBandMax) anyInView = true
      sumX += sx
      sumLocalX += b.x
      sumLocalY += b.y
    }
    if (anyInView) {
      this.showArrow(false, "")
      return
    }
    const meanSx = sumX / lines.length
    const left = meanSx < this.displayBandMin
    const label = left ? `← ${this.moodLabel}` : `${this.moodLabel} →`
    // Walk from the lines' mean position toward the page centre until the chip projects
    // just inside the band edge nearest to them.
    let lx = sumLocalX / lines.length
    const ly = sumLocalY / lines.length
    const stepDir = left ? 1 : -1
    const target = left ? this.displayBandMin + 0.05 : this.displayBandMax - 0.05
    for (let i = 0; i < 60; i++) {
      const sx = this.screenXOfLocal(lx, ly)
      if (sx === null) return
      if ((left && sx >= target) || (!left && sx <= target)) break
      lx += stepDir * 0.5
      if (Math.abs(lx) > this.widthCm / 2 + 6) break
    }
    this.arrowRoot.getTransform().setLocalPosition(new vec3(lx, ly, 0.5))
    this.showArrow(true, label)
  }

  private showArrow(visible: boolean, label: string): void {
    if (!this.arrowRoot || !this.arrowText) return
    if (visible && label !== this._arrowLabel) this.arrowText.text = label
    this._arrowLabel = visible ? label : ""
    this._arrowVisible = visible
    this.arrowRoot.enabled = visible
  }

  private buildBar(dish: DishDef): Bar {
    const L = dish.layout!
    const lineW = L.w * this.widthCm
    const lineH = L.h * this.heightCm
    const w = lineW + this.barPaddingCm
    const h = lineH + this.barPaddingCm
    const x = (L.x + L.w / 2 - 0.5) * this.widthCm * (this.mirrored ? -1 : 1)
    const y = (0.5 - (L.y + L.h / 2)) * this.heightCm
    // Wrapper (unit scale) owns the collider + Interactable; every visual is a child.
    const root = UI.obj(this.barsRoot!, `Bar-${dish.id}`, new vec3(x, y, 0.3))
    const collider = root.createComponent("Physics.ColliderComponent") as ColliderComponent
    const shape = Shape.createBoxShape()
    shape.size = new vec3(Math.max(w + DOT_SIZE + 0.8, 2), Math.max(h, 1.4), 1.2) // pinch target incl. the end dot
    collider.shape = shape
    collider.fitVisual = false
    const interactable = root.createComponent(Interactable.getTypeName()) as Interactable
    interactable.onTriggerEnd.add(() => this._onBarPinched.invoke({restaurantId: this.restaurantId, dishId: dish.id}))

    const full = this.quad(root, "Full", 0, 0, w, h, BAR_TEX)
    // Every verdict is an UNDERLINE under the dish name (thickness set per style in applyStyle): a line the
    // length of the name still reads as attached to it when marker tracking is a few millimetres off, where a
    // floating dot reads as a random square. The dot quad stays only as a disabled placeholder.
    const underline = this.quad(root, "Underline", 0, -lineH / 2 - 0.15, lineW + 0.6, 0.2, BAR_TEX)
    const endX = lineW / 2 + 0.45
    const dot = this.quad(root, "Dot", endX, 0, DOT_SIZE, DOT_SIZE, BAR_TEX)
    const star = this.quad(root, "Star", endX + 0.1, 0, STAR_SIZE, STAR_SIZE, STAR_TEX, 1)
    root.enabled = false
    const bar: Bar = {
      dish, root, style: "none", inCategory: false, picked: true, revealed: false, hideAt: 0, hoverSince: -1, revealT: 0, note: "", noteRoot: null, noteText: null, notePlate: null,
      full: full.so, fullMat: full.mat,
      underline: underline.so, underlineMat: underline.mat,
      dot: dot.so, dotMat: dot.mat,
      star: star.so, starMat: star.mat,
      x, y, w, h,
    }
    // Point to reveal, one dish at a time: the pointer (finger on the glasses, mouse in Lens Studio) has to REST
    // on a line for DWELL_SEC before its verdict fades in; sweeping across the page lights nothing. When a new
    // dish lights, the previous one goes out at once; otherwise a verdict lingers a moment after the pointer leaves.
    interactable.onHoverEnter.add(() => {
      bar.hoverSince = getTime()
      bar.hideAt = Number.POSITIVE_INFINITY
    })
    interactable.onHoverExit.add(() => {
      bar.hoverSince = -1
      if (bar.revealed) bar.hideAt = getTime() + REVEAL_LINGER_SEC
    })
    return bar
  }

  /** A tinted Image quad (square glyph stretched to w x h cm) at a page-local offset. */
  private quad(parent: SceneObject, name: string, x: number, y: number, w: number, h: number,
      tex: Texture, glyphCoverage: number = SQUARE_GLYPH_COVERAGE): {so: SceneObject; mat: Material} {
    const so = UI.obj(parent, name, new vec3(x, y, 0.05))
    const img = so.createComponent("Component.Image") as Image
    const mat = imageMaterial.clone()
    mat.mainPass.baseTex = tex
    mat.mainPass.baseColor = new vec4(1, 1, 1, 0)
    mat.mainPass.depthTest = true
    mat.mainPass.depthWrite = false
    img.clearMaterials()
    img.addMaterial(mat)
    so.getTransform().setLocalScale(new vec3(w / glyphCoverage, h / glyphCoverage, 1))
    so.enabled = false
    return {so, mat}
  }

  private buildBadge(): void {
    const W = Math.min(this.widthCm, this.badgeWidthCm)
    const H = 1.4
    this.badgeRoot = UI.obj(this.sceneObject, "Badge", new vec3(0.5, this.heightCm / 2 + this.badgeEdgeOffsetCm, 0.3))
    this.badgeRoot.createComponent("Component.Canvas")
    const plate = this.badgeRoot.createComponent(BackPlate.getTypeName()) as BackPlate
    plate.size = new vec2(W, H)
    const content = UI.obj(this.badgeRoot, "Content", new vec3(0, 0, UI.CONTENT_Z))
    const row = UI.flexRow(content, W, H, {gap: 0.5, padX: 0.6, justify: FlexJustify.Start, align: FlexAlign.Center})
    const dot = UI.addImage(row, BAR_TEX, 0.7, 0.7, new vec4(1, 1, 1, 0))
    this.badgeDotMat = dot.mainMaterial
    this.badgeText = UI.addRowText(row, "", "Caption", 45, W - 2.2, HorizontalAlignment.Left, UI.WHITE_SOFT)
  }

  private buildArrow(): void {
    const W = 6.5
    const H = 1.3
    this.arrowRoot = UI.obj(this.sceneObject, "MoodArrow", new vec3(0, 0, 0.5))
    this.arrowRoot.createComponent("Component.Canvas")
    this.arrowPlate = this.arrowRoot.createComponent(BackPlate.getTypeName()) as BackPlate
    this.arrowPlate.size = new vec2(W, H)
    const content = UI.obj(this.arrowRoot, "Content", new vec3(0, 0, UI.CONTENT_Z))
    const row = UI.flexRow(content, W, H, {justify: FlexJustify.Center, align: FlexAlign.Center})
    this.arrowText = UI.addRowText(row, "", "Caption", 45, W - 0.6, HorizontalAlignment.Center, new vec4(1, 1, 1, 1))
    this.arrowRoot.enabled = false
  }
}

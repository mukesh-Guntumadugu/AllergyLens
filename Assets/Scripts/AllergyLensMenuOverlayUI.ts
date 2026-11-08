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
export const MENU_MARKERS: {[restaurantId: string]: {marker: MarkerAsset; texture: Texture}} = {
  "laurel-cafe": {marker: requireAsset("../Markers/MenuMarker-laurel-cafe.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/laurel-cafe-menu-1.png") as Texture},
  "tatlilar": {marker: requireAsset("../Markers/MenuMarker-tatlilar.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/tatlilar-menu-1.png") as Texture},
  "chinese-menu": {marker: requireAsset("../Markers/MenuMarker-chinese-menu.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/chinese-menu-menu-1.png") as Texture},
  "kitchen-section": {marker: requireAsset("../Markers/MenuMarker-kitchen-section.imgmarker") as MarkerAsset, texture: requireAsset("../Markers/kitchen-section-menu-1.png") as Texture},
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
export type MarkStyle = "none" | "dot-safe" | "dot-unverified" | "underline-contains" | "star-safe"

export interface DishMark {
  dishId: string
  style: MarkStyle
  /** In the user's chosen mood category (drives the arrow chip). */
  inCategory: boolean
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
  /** page-local centre + size in cm */
  x: number
  y: number
  w: number
  h: number
}

const FULL_ALPHA = 0.35
const UNDERLINE_ALPHA = 0.85
const DOT_ALPHA = 0.8
const DOT_SIZE = 0.5
const STAR_SIZE = 0.9
const FADE_SEC = 0.4

@component
export class AllergyLensMenuOverlayUI extends BaseScriptComponent {
  /** Set by Main right before createComponent so a runtime-created overlay knows its restaurant (inputs are at defaults then). */
  static pending: {restaurantId: string; texture: Texture} | null = null

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
  lostHideDelaySec: number = 0.6

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
    }
  }

  private tintFor(style: MarkStyle): vec3 {
    return style === "star-safe" || style === "dot-safe" ? this.safeColor : style === "underline-contains" ? this.flagColor : this.unverifiedColor
  }

  private applyStyle(bar: Bar): void {
    const s = bar.style
    const marked = s !== "none"
    bar.root.enabled = marked && this._active
    bar.full.enabled = s === "star-safe"
    bar.underline.enabled = s === "underline-contains" || s === "dot-safe" || s === "dot-unverified"
    bar.dot.enabled = false
    bar.star.enabled = s === "star-safe"
    // Thick red line for "contains", a thin one for safe / unverified (colour tells the rest).
    const L = bar.dish.layout!
    const lineW = L.w * this.widthCm
    const lineH = L.h * this.heightCm
    const thick = s === "underline-contains" ? Math.max(0.32, 0.6 * lineH) : Math.max(0.2, 0.35 * lineH)
    bar.underline.getTransform().setLocalPosition(new vec3(0, -lineH / 2 - thick / 2 - 0.04, 0.05))
    bar.underline.getTransform().setLocalScale(new vec3((lineW + 0.6) / SQUARE_GLYPH_COVERAGE, thick / SQUARE_GLYPH_COVERAGE, 1))
    const t = this.tintFor(s)
    bar.fullMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, FULL_ALPHA * this.fade)
    bar.underlineMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, UNDERLINE_ALPHA * this.fade)
    bar.dotMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, DOT_ALPHA * this.fade)
    bar.starMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, this.fade)
  }

  private applyFade(): void {
    for (const bar of this.bars) {
      const t = this.tintFor(bar.style)
      bar.fullMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, FULL_ALPHA * this.fade)
      bar.underlineMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, UNDERLINE_ALPHA * this.fade)
      bar.dotMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, DOT_ALPHA * this.fade)
      bar.starMat.mainPass.baseColor = new vec4(t.x, t.y, t.z, this.fade)
    }
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
    const lines = want ? this.bars.filter((b) => b.inCategory && b.style !== "none") : []
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
    const x = (L.x + L.w / 2 - 0.5) * this.widthCm
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
    return {
      dish, root, style: "none", inCategory: false,
      full: full.so, fullMat: full.mat,
      underline: underline.so, underlineMat: underline.mat,
      dot: dot.so, dotMat: dot.mat,
      star: star.so, starMat: star.mat,
      x, y, w, h,
    }
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

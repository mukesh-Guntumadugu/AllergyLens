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
import {DishVerdict, RestaurantBadgeLevel} from "./AllergyLensChecker"
import * as UI from "./AllergyLensSharedUI"

const BAR_TEX = requireAsset("../Icons/square.png") as Texture
const SQUARE_GLYPH_COVERAGE = 0.75 // the glyph fills 18/24 of its canvas
const imageMaterial = requireAsset("../Materials/ImageMaterial.mat") as Material

export interface BarPinchEvent {
  restaurantId: string
  dishId: string
}

interface Bar {
  dish: DishDef
  root: SceneObject
  mat: Material
  /** page-local centre + size in cm */
  x: number
  y: number
  w: number
  h: number
}

@component
export class AllergyLensMenuOverlayUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensMenuOverlayUI – highlights + badge on a tracked real menu</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Restaurant id from the data (must have a menuImage). The marker on this object is that page.")
  restaurantId: string = "star-of-india"

  @input
  @hint("Padding (cm) added around each printed line's OCR box; bars are otherwise exactly the line's width and height.")
  @widget(new SliderWidget(0, 0.5, 0.05))
  barPaddingCm: number = 0.2

  @input
  @hint("Opacity of the highlight bars over the paper.")
  @widget(new SliderWidget(0.1, 1, 0.05))
  barAlpha: number = 0.6

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
  @hint("Seconds to keep the overlay after the marker is lost before hiding it.")
  @widget(new SliderWidget(0, 5, 0.1))
  lostHideDelaySec: number = 1.0

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
  private badgeRoot: SceneObject | null = null
  private badgeText: Text | null = null
  private badgeDotMat: Material | null = null
  private _badgeLevel: RestaurantBadgeLevel | "" = ""
  private _badgeText = ""
  private _active = false
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

  onAwake(): void {
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
    this.hideTimer.bind(() => this.setShown(false))

    this.barsRoot = UI.obj(this.sceneObject, "Bars")
    for (const dish of this.restaurant.dishes) {
      if (dish.layout) this.bars.push(this.buildBar(dish))
    }
    this.buildBadge()
    this.setShown(false)
  }

  // ── Public API (Main pushes state in) ──────────────────────────────────
  /** Tint every bar for the given verdicts (by dish id). Unlisted dishes keep "none". */
  setDishStates(states: Array<{dishId: string; verdict: DishVerdict}>): void {
    const map = new Map<string, DishVerdict>()
    for (const s of states) map.set(s.dishId, s.verdict)
    for (const bar of this.bars) {
      const v = map.get(bar.dish.id) ?? "none"
      const tint = v === "safe" ? this.safeColor : v === "contains" ? this.flagColor : v === "unverified" ? this.unverifiedColor : null
      bar.root.enabled = !!tint && this._active
      if (tint) bar.mat.mainPass.baseColor = new vec4(tint.x, tint.y, tint.z, this.barAlpha)
    }
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
  simulateFound(): boolean {
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
    const pos = cam.getWorldPosition().add(look.uniformScale(60)).add(up.uniformScale(-12))
    const t = this.sceneObject.getTransform()
    t.setWorldPosition(pos)
    t.setWorldRotation(rot) // the page's +Z faces the user
    t.setWorldScale(new vec3(1, 1, 1))
    this.handleFound()
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
    this._onFound.invoke(this.restaurantId)
  }

  private handleLost(): void {
    this._active = false
    this._onLost.invoke(this.restaurantId)
    if (this.lostHideDelaySec <= 0) this.setShown(false)
    else this.hideTimer?.reset(this.lostHideDelaySec)
  }

  private setShown(shown: boolean): void {
    if (this.barsRoot) this.barsRoot.enabled = shown
    if (this.badgeRoot) this.badgeRoot.enabled = shown
  }

  private buildBar(dish: DishDef): Bar {
    const L = dish.layout!
    const w = L.w * this.widthCm + this.barPaddingCm
    const h = L.h * this.heightCm + this.barPaddingCm
    const x = (L.x + L.w / 2 - 0.5) * this.widthCm
    const y = (0.5 - (L.y + L.h / 2)) * this.heightCm
    // Wrapper (unit scale) owns the collider + Interactable; the scaled visual is a child.
    const root = UI.obj(this.barsRoot!, `Bar-${dish.id}`, new vec3(x, y, 0.3))
    const collider = root.createComponent("Physics.ColliderComponent") as ColliderComponent
    const shape = Shape.createBoxShape()
    shape.size = new vec3(Math.max(w, 2), Math.max(h, 1.4), 1.2) // pinch target at least 2 x 1.4 cm
    collider.shape = shape
    collider.fitVisual = false
    const interactable = root.createComponent(Interactable.getTypeName()) as Interactable
    interactable.onTriggerEnd.add(() => this._onBarPinched.invoke({restaurantId: this.restaurantId, dishId: dish.id}))

    const visual = UI.obj(root, "Visual")
    const img = visual.createComponent("Component.Image") as Image
    const mat = imageMaterial.clone()
    mat.mainPass.baseTex = BAR_TEX
    mat.mainPass.baseColor = new vec4(1, 1, 1, 0)
    mat.mainPass.depthTest = true
    mat.mainPass.depthWrite = false
    img.clearMaterials()
    img.addMaterial(mat)
    visual.getTransform().setLocalScale(new vec3(w / SQUARE_GLYPH_COVERAGE, h / SQUARE_GLYPH_COVERAGE, 1))
    root.enabled = false
    return {dish, root, mat, x, y, w, h}
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
}

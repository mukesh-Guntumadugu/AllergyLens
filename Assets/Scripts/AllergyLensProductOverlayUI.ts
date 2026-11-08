// AllergyLensProductOverlayUI — sits on a ProductMarker SceneObject (MarkerTrackingComponent +
// ImageMarker of a packaged product's front label). Draws a thin outline around the label
// in the verdict colour and one chip above it ("Jif Creamy Peanut Butter · contains
// peanuts, soy"); the label itself is the pinch target for the detail card. Owns:
// found/lost handling (outline hides ~1 s after the marker is lost), the pinch event and
// the simulate hook. Expects @input barcode (a product in the bundled data) and
// labelHeightCm (= the ImageMarker's height). Must not run the check — Main pushes the
// verdict in.
//
// Adding a product = a label photo as an ImageMarker + a SceneObject with
// MarkerTrackingComponent + this script and its barcode; the data comes from
// tools/scrape/fetch_products.py --barcode <code>.

import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {ProductDef, getProduct} from "./AllergyLensMenuData"
import {RestaurantBadgeLevel} from "./AllergyLensChecker"
import * as UI from "./AllergyLensSharedUI"

const BAR_TEX = requireAsset("../Icons/square.png") as Texture
const SQUARE_GLYPH_COVERAGE = 0.75
const imageMaterial = requireAsset("../Materials/ImageMaterial.mat") as Material
const FRAME_ALPHA = 0.7
const FRAME_THICKNESS = 0.3
const FADE_SEC = 0.4

/** Label markers bundled with the Lens, by barcode. Main creates a ProductMarker object per entry at start. */
export const PRODUCT_MARKERS: {[barcode: string]: {marker: MarkerAsset; texture: Texture; heightCm: number}} = {
  "0051500255162": {
    marker: requireAsset("../Markers/ProductMarker-0051500255162.imgmarker") as MarkerAsset,
    texture: requireAsset("../Markers/product-0051500255162.png") as Texture,
    heightCm: 10,
  },
  "7eleven-gummi-worms": {
    marker: requireAsset("../Markers/ProductMarker-7eleven-gummi-worms.imgmarker") as MarkerAsset,
    texture: requireAsset("../Markers/product-7eleven-gummi-worms.png") as Texture,
    heightCm: 15, // the Nutrition Facts panel on the back of the bag
  },
}

@component
export class AllergyLensProductOverlayUI extends BaseScriptComponent {
  /** Set by Main right before createComponent so a runtime-created overlay knows its product (inputs are at defaults then). */
  static pending: {barcode: string; heightCm: number; texture: Texture | null} | null = null

  @ui.label('<span style="color: #60A5FA;">AllergyLensProductOverlayUI – outline + chip on a tracked product label</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Barcode of a product in the bundled Open Food Facts data (digits only).")
  barcode: string = "0051500255162"

  @input
  @hint("Real height of the label marker in cm (same value as the ImageMarker asset).")
  @widget(new SliderWidget(2, 40, 0.5))
  labelHeightCm: number = 10

  @input
  @hint("Chip width in cm.")
  @widget(new SliderWidget(8, 30, 0.5))
  chipWidthCm: number = 16

  @input("vec3", "{0.55, 0.95, 0.6}")
  @widget(new ColorWidget())
  safeColor: vec3

  @input("vec3", "{0.98, 0.45, 0.45}")
  @widget(new ColorWidget())
  flagColor: vec3

  @input("vec3", "{1.0, 0.8, 0.3}")
  @widget(new ColorWidget())
  unverifiedColor: vec3

  @input
  @hint("Seconds to keep the overlay after the marker is lost before it fades out.")
  @widget(new SliderWidget(0, 5, 0.1))
  lostHideDelaySec: number = 0.6
  @ui.group_end

  private product: ProductDef | null = null
  private widthCm = 16
  private heightCm = 10
  private frameRoot: SceneObject | null = null
  private labelTexture: Texture | null = null
  private labelImage: SceneObject | null = null
  private frameMats: Material[] = []
  private chipRoot: SceneObject | null = null
  private chipText: Text | null = null
  private chipDotMat: Material | null = null
  private _level: RestaurantBadgeLevel | "" = ""
  private _text = ""
  private _active = false
  private fade = 0
  private fadeTarget = 0
  private simulated = false
  private cameraTrackingWanted = true
  private tracker: MarkerTrackingComponent | null = null
  private hideTimer: DelayedCallbackEvent | null = null
  private _onFound = new Event<string>()
  private _onLost = new Event<string>()
  private _onPinched = new Event<string>()

  get onFound(): PublicApi<string> {
    return this._onFound.publicApi()
  }

  get onLost(): PublicApi<string> {
    return this._onLost.publicApi()
  }

  /** The label was pinched: fires with the barcode. */
  get onPinched(): PublicApi<string> {
    return this._onPinched.publicApi()
  }

  get isActive(): boolean {
    return this._active
  }

  get verdictLevel(): string {
    return this._level
  }

  get chipTextValue(): string {
    return this._text
  }

  /** Label geometry in local cm (centre + size), for placing the detail card beside it. */
  get labelGeometry(): {x: number; y: number; w: number; h: number} {
    return {x: 0, y: 0, w: this.widthCm, h: this.heightCm}
  }

  get chipCapacityChars(): number {
    return Math.floor((this.chipWidthCm - 2.2) / (0.5 * 45 / 110))
  }

  onAwake(): void {
    const pending = AllergyLensProductOverlayUI.pending
    if (pending) {
      this.barcode = pending.barcode
      this.labelHeightCm = pending.heightCm
      this.labelTexture = pending.texture
      AllergyLensProductOverlayUI.pending = null
    }
    this.product = getProduct(this.barcode) ?? null
    if (!this.product) {
      print(`AllergyLensProductOverlayUI: no product with barcode "${this.barcode}" in the data — overlay disabled.`)
      return
    }
    const tracker = this.sceneObject.getComponent("Component.MarkerTrackingComponent") as MarkerTrackingComponent | null
    this.tracker = tracker
    let aspect = 1.6
    if (tracker) {
      tracker.autoEnableWhenTracking = false
      tracker.onMarkerFound = () => this.handleFound()
      tracker.onMarkerLost = () => this.handleLost()
      try {
        const a = tracker.marker.getAspectRatio()
        if (a > 0) aspect = a
      } catch (e) {
        print(`AllergyLensProductOverlayUI: marker aspect unavailable (${e}); using ${aspect}`)
      }
    } else {
      print(`AllergyLensProductOverlayUI: no MarkerTrackingComponent on ${this.sceneObject.name}; simulate-only.`)
    }
    this.heightCm = this.labelHeightCm
    this.widthCm = this.heightCm * aspect

    this.hideTimer = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.hideTimer.bind(() => {
      this.fadeTarget = 0
    })
    this.createEvent("UpdateEvent").bind(() => this.onUpdate())

    this.buildSimulatedLabel()
    this.buildFrame()
    this.buildChip()
    this.setShown(false)
  }

  // ── Public API ─────────────────────────────────────────────────────────
  setVerdict(level: RestaurantBadgeLevel, text: string): void {
    this._level = level
    this._text = text
    const tint = level === "good" ? this.safeColor : level === "caution" ? this.unverifiedColor : this.flagColor
    if (this.chipText) this.chipText.text = text
    if (this.chipText) this.chipText.textFill.color = new vec4(tint.x, tint.y, tint.z, 1)
    if (this.chipDotMat) this.chipDotMat.mainPass.baseColor = new vec4(tint.x, tint.y, tint.z, 1)
    this.applyFade()
  }

  /** Debug / tests: park the label 50 cm ahead, facing the user, and act as found. Refused while the camera tracks it. */
  simulateFound(offsetXcm: number = 0): boolean {
    if (this.tracker && this.tracker.enabled && this.tracker.isTracking()) {
      print(`AllergyLensProductOverlayUI: simulateFound ignored — ${this.barcode} is being tracked by the camera`)
      return false
    }
    if (this.tracker) this.tracker.enabled = false
    this.simulated = true
    const cam = WorldCameraFinderProvider.getInstance().getTransform()
    const rot = cam.getWorldRotation()
    const look = rot.multiplyVec3(new vec3(0, 0, -1))
    const up = rot.multiplyVec3(new vec3(0, 1, 0))
    const right = rot.multiplyVec3(new vec3(1, 0, 0))
    const pos = cam.getWorldPosition().add(look.uniformScale(50)).add(up.uniformScale(-8)).add(right.uniformScale(offsetXcm))
    const t = this.sceneObject.getTransform()
    t.setWorldPosition(pos)
    t.setWorldRotation(rot)
    t.setWorldScale(new vec3(1, 1, 1))
    this.handleFound()
    if (this.labelImage) this.labelImage.enabled = true // the label itself, only on a simulated label
    return true
  }

  simulateLost(): void {
    const wasSimulated = this.simulated
    this.simulated = false
    this.handleLost()
    if (wasSimulated && this.tracker && this.cameraTrackingWanted) this.tracker.enabled = true
  }

  setCameraTracking(enabled: boolean): void {
    this.cameraTrackingWanted = enabled
    if (this.tracker && !this.simulated) this.tracker.enabled = enabled
  }

  // ── Private ────────────────────────────────────────────────────────────
  private handleFound(): void {
    this.hideTimer?.cancel()
    this._active = true
    this.setShown(true)
    if (!this.simulated && this.labelImage) this.labelImage.enabled = false // the camera sees the real label
    this.fadeTarget = 1
    this._onFound.invoke(this.barcode)
  }

  private handleLost(): void {
    this._active = false
    this._onLost.invoke(this.barcode)
    if (this.lostHideDelaySec <= 0) this.fadeTarget = 0
    else this.hideTimer?.reset(this.lostHideDelaySec)
  }

  private setShown(shown: boolean): void {
    if (this.frameRoot) this.frameRoot.enabled = shown
    if (this.chipRoot) this.chipRoot.enabled = shown
    if (!shown && this.labelImage) this.labelImage.enabled = false
    if (!shown) this.fade = 0
  }

  /** The label image (from PRODUCT_MARKERS) behind the outline; drawn only while simulated. */
  private buildSimulatedLabel(): void {
    if (!this.labelTexture) return
    const so = UI.obj(this.sceneObject, "SimulatedLabel", new vec3(0, 0, 0))
    const img = so.createComponent("Component.Image") as Image
    const mat = imageMaterial.clone()
    mat.mainPass.baseTex = this.labelTexture
    mat.mainPass.baseColor = new vec4(1, 1, 1, 1)
    mat.mainPass.depthTest = true
    mat.mainPass.depthWrite = true
    img.clearMaterials()
    img.addMaterial(mat)
    so.getTransform().setLocalScale(new vec3(this.widthCm, this.heightCm, 1))
    so.enabled = false
    this.labelImage = so
  }

  private onUpdate(): void {
    if (this.fade === this.fadeTarget) return
    const step = getDeltaTime() / FADE_SEC
    this.fade = this.fadeTarget > this.fade ? Math.min(this.fadeTarget, this.fade + step) : Math.max(this.fadeTarget, this.fade - step)
    this.applyFade()
    if (this.fade === 0 && this.fadeTarget === 0 && !this._active) this.setShown(false)
  }

  private applyFade(): void {
    const t = this._level === "good" ? this.safeColor : this._level === "caution" ? this.unverifiedColor : this.flagColor
    for (const m of this.frameMats) m.mainPass.baseColor = new vec4(t.x, t.y, t.z, FRAME_ALPHA * this.fade)
  }

  /** Four thin bars just outside the label's edges + a collider over the label for the pinch. */
  private buildFrame(): void {
    this.frameRoot = UI.obj(this.sceneObject, "Frame", new vec3(0, 0, 0.3))
    const w = this.widthCm + FRAME_THICKNESS
    const h = this.heightCm + FRAME_THICKNESS
    const T = FRAME_THICKNESS
    this.quad(this.frameRoot, "Top", 0, h / 2, w + T, T)
    this.quad(this.frameRoot, "Bottom", 0, -h / 2, w + T, T)
    this.quad(this.frameRoot, "Left", -w / 2, 0, T, h)
    this.quad(this.frameRoot, "Right", w / 2, 0, T, h)
    const collider = this.frameRoot.createComponent("Physics.ColliderComponent") as ColliderComponent
    const shape = Shape.createBoxShape()
    shape.size = new vec3(this.widthCm, this.heightCm, 1.5)
    collider.shape = shape
    collider.fitVisual = false
    const interactable = this.frameRoot.createComponent(Interactable.getTypeName()) as Interactable
    interactable.onTriggerEnd.add(() => this._onPinched.invoke(this.barcode))
  }

  private quad(parent: SceneObject, name: string, x: number, y: number, w: number, h: number): void {
    const so = UI.obj(parent, name, new vec3(x, y, 0.05))
    const img = so.createComponent("Component.Image") as Image
    const mat = imageMaterial.clone()
    mat.mainPass.baseTex = BAR_TEX
    mat.mainPass.baseColor = new vec4(1, 1, 1, 0)
    mat.mainPass.depthTest = true
    mat.mainPass.depthWrite = false
    img.clearMaterials()
    img.addMaterial(mat)
    so.getTransform().setLocalScale(new vec3(w / SQUARE_GLYPH_COVERAGE, h / SQUARE_GLYPH_COVERAGE, 1))
    this.frameMats.push(mat)
  }

  private buildChip(): void {
    const W = this.chipWidthCm
    const H = 1.4
    this.chipRoot = UI.obj(this.sceneObject, "Chip", new vec3(0, this.heightCm / 2 + 1.4, 0.3))
    this.chipRoot.createComponent("Component.Canvas")
    const plate = this.chipRoot.createComponent(BackPlate.getTypeName()) as BackPlate
    plate.size = new vec2(W, H)
    const content = UI.obj(this.chipRoot, "Content", new vec3(0, 0, UI.CONTENT_Z))
    const row = UI.flexRow(content, W, H, {gap: 0.5, padX: 0.6, justify: FlexJustify.Start, align: FlexAlign.Center})
    const dot = UI.addImage(row, BAR_TEX, 0.7, 0.7, new vec4(1, 1, 1, 0))
    this.chipDotMat = dot.mainMaterial
    this.chipText = UI.addRowText(row, "", "Caption", 45, W - 2.2, HorizontalAlignment.Left, UI.WHITE_SOFT)
  }
}

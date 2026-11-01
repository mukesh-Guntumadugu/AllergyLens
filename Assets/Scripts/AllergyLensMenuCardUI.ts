// AllergyLensMenuCardUI — the real-size menu card standing on the table: six dish
// tiles (icon + name) in two columns, each a pinchable UIKit Button with a
// transparent green/red highlight painted directly on it. Owns: tile construction,
// highlight tinting, dish-pinch events. Expects no scene @inputs (Main wires it as a
// typed handle). Must not decide which dishes are safe — Main pushes verdicts in.

import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {GridLayout} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Grid/GridLayout"
import {GridItem} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Grid/GridItem"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {DISHES} from "./AllergyLensMenuData"
import * as UI from "./AllergyLensSharedUI"

const ICONS: Record<string, Texture> = {
  ramen_dining: requireAsset("../Icons/ramen_dining.png") as Texture,
  lunch_dining: requireAsset("../Icons/lunch_dining.png") as Texture,
  set_meal: requireAsset("../Icons/set_meal.png") as Texture,
  local_pizza: requireAsset("../Icons/local_pizza.png") as Texture,
  rice_bowl: requireAsset("../Icons/rice_bowl.png") as Texture,
  cake: requireAsset("../Icons/cake.png") as Texture,
}
// Filled rounded square — stretched and tinted, it becomes the translucent highlight.
const HIGHLIGHT_TEX = requireAsset("../Icons/square.png") as Texture
const SQUARE_GLYPH_COVERAGE = 0.75 // the glyph fills 18/24 of its canvas
const imageMaterial = requireAsset("../Materials/ImageMaterial.mat") as Material

export type DishState = "none" | "safe" | "flagged"

const PAD = 1.2
const HEADER_H = 2.6
const GAP = 0.6
const COLS = 2
const ROWS = 3

interface Tile {
  root: SceneObject
  overlay: SceneObject
  overlayMat: Material
}

@component
export class AllergyLensMenuCardUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensMenuCardUI – menu card with six highlightable dishes</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Card width in cm (brief default 35).")
  @widget(new SliderWidget(20, 60, 1))
  cardWidthCm: number = 35

  @input
  @hint("Card height in cm (brief default 25).")
  @widget(new SliderWidget(15, 45, 1))
  cardHeightCm: number = 25

  @input
  @hint("Title printed at the top of the card.")
  title: string = "Menu"

  @input("vec4", "{0.55, 0.95, 0.6, 0.35}")
  @hint("Transparent light-green highlight for dishes you can eat.")
  @widget(new ColorWidget())
  safeColor: vec4

  @input("vec4", "{0.98, 0.45, 0.45, 0.42}")
  @hint("Transparent light-red highlight for dishes containing something from your profile.")
  @widget(new ColorWidget())
  flagColor: vec4

  @input
  @hint("Viewing distance (cm) used to scale text; the card sits ~65 cm from the user.")
  @widget(new SliderWidget(40, 110, 5))
  textDistanceCm: number = 70
  @ui.group_end

  private tiles: Tile[] = []
  private pendingStates: DishState[] = DISHES.map(() => "none" as DishState)
  private _onDishPinched = new Event<number>()

  /** Fires with the dish index (0-5) when the user pinches a dish tile. */
  get onDishPinched(): PublicApi<number> {
    return this._onDishPinched.publicApi()
  }

  get dishCount(): number {
    return DISHES.length
  }

  onAwake(): void {
    const W = this.cardWidthCm
    const H = this.cardHeightCm
    this.sceneObject.createComponent("Component.Canvas")
    const plate = this.sceneObject.createComponent(BackPlate.getTypeName()) as BackPlate
    plate.size = new vec2(W, H)

    const content = UI.obj(this.sceneObject, "Content", new vec3(0, 0, UI.CONTENT_Z))
    const col = UI.flexColumn(content, W, H, {
      gap: GAP, padX: PAD, padY: PAD, justify: FlexJustify.Start, align: FlexAlign.Stretch,
    })
    UI.addColumnText(col, this.title, "Subheadline", this.textDistanceCm, HEADER_H)

    const innerW = W - PAD * 2
    const gridH = H - PAD * 2 - HEADER_H - GAP
    const tileW = (innerW - GAP * (COLS - 1)) / COLS
    const tileH = (gridH - GAP * (ROWS - 1)) / ROWS

    UI.flexChild(col, {w: innerW, h: gridH}, (gridParent) => {
      const grid = gridParent.createComponent(GridLayout.getTypeName()) as GridLayout
      grid.onInitialized.add(() => {
        grid.width = innerW
        grid.height = gridH
        grid.templateColumns = "1fr 1fr"
        grid.templateRows = "1fr 1fr 1fr"
        grid.columnGap = GAP
        grid.rowGap = GAP
        const items: GridItem[] = []
        for (let i = 0; i < DISHES.length; i++) {
          const tile = UI.obj(gridParent, `Dish-${DISHES[i].id}`)
          const item = tile.createComponent(GridItem.getTypeName()) as GridItem
          item.overrideWidth = tileW
          item.overrideHeight = tileH
          items.push(item)
          this.tiles[i] = this.buildTile(tile, i, tileW, tileH)
        }
        grid.addItems(items)
        for (let i = 0; i < this.pendingStates.length; i++) this.applyState(i, this.pendingStates[i])
      })
    })
  }

  // ── Public API (Main pushes state in) ──────────────────────────────────
  setDishState(index: number, state: DishState): void {
    if (index < 0 || index >= DISHES.length) return
    this.pendingStates[index] = state
    this.applyState(index, state)
  }

  clearHighlights(): void {
    for (let i = 0; i < DISHES.length; i++) this.setDishState(i, "none")
  }

  /** The tile SceneObject for a dish — Main parks the detail card next to it. */
  getDishAnchor(index: number): SceneObject | null {
    return this.tiles[index]?.root ?? null
  }

  /** Which column the dish sits in: -1 = left, +1 = right (for detail-card side). */
  getDishSide(index: number): number {
    return index % COLS === 0 ? -1 : 1
  }

  // ── Private ────────────────────────────────────────────────────────────
  private buildTile(tile: SceneObject, index: number, w: number, h: number): Tile {
    const dish = DISHES[index]
    const btn = tile.createComponent(Button.getTypeName()) as Button
    btn.size = new vec3(w, h, 1)
    btn.onTriggerUp.add(() => this._onDishPinched.invoke(index))

    const iconSize = Math.min(h - 1.2, 3.6)
    const row = UI.flexRow(tile, w, h, {gap: 0.7, padX: 0.8, justify: FlexJustify.Start, align: FlexAlign.Center})
    UI.liftInZ(row, UI.BUTTON_LABEL_Z)
    UI.addImage(row, ICONS[dish.icon], iconSize, iconSize)
    UI.addRowText(row, dish.name, "Body", this.textDistanceCm, w - iconSize - 0.8 * 2 - 0.7,
      HorizontalAlignment.Left)

    // Highlight overlay — created LAST so the Canvas hierarchy sort paints it on top.
    const overlay = UI.obj(tile, "Highlight", new vec3(0, 0, UI.BUTTON_LABEL_Z + 0.06))
    const img = overlay.createComponent("Component.Image") as Image
    const mat = imageMaterial.clone()
    mat.mainPass.baseTex = HIGHLIGHT_TEX
    mat.mainPass.baseColor = new vec4(1, 1, 1, 0)
    mat.mainPass.depthTest = true
    mat.mainPass.depthWrite = false
    img.clearMaterials()
    img.addMaterial(mat)
    overlay.getTransform().setLocalScale(new vec3(w / SQUARE_GLYPH_COVERAGE, h / SQUARE_GLYPH_COVERAGE, 1))
    overlay.enabled = false
    return {root: tile, overlay, overlayMat: mat}
  }

  private applyState(index: number, state: DishState): void {
    const tile = this.tiles[index]
    if (!tile) return
    if (state === "none") {
      tile.overlay.enabled = false
      return
    }
    tile.overlayMat.mainPass.baseColor = state === "safe" ? this.safeColor : this.flagColor
    tile.overlay.enabled = true
  }
}

// AllergyLensMenuCardUI — the real-size menu card standing on the table: the selected
// restaurant's name as title and up to six dish tiles (icon + name) in two columns,
// each a pinchable UIKit Button with a transparent green / red / amber highlight painted
// directly on it. Owns: tile construction, re-rendering tiles for a restaurant,
// highlight tinting, dish-pinch events. Expects no scene @inputs (Main wires it as a
// typed handle). Must not decide which dishes are safe — Main pushes verdicts in.

import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {GridLayout} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Grid/GridLayout"
import {GridItem} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Grid/GridItem"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {DishDef, RestaurantDef} from "./AllergyLensMenuData"
import {RestaurantBadgeLevel} from "./AllergyLensChecker"
import * as UI from "./AllergyLensSharedUI"

// Every dish icon the data may name. requireAsset needs literals, so unknown icon names
// fall back to FALLBACK_ICON (and print once).
const ICONS: Record<string, Texture> = {
  ramen_dining: requireAsset("../Icons/ramen_dining.png") as Texture,
  lunch_dining: requireAsset("../Icons/lunch_dining.png") as Texture,
  set_meal: requireAsset("../Icons/set_meal.png") as Texture,
  local_pizza: requireAsset("../Icons/local_pizza.png") as Texture,
  rice_bowl: requireAsset("../Icons/rice_bowl.png") as Texture,
  cake: requireAsset("../Icons/cake.png") as Texture,
  restaurant: requireAsset("../Icons/restaurant.png") as Texture,
}
const FALLBACK_ICON = "restaurant"
// Filled rounded square — stretched and tinted, it becomes the translucent highlight.
const HIGHLIGHT_TEX = requireAsset("../Icons/square.png") as Texture
const SQUARE_GLYPH_COVERAGE = 0.75 // the glyph fills 18/24 of its canvas
const imageMaterial = requireAsset("../Materials/ImageMaterial.mat") as Material

export type DishState = "none" | "safe" | "contains" | "unverified"

const PAD = 1.2
const HEADER_H = 2.2
const BADGE_H = 1.3
const GAP = 0.6
const TYPICAL_PREFIX = "~ " // marks dishes whose ingredients come from a typical recipe
const COLS = 2
const ROWS = 3
const MAX_DISHES = COLS * ROWS

interface Tile {
  root: SceneObject
  iconMat: Material
  nameText: Text
  overlay: SceneObject
  overlayMat: Material
}

@component
export class AllergyLensMenuCardUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensMenuCardUI – restaurant menu card with highlightable dishes</span>')
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

  @input("vec4", "{0.55, 0.95, 0.6, 0.35}")
  @hint("Transparent light-green highlight: ingredients known, nothing from your profile.")
  @widget(new ColorWidget())
  safeColor: vec4

  @input("vec4", "{0.98, 0.45, 0.45, 0.42}")
  @hint("Transparent light-red highlight: contains something from your profile.")
  @widget(new ColorWidget())
  flagColor: vec4

  @input("vec4", "{1.0, 0.8, 0.3, 0.38}")
  @hint("Transparent amber highlight: ingredients not published — ask the restaurant.")
  @widget(new ColorWidget())
  unverifiedColor: vec4

  @input
  @hint("Viewing distance (cm) used to scale text; the card sits ~65 cm from the user.")
  @widget(new SliderWidget(40, 110, 5))
  textDistanceCm: number = 70
  @ui.group_end

  private tiles: Tile[] = []
  private titleText: Text | null = null
  private badgeText: Text | null = null
  private badgeDotMat: Material | null = null
  private _badgeLevel: RestaurantBadgeLevel | "" = ""
  private _badgeText = ""
  private pendingStates: DishState[] = []
  private pendingRestaurant: RestaurantDef | null = null
  private dishes: DishDef[] = []
  private warnedIcons = new Set<string>()
  private _onDishPinched = new Event<number>()

  /** Fires with the tile index (0-5) when the user pinches a dish tile. */
  get onDishPinched(): PublicApi<number> {
    return this._onDishPinched.publicApi()
  }

  get dishCount(): number {
    return this.dishes.length
  }

  /** Current restaurant badge level ("good" | "caution" | "avoid"), "" before the first setBadge. */
  get badgeLevel(): string {
    return this._badgeLevel
  }

  get badgeTextValue(): string {
    return this._badgeText
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
    this.titleText = UI.addColumnText(col, "Menu", "Subheadline", this.textDistanceCm, HEADER_H)

    const innerW = W - PAD * 2
    // Badge row under the title: tinted dot + "4 of 6 safe · ★4.4 · …" for the current profile.
    const badgeRow = UI.flexRow(col, innerW, BADGE_H, {gap: 0.5, justify: FlexJustify.Center, align: FlexAlign.Center})
    const dot = UI.addImage(badgeRow, HIGHLIGHT_TEX, 0.9, 0.9, new vec4(1, 1, 1, 0))
    this.badgeDotMat = dot.mainMaterial
    this.badgeText = UI.addRowText(badgeRow, "", "Caption", this.textDistanceCm, innerW - 2.5, HorizontalAlignment.Left, UI.WHITE_SOFT)

    const gridH = H - PAD * 2 - HEADER_H - BADGE_H - GAP * 2
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
        for (let i = 0; i < MAX_DISHES; i++) {
          const tile = UI.obj(gridParent, `Dish-${i}`)
          const item = tile.createComponent(GridItem.getTypeName()) as GridItem
          item.overrideWidth = tileW
          item.overrideHeight = tileH
          items.push(item)
          this.tiles[i] = this.buildTile(tile, i, tileW, tileH)
        }
        grid.addItems(items)
        if (this.pendingRestaurant) this.applyRestaurant(this.pendingRestaurant)
        for (let i = 0; i < this.pendingStates.length; i++) this.applyState(i, this.pendingStates[i])
      })
    })
  }

  // ── Public API (Main pushes state in) ──────────────────────────────────
  /** Show this restaurant: title + up to six dish tiles. Clears highlights. */
  setRestaurant(restaurant: RestaurantDef): void {
    this.pendingRestaurant = restaurant
    this.pendingStates = restaurant.dishes.map(() => "none" as DishState)
    if (this.tiles.length === MAX_DISHES) this.applyRestaurant(restaurant)
  }

  /** Restaurant-level badge for the current profile (Main recomputes it on every change). */
  setBadge(level: RestaurantBadgeLevel, text: string): void {
    this._badgeLevel = level
    this._badgeText = text
    if (!this.badgeText || !this.badgeDotMat) return
    const tint = level === "good" ? this.safeColor : level === "caution" ? this.unverifiedColor : this.flagColor
    this.badgeText.text = text
    this.badgeText.textFill.color = new vec4(tint.x, tint.y, tint.z, 1)
    this.badgeDotMat.mainPass.baseColor = new vec4(tint.x, tint.y, tint.z, 1)
  }

  setDishState(index: number, state: DishState): void {
    if (index < 0 || index >= MAX_DISHES) return
    this.pendingStates[index] = state
    this.applyState(index, state)
  }

  clearHighlights(): void {
    for (let i = 0; i < MAX_DISHES; i++) this.setDishState(i, "none")
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
  private applyRestaurant(restaurant: RestaurantDef): void {
    if (this.titleText) this.titleText.text = restaurant.name
    this.dishes = restaurant.dishes.slice(0, MAX_DISHES)
    if (restaurant.dishes.length > MAX_DISHES) {
      print(`AllergyLensMenuCardUI: ${restaurant.name} has ${restaurant.dishes.length} dishes; showing the first ${MAX_DISHES}.`)
    }
    for (let i = 0; i < MAX_DISHES; i++) {
      const tile = this.tiles[i]
      const dish = this.dishes[i]
      if (!dish) {
        tile.root.enabled = false
        tile.root.name = `Dish-unused-${i}`
        continue
      }
      tile.root.enabled = true
      tile.root.name = `Dish-${dish.id}`
      tile.nameText.text = (dish.ingredientsSource === "typical" ? TYPICAL_PREFIX : "") + dish.name
      let icon = ICONS[dish.icon]
      if (!icon) {
        if (!this.warnedIcons.has(dish.icon)) {
          this.warnedIcons.add(dish.icon)
          print(`AllergyLensMenuCardUI: icon "${dish.icon}" not bundled; using ${FALLBACK_ICON}.`)
        }
        icon = ICONS[FALLBACK_ICON]
      }
      tile.iconMat.mainPass.baseTex = icon
      this.applyState(i, "none")
    }
  }

  private buildTile(tile: SceneObject, index: number, w: number, h: number): Tile {
    const btn = tile.createComponent(Button.getTypeName()) as Button
    btn.size = new vec3(w, h, 1)
    btn.onTriggerUp.add(() => this._onDishPinched.invoke(index))

    const iconSize = Math.min(h - 1.2, 3.6)
    const row = UI.flexRow(tile, w, h, {gap: 0.7, padX: 0.8, justify: FlexJustify.Start, align: FlexAlign.Center})
    UI.liftInZ(row, UI.BUTTON_LABEL_Z)
    const img = UI.addImage(row, ICONS[FALLBACK_ICON], iconSize, iconSize)
    const nameText = UI.addRowText(row, "", "Body", this.textDistanceCm, w - iconSize - 0.8 * 2 - 0.7,
      HorizontalAlignment.Left)

    // Highlight overlay — created LAST so the Canvas hierarchy sort paints it on top.
    const overlay = UI.obj(tile, "Highlight", new vec3(0, 0, UI.BUTTON_LABEL_Z + 0.06))
    const ovImg = overlay.createComponent("Component.Image") as Image
    const mat = imageMaterial.clone()
    mat.mainPass.baseTex = HIGHLIGHT_TEX
    mat.mainPass.baseColor = new vec4(1, 1, 1, 0)
    mat.mainPass.depthTest = true
    mat.mainPass.depthWrite = false
    ovImg.clearMaterials()
    ovImg.addMaterial(mat)
    overlay.getTransform().setLocalScale(new vec3(w / SQUARE_GLYPH_COVERAGE, h / SQUARE_GLYPH_COVERAGE, 1))
    overlay.enabled = false
    return {root: tile, iconMat: img.mainMaterial, nameText, overlay, overlayMat: mat}
  }

  private applyState(index: number, state: DishState): void {
    const tile = this.tiles[index]
    if (!tile) return
    if (state === "none") {
      tile.overlay.enabled = false
      return
    }
    tile.overlayMat.mainPass.baseColor =
      state === "safe" ? this.safeColor : state === "contains" ? this.flagColor : this.unverifiedColor
    tile.overlay.enabled = true
  }
}

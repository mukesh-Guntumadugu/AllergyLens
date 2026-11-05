// AllergyLensDishDetailUI — the small card that opens next to a red dish: dish name,
// the problem ingredient, and whether it can be left out. Owns: its rows and the
// close button. Expects no scene @inputs; Main positions this SceneObject next to
// the pinched dish and calls showDetail/hideDetail. Starts hidden (authored
// disabled); content is built on first enable, so data passed before that is kept
// and applied in onAwake. Must not decide what is flagged.

import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {ElementContent} from "SpectaclesUIKit.lspkg/Scripts/Components/Content/ElementContent"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import * as UI from "./AllergyLensSharedUI"

const ICON_CLOSE = requireAsset("../Icons/close.png") as Texture
const ICON_WARNING = requireAsset("../Icons/warning.png") as Texture

const PAD = 0.8
const GAP = 0.4
const TITLE_H = 1.3
const HEADLINE_H = 1.3
const BODY_H = 3.4
const CLOSE_H = 2.4

export interface DishDetailData {
  dishName: string
  headline: string
  body: string
}

@component
export class AllergyLensDishDetailUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensDishDetailUI – why a dish is red</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Card width in cm (brief default 12).")
  @widget(new SliderWidget(8, 24, 0.5))
  cardWidthCm: number = 12

  @input("vec4", "{1.0, 0.72, 0.72, 1.0}")
  @hint("Color of the 'Contains ...' headline. Keep it light — the display is additive.")
  @widget(new ColorWidget())
  headlineColor: vec4

  @input
  @hint("Viewing distance (cm) used to scale text.")
  @widget(new SliderWidget(40, 110, 5))
  textDistanceCm: number = 70
  @ui.group_end

  private titleText: Text | null = null
  private headlineText: Text | null = null
  private bodyText: Text | null = null
  private pending: DishDetailData | null = null
  private _onClose = new Event<void>()
  private _heightCm = 8

  /** Height of the card plate in cm (known after onAwake). */
  get cardHeightCm(): number {
    return this._heightCm
  }

  /** User pinched the close (X) button. */
  get onClose(): PublicApi<void> {
    return this._onClose.publicApi()
  }

  get isVisible(): boolean {
    return this.sceneObject.enabled
  }

  onAwake(): void {
    const W = this.cardWidthCm
    const H = PAD * 2 + TITLE_H + HEADLINE_H + BODY_H + CLOSE_H + GAP * 3
    this.sceneObject.createComponent("Component.Canvas")
    const plate = this.sceneObject.createComponent(BackPlate.getTypeName()) as BackPlate
    plate.size = new vec2(W, H)
    this._heightCm = H

    const content = UI.obj(this.sceneObject, "Content", new vec3(0, 0, UI.CONTENT_Z))
    const col = UI.flexColumn(content, W, H, {gap: GAP, padX: PAD, padY: PAD, justify: FlexJustify.Start, align: FlexAlign.Stretch})
    const d = this.textDistanceCm

    this.titleText = UI.addColumnText(col, "", "Caption", d, TITLE_H, HorizontalAlignment.Left, UI.WHITE_SOFT)
    // Headline row: warning icon + "Contains peanuts."
    const innerW = W - PAD * 2
    const iconSize = 1.2
    const headRow = UI.flexRow(col, innerW, HEADLINE_H, {gap: 0.4, justify: FlexJustify.Start, align: FlexAlign.Center})
    UI.addImage(headRow, ICON_WARNING, iconSize, iconSize, this.headlineColor)
    this.headlineText = UI.addRowText(headRow, "", "Callout", d, innerW - iconSize - 0.4, HorizontalAlignment.Left, this.headlineColor)
    this.bodyText = UI.addColumnText(col, "", "Body", d, BODY_H, HorizontalAlignment.Left)
    this.bodyText.horizontalOverflow = HorizontalOverflow.Wrap
    this.bodyText.layoutRect = Rect.create(-innerW / 2, innerW / 2, -BODY_H / 2, BODY_H / 2)

    // Close button, centered in its own row.
    UI.flexChild(col, {w: CLOSE_H, h: CLOSE_H}, (so) => {
      so.name = "CloseButton"
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(CLOSE_H, CLOSE_H, 1)
      btn.onTriggerUp.add(() => this._onClose.invoke())
      const ec = so.createComponent(ElementContent.getTypeName()) as ElementContent
      ec.leadingIcon = ICON_CLOSE
      ec.leadingIconSize = 1.3
    })

    if (this.pending) this.apply(this.pending)
  }

  // ── Public API ─────────────────────────────────────────────────────────
  showDetail(data: DishDetailData): void {
    this.pending = data
    this.apply(data)
    this.sceneObject.enabled = true
  }

  hideDetail(): void {
    this.sceneObject.enabled = false
  }

  private apply(data: DishDetailData): void {
    if (!this.titleText || !this.headlineText || !this.bodyText) return
    this.titleText.text = data.dishName
    this.headlineText.text = data.headline
    this.bodyText.text = data.body
  }
}

// AllergyLensProfileUI — the profile panel shown at Lens start: one big pinch toggle
// per allergen in the knowledge base (Assets/Data/AllergyData.ts), grouped Allergies /
// Religious / Diet / Preferences in 3-column UIKit grids, plus a Done button. Owns: the
// toggle buttons and their on/off visuals. Expects no scene @inputs. Must not hold the
// profile — it reports each flip to Main (the single owner of profile state).
// Toggle SceneObjects are named "Toggle-<allergen id>" and the Done button "DoneButton"
// so LEAF scenarios can find them by name.

import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {GridLayout} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Grid/GridLayout"
import {GridItem} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Grid/GridItem"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {AllergenDef, GROUP_LABELS, GROUP_ORDER, allergensInGroup} from "./AllergyLensMenuData"
import * as UI from "./AllergyLensSharedUI"

const ICON_DONE = requireAsset("../Icons/check.png") as Texture

export interface ProfileToggleEvent {
  id: string
  on: boolean
}

const PAD = 1.2
const GAP = 0.4
const HEADER_H = 2.2
const GROUP_LABEL_H = 1.2
const TOGGLE_H = 2.8
const DONE_W = 10
const DONE_H = 2.8
const COLS = 3

@component
export class AllergyLensProfileUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensProfileUI – allergen toggles from the data module + Done</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Header text at the top of the panel.")
  title: string = "Your profile"

  @input
  @hint("Label on the Done button.")
  doneLabel: string = "Done"

  @input
  @hint("Panel width in cm (brief default 30). Height follows the toggle count.")
  @widget(new SliderWidget(20, 50, 1))
  panelWidthCm: number = 30

  @input
  @hint("Viewing distance (cm) used to scale text; the panel sits ~80 cm from the user.")
  @widget(new SliderWidget(40, 110, 5))
  textDistanceCm: number = 80
  @ui.group_end

  private buttons = new Map<string, Button>()
  private pendingStates = new Map<string, boolean>()
  private _onToggle = new Event<ProfileToggleEvent>()
  private _onDone = new Event<void>()

  /** A toggle flipped: {id, on}. */
  get onToggle(): PublicApi<ProfileToggleEvent> {
    return this._onToggle.publicApi()
  }

  /** User pinched Done. */
  get onDone(): PublicApi<void> {
    return this._onDone.publicApi()
  }

  onAwake(): void {
    const W = this.panelWidthCm
    const innerW = W - PAD * 2
    const d = this.textDistanceCm
    const btnW = (innerW - GAP * (COLS - 1)) / COLS

    // Height from the data: header + per group (label + grid) + Done + gaps.
    const groups = GROUP_ORDER.map((g) => ({group: g, items: allergensInGroup(g)})).filter((g) => g.items.length > 0)
    let H = PAD * 2 + HEADER_H + DONE_H
    let itemCount = 2
    for (const g of groups) {
      const rows = Math.ceil(g.items.length / COLS)
      H += GROUP_LABEL_H + rows * TOGGLE_H + (rows - 1) * GAP
      itemCount += 2
    }
    H += GAP * (itemCount - 1)

    this.sceneObject.createComponent("Component.Canvas")
    const plate = this.sceneObject.createComponent(BackPlate.getTypeName()) as BackPlate
    plate.size = new vec2(W, H)

    const content = UI.obj(this.sceneObject, "Content", new vec3(0, 0, UI.CONTENT_Z))
    const col = UI.flexColumn(content, W, H, {gap: GAP, padX: PAD, padY: PAD, justify: FlexJustify.Start, align: FlexAlign.Stretch})
    UI.addColumnText(col, this.title, "Subheadline", d, HEADER_H)

    for (const g of groups) {
      UI.addColumnText(col, GROUP_LABELS[g.group], "Caption", d, GROUP_LABEL_H, HorizontalAlignment.Left, UI.WHITE_SOFT)
      const rows = Math.ceil(g.items.length / COLS)
      const gridH = rows * TOGGLE_H + (rows - 1) * GAP
      UI.flexChild(col, {w: innerW, h: gridH}, (gridParent) => {
        const grid = gridParent.createComponent(GridLayout.getTypeName()) as GridLayout
        grid.onInitialized.add(() => {
          grid.width = innerW
          grid.height = gridH
          grid.templateColumns = "1fr 1fr 1fr"
          grid.templateRows = `repeat(${rows}, 1fr)`
          grid.columnGap = GAP
          grid.rowGap = GAP
          const gridItems: GridItem[] = []
          for (const a of g.items) {
            const tile = UI.obj(gridParent, `Toggle-${a.id}`)
            const gi = tile.createComponent(GridItem.getTypeName()) as GridItem
            gi.overrideWidth = btnW
            gi.overrideHeight = TOGGLE_H
            gridItems.push(gi)
            this.buildToggle(tile, a, btnW, TOGGLE_H)
          }
          grid.addItems(gridItems)
        })
      })
    }

    // Done — centered, with a check icon.
    const doneRow = UI.flexRow(col, innerW, DONE_H, {justify: FlexJustify.Center, align: FlexAlign.Center})
    UI.flexChild(doneRow, {w: DONE_W, h: DONE_H}, (so) => {
      so.name = "DoneButton"
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(DONE_W, DONE_H, 1)
      btn.onTriggerUp.add(() => this._onDone.invoke())
      const inner = UI.flexRow(so, DONE_W, DONE_H, {gap: 0.6, justify: FlexJustify.Center, align: FlexAlign.Center})
      UI.liftInZ(inner, UI.BUTTON_LABEL_Z)
      UI.addImage(inner, ICON_DONE, 1.8, 1.8)
      UI.addRowText(inner, this.doneLabel, "Callout", d,
        this.doneLabel.length * UI.charWidthCm("Callout", d) + 1, HorizontalAlignment.Left)
    })
  }

  // ── Public API ─────────────────────────────────────────────────────────
  setToggle(id: string, on: boolean): void {
    this.pendingStates.set(id, on)
    const btn = this.buttons.get(id)
    if (btn) btn.isOn = on
  }

  isOn(id: string): boolean {
    return this.buttons.get(id)?.isOn ?? false
  }

  // ── Private ────────────────────────────────────────────────────────────
  private buildToggle(so: SceneObject, item: AllergenDef, w: number, h: number): void {
    const btn = so.createComponent(Button.getTypeName()) as Button
    btn.size = new vec3(w, h, 1)
    btn.setIsToggleable(true)
    btn.isOn = false
    // onValueChange carries the settled state (1 = on). onFinished's boolean is the
    // toggle-group "explicit" flag, not the state — don't use it for on/off.
    btn.onValueChange.add((v: number) => this._onToggle.invoke({id: item.id, on: v === 1}))
    UI.addButtonLabel(so, item.label, w - 0.6, this.textDistanceCm, "Button")
    this.buttons.set(item.id, btn)
    const pending = this.pendingStates.get(item.id)
    if (pending !== undefined) btn.isOn = pending
  }
}

// AllergyLensProfileUI — the profile panel shown at Lens start: big pinch toggles in
// three groups (Allergies / Religious / Fitness) plus a Done button. Owns: the toggle
// buttons and their on/off visuals. Expects no scene @inputs. Must not hold the
// profile — it reports each flip to Main (the single owner of profile state).
// Toggle SceneObjects are named "Toggle-<id>" and the Done button "DoneButton" so
// LEAF scenarios can find them by name.

import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {PROFILE_ITEMS, ProfileItem} from "./AllergyLensMenuData"
import * as UI from "./AllergyLensSharedUI"

const ICON_DONE = requireAsset("../Icons/check.png") as Texture

export interface ProfileToggleEvent {
  id: string
  on: boolean
}

const PAD = 1.5
const GAP = 0.5
const HEADER_H = 2.6
const GROUP_LABEL_H = 1.4
const TOGGLE_H = 3.4
const DONE_W = 10
const GROUPS: Array<{name: ProfileItem["group"]; perRow: number}> = [
  {name: "Allergies", perRow: 3},
  {name: "Religious", perRow: 2},
  {name: "Fitness", perRow: 2},
]

@component
export class AllergyLensProfileUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensProfileUI – allergy / religious / fitness toggles + Done</span>')
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
  @hint("Panel width in cm (brief default 30). Height follows the content.")
  @widget(new SliderWidget(20, 50, 1))
  panelWidthCm: number = 30

  @input
  @hint("Viewing distance (cm) used to scale text; the panel sits ~80 cm from the user.")
  @widget(new SliderWidget(40, 110, 5))
  textDistanceCm: number = 80
  @ui.group_end

  private buttons = new Map<string, Button>()
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

    // Height from the row plan so the BackPlate matches the column exactly.
    let rows = 0
    for (const g of GROUPS) rows += Math.ceil(PROFILE_ITEMS.filter((p) => p.group === g.name).length / g.perRow)
    const itemCount = 1 + GROUPS.length + rows + 1
    const H = PAD * 2 + HEADER_H + GROUPS.length * GROUP_LABEL_H + rows * TOGGLE_H + TOGGLE_H + GAP * (itemCount - 1)

    this.sceneObject.createComponent("Component.Canvas")
    const plate = this.sceneObject.createComponent(BackPlate.getTypeName()) as BackPlate
    plate.size = new vec2(W, H)

    const content = UI.obj(this.sceneObject, "Content", new vec3(0, 0, UI.CONTENT_Z))
    const col = UI.flexColumn(content, W, H, {gap: GAP, padX: PAD, padY: PAD, justify: FlexJustify.Start, align: FlexAlign.Stretch})
    UI.addColumnText(col, this.title, "Subheadline", d, HEADER_H)

    for (const g of GROUPS) {
      UI.addColumnText(col, g.name, "Caption", d, GROUP_LABEL_H, HorizontalAlignment.Left, UI.WHITE_SOFT)
      const items = PROFILE_ITEMS.filter((p) => p.group === g.name)
      const btnW = (innerW - GAP * (g.perRow - 1)) / g.perRow
      for (let r = 0; r < items.length; r += g.perRow) {
        const row = UI.flexRow(col, innerW, TOGGLE_H, {gap: GAP, justify: FlexJustify.Start, align: FlexAlign.Center})
        for (const item of items.slice(r, r + g.perRow)) this.addToggle(row, item, btnW, TOGGLE_H)
      }
    }

    // Done — centered, with a check icon.
    const doneRow = UI.flexRow(col, innerW, TOGGLE_H, {justify: FlexJustify.Center, align: FlexAlign.Center})
    UI.flexChild(doneRow, {w: DONE_W, h: TOGGLE_H}, (so) => {
      so.name = "DoneButton"
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(DONE_W, TOGGLE_H, 1)
      btn.onTriggerUp.add(() => this._onDone.invoke())
      const inner = UI.flexRow(so, DONE_W, TOGGLE_H, {gap: 0.6, justify: FlexJustify.Center, align: FlexAlign.Center})
      UI.liftInZ(inner, UI.BUTTON_LABEL_Z)
      UI.addImage(inner, ICON_DONE, 2.0, 2.0)
      UI.addRowText(inner, this.doneLabel, "Callout", d,
        this.doneLabel.length * UI.charWidthCm("Callout", d) + 1, HorizontalAlignment.Left)
    })
  }

  // ── Public API ─────────────────────────────────────────────────────────
  setToggle(id: string, on: boolean): void {
    const btn = this.buttons.get(id)
    if (btn) btn.isOn = on
  }

  isOn(id: string): boolean {
    return this.buttons.get(id)?.isOn ?? false
  }

  // ── Private ────────────────────────────────────────────────────────────
  private addToggle(row: SceneObject, item: ProfileItem, w: number, h: number): void {
    UI.flexChild(row, {w, h}, (so) => {
      so.name = `Toggle-${item.id}`
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(w, h, 1)
      btn.setIsToggleable(true)
      btn.isOn = false
      // onValueChange carries the settled state (1 = on). onFinished's boolean is the
      // toggle-group "explicit" flag, not the state — don't use it for on/off.
      btn.onValueChange.add((v: number) => this._onToggle.invoke({id: item.id, on: v === 1}))
      UI.addButtonLabel(so, item.label, w - 0.6, this.textDistanceCm, "Button")
      this.buttons.set(item.id, btn)
    })
  }
}

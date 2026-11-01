// AllergyLensScanBarUI — the big "Scan menu" button plus a small Profile button,
// lying on the table in front of the menu card. Owns: those two buttons and their
// events. Expects no scene @inputs. Must not run the check itself — it only reports
// the pinch to Main.

import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {ElementContent} from "SpectaclesUIKit.lspkg/Scripts/Components/Content/ElementContent"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import * as UI from "./AllergyLensSharedUI"

const ICON_SCAN = requireAsset("../Icons/document_scanner.png") as Texture
const ICON_PROFILE = requireAsset("../Icons/person.png") as Texture

@component
export class AllergyLensScanBarUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensScanBarUI – Scan menu + Profile buttons</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Label on the big scan button.")
  scanLabel: string = "Scan menu"

  @input
  @hint("Width of the scan button in cm. Keep it big — it is the main pinch target.")
  @widget(new SliderWidget(10, 30, 0.5))
  scanWidthCm: number = 16

  @input
  @hint("Height of both buttons in cm (also the Profile button's diameter).")
  @widget(new SliderWidget(3, 8, 0.5))
  barHeightCm: number = 4.5

  @input
  @hint("Viewing distance (cm) used to scale the label text.")
  @widget(new SliderWidget(40, 110, 5))
  textDistanceCm: number = 70
  @ui.group_end

  private _onScan = new Event<void>()
  private _onProfile = new Event<void>()

  /** User pinched "Scan menu". */
  get onScan(): PublicApi<void> {
    return this._onScan.publicApi()
  }

  /** User pinched the small Profile button. */
  get onProfile(): PublicApi<void> {
    return this._onProfile.publicApi()
  }

  onAwake(): void {
    this.sceneObject.createComponent("Component.Canvas")
    const H = this.barHeightCm
    const gap = 1.2
    const totalW = this.scanWidthCm + gap + H
    const row = UI.flexRow(this.sceneObject, totalW, H, {gap, justify: FlexJustify.Center, align: FlexAlign.Center})

    // Big scan button: icon + label in a nested row on the button face.
    UI.flexChild(row, {w: this.scanWidthCm, h: H}, (so) => {
      so.name = "ScanButton"
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(this.scanWidthCm, H, 1)
      btn.onTriggerUp.add(() => this._onScan.invoke())
      const iconSize = Math.min(H - 1.4, 3.0)
      const inner = UI.flexRow(so, this.scanWidthCm, H, {gap: 0.7, justify: FlexJustify.Center, align: FlexAlign.Center})
      UI.liftInZ(inner, UI.BUTTON_LABEL_Z)
      UI.addImage(inner, ICON_SCAN, iconSize, iconSize)
      const labelW = Math.max(4, this.scanLabel.length * UI.charWidthCm("Callout", this.textDistanceCm) + 1)
      UI.addRowText(inner, this.scanLabel, "Callout", this.textDistanceCm, labelW, HorizontalAlignment.Left)
    })

    // Small round-ish Profile button: icon only (single-child ElementContent is safe here).
    UI.flexChild(row, {w: H, h: H}, (so) => {
      so.name = "ProfileButton"
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(H, H, 1)
      btn.onTriggerUp.add(() => this._onProfile.invoke())
      const ec = so.createComponent(ElementContent.getTypeName()) as ElementContent
      ec.leadingIcon = ICON_PROFILE
      ec.leadingIconSize = Math.min(H - 1.4, 2.6)
    })
  }
}

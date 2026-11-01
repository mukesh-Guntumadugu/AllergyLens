// AllergyLensScanBarUI — the big "Scan menu" button plus small Restaurant and Profile
// buttons, lying on the table in front of the menu card. Owns: those buttons and their
// events. Expects no scene @inputs. Must not run the check or pick the restaurant itself
// — it only reports the pinch to Main.

import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {ElementContent} from "SpectaclesUIKit.lspkg/Scripts/Components/Content/ElementContent"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import * as UI from "./AllergyLensSharedUI"
import {RestaurantBadgeLevel} from "./AllergyLensChecker"

const ICON_SCAN = requireAsset("../Icons/document_scanner.png") as Texture
const ICON_RESTAURANT = requireAsset("../Icons/restaurant.png") as Texture
const ICON_PROFILE = requireAsset("../Icons/person.png") as Texture
const DOT_TEX = requireAsset("../Icons/square.png") as Texture

@component
export class AllergyLensScanBarUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensScanBarUI – Scan menu + Restaurant + Profile buttons</span>')
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
  @hint("Height of all buttons in cm (also the small buttons' width).")
  @widget(new SliderWidget(3, 8, 0.5))
  barHeightCm: number = 4.5

  @input
  @hint("Viewing distance (cm) used to scale the label text.")
  @widget(new SliderWidget(40, 110, 5))
  textDistanceCm: number = 70

  @input("vec4", "{0.55, 0.95, 0.6, 1.0}")
  @hint("Badge dot on the Restaurant button when the restaurant looks good for the profile.")
  @widget(new ColorWidget())
  badgeGoodColor: vec4

  @input("vec4", "{1.0, 0.8, 0.3, 1.0}")
  @hint("Badge dot when the restaurant needs caution for the profile.")
  @widget(new ColorWidget())
  badgeCautionColor: vec4

  @input("vec4", "{0.98, 0.45, 0.45, 1.0}")
  @hint("Badge dot when the restaurant should be avoided for the profile.")
  @widget(new ColorWidget())
  badgeAvoidColor: vec4
  @ui.group_end

  private badgeDot: SceneObject | null = null
  private badgeDotMat: Material | null = null

  private _onScan = new Event<void>()
  private _onRestaurant = new Event<void>()
  private _onProfile = new Event<void>()

  /** User pinched "Scan menu". */
  get onScan(): PublicApi<void> {
    return this._onScan.publicApi()
  }

  /** User pinched the Restaurant button (Main cycles to the next restaurant). */
  get onRestaurant(): PublicApi<void> {
    return this._onRestaurant.publicApi()
  }

  /** User pinched the small Profile button. */
  get onProfile(): PublicApi<void> {
    return this._onProfile.publicApi()
  }

  onAwake(): void {
    this.sceneObject.createComponent("Component.Canvas")
    const H = this.barHeightCm
    const gap = 1.2
    const totalW = this.scanWidthCm + gap * 2 + H * 2
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

    const restaurantBtn = this.iconButton(row, "RestaurantButton", ICON_RESTAURANT, H, () => this._onRestaurant.invoke())
    this.iconButton(row, "ProfileButton", ICON_PROFILE, H, () => this._onProfile.invoke())

    // Badge dot in the Restaurant button's top-right corner (hidden until Main sets a badge).
    const dotSize = 1.2
    this.badgeDot = UI.obj(restaurantBtn, "RestaurantBadge", new vec3(H / 2 - dotSize * 0.7, H / 2 - dotSize * 0.7, UI.BUTTON_LABEL_Z + 0.1))
    const dot = UI.addImage(this.badgeDot, DOT_TEX, dotSize, dotSize, new vec4(1, 1, 1, 1), false)
    this.badgeDotMat = dot.mainMaterial
    this.badgeDot.enabled = false
  }

  /** Tint the Restaurant button's badge dot for the current profile. */
  setBadge(level: RestaurantBadgeLevel): void {
    if (!this.badgeDot || !this.badgeDotMat) return
    this.badgeDotMat.mainPass.baseColor =
      level === "good" ? this.badgeGoodColor : level === "caution" ? this.badgeCautionColor : this.badgeAvoidColor
    this.badgeDot.enabled = true
  }

  /** Square icon-only button (single-child ElementContent is safe here). */
  private iconButton(row: SceneObject, name: string, icon: Texture, size: number, onPinch: () => void): SceneObject {
    return UI.flexChild(row, {w: size, h: size}, (so) => {
      so.name = name
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(size, size, 1)
      btn.onTriggerUp.add(onPinch)
      const ec = so.createComponent(ElementContent.getTypeName()) as ElementContent
      ec.leadingIcon = icon
      ec.leadingIconSize = Math.min(size - 1.4, 2.6)
    })
  }
}

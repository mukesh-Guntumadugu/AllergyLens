// AllergyLensProfileButtonUI — one small world-locked pinch button, near the user at
// the bottom of the view, that reopens the profile panel. Owns: the button. Expects no
// scene @inputs. Must not decide anything — it only reports the pinch to Main.
// SceneObject name "ProfileButton" so LEAF can find it.

import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {ElementContent} from "SpectaclesUIKit.lspkg/Scripts/Components/Content/ElementContent"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import * as UI from "./AllergyLensSharedUI"

const ICON_PROFILE = requireAsset("../Icons/person.png") as Texture

@component
export class AllergyLensProfileButtonUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensProfileButtonUI – reopen the profile panel</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Button size in cm (square). Keep it ≥ 4 cm so it is an easy pinch target.")
  @widget(new SliderWidget(3, 8, 0.5))
  sizeCm: number = 4.5
  @ui.group_end

  private _onProfile = new Event<void>()

  /** User pinched the Profile button. */
  get onProfile(): PublicApi<void> {
    return this._onProfile.publicApi()
  }

  onAwake(): void {
    this.sceneObject.createComponent("Component.Canvas")
    const S = this.sizeCm
    const row = UI.flexRow(this.sceneObject, S, S, {justify: FlexJustify.Center, align: FlexAlign.Center})
    UI.flexChild(row, {w: S, h: S}, (so) => {
      so.name = "ProfileButton"
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(S, S, 1)
      btn.onTriggerUp.add(() => this._onProfile.invoke())
      const ec = so.createComponent(ElementContent.getTypeName()) as ElementContent
      ec.leadingIcon = ICON_PROFILE
      ec.leadingIconSize = Math.min(S - 1.4, 2.6)
    })
  }
}

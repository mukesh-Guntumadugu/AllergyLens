// AllergyLensProfileButtonUI — the way back to the profile once setup is done: one pinch target
// in the lower corner of the view, head-locked with the UI group it sits in. Transparent: an
// open-source icon (Material "account_circle") over a faint ring, no solid plate, big enough to
// read and pinch from 55 cm. Owns: the icon and its collider. Expects no scene @inputs beyond
// size. Must not decide anything — it only reports the pinch to Main.
// SceneObject name "ProfileButton" so LEAF can find it.

import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import * as UI from "./AllergyLensSharedUI"

const ICON_PROFILE = requireAsset("../Icons/profile/account.png") as Texture

@component
export class AllergyLensProfileButtonUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensProfileButtonUI – reopen the profile panel</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Icon size in cm. 7 cm at 55 cm reads clearly and is an easy pinch target.")
  @widget(new SliderWidget(4, 12, 0.5))
  sizeCm: number = 7

  @input
  @hint("Icon opacity when idle (it is see-through, not a solid plate).")
  @widget(new SliderWidget(0.3, 1, 0.05))
  idleAlpha: number = 0.8
  @ui.group_end

  private _onProfile = new Event<void>()
  private icon: Image | null = null

  /** User pinched the Profile button. */
  get onProfile(): PublicApi<void> {
    return this._onProfile.publicApi()
  }

  onAwake(): void {
    const S = this.sizeCm
    const root = UI.obj(this.sceneObject, "ProfileButton")
    // Pinch target: a thin box the size of the icon, plus SIK's Interactable (same recipe as the menu bars).
    const collider = root.createComponent("Physics.ColliderComponent") as ColliderComponent
    const shape = Shape.createBoxShape()
    shape.size = new vec3(S, S, 1.5)
    collider.shape = shape
    collider.fitVisual = false
    const interactable = root.createComponent(Interactable.getTypeName()) as Interactable
    interactable.onTriggerEnd.add(() => this._onProfile.invoke())
    interactable.onHoverEnter.add(() => this.setAlpha(1))
    interactable.onHoverExit.add(() => this.setAlpha(this.idleAlpha))
    // The icon itself, see-through; no plate behind it.
    this.icon = UI.addImage(root, ICON_PROFILE, S, S, new vec4(1, 1, 1, this.idleAlpha), false)
  }

  private setAlpha(a: number): void {
    if (this.icon) this.icon.mainPass.baseColor = new vec4(1, 1, 1, a)
  }
}

// AllergyLensProfileButtonUI — the way back to the profile once setup is done: one pinch target
// in the lower corner of the view, head-locked with the UI group it sits in. Transparent: an
// the app mark (open-source Material icon) with no solid plate behind it, big enough to
// read and pinch from 55 cm. Owns: the icon and its collider. Expects no scene @inputs beyond
// size. Must not decide anything — it only reports the pinch to Main.
// SceneObject name "ProfileButton" so LEAF can find it.

import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {InteractableManipulation} from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import * as UI from "./AllergyLensSharedUI"

// The app mark itself (Material "restaurant_menu", the same icon as the welcome screen) — no custom logo.
const ICON_PROFILE = requireAsset("../Icons/profile/logo.png") as Texture

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
  private _onDragStart = new Event<void>()
  private _onDragEnd = new Event<boolean>()
  private icon: Image | null = null
  private root: SceneObject | null = null
  private pinchStartLocal: vec3 | null = null
  private moved = false

  /** User tapped the Profile button (a pinch that did not drag it). */
  get onProfile(): PublicApi<void> {
    return this._onProfile.publicApi()
  }
  /** Pinch-and-drag began. */
  get onDragStart(): PublicApi<void> {
    return this._onDragStart.publicApi()
  }
  /** Drag ended; true when the icon actually moved (more than a centimetre). */
  get onDragEnd(): PublicApi<boolean> {
    return this._onDragEnd.publicApi()
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
    this.root = root
    // Pinch-and-drag moves the icon with SIK's own manipulation (the standard Specs grab feel): translation
    // only. The icon is a child of the head-locked group, so wherever it is let go becomes its new place in
    // the view and it keeps following the head from there. A pinch that did not move it is a tap: open.
    const manip = root.createComponent(InteractableManipulation.getTypeName()) as InteractableManipulation
    manip.setCanTranslate(true)
    manip.setCanRotate(false)
    manip.setCanScale(false)
    manip.onManipulationStart.add(() => {
      this.moved = false
      this._onDragStart.invoke()
    })
    manip.onManipulationEnd.add(() => {
      this.keepInView()
      this._onDragEnd.invoke(this.moved)
    })
    interactable.onTriggerStart.add(() => {
      this.pinchStartLocal = root.getTransform().getLocalPosition()
      this.moved = false
    })
    interactable.onTriggerEnd.add(() => {
      const start = this.pinchStartLocal
      const now = root.getTransform().getLocalPosition()
      this.moved = !!start && now.distance(start) > 1
      if (this.moved) return
      this._onProfile.invoke()
    })
    interactable.onHoverEnter.add(() => this.setAlpha(1))
    interactable.onHoverExit.add(() => this.setAlpha(this.idleAlpha))
    // The icon itself, see-through; no plate behind it.
    this.icon = UI.addImage(root, ICON_PROFILE, S, S, new vec4(1, 1, 1, this.idleAlpha), false)
  }

  /** After a drag, keep the icon on the panel's plane and inside the glasses' view (local cm of the head-locked group). */
  private keepInView(): void {
    if (!this.root) return
    const t = this.root.getTransform()
    const p = t.getLocalPosition()
    t.setLocalPosition(new vec3(Math.max(-22, Math.min(5, p.x)), Math.max(-3, Math.min(17, p.y)), 0))
  }

  private setAlpha(a: number): void {
    if (this.icon) this.icon.mainPass.baseColor = new vec4(1, 1, 1, a)
  }
}

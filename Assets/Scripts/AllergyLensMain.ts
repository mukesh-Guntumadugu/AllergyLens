// AllergyLensMain — orchestrator. Owns: the profile (what the user flagged), the scan
// results, and the show/hide flow between the four UI panels. Expects @inputs wired
// by the scene bootstrap: profilePanel, menuCard, scanBar, dishDetail (typed UI
// handles). Must not author UI text or geometry — it only pushes state into the UI
// modules and listens to their events.
//
// Flow (devpost/design-brief.md): profile panel shows at start → Done hides it and
// shows the menu + Scan button → Scan paints green/red on the dishes → pinching a
// red dish opens the detail card next to it → pinch again / another dish closes it →
// Profile button reopens the panel; rescanning updates the highlights.

import {AllergyLensProfileUI} from "./AllergyLensProfileUI"
import {AllergyLensMenuCardUI} from "./AllergyLensMenuCardUI"
import {AllergyLensScanBarUI} from "./AllergyLensScanBarUI"
import {AllergyLensDishDetailUI} from "./AllergyLensDishDetailUI"
import {AllergyLensAudio} from "./AllergyLensAudio"
import {DISHES} from "./AllergyLensMenuData"
import {checkMenu, describeResult, DishResult, Profile} from "./AllergyLensChecker"

@component
export class AllergyLensMain extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensMain – profile → scan → highlights → detail</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">References</span>')
  @ui.group_start("References")
  @input
  @hint("Profile panel UI (toggles + Done).")
  profilePanel!: AllergyLensProfileUI

  @input
  @hint("Menu card UI with the six dish tiles.")
  menuCard!: AllergyLensMenuCardUI

  @input
  @hint("Scan menu + Profile buttons.")
  scanBar!: AllergyLensScanBarUI

  @input
  @hint("Small detail card shown next to a red dish.")
  dishDetail!: AllergyLensDishDetailUI
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Show the profile panel when the Lens starts and keep the menu hidden until Done is pinched.")
  showProfileAtStart: boolean = true

  @input
  @hint("Gap (cm) between a dish tile's edge and the detail card that opens beside it.")
  @widget(new SliderWidget(0, 20, 0.5))
  detailGapCm: number = 1.5

  @input
  @hint("Volume for the click / scan / pop cues (0 = silent).")
  @widget(new SliderWidget(0, 1, 0.05))
  sfxVolume: number = 0.8
  @ui.group_end

  private profile = new Profile()
  private results: DishResult[] = []
  private openDish = -1
  private audio: AllergyLensAudio | null = null

  onAwake(): void {
    if (!this.profilePanel || !this.menuCard || !this.scanBar || !this.dishDetail) {
      print("AllergyLensMain: required @input not wired (profilePanel / menuCard / scanBar / dishDetail). Check Phase B.")
      return
    }
    const audioHost = global.scene.createSceneObject("Audio")
    audioHost.setParent(this.sceneObject)
    this.audio = new AllergyLensAudio(audioHost, this.sfxVolume)

    this.createEvent("OnStartEvent").bind(() => this.onStart())
  }

  private onStart(): void {
    // Subscribe here, not in onAwake: the UI SceneObjects sit below this root in the
    // hierarchy, so their scripts (and their Event fields) only exist once OnStart runs.
    this.profilePanel.onToggle.add((e) => {
      this.profile.set(e.id, e.on)
      this.audio?.playClick()
      print(`AllergyLens: profile ${e.id} = ${e.on ? "on" : "off"}`)
    })
    this.profilePanel.onDone.add(() => this.onProfileDone())
    this.scanBar.onScan.add(() => this.runScan())
    this.scanBar.onProfile.add(() => this.openProfile())
    this.menuCard.onDishPinched.add((i) => this.onDishPinched(i))
    this.dishDetail.onClose.add(() => this.closeDetail())

    const menuVisible = !this.showProfileAtStart
    this.profilePanel.getSceneObject().enabled = this.showProfileAtStart
    this.menuCard.getSceneObject().enabled = menuVisible
    this.scanBar.getSceneObject().enabled = menuVisible
    this.dishDetail.hideDetail()
    print(`AllergyLens: ready (profile ${this.showProfileAtStart ? "shown" : "hidden"})`)
  }

  // ── Profile ────────────────────────────────────────────────────────────
  private onProfileDone(): void {
    this.audio?.playClick()
    this.profilePanel.getSceneObject().enabled = false
    this.menuCard.getSceneObject().enabled = true
    this.scanBar.getSceneObject().enabled = true
    print(`AllergyLens: profile done [${this.profile.ids().join(", ")}] — menu shown`)
  }

  private openProfile(): void {
    this.audio?.playClick()
    this.closeDetail()
    this.profilePanel.getSceneObject().enabled = true
    print("AllergyLens: profile reopened")
  }

  // ── Scan ───────────────────────────────────────────────────────────────
  private runScan(): void {
    this.closeDetail()
    this.results = checkMenu(DISHES, this.profile)
    for (let i = 0; i < this.results.length; i++) {
      this.menuCard.setDishState(i, this.results[i].verdict)
    }
    this.audio?.playScan()
    const flagged = this.results.filter((r) => r.verdict === "flagged").map((r) => r.dishId)
    print(`AllergyLens: scan complete — flagged [${flagged.join(", ")}], safe ${this.results.length - flagged.length}`)
  }

  // ── Dish detail ────────────────────────────────────────────────────────
  private onDishPinched(index: number): void {
    const result = this.results[index]
    if (!result || result.verdict !== "flagged") {
      // Green (or unscanned) dish: nothing to explain — just close any open card.
      if (this.openDish >= 0) this.closeDetail()
      return
    }
    if (this.openDish === index) {
      this.closeDetail()
      return
    }
    this.openDish = index
    const text = describeResult(result)
    this.placeDetailNextTo(index)
    this.dishDetail.showDetail({dishName: DISHES[index].name, headline: text.headline, body: text.body})
    this.audio?.playPop()
    print(`AllergyLens: detail open for ${DISHES[index].id} — ${text.headline} ${text.body.replace(/\n/g, " ")}`)
  }

  private closeDetail(): void {
    if (this.openDish >= 0) print(`AllergyLens: detail closed for ${DISHES[this.openDish].id}`)
    this.openDish = -1
    this.dishDetail.hideDetail()
  }

  /** Park the detail card beside the pinched tile, in the card's plane, on the outer side. */
  private placeDetailNextTo(index: number): void {
    const anchor = this.menuCard.getDishAnchor(index)
    if (!anchor) return
    const at = anchor.getTransform()
    const rot = at.getWorldRotation()
    const right = rot.multiplyVec3(vec3.right())
    const forward = rot.multiplyVec3(vec3.forward())
    const side = this.menuCard.getDishSide(index)
    const tileHalfW = (this.menuCard.cardWidthCm - 1.2 * 2 - 0.6) / 4
    const offset = tileHalfW + this.detailGapCm + this.dishDetail.cardWidthCm / 2
    const pos = at.getWorldPosition().add(right.uniformScale(side * offset)).add(forward.uniformScale(0.5))
    const dt = this.dishDetail.getSceneObject().getTransform()
    dt.setWorldPosition(pos)
    dt.setWorldRotation(rot)
  }
}

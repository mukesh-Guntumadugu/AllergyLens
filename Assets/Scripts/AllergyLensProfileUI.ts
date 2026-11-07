// AllergyLensProfileUI — the profile as a short guided setup, one question per screen:
//   welcome → allergies → religious / cultural → diet → done.
// Space is the constraint on glasses, so each screen is only: the question (with one icon), the
// "Heard: …" line, the tiles, the chips for anything spoken, and Back / Next. No header. Three small
// controls sit in the top-right corner: keyboard (opens the SPECS system keyboard at once, with the
// typed text shown in a field BELOW the panel, never over it), mic (listening on / off) and speaker
// (voice on / off) — each both a status and a switch. In the Lens Studio preview with SPECS 27 the
// system keyboard is replaced by Lens Studio's "Keyboard Simulation" sheet (hardware keys type).
// Owns: the tiles, chips and controls and their visuals, the step switch. Expects no scene @inputs
// beyond sizing. Must not hold the profile — it reports every flip, step change, control and edit
// to Main (the single owner of profile state). Object names LEAF relies on: "Toggle-<allergen id>",
// "StartButton", "NextButton-<step>", "BackButton-<step>", "DoneButton", "MoreButton".

import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {ALLERGENS, AllergenDef} from "./AllergyLensMenuData"
import * as UI from "./AllergyLensSharedUI"

const ICON_DONE = requireAsset("../Icons/check.png") as Texture
// Open-source Material Symbols (Apache 2.0), fetched by tools/assets/fetch_icons.sh.
const ICON_LOGO = requireAsset("../Icons/profile/logo.png") as Texture
const ICON_KEYBOARD = requireAsset("../Icons/profile/keyboard.png") as Texture
const ICON_MIC = requireAsset("../Icons/profile/mic.png") as Texture
const ICON_MIC_OFF = requireAsset("../Icons/profile/mic_off.png") as Texture
const ICON_SPEAKER = requireAsset("../Icons/profile/speaker.png") as Texture
const ICON_SPEAKER_OFF = requireAsset("../Icons/profile/speaker_off.png") as Texture
const SCREEN_ICONS: {[s: string]: Texture} = {
  allergies: requireAsset("../Icons/profile/allergies.png") as Texture,
  religious: requireAsset("../Icons/profile/religious.png") as Texture,
  diet: requireAsset("../Icons/profile/diet.png") as Texture,
}

export type ProfileStep = "welcome" | "allergies" | "religious" | "diet"
export const PROFILE_STEPS: ProfileStep[] = ["welcome", "allergies", "religious", "diet"]
/** Every allergen id that has a tile on some screen; the rest of the profile shows as chips. */
export const TILE_IDS: string[] = ["peanut", "tree_nut", "milk", "egg", "wheat", "shellfish", "beef", "pork", "alcohol", "meat", "vegan", "high_sugar", "trans_fat"]

/** What each screen asks and which tiles it shows (ids from data/allergens.json). */
const SCREENS: {[s in ProfileStep]: {question: string; tiles: string[]}} = {
  welcome: {question: "", tiles: []},
  allergies: {question: "Any food allergies?", tiles: ["peanut", "tree_nut", "milk", "egg", "wheat", "shellfish"]},
  religious: {question: "Anything you avoid for religious or cultural reasons?", tiles: ["beef", "pork", "alcohol"]},
  diet: {question: "Any diet?", tiles: ["meat", "vegan", "high_sugar", "trans_fat"]},
}
/** Shorter tile labels than the data's "No beef" style. */
const TILE_LABELS: {[id: string]: string} = {
  peanut: "Peanuts", tree_nut: "Tree nuts", milk: "Milk / dairy", egg: "Eggs", wheat: "Wheat / gluten", shellfish: "Shellfish",
  fish: "Fish", soy: "Soy", sesame: "Sesame", beef: "No beef", pork: "No pork", alcohol: "No alcohol",
  meat: "Vegetarian", vegan: "Vegan", high_sugar: "Low sugar", trans_fat: "No trans fat",
}

export interface ProfileToggleEvent {
  id: string
  on: boolean
}

const PAD = 1.2
const GAP = 0.5
const COLS = 3
const QUESTION_H = 3.0
const HEARD_H = 1.9
const TILE_H = 3.4
const CHIP_H = 2.6
const FOOTER_H = 3.0
const FOOT_BTN_W = 9
const CTRL = 2.4         // corner control button size
const CTRL_ICON = 1.7
const ICON = 2.2
const BODY_ROWS = 2      // tile rows reserved on every question screen
const CHIP_ROWS = 2

@component
export class AllergyLensProfileUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">AllergyLensProfileUI – guided profile setup (welcome → allergies → religious → diet)</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Name shown on the welcome screen.")
  appName: string = "AllergyLens"

  @input
  @hint("Panel width in cm.")
  @widget(new SliderWidget(24, 50, 1))
  panelWidthCm: number = 34

  @input
  @hint("Viewing distance (cm) used to scale text; the panel sits ~80 cm from the user.")
  @widget(new SliderWidget(40, 110, 5))
  textDistanceCm: number = 80

  @input
  @hint("Text size multiplier for this panel (1 = the Specs type scale). Bigger reads better from 80 cm.")
  @widget(new SliderWidget(0.8, 2.0, 0.05))
  textScale: number = 1.3
  @ui.group_end

  private buttons = new Map<string, Button>()
  private pendingStates = new Map<string, boolean>()
  private screens = new Map<ProfileStep, SceneObject>()
  private heardTexts: Text[] = []
  private micTexts: Text[] = []
  private micIcons: Image[] = []
  private speakerIcons: Image[] = []
  private chipArea: SceneObject | null = null
  private chipObjects: SceneObject[] = []
  private chipW = 8
  private overflowText: Text | null = null
  private editRow: SceneObject | null = null
  private editText: Text | null = null
  private typed = ""
  private keyboardOpen = false
  private greeting: Text | null = null
  private panelH = 20
  private _step: ProfileStep = "welcome"
  private _listening = false
  private _speaking = true
  private _onToggle = new Event<ProfileToggleEvent>()
  private _onStep = new Event<ProfileStep>()
  private _onDone = new Event<void>()
  private _onMore = new Event<void>()
  private _onEditCustom = new Event<string>()
  private _onRemoveExtra = new Event<string>()
  private _onMicToggle = new Event<void>()
  private _onSpeakerToggle = new Event<void>()

  /** A tile flipped: {id, on}. */
  get onToggle(): PublicApi<ProfileToggleEvent> {
    return this._onToggle.publicApi()
  }
  /** The user moved to another screen (Start / Next / Back). */
  get onStep(): PublicApi<ProfileStep> {
    return this._onStep.publicApi()
  }
  /** User pinched Done on the last screen. */
  get onDone(): PublicApi<void> {
    return this._onDone.publicApi()
  }
  /** User pinched More… on the allergies screen: the Lens asks for the rest by voice. */
  get onMore(): PublicApi<void> {
    return this._onMore.publicApi()
  }
  /** User corrected the spoken items on the keyboard; the full text of the field. */
  get onEditCustom(): PublicApi<string> {
    return this._onEditCustom.publicApi()
  }
  /** User pinched a chip ("Sesame ×"): remove that item from the profile. */
  get onRemoveExtra(): PublicApi<string> {
    return this._onRemoveExtra.publicApi()
  }
  /** User pinched the mic control (listening on / off). */
  get onMicToggle(): PublicApi<void> {
    return this._onMicToggle.publicApi()
  }
  /** User pinched the speaker control (voice on / off). */
  get onSpeakerToggle(): PublicApi<void> {
    return this._onSpeakerToggle.publicApi()
  }
  get step(): ProfileStep {
    return this._step
  }

  onAwake(): void {
    const W = this.panelWidthCm
    const innerW = W - PAD * 2
    const d = this.textDistanceCm * this.textScale
    const tileW = (innerW - GAP * (COLS - 1)) / COLS
    const chipsH = CHIP_H * CHIP_ROWS + GAP
    // One height for every screen: question row, Heard line, two tile rows, two chip rows, footer.
    const H = PAD * 2 + QUESTION_H + HEARD_H + TILE_H * BODY_ROWS + chipsH + FOOTER_H + GAP * 6
    this.panelH = H
    this.chipW = tileW

    this.sceneObject.createComponent("Component.Canvas")
    const plate = this.sceneObject.createComponent(BackPlate.getTypeName()) as BackPlate
    plate.size = new vec2(W, H)
    const content = UI.obj(this.sceneObject, "Content", new vec3(0, 0, UI.CONTENT_Z))

    for (const step of PROFILE_STEPS) {
      const screen = UI.obj(content, `Screen-${step}`)
      this.screens.set(step, screen)
      const col = UI.flexColumn(screen, W, H, {gap: GAP, padX: PAD, padY: PAD, justify: FlexJustify.Start, align: FlexAlign.Stretch})
      if (step === "welcome") this.buildWelcome(col, innerW, d, chipsH)
      else this.buildQuestionScreen(col, innerW, d, tileW, step, chipsH)
      this.buildFooter(col, innerW, d, step)
      screen.enabled = step === this._step
    }
    // The typing field lives BELOW the panel, outside the plate, so it never covers anything.
    this.buildEditRow(innerW, d, H)
  }

  // ── Public API ─────────────────────────────────────────────────────────
  setStep(step: ProfileStep): void {
    this._step = step
    this.screens.forEach((so, s) => (so.enabled = s === step))
    this.setEditing(false)
  }

  setToggle(id: string, on: boolean): void {
    this.pendingStates.set(id, on)
    const btn = this.buttons.get(id)
    if (btn) btn.isOn = on
  }

  isOn(id: string): boolean {
    return this.buttons.get(id)?.isOn ?? false
  }

  /** "Hi, Mukesh." on the welcome screen (the Snapchat display name on the glasses). */
  setDisplayName(name: string): void {
    if (this.greeting) this.greeting.text = name.trim().length > 0 ? `Hi, ${name.trim()}.` : "Hi."
  }

  /** Show the last thing the microphone heard and what the Lens did with it (one line, inside the panel). */
  setHeard(text: string): void {
    const max = 62
    let shown = text
    if (shown.length > max) {
      const arrow = shown.indexOf(" → ")
      if (arrow > 0 && shown.length - arrow < max - 20) shown = shown.slice(0, max - (shown.length - arrow) - 1) + "…" + shown.slice(arrow)
      else shown = shown.slice(0, max - 1) + "…"
    }
    for (const t of this.heardTexts) t.text = shown
  }

  /** Mic state: the dot before the Heard line and the corner mic icon follow it. */
  setListening(on: boolean): void {
    this._listening = on
    for (const t of this.micTexts) t.textFill.color = on ? new vec4(0.4, 1, 0.5, 1) : new vec4(1, 1, 1, 0.3)
    for (const img of this.micIcons) {
      img.mainPass.baseTex = on ? ICON_MIC : ICON_MIC_OFF
      img.mainPass.baseColor = new vec4(1, 1, 1, on ? 1 : 0.55)
    }
  }

  /** Speaker state for the corner icon. */
  setSpeaking(on: boolean): void {
    this._speaking = on
    for (const img of this.speakerIcons) {
      img.mainPass.baseTex = on ? ICON_SPEAKER : ICON_SPEAKER_OFF
      img.mainPass.baseColor = new vec4(1, 1, 1, on ? 1 : 0.55)
    }
  }

  /**
   * Everything on the profile that has no tile on the allergies screen — fish, soy, sesame and
   * anything spoken ("olive oil") — as chips after the More… tile: five visible, "+N more" beyond
   * that. No limit on what is stored; the keyboard field always carries the full list.
   */
  setExtras(items: Array<{id: string; label: string}>): void {
    for (const so of this.chipObjects) so.destroy()
    this.chipObjects = []
    if (!this.chipArea) return
    const d = this.textDistanceCm * this.textScale
    const slots = COLS * CHIP_ROWS - 1 // the first slot is the More… tile
    const visible = items.slice(0, slots)
    visible.forEach((item, i) => {
      const slot = i + 1
      const col = slot % COLS
      const row = Math.floor(slot / COLS)
      const so = UI.obj(this.chipArea!, `Extra-${item.id}`, new vec3(this.slotX(col), this.slotY(row), UI.LAYOUT_Z_LIFT))
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(this.chipW, CHIP_H, 1)
      btn.onTriggerUp.add(() => this._onRemoveExtra.invoke(item.id))
      UI.addButtonLabel(so, `${item.label}  ×`, this.chipW - 0.8, d, "Callout")
      this.chipObjects.push(so)
    })
    if (this.overflowText) this.overflowText.text = items.length > slots ? `+${items.length - slots} more (keyboard shows all)` : ""
    if (!this.keyboardOpen) this.showTyped(items.map((i) => i.label).join(", "))
  }

  /**
   * Typing on / off: the SPECS system keyboard comes up at once (one pinch on the icon), the text is
   * shown in the field below the panel, Return applies it. Off dismisses the keyboard and hides the field.
   */
  setEditing(on: boolean): void {
    if (this.editRow) this.editRow.enabled = on
    if (on) this.requestKeyboard()
    else if (this.keyboardOpen) {
      try {
        global.textInputSystem.dismissKeyboard()
      } catch (e) {
        print(`AllergyLens: keyboard dismiss failed (${e})`)
      }
      this.keyboardOpen = false
    }
  }

  openEdit(): void {
    if (this._step !== "allergies") this.setStep("allergies")
    this.setEditing(true)
  }

  private requestKeyboard(): void {
    try {
      require("LensStudio:TextInputModule")
      const options = new TextInputSystem.KeyboardOptions()
      options.enablePreview = true
      options.keyboardType = TextInputSystem.KeyboardType.Text
      options.returnKeyType = TextInputSystem.ReturnKeyType.Done
      options.initialText = this.typed
      options.onTextChanged = (text: string) => this.showTyped(text)
      options.onReturnKeyPressed = () => {
        this.keyboardOpen = false
        global.textInputSystem.dismissKeyboard()
        if (this.editRow) this.editRow.enabled = false
        this._onEditCustom.invoke(this.typed)
      }
      options.onKeyboardStateChanged = (isOpen: boolean) => {
        this.keyboardOpen = isOpen
        print(`AllergyLens: keyboard ${isOpen ? "open" : "closed"}`)
      }
      options.onError = (error: number, description: string) => print(`AllergyLens: keyboard error ${error}: ${description}`)
      global.textInputSystem.requestKeyboard(options)
      this.keyboardOpen = true
    } catch (e) {
      print(`AllergyLens: keyboard unavailable (${e})`)
    }
  }

  private showTyped(text: string): void {
    this.typed = text
    if (this.editText) {
      const empty = text.trim().length === 0
      this.editText.text = empty ? "Type the foods to avoid, comma-separated" : text
      this.editText.textFill.color = empty ? UI.WHITE_SOFT : UI.WHITE
    }
  }

  // ── Screens ────────────────────────────────────────────────────────────
  private buildWelcome(col: SceneObject, innerW: number, d: number, chipsH: number): void {
    // Welcome: the mark, the greeting, two lines, Heard — centred; same total height as the other screens.
    const top = UI.flexRow(col, innerW, QUESTION_H, {gap: 0.8, justify: FlexJustify.SpaceBetween, align: FlexAlign.Center})
    UI.addRowText(top, this.appName, "Subheadline", d, innerW - CTRL * 3 - GAP * 3, HorizontalAlignment.Left, UI.WHITE_SOFT)
    this.addControls(top, d)
    const logoRow = UI.flexRow(col, innerW, 6, {justify: FlexJustify.Center, align: FlexAlign.Center})
    UI.addImage(logoRow, ICON_LOGO, 6, 6)
    this.greeting = UI.addColumnText(col, "Hi.", "Headline1", d, 3.0, HorizontalAlignment.Center)
    UI.addColumnText(col, "Let’s set up your profile in three quick steps. Say your answers, or pinch.", "Body", d, 1.8, HorizontalAlignment.Center, UI.WHITE_SOFT)
    this.addHeardLine(col, innerW, d)
    // Spacer so Start sits where Next does on the question screens.
    const used = QUESTION_H + 6 + 3.0 + 1.8 + HEARD_H + GAP * 4
    const target = QUESTION_H + HEARD_H + TILE_H * BODY_ROWS + chipsH + GAP * 4
    UI.flexChild(col, {w: innerW, h: Math.max(0.1, target - used)}, () => {})
  }

  private buildQuestionScreen(col: SceneObject, innerW: number, d: number, tileW: number, step: ProfileStep, chipsH: number): void {
    const screen = SCREENS[step]
    // Question row: icon + question on the left, the three controls on the right.
    const q = UI.flexRow(col, innerW, QUESTION_H, {gap: 0.6, justify: FlexJustify.SpaceBetween, align: FlexAlign.Center})
    const left = UI.flexRow(q, innerW - CTRL * 3 - GAP * 3, QUESTION_H, {gap: 0.6, justify: FlexJustify.Start, align: FlexAlign.Center})
    UI.addImage(left, SCREEN_ICONS[step], QUESTION_H * 0.85, QUESTION_H * 0.85)
    UI.addRowText(left, screen.question, "Headline2", d, innerW - CTRL * 3 - GAP * 3 - QUESTION_H, HorizontalAlignment.Left)
    this.addControls(q, d)
    this.addHeardLine(col, innerW, d)
    // Tiles, three per row; the reserved rows keep the footer in the same place on every screen.
    const ids = screen.tiles.slice()
    let rows = 0
    for (let r = 0; r < ids.length; r += COLS) {
      const row = UI.flexRow(col, innerW, TILE_H, {gap: GAP, justify: FlexJustify.Start, align: FlexAlign.Center})
      for (const id of ids.slice(r, r + COLS)) this.addTile(row, id, tileW, d)
      rows++
    }
    if (rows < BODY_ROWS) UI.flexChild(col, {w: innerW, h: TILE_H * (BODY_ROWS - rows) + GAP * (BODY_ROWS - rows)}, () => {})
    if (step === "allergies") {
      // Chip area: a fixed box; the More… tile takes the first slot, spoken items the rest. Everything inside
      // is placed by hand (hidden flex children would still take space), so nothing below ever moves.
      UI.flexChild(col, {w: innerW, h: chipsH}, (box) => {
        this.chipArea = box
        const more = UI.obj(box, "MoreButton", new vec3(this.slotX(0), this.slotY(0), UI.LAYOUT_Z_LIFT))
        const btn = more.createComponent(Button.getTypeName()) as Button
        btn.size = new vec3(tileW, CHIP_H, 1)
        btn.onTriggerUp.add(() => this._onMore.invoke())
        UI.addButtonLabel(more, "More…", tileW - 0.8, d, "Callout")
        this.overflowText = UI.addRowText(UI.obj(box, "Overflow", new vec3(0, -chipsH / 2 - 0.8, UI.LAYOUT_Z_LIFT)), "", "Caption", d, innerW, HorizontalAlignment.Left, UI.WHITE_SOFT)
      })
    } else {
      UI.flexChild(col, {w: innerW, h: chipsH}, () => {})
    }
  }

  private slotX(col: number): number {
    return -(this.chipW + GAP) + col * (this.chipW + GAP)
  }
  private slotY(row: number): number {
    return (CHIP_H + GAP) / 2 - row * (CHIP_H + GAP)
  }

  private addControls(row: SceneObject, d: number): void {
    const group = UI.flexRow(row, CTRL * 3 + GAP * 2, CTRL, {gap: GAP, justify: FlexJustify.End, align: FlexAlign.Center})
    this.addControl(group, "KeyboardButton", ICON_KEYBOARD, () => this.setEditing(!(this.editRow && this.editRow.enabled)), null)
    this.addControl(group, "MicButton", this._listening ? ICON_MIC : ICON_MIC_OFF, () => this._onMicToggle.invoke(), this.micIcons)
    this.addControl(group, "SpeakerButton", this._speaking ? ICON_SPEAKER : ICON_SPEAKER_OFF, () => this._onSpeakerToggle.invoke(), this.speakerIcons)
  }

  private addControl(row: SceneObject, name: string, icon: Texture, onPinch: () => void, registry: Image[] | null): void {
    UI.flexChild(row, {w: CTRL, h: CTRL}, (so) => {
      so.name = name
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(CTRL, CTRL, 1)
      btn.onTriggerUp.add(onPinch)
      const inner = UI.flexRow(so, CTRL, CTRL, {justify: FlexJustify.Center, align: FlexAlign.Center})
      UI.liftInZ(inner, UI.BUTTON_LABEL_Z)
      const img = UI.addImage(inner, icon, CTRL_ICON, CTRL_ICON)
      if (registry) registry.push(img)
    })
  }

  private addHeardLine(col: SceneObject, innerW: number, d: number): void {
    const row = UI.flexRow(col, innerW, HEARD_H, {gap: 0.6, justify: FlexJustify.Start, align: FlexAlign.Center})
    // A dot that is green while speech-to-text runs, then what was heard.
    this.micTexts.push(UI.addRowText(row, "●", "Body", d, 1.2, HorizontalAlignment.Center, new vec4(1, 1, 1, this._listening ? 1 : 0.3)))
    this.heardTexts.push(UI.addRowText(row, "", "Body", d, innerW - 1.8, HorizontalAlignment.Left, new vec4(0.6, 0.85, 1, 1)))
  }

  private buildFooter(col: SceneObject, innerW: number, d: number, step: ProfileStep): void {
    const row = UI.flexRow(col, innerW, FOOTER_H, {gap: GAP, justify: FlexJustify.SpaceBetween, align: FlexAlign.Center})
    const n = PROFILE_STEPS.indexOf(step)
    if (n >= 2) this.addFooterButton(row, `BackButton-${step}`, "‹ Back", null, d, () => this.go(PROFILE_STEPS[n - 1]))
    else UI.flexChild(row, {w: FOOT_BTN_W, h: FOOTER_H}, () => {})
    UI.addRowText(row, n === 0 ? "" : `${n} / 3`, "Caption", d, innerW - FOOT_BTN_W * 2 - GAP * 2, HorizontalAlignment.Center, UI.WHITE_SOFT)
    if (step === "welcome") this.addFooterButton(row, "StartButton", "Start ›", null, d, () => this.go("allergies"))
    else if (step === "diet") this.addFooterButton(row, "DoneButton", "Done", ICON_DONE, d, () => this._onDone.invoke())
    else this.addFooterButton(row, `NextButton-${step}`, "Next ›", null, d, () => this.go(PROFILE_STEPS[n + 1]))
  }

  private go(step: ProfileStep): void {
    this.setStep(step)
    this._onStep.invoke(step)
  }

  private addFooterButton(row: SceneObject, name: string, label: string, icon: Texture | null, d: number, onPinch: () => void): void {
    UI.flexChild(row, {w: FOOT_BTN_W, h: FOOTER_H}, (so) => {
      so.name = name
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(FOOT_BTN_W, FOOTER_H, 1)
      btn.onTriggerUp.add(onPinch)
      const inner = UI.flexRow(so, FOOT_BTN_W, FOOTER_H, {gap: 0.6, justify: FlexJustify.Center, align: FlexAlign.Center})
      UI.liftInZ(inner, UI.BUTTON_LABEL_Z)
      UI.addRowText(inner, label, "Callout", d, label.length * UI.charWidthCm("Callout", d) + 1, HorizontalAlignment.Center)
      if (icon) UI.addImage(inner, icon, ICON * 0.8, ICON * 0.8)
    })
  }

  private addTile(row: SceneObject, id: string, w: number, d: number): void {
    const item = ALLERGENS.find((a) => a.id === id)
    if (!item) return
    UI.flexChild(row, {w, h: TILE_H}, (so) => {
      so.name = `Toggle-${id}`
      this.buildToggle(so, item, w, d)
    })
  }

  private buildToggle(so: SceneObject, item: AllergenDef, w: number, d: number): void {
    const btn = so.createComponent(Button.getTypeName()) as Button
    btn.size = new vec3(w, TILE_H, 1)
    btn.setIsToggleable(true)
    btn.isOn = false
    // onValueChange carries the settled state (1 = on).
    btn.onValueChange.add((v: number) => this._onToggle.invoke({id: item.id, on: v === 1}))
    UI.addButtonLabel(so, TILE_LABELS[item.id] ?? item.label, w - 0.8, d, "Subheadline")
    this.buttons.set(item.id, btn)
    const pending = this.pendingStates.get(item.id)
    if (pending !== undefined) btn.isOn = pending
  }

  /** Text field + Apply, hanging below the panel; hidden until the keyboard control or "edit". */
  private buildEditRow(innerW: number, d: number, H: number): void {
    const edit = UI.obj(this.sceneObject, "EditRow", new vec3(0, -H / 2 - TILE_H / 2 - GAP, UI.CONTENT_Z))
    const fieldW = innerW - TILE_H - GAP
    // The field is a wide button: pinching it brings the keyboard back if it was dismissed.
    const fieldSO = UI.obj(edit, "EditCustomField", new vec3(-(TILE_H + GAP) / 2, 0, 0))
    const fieldBtn = fieldSO.createComponent(Button.getTypeName()) as Button
    fieldBtn.size = new vec3(fieldW, TILE_H, 1)
    fieldBtn.onTriggerUp.add(() => this.requestKeyboard())
    this.editText = UI.addButtonLabel(fieldSO, "Type the foods to avoid, comma-separated", fieldW - 1.2, d, "Body", UI.WHITE_SOFT)
    this.editText.horizontalAlignment = HorizontalAlignment.Left
    const applySO = UI.obj(edit, "ApplyCustomButton", new vec3(fieldW / 2 + GAP / 2, 0, 0))
    const apply = applySO.createComponent(Button.getTypeName()) as Button
    apply.size = new vec3(TILE_H, TILE_H, 1)
    apply.onTriggerUp.add(() => {
      this.setEditing(false)
      this._onEditCustom.invoke(this.typed)
    })
    const inner = UI.flexRow(applySO, TILE_H, TILE_H, {justify: FlexJustify.Center, align: FlexAlign.Center})
    UI.liftInZ(inner, UI.BUTTON_LABEL_Z)
    UI.addImage(inner, ICON_DONE, ICON, ICON)
    edit.enabled = false
    this.editRow = edit
  }
}

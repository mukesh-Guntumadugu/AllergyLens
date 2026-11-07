// AllergyLensProfileUI — the profile as a short guided setup, one question per screen:
//   welcome → allergies → religious / cultural → diet → done.
// Each screen: big question, a few text tiles (pinch or say), a "Heard: …" line with a mic,
// Back / Next. Allergies shows the six common ones; everything else is spoken: More… makes the
// Heard line the blank line ("sesame seeds, olive oil and garlic"), each item becomes a chip
// (pinch it to remove), there is no limit, and Edit opens a keyboard over the chips to fix words.
// Owns: the tiles and their on/off visuals, the step switch, the keyboard field. Expects no
// scene @inputs beyond sizing. Must not hold the profile — it reports each flip, step change
// and edit to Main (the single owner of profile state). Object names LEAF relies on:
// "Toggle-<allergen id>", "StartButton", "NextButton-<step>", "BackButton-<step>", "DoneButton", "MoreButton".

import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {TextInputField} from "SpectaclesUIKit.lspkg/Scripts/Components/TextInputField/TextInputField"
import {FlexAlign, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {ALLERGENS, AllergenDef} from "./AllergyLensMenuData"
import * as UI from "./AllergyLensSharedUI"

const ICON_DONE = requireAsset("../Icons/check.png") as Texture
// Open-source Material Symbols (Apache 2.0), fetched by tools/assets/fetch_icons.sh: one per screen + the app mark.
const ICON_LOGO = requireAsset("../Icons/profile/logo.png") as Texture
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
const SCREENS: {[s in ProfileStep]: {question: string; sub: string; tiles: string[]; more: string[]}} = {
  welcome: {question: "", sub: "", tiles: [], more: []},
  allergies: {question: "Any food allergies?", sub: "Pinch the common ones, or just say yours — any number.", tiles: ["peanut", "tree_nut", "milk", "egg", "wheat", "shellfish"], more: []},
  religious: {question: "Anything you avoid for religious or cultural reasons?", sub: "Say it or pinch it. Skip with Next.", tiles: ["beef", "pork", "alcohol"], more: []},
  diet: {question: "Any diet?", sub: "Say it or pinch it, then Done.", tiles: ["meat", "vegan", "high_sugar", "trans_fat"], more: []},
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

const PAD = 1.4
const GAP = 0.5
const COLS = 3
const HEADER_H = 3.2
const QUESTION_H = 3.0
const SUB_H = 1.6
const HEARD_H = 1.9
const TILE_H = 3.6
const CHIP_H = 2.6
const FOOTER_H = 3.4
const FOOT_BTN_W = 9.5
const ICON = 2.4

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
  private chipArea: SceneObject | null = null
  private chipObjects: SceneObject[] = []
  private chipW = 8
  private overflowText: Text | null = null
  private heardTexts: Text[] = []
  private micTexts: Text[] = []
  private editRow: SceneObject | null = null
  private editField: TextInputField | null = null
  private greeting: Text | null = null
  private _step: ProfileStep = "welcome"
  private _listening = false
  private _onToggle = new Event<ProfileToggleEvent>()
  private _onStep = new Event<ProfileStep>()
  private _onDone = new Event<void>()
  private _onMore = new Event<void>()
  private _onEditCustom = new Event<string>()
  private _onRemoveExtra = new Event<string>()
  private extras: Array<{id: string; label: string}> = []

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
  /** User pinched a chip ("Sesame ×"): remove that item from the profile. */
  get onRemoveExtra(): PublicApi<string> {
    return this._onRemoveExtra.publicApi()
  }
  /** User corrected the voice-added items on the keyboard; the full text of the field. */
  get onEditCustom(): PublicApi<string> {
    return this._onEditCustom.publicApi()
  }
  get step(): ProfileStep {
    return this._step
  }

  onAwake(): void {
    const W = this.panelWidthCm
    const innerW = W - PAD * 2
    const d = this.textDistanceCm * this.textScale
    const tileW = (innerW - GAP * (COLS - 1)) / COLS
    // One fixed height for every screen: header, question, hint, Heard line, three tile rows, two chip rows, footer.
    const CHIPS_H = CHIP_H * 2 + GAP
    const H = PAD * 2 + HEADER_H + QUESTION_H + SUB_H + HEARD_H + TILE_H * 3 + CHIPS_H + FOOTER_H + GAP * 8
    this.chipW = tileW

    this.sceneObject.createComponent("Component.Canvas")
    const plate = this.sceneObject.createComponent(BackPlate.getTypeName()) as BackPlate
    plate.size = new vec2(W, H)
    const content = UI.obj(this.sceneObject, "Content", new vec3(0, 0, UI.CONTENT_Z))

    for (const step of PROFILE_STEPS) {
      const screen = UI.obj(content, `Screen-${step}`)
      this.screens.set(step, screen)
      const col = UI.flexColumn(screen, W, H, {gap: GAP, padX: PAD, padY: PAD, justify: FlexJustify.Start, align: FlexAlign.Stretch})
      this.buildHeader(col, innerW, d, step)
      if (step === "welcome") this.buildWelcome(col, innerW, d)
      else this.buildQuestionScreen(col, innerW, d, tileW, step)
      this.buildFooter(col, innerW, d, step)
      screen.enabled = step === this._step
    }
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

  /** Show the last thing the microphone heard and what the Lens did with it. */
  setHeard(text: string): void {
    // One line, inside the panel: a long transcript is cut, the arrow part is kept.
    const max = 62
    let shown = text
    if (shown.length > max) {
      const arrow = shown.indexOf(" \u2192 ")
      if (arrow > 0 && shown.length - arrow < max - 20) shown = shown.slice(0, max - (shown.length - arrow) - 1) + "\u2026" + shown.slice(arrow)
      else shown = shown.slice(0, max - 1) + "\u2026"
    }
    for (const t of this.heardTexts) t.text = shown
  }

  /** Light the mic while speech-to-text is running. */
  setListening(on: boolean): void {
    this._listening = on
    for (const t of this.micTexts) t.textFill.color = on ? new vec4(0.4, 1, 0.5, 1) : new vec4(1, 1, 1, 0.3)
  }

  /**
   * Everything on the profile that has no tile on the allergies screen — fish, soy, sesame and
   * anything spoken ("olive oil") — as chips, three per row, two rows, "+N more" beyond that.
   * No limit on what is stored; the keyboard field always carries the full list.
   */
  setExtras(items: Array<{id: string; label: string}>): void {
    this.extras = items.slice()
    for (const so of this.chipObjects) so.destroy()
    this.chipObjects = []
    if (!this.chipArea) return
    const d = this.textDistanceCm * this.textScale
    const visible = items.slice(0, 6)
    visible.forEach((item, i) => {
      const col = i % COLS
      const row = Math.floor(i / COLS)
      const x = -(this.chipW + GAP) + col * (this.chipW + GAP)
      const y = (CHIP_H + GAP) / 2 - row * (CHIP_H + GAP)
      const so = UI.obj(this.chipArea!, `Extra-${item.id}`, new vec3(x, y, UI.LAYOUT_Z_LIFT))
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(this.chipW, CHIP_H, 1)
      btn.onTriggerUp.add(() => this._onRemoveExtra.invoke(item.id))
      UI.addButtonLabel(so, `${item.label}  ×`, this.chipW - 0.8, d, "Callout")
      so.enabled = !(this.editRow && this.editRow.enabled)
      this.chipObjects.push(so)
    })
    if (this.overflowText) this.overflowText.text = items.length > 6 ? `+${items.length - 6} more (Edit shows all)` : ""
    if (this.editField) this.editField.text = items.map((i) => i.label).join(", ")
  }

  /** Keyboard over the chip rows on / off (voice: "edit" / "keyboard"). */
  setEditing(on: boolean): void {
    if (this.editRow) this.editRow.enabled = on
    for (const so of this.chipObjects) so.enabled = !on
    if (this.overflowText) this.overflowText.enabled = !on
  }

  // ── Screens ────────────────────────────────────────────────────────────
  private buildHeader(col: SceneObject, innerW: number, d: number, step: ProfileStep): void {
    const row = UI.flexRow(col, innerW, HEADER_H, {gap: 0.8, justify: FlexJustify.Start, align: FlexAlign.Center})
    UI.addImage(row, ICON_LOGO, HEADER_H, HEADER_H)
    UI.addRowText(row, this.appName, "Subheadline", d, innerW - HEADER_H - 9, HorizontalAlignment.Left)
    const n = PROFILE_STEPS.indexOf(step)
    const dots = n === 0 ? "" : `${n} of 3`
    UI.addRowText(row, dots, "Callout", d, 7, HorizontalAlignment.Right, UI.WHITE_SOFT)
  }

  private buildWelcome(col: SceneObject, innerW: number, d: number): void {
    UI.flexChild(col, {w: innerW, h: GAP}, () => {})
    const logoRow = UI.flexRow(col, innerW, 7, {justify: FlexJustify.Center, align: FlexAlign.Center})
    UI.addImage(logoRow, ICON_LOGO, 7, 7)
    this.greeting = UI.addColumnText(col, "Hi.", "Headline1", d, QUESTION_H, HorizontalAlignment.Center)
    UI.addColumnText(col, "Let’s set up your profile in three quick steps.", "Body", d, SUB_H, HorizontalAlignment.Center)
    UI.addColumnText(col, "Say your answers, or pinch.", "Body", d, SUB_H, HorizontalAlignment.Center, UI.WHITE_SOFT)
    this.addHeardLine(col, innerW, d)
    // Spacer so the footer sits where it does on the question screens (their body: question + hint + 3 tile rows + chips).
    UI.flexChild(col, {w: innerW, h: TILE_H * 3 + CHIP_H * 2 + GAP - 7 - GAP - SUB_H}, () => {})
  }

  private buildQuestionScreen(col: SceneObject, innerW: number, d: number, tileW: number, step: ProfileStep): void {
    const screen = SCREENS[step]
    const q = UI.flexRow(col, innerW, QUESTION_H, {gap: 0.8, justify: FlexJustify.Start, align: FlexAlign.Center})
    UI.addImage(q, SCREEN_ICONS[step], QUESTION_H, QUESTION_H)
    UI.addRowText(q, screen.question, "Headline2", d, innerW - QUESTION_H - 0.8, HorizontalAlignment.Left)
    UI.addColumnText(col, screen.sub, "Body", d, SUB_H, HorizontalAlignment.Left, UI.WHITE_SOFT)
    this.addHeardLine(col, innerW, d)
    // Tiles, three per row.
    const ids = screen.tiles.slice()
    let rows = 0
    for (let r = 0; r < ids.length; r += COLS) {
      const row = UI.flexRow(col, innerW, TILE_H, {gap: GAP, justify: FlexJustify.Start, align: FlexAlign.Center})
      for (const id of ids.slice(r, r + COLS)) this.addTile(row, id, tileW, d)
      rows++
    }
    const CHIPS_H = CHIP_H * 2 + GAP
    if (step === "allergies") {
      // Third row: More… (the Lens asks for the rest by voice) and Edit (keyboard over the chips).
      const row = UI.flexRow(col, innerW, TILE_H, {gap: GAP, justify: FlexJustify.Start, align: FlexAlign.Center})
      this.addActionTile(row, "MoreButton", "More…", tileW, d, () => this._onMore.invoke())
      this.addActionTile(row, "EditCustomButton", "Edit", tileW, d, () => this.setEditing(!(this.editRow && this.editRow.enabled)))
      rows++
      // Chip area: a fixed-size box; chips, the "+N more" line and the keyboard field are placed by hand inside it
      // (hidden flex children would still take space), so showing one or the other never moves the footer.
      UI.flexChild(col, {w: innerW, h: CHIPS_H}, (box) => {
        this.chipArea = box
        this.overflowText = UI.addRowText(UI.obj(box, "Overflow", new vec3(0, -(CHIP_H + GAP) / 2 - CHIP_H / 2 - 0.2, UI.LAYOUT_Z_LIFT)), "", "Caption", d, innerW, HorizontalAlignment.Left, UI.WHITE_SOFT)
        const edit = UI.obj(box, "EditRow", new vec3(0, 0, UI.LAYOUT_Z_LIFT))
        const fieldW = innerW - TILE_H - GAP
        const fieldSO = UI.obj(edit, "EditCustomField", new vec3(-(TILE_H + GAP) / 2, 0, 0))
        const field = fieldSO.createComponent(TextInputField.getTypeName()) as TextInputField
        field.placeholderText = "Type the foods to avoid, comma-separated"
        this.editField = field
        const applySO = UI.obj(edit, "ApplyCustomButton", new vec3(fieldW / 2 + GAP / 2, 0, 0))
        const apply = applySO.createComponent(Button.getTypeName()) as Button
        apply.size = new vec3(TILE_H, TILE_H, 1)
        apply.onTriggerUp.add(() => {
          this.setEditing(false)
          this._onEditCustom.invoke(this.editField ? this.editField.text : "")
        })
        const inner = UI.flexRow(applySO, TILE_H, TILE_H, {justify: FlexJustify.Center, align: FlexAlign.Center})
        UI.liftInZ(inner, UI.BUTTON_LABEL_Z)
        UI.addImage(inner, ICON_DONE, ICON, ICON)
        edit.enabled = false
        this.editRow = edit
      })
    } else {
      // Keep the footer at the same height as on the allergies screen.
      UI.flexChild(col, {w: innerW, h: TILE_H * (3 - rows) + GAP * (3 - rows) + CHIPS_H}, () => {})
    }
  }

  private addHeardLine(col: SceneObject, innerW: number, d: number): void {
    const row = UI.flexRow(col, innerW, HEARD_H, {gap: 0.6, justify: FlexJustify.Start, align: FlexAlign.Center})
    // A dot that lights green while speech-to-text runs, then what was heard.
    this.micTexts.push(UI.addRowText(row, "●", "Body", d, 1.2, HorizontalAlignment.Center, new vec4(1, 1, 1, this._listening ? 1 : 0.3)))
    this.heardTexts.push(UI.addRowText(row, "", "Body", d, innerW - 1.8, HorizontalAlignment.Left, new vec4(0.6, 0.85, 1, 1)))
  }

  private buildFooter(col: SceneObject, innerW: number, d: number, step: ProfileStep): void {
    const row = UI.flexRow(col, innerW, FOOTER_H, {gap: GAP, justify: FlexJustify.SpaceBetween, align: FlexAlign.Center})
    const n = PROFILE_STEPS.indexOf(step)
    // Names are unique per screen (the allergies and religious screens both have a Next) so tests can find the live one.
    if (n >= 2) this.addFooterButton(row, `BackButton-${step}`, "‹ Back", null, d, () => this.go(PROFILE_STEPS[n - 1]))
    else UI.flexChild(row, {w: FOOT_BTN_W, h: FOOTER_H}, () => {})
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

  private addActionTile(row: SceneObject, name: string, label: string, w: number, d: number, onPinch: () => void): void {
    UI.flexChild(row, {w, h: TILE_H}, (so) => {
      so.name = name
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(w, TILE_H, 1)
      btn.onTriggerUp.add(onPinch)
      UI.addButtonLabel(so, label, w - 0.8, d, "Subheadline")
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

  /** Show the keyboard field (voice: "edit" / "keyboard"); the allergies screen holds it. */
  openEdit(): void {
    if (this._step !== "allergies") this.setStep("allergies")
    this.setEditing(true)
  }
}

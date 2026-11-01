// AllergyLensSharedUI — layout + typography helpers shared by the AllergyLens UI
// modules (/specs-build-ui composition helpers, lifted into one module so the four
// panels stay short). Owns: the Specs type scale, flex composition, row/button text
// and image helpers. Expects no @inputs (plain module). Must not hold product state.

import {FlexLayout} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexLayout"
import {FlexItem} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexItem"
import {
  FlexAlign,
  FlexAlignSelf,
  FlexDirection,
  FlexJustify,
} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"

// ── Typography: single source of truth for text size + weight ──────────────
// Component.Text.size is the em-square height, calibrated for the SnapOS font at
// z = -110 cm. Panels closer than that pass their distance so angular size holds.
export const FONT_SIZE_SCALE = 1.0

export type TextRole =
  | "Title1" | "Title2" | "HeadlineXL" | "Headline1" | "Headline2"
  | "Subheadline" | "Button" | "Callout" | "Body" | "Caption"

export const TYPE_SCALE: Record<TextRole, {size: number; weight: number}> = {
  Title1: {size: 105, weight: 700}, Title2: {size: 93, weight: 700},
  HeadlineXL: {size: 62, weight: 700}, Headline1: {size: 54, weight: 700},
  Headline2: {size: 48, weight: 700}, Subheadline: {size: 41, weight: 700},
  Button: {size: 39, weight: 500}, Callout: {size: 39, weight: 700},
  Body: {size: 39, weight: 500}, Caption: {size: 38, weight: 500},
}

export function roleSize(role: TextRole, distanceCm: number = 110): number {
  return TYPE_SCALE[role].size * FONT_SIZE_SCALE * (distanceCm / 110)
}

export function applyTextRole(t: Text, role: TextRole, distanceCm: number = 110): void {
  t.size = roleSize(role, distanceCm)
  ;(t as Text & {weight?: number}).weight = TYPE_SCALE[role].weight
}

/** Rough glyph advance (cm per character) for a role at a distance — for layoutRect budgeting. */
export function charWidthCm(role: TextRole, distanceCm: number): number {
  const base = TYPE_SCALE[role].size >= 60 ? 0.7 : 0.5
  return base * (distanceCm / 110)
}

// ── Z conventions (local, +Z = toward the viewer) ──────────────────────────
export const CONTENT_Z = 0.6        // content host in front of a BackPlate/Frame face
export const LAYOUT_Z_LIFT = 0.02   // nested layout containers
export const BUTTON_LABEL_Z = 0.08  // anything drawn on a Button face

export const WHITE = new vec4(1, 1, 1, 1)
export const WHITE_SOFT = new vec4(1, 1, 1, 0.7)

const imageMaterial = requireAsset("../Materials/ImageMaterial.mat") as Material

// ── SceneObject helpers ────────────────────────────────────────────────────
export function obj(parent: SceneObject, name: string, position?: vec3): SceneObject {
  const so = global.scene.createSceneObject(name)
  so.setParent(parent)
  if (position) so.getTransform().setLocalPosition(position)
  return so
}

export function liftInZ(so: SceneObject, zOffset: number): void {
  const tr = so.getTransform()
  const p = tr.getLocalPosition()
  tr.setLocalPosition(new vec3(p.x, p.y, p.z + zOffset))
}

/** Register a child's FlexItem with the FlexLayout on `parent` (mandatory — see gotchas). */
export function registerItem(parent: SceneObject, item: FlexItem): void {
  const layout = parent.getComponent(FlexLayout.getTypeName()) as FlexLayout | null
  if (layout) layout.addItems([item])
}

// ── Flex containers ────────────────────────────────────────────────────────
export interface FlexOpts {
  gap?: number
  padX?: number
  padY?: number
  justify?: FlexJustify
  align?: FlexAlign
}

export function makeFlex(parent: SceneObject, direction: FlexDirection, width: number, height: number,
    opts?: FlexOpts): SceneObject {
  const container = obj(parent, direction === FlexDirection.Row ? "Row" : "Column")
  liftInZ(container, LAYOUT_Z_LIFT)
  const flex = container.createComponent(FlexLayout.getTypeName()) as FlexLayout
  // We register every child explicitly via registerItem → addItems. With auto-discovery
  // on, FlexLayout refuses addItems before it initializes, so turn it off up front.
  flex.autoDiscoverItemsOnStart = false
  const item = container.createComponent(FlexItem.getTypeName()) as FlexItem
  if (width > 0) item.overrideWidth = width
  if (height > 0) item.overrideHeight = height
  flex.onInitialized.add(() => {
    flex.width = width
    flex.height = height
    flex.direction = direction
    if (direction === FlexDirection.Row) flex.columnGap = opts?.gap ?? 0
    else flex.rowGap = opts?.gap ?? 0
    flex.paddingTop = opts?.padY ?? 0
    flex.paddingBottom = opts?.padY ?? 0
    flex.paddingLeft = opts?.padX ?? 0
    flex.paddingRight = opts?.padX ?? 0
    flex.justifyContent = opts?.justify ?? FlexJustify.Start
    flex.alignItems = opts?.align ?? FlexAlign.Stretch
  })
  registerItem(parent, item)
  return container
}

export function flexColumn(parent: SceneObject, width: number, height: number, opts?: FlexOpts): SceneObject {
  return makeFlex(parent, FlexDirection.Column, width, height, opts)
}

export function flexRow(parent: SceneObject, width: number, height: number, opts?: FlexOpts): SceneObject {
  return makeFlex(parent, FlexDirection.Row, width, height, opts)
}

/** Add a sized child to a flex container; `builder` fills it. Registers the FlexItem. */
export function flexChild(parent: SceneObject, size: {w?: number; h?: number; grow?: number},
    builder: (child: SceneObject) => void): SceneObject {
  const child = obj(parent, "Item")
  liftInZ(child, LAYOUT_Z_LIFT)
  const item = child.createComponent(FlexItem.getTypeName()) as FlexItem
  if (size.w !== undefined && size.w > 0) item.overrideWidth = size.w
  if (size.h !== undefined && size.h > 0) item.overrideHeight = size.h
  item.flexGrow = size.grow ?? 0
  item.flexShrink = 0
  builder(child)
  registerItem(parent, item)
  return child
}

// ── Text ───────────────────────────────────────────────────────────────────
function baseText(so: SceneObject, text: string, role: TextRole, distanceCm: number,
    align: HorizontalAlignment, color: vec4): Text {
  const t = so.createComponent("Component.Text") as Text
  t.text = text
  t.depthTest = true
  applyTextRole(t, role, distanceCm)
  t.horizontalAlignment = align
  t.verticalAlignment = VerticalAlignment.Center
  t.horizontalOverflow = HorizontalOverflow.Overflow
  t.verticalOverflow = VerticalOverflow.Overflow
  t.textFill.color = color
  return t
}

/** Text row inside a COLUMN container: stretches to the column width so alignment is real. */
export function addColumnText(parent: SceneObject, text: string, role: TextRole, distanceCm: number,
    heightCm: number, align: HorizontalAlignment = HorizontalAlignment.Center, color: vec4 = WHITE): Text {
  const so = obj(parent, "Text")
  const t = baseText(so, text, role, distanceCm, align, color)
  t.layoutRect = Rect.create(-0.5, 0.5, -0.5, 0.5)
  const item = so.createComponent(FlexItem.getTypeName()) as FlexItem
  item.alignSelf = FlexAlignSelf.Stretch
  item.overrideHeight = heightCm
  registerItem(parent, item)
  return t
}

/** Text cell inside a ROW container: needs a real width so neighbours don't overlap glyphs. */
export function addRowText(parent: SceneObject, text: string, role: TextRole, distanceCm: number,
    widthCm: number, align: HorizontalAlignment = HorizontalAlignment.Center, color: vec4 = WHITE): Text {
  const so = obj(parent, "RowText")
  const t = baseText(so, text, role, distanceCm, align, color)
  t.layoutRect = Rect.create(-widthCm / 2, widthCm / 2, -1.2, 1.2)
  const item = so.createComponent(FlexItem.getTypeName()) as FlexItem
  item.overrideWidth = widthCm
  item.overrideHeight = 2.4
  registerItem(parent, item)
  return t
}

/** Label drawn ON a Button face — lifted forward so the face does not occlude the glyphs. */
export function addButtonLabel(buttonSO: SceneObject, text: string, widthCm: number, distanceCm: number,
    role: TextRole = "Button", color: vec4 = WHITE): Text {
  const so = obj(buttonSO, "ButtonLabel", new vec3(0, 0, BUTTON_LABEL_Z))
  const t = baseText(so, text, role, distanceCm, HorizontalAlignment.Center, color)
  t.layoutRect = Rect.create(-widthCm / 2, widthCm / 2, -1.2, 1.2)
  return t
}

// ── Images ─────────────────────────────────────────────────────────────────
/** Icon/thumbnail with its own cloned ImageMaterial (depthTest on, depthWrite off). */
export function addImage(parent: SceneObject, texture: Texture, wCm: number, hCm: number,
    tint: vec4 = WHITE, registerInLayout: boolean = true): Image {
  const so = obj(parent, "Image")
  const img = so.createComponent("Component.Image") as Image
  const mat = imageMaterial.clone()
  mat.mainPass.baseTex = texture
  mat.mainPass.baseColor = tint
  mat.mainPass.depthTest = true
  mat.mainPass.depthWrite = false
  img.clearMaterials()
  img.addMaterial(mat)
  so.getTransform().setLocalScale(new vec3(wCm, hCm, 1))
  if (registerInLayout) {
    const item = so.createComponent(FlexItem.getTypeName()) as FlexItem
    item.overrideWidth = wCm
    item.overrideHeight = hCm
    registerItem(parent, item)
  }
  return img
}

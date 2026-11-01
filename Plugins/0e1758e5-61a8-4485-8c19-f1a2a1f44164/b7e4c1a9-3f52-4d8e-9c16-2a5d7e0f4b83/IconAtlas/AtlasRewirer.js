// Step 2: point the scene at the atlas instead of at individual icon PNGs.
//
// Once nothing references the loose icons, they stop being pulled into the Lens
// build — that, not deletion, is what actually makes the build smaller. Icons in
// Packages/ never shipped anyway, and Assets/Iconography/ is the source library,
// so neither is ever deleted here.
//
// Crop textures are the hinge. A ScreenCropTexture can be assigned as a
// material's baseTex at author time, but its cropRect and inputTexture exist
// only on the runtime RectCropTextureProvider — hence IconAtlasBootstrap.

import { describeIconPath } from './IconUsageScanner.js'

const CROP_DIR = 'IconAtlas/Crops'
const BOOTSTRAP_SCRIPT = 'IconAtlasBootstrap.ts'
const BOOTSTRAP_OBJECT = 'Icon Atlas Bootstrap'

function safeName(text) {
  return String(text).replace(/[^0-9a-zA-Z._-]+/g, '-').replace(/^-+|-+$/g, '') || 'icon'
}

function assetPathOf(value) {
  if (!value) { return null }
  try {
    const meta = value.fileMeta
    if (!meta) { return null }
    const path = meta.assetTreePath
    return path ? path.toString() : null
  } catch (e) {
    return null
  }
}

function findAssetByPathSuffix(assetManager, suffix) {
  for (const asset of assetManager.assets) {
    const path = assetPathOf(asset)
    if (path && path.length >= suffix.length && path.indexOf(suffix, path.length - suffix.length) >= 0) {
      return asset
    }
  }
  return null
}

/**
 * Creates (or reuses) one ScreenCropTexture per atlas frame, in frame order.
 * Returns { crops, created, reused, errors }.
 */
export function createCropTextures(assetManager, frames) {
  const destination = new Editor.Model.SourcePath(
    new Editor.Path(CROP_DIR),
    Editor.Model.SourceRootDirectory.Assets
  )

  // Index what is already there so repeated runs update rather than duplicate.
  const existing = new Map()
  for (const asset of assetManager.assets) {
    const path = assetPathOf(asset)
    if (path && path.indexOf(`Assets/${CROP_DIR}/`) === 0) {
      existing.set(path, asset)
    }
  }

  const crops = []
  const errors = []
  let created = 0
  let reused = 0

  for (const frame of frames) {
    const baseName = `atlas_${safeName(frame.category)}_${safeName(frame.name)}`
    const expectedPath = `Assets/${CROP_DIR}/${baseName}.screenCropTexture`
    const already = existing.get(expectedPath)
    if (already) {
      crops.push(already)
      reused++
      continue
    }
    try {
      const asset = assetManager.createNativeAsset('ScreenCropTexture', baseName, destination)
      crops.push(asset)
      created++
    } catch (e) {
      crops.push(null)
      errors.push(`${frame.category}/${frame.name}: ${e.message}`)
    }
  }

  return { crops: crops, created: created, reused: reused, errors: errors }
}

/**
 * Rewrites every icon reference in the scene to its crop texture.
 *
 * `replacements` maps icon asset path -> crop asset. Returns
 * { changed, skipped, details } where details describes each rewrite.
 */
export function repointReferences(model, replacements) {
  const scene = model.project.scene
  let changed = 0
  const skipped = []
  const details = []

  const replacementFor = (value) => {
    const path = assetPathOf(value)
    if (!path) { return null }
    if (!describeIconPath(path)) { return null }
    return replacements.get(path) || null
  }

  const repointMaterial = (material, label) => {
    if (!material) { return }
    let passes = null
    try { passes = material.passInfos } catch (e) { return }
    if (!passes) { return }
    for (let p = 0; p < passes.length; p++) {
      const pass = passes[p]
      let names = null
      try { names = pass.getPropertyNames() } catch (e) { continue }
      if (!names) { continue }
      for (const propertyName of names) {
        let current = null
        try { current = pass[propertyName] } catch (e) { continue }
        const crop = replacementFor(current)
        if (!crop) { continue }
        try {
          pass[propertyName] = crop
          changed++
          details.push(`${label} · ${propertyName}`)
        } catch (e) {
          skipped.push(`${label} · ${propertyName}: ${e.message}`)
        }
      }
    }
  }

  const repointComponent = (component, objectName) => {
    let typeName = 'Component'
    try { typeName = component.getTypeName() } catch (e) { /* keep default */ }
    const label = `${objectName} › ${typeName}`

    try {
      const count = component.getMaterialsCount ? component.getMaterialsCount() : 0
      for (let i = 0; i < count; i++) {
        repointMaterial(component.getMaterialAt(i), label)
      }
    } catch (e) { /* not a material visual */ }

    let inputNames = null
    try { inputNames = component.inputNames } catch (e) { inputNames = null }
    if (!inputNames) { return }

    for (const inputName of inputNames) {
      let current = null
      try { current = component[inputName] } catch (e) { continue }
      if (!current) { continue }

      if (Array.isArray(current)) {
        let hit = false
        const next = current.map((entry) => {
          const crop = replacementFor(entry)
          if (crop) { hit = true; return crop }
          return entry
        })
        if (!hit) { continue }
        try {
          component[inputName] = next
          changed++
          details.push(`${label}.${inputName} (${next.length} entries)`)
        } catch (e) {
          skipped.push(`${label}.${inputName}: ${e.message}`)
        }
      } else {
        const crop = replacementFor(current)
        if (!crop) { continue }
        try {
          component[inputName] = crop
          changed++
          details.push(`${label}.${inputName}`)
        } catch (e) {
          skipped.push(`${label}.${inputName}: ${e.message}`)
        }
      }
    }
  }

  const walk = (object) => {
    if (!object) { return }
    const name = object.name || '(unnamed)'
    let components = null
    try { components = object.components } catch (e) { components = null }
    if (components) {
      for (const component of components) { repointComponent(component, name) }
    }
    let children = null
    try { children = object.children } catch (e) { children = null }
    if (children) {
      for (const child of children) { walk(child) }
    }
  }

  for (const root of scene.rootSceneObjects) { walk(root) }

  return { changed: changed, skipped: skipped, details: details }
}

/**
 * Ensures a single wired IconAtlasBootstrap exists.
 *
 * The bootstrap script ships with the package and is already compiled, so its
 * inputs are registered and can be written immediately — which is why the grid
 * size is passed as two numbers rather than through a generated manifest.
 */
export function ensureBootstrap(model, atlasAsset, crops, columns, rows) {
  const assetManager = model.project.assetManager
  const scene = model.project.scene

  const scriptAsset = findAssetByPathSuffix(assetManager, BOOTSTRAP_SCRIPT)
  if (!scriptAsset) {
    return { ok: false, message: `${BOOTSTRAP_SCRIPT} not found in the project or its packages.` }
  }

  // Reuse an existing bootstrap component if one is already in the scene.
  let component = null
  const findExisting = (object) => {
    if (component || !object) { return }
    let components = null
    try { components = object.components } catch (e) { components = null }
    if (components) {
      for (const candidate of components) {
        let type = ''
        try { type = candidate.getTypeName() } catch (e) { continue }
        if (type !== 'ScriptComponent') { continue }
        let assigned = null
        try { assigned = candidate.scriptAsset } catch (e) { assigned = null }
        const path = assetPathOf(assigned)
        if (path && path.indexOf(BOOTSTRAP_SCRIPT) >= 0) { component = candidate; return }
      }
    }
    let children = null
    try { children = object.children } catch (e) { children = null }
    if (children) { for (const child of children) { findExisting(child) } }
  }
  for (const root of scene.rootSceneObjects) { findExisting(root) }

  let createdObject = false
  if (!component) {
    try {
      const object = scene.createSceneObject(BOOTSTRAP_OBJECT)
      component = object.addComponent('ScriptComponent')
      component.scriptAsset = scriptAsset
      createdObject = true
    } catch (e) {
      return { ok: false, message: `Could not add the bootstrap component: ${e.message}` }
    }
  }

  const usable = crops.filter((crop) => !!crop)
  try {
    component.atlas = atlasAsset
    component.crops = usable
    component.columns = columns
    component.rows = rows
  } catch (e) {
    return {
      ok: false,
      message:
        `Bootstrap added but its inputs could not be written (${e.message}). ` +
        'If the script was only just compiled, run step 2 again.',
    }
  }

  return {
    ok: true,
    createdObject: createdObject,
    wired: usable.length,
    message: createdObject
      ? `Added "${BOOTSTRAP_OBJECT}" and wired ${usable.length} crops.`
      : `Reused the existing bootstrap and wired ${usable.length} crops.`,
  }
}

// No automatic deletion, deliberately.
//
// An icon is only recognised as an icon by living inside a *.lspkg/ package or
// an Iconography/ folder — and neither may ever be deleted: the package is the
// distributable, and Iconography is the source library. So "find unreferenced
// stray copies and delete them" has no safe definition here; the only way to
// spot a copy would be matching filenames against the library, which would
// happily delete an unrelated heart.png of yours.
//
// It is also unnecessary. What keeps a loose icon in the build is a reference to
// it, so repointing is the whole job. This reports anything still referencing a
// loose icon after step 2 — those are what still ship, and they need a human
// decision, not a delete button.
export function findStillLooseReferences(model, scanFn) {
  const result = scanFn(model)
  return result.icons.map((icon) => ({
    path: icon.path,
    label: `${icon.category}/${icon.name}`,
    sources: icon.sources,
  }))
}

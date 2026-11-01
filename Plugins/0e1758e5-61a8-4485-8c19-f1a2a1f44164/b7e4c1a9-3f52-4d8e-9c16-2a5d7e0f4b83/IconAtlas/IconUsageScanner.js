// Finds which package icons the scene actually references.
//
// Why this matters: assets that live in Packages/ are NOT part of a Lens build,
// but anything referenced from the scene gets pulled in. So the set worth
// atlasing is exactly "icons this scene points at" — not the whole library.
//
// Strict mode by design: only real references count. Three places hold them:
//   1. material pass properties (baseTex and friends) on any visual component
//   2. Texture / Texture[] script inputs on ScriptComponents
//   3. the Image component's own material chain (same as 1)
//
// An icon assigned purely at runtime by name cannot be seen from here — that is
// the documented trade-off of strict scanning.

const ICONOGRAPHY = 'iconography/'
// Any package root, wherever it sits — Assets/Icons.lspkg/… or Packages/Icons.lspkg/…
const PACKAGE_ROOT = /(?:^|\/)[^\/]+\.lspkg\/(.+)$/i

/**
 * Pulls { category, name } out of an icon asset path, or null if not an icon.
 *
 * Layouts in the wild nest these markers — "Assets/Icons.lspkg/Iconography/
 * System/heart.png" contains both — so the DEEPEST "Iconography/" wins. Keying
 * off the first marker instead reports the category as "Iconography" for every
 * icon, which silently collapses the whole library into one group.
 */
export function describeIconPath(path) {
  if (!/\.png$/i.test(path)) { return null }

  let rest = null
  const marker = path.toLowerCase().lastIndexOf(ICONOGRAPHY)
  if (marker >= 0) {
    rest = path.substring(marker + ICONOGRAPHY.length)
  } else {
    const match = PACKAGE_ROOT.exec(path)
    if (!match) { return null }
    rest = match[1]
  }

  rest = rest.replace(/\.png$/i, '')
  const parts = rest.split('/')
  const name = parts[parts.length - 1]
  // Nested folders (System/Scan-qr-code/...) report their top-level category.
  const category = parts.length > 1 ? parts[0] : 'Uncategorised'
  return { category: category, name: name, subPath: rest }
}

function assetPathOf(value) {
  if (!value) { return null }
  try {
    const meta = value.fileMeta
    if (!meta) { return null }
    const path = meta.assetTreePath
    if (!path) { return null }
    return path.toString()
  } catch (e) {
    return null
  }
}

/**
 * Scans the open scene.
 *
 * Returns { icons, scanned, referenceCount } where `icons` is a sorted array of
 * { name, category, subPath, path, asset, sources[] } — one entry per unique
 * icon, with every place it was found listed in `sources`.
 */
export function scanUsedIcons(model) {
  const scene = model.project.scene
  const byPath = new Map()
  let referenceCount = 0
  const stats = { objects: 0, components: 0, materials: 0, scriptInputs: 0 }

  const consider = (value, source) => {
    const path = assetPathOf(value)
    if (!path) { return }
    const described = describeIconPath(path)
    if (!described) { return }
    referenceCount++
    const existing = byPath.get(path)
    if (existing) {
      if (existing.sources.indexOf(source) < 0) { existing.sources.push(source) }
      return
    }
    byPath.set(path, {
      name: described.name,
      category: described.category,
      subPath: described.subPath,
      path: path,
      asset: value,
      sources: [source],
    })
  }

  const scanMaterial = (material, source) => {
    if (!material) { return }
    let passes = null
    try { passes = material.passInfos } catch (e) { return }
    if (!passes) { return }
    stats.materials++
    for (let p = 0; p < passes.length; p++) {
      const pass = passes[p]
      let names = null
      try { names = pass.getPropertyNames() } catch (e) { continue }
      if (!names) { continue }
      for (const propertyName of names) {
        let value = null
        try { value = pass[propertyName] } catch (e) { continue }
        consider(value, source)
      }
    }
  }

  const scanComponent = (component, objectName) => {
    stats.components++
    let typeName = 'Component'
    try { typeName = component.getTypeName() } catch (e) { /* keep default */ }
    const source = `${objectName} › ${typeName}`

    // Visual components expose a material list.
    try {
      const count = component.getMaterialsCount ? component.getMaterialsCount() : 0
      for (let i = 0; i < count; i++) {
        scanMaterial(component.getMaterialAt(i), source)
      }
    } catch (e) { /* not a material visual */ }

    // Script inputs: single Texture and Texture[].
    let inputNames = null
    try { inputNames = component.inputNames } catch (e) { inputNames = null }
    if (inputNames) {
      for (const inputName of inputNames) {
        let value = null
        try { value = component[inputName] } catch (e) { continue }
        if (!value) { continue }
        stats.scriptInputs++
        const label = `${objectName} › ${typeName}.${inputName}`
        if (Array.isArray(value)) {
          for (const entry of value) { consider(entry, label) }
        } else {
          consider(value, label)
        }
      }
    }
  }

  const walk = (object) => {
    if (!object) { return }
    stats.objects++
    const name = object.name || '(unnamed)'

    let components = null
    try { components = object.components } catch (e) { components = null }
    if (components) {
      for (const component of components) { scanComponent(component, name) }
    }

    let children = null
    try { children = object.children } catch (e) { children = null }
    if (children) {
      for (const child of children) { walk(child) }
    }
  }

  for (const root of scene.rootSceneObjects) { walk(root) }

  const icons = Array.from(byPath.values())
  icons.sort((a, b) => {
    if (a.category !== b.category) { return a.category < b.category ? -1 : 1 }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  return { icons: icons, scanned: stats, referenceCount: referenceCount }
}

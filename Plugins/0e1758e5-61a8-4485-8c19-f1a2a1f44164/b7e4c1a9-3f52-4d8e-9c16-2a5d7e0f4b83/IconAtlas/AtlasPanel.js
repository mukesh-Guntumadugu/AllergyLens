import * as Ui from 'LensStudio:Ui'
import * as FileSystem from 'LensStudio:FileSystem'

import { scanUsedIcons } from './IconUsageScanner.js'
import { packAtlas, encodeAtlas, describeCost, fitCellSize, MAX_TEXTURE_SIZE } from './AtlasPacker.js'
import { createCropTextures, repointReferences, ensureBootstrap } from './AtlasRewirer.js'

const OUTPUT_DIR = 'IconAtlas'
const ATLAS_NAME = 'used-icons-atlas'
const CELL_SIZES = [128, 160, 320]

export class AtlasPanel {
  constructor(parentWidget, model) {
    this.model = model
    this.found = []
    this.signals = []
    this.lastPacked = null

    this.widget = new Ui.Widget(parentWidget)
    this.widget.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Expanding)
    this.layout = new Ui.BoxLayout()
    this.layout.setDirection(Ui.Direction.TopToBottom)

    this.buildUI()
    this.widget.layout = this.layout
  }

  getWidget() {
    return this.widget
  }

  buildUI() {
    const intro = new Ui.Label(this.widget)
    intro.text =
      'Packs only the icons this scene actually references into a single atlas ' +
      'in your Asset Browser. Icons left in the package are not part of the Lens build, ' +
      'so the atlas is all that ships.'
    intro.wordWrap = true
    intro.setMinimumWidth(300)
    this.layout.addWidget(intro)

    // Separator takes (orientation, shadow, parent) — not just a parent.
    this.layout.addWidget(
      new Ui.Separator(Ui.Orientation.Horizontal, Ui.Shadow.Sunken, this.widget)
    )

    const resolutionLabel = new Ui.Label(this.widget)
    resolutionLabel.text = 'Icon resolution in the atlas'
    resolutionLabel.fontRole = Ui.FontRole.Small
    this.layout.addWidget(resolutionLabel)

    this.resolutionBox = new Ui.ComboBox(this.widget)
    for (const size of CELL_SIZES) {
      this.resolutionBox.addItem(`${size} px per icon`)
    }
    // 128 is plenty for UI icons and is where most of the saving comes from.
    this.resolutionBox.currentText = '128 px per icon'
    this.layout.addWidget(this.resolutionBox)

    this.scanButton = new Ui.PushButton(this.widget)
    this.scanButton.text = 'Scan scene for used icons'
    this.signals.push(this.scanButton.onClick.connect(() => this.onScan()))
    this.layout.addWidget(this.scanButton)

    this.resultList = new Ui.ListWidget(this.widget)
    this.resultList.setMinimumHeight(180)
    this.layout.addWidgetWithStretch(this.resultList, 1, Ui.Alignment.AlignTop)

    this.generateButton = new Ui.PushButton(this.widget)
    this.generateButton.text = 'Step 1 — Create atlas from used icons'
    this.generateButton.primary = true
    this.generateButton.enabled = false
    this.signals.push(this.generateButton.onClick.connect(() => this.onGenerate()))
    this.layout.addWidget(this.generateButton)

    // Step 2 is what actually shrinks the build: until references move onto the
    // atlas, the loose icons are still pulled in and the atlas is dead weight.
    this.repointButton = new Ui.PushButton(this.widget)
    this.repointButton.text = 'Step 2 — Repoint scene at atlas'
    this.repointButton.enabled = false
    this.signals.push(this.repointButton.onClick.connect(() => this.onRepoint()))
    this.layout.addWidget(this.repointButton)


    this.status = new Ui.Label(this.widget)
    this.status.text = 'Scan the scene to begin.'
    this.status.wordWrap = true
    this.status.fontRole = Ui.FontRole.Small
    this.status.setMinimumWidth(300)
    this.layout.addWidget(this.status)
  }

  selectedCellSize() {
    const text = this.resolutionBox.currentText || ''
    for (const size of CELL_SIZES) {
      if (text.indexOf(String(size)) === 0) { return size }
    }
    return 128
  }

  setStatus(message) {
    this.status.text = message
  }

  addRow(text) {
    // ListWidgetItem's constructor requires its owning ListWidget; addTextItem
    // is the shorthand for a plain text row.
    this.resultList.addTextItem(text)
  }

  // ------------------------------------------------------------------ scan

  onScan() {
    this.resultList.clear()
    this.found = []

    let result
    try {
      result = scanUsedIcons(this.model)
    } catch (e) {
      this.setStatus(`Scan failed: ${e.message}`)
      this.generateButton.enabled = false
      return
    }

    this.found = result.icons
    if (this.found.length === 0) {
      this.addRow('No package icons are referenced by this scene.')
      this.generateButton.enabled = false
      this.setStatus(
        `Looked at ${result.scanned.objects} objects and ${result.scanned.components} ` +
        'components. Assign an icon to a material or a script Texture input, then scan again.'
      )
      return
    }

    for (const icon of this.found) {
      this.addRow(`${icon.category}/${icon.name}  —  ${icon.sources[0]}`)
    }

    const requested = this.selectedCellSize()
    const fitted = fitCellSize(this.found.length, requested)
    const projected =
      (fitted.columns * fitted.cell * fitted.rows * fitted.cell * 4) / (1024 * 1024)

    this.generateButton.enabled = true
    this.setStatus(
      `${this.found.length} icons referenced (${result.referenceCount} references). ` +
      `Atlas will be ${fitted.columns * fitted.cell}x${fitted.rows * fitted.cell}, ` +
      `about ${projected.toFixed(2)} MB uncompressed on GPU.` +
      (fitted.clamped
        ? ` Cell reduced ${requested}→${fitted.cell} px to stay inside Lens Studio's ` +
          `${MAX_TEXTURE_SIZE} px import limit — pick fewer icons for a sharper atlas.`
        : '')
    )
  }

  // -------------------------------------------------------------- generate

  projectRoot() {
    const projectFile = this.model.project.projectFile.toString()
    const cut = projectFile.lastIndexOf('/')
    return cut > 0 ? projectFile.substring(0, cut) : projectFile
  }

  async onGenerate() {
    if (this.found.length === 0) {
      this.setStatus('Nothing to pack — scan first.')
      return
    }

    this.generateButton.enabled = false
    try {
      await this.generateAtlas()
    } catch (e) {
      this.setStatus(`Generate failed: ${e.message}`)
    }
    this.generateButton.enabled = true
  }

  async generateAtlas() {
    const cell = this.selectedCellSize()
    const root = this.projectRoot()

    // Read the source PNGs. assetTreePath is project-relative and already
    // carries its Assets/ or Packages/ prefix, so it appends straight onto root.
    const icons = []
    const unreadable = []
    for (const icon of this.found) {
      const absolute = `${root}/${icon.path}`
      try {
        const bytes = FileSystem.readBytes(new Editor.Path(absolute))
        icons.push({ name: icon.name, category: icon.category, bytes: bytes })
      } catch (e) {
        unreadable.push(`${icon.category}/${icon.name}: ${e.message}`)
      }
    }

    if (icons.length === 0) {
      this.setStatus(`Could not read any icon files. First problem: ${unreadable[0] || 'unknown'}`)
      return
    }

    let packed
    let png
    try {
      packed = packAtlas(icons, cell)
      png = encodeAtlas(packed)
    } catch (e) {
      this.setStatus(`Packing failed: ${e.message}`)
      return
    }

    // Write straight into Assets/ and let the project's file watcher import it.
    // LS 5.23's FileSystem has no getAppCacheFolder and TempDir's constructor is
    // protected, so there is no staging directory to import from; the watcher
    // path is what actually works here.
    const destinationDir = `${root}/Assets/${OUTPUT_DIR}`
    try {
      // CreateDirOptions has a protected constructor — pass a plain object.
      FileSystem.createDir(new Editor.Path(destinationDir), { recursive: true })
    } catch (e) {
      // Already present is fine; a real failure surfaces on the write below.
    }

    const pngPath = `${destinationDir}/${ATLAS_NAME}.png`
    const jsonPath = `${destinationDir}/${ATLAS_NAME}.json`

    try {
      FileSystem.writeFile(new Editor.Path(pngPath), png)
    } catch (e) {
      this.setStatus(`Could not write the atlas: ${e.message}`)
      return
    }

    // Our encoder emits stored (uncompressed) deflate blocks for correctness.
    // Re-saving through Pixmap runs it back out through Qt's real PNG
    // compressor, which shrinks the file on disk without touching the pixels.
    let compressedNote = ''
    try {
      const pixmap = new Ui.Pixmap(new Editor.Path(pngPath))
      if (pixmap.width === packed.width && pixmap.height === packed.height) {
        pixmap.save(new Editor.Path(pngPath))
      } else {
        compressedNote = ' (left uncompressed — Pixmap re-read mismatched)'
      }
    } catch (e) {
      compressedNote = ' (left uncompressed)'
    }

    const manifest = {
      atlas: `Assets/${OUTPUT_DIR}/${ATLAS_NAME}.png`,
      cell: packed.cell,
      columns: packed.columns,
      rows: packed.rows,
      width: packed.width,
      height: packed.height,
      count: packed.frames.length,
      frames: packed.frames.map((frame) => ({
        name: frame.name,
        category: frame.category,
        index: frame.index,
        column: frame.column,
        row: frame.row,
      })),
    }
    try {
      FileSystem.writeFile(new Editor.Path(jsonPath), JSON.stringify(manifest, null, 2) + '\n')
    } catch (e) {
      compressedNote += ` (manifest not written: ${e.message})`
    }

    const importedPath = `Assets/${OUTPUT_DIR}/${ATLAS_NAME}.png`

    // Step 2 needs the frame order and grid size from this pack.
    this.lastPacked = packed
    this.repointButton.enabled = true

    const cost = describeCost(packed)
    this.resultList.clear()
    this.addRow(`Atlas: ${importedPath}`)
    this.addRow(`${packed.frames.length} icons — ${packed.columns}x${packed.rows} grid of ${packed.cell} px`)
    if (packed.clamped) {
      this.addRow(
        `  note: cell reduced ${packed.requestedCell}→${packed.cell} px to stay under ` +
        `the ${MAX_TEXTURE_SIZE} px texture limit`
      )
    }
    for (const frame of packed.frames) {
      this.addRow(`  [${frame.index}] ${frame.category}/${frame.name}  cell ${frame.column},${frame.row}`)
    }
    for (const failure of packed.failures) {
      this.addRow(`  SKIPPED ${failure.category}/${failure.name}: ${failure.reason}`)
    }
    for (const problem of unreadable) {
      this.addRow(`  UNREADABLE ${problem}`)
    }

    const skipped = packed.failures.length + unreadable.length
    this.setStatus(
      `Done — ${cost.label}${compressedNote}.` +
      (skipped > 0 ? ` ${skipped} icon(s) skipped, see the list.` : '') +
      ' The atlas and its manifest are in the Asset Browser under ' + OUTPUT_DIR + '/.'
    )
  }

  // ------------------------------------------------------- step 2: repoint

  findAtlasAsset() {
    const wanted = `Assets/${OUTPUT_DIR}/${ATLAS_NAME}.png`
    for (const asset of this.model.project.assetManager.assets) {
      try {
        const path = asset.fileMeta.assetTreePath.toString()
        if (path === wanted) { return asset }
      } catch (e) { /* not a file asset */ }
    }
    return null
  }

  onRepoint() {
    if (!this.lastPacked || this.lastPacked.frames.length === 0) {
      this.setStatus('Run step 1 first.')
      return
    }

    // The atlas is imported by the project's file watcher, so it may not be
    // registered the instant step 1 finishes.
    const atlasAsset = this.findAtlasAsset()
    if (!atlasAsset) {
      this.setStatus(
        `Atlas file written but not imported yet — give Lens Studio a moment and press step 2 again.`
      )
      return
    }

    this.repointButton.enabled = false
    try {
      this.repointScene(atlasAsset)
    } catch (e) {
      this.setStatus(`Repointing failed: ${e.message}`)
    }
    this.repointButton.enabled = true
  }

  repointScene(atlasAsset) {
    const packed = this.lastPacked
    const assetManager = this.model.project.assetManager

    const cropResult = createCropTextures(assetManager, packed.frames)

    // Frame order and this.found order both come from the same scan, so pair
    // each icon path with the crop that holds its cell.
    const replacements = new Map()
    for (let i = 0; i < packed.frames.length; i++) {
      const crop = cropResult.crops[i]
      if (!crop) { continue }
      const frame = packed.frames[i]
      for (const icon of this.found) {
        if (icon.name === frame.name && icon.category === frame.category) {
          replacements.set(icon.path, crop)
          break
        }
      }
    }

    const repointed = repointReferences(this.model, replacements)
    const bootstrap = ensureBootstrap(
      this.model,
      atlasAsset,
      cropResult.crops,
      packed.columns,
      packed.rows
    )

    // Anything still pointing at a loose icon keeps that icon in the build.
    let stillLoose = []
    try {
      const rescan = scanUsedIcons(this.model)
      stillLoose = rescan.icons
    } catch (e) { /* report what we can */ }

    this.resultList.clear()
    this.addRow(`Crop textures: ${cropResult.created} created, ${cropResult.reused} reused`)
    this.addRow(`References repointed: ${repointed.changed}`)
    this.addRow(bootstrap.message)
    for (const detail of repointed.details) { this.addRow(`  ${detail}`) }
    for (const problem of repointed.skipped) { this.addRow(`  SKIPPED ${problem}`) }
    for (const problem of cropResult.errors) { this.addRow(`  CROP FAILED ${problem}`) }
    if (stillLoose.length > 0) {
      this.addRow(`${stillLoose.length} icon(s) STILL referenced directly — these still ship:`)
      for (const icon of stillLoose) {
        this.addRow(`  ${icon.category}/${icon.name} ← ${icon.sources[0]}`)
      }
    } else {
      this.addRow('No loose icon references remain — only the atlas ships.')
    }

    const parts = [`Repointed ${repointed.changed} reference(s) onto the atlas.`]
    if (!bootstrap.ok) { parts.push(`WARNING: ${bootstrap.message}`) }
    if (stillLoose.length > 0) {
      parts.push(
        `${stillLoose.length} icon(s) are still referenced directly and will still ship — ` +
        'see the list.'
      )
    }
    parts.push('Save the project to keep these changes.')
    this.setStatus(parts.join(' '))
  }

  cleanup() {
    for (const signal of this.signals) {
      try { signal.disconnect() } catch (e) { /* already gone */ }
    }
    this.signals = []
  }
}

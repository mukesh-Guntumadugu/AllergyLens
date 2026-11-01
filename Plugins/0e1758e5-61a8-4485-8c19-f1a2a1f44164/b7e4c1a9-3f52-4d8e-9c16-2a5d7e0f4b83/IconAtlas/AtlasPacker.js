// Grid atlas packing: decode source icons, downscale, composite into one RGBA
// buffer, and report where each icon landed.
//
// Downscaling is alpha-weighted. Icon PNGs are white glyphs on fully
// transparent pixels whose RGB is often 0, so averaging RGB without weighting
// by alpha pulls edge pixels toward black and leaves a dark fringe. Weighting
// each sample by its own alpha keeps edges clean.

import { decodePng, encodePng } from './Png.js'

/**
 * Resamples straight RGBA down to targetSize x targetSize using a box filter.
 * Returns the source buffer untouched when no resize is needed.
 */
export function resampleRgba(rgba, width, height, targetSize) {
  if (width === targetSize && height === targetSize) { return rgba }

  const out = new Uint8Array(targetSize * targetSize * 4)
  const scaleX = width / targetSize
  const scaleY = height / targetSize

  for (let y = 0; y < targetSize; y++) {
    // Cover at least one source row even when scaling up.
    const y0 = Math.floor(y * scaleY)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY))
    for (let x = 0; x < targetSize; x++) {
      const x0 = Math.floor(x * scaleX)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX))

      let alphaSum = 0
      let redSum = 0
      let greenSum = 0
      let blueSum = 0
      let samples = 0

      for (let sy = y0; sy < y1 && sy < height; sy++) {
        for (let sx = x0; sx < x1 && sx < width; sx++) {
          const at = (sy * width + sx) * 4
          const alpha = rgba[at + 3]
          redSum += rgba[at] * alpha
          greenSum += rgba[at + 1] * alpha
          blueSum += rgba[at + 2] * alpha
          alphaSum += alpha
          samples++
        }
      }

      const at = (y * targetSize + x) * 4
      if (samples === 0 || alphaSum === 0) {
        out[at] = 0
        out[at + 1] = 0
        out[at + 2] = 0
        out[at + 3] = 0
      } else {
        out[at] = Math.round(redSum / alphaSum)
        out[at + 1] = Math.round(greenSum / alphaSum)
        out[at + 2] = Math.round(blueSum / alphaSum)
        out[at + 3] = Math.round(alphaSum / samples)
      }
    }
  }
  return out
}

// Lens Studio's texture importer clamps any imported image to this on each
// axis — it logs "Image <name> resized to WxH" and rescales silently. Exceeding
// it costs sharpness for nothing, so the packer shrinks the cell to stay under.
export const MAX_TEXTURE_SIZE = 2048

/** Chooses a near-square column count so the atlas is not a long strip. */
export function chooseColumns(count) {
  if (count <= 1) { return 1 }
  return Math.ceil(Math.sqrt(count))
}

/**
 * Largest cell size that keeps a `count`-icon grid inside MAX_TEXTURE_SIZE.
 * Returns the requested size when it already fits.
 */
export function fitCellSize(count, requestedCell, columnsOverride) {
  const columns = columnsOverride && columnsOverride > 0
    ? columnsOverride
    : chooseColumns(count)
  const rows = Math.ceil(count / columns)
  const longestAxis = Math.max(columns, rows)
  const maxCell = Math.floor(MAX_TEXTURE_SIZE / longestAxis)
  if (maxCell < 1) { return { cell: 1, clamped: true, columns: columns, rows: rows } }
  if (requestedCell <= maxCell) {
    return { cell: requestedCell, clamped: false, columns: columns, rows: rows }
  }
  return { cell: maxCell, clamped: true, columns: columns, rows: rows }
}

/**
 * Packs icons into a grid atlas.
 *
 * `icons` is [{ name, category, bytes }]. Returns
 * { width, height, columns, rows, cell, rgba, frames, failures } where each
 * frame carries the flat index, grid cell and normalised UV rect.
 */
export function packAtlas(icons, requestedCellSize, columnsOverride) {
  // Shrink the cell up front if the grid would exceed the importer's 2048 cap —
  // otherwise Lens Studio rescales the whole atlas on import and we lose
  // sharpness we never needed to spend.
  const fitted = fitCellSize(icons.length, requestedCellSize, columnsOverride)
  const cellSize = fitted.cell

  const decoded = []
  const failures = []

  for (const icon of icons) {
    try {
      const image = decodePng(icon.bytes)
      decoded.push({
        name: icon.name,
        category: icon.category,
        rgba: resampleRgba(image.rgba, image.width, image.height, cellSize),
      })
    } catch (e) {
      failures.push({ name: icon.name, category: icon.category, reason: e.message })
    }
  }

  if (decoded.length === 0) {
    return {
      width: 0, height: 0, columns: 0, rows: 0, cell: cellSize,
      requestedCell: requestedCellSize, clamped: fitted.clamped,
      rgba: new Uint8Array(0), frames: [], failures: failures,
    }
  }

  const columns = columnsOverride && columnsOverride > 0
    ? columnsOverride
    : chooseColumns(decoded.length)
  const rows = Math.ceil(decoded.length / columns)
  const width = columns * cellSize
  const height = rows * cellSize
  const atlas = new Uint8Array(width * height * 4)
  const frames = []

  for (let index = 0; index < decoded.length; index++) {
    const entry = decoded[index]
    const column = index % columns
    const row = Math.floor(index / columns)
    const originX = column * cellSize
    const originY = row * cellSize

    for (let y = 0; y < cellSize; y++) {
      const sourceStart = y * cellSize * 4
      const destStart = ((originY + y) * width + originX) * 4
      atlas.set(entry.rgba.subarray(sourceStart, sourceStart + cellSize * 4), destStart)
    }

    frames.push({
      name: entry.name,
      category: entry.category,
      index: index,
      column: column,
      row: row,
      // Normalised, origin top-left — the runtime converts to the crop rect.
      uv: {
        left: column / columns,
        right: (column + 1) / columns,
        top: row / rows,
        bottom: (row + 1) / rows,
      },
    })
  }

  return {
    width: width,
    height: height,
    columns: columns,
    rows: rows,
    cell: cellSize,
    requestedCell: requestedCellSize,
    clamped: fitted.clamped,
    rgba: atlas,
    frames: frames,
    failures: failures,
  }
}

/** Encodes a packed atlas to PNG bytes. */
export function encodeAtlas(packed) {
  return encodePng(packed.width, packed.height, packed.rgba)
}

/** Uncompressed GPU cost of the packed atlas, for reporting in the panel. */
export function describeCost(packed) {
  const bytes = packed.width * packed.height * 4
  return {
    bytes: bytes,
    megabytes: bytes / (1024 * 1024),
    label: `${packed.width}x${packed.height} — ${(bytes / (1024 * 1024)).toFixed(2)} MB on GPU`,
  }
}

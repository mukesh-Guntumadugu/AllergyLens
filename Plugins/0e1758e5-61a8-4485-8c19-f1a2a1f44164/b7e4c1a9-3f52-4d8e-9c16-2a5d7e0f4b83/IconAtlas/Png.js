// PNG decode / encode in pure JS.
//
// Lens Studio plugins have no image compositing API: Ui.Pixmap can load, crop,
// resize and save but cannot draw one image into another, and LensStudio:Shell
// only exposes openUrl/showItemInFolder, so an external packer cannot be run.
// FileSystem.readBytes/writeFile do give us raw bytes, so the atlas is built by
// decoding the source PNGs here, compositing into a buffer, and re-encoding.
//
// Scope is deliberately narrow — what the Figma icon export actually produces:
// 8-bit non-interlaced PNG, colour type 6 (RGBA), 2 (RGB), 4 (grey+alpha) or
// 0 (grey). Anything else throws with a clear message rather than guessing.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// ---------------------------------------------------------------- checksums

let crcTable = null

function crc32(bytes, start, end) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = start; i < end; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function adler32(bytes) {
  let a = 1
  let b = 0
  // 5552 is the largest run that cannot overflow a 32-bit accumulator.
  for (let i = 0; i < bytes.length; ) {
    const chunk = Math.min(i + 5552, bytes.length)
    for (; i < chunk; i++) {
      a += bytes[i]
      b += a
    }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}

// ------------------------------------------------------------------ inflate

class BitReader {
  constructor(bytes, offset) {
    this.bytes = bytes
    this.pos = offset
    this.bit = 0
    this.acc = 0
  }

  readBit() {
    if (this.bit === 0) {
      if (this.pos >= this.bytes.length) {
        throw new Error('PNG: truncated deflate stream')
      }
      this.acc = this.bytes[this.pos++]
      this.bit = 8
    }
    const value = this.acc & 1
    this.acc >>= 1
    this.bit--
    return value
  }

  readBits(count) {
    let value = 0
    for (let i = 0; i < count; i++) {
      value |= this.readBit() << i
    }
    return value
  }

  alignToByte() {
    this.bit = 0
  }
}

/** Canonical Huffman decoder built from a list of code lengths. */
class Huffman {
  constructor(lengths) {
    let maxLength = 0
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] > maxLength) { maxLength = lengths[i] }
    }

    const countPerLength = new Int32Array(maxLength + 1)
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] > 0) { countPerLength[lengths[i]]++ }
    }

    const firstCodeOfLength = new Int32Array(maxLength + 2)
    let code = 0
    for (let len = 1; len <= maxLength; len++) {
      code = (code + countPerLength[len - 1]) << 1
      firstCodeOfLength[len] = code
    }

    this.maxLength = maxLength
    this.counts = countPerLength
    this.firstCodes = firstCodeOfLength
    // Symbols sorted by (length, symbol) — the canonical ordering.
    this.symbols = []
    const nextIndex = new Int32Array(maxLength + 2)
    let offset = 0
    for (let len = 1; len <= maxLength; len++) {
      nextIndex[len] = offset
      offset += countPerLength[len]
    }
    this.symbols.length = offset
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      const len = lengths[symbol]
      if (len > 0) { this.symbols[nextIndex[len]++] = symbol }
    }
  }

  decode(reader) {
    let code = 0
    let firstIndex = 0
    for (let len = 1; len <= this.maxLength; len++) {
      code = (code << 1) | reader.readBit()
      const count = this.counts[len]
      const relative = code - this.firstCodes[len]
      if (relative < count) {
        return this.symbols[firstIndex + relative]
      }
      firstIndex += count
    }
    throw new Error('PNG: invalid Huffman code')
  }
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

let fixedLiteralTree = null
let fixedDistanceTree = null

function buildFixedTrees() {
  if (fixedLiteralTree) { return }
  const literalLengths = new Int32Array(288)
  for (let i = 0; i < 144; i++) { literalLengths[i] = 8 }
  for (let i = 144; i < 256; i++) { literalLengths[i] = 9 }
  for (let i = 256; i < 280; i++) { literalLengths[i] = 7 }
  for (let i = 280; i < 288; i++) { literalLengths[i] = 8 }
  fixedLiteralTree = new Huffman(literalLengths)
  const distanceLengths = new Int32Array(30)
  for (let i = 0; i < 30; i++) { distanceLengths[i] = 5 }
  fixedDistanceTree = new Huffman(distanceLengths)
}

/** Raw DEFLATE (RFC 1951) decoder. `expectedSize` pre-sizes the output. */
export function inflateRaw(bytes, offset, expectedSize) {
  const reader = new BitReader(bytes, offset)
  let out = new Uint8Array(expectedSize > 0 ? expectedSize : 1024)
  let length = 0

  const ensure = (extra) => {
    if (length + extra <= out.length) { return }
    let size = out.length * 2
    while (size < length + extra) { size *= 2 }
    const grown = new Uint8Array(size)
    grown.set(out.subarray(0, length))
    out = grown
  }

  for (;;) {
    const isFinal = reader.readBit()
    const type = reader.readBits(2)

    if (type === 0) {
      // Stored: byte-aligned literal run.
      reader.alignToByte()
      if (reader.pos + 4 > bytes.length) {
        throw new Error('PNG: truncated stored block')
      }
      const len = bytes[reader.pos] | (bytes[reader.pos + 1] << 8)
      reader.pos += 4 // skip LEN and its complement NLEN
      ensure(len)
      out.set(bytes.subarray(reader.pos, reader.pos + len), length)
      length += len
      reader.pos += len
    } else if (type === 1 || type === 2) {
      let literalTree
      let distanceTree
      if (type === 1) {
        buildFixedTrees()
        literalTree = fixedLiteralTree
        distanceTree = fixedDistanceTree
      } else {
        const literalCount = reader.readBits(5) + 257
        const distanceCount = reader.readBits(5) + 1
        const codeLengthCount = reader.readBits(4) + 4

        const codeLengthLengths = new Int32Array(19)
        for (let i = 0; i < codeLengthCount; i++) {
          codeLengthLengths[CODE_LENGTH_ORDER[i]] = reader.readBits(3)
        }
        const codeLengthTree = new Huffman(codeLengthLengths)

        const lengths = new Int32Array(literalCount + distanceCount)
        for (let i = 0; i < lengths.length; ) {
          const symbol = codeLengthTree.decode(reader)
          if (symbol < 16) {
            lengths[i++] = symbol
          } else if (symbol === 16) {
            if (i === 0) { throw new Error('PNG: repeat with no previous length') }
            const previous = lengths[i - 1]
            const repeat = reader.readBits(2) + 3
            for (let r = 0; r < repeat; r++) { lengths[i++] = previous }
          } else if (symbol === 17) {
            i += reader.readBits(3) + 3
          } else {
            i += reader.readBits(7) + 11
          }
        }
        literalTree = new Huffman(lengths.subarray(0, literalCount))
        distanceTree = new Huffman(lengths.subarray(literalCount))
      }

      for (;;) {
        const symbol = literalTree.decode(reader)
        if (symbol === 256) { break }
        if (symbol < 256) {
          ensure(1)
          out[length++] = symbol
        } else {
          const lengthIndex = symbol - 257
          if (lengthIndex >= LENGTH_BASE.length) {
            throw new Error('PNG: invalid length symbol ' + symbol)
          }
          const copyLength = LENGTH_BASE[lengthIndex] + reader.readBits(LENGTH_EXTRA[lengthIndex])
          const distanceSymbol = distanceTree.decode(reader)
          const distance = DIST_BASE[distanceSymbol] + reader.readBits(DIST_EXTRA[distanceSymbol])
          if (distance > length) {
            throw new Error('PNG: back-reference before start of stream')
          }
          ensure(copyLength)
          let from = length - distance
          for (let i = 0; i < copyLength; i++) {
            out[length++] = out[from++]
          }
        }
      }
    } else {
      throw new Error('PNG: reserved deflate block type')
    }

    if (isFinal) { break }
  }

  return out.subarray(0, length)
}

// ------------------------------------------------------------------- decode

function readUint32(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) { return a }
  return pb <= pc ? b : c
}

/**
 * Decodes a PNG to straight (non-premultiplied) RGBA.
 * Returns { width, height, rgba: Uint8Array }.
 */
export function decodePng(bytes) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) { throw new Error('not a PNG file') }
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idatParts = []
  let idatTotal = 0
  let palette = null
  let paletteAlpha = null

  let offset = 8
  while (offset + 8 <= bytes.length) {
    const dataLength = readUint32(bytes, offset)
    const type =
      String.fromCharCode(bytes[offset + 4]) +
      String.fromCharCode(bytes[offset + 5]) +
      String.fromCharCode(bytes[offset + 6]) +
      String.fromCharCode(bytes[offset + 7])
    const dataStart = offset + 8

    if (type === 'IHDR') {
      width = readUint32(bytes, dataStart)
      height = readUint32(bytes, dataStart + 4)
      bitDepth = bytes[dataStart + 8]
      colorType = bytes[dataStart + 9]
      interlace = bytes[dataStart + 12]
    } else if (type === 'PLTE') {
      palette = bytes.subarray(dataStart, dataStart + dataLength)
    } else if (type === 'tRNS' && colorType === 3) {
      paletteAlpha = bytes.subarray(dataStart, dataStart + dataLength)
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(dataStart, dataStart + dataLength))
      idatTotal += dataLength
    } else if (type === 'IEND') {
      break
    }

    offset = dataStart + dataLength + 4 // + CRC
  }

  if (width === 0 || height === 0) { throw new Error('PNG: missing IHDR') }
  if (bitDepth !== 8) {
    throw new Error(`PNG: unsupported bit depth ${bitDepth} (only 8 is supported)`)
  }
  if (interlace !== 0) { throw new Error('PNG: interlaced images are not supported') }
  if (idatTotal === 0) { throw new Error('PNG: no image data') }

  const channelCount = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channelCount) { throw new Error(`PNG: unsupported colour type ${colorType}`) }
  if (colorType === 3 && !palette) { throw new Error('PNG: indexed image without PLTE') }

  let compressed
  if (idatParts.length === 1) {
    compressed = idatParts[0]
  } else {
    compressed = new Uint8Array(idatTotal)
    let at = 0
    for (const part of idatParts) {
      compressed.set(part, at)
      at += part.length
    }
  }

  // zlib wrapper: 2-byte header, then the deflate stream (Adler-32 trails it).
  const stride = width * channelCount
  const raw = inflateRaw(compressed, 2, (stride + 1) * height)
  if (raw.length < (stride + 1) * height) {
    throw new Error('PNG: decompressed data is short')
  }

  // Undo per-scanline filtering in place.
  const pixelBytes = channelCount
  const lines = new Uint8Array(stride * height)
  let previousLine = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const source = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const line = lines.subarray(y * stride, (y + 1) * stride)
    line.set(source)

    if (filter === 1) {
      for (let i = pixelBytes; i < stride; i++) {
        line[i] = (line[i] + line[i - pixelBytes]) & 0xff
      }
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) {
        line[i] = (line[i] + previousLine[i]) & 0xff
      }
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= pixelBytes ? line[i - pixelBytes] : 0
        line[i] = (line[i] + ((left + previousLine[i]) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= pixelBytes ? line[i - pixelBytes] : 0
        const upLeft = i >= pixelBytes ? previousLine[i - pixelBytes] : 0
        line[i] = (line[i] + paeth(left, previousLine[i], upLeft)) & 0xff
      }
    } else if (filter !== 0) {
      throw new Error(`PNG: unknown filter type ${filter} on row ${y}`)
    }
    previousLine = line
  }

  // Expand whatever colour type we got into RGBA.
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, pixels = width * height; i < pixels; i++) {
    const out = i * 4
    if (colorType === 6) {
      rgba[out] = lines[i * 4]
      rgba[out + 1] = lines[i * 4 + 1]
      rgba[out + 2] = lines[i * 4 + 2]
      rgba[out + 3] = lines[i * 4 + 3]
    } else if (colorType === 2) {
      rgba[out] = lines[i * 3]
      rgba[out + 1] = lines[i * 3 + 1]
      rgba[out + 2] = lines[i * 3 + 2]
      rgba[out + 3] = 255
    } else if (colorType === 4) {
      const grey = lines[i * 2]
      rgba[out] = grey
      rgba[out + 1] = grey
      rgba[out + 2] = grey
      rgba[out + 3] = lines[i * 2 + 1]
    } else if (colorType === 0) {
      const grey = lines[i]
      rgba[out] = grey
      rgba[out + 1] = grey
      rgba[out + 2] = grey
      rgba[out + 3] = 255
    } else {
      const index = lines[i] * 3
      rgba[out] = palette[index]
      rgba[out + 1] = palette[index + 1]
      rgba[out + 2] = palette[index + 2]
      rgba[out + 3] = paletteAlpha && lines[i] < paletteAlpha.length ? paletteAlpha[lines[i]] : 255
    }
  }

  return { width: width, height: height, rgba: rgba }
}

// ------------------------------------------------------------------- encode

function writeChunk(parts, type, data) {
  const chunk = new Uint8Array(12 + data.length)
  chunk[0] = (data.length >>> 24) & 0xff
  chunk[1] = (data.length >>> 16) & 0xff
  chunk[2] = (data.length >>> 8) & 0xff
  chunk[3] = data.length & 0xff
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i)
  }
  chunk.set(data, 8)
  // CRC covers the type and the data, not the length.
  const crc = crc32(chunk, 4, 8 + data.length)
  chunk[8 + data.length] = (crc >>> 24) & 0xff
  chunk[9 + data.length] = (crc >>> 16) & 0xff
  chunk[10 + data.length] = (crc >>> 8) & 0xff
  chunk[11 + data.length] = crc & 0xff
  parts.push(chunk)
}

/**
 * Encodes straight RGBA as a PNG.
 *
 * The deflate stream uses stored (uncompressed) blocks — correctness over
 * ratio, since implementing a full compressor here is not worth it. The caller
 * re-saves the file through Ui.Pixmap afterwards, which re-encodes it with
 * Qt's real PNG compressor, so the file that lands in the project is compact.
 */
export function encodePng(width, height, rgba) {
  const parts = []
  parts.push(new Uint8Array(SIGNATURE))

  const header = new Uint8Array(13)
  header[0] = (width >>> 24) & 0xff
  header[1] = (width >>> 16) & 0xff
  header[2] = (width >>> 8) & 0xff
  header[3] = width & 0xff
  header[4] = (height >>> 24) & 0xff
  header[5] = (height >>> 16) & 0xff
  header[6] = (height >>> 8) & 0xff
  header[7] = height & 0xff
  header[8] = 8 // bit depth
  header[9] = 6 // colour type RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0
  writeChunk(parts, 'IHDR', header)

  // Filter byte 0 (None) in front of every scanline.
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const MAX_BLOCK = 65535
  const blockCount = Math.max(1, Math.ceil(raw.length / MAX_BLOCK))
  const zlib = new Uint8Array(2 + blockCount * 5 + raw.length + 4)
  let at = 0
  zlib[at++] = 0x78 // CMF: deflate, 32K window
  zlib[at++] = 0x01 // FLG: no dictionary, fastest
  for (let block = 0; block < blockCount; block++) {
    const start = block * MAX_BLOCK
    const size = Math.min(MAX_BLOCK, raw.length - start)
    zlib[at++] = block === blockCount - 1 ? 1 : 0 // BFINAL, BTYPE=00 stored
    zlib[at++] = size & 0xff
    zlib[at++] = (size >>> 8) & 0xff
    zlib[at++] = ~size & 0xff
    zlib[at++] = (~size >>> 8) & 0xff
    zlib.set(raw.subarray(start, start + size), at)
    at += size
  }
  const checksum = adler32(raw)
  zlib[at++] = (checksum >>> 24) & 0xff
  zlib[at++] = (checksum >>> 16) & 0xff
  zlib[at++] = (checksum >>> 8) & 0xff
  zlib[at++] = checksum & 0xff
  writeChunk(parts, 'IDAT', zlib.subarray(0, at))

  writeChunk(parts, 'IEND', new Uint8Array(0))

  let total = 0
  for (const part of parts) { total += part.length }
  const file = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    file.set(part, cursor)
    cursor += part.length
  }
  return file
}

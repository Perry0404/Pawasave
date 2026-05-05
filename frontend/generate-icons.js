// Generate minimal valid PNG icons for PWA manifest
// Run: node generate-icons.js
// Uses only built-in Node.js modules (no external deps)

const { deflateSync } = require('zlib')
const fs = require('fs')
const path = require('path')

let crcTable

function makeCrcTable() {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    crcTable[n] = c
  }
  return crcTable
}

function crc32(buf) {
  let crc = 0xffffffff
  const table = makeCrcTable()
  for (const byte of buf) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBytes, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf])
}

function createPng(width, height, r, g, b) {
  // Raw image: for each scanline: 1 filter byte (None=0) + width*3 RGB bytes
  const rowBytes = width * 3
  const raw = Buffer.alloc((1 + rowBytes) * height)
  for (let y = 0; y < height; y++) {
    const base = y * (1 + rowBytes)
    raw[base] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      raw[base + 1 + x * 3 + 0] = r
      raw[base + 1 + x * 3 + 1] = g
      raw[base + 1 + x * 3 + 2] = b
    }
  }

  const compressed = deflateSync(raw, { level: 6 })

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 2  // colour type: RGB
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter: adaptive
  ihdr[12] = 0 // interlace: none

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', compressed),
    writeChunk('IEND', Buffer.alloc(0)),
  ])
}

// Emerald #059669 → R=5, G=150, B=105
const r = 5, g = 150, b = 105

const outDir = path.join(__dirname, 'public')

fs.writeFileSync(path.join(outDir, 'icon-192.png'), createPng(192, 192, r, g, b))
fs.writeFileSync(path.join(outDir, 'icon-512.png'), createPng(512, 512, r, g, b))

console.log('✅  icon-192.png and icon-512.png written to public/')

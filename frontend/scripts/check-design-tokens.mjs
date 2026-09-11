/**
 * Fails if the design system references a CSS variable it never defines.
 *
 * This exists because two Critical rendering bugs shipped exactly that way. The Ajo
 * invite code referenced two tokens that did not exist, so their fallbacks painted a
 * near-black panel while the text colour resolved to near-black too, and the code was
 * invisible in light mode. A grep would have caught it at author time.
 *
 * Run: node scripts/check-design-tokens.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CSS = 'src/app/globals.css'

// Defined outside our stylesheet and legitimately referenced by name.
const EXTERNAL = new Set([
  'font-inter',        // injected by next/font via the body class
  'tw-gradient-stops', // Tailwind internals
])

/** Recursive walk. node:fs globSync is Node 22+ and CI runs 20. */
function walk(dir, ext, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, ext, out)
    else if (e.name.endsWith(ext)) out.push(p)
  }
  return out
}

/**
 * Comments legitimately name tokens, so don't scan them. Newlines are preserved so
 * reported line numbers still point at the real thing.
 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const lineOf = (s, i) => s.slice(0, i).split('\n').length

const css = stripComments(readFileSync(CSS, 'utf8'))

const defined = new Set(
  [...css.matchAll(/(?<![\w-])--([a-z0-9-]+)\s*:/g)].map((m) => m[1]),
)

const missing = []
const seen = new Set()

function scan(src, label) {
  for (const m of src.matchAll(/var\(\s*--([a-z0-9-]+)/g)) {
    const name = m[1]
    seen.add(name)
    if (defined.has(name) || EXTERNAL.has(name)) continue
    const key = `${name}@${label}`
    if (missing.some((x) => x.key === key)) continue
    missing.push({ key, name, where: `${label}:${lineOf(src, m.index)}` })
  }
}

scan(css, CSS)
for (const file of walk('src', '.tsx')) {
  scan(stripComments(readFileSync(file, 'utf8')), file)
}

if (missing.length) {
  console.error('\n  Undefined CSS variables:\n')
  for (const { name, where } of missing) console.error(`    --${name}  ${where}`)
  console.error(
    '\n  Define it in the .ps token block, or use an existing token.\n' +
      '  A var() with a fallback still counts: the fallback wins silently and hides the bug.\n',
  )
  process.exit(1)
}

console.log(`  ✓ ${seen.size} CSS variables referenced, all defined`)

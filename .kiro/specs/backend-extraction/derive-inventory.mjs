#!/usr/bin/env node
/**
 * Derives the complete server-side inventory from a git branch without checking it out.
 *
 * The extraction must not miss a single route, lib module or env var, and a hand-written
 * list would. This reads every file straight out of the git object store and emits both
 * JSON (for tooling) and Markdown (for the spec).
 *
 * Usage: node derive-inventory.mjs [branch]
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRANCH = process.argv[2] || 'audit-v2-remediation-and-flint-onramp'
const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(OUT_DIR, '../../..')

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const show = (path) => {
  try {
    return git('show', `${BRANCH}:${path}`)
  } catch {
    return null
  }
}

const listFiles = (glob) =>
  git('ls-tree', '-r', '--name-only', BRANCH, '--', glob).split('\n').filter(Boolean)

const uniq = (xs) => [...new Set(xs)].sort()
const matchAll = (src, re) => uniq([...src.matchAll(re)].map((m) => m[1]))

// Signal detection must run on code, not prose. `notifications.ts` mentions
// VAPID_PRIVATE_KEY in a header comment and was misread as server-only without this.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

// ── analysis helpers ─────────────────────────────────────────────────────────

const ENV_RE = /process\.env\.([A-Z0-9_]+)/g
const ENV_BRACKET_RE = /process\.env\[['"]([A-Z0-9_]+)['"]\]/g
const LIB_IMPORT_RE = /from\s+['"](?:@\/lib\/|\.\.?\/(?:\.\.\/)*lib\/|\.\/)([a-z0-9-]+(?:\/[a-z0-9-]+)?)['"]/g
const PKG_IMPORT_RE = /from\s+['"]([a-z@][^'"]*)['"]/g

/** Which auth gate protects a route. Order matters: the first match wins. */
function classifyAuth(src) {
  const kinds = []
  if (/checkCronAuth|CRON_SECRET/.test(src)) kinds.push('cron-secret')
  if (/isAuthorisedAdmin|verifyAdminToken/.test(src)) kinds.push('admin-session')
  if (/createServerClient|getSupabaseUser/.test(src)) kinds.push('user-jwt-cookie')
  if (/verifyXendWebhook|timingSafeEqual|createHmac|createVerify/.test(src)) kinds.push('webhook-signature')
  if (/WEBHOOK_TOKEN/.test(src)) kinds.push('webhook-query-token')
  if (/SERVICE_ROLE_KEY/.test(src)) kinds.push('service-role')
  return kinds.length ? kinds : ['NONE']
}

function nextPrimitives(src) {
  const p = []
  if (/NextRequest/.test(src)) p.push('NextRequest')
  if (/NextResponse\.json/.test(src)) p.push('NextResponse.json')
  if (/NextResponse\.redirect/.test(src)) p.push('NextResponse.redirect')
  if (/NextResponse\.next/.test(src)) p.push('NextResponse.next')
  if (/\bcookies\(\)/.test(src)) p.push('cookies()')
  if (/\bheaders\(\)/.test(src)) p.push('headers()')
  if (/revalidate(Path|Tag)/.test(src)) p.push('revalidate')
  if (/request\.cookies/.test(src)) p.push('request.cookies')
  if (/\.nextUrl/.test(src)) p.push('nextUrl')
  return p
}

function segmentConfig(src) {
  const cfg = {}
  const dyn = src.match(/export\s+const\s+dynamic\s*=\s*['"]([^'"]+)['"]/)
  if (dyn) cfg.dynamic = dyn[1]
  const dur = src.match(/export\s+const\s+maxDuration\s*=\s*(\d+)/)
  if (dur) cfg.maxDuration = Number(dur[1])
  const run = src.match(/export\s+const\s+runtime\s*=\s*['"]([^'"]+)['"]/)
  if (run) cfg.runtime = run[1]
  return cfg
}

// secrets.ts resolves these via `process.env[name]` with a runtime string, so a
// process.env.X scan cannot see them. Catch the getSecret('NAME') call sites instead,
// or the deposit mnemonic and every operational private key go missing from the contract.
const GET_SECRET_RE = /getSecret\(\s*['"]([A-Z0-9_]+)['"]/g

function envVars(src) {
  return uniq([
    ...matchAll(src, ENV_RE),
    ...matchAll(src, ENV_BRACKET_RE),
    ...matchAll(src, GET_SECRET_RE),
  ])
}

function libImports(src) {
  return matchAll(src, LIB_IMPORT_RE)
}

function externalPackages(src) {
  return matchAll(src, PKG_IMPORT_RE).filter((p) => !p.startsWith('@/') && !p.startsWith('.'))
}

// ── routes ───────────────────────────────────────────────────────────────────

const routeFiles = listFiles('frontend/src/app').filter((f) => /\/route\.ts$/.test(f))

const routes = routeFiles.map((file) => {
  const src = show(file) || ''
  const url = file.replace('frontend/src/app', '').replace(/\/route\.ts$/, '') || '/'
  return {
    url,
    file,
    lines: src.split('\n').length,
    methods: uniq(
      [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/g)].map(
        (m) => m[1],
      ),
    ),
    auth: classifyAuth(src),
    libs: libImports(src),
    packages: externalPackages(src),
    env: envVars(src),
    nextPrimitives: nextPrimitives(src),
    segmentConfig: segmentConfig(src),
    rpcs: matchAll(src, /\.rpc\(\s*['"]([a-z0-9_]+)['"]/g),
    tables: matchAll(src, /\.from\(\s*['"]([a-z0-9_]+)['"]/g),
  }
})

// ── lib modules ──────────────────────────────────────────────────────────────

const libFiles = listFiles('frontend/src/lib').filter((f) => /\.tsx?$/.test(f))

// Build the importer graph so each lib can be proven server-only or client-reachable.
const allSourceFiles = listFiles('frontend/src').filter((f) => /\.tsx?$/.test(f))
const sources = new Map(allSourceFiles.map((f) => [f, show(f) || '']))

function isClientFile(file, src) {
  if (/^frontend\/src\/app\/api\//.test(file)) return false
  if (/^frontend\/src\/middleware\.ts$/.test(file)) return false
  if (/\/route\.ts$/.test(file)) return false
  return /^['"]use client['"]/m.test(src) || /^frontend\/src\/(components|hooks)\//.test(file)
}

const libs = libFiles.map((file) => {
  const src = show(file) || ''
  const code = stripComments(src)
  const name = file.replace('frontend/src/lib/', '').replace(/\.tsx?$/, '')
  const importers = allSourceFiles.filter((f) => {
    if (f === file) return false
    const s = sources.get(f) || ''
    return new RegExp(`from\\s+['"]@/lib/${name.replace(/\//g, '\\/')}['"]`).test(s)
  })
  const clientImporters = importers.filter((f) => isClientFile(f, sources.get(f) || ''))
  const serverImporters = importers.filter((f) => !isClientFile(f, sources.get(f) || ''))

  const declaresUseClient = /^['"]use client['"]/m.test(code)
  const usesNextServer = /from\s+['"]next\/server['"]/.test(code)
  const usesNodeBuiltins = /from\s+['"](?:node:)?(?:crypto|fs|path|os|child_process)['"]/.test(code)
  const usesSecrets = /getSecret|SERVICE_ROLE_KEY|PRIVATE_KEY|MNEMONIC/.test(code)
  // Browser-only globals are decisive: these cannot run in Node.
  const usesBrowserGlobals = /\b(?:localStorage|sessionStorage|navigator|atob|Notification|window)\b/.test(code)

  // Dead code first: nothing imports it, so it needs a delete decision, not a home.
  let classification
  if (!importers.length) classification = 'UNUSED'
  else if (declaresUseClient || (usesBrowserGlobals && !serverImporters.length)) classification = 'client-only'
  else if (usesSecrets || usesNodeBuiltins || usesNextServer) {
    classification = clientImporters.length ? 'MIXED — needs splitting' : 'server-only'
  } else if (clientImporters.length && serverImporters.length) classification = 'shared'
  else if (clientImporters.length) classification = 'client-only'
  else classification = 'server-only'

  return {
    name,
    file,
    lines: src.split('\n').length,
    classification,
    env: envVars(src),
    packages: externalPackages(src),
    localImports: libImports(src),
    clientImporters,
    serverImporters,
    signals: { declaresUseClient, usesNextServer, usesNodeBuiltins, usesSecrets, usesBrowserGlobals },
  }
})

// ── browser-side direct Postgres access (the second backend) ─────────────────

const browserDbFiles = allSourceFiles
  .filter((f) => isClientFile(f, sources.get(f) || ''))
  .map((f) => {
    const src = sources.get(f) || ''
    return {
      file: f,
      rpcs: matchAll(src, /\.rpc\(\s*['"]([a-z0-9_]+)['"]/g),
      tables: matchAll(src, /\.from\(\s*['"]([a-z0-9_]+)['"]/g),
    }
  })
  .filter((e) => e.rpcs.length || e.tables.length)

// ── client fetch call sites (must be repointed at the backend) ───────────────

const fetchSites = allSourceFiles
  .filter((f) => isClientFile(f, sources.get(f) || ''))
  .flatMap((f) => {
    const src = sources.get(f) || ''
    return src
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter((l) => /fetch\(\s*[`'"]\/api\//.test(l.text))
      .map((l) => ({
        file: f,
        line: l.line,
        endpoint: (l.text.match(/fetch\(\s*[`'"]([^`'"]+)/) || [])[1] || '?',
      }))
  })

// ── cron schedule (the backend must serve every path the crontab calls) ──────

// Vendored into the contract because ops/cron/crontab lives in the parent repo and the
// backend's CI cannot read it. Without this the cron reachability gate would be unenforceable.
const crontab = show('ops/cron/crontab') || ''
const cronJobs = crontab
  .split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('#'))
  .flatMap((line) => {
    const path = (line.match(/pawasave-cron\.sh\s+(\/\S+)/) || [])[1]
    if (!path) return []
    const schedule = (line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)/) || [])[1] || null
    return [{ path, schedule }]
  })

// The runner's curl timeout, against the maxDuration each route declares. A route that
// declares longer than the runner allows is being cut off mid-run.
const runner = show('ops/cron/pawasave-cron.sh') || ''
const runnerTimeoutSec = Number((runner.match(/curl\s+-sS\s+-m\s+(\d+)/) || [])[1] || 0) || null

// ── aggregate ────────────────────────────────────────────────────────────────

const serverEnv = uniq(routes.flatMap((r) => r.env).concat(libs.filter((l) => l.classification === 'server-only').flatMap((l) => l.env)))
const serverPackages = uniq(
  routes.flatMap((r) => r.packages).concat(libs.filter((l) => l.classification !== 'client-only').flatMap((l) => l.packages)),
)

const inventory = {
  branch: BRANCH,
  generatedAt: new Date().toISOString(),
  commit: git('rev-parse', '--short', BRANCH).trim(),
  totals: {
    routes: routes.length,
    libs: libs.length,
    serverEnvVars: serverEnv.length,
    browserDbFiles: browserDbFiles.length,
    browserRpcs: uniq(browserDbFiles.flatMap((e) => e.rpcs)).length,
    browserTables: uniq(browserDbFiles.flatMap((e) => e.tables)).length,
    clientFetchSites: fetchSites.length,
    cronJobs: cronJobs.length,
  },
  cron: {
    runnerTimeoutSec,
    jobs: cronJobs,
    // Routes the runner cannot possibly finish. Pre-existing defect, fixed in task 22.
    exceedingRunnerTimeout: cronJobs
      .map((j) => ({ ...j, maxDuration: routes.find((r) => r.url === j.path)?.segmentConfig?.maxDuration }))
      .filter((j) => j.maxDuration && runnerTimeoutSec && j.maxDuration > runnerTimeoutSec),
  },
  routes,
  libs,
  browserDbFiles,
  fetchSites,
  serverEnv,
  serverPackages,
  libsByClassification: libs.reduce((acc, l) => {
    ;(acc[l.classification] ||= []).push(l.name)
    return acc
  }, {}),
}

writeFileSync(resolve(OUT_DIR, 'inventory.json'), JSON.stringify(inventory, null, 2))

// ── markdown ─────────────────────────────────────────────────────────────────

const md = []
md.push('# Backend extraction — derived inventory')
md.push('')
md.push(`Generated by \`derive-inventory.mjs\` from \`${BRANCH}\` at \`${inventory.commit}\`.`)
md.push('Do not edit by hand. Re-run the script instead.')
md.push('')
md.push(`**${routes.length} routes · ${libs.length} lib modules · ${serverEnv.length} server env vars · ${fetchSites.length} client fetch sites**`)
md.push('')
md.push('## Routes')
md.push('')
md.push('| # | URL | Methods | Auth | Lines | Libs | Segment cfg |')
md.push('|---|---|---|---|---|---|---|')
routes.forEach((r, i) => {
  const cfg = Object.entries(r.segmentConfig).map(([k, v]) => `${k}=${v}`).join(' ') || '—'
  md.push(
    `| ${i + 1} | \`${r.url}\` | ${r.methods.join(', ') || '—'} | ${r.auth.join(' + ')} | ${r.lines} | ${r.libs.join(', ') || '—'} | ${cfg} |`,
  )
})
md.push('')
md.push('## Lib modules')
md.push('')
md.push('| Module | Classification | Lines | Client importers | Server importers |')
md.push('|---|---|---|---|---|')
libs
  .slice()
  .sort((a, b) => a.classification.localeCompare(b.classification) || a.name.localeCompare(b.name))
  .forEach((l) => {
    md.push(
      `| \`${l.name}\` | ${l.classification} | ${l.lines} | ${l.clientImporters.length} | ${l.serverImporters.length} |`,
    )
  })
md.push('')
md.push('## Client fetch sites to repoint')
md.push('')
md.push('| File | Line | Endpoint |')
md.push('|---|---|---|')
fetchSites.forEach((s) => md.push(`| \`${s.file.replace('frontend/src/', '')}\` | ${s.line} | \`${s.endpoint}\` |`))
md.push('')
md.push('## Browser-side direct Postgres access')
md.push('')
md.push('Out of scope for the extraction itself, tracked so the boundary is honest.')
md.push('')
md.push('| File | RPCs | Tables |')
md.push('|---|---|---|')
browserDbFiles.forEach((e) =>
  md.push(`| \`${e.file.replace('frontend/src/', '')}\` | ${e.rpcs.length} | ${e.tables.length} |`),
)
md.push('')
md.push('## Server env vars')
md.push('')
md.push(serverEnv.map((v) => `- \`${v}\``).join('\n'))
md.push('')

writeFileSync(resolve(OUT_DIR, 'inventory.md'), md.join('\n'))

console.log(JSON.stringify(inventory.totals, null, 2))
console.log('\nlibs by classification:')
for (const [k, v] of Object.entries(inventory.libsByClassification)) {
  console.log(`  ${k}: ${v.length}`)
  console.log(`    ${v.join(', ')}`)
}
console.log('\nwrote inventory.json + inventory.md')

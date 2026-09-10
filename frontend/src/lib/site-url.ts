/**
 * site-url.ts — the app's canonical base URL for any link we hand to the outside
 * world (auth confirmation/OAuth/reset redirects, shareable invite links, etc.).
 *
 * Do NOT use window.location.origin for these. In the installed app a PWA/TWA/
 * Capacitor wrapper (or a dev server bound to 0.0.0.0) reports its origin as
 * `http://0.0.0.0:3000` / `capacitor://localhost`, which then gets baked into
 * links that are opened on OTHER devices — producing the "restricted network
 * port" / dead-0.0.0.0 failures we saw on signup confirmation and would hit on
 * shared Ajo invite links too.
 *
 * Resolution order:
 *   1. NEXT_PUBLIC_SITE_URL (explicit, always wins)
 *   2. a real http(s) origin that isn't 0.0.0.0 (keeps localhost usable in dev)
 *   3. the production domain
 */
export function siteBaseUrl(): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL
  if (env) return env.replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    const o = window.location.origin
    if (/^https?:\/\//i.test(o) && !/\/\/0\.0\.0\.0(?::|\/|$)/i.test(o)) return o
  }
  return 'https://pawasave.xyz'
}

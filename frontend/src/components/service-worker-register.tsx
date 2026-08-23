'use client'

import { useEffect } from 'react'

/** Registers the PWA service worker (makes the app installable on Android/iOS and
 *  eligible for the Play Store TWA). No-op in dev and where SW is unsupported. */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    // Whether an SW already controls this page. Only an UPDATE (old→new controller)
    // should force a reload; a brand-new first install (null→SW) must not, or every
    // first visit would reload once for nothing.
    const hadController = Boolean(navigator.serviceWorker.controller)
    let reloaded = false

    // When a freshly-activated SW takes control, the page is still running the OLD
    // bundle. Reload once so the user immediately gets the new build instead of being
    // stranded on stale code (this is exactly how a user got stuck on a removed screen).
    const onControllerChange = () => {
      if (reloaded || !hadController) return
      reloaded = true
      window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        // Check for a newer SW now, and hourly for long-lived installed sessions.
        reg.update().catch(() => {})
        const id = setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000)
        window.addEventListener('beforeunload', () => clearInterval(id), { once: true })
      }).catch(() => {})
    }
    window.addEventListener('load', onLoad)
    return () => {
      window.removeEventListener('load', onLoad)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])
  return null
}
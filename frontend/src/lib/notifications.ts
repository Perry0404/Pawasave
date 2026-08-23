/**
 * notifications.ts — client-side Web Push enable/disable.
 *
 * Subscribes the browser (and thus the Play Store TWA / installed PWA) to push via
 * the service worker + VAPID. The subscription is stored server-side so PawaSave can
 * notify the user of deposits, Ajo payouts, and loan due-dates. Needs
 * NEXT_PUBLIC_VAPID_PUBLIC_KEY (+ VAPID_PRIVATE_KEY server-side) to be configured.
 */
const VAPID = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ''

export function isPushEnabled(): boolean {
  try {
    return localStorage.getItem('ps_push') === '1' &&
      typeof Notification !== 'undefined' && Notification.permission === 'granted'
  } catch { return false }
}

function urlB64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ reports as MacIntel but has touch
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari uses the legacy navigator.standalone flag
    (navigator as any).standalone === true
}

export async function enablePush(): Promise<{ ok: boolean; message?: string }> {
  if (typeof window === 'undefined') return { ok: false, message: 'Notifications aren’t supported on this device' }

  // iOS ONLY allows Web Push for an app added to the Home Screen (installed PWA,
  // iOS 16.4+). In a normal Safari tab PushManager/Notification don't even exist,
  // so give an actionable instruction instead of a dead-end "not supported".
  if (isIOS() && !isStandalone()) {
    return {
      ok: false,
      message: 'On iPhone/iPad: tap the Share icon, choose “Add to Home Screen”, open PawaSave from the home screen, then turn on notifications. (Requires iOS 16.4 or later.)',
    }
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
    return {
      ok: false,
      message: isIOS()
        ? 'Your iOS version doesn’t support notifications yet — update to iOS 16.4 or later.'
        : 'Notifications aren’t supported on this device',
    }
  }
  if (!VAPID) return { ok: false, message: 'Notifications not configured yet' }
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return { ok: false, message: 'Notification permission was declined' }
  try {
    const reg = await navigator.serviceWorker.ready
    const existing = await reg.pushManager.getSubscription()
    const sub = existing || await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(VAPID) as unknown as BufferSource,
    })
    const res = await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub),
    })
    if (!res.ok) return { ok: false, message: 'Could not save your subscription' }
    localStorage.setItem('ps_push', '1')
    return { ok: true }
  } catch {
    return { ok: false, message: 'Could not enable notifications' }
  }
}

export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await fetch('/api/push/subscribe', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {})
      await sub.unsubscribe()
    }
  } catch { /* ignore */ }
  localStorage.removeItem('ps_push')
}
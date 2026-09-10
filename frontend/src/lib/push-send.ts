/**
 * push-send.ts — server-side Web Push sender.
 *
 * Sends a notification to every device a user has subscribed. Call from server
 * events (deposit credited, Ajo payout, loan due) once VAPID keys are configured:
 *   VAPID_SUBJECT (mailto:), NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
 * No-ops safely when keys/subscriptions are absent. Prunes dead endpoints (404/410).
 */
import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'

let configured: boolean | null = null
function ensureVapid(): boolean {
  if (configured !== null) return configured
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@pawasave.xyz'
  if (!pub || !priv) { configured = false; return false }
  try { webpush.setVapidDetails(subject, pub, priv); configured = true } catch { configured = false }
  return configured
}

export type PushPayload = { title: string; body: string; url?: string; tag?: string }

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!ensureVapid() || !process.env.SUPABASE_SERVICE_ROLE_KEY) return
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )
  const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth').eq('user_id', userId)
  if (!subs?.length) return
  const body = JSON.stringify(payload)
  await Promise.all(subs.map(async (s: any) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body)
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
      }
    }
  }))
}
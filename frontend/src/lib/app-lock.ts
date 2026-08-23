/**
 * app-lock.ts — biometric (Face ID / fingerprint) app lock.
 *
 * A device-local convenience lock, the same pattern banking apps use: after the app
 * launches (or returns from background), the user unlocks with the device's platform
 * biometric before the UI is revealed. It uses WebAuthn's platform authenticator, so
 * it works inside the Play Store TWA and the iOS wrapper (and any modern browser).
 *
 * SECURITY NOTE: this gates the UI on THIS device — it is not a server auth control
 * and does not replace the session or the transaction PIN (money actions still
 * require the PIN, which is verified server-side). It stops someone who picks up an
 * already-signed-in phone from browsing the account.
 */

const KEY = (userId: string) => `ps_applock_${userId}`

type Stored = { enabled: boolean; credentialId: string }

function read(userId: string): Stored | null {
  try { return JSON.parse(localStorage.getItem(KEY(userId)) || 'null') } catch { return null }
}
function write(userId: string, v: Stored | null) {
  if (v) localStorage.setItem(KEY(userId), JSON.stringify(v))
  else localStorage.removeItem(KEY(userId))
}

const b64uFromBuf = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const bufFromB64u = (s: string) => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const randChallenge = () => crypto.getRandomValues(new Uint8Array(32))

export async function isBiometricAvailable(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) return false
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() } catch { return false }
}

export function isAppLockEnabled(userId: string): boolean {
  return !!read(userId)?.enabled
}

/** Register the platform biometric and enable the lock for this device. */
export async function enableAppLock(userId: string, label: string): Promise<boolean> {
  if (!(await isBiometricAvailable())) return false
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: randChallenge(),
      rp: { name: 'PawaSave' },
      user: { id: bufFromB64u(b64uFromBuf(new TextEncoder().encode(userId).buffer as ArrayBuffer)), name: label || userId, displayName: label || 'PawaSave' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
    },
  })) as PublicKeyCredential | null
  if (!cred) return false
  write(userId, { enabled: true, credentialId: b64uFromBuf(cred.rawId) })
  return true
}

export function disableAppLock(userId: string) { write(userId, null) }

/** Prompt the device biometric to unlock. Returns true on success. */
export async function verifyAppLock(userId: string): Promise<boolean> {
  const stored = read(userId)
  if (!stored?.enabled || !stored.credentialId) return true // not enabled → nothing to unlock
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randChallenge(),
        allowCredentials: [{ type: 'public-key', id: bufFromB64u(stored.credentialId) }],
        userVerification: 'required',
        timeout: 60000,
      },
    })
    return !!assertion
  } catch {
    return false
  }
}
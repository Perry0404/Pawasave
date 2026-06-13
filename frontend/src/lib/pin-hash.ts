import crypto from 'crypto'

/**
 * Server-side transaction-PIN hashing (FIND-AUTH-01).
 *
 * A 4-digit PIN has only 10,000 possible values, so a fast or unsalted hash
 * (the old client-side SHA-256) is trivially brute-forced from a DB dump. The
 * only meaningful protection is a SLOW, SALTED hash computed on the server:
 * scrypt with a per-PIN random salt.
 *
 * Storage format: `scrypt$<saltHex>$<keyHex>`.
 * Legacy values are bare 64-char SHA-256 hex — verifyPin() still accepts them and
 * returns an `upgrade` so the caller can transparently migrate the stored hash.
 *
 * Server-only (reads raw PINs). Never import into a client component.
 */

const SCRYPT_KEYLEN = 32

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(pin, salt, SCRYPT_KEYLEN)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Verify a raw PIN against a stored hash (scrypt or legacy SHA-256).
 * When a legacy hash matches, `upgrade` is a fresh scrypt hash the caller should
 * persist so the account migrates off unsalted SHA-256.
 */
export function verifyPin(pin: string, stored: string | null | undefined): { ok: boolean; upgrade?: string } {
  if (!stored) return { ok: false }

  if (stored.startsWith('scrypt$')) {
    const [, saltHex, keyHex] = stored.split('$')
    if (!saltHex || !keyHex) return { ok: false }
    const key = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN)
    const expected = Buffer.from(keyHex, 'hex')
    return { ok: key.length === expected.length && crypto.timingSafeEqual(key, expected) }
  }

  // Legacy unsalted SHA-256 — accept once, then signal an upgrade to scrypt.
  if (safeEqualHex(sha256Hex(pin), stored)) {
    return { ok: true, upgrade: hashPin(pin) }
  }
  return { ok: false }
}
/**
 * Exclusive leases for the shared custody wallet.
 *
 * Custody has one nonce and one balance, so two concurrent signers hand out duplicate
 * nonces and both read the same idle balance. Every path that signs with custody takes
 * this lease first.
 *
 * Backed by migration 073. Unlike the older supply-lock this fails CLOSED: if the lease
 * cannot be confirmed the caller does not proceed. Migration 073 has to be applied before
 * this ships or every custody path will refuse to run.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import os from 'node:os'
import { createClient } from '@supabase/supabase-js'

/**
 * One key covers all custody signing, including pool supply and redeem. Separate keys
 * per operation looked tempting but a caller holding a signer lease often supplies or
 * redeems inside it, and two keys taken in different orders deadlock.
 */
export type LeaseScope = 'custody:signer'

export const DEFAULT_TTL_SECONDS = 180

export type LeaseFailure = 'held' | 'unavailable'

export class LeaseUnavailableError extends Error {
  constructor(readonly scope: string, readonly reason: LeaseFailure, readonly detail?: string) {
    super(
      reason === 'held'
        ? `Another operation holds the ${scope} lease`
        : `Cannot verify the ${scope} lease: ${detail ?? 'unknown error'}`,
    )
    this.name = 'LeaseUnavailableError'
  }
}

/** Thrown when a refresh finds the lease gone, meaning someone else may now be signing. */
export class LeaseLostError extends Error {
  constructor(readonly scope: string) {
    super(`Lost the ${scope} lease mid-operation`)
    this.name = 'LeaseLostError'
  }
}

export interface Lease {
  readonly scope: LeaseScope
  readonly token: string
  /** Aborts as soon as a refresh fails, so in-flight work can bail out. */
  readonly signal: AbortSignal
  get lost(): boolean
  refresh(ttlSeconds?: number): Promise<boolean>
  release(): Promise<void>
  /** Call before anything irreversible. Throws if we no longer hold the lease. */
  assertHeld(): void
}

export interface AcquireOptions {
  ttlSeconds?: number
  /** How long to keep retrying before giving up. 0 means try once. */
  waitMs?: number
  /** Shows up in lease_status, so make it something you would recognise in a log. */
  holder?: string
}

export type AcquireResult =
  | { ok: true; lease: Lease }
  | { ok: false; reason: LeaseFailure; detail?: string }

// Typed `any`: the generated client generics don't know these RPCs.
let _client: any = null

function db() {
  if (_client) return _client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  _client = createClient(url, key, { auth: { persistSession: false } })
  return _client
}

function defaultHolder(label?: string) {
  const base = `${process.pid}@${os.hostname()}`
  return label ? `${label} ${base}` : base
}

/** A missing function means migration 073 has not run, so retrying will not help. */
function isMissingFunction(error: any) {
  const code = String(error?.code ?? '')
  if (code === '42883' || code === 'PGRST202') return true
  return /could not find the function|does not exist/i.test(String(error?.message ?? ''))
}

function jitteredDelay(attempt: number) {
  const base = Math.min(200 * 2 ** attempt, 2000)
  return base / 2 + Math.random() * (base / 2)
}

const held = new AsyncLocalStorage<Map<string, Lease>>()

class DbLease implements Lease {
  private _lost = false
  private readonly controller = new AbortController()

  constructor(
    readonly scope: LeaseScope,
    readonly token: string,
    private readonly ttlSeconds: number,
  ) {}

  get signal() {
    return this.controller.signal
  }

  get lost() {
    return this._lost
  }

  private markLost() {
    if (this._lost) return
    this._lost = true
    this.controller.abort(new LeaseLostError(this.scope))
  }

  async refresh(ttlSeconds = this.ttlSeconds): Promise<boolean> {
    if (this._lost) return false
    const c = db()
    if (!c) {
      this.markLost()
      return false
    }
    const { data, error } = await c.rpc('refresh_lease', {
      p_key: this.scope,
      p_token: this.token,
      p_ttl_seconds: ttlSeconds,
    })
    // A transient error is not proof we lost it, so hold on and let the next tick decide.
    if (error) return !this._lost
    if (data !== true) {
      this.markLost()
      return false
    }
    return true
  }

  async release(): Promise<void> {
    const c = db()
    if (!c) return
    try {
      await c.rpc('release_lease', { p_key: this.scope, p_token: this.token })
    } catch {
      // TTL expiry is the backstop, so a failed release only delays the next holder.
    }
  }

  assertHeld() {
    if (this._lost) throw new LeaseLostError(this.scope)
  }
}

/** Delegates to the outer lease. Releasing a nested handle does nothing on purpose. */
class NestedLease implements Lease {
  constructor(private readonly parent: Lease) {}
  get scope() {
    return this.parent.scope
  }
  get token() {
    return this.parent.token
  }
  get signal() {
    return this.parent.signal
  }
  get lost() {
    return this.parent.lost
  }
  refresh(ttlSeconds?: number) {
    return this.parent.refresh(ttlSeconds)
  }
  async release() {}
  assertHeld() {
    this.parent.assertHeld()
  }
}

/** The lease this async context already holds, if any. */
export function currentLease(scope: LeaseScope = 'custody:signer'): Lease | null {
  return held.getStore()?.get(scope) ?? null
}

/**
 * Try to claim a lease. Prefer withLease, which handles refresh and release for you.
 * Use this only where acquire and release sit in different functions.
 */
export async function acquireLease(
  scope: LeaseScope = 'custody:signer',
  opts: AcquireOptions = {},
): Promise<AcquireResult> {
  const existing = currentLease(scope)
  if (existing) return { ok: true, lease: new NestedLease(existing) }

  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const waitMs = opts.waitMs ?? 0
  const holder = defaultHolder(opts.holder)

  const c = db()
  if (!c) return { ok: false, reason: 'unavailable', detail: 'no service role key' }

  const deadline = Date.now() + waitMs
  let attempt = 0
  let lastError: string | undefined

  for (;;) {
    const { data, error } = await c.rpc('try_acquire_lease', {
      p_key: scope,
      p_ttl_seconds: ttlSeconds,
      p_holder: holder,
    })

    if (error) {
      if (isMissingFunction(error)) {
        return { ok: false, reason: 'unavailable', detail: 'migration 073 not applied' }
      }
      lastError = error.message
    } else if (typeof data === 'string' && data) {
      return { ok: true, lease: new DbLease(scope, data, ttlSeconds) }
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return lastError
        ? { ok: false, reason: 'unavailable', detail: lastError }
        : { ok: false, reason: 'held' }
    }
    await new Promise((r) => setTimeout(r, Math.min(jitteredDelay(attempt++), remaining)))
  }
}

export interface WithLeaseOptions extends AcquireOptions {
  /** Seconds between refreshes. Defaults to a third of the TTL. */
  refreshEverySeconds?: number
}

/**
 * Run fn while holding the lease, refreshing it in the background and releasing after.
 * Nested calls for the same scope reuse the outer lease instead of deadlocking.
 * Throws LeaseUnavailableError if the lease cannot be claimed.
 */
export async function withLease<T>(
  scope: LeaseScope,
  fn: (lease: Lease) => Promise<T>,
  opts: WithLeaseOptions = {},
): Promise<T> {
  const existing = currentLease(scope)
  if (existing) return fn(new NestedLease(existing))

  const result = await acquireLease(scope, opts)
  if (!result.ok) throw new LeaseUnavailableError(scope, result.reason, result.detail)

  const lease = result.lease
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const every = Math.max(5, opts.refreshEverySeconds ?? Math.floor(ttl / 3))
  const timer = setInterval(() => {
    lease.refresh().catch(() => {})
  }, every * 1000)
  timer.unref?.()

  const store = new Map<string, Lease>([[scope, lease]])
  try {
    return await held.run(store, () => fn(lease))
  } finally {
    clearInterval(timer)
    await lease.release()
  }
}

/** Who holds a key right now. For debugging a stuck lease. */
export async function leaseStatus(scope: LeaseScope = 'custody:signer'): Promise<any> {
  const c = db()
  if (!c) return { key: scope, error: 'no service role key' }
  const { data, error } = await c.rpc('lease_status', { p_key: scope })
  if (error) return { key: scope, error: error.message }
  return data
}

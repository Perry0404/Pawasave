/**
 * secrets.ts — server-only secret resolution.
 *
 * Pulls sensitive values (the deposit mnemonic, operational private keys) from
 * AWS Secrets Manager instead of plain Vercel env, closing the "secret sits in
 * env" gap (CRIT-02/03 hardening). Falls back to process.env so local dev and
 * any not-yet-migrated value keeps working.
 *
 * Model: ONE secret in AWS Secrets Manager whose value is a JSON object, e.g.
 *   {
 *     "DEPOSIT_WALLET_MNEMONIC": "word1 ... word12",
 *     "CUSTODY_PRIVATE_KEY": "0x...",
 *     "ORACLE_KEEPER_PRIVATE_KEY": "0x...",
 *     "LIQUIDATION_KEEPER_PRIVATE_KEY": "0x...",
 *     "VAULT_HARVESTER_PRIVATE_KEY": "0x...",
 *     "DEPOSIT_GAS_FUNDER_PRIVATE_KEY": "0x..."
 *   }
 *
 * Env to enable it:
 *   AWS_SECRETS_ID        — the secret's name/ARN (when unset → pure env mode)
 *   AWS_REGION            — e.g. eu-west-1
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY — IAM creds scoped to JUST this secret
 * (the AWS SDK reads the credentials from env automatically).
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

const TTL_MS = 5 * 60_000
let cache: { at: number; values: Record<string, string> } | null = null

async function loadBundle(): Promise<Record<string, string>> {
  const secretId = process.env.AWS_SECRETS_ID
  if (!secretId) return {} // not configured → env-only mode
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values
  try {
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' })
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }))
    const values = JSON.parse(res.SecretString || '{}') as Record<string, string>
    cache = { at: Date.now(), values }
    return values
  } catch (e) {
    // Never hard-fail on a transient Secrets Manager issue — fall back to the
    // last good cache, then to env. The caller still validates presence.
    console.error('[secrets] Secrets Manager load failed, falling back:', (e as Error).message)
    return cache?.values ?? {}
  }
}

/** Resolve a secret by name: AWS Secrets Manager bundle first, then process.env. */
export async function getSecret(name: string): Promise<string | undefined> {
  const bundle = await loadBundle()
  return bundle[name] ?? process.env[name]
}
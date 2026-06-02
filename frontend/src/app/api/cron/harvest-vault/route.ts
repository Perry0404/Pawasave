import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { ethers } from 'ethers'

/**
 * GET /api/cron/harvest-vault
 *
 * Called every 6 hours by Vercel Cron.
 * Calls harvestYield() on the P-AUTO vault contract, collects the 6%
 * platform fee into the treasury, and records the yield event in Supabase
 * so the accrue-yield cron can distribute it to users proportionally.
 *
 * Required env vars:
 *   BASE_MAINNET_RPC_URL          — Base mainnet RPC
 *   VAULT_HARVESTER_PRIVATE_KEY   — private key of the HARVESTER_ROLE wallet
 *   PAUTO_VAULT_ADDRESS           — deployed PawasaveAutoVault address
 *   CRON_SECRET                   — Vercel cron secret
 */

const VAULT_ABI = [
  "function harvestYield() external returns (uint256 totalYield)",
  "function totalYieldHarvested() view returns (uint256)",
  "function platformFeeBps() view returns (uint256)",
  "function paused() view returns (bool)",
]

export async function GET(request: NextRequest) {
  // Auth
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rpcUrl      = process.env.BASE_MAINNET_RPC_URL
  const privateKey  = process.env.VAULT_HARVESTER_PRIVATE_KEY
  const vaultAddr   = process.env.PAUTO_VAULT_ADDRESS || process.env.NEXT_PUBLIC_PAUTO_VAULT_ADDRESS

  if (!rpcUrl || !privateKey || !vaultAddr) {
    console.log('[harvest-vault] Skipping — vault not configured for mainnet yet')
    return NextResponse.json({ ok: true, skipped: true, reason: 'Not configured' })
  }

  try {
    const provider  = new ethers.JsonRpcProvider(rpcUrl)
    const harvester = new ethers.Wallet(privateKey, provider)
    const vault     = new ethers.Contract(vaultAddr, VAULT_ABI, harvester)

    // Skip if vault is paused
    const paused = await vault.paused()
    if (paused) {
      return NextResponse.json({ ok: true, skipped: true, reason: 'Vault paused' })
    }

    // Harvest yield
    const tx      = await vault.harvestYield()
    const receipt = await tx.wait()

    // Parse YieldHarvested event
    const iface = new ethers.Interface([
      "event YieldHarvested(uint256 totalYield, uint256 platformFee, uint256 userYield, uint256 timestamp)",
    ])
    let totalYield  = 0n
    let platformFee = 0n
    let userYield   = 0n

    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log)
        if (parsed?.name === 'YieldHarvested') {
          totalYield  = parsed.args.totalYield
          platformFee = parsed.args.platformFee
          userYield   = parsed.args.userYield
        }
      } catch {}
    }

    console.log(`[harvest-vault] ✓ Harvested — total: ${totalYield}, fee: ${platformFee}, user: ${userYield}`)

    // Record in Supabase for proportional distribution to users
    if (userYield > 0n && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false } },
      )

      await supabase.from('vault_harvests').insert({
        tx_hash:          receipt.hash,
        total_yield_micro: Number(totalYield),
        platform_fee_micro: Number(platformFee),
        user_yield_micro:  Number(userYield),
        harvested_at:      new Date().toISOString(),
      })

      // Trigger proportional yield distribution to all active P-AUTO holders
      await supabase.rpc('distribute_vault_yield', {
        p_yield_micro: Number(userYield),
      })
    }

    return NextResponse.json({
      ok: true,
      txHash:     receipt.hash,
      totalYield: totalYield.toString(),
      platformFee: platformFee.toString(),
      userYield:  userYield.toString(),
    })

  } catch (err: any) {
    // harvestYield reverts with "No yield harvested" when nothing has accrued yet
    if (err?.message?.includes('No yield harvested')) {
      return NextResponse.json({ ok: true, skipped: true, reason: 'No yield yet' })
    }
    console.error('[harvest-vault] error:', err)
    return NextResponse.json({ error: err.message || 'Harvest failed' }, { status: 500 })
  }
}

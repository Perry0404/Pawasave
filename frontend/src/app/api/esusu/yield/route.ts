import { NextResponse } from 'next/server'

/**
 * POST /api/esusu/yield  — RETIRED (migration 115).
 *
 * This used to track and pay Ajo pot interest from the browser:
 *   • `deposit` recorded a contribution amount the CLIENT supplied, and could be repeated,
 *     so a member could inflate the pot's interest base at will;
 *   • `payout` credited the pot's interest to a recipient the CLIENT chose.
 *
 * Ajo interest is now paid inside process_esusu_payout() from the contributions the
 * database actually recorded, to the recipient that function selects, and only while
 * savings are backed by gNTB. Nothing here moves money any more; it answers so older
 * app builds that still call it fail quietly instead of erroring.
 */
export async function POST() {
  return NextResponse.json({ ok: true, retired: true, note: 'Ajo interest is paid by process_esusu_payout (migration 115)' })
}

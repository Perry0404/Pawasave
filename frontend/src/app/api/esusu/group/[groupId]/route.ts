import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET(
  _request: NextRequest,
  { params }: { params: { groupId: string } }
) {
  const { groupId } = params

  if (!groupId || !/^[0-9a-f-]{36}$/.test(groupId)) {
    return NextResponse.json({ error: 'Invalid group ID' }, { status: 400 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  const { data: group, error } = await supabase
    .from('esusu_groups')
    .select('id, name, contribution_amount_kobo, cycle_period, max_members, status, current_cycle, created_at')
    .eq('id', groupId)
    .single()

  if (error || !group) {
    return NextResponse.json({ error: 'Circle not found' }, { status: 404 })
  }

  const { count } = await supabase
    .from('esusu_members')
    .select('*', { count: 'exact', head: true })
    .eq('group_id', groupId)

  return NextResponse.json({ ...group, member_count: count ?? 0 })
}

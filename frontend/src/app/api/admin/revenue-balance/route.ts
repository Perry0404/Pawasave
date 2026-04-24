import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET(request: NextRequest) {
  // Simple auth via query param for admin polling
  const pw = request.nextUrl.searchParams.get('pw')
  if (!pw || pw !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'platform_revenue_kobo')
    .single()

  return NextResponse.json({ revenueKobo: Number(data?.value || 0) })
}

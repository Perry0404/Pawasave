import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code       = searchParams.get('code')
  const tokenHash  = searchParams.get('token_hash')
  const type       = searchParams.get('type')          // 'recovery' | 'signup' | etc.
  const next       = searchParams.get('next') || '/'

  // Recovery email always lands on /reset-password regardless of `next`
  const redirectTo = type === 'recovery' ? '/reset-password' : next

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        },
      },
    }
  )

  // PKCE flow — code exchanged for session
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(redirectTo, request.url))
  }

  // Email OTP / token_hash flow (Supabase recovery emails use this)
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as any })
    if (!error) return NextResponse.redirect(new URL(redirectTo, request.url))
  }

  // Fragment-based tokens (#access_token=...) can't be read server-side.
  // For recovery links, send user to reset-password and let client handle the fragment.
  if (type === 'recovery') {
    return NextResponse.redirect(new URL('/reset-password', request.url))
  }

  return NextResponse.redirect(new URL('/?error=auth_callback_failed', request.url))
}
